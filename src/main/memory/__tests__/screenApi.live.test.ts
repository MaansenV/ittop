import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryScreenApi } from '../screenApi'
import { VaultClient } from '../vaultClient'
import { VaultManager } from '../vaultManager'
import { pathsForDb, type VaultPaths } from '../paths'

const WS = '66666666-6666-4633-8666-666666666666'

// Full-path browse proof: the real screenApi (not just the broker) against
// the real binary on temp userData. Never the user's vault.
// Run: ITTOP_VAULT_LIVE_TEST=1 npx vitest run src/main/memory
const runIf = process.env.ITTOP_VAULT_LIVE_TEST === '1' ? describe : describe.skip

function tree(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true, encoding: 'utf8' }) as string[]
  } catch {
    return []
  }
}

runIf('MemoryScreenApi browse live (cold start, real binary)', () => {
  it('cold browse reports noStore and creates nothing; existing store boots and lists', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'ittop-screen-browse-'))
    const api = new MemoryScreenApi({
      isEnabled: () => true,
      userDataDir,
      getManager: () => manager,
    })
    const manager = new VaultManager({ userDataDir, binaryPath: 'perseus-vault' })
    try {
      // Cold: no files at all — full path refuses, creates nothing.
      const cold = (await api.browse(WS, { db: 'workspace' })) as {
        db: string
        noStore: boolean
        items: unknown[]
        total: number | null
      }
      expect(cold.db).toBe(`workspace:${WS}`)
      expect(cold.noStore).toBe(true)
      expect(cold.items).toEqual([])
      expect(cold.total).toBeNull()
      expect(tree(join(userDataDir, 'vault'))).toEqual([])
      // Setup an existing store (explicit ensure + CLI write = registry duty).
      await manager.ensureWorkspace(WS)
      const paths = pathsForDb(userDataDir, `workspace:${WS}`)
      execFileSync(
        'perseus-vault',
        ['write', '--db', paths.dbFile, '--encryption-key', paths.keyFile, '--category', 'decision', '--key', 'cold-a',
          '--workspace-hash', WS, '--body', '{"content":"cold alpha"}'],
        { encoding: 'utf8' },
      )
      await manager.stopAll()
      // Fresh manager = cold boot: browse must boot the EXISTING store
      // (no recreate) and list through the whole path — with a full
      // lossless snapshot before/after proving bootExisting + browse
      // persist nothing.
      const manager2 = new VaultManager({ userDataDir, binaryPath: 'perseus-vault' })
      const api2 = new MemoryScreenApi({ isEnabled: () => true, userDataDir, getManager: () => manager2 })
      const dumpAll = async (dbFile: string): Promise<Record<string, unknown>> => {
        const { DatabaseSync } = await import('node:sqlite')
        const d = new DatabaseSync(dbFile, { readOnly: true })
        try {
          const tables = d
            .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name")
            .all() as Array<{ name: string }>
          const out: Record<string, unknown> = {}
          for (const { name } of tables) {
            const safe = name.replace(/"/g, '""')
            const cols = d.prepare(`PRAGMA table_info("${safe}")`).all() as Array<{ name: string }>
            if (cols.length === 0) throw new Error(`table "${name}" has no columns`)
            const sel = cols
              .map((c) => `quote("${c.name.replace(/"/g, '""')}") AS "${c.name.replace(/"/g, '""')}"`)
              .join(', ')
            try {
              out[name] = d.prepare(`SELECT ${sel} FROM "${safe}"`).all()
            } catch (e) {
              throw new Error(`table "${name}" unreadable: ${(e as Error).message}`)
            }
          }
          return out
        } finally {
          d.close()
        }
      }
      try {
        const before = await dumpAll(paths.dbFile)
        const warm = (await api2.browse(WS, { db: 'workspace' })) as {
          noStore: boolean
          items: Array<{ key?: string }>
          total: number | null
          missing: unknown
        }
        expect(warm.noStore).toBe(false)
        expect(warm.missing).toBeNull()
        expect(warm.items.map((m) => m.key)).toEqual(['cold-a'])
        expect(warm.total).toBe(1)
        // bootExisting + browse persisted nothing.
        expect(await dumpAll(paths.dbFile)).toEqual(before)
      } finally {
        api2.close()
        await manager2.stopAll().catch(() => undefined)
      }
      // Race regression (deterministic): the DB vanishes AFTER the
      // pre-checks but BEFORE serve opens it; the key remains. The vendor
      // open-mode recreates an EMPTY db and starts — browse must refuse
      // to serve it (no silent empty store), and the key stays untouched.
      const keyBefore = readFileSync(paths.keyFile)
      const manager3 = new VaultManager({
        userDataDir,
        binaryPath: 'perseus-vault',
        createClient: (cpaths: VaultPaths, onExit) => {
          const { rmSync: rm } = require('node:fs') as typeof import('node:fs')
          rm(cpaths.dbFile) // external deleter striking mid-boot
          return new VaultClient('perseus-vault', cpaths.dbFile, cpaths.keyFile, {
            onUnexpectedExit: onExit,
          })
        },
      })
      const api3 = new MemoryScreenApi({ isEnabled: () => true, userDataDir, getManager: () => manager3 })
      try {
        await expect(api3.browse(WS, { db: 'workspace' })).rejects.toThrow(/changed during boot/)
        // Vendor behavior proven: serve recreated an EMPTY db (entity lost
        // with the deleted file) — refused, never served. Key untouched.
        const { DatabaseSync } = await import('node:sqlite')
        const d = new DatabaseSync(paths.dbFile, { readOnly: true })
        try {
          const n = (d.prepare('SELECT COUNT(*) AS c FROM entities').get() as { c: number }).c
          expect(n).toBe(0)
        } finally {
          d.close()
        }
        expect(readFileSync(paths.keyFile).equals(keyBefore)).toBe(true)
      } finally {
        api3.close()
        await manager3.stopAll().catch(() => undefined)
      }
    } finally {
      api.close()
      await manager.stopAll().catch(() => undefined)
      rmSync(userDataDir, { recursive: true, force: true })
    }
  }, 120000)
})
