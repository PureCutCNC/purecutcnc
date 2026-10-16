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

import { applyMoveToGrid } from './replay'
import { applySquareMoveToGrid, squareMaterialIntervals, squareSurfaceRadius } from './squareReplay'
import { PlaybackController, cloneSimulationGrid } from './playback'
import { createSimulationGrid } from './grid'
import { barCentre, barMaxRadius, barPivotZ, squareStock } from '../../types/barStock'
import { defaultTool, newProject, rectProfile } from '../../types/project'
import { normalizeToolForProject } from '../toolpaths/geometry'
import { generateRotaryRough } from '../toolpaths/rotaryModel'
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

  // Diagonal submove (both angle and along move): split below the across cell
  // width and swept to the removed-band fixed point.
  grid = squareSheet(20, 'x', 0)
  move = { kind: 'cut', from: { x: 20, y: -8, z: 6 }, to: { x: 60, y: 8, z: 6 } }
  applyMoveToGrid(grid, move, 5, 'flat_endmill', null)
  assertMatchesOracle(grid, move, 5, 'flat_endmill', 0.05, 'flat diagonal sweep z=6')

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

  grid = squareSheet(20, 'x', 0)
  move = { kind: 'cut', from: { x: 20, y: -6, z: 6 }, to: { x: 60, y: 6, z: 6 } }
  applyMoveToGrid(grid, move, 5, 'ball_endmill', null)
  assertMatchesOracle(grid, move, 5, 'ball_endmill', 0.05, 'ball diagonal sweep z=6')

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

  const cutAt = (fromAcross: number, toAcross: number): SimulationGrid => {
    const grid = squareSheet(side, 'x', 0)
    applyMoveToGrid(grid, {
      kind: 'cut', from: { x: 20, y: fromAcross, z: 6 }, to: { x: 60, y: toAcross, z: 6 },
    }, rt, 'flat_endmill', null)
    return grid
  }

  // A move across the seam and the same move shifted one period are identical.
  const seam = cutAt(base + 2, base + 12)
  const shifted = cutAt(base + 2 + circumference, base + 12 + circumference)
  assert(gridsApproxEqual(seam, shifted), 'a seam-crossing cut must equal the same cut one period on')

  // A whole extra turn reaches the same material.
  const turned = cutAt(base + 2, base + 12 + circumference)
  assert(
    measure(turned).changed >= measure(seam).changed,
    'turning through an extra period must reach at least the same material',
  )
  const turnedAgain = cutAt(base + 2 + circumference, base + 12 + 2 * circumference)
  assert(gridsApproxEqual(turned, turnedAgain), 'a multi-turn cut must be periodic')

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
  console.log('\nAll square replay tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
