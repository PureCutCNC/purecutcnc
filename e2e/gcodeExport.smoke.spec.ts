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
 * Export G-code dialog smoke: the operation checklist (issue #274).
 *
 * Covers the per-operation entry point (row action pre-checks only that
 * operation), the default set from the header Export button, and the
 * disabled state when nothing is checked.
 */

import { test, expect } from './fixtures'
import { seedGcodeExportProject } from './gcodeExport.helpers'

test.describe('Export G-code operation checklist smoke', () => {
  test('per-operation export pre-checks only that operation', async ({ app, ui }) => {
    await seedGcodeExportProject(app.page)

    await ui.operations.rowExportButton(app.page, 'Route B').click()

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
    await expect(ui.exportDialog.warnings(app.page).filter({
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
  })
})
