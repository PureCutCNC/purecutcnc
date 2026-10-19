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

test.describe('Command palette', () => {
  test('opens with Ctrl+K, filters, runs a command and closes with Escape', async ({ app }) => {
    const page = app.page

    // The browser build loads GoatCounter; keep this smoke test hermetic on
    // runners without external DNS. Reload after installing the route so the
    // fixture's initial-load console error does not leak into the assertion.
    await page.route('https://gc.zgo.at/count.js', (route) => route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: '',
    }))
    // Only the offline analytics load may be present; a real boot error must
    // still fail the smoke test.
    expect(app.errors.every((error) => error.includes('ERR_NAME_NOT_RESOLVED'))).toBe(true)
    app.errors.length = 0
    await page.reload()
    await page.waitForSelector('canvas', { timeout: 15000 })

    await page.keyboard.press('Control+k')
    const dialog = page.getByRole('dialog', { name: 'Command palette' })
    await expect(dialog).toBeVisible()

    const input = dialog.getByRole('textbox')

    await input.fill('rectangle')
    await expect(dialog.getByRole('option', { name: /rectangle/i }).first()).toBeVisible()

    await input.fill('undo')
    await expect(dialog.getByRole('option', { name: /undo/i })).toHaveCount(0)

    await input.fill('zoom to model')
    const option = dialog.getByRole('option', { name: /zoom to model/i })
    await expect(option).toBeVisible()

    await page.keyboard.press('Enter')
    await expect(dialog).not.toBeVisible()

    // Import lives in the toolbar assemblies; the palette reaches it through
    // the shared palette-event bridge.
    await page.keyboard.press('Control+k')
    await expect(dialog).toBeVisible()
    await input.fill('import geometry')
    await expect(dialog.getByRole('option', { name: /import geometry/i })).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(dialog).not.toBeVisible()
    const importDialog = page.getByRole('heading', { name: 'Import geometry' })
    await expect(importDialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(importDialog).not.toBeVisible()

    // Text uses the same bridge but its dialog lives in the creation surface.
    await page.keyboard.press('Control+k')
    await expect(dialog).toBeVisible()
    await input.fill('text')
    await expect(dialog.getByRole('option', { name: /text/i }).first()).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(dialog).not.toBeVisible()
    const textDialog = page.getByRole('heading', { name: 'Add text' })
    await expect(textDialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(textDialog).not.toBeVisible()

    await page.keyboard.press('Control+k')
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
  })
})
