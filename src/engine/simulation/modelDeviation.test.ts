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

/// <reference types="node" />

/**
 * Deviation of simulated stock from the combined model (issue #1268).
 *
 * Synthetic grids pin each class and the lateral tolerance/allowance rule;
 * a 60 × 40 × 10 mm block with a 20 × 20 × 4 mm pocket pins the whole
 * comparison: a rough with stock-to-leave reads as intended leftover, the
 * finish's square corners left by a round tool as unintended leftover, an
 * injected over-deep move as a gouge attributed to its operation, the same job
 * cut from a Bottom setup, and rotary work as unverified.
 *
 * Run with: npx tsx src/engine/simulation/modelDeviation.test.ts
 */

import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { BOTTOM_SETUP_ID, projectWithFeatures, withBottomSetup } from '../../test/projectFixtures'
import { newProject, rectProfile, type MachiningSetup, type Operation, type OperationKind, type Project, type SketchFeature, type SketchProfile } from '../../types/project'
import { toolpathInStockFrame } from '../setupFrameProject'
import { setupFrame } from '../setupOrientation'
import type { ToolpathMove } from '../toolpaths/types'
import {
  classifyModelDeviation,
  MODEL_DEVIATION_CLASSES,
  MODEL_DEVIATION_GOUGE,
  MODEL_DEVIATION_INTENDED_LEFTOVER,
  MODEL_DEVIATION_OK,
  MODEL_DEVIATION_UNINTENDED_LEFTOVER,
  modelDeviationRegions,
  replayItemsWithRemovalAttribution,
  verifyAgainstModel,
  type ModelCellAllowances,
  type ModelVerificationResult,
} from './modelDeviation'
import { buildModelTargetHeights } from './modelTarget'
import { createSimulationGrid } from './grid'
import { simulateReplayItemsHeightfield } from './replay'
import type { SimulationGrid, SimulationReplayItem } from './types'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

// ── Synthetic grids ─────────────────────────────────────────────────────────

function syntheticGrid(cols: number, rows: number, top: number): SimulationGrid {
  return {
    originX: 0, originY: 0, cellSize: 1, cols, rows, stockBottomZ: 0, stockTopZ: top,
    topZ: new Float32Array(cols * rows).fill(top),
  }
}

function zeroAllowances(count: number): ModelCellAllowances {
  return { radial: new Float32Array(count), axial: new Float32Array(count) }
}

function testSyntheticClasses(): void {
  console.log('Testing each class on a synthetic grid...')
  const grid = syntheticGrid(10, 10, 5)
  const target = new Float32Array(100).fill(5)
  const allowances = zeroAllowances(100)
  const at = (col: number, row: number) => row * 10 + col
  grid.topZ[at(2, 2)] = 3 // 2 below the model
  grid.topZ[at(5, 5)] = 5.2 // inside the tolerance
  grid.topZ[at(7, 7)] = 5.8 // beyond the tolerance, within its axial allowance
  allowances.axial[at(7, 7)] = 0.5
  grid.topZ[at(7, 2)] = 7 // far beyond its allowance
  allowances.axial[at(7, 2)] = 0.5
  grid.topZ[at(2, 7)] = 5.8 // above the model, never cut: allowance 0
  const { cellClasses, deviation } = classifyModelDeviation(grid, target, allowances, 0.5)
  assert(cellClasses[at(2, 2)] === MODEL_DEVIATION_GOUGE, 'a cell 2 below the model is a gouge')
  assert(cellClasses[at(5, 5)] === MODEL_DEVIATION_OK, 'a cell within the tolerance is ok')
  assert(cellClasses[at(7, 7)] === MODEL_DEVIATION_INTENDED_LEFTOVER, 'a cell within its allowance is intended leftover')
  assert(cellClasses[at(7, 2)] === MODEL_DEVIATION_UNINTENDED_LEFTOVER, 'a cell beyond its allowance is unintended leftover')
  assert(cellClasses[at(2, 7)] === MODEL_DEVIATION_UNINTENDED_LEFTOVER, 'an uncut cell above tolerance has no allowance')
  assert(cellClasses[at(0, 0)] === MODEL_DEVIATION_OK, 'an exact cell is ok')
  assert(Math.abs(deviation[at(2, 2)] + 2) < 1e-6 && Math.abs(deviation[at(7, 2)] - 2) < 1e-6, 'deviation is simulated minus target')
  assert(MODEL_DEVIATION_CLASSES[MODEL_DEVIATION_GOUGE] === 'gouge', 'codes index the class list')

  const cellOperation = new Int32Array(100).fill(-1)
  cellOperation[at(2, 2)] = 1
  cellOperation[at(7, 7)] = 0
  const regions = modelDeviationRegions(grid, target, { cellClasses, deviation }, cellOperation, ['rough', 'probe'])
  assert(regions.length === 4, `four single-cell regions, got ${regions.length}`)
  const gouge = regions[0]
  assert(gouge.class === 'gouge' && gouge.operationId === 'probe', 'the gouge region comes first and names the cutting operation')
  assert(Math.abs(gouge.maxDeviation - 2) < 1e-6 && gouge.cellCount === 1 && gouge.area === 1, 'gouge size and area')
  assert(gouge.centroid.x === 2.5 && gouge.centroid.y === 2.5, 'centroid at the cell centre')
  assert(gouge.bounds.minX === 2 && gouge.bounds.maxX === 3, 'bounds are the cell extent')
  const intended = regions.find((region) => region.class === 'intendedLeftover')
  assert(intended?.operationId === 'rough', 'an intended leftover names the operation whose allowance applies')
  assert(regions.filter((region) => region.class === 'unintendedLeftover').every((region) => region.operationId === null), 'never-cut leftover has no operation')
}

function testSyntheticWalls(): void {
  console.log('Testing a wall: lateral tolerance and a radial skin...')
  // The model is a 10-high wall over columns 0..4 and a floor at 0 beyond.
  const grid = syntheticGrid(12, 3, 10)
  const target = new Float32Array(36)
  for (let row = 0; row < 3; row += 1) for (let col = 0; col < 5; col += 1) target[row * 12 + col] = 10
  for (let row = 0; row < 3; row += 1) for (let col = 8; col < 12; col += 1) grid.topZ[row * 12 + col] = 0

  // Columns 5..7 stand at full height: one cell off the wall is within a 1.0
  // tolerance, but with no allowance the rest is unintended.
  let classes = classifyModelDeviation(grid, target, zeroAllowances(36), 1).cellClasses
  assert(classes[12 + 5] === MODEL_DEVIATION_OK, 'one cell beside the wall is within the lateral tolerance')
  assert(classes[12 + 6] === MODEL_DEVIATION_UNINTENDED_LEFTOVER, 'two cells beside the wall is leftover')
  assert(classes[12 + 9] === MODEL_DEVIATION_OK, 'the floor is ok')

  // A 2.0 radial stock-to-leave makes the skin intended out to 2 + tolerance.
  const allowances = zeroAllowances(36)
  allowances.radial.fill(2)
  classes = classifyModelDeviation(grid, target, allowances, 0.5).cellClasses
  assert(classes[12 + 6] === MODEL_DEVIATION_INTENDED_LEFTOVER, 'a skin 2 from the wall is within a 2 radial allowance')
  assert(classes[12 + 7] === MODEL_DEVIATION_UNINTENDED_LEFTOVER, 'a skin 3 from the wall is beyond it')

  // A cut one cell into the wall is not a gouge at a 1.0 tolerance, two are.
  const cut = syntheticGrid(12, 3, 10)
  for (let row = 0; row < 3; row += 1) for (let col = 3; col < 12; col += 1) cut.topZ[row * 12 + col] = 0
  classes = classifyModelDeviation(cut, target, zeroAllowances(36), 1).cellClasses
  assert(classes[12 + 4] === MODEL_DEVIATION_OK, 'a wall one cell off is within the lateral tolerance')
  assert(classes[12 + 3] === MODEL_DEVIATION_GOUGE, 'two cells into the wall is a gouge')
}

// ── A real block, pocket and replay ─────────────────────────────────────────

const POCKET = { minX: 20, minY: 10, maxX: 40, maxY: 30, floor: 6 }

function feature(id: string, operation: SketchFeature['operation'], profile: SketchProfile, zTop: number, zBottom: number, face: 'top' | 'bottom' = 'top'): SketchFeature {
  return {
    id, name: id, kind: 'rect', folderId: null,
    sketch: { profile, origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation, z_top: zTop, z_bottom: zBottom, authoringFace: face, visible: true, locked: false,
  }
}

function operation(project: Project, id: string, kind: OperationKind, radial: number, axial: number): Operation {
  return {
    ...defaultOperationForTarget(project, kind, 'rough', { source: 'features', featureIds: ['pocket'] }, 0),
    id, name: id, stockToLeaveRadial: radial, stockToLeaveAxial: axial,
  }
}

function blockProject(pocketFace: 'top' | 'bottom' = 'top'): Project {
  const base = newProject('Verify', 'mm')
  base.stock = { ...base.stock, profile: rectProfile(0, 0, 60, 40), thickness: 10 }
  const pocketZ = pocketFace === 'top' ? [10, POCKET.floor] : [10 - POCKET.floor, 0]
  const project = projectWithFeatures(base, [
    feature('base', 'add', rectProfile(0, 0, 60, 40), 10, 0, pocketFace),
    feature('pocket', 'subtract', rectProfile(POCKET.minX, POCKET.minY, 20, 20), pocketZ[0], pocketZ[1], pocketFace),
  ])
  return {
    ...project,
    operations: [
      operation(project, 'rough', 'pocket', 0.5, 0.5),
      operation(project, 'finish', 'pocket', 0, 0),
      operation(project, 'deep', 'pocket', 0, 0),
      operation(project, 'turn', 'rotary_rough', 0, 0),
    ],
  }
}

/** A zig-zag over the tool-centre rectangle plus its perimeter loop, at one Z. */
function rasterMoves(minX: number, minY: number, maxX: number, maxY: number, z: number, step: number): ToolpathMove[] {
  const moves: ToolpathMove[] = []
  let at = { x: minX, y: minY, z: 12 }
  const to = (x: number, y: number, kind: ToolpathMove['kind'] = 'cut', toZ = z) => {
    const next = { x, y, z: toZ }
    moves.push({ kind, from: at, to: next })
    at = next
  }
  to(minX, minY, 'plunge')
  let forward = true
  for (let y = minY; ; y = Math.min(maxY, y + step)) {
    to(at.x, y)
    to(forward ? maxX : minX, y)
    forward = !forward
    if (y >= maxY) break
  }
  to(minX, maxY)
  to(minX, minY)
  to(maxX, minY)
  to(maxX, maxY)
  to(minX, maxY)
  return moves
}

function item(operationId: string, toolRadius: number, moves: ToolpathMove[]): SimulationReplayItem {
  return {
    operationId, operationName: operationId, toolRef: null, toolType: 'flat_endmill', toolRadius, vBitAngle: null,
    toolpath: { operationId, moves, warnings: [], bounds: null },
  }
}

/** The rough: a 2 mm radius flat endmill leaving 0.5 mm on walls and floor. */
function roughItem(): SimulationReplayItem {
  const inset = 2 + 0.5
  return item('rough', 2, rasterMoves(POCKET.minX + inset, POCKET.minY + inset, POCKET.maxX - inset, POCKET.maxY - inset, POCKET.floor + 0.5, 1.5))
}

/** The finish: a 4 mm radius flat endmill to size, which cannot reach the square corners. */
function finishItem(): SimulationReplayItem {
  const inset = 4
  return item('finish', 4, rasterMoves(POCKET.minX + inset, POCKET.minY + inset, POCKET.maxX - inset, POCKET.maxY - inset, POCKET.floor, 3))
}

/** A short cut 1.5 mm below the pocket floor in its middle. */
function deepItem(): SimulationReplayItem {
  const z = POCKET.floor - 1.5
  return item('deep', 1, [
    { kind: 'plunge', from: { x: 28, y: 20, z: 12 }, to: { x: 28, y: 20, z } },
    { kind: 'cut', from: { x: 28, y: 20, z }, to: { x: 32, y: 20, z } },
  ])
}

function verified(result: ModelVerificationResult): Extract<ModelVerificationResult, { status: 'verified' }> {
  assert(result.status === 'verified', `expected verified, got ${result.status} (${result.reason ?? ''})`)
  return result
}

function classAt(result: Extract<ModelVerificationResult, { status: 'verified' }>, x: number, y: number): string {
  const { grid } = result
  const col = Math.floor((x - grid.originX) / grid.cellSize)
  const row = Math.floor((y - grid.originY) / grid.cellSize)
  return MODEL_DEVIATION_CLASSES[result.cellClasses[row * grid.cols + col]]
}

async function testTarget(): Promise<void> {
  console.log('Testing the model target is the combined model\'s top surface...')
  const project = blockProject()
  const grid = createSimulationGrid(project, {})
  const target = await buildModelTargetHeights(grid, project)
  assert(target, 'a block with a base add has a model')
  const at = (x: number, y: number) => target[Math.floor(y / grid.cellSize) * grid.cols + Math.floor(x / grid.cellSize)]
  assert(Math.abs(at(30, 20) - POCKET.floor) < 1e-4, `pocket floor at ${POCKET.floor}, got ${at(30, 20)}`)
  assert(Math.abs(at(5, 5) - 10) < 1e-4, `stock top at 10, got ${at(5, 5)}`)
  const empty = newProject('Empty', 'mm')
  assert(await buildModelTargetHeights(createSimulationGrid(empty, {}), empty) === null, 'no model reads null')
}

function testAttributionParity(): void {
  console.log('Testing the attribution replay leaves the batch replay\'s heights...')
  const project = blockProject()
  const items = [roughItem(), finishItem(), deepItem()]
  const batch = simulateReplayItemsHeightfield(project, items, {}).grid
  const grid = createSimulationGrid(project, {})
  const { lastItem } = replayItemsWithRemovalAttribution(grid, items)
  assert(Buffer.from(grid.topZ.buffer).equals(Buffer.from(batch.topZ.buffer)), 'heights equal the batch replay byte for byte')
  const col = Math.floor(30 / grid.cellSize)
  const row = Math.floor(20 / grid.cellSize)
  assert(lastItem[row * grid.cols + col] === 2, 'the deep move cut the pocket centre last')
  assert(lastItem[0] === -1, 'an uncut corner of the stock has no item')
}

async function testRoughIntendedLeftover(): Promise<void> {
  console.log('Testing a rough with stock-to-leave reads as intended leftover...')
  const project = blockProject()
  const result = verified(await verifyAgainstModel({ project, items: [roughItem(), finishItem()], uptoOperationId: 'rough' }))
  assert(result.operationIds.join() === 'rough', 'only the rough is replayed up to it')
  assert(classAt(result, 30, 20) === 'intendedLeftover', `floor centre: intended, got ${classAt(result, 30, 20)}`)
  assert(classAt(result, POCKET.minX + 0.4, 20) === 'intendedLeftover', `wall skin: intended, got ${classAt(result, POCKET.minX + 0.4, 20)}`)
  assert(classAt(result, 5, 5) === 'ok', 'untouched stock outside the pocket is ok')
  assert(result.summary.gougeCells === 0, 'a rough leaving stock gouges nothing')
  const largest = result.regions.find((region) => region.class === 'intendedLeftover')
  assert(largest?.operationId === 'rough', 'the intended leftover names the rough')
  assert(result.tolerance >= result.grid.cellSize, 'the tolerance is at least one cell')
}

async function testFinishCornersUnintended(): Promise<void> {
  console.log('Testing a round tool in a square corner leaves unintended leftover...')
  const project = blockProject()
  // The rough and the finish together leave nothing to cut on the floor and walls.
  const both = verified(await verifyAgainstModel({ project, items: [roughItem(), finishItem()] }))
  assert(classAt(both, 30, 20) === 'ok' && both.summary.gougeCells === 0, 'rough then finish: the floor is ok, nothing gouged')
  // The finish alone: its corners are left beyond any allowance. (After the
  // rough, part of each corner is the rough's cut and reads against the rough's
  // allowance — the last operation that removed material.)
  const result = verified(await verifyAgainstModel({ project, items: [finishItem()] }))
  assert(classAt(result, 30, 20) === 'ok', `finished floor: ok, got ${classAt(result, 30, 20)}`)
  assert(classAt(result, POCKET.minX + 0.2, 20) === 'ok', 'finished wall: ok')
  assert(result.summary.gougeCells === 0 && result.summary.intendedLeftoverCells === 0, 'no gouge and no allowance left')
  const corners = result.regions.filter((region) => region.class === 'unintendedLeftover')
  assert(corners.length === 4, `one unintended region per corner, got ${corners.length}`)
  for (const corner of corners) {
    assert(corner.operationId === 'finish', `a corner names the finish, got ${corner.operationId}`)
    const nearX = Math.min(Math.abs(corner.centroid.x - POCKET.minX), Math.abs(corner.centroid.x - POCKET.maxX))
    const nearY = Math.min(Math.abs(corner.centroid.y - POCKET.minY), Math.abs(corner.centroid.y - POCKET.maxY))
    assert(nearX < 2 && nearY < 2, `the region sits in a corner, at (${corner.centroid.x}, ${corner.centroid.y})`)
    assert(corner.maxDeviation > 3, 'the corner stands near full pocket depth')
  }
}

async function testDeepMoveGouges(): Promise<void> {
  console.log('Testing an injected over-deep move is a gouge...')
  const project = blockProject()
  const result = verified(await verifyAgainstModel({ project, items: [roughItem(), finishItem(), deepItem()] }))
  const gouges = result.regions.filter((region) => region.class === 'gouge')
  assert(gouges.length === 1, `one gouge region, got ${gouges.length}`)
  assert(gouges[0].operationId === 'deep', 'the gouge names the deep operation')
  assert(Math.abs(gouges[0].maxDeviation - 1.5) < 1e-3, `1.5 mm deep, got ${gouges[0].maxDeviation}`)
  assert(gouges[0].bounds.minX >= 26.5 && gouges[0].bounds.maxX <= 33.5, 'the gouge spans the move and its cutter')
}

async function testHiddenFeaturesStayInTheModel(): Promise<void> {
  console.log('Testing a hidden feature is still part of the model (issue #1269)...')
  const shown = blockProject()
  const hidden: Project = {
    ...shown,
    features: shown.features.map((entry) => (entry.id === 'pocket' ? { ...entry, visible: false } : entry)),
  }
  const grid = createSimulationGrid(hidden, {})
  const target = await buildModelTargetHeights(grid, hidden)
  assert(target, 'the hidden project still has a model')
  const centre = target[Math.floor(20 / grid.cellSize) * grid.cols + Math.floor(30 / grid.cellSize)]
  assert(Math.abs(centre - POCKET.floor) < 1e-4, `a hidden pocket still lowers the target to its floor, got ${centre}`)
  const result = verified(await verifyAgainstModel({ project: hidden, items: [roughItem(), finishItem()] }))
  assert(result.summary.gougeCells === 0, 'machining a hidden pocket is not a gouge')
}

async function testBottomSetup(): Promise<void> {
  console.log('Testing a Bottom setup verifies in its own frame...')
  const project = withBottomSetup(blockProject('bottom'))
  const setup = project.setups.find((entry) => entry.id === BOTTOM_SETUP_ID) as MachiningSetup
  const frame = setupFrame(setup.orientation, project.stock)
  // The same setup-local job as Top, carried into canonical stock space.
  const canonical = [roughItem(), finishItem()].map((entry) => ({ ...entry, toolpath: toolpathInStockFrame(entry.toolpath, frame) }))
  const bottom = verified(await verifyAgainstModel({ project, items: canonical, setup }))
  assert(classAt(bottom, 30, 20) === 'ok', `bottom floor: ok, got ${classAt(bottom, 30, 20)}`)
  assert(bottom.summary.gougeCells === 0, 'the bottom job gouges nothing from its own face')
  assert(bottom.regions.filter((region) => region.class === 'unintendedLeftover').length === 4, 'its four corners are left')
  // The same canonical moves read from Top cut into the solid top face: the
  // blind Bottom pocket is not reachable there, so the model is solid.
  const top = verified(await verifyAgainstModel({ project, items: canonical }))
  assert(top.summary.gougeCells > 0, 'read from Top, the bottom job gouges the top face')
}

async function testUnverified(): Promise<void> {
  console.log('Testing rotary work and missing inputs are unverified...')
  const project = blockProject()
  const around: Pick<MachiningSetup, 'orientation' | 'kind'> = { kind: 'around', orientation: { axis: 'x', angleDeg: 0 } }
  let result = await verifyAgainstModel({ project, items: [finishItem()], setup: around })
  assert(result.status === 'unverified' && result.reason === 'aroundSetup', 'an Around setup is unverified')
  result = await verifyAgainstModel({ project, items: [item('turn', 2, finishItem().toolpath.moves)] })
  assert(result.status === 'unverified' && result.reason === 'rotaryOperation', 'a rotary operation is unverified')
  const turning: ToolpathMove = { kind: 'cut', from: { x: 30, y: 20, z: 8, a: 0 }, to: { x: 32, y: 20, z: 8, a: 90 } }
  result = await verifyAgainstModel({ project, items: [item('finish', 2, [turning])] })
  assert(result.status === 'unverified' && result.reason === 'rotaryMotion', 'a move turning A while cutting is unverified')
  result = await verifyAgainstModel({ project, items: [finishItem()], uptoOperationId: 'missing' })
  assert(result.status === 'unverified' && result.reason === 'uptoOperationNotFound', 'an unknown selection is unverified')
  const empty = newProject('Empty', 'mm')
  result = await verifyAgainstModel({ project: empty, items: [finishItem()] })
  assert(result.status === 'unverified' && result.reason === 'noModel', 'a project with no model is unverified')
  assert(result.warnings.some((warning) => warning.code === 'unknownOperation' && warning.operationId === 'finish'), 'an unknown operation is a warning')
}

async function main(): Promise<void> {
  testSyntheticClasses()
  testSyntheticWalls()
  await testTarget()
  testAttributionParity()
  await testRoughIntendedLeftover()
  await testFinishCornersUnintended()
  await testDeepMoveGouges()
  await testHiddenFeaturesStayInTheModel()
  await testBottomSetup()
  await testUnverified()
  console.log('modelDeviation tests passed')
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
