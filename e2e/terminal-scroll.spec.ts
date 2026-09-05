import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { SearchAddon } from '@xterm/addon-search'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// A bare Electron window: no ittop main process, hook server, real PTYs or user workspaces.
// Override only for running the identical regression against another installed xterm release.
const packages = process.env.ITTOP_XTERM_TEST_MODULES ?? resolve('node_modules')
const xtermPath = (file: string): string => join(packages, '@xterm', file)

declare global {
  interface Window {
    terminal: Terminal
    fit: FitAddon
    search: SearchAddon
    writeOutput: (data: string) => Promise<void>
    settle: () => Promise<void>
    safeFits: number
    stream: ReturnType<typeof setInterval>
  }
}

let app: ElectronApplication | undefined
let page: Page
let directory: string

test.beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'ittop-scroll-test-'))
  const main = join(directory, 'main.cjs')
  writeFileSync(main, `const { app, BrowserWindow } = require('electron');
app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 1000, height: 800, webPreferences: { backgroundThrottling: false } });
  window.loadURL('about:blank');
});`)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ executablePath: require('electron'), args: [main], env })
  page = await app.firstWindow()
  await page.setContent(`<div class="app-shell"><div class="main-area"><div class="panes">
    <div class="terminal-pane" style="display:flex"><div class="terminal-pane-header">Scroll regression</div>
    <div class="terminal-container"></div></div></div></div></div>`)
  await page.addStyleTag({ path: xtermPath('xterm/css/xterm.css') })
  await page.addStyleTag({ path: resolve('src/renderer/src/styles.css') })
  for (const file of ['xterm/lib/xterm.js', 'addon-fit/lib/addon-fit.js', 'addon-search/lib/addon-search.js', 'addon-web-links/lib/addon-web-links.js']) {
    await page.addScriptTag({ path: xtermPath(file) })
  }
  await page.evaluate(async () => {
    const constructors = window as unknown as {
      Terminal: new (options: object) => Terminal
      FitAddon: { FitAddon: new () => FitAddon }
      SearchAddon: { SearchAddon: new () => SearchAddon }
      WebLinksAddon: { WebLinksAddon: new () => { activate(terminal: Terminal): void; dispose(): void } }
    }
    window.terminal = new constructors.Terminal({
      scrollback: 10000, cursorBlink: true, convertEol: true,
      fontFamily: 'Cascadia Code, Consolas, monospace', fontSize: 13
    })
    window.fit = new constructors.FitAddon.FitAddon()
    window.search = new constructors.SearchAddon.SearchAddon()
    terminal.loadAddon(fit)
    terminal.loadAddon(search)
    terminal.loadAddon(new constructors.WebLinksAddon.WebLinksAddon())
    const container = document.querySelector<HTMLElement>('.terminal-container')!
    terminal.open(container)
    window.settle = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))
    window.writeOutput = (data) => new Promise((done) => terminal.write(data, done))
    // Mirror TerminalPane's hidden-size guard and 120 ms ResizeObserver debounce.
    window.safeFits = 0
    const safeFit = (): void => {
      if (!container.clientWidth || !container.clientHeight) return
      fit.fit()
      window.safeFits++
    }
    let timer: ReturnType<typeof setTimeout>
    new ResizeObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(safeFit, 120)
    }).observe(container)
    await settle()
    safeFit()
    terminal.focus()
  })
  await page.waitForFunction(() => window.safeFits >= 2)
  await writeLines(0, 200)
  await page.mouse.move(500, 350)
})

test.afterEach(async ({}, testInfo) => {
  try {
    if (page && !page.isClosed()) {
      await testInfo.attach('scroll-state', { body: JSON.stringify(await snapshot(), null, 2), contentType: 'application/json' })
    }
  } finally {
    await app?.close()
    app = undefined
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

async function snapshot() {
  return page.evaluate(() => {
    const buffer = terminal.buffer.active
    const viewport = (document.querySelector<HTMLElement>('.xterm-scrollable-element') ?? document.querySelector<HTMLElement>('.xterm-viewport'))!
    return {
      base: buffer.baseY, y: buffer.viewportY, rows: terminal.rows, cols: terminal.cols,
      firstLine: buffer.getLine(buffer.viewportY)?.translateToString(true),
      top: viewport.scrollTop, height: viewport.scrollHeight, client: viewport.clientHeight,
      outer: [...document.querySelectorAll<HTMLElement>('.panes, .terminal-pane, .terminal-container, .xterm')]
        .map((el) => ({ name: el.className, top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight }))
    }
  })
}

async function writeLines(start: number, count: number): Promise<void> {
  await page.evaluate(async ({ start, count }) => {
    await writeOutput(Array.from({ length: count }, (_, i) => `line ${start + i} synthetic output\r\n`).join(''))
    await settle()
  }, { start, count })
}

async function wheelUntil(direction: -1 | 1, reached: (state: Awaited<ReturnType<typeof snapshot>>) => boolean): Promise<void> {
  await page.mouse.move(500, 350)
  for (let i = 0; i < 150; i++) {
    await page.mouse.wheel(0, direction * 120)
    await page.waitForTimeout(25)
    if (reached(await snapshot())) return
  }
}

async function scrollUp(): Promise<void> {
  const before = await snapshot()
  await wheelUntil(-1, (s) => s.y < before.y - 25)
  await expect.poll(async () => (await snapshot()).y).toBeLessThan(before.y - 25)
}

async function wheelToEnd(): Promise<void> {
  await wheelUntil(1, (s) => s.base === s.y)
}

async function dragScrollbarToEnd(): Promise<void> {
  await wheelUntil(-1, (s) => s.y === 0)
  await expect.poll(async () => (await snapshot()).y).toBe(0)
  const viewport = await page.locator('.xterm-viewport, .xterm-scrollable-element').last().boundingBox()
  expect(viewport).not.toBeNull()
  const slider = page.locator('.xterm .scrollbar.vertical .slider')
  const handle = await slider.count() ? await slider.boundingBox() : null
  const x = handle ? handle.x + handle.width / 2 : viewport!.x + viewport!.width - 5
  const y = handle ? handle.y + handle.height / 2 : viewport!.y + 8
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x, viewport!.y + viewport!.height - 2, { steps: 12 })
  await page.mouse.up()
}

for (const reading of [false, true]) {
  for (const input of ['wheel', 'scrollbar'] as const) {
    test(`hidden output preserves ${reading ? 'reading position' : 'auto-follow'} and reaches end by ${input}`, async () => {
      if (reading) {
        await scrollUp()
      }
      const before = await snapshot()
      await page.evaluate(() => { document.querySelector<HTMLElement>('.terminal-pane')!.style.display = 'none' })
      await writeLines(200, 100)
      const fits = await page.evaluate(() => window.safeFits)
      await page.evaluate(() => {
        document.querySelector<HTMLElement>('.terminal-pane')!.style.display = 'flex'
        requestAnimationFrame(() => terminal.focus())
      })
      await page.waitForFunction((previous) => window.safeFits > previous, fits)
      await page.evaluate(() => settle())
      if (reading) expect((await snapshot()).firstLine).toBe(before.firstLine)
      else expect((await snapshot()).y).toBe((await snapshot()).base)
      // No further output here: it could accidentally resynchronize the old viewport.
      if (input === 'wheel') { await scrollUp(); await wheelToEnd() }
      else await dragScrollbarToEnd()
      await expect.poll(async () => { const s = await snapshot(); return s.base - s.y }).toBe(0)
      expect((await snapshot()).outer.every((el) => el.top === 0)).toBe(true)
    })
  }
}

test('streaming follows at bottom, preserves reading position, and permits wheel scrolling', async () => {
  const before = await snapshot()
  await page.evaluate(() => {
    let n = 200
    window.stream = setInterval(() => terminal.write(`line ${n++} streaming\r\n`), 100)
  })
  await expect.poll(async () => (await snapshot()).base).toBeGreaterThan(before.base + 10)
  await expect.poll(async () => { const s = await snapshot(); return s.base - s.y }).toBe(0)
  await scrollUp()
  const reading = await snapshot()
  await expect.poll(async () => (await snapshot()).base).toBeGreaterThan(reading.base + 10)
  expect((await snapshot()).firstLine).toBe(reading.firstLine)
  await wheelToEnd()
  await expect.poll(async () => { const s = await snapshot(); return s.base - s.y }).toBe(0)
  await page.evaluate(async () => { clearInterval(stream); await writeOutput(''); await settle() })
})

test('resize, search and alternate-buffer return leave the normal buffer scrollable', async () => {
  await page.evaluate(() => { document.querySelector<HTMLElement>('.app-shell')!.style.height = '600px' })
  await expect.poll(async () => (await snapshot()).rows).toBeLessThan(40)
  await wheelToEnd()
  await expect.poll(async () => { const s = await snapshot(); return s.base - s.y }).toBe(0)
  expect(await page.evaluate(() => search.findNext('line 100 synthetic'))).toBe(true)
  await expect.poll(async () => (await snapshot()).y).toBeLessThan(150)
  await wheelToEnd()
  await expect.poll(async () => { const s = await snapshot(); return s.base - s.y }).toBe(0)
  const before = await snapshot()
  await page.evaluate(async () => {
    await writeOutput('\x1b[?1049hFull-screen test\x1b[?1049l')
    await settle()
  })
  expect((await snapshot()).base).toBe(before.base)
  await scrollUp()
  await wheelToEnd()
  await expect.poll(async () => { const s = await snapshot(); return s.base - s.y }).toBe(0)
})

test('clear-and-replay remains scrollable without filtering terminal commands', async () => {
  await scrollUp()
  await page.evaluate(async () => {
    const replay = Array.from({ length: 250 }, (_, i) => `replayed ${i}\r\n`).join('')
    terminal.write('\x1b[?2026h\x1b[2J\x1b[H\x1b[3J')
    for (let i = 0; i < replay.length; i += 4096) terminal.write(replay.slice(i, i + 4096))
    await writeOutput('\x1b[?2026l')
    await settle()
  })
  // CSI 3J deliberately replaces scrollback; no assertion that the old reading position survives.
  await wheelToEnd()
  await expect.poll(async () => { const s = await snapshot(); return s.base - s.y }).toBe(0)
  expect(await page.evaluate(() => terminal.buffer.active.getLine(249)?.translateToString(true))).toBe('replayed 249')
})
