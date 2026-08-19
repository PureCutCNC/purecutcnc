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
 * Unit tests for the swept-envelope coverage test (issue #546, slice S3).
 *
 * Run with: npx tsx src/engine/toolpaths/sweptCoverage.test.ts
 */

import type { Point } from '../../types/project'
import { buildSweptCoverage, pathIsCovered, sweptRegionIsCovered } from './sweptCoverage'

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const square: Point[] = [
  { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
]

function testCoversExactlyTheSweptBand(): void {
  const coverage = buildSweptCoverage([square], 1)
  assert(coverage.covers(5, 0), 'a point on the centreline is swept')
  assert(coverage.covers(5, 0.999), 'a point just inside the radius is swept')
  assert(coverage.covers(5, 1), 'a point exactly one radius away is swept')
  assert(!coverage.covers(5, 1.001), 'a point just outside the radius is not swept')
  assert(coverage.covers(0, 0), 'a vertex is swept')
  assert(!coverage.covers(5, 5), 'the middle of the square is far from every edge')
  // The closed ring includes the closing edge, so the fourth side counts too.
  assert(coverage.covers(0.5, 5), 'the closing edge of the ring is indexed like any other')
  console.log('covers exactly the swept band: PASSED')
}

function testGridPlacesFarGeometryCorrectly(): void {
  // The index buckets by cell, so geometry away from the origin — and in
  // negative coordinates, where flooring rounds the other way — has to land in
  // the cells a query actually reads.
  const far: Point[] = [
    { x: -940.5, y: -1203.25 }, { x: -900.5, y: -1203.25 },
    { x: -900.5, y: -1183.25 }, { x: -940.5, y: -1183.25 },
  ]
  const coverage = buildSweptCoverage([far], 0.75)
  assert(coverage.covers(-920.5, -1203.25), 'a point on far negative geometry is swept')
  // 0.65 above the rail with a 0.75 cell: inside the radius but in the cell
  // row above, so it is only found if stored segments are registered into the
  // cells their radius-expanded box touches rather than their own.
  assert(coverage.covers(-920.5, -1202.6), 'and so is one inside the radius in the next cell up')
  assert(!coverage.covers(-920.5, -1199), 'a point beyond the radius there is not')
  console.log('grid places far geometry correctly: PASSED')
}

function testPathCoverageNeedsEveryPoint(): void {
  const coverage = buildSweptCoverage([square], 1)
  const inside: Point[] = [{ x: 2, y: 0.5 }, { x: 8, y: 0.5 }]
  assert(pathIsCovered(inside, coverage, 0.05), 'a path running along the band is covered')
  // One excursion is enough to fail it, and it sits mid-segment where only
  // sampling can find it — the endpoints are both well inside.
  const excursion: Point[] = [{ x: 2, y: 0.5 }, { x: 5, y: 3 }, { x: 8, y: 0.5 }]
  assert(!pathIsCovered(excursion, coverage, 0.05),
    'a path leaving the band mid-segment is not covered')
  const startsOutside: Point[] = [{ x: 5, y: 5 }, { x: 5, y: 0.5 }]
  assert(!pathIsCovered(startsOutside, coverage, 0.05),
    'the first point is tested too, not just the samples after it')
  console.log('path coverage needs every point: PASSED')
}

function testTheInteriorOfASegmentIsSampled(): void {
  // Two parallel rails with a gap between them. A single straight move from one
  // rail to the other has both *endpoints* inside the band and its whole middle
  // outside, so only sampling along the segment can see the excursion.
  const rails: Point[][] = [
    [{ x: 0, y: 0 }, { x: 10, y: 0 }],
    [{ x: 0, y: 10 }, { x: 10, y: 10 }],
  ]
  const coverage = buildSweptCoverage(rails, 1)
  const crossing: Point[] = [{ x: 5, y: 0.5 }, { x: 5, y: 9.5 }]
  assert(coverage.covers(crossing[0].x, crossing[0].y) && coverage.covers(crossing[1].x, crossing[1].y),
    'both endpoints of the crossing are inside the band')
  assert(!pathIsCovered(crossing, coverage, 0.05),
    'the gap in the middle of the segment is found')
  console.log('the interior of a segment is sampled: PASSED')
}

function testUnanswerableQuestionsAnswerNo(): void {
  const coverage = buildSweptCoverage([square], 1)
  const path: Point[] = [{ x: 2, y: 0.5 }, { x: 8, y: 0.5 }]
  const cases: Array<[string, boolean]> = [
    ['nothing to compare against', pathIsCovered(path, buildSweptCoverage([], 1), 0.05)],
    ['a non-positive tool radius', pathIsCovered(path, buildSweptCoverage([square], 0), 0.05)],
    ['a non-finite tool radius', pathIsCovered(path, buildSweptCoverage([square], Number.NaN), 0.05)],
    ['a non-positive sample step', pathIsCovered(path, coverage, 0)],
    ['an empty path', pathIsCovered([], coverage, 0.05)],
    ['a non-finite path point', pathIsCovered([{ x: 2, y: 0.5 }, { x: Number.NaN, y: 0.5 }], coverage, 0.05)],
    ['a degenerate centreline', pathIsCovered(path, buildSweptCoverage([[{ x: 0, y: 0 }]], 1), 0.05)],
  ]
  for (const [label, result] of cases) {
    assert(result === false, `${label} answers no — this gate only ever removes motion`)
  }
  const empty = buildSweptCoverage([], 1)
  assert(empty.segmentCount === 0, 'an empty coverage reports no segments')
  assert(!empty.covers(0, 0) && !empty.covers(5, 5),
    'an empty coverage sweeps nothing, asked directly rather than through pathIsCovered')
  console.log('unanswerable questions answer no: PASSED')
}

function testSweptRegionAsksAboutMetalNotAboutTheLine(): void {
  // Two rails a tool-width apart, and a path running straight down the middle
  // of the gap. Its *centreline* is inside both rails' swept band the whole
  // way — `pathIsCovered` says yes — but a cutter following it removes a strip
  // down the middle that neither rail touches. This is the difference that let
  // a corner cleanup loop be dropped while it was still the only pass clearing
  // part of the floor.
  // Rails at y=0 and y=2.4 with a unit cutter sweep y<=1 and y>=1.4, leaving a
  // 0.4-wide strip between them. A path at y=0.95 is 0.95 from the lower rail,
  // so its centreline is covered, but its own sweep reaches y=1.95 and takes
  // that strip.
  const rails: Point[][] = [
    [{ x: 0, y: 0 }, { x: 10, y: 0 }],
    [{ x: 0, y: 2.4 }, { x: 10, y: 2.4 }],
  ]
  const covered = buildSweptCoverage(rails, 1)
  const middle: Point[] = [{ x: 2, y: 0.95 }, { x: 8, y: 0.95 }]
  assert(pathIsCovered(middle, covered, 0.05),
    'the centreline of the middle path is inside the rails\' band')
  assert(!sweptRegionIsCovered(middle, covered, 1, 0.05),
    'but sweeping it removes metal the rails never reach')

  // Move it onto a rail and both agree.
  const onRail: Point[] = [{ x: 2, y: 0 }, { x: 8, y: 0 }]
  assert(sweptRegionIsCovered(onRail, covered, 1, 0.05),
    'a path lying on a rail removes nothing the rail does not')
  console.log('swept region asks about metal, not about the line: PASSED')
}

function testSweptRegionFailsClosed(): void {
  const square: Point[] = [
    { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
  ]
  const covered = buildSweptCoverage([square], 1)
  const path: Point[] = [{ x: 2, y: 0 }, { x: 8, y: 0 }]
  const cases: Array<[string, boolean]> = [
    ['an empty path', sweptRegionIsCovered([], covered, 1, 0.05)],
    ['a non-positive radius', sweptRegionIsCovered(path, covered, 0, 0.05)],
    ['a non-positive cell size', sweptRegionIsCovered(path, covered, 1, 0)],
    ['nothing to compare against', sweptRegionIsCovered(path, buildSweptCoverage([], 1), 1, 0.05)],
    ['a non-finite path point', sweptRegionIsCovered([{ x: 2, y: 0 }, { x: Number.NaN, y: 0 }], covered, 1, 0.05)],
  ]
  for (const [label, result] of cases) {
    assert(result === false, `${label} answers no — this gate only ever removes motion`)
  }
  console.log('swept region fails closed: PASSED')
}

function testDeterminism(): void {
  const path: Point[] = [{ x: 2, y: 0.5 }, { x: 8, y: 0.5 }, { x: 9.5, y: 4 }]
  const first = pathIsCovered(path, buildSweptCoverage([square], 1), 0.05)
  for (let repeat = 0; repeat < 5; repeat += 1) {
    assert(pathIsCovered(path, buildSweptCoverage([square], 1), 0.05) === first,
      'the coverage answer is deterministic')
  }
  console.log('determinism: PASSED')
}

try {
  testCoversExactlyTheSweptBand()
  testGridPlacesFarGeometryCorrectly()
  testPathCoverageNeedsEveryPoint()
  testTheInteriorOfASegmentIsSampled()
  testUnanswerableQuestionsAnswerNo()
  testSweptRegionAsksAboutMetalNotAboutTheLine()
  testSweptRegionFailsClosed()
  testDeterminism()
  console.log('\nAll sweptCoverage tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
