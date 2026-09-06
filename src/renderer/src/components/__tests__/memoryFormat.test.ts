import { describe, expect, it } from 'vitest'
import {
  dateOf,
  detailContent,
  historyVersions,
  paragraphsOf,
  recallWhenOf,
  recentOf,
  snippet,
  statCardsOf,
  stepsOf,
  str,
  tagsOf,
  titleOf,
  usedOf,
  versionBlurb,
  versionTime,
} from '../memoryFormat'

describe('memoryFormat', () => {
  it('humanizes keys and never throws on junk', () => {
    expect(titleOf('astar-doorways-no-links')).toBe('Astar doorways no links')
    expect(titleOf('xterm_fit_padding')).toBe('Xterm fit padding')
    expect(titleOf('')).toBe('(untitled)')
    expect(str(undefined)).toBe('')
    expect(str(42)).toBe('')
    expect(snippet('x'.repeat(200))).toHaveLength(141)
    expect(dateOf(NaN)).toBe('')
    expect(dateOf('tomorrow')).toBe('')
    expect(dateOf(1788689366934)).toMatch(/2026/)
  })

  it('keeps at most four string tags', () => {
    expect(tagsOf({ tags: ['a', 'b', 1, null, 'c', 'd', 'e'] })).toEqual(['a', 'b', 'c', 'd'])
    expect(tagsOf({})).toEqual([])
  })

  it('decodes body_json defensively for the detail fallback', () => {
    expect(detailContent({ content: 'direct' }, '')).toBe('direct')
    expect(detailContent({ content: 'direct' }, 'list first')).toBe('list first')
    expect(detailContent({ body_json: '{"content":"decoded body"}' }, '')).toBe('decoded body')
    expect(detailContent({ body_json: '{"content":42}' }, '')).toBe('')
    expect(detailContent({ body_json: 'not json{{{' }, '')).toBe('not json{{{')
    expect(detailContent(null, '')).toBe('')
    expect(detailContent(undefined, '')).toBe('')
  })

  it('reads history tolerantly and blurbs versions', () => {
    expect(historyVersions(null)).toEqual([])
    expect(historyVersions({ versions: 'nope' })).toEqual([])
    const vs = historyVersions({ versions: [{ content: 'hello' }, 42, { created_at_unix_ms: 1788689366934 }] })
    expect(vs).toHaveLength(2)
    expect(versionBlurb(vs[0])).toBe('hello')
    expect(versionTime(vs[1])).toMatch(/2026/)
    expect(versionTime({})).toBe('')
  })

  it('sorts by recency and usage with zero defaults', () => {
    expect(recentOf({})).toBe(0)
    expect(recentOf({ created_at_unix_ms: 5 })).toBe(5)
    expect(usedOf({})).toBe(0)
    expect(usedOf({ retrieval_count: 3 })).toBe(3)
  })

  it('splits procedure bodies into steps, prose into paragraphs', () => {
    expect(stepsOf('Do a; then b; finally c')).toEqual(['Do a', 'then b', 'finally c'])
    expect(stepsOf('Just one; and two')).toBeNull()
    expect(stepsOf('a\nb; c; d')).toBeNull()
    expect(stepsOf('short; ' + 'x'.repeat(201) + '; tail')).toBeNull()
    expect(paragraphsOf('one\n\ntwo\nthree')).toEqual(['one', 'two', 'three'])
    expect(paragraphsOf('  ')).toEqual([])
  })

  it('collects when-to-use hints and stat cards', () => {
    expect(recallWhenOf({ recall_when: ['a', 1, 'b'] }, null)).toEqual(['a', 'b'])
    expect(recallWhenOf({}, { recall_when: ['x'] })).toEqual(['x'])
    expect(
      recallWhenOf({ body_json: '{"recall_when":["y"]}' }, null),
    ).toEqual(['y'])
    expect(recallWhenOf({}, null)).toEqual([])
    const cards = statCardsOf({ certainty: 0.5, retrieval_count: 3, decay_score: 0.25, layer: 'buffer', status: 'active' })
    expect(cards.map((c) => c.label)).toEqual(['Confidence', 'Used', 'Decay', 'Layer', 'Status'])
    expect(cards[0]).toMatchObject({ value: '50%', frac: 0.5 })
    expect(statCardsOf(null)).toEqual([])
  })
})
