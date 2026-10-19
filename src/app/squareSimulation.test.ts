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
 * The app wiring of a real square-blank Around simulation (issue #1016 C2).
 *
 * A square blank is simulated exactly like the round bar: the same radial
 * heightfield, the same cutting kernel, the same playback and the same
 * synchronous app path. Its only square-specific input is the grid
 * initialization descriptor, which must reach every grid the app builds — the
 * empty result, the selected cut, the visible replay and the playback starting
 * stock — through one option builder.
 *
 * The path is the accepted production output — `computeOperationToolpath` on an
 * ordinary rotary rough with an imported prism model, on a blank held by the
 * real default chuck — replayed through the shipped `buildSimulationSetupInput`
 * and `computeSimulationResult` / `useSimulationModel` entry points. The hook is
 * rendered to static markup, which runs the component body but never an effect:
 * a square result and its playback base grid appearing there prove the
 * synchronous path, with no worker or deferred delivery to stand in for it.
 *
 * Mutations these assertions were checked against, each applied on its own and
 * reverted:
 * - `simulationBuildOptions` dropping `squareBar` → "the input carries the
 *   square initialization descriptor" / every entry point assertion fails;
 * - `computeSimulationResult`'s visible branch dropping the options → "the
 *   visible replay is a square grid" fails;
 * - the playback base grid built without the shared options → "a playback base
 *   grid starts at the square baseline" fails;
 * - `emptySimulationStats` reading `stockTopZ` (the corner maximum) → "the
 *   empty result reports the true material baseline" fails;
 * - `buildSimulationSetupInput` dropping the descriptor → "the input carries
 *   the square initialization descriptor" fails;
 * - delivering the square result from an effect/worker again → the static-render
 *   assertion "the square result is synchronous" fails;
 * - a square mismatched-axis Around setup returning null (the round behaviour)
 *   instead of throwing → "a square mismatch refuses instead of drawing a flat
 *   sheet" fails.
 *
 * Run with: npx tsx src/app/squareSimulation.test.ts
 */

import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { getStockBounds, newProject, roundStock, type MachiningSetup, type SquareStock } from '../types/project'
import { PlaybackController } from '../engine/simulation/playback'
import type { AroundFrame } from '../engine/aroundFrame'
import type { SimulationGrid } from '../engine/simulation'
import { buildSimulationSetupInput } from './simulationSetup'
import { computeSimulationResult, useSimulationModel } from './useSimulationModel'
import {
  DETAIL,
  LENGTH,
  SIDE,
  generated,
  inputFor,
  resultArgs,
  squareRotaryProject,
} from '../test/squareSimulationFixture'

function near(actual: number, expected: number, label: string, epsilon = 1e-6): void {
  assert(Math.abs(actual - expected) <= epsilon, `${label}: expected ${expected}, got ${actual}`)
}

/** The lowest cell of a grid's immutable starting surface. */
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
function sheetPoint(frame: AroundFrame, along: number, angleDeg: number): { x: number; y: number } {
  const across = frame.zero + angleDeg * frame.circumference / 360
  return frame.axis === 'x' ? { x: along, y: across } : { x: across, y: along }
}

function cellAtSheetPoint(grid: SimulationGrid, frame: AroundFrame, along: number, angleDeg: number): number {
  const point = sheetPoint(frame, along, angleDeg)
  return cellAt(grid, point.x, point.y)
}

type HookArgs = Parameters<typeof useSimulationModel>[0]
type HookResult = ReturnType<typeof useSimulationModel>

/**
 * Render the hook as the app does. `renderToStaticMarkup` runs the component
 * body but no effects, so anything a square blank needs must be computed
 * synchronously — exactly the path the viewport consumes.
 */
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

/** Cells whose current height is below the grid's immutable starting surface. */
function removedCells(grid: SimulationGrid): number {
  const baseline = grid.initialTopZ!
  let removed = 0
  for (let index = 0; index < grid.topZ.length; index += 1) {
    if (grid.topZ[index] < baseline[index] - 1e-9) removed += 1
  }
  return removed
}

// ---------------------------------------------------------------------------
// 1. The setup input carries the descriptor, both shapes, both axes
// ---------------------------------------------------------------------------

function testSetupInputDescriptor(): void {
  console.log('Testing the setup input carries the square initialization descriptor...')
  for (const axis of ['x', 'y'] as const) {
    const { project, operation } = squareRotaryProject(axis, { x: 5, y: 7 })
    const toolpath = generated(project, operation)
    const input = inputFor(project, operation, toolpath)
    const stock = project.stock as SquareStock
    assert(input.squareBar, `${axis}: the input carries a square initialization descriptor`)
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
// 2. Every app grid entry point gets the same square initialization
// ---------------------------------------------------------------------------

function testEveryEntryPoint(): void {
  console.log('Testing every app grid entry point builds the same square grid...')
  const { project, operation, setup } = squareRotaryProject('x')
  const toolpath = generated(project, operation)
  const input = inputFor(project, operation, toolpath)

  // empty (no selected operation)
  const empty = computeSimulationResult(resultArgs(project, operation, input, 'selected', false))
  assert(!('squareBar' in empty.grid), 'the grid carries no runtime square switch')
  assert(!('squareMaterial' in empty.grid), 'and no interval material map')
  assert(empty.grid.initialTopZ, 'the empty result keeps the immutable square baseline')
  assert.equal(empty.stats.removedCellCount, 0, 'a virgin square removes nothing')
  assert.equal(empty.stats.processedMoveCount, 0, 'and processes no move')
  near(empty.stats.minTopZ, minBaseline(empty.grid), 'the empty result reports the true material baseline')
  assert(
    empty.stats.minTopZ < empty.grid.stockTopZ - 0.5,
    'the baseline is the inscribed surface, not the corner maximum',
  )
  for (let index = 0; index < empty.grid.topZ.length; index += 1) {
    assert.equal(empty.grid.topZ[index], empty.grid.initialTopZ![index], `virgin cell ${index} starts at its baseline`)
  }

  // selected
  const selected = computeSimulationResult(resultArgs(project, operation, input, 'selected'))
  assert(selected.grid.initialTopZ, 'the selected cut is seeded square')
  assert(selected.stats.removedCellCount > 0, 'the real generated rough removes physical material')

  // visible/all
  const visible = computeSimulationResult(resultArgs(project, operation, input, 'visible'))
  assert(visible.grid.initialTopZ, 'the visible replay is seeded square')
  assert.equal(visible.stats.removedCellCount, selected.stats.removedCellCount, 'selected and visible agree on the removed cells')
  near(visible.stats.minTopZ, selected.stats.minTopZ, 'and on the lowest material', 1e-5)
  assert.equal(visible.stats.processedMoveCount, selected.stats.processedMoveCount, 'and process the same moves')

  // prior-operation playback base grid, through the real hook, rendered without
  // effects: the square result and the lazy base grid are both synchronous.
  const hook = renderModel({
    project,
    centerTab: 'simulation',
    simulationMode: 'selected',
    simulationDetailCells: DETAIL,
    selectedOperation: operation,
    selectedToolpath: toolpath,
    requestToolpath: () => Promise.resolve(null),
  })
  assert.equal(hook.simulationInputPending, false, 'the square result is synchronous — no worker or effect delivery')
  assert(hook.simulationResult, 'the hook has a square result on the first render')
  assert(hook.simulationResult!.grid.initialTopZ, 'the hook result is seeded square')
  const playback = hook.simulationPlaybackInput
  assert(playback, 'playback is available for a first square operation')
  const base = playback!.getBaseGrid()
  assert(base === playback!.getBaseGrid(), 'repeated playback calls return the same starting stock')
  assert(base.initialTopZ, 'a playback base grid starts at the square baseline')
  for (let index = 0; index < base.topZ.length; index += 1) {
    assert.equal(base.topZ[index], base.initialTopZ![index], `base cell ${index} is virgin square stock`)
  }
  assert.equal(hook.simulationPlaybackInput!.units, 'mm', 'units follow the project')
  assert.equal(setup.kind, 'around', 'fixture setup is Around')
}

// ---------------------------------------------------------------------------
// 3. The physical result: corners cleared, untouched ends square
// ---------------------------------------------------------------------------

function testActualGeneratedBand(): void {
  console.log('Testing the actual generated band clears corners and keeps the untouched ends square...')
  const { project, operation } = squareRotaryProject('x')
  const toolpath = generated(project, operation)
  const input = inputFor(project, operation, toolpath)
  const visible = computeSimulationResult(resultArgs(project, operation, input, 'visible'))
  const grid = visible.grid
  const frame = input.squareBar!.frame
  const baseline = grid.initialTopZ!
  const alongMid = 15

  // A corner ray at 45 degrees loses real material, and its baseline stands
  // above the nominal radius: the shared kernel cuts above the inscribed
  // surface. The flat ray starts on the inscribed face, never on a
  // circumscribed cylinder.
  const cornerIndex = cellAtSheetPoint(grid, frame, alongMid, 45)
  const cornerBaseline = baseline[cornerIndex]
  assert(
    cornerBaseline > SIDE / 2 + 1,
    `the corner baseline stands above the nominal radius (${cornerBaseline} vs ${SIDE / 2})`,
  )
  assert(
    grid.topZ[cornerIndex] < cornerBaseline - 1,
    `a corner above the nominal radius is cleared (Z ${grid.topZ[cornerIndex]} vs baseline ${cornerBaseline})`,
  )
  const flatIndex = cellAtSheetPoint(grid, frame, alongMid, 0)
  assert(
    Math.abs(baseline[flatIndex] - SIDE / 2) < 0.1,
    'a flat ray baseline is half the side',
  )
  assert(
    grid.topZ[flatIndex] < baseline[flatIndex],
    'the flat ray is cut as the round target reaches it',
  )

  // Untouched stock ends stay square: no path reached them, so their heights
  // are still the blank's own cross section.
  for (const along of [0.5, LENGTH - 0.5]) {
    const endIndex = cellAtSheetPoint(grid, frame, along, 0)
    assert.equal(grid.topZ[endIndex], baseline[endIndex], `the end at ${along} stays square`)
  }

  // Statistics measure every cell against its own starting height, and count
  // only cells the kernel actually lowered.
  assert.equal(
    visible.stats.removedCellCount,
    removedCells(grid),
    'the removed-cell count is the cells lowered below their own baseline',
  )
  let deepest = 0
  for (let index = 0; index < grid.topZ.length; index += 1) {
    const depth = baseline[index] - grid.topZ[index]
    if (depth > deepest) deepest = depth
  }
  near(visible.stats.maxRemovedDepth, deepest, 'the deepest removal is measured from each cell baseline', 1e-9)
  assert(frame.radius === SIDE / 2, 'every grid point is measured on the true pivot')
}

// ---------------------------------------------------------------------------
// 4. Playback advances, back-seeks and resets on the same square heightfield
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
  const base = playback!.getBaseGrid()
  const controller = new PlaybackController(
    base,
    playback!.moves,
    {
      toolType: playback!.toolType,
      toolRadius: playback!.toolRadius,
      vBitAngle: playback!.vBitAngle,
    },
    { maxSegmentLength: playback!.maxSegmentLength },
  )
  assert.equal(controller.liveGrid.initialTopZ, base.initialTopZ, 'playback shares the immutable square baseline')

  // Scrub forward to the end, then compare the whole heightfield with the
  // batch pass. Both run the one shared kernel.
  controller.seekToFraction(1)
  const played = controller.liveGrid
  const batch = selected.grid
  assert.equal(played.topZ.length, batch.topZ.length, 'playback and batch grids have the same size')
  let maxDifference = 0
  for (let index = 0; index < batch.topZ.length; index += 1) {
    const difference = Math.abs(played.topZ[index] - batch.topZ[index])
    if (difference > maxDifference) maxDifference = difference
  }
  near(maxDifference, 0, 'subdivided playback matches the batch replay at every cell', 1e-6)

  // Back-seek resets and replays; the result must still match the batch pass.
  controller.seekToFraction(0.5)
  controller.seekToFraction(1)
  const reseeked = controller.liveGrid
  for (let index = 0; index < batch.topZ.length; index += 1) {
    near(reseeked.topZ[index], batch.topZ[index], `cell ${index}: a back-seek then replay matches the batch`, 1e-6)
  }

  // Reset restores the prior-operation base grid exactly — the square blank's
  // own starting heights, not a uniform cylinder.
  controller.reset()
  for (let index = 0; index < controller.liveGrid.topZ.length; index += 1) {
    assert.equal(controller.liveGrid.topZ[index], base.topZ[index], `cell ${index}: reset restores the square base top`)
  }
  assert.equal(controller.liveGrid.initialTopZ, base.initialTopZ, 'reset keeps the immutable square baseline')
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
    assert(input.squareBar, `${label}: the input carries the square descriptor`)
    assert(result.grid.initialTopZ, `${label}: the grid is seeded square`)
    const bounds = getStockBounds(project.stock)
    const grid = result.grid
    // The replay project is the unrolled sheet: along the bar the grid keeps
    // the real stock end (the off-origin coordinate); across it spans the
    // nominal sheet from its seam start.
    const alongOrigin = axis === 'x' ? grid.originX : grid.originY
    const acrossOrigin = axis === 'x' ? grid.originY : grid.originX
    const alongMin = axis === 'x' ? bounds.minX : bounds.minY
    const frame = input.squareBar!.frame
    near(alongOrigin, alongMin, `${label}: the grid origin follows the real stock end`, 1e-9)
    near(acrossOrigin, frame.sheetStart, `${label}: across spans the nominal sheet`, 1e-9)
    assert(result.stats.removedCellCount > 0, `${label}: the real generated band removes material`)
    assert(input.squareBar!.side === SIDE, `${label}: the descriptor keeps the side`)
    assert(project.meta.units === units, `${label}: the project keeps its units`)
  }
}

function main(): void {
  testSetupInputDescriptor()
  testEveryEntryPoint()
  testActualGeneratedBand()
  testPlaybackParity()
  testAxesUnitsOffOrigin()
  console.log('square simulation wiring tests passed')
}

try {
  main()
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : error)
  throw error
}
