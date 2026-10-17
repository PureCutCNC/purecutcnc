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
 * Early-stop convergence of the square-material searches (issue #1016 C2-P1).
 *
 * `maximizeConcave` (golden section) and `bisectCrossing` (bisection) used to
 * run a fixed 96 iterations for every cell of every move. They now stop as soon
 * as the bracket is below one Float32 ulp of the move parameter and — for a
 * crossing — the stored radial endpoint has stopped moving in value space. The
 * parameter alone is not enough: a tangential feasibility boundary changes the
 * endpoint like `√(s − s*)`, so a bracket far below one parameter ulp can still
 * move the stored material by a whole Float32 ulp and change the interval
 * topology. The Codex regression below is exactly that case.
 *
 * This test replays a seeded, asymmetric move set through the kernel twice —
 * once with the pre-P1 fixed-96 search, once with the early exit — and requires
 * every stored interval endpoint and every stored top to be equal after
 * `Math.fround`, with identical interval counts. It also requires the early
 * exit to actually be taken: the legacy run must spend exactly 96 iterations
 * per call, and the new run's mean must stay below the stated bounds.
 *
 * Mutations this was checked against, each applied on its own and reverted:
 * - revert the crossing stop to parameter-only tolerance → the Codex
 *   regression fails (an extra `[0, 1.1921845e-7]` interval appears);
 * - disable the early exit in `maximizeConcave` only → endpoints still agree,
 *   but the mean-iteration assertion fails;
 * - `bisectCrossing` returning the negative side → the non-negative-side
 *   invariant fails (15,356 crossings).
 * Loosening the parameter tolerance alone no longer fails: the stored-endpoint
 * check is what keeps the material stable, and the parameter only bounds the
 * remaining work.
 *
 * C2-P1F adds the crossing-determined band-high cases. A band's high can be the
 * wall reach at a domain end that a crossing fixes, so the flat crossing now
 * lists `reachAt` alongside `floorAt`; the ball's sphere and shank lists already
 * carry both of their stored values. `testCrossingDeterminedBandHighs` builds
 * one flat and one ball cell where that happens and compares them with
 * fixed-96. It also requires every configured endpoint list to be consulted
 * (`endpointChecks === 2 · endpointCalls`): dropping `reachAt` from the flat
 * list or `sphereHigh` from the sphere list lowers that count without changing
 * an iteration count or, in the sampled regimes, a stored value, which is why
 * the earlier seeded tests could not see the manager mutation.
 *
 * Run with: npx tsx src/engine/simulation/squareMaterialConvergence.test.ts
 */

import { applySquareMoveToGrid, squareSurfaceRadius } from './squareMaterial'
import type { SearchIterationStats, SquareSearchOptions } from './squareMaterial'
import type { SimulationGrid } from './types'
import type { AroundFrame } from '../aroundFrame'
import type { ToolpathMove } from '../toolpaths/types'
import type { ToolType } from '../../types/project'

const TWO_PI = Math.PI * 2
const SIDE = 12
const CIRCUMFERENCE = Math.PI * SIDE
const CELL_SIZE = 0.5
/** A grid spanning one nominal circumference across and 30 mm along the bar. */
const ALONG_LENGTH = 30

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

interface Sheet {
  grid: SimulationGrid
}

/** The production square sheet: pivot at the true centre, one-radius thickness. */
function makeSheet(axis: 'x' | 'y'): Sheet {
  const frame: AroundFrame = {
    axis,
    centre: 0,
    radius: SIDE / 2,
    zero: 0,
    sheetStart: -CIRCUMFERENCE / 2,
    circumference: CIRCUMFERENCE,
  }
  const alongMin = 0
  const alongMax = ALONG_LENGTH
  const xMin = axis === 'x' ? alongMin : -CIRCUMFERENCE / 2
  const xMax = axis === 'x' ? alongMax : CIRCUMFERENCE / 2
  const yMin = axis === 'x' ? -CIRCUMFERENCE / 2 : alongMin
  const yMax = axis === 'x' ? CIRCUMFERENCE / 2 : alongMax
  const cols = Math.round((xMax - xMin) / CELL_SIZE)
  const rows = Math.round((yMax - yMin) / CELL_SIZE)
  const topZ = new Float32Array(cols * rows)
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const across = axis === 'x' ? yMin + (row + 0.5) * CELL_SIZE : xMin + (col + 0.5) * CELL_SIZE
      topZ[row * cols + col] = squareSurfaceRadius(SIDE, (across - frame.zero) * TWO_PI / CIRCUMFERENCE)
    }
  }
  const grid: SimulationGrid = {
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
  return { grid }
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

/** One unrolled-sheet point at `along` and `angleDeg` on the nominal cylinder. */
function sheetPoint(along: number, angleDeg: number): { x: number; y: number } {
  const across = angleDeg * CIRCUMFERENCE / 360
  return { x: along, y: across }
}

function pointOn(axis: 'x' | 'y', along: number, angleDeg: number, z: number): { x: number; y: number; z: number } {
  const point = sheetPoint(along, angleDeg)
  return axis === 'x' ? { x: point.x, y: point.y, z } : { x: point.y, y: point.x, z }
}

interface SeededMove {
  label: string
  move: ToolpathMove
  toolRadius: number
  toolType: ToolType
}

/**
 * A deterministic, asymmetric move set: flat and ball, axial and oblique, both
 * rotation senses, stepped passes, plunges, the explicit-rotary-angle branch,
 * and passes that reach only the corner envelope (tip above the flat radius,
 * below the corner radius).
 */
function seededMoves(axis: 'x' | 'y'): SeededMove[] {
  const flat = 'flat_endmill' as const
  const ball = 'ball_endmill' as const
  // The exact angle-window edges for the two edge-ray moves below:
  // |θ| ≤ atan(rt / tipMin), expressed in the sheet's degrees.
  const flatWindowDeg = Math.atan(1.5 / 3.0) * 180 / Math.PI
  const ballWindowDeg = Math.atan(1.8 / 3.2) * 180 / Math.PI
  const moves: SeededMove[] = [
    {
      label: 'flat axial pass',
      move: { kind: 'cut', from: pointOn(axis, 4, 0, 5), to: pointOn(axis, 26, 0, 5) },
      toolRadius: 1.5,
      toolType: flat,
    },
    {
      label: 'flat oblique stepped pass',
      move: { kind: 'cut', from: pointOn(axis, 5, 9, 4.6), to: pointOn(axis, 24, 9, 4.0) },
      toolRadius: 1.2,
      toolType: flat,
    },
    {
      label: 'flat oblique 31 degrees',
      move: { kind: 'cut', from: pointOn(axis, 3, 31, 4.2), to: pointOn(axis, 27, 31, 4.2) },
      toolRadius: 1.6,
      toolType: flat,
    },
    {
      label: 'flat opposite rotation sense',
      move: { kind: 'cut', from: pointOn(axis, 6, -24, 3.8), to: pointOn(axis, 25, -24, 3.4) },
      toolRadius: 1.4,
      toolType: flat,
    },
    {
      label: 'flat corner-envelope-only pass',
      move: { kind: 'cut', from: pointOn(axis, 2, 45, 7.0), to: pointOn(axis, 28, 45, 7.6) },
      toolRadius: 1.8,
      toolType: flat,
    },
    {
      label: 'flat radial plunge',
      move: { kind: 'plunge', from: pointOn(axis, 15, 12, 9), to: pointOn(axis, 15, 12, 2.4) },
      toolRadius: 1.4,
      toolType: flat,
    },
    {
      label: 'flat stepped pass A',
      move: { kind: 'cut', from: pointOn(axis, 8, 20, 5.2), to: pointOn(axis, 22, 20, 5.2) },
      toolRadius: 1.3,
      toolType: flat,
    },
    {
      label: 'flat stepped pass B',
      move: { kind: 'cut', from: pointOn(axis, 8, 20, 4.5), to: pointOn(axis, 22, 20, 4.5) },
      toolRadius: 1.3,
      toolType: flat,
    },
    {
      label: 'flat explicit rotary angle',
      move: {
        kind: 'cut',
        from: { ...pointOn(axis, 6, 20, 4.1), a: 20 },
        to: { ...pointOn(axis, 25, 20, 3.8), a: 20 },
      },
      toolRadius: 1.2,
      toolType: flat,
    },
    {
      label: 'ball axial pass',
      move: { kind: 'cut', from: pointOn(axis, 4, 0, 5.2), to: pointOn(axis, 26, 0, 4.4) },
      toolRadius: 1.3,
      toolType: ball,
    },
    {
      label: 'ball oblique opposite sense',
      move: { kind: 'cut', from: pointOn(axis, 5, -40, 4.6), to: pointOn(axis, 24, -40, 4.6) },
      toolRadius: 1.5,
      toolType: ball,
    },
    {
      label: 'ball corner-envelope-only pass',
      move: { kind: 'cut', from: pointOn(axis, 3, 45, 7.0), to: pointOn(axis, 27, 45, 7.6) },
      toolRadius: 1.6,
      toolType: ball,
    },
    {
      label: 'ball radial plunge',
      move: { kind: 'plunge', from: pointOn(axis, 18, -15, 9), to: pointOn(axis, 18, -15, 3.0) },
      toolRadius: 1.5,
      toolType: ball,
    },
    {
      label: 'ball explicit rotary angle with changing across',
      move: {
        kind: 'cut',
        from: { ...pointOn(axis, 7, 25, 4.4), a: 25 },
        to: { ...pointOn(axis, 23, -5, 3.9), a: 25 },
      },
      toolRadius: 1.4,
      toolType: ball,
    },
    {
      label: 'flat near-axis tip to zero',
      move: { kind: 'cut', from: pointOn(axis, 6, 14, 6.5), to: pointOn(axis, 22, 14, 0) },
      toolRadius: 1.5,
      toolType: flat,
    },
    {
      label: 'ball near-axis tip to zero',
      move: { kind: 'cut', from: pointOn(axis, 7, -11, 6.0), to: pointOn(axis, 21, -11, 0) },
      toolRadius: 1.4,
      toolType: ball,
    },
    {
      label: 'flat shallow tip slope',
      move: { kind: 'cut', from: pointOn(axis, 4, 8, 4.50), to: pointOn(axis, 26, 8, 4.49) },
      toolRadius: 1.2,
      toolType: flat,
    },
    {
      label: 'ball steep tip slope',
      move: { kind: 'cut', from: pointOn(axis, 5, -33, 6.0), to: pointOn(axis, 24, -33, 1.2) },
      toolRadius: 1.6,
      toolType: ball,
    },
    {
      label: 'flat tiny tool radius',
      move: { kind: 'cut', from: pointOn(axis, 7, 18, 5.0), to: pointOn(axis, 23, 18, 3.6) },
      toolRadius: 0.05,
      toolType: flat,
    },
    {
      label: 'ball large tool radius',
      move: { kind: 'cut', from: pointOn(axis, 3.5, -52, 4.8), to: pointOn(axis, 26.5, -52, 4.0) },
      toolRadius: 4.0,
      toolType: ball,
    },
    {
      label: 'flat ray on the angle-window edge',
      move: { kind: 'cut', from: pointOn(axis, 4, flatWindowDeg, 4.6), to: pointOn(axis, 26, flatWindowDeg, 3.0) },
      toolRadius: 1.5,
      toolType: flat,
    },
    {
      label: 'ball ray on the angle-window edge',
      move: { kind: 'cut', from: pointOn(axis, 4.5, -ballWindowDeg, 5.0), to: pointOn(axis, 25.5, -ballWindowDeg, 3.2) },
      toolRadius: 1.8,
      toolType: ball,
    },
  ]
  return moves
}

interface RunResult {
  material: Map<number, readonly number[]>
  topZ: Float32Array
  stats: SearchIterationStats
}

function emptyStats(): SearchIterationStats {
  return {
    maximizeCalls: 0, maximizeIterations: 0, bisectCalls: 0, bisectIterations: 0,
    crossingsOnNegativeSide: 0, endpointChecks: 0, endpointCalls: 0,
  }
}

/** Replay the whole seeded move set through one kernel mode. */
function runMoves(axis: 'x' | 'y', legacy: boolean): RunResult {
  const { grid } = makeSheet(axis)
  const stats = emptyStats()
  const options: SquareSearchOptions = { legacyFixedSearch: legacy, searchIterations: stats }
  for (const { move, toolRadius, toolType } of seededMoves(axis)) {
    applySquareMoveToGrid(grid, move, toolRadius, toolType, options)
  }
  if (grid.squareMaterial === undefined) throw new Error('the seeded moves must record square material')
  return { material: grid.squareMaterial, topZ: grid.topZ, stats }
}

interface DifferenceReport {
  compared: number
  endpointCompared: number
  intervalCounts: number
  worst: string
}

/**
 * Compare every stored interval endpoint and every stored top height after
 * Float32 rounding. A pair that rounds to the same Float32 value is identical
 * to the stored grid; a pair that does not is a regression, not a tolerated
 * one-ulp difference. Interval counts must match cell for cell: that is the
 * interval topology, and a single split is exactly the Codex sliver.
 */
function compareRuns(legacy: RunResult, latest: RunResult): DifferenceReport {
  const report: DifferenceReport = {
    compared: 0, endpointCompared: 0, intervalCounts: 0, worst: '',
  }
  const keys = new Set([...legacy.material.keys(), ...latest.material.keys()])
  for (const key of [...keys].sort((a, b) => a - b)) {
    const before = legacy.material.get(key)
    const after = latest.material.get(key)
    assert(before !== undefined && after !== undefined, `cell ${key} must be stored in both runs`)
    assert(
      before!.length === after!.length,
      `cell ${key}: interval count ${before!.length / 2} vs ${after!.length / 2} ` +
        `(${JSON.stringify(before)} vs ${JSON.stringify(after)})`,
    )
    report.intervalCounts += 1
    for (let i = 0; i < before!.length; i += 1) {
      const a = Math.fround(before![i])
      const b = Math.fround(after![i])
      report.compared += 1
      report.endpointCompared += 1
      if (a !== b) report.worst = report.worst || `cell ${key} endpoint ${i}: ${before![i]} vs ${after![i]}`
      assert(a === b, `cell ${key} endpoint ${i} differs after Math.fround: ${before![i]} vs ${after![i]}`)
    }
  }
  assert(legacy.topZ.length === latest.topZ.length, 'both runs share the grid shape')
  for (let i = 0; i < legacy.topZ.length; i += 1) {
    const a = Math.fround(legacy.topZ[i])
    const b = Math.fround(latest.topZ[i])
    report.compared += 1
    if (a !== b) report.worst = report.worst || `cell ${i} top: ${legacy.topZ[i]} vs ${latest.topZ[i]}`
    assert(a === b, `cell ${i} top differs after Math.fround: ${legacy.topZ[i]} vs ${latest.topZ[i]}`)
  }
  return report
}

function mean(stats: SearchIterationStats, calls: 'maximizeCalls' | 'bisectCalls', iterations: 'maximizeIterations' | 'bisectIterations'): number {
  assert(stats[calls] > 0, `${calls} must have run at least once`)
  return stats[iterations] / stats[calls]
}

/**
 * The Codex reproduction, pinned to one cell: side 12, cell along 0.5, the
 * cell's ray 0.6 rad from the tool, flat endmill radius 2.4, constant A=0, and
 * a `(0, 4.6)` → `(2.9000000572999998, 0)` move. Fixed-96 stores one surviving
 * interval; the parameter-only early stop left an extra `[0, 1.1921845e-7]`
 * one because the crossing's radial endpoint moved across the compaction
 * threshold. The regression is the interval count and the stored endpoints.
 */
function testCodexRadialRegression(): void {
  console.log('Testing the Codex side-12 radial-endpoint regression...')
  const move: ToolpathMove = {
    kind: 'cut',
    from: { x: 0, y: 0, z: 4.6, a: 0 },
    to: { x: 2.9000000572999998, y: 0, z: 0, a: 0 },
  }
  const legacyGrid = makeCell(0.5, 3.6)
  const latestGrid = makeCell(0.5, 3.6)
  applySquareMoveToGrid(legacyGrid, move, 2.4, 'flat_endmill', { legacyFixedSearch: true })
  applySquareMoveToGrid(latestGrid, move, 2.4, 'flat_endmill')
  const legacy = legacyGrid.squareMaterial?.get(0)
  const latest = latestGrid.squareMaterial?.get(0)
  if (legacy === undefined || latest === undefined) throw new Error('assertion failed: the Codex move must cut the cell')
  assert(
    legacy.length === 2,
    `fixed-96 must store one surviving interval, got ${JSON.stringify(legacy)}`,
  )
  assert(
    latest.length === legacy.length,
    `the early exit must keep the fixed-96 interval count: ${JSON.stringify(latest)} vs ${JSON.stringify(legacy)}`,
  )
  for (let i = 0; i < legacy.length; i += 1) {
    assert(
      Math.fround(latest[i]) === Math.fround(legacy[i]),
      `endpoint ${i} differs after Math.fround: ${latest[i]} vs ${legacy[i]}`,
    )
  }
  console.log(`  fixed 96 ${JSON.stringify(legacy)}; early exit ${JSON.stringify(latest)}`)
}

/** Replay one cell through one search mode, keeping the iteration accounting. */
function runCell(
  along: number,
  across: number,
  move: ToolpathMove,
  toolRadius: number,
  toolType: ToolType,
  legacy: boolean,
): RunResult {
  const grid = makeCell(along, across)
  const stats = emptyStats()
  applySquareMoveToGrid(grid, move, toolRadius, toolType, {
    ...(legacy ? { legacyFixedSearch: true } : {}),
    searchIterations: stats,
  })
  if (grid.squareMaterial === undefined) throw new Error('assertion failed: the probe move must cut the cell')
  return { material: grid.squareMaterial, topZ: grid.topZ, stats }
}

/** The non-negative side of the last sign change of a decreasing-then-crossing function. */
function bisectProbe(evaluate: (s: number) => number, lo: number, hi: number): number {
  assert(evaluate(lo) >= 0 && evaluate(hi) < 0, 'the probe needs one crossing, non-negative on the left')
  let a = lo
  let b = hi
  for (let i = 0; i < 200; i += 1) {
    const mid = (a + b) / 2
    if (mid === a || mid === b) break
    if (evaluate(mid) >= 0) a = mid
    else b = mid
  }
  return a
}

/**
 * The C2-P1F follow-through: a band's high can be attained at a domain end
 * that a crossing determines, not only at a fixed move end or an interior
 * maximum. Both cases below are built so the removed band's high is exactly the
 * wall reach at a sign change:
 *
 *   - flat: `floor = tip/cos` rises faster than the wall reach, so the feasible
 *     domain is `[0, cross]`, the reach increases across it, and
 *     `maximizeConcave(reachAt)` returns `reachAt(cross)`;
 *   - ball: the shank's `inner = (tip+rt)/cos` overtakes the reach at a crossing
 *     inside the move, the reach increases up to it, so the band high is again
 *     `reachAt(cross)`; a sphere discriminant crossing is present as well, so
 *     the sphere's endpoint list is exercised by the same cell.
 *
 * The stored values must match fixed-96 after `Math.fround`. The iteration
 * accounting then proves the crossing actually consulted both ends of every
 * configured endpoint list: dropping `reachAt` from the flat list or
 * `sphereHigh` from the sphere list lowers `endpointChecks` while leaving every
 * iteration count unchanged, so this is the assertion that sees it.
 */
function testCrossingDeterminedBandHighs(): void {
  console.log('Testing band highs attained at crossing-determined domain ends...')

  // flat: side 12, cell at x 0.5, ray 0.5 rad from the tool, flat radius 1,
  // tip 1.5 → 2.0 over x 0 → 0.4.
  const flat: ToolpathMove = {
    kind: 'cut',
    from: { x: 0, y: 3.0, z: 1.5, a: 0 },
    to: { x: 0.4, y: 3.0, z: 2.0, a: 0 },
  }
  const flatCos = Math.cos(0.5)
  const flatSin = Math.sin(0.5)
  const flatDx = (s: number): number => 0.5 - 0.4 * s
  const flatReach = (s: number): number => Math.sqrt(Math.max(0, 1 - flatDx(s) ** 2)) / flatSin
  const flatFloor = (s: number): number => (1.5 + 0.5 * s) / flatCos
  const flatCross = bisectProbe((s) => flatReach(s) - flatFloor(s), 0, 1)
  assert(
    flatCross > 0 && flatCross < 1,
    `flat: the feasible domain must end at an interior crossing, got ${flatCross}`,
  )
  assert(
    flatReach(flatCross) > flatReach(0),
    'flat: the reach must increase up to the crossing so its maximum sits there',
  )

  const flatLegacy = runCell(0.5, 3.0, flat, 1, 'flat_endmill', true)
  const flatLatest = runCell(0.5, 3.0, flat, 1, 'flat_endmill', false)
  compareRuns(flatLegacy, flatLatest)
  const flatIntervals = flatLatest.material.get(0)!
  assert(flatIntervals.length === 4, `flat: expected one removed band, got ${JSON.stringify(flatIntervals)}`)
  assert(
    Math.abs(flatIntervals[2] - flatReach(flatCross)) < 1e-6,
    `flat: the band high ${flatIntervals[2]} is not the reach at the crossing ${flatReach(flatCross)}`,
  )
  assert(
    Math.abs(flatIntervals[1] - flatFloor(0)) < 1e-6,
    `flat: the band low ${flatIntervals[1]} is not the floor at the fixed end ${flatFloor(0)}`,
  )
  assert(flatLatest.stats.endpointCalls > 0, 'flat: the crossing must reach the stored-endpoint comparison')
  assert(
    flatLatest.stats.endpointChecks === 2 * flatLatest.stats.endpointCalls,
    `flat: both stored endpoints must be compared at every crossing ` +
      `(${flatLatest.stats.endpointChecks} checks over ${flatLatest.stats.endpointCalls} calls)`,
  )
  console.log(
    `  flat: crossing ${flatCross.toFixed(6)}, band high ${flatIntervals[2].toFixed(6)} ` +
      `(reach there), ${flatLatest.stats.endpointChecks} endpoint checks`,
  )

  // ball: side 12, one cell at x -0.1503, radius 0.5777, tip 0.3164 → 2.8361
  // over x 0.0516 → -0.1664 (a seeded search result). The shank crossing is the
  // band high; the sphere discriminant crosses too, so both ball endpoint lists
  // are exercised by this cell.
  const ballTheta = 0.179521833525135
  const ballRadius = 0.5776574408635498
  const ballTipFrom = 0.31633938564918934
  const ballTipTo = 2.83612400800921
  const ballAlongDelta = -0.21795972646214068
  const ballFromAlong = 0.05160518130287528
  const ballAlong = -0.15031835686075554
  const ballAcross = ballTheta * 6
  const ball: ToolpathMove = {
    kind: 'cut',
    from: { x: ballFromAlong, y: ballAcross, z: ballTipFrom, a: 0 },
    to: { x: ballFromAlong + ballAlongDelta, y: ballAcross, z: ballTipTo, a: 0 },
  }
  const ballCos = Math.cos(ballTheta)
  const ballSin = Math.sin(ballTheta)
  const ballDx = (s: number): number => ballAlong - ballFromAlong - ballAlongDelta * s
  const ballCentre = (s: number): number => ballTipFrom + (ballTipTo - ballTipFrom) * s + ballRadius
  const ballReach = (s: number): number =>
    Math.sqrt(Math.max(0, ballRadius ** 2 - ballDx(s) ** 2)) / ballSin
  const ballInner = (s: number): number => ballCentre(s) / ballCos
  const ballDisc = (s: number): number =>
    ballRadius ** 2 - ballCentre(s) ** 2 * ballSin ** 2 - ballDx(s) ** 2
  const shankCross = bisectProbe((s) => ballReach(s) - ballInner(s), 0, 1)
  assert(
    shankCross > 0 && shankCross < 1,
    `ball: the shank domain must end at an interior crossing, got ${shankCross}`,
  )
  assert(
    ballReach(shankCross) > ballReach(0),
    'ball: the shank reach must increase up to the crossing so its maximum sits there',
  )
  assert(
    ballDisc(0) > 0 && ballDisc(1) < 0,
    'ball: the sphere discriminant must also cross inside the move',
  )

  const ballLegacy = runCell(ballAlong, ballAcross, ball, ballRadius, 'ball_endmill', true)
  const ballLatest = runCell(ballAlong, ballAcross, ball, ballRadius, 'ball_endmill', false)
  compareRuns(ballLegacy, ballLatest)
  const ballIntervals = ballLatest.material.get(0)!
  assert(ballIntervals.length === 4, `ball: expected one removed band, got ${JSON.stringify(ballIntervals)}`)
  assert(
    Math.abs(ballIntervals[2] - ballReach(shankCross)) < 1e-6,
    `ball: the band high ${ballIntervals[2]} is not the shank reach at the crossing ${ballReach(shankCross)}`,
  )
  assert(ballLatest.stats.endpointCalls > 0, 'ball: the crossings must reach the stored-endpoint comparison')
  assert(
    ballLatest.stats.endpointChecks === 2 * ballLatest.stats.endpointCalls,
    `ball: both stored endpoints must be compared at every crossing ` +
      `(${ballLatest.stats.endpointChecks} checks over ${ballLatest.stats.endpointCalls} calls)`,
  )
  console.log(
    `  ball: shank crossing ${shankCross.toFixed(6)}, band high ${ballIntervals[2].toFixed(6)} ` +
      `(reach there), ${ballLatest.stats.endpointChecks} endpoint checks`,
  )
}

function testStoredMaterialDoesNotMove(): void {
  console.log('Testing the early-exit search stores the same square material as fixed 96...')
  for (const axis of ['x', 'y'] as const) {
    const legacy = runMoves(axis, true)
    const latest = runMoves(axis, false)

    // The seeded set must actually cut: an empty map would pass every equality.
    assert(legacy.material.size > 100, `${axis}: the seeded moves must write real material, got ${legacy.material.size} cells`)
    let interiorBands = 0
    for (const intervals of legacy.material.values()) if (intervals.length >= 4) interiorBands += 1
    assert(interiorBands > 0, `${axis}: the seeded moves must leave interior gaps, not just an outer shell`)

    const report = compareRuns(legacy, latest)
    console.log(
      `${axis}: ${report.compared} stored values compared, all equal after Math.fround; ` +
        `${report.intervalCounts} cells with identical interval counts ` +
        `(${report.endpointCompared} interval endpoints)` +
        (report.worst ? ` — first difference: ${report.worst}` : ''),
    )
    assert(report.compared > 1000, `${axis}: the comparison must cover real endpoints, got ${report.compared}`)
  }
}

function testEarlyExitIsTaken(): void {
  console.log('Testing the early exit is actually taken and bounded...')
  // Derived from the tolerances: a unit bracket needs ~42 golden steps (0.618
  // shrink each) and ~29 bisections just to reach the parameter tolerance; the
  // tangential crossings add a few more until the stored endpoint rounds to one
  // Float32 value. The seeded windows usually start narrower than one, so the
  // measured means sit below these ceiling figures; the bounds still fail the
  // fixed 96 outright and they are tight enough to catch a regression that
  // removes either half of the stop rule.
  const MAXIMIZE_MEAN_BOUND = 45
  const BISECT_MEAN_BOUND = 40
  for (const axis of ['x', 'y'] as const) {
    const legacy = runMoves(axis, true)
    const latest = runMoves(axis, false)

    // The legacy mode must be the pre-P1 search, exactly: every call spends its
    // full budget. If the option stops reaching the loops, this fails first.
    assert(
      legacy.stats.maximizeIterations === 96 * legacy.stats.maximizeCalls,
      `${axis}: the legacy golden-section search must spend 96 iterations per call ` +
        `(${legacy.stats.maximizeIterations} / ${legacy.stats.maximizeCalls})`,
    )
    assert(
      legacy.stats.bisectIterations === 96 * legacy.stats.bisectCalls,
      `${axis}: the legacy bisection must spend 96 iterations per call ` +
        `(${legacy.stats.bisectIterations} / ${legacy.stats.bisectCalls})`,
    )

    const maximizeMean = mean(latest.stats, 'maximizeCalls', 'maximizeIterations')
    const bisectMean = mean(latest.stats, 'bisectCalls', 'bisectIterations')
    console.log(
      `${axis}: maximize ${maximizeMean.toFixed(2)} iterations/call (legacy 96, bound ${MAXIMIZE_MEAN_BOUND}); ` +
        `bisect ${bisectMean.toFixed(2)} iterations/call (legacy 96, bound ${BISECT_MEAN_BOUND})`,
    )
    assert(
      maximizeMean <= MAXIMIZE_MEAN_BOUND,
      `${axis}: mean golden-section iterations ${maximizeMean.toFixed(2)} exceed the early-exit bound ${MAXIMIZE_MEAN_BOUND}`,
    )
    assert(
      bisectMean <= BISECT_MEAN_BOUND,
      `${axis}: mean bisection iterations ${bisectMean.toFixed(2)} exceed the early-exit bound ${BISECT_MEAN_BOUND}`,
    )
    assert(
      latest.stats.maximizeIterations < legacy.stats.maximizeIterations,
      `${axis}: the early exit must do less golden-section work than the fixed count`,
    )
    assert(
      latest.stats.bisectIterations < legacy.stats.bisectIterations,
      `${axis}: the early exit must do less bisection work than the fixed count`,
    )
    // The early exit returns the last known non-negative point, never the
    // infeasible side. At this tolerance an off-by-one-side crossing moves a
    // stored value by thousandths of an ulp, so only this invariant sees it.
    assert(
      legacy.stats.crossingsOnNegativeSide === 0,
      `${axis}: the legacy search must return the non-negative side (${legacy.stats.crossingsOnNegativeSide} did not)`,
    )
    assert(
      latest.stats.crossingsOnNegativeSide === 0,
      `${axis}: the early exit must return the non-negative side (${latest.stats.crossingsOnNegativeSide} did not)`,
    )
  }
}

function main(): void {
  testCodexRadialRegression()
  testCrossingDeterminedBandHighs()
  testStoredMaterialDoesNotMove()
  testEarlyExitIsTaken()
  console.log('square-material convergence: PASSED')
}

main()
