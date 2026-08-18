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
import { planContourSmoothing } from './offsetSmoothing'
import { buildWallCornerCleanupContour } from './wallCornerCleanup'

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function pointSegmentDistance(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared <= 1e-18) return Math.hypot(point.x - a.x, point.y - a.y)
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared))
  return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t))
}

function pathDistance(point: Point, path: Point[]): number {
  let best = Number.POSITIVE_INFINITY
  for (let index = 0; index < path.length; index += 1) {
    best = Math.min(best, pointSegmentDistance(point, path[index], path[(index + 1) % path.length]))
  }
  return best
}

function samePoint(a: Point, b: Point, tolerance = 1e-7): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) <= tolerance
}

function direction(from: Point, to: Point): Point {
  const length = Math.hypot(to.x - from.x, to.y - from.y)
  return { x: (to.x - from.x) / length, y: (to.y - from.y) / length }
}

function angleBetween(a: Point, b: Point): number {
  return Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y)))
}

function denseSourceSamples(source: Point[], spacing: number): Point[] {
  const samples: Point[] = []
  for (let index = 0; index < source.length; index += 1) {
    const a = source[index]
    const b = source[(index + 1) % source.length]
    const count = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / spacing))
    for (let sample = 0; sample < count; sample += 1) {
      const t = sample / count
      samples.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
    }
  }
  return samples
}

function squareDomain(x: number, y: number): boolean {
  return x >= -1e-8 && x <= 20 + 1e-8 && y >= -1e-8 && y <= 20 + 1e-8
}

function testRoundedFirstThenExactCleanup(): void {
  const square: Point[] = [
    { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 },
  ]
  const plan = planContourSmoothing(square, 8)
  const result = buildWallCornerCleanupContour(plan, { isInsideDomain: squareDomain })
  assert(result !== null, 'square admits contained cleanup returns')
  assert(result.cleanupCount === 4, 'one cleanup loop is emitted for each rounded corner')
  assert(result.points.length > plan.points.length, 'cleanup path follows the rounded path with extra motion')

  const transition = plan.transitions[0]
  assert(transition !== undefined, 'square has a planned transition')
  const beforeExit = transition.transitionPoints.at(-2)
  assert(beforeExit !== undefined, 'transition has a final tessellated chord')
  const roundedExitIndex = result.points.findIndex((point, index) => {
    if (!samePoint(point, transition.exit)) return false
    const previous = result.points[(index + result.points.length - 1) % result.points.length]
    return samePoint(previous, beforeExit)
  })
  assert(roundedExitIndex >= 0, 'rounded transition appears before its cleanup return')
  let returnedEntryIndex = -1
  for (let offset = 1; offset < result.points.length; offset += 1) {
    const index = (roundedExitIndex + offset) % result.points.length
    if (samePoint(result.points[index], transition.entry)) {
      returnedEntryIndex = index
      break
    }
  }
  assert(returnedEntryIndex >= 0, 'return reaches the exact source-span entry')
  const arcTangent = direction(beforeExit, result.points[roundedExitIndex])
  const returnDeparture = direction(
    result.points[roundedExitIndex],
    result.points[(roundedExitIndex + 1) % result.points.length],
  )
  assert(angleBetween(arcTangent, returnDeparture) < 0.12, 'return leaves tangent to the broad arc')
  const returnArrival = direction(
    result.points[(returnedEntryIndex + result.points.length - 1) % result.points.length],
    result.points[returnedEntryIndex],
  )
  const exactSpanDeparture = direction(
    result.points[returnedEntryIndex],
    result.points[(returnedEntryIndex + 1) % result.points.length],
  )
  assert(angleBetween(returnArrival, exactSpanDeparture) < 0.12, 'return arrives tangent to the exact cleanup span')

  for (const sample of denseSourceSamples(square, 0.2)) {
    assert(pathDistance(sample, result.points) <= 1e-7, 'exact sharp source span remains covered')
  }
}

function testEveryEmittedSegmentStaysInDomain(): void {
  const source: Point[] = [
    { x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 12 },
    { x: 18, y: 12 }, { x: 18, y: 30 }, { x: 0, y: 30 },
  ]
  const domain = (x: number, y: number): boolean =>
    x >= -1e-8 && y >= -1e-8 && x <= 30 + 1e-8 && y <= 30 + 1e-8
    && (x <= 18 + 1e-8 || y <= 12 + 1e-8)
  const plan = planContourSmoothing(source, 5)
  const result = buildWallCornerCleanupContour(plan, { isInsideDomain: domain })
  assert(result !== null, 'concave domain admits only contained local returns')
  for (let index = 0; index < result.points.length; index += 1) {
    const a = result.points[index]
    const b = result.points[(index + 1) % result.points.length]
    for (let sample = 0; sample <= 20; sample += 1) {
      const t = sample / 20
      assert(domain(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t), 'emitted segment stays in domain')
    }
  }
}

function testFailClosedWhenReturnCannotFit(): void {
  const square: Point[] = [
    { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 },
  ]
  const plan = planContourSmoothing(square, 8)
  const result = buildWallCornerCleanupContour(plan, {
    isInsideDomain: (x, y) => square.some((point) => Math.hypot(point.x - x, point.y - y) <= 1e-9),
  })
  // A domain this degenerate admits no arc and no return, so every corner
  // declines. The safety property is that nothing unproven is emitted: the
  // result is the sharp source ring and no corner claims a cleanup.
  assert(result !== null, 'a fully declined ring is still a walkable result')
  assert(result.cleanupCount === 0, 'no corner may claim cleanup when no return fits')
  assert(
    result.points.length === square.length,
    `a fully declined ring emits the sharp source, got ${result.points.length} points`,
  )
  for (const corner of square) {
    assert(
      result.points.some((point) => Math.hypot(point.x - corner.x, point.y - corner.y) <= 1e-9),
      'every sharp source corner survives when the plan is declined',
    )
  }
}

/**
 * The broad arc needs its own domain check, not just the return that follows.
 * Here an obstruction sits on the arc of one corner while leaving that corner's
 * return swing clear, so the return check alone would happily emit an arc that
 * drives straight through it. (On the concave fixture above the two checks
 * happen to overlap, which is why this case is needed to constrain the arc one.)
 */
function testArcLeavingTheDomainDeclinesItsCorner(): void {
  const square: Point[] = [
    { x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 },
  ]
  // Centre of the arc that rounds the corner at (0,0) with radius 8.
  const blockedCentre = { x: 2.343, y: 2.343 }
  const blockedRadius = 1
  const domain = (x: number, y: number): boolean =>
    Math.hypot(x - blockedCentre.x, y - blockedCentre.y) > blockedRadius
  const plan = planContourSmoothing(square, 8)
  const result = buildWallCornerCleanupContour(plan, { isInsideDomain: domain })
  assert(result !== null, 'the ring is still walkable with one corner declined')
  assert(
    result.cleanupCount === 3,
    `the three unobstructed corners still round and clean, got ${result.cleanupCount}`,
  )
  assert(
    result.points.some((point) => Math.hypot(point.x, point.y) <= 1e-9),
    'the obstructed corner keeps its exact sharp vertex',
  )
  for (let index = 0; index < result.points.length; index += 1) {
    const a = result.points[index]
    const b = result.points[(index + 1) % result.points.length]
    const samples = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.02))
    for (let sample = 0; sample <= samples; sample += 1) {
      const t = sample / samples
      assert(
        domain(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t),
        'no emitted motion may cross the obstruction sitting on the arc',
      )
    }
  }
}

function testIdentityPlanNeedsNoCleanup(): void {
  const source: Point[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }]
  const plan = planContourSmoothing(source, 0)
  const result = buildWallCornerCleanupContour(plan, { isInsideDomain: () => true })
  assert(result !== null && result.cleanupCount === 0, 'identity plan stays an identity')
  assert(JSON.stringify(result.points) === JSON.stringify(source), 'identity points stay unchanged')
}

testRoundedFirstThenExactCleanup()
testEveryEmittedSegmentStaysInDomain()
testFailClosedWhenReturnCannotFit()
testArcLeavingTheDomainDeclinesItsCorner()
testIdentityPlanNeedsNoCleanup()
console.log('wallCornerCleanup tests: PASSED')
