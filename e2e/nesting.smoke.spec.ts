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

// Sheet nesting (issue #848, step 3 of #741): open Nest from the Distribute
// menu, nest a part with a pocket, then discard the nest again.

import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { getFeatureCount, getProject, seedProject, selectFeatures } from './helpers'

const PANEL = '.canvas-workflow-panel--nest'

function rectProfile(x: number, y: number, width: number, height: number) {
  return {
    start: { x, y },
    segments: [
      { type: 'line' as const, to: { x: x + width, y } },
      { type: 'line' as const, to: { x: x + width, y: y + height } },
      { type: 'line' as const, to: { x, y: y + height } },
      { type: 'line' as const, to: { x, y } },
    ],
    closed: true,
  }
}

function row(id: string, definitionId: string, zBottom: number) {
  return {
    id,
    name: id,
    definitionId,
    transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    constraints: [] as unknown[],
    folderId: null,
    z_top: 0.75,
    z_bottom: zBottom,
    visible: true,
    locked: false,
  }
}

function nestingProjectJson(withBracket = false): string {
  const now = '2026-09-23T00:00:00.000Z'
  return JSON.stringify({
    version: '3.0',
    meta: {
      name: 'Nesting E2E fixture',
      created: now,
      modified: now,
      units: 'inch',
      showFeatureInfo: true,
      showDimensions: true,
      copyMode: 'reference',
      maxTravelZ: 2,
      operationClearanceZ: 0.2,
      clampClearanceXY: 0.5,
      clampClearanceZ: 0.2,
      machineDefinitions: [],
      selectedMachineId: null,
    },
    grid: { extent: 40, majorSpacing: 1, minorSpacing: 0.25, snapEnabled: false, snapIncrement: 0.25, visible: true },
    stock: {
      profile: rectProfile(0, 0, 20, 12),
      thickness: 0.75,
      material: 'plywood',
      color: '#b9a83c',
      visible: true,
      origin: { x: 0, y: 0 },
    },
    origin: { name: 'Origin', x: 0, y: 0, z: 0.75, visible: true },
    backdrop: null,
    dimensions: {},
    annotations: [],
    modelAssets: {},
    featureDefinitions: {
      'def-plate': { id: 'def-plate', kind: 'rect', profile: rectProfile(1, 1, 3, 2), dimensions: [], text: null, stl: null, operation: 'add' },
      'def-pocket': { id: 'def-pocket', kind: 'rect', profile: rectProfile(1.5, 1.5, 1, 1), dimensions: [], text: null, stl: null, operation: 'subtract' },
      ...(withBracket
        ? { 'def-bracket': { id: 'def-bracket', kind: 'rect', profile: rectProfile(6, 1, 2, 4), dimensions: [], text: null, stl: null, operation: 'add' } }
        : {}),
    },
    features: [
      row('f-plate', 'def-plate', 0),
      row('f-pocket', 'def-pocket', 0.5),
      ...(withBracket ? [row('f-bracket', 'def-bracket', 0)] : []),
    ],
    featureFolders: [],
    featureTree: [],
    global_constraints: [],
    tools: [],
    operations: [],
    tabs: [],
    clamps: [],
    ai_history: [],
  })
}

/** `count` separate 1x1 squares — enough parts to overflow a panel that grows per row. */
function manyPartsProjectJson(count: number): string {
  const project = JSON.parse(nestingProjectJson()) as { featureDefinitions: Record<string, unknown>; features: unknown[] }
  project.featureDefinitions = {}
  project.features = []
  for (let index = 0; index < count; index += 1) {
    const id = `part-${String.fromCharCode(97 + index)}`
    project.featureDefinitions[`def-${id}`] = {
      id: `def-${id}`, kind: 'rect', profile: rectProfile(1 + 1.5 * (index % 10), 1 + 1.5 * Math.floor(index / 10), 1, 1),
      dimensions: [], text: null, stl: null, operation: 'add',
    }
    project.features.push(row(id, `def-${id}`, 0))
  }
  return JSON.stringify(project)
}

async function nestCount(page: Page): Promise<number> {
  const project = await getProject(page) as { nests?: unknown[] }
  return project.nests?.length ?? 0
}

async function openNest(page: Page) {
  await page.getByRole('button', { name: 'Distribute selected features', exact: true }).first().click()
  await page.getByRole('menu').getByRole('button', { name: 'Nest on stock', exact: true }).click()
  const panel = page.locator(PANEL)
  await expect(panel).toBeVisible()
  return panel
}

test('Nest on stock arranges copies of a part and Discard removes them', async ({ app }) => {
  const { page } = app
  await seedProject(page, nestingProjectJson())
  await selectFeatures(page, ['f-plate'])

  await page.getByRole('button', { name: 'Distribute selected features', exact: true }).first().click()
  const menu = page.getByRole('menu')
  await menu.getByRole('button', { name: 'Nest on stock', exact: true }).click()
  const panel = page.locator(PANEL)
  await expect(panel).toBeVisible()
  await expect(panel.locator('.canvas-workflow-panel__title')).toHaveText('Nest on stock')
  // Run, stop and accept live in the body; the title bar only closes (#866).
  const titleButtons = panel.locator('.canvas-workflow-panel__actions button')
  await expect(titleButtons).toHaveCount(1)
  await expect(titleButtons).toHaveAccessibleName('Cancel')

  // Containment pulled the pocket into the part; no edge route, so the gap is asked for.
  await expect(panel).toContainText('2 features in the part')
  await expect(panel.getByRole('alert')).toHaveText('Enter the gap between parts.')
  const run = panel.getByRole('button', { name: 'Nest', exact: true })
  await expect(run).toBeDisabled()

  await panel.getByLabel('Gap (inch)').fill('0.25')
  await panel.getByLabel('Parts on sheet').fill('6')
  await expect(run).toBeEnabled()
  await run.click()

  await expect(panel.getByRole('status')).toHaveText('All 6 parts fit on the stock.')
  await expect.poll(() => getFeatureCount(page)).toBe(12)
  const nested = await getProject(page) as { nests?: { name: string }[]; featureFolders: { name: string }[] }
  expect(nested.nests?.map((nest) => nest.name)).toEqual(['Nest 1'])
  expect(nested.featureFolders.map((folder) => folder.name)).toContain('Nest 1')

  // The panel now targets the nest it just made.
  await expect(panel.getByRole('button', { name: 'Nest again', exact: true })).toBeVisible()

  // Keep improving searches on in the worker (#862). Identical copies never
  // improve, so the search may stall on its own before Stop lands.
  const keepImproving = panel.getByRole('button', { name: 'Keep improving', exact: true })
  await keepImproving.click()
  await expect(panel.getByRole('status').filter({ hasText: /layouts tried/ })).toBeVisible()
  await expect(titleButtons).toHaveCount(1)
  await panel.getByRole('button', { name: 'Stop', exact: true }).click({ timeout: 2_000 }).catch(() => undefined)
  await expect(keepImproving).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => getFeatureCount(page)).toBe(12)
  await panel.getByRole('button', { name: 'Discard nest', exact: true }).click()
  await expect.poll(() => getFeatureCount(page)).toBe(2)
  const discarded = await getProject(page) as { nests?: unknown[]; featureFolders: unknown[] }
  expect(discarded.nests).toBeUndefined()
  expect(discarded.featureFolders).toHaveLength(0)

  await expect(panel.getByRole('button', { name: 'Accept nest', exact: true })).toHaveCount(0)
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(panel).toHaveCount(0)
  expect(await getFeatureCount(page)).toBe(2)
})

test('Nest on stock takes a quantity per part when several parts are selected', async ({ app }) => {
  const { page } = app
  await seedProject(page, nestingProjectJson(true))
  await selectFeatures(page, ['f-plate', 'f-bracket'])

  await page.getByRole('button', { name: 'Distribute selected features', exact: true }).first().click()
  await page.getByRole('menu').getByRole('button', { name: 'Nest on stock', exact: true }).click()
  const panel = page.locator(PANEL)
  await expect(panel).toContainText('2 parts')
  await expect(panel.getByLabel('Parts on sheet: f-plate')).toHaveValue('1')
  await expect(panel.getByLabel('Parts on sheet: f-bracket')).toHaveValue('1')

  await panel.getByLabel('All parts').fill('3')
  await panel.getByLabel('Parts on sheet: f-bracket').fill('2')
  await panel.getByLabel('Gap (inch)').fill('0.25')
  await panel.getByRole('button', { name: 'Nest', exact: true }).click()

  await expect(panel.getByRole('status')).toHaveText('All 5 parts fit on the stock.')
  // 3 plates with their pockets, 2 brackets.
  await expect.poll(() => getFeatureCount(page)).toBe(8)
  const nested = await getProject(page) as { nests?: { parts: { quantity: number }[] }[] }
  expect(nested.nests?.[0].parts.map((part) => part.quantity)).toEqual([3, 2])

  // Accept keeps the nest and closes the panel.
  await panel.getByRole('button', { name: 'Accept nest', exact: true }).click()
  await expect(panel).toHaveCount(0)
  expect(await getFeatureCount(page)).toBe(8)
})

test('Nest panel keeps every control on screen with 26 parts, and Cancel reverts', async ({ app }) => {
  const { page } = app
  // The size the bug was reported at: the panel ran off the bottom here.
  await page.setViewportSize({ width: 1280, height: 720 })
  const ids = Array.from({ length: 26 }, (_, index) => `part-${String.fromCharCode(97 + index)}`)
  await seedProject(page, manyPartsProjectJson(26))
  await selectFeatures(page, ids)
  const panel = await openNest(page)
  await expect(panel).toContainText('26 parts')
  const partsToggle = panel.getByRole('button', { name: 'Parts (26)', exact: true })
  await expect(partsToggle).toHaveAttribute('aria-expanded', 'true')

  await panel.getByLabel('Gap (inch)').fill('0.25')
  await panel.getByRole('button', { name: 'Nest', exact: true }).click()
  await expect(panel.getByRole('status')).toHaveText('All 26 parts fit on the stock.')
  // Quantity 1 each: the originals are laid out, not copied.
  await expect.poll(() => nestCount(page)).toBe(1)

  // The parts list scrolls inside the panel; the panel stays in the window.
  const viewport = page.viewportSize()!
  const box = (await panel.boundingBox())!
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
  await panel.getByLabel('Parts on sheet: part-z').scrollIntoViewIfNeeded()
  await expect(panel.getByLabel('Parts on sheet: part-z')).toBeInViewport()

  // Collapsing the section hides the rows but keeps All parts.
  await partsToggle.click()
  await expect(partsToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(panel.getByLabel('Parts on sheet: part-a')).toBeHidden()
  await expect(panel.getByLabel('All parts')).toBeVisible()

  await panel.getByRole('button', { name: 'Discard nest', exact: true }).click()
  await expect.poll(() => nestCount(page)).toBe(0)
  await panel.getByRole('button', { name: 'Nest', exact: true }).click()
  await expect.poll(() => nestCount(page)).toBe(1)

  // Cancel undoes this panel's steps and closes it.
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(panel).toHaveCount(0)
  await expect.poll(() => nestCount(page)).toBe(0)
  expect(await getFeatureCount(page)).toBe(26)
})
