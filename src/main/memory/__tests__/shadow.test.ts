import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ShadowEval } from '../shadow'
import type { VaultManager } from '../vaultManager'

const WS = '11111111-1111-4111-8111-111111111111'
const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

function userData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ittop-shadow-'))
  dirs.push(dir)
  return dir
}

function stubManager(calls: Array<{ tool: string; args: Record<string, unknown> }> = []): VaultManager {
  return {
    call: async (_db: string, tool: string, args: Record<string, unknown>) => {
      calls.push({ tool, args })
      if (tool === 'perseus_vault_recall_when') {
        return { items: [{ id: 'e1', category: 'decision', key: 'k', content: 'prior fact' }] }
      }
      if (tool === 'perseus_vault_capture') {
        return {
          created: 0,
          dry_run: true,
          notes: [{ key: 'solved-flaky-thing', summary: 'Solved: flaky thing fixed.', type: 'takeaway' }],
        }
      }
      throw new Error(`unexpected tool ${tool}`)
    },
  } as unknown as VaultManager
}

describe('ShadowEval', () => {
  it('fails closed while disabled without touching the filesystem', async () => {
    const dir = userData()
    const shadow = new ShadowEval({ isEnabled: () => false, userDataDir: dir, getManager: () => stubManager() })
    try {
      expect(() => shadow.list()).toThrow(/disabled/)
      await expect(
        shadow.run({ workspaceId: WS, workspaceName: 'w', hookEvent: 'Stop' }),
      ).rejects.toThrow(/disabled/)
      expect(readdirSync(dir)).toEqual([])
    } finally {
      shadow.close()
    }
  })

  it('runs recall + dry-run capture and records an evaluated receipt', async () => {
    const tools: Array<{ tool: string; args: Record<string, unknown> }> = []
    const shadow = new ShadowEval({ isEnabled: () => true, userDataDir: userData(), getManager: () => stubManager(tools) })
    try {
      const receipt = await shadow.run({
        workspaceId: WS,
        workspaceName: 'demo',
        hookEvent: 'Stop',
        message: 'solved the flaky thing',
      })
      expect(receipt.recallHits).toBe(1)
      expect(receipt.notes).toHaveLength(1)
      expect(receipt.notes[0].key).toBe('solved-flaky-thing')
      expect(['approve', 'review', 'reject']).toContain(receipt.notes[0].verdict)
      // Read-only proof: recall_when (+1 hasMore probe) + capture only,
      // with the safe flags set explicitly.
      const captures = tools.filter((t) => t.tool === 'perseus_vault_capture')
      expect(captures).toHaveLength(1)
      expect(captures[0].args.dry_run).toBe(true)
      expect(captures[0].args.llm).toBe(false)
      expect(captures[0].args.consume).toBe(false)
      for (const tool of tools) {
        expect(['perseus_vault_recall_when', 'perseus_vault_capture']).toContain(tool.tool)
      }
      const rows = shadow.list()
      expect(rows).toHaveLength(1)
      expect(rows[0].notesAccepted).toBe(receipt.accepted)
    } finally {
      shadow.close()
    }
  })

  it('guard blocks the capture dispatch when disable lands during slow ensure', async () => {
    let shadowRef!: ShadowEval
    const manager = {
      call: async (_db: string, tool: string, _args: Record<string, unknown>, guard?: () => void) => {
        if (tool === 'perseus_vault_recall_when') return { items: [] }
        if (tool === 'perseus_vault_capture') {
          shadowRef.invalidate() // disable lands while ensure is still slow
          guard?.() // manager dispatches synchronously after ensure: must throw
          throw new Error('capture dispatch must not happen after disable')
        }
        throw new Error(`unexpected tool ${tool}`)
      },
    } as unknown as VaultManager
    const dir = userData()
    const shadow = new ShadowEval({ isEnabled: () => true, userDataDir: dir, getManager: () => manager })
    shadowRef = shadow
    try {
      await expect(
        shadow.run({ workspaceId: WS, workspaceName: 'demo', hookEvent: 'Stop' }),
      ).rejects.toThrow(/superseded|disabled/)
      expect(readdirSync(dir)).toEqual([])
    } finally {
      shadow.close()
    }
  })

  it('invalidate during capture aborts before record, no file', async () => {
    let releaseCap!: (v: unknown) => void
    const capGate = new Promise<unknown>((res) => {
      releaseCap = res
    })
    let captureCalls = 0
    const manager = {
      call: async (_db: string, tool: string) => {
        if (tool === 'perseus_vault_recall_when') return { items: [] }
        if (tool === 'perseus_vault_capture') {
          captureCalls += 1
          return capGate // capture actually entered, answer delayed
        }
        throw new Error(`unexpected tool ${tool}`)
      },
    } as unknown as VaultManager
    const dir = userData()
    const shadow = new ShadowEval({ isEnabled: () => true, userDataDir: dir, getManager: () => manager })
    try {
      const pending = shadow.run({ workspaceId: WS, workspaceName: 'demo', hookEvent: 'Stop' })
      while (captureCalls === 0) {
        await new Promise((r) => setTimeout(r, 0))
      }
      shadow.invalidate()
      releaseCap({ created: 0, dry_run: true, notes: [{ key: 'late', summary: 'too late', type: 'takeaway' }] })
      await expect(pending).rejects.toThrow(/superseded|revoked|unknown memory session/)
      expect(readdirSync(dir)).toEqual([])
    } finally {
      shadow.close()
    }
  })

  it('close during capture aborts with no reopen afterwards', async () => {
    let releaseCap!: (v: unknown) => void
    const capGate = new Promise<unknown>((res) => {
      releaseCap = res
    })
    let captureCalls = 0
    const manager = {
      call: async (_db: string, tool: string) => {
        if (tool === 'perseus_vault_recall_when') return { items: [] }
        if (tool === 'perseus_vault_capture') {
          captureCalls += 1
          return capGate
        }
        throw new Error(`unexpected tool ${tool}`)
      },
    } as unknown as VaultManager
    const dir = userData()
    const shadow = new ShadowEval({ isEnabled: () => true, userDataDir: dir, getManager: () => manager })
    try {
      const pending = shadow.run({ workspaceId: WS, workspaceName: 'demo', hookEvent: 'Stop' })
      while (captureCalls === 0) {
        await new Promise((r) => setTimeout(r, 0))
      }
      shadow.close()
      releaseCap({ created: 0, dry_run: true, notes: [] })
      await expect(pending).rejects.toThrow(/closed|superseded|revoked|unknown memory session/)
      expect(() => shadow.list()).toThrow(/closed/)
      expect(readdirSync(dir)).toEqual([])
    } finally {
      shadow.close()
    }
  })

  it('parallel runs leave the instance reusable for a fresh run', async () => {
    const WS2 = '22222222-2222-4222-8222-222222222222'
    const WS3 = '33333333-3333-4333-8333-333333333333'
    let release!: (v: unknown) => void
    const gate = new Promise<unknown>((res) => {
      release = res
    })
    let gated = true
    const manager = {
      call: async (_db: string, tool: string) => {
        if (gated && tool === 'perseus_vault_recall_when') return gate
        if (tool === 'perseus_vault_recall_when') return { items: [] }
        if (tool === 'perseus_vault_capture') {
          return { created: 0, dry_run: true, notes: [{ key: 'fresh', summary: 'Fresh note.', type: 'takeaway' }] }
        }
        throw new Error(`unexpected tool ${tool}`)
      },
    } as unknown as VaultManager
    const shadow = new ShadowEval({ isEnabled: () => true, userDataDir: userData(), getManager: () => manager })
    try {
      const a = shadow.run({ workspaceId: WS, workspaceName: 'a', hookEvent: 'Stop' })
      const b = shadow.run({ workspaceId: WS2, workspaceName: 'b', hookEvent: 'Stop' })
      shadow.invalidate()
      release({ items: [] })
      await expect(a).rejects.toThrow(/superseded|revoked|unknown memory session/)
      await expect(b).rejects.toThrow(/superseded|revoked|unknown memory session/)
      // Fresh workspace (no cooldown): a full successful run with receipt.
      gated = false
      const receipt = await shadow.run({ workspaceId: WS3, workspaceName: 'c', hookEvent: 'Stop' })
      expect(receipt.notes).toHaveLength(1)
      expect(receipt.notes[0].key).toBe('fresh')
      expect(shadow.list()).toHaveLength(1)
    } finally {
      shadow.close()
    }
  })
  it('parallel workspace runs abort independently on invalidate', async () => {
    const WS2 = '22222222-2222-4222-8222-222222222222'
    let release!: (v: unknown) => void
    const gate = new Promise<unknown>((res) => {
      release = res
    })
    const manager = {
      call: async () => gate,
    } as unknown as VaultManager
    const dir = userData()
    const shadow = new ShadowEval({ isEnabled: () => true, userDataDir: dir, getManager: () => manager })
    try {
      const a = shadow.run({ workspaceId: WS, workspaceName: 'a', hookEvent: 'Stop' })
      const b = shadow.run({ workspaceId: WS2, workspaceName: 'b', hookEvent: 'Stop' })
      shadow.invalidate() // revokes BOTH handles, retires the generation
      release({ items: [] })
      await expect(a).rejects.toThrow(/superseded|revoked|unknown memory session/)
      await expect(b).rejects.toThrow(/superseded|revoked|unknown memory session/)
      expect(readdirSync(dir)).toEqual([])
      // Still usable after re-enable (invalidate is not close).
      expect(shadow.list()).toEqual([])
    } finally {
      shadow.close()
    }
  })
  it('disable during recall aborts before capture and record', async () => {
    let releaseRecall!: (v: unknown) => void
    const recallGate = new Promise<unknown>((res) => {
      releaseRecall = res
    })
    const tools: Array<{ tool: string }> = []
    let enabled = true
    const manager = {
      call: async (_db: string, tool: string) => {
        tools.push({ tool })
        if (tool === 'perseus_vault_recall_when') return recallGate
        throw new Error(`must never reach ${tool}`)
      },
    } as unknown as VaultManager
    const dir = userData()
    const shadow = new ShadowEval({ isEnabled: () => enabled, userDataDir: dir, getManager: () => manager })
    try {
      const pending = shadow.run({ workspaceId: WS, workspaceName: 'demo', hookEvent: 'Stop' })
      enabled = false
      shadow.invalidate()
      releaseRecall({ items: [] })
      await expect(pending).rejects.toThrow(/disabled|superseded|revoked|unknown memory session/)
      const names = tools.map((t) => t.tool)
      expect(names.length).toBeGreaterThan(0)
      for (const name of names) expect(name).toBe('perseus_vault_recall_when')
      expect(readdirSync(dir)).toEqual([])
    } finally {
      shadow.close()
    }
  })

  it('close during RPC aborts and blocks everything after', async () => {
    let releaseRecall!: (v: unknown) => void
    const recallGate = new Promise<unknown>((res) => {
      releaseRecall = res
    })
    const manager = {
      call: async () => recallGate,
    } as unknown as VaultManager
    const shadow = new ShadowEval({ isEnabled: () => true, userDataDir: userData(), getManager: () => manager })
    try {
      const pending = shadow.run({ workspaceId: WS, workspaceName: 'demo', hookEvent: 'Stop' })
      shadow.close()
      releaseRecall({ items: [] })
      await expect(pending).rejects.toThrow(/closed|superseded|revoked|unknown memory session/)
      await expect(
        shadow.run({ workspaceId: WS, workspaceName: 'demo', hookEvent: 'Stop' }),
      ).rejects.toThrow(/closed/)
      expect(() => shadow.list()).toThrow(/closed/)
    } finally {
      shadow.close() // idempotent
    }
  })

  it('redacts secrets from persisted receipts (proven by DB read)', async () => {
    const manager = {
      call: async (_db: string, tool: string) => {
        if (tool === 'perseus_vault_recall_when') return { items: [] }
        if (tool === 'perseus_vault_capture') {
          return {
            created: 0,
            dry_run: true,
            notes: [
              {
                key: 'leaked deploy token',
                summary: 'Deployed with api-key = TOPSECRET-TOKEN-12345 in env.',
                type: 'pitfall',
              },
            ],
          }
        }
        throw new Error(`unexpected tool ${tool}`)
      },
    } as unknown as VaultManager
    const dir = userData()
    const shadow = new ShadowEval({ isEnabled: () => true, userDataDir: dir, getManager: () => manager })
    try {
      const receipt = await shadow.run({ workspaceId: WS, workspaceName: 'demo', hookEvent: 'Stop' })
      expect(receipt.notes).toHaveLength(1)
      const db = new DatabaseSync(join(dir, 'vault', 'shadow.db'), { readOnly: true })
      try {
        const row = db.prepare(`SELECT receipt FROM runs WHERE id = ?`).get(receipt.id) as { receipt: string }
        expect(row.receipt).not.toContain('TOPSECRET-TOKEN-12345')
        expect(row.receipt).toContain('REDACTED')
      } finally {
        db.close()
      }
    } finally {
      shadow.close()
    }
  })
  it('enforces per-workspace cooldown', async () => {
    const shadow = new ShadowEval({ isEnabled: () => true, userDataDir: userData(), getManager: () => stubManager() })
    try {
      await shadow.run({ workspaceId: WS, workspaceName: 'demo', hookEvent: 'Stop' })
      await expect(
        shadow.run({ workspaceId: WS, workspaceName: 'demo', hookEvent: 'Stop' }),
      ).rejects.toThrow(/cooldown/)
      expect(shadow.list()).toHaveLength(1)
    } finally {
      shadow.close()
    }
  })

  it('rejects invalid workspace ids without side effects', async () => {
    const tools: Array<{ tool: string; args: Record<string, unknown> }> = []
    const dir = userData()
    const shadow = new ShadowEval({ isEnabled: () => true, userDataDir: dir, getManager: () => stubManager(tools) })
    try {
      await expect(
        shadow.run({ workspaceId: 'not-a-uuid', workspaceName: 'x', hookEvent: 'Stop' }),
      ).rejects.toThrow(/workspace id/)
      expect(tools).toEqual([])
      expect(readdirSync(dir)).toEqual([])
    } finally {
      shadow.close()
    }
  })
})
