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

import type { SketchProfile, Point, Project, ProjectMeta, GridSettings, Stock, MachineOrigin, SketchFeature } from '../../types/project'
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
    meta: { name: 'test', unit: 'mm', modified: new Date().toISOString() } as unknown as ProjectMeta,
    grid: { sizeX: 100, sizeY: 100, originX: 0, originY: 0 } as unknown as GridSettings,
    stock: { x: 0, y: 0, w: 500, h: 500, thickness: 10 } as unknown as Stock,
    origin: { x: 0, y: 0 } as unknown as MachineOrigin,
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
    }) as unknown as SketchFeature[]),
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
  } as unknown as Project
}

function makeProfile(
  start: Point,
  segments: SketchProfile['segments'],
  closed = false,
): SketchProfile {
  return { start, segments, closed }
}

// ── extend: line meets vertical line ────────────────────────────────────

function testExtendLineToVerticalLine() {
  // Subject: horizontal line (0,10)→(5,10) — open, last segment
  // Target: vertical line (10,0)→(10,20)
  // Extension of subject forward (→) should hit the target at (10,10)
  const subjProfile = makeProfile(pt(0, 10), [
    { type: 'line', to: pt(5, 10) },
  ])

  const tgtProfile = makeProfile(pt(10, 0), [
    { type: 'line', to: pt(10, 20) },
  ])

  const features = [
    { id: 'subj', profile: subjProfile },
    { id: 'tgt', profile: tgtProfile },
  ]
  const project = makeMockProject(features)

  // Set up the store with this project
  useProjectStore.setState({ project })

  // Extend from last segment (index 0, only segment), t > 0.5 → grow from end
  const subject = { featureId: 'subj', segmentIndex: 0, point: pt(4, 10), t: 0.8 }
  const target = { featureId: 'tgt', segmentIndex: 0, point: pt(10, 10), t: 0.5 }
  useProjectStore.getState().extendFeatureEndpoint(subject, target)

  const updatedProject = useProjectStore.getState().project
  const updatedFeature = updatedProject.features.find((f: SketchFeature) => f.id === 'subj')
  assert(updatedFeature !== undefined, 'subject feature should exist')

  const updatedProfile = updatedFeature!.sketch.profile
  const endPoint = updatedProfile.segments[0].to
  assert(
    Math.abs(endPoint.x - 10) < ε && Math.abs(endPoint.y - 10) < ε,
    `extended endpoint should be (10,10), got (${endPoint.x}, ${endPoint.y})`,
  )

  console.log('  extend line to vertical line → endpoint at intersection: PASSED')
}

// ── extend: line meets line at apparent intersection ──────────────────

function testExtendApparentIntersection() {
  // Subject: horizontal line (0,10)→(5,10) — going right
  // Target: short line (10,15)→(10,18) — vertical but too short to reach y=10
  // The target's supporting line goes through (10,15)→(10,18) and would
  // intersect the subject's extension at (10,10) — apparent intersection.
  const subjProfile = makeProfile(pt(0, 10), [
    { type: 'line', to: pt(5, 10) },
  ])

  const tgtProfile = makeProfile(pt(10, 15), [
    { type: 'line', to: pt(10, 18) },
  ])

  const features = [
    { id: 'subj', profile: subjProfile },
    { id: 'tgt', profile: tgtProfile },
  ]
  const project = makeMockProject(features)

  useProjectStore.setState({ project })

  const subject = { featureId: 'subj', segmentIndex: 0, point: pt(4, 10), t: 0.8 }
  const target = { featureId: 'tgt', segmentIndex: 0, point: pt(10, 16), t: 0.5 }
  useProjectStore.getState().extendFeatureEndpoint(subject, target)

  const updatedProject = useProjectStore.getState().project
  const updatedFeature = updatedProject.features.find((f: SketchFeature) => f.id === 'subj')
  const updatedProfile = updatedFeature!.sketch.profile
  const endPoint = updatedProfile.segments[0].to

  assert(
    Math.abs(endPoint.x - 10) < ε && Math.abs(endPoint.y - 10) < ε,
    `apparent-intersection endpoint should be (10,10), got (${endPoint.x}, ${endPoint.y})`,
  )

  console.log('  extend to apparent intersection (supporting line): PASSED')
}

// ── extend: no-op when subject is closed ───────────────────────────────

function testExtendNoOpOnClosedProfile() {
  // Closed rectangle — cannot extend
  const subjProfile = makeProfile(pt(50, 0), [
    { type: 'line', to: pt(60, 0) },
    { type: 'line', to: pt(60, 10) },
    { type: 'line', to: pt(50, 10) },
    { type: 'line', to: pt(50, 0) },
  ], true)

  const tgtProfile = makeProfile(pt(70, 0), [
    { type: 'line', to: pt(70, 20) },
  ])

  const features = [
    { id: 'subj', profile: subjProfile },
    { id: 'tgt', profile: tgtProfile },
  ]
  const project = makeMockProject(features)

  useProjectStore.setState({ project })

  const subject = { featureId: 'subj', segmentIndex: 0, point: pt(55, 0), t: 0.5 }
  const target = { featureId: 'tgt', segmentIndex: 0, point: pt(70, 10), t: 0.5 }
  const hints = useProjectStore.getState().extendFeatureEndpoint(subject, target)

  // Verify profile is unchanged
  const updatedProject = useProjectStore.getState().project
  const updatedFeature = updatedProject.features.find((f: SketchFeature) => f.id === 'subj')
  const updatedProfile = updatedFeature!.sketch.profile
  assert(updatedProfile.closed === true, 'closed profile should remain closed')
  assert(
    hints.some((h) => h.toLowerCase().includes('closed')),
    `hints should mention closed profile, got: ${hints.join(', ')}`,
  )

  console.log('  no-op on closed profile: PASSED')
}

// ── extend: no-op when segment is not an end segment ──────────────────

function testExtendNoOpOnMiddleSegment() {
  // Three-segment open profile. Try to extend from middle segment (index 1).
  const subjProfile = makeProfile(pt(0, 0), [
    { type: 'line', to: pt(5, 0) },
    { type: 'line', to: pt(5, 10) },  // middle segment — not an end
    { type: 'line', to: pt(10, 10) },
  ])

  const tgtProfile = makeProfile(pt(15, 0), [
    { type: 'line', to: pt(15, 20) },
  ])

  const features = [
    { id: 'subj', profile: subjProfile },
    { id: 'tgt', profile: tgtProfile },
  ]
  const project = makeMockProject(features)

  useProjectStore.setState({ project })

  const subject = { featureId: 'subj', segmentIndex: 1, point: pt(5, 5), t: 0.5 }
  const target = { featureId: 'tgt', segmentIndex: 0, point: pt(15, 10), t: 0.5 }
  useProjectStore.getState().extendFeatureEndpoint(subject, target)

  // Profile unchanged
  const updatedProject = useProjectStore.getState().project
  const updatedFeature = updatedProject.features.find((f: SketchFeature) => f.id === 'subj')
  assert(updatedFeature!.sketch.profile.segments.length === 3, 'profile should be unchanged')

  console.log('  no-op on middle segment: PASSED')
}

// ── extend: arc end meets line ───────────────────────────────────────

function testExtendArcEndToLine() {
  // Arc from (10,0) ccw to (0,10), center (0,0), radius 10
  // Extend the arc along its circle to meet a vertical line at x=-6
  // At x=-6 on circle: y = ±√(100-36) = ±8.
  // Arc sweeps from angle 0 to π/2 ccw. Forward (past π/2, into Q2) gives x<0, y>0.
  // So intersection at (-6, 8).

  const subjProfile = makeProfile(pt(10, 0), [
    { type: 'arc', to: pt(0, 10), center: pt(0, 0), clockwise: false },
  ])

  // Target: vertical line at x=-6 from y=-20 to y=20
  const tgtProfile = makeProfile(pt(-6, -20), [
    { type: 'line', to: pt(-6, 20) },
  ])

  const features = [
    { id: 'subj', profile: subjProfile },
    { id: 'tgt', profile: tgtProfile },
  ]
  const project = makeMockProject(features)

  useProjectStore.setState({ project })

  // t > 0.5 → grow from end (to)
  const subject = { featureId: 'subj', segmentIndex: 0, point: pt(5, 7), t: 0.8 }
  const target = { featureId: 'tgt', segmentIndex: 0, point: pt(-6, 8), t: 0.55 }
  useProjectStore.getState().extendFeatureEndpoint(subject, target)

  const updatedProject = useProjectStore.getState().project
  const updatedFeature = updatedProject.features.find((f: SketchFeature) => f.id === 'subj')
  const updatedProfile = updatedFeature!.sketch.profile
  const endPoint = updatedProfile.segments[0].to

  // Should be at (-6, 8) — on the circle (radius 10 check) and on x=-6
  const dist = Math.hypot(endPoint.x - 0, endPoint.y - 0)
  assert(Math.abs(dist - 10) < 1e-4,
    `arc endpoint should remain on circle (r=10), got distance ${dist}`)
  assert(Math.abs(endPoint.x - (-6)) < ε,
    `arc endpoint x should be -6 (on target line), got ${endPoint.x}`)
  assert(endPoint.y > 0,
    `arc endpoint should have y > 0 (Q2, forward of π/2), got ${endPoint.y}`)
  // The point on x=-6, circle r=10: y = ±8. Forward of π/2 means y > 0, so y=8.
  assert(Math.abs(endPoint.y - 8) < ε,
    `arc endpoint y should be 8, got ${endPoint.y}`)

  console.log('  extend arc end along circle to line: PASSED')
}

// ── extend: parallel lines — no-op ────────────────────────────────────

function testExtendParallelNoOp() {
  // Two horizontal lines at different y — their directions are parallel
  const subjProfile = makeProfile(pt(0, 10), [
    { type: 'line', to: pt(5, 10) },
  ])

  const tgtProfile = makeProfile(pt(0, 20), [
    { type: 'line', to: pt(20, 20) },
  ])

  const features = [
    { id: 'subj', profile: subjProfile },
    { id: 'tgt', profile: tgtProfile },
  ]
  const project = makeMockProject(features)

  useProjectStore.setState({ project })

  const subject = { featureId: 'subj', segmentIndex: 0, point: pt(4, 10), t: 0.8 }
  const target = { featureId: 'tgt', segmentIndex: 0, point: pt(10, 20), t: 0.5 }
  useProjectStore.getState().extendFeatureEndpoint(subject, target)

  // Profile should be unchanged
  const updatedProject = useProjectStore.getState().project
  const updatedFeature = updatedProject.features.find((f: SketchFeature) => f.id === 'subj')
  const updatedProfile = updatedFeature!.sketch.profile
  assert(
    Math.abs(updatedProfile.segments[0].to.x - 5) < ε,
    'endpoint should be unchanged (parallel)',
  )

  console.log('  parallel lines — no-op: PASSED')
}

// ── extend: extend from start end ─────────────────────────────────────

function testExtendFromStart() {
  // Subject: line from (5,10)→(10,10). t < 0.5 on first (only) segment → grow from start
  // Target: vertical line at x=0
  // Extension backward from (5,10) ← should hit at (0,10)
  const subjProfile = makeProfile(pt(5, 10), [
    { type: 'line', to: pt(10, 10) },
  ])

  const tgtProfile = makeProfile(pt(0, -10), [
    { type: 'line', to: pt(0, 30) },
  ])

  const features = [
    { id: 'subj', profile: subjProfile },
    { id: 'tgt', profile: tgtProfile },
  ]
  const project = makeMockProject(features)

  useProjectStore.setState({ project })

  // t < 0.5 → grow from start
  const subject = { featureId: 'subj', segmentIndex: 0, point: pt(6, 10), t: 0.2 }
  const target = { featureId: 'tgt', segmentIndex: 0, point: pt(0, 10), t: 0.5 }
  useProjectStore.getState().extendFeatureEndpoint(subject, target)

  const updatedProject = useProjectStore.getState().project
  const updatedFeature = updatedProject.features.find((f: SketchFeature) => f.id === 'subj')
  const updatedProfile = updatedFeature!.sketch.profile

  assert(
    Math.abs(updatedProfile.start.x - 0) < ε && Math.abs(updatedProfile.start.y - 10) < ε,
    `start should extend to (0,10), got (${updatedProfile.start.x}, ${updatedProfile.start.y})`,
  )

  console.log('  extend from start end: PASSED')
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

console.log('── extendFeatureEndpoint ──')
run('line to vertical line', testExtendLineToVerticalLine)
run('apparent intersection', testExtendApparentIntersection)
run('no-op on closed profile', testExtendNoOpOnClosedProfile)
run('no-op on middle segment', testExtendNoOpOnMiddleSegment)
run('arc end to line', testExtendArcEndToLine)
run('parallel lines no-op', testExtendParallelNoOp)
run('extend from start end', testExtendFromStart)

console.log(`\n${passed} passed, ${failed} failed`)

if (failed > 0) {
  process.exit(1)
}
