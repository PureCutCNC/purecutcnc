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
 * Top / Bottom faces in the workspace (issue #945): the face switch, drawing
 * on Bottom with the same Z range control Top uses, the ghost of the other
 * face, and the explicit change of a feature's authoring face.
 */

import type { DimensionAnnotation } from '../src/types/project'
import { seedConstructionReferences, referenceCanvasPoint, pickReference, referenceSnapshot, referenceSnapIndicator } from './constructionReferences.helpers'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import {
  clickMenuItem,
  completePendingMove,
  enterSketchEdit,
  getHoveredFeatureId,
  getPendingMove,
  getProject,
  openRowContextMenu,
  seedProject,
  placePendingAddAt,
  setPendingAddAnchor,
  startAddRectPlacement,
  cancelPendingAdd,
} from './helpers'

interface SavedFeature {
  id: string
  name: string
  definitionId: string
  authoringFace: 'top' | 'bottom'
  z_top: number
  z_bottom: number
  transform: { a: number; b: number; c: number; d: number; e: number; f: number }
}

interface SavedSetup { id: string; orientation: { axis: string; angleDeg: number } }

/** A saved project without the timestamp every save renews. */
function withoutModified(project: Record<string, unknown>): Record<string, unknown> {
  const { modified: _modified, ...meta } = project.meta as Record<string, unknown>
  void _modified
  return { ...project, meta }
}

function featureRow(page: Page, id: string) {
  return page.locator(`.tree-row--feature[data-feature-id="${id}"]`)
}

async function features(page: Page): Promise<SavedFeature[]> {
  return (await getProject(page)).features as SavedFeature[]
}

/** Draw a rectangle through the store, in stock coordinates (the default stock is 4 × 3 in). */
async function drawRect(page: Page, x1: number, y1: number, x2: number, y2: number): Promise<void> {
  await startAddRectPlacement(page)
  await setPendingAddAnchor(page, x1, y1)
  await placePendingAddAt(page, x2, y2)
  await cancelPendingAdd(page)
}

/**
 * Z and face rows are per-instance: they sit on the properties panel's
 * Instance tab. It stays open across selections, and a second click closes it.
 */
async function openInstanceProperties(page: Page): Promise<void> {
  await page.locator('.properties-panel').getByRole('button', { name: 'Instance', exact: true }).click()
}

async function canvasCentre(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.locator('.sketch-canvas').boundingBox()
  expect(box).not.toBeNull()
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }
}

async function canvasImage(page: Page): Promise<string> {
  return page.locator('.sketch-canvas').evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL())
}

test('a Top-only project shows the face switch and nothing else about faces', async ({ app, ui }) => {
  const { page } = app
  await drawRect(page, 1, 1, 3, 2)

  await expect(ui.face.segment(page, 'Top')).toHaveAttribute('aria-pressed', 'true')
  await expect(ui.face.segment(page, 'Bottom')).toHaveAttribute('aria-pressed', 'false')
  await expect(ui.face.otherSideToggle(page)).toHaveCount(0)
  await expect(ui.face.banner(page)).toHaveCount(0)
  await expect(ui.face.layer(page, 'top')).toHaveCount(0)
  await expect(page.locator('.face-chip')).toHaveCount(0)
  await page.locator('.tree-row--feature').first().click()
  await openInstanceProperties(page)
  await expect(page.locator('.properties-panel .z-range-slider')).toBeVisible()
  await expect(page.locator('.properties-panel .face-row')).toHaveCount(0)
  await expect(ui.face.zRange(page)).toHaveCount(0)
})

test('switching to Bottom, drawing a pocket and setting its Z range the way Top does', async ({ app, ui }) => {
  const { page } = app
  // A base covering the middle of the stock, so the canvas centre is on it in both views.
  await drawRect(page, 1, 1, 3, 2)
  const [base] = await features(page)
  expect(base.authoringFace).toBe('top')

  await ui.face.segment(page, 'Bottom').click()
  await expect(ui.face.segment(page, 'Bottom')).toHaveAttribute('aria-pressed', 'true')
  await expect(ui.face.banner(page)).toContainText('Stock flipped about X')
  await expect(ui.face.banner(page)).toContainText('Drawing on bottom face')
  await expect(ui.face.layer(page, 'bottom')).toHaveAttribute('data-face-state', 'active')
  await expect(ui.face.layer(page, 'top')).toHaveAttribute('data-face-state', 'ghost')
  await expect(ui.face.ghostRows(page)).toHaveCount(1)

  // Looking at Bottom has not given the project a setup yet.
  expect((await getProject(page)).setups as SavedSetup[]).toHaveLength(1)

  // Draw the pocket on Bottom, away from the centre: the first Bottom content
  // is what makes the Bottom setup real.
  await drawRect(page, 0.2, 0.2, 0.9, 0.9)
  const pocket = (await features(page))[1]
  expect(pocket.authoringFace).toBe('bottom')
  const saved = await getProject(page)
  const setups = saved.setups as SavedSetup[]
  expect(setups).toHaveLength(2)
  expect(setups[1].orientation).toEqual({ axis: 'x', angleDeg: 180 })
  expect(saved.activeSetupId).toBe(setups[1].id)
  await expect(page.locator('.tree-row--feature.tree-row--selected')).toHaveCount(1)

  // The Z range is the control Top uses, read with the stock flipped: a new
  // pocket runs the full height, 0.75 → 0, just as it would on Top.
  await openInstanceProperties(page)
  const zTop = ui.face.zField(page, 'top')
  const zBottom = ui.face.zField(page, 'bottom')
  await expect(ui.face.zRange(page).locator('.z-range-slider')).toBeVisible()
  await expect(zTop).toHaveValue('0.75')
  await expect(zBottom).toHaveValue('0')

  // Z bottom 0.5 is a pocket 0.25 deep from the face in front of you — on
  // Bottom that is the stock span 0.25 → 0, shown read-only beneath.
  await zBottom.fill('0.5')
  await zBottom.press('Enter')
  await expect(ui.face.stockSpan(page)).toHaveText('0.25 → 0 in')
  const dimensioned = (await features(page))[1]
  expect(dimensioned.z_bottom).toBe(0)
  expect(dimensioned.z_top).toBe(0.25)

  // A top below the bottom is refused: nothing is swapped, the span stays.
  await zTop.fill('0.4')
  await zTop.press('Enter')
  await expect(zTop).toHaveValue('0.75')
  await expect(ui.face.stockSpan(page)).toHaveText('0.25 → 0 in')
  const refused = (await features(page))[1]
  expect([refused.z_bottom, refused.z_top]).toEqual([0, 0.25])

  // A floating pocket keeps both ends.
  await zTop.fill('0.65')
  await zTop.press('Enter')
  await expect(ui.face.stockSpan(page)).toHaveText('0.25 → 0.1 in')
  const floating = (await features(page))[1]
  expect([floating.z_bottom, floating.z_top]).toEqual([0.1, 0.25])

  // Back on Top the same feature is the ghost and the base is editable again.
  await ui.face.segment(page, 'Top').click()
  await expect(ui.face.banner(page)).not.toContainText('Stock flipped')
  await expect(ui.face.layer(page, 'top')).toHaveAttribute('data-face-state', 'active')
  await expect(ui.face.layer(page, 'bottom')).toHaveAttribute('data-face-state', 'ghost')
  await expect(ui.face.ghostRows(page)).toHaveCount(1)
  await expect(ui.face.ghostRows(page)).toHaveAttribute('data-feature-id', pocket.id)
})

// The review's finding 5: the first switch to Bottom used to add the Bottom
// setup, which dirtied a clean project and left an undo entry.
test('looking at Bottom leaves a clean project untouched until something is drawn there', async ({ app, ui }) => {
  const { page } = app
  const undo = page.getByRole('button', { name: 'Undo', exact: true }).first()
  const cleanSave = page.getByRole('button', { name: 'Save project', exact: true }).first()
  const before = withoutModified(await getProject(page))
  await expect(undo).toBeDisabled()
  await expect(cleanSave).toBeVisible()

  await ui.face.segment(page, 'Bottom').click()
  await expect(ui.face.segment(page, 'Bottom')).toHaveAttribute('aria-pressed', 'true')
  await expect(ui.face.banner(page)).toContainText('Stock flipped about X')
  await expect(undo).toBeDisabled()
  await expect(cleanSave).toBeVisible()
  expect(withoutModified(await getProject(page))).toEqual(before)

  await ui.face.segment(page, 'Top').click()
  await expect(ui.face.banner(page)).toHaveCount(0)
  await expect(ui.face.otherSideToggle(page)).toHaveCount(0)
  await expect(undo).toBeDisabled()
  await expect(cleanSave).toBeVisible()
  expect(withoutModified(await getProject(page))).toEqual(before)

  // The first feature drawn on Bottom brings the setup with it, as one edit.
  await ui.face.segment(page, 'Bottom').click()
  await drawRect(page, 0.2, 0.2, 0.9, 0.9)
  const drawn = await getProject(page)
  const setups = drawn.setups as SavedSetup[]
  expect(setups).toHaveLength(2)
  expect(setups[1].orientation).toEqual({ axis: 'x', angleDeg: 180 })
  expect(drawn.activeSetupId).toBe(setups[1].id)
  expect((drawn.features as SavedFeature[])[0].authoringFace).toBe('bottom')
  await expect(page.getByRole('button', { name: 'Save project with unsaved changes', exact: true }).first()).toBeVisible()

  // One undo takes the feature and the setup away, and the view stays on Bottom.
  await undo.click()
  const undone = await getProject(page)
  expect(undone.features as unknown[]).toHaveLength(0)
  expect(undone.setups as unknown[]).toHaveLength(1)
  await expect(undo).toBeDisabled()
  await expect(ui.face.segment(page, 'Bottom')).toHaveAttribute('aria-pressed', 'true')
  await expect(ui.face.banner(page)).toContainText('Stock flipped about X')
})

// The review's finding 1: the header switch was disabled during a move, but a
// ghost row's menu still switched face, and the move then landed on a ghost.
test('a ghost row cannot switch or change a face while a move is in progress', async ({ app, ui }) => {
  const { page } = app
  await drawRect(page, 1, 1, 3, 2)
  await ui.face.segment(page, 'Bottom').click()
  await drawRect(page, 0.2, 0.2, 0.9, 0.9)
  const [base, pocket] = await features(page)

  await (await openRowContextMenu(page, featureRow(page, pocket.id))).getByRole('button', { name: 'Move', exact: true }).click()
  expect((await getPendingMove(page))?.entityIds).toEqual([pocket.id])
  await expect(ui.face.segment(page, 'Top')).toBeDisabled()

  await ui.face.ghostRows(page).click({ button: 'right' })
  await expect(page.getByRole('button', { name: 'Switch to top face to edit' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Change authoring face…' })).toBeDisabled()
  expect((await getPendingMove(page))?.entityIds).toEqual([pocket.id])

  // The move finishes on the feature it started on; the ghost is untouched.
  await completePendingMove(page, 0.2, 0.1)
  const [baseAfter, pocketAfter] = await features(page)
  expect(baseAfter).toEqual(base)
  expect(pocketAfter.authoringFace).toBe('bottom')
  expect(pocketAfter.transform).not.toEqual(pocket.transform)
  await expect(ui.face.segment(page, 'Bottom')).toHaveAttribute('aria-pressed', 'true')
  await expect(ui.face.segment(page, 'Top')).toBeEnabled()
})

// Second review: the face could be switched half-way through drawing a shape,
// which left an outline picked in two views.
test('the face is held once a shape has a point on the canvas', async ({ app, ui }) => {
  const { page } = app
  await startAddRectPlacement(page)
  // An armed tool belongs to no face yet.
  await expect(ui.face.segment(page, 'Bottom')).toBeEnabled()
  await setPendingAddAnchor(page, 1, 1)
  await expect(ui.face.segment(page, 'Bottom')).toBeDisabled()
  await expect(ui.face.segment(page, 'Bottom')).toHaveAttribute('title', 'Finish the current edit before switching face')
  await placePendingAddAt(page, 3, 2)
  await cancelPendingAdd(page)
  await expect(ui.face.segment(page, 'Bottom')).toBeEnabled()
  expect((await features(page))[0].authoringFace).toBe('top')
})

// The review's finding 6, as decided: a linked copy stays linked on the other
// face, and the UI says how many copies there share the shape.
test('a shape shared with linked copies on the other face says so where it is moved and edited', async ({ app, ui }) => {
  const { page } = app
  await drawRect(page, 0.5, 0.5, 1.5, 1.2)
  const [plate] = await features(page)
  await clickMenuItem(await openRowContextMenu(page, featureRow(page, plate.id)), 'Copy')
  await completePendingMove(page, 2, 0)
  const copy = (await features(page))[1]
  expect(copy.definitionId).toBe(plate.definitionId)

  // From Bottom both are ghosts. Moving one across names the copy that stays.
  await ui.face.segment(page, 'Bottom').click()
  await featureRow(page, copy.id).click({ button: 'right' })
  await page.getByRole('button', { name: 'Change authoring face…' }).click()
  const dialog = ui.face.changeFaceDialog(page)
  await expect(dialog.getByTestId('change-face-linked')).toContainText('1 linked copy stays on the top face')
  await dialog.getByRole('button', { name: 'Move to bottom face' }).click()
  await expect(dialog).toHaveCount(0)
  const moved = (await features(page))[1]
  expect(moved.authoringFace).toBe('bottom')
  expect(moved.definitionId).toBe(plate.definitionId)
  // A feature moved to Bottom is Bottom content: the setup is real now.
  expect((await getProject(page)).setups as SavedSetup[]).toHaveLength(2)

  // Where the shape is edited, it says the copy on the other face changes
  // too: in the Shape properties, and in the sketch-edit panel.
  await featureRow(page, copy.id).click()
  await page.locator('.properties-panel').getByRole('button', { name: /^Shape/ }).click()
  await expect(page.getByTestId('linked-other-face-note')).toContainText('1 linked copy on the top face')
  await enterSketchEdit(page, copy.id)
  await expect(page.getByTestId('edit-linked-other-face-note')).toContainText('1 linked copy on the top face')
  await page.locator('.canvas-workflow-panel--edit').getByRole('button', { name: 'Cancel editing', exact: true }).click()
  await expect(page.locator('.canvas-workflow-panel--edit')).toHaveCount(0)
  await ui.face.segment(page, 'Top').click()
  await featureRow(page, plate.id).click()
  await expect(page.getByTestId('linked-other-face-note')).toContainText('1 linked copy on the bottom face')

  // With every copy on one face there is nothing to say.
  await featureRow(page, plate.id).click({ button: 'right' })
  await page.getByRole('button', { name: 'Change authoring face…' }).click()
  await expect(ui.face.changeFaceDialog(page)).toBeVisible()
  await expect(ui.face.changeFaceDialog(page).getByTestId('change-face-linked')).toHaveCount(0)
  await ui.face.changeFaceDialog(page).getByRole('button', { name: 'Cancel' }).click()
})

test('the ghost toggle hides and shows the other side, and a ghost cannot be picked or dragged', async ({ app, ui }) => {
  const { page } = app
  await drawRect(page, 1, 1, 3, 2)
  const centre = await canvasCentre(page)

  // Control: on Top the base is under the canvas centre and a click selects it.
  await page.mouse.click(centre.x, centre.y)
  await expect(page.locator('.tree-row--feature.tree-row--selected')).toHaveCount(1)

  await ui.face.segment(page, 'Bottom').click()
  await expect(page.locator('.tree-row--feature.tree-row--selected')).toHaveCount(0)
  const before = await features(page)

  // Hover, click and drag where the ghost is drawn: nothing is picked or moved.
  await page.mouse.move(centre.x, centre.y)
  expect(await getHoveredFeatureId(page)).toBeNull()
  await page.mouse.click(centre.x, centre.y)
  await expect(page.locator('.tree-row--feature.tree-row--selected')).toHaveCount(0)
  await page.mouse.move(centre.x, centre.y)
  await page.mouse.down()
  await page.mouse.move(centre.x + 60, centre.y + 40, { steps: 6 })
  await page.mouse.up()
  expect(await features(page)).toEqual(before)
  await expect(page.locator('.tree-row--feature.tree-row--selected')).toHaveCount(0)

  // The ghost row offers no selection either.
  await ui.face.ghostRows(page).click()
  await expect(page.locator('.tree-row--feature.tree-row--selected')).toHaveCount(0)

  // The toggle changes what the canvas draws, both ways, and nothing else.
  const toggle = ui.face.otherSideToggle(page)
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await page.mouse.move(centre.x, centre.y - 300)
  const shown = await canvasImage(page)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(() => canvasImage(page)).not.toBe(shown)
  await expect(ui.face.ghostRows(page)).toHaveCount(1)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => canvasImage(page)).toBe(shown)
  expect(await features(page)).toEqual(before)
})

test('a ghost row leads to its own face, and changing a face is confirmed and keeps the stock span', async ({ app, ui }) => {
  const { page } = app
  await drawRect(page, 1, 1, 3, 2)
  await ui.face.segment(page, 'Bottom').click()
  await drawRect(page, 0.2, 0.2, 0.9, 0.9)
  const pocket = (await features(page))[1]
  await openInstanceProperties(page)
  const zBottom = ui.face.zField(page, 'bottom')
  await zBottom.fill('0.5')
  await zBottom.press('Enter')
  await expect(ui.face.stockSpan(page)).toHaveText('0.25 → 0 in')

  // From Top, the Bottom pocket's row menu switches the workspace to its face.
  await ui.face.segment(page, 'Top').click()
  await ui.face.ghostRows(page).click({ button: 'right' })
  await page.getByRole('button', { name: 'Switch to bottom face to edit' }).click()
  await expect(ui.face.segment(page, 'Bottom')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator(`.tree-row--feature.tree-row--selected[data-feature-id="${pocket.id}"]`)).toHaveCount(1)

  // Changing the authoring face opens a confirmation; cancelling changes nothing.
  await page.locator('.properties-panel .face-row').getByRole('button', { name: 'Change…' }).click()
  const dialog = ui.face.changeFaceDialog(page)
  await expect(dialog).toBeVisible()
  // On Bottom it reads 0.75 → 0.5 (stock flipped); on Top it will read its stored span.
  await expect(dialog.getByTestId('change-face-z-now')).toHaveText('0.75 → 0.5')
  await expect(dialog.getByTestId('change-face-z-after')).toHaveText('0.25 → 0')
  await expect(dialog.getByTestId('change-face-span-now')).toHaveText('0.25 → 0')
  await expect(dialog.getByTestId('change-face-span-after')).toHaveText('0.25 → 0')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  expect((await features(page))[1].authoringFace).toBe('bottom')

  await page.locator('.properties-panel .face-row').getByRole('button', { name: 'Change…' }).click()
  await ui.face.changeFaceDialog(page).getByRole('button', { name: 'Move to top face' }).click()
  await expect(ui.face.changeFaceDialog(page)).toHaveCount(0)
  const moved = (await features(page))[1]
  expect(moved.authoringFace).toBe('top')
  expect([moved.z_bottom, moved.z_top]).toEqual([0, 0.25])
  // It is now a ghost on Bottom, and no longer selected.
  await expect(page.locator('.tree-row--feature.tree-row--selected')).toHaveCount(0)
  await expect(ui.face.ghostRows(page)).toHaveCount(2)
})

test('the face switch is reachable and operable from the keyboard', async ({ app, ui }) => {
  const { page } = app
  await page.getByRole('tab', { name: 'Sketch', exact: true }).focus()
  await page.keyboard.press('Tab')
  await expect(ui.face.segment(page, 'Top')).toBeFocused()
  await page.keyboard.press('Tab')
  const bottom = ui.face.segment(page, 'Bottom')
  await expect(bottom).toBeFocused()
  // Keyboard focus is visible on the control itself.
  expect(await bottom.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe('none')

  await page.keyboard.press('Space')
  await expect(bottom).toHaveAttribute('aria-pressed', 'true')
  await expect(bottom).toBeFocused()
  await expect(ui.face.banner(page)).toContainText('Stock flipped about X')

  // The ghost toggle appears next in the tab order once both faces exist.
  await page.keyboard.press('Tab')
  await expect(ui.face.otherSideToggle(page)).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(ui.face.otherSideToggle(page)).toHaveAttribute('aria-pressed', 'false')
})

test('angle fields on Bottom read and turn as they do on Top', async ({ app, ui }) => {
  const { page } = app
  // A backdrop gives the properties panel an Angle field; 90 is its unrotated value.
  const saved = await getProject(page)
  await seedProject(page, JSON.stringify({
    ...saved,
    backdrop: {
      name: 'Backdrop',
      mimeType: 'image/png',
      imageDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      intrinsicWidth: 1,
      intrinsicHeight: 1,
      center: { x: 2, y: 1.5 },
      width: 2,
      height: 1,
      orientationAngle: 90,
      opacity: 0.5,
      visible: true,
    },
  }))
  const angle = page.locator('.properties-panel .properties-field').filter({ hasText: 'Angle' }).locator('input')
  await page.locator('.tree-row--backdrop').click()
  await expect(angle).toHaveValue('90')

  // Flipped about X the backdrop points the other way up; the field says so,
  // and a typed angle is stored back in stock space.
  await ui.face.segment(page, 'Bottom').click()
  await page.locator('.tree-row--backdrop').click()
  await expect(angle).toHaveValue('-90')
  await angle.fill('-80')
  await angle.press('Enter')
  await expect.poll(async () => ((await getProject(page)).backdrop as { orientationAngle: number }).orientationAngle).toBe(80)
  await expect(angle).toHaveValue('-80')
  await ui.face.segment(page, 'Top').click()
  await page.locator('.tree-row--backdrop').click()
  await expect(angle).toHaveValue('80')

  // A radial sweep: positive in its field on Bottom, as on Top, and it stays
  // what was typed (the stored value is the reversed stock-space turn).
  await ui.face.segment(page, 'Bottom').click()
  await drawRect(page, 0.4, 0.4, 0.9, 0.9)
  await page.getByRole('button', { name: 'Distribute selected features', exact: true }).first().click()
  await page.getByRole('menu').getByRole('button', { name: 'Radial', exact: true }).click()
  const sweep = page.locator('.canvas-workflow-panel--feature-distribution').getByLabel('Sweep')
  await expect(sweep).toHaveValue('360')
  await sweep.fill('90')
  await expect(sweep).toHaveValue('90')
  await page.keyboard.press('Escape')
})

test('grid spacing on Bottom steps the way it does on Top', async ({ app, ui }) => {
  const { page } = app
  /** Where a feature's first point sits in the stock. */
  const placed = async (index: number) => {
    const project = await getProject(page)
    const feature = (project.features as SavedFeature[])[index]
    const definitions = project.featureDefinitions as Record<string, { profile: { start: { x: number; y: number } } }>
    const { start } = definitions[feature.definitionId].profile
    const { a, b, c, d, e, f } = feature.transform
    return { x: a * start.x + c * start.y + e, y: b * start.x + d * start.y + f }
  }
  const grid = async () => {
    await page.getByRole('button', { name: 'Distribute selected features', exact: true }).first().click()
    await page.getByRole('menu').getByRole('button', { name: 'Grid', exact: true }).click()
    return page.locator('.canvas-workflow-panel--feature-distribution')
  }

  // Top, as the control: one row up by a typed 0.5 is +0.5 in the stock.
  await drawRect(page, 0.4, 1.4, 0.8, 1.8)
  let panel = await grid()
  await panel.getByLabel('Rows').fill('2')
  await panel.getByLabel('Columns').fill('1')
  await panel.getByLabel('Y spacing').fill('0.5')
  await panel.getByRole('button', { name: 'Create copies', exact: true }).click()
  expect((await placed(1)).y - (await placed(0)).y).toBeCloseTo(0.5, 9)

  // Bottom, flipped about X: the field reads a positive default, and the same
  // typed 0.5 steps the same way on screen, which is −0.5 in the stock.
  await ui.face.segment(page, 'Bottom').click()
  await drawRect(page, 2.4, 1.4, 2.8, 1.8)
  panel = await grid()
  const spacingY = panel.getByLabel('Y spacing')
  await expect(spacingY).not.toHaveValue(/^-/)
  await expect(panel.getByLabel('X spacing')).not.toHaveValue(/^-/)
  await panel.getByLabel('Rows').fill('2')
  await panel.getByLabel('Columns').fill('1')
  await spacingY.fill('0.5')
  await expect(spacingY).toHaveValue('0.5')
  await panel.getByRole('button', { name: 'Create copies', exact: true }).click()
  const source = await placed(2)
  const copy = await placed(3)
  expect(copy.y - source.y).toBeCloseTo(-0.5, 9)
  expect(copy.x - source.x).toBeCloseTo(0, 9)
})

test('a 3D view parked on the Top or Bottom preset follows the face; other views stay put', async ({ app, ui }) => {
  const { page } = app
  await drawRect(page, 1, 1, 3, 2)
  await ui.viewMenu.tab3d(page).click()
  const checked = async (label: string) => {
    await ui.viewMenu.trigger3d(page).click()
    const value = await ui.viewMenu.option3d(page, label).getAttribute('aria-checked')
    await page.keyboard.press('Escape')
    return value
  }

  // The default isometric view is left where it is.
  await ui.face.segment(page, 'Bottom').click()
  expect(await checked('Isometric view')).toBe('true')
  await ui.face.segment(page, 'Top').click()

  // A plan view turns over with the stock.
  await ui.viewMenu.trigger3d(page).click()
  await ui.viewMenu.option3d(page, 'Top view').click()
  await ui.face.segment(page, 'Bottom').click()
  expect(await checked('Bottom view')).toBe('true')
  await ui.face.segment(page, 'Top').click()
  expect(await checked('Top view')).toBe('true')
})

test.describe('landscape tablet', () => {
  test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true })

  test('the face controls keep full tap targets and do not widen the shell', async ({ app, ui }) => {
    const { page } = app
    // The switch must not push the layout wider than the screen, and on an
    // empty project the first-run overlay must not cover it.
    const canvasWidth = async () => (await page.locator('.sketch-canvas').boundingBox())!.width
    expect(await canvasWidth()).toBeLessThanOrEqual(1024)
    await expect(page.locator('.empty-state-overlay')).toBeVisible()
    await ui.face.segment(page, 'Bottom').tap()
    await expect(ui.face.segment(page, 'Bottom')).toHaveAttribute('aria-pressed', 'true')

    for (const control of [ui.face.segment(page, 'Top'), ui.face.segment(page, 'Bottom'), ui.face.otherSideToggle(page)]) {
      const box = await control.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.height).toBeGreaterThanOrEqual(44)
      expect(box!.width).toBeGreaterThanOrEqual(44)
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(1024)
    }

    expect(await canvasWidth()).toBeLessThanOrEqual(1024)
    await expect(ui.face.banner(page)).toContainText('Stock flipped about X')

    await ui.face.otherSideToggle(page).tap()
    await expect(ui.face.otherSideToggle(page)).toHaveAttribute('aria-pressed', 'false')
    await ui.face.segment(page, 'Top').tap()
    await expect(ui.face.segment(page, 'Top')).toHaveAttribute('aria-pressed', 'true')
  })
})

for (const face of ['top', 'bottom'] as const) {
  for (const axis of ['x', 'y'] as const) {
    test(`#994 ${face}/${axis}: reference point preview and capture keep construction read-only`, async ({ app, ui }) => {
      const { page } = app
      const options = { face, axis }
      await seedConstructionReferences(page, options)
      const canvas = page.locator('canvas.sketch-canvas')
      const before = withoutModified(await getProject(page))
      const guideBefore = referenceSnapshot(before)
      // Normal click, double-click, row click and Delete cannot enter foreign editing.
      await pickReference(canvas, options, 20, 15)
      await canvas.dblclick({ position: await referenceCanvasPoint(canvas, options, 20, 15) })
      await featureRow(page, 'reference-guide').click()
      await page.keyboard.press('Delete')
      await expect(featureRow(page, 'reference-guide')).not.toHaveClass(/tree-row--selected/)
      await expect(page.locator('.canvas-workflow-panel--edit')).toHaveCount(0)
      expect(withoutModified(await getProject(page))).toEqual(before)
      await startAddRectPlacement(page)
      const nearCorner = await referenceCanvasPoint(canvas, options, 20.3, 15.2)
      await canvas.hover({ position: nearCorner })
      await expect(referenceSnapIndicator(page)).toHaveCount(1)
      await ui.face.otherSideToggle(page).click()
      await canvas.hover({ position: nearCorner })
      await expect(referenceSnapIndicator(page)).toHaveCount(0)
      await ui.face.otherSideToggle(page).click()
      await canvas.hover({ position: nearCorner })
      await expect(referenceSnapIndicator(page)).toHaveCount(1)
      await canvas.click({ position: nearCorner })
      expect(withoutModified(await getProject(page))).toEqual(before)
      await cancelPendingAdd(page)
      expect(withoutModified(await getProject(page))).toEqual(before)
      await startAddRectPlacement(page)
      await canvas.click({ position: nearCorner })
      await pickReference(canvas, options, 50, 25)
      await cancelPendingAdd(page)
      const after = await getProject(page)
      expect(referenceSnapshot(after)).toEqual(guideBefore)
      const rows = after.features as Array<{ id: string; definitionId: string; authoringFace: string }>
      const created = rows.find(row => !['reference-source', 'reference-guide', 'reference-cutter', 'reference-subject', 'reference-run'].includes(row.id))!
      expect(created.authoringFace).toBe(face)
      const definitions = after.featureDefinitions as Record<string, { profile: { start: { x: number; y: number } } }>
      // New definitions are local; resolve the saved instance to check the actual stock point.
      const saved = rows.find(row => row.id === created.id) as typeof created & { transform: { a: number; b: number; c: number; d: number; e: number; f: number } }
      const { start } = definitions[created.definitionId].profile
      const m = saved.transform
      expect(m.a * start.x + m.c * start.y + m.e).toBeCloseTo(20, 7)
      expect(m.b * start.x + m.d * start.y + m.f).toBeCloseTo(15, 7)
      expect(definitions[created.definitionId]).toBeDefined()
      await page.getByRole('button', { name: 'Undo', exact: true }).first().click()
      expect(withoutModified(await getProject(page))).toEqual(before)
    })
  }
}

for (const variant of [{ hidden: true }, { role: 'line' as const }]) {
  test(`#994 hidden/nonconstruction reference cannot snap ${JSON.stringify(variant)}`, async ({ app }) => {
    const options = { face: 'bottom' as const, axis: 'y' as const, ...variant }
    await seedConstructionReferences(app.page, options)
    await startAddRectPlacement(app.page)
    const canvas = app.page.locator('canvas.sketch-canvas')
    await canvas.hover({ position: await referenceCanvasPoint(canvas, options, 20.3, 15.2) })
    await expect(referenceSnapIndicator(app.page)).toHaveCount(0)
    const before = withoutModified(await getProject(app.page))
    await pickReference(canvas, options, 20.3, 15.2)
    await cancelPendingAdd(app.page)
    expect(withoutModified(await getProject(app.page))).toEqual(before)
  })
}

test('#994 a cross-face anchored dimension stays a measurement and construction remains an invalid CAM target', async ({ app, ui }) => {
  const options = { face: 'bottom' as const, axis: 'x' as const, locked: false }
  await seedConstructionReferences(app.page, options)
  const canvas = app.page.locator('canvas.sketch-canvas')
  const before = referenceSnapshot(await getProject(app.page))
  await app.page.getByRole('button', { name: 'Add dimension', exact: true }).first().click()
  await app.page.getByRole('button', { name: 'Horizontal dimension', exact: true }).click()
  await pickReference(canvas, options, 20, 15)
  await pickReference(canvas, options, 50, 15)
  await pickReference(canvas, options, 35, 8)
  const project = await getProject(app.page)
  const annotations = project.annotations as DimensionAnnotation[]
  expect(annotations).toHaveLength(1)
  expect(annotations[0].a).toMatchObject({ kind: 'vertex', target: { source: 'feature', featureId: 'reference-guide' } })
  expect(annotations[0].b).toMatchObject({ kind: 'vertex', target: { source: 'feature', featureId: 'reference-guide' } })
  await pickReference(canvas, options, 35, 8)
  await expect(app.page.locator('.canvas-workflow-panel--driving-edit')).toHaveCount(0)
  expect(referenceSnapshot(await getProject(app.page))).toEqual(before)
  await ui.face.segment(app.page, 'Top').click()
  await featureRow(app.page, 'reference-guide').click()
  await app.page.getByRole('button', { name: 'Add to Top', exact: true }).click()
  await expect(ui.operations.addMenuAvailableRows(app.page)).toHaveCount(0)
  await ui.operations.addMenuUnavailableToggle(app.page).click()
  const addButtons = ui.operations.addMenuUnavailableRows(app.page).getByRole('button', { name: 'Add', exact: true })
  expect(await addButtons.count()).toBeGreaterThan(0)
  for (const button of await addButtons.all()) await expect(button).toBeDisabled()
})

test('#994 a foreign construction point cannot become a fixed-distance constraint reference', async ({ app }) => {
  const options = { face: 'bottom' as const, axis: 'y' as const }
  await seedConstructionReferences(app.page, options)
  const before = withoutModified(await getProject(app.page))
  const menu = await openRowContextMenu(app.page, featureRow(app.page, 'reference-source'))
  await menu.getByRole('button', { name: 'Add constraint', exact: true }).click()
  const canvas = app.page.locator('canvas.sketch-canvas')
  await pickReference(canvas, options, 80, 40)
  await canvas.hover({ position: await referenceCanvasPoint(canvas, options, 20.3, 15.2) })
  await expect(referenceSnapIndicator(app.page)).toHaveCount(0)
  await pickReference(canvas, options, 20.3, 15.2)
  await expect(app.page.getByText('Tap a snap point on another feature.', { exact: true })).toBeVisible()
  expect(withoutModified(await getProject(app.page))).toEqual(before)
  await app.page.keyboard.press('Escape')
  await expect(app.page.getByText('Tap a snap point on another feature.', { exact: true })).toHaveCount(0)
  await app.page.getByRole('button', { name: 'Cancel editing', exact: true }).click()
  expect(withoutModified(await getProject(app.page))).toEqual(before)
})

test.describe('#994 landscape construction references', () => {
  test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true })
  for (const face of ['top', 'bottom'] as const) {
    test(`${face}: touch captures a foreign point without pan or edit selection`, async ({ app }) => {
      const options = { face, axis: 'y' as const }
      await seedConstructionReferences(app.page, options)
      const canvas = app.page.locator('canvas.sketch-canvas')
      const before = referenceSnapshot(await getProject(app.page))
      await startAddRectPlacement(app.page)
      await pickReference(canvas, options, 20.3, 15.2, true)
      await pickReference(canvas, options, 50, 25, true)
      await cancelPendingAdd(app.page)
      const project = await getProject(app.page)
      expect((project.features as unknown[]).length).toBe(6)
      expect(referenceSnapshot(project)).toEqual(before)
      await expect(featureRow(app.page, 'reference-guide')).not.toHaveClass(/tree-row--selected/)
      await app.page.getByRole('button', { name: 'Undo', exact: true }).first().click()
      expect((await features(app.page)).length).toBe(5)
    })
  }
})

// #994 review: clipboard placement is local canvas state, but reads the same references.
for (const face of ['top', 'bottom'] as const) {
  for (const axis of ['x', 'y'] as const) {
    test(`#994 clipboard ${face}/${axis}: real paste snaps its placed centre to foreign construction`, async ({ app, ui }) => {
      const { page } = app
      const options = { face, axis }
      await seedConstructionReferences(page, options)
      const canvas = page.locator('canvas.sketch-canvas')
      const before = withoutModified(await getProject(page))
      const refs = referenceSnapshot(before)
      await featureRow(page, 'reference-source').click()
      await canvas.focus()
      await page.keyboard.press('ControlOrMeta+c')
      await page.keyboard.press('ControlOrMeta+v')
      const paste = page.locator('.canvas-workflow-panel').filter({ has: page.locator('.canvas-workflow-panel__title', { hasText: 'Paste features' }) })
      await expect(paste).toBeVisible()
      const near = await referenceCanvasPoint(canvas, options, 20.3, 15.2)
      await canvas.hover({ position: near })
      const previewSnapped = await referenceSnapIndicator(page).count()
      await canvas.click({ position: near })
      await expect(paste).toHaveCount(0)
      const after = await getProject(page)
      const rows = after.features as SavedFeature[]
      const originalIds = new Set((before.features as SavedFeature[]).map(row => row.id))
      const placed = rows.find(row => !originalIds.has(row.id))!
      expect(placed.authoringFace).toBe(face)
      expect(placed.transform.e + 82.5).toBeCloseTo(20, 6)
      expect(placed.transform.f + 42.5).toBeCloseTo(15, 6)
      expect(previewSnapped).toBe(1)
      expect(referenceSnapshot(after)).toEqual(refs)
      await page.keyboard.press('ControlOrMeta+z')
      expect(withoutModified(await getProject(page))).toEqual(before)

      // Cancellation clears the local reference phase, including the next pointer preview.
      await featureRow(page, 'reference-source').click()
      await canvas.focus()
      await page.keyboard.press('ControlOrMeta+v')
      await expect(paste).toBeVisible()
      await canvas.hover({ position: near })
      await expect(referenceSnapIndicator(page)).toHaveCount(1)
      await page.keyboard.press('Escape')
      await expect(paste).toHaveCount(0)
      await canvas.hover({ position: await referenceCanvasPoint(canvas, options, 20.4, 15.3) })
      await expect(referenceSnapIndicator(page)).toHaveCount(0)
      expect(withoutModified(await getProject(page))).toEqual(before)

      // Other side off cannot satisfy point-only snapping; disabling snap permits raw placement.
      await ui.face.otherSideToggle(page).click()
      await canvas.focus()
      await page.keyboard.press('ControlOrMeta+v')
      await expect(paste).toBeVisible()
      await canvas.hover({ position: near })
      await expect(referenceSnapIndicator(page)).toHaveCount(0)
      await canvas.click({ position: near })
      await expect(paste).toBeVisible()
      expect(withoutModified(await getProject(page))).toEqual(before)
      await page.getByRole('button', { name: 'Disable snapping', exact: true }).click()
      await canvas.click({ position: near })
      const raw = ((await getProject(page)).features as SavedFeature[]).find(row => !originalIds.has(row.id))!
      expect(raw.transform.e + 82.5).toBeCloseTo(20.3, 0)
      expect(raw.transform.f + 42.5).toBeCloseTo(15.2, 0)
      expect(Math.hypot(raw.transform.e + 82.5 - 20, raw.transform.f + 42.5 - 15)).toBeGreaterThan(0.15)
      expect(referenceSnapshot(await getProject(page))).toEqual(refs)
    })
  }
  test(`#994 clipboard ${face}: hidden construction cannot snap a real paste`, async ({ app }) => {
    const { page } = app
    const options = { face, axis: 'y' as const, hidden: true }
    await seedConstructionReferences(page, options)
    const canvas = page.locator('canvas.sketch-canvas')
    const before = await getProject(page)
    await featureRow(page, 'reference-source').click()
    await canvas.focus()
    await page.keyboard.press('ControlOrMeta+c')
    await page.keyboard.press('ControlOrMeta+v')
    await expect(page.locator('.canvas-workflow-panel').filter({ has: page.locator('.canvas-workflow-panel__title', { hasText: 'Paste features' }) })).toBeVisible()
    await canvas.hover({ position: await referenceCanvasPoint(canvas, options, 20.3, 15.2) })
    await expect(referenceSnapIndicator(page)).toHaveCount(0)
    await pickReference(canvas, options, 20.3, 15.2)
    expect(withoutModified(await getProject(page))).toEqual(withoutModified(before))
    await page.getByRole('button', { name: 'Disable snapping', exact: true }).click()
    await pickReference(canvas, options, 20.3, 15.2)
    const ids = new Set((before.features as SavedFeature[]).map(row => row.id))
    const placed = ((await getProject(page)).features as SavedFeature[]).find(row => !ids.has(row.id))!
    expect(placed.authoringFace).toBe(face)
    expect(Math.hypot(placed.transform.e + 82.5 - 20, placed.transform.f + 42.5 - 15)).toBeGreaterThan(0.15)
    expect(referenceSnapshot(await getProject(page))).toEqual(referenceSnapshot(before))
  })
}
