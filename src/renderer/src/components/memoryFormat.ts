// Pure display helpers for the memory screen (no IPC, no store).
// Defensive by contract: unknown shapes never throw, missing content
// falls back to body_json decoding, missing everything renders '—'.

export function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

export function snippet(v: unknown, n = 140): string {
  const s = str(v)
  return s.length > n ? `${s.slice(0, n)}…` : s
}

export function titleOf(key: string): string {
  const s = key.replace(/[-_]+/g, ' ').trim()
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : '(untitled)'
}

export function dateOf(v: unknown): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return ''
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString()
}

export function tagsOf(item: Record<string, unknown>): string[] {
  const t = item.tags
  return Array.isArray(t) ? t.filter((x): x is string => typeof x === 'string').slice(0, 4) : []
}

export function historyVersions(history: unknown): Array<Record<string, unknown>> {
  const h = (history ?? {}) as Record<string, unknown>
  const v = h.versions
  if (!Array.isArray(v)) return []
  return v.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
}

export function versionTime(v: Record<string, unknown>): string {
  for (const k of ['created_at_unix_ms', 'at_unix_ms', 'timestamp', 'createdAt', 'at']) {
    const d = dateOf(v[k])
    if (d) return d
  }
  return ''
}

export function versionBlurb(v: Record<string, unknown>): string {
  for (const k of ['content', 'body', 'summary', 'text']) {
    const s = str(v[k])
    if (s) return snippet(s, 120)
  }
  return snippet(JSON.stringify(v), 120)
}

/** Detail body: list content first, then defensively decoded body_json. */
export function detailContent(detail: unknown, fallback: string): string {
  if (fallback) return fallback
  const d = (detail ?? {}) as Record<string, unknown>
  if (str(d.content)) return str(d.content)
  const raw = str(d.body_json)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (str(parsed.content)) return str(parsed.content)
    } catch {
      return raw.length > 2000 ? `${raw.slice(0, 2000)}…` : raw
    }
  }
  return ''
}

export function recentOf(item: Record<string, unknown>): number {
  for (const k of ['last_accessed_unix_ms', 'created_at_unix_ms']) {
    const v = item[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return 0
}

export function usedOf(item: Record<string, unknown>): number {
  const v = item.retrieval_count
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

export function asJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

/** Body text split into readable paragraphs (blank-line or single breaks). */
export function paragraphsOf(content: string): string[] {
  return content
    .split(/\n\s*\n|\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
}

/**
 * Step detection for procedure-like bodies: 3+ semicolon-separated clauses,
 * each short enough to be a step. Otherwise paragraphs (never force it).
 */
export function stepsOf(content: string): string[] | null {
  if (content.includes('\n')) return null
  const parts = content
    .split(/;\s+/)
    .map((p) => p.trim().replace(/;$/, ''))
    .filter((p) => p.length > 0)
  if (parts.length < 3 || parts.some((p) => p.length > 200)) return null
  return parts
}

/** "When to use" hints: recall_when from detail, body_json or list item. */
export function recallWhenOf(detail: unknown, item: Record<string, unknown> | null): string[] {
  const d = (detail ?? {}) as Record<string, unknown>
  const raw = d.recall_when ?? item?.recall_when
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, 8)
  const body = str(d.body_json)
  if (body) {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>
      if (Array.isArray(parsed.recall_when)) {
        return parsed.recall_when.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, 8)
      }
    } catch {
      // not JSON — no hints
    }
  }
  return []
}

export interface StatCard {
  label: string
  value: string
  /** 0..1 fraction for a meter bar, when the stat is a ratio. */
  frac: number | null
}

function pct(v: unknown): string | null {
  return typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v * 100)}%` : null
}

function fracOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null
}

/** Small metadata cards for the detail view (human labels, no jargon). */
export function statCardsOf(detail: unknown): StatCard[] {
  const d = (detail ?? {}) as Record<string, unknown>
  const out: StatCard[] = []
  const conf = pct(d.certainty)
  if (conf !== null) out.push({ label: 'Confidence', value: conf, frac: fracOf(d.certainty) })
  if (typeof d.retrieval_count === 'number') {
    out.push({ label: 'Used', value: `${d.retrieval_count}×`, frac: null })
  }
  const decay = pct(d.decay_score)
  if (decay !== null) out.push({ label: 'Decay', value: decay, frac: fracOf(d.decay_score) })
  if (str(d.layer)) out.push({ label: 'Layer', value: str(d.layer), frac: null })
  if (str(d.status)) out.push({ label: 'Status', value: str(d.status), frac: null })
  return out
}
