import { test, expect } from '@playwright/test'
import { execFileSync, execSync } from 'child_process'
import { existsSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { launchApp, closeApp } from './helpers'
import type { LaunchedApp } from './helpers'

interface VaultStatus {
  operational?: boolean
  dbFile?: string
  pid?: number | null
  endedClean?: boolean
}

function vaultBinaryPresent(): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'perseus-vault.exe' : 'perseus-vault', ['--version'])
    return true
  } catch {
    return false
  }
}

async function pollFor(fn: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const end = Date.now() + timeoutMs
  for (;;) {
    if (fn()) return
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 250))
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function ancestorPids(pid: number, depth = 6): number[] {
  // Electron on Windows nests helper processes: the vault child need not be a
  // DIRECT child of the launched process, but the app must own the chain.
  // Single process-table snapshot (one subprocess), then walk in JS.
  let table = ''
  try {
    table =
      process.platform === 'win32'
        ? execSync(
            'powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | Format-Table -HideTableHeaders"',
            { encoding: 'utf8', timeout: 20_000 },
          )
        : execSync('ps -eo pid=,ppid=', { encoding: 'utf8', timeout: 20_000 })
  } catch {
    const direct = parentPid(pid)
    return direct === null ? [] : [direct]
  }
  const parent = new Map<number, number>()
  for (const line of table.split('\n')) {
    const nums = line.trim().split(/\s+/).map(Number)
    if (nums.length >= 2 && Number.isFinite(nums[0]) && Number.isFinite(nums[1]) && nums[0] > 0) {
      parent.set(nums[0], nums[1])
    }
  }
  const chain: number[] = []
  let current: number | undefined = pid
  for (let i = 0; i < depth && current !== undefined; i++) {
    current = parent.get(current)
    if (current !== undefined && current > 0) chain.push(current)
  }
  return chain
}

function parentPid(pid: number): number | null {
  try {
    const out =
      process.platform === 'win32'
        ? execSync(
            `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ParentProcessId"`,
            { encoding: 'utf8' },
          )
        : execSync(`ps -o ppid= -p ${pid}`, { encoding: 'utf8' })
    const n = Number(out.trim())
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

function pingPids(): number[] {
  try {
    if (process.platform === 'win32') {
      const out = execSync('tasklist /FI "IMAGENAME eq PING.EXE" /FO CSV', { encoding: 'utf8' })
      const pids: number[] = []
      for (const line of out.split('\n').slice(1)) {
        const cols = line.split('","')
        const n = Number((cols[1] ?? '').replace(/"/g, '').trim())
        if (Number.isFinite(n) && n > 0) pids.push(n)
      }
      return pids
    }
    const out = execSync('pgrep -x ping || true', { encoding: 'utf8' })
    return out
      .split('\n')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
  } catch {
    return []
  }
}

function vaultPids(): number[] {
  try {
    if (process.platform === 'win32') {
      const out = execSync('tasklist /FI "IMAGENAME eq perseus-vault.exe" /FO CSV', { encoding: 'utf8' })
      const pids: number[] = []
      for (const line of out.split('\n').slice(1)) {
        const cols = line.split('","')
        const n = Number((cols[1] ?? '').replace(/"/g, '').trim())
        if (Number.isFinite(n) && n > 0) pids.push(n)
      }
      return pids
    }
    const out = execSync('pgrep -x perseus-vault || true', { encoding: 'utf8' })
    return out
      .split('\n')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
  } catch {
    return []
  }
}

function readStatus(userDataDir: string): VaultStatus | null {
  const file = join(userDataDir, 'vault', 'global.status.json')
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as VaultStatus
  } catch {
    return null
  }
}

// The app already quit on its own (via evaluate-app.quit): only reap files.
async function cleanupDeadApp(ctx: LaunchedApp): Promise<void> {
  await ctx.app.close().catch(() => undefined)
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(ctx.userDataDir, { recursive: true, force: true })
      return
    } catch {
      await new Promise((r) => setTimeout(r, 200))
    }
  }
}

async function quitApp(ctx: LaunchedApp): Promise<void> {
  // Register the close wait BEFORE quitting: a fast exit must not be missed.
  const closed = ctx.app.waitForEvent('close', { timeout: 30_000 })
  await ctx.app.evaluate(({ app }) => app.quit())
  await closed
}

test.describe('memory vault wiring', () => {
  test('disabled by default: no vault processes, no vault files', async () => {
    // Foreign vault processes (e.g. a developer's live instance) are not
    // ours: diff PIDs around the test instead of asserting system-wide
    // absence — and never touch them.
    const before = new Set(vaultPids())
    const ctx = await launchApp()
    try {
      expect(existsSync(join(ctx.userDataDir, 'vault'))).toBe(false)
      expect(readStatus(ctx.userDataDir)).toBeNull()
      await ctx.app.close()
      const leaked = vaultPids().filter((pid) => !before.has(pid))
      expect(leaked).toEqual([])
    } finally {
      await closeApp(ctx)
    }
  })

  test('enabled vault boots isolated with owned PID and leaves no child behind on quit', async () => {
    test.skip(!vaultBinaryPresent(), 'perseus-vault binary not on PATH')
    const ctx = await launchApp({ memoryVaultEnabled: true })
    try {
      const expectedDb = join(ctx.userDataDir, 'vault', 'global.db')
      const expectedKey = join(ctx.userDataDir, 'vault', 'keys', 'global.key')
      await pollFor(() => readStatus(ctx.userDataDir)?.operational === true, 25_000, 'operational status')
      const status = readStatus(ctx.userDataDir)
      expect(status?.dbFile).toBe(expectedDb) // exact isolated path, never the live vault DB
      expect(existsSync(expectedDb)).toBe(true)
      expect(existsSync(expectedKey)).toBe(true)
      expect(typeof status?.pid).toBe('number')
      const vaultPid = status?.pid as number
      expect(processAlive(vaultPid)).toBe(true)
      expect(ancestorPids(vaultPid)).toContain(ctx.app.process().pid) // app-owned, not foreign

      await quitApp(ctx)
      await pollFor(() => !processAlive(vaultPid), 15_000, 'owned vault PID to exit')
      const closed = readStatus(ctx.userDataDir)
      expect(closed?.endedClean).toBe(true)
    } finally {
      await cleanupDeadApp(ctx)
    }
  })

  test('double quit during a delayed drain waits once and exits cleanly', async () => {
    test.skip(!vaultBinaryPresent(), 'perseus-vault binary not on PATH')
    const ctx = await launchApp({ memoryVaultEnabled: true }, { ITTOP_VAULT_TEST_DRAIN_DELAY_MS: '5000' })
    try {
      await pollFor(() => readStatus(ctx.userDataDir)?.operational === true, 25_000, 'operational status')
      const vaultPid = readStatus(ctx.userDataDir)?.pid as number
      const t0 = Date.now()
      await Promise.all([quitApp(ctx), quitApp(ctx)]) // two quits join one drain
      expect(Date.now() - t0).toBeGreaterThanOrEqual(4000) // drain was awaited, not bypassed
      await pollFor(() => !processAlive(vaultPid), 15_000, 'owned vault PID to exit')
    } finally {
      await cleanupDeadApp(ctx)
    }
  })

  test('a mid-drain vault failure still cleans the PTY session and quits', async () => {
    test.skip(!vaultBinaryPresent(), 'perseus-vault binary not on PATH')
    test.setTimeout(90_000)
    const pingsBefore = new Set(pingPids())
    const ctx = await launchApp({ memoryVaultEnabled: true }, { ITTOP_VAULT_TEST_ABORT_DRAIN: '1' })
    try {
      // A harmless never-ending PTY session: must be reaped by the quit drain.
      const { window } = ctx
      await window.locator('button[title="New workspace (Ctrl+N)"]').click()
      await window.locator('.modal input').first().fill('Vault E2E')
      await window.locator('.folder-row input').fill(tmpdir())
      await window.locator('.modal-actions button.primary').click()
      await expect(window.locator('.workspace-item', { hasText: 'Vault E2E' })).toBeVisible()
      await window.locator('.sidebar-tab', { hasText: 'Workspaces' }).click()
      await window
        .locator('.workspace-group')
        .filter({ hasText: 'Vault E2E' })
        .locator('.terminal-add-row')
        .click()
      await window.locator('.modal input').first().fill('pinger')
      await window.locator('.modal label:has-text("Start command") input').fill('ping -t 127.0.0.1')
      await window.locator('.modal-actions button.primary', { hasText: 'Add' }).click()
      await expect(window.locator('.terminal-pane .terminal-pane-title')).toContainText('pinger')
      await pollFor(
        () => pingPids().some((p) => !pingsBefore.has(p)),
        20_000,
        'a new ping.exe from our terminal',
      )

      await pollFor(() => readStatus(ctx.userDataDir)?.operational === true, 25_000, 'operational status')
      const vaultPid = readStatus(ctx.userDataDir)?.pid as number
      await quitApp(ctx) // vault drain aborts mid-flight; PTY drain must still run
      await pollFor(() => !processAlive(vaultPid), 15_000, 'owned vault PID to exit')
      const leaked = pingPids().filter((p) => !pingsBefore.has(p))
      expect(leaked).toEqual([]) // PTY cleanup ran despite the vault failure
      const closed = readStatus(ctx.userDataDir)
      expect(closed?.error).toContain('aborted mid-flight')
    } finally {
      await cleanupDeadApp(ctx)
    }
  })
})
