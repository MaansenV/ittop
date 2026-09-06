import { describe, expect, it, vi } from 'vitest'
import { AppShutdown } from '../shutdown'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('AppShutdown', () => {
  it('runs steps in order and quits exactly once', async () => {
    const order: string[] = []
    const quit = vi.fn()
    const shutdown = new AppShutdown(
      [
        { name: 'a', run: async () => void order.push('a') },
        { name: 'b', run: async () => void order.push('b') },
      ],
      quit,
      () => undefined,
    )
    await shutdown.requestQuit()
    expect(order).toEqual(['a', 'b'])
    expect(quit).toHaveBeenCalledTimes(1)
    expect(shutdown.settled).toBe(true)
  })

  it('joins concurrent requests into one drain', async () => {
    const gate = deferred()
    let runs = 0
    const quit = vi.fn()
    const shutdown = new AppShutdown(
      [
        {
          name: 'slow',
          run: async () => {
            runs++
            await gate.promise
          },
        },
      ],
      quit,
      () => undefined,
    )
    const q1 = shutdown.requestQuit()
    const q2 = shutdown.requestQuit()
    gate.resolve()
    await q1
    await q2
    expect(runs).toBe(1)
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('runs remaining steps and still quits when one fails', async () => {
    const ran: string[] = []
    const logs: string[] = []
    const quit = vi.fn()
    const shutdown = new AppShutdown(
      [
        {
          name: 'bad',
          run: async () => {
            throw new Error('boom')
          },
        },
        {
          name: 'good',
          run: async () => void ran.push('good'),
        },
      ],
      quit,
      (m) => logs.push(m),
    )
    await shutdown.requestQuit() // never rejects
    expect(ran).toEqual(['good'])
    expect(quit).toHaveBeenCalledTimes(1)
    expect(logs.some((m) => m.includes('bad') && m.includes('boom'))).toBe(true)
    expect(shutdown.settled).toBe(true)
  })

  it('does not quit twice on requests after completion', async () => {
    const quit = vi.fn()
    const shutdown = new AppShutdown([{ name: 'a', run: async () => undefined }], quit, () => undefined)
    await shutdown.requestQuit()
    await shutdown.requestQuit()
    expect(quit).toHaveBeenCalledTimes(1)
  })
})
