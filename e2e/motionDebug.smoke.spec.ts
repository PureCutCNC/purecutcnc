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
 * Since #1179 a rotary program also offers a 3D wrapped view, and it is where
 * the dialog opens: the third test seeds an Around pocket on a bar (one cutting
 * level, so both views stay available) and asserts the wrapped scene draws and
 * reads out its A span, while a flat operation keeps only the 2D plan. The
 * fourth test adds a real **Rotary rough** to an imported model — the case the
 * app check found unreachable (correction round 3): its cutting Z changes on
 * every move, and the plan view's eligibility used to gate the button itself.
 */

import { test, expect } from './fixtures'
import { seedGcodeExportProject } from './gcodeExport.helpers'
import { seedAroundRotaryProject, seedRotaryModelProject } from './rotaryMotionDebug.helpers'

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

    // A rotary program lands on the wrapped view (correction round 3); its one
    // cutting level keeps the plan a click away.
    const canvas = ui.motionDebug.wrappedCanvas(app.page)
    await expect(canvas).toBeVisible()
    await expect(ui.motionDebug.svg(app.page)).toHaveCount(0)
    const toggle = ui.motionDebug.viewToggle(app.page)
    await expect(toggle).toBeVisible()
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

    // Hiding a layer takes it out of the drawn scene and re-showing it brings it
    // back. The redraw itself (the review's stale-pixel finding) is asserted in
    // the unit suite, which counts the renderer's draws through an injected
    // renderer — the browser's pixels are not observable from here.
    const pieces = async () => Number(await host.getAttribute('data-motion-pieces'))
    const exported = ui.motionDebug.layerCheckbox(app.page, 'Exported G-code')
    await exported.uncheck()
    await expect.poll(pieces).toBe(0)
    await exported.check()
    await expect.poll(pieces).toBeGreaterThan(20)

    // The sidebar's cutting-level and non-cutting filters reach the 3D scene
    // too: "all levels" draws more than the default level, and turning the
    // non-cutting moves on adds the rapids (review of #1179).
    const oneLevel = await pieces()
    const zSelect = ui.motionDebug.zLevelSelect(app.page)
    await zSelect.selectOption('all')
    await expect.poll(pieces).toBeGreaterThan(oneLevel)
    const allCutting = await pieces()
    const nonCutting = ui.motionDebug.nonCuttingCheckbox(app.page)
    await nonCutting.check()
    await expect.poll(pieces).toBeGreaterThan(allCutting)
    await nonCutting.uncheck()
    await expect.poll(pieces).toBe(allCutting)

    // Switching back restores the flat plan.
    await ui.motionDebug.view2dButton(app.page).click()
    await expect(ui.motionDebug.svg(app.page)).toBeVisible()
  })

  test('opens the wrapped view for a real Rotary rough on a round bar', async ({ app, ui }) => {
    // A real rotary operation generates thousands of moves and the export then
    // posts them; two workers on a software-rendered runner need the room.
    test.setTimeout(180_000)
    await seedRotaryModelProject(app.page)

    // The Around face is active from the seed; add the operation the wrapped
    // view exists for. A rotary kind takes no rough/finish split, so its row
    // carries a single Add.
    await ui.face.switchTo(app.page, 'Around')
    await ui.setupCam.add(app.page).click()
    await expect(ui.setupCam.addMenu(app.page)).toBeVisible()
    await ui.setupCam.addMenu(app.page).locator('.cam-operation-item')
      .filter({ has: app.page.getByRole('button', { name: 'Rotary rough', exact: true }) })
      .getByRole('button', { name: 'Add', exact: true }).click()
    await expect(ui.operations.rowByName(app.page, 'Rotary rough')).toBeVisible()

    // Wait for the operation to generate before opening the export: the Inspect
    // action needs a prepared program, and the dialog needs the generated path.
    await expect(ui.generation.gearStatus(app.page)).toHaveAttribute('aria-label', /up to date/, { timeout: 60_000 })

    // Add leaves the new operation selected, so its properties header carries
    // the per-operation export action. Clicking the row again would deselect
    // it (the panel toggles selection).
    await ui.operations.propertiesExportButton(app.page, 'Rotary rough').click()
    await expect(ui.exportDialog.root(app.page)).toBeVisible()

    // This is the app-check finding: the button must be there for a variable-Z
    // rotary operation, which 89f434ab refused.
    const inspect = ui.exportDialog.inspectButton(app.page)
    await expect(inspect).toBeVisible()
    await inspect.click()

    const dialog = ui.motionDebug.root(app.page)
    await expect(dialog).toBeVisible()

    // It lands on the wrapped 3D scene and draws the program there.
    const canvas = ui.motionDebug.wrappedCanvas(app.page)
    await expect(canvas).toBeVisible()
    await expect(ui.motionDebug.svg(app.page)).toHaveCount(0)
    const size = await canvas.evaluate((element) => ({ width: element.clientWidth, height: element.clientHeight }))
    expect(size.width).toBeGreaterThan(0)
    expect(size.height).toBeGreaterThan(0)

    const host = app.page.locator('[data-testid="motion-debug-3d"]')
    await expect.poll(async () => Number(await host.getAttribute('data-motion-pieces'))).toBeGreaterThan(20)
    await expect(host.locator('.motion-debug__empty')).toHaveCount(0)

    const readout = ui.motionDebug.angleReadout(app.page)
    await expect(readout).toContainText(/A range: -?[\d.]+° … -?[\d.]+°/)

    // A rough changes cutting Z on every move, so there is no cutting-level
    // selector to offer, no per-level table, and no plan model — the flat plan
    // is not offered at all rather than listing thousands of levels
    // (correction round 3).
    await expect(ui.motionDebug.zLevelSelect(app.page)).toHaveCount(0)
    await expect(app.page.locator('[data-testid="motion-debug-per-level"]')).toHaveCount(0)
    await expect(app.page.locator('[data-testid="motion-debug-variable-z-note"]')).toBeVisible()
    await expect(ui.motionDebug.viewToggle(app.page)).toHaveCount(0)

    // The sidebar still reports the program it is showing. A rotary generator
    // reports no separate raw path, so only the optimized count is claimed.
    const sidebar = dialog.locator('.motion-debug__sidebar')
    await expect(sidebar).toContainText('Optimized moves')
    await expect(sidebar).not.toContainText('Raw moves:')
    await expect(sidebar).not.toContainText('Generated (raw)')
    await expect(sidebar).not.toContainText('—')
  })
})
