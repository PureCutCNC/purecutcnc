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
 *
 * The unit-change cases are issue #1157: a canned model's mesh is regenerated in
 * the new units from its converted parameters, so its `stl.scale` is the
 * dimensionless user factor on that mesh, never a unit bridge. A unit change
 * therefore leaves a canned model the same physical size, and an imported STL
 * (whose asset stays in its source units) keeps its scale conversion.
 */

import {
  IDENTITY_MATRIX,
  rectProfile,
  type CannedShapeData,
  type FeatureDefinition,
  type FeatureInstance,
  type Project,
  type SketchFeature,
} from '../types/project'
import { useProjectStore } from './projectStore'
import type { ProjectStore } from './types'
import { instantiateProjectTemplate } from './helpers/normalize'
import { resolveFeatureInstance } from './helpers/resolveFeatures'
import { cannedShapeFrame, cannedShapeIsExpandable } from '../cannedShapes'
import { cannedShapeModelAssetId, rebuildCannedShapeModel } from '../cannedShapes/model'
import { POLYGON_CANNED_KIND, TURN_CANNED_KIND } from '../cannedShapes/generators/kinds'
import { loadSTLTransformedGeometry } from '../engine/csg'
import { computeMeshBounds, serializeImportedMesh } from '../engine/importedMesh'
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
  minX: number
  maxX: number
  minY: number
  maxY: number
  minZ: number
  maxZ: number
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
    minX,
    maxX,
    minY,
    maxY,
    minZ,
    maxZ,
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

// ── A unit change keeps models the same physical size (issue #1157) ────────

/**
 * The bar frame both rotary solids are authored against: a 2 in bar along X
 * whose axis sits at across = 1. Lengths here are in the project's units at
 * authoring time (inches for these cases).
 */
const UNIT_MODEL_FRAME = {
  axis: 'x' as const,
  thickness: 2,
  alongMin: 0,
  alongMax: 4,
  acrossCentre: 1,
}

function hexCanned(): CannedShapeData {
  return {
    kind: POLYGON_CANNED_KIND,
    params: { start: 0.75, length: 0.5, sides: 6, acrossFlats: 1.5, rotation: 0, frame: UNIT_MODEL_FRAME },
  }
}

function turnCanned(): CannedShapeData {
  return {
    kind: TURN_CANNED_KIND,
    params: { start: 1.2, length: 2.55, diameter: 1, segments: 251, frame: UNIT_MODEL_FRAME },
  }
}

function cannedDefinition(id: string, canned: CannedShapeData, userScale: number): FeatureDefinition {
  return {
    id,
    kind: 'stl',
    profile: cannedShapeFrame(canned) ?? rectProfile(0, 0, 1, 1),
    dimensions: [],
    text: null,
    canned,
    stl: { scale: userScale, axisSwap: 'none' },
    operation: 'model',
  }
}

/** An imported 1 x 1 x 1 inch box, its asset in source (inch) coordinates. */
function importedBox(): { definition: FeatureDefinition; asset: ReturnType<typeof serializeImportedMesh> } {
  const positions = new Float32Array([
    -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
    -0.5, -0.5, 1, 0.5, -0.5, 1, 0.5, 0.5, 1, -0.5, 0.5, 1,
  ])
  const index = new Uint32Array([
    0, 2, 1, 0, 3, 2,
    4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6,
    3, 0, 4, 3, 4, 7,
  ])
  const meshAssetId = 'model-asset-imported-box'
  return {
    definition: {
      id: 'def-imported',
      kind: 'stl',
      profile: rectProfile(-0.5, -0.5, 1, 1),
      dimensions: [],
      text: null,
      stl: { format: 'stl', meshAssetId, scale: 1, axisSwap: 'none' },
      operation: 'model',
    },
    asset: serializeImportedMesh({ positions, index, bounds: computeMeshBounds(positions) }, 'stl'),
  }
}

function modelInstance(id: string, definitionId: string, zBottom: number, zTop: number): FeatureInstance {
  return {
    id,
    name: id,
    definitionId,
    transform: { ...IDENTITY_MATRIX },
    constraints: [],
    folderId: null,
    z_top: zTop,
    z_bottom: zBottom,
    authoringFace: 'top',
    visible: true,
    locked: false,
  }
}

/**
 * An inch project holding a Hex and a Turn canned model (their meshes rebuilt as
 * a save/load would) plus an imported STL box. The canned instance spans are
 * what the app's own creation/rebuild writes: the generated mesh extent at the
 * user's scale, anchored where the generator's `modelZAnchor` puts it.
 */
function seedUnitChangeProject(hexScale = 1): Project {
  const hex = cannedDefinition('def-hex', hexCanned(), hexScale)
  const turn = cannedDefinition('def-turn', turnCanned(), 1)
  const rebuiltHex = rebuildCannedShapeModel(hex)
  const rebuiltTurn = rebuildCannedShapeModel(turn)
  assert(rebuiltHex, 'the hex model generates a mesh')
  assert(rebuiltTurn, 'the turn model generates a mesh')
  const imported = importedBox()

  const spanOf = (rebuilt: NonNullable<ReturnType<typeof rebuildCannedShapeModel>>) => ({
    zBottom: rebuilt.asset.bounds.minZ * rebuilt.scale,
    zTop: rebuilt.asset.bounds.maxZ * rebuilt.scale,
  })
  const hexSpan = spanOf(rebuiltHex)
  const turnSpan = spanOf(rebuiltTurn)

  const template = instantiateProjectTemplate()
  const project: Project = {
    ...template,
    meta: { ...template.meta, units: 'inch' },
    modelAssets: {
      [rebuiltHex.assetId]: rebuiltHex.asset,
      [rebuiltTurn.assetId]: rebuiltTurn.asset,
      'model-asset-imported-box': imported.asset,
    },
    featureDefinitions: {
      [hex.id]: rebuiltHex.definition,
      [turn.id]: rebuiltTurn.definition,
      [imported.definition.id]: imported.definition,
    },
    features: [
      modelInstance('hex', hex.id, hexSpan.zBottom, hexSpan.zTop),
      modelInstance('turn', turn.id, turnSpan.zBottom, turnSpan.zTop),
      modelInstance('imported', imported.definition.id, 0, 1),
    ],
  }
  useProjectStore.setState({
    project,
    history: { past: [], future: [], transactionStart: null },
  } as unknown as Partial<ProjectStore>)
  return project
}

/** Consumed world-space mesh bounds in millimetres, whatever the project units. */
function consumedBoundsMm(featureId: string): ConsumedGeometry {
  const units = useProjectStore.getState().project.meta.units
  const factor = units === 'inch' ? 25.4 : 1
  const geometry = consumedGeometry(featureId)
  return {
    minX: geometry.minX * factor,
    maxX: geometry.maxX * factor,
    minY: geometry.minY * factor,
    maxY: geometry.maxY * factor,
    minZ: geometry.minZ * factor,
    maxZ: geometry.maxZ * factor,
    zTop: geometry.zTop * factor,
    zBottom: geometry.zBottom * factor,
    height: geometry.height * factor,
    width: geometry.width * factor,
    depth: geometry.depth * factor,
  }
}

/**
 * Equal within float tolerance. The mesh asset stores positions as Float32, so
 * a millimetre measurement of a ~45 mm model carries ~1e-6 mm of representation
 * error that no unit conversion put there; compare relatively, not bit-exactly.
 *
 * Both ends of every axis are compared, not just the extents: a conversion that
 * displaces a model sideways keeps its width and depth but moves its world-space
 * bounds, and issue #1157's acceptance is that the bounds do not move.
 */
function assertSamePhysicalSize(
  actual: ConsumedGeometry,
  expected: ConsumedGeometry,
  message: string,
  epsilon = 1e-6,
): void {
  const compared = [
    'minX', 'maxX', 'minY', 'maxY', 'minZ', 'maxZ',
    'zBottom', 'zTop', 'height', 'width', 'depth',
  ] as const
  for (const key of compared) {
    const scale = Math.max(1, Math.abs(actual[key]), Math.abs(expected[key]))
    if (Math.abs(actual[key] - expected[key]) > epsilon * scale) {
      throw new Error(
        `${message}: ${key} is ${actual[key]} mm, expected ${expected[key]} mm (Δ ${actual[key] - expected[key]} mm)`,
      )
    }
  }
}

test('inch → mm → inch leaves every model the same physical size', () => {
  seedUnitChangeProject()
  const ids = ['hex', 'turn', 'imported'] as const
  const before = new Map(ids.map((id) => [id, consumedBoundsMm(id)]))
  assert(
    before.get('hex')!.width > 0 && before.get('hex')!.depth > 0,
    'the hex model has geometry on both an X and a Y axis to measure',
  )

  useProjectStore.getState().setUnits('mm', 'convert')
  let project = useProjectStore.getState().project
  assertEqual(project.meta.units, 'mm', 'the project is in millimetres')
  for (const id of ids) {
    assertSamePhysicalSize(consumedBoundsMm(id), before.get(id)!, `inch → mm keeps ${id} the same size`)
  }

  useProjectStore.getState().setUnits('inch', 'convert')
  project = useProjectStore.getState().project
  assertEqual(project.meta.units, 'inch', 'the project is back in inches')
  for (const id of ids) {
    assertSamePhysicalSize(consumedBoundsMm(id), before.get(id)!, `mm → inch keeps ${id} the same size`)
  }
})

test('a canned model with a user scale keeps it, and its doubled size, through a unit change', () => {
  seedUnitChangeProject(2)
  const before = consumedBoundsMm('hex')

  useProjectStore.getState().setUnits('mm', 'convert')
  const project = useProjectStore.getState().project
  const definition = project.featureDefinitions['def-hex']
  assert(definition, 'the hex definition survives the unit change')
  assertEqual(definition.stl?.scale, 2, 'the user scale stays the dimensionless factor 2')

  const assetId = definition.stl?.meshAssetId
  assert(assetId, 'the definition still references its generated mesh')
  const asset = project.modelAssets[assetId]
  assert(asset, 'the regenerated mesh asset exists')
  const unscaledWidth = asset.bounds.maxX - asset.bounds.minX
  const unscaledHeight = asset.bounds.maxZ - asset.bounds.minZ

  const after = consumedBoundsMm('hex')
  assertSamePhysicalSize(after, before, 'a scaled model keeps its physical size through the unit change')
  const close = (actual: number, expected: number): boolean => Math.abs(actual - expected) <= 1e-6 * Math.max(1, expected)
  assert(close(after.width, unscaledWidth * 2), `width is twice the unscaled mesh (${after.width} vs ${unscaledWidth * 2})`)
  assert(close(after.height, unscaledHeight * 2), `height is twice the unscaled mesh (${after.height} vs ${unscaledHeight * 2})`)
})

if (failCount > 0) {
  console.error(`\n${failCount} test(s) failed, ${passCount} passed`)
  process.exit(1)
}
console.log(`\nAll ${passCount} canned-model tests passed`)
