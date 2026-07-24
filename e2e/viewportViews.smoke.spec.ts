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

/**
 * View-preset dropdown smoke test (issue #243).
 *
 * Verifies the single-button dropdown that replaced the 7-button preset row
 * in both the 3D and simulation viewports: opening the menu, switching to a
 * named view, and confirming the trigger title + check-mark update.
 */
test.describe('View preset menu', () => {
  test('3D viewport: switch to Top view and verify the trigger updates', async ({ app, ui }) => {
    await ui.viewMenu.tab3d(app.page).click()

    const trigger = ui.viewMenu.trigger3d(app.page)
    await expect(trigger).toBeVisible()

    await trigger.click()
    const menu = ui.viewMenu.menu3d(app.page)
    await expect(menu).toBeVisible()

    const topOption = ui.viewMenu.option3d(app.page, 'Top view')
    await expect(topOption).toBeVisible()
    await topOption.click()

    await expect(menu).not.toBeVisible()

    await trigger.click()
    await expect(ui.viewMenu.menu3d(app.page)).toBeVisible()
    await expect(ui.viewMenu.option3d(app.page, 'Top view')).toHaveAttribute('aria-checked', 'true')
    await expect(ui.viewMenu.option3d(app.page, 'Isometric view')).toHaveAttribute('aria-checked', 'false')
  })

  test('3D viewport: Fit to model and Reset view actions are available', async ({ app, ui }) => {
    await ui.viewMenu.tab3d(app.page).click()

    const trigger = ui.viewMenu.trigger3d(app.page)
    await trigger.click()
    const menu = ui.viewMenu.menu3d(app.page)
    await expect(menu).toBeVisible()

    await expect(ui.viewMenu.action3d(app.page, 'Fit to model')).toBeVisible()
    await expect(ui.viewMenu.action3d(app.page, 'Reset view')).toBeVisible()

    await ui.viewMenu.action3d(app.page, 'Reset view').click()
    await expect(menu).not.toBeVisible()
  })

  test('simulation viewport: switch to Front view and verify the trigger updates', async ({ app, ui }) => {
    await ui.viewMenu.tabSimulation(app.page).click()

    const trigger = ui.viewMenu.triggerSim(app.page)
    await expect(trigger).toBeVisible()

    await trigger.click()
    const menu = ui.viewMenu.menuSim(app.page)
    await expect(menu).toBeVisible()

    const frontOption = ui.viewMenu.optionSim(app.page, 'Front view')
    await expect(frontOption).toBeVisible()
    await frontOption.click()

    await expect(menu).not.toBeVisible()

    await trigger.click()
    await expect(ui.viewMenu.menuSim(app.page)).toBeVisible()
    await expect(ui.viewMenu.optionSim(app.page, 'Front view')).toHaveAttribute('aria-checked', 'true')
  })
})
