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
 * A round bar simulated from a flat Top or Bottom setup (issue #1049).
 *
 * Before this, a flat setup seeded its heightfield from the stock's bounding
 * box, so a rotary project's round bar was drawn as a square block on Top and
 * Bottom. The grid now starts at the bar's real upper profile:
 * `pivot + sqrt(R² − d²)` for a cell `d` across from the centreline, and the
 * grid's empty value where `|d| ≥ R`. Nothing else changes: block and square
 * blanks keep their exact grids, and the unchanged flat kernel cuts the seeded
 * surface as it cuts a block.
 *
 * The expected profile is written out in this file from the bar's geometry —
 * it never calls the production seeding helper.
 *
 * Mutations these assertions were checked against, each applied on its own to
 * `src/engine/simulation/grid.ts` from a `cp` backup and reverted:
 * - filling the bounding box again (`topZ.fill(spec.stockTopZ)` instead of the
 *   seed) → `x/mm/top: cell (0,0): expected 26.3703…, got 40`;
 * - swapping the across axis (`'x'` treated as `'y'` and vice versa) →
 *   `x/mm/top: cell (0,0): expected 26.3703…, got 0`;
 * - dropping the empty-outside-the-bar rule (clamping the square root to 0
 *   instead of starting empty) → `x/mm/top: cell (0,19): expected 0, got 20`.
 *
 * Run with: npx tsx src/engine/simulation/flatRoundBar.test.ts
 */

import assert from 'node:assert/strict'
import {
  getStockBounds,
  newProject,
  roundStock,
  type MachiningSetup,
  type Project,
  type SetupFace,
  type Stock,
  type StockAxis,
} from '../../types/project'
import { normalizeSquareStock, squareStock } from '../../types/barStock'
import { createSimulationGrid } from './grid'
import { simulateReplayItemsHeightfield } from './replay'
import type { SimulationGrid } from './types'
import { buildSimulationSetupInput } from '../../app/simulationSetup'
import { simulationBuildOptions } from '../../app/simulationCompute'

const DETAIL = 96

function approx(actual: number, expected: number, label: string, epsilon = 1e-4): void {
  assert(
    Math.abs(actual - expected) <= epsilon,
    `${label}: expected ${expected}, got ${actual} (delta ${actual - expected})`,
  )
}

function faceSetup(face: SetupFace): MachiningSetup {
  return {
    id: face === 'bottom' ? 'setup-bottom' : 'setup-top',
    name: face === 'bottom' ? 'Bottom' : 'Top',
    orientation: { axis: 'x', angleDeg: face === 'bottom' ? 180 : 0 },
    indexing: 'manual',
    registration: [],
    notes: '',
    operationIds: [],
  }
}

interface BarFixture {
  project: Project
  axis: StockAxis
  diameter: number
  /** The centreline coordinate across the bar, from the stock bounds. */
  centre: number
}

function flatProject(stock: Stock, units: 'mm' | 'inch' = 'mm'): Project {
  const project = newProject('flat-bar', units)
  project.stock = stock
  project.setups = [faceSetup('top'), faceSetup('bottom')]
  project.activeSetupId = faceSetup('top').id
  return project
}

function barFixture(axis: StockAxis, diameter: number, units: 'mm' | 'inch' = 'mm'): BarFixture {
  const length = units === 'mm' ? 200 : 8
  const at = axis === 'x' ? { x: 10, y: 30 } : { x: 30, y: 10 }
  const stock = roundStock(diameter, length, axis, at)
  const bounds = getStockBounds(stock)
  return {
    project: flatProject(stock, units),
    axis,
    diameter,
    centre: axis === 'x' ? (bounds.minY + bounds.maxY) / 2 : (bounds.minX + bounds.maxX) / 2,
  }
}

/** The grid the app builds for one setup, plus the setup-local project. */
function setupSimulation(fixture: BarFixture, face: SetupFace): {
  input: NonNullable<ReturnType<typeof buildSimulationSetupInput>>
  options: ReturnType<typeof simulationBuildOptions>
  grid: SimulationGrid
} {
  const setup = fixture.project.setups.find((entry) => entry.id === faceSetup(face).id)!
  const input = buildSimulationSetupInput(fixture.project, setup, new Map())
  assert(input, `${fixture.axis}/${face}: the setup yields a simulation input`)
  const options = simulationBuildOptions(input, DETAIL)
  return { input, options, grid: createSimulationGrid(input.project, options) }
}

function cellCentre(grid: SimulationGrid, col: number, row: number): { x: number; y: number } {
  return {
    x: grid.originX + (col + 0.5) * grid.cellSize,
    y: grid.originY + (row + 0.5) * grid.cellSize,
  }
}

/** The across distance from the bar's centreline, in the test's own terms. */
function acrossDistance(fixture: BarFixture, grid: SimulationGrid, col: number, row: number): number {
  const centre = cellCentre(grid, col, row)
  return (fixture.axis === 'x' ? centre.y : centre.x) - fixture.centre
}

/** The analytic bar top at `distance` across, written independently here. */
function analyticTop(fixture: BarFixture, distance: number): number {
  const radius = fixture.diameter / 2
  const squared = distance * distance
  if (squared >= radius * radius) return 0
  return radius + Math.sqrt(radius * radius - squared)
}

// ---------------------------------------------------------------------------
// 1. The seeded profile, cell by cell, on both axes, units and setups.
// ---------------------------------------------------------------------------

function testSeedMatchesAnalyticProfile(): void {
  console.log('Testing a flat setup seeds the round bar\'s analytic profile on both axes, units and faces...')
  let combos = 0
  for (const axis of ['x', 'y'] as const) {
    for (const units of ['mm', 'inch'] as const) {
      const diameter = units === 'mm' ? 40 : 1.5
      const fixture = barFixture(axis, diameter, units)
      let reference: SimulationGrid | null = null
      for (const face of ['top', 'bottom'] as const) {
        const { input, grid } = setupSimulation(fixture, face)
        const hasDescriptor = input.flatRoundBar !== undefined
        assert(hasDescriptor, `${axis}/${units}/${face}: the input carries the flat round-bar descriptor`)
        assert(!('flatRoundBar' in grid), 'the initialization descriptor must not land on the grid')
        assert(grid.initialTopZ, `${axis}/${units}/${face}: the seeded grid carries an immutable baseline`)
        assert(grid.stockTopZ === diameter, `${axis}/${units}/${face}: the stock top stays the diameter`)
        assert(grid.stockBottomZ === 0, 'the empty value is the stock bottom')

        let material = 0
        let empty = 0
        for (let row = 0; row < grid.rows; row += 1) {
          for (let col = 0; col < grid.cols; col += 1) {
            const index = row * grid.cols + col
            const distance = acrossDistance(fixture, grid, col, row)
            const expected = analyticTop(fixture, distance)
            approx(grid.topZ[index], expected, `${axis}/${units}/${face}: cell (${col},${row})`)
            assert(
              grid.initialTopZ[index] === grid.topZ[index],
              `${axis}/${units}/${face}: the baseline equals the seeded cell (${col},${row})`,
            )
            if (Math.abs(distance) >= diameter / 2) empty += 1
            else material += 1
          }
        }
        assert(material > 0, `${axis}/${units}/${face}: the grid has material cells`)
        assert(empty > 0, `${axis}/${units}/${face}: the grid has empty cells outside the bar`)

        // The section is constant along the bar: a full row for an X bar, a
        // full column for a Y bar.
        if (axis === 'x') {
          for (let row = 0; row < grid.rows; row += 1) {
            const first = grid.topZ[row * grid.cols]
            for (let col = 1; col < grid.cols; col += 1) {
              assert(grid.topZ[row * grid.cols + col] === first, `${axis}/${units}/${face}: row ${row} is constant along X`)
            }
          }
        } else {
          for (let col = 0; col < grid.cols; col += 1) {
            const first = grid.topZ[col]
            for (let row = 1; row < grid.rows; row += 1) {
              assert(grid.topZ[row * grid.cols + col] === first, `${axis}/${units}/${face}: column ${col} is constant along Y`)
            }
          }
        }

        // Bottom is the same profile as Top: the bar is symmetric about its
        // axis, and the setup turn is already in the setup-local stock.
        if (reference) assert.deepEqual(grid.topZ, reference.topZ, `${axis}/${units}: Bottom seeds the same profile as Top`)
        else reference = grid
        combos += 1
      }
    }
  }
  console.log(`flat round-bar profile: PASSED (${combos} axis/units/face combinations)`)
}

// ---------------------------------------------------------------------------
// 2. Block, square blank and the Around sheet keep the base output.
// ---------------------------------------------------------------------------

function assertNoDescriptorOnBaseStock(): void {
  console.log('Testing a block, a square blank and the unrolled sheet keep their exact grids...')
  // Block.
  const block = newProject('block', 'mm')
  block.setups = [faceSetup('top'), faceSetup('bottom')]
  block.activeSetupId = faceSetup('top').id
  for (const face of ['top', 'bottom'] as const) {
    const setup = block.setups.find((entry) => entry.id === faceSetup(face).id)!
    const input = buildSimulationSetupInput(block, setup, new Map())
    assert(input, `block/${face}: yields an input`)
    assert(input.flatRoundBar === undefined, `block/${face}: no flat round-bar descriptor`)
    const options = simulationBuildOptions(input, DETAIL)
    assert(!('flatRoundBar' in options), `block/${face}: the options carry no flat round-bar key`)
    const grid = createSimulationGrid(input.project, options)
    const base = createSimulationGrid(block, { targetLongAxisCells: DETAIL })
    assert.deepEqual(grid.topZ, base.topZ, `block/${face}: the grid is byte-identical to the base output`)
    assert(!('initialTopZ' in grid), `block/${face}: a block grid gains no baseline`)
  }

  // Square blank: its top face is flat, so a flat setup is a block.
  const square = flatProject(normalizeSquareStock(squareStock(25, 120, 'x', { x: 0, y: 10 })))
  for (const face of ['top', 'bottom'] as const) {
    const setup = square.setups.find((entry) => entry.id === faceSetup(face).id)!
    const input = buildSimulationSetupInput(square, setup, new Map())
    assert(input, `square/${face}: yields an input`)
    assert(input.flatRoundBar === undefined, `square/${face}: no flat round-bar descriptor`)
    const options = simulationBuildOptions(input, DETAIL)
    assert(!('flatRoundBar' in options), `square/${face}: the options carry no flat round-bar key`)
    const grid = createSimulationGrid(input.project, options)
    const base = createSimulationGrid(square, { targetLongAxisCells: DETAIL })
    assert.deepEqual(grid.topZ, base.topZ, `square/${face}: the grid is byte-identical to the base output`)
    assert(!('initialTopZ' in grid), `square/${face}: a square blank on a flat face gains no baseline`)
    for (const height of grid.topZ) assert(height === 25, `square/${face}: every cell starts at the flat top face`)
  }

  // The unrolled sheet is a block, even though the project's stock is a bar.
  const bar = barFixture('x', 40)
  const aroundSetup: MachiningSetup = {
    ...faceSetup('top'),
    id: 'setup-around',
    name: 'Around',
    kind: 'around',
  }
  const aroundProject: Project = { ...bar.project, setups: [aroundSetup], activeSetupId: aroundSetup.id }
  const input = buildSimulationSetupInput(aroundProject, aroundSetup, new Map())
  assert(input, 'around: yields an input')
  assert(input.flatRoundBar === undefined, 'around: the unrolled sheet carries no flat round-bar descriptor')
  assert(input.bar, 'around: the real bar still rides beside the sheet')
  const options = simulationBuildOptions(input, DETAIL)
  assert(options.wrap, 'around: the sheet keeps its periodic wrap')
  const grid = createSimulationGrid(input.project, options)
  assert(!('initialTopZ' in grid), 'around: the unrolled sheet grows no baseline')
  for (const height of grid.topZ) {
    assert(height === input.project.stock.thickness, 'around: every sheet cell starts at the uniform sheet top')
  }
  console.log('block, square blank and unrolled sheet: PASSED')
}

// ---------------------------------------------------------------------------
// 3. A pocket on Top of the bar cuts the curved surface and never fills space.
// ---------------------------------------------------------------------------

function testPocketCutsOnlyReachableMaterial(): void {
  console.log('Testing a pocket on Top of a round bar lowers only the material the cutter reaches...')
  const fixture = barFixture('x', 40)
  const { input, options } = setupSimulation(fixture, 'top')
  const radius = fixture.diameter / 2
  const pivot = radius

  // A flat endmill running along the bar near its far edge, so its footprint
  // reaches across the silhouette into empty space (the grid's round-up leaves
  // at least one cell centre beyond the bar), plus a pass down the centreline
  // to cut the tall part of the curve.
  const toolRadius = 6
  const edgeMove = {
    kind: 'cut' as const,
    from: { x: 60, y: fixture.centre + radius - 4, z: pivot },
    to: { x: 140, y: fixture.centre + radius - 4, z: pivot },
  }
  const centreMove = {
    kind: 'cut' as const,
    from: { x: 60, y: fixture.centre, z: pivot },
    to: { x: 140, y: fixture.centre, z: pivot },
  }
  const moves = [edgeMove, centreMove]

  // A virgin bar is not "mostly removed just because it is round": the seeded
  // baseline is what removal is measured against.
  const virgin = simulateReplayItemsHeightfield(input.project, [], options)
  assert.equal(virgin.stats.removedCellCount, 0, 'a virgin round bar reports nothing removed')
  assert.equal(virgin.stats.maxRemovedDepth, 0, 'a virgin round bar reports no removed depth')

  // The app's own grid and paths: the descriptor reaches the replay exactly as
  // the panel builds it.
  const result = simulateReplayItemsHeightfield(input.project, [{
    operationId: 'flat-pocket',
    operationName: 'flat-pocket',
    toolRef: null,
    toolType: 'flat_endmill',
    toolRadius,
    vBitAngle: null,
    toolpath: { operationId: 'flat-pocket', moves, bounds: null, warnings: [] },
  }], options)
  const baseline = new Float32Array(result.grid.initialTopZ!)

  const distanceToMove = (x: number, y: number, move: typeof edgeMove): number => {
    const dx = move.to.x - move.from.x
    const dy = move.to.y - move.from.y
    const lengthSq = dx * dx + dy * dy
    const t = lengthSq <= 1e-12 ? 0 : Math.max(0, Math.min(1, ((x - move.from.x) * dx + (y - move.from.y) * dy) / lengthSq))
    return Math.hypot(x - (move.from.x + dx * t), y - (move.from.y + dy * t))
  }

  let cutCells = 0
  let emptyCellsUnderFootprint = 0
  let untouchedHighCells = 0
  for (let row = 0; row < result.grid.rows; row += 1) {
    for (let col = 0; col < result.grid.cols; col += 1) {
      const index = row * result.grid.cols + col
      const centre = cellCentre(result.grid, col, row)
      const distance = acrossDistance(fixture, result.grid, col, row)
      const before = baseline[index]
      const after = result.grid.topZ[index]
      assert(after <= before + 1e-9, `cell (${col},${row}) must never be raised (${before} -> ${after})`)

      const inFootprint = moves.some((move) => distanceToMove(centre.x, centre.y, move) <= toolRadius + 1e-9)
      if (Math.abs(distance) >= radius) {
        assert(after === 0, `cell (${col},${row}) outside the bar stays empty, got ${after}`)
        if (inFootprint) emptyCellsUnderFootprint += 1
        continue
      }

      // The cutter's flat bottom is at the pivot, so a reachable cell is cut to
      // exactly that height when its starting surface is above it. The kernel
      // accepts a radius of `toolRadius + 1e-9`; the sliver in between is left
      // unasserted rather than guessed.
      const distanceToCut = Math.min(...moves.map((move) => distanceToMove(centre.x, centre.y, move)))
      if (distanceToCut <= toolRadius - 1e-9) {
        approx(after, Math.min(before, pivot), `cell (${col},${row}) inside the cutter's footprint`)
        if (after < before - 1e-9) cutCells += 1
      } else if (distanceToCut >= toolRadius + 1e-9) {
        assert(after === before, `cell (${col},${row}) beyond the cutter's reach keeps its curved surface`)
        if (before > pivot) untouchedHighCells += 1
      }
    }
  }

  assert(cutCells > 0, 'the pocket removes material from the curved surface')
  assert(untouchedHighCells > 0, 'cells beyond the cutter\'s reach keep the tall part of the curve')
  assert(emptyCellsUnderFootprint > 0, 'fixture: the cutter\'s footprint really covers empty space outside the bar')
  assert(result.stats.removedCellCount === cutCells, `removed cells must match the lowered cells (${cutCells})`)
  assert(result.stats.maxRemovedDepth > 0, 'the deepest cut is reported')
  console.log(`pocket on a round bar: PASSED (${cutCells} cells cut, ${emptyCellsUnderFootprint} empty cells under the footprint)`)
}

// ---------------------------------------------------------------------------
// 4. The descriptor is validated, and the flat profile is not a square or wrap.
// ---------------------------------------------------------------------------

function testDescriptorValidation(): void {
  console.log('Testing the flat round-bar descriptor is validated before seeding...')
  const fixture = barFixture('x', 40)
  const descriptor = { axis: 'x' as const, pivot: 20, radius: 20, centre: fixture.centre }
  assert.throws(
    () => createSimulationGrid(fixture.project, { flatRoundBar: { ...descriptor, radius: 0 } }),
    RangeError,
    'a zero radius is refused',
  )
  assert.throws(
    () => createSimulationGrid(fixture.project, { flatRoundBar: { ...descriptor, centre: Number.NaN } }),
    RangeError,
    'a non-finite centre is refused',
  )
  assert.throws(
    () => createSimulationGrid(fixture.project, { flatRoundBar: { ...descriptor, axis: 'z' as never } }),
    RangeError,
    'an unknown axis is refused',
  )
  assert.throws(
    () => createSimulationGrid(fixture.project, {
      flatRoundBar: descriptor,
      squareBar: { side: 40, frame: { axis: 'x', centre: 0, radius: 20, zero: 0, sheetStart: -20, circumference: Math.PI * 40 } },
    }),
    RangeError,
    'a square descriptor and a flat round bar are mutually exclusive',
  )
  assert.throws(
    () => createSimulationGrid(fixture.project, { flatRoundBar: descriptor, wrap: { axis: 'y', period: 40 } }),
    RangeError,
    'a flat round bar cannot be the wrapped sheet',
  )
  console.log('flat round-bar descriptor validation: PASSED')
}

testSeedMatchesAnalyticProfile()
assertNoDescriptorOnBaseStock()
testPocketCutsOnlyReachableMaterial()
testDescriptorValidation()
