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
 * Choosing and sizing round stock in the Properties panel (#392 slices B–D):
 * the Shape field turns a block into a bar and swaps Width/Height/Thickness for
 * Diameter/Length/Axis, a diameter edit reaches the status bar, an axis change
 * is one undo step, the bar gains a chuck the store keeps centred, plasma mode
 * hides the Shape field for a block but not a bar (#960), and the bar and its
 * chuck build a scene in the 3D view.
 */

import { readFileSync } from 'node:fs'
import { test, expect } from './fixtures'
import { getProject, selectMachine } from './helpers'
import { roundStockCentre, type Project, type RoundStock } from '../src/types/project'

const modKey = process.platform === 'darwin' ? 'Meta' : 'Control'

/** The bundled plasma machine, read from the JSON the app ships (as #960 does). */
const QT_PLASMAC = JSON.parse(
  readFileSync(new URL('../src/engine/gcode/definitions/qtplasmac.json', import.meta.url), 'utf8'),
) as { name: string }

test('the stock switches to a round bar, is sized, and switches back', async ({ app, ui }) => {
  const page = app.page
  await ui.tree.stockRow(page).click()

  // The default project is a block: the block fields are the ones on show.
  await expect(ui.properties.exactText(page, 'Width')).toBeVisible()
  await expect(ui.properties.stockShape(page)).toBeVisible()

  await ui.properties.stockShape(page).locator('.ui-select__trigger').click()
  await ui.properties.stockShapeOption(page, 'Round bar').click()

  // A bar gains a chuck, centred on the bar's centreline; the origin follows.
  const bar = await getProject(page) as unknown as Project
  const barStock = bar.stock as RoundStock
  const chuck = bar.clamps.find((clamp) => clamp.type === 'chuck')
  expect(chuck?.name).toBe('Chuck')
  expect(chuck?.y).toBeCloseTo(roundStockCentre(barStock) - (chuck?.h ?? 0) / 2, 6)
  expect(bar.origin.y).toBeCloseTo(roundStockCentre(barStock), 6)
  await expect(ui.tree.clampRows(page).filter({ hasText: 'Chuck' })).toHaveCount(1)

  // Diameter / Length / Axis replace Width / Height / Thickness.
  await expect(ui.properties.exactText(page, 'Diameter')).toBeVisible()
  await expect(ui.properties.exactText(page, 'Length')).toBeVisible()
  await expect(ui.properties.exactText(page, 'Axis')).toBeVisible()
  await expect(ui.properties.exactText(page, 'Width')).toHaveCount(0)
  await expect(ui.properties.exactText(page, 'Height')).toHaveCount(0)
  await expect(ui.properties.exactText(page, 'Thickness')).toHaveCount(0)

  // The default stock is 4 × 3 × 0.75 in: the long side (4) becomes the length
  // along X and the thickness (0.75) the diameter.
  await expect(ui.statusBar.stockDimensions(page)).toContainText('Ø0.75 × 4')

  // A diameter edit reaches the status bar.
  const diameter = ui.properties.stockDiameter(page)
  await diameter.fill('1.5')
  await diameter.press('Enter')
  await expect(ui.statusBar.stockDimensions(page)).toContainText('Ø1.5 × 4')

  // The axis change is one undo step.
  await expect(ui.properties.stockAxis(page).locator('.ui-select__label')).toHaveText('X')
  await ui.properties.stockAxis(page).locator('.ui-select__trigger').click()
  await ui.properties.stockAxisOption(page, 'Y').click()
  await expect(ui.properties.stockAxis(page).locator('.ui-select__label')).toHaveText('Y')

  await page.keyboard.press(`${modKey}+z`)
  await expect(ui.properties.stockAxis(page).locator('.ui-select__label')).toHaveText('X')

  // Back to a block: the block fields return.
  await ui.properties.stockShape(page).locator('.ui-select__trigger').click()
  await ui.properties.stockShapeOption(page, 'Block').click()
  await expect(ui.properties.exactText(page, 'Width')).toBeVisible()
  await expect(ui.properties.exactText(page, 'Height')).toBeVisible()
  await expect(ui.properties.exactText(page, 'Thickness')).toBeVisible()
  await expect(ui.properties.exactText(page, 'Diameter')).toHaveCount(0)
  await expect(ui.properties.exactText(page, 'Axis')).toHaveCount(0)

  // A block cannot hold a chuck: it is gone with the bar.
  await expect(ui.tree.clampRows(page).filter({ hasText: 'Chuck' })).toHaveCount(0)

  // One undo brings the bar and its chuck back.
  await page.keyboard.press(`${modKey}+z`)
  await expect(ui.properties.exactText(page, 'Diameter')).toBeVisible()
  await expect(ui.properties.exactText(page, 'Axis')).toBeVisible()
  await expect(ui.tree.clampRows(page).filter({ hasText: 'Chuck' })).toHaveCount(1)
})

test('selecting the chuck shows Type and Diameter and no Z control', async ({ app, ui }) => {
  const page = app.page
  await ui.tree.stockRow(page).click()
  await ui.properties.stockShape(page).locator('.ui-select__trigger').click()
  await ui.properties.stockShapeOption(page, 'Round bar').click()

  await ui.tree.clampRows(page).filter({ hasText: 'Chuck' }).click()

  await expect(ui.properties.clampType(page)).toBeVisible()
  await expect(ui.properties.clampType(page).locator('.ui-select__label')).toHaveText('Chuck')
  await expect(ui.properties.clampDiameter(page)).toBeVisible()
  // The height is derived from the bar, so there is no Z control to set it.
  await expect(ui.properties.zRangeSlider(page)).toHaveCount(0)
})

test('plasma mode hides the Shape field', async ({ app, ui }) => {
  await selectMachine(app.page, ui, QT_PLASMAC.name)
  await ui.tree.stockRow(app.page).click()

  await expect(ui.properties.exactText(app.page, 'Width')).toBeVisible()
  await expect(ui.properties.stockShape(app.page)).toHaveCount(0)
})

test('plasma mode hides the Shape field only for a block', async ({ app, ui }) => {
  // A bar keeps the Shape field under a plasma machine, so the user can go back.
  await ui.tree.stockRow(app.page).click()
  await ui.properties.stockShape(app.page).locator('.ui-select__trigger').click()
  await ui.properties.stockShapeOption(app.page, 'Round bar').click()

  await selectMachine(app.page, ui, QT_PLASMAC.name)
  await ui.tree.stockRow(app.page).click()
  await expect(ui.properties.stockShape(app.page)).toBeVisible()

  await ui.properties.stockShape(app.page).locator('.ui-select__trigger').click()
  await ui.properties.stockShapeOption(app.page, 'Block').click()
  await expect(ui.properties.exactText(app.page, 'Width')).toBeVisible()
  await expect(ui.properties.stockShape(app.page)).toHaveCount(0)
})

// Slice D is drawing only: the bar draws as a cylinder and its chuck as a round
// fixture. No engine, format or store behaviour is asserted here. The fixture
// already fails the test on any console error, which is what a broken scene
// build (a bad geometry or a NaN transform) emits.
test('the round bar builds its scene in the 3D view', async ({ app, ui }) => {
  const page = app.page
  await ui.tree.stockRow(page).click()
  await ui.properties.stockShape(page).locator('.ui-select__trigger').click()
  await ui.properties.stockShapeOption(page, 'Round bar').click()

  const project = await getProject(page) as unknown as Project
  expect((project.stock as RoundStock).shape).toBe('round')

  await ui.viewMenu.tab3d(page).click()
  const canvas = page.locator('#workspace-panel-preview3d canvas')
  await expect(canvas).toBeVisible()
  const size = await canvas.evaluate((element) => ({
    width: element.clientWidth,
    height: element.clientHeight,
  }))
  expect(size.width).toBeGreaterThan(0)
  expect(size.height).toBeGreaterThan(0)
})
