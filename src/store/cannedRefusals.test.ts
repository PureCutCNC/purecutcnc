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
 * Canned-shape refusal tests (issue #1112, slice A).
 *
 * Run with: npx tsx src/store/cannedRefusals.test.ts
 *
 * Move/rotate/mirror/copy keep a shape canned (those are transforms and
 * definition copies, covered by the format/definition tests). Edit sketch,
 * constraints, Cut, Join, Trim and Offset have no meaningful result on a
 * generated shape, so every entry point must refuse until Expand to features.
 */

import {
  IDENTITY_MATRIX,
  rectProfile,
  type FeatureDefinition,
  type FeatureInstance,
  type Project,
} from '../types/project'
import { useProjectStore } from './projectStore'
import type { ProjectStore } from './types'
import { instantiateProjectTemplate } from './helpers/normalize'
import { selectionQualifiesForImmediateJoin } from './helpers/shapeActionEligibility'
import { registerTestCannedShapes, testPlateCanned } from '../test/cannedShapeFixture'

registerTestCannedShapes()

let passCount = 0
let failCount = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`✓ ${name}`)
    passCount += 1
  } catch (error) {
    console.error(`✗ ${name}`)
    console.error(`  ${(error as Error).message}`)
    failCount += 1
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}\n  Expected: ${JSON.stringify(expected)}\n  Actual: ${JSON.stringify(actual)}`)
  }
}

function row(id: string, name: string, definition: FeatureDefinition, x: number): FeatureInstance {
  return {
    id,
    name,
    definitionId: definition.id,
    transform: { ...IDENTITY_MATRIX, e: x },
    constraints: [],
    folderId: null,
    z_top: 5,
    z_bottom: 0,
    authoringFace: 'top',
    visible: true,
    locked: false,
  }
}

function seed(): Project {
  const cannedDefinition: FeatureDefinition = {
    id: 'def-canned',
    kind: 'composite',
    profile: rectProfile(0, 0, 100, 60),
    dimensions: [],
    text: null,
    canned: testPlateCanned(100, 60, 12),
    stl: null,
    operation: 'add',
  }
  const plainDefinition: FeatureDefinition = {
    id: 'def-plain',
    kind: 'rect',
    profile: rectProfile(0, 0, 20, 10),
    dimensions: [],
    text: null,
    stl: null,
    operation: 'add',
  }
  const project: Project = {
    ...instantiateProjectTemplate(),
    featureDefinitions: {
      [cannedDefinition.id]: cannedDefinition,
      [plainDefinition.id]: plainDefinition,
    },
    features: [
      row('canned', 'Plate', cannedDefinition, 0),
      row('plain', 'Plain', plainDefinition, 200),
    ],
  }
  useProjectStore.setState({
    project,
    selection: {
      ...useProjectStore.getState().selection,
      selectedFeatureIds: ['canned'],
      selectedFeatureId: 'canned',
      selectedNode: { type: 'feature', featureId: 'canned' },
      mode: 'feature',
    },
    history: { past: [], future: [], transactionStart: null },
  } as unknown as Partial<ProjectStore>)
  return project
}

function select(ids: string[]): void {
  useProjectStore.setState({
    selection: {
      ...useProjectStore.getState().selection,
      selectedFeatureIds: ids,
      selectedFeatureId: ids.at(-1) ?? null,
      selectedNode: ids.length > 0 ? { type: 'feature', featureId: ids.at(-1)! } : null,
      mode: 'feature',
    },
  } as unknown as Partial<ProjectStore>)
}

test('Edit sketch is refused', () => {
  seed()
  useProjectStore.getState().enterSketchEdit('canned')
  const state = useProjectStore.getState()
  assertEqual(state.selection.mode, 'feature', 'mode unchanged')
  assertEqual(state.sketchEditSession, null, 'no edit session')
})

test('Constraints are refused', () => {
  seed()
  useProjectStore.getState().beginConstraint('canned')
  assertEqual(useProjectStore.getState().pendingConstraint, null, 'no constraint session')
})

test('Cut is refused and changes nothing', () => {
  seed()
  select(['plain', 'canned'])
  const before = useProjectStore.getState().project
  const created = useProjectStore.getState().cutSelectedFeatures(false)
  assertEqual(created, [], 'no derived rows')
  assertEqual(useProjectStore.getState().project, before, 'project untouched')
})

test('Join is refused and changes nothing', () => {
  seed()
  select(['plain', 'canned'])
  const before = useProjectStore.getState().project
  const created = useProjectStore.getState().mergeSelectedFeatures(false)
  assertEqual(created, [], 'no derived rows')
  assertEqual(useProjectStore.getState().project, before, 'project untouched')
})

test('Offset is refused and changes nothing', () => {
  seed()
  const before = useProjectStore.getState().project
  const created = useProjectStore.getState().offsetSelectedFeatures(2)
  assertEqual(created, [], 'no derived rows')
  assertEqual(useProjectStore.getState().project, before, 'project untouched')
})

test('Trim is refused with a reason', () => {
  seed()
  const before = useProjectStore.getState().project
  const hints = useProjectStore.getState().trimFeatureSegment(
    { featureId: 'canned', segmentIndex: 0 },
    { featureId: 'plain', segmentIndex: 0 },
  )
  assert(hints.length > 0, 'a reason is returned')
  assert(hints.some((hint) => hint.includes('expand to features first')), `reason names the way out: ${hints[0]}`)
  assertEqual(useProjectStore.getState().project, before, 'project untouched')
})

test('the immediate-join shortcut does not run on a canned shape', () => {
  const project = seed()
  assertEqual(selectionQualifiesForImmediateJoin(project, ['plain', 'canned']), false, 'falls back to the panel')
})

test('after Expand to features the plain rows accept the sketch', () => {
  seed()
  useProjectStore.getState().expandCannedFeature('canned')
  const state = useProjectStore.getState()
  const groupedFolderIds = new Set(
    state.project.featureFolders.filter((folder) => folder.grouped).map((folder) => folder.id),
  )
  const created = state.project.features.find((feature) => feature.folderId && groupedFolderIds.has(feature.folderId))
  assert(created, 'an outline row exists')
  useProjectStore.getState().enterSketchEdit(created.id)
  assertEqual(useProjectStore.getState().selection.mode, 'sketch_edit', 'edit now opens')
})

if (failCount > 0) {
  console.error(`\n${failCount} test(s) failed, ${passCount} passed`)
  process.exit(1)
}
console.log(`\nAll ${passCount} canned-refusal tests passed`)
