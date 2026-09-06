import { GLOBAL_DB_ID } from './paths'
import type { SessionRegistry } from './capabilities'
import { MERGE_CONTRACT_VERSION, mergeRecallResults, type MergeableItem, type MergedItem } from './recallMerge'
import type { VaultManager } from './vaultManager'
import { admit } from './admission'
import type { ReviewStore, StoredCandidate } from './reviewStore'

export interface MemoryPromoteResult {
  ok: boolean
  operationId: string
  status: 'verified' | 'failed' | 'indeterminate'
  targetDb: string
  category: string
  key: string
  error?: string
}

export interface RecallQuery {
  query: string
  limit?: number
  /**
   * Only 'dense' is supported (fail-closed). Measured on binary 2.23.2:
   * dense/recallWhen/getEntity/history never persist usage changes, while
   * fts5 persists +1 count/access/decay per served recall and hybrid is
   * unproven. 'fts5'/'hybrid' throw until a fork patch decouples ranking.
   */
  mode?: 'dense'
}

/**
 * Scope selection. Default is home workspace DB + global (when granted);
 * granted extras are queried ONLY via an explicit selected list — a subset
 * of the session's granted DBs, never more. Scopes narrow, never widen.
 */
export type RecallScope = 'default' | VaultDbId[]

export type VaultDbId = string

export interface RecallOpts {
  scope?: RecallScope
  /** Per-DB backend candidate limit (bounded int 1..100). */
  perDbLimit?: number
  /** Final merged total cap (bounded int 1..200). */
  maxTotal?: number
  /** Offset into the merged order (bounded int 0..10000). */
  offset?: number
}

export interface BrowseOpts {
  /** Explicit DB selection (required, 1..8): no default merging. */
  scope: VaultDbId[]
  /** Category filter (1..64 chars); omitted = all categories. */
  category?: string
  /** Page size (bounded int 1..100, default 100). */
  limit?: number
  /** Continuation cursor from a previous page (1..512 chars). */
  cursor?: string
}

export interface BrowseDbResult {
  db: string
  items: RecallItemWire[]
  /** Backend total, or null when the backend did not report one. */
  total: number | null
  hasMore: boolean
  nextCursor: string | null
  missing: { db: string; reason: string } | null
}

export interface BrowseResult {
  evaluatedAt: string
  perDb: BrowseDbResult[]
  partial: boolean
}

const MAX_PER_DB_LIMIT = 100
const MAX_TOTAL = 200
const MAX_OFFSET = 10000
const MAX_BROWSE_SCOPE = 8
const MAX_BROWSE_LIMIT = 100
const BROWSE_DEFAULT_LIMIT = 100

export interface BrokerRecallResult<T extends MergeableItem> {
  mergeContract: number
  /** Output timestamp of this envelope — NOT a backend-anchored revision.
   * Determinism is promised only for identical local rankings (same DB
   * revisions); independent DBs have no atomic snapshot view. */
  evaluatedAt: string
  items: Array<MergedItem<T>>
  /** DBs that failed, timed out, answered malformed, or reported backend
   * incompleteness: the result is explicitly partial, never silent. */
  missing: Array<{ db: string; reason: string }>
  partial: boolean
  /** True when nothing failed and nothing matched (vs. total outage). */
  completeEmpty: boolean
  /** True when the bounded V1 candidate window may hide more (see below). */
  hasMore: boolean
}

export interface RecallItemWire {
  id: string
  category?: string
  key?: string
  content?: string
  [key: string]: unknown
}

// V1 pagination contract: the broker pages over a BOUNDED candidate window
// (perDbLimit each + maxTotal merged). hasMore=true means the window may
// hide more — either a DB returned a full page or the merged list hit the
// total cap. There are no cursors and no cross-call snapshots: each page
// re-queries, so a changed source state shows immediately (never stale).
const BACKEND_INCOMPLETE = new Set(['timeout', 'partial', 'degraded', 'unavailable', 'error', 'failed'])

// Read-only memory broker. Sessions are opaque handles resolved against the
// registry on EVERY access — forged, copied or revoked sessions yield no
// data. Fan-out covers only the resolved scope; late answers after
// revocation are discarded before merging. No write methods exist on
// purpose (broker writes stay locked).
//
// Read hygiene (measured on binary 2.23.2, see reinforcement.live.test.ts):
// the reinforce flag does NOT gate reinforcement — the MODE does. Dense
// (always sent explicitly, plus reinforce:false belt-and-braces) never
// persists usage changes; fts5 would (+1 count/access/decay per served
// recall) and is therefore rejected above. derived_from is never cited, so
// broker reads mark nothing as useful.
export interface BrokerOptions {
  allowLiveWrites?: boolean
}

export class MemoryBroker {
  constructor(
    private readonly manager: VaultManager,
    private readonly sessions: SessionRegistry,
    private readonly opts: BrokerOptions = {},
  ) {}

  async recall(
    handle: string,
    query: RecallQuery,
    opts: RecallOpts = {},
  ): Promise<BrokerRecallResult<RecallItemWire>> {
    const evaluatedAt = new Date().toISOString()
    if (query.mode !== undefined && query.mode !== 'dense') {
      throw new Error(`unsupported recall mode '${query.mode}' (reinforcing; locked until fork-patch)`)
    }
    const perDbLimit = boundedInt('perDbLimit', opts.perDbLimit ?? query.limit ?? 10, 1, MAX_PER_DB_LIMIT)
    const maxTotal = boundedInt('maxTotal', opts.maxTotal ?? 30, 1, MAX_TOTAL)
    const offset = boundedInt('offset', opts.offset ?? 0, 0, MAX_OFFSET)
    const dbs = this.resolveScope(handle, opts.scope)
    const settled = await Promise.all(
      dbs.map(async (db) => {
        this.checkLive(handle, db)
        try {
          const res = (await this.manager.call(db, 'perseus_vault_recall', {
            query: query.query,
            limit: perDbLimit,
            mode: 'dense',
            reinforce: false,
            workspace_hash: db === GLOBAL_DB_ID ? '' : dbWorkspaceHash(db),
          }, () => void this.sessions.assertLive(handle))) as { items?: unknown; outcome?: { status?: unknown }; total?: unknown }
          this.checkLive(handle, db)
          return { db, items: validItems(res), missing: backendGap(db, res) }
        } catch (e) {
          return { db, items: [] as RecallItemWire[], missing: { db, reason: (e as Error).message } }
        }
      }),
    )
    this.sessions.assertLive(handle)
    return this.envelope(evaluatedAt, settled, { perDbLimit, maxTotal, offset })
  }

  async recallWhen(
    handle: string,
    context: string,
    limit = 5,
    opts: { scope?: RecallScope } = {},
  ): Promise<BrokerRecallResult<RecallItemWire>> {
    const evaluatedAt = new Date().toISOString()
    const capped = boundedInt('limit', limit, 1, MAX_PER_DB_LIMIT)
    const dbs = this.resolveScope(handle, opts.scope)
    const settled = await Promise.all(
      dbs.map(async (db) => {
        this.checkLive(handle, db)
        try {
          const res = (await this.manager.call(db, 'perseus_vault_recall_when', {
            context,
            limit: capped,
            workspace_hash: db === GLOBAL_DB_ID ? '' : dbWorkspaceHash(db),
          }, () => void this.sessions.assertLive(handle))) as { items?: unknown; outcome?: { status?: unknown } }
          this.checkLive(handle, db)
          return { db, items: validItems(res), missing: backendGap(db, res) }
        } catch (e) {
          return { db, items: [] as RecallItemWire[], missing: { db, reason: (e as Error).message } }
        }
      }),
    )
    this.sessions.assertLive(handle)
    return this.envelope(evaluatedAt, settled, { perDbLimit: capped, maxTotal: 30, offset: 0 })
  }

  /** Scoped detail read (screen drill-down). Re-authorized after the RPC. */
  async getEntity(handle: string, db: string, id: string): Promise<unknown> {
    this.sessions.check(handle, db)
    try {
      const res = await this.manager.call(db, 'perseus_vault_get_entity', { id }, () =>
        void this.sessions.assertLive(handle),
      )
      this.sessions.check(handle, db)
      return res
    } catch (e) {
      this.sessions.check(handle, db)
      throw e
    }
  }

  /** Scoped history read (screen drill-down). Re-authorized after the RPC. */
  async history(handle: string, db: string, category: string, key: string): Promise<unknown> {
    this.sessions.check(handle, db)
    try {
      const res = await this.manager.call(db, 'perseus_vault_history', { category, key, limit: 20 }, () =>
        void this.sessions.assertLive(handle),
      )
      this.sessions.check(handle, db)
      return res
    } catch (e) {
      this.sessions.check(handle, db)
      throw e
    }
  }

  /**
   * Browse-first listing over `perseus_vault_scan` (measured side-effect
   * free on binary 2.23.2: entities + journal identical before/after scan,
   * category filter, cursor paging, total/has_more/next_cursor contract).
   * Scope is REQUIRED explicit (no default merging): the UI passes exactly
   * the selected DB. No merging across DBs — per-DB pages stay honest for
   * paging; the single-select UI reads perDb[0]. Unknown totals stay null
   * (never invented). Late answers after revocation are discarded.
   */
  async browse(handle: string, opts: BrowseOpts): Promise<BrowseResult> {
    const evaluatedAt = new Date().toISOString()
    if (!Array.isArray(opts.scope) || opts.scope.length === 0 || opts.scope.length > MAX_BROWSE_SCOPE) {
      throw new Error(`invalid scope: expected 1..${MAX_BROWSE_SCOPE} explicit DB ids`)
    }
    const dbs = this.resolveScope(handle, [...opts.scope])
    const limit = boundedInt('limit', opts.limit ?? BROWSE_DEFAULT_LIMIT, 1, MAX_BROWSE_LIMIT)
    const category = opts.category === undefined ? undefined : validCategory(opts.category)
    const cursor = opts.cursor === undefined ? undefined : validCursor(opts.cursor)
    const settled = await Promise.all(
      dbs.map(async (db): Promise<BrowseDbResult> => {
        this.checkLive(handle, db)
        try {
          const args: Record<string, unknown> = {
            limit,
            workspace_hash: db === GLOBAL_DB_ID ? '' : dbWorkspaceHash(db),
          }
          if (category !== undefined) args.category = category
          if (cursor !== undefined) args.cursor = cursor
          const res = (await this.manager.callIfReady(db, 'perseus_vault_scan', args, () =>
            void this.sessions.assertLive(handle),
          )) as { items?: unknown; total?: unknown; has_more?: unknown; next_cursor?: unknown }
          this.checkLive(handle, db)
          return validatedScan(db, res)
        } catch (e) {
          return { db, items: [], total: null, hasMore: false, nextCursor: null, missing: { db, reason: (e as Error).message } }
        }
      }),
    )
    this.sessions.assertLive(handle)
    return { evaluatedAt, perDb: settled, partial: settled.some((s) => s.missing !== null) }
  }

  /**
   * Promotes an approved candidate into the target vault.
   * Runs the entire sequence (approval recheck, multi-page scan, admission,
   * write dispatch, and readback verification) under the manager's exclusive DB lock.
   */
  async promote(
    handle: string,
    candidate: StoredCandidate & { id: number; revision: number },
    reviews: ReviewStore,
  ): Promise<MemoryPromoteResult> {
    if (!this.opts.allowLiveWrites && process.env.ITTOP_ALLOW_LIVE_PROMOTION !== 'true') {
      throw new Error('vault writes are locked in this phase (dry-run preview only until migration gate approval)')
    }

    this.sessions.assertCanPromote(handle, candidate.db)
    const operationId = `${candidate.id}:${candidate.revision}:${candidate.db}`

    const intent = reviews.recordPromotionIntent({
      operationId,
      fromDb: candidate.db,
      toDb: candidate.db,
      category: candidate.category,
      key: candidate.key,
      snapshot: JSON.stringify({
        content: candidate.content,
        triggers: candidate.triggers,
        future_use: candidate.futureUse,
        evidence: candidate.evidence,
      }),
    })

    if (intent === 'verified') {
      return {
        ok: true,
        operationId,
        status: 'verified',
        targetDb: candidate.db,
        category: candidate.category,
        key: candidate.key,
      }
    }

    return this.manager.withWriteTransaction(candidate.db, async (writeDirect) => {
      // 1. Re-verify session and candidate under lock
      this.sessions.assertLive(handle)
      const stored = reviews.get(candidate.id)
      if (!stored || stored.statusState !== 'approved' || stored.revision !== candidate.revision) {
        const err = `candidate ${candidate.id} changed or no longer approved`
        reviews.updatePromotionState(operationId, 'failed', 'intent', err)
        throw new Error(err)
      }

      // 2. Full multi-page live scan
      const liveItems: RecallItemWire[] = []
      const seenCursors = new Set<string>()
      let cursor: string | undefined = undefined
      for (let pageNum = 0; pageNum < 50; pageNum++) {
        const scan = await this.browse(handle, {
          scope: [candidate.db],
          category: candidate.category,
          cursor,
          limit: 100,
        })
        if (scan.partial) {
          const err = `live scan on ${candidate.db} returned partial results`
          reviews.updatePromotionState(operationId, 'failed', 'intent', err)
          throw new Error(err)
        }
        const dbResult = scan.perDb[0]
        if (!dbResult || dbResult.missing) {
          const err = `live scan on ${candidate.db} failed: ${dbResult?.missing?.reason ?? 'missing'}`
          reviews.updatePromotionState(operationId, 'failed', 'intent', err)
          throw new Error(err)
        }
        liveItems.push(...dbResult.items)
        if (!dbResult.hasMore) break
        if (!dbResult.nextCursor || seenCursors.has(dbResult.nextCursor)) {
          const err = `live scan on ${candidate.db} reported invalid or repeated cursor`
          reviews.updatePromotionState(operationId, 'failed', 'intent', err)
          throw new Error(err)
        }
        if (pageNum === 49) {
          const err = `live scan on ${candidate.db} exceeded 50 pages bound`
          reviews.updatePromotionState(operationId, 'failed', 'intent', err)
          throw new Error(err)
        }
        seenCursors.add(dbResult.nextCursor)
        cursor = dbResult.nextCursor
      }

      // 3. Admission check against complete live items
      const admission = admit(candidate, {
        findSameKey: (_db, _cat, key) =>
          liveItems
            .filter((i) => i.key === key)
            .map((i) => ({ status: 'active', content: i.content ?? '' })),
      })

      if (admission.decision === 'reject') {
        const err = `live admission rejected: ${admission.reasons.join('; ')}`
        reviews.updatePromotionState(operationId, 'failed', 'intent', err)
        throw new Error(err)
      }

      const hasLiveCollision = liveItems.some((i) => i.key === candidate.key)
      const override = (candidate as { decisionMeta?: { override?: unknown } }).decisionMeta?.override
      if (hasLiveCollision && !override) {
        const err = 'live admission conflict: existing key requires audited human override'
        reviews.updatePromotionState(operationId, 'failed', 'intent', err)
        throw new Error(err)
      }

      // 4. Atomic CAS to dispatched
      reviews.updatePromotionState(operationId, 'dispatched', 'intent')
      this.sessions.assertLive(handle)

      // 5. Exclusive write
      try {
        await writeDirect({
          category: candidate.category,
          key: candidate.key,
          body: JSON.stringify({
            content: candidate.content,
            triggers: candidate.triggers,
            future_use: candidate.futureUse,
            source_ref: candidate.evidence?.sourceRef,
          }),
        })
      } catch (writeErr) {
        const message = (writeErr as Error).message || String(writeErr)
        reviews.updatePromotionState(operationId, 'indeterminate', 'dispatched', message)
        throw new Error(`write dispatched but outcome indeterminate: ${message}`)
      }

      // 6. Exact readback verify against restarted vault
      this.sessions.assertLive(handle)
      try {
        const readback = (await this.history(handle, candidate.db, candidate.category, candidate.key)) as {
          versions?: Array<{ category?: string; key?: string }>
          total?: number
        } | null
        const versions = Array.isArray(readback?.versions) ? readback.versions : []
        const matched = versions.some(
          (v) => v.category === candidate.category && v.key === candidate.key,
        )
        if (!matched) {
          reviews.updatePromotionState(operationId, 'indeterminate', 'dispatched', 'readback verification found no matching entity')
          throw new Error('promotion write succeeded but readback verification found no matching entity')
        }
      } catch (readbackErr) {
        const message = (readbackErr as Error).message || String(readbackErr)
        reviews.updatePromotionState(operationId, 'indeterminate', 'dispatched', `readback verification failed: ${message}`)
        throw new Error(`promotion write succeeded but readback verification failed: ${message}`)
      }

      reviews.updatePromotionState(operationId, 'verified', 'dispatched')
      reviews.markCandidatePromoted(candidate.id)
      return {
        ok: true,
        operationId,
        status: 'verified',
        targetDb: candidate.db,
        category: candidate.category,
        key: candidate.key,
      }
    })
  }

  private resolveScope(handle: string, scope: RecallScope | undefined): VaultDbId[] {
    const grant = this.sessions.resolve(handle)
    if (this.sessions.isRevoked(handle)) throw new Error(`session '${handle}' is revoked`)
    if (scope === undefined || scope === 'default') {
      const dbs = [grant.workspaceDb]
      if (grant.readDbs.includes(GLOBAL_DB_ID)) dbs.push(GLOBAL_DB_ID)
      return dbs
    }
    for (const db of scope) {
      if (!grant.readDbs.includes(db)) {
        throw new Error(`session '${handle}' may not select '${db}'`)
      }
    }
    return [...new Set(scope)]
  }

  private checkLive(handle: string, db: VaultDbId): void {
    this.sessions.check(handle, db)
  }

  private envelope<T extends MergeableItem>(
    evaluatedAt: string,
    settled: Array<{ db: string; items: T[]; missing: { db: string; reason: string } | null }>,
    caps: { perDbLimit: number; maxTotal: number; offset: number },
  ): BrokerRecallResult<T> {
    const missing = settled.filter((s) => s.missing !== null).map((s) => s.missing as { db: string; reason: string })
    const ok = settled.filter((s) => s.missing === null)
    const hitPageEdge = ok.some((s) => s.items.length >= caps.perDbLimit)
    // +1 probe: fetch one candidate past the window so hasMore is proven,
    // not guessed. Two DBs below perDbLimit can still overflow maxTotal.
    const merged = mergeRecallResults(
      ok.map((s) => ({ db: s.db, items: s.items })),
      { perDbLimit: caps.perDbLimit, maxTotal: caps.maxTotal + caps.offset + 1 },
    )
    const cutByCap = merged.length > caps.maxTotal + caps.offset
    const window = merged.slice(0, caps.maxTotal + caps.offset)
    const items = window.slice(caps.offset)
    return {
      mergeContract: MERGE_CONTRACT_VERSION,
      evaluatedAt,
      items,
      missing,
      partial: missing.length > 0,
      completeEmpty: missing.length === 0 && merged.length === 0,
      hasMore: hitPageEdge || cutByCap,
    }
  }
}

function validCategory(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 64) {
    throw new Error('invalid category: expected non-empty string (max 64 chars)')
  }
  return value
}

function validCursor(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new Error('invalid cursor: expected non-empty string (max 512 chars)')
  }
  return value
}

function validatedScan(
  db: string,
  res: { items?: unknown; total?: unknown; has_more?: unknown; next_cursor?: unknown } | null | undefined,
): BrowseDbResult {
  if (!res || typeof res !== 'object' || !Array.isArray(res.items)) {
    return { db, items: [], total: null, hasMore: false, nextCursor: null, missing: { db, reason: 'malformed response (items missing)' } }
  }
  return {
    db,
    items: validItems(res),
    total: typeof res.total === 'number' && Number.isFinite(res.total) && res.total >= 0 ? Math.floor(res.total) : null,
    hasMore: res.has_more === true,
    nextCursor: typeof res.next_cursor === 'string' ? res.next_cursor : null,
    missing: null,
  }
}
function validItems(res: { items?: unknown } | null | undefined): RecallItemWire[] {
  if (!res || typeof res !== 'object' || !Array.isArray(res.items)) return []
  return res.items.filter(
    (item): item is RecallItemWire =>
      typeof item === 'object' && item !== null && typeof (item as { id?: unknown }).id === 'string',
  )
}

// A successful RPC can still report backend incompleteness (or garbage).
// outcome.status timeout/partial/degraded/unavailable/error/failed — and any
// response whose items are not an array — mark the source missing instead of
// pretending to a complete empty result.
function backendGap(
  db: string,
  res: { items?: unknown; outcome?: { status?: unknown } } | null | undefined,
): { db: string; reason: string } | null {
  if (!res || typeof res !== 'object' || !Array.isArray(res.items)) {
    return { db, reason: 'malformed response (items missing)' }
  }
  const status = res.outcome?.status
  if (typeof status === 'string' && BACKEND_INCOMPLETE.has(status.toLowerCase())) {
    return { db, reason: `backend reported ${status}` }
  }
  return null
}

function boundedInt(name: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`invalid ${name}: expected integer ${min}..${max}`)
  }
  return value
}

// Manager DB ids are namespaced ('workspace:<uuid>'); the vault server
// addresses workspaces by bare hash. Global lives at hash '' (verified:
// remember schema documents empty workspace_hash as global). Per-DB hash
// scoping inside workspace DBs is a migration-time decision (Phase 6);
// until then the bare uuid addresses that workspace's entities.
function dbWorkspaceHash(db: string): string {
  const prefix = 'workspace:'
  return db.startsWith(prefix) ? db.slice(prefix.length) : db
}
