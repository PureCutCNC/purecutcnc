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
 * Tests for Feature References Snapshot Operations (slice 06).
 *
 * Run with: npx tsx src/store/snapshotOps.test.ts
 */

import {
  IDENTITY_MATRIX,
  newProject,
  rectProfile,
  type FeatureDefinition,
  type Matrix2D,
  type Project,
  type SketchFeature,
} from '../types/project'
import { useProjectStore } from './projectStore'
import type { ProjectStore } from './types'
import { getDefinitionId } from './helpers/featureDefinitions'
import { resolveProfile, resolveFeatureInstance } from './helpers/resolveFeatures'
import { translateMatrix } from './helpers/instanceTransforms'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

// ── Helpers ────────────────────────────────────────────────────────

/** Setup store with a fresh project. */
function resetStore(project?: Project): void {
  useProjectStore.setState({
    project: project ?? newProject(),
    selection: { selectedFeatureIds: [] },
    history: { past: [], future: [], transactionStart: null },
  } as unknown as Partial<ProjectStore>)
}

/** Add a rect feature with a definition to the project via direct state mutation. */
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
  const resolvedProfile = transform === IDENTITY_MATRIX ? profile : resolveProfile({ id: `def-${id}`, kind: 'rect', profile, dimensions: [], text: null, stl: null, operation: 'add' }, transform)

  const definition: FeatureDefinition = {
    id: `def-${id}`,
    kind: 'rect',
    profile,
    dimensions: [],
    text: null,
    stl: null,
    operation: 'add',
  }

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

/** Set the selected feature IDs in the store. */
function selectFeatures(ids: string[]): void {
  useProjectStore.setState({
    selection: {
      ...useProjectStore.getState().selection,
      selectedFeatureIds: ids,
      selectedFeatureId: ids.length > 0 ? ids[ids.length - 1] : null,
      selectedNode: ids.length > 0 ? { type: 'feature', featureId: ids[ids.length - 1] } : null,
      mode: 'feature',
      activeControl: null,
    },
  } as unknown as Partial<ProjectStore>)
}

/** Get the current project from the store. */
function getProject(): Project {
  return useProjectStore.getState().project
}

/** Get feature rows from the store. */
function getFeatures(): SketchFeature[] {
  return getProject().features
}

/** Get feature definitions from the store. */
function getDefinitions(): Record<string, FeatureDefinition> {
  return getProject().featureDefinitions
}

/** Undo the last action. */
function undo(): void {
  const state = useProjectStore.getState()
  if (state.history.past.length > 0) {
    const prev = state.history.past[state.history.past.length - 1]
    useProjectStore.setState({
      project: prev,
      history: {
        past: state.history.past.slice(0, -1),
        future: [state.project, ...state.history.future],
        transactionStart: null,
      },
    } as unknown as Partial<ProjectStore>)
  }
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

console.log('\nSnapshot Operations — Definition/Instance creation')

test('join result is a definition + instance with identity transform', () => {
  resetStore()
  addRectFeature('f-0001', 'Rect A', 10, 10, 20, 20)
  addRectFeature('f-0002', 'Rect B', 15, 15, 20, 20)
  selectFeatures(['f-0001', 'f-0002'])

  const resultIds = useProjectStore.getState().mergeSelectedFeatures(false)
  assert(resultIds.length > 0, 'join should produce at least one result')

  const project = getProject()
  const resultFeature = project.features.find((f) => f.id === resultIds[0])
  assert(resultFeature != null, 'result feature should exist')

  const withRefs = resultFeature as SketchFeature & { definitionId?: string; transform?: Matrix2D }
  assert(withRefs.definitionId != null, 'result feature must have explicit definitionId')
  assert(withRefs.definitionId !== resultFeature.id, 'definitionId should be a snapshot def, not the feature ID')

  const def = project.featureDefinitions[withRefs.definitionId!]
  assert(def != null, 'result feature definition must exist in featureDefinitions')

  const transform = withRefs.transform
  assert(transform != null, 'result feature must have transform')
  assert(
    transform.a === 1 && transform.b === 0 && transform.c === 0 && transform.d === 1 && transform.e === 0 && transform.f === 0,
    'result transform should be identity',
  )
})

test('cut result is a definition + instance with identity transform', () => {
  resetStore()
  addRectFeature('f-0001', 'Target', 10, 10, 30, 30)
  addRectFeature('f-0002', 'Cutter', 20, 15, 10, 20)
  selectFeatures(['f-0001', 'f-0002'])

  const resultIds = useProjectStore.getState().cutSelectedFeatures(false)
  assert(resultIds.length > 0, 'cut should produce at least one result')

  const project = getProject()
  const resultFeature = project.features.find((f) => f.id === resultIds[0])
  assert(resultFeature != null, 'result feature should exist')

  const withRefs = resultFeature as SketchFeature & { definitionId?: string; transform?: Matrix2D }
  assert(withRefs.definitionId != null, 'result must have explicit definitionId')
  assert(withRefs.definitionId !== resultFeature.id, 'definitionId should be a snapshot def')

  const def = project.featureDefinitions[withRefs.definitionId!]
  assert(def != null, 'result feature definition must exist in featureDefinitions')

  const transform = withRefs.transform
  assert(transform != null, 'result must have transform')
  assert(
    transform.a === 1 && transform.b === 0 && transform.c === 0 && transform.d === 1 && transform.e === 0 && transform.f === 0,
    'result transform should be identity',
  )
})

test('offset result is a definition + instance with identity transform', () => {
  resetStore()
  addRectFeature('f-0001', 'Rect', 20, 20, 30, 30)
  selectFeatures(['f-0001'])

  const resultIds = useProjectStore.getState().offsetSelectedFeatures(10)
  assert(resultIds.length > 0, 'offset should produce at least one result')

  const project = getProject()
  const resultFeature = project.features.find((f) => f.id === resultIds[0])
  assert(resultFeature != null, 'result feature should exist')

  const withRefs = resultFeature as SketchFeature & { definitionId?: string; transform?: Matrix2D }
  assert(withRefs.definitionId != null, 'result must have explicit definitionId')

  const def = project.featureDefinitions[withRefs.definitionId!]
  assert(def != null, 'result definition must exist in featureDefinitions')

  const transform = withRefs.transform
  assert(transform != null, 'result must have transform')
  assert(
    transform.a === 1 && transform.b === 0 && transform.c === 0 && transform.d === 1 && transform.e === 0 && transform.f === 0,
    'result transform should be identity',
  )
})

console.log('\nSnapshot Operations — keepOriginals behavior')

test('keepOriginals=true preserves consumed inputs (join)', () => {
  resetStore()
  addRectFeature('f-0001', 'Rect A', 10, 10, 20, 20)
  addRectFeature('f-0002', 'Rect B', 15, 15, 20, 20)
  selectFeatures(['f-0001', 'f-0002'])

  const before = new Set(getFeatures().map((f) => f.id))
  useProjectStore.getState().mergeSelectedFeatures(true)
  const after = new Set(getFeatures().map((f) => f.id))

  assert(before.has('f-0001') && before.has('f-0002'), 'inputs must exist before join')
  assert(after.has('f-0001') && after.has('f-0002'), 'keepOriginals=true must keep inputs')
  assert(after.size > before.size, 'new result features must be added')
})

test('keepOriginals=false removes consumed inputs (join)', () => {
  resetStore()
  addRectFeature('f-0001', 'Rect A', 10, 10, 20, 20)
  addRectFeature('f-0002', 'Rect B', 15, 15, 20, 20)
  selectFeatures(['f-0001', 'f-0002'])

  useProjectStore.getState().mergeSelectedFeatures(false)
  const after = new Set(getFeatures().map((f) => f.id))

  assert(!after.has('f-0001') && !after.has('f-0002'), 'keepOriginals=false must remove consumed inputs')
})

test('keepOriginals=false removes consumed inputs (cut)', () => {
  resetStore()
  addRectFeature('f-0001', 'Target', 10, 10, 30, 30)
  addRectFeature('f-0002', 'Cutter', 20, 15, 10, 20)
  selectFeatures(['f-0001', 'f-0002'])

  useProjectStore.getState().cutSelectedFeatures(false)
  const after = new Set(getFeatures().map((f) => f.id))

  assert(!after.has('f-0001'), 'keepOriginals=false must remove cut target')
})

test('keepOriginals=true keeps consumed inputs (cut)', () => {
  resetStore()
  addRectFeature('f-0001', 'Target', 10, 10, 30, 30)
  addRectFeature('f-0002', 'Cutter', 20, 15, 10, 20)
  selectFeatures(['f-0001', 'f-0002'])

  useProjectStore.getState().cutSelectedFeatures(true)
  const after = new Set(getFeatures().map((f) => f.id))

  assert(after.has('f-0001') && after.has('f-0002'), 'keepOriginals=true must keep both cutter and target')
})

console.log('\nSnapshot Operations — Definition GC')

test('GC removes orphaned definition when last instance is consumed', () => {
  resetStore()
  const { definition } = addRectFeature('f-0001', 'Only Instance', 10, 10, 20, 20)
  addRectFeature('f-0002', 'Second', 25, 10, 20, 20)
  selectFeatures(['f-0001', 'f-0002'])

  // f-0001 should be consumed and its definition GC'd since it was the only instance
  useProjectStore.getState().mergeSelectedFeatures(false)

  const defs = getDefinitions()
  assert(defs[definition.id] === undefined, 'orphaned definition must be GC\'d when last instance consumed')
})

test('GC preserves definition when sibling instance still exists', () => {
  resetStore()
  const { definition } = addRectFeature('f-0001', 'Shared Def A', 10, 10, 20, 20)

  // Add a second instance pointing at the same definition
  const state = useProjectStore.getState()
  const resolvedProfile = resolveProfile(definition, IDENTITY_MATRIX)
  const sibling: SketchFeature = {
    id: 'f-0001b',
    name: 'Shared Def B',
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: resolvedProfile,
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
    definitionId: definition.id,
    transform: IDENTITY_MATRIX,
  } as SketchFeature & { definitionId?: string; transform?: Matrix2D }

  useProjectStore.setState({
    project: {
      ...state.project,
      features: [...state.project.features, sibling as SketchFeature],
    },
  } as unknown as Partial<ProjectStore>)

  addRectFeature('f-0002', 'Third', 25, 10, 20, 20)
  selectFeatures(['f-0001', 'f-0002'])

  // Consume f-0001 but sibling f-0001b still references the same definition
  useProjectStore.getState().mergeSelectedFeatures(false)

  const defs = getDefinitions()
  assert(defs[definition.id] !== undefined, 'definition must survive when sibling instance still references it')
})

console.log('\nSnapshot Operations — Sibling isolation')

test('snapshotting one instance does not alter sibling of shared definition', () => {
  resetStore()
  const { definition: sharedDef } = addRectFeature('f-0001', 'Shared A', 10, 10, 20, 20)

  // Create a sibling instance with a translate transform
  const tMat = translateMatrix(50, 0)
  const resolvedProfile = resolveProfile(sharedDef, tMat)
  const sibling = {
    id: 'f-0001b',
    name: 'Shared B',
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
    definitionId: sharedDef.id,
    transform: tMat,
  } as SketchFeature & { definitionId?: string; transform?: Matrix2D }

  const state = useProjectStore.getState()
  useProjectStore.setState({
    project: {
      ...state.project,
      features: [...state.project.features, sibling as SketchFeature],
    },
  } as unknown as Partial<ProjectStore>)

  // Snapshot the sibling definition's features and profile for later comparison
  const siblingResolvedBefore = resolveFeatureInstance(getProject(), 'f-0001b')
  assert(siblingResolvedBefore != null, 'sibling must resolve before snapshot')

  addRectFeature('f-0002', 'Other', 25, 10, 20, 20)
  selectFeatures(['f-0001', 'f-0002'])

  // Perform a join that consumes f-0001 (the first instance of sharedDef)
  useProjectStore.getState().mergeSelectedFeatures(false)

  // Sibling should still exist and have the same definition
  const defs = getDefinitions()
  assert(defs[sharedDef.id] !== undefined, 'shared definition must survive')

  const siblingFeature = getFeatures().find((f) => f.id === 'f-0001b')
  assert(siblingFeature != null, 'sibling instance must still exist')

  const siblingDefId = getDefinitionId(siblingFeature!)
  assert(siblingDefId === sharedDef.id, 'sibling must still reference the shared definition')

  // Sibling's resolved geometry must be unchanged
  const siblingResolvedAfter = resolveFeatureInstance(getProject(), 'f-0001b')
  assert(siblingResolvedAfter != null, 'sibling must still resolve after snapshot')

  // Compare resolved profiles (should be byte-identical)
  const profileBefore = siblingResolvedBefore!.sketch.profile
  const profileAfter = siblingResolvedAfter!.sketch.profile

  // Compare start points
  assert(
    Math.abs(profileBefore.start.x - profileAfter.start.x) < 1e-6 && Math.abs(profileBefore.start.y - profileAfter.start.y) < 1e-6,
    'sibling resolved profile start must be unchanged',
  )
  assert(profileBefore.segments.length === profileAfter.segments.length, 'sibling resolved segments count must be unchanged')
})

console.log('\nSnapshot Operations — Transformed inputs')

test('snapshot of a transformed input uses resolved world geometry', () => {
  resetStore()
  // Create a feature with a translate transform
  const tMat = translateMatrix(100, 0)
  addRectFeature('f-0001', 'Translated Rect', 10, 10, 20, 20, { transform: tMat })
  addRectFeature('f-0002', 'Other Rect', 105, 10, 20, 20)
  selectFeatures(['f-0001', 'f-0002'])

  useProjectStore.getState().mergeSelectedFeatures(false)

  const project = getProject()
  const resultFeatures = project.features.filter((f) => f.id.startsWith('f') && !['f-0001', 'f-0002'].includes(f.id))
  assert(resultFeatures.length > 0, 'join should produce result features')

  const resultFeature = resultFeatures[0]
  const withRefs = resultFeature as SketchFeature & { definitionId?: string; transform?: Matrix2D }
  const def = project.featureDefinitions[withRefs.definitionId!]
  assert(def != null, 'result must have a definition')

  // The result definition profile should be world-space geometry (translated by 100px)
  // The input feature f-0001 was at (110, 10) in world space (original 10 + translate 100)
  // f-0002 was at (105, 10)
  // The union should be around x≈105-130
  const profile = def.profile
  const startX = profile.start.x
  assert(startX > 80, `result profile should reflect world-space geometry (got start.x=${startX}, expected >80 for translated input)`)
})

console.log('\nSnapshot Operations — Undo/redo')

test('undo restores consumed instances and removes snapshot definitions', () => {
  resetStore()
  addRectFeature('f-0001', 'Rect A', 10, 10, 20, 20)
  addRectFeature('f-0002', 'Rect B', 15, 15, 20, 20)
  selectFeatures(['f-0001', 'f-0002'])

  const projectBefore = JSON.parse(JSON.stringify(getProject()))
  const resultIds = useProjectStore.getState().mergeSelectedFeatures(false)
  assert(resultIds.length > 0, 'join should produce results')

  const projectAfterJoin = getProject()
  assert(!projectAfterJoin.features.find((f) => f.id === 'f-0001'), 'f-0001 should be consumed')

  // Undo
  undo()

  const projectAfterUndo = getProject()
  assert(projectAfterUndo.features.find((f) => f.id === 'f-0001') != null, 'f-0001 must be restored after undo')
  assert(projectAfterUndo.features.find((f) => f.id === 'f-0002') != null, 'f-0002 must be restored after undo')

  // Snapshot definitions should be gone
  for (const defId of Object.keys(projectAfterUndo.featureDefinitions)) {
    const wasInBeforeJoin = projectBefore.featureDefinitions[defId] !== undefined
    assert(wasInBeforeJoin, `definition ${defId} should not exist after undo (was not in pre-join state)`)
  }
})

test('undo restores orphaned definition', () => {
  resetStore()
  const { definition } = addRectFeature('f-0001', 'Only', 10, 10, 20, 20)
  addRectFeature('f-0002', 'Other', 25, 10, 20, 20)
  selectFeatures(['f-0001', 'f-0002'])

  assert(getDefinitions()[definition.id] !== undefined, 'definition must exist before join')
  useProjectStore.getState().mergeSelectedFeatures(false)
  assert(getDefinitions()[definition.id] === undefined, 'orphaned definition must be GC\'d after join')

  undo()
  assert(getDefinitions()[definition.id] !== undefined, 'orphaned definition must be restored after undo')
})

// ── Results ─────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed${failed > 0 ? ' ❌' : ' ✓'}\n`)

if (failed > 0) throw new Error(`${failed} test(s) failed`)
