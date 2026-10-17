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
 * The app wiring of a real square-blank Around simulation (issue #1016
 * C2-R2V).
 *
 * The path is the accepted S3 engine output — `generateRotaryOperation` on an
 * ordinary rotary rough with an imported prism model — replayed through the
 * shipped `buildSimulationSetupInput` and the shipped `computeSimulationResult`
 * / `useSimulationModel` entry points. The round and flat paths are untouched;
 * a square blank carries its transient descriptor into every grid the app
 * builds, and the material model removes the real corners while the untouched
 * ends stay square.
 *
 * `generateRotaryOperation` is called directly because this base's post-setup
 * policy still refuses square production dispatch (the reviewed U1 policy is
 * not in this base). The simulation consumes the generated stock-space path
 * exactly as it will once that policy lands; this file reports that dependency
 * rather than reimplementing or editing the policy.
 *
 * Mutations these assertions were checked against, each applied on its own and
 * reverted:
 * - `computeSimulationResult`'s visible branch dropping `squareBar` → "the
 *   visible replay is a square grid" and the actual-band test fail;
 * - `getBaseGrid` dropping `squareBar` → "a playback base grid is a square
 *   grid" fails;
 * - the empty-stats baseline reading `stockTopZ` (the corner maximum) or the
 *   unrolled bar's thickness → "the empty result reports the true material
 *   baseline" fails;
 * - `buildSimulationSetupInput` dropping the descriptor → "the input carries
 *   the square descriptor" fails;
 * - a square mismatched-axis Around setup returning null (the round behaviour)
 *   instead of throwing → "a square mismatch refuses instead of drawing a flat
 *   sheet" fails.
 *
 * Run with: npx tsx src/app/squareSimulation.test.ts
 */

import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { defaultOperationForTarget } from '../store/helpers/operationDefaults'
import { projectWithFeatures } from '../test/projectFixtures'
import {
  defaultTool,
  getStockBounds,
  newProject,
  rectProfile,
  roundStock,
  type MachiningSetup,
  type Operation,
  type Project,
  type SketchFeature,
  type SquareStock,
} from '../types/project'
import { squareStock } from '../types/barStock'
import { computeMeshBounds, serializeImportedMesh } from '../engine/importedMesh'
import { generateRotaryOperation } from '../engine/toolpaths/rotaryOperation'
import type { ToolpathResult } from '../engine/toolpaths/types'
import { squareMaterialIntervals } from '../engine/simulation/squareReplay'
import { PlaybackController } from '../engine/simulation/playback'
import type { SimulationGrid } from '../engine/simulation'
import { buildSimulationSetupInput, type SimulationSetupInput } from './simulationSetup'
import {
  computeSimulationResult,
  useSimulationModel,
  type SimulationResultInput,
} from './useSimulationModel'

const SIDE = 12
const LENGTH = 30
/** Coarse enough for a focused test; the kernel-resolution parity is #1016 R1's. */
const DETAIL = 60

function near(actual: number, expected: number, label: string, epsilon = 1e-6): void {
  assert(Math.abs(actual - expected) <= epsilon, `${label}: expected ${expected}, got ${actual}`)
}

/**
 * A rotary project on a square blank with one imported prism model and one real
 * rotary rough. `at` places the blank (and the model with it), so a nonzero
 * value exercises a grid origin away from zero; `axis` swaps along/across.
 */
function squareRotaryProject(
  axis: 'x' | 'y',
  at: { x: number; y: number } = { x: 0, y: 0 },
  units: 'mm' | 'inch' = 'mm',
): { project: Project; operation: Operation; setup: MachiningSetup } {
  const base = newProject('square simulation', units)
  base.meta.created = base.meta.modified = '2026-01-01T00:00:00.000Z'
  base.meta.maxTravelZ = 25
  base.meta.projectType = 'rotary'
  base.stock = squareStock(SIDE, LENGTH, axis, at)
  base.tools = [{
    ...defaultTool(units, 1),
    id: 't1',
    type: 'ball_endmill',
    diameter: 2,
    defaultStepover: 0.8,
    defaultStepdown: 1,
  }]

  // The accepted fixture's small closed asymmetric prism: along 3..27, across
  // -2..2 about the bar centre, top 9 / bottom 4. Placed inside the blank.
  const raw = new Float32Array([
    3, -2, 4, 27, -2, 4, 27, 2, 4, 3, 2, 4,
    3, -2, 8, 27, -2, 9, 27, 2, 9, 3, 2, 8,
  ])
  const alongAt = axis === 'x' ? at.x : at.y
  const acrossAt = axis === 'x' ? at.y : at.x
  const positions = new Float32Array(raw.length)
  for (let i = 0; i < raw.length; i += 3) {
    const along = alongAt + raw[i]
    const across = acrossAt + SIDE / 2 + raw[i + 1]
    const z = raw[i + 2]
    if (axis === 'x') {
      positions[i] = along
      positions[i + 1] = across
    } else {
      positions[i] = across
      positions[i + 1] = along
    }
    positions[i + 2] = z
  }
  const index = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7])
  base.modelAssets = { asset: serializeImportedMesh({ positions, index, bounds: computeMeshBounds(positions) }, 'stl') }

  const model: SketchFeature = {
    id: 'model', name: 'Model', kind: 'stl', operation: 'model', authoringFace: 'top', folderId: null,
    sketch: {
      profile: axis === 'x' ? rectProfile(at.x + 3, at.y + 4, 24, 4) : rectProfile(at.x + 4, at.y + 3, 4, 24),
      origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [],
    },
    stl: { format: 'stl', meshAssetId: 'asset', scale: 1, axisSwap: 'none' },
    z_top: 9, z_bottom: 4, visible: true, locked: false,
  }
  const around: SketchFeature = {
    ...model, id: 'sketch', name: 'Sketch', kind: 'rect', operation: 'subtract',
    stl: null, authoringFace: 'around', z_top: 12, z_bottom: 10,
  }
  const project = projectWithFeatures(base, [model, around])
  project.setups.push({
    ...project.setups[0],
    id: 'around', name: 'Around', kind: 'around', orientation: { axis, angleDeg: 0 },
  })
  project.activeSetupId = 'around'
  project.clamps = [{
    id: 'chuck', name: 'Chuck', type: 'chuck',
    x: at.x,
    y: at.y,
    w: axis === 'x' ? 2 : 12,
    h: axis === 'x' ? 12 : 2,
    height: 14,
    visible: true,
  }]
  const operation: Operation = {
    ...defaultOperationForTarget(project, 'rotary_rough', 'rough', { source: 'features', featureIds: ['model'] }, 0),
    setupId: 'around',
    stockToLeaveRadial: 0.4,
  }
  project.operations = [operation]
  return { project, operation, setup: project.setups.find((entry) => entry.id === 'around')! }
}

/**
 * The accepted generated path. `computeOperationToolpath` is deliberately not
 * used: this base's post-setup policy refuses square production dispatch until
 * the reviewed U1 policy lands; the generator itself is the accepted S3 seam.
 */
function generated(project: Project, operation: Operation): ToolpathResult {
  const result = generateRotaryOperation(project, operation)
  assert(result.moves.length > 0, 'fixture: the generated square rough is nonempty')
  assert(result.warnings.length === 0, `fixture: the generated square rough warns (${JSON.stringify(result.warnings)})`)
  return result
}

function inputFor(project: Project, operation: Operation, toolpath: ToolpathResult): SimulationSetupInput {
  const input = buildSimulationSetupInput(project, project.setups.find((entry) => entry.id === 'around')!, new Map([[operation.id, toolpath]]))
  assert(input, 'fixture: the around setup yields a simulation input')
  return input
}

function resultArgs(
  project: Project,
  operation: Operation,
  input: SimulationSetupInput,
  mode: 'selected' | 'visible',
  withOperation = true,
): SimulationResultInput {
  const paths = new Map([[operation.id, input.toolpaths.get(operation.id)!]])
  return {
    setupInput: input,
    project,
    simulationMode: mode,
    simulationDetailCells: DETAIL,
    selectedInSetup: withOperation ? operation : null,
    paths,
  }
}

function minBaseline(grid: SimulationGrid): number {
  assert(grid.initialTopZ, 'fixture: a square grid carries its immutable baseline')
  let min = Infinity
  for (const value of grid.initialTopZ) if (value < min) min = value
  return min
}

/** The cell containing a project point. */
function cellAt(grid: SimulationGrid, x: number, y: number): number {
  const col = Math.min(grid.cols - 1, Math.max(0, Math.floor((x - grid.originX) / grid.cellSize)))
  const row = Math.min(grid.rows - 1, Math.max(0, Math.floor((y - grid.originY) / grid.cellSize)))
  return row * grid.cols + col
}

/** A project-space point at `angleDeg` on the nominal sheet, at along `along`. */
function sheetPoint(grid: SimulationGrid, along: number, angleDeg: number): { x: number; y: number } {
  const frame = grid.squareBar!.frame
  const across = frame.zero + angleDeg * frame.circumference / 360
  return frame.axis === 'x' ? { x: along, y: across } : { x: across, y: along }
}

function cellAtSheetPoint(grid: SimulationGrid, along: number, angleDeg: number): number {
  const point = sheetPoint(grid, along, angleDeg)
  return cellAt(grid, point.x, point.y)
}

type HookArgs = Parameters<typeof useSimulationModel>[0]
type HookResult = ReturnType<typeof useSimulationModel>

function renderModel(args: HookArgs): HookResult {
  let captured: HookResult | null = null
  function Capture() {
    // eslint-disable-next-line react-hooks/globals
    captured = useSimulationModel(args)
    return null
  }
  renderToStaticMarkup(createElement(Capture))
  assert(captured, 'useSimulationModel rendered')
  return captured
}

// ---------------------------------------------------------------------------
// 1. The setup input carries the descriptor, both shapes, both axes
// ---------------------------------------------------------------------------

function testSetupInputDescriptor(): void {
  console.log('Testing the setup input carries the actual square descriptor...')
  for (const axis of ['x', 'y'] as const) {
    const { project, operation } = squareRotaryProject(axis, { x: 5, y: 7 })
    const toolpath = generated(project, operation)
    const input = inputFor(project, operation, toolpath)
    const stock = project.stock as SquareStock
    assert(input.squareBar, `${axis}: the input carries a square descriptor`)
    near(input.squareBar!.side, SIDE, `${axis}: the side is the physical blank side`)
    assert(input.squareBar!.frame.axis === axis, `${axis}: the descriptor keeps the Around frame`)
    near(input.squareBar!.frame.radius, SIDE / 2, `${axis}: the nominal pivot stays side/2`)
    near(input.squareBar!.frame.circumference, Math.PI * SIDE, `${axis}: the nominal sheet stays pi·side`)
    assert(input.bar?.stock === project.stock, `${axis}: the bar carries the real square stock`)
    assert(input.project.stock.thickness === SIDE / 2, `${axis}: the replay project is the one-radius unrolled block`)
    assert(!('squareBar' in input.project.stock), `${axis}: the descriptor is transient, not on the block`)
    assert(stock.shape === 'square', `${axis}: fixture stock is square`)
  }

  // The round path stays exactly as it was: no square descriptor, unchanged bar.
  const round = newProject('round', 'mm')
  round.meta.projectType = 'rotary'
  round.stock = roundStock(12, 30, 'x', { x: 5, y: 7 })
  const roundSetup: MachiningSetup = {
    id: 'around', name: 'Around', kind: 'around', orientation: { axis: 'x', angleDeg: 0 },
    indexing: 'manual', registration: [], notes: '', operationIds: [],
  }
  const roundInput = buildSimulationSetupInput({ ...round, setups: [roundSetup], activeSetupId: 'around' }, roundSetup, new Map())
  assert(roundInput, 'a round Around setup still yields an input')
  assert(roundInput!.squareBar === undefined, 'a round bar gains no square descriptor')
  assert(roundInput!.bar?.stock.shape === 'round', 'and keeps the round bar')

  // A square blank on a mismatched Around axis must surface, never draw a flat
  // sheet that claims the job succeeded. The round bar keeps its null result.
  const square = squareRotaryProject('x')
  const wrong: MachiningSetup = { ...square.setup, orientation: { axis: 'y', angleDeg: 0 } }
  assert.throws(
    () => buildSimulationSetupInput({ ...square.project, setups: [wrong], activeSetupId: 'around' }, wrong, new Map()),
    RangeError,
    'a square mismatch refuses instead of drawing a flat sheet',
  )
  const roundWrong: MachiningSetup = { ...roundSetup, orientation: { axis: 'y', angleDeg: 0 } }
  const roundWrongProject = { ...round, setups: [roundWrong], activeSetupId: 'around' }
  assert.equal(
    buildSimulationSetupInput(roundWrongProject, roundWrong, new Map()),
    null,
    'a round mismatch keeps the established no-simulation result',
  )
}

// ---------------------------------------------------------------------------
// 2. Every app grid entry point gets the descriptor
// ---------------------------------------------------------------------------

function testEveryEntryPoint(): void {
  console.log('Testing every app grid entry point builds a square grid...')
  const { project, operation, setup } = squareRotaryProject('x')
  const toolpath = generated(project, operation)
  const input = inputFor(project, operation, toolpath)

  // empty (no selected operation)
  const empty = computeSimulationResult(resultArgs(project, operation, input, 'selected', false))
  assert(empty.grid.squareBar, 'the empty result is a square grid')
  assert(empty.grid.initialTopZ, 'with the immutable square baseline')
  assert(empty.grid.squareMaterial instanceof Map, 'and the interval map')
  assert.equal(empty.stats.removedCellCount, 0, 'a virgin square removes nothing')
  assert.equal(empty.stats.processedMoveCount, 0, 'and processes no move')
  near(empty.stats.minTopZ, minBaseline(empty.grid), 'the empty result reports the true material baseline')
  assert(
    empty.stats.minTopZ < empty.grid.stockTopZ - 0.5,
    'the baseline is the inscribed surface, not the corner maximum',
  )

  // selected
  const selected = computeSimulationResult(resultArgs(project, operation, input, 'selected'))
  assert(selected.grid.squareBar, 'the selected cut is a square grid')
  assert(selected.stats.removedCellCount > 0, 'the real generated rough removes physical material')

  // visible/all
  const visible = computeSimulationResult(resultArgs(project, operation, input, 'visible'))
  assert(visible.grid.squareBar, 'the visible replay is a square grid')
  assert.equal(visible.stats.removedCellCount, selected.stats.removedCellCount, 'selected and visible agree on the removed cells')
  near(visible.stats.minTopZ, selected.stats.minTopZ, 'and on the lowest material', 1e-5)
  assert.equal(visible.stats.processedMoveCount, selected.stats.processedMoveCount, 'and process the same moves')

  // prior-operation playback base grid, through the real hook
  const hook = renderModel({
    project,
    centerTab: 'simulation',
    simulationMode: 'selected',
    simulationDetailCells: DETAIL,
    selectedOperation: operation,
    selectedToolpath: toolpath,
    requestToolpath: () => Promise.resolve(null),
  })
  assert(hook.simulationResult?.grid.squareBar, 'the hook result is a square grid')
  const playback = hook.simulationPlaybackInput
  assert(playback, 'playback is available for a first square operation')
  const base = playback!.getBaseGrid()
  assert(base.squareBar, 'a playback base grid is a square grid')
  assert(base.initialTopZ, 'with its immutable baseline')
  assert.equal(base.squareMaterial?.size, 0, 'a base grid starts as virgin square material')
  assert.equal(hook.simulationPlaybackInput?.units, 'mm', 'units follow the project')
  assert.equal(setup.kind, 'around', 'fixture setup is Around')
}

// ---------------------------------------------------------------------------
// 3. The physical result: corners cleared, gaps kept, ends square
// ---------------------------------------------------------------------------

function testActualGeneratedBand(): void {
  console.log('Testing the actual generated band clears corners and keeps the untouched ends square...')
  const { project, operation } = squareRotaryProject('x')
  const toolpath = generated(project, operation)
  const input = inputFor(project, operation, toolpath)
  const visible = computeSimulationResult(resultArgs(project, operation, input, 'visible'))
  const grid = visible.grid
  const frame = grid.squareBar!.frame
  const alongMid = 15

  // A corner ray at 45 degrees loses real material; the flat ray at 0 degrees
  // starts on the inscribed face, never on a circumscribed cylinder.
  const cornerIndex = cellAtSheetPoint(grid, alongMid, 45)
  const cornerBaseline = grid.initialTopZ![cornerIndex]
  assert(
    grid.topZ[cornerIndex] < cornerBaseline - 2,
    `a corner is cleared (Z ${grid.topZ[cornerIndex]} vs baseline ${cornerBaseline})`,
  )
  const flatIndex = cellAtSheetPoint(grid, alongMid, 0)
  assert(
    Math.abs(grid.initialTopZ![flatIndex] - SIDE / 2) < 0.1,
    'a flat ray baseline is half the side',
  )
  assert(
    grid.topZ[flatIndex] < grid.initialTopZ![flatIndex],
    'the flat ray is cut as the round target reaches it',
  )

  // Untouched stock ends stay square: no interval was written there and the
  // outer surface is still the blank baseline.
  for (const along of [0.5, LENGTH - 0.5]) {
    const endIndex = cellAtSheetPoint(grid, along, 0)
    assert.equal(grid.squareMaterial!.has(endIndex), false, `the end at ${along} keeps its virgin material`)
    assert.equal(grid.topZ[endIndex], grid.initialTopZ![endIndex], `the end at ${along} stays square`)
  }

  // An interval-only removal keeps the outer top and is still counted: the
  // stats count every cell with recorded material, not the moved envelope.
  let interiorOnly = -1
  for (let index = 0; index < grid.topZ.length && interiorOnly < 0; index += 1) {
    const intervals = squareMaterialIntervals(grid, index)
    if (intervals.length >= 4 && grid.topZ[index] === grid.initialTopZ![index]) interiorOnly = index
  }
  assert(interiorOnly >= 0, 'the generated rough leaves an interior gap behind an intact outer shell')
  const intervals = squareMaterialIntervals(grid, interiorOnly)
  assert.equal(intervals[0], 0, 'the surviving core starts at the stock bottom')
  assert(intervals[1] > 0 && intervals[2] > intervals[1], 'the interior gap is a real removed band')
  assert(intervals[3] >= intervals[2], 'and the outer shell survives above it')
  assert.equal(
    visible.stats.removedCellCount,
    grid.squareMaterial!.size,
    'a material-writing cell counts once, even when its outer top never moved',
  )
  assert(frame.radius === SIDE / 2, 'every grid point is measured on the true pivot')
}

// ---------------------------------------------------------------------------
// 4. Playback advances, back-seeks and resets on the same square material
// ---------------------------------------------------------------------------

function testPlaybackParity(): void {
  console.log('Testing square playback advance, back-seek and reset parity...')
  const { project, operation } = squareRotaryProject('x')
  const toolpath = generated(project, operation)
  const input = inputFor(project, operation, toolpath)
  const selected = computeSimulationResult(resultArgs(project, operation, input, 'selected'))
  const hook = renderModel({
    project,
    centerTab: 'simulation',
    simulationMode: 'selected',
    simulationDetailCells: DETAIL,
    selectedOperation: operation,
    selectedToolpath: toolpath,
    requestToolpath: () => Promise.resolve(null),
  })
  const playback = hook.simulationPlaybackInput
  assert(playback, 'square playback input exists')

  // Build the controller exactly as the viewport does: the hook's base grid
  // plus the selected operation's local moves.
  const controller = new PlaybackController(
    playback!.getBaseGrid(),
    playback!.moves,
    {
      toolType: playback!.toolType,
      toolRadius: playback!.toolRadius,
      vBitAngle: playback!.vBitAngle,
    },
    { maxSegmentLength: playback!.maxSegmentLength },
  )
  assert(controller.liveGrid.squareBar, 'the live playback grid is square')
  assert.equal(controller.liveGrid.squareMaterial?.size, 0, 'and starts virgin')

  // Scrub forward to the end, then compare the whole grid with the batch pass.
  controller.seekToFraction(1)
  const played = controller.liveGrid
  const batch = selected.grid
  let compared = 0
  for (let index = 0; index < batch.topZ.length; index += 1) {
    const left = squareMaterialIntervals(played, index)
    const right = squareMaterialIntervals(batch, index)
    assert.equal(left.length, right.length, `cell ${index}: playback keeps the batch's interval count`)
    for (let i = 0; i < left.length; i += 1) {
      near(left[i], right[i], `cell ${index} interval ${i}`, 1e-4)
    }
    compared += 1
  }
  assert.equal(compared, batch.topZ.length, 'every cell is compared')

  // Back-seek resets and replays; a reset to zero restores the virgin blank.
  // The sampled cells include the generated path's interval-only gap.
  let gapCell = -1
  for (let index = 0; index < batch.topZ.length && gapCell < 0; index += 1) {
    if (squareMaterialIntervals(batch, index).length >= 4 && batch.topZ[index] === batch.initialTopZ![index]) gapCell = index
  }
  assert(gapCell >= 0, 'the generated path leaves an interval-only gap to re-check after back-seek')
  controller.seekToFraction(0.5)
  controller.seekToFraction(1)
  const reseeked = controller.liveGrid
  for (const index of [0, 1, gapCell, Math.floor(batch.topZ.length / 2), batch.topZ.length - 1]) {
    const left = squareMaterialIntervals(reseeked, index)
    const right = squareMaterialIntervals(batch, index)
    assert.equal(left.length, right.length, `cell ${index}: a back-seek then replay matches the batch`)
    for (let i = 0; i < left.length; i += 1) near(left[i], right[i], `cell ${index} back-seek interval ${i}`, 1e-4)
  }
  controller.reset()
  assert.equal(controller.liveGrid.squareMaterial?.size, 0, 'reset restores the virgin square material')
  for (let index = 0; index < controller.liveGrid.topZ.length; index += 1) {
    assert.equal(controller.liveGrid.topZ[index], controller.baseGrid.topZ[index], `cell ${index}: reset restores the square top`)
  }
}

// ---------------------------------------------------------------------------
// 5. Both axes, inch units and an off-origin grid all carry the actual blank
// ---------------------------------------------------------------------------

function testAxesUnitsOffOrigin(): void {
  console.log('Testing the square wiring on both axes, inch units and an off-origin grid...')
  for (const [axis, at, units] of [
    ['y', { x: 0, y: 0 }, 'mm'],
    ['x', { x: 5, y: 7 }, 'inch'],
  ] as const) {
    const { project, operation } = squareRotaryProject(axis, at, units)
    const toolpath = generated(project, operation)
    const input = inputFor(project, operation, toolpath)
    const result = computeSimulationResult(resultArgs(project, operation, input, 'visible'))
    const label = `${axis}/${units}/at(${at.x},${at.y})`
    assert(result.grid.squareBar, `${label}: the grid is square`)
    const bounds = getStockBounds(project.stock)
    const grid = result.grid
    // The replay project is the unrolled sheet: along the bar the grid keeps
    // the real stock end (the off-origin coordinate); across it spans the
    // nominal sheet from its seam start.
    const alongOrigin = axis === 'x' ? grid.originX : grid.originY
    const acrossOrigin = axis === 'x' ? grid.originY : grid.originX
    const alongMin = axis === 'x' ? bounds.minX : bounds.minY
    const frame = grid.squareBar!.frame
    near(alongOrigin, alongMin, `${label}: the grid origin follows the real stock end`, 1e-9)
    near(acrossOrigin, frame.sheetStart, `${label}: across spans the nominal sheet`, 1e-9)
    assert(result.stats.removedCellCount > 0, `${label}: the real generated band removes material`)
    assert(result.grid.squareBar!.side === SIDE, `${label}: the descriptor keeps the side`)
    assert(project.meta.units === units, `${label}: the project keeps its units`)
  }
}

testSetupInputDescriptor()
testEveryEntryPoint()
testActualGeneratedBand()
testPlaybackParity()
testAxesUnitsOffOrigin()

console.log('square simulation wiring tests passed')
