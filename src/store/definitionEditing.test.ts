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

/** Strict definition editing tests for the 3.0 feature-instance model. */

import {
  IDENTITY_MATRIX,
  circleProfile,
  newProject,
  rectProfile,
  type FeatureInstance,
  type Matrix2D,
  type Project,
  type SketchFeature,
} from '../types/project'
import { projectWithFeatures, resolvedFeature } from '../test/projectFixtures'
import {
  getDefinitionId,
  getInstanceIdsForDefinition,
  makeUnique,
} from './helpers/featureDefinitions'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function draftFeature(id = 'feature-1'): SketchFeature {
  return {
    id,
    name: 'Rectangle',
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(10, 20, 30, 15),
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
}

function addLinkedInstance(
  project: Project,
  id: string,
  transform: Matrix2D,
): FeatureInstance {
  const original = project.features[0]
  assert(original, 'original instance must exist')
  const instance: FeatureInstance = {
    ...original,
    id,
    name: 'Linked rectangle',
    transform: { ...transform },
    constraints: [],
  }
  project.features.push(instance)
  return instance
}

function makeLinkedProject(): Project {
  const project = projectWithFeatures(newProject('Definitions', 'mm'), [draftFeature()])
  addLinkedInstance(project, 'feature-2', {
    ...IDENTITY_MATRIX,
    e: 50,
  })
  return project
}

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`   ✓ ${name}`)
  } catch (error: unknown) {
    failed += 1
    console.log(`   ✗ ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

test('getDefinitionId requires the explicit instance reference', () => {
  const project = makeLinkedProject()
  assert(getDefinitionId(project.features[0]) === 'feature-1', 'original definition ID')
  assert(getDefinitionId(project.features[1]) === 'feature-1', 'linked definition ID')
})

test('getInstanceIdsForDefinition returns every linked instance', () => {
  const project = makeLinkedProject()
  const ids = getInstanceIdsForDefinition(project, 'feature-1')
  assert(ids.length === 2, `expected 2 instances, got ${ids.length}`)
  assert(ids.includes('feature-1') && ids.includes('feature-2'), 'both IDs should be returned')
})

test('definition edits are visible through every resolver read without rebaking rows', () => {
  const project = makeLinkedProject()
  const beforeRows = JSON.stringify(project.features)
  project.featureDefinitions['feature-1'] = {
    ...project.featureDefinitions['feature-1'],
    profile: rectProfile(20, 30, 40, 25),
  }

  const original = resolvedFeature(project, 'feature-1')
  const linked = resolvedFeature(project, 'feature-2')
  assert(original.sketch.profile.start.x === 20, 'original should resolve edited definition')
  assert(linked.sketch.profile.start.x === 70, 'linked transform should apply to edited definition')
  assert(JSON.stringify(project.features) === beforeRows, 'instance rows should remain lightweight and unchanged')
})

test('makeUnique clones the definition and isolates later edits', () => {
  const project = makeLinkedProject()
  const unique = makeUnique(project, 'feature-2')
  assert(unique, 'makeUnique should succeed')
  project.features = unique.features
  project.featureDefinitions[unique.newDefinitionId] = unique.clonedDefinition

  project.featureDefinitions['feature-1'] = {
    ...project.featureDefinitions['feature-1'],
    profile: rectProfile(100, 100, 10, 10),
  }

  const original = resolvedFeature(project, 'feature-1')
  const uniqueInstance = resolvedFeature(project, 'feature-2')
  assert(original.sketch.profile.start.x === 100, 'original should use edited definition')
  assert(uniqueInstance.sketch.profile.start.x === 60, 'unique instance should retain cloned geometry and transform')
  assert(project.features[1].definitionId === unique.newDefinitionId, 'instance should reference clone')
})

test('definition owns kind, operation, text, STL, and geometry', () => {
  const feature = draftFeature('rich-feature')
  feature.kind = 'circle'
  feature.sketch.profile = circleProfile(5, 6, 4)
  feature.operation = 'model'
  feature.text = { text: 'A', style: 'skeleton', fontId: 'simple_stroke', size: 10 }
  feature.stl = { meshAssetId: 'asset-1', scale: 1, axisSwap: 'none' }
  const project = projectWithFeatures(newProject('Rich definition', 'mm'), [feature])
  const row = project.features[0] as unknown as Record<string, unknown>
  const resolved = resolvedFeature(project, feature.id)

  assert(!('sketch' in row), 'instance row must not contain sketch geometry')
  assert(!('operation' in row), 'instance row must not contain operation')
  assert(!('kind' in row), 'instance row must not contain kind')
  assert(resolved.kind === 'circle', 'kind should resolve from definition')
  assert(resolved.operation === 'model', 'operation should resolve from definition')
  assert(resolved.text?.text === 'A', 'text should resolve from definition')
  assert(resolved.stl?.meshAssetId === 'asset-1', 'STL should resolve from definition')
})

console.log(`\nDefinition editing: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
