import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { VaultManager } from '../vaultManager'
import { pathsForDb } from '../paths'
import { snapshotDb, vacuumIntoSnapshot } from './dbSnapshot'

// Isolated migration-probe (binary 2.23.2): the ONLY implementation work
// allowed before the Phase-6 plan approval — safe snapshot method, provably
// non-mutating reads, and write-path feasibility, all on temp DBs with
// temp/isolated keys. The live user DB is never touched.
// Run: ITTOP_VAULT_LIVE_TEST=1 npx vitest run src/main/memory
const runIf = process.env.ITTOP_VAULT_LIVE_TEST === '1' ? describe : describe.skip

function cli(...args: string[]): string {
  return execFileSync('perseus-vault', args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
  })
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function initVault(dir: string): { db: string; key: string } {
  const db = join(dir, 's.db')
  const key = join(dir, 't.key')
  cli('keygen', '--key-file', key)
  cli('init', '--db', db, '--key-file', key)
  return { db, key }
}

function write(db: string, key: string, category: string, k: string, body: unknown): void {
  cli(
    'write',
    '--db',
    db,
    '--encryption-key',
    key,
    '--category',
    category,
    '--key',
    k,
    '--body',
    JSON.stringify(body),
  )
}

runIf('migration probe', () => {
  it('reads metadata without mutation and keeps bodies opaque', () => {
    const dir = tempDir('ittop-probe-ro-')
    try {
      const { db, key } = initVault(dir)
      write(db, key, 'decision', 'ro probe', { content: 'secret body text' })
      const before = snapshotDb(db)
      // Read-only inventory session: metadata, history, links, counters.
      const d = new DatabaseSync(db, { readOnly: true })
      try {
        d.exec('PRAGMA query_only = ON')
        const row = d.prepare(`SELECT category, key, retrieval_count, decay_score FROM entities`).get() as Record<
          string,
          unknown
        >
        expect(row.category).toBe('decision')
        expect(row.key).toBe('ro probe')
        const body = (
          d.prepare(`SELECT body_json AS b FROM entities`).get() as {
            b: string
          }
        ).b
        expect(body).not.toContain('secret body text')
      } finally {
        d.close()
      }
      expect(snapshotDb(db)).toBe(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('snapshots consistently under concurrent writes and checkpoints', () => {
    const dir = tempDir('ittop-probe-snap-')
    try {
      const { db, key } = initVault(dir)
      // Sequential writer + checkpointer + snapshotter: every snapshot
      // must be an exact prefix (writes 1..k, no torn halves), each with
      // clean integrity — the consistency proof for live sources.
      for (let i = 1; i <= 4; i++) {
        write(db, key, 'decision', `snap key ${i}`, { content: `v${i}` })
        const cp = new DatabaseSync(db)
        try {
          cp.exec('PRAGMA wal_checkpoint(TRUNCATE)')
        } finally {
          cp.close()
        }
        const snap = join(dir, `snap-${i}.db`)
        vacuumIntoSnapshot(db, snap)
        const s = new DatabaseSync(snap, { readOnly: true })
        try {
          s.exec('PRAGMA query_only = ON')
          expect((s.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe(
            'ok',
          )
          const keys = (
            s.prepare(`SELECT key FROM entities ORDER BY key`).all() as Array<{ key: string }>
          ).map((r) => r.key)
          expect(keys).toEqual([1, 2, 3, 4].slice(0, i).map((n) => `snap key ${n}`))
        } finally {
          s.close()
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it(
    'snapshots stay prefix-consistent under a live writer',
    async () => {
    const dir = tempDir('ittop-probe-par-')
    try {
      const { db, key } = initVault(dir)
      write(db, key, 'decision', 'par seed', { content: 'seed' })
      const { fork } = await import('node:child_process')
      const child = fork(join(__dirname, 'parWriter.cjs'), [db, key, '15'], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] })
      // Child stdout carries READY/CKPT/DONE markers. ONE data handler for
      // the whole run (a second handler would duplicate every chunk).
      let childOut = ''
      let readyResolve: (() => void) | null = null
      let doneResolve: (() => void) | null = null
      child.stdout?.on('data', (d: Buffer) => {
        childOut += d.toString()
        if (readyResolve && childOut.includes('READY')) {
          const r = readyResolve
          readyResolve = null
          r()
        }
        if (doneResolve && childOut.includes('DONE')) {
          const r = doneResolve
          doneResolve = null
          r()
        }
      })
      try {
        await new Promise<void>((resolve, reject) => {
          const to = setTimeout(() => reject(new Error('writer never ready')), 15000)
          readyResolve = () => {
            clearTimeout(to)
            resolve()
          }
          child.on('error', reject)
        })
        // Snapshot in a tight loop while the writer hammers away.
        const snaps: string[][] = []
        for (let s = 0; s < 8; s++) {
          const snap = join(dir, `par-${s}.db`)
          vacuumIntoSnapshot(db, snap)
          const d = new DatabaseSync(snap, { readOnly: true })
          try {
            d.exec('PRAGMA query_only = ON')
            expect((d.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe(
              'ok',
            )
            snaps.push(
              (d.prepare(`SELECT key FROM entities ORDER BY key`).all() as Array<{ key: string }>).map((r) => r.key),
            )
          } finally {
            d.close()
          }
        }
        await new Promise<void>((resolve, reject) => {
          const to = setTimeout(() => reject(new Error('writer never done')), 90000)
          doneResolve = () => {
            clearTimeout(to)
            resolve()
          }
          if (childOut.includes('DONE')) doneResolve()
          child.on('error', reject)
          // 'close' (not 'exit'): stdio flushed AND handles released —
          // on Windows a read right after 'exit' can still see a lock.
          child.on('close', (code) => {
            if (code !== 0) {
              clearTimeout(to)
              reject(new Error(`writer exit ${code}`))
              return
            }
            // Exit can fire before the trailing stdout chunk arrives:
            // re-check after a beat instead of trusting exit alone.
            setTimeout(() => {
              if (childOut.includes('DONE')) {
                if (doneResolve) doneResolve()
              } else reject(new Error('writer exited without DONE'))
            }, 500)
          })
        })
        // Explicit checkpoints in the child: one logged CKPT marker per
        // iteration (invocation proof); frame-level effect is proven
        // separately in the deterministic checkpoint test.
        const ckpts = (childOut.match(/^CKPT \d+$/gm) ?? []).length
        expect(ckpts).toBe(15)
        // Overlap proof: at least one snapshot landed mid-flight (partial,
        // neither seed-only nor complete) — without overlap this fails.
        const counts = snaps.map((k) => k.length)
        expect(counts.some((c) => c > 1 && c < 16)).toBe(true)
        // Prefix proof: every snapshot holds exactly seed + par keys 1..m
        // for some m (no gaps, no extras) — order-independent sets.
        for (const keys of snaps) {
          expect(keys).toContain('par seed')
          const nums = keys
            .filter((k) => k !== 'par seed')
            .map((k) => Number(k.replace('par key ', '')))
            .sort((a, b) => a - b)
          expect(nums).toEqual(Array.from({ length: nums.length }, (_, i) => i + 1))
        }
        // Own-mutation separation: the source holds exactly seed + 15 writer rows.
        // Bounded retries: Windows may hold the file lock briefly after child teardown.
        let all: string[] = []
        let locked = true
        for (let attempt = 0; attempt < 50 && locked; attempt++) {
          const d = new DatabaseSync(db, { readOnly: true })
          try {
            d.exec('PRAGMA query_only = ON')
            all = (d.prepare(`SELECT key FROM entities ORDER BY key`).all() as Array<{ key: string }>).map(
              (r) => r.key,
            )
            locked = false
          } catch (e) {
            if (!(e instanceof Error) || !/locked/i.test(e.message)) throw e
            await new Promise((r) => setTimeout(r, 200))
          } finally {
            d.close()
          }
        }
        expect(locked).toBe(false)
        expect(all.length).toBe(16)
      } finally {
        child.kill()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    },
    120_000,
  )

  it('checkpoints observably move frames between consistent snapshots', () => {
    const dir = tempDir('ittop-probe-ckpt-')
    try {
      const { db, key } = initVault(dir)
      write(db, key, 'decision', 'ckpt seed', { content: 'seed' })
      // Uncheckpointed frames from a held-open writer (no close yet).
      const writer = new DatabaseSync(db)
      const walSize = (): number => {
        try {
          return statSync(db + '-wal').size
        } catch {
          return -1
        }
      }
      try {
        writer.exec('CREATE TABLE IF NOT EXISTS ck_junk (i INTEGER)')
        writer.exec(`INSERT INTO ck_junk VALUES (1), (2), (3)`)
        const walBefore = walSize()
        expect(walBefore).toBeGreaterThan(0)
        vacuumIntoSnapshot(db, join(dir, 'pre.db'))
        // Explicit checkpoint moves the frames: observable file behavior,
        // no pragma-accounting interpretation involved.
        const cp = new DatabaseSync(db)
        try {
          cp.exec('PRAGMA wal_checkpoint(TRUNCATE)')
        } finally {
          cp.close()
        }
        expect(walSize()).toBeLessThan(walBefore)
        vacuumIntoSnapshot(db, join(dir, 'post.db'))
        for (const f of ['pre.db', 'post.db']) {
          const s = new DatabaseSync(join(dir, f), { readOnly: true })
          try {
            s.exec('PRAGMA query_only = ON')
            expect(
              (s.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check,
            ).toBe('ok')
          } finally {
            s.close()
          }
        }
        // Same logical content before/after the checkpoint.
        expect(snapshotDb(join(dir, 'post.db'))).toBe(snapshotDb(join(dir, 'pre.db')))
      } finally {
        writer.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('vacuumIntoSnapshot leaves main and WAL bytes identical with WAL data present', () => {
    const dir = tempDir('ittop-probe-waldata-')
    try {
      const { db } = initVault(dir)
      // Writer stays OPEN with uncheckpointed frames: the WAL provably
      // holds committed user data here (not just coordination).
      const writer = new DatabaseSync(db)
      try {
        writer.exec('CREATE TABLE scratch (a TEXT)')
        writer.exec(`INSERT INTO scratch VALUES ('x'), ('y')`)
        expect(statSync(db + '-wal').size).toBeGreaterThan(0)
        const readBytes = (f: string): string | null => {
          try {
            return readFileSync(f).toString('base64')
          } catch {
            return null
          }
        }
        const mainBefore = readBytes(db)
        const walBefore = readBytes(db + '-wal')
        const shmBefore = readBytes(db + '-shm')
        vacuumIntoSnapshot(db, join(dir, 'w.db'))
        // Main + WAL bytes identical; SHM (WAL-Index/Koordination) may change
        // and is tracked separately — it holds no user data.
        expect(readBytes(db)).toBe(mainBefore)
        expect(readBytes(db + '-wal')).toBe(walBefore)
        const shmAfter = readBytes(db + '-shm')
        // Separately tracked invariant: snapshotting never REMOVES sidecars
        // (absent→created is normal coordination, never user-data loss).
        expect(shmBefore === null || shmAfter !== null).toBe(true)
        const s = new DatabaseSync(join(dir, 'w.db'), { readOnly: true })
        try {
          s.exec('PRAGMA query_only = ON')
          expect((s.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe(
            'ok',
          )
          expect(
            (s.prepare(`SELECT COUNT(*) AS n FROM scratch`).get() as { n: number }).n,
          ).toBe(2)
        } finally {
          s.close()
        }
      } finally {
        writer.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('vacuumIntoSnapshot leaves source data bytes identical', () => {
    const dir = tempDir('ittop-probe-quiet-')
    try {
      const { db } = initVault(dir)
      // Only the main DB file holds user data. Opening any SQLite DB
      // creates -wal/-shm coordination sidecars (empty, no user data) —
      // asserting THOSE identical would forbid merely opening the file.
      const readMain = (): string => readFileSync(db).toString('base64')
      const walBytes = (): number => {
        try {
          return readFileSync(db + '-wal').length
        } catch {
          return -1
        }
      }
      const before = readMain()
      vacuumIntoSnapshot(db, join(dir, 'q.db'))
      expect(readMain()).toBe(before)
      expect(walBytes()).toBeLessThanOrEqual(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('copies a vault DB with history intact', async () => {
    const dir = tempDir('ittop-probe-trio-')
    try {
      const { db, key } = initVault(dir)
      write(db, key, 'decision', 'trio probe', { content: 'v1' })
      write(db, key, 'decision', 'trio probe', { content: 'v2' })
      const copy = join(dir, 'c.db')
      vacuumIntoSnapshot(db, copy)
      expect(snapshotDb(copy)).toBe(snapshotDb(db))
      const d = new DatabaseSync(copy, { readOnly: true })
      try {
        d.exec('PRAGMA query_only = ON')
        // CLI write-replay builds history: the superseded V1 lives in
        // entity_history, the current version in entities (bodies stay
        // encrypted — presence, not content, is asserted).
        const n = (
          d.prepare(`SELECT COUNT(*) AS n FROM entity_history WHERE key = 'trio probe'`).get() as { n: number }
        ).n
        expect(n).toBeGreaterThanOrEqual(1)
        const live = (
          d.prepare(`SELECT key FROM entities WHERE key = 'trio probe'`).get() as { key: string }
        ).key
        expect(live).toBe('trio probe')
      } finally {
        d.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('documents the MCP write path: proposed without admission, links work', async () => {
    const userDataDir = tempDir('ittop-probe-write-')
    const manager = new VaultManager({ userDataDir, binaryPath: 'perseus-vault' })
    try {
      await manager.ensureGlobal()
      // Bare remember lands in proposed (no admission envelope) — history
      // stays empty: replay-via-remember CANNOT transfer history depth.
      // History transfer needs the CLI authority path (see trio test).
      const first = (await manager.call('global', 'perseus_vault_remember', {
        category: 'decision',
        key: 'probe replay',
        body_json: JSON.stringify({ content: 'version one' }),
      })) as { id?: string; disposition?: string }
      expect(first.disposition).toBe('pending_approval')
      const second = (await manager.call('global', 'perseus_vault_remember', {
        category: 'decision',
        key: 'probe replay',
        body_json: JSON.stringify({ content: 'version two' }),
      })) as { id?: string }
      expect(second.id).toBe(first.id)
      const history = (await manager.call('global', 'perseus_vault_history', {
        category: 'decision',
        key: 'probe replay',
        limit: 10,
      })) as { total?: number }
      expect(history.total).toBe(0)
      await manager.call('global', 'perseus_vault_remember', {
        category: 'decision',
        key: 'probe other',
        body_json: JSON.stringify({ content: 'other' }),
      })
      // Deterministic target id straight from the table (no guessing).
      const global = pathsForDb(userDataDir, 'global')
      const ids = new DatabaseSync(global.dbFile, { readOnly: true })
      let otherId = ''
      try {
        ids.exec('PRAGMA query_only = ON')
        otherId = (
          ids.prepare(`SELECT id FROM entities WHERE key = 'probe other'`).get() as { id: string }
        ).id
      } finally {
        ids.close()
      }
      expect(otherId).not.toBe('')
      await manager.call('global', 'perseus_vault_link', {
        from_category: 'decision',
        from_key: 'probe replay',
        to_id: otherId,
      })
      const d = new DatabaseSync(global.dbFile, { readOnly: true })
      try {
        d.exec('PRAGMA query_only = ON')
        const links = (
          d.prepare(`SELECT links FROM entities WHERE key = 'probe replay'`).get() as { links: string | null }
        ).links
        expect(links ?? '').toContain(otherId)
      } finally {
        d.close()
      }
    } finally {
      await manager.stopAll().catch(() => undefined)
      rmSync(userDataDir, { recursive: true, force: true })
    }
  })
})
