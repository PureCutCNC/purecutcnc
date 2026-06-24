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
 * Unit tests for slotProfile — the obround (slot) profile constructor.
 *
 * Run with: npx tsx src/types/slot.test.ts
 */

import type { Point, ArcSegment } from './project'
import { slotProfile } from './project'

const ε = 1e-10

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

const p1: Point = { x: 0, y: 0 }
const p2: Point = { x: 10, y: 0 }
const width = 4

function testSegmentCountAndTypes() {
  const profile = slotProfile(p1, p2, width)
  assert(profile.segments.length === 4, `expected 4 segments, got ${profile.segments.length}`)
  const types = profile.segments.map((s) => s.type)
  assert(types[0] === 'line', `segment 0 should be line, got ${types[0]}`)
  assert(types[1] === 'arc', `segment 1 should be arc, got ${types[1]}`)
  assert(types[2] === 'line', `segment 2 should be line, got ${types[2]}`)
  assert(types[3] === 'arc', `segment 3 should be arc, got ${types[3]}`)
  console.log('segment count and types: PASSED')
}

function testArcCenters() {
  const profile = slotProfile(p1, p2, width)
  const seg1 = profile.segments[1] as ArcSegment
  const seg3 = profile.segments[3] as ArcSegment
  assert(Math.abs(seg1.center.x - p2.x) < ε, `seg1 center.x ${seg1.center.x} ≠ p2.x ${p2.x}`)
  assert(Math.abs(seg1.center.y - p2.y) < ε, `seg1 center.y ${seg1.center.y} ≠ p2.y ${p2.y}`)
  assert(Math.abs(seg3.center.x - p1.x) < ε, `seg3 center.x ${seg3.center.x} ≠ p1.x ${p1.x}`)
  assert(Math.abs(seg3.center.y - p1.y) < ε, `seg3 center.y ${seg3.center.y} ≠ p1.y ${p1.y}`)
  console.log('arc centers: PASSED')
}

function testConnectivity() {
  const profile = slotProfile(p1, p2, width)
  const { segments } = profile
  // seg[0] starts at profile.start, ends at segments[0].to
  // arc seg[1] starts at segments[0].to (by construction — the arc's start is implicit)
  // We verify that arc radii from center to start/end are equal (both = width/2)
  // and that each segment end is a valid start for the next
  const seg1 = segments[1] as ArcSegment
  const seg3 = segments[3] as ArcSegment

  // segment[0] end (B) and segment[1] start are same point
  const B = segments[0].to
  const rFromB = dist(B, seg1.center)
  const rToC = dist(seg1.to, seg1.center)
  assert(Math.abs(rFromB - width / 2) < ε, `B to p2 distance ${rFromB} ≠ ${width / 2}`)
  assert(Math.abs(rToC - width / 2) < ε, `C to p2 distance ${rToC} ≠ ${width / 2}`)

  // segment[2] end (D) and segment[3] start are same point
  const D = segments[2].to
  const rFromD = dist(D, seg3.center)
  const rToA = dist(seg3.to, seg3.center)
  assert(Math.abs(rFromD - width / 2) < ε, `D to p1 distance ${rFromD} ≠ ${width / 2}`)
  assert(Math.abs(rToA - width / 2) < ε, `A to p1 distance ${rToA} ≠ ${width / 2}`)

  console.log('connectivity: PASSED')
}

function testArcRadii() {
  const profile = slotProfile(p1, p2, width)
  const seg1 = profile.segments[1] as ArcSegment
  const seg3 = profile.segments[3] as ArcSegment
  assert(Math.abs(dist(seg1.to, seg1.center) - width / 2) < ε, `arc1 radius ≠ width/2`)
  assert(Math.abs(dist(seg3.to, seg3.center) - width / 2) < ε, `arc2 radius ≠ width/2`)
  console.log('arc radii: PASSED')
}

function testClosure() {
  const profile = slotProfile(p1, p2, width)
  const lastTo = profile.segments[profile.segments.length - 1].to
  assert(Math.abs(lastTo.x - profile.start.x) < ε, `lastTo.x ${lastTo.x} ≠ start.x ${profile.start.x}`)
  assert(Math.abs(lastTo.y - profile.start.y) < ε, `lastTo.y ${lastTo.y} ≠ start.y ${profile.start.y}`)
  assert(profile.closed === true, 'profile.closed should be true')
  console.log('closure: PASSED')
}

function testHorizontalSlot() {
  const r = width / 2
  const profile = slotProfile(p1, p2, width)
  // For horizontal p1(0,0)→p2(10,0): angle=0, px=-sin(0)=0, py=cos(0)=1
  // A = p1 + r*(0,1) = (0, r)
  assert(Math.abs(profile.start.x - p1.x) < ε, `start.x ${profile.start.x} ≠ ${p1.x}`)
  assert(Math.abs(profile.start.y - (p1.y + r)) < ε, `start.y ${profile.start.y} ≠ ${p1.y + r}`)
  console.log('horizontal slot: PASSED')
}

function testRotated45() {
  const angle45 = Math.PI / 4
  const r = width / 2
  const dist10 = 10
  const q1: Point = { x: 0, y: 0 }
  const q2: Point = { x: dist10 * Math.cos(angle45), y: dist10 * Math.sin(angle45) }
  const profile = slotProfile(q1, q2, width)

  // First segment is line from A to B
  const A = profile.start
  const B = profile.segments[0].to
  const midTop = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 }

  // Expected midpoint: (p1 + p2) / 2 + r * (-sin45, cos45)
  const px = -Math.sin(angle45)
  const py = Math.cos(angle45)
  const expected: Point = {
    x: (q1.x + q2.x) / 2 + r * px,
    y: (q1.y + q2.y) / 2 + r * py,
  }

  assert(Math.abs(midTop.x - expected.x) < ε, `midTop.x ${midTop.x} ≠ expected ${expected.x}`)
  assert(Math.abs(midTop.y - expected.y) < ε, `midTop.y ${midTop.y} ≠ expected ${expected.y}`)
  console.log('rotated 45°: PASSED')
}

try {
  testSegmentCountAndTypes()
  testArcCenters()
  testConnectivity()
  testArcRadii()
  testClosure()
  testHorizontalSlot()
  testRotated45()
  console.log('\nAll slotProfile tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
