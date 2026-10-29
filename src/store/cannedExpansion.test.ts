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
 * Canned-shape expansion tests (issue #1112, slice A).
 *
 * Run with: npx tsx src/store/cannedExpansion.test.ts
 *
 * Expand to features must give plain outline rows with Text's nesting rule:
 * outer = the feature type, hole = the opposite, and the source row kept.
 */

import {
  IDENTITY_MATRIX,
  type CannedShapeData,
  type FeatureDefinition,
  type FeatureInstance,
  type Project,
} from '../types/project'
import { useProjectStore } from './projectStore'
import type { ProjectStore } from './types'
import { instantiateProjectTemplate } from './helpers/normalize'
import { resolveCannedShapeShapes } from '../cannedShapes'
import { registerTestCannedShapes, testOpenLineCanned, testPlateCanned } from '../test/cannedShapeFixture'
import { resolveFeatureInstance } from './helpers/resolveFeatures'

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

function cannedFeature(
  id: string,
  canned: CannedShapeData,
  operation: FeatureDefinition['operation'] = 'add',
): { feature: FeatureInstance; definition: FeatureDefinition } {
  const definition: FeatureDefinition = {
    id: `def-${id}`,
    kind: 'composite',
    profile: { start: { x: 0, y: 0 }, segments: [], closed: true },
    dimensions: [],
    text: null,
    canned,
    stl: null,
    operation,
  }
  const feature: FeatureInstance = {
    id,
    name: id === 'canned-1' ? 'Plate' : 'Line',
    definitionId: definition.id,
    transform: { ...IDENTITY_MATRIX },
    constraints: [],
    folderId: null,
    z_top: 5,
    z_bottom: 0,
    authoringFace: 'top',
    visible: true,
    locked: false,
  }
  return { feature, definition }
}

function seed(): Project {
  const canned = cannedFeature('canned-1', testPlateCanned(100, 60, 12))
  const line = cannedFeature('canned-2', testOpenLineCanned(60, 8), 'line')
  const project: Project = {
    ...instantiateProjectTemplate(),
    featureDefinitions: {
      [canned.definition.id]: canned.definition,
      [line.definition.id]: line.definition,
    },
    features: [canned.feature, line.feature],
  }
  useProjectStore.setState({
    project,
    selection: {
      ...useProjectStore.getState().selection,
      selectedFeatureIds: ['canned-1'],
      selectedFeatureId: 'canned-1',
      selectedNode: { type: 'feature', featureId: 'canned-1' },
      mode: 'feature',
    },
    history: { past: [], future: [], transactionStart: null },
  } as unknown as Partial<ProjectStore>)
  return project
}

test('Expand keeps the source row and adds one folder with plain outlines', () => {
  const project = seed()
  useProjectStore.getState().expandCannedFeature('canned-1')
  const state = useProjectStore.getState()

  assertEqual(state.project.features.length, project.features.length + 2, 'two outline rows added')
  assertEqual(state.project.featureFolders.length, project.featureFolders.length + 1, 'one grouped folder')
  const folder = state.project.featureFolders[state.project.featureFolders.length - 1]
  assertEqual(folder.grouped, true, 'folder is a grouped expansion')
  assertEqual(folder.name, 'Plate', 'folder is named after the shape')

  const created = state.project.features.filter((row) => row.folderId === folder.id)
  assertEqual(created.length, 2, 'both outlines are in the folder')
  assertEqual(created.map((row) => row.name), ['Plate', 'Plate hole'], 'generator names the pieces')

  const definitions = created.map((row) => state.project.featureDefinitions[row.definitionId])
  assertEqual(definitions.map((definition) => definition.kind), ['composite', 'composite'], 'plain composites')
  assertEqual(definitions.map((definition) => definition.operation), ['add', 'subtract'], 'Add plate, Subtract hole')
  assertEqual(definitions.every((definition) => !definition.canned), true, 'pieces are no longer canned')
  assert(state.project.features.some((source) => source.id === 'canned-1'), 'source row kept')
})

test('the expanded profiles are the generated profiles', () => {
  const project = seed()
  const source = resolveFeatureInstance(project, 'canned-1')
  assert(source, 'source resolves')
  const expected = resolveCannedShapeShapes(source).map((shape) => shape.profile)

  useProjectStore.getState().expandCannedFeature('canned-1')
  const state = useProjectStore.getState()
  const created = state.project.features.filter((row) => row.folderId !== null && row.folderId !== undefined
    && state.project.featureFolders.some((folder) => folder.id === row.folderId && folder.grouped))
  assertEqual(
    created.map((row) => state.project.featureDefinitions[row.definitionId].profile),
    expected,
    'expanded geometry is exactly the generated geometry',
  )
})

test('a Subtract canned shape expands into Subtract outer / Add hole', () => {
  const canned = cannedFeature('canned-1', testPlateCanned(100, 60, 12), 'subtract')
  const project: Project = {
    ...instantiateProjectTemplate(),
    featureDefinitions: { [canned.definition.id]: canned.definition },
    features: [canned.feature],
  }
  useProjectStore.setState({
    project,
    selection: { ...useProjectStore.getState().selection, selectedFeatureIds: ['canned-1'] },
    history: { past: [], future: [], transactionStart: null },
  } as unknown as Partial<ProjectStore>)

  useProjectStore.getState().expandCannedFeature('canned-1')
  const state = useProjectStore.getState()
  const groupedFolderIds = new Set(
    state.project.featureFolders.filter((folder) => folder.grouped).map((folder) => folder.id),
  )
  const created = state.project.features.filter((row) => row.folderId !== null && groupedFolderIds.has(row.folderId))
  assertEqual(
    created.map((row) => state.project.featureDefinitions[row.definitionId].operation),
    ['subtract', 'add'],
    'Subtract plate, Add bore island',
  )
})

test('an open-line canned shape expands into open plain rows', () => {
  seed()
  useProjectStore.getState().expandCannedFeature('canned-2')
  const state = useProjectStore.getState()
  const groupedFolderIds = new Set(
    state.project.featureFolders.filter((folder) => folder.grouped).map((folder) => folder.id),
  )
  const lines = state.project.features.filter((row) => row.folderId !== null && groupedFolderIds.has(row.folderId))
  assertEqual(lines.length, 1, 'one open outline')
  const definition = state.project.featureDefinitions[lines[0].definitionId]
  assertEqual(definition.operation, 'line', 'open line keeps Line')
  assertEqual(definition.profile.closed, false, 'profile is open')
})

test('expanding a plain feature is a no-op', () => {
  seed()
  const before = useProjectStore.getState().project
  useProjectStore.getState().expandCannedFeature('does-not-exist')
  assertEqual(useProjectStore.getState().project, before, 'nothing changes')
})

test('the expanded rows are ordinary features again', () => {
  seed()
  useProjectStore.getState().expandCannedFeature('canned-1')
  const state = useProjectStore.getState()
  const groupedFolderIds = new Set(
    state.project.featureFolders.filter((folder) => folder.grouped).map((folder) => folder.id),
  )
  const created = state.project.features.filter((row) => row.folderId !== null && groupedFolderIds.has(row.folderId))
  assert(created.length > 0, 'rows exist')
  useProjectStore.getState().enterSketchEdit(created[0].id)
  assertEqual(useProjectStore.getState().selection.mode, 'sketch_edit', 'a plain row can be sketched')
  assert(useProjectStore.getState().sketchEditSession !== null, 'edit session opened')
})

if (failCount > 0) {
  console.error(`\n${failCount} test(s) failed, ${passCount} passed`)
  process.exit(1)
}
console.log(`\nAll ${passCount} canned-expansion tests passed`)
