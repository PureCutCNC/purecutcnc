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
 * Unit tests for the full-radius corner arc search (issue #546, slice S3).
 *
 * Run with: npx tsx src/engine/toolpaths/broadCornerArc.test.ts
 */

import type { Point } from '../../types/project'
import { findBroadCornerArc, type BroadCornerArc } from './broadCornerArc'

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function edgeOf(ring: Point[], index: number): { from: Point; to: Point; ux: number; uy: number; length: number } {
  const from = ring[index % ring.length]
  const to = ring[(index + 1) % ring.length]
  const length = Math.hypot(to.x - from.x, to.y - from.y)
  return { from, to, ux: (to.x - from.x) / length, uy: (to.y - from.y) / length, length }
}

/** Distance from a point to a segment. */
function segmentDistance(point: Point, from: Point, to: Point): number {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared <= 1e-18) return Math.hypot(point.x - from.x, point.y - from.y)
  const t = Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared))
  return Math.hypot(point.x - (from.x + dx * t), point.y - (from.y + dy * t))
}

/**
 * Every property the arc must have to be usable, asserted numerically rather
 * than by comparing against remembered coordinates: tangency to the two named
 * source edges, both tangent points inside their own segments, and a circle
 * with nothing of the ring inside it.
 */
function assertTangentAndClear(ring: Point[], arc: BroadCornerArc, label: string): void {
  for (const [edgeIndex, tangent, side] of [
    [arc.entryEdge, arc.entry, 'entry'],
    [arc.exitEdge, arc.exit, 'exit'],
  ] as const) {
    const edge = edgeOf(ring, edgeIndex)
    assert(segmentDistance(tangent, edge.from, edge.to) <= 1e-9,
      `${label}: the ${side} tangent point lies on its own source segment`)
    const parameter = ((tangent.x - edge.from.x) * edge.ux + (tangent.y - edge.from.y) * edge.uy) / edge.length
    assert(parameter >= -1e-9 && parameter <= 1 + 1e-9,
      `${label}: the ${side} tangent point lies inside its segment, not on its extension`)
    assert(Math.abs(Math.hypot(tangent.x - arc.centre.x, tangent.y - arc.centre.y) - arc.radius) <= 1e-9,
      `${label}: the ${side} tangent point is exactly one radius from the centre`)
    const radial = { x: tangent.x - arc.centre.x, y: tangent.y - arc.centre.y }
    assert(Math.abs(radial.x * edge.ux + radial.y * edge.uy) <= 1e-9,
      `${label}: the arc is tangent to the ${side} edge, so it rejoins without a kink`)
  }
  for (let index = 0; index < ring.length; index += 1) {
    if (index === arc.entryEdge || index === arc.exitEdge) continue
    const edge = edgeOf(ring, index)
    assert(segmentDistance(arc.centre, edge.from, edge.to) >= arc.radius - 1e-7,
      `${label}: no part of the ring lies inside the arc's circle`)
  }
}

/**
 * A crescent: one long straight chord, and a circular arc tessellated into
 * chords a fraction of the requested radius long running into each end of it.
 * The two corners are the shape an island's rounded offset leaves where it
 * meets a pocket wall — sharp, but reached through nothing but short edges.
 */
function tessellatedCrescent(steps = 160): Point[] {
  const radius = 5
  const half = (80 * Math.PI) / 180
  const ring: Point[] = []
  for (let step = 0; step <= steps; step += 1) {
    const angle = Math.PI - half + (2 * half * step) / steps
    ring.push({ x: radius + radius * Math.cos(angle), y: radius * Math.sin(angle) })
  }
  return ring
}

/** The sharpest turn on the ring, with the sign the search needs. */
function sharpestCorner(ring: Point[]): { index: number; turn: number } {
  let best = { index: 0, turn: 0 }
  for (let index = 0; index < ring.length; index += 1) {
    const previous = ring[(index + ring.length - 1) % ring.length]
    const point = ring[index]
    const next = ring[(index + 1) % ring.length]
    let turn = Math.atan2(next.y - point.y, next.x - point.x)
      - Math.atan2(point.y - previous.y, point.x - previous.x)
    while (turn > Math.PI) turn -= 2 * Math.PI
    while (turn <= -Math.PI) turn += 2 * Math.PI
    if (Math.abs(turn) > Math.abs(best.turn)) best = { index, turn }
  }
  return best
}

function testSquareCornerJamsOnItsOwnTwoEdges(): void {
  const square: Point[] = [
    { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 },
  ]
  const arc = findBroadCornerArc({
    points: square, apexFirst: 1, apexLast: 1, turnSign: 1, radius: 5,
  })
  assert(arc !== null, 'an isolated square corner admits a full-radius arc')
  assert(arc.entryEdge === 0 && arc.exitEdge === 1,
    'the arc jams against the two edges adjacent to the corner')
  assert(arc.span === 1, 'it cuts across exactly the corner vertex')
  assert(Math.abs(arc.sweep - Math.PI / 2) <= 1e-9, 'a square corner sweeps 90 degrees')
  assert(Math.abs(arc.entry.x - 15) <= 1e-9 && Math.abs(arc.entry.y) <= 1e-9,
    'the tangent point sits one radius back from the apex')
  assertTangentAndClear(square, arc, 'square')
  console.log('square corner jams on its own two edges: PASSED')
}

function testTessellatedCornerReachesTheFullRadius(): void {
  const ring = tessellatedCrescent()
  const corner = sharpestCorner(ring)
  const radius = 1
  const arc = findBroadCornerArc({
    points: ring, apexFirst: corner.index, apexLast: corner.index,
    turnSign: corner.turn >= 0 ? 1 : -1, radius,
  })
  assert(arc !== null, 'the tessellated corner admits a full-radius arc')
  assert(arc.radius === radius, 'the arc is emitted at exactly the requested radius')
  assert(arc.span > 1,
    'reaching the full radius means cutting across source vertices, not one edge')
  assertTangentAndClear(ring, arc, 'tessellated')
  // The point of the slice: the ordinary construction is starved by the short
  // tessellation edges, and this is not. The setback it could take is one
  // edge, so the radius it could reach is a fraction of the request.
  const incoming = edgeOf(ring, (corner.index - 1 + ring.length) % ring.length)
  const starved = incoming.length * Math.tan((Math.PI - Math.abs(corner.turn)) / 2)
  assert(incoming.length < radius / 5,
    'the edge reaching the corner is a small fraction of the requested radius')
  assert(starved < radius / 4,
    'a fillet built from that edge alone would come out under a quarter of the request')
  console.log('tessellated corner reaches the full radius: PASSED')
}

function testSweepMatchesTheSourcePathItReplaces(): void {
  const ring = tessellatedCrescent()
  const corner = sharpestCorner(ring)
  const arc = findBroadCornerArc({
    points: ring, apexFirst: corner.index, apexLast: corner.index,
    turnSign: corner.turn >= 0 ? 1 : -1, radius: 1,
  })
  assert(arc !== null, 'the tessellated corner admits an arc')
  let sourceTurn = 0
  for (let offset = 1; offset <= arc.span; offset += 1) {
    const index = (arc.entryEdge + offset) % ring.length
    const previous = edgeOf(ring, (index - 1 + ring.length) % ring.length)
    const next = edgeOf(ring, index)
    let turn = Math.atan2(next.uy, next.ux) - Math.atan2(previous.uy, previous.ux)
    while (turn > Math.PI) turn -= 2 * Math.PI
    while (turn <= -Math.PI) turn += 2 * Math.PI
    sourceTurn += turn
  }
  assert(Math.abs(arc.sweep - sourceTurn) <= 1e-6,
    'the arc turns by exactly as much as the source path it replaces')
  console.log('sweep matches the source path it replaces: PASSED')
}

function testCorridorNarrowerThanTwoRadiiDeclines(): void {
  // A sliver 0.30 wide cannot hold a circle of radius 0.25, however sharp its
  // corners are. Declining is the whole safety story: the caller keeps its
  // existing geometry instead of getting an arc that leaves the material.
  const ring: Point[] = [
    { x: 0, y: 0 }, { x: 0.3, y: 0 }, { x: 0.3, y: 6 }, { x: 0, y: 6 },
  ]
  const arc = findBroadCornerArc({
    points: ring, apexFirst: 1, apexLast: 1, turnSign: 1, radius: 0.25,
  })
  assert(arc === null, 'a corridor narrower than two radii declines')
  const fits = findBroadCornerArc({
    points: ring, apexFirst: 1, apexLast: 1, turnSign: 1, radius: 0.1,
  })
  assert(fits !== null, 'the same corner admits an arc that does fit')
  console.log('corridor narrower than two radii declines: PASSED')
}

function testOppositeWallBlocksTheCircle(): void {
  // The blocking segment is the far wall, which is nowhere near the corner in
  // index order — a search that only checked the local window would miss it.
  const ring: Point[] = [
    { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 0.6 }, { x: 2, y: 0.6 },
    { x: 2, y: 4 }, { x: 0, y: 4 },
  ]
  const blocked = findBroadCornerArc({
    points: ring, apexFirst: 1, apexLast: 1, turnSign: 1, radius: 0.5,
  })
  assert(blocked === null, 'the opposite wall keeps a half-radius circle out of the corner')
  const clear = findBroadCornerArc({
    points: ring, apexFirst: 1, apexLast: 1, turnSign: 1, radius: 0.25,
  })
  assert(clear !== null, 'a circle that fits between the walls is accepted')
  assertTangentAndClear(ring, clear, 'blocked corner')
  console.log('opposite wall blocks the circle: PASSED')
}

function testTangentPointFallingOffAShortEdgeWalksFurtherOut(): void {
  // The last edge before the corner is a 0.2 stub, collinear with a long run
  // behind it. The tangent point for a radius-2 arc sits 2 back from the apex,
  // which is on the long edge, not the stub. Taking the stub anyway would put
  // the emitted tangent point on the stub's *extension* — off the path — which
  // is the kink the whole construction exists to avoid.
  const ring: Point[] = [
    { x: 0, y: 0 }, { x: 9.8, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 },
  ]
  const arc = findBroadCornerArc({
    points: ring, apexFirst: 2, apexLast: 2, turnSign: 1, radius: 2,
  })
  assert(arc !== null, 'the corner admits an arc')
  assert(arc.entryEdge === 0,
    'the arc reaches back past the stub to the edge that can actually hold its tangent point')
  assert(Math.abs(arc.entry.x - 8) <= 1e-9 && Math.abs(arc.entry.y) <= 1e-9,
    'the tangent point sits one setback back from the apex, on the long edge')
  assertTangentAndClear(ring, arc, 'short stub')
  console.log('a tangent point falling off a short edge walks further out: PASSED')
}

/**
 * Invariant fuzz. Every arc the search returns, on any ring, must be tangent
 * to its two named edges inside their own segments, must have nothing of the
 * ring inside its circle, and must turn by exactly as much as the source path
 * it replaces. Rings are perturbed deterministically — never Math.random, so a
 * failure is reproducible.
 */
function testInvariantsHoldOverPerturbedRings(): void {
  let seed = 20260818
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  let arcs = 0
  for (let iteration = 0; iteration < 400; iteration += 1) {
    const steps = 8 + Math.floor(next() * 40)
    const half = ((20 + next() * 140) * Math.PI) / 180
    const scale = 0.5 + next() * 8
    const jitter = next() * 0.05
    const ring: Point[] = []
    for (let step = 0; step <= steps; step += 1) {
      const angle = Math.PI - half + (2 * half * step) / steps
      const wobble = 1 + (next() - 0.5) * jitter
      ring.push({
        x: scale + scale * Math.cos(angle) * wobble,
        y: scale * Math.sin(angle) * wobble,
      })
    }
    if (ring.length < 3) continue
    const radius = scale * (0.05 + next() * 0.5)
    for (let index = 0; index < ring.length; index += 1) {
      const previous = ring[(index + ring.length - 1) % ring.length]
      const point = ring[index]
      const following = ring[(index + 1) % ring.length]
      let turn = Math.atan2(following.y - point.y, following.x - point.x)
        - Math.atan2(point.y - previous.y, point.x - previous.x)
      while (turn > Math.PI) turn -= 2 * Math.PI
      while (turn <= -Math.PI) turn += 2 * Math.PI
      if (Math.abs(turn) < (20 * Math.PI) / 180) continue
      const arc = findBroadCornerArc({
        points: ring, apexFirst: index, apexLast: index,
        turnSign: turn >= 0 ? 1 : -1, radius,
      })
      if (!arc) continue
      arcs += 1
      assertTangentAndClear(ring, arc, `fuzz ${iteration}/${index}`)
      let sourceTurn = 0
      for (let offset = 1; offset <= arc.span; offset += 1) {
        const edgeIndex = (arc.entryEdge + offset) % ring.length
        const before = edgeOf(ring, (edgeIndex - 1 + ring.length) % ring.length)
        const after = edgeOf(ring, edgeIndex)
        let step = Math.atan2(after.uy, after.ux) - Math.atan2(before.uy, before.ux)
        while (step > Math.PI) step -= 2 * Math.PI
        while (step <= -Math.PI) step += 2 * Math.PI
        sourceTurn += step
      }
      assert(Math.abs(arc.sweep - sourceTurn) <= 1e-6,
        `fuzz ${iteration}/${index}: the arc turns by as much as the source path it replaces`)
      assert(Math.sign(arc.sweep) === (turn >= 0 ? 1 : -1),
        `fuzz ${iteration}/${index}: the arc turns the same way as the corner`)
    }
  }
  assert(arcs > 200, `the fuzz actually exercised the search (${arcs} arcs)`)
  console.log(`invariants hold over perturbed rings (${arcs} arcs): PASSED`)
}

function testScaleEquivalence(): void {
  const ring = tessellatedCrescent()
  const corner = sharpestCorner(ring)
  const sign = corner.turn >= 0 ? 1 : -1
  const scale = 25.4
  const plain = findBroadCornerArc({
    points: ring, apexFirst: corner.index, apexLast: corner.index, turnSign: sign, radius: 1,
  })
  const scaled = findBroadCornerArc({
    points: ring.map((point) => ({ x: point.x * scale, y: point.y * scale })),
    apexFirst: corner.index, apexLast: corner.index, turnSign: sign, radius: scale,
  })
  assert(plain !== null && scaled !== null, 'both scales produce an arc')
  assert(plain.entryEdge === scaled.entryEdge && plain.exitEdge === scaled.exitEdge,
    'a scaled copy jams against the same two edges')
  assert(Math.abs(plain.entry.x * scale - scaled.entry.x) <= 1e-6 * scale
    && Math.abs(plain.entry.y * scale - scaled.entry.y) <= 1e-6 * scale,
    'a scaled copy produces the scaled tangent point')
  assert(Math.abs(plain.sweep - scaled.sweep) <= 1e-9, 'the sweep is scale invariant')
  console.log('scale equivalence: PASSED')
}

function testOrientationReversalMirrors(): void {
  const square: Point[] = [
    { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 },
  ]
  const forward = findBroadCornerArc({
    points: square, apexFirst: 1, apexLast: 1, turnSign: 1, radius: 5,
  })
  const reversed = [...square].reverse()
  // The same geometric corner, now index 2 of the reversed ring, turning the
  // other way.
  const backward = findBroadCornerArc({
    points: reversed, apexFirst: 2, apexLast: 2, turnSign: -1, radius: 5,
  })
  assert(forward !== null && backward !== null, 'both orientations produce an arc')
  assert(Math.abs(forward.centre.x - backward.centre.x) <= 1e-9
    && Math.abs(forward.centre.y - backward.centre.y) <= 1e-9,
    'reversing the contour puts the arc on the same circle')
  assert(Math.abs(forward.entry.x - backward.exit.x) <= 1e-9
    && Math.abs(forward.entry.y - backward.exit.y) <= 1e-9,
    'entry and exit swap when the contour is walked backwards')
  assert(Math.abs(forward.sweep + backward.sweep) <= 1e-9, 'the sweep changes sign')
  console.log('orientation reversal mirrors: PASSED')
}

function testDegenerateInputsDecline(): void {
  const square: Point[] = [
    { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 },
  ]
  const cases: Array<[string, BroadCornerArc | null]> = [
    ['a non-positive radius', findBroadCornerArc({ points: square, apexFirst: 1, apexLast: 1, turnSign: 1, radius: 0 })],
    ['a non-finite radius', findBroadCornerArc({ points: square, apexFirst: 1, apexLast: 1, turnSign: 1, radius: Number.NaN })],
    ['fewer than three points', findBroadCornerArc({ points: square.slice(0, 2), apexFirst: 1, apexLast: 1, turnSign: 1, radius: 5 })],
    ['an out-of-range apex', findBroadCornerArc({ points: square, apexFirst: 9, apexLast: 9, turnSign: 1, radius: 5 })],
    ['an unusable turn sign', findBroadCornerArc({ points: square, apexFirst: 1, apexLast: 1, turnSign: 0, radius: 5 })],
    ['a duplicated vertex', findBroadCornerArc({
      points: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }],
      apexFirst: 2, apexLast: 2, turnSign: 1, radius: 5,
    })],
  ]
  for (const [label, result] of cases) {
    assert(result === null, `${label} declines instead of emitting geometry`)
  }
  console.log('degenerate inputs decline: PASSED')
}

function testDeterminism(): void {
  const ring = tessellatedCrescent()
  const corner = sharpestCorner(ring)
  const sign = corner.turn >= 0 ? 1 : -1
  const first = findBroadCornerArc({ points: ring, apexFirst: corner.index, apexLast: corner.index, turnSign: sign, radius: 1 })
  for (let repeat = 0; repeat < 5; repeat += 1) {
    const again = findBroadCornerArc({ points: ring, apexFirst: corner.index, apexLast: corner.index, turnSign: sign, radius: 1 })
    assert(JSON.stringify(first) === JSON.stringify(again), 'the search is deterministic')
  }
  console.log('determinism: PASSED')
}

try {
  testSquareCornerJamsOnItsOwnTwoEdges()
  testTessellatedCornerReachesTheFullRadius()
  testSweepMatchesTheSourcePathItReplaces()
  testCorridorNarrowerThanTwoRadiiDeclines()
  testOppositeWallBlocksTheCircle()
  testTangentPointFallingOffAShortEdgeWalksFurtherOut()
  testInvariantsHoldOverPerturbedRings()
  testScaleEquivalence()
  testOrientationReversalMirrors()
  testDegenerateInputsDecline()
  testDeterminism()
  console.log('\nAll broadCornerArc tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
