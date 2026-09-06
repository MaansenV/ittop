import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { UsageLedger } from '../tracking'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ittop-usage-'))
  dirs.push(dir)
  return join(dir, 'usage.db')
}

describe('UsageLedger', () => {
  it('counts retrieved and applied separately per entity version', () => {
    const ledger = new UsageLedger(tempFile())
    try {
      ledger.record({ eventId: 'e1', kind: 'retrieved', db: 'workspace:w', entityId: 'm1', entityVersion: 3 })
      ledger.record({ eventId: 'e2', kind: 'retrieved', db: 'workspace:w', entityId: 'm1', entityVersion: 3 })
      ledger.record({ eventId: 'e3', kind: 'applied', db: 'workspace:w', entityId: 'm1', entityVersion: 3 })
      expect(ledger.counts('workspace:w', 'm1')).toEqual({ retrieved: 2, applied: 1 })
      expect(ledger.counts('workspace:w', 'unknown')).toEqual({ retrieved: 0, applied: 0 })
      expect(ledger.total()).toBe(3)
    } finally {
      ledger.close()
    }
  })

  it('replays collapse on event id, conflicts throw, versions filter', () => {
    const ledger = new UsageLedger(tempFile())
    try {
      const ev = { eventId: 'same', kind: 'applied' as const, db: 'global', entityId: 'm9', entityVersion: 1 }
      ledger.record(ev)
      ledger.record(ev) // identical replay collapses
      ledger.record({ ...ev, eventId: 'other' })
      expect(ledger.counts('global', 'm9')).toEqual({ retrieved: 0, applied: 2 })
      expect(() =>
        ledger.record({ eventId: 'same', kind: 'retrieved', db: 'global', entityId: 'm9', entityVersion: 1 }),
      ).toThrow(/conflicts/)
      expect(() =>
        ledger.record({ eventId: 'same', kind: 'applied', db: 'global', entityId: 'm9', entityVersion: 2 }),
      ).toThrow(/conflicts/)
      ledger.record({ eventId: 'v2-use', kind: 'applied', db: 'global', entityId: 'm9', entityVersion: 2 })
      expect(ledger.counts('global', 'm9', 1)).toEqual({ retrieved: 0, applied: 2 })
      expect(ledger.counts('global', 'm9', 2)).toEqual({ retrieved: 0, applied: 1 })
      expect(ledger.counts('global', 'm9')).toEqual({ retrieved: 0, applied: 3 })
    } finally {
      ledger.close()
    }
  })
})
