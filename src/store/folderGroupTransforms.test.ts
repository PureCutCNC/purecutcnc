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
 * Folder Transform Groups — Slice 3 (verification) unit tests.
 *
 * Verifies that group transforms (move/copy/resize/rotate/mirror) already
 * work through the existing transform machinery when slice 2a selection
 * expansion fans out the entity IDs. No new transform code is added;
 * these tests confirm the behavior.
 *
 * Run with: npx tsx src/store/folderGroupTransforms.test.ts
 */

import { newProject, type Matrix2D } from '../types/project'
import { useProjectStore } from './projectStore'
import type { ProjectStore } from './types'
import { multiplyMatrix, rotateDelta } from './helpers/instanceTransforms'
import { isIdentityMatrix, resolveFeatureInstance } from './helpers/resolveFeatures'

// ── Assertion helpers ──────────────────────────────────────────────

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(left: number, right: number, epsilon = 1e-6): boolean {
  return Math.abs(left - right) <= epsilon
}

function assertApprox(left: number, right: number, message: string, epsilon = 1e-5): void {
  assert(approx(left, right, epsilon), `${message}: expected ~${right}, got ${left}`)
}

// ── Store helpers ──────────────────────────────────────────────────

function resetStore(): void {
  useProjectStore.setState({
    project: newProject(),
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
    pendingMove: null,
    pendingTransform: null,
    pendingOffset: null,
    pendingShapeAction: null,
    pendingAdd: null,
    creationTarget: 'feature',
  } as unknown as Partial<ProjectStore>)
}

/**
 * Build a grouped folder with N rect features and return their ids + folder id.
 * Each rect is placed at the given position. After this, the store state
 * has the newly created feature selected (single-feature selection from addFeature).
 */
function setupGroupedFolderWithRects(
  rects: Array<{ name: string; x: number; y: number; w: number; h: number; depth: number }>,
): { folderId: string; featureIds: string[] } {
  resetStore()

  const folderId = useProjectStore.getState().addFeatureFolder('features')
  useProjectStore.getState().toggleFolderGrouped(folderId)

  const featureIds: string[] = []
  for (const r of rects) {
    useProjectStore.getState().addRectFeature(r.name, r.x, r.y, r.w, r.h, r.depth)
    const sel = useProjectStore.getState().selection
    assert(sel.selectedFeatureId !== null, 'expected a selected feature after addRectFeature')
    featureIds.push(sel.selectedFeatureId)
  }

  return { folderId, featureIds }
}

/**
 * Get the transform matrix from a feature in the store, defaulting to identity.
 */
function getFeatureTransform(featureId: string): Matrix2D {
  const state = useProjectStore.getState()
  const feature = state.project.features.find((f) => f.id === featureId)
  assert(feature !== undefined, `feature ${featureId} not found in project`)
  return feature.transform
}

/**
 * Get the definition ID for a feature, if any.
 */
function getFeatureDefinitionId(featureId: string): string | undefined {
  const state = useProjectStore.getState()
  const feature = state.project.features.find((f) => f.id === featureId)
  assert(feature !== undefined, `feature ${featureId} not found in project`)
  return feature.definitionId
}

// ── Test runner ────────────────────────────────────────────────────

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
// 1. start* actions fan entityIds to all group members
// ============================================================================

console.log('\n1. start* actions fan entityIds to all group members')

test('startResizeFeature on grouped member sets entityIds to all members', () => {
  const { featureIds } = setupGroupedFolderWithRects([
    { name: 'F1', x: 0, y: 0, w: 100, h: 100, depth: 5 },
    { name: 'F2', x: 200, y: 0, w: 100, h: 100, depth: 5 },
  ])
  assert(featureIds.length === 2, `expected 2 features, got ${featureIds.length}`)
  const [f1, f2] = featureIds

  // Deselect, then select f1 non-additively to trigger group expansion
  useProjectStore.getState().selectProject()
  useProjectStore.getState().selectFeature(f1, false)
  const selPre = useProjectStore.getState().selection
  assert(selPre.selectedFeatureIds.length === 2, 'selection should include both group members')
  assert(selPre.groupFolderId !== null, 'groupFolderId should be set')

  // Start resize on one member
  useProjectStore.getState().startResizeFeature(f1)
  const pending = useProjectStore.getState().pendingTransform
  assert(pending !== null, 'pendingTransform should be set')
  assert(pending.mode === 'resize', 'pending transform mode should be resize')
  assert(pending.entityIds.length === 2, `expected 2 entityIds, got ${pending.entityIds.length}`)
  assert(pending.entityIds.includes(f1), 'entityIds should include f1')
  assert(pending.entityIds.includes(f2), 'entityIds should include f2')
})

test('startRotateFeature on grouped member sets entityIds to all members', () => {
  const { featureIds } = setupGroupedFolderWithRects([
    { name: 'F1', x: 0, y: 0, w: 100, h: 100, depth: 5 },
    { name: 'F2', x: 200, y: 0, w: 100, h: 100, depth: 5 },
  ])
  const [f1, f2] = featureIds

  useProjectStore.getState().selectProject()
  useProjectStore.getState().selectFeature(f1, false)

  useProjectStore.getState().startRotateFeature(f1)
  const pending = useProjectStore.getState().pendingTransform
  assert(pending !== null, 'pendingTransform should be set')
  assert(pending.mode === 'rotate', 'pending transform mode should be rotate')
  assert(pending.entityIds.length === 2, `expected 2 entityIds, got ${pending.entityIds.length}`)
  assert(pending.entityIds.includes(f1) && pending.entityIds.includes(f2), 'entityIds should include both members')
})

test('startMirrorFeature on grouped member sets entityIds to all members', () => {
  const { featureIds } = setupGroupedFolderWithRects([
    { name: 'F1', x: 0, y: 0, w: 100, h: 100, depth: 5 },
    { name: 'F2', x: 200, y: 0, w: 100, h: 100, depth: 5 },
  ])
  const [f1, f2] = featureIds

  useProjectStore.getState().selectProject()
  useProjectStore.getState().selectFeature(f1, false)

  useProjectStore.getState().startMirrorFeature(f1)
  const pending = useProjectStore.getState().pendingTransform
  assert(pending !== null, 'pendingTransform should be set')
  assert(pending.mode === 'mirror', 'pending transform mode should be mirror')
  assert(pending.entityIds.length === 2, `expected 2 entityIds, got ${pending.entityIds.length}`)
  assert(pending.entityIds.includes(f1) && pending.entityIds.includes(f2), 'entityIds should include both members')
})

test('startMoveFeature on grouped member sets entityIds to all members', () => {
  const { featureIds } = setupGroupedFolderWithRects([
    { name: 'F1', x: 0, y: 0, w: 100, h: 100, depth: 5 },
    { name: 'F2', x: 200, y: 0, w: 100, h: 100, depth: 5 },
  ])
  const [f1, f2] = featureIds

  useProjectStore.getState().selectProject()
  useProjectStore.getState().selectFeature(f1, false)

  useProjectStore.getState().startMoveFeature(f1)
  const pending = useProjectStore.getState().pendingMove
  assert(pending !== null, 'pendingMove should be set')
  assert(pending.mode === 'move', 'pending move mode should be move')
  assert(pending.entityIds.length === 2, `expected 2 entityIds, got ${pending.entityIds.length}`)
  assert(pending.entityIds.includes(f1) && pending.entityIds.includes(f2), 'entityIds should include both members')
})

test('startCopyFeature on grouped member sets entityIds to all members', () => {
  const { featureIds } = setupGroupedFolderWithRects([
    { name: 'F1', x: 0, y: 0, w: 100, h: 100, depth: 5 },
    { name: 'F2', x: 200, y: 0, w: 100, h: 100, depth: 5 },
  ])
  const [f1, f2] = featureIds

  useProjectStore.getState().selectProject()
  useProjectStore.getState().selectFeature(f1, false)

  useProjectStore.getState().startCopyFeature(f1)
  const pending = useProjectStore.getState().pendingMove
  assert(pending !== null, 'pendingMove should be set for copy')
  assert(pending.mode === 'copy', 'pending move mode should be copy')
  assert(pending.entityIds.length === 2, `expected 2 entityIds, got ${pending.entityIds.length}`)
  assert(pending.entityIds.includes(f1) && pending.entityIds.includes(f2), 'entityIds should include both members')
})

// ============================================================================
// 2. Rigid-body transform: shared pivot preserves relative layout
// ============================================================================

console.log('\n2. Rigid-body transform preserves relative layout')

test('group rotate transforms all members about the same shared pivot', () => {
  const { featureIds } = setupGroupedFolderWithRects([
    { name: 'F1', x: 0, y: 0, w: 100, h: 100, depth: 5 },
    { name: 'F2', x: 200, y: 0, w: 100, h: 100, depth: 5 },
  ])
  const [f1, f2] = featureIds

  // Record pre-transform state
  const oldTransform1 = getFeatureTransform(f1)
  const oldTransform2 = getFeatureTransform(f2)
  const oldDefIds = new Set([getFeatureDefinitionId(f1), getFeatureDefinitionId(f2)])

  // Select group and start rotate
  useProjectStore.getState().selectProject()
  useProjectStore.getState().selectFeature(f1, false)
  useProjectStore.getState().startRotateFeature(f1)

  // Set up a 90° CCW rotation around pivot (100, 0)
  // referenceStart=100,0  referenceEnd=110,0  previewPoint=100,10
  // startVector=(10,0), endVector=(0,10), angle=atan2(10*10 - 0*0, 0) = atan2(100, 0) = π/2
  const pivot = { x: 100, y: 0 }
  useProjectStore.getState().setPendingTransformReferenceStart(pivot)
  useProjectStore.getState().setPendingTransformReferenceEnd({ x: 110, y: 0 })
  useProjectStore.getState().completePendingTransform({ x: 100, y: 10 })

  // Verify pending transform cleared
  assert(useProjectStore.getState().pendingTransform === null, 'pendingTransform should be cleared')

  // Verify both features still exist
  const newTransform1 = getFeatureTransform(f1)
  const newTransform2 = getFeatureTransform(f2)
  assert(!isIdentityMatrix(newTransform1), 'f1 transform should not be identity after rotate')
  assert(!isIdentityMatrix(newTransform2), 'f2 transform should not be identity after rotate')

  // Expected rotation delta: rotateDelta(pivot, π/2)
  const expectedDelta = rotateDelta(pivot, Math.PI / 2)

  // Verify each feature's new transform = expectedDelta * oldTransform (rigid-body invariant)
  const expectedT1 = multiplyMatrix(expectedDelta, oldTransform1)
  const expectedT2 = multiplyMatrix(expectedDelta, oldTransform2)

  for (const key of ['a', 'b', 'c', 'd', 'e', 'f'] as const) {
    assertApprox(newTransform1[key], expectedT1[key], `f1 transform.${key} mismatch`)
    assertApprox(newTransform2[key], expectedT2[key], `f2 transform.${key} mismatch`)
  }

  // Verify feature definitions are unchanged (no new definitions, old ones still present)
  const state = useProjectStore.getState()
  for (const defId of oldDefIds) {
    assert(defId !== undefined && state.project.featureDefinitions[defId] !== undefined,
      `definition ${defId} should still exist`)
  }
})

test('group resize transforms all members about the same shared pivot', () => {
  const { featureIds } = setupGroupedFolderWithRects([
    { name: 'F1', x: 0, y: 0, w: 100, h: 100, depth: 5 },
    { name: 'F2', x: 200, y: 0, w: 100, h: 100, depth: 5 },
  ])
  const [f1, f2] = featureIds

  // Select group and start resize
  useProjectStore.getState().selectProject()
  useProjectStore.getState().selectFeature(f1, false)
  useProjectStore.getState().startResizeFeature(f1)

  // Use a pivot between the two features (at x=100, y=0) so both features
  // are offset from the pivot. referenceStart=(100,0), referenceEnd=(200,0),
  // previewPoint=(300,0) → 2x scale along X pivoted at (100,0).
  useProjectStore.getState().setPendingTransformReferenceStart({ x: 100, y: 0 })
  useProjectStore.getState().setPendingTransformReferenceEnd({ x: 200, y: 0 })
  useProjectStore.getState().completePendingTransform({ x: 300, y: 0 })

  assert(useProjectStore.getState().pendingTransform === null, 'pendingTransform should be cleared')

  // Both features should have non-identity transforms after resize
  const newTransform1 = getFeatureTransform(f1)
  const newTransform2 = getFeatureTransform(f2)
  assert(!isIdentityMatrix(newTransform1), 'f1 transform should not be identity after resize')
  assert(!isIdentityMatrix(newTransform2), 'f2 transform should not be identity after resize')

  // Verify both features still exist in the project
  const state = useProjectStore.getState()
  assert(state.project.features.some((f) => f.id === f1), 'f1 should still exist')
  assert(state.project.features.some((f) => f.id === f2), 'f2 should still exist')

  // Shared-pivot proof: both features receive the same scale transform composed
  // onto their current transform. Since both start from IDENTITY, they should
  // have identical resulting transforms — proving they share the same pivot.
  const bothScaled = newTransform1.a > 1 && newTransform2.a > 1
  assert(bothScaled, 'both features should have X-scale > 1')

  // All 6 matrix components must match (both features get the same composed delta)
  for (const key of ['a', 'b', 'c', 'd', 'e', 'f'] as const) {
    assertApprox(newTransform1[key], newTransform2[key],
      `shared-pivot invariant: transform.${key} should match for both members`)
  }
})

test('group move translates all members by the same delta', () => {
  const { featureIds } = setupGroupedFolderWithRects([
    { name: 'F1', x: 0, y: 0, w: 100, h: 100, depth: 5 },
    { name: 'F2', x: 200, y: 0, w: 100, h: 100, depth: 5 },
  ])
  const [f1, f2] = featureIds

  const oldTransform1 = getFeatureTransform(f1)
  const oldTransform2 = getFeatureTransform(f2)

  // Select group and start move
  useProjectStore.getState().selectProject()
  useProjectStore.getState().selectFeature(f1, false)
  useProjectStore.getState().startMoveFeature(f1)

  // Move by (50, 30)
  useProjectStore.getState().setPendingMoveFrom({ x: 0, y: 0 })
  useProjectStore.getState().completePendingMove({ x: 50, y: 30 })

  assert(useProjectStore.getState().pendingMove === null, 'pendingMove should be cleared')

  const newTransform1 = getFeatureTransform(f1)
  const newTransform2 = getFeatureTransform(f2)

  // Both should have their translation components incremented by (50, 30)
  assertApprox(newTransform1.e, oldTransform1.e + 50, 'f1 transform.e')
  assertApprox(newTransform1.f, oldTransform1.f + 30, 'f1 transform.f')
  assertApprox(newTransform2.e, oldTransform2.e + 50, 'f2 transform.e')
  assertApprox(newTransform2.f, oldTransform2.f + 30, 'f2 transform.f')

  // Linear parts (a,b,c,d) should be unchanged (move is pure translation)
  assertApprox(newTransform1.a, oldTransform1.a, 'f1 transform.a')
  assertApprox(newTransform1.b, oldTransform1.b, 'f1 transform.b')
  assertApprox(newTransform1.c, oldTransform1.c, 'f1 transform.c')
  assertApprox(newTransform1.d, oldTransform1.d, 'f1 transform.d')

  assertApprox(newTransform2.a, oldTransform2.a, 'f2 transform.a')
  assertApprox(newTransform2.b, oldTransform2.b, 'f2 transform.b')
  assertApprox(newTransform2.c, oldTransform2.c, 'f2 transform.c')
  assertApprox(newTransform2.d, oldTransform2.d, 'f2 transform.d')
})

// ============================================================================
// 3. Feature-reference invariant
// ============================================================================

console.log('\n3. Feature-reference invariant')

test('group transform does not mutate FeatureDefinition entries', () => {
  const { featureIds } = setupGroupedFolderWithRects([
    { name: 'F1', x: 0, y: 0, w: 100, h: 100, depth: 5 },
    { name: 'F2', x: 200, y: 0, w: 100, h: 100, depth: 5 },
  ])
  const [f1] = featureIds

  // Snapshot definitions before transform
  const stateBefore = useProjectStore.getState()
  const defIdsBefore = new Set(Object.keys(stateBefore.project.featureDefinitions))
  const defSnapshots = new Map(
    Object.entries(stateBefore.project.featureDefinitions).map(([id, def]) => [id, JSON.stringify(def)]),
  )

  // Select group and perform a rotate
  useProjectStore.getState().selectProject()
  useProjectStore.getState().selectFeature(f1, false)
  useProjectStore.getState().startRotateFeature(f1)

  useProjectStore.getState().setPendingTransformReferenceStart({ x: 100, y: 0 })
  useProjectStore.getState().setPendingTransformReferenceEnd({ x: 110, y: 0 })
  useProjectStore.getState().completePendingTransform({ x: 100, y: 10 })

  const stateAfter = useProjectStore.getState()
  const defIdsAfter = new Set(Object.keys(stateAfter.project.featureDefinitions))

  // No definitions should have been added or removed
  assert(defIdsBefore.size === defIdsAfter.size,
    `definition count changed: ${defIdsBefore.size} → ${defIdsAfter.size}`)

  // Each definition should be byte-identical
  for (const defId of defIdsBefore) {
    assert(defIdsAfter.has(defId), `definition ${defId} missing after transform`)
    const before = defSnapshots.get(defId)
    const after = JSON.stringify(stateAfter.project.featureDefinitions[defId])
    assert(before === after, `definition ${defId} was mutated by group transform`)
  }
})

test('out-of-group instance sharing a definition is NOT affected by group transform', () => {
  // Create a grouped folder with one feature
  const { featureIds } = setupGroupedFolderWithRects([
    { name: 'F1', x: 0, y: 0, w: 100, h: 100, depth: 5 },
  ])
  const [f1] = featureIds

  const defId = getFeatureDefinitionId(f1)
  assert(defId !== undefined, 'f1 should have a definitionId')

  // Create a second feature OUTSIDE the folder that shares f1's definition
  // We do this by selecting project root (not the folder) and adding a feature
  // with the same definition ID manually via addFeature with definitionId set
  useProjectStore.getState().selectProject()

  // Get the f1 feature and its definition
  const state = useProjectStore.getState()
  const f1Feature = resolveFeatureInstance(state.project, f1)
  assert(f1Feature != null, 'f1 should resolve')

  // Create a new feature outside the folder that shares the same definition
  // We construct it manually and call addFeature with explicit definitionId
  const nextId = 'f-outgroup'
  const outgroupFeature = {
    ...f1Feature,
    id: nextId,
    name: 'F-outgroup',
    folderId: null, // NOT in the folder
    definitionId: defId,
    transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
  }
  useProjectStore.getState().addFeature(outgroupFeature)

  // Verify outgroup feature exists with same definition
  const stateMid = useProjectStore.getState()
  const outgroupF = resolveFeatureInstance(stateMid.project, nextId)
  assert(outgroupF != null, 'outgroup feature should exist')
  assert(getFeatureDefinitionId(nextId) === defId,
    `outgroup feature should share definition ${defId}, got ${getFeatureDefinitionId(nextId)}`)

  // Snapshot outgroup feature state before group transform
  const outgroupTransformBefore = getFeatureTransform(nextId)

  // Now perform a group transform on the grouped folder member
  useProjectStore.getState().selectFeature(f1, false)
  useProjectStore.getState().startRotateFeature(f1)

  useProjectStore.getState().setPendingTransformReferenceStart({ x: 100, y: 0 })
  useProjectStore.getState().setPendingTransformReferenceEnd({ x: 110, y: 0 })
  useProjectStore.getState().completePendingTransform({ x: 100, y: 10 })

  // Group member f1 should have changed
  const f1After = getFeatureTransform(f1)
  assert(!isIdentityMatrix(f1After), 'f1 transform should be non-identity after rotate')

  // Out-of-group feature should be completely unaffected
  const stateAfter = useProjectStore.getState()
  const outgroupAfter = resolveFeatureInstance(stateAfter.project, nextId)
  assert(outgroupAfter != null, 'outgroup feature should still exist')
  const outgroupTransformAfter = getFeatureTransform(nextId)
  assert(
    JSON.stringify(outgroupTransformBefore) === JSON.stringify(outgroupTransformAfter),
    'outgroup feature transform should be unchanged',
  )
  // Also verify the sketch profile is unchanged
  assert(
    JSON.stringify(outgroupAfter.sketch.profile) === JSON.stringify(outgroupF.sketch.profile),
    'outgroup feature sketch profile should be unchanged',
  )
})

// ============================================================================
// 4. Group copy includes all members
// ============================================================================

console.log('\n4. Group copy includes all members')

test('startCopyFeature on grouped member includes all members in entityIds', () => {
  const { featureIds } = setupGroupedFolderWithRects([
    { name: 'F1', x: 0, y: 0, w: 100, h: 100, depth: 5 },
    { name: 'F2', x: 200, y: 0, w: 100, h: 100, depth: 5 },
  ])
  const [f1, f2] = featureIds

  useProjectStore.getState().selectProject()
  useProjectStore.getState().selectFeature(f1, false)

  // Start copy
  useProjectStore.getState().startCopyFeature(f1)
  const pending = useProjectStore.getState().pendingMove
  assert(pending !== null, 'pendingMove should be set for copy')
  assert(pending.mode === 'copy', 'mode should be copy')
  assert(pending.entityIds.includes(f1), 'entityIds should include f1')
  assert(pending.entityIds.includes(f2), 'entityIds should include f2')
  assert(pending.entityIds.length === 2, `expected 2 entityIds, got ${pending.entityIds.length}`)
})

test('completePendingMove with copy on grouped members creates copies for all members', () => {
  const { featureIds } = setupGroupedFolderWithRects([
    { name: 'F1', x: 0, y: 0, w: 100, h: 100, depth: 5 },
    { name: 'F2', x: 200, y: 0, w: 100, h: 100, depth: 5 },
  ])
  const [f1, f2] = featureIds

  const featureCountBefore = useProjectStore.getState().project.features.length
  assert(featureCountBefore === 2, `expected 2 features, got ${featureCountBefore}`)

  useProjectStore.getState().selectProject()
  useProjectStore.getState().selectFeature(f1, false)

  // Start copy and complete it
  useProjectStore.getState().startCopyFeature(f1)
  useProjectStore.getState().setPendingMoveFrom({ x: 0, y: 0 })
  useProjectStore.getState().completePendingMove({ x: 50, y: 30 })

  // Should now have original 2 + 2 copies = 4 features
  const featureCountAfter = useProjectStore.getState().project.features.length
  assert(featureCountAfter === 4,
    `expected 4 features after group copy (2 original + 2 copies), got ${featureCountAfter}`)

  // Original features should still exist
  const state = useProjectStore.getState()
  assert(state.project.features.some((f) => f.id === f1), 'f1 should still exist')
  assert(state.project.features.some((f) => f.id === f2), 'f2 should still exist')

  // The selection should point to the newly created copies
  const sel = state.selection
  assert(sel.selectedFeatureIds.length === 2,
    `expected 2 selected features (the copies), got ${sel.selectedFeatureIds.length}`)
  assert(!sel.selectedFeatureIds.includes(f1), 'original f1 should not be selected')
  assert(!sel.selectedFeatureIds.includes(f2), 'original f2 should not be selected')
  assert(
    sel.selectedFeatureIds.every((id) => id !== f1 && id !== f2),
    'selected IDs should be the new copy IDs',
  )
})

// ============================================================================
// 4b. Group copy creates a new grouped folder (Slice 4 fix)
// ============================================================================

console.log('\n4b. Group copy creates a new grouped folder')

test('group copy creates a new grouped folder containing all copies', () => {
  const { folderId: sourceFolderId, featureIds } = setupGroupedFolderWithRects([
    { name: 'F1', x: 0, y: 0, w: 100, h: 100, depth: 5 },
    { name: 'F2', x: 200, y: 0, w: 100, h: 100, depth: 5 },
  ])
  const [f1, f2] = featureIds

  const foldersBefore = useProjectStore.getState().project.featureFolders.length
  const featuresBefore = useProjectStore.getState().project.features.length
  assert(foldersBefore === 1, `expected 1 folder before copy, got ${foldersBefore}`)
  assert(featuresBefore === 2, `expected 2 features before copy, got ${featuresBefore}`)

  useProjectStore.getState().selectProject()
  useProjectStore.getState().selectFeature(f1, false)

  // Start copy and complete it
  useProjectStore.getState().startCopyFeature(f1)
  useProjectStore.getState().setPendingMoveFrom({ x: 0, y: 0 })
  useProjectStore.getState().completePendingMove({ x: 50, y: 30 })

  const state = useProjectStore.getState()
  const project = state.project

  // One new folder should be created
  assert(
    project.featureFolders.length === 2,
    `expected 2 folders (1 original + 1 new), got ${project.featureFolders.length}`,
  )

  // The new folder should be grouped
  const newFolder = project.featureFolders.find((f) => f.id !== sourceFolderId)
  assert(newFolder !== undefined, 'new folder should exist')
  assert(newFolder.grouped === true, 'new folder should be grouped')
  assert(newFolder.collapsed === false, 'new folder should not be collapsed')
  assert(
    newFolder.name.includes('Copy'),
    `new folder name should include "Copy", got "${newFolder.name}"`,
  )

  // Source folder should still exist and be grouped
  const sourceFolder = project.featureFolders.find((f) => f.id === sourceFolderId)
  assert(sourceFolder !== undefined, 'source folder should still exist')
  assert(sourceFolder.grouped === true, 'source folder should still be grouped')

  // All features should exist (2 original + 2 copies = 4)
  assert(project.features.length === 4,
    `expected 4 features, got ${project.features.length}`)

  // Original features should still belong to the source folder
  const origF1 = project.features.find((f) => f.id === f1)
  const origF2 = project.features.find((f) => f.id === f2)
  assert(origF1 !== undefined, 'original f1 should exist')
  assert(origF2 !== undefined, 'original f2 should exist')
  assert(origF1.folderId === sourceFolderId,
    `original f1 should belong to source folder, got ${origF1.folderId}`)
  assert(origF2.folderId === sourceFolderId,
    `original f2 should belong to source folder, got ${origF2.folderId}`)

  // Copy features should belong to the NEW folder (not the source folder)
  const copyFeatures = project.features.filter((f) => f.id !== f1 && f.id !== f2)
  assert(copyFeatures.length === 2,
    `expected 2 copy features, got ${copyFeatures.length}`)
  for (const cf of copyFeatures) {
    assert(cf.folderId === newFolder.id,
      `copy feature ${cf.id} should belong to new folder ${newFolder.id}, got ${cf.folderId}`)
  }

  // Selection should point to the copies with groupFolderId set to the new folder
  const sel = state.selection
  assert(sel.selectedFeatureIds.length === 2,
    `expected 2 selected features, got ${sel.selectedFeatureIds.length}`)
  assert(
    sel.selectedFeatureIds.every((id) => id !== f1 && id !== f2),
    'selected IDs should be the copy IDs',
  )
  assert(sel.groupFolderId === newFolder.id,
    `groupFolderId should be ${newFolder.id}, got ${sel.groupFolderId}`)
})

test('group copy featureTree has one new folder entry and no root feature entries for copies', () => {
  const { folderId: sourceFolderId, featureIds } = setupGroupedFolderWithRects([
    { name: 'F1', x: 0, y: 0, w: 100, h: 100, depth: 5 },
    { name: 'F2', x: 200, y: 0, w: 100, h: 100, depth: 5 },
  ])
  const [f1] = featureIds

  const treeEntryCountBefore = useProjectStore.getState().project.featureTree.length
  assert(treeEntryCountBefore === 1,
    `expected 1 featureTree entry before copy, got ${treeEntryCountBefore}`)

  useProjectStore.getState().selectProject()
  useProjectStore.getState().selectFeature(f1, false)

  useProjectStore.getState().startCopyFeature(f1)
  useProjectStore.getState().setPendingMoveFrom({ x: 0, y: 0 })
  useProjectStore.getState().completePendingMove({ x: 50, y: 30 })

  const project = useProjectStore.getState().project
  const newFolder = project.featureFolders.find((f) => f.id !== sourceFolderId)
  assert(newFolder !== undefined, 'new folder should exist')

  // featureTree should have the original folder entry + one new folder entry
  assert(
    project.featureTree.length === 2,
    `expected 2 featureTree entries (1 original folder + 1 new folder), got ${project.featureTree.length}`,
  )

  // The new entry should be a folder entry pointing to the new folder
  const folderEntries = project.featureTree.filter((e) => e.type === 'folder')
  assert(folderEntries.length === 2,
    `expected 2 folder entries, got ${folderEntries.length}`)
  assert(
    folderEntries.some((e) => e.folderId === sourceFolderId),
    'source folder entry should still exist',
  )
  assert(
    folderEntries.some((e) => e.folderId === newFolder.id),
    'new folder entry should exist',
  )

  // No root feature entries for the copies (their membership comes from folderId)
  const copyFeatureIds = project.features
    .filter((f) => f.folderId === newFolder.id)
    .map((f) => f.id)
  assert(copyFeatureIds.length === 2,
    `expected 2 features in new folder, got ${copyFeatureIds.length}`)

  const rootFeatureEntries = project.featureTree.filter((e) => e.type === 'feature')
  for (const entry of rootFeatureEntries) {
    if (entry.type === 'feature') {
      assert(
        !copyFeatureIds.includes(entry.featureId),
        `copy feature ${entry.featureId} should NOT have a root featureTree entry`,
      )
    }
  }

  // No feature id appears both in a folder and at root (sync consistency)
  const folderMemberIds = new Set(
    project.features.filter((f) => f.folderId !== null).map((f) => f.id),
  )
  for (const entry of rootFeatureEntries) {
    if (entry.type === 'feature') {
      assert(
        !folderMemberIds.has(entry.featureId),
        `feature ${entry.featureId} is both a folder member and a root entry`,
      )
    }
  }
})

test('group copy selection has groupFolderId set to the new folder', () => {
  const { folderId: sourceFolderId, featureIds } = setupGroupedFolderWithRects([
    { name: 'F1', x: 0, y: 0, w: 100, h: 100, depth: 5 },
  ])
  const [f1] = featureIds

  useProjectStore.getState().selectProject()
  useProjectStore.getState().selectFeature(f1, false)

  useProjectStore.getState().startCopyFeature(f1)
  useProjectStore.getState().setPendingMoveFrom({ x: 0, y: 0 })
  useProjectStore.getState().completePendingMove({ x: 50, y: 30 })

  const state = useProjectStore.getState()
  const sel = state.selection
  const newFolder = state.project.featureFolders.find((f) => f.id !== sourceFolderId)
  assert(newFolder !== undefined, 'new folder should exist')

  assert(sel.groupFolderId === newFolder.id,
    `groupFolderId should be ${newFolder.id}, got ${sel.groupFolderId}`)
  assert(sel.selectedFeatureIds.length === 1,
    'should have 1 selected feature (the copy)')
  assert(sel.selectedFeatureIds[0] !== f1,
    'selected feature should be the copy, not the original')
  assert(sel.selectedNode?.type === 'folder',
    `selectedNode should be folder, got ${sel.selectedNode?.type}`)
})

// ============================================================================
// 4c. Non-group copy regression guard
// ============================================================================

console.log('\n4c. Non-group copy regression guard')

test('non-group copy (feature not in any folder) still creates root featureTree entries', () => {
  resetStore()

  // Add a feature NOT in any folder
  useProjectStore.getState().addRectFeature('Solo', 0, 0, 100, 100, 5)
  const f1 = useProjectStore.getState().selection.selectedFeatureId!
  const featuresBefore = useProjectStore.getState().project.features.length

  // Copy it
  useProjectStore.getState().selectProject()
  useProjectStore.getState().selectFeature(f1, false)
  useProjectStore.getState().startCopyFeature(f1)
  useProjectStore.getState().setPendingMoveFrom({ x: 0, y: 0 })
  useProjectStore.getState().completePendingMove({ x: 50, y: 30 })

  const project = useProjectStore.getState().project
  assert(project.features.length === featuresBefore + 1,
    `expected ${featuresBefore + 1} features after solo copy, got ${project.features.length}`)

  // The original feature should still have no folderId
  const orig = project.features.find((f) => f.id === f1)
  assert(orig !== undefined, 'original feature should still exist')
  assert(orig.folderId === null, 'original feature should have no folderId')

  // The copy should also have no folderId (non-group copy preserves folderId)
  const copy = project.features.find((f) => f.id !== f1)
  assert(copy !== undefined, 'copy feature should exist')
  assert(copy.folderId === null,
    `copy feature should have null folderId (non-group), got ${copy.folderId}`)

  // featureTree should have a root entry for the copy
  const rootFeatureIds = project.featureTree
    .filter((e) => e.type === 'feature')
    .map((e) => e.type === 'feature' ? e.featureId : '')
    .filter(Boolean)
  assert(rootFeatureIds.includes(copy.id),
    'copy feature should have a root featureTree entry')

  // Selection should NOT have groupFolderId set (not a group copy)
  const sel = useProjectStore.getState().selection
  assert(
    sel.groupFolderId === undefined || sel.groupFolderId === null,
    `groupFolderId should be null/undefined for non-group copy, got ${sel.groupFolderId}`,
  )
  assert(sel.selectedFeatureIds.length === 1,
    'should have 1 selected feature')
})

test('copy feature in non-grouped folder joins the same folder (no root entry)', () => {
  resetStore()

  // Create a non-grouped folder
  const folderId = useProjectStore.getState().addFeatureFolder('features')
  // grouped defaults to false — do NOT toggle it

  useProjectStore.getState().addRectFeature('F1', 0, 0, 100, 100, 5)
  const f1 = useProjectStore.getState().selection.selectedFeatureId!

  // f1 should be in the non-grouped folder
  const f1Feature = useProjectStore.getState().project.features.find((f) => f.id === f1)
  assert(f1Feature?.folderId === folderId,
    `f1 should be in the non-grouped folder, got folderId=${f1Feature?.folderId}`)

  // Copy it
  useProjectStore.getState().selectProject()
  useProjectStore.getState().selectFeature(f1, false)
  useProjectStore.getState().startCopyFeature(f1)
  useProjectStore.getState().setPendingMoveFrom({ x: 0, y: 0 })
  useProjectStore.getState().completePendingMove({ x: 50, y: 30 })

  const project = useProjectStore.getState().project
  const folders = project.featureFolders
  assert(folders.length === 1,
    `expected 1 folder (no new folder for non-group copy), got ${folders.length}`)

  // Copy should have the same folderId as original (not a new folder)
  const copyFeature = project.features.find((f) => f.id !== f1)
  assert(copyFeature !== undefined, 'copy feature should exist')
  assert(copyFeature.folderId === folderId,
    `copy should belong to same folder, got folderId=${copyFeature.folderId}`)

  // A foldered copy gets NO root featureTree entry — folder children render
  // from the features array, and a stray root entry would double-list the
  // copy (same sync-consistency invariant asserted for group copies above).
  const rootEntries = project.featureTree.filter((e) => e.type === 'feature')
  const rootCopyEntry = rootEntries.find(
    (e) => e.type === 'feature' && e.featureId === copyFeature.id,
  )
  assert(rootCopyEntry === undefined,
    'foldered copy must not appear as a root featureTree entry')

  // Selection should NOT have groupFolderId
  const sel = useProjectStore.getState().selection
  assert(
    sel.groupFolderId === undefined || sel.groupFolderId === null,
    `groupFolderId should be null/undefined for non-group copy, got ${sel.groupFolderId}`,
  )
})

// ============================================================================
// 5. Edge cases
// ============================================================================

console.log('\n5. Edge cases')

test('startResizeFeature on non-grouped folder selects only the clicked feature', () => {
  resetStore()

  // Create a non-grouped folder
  useProjectStore.getState().addFeatureFolder('features')
  // Keep grouped as false (default)

  useProjectStore.getState().addRectFeature('F1', 0, 0, 100, 100, 5)
  const f1 = useProjectStore.getState().selection.selectedFeatureId!
  useProjectStore.getState().addRectFeature('F2', 200, 0, 100, 100, 5)

  // Deselect, then select f1
  useProjectStore.getState().selectProject()
  useProjectStore.getState().selectFeature(f1, false)

  // Verify non-grouped selection
  const sel = useProjectStore.getState().selection
  assert(sel.selectedFeatureIds.length === 1, 'non-grouped select should have 1 feature')
  assert(sel.groupFolderId === null || sel.groupFolderId === undefined,
    `groupFolderId should be null/undefined for non-grouped, got ${sel.groupFolderId}`)

  // Start resize
  useProjectStore.getState().startResizeFeature(f1)
  const pending = useProjectStore.getState().pendingTransform
  assert(pending !== null, 'pendingTransform should be set')
  assert(pending.entityIds.length === 1,
    `non-grouped pending transform should have 1 entityId, got ${pending.entityIds.length}`)
  assert(pending.entityIds[0] === f1, 'entityIds should contain only f1')
})

test('locked feature in grouped folder does not block transform of other members', () => {
  resetStore()

  const folderId = useProjectStore.getState().addFeatureFolder('features')
  useProjectStore.getState().toggleFolderGrouped(folderId)

  useProjectStore.getState().addRectFeature('F1', 0, 0, 100, 100, 5)
  const f1 = useProjectStore.getState().selection.selectedFeatureId!
  useProjectStore.getState().addRectFeature('F2', 200, 0, 100, 100, 5)
  const f2 = useProjectStore.getState().selection.selectedFeatureId!

  // Lock f2
  useProjectStore.getState().updateFeature(f2, { locked: true })

  // Select group (f1)
  useProjectStore.getState().selectProject()
  useProjectStore.getState().selectFeature(f1, false)
  const sel = useProjectStore.getState().selection
  assert(sel.selectedFeatureIds.includes(f2), 'locked f2 should still be in group selection')

  // Start resize — should be blocked because one member is locked
  useProjectStore.getState().startResizeFeature(f1)
  const pending = useProjectStore.getState().pendingTransform
  // The pendingActionsSlice checks: features.some((feature) => feature.locked) → returns {}
  assert(pending === null,
    'pendingTransform should be null when a group member is locked')
})

// ============================================================================
// Summary
// ============================================================================

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  process.exitCode = 1
}
