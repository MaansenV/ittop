import { describe, expect, it } from 'vitest'
import { SessionRegistry, assertCanRead, canWriteGrant } from '../capabilities'

const WS = '11111111-1111-4111-8111-111111111111'
const WS2 = '22222222-2222-4222-8222-222222222222'

describe('session capabilities', () => {
  it('defaults to home workspace + global reads, no writes', () => {
    const reg = new SessionRegistry()
    const h = reg.open(WS, {})
    const grant = reg.resolve(h)
    expect(grant.workspaceDb).toBe(`workspace:${WS}`)
    expect([...grant.readDbs]).toEqual([`workspace:${WS}`, 'global'])
    expect(canWriteGrant(grant, `workspace:${WS}`)).toBe(false)
    expect(canWriteGrant(grant, 'global')).toBe(false)
  })

  it('adds explicitly granted workspaces and dedupes', () => {
    const reg = new SessionRegistry()
    const h = reg.open(WS, { extraWorkspaceIds: [WS2, WS2, WS] })
    expect([...reg.resolve(h).readDbs]).toEqual([`workspace:${WS}`, 'global', `workspace:${WS2}`])
  })

  it('supports global-free sessions', () => {
    const reg = new SessionRegistry()
    expect([...reg.resolve(reg.open(WS, { includeGlobal: false })).readDbs]).toEqual([
      `workspace:${WS}`,
    ])
  })

  it('rejects invalid and reserved workspace ids', () => {
    const reg = new SessionRegistry()
    expect(() => reg.open('nope', {})).toThrow()
    expect(() => reg.open('global', {})).toThrow()
    expect(() => reg.open(WS, { extraWorkspaceIds: ['global'] })).toThrow()
  })

  it('rejects unknown handles — nothing is synthesized', () => {
    const reg = new SessionRegistry()
    expect(() => reg.resolve('sess_forged')).toThrow(/unknown memory session/)
    expect(() => reg.check('sess_forged', 'global')).toThrow(/unknown memory session/)
    expect(reg.canWrite('sess_forged', 'global')).toBe(false)
  })

  it('revocation blocks reads and writes; close forgets entirely', () => {
    const reg = new SessionRegistry()
    const h = reg.open(WS, { mayWriteWorkspace: true })
    reg.revoke(h)
    expect(() => reg.check(h, `workspace:${WS}`)).toThrow(/revoked/)
    expect(reg.canWrite(h, `workspace:${WS}`)).toBe(false)
    reg.close(h)
    expect(() => reg.resolve(h)).toThrow(/unknown memory session/)
  })

  it('grants are frozen: tampering throws instead of widening access', () => {
    const reg = new SessionRegistry()
    const h = reg.open(WS, {})
    const grant = reg.resolve(h)
    expect(Object.isFrozen(grant)).toBe(true)
    expect(Object.isFrozen(grant.readDbs)).toBe(true)
    expect(() => {
      ;(grant.readDbs as string[]).push(`workspace:${WS2}`)
    }).toThrow()
    expect(() => assertCanRead(grant, `workspace:${WS2}`)).toThrow(/may not read/)
  })

  it('foreign workspaces are unreadable without a grant', () => {
    const reg = new SessionRegistry()
    const h = reg.open(WS, {})
    expect(() => reg.check(h, `workspace:${WS2}`)).toThrow(/may not read/)
    const h2 = reg.open(WS, { extraWorkspaceIds: [WS2] })
    expect(() => reg.check(h2, `workspace:${WS2}`)).not.toThrow()
  })

  it('honors the workspace write flag, never global', () => {
    const reg = new SessionRegistry()
    const h = reg.open(WS, { mayWriteWorkspace: true })
    const grant = reg.resolve(h)
    expect(canWriteGrant(grant, `workspace:${WS}`)).toBe(true)
    expect(canWriteGrant(grant, 'global')).toBe(false)
    expect(canWriteGrant(grant, `workspace:${WS2}`)).toBe(false)
    expect(reg.canWrite(h, `workspace:${WS}`)).toBe(true)
  })
})
