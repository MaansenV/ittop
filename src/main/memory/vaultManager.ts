import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { VaultClient } from './vaultClient'
import {
  GLOBAL_DB_ID,
  pathsForDb,
  workspaceDbId,
  type VaultPaths,
} from './paths'

export type VaultDbId = string // 'global' or 'workspace:<uuid>' (see paths.ts)
export type VaultState = 'stopped' | 'starting' | 'ready' | 'degraded' | 'backoff' | 'stopping'

export interface VaultProcess {
  readonly running: boolean
  readonly pid?: number
  start(): Promise<void>
  call(tool: string, args: Record<string, unknown>): Promise<unknown>
  stop(): Promise<void>
}

export type VaultProcessFactory = (
  paths: VaultPaths,
  onUnexpectedExit: (code: number | null) => void,
) => VaultProcess

// Minimal init-child contract (real ChildProcess satisfies it structurally).
// The manager owns the process: abort on stop/deadline, confirm termination.
export interface InitProc {
  readonly exitCode: number | null
  readonly pid?: number | undefined
  kill(signal?: NodeJS.Signals): boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  once(event: 'exit' | 'error', listener: (...args: any[]) => void): unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: 'exit' | 'error', listener: (...args: any[]) => void): unknown
}

export type InitProcessFactory = (paths: VaultPaths) => InitProc

export interface VaultManagerOptions {
  userDataDir: string
  binaryPath: string
  keyFile?: string
  baseBackoffMs?: number
  maxBackoffMs?: number
  crashWindowMs?: number
  maxCrashesInWindow?: number
  createClient?: VaultProcessFactory
  // Registry duty override (tests inject a no-op; default shells out to `init`).
  initDb?: (paths: VaultPaths) => Promise<void>
  initTimeoutMs?: number
  createInitProcess?: InitProcessFactory
}

interface Entry {
  state: VaultState
  client: VaultProcess | null
  startPromise: Promise<void> | null
  stopPromise: Promise<void> | null
  crashAt: number[]
  backoffTimer: NodeJS.Timeout | null
  generation: number
  initProc: InitProc | null
  initAbort: (() => void) | null
}

interface HealthDetail {
  status?: string
  db_path?: string
}

const BASE_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30000
const INIT_TIMEOUT_MS = 30000
const INIT_KILL_GRACE_MS = 3000
const INIT_KILL_DEADLINE_MS = 5000
const CRASH_WINDOW_MS = 5 * 60 * 1000
const MAX_CRASHES_IN_WINDOW = 3

// Owns exactly one child process per open DB (global + one per workspace).
// Isolated skeleton: NOT wired into index.ts, no migration, no maintenance,
// no broker writes. Operational = health.status === 'healthy' against the
// EXPECTED database file (an empty store reports ready:false, which is a
// valid operating state — Phase-0 evidence).
export class VaultManager {
  private readonly entries = new Map<VaultDbId, Entry>()
  private stopAllPromise: Promise<void> | null = null
  private shutDown = false

  constructor(private readonly opts: VaultManagerOptions) {}

  stateOf(db: VaultDbId): VaultState {
    return this.entries.get(db)?.state ?? 'stopped'
  }

  // Crashes inside the current window (same threshold as backoff decisions).
  // Diagnostics surface for the Ops view; tests use it to prove that stale
  // health responses add no crash.
  crashCount(db: VaultDbId): number {
    const entry = this.entries.get(db)
    if (!entry) return 0
    const windowMs = this.opts.crashWindowMs ?? CRASH_WINDOW_MS
    const now = Date.now()
    return entry.crashAt.filter((t) => now - t < windowMs).length
  }

  pidOf(db: VaultDbId): number | undefined {
    return this.entries.get(db)?.client?.pid
  }

  // Scoped tool call for the broker/screen layer: ensures the DB, then
  // re-validates the caller's liveness guard AFTER the (possibly slow)
  // ensure and dispatches synchronously — no await sits between the guard
  // and the dispatch, so revocation races cannot slip a call through.
  // INTERNAL ONLY — never expose via IPC/MCP without broker authorization.
  async call(
    db: VaultDbId,
    tool: string,
    args: Record<string, unknown>,
    guard?: () => void,
  ): Promise<unknown> {
    const entry = this.getOrCreate(db)
    if (entry.state !== 'ready' || !entry.client) {
      await this.ensure(db)
    }
    guard?.()
    const client = this.entries.get(db)?.client
    if (!client) throw new Error(`vault '${db}' not available`)
    return client.call(tool, args)
  }

  /**
   * Browse-path call: NEVER ensures/inits — a stopped or missing vault
   * stays untouched (no DB file, no key file, no child process). Throws
   * when not ready; callers report the DB as missing instead of creating
   * it. The screenApi existence pre-check is UX only (noStore vs empty);
   * THIS is the hard no-create guarantee (covers check-then-act races and
   * missing keys).
   */
  async callIfReady(
    db: VaultDbId,
    tool: string,
    args: Record<string, unknown>,
    guard?: () => void,
  ): Promise<unknown> {
    const entry = this.entries.get(db)
    if (!entry || entry.state !== 'ready' || !entry.client) {
      throw new Error(`vault '${db}' not ready (browse creates nothing)`)
    }
    guard?.()
    const client = this.entries.get(db)?.client
    if (!client) throw new Error(`vault '${db}' not available`)
    return client.call(tool, args)
  }

  async ensureGlobal(): Promise<void> {
    await this.ensure(GLOBAL_DB_ID)
  }

  async ensureWorkspace(workspaceId: string): Promise<void> {
    await this.ensure(workspaceDbId(workspaceId))
  }

  /**
   * Existing-only boot for the browse path: starts the child on a store
   * that is already there, REFUSES to create one. The existence decision
   * lives here (manager), not at the caller — no check-then-act gap
   * across components. existingOnly threads into runInit so even a boot
   * racing an external deletion aborts instead of initializing.
   * Missing key files are rejected too (serve would fail without one;
   * creating keys is a registry duty, never a read side effect).
   * Proven boundary (binary 2.23.2, temp paths): `serve` on a missing DB
   * creates an EMPTY db file but then dies in encryption setup without a
   * key (no key ever created, no data path). The identity guard below
   * covers the remaining race (DB deleted, key kept): ANY store created
   * during this boot — by vendor open-mode or anyone else — is refused
   * on THIS call (child stopped, never served from this boot); a retry
   * re-verifies from scratch. Never deleted: it may belong to a
   * concurrent legitimate ensure.
   * Documented exception (user-delegated risk acceptance): if an EXTERNAL
   * actor deletes the DB mid-boot, the vendor recreates an empty file;
   * the first call refuses it (proven), but a LATER browse accepts the
   * leftover as the current (empty) store. This loosens the absolute
   * no-create requirement for exactly this external-delete race.
   */
  async bootExisting(db: VaultDbId): Promise<void> {
    const paths = pathsForDb(this.opts.userDataDir, db) // throws on unknown ids
    const before = storeIdentity(paths.dbFile)
    if (!before) {
      throw new Error(`vault '${db}' has no store (browse creates nothing)`)
    }
    if (!existsSync(paths.keyFile)) {
      throw new Error(`vault '${db}' has no key (browse creates nothing)`)
    }
    const t0 = Date.now()
    await this.ensureInner(db, true)
    if (storeChangedAfter(paths.dbFile, t0, before)) {
      await this.stop(db).catch(() => undefined)
      throw new Error(`vault '${db}' store changed during boot (not served)`)
    }
  }

  async stopWorkspace(workspaceId: string): Promise<void> {
    await this.stop(workspaceDbId(workspaceId))
  }

  async health(db: VaultDbId): Promise<{ operational: boolean; state: VaultState; detail: unknown }> {
    const entry = this.entries.get(db)
    if (!entry || entry.state !== 'ready' || !entry.client?.running) {
      return { operational: false, state: entry?.state ?? 'stopped', detail: null }
    }
    // Pin client + generation: a late response after stop/restart must neither
    // report operational nor degrade the (possibly new) entry.
    const client = entry.client
    const generation = entry.generation
    const fresh = (): boolean => entry.generation === generation && entry.client === client
    let detail: HealthDetail | null
    try {
      detail = (await client.call('perseus_vault_health', {})) as HealthDetail | null
    } catch (e) {
      if (!fresh()) {
        return { operational: false, state: entry.state, detail: { error: 'stale health response ignored' } }
      }
      if (entry.state !== 'ready') {
        // A sibling call already degraded us: no extra crash count, no mutation.
        return { operational: false, state: entry.state, detail: { error: 'health settled after state change' } }
      }
      this.noteCrash(entry)
      entry.state = 'degraded'
      return { operational: false, state: 'degraded', detail: { error: (e as Error).message } }
    }
    if (!fresh()) {
      return { operational: false, state: entry.state, detail: { error: 'stale health response ignored' } }
    }
    if (entry.state !== 'ready') {
      // A sibling call degraded us while this RPC was in flight: never revive.
      return { operational: false, state: entry.state, detail: { error: 'health settled after state change' } }
    }
    try {
      const paths = pathsForDb(this.opts.userDataDir, db)
      verifyDetail(db, paths.dbFile, detail)
      return { operational: true, state: 'ready', detail }
    } catch (e) {
      this.noteCrash(entry)
      entry.state = 'degraded'
      return { operational: false, state: 'degraded', detail: { error: (e as Error).message } }
    }
  }

  // Shared, coalesced drain: stop(), stopAll() and degraded-cleanup all await
  // the SAME transition — concurrent callers can never double-stop or
  // start-while-draining. A failed drain keeps the client reference, marks
  // degraded and rethrows: restart stays blocked until cleanup succeeds.
  private drain(entry: Entry, resetCrashes: boolean): Promise<void> {
    if (entry.stopPromise) return entry.stopPromise
    entry.generation++
    // Abort a blocked init FIRST so the drain never waits out its timeout:
    // startAttempt observes the generation change and bails without backoff.
    entry.initAbort?.()
    entry.initAbort = null
    if (entry.backoffTimer) {
      clearTimeout(entry.backoffTimer)
      entry.backoffTimer = null
    }
    if (entry.state === 'stopped') return Promise.resolve()
    entry.state = 'stopping'
    const ongoingStart = entry.startPromise
    const p = (async () => {
      try {
        if (ongoingStart) await ongoingStart.catch(() => undefined)
        await this.killInitProc(entry)
        await entry.client?.stop()
      } catch (e) {
        entry.state = 'degraded'
        entry.stopPromise = null
        throw e instanceof Error ? e : new Error(String(e))
      }
      entry.client = null
      entry.initProc = null
      entry.initAbort = null
      if (resetCrashes) entry.crashAt = []
      entry.state = 'stopped'
      entry.startPromise = null
      entry.stopPromise = null
    })()
    entry.stopPromise = p
    return p
  }

  async stop(db: VaultDbId): Promise<void> {
    const entry = this.entries.get(db)
    if (!entry) return
    await this.drain(entry, true)
  }

  async stopAll(): Promise<void> {
    if (this.stopAllPromise) return this.stopAllPromise
    this.shutDown = true
    const p = (async () => {
      await Promise.all([...this.entries.keys()].map((db) => this.stop(db)))
    })()
    this.stopAllPromise = p
    try {
      await p
    } finally {
      this.stopAllPromise = null
    }
  }

  private getOrCreate(db: VaultDbId): Entry {
    let entry = this.entries.get(db)
    if (!entry) {
      entry = {
        state: 'stopped',
        client: null,
        startPromise: null,
        stopPromise: null,
        crashAt: [],
        backoffTimer: null,
        generation: 0,
        initProc: null,
        initAbort: null,
      }
      this.entries.set(db, entry)
    }
    return entry
  }

  private async ensure(db: VaultDbId): Promise<void> {
    await this.ensureInner(db, false)
  }

  private async ensureInner(db: VaultDbId, existingOnly: boolean): Promise<void> {
    if (this.shutDown) throw new Error('vault manager is shut down')
    const paths = pathsForDb(this.opts.userDataDir, db) // throws on unknown ids
    const entry = this.getOrCreate(db)
    if (entry.state === 'ready') {
      if (entry.client?.running) return
      entry.state = 'stopped' // died underneath us; restart below
    }
    if (entry.state === 'starting') {
      await entry.startPromise
      return this.assertReady(db, entry)
    }
    if (entry.state === 'backoff') throw new Error(`vault '${db}' is backing off, retry later`)
    if (entry.state === 'stopping') {
      await entry.stopPromise
      if (this.shutDown) throw new Error('vault manager is shut down')
      return this.ensureInner(db, existingOnly)
    }
    if (entry.state === 'degraded') {
      try {
        await this.drain(entry, false)
      } catch (e) {
        throw new Error(`vault '${db}' cleanup failed, restart blocked: ${(e as Error).message}`)
      }
      if (this.shutDown) throw new Error('vault manager is shut down')
    }
    entry.generation++ // fresh attempt generation: stale exit callbacks can't clear the new client
    const generation = entry.generation
    entry.state = 'starting'
    entry.startPromise = this.startAttempt(db, paths, entry, generation, existingOnly)
    try {
      await entry.startPromise
    } finally {
      if (entry.startPromise) entry.startPromise = null
    }
    if (entry.generation !== generation) throw new Error(`vault '${db}' stopped during start`)
    return this.assertReady(db, entry)
  }

  private assertReady(db: VaultDbId, entry: Entry): void {
    if (entry.state !== 'ready' || !entry.client?.running) {
      throw new Error(`vault '${db}' failed to start (state ${entry.state})`)
    }
  }

  private async startAttempt(
    db: VaultDbId,
    paths: VaultPaths,
    entry: Entry,
    generation: number,
    existingOnly = false,
  ): Promise<void> {
    try {
      await this.runInit(db, paths, entry, existingOnly)
    } catch (e) {
      // A generation change means stop() owns this entry now: its drain kills
      // the init child. Otherwise kill it here; a failed cleanup keeps the
      // reference and blocks restart instead of leaking a live child.
      if (entry.generation !== generation) return
      try {
        await this.killInitProc(entry)
      } catch (killErr) {
        entry.state = 'degraded'
        throw new Error(
          `vault '${db}' init failed (${(e as Error).message}) and init cleanup failed, restart blocked: ${(killErr as Error).message}`,
        )
      }
      this.toBackoff(entry)
      throw e
    }
    // A stop during init must not birth a stillborn child: re-check first.
    if (entry.generation !== generation || this.shutDown) return
    let client: VaultProcess
    try {
      const factory = this.opts.createClient
      client =
        factory?.(paths, (code) => this.onProcessExit(db, generation, code)) ??
        new VaultClient(this.opts.binaryPath, paths.dbFile, this.opts.keyFile ?? paths.keyFile, {
          onUnexpectedExit: (code) => this.onProcessExit(db, generation, code),
        })
    } catch (e) {
      this.toBackoff(entry)
      throw e
    }
    entry.client = client
    try {
      await client.start()
      if (entry.generation !== generation || this.shutDown) return // drain() owns the client now
      const detail = (await client.call('perseus_vault_health', {})) as HealthDetail | null
      verifyDetail(db, paths.dbFile, detail)
      if (entry.generation !== generation || this.shutDown) return // drain() owns the client now
      entry.state = 'ready'
    } catch (e) {
      try {
        await client.stop()
      } catch (cleanupError) {
        // Cleanup failed: keep the reference, block restart, report both.
        entry.client = client
        entry.state = 'degraded'
        throw new Error(
          `vault '${db}' failed (${(e as Error).message}) and cleanup failed, restart blocked: ${(cleanupError as Error).message}`,
        )
      }
      if (entry.client === client) entry.client = null
      if (entry.generation !== generation) return
      this.toBackoff(entry)
      throw e
    }
  }

  // Registry duty: a workspace gets its DB on first use. `init` is idempotent
  // for existing DBs (key file reused as-is, never overwritten).  // The init child is OWNED: abort on stop/deadline, confirm termination.
  // A failed cleanup keeps the reference and blocks restart (via drain).
  private async runInit(db: VaultDbId, paths: VaultPaths, entry: Entry, existingOnly = false): Promise<void> {
    if (existsSync(paths.dbFile)) return
    // Existing-only boot racing an external deletion: abort, never init.
    if (existingOnly) throw new Error(`vault '${db}' has no store (browse creates nothing)`)
    const ms = this.opts.initTimeoutMs ?? INIT_TIMEOUT_MS
    if (this.opts.initDb) {
      // Injected (tests): no child to own; the timeout still bounds the wait.
      await this.raceInit(this.opts.initDb(paths), ms, db, entry)
      return
    }
    // `init` creates the file but no parent dirs — the registry owns layout.
    mkdirSync(dirname(paths.dbFile), { recursive: true })
    mkdirSync(dirname(paths.keyFile), { recursive: true })
    const child = this.opts.createInitProcess
      ? this.opts.createInitProcess(paths)
      : spawn(this.opts.binaryPath, ['init', '--db', paths.dbFile, '--key-file', paths.keyFile], {
          stdio: 'ignore',
          windowsHide: true,
        })
    entry.initProc = child
    // Persistent guard: EVERY error on the init child must be observed — an
    // unobserved 'error' event would crash the Electron host. Errors never
    // count as exit; the reference lives until confirmed termination.
    child.on('error', () => undefined)
    // NB: initProc is cleared ONLY by killInitProc (the killer) or on clean
    // exit below — never here: after an abort/timeout the drain still has to
    // kill the child, and after a failure startAttempt's catch does.
    try {
      await this.raceInit(this.waitInitExit(child, paths), ms, db, entry)
    } finally {
      entry.initAbort = null
    }
  }

  private raceInit(work: Promise<void>, ms: number, db: VaultDbId, entry: Entry): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`vault '${db}' init timed out`)), ms)
      t.unref?.()
      entry.initAbort = () => {
        clearTimeout(t)
        reject(new Error(`vault '${db}' init aborted by stop`))
      }
      void work.then(
        () => {
          clearTimeout(t)
          entry.initAbort = null
          resolve()
        },
        (e: unknown) => {
          clearTimeout(t)
          entry.initAbort = null
          reject(e instanceof Error ? e : new Error(String(e)))
        },
      )
    })
  }

  private waitInitExit(child: InitProc, paths: VaultPaths): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (child.exitCode !== null) {
        if (child.exitCode === 0) resolve()
        else reject(new Error(`vault init exited with code ${child.exitCode} for ${paths.dbFile}`))
        return
      }
      child.once('exit', (code: unknown) => {
        if (code === 0) resolve()
        else reject(new Error(`vault init exited with code ${code as number} for ${paths.dbFile}`))
      })
      child.once('error', (err: unknown) => {
        reject(err instanceof Error ? err : new Error(String(err)))
      })
    })
  }

  private async killInitProc(entry: Entry): Promise<void> {
    const child = entry.initProc
    entry.initProc = null
    entry.initAbort = null
    if (!child || child.exitCode !== null) return
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
    })
    const stillAlive = (): boolean => child.exitCode === null
    let signaled: boolean
    try {
      signaled = child.kill()
    } catch {
      signaled = false
    }
    // Lost the race with a concurrent exit: confirmed end, no failure.
    if (!signaled && !stillAlive()) return
    if (!signaled) {
      entry.initProc = child // keep: a later stop retries against the same child
      throw new Error('vault init kill signal rejected by OS')
    }
    if (await this.waitForMs(exited, INIT_KILL_GRACE_MS)) return
    try {
      signaled = child.kill('SIGKILL')
    } catch {
      signaled = false
    }
    if (!signaled && !stillAlive()) return
    if (!signaled) {
      entry.initProc = child
      throw new Error('vault init SIGKILL rejected by OS')
    }
    if (await this.waitForMs(exited, INIT_KILL_DEADLINE_MS)) return
    entry.initProc = child // keep: never silently drop a live child
    throw new Error('vault init child did not exit after SIGKILL')
  }

  private waitForMs(p: Promise<void>, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), ms)
      t.unref?.()
      void p.then(() => {
        clearTimeout(t)
        resolve(true)
      })
    })
  }

  private onProcessExit(db: VaultDbId, generation: number, _code: number | null): void {
    const entry = this.entries.get(db)
    if (!entry || entry.generation !== generation) return // stale child
    if (entry.state !== 'ready' && entry.state !== 'starting') return
    entry.client = null
    entry.state = 'degraded'
    this.noteCrash(entry)
    if (entry.crashAt.length >= (this.opts.maxCrashesInWindow ?? MAX_CRASHES_IN_WINDOW)) {
      this.toBackoff(entry)
    }
  }

  private noteCrash(entry: Entry): void {
    const windowMs = this.opts.crashWindowMs ?? CRASH_WINDOW_MS
    const now = Date.now()
    entry.crashAt = [...entry.crashAt.filter((t) => now - t < windowMs), now]
  }

  private toBackoff(entry: Entry): void {
    const base = this.opts.baseBackoffMs ?? BASE_BACKOFF_MS
    const max = this.opts.maxBackoffMs ?? MAX_BACKOFF_MS
    const delay = Math.min(max, base * 2 ** Math.min(entry.crashAt.length, 10))
    entry.state = 'backoff'
    const timer = setTimeout(() => {
      entry.backoffTimer = null
      if (!this.shutDown && entry.state === 'backoff') entry.state = 'stopped'
    }, delay)
    timer.unref?.()
    entry.backoffTimer = timer
  }
}

function platformNormalize(s: string): string {
  if (process.platform === 'win32') {
    return s.replace(/^\\\\\?\\/, '').replace(/\//g, '\\').toLowerCase()
  }
  return s // POSIX: backslashes are legal filename chars — never rewrite
}

function isAbsoluteDbPath(s: string): boolean {
  if (process.platform === 'win32') return /^[a-zA-Z]:\\/.test(s) || s.startsWith('\\\\')
  return s.startsWith('/')
}

// Exact absolute-path equality. The server-reported path must itself be
// absolute (no resolve() on untrusted input); the expected side comes from
// our own config. A missing db_path is rejected: without it the manager
// cannot prove which database answers.
export function verifyDetail(db: string, expectedDbFile: string, detail: HealthDetail | null): void {
  if (detail?.status !== 'healthy') throw new Error(`vault '${db}' unhealthy`)
  if (typeof detail?.db_path !== 'string' || detail.db_path.length === 0) {
    throw new Error(`vault '${db}' health hides its database path`)
  }
  if (!isAbsoluteDbPath(detail.db_path)) {
    throw new Error(`vault '${db}' reported a non-absolute database path`)
  }
  if (platformNormalize(resolve(expectedDbFile)) !== platformNormalize(detail.db_path)) {
    throw new Error(`vault '${db}' serves unexpected database`)
  }
}

export function normalizeVaultDbPath(s: string): string {
  return platformNormalize(resolve(s))
}

/**
 * Boot-race guard (pure, unit-tested): true when the store file was
 * (re)created at or after t0 — i.e. NOT the file verified before boot.
 * Compares birthtime AND file index (ino): NTFS tunneling reuses the
 * birthtime on quick delete+recreate, but the index always changes.
 * `>=` deliberately: a same-millisecond creation refuses once (safe — a
 * retry re-verifies) while no genuine pre-existing store can match.
 * Vanished files (or a missing baseline) refuse as well.
 */
export interface StoreIdentity {
  birthtimeMs: number
  ino: number
}

export function storeIdentity(dbFile: string): StoreIdentity | null {
  try {
    const s = statSync(dbFile)
    return { birthtimeMs: s.birthtimeMs, ino: s.ino }
  } catch {
    return null
  }
}

export function storeChangedAfter(dbFile: string, t0: number, before: StoreIdentity | null): boolean {
  if (!before) return true
  let after: StoreIdentity
  try {
    const s = statSync(dbFile)
    after = { birthtimeMs: s.birthtimeMs, ino: s.ino }
  } catch {
    return true
  }
  if (after.birthtimeMs >= t0) return true
  return after.ino !== before.ino
}
