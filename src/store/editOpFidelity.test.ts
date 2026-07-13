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
 * Sketch-Edit Op Fidelity Tests — Phase 3 audit-and-fill (Area B).
 *
 * Fills holes not covered by H1 (move-a-point round-trip) or editInPlace
 * (fillet + linked propagation): insert/delete point, disconnect,
 * arc-handle edit — each with linked-instance propagation and
 * segment-kind preservation assertions.
 *
 * Run with: npx tsx src/store/editOpFidelity.test.ts
 */

import {
  IDENTITY_MATRIX,
  newProject,
  rectProfile,
  type FeatureDefinition,
  type FeatureInstance,
  type Matrix2D,
  type Point,
  type Project,
  type SketchFeature,
} from '../types/project'
import { useProjectStore } from './projectStore'
import type { ProjectStore } from './types'
import { resolveFeatureInstance, resolvedProjectFeatures } from './helpers/resolveFeatures'
import { translateMatrix } from './helpers/instanceTransforms'

// ── Helpers ──────────────────────────────────────────────────────────

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(a: number, b: number, epsilon = 1e-6): boolean {
  return Math.abs(a - b) <= epsilon
}

function pointEq(a: Point, b: Point, epsilon = 1e-6): boolean {
  return approx(a.x, b.x, epsilon) && approx(a.y, b.y, epsilon)
}

function resetStore(project?: Project): void {
  useProjectStore.setState({
    project: project ?? newProject(),
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
  } as unknown as Partial<ProjectStore>)
}

function addRectFeature(
  id: string,
  name: string,
  cx: number,
  cy: number,
  w: number,
  h: number,
  opts?: { transform?: Matrix2D },
): { feature: SketchFeature; definition: FeatureDefinition } {
  const profile = rectProfile(cx, cy, w, h)
  const transform = opts?.transform ?? IDENTITY_MATRIX
  const definition: FeatureDefinition = {
    id: `def-${id}`,
    kind: 'rect',
    profile,
    dimensions: [],
    text: null,
    stl: null,
    operation: 'add',
  }
  const instance: FeatureInstance = {
    id,
    name,
    definitionId: `def-${id}`,
    transform: { ...transform },
    constraints: [],
    folderId: null,
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
  }

  const state = useProjectStore.getState()
  useProjectStore.setState({
    project: {
      ...state.project,
      features: [...state.project.features, instance],
      featureDefinitions: {
        ...state.project.featureDefinitions,
        [`def-${id}`]: definition,
      },
    },
  } as unknown as Partial<ProjectStore>)

  const feature = resolveFeatureInstance(useProjectStore.getState().project, id)
  assert(feature, `feature ${id} should resolve`)
  return { feature, definition }
}

function addLinkedInstance(
  id: string,
  name: string,
  definitionId: string,
  transform: Matrix2D,
): SketchFeature {
  const state = useProjectStore.getState()
  const definition = state.project.featureDefinitions[definitionId]
  assert(definition != null, `definition ${definitionId} must exist`)

  const instance: FeatureInstance = {
    id,
    name,
    definitionId,
    transform: { ...transform },
    constraints: [],
    folderId: null,
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
  }

  useProjectStore.setState({
    project: {
      ...state.project,
      features: [...state.project.features, instance],
    },
  } as unknown as Partial<ProjectStore>)

  const feature = resolveFeatureInstance(useProjectStore.getState().project, id)
  assert(feature, `feature ${id} should resolve`)
  return feature
}

function getProject(): Project {
  return useProjectStore.getState().project
}

function getFeatures(): SketchFeature[] {
  return resolvedProjectFeatures(getProject())
}

// ── Test runner ──────────────────────────────────────────────────────

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

// =====================================================================
// 1. INSERT POINT — segment kinds preserved + linked propagation
// =====================================================================

console.log('\nInsert point — segment kinds + linked propagation')

test('insert point on rect segment: segments stay lines, linked sibling updated', () => {
  resetStore()

  // Create a rect at (10,20) with size 30×15
  const { definition } = addRectFeature('f-0001', 'Original', 10, 20, 30, 15)

  // Add linked instance translated
  const t = translateMatrix(80, 40)
  addLinkedInstance('f-0002', 'Linked', definition.id, t)

  // Enter sketch edit on the original instance
  useProjectStore.getState().enterSketchEdit('f-0001')

  // Insert a point at the midpoint of segment 0 (top edge, from (10,20) to (40,20))
  // t=0.5 means midpoint
  useProjectStore.getState().insertFeaturePoint('f-0001', {
    kind: 'segment',
    segmentIndex: 0,
    point: { x: 25, y: 20 },
    t: 0.5,
  })

  // Apply the edit
  useProjectStore.getState().applySketchEdit()

  const features = getFeatures()
  const orig = features.find((f) => f.id === 'f-0001')!
  const linked = features.find((f) => f.id === 'f-0002')!

  // Original should now have 5 segments (4 original → 5 after insert)
  assert(orig.sketch.profile.segments.length === 5,
    `orig should have 5 segments after insert, got ${orig.sketch.profile.segments.length}`)

  // All segments should be lines (no arcs, beziers introduced)
  for (const seg of orig.sketch.profile.segments) {
    assert(seg.type === 'line', `all segments should be lines after line-insert, got ${seg.type}`)
  }

  // Linked instance should have the same segment count (propagated)
  assert(linked.sketch.profile.segments.length === orig.sketch.profile.segments.length,
    `linked should have ${orig.sketch.profile.segments.length} segments, got ${linked.sketch.profile.segments.length}`)

  // All linked segments should also be lines
  for (const seg of linked.sketch.profile.segments) {
    assert(seg.type === 'line', `linked segments should all be lines, got ${seg.type}`)
  }

  // Offset preserved
  assert(pointEq(linked.sketch.profile.start,
    { x: orig.sketch.profile.start.x + 80, y: orig.sketch.profile.start.y + 40 }),
    'linked offset should be preserved after insert')

  // Definition should hold canonical (untransformed) shape
  const def = getProject().featureDefinitions[definition.id]
  assert(def != null, 'definition should still exist')
  assert(def.profile.segments.length === 5, `definition should have 5 segments, got ${def.profile.segments.length}`)
  for (const seg of def.profile.segments) {
    assert(seg.type === 'line', `definition segments should be lines, got ${seg.type}`)
  }
})

// =====================================================================
// 2. DELETE POINT — segment kinds preserved + linked propagation
// =====================================================================

console.log('\nDelete point — segment kinds + linked propagation')

test('delete point from rect: profile stays valid, linked sibling updated', () => {
  resetStore()

  const { definition } = addRectFeature('f-0001', 'Original', 10, 20, 30, 15)
  const t = translateMatrix(80, 40)
  addLinkedInstance('f-0002', 'Linked', definition.id, t)

  // First insert a point so we have 5 anchors
  useProjectStore.getState().enterSketchEdit('f-0001')
  useProjectStore.getState().insertFeaturePoint('f-0001', {
    kind: 'segment',
    segmentIndex: 0,
    point: { x: 25, y: 20 },
    t: 0.5,
  })
  useProjectStore.getState().applySketchEdit()

  // Now enter edit again and delete the inserted point (anchor at index 1)
  useProjectStore.getState().enterSketchEdit('f-0001')
  useProjectStore.getState().deleteFeaturePoint('f-0001', 1)
  useProjectStore.getState().applySketchEdit()

  const features = getFeatures()
  const orig = features.find((f) => f.id === 'f-0001')!
  const linked = features.find((f) => f.id === 'f-0002')!

  // Should be back to 4 segments (rect)
  assert(orig.sketch.profile.segments.length === 4,
    `orig should have 4 segments after delete, got ${orig.sketch.profile.segments.length}`)

  // All segments should be lines
  for (const seg of orig.sketch.profile.segments) {
    assert(seg.type === 'line', `segments should be lines after delete, got ${seg.type}`)
  }

  // Profile should still be closed
  assert(orig.sketch.profile.closed, 'profile should still be closed after delete')

  // Linked propagated
  assert(linked.sketch.profile.segments.length === 4,
    `linked should have 4 segments, got ${linked.sketch.profile.segments.length}`)

  // Offset preserved
  assert(pointEq(linked.sketch.profile.start,
    { x: orig.sketch.profile.start.x + 80, y: orig.sketch.profile.start.y + 40 }),
    'linked offset preserved after delete')

  // Definition canonical shape
  const def = getProject().featureDefinitions[definition.id]
  assert(def != null, 'definition should exist')
  assert(def.profile.segments.length === 4, 'definition should have 4 segments')
})

// =====================================================================
// 3. DISCONNECT — closed→open + linked propagation
// =====================================================================

console.log('\nDisconnect — profile break + linked propagation')

test('disconnect opens closed profile at anchor, linked sibling reflects change', () => {
  resetStore()

  const { definition } = addRectFeature('f-0001', 'Original', 10, 20, 30, 15)
  const t = translateMatrix(80, 40)
  addLinkedInstance('f-0002', 'Linked', definition.id, t)

  // Enter sketch edit and disconnect at anchor 1
  useProjectStore.getState().enterSketchEdit('f-0001')
  useProjectStore.getState().disconnectFeaturePoint('f-0001', 1)
  useProjectStore.getState().applySketchEdit()

  const features = getFeatures()
  const orig = features.find((f) => f.id === 'f-0001')!
  const linked = features.find((f) => f.id === 'f-0002')!

  // Profile should now be open
  assert(!orig.sketch.profile.closed, 'disconnected profile should be open')

  // Start should be at the disconnected anchor (anchor 1)
  // Anchor 1 of rect (10,20,30,15) is at top-right: (40, 20)
  assert(pointEq(orig.sketch.profile.start, { x: 40, y: 20 }),
    `disconnected start should be at anchor 1 (40,20), got (${orig.sketch.profile.start.x}, ${orig.sketch.profile.start.y})`)

  // Segment kinds should all be lines
  for (const seg of orig.sketch.profile.segments) {
    assert(seg.type === 'line', `segments should be lines after disconnect, got ${seg.type}`)
  }

  // Linked propagated — should also be open
  assert(!linked.sketch.profile.closed, 'linked profile should also be open')

  // Linked start offset preserved
  assert(pointEq(linked.sketch.profile.start,
    { x: orig.sketch.profile.start.x + 80, y: orig.sketch.profile.start.y + 40 }),
    'linked offset preserved after disconnect')

  // Definition holds canonical open shape
  const def = getProject().featureDefinitions[definition.id]
  assert(def != null, 'definition should exist')
  assert(!def.profile.closed, 'definition profile should be open')
})

// =====================================================================
// 4. ARC HANDLE EDIT — segment stays arc + linked propagation
// =====================================================================

console.log('\nArc handle edit — segment stays arc + linked propagation')

test('move arc handle: segment stays arc, linked sibling updated', () => {
  resetStore()

  // Create a composite feature with an arc segment
  const profile = {
    start: { x: 10, y: 0 },
    segments: [
      { type: 'line' as const, to: { x: 20, y: 0 } },
      { type: 'arc' as const, to: { x: 30, y: 10 }, center: { x: 20, y: 10 }, clockwise: false },
      { type: 'line' as const, to: { x: 10, y: 10 } },
      { type: 'line' as const, to: { x: 10, y: 0 } },
    ],
    closed: true,
  }

  const definition: FeatureDefinition = {
    id: 'def-comp',
    kind: 'composite',
    profile,
    dimensions: [],
    text: null,
    stl: null,
    operation: 'add',
  }

  const state = useProjectStore.getState()
  useProjectStore.setState({
    project: {
      ...state.project,
      features: [...state.project.features, {
        id: 'f-0001',
        name: 'Original',
        definitionId: 'def-comp',
        transform: { ...IDENTITY_MATRIX },
        constraints: [],
        folderId: null,
        z_top: 5,
        z_bottom: 0,
        visible: true,
        locked: false,
      }],
      featureDefinitions: {
        ...state.project.featureDefinitions,
        'def-comp': definition,
      },
    },
  } as unknown as Partial<ProjectStore>)

  // Add linked instance
  const t = translateMatrix(80, 40)
  addLinkedInstance('f-0002', 'Linked', 'def-comp', t)

  // Enter sketch edit and move the arc handle (segment 1, arc_handle index 1)
  // The arc_handle is the control point between center and endpoint
  useProjectStore.getState().enterSketchEdit('f-0001')
  useProjectStore.getState().moveFeatureControl('f-0001',
    { kind: 'arc_handle', index: 1 },
    { x: 25, y: 15 },  // move arc handle outward
  )
  useProjectStore.getState().applySketchEdit()

  const features = getFeatures()
  const orig = features.find((f) => f.id === 'f-0001')!
  const linked = features.find((f) => f.id === 'f-0002')!

  // Segment 1 should still be an arc
  const origArc = orig.sketch.profile.segments[1]
  assert(origArc.type === 'arc', `segment 1 should stay arc after handle move, got ${origArc.type}`)

  // Arc center may have moved — at minimum the arc should not be degenerate
  if (origArc.type === 'arc') {
    const radius = Math.hypot(origArc.to.x - origArc.center.x, origArc.to.y - origArc.center.y)
    assert(radius > 0, 'arc radius should be > 0 after handle move')
  }

  // Linked segment 1 should also be an arc
  const linkedArc = linked.sketch.profile.segments[1]
  assert(linkedArc.type === 'arc', `linked segment 1 should stay arc, got ${linkedArc.type}`)

  // Offset preserved
  assert(pointEq(linked.sketch.profile.start,
    { x: orig.sketch.profile.start.x + 80, y: orig.sketch.profile.start.y + 40 }),
    'linked offset preserved after arc handle move')

  // Definition holds canonical shape with arc
  const def = getProject().featureDefinitions['def-comp']
  assert(def != null, 'definition should exist')
  const defArc = def.profile.segments[1]
  assert(defArc.type === 'arc', `definition segment 1 should be arc, got ${defArc.type}`)
})

// =====================================================================
// Summary
// =====================================================================

console.log(`\n${passed} passed, ${failed} failed`)

if (failed > 0) {
  process.exit(1)
}
