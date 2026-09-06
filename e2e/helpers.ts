import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

export interface LaunchedApp {
  app: ElectronApplication
  window: Page
  userDataDir: string
}

export interface SeedWorkspace {
  id: string
  name: string
}

export async function launchApp(
  seed?: { memoryVaultEnabled?: boolean; workspaces?: SeedWorkspace[]; vaultSeed?: SeedWorkspace[] },
  envExtra?: Record<string, string>,
): Promise<LaunchedApp> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'ittop-e2e-'))

  if (seed) {
    const { writeFileSync, copyFileSync, mkdirSync } = await import('fs')
    // Isolated vault seed (7a smoke): VACUUM-copy the MIGRATED per-UUID DBs
    // (proven 6a read-only pattern) plus their key files — the exact
    // migrated distribution, no hash rewriting, no live writes. A missing
    // migrated DB fails loudly instead of seeding something else.
    for (const w of seed.vaultSeed ?? []) {
      const { DatabaseSync } = await import('node:sqlite')
      const appVault = 'C:\\Users\\dinli\\AppData\\Roaming\\ittop\\vault'
      const srcDb = join(appVault, 'workspaces', `${w.id}.db`)
      const wsDir = join(userDataDir, 'vault', 'workspaces')
      const keyDir = join(userDataDir, 'vault', 'keys', 'workspaces')
      mkdirSync(wsDir, { recursive: true })
      mkdirSync(keyDir, { recursive: true })
      const destDb = join(wsDir, `${w.id}.db`)
      const src = new DatabaseSync(srcDb, { readOnly: true })
      try {
        src.exec(`VACUUM INTO '${destDb.replace(/'/g, "''")}'`)
      } finally {
        src.close()
      }
      copyFileSync(join(appVault, 'keys', 'workspaces', `${w.id}.key`), join(keyDir, `${w.id}.key`))
    }
    writeFileSync(
      join(userDataDir, 'workspaces.json'),
      JSON.stringify({
        workspaces: (seed.workspaces ?? []).map((w, i) => ({
          id: w.id,
          name: w.name,
          projectPath: '',
          order: i,
          terminals: [],
        })),
        settings: {
          sidebarWidth: 280,
          sidebarCollapsed: false,
          filePanelWidth: 340,
          activeWorkspaceId: seed.workspaces?.[0]?.id ?? null,
          theme: 'dark',
          notificationsEnabled: true,
          defaultStartCommand: 'claude',
          idleDebounceMs: 1200,
          paneColFractions: [],
          memoryVaultEnabled: seed.memoryVaultEnabled === true,
        },
      }),
    )
  }

  // require, not import: Playwright's test runner executes under plain Node, so requiring the
  // `electron` package here returns the path to the platform Electron binary (its normal
  // behavior outside of an actual Electron process) — exactly what executablePath needs.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const electronPath = require('electron') as unknown as string

  const env = { ...process.env }
  if (envExtra) Object.assign(env, envExtra)
  // This sandboxed dev session sets ELECTRON_RUN_AS_NODE globally, which makes a bare
  // `electron` invocation run as plain Node instead of launching the app (app/BrowserWindow
  // undefined). Real user machines don't have this set, but strip it defensively either way.
  delete env.ELECTRON_RUN_AS_NODE
  env.ITTOP_USER_DATA_DIR = userDataDir

  const app = await electron.launch({
    executablePath: electronPath,
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env
  })
  // From here on we own the handle: EVERY failure path closes our own app —
  // never foreign processes — so hung launches can't orphan tray dwellers.
  try {
    // Unpackaged runs open a detached DevTools window (is.dev); when it wins
    // the window race, firstWindow() grabs it instead of the app. Fall
    // through to the first non-devtools window in that case.
    let window = await app.firstWindow()
    if (window.url().startsWith('devtools')) {
      // The app window opened before/while DevTools won the firstWindow
      // race (its 'window' event already fired): poll the window list.
      const deadline = Date.now() + 30_000
      for (;;) {
        const candidate = app.windows().find((w) => !w.url().startsWith('devtools'))
        if (candidate) {
          window = candidate
          break
        }
        if (Date.now() > deadline) throw new Error('timed out waiting for app window behind DevTools')
        await new Promise((r) => setTimeout(r, 250))
      }
    }
    // 'domcontentloaded' fires before our SPA's React tree has actually mounted; wait for a
    // real rendered element instead of racing the app's own async startup (IPC round trip for
    // getWorkspaces() + getHookServerInfo() in the store's load()).
    await window.locator('.app-shell').waitFor({ state: 'attached', timeout: 30_000 })
    return { app, window, userDataDir }
  } catch (e) {
    await app.close().catch(() => undefined)
    throw e
  }
}

export async function closeApp({ app, userDataDir }: LaunchedApp): Promise<void> {
  await app.close()
  // The just-killed process can hold its userData files open for a brief moment after
  // app.close() resolves in this environment; retry the cleanup instead of throwing.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(userDataDir, { recursive: true, force: true })
      return
    } catch {
      await new Promise((r) => setTimeout(r, 200))
    }
  }
}
