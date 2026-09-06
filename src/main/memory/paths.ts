import { join } from 'path'

export interface VaultPaths {
  dbFile: string
  keyFile: string
}

export const GLOBAL_DB_ID = 'global'

export function workspaceDbId(workspaceId: string): string {
  return `workspace:${validateWorkspaceId(workspaceId)}`
}

// Strict validation against the ittop Workspace.id contract (uuidv4):
// no lossy sanitizing, so two different ids can never share one DB file,
// and Windows device names (CON, NUL, COM1, …) cannot slip through.
// Lowercased: the DB lives on case-insensitive filesystems (Windows/macOS).
// 'global' is unreachable (not a UUID) but rejected explicitly for clarity.
export function validateWorkspaceId(id: string): string {
  if (typeof id !== 'string') throw new Error('invalid workspace id for vault path')
  const normalized = id.toLowerCase()
  if (normalized === GLOBAL_DB_ID) throw new Error("workspace id 'global' is reserved")
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(normalized)) {
    throw new Error('invalid workspace id for vault path: must be a UUID')
  }
  return normalized
}

// Layout: <userData>/vault/global.db + <userData>/vault/workspaces/<id>.db
// Keys in sibling dirs (global.key vs workspaces/<id>.key) until the
// OS-keystore adapter lands (Phase 1 full).
export function vaultDir(userDataDir: string): string {
  return join(userDataDir, 'vault')
}

export function globalVaultPaths(userDataDir: string): VaultPaths {
  return {
    dbFile: join(vaultDir(userDataDir), 'global.db'),
    keyFile: join(vaultDir(userDataDir), 'keys', 'global.key'),
  }
}

export function workspaceVaultPaths(userDataDir: string, workspaceId: string): VaultPaths {
  const id = validateWorkspaceId(workspaceId)
  return {
    dbFile: join(vaultDir(userDataDir), 'workspaces', `${id}.db`),
    keyFile: join(vaultDir(userDataDir), 'keys', 'workspaces', `${id}.key`),
  }
}

export function pathsForDb(userDataDir: string, db: string): VaultPaths {
  if (db === GLOBAL_DB_ID) return globalVaultPaths(userDataDir)
  const prefix = 'workspace:'
  if (db.startsWith(prefix)) return workspaceVaultPaths(userDataDir, db.slice(prefix.length))
  throw new Error(`unknown vault db id: ${db}`)
}
