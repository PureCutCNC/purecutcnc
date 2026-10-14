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
 * The Around face in the 3D view and the Simulation tab (issue #395 slice E).
 *
 * A round bar with a rotary machine and both a Top and an Around setup: the 3D
 * view draws the real bar with the wrapped passes on its surface (captured from
 * the default view and from a low angle, where the underside of the wrap
 * shows), and the Simulation tab lists both setups and turns the cut bar
 * during playback, with an optional flat Unrolled view.
 *
 * The project is seeded through the page's store, as `setupCam.smoke.spec.ts`
 * and `setupPreview.smoke.spec.ts` do. The fixture already fails the test on
 * any console error, which is what a bad geometry or NaN transform emits.
 *
 * Deliberately not covered here: the sketch canvas and the face switch — those
 * are separate slices.
 */

import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { seedGcodeExportProject } from './gcodeExport.helpers'
import { getProject, seedProject } from './helpers'
import { defaultTool, roundStock, roundStockCentre, type MachineDefinition, type Project, type RoundStock, type SketchProfile } from '../src/types/project'

const BAR = roundStock(40, 200, 'x', { x: 10, y: 30 })
const SHEET_START = BAR.profile.start.y
const CIRCUMFERENCE = Math.PI * BAR.thickness
/** Flat coordinates of the Around pocket: on the sheet, x along, y across. */
const POCKET = { x: 50, y: SHEET_START + 12, w: 60, h: 10 }

/** A 3 mm flat endmill in mm, referenced by its real id (issue #395 slice F). */
const TOOL = { ...defaultTool('mm', 1), id: 't1', name: '3 mm Flat Endmill', diameter: 3, maxCutDepth: 40 }

const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }

function rect(x: number, y: number, w: number, h: number): SketchProfile {
  return {
    start: { x, y },
    segments: [
      { type: 'line', to: { x: x + w, y } },
      { type: 'line', to: { x: x + w, y: y + h } },
      { type: 'line', to: { x, y: y + h } },
      { type: 'line', to: { x, y } },
    ],
    closed: true,
  }
}

/**
 * A complete bundled definition plus a rotary axis about x (issue #393). The
 * bundled GRBL carries every block the schema requires, so this is the real
 * machine shape, not a partial object.
 */
function rotaryMachine(): MachineDefinition {
  // Read as a file: importing the definitions module would pull JSON imports
  // into the Playwright runner, which Node refuses without an attribute.
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
 * Seed the bar, the rotary machine, a Top setup and an Around setup. Around
 * carries a pocket and a line that wraps more than once round the bar; Top
 * carries a small pocket so the project has two setups and the Simulation
 * picker exists. Returns the saved project for the tests to read back.
 */
async function seedAroundProject(page: Page): Promise<Project> {
  await seedGcodeExportProject(page)
  const seeded = await getProject(page) as unknown as Project
  const project = structuredClone(seeded)
  project.meta.name = 'Around bar'
  project.meta.units = 'mm'
  project.stock = BAR
  project.origin = { ...project.origin, x: BAR.profile.start.x, y: BAR.profile.start.y, z: BAR.thickness }
  project.meta.machineDefinitions = project.meta.machineDefinitions ?? []
  project.meta.machineDefinitions = [...project.meta.machineDefinitions, rotaryMachine()]
  project.meta.selectedMachineId = 'e2e-rotary'
  project.tools = [TOOL]
  const template = project.features[0]
  const definition = project.featureDefinitions[template.definitionId]
  project.featureDefinitions = {
    ...project.featureDefinitions,
    'around-pocket': {
      ...definition,
      id: 'around-pocket',
      operation: 'subtract',
      profile: rect(POCKET.x, POCKET.y, POCKET.w, POCKET.h),
    },
    'around-line': {
      ...definition,
      id: 'around-line',
      operation: 'line',
      profile: {
        start: { x: 20, y: SHEET_START + 5 },
        segments: [{ type: 'line', to: { x: 180, y: SHEET_START + 1.5 * CIRCUMFERENCE } }],
        closed: false,
      },
    },
    'top-pocket': {
      ...definition,
      id: 'top-pocket',
      operation: 'subtract',
      profile: rect(30, 40, 10, 6),
    },
  }
  project.features = [
    {
      ...template, id: 'around-pocket', name: 'Around pocket', definitionId: 'around-pocket',
      authoringFace: 'around', z_top: BAR.thickness, z_bottom: BAR.thickness - 4, transform: IDENTITY,
    },
    {
      ...template, id: 'around-line', name: 'Around line', definitionId: 'around-line',
      authoringFace: 'around', z_top: BAR.thickness, z_bottom: BAR.thickness - 1, transform: IDENTITY,
    },
    {
      ...template, id: 'top-pocket', name: 'Top pocket', definitionId: 'top-pocket',
      authoringFace: 'top', z_top: BAR.thickness, z_bottom: BAR.thickness - 4, transform: IDENTITY,
    },
  ]
  project.featureTree = []
  const top = { ...project.setups[0], name: 'Top', operationIds: ['op-top'] }
  project.setups = [
    top,
    {
      id: 'setup-around', name: 'Around', kind: 'around', orientation: { axis: 'x', angleDeg: 0 },
      indexing: 'manual', registration: [], notes: '', operationIds: ['op-around', 'op-around-line'],
    },
  ]
  project.activeSetupId = 'setup-around'
  const base = project.operations[0]
  project.operations = [
    {
      ...base, id: 'op-around', name: 'Around pocket', kind: 'pocket',
      target: { source: 'features', featureIds: ['around-pocket'] },
      setupId: 'setup-around', toolRef: TOOL.id, stepdown: 2, stepover: 0.4,
      feed: 600, plungeFeed: 180, rpm: 18000, enabled: true, showToolpath: true,
    },
    {
      ...base, id: 'op-around-line', name: 'Around line', kind: 'follow_line', pass: 'finish',
      target: { source: 'features', featureIds: ['around-line'] },
      setupId: 'setup-around', toolRef: TOOL.id, stepdown: 1, stepover: 0.4,
      feed: 600, plungeFeed: 180, rpm: 18000, carveDepth: 1, maxCarveDepth: 1,
      carveStrategy: 'direct', entryStrategy: 'plunge', enabled: true, showToolpath: true,
    },
    {
      ...base, id: 'op-top', name: 'Top pocket', kind: 'pocket',
      target: { source: 'features', featureIds: ['top-pocket'] },
      setupId: top.id, toolRef: TOOL.id, stepdown: 2, stepover: 0.4,
      feed: 600, plungeFeed: 180, rpm: 18000, enabled: true, showToolpath: true,
    },
  ]
  await seedProject(page, JSON.stringify(project))
  return await getProject(page) as unknown as Project
}

async function viewportStats(page: Page) {
  const viewport = page.locator('#workspace-panel-simulation .simulation-viewport')
  return {
    setup: await viewport.getAttribute('data-simulation-setup'),
    removed: Number(await viewport.getAttribute('data-simulation-removed-cells')),
  }
}

interface PocketPathReadout {
  moveCount: number
  allHaveAngle: boolean
  minAcross: number
  maxAcross: number
}

/** The generated wrapped pocket path, read the way `plasmaKerfPreview` does. */
async function pocketPath(page: Page, operationId: string): Promise<PocketPathReadout> {
  return page.evaluate(async (id) => {
    const storeUrl = '/src/store/projectStore.ts'
    const generateUrl = '/src/engine/toolpaths/generateOperation.ts'
    const { useProjectStore } = await import(storeUrl) as typeof import('../src/store/projectStore')
    const { computeOperationToolpath } = await import(generateUrl) as typeof import('../src/engine/toolpaths/generateOperation')
    const project = useProjectStore.getState().project
    const operation = project.operations.find((candidate) => candidate.id === id)
    if (!operation) throw new Error(`e2e: the project has no operation ${id}`)
    const envelope = computeOperationToolpath(project, operation)
    if (!envelope) throw new Error(`e2e: ${id} did not generate`)
    const points = envelope.result.moves.flatMap((move) => [move.from, move.to])
    return {
      moveCount: envelope.result.moves.length,
      allHaveAngle: points.every((point) => typeof point.a === 'number'),
      minAcross: Math.min(...points.map((point) => point.y)),
      maxAcross: Math.max(...points.map((point) => point.y)),
    }
  }, operationId)
}

interface WrappedLineReadout {
  moveCount: number
  cutMoveCount: number
  minAngle: number
  maxAngle: number
  cutRadius: number
  maxRadiusError: number
  minStockZ: number
  centreHeight: number
}

/** The generated multi-turn line, mapped back onto the unturned bar. */
async function wrappedLine(page: Page, operationId: string): Promise<WrappedLineReadout> {
  return page.evaluate(async (id) => {
    const storeUrl = '/src/store/projectStore.ts'
    const generateUrl = '/src/engine/toolpaths/generateOperation.ts'
    const rotaryUrl = '/src/engine/rotaryFrame.ts'
    const projectUrl = '/src/types/project.ts'
    const { useProjectStore } = await import(storeUrl) as typeof import('../src/store/projectStore')
    const { computeOperationToolpath } = await import(generateUrl) as typeof import('../src/engine/toolpaths/generateOperation')
    const { stockSpacePoint } = await import(rotaryUrl) as typeof import('../src/engine/rotaryFrame')
    const { isRoundStock, roundStockCentre } = await import(projectUrl) as typeof import('../src/types/project')
    const project = useProjectStore.getState().project
    const operation = project.operations.find((candidate) => candidate.id === id)
    if (!operation) throw new Error(`e2e: the project has no operation ${id}`)
    if (!isRoundStock(project.stock)) throw new Error('e2e: the stock is not a bar')
    const stock = project.stock
    const envelope = computeOperationToolpath(project, operation)
    if (!envelope) throw new Error(`e2e: ${id} did not generate`)
    const moves = envelope.result.moves
    const angles = moves
      .flatMap((move) => [move.from.a, move.to.a])
      .filter((angle): angle is number => typeof angle === 'number')
    const cutPoints = moves
      .filter((move) => move.kind === 'cut')
      .flatMap((move) => [move.from, move.to])
      .map((point) => stockSpacePoint(point, stock))
    const centre = roundStockCentre(stock)
    const height = stock.thickness / 2
    const radii = cutPoints.map((point) => Math.hypot(point.y - centre, point.z - height))
    return {
      moveCount: moves.length,
      cutMoveCount: cutPoints.length,
      minAngle: Math.min(...angles),
      maxAngle: Math.max(...angles),
      cutRadius: radii[0] ?? 0,
      maxRadiusError: radii.length === 0 ? 0 : Math.max(...radii.map((radius) => Math.abs(radius - radii[0]))),
      minStockZ: cutPoints.length === 0 ? height : Math.min(...cutPoints.map((point) => point.z)),
      centreHeight: height,
    }
  }, operationId)
}

test('the 3D view draws the wrapped Around pass on the real bar', async ({ app, ui }, testInfo) => {
  const { page } = app
  const project = await seedAroundProject(page)
  expect((project.stock as RoundStock).shape).toBe('round')
  expect(project.setups.some((setup) => setup.kind === 'around')).toBe(true)

  // Wait for generation before reading the paths back: an operation with no
  // tool generates nothing, and the assertions below would then be vacuous.
  await expect(ui.generation.gearStatus(page)).toHaveAttribute('aria-label', /up to date/, { timeout: 30_000 })

  // The pocket's path is wrapped onto the bar: every point carries the rotary
  // angle and sits over the bar's centreline.
  const pocket = await pocketPath(page, 'op-around')
  expect(pocket.moveCount).toBeGreaterThan(0)
  expect(pocket.allHaveAngle).toBe(true)
  const centre = roundStockCentre(BAR)
  expect(Math.abs(pocket.minAcross - centre)).toBeLessThan(1e-6)
  expect(Math.abs(pocket.maxAcross - centre)).toBeLessThan(1e-6)

  // The multi-turn line keeps turning past 360°, reaches the underside of the
  // bar, and every cut stays at the same radius from the centreline.
  const line = await wrappedLine(page, 'op-around-line')
  expect(line.moveCount).toBeGreaterThan(0)
  expect(line.cutMoveCount).toBeGreaterThan(0)
  expect(line.maxAngle - line.minAngle).toBeGreaterThan(360)
  expect(line.minStockZ).toBeLessThan(line.centreHeight)
  expect(Math.abs(line.cutRadius - (BAR.thickness / 2 - 1))).toBeLessThan(0.05)
  expect(line.maxRadiusError).toBeLessThan(0.01)

  await ui.viewMenu.tab3d(page).click()
  const canvas = page.locator('#workspace-panel-preview3d canvas')
  await expect(canvas).toBeVisible()
  const size = await canvas.evaluate((element) => ({ width: element.clientWidth, height: element.clientHeight }))
  expect(size.width).toBeGreaterThan(0)
  expect(size.height).toBeGreaterThan(0)

  // What the overlay itself drew (issue #395 review), not a path regenerated
  // beside it: the wrapped line is over a hundred pieces, and its lowest drawn
  // point is below the bar's centreline — it really goes under the bar.
  const overlay = page.locator('#workspace-panel-preview3d .viewport-3d')
  await expect.poll(
    async () => Number(await overlay.getAttribute('data-toolpath-segments')),
    { timeout: 15_000 },
  ).toBeGreaterThanOrEqual(100)
  const drawnMinZ = Number(await overlay.getAttribute('data-toolpath-min-z'))
  expect(drawnMinZ).toBeLessThan(BAR.thickness / 2)

  // The scene build is asynchronous; give it a frame and capture the default
  // isometric view the workspace opens on.
  await page.waitForTimeout(500)
  await page.screenshot({ path: testInfo.outputPath('around-3d-default.png') })

  // A low angle: drag the panel down and sideways so the camera drops towards
  // the bar's underside without going under the floor, then zoom in. The
  // wrapped passes must still be there, underside included.
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  const centrePx = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }
  await page.mouse.move(centrePx.x, centrePx.y)
  await page.mouse.down()
  await page.mouse.move(centrePx.x - 60, centrePx.y - 40, { steps: 12 })
  await page.mouse.up()
  await page.mouse.move(centrePx.x, centrePx.y)
  await page.mouse.wheel(0, -240)
  await page.waitForTimeout(300)
  await page.screenshot({ path: testInfo.outputPath('around-3d-low-angle.png') })

  // The view is still the live 3D scene, not a blank panel after the drag.
  await expect(canvas).toBeVisible()
})

test('the Simulation tab turns the cut bar under the tool and can unroll it', async ({ app, ui }, testInfo) => {
  const { page } = app
  const project = await seedAroundProject(page)
  const aroundSetup = project.setups.find((setup) => setup.kind === 'around')!
  const topSetup = project.setups.find((setup) => setup.id !== aroundSetup.id)!

  await expect(ui.generation.gearStatus(page)).toHaveAttribute('aria-label', /up to date/, { timeout: 30_000 })

  // Selecting an operation gives the selected set something to simulate; with
  // nothing selected the run is an uncut sheet and Play tool is disabled.
  await ui.operations.rowByName(page, 'Around pocket').click()
  await ui.viewMenu.tabSimulation(page).click()

  // Two setups make the picker exist, and it offers both.
  await expect(ui.simSetup.picker(page)).toBeVisible()
  await expect(ui.simSetup.picker(page).locator('option')).toHaveCount(2)
  await expect(ui.simSetup.picker(page)).toContainText('Around')
  await expect(ui.simSetup.picker(page)).toContainText('Top')
  await expect(ui.simSetup.picker(page).locator(`option[value="${topSetup.id}"]`)).toHaveCount(1)

  await ui.simSetup.picker(page).selectOption(aroundSetup.id)
  await expect(ui.simSetup.picker(page)).toHaveValue(aroundSetup.id)
  await expect(ui.simSetup.note(page)).toContainText('Around')

  const viewport = ui.simSetup.viewport(page)
  await expect(viewport).toHaveAttribute('data-simulation-view', 'bar')
  await expect(viewport).toHaveAttribute('data-simulation-bar-angle', '0.000')
  await expect.poll(async () => (await viewportStats(page)).removed).toBeGreaterThan(0)
  expect((await viewportStats(page)).setup).toBe(aroundSetup.id)
  await expect(ui.simSetup.playTool(page)).toBeEnabled()
  const canvas = ui.simSetup.canvas(page)
  await expect(canvas).toBeVisible()
  await page.waitForTimeout(500)
  await page.screenshot({ path: testInfo.outputPath('around-simulation-bar-default.png') })

  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  const centre = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }
  await page.mouse.move(centre.x, centre.y)
  await page.mouse.down()
  await page.mouse.move(centre.x - 60, centre.y, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  await page.screenshot({ path: testInfo.outputPath('around-simulation-bar-side.png') })

  // This fixture is an X bar. Right looks along world X, so it is end-on.
  await ui.viewMenu.triggerSim(page).click()
  await ui.viewMenu.optionSim(page, 'Right').click()
  await page.waitForTimeout(300)
  await page.screenshot({ path: testInfo.outputPath('around-simulation-bar-end.png') })

  await ui.simSetup.playTool(page).click()
  await expect(ui.simSetup.progress(page)).toBeVisible()
  await ui.simSetup.playPause(page).click()
  await expect.poll(async () => Math.abs(Number(await viewport.getAttribute('data-simulation-bar-angle'))), {
    timeout: 30_000,
  }).toBeGreaterThan(0.001)
  await expect.poll(async () => Number((await ui.simSetup.progress(page).textContent())?.replace('%', '') ?? '0'), {
    timeout: 30_000,
  }).toBeGreaterThan(0)
  await ui.simSetup.playPause(page).click()

  await ui.simSetup.unrolled(page).click()
  await expect(viewport).toHaveAttribute('data-simulation-view', 'unrolled')
  await expect(viewport).toHaveAttribute('data-simulation-bar-angle', '0.000')
  await expect(ui.simSetup.unrolled(page)).toHaveAttribute('aria-pressed', 'true')
  await ui.simSetup.unrolled(page).click()
  await expect(viewport).toHaveAttribute('data-simulation-view', 'bar')
  await expect(ui.simSetup.unrolled(page)).toHaveAttribute('aria-pressed', 'false')

  await ui.simSetup.picker(page).selectOption(topSetup.id)
  await expect(viewport).toHaveAttribute('data-simulation-view', 'flat')
  await expect(ui.simSetup.unrolled(page)).toHaveCount(0)
})
