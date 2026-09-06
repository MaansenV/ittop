import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useMemoryStore } from '../useMemoryStore'

const WS_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const WS_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const api = {
  memoryStatus: vi.fn(),
  memorySearch: vi.fn(),
  memoryBrowse: vi.fn(),
  memoryEntity: vi.fn(),
  memoryHistory: vi.fn(),
  memoryReviewList: vi.fn(),
  memoryReviewDecide: vi.fn(),
  memoryPromoteDryRun: vi.fn(),
  memoryShadowRuns: vi.fn(),
}

function install(): void {
  ;(globalThis as unknown as { window: unknown }).window = { api }
  useMemoryStore.setState({
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
    shadow: null,
    overrideBy: '',
    overrideReason: '',
    error: null,
    lastWorkspaceId: null,
    contextKey: '',
  })
  vi.clearAllMocks()
}

function page(tag: string, extra: Record<string, unknown> = {}): unknown {
  return {
    db: `workspace:${WS_A}`,
    noStore: false,
    items: [{ item: { id: 'e1', category: 'decision', key: 'k', content: tag }, db: `workspace:${WS_A}` }],
    total: 1,
    hasMore: false,
    nextCursor: null,
    missing: null,
    ...extra,
  }
}

function envelope(tag: string): unknown {
  return {
    items: [{ item: { id: 'e1', category: 'decision', key: 'k', content: tag }, db: 'global' }],
    missing: [],
    partial: false,
    completeEmpty: false,
    hasMore: false,
  }
}

describe('useMemoryStore', () => {
  beforeEach(install)

  it('drops the slower first search when a second search supersedes it', async () => {
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    api.memorySearch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const s = useMemoryStore.getState()
    s.setQuery('first')
    const p1 = s.search(WS_A)
    s.setQuery('second')
    const p2 = s.search(WS_A)
    second.resolve(envelope('second-answer'))
    await p2
    first.resolve(envelope('first-answer'))
    await p1
    const items = useMemoryStore.getState().results?.items ?? []
    expect(items).toHaveLength(1)
    expect(String(items[0].item.content)).toBe('second-answer')
  })

  it('drops detail A when selection B wins the race', async () => {
    const gateA = deferred<unknown>()
    api.memoryEntity.mockReturnValueOnce(gateA.promise).mockResolvedValueOnce({ id: 'e2' })
    api.memoryHistory.mockResolvedValue(null)
    const s = useMemoryStore.getState()
    const pA = s.select(WS_A, 'global', 'e1')
    const pB = s.select(WS_A, 'global', 'e2')
    gateA.resolve({ id: 'e1' })
    await Promise.all([pA, pB])
    expect(useMemoryStore.getState().detail).toEqual({ id: 'e2' })
  })

  it('resets search state on workspace switch', async () => {
    api.memorySearch.mockResolvedValue(envelope('a'))
    const s = useMemoryStore.getState()
    s.setQuery('q')
    await s.search(WS_A)
    expect(useMemoryStore.getState().results?.items).toHaveLength(1)
    api.memorySearch.mockResolvedValue(envelope('b'))
    await s.search(WS_B)
    // The second search ran against the new workspace; its answers apply.
    expect(String(useMemoryStore.getState().results?.items[0].item.content)).toBe('b')
    expect(useMemoryStore.getState().lastWorkspaceId).toBe(WS_B)
  })

  it('drops a late answer that arrives after a workspace switch', async () => {
    const slow = deferred<unknown>()
    api.memorySearch.mockReturnValueOnce(slow.promise)
    const s = useMemoryStore.getState()
    s.setQuery('q')
    const pSlow = s.search(WS_A)
    // Switch workspace with an instant answer.
    api.memorySearch.mockResolvedValue(envelope('fresh'))
    await s.search(WS_B)
    slow.resolve(envelope('stale'))
    await pSlow
    expect(String(useMemoryStore.getState().results?.items[0].item.content)).toBe('fresh')
  })

  it('setContext resets a stale category filter on workspace switch', async () => {
    const s = useMemoryStore.getState()
    s.setContext(WS_A, true)
    s.setCategoryFilter('decision')
    expect(useMemoryStore.getState().categoryFilter).toBe('decision')
    s.setContext(WS_B, true)
    expect(useMemoryStore.getState().categoryFilter).toBe('all')
    expect(useMemoryStore.getState().results).toBeNull()
  })

  it('setContext clears search state on workspace switch without a new search', async () => {
    api.memorySearch.mockResolvedValue(envelope('a'))
    const s = useMemoryStore.getState()
    s.setContext(WS_A, true)
    s.setQuery('q')
    await s.search(WS_A)
    expect(useMemoryStore.getState().results?.items).toHaveLength(1)
    s.setContext(WS_B, true)
    const st = useMemoryStore.getState()
    expect(st.results).toBeNull()
    expect(st.selectedId).toBe('')
    expect(st.lastWorkspaceId).toBe(WS_B)
  })

  it('disable during a delayed review response drops it and resets', async () => {
    const slow = deferred<unknown>()
    api.memoryReviewList.mockReturnValueOnce(slow.promise)
    const s = useMemoryStore.getState()
    s.setContext(WS_A, true)
    const p = s.refreshReview()
    s.setContext(WS_A, false)
    slow.resolve({ queued: [{ id: 1 }], counts: { queued: 1 } })
    await p
    const st = useMemoryStore.getState()
    expect(st.review).toBeNull()
    expect(st.results).toBeNull()
  })

  it('no stale data surfaces after re-enable without refresh', async () => {
    const s = useMemoryStore.getState()
    s.setContext(WS_A, true)
    api.memoryReviewList.mockResolvedValue({ queued: [], counts: {} })
    await s.refreshReview()
    s.setContext(WS_A, false)
    expect(useMemoryStore.getState().review).toBeNull()
    s.setContext(WS_A, true)
    // Re-enable resets to empty; only an explicit refresh repopulates.
    expect(useMemoryStore.getState().review).toBeNull()
    expect(useMemoryStore.getState().results).toBeNull()
  })

  it('delayed shadow list after disable writes nothing', async () => {
    const slow = deferred<unknown>()
    api.memoryShadowRuns.mockReturnValueOnce(slow.promise)
    const s = useMemoryStore.getState()
    s.setContext(WS_A, true)
    const p = s.refreshShadow()
    s.setContext(WS_A, false)
    slow.resolve([{ id: 1 }])
    await p
    expect(useMemoryStore.getState().shadow).toBeNull()
  })
  it('delayed post-decide refresh after disable+re-enable writes nothing', async () => {
    const slow = deferred<unknown>()
    api.memoryReviewDecide.mockResolvedValue({ id: 7 })
    api.memoryReviewList.mockReturnValueOnce(slow.promise)
    const s = useMemoryStore.getState()
    s.setContext(WS_A, true)
    const p = s.decide(7, false, 1)
    // Decide-RPC durch, Refresh hängt: Disable + Re-Enable dazwischen.
    while (api.memoryReviewList.mock.calls.length === 0) {
      await new Promise((r) => setTimeout(r, 0))
    }
    s.setContext(WS_A, false)
    s.setContext(WS_A, true)
    slow.resolve({ queued: [{ id: 9 }], counts: { queued: 1 } })
    await p
    const st = useMemoryStore.getState()
    expect(st.review).toBeNull()
    expect(st.preview).toBeNull()
  })
  it('setContext is idempotent for the same context', async () => {
    api.memorySearch.mockResolvedValue(envelope('a'))
    const s = useMemoryStore.getState()
    s.setContext(WS_A, true)
    s.setQuery('q')
    await s.search(WS_A)
    s.setContext(WS_A, true) // mount + shell double-call: must not wipe
    expect(useMemoryStore.getState().results?.items).toHaveLength(1)
  })
  it('resets stale state when disabled', async () => {
    api.memoryStatus.mockResolvedValue({ enabled: false, ready: false })
    useMemoryStore.setState({
      results: {
        items: [{ item: { id: 'x' }, db: 'global' }],
        missing: [],
        partial: false,
        completeEmpty: false,
        hasMore: false,
      },
      selectedId: 'x',
    })
    await useMemoryStore.getState().refreshStatus()
    const st = useMemoryStore.getState()
    expect(st.status).toEqual({ enabled: false, ready: false })
    expect(st.results).toBeNull()
    expect(st.selectedId).toBe('')
  })

  it('refreshBrowse loads the selected store and clears search results', async () => {
    api.memoryBrowse.mockResolvedValue(page('browsed'))
    api.memoryStatus.mockResolvedValue({ enabled: true, ready: true })
    api.memoryEntity.mockResolvedValue({ id: 'e1' })
    api.memoryHistory.mockResolvedValue(null)
    const s = useMemoryStore.getState()
    s.setContext(WS_A, true)
    await s.refreshBrowse(WS_A)
    // Auto-select fires (fire-and-forget): let it land.
    await new Promise((r) => setTimeout(r, 0))
    const st = useMemoryStore.getState()
    expect(st.browse?.items).toHaveLength(1)
    expect(String(st.browse?.items[0].item.content)).toBe('browsed')
    expect(st.results).toBeNull()
    expect(api.memoryBrowse).toHaveBeenCalledWith(WS_A, { db: 'workspace' })
    // First entry auto-selected: no void detail.
    expect(st.selectedId).toBe('e1')
    // Status re-read after a successful browse.
    expect(st.status).toEqual({ enabled: true, ready: true })
  })

  it('empty-query search falls back to browse', async () => {
    api.memoryBrowse.mockResolvedValue(page('fallback'))
    const s = useMemoryStore.getState()
    s.setContext(WS_A, true)
    s.setQuery('   ')
    await s.search(WS_A)
    expect(api.memorySearch).not.toHaveBeenCalled()
    expect(useMemoryStore.getState().browse?.items).toHaveLength(1)
  })

  it('loadMore appends without duplicates', async () => {
    api.memoryBrowse.mockResolvedValue(
      page('p1', { hasMore: true, nextCursor: 'c1' }),
    )
    const s = useMemoryStore.getState()
    s.setContext(WS_A, true)
    await s.refreshBrowse(WS_A)
    api.memoryBrowse.mockResolvedValue({
      ...(page('p2') as Record<string, unknown>),
      items: [
        { item: { id: 'e1', category: 'decision', key: 'k', content: 'p1' }, db: `workspace:${WS_A}` },
        { item: { id: 'e2', category: 'gotcha', key: 'k2', content: 'p2' }, db: `workspace:${WS_A}` },
      ],
      hasMore: false,
      nextCursor: null,
    })
    await s.loadMore(WS_A)
    const items = useMemoryStore.getState().browse?.items ?? []
    expect(items.map((m) => String(m.item.id)).sort()).toEqual(['e1', 'e2'])
  })

  it('setScope resets stale state and search honors the selected scope', async () => {
    api.memoryBrowse.mockResolvedValue(page('g'))
    api.memorySearch.mockResolvedValue(envelope('s'))
    const s = useMemoryStore.getState()
    s.setContext(WS_A, true)
    s.setScope('global', null)
    await s.refreshBrowse(WS_A)
    expect(api.memoryBrowse).toHaveBeenCalledWith(WS_A, { db: 'global' })
    s.setQuery('q')
    await s.search(WS_A)
    expect(api.memorySearch).toHaveBeenCalledWith(WS_A, 'q', 10, ['global'])
  })

  it('a selection mid-loadMore still lands the page and clears busy', async () => {
    const gate = deferred<unknown>()
    api.memoryBrowse.mockResolvedValue(
      page('p1', { hasMore: true, nextCursor: 'c1' }),
    )
    const s = useMemoryStore.getState()
    s.setContext(WS_A, true)
    await s.refreshBrowse(WS_A)
    api.memoryEntity.mockResolvedValue({ id: 'e1' })
    api.memoryHistory.mockResolvedValue(null)
    api.memoryBrowse.mockReturnValueOnce(gate.promise)
    const pMore = s.loadMore(WS_A)
    // Select while the page is in flight: must not strand browsing=true.
    await s.select(WS_A, `workspace:${WS_A}`, 'e1')
    gate.resolve(page('p2'))
    await pMore
    const st = useMemoryStore.getState()
    expect(st.browsing).toBe(false)
    expect(st.browse?.items.length).toBeGreaterThan(0)
    expect(st.selectedId).toBe('e1')
  })

  it('a select during refreshBrowse clears busy without landing stale rows', async () => {
    const gate = deferred<unknown>()
    api.memoryBrowse.mockReturnValueOnce(gate.promise)
    api.memoryEntity.mockResolvedValue({ id: 'e9' })
    api.memoryHistory.mockResolvedValue(null)
    const s = useMemoryStore.getState()
    s.setContext(WS_A, true)
    const pBrowse = s.refreshBrowse(WS_A)
    await s.select(WS_A, `workspace:${WS_A}`, 'e9')
    gate.resolve(page('stale'))
    await pBrowse
    const st = useMemoryStore.getState()
    expect(st.browsing).toBe(false)
    expect(st.browse).toBeNull() // stale page dropped, not resurrected
    expect(st.selectedId).toBe('e9')
  })

  it('a malformed loadMore page clears busy and keeps the list', async () => {
    api.memoryBrowse.mockResolvedValue(page('p1', { hasMore: true, nextCursor: 'c1' }))
    const s = useMemoryStore.getState()
    s.setContext(WS_A, true)
    await s.refreshBrowse(WS_A)
    api.memoryBrowse.mockResolvedValue({ garbage: true })
    await s.loadMore(WS_A)
    const st = useMemoryStore.getState()
    expect(st.browsing).toBe(false)
    expect(st.browse?.items).toHaveLength(1)
  })

  it('search clears a stale browsing flag when it replaces the list', async () => {
    api.memoryBrowse.mockResolvedValue(page('p1', { hasMore: true, nextCursor: 'c1' }))
    api.memorySearch.mockResolvedValue(envelope('s'))
    const s = useMemoryStore.getState()
    s.setContext(WS_A, true)
    await s.refreshBrowse(WS_A)
    // Simulate a stranded busy flag (older revision left it true).
    useMemoryStore.setState({ browsing: true })
    s.setQuery('q')
    await s.search(WS_A)
    const st = useMemoryStore.getState()
    expect(st.browsing).toBe(false)
    expect(st.results?.items).toHaveLength(1)
  })

  it('a refreshBrowse error after select publishes no error and clears busy', async () => {
    const gate = deferred<unknown>()
    api.memoryBrowse.mockReturnValueOnce(gate.promise)
    api.memoryEntity.mockResolvedValue({ id: 'e9' })
    api.memoryHistory.mockResolvedValue(null)
    const s = useMemoryStore.getState()
    s.setContext(WS_A, true)
    const pBrowse = s.refreshBrowse(WS_A)
    await s.select(WS_A, `workspace:${WS_A}`, 'e9')
    gate.reject(new Error('vault died'))
    await pBrowse
    const st = useMemoryStore.getState()
    expect(st.browsing).toBe(false)
    expect(st.error).toBeNull() // dead context: the select owns the UI
    expect(st.selectedId).toBe('e9')
  })
})
