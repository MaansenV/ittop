import { test, expect } from '@playwright/test'
import { launchApp, closeApp } from './helpers'

// Isolated UI smoke for the Phase-4 Memory-Screen: real app, isolated
// temp userData, no mocks. Asserts the button, the three tabs and the
// empty-queue state — never any vault write.
test.describe('memory screen', () => {
  test('button opens the screen with browse, review and ops tabs', async () => {
    // Cold Electron launches in this sandbox are timing-noisy (see
    // playwright.config.ts); the flow itself is fast once attached.
    test.slow()
    const ctx = await launchApp({ memoryVaultEnabled: true })
    try {
      const button = ctx.window.getByRole('button', { name: /Memory/ })
      await expect(button).toBeVisible({ timeout: 15_000 })
      await button.click()
      await ctx.window.locator('.memory-screen').waitFor({ state: 'attached', timeout: 15_000 })

      // Browse tab: no workspace open, so the backend input explains itself
      // (the page filter stays usable on whatever is loaded).
      await expect(ctx.window.locator('input[aria-label="Search the vault"]')).toBeDisabled()

      // Review tab: empty isolated queue.
      await ctx.window.getByRole('button', { name: /^Review/ }).click()
      await expect(ctx.window.locator('.memory-list')).toContainText('Queue empty.')

      // Ops tab: status renders (ready only once the vault child is up).
      await ctx.window.getByRole('button', { name: 'Ops' }).click()
      await expect(ctx.window.locator('.memory-ops')).toContainText('Status')

      await ctx.window.locator('.memory-close').click()
      await expect(ctx.window.locator('.memory-screen')).toHaveCount(0)
    } finally {
      await closeApp(ctx)
    }
  })

  test('no memory button while the vaults are disabled', async () => {
    test.slow()
    const ctx = await launchApp()
    try {
      await expect(ctx.window.getByRole('button', { name: /Memory/ })).toHaveCount(0)
    } finally {
      await closeApp(ctx)
    }
  })
})
