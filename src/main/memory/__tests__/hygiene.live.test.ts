import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { MemoryBroker } from '../broker'
import { SessionRegistry } from '../capabilities'
import { VaultManager } from '../vaultManager'
import { pathsForDb } from '../paths'

const WS = '66666666-6666-4633-8666-666666666666'

// Persisted read-hygiene proof via DIRECT read-only inspection — never a
// recall path. readOnly + PRAGMA query_only makes mutation structurally
// impossible (writes throw). Snapshots cover every entity row in full
// (counters, stamps, decay, links, status) so no field can drift silently.
// Run: ITTOP_VAULT_LIVE_TEST=1 npx vitest run src/main/memory
const runIf = process.env.ITTOP_VAULT_LIVE_TEST === '1' ? describe : describe.skip

function cli(db: string, key: string, subcommand: string, ...args: string[]): string {
  return execFileSync('perseus-vault', [subcommand, '--db', db, '--encryption-key', key, ...args], {
    encoding: 'utf8',
  })
}

function serveCall(db: string, key: string, tool: string, args: Record<string, unknown>): unknown {
  const req = [
    '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"hyg","version":"0"}}}',
    '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
  ].join('\n')
  const out = execFileSync(
    'perseus-vault',
    ['serve', '--db', db, '--encryption-key', key],
    { encoding: 'utf8', input: req, timeout: 60000 },
  )
  const last = out.trim().split('\n').at(-1) as string
  return (JSON.parse(last) as { result?: unknown }).result
}

interface Fixture {
  dir: string
  db: string
  key: string
}

function freshDb(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'ittop-vault-hyg-'))
  const db = join(dir, 'h.db')
  const key = join(dir, 'h.key')
  execFileSync('perseus-vault', ['init', '--db', db, '--key-file', key], { encoding: 'utf8' })
  return { dir, db, key }
}

function writeEntity(fx: Fixture, category: string, k: string, body: string, ws = 'hygws'): void {
  const out = cli(fx.db, fx.key, 'write', '--category', category, '--key', k, '--workspace-hash', ws, '--body', body)
  if (!out.includes('"action": "created"') && !out.includes('"action":"created"')) {
    throw new Error(`write not created (likely deduped): ${out.slice(0, 200)}`)
  }
}

/** Persisted snapshots split by contract: entity rows (strictly immutable
 * under reads) vs. append-only audit telemetry (served_events and
 * recall_arm_audits grow per served recall by design — observability, not
 * usage reinforcement). */
function snapshot(fx: Fixture): { entities: string; audit: string } {
  const db = new DatabaseSync(fx.db, { readOnly: true })
  try {
    db.exec('PRAGMA query_only = ON')
    const entities = JSON.stringify(db.prepare('SELECT * FROM entities ORDER BY id').all())
    const served = JSON.stringify(db.prepare('SELECT * FROM served_events ORDER BY id').all())
    const audits = JSON.stringify(db.prepare('SELECT * FROM recall_arm_audits ORDER BY rowid').all())
    return {
      entities,
      audit: JSON.stringify({ served: JSON.parse(served), audits: JSON.parse(audits) }),
    }
  } finally {
    db.close()
  }
}

function auditUnchangedExceptAppend(before: string, after: string): boolean {
  // Baseline audit rows must still exist BYTE-IDENTICAL (by id); new rows
  // from served recalls may append. Documents exactly what is proven.
  const b = JSON.parse(before) as { served: Array<{ id: string }>; audits: Array<{ id?: string }> }
  const a = JSON.parse(after) as { served: Array<{ id: string }>; audits: Array<{ id?: string }> }
  const sameRows = (rowsB: unknown[], rowsA: unknown[]): boolean => {
    const byId = new Map<string, string>()
    for (const r of rowsA as Array<Record<string, unknown>>) {
      if (typeof r.id === 'string') byId.set(r.id, JSON.stringify(r))
    }
    return (rowsB as Array<Record<string, unknown>>).every(
      (r) => typeof r.id === 'string' && byId.get(r.id) === JSON.stringify(r),
    )
  }
  return sameRows(b.served, a.served) && sameRows(b.audits, a.audits)
}

function diffPaths(a: Array<Record<string, unknown>>, b: Array<Record<string, unknown>>): string[] {
  const changed: string[] = []
  const byId = new Map(b.map((e) => [e.id as string, e]))
  for (const ea of a) {
    const eb = byId.get(ea.id as string)
    if (!eb) {
      changed.push(`${ea.id as string}:row-missing`)
      continue
    }
    for (const k of Object.keys(ea)) {
      if (JSON.stringify(ea[k]) !== JSON.stringify(eb[k])) changed.push(`${ea.id as string}:${k}`)
    }
  }
  return changed
}

runIf('read hygiene via persisted snapshots', () => {
  it('snapshot detects usage mutation (sensitivity: retrieval_count + last_accessed)', () => {
    const fx = freshDb()
    try {
      writeEntity(fx, 'decision', 'k1', '{"content":"sens usage"}')
      const before = snapshot(fx)
      serveCall(fx.db, fx.key, 'perseus_vault_recall', {
        query: 'sens usage',
        workspace_hash: 'hygws',
        limit: 5,
        mode: 'dense',
        reinforce: true,
      })
      serveCall(fx.db, fx.key, 'perseus_vault_recall', {
        query: 'sens usage',
        workspace_hash: 'hygws',
        limit: 5,
      })
      const after = snapshot(fx)
      const changed = diffPaths(
        JSON.parse(before.entities) as Array<Record<string, unknown>>,
        JSON.parse(after.entities) as Array<Record<string, unknown>>,
      )
      // The reinforce flush moves EXACTLY the usage quadruple — and nothing else.
      expect(changed.sort()).toEqual([
        expect.stringMatching(/:decay_score$/),
        expect.stringMatching(/:last_accessed_unix_ms$/),
        expect.stringMatching(/:retrieval_count$/),
        expect.stringMatching(/:utility_score$/),
      ])
    } finally {
      rmSync(fx.dir, { recursive: true, force: true })
    }
  })

  it('snapshot detects link mutation (sensitivity: links)', () => {
    const fx = freshDb()
    try {
      writeEntity(fx, 'decision', 'k1', '{"content":"sens link alpha entirely distinct first record"}')
      writeEntity(fx, 'decision', 'k2', '{"content":"zebras quantum telescope utterly different second"}')
      const e1 = (
        JSON.parse(snapshot(fx).entities) as Array<{ id: string; key: string }>
      ).find((e) => e.key === 'k1')?.id as string
      const e2 = (
        JSON.parse(snapshot(fx).entities) as Array<{ id: string; key: string }>
      ).find((e) => e.key === 'k2')?.id as string
      const before = snapshot(fx)
      serveCall(fx.db, fx.key, 'perseus_vault_link', {
        from_category: 'decision',
        from_key: 'k1',
        relationship: 'references',
        to_id: e2,
      })
      void e1
      const after = snapshot(fx)
      const changed = diffPaths(
        JSON.parse(before.entities) as Array<Record<string, unknown>>,
        JSON.parse(after.entities) as Array<Record<string, unknown>>,
      )
      // Link creation moves links + its access stamp — and nothing else.
      expect(changed.sort()).toEqual([
        expect.stringMatching(/:last_accessed_unix_ms$/),
        expect.stringMatching(/:links$/),
      ])
    } finally {
      rmSync(fx.dir, { recursive: true, force: true })
    }
  })

  it('broker reads leave persisted entity state untouched (hygiene)', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'ittop-vault-bhyg-'))
    const managers: VaultManager[] = []
    const manager = new VaultManager({ userDataDir, binaryPath: 'perseus-vault' })
    managers.push(manager)
    try {
      await manager.ensureGlobal()
      const global = pathsForDb(userDataDir, 'global')
      const fx = { dir: userDataDir, db: global.dbFile, key: global.keyFile }
      cli(global.dbFile, global.keyFile, 'write', '--category', 'decision', '--key', 'hygiene probe', '--body', '{"content":"hygiene probe v1","recall_when":["hygiene trigger context"]}')
      cli(global.dbFile, global.keyFile, 'write', '--category', 'decision', '--key', 'hygiene probe', '--body', '{"content":"hygiene probe v2","recall_when":["hygiene trigger context"]}')
      const sessions = new SessionRegistry()
      const broker = new MemoryBroker(manager, sessions)
      const h = sessions.open(WS, {})
      const wsPaths = pathsForDb(userDataDir, `workspace:${WS}`)
      const snapOf = (): { entities: string; audits: [string, string] } => {
        const g = snapshot(fx)
        const w = snapshot({ dir: userDataDir, db: wsPaths.dbFile, key: wsPaths.keyFile })
        return { entities: g.entities + '\n//workspace//\n' + w.entities, audits: [g.audit, w.audit] }
      }
      await broker.recall(h, { query: 'warmup nomatch xyz', limit: 1 }) // lazily creates the workspace DB
      const baseline = snapOf()
      const checkUntouched = (label: string): void => {
        const now = snapOf()
        expect(now.entities, `entities after ${label}`).toBe(baseline.entities)
        expect(now.audits.length).toBe(baseline.audits.length)
        now.audits.forEach((audit, i) => {
          expect(auditUnchangedExceptAppend(baseline.audits[i], audit), `audit rows intact after ${label}`).toBe(true)
        })
      }
      const reads: Array<() => Promise<unknown>> = [
        () => broker.recall(h, { query: 'hygiene probe', limit: 5, mode: 'dense' }),
        () => broker.recall(h, { query: 'hygiene probe', limit: 5, mode: 'dense' }),
        () => broker.recallWhen(h, 'hygiene trigger context', 5),
      ]
      for (const [i, read] of reads.entries()) {
        await read()
        checkUntouched(`read#${i}`)
      }
      const whenHit = (
        await broker.recallWhen(h, 'hygiene trigger context', 5)
      ).items.find((m) => (m.item as { key?: string }).key === 'hygiene probe')
      expect(whenHit, 'recallWhen trigger hits positively').toBeDefined()
      checkUntouched('recallWhen-positive')
      const found = (
        await broker.recall(h, { query: 'hygiene probe', limit: 5 })
      ).items.find((m) => (m.item as { key?: string }).key === 'hygiene probe')
      const id = ((found as { item: unknown }).item as { id: string }).id
      await broker.getEntity(h, 'global', id)
      checkUntouched('getEntity')
      await broker.history(h, 'global', 'decision', 'hygiene probe')
      checkUntouched('history')
      const hist = (await broker.history(h, 'global', 'decision', 'hygiene probe')) as {
        total?: number
        versions?: Array<{ body_json?: string }>
      }
      expect(hist.total, 'history shows the v1 predecessor').toBeGreaterThanOrEqual(1)
      expect(
        (hist.versions ?? []).some((v) => (v.body_json ?? '').includes('hygiene probe v1')),
        'history contains v1 content',
      ).toBe(true)
      checkUntouched('history-content')
      // No absolute-zero claim here: the v1→v2 fixture update itself bumps
      // usage once (write path, expected — proven absolute-zero on fresh
      // single-write entities lives in reinforcement.live.test.ts). What
      // matters: READS move nothing from this baseline onward.
      const row = (
        JSON.parse(snapOf().entities.split('\n//workspace//\n')[0]) as Array<{ key: string; retrieval_count: number }>
      ).find((e) => e.key === 'hygiene probe')
      expect(row).toBeDefined()
      // Pending work flushed by shutdown, then a fresh server generation
      // (new manager = app restart): still identical — nothing hiding.
      await manager.stopAll()
      checkUntouched('stopAll')
      const manager2 = new VaultManager({ userDataDir, binaryPath: 'perseus-vault' })
      managers.push(manager2)
      const broker2 = new MemoryBroker(manager2, sessions)
      await manager2.ensureGlobal()
      checkUntouched('restart')
      const again = (
        await broker2.recall(h, { query: 'hygiene probe', limit: 5 })
      ).items.find((m) => (m.item as { key?: string }).key === 'hygiene probe')
      expect(again).toBeDefined()
      checkUntouched('final recall')
      await manager2.stopAll()
    } finally {
      for (const m of managers) await m.stopAll().catch(() => undefined)
      rmSync(userDataDir, { recursive: true, force: true })
    }
  }, 180000)
})
