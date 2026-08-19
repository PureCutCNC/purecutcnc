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

import { test, expect, type Page } from './fixtures'
import { panelHandles } from './selectors'

/**
 * Panel pull-out handles smoke test (issue #557).
 *
 * Verifies the two chevron handles that replaced the four workspace-layout
 * preset buttons: collapsing a panel reclaims canvas width and hides the
 * panel, the handle's accessible name + chevron direction describe the next
 * action, the handles stay outside the workspace tablist, and panel state
 * survives switching between Sketch / 3D / Simulation.
 */

/** Width of the active sketch stage, used to prove canvas reclamation. */
async function stageWidth(page: Page): Promise<number> {
  const box = await panelHandles.sketchStage(page).boundingBox()
  if (!box) throw new Error('sketch stage has no bounding box')
  return box.width
}

test.describe('Panel pull-out handles', () => {
  test('left handle collapses and restores the project panel, reclaiming canvas', async ({ app }) => {
    const page = app.page
    const original = await stageWidth(page)

    // Open by default: the handle names the action that hides the panel.
    await expect(panelHandles.leftHandle(page)).toHaveAttribute('aria-expanded', 'true')
    await expect(panelHandles.leftHandle(page)).toHaveAccessibleName('Hide project panel')
    await expect(panelHandles.leftHandle(page).locator('use')).toHaveAttribute('href', /#chevrons-left$/)

    await panelHandles.leftHandle(page).click()
    await expect(panelHandles.leftPanel(page)).not.toBeVisible()
    expect(await stageWidth(page)).toBeGreaterThan(original + 50)

    // Collapsed: name, chevron direction and resting style all flip.
    await expect(panelHandles.leftHandle(page)).toHaveAttribute('aria-expanded', 'false')
    await expect(panelHandles.leftHandle(page)).toHaveAccessibleName('Show project panel')
    await expect(panelHandles.leftHandle(page).locator('use')).toHaveAttribute('href', /#chevrons-right$/)
    await expect(panelHandles.leftHandle(page)).toHaveClass(/panel-handle--collapsed/)

    await panelHandles.leftHandle(page).click()
    await expect(panelHandles.leftPanel(page)).toBeVisible()
    expect(Math.abs((await stageWidth(page)) - original)).toBeLessThanOrEqual(1)
    await expect(panelHandles.leftHandle(page)).toHaveAttribute('aria-expanded', 'true')
  })

  test('right handle collapses and restores the CAM panel, reclaiming canvas', async ({ app }) => {
    const page = app.page
    const original = await stageWidth(page)

    await expect(panelHandles.rightHandle(page)).toHaveAttribute('aria-expanded', 'true')
    await expect(panelHandles.rightHandle(page)).toHaveAccessibleName('Hide CAM panel')
    await expect(panelHandles.rightHandle(page).locator('use')).toHaveAttribute('href', /#chevrons-right$/)

    await panelHandles.rightHandle(page).click()
    await expect(panelHandles.rightPanel(page)).not.toBeVisible()
    expect(await stageWidth(page)).toBeGreaterThan(original + 50)

    await expect(panelHandles.rightHandle(page)).toHaveAttribute('aria-expanded', 'false')
    await expect(panelHandles.rightHandle(page)).toHaveAccessibleName('Show CAM panel')
    await expect(panelHandles.rightHandle(page).locator('use')).toHaveAttribute('href', /#chevrons-left$/)
    await expect(panelHandles.rightHandle(page)).toHaveClass(/panel-handle--collapsed/)

    await panelHandles.rightHandle(page).click()
    await expect(panelHandles.rightPanel(page)).toBeVisible()
    expect(Math.abs((await stageWidth(page)) - original)).toBeLessThanOrEqual(1)
    await expect(panelHandles.rightHandle(page)).toHaveAttribute('aria-expanded', 'true')
  })

  test('handles sit outside the workspace tablist', async ({ app }) => {
    const page = app.page
    const tablist = panelHandles.centreTablist(page)

    // The tablist holds exactly the three workspace tabs and no handle.
    await expect(tablist.getByRole('tab')).toHaveCount(3)
    await expect(tablist.locator('#panel-handle-left')).toHaveCount(0)
    await expect(tablist.locator('#panel-handle-right')).toHaveCount(0)

    await expect(panelHandles.leftHandle(page)).toBeVisible()
    await expect(panelHandles.rightHandle(page)).toBeVisible()
  })

  test('panel state survives Sketch → 3D → Simulation switching', async ({ app }) => {
    const page = app.page

    await panelHandles.leftHandle(page).click()
    await expect(panelHandles.leftPanel(page)).not.toBeVisible()

    await page.getByRole('tab', { name: '3D view' }).click()
    await expect(panelHandles.leftPanel(page)).not.toBeVisible()

    await page.getByRole('tab', { name: 'Simulation' }).click()
    await expect(panelHandles.leftPanel(page)).not.toBeVisible()
    await expect(panelHandles.leftHandle(page)).toHaveAttribute('aria-expanded', 'false')

    await panelHandles.leftHandle(page).click()
    await expect(panelHandles.leftPanel(page)).toBeVisible()
  })
})
