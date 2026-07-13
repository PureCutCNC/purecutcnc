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
 * Store tests for gear creation.
 *
 * Run with: npx tsx src/store/gearCreation.test.ts
 */

import { IDENTITY_MATRIX, newProject, type Matrix2D, type Project, type SketchFeature } from '../types/project'
import { useProjectStore } from './projectStore'
import { resolveFeatureInstance } from './helpers/resolveFeatures'
import type { ProjectStore } from './types'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
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
      groupFolderId: null,
    },
    history: { past: [], future: [], transactionStart: null },
    sketchEditSession: null,
    pendingConstraint: null,
    pendingTransform: null,
    pendingOffset: null,
    pendingAdd: null,
    pendingMove: null,
    pendingShapeAction: null,
  } as unknown as Partial<ProjectStore>)
}

function createdFeature(id: string): SketchFeature {
  const feature = resolveFeatureInstance(useProjectStore.getState().project, id)
  assert(feature != null, `feature ${id} should exist`)
  return feature
}

function assertIdentityTransform(feature: SketchFeature): void {
  const withTransform = feature as SketchFeature & { definitionId?: string; transform?: Matrix2D }
  assert(withTransform.definitionId !== undefined, `${feature.name} should have a definition id`)
  assert(withTransform.transform !== undefined, `${feature.name} should have a transform`)
  assert(withTransform.transform.a === IDENTITY_MATRIX.a, 'transform.a should be identity')
  assert(withTransform.transform.d === IDENTITY_MATRIX.d, 'transform.d should be identity')
  const definition = useProjectStore.getState().project.featureDefinitions[withTransform.definitionId]
  assert(definition !== undefined, `definition ${withTransform.definitionId} should exist`)
}

function placeGear(radius = 20): void {
  const store = useProjectStore.getState()
  store.startAddGearPlacement()
  useProjectStore.getState().setPendingAddAnchor({ x: 10, y: 12 })
  useProjectStore.getState().setPendingGearRadiusAt({ x: 10 + radius, y: 12 })
}

function testGearWithoutBoreCreatesSingleFeature() {
  resetStore()
  placeGear()

  const beforeHistory = useProjectStore.getState().history.past.length
  const ids = useProjectStore.getState().completePendingGear()
  const state = useProjectStore.getState()

  assert(ids.length === 1, `expected one created id, got ${ids.length}`)
  assert(state.pendingAdd === null, 'pending gear should clear after creation')
  assert(state.project.features.length === 1, `expected one feature, got ${state.project.features.length}`)
  assert(state.project.featureFolders.length === 0, 'gear without bore should not create a folder')
  assert(state.history.past.length === beforeHistory + 1, 'gear creation should add one history entry')

  const gear = createdFeature(ids[0])
  assert(gear.kind === 'composite', `gear kind should be composite, got ${gear.kind}`)
  assert(gear.name.startsWith('Gear '), `gear name should start with Gear, got ${gear.name}`)
  assert(gear.operation === 'add', `first machining gear should become add, got ${gear.operation}`)
  assert(gear.sketch.profile.closed === true, 'gear profile should be closed')
  assertIdentityTransform(gear)
  console.log('gear without bore: PASSED')
}

function testGearWithBoreCreatesGroupedFeatures() {
  resetStore()
  placeGear()
  useProjectStore.getState().setPendingGearParams({ boreDiameter: 6 })

  const beforeHistory = useProjectStore.getState().history.past.length
  const ids = useProjectStore.getState().completePendingGear()
  const state = useProjectStore.getState()

  assert(ids.length === 2, `expected two created ids, got ${ids.length}`)
  assert(state.pendingAdd === null, 'pending gear should clear after grouped creation')
  assert(state.history.past.length === beforeHistory + 1, 'gear+bore should add one history entry')

  const gear = createdFeature(ids[0])
  const bore = createdFeature(ids[1])
  assert(gear.folderId !== null, 'gear should be assigned to a group folder')
  assert(gear.folderId === bore.folderId, 'gear and bore should share a folder')
  assert(bore.kind === 'circle', `bore kind should be circle, got ${bore.kind}`)
  assert(bore.operation === 'subtract', `bore operation should be subtract, got ${bore.operation}`)
  assert(bore.z_top === gear.z_top && bore.z_bottom === gear.z_bottom, 'bore should share gear Z range')

  const folder = state.project.featureFolders.find((candidate) => candidate.id === gear.folderId)
  assert(folder !== undefined, 'group folder should exist')
  assert(folder.grouped === true, 'gear folder should be grouped')
  assert(folder.name === 'Gear 1', `folder name should use gear-scoped numbering, got ${folder.name}`)
  assert(gear.name === 'Gear 1', `gear name should match folder number, got ${gear.name}`)
  assert(bore.name === 'Gear Bore 1', `bore name should match folder number, got ${bore.name}`)
  assert(state.selection.selectedNode?.type === 'folder' && state.selection.selectedNode.folderId === folder.id, 'selection should target the gear folder')
  assert(state.selection.groupFolderId === folder.id, 'selection should carry groupFolderId')
  assert(state.selection.selectedFeatureIds.includes(gear.id), 'gear should be selected')
  assert(state.selection.selectedFeatureIds.includes(bore.id), 'bore should be selected')
  assertIdentityTransform(gear)
  assertIdentityTransform(bore)
  console.log('gear with bore group: PASSED')
}

function testRepeatedGearBoreGroupsUseSharedGearNumbers() {
  resetStore()
  placeGear()
  useProjectStore.getState().setPendingGearParams({ boreDiameter: 6 })
  useProjectStore.getState().completePendingGear()

  placeGear()
  useProjectStore.getState().setPendingGearParams({ boreDiameter: 6 })
  const ids = useProjectStore.getState().completePendingGear()
  const state = useProjectStore.getState()
  const gear = createdFeature(ids[0])
  const bore = createdFeature(ids[1])
  const folder = state.project.featureFolders.find((candidate) => candidate.id === gear.folderId)

  assert(folder !== undefined, 'second gear folder should exist')
  assert(folder.name === 'Gear 2', `second folder should be Gear 2, got ${folder.name}`)
  assert(gear.name === 'Gear 2', `second gear should be Gear 2, got ${gear.name}`)
  assert(bore.name === 'Gear Bore 2', `second bore should be Gear Bore 2, got ${bore.name}`)
  console.log('repeated gear with bore naming: PASSED')
}

function testInvalidBoreDoesNotCreateFeature() {
  resetStore()
  placeGear(8)
  useProjectStore.getState().setPendingGearParams({ boreDiameter: 20 })

  const ids = useProjectStore.getState().completePendingGear()
  const state = useProjectStore.getState()

  assert(ids.length === 0, `expected no created ids, got ${ids.length}`)
  assert(state.pendingAdd?.shape === 'gear', 'pending gear should remain when validation fails')
  assert(state.project.features.length === 0, 'invalid gear should not create features')
  assert(state.history.past.length === 0, 'invalid gear should not add history')
  console.log('invalid bore validation: PASSED')
}

testGearWithoutBoreCreatesSingleFeature()
testGearWithBoreCreatesGroupedFeatures()
testRepeatedGearBoreGroupsUseSharedGearNumbers()
testInvalidBoreDoesNotCreateFeature()
