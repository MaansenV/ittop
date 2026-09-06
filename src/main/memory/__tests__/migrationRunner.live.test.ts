import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { MemoryBroker } from '../broker'
import { SessionRegistry } from '../capabilities'
import { runMigration, type MigrationEntry, type RunnerDeps } from '../migrate'
import { VaultManager } from '../vaultManager'
import { pathsForDb } from '../paths'

// Live proof for the 6b runner (binary 2.23.2): the SAME runMigration core
// with CLI-backed deps on temp DBs in ittop layout — full intended payload
// (category/key/body/entity-type/tags/UUID workspace scope/recall_when),
// crash adoption, scope isolation, trigger hits, full-field compare.
// Bodies are SYNTHETIC (mechanics proof; see phase6-mapping.md).
// Run: ITTOP_VAULT_LIVE_TEST=1 npx vitest run src/main/memory
const runIf = process.env.ITTOP_VAULT_LIVE_TEST === '1' ? describe : describe.skip

const WS_KINE = '55555555-5555-4555-8555-555555555555'
const WS_ITT = '66666666-6666-4666-8666-666666666666'

const TAGS: Record<string, string[]> = {
  'astar-doorways-no-links': ['astar', 'recast', 'doors'],
  'powershell-utf8-bom-json': ['powershell', 'mcp', 'json'],
  'release-workflow': ['release', 'workflow'],
}

function plan(): MigrationEntry[] {
  const keys: Array<[string, string, string, string[]]> = [
    ['kine', 'decision', 'astar-doorways-no-links', ['connecting recast graph through door openings']],
    ['kine', 'decision', 'astar-recast-support', ['setting up AstarPath with RecastGraph']],
    ['kine', 'decision', 'crawler-navigation-removed', ['removing CrawlerNavigation subsystem']],
    ['kine', 'decision', 'door-navmesh-carver', ['implementing DoorNavmeshCarver blocking logic']],
    ['kine', 'decision', 'doorastarsetup-baked-cut', ['baking NavmeshCut into door prefab']],
    ['kine', 'decision', 'net-stack', ['choosing PurrNet coop networking setup']],
    ['kine', 'decision', 'purrnet-door-leaf-complete', ['decoupling door leaf animation from PurrNet']],
    ['ittop', 'gotcha', 'advisor-v2-latch-loop', ['debugging advisor-v2 latch loop']],
    ['ittop', 'gotcha', 'powershell-utf8-bom-json', ['PowerShell UTF8 BOM breaks JSON.parse']],
    ['ittop', 'gotcha', 'xterm-fit-padding', ['xterm fit addon measures grid wrong']],
    ['ittop', 'procedure', 'release-workflow', ['releasing new ittop version workflow']],
  ]
  return keys.map(([db, category, key, triggers]) => ({
    workspaceUuid: db === 'kine' ? WS_KINE : WS_ITT,
    category,
    key,
    body: JSON.stringify({ content: `6a runner proof body for ${key}.`, recall_when: triggers }),
    entityType: category === 'procedure' ? 'procedure' : 'insight',
    tags: TAGS[key] ?? [],
  }))
}

function cli(...args: string[]): string {
  return execFileSync('perseus-vault', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] })
}

runIf('migration runner (live proof)', () => {
  it('migrates the full payload with crash adoption and scope isolation', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'ittop-migrunner-'))
    const manager = new VaultManager({ userDataDir, binaryPath: 'perseus-vault' })
    try {
      await manager.ensureWorkspace(WS_KINE)
      await manager.ensureWorkspace(WS_ITT)
      const sessions = new SessionRegistry()
      const broker = new MemoryBroker(manager, sessions)
      const dbId = (uuid: string): string => `workspace:${uuid}`
      const keyFile = (uuid: string): string => pathsForDb(userDataDir, dbId(uuid)).keyFile
      const dbFile = (uuid: string): string => pathsForDb(userDataDir, dbId(uuid)).dbFile

      const deps = (crashAfterWrites: number): RunnerDeps & { writeCount: () => number } => {
        const state = { writes: 0 }
        return {
          writeCount: () => state.writes,
          targetHasEntities: async (uuid) => {
            const d = new DatabaseSync(dbFile(uuid), { readOnly: true })
            try {
              d.exec('PRAGMA query_only = ON')
              return (d.prepare('SELECT COUNT(*) AS n FROM entities').get() as { n: number }).n > 0
            } finally {
              d.close()
            }
          },
          targetPath: (uuid) => dbFile(uuid),
          targetIdentities: async (uuid) => {
            const d = new DatabaseSync(dbFile(uuid), { readOnly: true })
            try {
              d.exec('PRAGMA query_only = ON')
              return (
                d.prepare('SELECT category, key, workspace_hash AS wh FROM entities').all() as Array<{
                  category: string
                  key: string
                  wh: string
                }>
              ).map((r) => ({ category: r.category, key: r.key, workspace_hash: r.wh }))
            } finally {
              d.close()
            }
          },
          writeEntry: (e) => {
            cli(
              'write', '--db', dbFile(e.workspaceUuid), '--encryption-key', keyFile(e.workspaceUuid),
              '--category', e.category, '--key', e.key, '--body', e.body,
              '--entity-type', e.entityType, '--tags', e.tags.join(','),
              '--workspace-hash', e.workspaceUuid,
            )
            state.writes += 1
            if (crashAfterWrites > 0 && state.writes >= crashAfterWrites) {
              throw new Error('simulated crash between write and manifest')
            }
          },
          readBack: async (uuid, category, key) => {
            // SQL-first resolution (never recall-bounded): a present dataset
            // outside recall hits must still be found, never rewritten.
            // Ambiguous identities refuse instead of guessing.
            const d0 = new DatabaseSync(dbFile(uuid), { readOnly: true })
            let found: Array<{ id: string; wh: string }>
            try {
              d0.exec('PRAGMA query_only = ON')
              found = d0
                .prepare('SELECT id, workspace_hash AS wh FROM entities WHERE category = ? AND key = ?')
                .all(category, key) as Array<{ id: string; wh: string }>
            } finally {
              d0.close()
            }
            if (found.length === 0) return null
            if (found.length > 1) {
              throw new Error(`refusing readBack: ambiguous identity for ${category}/${key}`)
            }
            const h = sessions.open(uuid, {})
            try {
              const ent = (await broker.getEntity(h, dbId(uuid), found[0].id)) as Record<string, unknown>
              const body = typeof ent.body_json === 'string' ? ent.body_json : JSON.stringify(ent.body_json ?? '')
              const d = new DatabaseSync(dbFile(uuid), { readOnly: true })
              try {
                d.exec('PRAGMA query_only = ON')
                const row = d.prepare('SELECT workspace_hash AS wh, tags FROM entities WHERE id = ?').get(found[0].id) as {
                  wh: string
                  tags: string
                }
                let tags: string[] = []
                try {
                  const parsed: unknown = JSON.parse(row.tags || '[]')
                  tags = Array.isArray(parsed) ? (parsed as string[]) : []
                } catch {
                  tags = []
                }
                return {
                  body,
                  fields: { category: ent.category, key: ent.key, entity_type: ent.entity_type, tags, workspace_hash: row.wh },
                }
              } finally {
                d.close()
              }
            } finally {
              sessions.close(h)
            }
          },
          recallKeys: async (uuid, query) => {
            const h = sessions.open(uuid, {})
            try {
              const res = await broker.recall(h, { query, limit: 10, mode: 'dense' })
              return res.items
                .filter((m) => m.db === dbId(uuid))
                .map((m) => (m.item as { key?: string }).key ?? '')
            } finally {
              sessions.close(h)
            }
          },
          isAborted: () => false,
        }
      }

      const manifest = join(userDataDir, 'manifest.json')
      // Phase 1: crash mid-run (entry 3 written, never manifested).
      await expect(runMigration(plan(), manifest, deps(3))).rejects.toThrow(/simulated crash/)
      // Phase 2: resume completes; crash victim adopted without rewrite.
      const receipt = await runMigration(plan(), manifest, deps(0))
      expect(receipt.aborted).toBe(false)
      expect(receipt.entries).toHaveLength(11)
      expect(receipt.entries.filter((e) => e.adopted)).toHaveLength(1)
      expect(receipt.entries.every((e) => e.verified)).toBe(true)

      // Full-field payload compare incl. tags/type/workspace scope.
      const hk = sessions.open(WS_KINE)
      const hi = sessions.open(WS_ITT)
      try {
        for (const e of plan()) {
          const h = e.workspaceUuid === WS_KINE ? hk : hi
          const res = await broker.recall(h, { query: e.key, limit: 5, mode: 'dense' })
          const hit = res.items.find((m) => (m.item as { key?: string }).key === e.key)
          expect(hit).toBeTruthy()
          if (!hit) throw new Error(`lost ${e.key}`)
          const ent = (await broker.getEntity(h, dbId(e.workspaceUuid), (hit.item as { id: string }).id)) as Record<
            string,
            unknown
          >
          expect(ent.category).toBe(e.category)
          expect(ent.entity_type).toBe(e.entityType)
          expect(ent.body_json).toBe(e.body)
        }
        for (const uuid of [WS_KINE, WS_ITT] as const) {
          const d = new DatabaseSync(dbFile(uuid), { readOnly: true })
          try {
            d.exec('PRAGMA query_only = ON')
            for (const e of plan().filter((p) => p.workspaceUuid === uuid)) {
              const row = d.prepare('SELECT workspace_hash AS wh, tags FROM entities WHERE key = ?').get(e.key) as {
                wh: string
                tags: string
              }
              expect(row.wh).toBe(uuid)
              for (const t of e.tags) expect(row.tags).toContain(t)
            }
          } finally {
            d.close()
          }
        }
        // Scope isolation across the two workspace DBs.
        for (const e of plan()) {
          const home = e.workspaceUuid === WS_KINE ? hk : hi
          const away = e.workspaceUuid === WS_KINE ? hi : hk
          const hr = await broker.recall(home, { query: e.key, limit: 5, mode: 'dense' })
          expect(hr.items.some((m) => (m.item as { key?: string }).key === e.key)).toBe(true)
          const ar = await broker.recall(away, { query: e.key, limit: 5, mode: 'dense' })
          expect(ar.items.some((m) => (m.item as { key?: string }).key === e.key)).toBe(false)
        }
        // Trigger hits on every replayed entry (declared arrays).
        for (const e of plan()) {
          const h = e.workspaceUuid === WS_KINE ? hk : hi
          const res = await broker.recallWhen(h, JSON.parse(e.body).recall_when[0] as string, 5)
          expect(res.items.some((m) => (m.item as { key?: string }).key === e.key)).toBe(true)
        }
      } finally {
        sessions.close(hk)
        sessions.close(hi)
      }

      // No dupes, no extra history anywhere.
      for (const uuid of [WS_KINE, WS_ITT]) {
        const d = new DatabaseSync(dbFile(uuid), { readOnly: true })
        try {
          d.exec('PRAGMA query_only = ON')
          expect(
            (d.prepare('SELECT COUNT(*) AS n FROM entities GROUP BY key HAVING COUNT(*) > 1').all() as unknown[]).length,
          ).toBe(0)
          expect((d.prepare('SELECT COUNT(*) AS n FROM entity_history').get() as { n: number }).n).toBe(0)
        } finally {
          d.close()
        }
      }
    } finally {
      await manager.stopAll().catch(() => undefined)
      rmSync(userDataDir, { recursive: true, force: true })
    }
  }, 240_000)
  it('adopts SQL-present rows via SQL-first readBack (no recall needed, no rewrite)', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'ittop-migrunner-'))
    const manager = new VaultManager({ userDataDir, binaryPath: 'perseus-vault' })
    try {
      await manager.ensureWorkspace(WS_KINE)
      const sessions = new SessionRegistry()
      const broker = new MemoryBroker(manager, sessions)
      const dbId = (uuid: string): string => `workspace:${uuid}`
      const dbFile = (uuid: string): string => pathsForDb(userDataDir, dbId(uuid)).dbFile
      const body = JSON.stringify({ content: 'smuggled body', recall_when: ['smuggled trigger phrase'] })
      // Smuggle a row past the write path: raw SQL, NULL embedding, no FTS
      // rows, no manifest. Adoption must come from SQL-first readBack alone
      // (recall behavior is irrelevant to the guarantee and not asserted).
      const w = new DatabaseSync(dbFile(WS_KINE))
      try {
        w.prepare(
          `INSERT INTO entities (id, category, key, body_json, status, type, workspace_hash, visibility, created_at_unix_ms, last_accessed_unix_ms) VALUES (?, ?, ?, ?, 'active', 'insight', ?, 'workspace', ?, ?)`,
        ).run('smuggled-id', 'decision', 'smuggled-key', body, WS_KINE, Date.now(), Date.now())
      } finally {
        w.close()
      }
      const entry: MigrationEntry = {
        workspaceUuid: WS_KINE,
        category: 'decision',
        key: 'smuggled-key',
        body,
        entityType: 'insight',
        tags: [],
      }
      let writes = 0
      const receipt = await runMigration(
        [entry],
        join(userDataDir, 'manifest.json'),
        {
          targetHasEntities: async () => false,
          targetPath: (uuid) => dbFile(uuid),
          targetIdentities: async () => [],
          writeEntry: () => {
            writes += 1
          },
          readBack: async (uuid, category, key) => {
            const d = new DatabaseSync(dbFile(uuid), { readOnly: true })
            try {
              d.exec('PRAGMA query_only = ON')
              const found = d
                .prepare('SELECT id, workspace_hash AS wh FROM entities WHERE category = ? AND key = ?')
                .all(category, key) as Array<{ id: string; wh: string }>
              if (found.length === 0) return null
              if (found.length > 1) throw new Error('ambiguous')
              const h = sessions.open(uuid, {})
              try {
                const ent = (await broker.getEntity(h, dbId(uuid), found[0].id)) as Record<string, unknown>
                const b = typeof ent.body_json === 'string' ? ent.body_json : JSON.stringify(ent.body_json ?? '')
                return { body: b, fields: { category, key, entity_type: 'insight', tags: [], workspace_hash: found[0].wh } }
              } finally {
                sessions.close(h)
              }
            } finally {
              d.close()
            }
          },
          recallKeys: async () => [],
          isAborted: () => false,
        },
      )
      expect(receipt.entries).toHaveLength(1)
      expect(receipt.entries[0].adopted).toBe(true)
      expect(writes).toBe(0)
    } finally {
      await manager.stopAll().catch(() => undefined)
      rmSync(userDataDir, { recursive: true, force: true })
    }
  }, 240_000)
})
