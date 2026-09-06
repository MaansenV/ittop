import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { VaultManager, storeIdentity, storeChangedAfter, closeBaseline, type VaultProcess, type VaultProcessFactory } from '../vaultManager'
import type { VaultPaths } from '../paths'

const WS = '11111111-1111-4111-8111-111111111111'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

interface Fake extends VaultProcess {
  stopCalls: number
  runningFlag: boolean
  startGate: { promise: Promise<void>; resolve: () => void } | null
  startError: Error | null
  healthValue: unknown
  exitCb: ((code: number | null) => void) | null
  failStop: boolean
  stopGate: { promise: Promise<void>; resolve: () => void } | null
  callGate: { promise: Promise<void>; resolve: () => void } | null
  script: Array<{ gate?: { promise: Promise<void> }; value?: unknown }> | null
}

function makeFake(paths: VaultPaths, onExit: (code: number | null) => void): Fake {
  return {
    stopCalls: 0,
    runningFlag: true,
    startGate: null,
    startError: null,
    healthValue: { status: 'healthy', db_path: paths.dbFile },
    exitCb: onExit,
    failStop: false,
    stopGate: null,
    callGate: null,
    script: null,
    get running() {
      return this.runningFlag
    },
    async start() {
      if (this.startGate) await this.startGate.promise
      if (this.startError) throw this.startError
    },
    async call() {
      if (this.script && this.script.length > 0) {
        const step = this.script.shift() as { gate?: { promise: Promise<void> }; value?: unknown }
        if (step.gate) await step.gate.promise
        if (step.value !== undefined) {
          if (step.value instanceof Error) throw step.value
          return step.value
        }
      }
      if (this.callGate) await this.callGate.promise
      if (this.healthValue instanceof Error) throw this.healthValue
      return this.healthValue
    },
    async stop() {
      this.stopCalls++
      if (this.stopGate) await this.stopGate.promise
      if (this.failStop) throw new Error('stop failed')
    },
  }
}

function harness(
  opts: { manager?: Partial<ConstructorParameters<typeof VaultManager>[0]> } = {},
): { manager: VaultManager; created: Array<{ fake: Fake; paths: VaultPaths }> } {
  const created: Array<{ fake: Fake; paths: VaultPaths }> = []
  const factory: VaultProcessFactory = (paths: VaultPaths, onExit) => {
    const fake = makeFake(paths, onExit)
    created.push({ fake, paths })
    return fake
  }
  const manager = new VaultManager({
    userDataDir: resolve('test-ud'),
    binaryPath: 'bin',
    createClient: factory,
    initDb: () => Promise.resolve(),
    ...(opts.manager ?? {}),
  })
  return { manager, created }
}

describe('VaultManager', () => {
  it('starts unknown DBs as stopped and reports non-operational health', async () => {
    const { manager } = harness()
    expect(manager.stateOf('global')).toBe('stopped')
    await expect(manager.health('global')).resolves.toMatchObject({ operational: false })
  })

  it('coalesces parallel ensures into one client and reports healthy', async () => {
    const { manager, created } = harness()
    await Promise.all([manager.ensureGlobal(), manager.ensureGlobal(), manager.ensureWorkspace(WS)])
    expect(created).toHaveLength(2)
    expect(manager.stateOf('global')).toBe('ready')
    await expect(manager.health('global')).resolves.toMatchObject({ operational: true })
    await manager.stopAll()
    expect(manager.stateOf('global')).toBe('stopped')
  })

  it('backs off when the factory throws and refuses immediate retry', async () => {
    const m2 = new VaultManager({
      userDataDir: resolve('test-ud'),
      binaryPath: 'bin',
      initDb: () => Promise.resolve(),
      baseBackoffMs: 60000,
      maxBackoffMs: 60000,
      createClient: () => {
        throw new Error('factory boom')
      },
    })
    await expect(m2.ensureGlobal()).rejects.toThrow(/factory boom/)
    expect(m2.stateOf('global')).toBe('backoff')
    await expect(m2.ensureGlobal()).rejects.toThrow(/backing off/)
    await m2.stopAll()
  })

  it('stops each client exactly once, even on double stopAll', async () => {
    const { manager, created } = harness()
    await manager.ensureGlobal()
    await manager.ensureWorkspace(WS)
    await Promise.all([manager.stopAll(), manager.stopAll()])
    expect(created).toHaveLength(2)
    for (const { fake } of created) expect(fake.stopCalls).toBe(1)
  })

function waitFor(fn: () => boolean, label: string): Promise<void> {
  const end = Date.now() + 5000
  return (async (): Promise<void> => {
    while (!fn()) {
      if (Date.now() > end) throw new Error(`waitFor timed out: ${label}`)
      await new Promise((r) => setTimeout(r, 10))
    }
  })()
}

interface FakeInit extends EventEmitter {
  exitCode: number | null
  pid: number | undefined
  killCalls: number
  killResult: boolean
  exited: boolean
  kill: (signal?: NodeJS.Signals) => boolean
  emitExit: (code?: number) => void
}

function makeFakeInit(): FakeInit {
  const fake = new EventEmitter() as FakeInit
  fake.exitCode = null
  fake.pid = 4242
  fake.killCalls = 0
  fake.killResult = true
  fake.exited = false
  fake.kill = (_signal?: NodeJS.Signals) => {
    fake.killCalls++
    if (!fake.killResult) {
      // Failed kill on a LIVE child: async 'error', never 'exit'.
      // A real EventEmitter throws on unobserved 'error' — the manager must
      // always listen (persistent guard), so this must not crash.
      setImmediate(() => fake.emit('error', new Error('mock init kill error')))
    }
    return fake.killResult
  }
  fake.emitExit = (code = 0) => {
    fake.exitCode = code
    fake.exited = true
    fake.emit('exit', code)
  }
  return fake
}

  it('drains an in-flight start on stop: start finishes, client stops once', async () => {
    const gate = deferred()
    const pool: Fake[] = []
    let n = 0
    const m2 = new VaultManager({
      userDataDir: resolve('test-ud'),
      binaryPath: 'bin',
      initDb: () => Promise.resolve(),
      createClient: (_paths, onExit) => {
        const f = pool[n++ % pool.length]
        f.exitCb = onExit
        f.healthValue = { status: 'healthy', db_path: _paths.dbFile }
        return f
      },
    })
    const first = makeFake({ dbFile: 'UD/vault/global.db', keyFile: 'k' }, () => undefined)
    first.startGate = gate
    pool.push(first)
    const ensuring = m2.ensureGlobal()
    await waitFor(() => n === 1, 'factory call') // stop strictly during start
    const stopping = m2.stop('global')
    gate.resolve()
    await ensuring.catch(() => undefined)
    await stopping
    expect(first.stopCalls).toBe(1)
    expect(m2.stateOf('global')).toBe('stopped')
  })

  it('marks degraded on health failure and restarts on next ensure', async () => {
    const { manager, created } = harness()
    await manager.ensureGlobal()
    created[0].fake.healthValue = { status: 'unhealthy', db_path: created[0].paths.dbFile }
    await expect(manager.health('global')).resolves.toMatchObject({ operational: false })
    expect(manager.stateOf('global')).toBe('degraded')
    await manager.ensureGlobal()
    expect(created).toHaveLength(2)
    expect(manager.stateOf('global')).toBe('ready')
    await manager.stopAll()
  })

  it('degrades on unexpected exit and backs off after rapid crashes', async () => {
    const { manager, created } = harness()
    await manager.ensureGlobal()
    created[0].fake.exitCb?.(1)
    expect(manager.stateOf('global')).toBe('degraded')
    await manager.ensureGlobal()
    expect(created).toHaveLength(2)
    created[1].fake.exitCb?.(1)
    await manager.ensureGlobal()
    expect(created).toHaveLength(3)
    created[2].fake.exitCb?.(1)
    expect(manager.stateOf('global')).toBe('backoff')
    await expect(manager.ensureGlobal()).rejects.toThrow(/backing off/)
    await manager.stopAll()
  })

  it('ignores stale exit callbacks after a restart', async () => {
    const { manager, created } = harness()
    await manager.ensureGlobal()
    const firstExit = created[0].fake.exitCb
    created[0].fake.exitCb?.(1)
    await manager.ensureGlobal()
    expect(manager.stateOf('global')).toBe('ready')
    firstExit?.(1) // late signal from the dead child: must not clear the new client
    expect(manager.stateOf('global')).toBe('ready')
    await expect(manager.health('global')).resolves.toMatchObject({ operational: true })
    await manager.stopAll()
  })

  it('a late healthy answer never revives a degraded entry', async () => {
    const { manager, created } = harness()
    await manager.ensureGlobal()
    const dbFile = created[0].paths.dbFile
    const gA = deferred()
    const gB = deferred()
    created[0].fake.script = [
      { gate: gA, value: { status: 'unhealthy', db_path: dbFile } },
      { gate: gB, value: { status: 'healthy', db_path: dbFile } },
    ]
    const h1 = manager.health('global')
    const h2 = manager.health('global')
    gA.resolve()
    await expect(h1).resolves.toMatchObject({ operational: false })
    expect(manager.stateOf('global')).toBe('degraded')
    gB.resolve()
    const r2 = await h2
    expect(r2.operational).toBe(false) // state guard: no late revival
    expect(manager.stateOf('global')).toBe('degraded')
    await manager.stopAll()
  })

  it('a late health error after stopAll corrupts nothing', async () => {
    const { manager, created } = harness()
    await manager.ensureGlobal()
    const g = deferred()
    created[0].fake.script = [{ gate: g, value: new Error('late boom') }]
    const h = manager.health('global')
    await manager.stopAll()
    g.resolve()
    const res = await h
    expect(res.operational).toBe(false)
    expect(manager.stateOf('global')).toBe('stopped')
    expect(created).toHaveLength(1)
  })

  it('a late error after a degrade adds no crash and mutates nothing', async () => {
    const { manager, created } = harness({ manager: { maxCrashesInWindow: 2, crashWindowMs: 600000 } })
    await manager.ensureGlobal()
    const dbFile = created[0].paths.dbFile
    const gA = deferred()
    const gB = deferred()
    created[0].fake.script = [
      { gate: gA, value: { status: 'unhealthy', db_path: dbFile } },
      { gate: gB, value: new Error('late boom') },
    ]
    const h1 = manager.health('global')
    const h2 = manager.health('global')
    gA.resolve()
    await expect(h1).resolves.toMatchObject({ operational: false })
    expect(manager.stateOf('global')).toBe('degraded')
    gB.resolve()
    const r2 = await h2
    expect(r2.operational).toBe(false)
    // The invariant itself: exactly 1 crash counted, the stale error added none.
    expect(manager.crashCount('global')).toBe(1)
    // …and therefore the next ensure restarts instead of backing off.
    await manager.ensureGlobal()
    expect(created).toHaveLength(2)
    expect(manager.stateOf('global')).toBe('ready')
    await manager.stopAll()
  })

  it('ignores a late health success after restart', async () => {
    const { manager, created } = harness()
    await manager.ensureGlobal()
    const gate = deferred()
    created[0].fake.callGate = gate
    const h = manager.health('global')
    await manager.stop('global')
    await manager.ensureGlobal()
    expect(created).toHaveLength(2)
    gate.resolve() // stale answer from the dead client
    const res = await h
    expect(res.operational).toBe(false)
    expect(manager.stateOf('global')).toBe('ready') // new client untouched
    await manager.stopAll()
  })

  it('restarts when the ready client died underneath', async () => {
    const { manager, created } = harness()
    await manager.ensureGlobal()
    created[0].fake.runningFlag = false
    await manager.ensureGlobal()
    expect(created).toHaveLength(2)
    await manager.stopAll()
  })

  it('rejects a wrong database behind the process', async () => {
    const { manager, created } = harness()
    await manager.ensureGlobal()
    created[0].fake.healthValue = { status: 'healthy', db_path: 'X:/other.db' }
    await expect(manager.health('global')).resolves.toMatchObject({ operational: false })
    expect(manager.stateOf('global')).toBe('degraded')
    await manager.stopAll()
  })

  it('rejects a missing database path in health', async () => {
    const { manager, created } = harness()
    await manager.ensureGlobal()
    created[0].fake.healthValue = { status: 'healthy' }
    await expect(manager.health('global')).resolves.toMatchObject({ operational: false })
    expect(manager.stateOf('global')).toBe('degraded')
    await manager.stopAll()
  })

  it('serializes degraded cleanup: double ensure + stopAll share one drain', async () => {
    const { manager, created } = harness()
    await manager.ensureGlobal()
    created[0].fake.healthValue = { status: 'unhealthy', db_path: created[0].paths.dbFile }
    await manager.health('global')
    expect(manager.stateOf('global')).toBe('degraded')
    const gate = deferred()
    created[0].fake.stopGate = gate
    const e1 = manager.ensureGlobal()
    const e2 = manager.ensureGlobal()
    const s = manager.stopAll()
    await Promise.resolve()
    gate.resolve()
    await e1.catch(() => undefined)
    await e2.catch(() => undefined)
    await s
    // one shared drain: the single live client stopped exactly once
    expect(created[0].fake.stopCalls).toBe(1)
    expect(manager.stateOf('global')).toBe('stopped')
  })

  it('keeps the reference and blocks restart when start cleanup fails', async () => {
    const pool: Fake[] = []
    let n = 0
    const m2 = new VaultManager({
      userDataDir: resolve('test-ud'),
      binaryPath: 'bin',
      initDb: () => Promise.resolve(),
      baseBackoffMs: 60000,
      maxBackoffMs: 60000,
      createClient: (paths, onExit) => {
        const f = pool[n++ % pool.length]
        f.exitCb = onExit
        f.healthValue = { status: 'healthy', db_path: paths.dbFile }
        return f
      },
    })
    const good = makeFake({ dbFile: 'x', keyFile: 'k' }, () => undefined)
    const bad = makeFake({ dbFile: 'x', keyFile: 'k' }, () => undefined)
    bad.startError = new Error('late start failure')
    bad.failStop = true
    pool.push(good, bad)
    await m2.ensureGlobal()
    expect(m2.stateOf('global')).toBe('ready')
    good.runningFlag = false // force a fresh attempt on the poisoned client
    await expect(m2.ensureGlobal()).rejects.toThrow(/cleanup failed/)
    expect(m2.stateOf('global')).toBe('degraded')
    bad.failStop = false
    await m2.stopAll()
  })

  it('blocks restart when degraded cleanup fails', async () => {
    const { manager, created } = harness()
    await manager.ensureGlobal()
    created[0].fake.healthValue = { status: 'unhealthy', db_path: created[0].paths.dbFile }
    await manager.health('global')
    expect(manager.stateOf('global')).toBe('degraded')
    created[0].fake.failStop = true
    await expect(manager.ensureGlobal()).rejects.toThrow(/cleanup failed, restart blocked/)
    expect(created).toHaveLength(1)
    created[0].fake.failStop = false
    await manager.stopAll()
  })

  it('coalesces starts during stopping into exactly one child', async () => {
    const gate = deferred()
    const first = makeFake({ dbFile: 'UD/vault/global.db', keyFile: 'k' }, () => undefined)
    first.startGate = gate
    const creations: Fake[] = [first]
    let n = 0
    const m3 = new VaultManager({
      userDataDir: resolve('test-ud'),
      binaryPath: 'bin',
      initDb: () => Promise.resolve(),
      createClient: (paths, onExit) => {
        const f = creations[n++ % creations.length]
        f.exitCb = onExit
        f.healthValue = { status: 'healthy', db_path: paths.dbFile }
        return f
      },
    })
    const ensuring = m3.ensureGlobal()
    await waitFor(() => n === 1, 'factory call') // stop strictly during start
    const stopping = m3.stop('global')
    const r1 = m3.ensureGlobal()
    const r2 = m3.ensureGlobal()
    gate.resolve()
    await ensuring.catch(() => undefined)
    await stopping
    await r1
    await r2
    expect(m3.stateOf('global')).toBe('ready')
    // exactly one restart child despite two ensures during stopping
    expect(n).toBe(2)
    expect(first.stopCalls).toBe(1)
    await m3.stopAll()
  })

  it('stop during DB init creates no child and settles stopped', async () => {
    const gate = deferred()
    let factoryCalls = 0
    const m2 = new VaultManager({
      userDataDir: resolve('test-ud'),
      binaryPath: 'bin',
      initDb: () => gate.promise,
      createClient: () => {
        factoryCalls++
        throw new Error('must not be called')
      },
    })
    const ensuring = m2.ensureGlobal()
    await Promise.resolve()
    const stopping = m2.stop('global')
    gate.resolve()
    await ensuring.catch(() => undefined)
    await stopping
    expect(factoryCalls).toBe(0) // init unfinished → no child ever born
    expect(m2.stateOf('global')).toBe('stopped')
  })

  it('a hanging init rejects bounded and the stop still settles', async () => {
    const m2 = new VaultManager({
      userDataDir: resolve('test-ud'),
      binaryPath: 'bin',
      initDb: () => new Promise<void>(() => undefined), // never settles
      initTimeoutMs: 200,
      baseBackoffMs: 60000,
      maxBackoffMs: 60000,
      createClient: () => {
        throw new Error('must not be called')
      },
    })
    await expect(m2.ensureGlobal()).rejects.toThrow(/init timed out/)
    expect(m2.stateOf('global')).toBe('backoff')
    await m2.stop('global')
    expect(m2.stateOf('global')).toBe('stopped')
  })

  it('stop during a real init child kills it, confirms exit, spawns no serve', async () => {
    const init = makeFakeInit()
    let factoryCalls = 0
    const m2 = new VaultManager({
      userDataDir: resolve('test-ud'),
      binaryPath: 'bin',
      initTimeoutMs: 60000,
      createInitProcess: () => init,
      createClient: () => {
        factoryCalls++
        throw new Error('must not be called')
      },
    })
    const ensuring = m2.ensureGlobal()
    void ensuring.catch(() => undefined) // outcome asserted via stopping/state below
    await waitFor(() => init.killCalls === 0 && m2.stateOf('global') === 'starting', 'init start')
    const stopping = m2.stop('global')
    await waitFor(() => init.killCalls === 1, 'init kill')
    init.emitExit(0) // termination confirmed only here, not at kill()
    await stopping
    expect(factoryCalls).toBe(0) // no serve child, no late writes possible
    expect(init.exited).toBe(true)
    expect(m2.stateOf('global')).toBe('stopped')
  })

  it('refused init kill keeps the reference and blocks restart', async () => {
    const init = makeFakeInit()
    init.killResult = false // kill rejected, child never exits
    let factoryCalls = 0
    const m2 = new VaultManager({
      userDataDir: resolve('test-ud'),
      binaryPath: 'bin',
      initTimeoutMs: 60000,
      baseBackoffMs: 60000,
      maxBackoffMs: 60000,
      createInitProcess: () => init,
      createClient: () => {
        factoryCalls++
        throw new Error('must not be called')
      },
    })
    const ensuring = m2.ensureGlobal()
    void ensuring.catch(() => undefined) // outcome asserted via stops below
    await waitFor(() => m2.stateOf('global') === 'starting', 'init start')
    await expect(m2.stop('global')).rejects.toThrow(/rejected by OS/)
    await new Promise((r) => setTimeout(r, 50)) // 1st async kill-error lands: observed, no crash
    expect(factoryCalls).toBe(0)
    // Reference kept: every further stop retries the same child…
    await expect(m2.stop('global')).rejects.toThrow(/rejected by OS/)
    await new Promise((r) => setTimeout(r, 50)) // 2nd async kill-error lands: observed, no crash
    expect(init.killCalls).toBe(2)
    // …and restart stays blocked instead of spawning beside it.
    await expect(m2.ensureGlobal()).rejects.toThrow(/cleanup failed, restart blocked/)
    expect(factoryCalls).toBe(0)
    init.killResult = true
    init.emitExit(0)
    await m2.stopAll()
    expect(m2.stateOf('global')).toBe('stopped')
  })

  it('reserves the global id for workspaces', async () => {
    const { manager } = harness()
    await expect(manager.ensureWorkspace('global')).rejects.toThrow(/reserved/)
  })
})

describe('bootExisting', () => {
  function realDir(): string {
    const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs') as typeof import('node:fs')
    const { tmpdir } = require('node:os') as typeof import('node:os')
    const { join } = require('node:path') as typeof import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'ittop-boot-'))
    mkdirSync(join(dir, 'vault', 'workspaces'), { recursive: true })
    mkdirSync(join(dir, 'vault', 'keys', 'workspaces'), { recursive: true })
    writeFileSync(join(dir, 'vault', 'workspaces', `${WS.toLowerCase()}.db`), 'store')
    writeFileSync(join(dir, 'vault', 'keys', 'workspaces', `${WS.toLowerCase()}.key`), 'key')
    return dir
  }

  it('refuses missing stores and keys without touching the backend', async () => {
    const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
    const { tmpdir } = require('node:os') as typeof import('node:os')
    const { join } = require('node:path') as typeof import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'ittop-boot-empty-'))
    let clients = 0
    const manager = new VaultManager({
      userDataDir: dir,
      binaryPath: 'bin',
      initDb: () => Promise.resolve(),
      createClient: () => {
        clients += 1
        throw new Error('must never boot')
      },
    })
    await expect(manager.bootExisting(`workspace:${WS}`)).rejects.toThrow(/has no store/)
    expect(clients).toBe(0)
  })

  it('boots a pre-existing store', async () => {
    const dir = realDir()
    const { manager, created } = harness({ manager: { userDataDir: dir } })
    // Settle the clock past file creation (ms guard, deterministic).
    await new Promise((r) => setTimeout(r, 5))
    await manager.bootExisting(`workspace:${WS}`)
    expect(manager.stateOf(`workspace:${WS}`)).toBe('ready')
    expect(created).toHaveLength(1)
    await manager.stopAll()
  })

  it('refuses a store recreated mid-boot (deterministic race)', async () => {
    const dir = realDir()
    await new Promise((r) => setTimeout(r, 5))
    const manager = new VaultManager({
      userDataDir: dir,
      binaryPath: 'bin',
      initDb: () => Promise.resolve(),
      createClient: (paths: VaultPaths, onExit) => {
        // External deleter + recreator striking after the pre-checks
        // (and after runInit's check): the served file is not verified.
        const { rmSync, writeFileSync } = require('node:fs') as typeof import('node:fs')
        rmSync(paths.dbFile)
        writeFileSync(paths.dbFile, 'fresh')
        return makeFake(paths, onExit)
      },
    })
    await expect(manager.bootExisting(`workspace:${WS}`)).rejects.toThrow(/changed during boot/)
    await manager.stopAll()
  })

  it('executeWrite stops serve, runs writer, and restarts serve under lease', async () => {
    let serveRunning = false
    let writes = 0
    let writeSawServe = false
    const manager = new VaultManager({
      userDataDir: realDir(),
      binaryPath: 'bin',
      initDb: () => Promise.resolve(),
      createClient: (paths, onExit) => {
        serveRunning = true
        const fake = makeFake(paths, onExit)
        const origStop = fake.stop.bind(fake)
        fake.stop = async () => {
          serveRunning = false
          return origStop()
        }
        return fake
      },
      cliWrite: async (_paths, _args) => {
        writes += 1
        if (serveRunning) writeSawServe = true
      },
    })
    await manager.ensureWorkspace(WS)
    expect(serveRunning).toBe(true)
    await manager.executeWrite(`workspace:${WS}`, { category: 'decision', key: 'k1', body: '{}' })
    expect(writes).toBe(1)
    expect(writeSawServe).toBe(false)
    expect(serveRunning).toBe(true)
    await manager.stopAll()
  })
})

describe('storeChangedAfter', () => {
  it('distinguishes pre-existing, recreated and vanished files', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = require('node:fs') as typeof import('node:fs')
    const { tmpdir } = require('node:os') as typeof import('node:os')
    const { join } = require('node:path') as typeof import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'ittop-birth-'))
    const f = join(dir, 's.db')
    writeFileSync(f, 'v1')
    const before = storeIdentity(f)
    expect(before).not.toBeNull()
    const t0 = Date.now()
    // Untouched file: identical content.
    expect(storeChangedAfter(f, t0, before)).toBe(false)
    expect(storeChangedAfter(join(dir, 'missing.db'), t0, before)).toBe(true)
    expect(storeChangedAfter(f, t0, null)).toBe(true)
    // Delete + recreate: baseline descriptor holds open the old inode,
    // so the new file gets a distinct inode even on rapid ext4 reuse.
    rmSync(f)
    writeFileSync(f, 'v2')
    expect(storeChangedAfter(f, t0, before)).toBe(true)
    closeBaseline(before)
  })
})
