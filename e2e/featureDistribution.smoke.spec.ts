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

import { expect, test } from './fixtures'
import { getFeatureCount, selectFeatures } from './helpers'
import { clickCanvasWorld, seedObviousOverlapFeatureProject, seedOverlapFeatureProject } from './overlapFeatureSelection.helpers'

const PANEL = '.canvas-workflow-panel--feature-distribution'

async function openFeatureDistribution(
  page: Parameters<typeof seedOverlapFeatureProject>[0],
  mode: 'Grid' | 'Radial' | 'Along path' = 'Grid',
) {
  await seedOverlapFeatureProject(page, 1)
  await selectFeatures(page, ['f-overlap-1'])
  await expect(page.getByRole('button', { name: 'Feature distribution', exact: true })).toHaveCount(0)
  const command = page.getByRole('button', { name: 'Distribute selected features', exact: true }).first()
  await expect(command).toBeEnabled()
  await command.click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  await menu.getByRole('button', { name: mode, exact: true }).click()
  await expect(page.locator(PANEL)).toBeVisible()
}

test('Distribute drawer opens a grid preview and leaves standard distribution disabled for one feature', async ({ app }) => {
  await seedOverlapFeatureProject(app.page, 1)
  await selectFeatures(app.page, ['f-overlap-1'])
  const command = app.page.getByRole('button', { name: 'Distribute selected features', exact: true }).first()
  await expect(command).toBeEnabled()
  await command.click()
  const menu = app.page.getByRole('menu')
  await expect(menu.getByRole('button', { name: 'Distribute horizontally (equal gaps)', exact: true })).toBeDisabled()
  await expect(menu.getByRole('button', { name: 'Grid', exact: true })).toBeEnabled()
  await expect(menu.getByRole('button', { name: 'Radial', exact: true })).toBeEnabled()
  await expect(menu.getByRole('button', { name: 'Along path', exact: true })).toBeEnabled()
  await menu.getByRole('button', { name: 'Grid', exact: true }).click()
  await expect(app.page.locator(PANEL)).toBeVisible()

  const panel = app.page.locator(PANEL)

  await expect(panel.locator('.canvas-workflow-panel__title')).toHaveText('Feature distribution')
  await expect(panel.getByLabel('X spacing')).toHaveValue('2')
  await expect(panel.getByLabel('Y spacing')).toHaveValue('2')
  await expect(panel.getByRole('button', { name: 'Create copies', exact: true })).toBeEnabled()
  expect(await getFeatureCount(app.page)).toBe(1)

  await panel.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(panel).toHaveCount(0)
  expect(await getFeatureCount(app.page)).toBe(1)
})

test('Feature distribution creates the planned copies in one visible workflow', async ({ app }) => {
  await openFeatureDistribution(app.page)
  const panel = app.page.locator(PANEL)

  // Default grid is 1 × 2, so one additional instance is previewed and then committed.
  await panel.getByRole('button', { name: 'Create copies', exact: true }).click()
  await expect(panel).toHaveCount(0)
  await expect.poll(() => getFeatureCount(app.page)).toBe(2)
})

test('Escape cancels Feature Distribution without changing the project', async ({ app }) => {
  await openFeatureDistribution(app.page)
  await app.page.locator('canvas.sketch-canvas').focus()
  await app.page.keyboard.press('Escape')

  await expect(app.page.locator(PANEL)).toHaveCount(0)
  expect(await getFeatureCount(app.page)).toBe(1)
})

test('radial distribution picks its center from the sketch', async ({ app }) => {
  await openFeatureDistribution(app.page, 'Radial')
  const panel = app.page.locator(PANEL)
  const canvas = app.page.locator('canvas.sketch-canvas')

  await expect(panel.getByLabel('Center X')).toHaveCount(0)
  await expect(panel.getByLabel('Center Y')).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'Create copies', exact: true })).toBeDisabled()

  await panel.getByRole('button', { name: 'Pick center', exact: true }).click()
  await expect(panel.getByText('Click a center point on the sketch — Esc cancels', { exact: true })).toBeVisible()
  await panel.getByRole('button', { name: 'Cancel picking', exact: true }).click()
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Pick center', exact: true })).toBeVisible()

  await panel.getByRole('button', { name: 'Pick center', exact: true }).click()
  await clickCanvasWorld(canvas, 80, 20)
  await expect(panel.getByRole('button', { name: 'Change center', exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Create copies', exact: true })).toBeEnabled()
  await panel.getByRole('button', { name: 'Create copies', exact: true }).click()
  await expect.poll(() => getFeatureCount(app.page)).toBe(4)
})

test('along-path distribution names a guide chosen from its visible outline', async ({ app }) => {
  await seedObviousOverlapFeatureProject(app.page)
  await selectFeatures(app.page, ['f-overlap-1'])
  await app.page.getByRole('button', { name: 'Distribute selected features', exact: true }).first().click()
  await app.page.getByRole('menu').getByRole('button', { name: 'Along path', exact: true }).click()
  const panel = app.page.locator(PANEL)
  const canvas = app.page.locator('canvas.sketch-canvas')

  await expect(panel.getByRole('button', { name: 'Create copies', exact: true })).toBeDisabled()
  await panel.getByRole('button', { name: 'Pick guide', exact: true }).click()
  await expect(panel.getByText('Click a separate guide outline on the sketch — Esc cancels', { exact: true })).toBeVisible()
  await panel.getByRole('button', { name: 'Cancel picking', exact: true }).click()
  await expect(panel.getByRole('button', { name: 'Pick guide', exact: true })).toBeVisible()
  await panel.getByRole('button', { name: 'Pick guide', exact: true }).click()
  await clickCanvasWorld(canvas, 10, 45)

  await expect(panel.getByRole('button', { name: 'Change guide', exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Create copies', exact: true })).toBeEnabled()
  await panel.getByRole('button', { name: 'Create copies', exact: true }).click()
  await expect.poll(() => getFeatureCount(app.page)).toBe(5)
})

test('a toolbar action cancels an active sketch pick', async ({ app }) => {
  await openFeatureDistribution(app.page, 'Radial')
  const panel = app.page.locator(PANEL)
  await panel.getByRole('button', { name: 'Pick center', exact: true }).click()
  await app.page.locator('.toolbar').first().getByRole('button').first().click()
  await expect(panel).toHaveCount(0)
})

test.describe('tablet command bar', () => {
  test.use({ hasTouch: true, viewport: { width: 1024, height: 768 } })

  test('keeps pattern distribution discoverable from the Distribute drawer', async ({ app }) => {
    await seedOverlapFeatureProject(app.page, 1)
    await selectFeatures(app.page, ['f-overlap-1'])

    const command = app.page.getByRole('button', { name: 'Distribute selected features', exact: true }).first()
    await expect(command).toBeVisible()
    await expect(command).toBeEnabled()
    await command.click()
    await app.page.locator('.tool-rail__popover').getByRole('button', { name: 'Grid', exact: true }).click()
    await expect(app.page.locator(PANEL)).toBeVisible()
  })
})
