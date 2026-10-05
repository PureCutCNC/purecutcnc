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

import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import {
  getHoveredFeatureId,
  getProject,
  seedProject,
  placePendingAddAt,
  setPendingAddAnchor,
  startAddRectPlacement,
  cancelPendingAdd,
} from './helpers'

interface SavedFeature {
  id: string
  name: string
  authoringFace: 'top' | 'bottom'
  z_top: number
  z_bottom: number
  transform: unknown
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

  const saved = await getProject(page)
  const setups = saved.setups as Array<{ id: string; orientation: { axis: string; angleDeg: number } }>
  expect(setups).toHaveLength(2)
  expect(setups[1].orientation).toEqual({ axis: 'x', angleDeg: 180 })
  expect(saved.activeSetupId).toBe(setups[1].id)

  // Draw the pocket on Bottom, away from the centre.
  await drawRect(page, 0.2, 0.2, 0.9, 0.9)
  const pocket = (await features(page))[1]
  expect(pocket.authoringFace).toBe('bottom')
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
