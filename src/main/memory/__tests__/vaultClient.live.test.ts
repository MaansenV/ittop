import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { VaultClient } from '../vaultClient'

// Live compatibility proof against the real binary + a FRESH temp DB
// (own key file). Never touches the user's real vault.
// Run: ITTOP_VAULT_LIVE_TEST=1 npx vitest run src/main/memory
const runIf = process.env.ITTOP_VAULT_LIVE_TEST === '1' ? describe : describe.skip

function cli(db: string, key: string, subcommand: string, ...args: string[]): string {
  return execFileSync('perseus-vault', [subcommand, '--db', db, '--encryption-key', key, ...args], {
    encoding: 'utf8',
  })
}

function childAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

runIf('VaultClient live (real binary, temp DB)', () => {
  it('handshake, empty healthy DB, exact path, roundtrip, restart, confirmed exit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ittop-vault-live-'))
    const db = join(dir, 'live.db')
    const key = join(dir, 'live.key')
    const ws = '22222222-2222-4222-8222-222222222222'
    const client = new VaultClient('perseus-vault', db, key)
    try {
      execFileSync('perseus-vault', ['init', '--db', db, '--key-file', key], { encoding: 'utf8' })
      await client.start()
      expect(client.running).toBe(true)
      expect(childAlive(client.childPid)).toBe(true)

      const health = (await client.call('perseus_vault_health', {})) as {
        status?: string
        ready?: boolean
        active_memories?: number
        db_path?: string
      }
      expect(health.status).toBe('healthy')
      expect(health.ready).toBe(false) // empty store: healthy but not ready
      expect(health.active_memories).toBe(0)
      expect(health.db_path).toContain('live.db')

      cli(db, key, 'write', '--category', 'decision', '--key', 'live-probe', '--workspace-hash', ws,
        '--body', '{"content":"live probe","recall_when":["live probe context"]}')
      const recall = (await client.call('perseus_vault_recall', {
        query: 'live probe',
        workspace_hash: ws,
        limit: 5,
      })) as { total?: number }
      expect(recall.total).toBe(1)

      cli(db, key, 'write', '--category', 'decision', '--key', 'live-probe', '--workspace-hash', ws,
        '--body', '{"content":"live probe v2"}')
      const history = (await client.call('perseus_vault_history', {
        category: 'decision',
        key: 'live-probe',
        limit: 5,
      })) as { total?: number }
      expect(history.total).toBe(1)

      cli(db, key, 'forget', '--category', 'decision', '--key', 'live-probe')
      const after = (await client.call('perseus_vault_recall', {
        query: 'live probe',
        workspace_hash: ws,
        limit: 5,
      })) as { total?: number }
      expect(after.total).toBe(0)

      const pid = client.childPid
      await client.stop()
      expect(childAlive(pid)).toBe(false)

      await client.start() // restart: process + persistence proof
      const re = (await client.call('perseus_vault_health', {})) as { status?: string }
      expect(re.status).toBe('healthy')
      await client.stop()
      expect(childAlive(client.childPid)).toBe(false)
    } finally {
      await client.stop().catch(() => undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120000)
})
