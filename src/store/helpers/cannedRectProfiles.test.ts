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
 * Unit tests for roundedRectProfile and chamferedRectProfile.
 *
 * Run with: npx tsx src/store/helpers/cannedRectProfiles.test.ts
 */

import { roundedRectProfile, chamferedRectProfile } from './cannedRectProfiles'
import type { SketchProfile } from '../../types/project'

const ε = 1e-9

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function countSegments(profile: SketchProfile) {
  let lines = 0
  let arcs = 0
  for (const s of profile.segments) {
    if (s.type === 'line') lines += 1
    else if (s.type === 'arc') arcs += 1
  }
  return { total: lines + arcs, lines, arcs }
}

function lastTo(profile: SketchProfile) {
  const segs = profile.segments
  return segs[segs.length - 1]?.to ?? profile.start
}

// ── roundedRectProfile ────────────────────────────────────────────

function testRoundedSegmentCount() {
  const p = roundedRectProfile({ x: 0, y: 0 }, { x: 100, y: 60 }, 10)
  const c = countSegments(p)
  assert(c.total === 8, `expected 8 total segments, got ${c.total}`)
  assert(c.lines === 4, `expected 4 lines, got ${c.lines}`)
  assert(c.arcs === 4, `expected 4 arcs, got ${c.arcs}`)
  console.log('  segment count: PASSED')
}

function testRoundedClosure() {
  const p = roundedRectProfile({ x: 0, y: 0 }, { x: 100, y: 60 }, 10)
  assert(p.closed === true, 'profile should be closed')
  const lt = lastTo(p)
  assert(Math.abs(lt.x - p.start.x) < ε && Math.abs(lt.y - p.start.y) < ε, 'last point should equal start')
  console.log('  closure: PASSED')
}

function testRoundedBoundsPreserved() {
  const p = roundedRectProfile({ x: 0, y: 0 }, { x: 100, y: 60 }, 10)
  const pts: { x: number; y: number }[] = [p.start]
  for (const s of p.segments) pts.push(s.to)
  const xs = pts.map((pt) => pt.x)
  const ys = pts.map((pt) => pt.y)
  assert(Math.abs(Math.min(...xs)) < ε, 'min x should be ~0')
  assert(Math.abs(Math.max(...xs) - 100) < ε, 'max x should be ~100')
  assert(Math.abs(Math.min(...ys)) < ε, 'min y should be ~0')
  assert(Math.abs(Math.max(...ys) - 60) < ε, 'max y should be ~60')
  console.log('  bounds preserved: PASSED')
}

function arcRadius(s: { type: 'arc'; to: { x: number; y: number }; center: { x: number; y: number } }): number {
  return Math.hypot(s.to.x - s.center.x, s.to.y - s.center.y)
}

function testRoundedArcRadii() {
  const radius = 8
  const p = roundedRectProfile({ x: 0, y: 0 }, { x: 100, y: 60 }, radius)
  for (const s of p.segments) {
    if (s.type === 'arc') {
      const r = arcRadius(s)
      assert(Math.abs(r - radius) < 1e-6, `arc radius ${r} ≠ expected ${radius}`)
    }
  }
  console.log('  arc radii match corner: PASSED')
}

function testRoundedZeroRadius() {
  const p = roundedRectProfile({ x: 0, y: 0 }, { x: 100, y: 60 }, 0)
  const c = countSegments(p)
  assert(c.total === 4, `expected 4 segments (plain rect), got ${c.total}`)
  assert(c.arcs === 0, `expected 0 arcs, got ${c.arcs}`)
  console.log('  zero radius returns plain rect: PASSED')
}

function testRoundedOversizedClamp() {
  // width=100, height=60 → min/2 = 30, so radius=50 should be clamped to ~30
  const p = roundedRectProfile({ x: 0, y: 0 }, { x: 100, y: 60 }, 50)
  for (const s of p.segments) {
    if (s.type === 'arc') {
      const r = arcRadius(s)
      assert(r <= 30, `clamped arc radius ${r} should be ≤ 30`)
    }
  }
  console.log('  oversized radius clamped: PASSED')
}

function testRoundedZeroSizeRect() {
  const p = roundedRectProfile({ x: 5, y: 5 }, { x: 5, y: 5 }, 10)
  const c = countSegments(p)
  assert(c.total === 4, 'zero-size rect should be plain rect')
  assert(c.arcs === 0, 'zero-size rect should have no arcs')
  console.log('  zero-size rect: PASSED')
}

function testRoundedSwappedCorners() {
  const p = roundedRectProfile({ x: 100, y: 60 }, { x: 0, y: 0 }, 10)
  const pts: { x: number; y: number }[] = [p.start]
  for (const s of p.segments) pts.push(s.to)
  const xs = pts.map((pt) => pt.x)
  assert(Math.abs(Math.min(...xs)) < ε, 'swapped: min x should be ~0')
  assert(Math.abs(Math.max(...xs) - 100) < ε, 'swapped: max x should be ~100')
  console.log('  swapped corners: PASSED')
}

// ── chamferedRectProfile ──────────────────────────────────────────

function testChamferedSegmentCount() {
  const p = chamferedRectProfile({ x: 0, y: 0 }, { x: 100, y: 60 }, 10)
  const c = countSegments(p)
  assert(c.total === 8, `expected 8 total segments, got ${c.total}`)
  assert(c.lines === 8, `expected 8 lines, got ${c.lines}`)
  assert(c.arcs === 0, `expected 0 arcs, got ${c.arcs}`)
  console.log('  segment count (8 lines): PASSED')
}

function testChamferedClosure() {
  const p = chamferedRectProfile({ x: 0, y: 0 }, { x: 100, y: 60 }, 10)
  assert(p.closed === true, 'profile should be closed')
  const lt = lastTo(p)
  assert(Math.abs(lt.x - p.start.x) < ε && Math.abs(lt.y - p.start.y) < ε, 'last point should equal start')
  console.log('  closure: PASSED')
}

function testChamferedBoundsPreserved() {
  const p = chamferedRectProfile({ x: 0, y: 0 }, { x: 100, y: 60 }, 10)
  const pts: { x: number; y: number }[] = [p.start]
  for (const s of p.segments) pts.push(s.to)
  const xs = pts.map((pt) => pt.x)
  const ys = pts.map((pt) => pt.y)
  assert(Math.abs(Math.min(...xs)) < ε, 'min x should be ~0')
  assert(Math.abs(Math.max(...xs) - 100) < ε, 'max x should be ~100')
  assert(Math.abs(Math.min(...ys)) < ε, 'min y should be ~0')
  assert(Math.abs(Math.max(...ys) - 60) < ε, 'max y should be ~60')
  console.log('  bounds preserved: PASSED')
}

function testChamferedSymmetricCuts() {
  const p = chamferedRectProfile({ x: 0, y: 0 }, { x: 100, y: 60 }, 10)
  // 8 segments: 4 chamfer diagonals (d·√2 ≈ 14.14) + 4 rect edges (w-2d=80, h-2d=40)
  const expectedChamferLen = 10 * Math.SQRT2
  const chamferLengths: number[] = []
  const pts: { x: number; y: number }[] = [p.start]
  for (const s of p.segments) pts.push(s.to)
  for (let i = 0; i < pts.length; i += 1) {
    const next = pts[(i + 1) % pts.length]
    const len = Math.hypot(next.x - pts[i].x, next.y - pts[i].y)
    if (Math.abs(len - expectedChamferLen) < 1) {
      chamferLengths.push(len)
    }
  }
  // Should have 4 chamfer edges all of roughly equal length
  assert(chamferLengths.length === 4, `expected 4 chamfer edges, got ${chamferLengths.length}`)
  for (let i = 1; i < chamferLengths.length; i += 1) {
    assert(Math.abs(chamferLengths[i] - chamferLengths[0]) < 1e-6, `chamfer lengths differ: ${chamferLengths[0]} vs ${chamferLengths[i]}`)
  }
  console.log('  symmetric chamfer cuts: PASSED')
}

function testChamferedZeroDistance() {
  const p = chamferedRectProfile({ x: 0, y: 0 }, { x: 100, y: 60 }, 0)
  const c = countSegments(p)
  assert(c.total === 4, `expected 4 segments (plain rect), got ${c.total}`)
  assert(c.lines === 4, `expected 4 lines, got ${c.lines}`)
  console.log('  zero distance returns plain rect: PASSED')
}

function testChamferedOversizedClamp() {
  const p = chamferedRectProfile({ x: 0, y: 0 }, { x: 100, y: 60 }, 50)
  const c = countSegments(p)
  // With clamped distance, may still produce 8 or fall back to 4 if corner too small
  assert(c.total >= 4, `expected at least 4 segments`)
  console.log('  oversized distance handled: PASSED')
}

function testChamferedSquare() {
  const p = chamferedRectProfile({ x: 0, y: 0 }, { x: 50, y: 50 }, 10)
  const c = countSegments(p)
  assert(c.total === 8, `expected 8 segments, got ${c.total}`)
  assert(p.closed === true, 'square chamfer should be closed')
  console.log('  square chamfer: PASSED')
}

// ── runner ─────────────────────────────────────────────────────────

console.log('── roundedRectProfile ──')
try {
  testRoundedSegmentCount()
  testRoundedClosure()
  testRoundedBoundsPreserved()
  testRoundedArcRadii()
  testRoundedZeroRadius()
  testRoundedOversizedClamp()
  testRoundedZeroSizeRect()
  testRoundedSwappedCorners()
  console.log('All roundedRectProfile tests PASSED.')
} catch (e) {
  console.error(e)
  process.exit(1)
}

console.log('\n── chamferedRectProfile ──')
try {
  testChamferedSegmentCount()
  testChamferedClosure()
  testChamferedBoundsPreserved()
  testChamferedSymmetricCuts()
  testChamferedZeroDistance()
  testChamferedOversizedClamp()
  testChamferedSquare()
  console.log('All chamferedRectProfile tests PASSED.')
} catch (e) {
  console.error(e)
  process.exit(1)
}

console.log('\nAll cannedRectProfiles tests PASSED.')
