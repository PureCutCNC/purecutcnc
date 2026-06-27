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
 * Tests for Edit Sketch In Place (slice 09).
 *
 * Run with: npx tsx src/store/editInPlace.test.ts
 */

import {
  IDENTITY_MATRIX,
  newProject,
  rectProfile,
  type FeatureDefinition,
  type Matrix2D,
  type Point,
  type Project,
  type SketchFeature,
} from '../types/project'
import { useProjectStore } from './projectStore'
import type { ProjectStore } from './types'
import { getDefinitionId } from './helpers/featureDefinitions'
import { resolveProfile, applyMatrixToPoint } from './helpers/resolveFeatures'
import {
  invertMatrix,
  multiplyMatrix,
  translateMatrix,
  rotateMatrix,
  scaleMatrix,
} from './helpers/instanceTransforms'
import { transformProfileAffine } from './helpers/transform'
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

// ── Helpers ────────────────────────────────────────────────────────

function approx(a: number, b: number, epsilon = 1e-6): boolean {
  return Math.abs(a - b) <= epsilon
}

function pointEq(a: Point, b: Point, epsilon = 1e-6): boolean {
  return approx(a.x, b.x, epsilon) && approx(a.y, b.y, epsilon)
}

/** Reset the store with a fresh project. */
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

/** Add a rect feature with a definition to the store via direct state mutation. */
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
  const resolvedProfile =
    transform === IDENTITY_MATRIX
      ? profile
      : resolveProfile(definition, transform)

  const feature = {
    id,
    name,
    kind: 'rect' as const,
    folderId: null,
    sketch: {
      profile: resolvedProfile,
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'add' as const,
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
    definitionId: `def-${id}`,
    transform,
  } as SketchFeature & { definitionId?: string; transform?: Matrix2D }

  const state = useProjectStore.getState()
  useProjectStore.setState({
    project: {
      ...state.project,
      features: [...state.project.features, feature as SketchFeature],
      featureDefinitions: {
        ...state.project.featureDefinitions,
        [`def-${id}`]: definition,
      },
    },
  } as unknown as Partial<ProjectStore>)

  return { feature: feature as SketchFeature, definition }
}

/** Add a linked instance sharing an existing definition. */
function addLinkedInstance(
  id: string,
  name: string,
  definitionId: string,
  transform: Matrix2D,
): SketchFeature {
  const state = useProjectStore.getState()
  const definition = state.project.featureDefinitions[definitionId]
  assert(definition != null, `definition ${definitionId} must exist`)

  const resolved = resolveProfile(definition, transform)
  const feature = {
    id,
    name,
    kind: 'rect' as const,
    folderId: null,
    sketch: {
      profile: resolved,
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: definition.operation,
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
    definitionId,
    transform,
  } as SketchFeature & { definitionId?: string; transform?: Matrix2D }

  useProjectStore.setState({
    project: {
      ...state.project,
      features: [...state.project.features, feature as SketchFeature],
    },
  } as unknown as Partial<ProjectStore>)

  return feature as SketchFeature
}

function getProject(): Project {
  return useProjectStore.getState().project
}

function getFeatures(): SketchFeature[] {
  return getProject().features
}

// ── Tests ──────────────────────────────────────────────────────────

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

// ============================================================================
// 1. invertMatrix round-trip
// ============================================================================

console.log('\nEdit In Place — invertMatrix round-trip')

test('invertMatrix × multiplyMatrix ≈ identity for translate', () => {
  const t = translateMatrix(30, -15)
  const inv = invertMatrix(t)
  const composed = multiplyMatrix(t, inv)

  assert(approx(composed.a, 1), `a: ${composed.a}`)
  assert(approx(composed.b, 0), `b: ${composed.b}`)
  assert(approx(composed.c, 0), `c: ${composed.c}`)
  assert(approx(composed.d, 1), `d: ${composed.d}`)
  assert(approx(composed.e, 0), `e: ${composed.e}`)
  assert(approx(composed.f, 0), `f: ${composed.f}`)
})

test('invertMatrix × multiplyMatrix ≈ identity for rotate', () => {
  const r = rotateMatrix(Math.PI / 4) // 45°
  const inv = invertMatrix(r)
  const composed = multiplyMatrix(r, inv)

  assert(approx(composed.a, 1), `a: ${composed.a}`)
  assert(approx(composed.b, 0), `b: ${composed.b}`)
  assert(approx(composed.c, 0), `c: ${composed.c}`)
  assert(approx(composed.d, 1), `d: ${composed.d}`)
  assert(approx(composed.e, 0), `e: ${composed.e}`)
  assert(approx(composed.f, 0), `f: ${composed.f}`)
})

test('invertMatrix × multiplyMatrix ≈ identity for uniform scale', () => {
  const s = scaleMatrix(2.5, 2.5)
  const inv = invertMatrix(s)
  const composed = multiplyMatrix(s, inv)

  assert(approx(composed.a, 1), `a: ${composed.a}`)
  assert(approx(composed.b, 0), `b: ${composed.b}`)
  assert(approx(composed.c, 0), `c: ${composed.c}`)
  assert(approx(composed.d, 1), `d: ${composed.d}`)
  assert(approx(composed.e, 0), `e: ${composed.e}`)
  assert(approx(composed.f, 0), `f: ${composed.f}`)
})

test('invertMatrix × multiplyMatrix ≈ identity for composed transform', () => {
  // Compose: translate → rotate → scale
  const t = translateMatrix(100, 50)
  const r = rotateMatrix(Math.PI / 6)
  const s = scaleMatrix(0.5, 0.5)
  const composed = multiplyMatrix(t, multiplyMatrix(r, s))
  const inv = invertMatrix(composed)
  const roundtrip = multiplyMatrix(composed, inv)

  assert(approx(roundtrip.a, 1), `a: ${roundtrip.a}`)
  assert(approx(roundtrip.b, 0), `b: ${roundtrip.b}`)
  assert(approx(roundtrip.c, 0), `c: ${roundtrip.c}`)
  assert(approx(roundtrip.d, 1), `d: ${roundtrip.d}`)
  assert(approx(roundtrip.e, 0), `e: ${roundtrip.e}`)
  assert(approx(roundtrip.f, 0), `f: ${roundtrip.f}`)
})

test('invertMatrix returns identity for zero determinant', () => {
  const degenerate: Matrix2D = { a: 0, b: 0, c: 0, d: 0, e: 10, f: 20 }
  const inv = invertMatrix(degenerate)
  assert(inv.a === 1 && inv.b === 0 && inv.c === 0 && inv.d === 1 && inv.e === 0 && inv.f === 0,
    'degenerate should return identity')
})

// ============================================================================
// 2. Edit in place: transformed linked instances
// ============================================================================

console.log('\nEdit In Place — transformed linked instances')

test('edit-in-place keeps transformed instance at world location', () => {
  resetStore()

  // Create a rect at (10,20) with size 30×15
  const { definition } = addRectFeature('f-0001', 'Original', 10, 20, 30, 15)

  // Add a linked instance translated by +80x, +40y
  const t = translateMatrix(80, 40)
  addLinkedInstance('f-0002', 'Translated', definition.id, t)

  // Verify pre-edit state: the transformed instance should be at world location
  let features = getFeatures()
  const preTransformed = features.find((f) => f.id === 'f-0002')!
  // Origin instance at (10,20), transformed at (10+80, 20+40) = (90, 60)
  assert(pointEq(preTransformed.sketch.profile.start, { x: 90, y: 60 }),
    `pre-edit transformed start: expected (90,60), got (${preTransformed.sketch.profile.start.x}, ${preTransformed.sketch.profile.start.y})`)

  // Enter sketch edit on the transformed instance
  useProjectStore.getState().enterSketchEdit('f-0002')

  // After enterSketchEdit, the transformed instance should still be at its world location
  features = getFeatures()
  const duringEdit = features.find((f) => f.id === 'f-0002')!
  assert(pointEq(duringEdit.sketch.profile.start, { x: 90, y: 60 }),
    `during-edit transformed start: expected (90,60), got (${duringEdit.sketch.profile.start.x}, ${duringEdit.sketch.profile.start.y})`)

  // The identity instance should remain at the origin
  const duringEditOrig = features.find((f) => f.id === 'f-0001')!
  assert(pointEq(duringEditOrig.sketch.profile.start, { x: 10, y: 20 }),
    `during-edit orig start: expected (10,20), got (${duringEditOrig.sketch.profile.start.x}, ${duringEditOrig.sketch.profile.start.y})`)
})

test('fillet edit on transformed instance propagates to all instances via definition', () => {
  resetStore()

  const { definition } = addRectFeature('f-0001', 'Original', 10, 20, 30, 15)
  const t = translateMatrix(80, 40)
  addLinkedInstance('f-0002', 'Translated', definition.id, t)

  // Enter sketch edit on the transformed instance
  useProjectStore.getState().enterSketchEdit('f-0002')

  // Apply a fillet: fillet anchor 0 of the transformed instance with radius 3
  useProjectStore.getState().filletFeaturePoint('f-0002', 0, 3)

  // Apply the edit
  useProjectStore.getState().applySketchEdit()

  // Both instances should be re-baked with the new definition
  const features = getFeatures()
  const orig = features.find((f) => f.id === 'f-0001')!
  const transformed = features.find((f) => f.id === 'f-0002')!

  // Verify the original instance start is still near (10, 20) — fillet on anchor 0
  // changes the start point and inserts arc segments, so the profile changed
  assert(orig.sketch.profile.segments.length !== 4,
    `orig profile should have more than 4 segments after fillet, got ${orig.sketch.profile.segments.length}`)

  // The transformed instance should have an arc too (propagated)
  assert(transformed.sketch.profile.segments.length !== 4,
    `transformed profile should have more than 4 segments after fillet, got ${transformed.sketch.profile.segments.length}`)

  // Both instances should have the same segment count (same definition)
  assert(orig.sketch.profile.segments.length === transformed.sketch.profile.segments.length,
    `segment counts should match: orig=${orig.sketch.profile.segments.length}, transformed=${transformed.sketch.profile.segments.length}`)

  // The offset between instances should be preserved:
  // original start is near (10,20), transformed start should be near (10+80, 20+40) = (90,60)
  assert(pointEq(transformed.sketch.profile.start,
    { x: orig.sketch.profile.start.x + 80, y: orig.sketch.profile.start.y + 40 }),
    `offset preserved: orig=(${orig.sketch.profile.start.x}, ${orig.sketch.profile.start.y}), ` +
    `transformed=(${transformed.sketch.profile.start.x}, ${transformed.sketch.profile.start.y})`)

  // Verify definition profile is definition-local (not world-space)
  const def = getProject().featureDefinitions[definition.id]
  assert(def != null, 'definition should still exist')
  // Definition-local start should be near the original profile start, not at the transformed location
  assert(approx(def.profile.start.x, 10, 5), `def-local start.x should be near 10, got ${def.profile.start.x}`)
  assert(approx(def.profile.start.y, 20, 5), `def-local start.y should be near 20, got ${def.profile.start.y}`)
})

test('moveFeatureControl on transformed instance round-trips through definition', () => {
  resetStore()

  const { definition } = addRectFeature('f-0001', 'Original', 10, 20, 30, 15)
  const t = translateMatrix(80, 40)
  addLinkedInstance('f-0002', 'Translated', definition.id, t)

  // Enter sketch edit on the transformed instance
  useProjectStore.getState().enterSketchEdit('f-0002')

  // Move anchor 0 of the transformed instance to a new WORLD-SPACE position
  // The transformed instance's start is at (90, 60) (10+80, 20+40)
  // Move it to (95, 65) in world space
  useProjectStore.getState().moveFeatureControl('f-0002', { kind: 'anchor', index: 0 }, { x: 95, y: 65 })

  // Apply
  useProjectStore.getState().applySketchEdit()

  const features = getFeatures()
  const orig = features.find((f) => f.id === 'f-0001')!
  const transformed = features.find((f) => f.id === 'f-0002')!

  // The transformed instance's start should be at the world point we set
  assert(pointEq(transformed.sketch.profile.start, { x: 95, y: 65 }),
    `transformed start: expected (95,65), got (${transformed.sketch.profile.start.x}, ${transformed.sketch.profile.start.y})`)

  // The identity instance's start should be at the definition-local position:
  // (95-80, 65-40) = (15, 25) — the edit inverse-transformed
  assert(pointEq(orig.sketch.profile.start, { x: 15, y: 25 }),
    `orig start: expected (15,25), got (${orig.sketch.profile.start.x}, ${orig.sketch.profile.start.y})`)

  // Offset preserved
  assert(pointEq(transformed.sketch.profile.start,
    { x: orig.sketch.profile.start.x + 80, y: orig.sketch.profile.start.y + 40 }),
    'offset preserved after move')

  // Verify round-trip stability: resolve again and it should match
  const def = getProject().featureDefinitions[definition.id]
  const rerunOrig = resolveProfile(def, IDENTITY_MATRIX)
  assert(pointEq(rerunOrig.start, orig.sketch.profile.start),
    `round-trip orig: expected (${orig.sketch.profile.start.x}, ${orig.sketch.profile.start.y}), got (${rerunOrig.start.x}, ${rerunOrig.start.y})`)

  const rerunTransformed = resolveProfile(def, t)
  assert(pointEq(rerunTransformed.start, transformed.sketch.profile.start),
    `round-trip transformed: expected (${transformed.sketch.profile.start.x}, ${transformed.sketch.profile.start.y}), got (${rerunTransformed.start.x}, ${rerunTransformed.start.y})`)
})

test('chamfer edit on transformed instance propagates to all instances via definition', () => {
  resetStore()

  const { definition } = addRectFeature('f-0001', 'Original', 10, 20, 30, 15)
  const t = translateMatrix(80, 40)
  addLinkedInstance('f-0002', 'Translated', definition.id, t)

  useProjectStore.getState().enterSketchEdit('f-0002')
  useProjectStore.getState().chamferFeaturePoint('f-0002', 0, 3)
  useProjectStore.getState().applySketchEdit()

  const features = getFeatures()
  const original = features.find((feature) => feature.id === 'f-0001')!
  const transformed = features.find((feature) => feature.id === 'f-0002')!
  assert(original.sketch.profile.segments.length === 5, 'chamfer adds one line segment to the original instance')
  assert(transformed.sketch.profile.segments.length === 5, 'chamfer rebakes the linked instance')
  assert(transformed.sketch.profile.segments.every((segment) => segment.type === 'line'), 'chamfer remains line geometry')
  assert(pointEq(
    transformed.sketch.profile.start,
    { x: original.sketch.profile.start.x + 80, y: original.sketch.profile.start.y + 40 },
  ), 'chamfer preserves the linked instance transform')
})

test('cancelSketchEdit restores a pending chamfer edit', () => {
  resetStore()

  const { definition } = addRectFeature('f-0001', 'Original', 10, 20, 30, 15)
  addLinkedInstance('f-0002', 'Linked', definition.id, translateMatrix(80, 40))
  const before = JSON.stringify(getProject().featureDefinitions[definition.id].profile)

  useProjectStore.getState().enterSketchEdit('f-0002')
  useProjectStore.getState().chamferFeaturePoint('f-0002', 0, 3)
  useProjectStore.getState().cancelSketchEdit()

  assert(JSON.stringify(getProject().featureDefinitions[definition.id].profile) === before, 'cancel restores the shared definition after chamfer')
  assert(getFeatures().every((feature) => feature.sketch.profile.segments.length === 4), 'cancel restores every linked instance profile')
})

test('cancelSketchEdit restores pre-edit geometry', () => {
  resetStore()

  const { definition } = addRectFeature('f-0001', 'Original', 10, 20, 30, 15)
  const t = translateMatrix(80, 40)
  addLinkedInstance('f-0002', 'Translated', definition.id, t)

  // Snapshot the original definition profile
  const preDef = getProject().featureDefinitions[definition.id]
  const preProfile = JSON.stringify(preDef.profile)

  // Enter sketch edit on the transformed instance
  useProjectStore.getState().enterSketchEdit('f-0002')

  // Move an anchor
  useProjectStore.getState().moveFeatureControl('f-0002', { kind: 'anchor', index: 0 }, { x: 95, y: 65 })

  // Cancel instead of apply
  useProjectStore.getState().cancelSketchEdit()

  // Definition should be restored to pre-edit state
  const postDef = getProject().featureDefinitions[definition.id]
  assert(JSON.stringify(postDef.profile) === preProfile,
    'cancel should restore definition profile')

  // Both instances should be back at their pre-edit positions
  const features = getFeatures()
  const orig = features.find((f) => f.id === 'f-0001')!
  const transformed = features.find((f) => f.id === 'f-0002')!

  assert(pointEq(orig.sketch.profile.start, { x: 10, y: 20 }),
    `cancel restore orig: expected (10,20), got (${orig.sketch.profile.start.x}, ${orig.sketch.profile.start.y})`)
  assert(pointEq(transformed.sketch.profile.start, { x: 90, y: 60 }),
    `cancel restore transformed: expected (90,60), got (${transformed.sketch.profile.start.x}, ${transformed.sketch.profile.start.y})`)
})

// ============================================================================
// 3. Make Unique then edit-in-place
// ============================================================================

console.log('\nEdit In Place — Make Unique then edit-in-place')

test('makeUnique then edit-in-place: edit applies at actual position with translate+scale', () => {
  resetStore()

  // Create a rect at (10,20) with size 30×15 (width 30, height 15)
  const { definition } = addRectFeature('f-0001', 'Original', 10, 20, 30, 15)

  // Translate by +100x, +50y AND scale by 2x (uniform)
  const t: Matrix2D = multiplyMatrix(translateMatrix(100, 50), scaleMatrix(2, 2))
  addLinkedInstance('f-0002', 'TransformedLinked', definition.id, t)

  // Verify pre-edit: transformed start should be at applyMatrixToPoint(t, {10,20})
  let features = getFeatures()
  const preTransformed = features.find((f) => f.id === 'f-0002')!
  const expectedWorld = applyMatrixToPoint(t, { x: 10, y: 20 })
  assert(pointEq(preTransformed.sketch.profile.start, expectedWorld),
    `pre-makeUnique world pos: expected (${expectedWorld.x}, ${expectedWorld.y}), got (${preTransformed.sketch.profile.start.x}, ${preTransformed.sketch.profile.start.y})`)

  // Make Unique on the transformed instance
  useProjectStore.getState().makeUnique('f-0002')

  // After makeUnique, the instance should still be at the same world position
  features = getFeatures()
  const uniqueFeature = features.find((f) => f.id === 'f-0002')!
  assert(uniqueFeature != null, 'unique feature should still exist')
  assert(pointEq(uniqueFeature.sketch.profile.start, expectedWorld),
    `post-makeUnique world pos: expected (${expectedWorld.x}, ${expectedWorld.y}), got (${uniqueFeature.sketch.profile.start.x}, ${uniqueFeature.sketch.profile.start.y})`)

  // The original instance should be unaffected
  const origFeature = features.find((f) => f.id === 'f-0001')!
  assert(pointEq(origFeature.sketch.profile.start, { x: 10, y: 20 }),
    `orig should be unaffected: expected (10,20), got (${origFeature.sketch.profile.start.x}, ${origFeature.sketch.profile.start.y})`)

  // The unique copy should have its own definition (different from original)
  const uniqueDefId = getDefinitionId(uniqueFeature)
  assert(uniqueDefId !== definition.id, 'unique feature should have its own definitionId')

  // Enter sketch edit on the unique copy
  useProjectStore.getState().enterSketchEdit('f-0002')

  // Verify it stays at the same world position during edit (does NOT jump to origin)
  features = getFeatures()
  const duringEdit = features.find((f) => f.id === 'f-0002')!
  assert(pointEq(duringEdit.sketch.profile.start, expectedWorld),
    `during-edit unique pos: expected (${expectedWorld.x}, ${expectedWorld.y}), got (${duringEdit.sketch.profile.start.x}, ${duringEdit.sketch.profile.start.y})`)

  // Move anchor 0 to a new world position
  useProjectStore.getState().moveFeatureControl('f-0002', { kind: 'anchor', index: 0 }, { x: expectedWorld.x + 5, y: expectedWorld.y + 10 })

  // Apply
  useProjectStore.getState().applySketchEdit()

  // After apply, the unique copy should reflect the edit
  features = getFeatures()
  const postEdit = features.find((f) => f.id === 'f-0002')!
  assert(pointEq(postEdit.sketch.profile.start, { x: expectedWorld.x + 5, y: expectedWorld.y + 10 }),
    `post-edit unique pos: expected (${expectedWorld.x + 5}, ${expectedWorld.y + 10}), got (${postEdit.sketch.profile.start.x}, ${postEdit.sketch.profile.start.y})`)

  // The original instance should be completely unaffected
  const postOrig = features.find((f) => f.id === 'f-0001')!
  assert(pointEq(postOrig.sketch.profile.start, { x: 10, y: 20 }),
    `post-edit orig should still be (10,20), got (${postOrig.sketch.profile.start.x}, ${postOrig.sketch.profile.start.y})`)

  // The unique copy's definition should have the edit in definition-local space
  const uniqueDef = getProject().featureDefinitions[uniqueDefId]
  assert(uniqueDef != null, 'unique definition should exist')
  // The definition-local start should be the inverse of the transform applied to the world point
  const inv = invertMatrix(t)
  const expectedDefLocal = applyMatrixToPoint(inv, { x: expectedWorld.x + 5, y: expectedWorld.y + 10 })
  assert(pointEq(uniqueDef.profile.start, expectedDefLocal),
    `unique def-local start: expected (${expectedDefLocal.x}, ${expectedDefLocal.y}), got (${uniqueDef.profile.start.x}, ${uniqueDef.profile.start.y})`)
})

test('makeUnique then edit-in-place: only unique copy changes, other instances unaffected', () => {
  resetStore()

  // Create a shared definition with two instances
  const { definition } = addRectFeature('f-0001', 'Original', 10, 20, 30, 15)
  addLinkedInstance('f-0002', 'Linked-1', definition.id, translateMatrix(50, 0))
  addLinkedInstance('f-0003', 'Linked-2', definition.id, translateMatrix(0, 50))

  // The instance we'll make unique — linked-1 at +50x
  const preLinked1 = getFeatures().find((f) => f.id === 'f-0002')!
  const preLinked1Start = { ...preLinked1.sketch.profile.start }
  // Should be (10+50, 20+0) = (60, 20)
  assert(pointEq(preLinked1Start, { x: 60, y: 20 }),
    `pre linked-1 start: expected (60,20), got (${preLinked1Start.x}, ${preLinked1Start.y})`)

  // Make Unique on f-0002
  useProjectStore.getState().makeUnique('f-0002')

  // Enter sketch edit on the unique copy (f-0002)
  useProjectStore.getState().enterSketchEdit('f-0002')

  // Move anchor 0 to a new world position
  useProjectStore.getState().moveFeatureControl('f-0002', { kind: 'anchor', index: 0 }, { x: 65, y: 25 })

  // Apply
  useProjectStore.getState().applySketchEdit()

  // Unique copy (f-0002) should reflect the edit
  const postEditLinked1 = getFeatures().find((f) => f.id === 'f-0002')!
  assert(pointEq(postEditLinked1.sketch.profile.start, { x: 65, y: 25 }),
    `post-edit unique: expected (65,25), got (${postEditLinked1.sketch.profile.start.x}, ${postEditLinked1.sketch.profile.start.y})`)

  // Original instance (f-0001) should be unaffected
  const postOrig = getFeatures().find((f) => f.id === 'f-0001')!
  assert(pointEq(postOrig.sketch.profile.start, { x: 10, y: 20 }),
    `post-edit orig should be (10,20), got (${postOrig.sketch.profile.start.x}, ${postOrig.sketch.profile.start.y})`)

  // Linked-2 (f-0003) shares definition with f-0001, should be unaffected by the unique edit
  const postLinked2 = getFeatures().find((f) => f.id === 'f-0003')!
  assert(pointEq(postLinked2.sketch.profile.start, { x: 10, y: 70 }),
    `post-edit linked-2 should be (10,70), got (${postLinked2.sketch.profile.start.x}, ${postLinked2.sketch.profile.start.y})`)
})

// Regression: transformProfileAffine must transform a circle's center, not just
// its edge point. Omitting it corrupted the radius when inverse-baking the edit
// of a moved/copied circle (huge-circle bug).
test('transformProfileAffine transforms circle center (radius preserved under translate)', () => {
  const profile = {
    start: { x: 60, y: 50 },
    segments: [
      { type: 'circle' as const, center: { x: 50, y: 50 }, to: { x: 60, y: 50 }, clockwise: false },
    ],
    closed: true,
  }
  const moved = transformProfileAffine(profile, (p: Point) => ({ x: p.x + 100, y: p.y + 100 }))
  const seg = moved.segments[0] as { type: 'circle'; center: Point; to: Point }
  assert(seg.type === 'circle', 'segment should remain a circle')
  assert(pointEq(seg.center, { x: 150, y: 150 }), `center should move to (150,150), got (${seg.center.x},${seg.center.y})`)
  assert(pointEq(moved.start, { x: 160, y: 150 }), `start should move to (160,150), got (${moved.start.x},${moved.start.y})`)
  const radius = Math.hypot(moved.start.x - seg.center.x, moved.start.y - seg.center.y)
  assert(approx(radius, 10), `radius preserved at 10, got ${radius}`)
})

// Regression: arc segments (e.g. in composites) must survive rebake instead of
// being flattened to splines. resolveProfile keeps arcs under similarity
// transforms; transformProfileAffine (inverse-bake) keeps them as arcs.
test('resolveProfile preserves arc segments under identity + translate', () => {
  const profile = {
    start: { x: 10, y: 0 },
    segments: [
      { type: 'arc' as const, to: { x: 0, y: 10 }, center: { x: 0, y: 0 }, clockwise: false },
      { type: 'line' as const, to: { x: 0, y: 0 } },
      { type: 'line' as const, to: { x: 10, y: 0 } },
    ],
    closed: true,
  }
  const def: FeatureDefinition = {
    id: 'd-arc', kind: 'composite', profile,
    dimensions: [], text: null, stl: null, operation: 'add',
  }
  const ident = resolveProfile(def, IDENTITY_MATRIX)
  assert(ident.segments[0].type === 'arc', `identity should keep arc, got ${ident.segments[0].type}`)

  const moved = resolveProfile(def, translateMatrix(100, 50))
  const a = moved.segments[0]
  assert(a.type === 'arc', `translate should keep arc, got ${a.type}`)
  assert(a.type === 'arc' && pointEq(a.center, { x: 100, y: 50 }), 'arc center should translate')
})

test('transformProfileAffine keeps arc segments (center transformed)', () => {
  const profile = {
    start: { x: 10, y: 0 },
    segments: [{ type: 'arc' as const, to: { x: 0, y: 10 }, center: { x: 0, y: 0 }, clockwise: false }],
    closed: false,
  }
  const out = transformProfileAffine(profile, (p: Point) => ({ x: p.x + 5, y: p.y + 5 }))
  const a = out.segments[0]
  assert(a.type === 'arc', `should keep arc, got ${a.type}`)
  assert(a.type === 'arc' && pointEq(a.center, { x: 5, y: 5 }), 'arc center should move')
})

// ============================================================================
// Summary
// ============================================================================

console.log(`\n${passed} passed, ${failed} failed`)

if (failed > 0) {
  process.exit(1)
}
