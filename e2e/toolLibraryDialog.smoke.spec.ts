/**
 * Copyright 2026 Franja (Frank) Povazanj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { test, expect } from './fixtures'

test.describe('Tool library import dialog smoke', () => {
  test('opens the dialog when trigger clicked', async ({ app }) => {
    await app.page.getByRole('tab', { name: 'Tools' }).click()
    const trigger = app.page.getByRole('button', { name: /Import from library/ })
    await expect(trigger).toBeVisible()
    await trigger.click()

    const dialog = app.page.getByRole('dialog', { name: 'Import tools from library' })
    await expect(dialog).toBeVisible()

    // Close button should be visible
    const closeXButton = dialog.locator('.dialog-close')
    await expect(closeXButton).toBeVisible()

    // Search input should be visible and focused
    const searchInput = dialog.getByRole('searchbox')
    await expect(searchInput).toBeVisible()
    await expect(searchInput).toBeFocused()
  })

  test('closes via close button without mutation', async ({ app }) => {
    await app.page.getByRole('tab', { name: 'Tools' }).click()
    await app.page.getByRole('button', { name: /Import from library/ }).click()

    const dialog = app.page.getByRole('dialog', { name: 'Import tools from library' })
    await expect(dialog).toBeVisible()

    const initialToolCount = await app.page.locator('.cam-tool-tree .tree-row--feature').count()

    await dialog.locator('.dialog-close').click()
    await expect(dialog).not.toBeVisible()

    const finalToolCount = await app.page.locator('.cam-tool-tree .tree-row--feature').count()
    expect(finalToolCount).toBe(initialToolCount)
  })

  test('closes via Escape key', async ({ app }) => {
    await app.page.getByRole('tab', { name: 'Tools' }).click()
    await app.page.getByRole('button', { name: /Import from library/ }).click()

    const dialog = app.page.getByRole('dialog', { name: 'Import tools from library' })
    await expect(dialog).toBeVisible()

    await app.page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
  })

  test('closes via backdrop click', async ({ app }) => {
    await app.page.getByRole('tab', { name: 'Tools' }).click()
    await app.page.getByRole('button', { name: /Import from library/ }).click()

    const dialog = app.page.getByRole('dialog', { name: 'Import tools from library' })
    await expect(dialog).toBeVisible()

    await app.page.locator('.dialog-backdrop').click({ position: { x: 2, y: 2 } })
    await expect(dialog).not.toBeVisible()
  })

  test('search filters library tools', async ({ app }) => {
    await app.page.getByRole('tab', { name: 'Tools' }).click()
    await app.page.getByRole('button', { name: /Import from library/ }).click()

    const dialog = app.page.getByRole('dialog', { name: 'Import tools from library' })
    await expect(dialog).toBeVisible()

    const searchInput = dialog.getByRole('searchbox')
    await searchInput.fill('nonexistent-tool-xyz')

    await expect(dialog.getByText(/No library tools match the current filters/)).toBeVisible()

    const clearButton = dialog.getByRole('button', { name: 'Clear filters' })
    await expect(clearButton).toBeVisible()

    await clearButton.click()
    await expect(dialog.locator('.tl-row')).not.toHaveCount(0)
  })

  test('selects and imports a new tool', async ({ app }) => {
    await app.page.getByRole('tab', { name: 'Tools' }).click()

    const initialCount = await app.page.locator('.cam-tool-tree .tree-row--feature').count()

    await app.page.getByRole('button', { name: /Import from library/ }).click()
    const dialog = app.page.getByRole('dialog', { name: 'Import tools from library' })
    await expect(dialog).toBeVisible()

    const importableCheckboxes = dialog.locator('.tl-row:not(.tl-row--imported) .tl-row__check')
    const firstCheckboxCount = await importableCheckboxes.count()
    if (firstCheckboxCount === 0) {
      // All tools may already be imported or no rows are visible.
      // Verify the dialog shows a valid state and close cleanly.
      const hasAllImported = await dialog.getByText(/All matching library tools are already in the project/).isVisible()
      const hasStatus = await dialog.locator('.tl-status').first().isVisible()
      expect(hasAllImported || hasStatus, 'expected all-imported message or status when no importable rows exist').toBe(true)
      await app.page.keyboard.press('Escape')
      return
    }

    // Click the first importable row's label area to select
    await importableCheckboxes.first().check()

    // Footer should show selection count and enabled import button
    await expect(dialog.locator('.tl-footer-count')).toContainText('1 tool selected')
    await expect(dialog.getByRole('button', { name: 'Import tool' })).toBeEnabled()

    await dialog.getByRole('button', { name: 'Import tool' }).click()

    // Dialog should close on success
    await expect(dialog).not.toBeVisible()

    const finalCount = await app.page.locator('.cam-tool-tree .tree-row--feature').count()
    expect(finalCount).toBe(initialCount + 1)
  })

  test('disables already-imported tools', async ({ app }) => {
    await app.page.getByRole('tab', { name: 'Tools' }).click()

    // First import a tool
    await app.page.getByRole('button', { name: /Import from library/ }).click()
    let dialog = app.page.getByRole('dialog', { name: 'Import tools from library' })
    const firstCheckbox = dialog.locator('.tl-row:not(.tl-row--imported) .tl-row__check').first()
    await firstCheckbox.check()
    await dialog.getByRole('button', { name: 'Import tool' }).click()
    await expect(dialog).not.toBeVisible()

    // Re-open the dialog
    await app.page.getByRole('button', { name: /Import from library/ }).click()
    dialog = app.page.getByRole('dialog', { name: 'Import tools from library' })

    // The imported row should now show "In project" with disabled checkbox
    await expect(dialog.locator('.tl-row--imported')).not.toHaveCount(0)
    await expect(dialog.locator('.tl-row--imported .tl-row__status').first()).toContainText(/In project/)
    await expect(dialog.locator('.tl-row--imported .tl-row__check').first()).toBeDisabled()
  })

  test('import button is disabled with no new tools selected', async ({ app }) => {
    await app.page.getByRole('tab', { name: 'Tools' }).click()
    await app.page.getByRole('button', { name: /Import from library/ }).click()

    const dialog = app.page.getByRole('dialog', { name: 'Import tools from library' })
    await expect(dialog).toBeVisible()

    const importButton = dialog.locator('.dialog-footer .btn-primary')
    await expect(importButton).toBeDisabled()
  })

  test('restores focus to trigger on close', async ({ app }) => {
    await app.page.getByRole('tab', { name: 'Tools' }).click()

    const trigger = app.page.getByRole('button', { name: /Import from library/ })
    await trigger.click()

    await app.page.keyboard.press('Escape')

    await expect(trigger).toBeFocused()
  })

  test('selected tool remains counted and importable after search hides it', async ({ app }) => {
    await app.page.getByRole('tab', { name: 'Tools' }).click()
    await app.page.getByRole('button', { name: /Import from library/ }).click()

    const dialog = app.page.getByRole('dialog', { name: 'Import tools from library' })
    await expect(dialog).toBeVisible()

    // Note the name of the first importable entry
    const firstRow = dialog.locator('.tl-row:not(.tl-row--imported)').first()
    const firstName = await firstRow.locator('.tl-row__name').textContent()

    // Select it
    await firstRow.locator('.tl-row__check').check()
    await expect(dialog.locator('.tl-footer-count')).toContainText('1 tool selected')

    // Search for something that hides the selected tool
    await dialog.getByRole('searchbox').fill('nonexistent-tool-xyz')

    // Footer count must still show 1 tool selected (selection survives filter)
    await expect(dialog.locator('.tl-footer-count')).toContainText('1 tool selected')

    // Clear search
    await dialog.getByRole('button', { name: 'Clear filters' }).click()

    // Selected tool reappears and is still selected
    const restoredRow = dialog.locator('.tl-row--selected').first()
    await expect(restoredRow.locator('.tl-row__name')).toContainText(firstName ?? '')

    // Import button should still be enabled with correct count
    await expect(dialog.locator('.tl-footer-count')).toContainText('1 tool selected')
    await expect(dialog.getByRole('button', { name: 'Import tool' })).toBeEnabled()
  })

  test('Tab and Shift+Tab cannot escape the dialog focus trap', async ({ app }) => {
    await app.page.getByRole('tab', { name: 'Tools' }).click()
    await app.page.getByRole('button', { name: /Import from library/ }).click()

    const dialog = app.page.getByRole('dialog', { name: 'Import tools from library' })
    await expect(dialog).toBeVisible()

    // Start in the search input
    const searchInput = dialog.getByRole('searchbox')
    await expect(searchInput).toBeFocused()

    // Tab forward until we've cycled several times; focus must stay in the dialog
    for (let i = 0; i < 20; i++) {
      await app.page.keyboard.press('Tab')
      // After each Tab, the activeElement must be within the dialog
      const isInDialog = await dialog.evaluate((el, doc) => {
        return el.contains(doc.activeElement)
      }, await app.page.evaluateHandle(() => document))
      expect(isInDialog, `Tab ${i + 1}: focus escaped the dialog`).toBe(true)
    }

    // Shift+Tab backward several times; focus must stay in the dialog
    for (let i = 0; i < 20; i++) {
      await app.page.keyboard.press('Shift+Tab')
      const isInDialog = await dialog.evaluate((el, doc) => {
        return el.contains(doc.activeElement)
      }, await app.page.evaluateHandle(() => document))
      expect(isInDialog, `Shift+Tab ${i + 1}: focus escaped the dialog`).toBe(true)
    }
  })

  test('tablet landscape viewport keeps footer visible with scrolling results', async ({ app }) => {
    // Set a supported tablet landscape viewport (1024×768)
    await app.page.setViewportSize({ width: 1024, height: 768 })

    await app.page.getByRole('tab', { name: 'Tools' }).click()
    await app.page.getByRole('button', { name: /Import from library/ }).click()

    const dialog = app.page.getByRole('dialog', { name: 'Import tools from library' })
    await expect(dialog).toBeVisible()

    // Footer must be visible (not scrolled off-screen)
    const footer = dialog.locator('.dialog-footer')
    await expect(footer).toBeVisible()
    // Footer must intersect the viewport (not be clipped)
    await expect(footer).toBeInViewport()

    // Results region must own scrolling
    const results = dialog.locator('.tl-results')
    await expect(results).toBeVisible()

    // The cancel and import buttons must be visible
    const cancelButton = dialog.locator('.dialog-footer .btn-secondary')
    await expect(cancelButton).toBeVisible()
    await expect(cancelButton).toBeInViewport()

    const importButton = dialog.locator('.dialog-footer .btn-primary')
    await expect(importButton).toBeVisible()
    await expect(importButton).toBeInViewport()
  })
})
