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
 * Tests for Feature References Definition Editing (slice 05).
 *
 * Run with: npx tsx src/store/definitionEditing.test.ts
 */

import {
  circleProfile,
  inferFeatureKind,
  newProject,
  rectProfile,
  type FeatureDefinition,
  type Matrix2D,
  type Project,
  type SketchFeature,
} from '../types/project'
import { resolveProfile } from './helpers/resolveFeatures'
import {
  getDefinitionId,
  getInstanceIdsForDefinition,
  makeUnique,
  rebakeAllInstances,
} from './helpers/featureDefinitions'

// Reuse the same assertion utilities used by featureResolver.test.ts
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

// ── Helpers ────────────────────────────────────────────────────────

/** Build a simple project with one rect feature, definition, and instance. */
function makeSimpleProject(
  cx = 10,
  cy = 20,
  w = 30,
  h = 15,
): Project {
  const profile = rectProfile(cx, cy, w, h)
  const feature: SketchFeature = {
    id: 'f-0001',
    name: 'Rect',
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

  const definition: FeatureDefinition = {
    id: feature.id,
    kind: feature.kind,
    profile,
    dimensions: [],
    operation: feature.operation,
  }

  const project = newProject()
  project.features = [feature]
  project.featureDefinitions = { [definition.id]: definition }
  return project
}

/** Add a second instance sharing the same definition, with a transform. */
function addLinkedInstance(
  project: Project,
  instanceId: string,
  name: string,
  definitionId: string,
  transform: Matrix2D,
): void {
  const definition = project.featureDefinitions[definitionId]
  assert(definition != null, 'definition must exist')

  const resolved = resolveProfile(definition, transform)
  const feature: SketchFeature = {
    id: instanceId,
    name,
    kind: inferFeatureKind(resolved),
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
  }
  // Stash definitionId + transform on the feature row (compatibility shape).
  ;(feature as unknown as Record<string, unknown>).definitionId = definitionId
  ;(feature as unknown as Record<string, unknown>).transform = transform

  project.features.push(feature)
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

// ────────────────────────────────────────────────────────────────────
// 1. getDefinitionId
// ────────────────────────────────────────────────────────────────────

test('getDefinitionId uses explicit definitionId', () => {
  const feature = { id: 'f-0001', name: '', kind: 'rect', folderId: null, sketch: { profile: rectProfile(0, 0, 10, 10), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] }, operation: 'add' as const, z_top: 1, z_bottom: 0, visible: true, locked: false }
  ;(feature as Record<string, unknown>).definitionId = 'def-explicit'
  assert(getDefinitionId(feature as SketchFeature) === 'def-explicit', 'should use explicit')
})

test('getDefinitionId falls back to feature.id', () => {
  const feature = { id: 'f-0001', name: '', kind: 'rect', folderId: null, sketch: { profile: rectProfile(0, 0, 10, 10), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] }, operation: 'add' as const, z_top: 1, z_bottom: 0, visible: true, locked: false }
  assert(getDefinitionId(feature as SketchFeature) === 'f-0001', 'should fall back')
})

// ────────────────────────────────────────────────────────────────────
// 2. getInstanceIdsForDefinition
// ────────────────────────────────────────────────────────────────────

test('getInstanceIdsForDefinition returns referencing instance IDs', () => {
  const project = makeSimpleProject()
  addLinkedInstance(project, 'f-0002', 'Linked', 'f-0001', {
    a: 1, b: 0, c: 0, d: 1, e: 50, f: 0,
  })

  const ids = getInstanceIdsForDefinition(project, 'f-0001')
  assert(ids.length === 2, `expected 2 instances, got ${ids.length}`)
  assert(ids.includes('f-0001'), 'should include original')
  assert(ids.includes('f-0002'), 'should include linked')
})

// ────────────────────────────────────────────────────────────────────
// 3. Re-bake propagates definition edits to all instances
// ────────────────────────────────────────────────────────────────────

test('rebakeAllInstances propagates definition profile edit to all instances', () => {
  const project = makeSimpleProject()
  addLinkedInstance(project, 'f-0002', 'Linked', 'f-0001', {
    a: 1, b: 0, c: 0, d: 1, e: 50, f: 0,
  })

  // Edit the definition: make it a different rect
  const def = project.featureDefinitions['f-0001']!
  const newProfile = rectProfile(20, 30, 40, 25)
  project.featureDefinitions['f-0001'] = { ...def, profile: newProfile, kind: inferFeatureKind(newProfile) }

  // Re-bake
  const nextFeatures = rebakeAllInstances(project, 'f-0001')

  // Original instance: identity transform → should match new definition profile
  const orig = nextFeatures.find((f) => f.id === 'f-0001')!
  assert(orig.sketch.profile.start.x === 20, 'orig start.x')
  assert(orig.sketch.profile.start.y === 30, 'orig start.y')

  // Linked instance: translate 50,0 → profile shifted
  const linked = nextFeatures.find((f) => f.id === 'f-0002')!
  assert(linked.sketch.profile.start.x === 70, `linked start.x: expected 70, got ${linked.sketch.profile.start.x}`)
  assert(linked.sketch.profile.start.y === 30, `linked start.y: expected 30, got ${linked.sketch.profile.start.y}`)
})

// ────────────────────────────────────────────────────────────────────
// 4. Editing with editingFeatureId uses identity transform
// ────────────────────────────────────────────────────────────────────

test('rebakeAllInstances with editingFeatureId uses identity for the editor', () => {
  const project = makeSimpleProject()
  addLinkedInstance(project, 'f-0002', 'Linked', 'f-0001', {
    a: 1, b: 0, c: 0, d: 1, e: 50, f: 0,
  })

  // Simulate a definition edit during sketch_edit on the linked (transformed) instance
  const def = project.featureDefinitions['f-0001']!
  const newProfile = rectProfile(20, 30, 40, 25)
  project.featureDefinitions['f-0001'] = { ...def, profile: newProfile, kind: inferFeatureKind(newProfile) }

  // Re-bake with editingFeatureId = the linked instance
  const nextFeatures = rebakeAllInstances(project, 'f-0001', { editingFeatureId: 'f-0002' })

  // Editing feature (f-0002) should get definition-local profile (identity transform)
  const editing = nextFeatures.find((f) => f.id === 'f-0002')!
  assert(editing.sketch.profile.start.x === 20, `editing start.x: expected 20, got ${editing.sketch.profile.start.x}`)
  assert(editing.sketch.profile.start.y === 30, `editing start.y: expected 30, got ${editing.sketch.profile.start.y}`)

  // Non-editing feature (f-0001) should get definition-local (identity transform too — it IS identity)
  const orig = nextFeatures.find((f) => f.id === 'f-0001')!
  assert(orig.sketch.profile.start.x === 20, `orig start.x: expected 20, got ${orig.sketch.profile.start.x}`)
})

// ────────────────────────────────────────────────────────────────────
// 5. Profile edit through transformed instance writes definition-local geometry
// ────────────────────────────────────────────────────────────────────

test('profile edit through transformed instance writes definition-local', () => {
  const project = makeSimpleProject(10, 20, 30, 15)
  // Add a linked instance that is translated
  addLinkedInstance(project, 'f-0002', 'Translated', 'f-0001', {
    a: 1, b: 0, c: 0, d: 1, e: 100, f: 0,
  })

  // Simulate editing the definition-local profile directly, as a store action would
  const def = project.featureDefinitions['f-0001']!
  const newProfile = rectProfile(5, 10, 60, 30) // definition-local edit
  const nextDef = { ...def, profile: newProfile, kind: inferFeatureKind(newProfile) }
  const intermediateProject = {
    ...project,
    featureDefinitions: { ...project.featureDefinitions, 'f-0001': nextDef },
  }

  // When editing the transformed instance, it sees definition-local
  const nextFeatures = rebakeAllInstances(intermediateProject, 'f-0001', { editingFeatureId: 'f-0002' })

  // Editing feature should see definition-local (identity applied)
  const editing = nextFeatures.find((f) => f.id === 'f-0002')!
  assert(editing.sketch.profile.start.x === 5, 'editing should see def-local x')
  assert(editing.sketch.profile.start.y === 10, 'editing should see def-local y')

  // Now verify that resolveProfile(definition, transform) gives the correct world-space result
  const resolved = resolveProfile(nextDef, { a: 1, b: 0, c: 0, d: 1, e: 100, f: 0 })
  assert(resolved.start.x === 105, `resolved world x: expected 105, got ${resolved.start.x}`)
  assert(resolved.start.y === 10, `resolved world y: expected 10, got ${resolved.start.y}`)
})

// ────────────────────────────────────────────────────────────────────
// 6. Circle radius edit propagates and keeps circles
// ────────────────────────────────────────────────────────────────────

function makeCircleProject(cx = 50, cy = 50, r = 25): Project {
  const profile = circleProfile(cx, cy, r)
  const feature: SketchFeature = {
    id: 'f-circle',
    name: 'Circle',
    kind: 'circle',
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

  const definition: FeatureDefinition = {
    id: feature.id,
    kind: feature.kind,
    profile,
    dimensions: [],
    operation: feature.operation,
  }

  const project = newProject()
  project.features = [feature]
  project.featureDefinitions = { [definition.id]: definition }
  return project
}

test('circle radius edit propagates to all instances and keeps them circles', () => {
  const project = makeCircleProject()
  addLinkedInstance(project, 'f-circle-2', 'Linked Circle', 'f-circle', {
    a: 1, b: 0, c: 0, d: 1, e: 100, f: 0,
  })

  // Edit: make the circle radius larger
  const def = project.featureDefinitions['f-circle']!
  const newProfile = circleProfile(50, 50, 40) // radius 25 → 40
  const nextDef = { ...def, profile: newProfile, kind: 'circle' as const }

  const intermediateProject = {
    ...project,
    featureDefinitions: { ...project.featureDefinitions, 'f-circle': nextDef },
  }
  const nextFeatures = rebakeAllInstances(intermediateProject, 'f-circle')

  // Both instances should be circles
  const orig = nextFeatures.find((f) => f.id === 'f-circle')!
  assert(orig.kind === 'circle', `orig kind should be circle, got ${orig.kind}`)
  assert(orig.sketch.profile.segments[0]?.type === 'circle', 'orig seg should be circle type')

  const linked = nextFeatures.find((f) => f.id === 'f-circle-2')!
  assert(linked.kind === 'circle', `linked kind should be circle, got ${linked.kind}`)

  // The linked circle should be at translated position
  const linkedCircle = linked.sketch.profile.segments[0]
  assert(linkedCircle?.type === 'circle', 'linked should have circle segment')
  if (linkedCircle.type === 'circle') {
    assert(linkedCircle.center.x === 150, `linked center.x: expected 150, got ${linkedCircle.center.x}`)
  }
})

// ────────────────────────────────────────────────────────────────────
// 7. Adding a point to a circle converts the shared definition
// ────────────────────────────────────────────────────────────────────

test('adding a point to a circle converts shared definition kind for all instances', () => {
  const project = makeCircleProject()
  addLinkedInstance(project, 'f-circle-2', 'Linked Circle', 'f-circle', {
    a: 1, b: 0, c: 0, d: 1, e: 100, f: 0,
  })

  // Simulate adding a point: replace circle profile with a composite profile
  // (In practice insertPointIntoProfile on a circle converts it)
  const def = project.featureDefinitions['f-circle']!
  // Build a simple open profile (like what would result from breaking a circle)
  const newProfile = {
    start: { x: 50, y: 25 },
    segments: [
      { type: 'line' as const, to: { x: 75, y: 25 } },
      { type: 'line' as const, to: { x: 75, y: 50 } },
      { type: 'line' as const, to: { x: 50, y: 50 } },
      { type: 'line' as const, to: { x: 50, y: 25 } },
    ],
    closed: true,
  }
  const nextDef = { ...def, profile: newProfile, kind: inferFeatureKind(newProfile) }

  const intermediateProject = {
    ...project,
    featureDefinitions: { ...project.featureDefinitions, 'f-circle': nextDef },
  }
  const nextFeatures = rebakeAllInstances(intermediateProject, 'f-circle')

  // Both instances should now NOT be circles
  const orig = nextFeatures.find((f) => f.id === 'f-circle')!
  assert(orig.kind !== 'circle', `orig should not be circle, got ${orig.kind}`)

  const linked = nextFeatures.find((f) => f.id === 'f-circle-2')!
  assert(linked.kind !== 'circle', `linked should not be circle, got ${linked.kind}`)

  // The definition should also be updated
  assert(nextDef.kind !== 'circle', `def should not be circle, got ${nextDef.kind}`)
})

// ────────────────────────────────────────────────────────────────────
// 8. makeUnique breaks propagation
// ────────────────────────────────────────────────────────────────────

test('makeUnique clones definition and repoints instance', () => {
  const project = makeSimpleProject()
  addLinkedInstance(project, 'f-0002', 'Linked', 'f-0001', {
    a: 1, b: 0, c: 0, d: 1, e: 50, f: 0,
  })

  const result = makeUnique(project, 'f-0002')
  assert(result != null, 'makeUnique should succeed')
  const { newDefinitionId, clonedDefinition, features } = result!

  // Should have a new definition ID
  assert(newDefinitionId.startsWith('def-clone-'), `expected def-clone-*, got ${newDefinitionId}`)

  // The unique instance should now point to the clone
  const uniqueInstance = features.find((f) => f.id === 'f-0002')!
  const uniqueDefId = getDefinitionId(uniqueInstance)
  assert(uniqueDefId === newDefinitionId, `instance should point to clone, got ${uniqueDefId}`)

  // Original instance still points to the original definition
  const origInstance = features.find((f) => f.id === 'f-0001')!
  assert(getDefinitionId(origInstance) === 'f-0001', 'original should still point to f-0001')

  // The cloned definition should have the same profile
  const originalDef = project.featureDefinitions['f-0001']!
  assert(
    clonedDefinition.profile.start.x === originalDef.profile.start.x,
    'cloned profile start.x should match',
  )
})

test('makeUnique breaks propagation: edit original does not affect unique', () => {
  const project = makeSimpleProject()
  addLinkedInstance(project, 'f-0002', 'Linked', 'f-0001', {
    a: 1, b: 0, c: 0, d: 1, e: 50, f: 0,
  })

  // Make unique first
  const result = makeUnique(project, 'f-0002')
  assert(result != null, 'makeUnique should succeed')
  const { newDefinitionId } = result!

  // Reconstruct the project with the unique instance
  project.features = result.features
  project.featureDefinitions = {
    ...project.featureDefinitions,
    [newDefinitionId]: result.clonedDefinition,
  }

  // Now edit the ORIGINAL definition
  const origDef = project.featureDefinitions['f-0001']!
  const newProfile = rectProfile(100, 200, 40, 25)
  project.featureDefinitions['f-0001'] = { ...origDef, profile: newProfile, kind: inferFeatureKind(newProfile) }

  // Re-bake only the original definition
  const nextFeatures = rebakeAllInstances(project, 'f-0001')

  // Original instance should reflect the edit
  const orig = nextFeatures.find((f) => f.id === 'f-0001')!
  assert(orig.sketch.profile.start.x === 100, `orig start.x: expected 100, got ${orig.sketch.profile.start.x}`)

  // Unique instance should NOT reflect the edit (still has the cloned profile)
  const unique = nextFeatures.find((f) => f.id === 'f-0002')!
  assert(
    unique.sketch.profile.start.x !== 100,
    `unique should not reflect edit, got start.x=${unique.sketch.profile.start.x}`,
  )
  // It should still have the translated clone (from makeUnique)
  // The cloned profile starts at 10 (original), translated by 50 → 60
  assert(
    unique.sketch.profile.start.x === 60,
    `unique start.x: expected 60, got ${unique.sketch.profile.start.x}`,
  )
})

// ────────────────────────────────────────────────────────────────────
// 9. Identity-migrated single-instance edit equivalence
// ────────────────────────────────────────────────────────────────────

test('identity-migrated single-instance edit produces same resolved geometry', () => {
  const project = makeSimpleProject(10, 20, 30, 15)

  // Simulate what a store action would do: edit the definition
  const def = project.featureDefinitions['f-0001']!
  const newProfile = rectProfile(5, 10, 60, 30)
  const nextDef = { ...def, profile: newProfile, kind: inferFeatureKind(newProfile) }

  const intermediateProject = {
    ...project,
    featureDefinitions: { ...project.featureDefinitions, 'f-0001': nextDef },
  }
  const nextFeatures = rebakeAllInstances(intermediateProject, 'f-0001')

  const edited = nextFeatures.find((f) => f.id === 'f-0001')!
  // With identity transform, the feature profile should equal the definition profile
  assert(edited.sketch.profile.start.x === 5, `start.x: expected 5, got ${edited.sketch.profile.start.x}`)
  assert(edited.sketch.profile.start.y === 10, `start.y: expected 10, got ${edited.sketch.profile.start.y}`)

  // The definition's profile should match
  assert(nextDef.profile.start.x === 5, 'def start.x')
  assert(nextDef.profile.start.y === 10, 'def start.y')
})

// ────────────────────────────────────────────────────────────────────
// 10. Editing preserves text/stl kind
// ────────────────────────────────────────────────────────────────────

test('editing preserves text/stl feature kind', () => {
  const profile = rectProfile(0, 0, 10, 10)
  const feature: SketchFeature = {
    id: 'f-text',
    name: 'Text',
    kind: 'text',
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
    text: { text: 'Hello', style: 'skeleton' as const, fontId: 'simple_stroke' as const, size: 12 },
  }

  const definition: FeatureDefinition = {
    id: feature.id,
    kind: 'text',
    profile,
    dimensions: [],
    operation: 'add',
    text: { text: 'Hello', style: 'skeleton' as const, fontId: 'simple_stroke' as const, size: 12 },
  }

  const project = newProject()
  project.features = [feature]
  project.featureDefinitions = { [definition.id]: definition }

  // Edit the profile (simulating a shape change)
  const newProfile = rectProfile(5, 5, 20, 20)
  project.featureDefinitions['f-text'] = {
    ...definition,
    profile: newProfile,
    kind: 'text', // stay text
  }

  const nextFeatures = rebakeAllInstances(project, 'f-text')
  const edited = nextFeatures.find((f) => f.id === 'f-text')!
  assert(edited.kind === 'text', `text feature kind should stay text, got ${edited.kind}`)
})

// ────────────────────────────────────────────────────────────────────
// 11. Definition kind updates on profile change
// ────────────────────────────────────────────────────────────────────

test('definition kind updates with profile edits', () => {
  const project = makeSimpleProject(10, 20, 30, 15)
  const def = project.featureDefinitions['f-0001']!
  assert(def.kind === 'rect', 'initial kind should be rect')

  // Simulate making it a polygon
  const polyProfile = {
    start: { x: 0, y: 0 },
    segments: [
      { type: 'line' as const, to: { x: 10, y: 0 } },
      { type: 'line' as const, to: { x: 10, y: 5 } },
      { type: 'line' as const, to: { x: 5, y: 10 } },
      { type: 'line' as const, to: { x: 0, y: 5 } },
      { type: 'line' as const, to: { x: 0, y: 0 } },
    ],
    closed: true,
  }
  const nextKind = inferFeatureKind(polyProfile)
  assert(nextKind === 'polygon', `inferred kind should be polygon, got ${nextKind}`)
})

// ── Report ──────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`)
if (failed > 0) throw new Error(`${failed} test(s) failed`)
