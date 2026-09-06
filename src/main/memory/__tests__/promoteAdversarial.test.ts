import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryBroker } from '../broker'
import { SessionRegistry } from '../capabilities'
import { ReviewStore } from '../reviewStore'
import { VaultManager } from '../vaultManager'
import type { AdmissionCandidate } from '../admission'

const WS = '33333333-3333-4333-8333-333333333333'
const activeStores: ReviewStore[] = []
const dirs: string[] = []

afterEach(() => {
  while (activeStores.length > 0) {
    try { activeStores.pop()?.close() } catch {}
  }
  while (dirs.length > 0) {
    try { rmSync(dirs.pop() as string, { recursive: true, force: true }) } catch {}
  }
})

function tempStore(): { file: string; store: ReviewStore } {
  const dir = mkdtempSync(join(tmpdir(), 'ittop-adv-'))
  dirs.push(dir)
  const file = join(dir, 'review.db')
  const store = new ReviewStore({ file })
  activeStores.push(store)
  return { file, store }
}

function candidate(over: Partial<AdmissionCandidate> = {}): AdmissionCandidate {
  return {
    db: `workspace:${WS}`,
    category: 'decision',
    key: 'adv-key',
    content: 'valid adversarial test content with enough detail for admission',
    futureUse: 'used for adversarial tests in the test suite',
    triggers: ['when debugging adversarial tests in phase7', 'when testing promote error handling'],
    evidence: { sourceRef: 'adv-test' },
    ...over,
  }
}

const passRecheck = () => ({ decision: 'approve' as const, score: 1.0, reasons: [] })

describe('Promote Adversarial & Safety Gates (Phase 7b)', () => {
  it('serializes concurrent promotions on real VaultManager without deadlock, proving maxConcurrentWrites = 1', async () => {
    const { store } = tempStore()
    const sessions = new SessionRegistry()
    const handle = sessions.open(WS, {
      purpose: 'screen_promote',
      mayPromote: true,
      mayWriteWorkspace: true,
    })

    let inFlightWrites = 0
    let maxConcurrentWrites = 0

    const managerDir = mkdtempSync(join(tmpdir(), 'ittop-mgr-'))
    dirs.push(managerDir)

    const manager = new VaultManager({
      userDataDir: managerDir,
      binaryPath: 'bin',
      initDb: () => Promise.resolve(),
      createClient: (paths, _onExit) => ({
        running: true,
        pid: 1234,
        start: async () => {},
        stop: async () => {},
        call: async (tool, args) => {
          if (tool === 'perseus_vault_history') {
            return { versions: [{ category: 'decision', key: args.key }], total: 1 }
          }
          if (tool === 'perseus_vault_health') {
            return { status: 'healthy', db_path: paths.dbFile }
          }
          return { items: [], total: 0, has_more: false, next_cursor: null }
        },
      }),
      cliWrite: async (_paths, _args) => {
        inFlightWrites += 1
        maxConcurrentWrites = Math.max(maxConcurrentWrites, inFlightWrites)
        await new Promise((r) => setTimeout(r, 20))
        inFlightWrites -= 1
      },
    })

    const broker = new MemoryBroker(manager, sessions, { allowLiveWrites: true })
    broker.browse = async () => ({
      evaluatedAt: '',
      perDb: [{ db: `workspace:${WS}`, items: [], total: 0, hasMore: false, nextCursor: null, missing: null }],
      partial: false,
    })

    const id1 = store.submit(candidate({ key: 'k1' }), { decision: 'review', score: 0.8, reasons: [] })
    const id2 = store.submit(candidate({ key: 'k2' }), { decision: 'review', score: 0.8, reasons: [] })
    store.decide(id1, 'approved', { expectedRevision: 1, recheck: passRecheck })
    store.decide(id2, 'approved', { expectedRevision: 1, recheck: passRecheck })

    const cand1 = store.get(id1)!
    const cand2 = store.get(id2)!

    // Parallel dispatch: proves NO deadlock and strict serialization
    const [res1, res2] = await Promise.all([
      broker.promote(handle, cand1, store),
      broker.promote(handle, cand2, store),
    ])

    expect(res1.ok).toBe(true)
    expect(res2.ok).toBe(true)
    expect(maxConcurrentWrites).toBe(1) // Exactly 1 write at a time
    expect(store.get(id1)?.statusState).toBe('promoted')
    expect(store.get(id2)?.statusState).toBe('promoted')
    await manager.stopAll()
  })

  it('hard-blocks writes when allowLiveWrites is false and env gate is missing', async () => {
    const { store } = tempStore()
    const sessions = new SessionRegistry()
    const handle = sessions.open(WS, {
      purpose: 'screen_promote',
      mayPromote: true,
      mayWriteWorkspace: true,
    })

    const managerDir = mkdtempSync(join(tmpdir(), 'ittop-mgr-'))
    dirs.push(managerDir)
    const manager = new VaultManager({
      userDataDir: managerDir,
      binaryPath: 'bin',
      initDb: () => Promise.resolve(),
    })

    const broker = new MemoryBroker(manager, sessions, { allowLiveWrites: false })
    const id = store.submit(candidate({ key: 'locked-key' }), { decision: 'review', score: 0.8, reasons: [] })
    store.decide(id, 'approved', { expectedRevision: 1, recheck: passRecheck })
    const cand = store.get(id)!

    await expect(broker.promote(handle, cand, store)).rejects.toThrow(/locked in this phase/)
    await manager.stopAll()
  })

  it('rejects promotions when live scan reports invalid or repeated cursors', async () => {
    const { store } = tempStore()
    const sessions = new SessionRegistry()
    const handle = sessions.open(WS, {
      purpose: 'screen_promote',
      mayPromote: true,
      mayWriteWorkspace: true,
    })

    const managerDir = mkdtempSync(join(tmpdir(), 'ittop-mgr-'))
    dirs.push(managerDir)
    const manager = new VaultManager({
      userDataDir: managerDir,
      binaryPath: 'bin',
      initDb: () => Promise.resolve(),
    })

    const broker = new MemoryBroker(manager, sessions, { allowLiveWrites: true })
    broker.browse = async () => ({
      evaluatedAt: '',
      perDb: [{
        db: `workspace:${WS}`,
        items: [],
        total: 100,
        hasMore: true,
        nextCursor: 'repeated-cursor',
        missing: null,
      }],
      partial: false,
    })

    const id = store.submit(candidate({ key: 'page-key' }), { decision: 'review', score: 0.8, reasons: [] })
    store.decide(id, 'approved', { expectedRevision: 1, recheck: passRecheck })
    const cand = store.get(id)!

    await expect(broker.promote(handle, cand, store)).rejects.toThrow(/invalid or repeated cursor/)
    await manager.stopAll()
  })

  it('aborts when live scan reveals a conflicting key without audited override', async () => {
    const { store } = tempStore()
    const sessions = new SessionRegistry()
    const handle = sessions.open(WS, {
      purpose: 'screen_promote',
      mayPromote: true,
      mayWriteWorkspace: true,
    })

    let writeExecuted = false
    const managerDir = mkdtempSync(join(tmpdir(), 'ittop-mgr-'))
    dirs.push(managerDir)
    const manager = new VaultManager({
      userDataDir: managerDir,
      binaryPath: 'bin',
      initDb: () => Promise.resolve(),
      cliWrite: async () => {
        writeExecuted = true
      },
    })

    const broker = new MemoryBroker(manager, sessions, { allowLiveWrites: true })
    broker.browse = async () => ({
      evaluatedAt: '',
      perDb: [{
        db: `workspace:${WS}`,
        items: [{ id: 'i1', key: 'conflict-key', content: 'different live content' } as unknown as import('../broker').RecallItemWire],
        total: 1,
        hasMore: false,
        nextCursor: null,
        missing: null,
      }],
      partial: false,
    })

    const id = store.submit(candidate({ key: 'conflict-key' }), { decision: 'review', score: 0.8, reasons: [] })
    store.decide(id, 'approved', { expectedRevision: 1, recheck: passRecheck })
    const cand = store.get(id)!

    await expect(broker.promote(handle, cand, store)).rejects.toThrow(/requires audited human override/)
    expect(writeExecuted).toBe(false)
    expect(store.getPromotion(`${id}:1:workspace:${WS}`)?.status).toBe('failed')
    await manager.stopAll()
  })

  it('marks indeterminate and throws when readback verification finds no matching entity', async () => {
    const { store } = tempStore()
    const sessions = new SessionRegistry()
    const handle = sessions.open(WS, {
      purpose: 'screen_promote',
      mayPromote: true,
      mayWriteWorkspace: true,
    })

    let writeExecuted = false
    const managerDir = mkdtempSync(join(tmpdir(), 'ittop-mgr-'))
    dirs.push(managerDir)
    const manager = new VaultManager({
      userDataDir: managerDir,
      binaryPath: 'bin',
      initDb: () => Promise.resolve(),
      createClient: (paths, _onExit) => ({
        running: true,
        pid: 1234,
        start: async () => {},
        stop: async () => {},
        call: async (tool) => {
          if (tool === 'perseus_vault_health') return { status: 'healthy', db_path: paths.dbFile }
          return { items: [], total: 0, has_more: false, next_cursor: null }
        },
      }),
      cliWrite: async () => {
        writeExecuted = true
      },
    })

    const broker = new MemoryBroker(manager, sessions, { allowLiveWrites: true })
    broker.browse = async () => ({
      evaluatedAt: '',
      perDb: [{ db: `workspace:${WS}`, items: [], total: 0, hasMore: false, nextCursor: null, missing: null }],
      partial: false,
    })
    // History returns versions for a DIFFERENT key on readback
    broker.history = async () => ({ versions: [{ category: 'decision', key: 'other-key' }], total: 1 })

    const id = store.submit(candidate({ key: 'phantom-key' }), { decision: 'review', score: 0.8, reasons: [] })
    store.decide(id, 'approved', { expectedRevision: 1, recheck: passRecheck })
    const cand = store.get(id)!

    await expect(broker.promote(handle, cand, store)).rejects.toThrow(/readback verification found no matching entity/)
    expect(writeExecuted).toBe(true)
    const prom = store.getPromotion(`${id}:1:workspace:${WS}`)
    expect(prom?.status).toBe('indeterminate')
    expect(store.get(id)?.statusState).toBe('approved')
    await manager.stopAll()
  })
})
