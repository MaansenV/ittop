import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { VaultMemoryService, resolveVaultBinary } from '../service'
import type { VaultProcess } from '../vaultManager'
import type { VaultPaths } from '../paths'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

function tempUserData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ittop-vault-svc-'))
  dirs.push(dir)
  return dir
}

function healthyFake(
  paths: VaultPaths,
  opts: { stopGate?: { promise: Promise<void> }; fail?: { stop: boolean } } = {},
): VaultProcess & { stopCalls: number } {
  const fake = {
    running: true,
    stopCalls: 0,
    async start() {
      // no-op fake
    },
    async call() {
      return { status: 'healthy', db_path: paths.dbFile }
    },
    async stop() {
      fake.stopCalls++
      if (opts.stopGate) await opts.stopGate.promise
      if (opts.fail?.stop) throw new Error('stop failed')
    },
  }
  return fake as unknown as VaultProcess & { stopCalls: number }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('VaultMemoryService', () => {
  it('does nothing while disabled: no child, no files', async () => {
    const userDataDir = tempUserData()
    let creations = 0
    const svc = new VaultMemoryService({
      userDataDir,
      binaryPath: 'bin',
      isEnabled: () => false,
      createClient: (paths) => {
        creations++
        return healthyFake(paths)
      },
    })
    await svc.reconcile()
    expect(svc.active).toBe(false)
    expect(creations).toBe(0)
    expect(existsSync(join(userDataDir, 'vault'))).toBe(false)
  })

  it('activates the isolated global DB when enabled', async () => {
    const userDataDir = tempUserData()
    let creations = 0
    let enabled = false
    const svc = new VaultMemoryService({
      userDataDir,
      binaryPath: 'bin',
      isEnabled: () => enabled,
      initDb: () => Promise.resolve(),
      createClient: (paths) => {
        creations++
        return healthyFake(paths)
      },
    })
    await svc.reconcile()
    expect(creations).toBe(0)
    enabled = true
    await svc.reconcile()
    expect(svc.active).toBe(true)
    expect(creations).toBe(1)
    const statusFile = join(userDataDir, 'vault', 'global.status.json')
    expect(existsSync(statusFile)).toBe(true)
    const status = JSON.parse(readFileSync(statusFile, 'utf-8')) as {
      operational?: boolean
      dbFile?: string
    }
    expect(status.operational).toBe(true)
    expect(status.dbFile).toBe(join(userDataDir, 'vault', 'global.db'))
    enabled = false
    await svc.reconcile()
    expect(svc.active).toBe(false)
    const closed = JSON.parse(readFileSync(statusFile, 'utf-8')) as { endedClean?: boolean }
    expect(closed.endedClean).toBe(true)
  })

  it('shutdown stops everything without throwing when idle', async () => {
    const svc = new VaultMemoryService({ userDataDir: tempUserData(), binaryPath: 'bin', isEnabled: () => false })
    await svc.shutdown()
    expect(svc.active).toBe(false)
  })

  it('a failing ensure never rejects reconcile', async () => {
    const logs: string[] = []
    const svc = new VaultMemoryService({
      userDataDir: tempUserData(),
      binaryPath: 'bin',
      isEnabled: () => true,
      createClient: () => {
        throw new Error('nope')
      },
      log: (m) => logs.push(m),
    })
    await svc.reconcile()
    expect(svc.active).toBe(true)
    await svc.shutdown()
  })

  it('serializes enable-disable-enable across a delayed stop: one manager at a time', async () => {
    const userDataDir = tempUserData()
    const gate = deferred()
    const created: Array<{ stopCalls: number }> = []
    let enabled = true
    const svc = new VaultMemoryService({
      userDataDir,
      binaryPath: 'bin',
      isEnabled: () => enabled,
      initDb: () => Promise.resolve(),
      createClient: (paths) => {
        const f = healthyFake(paths, { stopGate: gate })
        created.push(f)
        return f
      },
    })
    await svc.reconcile()
    expect(svc.active).toBe(true)
    enabled = false
    const disabling = svc.reconcile()
    // Wait until the drain is really in flight (mirrors separate IPC round
    // trips: each reconcile must observe its own flag value).
    const end = Date.now() + 5000
    while (created[0].stopCalls === 0) {
      if (Date.now() > end) throw new Error('drain did not start')
      await new Promise((r) => setTimeout(r, 10))
    }
    enabled = true
    const reenabling = svc.reconcile() // queued behind the drain
    gate.resolve()
    await disabling
    await reenabling
    expect(svc.active).toBe(true)
    expect(created).toHaveLength(2) // first manager drained, exactly one new
    for (const f of created) expect(f.stopCalls).toBeLessThanOrEqual(1)
    await svc.shutdown()
    expect(svc.active).toBe(false)
  })

  it('keeps the reference on cleanup failure and retries instead of doubling', async () => {
    const userDataDir = tempUserData()
    let enabled = true
    const fail = { stop: false }
    let creations = 0
    const svc = new VaultMemoryService({
      userDataDir,
      binaryPath: 'bin',
      isEnabled: () => enabled,
      initDb: () => Promise.resolve(),
      createClient: (paths) => {
        creations++
        return healthyFake(paths, { fail })
      },
    })
    await svc.reconcile()
    fail.stop = true
    enabled = false
    await svc.reconcile() // resolves despite the failure…
    expect(svc.active).toBe(true) // …reference kept, nothing dropped…
    expect(svc.fault?.message).toMatch(/stop failed/)
    expect(creations).toBe(1) // …and no second manager spawned
    fail.stop = false
    await svc.reconcile()
    expect(svc.active).toBe(false)
    await svc.shutdown()
  })

  it('reconcile during shutdown is a no-op and shutdown latches', async () => {
    const userDataDir = tempUserData()
    const gate = deferred()
    let creations = 0
    const flag = { on: true }
    const svc = new VaultMemoryService({
      userDataDir,
      binaryPath: 'bin',
      isEnabled: () => flag.on,
      initDb: () => Promise.resolve(),
      createClient: (paths) => {
        creations++
        return healthyFake(paths, { stopGate: gate })
      },
    })
    await svc.reconcile()
    const shutting = svc.shutdown() // latch set synchronously
    await svc.reconcile() // no-op: must not create anything
    expect(creations).toBe(1)
    gate.resolve()
    await shutting
    expect(svc.active).toBe(false)
    await svc.reconcile() // latched: still a no-op even though enabled
    expect(creations).toBe(1)
  })
})

describe('resolveVaultBinary', () => {
  const exe = process.platform === 'win32' ? 'perseus-vault.exe' : 'perseus-vault'
  it('prefers the bundled binary when packaged and present', () => {
    expect(resolveVaultBinary(true, '/res', (p) => p.endsWith(exe))).toContain('bin/')
  })
  it('falls back to PATH when packaged but missing, or in dev', () => {
    expect(resolveVaultBinary(true, '/res', () => false)).toBe(exe)
    expect(resolveVaultBinary(false, '/res', () => true)).toBe(exe)
  })
})
