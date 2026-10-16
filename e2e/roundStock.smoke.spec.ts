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
 * Choosing and sizing bar stock in the Properties panel (#392 slices B–D,
 * square blank #1016 C2):
 * a **rotary** project turns the block into a bar — the project type does that
 * now, and the Shape control offers the type's shapes (#1028): a round bar and,
 * since #1016 C2, a real square blank. A round bar swaps
 * Width/Height/Thickness for Diameter/Length/Axis, a bar gains a chuck the
 * store keeps centred, the square blank swaps in Side/Length/Axis instead, a
 * plasma project offers only a block (disabled control) while a bar it already
 * has stays offered, and the bar and its chuck build a scene in the 3D view.
 */

import { test, expect } from './fixtures'
import { getProject, seedProject, setProjectType } from './helpers'
import { roundStockCentre, type Project, type RoundStock, type SquareStock } from '../src/types/project'
import { squareStock } from '../src/types/barStock'

const modKey = process.platform === 'darwin' ? 'Meta' : 'Control'

test('a rotary project turns the block into a bar, which is sized, and back', async ({ app, ui }) => {
  const page = app.page
  await ui.tree.stockRow(page).click()

  // The default project is a milling block: the block fields are on show, and
  // the Shape control offers only that one shape, disabled.
  await expect(ui.properties.exactText(page, 'Width')).toBeVisible()
  await expect(ui.properties.stockShape(page)).toBeVisible()
  await expect(ui.properties.stockShape(page).locator('.ui-select__trigger')).toBeDisabled()

  // The project type is what makes a bar (issue #1028), and since #1016 C2 that
  // type offers both bar shapes: a round bar and a real square blank.
  await setProjectType(page, ui, 'Rotary')
  await ui.tree.stockRow(page).click()
  await expect(ui.properties.stockShape(page).locator('.ui-select__label')).toHaveText('Round bar')
  await expect(ui.properties.stockShape(page).locator('.ui-select__trigger')).toBeEnabled()
  // The type offers both bar shapes through this control (#1016 C2).
  await ui.properties.stockShape(page).locator('.ui-select__trigger').click()
  await expect(ui.properties.stockShapeOption(page, 'Round bar')).toBeVisible()
  await expect(ui.properties.stockShapeOption(page, 'Square blank')).toBeVisible()
  await page.keyboard.press('Escape')

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

  // Back to a block: the project type does that too (issue #1028).
  await setProjectType(page, ui, 'Milling / routing')
  await ui.tree.stockRow(page).click()
  await expect(ui.properties.exactText(page, 'Width')).toBeVisible()
  await expect(ui.properties.exactText(page, 'Height')).toBeVisible()
  await expect(ui.properties.exactText(page, 'Thickness')).toBeVisible()
  await expect(ui.properties.exactText(page, 'Diameter')).toHaveCount(0)
  await expect(ui.properties.exactText(page, 'Axis')).toHaveCount(0)

  // A block cannot hold a chuck: it is gone with the bar.
  await expect(ui.tree.clampRows(page).filter({ hasText: 'Chuck' })).toHaveCount(0)

  // One undo brings the bar and its chuck back.
  await page.keyboard.press(`${modKey}+z`)
  await ui.tree.stockRow(page).click()
  await expect(ui.properties.exactText(page, 'Diameter')).toBeVisible()
  await expect(ui.properties.exactText(page, 'Axis')).toBeVisible()
  await expect(ui.tree.clampRows(page).filter({ hasText: 'Chuck' })).toHaveCount(1)
})

test('a rotary project offers a real square blank, sized by side and axis', async ({ app, ui }) => {
  const page = app.page
  await setProjectType(page, ui, 'Rotary')
  await ui.tree.stockRow(page).click()

  // Square blank is a choice the project type offers beside the round bar.
  await ui.properties.stockShape(page).locator('.ui-select__trigger').click()
  await ui.properties.stockShapeOption(page, 'Square blank').click()
  await expect(ui.properties.stockShape(page).locator('.ui-select__label')).toHaveText('Square blank')

  // A real blank: `shape` is square and `thickness` is the physical side. The
  // default 4 × 3 × 0.75 in block turns into a 4-long bar with a 0.75 side.
  const project = await getProject(page) as unknown as Project
  const blank = project.stock as SquareStock
  expect(blank.shape).toBe('square')
  expect(blank.thickness).toBeCloseTo(0.75, 6)
  expect(blank.axis).toBe('x')

  // The status bar shows the square's own side, not a diameter.
  await expect(ui.statusBar.stockDimensions(page)).toContainText('▢0.75 × 4')

  // Side / Length / Axis replace Width / Height / Thickness and Diameter.
  await expect(ui.properties.exactText(page, 'Side')).toBeVisible()
  await expect(ui.properties.exactText(page, 'Length')).toBeVisible()
  await expect(ui.properties.exactText(page, 'Axis')).toBeVisible()
  await expect(ui.properties.exactText(page, 'Diameter')).toHaveCount(0)
  await expect(ui.properties.exactText(page, 'Width')).toHaveCount(0)
  await expect(ui.properties.exactText(page, 'Height')).toHaveCount(0)

  // A side edit reaches the status bar and leaves the length alone.
  await ui.properties.stockSide(page).fill('1')
  await ui.properties.stockSide(page).press('Enter')
  await expect(ui.statusBar.stockDimensions(page)).toContainText('▢1 × 4')
  const resized = await getProject(page) as unknown as Project
  expect((resized.stock as SquareStock).thickness).toBeCloseTo(1, 6)

  // The axis change is one undo step, exactly as for a round bar.
  await expect(ui.properties.stockAxis(page).locator('.ui-select__label')).toHaveText('X')
  await ui.properties.stockAxis(page).locator('.ui-select__trigger').click()
  await ui.properties.stockAxisOption(page, 'Y').click()
  await expect(ui.properties.stockAxis(page).locator('.ui-select__label')).toHaveText('Y')
  await page.keyboard.press(`${modKey}+z`)
  await expect(ui.properties.stockAxis(page).locator('.ui-select__label')).toHaveText('X')

  // Back to a round bar through the same control, and the round fields return.
  await ui.properties.stockShape(page).locator('.ui-select__trigger').click()
  await ui.properties.stockShapeOption(page, 'Round bar').click()
  await expect(ui.properties.exactText(page, 'Diameter')).toBeVisible()
  await expect(ui.properties.exactText(page, 'Side')).toHaveCount(0)
})

test('a square blank keeps a manual origin across a side edit and a reload', async ({ app, ui }) => {
  const page = app.page
  // Seed a square blank with the machine origin deliberately moved off its
  // default, the way the user would after placing it by hand.
  const project = await getProject(page)
  const meta = project.meta as Record<string, unknown>
  const blank = squareStock(0.75, 4, 'x')
  await seedProject(page, JSON.stringify({
    ...project,
    stock: blank,
    origin: { ...(project.origin as Record<string, unknown>), x: 1, y: 1, z: 0.5 },
    meta: { ...meta, units: 'inch', projectType: 'rotary' },
  }))

  await ui.tree.stockRow(page).click()
  await expect(ui.properties.stockShape(page).locator('.ui-select__label')).toHaveText('Square blank')

  // A side edit resizes the blank and leaves the manual origin where it was.
  await ui.properties.stockSide(page).fill('1')
  await ui.properties.stockSide(page).press('Enter')
  const edited = await getProject(page) as unknown as Project
  expect((edited.stock as SquareStock).thickness).toBeCloseTo(1, 6)
  expect(edited.origin).toMatchObject({ x: 1, y: 1, z: 0.5 })

  // One undo brings the side back without touching the origin.
  await page.keyboard.press(`${modKey}+z`)
  await expect(ui.properties.stockSide(page)).toHaveValue('0.75')
  expect((await getProject(page) as unknown as Project).origin).toMatchObject({ x: 1, y: 1, z: 0.5 })

  // A reload keeps the blank, its side and the manual origin.
  await seedProject(page, JSON.stringify(edited))
  await ui.tree.stockRow(page).click()
  await expect(ui.properties.stockShape(page).locator('.ui-select__label')).toHaveText('Square blank')
  await expect(ui.properties.stockSide(page)).toHaveValue('1')
  expect((await getProject(page) as unknown as Project).origin).toMatchObject({ x: 1, y: 1, z: 0.5 })
})

test('selecting the chuck shows Type and Diameter and no Z control', async ({ app, ui }) => {
  const page = app.page
  await setProjectType(page, ui, 'Rotary')
  await ui.tree.clampRows(page).filter({ hasText: 'Chuck' }).click()

  await expect(ui.properties.clampType(page)).toBeVisible()
  await expect(ui.properties.clampType(page).locator('.ui-select__label')).toHaveText('Chuck')
  await expect(ui.properties.clampDiameter(page)).toBeVisible()
  // The height is derived from the bar, so there is no Z control to set it.
  await expect(ui.properties.zRangeSlider(page)).toHaveCount(0)
})

test('a plasma project offers only a block, as a disabled control', async ({ app, ui }) => {
  await setProjectType(app.page, ui, 'Plasma')
  await ui.tree.stockRow(app.page).click()

  // The project is a block, so Width/Height/Thickness are the fields on show.
  await expect(ui.properties.exactText(app.page, 'Width')).toBeVisible()
  // The Shape control is always rendered now; with one shape offered it is a
  // disabled single-shape control rather than hidden (#1028).
  await expect(ui.properties.stockShape(app.page)).toBeVisible()
  await expect(ui.properties.stockShape(app.page).locator('.ui-select__label')).toHaveText('Block')
  await expect(ui.properties.stockShape(app.page).locator('.ui-select__trigger')).toBeDisabled()
})

test('a plasma project keeps offering the bar it already has', async ({ app, ui }) => {
  // Start from a round bar — a rotary project makes one — then seed the stored
  // type as plasma. The bar is not a shape plasma offers, but it stays listed
  // so the user can convert it back instead of it becoming unreachable (#1028).
  await setProjectType(app.page, ui, 'Rotary')
  const withBar = await getProject(app.page)
  const meta = withBar.meta as Record<string, unknown>
  meta.projectType = 'plasma'
  await seedProject(app.page, JSON.stringify(withBar))

  await ui.tree.stockRow(app.page).click()
  await expect(ui.properties.stockShape(app.page)).toBeVisible()
  await expect(ui.properties.stockShape(app.page).locator('.ui-select__label')).toHaveText('Round bar')
  await expect(ui.properties.stockShape(app.page).locator('.ui-select__trigger')).toBeEnabled()

  // Converting to the offered block disables the control once more.
  await ui.properties.stockShape(app.page).locator('.ui-select__trigger').click()
  await ui.properties.stockShapeOption(app.page, 'Block').click()
  await expect(ui.properties.stockShape(app.page).locator('.ui-select__label')).toHaveText('Block')
  await expect(ui.properties.stockShape(app.page).locator('.ui-select__trigger')).toBeDisabled()
})

// Slice D is drawing only: the bar draws as a cylinder and its chuck as a round
// fixture. No engine, format or store behaviour is asserted here. The fixture
// already fails the test on any console error, which is what a broken scene
// build (a bad geometry or a NaN transform) emits.
test('the round bar builds its scene in the 3D view', async ({ app, ui }) => {
  const page = app.page
  await setProjectType(page, ui, 'Rotary')

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
