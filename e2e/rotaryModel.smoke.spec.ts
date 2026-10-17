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
import { defaultRoundWorkholding } from '../src/store/helpers/roundWorkholding'
import { IDENTITY_MATRIX, defaultTool, newProject, rectProfile, roundStock } from '../src/types/project'
import { squareStock } from '../src/types/barStock'
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
    diameter: 6, defaultStepover: 3, defaultStepdown: 2,
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
  await expect(ui.face.segment(page, 'Around')).toHaveAttribute('aria-pressed', 'true')

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
  await expect(ui.face.segment(page, 'Around')).toHaveAttribute('aria-pressed', 'true')

  await ui.rotarySolid.squareToRoundButton(page).click()
  await expect(ui.rotarySolid.dialog(page)).toBeVisible()
  await ui.rotarySolid.field(page, 'start').fill('10')
  await ui.rotarySolid.field(page, 'length').fill('30')
  await ui.rotarySolid.field(page, 'diameter').fill('20')
  await ui.rotarySolid.createButton(page).click()
  await expect(ui.rotarySolid.dialog(page)).toBeHidden()
  await expect(ui.generation.gearStatus(page)).toHaveAttribute('aria-label', /up to date/, { timeout: 60_000 })

  const project = await getProject(page) as unknown as Project
  expect((project.stock as { shape?: string }).shape).toBe('square')
  const finish = project.operations.find((operation) => operation.kind === 'rotary_finish')!
  const rough = project.operations.find((operation) => operation.kind === 'rotary_rough')!
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
  await ui.operations.rowByName(page, 'Rotary finish').click()
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
