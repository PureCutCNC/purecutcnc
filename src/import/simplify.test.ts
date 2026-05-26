/**
 * Unit tests for the DXF post-import simplification pass.
 *
 * Run with: npx tsx src/import/simplify.test.ts
 */

import type { SketchProfile } from '../types/project'
import { DEFAULT_SIMPLIFY_OPTIONS, simplifyProfile } from './simplify'

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`)
  }
}

function approx(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) < eps
}

// ---------------------------------------------------------------------------
// Geometry helpers used to build test profiles
// ---------------------------------------------------------------------------

function circlePoints(cx: number, cy: number, radius: number, count: number, fromAngle = 0, toAngle = 2 * Math.PI): Array<{ x: number; y: number }> {
  const pts = []
  for (let i = 0; i <= count; i += 1) {
    const angle = fromAngle + (toAngle - fromAngle) * (i / count)
    pts.push({ x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius })
  }
  return pts
}

function lineStripProfile(points: Array<{ x: number; y: number }>, closed = false): SketchProfile {
  assert(points.length >= 2, 'lineStripProfile needs at least 2 points')
  const segments = points.slice(1).map((p) => ({ type: 'line' as const, to: p }))
  if (closed) {
    segments.push({ type: 'line' as const, to: points[0] })
  }
  return { start: points[0], segments, closed }
}

// ---------------------------------------------------------------------------
// 1. Collinear-line merging
// ---------------------------------------------------------------------------

function testCollinearMerge(): void {
  // Three collinear points A → B → C should merge to a single A → C line.
  const profile = lineStripProfile([
    { x: 0, y: 0 },
    { x: 5, y: 0 },
    { x: 10, y: 0 },
  ])

  // Use absurdly tight arc tolerance so only merging triggers.
  const result = simplifyProfile(profile, { ...DEFAULT_SIMPLIFY_OPTIONS, radiusToleranceFraction: 1e-12 })

  assert(result.segments.length === 1, `collinear merge: expected 1 segment, got ${result.segments.length}`)
  assert(result.segments[0].type === 'line', 'collinear merge: segment should be line')
  assert(approx(result.segments[0].to.x, 10), 'collinear merge: to.x')
  assert(approx(result.segments[0].to.y, 0), 'collinear merge: to.y')
  console.log('PASS: collinear merge')
}

function testCollinearMergeNonCollinear(): void {
  // Non-collinear path should not be merged.
  const profile = lineStripProfile([
    { x: 0, y: 0 },
    { x: 5, y: 1 },  // slight angle
    { x: 10, y: 0 },
  ])
  const result = simplifyProfile(profile, { ...DEFAULT_SIMPLIFY_OPTIONS, radiusToleranceFraction: 1e-12 })
  assert(result.segments.length === 2, `non-collinear: expected 2 segments, got ${result.segments.length}`)
  console.log('PASS: non-collinear not merged')
}

// ---------------------------------------------------------------------------
// 2. Arc detection
// ---------------------------------------------------------------------------

function testArcDetection(): void {
  // 12 sample points spanning a quarter-circle (0 → π/2) around origin, radius 10.
  const cx = 5
  const cy = 3
  const radius = 10
  const count = 12
  const pts = circlePoints(cx, cy, radius, count, 0, Math.PI / 2)
  const profile = lineStripProfile(pts)

  const result = simplifyProfile(profile, DEFAULT_SIMPLIFY_OPTIONS)

  assert(result.segments.length === 1, `arc detection: expected 1 segment, got ${result.segments.length}`)
  const seg = result.segments[0]
  assert(seg.type === 'arc', `arc detection: expected arc, got ${seg.type}`)

  if (seg.type === 'arc') {
    assert(approx(seg.center.x, cx, 0.01), `arc center.x: expected ${cx}, got ${seg.center.x}`)
    assert(approx(seg.center.y, cy, 0.01), `arc center.y: expected ${cy}, got ${seg.center.y}`)
    const startRadius = Math.hypot(profile.start.x - seg.center.x, profile.start.y - seg.center.y)
    assert(approx(startRadius, radius, 0.01), `arc start on circle: radius ${startRadius}`)
  }
  console.log('PASS: arc detection')
}

function testArcDetectionTooFewSegments(): void {
  // Fewer than minArcSegments (6) segments → no arc fitting.
  const cx = 0
  const cy = 0
  const radius = 5
  const count = 4  // only 4 line segments
  const pts = circlePoints(cx, cy, radius, count, 0, Math.PI)
  const profile = lineStripProfile(pts)

  const result = simplifyProfile(profile, DEFAULT_SIMPLIFY_OPTIONS)

  assert(result.segments.length === count, `too few segments: expected ${count}, got ${result.segments.length}`)
  assert(result.segments[0].type === 'line', 'too few segments: should stay as lines')
  console.log('PASS: arc detection skipped for too few segments')
}

function testArcToleranceTight(): void {
  // Points computed on a circle have floating-point errors of ~1e-14.
  // A tolerance of 1e-9 (much tighter than the 1% default) should still detect the arc.
  const pts = circlePoints(0, 0, 8, 10, 0, Math.PI)
  const profile = lineStripProfile(pts)
  const result = simplifyProfile(profile, { minArcSegments: 6, radiusToleranceFraction: 1e-9 })
  assert(result.segments.length === 1, `tight tol: expected 1 arc segment, got ${result.segments.length}`)
  assert(result.segments[0].type === 'arc', 'tight tol: expected arc')
  console.log('PASS: arc detection with very tight tolerance on numerically exact points')
}

function testNonCircularNotFitted(): void {
  // Points on a parabola should not be mistaken for an arc.
  const pts = Array.from({ length: 13 }, (_, i) => {
    const t = (i / 12) * 4 - 2  // t in [-2, 2]
    return { x: t, y: t * t }
  })
  const profile = lineStripProfile(pts)
  const result = simplifyProfile(profile, DEFAULT_SIMPLIFY_OPTIONS)
  assert(result.segments.length === 12, `parabola: expected 12 segments, got ${result.segments.length}`)
  assert(result.segments[0].type === 'line', 'parabola: segments should stay as lines')
  console.log('PASS: parabolic path not fitted as arc')
}

// ---------------------------------------------------------------------------
// 3. Full-circle detection
// ---------------------------------------------------------------------------

function testFullCircleDetection(): void {
  // A closed 24-gon approximating a circle should collapse to a circle segment.
  const cx = 2
  const cy = -3
  const radius = 7
  const count = 24
  const pts = circlePoints(cx, cy, radius, count, 0, 2 * Math.PI).slice(0, count)
  const profile = lineStripProfile(pts, true /* closed */)

  const result = simplifyProfile(profile, DEFAULT_SIMPLIFY_OPTIONS)

  assert(result.segments.length === 1, `full circle: expected 1 segment, got ${result.segments.length}`)
  assert(result.segments[0].type === 'circle', `full circle: expected circle, got ${result.segments[0].type}`)

  if (result.segments[0].type === 'circle') {
    assert(approx(result.segments[0].center.x, cx, 0.05), `circle center.x`)
    assert(approx(result.segments[0].center.y, cy, 0.05), `circle center.y`)
  }
  console.log('PASS: full-circle detection')
}

// ---------------------------------------------------------------------------
// 4. Mixed profile (arc run + straight segment)
// ---------------------------------------------------------------------------

function testMixedProfile(): void {
  // Build a profile: 8 sample points on a semicircle, then a straight line home.
  const cx = 0
  const cy = 0
  const radius = 5
  const arcPts = circlePoints(cx, cy, radius, 8, 0, Math.PI)
  // After the arc, add a straight segment back to start.
  const allPts = [...arcPts, arcPts[0]]
  const profile = lineStripProfile(allPts)

  const result = simplifyProfile(profile, DEFAULT_SIMPLIFY_OPTIONS)

  // Should produce: 1 arc + 1 line.
  assert(result.segments.length === 2, `mixed: expected 2 segments, got ${result.segments.length}`)
  assert(result.segments[0].type === 'arc', `mixed: first segment should be arc, got ${result.segments[0].type}`)
  assert(result.segments[1].type === 'line', `mixed: second segment should be line, got ${result.segments[1].type}`)
  console.log('PASS: mixed arc + line profile')
}

// ---------------------------------------------------------------------------
// 5. Profile with existing arc segments (pass-through)
// ---------------------------------------------------------------------------

function testExistingArcPassthrough(): void {
  // A profile that already has an arc segment should not be modified.
  const profile: SketchProfile = {
    start: { x: 0, y: 0 },
    segments: [
      { type: 'arc', to: { x: 10, y: 0 }, center: { x: 5, y: 0 }, clockwise: false },
    ],
    closed: false,
  }
  const result = simplifyProfile(profile, DEFAULT_SIMPLIFY_OPTIONS)
  assert(result.segments.length === 1, 'passthrough: segment count unchanged')
  assert(result.segments[0].type === 'arc', 'passthrough: arc preserved')
  console.log('PASS: existing arc segment passed through unchanged')
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

let failures = 0

const tests = [
  testCollinearMerge,
  testCollinearMergeNonCollinear,
  testArcDetection,
  testArcDetectionTooFewSegments,
  testArcToleranceTight,
  testNonCircularNotFitted,
  testFullCircleDetection,
  testMixedProfile,
  testExistingArcPassthrough,
]

for (const test of tests) {
  try {
    test()
  } catch (e) {
    console.error(`FAIL: ${test.name} — ${e instanceof Error ? e.message : String(e)}`)
    failures += 1
  }
}

if (failures > 0) {
  throw new Error(`${failures} simplify test(s) failed.`)
}
console.log('\nAll simplify tests passed.')
