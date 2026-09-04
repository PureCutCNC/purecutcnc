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

import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { getFeatureCount, getProject } from './helpers'
import { clickCanvasWorld, seedOverlapFeatureProject } from './overlapFeatureSelection.helpers'

const PANEL = '.canvas-workflow-panel--text-layout'

interface TextLayoutShape {
  kind: string
  radius?: number
  direction?: string
  fit?: string
  anchor?: string
  reversed?: boolean
  path?: { segments: unknown[] }
}

/** Place a straight run and select it, without opening the layout panel. */
async function placeAndSelectRun(page: Page, text = 'ARC'): Promise<void> {
  await page.evaluate(async (value: string) => {
    const w = window as unknown as {
      __pcTest: {
        startAddTextPlacement: (t: string) => Promise<void>
        placePendingTextAt: (x: number, y: number) => Promise<string[]>
        selectFeatures: (ids: string[]) => Promise<void>
      }
    }
    await w.__pcTest.startAddTextPlacement(value)
    const created = await w.__pcTest.placePendingTextAt(120, 120)
    if (created.length > 0) await w.__pcTest.selectFeatures([created[created.length - 1]!])
  }, text)
}

/**
 * Place a straight run, select it, and open the baseline edit on it — the
 * panel is an edit on existing text, not a step in creating it.
 */
async function startLayout(page: Page, kind: 'arc' | 'path' = 'arc', text = 'ARC'): Promise<void> {
  await page.evaluate(async ([value, k]: [string, string]) => {
    const w = window as unknown as { __pcTest: { startTextLayout: (t: string, k: 'arc' | 'path') => Promise<void> } }
    await w.__pcTest.startTextLayout(value, k as 'arc' | 'path')
  }, [text, kind] as [string, string])
  await expect(page.locator(PANEL)).toBeVisible()
}

/**
 * The layout stored on the one text feature in the project, if any.
 *
 * It lives on the **instance row**, not the shared definition — that is what
 * lets one copy curve while its siblings stay straight.
 */
async function storedTextLayout(page: Page): Promise<TextLayoutShape | null> {
  const project = await getProject(page)
  const features = (project.features ?? []) as Array<{ textLayout?: TextLayoutShape | null }>
  for (const feature of features) {
    if (feature.textLayout) return feature.textLayout
  }
  return null
}

test('Text layout panel opens on the selected run in the mode that was picked', async ({ app }) => {
  await seedOverlapFeatureProject(app.page, 1)
  await startLayout(app.page, 'arc')
  const panel = app.page.locator(PANEL)

  await expect(panel.locator('.canvas-workflow-panel__title')).toHaveText('Text layout')
  // The mode comes from the arrange button that opened it, so the panel is
  // already on the arc rather than starting straight.
  await expect(panel.getByLabel('Layout')).toHaveValue('arc')
  await expect(panel.getByLabel('Radius')).toBeVisible()
  await expect(panel.getByLabel('Sweep')).toBeVisible()
  await expect(panel.getByLabel('Direction')).toHaveValue('cw')
  await expect(panel.getByLabel('Anchor')).toHaveValue('center')
  await expect(panel.getByLabel('Fit')).toHaveValue('natural')
})

test('Arc applies to the selected run once a centre is picked', async ({ app }) => {
  await seedOverlapFeatureProject(app.page, 1)
  await startLayout(app.page, 'arc')
  const panel = app.page.locator(PANEL)
  const countAfterRun = await getFeatureCount(app.page)

  // The run already exists, so applying edits it rather than adding anything.
  const apply = panel.getByRole('button', { name: 'Apply', exact: true })
  await expect(apply).toBeDisabled()
  expect(await storedTextLayout(app.page)).toBeNull()

  // The centre is an explicit pick with its own button, the same interaction
  // the radial distribution panel uses.
  await panel.getByRole('button', { name: 'Pick center', exact: true }).click()
  const canvas = app.page.locator('canvas').first()
  await clickCanvasWorld(canvas, 20, 70)
  await expect(panel.getByRole('button', { name: 'Change center', exact: true })).toBeVisible()

  await expect(apply).toBeEnabled()
  await apply.click()

  expect(await getFeatureCount(app.page)).toBe(countAfterRun)
  const layout = await storedTextLayout(app.page)
  expect(layout?.kind).toBe('arc')
  expect(layout?.radius ?? 0).toBeGreaterThan(0)
  expect(layout?.direction).toBe('cw')
})

test('Flipping to anticlockwise moves the run to the bottom of the circle', async ({ app }) => {
  await seedOverlapFeatureProject(app.page, 1)
  await startLayout(app.page, 'arc')
  const panel = app.page.locator(PANEL)

  // cw writes over the top (12 o'clock is 270 in this app's clockwise-positive,
  // Y-down convention); ccw has to carry the run to 6 o'clock, not merely
  // reverse travel and leave it upside down at the top.
  await expect(panel.getByLabel('Angle')).toHaveValue('270')
  await panel.getByLabel('Direction').selectOption('ccw')
  await expect(panel.getByLabel('Angle')).toHaveValue('90')

  await panel.getByLabel('Direction').selectOption('cw')
  await expect(panel.getByLabel('Angle')).toHaveValue('270')
})

test('Path text needs a guide, then applies from the panel', async ({ app }) => {
  await seedOverlapFeatureProject(app.page, 1)
  const before = await getFeatureCount(app.page)
  await startLayout(app.page, 'path', 'PATH')
  const panel = app.page.locator(PANEL)

  // Refuses until a guide is picked, because without one there is no baseline.
  const create = panel.getByRole('button', { name: 'Apply', exact: true })
  await expect(create).toBeDisabled()

  await panel.getByRole('button', { name: 'Pick guide', exact: true }).click()
  const canvas = app.page.locator('canvas').first()
  await clickCanvasWorld(canvas, 0.4, 45)

  await expect(create).toBeEnabled()
  await create.click()
  // The run already existed; applying a baseline must not add a second one.
  expect(await getFeatureCount(app.page)).toBe(before + 1)

  const layout = await storedTextLayout(app.page)
  expect(layout?.kind).toBe('path')
  // The guide is baked in, not linked, so the outline travels with the text.
  expect((layout?.path?.segments ?? []).length).toBeGreaterThan(0)
})

test('Escape backs out of guide picking without discarding the run', async ({ app }) => {
  await seedOverlapFeatureProject(app.page, 1)
  await startLayout(app.page, 'path')
  const panel = app.page.locator(PANEL)
  await panel.getByRole('button', { name: 'Pick guide', exact: true }).click()
  await expect(panel.getByRole('button', { name: 'Cancel picking', exact: true })).toBeVisible()

  // Esc leaves picking but keeps the edit open, so a mis-click does not throw
  // away the settings along with it.
  await app.page.keyboard.press('Escape')
  await expect(panel).toBeVisible()
  await expect(panel.getByLabel('Layout')).toHaveValue('path')
  await expect(panel.getByRole('button', { name: 'Pick guide', exact: true })).toBeVisible()
})

test('Fill states the height the run will actually cut', async ({ app }) => {
  await seedOverlapFeatureProject(app.page, 1)
  await startLayout(app.page, 'arc', 'FILL')
  const panel = app.page.locator(PANEL)

  // Natural keeps the typed size, so there is nothing to warn about.
  await expect(panel.locator('.canvas-workflow-panel__hint')).toHaveCount(0)

  await panel.getByLabel('Fit').selectOption('fill')
  // Filling rescales the run, so the resulting height is stated outright.
  await expect(panel.locator('.canvas-workflow-panel__hint')).toContainText('Cuts at')
})

/**
 * Reaching the panel through the real toolbar, not the test bridge.
 *
 * Every other spec here drives the store directly, which is why they all stayed
 * green while the menu entries existed in only one of the two places that render
 * the arrange menu — the toolbar copy had no buttons at all and nothing noticed.
 * A store-level test can never catch an unreachable command.
 */
test('The arrange menu offers the text baselines and opens the panel', async ({ app }) => {
  await seedOverlapFeatureProject(app.page, 1)
  await placeAndSelectRun(app.page)

  const command = app.page.getByRole('button', { name: 'Distribute selected features', exact: true }).first()
  await expect(command).toBeEnabled()
  await command.click()

  const menu = app.page.getByRole('menu')
  // One entry, not one per baseline — the panel's mode selector picks the mode.
  await expect(menu.getByRole('button', { name: 'Text layout', exact: true })).toBeEnabled()
  await expect(menu.getByRole('button', { name: 'On a circle', exact: true })).toHaveCount(0)

  await menu.getByRole('button', { name: 'Text layout', exact: true }).click()
  const panel = app.page.locator(PANEL)
  await expect(panel).toBeVisible()
  await expect(panel.getByLabel('Layout')).toHaveValue('arc')
})

/** The baselines stay disabled unless the selection is a single text run. */
test('The text baselines are disabled for a non-text selection', async ({ app }) => {
  await seedOverlapFeatureProject(app.page, 2)
  // Select whatever the seed actually created, so the command itself is
  // enabled and the assertion is about the baselines, not about the menu.
  await app.page.evaluate(async () => {
    const w = window as unknown as {
      __pcTest: {
        getProject: () => Promise<{ features: Array<{ id: string }> }>
        selectFeatures: (ids: string[]) => Promise<void>
      }
    }
    const project = await w.__pcTest.getProject()
    await w.__pcTest.selectFeatures(project.features.map((feature) => feature.id))
  })

  const command = app.page.getByRole('button', { name: 'Distribute selected features', exact: true }).first()
  await command.click()
  const menu = app.page.getByRole('menu')
  await expect(menu.getByRole('button', { name: 'Text layout', exact: true })).toBeDisabled()
})
