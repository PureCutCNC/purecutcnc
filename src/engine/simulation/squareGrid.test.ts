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
 * Square-blank grid initialization (issue #1016 C2).
 *
 * A square grid seeds the blank's true cross section, keeps an immutable
 * baseline for statistics, and validates its transient initialization
 * descriptor. The descriptor itself never lands on the grid: downstream the
 * square blank is the round bar's radial heightfield. Flat and round grids must
 * keep their exact original keys and values.
 *
 * Run with: npx tsx src/engine/simulation/squareGrid.test.ts
 */

import { createSimulationGrid, resolveSimulationGridSpec, seedSquareTopZ, squareSurfaceRadius } from './grid'
import { simulateReplayItemsHeightfield } from './replay'
import { newProject, rectProfile } from '../../types/project'
import type { Project } from '../../types/project'
import type { AroundFrame } from '../aroundFrame'
import type { SimulationBuildOptions, SimulationGrid } from './types'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(a: number, b: number, epsilon = 1e-9): boolean {
  return Math.abs(a - b) < epsilon
}

const TWO_PI = Math.PI * 2

interface Sheet {
  project: Project
  frame: AroundFrame
  side: number
  xMin: number
  xMax: number
  yMin: number
  yMax: number
}

/**
 * A project whose stock is the unrolled square sheet: along the bar on `axis`,
 * one nominal circumference across, one nominal radius thick. This is what the
 * Around simulation feeds the grid (the unrolled block), with the square
 * descriptor alongside.
 */
function sheetProject(side: number, axis: 'x' | 'y', zero: number, alongLength = 80, alongStart = 0): Sheet {
  const circumference = Math.PI * side
  const radius = side / 2
  const frame: AroundFrame = {
    axis,
    centre: zero,
    radius,
    zero,
    sheetStart: zero - circumference / 2,
    circumference,
  }
  const project = newProject('square', 'mm')
  const xMin = axis === 'x' ? alongStart : zero - circumference / 2
  const xMax = axis === 'x' ? alongStart + alongLength : zero + circumference / 2
  const yMin = axis === 'x' ? zero - circumference / 2 : alongStart
  const yMax = axis === 'x' ? zero + circumference / 2 : alongStart + alongLength
  project.stock = { ...project.stock, profile: rectProfile(xMin, yMin, xMax - xMin, yMax - yMin), thickness: radius }
  return { project, frame, side, xMin, xMax, yMin, yMax }
}

function squareOptions(sheet: Sheet, targetLongAxisCells = 96): SimulationBuildOptions {
  return { squareBar: { side: sheet.side, frame: sheet.frame }, targetLongAxisCells }
}

function testSeedMatchesSquareCrossSection(): void {
  console.log('Testing square grid seeds the true cross section at every across cell...')
  const sheet = sheetProject(20, 'x', 0)
  const grid = createSimulationGrid(sheet.project, squareOptions(sheet))

  assert(!('squareBar' in grid), 'the initialization descriptor must not land on the grid')
  assert(!('squareMaterial' in grid), 'a square grid must not carry the discarded interval model')
  assert(grid.initialTopZ !== undefined, 'a square grid must carry an immutable baseline')
  assert(grid.topZ.length === grid.cols * grid.rows, 'the baseline must cover every cell')
  assert(grid.stockBottomZ === 0, `the square pivot must be the radial zero (got ${grid.stockBottomZ})`)
  const keys = Object.keys(grid).sort()
  const expectedKeys = [
    'cellSize', 'cols', 'initialTopZ', 'originX', 'originY', 'rows', 'stockBottomZ', 'stockTopZ', 'topZ',
  ].sort()
  assert(
    keys.length === expectedKeys.length && keys.every((key, i) => key === expectedKeys[i]),
    `square grid keys drifted: ${keys.join(',')}`,
  )

  for (let row = 0; row < grid.rows; row += 1) {
    for (let col = 0; col < grid.cols; col += 1) {
      const across = sheet.frame.axis === 'x'
        ? grid.originY + (row + 0.5) * grid.cellSize
        : grid.originX + (col + 0.5) * grid.cellSize
      const expected = squareSurfaceRadius(sheet.side, (across - sheet.frame.zero) * TWO_PI / sheet.frame.circumference)
      const value = grid.topZ[row * grid.cols + col]
      assert(approx(value, expected, 1e-5), `cell (${col},${row}) should seed ${expected}, got ${value}`)
      assert(grid.initialTopZ![row * grid.cols + col] === value, 'the baseline must equal the seeded surface')
    }
  }

  // Along the bar the section is constant: every column of a row is equal.
  for (let row = 0; row < grid.rows; row += 1) {
    const first = grid.topZ[row * grid.cols]
    for (let col = 1; col < grid.cols; col += 1) {
      assert(grid.topZ[row * grid.cols + col] === first, 'the square section must not vary along the bar')
    }
  }

  // The flat reaches half the side and the corner reaches side/√2.
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < grid.topZ.length; i += 1) {
    min = Math.min(min, grid.topZ[i])
    max = Math.max(max, grid.topZ[i])
  }
  assert(min >= sheet.side / 2 - 1e-5, `a flat must reach at least half the side, got ${min}`)
  assert(max <= sheet.side * Math.SQRT1_2 + 1e-5, `a corner must not exceed side/√2, got ${max}`)
  assert(max > sheet.side / 2 + grid.cellSize, 'the sampled section must include a real corner rise')
  console.log(`square seed cross section: PASSED (min ${min.toFixed(4)}, max ${max.toFixed(4)})`)
}

function testTopZMutationLeavesBaselineImmutable(): void {
  console.log('Testing lowering topZ never touches the immutable baseline...')
  const sheet = sheetProject(20, 'x', 0)
  const grid = createSimulationGrid(sheet.project, squareOptions(sheet))
  const baseline = new Float32Array(grid.initialTopZ!)
  grid.topZ.fill(0)
  for (let i = 0; i < baseline.length; i += 1) {
    assert(grid.initialTopZ![i] === baseline[i], 'the baseline must be immutable')
  }
  console.log('square baseline immutability: PASSED')
}

function testRenderEnvelopeHoldsCornersButPivotStaysNominal(): void {
  console.log('Testing the render envelope holds the corners while the pivot stays side/2...')
  const sheet = sheetProject(20, 'y', 0)
  const spec = resolveSimulationGridSpec(sheet.project, squareOptions(sheet))
  assert(approx(spec.stockTopZ, sheet.side * Math.SQRT1_2, 1e-9), `square stock top must be side/√2, got ${spec.stockTopZ}`)
  assert(approx(sheet.frame.radius, sheet.side / 2, 1e-12), 'the true pivot stays side/2, never the corner radius')
  assert(approx(sheet.frame.circumference, Math.PI * sheet.side, 1e-12), 'the nominal circumference stays π·side')
  console.log('square render envelope and true pivot: PASSED')
}

function testVirginSquareStatsAreZero(): void {
  console.log('Testing a virgin square grid reports zero removed material against its own baseline...')
  const sheet = sheetProject(20, 'x', 0)
  const result = simulateReplayItemsHeightfield(sheet.project, [], squareOptions(sheet))
  assert(result.stats.removedCellCount === 0, `a virgin square must remove nothing, got ${result.stats.removedCellCount}`)
  assert(result.stats.maxRemovedDepth === 0, `a virgin square must have zero depth, got ${result.stats.maxRemovedDepth}`)
  let minBaseline = Infinity
  for (let i = 0; i < result.grid.initialTopZ!.length; i += 1) minBaseline = Math.min(minBaseline, result.grid.initialTopZ![i])
  assert(approx(result.stats.minTopZ, minBaseline, 1e-5), `minTopZ must be the lowest cell baseline ${minBaseline}, got ${result.stats.minTopZ}`)
  assert(result.stats.minTopZ < result.grid.stockTopZ - 1e-3, 'the corner rise must not be mistaken for the whole surface')
  console.log('virgin square stats: PASSED')
}

function testOldGridsKeepExactKeysAndValues(): void {
  console.log('Testing flat and round grids keep their exact original keys and values...')
  const project = newProject('flat', 'mm')
  const topZ = project.stock.thickness
  const flat = createSimulationGrid(project, { targetLongAxisCells: 48 })
  assert(!('squareBar' in flat), 'a flat grid must not grow a squareBar key')
  assert(!('initialTopZ' in flat), 'a flat grid must not grow an initialTopZ key')
  assert(flat.stockTopZ === topZ, `flat stock top must stay thickness ${topZ}, got ${flat.stockTopZ}`)
  const keys = Object.keys(flat).sort()
  const expected = ['cellSize', 'cols', 'originX', 'originY', 'rows', 'stockBottomZ', 'stockTopZ', 'topZ'].sort()
  assert(keys.length === expected.length && keys.every((key, i) => key === expected[i]), `flat grid keys drifted: ${keys.join(',')}`)

  const wrap = { axis: 'y' as const, period: Math.PI * project.stock.thickness }
  const wrapped = createSimulationGrid(project, { targetLongAxisCells: 48, wrap })
  assert(!('squareBar' in wrapped) && !('initialTopZ' in wrapped), 'a wrapped round grid must keep its original keys')
  const wrappedKeys = Object.keys(wrapped).sort()
  const expectedWrapped = [...expected, 'wrap'].sort()
  assert(
    wrappedKeys.length === expectedWrapped.length && wrappedKeys.every((key, i) => key === expectedWrapped[i]),
    `wrapped grid keys drifted: ${wrappedKeys.join(',')}`,
  )
  console.log('old grid keys and values: PASSED')
}

function testDescriptorValidation(): void {
  console.log('Testing initialization validation rejects a bad side or a mismatched frame...')
  const sheet = sheetProject(20, 'x', 0)
  const base = squareOptions(sheet)
  const expectThrow = (options: SimulationBuildOptions, label: string): void => {
    let threw = false
    try {
      createSimulationGrid(sheet.project, options)
    } catch (error) {
      threw = error instanceof RangeError
    }
    assert(threw, `${label} must throw a RangeError`)
  }
  for (const side of [0, -1, NaN, Infinity]) {
    expectThrow({ ...base, squareBar: { side, frame: sheet.frame } }, `side ${side}`)
  }
  expectThrow(
    { ...base, squareBar: { side: 20, frame: { ...sheet.frame, radius: 20 } } },
    'a frame radius at the corner radius',
  )
  expectThrow(
    { ...base, squareBar: { side: 20, frame: { ...sheet.frame, circumference: 20 } } },
    'a frame circumference that is not π·side',
  )
  expectThrow(
    { ...base, squareBar: { side: 20, frame: { ...sheet.frame, zero: NaN } } },
    'a non-finite zero line',
  )
  // A valid descriptor must not throw.
  let ok: SimulationGrid | null = null
  try {
    ok = createSimulationGrid(sheet.project, base)
  } catch {
    ok = null
  }
  assert(ok !== null, 'a matching square descriptor must be accepted')
  console.log('square initialization validation: PASSED')
}

/**
 * The square seed writes one native row fill per row for an X bar (issue #1112
 * rt2-e). That is a pure replacement of the per-cell write, so it must land on
 * the same value in every cell — byte for byte, not within a tolerance. The
 * reference here is the per-cell loop itself, run over the same spec, including
 * a non-square grid (cols ≠ rows) and a non-integer cell size, because a fill
 * range that is off by one row or one column is exactly the bug this replaces.
 */
function testSeedRowsMatchPerCellReference(): void {
  console.log('Testing the square row fill is byte-identical to the per-cell seed...')
  for (const axis of ['x', 'y'] as const) {
    for (const targetLongAxisCells of [24, 60, 97]) {
      const sheet = sheetProject(20, axis, 3)
      const spec = resolveSimulationGridSpec(sheet.project, squareOptions(sheet, targetLongAxisCells))
      const squareBar = { side: sheet.side, frame: sheet.frame }
      const filled = new Float32Array(spec.cols * spec.rows)
      const reference = new Float32Array(spec.cols * spec.rows)
      seedSquareTopZ(filled, spec, squareBar)
      // The pre-#1112-rt2-e seed, kept as the reference: every cell written from
      // its own across height.
      const anglePerAcross = (2 * Math.PI) / squareBar.frame.circumference
      const acrossOrigin = squareBar.frame.axis === 'x' ? spec.originY : spec.originX
      const acrossCount = squareBar.frame.axis === 'x' ? spec.rows : spec.cols
      const acrossHeights = new Float32Array(acrossCount)
      for (let across = 0; across < acrossCount; across += 1) {
        const coordinate = acrossOrigin + (across + 0.5) * spec.cellSize
        acrossHeights[across] = squareSurfaceRadius(squareBar.side, (coordinate - squareBar.frame.zero) * anglePerAcross)
      }
      for (let row = 0; row < spec.rows; row += 1) {
        for (let col = 0; col < spec.cols; col += 1) {
          reference[row * spec.cols + col] = acrossHeights[squareBar.frame.axis === 'x' ? row : col]
        }
      }
      assert(filled.length === reference.length, `${axis}/${targetLongAxisCells}: the seed covers every cell`)
      for (let i = 0; i < reference.length; i += 1) {
        assert(
          Object.is(filled[i], reference[i]),
          `${axis}/${targetLongAxisCells}: cell ${i} must be ${reference[i]}, got ${filled[i]}`,
        )
      }
    }
  }
  console.log('square row-fill seed: PASSED')
}

try {
  testSeedMatchesSquareCrossSection()
  testSeedRowsMatchPerCellReference()
  testTopZMutationLeavesBaselineImmutable()
  testRenderEnvelopeHoldsCornersButPivotStaysNominal()
  testVirginSquareStatsAreZero()
  testOldGridsKeepExactKeysAndValues()
  testDescriptorValidation()
  console.log('\nAll square grid tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
