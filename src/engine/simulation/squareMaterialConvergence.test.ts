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
 * Fixed-count parity of the square-material searches (issue #1016 C2-P1R).
 *
 * P1/P1F let `maximizeConcave` and `bisectCrossing` stop at a tolerance. That
 * was reverted because the stored interval topology is decided on the
 * unrounded doubles: `compactIntervals` drops a band narrower than one Float32
 * ulp, and at a tangential crossing the endpoint moves like `√(s − s*)`, so a
 * tolerance stop can sit just across that threshold from the fixed-96 answer.
 *
 * Codex's two-cut case pins the failure. Side 12, one 0.5 mm cell at along 0.5,
 * across 3.6, A=0: cut 1 is a stationary flat r6 at along 0.5 with tip
 * 3.4963814291513753; cut 2 is a flat r2.4 move `(0, 4.6) → (2.9000000573, 0)`.
 * Fixed 96 removes the cell entirely (`[]`, topZ 0); an early stop leaves a
 * one-cell `[4.236314232713846, 4.236314737894846]` spike (topZ 4.2363…).
 *
 * Production now runs exactly `CONVERGE_ITERATIONS = 96` iterations in both
 * loops. These tests hard-code the pre-P1 kernel's stored values and the
 * digest of a seeded sweep, so re-introducing an early exit fails here: the
 * two-cut case is the mutation (an early exit at tolerance 1e-9 was checked and
 * fails the first test).
 *
 * Run with: npx tsx src/engine/simulation/squareMaterialConvergence.test.ts
 */

import { createHash } from 'node:crypto'
import { applySquareMoveToGrid, squareSurfaceRadius } from './squareMaterial'
import type { SimulationGrid } from './types'
import type { AroundFrame } from '../aroundFrame'
import type { ToolpathMove } from '../toolpaths/types'
import type { ToolType } from '../../types/project'

const TWO_PI = Math.PI * 2
const SIDE = 12
const CIRCUMFERENCE = Math.PI * SIDE
const CELL_SIZE = 0.5
const ALONG_LENGTH = 30

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

/**
 * One cell whose centre is exactly `(along, across)` on the test sheet, so the
 * Codex reproduction can pin the ray angle without grid-rounding noise.
 */
function makeCell(along: number, across: number): SimulationGrid {
  const frame: AroundFrame = {
    axis: 'x',
    centre: 0,
    radius: SIDE / 2,
    zero: 0,
    sheetStart: -CIRCUMFERENCE / 2,
    circumference: CIRCUMFERENCE,
  }
  const topZ = new Float32Array([squareSurfaceRadius(SIDE, across / (SIDE / 2))])
  return {
    originX: along - CELL_SIZE / 2,
    originY: across - CELL_SIZE / 2,
    cellSize: CELL_SIZE,
    cols: 1,
    rows: 1,
    stockBottomZ: 0,
    stockTopZ: SIDE * Math.SQRT1_2,
    squareBar: { side: SIDE, frame },
    initialTopZ: new Float32Array(topZ),
    topZ,
  }
}

/** The full production sheet: pivot at the true centre, one-radius thickness. */
function makeSheet(axis: 'x' | 'y'): SimulationGrid {
  const frame: AroundFrame = {
    axis,
    centre: 0,
    radius: SIDE / 2,
    zero: 0,
    sheetStart: -CIRCUMFERENCE / 2,
    circumference: CIRCUMFERENCE,
  }
  const xMin = axis === 'x' ? 0 : -CIRCUMFERENCE / 2
  const xMax = axis === 'x' ? ALONG_LENGTH : CIRCUMFERENCE / 2
  const yMin = axis === 'x' ? -CIRCUMFERENCE / 2 : 0
  const yMax = axis === 'x' ? CIRCUMFERENCE / 2 : ALONG_LENGTH
  const cols = Math.round((xMax - xMin) / CELL_SIZE)
  const rows = Math.round((yMax - yMin) / CELL_SIZE)
  const topZ = new Float32Array(cols * rows)
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const across = axis === 'x' ? yMin + (row + 0.5) * CELL_SIZE : xMin + (col + 0.5) * CELL_SIZE
      topZ[row * cols + col] = squareSurfaceRadius(SIDE, (across - frame.zero) * TWO_PI / CIRCUMFERENCE)
    }
  }
  return {
    originX: xMin,
    originY: yMin,
    cellSize: CELL_SIZE,
    cols,
    rows,
    stockBottomZ: 0,
    stockTopZ: SIDE * Math.SQRT1_2,
    squareBar: { side: SIDE, frame },
    initialTopZ: new Float32Array(topZ),
    topZ,
  }
}

function sheetPoint(along: number, angleDeg: number): { x: number; y: number } {
  return { x: along, y: angleDeg * CIRCUMFERENCE / 360 }
}

function pointOn(axis: 'x' | 'y', along: number, angleDeg: number, z: number): { x: number; y: number; z: number } {
  const point = sheetPoint(along, angleDeg)
  return axis === 'x' ? { x: point.x, y: point.y, z } : { x: point.y, y: point.x, z }
}

interface SeededMove {
  move: ToolpathMove
  toolRadius: number
  toolType: ToolType
}

/**
 * The deterministic, asymmetric move set the pre-P1 digest was taken from:
 * flat and ball, axial and oblique, both rotation senses, stepped passes,
 * plunges, the explicit-rotary-angle branch, and passes that reach only the
 * corner envelope.
 */
function seededMoves(axis: 'x' | 'y'): SeededMove[] {
  const flat = 'flat_endmill' as const
  const ball = 'ball_endmill' as const
  // The exact angle-window edges for the two edge-ray moves below:
  // |θ| ≤ atan(rt / tipMin), expressed in the sheet's degrees.
  const flatWindowDeg = Math.atan(1.5 / 3.0) * 180 / Math.PI
  const ballWindowDeg = Math.atan(1.8 / 3.2) * 180 / Math.PI
  return [
    { move: { kind: 'cut', from: pointOn(axis, 4, 0, 5), to: pointOn(axis, 26, 0, 5) }, toolRadius: 1.5, toolType: flat },
    { move: { kind: 'cut', from: pointOn(axis, 5, 9, 4.6), to: pointOn(axis, 24, 9, 4.0) }, toolRadius: 1.2, toolType: flat },
    { move: { kind: 'cut', from: pointOn(axis, 3, 31, 4.2), to: pointOn(axis, 27, 31, 4.2) }, toolRadius: 1.6, toolType: flat },
    { move: { kind: 'cut', from: pointOn(axis, 6, -24, 3.8), to: pointOn(axis, 25, -24, 3.4) }, toolRadius: 1.4, toolType: flat },
    { move: { kind: 'cut', from: pointOn(axis, 2, 45, 7.0), to: pointOn(axis, 28, 45, 7.6) }, toolRadius: 1.8, toolType: flat },
    { move: { kind: 'plunge', from: pointOn(axis, 15, 12, 9), to: pointOn(axis, 15, 12, 2.4) }, toolRadius: 1.4, toolType: flat },
    { move: { kind: 'cut', from: pointOn(axis, 8, 20, 5.2), to: pointOn(axis, 22, 20, 5.2) }, toolRadius: 1.3, toolType: flat },
    { move: { kind: 'cut', from: pointOn(axis, 8, 20, 4.5), to: pointOn(axis, 22, 20, 4.5) }, toolRadius: 1.3, toolType: flat },
    { move: { kind: 'cut', from: { ...pointOn(axis, 6, 20, 4.1), a: 20 }, to: { ...pointOn(axis, 25, 20, 3.8), a: 20 } }, toolRadius: 1.2, toolType: flat },
    { move: { kind: 'cut', from: pointOn(axis, 4, 0, 5.2), to: pointOn(axis, 26, 0, 4.4) }, toolRadius: 1.3, toolType: ball },
    { move: { kind: 'cut', from: pointOn(axis, 5, -40, 4.6), to: pointOn(axis, 24, -40, 4.6) }, toolRadius: 1.5, toolType: ball },
    { move: { kind: 'cut', from: pointOn(axis, 3, 45, 7.0), to: pointOn(axis, 27, 45, 7.6) }, toolRadius: 1.6, toolType: ball },
    { move: { kind: 'plunge', from: pointOn(axis, 18, -15, 9), to: pointOn(axis, 18, -15, 3.0) }, toolRadius: 1.5, toolType: ball },
    { move: { kind: 'cut', from: { ...pointOn(axis, 7, 25, 4.4), a: 25 }, to: { ...pointOn(axis, 23, -5, 3.9), a: 25 } }, toolRadius: 1.4, toolType: ball },
    { move: { kind: 'cut', from: pointOn(axis, 6, 14, 6.5), to: pointOn(axis, 22, 14, 0) }, toolRadius: 1.5, toolType: flat },
    { move: { kind: 'cut', from: pointOn(axis, 7, -11, 6.0), to: pointOn(axis, 21, -11, 0) }, toolRadius: 1.4, toolType: ball },
    { move: { kind: 'cut', from: pointOn(axis, 4, 8, 4.50), to: pointOn(axis, 26, 8, 4.49) }, toolRadius: 1.2, toolType: flat },
    { move: { kind: 'cut', from: pointOn(axis, 5, -33, 6.0), to: pointOn(axis, 24, -33, 1.2) }, toolRadius: 1.6, toolType: ball },
    { move: { kind: 'cut', from: pointOn(axis, 7, 18, 5.0), to: pointOn(axis, 23, 18, 3.6) }, toolRadius: 0.05, toolType: flat },
    { move: { kind: 'cut', from: pointOn(axis, 3.5, -52, 4.8), to: pointOn(axis, 26.5, -52, 4.0) }, toolRadius: 4.0, toolType: ball },
    { move: { kind: 'cut', from: pointOn(axis, 4, flatWindowDeg, 4.6), to: pointOn(axis, 26, flatWindowDeg, 3.0) }, toolRadius: 1.5, toolType: flat },
    { move: { kind: 'cut', from: pointOn(axis, 4.5, -ballWindowDeg, 5.0), to: pointOn(axis, 25.5, -ballWindowDeg, 3.2) }, toolRadius: 1.8, toolType: ball },
  ]
}

/**
 * SHA-256 over the raw float64 bits of every stored value, in a canonical
 * order: all `topZ` values by index, then every material cell by ascending
 * index with its interval endpoints. The digest is the pre-P1 kernel's, so a
 * single changed bit anywhere in the stored result fails the sweep.
 */
function digest(grid: SimulationGrid): string {
  const hash = createHash('sha256')
  const buffer = Buffer.alloc(8)
  hash.update(`top:${grid.topZ.length}`)
  for (let i = 0; i < grid.topZ.length; i += 1) {
    buffer.writeDoubleLE(grid.topZ[i])
    hash.update(buffer)
  }
  const map = grid.squareMaterial
  hash.update(`material:${map ? map.size : 0}`)
  if (!map) return hash.digest('hex')
  for (const key of [...map.keys()].sort((a, b) => a - b)) {
    const intervals = map.get(key)!
    hash.update(`k${key}:${intervals.length}`)
    for (const value of intervals) {
      buffer.writeDoubleLE(value)
      hash.update(buffer)
    }
  }
  return hash.digest('hex')
}

/**
 * The Codex two-cut regression: after the stationary r6 cut the cell keeps
 * `[0, 4.236314737894846]`; the following r2.4 move removes the rest. Fixed 96
 * stores the empty interval set and topZ 0, and any early stop leaves a
 * one-cell spike instead.
 */
function testCodexTwoCutCase(): void {
  console.log('Testing the Codex two-cut one-cell spike...')
  const stationary: ToolpathMove = {
    kind: 'cut',
    from: { x: 0.5, y: 0, z: 3.4963814291513753, a: 0 },
    to: { x: 0.5, y: 0, z: 3.4963814291513753, a: 0 },
  }
  const move: ToolpathMove = {
    kind: 'cut',
    from: { x: 0, y: 0, z: 4.6, a: 0 },
    to: { x: 2.9000000572999998, y: 0, z: 0, a: 0 },
  }
  const grid = makeCell(0.5, 3.6)
  applySquareMoveToGrid(grid, stationary, 6, 'flat_endmill')
  const afterFirst = grid.squareMaterial?.get(0)
  assert(afterFirst !== undefined, 'the stationary r6 cut must reach the cell')
  assert(
    afterFirst!.length === 2 && afterFirst![0] === 0 && afterFirst![1] === 4.236314737894846,
    `the stationary cut must leave [0, 4.236314737894846], got ${JSON.stringify(afterFirst)}`,
  )

  applySquareMoveToGrid(grid, move, 2.4, 'flat_endmill')
  const material = grid.squareMaterial?.get(0)
  assert(material !== undefined, 'the second cut must still write the cell')
  assert(
    material!.length === 0,
    `fixed 96 must remove the cell entirely, got ${JSON.stringify(material)} ` +
      '(an early stop leaves a [4.236314232713846, 4.236314737894846] spike)',
  )
  assert(grid.topZ[0] === 0, `fixed 96 must store topZ 0, got ${grid.topZ[0]}`)
  console.log('  empty interval set, topZ 0')
}

/**
 * The earlier one-cut case: side 12, one cell at along 0.5 whose ray is 0.6 rad
 * from the tool, flat r2.4, `(0, 4.6) → (2.9000000572999998, 0)`. Fixed 96
 * stores one surviving interval with these exact endpoints.
 */
function testOneCutCase(): void {
  console.log('Testing the one-cut fixed-96 interval...')
  const move: ToolpathMove = {
    kind: 'cut',
    from: { x: 0, y: 0, z: 4.6, a: 0 },
    to: { x: 2.9000000572999998, y: 0, z: 0, a: 0 },
  }
  const grid = makeCell(0.5, 3.6)
  applySquareMoveToGrid(grid, move, 2.4, 'flat_endmill')
  const material = grid.squareMaterial?.get(0)
  assert(material !== undefined, 'the one-cut case must reach the cell')
  assert(material!.length === 2, `expected one surviving interval, got ${JSON.stringify(material)}`)
  assert(material![0] === 4.236314233059706, `interval low differs: ${material![0]}`)
  assert(material![1] === 7.269769668579102, `interval high differs: ${material![1]}`)
  assert(grid.topZ[0] === 7.269769668579102, `topZ differs: ${grid.topZ[0]}`)
  console.log(`  ${JSON.stringify(material)}, topZ ${grid.topZ[0]}`)
}

/** The pre-P1 kernel's digest of the seeded sweep, per axis. */
const SEEDED_DIGEST: Readonly<Record<'x' | 'y', string>> = {
  x: '522653553c716ce5e6aabf7a4971effa3800c47013ff1f882090d4c833522be5',
  y: '7e58ceeaa68fcef93712d2e81c48c9278695c8958f4b51b79c61a9f134543886',
}

function testSeededSweepDigest(): void {
  console.log('Testing the seeded sweep against the pre-P1 digest...')
  for (const axis of ['x', 'y'] as const) {
    const grid = makeSheet(axis)
    for (const { move, toolRadius, toolType } of seededMoves(axis)) {
      applySquareMoveToGrid(grid, move, toolRadius, toolType)
    }
    const map = grid.squareMaterial
    assert(map !== undefined, `${axis}: the seeded moves must write real material`)
    assert(map!.size > 100, `${axis}: the seeded moves must cut real cells, got ${map!.size}`)
    let interiorBands = 0
    for (const intervals of map!.values()) if (intervals.length >= 4) interiorBands += 1
    assert(interiorBands > 0, `${axis}: the seeded moves must leave interior gaps, not just an outer shell`)

    const actual = digest(grid)
    assert(
      actual === SEEDED_DIGEST[axis],
      `${axis}: the stored result differs from the pre-P1 kernel (${actual} vs ${SEEDED_DIGEST[axis]})`,
    )
    console.log(`  ${axis}: ${map!.size} cells, digest ${actual}`)
  }
}

function main(): void {
  testCodexTwoCutCase()
  testOneCutCase()
  testSeededSweepDigest()
  console.log('square-material fixed-count parity: PASSED')
}

main()
