import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryBroker } from '../broker'
import { SessionRegistry } from '../capabilities'
import { VaultManager } from '../vaultManager'
import { pathsForDb } from '../paths'

const WS = '44444444-4444-4433-8444-444444444444'
const WS2 = '55555555-5555-4533-8555-555555555555'

// Live broker proof: real binary, real per-DB files under temp userData,
// real CLI-written entities, real fan-out + merge. Never the user's vault.
// Run: ITTOP_VAULT_LIVE_TEST=1 npx vitest run src/main/memory
const runIf = process.env.ITTOP_VAULT_LIVE_TEST === '1' ? describe : describe.skip

function cli(db: string, key: string, subcommand: string, ...args: string[]): string {
  return execFileSync('perseus-vault', [subcommand, '--db', db, '--encryption-key', key, ...args], {
    encoding: 'utf8',
  })
}

// Non-recall inspection path: digest of the recall-visible set. Stable while
// DB state is unchanged, changes iff it changes — the persisted
// before/after witness for read hygiene (recall responses alone could miss
// a first-or-last-read side effect).
function digestOf(db: string, key: string): string {
  const out = execFileSync('perseus-vault', ['--db', db, '--encryption-key', key, 'state-digest'], {
    encoding: 'utf8',
  })
  return (JSON.parse(out) as { digest: string }).digest
}

runIf('MemoryBroker live (real binary, temp userData)', () => {
  it('fans out over workspace + global DBs and merges with provenance', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'ittop-vault-broker-'))
    const manager = new VaultManager({ userDataDir, binaryPath: 'perseus-vault' })
    try {
      await manager.ensureGlobal()
      const global = pathsForDb(userDataDir, 'global')
      cli(global.dbFile, global.keyFile, 'write', '--category', 'decision', '--key', 'live-broker',
        '--body', '{"content":"live broker probe","recall_when":["live broker context"]}')
      const sessions = new SessionRegistry()
      const broker = new MemoryBroker(manager, sessions)
      const h = sessions.open(WS, {})
      // Touch the workspace DB first: the broker lazily creates it (real init).
      await broker.recall(h, { query: 'warmup nomatch xyz', limit: 1 })
      const wsPaths = pathsForDb(userDataDir, `workspace:${WS}`)
      cli(wsPaths.dbFile, wsPaths.keyFile, 'write', '--category', 'decision', '--key', 'live-ws-only',
        '--workspace-hash', WS,
        '--body', '{"content":"workspace only probe"}')
      const res = await broker.recall(h, { query: 'live broker probe', limit: 5 })
      expect(res.partial).toBe(false)
      expect(res.missing).toEqual([])
      const keys = res.items.map((m) => (m.item as { key?: string }).key)
      expect(keys).toContain('live-broker')
      const hit = res.items.find((m) => (m.item as { key?: string }).key === 'live-broker')
      expect(hit?.db).toBe('global')

      const when = await broker.recallWhen(h, 'live broker context', 5)
      expect(when.items.map((m) => (m.item as { key?: string }).key)).toContain('live-broker')

      // Pagination over the merged order is deterministic.
      const p1 = await broker.recall(h, { query: 'live broker probe' }, { maxTotal: 1 })
      expect(p1.items).toHaveLength(1)

      // Workspace isolation: a foreign session sees global hits, never ours.
      const wsRes = await broker.recall(h, { query: 'workspace only probe', limit: 5 })
      expect(wsRes.items.map((m) => (m.item as { key?: string }).key)).toContain('live-ws-only')
      expect(wsRes.items.find((m) => (m.item as { key?: string }).key === 'live-ws-only')?.db)
        .toBe(`workspace:${WS}`)
      const h2 = sessions.open(WS2, {})
      const foreign = await broker.recall(h2, { query: 'workspace only probe', limit: 5 })
      expect(foreign.items.map((m) => (m.item as { key?: string }).key)).not.toContain('live-ws-only')
      const foreignGlobal = await broker.recall(h2, { query: 'live broker probe', limit: 5 })
      expect(foreignGlobal.items.map((m) => (m.item as { key?: string }).key)).toContain('live-broker')

      // Read hygiene: every exposed read mode leaves counters/decay untouched.
      const snap = (m: { item: unknown }): string => {
        const it = m.item as {
          retrieval_count?: unknown
          last_accessed_unix_ms?: unknown
          decay_score?: unknown
          links?: unknown
        }
        return JSON.stringify([it.retrieval_count, it.last_accessed_unix_ms, it.decay_score, it.links])
      }
      const gdig = (): string => digestOf(global.dbFile, global.keyFile)
      const wdig = (): string => digestOf(wsPaths.dbFile, wsPaths.keyFile)
      expect(gdig()).not.toBe('0000000000000000') // entity present
      const reads: Array<() => Promise<unknown>> = [
        () => broker.recall(h, { query: 'live broker probe', limit: 5 }),
        () => broker.recall(h, { query: 'live broker probe', limit: 5, mode: 'dense' }),
        () => broker.recallWhen(h, 'live broker context', 5),
      ]
      const before = gdig()
      const wbefore = wdig()
      for (const read of reads) {
        await read()
        expect(gdig()).toBe(before) // persisted global state untouched
        expect(wdig()).toBe(wbefore) // persisted workspace state untouched
      }
      const first = (
        await broker.recall(h, { query: 'live broker probe', limit: 5 })
      ).items.find((m) => (m.item as { key?: string }).key === 'live-broker')
      expect(gdig()).toBe(before)
      const asCounter = (m: { item: unknown }): unknown =>
        (m.item as { retrieval_count?: unknown }).retrieval_count
      expect(asCounter(first as { item: unknown })).toBe(0) // absolute zero, not relative
      const detail = (await broker.getEntity(
        h,
        'global',
        ((first as { item: unknown }).item as { id?: string }).id as string,
      )) as { retrieval_count?: unknown }
      expect(detail).toBeDefined()
      expect(gdig()).toBe(before) // detail read inert, persisted
      const hist = (await broker.history(h, 'global', 'decision', 'live-broker')) as { total?: number }
      expect(typeof hist).toBe('object')
      expect(gdig()).toBe(before) // history read inert, persisted
      const after = await broker.recall(h, { query: 'live broker probe', limit: 5 })
      const again = after.items.find((m) => (m.item as { key?: string }).key === 'live-broker')
      expect(snap(again as { item: unknown })).toBe(snap(first as { item: unknown }))
      expect(asCounter(again as { item: unknown })).toBe(0)
      expect(gdig()).toBe(before)

      // Control experiment: reinforce:true is the (only observed) bump switch.
      // Two raw dense reinforce:true reads must flush +1 into the NEXT read —
      // proving the broker's explicit reinforce:false is the effective control.
      // (Raw manager.call: the broker itself offers no reinforced path.)
      const rawArgs = {
        query: 'live broker probe',
        limit: 5,
        mode: 'dense',
        reinforce: true,
        workspace_hash: '',
      }
      await manager.call('global', 'perseus_vault_recall', rawArgs)
      await manager.call('global', 'perseus_vault_recall', rawArgs)
      const controlled = (
        await broker.recall(h, { query: 'live broker probe', limit: 5 })
      ).items.find((m) => (m.item as { key?: string }).key === 'live-broker')
      expect(asCounter(controlled as { item: unknown })).toBeGreaterThan(0)
      await manager.stopAll()
    } finally {
      await manager.stopAll().catch(() => undefined)
      rmSync(userDataDir, { recursive: true, force: true })
    }
  }, 120000)

  it('browse creates nothing and persists nothing (all tables)', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const { readdirSync } = await import('node:fs')
    const userDataDir = mkdtempSync(join(tmpdir(), 'ittop-vault-browse-'))
    const manager = new VaultManager({ userDataDir, binaryPath: 'perseus-vault' })
    const tree = (dir: string): string[] => {
      try {
        return readdirSync(dir, { recursive: true, encoding: 'utf8' }) as string[]
      } catch {
        return []
      }
    }
    // Full persisted-state witness: EVERY table (including sqlite/FTS
    // internals — unreadable ones recorded honestly and still compared),
    // every row via quote() — fully lossless (blobs as X'..', i64 exact).
    // Catches links/telemetry/init effects a digest would miss.
    const dump = (dbFile: string): Record<string, unknown> => {
      const d = new DatabaseSync(dbFile, { readOnly: true })
      try {
        const tables = d
          .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name")
          .all() as Array<{ name: string }>
        const out: Record<string, unknown> = {}
        for (const { name } of tables) {
          const safe = name.replace(/"/g, '""')
          let rows: unknown
          try {
            const cols = d.prepare(`PRAGMA table_info("${safe}")`).all() as Array<{ name: string }>
            if (cols.length === 0) {
              // Column-less tables cannot be proven fully read: fail the gate.
              throw new Error(`table "${name}" has no columns (cannot prove full read)`)
            } else {
              const sel = cols
                .map((c) => `quote("${c.name.replace(/"/g, '""')}") AS "${c.name.replace(/"/g, '""')}"`) 
                .join(', ')
              rows = d.prepare(`SELECT ${sel} FROM "${safe}"`).all()
            }
          } catch (e) {
            // Unreadable tables FAIL the gate: silent gaps are not evidence.
            throw new Error(`table "${name}" unreadable: ${(e as Error).message}`)
          }
          out[name] = rows
        }
        return out
      } finally {
        d.close()
      }
    }
    try {
      const sessions = new SessionRegistry()
      const broker = new MemoryBroker(manager, sessions)
      const h = sessions.open(WS, {})
      // No store, no ensure, no key: browse reports missing and the vault
      // dir stays file-free (the hard no-create guarantee, not just UX).
      const missing = await broker.browse(h, { scope: [`workspace:${WS}`, 'global'] })
      expect(missing.partial).toBe(true)
      expect(missing.perDb).toHaveLength(2)
      for (const p of missing.perDb) {
        expect(p.items).toEqual([])
        expect(p.missing?.reason).toMatch(/not ready/)
      }
      expect(tree(join(userDataDir, 'vault'))).toEqual([])
      // Now with real stores: entities across categories + a global entry.
      await manager.ensureWorkspace(WS)
      await manager.ensureGlobal()
      const wsPaths = pathsForDb(userDataDir, `workspace:${WS}`)
      const global = pathsForDb(userDataDir, 'global')
      cli(wsPaths.dbFile, wsPaths.keyFile, 'write', '--category', 'decision', '--key', 'browse-a',
        '--workspace-hash', WS, '--body', '{"content":"browse alpha","recall_when":["browse"]}')
      cli(wsPaths.dbFile, wsPaths.keyFile, 'write', '--category', 'gotcha', '--key', 'browse-b',
        '--workspace-hash', WS, '--body', '{"content":"browse beta"}')
      cli(global.dbFile, global.keyFile, 'write', '--category', 'decision', '--key', 'browse-g',
        '--body', '{"content":"browse gamma"}')
      const beforeWs = dump(wsPaths.dbFile)
      const beforeGlobal = dump(global.dbFile)
      const dws = (): string => digestOf(wsPaths.dbFile, wsPaths.keyFile)
      const dg = (): string => digestOf(global.dbFile, global.keyFile)
      const digWs = dws()
      const digG = dg()
      // Broker pages (limit 1 → one item + cursor); the screenApi chains
      // internally and reports the REAL total, never a page count.
      const b1 = await broker.browse(h, { scope: [`workspace:${WS}`], limit: 1 })
      expect(b1.perDb[0].items).toHaveLength(1)
      expect(b1.perDb[0].hasMore).toBe(true)
      const bcursor = b1.perDb[0].nextCursor
      expect(typeof bcursor).toBe('string')
      const b2 = await broker.browse(h, { scope: [`workspace:${WS}`], limit: 1, cursor: bcursor as string })
      expect(b2.perDb[0].items).toHaveLength(1)
      const full = await broker.browse(h, { scope: [`workspace:${WS}`] })
      expect(full.perDb[0].items.map((m) => (m as { key?: string }).key).sort()).toEqual(['browse-a', 'browse-b'])
      const cat = await broker.browse(h, { scope: [`workspace:${WS}`], category: 'gotcha' })
      expect(cat.perDb[0].items.map((m) => (m as { key?: string }).key)).toEqual(['browse-b'])
      const g = await broker.browse(h, { scope: ['global'] })
      expect(g.perDb[0].items.map((m) => (m as { key?: string }).key)).toEqual(['browse-g'])
      // Nothing persisted anywhere: digests + every table identical.
      expect(dws()).toBe(digWs)
      expect(dg()).toBe(digG)
      expect(dump(wsPaths.dbFile)).toEqual(beforeWs)
      expect(dump(global.dbFile)).toEqual(beforeGlobal)
      await manager.stopAll()
    } finally {
      await manager.stopAll().catch(() => undefined)
      rmSync(userDataDir, { recursive: true, force: true })
    }
  }, 120000)
})
