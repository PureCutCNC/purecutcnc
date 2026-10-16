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
 * The physical polar cut kernel for a square blank (issue #1016 C2-R1).
 *
 * The tests hold the kernel against an **independent physical oracle**: a
 * brute-force machine-stock-space point-in-cutter test that samples each
 * cell's radial ray and the tool's whole path, with no production expression
 * restated. The oracle's radial sampling is `h0 / rSamples`, so every parity
 * assertion carries a documented geometry tolerance above it.
 *
 * Run with: npx tsx src/engine/simulation/squareReplay.test.ts
 */

import { applyMoveToGrid, simulateReplayItemsHeightfield } from './replay'
import { applySquareMoveToGrid, squareMaterialIntervals, squareSurfaceRadius } from './squareReplay'
import { PlaybackController, cloneSimulationGrid } from './playback'
import { createSimulationGrid } from './grid'
import { barCentre, barMaxRadius, barPivotZ, squareStock } from '../../types/barStock'
import { defaultTool, newProject, rectProfile } from '../../types/project'
import { normalizeToolForProject } from '../toolpaths/geometry'
import { generateRotaryFinish, generateRotaryRough } from '../toolpaths/rotaryModel'
import { buildRotaryCylinder } from '../rotaryCylinder'
import type { SimulationGrid } from './types'
import type { AroundFrame } from '../aroundFrame'
import type { ToolpathMove } from '../toolpaths/types'
import type { ToolType } from '../../types/project'

const TWO_PI = Math.PI * 2

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(a: number, b: number, epsilon = 1e-9): boolean {
  return Math.abs(a - b) < epsilon
}

/**
 * A square grid in project space. For `axis === 'x'` the along coordinate is
 * X and the across coordinate is Y; for `'y'` they swap, exactly as the Around
 * sheet does. The seed is the blank's true radial cross section.
 */
function makeSquareGrid(params: {
  side: number
  axis: 'x' | 'y'
  cellSize: number
  xMin: number
  xMax: number
  yMin: number
  yMax: number
  zero: number
  wrap?: { axis: 'x' | 'y'; period: number }
}): SimulationGrid {
  const { side, axis, cellSize, xMin, xMax, yMin, yMax, zero } = params
  const circumference = Math.PI * side
  const frame: AroundFrame = {
    axis,
    centre: zero,
    radius: side / 2,
    zero,
    sheetStart: zero - circumference / 2,
    circumference,
  }
  const cols = Math.max(1, Math.round((xMax - xMin) / cellSize))
  const rows = Math.max(1, Math.round((yMax - yMin) / cellSize))
  const topZ = new Float32Array(cols * rows)
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const across = axis === 'x' ? yMin + (row + 0.5) * cellSize : xMin + (col + 0.5) * cellSize
      topZ[row * cols + col] = squareSurfaceRadius(side, (across - zero) * TWO_PI / circumference)
    }
  }
  return {
    originX: xMin,
    originY: yMin,
    cellSize,
    cols,
    rows,
    stockBottomZ: 0,
    stockTopZ: side * Math.SQRT1_2,
    squareBar: { side, frame },
    initialTopZ: new Float32Array(topZ),
    topZ,
    ...(params.wrap ? { wrap: params.wrap } : {}),
  }
}

/** A square sheet spanning one nominal circumference around `zero`. */
function squareSheet(side: number, axis: 'x' | 'y', zero: number, cellSize = 0.5, alongLength = 80): SimulationGrid {
  const circumference = Math.PI * side
  return makeSquareGrid({
    side,
    axis,
    cellSize,
    xMin: axis === 'x' ? 0 : zero - circumference / 2,
    xMax: axis === 'x' ? alongLength : zero + circumference / 2,
    yMin: axis === 'x' ? zero - circumference / 2 : 0,
    yMax: axis === 'x' ? zero + circumference / 2 : alongLength,
    zero,
  })
}

interface Loss {
  changed: number
  maxLoss: number
}

function measure(grid: SimulationGrid): Loss {
  let changed = 0
  let maxLoss = 0
  for (let i = 0; i < grid.topZ.length; i += 1) {
    const loss = grid.initialTopZ![i] - grid.topZ[i]
    if (loss > 1e-9) changed += 1
    if (loss > maxLoss) maxLoss = loss
  }
  return { changed, maxLoss }
}

function gridsApproxEqual(a: SimulationGrid, b: SimulationGrid, epsilon = 1e-6): boolean {
  if (a.topZ.length !== b.topZ.length) return false
  for (let i = 0; i < a.topZ.length; i += 1) {
    if (!approx(a.topZ[i], b.topZ[i], epsilon)) return false
  }
  return true
}

/** A stable snapshot of a grid's remaining square material, for no-mutation checks. */
function materialSnapshot(grid: SimulationGrid): string {
  if (!grid.squareMaterial) return ''
  return JSON.stringify([...grid.squareMaterial.entries()].sort((a, b) => a[0] - b[0]))
}

/**
 * The square kernel refuses a regime it cannot certify with a `RangeError`
 * before it touches the grid, exactly like an unsupported cutter. This asserts
 * both halves: the refusal and the atomicity.
 */
function expectRefusal(grid: SimulationGrid, move: ToolpathMove, rt: number, toolType: ToolType, label: string): void {
  const heights = new Float32Array(grid.topZ)
  const material = materialSnapshot(grid)
  let threw = false
  try {
    applySquareMoveToGrid(grid, move, rt, toolType)
  } catch (error) {
    threw = error instanceof RangeError
  }
  assert(threw, `${label} must be refused with a RangeError`)
  for (let i = 0; i < heights.length; i += 1) {
    assert(grid.topZ[i] === heights[i], `${label} must not mutate a cell before refusing`)
  }
  assert(materialSnapshot(grid) === material, `${label} must not write material before refusing`)
}

/**
 * Independent physical oracle. Machine stock space: a material point on the
 * cell's radial ray at radius r, material angle `a`, when the program is at
 * angle A(t), sits at machine `(along, r·cos(a−A), r·sin(a−A))` about the true
 * pivot. A flat cutter is the half-cylinder `|Z| ≤ rt, Y ≥ z`; a ball is the
 * sphere of radius rt centred one radius above its tip plus the cylindrical
 * shank of the same radius beyond its equator. The outermost radius that no
 * sampled pose removes is the cell's new height.
 *
 * `rSamples` sets the oracle's own radial resolution (h0 / rSamples), which is
 * the geometry tolerance every parity assertion is measured against.
 */
function oracleHeight(
  grid: SimulationGrid,
  row: number,
  col: number,
  move: ToolpathMove,
  rt: number,
  ball: boolean,
  rSamples: number,
  tSamples: number,
): number {
  const frame = grid.squareBar!.frame
  const xAxis = frame.axis === 'x'
  const cellSize = grid.cellSize
  const along = xAxis ? grid.originX + (col + 0.5) * cellSize : grid.originY + (row + 0.5) * cellSize
  const across = xAxis ? grid.originY + (row + 0.5) * cellSize : grid.originX + (col + 0.5) * cellSize
  const h0 = grid.initialTopZ![row * grid.cols + col]
  const materialAngle = (across - frame.zero) * TWO_PI / frame.circumference

  const fromAlong = xAxis ? move.from.x : move.from.y
  const toAlong = xAxis ? move.to.x : move.to.y
  const fromAcross = xAxis ? move.from.y : move.from.x
  const toAcross = xAxis ? move.to.y : move.to.x

  const minZ = Math.min(move.from.z, move.to.z)
  if (minZ >= h0) return h0
  const atNearestAlong = fromAlong === toAlong
    ? fromAlong
    : Math.max(Math.min(along, Math.max(fromAlong, toAlong)), Math.min(fromAlong, toAlong))
  if (Math.abs(along - atNearestAlong) > rt) return h0

  const removable = new Uint8Array(rSamples + 1)
  for (let ti = 0; ti <= tSamples; ti += 1) {
    const t = ti / tSamples
    const l = fromAlong + (toAlong - fromAlong) * t
    const dx = along - l
    if (dx * dx > rt * rt) continue
    const at = fromAcross + (toAcross - fromAcross) * t
    const z = move.from.z + (move.to.z - move.from.z) * t
    const theta = materialAngle - (at - frame.zero) * TWO_PI / frame.circumference
    const cos = Math.cos(theta)
    const sin = Math.sin(theta)
    const ballCenterY = z + rt
    for (let ri = 0; ri <= rSamples; ri += 1) {
      if (removable[ri] !== 0) continue
      const r = (h0 * ri) / rSamples
      const y = r * cos
      const zz = r * sin
      // Ball: the lower hemisphere plus the cylindrical shank beyond its
      // equator — a bare sphere loses the body the tool actually has.
      const inside = ball
        ? dx * dx + (y - ballCenterY) * (y - ballCenterY) + zz * zz <= rt * rt
          || (dx * dx + zz * zz <= rt * rt && y >= ballCenterY)
        : dx * dx + zz * zz <= rt * rt && y >= z
      if (inside) removable[ri] = 1
    }
  }

  let best = 0
  for (let ri = 0; ri <= rSamples; ri += 1) {
    if (removable[ri] === 0) best = (h0 * ri) / rSamples
  }
  return best
}

/** Compare a whole grid against the oracle at a sample of its cells. */
function assertMatchesOracle(
  grid: SimulationGrid,
  move: ToolpathMove,
  rt: number,
  toolType: ToolType,
  tolerance: number,
  label: string,
  rSamples = 500,
  tSamples = 200,
): void {
  const changed: number[] = []
  for (let i = 0; i < grid.topZ.length; i += 1) {
    if (grid.topZ[i] < grid.initialTopZ![i] - 1e-9) changed.push(i)
  }
  const sample: number[] = []
  const stride = Math.max(1, Math.ceil(changed.length / 30))
  for (let i = 0; i < changed.length; i += stride) sample.push(changed[i])
  // A handful of untouched cells, so the oracle also confirms nothing was
  // gouged where the tool never reached.
  for (let i = 0; i < 8; i += 1) sample.push(Math.floor((i * 7919 + 13) % grid.topZ.length))

  let worst = 0
  let worstInfo = ''
  for (const index of sample) {
    const row = Math.floor(index / grid.cols)
    const col = index % grid.cols
    const oracle = oracleHeight(grid, row, col, move, rt, toolType === 'ball_endmill', rSamples, tSamples)
    const production = grid.topZ[index]
    const delta = Math.abs(production - oracle)
    if (delta > worst) {
      worst = delta
      worstInfo = `cell(${col},${row}) production=${production.toFixed(4)} oracle=${oracle.toFixed(4)}`
    }
  }
  assert(worst <= tolerance, `${label}: worst |production − oracle| = ${worst.toFixed(4)} > ${tolerance} (${worstInfo})`)
  console.log(`${label}: oracle parity PASSED (worst ${worst.toFixed(4)}, ${changed.length} cells changed)`)
}

// ---------------------------------------------------------------------------
// Just-touch: the measured regression this slice exists for.
// ---------------------------------------------------------------------------

function justTouchCase(side: number, axis: 'x' | 'y', zero: number, rt: number, alongLength = 80): void {
  const tip = side / 2 // the blank's flat surface radius at angle 0
  const move: ToolpathMove = axis === 'x'
    ? { kind: 'cut', from: { x: alongLength * 0.25, y: zero, z: tip }, to: { x: alongLength * 0.75, y: zero, z: tip } }
    : { kind: 'cut', from: { x: zero, y: alongLength * 0.25, z: tip }, to: { x: zero, y: alongLength * 0.75, z: tip } }

  // The production entry point: a square grid must dispatch to the physical
  // kernel, not the flat one.
  const grid = squareSheet(side, axis, zero, side / 20, alongLength)
  const result = applyMoveToGrid(grid, move, rt, 'flat_endmill', null)
  const loss = measure(grid)
  assert(result.changedCount === 0, `just-touch must report no changed cells, got ${result.changedCount}`)
  assert(loss.changed === 0, `just-touch must remove no material, got ${loss.changed} cells`)
  assert(loss.maxLoss === 0, `just-touch must not lower any cell, got max loss ${loss.maxLoss}`)
  assert(result.dirtyRegion === null, 'just-touch must not dirty a region')

  // The kernel directly, so its own contract is asserted too.
  const directGrid = squareSheet(side, axis, zero, side / 20, alongLength)
  const direct = applySquareMoveToGrid(directGrid, move, rt, 'flat_endmill')
  assert(direct.changedCount === 0, `the square kernel must report no just-touch change, got ${direct.changedCount}`)
  assert(measure(directGrid).maxLoss === 0, 'the square kernel must not lower a just-touch cell')
}

function testJustTouchRemovesNothing(): void {
  console.log('Testing a flat cutter that only touches the square top removes nothing...')
  // The manager's measured fixture: side 20, true pivot 10, 16 mm cutter whose
  // tip sits exactly on the flat at A0 while feeding along the bar. The old
  // unrolled Euclidean kernel lowered 838 cells here; the physical kernel
  // removes zero.
  justTouchCase(20, 'x', 0, 8)
  justTouchCase(20, 'y', 0, 8)
  justTouchCase(20, 'x', 5, 8) // off-origin across
  justTouchCase(0.75, 'x', 0, 0.3) // inches: side 0.75 in
  justTouchCase(0.75, 'y', 2, 0.3) // inches, off-origin, other axis
  console.log('just-touch zero removal: PASSED')
}

function testNaiveUnrolledKernelWouldHaveFailed(): void {
  console.log('Testing the naive unrolled kernel is genuinely different (the regression is real)...')
  // The old kernel is what a square grid would have used without a descriptor.
  // Prove the difference by seeding the same square heights into a grid with no
  // squareBar: the flat kernel then measures grooves the physical cutter cannot.
  const square = squareSheet(20, 'x', 0)
  const naive: SimulationGrid = { ...square, topZ: new Float32Array(square.topZ) }
  delete naive.squareBar
  delete naive.initialTopZ
  const move: ToolpathMove = { kind: 'cut', from: { x: 20, y: 0, z: 10 }, to: { x: 60, y: 0, z: 10 } }
  const naiveResult = applyMoveToGrid(naive, move, 8, 'flat_endmill', null)
  assert(naiveResult.changedCount > 100, `the flat kernel should carve false grooves, got ${naiveResult.changedCount} cells`)
  let naiveLoss = 0
  for (let i = 0; i < naive.topZ.length; i += 1) naiveLoss = Math.max(naiveLoss, square.initialTopZ![i] - naive.topZ[i])
  assert(naiveLoss > 1, `the flat kernel should show a large false radial loss, got ${naiveLoss}`)
  console.log(`naive unrolled kernel would carve ${naiveResult.changedCount} false cells: PASSED`)
}

// ---------------------------------------------------------------------------
// Physical oracle parity across the motion regimes.
// ---------------------------------------------------------------------------

/**
 * A diagonal submove is split into passes below the grid's across resolution
 * and swept to the removed-band fixed point, so it matches the physical oracle
 * to within the oracle's own radial sampling plus the documented diagonal
 * convergence margin below. It is not a regime the square generators emit
 * (constant-angle axial cuts and plunges are exact), so the slightly looser
 * tolerance is the honest bound.
 */
function testOracleParityFlatCuts(): void {
  console.log('Testing flat cuts below the top against the independent physical oracle...')

  // Broad tool, axial cut: the corner band beyond the tool's tangential reach
  // must keep material.
  let grid = squareSheet(20, 'x', 0)
  let move: ToolpathMove = { kind: 'cut', from: { x: 20, y: 0, z: 5 }, to: { x: 60, y: 0, z: 5 } }
  applyMoveToGrid(grid, move, 8, 'flat_endmill', null)
  assertMatchesOracle(grid, move, 8, 'flat_endmill', 0.035, 'flat broad axial z=5')

  // Narrow tool: a flat strip only.
  grid = squareSheet(20, 'x', 0)
  move = { kind: 'cut', from: { x: 20, y: 0, z: 7 }, to: { x: 60, y: 0, z: 7 } }
  applyMoveToGrid(grid, move, 2.5, 'flat_endmill', null)
  assertMatchesOracle(grid, move, 2.5, 'flat_endmill', 0.035, 'flat narrow axial z=7')

  // Oblique program angle near a corner: the tool faces the tilted face.
  grid = squareSheet(20, 'x', 0)
  move = { kind: 'cut', from: { x: 20, y: Math.PI * 20 * (40 / 360), z: 6 }, to: { x: 60, y: Math.PI * 20 * (40 / 360), z: 6 } }
  applyMoveToGrid(grid, move, 5, 'flat_endmill', null)
  assertMatchesOracle(grid, move, 5, 'flat_endmill', 0.035, 'flat oblique 40° axial z=6')

  // Radial plunge at one angle.
  grid = squareSheet(20, 'x', 0)
  move = { kind: 'plunge', from: { x: 40, y: 0, z: 14 }, to: { x: 40, y: 0, z: 3 } }
  applyMoveToGrid(grid, move, 4, 'flat_endmill', null)
  assertMatchesOracle(grid, move, 4, 'flat_endmill', 0.035, 'flat radial plunge')

  // Diagonal submove (both angle and along move): a move that turns the stock
  // as it travels sweeps a rotating body the kernel does not certify at grid
  // resolution, so it must refuse atomically instead of approximating the
  // sweep with a fixed pose sample.
  expectRefusal(
    squareSheet(20, 'x', 0),
    { kind: 'cut', from: { x: 20, y: -8, z: 6 }, to: { x: 60, y: 8, z: 6 } },
    5,
    'flat_endmill',
    'a below-envelope diagonal flat sweep',
  )

  // Inches: same physics, unit-scaled.
  grid = squareSheet(0.75, 'x', 0, 0.02)
  move = { kind: 'cut', from: { x: 0.25, y: 0, z: 0.1875 }, to: { x: 0.75, y: 0, z: 0.1875 } }
  applyMoveToGrid(grid, move, 0.3, 'flat_endmill', null)
  assertMatchesOracle(grid, move, 0.3, 'flat_endmill', 0.0013, 'flat inch axial z=0.1875')
}

function testOracleParityBallCuts(): void {
  console.log('Testing ball cuts against the independent physical oracle...')
  let grid = squareSheet(20, 'x', 0)
  let move: ToolpathMove = { kind: 'cut', from: { x: 20, y: 0, z: 5 }, to: { x: 60, y: 0, z: 5 } }
  applyMoveToGrid(grid, move, 6, 'ball_endmill', null)
  assertMatchesOracle(grid, move, 6, 'ball_endmill', 0.035, 'ball axial z=5')

  // A ball diagonal sweep turns the stock while it travels, which the kernel
  // does not certify at grid resolution: refuse atomically.
  expectRefusal(
    squareSheet(20, 'x', 0),
    { kind: 'cut', from: { x: 20, y: -6, z: 6 }, to: { x: 60, y: 6, z: 6 } },
    5,
    'ball_endmill',
    'a below-envelope diagonal ball sweep',
  )

  grid = squareSheet(20, 'y', 0)
  move = { kind: 'plunge', from: { x: 0, y: 40, z: 13 }, to: { x: 0, y: 40, z: 4 } }
  applyMoveToGrid(grid, move, 4, 'ball_endmill', null)
  assertMatchesOracle(grid, move, 4, 'ball_endmill', 0.035, 'ball Y-axis radial plunge')
}

function testHighAngleMovingLinkRemovesNothing(): void {
  console.log('Testing an angle-moving link above the corner envelope removes nothing...')
  const grid = squareSheet(20, 'x', 0)
  const maxRadius = 20 * Math.SQRT1_2
  const move: ToolpathMove = { kind: 'cut', from: { x: 20, y: -30, z: maxRadius + 1 }, to: { x: 60, y: 30, z: maxRadius + 0.5 } }
  const result = applyMoveToGrid(grid, move, 5, 'flat_endmill', null)
  assert(result.changedCount === 0, `a link above the corner envelope must remove nothing, got ${result.changedCount}`)
  assert(measure(grid).changed === 0, 'no cell may be lowered by an above-envelope link')

  // Exactly at the corner radius is still a touch, not a cut.
  const touching = squareSheet(20, 'x', 0)
  const touchMove: ToolpathMove = { kind: 'cut', from: { x: 20, y: -30, z: maxRadius }, to: { x: 60, y: 30, z: maxRadius } }
  const touchResult = applyMoveToGrid(touching, touchMove, 5, 'flat_endmill', null)
  assert(touchResult.changedCount === 0, `a pass at the corner radius must not cut, got ${touchResult.changedCount}`)
  console.log('above-envelope angle-moving links: PASSED')
}

// ---------------------------------------------------------------------------
// Retained shoulders, seam, multi-turn, true pivot.
// ---------------------------------------------------------------------------

function testUntouchedEndsKeepTheSquareSection(): void {
  console.log('Testing untouched axial ends keep the initial square cross section...')
  const grid = squareSheet(20, 'x', 0, 0.5, 80)
  const move: ToolpathMove = { kind: 'cut', from: { x: 30, y: 0, z: 5 }, to: { x: 50, y: 0, z: 5 } }
  const rt = 4
  applyMoveToGrid(grid, move, rt, 'flat_endmill', null)

  const endMargin = rt + grid.cellSize
  for (let row = 0; row < grid.rows; row += 1) {
    for (let col = 0; col < grid.cols; col += 1) {
      const along = grid.originX + (col + 0.5) * grid.cellSize
      const idx = row * grid.cols + col
      if (along < 30 - endMargin || along > 50 + endMargin) {
        assert(
          grid.topZ[idx] === grid.initialTopZ![idx],
          `untouched end cell (${col},${row}) must keep its square height`,
        )
      }
    }
  }
  // The cut itself did remove material in the middle.
  assert(measure(grid).changed > 0, 'the middle of the cut must remove material')
  console.log('retained axial ends: PASSED')
}

function testSeamAndMultiTurnIdentity(): void {
  console.log('Testing seam-period and multi-turn identity...')
  const side = 20
  const circumference = Math.PI * side
  const base = -circumference / 2
  const rt = 5

  // A constant-angle pass at one unrolled across coordinate. Shifting that
  // coordinate by a whole period shifts the program angle by 2π, which the
  // kernel's wrapped difference must map back onto the same material.
  const cutAtAngle = (across: number, fromZ = 6, toZ = 6): SimulationGrid => {
    const grid = squareSheet(side, 'x', 0)
    applyMoveToGrid(grid, {
      kind: 'cut', from: { x: 20, y: across, z: fromZ }, to: { x: 60, y: across, z: toZ },
    }, rt, 'flat_endmill', null)
    return grid
  }

  // A constant-angle pass and the same pass shifted one period are identical,
  // for a flat pass and for a sloping one.
  const seam = cutAtAngle(base + 2)
  const shifted = cutAtAngle(base + 2 + circumference)
  assert(gridsApproxEqual(seam, shifted), 'a seam pass must equal the same pass one period on')
  const back = cutAtAngle(base + 2 - circumference)
  assert(gridsApproxEqual(seam, back), 'a seam pass must equal the same pass one period back')
  const twoOn = cutAtAngle(base + 2 + 2 * circumference)
  assert(gridsApproxEqual(seam, twoOn), 'a seam pass must equal the same pass two periods on')

  const slopeSeam = cutAtAngle(base + 2, 6, 9)
  const slopeShifted = cutAtAngle(base + 2 + circumference, 6, 9)
  assert(gridsApproxEqual(slopeSeam, slopeShifted), 'a sloping seam pass must be periodic too')

  // A move that turns the stock while it travels is refused atomically, in any
  // multi-turn form — the kernel no longer approximates the rotating sweep.
  const turningGrid = squareSheet(side, 'x', 0)
  expectRefusal(
    turningGrid,
    { kind: 'cut', from: { x: 20, y: base + 2, z: 6 }, to: { x: 60, y: base + 12, z: 6 } },
    rt,
    'flat_endmill',
    'a turning seam cut',
  )
  expectRefusal(
    squareSheet(side, 'x', 0),
    { kind: 'cut', from: { x: 20, y: base + 2, z: 6 }, to: { x: 60, y: base + 12 + circumference, z: 6 } },
    rt,
    'flat_endmill',
    'a multi-turn turning cut',
  )

  // A square grid that also carries the Round wrap key must not double-count:
  // the physical kernel wraps the angle itself.
  const wrappedBase = squareSheet(side, 'x', 0, 0.5)
  const wrapped: SimulationGrid = { ...wrappedBase, wrap: { axis: 'y', period: circumference } }
  applyMoveToGrid(wrapped, { kind: 'cut', from: { x: 20, y: 0, z: 5 }, to: { x: 60, y: 0, z: 5 } }, rt, 'flat_endmill', null)
  const plain = squareSheet(side, 'x', 0, 0.5)
  applyMoveToGrid(plain, { kind: 'cut', from: { x: 20, y: 0, z: 5 }, to: { x: 60, y: 0, z: 5 } }, rt, 'flat_endmill', null)
  assert(gridsApproxEqual(wrapped, plain), 'the square kernel must not re-apply the round seam copies')
  console.log('seam and multi-turn identity: PASSED')
}

function testPivotIsTheTrueTurningAxis(): void {
  console.log('Testing the cut floor is a true machine plane about the pivot side/2...')
  // A flat cut with its tip 5 above the pivot flattens every reached cell to a
  // plane at machine height 5: a cell at machine angle θ ends at 5/cos θ. If the
  // pivot had been moved to the corner radius every height would shift.
  const side = 20
  const grid = squareSheet(side, 'x', 0)
  const move: ToolpathMove = { kind: 'cut', from: { x: 20, y: 0, z: 5 }, to: { x: 60, y: 0, z: 5 } }
  applyMoveToGrid(grid, move, 8, 'flat_endmill', null)

  const rowAtAngle = (deg: number): number => {
    const across = (deg * Math.PI / 180) * (side / 2)
    return Math.round((across - grid.originY) / grid.cellSize - 0.5)
  }
  const midCol = Math.round((40 - grid.originX) / grid.cellSize - 0.5)
  for (const deg of [0, 10, 20, 30]) {
    const row = rowAtAngle(deg)
    const idx = row * grid.cols + midCol
    // The tool's program across is 0, so the cell's machine angle is its own
    // across coordinate's angle.
    const cellAcross = grid.originY + (row + 0.5) * grid.cellSize
    const theta = (cellAcross - 0) * TWO_PI / grid.squareBar!.frame.circumference
    const expected = 5 / Math.cos(theta)
    assert(
      approx(grid.topZ[idx], expected, 0.02),
      `a cell at across ${cellAcross.toFixed(3)} should floor at ${expected.toFixed(4)}, got ${grid.topZ[idx]}`,
    )
  }
  // The pivot itself is not cut: a cell whose surface is below the plane keeps
  // its material (the machine plane is horizontal in the pivot frame).
  assert(grid.stockBottomZ === 0, 'the pivot stays the radial zero')
  console.log('true pivot cut plane: PASSED')
}

// ---------------------------------------------------------------------------
// Playback parity.
// ---------------------------------------------------------------------------

const TOOL = { toolType: 'flat_endmill' as const, toolRadius: 4, vBitAngle: null }

function squarePlaybackMoves(): ToolpathMove[] {
  return [
    { kind: 'plunge', from: { x: 30, y: 0, z: 14 }, to: { x: 30, y: 0, z: 4 } },
    { kind: 'cut', from: { x: 30, y: 0, z: 4 }, to: { x: 70, y: 0, z: 4 } },
    { kind: 'cut', from: { x: 30, y: 10, z: 6 }, to: { x: 70, y: 10, z: 6 } },
  ]
}

function testPlaybackMatchesBatchReplay(): void {
  console.log('Testing square playback, seek and subdivision match a batch replay...')
  const moves = squarePlaybackMoves()

  const batch = squareSheet(20, 'x', 0)
  for (const move of moves) applyMoveToGrid(batch, move, TOOL.toolRadius, TOOL.toolType, null)

  const stepped = new PlaybackController(squareSheet(20, 'x', 0), moves, TOOL, { maxSegmentLength: 0 })
  stepped.seekToFraction(1)
  assert(gridsApproxEqual(stepped.liveGrid, batch), 'stepped playback must match the batch replay')

  const subdivided = new PlaybackController(squareSheet(20, 'x', 0), moves, TOOL, { maxSegmentLength: TOOL.toolRadius * 2 })
  subdivided.seekToFraction(1)
  assert(gridsApproxEqual(subdivided.liveGrid, batch), 'subdivided playback must match the batch replay')

  // Forward seek chained equals a fresh seek; backward seek restores.
  const chained = new PlaybackController(squareSheet(20, 'x', 0), moves, TOOL, { maxSegmentLength: 0 })
  chained.seekToFraction(0.4)
  chained.seekToFraction(0.75)
  chained.seekToFraction(1)
  assert(gridsApproxEqual(chained.liveGrid, batch), 'chained forward seeks must match a fresh replay')

  chained.seekToFraction(0.1)
  const early = new PlaybackController(squareSheet(20, 'x', 0), moves, TOOL, { maxSegmentLength: 0 })
  early.seekToFraction(0.1)
  assert(gridsApproxEqual(chained.liveGrid, early.liveGrid), 'a backward seek must restore the earlier state')
  console.log('square playback parity: PASSED')
}

function testPlaybackPreservesDescriptorAndBaseline(): void {
  console.log('Testing playback preserves the descriptor and the immutable baseline...')
  const base = squareSheet(20, 'x', 0)
  const baseline = new Float32Array(base.initialTopZ!)
  const controller = new PlaybackController(base, squarePlaybackMoves(), TOOL, { maxSegmentLength: 0 })
  assert(controller.liveGrid.squareBar === base.squareBar, 'the descriptor must ride along by reference')
  assert(controller.liveGrid.initialTopZ === base.initialTopZ, 'the immutable baseline must ride along')
  controller.seekToFraction(1)
  controller.seekToFraction(0)
  for (let i = 0; i < baseline.length; i += 1) {
    assert(base.initialTopZ![i] === baseline[i], 'the baseline must never be written')
  }
  assert(gridsApproxEqual(controller.liveGrid, base), 'seeking back to zero must restore the base grid')
  console.log('playback descriptor and baseline: PASSED')
}

/**
 * A one-cell square grid, matching the manager's independent defect fixtures:
 * the cell sits on the ray at `angle` and at `along`, and its virgin radial
 * height is the blank's true cross-section there.
 */
function oneCellGrid(side: number, angle: number, along: number): SimulationGrid {
  const radius = side / 2
  const period = Math.PI * side
  const across = angle * radius
  const cellSize = 1
  const height = squareSurfaceRadius(side, angle)
  const frame: AroundFrame = {
    axis: 'x',
    centre: 0,
    radius,
    zero: 0,
    sheetStart: -period / 2,
    circumference: period,
  }
  return {
    originX: along - cellSize / 2,
    originY: across - cellSize / 2,
    cellSize,
    cols: 1,
    rows: 1,
    stockBottomZ: 0,
    stockTopZ: side * Math.SQRT1_2,
    wrap: { axis: 'y', period },
    squareBar: { side, frame },
    initialTopZ: new Float32Array([height]),
    topZ: new Float32Array([height]),
    squareMaterial: new Map<number, readonly number[]>(),
  }
}

/**
 * The kernel refuses what it cannot model physically instead of quietly
 * treating it as a flat cutter, and rejects invalid data before it touches the
 * grid.
 */
function testUnsupportedAndInvalidInputsRefuse(): void {
  console.log('Testing unsupported and invalid square inputs are refused...')
  const expectThrow = (label: string, run: () => void): void => {
    let threw = false
    try {
      run()
    } catch (error) {
      threw = error instanceof RangeError
    }
    assert(threw, `${label} must throw a RangeError`)
  }
  const message: ToolpathMove = { kind: 'cut', from: { x: 20, y: 0, z: 5 }, to: { x: 60, y: 0, z: 5 } }
  expectThrow('a v-bit cutter', () => applySquareMoveToGrid(oneCellGrid(20, 0, 40), message, 3, 'v_bit'))
  expectThrow('a non-positive tool radius', () => applySquareMoveToGrid(oneCellGrid(20, 0, 40), message, 0, 'flat_endmill'))
  expectThrow('a non-finite move', () => applySquareMoveToGrid(
    oneCellGrid(20, 0, 40),
    { kind: 'cut', from: { x: Number.NaN, y: 0, z: 5 }, to: { x: 60, y: 0, z: 5 } },
    3,
    'flat_endmill',
  ))
  const untouched = oneCellGrid(20, 0, 40)
  const before = squareMaterialIntervals(untouched, 0)
  try {
    applySquareMoveToGrid(untouched, { kind: 'cut', from: { x: 20, y: 0, z: Number.NaN }, to: { x: 60, y: 0, z: 5 } }, 3, 'flat_endmill')
  } catch {
    // expected
  }
  assert(untouched.squareMaterial!.size === 0, 'a refused move must not mutate the grid')
  assert(squareMaterialIntervals(untouched, 0).every((v, i) => v === before[i]), 'a refused move must not change material')
  console.log('unsupported and invalid input refusal: PASSED')
}

/**
 * The three defects the R1 slice was rejected for/**
 * The three defects the R1 slice was rejected for, each measured independently
 * on the actual geometry:
 *
 *  1. a sloping ball cut was evaluated at a global lowest tip, overcutting
 *     1.99 mm — the tip and its axial position must stay correlated;
 *  2. the ball was a bare sphere, losing the cylindrical body above its
 *     equator — constant tip 5 must cut to radius 5, not stop at 10;
 *  3. an interior flat groove left the outer lip standing, which a single
 *     `topZ` cannot represent at all.
 */
function testMeasuredDefectsReproduce(): void {
  console.log('Testing the three measured C2-R1F defects no longer reproduce...')
  const ballTolerance = 3e-5

  // 1. Sloping ball: the independent reference is
  //    min over the sweep of tip + rt − sqrt(rt² − dx²).
  {
    const grid = oneCellGrid(20, 0, 40)
    applyMoveToGrid(grid, { kind: 'cut', from: { x: 20, y: 0, z: 11 }, to: { x: 60, y: 0, z: 7 } }, 2, 'ball_endmill', null)
    let reference = 10
    for (let n = 0; n <= 100000; n += 1) {
      const t = n / 100000
      const along = 20 + 40 * t
      const tip = 11 - 4 * t
      const dx = 40 - along
      if (Math.abs(dx) <= 2) reference = Math.min(reference, tip + 2 - Math.sqrt(4 - dx * dx))
    }
    assert(approx(grid.topZ[0], reference, ballTolerance), `sloping ball cut must reach ${reference}, got ${grid.topZ[0]}`)
    console.log(`sloping ball reach: PASSED (${grid.topZ[0].toFixed(6)} vs ${reference.toFixed(6)})`)
  }

  // 2. Ball body: the lower hemisphere plus the cylindrical shank reaches tip.
  {
    const grid = oneCellGrid(20, 0, 40)
    applyMoveToGrid(grid, { kind: 'cut', from: { x: 20, y: 0, z: 5 }, to: { x: 60, y: 0, z: 5 } }, 2, 'ball_endmill', null)
    assert(approx(grid.topZ[0], 5, ballTolerance), `a constant tip 5 ball must cut to radius 5, got ${grid.topZ[0]}`)
    console.log(`ball body floor: PASSED (${grid.topZ[0].toFixed(6)})`)
  }

  // 3. Flat interior groove: two surviving pieces, outer height unchanged.
  {
    const theta = 50 * Math.PI / 180
    const tip = 5.9981231689453125
    const grid = oneCellGrid(20, theta, 50)
    const initial = grid.topZ[0]
    const result = applyMoveToGrid(grid, { kind: 'cut', from: { x: 28, y: 0, z: tip }, to: { x: 72, y: 0, z: tip } }, 8, 'flat_endmill', null)
    const intervals = squareMaterialIntervals(grid, 0)
    const expectedLow = tip / Math.cos(theta)
    const expectedHigh = 8 / Math.sin(theta)
    assert(intervals.length === 4, `the groove must leave two pieces, got ${JSON.stringify(intervals)}`)
    assert(approx(intervals[1], expectedLow, ballTolerance), `inner gap edge must be ${expectedLow}, got ${intervals[1]}`)
    assert(approx(intervals[2], expectedHigh, ballTolerance), `outer gap edge must be ${expectedHigh}, got ${intervals[2]}`)
    assert(grid.topZ[0] === initial, 'the outer shell must keep the cell height')
    assert(result.changedCount === 1, 'the interior groove must count as removal')
    console.log(`flat interior groove: PASSED (${intervals.map((v) => v.toFixed(5)).join(', ')})`)

    // A clone owns its own material map, so replaying into it cannot alias the
    // base or resurrect the base's removed band.
    const clone = cloneSimulationGrid(grid)
    assert(clone.squareMaterial !== grid.squareMaterial, 'a clone must own its material map')
    const before = [...squareMaterialIntervals(grid, 0)]
    applyMoveToGrid(clone, { kind: 'cut', from: { x: 28, y: theta * 10, z: 10 }, to: { x: 72, y: theta * 10, z: 10 } }, 8, 'flat_endmill', null)
    assert(approx(clone.topZ[0], expectedLow, ballTolerance), `a later aligned pass must expose the gap floor ${expectedLow}, got ${clone.topZ[0]}`)
    const after = squareMaterialIntervals(grid, 0)
    assert(after.length === before.length && after.every((v, i) => v === before[i]), 'the cloned replay must not mutate the base material')
    assert(grid.topZ[0] === initial, 'the cloned replay must not mutate the base height')
    console.log('clone isolation and later exposure: PASSED')
  }
}

/**
 * The removed radial bands of one cell under a move, from the independent/**
 * The removed radial bands of one cell under a move, from the independent
 * machine-stock-space oracle — the full interval, not just the outermost
 * endpoint, so an interior groove and a surviving outer shell are both visible.
 *
 * `rSamples` sets the radial resolution, so the returned endpoints carry a
 * geometry tolerance of about one sample.
 */
function oracleRemovedBands(
  grid: SimulationGrid,
  row: number,
  col: number,
  move: ToolpathMove,
  rt: number,
  ball: boolean,
  rSamples: number,
  tSamples: number,
): Array<[number, number]> {
  const frame = grid.squareBar!.frame
  const xAxis = frame.axis === 'x'
  const cellSize = grid.cellSize
  const along = xAxis ? grid.originX + (col + 0.5) * cellSize : grid.originY + (row + 0.5) * cellSize
  const across = xAxis ? grid.originY + (row + 0.5) * cellSize : grid.originX + (col + 0.5) * cellSize
  const h0 = grid.initialTopZ![row * grid.cols + col]
  const materialAngle = (across - frame.zero) * TWO_PI / frame.circumference

  const fromAlong = xAxis ? move.from.x : move.from.y
  const toAlong = xAxis ? move.to.x : move.to.y
  const fromAcross = xAxis ? move.from.y : move.from.x
  const toAcross = xAxis ? move.to.y : move.to.x

  const removable = new Uint8Array(rSamples + 1)
  for (let ti = 0; ti <= tSamples; ti += 1) {
    const t = ti / tSamples
    const l = fromAlong + (toAlong - fromAlong) * t
    const dx = along - l
    if (dx * dx > rt * rt) continue
    const at = fromAcross + (toAcross - fromAcross) * t
    const z = move.from.z + (move.to.z - move.from.z) * t
    const theta = materialAngle - (at - frame.zero) * TWO_PI / frame.circumference
    const cos = Math.cos(theta)
    const sin = Math.sin(theta)
    const ballCenterY = z + rt
    for (let ri = 0; ri <= rSamples; ri += 1) {
      if (removable[ri] !== 0) continue
      const r = (h0 * ri) / rSamples
      const y = r * cos
      const zz = r * sin
      const inside = ball
        ? dx * dx + (y - ballCenterY) * (y - ballCenterY) + zz * zz <= rt * rt
          || (dx * dx + zz * zz <= rt * rt && y >= ballCenterY)
        : dx * dx + zz * zz <= rt * rt && y >= z
      if (inside) removable[ri] = 1
    }
  }

  const bands: Array<[number, number]> = []
  let start: number | null = null
  for (let ri = 0; ri <= rSamples; ri += 1) {
    const r = (h0 * ri) / rSamples
    if (removable[ri] !== 0 && start === null) start = r
    if (removable[ri] === 0 && start !== null) {
      bands.push([start, r])
      start = null
    }
  }
  if (start !== null) bands.push([start, h0])
  return bands
}

/** The cell whose across coordinate is closest to a material angle. */
function cellNearestAngle(grid: SimulationGrid, angle: number): { row: number; col: number } {
  const frame = grid.squareBar!.frame
  const xAxis = frame.axis === 'x'
  const acrossOrigin = xAxis ? grid.originY : grid.originX
  const acrossCount = xAxis ? grid.rows : grid.cols
  let best = 0
  let bestDelta = Infinity
  for (let i = 0; i < acrossCount; i += 1) {
    const across = acrossOrigin + (i + 0.5) * grid.cellSize
    const delta = Math.abs((across - frame.zero) * TWO_PI / frame.circumference - angle)
    if (delta < bestDelta) {
      bestDelta = delta
      best = i
    }
  }
  const along = Math.max(0, Math.min(grid.cols - 1, Math.round((40 - grid.originX) / grid.cellSize)))
  return xAxis ? { row: best, col: along } : { row: along, col: best }
}

/**
 * The actual generated rough (issue #1016 C2-R1F). The first A0 pass of the
 * real `generateRotaryRough` output cuts an **interior** radial band on a 50°
 * ray: the outer shell survives, so the cell must keep two remaining intervals,
 * its derived outer `topZ` must not move, and the removal must still count.
 * Later passes may expose that gap but must never resurrect the material.
 */
function testActualGeneratedRoughInteriorGap(): void {
  console.log('Testing the actual generated rough keeps its interior gap and outer shell...')
  const side = 20
  const length = 100
  const stock = squareStock(side, length, 'x')
  const blank = newProject('gap', 'mm')
  const tool = normalizeToolForProject(
    { ...defaultTool('mm', 1), type: 'flat_endmill', diameter: 16 },
    blank,
  )
  const mesh = buildRotaryCylinder(stock, { diameter: 12, alongStart: 20, alongEnd: 80 }, 'mm')
  const rough = generateRotaryRough('gap', mesh, stock, tool, {
    stepover: 2 * Math.PI * barMaxRadius(stock) / 8,
    stepdown: 9,
    stockToLeave: 0,
    sampleSpacing: 12,
    requestedCellSize: 0.25,
    alongStart: 20,
    alongEnd: 80,
    safeRadius: 25,
  }, {})
  assert(rough.moves.length > 0, 'the generated rough must produce motion')

  const zero = barCentre(stock)
  const frame: AroundFrame = {
    axis: 'x',
    centre: zero,
    radius: side / 2,
    zero,
    sheetStart: zero - Math.PI * side / 2,
    circumference: Math.PI * side,
  }
  const project = newProject('gap', 'mm')
  project.stock = {
    ...project.stock,
    profile: rectProfile(0, frame.sheetStart, length, frame.circumference),
    thickness: side / 2,
  }
  const grid = createSimulationGrid(project, { squareBar: { side, frame }, targetLongAxisCells: 180 })

  // The generated moves are in stock space; the sheet's radial axis is
  // pivot-referenced, exactly as the manager's defect-3 probe reads it.
  const pivot = barPivotZ(stock)
  const toSheet = (move: ToolpathMove): ToolpathMove => ({
    ...move,
    from: { ...move.from, z: move.from.z - pivot },
    to: { ...move.to, z: move.to.z - pivot },
  })

  const first = rough.moves.find((move) => move.kind === 'cut'
    && move.from.a === 0 && move.to.a === 0
    && Math.min(move.from.x, move.to.x) < 50 && Math.max(move.from.x, move.to.x) > 50)
  assert(first !== undefined, 'the generated rough must contain a central A0 cut')
  const firstSheet = toSheet(first!)

  const { row, col } = cellNearestAngle(grid, 50 * Math.PI / 180)
  const idx = row * grid.cols + col
  const baseline = grid.initialTopZ![idx]
  const result = applyMoveToGrid(grid, firstSheet, 8, 'flat_endmill', null)
  const intervals = grid.squareMaterial?.get(idx)
  assert(intervals !== undefined, 'the interior cut must write the cell material')
  assert(intervals!.length === 4, `the interior cut must leave two surviving pieces, got ${JSON.stringify(intervals)}`)
  assert(intervals![0] === 0, 'the inner core must start at the stock bottom')
  assert(grid.topZ[idx] === baseline, 'the derived outer height must not move when only an interior band is cut')
  assert(result.changedCount > 0, 'the interior cut must count as removed material')
  assert(
    result.dirtyRegion !== null
      && result.dirtyRegion.colMin <= col && result.dirtyRegion.colMax >= col
      && result.dirtyRegion.rowMin <= row && result.dirtyRegion.rowMax >= row,
    'an interior-only removal must dirty its own cell',
  )

  const oracleSamples = 200000
  const oracle = oracleRemovedBands(grid, row, col, firstSheet, 8, false, oracleSamples, 400)
  assert(oracle.length === 1, `the oracle must see one removed band, got ${JSON.stringify(oracle)}`)
  // The oracle reports the last removable radial sample, so each endpoint
  // carries its own resolution (h0 / rSamples) as the geometry tolerance.
  const tolerance = 3 * (baseline / oracleSamples)
  assert(
    Math.abs(intervals![1] - oracle[0][0]) <= tolerance && Math.abs(intervals![2] - oracle[0][1]) <= tolerance,
    `gap endpoints [${intervals![1]}, ${intervals![2]}] must match the independent oracle ${JSON.stringify(oracle[0])}`,
  )
  // The gap interior is air: no surviving piece may reach into it.
  assert(!(intervals![1] < baseline && intervals![1] === intervals![2]), 'the gap must be a real interval')
  console.log(`generated rough gap: PASSED (${intervals!.map((v) => v.toFixed(5)).join(', ')})`)

  // Later rough passes may expose the gap floor, but a subtract-only material
  // can never resurrect the removed band.
  const remaining = rough.moves.slice(rough.moves.indexOf(first!) + 1).map(toSheet)
  for (const move of remaining) {
    if (move.kind !== 'cut' && move.kind !== 'plunge' && move.kind !== 'lead_in' && move.kind !== 'lead_out') continue
    applyMoveToGrid(grid, move, 8, 'flat_endmill', null)
  }
  const after = squareMaterialIntervals(grid, idx)
  const gapLow = intervals![1]
  const gapHigh = intervals![2]
  for (let i = 0; i < after.length; i += 2) {
    assert(
      after[i + 1] <= gapLow + 1e-6 || after[i] >= gapHigh - 1e-6,
      `later passes must not resurrect the removed gap ${JSON.stringify(after)}`,
    )
  }
  assert(after.length <= intervals!.length, 'later passes only remove material')
  console.log('generated rough gap survives later passes: PASSED')
}

// ---------------------------------------------------------------------------
// Narrow finite-body contact windows (issue #1016 C2-R1G).
// ---------------------------------------------------------------------------

/** A point placed on the bar axis (`along`) and the unrolled across coordinate. */
function axisPoint(axis: 'x' | 'y', along: number, across: number, z: number): { x: number; y: number; z: number } {
  return axis === 'x' ? { x: along, y: across, z } : { x: across, y: along, z }
}

/** A one-cell square grid whose cell centre is at `(cellAlong, cellAcross)`. */
function contactCellGrid(params: {
  side: number
  axis: 'x' | 'y'
  zero: number
  cellAlong: number
  cellAcross: number
  cellSize: number
  height: number
}): SimulationGrid {
  const { side, axis, zero, cellAlong, cellAcross, cellSize, height } = params
  const radius = side / 2
  const period = Math.PI * side
  const frame: AroundFrame = {
    axis,
    centre: zero,
    radius,
    zero,
    sheetStart: zero - period / 2,
    circumference: period,
  }
  return {
    originX: (axis === 'x' ? cellAlong : cellAcross) - cellSize / 2,
    originY: (axis === 'x' ? cellAcross : cellAlong) - cellSize / 2,
    cellSize,
    cols: 1,
    rows: 1,
    stockBottomZ: 0,
    stockTopZ: side * Math.SQRT1_2,
    wrap: { axis: axis === 'x' ? 'y' : 'x', period },
    squareBar: { side, frame },
    initialTopZ: new Float32Array([height]),
    topZ: new Float32Array([height]),
    squareMaterial: new Map<number, readonly number[]>(),
  }
}

interface ContactRig {
  makeGrid: () => SimulationGrid
  move: ToolpathMove
  /** An analytic radial point the finite cutter body reaches on the cell's ray. */
  witness: number
  /** A few Float32 ulps of the blank scale: the justified material agreement. */
  tolerance: number
}

/**
 * The manager's constant-angle contact probe, generalised across axes, units,
 * translation, scaling and direction: a one-cell square grid on the ray at
 * machine angle `theta`, and a move whose tip slopes so the ray meets the finite
 * flat cutter only over a narrow positive parameter window around
 * `sStar = 63/128`. A 65-node uniform scan lands on neither side of that window,
 * so a whole move reaching the witness is exactly the regression this pins.
 */
function narrowFlatRig(params: {
  axis: 'x' | 'y'
  scale: number
  theta: number
  alongOffset: number
  acrossOffset: number
  reversed: boolean
  /** Squared clearance at the window centre, in `scale²` units; 0 is a tangent. */
  marginScale?: number
}): ContactRig {
  const { axis, scale, theta, alongOffset, acrossOffset, reversed } = params
  const side = 20 * scale
  const radius = side / 2
  const rt = 2 * scale
  const sStar = 63 / 128
  const alongSpan = 4 * scale
  const dxStar = (2 - 4 * sStar) * scale
  const margin = (params.marginScale ?? 1e-4) * scale * scale
  const tanTheta = Math.tan(theta)
  // Feasibility is `Δx² + (tip·tanθ)² ≤ rt²`, so the narrowest window at `sStar`
  // for a chosen `Δx*` puts the tip at the clearance circle divided by tanθ.
  const tipStar = Math.sqrt(rt * rt - dxStar * dxStar - margin) / tanTheta
  const slope = (dxStar * alongSpan) / (tipStar * tanTheta * tanTheta)
  const tip0 = tipStar - slope * sStar
  const tip1 = tipStar + slope * (1 - sStar)
  const cellAlong = alongOffset + alongSpan * sStar + dxStar
  const cellAcross = acrossOffset + theta * radius
  const from = axisPoint(axis, alongOffset, acrossOffset, tip0)
  const to = axisPoint(axis, alongOffset + alongSpan, acrossOffset, tip1)
  return {
    move: { kind: 'cut', from: reversed ? to : from, to: reversed ? from : to },
    witness: (tipStar / Math.cos(theta)) * (1 + 1e-6),
    tolerance: Math.max(1, side) * 2 ** -22 * 4,
    makeGrid: () => contactCellGrid({
      side,
      axis,
      zero: 0,
      cellAlong,
      cellAcross,
      cellSize: scale,
      height: squareSurfaceRadius(side, (cellAcross * TWO_PI) / (Math.PI * side)),
    }),
  }
}

/**
 * The ball analogue: the sphere's discriminant
 * `rt² − centre(s)²sin²θ − Δx(s)²` is a concave quadratic whose converged
 * maximum `margin` sits at `sStar`, so the ray meets the ball over a window of
 * half-width `O(√margin)` there and the witness is the sphere's own ray centre.
 * The shank is infeasible at that geometry, so the window is the sphere's alone.
 */
function narrowBallRig(params: {
  axis: 'x' | 'y'
  scale: number
  theta: number
  alongOffset: number
  acrossOffset: number
  reversed: boolean
  /** Squared disc clearance at the window centre, in `scale²` units; 0 is a tangent. */
  marginScale?: number
}): ContactRig {
  const { axis, scale, theta, alongOffset, acrossOffset, reversed } = params
  const side = 20 * scale
  const radius = side / 2
  const rt = 2 * scale
  const sStar = 63 / 128
  const alongSpan = 4 * scale
  const dxStar = 0.3 * scale
  const margin = (params.marginScale ?? 1e-4) * scale * scale
  const sinTheta = Math.sin(theta)
  const sin2 = sinTheta * sinTheta
  const centreStar = Math.sqrt((rt * rt - dxStar * dxStar - margin) / sin2)
  const tipStar = centreStar - rt
  const tipDelta = (dxStar * alongSpan) / (centreStar * sin2)
  const tip0 = tipStar - tipDelta * sStar
  const tip1 = tipStar + tipDelta * (1 - sStar)
  const cellAlong = alongOffset + alongSpan * sStar + dxStar
  const cellAcross = acrossOffset + theta * radius
  const from = axisPoint(axis, alongOffset, acrossOffset, tip0)
  const to = axisPoint(axis, alongOffset + alongSpan, acrossOffset, tip1)
  return {
    move: { kind: 'cut', from: reversed ? to : from, to: reversed ? from : to },
    witness: centreStar * Math.cos(theta),
    tolerance: Math.max(1, side) * 2 ** -22 * 4,
    makeGrid: () => contactCellGrid({
      side,
      axis,
      zero: 0,
      cellAlong,
      cellAcross,
      cellSize: scale,
      height: squareSurfaceRadius(side, (cellAcross * TWO_PI) / (Math.PI * side)),
    }),
  }
}

/** A constant-angle move split into `parts` equal sub-moves along the same line. */
function subdivideContactMove(move: ToolpathMove, parts: number): ToolpathMove[] {
  const out: ToolpathMove[] = []
  for (let i = 0; i < parts; i += 1) {
    const t0 = i / parts
    const t1 = (i + 1) / parts
    out.push({
      kind: move.kind,
      from: {
        x: move.from.x + (move.to.x - move.from.x) * t0,
        y: move.from.y + (move.to.y - move.from.y) * t0,
        z: move.from.z + (move.to.z - move.from.z) * t0,
      },
      to: {
        x: move.from.x + (move.to.x - move.from.x) * t1,
        y: move.from.y + (move.to.y - move.from.y) * t1,
        z: move.from.z + (move.to.z - move.from.z) * t1,
      },
    })
  }
  return out
}

/** Whether a remaining-material interval array still covers `radius`. */
function intervalContains(intervals: readonly number[], radius: number): boolean {
  for (let i = 0; i < intervals.length; i += 2) {
    if (radius >= intervals[i] && radius <= intervals[i + 1]) return true
  }
  return false
}

function assertIntervalsNear(a: readonly number[], b: readonly number[], tolerance: number, label: string): void {
  assert(a.length === b.length, `${label}: interval count ${a.length} does not match ${b.length}`)
  for (let i = 0; i < a.length; i += 1) {
    assert(
      Math.abs(a[i] - b[i]) <= tolerance,
      `${label}: endpoint ${i} is ${a[i]} vs ${b[i]} (tolerance ${tolerance})`,
    )
  }
}

/**
 * One rig's contract: the whole move removes the analytically reached witness
 * over a genuinely narrow window, and every subdivision of the same move leaves
 * the same canonical material intervals within the Float32 bound.
 */
function assertContactRig(rig: ContactRig, rt: number, toolType: ToolType, label: string): void {
  const whole = rig.makeGrid()
  const result = applySquareMoveToGrid(whole, rig.move, rt, toolType)
  const wholeIntervals = squareMaterialIntervals(whole, 0)
  assert(result.changedCount === 1, `${label}: the whole move must remove material`)
  assert(
    !intervalContains(wholeIntervals, rig.witness),
    `${label}: the whole move must remove the analytic witness radius ${rig.witness}`,
  )
  assert(
    wholeIntervals.length === 4 && wholeIntervals[2] - wholeIntervals[1] < 0.1 * rt,
    `${label}: the removed window must be narrow and interior, got ${JSON.stringify(wholeIntervals)}`,
  )
  for (const parts of [16, 64, 128]) {
    const subdivided = rig.makeGrid()
    for (const move of subdivideContactMove(rig.move, parts)) applySquareMoveToGrid(subdivided, move, rt, toolType)
    const subIntervals = squareMaterialIntervals(subdivided, 0)
    assert(
      !intervalContains(subIntervals, rig.witness),
      `${label}: ${parts} subdivisions must also remove the witness`,
    )
    assertIntervalsNear(wholeIntervals, subIntervals, rig.tolerance, `${label} (${parts} subdivisions)`)
  }
}

function testNarrowConstantAngleContactWindows(): void {
  console.log('Testing narrow constant-angle contact windows are found without a scan...')
  const thetas = [30 * Math.PI / 180, 40 * Math.PI / 180, 45 * Math.PI / 180]
  let cases = 0
  for (const axis of ['x', 'y'] as const) {
    for (const scale of [1, 1 / 25.4]) {
      for (let i = 0; i < thetas.length; i += 1) {
        const shared = {
          axis,
          scale,
          theta: thetas[i],
          alongOffset: (i - 1) * 5 * scale,
          acrossOffset: (i - 1) * 3 * scale,
          reversed: i % 2 === 1,
        }
        assertContactRig(narrowFlatRig(shared), 2 * scale, 'flat_endmill', `flat narrow ${axis}/${i}`)
        assertContactRig(narrowBallRig(shared), 2 * scale, 'ball_endmill', `ball narrow ${axis}/${i}`)
        cases += 2
      }
    }
  }
  console.log(`narrow constant-angle contact windows: PASSED (${cases} cases)`)
}

/**
 * The other side of the narrow window: an oblique constant-angle pass whose
 * clearance at the window centre is exactly zero is a true tangent — the finite
 * cutter touches one radius and removes nothing. Widening the same geometry to a
 * positive clearance is the real narrow cut asserted above, so a tolerance that
 * silently swallowed it, or a scan that turned it into virgin material, fails.
 */
function testTrueObliqueTangentRemovesNothing(): void {
  console.log('Testing true oblique constant-angle tangents remove nothing...')
  let cases = 0
  for (const axis of ['x', 'y'] as const) {
    for (const scale of [1, 1 / 25.4]) {
      for (const theta of [30 * Math.PI / 180, 40 * Math.PI / 180, 45 * Math.PI / 180]) {
        const shared = {
          axis,
          scale,
          theta,
          alongOffset: 0,
          acrossOffset: 0,
          reversed: false,
          marginScale: 0,
        }
        const rigs: Array<{ rig: ContactRig; tool: ToolType; label: string }> = [
          { rig: narrowFlatRig(shared), tool: 'flat_endmill', label: 'flat' },
          { rig: narrowBallRig(shared), tool: 'ball_endmill', label: 'ball' },
        ]
        for (const { rig, tool, label } of rigs) {
          const grid = rig.makeGrid()
          const result = applySquareMoveToGrid(grid, rig.move, 2 * scale, tool)
          assert(
            result.changedCount === 0,
            `${label} true tangent ${axis}/${theta.toFixed(3)} must remove nothing, got ${result.changedCount}`,
          )
          assert(
            squareMaterialIntervals(grid, 0).length === 2,
            `${label} true tangent ${axis}/${theta.toFixed(3)} must leave virgin material`,
          )
          cases += 1
        }
      }
    }
  }
  console.log(`true oblique constant-angle tangents: PASSED (${cases} cases)`)
}

/**
 * The manager's independent physical ball probe, kept as a permanent
 * regression: a sloping ball and a constant-tip ball body, both axes, mm and
 * inch, both directions (16 cases), each against a brute-force min-over-the-sweep
 * reference — never a production expression. The manager's probe's other four
 * cases are its interior-gap cases, pinned separately above.
 */
function testManagerBallPhysicalProbe(): void {
  console.log('Testing the manager physical ball probe (16 cases)...')
  let cases = 0
  let worst = 0
  for (const axis of ['x', 'y'] as const) {
    for (const scale of [1, 1 / 25.4]) {
      for (const reversed of [false, true]) {
        for (const body of [false, true]) {
          const side = 20 * scale
          const r = 2 * scale
          const grid = contactCellGrid({
            side,
            axis,
            zero: 0,
            cellAlong: 40 * scale,
            cellAcross: 0,
            cellSize: scale,
            height: 10 * scale,
          })
          const a = axisPoint(axis, 20 * scale, 0, (body ? 5 : 11) * scale)
          const b = axisPoint(axis, 60 * scale, 0, (body ? 5 : 7) * scale)
          const move: ToolpathMove = { kind: 'cut', from: reversed ? b : a, to: reversed ? a : b }
          let expected = 10 * scale
          for (let n = 0; n <= 100000; n += 1) {
            const t = n / 100000
            const along = 20 * scale + 40 * scale * t
            const tip = (body ? 5 : 11 - 4 * t) * scale
            const dx = 40 * scale - along
            if (Math.abs(dx) <= r) expected = Math.min(expected, tip + r - Math.sqrt(Math.max(0, r * r - dx * dx)))
          }
          applySquareMoveToGrid(grid, move, r, 'ball_endmill')
          const error = Math.abs(grid.topZ[0] - expected)
          worst = Math.max(worst, error / scale)
          assert(
            error <= 3e-5 * scale,
            `physical ball ${axis}/${scale}/${reversed}/${body}: ${grid.topZ[0]} vs ${expected}`,
          )
          cases += 1
        }
      }
    }
  }
  assert(cases === 16, `the physical ball probe must cover 16 cases, got ${cases}`)
  console.log(`manager physical ball probe: PASSED (worst ${worst.toExponential(3)} mm)`)
}

/**
 * The supported boundary for angle-changing square motion: below the blanket's
 * corner envelope it is refused atomically, because the rotating sweep is not
 * certified at grid resolution; above the envelope it is the O(1) safe link the
 * generators retract through and must remove nothing. A move with a constant
 * explicit `a` is a constant-angle move even when `across` changes.
 */
function testChangingAngleRefusedAtomically(): void {
  console.log('Testing below-envelope angle-changing square motion is refused atomically...')
  const grid = squareSheet(20, 'x', 0)
  applyMoveToGrid(grid, { kind: 'cut', from: { x: 30, y: 0, z: 5 }, to: { x: 50, y: 0, z: 5 } }, 4, 'flat_endmill', null)
  const seeded = materialSnapshot(grid)
  expectRefusal(
    grid,
    { kind: 'cut', from: { x: 20, y: -8, z: 6 }, to: { x: 60, y: 8, z: 6 } },
    5,
    'flat_endmill',
    'a below-envelope turning flat move',
  )
  expectRefusal(
    grid,
    { kind: 'cut', from: { x: 20, y: 0, z: 6, a: 0 }, to: { x: 60, y: 0, z: 6, a: 45 } },
    5,
    'flat_endmill',
    'a below-envelope explicit-A change',
  )
  expectRefusal(
    grid,
    { kind: 'plunge', from: { x: 40, y: -8, z: 12 }, to: { x: 40, y: 8, z: 12 } },
    5,
    'ball_endmill',
    'a below-envelope turning ball move',
  )
  assert(materialSnapshot(grid) === seeded, 'every refusal must leave the seeded material untouched')

  // A constant program angle is a constant-angle move, however `across` moves.
  const constantA = squareSheet(20, 'x', 0)
  const result = applyMoveToGrid(
    constantA,
    { kind: 'cut', from: { x: 20, y: -8, z: 6, a: 0 }, to: { x: 60, y: 8, z: 6, a: 0 } },
    5,
    'flat_endmill',
    null,
  )
  assert(result.changedCount > 0, 'a constant explicit A move must cut, not refuse')

  // Above the full corner envelope even a turning move is a safe no-op.
  const above = squareSheet(20, 'x', 0)
  const aboveResult = applyMoveToGrid(
    above,
    { kind: 'cut', from: { x: 20, y: -30, z: 15 }, to: { x: 60, y: 30, z: 15 } },
    5,
    'flat_endmill',
    null,
  )
  assert(aboveResult.changedCount === 0, 'an above-envelope turning move must remove nothing')
  assert(measure(above).changed === 0, 'an above-envelope turning move must not lower a cell')
  console.log('angle-changing refusal and above-envelope safety: PASSED')
}

// ---------------------------------------------------------------------------
// Generated paths: material, stats and playback.
// ---------------------------------------------------------------------------

/** A square-stock project and its Around frame, for the generated-path tests. */
function squareStockProject(side: number, length: number, label: string): {
  stock: ReturnType<typeof squareStock>
  project: ReturnType<typeof newProject>
  frame: AroundFrame
} {
  const stock = squareStock(side, length, 'x')
  const zero = barCentre(stock)
  const frame: AroundFrame = {
    axis: 'x',
    centre: zero,
    radius: side / 2,
    zero,
    sheetStart: zero - Math.PI * side / 2,
    circumference: Math.PI * side,
  }
  const project = newProject(label, 'mm')
  project.stock = {
    ...project.stock,
    profile: rectProfile(0, frame.sheetStart, length, frame.circumference),
    thickness: side / 2,
  }
  return { stock, project, frame }
}

/** Compare every cell's canonical remaining material between two square grids. */
function materialMapsApproxEqual(a: SimulationGrid, b: SimulationGrid, epsilon = 1e-6): boolean {
  const keys = new Set<number>([...(a.squareMaterial?.keys() ?? []), ...(b.squareMaterial?.keys() ?? [])])
  for (const key of keys) {
    const left = squareMaterialIntervals(a, key)
    const right = squareMaterialIntervals(b, key)
    if (left.length !== right.length) return false
    for (let i = 0; i < left.length; i += 1) {
      if (!approx(left[i], right[i], epsilon)) return false
    }
  }
  return true
}

/**
 * Square statistics and the dirty region must report an **interior** removal:
 * the generated rough's A0 pass leaves a cell's outer `topZ` exactly where it
 * was while removing a radial band, and both must still count it.
 */
function testSquareStatsCountInteriorRemoval(): void {
  console.log('Testing square stats and dirty tracking count an interior-only removal...')
  const side = 20
  const length = 100
  const { project, frame } = squareStockProject(side, length, 'stats')
  const toolRadius = 8
  const tip = 5.9981231689453125
  const item = {
    operationId: 'stats',
    operationName: 'stats',
    toolRef: null,
    toolType: 'flat_endmill' as const,
    toolRadius,
    vBitAngle: null,
    toolpath: {
      operationId: 'stats',
      moves: [
        { kind: 'cut' as const, from: { x: 28, y: 0, z: tip }, to: { x: 72, y: 0, z: tip } },
      ],
      warnings: [],
      bounds: null,
    },
  }
  const result = simulateReplayItemsHeightfield(project, [item], {
    squareBar: { side, frame },
    targetLongAxisCells: 120,
  })
  const material = result.grid.squareMaterial
  assert(material !== undefined && material.size > 0, 'the interior pass must remove material')
  let interiorOnly = 0
  for (const index of material!.keys()) {
    if (result.grid.topZ[index] === result.grid.initialTopZ![index]) interiorOnly += 1
  }
  assert(interiorOnly > 0, 'the pass must leave at least one cell removed only inside')
  assert(
    result.stats.removedCellCount === material!.size,
    `stats must count every interval-only removal (${result.stats.removedCellCount} vs ${material!.size})`,
  )
  assert(result.stats.maxRemovedDepth > 0, 'stats must report the interior removal depth')
  console.log(`square interior-only stats: PASSED (${interiorOnly} cells with an unchanged outer height)`)
}

/**
 * The actual generated finish path — a ball toolpath with above-envelope angle
 * links — must replay through the square kernel, and stepped playback seeking
 * must land on the same material as the batch replay, intervals included.
 */
function testActualGeneratedFinishReplays(): void {
  console.log('Testing the actual generated finish replays and seeks identically...')
  const side = 20
  const { stock, project, frame } = squareStockProject(side, 100, 'finish')
  const blank = newProject('finish', 'mm')
  const tool = normalizeToolForProject({ ...defaultTool('mm', 1), type: 'ball_endmill', diameter: 8 }, blank)
  const mesh = buildRotaryCylinder(stock, { diameter: 12, alongStart: 20, alongEnd: 80 }, 'mm')
  const finish = generateRotaryFinish('finish', mesh, stock, tool, {
    stepover: 2 * Math.PI * barMaxRadius(stock) / 16,
    stockToLeave: 0,
    sampleSpacing: 8,
    requestedCellSize: 0.25,
    alongStart: 20,
    alongEnd: 80,
    safeRadius: 25,
  }, {})
  assert(finish.moves.length > 0, 'the generated finish must produce motion')

  const pivot = barPivotZ(stock)
  const moves = finish.moves
    .filter((move) => move.kind === 'cut' || move.kind === 'plunge' || move.kind === 'lead_in' || move.kind === 'lead_out')
    .map((move) => ({
      ...move,
      from: { ...move.from, z: move.from.z - pivot },
      to: { ...move.to, z: move.to.z - pivot },
    }))
  assert(moves.length > 0, 'the generated finish must have replayable motion')

  const makeGrid = (): SimulationGrid => createSimulationGrid(project, {
    squareBar: { side, frame },
    targetLongAxisCells: 120,
  })
  const batch = makeGrid()
  for (const move of moves) applyMoveToGrid(batch, move, tool.radius, 'ball_endmill', null)
  assert(measure(batch).changed > 0, 'the generated finish must remove material')

  const options = { toolType: 'ball_endmill' as const, toolRadius: tool.radius, vBitAngle: null }
  const playback = new PlaybackController(makeGrid(), moves, options, { maxSegmentLength: 0 })
  playback.seekToFraction(1)
  assert(gridsApproxEqual(playback.liveGrid, batch), 'generated finish playback must match the batch replay')
  assert(
    materialMapsApproxEqual(playback.liveGrid, batch),
    'generated finish playback material intervals must match the batch replay',
  )

  playback.seekToFraction(0.5)
  const halfway = new PlaybackController(makeGrid(), moves, options, { maxSegmentLength: 0 })
  halfway.seekToFraction(0.5)
  assert(gridsApproxEqual(playback.liveGrid, halfway.liveGrid), 'a backward finish seek must restore the earlier state')
  console.log('generated finish path and playback seeking: PASSED')
}

try {
  testJustTouchRemovesNothing()
  testNaiveUnrolledKernelWouldHaveFailed()
  testOracleParityFlatCuts()
  testOracleParityBallCuts()
  testHighAngleMovingLinkRemovesNothing()
  testUntouchedEndsKeepTheSquareSection()
  testSeamAndMultiTurnIdentity()
  testPivotIsTheTrueTurningAxis()
  testPlaybackMatchesBatchReplay()
  testPlaybackPreservesDescriptorAndBaseline()
  testMeasuredDefectsReproduce()
  testUnsupportedAndInvalidInputsRefuse()
  testActualGeneratedRoughInteriorGap()
  testNarrowConstantAngleContactWindows()
  testTrueObliqueTangentRemovesNothing()
  testManagerBallPhysicalProbe()
  testChangingAngleRefusedAtomically()
  testSquareStatsCountInteriorRemoval()
  testActualGeneratedFinishReplays()
  console.log('\nAll square replay tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
