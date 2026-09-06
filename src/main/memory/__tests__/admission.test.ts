import { describe, expect, it } from 'vitest'
import {
  ADMISSION_AUTO_THRESHOLD,
  ADMISSION_REVIEW_THRESHOLD,
  admit,
  redactSecrets,
  scanSecrets,
  type AdmissionCandidate,
} from '../admission'

const WSDB = 'workspace:11111111-1111-4111-8111-111111111111'

function candidate(over: Partial<AdmissionCandidate> = {}): AdmissionCandidate {
  return {
    db: WSDB,
    category: 'decision',
    key: 'k1',
    content: 'Use RecastGraph for the dungeon pathfinding.',
    futureUse: 'Needed whenever pathfinding topology changes in this project.',
    evidence: { sourceRef: 'hook:Stop terminal-3' },
    triggers: ['adding A* support to generated rooms', 'doorway navmesh gaps'],
    ...over,
  }
}

const emptyLookup = { findSameKey: () => [] }

describe('admission policy', () => {
  it('approves a complete candidate', () => {
    const v = admit(candidate(), emptyLookup)
    expect(v.decision).toBe('approve')
    expect(v.score).toBeGreaterThanOrEqual(ADMISSION_AUTO_THRESHOLD)
  })

  it('rejects missing mandatory fields with reasons', () => {
    expect(admit(candidate({ content: '  ' }), emptyLookup).decision).toBe('reject')
    expect(admit(candidate({ futureUse: 'short' }), emptyLookup).decision).toBe('reject')
    expect(admit(candidate({ evidence: { sourceRef: '' } }), emptyLookup).decision).toBe('reject')
    expect(admit(candidate({ triggers: [] }), emptyLookup).decision).toBe('reject')
    expect(admit(candidate({ key: '' }), emptyLookup).decision).toBe('reject')
  })

  it('rejects generic triggers', () => {
    const v = admit(candidate({ triggers: ['beim Programmieren'] }), emptyLookup)
    expect(v.decision).toBe('reject')
    expect(v.reasons.join(' ')).toMatch(/generic/)
  })

  it('finds secrets in every field, multi-hits and partial key blocks', () => {
    const base = candidate()
    expect(admit({ ...base, triggers: ['use AKIAIOSFODNN7EXAMPLE now'] }, emptyLookup).decision).toBe('reject')
    expect(
      admit({ ...base, evidence: { sourceRef: 'x', files: ['AKIAIOSFODNN7EXAMPLE inside'] } }, emptyLookup).decision,
    ).toBe('reject')
    expect(
      admit({ ...base, evidence: { sourceRef: 'x', testProof: 'pwd: s3cr3t!' } }, emptyLookup).decision,
    ).toBe('reject')
    expect(admit({ ...base, key: 'AKIAIOSFODNN7EXAMPLE' }, emptyLookup).decision).toBe('reject')
    const partial = admit(
      { ...base, content: 'leaked block:\n-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKc=' },
      emptyLookup,
    )
    expect(partial.decision).toBe('reject')
    expect(partial.redactedContent).not.toContain('MIIBOgIBAAJBAKc')
    const multi = admit(
      { ...base, content: 'AKIAIOSFODNN7EXAMPLE and AKIAIOSFODNN7EXAMPLE again' },
      emptyLookup,
    )
    expect(multi.decision).toBe('reject')
    expect(multi.redactedContent).not.toContain('AKIA')
    expect(multi.redactedContent?.match(/\[REDACTED:aws-key\]/g)).toHaveLength(2)
  })

  it('rejects secrets and keeps a redacted copy', () => {
    const v = admit(
      candidate({ content: 'Set token: ghp_abcdefghijklmnopqrstuvwxyz1234567890abcd' }),
      emptyLookup,
    )
    expect(v.decision).toBe('reject')
    expect(v.redactedContent).toMatch(/\[REDACTED:github-token\]/)
    expect(scanSecrets('AKIAIOSFODNN7EXAMPLE')).toContain('aws-key')
    expect(redactSecrets('pwd: s3cr3t!')).not.toContain('s3cr3t!')
  })

  it('routes negated completions to review, not auto', () => {
    const v = admit(candidate({ content: 'Door carving not fixed yet, still open.' }), emptyLookup)
    expect(v.decision).toBe('review')
    expect(v.score).toBeLessThan(ADMISSION_AUTO_THRESHOLD)
    expect(v.score).toBeGreaterThanOrEqual(ADMISSION_REVIEW_THRESHOLD)
  })

  it('approves a tight implemented entry with proof', () => {
    const v = admit(
      candidate({
        category: 'implemented',
        key: 'door-carver',
        content: 'DoorNavmeshCarver blocks closed doors.\nVerified in Editor + Play Mode.',
        status: 'done',
        implementedMeta: { testProof: 'E2E paths through both doorways', commit: 'abc1234' },
        triggers: ['door blocks pathfinding'],
      }),
      emptyLookup,
    )
    expect(v.decision).toBe('approve')
  })

  it('rejects structurally invalid shapes instead of scoring them', () => {
    expect(admit(candidate({ triggers: ['a', 'b', 'c', 'd'] }), emptyLookup).decision).toBe('reject')
    expect(
      admit(
        candidate({ category: 'implemented', key: 'x', content: 'ok', status: 'wip', triggers: ['t'] }),
        emptyLookup,
      ).decision,
    ).toBe('reject')
    expect(
      admit(
        candidate({
          category: 'implemented',
          key: 'x',
          content: 'l1\nl2\nl3\nl4',
          status: 'done',
          implementedMeta: { testProof: 't' },
          triggers: ['t'],
        }),
        emptyLookup,
      ).decision,
    ).toBe('reject')
  })

  it('caps unknown categories at review', () => {
    expect(admit(candidate({ category: 'note' }), emptyLookup).decision).toBe('review')
  })

  it('restricts global scope to confirmed user preferences', () => {
    expect(admit(candidate({ db: 'global' }), emptyLookup).decision).toBe('reject')
    const unconfirmed = admit(
      candidate({
        db: 'global',
        category: 'preference',
        key: 'theme',
        content: 'User prefers dark UI.',
        triggers: ['choosing a UI theme'],
      }),
      emptyLookup,
    )
    expect(unconfirmed.decision).toBe('review')
    const confirmed = admit(
      candidate({
        db: 'global',
        category: 'preference',
        key: 'theme',
        content: 'User prefers dark UI.',
        evidence: { sourceRef: 'user statement', confirmedByUser: true },
        triggers: ['choosing a UI theme'],
      }),
      emptyLookup,
    )
    expect(confirmed.decision).toBe('approve')
  })
  it('updates reverted status on the same key instead of deleting', () => {
    const v = admit(
      candidate({
        category: 'implemented',
        key: 'door-carver',
        content: 'DoorNavmeshCarver removed again, bridges are back.',
        status: 'reverted',
        implementedMeta: { commit: 'def5678' },
        triggers: ['door carving history'],
      }),
      emptyLookup,
    )
    expect(['approve', 'review']).toContain(v.decision)
  })

  it('rejects identical content on the same key as no-op', () => {
    const v = admit(candidate(), {
      findSameKey: () => [{ status: 'active', content: candidate().content }],
    })
    expect(v.decision).toBe('reject')
    expect(v.reasons.join(' ')).toMatch(/no-op/)
  })

  it('redacts CRLF partial blocks conservatively (trailing prose may go too)', () => {
    const lines = ['-----BEGIN RSA PRIVATE KEY-----']
    for (let i = 0; i < 40; i++) lines.push(`MIIBOgIBAAJBAKc${i} = `)
    const content = `before\r\n${lines.join('\r\n')}\r\nafter prose here`
    const v = admit(candidate({ content }), emptyLookup)
    expect(v.decision).toBe('reject')
    expect(v.redactedContent).not.toContain('MIIBOgIBAAJBAKc0')
    expect(v.redactedContent).toContain('before')
    // Conservative: the bounded partial rule eats following lines as well —
    // key material must never survive, prose loss is accepted on rejects.
  })

  it('nukes the whole field on over-long truncated blocks', () => {
    const lines = ['-----BEGIN RSA PRIVATE KEY-----']
    for (let i = 0; i < 250; i++) lines.push(`MIIB${i} ====`)
    lines.push('some legitimate trailing note')
    const content = `head\n${lines.join('\n')}`
    expect(scanSecrets(content)).toContain('private-key-overflow')
    const v = admit(candidate({ content }), emptyLookup)
    expect(v.decision).toBe('reject')
    expect(v.redactedContent).not.toContain('MIIB')
    expect(v.redactedContent).not.toContain('AAAA')
  })

  it('sends same-key contradictions to review, never auto-merge (A* fixture)', () => {
    // Live state: bridges were built (astar-recast-support). Candidate: remove them.
    const v = admit(
      candidate({
        key: 'astar-doorways-no-links',
        content: 'Remove the NodeLink2 bridges; the RecastGraph must connect through doorways.',
        futureUse: 'Authoritative doorway topology decision for all future navmesh work.',
        triggers: ['doorway links reappear', 'recast islands stay disconnected'],
      }),
      {
        findSameKey: () => [
          { status: 'active', content: 'Build NodeLink2 bridges for unconnected floor islands.' },
        ],
      },
    )
    expect(v.decision).toBe('review')
    expect(v.score).toBeLessThan(ADMISSION_AUTO_THRESHOLD)
  })
  it('keeps prose around complete blocks (precise path first)', () => {
    const keyBlock = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIBOgIBAAJBAKc=', 'MIIBOgIBAAJBAKd=', '-----END RSA PRIVATE KEY-----'].join("\n")
    const prose = Array.from({ length: 300 }, (_, i) => `ordinary log line ${i}`).join("\n")
    const content = `head note\n${keyBlock}\n${prose}`
    const v = admit(candidate({ content }), emptyLookup)
    expect(v.decision).toBe('reject')
    expect(v.redactedContent).not.toContain('MIIBOgIBAAJBAKc')
    expect(v.redactedContent).toContain('ordinary log line 299')
  })

  it('nukes truncated over-long blocks even before a complete block', () => {
    const long: string[] = ['-----BEGIN RSA PRIVATE KEY-----']
    for (let i = 0; i < 250; i++) long.push(`MIIB${i} ====`)
    const full = '-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----'
    const content = `${long.join("\n")}\nseparator prose\n${full}`
    const v = admit(candidate({ content }), emptyLookup)
    expect(v.decision).toBe('reject')
    expect(v.redactedContent).not.toContain('MIIB')
    expect(v.redactedContent).not.toContain('AAAA')
  })

  it('holds the 200/201 boundary with CRLF', () => {
    const mk = (n: number): string => {
      const lines = ['-----BEGIN RSA PRIVATE KEY-----']
      for (let i = 0; i < n; i++) lines.push(`MIIB${i} ====`)
      return lines.join("\r\n")
    }
    const at200 = admit(candidate({ content: mk(200) }), emptyLookup)
    expect(at200.redactedContent).not.toContain('MIIB0')
    expect(at200.redactedContent).toContain('[REDACTED:private-key-partial]')
    const at201 = admit(candidate({ content: mk(201) }), emptyLookup)
    expect(at201.redactedContent).toBe('[REDACTED:private-key-overflow]')
  })
})
