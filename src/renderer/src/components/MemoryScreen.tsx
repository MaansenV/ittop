import { Fragment, useEffect, useRef, useState } from 'react'
import type { MemoryReviewRow } from '../../../shared/types'
import { IconBrain, IconCheck, IconX } from './icons'
import { useAppStore } from '../store/useAppStore'
import { useMemoryStore } from '../store/useMemoryStore'
import {
  asJson,
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
} from './memoryFormat'

export default function MemoryScreen({
  workspaceId,
  onClose,
}: {
  workspaceId: string | null
  onClose: () => void
}): React.JSX.Element {
  const [tab, setTab] = useState<'browse' | 'review' | 'ops'>('browse')
  const [reviewId, setReviewId] = useState<number | null>(null)
  const [copied, setCopied] = useState(false)
  const [scopeHint, setScopeHint] = useState(() => {
    try {
      return localStorage.getItem('ittop.scopeHintSeen') !== '1'
    } catch {
      return true
    }
  })
  const dismissScopeHint = (): void => {
    setScopeHint(false)
    try {
      localStorage.setItem('ittop.scopeHintSeen', '1')
    } catch {
      // private mode: hint returns next visit, harmless
    }
  }
  const mounted = useRef(false)
  const s = useMemoryStore()
  const appWorkspaces = useAppStore((w) => w.workspaces)

  const dbName = (db: string): string => {
    if (db === 'global') return 'Global'
    const id = db.replace(/^workspace:/, '')
    return appWorkspaces.find((w) => w.id.toLowerCase() === id.toLowerCase())?.name ?? 'Unnamed workspace'
  }

  useEffect(() => {
    // Own context first (idempotent): later shell changes bump it again.
    // Browse-first: the list loads immediately, no search needed. Browse
    // bumps the generation, so it runs FIRST — status/review/shadow capture
    // the post-bump generation and their answers survive.
    s.setContext(workspaceId, true)
    if (workspaceId) void s.refreshBrowse(workspaceId)
    void s.refreshStatus()
    void s.refreshReview()
    void s.refreshShadow()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    // App workspace switch while the screen is open: follow it (mount is
    // covered above; setContext stays idempotent on identical repeats).
    if (!mounted.current) {
      mounted.current = true
      return
    }
    s.setContext(workspaceId, true)
    if (workspaceId) void s.refreshBrowse(workspaceId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId])

  useEffect(() => {
    // Screen-wide Escape (inputs handle their own keys too).
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selectedReview: MemoryReviewRow | null =
    s.review?.queued.find((r) => r.id === reviewId) ?? null

  // Unified list: backend search results win when present, else the browse
  // page. Category chips + page filter narrow the loaded page (labelled
  // "Filter"); "Search" asks the backend (labelled "Search").
  const mode: 'browse' | 'search' = s.results ? 'search' : 'browse'
  const baseItems = s.results?.items ?? s.browse?.items ?? []
  const categories = (() => {
    const counts = new Map<string, number>()
    for (const m of baseItems) {
      const c = str(m.item.category) || '(none)'
      counts.set(c, (counts.get(c) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  })()
  const visibleItems = baseItems.filter((m) => {
    if (s.categoryFilter !== 'all' && str(m.item.category) !== s.categoryFilter) return false
    if (s.tagFilter !== 'all' && !tagsOf(m.item).includes(s.tagFilter)) return false
    if (s.statusFilter !== 'all' && str(m.item.status || 'active') !== s.statusFilter) return false
    const f = s.pageFilter.trim().toLowerCase()
    if (!f) return true
    const hay =
      `${str(m.item.key)} ${str(m.item.category)} ${str(m.item.content)} ${tagsOf(m.item).join(' ')}`.toLowerCase()
    return hay.includes(f)
  })
  const sortedItems = [...visibleItems].sort((a, b) => {
    if (s.groupByCat) {
      const c = str(a.item.category).localeCompare(str(b.item.category))
      if (c !== 0) return c
    }
    if (s.sortKey === 'title') return str(a.item.key).localeCompare(str(b.item.key))
    if (s.sortKey === 'used') return usedOf(b.item) - usedOf(a.item)
    return recentOf(b.item) - recentOf(a.item)
  })
  const allTags = (() => {
    const set = new Set<string>()
    for (const m of baseItems) for (const t of tagsOf(m.item)) set.add(t)
    return [...set].sort()
  })()
  const allStatuses = (() => {
    const set = new Set<string>()
    for (const m of baseItems) set.add(str(m.item.status) || 'active')
    return [...set].sort()
  })()
  const totalLabel = mode === 'browse' ? (s.browse?.total ?? null) : null
  const selectedItem =
    baseItems.find((m) => String(m.item.id) === s.selectedId && m.db === s.selectedDb)?.item ?? null

  return (
    <div className="memory-screen">
      <div className="memory-header">
        <strong className="memory-brand">
          <IconBrain size={17} /> Memory
        </strong>
        <span className="memory-crumb">
          / {s.scope === 'global' ? 'Global' : (appWorkspaces.find((w) => w.id === (s.scopeWs ?? workspaceId))?.name ?? 'Workspace')}
        </span>
        <span
          className={`memory-pill${s.status?.ready ? ' ready' : ''}`}
          title={s.status?.ready ? 'Vaults ready' : 'Vaults not ready yet — boot them, then retry'}
        >
          <span className={`memory-dot${s.status?.ready ? ' ready' : ''}`} />
          {s.status?.ready ? 'ready' : 'starting…'}
        </span>
        {!s.status?.ready && (
          <button className="btn" onClick={() => void s.refreshStatus()}>
            Retry
          </button>
        )}
        <select
          aria-label="Memory workspace"
          value={s.scope === 'global' ? 'global' : (s.scopeWs ?? workspaceId ?? '')}
          disabled={!workspaceId}
          onChange={(e) => {
            const v = e.target.value
            if (v === 'global') {
              s.setScope('global', null)
            } else {
              s.setScope('workspace', v)
            }
            if (workspaceId) {
              // Scope-dependent list first, then the scope-independent
              // review (same generation order as mount).
              void s.refreshBrowse(workspaceId).then(() => s.refreshReview())
            }
          }}
        >
          {appWorkspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
          <option value="global">Global</option>
        </select>
        <span className="memory-status">
          {mode === 'browse'
            ? `Browse · ${totalLabel === null ? '–' : totalLabel} entries`
            : `Search results · ${visibleItems.length} shown`}
        </span>
        <div className="memory-tabs">
          <button className={`btn btn-tab${tab === 'browse' ? ' active' : ''}`} onClick={() => setTab('browse')}>
            Browse
          </button>
          <button className={`btn btn-tab${tab === 'review' ? ' active' : ''}`} onClick={() => setTab('review')}>
            Review{s.review ? ` (${s.review.queued.length})` : ''}
          </button>
          <button className={`btn btn-tab${tab === 'ops' ? ' active' : ''}`} onClick={() => setTab('ops')}>
            Ops
          </button>
        </div>
        <button className="btn memory-close" onClick={onClose}>
          <IconX size={13} /> Close
        </button>
      </div>

      {s.error && (
        <div className="memory-error">
          {s.error} <button onClick={() => s.clearError()}>dismiss</button>
        </div>
      )}

      {scopeHint && (
        <div className="memory-hintbar">
          <span>
            Showing <strong>{s.scope === 'global' ? 'Global' : (appWorkspaces.find((w) => w.id === (s.scopeWs ?? workspaceId))?.name ?? 'this workspace')}</strong>{' '}—
            only this store, nothing else. Switch stores above; Global is separate.
          </span>
          <button className="btn btn-chip" onClick={dismissScopeHint}>
            Got it
          </button>
        </div>
      )}

      {tab === 'browse' && (
        <div className="memory-body">
          <div className="memory-list">
            <div className="memory-searchbar">
              <input
                aria-label="Search the vault"
                placeholder={workspaceId ? 'Search the vault…' : 'Open a workspace first…'}
                value={s.query}
                disabled={!workspaceId}
                onChange={(e) => s.setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && workspaceId) void s.search(workspaceId)
                  if (e.key === 'Escape') onClose()
                }}
              />
              <button
                className="btn btn-primary"
                disabled={!workspaceId || s.searching}
                onClick={() => workspaceId && void s.search(workspaceId)}
              >
                {s.searching ? '…' : 'Search'}
              </button>
              {mode === 'search' && (
                <button
                  className="btn btn-chip"
                  onClick={() => {
                    s.setQuery('')
                    if (workspaceId) void s.refreshBrowse(workspaceId)
                  }}
                >
                  Clear
                </button>
              )}
            </div>
            <div className="memory-hint">
              {mode === 'browse'
                ? 'All entries of the selected store — newest first.'
                : 'Vault results for the query above.'}
            </div>
            {baseItems.length > 0 && (
              <div className="memory-searchbar">
                <input
                  aria-label="Filter loaded entries"
                  placeholder="Filter…"
                  className="memory-filter-inline"
                  value={s.pageFilter}
                  onChange={(e) => s.setPageFilter(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') onClose()
                  }}
                />
                <button
                  className={`btn btn-chip${s.categoryFilter === 'all' ? ' active' : ''}`}
                  onClick={() => s.setCategoryFilter('all')}
                >
                  all ({baseItems.length})
                </button>
                {categories.map(([c, n]) => (
                  <button
                    key={c}
                    className={`btn btn-chip${s.categoryFilter === c ? ' active' : ''}`}
                    onClick={() => s.setCategoryFilter(c)}
                  >
                    {c} ({n})
                  </button>
                ))}
              </div>
            )}
            {mode === 'search' && s.results?.partial && (
              <div className="memory-warn">Partial result — some DBs failed (see Ops).</div>
            )}
            {(mode === 'search' ? (s.results?.missing ?? []) : (s.browse?.missing ? [s.browse.missing] : [])).map(
              (mm) => (
                <div key={mm.db} className="memory-warn">
                  Store {dbName(mm.db)} incomplete: {mm.reason}
                </div>
              ),
            )}
            {mode === 'search' && s.results?.completeEmpty && <div className="memory-hint">No matches.</div>}
            {baseItems.length > 0 && (
              <div className="memory-searchbar">
                <select aria-label="Filter by tag" value={s.tagFilter} onChange={(e) => s.setTagFilter(e.target.value)}>
                  <option value="all">all tags</option>
                  {allTags.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Filter by status"
                  value={s.statusFilter}
                  onChange={(e) => s.setStatusFilter(e.target.value)}
                >
                  <option value="all">all states</option>
                  {allStatuses.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <select aria-label="Sort entries" value={s.sortKey} onChange={(e) => s.setSortKey(e.target.value as 'recent' | 'title' | 'used')}>
                  <option value="recent">recent first</option>
                  <option value="title">title A–Z</option>
                  <option value="used">most used</option>
                </select>
                <label className="memory-hint">
                  <input
                    type="checkbox"
                    checked={s.groupByCat}
                    onChange={(e) => s.setGroupByCat(e.target.checked)}
                  />{' '}group
                </label>
              </div>
            )}
            {mode === 'browse' && s.browsing && baseItems.length === 0 && (
              <div className="memory-hint">Loading entries…</div>
            )}
            {mode === 'browse' && s.browse?.noStore && (
              <div className="memory-hint">No memory store yet for this selection — entries appear after first use.</div>
            )}
            {mode === 'browse' && !s.browsing && !s.browse?.noStore && baseItems.length === 0 && (
              <div className="memory-hint">No entries in this store.</div>
            )}
            {sortedItems.map((m, idx) => {
              const id = String(m.item.id ?? '')
              const active = s.selectedId === id && s.selectedDb === m.db
              const tags = tagsOf(m.item)
              const when = dateOf(m.item.last_accessed_unix_ms ?? m.item.created_at_unix_ms)
              const cat = str(m.item.category) || '(none)'
              const prev = idx > 0 ? str(sortedItems[idx - 1].item.category) || '(none)' : null
              const showHeader = s.groupByCat && cat !== prev
              return (
                <Fragment key={`${m.db}:${id}`}>
                  {showHeader && <div className="memory-group">{cat}</div>}
                  <button
                  className={`memory-row${active ? ' active' : ''}`}
                  onClick={() => workspaceId && void s.select(workspaceId, m.db, id)}
                >
                  <span className="memory-key memory-card-title">{titleOf(str(m.item.key))}</span>
                  <div className="memory-badges">
                    <span className="memory-badge">{dbName(m.db)}</span>
                    {str(m.item.category) && <span className="memory-badge">{str(m.item.category)}</span>}
                    {str(m.item.status) && str(m.item.status) !== 'active' && (
                      <span className="memory-badge">{str(m.item.status)}</span>
                    )}
                    {tags.map((t) => (
                      <span key={t} className="memory-badge">
                        {t}
                      </span>
                    ))}
                    {when && <span className="memory-also">{when}</span>}
                  </div>
                  {'alsoIn' in m && Array.isArray(m.alsoIn) && m.alsoIn.length > 0 && (
                    <span className="memory-also">
                      also in {m.alsoIn.map((a: { db: string }) => dbName(a.db)).join(', ')}
                    </span>
                  )}
                  <div className="memory-snippet">{snippet(m.item.content)}</div>
                </button>
                </Fragment>
              )
            })}
            {baseItems.length > 0 && visibleItems.length === 0 && (
              <div className="memory-hint">Filter hides all entries — pick another category or clear the filter.</div>
            )}
            {mode === 'browse' && s.browse?.hasMore && (
              <button className="btn" disabled={s.browsing} onClick={() => workspaceId && void s.loadMore(workspaceId)}>
                {s.browsing ? 'Loading…' : `More (${s.browse.total === null ? '–' : s.browse.total} total)`}
              </button>
            )}
            {mode === 'search' && s.results?.hasMore && (
              <div className="memory-hint">More results may exist — narrow the query.</div>
            )}
          </div>
          <div className="memory-detail">
            {!s.selectedId && (
              <div className="memory-empty">
                <IconBrain size={28} />
                <div>Select an entry for detail + history.</div>
              </div>
            )}
            {s.selectedId &&
              (() => {
                const body = detailContent(s.detail, selectedItem ? str(selectedItem.content) : '')
                const steps = body ? stepsOf(body) : null
                const paras = !steps && body ? paragraphsOf(body) : []
                const hints = recallWhenOf(s.detail, selectedItem)
                const stats = statCardsOf(s.detail)
                const entityType = selectedItem ? str(selectedItem.entity_type) : ''
                const showType = entityType && entityType !== str(selectedItem?.category ?? '')
                const copy = (): void => {
                  setCopied(false)
                  void navigator.clipboard?.writeText(body).then(
                    () => setCopied(true),
                    () => undefined,
                  )
                  window.setTimeout(() => setCopied(false), 1500)
                }
                return (
                  <>
                    <h2 className="memory-title">
                      {selectedItem ? titleOf(str(selectedItem.key)) : s.selectedId}
                    </h2>
                    <div className="memory-badges">
                      {selectedItem && str(selectedItem.category) && (
                        <span className="memory-badge memory-badge-cat">{str(selectedItem.category)}</span>
                      )}
                      {showType && <span className="memory-badge">{entityType}</span>}
                      {selectedItem &&
                        tagsOf(selectedItem).map((t) => (
                          <span key={t} className="memory-badge memory-badge-tag">
                            #{t}
                          </span>
                        ))}
                    </div>
                    {steps && (
                      <ol className="memory-steps">
                        {steps.map((st, i) => (
                          <li key={i}>{st}</li>
                        ))}
                      </ol>
                    )}
                    {!steps && paras.map((p, i) => <p key={i}>{p}</p>)}
                    {!body && <div className="memory-hint">No readable content — see developer details below.</div>}
                    {hints.length > 0 && (
                      <>
                        <h4>When to use</h4>
                        <ul className="memory-hints">
                          {hints.map((h, i) => (
                            <li key={i}>{h}</li>
                          ))}
                        </ul>
                      </>
                    )}
                    {stats.length > 0 && (
                      <div className="memory-meta-line">
                        {dbName(s.selectedDb)} · {stats.map((st) => `${st.label} ${st.value}`).join(' · ')}
                      </div>
                    )}
                    {body && (
                      <div className="memory-actions">
                        <button className="btn" onClick={copy}>
                          {copied ? (
                            <>
                              <IconCheck size={13} /> Copied
                            </>
                          ) : (
                            'Copy content'
                          )}
                        </button>
                      </div>
                    )}
                    <details>
                      <summary>History ({historyVersions(s.detailHistory).length})</summary>
                      {historyVersions(s.detailHistory).length === 0 && (
                        <div className="memory-hint">No versions recorded.</div>
                      )}
                      {historyVersions(s.detailHistory).map((v, i) => (
                        <div key={i} className="memory-hint">
                          <strong>{versionTime(v) || `#${i + 1}`}</strong>
                          {(str(v.category) || str(v.key)) && (
                            <span>
                              {' '}· {str(v.category)} {str(v.key)}
                            </span>
                          )}
                          <div>{versionBlurb(v)}</div>
                        </div>
                      ))}
                    </details>
                    <details>
                      <summary>Developer details</summary>
                      <pre>{asJson(s.detail)}</pre>
                    </details>
                  </>
                )
              })()}
          </div>
        </div>
      )}

      {tab === 'review' && (
        <div className="memory-body">
          <div className="memory-list">
            <div className="memory-hint">
              Queued candidates live OUTSIDE the vault (never surface in recall). Target DB per row.
            </div>
            {s.review?.queued.map((r) => (
              <button
                key={r.id}
                className={`memory-row${reviewId === r.id ? ' active' : ''}`}
                onClick={() => setReviewId(r.id)}
              >
                <span className="memory-badge">{dbName(r.db)}</span>
                <span className="memory-key">
                  {r.category} / {r.key}
                </span>
                <span className="memory-also">
                  rev {r.revision} · {r.verdictDecision}
                </span>
                <div className="memory-snippet">{snippet(r.content)}</div>
              </button>
            ))}
            {s.review && s.review.queued.length === 0 && <div className="memory-hint">Queue empty.</div>}
          </div>
          <div className="memory-detail">
            {!selectedReview && !s.preview && (
              <div className="memory-hint">Select a candidate to decide.</div>
            )}
            {selectedReview && (
              <>
                <h3>
                  #{selectedReview.id} {selectedReview.category} / {selectedReview.key}
                </h3>
                <div className="memory-hint">
                  Target: <strong>{dbName(selectedReview.db)}</strong> · rev {selectedReview.revision} · verdict{' '}
                  {selectedReview.verdictDecision}
                </div>
                <p>{selectedReview.content}</p>
                <div className="memory-hint">Future use: {selectedReview.futureUse}</div>
                <div className="memory-hint">Triggers: {selectedReview.triggers.join(' · ')}</div>
                <div className="memory-hint">Source: {selectedReview.sourceRef}</div>
                <div className="memory-decide">
                  <button
                    className="btn btn-danger"
                    onClick={() => void s.decide(selectedReview.id, false, selectedReview.revision)}
                  >
                    Reject
                  </button>
                  <button
                    className="btn btn-primary"
                    onClick={() => void s.decide(selectedReview.id, true, selectedReview.revision)}
                  >
                    Approve
                  </button>
                </div>
                <div className="memory-hint">Approve on `review` verdicts needs override (audited):</div>
                <div className="memory-hint">
                  Verdict `review` means the agent is unsure and needs a human. Approving stages the entry (still no
                  vault write — promotion stays a dry-run preview below).
                </div>
                <div className="memory-searchbar">
                  <input
                    placeholder="by (name)"
                    value={s.overrideBy}
                    onChange={(e) => s.setOverride(e.target.value, s.overrideReason)}
                  />
                  <input
                    placeholder="reason"
                    value={s.overrideReason}
                    onChange={(e) => s.setOverride(s.overrideBy, e.target.value)}
                  />
                </div>
                <h4>Promotion preview (dry run — no vault write)</h4>
                <pre>{asJson(s.preview)}</pre>
              </>
            )}
            {s.preview && !selectedReview && (
              <>
                <div className="memory-hint">Approved — the queue no longer lists it. Preview:</div>
                <pre>{asJson(s.preview)}</pre>
              </>
            )}
          </div>
        </div>
      )}

      {tab === 'ops' && (
        <div className="memory-ops">
          <h3>Status</h3>
          <div className="memory-hint">
            {s.status?.ready ? 'Vaults are up and serving reads.' : 'Vaults not ready — reads fail closed until boot finishes.'}
          </div>
          <pre>{asJson(s.status)}</pre>
          <h3>Review counts</h3>
          <div className="memory-hint">Candidates per state — queued ones wait in the Review tab.</div>
          {s.review && Object.entries(s.review.counts).map(([k, v]) => (
            <div key={k} className="memory-hint">
              {k}: <strong>{v}</strong>
            </div>
          ))}
          <h3>Shadow runs (Stop hooks — dry-run policy probes, newest first)</h3>
          {!s.shadow && <div className="memory-hint">No shadow runs yet.</div>}
          {s.shadow?.map((r) => (
            <div key={r.id} className="memory-hint">
              #{r.id} · {new Date(r.createdAt).toLocaleTimeString()} · {r.hookEvent} · {r.workspaceId.slice(0, 8)} ·
              recall {r.recallHits} · policy-probe approvals {r.notesAccepted}/{r.notesTotal} (synthetic, not a real
              admission rate)
            </div>
          ))}
          {s.results && s.results.missing.length > 0 && (
            <>
              <h3>Missing DBs (last search)</h3>
              <pre>{asJson(s.results.missing)}</pre>
            </>
          )}
          <div className="memory-hint">
            Vault promotion is dry-run only in this phase (locked until migration). Review decisions touch only the
            isolated review queue.
          </div>
        </div>
      )}
    </div>
  )
}
