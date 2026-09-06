import { DatabaseSync } from 'node:sqlite'

export type UsageKind = 'retrieved' | 'applied';

export interface UsageEvent {
  /** Idempotency key (caller-generated): replays collapse, never double-count. */
  eventId: string
  kind: UsageKind
  db: string
  entityId: string
  entityVersion: number
  at: number
}

// retrieved ≠ applied, and the ledger proves it instead of claiming it:
// - retrieved: a recall SERVED the memory (exposure, automatic).
// - applied: an agent explicitly applied it, citing memory id + version.
// Reinforcement decisions downstream must use applied; retrieval_count is
// exposure telemetry, never usefulness evidence. Recording an application
// is not a success proof either — outcomes live elsewhere.
export class UsageLedger {
  private readonly db: DatabaseSync

  constructor(file: string) {
    this.db = new DatabaseSync(file)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_events (
        event_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        db TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        entity_version INTEGER NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_usage_entity ON usage_events(db, entity_id);
    `)
  }

  close(): void {
    this.db.close()
  }

  /**
   * Idempotent on identical replay; REJECTS the same eventId with a
   * differing payload (restart/replay conflict) instead of silently
   * ignoring it — a quiet drop would hide double-application bugs.
   */
  record(event: Omit<UsageEvent, 'at'> & { at?: number }): void {
    const at = event.at ?? Date.now()
    const existing = this.db
      .prepare(`SELECT kind, db, entity_id, entity_version FROM usage_events WHERE event_id = ?`)
      .get(event.eventId) as
      | { kind: string; db: string; entity_id: string; entity_version: number }
      | undefined
    if (existing) {
      if (
        existing.kind !== event.kind ||
        existing.db !== event.db ||
        existing.entity_id !== event.entityId ||
        existing.entity_version !== event.entityVersion
      ) {
        throw new Error(`usage event '${event.eventId}' conflicts with the recorded payload`)
      }
      return // identical replay: collapse
    }
    this.db
      .prepare(
        `INSERT INTO usage_events (event_id, kind, db, entity_id, entity_version, at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(event.eventId, event.kind, event.db, event.entityId, event.entityVersion, at)
  }

  counts(db: string, entityId: string, entityVersion?: number): { retrieved: number; applied: number } {
    const rows =
      entityVersion === undefined
        ? ((this.db
            .prepare(`SELECT kind, COUNT(*) AS n FROM usage_events WHERE db = ? AND entity_id = ? GROUP BY kind`)
            .all(db, entityId) as Array<{ kind: string; n: number }>))
        : ((this.db
            .prepare(
              `SELECT kind, COUNT(*) AS n FROM usage_events WHERE db = ? AND entity_id = ? AND entity_version = ? GROUP BY kind`,
            )
            .all(db, entityId, entityVersion) as Array<{ kind: string; n: number }>))
    let retrieved = 0
    let applied = 0
    for (const r of rows) {
      if (r.kind === 'retrieved') retrieved = r.n
      else if (r.kind === 'applied') applied = r.n
    }
    return { retrieved, applied }
  }

  total(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM usage_events`).get() as { n: number }).n
  }
}
