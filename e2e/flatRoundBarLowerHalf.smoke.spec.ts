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
 * The flat round bar's lower half is mounted by both simulation viewport
 * effects (issue #1049, review of the source-string check).
 *
 * The unit tests exercise the scene builder, but only a real mount can prove
 * the static and the playback effect each hand the bar's profile to that
 * builder. A regression that drops `flatRoundBarRef.current` from either call
 * builds a scene with `lowerHalf === null`, so the viewport's
 * `data-simulation-lower-half` / `data-simulation-playback-lower-half`
 * attributes stay unset and these assertions fail.
 *
 * A round-bar Rotary project is created through the New project dialog on its
 * Top setup; a milling block is the control that must never grow a lower half.
 */

import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import {
  cancelPendingAdd,
  createNewProject,
  getProject,
  placePendingAddAt,
  setPendingAddAnchor,
  startAddRectPlacement,
} from './helpers'

type Ui = typeof import('./selectors')

interface ProjectShape {
  meta: { projectType?: string }
  stock: { shape?: string }
}

/** Draw one rectangle in stock coordinates through the store seam. */
async function drawRect(page: Page, x1: number, y1: number, x2: number, y2: number): Promise<void> {
  await startAddRectPlacement(page)
  await setPendingAddAnchor(page, x1, y1)
  await placePendingAddAt(page, x2, y2)
  await cancelPendingAdd(page)
}

/**
 * Add a rough pocket to the selected subtract feature through the CAM Add
 * menu, then select the operation so the simulation runs it in Selected mode.
 */
async function addPocketRoughAndSelect(page: Page, ui: Ui): Promise<void> {
  await ui.setupCam.add(page).click()
  const pocket = ui.setupCam.addMenu(page)
    .locator('.cam-operation-item')
    .filter({ has: page.getByRole('button', { name: 'Pocket', exact: true }) })
  await pocket.getByRole('button', { name: 'Rough', exact: true }).click()
  await expect(ui.operations.rowByName(page, 'Pocket Rough')).toBeVisible()
  await ui.operations.rowByName(page, 'Pocket Rough').click()
}

/** The simulation viewport's mounted-scene evidence (issue #1049). */
async function viewportEvidence(page: Page, ui: Ui): Promise<{
  view: string | null
  surface: string | null
  lowerHalf: string | null
  playbackSurface: string | null
  playbackLowerHalf: string | null
}> {
  const viewport = ui.simSetup.viewport(page)
  return {
    view: await viewport.getAttribute('data-simulation-view'),
    surface: await viewport.getAttribute('data-simulation-surface'),
    lowerHalf: await viewport.getAttribute('data-simulation-lower-half'),
    playbackSurface: await viewport.getAttribute('data-simulation-playback-surface'),
    playbackLowerHalf: await viewport.getAttribute('data-simulation-playback-lower-half'),
  }
}

/** Switch to Simulation and wait for the static heightfield scene to mount. */
async function openSimulation(page: Page, ui: Ui): Promise<void> {
  await ui.viewMenu.tabSimulation(page).click()
  const viewport = ui.simSetup.viewport(page)
  await expect(viewport).toHaveAttribute('data-simulation-view', 'flat')
  await expect(viewport).toHaveAttribute('data-simulation-surface', 'heightfield', { timeout: 60_000 })
}

test('a Rotary round bar mounts the lower half in the static and playback views', async ({ app, ui }) => {
  test.setTimeout(180_000)
  const { page } = app

  await createNewProject(page, ui, { type: 'Rotary', shape: 'Round bar', size: '40', length: '200', axis: 'X' })
  await expect(ui.face.segment(page, 'Top')).toHaveAttribute('aria-pressed', 'true')
  const created = await getProject(page) as unknown as ProjectShape
  expect(created.meta.projectType).toBe('rotary')
  expect(created.stock.shape).toBe('round')

  // A base solid and a pocket inside it: the inner rectangle infers 'subtract',
  // which is what the Pocket operation accepts. Stock is 200 long across X and
  // Ø40 across Y.
  await drawRect(page, 20, 5, 180, 35)
  await drawRect(page, 60, 12, 140, 28)
  await addPocketRoughAndSelect(page, ui)

  await openSimulation(page, ui)
  const viewport = ui.simSetup.viewport(page)
  const staticScene = await viewportEvidence(page, ui)
  expect(staticScene.lowerHalf, 'the static Top view mounts the flat round-bar lower half').toBe('round-bar')
  expect(staticScene.playbackLowerHalf, 'no playback scene is mounted yet').toBeNull()

  // Selected mode is the default; assert the selected operation can play, then
  // mount the playback scene and require the same lower half there.
  await expect(ui.simSetup.modeSelected(page)).toHaveClass(/simulation-mode-toggle__btn--active/)
  await expect(ui.simSetup.playTool(page)).toBeEnabled({ timeout: 60_000 })
  await ui.simSetup.playTool(page).click()
  await expect(ui.simSetup.progress(page)).toBeVisible()
  await expect(viewport).toHaveAttribute('data-simulation-playback-surface', 'heightfield', { timeout: 60_000 })
  const playbackScene = await viewportEvidence(page, ui)
  expect(playbackScene.playbackLowerHalf, 'the playback view mounts the flat round-bar lower half').toBe('round-bar')
  expect(playbackScene.lowerHalf, 'the static scene is disposed while playback is mounted').toBeNull()
})

test('a milling block never mounts a round-bar lower half', async ({ app, ui }) => {
  test.setTimeout(180_000)
  const { page } = app

  await createNewProject(page, ui, { type: 'Milling / routing' })
  await expect(ui.face.segment(page, 'Top')).toHaveAttribute('aria-pressed', 'true')
  const created = await getProject(page) as unknown as ProjectShape
  expect(created.meta.projectType).toBe('milling')
  expect(created.stock.shape).toBeUndefined()

  // Stock is 100 × 80: the same add-base + inner subtract pair as the bar.
  await drawRect(page, 10, 10, 90, 70)
  await drawRect(page, 30, 25, 70, 55)
  await addPocketRoughAndSelect(page, ui)

  await openSimulation(page, ui)
  const viewport = ui.simSetup.viewport(page)
  const staticScene = await viewportEvidence(page, ui)
  expect(staticScene.lowerHalf, 'a block static view mounts no round-bar lower half').toBeNull()

  await expect(ui.simSetup.modeSelected(page)).toHaveClass(/simulation-mode-toggle__btn--active/)
  await expect(ui.simSetup.playTool(page)).toBeEnabled({ timeout: 60_000 })
  await ui.simSetup.playTool(page).click()
  await expect(ui.simSetup.progress(page)).toBeVisible()
  await expect(viewport).toHaveAttribute('data-simulation-playback-surface', 'heightfield', { timeout: 60_000 })
  const playbackScene = await viewportEvidence(page, ui)
  expect(playbackScene.playbackLowerHalf, 'a block playback view mounts no round-bar lower half').toBeNull()
})
