import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

const mock = { spawns: 0, badHandshake: true, killWorks: false }

interface MockProc extends EventEmitter {
  pid: number
  exitCode: number | null
  stdin: EventEmitter & { writableLength: number; write: (d: string) => boolean }
  stdout: EventEmitter & { setEncoding: (e: string) => void }
  kill: (sig?: string) => boolean
}

function reply(proc: MockProc, id: number, payload: unknown): void {
  setImmediate(() => {
    proc.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id, ...(payload as object) })}\n`)
  })
}

function handle(proc: MockProc, data: string): void {
  for (const line of data.split('\n')) {
    if (!line.trim()) continue
    const msg = JSON.parse(line) as { id?: number; method?: string }
    if (msg.id === undefined) continue
    if (msg.method === 'initialize') {
      reply(
        proc,
        msg.id,
        mock.badHandshake
          ? { result: {} }
          : { result: { protocolVersion: '2025-06-18', serverInfo: { name: 'perseus-vault' } } },
      )
    }
  }
}

vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>()
  return {
    ...orig,
    spawn: () => {
      mock.spawns++
      const proc = new EventEmitter() as MockProc
      proc.pid = 1000 + mock.spawns
      proc.exitCode = null
      proc.stdin = new EventEmitter() as MockProc['stdin']
      proc.stdin.writableLength = 0
      proc.stdin.write = (d: string) => {
        handle(proc, d)
        return true
      }
      proc.stdout = new EventEmitter() as MockProc['stdout']
      proc.stdout.setEncoding = () => undefined
      proc.kill = () => {
        if (!mock.killWorks) {
          // Failed kill on a LIVE child: 'error' now, no exit ever.
          setImmediate(() => proc.emit('error', new Error('mock kill error')))
          return false
        }
        proc.exitCode = 0
        setImmediate(() => proc.emit('exit', 0))
        return true
      }
      return proc
    },
  }
})

import { VaultClient } from '../vaultClient'

describe('VaultClient zombie cleanup', () => {
  it('failed handshake + failed kill keeps the child and blocks without a second spawn', async () => {
    mock.spawns = 0
    mock.badHandshake = true
    mock.killWorks = false
    const c = new VaultClient('bin', 'db', 'key')
    await expect(c.start()).rejects.toThrow(/cleanup failed/)
    expect(c.currentState).toBe('stopping')
    expect(c.childPid).toBe(1001) // same child still referenced
    expect(c.fault?.message).toMatch(/cleanup failed/)

    // Retry: drain fails again (kill emits 'error' a second time — observed,
    // no host crash), still exactly one child.
    await new Promise((r) => setTimeout(r, 50)) // let the first kill-error land
    await expect(c.start()).rejects.toThrow()
    await new Promise((r) => setTimeout(r, 50)) // let the second kill-error land
    expect(mock.spawns).toBe(1)
    expect(c.childPid).toBe(1001)

    // Recovery: kill works now → drain succeeds → queued start spawns #2 → ready.
    mock.killWorks = true
    mock.badHandshake = false
    await c.start()
    expect(c.running).toBe(true)
    expect(mock.spawns).toBe(2)
    await c.stop()
    expect(c.running).toBe(false)
  })
})
