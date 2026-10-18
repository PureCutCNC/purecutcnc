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
 * Parity tests for the optimized applyMoveToGrid cut kernel.
 *
 * The kernel inlines the point-to-segment distance and the cutter profile for
 * speed; these tests replay the same moves through a straightforward reference
 * implementation built on cutterSurfaceZ and require identical grids.
 *
 * Run with: npx tsx src/engine/simulation/replay.test.ts
 */

import { applyMoveToGrid } from './replay'
import { cutterSurfaceZ } from './tools'
import type { SimulationGrid } from './types'
import type { ToolType } from '../../types/project'
import type { ToolpathMove } from '../toolpaths/types'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function makeGrid(cols = 60, rows = 50): SimulationGrid {
  return {
    cols,
    rows,
    cellSize: 0.5,
    originX: -3,
    originY: -2,
    stockTopZ: 0,
    stockBottomZ: -6,
    topZ: new Float32Array(cols * rows).fill(0),
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/** The pre-optimization cell loop, kept as the behavioral reference. */
function referenceApplyMove(
  grid: SimulationGrid,
  move: ToolpathMove,
  toolRadius: number,
  toolType: ToolType,
  vBitAngle: number | null,
): void {
  const minX = Math.min(move.from.x, move.to.x) - toolRadius
  const maxX = Math.max(move.from.x, move.to.x) + toolRadius
  const minY = Math.min(move.from.y, move.to.y) - toolRadius
  const maxY = Math.max(move.from.y, move.to.y) + toolRadius

  const colStart = clamp(Math.floor((minX - grid.originX) / grid.cellSize), 0, grid.cols - 1)
  const colEnd = clamp(Math.floor((maxX - grid.originX) / grid.cellSize), 0, grid.cols - 1)
  const rowStart = clamp(Math.floor((minY - grid.originY) / grid.cellSize), 0, grid.rows - 1)
  const rowEnd = clamp(Math.floor((maxY - grid.originY) / grid.cellSize), 0, grid.rows - 1)

  const dx = move.to.x - move.from.x
  const dy = move.to.y - move.from.y
  const lengthSq = dx * dx + dy * dy
  const xyStationary = lengthSq <= 1e-12

  for (let row = rowStart; row <= rowEnd; row += 1) {
    const y = grid.originY + (row + 0.5) * grid.cellSize
    for (let col = colStart; col <= colEnd; col += 1) {
      const x = grid.originX + (col + 0.5) * grid.cellSize

      let distance: number
      let t: number
      if (xyStationary) {
        distance = Math.hypot(x - move.from.x, y - move.from.y)
        t = 0
      } else {
        t = clamp(((x - move.from.x) * dx + (y - move.from.y) * dy) / lengthSq, 0, 1)
        distance = Math.hypot(x - (move.from.x + dx * t), y - (move.from.y + dy * t))
      }

      const toolCenterZ = xyStationary
        ? Math.min(move.from.z, move.to.z)
        : move.from.z + (move.to.z - move.from.z) * t
      const cutZ = cutterSurfaceZ(toolType, toolRadius, toolCenterZ, distance, vBitAngle)
      if (cutZ === null) continue

      const idx = row * grid.cols + col
      const nextZ = Math.max(grid.stockBottomZ, cutZ)
      if (nextZ < grid.topZ[idx] - 1e-9) {
        grid.topZ[idx] = nextZ
      }
    }
  }
}

function maxGridDelta(a: SimulationGrid, b: SimulationGrid): number {
  let max = 0
  for (let i = 0; i < a.topZ.length; i += 1) {
    max = Math.max(max, Math.abs(a.topZ[i] - b.topZ[i]))
  }
  return max
}

const TEST_MOVES: ToolpathMove[] = [
  // Diagonal ramp cut crossing cell rows at an angle.
  { kind: 'cut', from: { x: -1, y: -1, z: -0.5 }, to: { x: 18, y: 14, z: -2.5 } },
  // Axis-aligned cut.
  { kind: 'cut', from: { x: 2, y: 6, z: -1 }, to: { x: 20, y: 6, z: -1 } },
  // Stationary plunge (zero XY length, Z-only).
  { kind: 'plunge', from: { x: 10, y: 10, z: 0 }, to: { x: 10, y: 10, z: -3 } },
  // Short lead-in arc segment.
  { kind: 'lead_in', from: { x: 4.2, y: 3.1, z: -1.2 }, to: { x: 4.9, y: 3.7, z: -1.2 } },
  // Cut deeper than the stock bottom (exercises the bottom clamp).
  { kind: 'cut', from: { x: 6, y: 2, z: -8 }, to: { x: 12, y: 2, z: -8 } },
]

function testKernelMatchesReferenceProfile(toolType: ToolType, toolRadius: number, vBitAngle: number | null): void {
  console.log(`Testing optimized kernel parity for ${toolType}...`)
  const optimized = makeGrid()
  const reference = makeGrid()

  for (const move of TEST_MOVES) {
    applyMoveToGrid(optimized, move, toolRadius, toolType, vBitAngle)
    referenceApplyMove(reference, move, toolRadius, toolType, vBitAngle)
  }

  const delta = maxGridDelta(optimized, reference)
  assert(delta <= 1e-6, `${toolType} kernel must match the cutterSurfaceZ reference (max delta ${delta})`)

  // Sanity: the moves actually removed material, so the test isn't vacuous.
  let removed = 0
  for (let i = 0; i < optimized.topZ.length; i += 1) {
    if (optimized.topZ[i] < -1e-9) removed += 1
  }
  assert(removed > 50, `expected a meaningful number of cut cells, got ${removed}`)
  console.log(`optimized kernel parity for ${toolType}: PASSED`)
}

function testDirtyRegionCoversChangedCells(): void {
  console.log('Testing dirty region exactly bounds the changed cells...')
  const grid = makeGrid()
  const before = new Float32Array(grid.topZ)
  const move: ToolpathMove = { kind: 'cut', from: { x: 3, y: 4, z: -1 }, to: { x: 9, y: 8, z: -1 } }
  const result = applyMoveToGrid(grid, move, 1.5, 'flat_endmill', null)

  assert(result.changedCount > 0 && result.dirtyRegion !== null, 'cut should change cells and report a region')
  const region = result.dirtyRegion!
  let changedInside = 0
  for (let row = 0; row < grid.rows; row += 1) {
    for (let col = 0; col < grid.cols; col += 1) {
      const changed = grid.topZ[row * grid.cols + col] !== before[row * grid.cols + col]
      const inside = col >= region.colMin && col <= region.colMax && row >= region.rowMin && row <= region.rowMax
      if (changed) {
        assert(inside, `changed cell (${col}, ${row}) must be inside the dirty region`)
        changedInside += 1
      }
    }
  }
  assert(changedInside === result.changedCount, 'changedCount should equal the number of modified cells')
  console.log('dirty region bounds changed cells: PASSED')
}

/**
 * A physically consistent round bar unrolled: one period across, with the
 * surface at the frame radius `period / 2π` (issue #1016 C2-F8). The old
 * fixture put the surface at 0 with a -6 bottom, which is a negative radius and
 * meaningless once the kernel resolves the cutter's true solid.
 */
function makeWrappedGrid(): SimulationGrid {
  const cols = 60
  const rows = 40
  const cellSize = 0.5
  const period = 20
  const radius = period / (2 * Math.PI)
  return {
    cols,
    rows,
    cellSize,
    originX: -3,
    originY: -10,
    stockTopZ: radius,
    stockBottomZ: 0,
    wrap: { axis: 'y', period },
    topZ: new Float32Array(cols * rows).fill(radius),
  }
}

function shiftAcross(move: ToolpathMove, shift: number): ToolpathMove {
  return {
    ...move,
    from: { ...move.from, y: move.from.y + shift },
    to: { ...move.to, y: move.to.y + shift },
  }
}

/**
 * F8 replaced the old flat-sheet parity for wrapped grids (the kernel now
 * resolves the cutter's true solid, so its values move on purpose). The seam
 * contract that parity protected is checked directly instead: replaying a path
 * one full period across must cut exactly the same material, because the sheet
 * is periodic. The flat kernel's own parity above is unchanged.
 */
function testWrappedRoundSeamIsAPureTranslation(): void {
  console.log('Testing a wrapped round grid cuts the same material one period across...')
  const period = 20
  const low = -10
  // Each move keeps a constant across coordinate, so the base cutter and its
  // seam copy touch disjoint cells and the comparison cannot depend on the
  // order the kernel applies them in.
  const atAcross = (across: number, z: number): ToolpathMove => ({
    kind: 'cut',
    from: { x: 4, y: across, z },
    to: { x: 16, y: across, z },
  })
  // A cutter just inside one seam and its copy one period across land on
  // opposite edges and touch disjoint cells, so the comparison is exact.
  const seamMoves: ToolpathMove[] = [
    atAcross(low + 0.4, 1.2), // just inside the low seam
    atAcross(low - 0.4, 1.2), // just outside it
  ]
  for (const [toolType, toolRadius, vBitAngle] of [
    ['flat_endmill', 1.5, null],
    ['ball_endmill', 2, null],
    ['v_bit', 3, 60],
  ] as [ToolType, number, number | null][]) {
    for (const move of seamMoves) {
      const original = makeWrappedGrid()
      const shifted = makeWrappedGrid()
      const before = new Float32Array(original.topZ)
      applyMoveToGrid(original, move, toolRadius, toolType, vBitAngle)
      applyMoveToGrid(shifted, shiftAcross(move, period), toolRadius, toolType, vBitAngle)
      const delta = maxGridDelta(original, shifted)
      assert(delta === 0, `${toolType} y=${move.from.y}: a seam copy must be a pure translation (max ${delta})`)
      let cut = 0
      for (let i = 0; i < before.length; i += 1) if (original.topZ[i] < before[i] - 1e-9) cut += 1
      assert(cut > 0, `${toolType} y=${move.from.y}: the seam fixture must cut`)
    }
  }
  console.log('wrapped round seam translation: PASSED')
}

function testRoundAndFlatGridsGainNoSquareKeys(): void {
  console.log('Testing a round/flat grid gains no square keys and reports no baseline...')
  const grid = makeWrappedGrid()
  applyMoveToGrid(grid, { kind: 'cut', from: { x: 2, y: 0, z: -1 }, to: { x: 12, y: 6, z: -1 } }, 2, 'flat_endmill', null)
  assert(!('squareBar' in grid), 'a round grid must not gain a squareBar key')
  assert(!('initialTopZ' in grid), 'a round grid must not gain an initialTopZ key')
  const keys = Object.keys(grid).sort()
  const expected = ['cellSize', 'cols', 'originX', 'originY', 'rows', 'stockBottomZ', 'stockTopZ', 'topZ', 'wrap'].sort()
  assert(keys.length === expected.length && keys.every((key, i) => key === expected[i]), `round grid keys drifted: ${keys.join(',')}`)

  const flat = makeGrid()
  applyMoveToGrid(flat, { kind: 'cut', from: { x: 2, y: 3, z: -1 }, to: { x: 12, y: 6, z: -1 } }, 2, 'flat_endmill', null)
  const flatKeys = Object.keys(flat).sort()
  const expectedFlat = ['cellSize', 'cols', 'originX', 'originY', 'rows', 'stockBottomZ', 'stockTopZ', 'topZ'].sort()
  assert(
    flatKeys.length === expectedFlat.length && flatKeys.every((key, i) => key === expectedFlat[i]),
    `flat grid keys drifted: ${flatKeys.join(',')}`,
  )
  console.log('round/flat grids gain no square keys: PASSED')
}

try {
  testKernelMatchesReferenceProfile('flat_endmill', 1.5, null)
  testKernelMatchesReferenceProfile('ball_endmill', 2, null)
  testKernelMatchesReferenceProfile('v_bit', 3, 60)
  testKernelMatchesReferenceProfile('v_bit', 3, 90)
  testKernelMatchesReferenceProfile('drill', 1.25, null)
  testDirtyRegionCoversChangedCells()
  testWrappedRoundSeamIsAPureTranslation()
  testRoundAndFlatGridsGainNoSquareKeys()
  console.log('\nAll replay kernel tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
