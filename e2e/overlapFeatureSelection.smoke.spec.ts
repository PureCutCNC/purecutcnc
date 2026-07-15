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
import { getHoveredFeatureId } from './helpers'
import {
  clickCanvasCenter,
  seedObviousOverlapFeatureProject,
  seedOverlapFeatureProject,
} from './overlapFeatureSelection.helpers'

test.describe('Overlap feature selection browser smoke', () => {
  test('selects a uniquely indicated outline without opening the picker', async ({ app, ui }) => {
    await seedObviousOverlapFeatureProject(app.page)

    await clickCanvasCenter(ui.canvas.sketch(app.page))

    await expect(ui.overlapFeaturePicker.root(app.page)).not.toBeVisible()
    await expect(ui.tree.rowByName(app.page, 'Top overlap')).toHaveClass(/tree-row--selected/)
    await expect(ui.tree.rowByName(app.page, 'Bottom overlap')).not.toHaveClass(/tree-row--selected/)
  })

  test('shows overlapping candidates and lets the user select a non-topmost feature', async ({ app, ui }) => {
    await seedOverlapFeatureProject(app.page)

    await clickCanvasCenter(ui.canvas.sketch(app.page))

    const picker = ui.overlapFeaturePicker.root(app.page)
    await expect(picker).toBeVisible()
    await expect(ui.overlapFeaturePicker.candidates(app.page)).toHaveCount(2)
    await expect(ui.overlapFeaturePicker.candidate(app.page, 'Top overlap')).toBeVisible()
    await expect(ui.overlapFeaturePicker.candidate(app.page, 'Bottom overlap')).toBeVisible()

    await ui.overlapFeaturePicker.candidate(app.page, 'Bottom overlap').click()

    await expect(picker).not.toBeVisible()
    await expect(ui.tree.rowByName(app.page, 'Bottom overlap')).toHaveClass(/tree-row--selected/)
    await expect(ui.tree.rowByName(app.page, 'Top overlap')).not.toHaveClass(/tree-row--selected/)
  })

  test('previews a hovered or focused candidate without selecting it', async ({ app, ui }) => {
    await seedOverlapFeatureProject(app.page)
    await clickCanvasCenter(ui.canvas.sketch(app.page))

    const bottomCandidate = ui.overlapFeaturePicker.candidate(app.page, 'Bottom overlap')
    const topCandidate = ui.overlapFeaturePicker.candidate(app.page, 'Top overlap')
    const cancelButton = ui.overlapFeaturePicker.cancelButton(app.page)

    await bottomCandidate.hover()
    await expect.poll(() => getHoveredFeatureId(app.page)).toBe('f-overlap-1')
    await expect(ui.tree.selectedRows(app.page)).toHaveCount(0)

    await cancelButton.hover()
    await expect.poll(() => getHoveredFeatureId(app.page)).toBeNull()

    await topCandidate.focus()
    await expect.poll(() => getHoveredFeatureId(app.page)).toBe('f-overlap-2')
    await expect(ui.tree.selectedRows(app.page)).toHaveCount(0)

    await cancelButton.focus()
    await expect.poll(() => getHoveredFeatureId(app.page)).toBeNull()
  })

  test('picker is usable in the landscape-tablet layout and Escape cancels it', async ({ app, ui }) => {
    await app.page.setViewportSize({ width: 1024, height: 768 })
    await seedOverlapFeatureProject(app.page)

    await clickCanvasCenter(ui.canvas.sketch(app.page))

    const picker = ui.overlapFeaturePicker.root(app.page)
    await expect(picker).toBeVisible()
    await expect(ui.overlapFeaturePicker.candidate(app.page, 'Bottom overlap')).toBeVisible()

    await app.page.keyboard.press('Escape')

    await expect(picker).not.toBeVisible()
    await expect(ui.tree.selectedRows(app.page)).toHaveCount(0)
  })

  test('boxes and scrolls a long candidate list', async ({ app, ui }) => {
    await seedOverlapFeatureProject(app.page, 17)

    await clickCanvasCenter(ui.canvas.sketch(app.page))

    const list = ui.overlapFeaturePicker.list(app.page)
    await expect(list).toBeVisible()
    await expect(ui.overlapFeaturePicker.candidates(app.page)).toHaveCount(17)
    await expect(list).toHaveCSS('overflow-y', 'auto')

    const dimensions = await list.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }))
    expect(dimensions.scrollHeight, 'long candidate list should scroll within its boxed viewport')
      .toBeGreaterThan(dimensions.clientHeight)

    await list.evaluate((element) => { element.scrollTop = element.scrollHeight })
    expect(await list.evaluate((element) => element.scrollTop), 'candidate list should accept scrolling')
      .toBeGreaterThan(0)
  })

  test('dismisses when the user starts a different action', async ({ app, ui }) => {
    await seedOverlapFeatureProject(app.page)

    await clickCanvasCenter(ui.canvas.sketch(app.page))

    const picker = ui.overlapFeaturePicker.root(app.page)
    await expect(picker).toBeVisible()

    await ui.tree.rowByName(app.page, 'Bottom overlap').click()

    await expect(picker).not.toBeVisible()
    await expect(ui.tree.rowByName(app.page, 'Bottom overlap')).toHaveClass(/tree-row--selected/)
  })
})
