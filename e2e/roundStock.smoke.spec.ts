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
 * a **rotary** project is created with its bar in the New project dialog
 * (issue #1046) — round, or the real square blank — and the Shape control then
 * offers the type's shapes (#1028). A round bar swaps Width/Height/Thickness
 * for Diameter/Length/Axis, a square blank swaps in Side/Length/Axis, a plasma
 * project offers only a block (disabled control) while a bar it already has
 * stays offered, and a bar's chuck and the bar build a scene in the 3D view.
 */

import { test, expect } from './fixtures'
import { createNewProject, getProject, seedProject, seedProjectType } from './helpers'
import {
  type Project,
  type RoundStock,
  type SquareStock,
} from '../src/types/project'
import { barCentre, barPivotZ, squareStock } from '../src/types/barStock'
import { convertLength } from '../src/utils/units'

const modKey = process.platform === 'darwin' ? 'Meta' : 'Control'

test('a rotary project is created as a bar, which is sized and re-aimed', async ({ app, ui }) => {
  const page = app.page
  // The type is chosen in the New project dialog and locked afterwards
  // (issue #1046); the blank metric rotary default is Ø 40 × 200 along X.
  await createNewProject(page, ui, { type: 'Rotary' })
  await ui.tree.stockRow(page).click()

  // The created project is a bar: the Shape control offers the type's shapes.
  await expect(ui.properties.stockShape(page)).toBeVisible()
  await expect(ui.properties.stockShape(page).locator('.ui-select__label')).toHaveText('Round bar')
  await expect(ui.properties.stockShape(page).locator('.ui-select__trigger')).toBeEnabled()
  await ui.properties.stockShape(page).locator('.ui-select__trigger').click()
  await expect(ui.properties.stockShapeOption(page, 'Round bar')).toBeVisible()
  await expect(ui.properties.stockShapeOption(page, 'Square blank')).toBeVisible()
  await page.keyboard.press('Escape')

  // Diameter / Length / Axis replace Width / Height / Thickness.
  await expect(ui.properties.exactText(page, 'Diameter')).toBeVisible()
  await expect(ui.properties.exactText(page, 'Length')).toBeVisible()
  await expect(ui.properties.exactText(page, 'Axis')).toBeVisible()
  await expect(ui.properties.exactText(page, 'Width')).toHaveCount(0)
  await expect(ui.properties.exactText(page, 'Height')).toHaveCount(0)
  await expect(ui.properties.exactText(page, 'Thickness')).toHaveCount(0)

  // The dialog's default stock is Ø 40 × 200 mm.
  await expect(ui.statusBar.stockDimensions(page)).toContainText('Ø40 × 200')

  // A diameter edit reaches the status bar.
  const diameter = ui.properties.stockDiameter(page)
  await diameter.fill('50')
  await diameter.press('Enter')
  await expect(ui.statusBar.stockDimensions(page)).toContainText('Ø50 × 200')

  // The axis change is one undo step.
  await expect(ui.properties.stockAxis(page).locator('.ui-select__label')).toHaveText('X')
  await ui.properties.stockAxis(page).locator('.ui-select__trigger').click()
  await ui.properties.stockAxisOption(page, 'Y').click()
  await expect(ui.properties.stockAxis(page).locator('.ui-select__label')).toHaveText('Y')

  await page.keyboard.press(`${modKey}+z`)
  await expect(ui.properties.stockAxis(page).locator('.ui-select__label')).toHaveText('X')
})

test('a rotary project offers a real square blank, sized by side and axis', async ({ app, ui }) => {
  const page = app.page
  await createNewProject(page, ui, { type: 'Rotary' })
  await ui.tree.stockRow(page).click()

  // Square blank is a choice the project type offers beside the round bar.
  await ui.properties.stockShape(page).locator('.ui-select__trigger').click()
  await ui.properties.stockShapeOption(page, 'Square blank').click()
  await expect(ui.properties.stockShape(page).locator('.ui-select__label')).toHaveText('Square blank')

  // A real blank: `shape` is square and `thickness` is the physical side. The
  // created Ø 40 × 200 bar relabels to a 200-long blank with a 40 side.
  const project = await getProject(page) as unknown as Project
  const blank = project.stock as SquareStock
  expect(blank.shape).toBe('square')
  expect(blank.thickness).toBeCloseTo(40, 6)
  expect(blank.axis).toBe('x')

  // The status bar shows the square's own side, not a diameter.
  await expect(ui.statusBar.stockDimensions(page)).toContainText('▢40 × 200')

  // Side / Length / Axis replace Width / Height / Thickness and Diameter.
  await expect(ui.properties.exactText(page, 'Side')).toBeVisible()
  await expect(ui.properties.exactText(page, 'Length')).toBeVisible()
  await expect(ui.properties.exactText(page, 'Axis')).toBeVisible()
  await expect(ui.properties.exactText(page, 'Diameter')).toHaveCount(0)
  await expect(ui.properties.exactText(page, 'Width')).toHaveCount(0)
  await expect(ui.properties.exactText(page, 'Height')).toHaveCount(0)

  // A side edit reaches the status bar and leaves the length alone.
  await ui.properties.stockSide(page).fill('50')
  await ui.properties.stockSide(page).press('Enter')
  await expect(ui.statusBar.stockDimensions(page)).toContainText('▢50 × 200')
  const resized = await getProject(page) as unknown as Project
  expect((resized.stock as SquareStock).thickness).toBeCloseTo(50, 6)

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

test('selecting the chuck shows Type and its diameter and no Z control', async ({ app, ui }) => {
  const page = app.page
  await createNewProject(page, ui, { type: 'Rotary' })
  await ui.tree.clampRows(page).filter({ hasText: 'Chuck' }).click()

  await expect(ui.properties.clampType(page)).toBeVisible()
  await expect(ui.properties.clampType(page).locator('.ui-select__label')).toHaveText('Chuck')
  // A chuck's diameter is its standard size (#1112 M): the Ø40 mm bar picks
  // the 5 inch body, and the label names only that size (issue #1112 R2
  // item 13) — the catalogue the preset comes from is not in the picker.
  await expect(ui.properties.chuckSize(page)).toBeVisible()
  await expect(ui.properties.chuckSize(page).locator('.ui-select__label')).toHaveText('5"')
  // The height is derived from the bar, so there is no Z control to set it.
  await expect(ui.properties.zRangeSlider(page)).toHaveCount(0)
})

test('a square blank gets the same chuck Type and Diameter as a round bar', async ({ app, ui }) => {
  const page = app.page
  // The reported repro (#1016 C2 F1): a rotary project on a square blank, with
  // the Around face — where a bar's workholding is edited — in view.
  await createNewProject(page, ui, { type: 'Rotary', shape: 'Square blank' })
  await ui.tree.stockRow(page).click()
  await expect(ui.properties.stockShape(page).locator('.ui-select__label')).toHaveText('Square blank')
  await ui.face.switchTo(page, 'Around')

  const loaded = await getProject(page) as unknown as Project
  const blank = loaded.stock as SquareStock
  expect(blank.shape).toBe('square')
  const chuckId = loaded.clamps.find((clamp) => clamp.type === 'chuck')!.id
  const side = blank.thickness
  const centre = barCentre(blank)
  const pivotZ = barPivotZ(blank)

  // The same controls a round bar shows: a Type select and a size that names
  // its diameter, and no Z control because the height follows the blank.
  await ui.tree.clampRows(page).filter({ hasText: 'Chuck' }).click()
  await expect(ui.properties.clampType(page)).toBeVisible()
  await expect(ui.properties.clampType(page).locator('.ui-select__label')).toHaveText('Chuck')
  await expect(ui.properties.chuckSize(page)).toBeVisible()
  // A 40 mm square's corner circle needs the 6 inch body.
  await expect(ui.properties.chuckSize(page).locator('.ui-select__label')).toHaveText('6"')
  await expect(ui.properties.zRangeSlider(page)).toHaveCount(0)

  // A plain clamp gives up the chuck size, and choosing Chuck mints one sized
  // for the square blank: its diameter clears the corner envelope, and it sits
  // at the blank's true pivot.
  await ui.properties.clampType(page).locator('.ui-select__trigger').click()
  await ui.properties.clampTypeOption(page, 'Clamp').click()
  await expect(ui.properties.clampDiameter(page)).toHaveCount(0)
  await expect(ui.properties.chuckSize(page)).toHaveCount(0)
  await expect(ui.properties.zRangeSlider(page)).toHaveCount(1)
  await ui.properties.clampType(page).locator('.ui-select__trigger').click()
  await ui.properties.clampTypeOption(page, 'Chuck').click()

  const minted = ((await getProject(page)) as unknown as Project).clamps.find((clamp) => clamp.id === chuckId)!
  expect(minted.type).toBe('chuck')
  const mintedDiameter = blank.axis === 'x' ? minted.h : minted.w
  expect(mintedDiameter).toBeGreaterThanOrEqual(side * Math.SQRT2)
  expect(blank.axis === 'x' ? minted.y : minted.x).toBeCloseTo(centre - mintedDiameter / 2, 6)
  expect(minted.height).toBeCloseTo(pivotZ + mintedDiameter / 2, 6)

  // Picking a larger standard size changes the diameter, recentres the chuck
  // on the pivot and derives its height — exactly the round bar's rule, using
  // the square's own pivot.
  await ui.properties.chuckSize(page).locator('.ui-select__trigger').click()
  await ui.properties.chuckSizeOption(page, '12"').click()
  const editedDiameter = convertLength(12.4, 'inch', 'mm')
  const edited = ((await getProject(page)) as unknown as Project).clamps.find((clamp) => clamp.id === chuckId)!
  expect(blank.axis === 'x' ? edited.h : edited.w).toBeCloseTo(editedDiameter, 6)
  expect(blank.axis === 'x' ? edited.y : edited.x).toBeCloseTo(centre - editedDiameter / 2, 6)
  expect(edited.height).toBeCloseTo(pivotZ + editedDiameter / 2, 6)
  await expect(ui.properties.chuckSize(page).locator('.ui-select__label')).toHaveText('12"')
  await expect(ui.properties.clampType(page).locator('.ui-select__label')).toHaveText('Chuck')
})

test('a plasma project offers only a block, as a disabled control', async ({ app, ui }) => {
  await createNewProject(app.page, ui, { type: 'Plasma' })
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
  await createNewProject(app.page, ui, { type: 'Rotary' })
  await seedProjectType(app.page, 'plasma')

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
  await createNewProject(page, ui, { type: 'Rotary' })

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
