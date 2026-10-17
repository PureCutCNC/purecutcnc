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
 * as the bracket is below one Float32 ulp of the move parameter, because
 * another step cannot move a stored interval endpoint.
 *
 * This test replays a seeded, asymmetric move set through the kernel twice —
 * once with the pre-P1 fixed-96 search, once with the early exit — and requires
 * every stored interval endpoint to be equal after `Math.fround`, or to differ
 * by at most one Float32 ulp (one-ulp differences are counted and printed; zero
 * is the target). It also requires the early exit to actually be taken: the
 * legacy run must spend exactly 96 iterations per call, and the new run's mean
 * must be below the stated bounds below those counts.
 *
 * Mutations this was checked against, each applied on its own and reverted:
 * - tolerance 1000x looser → the endpoint equality assertion fails;
 * - early exit removed from `maximizeConcave` only → endpoints still agree, but
 *   the mean-iteration assertion fails;
 * - `bisectCrossing` returning the negative side → the endpoint equality
 *   assertion fails here and the physical assertions in `squareReplay.test.ts`.
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
    crossingsOnNegativeSide: 0,
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

/** One Float32 ulp of `value`'s magnitude, from the IEEE exponent. */
const ULP_VIEW = new DataView(new ArrayBuffer(4))
function ulp32(value: number): number {
  const magnitude = Math.abs(Math.fround(value))
  if (magnitude === 0) return 2 ** -149
  ULP_VIEW.setFloat32(0, magnitude)
  const exponent = (ULP_VIEW.getUint32(0) >>> 23) & 0xff
  if (exponent === 0) return 2 ** -149
  return 2 ** (exponent - 127 - 23)
}

interface DifferenceReport {
  compared: number
  froundEqual: number
  withinOneUlp: number
  endpointCompared: number
  endpointWithinOneUlp: number
  worstUlps: number
  worst: string
}

/**
 * Compare every stored interval endpoint and every stored top height after
 * Float32 rounding. Any pair that rounds to the same Float32 value is equal for
 * the renderer; a pair one ulp apart is reported and must be at most one.
 */
function compareRuns(legacy: RunResult, latest: RunResult): DifferenceReport {
  const report: DifferenceReport = {
    compared: 0, froundEqual: 0, withinOneUlp: 0,
    endpointCompared: 0, endpointWithinOneUlp: 0, worstUlps: 0, worst: '',
  }
  const keys = new Set([...legacy.material.keys(), ...latest.material.keys()])
  for (const key of [...keys].sort((a, b) => a - b)) {
    const before = legacy.material.get(key)
    const after = latest.material.get(key)
    assert(before !== undefined && after !== undefined, `cell ${key} must be stored in both runs`)
    assert(before!.length === after!.length, `cell ${key}: interval count ${before!.length} vs ${after!.length}`)
    for (let i = 0; i < before!.length; i += 1) {
      const a = Math.fround(before![i])
      const b = Math.fround(after![i])
      report.compared += 1
      report.endpointCompared += 1
      if (a === b) {
        report.froundEqual += 1
        continue
      }
      const scale = Math.max(Math.abs(a), Math.abs(b))
      const ulps = Math.abs(before![i] - after![i]) / ulp32(scale)
      if (ulps > report.worstUlps) {
        report.worstUlps = ulps
        report.worst = `cell ${key} endpoint ${i}: ${before![i]} vs ${after![i]} (${ulps.toFixed(3)} ulp)`
      }
      assert(ulps <= 1, `cell ${key} endpoint ${i} moved ${ulps.toFixed(3)} Float32 ulp: ${before![i]} vs ${after![i]}`)
      report.withinOneUlp += 1
      report.endpointWithinOneUlp += 1
    }
  }
  assert(legacy.topZ.length === latest.topZ.length, 'both runs share the grid shape')
  for (let i = 0; i < legacy.topZ.length; i += 1) {
    const a = Math.fround(legacy.topZ[i])
    const b = Math.fround(latest.topZ[i])
    report.compared += 1
    if (a === b) {
      report.froundEqual += 1
      continue
    }
    const scale = Math.max(Math.abs(a), Math.abs(b))
    const ulps = Math.abs(legacy.topZ[i] - latest.topZ[i]) / ulp32(scale)
    if (ulps > report.worstUlps) {
      report.worstUlps = ulps
      report.worst = `cell ${i} top: ${legacy.topZ[i]} vs ${latest.topZ[i]} (${ulps.toFixed(3)} ulp)`
    }
    assert(ulps <= 1, `cell ${i} top moved ${ulps.toFixed(3)} Float32 ulp: ${legacy.topZ[i]} vs ${latest.topZ[i]}`)
    report.withinOneUlp += 1
  }
  return report
}

function mean(stats: SearchIterationStats, calls: 'maximizeCalls' | 'bisectCalls', iterations: 'maximizeIterations' | 'bisectIterations'): number {
  assert(stats[calls] > 0, `${calls} must have run at least once`)
  return stats[iterations] / stats[calls]
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
      `${axis}: ${report.compared} stored values compared, ${report.froundEqual} equal after Math.fround, ` +
        `${report.withinOneUlp} within one ulp (${report.endpointWithinOneUlp} of ${report.endpointCompared} interval endpoints, ` +
        `worst ${report.worstUlps.toFixed(3)} ulp)` +
        (report.worst ? ` — ${report.worst}` : ''),
    )
    // At most one Float32 ulp is the contract; zero is the target and the
    // printed counts make a regression toward the tolerance visible.
    assert(
      report.worstUlps <= 1,
      `${axis}: ${report.withinOneUlp} stored values moved by up to ${report.worstUlps.toFixed(3)} Float32 ulp`,
    )
    assert(report.compared > 1000, `${axis}: the comparison must cover real endpoints, got ${report.compared}`)
  }
}

function testEarlyExitIsTaken(): void {
  console.log('Testing the early exit is actually taken and bounded...')
  // Derived from the tolerance: a unit bracket needs ~42 golden steps (0.618
  // shrink each) and ~29 bisections to reach one Float32 ulp over 64. The
  // seeded windows usually start narrower than one, so the measured means sit
  // below these ceiling figures; the bounds still fail the fixed 96 outright.
  const MAXIMIZE_MEAN_BOUND = 45
  const BISECT_MEAN_BOUND = 32
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
  testStoredMaterialDoesNotMove()
  testEarlyExitIsTaken()
  console.log('square-material convergence: PASSED')
}

main()
