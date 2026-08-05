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

import type { Point } from '../../types/project'
import { DEFAULT_CLIPPER_SCALE } from './geometry'
import { splitClosedGuideByForbiddenPaths } from './guideFragments'
import type { ClipperPath } from './types'

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(left: number, right: number, epsilon = 1e-9): boolean {
  return Math.abs(left - right) <= epsilon
}

function samePoint(left: Point, right: Point): boolean {
  return approx(left.x, right.x) && approx(left.y, right.y)
}

function assertPoint(point: Point, expected: Point, message: string): void {
  assert(samePoint(point, expected), `${message}: expected (${expected.x}, ${expected.y}), got (${point.x}, ${point.y})`)
}

function clippedPath(points: Point[]): ClipperPath {
  return points.map((point) => ({
    X: Math.round(point.x * DEFAULT_CLIPPER_SCALE),
    Y: Math.round(point.y * DEFAULT_CLIPPER_SCALE),
  }))
}

const square: Point[] = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
]

function testNoForbiddenPathPassesThroughAsClosedGuide(): void {
  const fragments = splitClosedGuideByForbiddenPaths(square, [])
  assert(fragments.length === 1, 'no forbidden path returns one guide')
  assert(fragments[0].closed, 'uninterrupted guide remains closed')
  assert(fragments[0].points.length === 4, 'closed guide does not duplicate the seam')
  assertPoint(fragments[0].points[0], square[0], 'closed guide preserves its start')
  assertPoint(fragments[0].points.at(-1)!, square.at(-1)!, 'closed guide preserves its order')
}

function testRepeatedClosingVertexAndOneForbiddenInterval(): void {
  const repeatedClosedGuide = [...square, { ...square[0] }]
  const forbidden = clippedPath([
    { x: 4, y: -1 },
    { x: 6, y: -1 },
    { x: 6, y: 1 },
    { x: 4, y: 1 },
  ])

  const fragments = splitClosedGuideByForbiddenPaths(repeatedClosedGuide, [forbidden])
  assert(fragments.length === 1, 'one forbidden interval leaves one open cyclic span')
  assert(!fragments[0].closed, 'interrupted guide becomes an open span')
  assertPoint(fragments[0].points[0], { x: 6, y: 0 }, 'span starts at the exact exit intersection')
  assertPoint(fragments[0].points.at(-1)!, { x: 4, y: 0 }, 'span ends at the exact entry intersection')
  assert(
    !fragments[0].points.some((point, index) => index > 0 && samePoint(point, fragments[0].points[index - 1])),
    'repeated closing vertex is removed from the fragment',
  )
}

function testInsideRetainsExactForbiddenInterval(): void {
  const forbidden = clippedPath([
    { x: 4, y: -1 },
    { x: 6, y: -1 },
    { x: 6, y: 1 },
    { x: 4, y: 1 },
  ])

  const fragments = splitClosedGuideByForbiddenPaths(square, [forbidden], 'inside')
  assert(fragments.length === 1, 'one forbidden interval returns one inside span')
  assert(!fragments[0].closed, 'partial inside interval is open')
  assertPoint(fragments[0].points[0], { x: 4, y: 0 }, 'inside span starts at the exact entry')
  assertPoint(fragments[0].points.at(-1)!, { x: 6, y: 0 }, 'inside span ends at the exact exit')
}

function testDisjointUnionIntervalsRemainSeparate(): void {
  const left = clippedPath([
    { x: 2, y: -1 },
    { x: 3, y: -1 },
    { x: 3, y: 1 },
    { x: 2, y: 1 },
  ])
  const right = clippedPath([
    { x: 7, y: -1 },
    { x: 8, y: -1 },
    { x: 8, y: 1 },
    { x: 7, y: 1 },
  ])

  const fragments = splitClosedGuideByForbiddenPaths(square, [left, right])
  assert(fragments.length === 2, 'two disjoint union paths retain two outside spans')
  assertPoint(fragments[0].points[0], { x: 8, y: 0 }, 'cyclic order begins after the second interval')
  assertPoint(fragments[0].points.at(-1)!, { x: 2, y: 0 }, 'first cyclic span ends before the first interval')
  assertPoint(fragments[1].points[0], { x: 3, y: 0 }, 'second span starts after the first interval')
  assertPoint(fragments[1].points.at(-1)!, { x: 7, y: 0 }, 'second span ends before the second interval')
}

function testSeamCutReordersIntoOneContinuousSpan(): void {
  const seamForbidden = clippedPath([
    { x: -1, y: -1 },
    { x: 1, y: -1 },
    { x: 1, y: 1 },
    { x: -1, y: 1 },
  ])

  const fragments = splitClosedGuideByForbiddenPaths(square, [seamForbidden])
  assert(fragments.length === 1, 'a forbidden seam produces one re-ordered span')
  assertPoint(fragments[0].points[0], { x: 1, y: 0 }, 'seam span starts after the forbidden seam')
  assertPoint(fragments[0].points.at(-1)!, { x: 0, y: 1 }, 'seam span ends before the forbidden seam')
  assert(
    !fragments[0].points.some((point) => samePoint(point, { x: 0, y: 0 })),
    'forbidden seam point is not retained',
  )
}

function testInsideSeamCutReordersIntoOneContinuousSpan(): void {
  const seamForbidden = clippedPath([
    { x: -1, y: -1 },
    { x: 1, y: -1 },
    { x: 1, y: 1 },
    { x: -1, y: 1 },
  ])

  const fragments = splitClosedGuideByForbiddenPaths(square, [seamForbidden], 'inside')
  assert(fragments.length === 1, 'inside seam produces one re-ordered span')
  assertPoint(fragments[0].points[0], { x: 0, y: 1 }, 'inside seam starts at the exact last-edge entry')
  assertPoint(fragments[0].points.at(-1)!, { x: 1, y: 0 }, 'inside seam ends at the exact first-edge exit')
  assert(
    fragments[0].points.some((point) => samePoint(point, { x: 0, y: 0 })),
    'inside seam retains the original guide seam point',
  )
}

function testInsideRetainsAlreadyUnionedOverlappingKeepOut(): void {
  // The two source keep-outs overlap; the fragmenter intentionally receives
  // their one already-unioned contour rather than attempting a second union.
  const unionedOverlap = clippedPath([
    { x: 2, y: -1 },
    { x: 7, y: -1 },
    { x: 7, y: 1 },
    { x: 2, y: 1 },
  ])

  const fragments = splitClosedGuideByForbiddenPaths(square, [unionedOverlap], 'inside')
  assert(fragments.length === 1, 'unioned overlap produces one inside span')
  assertPoint(fragments[0].points[0], { x: 2, y: 0 }, 'unioned span starts at the first outer boundary')
  assertPoint(fragments[0].points.at(-1)!, { x: 7, y: 0 }, 'unioned span ends at the second outer boundary')
}

function testConcaveForbiddenPathDoesNotCollapseSeparatedIntervals(): void {
  const concaveForbidden = clippedPath([
    { x: 1, y: -1 },
    { x: 4, y: -1 },
    { x: 4, y: 1 },
    { x: 6, y: 1 },
    { x: 6, y: -1 },
    { x: 9, y: -1 },
    { x: 9, y: 3 },
    { x: 1, y: 3 },
  ])

  const fragments = splitClosedGuideByForbiddenPaths(square, [concaveForbidden])
  assert(fragments.length === 2, 'concave path retains both separated outside intervals')
  assertPoint(fragments[0].points[0], { x: 9, y: 0 }, 'concave cyclic span starts after the second tooth')
  assertPoint(fragments[0].points.at(-1)!, { x: 1, y: 0 }, 'concave cyclic span ends before the first tooth')
  assertPoint(fragments[1].points[0], { x: 4, y: 0 }, 'middle span starts at the first exact exit')
  assertPoint(fragments[1].points.at(-1)!, { x: 6, y: 0 }, 'middle span ends at the second exact entry')
}

function run(): void {
  testNoForbiddenPathPassesThroughAsClosedGuide()
  testRepeatedClosingVertexAndOneForbiddenInterval()
  testInsideRetainsExactForbiddenInterval()
  testDisjointUnionIntervalsRemainSeparate()
  testSeamCutReordersIntoOneContinuousSpan()
  testInsideSeamCutReordersIntoOneContinuousSpan()
  testInsideRetainsAlreadyUnionedOverlappingKeepOut()
  testConcaveForbiddenPathDoesNotCollapseSeparatedIntervals()
}

run()
