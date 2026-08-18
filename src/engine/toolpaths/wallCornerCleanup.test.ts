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

/**
 * A crescent: one long straight chord and a tessellated arc running into each
 * end of it, giving two corners starved by short edges. Same shape the planner
 * tests use, and the one an island's rounded offset leaves against a wall.
 */
function tessellatedCrescent(steps = 160): Point[] {
  const radius = 5
  const half = (80 * Math.PI) / 180
  const ring: Point[] = []
  for (let step = 0; step <= steps; step += 1) {
    const angle = Math.PI - half + (2 * half * step) / steps
    ring.push({ x: radius + radius * Math.cos(angle), y: radius * Math.sin(angle) })
  }
  // A square bump partway along the closing chord, so the same contour carries
  // both kinds of transition: the two starved corners where the arc runs into
  // the chord, and ordinary square ones that reach the full radius unaided.
  const chordX = ring[ring.length - 1].x
  ring.push({ x: chordX, y: -1 })
  ring.push({ x: chordX + 3, y: -1 })
  ring.push({ x: chordX + 3, y: 1 })
  ring.push({ x: chordX, y: 1 })
  return ring
}

function testCutAcrossModeCleansOnlyWhatCutMaterial(): void {
  const ring = tessellatedCrescent()
  const plan = planContourSmoothing(ring, 1, { broadCorners: true })
  const broad = plan.transitions.filter((transition) => transition.cutsAcrossSource)
  const ordinary = plan.transitions.filter((transition) => !transition.cutsAcrossSource)
  assert(broad.length > 0 && ordinary.length > 0,
    'the crescent plans both kinds of transition, so the modes are distinguishable')

  const generous = (): boolean => true
  const all = buildWallCornerCleanupContour(plan, { isInsideDomain: generous })
  const cutAcross = buildWallCornerCleanupContour(plan, {
    isInsideDomain: generous, cleanup: 'cut-across',
  })
  assert(all !== null && cutAcross !== null, 'both modes produce a contour')
  assert(all.cleanupCount === plan.transitions.length,
    "'all' cleans every rounded corner, which is what a wall ring needs")
  assert(cutAcross.cleanupCount === broad.length,
    "'cut-across' cleans exactly the transitions that cut material away")
  assert(cutAcross.points.length < all.points.length,
    'skipping the loops that clean nothing costs less motion')
  console.log('cut-across mode cleans only what cut material: PASSED')
}

function testBroadCornerCleanupLeavesNoMoreThanTodaysFillet(): void {
  const ring = tessellatedCrescent()
  const plan = planContourSmoothing(ring, 1, { broadCorners: true })
  const result = buildWallCornerCleanupContour(plan, {
    isInsideDomain: (): boolean => true, cleanup: 'cut-across',
  })
  assert(result !== null, 'the crescent admits contained cleanup returns')
  assert(result.cleanupCount > 0, 'at least one broad corner is cleaned')
  const broad = plan.transitions.filter((transition) => transition.cutsAcrossSource)
  assert(broad.length > 0, 'the crescent produces a broad transition')

  // The ordinary plan is what ships today, and the fillet it emits at this
  // corner is the yardstick: a broad arc plus its cleanup may not leave more
  // stock at any vertex than that fillet already leaves.
  const ordinary = planContourSmoothing(ring, 1)
  for (const transition of broad) {
    // The span is traversed exactly, not approximately.
    for (const point of transition.spanPoints ?? []) {
      assert(pathDistance(point, result.points) <= 1e-9,
        'every point of the cleanup span is on the emitted path')
    }
    const budget = Math.max(...ordinary.transitions
      .filter((other) => other.runIndices.some((index) => transition.runIndices.includes(index)))
      .map((other) => other.effectiveRadius))
    assert(Number.isFinite(budget) && budget > 0,
      'the corner has an ordinary fillet to be measured against')
    for (const index of transition.runIndices) {
      const vertex = plan.sourcePoints[index]
      assert(pathDistance(vertex, result.points) <= budget,
        'the cleanup leaves no more at a cut-across vertex than the ordinary fillet does')
    }
    // And without the cleanup the arc really does leave material there, so the
    // assertion above is not satisfied by an arc that never cut anything.
    const uncleaned = Math.max(...transition.runIndices
      .map((index) => pathDistance(plan.sourcePoints[index], plan.points)))
    assert(uncleaned > budget,
      'the broad arc on its own leaves more than the ordinary fillet — hence the cleanup')
  }
  console.log('broad corner cleanup leaves no more than today\'s fillet: PASSED')
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
testCutAcrossModeCleansOnlyWhatCutMaterial()
testBroadCornerCleanupLeavesNoMoreThanTodaysFillet()
console.log('wallCornerCleanup tests: PASSED')
