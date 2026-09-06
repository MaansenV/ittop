import { create } from 'zustand'
import type { MemoryPromotePreview, MemoryPromoteResult, MemoryReviewList, MemoryShadowRun, MemoryStatus } from '../../../shared/types'

export interface SearchEnvelope {
  items: Array<{ item: Record<string, unknown>; db: string; alsoIn?: Array<{ db: string; id: string }> }>
  missing: Array<{ db: string; reason: string }>
  partial: boolean
  completeEmpty: boolean
  hasMore: boolean
}

export interface BrowsePage {
  db: string
  noStore: boolean
  items: Array<{ item: Record<string, unknown>; db: string }>
  total: number | null
  hasMore: boolean
  nextCursor: string | null
  missing: { db: string; reason: string } | null
}

function asBrowse(raw: unknown): BrowsePage | null {
  const r = (raw ?? {}) as Partial<BrowsePage>
  if (typeof r.db !== 'string' || !Array.isArray(r.items)) return null
  const pageDb: string = r.db
  // Scan returns raw entities (no {item, db} envelope unlike recall):
  // wrap them so list/detail code stays uniform.
  const items = r.items.flatMap((m): BrowsePage['items'] => {
    if (typeof m !== 'object' || m === null) return []
    const item = (m as { item?: unknown }).item
    const inner = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : (m as Record<string, unknown>)
    const db = typeof (m as { db?: unknown }).db === 'string' ? (m as { db: string }).db : pageDb
    return [{ item: inner, db }]
  })
  return {
    db: r.db,
    noStore: r.noStore === true,
    items,
    total: typeof r.total === 'number' ? r.total : null,
    hasMore: r.hasMore === true,
    nextCursor: typeof r.nextCursor === 'string' ? r.nextCursor : null,
    missing: r.missing ?? null,
  }
}

function asEnvelope(raw: unknown): SearchEnvelope {
  const r = (raw ?? {}) as Partial<SearchEnvelope>
  return {
    items: Array.isArray(r.items) ? r.items : [],
    missing: Array.isArray(r.missing) ? r.missing : [],
    partial: r.partial === true,
    completeEmpty: r.completeEmpty === true,
    hasMore: r.hasMore === true,
  }
}

function err(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

interface MemoryState {
  status: MemoryStatus | null
  query: string
  searching: boolean
  results: SearchEnvelope | null
  categoryFilter: string
  pageFilter: string
  tagFilter: string
  statusFilter: string
  sortKey: 'recent' | 'title' | 'used'
  groupByCat: boolean
  rawView: boolean
  /** Screen-local scope: active workspace or the separate global store. */
  scope: 'workspace' | 'global'
  scopeWs: string | null
  browse: BrowsePage | null
  browsing: boolean
  selectedDb: string
  selectedId: string
  detail: unknown
  detailHistory: unknown
  review: MemoryReviewList | null
  preview: MemoryPromotePreview | null
  approvedCandidate: { id: number; revision: number; category: string; key: string } | null
  promotionResult: MemoryPromoteResult | null
  shadow: MemoryShadowRun[] | null
  overrideBy: string
  overrideReason: string
  error: string | null
  lastWorkspaceId: string | null
  contextKey: string

  setQuery: (q: string) => void
  setCategoryFilter: (c: string) => void
  setPageFilter: (f: string) => void
  setTagFilter: (t: string) => void
  setStatusFilter: (st: string) => void
  setSortKey: (k: 'recent' | 'title' | 'used') => void
  setGroupByCat: (v: boolean) => void
  setRawView: (v: boolean) => void
  setScope: (scope: 'workspace' | 'global', wsId: string | null) => void
  setOverride: (by: string, reason: string) => void
  /** Context switch from the app shell (workspace and/or flag changed).
   * Bumps the generation: every in-flight answer is dropped, stale search
   * state is reset on workspace change, everything on disable. */
  setContext: (workspaceId: string | null, enabled: boolean) => void
  refreshStatus: () => Promise<void>
  search: (workspaceId: string) => Promise<void>
  refreshBrowse: (workspaceId: string) => Promise<void>
  loadMore: (workspaceId: string) => Promise<void>
  select: (workspaceId: string, db: string, id: string) => Promise<void>
  refreshReview: () => Promise<void>
  decide: (id: number, approved: boolean, expectedRevision: number) => Promise<void>
  dryRun: (id: number) => Promise<void>
  promote: (id: number, expectedRevision: number) => Promise<boolean>
  refreshShadow: () => Promise<void>
  clearError: () => void
}

// Monotonic request generation: late answers from an older search/selection
// or a previous workspace are dropped, never rendered under new state.
// Browse paging has its OWN generation (browseSeq): appending a late page
// after a selection must still land (the list is selection-independent),
// while scope/context switches invalidate it. `seq` keeps guarding
// search/select/review/shadow.
let seq = 0
let browseSeq = 0

function resetSearch(): Partial<MemoryState> {
  browseSeq += 1
  return {
    results: null,
    browse: null,
    browsing: false,
    selectedDb: '',
    selectedId: '',
    detail: null,
    detailHistory: null,
    searching: false,
    rawView: false,
  }
}

export const useMemoryStore = create<MemoryState>((set, get) => ({
  status: null,
  query: '',
  searching: false,
  results: null,
  categoryFilter: 'all',
  pageFilter: '',
  tagFilter: 'all',
  statusFilter: 'all',
  sortKey: 'recent',
  groupByCat: false,
  rawView: false,
  scope: 'workspace',
  scopeWs: null,
  browse: null,
  browsing: false,
  selectedDb: '',
  selectedId: '',
  detail: null,
  detailHistory: null,
  review: null,
  preview: null,
  approvedCandidate: null,
  promotionResult: null,
  shadow: null,
  overrideBy: '',
  overrideReason: '',
  error: null,
  lastWorkspaceId: null as string | null,
  contextKey: '',

  setQuery: (q) => set({ query: q }),
  setCategoryFilter: (c) => set({ categoryFilter: c }),
  setPageFilter: (f) => set({ pageFilter: f }),
  setTagFilter: (t) => set({ tagFilter: t }),
  setStatusFilter: (st) => set({ statusFilter: st }),
  setSortKey: (k) => set({ sortKey: k }),
  setGroupByCat: (v) => set({ groupByCat: v }),
  setRawView: (v) => set({ rawView: v }),
  setScope: (scope, wsId) => {
    // Explicit user choice: new generation, everything stale is dropped.
    seq += 1
    browseSeq += 1
    set({
      scope,
      scopeWs: wsId,
      ...resetSearch(),
      categoryFilter: 'all',
      pageFilter: '',
      tagFilter: 'all',
      statusFilter: 'all',
      sortKey: 'recent',
      groupByCat: false,
      error: null,
    })
  },
  setOverride: (by, reason) => set({ overrideBy: by, overrideReason: reason }),
  clearError: () => set({ error: null }),

  setContext: (workspaceId, enabled) => {
    // Idempotent: mount + shell effects call with the same context — only
    // a real change bumps the generation (else mount refreshes would die).
    const key = `${enabled ? '1' : '0'}:${workspaceId ?? ''}`
    if (get().contextKey === key) return
    seq += 1
    set((st) => {
      if (!enabled) {
        return { contextKey: key, lastWorkspaceId: null, ...resetSearch(), review: null, preview: null, shadow: null, categoryFilter: 'all', pageFilter: '', tagFilter: 'all', statusFilter: 'all', sortKey: 'recent' as const, groupByCat: false, scope: 'workspace' as const, scopeWs: null }
      }
      if (workspaceId !== st.lastWorkspaceId) {
        // Workspace switch also resets the category filter: a stale filter
        // could hide every new result without a reachable reset. The screen
        // scope follows the app workspace (explicit user picks diverge).
        return { contextKey: key, lastWorkspaceId: workspaceId, ...resetSearch(), categoryFilter: 'all', pageFilter: '', tagFilter: 'all', statusFilter: 'all', sortKey: 'recent' as const, groupByCat: false, scope: 'workspace' as const, scopeWs: workspaceId }
      }
      return { contextKey: key, lastWorkspaceId: workspaceId }
    })
  },

  refreshStatus: async () => {
    const my = seq
    try {
      const status = await window.api.memoryStatus()
      if (my !== seq) return
      if (!status.enabled) {
        // Disabled: drop everything stale (results, selection, review).
        seq += 1
        set({ status, lastWorkspaceId: null, ...resetSearch(), review: null, preview: null, shadow: null, categoryFilter: 'all', pageFilter: '', tagFilter: 'all', statusFilter: 'all', sortKey: 'recent' as const, groupByCat: false, scope: 'workspace' as const, scopeWs: null })
      } else {
        set({ status })
      }
    } catch (e) {
      if (my !== seq) return
      set({ error: err(e) })
    }
  },

  search: async (workspaceId) => {
    const { query, lastWorkspaceId, scope, scopeWs } = get()
    if (!query.trim()) {
      // Empty search = browse (plan §7.7): reload the workspace list.
      await get().refreshBrowse(workspaceId)
      return
    }
    const sessionWs = scope === 'workspace' && scopeWs ? scopeWs : workspaceId
    const my = (seq += 1)
    // Workspace switch: never show the previous workspace's results.
    // Browsing is ours to clear here (no browse owner: refreshBrowse
    // always sets it itself when it runs).
    set(
      workspaceId !== lastWorkspaceId
        ? { lastWorkspaceId: workspaceId, ...resetSearch(), searching: true, error: null }
        : { searching: true, browsing: false, error: null, detail: null, detailHistory: null, selectedId: '' },
    )
    try {
      // Backend search honors the selected scope (single DB, validated
      // main-side); omitted only when no scope is selected yet.
      const scopeDbs =
        scope === 'global' ? ['global'] : scopeWs ? [`workspace:${scopeWs}`] : undefined
      const raw = await window.api.memorySearch(sessionWs, query.trim(), 10, scopeDbs)
      if (get().lastWorkspaceId !== workspaceId) return // switched away mid-flight
      if (my !== seq) return // superseded by a newer search
      set({ results: asEnvelope(raw), browse: null, searching: false })
    } catch (e) {
      if (my !== seq) return
      set({ error: err(e), searching: false })
    }
  },

  refreshBrowse: async (workspaceId) => {
    const { scope, scopeWs } = get()
    // The RPC session follows the selection: another workspace's DB is
    // only readable through that workspace's own session (grant-checked
    // main-side; ungranted selections fail closed, never silently).
    const sessionWs = scope === 'workspace' && scopeWs ? scopeWs : workspaceId
    const my = (seq += 1)
    const myBrowse = (browseSeq += 1)
    set({ browsing: true, error: null, detail: null, detailHistory: null, selectedId: '' })
    try {
      const raw = await window.api.memoryBrowse(sessionWs, { db: scope })
      if (myBrowse !== browseSeq) return // newer browse op owns the flag
      if (my !== seq) {
        // Superseded by select/search (no browse owner): never strand busy.
        set({ browsing: false })
        return
      }
      const page = asBrowse(raw)
      // A successful browse proves the vaults are up: re-read the status
      // so the pill never claims "starting" while entries are showing.
      try {
        const status = await window.api.memoryStatus()
        if (myBrowse === browseSeq && my === seq) set({ status })
      } catch {
        // status stays as-is; the list is authoritative
      }
      if (myBrowse !== browseSeq || my !== seq) return
      set({ browse: page, results: null, browsing: false })
      // No void detail: select the first entry (read-only drill-down).
      if (page && page.items.length > 0 && get().selectedId === '') {
        const first = page.items[0]
        void get().select(sessionWs, first.db, String(first.item.id))
      }
    } catch (e) {
      if (myBrowse !== browseSeq) return // newer browse op owns the flag
      if (my !== seq) {
        // Superseded by select/search (ownerless): clear busy, publish NO
        // error for a dead context — the owning op reports its own.
        set({ browsing: false })
        return
      }
      set({ error: err(e), browsing: false })
    }
  },

  loadMore: async (workspaceId) => {
    const { browse, scope, scopeWs } = get()
    if (!browse || !browse.hasMore || !browse.nextCursor) return
    const sessionWs = scope === 'workspace' && scopeWs ? scopeWs : workspaceId
    // Same browse generation: a selection mid-flight must NOT strand the
    // busy flag — appending a page is list-independent. Only a scope or
    // context switch (browseSeq bump) drops the answer.
    const myBrowse = browseSeq
    set({ browsing: true, error: null })
    try {
      const raw = await window.api.memoryBrowse(sessionWs, {
        db: get().scope,
        limit: 50,
        cursor: browse.nextCursor,
      })
      if (myBrowse !== browseSeq) return
      // The list itself was replaced meanwhile (new search/browse): the
      // page belongs to a dead list — drop it instead of resurrecting.
      // (The replacing op owns the busy flag; don't touch it.)
      if (get().browse !== browse) return
      const page = asBrowse(raw)
      if (!page || page.db !== browse.db) {
        // Our answer, unusable (malformed/foreign): clear OUR busy flag,
        // keep the list that is showing. (A replaced list implies a newer
        // browse op... which would have bumped browseSeq — so reaching
        // here means no newer owner exists. Search clears the flag itself.)
        set({ browsing: false })
        return
      }
      set({
        browse: {
          ...page,
          items: [...browse.items, ...page.items.filter((m) => !browse.items.some((b) => String(b.item.id) === String(m.item.id)))],
        },
        browsing: false,
      })
    } catch (e) {
      if (myBrowse !== browseSeq) return
      set({ error: err(e), browsing: false })
    }
  },

  select: async (workspaceId, db, id) => {
    const { scope, scopeWs } = get()
    const sessionWs = scope === 'workspace' && scopeWs ? scopeWs : workspaceId
    const my = (seq += 1)
    set({ selectedDb: db, selectedId: id, detail: null, detailHistory: null, error: null })
    try {
      const [detail, detailHistory] = await Promise.all([
        window.api.memoryEntity(sessionWs, db, id),
        (async (): Promise<unknown> => {
          const env = get().results
          const found =
            env?.items.find((i) => String(i.item.id) === id && i.db === db) ??
            get().browse?.items.find((i) => String(i.item.id) === id && i.db === db)
          const category = String(found?.item.category ?? '')
          const key = String(found?.item.key ?? '')
          if (!category || !key) return null
          return window.api.memoryHistory(sessionWs, db, category, key)
        })(),
      ])
      // A newer selection (or a disable-reset) arrived first: drop this one.
      if (my !== seq || get().selectedId !== id || get().selectedDb !== db) return
      set({ detail, detailHistory })
    } catch (e) {
      if (my !== seq) return
      set({ error: err(e) })
    }
  },

  refreshReview: async () => {
    const my = seq
    try {
      const review = await window.api.memoryReviewList()
      if (my !== seq) return
      set({ review, error: null })
    } catch (e) {
      if (my !== seq) return
      set({ error: err(e) })
    }
  },

  decide: async (id, approved, expectedRevision) => {
    const { overrideBy, overrideReason } = get()
    const my = seq
    const found = get().review?.queued.find((r) => r.id === id)
    const approvedCandidate = approved && found ? { id, revision: expectedRevision, category: found.category, key: found.key } : null
    try {
      await window.api.memoryReviewDecide({
        id,
        approved,
        expectedRevision,
        by: overrideBy.trim() || undefined,
        reason: overrideReason.trim() || undefined,
      })
      if (my !== seq) return
      const list = await window.api.memoryReviewList()
      if (my !== seq) return
      set({ review: list, preview: null, approvedCandidate, error: null })
      if (approved) await get().dryRun(id)
    } catch (e) {
      if (my !== seq) return
      set({ error: err(e) })
    }
  },

  dryRun: async (id) => {
    const my = seq
    try {
      const preview = await window.api.memoryPromoteDryRun(id)
      if (my !== seq) return
      set({ preview, promotionResult: null, error: null })
    } catch (e) {
      if (my !== seq) return
      set({ preview: null, error: err(e) })
    }
  },

  promote: async (id, expectedRevision) => {
    const my = seq
    try {
      const res = await window.api.memoryPromote(id, expectedRevision)
      if (my !== seq) return false
      const list = await window.api.memoryReviewList()
      if (my !== seq) return false
      set({ review: list, promotionResult: res, preview: null, approvedCandidate: null, error: null })
      return res.ok
    } catch (e) {
      if (my !== seq) return false
      set({ error: err(e) })
      return false
    }
  },

  refreshShadow: async () => {
    const my = seq
    try {
      const shadow = await window.api.memoryShadowRuns(20)
      if (my !== seq) return
      set({ shadow, error: null })
    } catch (e) {
      if (my !== seq) return
      set({ error: err(e) })
    }
  },
}))
