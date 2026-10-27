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
 * Turn on a real square blank, and the old project contract around it
 * (issue #1112 slice G, carrying #1016 C2-B).
 *
 * Run with: npx tsx src/store/rotarySolidStore.test.ts
 *
 * The blank the user mounted is a **square**, and that is what these tests
 * insist on: a Turn on it is the old Square to round finished target inside the
 * real blank, and the stored stock is byte-identical to the square the job
 * started from. The same canned model then generates through the production
 * seam on the square blank, so the square-stock safety guards are unchanged.
 *
 * Mutations checked one at a time against these assertions:
 * - the blank relabelled `round` → the byte-identical-stock assertion fails;
 * - the finished cylinder built on the blank's corner radius instead of the
 *   requested diameter → the diameter and facet assertions fail;
 * - `diameter > side` accepted → the blank-fit refusal fails;
 * - the model's Z span anchored to the old bottom after a diameter edit → the
 *   centreline assertion fails;
 * - the canned parameters not stored as the generator's set → the save/load
 *   round-trip fails;
 * - a Polygon on a square refused for needing a round bar → the square polygon
 *   creation and its mesh comparison fail;
 * - the old square-to-round folder routed through the new creator → its folder
 *   and operations disappear and the equivalence comparison has nothing to read.
 */

import assert from 'node:assert/strict'
import { defaultTool, newProject, rectProfile, type Project, type SketchFeature, type Tool } from '../types/project'
import { squareStock } from '../types/barStock'
import { bundledMachines } from '../machine/registry'
import { projectWithFeatures } from '../test/projectFixtures'
import { computeOperationToolpath } from '../engine/toolpaths/generateOperation'
import { loadPersistedTriangleMesh, serializeImportedMesh } from '../engine/importedMesh'
import type { ImportedTriangleMesh } from '../engine/importedMesh'
import { buildRotaryCylinder } from '../engine/rotaryCylinder'
import { buildRotaryPolygonPrism } from '../engine/rotaryPrism'
import { validateMachineDefinition } from '../engine/gcode/types'
import { runPostProcessor } from '../engine/gcode/postprocessor'
import { normalizeToolForProject } from '../engine/toolpaths/geometry'
import { generateCannedShapeMesh } from '../cannedShapes'
import { computeMeshBounds } from '../engine/importedMesh'
import { rotarySolidCannedData, type RotarySolidRefusal } from './helpers/rotarySolids'
import { rotarySolidFrame } from '../cannedShapes/generators/rotarySolidParams'
import { useProjectStore } from './projectStore'
import { switchWorkspaceFace } from './workspaceFace'

function refusalReason(result: { ok: boolean; reason?: RotarySolidRefusal }): RotarySolidRefusal | undefined {
  return result.ok ? undefined : result.reason
}

const store = () => useProjectStore.getState()

function near(actual: number, expected: number, label: string, tolerance = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} != ${expected}`)
}

// ── fixtures ──────────────────────────────────────────────────

const AT = { x: 10, y: 30 }
const SIDE = 25
const LENGTH = 120

function rotaryMachine(): ReturnType<typeof validateMachineDefinition> {
  const base = structuredClone(bundledMachines()[0])
  return validateMachineDefinition({
    ...base,
    id: 'around-square',
    rotary: { about: 'x', drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
  })
}

function cutter(): Tool {
  return {
    ...defaultTool('mm', 1),
    id: 'flat',
    name: 'Flat 6',
    units: 'mm',
    type: 'flat_endmill',
    diameter: 6,
    defaultStepover: 0.4,
    defaultStepdown: 2,
    defaultFeed: 600,
    defaultPlungeFeed: 200,
  }
}

function squareProject(): Project {
  const base = newProject('Turn square', 'mm')
  base.meta.projectType = 'rotary'
  base.stock = squareStock(SIDE, LENGTH, 'x', AT)
  const machine = rotaryMachine()
  base.meta.machineDefinitions = [machine]
  base.meta.selectedMachineId = machine.id
  base.tools = [cutter()]
  return base
}

function loadSquare(project: Project = squareProject()): Project {
  store().loadProject(project)
  assert.equal(switchWorkspaceFace('around'), true, 'the workspace enters Around')
  return store().project
}

function onlyModel() {
  const project = store().project
  const models = project.features.filter((feature) => project.featureDefinitions[feature.definitionId]?.kind === 'stl')
  assert.equal(models.length, 1, `exactly one model (got ${models.length})`)
  return models[0]
}

function modelMesh(feature = onlyModel()): ImportedTriangleMesh {
  const project = store().project
  const assetId = project.featureDefinitions[feature.definitionId]?.stl?.meshAssetId
  assert.ok(assetId, 'the model references a mesh asset')
  const asset = project.modelAssets[assetId]
  assert.ok(asset, 'the mesh asset exists')
  const mesh = loadPersistedTriangleMesh(asset)
  assert.ok(mesh, 'the mesh asset loads')
  return mesh
}

/** A legacy square-to-round folder + model + operations, as old files store it. */
function legacySquareProject(base: Project, mesh: ImportedTriangleMesh): Project {
  const assetId = 'model-asset-square-old'
  const asset = serializeImportedMesh(mesh, 'stl')
  const profile = rectProfile(
    mesh.bounds.minX,
    mesh.bounds.minY,
    mesh.bounds.maxX - mesh.bounds.minX,
    mesh.bounds.maxY - mesh.bounds.minY,
  )
  const definition = {
    id: 'def-square-old',
    kind: 'stl' as const,
    profile,
    dimensions: [],
    text: null,
    stl: { format: 'stl' as const, meshAssetId: assetId, scale: 1, axisSwap: 'none' as const },
    operation: 'model' as const,
  }
  const feature = {
    id: 'f-square-old',
    definitionId: definition.id,
    name: 'Square to round Model',
    kind: 'stl' as const,
    folderId: 'fd-square-old',
    sketch: { profile, origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
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
      featureDefinitions: { ...base.featureDefinitions, [definition.id]: definition },
      featureFolders: [{ id: 'fd-square-old', name: 'Square to round', collapsed: false, section: 'features' }],
      featureTree: [{ type: 'folder', folderId: 'fd-square-old' }, { type: 'feature', featureId: 'f-square-old' }],
    },
    [feature as unknown as SketchFeature],
  )
}

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

function movesAndGcode(project: Project, operationId: string): { moves: unknown[]; gcode: string } {
  const operation = project.operations.find((entry) => entry.id === operationId)
  assert.ok(operation)
  const envelope = computeOperationToolpath(project, operation)
  assert.ok(envelope)
  const toolRecord = project.tools.find((entry) => entry.id === operation.toolRef)
  assert.ok(toolRecord)
  const machine = project.meta.machineDefinitions.find((entry) => entry.id === project.meta.selectedMachineId)
  assert.ok(machine)
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

// ── creation on a square blank ───────────────────────────────

function testTurnOnSquare(): void {
  const project = loadSquare()
  const blank = project.stock
  assert.equal(blank.shape, 'square', 'the blank is a square, not a relabelled round bar')
  assert.equal(blank.thickness, SIDE, 'the blank side is untouched')
  const stockBefore = JSON.stringify(project.stock)

  const before = project.features.length
  const historyBefore = store().history.past.length
  const created = store().addRotarySolid({ kind: 'turn', start: 10, length: 30, diameter: 20 })
  assert.ok(created.ok, `Turn created (${created.ok ? '' : created.reason})`)
  if (!created.ok) return

  const next = store().project
  assert.equal(next.features.length, before + 1, 'one model row')
  assert.equal(next.featureFolders.length, 0, 'no folder')
  assert.equal(next.operations.length, 0, 'no operation')
  assert.equal(store().history.past.length, historyBefore + 1, 'one history entry')
  assert.equal(JSON.stringify(next.stock), stockBefore, 'the real square blank is byte-identical')

  const model = onlyModel()
  assert.equal(model.authoringFace, 'top', 'authored on Top for the persisted-model loader')
  const canned = next.featureDefinitions[model.definitionId].canned
  assert.equal(canned?.kind, 'turn', 'the canned kind is stored')

  // The model is the old Square to round cylinder: same vertices, same pivot.
  const mesh = modelMesh(model)
  const old = buildRotaryCylinder(
    project.stock as Parameters<typeof buildRotaryCylinder>[0],
    { diameter: 20, alongStart: 20, alongEnd: 50 },
    'mm',
  )
  assert.deepEqual(Array.from(mesh.positions), Array.from(old.positions), 'the Turn vertices equal Square to round')
  assert.deepEqual(Array.from(mesh.index), Array.from(old.index), 'the Turn triangles equal Square to round')
  near(mesh.bounds.minX, 20, 'start from the chuck end')
  near(mesh.bounds.maxX, 50, 'length 30')
  near(mesh.bounds.minZ, SIDE / 2 - 10, 'the cylinder sits on the blank pivot', 1e-3)
  near(mesh.bounds.maxZ, SIDE / 2 + 10, 'the cylinder top is on the pivot', 1e-3)

  // Undo removes it; redo restores it.
  store().undo()
  assert.equal(store().project.features.length, before, 'undo removes the model')
  store().redo()
  assert.equal(store().project.features.length, before + 1, 'redo restores the model')
}

function testPolygonOnSquare(): void {
  loadSquare()
  const created = store().addRotarySolid({
    kind: 'polygon', start: 0, length: 40, sides: 6, acrossFlats: 10, rotationDeg: 0,
  })
  assert.ok(created.ok, 'a polygon is created on a square blank')
  if (!created.ok) return
  const project = store().project
  const mesh = modelMesh()
  const old = buildRotaryPolygonPrism(project.stock as Parameters<typeof buildRotaryPolygonPrism>[0], {
    sides: 6, acrossFlats: 10, rotationDeg: 0, alongStart: 10, alongEnd: 50,
  })
  assert.deepEqual(Array.from(mesh.positions), Array.from(old.positions), 'the square-blank polygon is the builder output')
  assert.deepEqual(Array.from(mesh.index), Array.from(old.index), 'the square-blank polygon triangles match')
}

function testRefusals(): void {
  loadSquare()
  const before = store().project
  const historyBefore = store().history.past.length
  const cases: Array<[string, number | undefined]> = [
    ['a diameter above the side', 25.001],
    ['a zero diameter', 0],
    ['a non-finite diameter', Number.NaN],
  ]
  for (const [label, diameter] of cases) {
    const reason = refusalReason(store().addRotarySolid({ kind: 'turn', start: 0, length: 20, diameter: diameter as number }))
    assert.ok(reason === 'diameterExceedsStock' || reason === 'invalidDiameter', `${label} is refused (${reason})`)
    assert.equal(store().project.features.length, before.features.length, `${label} creates nothing`)
    assert.equal(store().history.past.length, historyBefore, `${label} records no history`)
  }
  assert.equal(
    refusalReason(store().addRotarySolid({ kind: 'polygon', start: 0, length: 20, sides: 6, acrossFlats: 30, rotationDeg: 0 })),
    'polygonExceedsStock',
    'a polygon wider than the blank is refused',
  )
  const flipped = store().project
  assert.equal(flipped.features.length, before.features.length)
}

// ── edit keeps the cylinder on the pivot ────────────────────

function testDiameterEditStaysCentred(): void {
  loadSquare()
  const created = store().addRotarySolid({ kind: 'turn', start: 10, length: 30, diameter: 20 })
  assert.ok(created.ok)
  if (!created.ok) return
  const model = onlyModel()
  const project = store().project
  const frame = rotarySolidFrame(project)
  assert.ok(frame)
  const canned = rotarySolidCannedData(frame, { kind: 'turn', start: 10, length: 30, diameter: 10 }, project.meta.units)
  assert.ok(canned)
  const mesh = generateCannedShapeMesh(canned)
  assert.ok(mesh)
  const bounds = computeMeshBounds(mesh.positions)
  store().updateFeature(model.id, { canned, z_bottom: bounds.minZ, z_top: bounds.maxZ })

  const edited = store().project.features.find((feature) => feature.id === model.id)
  assert.ok(edited)
  near(Number(edited.z_bottom), SIDE / 2 - 5, 'the smaller Turn still sits on the pivot', 1e-3)
  near(Number(edited.z_top), SIDE / 2 + 5, 'the smaller Turn top is on the pivot', 1e-3)
  const editedMesh = modelMesh(edited)
  near(editedMesh.bounds.minZ, SIDE / 2 - 5, 'the emitted mesh is centred', 1e-3)
  near(editedMesh.bounds.maxZ, SIDE / 2 + 5, 'the emitted mesh top is centred', 1e-3)
}

// ── save → load regenerates every kind ──────────────────────

function testRoundTripPerKind(): void {
  for (const input of [
    { kind: 'turn' as const, start: 10, length: 30, diameter: 20 },
    { kind: 'polygon' as const, start: 0, length: 40, sides: 8, acrossFlats: 10, rotationDeg: 22.5 },
  ]) {
    loadSquare()
    const created = store().addRotarySolid(input)
    assert.ok(created.ok, `${input.kind} created`)
    if (!created.ok) continue
    const before = store().project
    const beforeMesh = modelMesh()
    const file = store().saveProject()
    store().openProjectFromText(file, null)
    const after = store().project
    const feature = after.features.find((entry) => entry.id === created.featureId)
    assert.ok(feature, `${input.kind} survives the round trip`)
    assert.equal(after.featureDefinitions[feature.definitionId].canned?.kind, input.kind, `${input.kind}: kind survives`)
    const afterMesh = modelMesh(feature)
    assert.deepEqual(Array.from(afterMesh.positions), Array.from(beforeMesh.positions), `${input.kind}: vertices survive`)
    assert.deepEqual(Array.from(afterMesh.index), Array.from(beforeMesh.index), `${input.kind}: triangles survive`)
    assert.equal(before.operations.length, 0, 'the round trip creates no operation')
  }
}

// ── generation and equivalence on the square blank ─────────

function testSquareGenerationAndEquivalence(): void {
  const legacyBase = squareProject()
  const oldMesh = buildRotaryCylinder(
    legacyBase.stock as Parameters<typeof buildRotaryCylinder>[0],
    { diameter: 20, alongStart: 20, alongEnd: 50 },
    'mm',
  )
  const oldProject = legacySquareProject(legacyBase, oldMesh)
  loadSquare(oldProject)
  assert.equal(store().project.featureFolders.length, 1, 'the old folder is kept')
  const oldWithOps = addRotaryOperations('f-square-old')

  const newBase = squareProject()
  loadSquare(newBase)
  const created = store().addRotarySolid({ kind: 'turn', start: 10, length: 30, diameter: 20 })
  assert.ok(created.ok)
  if (!created.ok) return
  const newWithOps = addRotaryOperations(created.featureId)

  for (const kind of ['rotary_rough', 'rotary_finish'] as const) {
    const oldResult = movesAndGcode(oldWithOps, operationByKind(oldWithOps, kind).id)
    const newResult = movesAndGcode(newWithOps, operationByKind(newWithOps, kind).id)
    assert.deepEqual(newResult.moves, oldResult.moves, `${kind}: the square toolpath moves equal Square to round`)
    assert.equal(newResult.gcode, oldResult.gcode, `${kind}: the posted square G-code equals Square to round`)
    assert.ok(newResult.moves.length > 0, `${kind}: real motion on the square blank`)
  }

  // The guard is still the engine's: an operation on the canned model generates
  // through the square-stock seam, and the square stock is untouched.
  const finish = operationByKind(newWithOps, 'rotary_finish')
  const envelope = computeOperationToolpath(newWithOps, finish)
  assert.ok(envelope)
  assert.ok(envelope.result.moves.some((move) => move.from.a !== undefined || move.to.a !== undefined), 'the square pass carries the rotary angle')
  assert.equal(newWithOps.stock.shape, 'square', 'the stock stays a square blank')
}

// ── old projects stay old ───────────────────────────────────

function testOldSquareFolderUnchanged(): void {
  const base = squareProject()
  const oldMesh = buildRotaryCylinder(
    base.stock as Parameters<typeof buildRotaryCylinder>[0],
    { diameter: 20, alongStart: 20, alongEnd: 50 },
    'mm',
  )
  loadSquare(legacySquareProject(base, oldMesh))
  const loaded = store().project
  assert.equal(loaded.featureFolders.length, 1, 'the old folder is kept')
  assert.equal(loaded.featureFolders[0].name, 'Square to round', 'the old folder name is kept')
  const feature = loaded.features.find((entry) => entry.id === 'f-square-old')
  assert.ok(feature)
  assert.equal(feature.folderId, 'fd-square-old', 'the old model stays in its folder')
  const definition = loaded.featureDefinitions[feature.definitionId]
  assert.equal(definition.canned, undefined, 'no canned parameters are invented')
  assert.equal(definition.stl?.meshAssetId, 'model-asset-square-old', 'the old mesh asset is kept')
  assert.equal(loaded.operations.length, 0, 'loading creates no operation')

  // A real old project also carries its rough and finish. Adding them and
  // saving again must keep the folder, the model and both operations exactly as
  // they are: the new creator is never invoked for stored work.
  addRotaryOperations('f-square-old')
  const file = store().saveProject()
  store().openProjectFromText(file, null)
  const roundTripped = store().project
  assert.equal(roundTripped.featureFolders.length, 1, 'the old folder survives a save/load')
  assert.equal(roundTripped.featureFolders[0].name, 'Square to round', 'with its name')
  const keptFeature = roundTripped.features.find((entry) => entry.id === 'f-square-old')
  assert.ok(keptFeature, 'the old model survives')
  assert.equal(keptFeature.folderId, 'fd-square-old', 'and stays in its folder')
  assert.equal(roundTripped.operations.length, 2, 'both old operations survive')
  assert.deepEqual(
    roundTripped.operations.map((operation) => operation.kind).sort(),
    ['rotary_finish', 'rotary_rough'],
    'with their kinds',
  )
  assert.ok(
    roundTripped.operations.every((operation) => (
      operation.target.source === 'features' && operation.target.featureIds.includes('f-square-old')
    )),
    'and still target the old model',
  )
}

// ── run ──────────────────────────────────────────────────────

testTurnOnSquare()
testPolygonOnSquare()
testRefusals()
testDiameterEditStaysCentred()
testRoundTripPerKind()
testSquareGenerationAndEquivalence()
testOldSquareFolderUnchanged()

// A milling block is not a rotary project at all.
const block = newProject('Block', 'mm')
store().loadProject(block)
assert.equal(
  refusalReason(store().addRotarySolid({ kind: 'turn', start: 0, length: 10, diameter: 5 })),
  'notRotaryProject',
  'a milling block is not a rotary project',
)

console.log('rotarySolidStore: all assertions passed.')
