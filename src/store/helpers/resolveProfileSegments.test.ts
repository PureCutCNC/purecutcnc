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

import { resolveProfileSegments } from './resolveProfileSegments'
import { segmentIntersections, type LineSeg, type ArcSeg } from './segmentIntersection'
import { segmentHitTest } from '../../components/canvas/hitTest'
import type { SketchProfile, Point, Project } from '../../types/project'
import type { ViewTransform } from '../../components/canvas/viewTransform'

const ε = 1e-6
const TWO_PI = 2 * Math.PI

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function pt(x: number, y: number): Point {
  return { x, y }
}

// ── resolveProfileSegments ─────────────────────────────────────────────

function testResolveLineArcLineProfile() {
  const profile: SketchProfile = {
    start: pt(0, 0),
    segments: [
      { type: 'line', to: pt(10, 0) },
      { type: 'arc', to: pt(0, 10), center: pt(0, 0), clockwise: false },
      { type: 'line', to: pt(0, 20) },
    ],
    closed: false,
  }

  const resolved = resolveProfileSegments(profile)
  assert(resolved.length === 3, `expected 3 entries, got ${resolved.length}`)

  // First entry: line
  const seg0 = resolved[0]
  assert(seg0 !== null, 'segment 0 should not be null')
  assert(seg0!.kind === 'line', `segment 0 should be line, got ${seg0!.kind}`)
  if (seg0!.kind === 'line') {
    assert(seg0!.p0.x === 0 && seg0!.p0.y === 0, 'line p0 should be (0,0)')
    assert(seg0!.p1.x === 10 && seg0!.p1.y === 0, 'line p1 should be (10,0)')
  }

  // Second entry: arc
  const seg1 = resolved[1]
  assert(seg1 !== null, 'segment 1 should not be null')
  assert(seg1!.kind === 'arc', `segment 1 should be arc, got ${seg1!.kind}`)
  if (seg1!.kind === 'arc') {
    assert(Math.abs(seg1!.radius - 10) < ε, `arc radius should be 10, got ${seg1!.radius}`)
    assert(Math.abs(seg1!.a0 - 0) < ε, `arc a0 should be atan2(0,10)=0, got ${seg1!.a0}`)
    assert(Math.abs(seg1!.a1 - Math.PI / 2) < ε,
      `arc a1 should be atan2(10,0)=π/2, got ${seg1!.a1}`)
    assert(seg1!.ccw === true, `arc ccw should be true, got ${seg1!.ccw}`)
    assert(seg1!.center.x === 0 && seg1!.center.y === 0, 'arc center should be (0,0)')
  }

  // Third entry: line
  const seg2 = resolved[2]
  assert(seg2 !== null, 'segment 2 should not be null')
  assert(seg2!.kind === 'line', `segment 2 should be line, got ${seg2!.kind}`)
  if (seg2!.kind === 'line') {
    assert(seg2!.p0.x === 0 && seg2!.p0.y === 10, 'line2 p0 should be (0,10)')
    assert(seg2!.p1.x === 0 && seg2!.p1.y === 20, 'line2 p1 should be (0,20)')
  }

  console.log('  [line, arc, line] profile → 3 entries, correct kinds: PASSED')
}

function testResolveProfileWithBezier() {
  const profile: SketchProfile = {
    start: pt(0, 0),
    segments: [
      { type: 'line', to: pt(10, 0) },
      { type: 'bezier', to: pt(20, 10), control1: pt(13, 0), control2: pt(20, 7) },
      { type: 'line', to: pt(20, 20) },
    ],
    closed: false,
  }

  const resolved = resolveProfileSegments(profile)
  assert(resolved.length === 3, `expected 3 entries, got ${resolved.length}`)
  assert(resolved[0] !== null, 'line entry should not be null')
  assert(resolved[1] === null, 'bezier entry should be null')
  assert(resolved[2] !== null, 'second line entry should not be null')

  // Verify the second line still starts from the bezier's end point
  if (resolved[2]!.kind === 'line') {
    assert(resolved[2]!.p0.x === 20 && resolved[2]!.p0.y === 10,
      `line after bezier should start at bezier.to (20,10), got (${resolved[2]!.p0.x},${resolved[2]!.p0.y})`)
  }

  console.log('  profile with bezier → null entry: PASSED')
}

function testResolveCircleToFullArc() {
  const profile: SketchProfile = {
    start: pt(10, 0),
    segments: [
      { type: 'circle', center: pt(0, 0), to: pt(0, 10), clockwise: false },
    ],
    closed: true,
  }

  const resolved = resolveProfileSegments(profile)
  assert(resolved.length === 1, `expected 1 entry, got ${resolved.length}`)
  const seg = resolved[0]
  assert(seg !== null, 'circle entry should not be null')
  assert(seg!.kind === 'arc', `circle should resolve to arc kind, got ${seg!.kind}`)

  if (seg!.kind === 'arc') {
    assert(Math.abs(seg!.radius - 10) < ε, `circle radius should be 10, got ${seg!.radius}`)
    assert(Math.abs(seg!.a0) < ε, `circle a0 should be atan2(0,10)=0, got ${seg!.a0}`)
    // Full circle ccw: a1 = a0 + 2π
    assert(Math.abs(seg!.a1 - TWO_PI) < ε,
      `circle a1 should be 2π for ccw, got ${seg!.a1}`)
    assert(seg!.ccw === true, `circle ccw should be true`)
  }

  // Clockwise circle
  const profileCW: SketchProfile = {
    start: pt(10, 0),
    segments: [
      { type: 'circle', center: pt(0, 0), to: pt(0, -10), clockwise: true },
    ],
    closed: true,
  }

  const resolvedCW = resolveProfileSegments(profileCW)
  const segCW = resolvedCW[0]
  assert(segCW !== null, 'cw circle entry should not be null')
  if (segCW!.kind === 'arc') {
    assert(segCW!.ccw === false, `cw circle ccw should be false`)
    assert(segCW!.a1 < segCW!.a0, `cw circle a1 should be less than a0 (negative sweep)`)
    assert(Math.abs(segCW!.a1 + TWO_PI - segCW!.a0) < ε,
      `cw circle sweep should be -2π`)
  }

  console.log('  circle resolves to full‑circle arc: PASSED')
}

function testArcAnglesAndRadiusMatch() {
  // Arc from (0, 5) to (-5, 0), center at (0, 0), clockwise
  const profile: SketchProfile = {
    start: pt(0, 5),
    segments: [
      { type: 'arc', to: pt(-5, 0), center: pt(0, 0), clockwise: true },
    ],
    closed: false,
  }

  const resolved = resolveProfileSegments(profile)
  assert(resolved.length === 1, `expected 1 entry, got ${resolved.length}`)
  const seg = resolved[0]
  assert(seg !== null && seg.kind === 'arc', 'should be arc')

  if (seg!.kind === 'arc') {
    assert(Math.abs(seg!.radius - 5) < ε, `radius should be 5, got ${seg!.radius}`)
    // a0 = atan2(5, 0) = π/2
    assert(Math.abs(seg!.a0 - Math.PI / 2) < ε,
      `a0 should be π/2, got ${seg!.a0}`)
    // a1 = atan2(0, -5) = π
    assert(Math.abs(seg!.a1 - Math.PI) < ε,
      `a1 should be π, got ${seg!.a1}`)
    // clockwise → ccw = false
    assert(seg!.ccw === false, `ccw should be false for clockwise arc`)
  }
  console.log('  arc angles and radius match: PASSED')
}

// ── arc round‑trip through segmentIntersections ────────────────────────

function testArcRoundTripSegmentIntersections() {
  // Arc from angle 0 to π/2 (first quadrant), ccw
  const arc: ArcSeg = {
    kind: 'arc',
    center: pt(0, 0),
    radius: 10,
    a0: 0,
    a1: Math.PI / 2,
    ccw: true,
  }

  // Line crossing the arc interior: vertical line at x = 5.
  // Circle: x² + y² = 100. At x=5: y = ±√75 ≈ ±8.66
  // Point (5, 8.66): angle = atan2(8.66, 5) ≈ 1.047 rad = 60° — IN sweep [0, 90°]
  // Point (5, -8.66): angle ≈ -1.047 rad = -60° — NOT in sweep [0, 90°]
  const lineThroughSweep: LineSeg = {
    kind: 'line',
    p0: pt(5, -15),
    p1: pt(5, 15),
  }

  const hits = segmentIntersections(arc, lineThroughSweep)
  assert(hits.length === 1,
    `expected 1 hit for line crossing arc interior, got ${hits.length}`)

  const h = hits[0]
  assert(h.point.y > 0, 'hit should be at the top (y > 0) — point inside sweep')
  assert(Math.abs(Math.hypot(h.point.x - arc.center.x, h.point.y - arc.center.y) - arc.radius) < ε,
    'hit point should lie on circle')
  assert(Math.abs(h.tA) >= 0 && Math.abs(h.tA) <= 1,
    `tA should be in [0,1], got ${h.tA}`)

  // Line that misses the sweep: vertical line at x = -5.
  // Circle: at x=-5: y = ±√75 ≈ ±8.66
  // Point (-5, 8.66): angle ≈ 2.094 rad = 120° — NOT in sweep [0, 90°]
  // Point (-5, -8.66): angle ≈ -2.094 rad = -120° — NOT in sweep [0, 90°]
  const lineOutsideSweep: LineSeg = {
    kind: 'line',
    p0: pt(-5, -15),
    p1: pt(-5, 15),
  }

  const hitsOutside = segmentIntersections(arc, lineOutsideSweep)
  assert(hitsOutside.length === 0,
    `expected 0 hits for line outside arc sweep, got ${hitsOutside.length}`)

  console.log('  arc round‑trip through segmentIntersections: PASSED')
}

function testArcRoundTripViaProfileResolver() {
  // Build a profile with an arc, resolve it, then round‑trip through
  // segmentIntersections.
  const profile: SketchProfile = {
    start: pt(10, 0),
    segments: [
      { type: 'arc', to: pt(0, 10), center: pt(0, 0), clockwise: false },
    ],
    closed: false,
  }

  const resolved = resolveProfileSegments(profile)
  assert(resolved.length === 1 && resolved[0] !== null, 'should resolve to one arc')
  const resolvedArc = resolved[0] as ArcSeg

  assert(resolvedArc.kind === 'arc', 'resolved should be arc')
  assert(resolvedArc.ccw === true, 'arc should be ccw')
  assert(Math.abs(resolvedArc.a0) < ε, 'a0 should be 0')
  assert(Math.abs(resolvedArc.a1 - Math.PI / 2) < ε, 'a1 should be π/2')

  // A radial line from center in the first quadrant should hit the arc
  const radialLine: LineSeg = {
    kind: 'line',
    p0: pt(0, 0),
    p1: pt(10, 10),
  }
  const hits = segmentIntersections(radialLine, resolvedArc)
  assert(hits.length === 1,
    `radial line at 45° should hit resolved arc, got ${hits.length}`)
  assert(hits[0].tB > 0 && hits[0].tB < 1,
    `tB should be in (0,1), got ${hits[0].tB}`)

  // A radial line from center in the fourth quadrant should miss
  const radialLineOutside: LineSeg = {
    kind: 'line',
    p0: pt(0, 0),
    p1: pt(10, -10),
  }
  const hitsOutside = segmentIntersections(radialLineOutside, resolvedArc)
  assert(hitsOutside.length === 0,
    `radial line at -45° should miss resolved arc, got ${hitsOutside.length}`)

  console.log('  arc round‑trip via profile resolver: PASSED')
}

// ── segmentHitTest ─────────────────────────────────────────────────────

function makeMockViewTransform(scale = 1): ViewTransform {
  return { scale, offsetX: 0, offsetY: 0 }
}

function makeMockProject(profiles: Array<{ id: string; profile: SketchProfile; visible: boolean }>): Project {
  // Build a minimal project that flows through resolvedProjectFeatures →
  // rawFeatureAdapter (legacy path — no definitionId, no matching
  // featureDefinition).
  return {
    version: '1.0',
    meta: { name: 'test', unit: 'mm' } as any,
    grid: { sizeX: 100, sizeY: 100, originX: 0, originY: 0 } as any,
    stock: { x: 0, y: 0, w: 100, h: 100, thickness: 10 } as any,
    origin: { x: 0, y: 0 } as any,
    backdrop: null,
    dimensions: {},
    annotations: [],
    modelAssets: {},
    featureDefinitions: {},
    features: profiles.map((p) => ({
      id: p.id,
      name: p.id,
      kind: 'polygon',
      folderId: null,
      sketch: {
        profile: p.profile,
        origin: pt(0, 0),
        orientationAngle: 0,
        dimensions: [],
        constraints: [],
      },
      operation: 'add',
      z_top: 0,
      z_bottom: -5,
      visible: p.visible,
      locked: false,
    }) as any),
    featureFolders: [],
    featureTree: [],
    global_constraints: [],
    tools: [],
    operations: [],
    tabs: [],
    clamps: [],
    ai_history: [],
  } as any as Project
}

function testSegmentHitTestArcIndex() {
  // Profile: line (0,0)→(10,0), arc (10,0)→(0,10) ccw center(0,0), line (0,10)→(0,20)
  const profile: SketchProfile = {
    start: pt(0, 0),
    segments: [
      { type: 'line', to: pt(10, 0) },
      { type: 'arc', to: pt(0, 10), center: pt(0, 0), clockwise: false },
      { type: 'line', to: pt(0, 20) },
    ],
    closed: false,
  }

  const project = makeMockProject([
    { id: 'f1', profile, visible: true },
  ])
  const vt = makeMockViewTransform(1)
  const tolerancePx = 8

  // Click at (7, 7) — point on the arc at angle ~45°, radius 10
  // Actually: the arc starts at (10,0) (angle 0) and ends at (0,10) (angle π/2).
  // At angle π/4: (10*cos(π/4), 10*sin(π/4)) ≈ (7.071, 7.071)
  const clickOnArc = pt(7.071, 7.071)

  const hitArc = segmentHitTest(clickOnArc, project, vt, { openOnly: false }, tolerancePx)
  assert(hitArc !== null, 'should hit the arc — click at (7.07, 7.07) is on the arc')
  assert(hitArc!.segmentIndex === 1,
    `segmentIndex should be 1 (TRUE profile.segments index), got ${hitArc!.segmentIndex}`)
  assert(hitArc!.featureId === 'f1', `featureId should be f1, got ${hitArc!.featureId}`)
  assert(Math.abs(hitArc!.t) >= 0 && Math.abs(hitArc!.t) <= 1,
    `t should be in [0,1], got ${hitArc!.t}`)

  console.log('  segmentHitTest: arc click → segmentIndex === 1 (TRUE index): PASSED')
}

function testSegmentHitTestSecondLine() {
  // Same profile as above
  const profile: SketchProfile = {
    start: pt(0, 0),
    segments: [
      { type: 'line', to: pt(10, 0) },
      { type: 'arc', to: pt(0, 10), center: pt(0, 0), clockwise: false },
      { type: 'line', to: pt(0, 20) },
    ],
    closed: false,
  }

  const project = makeMockProject([
    { id: 'f1', profile, visible: true },
  ])
  const vt = makeMockViewTransform(1)
  const tolerancePx = 8

  // Click at (0, 15) — on the second line segment (segmentIndex 2)
  const clickOnLine = pt(0, 15)

  const hitLine = segmentHitTest(clickOnLine, project, vt, { openOnly: false }, tolerancePx)
  assert(hitLine !== null, 'should hit the second line')
  assert(hitLine!.segmentIndex === 2,
    `segmentIndex should be 2 (second line), got ${hitLine!.segmentIndex}`)
  assert(hitLine!.featureId === 'f1', `featureId should be f1, got ${hitLine!.featureId}`)
  // t ≈ 0.5 on line from (0,10) to (0,20)
  assert(Math.abs(hitLine!.t - 0.5) < 0.01,
    `t should be ~0.5, got ${hitLine!.t}`)

  console.log('  segmentHitTest: second line click → segmentIndex === 2: PASSED')
}

function testSegmentHitTestOpenOnlyExcludesClosed() {
  // Closed rectangle feature
  const closedProfile: SketchProfile = {
    start: pt(50, 0),
    segments: [
      { type: 'line', to: pt(60, 0) },
      { type: 'line', to: pt(60, 10) },
      { type: 'line', to: pt(50, 10) },
      { type: 'line', to: pt(50, 0) },
    ],
    closed: true,
  }

  const project = makeMockProject([
    { id: 'closed', profile: closedProfile, visible: true },
  ])
  const vt = makeMockViewTransform(1)
  const tolerancePx = 8

  // Click on the closed feature's segment
  const clickOnClosed = pt(55, 5)

  // With openOnly=true → should NOT hit closed feature
  const noHit = segmentHitTest(clickOnClosed, project, vt, { openOnly: true }, tolerancePx)
  assert(noHit === null, 'openOnly should exclude closed features')

  // With openOnly=false → should hit the closed feature
  const hit = segmentHitTest(clickOnClosed, project, vt, { openOnly: false }, tolerancePx)
  assert(hit !== null, 'without openOnly, should hit closed feature')
  assert(hit!.featureId === 'closed',
    `should hit closed feature, got ${hit!.featureId}`)

  console.log('  segmentHitTest: openOnly excludes closed features: PASSED')
}

function testSegmentHitTestInvisibleSkipped() {
  // Same profile, two features — one invisible
  const profile: SketchProfile = {
    start: pt(0, 0),
    segments: [
      { type: 'line', to: pt(10, 0) },
      { type: 'line', to: pt(10, 10) },
    ],
    closed: false,
  }

  const project = makeMockProject([
    { id: 'inv', profile, visible: false },
    { id: 'vis', profile: { ...profile, start: pt(0, 0) }, visible: true },
  ])
  const vt = makeMockViewTransform(1)

  const hit = segmentHitTest(pt(5, 0), project, vt, { openOnly: false }, 8)
  assert(hit !== null, 'should hit the visible feature')
  assert(hit!.featureId === 'vis',
    `should hit visible feature, got ${hit!.featureId}`)

  console.log('  segmentHitTest: invisible feature skipped: PASSED')
}

function testSegmentHitTestBezierSkipped() {
  // Profile with bezier between two lines
  const profile: SketchProfile = {
    start: pt(0, 0),
    segments: [
      { type: 'line', to: pt(10, 0) },
      { type: 'bezier', to: pt(20, 10), control1: pt(13, 0), control2: pt(20, 7) },
      { type: 'line', to: pt(20, 20) },
    ],
    closed: false,
  }

  const project = makeMockProject([
    { id: 'f1', profile, visible: true },
  ])
  const vt = makeMockViewTransform(1)

  // Click at (15, 5) — near the bezier but should not hit it (bezier = null)
  // It should fall through to the nearest non-null segment or miss entirely
  const hit = segmentHitTest(pt(15, 5), project, vt, { openOnly: false }, 8)

  // The bezier is skipped. The point (15,5) is closer to line[0] (10,0) at
  // distance ~7.07 or line[2] (20,10) at distance ~7.07. May or may not be
  // within tolerance. We just verify it doesn't crash and the bezier entry is
  // skipped (no hit with segmentIndex === 1).
  assert(hit === null || hit.segmentIndex !== 1,
    'should never return segmentIndex === 1 (bezier)')

  console.log('  segmentHitTest: bezier skipped: PASSED')
}

// ── runner ──────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function run(name: string, fn: () => void) {
  try {
    fn()
    passed += 1
  } catch (e) {
    failed += 1
    console.error(`FAILED: ${name}`)
    console.error(e)
  }
}

console.log('── resolveProfileSegments ──')
run('[line, arc, line] profile', testResolveLineArcLineProfile)
run('profile with bezier', testResolveProfileWithBezier)
run('circle to full arc', testResolveCircleToFullArc)
run('arc angles and radius', testArcAnglesAndRadiusMatch)

console.log('── arc round‑trip ──')
run('arc → segmentIntersections', testArcRoundTripSegmentIntersections)
run('via profile resolver', testArcRoundTripViaProfileResolver)

console.log('── segmentHitTest ──')
run('arc click → segmentIndex === 1', testSegmentHitTestArcIndex)
run('second line click → segmentIndex === 2', testSegmentHitTestSecondLine)
run('openOnly excludes closed', testSegmentHitTestOpenOnlyExcludesClosed)
run('invisible skipped', testSegmentHitTestInvisibleSkipped)
run('bezier skipped', testSegmentHitTestBezierSkipped)

console.log(`\n${passed} passed, ${failed} failed`)

if (failed > 0) {
  process.exit(1)
}
