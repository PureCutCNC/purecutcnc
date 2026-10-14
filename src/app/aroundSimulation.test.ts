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
 * One Around setup's simulation input (issue #395 slice E).
 *
 * An Around setup is not a rotation: its job is the bar's surface unrolled
 * flat, so the simulation is handed `unrolledProject` — a block one
 * circumference across and one radius thick — and each of the setup's paths
 * unwrapped back onto that sheet. Everything downstream then cuts a flat job,
 * which this file proves by replaying it through the unchanged heightfield
 * engine and reading the stock it removes.
 *
 * An Around setup whose bar is no longer a round bar on the setup's axis
 * yields no simulation rather than an exception.
 *
 * Run with: npx tsx src/app/aroundSimulation.test.ts
 */

import {
  defaultTool, getStockBounds, newProject, rectProfile, roundStock,
  type Clamp, type MachiningSetup, type Operation, type Project, type SetupFace, type SketchFeature,
} from '../types/project'
import * as THREE from 'three'
import { projectWithFeatures } from '../test/projectFixtures'
import { syncProjectSetups } from '../store/helpers/setups'
import { aroundFrame } from '../engine/aroundFrame'
import { buildClampMesh } from '../engine/csg'
import { THEME_PALETTES } from '../theme/palette'
import { computeOperationToolpath } from '../engine/toolpaths/generateOperation'
import { normalizeToolForProject } from '../engine/toolpaths/geometry'
import type { PocketToolpathResult, ToolpathResult } from '../engine/toolpaths/types'
import { simulateReplayItemsHeightfield, type SimulationGrid, type SimulationResult } from '../engine/simulation'
import { findMillingOperationTool } from '../toolPolicy'
import { buildSimulationBar, buildSimulationSetupInput, resolveSimulationSetup, simulationSetups, type SimulationSetupInput } from './simulationSetup'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
  )
}

const UNITS = 'mm' as const
const THREE_PALETTE = THEME_PALETTES.dark.three

function positionsOf(mesh: THREE.Mesh): number[] {
  const attribute = mesh.geometry.getAttribute('position')
  return Array.from(attribute.array as ArrayLike<number>)
}

function assertPositionsEqual(actual: number[], expected: number[], label: string): void {
  assert(actual.length === expected.length, `${label}: ${actual.length} positions, expected ${expected.length}`)
  for (let i = 0; i < actual.length; i++) {
    assert(actual[i] === expected[i], `${label}: position ${i} is ${actual[i]}, expected ${expected[i]}`)
  }
}

function sceneBox(mesh: THREE.Mesh): THREE.Box3 {
  mesh.updateMatrixWorld(true)
  return new THREE.Box3().setFromObject(mesh)
}

const AROUND_BAR = roundStock(40, 200, 'x', { x: 10, y: 30 })

/**
 * A round bar's workholding, sized the way `roundWorkholding.ts` keeps it:
 * centred on the bar's centreline (y 50, radius 20), `height` = bar radius +
 * its own radius. Its along extent is the fixture's own.
 */
const WORKHOLDING: Clamp[] = [
  { id: 'chuck', name: 'Chuck', type: 'chuck', x: -40, y: 10, w: 55, h: 80, height: 60, visible: true },
  { id: 'tail', name: 'Tailstock', type: 'tailstock', x: 200, y: 8, w: 40, h: 84, height: 62, visible: true },
]

function operation(overrides: Partial<Operation> & Pick<Operation, 'kind' | 'target'>): Operation {
  return {
    id: 'op1', name: 'op', pass: 'rough', enabled: true, showToolpath: true, debugToolpath: false,
    toolRef: 't1', stepdown: 2, stepover: 0.4, feed: 800, plungeFeed: 300, rpm: 18000,
    pocketPattern: 'offset', pocketAngle: 0, stockToLeaveRadial: 0, stockToLeaveAxial: 0,
    finishWalls: true, finishFloor: true, carveDepth: 2, maxCarveDepth: 2,
    cutDirection: 'conventional', machiningOrder: 'level_first', ...overrides,
  }
}

function pocketFeature(
  id: string,
  rect: { x: number; y: number; w: number; h: number },
  zTop: number,
  zBottom: number,
  authoringFace: SetupFace,
): SketchFeature {
  return {
    id, name: id, kind: 'rect', folderId: null,
    sketch: {
      profile: rectProfile(rect.x, rect.y, rect.w, rect.h),
      origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [],
    },
    operation: 'subtract', z_top: zTop, z_bottom: zBottom,
    authoringFace, visible: true, locked: false,
  }
}

/**
 * A bar with an Around setup, one Around pocket — flat coordinates as a Top
 * feature would store them, heights from the surface — and the pocket that
 * cuts it. The operation's generated path is the wrapped one the seam
 * actually returns.
 */
function makeAroundProject(stock = AROUND_BAR): { project: Project; setup: MachiningSetup; paths: Map<string, ToolpathResult> } {
  const base = newProject('sim-setup-around', 'mm')
  base.stock = stock
  base.tools = [{ ...defaultTool('mm', 1), id: 't1', name: 'Flat endmill', diameter: 3, maxCutDepth: 80 }]
  const withFeature = projectWithFeatures(base, [
    pocketFeature('around-pocket', { x: 40, y: 35, w: 30, h: 20 }, 40, 36, 'around'),
  ])
  const setup: MachiningSetup = {
    id: 'setup-around', name: 'Around', kind: 'around', orientation: { axis: 'x', angleDeg: 0 },
    indexing: 'manual', registration: [], notes: '', operationIds: [],
  }
  const op = operation({
    id: 'opAround', name: 'Around pocket', kind: 'pocket',
    target: { source: 'features', featureIds: ['around-pocket'] },
    setupId: setup.id, toolRef: 't1', stepdown: 2,
  })
  const project = syncProjectSetups({ ...withFeature, operations: [op], setups: [setup], activeSetupId: setup.id })
  const envelope = computeOperationToolpath(project, op)
  assert(envelope, 'fixture: the Around operation is generated')
  return { project, setup, paths: new Map([[op.id, envelope.result]]) }
}

function simulationInput(project: Project, setup: MachiningSetup, paths: ReadonlyMap<string, ToolpathResult>): SimulationSetupInput {
  const input = buildSimulationSetupInput(project, setup, paths)
  assert(input, `fixture: ${setup.id} yields a simulation input`)
  return input
}

/** The consumer's replay: every operation of the setup, into one fresh grid. */
function replaySetup(input: SimulationSetupInput, targetLongAxisCells = 140): SimulationResult {
  const items = input.operations.flatMap((op) => {
    const toolpath = input.toolpaths.get(op.id)
    const tool = findMillingOperationTool(input.project, op)
    if (!toolpath || !tool) return []
    const normalized = normalizeToolForProject(tool, input.project)
    return [{
      operationId: op.id,
      operationName: op.name,
      toolRef: tool.id,
      toolType: tool.type,
      toolRadius: normalized.radius,
      vBitAngle: normalized.vBitAngle,
      toolpath,
    }]
  })
  return simulateReplayItemsHeightfield(input.project, items, { targetLongAxisCells })
}

function topZAt(grid: SimulationGrid, x: number, y: number): number {
  const col = Math.min(grid.cols - 1, Math.max(0, Math.floor((x - grid.originX) / grid.cellSize)))
  const row = Math.min(grid.rows - 1, Math.max(0, Math.floor((y - grid.originY) / grid.cellSize)))
  return grid.topZ[row * grid.cols + col]
}

function testAroundIsUnrolledFlat(): void {
  console.log('Testing an Around input is the flat sheet with unwrapped paths...')
  const { project, setup, paths } = makeAroundProject()
  const frame = aroundFrame(AROUND_BAR)
  const input = simulationInput(project, setup, paths)

  // The stock is a block: no shape, no axis, one circumference across and one
  // radius thick.
  assert(!('shape' in input.project.stock), 'the flat stock is a plain block')
  assert(!('axis' in input.project.stock), 'and carries no bar axis')
  assert(input.project.stock.thickness === frame.radius, 'one radius thick')
  const flatBounds = getStockBounds(input.project.stock)
  assert(
    flatBounds.minX === 10 && flatBounds.minY === frame.sheetStart
    && flatBounds.maxX === 210 && flatBounds.maxY === frame.sheetStart + frame.circumference,
    `length along the bar by one circumference across, got ${JSON.stringify(flatBounds)}`,
  )
  // Only the Around features, lowered by the radius.
  assertEqual(input.project.features.map((feature) => feature.id), ['around-pocket'], 'only Around features')
  assertEqual(
    input.project.features.map((feature) => [feature.z_top, feature.z_bottom]),
    [[40 - frame.radius, 36 - frame.radius]],
    'feature heights lowered by the radius',
  )
  assert(input.project !== project, 'the flat project is a copy')
  assert(project.stock.shape === 'round', 'and the round project is untouched')

  // The path is unwrapped: no point carries an angle and the across
  // coordinate spreads over the sheet rather than sitting on the centreline.
  const local = input.toolpaths.get('opAround')
  assert(local, 'the Around path is in the input')
  for (const move of local.moves) {
    for (const point of [move.from, move.to]) {
      assert(!('a' in point), 'an unwrapped point has no angle key')
      assert(
        point.y >= frame.sheetStart - 1e-9 && point.y <= frame.sheetStart + frame.circumference + 1e-9,
        `an unwrapped point stays on the sheet, got y = ${point.y}`,
      )
    }
  }
  assertEqual(
    (local as PocketToolpathResult).stepLevels,
    [38 - frame.radius, 36 - frame.radius],
    'cut levels are lowered by the radius too',
  )
  assert(
    new Set(local.moves.flatMap((move) => [move.from.y, move.to.y])).size > 1,
    'the path varies across the sheet, not along a single line',
  )
}

function testAroundSimulatesFlat(): void {
  console.log('Testing an Around setup simulates on the flat sheet...')
  const { project, setup, paths } = makeAroundProject()
  const input = simulationInput(project, setup, paths)
  const result = replaySetup(input)

  assert(result.stats.removedCellCount > 0, 'the Around pocket removes material from the flat sheet')
  const frame = aroundFrame(AROUND_BAR)
  const centre = { x: 55, y: frame.sheetStart + 15 }
  assert(
    topZAt(result.grid, centre.x, centre.y) < input.project.stock.thickness - 2 * 0.5,
    'the pocket is cut at its flat position',
  )
  assert(
    Math.abs(topZAt(result.grid, centre.x - 60, centre.y) - input.project.stock.thickness) < 1e-6,
    'and the sheet beside it is untouched',
  )
}

function testFlatSetupDropsAroundFeatures(): void {
  console.log('Testing a flat setup simulates without the project Around features...')
  const base = newProject('flat-vs-around', 'mm')
  base.stock = AROUND_BAR
  base.tools = [{ ...defaultTool('mm', 1), id: 't1', name: 'Flat endmill', diameter: 3, maxCutDepth: 80 }]
  const built = projectWithFeatures(base, [
    pocketFeature('top-pocket', { x: 40, y: 35, w: 20, h: 20 }, 40, 36, 'top'),
    // An Around shape in the project, with no Around operation and no Around
    // setup: a flat setup must not draw it on the bar's rectangle (issue #395).
    pocketFeature('around-cut', { x: 60, y: 45, w: 10, h: 10 }, 40, 36, 'around'),
  ])
  const top = built.setups[0]
  const op = operation({
    id: 'opTop', name: 'Top pocket', kind: 'pocket',
    target: { source: 'features', featureIds: ['top-pocket'] }, setupId: top.id, toolRef: 't1',
  })
  const project = syncProjectSetups({ ...built, operations: [op], activeSetupId: top.id })
  const input = simulationInput(project, top, new Map())
  assertEqual(input.project.features.map((feature) => feature.id), ['top-pocket'], 'only the flat features simulate')
  assert(input.project !== project, 'and the input project is a copy when an Around feature is present')

  // No Around feature anywhere: the Top setup still passes the project through.
  const plain = syncProjectSetups({
    ...projectWithFeatures(base, [pocketFeature('top-pocket', { x: 40, y: 35, w: 20, h: 20 }, 40, 36, 'top')]),
    operations: [op],
    activeSetupId: top.id,
  })
  assert(simulationInput(plain, plain.setups[0], new Map()).project === plain,
    'a project with no Around feature simulates exactly the object it always did')
}

function testPickerAndBrokenAround(): void {
  console.log('Testing the picker lists an Around setup and a broken one yields no simulation...')
  const { project, setup, paths } = makeAroundProject()
  assertEqual(simulationSetups(project).map((entry) => entry.id), ['setup-around'], 'the picker lists the Around setup')
  assertEqual(resolveSimulationSetup(project, null, project.operations[0]).id, 'setup-around', 'and resolution finds it')

  // The bar is no longer a round bar on the setup's axis: no simulation, no
  // exception.
  for (const broken of [
    { ...project, stock: newProject().stock },
    { ...project, stock: roundStock(40, 200, 'y', { x: 10, y: 30 }) },
  ]) {
    let threw = false
    let input: SimulationSetupInput | null = null
    try {
      input = buildSimulationSetupInput(broken, setup, paths)
    } catch {
      threw = true
    }
    assert(!threw, 'a broken Around setup does not throw')
    assert(input === null, 'and yields no simulation')
  }
}

function testAroundClampBandsAreFlatBoxes(): void {
  console.log('Testing an Around input clips its chuck and tailstock to the sheet, as boxes...')
  const { project, setup, paths } = makeAroundProject()
  const withClamps: Project = { ...project, clamps: WORKHOLDING }
  const input = simulationInput(withClamps, setup, paths)
  const frame = aroundFrame(AROUND_BAR)

  // The simulation draws the sheet's block, not the real round bar — which is
  // what makes the mesh builder take the ordinary clamp box for these two
  // types instead of the cylinder about the bar's axis.
  assert(!('shape' in input.project.stock), 'the Around input draws the unrolled block')

  for (const original of WORKHOLDING) {
    const band = input.project.clamps.find((clamp) => clamp.id === original.id)
    assert(band, `the ${original.type} band is in the Around input`)
    assertEqual(
      { x: band.x, w: band.w, y: band.y, h: band.h },
      { x: original.x, w: original.w, y: frame.sheetStart, h: frame.circumference },
      `the ${original.type} keeps the fixture's extent along the bar and one turn across`,
    )
    assert(
      band.y >= frame.sheetStart && band.y + band.h <= frame.sheetStart + frame.circumference,
      `the ${original.type} band is inside the sheet across`,
    )
    assert(
      Math.abs(band.height - (original.height - frame.radius)) < 1e-9,
      `the ${original.type} height is measured from the sheet's bottom`,
    )

    const mesh = buildClampMesh(band, false, false, UNITS, THREE_PALETTE, input.project.stock)
    const box = sceneBox(mesh)
    // Scene X is project x, scene Z is project y, scene Y is project z.
    assert(
      Math.abs(box.min.x - original.x) < 1e-6 && Math.abs(box.max.x - (original.x + original.w)) < 1e-6,
      `the ${original.type} box keeps the fixture's extent along the bar`,
    )
    assert(
      Math.abs(box.min.z - frame.sheetStart) < 1e-4
      && Math.abs(box.max.z - (frame.sheetStart + frame.circumference)) < 1e-4,
      `the ${original.type} box spans the sheet across`,
    )
    // Above the sheet's surface it stands exactly the height the fixture held
    // above the real bar's surface.
    assert(
      Math.abs((box.max.y - frame.radius) - (original.height - AROUND_BAR.thickness)) < 1e-6,
      `the ${original.type} box stands ${original.height - AROUND_BAR.thickness} above the sheet`,
    )

    // It really is the ordinary box: the same clamp with no stock to round it
    // on, position for position. Handed the real bar, that same clamp is the
    // cylinder whose huge disc this fix removes.
    assertPositionsEqual(
      positionsOf(mesh),
      positionsOf(buildClampMesh(band, false, false, UNITS, THREE_PALETTE)),
      `the ${original.type} band draws as the ordinary clamp box`,
    )
    assert(
      positionsOf(buildClampMesh(band, false, false, UNITS, THREE_PALETTE, AROUND_BAR)).length !== positionsOf(mesh).length,
      `the ${original.type} on the real bar is the round mesh, not this box`,
    )
  }
}

function testFlatSetupKeepsItsClampsAndBar(): void {
  console.log('Testing a flat setup\'s input is unchanged: the project\'s own clamps and round bar...')
  const base = newProject('flat-vs-around', 'mm')
  base.stock = AROUND_BAR
  base.tools = [{ ...defaultTool('mm', 1), id: 't1', name: 'Flat endmill', diameter: 3, maxCutDepth: 80 }]
  const built = projectWithFeatures(base, [
    pocketFeature('top-pocket', { x: 40, y: 35, w: 20, h: 20 }, 40, 36, 'top'),
    pocketFeature('around-cut', { x: 60, y: 45, w: 10, h: 10 }, 40, 36, 'around'),
  ])
  const top = built.setups[0]
  const op = operation({
    id: 'opTop', name: 'Top pocket', kind: 'pocket',
    target: { source: 'features', featureIds: ['top-pocket'] }, setupId: top.id, toolRef: 't1',
  })
  const project = syncProjectSetups({ ...built, operations: [op], setups: [top], activeSetupId: top.id, clamps: WORKHOLDING })
  const input = simulationInput(project, top, new Map())

  // A flat setup takes `projectInSetupFrame(flatFaceProject(project))`, which
  // this change never touches: the clamps are the caller's own array and the
  // stock is still the real bar, so the round chuck keeps drawing round.
  assert(input.project.clamps === project.clamps, 'a flat setup hands back the project\'s own clamps, unchanged')
  assertEqual(input.project.clamps, project.clamps, 'deep-equal to the clamps it had before the Around fix')
  assert(input.project.stock === project.stock, 'and the real round bar, so its chuck stays round')
}

function testSecondTurnPocketAndBarData(): void {
  const { project, setup } = makeAroundProject()
  const frame = aroundFrame(AROUND_BAR)
  const secondTurn = projectWithFeatures({ ...project, featureDefinitions: {} }, [
    pocketFeature('around-pocket', { x: 40, y: 35 + frame.circumference, w: 30, h: 20 }, 40, 36, 'around'),
  ])
  const envelope = computeOperationToolpath(secondTurn, secondTurn.operations[0])
  assert(envelope, 'second turn pocket generates')
  assert(envelope.result.moves.some((move) => move.kind === 'cut' && (move.from.a ?? 0) > 360), 'fixture really cuts on the second turn')
  const input = simulationInput(secondTurn, setup, new Map([['opAround', envelope.result]]))
  for (const move of input.toolpaths.get('opAround')!.moves) {
    for (const point of [move.from, move.to]) assert(point.y >= frame.sheetStart - 1e-8 && point.y <= frame.sheetStart + frame.circumference + 1e-8, 'second turn paths are folded into first turn')
  }
  const result = replaySetup(input)
  assert(result.stats.removedCellCount > 0, 'a pocket on the second turn removes material')
  assert(topZAt(result.grid, 55, 45) < frame.radius - 1, 'second-turn pocket cuts the corresponding first-turn cells')
  const withClamps = { ...project, clamps: [...WORKHOLDING, { ...WORKHOLDING[0], id: 'hidden', visible: false }] }
  const bar = buildSimulationBar(withClamps, frame)
  assert(bar, 'pure bar helper builds Around data')
  assert(bar.stock === project.stock, 'bar uses the actual round stock')
  assert(bar.origin === project.origin, 'bar keeps the real origin')
  assertEqual(bar.frame, frame, 'Around frame passes through')
  assertEqual(bar.clamps, WORKHOLDING, 'only visible real fixtures, with no band rewrite')
  assertEqual(input.bar?.stock, secondTurn.stock, 'setup input carries bar display data to the model')
  assert(simulationInput({ ...project, operations: [] }, setup, new Map()).bar, 'an empty Around setup still draws the bar')
  const top = { ...setup, kind: undefined, orientation: { axis: 'x' as const, angleDeg: 0 } }
  assert(!simulationInput({ ...project, setups: [top] }, top, new Map()).bar, 'flat setup has no bar display variant')
}

testSecondTurnPocketAndBarData()
testAroundIsUnrolledFlat()
testAroundSimulatesFlat()
testPickerAndBrokenAround()
testFlatSetupDropsAroundFeatures()
testAroundClampBandsAreFlatBoxes()
testFlatSetupKeepsItsClampsAndBar()

console.log('Around simulation tests passed')
