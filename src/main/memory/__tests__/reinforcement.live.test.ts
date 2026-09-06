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

const WS = '99999999-9999-4933-8999-999999999999'

// Engine reinforcement map (binary 2.23.2, long-lived serve), proven here so
// the broker's fail-closed mode set rests on evidence, not assumption:
// - dense / recallWhen / getEntity / history: never persist usage changes.
// - fts5: persists +1 retrieval_count + refreshed access/decay per SERVED
//   recall, regardless of the reinforce flag (the flag only matters for
//   dense, where reinforce:true flushes the same bump into the next read).
// Run: ITTOP_VAULT_LIVE_TEST=1 npx vitest run src/main/memory
const runIf = process.env.ITTOP_VAULT_LIVE_TEST === '1' ? describe : describe.skip

function cli(db: string, key: string, subcommand: string, ...args: string[]): string {
  return execFileSync('perseus-vault', [subcommand, '--db', db, '--encryption-key', key, ...args], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
  })
}

function counters(db: string): { retrieval_count: number; last_accessed_unix_ms: number; decay_score: number } {
  const d = new DatabaseSync(db, { readOnly: true })
  try {
    d.exec('PRAGMA query_only = ON')
    return d.prepare('SELECT retrieval_count, last_accessed_unix_ms, decay_score FROM entities').get() as {
      retrieval_count: number
      last_accessed_unix_ms: number
      decay_score: number
    }
  } finally {
    d.close()
  }
}

runIf('reinforcement mode map', () => {
  it('documents exactly which read paths persist usage', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'ittop-vault-reinf-'))
    const manager = new VaultManager({ userDataDir, binaryPath: 'perseus-vault' })
    try {
      await manager.ensureGlobal()
      const global = pathsForDb(userDataDir, 'global')
      cli(global.dbFile, global.keyFile, 'write', '--category', 'decision', '--key', 'reinf probe', '--body', '{"content":"reinf probe"}')
      const sessions = new SessionRegistry()
      const broker = new MemoryBroker(manager, sessions)
      const h = sessions.open(WS, {})
      const snap = (): string => JSON.stringify(counters(global.dbFile))

      // Clean modes: dense, recallWhen, getEntity, history — zero movement.
      await broker.recall(h, { query: 'reinf probe', limit: 5, mode: 'dense' })
      await broker.recall(h, { query: 'reinf probe', limit: 5, mode: 'dense' })
      const found = (
        await broker.recall(h, { query: 'reinf probe', limit: 5, mode: 'dense' })
      ).items.find((m) => (m.item as { key?: string }).key === 'reinf probe')
      const id = ((found as { item: unknown }).item as { id: string }).id
      await broker.getEntity(h, 'global', id)
      await broker.history(h, 'global', 'decision', 'reinf probe')
      await broker.recallWhen(h, 'reinf probe', 5)
      const clean = JSON.parse(snap()) as { retrieval_count: number; decay_score: number }
      expect(clean.retrieval_count).toBe(0)
      expect(clean.decay_score).toBe(0.5)

      // Raw fts5 (the locked mode): bumps count/access/decay, same identity.
      await manager.call('global', 'perseus_vault_recall', {
        query: 'reinf probe',
        limit: 5,
        mode: 'fts5',
        reinforce: false,
        workspace_hash: '',
      })
      const after = JSON.parse(snap()) as { retrieval_count: number; decay_score: number }
      expect(after.retrieval_count).toBe(1)
      expect(after.decay_score).toBeGreaterThan(0.5)
      expect(snap()).not.toBe(JSON.stringify(clean))

      // Broker rejects the reinforcing modes fail-closed.
      await expect(broker.recall(h, { query: 'x', mode: 'fts5' as never })).rejects.toThrow(/locked until fork-patch/)
      await expect(broker.recall(h, { query: 'x', mode: 'hybrid' as never })).rejects.toThrow(/locked until fork-patch/)
      await manager.stopAll()
    } finally {
      await manager.stopAll().catch(() => undefined)
      rmSync(userDataDir, { recursive: true, force: true })
    }
  }, 120000)
})
