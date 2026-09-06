import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  entryFingerprint,
  entryId,
  planDigest,
  runMigration,
  type ManifestFile,
  type MigrationEntry,
  type RunnerDeps,
} from '../migrate'

const WS_A = '11111111-1111-4111-8111-111111111111'
const WS_B = '22222222-2222-4222-8222-222222222222'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

function plan(): MigrationEntry[] {
  return [
    { workspaceUuid: WS_A, category: 'decision', key: 'k1', body: '{"content":"one"}', entityType: 'insight', tags: ['a'] },
    { workspaceUuid: WS_A, category: 'decision', key: 'k2', body: '{"content":"two"}', entityType: 'insight', tags: [] },
    { workspaceUuid: WS_B, category: 'gotcha', key: 'k3', body: '{"content":"three"}', entityType: 'insight', tags: [] },
  ]
}

interface Row {
  body: string
  fields: Record<string, unknown>
}

function rowFor(e: MigrationEntry, scope?: string): Row {
  return {
    body: e.body,
    fields: { category: e.category, key: e.key, entity_type: e.entityType, tags: e.tags, workspace_hash: scope ?? e.workspaceUuid },
  }
}

function stubDeps(
  // store: compositeId -> row
  store: Map<string, Row>,
  opts: { aborted?: () => boolean; paths?: Record<string, string> } = {},
): RunnerDeps & { writes: string[] } {
  const writes: string[] = []
  const pathFor = (uuid: string): string =>
    opts.paths?.[uuid.toLowerCase()] ?? `/tmp/vault/workspaces/${uuid.toLowerCase()}.db`
  return {
    writes,
    targetHasEntities: (uuid) => [...store.keys()].some((k) => k.startsWith(`${uuid.toLowerCase()}/`)),
    targetPath: (uuid) => pathFor(uuid),
    targetIdentities: async (uuid) =>
      [...store.keys()]
        .filter((k) => k.startsWith(`${uuid.toLowerCase()}/`))
        .map((k) => {
          const [storedUuid, category, ...rest] = k.split('/')
          return { category, key: rest.join('/'), workspace_hash: storedUuid }
        }),
    writeEntry: (e) => {
      writes.push(e.key)
      store.set(entryId(e), rowFor(e))
    },
    readBack: async (uuid, category, key) => {
      const row = store.get(`${uuid.toLowerCase()}/${category}/${key}`)
      return row ?? null
    },
    recallKeys: async (uuid, query) =>
      [...store.keys()].filter((k) => k.startsWith(`${uuid.toLowerCase()}/`) && k.includes(query)),
    isAborted: opts.aborted ?? (() => false),
  }
}

function manifestHeader(p: MigrationEntry[] = plan()): Omit<ManifestFile, 'rows'> {
  return {
    version: 1,
    planDigest: planDigest(p),
    targets: [...new Set(p.map((e) => e.workspaceUuid.toLowerCase()))],
    targetPaths: Object.fromEntries(
      [...new Set(p.map((e) => e.workspaceUuid.toLowerCase()))].map((u) => [u, `/tmp/vault/workspaces/${u}.db`]),
    ),
  }
}

describe('runMigration', () => {
  it('migrates all entries with manifest and receipt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ittop-mig-'))
    dirs.push(dir)
    const deps = stubDeps(new Map())
    const receipt = await runMigration(plan(), join(dir, 'manifest.json'), deps)
    expect(receipt.aborted).toBe(false)
    expect(receipt.entries).toHaveLength(3)
    expect(receipt.entries.every((e) => e.verified && !e.adopted)).toBe(true)
    expect(deps.writes).toEqual(['k1', 'k2', 'k3'])
  })

  it('refuses populated targets before writing anything', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ittop-mig-'))
    dirs.push(dir)
    const store = new Map<string, Row>([[`${WS_B}/decision/old`, rowFor(plan()[2])]])
    const deps = stubDeps(store)
    await expect(runMigration(plan(), join(dir, 'manifest.json'), deps)).rejects.toThrow(/already holds entities/)
    expect(deps.writes).toEqual([])
  })

  it('refuses foreign plans, foreign rows, changed paths and corrupt manifests', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ittop-mig-'))
    dirs.push(dir)
    const foreign = plan().map((e) => ({ ...e, workspaceUuid: WS_B }))
    const manifestFile = join(dir, 'manifest.json')
    await runMigration(plan(), manifestFile, stubDeps(new Map()))
    await expect(runMigration(foreign, manifestFile, stubDeps(new Map()))).rejects.toThrow(
      /different plan|outside this manifest/,
    )
    // Foreign manifest row.
    const withForeign = JSON.parse(
      (await import('node:fs')).readFileSync(manifestFile, 'utf8'),
    ) as ManifestFile
    withForeign.rows['00000000-0000-4000-8000-000000000000/decision/evil'] = {
      fingerprint: 'x',
      status: 'done',
      db: 'workspace:00000000-0000-4000-8000-000000000000',
      adopted: false,
    }
    writeFileSync(manifestFile, JSON.stringify(withForeign))
    await expect(runMigration(plan(), manifestFile, stubDeps(new Map()))).rejects.toThrow(/foreign or invalid entry/)
    // Changed target path.
    const deps2 = stubDeps(new Map(), { paths: { [WS_A.toLowerCase()]: '/elsewhere/a.db' } })
    const dir2 = mkdtempSync(join(tmpdir(), 'ittop-mig-'))
    dirs.push(dir2)
    const manifest2 = join(dir2, 'manifest.json')
    await runMigration(plan(), manifest2, stubDeps(new Map()))
    await expect(runMigration(plan(), manifest2, deps2)).rejects.toThrow(/target path.*changed/)
    // Corrupt manifest locks.
    writeFileSync(manifestFile, 'not-json{{{')
    await expect(runMigration(plan(), manifestFile, stubDeps(new Map()))).rejects.toThrow(/corrupt/)
  })

  it('refuses extra targets and removed path bindings on loaded manifests', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ittop-mig-'))
    dirs.push(dir)
    const manifestFile = join(dir, 'manifest.json')
    await runMigration(plan(), manifestFile, stubDeps(new Map()))
    const { readFileSync } = await import('node:fs')
    const base = JSON.parse(readFileSync(manifestFile, 'utf8')) as ManifestFile
    // Extra target UUID.
    writeFileSync(
      manifestFile,
      JSON.stringify({ ...base, targets: [...base.targets, '99999999-9999-4999-8999-999999999999'] }),
    )
    await expect(runMigration(plan(), manifestFile, stubDeps(new Map()))).rejects.toThrow(/targets differ/)
    // Removed path binding.
    const { [WS_A.toLowerCase()]: _dropped, ...rest } = base.targetPaths
    void _dropped
    writeFileSync(manifestFile, JSON.stringify({ ...base, targetPaths: rest }))
    await expect(runMigration(plan(), manifestFile, stubDeps(new Map()))).rejects.toThrow(/target paths/)
  })

  it('refuses foreign categories under a known key on resume', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ittop-mig-'))
    dirs.push(dir)
    // Target holds decision/k1 (planned) plus gotcha/k1 (foreign category).
    const [p1] = plan()
    const store = new Map<string, Row>([
      [entryId(p1), rowFor(p1)],
      [`${WS_A}/gotcha/k1`, { body: '{"content":"foreign"}', fields: { category: 'gotcha', key: 'k1' } }],
    ])
    const deps = stubDeps(store)
    const manifestFile = join(dir, 'manifest.json')
    writeFileSync(
      manifestFile,
      JSON.stringify({
        ...manifestHeader(),
        rows: { [entryId(p1)]: { fingerprint: entryFingerprint(p1), status: 'done', db: `workspace:${WS_A}`, adopted: false } },
      }),
    )
    await expect(runMigration(plan(), manifestFile, deps)).rejects.toThrow(/foreign identity/)
    expect(deps.writes).toEqual([])
  })
  it('stops at the kill-switch with resumable state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ittop-mig-'))
    dirs.push(dir)
    let allow = 2
    const store = new Map<string, Row>()
    const deps = stubDeps(store, { aborted: () => allow <= 0 })
    const wrapped: RunnerDeps = {
      ...deps,
      writeEntry: (e) => {
        ;(deps as unknown as { writes: string[] }).writes.push(e.key)
        store.set(entryId(e), rowFor(e))
        allow -= 1
      },
    }
    const manifest = join(dir, 'manifest.json')
    const first = await runMigration(plan(), manifest, wrapped)
    expect(first.aborted).toBe(true)
    expect(first.entries).toHaveLength(2)
    allow = 99
    const second = await runMigration(plan(), manifest, wrapped)
    expect(second.aborted).toBe(false)
    expect(second.entries).toHaveLength(3)
    expect(second.entries.every((e) => e.verified)).toBe(true)
    expect(store.size).toBe(3)
  })

  it('refuses empty manifest over populated targets (first-write crash goes to operator)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ittop-mig-'))
    dirs.push(dir)
    const store = new Map<string, Row>([[entryId(plan()[0]), rowFor(plan()[0])]])
    const deps = stubDeps(store)
    await expect(runMigration(plan(), join(dir, 'manifest.json'), deps)).rejects.toThrow(/already holds entities/)
    expect(deps.writes).toEqual([])
  })

  it('adopts crash-window writes without rewriting (no extra history)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ittop-mig-'))
    dirs.push(dir)
    const [p1, p2] = plan()
    const store = new Map<string, Row>([
      [entryId(p1), rowFor(p1)],
      [entryId(p2), rowFor(p2)],
    ])
    const deps = stubDeps(store)
    const manifestFile = join(dir, 'manifest.json')
    writeFileSync(
      manifestFile,
      JSON.stringify({
        ...manifestHeader(),
        rows: { [entryId(p1)]: { fingerprint: entryFingerprint(p1), status: 'done', db: `workspace:${WS_A}`, adopted: false } },
      }),
    )
    const writeSpy = vi.fn(deps.writeEntry)
    const receipt = await runMigration(plan(), manifestFile, { ...deps, writeEntry: writeSpy })
    expect(receipt.entries.find((e) => e.key === 'k1')?.adopted).toBe(false)
    expect(receipt.entries.find((e) => e.key === 'k2')?.adopted).toBe(true)
    expect(writeSpy).not.toHaveBeenCalledWith(expect.objectContaining({ key: 'k1' }))
    expect(writeSpy).not.toHaveBeenCalledWith(expect.objectContaining({ key: 'k2' }))
    expect(writeSpy).toHaveBeenCalledTimes(1)
    expect(store.size).toBe(3)
  })

  it('re-verifies done rows whose fingerprint no longer matches (no blind skip)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ittop-mig-'))
    dirs.push(dir)
    const [p1] = plan()
    const store = new Map<string, Row>([[entryId(p1), rowFor(p1)]])
    const deps = stubDeps(store)
    const manifestFile = join(dir, 'manifest.json')
    writeFileSync(
      manifestFile,
      JSON.stringify({
        ...manifestHeader(),
        rows: { [entryId(p1)]: { fingerprint: 'stale-fingerprint', status: 'done', db: `workspace:${WS_A}`, adopted: false } },
      }),
    )
    const writeSpy = vi.fn(deps.writeEntry)
    const receipt = await runMigration(plan(), manifestFile, { ...deps, writeEntry: writeSpy })
    expect(receipt.entries.find((e) => e.key === 'k1')?.adopted).toBe(true)
    expect(writeSpy).not.toHaveBeenCalledWith(expect.objectContaining({ key: 'k1' }))
    expect(receipt.entries.every((e) => e.verified)).toBe(true)
  })

  it('fails closed on diverging present entries instead of overwriting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ittop-mig-'))
    dirs.push(dir)
    const [p1] = plan()
    const store = new Map<string, Row>([
      [entryId(p1), { body: '{"content":"foreign body"}', fields: { ...rowFor(p1).fields } }],
    ])
    const deps = stubDeps(store)
    const manifestFile = join(dir, 'manifest.json')
    writeFileSync(
      manifestFile,
      JSON.stringify({
        ...manifestHeader(),
        rows: {},
      }),
    )
    // Empty manifest + populated target refuses first (fresh-target rule)...
    await expect(runMigration(plan(), manifestFile, deps)).rejects.toThrow(/already holds entities/)
    // ...and with a partial manifest the diverging row fails closed, not overwritten.
    const [p2] = plan().slice(1)
    void p2
    const manifest2 = join(dir, 'manifest2.json')
    writeFileSync(
      manifest2,
      JSON.stringify({
        ...manifestHeader(),
        rows: { [entryId(p1)]: { fingerprint: entryFingerprint(p1), status: 'in_progress', db: `workspace:${WS_A}`, adopted: false } },
      }),
    )
    await expect(runMigration(plan(), manifest2, deps)).rejects.toThrow(/diverging entry/)
    expect(deps.writes).toEqual([])
  })

  it('keeps same key in different categories distinct', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ittop-mig-'))
    dirs.push(dir)
    const sameKey: MigrationEntry[] = [
      { workspaceUuid: WS_A, category: 'decision', key: 'dup', body: '{"content":"d"}', entityType: 'insight', tags: [] },
      { workspaceUuid: WS_A, category: 'gotcha', key: 'dup', body: '{"content":"g"}', entityType: 'insight', tags: [] },
    ]
    const deps = stubDeps(new Map())
    const receipt = await runMigration(sameKey, join(dir, 'manifest.json'), deps)
    expect(receipt.entries).toHaveLength(2)
    expect(deps.writes).toEqual(['dup', 'dup'])
  })

  it('refuses wrong stored scope even with matching key and category', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ittop-mig-'))
    dirs.push(dir)
    const [p1] = plan()
    // Row stored under the right composite id, but the STORED scope field
    // points elsewhere: adoption must fail on scope, and the diverging row
    // must fail closed (never silently adopted, never overwritten).
    const store = new Map<string, Row>([
      [entryId(p1), { ...rowFor(p1), fields: { ...rowFor(p1).fields, workspace_hash: WS_B } }],
    ])
    const deps = stubDeps(store)
    const manifestFile = join(dir, 'manifest.json')
    writeFileSync(
      manifestFile,
      JSON.stringify({
        ...manifestHeader(),
        rows: { [entryId(p1)]: { fingerprint: 'stale', status: 'in_progress', db: `workspace:${WS_A}`, adopted: false } },
      }),
    )
    await expect(runMigration(plan(), manifestFile, deps)).rejects.toThrow(/diverging entry/)
    expect(deps.writes).toEqual([])
  })
})
