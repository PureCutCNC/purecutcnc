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
import { seedToolpathVisProject } from './toolpathVisibility.helpers'

test.describe('Toolpath visibility panel smoke', () => {
  test('gcode icon toggle expands and collapses the panel', async ({ app, ui }) => {
    await seedToolpathVisProject(app.page)

    // Async toolpath generation — wait for the sketch panel to appear.
    const sketchPanel = ui.toolpathVis.sketchPanel(app.page)
    await expect(sketchPanel).toBeVisible({ timeout: 15000 })
    await expect(sketchPanel).toHaveClass(/viewport-toolpath-vis--expanded/)

    // Items visible when expanded
    const sketchItems = ui.toolpathVis.sketchItems(app.page)
    await expect(sketchItems.first()).toBeVisible()

    // Collapse
    await ui.toolpathVis.toggle(app.page).click()
    await expect(sketchPanel).not.toHaveClass(/viewport-toolpath-vis--expanded/)
    await expect(sketchItems).toHaveCount(0)

    // Expand again
    await ui.toolpathVis.toggle(app.page).click()
    await expect(sketchPanel).toHaveClass(/viewport-toolpath-vis--expanded/)
    await expect(sketchItems.first()).toBeVisible()
  })

  test('collapse preserves toggle selections', async ({ app, ui }) => {
    await seedToolpathVisProject(app.page)

    const sketchPanel = ui.toolpathVis.sketchPanel(app.page)
    await expect(sketchPanel).toBeVisible({ timeout: 15000 })

    // Toggle off one item
    const sketchItems = ui.toolpathVis.sketchItems(app.page)
    const firstItem = sketchItems.first()
    await expect(firstItem).toHaveAttribute('aria-pressed', 'true')
    await firstItem.click()
    await expect(firstItem).toHaveAttribute('aria-pressed', 'false')

    // Collapse and expand
    await ui.toolpathVis.toggle(app.page).click()
    await expect(sketchPanel).not.toHaveClass(/viewport-toolpath-vis--expanded/)
    await ui.toolpathVis.toggle(app.page).click()
    await expect(sketchPanel).toHaveClass(/viewport-toolpath-vis--expanded/)

    // Selection preserved
    await expect(sketchItems.first()).toHaveAttribute('aria-pressed', 'false')
  })

  test('panel renders in both sketch and 3D views', async ({ app, ui }) => {
    await seedToolpathVisProject(app.page)

    const sketchPanel = ui.toolpathVis.sketchPanel(app.page)
    await expect(sketchPanel).toBeVisible({ timeout: 15000 })
    await expect(ui.toolpathVis.sketchItems(app.page).first()).toBeVisible()

    // The 3D panel exists in the DOM (LCR layout) but may be hidden behind
    // the inactive preview tab — verify it is present in the DOM.
    await expect(ui.toolpathVis.view3dPanel(app.page)).toBeAttached({ timeout: 15000 })
    await expect(ui.toolpathVis.view3dItems(app.page).first()).toBeAttached()
  })
})
