import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  ADMISSION_POLICY_VERSION,
  redactDeep,
  scanSecrets,
  type AdmissionCandidate,
  type AdmissionVerdict,
} from './admission'

export type ReviewStatus = 'queued' | 'approved' | 'rejected' | 'expired' | 'promoted';

export interface StoredCandidate {
  id: number
  db: string
  category: string
  key: string
  content: string
  futureUse: string
  evidence: AdmissionCandidate['evidence']
  triggers: string[]
  status: string | undefined
  implementedMeta: AdmissionCandidate['implementedMeta']
  policyVersion: number
  revision: number
}

export interface ReviewRecord extends StoredCandidate {
  statusState: ReviewStatus
  verdict: AdmissionVerdict
  decisionMeta: { recheckDecision?: string; override?: { by: string; reason: string } }
  createdAt: number
  decidedAt: number | null
}

export interface ReviewStoreOptions {
  file: string
  /** Max queued candidates; oldest excess expires visibly (never silently). */
  maxQueued?: number
  /** Queue TTL in ms; expired rows are marked, not deleted. */
  queueTtlMs?: number
  /** Durable retention: hard-purge decided/expired rows older than this. */
  purgeAfterMs?: number
  /** Hard size cap in logical payload bytes (see capacity ledger). */
  maxBytes?: number
  /** Promotions retention: keep newest N (default 500). */
  promotionKeepNewest?: number
  /** Promotions TTL in ms, enforced independently of the count cap. */
  promotionTtlMs?: number
}

const DEFAULT_MAX_QUEUED = 200
const DEFAULT_QUEUE_TTL_MS = 14 * 24 * 3600 * 1000
const DEFAULT_PURGE_AFTER_MS = 90 * 24 * 3600 * 1000
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024
const PROMOTION_KEEP_NEWEST = 500
const DEFAULT_PROMOTION_TTL_MS = 90 * 24 * 3600 * 1000
const SCHEMA_VERSION = 3

// Payload column contracts: the byte ledger, backfill and the independent
// SQL check derive from exactly these lists.
const CANDIDATE_PAYLOAD_COLUMNS = [
  'db',
  'category',
  'key',
  'content',
  'future_use',
  'evidence',
  'triggers',
  'candidate_status',
  'implemented_meta',
  'verdict',
  'decision_meta',
] as const

const PROMOTION_PAYLOAD_COLUMNS = [
  'operation_id',
  'from_db',
  'to_db',
  'category',
  'key',
  'snapshot',
] as const

// Canonical column contracts, single definition: CREATE TABLE, migration
// diff and payload accounting all derive from these lists.
const CANDIDATE_COLUMNS: Array<[string, string]> = [
  ['id', 'INTEGER PRIMARY KEY AUTOINCREMENT'],
  ['db', 'TEXT NOT NULL'],
  ['category', 'TEXT NOT NULL'],
  ['key', 'TEXT NOT NULL'],
  ['content', 'TEXT NOT NULL'],
  ['future_use', 'TEXT NOT NULL'],
  ['evidence', 'TEXT NOT NULL'],
  ['triggers', 'TEXT NOT NULL'],
  ['candidate_status', "TEXT NOT NULL DEFAULT ''"],
  ['implemented_meta', "TEXT NOT NULL DEFAULT ''"],
  ['policy_version', 'INTEGER NOT NULL'],
  ['revision', 'INTEGER NOT NULL DEFAULT 1'],
  ['payload_bytes', 'INTEGER NOT NULL DEFAULT 0'],
  ['status', "TEXT NOT NULL DEFAULT 'queued'"],
  ['verdict', "TEXT NOT NULL DEFAULT '{}'"],
  ['decision_meta', "TEXT NOT NULL DEFAULT '{}'"],
  ['created_at', 'INTEGER NOT NULL'],
  ['decided_at', 'INTEGER'],
]

const PROMOTION_COLUMNS: Array<[string, string]> = [
  ['operation_id', 'TEXT PRIMARY KEY'],
  ['from_db', 'TEXT NOT NULL'],
  ['to_db', 'TEXT NOT NULL'],
  ['category', 'TEXT NOT NULL'],
  ['key', 'TEXT NOT NULL'],
  ['snapshot', 'TEXT NOT NULL'],
  ['status', "TEXT NOT NULL DEFAULT 'recorded'"],
  ['error', "TEXT NOT NULL DEFAULT ''"],
  ['payload_bytes', 'INTEGER NOT NULL DEFAULT 0'],
  ['created_at', 'INTEGER NOT NULL'],
  ['settled_at', 'INTEGER'],
]

const COLUMNS = [
  'id',
  'db',
  'category',
  'key',
  'content',
  'future_use',
  'evidence',
  'triggers',
  'candidate_status',
  'implemented_meta',
  'policy_version',
  'revision',
  'status',
  'verdict',
  'decision_meta',
  'created_at',
  'decided_at',
] as const

function mapRow(row: Record<string, unknown>): ReviewRecord {
  return {
    id: row.id as number,
    db: row.db as string,
    category: row.category as string,
    key: row.key as string,
    content: row.content as string,
    futureUse: row.future_use as string,
    evidence: JSON.parse(row.evidence as string) as StoredCandidate['evidence'],
    triggers: JSON.parse(row.triggers as string) as string[],
    status: (row.candidate_status as string) || undefined,
    implementedMeta: row.implemented_meta
      ? (JSON.parse(row.implemented_meta as string) as StoredCandidate['implementedMeta'])
      : undefined,
    policyVersion: row.policy_version as number,
    revision: row.revision as number,
    statusState: row.status as ReviewStatus,
    verdict: JSON.parse(row.verdict as string) as AdmissionVerdict,
    decisionMeta: JSON.parse((row.decision_meta as string) || '{}') as ReviewRecord['decisionMeta'],
    createdAt: row.created_at as number,
    decidedAt: (row.decided_at as number | null) ?? null,
  }
}

// Candidate store deliberately OUTSIDE the vault: queued (unapproved)
// content must never surface in recall. SQLite file, single writer (main
// process). Retention: queue cap + TTL mark expired visibly; a durable
// purge + size cap bound total growth — nothing vanishes silently.
export class ReviewStore {
  private readonly db: DatabaseSync
  private readonly maxQueued: number
  private readonly queueTtlMs: number
  private readonly purgeAfterMs: number
  private readonly maxBytes: number
  private readonly promotionKeepNewest: number
  private readonly promotionTtlMs: number
  expiredOnWrite = 0
  purgedTotal = 0

  constructor(opts: ReviewStoreOptions) {
    mkdirSync(dirname(opts.file), { recursive: true })
    const db = new DatabaseSync(opts.file)
    try {
      this.maxQueued = opts.maxQueued ?? DEFAULT_MAX_QUEUED
      this.queueTtlMs = opts.queueTtlMs ?? DEFAULT_QUEUE_TTL_MS
      this.purgeAfterMs = opts.purgeAfterMs ?? DEFAULT_PURGE_AFTER_MS
      this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
      this.promotionKeepNewest = opts.promotionKeepNewest ?? PROMOTION_KEEP_NEWEST
    this.promotionTtlMs = opts.promotionTtlMs ?? DEFAULT_PROMOTION_TTL_MS
      this.initSchema(db)
      this.migrateSchema(db)
      this.db = db
    } catch (e) {
      db.close() // never leak a locked handle on failed init
      throw e
    }
  }

  private initSchema(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS candidates (
        ${CANDIDATE_COLUMNS.map(([name, def]) => `${name} ${def}`).join(',\n        ')}
      );
      CREATE INDEX IF NOT EXISTS idx_candidates_status ON candidates(status);
      CREATE TABLE IF NOT EXISTS promotions (
        ${PROMOTION_COLUMNS.map(([name, def]) => `${name} ${def}`).join(',\n        ')}
      );
      CREATE TABLE IF NOT EXISTS capacity (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
    `)
  }

  /**
   * Versioned migration in ONE transaction: schema version < CURRENT means
   * add missing columns, recompute EVERYTHING (rows + ledger), bump version.
   * A stale capacity row from any previous version never survives — even
   * with complete columns, a version mismatch forces the full rebuild.
   * Idempotent: a crash before COMMIT leaves the old version → retry.
   */
  private migrateSchema(db: DatabaseSync): void {
    const versionRow = db.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as
      | { value: number }
      | undefined
    const version = versionRow?.value ?? 0
    if (version >= SCHEMA_VERSION) return
    db.exec('BEGIN IMMEDIATE')
    try {
      const liveColumns = (table: string): Set<string> => {
        const cols = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{ name: string }>
        return new Set(cols.map((c) => c.name))
      }
      const candLive = liveColumns('candidates')
      for (const [name, def] of CANDIDATE_COLUMNS) {
        if (name !== 'id' && !candLive.has(name)) {
          db.exec(`ALTER TABLE candidates ADD COLUMN ${name} ${def}`)
        }
      }
      const promLive = liveColumns('promotions')
      for (const [name, def] of PROMOTION_COLUMNS) {
        if (name !== 'operation_id' && !promLive.has(name)) {
          db.exec(`ALTER TABLE promotions ADD COLUMN ${name} ${def}`)
        }
      }
      this.backfillPayloadBytes(db)
      db.prepare(`INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = ?`)
        .run(SCHEMA_VERSION, SCHEMA_VERSION)
      db.exec('COMMIT')
    } catch (e) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // already rolled back — report the original error
      }
      throw e
    }
  }

  private backfillPayloadBytes(db: DatabaseSync = this.db): void {
    // No own transaction: callers own atomicity (migrateSchema wraps the
    // whole migration; payloadTotal fallback runs standalone best-effort).
    const candRows = db
      .prepare(`SELECT id, ${CANDIDATE_PAYLOAD_COLUMNS.join(', ')} FROM candidates`)
      .all() as Array<Record<string, unknown>>
    const updCand = db.prepare(`UPDATE candidates SET payload_bytes = ? WHERE id = ?`)
    let total = 0
    for (const r of candRows) {
      const bytes = payloadBytesOf(CANDIDATE_PAYLOAD_COLUMNS.map((c) => (r[c] as string) ?? ''))
      updCand.run(bytes, r.id as number)
      total += bytes
    }
    const promRows = db
      .prepare(`SELECT operation_id, ${PROMOTION_PAYLOAD_COLUMNS.join(', ')} FROM promotions`)
      .all() as Array<Record<string, unknown>>
    const updProm = db.prepare(`UPDATE promotions SET payload_bytes = ? WHERE operation_id = ?`)
    for (const r of promRows) {
      const bytes = payloadBytesOf(PROMOTION_PAYLOAD_COLUMNS.map((c) => (r[c] as string) ?? ''))
      updProm.run(bytes, r.operation_id as string)
      total += bytes
    }
    db.prepare(`INSERT INTO capacity (key, value) VALUES ('payload_bytes', ?) ON CONFLICT(key) DO UPDATE SET value = ?`)
      .run(total, total)
  }

  /** Runs fn in a transaction (for public mutators that lack their own). */
  private writeTxn<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const out = fn()
      this.db.exec('COMMIT')
      return out
    } catch (e) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // already rolled back — report the original error
      }
      throw e
    }
  }

  close(): void {
    this.db.close()
  }

  submit(candidate: AdmissionCandidate, verdict: AdmissionVerdict): number {
    const now = Date.now()
    // Defense in depth: EVERY persisted string is redacted recursively —
    // content, key, triggers, evidence, meta and verdict reasons. A reject
    // with secrets therefore leaves no raw secret anywhere in the row.
    const safe: AdmissionCandidate = redactDeep({
      db: candidate.db,
      category: candidate.category,
      key: candidate.key,
      content: candidate.content,
      futureUse: candidate.futureUse,
      evidence: candidate.evidence,
      triggers: candidate.triggers,
      status: candidate.status,
      implementedMeta: candidate.implementedMeta,
    })
    const safeVerdict: AdmissionVerdict = redactDeep(verdict)
    // Canonical payload: EXACTLY the strings below (see payloadBytesOf).
    const payloadCols = [
      safe.db,
      safe.category,
      safe.key,
      safe.content,
      safe.futureUse,
      JSON.stringify(safe.evidence),
      JSON.stringify(safe.triggers),
      safe.status ?? '',
      JSON.stringify(safe.implementedMeta ?? null),
      JSON.stringify(safeVerdict),
      '{}',
    ]
    const payload = payloadBytesOf(payloadCols)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db
        .prepare(
          `INSERT INTO candidates
            (db, category, key, content, future_use, evidence, triggers,
             candidate_status, implemented_meta, policy_version, revision,
             status, verdict, decision_meta, created_at, decided_at, payload_bytes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'queued', ?, '{}', ?, NULL, ?)`,
        )
        .run(
          safe.db,
          safe.category,
          safe.key,
          safe.content,
          safe.futureUse,
          JSON.stringify(safe.evidence),
          JSON.stringify(safe.triggers),
          safe.status ?? '',
          JSON.stringify(safe.implementedMeta ?? null),
          ADMISSION_POLICY_VERSION,
          JSON.stringify(safeVerdict),
          now,
          payload,
        )
      const id = Number(row.lastInsertRowid)
      this.chargePayload(payload)
      this.enforceRetention(now)
      this.db.exec('COMMIT')
      return id
    } catch (e) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // already rolled back / never began — report the original error
      }
      throw e
    }
  }

  /** Pending review candidates, oldest first. Expired ones are marked first. */
  queued(now = Date.now()): ReviewRecord[] {
    this.markExpired(now)
    return (
      this.db.prepare(`SELECT ${COLUMNS.join(', ')} FROM candidates WHERE status = 'queued' ORDER BY id ASC`).all() as Array<
        Record<string, unknown>
      >
    ).map(mapRow)
  }

  /**
   * Decide a candidate. Revision CAS is MANDATORY (lost updates between
   * reviewers fail loudly). Approval additionally requires a policy
   * re-check against the EXACT stored revision: 'approve' passes, 'review'
   * passes only with an explicit human override (who + why, audited in
   * decision_meta), 'reject' never passes — structural failures cannot be
   * healed by flipping status elsewhere.
   */
  decide(
    id: number,
    status: Extract<ReviewStatus, 'approved' | 'rejected'>,
    opts: {
      expectedRevision: number
      recheck?: (candidate: StoredCandidate) => AdmissionVerdict
      override?: { by: string; reason: string }
      now?: number
    },
  ): void {
    const current = this.get(id)
    if (!current || current.statusState !== 'queued') throw new Error(`review candidate ${id} not decidable`)
    if (opts.expectedRevision !== current.revision) {
      throw new Error(`review candidate ${id} changed underfoot (expected revision ${opts.expectedRevision})`)
    }
    let meta: ReviewRecord['decisionMeta'] = {}
    if (status === 'approved') {
      if (!opts.recheck) throw new Error(`approval of candidate ${id} requires a policy re-check`)
      const again = opts.recheck(current)
      meta = { recheckDecision: again.decision }
      if (again.decision === 'reject') {
        throw new Error(`approval blocked by re-check: ${again.reasons.join('; ')}`)
      }
      // Non-overridable gaps (unconfirmed global scope, missing test proof)
      // cannot be healed by human override — only by resubmitting evidence.
      if (again.nonOverridable && again.nonOverridable.length > 0) {
        throw new Error(
          `approval blocked: non-overridable gaps (${again.nonOverridable.join(',')}) — resubmit with evidence`,
        )
      }
      if (again.decision === 'review') {
        if (!opts.override?.by || !opts.override?.reason) {
          throw new Error(
            `approval of candidate ${id} needs an explicit human override (re-check: review)`,
          )
        }
        const safeOverride = redactDeep({ by: opts.override.by, reason: opts.override.reason }) as {
          by: string
          reason: string
        }
        meta = { ...meta, override: safeOverride }
      }
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const oldMetaRow = this.db.prepare(`SELECT decision_meta FROM candidates WHERE id = ?`).get(id) as
        | { decision_meta: string }
        | undefined
      const newMetaJson = JSON.stringify(meta)
      const delta =
        Buffer.byteLength(newMetaJson, 'utf8') - Buffer.byteLength(oldMetaRow?.decision_meta ?? '{}', 'utf8')
      const res = this.db
        .prepare(
          `UPDATE candidates SET status = ?, decided_at = ?, decision_meta = ?, payload_bytes = payload_bytes + ?
           WHERE id = ? AND status = 'queued' AND revision = ?`,
        )
        .run(status, opts.now ?? Date.now(), newMetaJson, delta, id, current.revision)
      if (res.changes !== 1) throw new Error(`review candidate ${id} changed underfoot during decide`)
      this.chargePayload(delta)
      this.db.exec('COMMIT')
    } catch (e) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // already rolled back — report the original error
      }
      throw e
    }
  }

  get(id: number): ReviewRecord | null {
    const row = this.db.prepare(`SELECT ${COLUMNS.join(', ')} FROM candidates WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined
    return row ? mapRow(row) : null
  }

  countByStatus(): Record<string, number> {
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM candidates GROUP BY status`)
      .all() as Array<{ status: string; n: number }>
    return Object.fromEntries(rows.map((r) => [r.status, r.n]))
  }

  /** Durable purge of decided/expired rows older than the retention window.
   * Ledger adjustment uses the stored per-row payload_bytes (exact byte
   * contract, no LENGTH recomputation that could drift from write time). */
  purgeExpired(beforeUnixMs: number): number {
    return this.writeTxn(() => this.purgeExpiredLocked(beforeUnixMs))
  }

  private purgeExpiredLocked(beforeUnixMs: number): number {
    const freedCandidates = this.storedPayloadSum(
      `SELECT COALESCE(SUM(payload_bytes), 0) AS n FROM candidates
       WHERE ((status IN ('expired', 'approved', 'rejected') AND decided_at IS NOT NULL AND decided_at < ?)
          OR (status = 'expired' AND created_at < ?))`,
      [beforeUnixMs, beforeUnixMs],
    )
    const res = this.db
      .prepare(`DELETE FROM candidates WHERE status IN ('expired', 'approved', 'rejected') AND decided_at IS NOT NULL AND decided_at < ?`)
      .run(beforeUnixMs)
    const res2 = this.db
      .prepare(`DELETE FROM candidates WHERE status = 'expired' AND created_at < ?`)
      .run(beforeUnixMs)
    const freedPromotions = this.storedPayloadSum(
      `SELECT COALESCE(SUM(payload_bytes), 0) AS n FROM promotions WHERE created_at < ? AND status NOT IN ('intent', 'dispatched', 'indeterminate')`,
      [beforeUnixMs],
    )
    const res3 = this.db
      .prepare(`DELETE FROM promotions WHERE created_at < ? AND status NOT IN ('intent', 'dispatched', 'indeterminate')`)
      .run(beforeUnixMs)
    const n = Number(res.changes) + Number(res2.changes) + Number(res3.changes)
    this.releasePayload(freedCandidates + freedPromotions)
    this.purgedTotal += n
    return n
  }

  /**
   * Explicit, redacted promotion snapshot: every persisted string is
   * secret-scanned fail-closed (any hit refuses the write) and provenance
   * carries project names only — never raw workspace paths. Recoverable via
   * the persistent operation id. No auto-publish, ever.
   */
  recordPromotion(input: {
    operationId: string
    fromDb: string
    toDb: string
    category: string
    key: string
    snapshot: string
    status?: string
  }): void {
    const hits = [
      ...scanField(input.snapshot),
      ...scanField(input.key),
      ...scanField(input.category),
      ...scanField(input.fromDb),
      ...scanField(input.toDb),
      ...scanField(input.operationId),
    ]
    if (hits.length > 0) {
      throw new Error(`promotion refused: secrets detected (${hits.join(',')})`)
    }
    const status = input.status ?? 'recorded'
    const payload = payloadBytesOf([input.operationId, input.fromDb, input.toDb, input.category, input.key, input.snapshot])
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare(
          `INSERT INTO promotions (operation_id, from_db, to_db, category, key, snapshot, status, created_at, payload_bytes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(operation_id) DO UPDATE SET
             status = excluded.status,
             error = '',
             created_at = excluded.created_at`,
        )
        .run(input.operationId, input.fromDb, input.toDb, input.category, input.key, input.snapshot, status, Date.now(), payload)
      this.chargePayload(payload)
      this.purgeExpiredLocked(Date.now() - this.purgeAfterMs)
      this.trimPromotions()
      this.trimPromotionsByAge(Date.now())
      this.db.exec('COMMIT')
    } catch (e) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // already rolled back — report the original error
      }
      throw e
    }
  }

  recordPromotionIntent(input: {
    operationId: string
    fromDb: string
    toDb: string
    category: string
    key: string
    snapshot: string
  }): 'intent' | 'verified' {
    const hits = [
      ...scanField(input.snapshot),
      ...scanField(input.key),
      ...scanField(input.category),
      ...scanField(input.fromDb),
      ...scanField(input.toDb),
      ...scanField(input.operationId),
    ]
    if (hits.length > 0) {
      throw new Error(`promotion refused: secrets detected (${hits.join(',')})`)
    }

    this.db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.db
        .prepare(`SELECT status, error FROM promotions WHERE operation_id = ?`)
        .get(input.operationId) as { status?: string; error?: string } | undefined

      if (existing) {
        if (existing.status === 'verified') {
          this.db.exec('COMMIT')
          return 'verified'
        }
        if (existing.status === 'dispatched') {
          throw new Error(`promotion '${input.operationId}' is currently dispatched in-flight; duplicate dispatch blocked`)
        }
        if (existing.status === 'indeterminate') {
          throw new Error(`promotion '${input.operationId}' is in indeterminate state, manual resolution required`)
        }
        if (existing.status === 'failed' || existing.status === 'intent') {
          this.db
            .prepare(`UPDATE promotions SET status = 'intent', error = '', created_at = ? WHERE operation_id = ? AND status = ?`)
            .run(Date.now(), input.operationId, existing.status)
          this.db.exec('COMMIT')
          return 'intent'
        }
      }

      const payload = payloadBytesOf([input.operationId, input.fromDb, input.toDb, input.category, input.key, input.snapshot])
      this.db
        .prepare(
          `INSERT INTO promotions (operation_id, from_db, to_db, category, key, snapshot, status, created_at, payload_bytes)
           VALUES (?, ?, ?, ?, ?, ?, 'intent', ?, ?)`,
        )
        .run(input.operationId, input.fromDb, input.toDb, input.category, input.key, input.snapshot, Date.now(), payload)
      this.chargePayload(payload)
      this.purgeExpiredLocked(Date.now() - this.purgeAfterMs)
      this.trimPromotions()
      this.trimPromotionsByAge(Date.now())
      this.db.exec('COMMIT')
      return 'intent'
    } catch (e) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // already rolled back
      }
      throw e
    }
  }

  updatePromotionState(
    operationId: string,
    state: 'dispatched' | 'verified' | 'failed' | 'indeterminate',
    expectedCurrentState?: 'intent' | 'dispatched' | 'failed',
    error: string = '',
  ): boolean {
    const settled = state === 'verified' || state === 'failed' ? Date.now() : null
    let query = `UPDATE promotions SET status = ?, error = ?, settled_at = ? WHERE operation_id = ?`
    const params: (string | number | null)[] = [state, error, settled, operationId]
    if (expectedCurrentState) {
      query += ` AND status = ?`
      params.push(expectedCurrentState)
    }
    const res = this.db.prepare(query).run(...params)
    return Number(res.changes) > 0
  }

  markCandidatePromoted(candidateId: number): void {
    this.db
      .prepare(`UPDATE candidates SET status = 'promoted', decided_at = ? WHERE id = ?`)
      .run(Date.now(), candidateId)
  }

  getPromotion(operationId: string): Record<string, unknown> | null {
    return (
      (this.db.prepare(`SELECT * FROM promotions WHERE operation_id = ?`).get(operationId) as unknown as Record<
        string,
        unknown
      >) ?? null
    )
  }

  /** Count retention for promotions, enforced on every promotion write
   * (not only via manual purge): keeps the newest N, ledger-adjusted. */
  private trimPromotions(): void {
    const freed = this.storedPayloadSum(
      `SELECT COALESCE(SUM(payload_bytes), 0) AS n FROM promotions
       WHERE status NOT IN ('intent', 'dispatched', 'indeterminate') AND operation_id NOT IN (
         SELECT operation_id FROM promotions WHERE status NOT IN ('intent', 'dispatched', 'indeterminate') ORDER BY created_at DESC, operation_id DESC LIMIT ?
       )`,
      [this.promotionKeepNewest],
    )
    this.db
      .prepare(
        `DELETE FROM promotions
         WHERE status NOT IN ('intent', 'dispatched', 'indeterminate') AND operation_id NOT IN (
           SELECT operation_id FROM promotions WHERE status NOT IN ('intent', 'dispatched', 'indeterminate') ORDER BY created_at DESC, operation_id DESC LIMIT ?
         )`,
      )
      .run(this.promotionKeepNewest)
    this.releasePayload(freed)
  }

  /** TTL retention for promotions, independent of the count cap: expired
   * promotions go on every promotion write, ledger-adjusted. */
  private trimPromotionsByAge(now: number): void {
    const freed = this.storedPayloadSum(
      `SELECT COALESCE(SUM(payload_bytes), 0) AS n FROM promotions WHERE created_at < ? AND status NOT IN ('intent', 'dispatched', 'indeterminate')`,
      [now - this.promotionTtlMs],
    )
    this.db
      .prepare(`DELETE FROM promotions WHERE created_at < ? AND status NOT IN ('intent', 'dispatched', 'indeterminate')`)
      .run(now - this.promotionTtlMs)
    this.releasePayload(freed)
  }

  private markExpired(now: number): void {
    this.db
      .prepare(`UPDATE candidates SET status = 'expired' WHERE status = 'queued' AND created_at < ?`)
      .run(now - this.queueTtlMs)
  }

  private enforceRetention(now: number): void {
    this.markExpired(now)
    // Durable purge first so the live set, not history, defines the cap.
    this.purgeExpiredLocked(now - this.purgeAfterMs)
    // Logical payload cap (not file size: pages may sit in cache/journal).
    // Throws inside the caller's transaction → full rollback, nothing stored.
    if (this.payloadTotal() > this.maxBytes) {
      throw new Error('review store over size cap: purge or raise the cap explicitly')
    }
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM candidates WHERE status = 'queued'`).get() as {
      n: number
    }
    const excess = row.n - this.maxQueued
    if (excess > 0) {
      this.db
        .prepare(
          `UPDATE candidates SET status = 'expired' WHERE id IN (
             SELECT id FROM candidates WHERE status = 'queued' ORDER BY id ASC LIMIT ?
           )`,
        )
        .run(excess)
      this.expiredOnWrite += excess
    }
  }

  /** Logical payload ledger: sum of persisted text bytes. Deterministic
   * inside transactions (file size would lag on cached/journal pages). */
  private payloadTotal(): number {
    const row = this.db.prepare(`SELECT value FROM capacity WHERE key = 'payload_bytes'`).get() as
      | { value: number }
      | undefined
    if (row) return row.value
    this.backfillPayloadBytes()
    return (
      this.db.prepare(`SELECT value FROM capacity WHERE key = 'payload_bytes'`).get() as { value: number }
    ).value
  }

  private storedPayloadSum(sql: string, params: number[]): number {
    return (this.db.prepare(sql).get(...params) as unknown as { n: number }).n
  }

  private chargePayload(bytes: number): void {
    const total = this.payloadTotal() + bytes
    if (total > this.maxBytes) {
      throw new Error('review store over size cap: purge or raise the cap explicitly')
    }
    this.db.prepare(`UPDATE capacity SET value = ? WHERE key = 'payload_bytes'`).run(total)
  }

  private releasePayload(bytes: number): void {
    const total = Math.max(0, this.payloadTotal() - bytes)
    this.db.prepare(`UPDATE capacity SET value = ? WHERE key = 'payload_bytes'`).run(total)
  }

  /** Diagnostics: current ledger value (Ops view + tests). */
  payloadBytesTotal(): number {
    return this.payloadTotal()
  }
}

/** Canonical byte contract, single definition: UTF-8 bytes of every
 * persisted payload string. Both the TS ledger and the independent SQL
 * check (LENGTH(CAST(col AS BLOB))) must implement exactly this set. */
function payloadBytesOf(values: unknown[]): number {
  let total = 0
  for (const v of values) {
    const s = typeof v === 'string' ? v : JSON.stringify(v ?? null)
    total += Buffer.byteLength(s, 'utf8')
  }
  return total
}

function scanField(text: string): string[] {
  return scanSecrets(text)
}

export function reviewStoreFile(userDataDir: string): string {
  return join(userDataDir, 'vault', 'review.db')
}
