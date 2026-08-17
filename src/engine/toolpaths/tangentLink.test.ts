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

function testStraightMiddleDomainSampling() {
  console.log('Testing the domain gate samples the straight middle...')
  // Review repro: an island expansion straddling the S's straight middle on
  // an otherwise open domain. Vertex-only sampling accepted the straddling
  // candidate; along-segment sampling must keep every returned path off the
  // island — whether by rejecting that candidate or by picking a safe one.
  const island: Point[] = [
    { x: 0.85, y: 1.95 }, { x: 1.2, y: 1.95 }, { x: 1.2, y: 2.6 }, { x: 0.85, y: 2.6 },
  ]
  const domain = buildOffsetDomainCheck([{
    outer: [{ x: -30, y: -30 }, { x: 30, y: -30 }, { x: 30, y: 30 }, { x: -30, y: 30 }],
    islands: [island],
  }])
  const ring: Point[] = [
    { x: 0.5, y: 1.2 }, { x: 4, y: 1.2 }, { x: 4, y: 3 }, { x: 0.5, y: 3 },
  ]
  const angle = (20 * Math.PI) / 180
  const result = tangentSLink(
    { x: 0, y: 0 },
    { x: Math.cos(angle), y: Math.sin(angle) },
    ring,
    { minRadius: 0.25, maxLength: 10, isInsideDomain: domain },
  )
  if (result !== null) {
    // Densely resample the emitted path: nothing may enter the island.
    for (let step = 0; step + 1 < result.points.length; step += 1) {
      const a = result.points[step]
      const b = result.points[step + 1]
      const segLen = Math.hypot(b.x - a.x, b.y - a.y)
      const samples = Math.max(1, Math.ceil(segLen / 0.002))
      for (let sample = 0; sample <= samples; sample += 1) {
        const t = sample / samples
        const x = a.x + (b.x - a.x) * t
        const y = a.y + (b.y - a.y) * t
        assert(!domainIslandInterior(x, y, island), 'path point (' + x.toFixed(3) + ', ' + y.toFixed(3) + ') enters the island expansion')
      }
    }
  }
  // The predicate itself rejects island-interior points (the mechanism the
  // sampling applies along the middle).
  assert(!domain(1.0, 2.2), 'predicate rejects a point strictly inside the island')
  console.log('straight-middle domain sampling: PASSED')
}

function domainIslandInterior(x: number, y: number, island: Point[]): boolean {
  let inside = false
  for (let i = 0, j = island.length - 1; i < island.length; j = i, i += 1) {
    if ((island[i].y > y) !== (island[j].y > y)
      && x < ((island[j].x - island[i].x) * (y - island[i].y)) / (island[j].y - island[i].y) + island[i].x) {
      inside = !inside
    }
  }
  return inside
}

function testBoundaryPointsAreInside() {
  console.log('Testing boundary points of the domain are accepted...')
  // The ring paths ride the domain boundary: every vertex of the domain's own
  // polygon must be accepted, not a ray-cast parity coin flip (measured
  // 32/64 accepted before the fix).
  const outer: Point[] = []
  const n = 64
  for (let k = 0; k < n; k += 1) {
    const a = (2 * Math.PI * k) / n
    outer.push({ x: 10 + 5 * Math.cos(a), y: 10 + 5 * Math.sin(a) })
  }
  const domain = buildOffsetDomainCheck([{ outer, islands: [] }])
  let accepted = 0
  for (const vertex of outer) {
    if (domain(vertex.x, vertex.y)) accepted += 1
  }
  assert(accepted === n, 'all ' + n + ' boundary vertices accepted, got ' + accepted)
  // The centre and a clearly outside point behave as before.
  assert(domain(10, 10), 'centre accepted')
  assert(!domain(40, 40), 'outside rejected')
  console.log('boundary points accepted: PASSED')
}

function testParallelLateralStep() {
  console.log('Testing the parallel lateral step (the sweep must bow across)...')
  // The exit tangent is parallel to the arrival ring's straight side; the
  // middle-direction sweep must reach outside the tangent cone to cross the
  // step. Arrival index 0 of the reviewer's fixture is the parallel side.
  const exit: Point = { x: 0, y: 0 }
  const t0: Point = { x: 1, y: 0 }
  const ring: Point[] = [
    { x: 0.5, y: 1 }, { x: 4, y: 1 }, { x: 4, y: 3 }, { x: 0.5, y: 3 },
  ]
  const result = tangentSLink(exit, t0, ring, openDomain)
  assert(result !== null, 'the parallel lateral step must admit an S')
  // Tangency at both ends.
  const points = result.points
  const firstDir = segmentDirection(points[0], points[1])
  const lastDir = segmentDirection(points[points.length - 2], points[points.length - 1])
  assert(angleBetween(firstDir, t0) < 0.06, 'first segment tangent to the exit direction')
  const ringTangent = segmentDirection(ring[result.arrivalIndex], ring[(result.arrivalIndex + 1) % ring.length])
  assert(angleBetween(lastDir, ringTangent) < 0.06, 'last segment tangent to the arrival direction')
  console.log('parallel lateral step: PASSED (arrival ' + result.arrivalIndex + ')')
}

try {
  testLateralStepSTangentAtBothEnds()
  testParallelLateralStep()
  testStraightMiddleDomainSampling()
  testBoundaryPointsAreInside()
  testDomainRejectionAndBudget()
  testDeterminism()
  testDomainCheck()
  testPocketOptionsGating()
  console.log('\nAll tangentLink tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
