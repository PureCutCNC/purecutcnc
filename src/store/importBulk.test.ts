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

import type { ClassifiedShape, ImportedShape } from '../import'
import { rectProfile } from '../types/project'
import type { SketchFeature } from '../types/project'
import { useProjectStore } from './projectStore'
import { LARGE_IMPORT_THRESHOLD } from './slices/importMergeSlice'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function resetStore(): void {
  useProjectStore.getState().createNewProject()
}

function makeImport(
  count: number,
  options: { repeatedNames?: boolean; layerPerShape?: boolean } = {},
): { shapes: ImportedShape[]; classified: ClassifiedShape[] } {
  const shapes: ImportedShape[] = []
  const classified: ClassifiedShape[] = []
  for (let index = 0; index < count; index += 1) {
    const profile = rectProfile(index * 2, 0, 1, 1)
    const name = options.repeatedNames ? 'Contour' : `Contour ${index}`
    const layerName = options.layerPerShape ? `Layer ${index}` : index < count / 2 ? 'Layer A' : 'Layer B'
    shapes.push({ name, sourceType: 'dxf', layerName, profile })
    classified.push({
      name,
      sourceType: 'dxf',
      layerName,
      profile,
      operation: 'line',
      sourceIndex: index,
    })
  }
  return { shapes, classified }
}

function importFixture(count: number, options?: Parameters<typeof makeImport>[1]): string[] {
  const fixture = makeImport(count, options)
  return useProjectStore.getState().importShapes({
    fileName: 'synthetic.dxf',
    sourceType: 'dxf',
    ...fixture,
  })
}

function test2980RepeatedNamesBulkImport(): void {
  resetStore()
  const historyBefore = useProjectStore.getState().history.past.length
  const start = performance.now()
  const ids = importFixture(2980, { repeatedNames: true })
  const elapsed = performance.now() - start
  const state = useProjectStore.getState()
  const { features, featureDefinitions, featureFolders } = state.project

  assert(ids.length === 2980 && features.length === 2980, 'all 2,980 contours are created')
  assert(ids.every((id, index) => id === features[index].id), 'returned IDs preserve classifier order')
  assert(features[0].name === 'Contour', 'first repeated name keeps its base')
  assert(features[1].name === 'Contour 2', 'second repeated name gets suffix 2')
  assert(features.at(-1)?.name === 'Contour 2980', 'suffix cursor remains deterministic through 2,980')
  assert(new Set(ids).size === 2980, 'feature IDs are unique')

  const definitionIds = features.map(
    (feature) => (feature as SketchFeature & { definitionId?: string }).definitionId,
  )
  const definedIds = definitionIds.filter((id): id is string => id !== undefined)
  assert(definedIds.length === 2980, 'every feature has a definition ID')
  assert(new Set(definedIds).size === 2980, 'definition IDs are unique')
  assert(
    definedIds.every((id) => featureDefinitions[id] !== undefined),
    'every definition ID resolves in the project table',
  )
  assert(featureFolders.length === 2, 'two source layers create two folders')
  assert(featureFolders.every((folder) => folder.collapsed), 'large-import folders start collapsed')
  assert(state.selection.selectedFeatureIds.length === 0, 'large import does not select thousands of children')
  assert(state.selection.selectedNode?.type === 'folder', 'large import selects a folder representative')
  assert(state.history.past.length === historyBefore + 1, 'bulk import records one undo snapshot')
  assert(elapsed < 5000, `2,980 repeated-name contours import within 5s (was ${elapsed.toFixed(0)}ms)`)
  console.log(`  2,980 repeated-name contours imported in ${elapsed.toFixed(0)}ms`)
}

function testThresholdBoundaryAndManyLayers(): void {
  resetStore()
  const below = LARGE_IMPORT_THRESHOLD - 1
  const belowIds = importFixture(below, { layerPerShape: true })
  let state = useProjectStore.getState()
  assert(belowIds.length === below, 'below-threshold fixture imported')
  assert(state.project.featureFolders.length === below, 'many-layer folder allocation is complete')
  assert(state.project.featureFolders.every((folder) => !folder.collapsed), '499-item folders remain expanded')
  assert(state.selection.selectedFeatureIds.length === below, '499-item import preserves select-all behavior')
  assert(new Set(state.project.featureFolders.map((folder) => folder.name)).size === below, 'folder names are unique')

  resetStore()
  const atThresholdIds = importFixture(LARGE_IMPORT_THRESHOLD)
  state = useProjectStore.getState()
  assert(atThresholdIds.length === LARGE_IMPORT_THRESHOLD, 'threshold fixture imported')
  assert(state.project.featureFolders.every((folder) => folder.collapsed), '500-item folders start collapsed')
  assert(state.selection.selectedFeatureIds.length === 0, '500-item selection is bounded')
  assert(state.selection.selectedNode?.type === 'folder', '500-item import selects a folder')
}

function testLegacySmallImportUnchanged(): void {
  resetStore()
  const shapes = makeImport(5).shapes.map((shape, index) => ({
    ...shape,
    profile: index % 2 === 0
      ? shape.profile
      : { ...shape.profile, closed: false },
  }))
  const ids = useProjectStore.getState().importShapes({
    fileName: 'legacy.svg',
    sourceType: 'svg',
    shapes,
  })
  const state = useProjectStore.getState()
  assert(ids.length === 5 && state.selection.selectedFeatureIds.length === 5, 'legacy small import selects all')
  assert(state.project.featureFolders.every((folder) => !folder.collapsed), 'legacy small folders remain expanded')
  assert(state.project.features[0].operation === 'add', 'legacy closed profile remains Add')
  assert(state.project.features[1].operation === 'line', 'legacy open profile remains Line')
}

const tests = [
  ['2,980 repeated-name bulk import', test2980RepeatedNamesBulkImport],
  ['threshold boundary and many layers', testThresholdBoundaryAndManyLayers],
  ['legacy small import unchanged', testLegacySmallImportUnchanged],
] as const

let passed = 0
for (const [name, test] of tests) {
  test()
  passed += 1
  console.log(`${name}: PASSED`)
}
console.log(`\nimportBulk.test.ts: ${passed} passed, 0 failed`)
