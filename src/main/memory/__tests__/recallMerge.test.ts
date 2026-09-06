import { describe, expect, it } from 'vitest'
import { MERGE_CONTRACT_VERSION, mergeRecallResults } from '../recallMerge'

const ws = 'workspace:w'
const g = 'global'
const sel = 'workspace:s'

function item(id: string, content: string, category = 'decision', key = id): { id: string; content: string; category: string; key: string } {
  return { id, content, category, key }
}

describe('recallMerge', () => {
  it('pins the contract version', () => {
    expect(MERGE_CONTRACT_VERSION).toBe(1)
  })

  it('orders by scope priority, preserving local rank (scores never cross DBs)', () => {
    const out = mergeRecallResults([
      { db: ws, items: [item('w2', 'second', 'decision', 'k2'), item('w1', 'first', 'decision', 'k1')] },
      { db: g, items: [item('g1', 'global hit', 'decision', 'kg')] },
    ])
    expect(out.map((m) => m.item.id)).toEqual(['w2', 'w1', 'g1'])
    expect(out.map((m) => m.db)).toEqual([ws, ws, g])
  })

  it('is deterministic for identical inputs and honors priority order', () => {
    const input = [
      { db: ws, items: [item('b', 'x', 'decision', 'kb'), item('a', 'y', 'decision', 'ka')] },
      { db: g, items: [item('c', 'z', 'decision', 'kc')] },
    ] as Array<{ db: string; items: { id: string; content: string; category: string; key: string }[] }>
    const a = mergeRecallResults(input)
    const a2 = mergeRecallResults(input)
    expect(a2).toEqual(a)
    expect(a.map((m) => m.item.id)).toEqual(['b', 'a', 'c'])
  })

  it('merges only on full identity (category + key + exact content)', () => {
    const out = mergeRecallResults([
      { db: ws, items: [item('w1', 'Same text', 'decision', 'k')] },
      { db: g, items: [item('g9', 'Same text', 'decision', 'k')] },
      { db: sel, items: [item('s1', 'Other', 'decision', 'ko')] },
    ])
    expect(out).toHaveLength(2)
    expect(out[0].item.id).toBe('w1') // higher priority body wins
    expect(out[0].alsoIn).toEqual([{ db: g, id: 'g9' }])
    expect(out[1].item.id).toBe('s1')
  })

  it('keeps whitespace-differing bodies separate (no fuzzy identity)', () => {
    const out = mergeRecallResults([
      { db: ws, items: [item('w1', 'Same  text', 'decision', 'k')] },
      { db: g, items: [item('g1', 'Same text', 'decision', 'k')] },
    ])
    expect(out).toHaveLength(2)
  })

  it('keeps same key/content with different metadata separate', () => {
    const a = { id: 'w1', category: 'decision', key: 'k', content: 'x', status: 'active' }
    const b = { id: 'g1', category: 'decision', key: 'k', content: 'x', status: 'deprecated' }
    const out = mergeRecallResults([
      { db: ws, items: [a] },
      { db: g, items: [b] },
    ])
    expect(out).toHaveLength(2)
  })

  it('keeps code bodies with different indentation separate', () => {
    const a = { id: 'w1', category: 'decision', key: 'k', content: 'if (x) {\n  y()\n}' }
    const b = { id: 'g1', category: 'decision', key: 'k', content: 'if (x) {\ny()\n}' }
    const out = mergeRecallResults([
      { db: ws, items: [a] },
      { db: g, items: [b] },
    ])
    expect(out).toHaveLength(2)
  })

  it('merges byte-identical copies modulo telemetry fields', () => {
    const a = {
      id: 'w1', category: 'decision', key: 'k', content: 'x',
      retrieval_count: 5, last_accessed_unix_ms: 111, decay_score: 0.9,
    }
    const b = {
      id: 'g1', category: 'decision', key: 'k', content: 'x',
      retrieval_count: 0, last_accessed_unix_ms: 222, decay_score: 0.5,
    }
    const out = mergeRecallResults([
      { db: ws, items: [a] },
      { db: g, items: [b] },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].alsoIn).toEqual([{ db: g, id: 'g1' }])
  })

  it('keeps same-content items with different keys or categories separate', () => {
    const out = mergeRecallResults([
      { db: ws, items: [item('a', 'same', 'decision', 'k1'), item('b', 'same', 'decision', 'k2')] },
      { db: g, items: [item('c', 'same', 'gotcha', 'k1')] },
    ])
    expect(out).toHaveLength(3)
  })

  it('keeps items without identity fields separate', () => {
    const out = mergeRecallResults([{ db: ws, items: [{ id: 'x' }, { id: 'x' }] }])
    expect(out).toHaveLength(2)
  })

  it('merges all capped candidates before the total cap (no lost provenance)', () => {
    const out = mergeRecallResults(
      [
        { db: ws, items: [item('w1', 'shared', 'decision', 'k')] },
        { db: g, items: [item('g1', 'shared', 'decision', 'k')] },
      ],
      { maxTotal: 1 },
    )
    expect(out).toHaveLength(1)
    expect(out[0].item.id).toBe('w1')
    expect(out[0].alsoIn).toEqual([{ db: g, id: 'g1' }])
  })

  it('applies per-DB limits, total cap and duplicate DB collapse', () => {
    const out = mergeRecallResults(
      [
        { db: ws, items: [item('w1', 'a'), item('w2', 'b'), item('w3', 'c')] },
        { db: ws, items: [item('wX', 'DUPLICATE DB ENTRY')] },
        { db: g, items: [item('g1', 'd')] },
      ],
      { perDbLimit: 2, maxTotal: 3 },
    )
    expect(out.map((m) => m.item.id)).toEqual(['w1', 'w2', 'g1'])
  })

  it('never collides across embedded newlines in category/key', () => {
    const a = { id: 'x1', category: 'a\nb', key: 'c', content: 'x' }
    const b = { id: 'x2', category: 'a', key: 'b\nc', content: 'x' }
    const out = mergeRecallResults([
      { db: ws, items: [a] },
      { db: g, items: [b] },
    ])
    expect(out).toHaveLength(2)
  })
})
