import { mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { admit, redactDeep } from './admission'
import { MemoryBroker } from './broker'
import { SessionRegistry } from './capabilities'
import { workspaceDbId } from './paths'
import type { VaultManager } from './vaultManager'

export interface ShadowDeps {
  isEnabled: () => boolean
  userDataDir: string
  getManager: () => VaultManager | null
}

export interface ShadowInput {
  workspaceId: string
  workspaceName: string
  hookEvent: string
  message?: string
}

export interface ShadowNote {
  key: string
  summary: string
  type: string
  verdict: string
  score: number
}

export interface ShadowReceipt {
  id: number
  createdAt: number
  workspaceId: string
  hookEvent: string
  recallHits: number
  notes: ShadowNote[]
  accepted: number
  /** Synthetic policy probe: source/trigger are invented, conflict lookup
   * is empty — the accepted quote is a pipeline-health signal, NOT a real
   * admission rate. */
  evalKind: 'synthetic-policy-probe'
}

export interface ShadowRunRow {
  id: number
  createdAt: number
  workspaceId: string
  hookEvent: string
  recallHits: number
  notesTotal: number
  notesAccepted: number
  receipt: unknown
}

/** Retention: newest N runs (bounded file, no ledger needed). */
const KEEP_NEWEST_RUNS = 200
/** Per-workspace cooldown: at most one shadow run per minute. */
const COOLDOWN_MS = 60_000

export function shadowDbFile(userDataDir: string): string {
  return join(userDataDir, 'vault', 'shadow.db')
}

function asNotes(raw: unknown): Array<{ key?: unknown; summary?: unknown; type?: unknown }> {
  const notes = (raw as { notes?: unknown })?.notes
  return Array.isArray(notes) ? (notes as Array<{ key?: unknown; summary?: unknown; type?: unknown }>) : []
}

// Shadow evaluation for the Phase-5 hook pipeline. Proven side-effect-free
// building blocks only: broker.recallWhen (Phase 2e) + capture dry_run
// (captureDryRun.live.test.ts) + the pure admit() policy. NOTHING here
// writes to any vault: no remember, no promote, no maintain. Receipts land
// in an isolated shadow.db (never in recall, never in the review queue).
export class ShadowEval {
  private readonly sessions = new SessionRegistry()
  private broker: MemoryBroker | null = null
  private brokerOf: VaultManager | null = null
  private db: DatabaseSync | null = null
  private readonly liveHandles = new Set<string>()
  private generation = 0
  private closed = false
  private lastRunAt = new Map<string, number>()

  constructor(private readonly deps: ShadowDeps) {}

  private gate(): void {
    if (this.closed) throw new Error('shadow eval closed')
    if (!this.deps.isEnabled()) throw new Error('shadow eval disabled')
  }

  private checkGen(gen: number): void {
    if (this.closed || gen !== this.generation) throw new Error('shadow eval superseded')
  }

  /** Revokes ALL live sessions and retires the generation: in-flight runs
   * abort before capture and before record. Re-usable after re-enable. */
  invalidate(): void {
    this.generation++
    for (const handle of this.liveHandles) {
      try {
        this.sessions.revoke(handle)
      } catch {
        // unknown already — still forget below
      }
      try {
        this.sessions.close(handle)
      } catch {
        // already closed — nothing to forget
      }
    }
    this.liveHandles.clear()
  }

  private store(): DatabaseSync {
    if (!this.db) {
      const file = shadowDbFile(this.deps.userDataDir)
      mkdirSync(dirname(file), { recursive: true })
      const db = new DatabaseSync(file)
      db.exec(`
        CREATE TABLE IF NOT EXISTS runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at INTEGER NOT NULL,
          workspace_id TEXT NOT NULL,
          hook_event TEXT NOT NULL,
          recall_hits INTEGER NOT NULL,
          notes_total INTEGER NOT NULL,
          notes_accepted INTEGER NOT NULL,
          receipt TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at);
      `)
      this.db = db
    }
    return this.db
  }

  /** Cooldown gate (per workspace). True when the run may proceed. */
  checkCooldown(workspaceId: string, now = Date.now()): boolean {
    const last = this.lastRunAt.get(workspaceId) ?? 0
    if (now - last < COOLDOWN_MS) return false
    this.lastRunAt.set(workspaceId, now)
    return true
  }

  async run(input: ShadowInput): Promise<ShadowReceipt> {
    this.gate()
    if (!this.checkCooldown(input.workspaceId)) throw new Error('shadow eval cooldown')
    const gen = this.generation
    const manager = this.deps.getManager()
    if (!manager) throw new Error('memory vault not ready')
    const wsDb = workspaceDbId(input.workspaceId) // throws on invalid ids
    if (!this.broker || this.brokerOf !== manager) {
      this.broker = new MemoryBroker(manager, this.sessions)
      this.brokerOf = manager
    }
    const broker = this.broker
    const handle = this.sessions.open(input.workspaceId, {})
    this.liveHandles.add(handle)
    try {
      const context = input.message?.trim() || `${input.hookEvent} in ${input.workspaceName}`
      const recallRes = await broker.recallWhen(handle, context, 5)
      this.checkGen(gen)
      const text = `# Session ${input.hookEvent} in ${input.workspaceName}\n\n${input.message ?? 'no message'}`
      // Liveness guard dispatches synchronously with the call: a disable
      // during a slow ensure still blocks the capture dispatch itself.
      const live = (): void => {
        this.gate()
        this.checkGen(gen)
        this.sessions.assertLive(handle)
      }
      const cap = (await manager.call(wsDb, 'perseus_vault_capture', {
        text,
        dry_run: true,
        llm: false,
        consume: false,
        workspace_hash: input.workspaceId.toLowerCase(),
        max_entities: 10,
        },
        live,
      )) as unknown
      this.checkGen(gen)
      const notes: ShadowNote[] = asNotes(cap)
        .slice(0, 20)
        .map((n) => {
          const key = String(n.key ?? 'untitled').slice(0, 120)
          const summary = String(n.summary ?? '').slice(0, 500)
          const type = String(n.type ?? 'takeaway').slice(0, 40)
          const verdict = admit(
            {
              db: wsDb,
              category: 'decision',
              key,
              content: summary || key,
              futureUse: `Shadow eval for ${input.hookEvent} in ${input.workspaceName}.`,
              evidence: { sourceRef: 'shadow-eval' },
              triggers: [`when ${input.hookEvent} in ${input.workspaceName}`.slice(0, 120)],
            },
            { findSameKey: () => [] },
          )
          return { key, summary, type, verdict: verdict.decision, score: verdict.score }
        })
      const accepted = notes.filter((n) => n.verdict === 'approve').length
      // Defense in depth: the distiller echoes payload text — redact every
      // persisted string so a secret in the transcript never lands in shadow.db.
      const safe = redactDeep({
        workspaceId: input.workspaceId,
        workspaceName: input.workspaceName,
        hookEvent: input.hookEvent,
        notes,
      })
      const receipt: ShadowReceipt = {
        id: 0,
        createdAt: Date.now(),
        workspaceId: safe.workspaceId,
        hookEvent: safe.hookEvent,
        recallHits: recallRes.items.length,
        notes: safe.notes,
        accepted,
        evalKind: 'synthetic-policy-probe',
      }
      this.checkGen(gen)
      receipt.id = this.record(receipt)
      return receipt
    } finally {
      this.liveHandles.delete(handle)
      try {
        this.sessions.close(handle)
      } catch {
        // revoked/closed by invalidate mid-flight — already forgotten
      }
    }
  }

  private record(receipt: ShadowReceipt): number {
    const db = this.store()
    const row = db
      .prepare(
        `INSERT INTO runs (created_at, workspace_id, hook_event, recall_hits, notes_total, notes_accepted, receipt)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        receipt.createdAt,
        receipt.workspaceId,
        receipt.hookEvent,
        receipt.recallHits,
        receipt.notes.length,
        receipt.accepted,
        JSON.stringify(receipt),
      )
    db.prepare(
      `DELETE FROM runs WHERE id NOT IN (SELECT id FROM runs ORDER BY id DESC LIMIT ?)`,
    ).run(KEEP_NEWEST_RUNS)
    return Number(row.lastInsertRowid)
  }

  list(limit = 20): ShadowRunRow[] {
    this.gate()
    const capped = Math.min(Math.max(Math.trunc(limit), 1), 100)
    if (!existsSync(shadowDbFile(this.deps.userDataDir))) return []
    const rows = this.store()
      .prepare(
        `SELECT id, created_at, workspace_id, hook_event, recall_hits, notes_total, notes_accepted, receipt
         FROM runs ORDER BY id DESC LIMIT ?`,
      )
      .all(capped) as Array<{
      id: number
      created_at: number
      workspace_id: string
      hook_event: string
      recall_hits: number
      notes_total: number
      notes_accepted: number
      receipt: string
    }>
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      workspaceId: r.workspace_id,
      hookEvent: r.hook_event,
      recallHits: r.recall_hits,
      notesTotal: r.notes_total,
      notesAccepted: r.notes_accepted,
      receipt: JSON.parse(r.receipt) as unknown,
    }))
  }

  close(): void {
    // Irreversible: later runs fail closed even if re-enabled.
    this.closed = true
    this.invalidate()
    this.db?.close()
    this.db = null
    this.broker = null
    this.brokerOf = null
  }
}
