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
 * The rotary operations on an imported model in a round bar (issue #1015
 * slice E).
 *
 * The project is the `src/test/rotaryOperationFixture.ts` fixture, written out
 * here rather than imported (that module reaches `src/text`, whose JSON font
 * imports the Playwright runner refuses): the same bar, mesh, Around setup, tool
 * and chuck the engine tests use, with a rotary machine selected and the model
 * left authored on Top, the face an STL import lands on. Through the page the
 * test then adds both rotary operations from "Add to Around", proves each one
 * generated wrapped moves (not merely that the gear says "up to date"), and
 * captures the 3D overlay and the Simulation tab's bar view.
 *
 * What this spec assumes about the page, for the manager to check against the
 * real DOM:
 * - the Around face is active from the seeded `activeSetupId`; the model is a
 *   ghost row there, but the two rotary rows do not depend on the selection
 *   (issue #1015): with nothing selected they are offered directly with `Add`
 *   enabled, and Add targets every imported model in the project, so clicking
 *   `Add` with the model unselected targets the model;
 * - "Add to Around" lists `Rotary rough` and `Rotary finish` as
 *   `.cam-operation-item` rows whose single button is `Add` (a rotary kind
 *   takes no rough/finish split), labelled from `operationAddButtonLabel`;
 * - on the Top face the two rows are absent from the menu entirely, because
 *   `currentSetupFace !== 'around'` gates them out;
 * - `data-toolpath-segments` on the 3D panel's `.viewport-3d` is the drawn
 *   overlay's segment count, and a left-drag of about −60 px orbits the camera;
 * - the Simulation tab reads `data-simulation-view="bar"` for the Around setup
 *   and `data-simulation-removed-cells` counts what the run removed;
 * - the rotary operation's properties carry the model checklist instead of "Use
 *   current selection" (issue #1015 slice K): `[data-rotary-targets]` on the
 *   fieldset, one `input[type=checkbox]` per imported model, `checked` and
 *   `disabled` when it is the only one.
 *
 * Run in the `test:e2e:workflow-ui` lane.
 */

import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { getProject, seedProject } from './helpers'
import { computeMeshBounds, serializeImportedMesh } from '../src/engine/importedMesh'
import { IDENTITY_MATRIX, defaultTool, newProject, rectProfile, roundStock } from '../src/types/project'
import type { MachineDefinition } from '../src/engine/gcode/types'
import type { FeatureDefinition, FeatureInstance, Project, RoundStock } from '../src/types/project'

/**
 * A complete bundled definition plus a rotary axis about x, as the sibling
 * Around specs build it. Read as a file: importing the definitions module would
 * pull JSON imports into the Playwright runner, which Node refuses without an
 * attribute.
 */
function rotaryMachine(): MachineDefinition {
  const grbl = JSON.parse(
    readFileSync(new URL('../src/engine/gcode/definitions/grbl.json', import.meta.url), 'utf8'),
  ) as MachineDefinition
  return {
    ...structuredClone(grbl),
    id: 'e2e-rotary',
    name: 'E2E Rotary Mill',
    builtin: false,
    rotary: { about: 'x', drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
  }
}

/**
 * The `rotaryOperationFixture` project written out here rather than imported:
 * that fixture reaches `src/text`, whose JSON font imports the Playwright runner
 * refuses. The bar, mesh and feature are the fixture's own (a small closed
 * asymmetric prism placed inside a 12 × 30 bar), with the model left authored on
 * Top — the face an STL import lands on — and reachable from Around only as a
 * rotary target. No operation is added: both are created through the page.
 */
function rotaryModelProject(): Project {
  const base = newProject('Rotary model', 'mm')
  base.meta.created = base.meta.modified = '2026-01-01T00:00:00.000Z'
  base.meta.maxTravelZ = 25
  // The Around face and the rotary add-menu belong to a rotary project
  // (issue #1028).
  base.meta.projectType = 'rotary'
  base.stock = roundStock(12, 30, 'x')
  base.tools = [{ ...defaultTool('mm', 1), id: 't1', type: 'ball_endmill', diameter: 2, defaultStepover: 0.8, defaultStepdown: 1 }]
  const positions = new Float32Array([
    3, 4, 4, 27, 4, 4, 27, 8, 4, 3, 8, 4,
    3, 4, 8, 27, 4, 9, 27, 8, 9, 3, 8, 8,
  ])
  const index = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7])
  base.modelAssets = { asset: serializeImportedMesh({ positions, index, bounds: computeMeshBounds(positions) }, 'stl') }
  const definition: FeatureDefinition = {
    id: 'model', kind: 'stl', profile: rectProfile(3, 4, 24, 4), dimensions: [], text: null,
    stl: { format: 'stl', meshAssetId: 'asset', scale: 1, axisSwap: 'none' }, operation: 'model',
  }
  const feature: FeatureInstance = {
    id: 'model', name: 'Model', definitionId: 'model', transform: IDENTITY_MATRIX, textLayout: null,
    constraints: [], z_top: 9, z_bottom: 4, authoringFace: 'top', folderId: null, visible: true, locked: false,
  }
  base.featureDefinitions = { model: definition }
  base.features = [feature]
  base.featureTree = [{ type: 'feature', featureId: 'model' }]
  base.setups = [...base.setups, { ...base.setups[0], id: 'around', name: 'Around', kind: 'around', orientation: { axis: 'x', angleDeg: 0 } }]
  base.activeSetupId = 'around'
  base.clamps = [{ id: 'chuck', name: 'Chuck', type: 'chuck', x: 0, y: 0, w: 2, h: 12, height: 14, visible: true }]
  return base
}

/** The fixture's bar and model, with a rotary machine selected. */
async function seedRotaryModelProject(page: Page): Promise<Project> {
  const project = rotaryModelProject()
  project.meta.machineDefinitions = [...(project.meta.machineDefinitions ?? []), rotaryMachine()]
  project.meta.selectedMachineId = 'e2e-rotary'
  await seedProject(page, JSON.stringify(project))
  return await getProject(page) as unknown as Project
}

interface RotaryPathReadout {
  moveCount: number
  warningCount: number
  allHaveAngle: boolean
  allOnCentreline: boolean
}

/** The generated wrapped path, read the way `around3d.smoke.spec.ts` does. */
async function rotaryPath(page: Page, operationId: string): Promise<RotaryPathReadout> {
  return page.evaluate(async (id) => {
    const storeUrl = '/src/store/projectStore.ts'
    const generateUrl = '/src/engine/toolpaths/generateOperation.ts'
    const projectUrl = '/src/types/project.ts'
    const { useProjectStore } = await import(storeUrl) as typeof import('../src/store/projectStore')
    const { computeOperationToolpath } = await import(generateUrl) as typeof import('../src/engine/toolpaths/generateOperation')
    const { isRoundStock, roundStockCentre } = await import(projectUrl) as typeof import('../src/types/project')
    const project = useProjectStore.getState().project
    const operation = project.operations.find((candidate) => candidate.id === id)
    if (!operation) throw new Error(`e2e: the project has no operation ${id}`)
    const envelope = computeOperationToolpath(project, operation)
    if (!envelope) throw new Error(`e2e: ${id} did not generate`)
    if (!isRoundStock(project.stock)) throw new Error('e2e: the stock is not a bar')
    const centre = roundStockCentre(project.stock)
    const across = project.stock.axis === 'x' ? 'y' : 'x'
    const points = envelope.result.moves.flatMap((move) => [move.from, move.to])
    return {
      moveCount: envelope.result.moves.length,
      warningCount: envelope.result.warnings.length,
      allHaveAngle: points.every((point) => typeof point.a === 'number'),
      allOnCentreline: points.every((point) => Math.abs(point[across] - centre) < 1e-6),
    }
  }, operationId)
}

test('the rotary operation shows the model it machines, checked and locked', async ({ app, ui }) => {
  const { page } = app
  test.setTimeout(60_000)
  await seedRotaryModelProject(page)

  // The Around setup is active from the seed; add the finish operation, which
  // Add selects (so its properties are already on screen).
  await ui.face.segment(page, 'Around').click()
  await ui.setupCam.add(page).click()
  await expect(ui.setupCam.addMenu(page)).toBeVisible()
  await ui.setupCam.addMenu(page).locator('.cam-operation-item')
    .filter({ has: page.getByRole('button', { name: 'Rotary finish', exact: true }) })
    .getByRole('button', { name: 'Add', exact: true }).click()

  // Its target field is the model checklist, not "Use current selection": the
  // model is not selectable on the Around sheet, so the selection could never
  // express it (issue #1015 slice K).
  const properties = page.locator('.cam-operation-properties')
  await expect(properties).toBeVisible()
  const picker = properties.locator('[data-rotary-targets]')
  await expect(picker).toBeVisible()
  await expect(picker.locator('legend')).toHaveText('Models to machine')
  // One model in the fixture: its single box is ticked, and locked so the
  // target can never be emptied.
  const box = picker.locator('input[type="checkbox"]')
  await expect(box).toHaveCount(1)
  await expect(box).toBeChecked()
  await expect(box).toBeDisabled()
  await expect(picker.locator('.properties-check span')).toHaveText('Model')
  await expect(properties.getByRole('button', { name: 'Use current selection', exact: true })).toHaveCount(0)
})

test('the rotary operations machine the model inside the bar', async ({ app, ui }, testInfo) => {
  const { page } = app
  test.setTimeout(120_000)
  const project = await seedRotaryModelProject(page)
  expect((project.stock as RoundStock).shape).toBe('round')

  // The Around setup is active from the seed; the model is a ghost row there,
  // but the rotary rows no longer need it selected.
  await expect(ui.face.segment(page, 'Around')).toHaveAttribute('aria-pressed', 'true')

  // ── "Add to Around" offers both rotary operations ──
  const rotaryRow = (label: 'Rotary rough' | 'Rotary finish') =>
    ui.setupCam.addMenu(page).locator('.cam-operation-item')
      .filter({ has: page.getByRole('button', { name: label, exact: true }) })
  // Nothing is selected, and nothing needs to be: on a round bar in Around the
  // two rows are available whatever the selection, and Add targets every
  // imported model in the project (issue #1015). The seeded project has one.
  const addRotary = async (label: 'Rotary rough' | 'Rotary finish'): Promise<void> => {
    await ui.setupCam.add(page).click()
    await expect(ui.setupCam.addMenu(page)).toBeVisible()
    await expect(rotaryRow(label)).toHaveCount(1)
    await rotaryRow(label).getByRole('button', { name: 'Add', exact: true }).click()
    await expect(ui.operations.rowByName(page, label)).toBeVisible()
  }
  await addRotary('Rotary finish')
  await addRotary('Rotary rough')

  // Each new operation targeted the model, read back from the store.
  const added = await getProject(page) as unknown as Project
  const modelId = added.features.find((feature) => added.featureDefinitions[feature.definitionId]?.kind === 'stl')!.id
  for (const kind of ['rotary_finish', 'rotary_rough'] as const) {
    expect(added.operations.find((operation) => operation.kind === kind)!.target)
      .toEqual({ source: 'features', featureIds: [modelId] })
  }

  // On Top the two rows are not offered at all (the manager's rule 7).
  await ui.face.segment(page, 'Top').click()
  await ui.setupCam.add(page).click()
  await expect(ui.setupCam.addMenu(page)).toBeVisible()
  await expect(ui.setupCam.addMenu(page).locator('.cam-operation-label').filter({ hasText: /^Rotary/ })).toHaveCount(0)
  await page.keyboard.press('Escape')

  // ── Both generated wrapped moves, read back from the store ──
  await ui.face.segment(page, 'Around').click()
  await expect(ui.generation.gearStatus(page)).toHaveAttribute('aria-label', /up to date/, { timeout: 30_000 })
  const after = await getProject(page) as unknown as Project
  const model = after.features.find((feature) => after.featureDefinitions[feature.definitionId]?.kind === 'stl')!
  const aroundSetup = after.setups.find((setup) => setup.kind === 'around')!
  const finish = after.operations.find((operation) => operation.kind === 'rotary_finish')!
  const rough = after.operations.find((operation) => operation.kind === 'rotary_rough')!
  expect(finish.target).toEqual({ source: 'features', featureIds: [model.id] })
  expect(rough.target).toEqual({ source: 'features', featureIds: [model.id] })
  expect(finish.setupId).toBe(aroundSetup.id)
  expect(rough.setupId).toBe(aroundSetup.id)
  for (const operation of [finish, rough]) {
    const generated = await rotaryPath(page, operation.id)
    expect(generated.moveCount).toBeGreaterThan(0)
    expect(generated.warningCount).toBe(0)
    expect(generated.allHaveAngle).toBe(true)
    expect(generated.allOnCentreline).toBe(true)
  }

  // ── 3D: the overlay draws the wrapped passes on the bar ──
  await ui.viewMenu.tab3d(page).click()
  const canvas = ui.viewport3d.canvas(page)
  await expect(canvas).toBeVisible()
  const overlay = ui.viewport3d.overlay(page)
  await expect.poll(
    async () => Number(await overlay.getAttribute('data-toolpath-segments')),
    { timeout: 15_000 },
  ).toBeGreaterThan(0)
  await page.waitForTimeout(500)
  await page.screenshot({ path: testInfo.outputPath('rotary-model-3d-default.png') })

  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  const centrePx = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }
  await page.mouse.move(centrePx.x, centrePx.y)
  await page.mouse.down()
  await page.mouse.move(centrePx.x - 60, centrePx.y - 40, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  await page.screenshot({ path: testInfo.outputPath('rotary-model-3d-low-angle.png') })
  await expect(canvas).toBeVisible()

  // ── Simulation: the Around setup is the bar and the run removes material ──
  await ui.operations.rowByName(page, 'Rotary finish').click()
  await ui.viewMenu.tabSimulation(page).click()
  await expect(ui.simSetup.picker(page)).toBeVisible()
  await ui.simSetup.picker(page).selectOption(aroundSetup.id)
  const viewport = ui.simSetup.viewport(page)
  await expect(viewport).toHaveAttribute('data-simulation-view', 'bar')
  await expect.poll(
    async () => Number(await viewport.getAttribute('data-simulation-removed-cells')),
    { timeout: 30_000 },
  ).toBeGreaterThan(0)
  await page.waitForTimeout(500)
  await page.screenshot({ path: testInfo.outputPath('rotary-model-simulation-bar.png') })
})
