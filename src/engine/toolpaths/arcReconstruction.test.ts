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

function testBoundsLargeNonFittingSearch(): void {
  console.log('Testing bounded large non-fitting search...')

  // Alternating points cannot fit a circle under the strict residual gate.
  // This size used to take seconds because every starting point re-tested
  // nearly every remaining endpoint. Keep the budget generous for CI while
  // still catching a regression to the unbounded cubic search.
  const result = measureNonFittingSearch(1200)

  assert(result.runs === 0, `expected no arc runs, got ${result.runs}`)
  // The exact-circle test above fixes the deterministic 128-point window
  // contract. This broad budget catches restoring the cubic search without a
  // flaky wall-clock scaling ratio while the full suite runs in parallel.
  assert(result.elapsedMs < 750,
    `expected bounded search below 750ms, took ${result.elapsedMs.toFixed(1)}ms`)
}

testFindsLongestValidArcRun()
testDetectsClockwiseArcRun()
testSplitsLargeCircularRunWithoutChangingItsCircle()
testUsesEditorRadiusRelativeValidation()
testMinimumRunCanExceedDefaultCandidateWindow()
testBoundsLargeNonFittingSearch()

console.log('arcReconstruction tests passed.')
