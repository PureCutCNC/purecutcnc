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
import { seedOverlapFeatureProject } from './overlapFeatureSelection.helpers'

const PANEL = '.canvas-workflow-panel--feature-distribution'

async function openFeatureDistribution(page: Parameters<typeof seedOverlapFeatureProject>[0]) {
  await seedOverlapFeatureProject(page, 1)
  await selectFeatures(page, ['f-overlap-1'])
  const command = page.getByRole('button', { name: 'Feature distribution', exact: true })
  await expect(command).toBeEnabled()
  await command.click()
  await expect(page.locator(PANEL)).toBeVisible()
}

test('Feature distribution command opens a configurable grid preview and cancel leaves the project unchanged', async ({ app }) => {
  await openFeatureDistribution(app.page)
  const panel = app.page.locator(PANEL)

  await expect(panel.locator('.canvas-workflow-panel__title')).toHaveText('Feature distribution')
  await expect(panel.getByRole('button', { name: 'Grid', exact: true })).toHaveAttribute('aria-pressed', 'true')
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

test.describe('tablet command bar', () => {
  test.use({ hasTouch: true, viewport: { width: 1024, height: 768 } })

  test('keeps Feature Distribution discoverable and opens its workflow', async ({ app }) => {
    await seedOverlapFeatureProject(app.page, 1)
    await selectFeatures(app.page, ['f-overlap-1'])

    const command = app.page.getByRole('button', { name: 'Feature distribution', exact: true }).first()
    await expect(command).toBeVisible()
    await expect(command).toBeEnabled()
    await command.click()
    await expect(app.page.locator(PANEL)).toBeVisible()
  })
})
