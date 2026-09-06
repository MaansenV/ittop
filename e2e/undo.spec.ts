import { test, expect } from '@playwright/test'
import { launchApp, closeApp } from './helpers'

const WS = '367ad444-0e10-426f-a480-0168436a33bd'

// Undo for destructive deletes: trash bar appears, restore brings back the
// identical workspace (ids preserved). Never touches vaults or user data.
test.describe('delete undo', () => {
  test('workspace delete shows trash bar and restores on undo', async () => {
    const ctx = await launchApp({ workspaces: [{ id: WS, name: 'UndoMe' }] })
    try {
      await ctx.window
        .getByRole('button', { name: 'Not now' })
        .click({ timeout: 5_000 })
        .catch(() => undefined)
      const row = ctx.window.locator('.workspace-item', { hasText: 'UndoMe' }).first()
      await expect(row).toBeVisible({ timeout: 15_000 })
      // Delete lives in the workspaces tree (activity rows have no actions).
      await ctx.window.getByRole('button', { name: 'Workspaces', exact: true }).click()
      await expect(ctx.window.locator('.workspace-item', { hasText: 'UndoMe' }).first()).toBeVisible()
      await row.hover()
      await ctx.window.getByRole('button', { name: 'Delete workspace' }).click()
      await ctx.window.getByRole('button', { name: 'Delete', exact: true }).click()
      // Gone from the list, trash bar offers undo.
      await expect(ctx.window.locator('.workspace-item', { hasText: 'UndoMe' })).toHaveCount(0)
      const bar = ctx.window.locator('.trashbar')
      await expect(bar).toBeVisible()
      await expect(bar).toContainText('UndoMe')
      // Undo restores the identical workspace.
      await bar.getByRole('button', { name: 'Undo', exact: true }).click()
      await expect(ctx.window.locator('.workspace-item', { hasText: 'UndoMe' })).toHaveCount(1)
      await expect(ctx.window.locator('.trashbar')).toHaveCount(0)
    } finally {
      await closeApp(ctx)
    }
  })
})
