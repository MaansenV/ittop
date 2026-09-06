import { randomUUID } from 'node:crypto'
import { GLOBAL_DB_ID, workspaceDbId } from './paths'

export type VaultDbId = string // 'global' or 'workspace:<uuid>'

// A session grant. Grants live ONLY in the SessionRegistry and are handed
// out as opaque handle strings — the broker never accepts a caller-built
// capability object, so forged readDbs or flipped flags cannot smuggle
// access. Records and their DB lists are frozen at creation; revocation
// lives beside them (freezing + later mutation would throw in strict mode).
export interface SessionGrant {
  readonly id: string
  /** Home workspace DB this session is bound to. */
  readonly workspaceDb: VaultDbId
  /** Exact set of readable DBs (home + global + explicitly granted extras). */
  readonly readDbs: readonly VaultDbId[]
  readonly mayWriteWorkspace: boolean
  readonly mayWriteGlobal: boolean
  readonly mayPromote: boolean
}

export interface SessionScopeOptions {
  /** Additional cross-workspace DBs by workspace UUID (explicit user grant). */
  extraWorkspaceIds?: string[]
  /** Default true: the shared user-level DB is granted. */
  includeGlobal?: boolean
  mayWriteWorkspace?: boolean
}

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionGrant>()
  private readonly revokedIds = new Set<string>()

  open(workspaceId: string, opts: SessionScopeOptions = {}): string {
    const workspaceDb = workspaceDbId(workspaceId) // throws on invalid/reserved ids
    const readDbs: VaultDbId[] = [workspaceDb]
    if (opts.includeGlobal !== false) readDbs.push(GLOBAL_DB_ID)
    for (const extra of opts.extraWorkspaceIds ?? []) {
      const db = workspaceDbId(extra)
      if (!readDbs.includes(db)) readDbs.push(db)
    }
    const grant: SessionGrant = {
      id: `sess_${randomUUID().replace(/-/g, '')}`,
      workspaceDb,
      readDbs: Object.freeze([...readDbs]),
      mayWriteWorkspace: opts.mayWriteWorkspace === true,
      mayWriteGlobal: false, // global writes need an explicit separate grant (Phase 3+)
      mayPromote: false, // promotions need an explicit separate grant (Phase 3+)
    }
    Object.freeze(grant)
    this.sessions.set(grant.id, grant)
    return grant.id
  }

  /** Resolves a handle to its grant. Unknown handles throw — never synthesize. */
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

  /** Full gate: unknown → revoked → ungranted, in that order. */
  check(handle: string, db: VaultDbId): SessionGrant {
    const grant = this.resolve(handle)
    if (this.isRevoked(handle)) throw new Error(`session '${handle}' is revoked`)
    assertCanRead(grant, db)
    return grant
  }

  /** Liveness only (unknown or revoked → throw), for post-RPC re-validation. */
  assertLive(handle: string): SessionGrant {
    const grant = this.resolve(handle)
    if (this.isRevoked(handle)) throw new Error(`session '${handle}' is revoked`)
    return grant
  }

  canWrite(handle: string, db: VaultDbId): boolean {
    const grant = this.sessions.get(handle)
    if (!grant || this.isRevoked(handle)) return false
    return canWriteGrant(grant, db)
  }

  /** Forgets a session entirely (handle becomes unknown). */
  close(handle: string): void {
    this.sessions.delete(handle)
    this.revokedIds.delete(handle)
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
