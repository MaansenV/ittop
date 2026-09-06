import { describe, expect, it } from 'vitest'
import { normalizeVaultDbPath } from '../vaultManager'
import {
  GLOBAL_DB_ID,
  globalVaultPaths,
  pathsForDb,
  vaultDir,
  workspaceDbId,
  workspaceVaultPaths,
} from '../paths'

describe('vault paths', () => {
  it('lays out global and workspace DBs under userData/vault', () => {
    const id = '11111111-1111-4111-8111-111111111111'
    expect(vaultDir('UD')).toContain('vault')
    expect(globalVaultPaths('UD').dbFile).toContain('global.db')
    expect(workspaceVaultPaths('UD', id).dbFile).toContain(`${id}.db`)
    expect(workspaceVaultPaths('UD', id).keyFile).toContain(`${id}.key`)
  })

  it('keeps global and workspace keys in separate dirs', () => {
    const id = '11111111-1111-4111-8111-111111111111'
    expect(globalVaultPaths('UD').keyFile).not.toContain('workspaces')
    expect(workspaceVaultPaths('UD', id).keyFile).toContain('workspaces')
  })

  it('rejects hostile, empty, long, reserved and non-UUID ids', () => {
    for (const bad of [
      '../evil',
      'a/b',
      'abc',
      '',
      'x'.repeat(65),
      'global',
      'Global',
      'CON',
      'NUL',
      'COM1',
      'ABC',
    ]) {
      expect(() => workspaceVaultPaths('UD', bad), bad).toThrow()
    }
  })

  it('accepts UUIDs and normalizes case', () => {
    const id = '11111111-1111-4111-8111-111111111111'
    expect(workspaceVaultPaths('UD', id.toUpperCase()).dbFile).toContain(`${id}.db`)
    expect(workspaceDbId(id.toUpperCase())).toBe(`workspace:${id}`)
  })

  it('namespaces manager ids', () => {
    expect(GLOBAL_DB_ID).toBe('global')
    expect(pathsForDb('UD', 'workspace:11111111-1111-4111-8111-111111111111').dbFile).toContain(
      '11111111-1111-4111-8111-111111111111.db',
    )
    expect(() => pathsForDb('UD', 'nope')).toThrow()
    expect(() => pathsForDb('UD', 'workspace:abc')).toThrow()
  })

  it('never rewrites backslashes on POSIX', () => {
    if (process.platform === 'win32') {
      expect(normalizeVaultDbPath('C:/a/b.db')).toBe('c:\\a\\b.db')
      return
    }
    expect(normalizeVaultDbPath('/tmp/a\\b.db')).toBe('/tmp/a\\b.db')
    expect(normalizeVaultDbPath('/tmp/a\\b.db')).not.toBe(normalizeVaultDbPath('/tmp/a/b.db'))
  })
})
