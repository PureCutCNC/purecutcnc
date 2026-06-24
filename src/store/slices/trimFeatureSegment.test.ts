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

import type { SketchProfile, Point, Project } from '../../types/project'
import { useProjectStore } from '../projectStore'

const ε = 1e-6

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function pt(x: number, y: number): Point {
  return { x, y }
}

function makeMockProject(
  features: Array<{
    id: string
    profile: SketchProfile
    visible?: boolean
    locked?: boolean
  }>,
): Project {
  return {
    version: '1.0',
    meta: { name: 'test', unit: 'mm', modified: new Date().toISOString() } as any,
    grid: { sizeX: 100, sizeY: 100, originX: 0, originY: 0 } as any,
    stock: { x: 0, y: 0, w: 500, h: 500, thickness: 10 } as any,
    origin: { x: 0, y: 0 } as any,
    backdrop: null,
    dimensions: {},
    annotations: [],
    modelAssets: {},
    featureDefinitions: {},
    features: features.map((f) => ({
      id: f.id,
      name: f.id,
      kind: 'polygon' as const,
      folderId: null,
      sketch: {
        profile: f.profile,
        origin: pt(0, 0),
        orientationAngle: 0,
        dimensions: [],
        constraints: [],
      },
      operation: 'add' as const,
      z_top: 0,
      z_bottom: -5,
      visible: f.visible ?? true,
      locked: f.locked ?? false,
    }) as any),
    featureFolders: [],
    featureTree: [
      ...features.map((f) => ({ type: 'feature' as const, featureId: f.id })),
    ],
    global_constraints: [],
    tools: [],
    operations: [],
    tabs: [],
    clamps: [],
    ai_history: [],
  } as any as Project
}

function makeProfile(
  start: Point,
  segments: SketchProfile['segments'],
  closed = false,
): SketchProfile {
  return { start, segments, closed }
}

// ── trim: line right overhang at vertical cutter ─────────────────────────

function testTrimLineRightOverhang() {
  // Subject: horizontal line (0,10)→(10,10) — open, single segment
  // Cutter: vertical line (7,0)→(7,20)
  // Click at t=0.8 (right side) → remove from x=7 to x=10
  const subjProfile = makeProfile(pt(0, 10), [
    { type: 'line', to: pt(10, 10) },
  ])

  const cutterProfile = makeProfile(pt(7, 0), [
    { type: 'line', to: pt(7, 20) },
  ])

  const features = [
    { id: 'subj', profile: subjProfile },
    { id: 'cutter', profile: cutterProfile },
  ]
  const project = makeMockProject(features)
  useProjectStore.setState({ project })

  const subject = { featureId: 'subj', segmentIndex: 0, point: pt(8, 10), t: 0.8 }
  const cutter = { featureId: 'cutter', segmentIndex: 0, point: pt(7, 10), t: 0.5 }
  useProjectStore.getState().trimFeatureSegment(subject, cutter)

  const updatedProject = useProjectStore.getState().project
  const updatedFeature = updatedProject.features.find((f: any) => f.id === 'subj')
  assert(updatedFeature !== undefined, 'subject feature should exist')

  const updatedProfile = updatedFeature!.sketch.profile
  const endPoint = updatedProfile.segments[0].to
  // The endpoint should now be at the intersection (7,10)
  assert(
    Math.abs(endPoint.x - 7) < ε && Math.abs(endPoint.y - 10) < ε,
    `trimmed endpoint should be (7,10), got (${endPoint.x}, ${endPoint.y})`,
  )
  // Start should be unchanged (0,10)
  assert(
    Math.abs(updatedProfile.start.x - 0) < ε && Math.abs(updatedProfile.start.y - 10) < ε,
    `start should stay at (0,10), got (${updatedProfile.start.x}, ${updatedProfile.start.y})`,
  )

  console.log('  trim line right overhang → endpoint at intersection: PASSED')
}

// ── trim: line left overhang → move profile.start ──────────────────────

function testTrimLineLeftOverhang() {
  // Subject: horizontal line (5,10)→(15,10) — open, single segment
  // Cutter: vertical line at x=8
  // Click at t=0.2 (left side of hit at t≈0.3) → remove left stub, move start
  const subjProfile = makeProfile(pt(5, 10), [
    { type: 'line', to: pt(15, 10) },
  ])

  const cutterProfile = makeProfile(pt(8, 0), [
    { type: 'line', to: pt(8, 20) },
  ])

  const features = [
    { id: 'subj', profile: subjProfile },
    { id: 'cutter', profile: cutterProfile },
  ]
  const project = makeMockProject(features)
  useProjectStore.setState({ project })

  // t on the subject: line from x=5 to x=15, hit at x=8 → tHit = (8-5)/(15-5) = 0.3
  // Click at t=0.15 (left of hit, near start) → remove left part
  const subject = { featureId: 'subj', segmentIndex: 0, point: pt(6.5, 10), t: 0.15 }
  const cutter = { featureId: 'cutter', segmentIndex: 0, point: pt(8, 10), t: 0.5 }
  useProjectStore.getState().trimFeatureSegment(subject, cutter)

  const updatedProject = useProjectStore.getState().project
  const updatedFeature = updatedProject.features.find((f: any) => f.id === 'subj')
  const updatedProfile = updatedFeature!.sketch.profile

  // Start should move to (8,10)
  assert(
    Math.abs(updatedProfile.start.x - 8) < ε && Math.abs(updatedProfile.start.y - 10) < ε,
    `start should move to (8,10), got (${updatedProfile.start.x}, ${updatedProfile.start.y})`,
  )
  // Endpoint should stay at (15,10)
  assert(
    Math.abs(updatedProfile.segments[0].to.x - 15) < ε && Math.abs(updatedProfile.segments[0].to.y - 10) < ε,
    `endpoint should stay at (15,10), got (${updatedProfile.segments[0].to.x}, ${updatedProfile.segments[0].to.y})`,
  )

  console.log('  trim line left overhang → start moves to intersection: PASSED')
}

// ── trim: no-op when subject is closed ──────────────────────────────────

function testTrimNoOpOnClosedProfile() {
  // Closed rectangle — cannot trim (MVP restriction)
  const subjProfile = makeProfile(pt(50, 0), [
    { type: 'line', to: pt(60, 0) },
    { type: 'line', to: pt(60, 10) },
    { type: 'line', to: pt(50, 10) },
    { type: 'line', to: pt(50, 0) },
  ], true)

  const cutterProfile = makeProfile(pt(55, -5), [
    { type: 'line', to: pt(55, 15) },
  ])

  const features = [
    { id: 'subj', profile: subjProfile },
    { id: 'cutter', profile: cutterProfile },
  ]
  const project = makeMockProject(features)
  useProjectStore.setState({ project })

  const subject = { featureId: 'subj', segmentIndex: 0, point: pt(55, 0), t: 0.5 }
  const cutter = { featureId: 'cutter', segmentIndex: 0, point: pt(55, 10), t: 0.5 }
  const hints = useProjectStore.getState().trimFeatureSegment(subject, cutter)

  // Profile should be unchanged
  const updatedProject = useProjectStore.getState().project
  const updatedFeature = updatedProject.features.find((f: any) => f.id === 'subj')
  assert(updatedFeature!.sketch.profile.closed === true, 'closed profile should remain closed')
  assert(
    hints.some((h) => h.toLowerCase().includes('closed')),
    `hints should mention closed profile, got: ${hints.join(', ')}`,
  )

  console.log('  no-op on closed profile: PASSED')
}

// ── trim: no-op when cutter doesn't cross ──────────────────────────────

function testTrimNoIntersection() {
  // Two parallel lines — no intersection
  const subjProfile = makeProfile(pt(0, 10), [
    { type: 'line', to: pt(10, 10) },
  ])

  const cutterProfile = makeProfile(pt(0, 20), [
    { type: 'line', to: pt(10, 20) },
  ])

  const features = [
    { id: 'subj', profile: subjProfile },
    { id: 'cutter', profile: cutterProfile },
  ]
  const project = makeMockProject(features)
  useProjectStore.setState({ project })

  const subject = { featureId: 'subj', segmentIndex: 0, point: pt(5, 10), t: 0.5 }
  const cutter = { featureId: 'cutter', segmentIndex: 0, point: pt(5, 20), t: 0.5 }
  const hints = useProjectStore.getState().trimFeatureSegment(subject, cutter)

  // Profile should be unchanged
  const updatedProject = useProjectStore.getState().project
  const updatedFeature = updatedProject.features.find((f: any) => f.id === 'subj')
  const seg = updatedFeature!.sketch.profile.segments[0]
  assert(Math.abs(seg.to.x - 10) < ε, 'endpoint x should be unchanged')
  assert(
    hints.some((h) => h.toLowerCase().includes("doesn't cross") || h.toLowerCase().includes('no intersection')),
    `hints should mention no crossing, got: ${hints.join(', ')}`,
  )

  console.log('  no-op when cutter does not cross: PASSED')
}

// ── trim: arc end segment shortened at line cutter ─────────────────────

function testTrimArcEndToLine() {
  // Arc from (10,0) ccw to (0,10), center (0,0), radius 10
  // Cutter: vertical line at x=3
  // Click at t=0.8 (near the end at (0,10)) → trim the end part
  // Intersection: x=3 on circle x²+y²=100 → y=√91≈9.54
  const center = pt(0, 0)
  const subjProfile = makeProfile(pt(10, 0), [
    { type: 'arc', to: pt(0, 10), center, clockwise: false },
  ])

  const cutterProfile = makeProfile(pt(3, -5), [
    { type: 'line', to: pt(3, 15) },
  ])

  const features = [
    { id: 'subj', profile: subjProfile },
    { id: 'cutter', profile: cutterProfile },
  ]
  const project = makeMockProject(features)
  useProjectStore.setState({ project })

  // Click near the end (to=(0,10)), t > tHit → trim from end
  const subject = { featureId: 'subj', segmentIndex: 0, point: pt(1, 10), t: 0.9 }
  const cutter = { featureId: 'cutter', segmentIndex: 0, point: pt(3, 9.5), t: 0.5 }
  useProjectStore.getState().trimFeatureSegment(subject, cutter)

  const updatedProject = useProjectStore.getState().project
  const updatedFeature = updatedProject.features.find((f: any) => f.id === 'subj')
  const updatedProfile = updatedFeature!.sketch.profile
  const updatedSeg = updatedProfile.segments[0]

  // Should still be an arc
  assert(updatedSeg.type === 'arc', 'segment should remain arc type')

  // Endpoint should be on the circle (radius ~10)
  const endDist = Math.hypot(updatedSeg.to.x - center.x, updatedSeg.to.y - center.y)
  assert(Math.abs(endDist - 10) < 1e-4,
    `arc endpoint should remain on circle (r=10), got distance ${endDist}`)

  // Endpoint should be at x≈3 (on the cutter line)
  assert(Math.abs(updatedSeg.to.x - 3) < ε,
    `arc endpoint x should be ≈3 (on cutter), got ${updatedSeg.to.x}`)

  // y should be positive (arc ends in Q2, above x-axis)
  assert(updatedSeg.to.y > 0,
    `arc endpoint y should be positive, got ${updatedSeg.to.y}`)

  // Start should be unchanged
  assert(
    Math.abs(updatedProfile.start.x - 10) < ε && Math.abs(updatedProfile.start.y - 0) < ε,
    `start should stay at (10,0), got (${updatedProfile.start.x}, ${updatedProfile.start.y})`,
  )

  console.log('  trim arc end to line → endpoint at intersection: PASSED')
}

// ── trim: arc start shortened at line cutter ────────────────────────────

function testTrimArcStartToLine() {
  // Arc from (10,0) ccw to (0,10), center (0,0), radius 10
  // Cutter: vertical line at x=8
  // Click at t=0.1 (near the start at (10,0)) → trim start part
  const center = pt(0, 0)
  const subjProfile = makeProfile(pt(10, 0), [
    { type: 'arc', to: pt(0, 10), center, clockwise: false },
  ])

  const cutterProfile = makeProfile(pt(8, -5), [
    { type: 'line', to: pt(8, 15) },
  ])

  const features = [
    { id: 'subj', profile: subjProfile },
    { id: 'cutter', profile: cutterProfile },
  ]
  const project = makeMockProject(features)
  useProjectStore.setState({ project })

  // Click near the start, t < tHit → trim from start
  const subject = { featureId: 'subj', segmentIndex: 0, point: pt(9.5, 1), t: 0.1 }
  const cutter = { featureId: 'cutter', segmentIndex: 0, point: pt(8, 6), t: 0.5 }
  useProjectStore.getState().trimFeatureSegment(subject, cutter)

  const updatedProject = useProjectStore.getState().project
  const updatedFeature = updatedProject.features.find((f: any) => f.id === 'subj')
  const updatedProfile = updatedFeature!.sketch.profile
  const updatedSeg = updatedProfile.segments[0]

  assert(updatedSeg.type === 'arc', 'segment should remain arc type')

  // Start should be on the circle (radius ~10)
  const startDist = Math.hypot(updatedProfile.start.x - center.x, updatedProfile.start.y - center.y)
  assert(Math.abs(startDist - 10) < 1e-4,
    `arc start should remain on circle (r=10), got distance ${startDist}`)

  // Start should be at x≈8 (on the cutter line)
  assert(Math.abs(updatedProfile.start.x - 8) < ε,
    `arc start x should be ≈8 (on cutter), got ${updatedProfile.start.x}`)

  // Endpoint should be unchanged
  assert(
    Math.abs(updatedSeg.to.x - 0) < ε && Math.abs(updatedSeg.to.y - 10) < ε,
    `endpoint should stay at (0,10), got (${updatedSeg.to.x}, ${updatedSeg.to.y})`,
  )

  console.log('  trim arc start to line → start moves to intersection: PASSED')
}

// ── trim: multi-segment profile — trim end segment ──────────────────────

function testTrimMultiSegmentEnd() {
  // Three-segment open profile: (0,0)→(5,0)→(5,10)→(10,10)
  // Trim the last segment with a vertical cutter at x=8
  const subjProfile = makeProfile(pt(0, 0), [
    { type: 'line', to: pt(5, 0) },
    { type: 'line', to: pt(5, 10) },
    { type: 'line', to: pt(10, 10) },   // last segment: (5,10)→(10,10)
  ])

  const cutterProfile = makeProfile(pt(8, 0), [
    { type: 'line', to: pt(8, 20) },
  ])

  const features = [
    { id: 'subj', profile: subjProfile },
    { id: 'cutter', profile: cutterProfile },
  ]
  const project = makeMockProject(features)
  useProjectStore.setState({ project })

  // Click on last segment (index 2) near the end, t > tHit → shorten from end
  const subject = { featureId: 'subj', segmentIndex: 2, point: pt(9, 10), t: 0.8 }
  const cutter = { featureId: 'cutter', segmentIndex: 0, point: pt(8, 10), t: 0.5 }
  useProjectStore.getState().trimFeatureSegment(subject, cutter)

  const updatedProject = useProjectStore.getState().project
  const updatedFeature = updatedProject.features.find((f: any) => f.id === 'subj')
  const updatedProfile = updatedFeature!.sketch.profile

  // Last segment endpoint should be at (8,10)
  const lastSeg = updatedProfile.segments[2]
  assert(
    Math.abs(lastSeg.to.x - 8) < ε && Math.abs(lastSeg.to.y - 10) < ε,
    `last segment endpoint should be (8,10), got (${lastSeg.to.x}, ${lastSeg.to.y})`,
  )

  // Segments 0 and 1 should be unchanged
  assert(
    Math.abs(updatedProfile.segments[0].to.x - 5) < ε && Math.abs(updatedProfile.segments[0].to.y - 0) < ε,
    'segment 0 should be unchanged',
  )
  assert(
    Math.abs(updatedProfile.segments[1].to.x - 5) < ε && Math.abs(updatedProfile.segments[1].to.y - 10) < ε,
    'segment 1 should be unchanged',
  )

  console.log('  trim multi-segment end: PASSED')
}

// ── trim: multi-segment profile — trim first segment start ──────────────

function testTrimMultiSegmentStart() {
  // Three-segment open profile: (0,0)→(5,0)→(5,10)→(10,10)
  // Trim the first segment with a vertical cutter at x=2
  const subjProfile = makeProfile(pt(0, 0), [
    { type: 'line', to: pt(5, 0) },    // first segment
    { type: 'line', to: pt(5, 10) },
    { type: 'line', to: pt(10, 10) },
  ])

  const cutterProfile = makeProfile(pt(2, -5), [
    { type: 'line', to: pt(2, 15) },
  ])

  const features = [
    { id: 'subj', profile: subjProfile },
    { id: 'cutter', profile: cutterProfile },
  ]
  const project = makeMockProject(features)
  useProjectStore.setState({ project })

  // Click on first segment near start, t < tHit → shorten from start
  const subject = { featureId: 'subj', segmentIndex: 0, point: pt(1, 0), t: 0.2 }
  const cutter = { featureId: 'cutter', segmentIndex: 0, point: pt(2, 5), t: 0.5 }
  useProjectStore.getState().trimFeatureSegment(subject, cutter)

  const updatedProject = useProjectStore.getState().project
  const updatedFeature = updatedProject.features.find((f: any) => f.id === 'subj')
  const updatedProfile = updatedFeature!.sketch.profile

  // Profile.start should move to (2,0)
  assert(
    Math.abs(updatedProfile.start.x - 2) < ε && Math.abs(updatedProfile.start.y - 0) < ε,
    `start should move to (2,0), got (${updatedProfile.start.x}, ${updatedProfile.start.y})`,
  )

  // First segment should now go from (2,0) to (5,0)
  assert(
    Math.abs(updatedProfile.segments[0].to.x - 5) < ε && Math.abs(updatedProfile.segments[0].to.y - 0) < ε,
    'segment 0 should still end at (5,0)',
  )

  console.log('  trim multi-segment start: PASSED')
}

// ── trim: no-op when click is on connected side of end segment ────────

function testTrimNoOpOnConnectedSide() {
  // Three-segment open profile: (0,0)→(5,0)→(5,10)→(10,10)
  // Click on first segment at t=0.8 (connected side, near seg1)
  // Cutter at x=2 → gap would be interior → no-op with hint
  const subjProfile = makeProfile(pt(0, 0), [
    { type: 'line', to: pt(5, 0) },
    { type: 'line', to: pt(5, 10) },
    { type: 'line', to: pt(10, 10) },
  ])

  const cutterProfile = makeProfile(pt(2, -5), [
    { type: 'line', to: pt(2, 15) },
  ])

  const features = [
    { id: 'subj', profile: subjProfile },
    { id: 'cutter', profile: cutterProfile },
  ]
  const project = makeMockProject(features)
  useProjectStore.setState({ project })

  // Click on first segment at t=0.8 (connected side) — the hit side connects to seg1
  const subject = { featureId: 'subj', segmentIndex: 0, point: pt(4, 0), t: 0.8 }
  const cutter = { featureId: 'cutter', segmentIndex: 0, point: pt(2, 5), t: 0.5 }
  const hints = useProjectStore.getState().trimFeatureSegment(subject, cutter)

  // Profile should be unchanged
  const updatedProject = useProjectStore.getState().project
  const updatedFeature = updatedProject.features.find((f: any) => f.id === 'subj')
  assert(updatedFeature!.sketch.profile.segments.length === 3, 'profile should be unchanged')
  assert(
    hints.some((h) => h.toLowerCase().includes('interior') || h.toLowerCase().includes('break')),
    `hints should mention interior/break, got: ${hints.join(', ')}`,
  )

  console.log('  no-op on connected side (interior break not MVP): PASSED')
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

console.log('── trimFeatureSegment ──')
run('trim line right overhang', testTrimLineRightOverhang)
run('trim line left overhang', testTrimLineLeftOverhang)
run('no-op on closed profile', testTrimNoOpOnClosedProfile)
run('no-op when cutter does not cross', testTrimNoIntersection)
run('trim arc end to line', testTrimArcEndToLine)
run('trim arc start to line', testTrimArcStartToLine)
run('trim multi-segment end', testTrimMultiSegmentEnd)
run('trim multi-segment start', testTrimMultiSegmentStart)
run('no-op on connected side', testTrimNoOpOnConnectedSide)

console.log(`\n${passed} passed, ${failed} failed`)

if (failed > 0) {
  process.exit(1)
}
