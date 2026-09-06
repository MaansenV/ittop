import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { VaultManager } from '../vaultManager'
import { snapshotDb } from './dbSnapshot'
import { pathsForDb } from '../paths'

// capture dry_run side-effect proof (binary 2.23.2): the Phase-5 shadow
// pipeline rests on dry_run writing nothing AND moving no counters.
// Run: ITTOP_VAULT_LIVE_TEST=1 npx vitest run src/main/memory
const runIf = process.env.ITTOP_VAULT_LIVE_TEST === '1' ? describe : describe.skip

function cli(db: string, key: string, subcommand: string, ...args: string[]): string {
  return execFileSync('perseus-vault', [subcommand, '--db', db, '--encryption-key', key, ...args], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
  })
}

function snapshot(db: string): string {
  return snapshotDb(db)
}

runIf('capture dry_run side effects', () => {
  it('distills notes without touching the database', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'ittop-vault-capdry-'))
    try {
      const manager = new VaultManager({ userDataDir, binaryPath: 'perseus-vault' })
      try {
        await manager.ensureGlobal()
        const global = pathsForDb(userDataDir, 'global')
        cli(
          global.dbFile,
          global.keyFile,
          'write',
          '--category',
          'decision',
          '--key',
          'capdry probe',
          '--body',
          '{"content":"capdry probe"}',
        )
        const before = snapshot(global.dbFile)
        const res = (await manager.call('global', 'perseus_vault_capture', {
          text: '# Solved: flaky launch was a DevTools firstWindow race\n\nThe E2E helper grabbed the DevTools window. Fix polls for the first non-devtools URL.',
          dry_run: true,
          max_entities: 5,
        })) as { created?: number; dry_run?: boolean; notes?: Array<{ key?: string }> }
        expect(res.created).toBe(0)
        expect(res.dry_run).toBe(true)
        expect(Array.isArray(res.notes)).toBe(true)
        expect(snapshot(global.dbFile)).toBe(before)
      } finally {
        await manager.stopAll().catch(() => undefined)
      }
    } finally {
      rmSync(userDataDir, { recursive: true, force: true })
    }
  })
})
