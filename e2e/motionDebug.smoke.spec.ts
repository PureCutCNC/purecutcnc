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

/**
 * Exported-motion debug view smoke (issue #356).
 *
 * Opens the debugger for a single eligible operation from the Export dialog,
 * then exercises the layer toggles, the non-cutting-moves toggle, and the
 * cutting-Z selector, and asserts the diagnostic reports "verified".
 *
 * Since #1179 a rotary program also offers a 3D wrapped view: the second test
 * seeds an Around pocket on a bar and asserts the view draws and reads out its
 * A span, while a flat operation keeps only the 2D plan.
 */

import { test, expect } from './fixtures'
import { seedGcodeExportProject } from './gcodeExport.helpers'
import { seedAroundRotaryProject } from './rotaryMotionDebug.helpers'

test.describe('Exported-motion debug view smoke', () => {
  test('open from the export dialog for one operation and toggle layers', async ({ app, ui }) => {
    await seedGcodeExportProject(app.page)

    // The per-operation entry point pre-checks only Route B → exactly one
    // eligible operation, so the Inspect button is available.
    await ui.operations.rowByName(app.page, 'Route B').click()
    await ui.operations.propertiesExportButton(app.page, 'Route B').click()
    await expect(ui.exportDialog.root(app.page)).toBeVisible()

    const inspect = ui.exportDialog.inspectButton(app.page)
    await expect(inspect).toBeVisible()
    await inspect.click()

    const dialog = ui.motionDebug.root(app.page)
    await expect(dialog).toBeVisible()
    await expect(ui.motionDebug.svg(app.page)).toBeVisible()

    // The exported layer is parsed from the literal G-code; toggling it off and
    // back on should keep the view stable (no console errors — guarded by the
    // fixture) and the diagnostic should end "verified" for a clean route.
    const exported = ui.motionDebug.layerCheckbox(app.page, 'Exported G-code')
    await exported.uncheck()
    await expect(exported).not.toBeChecked()
    await exported.check()
    await expect(exported).toBeChecked()

    // Non-cutting moves are hidden by default; toggling them on reveals the
    // dashed layer without affecting the verified status.
    const nonCutting = ui.motionDebug.nonCuttingCheckbox(app.page)
    await expect(nonCutting).not.toBeChecked()
    await nonCutting.check()
    await expect(nonCutting).toBeChecked()

    // Switch from the default (first cutting Z) to all cutting levels.
    const zSelect = ui.motionDebug.zLevelSelect(app.page)
    await zSelect.selectOption('all')

    // A flat operation's program has no rotary word, so there is nothing to
    // wrap and no 3D view is offered (issue #1179).
    await expect(ui.motionDebug.viewToggle(app.page)).toHaveCount(0)

    await expect(ui.motionDebug.diagnostic(app.page)).toContainText('Verified')
  })

  test('verifies a ShopBot part file export', async ({ app, ui }) => {
    // Same route, exported as SBP (issue #953): the exported layer is parsed
    // from the part file by the SBP parser, and must still match the path.
    await seedGcodeExportProject(app.page, { machineId: 'shopbot' })

    // The button that opens the export is named after the machine's format too.
    await ui.operations.rowByName(app.page, 'Route B').click()
    await ui.operations.propertiesExportButton(app.page, 'Route B', 'ShopBot part file').click()
    await expect(ui.exportDialog.root(app.page)).toBeVisible()
    await expect(ui.exportDialog.exportButton(app.page)).toContainText('.sbp')

    await ui.exportDialog.inspectButton(app.page).click()
    await expect(ui.motionDebug.root(app.page)).toBeVisible()
    await expect(ui.motionDebug.svg(app.page)).toBeVisible()

    // The exported layer is a part file here, not G-code.
    await expect(ui.motionDebug.layerCheckbox(app.page, 'Exported part file')).toBeChecked()
    await expect(ui.motionDebug.root(app.page)).not.toContainText('Exported G-code')

    await ui.motionDebug.zLevelSelect(app.page).selectOption('all')
    await expect(ui.motionDebug.diagnostic(app.page)).toContainText('Verified')
  })

  test('draws the exported rotary program wrapped around the bar in 3D', async ({ app, ui }) => {
    // The 3D scene build and the generation cache wait are the slow parts; two
    // workers on a software-rendered runner push this past the default budget.
    test.setTimeout(120_000)
    await seedAroundRotaryProject(app.page)

    // Wait for the Around pocket to generate before opening the export: an
    // operation with no toolpath is not eligible for the inspector.
    await expect(ui.generation.gearStatus(app.page)).toHaveAttribute('aria-label', /up to date/, { timeout: 30_000 })

    await ui.operations.rowByName(app.page, 'Around pocket').click()
    await ui.operations.propertiesExportButton(app.page, 'Around pocket').click()
    await expect(ui.exportDialog.root(app.page)).toBeVisible()
    await ui.exportDialog.inspectButton(app.page).click()

    // The plan view stays the default; the rotary program adds the toggle.
    await expect(ui.motionDebug.svg(app.page)).toBeVisible()
    const toggle = ui.motionDebug.viewToggle(app.page)
    await expect(toggle).toBeVisible()

    await ui.motionDebug.view3dButton(app.page).click()
    const canvas = ui.motionDebug.wrappedCanvas(app.page)
    await expect(canvas).toBeVisible()
    await expect(ui.motionDebug.svg(app.page)).toHaveCount(0)
    const size = await canvas.evaluate((element) => ({ width: element.clientWidth, height: element.clientHeight }))
    expect(size.width).toBeGreaterThan(0)
    expect(size.height).toBeGreaterThan(0)

    // The scene really drew the program wrapped (not an empty canvas): the
    // wrapped pocket is many 5° pieces, and no WebGL fallback message is shown.
    const host = app.page.locator('[data-testid="motion-debug-3d"]')
    await expect.poll(async () => Number(await host.getAttribute('data-motion-pieces'))).toBeGreaterThan(20)
    await expect(host.locator('.motion-debug__empty')).toHaveCount(0)

    // The readout names the program's A span (a wrapped pocket turns the bar).
    const readout = ui.motionDebug.angleReadout(app.page)
    await expect(readout).toContainText('A range')
    await expect(readout).toContainText(/A range: -?[\d.]+° … -?[\d.]+°/)

    // Switching back restores the flat plan.
    await ui.motionDebug.view2dButton(app.page).click()
    await expect(ui.motionDebug.svg(app.page)).toBeVisible()
  })
})
