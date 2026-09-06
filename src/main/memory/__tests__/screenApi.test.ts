import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AdmissionCandidate } from '../admission'
import { MemoryScreenApi } from '../screenApi'
import type { VaultManager } from '../vaultManager'

const WS = '11111111-1111-4111-8111-111111111111'
const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

function userData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ittop-screen-'))
  dirs.push(dir)
  return dir
}

function candidate(over: Partial<AdmissionCandidate> = {}): AdmissionCandidate {
  return {
    db: `workspace:${WS}`,
    category: 'decision',
    key: 'k1',
    content: 'Use RecastGraph for indoor navmesh baking.',
    futureUse: 'Recall when baking indoor navmeshes in Unity.',
    evidence: { sourceRef: 'screen-test' },
    triggers: ['baking indoor navmesh', 'recast graph setup'],
    ...over,
  }
}

const reviewVerdict = { decision: 'review' as const, score: 0.8, reasons: ['test'] }

function stubManager(): VaultManager {
  const serve = async (db: string, tool: string) => {
    if (tool === 'perseus_vault_recall') {
      return { items: [{ id: 'e1', category: 'decision', key: 'k-e1', content: 'stored fact' }] }
    }
    if (tool === 'perseus_vault_scan') {
      return {
        items: [{ id: 'e1', category: 'decision', key: 'k-e1', content: 'stored fact' }],
        total: 1,
        has_more: false,
        next_cursor: null,
      }
    }
    if (tool === 'perseus_vault_get_entity') return { id: 'e1', db, content: 'stored fact' }
    if (tool === 'perseus_vault_history') return { versions: [{ v: 1 }] }
    throw new Error(`unexpected tool ${tool}`)
  }
  return {
    call: async (db: string, tool: string) => serve(db, tool),
    // Browse path (callIfReady): same stubbed backend, separate method.
    callIfReady: async (db: string, tool: string) => serve(db, tool),
    bootExisting: async () => undefined,
    withDbLock: async (_db: string, fn: () => Promise<unknown>) => fn(),
    executeWrite: async () => undefined,
  } as unknown as VaultManager
}

function setup(enabled = true, manager: VaultManager | null = stubManager()): MemoryScreenApi {
  return new MemoryScreenApi({ isEnabled: () => enabled, userDataDir: userData(), getManager: () => manager })
}

describe('MemoryScreenApi', () => {
  it('fails closed while disabled: no file, no manager touch', async () => {
    const dir = userData()
    let managerTouched = false
    const api = new MemoryScreenApi({
      isEnabled: () => false,
      userDataDir: dir,
      getManager: () => {
        managerTouched = true
        return stubManager()
      },
    })
    try {
      // status() reports disabled (it does not throw — contract).
      expect(api.status()).toEqual({ enabled: false, ready: false })
      expect(() => api.reviewList()).toThrow(/disabled/)
      await expect(api.search(WS, 'q')).rejects.toThrow(/disabled/)
      await expect(api.entity(WS, `workspace:${WS}`, 'e1')).rejects.toThrow(/disabled/)
      await expect(api.history(WS, `workspace:${WS}`, 'decision', 'k')).rejects.toThrow(/disabled/)
      expect(() => api.promoteDryRun(1)).toThrow(/disabled/)
      expect(() => api.reviewDecide({ id: 1, approved: false, expectedRevision: 1 })).toThrow(/disabled/)
      expect(managerTouched).toBe(false)
      // No file created anywhere under the userData dir while disabled.
      const { readdirSync } = await import('node:fs')
      expect(readdirSync(dir)).toEqual([])
    } finally {
      api.close()
    }
  })

  it('searches dense-only through per-call sessions', async () => {
    const api = setup()
    try {
      const res = (await api.search(WS, 'navmesh', 5)) as {
        items: Array<{ item: { id: string } }>
        partial: boolean
      }
      expect(res.items).toHaveLength(1)
      expect(res.items[0].item.id).toBe('e1')
      expect(res.partial).toBe(false)
      const entity = (await api.entity(WS, `workspace:${WS}`, 'e1')) as { id: string }
      expect(entity.id).toBe('e1')
      const history = (await api.history(WS, `workspace:${WS}`, 'decision', 'k-e1')) as {
        versions: Array<{ v: number }>
      }
      expect(history.versions).toHaveLength(1)
    } finally {
      api.close()
    }
  })

  it('browse reports noStore without creating the DB file', async () => {
    const { existsSync } = await import('node:fs')
    const dir = userData()
    const api = new MemoryScreenApi({ isEnabled: () => true, userDataDir: dir, getManager: () => stubManager() })
    try {
      const res = (await api.browse(WS, { db: 'workspace' })) as {
        db: string
        noStore: boolean
        items: unknown[]
        total: number | null
      }
      expect(res.db).toBe(`workspace:${WS}`)
      expect(res.noStore).toBe(true)
      expect(res.items).toEqual([])
      expect(res.total).toBeNull()
      // Browse never creates the store as a side effect.
      expect(existsSync(join(dir, 'vault', 'workspaces', `${WS.toLowerCase()}.db`))).toBe(false)
      await expect(api.browse(WS, { db: 'other' as 'workspace' })).rejects.toThrow(/invalid browse db/)
    } finally {
      api.close()
    }
  })

  it('browse lists the existing store through the selected DB only', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const dir = userData()
    mkdirSync(join(dir, 'vault', 'workspaces'), { recursive: true })
    writeFileSync(join(dir, 'vault', 'workspaces', `${WS.toLowerCase()}.db`), 'stub')
    const api = new MemoryScreenApi({ isEnabled: () => true, userDataDir: dir, getManager: () => stubManager() })
    try {
      const res = (await api.browse(WS, { db: 'workspace', limit: 10 })) as {
        db: string
        noStore: boolean
        items: Array<{ id: string }>
        total: number | null
        missing: unknown
      }
      expect(res.db).toBe(`workspace:${WS}`)
      expect(res.noStore).toBe(false)
      expect(res.items.map((m) => m.id)).toEqual(['e1'])
      expect(res.total).toBe(1)
      expect(res.missing).toBeNull()
    } finally {
      api.close()
    }
  })

  it('browse chains backend pages and reports the real total', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const dir = userData()
    mkdirSync(join(dir, 'vault', 'workspaces'), { recursive: true })
    writeFileSync(join(dir, 'vault', 'workspaces', `${WS.toLowerCase()}.db`), 'stub')
    let pages = 0
    const manager = {
      callIfReady: async () => {
        pages += 1
        if (pages === 1) {
          return { items: [{ id: 'e1' }], total: 1, has_more: true, next_cursor: 'c1' }
        }
        return { items: [{ id: 'e2' }], total: 1, has_more: false, next_cursor: null }
      },
      ensureWorkspace: async () => undefined,
      ensureGlobal: async () => undefined,
      bootExisting: async () => undefined,
    } as unknown as VaultManager
    const api = new MemoryScreenApi({ isEnabled: () => true, userDataDir: dir, getManager: () => manager })
    try {
      const res = (await api.browse(WS, { db: 'workspace', limit: 1 })) as {
        items: Array<{ id: string }>
        total: number
        hasMore: boolean
      }
      // Backend totals are page counts (1 each); the screenApi chained.
      expect(res.items.map((m) => m.id)).toEqual(['e1', 'e2'])
      expect(res.total).toBe(2)
      expect(res.hasMore).toBe(false)
      expect(pages).toBe(2)
    } finally {
      api.close()
    }
  })

  it('browse reports unknown total on cap, repeat cursor and follow error', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const setupApi = (serve: () => Promise<unknown>): { api: MemoryScreenApi; dir: string } => {
      const dir = userData()
      mkdirSync(join(dir, 'vault', 'workspaces'), { recursive: true })
      writeFileSync(join(dir, 'vault', 'workspaces', `${WS.toLowerCase()}.db`), 'stub')
      const manager = {
        callIfReady: serve,
        bootExisting: async () => undefined,
      } as unknown as VaultManager
      return { api: new MemoryScreenApi({ isEnabled: () => true, userDataDir: dir, getManager: () => manager }), dir }
    }
    // Cap: backend always has more — stops after 10 pages, total unknown.
    {
      let n = 0
      const { api } = setupApi(async () => {
        n += 1
        return { items: [{ id: `e${n}` }], total: 1, has_more: true, next_cursor: `c${n}` }
      })
      try {
        const res = (await api.browse(WS, { db: 'workspace' })) as {
          items: unknown[]
          total: number | null
          hasMore: boolean
          missing: unknown
        }
        expect(n).toBe(10)
        expect(res.items).toHaveLength(10)
        expect(res.total).toBeNull()
        expect(res.hasMore).toBe(true)
      } finally {
        api.close()
      }
    }
    // Repeat cursor: no infinite loop, total unknown.
    {
      const { api } = setupApi(async () => ({ items: [{ id: 'e1' }], total: 1, has_more: true, next_cursor: 'same' }))
      try {
        const res = (await api.browse(WS, { db: 'workspace', cursor: 'same' })) as {
          total: number | null
          hasMore: boolean
          missing: { reason: string } | null
        }
        expect(res.total).toBeNull()
        expect(res.hasMore).toBe(true)
        expect(res.missing?.reason).toMatch(/did not advance/)
      } finally {
        api.close()
      }
    }
    // Follow error: keeps the loaded page, total unknown, missing set.
    {
      let n = 0
      const { api } = setupApi(async () => {
        n += 1
        if (n === 1) return { items: [{ id: 'e1' }], total: 1, has_more: true, next_cursor: 'c1' }
        throw new Error('page lost')
      })
      try {
        const res = (await api.browse(WS, { db: 'workspace' })) as {
          items: Array<{ id: string }>
          total: number | null
          missing: { reason: string } | null
        }
        expect(res.items.map((m) => m.id)).toEqual(['e1'])
        expect(res.total).toBeNull()
        expect(res.missing?.reason).toMatch(/page lost/)
      } finally {
        api.close()
      }
    }
    // Resume (input.cursor): remainder listed, total stays unknown.
    {
      let n = 0
      const { api } = setupApi(async () => {
        n += 1
        if (n === 1) return { items: [{ id: 'e2' }], total: 1, has_more: true, next_cursor: 'c2' }
        return { items: [{ id: 'e3' }], total: 1, has_more: false, next_cursor: null }
      })
      try {
        const res = (await api.browse(WS, { db: 'workspace', cursor: 'c1' })) as {
          items: Array<{ id: string }>
          total: number | null
          hasMore: boolean
        }
        expect(res.items.map((m) => m.id)).toEqual(['e2', 'e3'])
        expect(res.total).toBeNull()
        expect(res.hasMore).toBe(false)
      } finally {
        api.close()
      }
    }
  })

  it('onDisabled aborts an in-flight shadow run before capture', async () => {
    let releaseRecall!: (v: unknown) => void
    const recallGate = new Promise<unknown>((res) => {
      releaseRecall = res
    })
    const tools: string[] = []
    const manager = {
      call: async (_db: string, tool: string) => {
        tools.push(tool)
        if (tool === 'perseus_vault_recall_when') return recallGate
        throw new Error(`must never reach ${tool}`)
      },
    } as unknown as VaultManager
    const api = setup(true, manager)
    try {
      const pending = api.runShadow({ workspaceId: WS, workspaceName: 'demo', hookEvent: 'Stop' })
      api.onDisabled()
      releaseRecall({ items: [] })
      await expect(pending).rejects.toThrow(/disabled|superseded|revoked|unknown memory session/)
      expect(tools).toEqual(['perseus_vault_recall_when', 'perseus_vault_recall_when'])
    } finally {
      api.close()
    }
  })
  it('close is irreversible and aborts in-flight RPCs', async () => {
    let release!: (v: unknown) => void
    const gate = new Promise<unknown>((res) => {
      release = res
    })
    const manager = {
      call: async () => gate,
    } as unknown as VaultManager
    const api = new MemoryScreenApi({ isEnabled: () => true, userDataDir: userData(), getManager: () => manager })
    const internals = api as unknown as { sessions: { size: number } }
    try {
      const pending = api.search(WS, 'closing')
      expect(internals.sessions.size).toBe(1)
      api.close()
      release({ items: [] })
      await expect(pending).rejects.toThrow(/closed|revoked|unknown memory session/)
      expect(internals.sessions.size).toBe(0)
      // Every later call fails closed, even though the flag is still on.
      await expect(api.search(WS, 'q')).rejects.toThrow(/closed/)
      await expect(api.entity(WS, `workspace:${WS}`, 'e1')).rejects.toThrow(/closed/)
      await expect(api.history(WS, `workspace:${WS}`, 'decision', 'k')).rejects.toThrow(/closed/)
      expect(() => api.reviewList()).toThrow(/closed/)
      expect(() => api.reviewDecide({ id: 1, approved: false, expectedRevision: 1 })).toThrow(/closed/)
      expect(() => api.promoteDryRun(1)).toThrow(/closed/)
      expect(api.status()).toEqual({ enabled: true, ready: true })
    } finally {
      api.close() // idempotent
    }
  })
  it('disable mid-RPC revokes the session and drops the answer', async () => {
    let enabled = true
    let release!: (v: unknown) => void
    const gate = new Promise<unknown>((res) => {
      release = res
    })
    const manager = {
      call: async () => gate,
    } as unknown as VaultManager
    const api = new MemoryScreenApi({ isEnabled: () => enabled, userDataDir: userData(), getManager: () => manager })
    const internals = api as unknown as { sessions: { size: number } }
    try {
      const pending = api.search(WS, 'mid-flight')
      expect(internals.sessions.size).toBe(1)
      enabled = false
      api.onDisabled() // settingsUpdate wiring calls exactly this
      release({ items: [{ id: 'late', category: 'decision', key: 'k', content: 'must never arrive' }] })
      await expect(pending).rejects.toThrow(/disabled|revoked|unknown memory session|kill-switch/)
      expect(internals.sessions.size).toBe(0)
    } finally {
      api.close()
    }
  })

  it('failed RPCs leave no sessions behind', async () => {
    const manager = {
      call: async () => {
        throw new Error('backend down')
      },
    } as unknown as VaultManager
    const api = new MemoryScreenApi({ isEnabled: () => true, userDataDir: userData(), getManager: () => manager })
    const internals = api as unknown as { sessions: { size: number } }
    try {
      const res = (await api.search(WS, 'q')) as { partial: boolean; missing: Array<{ reason: string }> }
      expect(res.partial).toBe(true)
      expect(res.missing[0].reason).toMatch(/backend down/)
      expect(internals.sessions.size).toBe(0)
      await expect(api.entity(WS, `workspace:${WS}`, 'e1')).rejects.toThrow(/backend down/)
      expect(internals.sessions.size).toBe(0)
    } finally {
      api.close()
    }
  })

  it('screen reads never issue vault writes', async () => {
    const tools: string[] = []
    const manager = {
      call: async (_db: string, tool: string) => {
        tools.push(tool)
        if (tool === 'perseus_vault_recall') {
          return { items: [{ id: 'e1', category: 'decision', key: 'k-e1', content: 'fact' }] }
        }
        if (tool === 'perseus_vault_get_entity') return { id: 'e1' }
        if (tool === 'perseus_vault_history') return { versions: [] }
        throw new Error(`unexpected tool ${tool}`)
      },
    } as unknown as VaultManager
    const api = new MemoryScreenApi({ isEnabled: () => true, userDataDir: userData(), getManager: () => manager })
    try {
      await api.search(WS, 'q')
      await api.entity(WS, `workspace:${WS}`, 'e1')
      await api.history(WS, `workspace:${WS}`, 'decision', 'k-e1')
      const store = (api as unknown as { reviews: () => { submit: (c: AdmissionCandidate, v: unknown) => number } }).reviews()
      const id = store.submit(candidate(), reviewVerdict)
      api.reviewList()
      api.reviewDecide({ id, approved: false, expectedRevision: 1 })
      expect(tools.length).toBeGreaterThan(0)
      for (const tool of tools) {
        expect(['perseus_vault_recall', 'perseus_vault_get_entity', 'perseus_vault_history']).toContain(tool)
      }
    } finally {
      api.close()
    }
  })
  it('reports not-ready without a manager', async () => {
    const api = setup(true, null)
    try {
      expect(api.status()).toEqual({ enabled: true, ready: false })
      await expect(api.search(WS, 'q')).rejects.toThrow(/not ready/)
    } finally {
      api.close()
    }
  })

  it('rejects review candidates in the isolated queue', () => {
    const api = setup()
    try {
      const store = (api as unknown as { reviews: () => { submit: (c: AdmissionCandidate, v: unknown) => number } }).reviews()
      const id = store.submit(candidate(), reviewVerdict)
      const list = api.reviewList()
      expect(list.queued).toHaveLength(1)
      expect(list.counts.queued).toBe(1)
      const decided = api.reviewDecide({ id, approved: false, expectedRevision: 1 })
      expect(decided?.statusState).toBe('rejected')
      expect(api.reviewList().queued).toHaveLength(0)
    } finally {
      api.close()
    }
  })

  it('approves clean candidates and previews promotion as dry-run only', () => {
    const api = setup()
    try {
      const store = (api as unknown as { reviews: () => { submit: (c: AdmissionCandidate, v: unknown) => number } }).reviews()
      const id = store.submit(candidate({ key: 'clean-key' }), reviewVerdict)
      const decided = api.reviewDecide({ id, approved: true, expectedRevision: 1 })
      expect(decided?.statusState).toBe('approved')
      const preview = api.promoteDryRun(id)
      expect(preview.dryRun).toBe(true)
      expect(preview.targetDb).toBe(`workspace:${WS}`)
      expect(preview.key).toBe('clean-key')
    } finally {
      api.close()
    }
  })

  it('dry-run refuses non-approved candidates', () => {
    const api = setup()
    try {
      const store = (api as unknown as { reviews: () => { submit: (c: AdmissionCandidate, v: unknown) => number } }).reviews()
      const id = store.submit(candidate({ key: 'pending-key' }), reviewVerdict)
      expect(() => api.promoteDryRun(id)).toThrow(/only approved/)
    } finally {
      api.close()
    }
  })

  it('promotes approved candidates through broker and records verified audit', async () => {
    let writeCalled = false
    const customManager = {
      call: async (_db: string, tool: string) => {
        if (tool === 'perseus_vault_history') return { versions: [{ category: 'decision', key: 'prom-key' }], total: 1 }
        return { items: [], total: 0, has_more: false, next_cursor: null }
      },
      callIfReady: async (_db: string, _tool: string) => ({ items: [], total: 0, has_more: false, next_cursor: null }),
      bootExisting: async () => undefined,
      withDbLock: async (_db: string, fn: () => Promise<unknown>) => fn(),
      withWriteTransaction: async (_db: string, fn: (writer: (args: unknown) => Promise<void>) => Promise<unknown>) =>
        fn(async () => {
          writeCalled = true
        }),
      executeWrite: async () => {
        writeCalled = true
      },
    } as unknown as VaultManager
    process.env.ITTOP_ALLOW_LIVE_PROMOTION = 'true'
    const api = setup(true, customManager)
    try {
      const store = (api as unknown as { reviews: () => { submit: (c: AdmissionCandidate, v: unknown) => number; get: (id: number) => { statusState: string } } }).reviews()
      const id = store.submit(candidate({ key: 'prom-key' }), reviewVerdict)
      api.reviewDecide({ id, approved: true, expectedRevision: 1 })
      const res = await api.promote(id, 1)
      expect(res.ok).toBe(true)
      expect(res.status).toBe('verified')
      expect(writeCalled).toBe(true)
      expect(store.get(id).statusState).toBe('promoted')

      // Idempotent duplicate re-promotion
      const res2 = await api.promote(id, 1)
      expect(res2.ok).toBe(true)
      expect(res2.status).toBe('verified')
    } finally {
      delete process.env.ITTOP_ALLOW_LIVE_PROMOTION
      api.close()
    }
  })

  it('promote rejects revision mismatch or non-approved candidates', async () => {
    const api = setup()
    try {
      const store = (api as unknown as { reviews: () => { submit: (c: AdmissionCandidate, v: unknown) => number } }).reviews()
      const id = store.submit(candidate({ key: 'rev-key' }), reviewVerdict)
      await expect(api.promote(id, 1)).rejects.toThrow(/only approved/)
      api.reviewDecide({ id, approved: true, expectedRevision: 1 })
      await expect(api.promote(id, 2)).rejects.toThrow(/revision mismatch/)
    } finally {
      api.close()
    }
  })
})
