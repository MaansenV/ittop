import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface MigrationEntry {
  /** Target workspace UUID (resolved, never a name). */
  workspaceUuid: string
  category: string
  key: string
  /** Canonical body JSON string (includes recall_when where declared). */
  body: string
  entityType: string
  tags: string[]
}

export type ManifestStatus = 'in_progress' | 'done'

export interface ManifestRow {
  fingerprint: string
  status: ManifestStatus
  db: string
  adopted: boolean
}

export interface ManifestFile {
  version: 1
  /** SHA-256 over the canonical plan (entries). Binds manifest to plan. */
  planDigest: string
  /** Workspace UUIDs this manifest was created for. Foreign targets refused. */
  targets: string[]
  /** Expected target DB paths (derived at creation). Changed paths refused. */
  targetPaths: Record<string, string>
  rows: Record<string, ManifestRow>
}

export interface RunnerDeps {
  /** True when the target DB already holds entities (fresh, empty targets
   * enforced: the runner never merges into populated DBs). */
  targetHasEntities: (workspaceUuid: string) => boolean | Promise<boolean>
  /** Canonical DB file path for a workspace (bound at creation). */
  targetPath: (workspaceUuid: string) => string
  /** All stored identities in the target (category/key/scope for the resume check). */
  targetIdentities: (workspaceUuid: string) => Promise<StoredIdentity[]>
  /** Single write through the approved path (CLI authority write). */
  writeEntry: (entry: MigrationEntry) => void | Promise<void>
  /** Read back body + fields, or null when absent. Identity: UUID/category/key. */
  readBack: (
    workspaceUuid: string,
    category: string,
    key: string,
  ) => Promise<{ body: string; fields: Record<string, unknown> } | null>
  /** Dense recall keys in one workspace scope. */
  recallKeys: (workspaceUuid: string, query: string) => Promise<string[]>
  /** Kill-switch: checked before every entry AND right before each write. */
  isAborted: () => boolean
  onEvent?: (message: string) => void
}

export interface StoredIdentity {
  category: string
  key: string
  workspace_hash: string
}

export interface EntryReceipt {
  key: string
  db: string
  adopted: boolean
  verified: boolean
}

export interface MigrationReceipt {
  entries: EntryReceipt[]
  aborted: boolean
}

/** Composite identity: UUID + category + key (never key alone). */
export function entryId(e: Pick<MigrationEntry, 'workspaceUuid' | 'category' | 'key'>): string {
  return `${e.workspaceUuid.toLowerCase()}/${e.category}/${e.key}`
}

/** Full payload fingerprint: body + type + tags + scope (not just body). */
export function entryFingerprint(e: MigrationEntry): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        workspaceUuid: e.workspaceUuid.toLowerCase(),
        category: e.category,
        key: e.key,
        body: e.body,
        entityType: e.entityType,
        tags: [...e.tags].sort(),
      }),
    )
    .digest('hex')
}

export function planDigest(plan: MigrationEntry[]): string {
  return createHash('sha256')
    .update(JSON.stringify(plan.map((e) => ({ id: entryId(e), fingerprint: entryFingerprint(e) }))))
    .digest('hex')
}

function loadManifest(path: string, plan: MigrationEntry[]): { manifest: ManifestFile; isNew: boolean } {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        manifest: {
          version: 1,
          planDigest: planDigest(plan),
          targets: [...new Set(plan.map((e) => e.workspaceUuid.toLowerCase()))],
          targetPaths: {},
          rows: {},
        },
        isNew: true,
      }
    }
    throw e
  }
  let parsed: ManifestFile
  try {
    parsed = JSON.parse(raw) as ManifestFile
  } catch {
    throw new Error(`refusing to run: manifest at ${path} is corrupt (not JSON)`)
  }
  if (parsed.version !== 1 || typeof parsed.rows !== 'object' || !parsed.rows) {
    throw new Error(`refusing to run: manifest at ${path} has unknown shape`)
  }
  if (parsed.planDigest !== planDigest(plan)) {
    throw new Error('refusing to run: manifest belongs to a different plan')
  }
  return { manifest: parsed, isNew: false }
}

function validRow(row: unknown): row is ManifestRow {
  if (typeof row !== 'object' || row === null) return false
  const r = row as Record<string, unknown>
  return (
    typeof r.fingerprint === 'string' &&
    (r.status === 'in_progress' || r.status === 'done') &&
    typeof r.db === 'string' &&
    typeof r.adopted === 'boolean'
  )
}

function saveManifest(path: string, manifest: ManifestFile): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.manifest.${process.pid}.tmp`)
  writeFileSync(tmp, JSON.stringify(manifest, null, 2))
  renameSync(tmp, path) // atomic replace: readers never see half a manifest
}

// Executable 6b runner (Phase-6 plan §5/§6). Proof runs use temp DBs and
// synthetic bodies through this exact code path; the live run differs only
// in inputs (real bodies, confirmed UUIDs) and approvals — never in logic.
// Safety, all enforced here (not trusted to callers):
// - fresh targets: refuses when any target already holds entities (never
//   merges into populated DBs — file absence is meaningless since the
//   vault creates files on ensure);
// - manifest binding: plan digest + target UUID set + exact target paths;
//   unknown rows, foreign targets and changed paths refused; corrupt
//   manifests LOCK (only ENOENT means restart);
// - foreign existing content refused: on resume, every key present in a
//   target must belong to this plan (adopted-or-planned), nothing else;
// - composite identity (UUID/category/key) + full payload fingerprint
//   (body/type/tags/scope) everywhere, compared against the ACTUAL stored
//   scope (never the expected one);
// - kill-switch: checked before every entry AND immediately before the
//   actual write (after all awaits);
// - crash windows: manifest-first (in_progress + fingerprint) before write,
//   done after; resume verify-reconciles (adopt identical fingerprint,
//   never rewrite); a present-but-diverging entry fails closed (operator
//   decides, never repair-overwrite), so a crash between write and done
//   leaves no duplicate and no extra history;
// - done-skips re-verify the target fully (never blind trust).
export async function runMigration(
  plan: MigrationEntry[],
  manifestPath: string,
  deps: RunnerDeps,
): Promise<MigrationReceipt> {
  const { manifest, isNew } = loadManifest(manifestPath, plan)
  const targets = new Set(manifest.targets)
  const planUuids = new Set(plan.map((e) => e.workspaceUuid.toLowerCase()))
  if (!isNew) {
    // Loaded manifest: exact equality — no added/removed UUIDs, no added/
    // removed path bindings, no invalid rows. Anything else is foreign.
    // (Fresh manifests bind their paths in the block below instead.)
    const sameUuids =
      planUuids.size === targets.size && [...planUuids].every((u) => targets.has(u))
    if (!sameUuids) {
      throw new Error('refusing to run: manifest targets differ from plan targets')
    }
    const pathKeys = new Set(Object.keys(manifest.targetPaths ?? {}))
    const samePaths =
      pathKeys.size === targets.size &&
      [...targets].every((u) => typeof manifest.targetPaths[u] === 'string' && manifest.targetPaths[u].length > 0)
    if (!samePaths) {
      throw new Error('refusing to run: manifest target paths missing, extra, or empty')
    }
    const plannedIds = new Set(plan.map(entryId))
    for (const [id, row] of Object.entries(manifest.rows)) {
      if (!plannedIds.has(id) || !validRow(row)) {
        throw new Error(`refusing to run: manifest holds foreign or invalid entry ${id}`)
      }
    }
  }
  // Bind + verify exact target paths (first run records, later runs enforce).
  // Missing bindings on a loaded manifest refuse (never silently filled).
  for (const uuid of targets) {
    const expected = deps.targetPath(uuid)
    const recorded = manifest.targetPaths[uuid]
    if (recorded === undefined) {
      if (!isNew) {
        throw new Error(`refusing to run: manifest lacks target path binding for ${uuid}`)
      }
      manifest.targetPaths[uuid] = expected
    } else if (recorded !== expected) {
      throw new Error(`refusing to run: target path for ${uuid} changed (recorded ${recorded}, now ${expected})`)
    }
  }
  // Unknown manifest rows refused (nothing foreign rides along).
  const plannedIds = new Set(plan.map(entryId))
  for (const id of Object.keys(manifest.rows)) {
    if (!plannedIds.has(id)) {
      throw new Error(`refusing to run: manifest holds foreign entry ${id}`)
    }
  }
  // Fresh targets enforced only on a fresh start: resumes continue into
  // the targets the first run created (manifest rows prove that).
  if (Object.keys(manifest.rows).length === 0) {
    for (const e of plan) {
      if (await deps.targetHasEntities(e.workspaceUuid)) {
        throw new Error(`refusing to write: target for workspace ${e.workspaceUuid} already holds entities`)
      }
    }
  } else {
    // Resume: every identity present in a target must belong to this plan
    // exactly (UUID/category/key) — foreign categories under a known key
    // are refused just like foreign keys.
    for (const uuid of targets) {
      const present = await deps.targetIdentities(uuid)
      const allowed = new Set(
        plan.filter((e) => e.workspaceUuid.toLowerCase() === uuid).map((e) => `${e.category}/${e.key}`),
      )
      for (const idn of present) {
        if ((idn.workspace_hash ?? '').toLowerCase() !== uuid || !allowed.has(`${idn.category}/${idn.key}`)) {
          throw new Error(`refusing to run: target ${uuid} holds foreign identity ${idn.category}/${idn.key}`)
        }
      }
    }
  }
  const receipt: EntryReceipt[] = []
  const wantId = (e: MigrationEntry): string => entryId(e)
  const wantFingerprint = (e: MigrationEntry): string => entryFingerprint(e)

  const verifyIdentity = (
    e: MigrationEntry,
    back: { body: string; fields: Record<string, unknown> } | null,
  ): boolean => {
    if (!back) return false
    // Actual stored scope/category/key — never the expected values.
    if ((back.fields['workspace_hash'] as string)?.toLowerCase() !== e.workspaceUuid.toLowerCase()) return false
    if ((back.fields['category'] as string) !== e.category) return false
    if ((back.fields['key'] as string) !== e.key) return false
    return (
      entryFingerprint({
        workspaceUuid: e.workspaceUuid,
        category: String(back.fields['category'] ?? ''),
        key: String(back.fields['key'] ?? ''),
        body: back.body,
        entityType: String(back.fields['entity_type'] ?? back.fields['type'] ?? ''),
        tags: Array.isArray(back.fields['tags']) ? (back.fields['tags'] as string[]) : [],
      }) === wantFingerprint(e)
    )
  }

  for (const e of plan) {
    if (deps.isAborted()) {
      saveManifest(manifestPath, manifest)
      return { entries: receipt, aborted: true }
    }
    const id = wantId(e)
    const want = wantFingerprint(e)
    const db = `workspace:${e.workspaceUuid.toLowerCase()}`
    const done = manifest.rows[id]
    if (done?.status === 'done' && done.fingerprint === want) {
      // Done-skip with FULL re-verification (never blind trust).
      const current = await deps.readBack(e.workspaceUuid, e.category, e.key)
      if (!verifyIdentity(e, current)) {
        throw new Error(`refusing to run: manifest says done for ${id} but target verification failed`)
      }
      receipt.push({ key: e.key, db, adopted: false, verified: true })
      continue
    }
    // Verify-reconcile: adopt identical fingerprint without rewriting.
    const current = await deps.readBack(e.workspaceUuid, e.category, e.key)
    if (current) {
      if (verifyIdentity(e, current)) {
        manifest.rows[id] = { fingerprint: want, status: 'done', db, adopted: true }
        saveManifest(manifestPath, manifest)
        receipt.push({ key: e.key, db, adopted: true, verified: true })
        continue
      }
      // Present but diverging: fail closed for the operator, never
      // repair-overwrite (an overwrite would silently fork history).
      throw new Error(
        `refusing to run: target holds diverging entry for ${id} (verify first, then decide)`,
      )
    }
    manifest.rows[id] = { fingerprint: want, status: 'in_progress', db, adopted: false }
    saveManifest(manifestPath, manifest)
    // Kill-switch re-checked immediately before the actual write: everything
    // awaited above (recall, reads) could have taken arbitrarily long.
    if (deps.isAborted()) {
      saveManifest(manifestPath, manifest)
      return { entries: receipt, aborted: true }
    }
    await deps.writeEntry(e)
    const back = await deps.readBack(e.workspaceUuid, e.category, e.key)
    if (!verifyIdentity(e, back)) {
      throw new Error(`verify failed for ${e.category}/${e.key}: written content mismatch`)
    }
    manifest.rows[id] = { fingerprint: want, status: 'done', db, adopted: false }
    saveManifest(manifestPath, manifest)
    receipt.push({ key: e.key, db, adopted: false, verified: true })
    deps.onEvent?.(`migrated ${e.category}/${e.key}`)
  }
  return { entries: receipt, aborted: false }
}
