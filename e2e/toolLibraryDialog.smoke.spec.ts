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

function openToolLibraryDialog(page: ReturnType<typeof test['info']> extends never ? never : any) {
  // placeholder — see helpers below
}

test.describe('Tool library import dialog smoke', () => {
  test('opens the dialog when trigger clicked', async ({ app }) => {
    // Click the Tools tab to show the tool panel
    await app.page.getByRole('tab', { name: 'Tools' }).click()

    // Click the import trigger
    const trigger = app.page.getByRole('button', { name: /Import from library/ })
    await expect(trigger).toBeVisible()
    await trigger.click()

    // Dialog should be visible with the title
    const dialog = app.page.getByRole('dialog', { name: 'Import tools from library' })
    await expect(dialog).toBeVisible()

    // Close (X) button should be visible
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

    // Get initial tool count
    const initialToolCount = await app.page.locator('.cam-tool-tree .tree-row--feature').count()

    // Close via the X button
    await dialog.locator('.dialog-close').click()
    await expect(dialog).not.toBeVisible()

    // Tool count should be unchanged
    const finalToolCount = await app.page.locator('.cam-tool-tree .tree-row--feature').count()
    expect(finalToolCount).toBe(initialToolCount)
  })

  test('closes via Escape key', async ({ app }) => {
    await app.page.getByRole('tab', { name: 'Tools' }).click()
    await app.page.getByRole('button', { name: /Import from library/ }).click()

    const dialog = app.page.getByRole('dialog', { name: 'Import tools from library' })
    await expect(dialog).toBeVisible()

    // Press Escape
    await app.page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
  })

  test('closes via backdrop click', async ({ app }) => {
    await app.page.getByRole('tab', { name: 'Tools' }).click()
    await app.page.getByRole('button', { name: /Import from library/ }).click()

    const dialog = app.page.getByRole('dialog', { name: 'Import tools from library' })
    await expect(dialog).toBeVisible()

    // Click the backdrop (outside dialog)
    await app.page.locator('.dialog-backdrop').click({ position: { x: 2, y: 2 } })
    await expect(dialog).not.toBeVisible()
  })

  test('search filters library tools', async ({ app }) => {
    await app.page.getByRole('tab', { name: 'Tools' }).click()
    await app.page.getByRole('button', { name: /Import from library/ }).click()

    const dialog = app.page.getByRole('dialog', { name: 'Import tools from library' })
    await expect(dialog).toBeVisible()

    // Type in the search
    const searchInput = dialog.getByRole('searchbox')
    await searchInput.fill('nonexistent-tool-xyz')

    // Should show no-match message
    await expect(dialog.getByText(/No library tools match the current filters/)).toBeVisible()

    // Clear filters button should appear
    const clearButton = dialog.getByRole('button', { name: 'Clear filters' })
    await expect(clearButton).toBeVisible()

    // Clear and tools should re-appear
    await clearButton.click()
    await expect(dialog.locator('.tl-row')).not.toHaveCount(0)
  })

  test('selects and imports a new tool', async ({ app }) => {
    await app.page.getByRole('tab', { name: 'Tools' }).click()

    // If there's already a default tool, note its ID
    const initialCount = await app.page.locator('.cam-tool-tree .tree-row--feature').count()

    await app.page.getByRole('button', { name: /Import from library/ }).click()
    const dialog = app.page.getByRole('dialog', { name: 'Import tools from library' })
    await expect(dialog).toBeVisible()

    // Click the first non-imported row (skip already-imported ones)
    const importableRows = dialog.locator('.tl-row:not(.tl-row--imported)')
    const firstRowCount = await importableRows.count()
    if (firstRowCount === 0) {
      // All tools are already imported — just verify the state and close
      await expect(dialog.getByText(/All matching library tools are already in the project/)).toBeVisible()
      await app.page.keyboard.press('Escape')
      return
    }

    // Select the first importable row
    await importableRows.first().click()

    // Footer should show "1 tool selected" and "Import tool"
    await expect(dialog.locator('.tl-footer-count')).toContainText('1 tool selected')
    await expect(dialog.getByRole('button', { name: 'Import tool' })).toBeEnabled()

    // Click import
    await dialog.getByRole('button', { name: 'Import tool' }).click()

    // Dialog should close
    await expect(dialog).not.toBeVisible()

    // Tool count should increase by 1
    const finalCount = await app.page.locator('.cam-tool-tree .tree-row--feature').count()
    expect(finalCount).toBe(initialCount + 1)
  })

  test('disables already-imported tools', async ({ app }) => {
    await app.page.getByRole('tab', { name: 'Tools' }).click()

    // First import a tool
    await app.page.getByRole('button', { name: /Import from library/ }).click()
    let dialog = app.page.getByRole('dialog', { name: 'Import tools from library' })
    const firstRow = dialog.locator('.tl-row:not(.tl-row--imported)').first()
    await firstRow.click()
    await dialog.getByRole('button', { name: 'Import tool' }).click()
    await expect(dialog).not.toBeVisible()

    // Re-open the dialog
    await app.page.getByRole('button', { name: /Import from library/ }).click()
    dialog = app.page.getByRole('dialog', { name: 'Import tools from library' })

    // The row we imported should now show "In project"
    await expect(dialog.locator('.tl-row--imported')).not.toHaveCount(0)
    await expect(dialog.locator('.tl-row--imported .tl-row__status').first()).toContainText(/In project/)
  })

  test('import button is disabled with no new tools selected', async ({ app }) => {
    await app.page.getByRole('tab', { name: 'Tools' }).click()
    await app.page.getByRole('button', { name: /Import from library/ }).click()

    const dialog = app.page.getByRole('dialog', { name: 'Import tools from library' })
    await expect(dialog).toBeVisible()

    // With nothing selected, import button should be disabled
    const importButton = dialog.locator('.dialog-footer .btn-primary')
    await expect(importButton).toBeDisabled()
  })

  test('restores focus to trigger on close', async ({ app }) => {
    await app.page.getByRole('tab', { name: 'Tools' }).click()

    const trigger = app.page.getByRole('button', { name: /Import from library/ })
    await trigger.click()

    await app.page.keyboard.press('Escape')

    // After close, focus should be back on the trigger
    await expect(trigger).toBeFocused()
  })
})
