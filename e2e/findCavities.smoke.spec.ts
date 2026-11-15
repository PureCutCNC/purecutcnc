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
 * Find pockets and holes smoke (issue #1206 slice 2) — imports a real STL with
 * one blind pocket, runs the search from Properties, draws the shape, undoes
 * it, and checks that a second run offers nothing new.
 *
 * The detector and the store action are covered by
 * src/engine/modelRecognition/recognize.test.ts and
 * src/store/modelRecognitionFlow.test.ts. What only a browser run can prove is
 * that the section and the context-menu entry render for an imported model,
 * that the worker answers, and that the dialog commits what it lists.
 */

import { test, expect } from './fixtures'
import type { Locator, Page } from '@playwright/test'
import { getProject } from './helpers'
import { openImportDialog, selectSourceUnitsMm } from './importGeometry.helpers'

const PLATE = { x: 40, y: 30, z: 10 }
const POCKET = { minX: 10, maxX: 30, minY: 10, maxY: 20, floor: 6 }

/** ASCII STL of a 40 x 30 x 10 plate with a 20 x 10 pocket 4 deep in its top. */
function stlPlateWithPocket(): string {
  type V = [number, number, number]
  const triangles: Array<[V, V, V]> = []
  const quad = (a: V, b: V, c: V, d: V): void => {
    triangles.push([a, b, c], [a, c, d])
  }
  const { x, y, z } = PLATE
  const outer: Array<[number, number]> = [[0, 0], [x, 0], [x, y], [0, y]]
  const inner: Array<[number, number]> = [
    [POCKET.minX, POCKET.minY], [POCKET.maxX, POCKET.minY], [POCKET.maxX, POCKET.maxY], [POCKET.minX, POCKET.maxY],
  ]
  // Underside.
  quad([0, 0, 0], [0, y, 0], [x, y, 0], [x, 0, 0])
  for (let k = 0; k < 4; k += 1) {
    const [ax, ay] = outer[k]
    const [bx, by] = outer[(k + 1) % 4]
    const [cx, cy] = inner[(k + 1) % 4]
    const [dx, dy] = inner[k]
    // Outer wall, the top face around the pocket, then the pocket wall.
    quad([ax, ay, 0], [bx, by, 0], [bx, by, z], [ax, ay, z])
    quad([ax, ay, z], [bx, by, z], [cx, cy, z], [dx, dy, z])
    quad([dx, dy, POCKET.floor], [dx, dy, z], [cx, cy, z], [cx, cy, POCKET.floor])
  }
  // Pocket floor.
  quad(
    [inner[0][0], inner[0][1], POCKET.floor], [inner[1][0], inner[1][1], POCKET.floor],
    [inner[2][0], inner[2][1], POCKET.floor], [inner[3][0], inner[3][1], POCKET.floor],
  )
  const facets = triangles.map((triangle) => [
    '  facet normal 0 0 0',
    '    outer loop',
    ...triangle.map((vertex) => `      vertex ${vertex.join(' ')}`),
    '    endloop',
    '  endfacet',
  ].join('\n')).join('\n')
  return `solid plate\n${facets}\nendsolid plate\n`
}

async function importPlate(page: Page): Promise<void> {
  const dialog = await openImportDialog(page)
  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'pocket-plate.stl',
    mimeType: 'model/stl',
    buffer: Buffer.from(stlPlateWithPocket()),
  })
  await selectSourceUnitsMm(dialog)
  await dialog.locator('.dialog-footer .btn-primary').click()
  await expect(dialog).not.toBeVisible({ timeout: 30_000 })
}

interface FeatureRow { id: string; folderId: string | null; z_top: number; z_bottom: number; authoringFace: string }

function featuresOf(project: Record<string, unknown>): FeatureRow[] {
  return project.features as FeatureRow[]
}

async function openFromProperties(page: Page): Promise<Locator> {
  await page.locator('.tree-row--feature').first().click()
  await expect(page.locator('.properties-panel')).toBeVisible()
  await page.getByTestId('find-cavities-open').click()
  const dialog = page.getByTestId('find-cavities-dialog')
  await expect(dialog).toBeVisible()
  return dialog
}

test.describe('find pockets and holes', () => {
  test('draws the pocket found on an imported model, in one undo step, and offers nothing twice', async ({ app }) => {
    test.setTimeout(90_000)
    const { page } = app
    await importPlate(page)
    const before = featuresOf(await getProject(page))
    expect(before).toHaveLength(1)
    const model = before[0]
    const modelHeight = model.z_top - model.z_bottom

    const dialog = await openFromProperties(page)
    const row = dialog.getByTestId('find-cavities-row-c0')
    await expect(row).toBeVisible({ timeout: 30_000 })
    await expect(row).toHaveAttribute('data-kind', 'pocket')
    await expect(dialog.locator('.find-cavities__row')).toHaveCount(1)
    await expect(row.locator('input[type="checkbox"]')).toBeChecked()
    await expect(dialog.getByTestId('find-cavities-preview').locator('.find-cavities__shape')).toHaveCount(1)
    const add = dialog.getByTestId('find-cavities-add')
    await expect(add).toHaveText('Add 1 shape')

    // Unchecking the only row leaves nothing to add.
    await row.locator('input[type="checkbox"]').uncheck()
    await expect(add).toBeDisabled()
    await row.locator('input[type="checkbox"]').check()
    await add.click()
    await expect(dialog).not.toBeVisible()

    const project = await getProject(page)
    const after = featuresOf(project)
    expect(after).toHaveLength(2)
    const drawn = after.find((feature) => feature.id !== model.id)!
    expect(drawn.authoringFace).toBe('top')
    // Ratios, because the default project is in inches and the fixture is mm.
    expect((drawn.z_top - drawn.z_bottom) / modelHeight).toBeCloseTo((PLATE.z - POCKET.floor) / PLATE.z, 3)
    expect(drawn.z_top).toBeCloseTo(model.z_top, 4)
    // In a new folder, directly after the model in the tree.
    const tree = project.featureTree as Array<{ type: string; featureId?: string; folderId?: string }>
    const modelIndex = tree.findIndex((entry) => entry.featureId === model.id)
    expect(tree[modelIndex + 1]).toEqual({ type: 'folder', folderId: drawn.folderId })
    const folders = project.featureFolders as Array<{ id: string; name: string }>
    expect(folders.find((folder) => folder.id === drawn.folderId)?.name).toContain('pockets and holes')

    // A second run lists the pocket as already drawn and offers nothing.
    await page.locator('.tree-row--feature').first().click()
    await page.getByTestId('find-cavities-open').click()
    await expect(row).toBeVisible({ timeout: 30_000 })
    await expect(row).toContainText('Already drawn')
    await expect(row.locator('input[type="checkbox"]')).not.toBeChecked()
    await expect(add).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()

    // One undo takes the shape and its folder away again.
    await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+z`)
    const undone = await getProject(page)
    expect(featuresOf(undone)).toHaveLength(1)
    expect(undone.featureFolders as unknown[]).toHaveLength(0)
  })

  test('the tree context menu opens the same dialog', async ({ app }) => {
    test.setTimeout(90_000)
    const { page } = app
    await importPlate(page)
    await page.locator('.tree-row--feature').first().click({ button: 'right' })
    await page.getByTestId('context-find-cavities').click()
    const dialog = page.getByTestId('find-cavities-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('find-cavities-row-c0')).toBeVisible({ timeout: 30_000 })
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).not.toBeVisible()
    expect(featuresOf(await getProject(page))).toHaveLength(1)
  })
})
