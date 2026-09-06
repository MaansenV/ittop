import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizeVaultDbPath, VaultManager } from '../vaultManager'
import { pathsForDb, workspaceDbId } from '../paths'

const WS = '33333333-3333-4333-8333-333333333333'

// Live manager proof: real binary, real init, temp userDataDir — never the
// user's vault. For every stop the PID is captured before and probed after.
// Run: ITTOP_VAULT_LIVE_TEST=1 npx vitest run src/main/memory
const runIf = process.env.ITTOP_VAULT_LIVE_TEST === '1' ? describe : describe.skip

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

runIf('VaultManager live (real binary, temp userData)', () => {
  it('global + workspace DBs: exact path contract, restart, confirmed child end', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'ittop-vault-mgr-'))
    const manager = new VaultManager({ userDataDir, binaryPath: 'perseus-vault' })
    try {
      await manager.ensureGlobal()
      await manager.ensureWorkspace(WS)
      expect(manager.stateOf('global')).toBe('ready')
      expect(manager.stateOf(workspaceDbId(WS))).toBe('ready')

      for (const db of ['global', workspaceDbId(WS)]) {
        const expected = pathsForDb(userDataDir, db).dbFile
        const h = await manager.health(db)
        expect(h.operational).toBe(true)
        const reported = (h.detail as { db_path?: string }).db_path
        expect(typeof reported).toBe('string')
        expect(normalizeVaultDbPath(reported as string)).toBe(normalizeVaultDbPath(expected))
      }

      const pidGlobal = manager.pidOf('global')
      const pidWs = manager.pidOf(workspaceDbId(WS))
      expect(alive(pidGlobal)).toBe(true)
      expect(alive(pidWs)).toBe(true)
      expect(pidGlobal).not.toBe(pidWs) // one child per DB

      await manager.stopWorkspace(WS)
      expect(manager.stateOf(workspaceDbId(WS))).toBe('stopped')
      expect(alive(pidWs)).toBe(false)
      expect(alive(pidGlobal)).toBe(true) // sibling untouched

      await manager.ensureWorkspace(WS) // restart works
      expect(manager.stateOf(workspaceDbId(WS))).toBe('ready')
      const pidWs2 = manager.pidOf(workspaceDbId(WS))
      expect(alive(pidWs2)).toBe(true)

      await manager.stopAll()
      expect(alive(pidGlobal)).toBe(false)
      expect(alive(pidWs2)).toBe(false)
    } finally {
      await manager.stopAll().catch(() => undefined)
      rmSync(userDataDir, { recursive: true, force: true })
    }
  }, 120000)
})
