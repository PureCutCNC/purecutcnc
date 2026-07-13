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

import { newProject, rectProfile, type FeatureDefinition, type FeatureInstance, type Project } from '../types/project'
import { projectWithFeatures, resolvedFeature } from '../test/projectFixtures'
import { buildCopiedFeatures, extractClonedDefinitions } from './helpers/copyFeatures'
import { createFeatureInstance, getInstanceIdsForDefinition } from './helpers/featureDefinitions'
import { resolveFeatureInstance } from './helpers/resolveFeatures'
import { useProjectStore } from './projectStore'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function makeProject(): Project {
  const base = newProject()
  return projectWithFeatures(base, [{
    id: 'f0001',
    name: 'Rect',
    kind: 'rect',
    operation: 'add',
    visible: true,
    locked: false,
    z_top: 5,
    z_bottom: 0,
    folderId: null,
    sketch: {
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
      profile: rectProfile(0, 0, 100, 50),
    },
    text: null,
    stl: null,
  }])
}

function instanceFromCopy(
  copy: ReturnType<typeof buildCopiedFeatures>[number],
): FeatureInstance {
  return createFeatureInstance(copy, copy.definitionId, copy.transform)
}

{
  const project = makeProject()
  const source = resolvedFeature(project, 'f0001')
  const copies = buildCopiedFeatures(
    [source],
    project.features,
    200,
    0,
    1,
    project.featureDefinitions,
    'reference',
  )
  assert(copies.length === 1, 'one reference copy created')
  const copy = copies[0]
  assert(copy.definitionId === source.definitionId, 'reference copy shares its definition')
  assert(Object.keys(extractClonedDefinitions(copies)).length === 0, 'reference copy creates no definition')

  const copyInstance = instanceFromCopy(copy)
  const linkedProject = { ...project, features: [...project.features, copyInstance] }
  const resolvedCopy = resolveFeatureInstance(linkedProject, copy.id)
  assert(resolvedCopy, 'reference copy resolves')
  assert(Math.abs(resolvedCopy.sketch.profile.start.x - 200) < 1e-9, 'copy transform is applied once')
  assert(getInstanceIdsForDefinition(linkedProject, source.definitionId).length === 2, 'both rows are linked')
}

{
  const project = makeProject()
  const source = resolvedFeature(project, 'f0001')
  const copies = buildCopiedFeatures(
    [source],
    project.features,
    50,
    25,
    1,
    project.featureDefinitions,
    'independent',
  )
  assert(copies.length === 1, 'one independent copy created')
  const copy = copies[0]
  const clonedDefinitions = extractClonedDefinitions(copies)
  const clonedDefinition = clonedDefinitions[copy.definitionId] as FeatureDefinition | undefined
  assert(clonedDefinition, 'independent copy creates a definition')
  assert(copy.definitionId !== source.definitionId, 'independent copy has a unique definition')

  const copyInstance = instanceFromCopy(copy)
  const independentProject = {
    ...project,
    featureDefinitions: { ...project.featureDefinitions, ...clonedDefinitions },
    features: [...project.features, copyInstance],
  }
  assert(getInstanceIdsForDefinition(independentProject, source.definitionId).length === 1, 'source stays unique')
  assert(getInstanceIdsForDefinition(independentProject, copy.definitionId).length === 1, 'copy stays unique')
}

{
  const project = makeProject()
  useProjectStore.setState({ project, dirty: false })
  assert(project.meta.copyMode === 'reference', 'reference is the default copy mode')
  useProjectStore.getState().setCopyMode('independent')
  assert(useProjectStore.getState().project.meta.copyMode === 'independent', 'copy mode is mutable')
}

console.log('duplicateReference.test.ts passed')
