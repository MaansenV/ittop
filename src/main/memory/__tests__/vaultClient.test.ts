import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { VaultClient, VaultRpcError, VaultToolError } from '../vaultClient'

const FIXTURE = join(__dirname, 'fixtures', 'fake-serve.mjs')
const spawn = { command: process.execPath, args: [FIXTURE] }

const open: VaultClient[] = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.stop().catch(() => undefined)))
})

function client(timeoutMs = 2000): VaultClient {
  const c = new VaultClient('unused', 'unused.db', 'unused.key', { requestTimeoutMs: timeoutMs, spawn })
  open.push(c)
  return c
}

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('VaultClient', () => {
  it('starts and returns structuredContent from tools/call', async () => {
    const c = client()
    await c.start()
    expect(c.running).toBe(true)
    const res = (await c.call('perseus_vault_health', {})) as { echo: { name: string } }
    expect(res.echo.name).toBe('perseus_vault_health')
    await c.stop()
    expect(c.running).toBe(false)
  })

  it('coalesces parallel starts into one handshake', async () => {
    const c = client()
    await Promise.all([c.start(), c.start(), c.start()])
    expect(c.running).toBe(true)
    await c.stop()
  })

  it('surfaces server errors as VaultRpcError', async () => {
    const c = client()
    await c.start()
    await expect(c.call('boom', {})).rejects.toBeInstanceOf(VaultRpcError)
    await c.stop()
  })

  it('surfaces MCP tool failures as VaultToolError, not success', async () => {
    const c = client()
    await c.start()
    await expect(c.call('tool-boom', {})).rejects.toBeInstanceOf(VaultToolError)
    await c.stop()
  })

  it('times out a hanging call and stays usable', async () => {
    const c = client(250)
    await c.start()
    await expect(c.call('hang', {})).rejects.toThrow(/timeout/)
    const res = (await c.call('ping', {})) as { echo: { name: string } }
    expect(res.echo.name).toBe('ping')
    await c.stop()
  })

  it('rejects calls after stop', async () => {
    const c = client()
    await c.start()
    await c.stop()
    await expect(c.call('ping', {})).rejects.toThrow(/not ready/)
  })

  it('rejects the slow call on stop and survives its late frame', async () => {
    const c = client()
    await c.start()
    const slow = c.call('slow', {})
    const asserted = expect(slow).rejects.toThrow(/stopped/)
    await c.stop()
    await asserted
    await c.start()
    expect(c.running).toBe(true)
    await c.stop()
  })

  it('rejects oversized frames and shuts down', async () => {
    const c = client(5000)
    await c.start()
    await expect(c.call('big', {})).rejects.toThrow(/too large|stopped/)
    await c.stop()
  })

  it('rejects start when the binary does not exist', async () => {
    const bad = new VaultClient('does-not-exist-xyz', 'x.db', 'x.key', {
      requestTimeoutMs: 1000,
      spawn: { command: 'does-not-exist-xyz', args: [] },
    })
    open.push(bad)
    await expect(bad.start()).rejects.toThrow()
  })

  it('coalesces starts queued during stopping into exactly one child', async () => {
    const log = join(tmpdir(), `vault-fake-log-${process.pid}-${Date.now()}.log`)
    const c = new VaultClient('unused', 'unused.db', 'unused.key', {
      requestTimeoutMs: 5000,
      spawn: {
        command: process.execPath,
        args: [FIXTURE],
        env: { ...process.env, FAKE_SLOW_INIT_MS: '800', FAKE_LOG: log },
      },
    })
    open.push(c)
    try {
      await c.start()
      const stopping = c.stop()
      const r1 = c.start()
      const r2 = c.start()
      await stopping.catch(() => undefined)
      await r1
      await r2
      expect(c.running).toBe(true)
      const lines = readFileSync(log, 'utf8').trim().split('\n')
      expect(lines).toHaveLength(2) // initial child + exactly one restart child
    } finally {
      rmSync(log, { force: true })
    }
    await c.stop()
  })

  it('a renewed stop aborts the queued follow-up handshake mid-flight', async () => {
    const gateDir = mkdtempSync(join(tmpdir(), `vault-qgate-${process.pid}-`))
    const log = join(tmpdir(), `vault-qabort-log-${process.pid}-${Date.now()}.log`)
    const gatedSpawn = {
      command: process.execPath,
      args: [FIXTURE],
      env: { ...process.env, FAKE_INIT_GATE: gateDir, FAKE_LOG: log },
    }
    const c = new VaultClient('unused', 'unused.db', 'unused.key', { requestTimeoutMs: 10000, spawn: gatedSpawn })
    open.push(c)
    const release = join(gateDir, 'release')
    const waitForFile = async (): Promise<string> => {
      const end = Date.now() + 10000
      for (;;) {
        const hit = readdirSync(gateDir).find((f) => f.startsWith('got-'))
        if (hit) return hit.slice('got-'.length)
        if (Date.now() > end) throw new Error('waitForFile timed out')
        await new Promise((r) => setTimeout(r, 50))
      }
    }
    try {
      const first = c.start()
      await waitForFile() // init#1 received…
      writeFileSync(release, '') // …released → ready
      await first
      const pid1 = c.childPid
      rmSync(release, { force: true })
      rmSync(join(gateDir, `got-${pid1}`), { force: true })
      const s1 = c.stop()
      const r1 = c.start() // queued behind the drain
      await s1 // drain done: follow-up doStart#2 sends init#2…
      const pid2 = await waitForFile() // …explicitly received = handshake in flight
      expect(Number(pid2)).not.toBe(pid1)
      await c.stop() // renewed stop aborts mid-handshake (answer still held)
      await expect(r1).rejects.toThrow(/aborted|superseded/)
      expect(c.running).toBe(false)
      expect(alive(Number(pid2))).toBe(false)
      writeFileSync(release, '') // late answer: must be dropped, no revival
      await new Promise((r) => setTimeout(r, 300))
      expect(c.running).toBe(false)
      const lines = readFileSync(log, 'utf8').trim().split('\n')
      expect(lines).toHaveLength(2) // exactly: initial + aborted follow-up
    } finally {
      rmSync(gateDir, { recursive: true, force: true })
      rmSync(log, { force: true })
    }
    await c.stop()
  })

  // (The slow-init variant of this abort is superseded by the gated test above.)

  it('a renewed stop aborts the queued restart before birth: no live child', async () => {
    const log = join(tmpdir(), `vault-abort-log-${process.pid}-${Date.now()}.log`)
    const slowSpawn = {
      command: process.execPath,
      args: [FIXTURE],
      env: { ...process.env, FAKE_SLOW_INIT_MS: '1500', FAKE_LOG: log },
    }
    const c = new VaultClient('unused', 'unused.db', 'unused.key', { requestTimeoutMs: 8000, spawn: slowSpawn })
    open.push(c)
    try {
      await c.start()
      const s1 = c.stop()
      const r1 = c.start() // queued behind the drain
      const s2 = c.stop() // renewed stop wins: restart aborted
      await s1
      await s2
      await expect(r1).rejects.toThrow(/aborted/)
      expect(c.running).toBe(false)
      expect(c.childPid == null || alive(c.childPid) === false).toBe(true)
      const lines = readFileSync(log, 'utf8').trim().split('\n')
      expect(lines).toHaveLength(1) // follow-up child never born
    } finally {
      rmSync(log, { force: true })
    }
    await c.stop()
  })

  it('a stop during the follow-up handshake aborts it via generation', async () => {
    const slowSpawn = {
      command: process.execPath,
      args: [FIXTURE],
      env: { ...process.env, FAKE_SLOW_INIT_MS: '1500' },
    }
    const c = new VaultClient('unused', 'unused.db', 'unused.key', { requestTimeoutMs: 8000, spawn: slowSpawn })
    open.push(c)
    try {
      await c.start()
      await c.stop()
      const r1 = c.start() // direct start, slow handshake in flight
      await new Promise((r) => setTimeout(r, 200))
      expect(c.currentState).toBe('starting')
      await c.stop() // aborts the handshake instead of waiting it out
      await expect(r1).rejects.toThrow(/aborted|superseded/)
      expect(c.running).toBe(false)
      expect(c.childPid == null || alive(c.childPid) === false).toBe(true)
    } finally {
      await c.stop().catch(() => undefined)
    }
  })

  it('repeated stops all resolve', async () => {
    const c = client()
    await c.start()
    await c.stop()
    await c.stop()
    await c.stop()
    expect(c.running).toBe(false)
  })

  it('rejects calls after the child was killed externally', async () => {
    const c = client()
    await c.start()
    const pid = c.childPid
    expect(pid).toBeDefined()
    process.kill(pid as number, 'SIGKILL')
    await new Promise((r) => setTimeout(r, 500))
    expect(c.running).toBe(false)
    await expect(c.call('ping', {})).rejects.toThrow(/not ready/)
  })
})
