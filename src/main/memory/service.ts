import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { VaultManager, type VaultProcessFactory } from './vaultManager'
import type { VaultPaths } from './paths'

export interface VaultStatusFile {
  version: 1
  db: string
  dbFile: string
  pid: number | null
  operational: boolean
  updatedAt: string
  endedClean?: boolean
  error?: string
}

// Test-only hooks (honored only when set; never in normal operation):
// - ITTOP_VAULT_TEST_DRAIN_DELAY_MS: sleep before the shutdown drain.
// - ITTOP_VAULT_TEST_FAIL_STOP: throw after the real drain (error-path wiring).
// - ITTOP_VAULT_TEST_ABORT_DRAIN: fail the drain WITHOUT awaiting it — the
//   real teardown continues in the background. Simulates a vault failure
//   mid-drain while the child still exits on its own.
const TEST_DRAIN_DELAY_MS = Number(process.env.ITTOP_VAULT_TEST_DRAIN_DELAY_MS ?? 0)
const TEST_FAIL_STOP = process.env.ITTOP_VAULT_TEST_FAIL_STOP === '1'
const TEST_ABORT_DRAIN = process.env.ITTOP_VAULT_TEST_ABORT_DRAIN === '1'

export interface VaultServiceDeps {
  userDataDir: string
  binaryPath: string
  isEnabled: () => boolean
  createClient?: VaultProcessFactory
  initDb?: (paths: VaultPaths) => Promise<void>
  log?: (message: string) => void
}

// Lifecycle owner for the embedded memory vaults (global DB for now).
// Default-off: while disabled no child is spawned and no DB/key file is
// created. Enablement only ever uses isolated userData paths — the manager
// has no fallback to any pre-existing vault database.
//
// All operations are serialized through one queue: reconcile and shutdown
// can never overlap, so at most one manager (one child per DB) exists.
// shutdown() is irreversible and never rejects: a failed drain keeps the
// reference (restart-blocked) instead of dropping it, and the error is kept
// on fault for the Ops surface.
export class VaultMemoryService {
  private manager: VaultManager | null = null
  private op: Promise<void> | null = null
  private shutDown = false
  private lastError: Error | null = null
  private killSwitch = false

  constructor(private readonly deps: VaultServiceDeps) {}

  setKillSwitch(active: boolean): void {
    this.killSwitch = active
    if (active) {
      this.manager?.stopAll().catch(() => undefined)
    }
  }

  isKillSwitchActive(): boolean {
    return this.killSwitch || this.shutDown
  }

  get active(): boolean {
    return this.manager !== null
  }

  get fault(): Error | null {
    return this.lastError
  }

  /** Read-side accessor for the Phase-4 screen backend (broker fan-out).
   * Null while disabled or not reconciled — callers fail closed on null. */
  getManager(): VaultManager | null {
    return this.manager
  }

  reconcile(): Promise<void> {
    if (this.shutDown) return Promise.resolve()
    const prev = this.op ?? Promise.resolve()
    const next = prev.then(() => this.doReconcile(), () => this.doReconcile())
    const tracked: Promise<void> = next.then(
      () => undefined,
      () => undefined,
    )
    this.op = tracked
    void tracked.finally(() => {
      if (this.op === tracked) this.op = null
    })
    // reconcile reports via fault/log, never via rejection (callers use void).
    return next.then(
      () => undefined,
      () => undefined,
    )
  }

  async shutdown(): Promise<void> {
    this.shutDown = true // irreversible, set synchronously: later reconciles no-op
    const prev = this.op ?? Promise.resolve()
    const next = prev.then(() => this.shutdownLocked(), () => this.shutdownLocked())
    const tracked: Promise<void> = next.then(
      () => undefined,
      () => undefined,
    )
    this.op = tracked
    void tracked.finally(() => {
      if (this.op === tracked) this.op = null
    })
    return next.then(
      () => undefined,
      () => undefined,
    )
  }

  private async doReconcile(): Promise<void> {
    if (this.shutDown) return
    if (!this.deps.isEnabled()) {
      await this.shutdownLocked()
      return
    }
    if (!this.manager) {
      this.manager = new VaultManager({
        userDataDir: this.deps.userDataDir,
        binaryPath: this.deps.binaryPath,
        createClient: this.deps.createClient,
        initDb: this.deps.initDb,
      })
    }
    try {
      await this.manager.ensureGlobal()
    } catch (e) {
      this.lastError = e instanceof Error ? e : new Error(String(e))
      this.deps.log?.(`memory vault global DB not ready: ${this.lastError.message}`)
    }
    this.writeStatus(this.manager, this.lastError)
  }

  private async shutdownLocked(): Promise<void> {
    const manager = this.manager
    if (!manager) return
    try {
      if (TEST_DRAIN_DELAY_MS > 0) {
        await new Promise((r) => setTimeout(r, TEST_DRAIN_DELAY_MS))
      }
      if (TEST_ABORT_DRAIN) {
        // Fail fast WITHOUT awaiting: the real drain continues in the
        // background and must still reap the child (asserted in E2E).
        void manager.stopAll().then(
          () => undefined,
          (e: unknown) => {
            this.lastError = e instanceof Error ? e : new Error(String(e))
          },
        )
        throw new Error('test hook: vault drain aborted mid-flight')
      }
      await manager.stopAll()
      if (TEST_FAIL_STOP) throw new Error('test hook: vault stop failure')
    } catch (e) {
      // Keep the reference: dropping it would orphan a live child and a
      // retry would spawn a second manager beside it.
      this.lastError = e instanceof Error ? e : new Error(String(e))
      this.deps.log?.(`memory vault shutdown failed, reference kept: ${this.lastError.message}`)
      this.writeStatus(manager, this.lastError)
      return
    }
    if (this.manager === manager) this.manager = null
    this.writeStatus(null, null)
  }

  // Machine-readable Ops/status artifact for the app itself (future
  // Memory-Screen) and for E2E ownership proofs. Atomic write; isolated
  // userData paths only.
  private writeStatus(manager: VaultManager | null, error: Error | null): void {
    try {
      const dir = join(this.deps.userDataDir, 'vault')
      mkdirSync(dir, { recursive: true })
      const operational = manager !== null && error === null && manager.stateOf('global') === 'ready'
      const status: VaultStatusFile = {
        version: 1,
        db: 'global',
        dbFile: join(dir, 'global.db'),
        pid: manager?.pidOf('global') ?? null,
        operational,
        updatedAt: new Date().toISOString(),
        ...(manager === null ? { endedClean: true } : {}),
        ...(error ? { error: error.message } : {}),
      }
      const tmp = join(dir, 'global.status.json.tmp')
      writeFileSync(tmp, JSON.stringify(status, null, 2), 'utf-8')
      renameSync(tmp, join(dir, 'global.status.json'))
    } catch (e) {
      this.deps.log?.(`memory vault status write failed: ${(e as Error).message}`)
    }
  }
}

// Production bundles ship the binary under resources/bin/<platform>/;
// dev and missing-bundle cases fall back to PATH resolution at spawn time
// (a missing binary surfaces as degraded/backoff, never as a crash).
export function resolveVaultBinary(
  isPackaged: boolean,
  resourcesPath: string,
  exists: (path: string) => boolean,
): string {
  if (isPackaged) {
    const platformDir = process.platform === 'win32' ? 'win32' : 'darwin'
    const binary = process.platform === 'win32' ? 'perseus-vault.exe' : 'perseus-vault'
    const bundled = `${resourcesPath}/bin/${platformDir}/${binary}`
    if (exists(bundled)) return bundled
  }
  return process.platform === 'win32' ? 'perseus-vault.exe' : 'perseus-vault'
}
