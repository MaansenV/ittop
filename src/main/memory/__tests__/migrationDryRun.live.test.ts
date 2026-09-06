import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MemoryBroker } from '../broker'
import { SessionRegistry } from '../capabilities'
import { VaultManager } from '../vaultManager'
import { pathsForDb } from '../paths'

// Faithful 6a dry-run as a permanent live test (binary 2.23.2): the exact
// 6b transport on temp DBs — two workspace DBs in ittop layout, complete
// payload (category/key/body/entity-type/workspace-hash-UUID/trigger
// phrases in content), manifest-driven replay with crash adoption, broker
// recall with home/foreign scope, recall_when trigger proof, full-field
// payload compare. Bodies are SYNTHETIC (mechanics proof; real-content
// admit mapping lives in docs/memory/phase6-mapping.md).
// Run: ITTOP_VAULT_LIVE_TEST=1 npx vitest run src/main/memory
const runIf = process.env.ITTOP_VAULT_LIVE_TEST === '1' ? describe : describe.skip

const WS_KINE = '33333333-3333-4333-8333-333333333333'
const WS_ITT = '44444444-4444-4344-8444-444444444444'

interface PlanEntry {
  db: 'kine' | 'ittop'
  uuid: string
  category: string
  key: string
  triggers: string[]
}

const PLAN: PlanEntry[] = [
  { db: 'kine', uuid: WS_KINE, category: 'decision', key: 'astar-doorways-no-links', triggers: ['connecting recast graph through door openings'] },
  { db: 'kine', uuid: WS_KINE, category: 'decision', key: 'astar-recast-support', triggers: ['setting up AstarPath with RecastGraph'] },
  { db: 'kine', uuid: WS_KINE, category: 'decision', key: 'crawler-navigation-removed', triggers: ['removing CrawlerNavigation subsystem'] },
  { db: 'kine', uuid: WS_KINE, category: 'decision', key: 'door-navmesh-carver', triggers: ['implementing DoorNavmeshCarver blocking logic'] },
  { db: 'kine', uuid: WS_KINE, category: 'decision', key: 'doorastarsetup-baked-cut', triggers: ['baking NavmeshCut into door prefab'] },
  { db: 'kine', uuid: WS_KINE, category: 'decision', key: 'net-stack', triggers: ['choosing PurrNet coop networking setup'] },
  { db: 'kine', uuid: WS_KINE, category: 'decision', key: 'purrnet-door-leaf-complete', triggers: ['decoupling door leaf animation from PurrNet'] },
  { db: 'ittop', uuid: WS_ITT, category: 'gotcha', key: 'advisor-v2-latch-loop', triggers: ['debugging advisor-v2 latch loop'] },
  { db: 'ittop', uuid: WS_ITT, category: 'gotcha', key: 'powershell-utf8-bom-json', triggers: ['PowerShell UTF8 BOM breaks JSON.parse'] },
  { db: 'ittop', uuid: WS_ITT, category: 'gotcha', key: 'xterm-fit-padding', triggers: ['xterm fit addon measures grid wrong'] },
  { db: 'ittop', uuid: WS_ITT, category: 'procedure', key: 'release-workflow', triggers: ['releasing new ittop version workflow'] },
]

const bodyFor = (e: PlanEntry): string =>
  JSON.stringify({
    content: `6a dry-run body for ${e.key}.`,
    // Declared recall_when triggers (proven mechanism on temp): natural
    // phrases, matched fuzzily by recall_when. Mirrors the 6b transport.
    recall_when: e.triggers,
  })
const hashOf = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16)

function cli(...args: string[]): string {
  return execFileSync('perseus-vault', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] })
}

runIf('migration dry-run (faithful)', () => {
  it('replays with crash adoption, scope isolation, triggers and full payload', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'ittop-dryrun-'))
    const manager = new VaultManager({ userDataDir, binaryPath: 'perseus-vault' })
    try {
      await manager.ensureWorkspace(WS_KINE)
      await manager.ensureWorkspace(WS_ITT)
      const keyFile = (ws: string): string => pathsForDb(userDataDir, `workspace:${ws}`).keyFile
      const dbFile = (ws: string): string => pathsForDb(userDataDir, `workspace:${ws}`).dbFile
      const manifestFile = join(userDataDir, 'manifest.json')
      writeFileSync(manifestFile, '{}')
      const manifest = JSON.parse('{}') as Record<string, { hash: string; status: string }>

      const sessions = new SessionRegistry()
      const broker = new MemoryBroker(manager, sessions)
      const findEntity = async (handle: string, db: string, key: string): Promise<{ id: string } | null> => {
        const res = await broker.recall(handle, { query: key, limit: 5, mode: 'dense' })
        const hit = res.items.find((m) => (m.item as { key?: string }).key === key && m.db === db)
        return hit ? { id: (hit.item as { id: string }).id } : null
      }

      // Phase 1: replay with a crash injected between write #2 and its manifest.
      let writes = 0
      const CRASH_AFTER = 2
      let crashed = false
      const hk = sessions.open(WS_KINE)
      const hi = sessions.open(WS_ITT)
      const handles: Record<string, string> = { kine: hk, ittop: hi }
      try {
        for (const e of PLAN) {
          const want = bodyFor(e)
          const wantHash = hashOf(want)
          const done = manifest[e.key]
          if (done?.status === 'done' && done.hash === wantHash) continue
          // Verify-reconcile: adopt identical content without rewriting.
          const h = handles[e.db]
          const found = await findEntity(h, `workspace:${e.uuid}`, e.key)
          let adopted = false
          if (found) {
            const ent = (await broker.getEntity(h, `workspace:${e.uuid}`, found.id)) as { body_json?: unknown }
            const raw = typeof ent.body_json === 'string' ? ent.body_json : JSON.stringify(ent.body_json ?? '')
            // Full-body hash compare (content + recall_when): byte-exact adopt.
            if (hashOf(raw) === wantHash) adopted = true
          }
          if (!adopted) {
            cli(
              'write', '--db', dbFile(e.uuid), '--encryption-key', keyFile(e.uuid),
              '--category', e.category, '--key', e.key, '--body', want,
              '--entity-type', 'insight', '--workspace-hash', e.uuid,
            )
            writes += 1
            if (!crashed && writes >= CRASH_AFTER) {
              crashed = true
              break // simulated crash: manifest for this entry never recorded
            }
          }
          manifest[e.key] = { hash: wantHash, status: 'done' }
          writeFileSync(manifestFile, JSON.stringify(manifest))
        }
      } finally {
        sessions.close(hk)
        sessions.close(hi)
      }
      expect(crashed).toBe(true)

      // Phase 2: resume to completion (adopts the crash victim, no rewrite).
      const rk = sessions.open(WS_KINE)
      const ri = sessions.open(WS_ITT)
      const rhandles: Record<string, string> = { kine: rk, ittop: ri }
      try {
        for (const e of PLAN) {
          const want = bodyFor(e)
          const wantHash = hashOf(want)
          const done = manifest[e.key]
          if (done?.status === 'done' && done.hash === wantHash) continue
          const h = rhandles[e.db]
          const found = await findEntity(h, `workspace:${e.uuid}`, e.key)
          let adopted = false
          if (found) {
            const ent = (await broker.getEntity(h, `workspace:${e.uuid}`, found.id)) as { body_json?: unknown }
            const raw = typeof ent.body_json === 'string' ? ent.body_json : JSON.stringify(ent.body_json ?? '')
            // Full-body hash compare (content + recall_when): byte-exact adopt.
            if (hashOf(raw) === wantHash) adopted = true
          }
          if (!adopted) {
            cli(
              'write', '--db', dbFile(e.uuid), '--encryption-key', keyFile(e.uuid),
              '--category', e.category, '--key', e.key, '--body', want,
              '--entity-type', 'insight', '--workspace-hash', e.uuid,
            )
          }
          manifest[e.key] = { hash: wantHash, status: 'done' }
          writeFileSync(manifestFile, JSON.stringify(manifest))
        }

        // Full payload compare per entry (all fields, not just content).
        // workspace_hash comes from SQL: get_entity does not return it.
        for (const e of PLAN) {
          const h = rhandles[e.db]
          const found = await findEntity(h, `workspace:${e.uuid}`, e.key)
          expect(found).not.toBeNull()
          const ent = (await broker.getEntity(h, `workspace:${e.uuid}`, found!.id)) as Record<string, unknown>
          expect(ent.category).toBe(e.category)
          expect(ent.key).toBe(e.key)
          expect(ent.entity_type).toBe('insight')
          const raw = typeof ent.body_json === 'string' ? ent.body_json : JSON.stringify(ent.body_json ?? '')
          expect(hashOf(raw)).toBe(hashOf(bodyFor(e)))
        }
        for (const ws of [WS_KINE, WS_ITT] as const) {
          const d = new DatabaseSync(dbFile(ws), { readOnly: true })
          try {
            d.exec('PRAGMA query_only = ON')
            const rows = d.prepare('SELECT key, workspace_hash AS wh FROM entities').all() as Array<{
              key: string
              wh: string
            }>
            for (const r of rows) expect(r.wh).toBe(ws)
          } finally {
            d.close()
          }
        }

        // Scope isolation: home finds own, foreign scope stays clean.
        for (const [ws, other] of [[WS_KINE, WS_ITT], [WS_ITT, WS_KINE]] as const) {
          const h = ws === WS_KINE ? rk : ri
          const own = PLAN.filter((p) => p.uuid === ws)
          const foreign = PLAN.filter((p) => p.uuid === other)
          for (const e of own) {
            const f = await findEntity(h, `workspace:${ws}`, e.key)
            expect(f).not.toBeNull()
          }
          for (const e of foreign) {
            const res = await broker.recall(h, { query: e.key, limit: 5, mode: 'dense' })
            expect(res.items.filter((m) => (m.item as { key?: string }).key === e.key)).toEqual([])
          }
        }

        // Positive trigger proof: declared recall_when arrays (replayed in
        // the body) are matched by recallWhen — the transferable mechanism.
        for (const e of PLAN) {
          const h = rhandles[e.db]
          const res = await broker.recallWhen(h, e.triggers[0], 5)
          expect(
            res.items.some((m) => (m.item as { key?: string }).key === e.key),
          ).toBe(true)
        }
      } finally {
        sessions.close(rk)
        sessions.close(ri)
      }

      // No dupes, no extra history (crash victim adopted, never rewritten).
      for (const [ws, n] of [[WS_KINE, 7], [WS_ITT, 4]] as const) {
        const d = new DatabaseSync(dbFile(ws), { readOnly: true })
        try {
          d.exec('PRAGMA query_only = ON')
          expect((d.prepare('SELECT COUNT(*) AS n FROM entities').get() as { n: number }).n).toBe(n)
          expect(
            (d.prepare('SELECT COUNT(*) AS n FROM entities GROUP BY key HAVING COUNT(*) > 1').all() as unknown[]).length,
          ).toBe(0)
          expect((d.prepare('SELECT COUNT(*) AS n FROM entity_history').get() as { n: number }).n).toBe(0)
        } finally {
          d.close()
        }
      }
      expect(Object.keys(manifest)).toHaveLength(11)
    } finally {
      await manager.stopAll().catch(() => undefined)
      rmSync(userDataDir, { recursive: true, force: true })
    }
  }, 180_000)
})
