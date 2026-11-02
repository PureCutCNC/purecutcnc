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
 * Canned models (issue #1112 A2).
 *
 * Run with: npx tsx src/store/cannedModel.test.ts
 *
 * Turn and Polygon (slice G) are canned *models*: parameters generate a mesh,
 * the mesh is stored in `Project.modelAssets` and referenced from
 * `definition.stl`, so imported-model consumers use it unchanged. A model is
 * not expandable — expansion would throw the parameters away. `test-model` from
 * the test fixture proves the contract end to end.
 *
 * The consumed-geometry cases are the A3 contract: a regenerated height reaches
 * `loadSTLTransformedGeometry` through every instance's Z span (including a
 * linked copy at its own placement), and a rebuild keeps the user's `stl.scale`
 * and transform instead of resetting them.
 */

import {
  IDENTITY_MATRIX,
  rectProfile,
  type FeatureDefinition,
  type FeatureInstance,
  type Project,
  type SketchFeature,
} from '../types/project'
import { useProjectStore } from './projectStore'
import type { ProjectStore } from './types'
import { instantiateProjectTemplate } from './helpers/normalize'
import { resolveFeatureInstance } from './helpers/resolveFeatures'
import { cannedShapeIsExpandable } from '../cannedShapes'
import { cannedShapeModelAssetId, rebuildCannedShapeModel } from '../cannedShapes/model'
import { loadSTLTransformedGeometry } from '../engine/csg'
import { isGhostFeature } from './helpers/activeFace'
import { readFileSync } from 'node:fs'
import {
  registerTestCannedShapes,
  testModelCanned,
  TEST_MODEL_KIND,
} from '../test/cannedShapeFixture'

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

function featureDraft(): SketchFeature {
  return {
    id: 'new-model',
    name: 'New model',
    kind: 'stl',
    folderId: null,
    sketch: { profile: rectProfile(-10, -10, 20, 20), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    canned: testModelCanned(20, 20, 5),
    operation: 'model',
    z_top: 5,
    z_bottom: 0,
    authoringFace: 'top',
    visible: true,
    locked: false,
  }
}

function seed(): Project {
  const definition: FeatureDefinition = {
    id: 'def-model',
    kind: 'stl',
    profile: rectProfile(-20, -15, 40, 30),
    dimensions: [],
    text: null,
    canned: testModelCanned(40, 30, 10),
    stl: null,
    operation: 'model',
  }
  const instance: FeatureInstance = {
    id: 'model',
    name: 'Turned part',
    definitionId: definition.id,
    transform: { ...IDENTITY_MATRIX },
    constraints: [],
    folderId: null,
    z_top: 10,
    z_bottom: 0,
    authoringFace: 'top',
    visible: true,
    locked: false,
  }
  const project: Project = {
    ...instantiateProjectTemplate(),
    featureDefinitions: { [definition.id]: definition },
    features: [instance],
  }
  useProjectStore.setState({
    project,
    selection: {
      ...useProjectStore.getState().selection,
      selectedFeatureIds: ['model'],
      selectedFeatureId: 'model',
      selectedNode: { type: 'feature', featureId: 'model' },
      mode: 'feature',
    },
    history: { past: [], future: [], transactionStart: null },
  } as unknown as Partial<ProjectStore>)
  return project
}

function modelMesh(): {
  assetId: string
  triangleCount: number
  vertexCount: number
  bounds: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }
} {
  const project = useProjectStore.getState().project
  const definition = project.featureDefinitions['def-model']
  assert(definition, 'definition exists')
  const assetId = definition.stl?.meshAssetId
  assert(assetId, 'the definition references a generated mesh asset')
  const asset = project.modelAssets[assetId]
  assert(asset, 'the mesh asset exists')
  return {
    assetId,
    triangleCount: asset.triangleCount,
    vertexCount: asset.vertexCount,
    bounds: asset.bounds,
  }
}

interface ConsumedGeometry {
  zTop: number
  zBottom: number
  height: number
  width: number
  depth: number
}

/**
 * What a consumer actually gets: the transformed geometry every downstream
 * reader (CSG, 3D, simulation, surface toolpaths, export) loads from the
 * instance span, not the asset's stored bounds.
 */
function consumedGeometry(featureId: string): ConsumedGeometry {
  const project = useProjectStore.getState().project
  const resolved = resolveFeatureInstance(project, featureId)
  assert(resolved, `${featureId} resolves`)
  const geometry = loadSTLTransformedGeometry(resolved, project)
  assert(geometry, `${featureId} consumes its generated mesh`)

  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (let index = 0; index < geometry.positions.length; index += 3) {
    const x = geometry.positions[index]
    const y = geometry.positions[index + 1]
    const z = geometry.positions[index + 2]
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
    minZ = Math.min(minZ, z)
    maxZ = Math.max(maxZ, z)
  }
  return {
    zTop: maxZ,
    zBottom: minZ,
    height: maxZ - minZ,
    width: maxX - minX,
    depth: maxY - minY,
  }
}

test('a model generates a mesh into modelAssets on a parameter change', () => {
  seed()
  useProjectStore.getState().updateFeature('model', { canned: testModelCanned(40, 30, 10) })

  const project = useProjectStore.getState().project
  const definition = project.featureDefinitions['def-model']
  assertEqual(definition.canned, testModelCanned(40, 30, 10), 'the kind/params envelope is kept')
  assertEqual(definition.kind, 'stl', 'the model is an stl row')
  assertEqual(definition.operation, 'model', 'the model operation is kept')

  const mesh = modelMesh()
  assertEqual(mesh.triangleCount, 12, 'the box has twelve triangles')
  assertEqual(mesh.vertexCount, 8, 'the box has eight vertices')
  assertEqual(mesh.bounds, {
    minX: -20, maxX: 20, minY: -15, maxY: 15, minZ: -10, maxZ: 0,
  }, 'the mesh follows the current parameters')
})

test('creating a canned model builds its mesh in the same write', () => {
  const project: Project = instantiateProjectTemplate()
  useProjectStore.setState({
    project,
    selection: {
      ...useProjectStore.getState().selection,
      selectedFeatureIds: [],
      selectedFeatureId: null,
      selectedNode: null,
      mode: 'feature',
    },
    history: { past: [], future: [], transactionStart: null },
  } as unknown as Partial<ProjectStore>)

  useProjectStore.getState().addFeature(featureDraft())
  const created = useProjectStore.getState().project
  const row = created.features.find((feature) => feature.id === 'new-model')
  assert(row, 'the model row was created')
  const definition = created.featureDefinitions[row.definitionId]
  assert(definition?.canned, 'the definition is canned')
  const assetId = definition.stl?.meshAssetId
  assert(assetId, 'creation built the mesh reference')
  assert(created.modelAssets[assetId], 'creation stored the mesh asset')
  assertEqual(created.modelAssets[assetId].triangleCount, 12, 'the created mesh is the model mesh')
})

test('a parameter change rebuilds the mesh used by imported-model readers', () => {
  seed()
  useProjectStore.getState().updateFeature('model', { canned: testModelCanned(40, 30, 10) })
  const first = modelMesh()
  const firstConsumed = consumedGeometry('model')

  useProjectStore.getState().updateFeature('model', { canned: testModelCanned(60, 20, 14) })
  const second = modelMesh()
  const secondConsumed = consumedGeometry('model')

  assertEqual(second.assetId, first.assetId, 'one definition keeps one asset id')
  assertEqual(second.triangleCount, 12, 'the rebuilt mesh is still a box')
  assertEqual(second.bounds, {
    minX: -30, maxX: 30, minY: -10, maxY: 10, minZ: -14, maxZ: 0,
  }, 'the rebuilt mesh follows the new parameters')

  // Asset bounds are not the contract: consumers load the instance's Z span.
  assertEqual(
    [firstConsumed.width, firstConsumed.depth, firstConsumed.height],
    [40, 30, 10],
    'the first model is consumed at the height its parameters generated',
  )
  assertEqual(
    [secondConsumed.width, secondConsumed.depth, secondConsumed.height],
    [60, 20, 14],
    'a parameter change reaches loadSTLTransformedGeometry, not only the asset',
  )
  assertEqual([secondConsumed.zBottom, secondConsumed.zTop], [0, 14], 'the consumed span is the mesh height')

  const resolved = resolveFeatureInstance(useProjectStore.getState().project, 'model')
  assert(resolved, 'the model resolves')
  assertEqual(resolved.stl?.meshAssetId, second.assetId, 'the resolved row exposes the generated mesh')
  assertEqual(resolved.operation, 'model', 'the resolved row is a model')
  assertEqual([resolved.z_bottom, resolved.z_top], [0, 14], 'the instance span carries the regenerated height')
})

test('a regenerated height reaches a linked copy, each above its own bottom', () => {
  const seeded = seed()
  const source = seeded.features[0]
  assert(source, 'the seeded model row exists')
  const linked: FeatureInstance = {
    ...source,
    id: 'linked',
    name: 'Linked copy',
    z_bottom: 2,
    z_top: 12,
    transform: { ...source.transform, e: 60 },
  }
  useProjectStore.setState({
    project: { ...seeded, features: [source, linked] },
  } as unknown as Partial<ProjectStore>)

  useProjectStore.getState().updateFeature('model', { canned: testModelCanned(40, 30, 20) })

  const project = useProjectStore.getState().project
  const resolvedSource = resolveFeatureInstance(project, 'model')
  const resolvedLinked = resolveFeatureInstance(project, 'linked')
  assert(resolvedSource && resolvedLinked, 'both rows resolve')
  assertEqual(resolvedSource.definitionId, resolvedLinked.definitionId, 'the copy is linked to the same definition')
  assertEqual([resolvedSource.z_bottom, resolvedSource.z_top], [0, 20], 'the edited row follows the new height')
  assertEqual([resolvedLinked.z_bottom, resolvedLinked.z_top], [2, 22], 'the linked copy keeps its own bottom')

  const sourceGeometry = consumedGeometry('model')
  const linkedGeometry = consumedGeometry('linked')
  assertEqual([sourceGeometry.zBottom, sourceGeometry.zTop], [0, 20], 'the edited row consumes the full height')
  assertEqual([linkedGeometry.zBottom, linkedGeometry.zTop], [2, 22], 'the linked copy consumes the full height at its placement')
  assertEqual(
    [linkedGeometry.width, linkedGeometry.depth, linkedGeometry.height],
    [40, 30, 20],
    'the linked copy consumes the regenerated dimensions',
  )
})

test('a rebuilt model never reuses a copied definition’s asset id', () => {
  const definition: FeatureDefinition = {
    id: 'def-copied',
    kind: 'stl',
    profile: rectProfile(-20, -15, 40, 30),
    dimensions: [],
    text: null,
    canned: testModelCanned(40, 30, 10),
    stl: { meshAssetId: 'model-asset-shared-from-the-source', scale: 1, axisSwap: 'none' },
    operation: 'model',
  }
  const rebuilt = rebuildCannedShapeModel(definition)
  assert(rebuilt, 'the model rebuilds')
  assertEqual(rebuilt.assetId, cannedShapeModelAssetId('def-copied'), 'the asset is keyed by definition id')
  assertEqual(rebuilt.definition.stl?.meshAssetId, rebuilt.assetId, 'the definition points at its own asset')
})

test('save and load keep the parameters and regenerate the mesh', () => {
  seed()
  useProjectStore.getState().updateFeature('model', { canned: testModelCanned(60, 20, 14) })
  const before = modelMesh()

  const file = useProjectStore.getState().saveProject()
  useProjectStore.getState().openProjectFromText(file, null)

  const project = useProjectStore.getState().project
  assertEqual(
    project.featureDefinitions['def-model'].canned,
    testModelCanned(60, 20, 14),
    'parameters survive the round trip',
  )
  const after = modelMesh()
  assertEqual(after.triangleCount, 12, 'the mesh is regenerated on load')
  assertEqual(after.bounds, before.bounds, 'the regenerated mesh matches the saved parameters')
})

test('save and load keep stl.scale, the instance transform and the scaled height', () => {
  seed()
  useProjectStore.getState().updateFeature('model', { canned: testModelCanned(40, 30, 10) })
  const definition = useProjectStore.getState().project.featureDefinitions['def-model']
  assert(definition?.stl, 'the generated model has its stl record')

  const placedTransform = { ...IDENTITY_MATRIX, e: 12, f: -4 }
  useProjectStore.setState({
    project: {
      ...useProjectStore.getState().project,
      features: useProjectStore.getState().project.features.map((feature) => (
        feature.id === 'model' ? { ...feature, transform: placedTransform } : feature
      )),
    },
  } as unknown as Partial<ProjectStore>)
  useProjectStore.getState().updateFeature('model', {
    stl: { ...definition.stl, scale: 2 },
  })

  const file = useProjectStore.getState().saveProject()
  useProjectStore.getState().openProjectFromText(file, null)

  const project = useProjectStore.getState().project
  const loaded = project.featureDefinitions['def-model']
  assertEqual(loaded.stl?.scale, 2, 'a rebuild keeps the user scale instead of resetting it to 1')
  assertEqual(project.features[0].transform, placedTransform, 'the instance transform survives the same rebuild')

  const consumed = consumedGeometry('model')
  assertEqual(
    [consumed.width, consumed.depth, consumed.height],
    [80, 60, 20],
    'the regenerated mesh is consumed at 2× on every axis, not halved in XY',
  )

  // A later parameter edit keeps the scale too: 15 local units → 30 consumed.
  useProjectStore.getState().updateFeature('model', { canned: testModelCanned(40, 30, 15) })
  const edited = consumedGeometry('model')
  assertEqual(
    [edited.width, edited.depth, edited.height],
    [80, 60, 30],
    'a parameter edit applies the kept scale to the regenerated mesh',
  )
})

test('a model row is never a ghost, canned or imported', () => {
  const project = seed()
  const aroundSetup = {
    ...project.setups[0],
    id: 'around',
    name: 'Around',
    kind: 'around' as const,
    orientation: { axis: 'x' as const, angleDeg: 0 },
  }
  const faceProject = {
    setups: [aroundSetup],
    activeSetupId: aroundSetup.id,
    featureDefinitions: project.featureDefinitions,
  }
  assertEqual(isGhostFeature(faceProject, project.features[0]), false, 'the canned model row is selectable on Around')

  const plainDefinition: FeatureDefinition = {
    ...project.featureDefinitions['def-model'],
    id: 'def-plain-model',
    canned: undefined,
  }
  const withPlain = {
    ...faceProject,
    featureDefinitions: { ...faceProject.featureDefinitions, [plainDefinition.id]: plainDefinition },
  }
  assertEqual(
    isGhostFeature(withPlain, { authoringFace: 'top', definitionId: plainDefinition.id }),
    false,
    'an imported model is not tied to a face either (issue #1112 I)',
  )
  assertEqual(
    isGhostFeature(withPlain, { authoringFace: 'top', definitionId: 'not-a-model' }),
    true,
    'a non-model feature on the other face stays a ghost',
  )
})

test('a model kind is not expandable and Expand does nothing', () => {
  const project = seed()
  assertEqual(cannedShapeIsExpandable(testModelCanned()), false, 'the model declares itself non-expandable')
  assertEqual(cannedShapeIsExpandable({ kind: TEST_MODEL_KIND, params: {} }), false, 'capability reads through the envelope')

  const before = useProjectStore.getState().project
  useProjectStore.getState().expandCannedFeature('model')
  assertEqual(useProjectStore.getState().project, before, 'no plain rows are created')
  assertEqual(project.features.length, 1, 'the source row is the only row')

  const resolved = resolveFeatureInstance(before, 'model')
  assert(resolved?.canned, 'the model is canned')
  assertEqual(cannedShapeIsExpandable(resolved.canned), false, 'the resolved model is non-expandable')
})

test('Properties only renders Expand behind the capability flag', () => {
  // The button is JSX, so this pins the wiring: a model kind must reach the
  // `cannedExpandable` guard rather than an always-rendered Expand action.
  const source = readFileSync(
    new URL('../components/feature-tree/PropertiesPanel.tsx', import.meta.url),
    'utf8',
  )
  const expandLabel = source.indexOf("t('featureTree.properties.canned.expand')")
  assert(expandLabel > 0, 'the Expand label is still in Properties')
  const guard = source.lastIndexOf('cannedExpandable ?', expandLabel)
  assert(guard > 0, 'Expand is rendered inside the cannedExpandable guard')
  const assignment = source.indexOf('const cannedExpandable = isCannedShape && cannedShapeIsExpandable')
  assert(assignment > 0, 'the guard reads the kind capability')
})

test('a sketch kind still expands', () => {
  seed()
  // Not a model: the test plate declares no capabilities, so expandable is the
  // default and the shared capability reader must not over-reach.
  assertEqual(cannedShapeIsExpandable({ kind: 'test-plate', params: {} }), true, 'a sketch kind stays expandable')
})

if (failCount > 0) {
  console.error(`\n${failCount} test(s) failed, ${passCount} passed`)
  process.exit(1)
}
console.log(`\nAll ${passCount} canned-model tests passed`)
