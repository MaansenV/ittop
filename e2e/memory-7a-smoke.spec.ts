import { test, expect } from '@playwright/test'
import { launchApp, closeApp } from './helpers'

// Redesign smoke (isolated copies of the migrated UUID DBs, never live):
// browse-first list, workspace switcher, page filter, readable cards,
// backend search honoring scope, detail, review, ops.
const WS_KINE = 'f6e57579-9877-458a-8d70-238b681b011b'
const WS_ITT = '367ad444-0e10-426f-a480-0168436a33bd'

test.describe('memory screen redesign smoke', () => {
  test('browse, switch scope, filter, cards, search, detail, review, ops', async () => {
    const ctx = await launchApp({
      memoryVaultEnabled: true,
      workspaces: [
        { id: WS_ITT, name: 'ittop' },
        { id: WS_KINE, name: 'KinemationTest' },
      ],
      vaultSeed: [
        { id: WS_ITT, name: 'ittop' },
        { id: WS_KINE, name: 'KinemationTest' },
      ],
    })
    try {
      await ctx.window
        .getByRole('button', { name: 'Not now' })
        .click({ timeout: 5_000 })
        .catch(() => undefined)
      const button = ctx.window.getByRole('button', { name: /Memory/ })
      await expect(button).toBeVisible({ timeout: 15_000 })
      await button.click()
      await ctx.window.locator('.memory-screen').waitFor({ state: 'attached', timeout: 15_000 })

      // Browse-first: ittop's 4 entries load without any search.
      await expect(ctx.window.locator('.memory-row').first()).toBeVisible({ timeout: 15_000 })
      await expect(ctx.window.locator('.memory-row')).toHaveCount(4)
      await expect(ctx.window.locator('.memory-screen')).toContainText('Browse · 4 entries')

      // Switcher lists workspace names; switching loads KinemationTest's 7.
      const scope = ctx.window.locator('select[aria-label="Memory workspace"]')
      await expect(scope.locator('option')).toHaveCount(3) // 2 workspaces + Global
      await scope.selectOption(WS_KINE)
      await expect(ctx.window.locator('.memory-row')).toHaveCount(7)
      await expect(ctx.window.locator('.memory-screen')).toContainText('Browse · 7 entries')

      // Readable card: humanized title + badges, no raw key/category prefix.
      const first = ctx.window.locator('.memory-row').first()
      await expect(first.locator('.memory-key')).not.toContainText('decision /')
      await expect(first).toContainText('KinemationTest')

      // Page filter narrows the loaded page (labelled Filter, no backend):
      // fewer rows, and every visible row mentions the filter text.
      await ctx.window.locator('input[aria-label="Filter loaded entries"]').fill('recast')
      const filtered = await ctx.window.locator('.memory-row').count()
      expect(filtered).toBeGreaterThan(0)
      expect(filtered).toBeLessThan(7)
      for (let i = 0; i < filtered; i += 1) {
        await expect(ctx.window.locator('.memory-row').nth(i)).toContainText(/recast/i)
      }
      await ctx.window.locator('input[aria-label="Filter loaded entries"]').fill('')
      await expect(ctx.window.locator('.memory-row')).toHaveCount(7)

      // Detail: title, content paragraph, usage line, collapsibles.
      await ctx.window.locator('.memory-row').first().click()
      const detail = ctx.window.locator('.memory-detail')
      await expect(detail.locator('p, li').first()).not.toBeEmpty()
      await expect(detail.locator('.memory-meta-line')).toContainText('Confidence')
      await expect(detail.locator('summary', { hasText: 'Developer details' })).toBeVisible()

      // Backend search honors the selected scope (kine: navmesh hits).
      await ctx.window.locator('input[aria-label="Search the vault"]').fill('navmesh')
      await ctx.window
        .locator('.memory-list .memory-searchbar button', { hasText: 'Search' })
        .click()
      await expect(ctx.window.locator('.memory-screen')).toContainText('Search results')
      expect(await ctx.window.locator('.memory-row').count()).toBeGreaterThan(0)

      // Review tab: empty isolated queue. Ops tab: status renders.
      await ctx.window.getByRole('button', { name: /^Review/ }).click()
      await expect(ctx.window.locator('.memory-list')).toContainText('Queue empty.')
      await ctx.window.getByRole('button', { name: 'Ops' }).click()
      await expect(ctx.window.locator('.memory-ops')).toContainText('Status')

      await ctx.window.locator('.memory-close').click()
      await expect(ctx.window.locator('.memory-screen')).toHaveCount(0)
    } finally {
      await closeApp(ctx)
    }
  })

  test('global separation, keyboard close, narrow layout', async () => {
    const ctx = await launchApp({
      memoryVaultEnabled: true,
      workspaces: [
        { id: WS_ITT, name: 'ittop' },
        { id: WS_KINE, name: 'KinemationTest' },
      ],
      vaultSeed: [
        { id: WS_ITT, name: 'ittop' },
        { id: WS_KINE, name: 'KinemationTest' },
      ],
    })
    try {
      await ctx.window
        .getByRole('button', { name: 'Not now' })
        .click({ timeout: 5_000 })
        .catch(() => undefined)
      // Narrow window: single-column layout, no horizontal overflow.
      await ctx.window.setViewportSize({ width: 600, height: 800 })
      await ctx.window.getByRole('button', { name: /Memory/ }).click()
      await ctx.window.locator('.memory-screen').waitFor({ state: 'attached', timeout: 15_000 })
      await expect(ctx.window.locator('.memory-row').first()).toBeVisible({ timeout: 15_000 })
      const overflow = await ctx.window.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(overflow).toBeLessThanOrEqual(1)
      await ctx.window.locator('.memory-screen').screenshot({ path: 'test-results/memory-narrow.png' })

      // Global is a separate store: workspace entries must not leak in.
      await ctx.window.locator('select[aria-label="Memory workspace"]').selectOption('global')
      await expect(ctx.window.locator('.memory-screen')).toContainText(/No entries in this store|Browse · 0 entries/)
      await expect(ctx.window.locator('.memory-screen')).not.toContainText('release-workflow')
      await ctx.window.locator('.memory-screen').screenshot({ path: 'test-results/memory-global.png' })

      // Escape closes screen-wide (not only from inputs).
      await ctx.window.locator('.memory-screen').click({ position: { x: 5, y: 5 } })
      await ctx.window.keyboard.press('Escape')
      await expect(ctx.window.locator('.memory-screen')).toHaveCount(0)
    } finally {
      await closeApp(ctx)
    }
  })

  test('open screen follows an app workspace switch', async () => {
    const ctx = await launchApp({
      memoryVaultEnabled: true,
      workspaces: [
        { id: WS_ITT, name: 'ittop' },
        { id: WS_KINE, name: 'KinemationTest' },
      ],
      vaultSeed: [
        { id: WS_ITT, name: 'ittop' },
        { id: WS_KINE, name: 'KinemationTest' },
      ],
    })
    try {
      await ctx.window
        .getByRole('button', { name: 'Not now' })
        .click({ timeout: 5_000 })
        .catch(() => undefined)
      await ctx.window.getByRole('button', { name: /Memory/ }).click()
      await ctx.window.locator('.memory-screen').waitFor({ state: 'attached', timeout: 15_000 })
      await expect(ctx.window.locator('.memory-row')).toHaveCount(4)
      // Ctrl+2 switches the APP workspace while the screen is open: the
      // screen follows (scope, list and counts reload, no stale rows).
      await ctx.window.keyboard.press('Control+2')
      await expect(ctx.window.locator('.memory-row')).toHaveCount(7)
      await expect(ctx.window.locator('select[aria-label="Memory workspace"]')).toHaveValue(WS_KINE)
      await ctx.window.locator('.memory-close').click()
      await expect(ctx.window.locator('.memory-screen')).toHaveCount(0)
    } finally {
      await closeApp(ctx)
    }
  })
})
