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

async function startText(page: Page, text = 'ARC'): Promise<void> {
  await page.evaluate(async (value: string) => {
    const w = window as unknown as { __pcTest: { startAddTextPlacement: (t: string) => Promise<void> } }
    await w.__pcTest.startAddTextPlacement(value)
  }, text)
  await expect(page.locator(PANEL)).toBeVisible()
}

/** The layout stored on the one text feature in the project, if any. */
async function storedTextLayout(page: Page): Promise<TextLayoutShape | null> {
  const project = await getProject(page)
  const definitions = (project.featureDefinitions ?? {}) as Record<string, { text?: { layout?: TextLayoutShape | null } | null }>
  for (const definition of Object.values(definitions)) {
    if (definition.text?.layout) return definition.text.layout
  }
  return null
}

test('Text layout panel opens with the run straight and offers the curved modes', async ({ app }) => {
  await seedOverlapFeatureProject(app.page, 1)
  await startText(app.page)
  const panel = app.page.locator(PANEL)

  await expect(panel.locator('.canvas-workflow-panel__title')).toHaveText('Text layout')
  await expect(panel.getByLabel('Layout')).toHaveValue('horizontal')
  // Straight text still commits on a single canvas click, so the panel shows no
  // Create button of its own.
  await expect(panel.getByRole('button', { name: 'Create', exact: true })).toHaveCount(0)

  await panel.getByLabel('Layout').selectOption('arc')
  await expect(panel.getByLabel('Radius')).toBeVisible()
  await expect(panel.getByLabel('Sweep')).toBeVisible()
  await expect(panel.getByLabel('Direction')).toHaveValue('cw')
  await expect(panel.getByLabel('Anchor')).toHaveValue('center')
  await expect(panel.getByLabel('Fit')).toHaveValue('natural')
})

test('Arc text places in two canvas clicks and stores its layout', async ({ app }) => {
  await seedOverlapFeatureProject(app.page, 1)
  const before = await getFeatureCount(app.page)
  await startText(app.page)
  const panel = app.page.locator(PANEL)
  await panel.getByLabel('Layout').selectOption('arc')

  // Keep the gesture clear of the panel, which floats over the middle of the
  // canvas and would otherwise swallow the clicks.
  const canvas = app.page.locator('canvas').first()
  // First click is the centre: nothing is created yet.
  await clickCanvasWorld(canvas, 20, 70)
  expect(await getFeatureCount(app.page)).toBe(before)
  await expect(panel).toBeVisible()

  // Second click sits above the centre, which is the text-over-the-top case.
  await clickCanvasWorld(canvas, 20, 50)
  expect(await getFeatureCount(app.page)).toBe(before + 1)

  const layout = await storedTextLayout(app.page)
  expect(layout?.kind).toBe('arc')
  expect(layout?.radius ?? 0).toBeGreaterThan(0)
  expect(layout?.direction).toBe('cw')
})

test('Path text needs a guide, then commits from the panel', async ({ app }) => {
  await seedOverlapFeatureProject(app.page, 1)
  const before = await getFeatureCount(app.page)
  await startText(app.page, 'PATH')
  const panel = app.page.locator(PANEL)
  await panel.getByLabel('Layout').selectOption('path')

  // Unlike the other modes, this one commits from the panel — and refuses
  // until a guide is picked, because without one there is no baseline.
  const create = panel.getByRole('button', { name: 'Create', exact: true })
  await expect(create).toBeDisabled()
  await expect(panel.getByRole('alert')).toContainText('guide')

  await panel.getByRole('button', { name: 'Pick guide', exact: true }).click()
  const canvas = app.page.locator('canvas').first()
  await clickCanvasWorld(canvas, 0.4, 45)

  await expect(create).toBeEnabled()
  await create.click()
  expect(await getFeatureCount(app.page)).toBe(before + 1)

  const layout = await storedTextLayout(app.page)
  expect(layout?.kind).toBe('path')
  // The guide is baked in, not linked, so the outline travels with the text.
  expect((layout?.path?.segments ?? []).length).toBeGreaterThan(0)
})

test('Escape backs out of guide picking without discarding the run', async ({ app }) => {
  await seedOverlapFeatureProject(app.page, 1)
  await startText(app.page)
  const panel = app.page.locator(PANEL)
  await panel.getByLabel('Layout').selectOption('path')
  await panel.getByRole('button', { name: 'Pick guide', exact: true }).click()
  await expect(panel.getByRole('button', { name: 'Cancel picking', exact: true })).toBeVisible()

  await app.page.keyboard.press('Escape')
  await expect(panel).toBeVisible()
  await expect(panel.getByLabel('Layout')).toHaveValue('path')
})

test('Fill states the height the run will actually cut', async ({ app }) => {
  await seedOverlapFeatureProject(app.page, 1)
  await startText(app.page, 'FILL')
  const panel = app.page.locator(PANEL)
  await panel.getByLabel('Layout').selectOption('arc')

  // Natural keeps the typed size, so there is nothing to warn about.
  await expect(panel.locator('.canvas-workflow-panel__hint')).toHaveCount(0)

  await panel.getByLabel('Fit').selectOption('fill')
  // Filling rescales the run, so the resulting height is stated outright.
  await expect(panel.locator('.canvas-workflow-panel__hint')).toContainText('Cuts at')
})
