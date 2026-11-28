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
 * Verify exported path smoke (issue #1269).
 *
 * Opens the G-code export fixture (two outside routes around one add feature,
 * GRBL selected), switches the simulation viewport to Verify, and runs each
 * comparison on demand: every covered operation is listed with a verdict, the
 * model comparisons colour the stock (`data-verify-overlay`), Internal ↔
 * Exported verifies the GRBL program against its toolpaths, a finding frames
 * the viewport, and an edit marks the result stale without running again.
 */

import { test, expect } from './fixtures'
import { seedGcodeExportProject } from './gcodeExport.helpers'
import { getProject, seedProject } from './helpers'

test.describe('Verify exported path smoke', () => {
  test('runs each comparison on demand and lists every operation', async ({ app, ui }, testInfo) => {
    const { page } = app
    await seedGcodeExportProject(page)
    await ui.operations.rowByName(page, 'Route B').click()
    await ui.viewMenu.tabSimulation(page).click()

    await ui.verify.modeButton(page).click()
    await expect(ui.verify.panel(page)).toBeVisible()
    await expect(ui.verify.panel(page)).toHaveAttribute('data-verify-status', 'idle')
    await expect(ui.verify.results(page)).toHaveCount(0)
    await expect(ui.simSetup.playTool(page)).toBeDisabled()

    // Model ↔ Internal: cumulative up to the selected Route B.
    await ui.verify.run(page).click()
    await expect(ui.verify.panel(page)).toHaveAttribute('data-verify-status', 'done', { timeout: 60_000 })
    await expect(ui.verify.results(page)).toHaveAttribute('data-verify-result', 'verified')
    await expect(ui.verify.operations(page)).toHaveCount(2)
    await expect(ui.verify.operation(page, 'op-route-a')).toBeVisible()
    await expect(ui.simSetup.viewport(page)).toHaveAttribute('data-verify-overlay', 'cells')
    await page.screenshot({ path: testInfo.outputPath('verify-model-internal.png') })

    // A finding frames the viewport and is marked selected.
    const findings = ui.verify.findings(page)
    if (await findings.count() > 0) {
      await findings.first().click()
      await expect(findings.first()).toHaveAttribute('aria-pressed', 'true')
    }

    // Model ↔ Exported reads the GRBL program back.
    await ui.verify.comparison(page).selectOption('modelExported')
    await expect(ui.verify.panel(page)).toHaveAttribute('data-verify-stale', 'requestChanged')
    await ui.verify.run(page).click()
    await expect(ui.verify.panel(page)).toHaveAttribute('data-verify-stale', 'current', { timeout: 60_000 })
    await expect(ui.verify.operations(page)).toHaveCount(2)

    // Internal ↔ Exported: the program cuts exactly its toolpaths.
    await ui.verify.comparison(page).selectOption('internalExported')
    await ui.verify.run(page).click()
    await expect(ui.verify.panel(page)).toHaveAttribute('data-verify-stale', 'current', { timeout: 60_000 })
    await expect(ui.verify.operation(page, 'op-route-a')).toHaveAttribute('data-verify-verdict', 'verified')
    await expect(ui.verify.operation(page, 'op-route-b')).toHaveAttribute('data-verify-verdict', 'verified')
    await page.screenshot({ path: testInfo.outputPath('verify-internal-exported.png') })

    // An edit leaves the result on screen, marked stale, and runs nothing.
    const project = await getProject(page) as { meta: { name: string } }
    project.meta.name = 'Edited'
    await seedProject(page, JSON.stringify(project))
    await expect(ui.verify.panel(page)).toHaveAttribute('data-verify-stale', 'projectEdited')
    await expect(ui.verify.panel(page)).toHaveAttribute('data-verify-status', 'done')
    await expect(ui.verify.operations(page)).toHaveCount(2)

    // Leaving Verify gives the toolbar back to the simulation.
    await ui.simSetup.modeSelected(page).click()
    await expect(ui.verify.panel(page)).toHaveCount(0)
    await expect(ui.simSetup.viewport(page)).not.toHaveAttribute('data-verify-overlay', 'cells')
  })
})
