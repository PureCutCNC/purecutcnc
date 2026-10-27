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
 * Turn and Polygon as canned models on a round bar (issue #1112 slice G).
 *
 * Run with: npx tsx src/store/rotarySolids.test.ts
 *
 * Mutations checked one at a time against these assertions:
 * - the creator writes a folder, a model and two operations as the old command
 *   did → "one feature, no folder, no operation" fails;
 * - the model is stamped `authoringFace: 'around'` → the consumer assertion
 *   fails (the persisted-model loader returns null for Around);
 * - `z_bottom`/`z_top` written as `[0, barDiameter]` instead of the emitted
 *   mesh's own Z bounds → the load-identity and placement assertions fail;
 * - the generated mesh built with rounded or re-derived numbers instead of the
 *   shared builder → the vertex comparison against the old command fails;
 * - the Y-bar start/length mapped as if Y grew away from the chuck → the
 *   `start 10 on a Y bar` bounds assertion fails;
 * - the canned parameters dropped from the definition, or an operation
 *   created from a tool, → the parameter/tool assertions fail;
 * - the creator split across two `set` calls → the one-undo assertion fails;
 * - the refusal path calling `set` first → the no-change assertions fail;
 * - the edit writing `canned` without pinning the regenerated Z bounds → the
 *   linked-copy and cylinder-centreline assertions fail;
 * - the old-folder fixture routed through the new creator → its folder and
 *   operations disappear and the equivalence comparison has nothing to read.
 */

import assert from 'node:assert/strict'
import { defaultTool, newProject, rectProfile, roundStock } from '../types/project'
import type { FeatureDefinition, FeatureInstance, Project, SketchFeature, Tool } from '../types/project'
import { bundledMachines } from '../machine/registry'
import { projectWithFeatures } from '../test/projectFixtures'
import { computeOperationToolpath } from '../engine/toolpaths/generateOperation'
import { loadPersistedTriangleMesh, serializeImportedMesh } from '../engine/importedMesh'
import type { ImportedTriangleMesh } from '../engine/importedMesh'
import { buildRotaryPolygonPrism } from '../engine/rotaryPrism'
import { buildRotaryCylinderMesh, rotaryCylinderSegments } from '../engine/rotaryCylinder'
import { validateMachineDefinition } from '../engine/gcode/types'
import type { MachineDefinition } from '../engine/gcode/types'
import { runPostProcessor } from '../engine/gcode/postprocessor'
import { normalizeToolForProject } from '../engine/toolpaths/geometry'
import { rotarySolidCannedData, type RotarySolidInput, type RotarySolidRefusal } from './helpers/rotarySolids'
import { computeMeshBounds } from '../engine/importedMesh'
import { generateCannedShapeMesh } from '../cannedShapes'
import { rotarySolidBarLength, rotarySolidFrame } from '../cannedShapes/generators/rotarySolidParams'
import { useProjectStore } from './projectStore'
import { switchWorkspaceFace } from './workspaceFace'

function refusalReason(result: { ok: boolean; reason?: RotarySolidRefusal }): RotarySolidRefusal | undefined {
  return result.ok ? undefined : result.reason
}

const store = () => useProjectStore.getState()

function log(message: string): void {
  console.log(message)
}

function near(actual: number, expected: number, label: string, tolerance = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} != ${expected}`)
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

function rotaryMachine(axis: 'x' | 'y'): MachineDefinition {
  const base = structuredClone(bundledMachines()[0])
  return validateMachineDefinition({
    ...base,
    id: `around-${axis}`,
    rotary: { about: axis, drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
  })
}

function cutter(units: 'mm' | 'inch'): Tool {
  return {
    ...defaultTool(units, 1),
    id: 'ball',
    name: 'Ball',
    units,
    type: 'ball_endmill',
    diameter: units === 'mm' ? 4 : 0.25,
    defaultStepover: 0.4,
    defaultStepdown: units === 'mm' ? 1 : 0.04,
    defaultFeed: units === 'mm' ? 600 : 24,
    defaultPlungeFeed: units === 'mm' ? 200 : 8,
  }
}

/** A rotary project on the given bar, before any load. */
function roundProject(spec: BarSpec = MM_X): Project {
  const base = newProject(`Solids ${spec.axis} ${spec.units}`, spec.units)
  base.meta.projectType = 'rotary'
  base.stock = roundStock(spec.diameter, spec.length, spec.axis, spec.at)
  const machine = rotaryMachine(spec.axis)
  base.meta.machineDefinitions = [machine]
  base.meta.selectedMachineId = machine.id
  base.tools = [cutter(spec.units)]
  return base
}

/** Load the bar, enter Around and return the project the workspace holds. */
function loadRotary(project: Project): Project {
  store().loadProject(project)
  assert.equal(switchWorkspaceFace('around'), true, 'the workspace enters Around')
  return store().project
}

function onlyModel(): FeatureInstance {
  const project = store().project
  const models = project.features.filter((feature) => project.featureDefinitions[feature.definitionId]?.kind === 'stl')
  assert.equal(models.length, 1, `exactly one model (got ${models.length})`)
  return models[0]
}

function modelAsset(feature: FeatureInstance): ImportedTriangleMesh {
  const project = store().project
  const definition = project.featureDefinitions[feature.definitionId]
  const assetId = definition?.stl?.meshAssetId
  assert.ok(assetId, 'the model references a mesh asset')
  const asset = project.modelAssets[assetId]
  assert.ok(asset, 'the mesh asset exists')
  const mesh = loadPersistedTriangleMesh(asset)
  assert.ok(mesh, 'the mesh asset loads')
  return mesh
}

/** A legacy rotary-solid folder + model + operations, exactly as old files store it. */
function legacyProject(base: Project, mesh: ImportedTriangleMesh, folderName: string): Project {
  const assetId = 'model-asset-old'
  const asset = serializeImportedMesh(mesh, 'stl')
  const definition: FeatureDefinition = {
    id: 'def-old',
    kind: 'stl',
    profile: rectProfile(
      mesh.bounds.minX,
      mesh.bounds.minY,
      mesh.bounds.maxX - mesh.bounds.minX,
      mesh.bounds.maxY - mesh.bounds.minY,
    ),
    dimensions: [],
    text: null,
    stl: { format: 'stl', meshAssetId: assetId, scale: 1, axisSwap: 'none' },
    operation: 'model',
  }
  const feature = {
    id: 'f-old',
    definitionId: 'def-old',
    name: `${folderName} Model`,
    kind: 'stl' as const,
    folderId: 'fd-old',
    sketch: {
      profile: definition.profile,
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'model' as const,
    authoringFace: 'top' as const,
    z_top: mesh.bounds.maxZ,
    z_bottom: mesh.bounds.minZ,
    visible: true,
    locked: false,
  }
  return projectWithFeatures(
    {
      ...base,
      modelAssets: { ...base.modelAssets, [assetId]: asset },
      featureDefinitions: { ...base.featureDefinitions, 'def-old': definition },
      featureFolders: [{ id: 'fd-old', name: folderName, collapsed: false, section: 'features' }],
      featureTree: [{ type: 'folder', folderId: 'fd-old' }, { type: 'feature', featureId: 'f-old' }],
    },
    [feature as unknown as SketchFeature],
  )
}

/** Compute a toolpath and post it through the real postprocessor. */
function movesAndGcode(project: Project, operationId: string): { moves: unknown[]; gcode: string } {
  const operation = project.operations.find((entry) => entry.id === operationId)
  assert.ok(operation, 'the operation exists')
  const envelope = computeOperationToolpath(project, operation)
  assert.ok(envelope, 'generation returns an envelope')
  const toolRecord = project.tools.find((entry) => entry.id === operation.toolRef)
  assert.ok(toolRecord, 'the operation tool exists')
  const machine = project.meta.machineDefinitions.find((entry) => entry.id === project.meta.selectedMachineId)
  assert.ok(machine, 'the machine exists')
  const result = runPostProcessor({
    project,
    definition: validateMachineDefinition(machine),
    operations: [{
      operation,
      tool: normalizeToolForProject(toolRecord, project),
      toolpath: envelope.result,
    }],
    options: { emitToolChanges: false, emitCoolant: false, programName: project.meta.name },
  })
  return {
    moves: envelope.result.moves,
    gcode: result.gcode.replace(/\b\d{4}-\d{2}-\d{2}\b/g, 'YYYY-MM-DD'),
  }
}

/** Add the two rotary operations the old command created, through the store. */
function addRotaryOperations(featureId: string): Project {
  const target = { source: 'features' as const, featureIds: [featureId] }
  assert.ok(store().addOperation('rotary_rough', 'rough', target), 'rough is created')
  assert.ok(store().addOperation('rotary_finish', 'finish', target), 'finish is created')
  return store().project
}

function operationByKind(project: Project, kind: 'rotary_rough' | 'rotary_finish') {
  const operation = project.operations.find((entry) => entry.kind === kind)
  assert.ok(operation, `${kind} exists`)
  return operation
}

// ── creation ─────────────────────────────────────────────────

function testPolygonCreation(): void {
  loadRotary(roundProject())
  const before = store().project
  const historyBefore = store().history.past.length
  const result = store().addRotarySolid({
    kind: 'polygon',
    start: 10,
    length: 20,
    sides: 6,
    acrossFlats: 15,
    rotationDeg: 0,
  })
  assert.ok(result.ok, `polygon created (${result.ok ? '' : result.reason})`)
  if (!result.ok) return

  const project = store().project
  assert.equal(project.features.length, before.features.length + 1, 'one feature row')
  assert.equal(project.featureFolders.length, before.featureFolders.length, 'no folder')
  assert.equal(project.operations.length, before.operations.length, 'no operation')
  assert.deepEqual(project.tools, before.tools, 'no tool is added or changed')
  assert.equal(store().history.past.length, historyBefore + 1, 'one history entry')

  const model = onlyModel()
  assert.equal(model.name, 'Hex', 'a six-sided polygon is a Hex')
  assert.equal(model.authoringFace, 'top', 'authored on Top for the persisted-model loader')
  const definition = project.featureDefinitions[model.definitionId]
  assert.equal(definition.kind, 'stl', 'the row is an stl model')
  assert.equal(definition.operation, 'model', 'the row is a model')
  assert.equal(definition.canned?.kind, 'polygon', 'the canned kind is stored')
  assert.ok(definition.canned, 'the parameters are stored')
  assert.equal((definition.canned.params as { start: number }).start, 10, 'start is stored')
  assert.equal((definition.canned.params as { length: number }).length, 20, 'length is stored')

  // The mesh is the old command's mesh, vertex for vertex, at the absolute
  // stock coordinates the old command emitted.
  const mesh = modelAsset(model)
  const old = buildRotaryPolygonPrism(project.stock as Parameters<typeof buildRotaryPolygonPrism>[0], {
    sides: 6,
    acrossFlats: 15,
    rotationDeg: 0,
    alongStart: 20,
    alongEnd: 40,
  })
  assert.deepEqual(Array.from(mesh.positions), Array.from(old.positions), 'the polygon vertices equal the old command')
  assert.deepEqual(Array.from(mesh.index), Array.from(old.index), 'the polygon triangles equal the old command')
  near(mesh.bounds.minZ, 12.5, 'polygon bottom on the bar centreline')
  near(mesh.bounds.maxZ, 27.5, 'polygon top')
  assert.deepEqual([model.z_bottom, model.z_top], [mesh.bounds.minZ, mesh.bounds.maxZ], 'the span is the mesh bounds')

  // One undo removes everything; redo restores it.
  store().undo()
  assert.equal(store().project.features.length, before.features.length, 'undo removes the model')
  store().redo()
  assert.equal(store().project.features.length, before.features.length + 1, 'redo restores the model')
}

function testTurnCreation(): void {
  loadRotary(roundProject())
  const result = store().addRotarySolid({ kind: 'turn', start: 0, length: 40, diameter: 20 })
  assert.ok(result.ok, `turn created (${result.ok ? '' : result.reason})`)
  if (!result.ok) return
  const model = onlyModel()
  const project = store().project
  const mesh = modelAsset(model)
  const frame = rotarySolidFrame(project)
  assert.ok(frame)
  const canned = project.featureDefinitions[model.definitionId].canned
  assert.ok(canned)
  const segments = (canned.params as { segments: number }).segments
  const old = buildRotaryCylinderMesh(project.stock as Parameters<typeof buildRotaryCylinderMesh>[0], {
    diameter: 20,
    alongStart: 10,
    alongEnd: 50,
  }, segments)
  assert.deepEqual(Array.from(mesh.positions), Array.from(old.positions), 'the Turn vertices equal the cylinder builder')
  assert.deepEqual(Array.from(mesh.index), Array.from(old.index), 'the Turn triangles equal the cylinder builder')
  near(mesh.bounds.minX, 10, 'the Turn starts at the chuck end')
  near(mesh.bounds.maxX, 50, 'the Turn length is 40')
  near(mesh.bounds.minZ, 10, 'the Turn bottom is on the bar centreline minus radius', 1e-3)
  near(mesh.bounds.maxZ, 30, 'the Turn top is on the bar centreline plus radius', 1e-3)
}

function testYAxisMapping(): void {
  loadRotary(roundProject(MM_Y))
  const result = store().addRotarySolid({
    kind: 'polygon',
    start: 10,
    length: 20,
    sides: 6,
    acrossFlats: 10,
    rotationDeg: 0,
  })
  assert.ok(result.ok, 'the Y-bar polygon is created')
  if (!result.ok) return
  const mesh = modelAsset(onlyModel())
  // The chuck end of a Y bar is maxY = 230, so start 10 and length 20 is
  // y 200..220 — never the mirrored y 10..30.
  near(mesh.bounds.minY, 200, 'Y start from the chuck end')
  near(mesh.bounds.maxY, 220, 'Y end from the chuck end')
}

function testRefusals(): void {
  loadRotary(roundProject())
  const before = store().project
  const historyBefore = store().history.past.length
  const cases: Array<[string, RotarySolidInput, RotarySolidRefusal]> = [
    ['two sides', { kind: 'polygon', start: 0, length: 20, sides: 2, acrossFlats: 10, rotationDeg: 0 }, 'invalidSides'],
    ['a polygon wider than the bar', { kind: 'polygon', start: 0, length: 20, sides: 6, acrossFlats: 41, rotationDeg: 0 }, 'polygonExceedsStock'],
    ['a band past the bar', { kind: 'polygon', start: 190, length: 20, sides: 6, acrossFlats: 10, rotationDeg: 0 }, 'invalidAlongRange'],
    ['a turn wider than the bar', { kind: 'turn', start: 0, length: 20, diameter: 41 }, 'diameterExceedsStock'],
    ['a zero diameter', { kind: 'turn', start: 0, length: 20, diameter: 0 }, 'invalidDiameter'],
    ['a start below zero', { kind: 'turn', start: -1, length: 20, diameter: 20 }, 'invalidStart'],
  ]
  for (const [label, input, reason] of cases) {
    assert.equal(refusalReason(store().addRotarySolid(input)), reason, `${label} is refused`)
    assert.equal(store().project.features.length, before.features.length, `${label} creates no feature`)
    assert.equal(store().history.past.length, historyBefore, `${label} creates no history entry`)
  }
}

// ── edit and linked copies ────────────────────────────────────

function testEditRebuildsAndCopiesFollow(): void {
  loadRotary(roundProject())
  const created = store().addRotarySolid({
    kind: 'polygon', start: 10, length: 20, sides: 6, acrossFlats: 15, rotationDeg: 0,
  })
  assert.ok(created.ok)
  if (!created.ok) return
  const model = onlyModel()
  const linked: FeatureInstance = {
    ...model,
    id: 'linked',
    name: 'Linked copy',
    z_bottom: Number(model.z_bottom) - 27.5,
    z_top: Number(model.z_top) - 27.5,
  }
  store().loadProject({ ...store().project, features: [...store().project.features, linked] })

  const project = store().project
  const frame = rotarySolidFrame(project)
  assert.ok(frame)
  const canned = rotarySolidCannedData(frame, {
    kind: 'polygon', start: 30, length: 40, sides: 8, acrossFlats: 10, rotationDeg: 0,
  }, project.meta.units)
  assert.ok(canned)
  const mesh = generateCannedShapeMesh(canned)
  assert.ok(mesh)
  const bounds = computeMeshBounds(mesh.positions)
  store().updateFeature(model.id, { canned, z_bottom: bounds.minZ, z_top: bounds.maxZ })

  const edited = store().project
  const editedModel = edited.features.find((feature) => feature.id === model.id)
  const editedLink = edited.features.find((feature) => feature.id === 'linked')
  assert.ok(editedModel && editedLink)
  assert.equal(edited.featureDefinitions[editedModel.definitionId].canned?.kind, 'polygon')
  near(Number(editedModel.z_bottom), bounds.minZ, 'the edited row sits on the new mesh bottom')
  near(Number(editedModel.z_top), bounds.maxZ, 'the edited row reaches the new mesh top')
  near(Number(editedLink.z_bottom), -15, 'the linked copy keeps its own bottom')
  near(Number(editedLink.z_top), -15 + (bounds.maxZ - bounds.minZ), 'the linked copy follows the new height')
  const assetMesh = modelAsset(editedModel)
  assert.equal(assetMesh.positions.length, mesh.positions.length, 'the shared mesh was rebuilt')
}

// ── generator parameter sets and the old command ─────────────

function testMeshEquivalenceAcrossParameterSets(): void {
  const base = roundProject()
  const project = loadRotary(base)
  const frame = rotarySolidFrame(project)
  assert.ok(frame)
  const polygonSets = [
    { sides: 6, acrossFlats: 15, rotationDeg: 0, start: 0, length: 40 },
    { sides: 8, acrossFlats: 10, rotationDeg: 22.5, start: 10, length: 25 },
    { sides: 3, acrossFlats: 20, rotationDeg: -15, start: 50, length: 60 },
  ]
  for (const set of polygonSets) {
    const canned = rotarySolidCannedData(frame, { kind: 'polygon', ...set }, project.meta.units)
    assert.ok(canned, `polygon set ${set.sides}/${set.acrossFlats} normalizes`)
    const generated = generateCannedShapeMesh(canned)
    assert.ok(generated)
    const old = buildRotaryPolygonPrism(project.stock as Parameters<typeof buildRotaryPolygonPrism>[0], {
      sides: set.sides,
      acrossFlats: set.acrossFlats,
      rotationDeg: set.rotationDeg,
      alongStart: frame.alongMin + set.start,
      alongEnd: frame.alongMin + set.start + set.length,
    })
    assert.deepEqual(Array.from(generated.positions), Array.from(old.positions), `polygon ${set.sides} vertices`)
    assert.deepEqual(Array.from(generated.indices), Array.from(old.index), `polygon ${set.sides} triangles`)
  }

  const turnSets = [
    { diameter: 20, start: 0, length: 40 },
    { diameter: 32, start: 20, length: 70 },
    { diameter: 8, start: 100, length: 30 },
  ]
  for (const set of turnSets) {
    const canned = rotarySolidCannedData(frame, { kind: 'turn', ...set }, project.meta.units)
    assert.ok(canned, `turn set ${set.diameter} normalizes`)
    const generated = generateCannedShapeMesh(canned)
    assert.ok(generated)
    const segments = (canned.params as { segments: number }).segments
    const old = buildRotaryCylinderMesh(project.stock as Parameters<typeof buildRotaryCylinderMesh>[0], {
      diameter: set.diameter,
      alongStart: frame.alongMin + set.start,
      alongEnd: frame.alongMin + set.start + set.length,
    }, segments)
    assert.deepEqual(Array.from(generated.positions), Array.from(old.positions), `turn ${set.diameter} vertices`)
    assert.deepEqual(Array.from(generated.indices), Array.from(old.index), `turn ${set.diameter} triangles`)
  }
}

// ── toolpath and G-code equivalence ──────────────────────────

function testToolpathAndGcodeEquivalence(): void {
  // The old folder + model + operations and the new canned model + operations
  // are built from the same bar, tool and operation defaults, so every move and
  // the posted program must match.
  const legacyBase = roundProject()
  const oldMesh = buildRotaryPolygonPrism(legacyBase.stock as Parameters<typeof buildRotaryPolygonPrism>[0], {
    sides: 6, acrossFlats: 15, rotationDeg: 0, alongStart: 20, alongEnd: 40,
  })
  const oldProject = legacyProject(legacyBase, oldMesh, 'Hex')
  loadRotary(oldProject)
  const oldWithOps = addRotaryOperations('f-old')

  const newBase = roundProject()
  store().loadProject(newBase)
  assert.equal(switchWorkspaceFace('around'), true)
  const created = store().addRotarySolid({
    kind: 'polygon', start: 10, length: 20, sides: 6, acrossFlats: 15, rotationDeg: 0,
  })
  assert.ok(created.ok)
  if (!created.ok) return
  const newWithOps = addRotaryOperations(created.featureId)

  for (const kind of ['rotary_rough', 'rotary_finish'] as const) {
    const oldResult = movesAndGcode(oldWithOps, operationByKind(oldWithOps, kind).id)
    const newResult = movesAndGcode(newWithOps, operationByKind(newWithOps, kind).id)
    assert.deepEqual(newResult.moves, oldResult.moves, `${kind}: the toolpath moves equal the old folder's model`)
    assert.equal(newResult.gcode, oldResult.gcode, `${kind}: the posted G-code equals the old folder's model`)
    assert.ok(newResult.moves.length > 0, `${kind}: real motion`)
  }
}

// ── old projects stay old ────────────────────────────────────

function testOldFolderLoadsUnchanged(): void {
  const base = roundProject()
  const oldMesh = buildRotaryPolygonPrism(base.stock as Parameters<typeof buildRotaryPolygonPrism>[0], {
    sides: 6, acrossFlats: 15, rotationDeg: 0, alongStart: 20, alongEnd: 40,
  })
  const oldProject = legacyProject(base, oldMesh, 'Hex')
  loadRotary(oldProject)
  const loaded = store().project
  assert.equal(loaded.featureFolders.length, 1, 'the old folder is kept')
  assert.equal(loaded.featureFolders[0].name, 'Hex', 'the old folder name is kept')
  const feature = loaded.features.find((entry) => entry.id === 'f-old')
  assert.ok(feature, 'the old model row is kept')
  assert.equal(feature.folderId, 'fd-old', 'the old model stays in its folder')
  const definition = loaded.featureDefinitions[feature.definitionId]
  assert.equal(definition.canned, undefined, 'no canned parameters are invented')
  assert.equal(definition.stl?.meshAssetId, 'model-asset-old', 'the old mesh asset is kept')
  assert.equal(loaded.operations.length, 0, 'loading creates no operation')
}

// ── run ──────────────────────────────────────────────────────

loadRotary(roundProject())
const frame = rotarySolidFrame(store().project)
assert.ok(frame)
assert.equal(rotarySolidBarLength(frame), 200, 'the test bar is 200 long')

testPolygonCreation()
testTurnCreation()
testYAxisMapping()
testRefusals()
testEditRebuildsAndCopiesFollow()
testMeshEquivalenceAcrossParameterSets()
testToolpathAndGcodeEquivalence()
testOldFolderLoadsUnchanged()

// ── inch bar ─────────────────────────────────────────────────

loadRotary(roundProject(INCH_X))
const inch = store().addRotarySolid({
  kind: 'polygon', start: 0.25, length: 1, sides: 6, acrossFlats: 0.3, rotationDeg: 0,
})
assert.ok(inch.ok, 'the inch polygon is created')
if (inch.ok) {
  const mesh = modelAsset(onlyModel())
  near(mesh.bounds.minX, 3.25, 'inch start from the chuck end', 1e-4)
  near(mesh.bounds.maxX, 4.25, 'inch length', 1e-4)
  near(mesh.bounds.maxZ - mesh.bounds.minZ, 0.3, 'inch across flats', 1e-4)
}

// An inch Turn must choose its ring count from the inch sagitta, not the mm
// one: the same physical tolerance gives a finer ring at inch scale.
loadRotary(roundProject(INCH_X))
const inchTurn = store().addRotarySolid({ kind: 'turn', start: 0.25, length: 1, diameter: 0.5 })
assert.ok(inchTurn.ok, 'the inch turn is created')
if (inchTurn.ok) {
  const model = onlyModel()
  const canned = store().project.featureDefinitions[model.definitionId].canned
  assert.ok(canned)
  assert.equal(
    (canned.params as { segments: number }).segments,
    rotaryCylinderSegments(0.25, 'inch'),
    'the inch Turn stores the inch sagitta ring count',
  )
  const mesh = modelAsset(model)
  near(mesh.bounds.minX, 3.25, 'inch Turn start', 1e-3)
  near(mesh.bounds.maxX, 4.25, 'inch Turn length', 1e-3)
}

// A block is not a bar.
const block = newProject('Block', 'mm')
store().loadProject(block)
assert.equal(refusalReason(store().addRotarySolid({ kind: 'turn', start: 0, length: 10, diameter: 5 })), 'notRotaryProject', 'a block project is refused')

log('rotarySolids: all assertions passed.')
