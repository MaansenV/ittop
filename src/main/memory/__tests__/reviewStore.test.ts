import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { admit } from '../admission'
import { ReviewStore, reviewStoreFile } from '../reviewStore'
import type { AdmissionCandidate, AdmissionVerdict } from '../admission'
import type { StoredCandidate } from '../reviewStore'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ittop-review-'))
  dirs.push(dir)
  return join(dir, 'review.db')
}

function candidate(over: Partial<AdmissionCandidate> = {}): AdmissionCandidate {
  return {
    db: 'workspace:w',
    category: 'decision',
    key: 'k1',
    content: 'Use RecastGraph.',
    futureUse: 'Pathfinding topology reference.',
    evidence: { sourceRef: 'test' },
    triggers: ['astar work'],
    ...over,
  }
}

const verdict = { decision: 'review' as const, score: 0.8, reasons: ['test'] }
function recheckApprove(): { decision: 'approve'; score: number; reasons: string[] } {
  return { decision: 'approve', score: 1, reasons: [] }
}

describe('ReviewStore', () => {
  it('queues, decides and reports counts', () => {
    const store = new ReviewStore({ file: tempFile() })
    try {
      const id = store.submit(
        candidate({ status: 'done', implementedMeta: { testProof: 't', commit: 'c' } }),
        verdict,
      )
      const stored = store.get(id)
      expect(stored?.statusState).toBe('queued')
      expect(stored?.status).toBe('done')
      expect(stored?.implementedMeta).toEqual({ testProof: 't', commit: 'c' })
      expect(stored?.policyVersion).toBe(1)
      expect(stored?.revision).toBe(1)
      expect(stored?.triggers).toEqual(['astar work'])
      store.decide(id, 'approved', { expectedRevision: 1, recheck: recheckApprove })
      expect(store.get(id)?.statusState).toBe('approved')
      expect(() => store.decide(id, 'rejected', { expectedRevision: 1 })).toThrow(/not decidable/)
      expect(store.countByStatus()).toEqual({ approved: 1 })
    } finally {
      store.close()
    }
  })

  it('refuses approval without re-check and on revision drift', () => {
    const store = new ReviewStore({ file: tempFile() })
    try {
      const id = store.submit(candidate(), verdict)
      expect(() =>
        store.decide(id, 'approved', { expectedRevision: 1 }),
      ).toThrow(/requires a policy re-check/)
      expect(() =>
        store.decide(id, 'approved', { expectedRevision: 2, recheck: recheckApprove }),
      ).toThrow(/underfoot/)
      expect(() =>
        store.decide(id, 'approved', {
          expectedRevision: 1,
          recheck: () => ({ decision: 'reject', score: 0, reasons: ['stale contradiction'] }),
        }),
      ).toThrow(/blocked by re-check/)
      expect(store.get(id)?.statusState).toBe('queued') // still queued, nothing lost
    } finally {
      store.close()
    }
  })

  it('enforces real policy on approve: unconfirmed global stays blocked with override', () => {
    const store = new ReviewStore({ file: tempFile() })
    try {
      const cand = candidate({
        db: 'global',
        category: 'preference',
        key: 'theme',
        content: 'User prefers dark UI.',
        triggers: ['choosing a UI theme'],
      })
      const v = admit(cand, { findSameKey: () => [] })
      expect(v.decision).toBe('review') // unconfirmed
      const id = store.submit(cand, v)
      const recheck = (stored: StoredCandidate): AdmissionVerdict =>
        admit(
          {
            db: stored.db,
            category: stored.category,
            key: stored.key,
            content: stored.content,
            futureUse: stored.futureUse,
            evidence: stored.evidence,
            triggers: stored.triggers,
            status: stored.status,
            implementedMeta: stored.implementedMeta,
          },
          { findSameKey: () => [] },
        )
      expect(() =>
        store.decide(id, 'approved', {
          expectedRevision: 1,
          recheck,
          override: { by: 'user', reason: 'looks fine' },
        }),
      ).toThrow(/non-overridable/)
      expect(store.get(id)?.statusState).toBe('queued')
    } finally {
      store.close()
    }
  })

  it('allows human override of review verdicts, never of rejects', () => {
    const store = new ReviewStore({ file: tempFile() })
    try {
      const id = store.submit(candidate(), verdict)
      expect(() =>
        store.decide(id, 'approved', {
          expectedRevision: 1,
          recheck: () => ({ decision: 'review', score: 0.8, reasons: ['needs eyes'] }),
        }),
      ).toThrow(/explicit human override/)
      store.decide(id, 'approved', {
        expectedRevision: 1,
        recheck: () => ({ decision: 'review', score: 0.8, reasons: ['needs eyes'] }),
        override: { by: 'user', reason: 'verified in editor' },
      })
      const done = store.get(id)
      expect(done?.statusState).toBe('approved')
      expect(done?.decisionMeta.override).toEqual({ by: 'user', reason: 'verified in editor' })
      const id2 = store.submit(candidate({ key: 'k2' }), verdict)
      expect(() =>
        store.decide(id2, 'approved', {
          expectedRevision: 1,
          recheck: () => ({ decision: 'reject', score: 0, reasons: ['structural'] }),
          override: { by: 'user', reason: 'try anyway' },
        }),
      ).toThrow(/blocked by re-check/)
      expect(store.get(id2)?.statusState).toBe('queued')
    } finally {
      store.close()
    }
  })

  it('round-trips every field across close and reopen', () => {
    const file = tempFile()
    const full = candidate({
      status: 'done',
      implementedMeta: { testProof: 'e2e green', commit: 'abc', files: ['a.ts'] },
    })
    const verdictFull = {
      decision: 'review' as const,
      score: 0.8,
      reasons: ['r1', 'r2'],
    }
    let id = 0
    const s1 = new ReviewStore({ file })
    try {
      id = s1.submit(full, verdictFull)
      s1.decide(id, 'approved', { expectedRevision: 1, recheck: recheckApprove })
    } finally {
      s1.close()
    }
    const s2 = new ReviewStore({ file })
    try {
      const back = s2.get(id)
      expect(back?.db).toBe(full.db)
      expect(back?.category).toBe(full.category)
      expect(back?.key).toBe(full.key)
      expect(back?.content).toBe(full.content)
      expect(back?.futureUse).toBe(full.futureUse)
      expect(back?.evidence).toEqual(full.evidence)
      expect(back?.triggers).toEqual(full.triggers)
      expect(back?.status).toBe('done')
      expect(back?.implementedMeta).toEqual(full.implementedMeta)
      expect(back?.policyVersion).toBe(1)
      expect(back?.revision).toBe(1)
      expect(back?.statusState).toBe('approved')
      expect(back?.verdict).toEqual(verdictFull)
      expect(back?.decidedAt).not.toBeNull()
    } finally {
      s2.close()
    }
  })

  it('expires overflow visibly instead of losing silently', () => {
    const store = new ReviewStore({ file: tempFile(), maxQueued: 2 })
    try {
      store.submit(candidate({ key: 'a' }), verdict)
      store.submit(candidate({ key: 'b' }), verdict)
      store.submit(candidate({ key: 'c' }), verdict)
      expect(store.expiredOnWrite).toBe(1)
      const queued = store.queued()
      expect(queued.map((r) => r.key)).toEqual(['b', 'c']) // oldest expired
      expect(store.countByStatus().expired).toBe(1)
    } finally {
      store.close()
    }
  })

  it('expires stale rows by TTL without deleting', () => {
    const store = new ReviewStore({ file: tempFile(), queueTtlMs: 1000 })
    try {
      const id = store.submit(candidate(), verdict)
      expect(store.queued(Date.now() + 2000)).toHaveLength(0)
      expect(store.get(id)?.statusState).toBe('expired')
    } finally {
      store.close()
    }
  })

  it('purges decided history durably and caps total size transactionally', () => {
    const store = new ReviewStore({ file: tempFile(), purgeAfterMs: 1000 })
    try {
      const id = store.submit(candidate(), verdict)
      store.decide(id, 'rejected', { expectedRevision: 1, now: 1000 })
      expect(store.purgeExpired(1000 + 1001)).toBe(1)
      expect(store.get(id)).toBeNull()
      expect(store.purgedTotal).toBe(1)
    } finally {
      store.close()
    }
    const tiny = new ReviewStore({ file: tempFile(), maxBytes: 1 })
    try {
      expect(() => tiny.submit(candidate(), verdict)).toThrow(/size cap/)
      expect(tiny.countByStatus()).toEqual({})
    } finally {
      tiny.close()
    }
  })

  it('retains only the newest promotions without manual purge', () => {
    const store = new ReviewStore({ file: tempFile(), promotionKeepNewest: 2 })
    try {
      const op = (n: number): void =>
        store.recordPromotion({
          operationId: `op-${n}`,
          fromDb: 'workspace:w',
          toDb: 'global',
          category: 'gotcha',
          key: `k${n}`,
          snapshot: `{"n":${n}}`,
        })
      op(1)
      op(2)
      op(3) // third write auto-trims the oldest: no manual purge involved
      expect(store.getPromotion('op-1')).toBeNull()
      expect(store.getPromotion('op-2')?.status).toBe('recorded')
      expect(store.getPromotion('op-3')?.status).toBe('recorded')
    } finally {
      store.close()
    }
  })

  it('ledger always equals the independent SQL byte sum, incl. Unicode', () => {
    const file = tempFile()
    const store = new ReviewStore({ file })
    const checkLedger = (): void => {
      // Fully independent: per-column UTF-8 byte sums, never payload_bytes.
      const db = new DatabaseSync(file, { readOnly: true })
      try {
        const c = db
          .prepare(
            `SELECT COALESCE(SUM(
               LENGTH(CAST(db AS BLOB)) + LENGTH(CAST(category AS BLOB)) + LENGTH(CAST(key AS BLOB)) +
               LENGTH(CAST(content AS BLOB)) + LENGTH(CAST(future_use AS BLOB)) + LENGTH(CAST(evidence AS BLOB)) +
               LENGTH(CAST(triggers AS BLOB)) + LENGTH(CAST(candidate_status AS BLOB)) +
               LENGTH(CAST(implemented_meta AS BLOB)) + LENGTH(CAST(verdict AS BLOB)) +
               LENGTH(CAST(decision_meta AS BLOB))
             ), 0) AS n FROM candidates`,
          )
          .get() as { n: number }
        const p = db
          .prepare(
            `SELECT COALESCE(SUM(
               LENGTH(CAST(operation_id AS BLOB)) + LENGTH(CAST(from_db AS BLOB)) + LENGTH(CAST(to_db AS BLOB)) +
               LENGTH(CAST(category AS BLOB)) + LENGTH(CAST(key AS BLOB)) + LENGTH(CAST(snapshot AS BLOB))
             ), 0) AS n FROM promotions`,
          )
          .get() as { n: number }
        expect(store.payloadBytesTotal()).toBe(c.n + p.n)
      } finally {
        db.close()
      }
    }
    try {
      // Multibyte content: must count UTF-8 bytes, not characters.
      const id = store.submit(
        candidate({ key: 'uni', content: 'Grüße ✅ Universität naïve façade', triggers: ['t-üñï'] }),
        verdict,
      )
      checkLedger()
      store.decide(id, 'approved', { expectedRevision: 1, recheck: recheckApprove })
      checkLedger()
      store.recordPromotion({
        operationId: 'op-u',
        fromDb: 'workspace:w',
        toDb: 'global',
        category: 'gotcha',
        key: 'ku',
        snapshot: '{"emoji":"✅✅"}',
      })
      checkLedger()
      // Independent spot check: byte length via SQL CAST-to-BLOB for one row.
      const db = new DatabaseSync(file, { readOnly: true })
      try {
        const row = db.prepare(`SELECT LENGTH(CAST(content AS BLOB)) AS n FROM candidates WHERE id = ?`).get(id) as {
          n: number
        }
        expect(row.n).toBe(Buffer.byteLength('Grüße ✅ Universität naïve façade', 'utf8'))
      } finally {
        db.close()
      }
    } finally {
      store.close()
    }
  })

  it('migrates a stale ledger from the old schema version', () => {
    const file = tempFile()
    // Old-schema fixture: no payload_bytes columns, WRONG ledger value.
    const raw = new DatabaseSync(file)
    try {
      raw.exec(`CREATE TABLE candidates (
        id INTEGER PRIMARY KEY AUTOINCREMENT, db TEXT NOT NULL, category TEXT NOT NULL,
        key TEXT NOT NULL, content TEXT NOT NULL, future_use TEXT NOT NULL,
        evidence TEXT NOT NULL, triggers TEXT NOT NULL, candidate_status TEXT NOT NULL DEFAULT '',
        implemented_meta TEXT NOT NULL DEFAULT '', policy_version INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'queued',
        verdict TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, decided_at INTEGER)`)
      raw.exec(`CREATE TABLE promotions (
        operation_id TEXT PRIMARY KEY, from_db TEXT NOT NULL, to_db TEXT NOT NULL,
        category TEXT NOT NULL, key TEXT NOT NULL, snapshot TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'recorded', created_at INTEGER NOT NULL)`)
      raw.exec(`CREATE TABLE capacity (key TEXT PRIMARY KEY, value INTEGER NOT NULL)`)
      raw.prepare(`INSERT INTO candidates
        (db, category, key, content, future_use, evidence, triggers, status, verdict, created_at, decided_at, policy_version, revision)
        VALUES ('w','decision','old','Grüße ✅','use','{}','[]','approved','{}',1000,1001,1,1)`).run()
      raw.prepare(`INSERT INTO capacity (key, value) VALUES ('payload_bytes', 1)`).run()
    } finally {
      raw.close()
    }
    const store = new ReviewStore({ file })
    try {
      // Ledger recomputed from stored strings (not the stale value 1).
      const db = new DatabaseSync(file, { readOnly: true })
      try {
        const row = db.prepare(`SELECT COALESCE(SUM(payload_bytes), 0) AS n FROM candidates`).get() as { n: number }
        // Independent expectation: 1+8+3+11+3+2+2+0+0+2+2 (multibyte content in bytes).
        const expected =
          Buffer.byteLength('wdecisionold', 'utf8') +
          Buffer.byteLength('Grüße ✅', 'utf8') +
          Buffer.byteLength('use{}[]', 'utf8') +
          Buffer.byteLength('{}{}', 'utf8')
        expect(row.n).toBe(expected)
        expect(store.payloadBytesTotal()).toBe(row.n)
      } finally {
        db.close()
      }
      expect(store.get(1)?.statusState).toBe('approved') // old rows untouched otherwise
    } finally {
      store.close()
    }
  })

  it('rejects over-limit inserts on a filled store with full rollback', () => {
    const file = tempFile()
    const s1 = new ReviewStore({ file })
    try {
      s1.submit(candidate({ key: 'a', content: 'x'.repeat(100) }), verdict)
      s1.submit(candidate({ key: 'b', content: 'y'.repeat(100) }), verdict)
    } finally {
      s1.close()
    }
    // Reopen the SAME file with a cap just above current usage: the next
    // insert overflows → throws, stores nothing, ledger untouched.
    const probe = new ReviewStore({ file })
    let used = 0
    try {
      used = probe.payloadBytesTotal()
      expect(used).toBeGreaterThan(0)
    } finally {
      probe.close()
    }
    const tight = new ReviewStore({ file, maxBytes: used + 10 })
    try {
      expect(() => tight.submit(candidate({ key: 'c', content: 'z'.repeat(100) }), verdict)).toThrow(/size cap/)
      expect(tight.countByStatus()).toEqual({ queued: 2 })
      expect(tight.payloadBytesTotal()).toBe(used)
    } finally {
      tight.close()
    }
    const reopened = new ReviewStore({ file })
    try {
      expect(reopened.countByStatus()).toEqual({ queued: 2 })
      expect(reopened.payloadBytesTotal()).toBe(used)
    } finally {
      reopened.close()
    }
  })

  it('rolls back over-limit inserts: nothing stored, file stays consistent', () => {
    const file = tempFile()
    const tiny = new ReviewStore({ file, maxBytes: 1 })
    try {
      expect(() => tiny.submit(candidate(), verdict)).toThrow(/size cap/)
    } finally {
      tiny.close()
    }
    const reopened = new ReviewStore({ file, maxBytes: 100 * 1024 * 1024 })
    try {
      expect(reopened.countByStatus()).toEqual({})
      const id = reopened.submit(candidate(), verdict)
      expect(reopened.get(id)?.statusState).toBe('queued')
    } finally {
      reopened.close()
    }
  })

  it('records promotions with recoverable operation ids', () => {
    const store = new ReviewStore({ file: tempFile() })
    try {
      store.recordPromotion({
        operationId: 'op-1',
        fromDb: 'workspace:w',
        toDb: 'global',
        category: 'gotcha',
        key: 'bom-json',
        snapshot: '{"content":"no BOM in JSON","project":"ittop"}',
      })
      const op = store.getPromotion('op-1')
      expect(op?.status).toBe('recorded')
      expect(store.getPromotion('missing')).toBeNull()
    } finally {
      store.close()
    }
  })

  it('refuses promotions carrying secrets', () => {
    const store = new ReviewStore({ file: tempFile() })
    try {
      expect(() =>
        store.recordPromotion({
          operationId: 'op-x',
          fromDb: 'workspace:w',
          toDb: 'global',
          category: 'gotcha',
          key: 'k',
          snapshot: '{"token": "abc123456789"}',
        }),
      ).toThrow(/secrets detected/)
      expect(store.getPromotion('op-x')).toBeNull()
    } finally {
      store.close()
    }
  })

  it('redacts secrets in every persisted field, including multi-hits and partial key blocks', () => {
    const store = new ReviewStore({ file: tempFile() })
    const privA = '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKc=\nMIIBOgIBAAJBAKd='
    const privB = '\n-----END RSA PRIVATE KEY-----'
    try {
      const id = store.submit(
        candidate({
          content: `first AKIAIOSFODNN7EXAMPLE then AKIAIOSFODNN7EXAMPLE again ${privA}${privB}`,
          futureUse: 'token: abcdefgh12345678 in future',
          key: 'k-secret',
          evidence: { sourceRef: 'note with password: hunter2', files: ['AKIAIOSFODNN7EXAMPLE leaked here'] },
          triggers: ['bearer abcdefghijklmnop', 'plain trigger'],
          implementedMeta: { testProof: `uses ${privA} without end` },
        }),
        { decision: 'reject', score: 0, reasons: ['secret in trigger: bearer abcdefghijklmnop'] },
      )
      const raw = store.get(id)
      const dump = JSON.stringify(raw)
      expect(dump).not.toContain('AKIAIOSFODNN7EXAMPLE')
      expect(dump).not.toContain('MIIBOgIBAAJBAKc')
      expect(dump).not.toContain('hunter2')
      expect(dump).not.toContain('abcdefgh12345678')
      expect(dump).not.toContain('abcdefghijklmnop')
      expect(dump).toContain('plain trigger') // non-secret content survives
      // Verdict reasons redacted too.
      expect(JSON.stringify(raw?.verdict)).not.toContain('abcdefghijklmnop')
    } finally {
      store.close()
    }
  })

  it('stores redacted copies when secrets slipped through admission', () => {
    const store = new ReviewStore({ file: tempFile() })
    try {
      const id = store.submit(
        candidate({ content: 'Set api-key: hunter2hunter2', triggers: ['token: abcdefgh12345678'] }),
        verdict,
      )
      const raw = store.get(id)
      expect(raw?.content).not.toContain('hunter2')
      expect(raw?.triggers.join(' ')).not.toContain('abcdefgh')
    } finally {
      store.close()
    }
  })

  it('lives outside the vault: own SQLite file with only queue tables', () => {
    const file = tempFile()
    const store = new ReviewStore({ file })
    try {
      store.submit(candidate(), verdict)
      const db = new DatabaseSync(file, { readOnly: true })
      try {
        const tables = (
          db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as Array<{ name: string }>
        ).map((r) => r.name)
        expect(tables.filter((t) => !t.startsWith('sqlite_'))).toEqual([
          'candidates',
          'capacity',
          'promotions',
          'schema_meta',
        ])
      } finally {
        db.close()
      }
      expect(reviewStoreFile('UD')).toContain('review.db')
    } finally {
      store.close()
    }
  })

  it('admission verdicts flow end to end: admit → submit → decide', () => {
    const store = new ReviewStore({ file: tempFile() })
    try {
      const cand = candidate({ key: 'flow' })
      const v = admit(cand, { findSameKey: () => [] })
      expect(['approve', 'review']).toContain(v.decision)
      const id = store.submit(cand, v)
      store.decide(id, 'rejected', { expectedRevision: 1 })
      expect(store.get(id)?.statusState).toBe('rejected')
    } finally {
      store.close()
    }
  })
  it('version gate: complete columns + stale ledger still recompute, version persists', () => {
    const file = tempFile()
    // Build a schema-current DB through the store itself (never drifts).
    const seed = new ReviewStore({ file })
    seed.submit(candidate({ key: 'vg' }), verdict)
    const before = seed.payloadBytesTotal()
    seed.close()
    // Corrupt: wipe per-row bytes + ledger, delete the version marker.
    // All columns stay present — only the missing version triggers rebuild.
    const raw = new DatabaseSync(file)
    try {
      raw.exec(`UPDATE candidates SET payload_bytes = 0`)
      raw.exec(`UPDATE capacity SET value = 999999 WHERE key = 'payload_bytes'`)
      raw.exec(`DELETE FROM schema_meta WHERE key = 'schema_version'`)
    } finally {
      raw.close()
    }
    const store = new ReviewStore({ file })
    let after = 0
    try {
      after = store.payloadBytesTotal()
      expect(after).toBe(before)
      const meta = new DatabaseSync(file, { readOnly: true })
      try {
        const v = meta.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as { value: number }
        expect(v.value).toBe(2)
      } finally {
        meta.close()
      }
    } finally {
      store.close()
    }
    // Reopen: version gate holds, ledger stable (idempotent migration).
    const again = new ReviewStore({ file })
    try {
      expect(again.payloadBytesTotal()).toBe(after)
    } finally {
      again.close()
    }
  })

  it('aborted migration rolls back fully and retries cleanly', () => {
    const file = tempFile()
    const seed = new ReviewStore({ file })
    seed.submit(candidate({ key: 'abort' }), verdict)
    const before = seed.payloadBytesTotal()
    seed.close()
    // Setup: old version, missing column, wrong ledger, abort trigger on bump.
    const raw = new DatabaseSync(file)
    try {
      raw.exec(`UPDATE candidates SET payload_bytes = 0`)
      raw.exec(`UPDATE capacity SET value = 999999 WHERE key = 'payload_bytes'`)
      raw.exec(`UPDATE schema_meta SET value = 1 WHERE key = 'schema_version'`)
      raw.exec(`ALTER TABLE candidates DROP COLUMN payload_bytes`)
      raw.exec(`CREATE TRIGGER abort_bump BEFORE UPDATE ON schema_meta
                WHEN NEW.key = 'schema_version'
                BEGIN SELECT RAISE(ABORT, 'forced migration abort'); END`)
    } finally {
      raw.close()
    }
    // Abort AFTER alter + backfill: constructor throws the forced error.
    expect(() => new ReviewStore({ file })).toThrow(/forced migration abort/)
    // State untouched: old version, wrong ledger, column still missing, row intact.
    const check = new DatabaseSync(file, { readOnly: true })
    try {
      const v = check.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as { value: number }
      expect(v.value).toBe(1)
      const cap = check.prepare(`SELECT value FROM capacity WHERE key = 'payload_bytes'`).get() as { value: number }
      expect(cap.value).toBe(999999)
      const cols = check.prepare(`SELECT name FROM pragma_table_info('candidates')`).all() as Array<{ name: string }>
      expect(cols.map((c) => c.name)).not.toContain('payload_bytes')
      const row = check.prepare(`SELECT key, content FROM candidates`).get() as { key: string }
      expect(row.key).toBe('abort')
    } finally {
      check.close()
    }
    // Remove the trigger: retry succeeds with exact bytes.
    const fix = new DatabaseSync(file)
    try {
      fix.exec(`DROP TRIGGER abort_bump`)
    } finally {
      fix.close()
    }
    const store = new ReviewStore({ file })
    try {
      expect(store.payloadBytesTotal()).toBe(before)
      const meta = new DatabaseSync(file, { readOnly: true })
      try {
        const mv = meta.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as { value: number }
        expect(mv.value).toBe(2)
        const sum = meta
          .prepare(
            `SELECT COALESCE(SUM(
               LENGTH(CAST(db AS BLOB)) + LENGTH(CAST(category AS BLOB)) + LENGTH(CAST(key AS BLOB)) +
               LENGTH(CAST(content AS BLOB)) + LENGTH(CAST(future_use AS BLOB)) + LENGTH(CAST(evidence AS BLOB)) +
               LENGTH(CAST(triggers AS BLOB)) + LENGTH(CAST(candidate_status AS BLOB)) +
               LENGTH(CAST(implemented_meta AS BLOB)) + LENGTH(CAST(verdict AS BLOB)) +
               LENGTH(CAST(decision_meta AS BLOB))
             ), 0) AS n FROM candidates`,
          )
          .get() as { n: number }
        expect(store.payloadBytesTotal()).toBe(sum.n)
      } finally {
        meta.close()
      }
    } finally {
      store.close()
    }
  })

  it('failed init never leaks a locked handle', () => {
    const file = tempFile()
    writeFileSync(file, 'not a database at all')
    // Concrete SQLite message (not a bare toThrow): proves the failure is
    // the corrupt file, and the retry proves no handle was leaked.
    expect(() => new ReviewStore({ file })).toThrow(/not a database/i)
    // Second open throws the same way, not SQLITE_BUSY: no leaked handle.
    expect(() => new ReviewStore({ file })).toThrow(/not a database/i)
  })

  it('promotion TTL fires on the next write, independent of the count cap', () => {
    const file = tempFile()
    const store = new ReviewStore({ file, promotionKeepNewest: 1000, promotionTtlMs: 40 })
    const op = (n: number): void =>
      store.recordPromotion({
        operationId: `ttl-op-${n}`,
        fromDb: 'workspace:w',
        toDb: 'global',
        category: 'gotcha',
        key: `k${n}`,
        snapshot: `{"n":${n}}`,
      })
    try {
      op(1)
      expect(store.getPromotion('ttl-op-1')?.status).toBe('recorded')
      const start = Date.now()
      while (Date.now() - start < 80) {
        // busy-wait past the TTL: deterministic without timers
      }
      op(2) // this write alone expires ttl-op-1: no count pressure, no manual purge
      expect(store.getPromotion('ttl-op-1')).toBeNull()
      expect(store.getPromotion('ttl-op-2')?.status).toBe('recorded')
      const db = new DatabaseSync(file, { readOnly: true })
      try {
        const p = db
          .prepare(
            `SELECT COALESCE(SUM(
               LENGTH(CAST(operation_id AS BLOB)) + LENGTH(CAST(from_db AS BLOB)) + LENGTH(CAST(to_db AS BLOB)) +
               LENGTH(CAST(category AS BLOB)) + LENGTH(CAST(key AS BLOB)) + LENGTH(CAST(snapshot AS BLOB))
             ), 0) AS n FROM promotions`,
          )
          .get() as { n: number }
        const c = db
          .prepare(`SELECT COALESCE(SUM(payload_bytes), 0) AS n FROM candidates`)
          .get() as { n: number }
        expect(store.payloadBytesTotal()).toBe(c.n + p.n)
      } finally {
        db.close()
      }
    } finally {
      store.close()
    }
  })
})
