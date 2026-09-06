import { admit, type AdmissionCandidate } from './admission'
import { existsSync } from 'node:fs'
import { MemoryBroker, type MemoryPromoteResult } from './broker'
import { SessionRegistry } from './capabilities'
import { GLOBAL_DB_ID, pathsForDb, workspaceDbId } from './paths'
import { ShadowEval, type ShadowRunRow } from './shadow'
import type { MemoryPromotePreview, MemoryReviewRow } from '../../shared/types'
import { ReviewStore, reviewStoreFile, type ReviewRecord } from './reviewStore'
import type { VaultManager } from './vaultManager'
import { McpBridgeServer, type McpBridgeEndpoint } from './mcpBridge'

export interface BrowseInput {
  /** 'workspace' = active workspace DB, 'global' = shared DB (separate choice). */
  db: 'workspace' | 'global'
  category?: string
  limit?: number
  cursor?: string
}

/** Internal cursor-chain cap: 10 backend pages per browse call. */
const BROWSE_MAX_PAGES = 10

export interface ScreenApiDeps {
  isEnabled: () => boolean
  userDataDir: string
  getManager: () => VaultManager | null
}

export interface DecideInput {
  id: number
  approved: boolean
  expectedRevision: number
  by?: string
  reason?: string
}

// Read-only screen backend for the Phase-4 Memory-Screen. Every method
// fails closed while the memory vaults are disabled — no child, no file.
// Reads go through per-call sessions (opened, used, closed: never leaked).
// Review decisions touch ONLY the isolated review.db (Phase-3 state);
// vault promotion is a dry-run preview — the write itself stays locked
// until the migration phase.
export class MemoryScreenApi {
  private readonly sessions: SessionRegistry
  private readonly liveHandles = new Set<string>()
  private broker: MemoryBroker | null = null
  private brokerOf: VaultManager | null = null
  private review: ReviewStore | null = null
  private shadow: ShadowEval | null = null
  private closed = false
  private terminalBridges = new Map<string, McpBridgeEndpoint>()

  constructor(private readonly deps: ScreenApiDeps) {
    this.sessions = new SessionRegistry(() => !this.deps.isEnabled())
  }

  private gate(): void {
    if (this.closed) throw new Error('memory screen closed')
    if (!this.deps.isEnabled()) throw new Error('memory screen disabled')
  }

  /**
   * Called when the flag flips off (settings) and from close(): revokes
   * every live session so in-flight RPCs fail instead of delivering
   * answers after disable. New calls stay blocked via gate().
   */
  onDisabled(): void {
    for (const handle of this.liveHandles) {
      try {
        this.sessions.revoke(handle)
      } catch {
        // unknown already — still ensure the handle is forgotten below
      }
      try {
        this.sessions.close(handle)
      } catch {
        // already closed — nothing to forget
      }
    }
    this.liveHandles.clear()
    // In-flight shadow runs abort before capture and before record.
    this.shadow?.invalidate()
  }

  private async withSession<T>(
    workspaceId: string,
    fn: (broker: MemoryBroker, handle: string) => Promise<T>,
  ): Promise<T> {
    this.gate()
    const broker = this.brokerFor()
    const handle = this.sessions.open(workspaceId, {})
    this.liveHandles.add(handle)
    try {
      const res = await fn(broker, handle)
      // Re-check after the RPC: a disable mid-flight revokes the session
      // (broker guards throw) and this gate drops any answer regardless.
      this.gate()
      return res
    } finally {
      this.liveHandles.delete(handle)
      try {
        this.sessions.close(handle)
      } catch {
        // revoked/closed by onDisabled mid-flight — already forgotten
      }
    }
  }

  private brokerFor(): MemoryBroker {
    const manager = this.deps.getManager()
    if (!manager) throw new Error('memory vault not ready')
    if (!this.broker || this.brokerOf !== manager) {
      this.broker = new MemoryBroker(manager, this.sessions, { allowLiveWrites: true })
      this.brokerOf = manager
    }
    return this.broker
  }

  private reviews(): ReviewStore {
    if (!this.review) this.review = new ReviewStore({ file: reviewStoreFile(this.deps.userDataDir) })
    return this.review
  }

  shadowRuns(limit = 20): ShadowRunRow[] {
    this.gate()
    return this.shadows().list(limit)
  }

  /** Hook-triggered shadow run (Stop events). Rejects on cooldown/disabled. */
  runShadow(input: { workspaceId: string; workspaceName: string; hookEvent: string; message?: string }): Promise<unknown> {
    this.gate()
    return this.shadows().run(input)
  }

  private shadows(): ShadowEval {
    if (!this.shadow) {
      this.shadow = new ShadowEval({
        isEnabled: this.deps.isEnabled,
        userDataDir: this.deps.userDataDir,
        getManager: this.deps.getManager,
      })
    }
    return this.shadow
  }

  status(): { enabled: boolean; ready: boolean } {
    const enabled = this.deps.isEnabled()
    return { enabled, ready: enabled && this.deps.getManager() !== null }
  }

  async search(workspaceId: string, query: string, limit = 10, scope?: string[]): Promise<unknown> {
    return this.withSession(workspaceId, (broker, handle) =>
      broker.recall(handle, { query, limit, mode: 'dense' }, scope ? { scope } : {}),
    )
  }

  async entity(workspaceId: string, db: string, id: string): Promise<unknown> {
    return this.withSession(workspaceId, (broker, handle) => broker.getEntity(handle, db, id))
  }

  async history(workspaceId: string, db: string, category: string, key: string): Promise<unknown> {
    return this.withSession(workspaceId, (broker, handle) => broker.history(handle, db, category, key))
  }

  /**
   * Browse-first listing: exactly ONE explicitly selected DB, never merged.
   * A missing DB file is reported as noStore (empty state + hint) and is
   * NEVER created as a browse side effect. An EXISTING file is booted via
   * bootExisting (refuses missing files/keys, aborts on races) so the read
   * itself runs on callIfReady, which can never ensure/init.
   * Residual race: deletion between check and boot recreates (same class
   * as today's recall path) — documented, not silent.
   * The backend `total` counts only the returned page, so the screenApi
   * follows cursors internally (100/page, max 10 pages) and reports the
   * REAL total — the renderer never shows a page count as the collection
   * size. Fail-closed like all reads.
   */
  async browse(workspaceId: string, input: BrowseInput): Promise<unknown> {
    if (input.db !== 'workspace' && input.db !== 'global') {
      throw new Error(`invalid browse db '${String((input as { db?: unknown }).db)}' (expected 'workspace' or 'global')`)
    }
    return this.withSession(workspaceId, async (broker, handle) => {
      const db = input.db === 'global' ? GLOBAL_DB_ID : workspaceDbId(workspaceId)
      if (!existsSync(pathsForDb(this.deps.userDataDir, db).dbFile)) {
        return { db, noStore: true, items: [], total: null, hasMore: false, nextCursor: null, missing: null }
      }
      // Boot the existing store (never creates: bootExisting refuses
      // missing files AND missing keys, and aborts on races).
      const manager = this.deps.getManager()
      if (!manager) throw new Error('memory vault not ready')
      await manager.bootExisting(db)
      const items: unknown[] = []
      let cursor = input.cursor
      let missing: { db: string; reason: string } | null = null
      let nextCursor: string | null = null
      // The first page honors an explicit smaller limit (tests, previews);
      // follow-ups always take full backend pages.
      let limit = input.limit
      // A resumed chain (input.cursor) reports only its remainder: the
      // total stays unknown (null) — never the rest as the collection.
      let complete = input.cursor == null
      for (let page = 0; page < BROWSE_MAX_PAGES; page += 1) {
        const res = await broker.browse(handle, { scope: [db], category: input.category, limit, cursor })
        const one = res.perDb[0]
        if (!one || one.missing) {
          missing = one?.missing ?? { db, reason: 'empty browse response' }
          nextCursor = null
          complete = false
          break
        }
        items.push(...one.items)
        if (!one.hasMore) {
          nextCursor = null
          break
        }
        if (!one.nextCursor) {
          // Backend claims more but offers no cursor: cannot continue —
          // report instead of silently truncating.
          missing = { db, reason: 'backend reports more entries without a cursor' }
          nextCursor = null
          complete = false
          break
        }
        if (one.nextCursor === cursor) {
          // Backend repeats the cursor: stop instead of looping forever;
          // the count stays unknown.
          missing = { db, reason: 'backend cursor did not advance' }
          nextCursor = one.nextCursor
          complete = false
          break
        }
        cursor = one.nextCursor
        limit = undefined
        nextCursor = one.nextCursor
      }
      if (nextCursor !== null) complete = false // page cap reached
      // total is REAL only on full enumeration — otherwise unknown (null),
      // never a page count.
      return {
        db,
        noStore: false,
        items,
        total: complete ? items.length : null,
        hasMore: nextCursor !== null,
        nextCursor,
        missing,
      }
    })
  }

  reviewList(): { queued: MemoryReviewRow[]; counts: Record<string, number> } {
    this.gate()
    const store = this.reviews()
    return {
      queued: store.queued().map((r) => ({
        id: r.id,
        db: r.db,
        category: r.category,
        key: r.key,
        content: r.content,
        futureUse: r.futureUse,
        triggers: r.triggers,
        sourceRef: r.evidence?.sourceRef ?? '',
        verdictDecision: r.verdict.decision,
        statusState: r.statusState,
        revision: r.revision,
        createdAt: r.createdAt,
        decidedAt: r.decidedAt,
      })),
      counts: store.countByStatus(),
    }
  }

  reviewDecide(input: DecideInput): ReviewRecord | null {
    this.gate()
    const store = this.reviews()
    if (!input.approved) {
      store.decide(input.id, 'rejected', { expectedRevision: input.expectedRevision })
      return store.get(input.id)
    }
    const current = store.get(input.id)
    if (!current) throw new Error(`review candidate ${input.id} not found`)
    const candidate: AdmissionCandidate = {
      db: current.db,
      category: current.category as AdmissionCandidate['category'],
      key: current.key,
      content: current.content,
      futureUse: current.futureUse,
      evidence: current.evidence,
      triggers: current.triggers,
      status: current.status,
      implementedMeta: current.implementedMeta,
    }
    // Screen re-check consults pending queue entries only (documented
    // limitation): the full live-vault conflict check happens at promotion
    // time, which is dry-run only in this phase.
    const peers = store.queued().filter((r) => r.id !== current.id)
    const recheck = (): ReturnType<typeof admit> =>
      admit(candidate, {
        findSameKey: (db, category, key) =>
          peers
            .filter((r) => r.db === db && r.category === category && r.key === key)
            .map((r) => ({ status: r.statusState, content: r.content })),
      })
    store.decide(input.id, 'approved', {
      expectedRevision: input.expectedRevision,
      recheck,
      override:
        input.by && input.reason ? { by: input.by, reason: input.reason } : undefined,
    })
    return store.get(input.id)
  }

  promoteDryRun(id: number): MemoryPromotePreview {
    this.gate()
    const record = this.reviews().get(id)
    if (!record) throw new Error(`review candidate ${id} not found`)
    if (record.statusState !== 'approved') {
      throw new Error(`candidate ${id} is ${record.statusState}, only approved candidates preview promotion`)
    }
    return {
      dryRun: true,
      targetDb: record.db,
      category: record.category,
      key: record.key,
      content: record.content,
      triggers: record.triggers,
      sourceRef: record.evidence?.sourceRef ?? '',
      note: 'dry run only: no vault write performed (locked until migration)',
    }
  }

  async promote(id: number, expectedRevision: number): Promise<MemoryPromoteResult> {
    this.gate()
    const store = this.reviews()
    const record = store.get(id)
    if (!record) throw new Error(`review candidate ${id} not found`)
    if (record.statusState === 'promoted') {
      if (record.revision !== expectedRevision) {
        throw new Error(`candidate ${id} revision mismatch: expected ${expectedRevision}, found ${record.revision}`)
      }
      const operationId = `${record.id}:${record.revision}:${record.db}`
      const existing = store.getPromotion(operationId)
      if (existing && existing.status === 'verified') {
        return {
          ok: true,
          operationId,
          status: 'verified',
          targetDb: record.db,
          category: record.category,
          key: record.key,
        }
      }
    }
    if (record.statusState !== 'approved') {
      throw new Error(`candidate ${id} is ${record.statusState}, only approved candidates can be promoted`)
    }
    if (record.revision !== expectedRevision) {
      throw new Error(`candidate ${id} revision mismatch: expected ${expectedRevision}, found ${record.revision}`)
    }

    const workspaceId = record.db.startsWith('workspace:') ? record.db.slice('workspace:'.length) : 'global'
    const handle = this.sessions.open(workspaceId === 'global' ? '11111111-1111-4111-8111-111111111111' : workspaceId, {
      purpose: 'screen_promote',
      mayPromote: true,
      mayWriteWorkspace: true,
      mayWriteGlobal: workspaceId === 'global',
    })
    this.liveHandles.add(handle)
    try {
      const broker = this.brokerFor()
      const result = await broker.promote(handle, record, store)
      this.gate()
      return result
    } finally {
      this.sessions.revoke(handle)
      this.sessions.close(handle)
      this.liveHandles.delete(handle)
    }
  }

  async createTerminalBridge(workspaceId: string, terminalId: string): Promise<McpBridgeEndpoint | null> {
    if (this.closed || !this.deps.isEnabled()) return null
    const manager = this.deps.getManager()
    if (!manager) return null

    await this.closeTerminalBridge(terminalId)

    const sessionHandle = this.sessions.open(workspaceId, {
      purpose: 'terminal_mcp',
      includeGlobal: true,
      mayWriteWorkspace: false,
      mayWriteGlobal: false,
      mayPromote: false,
    })
    this.liveHandles.add(sessionHandle)

    const broker = this.brokerFor()
    const bridge = new McpBridgeServer({
      broker,
      sessions: this.sessions,
      workspaceId,
      sessionHandle,
    })

    try {
      const socketPath = await bridge.start()
      const endpoint: McpBridgeEndpoint = {
        socketPath,
        sessionHandle,
        close: async () => {
          await bridge.close()
          this.sessions.revoke(sessionHandle)
          this.sessions.close(sessionHandle)
          this.liveHandles.delete(sessionHandle)
        },
      }
      this.terminalBridges.set(terminalId, endpoint)
      return endpoint
    } catch {
      this.sessions.revoke(sessionHandle)
      this.sessions.close(sessionHandle)
      this.liveHandles.delete(sessionHandle)
      return null
    }
  }

  async closeTerminalBridge(terminalId: string): Promise<void> {
    const existing = this.terminalBridges.get(terminalId)
    if (existing) {
      this.terminalBridges.delete(terminalId)
      // Synchronously revoke session first before awaiting bridge close
      this.sessions.revoke(existing.sessionHandle)
      this.sessions.close(existing.sessionHandle)
      this.liveHandles.delete(existing.sessionHandle)
      await existing.close().catch(() => undefined)
    }
  }

  close(): void {
    // Irreversible: later calls fail closed even if re-enabled — a fresh
    // instance is required (shutdown semantics, mirrors the service).
    this.closed = true
    for (const bridge of this.terminalBridges.values()) {
      void bridge.close().catch(() => undefined)
    }
    this.terminalBridges.clear()
    this.onDisabled()
    this.review?.close()
    this.review = null
    this.shadow?.close()
    this.shadow = null
    this.broker = null
    this.brokerOf = null
  }
}
