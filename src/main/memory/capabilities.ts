import { randomUUID } from 'node:crypto'
import { GLOBAL_DB_ID, workspaceDbId } from './paths'

export type VaultDbId = string // 'global' or 'workspace:<uuid>'

export type SessionPurpose = 'screen' | 'screen_promote' | 'terminal_mcp' | 'test'

const MAX_TTL_MS: Record<SessionPurpose, number> = {
  screen: 8 * 3600 * 1000,
  screen_promote: 15 * 60 * 1000,
  terminal_mcp: 24 * 3600 * 1000,
  test: 3600 * 1000,
}

const DEFAULT_TTL_MS: Record<SessionPurpose, number> = {
  screen: 2 * 3600 * 1000,
  screen_promote: 5 * 60 * 1000,
  terminal_mcp: 8 * 3600 * 1000,
  test: 60 * 1000,
}

const DEFAULT_MAX_CALLS_PER_MINUTE: Record<SessionPurpose, number> = {
  screen: 120,
  screen_promote: 30,
  terminal_mcp: 60,
  test: 100,
}

const DEFAULT_MAX_CALLS_PER_SESSION: Record<SessionPurpose, number> = {
  screen: 1000,
  screen_promote: 50,
  terminal_mcp: 500,
  test: 500,
}

const DEFAULT_MAX_CALLS_PER_DAY: Record<SessionPurpose, number> = {
  screen: 5000,
  screen_promote: 200,
  terminal_mcp: 2000,
  test: 1000,
}

export interface SessionGrant {
  readonly id: string
  readonly purpose: SessionPurpose
  readonly createdAt: number
  readonly expiresAt: number // mandatory finite expiry
  readonly generation: number
  /** Home workspace DB this session is bound to. */
  readonly workspaceDb: VaultDbId
  /** Exact set of readable DBs (home + global + explicitly granted extras). */
  readonly readDbs: readonly VaultDbId[]
  readonly mayWriteWorkspace: boolean
  readonly mayWriteGlobal: boolean
  readonly mayPromote: boolean
  readonly maxCallsPerMinute: number // mandatory finite bound
  readonly maxCallsPerSession: number // mandatory finite bound
  readonly maxCallsPerDay: number // mandatory finite bound
}

export interface SessionScopeOptions {
  /** Purpose of the session: screen reads vs promote writes vs terminal MCP. */
  purpose?: SessionPurpose
  /** Time to live in milliseconds; bounded by purpose max. */
  ttlMs?: number
  /** Additional cross-workspace DBs by workspace UUID (explicit user grant). */
  extraWorkspaceIds?: string[]
  /** Default true: the shared user-level DB is granted. */
  includeGlobal?: boolean
  mayWriteWorkspace?: boolean
  mayWriteGlobal?: boolean
  mayPromote?: boolean
  maxCallsPerMinute?: number
  maxCallsPerSession?: number
  maxCallsPerDay?: number
}

interface BudgetState {
  callCountTotal: number
  callCountMinute: number
  minuteWindowStart: number
}

interface WorkspaceDayBudget {
  callCountDay: number
  dayWindowStart: number
}

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionGrant>()
  private readonly revokedIds = new Set<string>()
  private readonly budgets = new Map<string, BudgetState>()
  private readonly workspaceDayBudgets = new Map<string, WorkspaceDayBudget>()
  private generation = 0
  private killSwitchActive = false

  constructor(private readonly getExternalKillSwitch?: () => boolean) {}

  setKillSwitch(active: boolean): void {
    this.killSwitchActive = active
    if (active) {
      this.revokeAll()
    }
  }

  isKillSwitchActive(): boolean {
    return this.killSwitchActive || (this.getExternalKillSwitch?.() === true)
  }

  open(workspaceId: string, opts: SessionScopeOptions = {}): string {
    if (this.isKillSwitchActive()) throw new Error('memory vault kill-switch is active')
    const workspaceDb = workspaceDbId(workspaceId) // throws on invalid/reserved ids

    const purpose = opts.purpose ?? 'screen'

    // Enforce purpose constraints: terminal_mcp is strictly read-only
    if (purpose === 'terminal_mcp') {
      if (opts.mayWriteWorkspace === true || opts.mayWriteGlobal === true || opts.mayPromote === true) {
        throw new Error("purpose 'terminal_mcp' is strictly read-only and may not receive write or promote grants")
      }
    }
    if (purpose === 'screen' && opts.mayPromote === true) {
      throw new Error("purpose 'screen' may not receive promote grants (use purpose 'screen_promote')")
    }

    const readDbs: VaultDbId[] = [workspaceDb]
    if (opts.includeGlobal !== false) readDbs.push(GLOBAL_DB_ID)
    for (const extra of opts.extraWorkspaceIds ?? []) {
      const db = workspaceDbId(extra)
      if (!readDbs.includes(db)) readDbs.push(db)
    }

    const now = Date.now()
    const rawTtl = typeof opts.ttlMs === 'number' && Number.isFinite(opts.ttlMs) ? opts.ttlMs : DEFAULT_TTL_MS[purpose]
    const boundedTtl = rawTtl <= 0 ? rawTtl : Math.min(rawTtl, MAX_TTL_MS[purpose])
    const expiresAt = now + boundedTtl

    const maxCallsPerMinute = typeof opts.maxCallsPerMinute === 'number' && opts.maxCallsPerMinute > 0
      ? opts.maxCallsPerMinute
      : DEFAULT_MAX_CALLS_PER_MINUTE[purpose]
    const maxCallsPerSession = typeof opts.maxCallsPerSession === 'number' && opts.maxCallsPerSession > 0
      ? opts.maxCallsPerSession
      : DEFAULT_MAX_CALLS_PER_SESSION[purpose]
    const maxCallsPerDay = typeof opts.maxCallsPerDay === 'number' && opts.maxCallsPerDay > 0
      ? opts.maxCallsPerDay
      : DEFAULT_MAX_CALLS_PER_DAY[purpose]

    const grant: SessionGrant = {
      id: `sess_${randomUUID().replace(/-/g, '')}`,
      purpose,
      createdAt: now,
      expiresAt,
      generation: ++this.generation,
      workspaceDb,
      readDbs: Object.freeze([...readDbs]),
      mayWriteWorkspace: opts.mayWriteWorkspace === true,
      mayWriteGlobal: opts.mayWriteGlobal === true,
      mayPromote: opts.mayPromote === true,
      maxCallsPerMinute,
      maxCallsPerSession,
      maxCallsPerDay,
    }
    Object.freeze(grant)
    this.sessions.set(grant.id, grant)
    this.budgets.set(grant.id, {
      callCountTotal: 0,
      callCountMinute: 0,
      minuteWindowStart: now,
    })
    return grant.id
  }

  resolve(handle: string): SessionGrant {
    const grant = this.sessions.get(handle)
    if (!grant) throw new Error('unknown memory session')
    return grant
  }

  revoke(handle: string): void {
    if (this.sessions.has(handle)) this.revokedIds.add(handle)
  }

  isRevoked(handle: string): boolean {
    return this.revokedIds.has(handle)
  }

  isExpired(grant: SessionGrant, now: number = Date.now()): boolean {
    return now > grant.expiresAt
  }

  check(handle: string, db: VaultDbId): SessionGrant {
    if (this.isKillSwitchActive()) throw new Error('memory vault kill-switch is active')
    const grant = this.resolve(handle)
    if (this.isRevoked(handle)) throw new Error(`session '${handle}' is revoked`)
    if (this.isExpired(grant)) throw new Error(`session '${handle}' has expired`)
    assertCanRead(grant, db)
    this.consumeBudget(grant)
    return grant
  }

  assertLive(handle: string): SessionGrant {
    if (this.isKillSwitchActive()) throw new Error('memory vault kill-switch is active')
    const grant = this.resolve(handle)
    if (this.isRevoked(handle)) throw new Error(`session '${handle}' is revoked`)
    if (this.isExpired(grant)) throw new Error(`session '${handle}' has expired`)
    return grant
  }

  assertCanPromote(handle: string, db: VaultDbId): SessionGrant {
    if (this.isKillSwitchActive()) throw new Error('memory vault kill-switch is active')
    const grant = this.assertLive(handle)
    if (!grant.mayPromote) throw new Error(`session '${handle}' has no promote grant`)
    if (!canWriteGrant(grant, db)) throw new Error(`session '${handle}' may not write to '${db}'`)
    this.consumeBudget(grant)
    return grant
  }

  canWrite(handle: string, db: VaultDbId): boolean {
    if (this.isKillSwitchActive()) return false
    const grant = this.sessions.get(handle)
    if (!grant || this.isRevoked(handle) || this.isExpired(grant)) return false
    return canWriteGrant(grant, db)
  }

  private consumeBudget(grant: SessionGrant): void {
    const budget = this.budgets.get(grant.id)
    if (!budget) return
    const now = Date.now()
    if (now - budget.minuteWindowStart >= 60_000) {
      budget.callCountMinute = 0
      budget.minuteWindowStart = now
    }

    let wsDay = this.workspaceDayBudgets.get(grant.workspaceDb)
    if (!wsDay || now - wsDay.dayWindowStart >= 86_400_000) {
      wsDay = { callCountDay: 0, dayWindowStart: now }
      this.workspaceDayBudgets.set(grant.workspaceDb, wsDay)
    }

    if (budget.callCountMinute >= grant.maxCallsPerMinute) {
      throw new Error(`session '${grant.id}' exceeded rate limit (${grant.maxCallsPerMinute}/min)`)
    }
    if (wsDay.callCountDay >= grant.maxCallsPerDay) {
      throw new Error(`workspace '${grant.workspaceDb}' exceeded daily call budget (${grant.maxCallsPerDay}/day)`)
    }
    if (budget.callCountTotal >= grant.maxCallsPerSession) {
      throw new Error(`session '${grant.id}' exceeded session call budget (${grant.maxCallsPerSession})`)
    }
    budget.callCountTotal += 1
    budget.callCountMinute += 1
    wsDay.callCountDay += 1
  }

  /**
   * Revokes all sessions bound to a workspace OR holding cross-workspace grants
   * to that workspace synchronously.
   */
  revokeWorkspace(workspaceId: string): number {
    const targetDb = workspaceDbId(workspaceId)
    let count = 0
    for (const [id, grant] of this.sessions.entries()) {
      if ((grant.workspaceDb === targetDb || grant.readDbs.includes(targetDb)) && !this.revokedIds.has(id)) {
        this.revokedIds.add(id)
        count += 1
      }
    }
    return count
  }

  revokeAll(): void {
    for (const id of this.sessions.keys()) {
      this.revokedIds.add(id)
    }
  }

  close(handle: string): void {
    this.sessions.delete(handle)
    this.revokedIds.delete(handle)
    this.budgets.delete(handle)
  }

  get size(): number {
    return this.sessions.size
  }
}

export function assertCanRead(grant: SessionGrant, db: VaultDbId): void {
  if (!grant.readDbs.includes(db)) {
    throw new Error(`session '${grant.id}' may not read '${db}'`)
  }
}

export function canWriteGrant(grant: SessionGrant, db: VaultDbId): boolean {
  if (db === grant.workspaceDb) return grant.mayWriteWorkspace
  if (db === GLOBAL_DB_ID) return grant.mayWriteGlobal
  return false
}
