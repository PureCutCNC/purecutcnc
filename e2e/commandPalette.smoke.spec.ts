/**
 * Copyright 2026 Maik Rolf
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

import { readFileSync } from 'node:fs'
import { test, expect } from './fixtures'
import {
  cancelPendingAdd,
  clickMenuItem,
  getPendingAddShape,
  getProject,
  openRowContextMenu,
  rowByName,
  seedProject,
  selectFeatures,
  setPendingAddAnchor,
  startAddRectPlacement,
  startRotateFeature,
} from './helpers'
import { seedGcodeExportProject } from './gcodeExport.helpers'
import { seedObviousOverlapFeatureProject, seedOverlapFeatureProject } from './overlapFeatureSelection.helpers'

test.describe('Command palette', () => {
  test.beforeEach(async ({ app }) => {
    const page = app.page

    // The browser build loads GoatCounter; keep these smoke tests hermetic on
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
  })

  test('opens with Ctrl+K, filters, runs a command and closes with Escape', async ({ app }) => {
    const page = app.page

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
    const textInput = page.locator('#text-tool-value')
    await expect(textInput).toBeFocused()

    // The palette may open over another dialog. Escape must close only the
    // palette and return focus to the draft, not close both dialogs.
    await textInput.fill('Draft text')
    await page.keyboard.press('Control+k')
    await expect(dialog).toBeVisible()
    await input.fill('zoom to model')
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
    await expect(textDialog).toBeVisible()
    await expect(textInput).toHaveValue('Draft text')
    await expect(textInput).toBeFocused()

    await page.keyboard.press('Escape')
    await expect(textDialog).not.toBeVisible()

    // Tab is contained by the modal; it must not reach background controls.
    await page.keyboard.press('Control+k')
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Tab')
    await expect(input).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()

    // Touch/pointer entry point in the top toolbar; focus returns to it.
    const paletteButton = page.locator('.toolbar--global').getByRole('button', { name: 'Command palette' })
    await paletteButton.click()
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
    await expect(paletteButton).toBeFocused()
  })

  test('closing the palette keeps a partially completed transform', async ({ app }) => {
    const page = app.page

    await seedOverlapFeatureProject(page, 2)
    await startRotateFeature(page, 'f-overlap-1')

    const panel = page.locator('.canvas-workflow-panel--transform')
    await expect(panel).toBeVisible()
    await expect(panel.locator('.canvas-workflow-panel__step')).toHaveText(/Select origin/)

    await page.keyboard.press('Control+k')
    const dialog = page.getByRole('dialog', { name: 'Command palette' })
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()

    await expect(panel).toBeVisible()
    await expect(panel.locator('.canvas-workflow-panel__step')).toHaveText(/Select origin/)
  })

  test('closing the palette keeps a pending rectangle anchor', async ({ app }) => {
    const page = app.page

    await startAddRectPlacement(page)
    await setPendingAddAnchor(page, 10, 10)
    expect(await getPendingAddShape(page)).toBe('rect')

    await page.keyboard.press('Control+k')
    const dialog = page.getByRole('dialog', { name: 'Command palette' })
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()

    expect(await getPendingAddShape(page)).toBe('rect')
    await cancelPendingAdd(page)
  })

  test('closing the palette keeps a pending constraint', async ({ app, ui }) => {
    const page = app.page

    await seedOverlapFeatureProject(page, 2)
    const menu = await openRowContextMenu(page, rowByName(page, 'Top overlap'))
    await clickMenuItem(menu, 'Add constraint')

    const panel = page.locator('.canvas-workflow-panel').filter({ hasText: /Pick anchor/ })
    await expect(panel).toBeVisible()

    await page.keyboard.press('Control+k')
    const dialog = page.getByRole('dialog', { name: 'Command palette' })
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()

    await expect(panel).toBeVisible()
  })

  test('closing the palette keeps a numeric entry', async ({ app, ui }) => {
    const page = app.page

    await seedOverlapFeatureProject(page, 2)
    await selectFeatures(page, ['f-overlap-1'])
    const panel = ui.properties.panel(page)
    await panel.getByRole('button', { name: 'Instance' }).click()
    const numeric = panel.locator('[data-numeric-entry="true"]').first()
    await expect(numeric).toBeVisible()
    await numeric.fill('1.25')

    await page.keyboard.press('Control+k')
    const dialog = page.getByRole('dialog', { name: 'Command palette' })
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()

    await expect(numeric).toHaveValue('1.25')
    await expect(numeric).toBeFocused()
  })

  test('palette runs an alignment command on a multi-selection', async ({ app }) => {
    const page = app.page

    await seedObviousOverlapFeatureProject(page)
    await selectFeatures(page, ['f-overlap-1', 'f-overlap-2'])

    await page.keyboard.press('Control+k')
    const dialog = page.getByRole('dialog', { name: 'Command palette' })
    await expect(dialog).toBeVisible()
    const input = dialog.getByRole('textbox')
    await input.fill('Align left')
    await expect(dialog.getByRole('option', { name: /Align left/ })).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(dialog).not.toBeVisible()

    const project = await getProject(page)
    const features = project.features as Array<{ id: string; transform: { e: number } }>
    const bottom = features.find((feature) => feature.id === 'f-overlap-1')
    const top = features.find((feature) => feature.id === 'f-overlap-2')
    expect(bottom?.transform.e).toBe(top?.transform.e)
  })

  test('palette starts a dimension workflow', async ({ app }) => {
    const page = app.page

    await seedObviousOverlapFeatureProject(page)
    await selectFeatures(page, ['f-overlap-1'])

    await page.keyboard.press('Control+k')
    const dialog = page.getByRole('dialog', { name: 'Command palette' })
    await expect(dialog).toBeVisible()
    const input = dialog.getByRole('textbox')
    await input.fill('Horizontal dimension')
    await expect(dialog.getByRole('option', { name: /Horizontal dimension/ })).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(dialog).not.toBeVisible()

    await expect(page.getByText('Click the first point')).toBeVisible()
  })

  test('palette exposes distribution commands for three selected features', async ({ app }) => {
    const page = app.page

    await seedOverlapFeatureProject(page, 3)
    await selectFeatures(page, ['f-overlap-1', 'f-overlap-2', 'f-overlap-3'])

    await page.keyboard.press('Control+k')
    const dialog = page.getByRole('dialog', { name: 'Command palette' })
    await expect(dialog).toBeVisible()
    const input = dialog.getByRole('textbox')
    await input.fill('Distribute horizontally (equal gaps)')
    const option = dialog.getByRole('option', { name: /Distribute horizontally \(equal gaps\)/ })
    await expect(option).toBeEnabled()
    await page.keyboard.press('Enter')
    await expect(dialog).not.toBeVisible()
  })

  test('closing the palette leaves toolpath generation paused, not cancelled', async ({ app, ui }) => {
    const page = app.page

    await ui.generation.backendTrigger(page).click()
    await ui.generation.backendOption(page, /Background thread/).click()

    const heavy = readFileSync(new URL('../src/engine/test-fixtures/trochoidal-249k.camj', import.meta.url), 'utf8')
    void seedProject(page, heavy).catch(() => {})

    await expect(ui.generation.gearStatus(page)).toHaveAttribute('aria-label', /Generating/, { timeout: 20_000 })
    await ui.generation.backendTrigger(page).click()
    await ui.generation.stopButton(page).click()
    await expect(ui.generation.gearStatus(page)).toHaveAttribute('aria-label', /paused/, { timeout: 20_000 })

    await page.keyboard.press('Control+k')
    const dialog = page.getByRole('dialog', { name: 'Command palette' })
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()

    await expect(ui.generation.gearStatus(page)).toHaveAttribute('aria-label', /paused/, { timeout: 5_000 })
  })

  test('closing the palette keeps simulation playback open', async ({ app, ui }) => {
    const page = app.page

    await seedGcodeExportProject(page)
    await ui.operations.rowByName(page, 'Route A').click()
    await ui.viewMenu.tabSimulation(page).click()

    const playTool = page.locator('#workspace-panel-simulation').getByRole('button', { name: /Play tool/i })
    await expect(playTool).toBeEnabled({ timeout: 30_000 })
    await playTool.click()
    const playbackBar = page.locator('.simulation-playback-bar')
    await expect(playbackBar).toBeVisible()

    await page.keyboard.press('Control+k')
    const dialog = page.getByRole('dialog', { name: 'Command palette' })
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()

    await expect(playbackBar).toBeVisible()
    await expect(page.locator('#workspace-panel-simulation')).toBeVisible()
  })
})
