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
 *   normal selectable row there now (issue #1112 I), and the two rotary rows do
 *   not depend on the selection
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
 * - a square blank draws the same heightfield as the round bar, so the tab
 *   reports `data-simulation-surface="heightfield"`; during playback it also
 *   reports the live grid's progress, removed cells and minimum Z, which is how
 *   the square playback test proves progress 0 is the prior rough, not virgin
 *   stock (issue #1016 C2);
 * - the rotary operation's properties carry the Cuts list (issue #1112 I):
 *   `[data-operation-cuts]`, one `[data-cut-feature-id]` row per current
 *   target, the target's own `.cam-cuts__icon` and `.cam-cuts__name` inside it,
 *   and a remove × that is disabled when removing the row would empty the
 *   operation. The name is asserted *visible*, not merely present: the panel's
 *   field rule used to stretch the × over the row and squeeze the name to
 *   nothing (issue #1112 rt3-a, item 25). A selected model narrows the target
 *   and a selected Around region joins it as a filter through "Use current
 *   selection".
 *
 * Run in the `test:e2e:workflow-ui` lane.
 */

import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { getProject, seedProject, selectFeatures } from './helpers'
import { computeMeshBounds, serializeImportedMesh } from '../src/engine/importedMesh'
import { defaultRoundWorkholding } from '../src/store/helpers/roundWorkholding'
import { IDENTITY_MATRIX, defaultTool, newProject, rectProfile, roundStock } from '../src/types/project'
import { barMaxRadius, squareStock } from '../src/types/barStock'
import type { MachineDefinition } from '../src/engine/gcode/types'
import type { FeatureDefinition, FeatureInstance, Project, RotaryPassDirection, RoundStock, SquareStock } from '../src/types/project'

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
function rotaryModelProject(options: { secondModel?: boolean } = {}): Project {
  const base = newProject('Rotary model', 'mm')
  base.meta.created = base.meta.modified = '2026-01-01T00:00:00.000Z'
  base.meta.maxTravelZ = 25
  // The Around face and the rotary add-menu belong to a rotary project
  // (issue #1028).
  base.meta.projectType = 'rotary'
  const bar = roundStock(12, 30, 'x')
  base.stock = bar
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
  if (options.secondModel) {
    // A second imported model, so a rotary operation can target one and leave
    // the other unchecked. Adding a region then proves the model choice is
    // kept (#1096 re-review, P2).
    const secondDefinition: FeatureDefinition = { ...definition, id: 'second' }
    const secondFeature: FeatureInstance = {
      ...feature, id: 'second', name: 'Second', definitionId: 'second',
    }
    base.featureDefinitions = { ...base.featureDefinitions, second: secondDefinition }
    base.features = [...base.features, secondFeature]
    base.featureTree = [...base.featureTree, { type: 'feature', featureId: 'second' }]
  }
  // A closed Around region, selectable on the sheet: the rotary operation's
  // "Use current selection" adds it to the target as a mask, so the test can
  // exercise the region addition rather than only the button's presence
  // (#1096).
  const regionDefinition: FeatureDefinition = {
    id: 'region', kind: 'rect', profile: rectProfile(8, 5, 12, 2), dimensions: [], text: null,
    stl: null, operation: 'region',
  }
  const region: FeatureInstance = {
    id: 'region', name: 'Region', definitionId: 'region', transform: IDENTITY_MATRIX, textLayout: null,
    constraints: [], z_top: 12, z_bottom: 0, authoringFace: 'around', folderId: null, visible: true, locked: false,
  }
  base.featureDefinitions = { ...base.featureDefinitions, region: regionDefinition }
  base.features = [...base.features, region]
  base.featureTree = [...base.featureTree, { type: 'feature', featureId: 'region' }]
  base.setups = [...base.setups, { ...base.setups[0], id: 'around', name: 'Around', kind: 'around', orientation: { axis: 'x', angleDeg: 0 } }]
  base.activeSetupId = 'around'
  // The app's own workholding for this bar, not an arbitrary 12 mm block: the
  // cache test turns the same physical box square, and a chuck that did not
  // clear the square corner envelope would make the accepted S4 output guard
  // refuse every pass the test claims (issue #1016 C2-U2F).
  base.clamps = [{ id: 'chuck', name: 'Chuck', visible: true, ...defaultRoundWorkholding('chuck', bar, 'mm') }]
  return base
}

/** The fixture's bar and model, with a rotary machine selected. */
async function seedRotaryModelProject(
  page: Page,
  options: { secondModel?: boolean } = {},
): Promise<Project> {
  const project = rotaryModelProject(options)
  project.meta.machineDefinitions = [...(project.meta.machineDefinitions ?? []), rotaryMachine()]
  project.meta.selectedMachineId = 'e2e-rotary'
  await seedProject(page, JSON.stringify(project))
  return await getProject(page) as unknown as Project
}

interface RotaryPathReadout {
  moveCount: number
  warningCodes: string[]
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
      warningCodes: envelope.result.warnings.map((warning) => warning.code),
      allHaveAngle: points.every((point) => typeof point.a === 'number'),
      allOnCentreline: points.every((point) => Math.abs(point[across] - centre) < 1e-6),
    }
  }, operationId)
}

interface RotaryPassReadout {
  moveCount: number
  pointCount: number
  angleCount: number
  minAngle: number
  maxAngle: number
  signature: number
  warningCodes: string[]
}

/**
 * The generated path of one rotary operation, read from the store's own
 * project, with the A range and a deterministic signature of the move list
 * (#1045 slice B).
 *
 * `passDirection` overrides the stored Passes value, so the along result can be
 * compared against the same operation after the control has written 'around'.
 * The signature is an FNV-1a hash of the rounded points rather than an array of
 * thousands of moves: it still differs when any move differs, and it keeps the
 * evaluate payload small.
 */
async function rotaryPassReadout(
  page: Page,
  operationId: string,
  passDirection: RotaryPassDirection | null = null,
): Promise<RotaryPassReadout> {
  return page.evaluate(async ({ id, direction }) => {
    const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('../src/store/projectStore')
    const { computeOperationToolpath } = await import('/src/engine/toolpaths/generateOperation.ts') as typeof import('../src/engine/toolpaths/generateOperation')
    const project = useProjectStore.getState().project
    const stored = project.operations.find((candidate) => candidate.id === id)
    if (!stored) throw new Error(`e2e: the project has no operation ${id}`)
    const operation = direction === null ? stored : { ...stored, rotaryPassDirection: direction }
    const envelope = computeOperationToolpath(project, operation)
    if (!envelope) throw new Error(`e2e: ${id} did not generate`)

    let hash = 2166136261
    const mix = (text: string): void => {
      for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i)
        hash = Math.imul(hash, 16777619)
      }
    }
    const points = envelope.result.moves.flatMap((move) => [move.from, move.to])
    for (const move of envelope.result.moves) {
      mix(`${move.kind}|`)
      for (const point of [move.from, move.to]) {
        mix(`${point.x.toFixed(5)},${point.y.toFixed(5)},${point.z.toFixed(5)},${point.a === undefined ? 'none' : point.a.toFixed(4)};`)
      }
    }
    const angles = points
      .map((point) => point.a)
      .filter((angle): angle is number => typeof angle === 'number')
    return {
      moveCount: envelope.result.moves.length,
      pointCount: points.length,
      angleCount: angles.length,
      minAngle: angles.length > 0 ? Math.min(...angles) : Number.NaN,
      maxAngle: angles.length > 0 ? Math.max(...angles) : Number.NaN,
      signature: hash >>> 0,
      warningCodes: envelope.result.warnings.map((warning) => warning.code),
    }
  }, { id: operationId, direction: passDirection })
}

test('the rotary operation lists the model it machines in Cuts, last target kept', async ({ app, ui }) => {
  const { page } = app
  test.setTimeout(60_000)
  await seedRotaryModelProject(page)

  // The Around setup is active from the seed; add the finish operation, which
  // Add selects (so its properties are already on screen).
  await ui.face.switchTo(page, 'Around')
  await ui.setupCam.add(page).click()
  await expect(ui.setupCam.addMenu(page)).toBeVisible()
  await ui.setupCam.addMenu(page).locator('.cam-operation-item')
    .filter({ has: page.getByRole('button', { name: 'Rotary finish', exact: true }) })
    .getByRole('button', { name: 'Add', exact: true }).click()

  // The Cuts list shows the current target only -- the model Add chose -- and
  // no candidate checkboxes: the model is a normal selectable row now, so
  // selection is how it is picked (issue #1112 I). The one model is the
  // operation's last target, so its remove × is refused.
  const properties = page.locator('.cam-operation-properties')
  await expect(properties).toBeVisible()
  const cuts = properties.locator('[data-operation-cuts]')
  await expect(cuts).toBeVisible()
  await expect(cuts.getByText('Cuts', { exact: true })).toBeVisible()
  await expect(cuts.locator('[data-cut-feature-id]')).toHaveCount(1)
  const modelRow = cuts.locator('[data-cut-feature-id="model"]')
  await expect(modelRow).toContainText('Model')
  // The row reads as what it cuts: a visible icon and a visible name, with the
  // × a small control at the end of the row rather than the whole row
  // (issue #1112 rt3-a, item 25).
  await expect(modelRow.locator('.cam-cuts__name')).toBeVisible()
  await expect(modelRow.locator('.cam-cuts__name')).toHaveText('Model')
  await expect(modelRow.locator('.cam-cuts__icon')).toBeVisible()
  const remove = modelRow.locator('.cam-cuts__remove')
  await expect(remove).toBeDisabled()
  await expect(remove).toHaveAttribute('title', 'An operation must cut at least one target')
  const apply = properties.getByRole('button', { name: 'Use current selection', exact: true })
  await expect(apply).toHaveCount(1)

  // #1096: add the seeded Around region through the control. The region note
  // renders only when the operation's target carries a region, so it is the
  // observable that the click wrote the filter; the model row must still be
  // there (adding a region does not reset the model choice). Selecting a
  // feature leaves the operation selected, so the properties stay on screen.
  await expect(properties.locator('.cam-region-note')).toHaveCount(0)
  await selectFeatures(page, ['region'])
  await expect(properties).toBeVisible()
  await apply.click()
  await expect(properties.locator('.cam-region-note')).toBeVisible()
  await expect(cuts.locator('[data-cut-feature-id="model"]')).toBeVisible()
  const regionRow = cuts.locator('[data-cut-feature-id="region"]')
  await expect(regionRow).toContainText('Region')
  await expect(regionRow).toHaveAttribute('data-cut-filter', 'true')
})

test('removing a model from Cuts keeps the rotary operation\'s other model', async ({ app, ui }) => {
  const { page } = app
  test.setTimeout(60_000)
  await seedRotaryModelProject(page, { secondModel: true })

  // Add the finish: the Add route targets every imported model, so both are
  // rows in Cuts.
  await ui.face.switchTo(page, 'Around')
  await ui.setupCam.add(page).click()
  await expect(ui.setupCam.addMenu(page)).toBeVisible()
  await ui.setupCam.addMenu(page).locator('.cam-operation-item')
    .filter({ has: page.getByRole('button', { name: 'Rotary finish', exact: true }) })
    .getByRole('button', { name: 'Add', exact: true }).click()

  const properties = page.locator('.cam-operation-properties')
  await expect(properties).toBeVisible()
  const cuts = properties.locator('[data-operation-cuts]')
  await expect(cuts).toBeVisible()
  const modelRow = cuts.locator('[data-cut-feature-id="model"]')
  const secondRow = cuts.locator('[data-cut-feature-id="second"]')
  await expect(modelRow).toBeVisible()
  await expect(secondRow).toBeVisible()

  // Target only "Model": removing "Second" from Cuts is how a model is kept
  // out now that the checklist is gone. With one model left its remove × is
  // refused, exactly as the last checklist box was locked.
  await secondRow.locator('.cam-cuts__remove').click()
  await expect(secondRow).toHaveCount(0)
  await expect(modelRow).toBeVisible()
  await expect(modelRow.locator('.cam-cuts__remove')).toBeDisabled()

  // Selecting the region must not toggle the operation off. It stays selected,
  // its properties stay on screen, and "Use current selection" adds the region
  // while keeping the model choice.
  await selectFeatures(page, ['region'])
  await expect(properties).toBeVisible()
  const apply = properties.getByRole('button', { name: 'Use current selection', exact: true })
  await expect(apply).toHaveCount(1)
  await apply.click()
  await expect(properties.locator('.cam-region-note')).toBeVisible()
  await expect(modelRow).toBeVisible()
  await expect(secondRow).toHaveCount(0)
  await expect(cuts.locator('[data-cut-feature-id="region"]')).toHaveAttribute('data-cut-filter', 'true')

  // The target itself: the region joined it, "Model" stayed, and the removed
  // "Second" did not come back.
  const project = await getProject(page) as unknown as Project
  const operation = project.operations.find((candidate) => candidate.kind === 'rotary_finish')
  expect(operation).toBeDefined()
  expect(operation!.target.source).toBe('features')
  if (operation!.target.source === 'features') {
    expect(operation!.target.featureIds).toContain('model')
    expect(operation!.target.featureIds).toContain('region')
    expect(operation!.target.featureIds).not.toContain('second')
  }
})

test('the rotary operations machine the model inside the bar', async ({ app, ui }, testInfo) => {
  const { page } = app
  test.setTimeout(120_000)
  const project = await seedRotaryModelProject(page)
  expect((project.stock as RoundStock).shape).toBe('round')

  // The Around setup is active from the seed; the model is a normal row there
  // (not a ghost, issue #1112 I), but the rotary rows do not need it selected.
  await expect(ui.face.current(page)).toHaveAttribute('data-face', 'around')

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
  await ui.face.switchTo(page, 'Top')
  await ui.setupCam.add(page).click()
  await expect(ui.setupCam.addMenu(page)).toBeVisible()
  await expect(ui.setupCam.addMenu(page).locator('.cam-operation-label').filter({ hasText: /^Rotary/ })).toHaveCount(0)
  await page.keyboard.press('Escape')

  // ── Both generated wrapped moves, read back from the store ──
  await ui.face.switchTo(page, 'Around')
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
  // The finish was added before the rough, so no rough precedes it in the
  // setup: it carries the advisory "no rough before this finish" (#1045).
  for (const [operation, codes] of [[finish, ['rotaryFinishWithoutRough']], [rough, []]] as const) {
    const generated = await rotaryPath(page, operation.id)
    expect(generated.moveCount).toBeGreaterThan(0)
    expect(generated.warningCodes).toEqual(codes)
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
  await selectOperationRow(page, ui, 'Rotary finish')
  await ui.viewMenu.tabSimulation(page).click()
  // The Around operation is cut in the Around setup, so selecting it puts the
  // workspace on that face and the simulation follows it (issue #1112 F3).
  await expect(ui.face.current(page)).toHaveAttribute('data-face', 'around')
  const viewport = ui.simSetup.viewport(page)
  await expect(viewport).toHaveAttribute('data-simulation-setup', aroundSetup.id)
  await expect(viewport).toHaveAttribute('data-simulation-view', 'bar')
  await expect.poll(
    async () => Number(await viewport.getAttribute('data-simulation-removed-cells')),
    { timeout: 30_000 },
  ).toBeGreaterThan(0)
  await page.waitForTimeout(500)
  await page.screenshot({ path: testInfo.outputPath('rotary-model-simulation-bar.png') })
})

/**
 * #1045 slice B: the Passes control switches a rotary operation between passes
 * along the bar and rings around it. The DOM proves the control exists and
 * writes the operation; the generated path proves the generator honoured it —
 * every point still carries A within one turn, and the move list is not the
 * along list merely relabelled.
 */
test('the rotary finish can run its passes around the bar', async ({ app, ui }) => {
  test.setTimeout(180_000)
  const { page } = app
  await seedRotaryModelProject(page)
  await expect(ui.face.current(page)).toHaveAttribute('data-face', 'around')
  await addRotaryOperation(page, ui, 'Rotary finish')
  await expect(ui.generation.gearStatus(page)).toHaveAttribute('aria-label', /up to date/, { timeout: 60_000 })
  await expect(ui.generation.pendingOperationBadges(page)).toHaveCount(0)

  const added = await getProject(page) as unknown as Project
  const finish = added.operations.find((operation) => operation.kind === 'rotary_finish')!
  // A new operation leaves the field absent: missing IS along, the motion every
  // saved rotary operation was cut with (#1045 slice A).
  expect(finish.rotaryPassDirection).toBeUndefined()
  const along = await rotaryPassReadout(page, finish.id)
  expect(along.moveCount).toBeGreaterThan(0)
  // A finish on its own carries the advisory "no rough before this finish" (#1045).
  expect(along.warningCodes).toEqual(['rotaryFinishWithoutRough'])

  // #1112 C2: on a rotary operation the radial stock reference is the bar
  // cross-section, not the pocket-wall picture milling shows. The exact
  // geometry is pinned by OperationParameterReference.test.ts; here the DOM
  // proves the CAMPanel row chose the rotary variant.
  const stockRadial = ui.cam.operationField(page, 'Stock to leave radial')
  await expect(stockRadial).toBeVisible()
  const radialPicture = stockRadial.locator('svg.op-param-ref')
  await expect(radialPicture).toHaveCount(1)
  await expect(radialPicture).toBeVisible()
  await expect(radialPicture).toHaveAttribute('aria-label', 'Stock radial reference')
  const radialMarkup = await radialPicture.innerHTML()
  expect(radialMarkup).toContain('m-12 0a12 11')
  expect(radialMarkup).not.toContain('M8 7h42v20H8z')
  // #1112 decision 8.16: the rotary picture carries the "walls are radial"
  // limit note; the flat pocket picture does not.
  await expect(stockRadial.locator('.op-param-ref-note')).toHaveText('Walls are radial')

  // The Passes control lives in the collapsed Strategy group. Add selected the
  // operation, so its properties are already on screen; clicking its row again
  // would deselect it and close them.
  await ui.cam.operationGroup(page, 'Strategy').click()
  const passes = ui.cam.operationField(page, 'Passes')
  await expect(passes).toBeVisible()
  await expect(passes.locator('.ui-select__label')).toHaveText('Along the bar')

  // #1112 C2: the Passes field carries a reference picture that must swap with
  // the direction rather than stay on the along drawing. The unit test owns
  // which marker belongs to which direction; here the live DOM proves the
  // render site passes the stored value through as the variant, so each
  // direction carries its own arrow and not the other one.
  const passesPicture = passes.locator('svg.op-param-ref')
  await expect(passesPicture).toHaveCount(1)
  await expect(passesPicture).toBeVisible()
  await expect(passesPicture).toHaveAttribute('aria-label', 'Passes reference')
  await expect(passesPicture.locator('[data-arrow="along-bar"]')).toHaveCount(1)
  await expect(passesPicture.locator('[data-arrow="around-bar"]')).toHaveCount(0)
  const alongPicture = await passesPicture.innerHTML()
  expect(alongPicture.length).toBeGreaterThan(0)

  await passes.locator('.ui-select__trigger').click()
  await page.getByRole('option', { name: 'Around the bar', exact: true }).click()
  await expect(passes.locator('.ui-select__label')).toHaveText('Around the bar')
  await expect(passesPicture.locator('[data-arrow="around-bar"]')).toHaveCount(1)
  await expect(passesPicture.locator('[data-arrow="along-bar"]')).toHaveCount(0)
  const aroundPicture = await passesPicture.innerHTML()
  expect(aroundPicture).not.toBe(alongPicture)

  // The control wrote the operation, and generation settled on the new motion.
  await expect(ui.generation.gearStatus(page)).toHaveAttribute('aria-label', /up to date/, { timeout: 60_000 })
  await expect(ui.generation.pendingOperationBadges(page)).toHaveCount(0)
  const changed = await getProject(page) as unknown as Project
  expect(changed.operations.find((operation) => operation.kind === 'rotary_finish')!.rotaryPassDirection).toBe('around')

  const around = await rotaryPassReadout(page, finish.id)
  expect(around.warningCodes).toEqual(['rotaryFinishWithoutRough'])
  expect(around.moveCount).toBeGreaterThan(0)
  // Every point of the around path turns, and one operation never leaves the
  // first turn: the ring alternation keeps A inside [0, 360].
  expect(around.angleCount).toBe(around.pointCount)
  expect(around.minAngle).toBeGreaterThanOrEqual(0)
  expect(around.maxAngle).toBeLessThanOrEqual(360)
  // Rings at one along position are not the along pass with a different label.
  expect(around.signature).not.toBe(along.signature)
})

// ── #1016 C2: square blanks and the generation cache ────────────────
//
// The generated geometry is what the preview and the simulation show, so these
// read the real `computeOperationToolpath` paths back from the live project.
// "Up to date" on the gear is not proof of motion, and a cached round path
// surviving a stock change would be exactly the failure this pins.

interface PathSignature {
  moveCount: number
  cutMoveCount: number
  minZ: number
  maxZ: number
  minAlong: number
  maxAlong: number
  cutMinAlong: number
  cutMaxAlong: number
  hasAngle: boolean
}

/** The generated path of one operation, with along/Z extents and cut-only bounds. */
async function pathSignature(page: Page, operationId: string): Promise<PathSignature> {
  return page.evaluate(async (id) => {
    const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('../src/store/projectStore')
    const { computeOperationToolpath } = await import('/src/engine/toolpaths/generateOperation.ts') as typeof import('../src/engine/toolpaths/generateOperation')
    const project = useProjectStore.getState().project
    const operation = project.operations.find((candidate) => candidate.id === id)
    if (!operation) throw new Error(`e2e: the project has no operation ${id}`)
    const envelope = computeOperationToolpath(project, operation)
    if (!envelope) throw new Error(`e2e: ${id} did not generate`)
    const axis = project.stock.axis
    const alongOf = (point: { x: number; y: number }): number => (axis === 'x' ? point.x : point.y)
    let minZ = Number.POSITIVE_INFINITY
    let maxZ = Number.NEGATIVE_INFINITY
    let minAlong = Number.POSITIVE_INFINITY
    let maxAlong = Number.NEGATIVE_INFINITY
    let cutMinAlong = Number.POSITIVE_INFINITY
    let cutMaxAlong = Number.NEGATIVE_INFINITY
    let cutMoveCount = 0
    let hasAngle = true
    for (const move of envelope.result.moves) {
      if (move.kind === 'cut') {
        cutMoveCount += 1
        cutMinAlong = Math.min(cutMinAlong, alongOf(move.from), alongOf(move.to))
        cutMaxAlong = Math.max(cutMaxAlong, alongOf(move.from), alongOf(move.to))
      }
      for (const point of [move.from, move.to]) {
        minZ = Math.min(minZ, point.z)
        maxZ = Math.max(maxZ, point.z)
        minAlong = Math.min(minAlong, alongOf(point))
        maxAlong = Math.max(maxAlong, alongOf(point))
        if (typeof point.a !== 'number') hasAngle = false
      }
    }
    return {
      moveCount: envelope.result.moves.length,
      cutMoveCount,
      minZ, maxZ, minAlong, maxAlong, cutMinAlong, cutMaxAlong, hasAngle,
    }
  }, operationId)
}

/** What one operation generates right now: moves, or a refusal. */
async function generationOutcome(page: Page, operationId: string): Promise<{ moveCount: number; warningCodes: string[] }> {
  return page.evaluate(async (id) => {
    const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('../src/store/projectStore')
    const { computeOperationToolpath } = await import('/src/engine/toolpaths/generateOperation.ts') as typeof import('../src/engine/toolpaths/generateOperation')
    const project = useProjectStore.getState().project
    const operation = project.operations.find((candidate) => candidate.id === id)
    if (!operation) throw new Error(`e2e: the project has no operation ${id}`)
    const envelope = computeOperationToolpath(project, operation)
    if (!envelope) return { moveCount: 0, warningCodes: [] }
    return {
      moveCount: envelope.result.moves.length,
      warningCodes: envelope.result.warnings.map((warning) => warning.code),
    }
  }, operationId)
}

/**
 * A square blank of side 25 mm and length 120 mm along X, an Around setup and a
 * rotary machine: the real starting box of a square-to-round job. No model yet
 * — the UI's Square to round creates the finished round target. The clamp is
 * the app's default round workholding for this blank, which clears the square
 * corner envelope and sits at the true pivot (`side / 2`); a manual chuck only
 * as wide as the side would clash with the corners the accepted S4 guard
 * checks (issue #1016 C2-U2F). Its grip is the existing start-end clearance,
 * so the generated cut range is shortened by the normal end-support rule.
 */
async function seedSquareBlankProject(page: Page): Promise<Project> {
  const base = newProject('Rotary square', 'mm')
  base.meta.created = base.meta.modified = '2026-01-01T00:00:00.000Z'
  base.meta.maxTravelZ = 60
  base.meta.projectType = 'rotary'
  const blank = squareStock(25, 120, 'x')
  base.stock = blank
  base.tools = [{
    ...defaultTool('mm', 1), id: 't1', name: 'Flat 6', type: 'flat_endmill',
    // A rotary stepover is a *fraction of the tool diameter* (0.4 × 6 = 2.4 mm),
    // not a distance: the old 3 stepped 18 mm and left ridges the simulated
    // band showed as un-cut cells. 0.4 is the value whose coverage the tests
    // below pin (issue #1016 C2 correction D2).
    diameter: 6, defaultStepover: 0.4, defaultStepdown: 2,
  }, {
    // Rotary operations prefer a ball endmill. With only the flat above, the
    // CAM Add menu imports the library's 4 mm ball at a 0.067 finishing
    // stepover, ~30x the passes, and the spec spends its time redrawing them
    // (issue #1139). This ball is the cutter the Add menu picks from the
    // project instead, importing nothing. A ball leaves scallops a flat does
    // not: to keep them under the 0.05 mm the coverage check below allows, a
    // 6 mm ball needs a stepover under ~1.1 mm, so 0.15 x 6 = 0.9 mm.
    ...defaultTool('mm', 2), id: 't2', name: 'Ball 6', type: 'ball_endmill',
    diameter: 6, defaultStepover: 0.15, defaultStepdown: 2,
  }]
  base.clamps = [{ id: 'chuck', name: 'Chuck', visible: true, ...defaultRoundWorkholding('chuck', blank, 'mm') }]
  base.setups = [
    ...base.setups,
    { ...base.setups[0], id: 'around', name: 'Around', kind: 'around', orientation: { axis: 'x', angleDeg: 0 } },
  ]
  base.activeSetupId = 'around'
  base.meta.machineDefinitions = [rotaryMachine()]
  base.meta.selectedMachineId = 'e2e-rotary'
  await seedProject(page, JSON.stringify(base))
  return await getProject(page) as unknown as Project
}

/** Open the creation drawer, where the Turn and Polygon entries live. */
async function openCreationDrawer(page: Page): Promise<void> {
  const drawer = page.locator('.toolbar-creation-picker__drawer')
  if ((await drawer.count()) === 0 || !(await drawer.isVisible())) {
    await page.locator('.toolbar-creation-picker__drawer-btn').click()
  }
  await expect(drawer).toBeVisible()
}

/** Add a rotary operation through the real Add menu, the way a user does. */
async function addRotaryOperation(page: Page, ui: typeof import('./selectors'), label: 'Rotary rough' | 'Rotary finish'): Promise<void> {
  const row = ui.setupCam.addMenu(page).locator('.cam-operation-item')
    .filter({ has: page.getByRole('button', { name: label, exact: true }) })
  await ui.setupCam.add(page).click()
  await expect(ui.setupCam.addMenu(page)).toBeVisible()
  await expect(row).toHaveCount(1)
  await row.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(ui.operations.rowByName(page, label)).toBeVisible()
}

/**
 * Select an operation without toggling it off. Adding an operation already
 * selects it, and a click on the selected row is the panel's deselect gesture;
 * a simulation in "Selected" mode then has nothing to show.
 */
async function selectOperationRow(page: Page, ui: typeof import('./selectors'), label: string): Promise<void> {
  const row = ui.operations.rowByName(page, label)
  if (!(await row.evaluate((element) => element.classList.contains('tree-row--selected')))) {
    await row.click()
  }
  await expect(row).toHaveClass(/tree-row--selected/)
}

/**
 * What the 3D preview actually drew, read from the panel's own readout. This is
 * the consumer output of the generation cache — the same path the scene built,
 * not a path recomputed beside it.
 */
interface DrawnToolpathStats {
  segments: number
  minZ: number
  maxZ: number
}

async function drawnToolpathStats(page: Page): Promise<DrawnToolpathStats | null> {
  const overlay = page.locator('#workspace-panel-preview3d .viewport-3d')
  const segments = await overlay.getAttribute('data-toolpath-segments')
  const minZ = await overlay.getAttribute('data-toolpath-min-z')
  const maxZ = await overlay.getAttribute('data-toolpath-max-z')
  if (segments === null || minZ === null || maxZ === null) return null
  return { segments: Number(segments), minZ: Number(minZ), maxZ: Number(maxZ) }
}

/**
 * An **independent expected reference** for that readout: the same production
 * display mapping, applied to a fresh generation of the live project. It is
 * deliberately not the observed value — only `data-toolpath-*` is the cached
 * output the preview consumes — so a cache that keeps a path from an older
 * stock fails the comparison instead of matching itself.
 */
async function expectedDrawnToolpathStats(page: Page): Promise<DrawnToolpathStats> {
  return page.evaluate(async () => {
    const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('../src/store/projectStore')
    const { computeOperationToolpath } = await import('/src/engine/toolpaths/generateOperation.ts') as typeof import('../src/engine/toolpaths/generateOperation')
    const { stockSpaceToolpath } = await import('/src/components/viewport3d/toolpathOverlay.ts') as typeof import('../src/components/viewport3d/toolpathOverlay')
    const project = useProjectStore.getState().project
    let segments = 0
    let minZ = Number.POSITIVE_INFINITY
    let maxZ = Number.NEGATIVE_INFINITY
    for (const operation of project.operations) {
      if (!operation.showToolpath) continue
      const envelope = computeOperationToolpath(project, operation)
      if (!envelope) continue
      const drawn = stockSpaceToolpath(envelope.result, project.stock)
      segments += drawn.moves.length
      for (const move of drawn.moves) {
        for (const point of [move.from, move.to]) {
          minZ = Math.min(minZ, point.z)
          maxZ = Math.max(maxZ, point.z)
        }
      }
    }
    return { segments, minZ, maxZ }
  })
}

/**
 * The readout's fields are published rounded to 3 decimals; compare the same
 * text the panel exposes so the expected reference and the observed value are
 * formatted identically.
 */
function drawnStatsKey(stats: DrawnToolpathStats): string {
  return `${stats.segments}|${stats.minZ.toFixed(3)}|${stats.maxZ.toFixed(3)}`
}

/**
 * Wait until the 3D overlay is drawing a non-empty path that matches a fresh
 * generation for the live stock, then return that reference. The per-operation
 * pending badges are the cache-validity signal: the gear's "up to date" text
 * comes from the queue and can be true while a preview result is still stale.
 */
async function expectDrawnMatchesFresh(
  page: Page,
  ui: typeof import('./selectors'),
  label: string,
): Promise<DrawnToolpathStats> {
  const expected = await expectedDrawnToolpathStats(page)
  expect(expected.segments, `${label}: the fresh reference is not empty`).toBeGreaterThan(0)
  await expect(ui.generation.gearStatus(page)).toHaveAttribute('aria-label', /up to date/, { timeout: 60_000 })
  await expect(ui.generation.pendingOperationBadges(page)).toHaveCount(0)
  await expect
    .poll(async () => {
      const drawn = await drawnToolpathStats(page)
      return drawn === null ? 'not drawn' : drawnStatsKey(drawn)
    }, { timeout: 60_000, message: `${label}: the 3D overlay draws the output generated for the live stock` })
    .toBe(drawnStatsKey(expected))
  return expected
}

test('turning the bar square, and resizing the square, invalidates the preview cache', async ({ app, ui }) => {
  test.setTimeout(240_000)
  const { page } = app
  const project = await seedRotaryModelProject(page)
  expect((project.stock as RoundStock).shape).toBe('round')
  await expect(ui.face.current(page)).toHaveAttribute('data-face', 'around')

  await addRotaryOperation(page, ui, 'Rotary finish')
  await addRotaryOperation(page, ui, 'Rotary rough')
  await expect(ui.generation.gearStatus(page)).toHaveAttribute('aria-label', /up to date/, { timeout: 60_000 })

  const before = await getProject(page) as unknown as Project
  const finishBefore = before.operations.find((operation) => operation.kind === 'rotary_finish')!
  const round = await pathSignature(page, finishBefore.id)
  expect(round.moveCount).toBeGreaterThan(0)
  expect(round.hasAngle).toBe(true)

  // The preview the user is looking at: what the 3D overlay drew, not a fresh
  // path beside it.
  await ui.viewMenu.tab3d(page).click()
  await expect(ui.viewport3d.canvas(page)).toBeVisible()
  const roundDrawn = await expectDrawnMatchesFresh(page, ui, 'round bar')

  // Round → square, same physical box. The generation cache keys on the stock,
  // so the old round path must not survive as the preview.
  await page.evaluate(async () => {
    const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('../src/store/projectStore')
    useProjectStore.getState().setStockShape('square')
  })

  const after = await getProject(page) as unknown as Project
  expect((after.stock as { shape?: string }).shape).toBe('square')
  const finishAfter = after.operations.find((operation) => operation.kind === 'rotary_finish')!
  const square = await pathSignature(page, finishAfter.id)
  expect(square.moveCount).toBeGreaterThan(0)
  // A square blank's turning job clears corners the round path never touched,
  // so the geometry must differ — never a reused round path.
  const changed = square.moveCount !== round.moveCount
    || Math.abs(square.minZ - round.minZ) > 1e-6
    || Math.abs(square.maxZ - round.maxZ) > 1e-6
  expect(changed).toBe(true)
  const squareDrawn = await expectDrawnMatchesFresh(page, ui, 'square blank')
  expect(drawnStatsKey(squareDrawn), 'the preview really changed with the stock').not.toBe(drawnStatsKey(roundDrawn))

  // A side resize is a different physical box while the shape stays square: the
  // stock object changes, so the preview and simulation must be regenerated for
  // it rather than reused from the first square.
  await page.evaluate(async () => {
    const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('../src/store/projectStore')
    const { originAfterStockEdit, resizeSquareStock } = await import('/src/store/helpers/stockShape.ts') as typeof import('../src/store/helpers/stockShape')
    const state = useProjectStore.getState()
    const stock = state.project.stock
    if (stock.shape !== 'square') throw new Error('e2e: the stock is not a square blank')
    const resized = resizeSquareStock(stock, { side: 20 })
    state.setStockAndOrigin(resized, originAfterStockEdit(state.project.origin, stock, resized))
  })
  const resized = await getProject(page) as unknown as Project
  expect((resized.stock as { shape?: string; thickness: number }).shape).toBe('square')
  expect((resized.stock as { thickness: number }).thickness).toBeCloseTo(20, 6)
  const resizedDrawn = await expectDrawnMatchesFresh(page, ui, 'resized square blank')
  expect(drawnStatsKey(resizedDrawn), 'the preview really followed the side resize').not.toBe(drawnStatsKey(squareDrawn))
})

test('a stock axis change on a populated Around setup does not transpose the model', async ({ app, ui }) => {
  test.setTimeout(120_000)
  const { page } = app
  const seeded = await seedRotaryModelProject(page)
  const modelBefore = seeded.features.find((feature) => seeded.featureDefinitions[feature.definitionId]?.kind === 'stl')!
  const profileBefore = seeded.featureDefinitions[modelBefore.definitionId]!.profile

  // Populate the Around setup through the real Add menu, so the setup follows
  // the bar only while it is empty (a stock axis change is then a mismatch,
  // not a silent transposition of the stored model).
  await addRotaryOperation(page, ui, 'Rotary finish')
  await addRotaryOperation(page, ui, 'Rotary rough')
  await expect(ui.generation.gearStatus(page)).toHaveAttribute('aria-label', /up to date/, { timeout: 60_000 })
  const finishId = (await getProject(page) as unknown as Project).operations.find((operation) => operation.kind === 'rotary_finish')!.id

  /** Re-aim the round bar, keeping its length and diameter. */
  const setBarAxis = async (axis: 'x' | 'y'): Promise<void> => {
    await page.evaluate(async (nextAxis) => {
      const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('../src/store/projectStore')
      const { resizeRoundStock } = await import('/src/store/helpers/stockShape.ts') as typeof import('../src/store/helpers/stockShape')
      const state = useProjectStore.getState()
      const stock = state.project.stock
      if (stock.shape !== 'round') throw new Error('e2e: the stock is not a round bar')
      const next = resizeRoundStock(stock, { axis: nextAxis })
      state.setStockAndOrigin(next, state.project.origin)
    }, axis)
  }

  await setBarAxis('y')
  const reaimed = await getProject(page) as unknown as Project
  // The non-empty setup keeps its own axis and the model is not transposed.
  expect(reaimed.setups.find((setup) => setup.kind === 'around')!.orientation.axis).toBe('x')
  expect(reaimed.featureDefinitions[modelBefore.definitionId]!.profile).toEqual(profileBefore)
  // The mismatch refuses: no transposed geometry is generated from the old path.
  const mismatched = await generationOutcome(page, finishId)
  expect(mismatched.moveCount).toBe(0)

  // Restoring the axis makes the setup match again and a real path returns.
  await setBarAxis('x')
  const restored = await getProject(page) as unknown as Project
  expect(restored.setups.find((setup) => setup.kind === 'around')!.orientation.axis).toBe('x')
  await expect(ui.generation.gearStatus(page)).toHaveAttribute('aria-label', /up to date/, { timeout: 60_000 })
  const path = await pathSignature(page, finishId)
  expect(path.moveCount).toBeGreaterThan(0)
})

test('square to round generates inside the band and removes material', async ({ app, ui }, testInfo) => {
  test.setTimeout(180_000)
  const { page } = app
  await seedSquareBlankProject(page)
  await expect(ui.face.current(page)).toHaveAttribute('data-face', 'around')

  // The Around Add menu offers only what Around can do (issue #1112 K): the
  // 3D surface strategies are not listed, and the wrapped sheet kinds stay in
  // place with the stock reason — disabled, not behind the "not available for
  // this selection" disclosure, so this assertion needs no expand step. Decision
  // 17's wording is "Not available on a square bar yet": turning the blank
  // works, the sheet work does not.
  await ui.setupCam.add(page).click()
  await expect(ui.setupCam.addMenu(page)).toBeVisible()
  const aroundMenu = ui.setupCam.addMenu(page)
  for (const label of ['3D surface rough', '3D surface finish', '3D surface cleanup']) {
    await expect(aroundMenu.locator('.cam-operation-label').filter({ hasText: label })).toHaveCount(0)
  }
  const aroundPocket = aroundMenu.locator('.cam-operation-item')
    .filter({ has: page.getByRole('button', { name: 'Pocket', exact: true }) })
  await expect(aroundPocket.locator('.cam-operation-hint__text')).toHaveText('Not available on a square bar yet')
  await expect(aroundPocket.getByRole('button', { name: 'Rough', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(ui.setupCam.addMenu(page)).toBeHidden()

  await openCreationDrawer(page)

  await ui.rotarySolid.turnButton(page).click()
  await expect(ui.rotarySolid.dialog(page)).toBeVisible()
  await ui.rotarySolid.field(page, 'start').fill('10')
  await ui.rotarySolid.field(page, 'length').fill('30')
  await ui.rotarySolid.field(page, 'diameter').fill('20')
  await ui.rotarySolid.createButton(page).click()
  await expect(ui.rotarySolid.dialog(page)).toBeHidden()
  // Creation adds the model only (issue #1112 G); the two rotary operations
  // are added through the ordinary CAM Add menu.
  await addRotaryOperation(page, ui, 'Rotary rough')
  await addRotaryOperation(page, ui, 'Rotary finish')
  await expect(ui.generation.gearStatus(page)).toHaveAttribute('aria-label', /up to date/, { timeout: 60_000 })

  const project = await getProject(page) as unknown as Project
  expect((project.stock as { shape?: string }).shape).toBe('square')
  const finish = project.operations.find((operation) => operation.kind === 'rotary_finish')!
  const rough = project.operations.find((operation) => operation.kind === 'rotary_rough')!
  // The Add menu picks the project's own ball for both rotary operations and
  // imports nothing (issue #1139).
  expect(rough.toolRef).toBe('t2')
  expect(finish.toolRef).toBe('t2')
  expect(project.tools.map((tool) => tool.id)).toEqual(['t1', 't2'])
  const band = await pathSignature(page, finish.id)
  expect(band.cutMoveCount).toBeGreaterThan(0)
  expect(band.hasAngle).toBe(true)
  // Cutting stays on the requested band: the square material outside 10..40 is
  // retained end stock, not turned away. (Lead and rapid moves may reach
  // outside; only the cuts are pinned.)
  expect(band.cutMinAlong).toBeGreaterThanOrEqual(10 - 1e-6)
  expect(band.cutMaxAlong).toBeLessThanOrEqual(40 + 1e-6)
  const roughBand = await pathSignature(page, rough.id)
  expect(roughBand.cutMoveCount).toBeGreaterThan(0)
  expect(roughBand.cutMinAlong).toBeGreaterThanOrEqual(10 - 1e-6)
  expect(roughBand.cutMaxAlong).toBeLessThanOrEqual(40 + 1e-6)

  // Simulation: the Around bar view removes material.
  await selectOperationRow(page, ui, 'Rotary finish')
  await ui.viewMenu.tabSimulation(page).click()
  const viewport = ui.simSetup.viewport(page)
  await expect(viewport).toHaveAttribute('data-simulation-view', 'bar')
  await expect.poll(
    async () => Number(await viewport.getAttribute('data-simulation-removed-cells')),
    { timeout: 60_000 },
  ).toBeGreaterThan(0)

  // 3D: the overlay draws the generated passes; a low orbit and an end view
  // both keep the canvas alive.
  await ui.viewMenu.tab3d(page).click()
  const canvas = ui.viewport3d.canvas(page)
  await expect(canvas).toBeVisible()
  const overlay = ui.viewport3d.overlay(page)
  await expect.poll(
    async () => Number(await overlay.getAttribute('data-toolpath-segments')),
    { timeout: 15_000 },
  ).toBeGreaterThan(0)
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  const centre = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }
  await page.mouse.move(centre.x, centre.y)
  await page.mouse.down()
  await page.mouse.move(centre.x - 60, centre.y - 40, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  await page.screenshot({ path: testInfo.outputPath('square-to-round-3d-low-angle.png') })

  // End view of the bar: the 3D view preset menu still drives the camera.
  await ui.viewMenu.trigger3d(page).click()
  await ui.viewMenu.option3d(page, 'Right view').click()
  await expect(canvas).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('square-to-round-3d-end-view.png') })
})

// ── #1016 C2: square playback on the shared heightfield ──────────────
//
// A square blank is simulated exactly like the round bar (issue #1016 C2): the
// same radial heightfield, the same `PlaybackController` and the same GPU
// surface. This test drives the real Square-to-round job through the page and
// reads the viewport's own evidence attributes: the mounted surface, and the
// live playback grid's progress, removed cells and minimum Z. At progress 0
// the removed cells must already be the prior rough's, never a virgin blank.

/** Drive a real range control the way a pointer/keyboard would (0..1000). */
async function setPlaybackProgress(page: Page, ui: typeof import('./selectors'), value: number): Promise<void> {
  await ui.simSetup.progressSlider(page).evaluate((element, next) => {
    const input = element as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, String(next))
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)
}

interface PlaybackEvidence {
  surface: string | null
  progress: number
  removedCells: number
  minZ: number
}

/** The live playback grid's evidence, published by the viewport itself. */
async function playbackEvidence(page: Page, ui: typeof import('./selectors')): Promise<PlaybackEvidence> {
  const viewport = ui.simSetup.viewport(page)
  return {
    surface: await viewport.getAttribute('data-simulation-playback-surface'),
    progress: Number(await viewport.getAttribute('data-simulation-playback-progress')),
    removedCells: Number(await viewport.getAttribute('data-simulation-playback-removed-cells')),
    minZ: Number(await viewport.getAttribute('data-simulation-playback-min-z')),
  }
}

interface StaticSquareSimulation {
  removedCells: number
  minTopZ: number
  endCells: number
  keptEndCells: number
}

/**
 * The independent expected static result: the same production setup input,
 * operations and `computeSimulationResult` the panel runs, replayed beside the
 * observed attributes. It also reads the square grid's own immutable baseline
 * to prove the blank's ends are untouched by the cut.
 */
async function staticSquareSimulation(page: Page, detailCells: number): Promise<StaticSquareSimulation> {
  return page.evaluate(async (detail) => {
    const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('../src/store/projectStore')
    const { computeOperationToolpath } = await import('/src/engine/toolpaths/generateOperation.ts') as typeof import('../src/engine/toolpaths/generateOperation')
    const { buildSimulationSetupInput } = await import('/src/app/simulationSetup.ts') as typeof import('../src/app/simulationSetup')
    const { computeSimulationResult } = await import('/src/app/useSimulationModel.ts') as typeof import('../src/app/useSimulationModel')
    const project = useProjectStore.getState().project
    const around = project.setups.find((setup) => setup.kind === 'around')
    const finish = project.operations.find((operation) => operation.kind === 'rotary_finish')
    if (!around || !finish) throw new Error('e2e: the square fixture has no Around finish')

    const paths = new Map<string, import('../src/engine/toolpaths/types').ToolpathResult>()
    for (const operation of project.operations) {
      if (operation.setupId !== around.id) continue
      const envelope = computeOperationToolpath(project, operation)
      if (envelope) paths.set(operation.id, envelope.result)
    }
    const setupInput = buildSimulationSetupInput(project, around, paths)
    if (!setupInput) throw new Error('e2e: the square fixture yields no simulation input')
    const result = computeSimulationResult({
      setupInput,
      project,
      simulationMode: 'selected',
      simulationDetailCells: detail,
      selectedInSetup: finish,
      paths,
    })

    const grid = result.grid
    const baseline = grid.initialTopZ
    if (!baseline) throw new Error('e2e: the square simulation has no per-cell baseline')
    const { getStockBounds } = await import('/src/types/project.ts') as typeof import('../src/types/project')
    const stockBounds = getStockBounds(project.stock)
    const xAxis = project.stock.axis === 'x'
    const minAlong = xAxis ? stockBounds.minX : stockBounds.minY
    const maxAlong = xAxis ? stockBounds.maxX : stockBounds.maxY
    let endCells = 0
    let keptEndCells = 0
    for (let row = 0; row < grid.rows; row += 1) {
      for (let col = 0; col < grid.cols; col += 1) {
        const along = xAxis
          ? grid.originX + (col + 0.5) * grid.cellSize
          : grid.originY + (row + 0.5) * grid.cellSize
        // The job cuts 10..40; only the outermost millimetre of the physical
        // blank is checked, safely clear of the band and its leads.
        if (along > minAlong + 1 && along < maxAlong - 1) continue
        const index = row * grid.cols + col
        endCells += 1
        if (Math.abs(grid.topZ[index] - baseline[index]) < 1e-9) keptEndCells += 1
      }
    }
    return {
      removedCells: result.stats.removedCellCount,
      minTopZ: result.stats.minTopZ,
      endCells,
      keptEndCells,
    }
  }, detailCells)
}

interface SquareCutCoverage {
  /** Along extents of the finish cuts that actually sit at the target radius. */
  cutMinAlong: number
  cutMaxAlong: number
  /** Grid cells inside the cut range, one tool radius in from each end. */
  reachableCells: number
  /** Those at or below the target radius plus the 0.05 mm allowance. */
  coveredCells: number
  /** Cells the cutter cannot reach beyond the requested band. */
  outsideCells: number
  /** Those that still sit exactly on the square blank's immutable baseline. */
  keptOutsideCells: number
}

interface SquareCutCoverageRequest {
  detailCells: number
  targetRadius: number
  bandStart: number
  bandEnd: number
}

/**
 * The finished surface's coverage, computed in the page exactly as the panel
 * computes the visible replay: the same generated paths,
 * `buildSimulationSetupInput` and `computeSimulationResult` in `visible` mode
 * (rough + finish) on the app's own detail value. This is the surface the user
 * sees, not a second simulation beside it.
 *
 * The cut range is read from the finish moves that actually sit at the target
 * radius, shrunk by one tool radius each side: the cells a correct pass pattern
 * must have reached. A too-coarse stepover leaves ridges inside that range,
 * which is the #1016 C2-D2 regression. Cells farther than the cutter's reach
 * outside the requested band must still be the square blank's baseline.
 */
async function squareCutCoverage(
  page: Page,
  request: SquareCutCoverageRequest,
): Promise<SquareCutCoverage> {
  return page.evaluate(async ({ detailCells, targetRadius, bandStart, bandEnd }) => {
    const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('../src/store/projectStore')
    const { computeOperationToolpath } = await import('/src/engine/toolpaths/generateOperation.ts') as typeof import('../src/engine/toolpaths/generateOperation')
    const { buildSimulationSetupInput } = await import('/src/app/simulationSetup.ts') as typeof import('../src/app/simulationSetup')
    const { computeSimulationResult } = await import('/src/app/simulationCompute.ts') as typeof import('../src/app/simulationCompute')
    const { normalizeToolForProject } = await import('/src/engine/toolpaths/geometry.ts') as typeof import('../src/engine/toolpaths/geometry')
    const { barPivotZ } = await import('/src/types/barStock.ts') as typeof import('../src/types/barStock')
    const project = useProjectStore.getState().project
    const around = project.setups.find((setup) => setup.kind === 'around')
    const finish = project.operations.find((operation) => operation.kind === 'rotary_finish')
    if (!around || !finish) throw new Error('e2e: the square fixture has no Around finish')
    const toolRecord = project.tools.find((tool) => tool.id === finish.toolRef)
    if (!toolRecord) throw new Error('e2e: the square finish has no tool')
    // The same radius the replay kernel uses, so the shrink matches the cut.
    const toolRadius = normalizeToolForProject(toolRecord, project).radius

    const paths = new Map<string, import('../src/engine/toolpaths/types').ToolpathResult>()
    for (const operation of project.operations) {
      if (operation.setupId !== around.id) continue
      const envelope = computeOperationToolpath(project, operation)
      if (envelope) paths.set(operation.id, envelope.result)
    }
    const finishPath = paths.get(finish.id)
    if (!finishPath) throw new Error('e2e: the square finish did not generate')

    // The finished radius is the tool-tip radius above the turning pivot. A
    // 0.05 mm window absorbs the sampler's own discretization; only cuts that
    // reach the finished surface bound the stretch a correct pattern covers.
    const pivot = barPivotZ(project.stock)
    const targetZ = pivot + targetRadius
    const xAxis = project.stock.axis === 'x'
    let cutMinAlong = Number.POSITIVE_INFINITY
    let cutMaxAlong = Number.NEGATIVE_INFINITY
    for (const move of finishPath.moves) {
      if (move.kind !== 'cut') continue
      for (const point of [move.from, move.to]) {
        if (Math.abs(point.z - targetZ) > 0.05) continue
        const along = xAxis ? point.x : point.y
        cutMinAlong = Math.min(cutMinAlong, along)
        cutMaxAlong = Math.max(cutMaxAlong, along)
      }
    }
    if (!(cutMaxAlong > cutMinAlong)) throw new Error('e2e: the finish has no cut at the target radius')

    const setupInput = buildSimulationSetupInput(project, around, paths)
    if (!setupInput) throw new Error('e2e: the square fixture yields no simulation input')
    const result = computeSimulationResult({
      setupInput,
      project,
      simulationMode: 'visible',
      simulationDetailCells: detailCells,
      selectedInSetup: finish,
      paths,
    })
    const grid = result.grid
    const baseline = grid.initialTopZ
    if (!baseline) throw new Error('e2e: the square simulation has no per-cell baseline')

    const reachMin = cutMinAlong + toolRadius
    const reachMax = cutMaxAlong - toolRadius
    if (!(reachMax > reachMin)) throw new Error('e2e: the finish cut range is shorter than the tool')
    // The cutter's footprint reaches a tool radius past the requested band, and
    // one cell absorbs the grid arithmetic — the same reach the square replay
    // engine test allows before an end cell must still be virgin.
    const outsideReach = toolRadius + grid.cellSize
    let reachableCells = 0
    let coveredCells = 0
    let outsideCells = 0
    let keptOutsideCells = 0
    for (let row = 0; row < grid.rows; row += 1) {
      for (let col = 0; col < grid.cols; col += 1) {
        const along = xAxis
          ? grid.originX + (col + 0.5) * grid.cellSize
          : grid.originY + (row + 0.5) * grid.cellSize
        const index = row * grid.cols + col
        if (along >= reachMin && along <= reachMax) {
          reachableCells += 1
          if (grid.topZ[index] <= targetRadius + 0.05) coveredCells += 1
        }
        if (along < bandStart - outsideReach || along > bandEnd + outsideReach) {
          outsideCells += 1
          if (Math.abs(grid.topZ[index] - baseline[index]) < 1e-9) keptOutsideCells += 1
        }
      }
    }
    return { cutMinAlong, cutMaxAlong, reachableCells, coveredCells, outsideCells, keptOutsideCells }
  }, request)
}

test('square playback starts from the prior rough, follows the finish and resets to it', async ({ app, ui }) => {
  test.setTimeout(300_000)
  const { page } = app
  const seeded = await seedSquareBlankProject(page)
  const blank = seeded.stock as SquareStock
  expect(blank.shape).toBe('square')
  expect(blank.thickness).toBe(25)
  // The physical corner diameter the chuck has to clear, not the nominal side.
  expect(2 * barMaxRadius(blank)).toBeCloseTo(25 * Math.SQRT2, 6)
  await expect(ui.face.current(page)).toHaveAttribute('data-face', 'around')

  // The real square-to-round job: the app's own Turn dialog creates the round
  // target, then the two rotary operations are added from CAM.
  await openCreationDrawer(page)
  await ui.rotarySolid.turnButton(page).click()
  await expect(ui.rotarySolid.dialog(page)).toBeVisible()
  await ui.rotarySolid.field(page, 'start').fill('10')
  await ui.rotarySolid.field(page, 'length').fill('30')
  await ui.rotarySolid.field(page, 'diameter').fill('20')
  await ui.rotarySolid.createButton(page).click()
  await expect(ui.rotarySolid.dialog(page)).toBeHidden()
  await addRotaryOperation(page, ui, 'Rotary rough')
  await addRotaryOperation(page, ui, 'Rotary finish')
  await expect(ui.generation.gearStatus(page)).toHaveAttribute('aria-label', /up to date/, { timeout: 60_000 })

  const project = await getProject(page) as unknown as Project
  expect((project.stock as { shape?: string }).shape).toBe('square')
  const around = project.setups.find((setup) => setup.kind === 'around')!
  const rough = project.operations.find((operation) => operation.kind === 'rotary_rough')!
  const finish = project.operations.find((operation) => operation.kind === 'rotary_finish')!
  const roughIndex = project.operations.findIndex((operation) => operation.id === rough.id)
  const finishIndex = project.operations.findIndex((operation) => operation.id === finish.id)
  expect(roughIndex).toBeGreaterThanOrEqual(0)
  expect(finishIndex).toBeGreaterThan(roughIndex)

  // The dialog's rough defaults to no radial stock, so it already cuts to the
  // finish surface and the finish would be a no-op in the heightfield. Leave the
  // 0.4 mm an operator would, through the operation's own field, so the prior
  // rough and the finished states are genuinely different — which is what the
  // playback base and the "more removed by the end" assertions need.
  await page.evaluate(async (roughId) => {
    const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('../src/store/projectStore')
    useProjectStore.getState().updateOperation(roughId, { stockToLeaveRadial: 0.4 })
  }, rough.id)
  await expect(ui.generation.gearStatus(page)).toHaveAttribute('aria-label', /up to date/, { timeout: 60_000 })
  await expect(ui.generation.pendingOperationBadges(page)).toHaveCount(0)

  // Square ends kept: both cuts stay inside the requested 10..40 band, so the
  // blank's 0..10 and 40..120 ends are retained material.
  for (const operation of [rough, finish]) {
    const band = await pathSignature(page, operation.id)
    expect(band.cutMoveCount, operation.name + ' cuts').toBeGreaterThan(0)
    expect(band.hasAngle).toBe(true)
    expect(band.cutMinAlong, operation.name + ' starts inside the band').toBeGreaterThanOrEqual(10 - 1e-6)
    expect(band.cutMaxAlong, operation.name + ' ends inside the band').toBeLessThanOrEqual(40 + 1e-6)
  }

  // ── The selected finish opens as the shared heightfield, with removal ──
  await selectOperationRow(page, ui, 'Rotary finish')
  await ui.viewMenu.tabSimulation(page).click()
  // The workspace is on the Around face, so the simulation shows that setup
  // with no picker of its own (issue #1112 F3).
  await expect(ui.face.current(page)).toHaveAttribute('data-face', 'around')
  const viewport = ui.simSetup.viewport(page)
  await expect(viewport).toHaveAttribute('data-simulation-setup', around.id)
  await expect(viewport).toHaveAttribute('data-simulation-view', 'bar')
  // A square grid draws the same surface and instanced boundary as the round
  // bar; a square-only branch that skipped the heightfield would leave this
  // unset.
  await expect(viewport).toHaveAttribute('data-simulation-surface', 'heightfield')
  await expect.poll(
    async () => Number(await viewport.getAttribute('data-simulation-removed-cells')),
    { timeout: 60_000 },
  ).toBeGreaterThan(0)
  const staticRemoved = Number(await viewport.getAttribute('data-simulation-removed-cells'))
  const staticMinZ = Number(await viewport.getAttribute('data-simulation-min-z'))
  expect(staticMinZ, 'the static finish reports a real minimum Z').toBeGreaterThan(0)

  // The mounted result matches the same production computation beside it, and
  // its square blank keeps both ends: every end cell still sits on the grid's
  // own immutable starting baseline.
  const detailCells = Number(await ui.simSetup.detail(page).inputValue())
  expect(detailCells).toBeGreaterThan(0)
  const independent = await staticSquareSimulation(page, detailCells)
  expect(independent.removedCells, 'the panel shows the production removed cells').toBe(staticRemoved)
  expect(independent.minTopZ).toBeCloseTo(staticMinZ, 6)
  expect(independent.endCells, 'the fixture has end cells to check').toBeGreaterThan(0)
  expect(independent.keptEndCells, 'the square blank keeps both ends').toBe(independent.endCells)

  // ── The finished band is reached across its width, not just "some material
  // removed" ──
  // The dialog asks for a 20 mm round target inside the 25 mm square, so the
  // target radius is 10. The finish's target-depth moves bound the stretch a
  // correct pass pattern must reach; one tool radius in from each end, every
  // cell has to sit at the target radius (within 0.05 mm). With the old 18 mm
  // stepover the band was cut at only seven angles and the ridges left most of
  // these cells high (issue #1016 C2 correction D2). Cells farther than the
  // cutter's reach outside the requested 10..40 band must stay virgin.
  const coverage = await squareCutCoverage(page, { detailCells, targetRadius: 10, bandStart: 10, bandEnd: 40 })
  expect(coverage.reachableCells, 'the finish leaves cells inside its cut range to check').toBeGreaterThan(0)
  expect(
    coverage.coveredCells / coverage.reachableCells,
    `only ${coverage.coveredCells}/${coverage.reachableCells} cells inside `
      + `${coverage.cutMinAlong.toFixed(2)}..${coverage.cutMaxAlong.toFixed(2)} reached the target radius`,
  ).toBeGreaterThanOrEqual(0.99)
  expect(coverage.outsideCells, 'the blank leaves cells beyond the requested band').toBeGreaterThan(0)
  expect(coverage.keptOutsideCells, 'the cut never reaches the blank beyond the requested band').toBe(coverage.outsideCells)

  // ── Playback starts from the prior rough, not virgin stock ──
  await expect(ui.simSetup.playTool(page)).toBeEnabled({ timeout: 60_000 })
  await ui.simSetup.playTool(page).click()
  await expect(ui.simSetup.progress(page)).toBeVisible()
  await expect(viewport).toHaveAttribute('data-simulation-playback-surface', 'heightfield')
  await expect.poll(async () => (await playbackEvidence(page, ui)).progress, { timeout: 60_000 }).toBe(0)
  await expect.poll(async () => (await playbackEvidence(page, ui)).removedCells, { timeout: 60_000 }).toBeGreaterThan(0)
  const start = await playbackEvidence(page, ui)
  expect(start.surface).toBe('heightfield')
  // The starting material is the rough, which left radial stock: it is already
  // lower than virgin and shallower than the finished surface.
  expect(start.minZ, 'progress 0 is the rough, not the finished surface').toBeGreaterThan(staticMinZ)
  const startRemoved = start.removedCells

  // ── Play a burst, then seek to the end: more material is gone ──
  // The burst only proves that Play advances; how far it gets in a minute is
  // the runner's render speed (CI's software GL reached 1 % on this job), so
  // any progress counts. The material checks follow the seek to the end.
  await ui.simSetup.playPause(page).click()
  await expect.poll(async () => (await playbackEvidence(page, ui)).progress, { timeout: 60_000 }).toBeGreaterThan(0)
  await ui.simSetup.playPause(page).click()
  await expect.poll(async () => (await playbackEvidence(page, ui)).progress).toBeGreaterThan(0)

  await setPlaybackProgress(page, ui, 1000)
  // The slider sets its progress immediately while the seek itself lands on the
  // next RAF, so wait for the live grid to reach the finished surface, not just
  // for the slider's own number.
  await expect.poll(async () => {
    const evidence = await playbackEvidence(page, ui)
    return evidence.progress > 0.999 && evidence.minZ < start.minZ ? 'ended' : null
  }, { timeout: 60_000 }).toBe('ended')
  const end = await playbackEvidence(page, ui)
  // The finish works inside the same band the rough already opened (#1016 C2
  // F7 keeps both cutters one radius inside it), so it deepens cells rather than
  // reaching new ones: the count never drops, and the depth check below is what
  // proves the finish cut.
  expect(end.removedCells, 'the end never removes fewer cells than the prior rough').toBeGreaterThanOrEqual(startRemoved)
  expect(end.minZ, 'the finish cut deeper than the prior rough').toBeLessThan(start.minZ)
  // The end of the finish playback is the finished static surface.
  expect(end.minZ).toBeCloseTo(staticMinZ, 2)

  // ── Stop & reset returns to the progress-0 prior rough ──
  await ui.simSetup.stop(page).click()
  await expect.poll(async () => (await playbackEvidence(page, ui)).progress, { timeout: 30_000 }).toBe(0)
  const reset = await playbackEvidence(page, ui)
  expect(reset.removedCells).toBe(startRemoved)
  expect(reset.minZ).toBe(start.minZ)

  // ── Back-seek: mid-path, then back to zero restores the same rough ──
  await setPlaybackProgress(page, ui, 600)
  await expect.poll(async () => (await playbackEvidence(page, ui)).progress, { timeout: 30_000 }).toBeGreaterThan(0.59)
  await setPlaybackProgress(page, ui, 0)
  // The back-seek replays to zero on a RAF; wait for the restored grid itself.
  await expect.poll(async () => {
    const evidence = await playbackEvidence(page, ui)
    return evidence.progress === 0 && evidence.minZ === start.minZ ? 'restored' : null
  }, { timeout: 30_000 }).toBe('restored')
  const backSeek = await playbackEvidence(page, ui)
  expect(backSeek.removedCells).toBe(startRemoved)
  expect(backSeek.minZ).toBe(start.minZ)

  // ── Turning playback off returns to the static heightfield ──
  await ui.simSetup.playTool(page).click()
  await expect(viewport).toHaveAttribute('data-simulation-surface', 'heightfield')
  await expect(viewport).not.toHaveAttribute('data-simulation-playback-surface', 'heightfield')

  // ── A blank length edit rebuilds the simulation for the new stock ──
  await page.evaluate(async () => {
    const { useProjectStore } = await import('/src/store/projectStore.ts') as typeof import('../src/store/projectStore')
    const { originAfterStockEdit, resizeSquareStock } = await import('/src/store/helpers/stockShape.ts') as typeof import('../src/store/helpers/stockShape')
    const state = useProjectStore.getState()
    const stock = state.project.stock
    if (stock.shape !== 'square') throw new Error('e2e: the stock is not a square blank')
    const resized = resizeSquareStock(stock, { length: 140 })
    state.setStockAndOrigin(resized, originAfterStockEdit(state.project.origin, stock, resized))
  })
  await expect(ui.generation.gearStatus(page)).toHaveAttribute('aria-label', /up to date/, { timeout: 60_000 })
  await expect.poll(
    async () => Number(await viewport.getAttribute('data-simulation-removed-cells')),
    { timeout: 60_000, message: 'a length edit rebuilds the simulation for the new stock' },
  ).not.toBe(staticRemoved)
})
