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
 * Unit tests for roundContourCorners — the emit-time corner fillet applied to
 * offset clearing rings.
 *
 * Run with: npx tsx src/engine/toolpaths/offsetSmoothing.test.ts
 */

import type { Point } from '../../types/project'
import { roundContourCorners } from './offsetSmoothing'

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function pointsEqual(a: Point[], b: Point[]): boolean {
  if (a.length !== b.length) return false
  return a.every((point, index) => point.x === b[index].x && point.y === b[index].y)
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

const SQUARE: Point[] = [
  { x: 0, y: 0 },
  { x: 20, y: 0 },
  { x: 20, y: 20 },
  { x: 0, y: 20 },
]

function testIdentityWhenDisabled() {
  console.log('Testing roundContourCorners is an identity no-op when disabled...')
  assert(pointsEqual(roundContourCorners(SQUARE, 0), SQUARE), 'radius 0 must return the input unchanged')
  assert(pointsEqual(roundContourCorners(SQUARE, -3), SQUARE), 'negative radius must return the input unchanged')
  const twoPoints: Point[] = [{ x: 0, y: 0 }, { x: 1, y: 1 }]
  assert(pointsEqual(roundContourCorners(twoPoints, 2), twoPoints), 'a degenerate (<3 point) ring is returned unchanged')
  console.log('identity when disabled: PASSED')
}

function testRoundsSquareCorners() {
  console.log('Testing roundContourCorners rounds the four 90° corners of a square...')
  const radius = 4
  const rounded = roundContourCorners(SQUARE, radius)

  assert(rounded.length > SQUARE.length, `expected added arc points, got ${rounded.length}`)

  // No sharp corner survives: every original 90° turn is now a smooth arc.
  assert(maxDeflectionDeg(rounded) < 10, `no output corner should stay sharp, max deflection was ${maxDeflectionDeg(rounded).toFixed(1)}°`)

  // Convex-corner fillets cut *inside* the corner, so the rounded ring never
  // leaves the original bounding box (never gouges outward past the walls).
  const box = bbox(rounded)
  assert(
    box.minX >= -1e-6 && box.minY >= -1e-6 && box.maxX <= 20 + 1e-6 && box.maxY <= 20 + 1e-6,
    'rounded convex corners must stay within the original bounding box',
  )

  // Each original apex is cleared by roughly r*(sqrt(2)-1) for a 90° corner
  // (the arc's closest approach), confirming a real radius, not a chamfer.
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

function testClampPreventsOverlapOnSmallSquare() {
  console.log('Testing the per-corner clamp keeps huge radii from overlapping or blowing up...')
  // Radius far larger than the square: every corner is clamped to half the
  // edge, so the ring stays simple and bounded (edges meet the fillets, no
  // self-intersection, nothing escapes the box).
  const rounded = roundContourCorners(SQUARE, 1000)
  assert(rounded.length >= 8, 'expected clamped fillets on every corner')
  const box = bbox(rounded)
  assert(
    box.minX >= -1e-6 && box.minY >= -1e-6 && box.maxX <= 20 + 1e-6 && box.maxY <= 20 + 1e-6,
    'clamped fillets must stay within the original bounding box',
  )
  assert(maxDeflectionDeg(rounded) < 10, 'clamped corners should still be smooth')
  console.log('clamp prevents overlap: PASSED')
}

function testShallowCornersPreserved() {
  console.log('Testing gentle turns below the deflection threshold are left untouched...')
  // A near-straight vertex (a few degrees of deflection) should not be rounded.
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

try {
  testIdentityWhenDisabled()
  testRoundsSquareCorners()
  testClampPreventsOverlapOnSmallSquare()
  testShallowCornersPreserved()
  console.log('\nAll offsetSmoothing tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
