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
 * Post-import 3D orientation smoke (issue #241) — imports a real STL through
 * the dialog, rotates it from the properties panel, and checks the committed
 * project state.
 *
 * The geometry math is covered by src/engine/modelOrientation.test.ts. What
 * only a browser run can prove is that the panel section renders for an
 * imported model, that the async re-derivation actually commits, and that the
 * sketch-side artifacts (silhouette, profile) follow the rotation.
 */

import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'
import { getProject } from './helpers'
import { openImportDialog, selectSourceUnitsMm, stlBox } from './importGeometry.helpers'

/** Box dimensions chosen so X, Y, and Z are all distinguishable. */
const BOX_X = 20
const BOX_Y = 10
const BOX_Z = 30

interface ModelState {
  orientation?: { rx: number, ry: number, rz: number }
  zTop: number
  zBottom: number
  silhouetteBounds: { width: number, height: number }
}

function readModelState(project: Record<string, unknown>): ModelState {
  const features = project.features as Array<{ definitionId: string, z_top: number, z_bottom: number }>
  const definitions = project.featureDefinitions as Record<string, {
    stl?: { orientation?: { rx: number, ry: number, rz: number }, silhouettePaths?: Array<Array<{ x: number, y: number }>> }
  }>
  const instance = features[0]
  const stl = definitions[instance.definitionId]?.stl
  const points = (stl?.silhouettePaths ?? []).flat()
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  return {
    orientation: stl?.orientation,
    zTop: instance.z_top,
    zBottom: instance.z_bottom,
    silhouetteBounds: {
      width: xs.length ? Math.max(...xs) - Math.min(...xs) : 0,
      height: ys.length ? Math.max(...ys) - Math.min(...ys) : 0,
    },
  }
}

async function importBox(page: Page): Promise<void> {
  const dialog = await openImportDialog(page)
  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'orientation-box.stl',
    mimeType: 'model/stl',
    buffer: Buffer.from(stlBox(BOX_X, BOX_Y, BOX_Z)),
  })
  await selectSourceUnitsMm(dialog)
  await dialog.locator('.dialog-footer .btn-primary').click()
  await expect(dialog).not.toBeVisible({ timeout: 30_000 })
}

async function openOrientationSection(page: Page): Promise<void> {
  await page.locator('.tree-row--feature').first().click()
  await expect(page.locator('.properties-panel')).toBeVisible()
  const header = page.getByRole('button', { name: '3D orientation' })
  await expect(header).toBeVisible()
  if (await header.getAttribute('aria-expanded') !== 'true') {
    await header.click()
  }
  await expect(page.locator('.properties-field').filter({ hasText: 'Rotate X' })).toBeVisible()
}

function axisButton(page: Page, axisLabel: string, buttonLabel: string) {
  return page.locator('.properties-field')
    .filter({ hasText: axisLabel })
    .getByRole('button', { name: buttonLabel, exact: true })
}

/**
 * Arms a MutationObserver that latches if the busy overlay ever reaches the
 * DOM. Locator polling cannot do this job: on a small mesh the reposition
 * finishes in a couple of frames, so the overlay is real but too short-lived
 * to catch by sampling. The observer fires on the mutation itself.
 *
 * What this actually guards is the paint yield in ModelOrientationSection —
 * without it React never commits the busy state at all for a manifold mesh,
 * and the app just freezes silently.
 */
async function watchForBusyOverlay(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = window as unknown as { __overlaySeen?: boolean }
    target.__overlaySeen = false
    new MutationObserver(() => {
      if (document.querySelector('.viewport-busy-overlay')) target.__overlaySeen = true
    }).observe(document.body, { childList: true, subtree: true })
  })
}

function busyOverlayWasShown(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { __overlaySeen?: boolean }).__overlaySeen === true)
}

test.describe('imported model 3D orientation', () => {
  test('rotating 90° about X is rigid and updates the sketch silhouette', async ({ app }) => {
    test.setTimeout(90_000)
    await importBox(app.page)

    const before = readModelState(await getProject(app.page))
    expect(before.orientation, 'a freshly imported model carries no orientation').toBeUndefined()
    // Asserted as ratios rather than absolute lengths — the default project is
    // in inches, so the mm fixture arrives scaled.
    const beforeHeight = before.zTop - before.zBottom
    expect(before.silhouetteBounds.width / before.silhouetteBounds.height).toBeCloseTo(BOX_X / BOX_Y, 2)
    expect(beforeHeight / before.silhouetteBounds.height).toBeCloseTo(BOX_Z / BOX_Y, 2)

    await openOrientationSection(app.page)
    await watchForBusyOverlay(app.page)
    await axisButton(app.page, 'Rotate X', '+90°').click()

    // The rotation is async (silhouette re-projection); wait for the commit.
    await expect.poll(
      async () => readModelState(await getProject(app.page)).orientation?.rx ?? null,
      { timeout: 30_000 },
    ).toBe(90)
    expect(await busyOverlayWasShown(app.page), 'busy overlay should reach the DOM').toBe(true)

    const after = readModelState(await getProject(app.page))
    // Standing the box on its side swaps the Y and Z extents. Rigid means the
    // new Z band IS the old Y extent — not the old band with the mesh
    // restretched back into it, which is what a naive implementation produces.
    expect(after.zTop - after.zBottom, 'Z band becomes the old Y extent')
      .toBeCloseTo(before.silhouetteBounds.height, 2)
    expect(after.zBottom, 'the base plane is the anchor').toBeCloseTo(before.zBottom, 3)
    // The sketch top view now looks down at the taller face.
    expect(after.silhouetteBounds.width, 'X is untouched by an X rotation')
      .toBeCloseTo(before.silhouetteBounds.width, 2)
    expect(after.silhouetteBounds.height, 'Y extent becomes the old model height')
      .toBeCloseTo(beforeHeight, 2)
  })

  test('lift moves the model without changing its height', async ({ app }) => {
    test.setTimeout(90_000)
    await importBox(app.page)
    await openOrientationSection(app.page)

    const before = readModelState(await getProject(app.page))
    const liftField = app.page.locator('.properties-field').filter({ hasText: 'Lift' }).locator('input')
    await liftField.fill('7')
    await liftField.press('Enter')

    await expect.poll(
      async () => readModelState(await getProject(app.page)).zBottom,
      { timeout: 10_000 },
    ).toBeCloseTo(7, 3)

    const after = readModelState(await getProject(app.page))
    expect(after.zTop - after.zBottom, 'height is unchanged by a lift').toBeCloseTo(
      before.zTop - before.zBottom,
      3,
    )
  })

  test('reset returns the model to its import orientation', async ({ app }) => {
    test.setTimeout(90_000)
    await importBox(app.page)
    const before = readModelState(await getProject(app.page))

    await openOrientationSection(app.page)
    await axisButton(app.page, 'Rotate Y', '+90°').click()
    await expect.poll(
      async () => readModelState(await getProject(app.page)).orientation?.ry ?? null,
      { timeout: 30_000 },
    ).toBe(90)

    await app.page.getByRole('button', { name: 'Reset to import orientation' }).click()
    await expect.poll(
      async () => readModelState(await getProject(app.page)).orientation ?? 'cleared',
      { timeout: 30_000 },
    ).toBe('cleared')

    const after = readModelState(await getProject(app.page))
    expect(after.zTop - after.zBottom).toBeCloseTo(before.zTop - before.zBottom, 2)
    expect(after.silhouetteBounds.width).toBeCloseTo(before.silhouetteBounds.width, 2)
    expect(after.silhouetteBounds.height).toBeCloseTo(before.silhouetteBounds.height, 2)
  })
})
