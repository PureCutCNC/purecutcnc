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

    // Wait for rows to render (either imported or importable).
    await expect(dialog.locator('.tl-row').first()).toBeVisible()

    const importableCheckboxes = dialog.locator('.tl-row:not(.tl-row--imported) .tl-row__check')
    const firstCheckboxCount = await importableCheckboxes.count()
    if (firstCheckboxCount === 0) {
      // Every visible row is already imported — the all-imported banner must be
      // visible AND the imported rows must still be rendered (not replaced).
      await expect(dialog.locator('.tl-banner')).toBeVisible()
      await expect(dialog.locator('.tl-row--imported')).not.toHaveCount(0)
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

  test('imported rows render alongside all-imported banner', async ({ app }) => {
    // Regression: when every filtered entry is already imported the dialog
    // must show a compact banner AND still render each imported row with its
    // disabled checkbox and In-project label — not replace the rows.
    await app.page.getByRole('tab', { name: 'Tools' }).click()
    await app.page.getByRole('button', { name: /Import from library/ }).click()

    const dialog = app.page.getByRole('dialog', { name: 'Import tools from library' })
    await expect(dialog).toBeVisible()

    // Wait for rows to render before counting.
    await expect(dialog.locator('.tl-row').first()).toBeVisible()

    // Import every visible importable tool so the next open sees all-imported.
    // A project that already has every tool imported skips this block naturally.
    const importableChecks = dialog.locator('.tl-row:not(.tl-row--imported) .tl-row__check')
    const importCount = await importableChecks.count()
    if (importCount > 0) {
      for (let i = 0; i < importCount; i++) {
        await importableChecks.nth(i).check()
      }
      await dialog.locator('.dialog-footer .btn-primary').click()
      await expect(dialog).not.toBeVisible()

      // Re-open: now every row visible under the current filter should be imported.
      await app.page.getByRole('button', { name: /Import from library/ }).click()
      // Wait for the re-opened dialog's rows to fully render.
      await expect(
        app.page.getByRole('dialog', { name: 'Import tools from library' }).locator('.tl-row').first(),
      ).toBeVisible()
    }

    // Re-query the dialog — this is either the re-opened dialog (import path)
    // or the still-open initial dialog (already-all-imported path).
    const currentDialog = app.page.getByRole('dialog', {
      name: 'Import tools from library',
    })

    // 1. Every visible row must be imported — zero non-imported rows remain.
    await expect(currentDialog.locator('.tl-row:not(.tl-row--imported)')).toHaveCount(0)

    // 2. The compact all-imported banner must be visible with its localized copy.
    await expect(currentDialog.locator('.tl-banner')).toBeVisible()
    await expect(currentDialog.locator('.tl-banner')).toContainText(/already in the project/)

    // 3. Imported rows must remain rendered with a disabled checkbox and
    //    an "In project" status label — the banner augments, not replaces them.
    const importedRows = currentDialog.locator('.tl-row--imported')
    await expect(importedRows.first()).toBeVisible()
    await expect(importedRows.first().locator('.tl-row__check')).toBeDisabled()
    await expect(importedRows.first().locator('.tl-row__status')).toContainText(/In project/)
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

  test('shows loading state while tool-library.json response is pending', async ({ app }) => {
    // Gate the bundled library response behind a promise so we can observe
    // the loading state before any rows appear.
    let releaseResponse: () => void
    const gate = new Promise<void>((resolve) => {
      releaseResponse = resolve
    })

    await app.page.route('**/tool-library.json', async (route) => {
      await gate
      await route.continue()
    })

    try {
      await app.page.getByRole('tab', { name: 'Tools' }).click()
      await app.page.getByRole('button', { name: /Import from library/ }).click()

      const dialog = app.page.getByRole('dialog', { name: 'Import tools from library' })
      await expect(dialog).toBeVisible()

      // The loading status must be visible while the response is held.
      await expect(dialog.locator('.tl-status')).toBeVisible()
      await expect(dialog.locator('.tl-spinner')).toBeVisible()
      await expect(dialog.getByText(/Loading tool library/)).toBeVisible()

      // Rows must NOT be present yet.
      await expect(dialog.locator('.tl-row')).toHaveCount(0)

      // Release the response.
      releaseResponse!()

      // Rows must appear after the response resolves.
      await expect(dialog.locator('.tl-row')).not.toHaveCount(0)
    } finally {
      // Always unroute so subsequent tests are not affected.
      await app.page.unroute('**/tool-library.json')
      // If the test failed before releasing, release now so the route
      // handler can exit and the page can continue.
      releaseResponse!()
    }
  })

  test('filter bar and results span the full dialog width', async ({ app }) => {
    await app.page.getByRole('tab', { name: 'Tools' }).click()
    await app.page.getByRole('button', { name: /Import from library/ }).click()

    const dialog = app.page.getByRole('dialog', { name: 'Import tools from library' })
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('.tl-row').first()).toBeVisible()

    // The shared `.dialog-body` is a two-column (320px 1fr) form grid. The
    // tool-library body must override that to a single column, or the filter
    // bar is stranded in a dead 320px column beside a half-width result list.
    const layout = await app.page.evaluate(() => {
      const width = (selector: string) =>
        Math.round(document.querySelector(selector)!.getBoundingClientRect().width)
      return {
        body: width('.dialog-body--tool-library'),
        filters: width('.tl-filters'),
        results: width('.tl-results'),
      }
    })

    expect(layout.filters).toBe(layout.body)
    expect(layout.results).toBe(layout.body)
  })

  test('Escape closes an open filter dropdown before the dialog', async ({ app }) => {
    await app.page.getByRole('tab', { name: 'Tools' }).click()
    await app.page.getByRole('button', { name: /Import from library/ }).click()

    const dialog = app.page.getByRole('dialog', { name: 'Import tools from library' })
    await expect(dialog).toBeVisible()

    const typeSelect = dialog.locator('.tl-filter-selects .ui-select').first()
    await typeSelect.locator('.ui-select__trigger').click()
    const dropdown = typeSelect.locator('.ui-select__dropdown')
    await expect(dropdown).toBeVisible()

    // The dropdown must not be clipped by the dialog body's overflow.
    const clipped = await app.page.evaluate(() => {
      const dd = document.querySelector('.dialog--tool-library .ui-select__dropdown')!
      const body = document.querySelector('.dialog-body--tool-library')!
      return dd.getBoundingClientRect().bottom > body.getBoundingClientRect().bottom + 1
        && getComputedStyle(body).overflow !== 'visible'
    })
    expect(clipped).toBe(false)

    // First Escape dismisses the dropdown only.
    await app.page.keyboard.press('Escape')
    await expect(dropdown).toHaveCount(0)
    await expect(dialog).toBeVisible()

    // Second Escape closes the dialog.
    await app.page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
  })

  test('result list scrolls when the library is larger than the dialog', async ({ app }) => {
    // Serve a library big enough to overflow any supported dialog height so
    // the assertion cannot pass by accident on a short bundled list.
    await app.page.route('**/tool-library.json', async (route) => {
      const tools = Array.from({ length: 60 }, (_, i) => ({
        key: `scroll_probe_${i}`,
        name: `Scroll Probe ${i}`,
        units: 'inch',
        type: 'flat_endmill',
        diameter: 0.1 + i * 0.01,
        flutes: 2,
        material: 'carbide',
        defaultRpm: 18000,
        defaultFeed: 30,
        defaultPlungeFeed: 12,
        defaultStepdown: 0.1,
        defaultStepover: 0.4,
        maxCutDepth: 1,
      }))
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ name: 'Scroll Probe', version: '1', tools }),
      })
    })

    try {
      await app.page.getByRole('tab', { name: 'Tools' }).click()
      await app.page.getByRole('button', { name: /Import from library/ }).click()

      const dialog = app.page.getByRole('dialog', { name: 'Import tools from library' })
      await expect(dialog).toBeVisible()
      await expect(dialog.locator('.tl-row')).toHaveCount(60)

      const results = dialog.locator('.tl-results')
      const scroll = await results.evaluate((el) => {
        el.scrollTop = el.scrollHeight
        return {
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          scrollTop: el.scrollTop,
        }
      })

      // The list overflows and the results region — not the page — absorbs it.
      expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight)
      expect(scroll.scrollTop).toBeGreaterThan(0)

      // The last row is reachable, and the footer stays put while scrolling.
      await expect(dialog.locator('.tl-row').last()).toBeInViewport()
      await expect(dialog.locator('.dialog-footer')).toBeInViewport()
      await expect(dialog.locator('.tl-filters')).toBeInViewport()
    } finally {
      await app.page.unroute('**/tool-library.json')
    }
  })
})

test.describe('Tool library import dialog — tablet', () => {
  test.use({
    viewport: { width: 1024, height: 768 },
    hasTouch: true,
  })

  test('enters tablet shell mode with touch targets and scrolling results', async ({ app }) => {
    // The app shell must reflect tablet mode (width >= 900 + pointer: coarse).
    const shell = app.page.locator('.app-shell')
    await expect(shell).toHaveAttribute('data-shell-mode', 'tablet')

    // On tablet the right panel is a hidden slide-in drawer — open it first.
    await app.page.getByRole('button', { name: 'Open operations panel' }).click()
    await app.page.getByRole('tab', { name: 'Tools' }).click()
    await app.page.getByRole('button', { name: /Import from library/ }).click()

    const dialog = app.page.getByRole('dialog', { name: 'Import tools from library' })
    await expect(dialog).toBeVisible()

    // Footer must be visible and in the viewport.
    const footer = dialog.locator('.dialog-footer')
    await expect(footer).toBeVisible()
    await expect(footer).toBeInViewport()

    // The results region must be configured as the vertical overflow owner.
    const results = dialog.locator('.tl-results')
    const overflowY = await results.evaluate((el) => window.getComputedStyle(el).overflowY)
    expect(['auto', 'scroll']).toContain(overflowY)

    // #527: rows render after the dialog opens, and under parallel workers
    // the measurements below raced that render — both heights read 140, the
    // empty list's min-height — so the scroll assertion silently tested
    // nothing. Wait until the populated list actually overflows before
    // measuring it; a timeout here is the regression this test guards
    // against, not a product bug it should paper over.
    await expect.poll(
      () => results.evaluate((el) => el.scrollHeight > el.clientHeight),
      { message: 'results list should overflow its container once rows render' },
    ).toBe(true)

    // The results region must be the element that actually overflows —
    // never the dialog body, the form, or the page. `scrollHeight >=
    // clientHeight` is true of every element and would pass even if the
    // rows were silently clipped, so assert the region is strictly taller
    // than its box and that scrolling it moves.
    const scrollHeight = await results.evaluate((el) => el.scrollHeight)
    const clientHeight = await results.evaluate((el) => el.clientHeight)
    expect(scrollHeight).toBeGreaterThan(clientHeight)

    const scrollTop = await results.evaluate((el) => {
      el.scrollTop = el.scrollHeight
      return el.scrollTop
    })
    expect(scrollTop).toBeGreaterThan(0)

    // Representative interactive targets must be >= 44 CSS px.
    // Search input — touch-sized on tablet.
    const searchInput = dialog.getByRole('searchbox')
    const searchBox = await searchInput.boundingBox()
    expect(searchBox).not.toBeNull()
    expect(searchBox!.height).toBeGreaterThanOrEqual(44)

    // Footer action buttons.
    const cancelBtn = dialog.locator('.dialog-footer .btn-secondary')
    const cancelBox = await cancelBtn.boundingBox()
    expect(cancelBox).not.toBeNull()
    expect(cancelBox!.height).toBeGreaterThanOrEqual(44)

    const importBtn = dialog.locator('.dialog-footer .btn-primary')
    const importBox = await importBtn.boundingBox()
    expect(importBox).not.toBeNull()
    expect(importBox!.height).toBeGreaterThanOrEqual(44)

    // Both footer buttons must be in the viewport.
    await expect(cancelBtn).toBeInViewport()
    await expect(importBtn).toBeInViewport()
  })
})
