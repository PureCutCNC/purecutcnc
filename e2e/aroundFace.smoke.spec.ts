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
 * The Around face in the workspace (issue #395, slice D1): the face switch on
 * a round bar, its banner, the Around tree layer and chip, Top-style Z
 * properties with no face change, the CAM "Around operations" section and an
 * Around operation that generates, the export program card, and Print
 * disabled on Around.
 *
 * Deliberately not covered here: the Sketch canvas, the 3D view and the
 * Simulation tab — those are separate slices.
 *
 * NOTE: this spec was added without a browser run (slice D1 worker); it has
 * not been executed locally.
 */

import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { defaultTool, newProject, roundStock, type Project } from '../src/types/project'
import {
  cancelPendingAdd,
  getProject,
  placePendingAddAt,
  seedProject,
  setPendingAddAnchor,
  startAddRectPlacement,
} from './helpers'

interface SavedFeature {
  id: string
  authoringFace?: string
  definitionId: string
  operation?: string
}

/** A mm round bar with (optionally) a rotary machine along its X axis. */
function aroundProject(options: { rotary: boolean }): Project {
  const base = newProject('Around smoke', 'mm')
  // Read as a file: importing the machine registry would pull JSON imports
  // into the Playwright runner, which Node refuses without an attribute.
  const grbl = JSON.parse(
    readFileSync(new URL('../src/engine/gcode/definitions/grbl.json', import.meta.url), 'utf8'),
  ) as Project['meta']['machineDefinitions'][number]
  const machine = { ...grbl, id: 'around-machine', builtin: false }
  base.stock = roundStock(25, 120, 'x')
  base.meta = {
    ...base.meta,
    machineDefinitions: options.rotary
      ? [{ ...machine, rotary: { about: 'x', drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } } }]
      : [machine],
    selectedMachineId: options.rotary ? 'around-machine' : machine.id,
  }
  base.tools = [{ ...defaultTool('mm', 1), id: 't1', diameter: 3, maxCutDepth: 20 }]
  return base
}

function featureRow(page: Page, id: string) {
  return page.locator(`.tree-row--feature[data-feature-id="${id}"]`)
}

/** Draw a rectangle in unrolled stock coordinates (the bar is 120 long, Ø25). */
async function drawRect(page: Page, x1: number, y1: number, x2: number, y2: number): Promise<void> {
  await startAddRectPlacement(page)
  await setPendingAddAnchor(page, x1, y1)
  await placePendingAddAt(page, x2, y2)
  await cancelPendingAdd(page)
}

test('a block stock shows exactly the switch it always had: no Around segment', async ({ app, ui }) => {
  const { page } = app
  // The default project is a block.
  await expect(ui.face.segment(page, 'Top')).toBeVisible()
  await expect(ui.face.segment(page, 'Bottom')).toBeVisible()
  await expect(ui.face.segment(page, 'Around')).toHaveCount(0)
})

test('a round bar without a rotary machine shows Around disabled, saying what is missing', async ({ app, ui }) => {
  const { page } = app
  await seedProject(page, JSON.stringify(aroundProject({ rotary: false })))

  const around = ui.face.segment(page, 'Around')
  await expect(around).toBeVisible()
  await expect(around).toBeDisabled()
  await expect(around).toHaveAttribute('title', 'Around needs a machine with a rotary axis. Set one in the machine editor.')
  // Nothing was created by merely looking at the segment.
  await expect(ui.face.segment(page, 'Top')).toHaveAttribute('aria-pressed', 'true')
})

test('Around on a rotary bar: banner, tree layer, Z properties, CAM, export and Print', async ({ app, ui }) => {
  const { page } = app
  await seedProject(page, JSON.stringify(aroundProject({ rotary: true })))

  // ── The switch, the banner and the empty Around layer ──
  await ui.face.segment(page, 'Around').click()
  await expect(ui.face.segment(page, 'Around')).toHaveAttribute('aria-pressed', 'true')
  await expect(ui.face.segment(page, 'Around')).toHaveAttribute('title', 'Work around the bar')
  await expect(ui.face.banner(page)).toContainText('The bar turns in the rotary.')
  await expect(ui.face.banner(page)).toContainText('Drawing on the surface of the bar')
  // A flat face and Around share no plane: the other-side toggle is gone.
  await expect(ui.face.otherSideToggle(page)).toHaveCount(0)

  // ── A base and a pocket target, both Around ──
  await drawRect(page, 10, 5, 100, 15)
  await drawRect(page, 20, 8, 40, 12)
  const drawn = await getProject(page)
  const features = drawn.features as SavedFeature[]
  // A feature's operation lives on its shared definition, not on the instance.
  const definitions = drawn.featureDefinitions as Record<string, { operation?: string }>
  expect(features).toHaveLength(2)
  for (const feature of features) {
    expect(feature.authoringFace).toBe('around')
    // The bar is already solid, so a shape drawn on it is a cut, never a base.
    expect(definitions[(feature as unknown as { definitionId: string }).definitionId]?.operation).toBe('subtract')
  }
  // The tree shows its face layers once the project has a feature; before that
  // it shows its empty message.
  await expect(ui.face.layer(page, 'around')).toHaveAttribute('data-face-state', 'active')
  await expect(ui.face.layer(page, 'around')).toContainText('Around')
  // An Around subtract takes no part in the solid: no "first feature must be Add".
  await expect(ui.tree.warning(page)).toHaveCount(0)
  await expect(featureRow(page, features[1].id)).toBeVisible()

  // ── Properties: ordinary Top-style Z controls, and no Change face row ──
  await featureRow(page, features[1].id).click()
  await page.locator('.properties-panel').getByRole('button', { name: 'Instance', exact: true }).click()
  await expect(page.locator('.properties-panel .z-range-slider')).toBeVisible()
  await expect(page.locator('.properties-panel .face-z-range')).toHaveCount(0)
  await expect(page.locator('.properties-panel .face-row .face-chip--around')).toBeVisible()
  await expect(page.locator('.properties-panel .face-row').getByRole('button', { name: 'Change…' })).toHaveCount(0)

  // ── CAM: "Around operations" and "Add to Around" adds a pocket that generates ──
  await expect(ui.setupCam.section(page, 'around')).toContainText('Around operations')
  await expect(ui.setupCam.section(page, 'around')).toContainText('Bar in the rotary')
  await ui.setupCam.add(page).click()
  await expect(ui.setupCam.addMenu(page)).toBeVisible()
  // An Around setup gets no cross-face target picker.
  await expect(ui.setupCam.addMenu(page).locator('.cam-cross-face-picker')).toHaveCount(0)
  const pocketRow = ui.setupCam.addMenu(page)
    .locator('.cam-operation-item')
    .filter({ has: page.getByRole('button', { name: 'Pocket', exact: true }) })
  // A pocket offers its passes rather than a single Add.
  await pocketRow.getByRole('button', { name: 'Rough', exact: true }).click()
  await expect(ui.operations.rowByName(page, 'Pocket Rough')).toBeVisible()
  await expect(ui.generation.gearStatus(page)).toHaveAttribute('aria-label', /up to date/, { timeout: 30_000 })
  const withOperation = await getProject(page)
  const aroundSetupId = (withOperation.setups as Array<{ id: string; kind?: string }>).find((setup) => setup.kind === 'around')!.id
  expect((withOperation.operations as Array<{ kind: string; setupId?: string }>)[0]).toMatchObject({ kind: 'pocket', setupId: aroundSetupId })

  // ── Export: the Around setup is its own group and program card ──
  await ui.operations.headerExportButton(page).click()
  await expect(ui.exportDialog.setupHeading(page, 'around')).toContainText('Around')
  await expect(ui.exportDialog.programCard(page, 'around')).toBeVisible()
  // Escape does not close this dialog; its header button does.
  await ui.exportDialog.root(page).locator('.dialog-header').getByRole('button').last().click()
  await expect(ui.exportDialog.root(page)).toBeHidden()

  // ── Print is disabled on Around, saying why ──
  await expect(ui.toolbar.printButton(page).first()).toBeDisabled()
  await expect(ui.toolbar.printButton(page).first()).toHaveAttribute('aria-label', 'Printing shows the flat faces. Switch to the top or bottom face to print.')

  // ── A flat face sees the Around features as ghosts that name their face ──
  await ui.face.segment(page, 'Top').click()
  await expect(ui.face.ghostRows(page)).toHaveCount(2)
  await expect(ui.face.ghostRows(page).first()).toHaveAttribute('title', 'On the around face. Switch to it to edit.')
  await ui.face.ghostRows(page).first().click({ button: 'right' })
  await expect(page.getByRole('button', { name: 'Switch to around face to edit' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Change authoring face…' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  // From a flat face Print works as it did.
  await expect(ui.toolbar.printButton(page).first()).toBeEnabled()
})
