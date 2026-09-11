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
 * Export G-code dialog smoke: the operation checklist (issue #274) and the
 * error tier (issue #755).
 *
 * Covers the per-operation entry point (the Properties-header action
 * pre-checks only the selected operation), the default set from the header
 * Export button, the disabled state when nothing is checked, and a program
 * that changes tool with M6 off — reported as an error that blocks the export,
 * where a program whose operations share one tool is not.
 */

import { test, expect } from './fixtures'
import { seedGcodeExportProject } from './gcodeExport.helpers'

test.describe('Export G-code operation checklist smoke', () => {
  test('per-operation export pre-checks only that operation', async ({ app, ui }) => {
    await seedGcodeExportProject(app.page)

    // Selecting an operation row points the Properties-header export action at it.
    await ui.operations.rowByName(app.page, 'Route B').click()
    await ui.operations.propertiesExportButton(app.page, 'Route B').click()

    const dialog = ui.exportDialog.root(app.page)
    await expect(dialog).toBeVisible()
    await expect(ui.exportDialog.operationOptions(app.page)).toHaveCount(2)
    await expect(ui.exportDialog.operationCheckbox(app.page, 'Route A')).not.toBeChecked()
    await expect(ui.exportDialog.operationCheckbox(app.page, 'Route B')).toBeChecked()

    // The GRBL machine is active, so the scoped preview enables Export.
    await expect(ui.exportDialog.exportButton(app.page)).toBeEnabled()

    // Unchecking the last operation disables Export and explains why.
    await ui.exportDialog.operationCheckbox(app.page, 'Route B').uncheck()
    await expect(ui.exportDialog.exportButton(app.page)).toBeDisabled()
    await expect(ui.exportDialog.errors(app.page).filter({
      hasText: 'No operations selected',
    })).toBeVisible()

    // Re-checking the other operation re-enables Export.
    await ui.exportDialog.operationCheckbox(app.page, 'Route A').check()
    await expect(ui.exportDialog.exportButton(app.page)).toBeEnabled()
  })

  test('header export pre-checks the whole visible set', async ({ app, ui }) => {
    await seedGcodeExportProject(app.page)

    await ui.operations.headerExportButton(app.page).click()

    await expect(ui.exportDialog.root(app.page)).toBeVisible()
    await expect(ui.exportDialog.operationCheckbox(app.page, 'Route A')).toBeChecked()
    await expect(ui.exportDialog.operationCheckbox(app.page, 'Route B')).toBeChecked()
    await expect(ui.exportDialog.exportButton(app.page)).toBeEnabled()

    // The header toggle flips the whole selection: Deselect all → Select all.
    const toggle = ui.exportDialog.selectionToggle(app.page)
    await expect(toggle).toHaveText('Deselect all')
    await toggle.click()
    await expect(ui.exportDialog.operationCheckbox(app.page, 'Route A')).not.toBeChecked()
    await expect(ui.exportDialog.operationCheckbox(app.page, 'Route B')).not.toBeChecked()
    await expect(ui.exportDialog.exportButton(app.page)).toBeDisabled()
    await expect(toggle).toHaveText('Select all')
    await toggle.click()
    await expect(ui.exportDialog.operationCheckbox(app.page, 'Route A')).toBeChecked()
    await expect(ui.exportDialog.operationCheckbox(app.page, 'Route B')).toBeChecked()
    await expect(ui.exportDialog.exportButton(app.page)).toBeEnabled()
  })

  test('one tool across the program with tool changes off stays clean', async ({ app, ui }) => {
    await seedGcodeExportProject(app.page)
    await ui.operations.headerExportButton(app.page).click()

    // A ready program reports its total line count; the dialog shows nothing
    // while a preparation is in flight, which reads as 0 here.
    const reportedLines = async (): Promise<number> => {
      const summary = ui.exportPreview.summary(app.page)
      if (await summary.count() === 0) return 0
      const match = /(\d+) lines total/.exec((await summary.textContent()) ?? '')
      return match ? Number(match[1]) : 0
    }

    await expect.poll(reportedLines).toBeGreaterThan(0)
    const withToolChanges = await reportedLines()

    await ui.exportDialog.emitToolChanges(app.page).uncheck()

    // Rebuilding the program takes a debounce, and the change commands it drops
    // (with the spindle restart for the next operation) sit past the 30-line
    // preview, so the reported line count falling is the only whole-program
    // signal available. It has to fall *to a ready program*: the dialog reports
    // no count at all while a preparation is in flight, and "0 < before" would
    // otherwise let the assertions below describe that empty state rather than
    // the rebuilt program. Both routes share a tool, so nothing was left
    // unexecuted and there is no error.
    await expect.poll(async () => {
      const lines = await reportedLines()
      return lines > 0 && lines < withToolChanges
    }).toBe(true)
    await expect(ui.exportDialog.errors(app.page)).toHaveCount(0)
    await expect(ui.exportDialog.exportButton(app.page)).toBeEnabled()
  })

  test('a real tool change with tool changes off blocks the export', async ({ app, ui }) => {
    await seedGcodeExportProject(app.page, { routeBOnSecondTool: true })
    await ui.operations.headerExportButton(app.page).click()

    await ui.exportDialog.emitToolChanges(app.page).uncheck()

    // Route B would run with Route A's tool and nothing in the program pauses
    // the machine for a change, so this blocks the export rather than noting it.
    await expect(ui.exportDialog.errors(app.page).filter({ hasText: 'Route B' })).toBeVisible()
    await expect(ui.exportDialog.exportButton(app.page)).toBeDisabled()

    // Emitting the change is the fix the message asks for, and it clears the
    // error once the rebuilt program lands.
    await ui.exportDialog.emitToolChanges(app.page).check()
    await expect(ui.exportDialog.exportButton(app.page)).toBeEnabled()
    await expect(ui.exportDialog.errors(app.page)).toHaveCount(0)
  })
})
