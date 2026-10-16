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
 * The square-to-round finished target on a real square blank (issue #1016
 * C2-B).
 *
 * The blank the user mounted is a **square**, and that is what these tests
 * insist on: the created model is the round finished target inside it, and the
 * stored stock is byte-identical to the square the job started from. The
 * retained square ends and the actual square-stock generation are the engine
 * slice's work; this file proves the created rough and finish operations
 * generate real motion through the production seam on the square blank
 * (C2-S4), and that the physical workholding guard is what the setup is judged
 * by rather than a shape assumption.
 *
 * Mutations checked one at a time against these assertions:
 * - the blank relabelled `round` (or rebuilt through the round normalizer) →
 *   the byte-identical-stock assertion fails;
 * - the pivot taken as `0` or as `barMaxRadius` instead of `barPivotZ`
 *   (side / 2) → the true-pivot assertions fail;
 * - the blank's centreline replaced by the stock origin → the across-placement
 *   assertions fail;
 * - the cylinder built on a circumscribed radius (`side × √½ / 2`) instead of
 *   the requested `diameter / 2` → the diameter, facet and Z-extent assertions
 *   fail;
 * - `diameter > side` accepted → the blank-fit refusal fails and the
 *   inside-the-blank assertion fails;
 * - `z_bottom`/`z_top` written as `[0, side]` → the load-identity assertions
 *   fail on any diameter below the side;
 * - the model's operations left on the provisional setup id, or the target
 *   pointed at the folder → the setup/target assertions fail;
 * - generation treated as working on a square blank → the successful
 *   nonempty-motion assertions fail (and would be a false claim);
 * - creation split across two `set` calls → the undo assertion fails;
 * - the creation taking its own snapshot (or clearing `transactionStart`)
 *   inside an open transaction → the combined undo/redo and the "open
 *   transaction is preserved" assertions fail.
 *
 * Run with: npx tsx src/store/rotarySolidStore.test.ts
 */

import assert from 'node:assert/strict'
import { defaultTool, getStockBounds, newProject, roundStock } from '../types/project'
import { barCentre, barPivotZ, isSquareStock, squareStock } from '../types/barStock'
import type { Project, SketchFeature, SquareStock, Tool } from '../types/project'
import { bundledMachines } from '../machine/registry'
import { projectWithFeatures } from '../test/projectFixtures'
import { computeOperationToolpath } from '../engine/toolpaths/generateOperation'
import { loadSTLTransformedGeometry } from '../engine/csg'
import { loadPersistedTriangleMesh } from '../engine/importedMesh'
import { validateMachineDefinition } from '../engine/gcode/types'
import type { MachineDefinition } from '../engine/gcode/types'
import { activeFace, activeSetup } from './helpers/activeFace'
import { provisionalSetupId } from './helpers/provisionalSetup'
import { useProjectStore } from './projectStore'
import type { RotarySolidRefusal } from './helpers/rotarySolids'
import { planRotarySolid } from './helpers/rotarySolids'

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

interface BlankSpec {
  axis: 'x' | 'y'
  units: 'mm' | 'inch'
  at: { x: number; y: number }
  side: number
  length: number
}

const MM_X: BlankSpec = { axis: 'x', units: 'mm', at: { x: 10, y: 30 }, side: 40, length: 200 }
const MM_Y: BlankSpec = { axis: 'y', units: 'mm', at: { x: 10, y: 30 }, side: 40, length: 200 }
const INCH_X: BlankSpec = { axis: 'x', units: 'inch', at: { x: 3, y: 5 }, side: 1.5, length: 8 }
const INCH_Y: BlankSpec = { axis: 'y', units: 'inch', at: { x: 3, y: 5 }, side: 1.5, length: 8 }

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
    diameter: units === 'mm' ? 4 : 0.1875,
    defaultStepover: 0.4,
    defaultStepdown: units === 'mm' ? 1 : 0.04,
    defaultFeed: units === 'mm' ? 600 : 24,
    defaultPlungeFeed: units === 'mm' ? 200 : 8,
  }
}

function squareBlankFor(spec: BlankSpec): SquareStock {
  return squareStock(spec.side, spec.length, spec.axis, spec.at)
}

/**
 * A rotary project on a real square blank with a real Around setup, already
 * active. `switchWorkspaceFace` refuses to enter Around on a square blank
 * today (`aroundUnavailableReason` still answers `needsRoundBar`), so the
 * fixture points the workspace at the real setup directly — the documented
 * state the UI slice will widen.
 */
function loadSquare(spec: BlankSpec, tools: Tool[]): Project {
  const base = newProject(`Square ${spec.axis} ${spec.units}`, spec.units)
  base.meta.projectType = 'rotary'
  base.stock = squareBlankFor(spec)
  const machine = rotaryMachine(spec.axis)
  base.meta.machineDefinitions = [machine]
  base.meta.selectedMachineId = machine.id
  base.tools = tools
  base.setups.push({
    ...base.setups[0],
    id: 'square-around',
    name: 'Around',
    kind: 'around',
    orientation: { axis: spec.axis, angleDeg: 0 },
  })
  base.activeSetupId = 'square-around'
  store().loadProject(projectWithFeatures(base, []))
  assert.equal(activeFace(store().project), 'around', 'the fixture is on a real Around setup')
  assert.ok(isSquareStock(store().project.stock), 'the fixture stock is a square blank')
  return store().project
}

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

const SQUARE_TO_ROUND = { kind: 'square-to-round' } as const

// ── creation keeps the real square blank ──────────────────────

log('Testing square-to-round creation on a real square blank...')
{
  const spec = MM_X
  const project = loadSquare(spec, [cutter('mm', 'ball')])
  const stockBefore = structuredClone(project.stock)
  const bounds = getStockBounds(project.stock)
  const alongStart = bounds.minX + 20
  const alongEnd = alongStart + 60
  const diameter = 24
  const historyBefore = store().history.past.length

  const result = store().addRotarySolid({ ...SQUARE_TO_ROUND, diameter, alongStart, alongEnd, toolRef: 'ball' })
  assert.ok(result.ok, `created (${result.ok ? '' : `${result.reason} ${result.detail ?? ''}`})`)
  if (!result.ok) throw new Error('unreachable')
  assert.equal(store().history.past.length, historyBefore + 1, 'exactly one history entry')

  const after = store().project
  // The blank is byte-identical: still the same square, never relabelled round.
  assert.ok(isSquareStock(after.stock), 'the stock is still a square blank')
  assert.equal(after.stock.shape, 'square', 'the shape is square')
  assert.equal(after.stock.thickness, spec.side, 'thickness is still the physical side')
  assert.deepEqual(after.stock, stockBefore, 'the stored blank is byte-identical')

  const folder = after.featureFolders.find((entry) => entry.id === result.folderId)
  assert.ok(folder, 'the folder exists')
  assert.equal(folder.name, 'Square to round', 'the folder is named for the shape')

  const feature = createdFeature(result.featureId)
  assert.equal(feature.folderId, result.folderId, 'the model is inside the folder')
  assert.equal(feature.kind, 'stl', 'the model is an stl feature')
  assert.equal(feature.operation, 'model', 'the model is an ordinary model feature')
  assert.equal(feature.authoringFace, 'top', 'the model is authored on Top for the load pipeline')
  const asset = after.modelAssets?.[feature.stl!.meshAssetId!]
  assert.ok(asset, 'the asset is stored')
  const mesh = loadPersistedTriangleMesh(asset)!

  // The target is the requested cylinder on the blank's true pivot — not a
  // circumscribed-stock approximation.
  const centre = barCentre(after.stock as SquareStock)
  const pivot = barPivotZ(after.stock as SquareStock)
  near(pivot, spec.side / 2, 'pivot is the blank side / 2')
  near((mesh.bounds.minZ + mesh.bounds.maxZ) / 2, pivot, 'the cylinder is centred on the true pivot', 1e-4)
  near(mesh.bounds.maxZ - mesh.bounds.minZ, diameter, 'the cylinder is the requested diameter', 1e-4)
  near(mesh.bounds.minZ, pivot - diameter / 2, 'Z bottom is the pivot less the radius', 1e-4)
  near(mesh.bounds.maxZ, pivot + diameter / 2, 'Z top is the pivot plus the radius', 1e-4)
  if (spec.axis === 'x') {
    near((mesh.bounds.minY + mesh.bounds.maxY) / 2, centre, 'centred across the blank', 1e-4)
  } else {
    near((mesh.bounds.minX + mesh.bounds.maxX) / 2, centre, 'centred across the blank', 1e-4)
  }
  // Inside the real blank: the cross-section never reaches a corner.
  const half = spec.side / 2
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const across = spec.axis === 'x' ? mesh.positions[i + 1] : mesh.positions[i]
    const up = mesh.positions[i + 2]
    assert.ok(Math.abs(across - centre) <= half + 1e-4, 'every vertex is inside the blank across')
    assert.ok(up >= -1e-4 && up <= spec.side + 1e-4, 'every vertex is inside the blank in Z')
  }

  // The feature's Z band is the emitted mesh's own, so the load fit is identity.
  near(feature.z_bottom as number, mesh.bounds.minZ, 'z_bottom is the mesh minimum Z')
  near(feature.z_top as number, mesh.bounds.maxZ, 'z_top is the mesh maximum Z')
  assert.notEqual(feature.z_bottom, 0, 'the target is not stretched to the blank bottom')

  // Rough and finish target the model, in the real Around setup.
  assert.equal(after.operations.length, 2, 'two operations are created')
  const rough = after.operations.find((entry) => entry.id === result.roughOperationId)!
  const finish = after.operations.find((entry) => entry.id === result.finishOperationId)!
  assert.equal(rough.kind, 'rotary_rough', 'the first is a rotary rough')
  assert.equal(finish.kind, 'rotary_finish', 'the second is a rotary finish')
  for (const operation of [rough, finish]) {
    assert.deepEqual(operation.target, { source: 'features', featureIds: [result.featureId] }, 'targets the model')
    assert.equal(operation.setupId, 'square-around', 'joins the real Around setup')
  }
  assert.equal(activeSetup(after).id, 'square-around', 'the workspace stays on the real Around setup')
  assert.notEqual(activeSetup(after).id, provisionalSetupId('around'), 'no provisional setup was invented')

  // No creation parameters are persisted.
  const serialized = JSON.stringify({
    folder,
    definition: after.featureDefinitions[feature.definitionId],
    instance: after.features.find((entry) => entry.id === result.featureId),
  })
  for (const field of ['"diameter"', '"alongStart"', '"alongEnd"', 'squareToRoundParams', 'solidParams']) {
    assert.ok(!serialized.includes(field), `${field} is not persisted`)
  }
}

// ── both axes, both units, an offset blank ────────────────────

log('Testing both blank axes, both units and an offset blank...')
{
  for (const spec of [MM_X, MM_Y, INCH_X, INCH_Y]) {
    const label = `${spec.axis}/${spec.units}`
    loadSquare(spec, [cutter(spec.units, 'ball')])
    const stockBefore = structuredClone(store().project.stock)
    const bounds = getStockBounds(store().project.stock)
    const alongMin = spec.axis === 'x' ? bounds.minX : bounds.minY
    const alongStart = alongMin + spec.length * 0.1
    const alongEnd = alongStart + spec.length * 0.3
    const diameter = spec.side * 0.6

    const result = store().addRotarySolid({ ...SQUARE_TO_ROUND, diameter, alongStart, alongEnd, toolRef: 'ball' })
    assert.ok(result.ok, `${label}: created (${result.ok ? '' : result.reason})`)
    if (!result.ok) throw new Error('unreachable')

    const after = store().project
    assert.deepEqual(after.stock, stockBefore, `${label}: the blank is unchanged`)
    const feature = createdFeature(result.featureId)
    const mesh = loadPersistedTriangleMesh(after.modelAssets![feature.stl!.meshAssetId!])!
    near((mesh.bounds.minZ + mesh.bounds.maxZ) / 2, spec.side / 2, `${label}: true pivot`, 1e-4)
    near(mesh.bounds.maxZ - mesh.bounds.minZ, diameter, `${label}: requested diameter`, 1e-4)
    if (spec.axis === 'x') {
      near(mesh.bounds.minX, alongStart, `${label}: along start`, 1e-4)
      near(mesh.bounds.maxX, alongEnd, `${label}: along end`, 1e-4)
    } else {
      near(mesh.bounds.minY, alongStart, `${label}: along start`, 1e-4)
      near(mesh.bounds.maxY, alongEnd, `${label}: along end`, 1e-4)
    }

    // The load seam is identity and the saved file round-trips.
    const transformed = loadSTLTransformedGeometry(feature, after)
    assert.ok(transformed, `${label}: the model loads`)
    if (!transformed) throw new Error('unreachable')
    near(transformed.rawMinZ, mesh.bounds.minZ, `${label}: rawMinZ is the mesh minimum`)
    let minZ = Infinity
    let maxZ = -Infinity
    for (let i = 2; i < transformed.positions.length; i += 3) {
      minZ = Math.min(minZ, transformed.positions[i])
      maxZ = Math.max(maxZ, transformed.positions[i])
    }
    near(minZ, mesh.bounds.minZ, `${label}: loaded minimum Z is the mesh minimum`, 1e-4)
    near(maxZ, mesh.bounds.maxZ, `${label}: loaded maximum Z is the mesh maximum`, 1e-4)

    const saved = JSON.parse(store().saveProject()) as Project
    store().loadProject(saved)
    const reloadedFeature = createdFeature(result.featureId)
    const reloadedAsset = store().project.modelAssets?.[reloadedFeature.stl!.meshAssetId!]
    assert.ok(reloadedAsset, `${label}: the asset survives save and reload`)
    near(loadPersistedTriangleMesh(reloadedAsset)!.bounds.minZ, mesh.bounds.minZ, `${label}: reloaded mesh`)
    assert.ok(isSquareStock(store().project.stock), `${label}: the reloaded blank is still square`)
    near((reloadedFeature.z_bottom as number), mesh.bounds.minZ, `${label}: reloaded z_bottom`)
    near((reloadedFeature.z_top as number), mesh.bounds.maxZ, `${label}: reloaded z_top`)
    assert.equal(reloadedFeature.operation, 'model', `${label}: reloads as an ordinary model`)
  }
}

// ── equal-to-side is allowed, larger is refused ───────────────

log('Testing diameter at and above the blank side...')
{
  loadSquare(MM_X, [cutter('mm', 'ball')])
  const bounds = getStockBounds(store().project.stock)
  const span = { alongStart: bounds.minX + 20, alongEnd: bounds.minX + 80, toolRef: 'ball' }
  const atSide = store().addRotarySolid({ ...SQUARE_TO_ROUND, diameter: 40, ...span })
  assert.ok(atSide.ok, 'a diameter equal to the side is the inscribed circle and is allowed')
  if (!atSide.ok) throw new Error('unreachable')
  const feature = createdFeature(atSide.featureId)
  const mesh = loadPersistedTriangleMesh(store().project.modelAssets![feature.stl!.meshAssetId!])!
  near(mesh.bounds.minZ, 0, 'at the side the target reaches the blank bottom', 0.002)
  near(mesh.bounds.maxZ, 40, 'at the side the target reaches the blank top', 0.002)

  loadSquare(MM_X, [cutter('mm', 'ball')])
  const tooBig = store().addRotarySolid({ ...SQUARE_TO_ROUND, diameter: 40.001, ...span })
  assert.equal(tooBig.ok, false, 'a diameter above the side is refused')
  assert.equal(refusalReason(tooBig), 'diameterExceedsBlank', 'with the blank-fit reason')
  for (const diameter of [0, -1, NaN, Infinity]) {
    const refused = store().addRotarySolid({ ...SQUARE_TO_ROUND, diameter, ...span })
    assert.equal(refused.ok, false, `diameter ${diameter} is refused`)
    assert.equal(refusalReason(refused), 'invalidDiameter', `diameter ${diameter} carries the invalid reason`)
  }
}

// ── the production seam generates on the square blank ─────────

log('Testing the production seam generates safe square rough and finish motion...')
{
  loadSquare(MM_X, [cutter('mm', 'ball')])
  const bounds = getStockBounds(store().project.stock)
  const result = store().addRotarySolid({
    ...SQUARE_TO_ROUND,
    diameter: 24,
    alongStart: bounds.minX + 20,
    alongEnd: bounds.minX + 80,
    toolRef: 'ball',
  })
  assert.ok(result.ok, 'the model and its operations are created')
  if (!result.ok) throw new Error('unreachable')

  // The production dispatch admits the real square blank: the same seam the
  // engine slice owns (`setupGenerationBlock` → `generateRotaryOperation`)
  // now produces motion instead of the documented shape refusal.
  const pivot = barPivotZ(store().project.stock as SquareStock)
  const centre = barCentre(store().project.stock as SquareStock)
  for (const id of [result.roughOperationId, result.finishOperationId]) {
    const operation = store().project.operations.find((entry) => entry.id === id)!
    const envelope = computeOperationToolpath(store().project, operation)
    assert.ok(envelope, `${operation.kind}: the engine answers`)
    if (!envelope) throw new Error('unreachable')
    assert.ok(envelope.result.moves.length > 0, `${operation.kind}: nonempty motion on the square blank`)
    assert.ok(
      !envelope.result.warnings.some((warning) => warning.code === 'aroundStockMismatch'),
      `${operation.kind}: admitted, not refused as a shape/setup mismatch`,
    )
    for (const move of envelope.result.moves) {
      for (const point of [move.from, move.to]) {
        assert.ok(point.a !== undefined, `${operation.kind}: every endpoint carries A`)
        assert.equal(point.y, centre, `${operation.kind}: across stays on the true pivot`)
        assert.ok(point.z >= pivot - 1e-9, `${operation.kind}: never cuts below the pivot`)
      }
    }
  }
}

// ── undo and redo restore the square blank and the model ──────

log('Testing one undo and redo on the square blank...')
{
  const project = loadSquare(MM_X, [cutter('mm', 'ball')])
  const stockBefore = structuredClone(project.stock)
  const bounds = getStockBounds(project.stock)
  const result = store().addRotarySolid({
    ...SQUARE_TO_ROUND,
    diameter: 24,
    alongStart: bounds.minX + 20,
    alongEnd: bounds.minX + 80,
    toolRef: 'ball',
  })
  assert.ok(result.ok, 'created')
  if (!result.ok) throw new Error('unreachable')
  const after = store().project
  const assetId = after.featureDefinitions[after.features[0].definitionId].stl!.meshAssetId!

  store().undo()
  const undone = store().project
  assert.equal(undone.features.length, 0, 'undo removes the model')
  assert.equal(undone.featureFolders.length, 0, 'undo removes the folder')
  assert.equal(undone.operations.length, 0, 'undo removes both operations')
  assert.equal(undone.modelAssets?.[assetId], undefined, 'undo removes the asset')
  assert.deepEqual(undone.stock, stockBefore, 'undo leaves the square blank as it was')
  assert.equal(activeFace(undone), 'around', 'undo keeps the real Around setup in view')

  store().redo()
  const redone = store().project
  assert.equal(redone.features.length, 1, 'redo restores the model')
  assert.equal(redone.operations.length, 2, 'redo restores both operations')
  assert.ok(redone.modelAssets?.[assetId], 'redo restores the asset')
  assert.deepEqual(redone.stock, stockBefore, 'redo never touches the blank')
}

// ── creation inside an outer history transaction ──────────────

log('Testing creation inside an outer transaction on the real square setup...')
{
  const project = loadSquare(MM_X, [cutter('mm', 'ball')])
  const bounds = getStockBounds(project.stock)
  const stockBefore = structuredClone(project.stock)
  const snapBefore = project.grid.snapIncrement
  const featuresBefore = project.features.length
  const operationsBefore = project.operations.length
  const historyBefore = store().history.past.length

  store().beginHistoryTransaction()
  store().setGrid({ ...store().project.grid, snapIncrement: snapBefore * 2 })
  const result = store().addRotarySolid({
    ...SQUARE_TO_ROUND,
    diameter: 24,
    alongStart: bounds.minX + 20,
    alongEnd: bounds.minX + 80,
    toolRef: 'ball',
  })
  assert.ok(result.ok, `created inside the transaction (${result.ok ? '' : result.reason})`)
  if (!result.ok) throw new Error('unreachable')
  const assetId = store().project.featureDefinitions[
    store().project.features.find((entry) => entry.id === result.featureId)!.definitionId
  ].stl!.meshAssetId!

  assert.ok(store().history.transactionStart, 'the transaction is still open after the creation')
  assert.equal(store().history.past.length, historyBefore, 'the creation adds no snapshot inside a transaction')
  assert.equal(store().project.operations.length, operationsBefore + 2, 'both operations exist before the commit')

  store().commitHistoryTransaction()
  assert.equal(store().history.past.length, historyBefore + 1, 'the commit owns exactly one snapshot')

  store().undo()
  const undone = store().project
  assert.equal(undone.grid.snapIncrement, snapBefore, 'undo restores the prior grid edit')
  assert.equal(undone.features.length, featuresBefore, 'undo removes the model')
  assert.equal(undone.operations.length, operationsBefore, 'undo removes both operations')
  assert.equal(undone.featureFolders.length, 0, 'undo removes the folder')
  assert.equal(undone.modelAssets?.[assetId], undefined, 'undo removes the asset')
  assert.deepEqual(undone.stock, stockBefore, 'undo leaves the blank as it was')
  assert.equal(activeSetup(undone).id, 'square-around', 'undo keeps the real Around setup in view')
  assert.equal(store().history.future.length, 1, 'the combined step is redoable')

  store().redo()
  const redone = store().project
  assert.equal(redone.grid.snapIncrement, snapBefore * 2, 'redo restores the grid edit')
  assert.equal(redone.features.length, featuresBefore + 1, 'redo restores the model')
  assert.equal(redone.operations.length, operationsBefore + 2, 'redo restores both operations')
  assert.ok(redone.modelAssets?.[assetId], 'redo restores the asset')
  assert.deepEqual(redone.stock, stockBefore, 'redo never touches the blank')
}

log('Testing a refused creation leaves an open transaction alone...')
{
  loadSquare(MM_X, [cutter('mm', 'ball')])
  const bounds = getStockBounds(store().project.stock)
  const snapBefore = store().project.grid.snapIncrement
  store().beginHistoryTransaction()
  store().setGrid({ ...store().project.grid, snapIncrement: 3 })
  const projectAfterEdit = store().project
  const selectionAfterEdit = store().selection
  const dirtyAfterEdit = store().dirty
  const historyAfterEdit = store().history.past.length
  const transactionStart = store().history.transactionStart
  assert.ok(transactionStart, 'the transaction is open')

  const refused = store().addRotarySolid({ ...SQUARE_TO_ROUND, diameter: 41, alongStart: bounds.minX + 20, alongEnd: bounds.minX + 80, toolRef: 'ball' })
  assert.equal(refused.ok, false, 'the bad input is refused')
  assert.equal(store().history.transactionStart, transactionStart, 'the transaction snapshot is unchanged')
  assert.equal(store().project, projectAfterEdit, 'the project is unchanged')
  assert.equal(store().selection, selectionAfterEdit, 'the selection is unchanged')
  assert.equal(store().dirty, dirtyAfterEdit, 'dirtiness is unchanged')
  assert.equal(store().history.past.length, historyAfterEdit, 'no snapshot was added')

  store().cancelHistoryTransaction()
  assert.equal(store().project.grid.snapIncrement, snapBefore, 'the untouched transaction still cancels cleanly')
}

// ── refusals and the ordinary-edit contract ───────────────────

log('Testing refusals, the wrong stock shape and ordinary model editing...')
{
  const project = loadSquare(MM_X, [cutter('mm', 'ball')])
  const bounds = getStockBounds(project.stock)
  const base = {
    ...SQUARE_TO_ROUND,
    diameter: 24,
    alongStart: bounds.minX + 20,
    alongEnd: bounds.minX + 80,
    toolRef: 'ball',
  }
  const before = store().project
  const selectionBefore = store().selection
  const dirtyBefore = store().dirty
  const historyBefore = store().history.past.length

  const refusals: Array<[string, () => { ok: boolean }]> = [
    ['descending along range', () => store().addRotarySolid({ ...base, alongStart: bounds.minX + 80, alongEnd: bounds.minX + 20 })],
    ['along range outside the blank', () => store().addRotarySolid({ ...base, alongEnd: bounds.maxX + 10 })],
    ['non-finite along range', () => store().addRotarySolid({ ...base, alongStart: NaN })],
    ['missing tool', () => store().addRotarySolid({ ...base, toolRef: 'nope' })],
    ['diameter above the side', () => store().addRotarySolid({ ...base, diameter: 41 })],
  ]
  for (const [label, run] of refusals) {
    const refused = run()
    assert.equal(refused.ok, false, `${label} is refused`)
    assert.equal(store().project, before, `${label} leaves the project untouched`)
    assert.equal(store().selection, selectionBefore, `${label} leaves the selection untouched`)
    assert.equal(store().dirty, dirtyBefore, `${label} leaves dirtiness untouched`)
    assert.equal(store().history.past.length, historyBefore, `${label} adds no history entry`)
  }

  // Square-to-round needs a square blank: on a round bar it is refused.
  const roundBase = newProject('Round', 'mm')
  roundBase.meta.projectType = 'rotary'
  roundBase.stock = roundStock(40, 200, 'x', { x: 10, y: 30 })
  const machine = rotaryMachine('x')
  roundBase.meta.machineDefinitions = [machine]
  roundBase.meta.selectedMachineId = machine.id
  roundBase.tools = [cutter('mm', 'ball')]
  roundBase.setups.push({
    ...roundBase.setups[0],
    id: 'round-around',
    name: 'Around',
    kind: 'around',
    orientation: { axis: 'x', angleDeg: 0 },
  })
  roundBase.activeSetupId = 'round-around'
  store().loadProject(projectWithFeatures(roundBase, []))
  assert.equal(activeFace(store().project), 'around', 'the round project is on Around')
  assert.equal(
    refusalReason(store().addRotarySolid({ ...base })),
    'needsSquareBar',
    'a round bar is refused for square-to-round',
  )

  store().loadProject(newProject('Milling', 'mm'))
  assert.equal(refusalReason(store().addRotarySolid({ ...base })), 'notRotaryProject', 'a non-rotary project is refused')

  // A provisional Around setup cannot be realised on a square blank: the
  // store's reconciler would discard the write, so the plan refuses instead of
  // reporting success. The state is unreachable through the store's own face
  // switcher today, so it is driven through the pure plan directly.
  loadSquare(MM_X, [cutter('mm', 'ball')])
  const provisional = { ...store().project, activeSetupId: provisionalSetupId('around') }
  assert.equal(
    refusalReason(planRotarySolid(provisional, store().selection, {
      ...SQUARE_TO_ROUND,
      diameter: 24,
      alongStart: bounds.minX + 20,
      alongEnd: bounds.minX + 80,
      toolRef: 'ball',
    })),
    'provisionalAroundUnsupported',
    'a provisional Around setup is refused for square-to-round',
  )

  // A created model is an ordinary feature: renaming it is an ordinary edit.
  loadSquare(MM_X, [cutter('mm', 'ball')])
  const created = store().addRotarySolid({
    ...SQUARE_TO_ROUND,
    diameter: 24,
    alongStart: getStockBounds(store().project.stock).minX + 20,
    alongEnd: getStockBounds(store().project.stock).minX + 80,
    toolRef: 'ball',
  })
  assert.ok(created.ok, 'created')
  if (!created.ok) throw new Error('unreachable')
  store().updateFeature(created.featureId, { name: 'Renamed target' })
  const renamed = store().project.features.find((entry) => entry.id === created.featureId)!
  assert.equal(renamed.name, 'Renamed target', 'the model renames like any ordinary feature')
  assert.equal(renamed.definitionId !== undefined, true, 'and keeps its definition reference')
}

/** A round bar with the same box as the square fixtures, for the shape refusal. */
log('rotarySolidStore: all assertions passed.')

/**
 * Guard sites outside this file, reported and not edited here (the engine /
 * UI slices own them): `activeFace.ts`'s `aroundUnavailableReason` still
 * answers `needsRoundBar` for a square blank and the face switcher still
 * refuses to enter Around; `operationValidity.ts`, the CSG / overlay readers
 * and the simulation setup still branch on `isRoundStock`. The engine
 * production seam (`setupGenerationBlock` → `generateRotaryOperation`) and the
 * output planner (`motionPipeline.ts`) now admit the square blank; the
 * physical workholding / ordinary-clamp guard and the refusal severity live in
 * `squareRotarySafety.ts` and `warningCodes.ts`.
 */
