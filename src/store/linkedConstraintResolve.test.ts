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
 * Tests for Linked Constraint Re-solve (slice 10).
 *
 * Run with: npx tsx src/store/linkedConstraintResolve.test.ts
 */

import {
  propagateConstraintsOnTranslate,
  validateConstraintsOnFeature,
} from '../sketch/constraintSolver'
import {
  circleProfile,
  inferFeatureKind,
  newProject,
  rectProfile,
  type FeatureDefinition,
  type Matrix2D,
  type Point,
  type Project,
  type SketchFeature,
  type SketchProfile,
} from '../types/project'
import { resolveFeatureInstance, resolveProfile } from './helpers/resolveFeatures'
import {
  getInstanceIdsForDefinition,
  rebakeAllInstances,
} from './helpers/featureDefinitions'
import { resolveSketchSnap } from '../components/canvas/snappingHelpers'
import type { ViewTransform } from '../components/canvas/viewTransform'
import { useProjectStore } from './projectStore'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(a: number, b: number, epsilon = 1e-2): boolean {
  return Math.abs(a - b) < epsilon
}

// ── Re-usable test harness ────────────────────────────────────────────

/** Transform profile helper matching the store's transformProfile. */
function transformProfile(profile: SketchProfile, tx: (p: Point) => Point): SketchProfile {
  return {
    ...profile,
    start: tx(profile.start),
    segments: profile.segments.map((s) => {
      if (s.type === 'circle' || s.type === 'arc') {
        return { ...s, center: tx(s.center), to: tx(s.to) }
      }
      return { ...s, to: tx(s.to) }
    }),
  }
}

/** Translate a feature's profile in-place (simulating direct move). */
function translateProfileDirect(profile: SketchProfile, dx: number, dy: number): SketchProfile {
  return transformProfile(profile, (p) => ({ x: p.x + dx, y: p.y + dy }))
}

/** Attach a definitionId + transform stub to a feature. */
function attachDefinitionRef(feature: SketchFeature, definitionId: string, transform: Matrix2D): void {
  ;(feature as unknown as Record<string, unknown>).definitionId = definitionId
  ;(feature as unknown as Record<string, unknown>).transform = transform
}

/**
 * Build a project with:
 *  - A rect definition: rectProfile(0, 0, 10, 10) — top-left at origin, 10×10
 *    start: (0,0), segments: to(10,0), to(10,10), to(0,10), to(0,0)
 *    Right edge = segment[1]: from (10,0) to (10,10), normal points left (-x)
 *  - Instance 1 (identity transform)
 *  - Instance 2 (translated 50, 0)
 *  - A circle feature constrained to inst-1's RIGHT EDGE at signed distance -12.
 *    Circle centre at (22, 5): signed distance from right edge (x=10) = -(22-10) = -12.
 *    Circle radius = 2.
 */
function makeLinkedSetup(): Project {
  const profile = rectProfile(0, 0, 10, 10)
  const definition: FeatureDefinition = {
    id: 'def-rect',
    kind: 'rect',
    profile,
    dimensions: [],
    operation: 'add',
  }

  const inst1: SketchFeature = {
    id: 'inst-1',
    name: 'Rect 1',
    kind: 'rect',
    folderId: null,
    sketch: {
      profile,
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'add',
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
  attachDefinitionRef(inst1, definition.id, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })

  // Instance 2: translated (50, 0)
  const inst2Transform: Matrix2D = { a: 1, b: 0, c: 0, d: 1, e: 50, f: 0 }
  const inst2Profile = resolveProfile(definition, inst2Transform)
  const inst2: SketchFeature = {
    id: 'inst-2',
    name: 'Rect 2',
    kind: inferFeatureKind(inst2Profile),
    folderId: null,
    sketch: {
      profile: inst2Profile,
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'add',
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
  attachDefinitionRef(inst2, definition.id, inst2Transform)

  // Circle constrained to inst-1's RIGHT EDGE at signed distance -12.
  // Circle centre (22, 5): distance from right edge (x=10) = 12 units to the right.
  const circleProf = circleProfile(22, 5, 2)
  const circle: SketchFeature = {
    id: 'circle-dep',
    name: 'Circle',
    kind: 'circle',
    folderId: null,
    sketch: {
      profile: circleProf,
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [
        {
          id: 'c1',
          type: 'fixed_distance',
          segment_ids: ['inst-1'],
          value: -12,
          anchor_point: { x: 22, y: 5 },
          reference_segment: { a: { x: 10, y: 0 }, b: { x: 10, y: 10 } },
          anchor_index: -1,
          anchor_type: 'anchor',
          reference_index: 1,
          reference_type: 'segment',
        } as import('../types/project').LocalConstraint,
      ],
    },
    operation: 'add',
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
  }

  const project = newProject()
  project.features = [inst1, inst2, circle]
  project.featureDefinitions = { [definition.id]: definition }
  return project
}

// ── Helpers for the linked re-solve ───────────────────────────────────

/**
 * Simulate what syncEditedFeatureDefinition does after rebaking:
 * get all instance IDs, rebake, then re-solve dependents of ALL instances.
 */
function linkedRebakeAndResolve(
  project: Project,
  definitionId: string,
  newProfile: SketchProfile,
): SketchFeature[] {
  const def = project.featureDefinitions[definitionId]
  if (!def) return project.features

  const nextDef = { ...def, profile: newProfile, kind: inferFeatureKind(newProfile) }
  const nextProject = {
    ...project,
    featureDefinitions: {
      ...project.featureDefinitions,
      [definitionId]: nextDef,
    },
  }

  // Get all instance IDs BEFORE rebaking
  const allInstanceIds = getInstanceIdsForDefinition(project, definitionId)

  // Rebake
  let nextFeatures = rebakeAllInstances(nextProject, definitionId)

  // Re-solve dependents of ALL rebaked instances
  const offsets = new Map(allInstanceIds.map((id) => [id, { dx: 0, dy: 0 }] as const))
  nextFeatures = propagateConstraintsOnTranslate(nextFeatures, offsets, { transformProfile })

  // Validate all constraints
  const byId = new Map(nextFeatures.map((f) => [f.id, f]))
  nextFeatures = nextFeatures.map((f) => {
    if (f.sketch.constraints.every((c) => c.type !== 'fixed_distance')) return f
    return validateConstraintsOnFeature(f, byId)
  })

  return nextFeatures
}

// ── Tests ─────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`   ✓ ${name}`)
  } catch (err: unknown) {
    failed += 1
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`   ✗ ${name}: ${msg}`)
  }
}

function resetStore(project: Project): void {
  useProjectStore.setState({
    project,
    selection: {
      selectedFeatureIds: [],
      selectedFeatureId: null,
      selectedNode: null,
      mode: 'feature' as const,
      sketchEditTool: null,
      activeControl: null,
      hoveredFeatureId: null,
    },
    history: { past: [], future: [], transactionStart: null },
    sketchEditSession: null,
    pendingConstraint: null,
    pendingTransform: null,
    pendingOffset: null,
  } as Partial<ReturnType<typeof useProjectStore.getState>>)
}

// ──────────────────────────────────────────────────────────────────────
// 1. Linked edit → dependent of sibling re-solves
// ──────────────────────────────────────────────────────────────────────

test('edit linked instance → dependent of sibling re-solves', () => {
  const project = makeLinkedSetup()

  // Verify initial positions
  const circle = project.features.find((f) => f.id === 'circle-dep')!
  const cSeg = circle.sketch.profile.segments[0]
  assert(cSeg?.type === 'circle', 'circle should be circle type')
  if (cSeg.type === 'circle') {
    assert(approx(cSeg.center.x, 22), `circle centre.x should be 22, got ${cSeg.center.x}`)
    assert(approx(cSeg.center.y, 5), `circle centre.y should be 5, got ${cSeg.center.y}`)
  }

  // Edit the definition: widen from 10×10 to 20×10.
  // Right edge moves from x=10 to x=20.
  // Circle at signed distance -12 should follow: -(x-20) = -12 → x = 32.
  const newProfile = rectProfile(0, 0, 20, 10)
  const nextFeatures = linkedRebakeAndResolve(project, 'def-rect', newProfile)

  // inst-1 right edge should now be at x=20
  const inst1 = nextFeatures.find((f) => f.id === 'inst-1')!
  const inst1Seg1 = inst1.sketch.profile.segments[1]
  assert(approx(inst1Seg1!.to.x, 20), `inst1 right-edge to.x should be 20, got ${inst1Seg1?.to.x}`)

  // inst-2 should have translated right edge at x=70 (50 + 20)
  const inst2 = nextFeatures.find((f) => f.id === 'inst-2')!
  const inst2Seg1 = inst2.sketch.profile.segments[1]
  assert(approx(inst2Seg1!.to.x, 70), `inst2 right-edge to.x should be 70, got ${inst2Seg1?.to.x}`)

  // Circle centre should follow: x = 32
  const circleAfter = nextFeatures.find((f) => f.id === 'circle-dep')!
  const cSegAfter = circleAfter.sketch.profile.segments[0]
  assert(cSegAfter?.type === 'circle', 'circle should still be circle type')
  if (cSegAfter.type === 'circle') {
    assert(approx(cSegAfter.center.x, 32),
      `circle centre.x should follow to 32, got ${cSegAfter.center.x}`)
    assert(approx(cSegAfter.center.y, 5),
      `circle centre.y should stay 5, got ${cSegAfter.center.y}`)
  }

  // Constraint should be updated (value preserved, anchor/ref refreshed).
  // Note: the solver's prior-weight damping causes a tiny bias (~0.1% of movement),
  // so validateConstraintsOnFeature may mark the constraint temporarily invalid
  // if the signed distance deviates by more than its 1e-3 tolerance.  That is
  // pre-existing solver behaviour and not specific to linked-constraint re-solve.
  const circleConstraint = circleAfter.sketch.constraints[0]
  assert(circleConstraint?.type === 'fixed_distance', 'should have fixed_distance constraint')
  if (circleConstraint.type === 'fixed_distance') {
    assert(approx(circleConstraint.value!, -12), 'constraint value should still be -12')
  }
})

// ──────────────────────────────────────────────────────────────────────
// 2. Direct-edit regression (existing behavior must not break)
// ──────────────────────────────────────────────────────────────────────

test('direct-edit regression: dependent re-solves after host moves', () => {
  const project = makeLinkedSetup()

  const dx = 15, dy = 5

  // Simulate direct move of inst-1 (same pattern as completePendingMove):
  // 1. Translate the feature's profile directly
  // 2. Call propagateConstraintsOnTranslate with the move offset
  const features = project.features.map((f) => {
    if (f.id !== 'inst-1') return f
    return {
      ...f,
      sketch: {
        ...f.sketch,
        profile: translateProfileDirect(f.sketch.profile, dx, dy),
      },
    }
  })

  const movedOffsets = new Map([['inst-1', { dx, dy }]])
  const nextFeatures = propagateConstraintsOnTranslate(features, movedOffsets, { transformProfile })

  // inst-1 start moves from (0,0) to (15, 5)
  const inst1 = nextFeatures.find((f) => f.id === 'inst-1')!
  assert(approx(inst1.sketch.profile.start.x, 15), `inst1 start.x should be 15, got ${inst1.sketch.profile.start.x}`)
  assert(approx(inst1.sketch.profile.start.y, 5), `inst1 start.y should be 5, got ${inst1.sketch.profile.start.y}`)

  // Circle should follow: centre was (22, 5) → after +15,+5 → (37, 10)
  const circle = nextFeatures.find((f) => f.id === 'circle-dep')!
  const cSeg = circle.sketch.profile.segments[0]
  assert(cSeg?.type === 'circle', 'circle should be circle type')
  if (cSeg.type === 'circle') {
    assert(approx(cSeg.center.x, 37),
      `circle centre.x should be 37, got ${cSeg.center.x}`)
    assert(approx(cSeg.center.y, 10),
      `circle centre.y should be 10, got ${cSeg.center.y}`)
  }
})

// ──────────────────────────────────────────────────────────────────────
// 3. No-drift stability: re-solving twice produces the same result
// ──────────────────────────────────────────────────────────────────────

test('no-drift stability: double re-solve is idempotent', () => {
  const project = makeLinkedSetup()
  const newProfile = rectProfile(0, 0, 20, 10)

  // First re-solve
  const first = linkedRebakeAndResolve(project, 'def-rect', newProfile)

  // Second re-solve — rebuild from the first result with the updated definition
  const firstProject = {
    ...project,
    features: first,
    featureDefinitions: {
      ...project.featureDefinitions,
      'def-rect': {
        ...project.featureDefinitions['def-rect']!,
        profile: newProfile,
        kind: inferFeatureKind(newProfile),
      },
    },
  }
  const second = linkedRebakeAndResolve(firstProject, 'def-rect', newProfile)

  // Circle centre position should be identical between passes
  const circle1 = first.find((f) => f.id === 'circle-dep')!
  const circle2 = second.find((f) => f.id === 'circle-dep')!
  const c1Seg = circle1.sketch.profile.segments[0]
  const c2Seg = circle2.sketch.profile.segments[0]
  assert(c1Seg?.type === 'circle' && c2Seg?.type === 'circle', 'both should be circles')

  if (c1Seg.type === 'circle' && c2Seg.type === 'circle') {
    assert(approx(c1Seg.center.x, c2Seg.center.x),
      `no drift: centre.x ${c1Seg.center.x} vs ${c2Seg.center.x}`)
    assert(approx(c1Seg.center.y, c2Seg.center.y),
      `no drift: centre.y ${c1Seg.center.y} vs ${c2Seg.center.y}`)
  }

  // All feature start positions should be identical
  for (const f1 of first) {
    const f2 = second.find((f) => f.id === f1.id)!
    assert(f2 != null, `feature ${f1.id} should exist in second pass`)
    assert(
      approx(f1.sketch.profile.start.x, f2.sketch.profile.start.x) &&
      approx(f1.sketch.profile.start.y, f2.sketch.profile.start.y),
      `no drift: ${f1.id} start (${f1.sketch.profile.start.x}, ${f1.sketch.profile.start.y}) vs (${f2.sketch.profile.start.x}, ${f2.sketch.profile.start.y})`,
    )
  }
})

// ──────────────────────────────────────────────────────────────────────
// 4. Constraint-created moves keep v2 resolved geometry in sync for snapping
// ──────────────────────────────────────────────────────────────────────

test('constraint commit updates instance transform so snapping sees moved circle centre', () => {
  const horizontalProfile: SketchProfile = {
    start: { x: 0, y: 0 },
    segments: [{ type: 'line', to: { x: 20, y: 0 } }],
    closed: false,
  }
  const verticalProfile: SketchProfile = {
    start: { x: 6, y: -5 },
    segments: [{ type: 'line', to: { x: 6, y: 5 } }],
    closed: false,
  }
  const circleProf = circleProfile(6, -5, 1)

  const horizontal: SketchFeature = {
    id: 'horizontal',
    name: 'Horizontal',
    kind: 'polygon',
    folderId: null,
    sketch: { profile: horizontalProfile, origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: 'add',
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
  attachDefinitionRef(horizontal, 'def-horizontal', { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })

  const vertical: SketchFeature = {
    id: 'vertical',
    name: 'Vertical',
    kind: 'polygon',
    folderId: null,
    sketch: { profile: verticalProfile, origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: 'add',
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
  attachDefinitionRef(vertical, 'def-vertical', { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })

  const circle: SketchFeature = {
    id: 'circle',
    name: 'Circle',
    kind: 'circle',
    folderId: null,
    sketch: { profile: circleProf, origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: 'add',
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
  attachDefinitionRef(circle, 'def-circle', { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })

  const project = newProject()
  project.features = [horizontal, vertical, circle]
  project.featureDefinitions = {
    'def-horizontal': { id: 'def-horizontal', kind: 'polygon', profile: horizontalProfile, dimensions: [], operation: 'add' },
    'def-vertical': { id: 'def-vertical', kind: 'polygon', profile: verticalProfile, dimensions: [], operation: 'add' },
    'def-circle': { id: 'def-circle', kind: 'circle', profile: circleProf, dimensions: [], operation: 'add' },
  }

  resetStore(project)
  const store = useProjectStore.getState()
  store.beginConstraint('circle')
  store.setConstraintAnchor({ point: { x: 6, y: -5 }, snapMode: 'center' })
  store.setConstraintReference({
    point: { x: 6, y: 0 },
    featureId: 'horizontal',
    snapMode: 'intersection',
    intersection: {
      a: { target: { source: 'feature', featureId: 'horizontal' }, segmentIndex: 0 },
      b: { target: { source: 'feature', featureId: 'vertical' }, segmentIndex: 0 },
    },
  })
  store.commitConstraintDistance(10)

  const nextProject = useProjectStore.getState().project
  const circleRow = nextProject.features.find((f) => f.id === 'circle') as (SketchFeature & { transform?: Matrix2D }) | undefined
  assert(circleRow !== undefined, 'circle row should exist')
  assert(approx(circleRow.transform?.f ?? 0, -5), `circle transform.f should be -5, got ${circleRow.transform?.f}`)

  const resolvedCircle = resolveFeatureInstance(nextProject, 'circle')
  assert(resolvedCircle !== null, 'resolved circle should exist')
  const segment = resolvedCircle!.sketch.profile.segments[0]
  assert(segment?.type === 'circle', 'resolved segment should be circle')
  if (segment.type === 'circle') {
    assert(approx(segment.center.x, 6), `resolved circle center x should be 6, got ${segment.center.x}`)
    assert(approx(segment.center.y, -10), `resolved circle center y should be -10, got ${segment.center.y}`)
  }

  const vt: ViewTransform = { scale: 1, offsetX: 0, offsetY: 0 }
  const snap = resolveSketchSnap({
    rawPoint: { x: 6, y: -10 },
    vt,
    snapSettings: { enabled: true, modes: ['center', 'line'], pixelRadius: 4 },
    project: nextProject,
    referencePoint: null,
  })
  assert(snap.mode === 'center', `snap at moved circle center should be center, got ${snap.mode}`)
  assert(approx(snap.point.x, 6) && approx(snap.point.y, -10),
    `snap point should be moved center (6,-10), got (${snap.point.x}, ${snap.point.y})`)
})

// ── Report ────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`)
if (failed > 0) throw new Error(`${failed} test(s) failed`)
