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
 * Direct regression coverage for the shared partial-run arc search.
 *
 * Run with: npx tsx src/engine/toolpaths/arcReconstruction.test.ts
 */

import { findArcRunsInPoints } from './arcReconstruction'
import type { PartialArcFitOptions } from './arcReconstruction'
import type { Point } from '../../types/project'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approxEq(actual: number, expected: number, tolerance = 1e-6): boolean {
  return Math.abs(actual - expected) <= tolerance
}

function sampledArc(
  radius: number,
  startAngle: number,
  endAngle: number,
  segments: number,
): Point[] {
  const points: Point[] = []
  for (let i = 0; i <= segments; i += 1) {
    const angle = startAngle + ((endAngle - startAngle) * i) / segments
    points.push({ x: radius * Math.cos(angle), y: radius * Math.sin(angle) })
  }
  return points
}

const FIT_OPTIONS: PartialArcFitOptions = {
  minArcPoints: 4,
  maxResidual: 1e-6,
  maxSegmentAngleDeg: 90,
  minChordRatio: 0.15,
  minTotalSweepRad: Math.PI / 180,
  maxAngularStepRatio: 4,
}

const EDITOR_FIT_OPTIONS: PartialArcFitOptions = {
  minArcPoints: 7,
  maxResidual: 0,
  radiusToleranceFraction: 0.01,
  maxSegmentAngleDeg: 20,
  minChordRatio: 0.15,
  sourceCenters: [{ x: 0, y: 0 }],
}

function testFindsLongestValidArcRun(): void {
  console.log('Testing longest valid arc run...')

  const points = [
    ...sampledArc(10, 0, Math.PI / 2, 12),
    { x: 0, y: 11 },
    { x: 1, y: 12 },
    { x: 2, y: 11 },
  ]
  const runs = findArcRunsInPoints(points, FIT_OPTIONS)

  assert(runs.length === 1, `expected one arc run, got ${runs.length}`)
  const run = runs[0]
  assert(run.startIndex === 0, `expected start index 0, got ${run.startIndex}`)
  assert(run.endIndex === 12, `expected longest valid end index 12, got ${run.endIndex}`)
  assert(approxEq(run.center.x, 0), `expected center.x 0, got ${run.center.x}`)
  assert(approxEq(run.center.y, 0), `expected center.y 0, got ${run.center.y}`)
  assert(approxEq(run.radius, 10), `expected radius 10, got ${run.radius}`)
  assert(run.clockwise === false, 'expected counter-clockwise arc')
}

function testDetectsClockwiseArcRun(): void {
  console.log('Testing clockwise arc run...')

  const runs = findArcRunsInPoints(sampledArc(10, Math.PI / 2, 0, 12), FIT_OPTIONS)

  assert(runs.length === 1, `expected one arc run, got ${runs.length}`)
  assert(runs[0].clockwise === true, 'expected clockwise arc')
}

function testSplitsLargeCircularRunWithoutChangingItsCircle(): void {
  console.log('Testing large circular run splits on the same circle...')

  const points = sampledArc(10, 0, Math.PI * 2, 360)
  const runs = findArcRunsInPoints(points, FIT_OPTIONS)

  assert(runs.length === 3, `expected 3 bounded runs, got ${runs.length}`)
  let expectedStartIndex = 0
  for (const run of runs) {
    assert(run.startIndex === expectedStartIndex,
      `expected run start ${expectedStartIndex}, got ${run.startIndex}`)
    assert(run.endIndex - run.startIndex + 1 <= 128,
      `run spans more than 128 points (${run.endIndex - run.startIndex + 1})`)
    assert(approxEq(run.center.x, 0), `expected center.x 0, got ${run.center.x}`)
    assert(approxEq(run.center.y, 0), `expected center.y 0, got ${run.center.y}`)
    assert(approxEq(run.radius, 10), `expected radius 10, got ${run.radius}`)
    assert(run.clockwise === false, 'expected counter-clockwise arc')
    expectedStartIndex = run.endIndex
  }
  assert(expectedStartIndex === points.length - 1,
    `expected runs to reach final point ${points.length - 1}, got ${expectedStartIndex}`)
}

function testUsesEditorRadiusRelativeValidation(): void {
  console.log('Testing editor radius-relative validation...')

  const runs = findArcRunsInPoints(sampledArc(10, 0, Math.PI / 2, 18), EDITOR_FIT_OPTIONS)

  assert(runs.length === 1, `expected one editor arc run, got ${runs.length}`)
  assert(approxEq(runs[0].center.x, 0), `expected center.x 0, got ${runs[0].center.x}`)
  assert(approxEq(runs[0].center.y, 0), `expected center.y 0, got ${runs[0].center.y}`)
  assert(approxEq(runs[0].radius, 10), `expected radius 10, got ${runs[0].radius}`)
}

function testMinimumRunCanExceedDefaultCandidateWindow(): void {
  console.log('Testing minimum run above the default candidate window...')

  const points = sampledArc(10, 0, Math.PI, 128)
  const runs = findArcRunsInPoints(points, { ...FIT_OPTIONS, minArcPoints: points.length })

  assert(runs.length === 1, `expected one minimum-sized arc run, got ${runs.length}`)
  assert(runs[0].startIndex === 0, `expected start index 0, got ${runs[0].startIndex}`)
  assert(runs[0].endIndex === points.length - 1,
    `expected end index ${points.length - 1}, got ${runs[0].endIndex}`)
}

function nonFittingPoints(count: number): Point[] {
  return Array.from({ length: count }, (_, index) => ({
    x: index,
    y: index % 2 === 0 ? 0 : 10,
  }))
}

function measureNonFittingSearch(count: number): { runs: number; elapsedMs: number } {
  const startedAt = performance.now()
  const runs = findArcRunsInPoints(nonFittingPoints(count), FIT_OPTIONS)
  return { runs: runs.length, elapsedMs: performance.now() - startedAt }
}

/**
 * Lowest CPU time, in ms, across `reps` searches over the same input.
 *
 * Measures CPU time (`process.cpuUsage`) rather than wall clock, because
 * `scripts/run-tests.ts` executes test files in a parallel pool. Wall clock
 * counts time this process spends descheduled while sibling test files run,
 * and it does so unevenly: the larger input runs longer, so it is exposed to
 * more of that interference, which systematically inflates the ratio below.
 * CPU time excludes descheduled time and is stable under load. Measured on an
 * 8-core-saturated machine:
 *
 *   wall-clock ratio   2.18 .. 3.23   (and 4.7 observed in a real suite run)
 *   CPU-time ratio     2.20 .. 2.35
 *
 * Minimum rather than mean, since contention can only ever add cost. Points
 * are built once so allocation stays outside the measured region.
 */
function bestNonFittingCpuMs(count: number, reps = 3): number {
  const points = nonFittingPoints(count)
  let best = Infinity
  for (let rep = 0; rep < reps; rep += 1) {
    const before = process.cpuUsage()
    findArcRunsInPoints(points, FIT_OPTIONS)
    const delta = process.cpuUsage(before)
    best = Math.min(best, (delta.user + delta.system) / 1000)
  }
  return best
}

function testBoundsLargeNonFittingSearch(): void {
  console.log('Testing bounded large non-fitting search...')

  // Alternating points cannot fit a circle under the strict residual gate, so
  // every start position runs the full candidate scan — the worst case.
  const result = measureNonFittingSearch(1200)
  assert(result.runs === 0, `expected no arc runs, got ${result.runs}`)

  // Assert the SHAPE of the cost curve, not a wall-clock budget. The bounded
  // window makes the search linear in the input, so doubling the points roughly
  // doubles the cost; the old unbounded search was cubic. Measured here:
  //
  //   window 128 (current)  400->800 pts    2.2x   pass
  //   window 512            400->800 pts    5.5x   fail
  //   unbounded             400->800 pts    7.7x   fail
  //
  // The point of a ratio is ROBUSTNESS, not extra sensitivity. An absolute
  // budget cannot tell "the algorithm regressed" from "the machine is busy":
  // the previous `< 750ms` assertion measured 119ms idle but 889ms under
  // parallel suite load, and failed a build on unchanged code.
  //
  // Tradeoff, stated honestly: a ratio is BLIND to a uniform constant-factor
  // slowdown, which an absolute budget would catch. That is an accepted gap —
  // the deterministic tests above already pin the window contract (both
  // regressions in the table fail `testSplitsLargeCircularRunWithoutChanging-
  // ItsCircle` before reaching this point), so this assertion only has to guard
  // a structural return to unbounded scanning.
  //
  // Warm each size once so JIT tiering/compilation stays out of the measured
  // region (mirrors the guidance in src/test/cpuRatio.ts).
  findArcRunsInPoints(nonFittingPoints(400), FIT_OPTIONS)
  findArcRunsInPoints(nonFittingPoints(800), FIT_OPTIONS)

  const small = bestNonFittingCpuMs(400)
  const large = bestNonFittingCpuMs(800)

  // On Windows, process.cpuUsage() rounds to whole milliseconds, so a sub-ms
  // baseline reads exactly 0 and `large / small` is undefined (Infinity) — a
  // measurement floor, not a regression (the assertion passed there on
  // 2026-08-12 and failed spuriously on 2026-08-27). The deterministic
  // window-contract tests above are the primary guard and run on every
  // platform; this ratio only backstops a structural return to unbounded
  // scanning, so skip it where it cannot be measured, loudly.
  if (small === 0) {
    console.log(`arc-search scaling ratio skipped: baseline below timer resolution `
      + `(${small.toFixed(1)}ms -> ${large.toFixed(1)}ms CPU)`)
  } else {
    const ratio = large / small

    assert(ratio < 4,
      `expected sub-cubic scaling for 2x the input (linear ~2x, cubic ~8x), got ${ratio.toFixed(1)}x `
      + `(${small.toFixed(1)}ms -> ${large.toFixed(1)}ms CPU)`)
  }
}

testFindsLongestValidArcRun()
testDetectsClockwiseArcRun()
testSplitsLargeCircularRunWithoutChangingItsCircle()
testUsesEditorRadiusRelativeValidation()
testMinimumRunCanExceedDefaultCandidateWindow()
testBoundsLargeNonFittingSearch()

console.log('arcReconstruction tests passed.')
