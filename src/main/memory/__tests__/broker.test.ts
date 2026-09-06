import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MemoryBroker } from '../broker'
import { SessionRegistry } from '../capabilities'
import { VaultManager, type VaultProcess } from '../vaultManager'

const WS = '11111111-1111-4111-8111-111111111111'
const WS2 = '22222222-2222-4222-8222-222222222222'
const WDB = `workspace:${WS}`
const W2DB = `workspace:${WS2}`

interface Call {
  db: string
  tool: string
  args: Record<string, unknown>
}

type Behavior = (call: Call) => unknown

function stubManager(behavior: Behavior, calls: Call[]): VaultManager {
  return {
    call: async (db: string, tool: string, args: Record<string, unknown>) => {
      const call = { db, tool, args }
      calls.push(call)
      // The stub honors backend limits like the real server (caps candidates).
      const res = behavior(call)
      if (res instanceof Error) throw res
      const typed = res as { items?: Array<{ id: string }> }
      if (Array.isArray(typed?.items) && typeof args.limit === 'number') {
        return { ...typed, items: typed.items.slice(0, args.limit) }
      }
      return res
    },
    // Browse path never ensures: same stub, separate method like the real manager.
    callIfReady: async (db: string, tool: string, args: Record<string, unknown>) => {
      const call = { db, tool, args }
      calls.push(call)
      const res = behavior(call)
      if (res instanceof Error) throw res
      return res
    },
  } as unknown as VaultManager
}

function items(...ids: string[]): { items: Array<{ id: string; content: string; category: string; key: string }> } {
  return { items: ids.map((id) => ({ id, content: `body ${id}`, category: 'decision', key: `k-${id}` })) }
}

function setup(behavior: Behavior, calls: Call[] = []): { broker: MemoryBroker; sessions: SessionRegistry } {
  const sessions = new SessionRegistry()
  return { broker: new MemoryBroker(stubManager(behavior, calls), sessions), sessions }
}

describe('MemoryBroker', () => {
  it('fans out to exactly the default scope with read-hygiene args', async () => {
    const calls: Call[] = []
    const { broker, sessions } = setup((c) => {
      if (c.db === WDB) return items('w1', 'w2')
      return items('g1')
    }, calls)
    const h = sessions.open(WS, {})
    const res = await broker.recall(h, { query: 'q', limit: 5 })
    expect(res.partial).toBe(false)
    expect(res.missing).toEqual([])
    expect(res.completeEmpty).toBe(false)
    expect(res.hasMore).toBe(false)
    expect(res.mergeContract).toBe(1)
    expect(typeof res.evaluatedAt).toBe('string')
    expect(res.items.map((m) => m.item.id)).toEqual(['w1', 'w2', 'g1'])
    expect(calls).toHaveLength(2)
    for (const c of calls) {
      expect(c.tool).toBe('perseus_vault_recall')
      expect(c.args.reinforce).toBe(false)
      expect(c.args).not.toHaveProperty('derived_from')
    }
    const byDb = new Map(calls.map((c) => [c.db, c.args]))
    expect(byDb.get(WDB)?.workspace_hash).toBe(WS) // bare uuid
    expect(byDb.get('global')?.workspace_hash).toBe('') // global lives at ''
  })

  it('queries granted extras only via explicit selected scope', async () => {
    const calls: Call[] = []
    const { broker, sessions } = setup(() => items('x'), calls)
    const h = sessions.open(WS, { extraWorkspaceIds: [WS2] })
    await broker.recall(h, { query: 'q' })
    expect(calls.map((c) => c.db).sort()).toEqual([WDB, 'global'].sort())
    calls.length = 0
    await broker.recall(h, { query: 'q' }, { scope: [W2DB] })
    expect(calls.map((c) => c.db)).toEqual([W2DB])
    await expect(broker.recall(h, { query: 'q' }, { scope: ['workspace:unknown' as string] })).rejects.toThrow(
      /may not select/,
    )
  })

  it('never queries DBs outside the capability', async () => {
    const calls: Call[] = []
    const { broker, sessions } = setup(() => items('x'), calls)
    const h = sessions.open(WS, {})
    await expect(broker.getEntity(h, W2DB, 'id')).rejects.toThrow(/may not read/)
    await expect(broker.history(h, W2DB, 'c', 'k')).rejects.toThrow(/may not read/)
    await expect(broker.getEntity('sess_nope', WDB, 'id')).rejects.toThrow(/unknown memory session/)
    expect(calls).toHaveLength(0)
  })

  it('reports partial results with missing DBs instead of failing', async () => {
    const { broker, sessions } = setup((c) => {
      if (c.db === WDB) throw new Error('timeout')
      return items('g1')
    })
    const res = await broker.recall(sessions.open(WS, {}), { query: 'q' })
    expect(res.partial).toBe(true)
    expect(res.missing).toEqual([{ db: WDB, reason: 'timeout' }])
    expect(res.completeEmpty).toBe(false)
    expect(res.items.map((m) => m.item.id)).toEqual(['g1'])
  })

  it('treats backend-reported incompleteness and malformed bodies as missing', async () => {
    const { broker, sessions } = setup((c) => {
      if (c.db === WDB) return { items: items('w1').items, outcome: { status: 'timeout' } }
      return { nope: true }
    })
    const res = await broker.recall(sessions.open(WS, {}), { query: 'q' })
    expect(res.partial).toBe(true)
    expect(res.items).toEqual([])
    expect(res.completeEmpty).toBe(false)
    expect(res.missing.map((m) => m.db).sort()).toEqual([WDB, 'global'].sort())
    expect(res.missing.find((m) => m.db === WDB)?.reason).toMatch(/timeout/)
    expect(res.missing.find((m) => m.db === 'global')?.reason).toMatch(/malformed/)
  })

  it('distinguishes total outage from complete emptiness', async () => {
    const downSessions = new SessionRegistry()
    const down = new MemoryBroker(
      stubManager(() => {
        throw new Error('down')
      }, []),
      downSessions,
    )
    const empty = await down.recall(downSessions.open(WS, {}), { query: 'q' })
    expect(empty.partial).toBe(true)
    expect(empty.completeEmpty).toBe(false)
    expect(empty.items).toEqual([])

    const hollowSessions = new SessionRegistry()
    const hollow = new MemoryBroker(stubManager(() => ({ items: [] }), []), hollowSessions)
    const full = await hollow.recall(hollowSessions.open(WS, {}), { query: 'q' })
    expect(full.partial).toBe(false)
    expect(full.completeEmpty).toBe(true)
  })

  it('rejects everything for revoked and unknown sessions', async () => {
    const spy = vi.fn()
    const sessions = new SessionRegistry()
    const broker = new MemoryBroker(stubManager(spy, []), sessions)
    const h = sessions.open(WS, {})
    sessions.revoke(h)
    await expect(broker.recall(h, { query: 'q' })).rejects.toThrow(/revoked/)
    await expect(broker.recallWhen(h, 'ctx')).rejects.toThrow(/revoked/)
    await expect(broker.getEntity(h, WDB, 'id')).rejects.toThrow(/revoked/)
    await expect(broker.recall('sess_nope', { query: 'q' })).rejects.toThrow(/unknown memory session/)
    expect(spy).not.toHaveBeenCalled()
  })

  it('drops late answers after mid-flight revocation', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const sessions = new SessionRegistry()
    const broker = new MemoryBroker(
      stubManager(async () => {
        await gate
        return items('late')
      }, []),
      sessions,
    )
    const h = sessions.open(WS, {})
    const pending = broker.recall(h, { query: 'q' })
    const denied = expect(pending).rejects.toThrow(/revoked/)
    sessions.revoke(h)
    release()
    await denied
  })

  const guardedMethods: Record<string, { tool: string; run: (b: MemoryBroker, h: string) => Promise<unknown> }> = {
    recall: { tool: 'perseus_vault_recall', run: (b, h) => b.recall(h, { query: 'q' }) },
    recallWhen: { tool: 'perseus_vault_recall_when', run: (b, h) => b.recallWhen(h, 'ctx') },
    getEntity: {
      tool: 'perseus_vault_get_entity',
      run: (b, h) => b.getEntity(h, `workspace:${WS}`, 'e1'),
    },
    history: {
      tool: 'perseus_vault_history',
      run: (b, h) => b.history(h, `workspace:${WS}`, 'decision', 'k'),
    },
  }
  for (const [name, method] of Object.entries(guardedMethods)) {
    for (const ending of ['revoke', 'close'] as const) {
      it(`post-ensure guard blocks ${name} after session ${ending} (zero data dispatches)`, async () => {
        let release!: () => void
        const gate = new Promise<void>((r) => {
          release = r
        })
        const dispatches: Call[] = []
        const sessions = new SessionRegistry()
        const manager = new VaultManager({
          userDataDir: resolve('test-ud-guard'),
          binaryPath: 'bin',
          initDb: () => gate,
          createClient: (paths, onExit) => {
            void onExit
            return {
              running: true,
              async start() {
                // fake starting
              },
              async call(tool: string, args: Record<string, unknown>) {
                dispatches.push({ db: paths.dbFile, tool, args })
                return { status: 'healthy', db_path: paths.dbFile }
              },
              async stop() {
                // fake stopping
              },
            } as unknown as VaultProcess
          },
        })
        const broker = new MemoryBroker(manager, sessions)
        const h = sessions.open(WS, {})
        const pending = method.run(broker, h)
        const denied =
          ending === 'revoke'
            ? expect(pending).rejects.toThrow(/revoked/)
            : expect(pending).rejects.toThrow(/unknown/)
        if (ending === 'revoke') sessions.revoke(h)
        else sessions.close(h) // also clears the revoked set: resolve must still fail
        release()
        await denied
        expect(dispatches.filter((d) => d.tool === method.tool)).toEqual([])
        await manager.stopAll()
      })
    }
  }

  it('flags hasMore when small pages jointly overflow maxTotal', async () => {
    const { broker, sessions } = setup((c) => {
      if (c.db === WDB) return items('w1', 'w2')
      return items('g1')
    })
    const res = await broker.recall(sessions.open(WS, {}), { query: 'q' }, { perDbLimit: 10, maxTotal: 2 })
    expect(res.items.map((m) => m.item.id)).toEqual(['w1', 'w2'])
    expect(res.hasMore).toBe(true) // 2+1 candidates > maxTotal 2
    expect(res.partial).toBe(false)
  })

  it('paginates deterministically over a bounded window with hasMore', async () => {
    const { broker, sessions } = setup((c) => {
      if (c.db === WDB) return items('w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 'w10', 'w11', 'w12')
      return items('g1', 'g2')
    })
    const h = sessions.open(WS, {})
    // Backend page edge (12 > perDb 10) → hasMore even though merged fits.
    const full = await broker.recall(h, { query: 'q' }, { perDbLimit: 10, maxTotal: 30 })
    expect(full.items).toHaveLength(12)
    expect(full.hasMore).toBe(true)
    const p1 = await broker.recall(h, { query: 'q' }, { perDbLimit: 10, maxTotal: 2 })
    const p2 = await broker.recall(h, { query: 'q' }, { perDbLimit: 10, maxTotal: 2, offset: 2 })
    expect(p1.items.map((m) => m.item.id)).toEqual(['w1', 'w2'])
    expect(p1.hasMore).toBe(true)
    expect(p2.items.map((m) => m.item.id)).toEqual(['w3', 'w4'])
    // Offset past the window: empty page, still bounded and honest.
    const past = await broker.recall(h, { query: 'q' }, { perDbLimit: 2, maxTotal: 2, offset: 100 })
    expect(past.items).toEqual([])
  })

  it('validates pagination numbers fail-closed', async () => {
    const { broker, sessions } = setup(() => items('x'))
    const h = sessions.open(WS, {})
    await expect(broker.recall(h, { query: 'q' }, { perDbLimit: 0 })).rejects.toThrow(/perDbLimit/)
    await expect(broker.recall(h, { query: 'q' }, { perDbLimit: 101 })).rejects.toThrow(/perDbLimit/)
    await expect(broker.recall(h, { query: 'q' }, { maxTotal: -1 })).rejects.toThrow(/maxTotal/)
    await expect(broker.recall(h, { query: 'q' }, { offset: -2 })).rejects.toThrow(/offset/)
    await expect(broker.recall(h, { query: 'q' }, { offset: 1.5 })).rejects.toThrow(/offset/)
  })

  it('is order-stable under permuted backend answer order', async () => {
    const releases = new Map<string, () => void>()
    const sessions = new SessionRegistry()
    const broker = new MemoryBroker(
      stubManager(
        (c) =>
          new Promise((resolve) => {
            releases.set(c.db, () =>
              resolve(c.db === WDB ? items('w1') : items('g1')),
            )
          }),
        [],
      ),
      sessions,
    )
    const h = sessions.open(WS, {})
    const pending = broker.recall(h, { query: 'q' })
    await new Promise((r) => setTimeout(r, 50))
    releases.get('global')?.() // global answers FIRST…
    await new Promise((r) => setTimeout(r, 50))
    releases.get(WDB)?.() // …workspace answers last…
    const res = await pending
    expect(res.items.map((m) => m.item.id)).toEqual(['w1', 'g1']) // …order kept
  })

  it('browse scans exactly the explicit scope with read-hygiene args', async () => {
    const calls: Call[] = []
    const { broker, sessions } = setup((c) => {
      if (c.tool !== 'perseus_vault_scan') throw new Error(`wrong tool ${c.tool}`)
      return { items: items('w1', 'w2').items, total: 2, has_more: false, next_cursor: null }
    }, calls)
    const res = await broker.browse(sessions.open(WS, {}), { scope: [WDB], category: 'decision', limit: 10 })
    expect(res.partial).toBe(false)
    expect(res.perDb).toHaveLength(1)
    expect(res.perDb[0]).toMatchObject({ db: WDB, total: 2, hasMore: false, nextCursor: null, missing: null })
    expect(res.perDb[0].items.map((m) => m.id)).toEqual(['w1', 'w2'])
    expect(calls).toHaveLength(1)
    expect(calls[0].tool).toBe('perseus_vault_scan')
    expect(calls[0].args).toMatchObject({ category: 'decision', limit: 10, workspace_hash: WS })
    expect(calls[0].args).not.toHaveProperty('cursor')
  })

  it('browse rejects empty scope, ungranted DBs and bad paging input', async () => {
    const calls: Call[] = []
    const { broker, sessions } = setup(() => ({ items: [] }), calls)
    const h = sessions.open(WS, {})
    await expect(broker.browse(h, { scope: [] })).rejects.toThrow(/invalid scope/)
    await expect(broker.browse(h, { scope: [W2DB] })).rejects.toThrow(/may not select/)
    await expect(broker.browse(h, { scope: [WDB], limit: 0 })).rejects.toThrow(/invalid limit/)
    await expect(broker.browse(h, { scope: [WDB], category: '' })).rejects.toThrow(/invalid category/)
    await expect(broker.browse(h, { scope: [WDB], cursor: '' })).rejects.toThrow(/invalid cursor/)
    expect(calls).toHaveLength(0)
  })

  it('browse keeps unknown totals null and malformed bodies missing', async () => {
    const { broker, sessions } = setup((c) => {
      if (c.db === WDB) return { items: items('w1').items } // no total/has_more
      return { nope: true }
    })
    const res = await broker.browse(sessions.open(WS, {}), { scope: [WDB, 'global'] })
    expect(res.partial).toBe(true)
    const ws = res.perDb.find((p) => p.db === WDB)
    expect(ws?.total).toBeNull()
    expect(ws?.hasMore).toBe(false)
    expect(ws?.missing).toBeNull()
    const g = res.perDb.find((p) => p.db === 'global')
    expect(g?.missing?.reason).toMatch(/malformed/)
  })

  it('recallWhen fans out with the same guards', async () => {
    const calls: Call[] = []
    const { broker, sessions } = setup((c) => {
      if (c.tool !== 'perseus_vault_recall_when') throw new Error(`wrong tool ${c.tool}`)
      return c.db === WDB ? items('w1') : items('g1')
    }, calls)
    const res = await broker.recallWhen(sessions.open(WS, {}), 'some context', 5)
    expect(res.partial).toBe(false)
    expect(res.items.map((m) => m.item.id)).toEqual(['w1', 'g1'])
    for (const c of calls) {
      expect(c.args.context).toBe('some context')
      expect(c.args).not.toHaveProperty('derived_from')
    }
  })

  it('scoped detail reads pass through with capability checks', async () => {
    const calls: Call[] = []
    const { broker, sessions } = setup((c) => {
      if (c.tool === 'perseus_vault_get_entity') return { id: 'e1' }
      return { versions: [] }
    }, calls)
    const h = sessions.open(WS, {})
    await expect(broker.getEntity(h, WDB, 'e1')).resolves.toEqual({ id: 'e1' })
    await expect(broker.history(h, 'global', 'decision', 'k')).resolves.toEqual({ versions: [] })
    expect(calls.map((c) => `${c.db}:${c.tool}`)).toEqual([
      `${WDB}:perseus_vault_get_entity`,
      'global:perseus_vault_history',
    ])
  })
})
