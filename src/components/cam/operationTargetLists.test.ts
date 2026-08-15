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
 * Tests for the context-menu operation-target candidate lists (issue #519).
 *
 * The two helpers must agree with the store's own `updateOperation` guard:
 * an "Add" candidate is always a valid post-merge target, and a
 * "Remove" candidate with `canRemove: false` is exactly the set of rows the
 * menu renders disabled.
 *
 * Run with: npx tsx src/components/cam/operationTargetLists.test.ts
 */

import {
  addToOperationCandidates,
  removeFromOperationCandidates,
} from './operationTargetLists'
import { projectWithFeatures } from '../../test/projectFixtures'
import {
  newProject,
  rectProfile,
  type FeatureKind,
  type FeatureOperation,
  type Operation,
  type OperationTarget,
  type Project,
  type SketchFeature,
} from '../../types/project'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function makeFeature(
  id: string,
  operation: FeatureOperation,
  kind: FeatureKind = 'polygon',
  closed = true,
): SketchFeature {
  return {
    id,
    name: id,
    kind,
    stl: kind === 'stl' ? null : undefined,
    folderId: null,
    sketch: {
      profile: rectProfile(0, 0, 10, 10),
      origin: { x: 0, y: 0 },
      orientationAngle: 90,
      dimensions: [],
      constraints: [],
    },
    operation,
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
    ...(closed ? {} : {
      sketch: {
        profile: {
          start: { x: 0, y: 0 },
          segments: [{ type: 'line' as const, to: { x: 10, y: 10 } }],
          closed: false,
        },
        origin: { x: 0, y: 0 },
        orientationAngle: 90,
        dimensions: [],
        constraints: [],
      },
    }),
  }
}

function makeOperation(
  id: string,
  kind: Operation['kind'],
  target: OperationTarget,
): Operation {
  return {
    id,
    name: id,
    kind,
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target,
    toolRef: null,
    stepdown: 1,
    stepover: 0.5,
    feed: 100,
    plungeFeed: 50,
    rpm: 10000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: false,
    finishFloor: false,
    carveDepth: 0,
    maxCarveDepth: 0,
  }
}

function featureTarget(...featureIds: string[]): OperationTarget {
  return { source: 'features', featureIds }
}

function projectWith(
  features: SketchFeature[],
  operations: Operation[],
): Project {
  return { ...projectWithFeatures(newProject(), features), operations }
}

function ids(candidates: Operation[]): string[] {
  return candidates.map((candidate) => candidate.id)
}

// ── addToOperationCandidates ──────────────────────────────────────

function testPocketAcceptsSecondSubtractAndRegions(): void {
  const project = projectWith(
    [makeFeature('sub1', 'subtract'), makeFeature('sub2', 'subtract'), makeFeature('reg1', 'region')],
    [makeOperation('pocket', 'pocket', featureTarget('sub1'))],
  )

  assert(ids(addToOperationCandidates(project, ['sub2'])).includes('pocket'), 'pocket accepts a second subtract feature')
  assert(ids(addToOperationCandidates(project, ['reg1'])).includes('pocket'), 'pocket accepts a closed region')
  assert(ids(addToOperationCandidates(project, ['sub2', 'reg1'])).includes('pocket'), 'pocket accepts a mixed selection')
}

function testAddExcludesNoOpAndIncompatibleSelections(): void {
  const project = projectWith(
    [
      makeFeature('sub1', 'subtract'),
      makeFeature('sub2', 'subtract'),
      makeFeature('add1', 'add'),
      makeFeature('con1', 'construction'),
    ],
    [makeOperation('pocket', 'pocket', featureTarget('sub1'))],
  )

  assert(ids(addToOperationCandidates(project, ['sub1'])).length === 0, 'already-present feature is a no-op')
  assert(ids(addToOperationCandidates(project, ['add1'])).length === 0, 'pocket rejects add features')
  assert(ids(addToOperationCandidates(project, ['con1'])).length === 0, 'construction geometry is never a target')
  assert(ids(addToOperationCandidates(project, ['sub2', 'con1'])).length === 0, 'one construction id poisons the selection')
}

function testOutsideRouteAddsOnlyAddOrModelFeatures(): void {
  const project = projectWith(
    [makeFeature('add1', 'add'), makeFeature('model1', 'model', 'stl'), makeFeature('sub1', 'subtract')],
    [makeOperation('outside', 'edge_route_outside', featureTarget('add1'))],
  )

  assert(ids(addToOperationCandidates(project, ['model1'])).includes('outside'), 'outside route accepts a model')
  assert(ids(addToOperationCandidates(project, ['sub1'])).length === 0, 'outside route rejects subtract features')
}

function testFinishSurfaceKeepsSingleModelInvariant(): void {
  const project = projectWith(
    [
      makeFeature('model1', 'model', 'stl'),
      makeFeature('model2', 'model', 'stl'),
      makeFeature('reg1', 'region'),
    ],
    [makeOperation('finish', 'finish_surface', featureTarget('model1'))],
  )

  assert(ids(addToOperationCandidates(project, ['reg1'])).includes('finish'), 'finish surface accepts a region')
  assert(ids(addToOperationCandidates(project, ['model2'])).length === 0, 'finish surface stays single-model')
}

function testStockTargetOperationsNeverAppear(): void {
  const project = projectWith(
    [makeFeature('add1', 'add')],
    [makeOperation('facing', 'surface_clean', { source: 'stock' })],
  )

  assert(ids(addToOperationCandidates(project, ['add1'])).length === 0, 'stock-target operation cannot take features')
  assert(removeFromOperationCandidates(project, ['add1']).length === 0, 'stock-target operation cannot list features')
}

function testEmptySelectionYieldsNoCandidates(): void {
  const project = projectWith(
    [makeFeature('sub1', 'subtract')],
    [makeOperation('pocket', 'pocket', featureTarget('sub1'))],
  )

  assert(addToOperationCandidates(project, []).length === 0, 'empty selection adds nothing')
  assert(removeFromOperationCandidates(project, []).length === 0, 'empty selection removes nothing')
}

// ── removeFromOperationCandidates ─────────────────────────────────

function testRemoveListsContainingOperationsWithValidityFlag(): void {
  const project = projectWith(
    [makeFeature('sub1', 'subtract'), makeFeature('sub2', 'subtract'), makeFeature('reg1', 'region')],
    [
      makeOperation('pocket-two', 'pocket', featureTarget('sub1', 'sub2')),
      makeOperation('pocket-one', 'pocket', featureTarget('sub1')),
      makeOperation('pocket-mixed', 'pocket', featureTarget('sub1', 'reg1')),
      makeOperation('other', 'pocket', featureTarget('sub2')),
    ],
  )

  const forSub1 = removeFromOperationCandidates(project, ['sub1'])
  const byId = new Map(forSub1.map((candidate) => [candidate.operation.id, candidate.canRemove]))

  assert(byId.get('pocket-two') === true, 'removing one of two subtract features stays valid')
  assert(byId.get('pocket-one') === false, 'removing the only machining feature invalidates the operation')
  assert(byId.get('pocket-mixed') === false, 'removing the only machining feature of a mixed target invalidates it')
  assert(!byId.has('other'), 'operations without the selection are not listed')
}

function testRemoveRegionAndMultiSelection(): void {
  const project = projectWith(
    [makeFeature('sub1', 'subtract'), makeFeature('reg1', 'region')],
    [makeOperation('pocket', 'pocket', featureTarget('sub1', 'reg1'))],
  )

  const forRegion = removeFromOperationCandidates(project, ['reg1'])
  assert(forRegion.length === 1 && forRegion[0].canRemove === true, 'removing the region keeps the pocket valid')

  const forAll = removeFromOperationCandidates(project, ['sub1', 'reg1'])
  assert(forAll.length === 1 && forAll[0].canRemove === false, 'removing everything invalidates the operation')
}

// ── runner ─────────────────────────────────────────────────────────

const tests: Array<[string, () => void]> = [
  ['pocket accepts second subtract and regions', testPocketAcceptsSecondSubtractAndRegions],
  ['add excludes no-op and incompatible selections', testAddExcludesNoOpAndIncompatibleSelections],
  ['outside route adds only add/model features', testOutsideRouteAddsOnlyAddOrModelFeatures],
  ['finish surface keeps single-model invariant', testFinishSurfaceKeepsSingleModelInvariant],
  ['stock-target operations never appear', testStockTargetOperationsNeverAppear],
  ['empty selection yields no candidates', testEmptySelectionYieldsNoCandidates],
  ['remove lists containing operations with validity flag', testRemoveListsContainingOperationsWithValidityFlag],
  ['remove region and multi-selection', testRemoveRegionAndMultiSelection],
]

let failures = 0
for (const [name, test] of tests) {
  try {
    test()
    console.log(`PASS ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${name}`)
    console.error(error)
  }
}

if (failures > 0) {
  console.error(`${failures} test(s) failed`)
  process.exit(1)
}

console.log(`All ${tests.length} operation-target list tests passed`)
