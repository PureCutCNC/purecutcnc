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
 * Unit tests for the contour-level turn planner (issue #546, slice S1) —
 * planContourSmoothing plus the roundContourCorners compatibility wrapper.
 *
 * Run with: npx tsx src/engine/toolpaths/offsetSmoothing.test.ts
 */

import type { Point } from '../../types/project'
import { planContourSmoothing, roundContourCorners } from './offsetSmoothing'

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(actual: number, expected: number, tolerance: number): boolean {
  return Math.abs(actual - expected) <= tolerance
}

function pointsEqual(a: Point[], b: Point[]): boolean {
  if (a.length !== b.length) return false
  return a.every((point, index) => point.x === b[index].x && point.y === b[index].y)
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** Rotate a closed ring so old index `offset` becomes index 0. */
function rotateRing(points: Point[], offset: number): Point[] {
  return points.map((_, index) => points[(index + offset) % points.length])
}

/** Split the edge a->b into steps+1 collinear pieces; returns the interior
 *  vertices (exactly collinear, so the planner treats them as straight). */
function subdivideEdge(a: Point, b: Point, steps: number): Point[] {
  return Array.from({ length: steps }, (_, index) => ({
    x: a.x + ((b.x - a.x) * (index + 1)) / (steps + 1),
    y: a.y + ((b.y - a.y) * (index + 1)) / (steps + 1),
  }))
}

/** True when two closed rings are the same cyclic point sequence. */
function cyclicPointsEquivalent(a: Point[], b: Point[], tolerance: number): boolean {
  if (a.length !== b.length) return false
  const count = a.length
  return Array.from({ length: count }, (_, offset) =>
    a.every((point, index) => {
      const other = b[(index + offset) % count]
      const scale = Math.max(1, Math.abs(point.x), Math.abs(point.y))
      return approx(other.x, point.x, tolerance * scale) && approx(other.y, point.y, tolerance * scale)
    }),
  ).some(Boolean)
}

/** Largest turn (deflection) angle, in degrees, over a closed contour. */
function maxDeflectionDeg(points: Point[]): number {
  const count = points.length
  let max = 0
  for (let index = 0; index < count; index += 1) {
    const previous = points[(index + count - 1) % count]
    const current = points[index]
    const next = points[(index + 1) % count]
    const inX = current.x - previous.x
    const inY = current.y - previous.y
    const outX = next.x - current.x
    const outY = next.y - current.y
    const inLen = Math.hypot(inX, inY)
    const outLen = Math.hypot(outX, outY)
    if (inLen <= 1e-9 || outLen <= 1e-9) continue
    const cos = Math.max(-1, Math.min(1, (inX * outX + inY * outY) / (inLen * outLen)))
    max = Math.max(max, (Math.acos(cos) * 180) / Math.PI)
  }
  return max
}

function bbox(points: Point[]) {
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
}

function minDistanceTo(points: Point[], target: Point): number {
  return Math.min(...points.map((point) => Math.hypot(point.x - target.x, point.y - target.y)))
}

/** Radius of the circle through three non-collinear points. */
function circumradius(a: Point, b: Point, c: Point): number {
  const ab = dist(a, b)
  const bc = dist(b, c)
  const ca = dist(c, a)
  const area = Math.abs(
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x),
  ) / 2
  assert(area > 1e-12, 'circumradius needs non-collinear points')
  return (ab * bc * ca) / (4 * area)
}

/** Independent O(n^2) proper-intersection check over a closed polyline. */
function hasProperIntersection(points: Point[]): boolean {
  const count = points.length
  const orientation = (p: Point, q: Point, r: Point): number =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  const strictlyInside = (p: Point, q: Point, r: Point): boolean => {
    if (Math.abs(q.x - p.x) >= Math.abs(q.y - p.y)) {
      const min = Math.min(p.x, q.x)
      const max = Math.max(p.x, q.x)
      return r.x > min && r.x < max
    }
    const min = Math.min(p.y, q.y)
    const max = Math.max(p.y, q.y)
    return r.y > min && r.y < max
  }
  const cross = (a: Point, b: Point, c: Point, d: Point): boolean => {
    const d1 = orientation(c, d, a)
    const d2 = orientation(c, d, b)
    const d3 = orientation(a, b, c)
    const d4 = orientation(a, b, d)
    if (
      ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0))
      && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
    ) {
      return true
    }
    if (d1 === 0 && strictlyInside(c, d, a)) return true
    if (d2 === 0 && strictlyInside(c, d, b)) return true
    if (d3 === 0 && strictlyInside(a, b, c)) return true
    if (d4 === 0 && strictlyInside(a, b, d)) return true
    return false
  }
  for (let i = 0; i < count; i += 1) {
    for (let j = i + 2; j < count; j += 1) {
      if (i === 0 && j === count - 1) continue // incident closing pair
      if (cross(points[i], points[(i + 1) % count], points[j], points[(j + 1) % count])) {
        return true
      }
    }
  }
  return false
}

const SQUARE: Point[] = [
  { x: 0, y: 0 },
  { x: 20, y: 0 },
  { x: 20, y: 20 },
  { x: 0, y: 20 },
]

/** The 20x20 square corner at (20,0) whose two adjacent edges are split into
 *  10-unit halves by collinear extra vertices (shallow turns, never rounded). */
const SPLIT_SQUARE: Point[] = [
  { x: 20, y: 0 },
  { x: 10, y: 0 },
  { x: 0, y: 0 },
  { x: 0, y: 20 },
  { x: 20, y: 20 },
  { x: 20, y: 10 },
]

/** Rectangle with one corner replaced by a quarter arc of radius 4 (5
 *  vertices, 22.5-degree steps) centred at (0,0), plus straight legs. */
const ARC_CORNER_CONTOUR: Point[] = [
  { x: 4, y: -20 },
  { x: 4, y: 0 },
  { x: 3.695518, y: 1.530734 },
  { x: 2.828427, y: 2.828427 },
  { x: 1.530734, y: 3.695518 },
  { x: 0, y: 4 },
  { x: -20, y: 4 },
  { x: -20, y: -20 },
]

function testIdentityWhenDisabled() {
  console.log('Testing roundContourCorners is an identity no-op when disabled...')
  assert(pointsEqual(roundContourCorners(SQUARE, 0), SQUARE), 'radius 0 must return the input unchanged')
  assert(pointsEqual(roundContourCorners(SQUARE, -3), SQUARE), 'negative radius must return the input unchanged')
  const twoPoints: Point[] = [{ x: 0, y: 0 }, { x: 1, y: 1 }]
  assert(pointsEqual(roundContourCorners(twoPoints, 2), twoPoints), 'a degenerate (<3 point) ring is returned unchanged')
  const plan = planContourSmoothing(SQUARE, 0)
  assert(plan.points === SQUARE && plan.transitions.length === 0, 'identity plan carries no transitions')
  console.log('identity when disabled: PASSED')
}

function testRoundsSquareCorners() {
  console.log('Testing roundContourCorners rounds the four 90° corners of a square...')
  const radius = 4
  const rounded = roundContourCorners(SQUARE, radius)

  assert(rounded.length > SQUARE.length, `expected added arc points, got ${rounded.length}`)
  assert(maxDeflectionDeg(rounded) < 10, `no output corner should stay sharp, max deflection was ${maxDeflectionDeg(rounded).toFixed(1)}°`)

  const box = bbox(rounded)
  assert(
    box.minX >= -1e-6 && box.minY >= -1e-6 && box.maxX <= 20 + 1e-6 && box.maxY <= 20 + 1e-6,
    'rounded convex corners must stay within the original bounding box',
  )

  const expectedClearance = radius * (Math.SQRT2 - 1)
  for (const corner of SQUARE) {
    const clearance = minDistanceTo(rounded, corner)
    assert(
      clearance > expectedClearance * 0.6,
      `apex ${JSON.stringify(corner)} should be cleared by ~${expectedClearance.toFixed(2)}, got ${clearance.toFixed(2)}`,
    )
  }
  console.log('rounds square corners: PASSED')
}

function testHugeRadiusStaysInsideBox() {
  console.log('Testing huge radii stay bounded and simple...')
  const rounded = roundContourCorners(SQUARE, 1000)
  assert(rounded.length >= 8, 'expected fillets on every corner')
  const box = bbox(rounded)
  assert(
    box.minX >= -1e-6 && box.minY >= -1e-6 && box.maxX <= 20 + 1e-6 && box.maxY <= 20 + 1e-6,
    'filleted contour must stay within the original bounding box',
  )
  assert(maxDeflectionDeg(rounded) < 10, 'corners should still be smooth')
  assert(!hasProperIntersection(rounded), 'huge-radius output must not self-intersect')
  console.log('huge radius stays bounded: PASSED')
}

function testShallowCornersPreserved() {
  console.log('Testing gentle turns below the deflection threshold are left untouched...')
  const almostStraight: Point[] = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 20, y: 0.4 },
    { x: 20, y: 20 },
    { x: 0, y: 20 },
  ]
  const rounded = roundContourCorners(almostStraight, 3, { minDeflectionDeg: 20 })
  assert(
    rounded.some((point) => point.x === 10 && point.y === 0),
    'a sub-threshold vertex must be preserved verbatim',
  )
  console.log('shallow corners preserved: PASSED')
}

function testAcuteCornerRetreatBounded() {
  console.log('Testing an acute corner rounds but never retreats past the radius...')
  const radius = 3
  const acute: Point[] = [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 6, y: 16 }]
  const apex = { x: 80, y: 0 }
  const rounded = roundContourCorners(acute, radius)

  assert(!rounded.some((point) => point.x === apex.x && point.y === apex.y), 'the acute apex should be rounded away')

  const closest = minDistanceTo(rounded, apex)
  assert(closest <= radius + 1e-6, `acute-corner retreat ${closest.toFixed(3)} must stay within radius ${radius}`)
  assert(closest > 0, 'the corner should still be rounded, not collapsed onto the apex')
  console.log('acute corner retreat bounded: PASSED')
}

function testIsolatedCornerExceedsOldHalfEdgeCap() {
  console.log('Testing an isolated 20x20 square corner attains radius 8 beyond the old half-edge clamp...')
  // The old per-vertex clamp limited every fillet to half the shorter adjacent
  // edge: for the 10-unit edges of this corner that caps the radius at 5.
  const radius = 8
  const plan = planContourSmoothing(SPLIT_SQUARE, radius)
  assert(plan.transitions.length === 4, `expected all four corners rounded, got ${plan.transitions.length}`)

  const corner = plan.transitions.find((transition) => transition.firstIndex === 0)
  assert(corner !== undefined, 'the (20,0) corner must be a planned transition')
  assert(
    corner.lastIndex === 0 && corner.runIndices.length === 1 && corner.runIndices[0] === 0,
    'metadata must name the actual changed source run',
  )
  assert(approx(Math.abs(corner.signedTurn), Math.PI / 2, 1e-9), 'signed turn must be 90°')
  assert(corner.requestedRadius === radius, 'requested radius recorded verbatim')
  assert(approx(corner.effectiveRadius, radius, 1e-9), `effective radius must reach 8, got ${corner.effectiveRadius}`)
  assert(approx(corner.entry.x, 20, 1e-9) && approx(corner.entry.y, 8, 1e-9), `entry must be (20,8), got (${corner.entry.x}, ${corner.entry.y})`)
  assert(approx(corner.exit.x, 12, 1e-9) && approx(corner.exit.y, 0, 1e-9), `exit must be (12,0), got (${corner.exit.x}, ${corner.exit.y})`)
  assert(corner.entryEdgeIndex === 5, 'entry setback comes from the (20,10)->(20,0) edge')
  assert(corner.exitEdgeIndex === 0, 'exit setback comes from the (20,0)->(10,0) edge')
  assert(
    corner.transitionPoints.length >= 19 && corner.transitionPoints.length <= 20,
    `90° at a 5° arc step must tessellate (~19-20 points), got ${corner.transitionPoints.length}`,
  )
  const mid = corner.transitionPoints[Math.floor(corner.transitionPoints.length / 2)]
  assert(
    approx(circumradius(corner.entry, mid, corner.exit), radius, 1e-9),
    'emitted arc points must lie on a circle of radius 8',
  )
  // The arc's sampled midpoint approaches the apex within the chord error of
  // the 5° tessellation, but still far closer than the old 5-radius fillet
  // (which clears 5*(sqrt(2)-1) = 2.07).
  const clearance = minDistanceTo(plan.points, { x: 20, y: 0 })
  assert(
    approx(clearance, radius * (Math.SQRT2 - 1), 0.05),
    `apex clearance must match an 8-radius fillet, got ${clearance.toFixed(4)}`,
  )
  for (const transition of plan.transitions) {
    assert(approx(transition.effectiveRadius, radius, 1e-9), 'every corner of the split square attains radius 8')
  }
  assert(!hasProperIntersection(plan.points), 'planned contour must not self-intersect')
  console.log('isolated corner exceeds the old half-edge cap: PASSED')
}

function testAdjacentTurnsShareShortEdge() {
  console.log('Testing adjacent turns competing for one short edge share it without overlap...')
  const rectangle: Point[] = [
    { x: 0, y: 0 },
    { x: 6, y: 0 },
    { x: 6, y: 20 },
    { x: 0, y: 20 },
  ]

  // Request 5 on the 6-unit edges: each corner wants a 5-unit setback but two
  // corners compete for every short edge, so all four scale to ~3.
  const conflicted = planContourSmoothing(rectangle, 5)
  assert(conflicted.transitions.length === 4, 'all four corners are rounded')
  for (const transition of conflicted.transitions) {
    assert(
      approx(transition.effectiveRadius, 3, 1e-5),
      `conflicting setbacks must scale to ~3, got ${transition.effectiveRadius}`,
    )
  }
  const firstCorner = conflicted.transitions.find((transition) => transition.firstIndex === 0)
  const secondCorner = conflicted.transitions.find((transition) => transition.firstIndex === 1)
  assert(
    firstCorner !== undefined && secondCorner !== undefined,
    'the two corners on the short edge are both planned',
  )
  assert(
    firstCorner.exit.x < secondCorner.entry.x,
    'exit of the first corner must precede the entry of the second along the shared edge',
  )
  assert(secondCorner.entry.x - firstCorner.exit.x > 0, 'an epsilon connector remains between the setbacks')
  assert(!hasProperIntersection(conflicted.points), 'conflicted output must not self-intersect')
  assert(maxDeflectionDeg(conflicted.points) < 10, 'conflicted output stays smooth')

  // Request 2 fits without conflict: nothing scales and every corner keeps 2.
  const free = planContourSmoothing(rectangle, 2)
  for (const transition of free.transitions) {
    assert(
      approx(transition.effectiveRadius, 2, 1e-9),
      `non-conflicting setbacks must stay at the request, got ${transition.effectiveRadius}`,
    )
  }
  console.log('adjacent turns share a short edge: PASSED')
}

function testMultiVertexTurnRunBecomesOneTransition() {
  console.log('Testing a multi-vertex same-sign turn run becomes one broad tangent transition...')
  const plan8 = planContourSmoothing(ARC_CORNER_CONTOUR, 8)
  const run = plan8.transitions.find((transition) => transition.runIndices.length === 5)
  assert(run !== undefined, 'the five tessellated arc vertices must collapse into one transition')
  assert(
    run.firstIndex === 1 && run.lastIndex === 5,
    `the transition must span source indices 1..5, got ${run.firstIndex}..${run.lastIndex}`,
  )
  assert(
    run.runIndices.join(',') === '1,2,3,4,5',
    'metadata must list every vertex of the source run in order',
  )
  assert(approx(run.effectiveRadius, 8, 1e-5), `one broad transition must reach radius 8, got ${run.effectiveRadius}`)
  assert(approx(run.entry.x, 4, 1e-9) && approx(run.entry.y, -4, 1e-9), `entry must be (4,-4), got (${run.entry.x}, ${run.entry.y})`)
  assert(approx(run.exit.x, -4, 1e-9) && approx(run.exit.y, 4, 1e-9), `exit must be (-4,4), got (${run.exit.x}, ${run.exit.y})`)
  assert(
    run.transitionPoints.length >= 19,
    `the broad arc must stay tessellated, got ${run.transitionPoints.length} points`,
  )
  assert(!hasProperIntersection(plan8.points), 'planned contour must not self-intersect')

  const plan12 = planContourSmoothing(ARC_CORNER_CONTOUR, 12)
  const run12 = plan12.transitions.find((transition) => transition.runIndices.length === 5)
  assert(run12 !== undefined, 'the same run exists at radius 12')
  assert(
    approx(run12.effectiveRadius, 12, 1e-5) && run12.effectiveRadius > run.effectiveRadius + 3.9,
    `changing the request must materially change the fitted radius, got ${run12.effectiveRadius}`,
  )
  console.log('multi-vertex run becomes one broad transition: PASSED')
}

function testSmootherRunStaysUnchanged() {
  console.log('Testing a source arc already smoother than the request stays unchanged...')
  // Request 3 against a quarter arc of radius 4: the run's fitted local radius
  // already exceeds the request, so its vertices must survive verbatim.
  const plan = planContourSmoothing(ARC_CORNER_CONTOUR, 3)
  assert(plan.transitions.length === 3, `only the three sharp corners are rounded, got ${plan.transitions.length}`)
  for (const transition of plan.transitions) {
    assert(
      transition.runIndices.every((index) => index === 0 || index === 6 || index === 7),
      'no transition may cover any vertex of the smooth source arc',
    )
  }
  for (let index = 1; index <= 5; index += 1) {
    const vertex = ARC_CORNER_CONTOUR[index]
    assert(
      plan.points.some((point) => point.x === vertex.x && point.y === vertex.y),
      `arc vertex ${index} must survive verbatim`,
    )
  }
  console.log('smoother source run unchanged: PASSED')
}

function testFailClosedDegenerateCases() {
  console.log('Testing degenerate and unstable cases fail closed deterministically...')

  // Duplicate closing vertex: identical to the seam-free ring.
  const withSeam: Point[] = [...SQUARE, { x: 0, y: 0 }]
  assert(
    pointsEqual(roundContourCorners(withSeam, 4), roundContourCorners(SQUARE, 4)),
    'a duplicated closing vertex must not corrupt cyclic indexing',
  )

  // Zero-length edge: the duplicated vertex survives verbatim, corners round.
  const zeroEdge: Point[] = [
    { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0 },
    { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 },
  ]
  const zeroPlan = planContourSmoothing(zeroEdge, 4)
  assert(zeroPlan.transitions.length === 4, 'the four real corners are rounded')
  assert(
    zeroPlan.points.filter((point) => point.x === 10 && point.y === 0).length === 2,
    'both copies of the duplicated vertex are preserved',
  )
  assert(zeroPlan.points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)), 'no NaN output')

  // Tiny contour: every edge below the epsilon — identity.
  const tiny: Point[] = [{ x: 0, y: 0 }, { x: 1e-12, y: 0 }, { x: 0, y: 1e-12 }]
  const tinyPlan = planContourSmoothing(tiny, 2)
  assert(tinyPlan.points === tiny && tinyPlan.transitions.length === 0, 'tiny contour fails closed to identity')

  // Non-finite input: identity.
  const nanContour: Point[] = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: NaN, y: 20 }, { x: 0, y: 20 }]
  const nanPlan = planContourSmoothing(nanContour, 4)
  assert(nanPlan.points === nanContour && nanPlan.transitions.length === 0, 'non-finite input fails closed to identity')

  // Near-reversal slot turnaround: the two 90° vertices at the top of a 2-wide
  // slot make a 180° U-turn. Their run's shoulders are parallel, so the run
  // must decline and the vertices must never merge into one doubled-back arc.
  const uTurn: Point[] = [
    { x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 4 }, { x: 4, y: 4 },
    { x: 4, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 },
  ]
  assert(!hasProperIntersection(uTurn), 'the slot contour itself must be simple')
  const uPlan = planContourSmoothing(uTurn, 4)
  for (const transition of uPlan.transitions) {
    assert(transition.runIndices.length === 1, 'the hairpin vertices must stay single-vertex transitions')
  }
  assert(uPlan.points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)), 'no NaN output')
  assert(!hasProperIntersection(uPlan.points), 'hairpin output must not self-intersect')

  // Behind-apex shoulder: with a request smaller than the apex distance of the
  // three-vertex chamfer run, the run must decline and fall back per vertex.
  const chamfer: Point[] = [
    { x: 12, y: 0 }, { x: 4, y: 0 }, { x: 1, y: 1 },
    { x: 0, y: 4 }, { x: 0, y: 12 }, { x: 12, y: 12 },
  ]
  const tight = planContourSmoothing(chamfer, 1)
  for (const transition of tight.transitions) {
    assert(transition.runIndices.length === 1, 'behind-apex run must fail closed to single-vertex fallback')
  }
  // The same chamfer at radius 6 (beyond the apex distance 4) is one clean run.
  const roomy = planContourSmoothing(chamfer, 6)
  const chamferRun = roomy.transitions.find((transition) => transition.runIndices.length === 3)
  assert(chamferRun !== undefined, 'radius 6 must group the chamfer into one run')
  assert(chamferRun.runIndices.join(',') === '1,2,3', 'the run names the three chamfer vertices')
  assert(approx(chamferRun.effectiveRadius, 6, 1e-5), 'the chamfer run attains the request once the apex fits')
  console.log('degenerate cases fail closed: PASSED')
}

function testOrientationReversalEquivalent() {
  console.log('Testing orientation reversal produces equivalent geometry in reverse order...')
  const forward = roundContourCorners(SPLIT_SQUARE, 8)
  const reversedInput = SPLIT_SQUARE.slice().reverse()
  const reversed = roundContourCorners(reversedInput, 8)
  assert(reversed.length === forward.length, 'reversed output keeps the same point count')
  const tolerance = 1e-9
  for (let index = 0; index < forward.length; index += 1) {
    const expected = forward[forward.length - 1 - index]
    const actual = reversed[index]
    const scale = Math.max(1, Math.abs(expected.x), Math.abs(expected.y))
    assert(
      approx(actual.x, expected.x, tolerance * scale) && approx(actual.y, expected.y, tolerance * scale),
      `reversed point ${index} must mirror forward point ${forward.length - 1 - index}`,
    )
  }
  console.log('orientation reversal: PASSED')
}

function testScaleEquivalence() {
  console.log('Testing a scaled copy of the contour/radius produces the scaled result...')
  const scale = 3
  const base = planContourSmoothing(SPLIT_SQUARE, 8)
  const scaledInput = SPLIT_SQUARE.map((point) => ({ x: point.x * scale, y: point.y * scale }))
  const scaled = planContourSmoothing(scaledInput, 8 * scale)
  // Arc tessellation counts can differ by one at the ceil(|sweep|/step)
  // boundary (float jitter), so compare the geometric contract rather than
  // sample positions: same runs, exactly scaled radii and tangent points, and
  // every emitted point on the same circle as its unscaled counterpart.
  assert(scaled.transitions.length === base.transitions.length, 'same number of transitions')
  for (let index = 0; index < base.transitions.length; index += 1) {
    const b = base.transitions[index]
    const s = scaled.transitions[index]
    assert(b.firstIndex === s.firstIndex && b.lastIndex === s.lastIndex, 'same source runs')
    assert(approx(s.effectiveRadius, b.effectiveRadius * scale, 1e-9), 'effective radius scales exactly')
    assert(approx(s.entry.x, b.entry.x * scale, 1e-9) && approx(s.entry.y, b.entry.y * scale, 1e-9), 'entry scales exactly')
    assert(approx(s.exit.x, b.exit.x * scale, 1e-9) && approx(s.exit.y, b.exit.y * scale, 1e-9), 'exit scales exactly')
    assert(
      Math.abs(s.transitionPoints.length - b.transitionPoints.length) <= 1,
      'tessellation count matches within the ceil boundary',
    )
    // Both arcs share a centre on the (scaled) bisector: entry/exit and the
    // arc midpoint of one side must lie on the other side's circle.
    const bMid = b.transitionPoints[Math.floor(b.transitionPoints.length / 2)]
    const bRadius = circumradius(b.entry, bMid, b.exit)
    const sMid = s.transitionPoints[Math.floor(s.transitionPoints.length / 2)]
    const sRadius = circumradius(s.entry, sMid, s.exit)
    assert(approx(sRadius, bRadius * scale, 1e-9), 'arc radius scales exactly')
    // Every sampled point of each arc lies on the same circle.
    for (const point of s.transitionPoints) {
      if (point === s.entry || point === s.exit) continue
      assert(approx(circumradius(s.entry, point, s.exit), sRadius, 1e-9), 'scaled arc points are on one circle')
    }
    for (const point of b.transitionPoints) {
      if (point === b.entry || point === b.exit) continue
      assert(approx(circumradius(b.entry, point, b.exit), bRadius, 1e-9), 'base arc points are on one circle')
    }
  }
  console.log('scale equivalence: PASSED')
}

function testSeamInvariantTurnRuns() {
  console.log('Testing a same-sign turn run split across the seam merges like any other...')
  const base = planContourSmoothing(ARC_CORNER_CONTOUR, 8)
  const seam = planContourSmoothing(rotateRing(ARC_CORNER_CONTOUR, 3), 8)

  assert(
    seam.transitions.length === base.transitions.length,
    'rotation must not change the number of transitions',
  )

  // Old source indices 1..5 (the five tessellated arc vertices) map to rotated
  // indices 6,7,0,1,2: the same broad turn, now split across the seam.
  const seamRun = seam.transitions.find((transition) => transition.runIndices.length === 5)
  assert(seamRun !== undefined, 'the broad arc run must still be found as one transition')
  assert(
    seamRun.firstIndex === 6 && seamRun.lastIndex === 2,
    `the transition must span cyclic source indices 6..2, got ${seamRun.firstIndex}..${seamRun.lastIndex}`,
  )
  assert(
    seamRun.runIndices.join(',') === '6,7,0,1,2',
    'runIndices must list every vertex of the wrapped run in contour order',
  )
  assert(seamRun.entryEdgeIndex === 5, 'the entry setback comes from edge 5 (the edge into rotated index 6)')
  assert(seamRun.exitEdgeIndex === 2, 'the exit setback comes from edge 2 (the edge out of rotated index 2)')

  const baseRun = base.transitions.find((transition) => transition.runIndices.length === 5)
  assert(baseRun !== undefined, 'the base plan has the same broad run away from the seam')
  assert(
    approx(seamRun.signedTurn, baseRun.signedTurn, 1e-12),
    'the wrapped run accumulates the same signed turn',
  )
  assert(
    approx(seamRun.effectiveRadius, baseRun.effectiveRadius, 1e-9),
    'the wrapped run attains the same effective radius',
  )
  assert(
    approx(seamRun.entry.x, baseRun.entry.x, 1e-9) && approx(seamRun.entry.y, baseRun.entry.y, 1e-9)
      && approx(seamRun.exit.x, baseRun.exit.x, 1e-9) && approx(seamRun.exit.y, baseRun.exit.y, 1e-9),
    'entry and exit are the same geometric tangent points',
  )

  // Every other transition must map onto a base transition shifted back by the
  // rotation, with the same source span, turn, and tangent points.
  const rotation = 3
  const baseSignatures = base.transitions.map((transition) => ({
    indices: transition.runIndices.join(','),
    turn: transition.signedTurn,
    entry: transition.entry,
    exit: transition.exit,
  }))
  for (const transition of seam.transitions) {
    const mapped = transition.runIndices
      .map((index) => (index + rotation) % ARC_CORNER_CONTOUR.length)
      .join(',')
    assert(
      baseSignatures.some((signature) => signature.indices === mapped
        && approx(signature.turn, transition.signedTurn, 1e-12)
        && approx(signature.entry.x, transition.entry.x, 1e-9)
        && approx(signature.entry.y, transition.entry.y, 1e-9)
        && approx(signature.exit.x, transition.exit.x, 1e-9)
        && approx(signature.exit.y, transition.exit.y, 1e-9)),
      `rotated transition ${transition.runIndices.join(',')} must match a base transition`,
    )
  }

  assert(
    cyclicPointsEquivalent(seam.points, base.points, 1e-9),
    'the emitted contour must be the same closed ring regardless of the seam',
  )
  assert(!hasProperIntersection(seam.points), 'the seam-split plan must not self-intersect')
  console.log('seam-invariant turn runs: PASSED')
}

function testSelfIntersectingPlanFailsClosed() {
  console.log('Testing a planned contour that would self-intersect fails closed to the source...')
  // A square with a bottom notch and a right-edge notch. At radius 14 the
  // vertices (26,0) and (40,14) group into one turn run whose tangent arc cuts
  // across the notched region; the source contour itself is simple, so the
  // crossing is introduced by the rounding. Found by a deterministic search
  // over notched rectangles, run against an unguarded copy of the module:
  // only radius 14 of {6,8,10,12,14} produces a crossing.
  const { contour, radius } = SELF_INTERSECT_CASE
  assert(!hasProperIntersection(contour), 'the source contour must be simple')
  const plan = planContourSmoothing(contour, radius)
  assert(
    plan.points === contour,
    'self-intersecting plan must return the unchanged source geometry',
  )
  assert(plan.transitions.length === 0, 'no transition survives the self-intersection guard')
  console.log('self-intersecting plan fails closed: PASSED')
}

const SELF_INTERSECT_CASE = {
  contour: [
    { x: 23, y: 0 },
    { x: 23, y: -13 },
    { x: 26, y: -13 },
    { x: 26, y: 0 },
    { x: 40, y: 14 },
    { x: 44, y: 14 },
    { x: 44, y: 19 },
    { x: 40, y: 19 },
  ],
  radius: 14,
}

/**
 * The base notches of SELF_INTERSECT_CASE with two long collinear stretches
 * inserted: 70 vertices along the edge below the (26,0) corner and 30 along
 * the diagonal back edge. The unchanged vertices separate the corner
 * transitions in the emitted contour, and the rounding arc of the (26,0)/(40,14)
 * corner run cuts across the middle of the subdivided diagonal — the crossing
 * pair is a changed arc segment and an unchanged source segment, both sitting
 * far beyond every segment the old position bookkeeping would have marked.
 * Verified by running the planner with the guard disabled: radius 14 produces
 * proper crossings, and the old bookkeeping (position advanced by transition
 * point counts only) marks neither segment of either crossing pair, so the
 * old guard returned the crossed contour instead of failing closed.
 */
const SELF_INTERSECT_BOOKKEEPING_CASE: Point[] = (() => {
  const { contour } = SELF_INTERSECT_CASE
  return [
    contour[0], contour[1], contour[2],
    ...subdivideEdge(contour[2], contour[3], 70),
    contour[3], contour[4], contour[5], contour[6], contour[7],
    ...subdivideEdge(contour[7], contour[0], 30),
  ]
})()

function testSeparatedTransitionsCheckedForCrossing() {
  console.log('Testing a crossing past unchanged vertices between transitions fails closed...')
  const contour = SELF_INTERSECT_BOOKKEEPING_CASE
  assert(!hasProperIntersection(contour), 'the source contour must be simple')
  const plan = planContourSmoothing(contour, SELF_INTERSECT_CASE.radius)
  assert(
    plan.points === contour,
    'the crossed plan must return the unchanged source geometry',
  )
  assert(
    plan.transitions.length === 0,
    'no transition survives the whole-contour crossing guard',
  )
  console.log('separated transitions checked for crossing: PASSED')
}

function testDeterminism() {
  console.log('Testing the planner is deterministic...')
  const first = planContourSmoothing(ARC_CORNER_CONTOUR, 8)
  const second = planContourSmoothing(ARC_CORNER_CONTOUR, 8)
  assert(JSON.stringify(first) === JSON.stringify(second), 'two identical calls must produce identical plans')
  console.log('determinism: PASSED')
}

/**
 * A four-vertex ring whose 106-degree turn run (vertices 0..1) sits between a
 * 39.6-long edge and a 2.24-long one. The short edge is shared with the next
 * corner, so the run's exit setback is scaled down hard while its entry apex
 * stays far out along the long edge. Before the shoulder guard the allocation
 * pulled the run's apex distance below its entry apex distance and the entry
 * tangent point landed 1.61 *past* source vertex 0 — the emitted path left the
 * ring along the extended edge instead of easing off the corner.
 */
const STARVED_SHOULDER_CONTOUR: Point[] = [
  { x: 15, y: 28 },
  { x: 14, y: 31 },
  { x: 12, y: 30 },
  { x: 22, y: -11 },
]

/** Signed setback of `point` from `vertex` along the direction to `toward`. */
function setbackAlong(vertex: Point, toward: Point, point: Point): number {
  const dx = toward.x - vertex.x
  const dy = toward.y - vertex.y
  const length = Math.hypot(dx, dy)
  if (length <= 0) return 0
  return ((point.x - vertex.x) * dx + (point.y - vertex.y) * dy) / length
}

function testTangentPointsStayOnTheirShoulderEdges() {
  console.log('Testing a starved shoulder declines the turn instead of overshooting the vertex...')
  const contour = STARVED_SHOULDER_CONTOUR
  const count = contour.length
  const plan = planContourSmoothing(contour, 4.5)

  for (const transition of plan.transitions) {
    // The entry tangent point must sit on the edge running INTO the run, i.e.
    // a non-negative distance back from the run's first vertex, and no farther
    // than that edge is long. Same for the exit on the edge leaving the run.
    const firstVertex = contour[transition.firstIndex]
    const beforeFirst = contour[(transition.firstIndex - 1 + count) % count]
    const entrySetback = setbackAlong(firstVertex, beforeFirst, transition.entry)
    assert(
      entrySetback >= -1e-9,
      `entry of run ${transition.firstIndex}..${transition.lastIndex} overshoots its vertex by `
        + `${(-entrySetback).toFixed(4)}; it must stay on the incoming shoulder edge`,
    )
    assert(
      entrySetback <= dist(firstVertex, beforeFirst) + 1e-9,
      'entry must not reach past the far end of the incoming shoulder edge',
    )

    const lastVertex = contour[transition.lastIndex]
    const afterLast = contour[(transition.lastIndex + 1) % count]
    const exitSetback = setbackAlong(lastVertex, afterLast, transition.exit)
    assert(
      exitSetback >= -1e-9,
      `exit of run ${transition.firstIndex}..${transition.lastIndex} overshoots its vertex by `
        + `${(-exitSetback).toFixed(4)}; it must stay on the outgoing shoulder edge`,
    )
    assert(
      exitSetback <= dist(lastVertex, afterLast) + 1e-9,
      'exit must not reach past the far end of the outgoing shoulder edge',
    )
  }

  // The 0..1 run is the one that cannot be funded, so it keeps source geometry.
  assert(
    !plan.transitions.some((transition) => transition.firstIndex === 0 && transition.lastIndex === 1),
    'the starved run must be declined, not emitted with a tangent point inside the run',
  )
  assert(
    plan.points.some((point) => approx(point.x, contour[0].x, 1e-9) && approx(point.y, contour[0].y, 1e-9))
      && plan.points.some((point) => approx(point.x, contour[1].x, 1e-9) && approx(point.y, contour[1].y, 1e-9)),
    'the declined run keeps its exact source vertices',
  )
  // Declining one turn must not stop the fundable corners from rounding.
  assert(plan.transitions.length > 0, 'the remaining corners still round')
  assert(!hasProperIntersection(plan.points), 'the emitted contour stays simple')
  console.log('tangent points stay on their shoulder edges: PASSED')
}

/**
 * Five vertices whose two longest same-sign candidates tie on length. The
 * winner claims vertices the loser then cannot use, so an index-ordered
 * tie-break re-grouped the whole ring depending on where the seam fell: shifted
 * by two this contour used to emit 3 transitions and 72 points where every
 * other rotation emitted 4 and 78.
 */
const TIED_CANDIDATES_CONTOUR: Point[] = [
  { x: -17, y: -1 },
  { x: -19, y: -8 },
  { x: -18, y: -12 },
  { x: -15, y: -13 },
  { x: 14, y: -10 },
]

function testGroupingIsSeamInvariantUnderEveryRotation() {
  console.log('Testing tied turn-run candidates group the same way from every seam...')
  for (const contour of [TIED_CANDIDATES_CONTOUR, ARC_CORNER_CONTOUR, SELF_INTERSECT_CASE.contour]) {
    const radius = contour === SELF_INTERSECT_CASE.contour ? 6 : 4.5
    const base = planContourSmoothing(contour, radius)
    for (let shift = 1; shift < contour.length; shift += 1) {
      const rotated = rotateRing(contour, shift)
      const plan = planContourSmoothing(rotated, radius)
      assert(
        plan.transitions.length === base.transitions.length,
        `rotating by ${shift} changed the transition count `
          + `${base.transitions.length} -> ${plan.transitions.length}`,
      )
      assert(
        plan.points.length === base.points.length,
        `rotating by ${shift} changed the emitted point count `
          + `${base.points.length} -> ${plan.points.length}`,
      )
      assert(
        cyclicPointsEquivalent(plan.points, base.points, 1e-9),
        `rotating by ${shift} produced a different curve`,
      )
    }
  }
  console.log('grouping is seam-invariant under every rotation: PASSED')
}

/**
 * A coarsely tessellated corner: vertices 0..2 turn 33.9 and 35.9 degrees. Any
 * three points fit a circle exactly, so a vertex-only smoothness test reports
 * 0.000% deviation at a fitted radius of 2.125 and shields this corner from a
 * request of 2. Measuring the polyline puts the segment midpoints 5.4% off that
 * circle, which is what a 34-degree-per-vertex path actually is.
 */
const COARSE_TURN_CONTOUR: Point[] = [
  { x: 29.182, y: -0.862 },
  { x: 29.819, y: 0.359 },
  { x: 29.697, y: 1.453 },
  { x: 28.817, y: 2.422 },
  { x: -27.355, y: -0.064 },
  { x: 18.501, y: -9.586 },
]

/**
 * A genuinely smooth source arc: vertices 0..4 track a circle of radius 5.896
 * to within 1.6%. A request of 4.5 is *narrower* than the source, so the run
 * must be left alone — rounding any part of it would tighten an arc that is
 * already broader than what was asked for.
 */
const BROADER_THAN_REQUEST_ARC: Point[] = [
  { x: 23.908, y: 13.747 },
  { x: 23.488, y: 15.989 },
  { x: 22.711, y: 17.719 },
  { x: 21.575, y: 18.934 },
  { x: 20.081, y: 19.636 },
  { x: -10.863, y: 22.482 },
]

function testSmoothnessIsMeasuredOnThePathNotTheVertices() {
  console.log('Testing a coarse turn is rounded and a broader-than-request arc is not...')

  // Sharp side: the three-point run must be rounded despite fitting a circle
  // through its vertices exactly.
  const coarse = planContourSmoothing(COARSE_TURN_CONTOUR, 2)
  const rounded = coarse.transitions.find(
    (transition) => transition.firstIndex === 0 && transition.lastIndex === 2,
  )
  assert(
    rounded !== undefined,
    'the 34-degree-per-vertex run must be rounded, not mistaken for a smooth arc',
  )
  assert(
    rounded.effectiveRadius > 0 && rounded.effectiveRadius <= 2 + 1e-9,
    `the rounded run must honour the request, got ${rounded.effectiveRadius}`,
  )
  assert(!hasProperIntersection(coarse.points), 'the rounded coarse turn stays simple')

  // Smooth side: an arc already broader than the request keeps every vertex.
  const arc = planContourSmoothing(BROADER_THAN_REQUEST_ARC, 4.5)
  assert(
    !arc.transitions.some((transition) => transition.runIndices.some((index) => index <= 4)),
    'a source arc broader than the request must not be tightened by rounding part of it',
  )
  for (let index = 0; index <= 4; index += 1) {
    const vertex = BROADER_THAN_REQUEST_ARC[index]
    assert(
      arc.points.some((point) => approx(point.x, vertex.x, 1e-9) && approx(point.y, vertex.y, 1e-9)),
      `source vertex ${index} of the broad arc must survive unchanged`,
    )
  }
  console.log('smoothness measured on the path, not the vertices: PASSED')
}

try {
  testIdentityWhenDisabled()
  testRoundsSquareCorners()
  testHugeRadiusStaysInsideBox()
  testShallowCornersPreserved()
  testAcuteCornerRetreatBounded()
  testIsolatedCornerExceedsOldHalfEdgeCap()
  testAdjacentTurnsShareShortEdge()
  testMultiVertexTurnRunBecomesOneTransition()
  testSmootherRunStaysUnchanged()
  testSmoothnessIsMeasuredOnThePathNotTheVertices()
  testFailClosedDegenerateCases()
  testOrientationReversalEquivalent()
  testScaleEquivalence()
  testSeamInvariantTurnRuns()
  testGroupingIsSeamInvariantUnderEveryRotation()
  testTangentPointsStayOnTheirShoulderEdges()
  testSelfIntersectingPlanFailsClosed()
  testSeparatedTransitionsCheckedForCrossing()
  testDeterminism()
  console.log('\nAll offsetSmoothing tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
