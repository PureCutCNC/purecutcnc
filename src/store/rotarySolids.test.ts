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
 * The generated polygon solid on a round bar (issue #1016 C2-B).
 *
 * Mutations checked one at a time against these assertions:
 * - `z_bottom`/`z_top` written as `[0, barDiameter]` instead of the emitted
 *   mesh's Z bounds → the load-identity assertions fail (the loader's Z fit
 *   stops being the identity and the hex is stretched);
 * - the generated mesh serialized with `mesh` left on the feature instead of
 *   moved into `modelAssets` → the asset assertions fail;
 * - the model stamped `authoringFace: 'around'` → the load-identity test's
 *   `loadSTLTransformedGeometry` returns null;
 * - the operations left on the provisional setup id → "both operations join the
 *   real Around setup" fails;
 * - the finish operation created with `pass: 'rough'`, or the two kinds swapped
 *   → the kind/pass assertions fail;
 * - the target omitted or pointed at the folder → the target-id assertions and
 *   the generation test fail;
 * - the scratch tool's unit conversion dropped for one cross-unit tool default
 *   → "the operation lands in project units while the stored record does not"
 *   fails (feed/stepdown/plunge);
 * - the created feature's name not passed through `uniqueName` → the collision
 *   test fails against a pre-existing "Hex Model";
 * - creation split across two `set` calls → "one undo removes everything"
 *   fails;
 * - the refusal path calling `set` before validating → the invalid-input
 *   no-change assertions fail;
 * - the input numbers written to the feature/definition → the "no creation
 *   fields persisted" assertions fail.
 *
 * Run with: npx tsx src/store/rotarySolids.test.ts
 */

import assert from 'node:assert/strict'
import { defaultTool, getStockBounds, newProject, roundStock } from '../types/project'
import { squareStock } from '../types/barStock'
import type { Project, SketchFeature, Tool } from '../types/project'
import { bundledMachines } from '../machine/registry'
import { projectWithFeatures } from '../test/projectFixtures'
import { computeOperationToolpath } from '../engine/toolpaths/generateOperation'
import { loadSTLTransformedGeometry } from '../engine/csg'
import { computeMeshBounds, loadPersistedTriangleMesh, serializeImportedMesh } from '../engine/importedMesh'
import type { ImportedModelSourceFormat } from '../types/project'
import { validateMachineDefinition } from '../engine/gcode/types'
import type { MachineDefinition } from '../engine/gcode/types'
import { warningSeverity } from '../engine/toolpaths/warningCodes'
import { activeFace, activeSetup } from './helpers/activeFace'
import { provisionalSetupId } from './helpers/provisionalSetup'
import { useProjectStore } from './projectStore'
import { switchWorkspaceFace } from './workspaceFace'
import type { RotarySolidRefusal } from './helpers/rotarySolids'

/** The typed refusal reason, or undefined when the creation succeeded. */
function refusalReason(result: { ok: boolean; reason?: RotarySolidRefusal }): RotarySolidRefusal | undefined {
  return result.ok ? undefined : result.reason
}

function near(actual: number, expected: number, label: string, tolerance = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} != ${expected}`)
}

const store = () => useProjectStore.getState()

function log(message: string): void {
  console.log(message)
}

// ── fixtures ──────────────────────────────────────────────────

interface BarSpec {
  axis: 'x' | 'y'
  units: 'mm' | 'inch'
  at: { x: number; y: number }
  diameter: number
  length: number
}

const MM_X: BarSpec = { axis: 'x', units: 'mm', at: { x: 10, y: 30 }, diameter: 40, length: 200 }
const MM_Y: BarSpec = { axis: 'y', units: 'mm', at: { x: 10, y: 30 }, diameter: 40, length: 200 }
const INCH_X: BarSpec = { axis: 'x', units: 'inch', at: { x: 3, y: 5 }, diameter: 2, length: 8 }
const INCH_Y: BarSpec = { axis: 'y', units: 'inch', at: { x: 3, y: 5 }, diameter: 2, length: 8 }

function rotaryMachine(axis: 'x' | 'y'): MachineDefinition {
  const base = structuredClone(bundledMachines()[0])
  return validateMachineDefinition({
    ...base,
    id: `around-${axis}`,
    rotary: { about: axis, drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
  })
}

function cutter(units: 'mm' | 'inch', id: string): Tool {
  return {
    ...defaultTool(units, 1),
    id,
    name: `${id} ball`,
    units,
    type: 'ball_endmill',
    diameter: units === 'mm' ? 3 : 0.125,
    defaultStepover: 0.4,
    defaultStepdown: units === 'mm' ? 1 : 0.04,
    defaultFeed: units === 'mm' ? 600 : 24,
    defaultPlungeFeed: units === 'mm' ? 200 : 8,
  }
}

/** A rotary project on the given bar, with the given tools, loaded onto Around. */
function loadRotary(spec: BarSpec, tools: Tool[], features: SketchFeature[] = [], assets = {}): Project {
  const base = newProject(`Solids ${spec.axis} ${spec.units}`, spec.units)
  base.meta.projectType = 'rotary'
  base.stock = roundStock(spec.diameter, spec.length, spec.axis, spec.at)
  const machine = rotaryMachine(spec.axis)
  base.meta.machineDefinitions = [machine]
  base.meta.selectedMachineId = machine.id
  base.tools = tools
  base.modelAssets = { ...base.modelAssets, ...assets }
  const project = projectWithFeatures(base, features)
  store().loadProject(project)
  assert.equal(switchWorkspaceFace('around'), true, 'the workspace enters Around')
  return store().project
}

/** The project's own feature as a resolved-into-draft shape, for the load seam. */
function createdFeature(id: string): SketchFeature & { definitionId: string } {
  const instance = store().project.features.find((entry) => entry.id === id)
  assert.ok(instance, `feature ${id} exists`)
  const definition = store().project.featureDefinitions[instance.definitionId]
  assert.ok(definition, `definition for ${id} exists`)
  return {
    ...(instance as unknown as SketchFeature),
    definitionId: instance.definitionId,
    sketch: {
      profile: definition.profile,
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: definition.dimensions,
      constraints: [],
    },
    kind: definition.kind,
    operation: definition.operation,
    text: definition.text,
    stl: definition.stl,
  }
}

/** A tiny standalone asset that an existing feature can reference. */
function tinyAsset(format: ImportedModelSourceFormat = 'stl'): NonNullable<Project['modelAssets']>[string] {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
  return serializeImportedMesh({ positions, index: new Uint32Array([0, 1, 2]), bounds: computeMeshBounds(positions) }, format)
}

function existingModelFeature(id: string, assetId: string, folderId: string | null, name: string): SketchFeature {
  return {
    id,
    name,
    kind: 'stl',
    operation: 'model',
    authoringFace: 'top',
    folderId,
    sketch: {
      profile: {
        start: { x: 0, y: 0 },
        segments: [
          { type: 'line', to: { x: 1, y: 0 } },
          { type: 'line', to: { x: 1, y: 1 } },
          { type: 'line', to: { x: 0, y: 1 } },
          { type: 'line', to: { x: 0, y: 0 } },
        ],
        closed: true,
      },
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    stl: { format: 'stl', meshAssetId: assetId, scale: 1, axisSwap: 'none' },
    z_top: 1,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

const POLYGON = { kind: 'polygon', sides: 6, acrossFlats: 16, rotationDeg: 0 } as const

// ── creation, folder, model, operations ───────────────────────

log('Testing polygon creation, folder, model asset and both operations...')
{
  const spec = MM_X
  loadRotary(spec, [cutter('mm', 'ball')])
  const before = store().project
  const historyBefore = store().history.past.length
  const bounds = getStockBounds(before.stock)
  const alongStart = bounds.minX + 20
  const alongEnd = alongStart + 60

  const result = store().addRotarySolid({ ...POLYGON, alongStart, alongEnd, toolRef: 'ball' })
  assert.ok(result.ok, `polygon created (${result.ok ? '' : `${result.reason} ${result.detail ?? ''}`})`)
  if (!result.ok) throw new Error('unreachable')
  assert.equal(store().history.past.length, historyBefore + 1, 'exactly one history entry')

  const project = store().project
  const folder = project.featureFolders.find((entry) => entry.id === result.folderId)
  assert.ok(folder, 'the folder exists')
  assert.equal(folder.name, 'Hex', 'the folder is named for the shape')
  assert.equal(folder.section, 'features', 'the folder is an ordinary features folder')

  const feature = createdFeature(result.featureId)
  assert.equal(feature.folderId, result.folderId, 'the model is inside the folder')
  assert.equal(feature.kind, 'stl', 'the model is an stl feature')
  assert.equal(feature.operation, 'model', 'the model is an ordinary model feature')
  assert.equal(feature.authoringFace, 'top', 'the model is authored on Top for the load pipeline')
  assert.ok(feature.stl?.meshAssetId, 'the model references a mesh asset')
  assert.equal(feature.stl?.mesh, undefined, 'no transient mesh is left on the feature')
  const asset = project.modelAssets?.[feature.stl.meshAssetId]
  assert.ok(asset, 'the asset is in the project')

  // The mesh sits inside the bar and its Z bounds are the feature's own.
  const meshBounds = loadPersistedTriangleMesh(asset)!.bounds
  near(feature.z_bottom as number, meshBounds.minZ, 'z_bottom is the emitted mesh minimum Z')
  near(feature.z_top as number, meshBounds.maxZ, 'z_top is the emitted mesh maximum Z')
  assert.notEqual(feature.z_bottom, 0, 'the model is not stretched to the bar bottom')
  assert.notEqual(feature.z_top, spec.diameter, 'the model is not stretched to the bar top')

  // The plan sketch is the mesh's own absolute plan bounds.
  const profileBounds = getStockBounds({ ...project.stock, profile: feature.sketch.profile })
  near(profileBounds.minX, meshBounds.minX, 'sketch min X is the mesh plan minimum')
  near(profileBounds.maxX, meshBounds.maxX, 'sketch max X is the mesh plan maximum')
  near(profileBounds.minY, meshBounds.minY, 'sketch min Y is the mesh plan minimum')
  near(profileBounds.maxY, meshBounds.maxY, 'sketch max Y is the mesh plan maximum')

  // Rough then finish, both targeting exactly the created model.
  assert.equal(project.operations.length, 2, 'two operations are created')
  const rough = project.operations.find((entry) => entry.id === result.roughOperationId)
  const finish = project.operations.find((entry) => entry.id === result.finishOperationId)
  assert.ok(rough && finish, 'both operation ids resolve')
  assert.equal(rough.kind, 'rotary_rough', 'the first is a rotary rough')
  assert.equal(rough.pass, 'rough', 'the rough passes as rough')
  assert.equal(finish.kind, 'rotary_finish', 'the second is a rotary finish')
  assert.equal(finish.pass, 'finish', 'the finish passes as finish')
  for (const operation of [rough, finish]) {
    assert.deepEqual(operation.target, { source: 'features', featureIds: [result.featureId] }, 'targets the model')
    assert.equal(operation.toolRef, 'ball', 'uses the existing tool')
  }
  const setup = activeSetup(project)
  assert.equal(setup.kind, 'around', 'the workspace stays on Around')
  assert.notEqual(setup.id, provisionalSetupId('around'), 'the provisional setup is made real in the same step')
  assert.equal(rough.setupId, setup.id, 'the rough joins the real Around setup')
  assert.equal(finish.setupId, setup.id, 'the finish joins the real Around setup')
  assert.ok(project.setups.some((entry) => entry.id === setup.id && entry.kind === 'around'), 'the setup is stored')

  // The write leaves the new folder selected (the model is a ghost on Around).
  assert.deepEqual(store().selection.selectedNode, { type: 'folder', folderId: result.folderId }, 'the folder is selected')
  assert.equal(store().selection.selectedFeatureId, null, 'no ghost feature is left selected')

  // The input numbers are not stored anywhere.
  const serialized = JSON.stringify({ folder, definition: project.featureDefinitions[feature.definitionId], instance: project.features.find((entry) => entry.id === result.featureId) })
  for (const field of ['"sides"', '"acrossFlats"', '"rotationDeg"', '"alongStart"', '"alongEnd"', '"diameter"', 'polygonParams', 'solidParams']) {
    assert.ok(!serialized.includes(field), `${field} is not persisted`)
  }
  const rawInstance = project.features.find((entry) => entry.id === result.featureId)!
  assert.deepEqual(Object.keys(rawInstance).sort(), [
    'authoringFace', 'constraints', 'definitionId', 'folderId', 'id', 'locked', 'name',
    'textLayout', 'transform', 'visible', 'z_bottom', 'z_top',
  ], 'the instance carries no creation fields')
}

// ── both axes, both units, an offset blank ────────────────────

log('Testing both bar axes, both units and an offset blank...')
{
  for (const spec of [MM_X, MM_Y, INCH_X, INCH_Y]) {
    const label = `${spec.axis}/${spec.units}`
    loadRotary(spec, [cutter(spec.units, 'ball')])
    const bounds = getStockBounds(store().project.stock)
    const alongMin = spec.axis === 'x' ? bounds.minX : bounds.minY
    const acrossMin = spec.axis === 'x' ? bounds.minY : bounds.minX
    const acrossMax = spec.axis === 'x' ? bounds.maxY : bounds.maxX
    const acrossFlats = spec.units === 'mm' ? 16 : 0.6
    const radius = spec.diameter / 2
    const apothem = acrossFlats / 2
    const alongStart = alongMin + (spec.length * 0.1)
    const alongEnd = alongStart + (spec.length * 0.3)

    const result = store().addRotarySolid({ kind: 'polygon', sides: 6, acrossFlats, alongStart, alongEnd, toolRef: 'ball' })
    assert.ok(result.ok, `${label}: created (${result.ok ? '' : result.reason})`)
    if (!result.ok) throw new Error('unreachable')
    const feature = createdFeature(result.featureId)
    const asset = store().project.modelAssets![feature.stl!.meshAssetId!]
    const mesh = loadPersistedTriangleMesh(asset)!
    const centre = (acrossMin + acrossMax) / 2

    // Absolute placement on the bar's own frame, both axes: along is the
    // requested span, across is centred, Z straddles the centreline.
    if (spec.axis === 'x') {
      near(mesh.bounds.minX, alongStart, `${label}: along start`, 1e-4)
      near(mesh.bounds.maxX, alongEnd, `${label}: along end`, 1e-4)
      near((mesh.bounds.minY + mesh.bounds.maxY) / 2, centre, `${label}: centred across`, 1e-4)
    } else {
      near(mesh.bounds.minY, alongStart, `${label}: along start`, 1e-4)
      near(mesh.bounds.maxY, alongEnd, `${label}: along end`, 1e-4)
      near((mesh.bounds.minX + mesh.bounds.maxX) / 2, centre, `${label}: centred across`, 1e-4)
    }
    near(mesh.bounds.minZ, radius - apothem, `${label}: Z spans the apothem below the pivot`, 1e-4)
    near(mesh.bounds.maxZ, radius + apothem, `${label}: Z spans the apothem above the pivot`, 1e-4)
    near((mesh.bounds.minZ + mesh.bounds.maxZ) / 2, radius, `${label}: centred on the bar's pivot Z`, 1e-4)
    near(feature.z_bottom as number, mesh.bounds.minZ, `${label}: z_bottom is the mesh minimum`)
    near(feature.z_top as number, mesh.bounds.maxZ, `${label}: z_top is the mesh maximum`)
  }
}

// ── the persisted-model load seam stays identity ──────────────

log('Testing mesh Z bounds against the loader fit and the saved file...')
{
  for (const spec of [MM_X, MM_Y, INCH_X, INCH_Y]) {
    const label = `${spec.axis}/${spec.units}`
    loadRotary(spec, [cutter(spec.units, 'ball')])
    const bounds = getStockBounds(store().project.stock)
    const alongMin = spec.axis === 'x' ? bounds.minX : bounds.minY
    const alongStart = alongMin + spec.length * 0.1
    const alongEnd = alongStart + spec.length * 0.3
    const acrossFlats = spec.units === 'mm' ? 16 : 0.6
    const created = store().addRotarySolid({ kind: 'polygon', sides: 8, acrossFlats, alongStart, alongEnd, toolRef: 'ball' })
    assert.ok(created.ok, `${label}: created`)
    if (!created.ok) throw new Error('unreachable')

    const project = store().project
    const feature = createdFeature(created.featureId)
    const asset = project.modelAssets![feature.stl!.meshAssetId!]
    const mesh = loadPersistedTriangleMesh(asset)!
    const transformed = loadSTLTransformedGeometry(feature, project)
    assert.ok(transformed, `${label}: the model loads through the persisted-model seam`)
    if (!transformed) throw new Error('unreachable')

    // The loader fits raw mesh Z into [z_bottom, z_top]; equal bounds mean the
    // fit is the identity and every loaded vertex keeps its real Z.
    near(transformed.rawMinZ, mesh.bounds.minZ, `${label}: rawMinZ is the mesh minimum`)
    near(transformed.meshHeight, mesh.bounds.maxZ - mesh.bounds.minZ, `${label}: mesh height is preserved`)
    let minZ = Infinity
    let maxZ = -Infinity
    for (let i = 2; i < transformed.positions.length; i += 3) {
      minZ = Math.min(minZ, transformed.positions[i])
      maxZ = Math.max(maxZ, transformed.positions[i])
    }
    near(minZ, mesh.bounds.minZ, `${label}: loaded minimum Z is the mesh minimum`, 1e-4)
    near(maxZ, mesh.bounds.maxZ, `${label}: loaded maximum Z is the mesh maximum`, 1e-4)

    // Save and reload: the asset survives pruning, the Z band and the mesh are
    // unchanged (the model is an ordinary persisted asset).
    const saved = store().saveProject()
    const reloaded = JSON.parse(saved) as Project
    store().loadProject(reloaded)
    const reloadedFeature = createdFeature(created.featureId)
    const reloadedAsset = store().project.modelAssets?.[reloadedFeature.stl!.meshAssetId!]
    assert.ok(reloadedAsset, `${label}: the asset survives save and reload`)
    const reloadedMesh = loadPersistedTriangleMesh(reloadedAsset)!
    near(reloadedMesh.bounds.minZ, mesh.bounds.minZ, `${label}: reloaded mesh minimum Z`)
    near(reloadedMesh.bounds.maxZ, mesh.bounds.maxZ, `${label}: reloaded mesh maximum Z`)
    near(reloadedFeature.z_bottom as number, mesh.bounds.minZ, `${label}: reloaded z_bottom`)
    near(reloadedFeature.z_top as number, mesh.bounds.maxZ, `${label}: reloaded z_top`)
    assert.equal(reloadedFeature.operation, 'model', `${label}: reloads as an ordinary model`)
  }
}

// ── the real generation path ──────────────────────────────────

log('Testing generated rough and finish moves on the actual bar...')
{
  loadRotary(MM_X, [cutter('mm', 'ball')])
  const bounds = getStockBounds(store().project.stock)
  const alongStart = bounds.minX + 20
  const alongEnd = alongStart + 60
  const created = store().addRotarySolid({ ...POLYGON, alongStart, alongEnd, toolRef: 'ball' })
  assert.ok(created.ok, 'created')
  if (!created.ok) throw new Error('unreachable')

  const project = store().project
  for (const id of [created.roughOperationId, created.finishOperationId]) {
    const operation = project.operations.find((entry) => entry.id === id)!
    const envelope = computeOperationToolpath(project, operation)
    assert.ok(envelope, `${operation.kind}: generation returns an envelope`)
    if (!envelope) throw new Error('unreachable')
    const path = envelope.result
    assert.ok(path.moves.length > 0, `${operation.kind}: nonempty moves`)
    assert.deepEqual(
      path.warnings.map((warning) => warningSeverity(warning.code)),
      [],
      `${operation.kind}: no generation warning at any severity`,
    )
    // The cut stays inside the bar's own radius envelope.
    const radius = project.stock.thickness / 2
    for (const move of path.moves) {
      for (const point of [move.from, move.to]) {
        assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z), `${operation.kind}: finite points`)
      }
    }
    assert.ok(radius > 0, `${operation.kind}: a real bar radius`)
  }
}

// ── cross-unit existing tool ──────────────────────────────────

log('Testing a tool stored in the other unit...')
{
  const project = loadRotary(MM_X, [cutter('inch', 'inch-ball')])
  assert.equal(project.meta.units, 'mm', 'the project is metric')
  const bounds = getStockBounds(project.stock)
  const result = store().addRotarySolid({
    ...POLYGON,
    alongStart: bounds.minX + 20,
    alongEnd: bounds.minX + 80,
    toolRef: 'inch-ball',
  })
  assert.ok(result.ok, `created with a cross-unit tool (${result.ok ? '' : result.reason})`)
  if (!result.ok) throw new Error('unreachable')

  const after = store().project
  const stored = after.tools.find((entry) => entry.id === 'inch-ball')!
  assert.equal(stored.units, 'inch', 'the stored tool keeps its units')
  assert.equal(stored.diameter, 0.125, 'the stored tool keees its raw diameter')
  assert.equal(stored.defaultFeed, 24, 'the stored tool keeps its raw feed')
  assert.equal(stored.defaultStepdown, 0.04, 'the stored tool keeps its raw stepdown')

  const rough = after.operations.find((entry) => entry.id === result.roughOperationId)!
  near(rough.feed, 24 * 25.4, 'the operation feed lands in project units', 1e-9)
  near(rough.plungeFeed, 8 * 25.4, 'the operation plunge feed lands in project units', 1e-9)
  near(rough.stepdown, 0.04 * 25.4, 'the operation stepdown lands in project units', 1e-9)
  assert.equal(rough.toolRef, 'inch-ball', 'the operation still references the stored record')
  assert.equal(after.tools.length, 1, 'no tool was added or removed')
}

// ── unique ids and names beside existing content ──────────────

log('Testing unique ids and names beside existing assets...')
{
  const existing = existingModelFeature('existing-model', 'existing-asset', 'existing-folder', 'Hex Model')
  const base = newProject('Collide', 'mm')
  base.meta.projectType = 'rotary'
  base.stock = roundStock(40, 200, 'x', { x: 10, y: 30 })
  const machine = rotaryMachine('x')
  base.meta.machineDefinitions = [machine]
  base.meta.selectedMachineId = machine.id
  base.tools = [cutter('mm', 'hex-1')]
  base.modelAssets = { 'existing-asset': tinyAsset() }
  base.featureFolders = [{ id: 'existing-folder', name: 'Hex', collapsed: false, section: 'features' }]
  const project = projectWithFeatures(base, [existing])
  store().loadProject(project)
  assert.equal(switchWorkspaceFace('around'), true, 'the workspace enters Around')

  const bounds = getStockBounds(store().project.stock)
  // An existing feature id and asset id that the new ids must not reuse.
  const result = store().addRotarySolid({
    ...POLYGON,
    alongStart: bounds.minX + 20,
    alongEnd: bounds.minX + 80,
    toolRef: 'hex-1',
  })
  assert.ok(result.ok, 'created beside existing content')
  if (!result.ok) throw new Error('unreachable')

  const after = store().project
  assert.notEqual(result.folderId, 'existing-folder', 'a fresh folder id')
  assert.notEqual(result.featureId, 'existing-model', 'a fresh feature id')
  const folder = after.featureFolders.find((entry) => entry.id === result.folderId)!
  assert.equal(folder.name, 'Hex 2', 'the folder name avoids the existing one')
  const feature = after.features.find((entry) => entry.id === result.featureId)!
  assert.equal(feature.name, 'Hex 2 Model', 'the feature name avoids the existing one')
  const assetId = after.featureDefinitions[feature.definitionId].stl!.meshAssetId!
  assert.notEqual(assetId, 'existing-asset', 'the new asset does not overwrite the existing one')
  assert.ok(after.modelAssets!['existing-asset'], 'the existing asset is untouched')
  assert.ok(after.modelAssets![assetId], 'the new asset is stored')
}

// ── undo and redo ─────────────────────────────────────────────

log('Testing one undo removes everything and redo restores it...')
{
  loadRotary(MM_X, [cutter('mm', 'ball')])
  const before = store().project
  const bounds = getStockBounds(before.stock)
  const result = store().addRotarySolid({
    ...POLYGON,
    alongStart: bounds.minX + 20,
    alongEnd: bounds.minX + 80,
    toolRef: 'ball',
  })
  assert.ok(result.ok, 'created')
  if (!result.ok) throw new Error('unreachable')
  const createdAssetId = store().project.featureDefinitions[
    store().project.features.find((entry) => entry.id === result.featureId)!.definitionId
  ].stl!.meshAssetId!

  store().undo()
  const undone = store().project
  assert.equal(undone.features.length, before.features.length, 'undo removes the model')
  assert.equal(undone.featureFolders.length, before.featureFolders.length, 'undo removes the folder')
  assert.equal(undone.operations.length, 0, 'undo removes both operations')
  assert.equal(undone.modelAssets?.[createdAssetId], undefined, 'undo removes the asset')
  assert.deepEqual(Object.keys(undone.featureDefinitions), [], 'undo leaves no orphan definition')
  assert.equal(activeFace(undone), 'around', 'undo keeps the workspace on Around')
  assert.equal(store().history.future.length, 1, 'the undone step is redoable')

  store().redo()
  const redone = store().project
  assert.equal(redone.features.length, before.features.length + 1, 'redo restores the model')
  assert.equal(redone.featureFolders.length, before.featureFolders.length + 1, 'redo restores the folder')
  assert.equal(redone.operations.length, 2, 'redo restores both operations')
  assert.ok(redone.modelAssets?.[createdAssetId], 'redo restores the asset')
  assert.equal(activeFace(redone), 'around', 'redo keeps the workspace on Around')
}

// ── refusals change nothing ───────────────────────────────────

log('Testing refusals leave the project, history and selection untouched...')
{
  loadRotary(MM_X, [cutter('mm', 'ball')])
  const bounds = getStockBounds(store().project.stock)
  const base = {
    kind: 'polygon' as const,
    sides: 6,
    acrossFlats: 16,
    alongStart: bounds.minX + 20,
    alongEnd: bounds.minX + 80,
    toolRef: 'ball',
  }
  const before = store().project
  const selectionBefore = store().selection
  const dirtyBefore = store().dirty
  const historyBefore = store().history.past.length
  const assetsBefore = Object.keys(store().project.modelAssets ?? {}).length

  const refusals: Array<[string, () => { ok: boolean; reason?: string }]> = [
    ['sides below three', () => store().addRotarySolid({ ...base, sides: 2 })],
    ['non-integer sides', () => store().addRotarySolid({ ...base, sides: 6.5 })],
    ['sides above the ceiling', () => store().addRotarySolid({ ...base, sides: 65 })],
    ['non-positive across flats', () => store().addRotarySolid({ ...base, acrossFlats: 0 })],
    ['non-finite across flats', () => store().addRotarySolid({ ...base, acrossFlats: Infinity })],
    ['non-finite rotation', () => store().addRotarySolid({ ...base, rotationDeg: NaN })],
    ['descending along range', () => store().addRotarySolid({ ...base, alongStart: bounds.minX + 80, alongEnd: bounds.minX + 20 })],
    ['along range outside the bar', () => store().addRotarySolid({ ...base, alongEnd: bounds.maxX + 10 })],
    ['polygon wider than the bar', () => store().addRotarySolid({ ...base, acrossFlats: 41 })],
    ['missing tool', () => store().addRotarySolid({ ...base, toolRef: 'nope' })],
  ]
  for (const [label, run] of refusals) {
    const refused = run()
    assert.equal(refused.ok, false, `${label} is refused`)
    assert.equal(store().project, before, `${label} leaves the project untouched`)
    assert.equal(store().selection, selectionBefore, `${label} leaves the selection untouched`)
    assert.equal(store().dirty, dirtyBefore, `${label} leaves dirtiness untouched`)
    assert.equal(store().history.past.length, historyBefore, `${label} adds no history entry`)
    assert.equal(Object.keys(store().project.modelAssets ?? {}).length, assetsBefore, `${label} adds no asset`)
  }

  // Wrong project type / face / stock shape and an incompatible tool are typed.
  store().loadProject(newProject('Milling', 'mm'))
  assert.equal(refusalReason(store().addRotarySolid({ ...base })), 'notRotaryProject', 'a non-rotary project is refused')

  loadRotary(MM_X, [cutter('mm', 'ball')])
  store().setActiveSetup(store().project.setups.find((setup) => setup.kind !== 'around')?.id ?? provisionalSetupId('top'))
  assert.notEqual(activeFace(store().project), 'around', 'the fixture is away from Around')
  assert.equal(refusalReason(store().addRotarySolid({ ...base })), 'notAroundFace', 'a non-Around workspace is refused')

  // An incompatible cutter and an unusable cutter record are both refused.
  const plasma: Tool = { ...defaultTool('mm', 2), id: 'torch', type: 'plasma' }
  const blunt: Tool = { ...cutter('mm', 'blunt'), diameter: 0 }
  loadRotary(MM_X, [cutter('mm', 'ball'), plasma, blunt])
  assert.equal(refusalReason(store().addRotarySolid({ ...base, toolRef: 'torch' })), 'toolIncompatible', 'a torch is refused')
  assert.equal(refusalReason(store().addRotarySolid({ ...base, toolRef: 'blunt' })), 'invalidTool', 'a zero-diameter cutter is refused')

  // A polygon needs a round bar; a real Around setup gives the square project a
  // workspace face so the refusal is the stock shape, not the face.
  const squareBase = newProject('Square', 'mm')
  squareBase.meta.projectType = 'rotary'
  squareBase.stock = squareStock(40, 200, 'x', { x: 10, y: 30 })
  const machine = rotaryMachine('x')
  squareBase.meta.machineDefinitions = [machine]
  squareBase.meta.selectedMachineId = machine.id
  squareBase.tools = [cutter('mm', 'ball')]
  squareBase.setups.push({
    ...squareBase.setups[0],
    id: 'square-around',
    name: 'Around',
    kind: 'around',
    orientation: { axis: 'x', angleDeg: 0 },
  })
  squareBase.activeSetupId = 'square-around'
  store().loadProject(projectWithFeatures(squareBase, []))
  assert.equal(activeFace(store().project), 'around', 'the square project is on a real Around setup')
  assert.equal(refusalReason(store().addRotarySolid({ ...base })), 'needsRoundBar', 'a square blank is refused for a polygon')

  // The active Around setup must turn about the bar's own axis. An existing
  // Around feature keeps the setup from being re-axised onto the bar, so the
  // real mismatch survives the reconciler.
  const aroundLine: SketchFeature = {
    id: 'around-line',
    name: 'Around line',
    kind: 'polygon',
    operation: 'line',
    authoringFace: 'around',
    folderId: null,
    sketch: {
      profile: { start: { x: 0, y: 0 }, segments: [{ type: 'line', to: { x: 10, y: 0 } }], closed: false },
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    z_top: 40,
    z_bottom: 39,
    visible: true,
    locked: false,
  }
  const yBase = newProject('Y bar', 'mm')
  yBase.meta.projectType = 'rotary'
  yBase.stock = roundStock(40, 200, 'y', { x: 10, y: 30 })
  yBase.meta.machineDefinitions = [machine]
  yBase.meta.selectedMachineId = machine.id
  yBase.tools = [cutter('mm', 'ball')]
  yBase.setups.push({
    ...yBase.setups[0],
    id: 'y-around',
    name: 'Around',
    kind: 'around',
    orientation: { axis: 'x', angleDeg: 0 },
  })
  yBase.activeSetupId = 'y-around'
  store().loadProject(projectWithFeatures(yBase, [aroundLine]))
  assert.equal(activeFace(store().project), 'around', 'the Y bar project is on Around')
  assert.equal(
    refusalReason(store().addRotarySolid({ ...base })),
    'setupAxisMismatch',
    'an Around setup about the other axis is refused',
  )
}

log('rotarySolids: all assertions passed.')
