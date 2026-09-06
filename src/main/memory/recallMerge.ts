// Versioned fan-out merge contract. V1 rules (deterministic, no cross-DB
// score comparison — BM25 values from different indexes are incomparable):
//  1. Scope priority: home workspace DB first, then global, then explicitly
//     selected other DBs (caller passes DBs in priority order).
//  2. Within one DB the local rank order is preserved as returned.
//  3. Ties break by stable entity id (lexicographic).
//  4. Display-merge ONLY on full structured identity: equal category +
//     equal key + byte-exact content + deep-equal remaining body, ignoring
//     a documented volatile telemetry set (counters, decay, access stamps).
//     Anything else (validity, status, indentation, extra fields) stays
//     separate — a similar body alone is NEVER identity.
//  5. Merge runs over ALL capped candidates first; the total cap applies
//     afterwards, so a lower-priority duplicate of a kept item always lands
//     in its provenance instead of being cut off.
// Priority is relevance shaping, not truth: workspace-first does NOT mean
// truer — cross-DB contradictions stay visible side by side.
export const MERGE_CONTRACT_VERSION = 1

export interface MergeableItem {
  id: string
  category?: string
  key?: string
  content?: string
  [key: string]: unknown
}

export interface MergedItem<T extends MergeableItem> {
  item: T
  db: string
  alsoIn?: Array<{ db: string; id: string }>
}

export interface MergeOptions {
  perDbLimit?: number
  maxTotal?: number
}

const DEFAULT_PER_DB_LIMIT = 10
const DEFAULT_MAX_TOTAL = 30

// Volatile per-copy telemetry: excluded from identity (different usage
// histories must not split an otherwise identical fact copy).
const VOLATILE_FIELDS = new Set([
  'id',
  'retrieval_count',
  'last_accessed_unix_ms',
  'decay_score',
  'follow_count',
  'follow_rate',
  'miss_count',
  'why_served',
  'hints',
])

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

// Full structured identity for DISPLAY merging: same fact (category + key)
// with a byte-exact body and deep-equal remainder. Serialized as ONE JSON
// tuple — never newline-concatenated (category='a\nb',key='c' must not
// collide with category='a',key='b\nc'). Items missing
// category/key/content never merge.
function identityKey(item: MergeableItem): string | null {
  if (typeof item.category !== 'string' || item.category.length === 0) return null
  if (typeof item.key !== 'string' || item.key.length === 0) return null
  if (typeof item.content !== 'string' || item.content.trim().length === 0) return null
  const rest: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(item)) {
    if (VOLATILE_FIELDS.has(k) || k === 'category' || k === 'key' || k === 'content') continue
    rest[k] = v
  }
  return stableStringify([item.category, item.key, item.content, rest])
}

export function mergeRecallResults<T extends MergeableItem>(
  perDb: Array<{ db: string; items: T[] }>,
  opts: MergeOptions = {},
): Array<MergedItem<T>> {
  const perDbLimit = opts.perDbLimit ?? DEFAULT_PER_DB_LIMIT
  const maxTotal = opts.maxTotal ?? DEFAULT_MAX_TOTAL
  // Duplicate DB entries collapse to the first occurrence (stable priority).
  const seenDb = new Set<string>()
  const ranked: Array<{ entry: MergedItem<T>; dbIndex: number; localIndex: number }> = []
  let dbIndex = 0
  for (const { db, items } of perDb) {
    if (seenDb.has(db)) continue
    seenDb.add(db)
    const capped = items.slice(0, Math.max(0, perDbLimit))
    for (const [localIndex, item] of capped.entries()) {
      ranked.push({ entry: { item, db }, dbIndex, localIndex })
    }
    dbIndex++
  }
  // Explicit keys: scope priority, then local rank, then stable id.
  // Raw BM25 scores never cross DB boundaries.
  ranked.sort((a, b) => {
    if (a.dbIndex !== b.dbIndex) return a.dbIndex - b.dbIndex
    if (a.localIndex !== b.localIndex) return a.localIndex - b.localIndex
    if (a.entry.item.id < b.entry.item.id) return -1
    if (a.entry.item.id > b.entry.item.id) return 1
    return 0
  })
  const merged: Array<MergedItem<T>> = []
  const seenIdentity = new Map<string, MergedItem<T>>()
  for (const { entry } of ranked) {
    const key = identityKey(entry.item)
    if (key !== null) {
      const first = seenIdentity.get(key)
      if (first) {
        // Identical fact elsewhere: keep provenance, keep the FIRST
        // (higher-priority) body.
        first.alsoIn = [...(first.alsoIn ?? []), { db: entry.db, id: entry.item.id }]
        continue
      }
      seenIdentity.set(key, entry)
    }
    merged.push(entry)
  }
  return merged.slice(0, Math.max(0, maxTotal))
}
