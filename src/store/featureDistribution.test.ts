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

import { newProject, rectProfile, type Project } from '../types/project'
import { projectWithFeatures } from '../test/projectFixtures'
import { useProjectStore } from './projectStore'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function makeProject(): Project {
  const base = newProject()
  return projectWithFeatures(base, [
    {
      id: 'source', name: 'Source', kind: 'rect', operation: 'add', visible: true, locked: false,
      z_top: 5, z_bottom: 0, folderId: 'source-folder', text: null, stl: null,
      sketch: { origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [], profile: rectProfile(0, 0, 10, 10) },
    },
    {
      id: 'guide', name: 'Guide', kind: 'rect', operation: 'add', visible: true, locked: false,
      z_top: 5, z_bottom: 0, folderId: null, text: null, stl: null,
      sketch: { origin: { x: 20, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [], profile: rectProfile(20, 0, 30, 10) },
    },
    {
      id: 'companion', name: 'Companion', kind: 'rect', operation: 'add', visible: true, locked: false,
      z_top: 5, z_bottom: 0, folderId: 'source-folder', text: null, stl: null,
      sketch: { origin: { x: 0, y: 20 }, orientationAngle: 0, dimensions: [], constraints: [], profile: rectProfile(0, 20, 10, 30) },
    },
  ])
}

function resetStore(project: Project) {
  useProjectStore.setState({
    project,
    pendingFeatureDistribution: null,
    history: { past: [], future: [], transactionStart: null },
    dirty: false,
  })
  useProjectStore.getState().selectFeatures(['source'])
}

function testReferenceDistributionKeepsSourceAndCreatesOneUndoStep() {
  const project = makeProject()
  resetStore(project)
  const state = useProjectStore.getState()
  state.startFeatureDistribution()
  state.updateFeatureDistribution({ mode: 'grid', rows: 1, columns: 3, spacingX: 20, spacingY: 0, startScale: 100, endScale: 60 })
  const ids = useProjectStore.getState().completeFeatureDistribution()
  const after = useProjectStore.getState()

  assert(ids.length === 2, 'grid should create two additional members')
  assert(after.project.features.length === 5, 'source, companion, guide, and two copies should remain')
  const source = after.project.features.find((feature) => feature.id === 'source')
  assert(source, 'source should remain')
  for (const id of ids) {
    const copy = after.project.features.find((feature) => feature.id === id)
    assert(copy, 'created copy should exist')
    assert(copy.definitionId === source.definitionId, 'reference copies should share the source definition')
    assert(copy.folderId === null, 'distribution members should be individually selectable root entries')
  }
  assert(after.history.past.length === 1, 'distribution should create exactly one undo checkpoint')
  assert(after.selection.selectedFeatureIds.join(',') === ids.join(','), 'created copies should be selected')

  after.undo()
  assert(useProjectStore.getState().project.features.length === 3, 'undo should remove the whole distribution at once')
  useProjectStore.getState().redo()
  assert(useProjectStore.getState().project.features.length === 5, 'redo should restore the whole distribution at once')
  console.log('reference distribution transaction: PASSED')
}

function testIndependentDistributionClonesDefinitionsAndLeavesGuideUntouched() {
  const project = makeProject()
  project.meta = { ...project.meta, copyMode: 'independent' }
  const guideBefore = structuredClone(project.features.find((feature) => feature.id === 'guide'))
  resetStore(project)
  const state = useProjectStore.getState()
  state.startFeatureDistribution()
  state.updateFeatureDistribution({
    mode: 'path', copyCount: 2, startOffset: 0, endOffset: 0,
    orientation: 'follow', startScale: 100, endScale: 80,
  })
  state.setFeatureDistributionPickTarget('guide')
  state.setFeatureDistributionGuide('guide')
  const ids = useProjectStore.getState().completeFeatureDistribution()
  const after = useProjectStore.getState()
  const source = after.project.features.find((feature) => feature.id === 'source')

  assert(ids.length === 1, 'closed guide should create the requested total less the moved source')
  assert(source, 'source should remain')
  assert(source.transform.e === 15 && source.transform.f === -5, 'the existing source should move so its pivot starts on the guide')
  assert(ids.every((id) => after.project.features.find((feature) => feature.id === id)?.definitionId !== source.definitionId), 'independent copies need separate definitions')
  assert(ids.every((id) => after.project.featureDefinitions[after.project.features.find((feature) => feature.id === id)!.definitionId]), 'independent definitions should be committed')
  assert(JSON.stringify(after.project.features.find((feature) => feature.id === 'guide')) === JSON.stringify(guideBefore), 'guide must remain unchanged')
  console.log('independent path distribution: PASSED')
}

function testCancelDoesNotChangeTheProject() {
  const project = makeProject()
  const before = structuredClone(project)
  resetStore(project)
  useProjectStore.getState().startFeatureDistribution()
  useProjectStore.getState().cancelFeatureDistribution()
  const after = useProjectStore.getState()
  assert(after.pendingFeatureDistribution === null, 'cancel should clear transient workflow state')
  assert(JSON.stringify(after.project) === JSON.stringify(before), 'cancel should not mutate the project')
  console.log('distribution cancel: PASSED')
}

function testInchDefaultsAndRadialCenterPickingStayTransientUntilConfirmed() {
  const project = makeProject()
  project.meta = { ...project.meta, units: 'inch' }
  resetStore(project)
  const state = useProjectStore.getState()
  state.startFeatureDistribution()

  const gridPending = useProjectStore.getState().pendingFeatureDistribution
  assert(gridPending?.spec.mode === 'grid', 'workflow should start with the grid mode')
  if (gridPending?.spec.mode === 'grid') {
    assert(gridPending.spec.spacingX === 2 && gridPending.spec.spacingY === 2, 'inch projects should start with 2 in spacing')
  }

  state.startFeatureDistribution('radial')
  assert(!useProjectStore.getState().pendingFeatureDistribution?.radialCenterPicked, 'radial distribution should require a picked center')

  state.setFeatureDistributionPickTarget('radial-center')
  state.setFeatureDistributionRadialCenter({ x: 30, y: 30 })
  const radialPending = useProjectStore.getState().pendingFeatureDistribution
  assert(radialPending?.pickTarget === null, 'a point pick should exit center-picking mode')
  assert(radialPending?.radialCenterPicked, 'a point pick should mark the radial center as chosen')
  assert(radialPending?.spec.mode === 'radial' && radialPending.spec.center.x === 30 && radialPending.spec.center.y === 30, 'the selected sketch point should become the radial center')
  const ids = useProjectStore.getState().completeFeatureDistribution()
  assert(ids.length === 3, 'a four-instance radial distribution should create three copies')

  state.startFeatureDistribution('path')
  const pathPending = useProjectStore.getState().pendingFeatureDistribution
  assert(pathPending?.spec.mode === 'path', 'the along-path command should open a path-specific workflow')
  console.log('inch defaults and radial center pick: PASSED')
}

function testGroupedSourcesCreateOneIndividuallySelectableMemberPerSource() {
  const project = makeProject()
  resetStore(project)
  useProjectStore.getState().selectFeatures(['source', 'companion'])
  const state = useProjectStore.getState()
  state.startFeatureDistribution()
  state.updateFeatureDistribution({ mode: 'grid', rows: 1, columns: 2, spacingX: 20, spacingY: 0, startScale: 100, endScale: 100 })
  const ids = useProjectStore.getState().completeFeatureDistribution()
  const after = useProjectStore.getState()

  assert(ids.length === 2, 'one grid member should copy every selected source in the layout group')
  assert(after.project.features.length === 5, 'the grouped sources should both remain beside their two generated copies')
  assert(ids.every((id) => after.project.features.find((feature) => feature.id === id)?.folderId === null), 'generated group members should remain individually selectable')
  console.log('grouped distribution members: PASSED')
}

testReferenceDistributionKeepsSourceAndCreatesOneUndoStep()
testIndependentDistributionClonesDefinitionsAndLeavesGuideUntouched()
testCancelDoesNotChangeTheProject()
testInchDefaultsAndRadialCenterPickingStayTransientUntilConfirmed()
testGroupedSourcesCreateOneIndividuallySelectableMemberPerSource()
