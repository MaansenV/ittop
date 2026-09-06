import { spawn, type ChildProcess } from 'node:child_process'

export class VaultRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message)
    this.name = 'VaultRpcError'
  }
}

// A tool ran but reported failure (MCP result.isError) — distinct from a
// transport-level JSON-RPC error. Callers must NOT treat this as success.
export class VaultToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VaultToolError'
  }
}

// stop() gave up waiting: the child may still be alive. The reference is kept
// (never silently dropped) so later stops keep trying instead of reporting a
// false clean shutdown. The OS reaps the orphan on app exit at the latest.
export class VaultZombieError extends Error {
  constructor(
    public readonly pid: number | undefined,
    message: string,
  ) {
    super(message)
    this.name = 'VaultZombieError'
  }
}

export type VaultClientState = 'idle' | 'starting' | 'ready' | 'stopping' | 'stopped'

export interface VaultClientOptions {
  requestTimeoutMs?: number
  maxFrameBytes?: number
  maxBufferedBytes?: number
  maxPending?: number
  maxWriteBufferedBytes?: number
  killGraceMs?: number
  killDeadlineMs?: number
  serverName?: string
  // Test seam: replace the child invocation (default: binary serve --db --encryption-key).
  spawn?: { command: string; args: string[]; env?: NodeJS.ProcessEnv }
  // Fired when the child dies unexpectedly (never after stop()).
  onUnexpectedExit?: (code: number | null) => void
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
  generation: number
}

const DEFAULT_TIMEOUT_MS = 30000
const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_PENDING = 64
const DEFAULT_MAX_WRITE_BUFFERED_BYTES = 1024 * 1024
const DEFAULT_KILL_GRACE_MS = 3000
const DEFAULT_KILL_DEADLINE_MS = 5000
const EXPECTED_SERVER_NAME = 'perseus-vault'
const SUPPORTED_PROTOCOL_VERSIONS = ['2024-11-05', '2025-06-18']

// Newline-delimited JSON-RPC stdio client for `perseus-vault serve`.
// One instance owns its child end to end: explicit states, coalesced
// start/stop (including starts queued during stopping — exactly one follow-up
// child), generation-bound close handling. No reconnect, no retries:
// a timed-out write has UNKNOWN outcome and must never be resent blindly.
export class VaultClient {
  private proc: ChildProcess | null = null
  private state: VaultClientState = 'idle'
  private generation = 0
  private buf = ''
  private nextId = 0
  private readonly pending = new Map<number, Pending>()
  private startPromise: Promise<void> | null = null
  private stopPromise: Promise<void> | null = null
  private queuedStart: Promise<void> | null = null
  private restartQueued = false
  private lastFault: Error | null = null

  constructor(
    private readonly binaryPath: string,
    private readonly dbFile: string,
    private readonly keyFile: string,
    private readonly opts: VaultClientOptions = {},
  ) {}

  get currentState(): VaultClientState {
    return this.state
  }

  get running(): boolean {
    return this.state === 'ready'
  }

  get childPid(): number | undefined {
    return this.proc?.pid
  }

  get pid(): number | undefined {
    return this.childPid
  }

  get fault(): Error | null {
    return this.lastFault
  }

  start(): Promise<void> {
    if (this.state === 'ready') return Promise.resolve()
    if (this.startPromise) return this.startPromise
    if (this.state === 'stopping') {
      // Queue exactly one follow-up start behind the drain; concurrent
      // starters share it. A renewed stop() cancels it (see stop()).
      this.restartQueued = true
      if (!this.queuedStart) {
        // NB: stop() may have settled uncleanly (stopPromise cleared); then
        // retry the drain instead of resolving without a start.
        const drain = this.stopPromise ?? this.runDrain()
        this.queuedStart = drain
          .then(() => {
            if (!this.restartQueued) throw new Error('vault start aborted by stop')
            this.restartQueued = false
            this.startPromise = this.doStart().finally(() => {
              this.startPromise = null
            })
            return this.startPromise
          })
          .finally(() => {
            this.queuedStart = null
          })
      }
      return this.queuedStart
    }
    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  stop(): Promise<void> {
    if (this.state === 'idle' || this.state === 'stopped') return Promise.resolve()
    // A renewed stop wins over a queued restart: no new child after this drain.
    this.restartQueued = false
    if (this.stopPromise) return this.stopPromise
    return this.runDrain()
  }

  private runDrain(): Promise<void> {
    const ongoingStart = this.state === 'starting' ? this.startPromise : null
    // Abort an in-flight handshake fast: bump the generation AND fail its
    // pending RPCs now, so the drain never waits out a slow server (stale
    // frames arriving later are dropped by the generation guard).
    if (ongoingStart) {
      const aborted = this.generation
      this.generation++
      this.failPending(aborted, new Error('vault start aborted by stop'))
    }
    this.state = 'stopping'
    const p = (async () => {
      try {
        if (ongoingStart) {
          try {
            await ongoingStart
          } catch {
            // Start failure is reported through start(); stop still drains.
          }
        }
        await this.shutdownChild()
      } catch (e) {
        // Cleanup failed: keep the reference, stay visible, report.
        // The next stop() retries against the same child.
        this.lastFault = e instanceof Error ? e : new Error(String(e))
        this.state = 'stopping'
        throw this.lastFault
      }
      this.state = 'stopped'
    })()
    this.stopPromise = p.finally(() => {
      this.stopPromise = null
    })
    return this.stopPromise
  }

  async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.state !== 'ready' || !this.proc) throw new Error('vault client not ready')
    const maxPending = this.opts.maxPending ?? DEFAULT_MAX_PENDING
    if (this.pending.size >= maxPending) throw new Error('vault client pending queue full')
    const msg = (await this.rpc('tools/call', { name: tool, arguments: args })) as {
      result?: { isError?: boolean; structuredContent?: unknown; content?: Array<{ text?: string }> }
    }
    const result = msg.result
    if (result?.isError) {
      const text = result.content?.[0]?.text ?? 'vault tool reported failure'
      throw new VaultToolError(`${tool}: ${text.slice(0, 500)}`)
    }
    if (result?.structuredContent !== undefined) return result.structuredContent
    const text = result?.content?.[0]?.text
    if (typeof text === 'string') {
      try {
        return JSON.parse(text) as unknown
      } catch {
        return text
      }
    }
    return result
  }

  private async doStart(): Promise<void> {
    this.state = 'starting'
    this.generation++
    const generation = this.generation
    this.buf = ''
    const spawnCmd = this.opts.spawn ?? {
      command: this.binaryPath,
      args: ['serve', '--db', this.dbFile, '--encryption-key', this.keyFile],
    }
    let proc: ChildProcess
    try {
      proc = spawn(spawnCmd.command, spawnCmd.args, {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
        env: spawnCmd.env ?? process.env,
      })
    } catch (e) {
      this.state = 'idle'
      throw e instanceof Error ? e : new Error(String(e))
    }
    this.proc = proc
    const exited = new Promise<never>((_, reject) => {
      // 'error' alone proves nothing about liveness (a failed kill on a live
      // process also emits it): reject the start race, but free the reference
      // only on confirmed 'exit'.
      proc.once('error', (err) => {
        this.failPending(generation, err instanceof Error ? err : new Error(String(err)))
        reject(err instanceof Error ? err : new Error(String(err)))
      })
      proc.once('exit', (code) => {
        this.onChildExit(proc, generation, code)
        reject(new Error(`vault exited during start (code ${code})`))
      })
    })
    // Persistent guard: every LATER error on the same child must also be
    // observed — an unobserved 'error' event would crash the Electron host.
    // It only fails pending calls; liveness is decided by 'exit' alone.
    proc.on('error', (err) => {
      if (this.proc !== proc || this.generation !== generation) return
      this.failPending(generation, err instanceof Error ? err : new Error(String(err)))
    })
    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (d: string) => this.onData(d, generation))
    proc.stdout?.on('error', (err) => {
      // Stream failure: the child is going away; fail pending calls now and
      // let 'exit' confirm the end (reference freed only there).
      this.failPending(generation, new Error(`vault stdout error: ${(err as Error).message}`))
    })
    proc.stdin?.on('error', (err) => {
      this.failPending(generation, new Error(`vault stdin error: ${(err as Error).message}`))
    })
    try {
      const hello = (await Promise.race([
        this.rpc('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'ittop', version: '0' },
        }),
        exited,
      ])) as {
        result?: { protocolVersion?: unknown; serverInfo?: { name?: unknown } }
      }
      const serverName = this.opts.serverName ?? EXPECTED_SERVER_NAME
      if (
        typeof hello?.result?.protocolVersion !== 'string' ||
        !SUPPORTED_PROTOCOL_VERSIONS.includes(hello.result.protocolVersion) ||
        hello.result.serverInfo?.name !== serverName
      ) {
        throw new Error('vault handshake failed: unexpected server identity')
      }
      if (this.proc !== proc || this.generation !== generation || this.state !== 'starting') {
        throw new Error('vault start superseded')
      }
      this.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      this.state = 'ready'
    } catch (e) {
      // Cleanup failure here must NOT resolve to idle with a dropped reference:
      // keep the child, park in 'stopping' (no stopPromise), record both errors.
      // The next start()/stop() retries the drain against the same child.
      const original = e instanceof Error ? e : new Error(String(e))
      try {
        await this.shutdownChild()
      } catch (cleanupError) {
        const ce = cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError))
        this.lastFault = new Error(`vault start failed (${original.message}); cleanup failed: ${ce.message}`)
        this.state = 'stopping'
        throw this.lastFault
      }
      if (this.state === 'starting') this.state = 'idle'
      throw original
    }
  }

  private async shutdownChild(): Promise<void> {
    const proc = this.proc
    if (!proc || proc.exitCode !== null) {
      this.proc = null
      this.failPending(this.generation, new Error('vault client stopped'))
      return
    }
    this.failPending(this.generation, new Error('vault client stopped'))
    const exited = new Promise<void>((resolve) => {
      proc.once('exit', () => resolve())
    })
    let signaled: boolean
    try {
      signaled = proc.kill()
    } catch {
      signaled = false
    }
    if (!signaled) {
      // Lost the race with a concurrent exit: confirmed end, no failure.
      if (proc.exitCode !== null) {
        this.proc = null
        return
      }
      throw new Error('vault kill signal rejected by OS')
    }
    const graceMs = this.opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS
    const deadlineMs = this.opts.killDeadlineMs ?? DEFAULT_KILL_DEADLINE_MS
    if (await this.waitFor(exited, graceMs)) {
      this.proc = null
      return
    }
    try {
      signaled = proc.kill('SIGKILL')
    } catch {
      signaled = false
    }
    if (!signaled) {
      if (proc.exitCode !== null) {
        this.proc = null
        return
      }
      throw new Error('vault SIGKILL rejected by OS')
    }
    if (await this.waitFor(exited, deadlineMs)) {
      this.proc = null
      return
    }
    // Still alive: keep the reference (never silently drop a live child) and
    // report. The next stop() retries against the same process.
    throw new VaultZombieError(proc.pid, 'vault child did not exit after SIGKILL')
  }

  private waitFor(p: Promise<void>, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), ms)
      t.unref?.()
      void p.then(() => {
        clearTimeout(t)
        resolve(true)
      })
    })
  }

  private onChildExit(proc: ChildProcess, generation: number, code: number | null): void {
    if (this.proc !== proc || this.generation !== generation) return // stale child
    this.proc = null
    this.failPending(generation, new Error(`vault exited unexpectedly (code ${code})`))
    if (this.state === 'ready' || this.state === 'starting') {
      this.state = 'idle'
      this.opts.onUnexpectedExit?.(code)
    }
  }

  private failPending(generation: number, err: Error): void {
    for (const [id, p] of this.pending) {
      if (p.generation !== generation) continue
      this.pending.delete(id)
      clearTimeout(p.timer)
      p.reject(err)
    }
  }

  private send(frame: unknown): void {
    const stdin = this.proc?.stdin
    if (!stdin) throw new Error('vault client not running')
    const wire = `${JSON.stringify(frame)}\n`
    const maxBuffered = this.opts.maxWriteBufferedBytes ?? DEFAULT_MAX_WRITE_BUFFERED_BYTES
    if (stdin.writableLength + Buffer.byteLength(wire, 'utf8') > maxBuffered) {
      throw new Error('vault client write backpressure: child is not draining stdin')
    }
    try {
      stdin.write(wire)
    } catch (e) {
      throw e instanceof Error ? e : new Error(String(e))
    }
  }

  private rpc(method: string, params: unknown): Promise<unknown> {
    const timeoutMs = this.opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS
    return new Promise((resolve, reject) => {
      if (!this.proc || (this.state !== 'starting' && this.state !== 'ready')) {
        reject(new Error('vault client not running'))
        return
      }
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`vault RPC timeout: ${method}`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer, generation: this.generation })
      try {
        this.send({ jsonrpc: '2.0', id, method, params })
      } catch (e) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  private onData(chunk: string, generation: number): void {
    if (generation !== this.generation) return // stale child frames
    const maxFrame = this.opts.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES
    this.buf += chunk // stdout uses utf8 encoding: split multibyte chars arrive intact
    if (Buffer.byteLength(this.buf, 'utf8') > 2 * maxFrame) {
      this.failPending(generation, new Error('vault read buffer over limit'))
      this.recordStopFault()
      this.buf = ''
      return
    }
    let idx: number
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim()
      this.buf = this.buf.slice(idx + 1)
      if (!line) continue
      if (Buffer.byteLength(line, 'utf8') > maxFrame) {
        this.failPending(generation, new Error('vault frame too large'))
        this.recordStopFault()
        continue
      }
      let msg: { id?: number; result?: unknown; error?: { code?: number; message?: string } }
      try {
        msg = JSON.parse(line) as typeof msg
      } catch {
        continue
      }
      if (msg.id === undefined) continue
      const p = this.pending.get(msg.id)
      if (!p || p.generation !== generation) continue
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new VaultRpcError(msg.error.code ?? -1, msg.error.message ?? 'vault error'))
      else p.resolve(msg)
    }
  }

  // Oversize-input shutdown runs outside any caller's await chain: record the
  // outcome instead of dropping it with void.
  private recordStopFault(): void {
    this.stop().then(
      () => undefined,
      (e: unknown) => {
        this.lastFault = e instanceof Error ? e : new Error(String(e))
      },
    )
  }
}
