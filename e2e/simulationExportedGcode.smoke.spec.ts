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
 * Smoke test for simulating from exported G-code (issue #1261).
 */

import { test, expect } from './fixtures'
import { seedGcodeExportProject } from './gcodeExport.helpers'

test.describe('Simulation exported G-code source toggle', () => {
  test('toggles between Planned and Exported G-code in Simulation', async ({ app, ui }) => {
    await seedGcodeExportProject(app.page)

    await ui.operations.rowByName(app.page, 'Route B').click()
    await app.page.getByRole('tab', { name: 'Simulation' }).click()

    const sourceGroup = app.page.getByRole('tablist', { name: 'Simulation source' })
    await expect(sourceGroup).toBeVisible()

    const plannedBtn = sourceGroup.getByRole('button', { name: 'Planned' })
    const exportedBtn = sourceGroup.getByRole('button', { name: 'Exported G-code' })
    await expect(plannedBtn).toBeVisible()
    await expect(exportedBtn).toBeEnabled()

    await exportedBtn.click()
    await expect(exportedBtn).toHaveClass(/simulation-mode-toggle__btn--active/)
    await expect(app.page.getByTestId('simulation-export-warning')).toHaveCount(0)

    await plannedBtn.click()
    await expect(plannedBtn).toHaveClass(/simulation-mode-toggle__btn--active/)
  })
})
