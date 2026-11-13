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
 * Copy / Make unique keep a shape canned (issue #1112, slice A).
 *
 * Run with: npx tsx src/store/cannedCopy.test.ts
 *
 * Move, rotate, mirror and copy are placement acts: they must keep the stored
 * kind/params. Make unique and an independent copy clone the definition, so the
 * clone must carry a *deep* copy of the parameters rather than share one object.
 */

import {
  IDENTITY_MATRIX,
  getProfileBounds,
  rectProfile,
  type FeatureDefinition,
  type FeatureInstance,
  type Project,
} from '../types/project'
import { instantiateProjectTemplate } from './helpers/normalize'
import { resolveFeatureInstance } from './helpers/resolveFeatures'
import { buildCopiedFeatures, type ReferencedSketchFeature } from './helpers/copyFeatures'
import { makeUnique } from './helpers/featureDefinitions'
import { resolveCannedShapeProfiles } from '../cannedShapes'
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

function project(): Project {
  const definition: FeatureDefinition = {
    id: 'def-plate',
    kind: 'composite',
    profile: rectProfile(0, 0, 100, 60),
    dimensions: [],
    text: null,
    canned: testPlateCanned(100, 60, 12),
    stl: null,
    operation: 'add',
  }
  const feature: FeatureInstance = {
    id: 'plate',
    name: 'Plate',
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
  return {
    ...instantiateProjectTemplate(),
    featureDefinitions: { [definition.id]: definition },
    features: [feature],
  }
}

function source(projectValue: Project): ReferencedSketchFeature {
  const resolved = resolveFeatureInstance(projectValue, 'plate')
  assert(resolved, 'source resolves')
  return resolved as unknown as ReferencedSketchFeature
}

test('a reference copy keeps the same definition (and so the parameters)', () => {
  const projectValue = project()
  const sourceFeature = source(projectValue)
  const created = buildCopiedFeatures(
    [sourceFeature],
    projectValue.features.map(({ id, name }) => ({ id, name })),
    20,
    0,
    1,
    projectValue.featureDefinitions,
    'reference',
  )
  assertEqual(created.length, 1, 'one copy')
  assertEqual(created[0].definitionId, 'def-plate', 'the copy shares the definition')
  assertEqual(created[0].transform.e, 20, 'the copy is placed at the offset')

  const copyProfiles = resolveCannedShapeProfiles({
    operation: created[0].operation,
    canned: projectValue.featureDefinitions[created[0].definitionId].canned,
    transform: created[0].transform,
  })
  const bounds = getProfileBounds(copyProfiles[0])
  assertEqual(bounds, { minX: 20, maxX: 120, minY: 0, maxY: 60 }, 'the generated copy follows the transform')
})

test('an independent copy deep-clones the canned data', () => {
  const projectValue = project()
  const sourceFeature = source(projectValue)
  const created = buildCopiedFeatures(
    [sourceFeature],
    projectValue.features.map(({ id, name }) => ({ id, name })),
    20,
    0,
    1,
    projectValue.featureDefinitions,
    'independent',
  )
  const cloned = created[0]._clonedDefinition
  assert(cloned, 'independent copy has its own definition')
  assertEqual(cloned.canned, testPlateCanned(100, 60, 12), 'parameters copied')
  assert(cloned.canned !== projectValue.featureDefinitions['def-plate'].canned, 'not the same params object')
})

test('Make unique clones the canned data and keeps the original intact', () => {
  const projectValue = project()
  const result = makeUnique(projectValue, 'plate')
  assert(result, 'make unique succeeds')
  assertEqual(result.clonedDefinition.canned, testPlateCanned(100, 60, 12), 'clone carries the parameters')
  assert(result.clonedDefinition.canned !== projectValue.featureDefinitions['def-plate'].canned, 'params are not shared')
  assertEqual(projectValue.featureDefinitions['def-plate'].canned, testPlateCanned(100, 60, 12), 'original unchanged')
})

test('a moved instance still regenerates the same shape', () => {
  const projectValue = project()
  const moved = resolveFeatureInstance({
    ...projectValue,
    features: projectValue.features.map((feature) => ({
      ...feature,
      transform: { ...IDENTITY_MATRIX, e: 40, f: -10 },
    })),
  }, 'plate')
  assert(moved, 'moved instance resolves')
  const profiles = resolveCannedShapeProfiles(moved)
  assertEqual(profiles.length, 2, 'still a plate with a hole')
  assertEqual(getProfileBounds(profiles[0]), { minX: 40, maxX: 140, minY: -10, maxY: 50 }, 'moved geometrically')
})

if (failCount > 0) {
  console.error(`\n${failCount} test(s) failed, ${passCount} passed`)
  process.exit(1)
}
console.log(`\nAll ${passCount} canned-copy tests passed`)
