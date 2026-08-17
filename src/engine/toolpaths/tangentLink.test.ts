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
 * Unit tests for tangential S-links (issue #545).
 * Run with: npx tsx src/engine/toolpaths/tangentLink.test.ts
 */

import {
  buildOffsetDomainCheck,
  pocketTangentLinkOptions,
  tangentSLink,
  type TangentLinkOptions,
} from './tangentLink'
import type { Point } from '../../types/project'

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error('Assertion failed: ' + message)
}

function approx(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps
}

function segmentDirection(from: Point, to: Point): Point {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy)
  return { x: dx / length, y: dy / length }
}

function angleBetween(a: Point, b: Point): number {
  const cos = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y))
  return Math.acos(cos)
}

const openDomain: TangentLinkOptions = {
  minRadius: 0.25,
  maxLength: 10,
  isInsideDomain: () => true,
}

function testLateralStepSTangentAtBothEnds() {
  console.log('Testing the lateral-step S is tangent at both ends...')
  const exit: Point = { x: 0, y: 0 }
  const t0: Point = { x: 1, y: 0 }
  // Arrival ring: a square one unit below, cut in the +x direction.
  const ring: Point[] = [
    { x: 0.5, y: 1 }, { x: 3, y: 1 }, { x: 3, y: 2.5 }, { x: 0.5, y: 2.5 },
  ]
  const result = tangentSLink(exit, t0, ring, openDomain)
  assert(result !== null, 'lateral step with a parallel arrival ring must admit an S')
  const points = result.points
  assert(result.arrivalIndex >= 0 && result.arrivalIndex < ring.length, 'arrival index names a ring vertex')
  assert(approx(points[0].x, exit.x) && approx(points[0].y, exit.y), 'S starts at the exit point')
  assert(
    approx(points[points.length - 1].x, ring[result.arrivalIndex].x)
    && approx(points[points.length - 1].y, ring[result.arrivalIndex].y),
    'S ends on the arrival vertex',
  )
  // Tangency: the first segment continues the exit tangent and the last
  // continues the arrival ring's travel direction (chord steps deviate by at
  // most half the 5-degree tessellation).
  const firstDir = segmentDirection(points[0], points[1])
  const lastDir = segmentDirection(points[points.length - 2], points[points.length - 1])
  assert(angleBetween(firstDir, t0) < 0.06, 'first segment is tangent to the departure direction')
  const ringTangent = segmentDirection(ring[result.arrivalIndex], ring[(result.arrivalIndex + 1) % ring.length])
  assert(angleBetween(lastDir, ringTangent) < 0.06, 'last segment is tangent to the arrival direction')
  // The S must actually wander off the straight line (an S, not a line).
  let maxLateral = 0
  for (const point of points) maxLateral = Math.max(maxLateral, Math.abs(point.y))
  assert(maxLateral > 0.05, 'the S bulges off the straight corridor')
  console.log('lateral-step S tangency: PASSED (arrival ' + result.arrivalIndex + ', ' + (points.length - 1) + ' segments)')
}

function testDomainRejectionAndBudget() {
  console.log('Testing domain rejection and the length budget...')
  const exit: Point = { x: 0, y: 0 }
  const t0: Point = { x: 1, y: 0 }
  const ring: Point[] = [
    { x: 0.5, y: 1 }, { x: 3, y: 1 }, { x: 3, y: 2.5 }, { x: 0.5, y: 2.5 },
  ]
  const closed: TangentLinkOptions = { ...openDomain, isInsideDomain: (_x, y) => y <= 0.5 - 1e-9 }
  assert(tangentSLink(exit, t0, ring, closed) === null, 'domain that excludes the S rejects it')
  const far: Point[] = [
    { x: 20, y: 1 }, { x: 22, y: 1 }, { x: 22, y: 2.5 }, { x: 20, y: 2.5 },
  ]
  assert(tangentSLink(exit, t0, far, openDomain) === null, 'ring beyond the length budget is unreachable')
  assert(tangentSLink(exit, t0, [{ x: 1, y: 1 }, { x: 2, y: 1 }], openDomain) === null, 'degenerate ring rejects')
  console.log('domain rejection and budget: PASSED')
}

function testDeterminism() {
  console.log('Testing determinism...')
  const exit: Point = { x: 0, y: 0 }
  const t0 = segmentDirection({ x: 0, y: 0 }, { x: 3, y: 1 })
  const ring: Point[] = [
    { x: 0.5, y: 1 }, { x: 3, y: 1 }, { x: 3, y: 2.5 }, { x: 0.5, y: 2.5 },
  ]
  const a = tangentSLink(exit, t0, ring, openDomain)
  const b = tangentSLink(exit, t0, ring, openDomain)
  assert(a !== null && b !== null, 'both runs find an S')
  assert(JSON.stringify(a) === JSON.stringify(b), 'identical inputs produce identical paths')
  console.log('determinism: PASSED')
}

function testDomainCheck() {
  console.log('Testing the offset-domain predicate...')
  const domain = buildOffsetDomainCheck([
    {
      outer: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
      islands: [[{ x: 4, y: 4 }, { x: 6, y: 4 }, { x: 6, y: 6 }, { x: 4, y: 6 }]],
    },
    {
      outer: [{ x: 20, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 10 }, { x: 20, y: 10 }],
      islands: [],
    },
  ])
  assert(domain(2, 2), 'inside the outer, outside the island')
  assert(!domain(5, 5), 'inside the island is rejected')
  assert(!domain(15, 5), 'between disjoint regions is rejected')
  assert(domain(25, 5), 'inside a second region')
  assert(!domain(35, 5), 'outside everything is rejected')
  console.log('offset-domain predicate: PASSED')
}

function testPocketOptionsGating() {
  console.log('Testing pocket option gating...')
  const region = { outer: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], islands: [] as Point[][] }
  assert(pocketTangentLinkOptions(undefined, 6, [region]) === undefined, 'undefined flag disables')
  assert(pocketTangentLinkOptions(false, 6, [region]) === undefined, 'false flag disables')
  const options = pocketTangentLinkOptions(true, 6, [region])
  assert(options !== undefined, 'true flag enables')
  const o = options as TangentLinkOptions
  assert(approx(o.minRadius, 6 * 0.25), 'minRadius = 0.25 x tool diameter')
  assert(approx(o.maxLength, 6 * 2.5), 'maxLength = 2.5 x tool diameter')
  assert(o.isInsideDomain(5, 5), 'domain predicate wired')
  assert(!o.isInsideDomain(20, 20), 'domain predicate rejects outside')
  console.log('pocket option gating: PASSED')
}

try {
  testLateralStepSTangentAtBothEnds()
  testDomainRejectionAndBudget()
  testDeterminism()
  testDomainCheck()
  testPocketOptionsGating()
  console.log('\nAll tangentLink tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
