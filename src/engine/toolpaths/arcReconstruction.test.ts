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

function testBoundsLargeNonFittingSearch(): void {
  console.log('Testing bounded large non-fitting search...')

  // Alternating points cannot fit a circle under the strict residual gate.
  // This size used to take seconds because every starting point re-tested
  // nearly every remaining endpoint. Keep the budget generous for CI while
  // still catching a regression to the unbounded cubic search.
  const points: Point[] = Array.from({ length: 1200 }, (_, index) => ({
    x: index,
    y: index % 2 === 0 ? 0 : 10,
  }))
  const startedAt = performance.now()
  const runs = findArcRunsInPoints(points, FIT_OPTIONS)
  const elapsedMs = performance.now() - startedAt

  assert(runs.length === 0, `expected no arc runs, got ${runs.length}`)
  assert(elapsedMs < 750, `expected bounded search below 750ms, took ${elapsedMs.toFixed(1)}ms`)
}

testFindsLongestValidArcRun()
testDetectsClockwiseArcRun()
testBoundsLargeNonFittingSearch()

console.log('arcReconstruction tests passed.')
