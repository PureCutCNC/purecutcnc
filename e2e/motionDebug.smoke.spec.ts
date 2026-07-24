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
 */

import { test, expect } from './fixtures'
import { seedGcodeExportProject } from './gcodeExport.helpers'

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

    await expect(ui.motionDebug.diagnostic(app.page)).toContainText('Verified')
  })
})
