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
 * Store-level tests for joining closed features that share a line segment
 * (issue #271): the join workflow must group edge-adjacent features, admit
 * them to an active join session, and merge them into a single feature.
 *
 * Run with: npx tsx src/store/joinSharedEdge.test.ts
 */

import {
  getProfileBounds,
  newProject,
  rectProfile,
  type FeatureDefinition,
  type Project,
  type SketchFeature,
} from '../types/project'
import { useProjectStore } from './projectStore'
import type { ProjectStore } from './types'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

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

// ── Helpers ────────────────────────────────────────────────────────

/** Setup store with a fresh project. */
function resetStore(): void {
  useProjectStore.setState({
    project: newProject(),
    selection: { selectedFeatureIds: [] },
    pendingShapeAction: null,
    history: { past: [], future: [], transactionStart: null },
  } as unknown as Partial<ProjectStore>)
}

/** Add a rect feature with a definition to the project via direct state mutation. */
function addRectFeature(id: string, name: string, x: number, y: number, w: number, h: number): SketchFeature {
  const profile = rectProfile(x, y, w, h)
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
      profile,
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
  } as SketchFeature

  const state = useProjectStore.getState()
  useProjectStore.setState({
    project: {
      ...state.project,
      features: [...state.project.features, feature],
      featureDefinitions: {
        ...state.project.featureDefinitions,
        [`def-${id}`]: definition,
      },
    },
  } as unknown as Partial<ProjectStore>)

  return feature
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

function getProject(): Project {
  return useProjectStore.getState().project
}

function joinEntityIds(): string[] {
  const pending = useProjectStore.getState().pendingShapeAction
  return pending?.kind === 'join' ? pending.entityIds : []
}

// ────────────────────────────────────────────────────────────────────

console.log('\nJoin — closed features sharing a line segment (issue #271)')

test('startJoinSelectedFeatures groups edge-adjacent rects', () => {
  resetStore()
  addRectFeature('a', 'Left', 0, 0, 10, 10)
  addRectFeature('b', 'Right', 10, 0, 10, 10)
  selectFeatures(['a', 'b'])

  useProjectStore.getState().startJoinSelectedFeatures()

  const ids = [...joinEntityIds()].sort()
  assert(ids.join(',') === 'a,b', `both edge-adjacent rects must enter the join group, got ${ids.join(',')}`)
})

test('completePendingShapeAction merges edge-adjacent rects into one feature', () => {
  resetStore()
  addRectFeature('a', 'Left', 0, 0, 10, 10)
  addRectFeature('b', 'Right', 10, 0, 10, 10)
  selectFeatures(['a', 'b'])

  useProjectStore.getState().startJoinSelectedFeatures()
  const createdIds = useProjectStore.getState().completePendingShapeAction()

  assert(createdIds.length === 1, `join must create exactly one feature, got ${createdIds.length}`)
  const project = getProject()
  assert(!project.features.find((feature) => feature.id === 'a'), 'original a must be consumed')
  assert(!project.features.find((feature) => feature.id === 'b'), 'original b must be consumed')

  const merged = project.features.find((feature) => feature.id === createdIds[0])
  assert(merged, 'merged feature must exist in the project')
  assert(merged.sketch.profile.closed, 'merged profile must be closed')
  const bounds = getProfileBounds(merged.sketch.profile)
  assert(
    bounds.minX === 0 && bounds.minY === 0 && bounds.maxX === 20 && bounds.maxY === 10,
    `merged outline must span the combined rect, got ${JSON.stringify(bounds)}`,
  )
})

test('startJoinSelectedFeatures still excludes corner-touching rects', () => {
  resetStore()
  addRectFeature('a', 'Left', 0, 0, 10, 10)
  addRectFeature('c', 'Corner', 10, 10, 10, 10)
  selectFeatures(['a', 'c'])

  useProjectStore.getState().startJoinSelectedFeatures()

  assert(joinEntityIds().length === 1, 'corner-touching rects must not group for join')
})

test('active join session admits an edge-adjacent feature via selectFeature', () => {
  resetStore()
  addRectFeature('a', 'Left', 0, 0, 10, 10)
  addRectFeature('b', 'Right', 10, 0, 10, 10)
  addRectFeature('c', 'Corner', 20, 10, 10, 10)
  selectFeatures(['a'])

  useProjectStore.getState().startJoinSelectedFeatures()
  assert(joinEntityIds().join(',') === 'a', 'join session must start with the selected rect')

  useProjectStore.getState().selectFeature('b', true)
  const afterAdjacent = [...joinEntityIds()].sort()
  assert(afterAdjacent.join(',') === 'a,b', `edge-adjacent rect must be admitted, got ${afterAdjacent.join(',')}`)

  useProjectStore.getState().selectFeature('c', true)
  const afterCorner = [...joinEntityIds()].sort()
  assert(afterCorner.join(',') === 'a,b', `corner-touching rect must be rejected, got ${afterCorner.join(',')}`)
})

test('keepOriginals join preserves the source features', () => {
  resetStore()
  addRectFeature('a', 'Left', 0, 0, 10, 10)
  addRectFeature('b', 'Right', 10, 0, 10, 10)
  selectFeatures(['a', 'b'])

  const createdIds = useProjectStore.getState().mergeSelectedFeatures(true)

  assert(createdIds.length === 1, `join must create exactly one feature, got ${createdIds.length}`)
  const project = getProject()
  assert(project.features.find((feature) => feature.id === 'a'), 'original a must remain with keepOriginals')
  assert(project.features.find((feature) => feature.id === 'b'), 'original b must remain with keepOriginals')
})

// ── Results ─────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed${failed > 0 ? ' ❌' : ' ✓'}\n`)

if (failed > 0) throw new Error(`${failed} test(s) failed`)
