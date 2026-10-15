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
 * Canned Thread and Flutes store flow (issue #1016 C1 slice A).
 *
 * Mutations checked one at a time against these assertions:
 * - the starts multiplier omitted from the lead → "a two-start thread advances
 *   the lead per turn" fails;
 * - the start offset dropped (all starts on the zero line) → "starts sit C/n
 *   apart" fails;
 * - the X/Y mapping swapped → the Y-bar along/across assertions fail;
 * - the new lines not stamped `authoringFace: 'around'` → "the setup is made
 *   real in the same step" and the seam generation fail;
 * - the operation left on the provisional setup id after the write → "the
 *   operation joins a real Around setup" fails;
 * - a depth at the radius accepted → "a depth reaching the centreline is
 *   refused" fails;
 * - creation split across two `set` calls → "one undo removes everything"
 *   fails;
 * - the parameter records serialized → the "no input fields persisted"
 *   assertions fail.
 *
 * Run with: npx tsx src/store/rotaryPatterns.test.ts
 */

import assert from 'node:assert/strict'
import { defaultTool, getStockBounds, newProject, roundStock } from '../types/project'
import type { Project, SketchFeature, Tool } from '../types/project'
import type { ToolLibraryEntry } from '../toolLibrary'
import { bundledMachines } from '../machine/registry'
import { projectWithFeatures } from '../test/projectFixtures'
import { computeOperationToolpath } from '../engine/toolpaths/generateOperation'
import { normalizeToolForProject } from '../engine/toolpaths/geometry'
import { runPostProcessor } from '../engine/gcode/postprocessor'
import { rotaryWord, validateMachineDefinition } from '../engine/gcode/types'
import type { MachineDefinition } from '../engine/gcode/types'
import { warningSeverity } from '../engine/toolpaths/warningCodes'
import { activeFace, activeSetup, aroundUnavailableReason } from './helpers/activeFace'
import { provisionalSetupId } from './helpers/provisionalSetup'
import { rotaryPatternFrame } from './helpers/rotaryPatterns'
import { useProjectStore } from './projectStore'
import { switchWorkspaceFace } from './workspaceFace'

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
}

const MM_BAR: BarSpec = { axis: 'x', units: 'mm', at: { x: 10, y: 30 } }
const INCH_BAR: BarSpec = { axis: 'y', units: 'inch', at: { x: 3, y: 5 } }

function barStock(spec: BarSpec): ReturnType<typeof roundStock> {
  return spec.axis === 'x' ? roundStock(40, 200, 'x', spec.at) : roundStock(2, 8, 'y', spec.at)
}

function rotaryMachine(axis: 'x' | 'y', drive: 'own' | 'borrowed', reversed = false): MachineDefinition {
  const base = structuredClone(bundledMachines()[0])
  return validateMachineDefinition({
    ...base,
    id: `around-${axis}-${drive}${reversed ? '-rev' : ''}`,
    rotary: { about: axis, drive, reversed, inverseTimeFeed: { on: 'G93', off: 'G94' } },
  })
}

function vBit(units: 'mm' | 'inch', id: string): Tool {
  return {
    ...defaultTool(units, 1),
    id,
    name: `${id} 60 V-bit`,
    units,
    type: 'v_bit',
    diameter: units === 'mm' ? 6 : 0.25,
    vBitAngle: 60,
    // 0 means no declared ceiling, so a thread is never warned about its depth.
    maxCutDepth: 0,
    defaultStepdown: units === 'mm' ? 0.4 : 0.02,
    defaultFeed: units === 'mm' ? 600 : 24,
    defaultPlungeFeed: units === 'mm' ? 200 : 8,
  }
}

function vBitLibrary(units: 'mm' | 'inch'): ToolLibraryEntry {
  const { id: _id, ...entry } = vBit(units, 'library')
  void _id
  return { ...entry, key: `vbit-${units}` }
}

/** A rotary project with the given tools, loaded and switched onto Around. */
function loadRotary(spec: BarSpec, tools: Tool[]): Project {
  const base = newProject(`Patterns ${spec.axis}`, spec.units)
  base.meta.projectType = 'rotary'
  base.stock = barStock(spec)
  const machine = rotaryMachine(spec.axis, 'own')
  base.meta.machineDefinitions = [machine]
  base.meta.selectedMachineId = machine.id
  base.tools = tools
  const project = projectWithFeatures(base, [])
  store().loadProject(project)
  assert.equal(switchWorkspaceFace('around'), true, 'the workspace enters Around')
  return store().project
}

function resetStore(project: Project): void {
  store().loadProject(project)
}

const createdFeature = (id: string): SketchFeature => {
  const feature = store().project.features.find((entry) => entry.id === id)
  assert.ok(feature, `feature ${id} exists`)
  const definition = store().project.featureDefinitions[feature.definitionId]
  assert.ok(definition, `definition for ${id} exists`)
  return {
    ...(feature as unknown as SketchFeature),
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

/** The flat cut levels the generator documents: from `topZ` down to `finalZ` by `stepdown`. */
function carveLevels(topZ: number, finalZ: number, stepdown: number): number[] {
  const levels: number[] = []
  let z = topZ
  while (z > finalZ) {
    z = Math.max(finalZ, z - stepdown)
    levels.push(z)
    if (z <= finalZ) break
  }
  return levels.length > 0 ? levels : [finalZ]
}

// ── thread creation ───────────────────────────────────────────

log('Testing thread creation, geometry and the one-step setup...')
{
  loadRotary(MM_BAR, [vBit('mm', 'v1')])
  const frame = rotaryPatternFrame(store().project)!
  const before = store().project
  const historyBefore = store().history.past.length
  const result = store().addRotaryPattern({ kind: 'thread', start: 25, length: 60, pitch: 2, starts: 1, depth: 1.2 })

  assert.ok(result.ok, `thread created (${result.ok ? '' : result.reason})`)
  if (!result.ok) throw new Error('unreachable')
  assert.equal(result.featureIds.length, 1, 'one line for a single start')
  assert.equal(store().history.past.length, historyBefore + 1, 'exactly one history entry')

  const project = store().project
  const folder = project.featureFolders.find((entry) => entry.id === result.folderId)
  assert.ok(folder, 'the folder exists')
  assert.equal(folder.name, 'Thread', 'the folder is named after the thread')
  assert.equal(folder.section, 'features', 'the folder is an ordinary features folder')
  assert.notEqual(folder.grouped, true, 'the folder is not a grouped composite')

  const feature = createdFeature(result.featureIds[0])
  assert.equal(feature.folderId, result.folderId, 'the line is inside the folder')
  assert.equal(feature.operation, 'line', 'the line is an ordinary line feature')
  assert.equal(feature.authoringFace, 'around', 'the line is authored on Around')
  assert.equal(feature.sketch.profile.closed, false, 'the line is open')
  assert.equal(feature.sketch.profile.segments.length, 1, 'the line is one segment')
  assert.equal(feature.z_top, project.stock.thickness, 'z_top is the bar surface')
  near(feature.z_bottom, project.stock.thickness - 1.2, 'z_bottom is the requested depth below the surface')

  // Sheet geometry: along is the bar axis, across is the other one and starts
  // on the centered zero line.
  const start = feature.sketch.profile.start
  const end = (feature.sketch.profile.segments[0] as { to: { x: number; y: number } }).to
  const bounds = getStockBounds(project.stock)
  near(start.x, bounds.minX + 25, 'along start measured from the stock minimum')
  near(end.x, bounds.minX + 25 + 60, 'along end is start + length')
  near(start.y, frame.zero, 'a single start begins on the zero line')
  near(end.y - start.y, frame.circumference * 60 / 2, 'one circumference per pitch along')

  const operation = project.operations.find((entry) => entry.id === result.operationId)
  assert.ok(operation, 'the operation exists')
  assert.equal(project.operations.length, 1, 'exactly one operation created')
  assert.equal(operation.kind, 'follow_line', 'an Engrave operation')
  assert.equal(operation.pass, 'rough', 'cut in stepdown passes')
  assert.equal(operation.target.source, 'features', 'the Engrave targets features')
  assert.deepEqual(operation.target.featureIds, result.featureIds, 'the Engrave targets exactly the created lines')
  assert.equal(operation.toolRef, 'v1', 'the existing V-bit is used')
  near(operation.carveDepth, 1.2, 'the Engrave cuts to the requested depth')
  assert.ok((operation.stepdown ?? 0) > 0, 'the Engrave has a positive stepdown')

  const setup = activeSetup(project)
  assert.equal(setup.kind, 'around', 'the workspace stays on Around')
  assert.notEqual(setup.id, provisionalSetupId('around'), 'the provisional setup is made real in the same step')
  assert.equal(operation.setupId, setup.id, 'the operation joins the real Around setup')
  assert.ok(project.setups.some((entry) => entry.id === setup.id && entry.kind === 'around'), 'the setup is stored')
  assert.deepEqual(activeFace(project), 'around')

  // The input numbers are not stored: nothing but ordinary shapes.
  const serialized = JSON.stringify({ folder, features: project.features, definitions: project.featureDefinitions, operation })
  for (const field of ['"pitch"', '"starts"', '"twist"', '"length"', 'threadParams', 'fluteParams']) {
    assert.ok(!serialized.includes(field), `${field} is not persisted`)
  }
  const rawInstance = project.features.find((entry) => entry.id === result.featureIds[0])!
  assert.deepEqual(
    Object.keys(rawInstance).sort(),
    ['authoringFace', 'constraints', 'definitionId', 'folderId', 'id', 'locked', 'name', 'textLayout', 'transform', 'visible', 'z_bottom', 'z_top'].sort(),
    'the line instance has exactly the ordinary instance shape',
  )

  // One undo removes everything; redo restores it.
  store().undo()
  const undone = store().project
  assert.equal(undone.features.length, 0, 'undo removes the line')
  assert.equal(undone.featureFolders.length, 0, 'undo removes the folder')
  assert.equal(undone.operations.length, 0, 'undo removes the operation')
  assert.equal(undone.tools.length, 1, 'undo removes no pre-existing tool')
  assert.equal(activeFace(undone), 'around', 'undo leaves the workspace on Around')
  store().redo()
  assert.equal(store().project.features.length, 1, 'redo restores the line')
  assert.equal(store().project.featureFolders.length, 1, 'redo restores the folder')
  assert.equal(store().project.operations.length, 1, 'redo restores the operation')

  // A refused creation changes nothing at all.
  const refusedBefore = store().project
  const refusedHistory = store().history.past.length
  const refused = store().addRotaryPattern({ kind: 'thread', start: 0, length: 10, pitch: 2, depth: frame.radius })
  assert.equal(refused.ok, false, 'a depth at the radius is refused')
  assert.equal(refused.ok === false && refused.reason, 'depthReachesCentreline', 'with the centreline reason')
  assert.equal(store().project, refusedBefore, 'a refusal does not touch the project')
  assert.equal(store().history.past.length, refusedHistory, 'a refusal adds no history')
  resetStore(before)
}

// ── multi-start thread, off-origin geometry ───────────────────

log('Testing multi-start lead, start spacing and the Y/inch sheet...')
{
  loadRotary(MM_BAR, [vBit('mm', 'v1')])
  const frame = rotaryPatternFrame(store().project)!
  const result = store().addRotaryPattern({ kind: 'thread', start: 40, length: 30, pitch: 1.25, starts: 2, depth: 1 })
  assert.ok(result.ok, 'two-start thread created')
  if (!result.ok) throw new Error('unreachable')
  assert.equal(result.featureIds.length, 2, 'one line per start')
  const lines = result.featureIds.map((id) => createdFeature(id).sketch.profile)
  const across = lines.map((line) => line.start.y)
  near(across[1] - across[0], frame.circumference / 2, 'starts sit C/n apart')
  for (const line of lines) {
    const end = (line.segments[0] as { to: { x: number; y: number } }).to
    near(Math.abs(end.y - line.start.y), frame.circumference * 30 / (2 * 1.25), 'a two-start thread advances the lead per turn')
  }
  const operation = store().project.operations.at(-1)!
  assert.deepEqual(operation.target.featureIds, result.featureIds, 'both starts are one Engrave target')

  // Y bar, inch, off-origin: along is Y (from the stock minimum), across is X
  // and starts on the centered zero line.
  loadRotary(INCH_BAR, [vBit('inch', 'vi')])
  const inchFrame = rotaryPatternFrame(store().project)!
  const inchResult = store().addRotaryPattern({ kind: 'thread', start: 1.5, length: 3, pitch: 0.05, depth: 0.1 })
  assert.ok(inchResult.ok, 'inch Y-bar thread created')
  if (!inchResult.ok) throw new Error('unreachable')
  const inchFeature = createdFeature(inchResult.featureIds[0])
  const inchBounds = getStockBounds(store().project.stock)
  near(inchFeature.sketch.profile.start.y, inchBounds.minY + 1.5, 'Y bar along start is measured from the stock minimum')
  near(inchFeature.sketch.profile.start.x, inchFrame.zero, 'Y bar across starts on the centered zero line')
  const inchEnd = (inchFeature.sketch.profile.segments[0] as { to: { x: number; y: number } }).to
  near(inchEnd.y, inchBounds.minY + 1.5 + 3, 'Y bar along end is start + length')
  near(inchEnd.x - inchFeature.sketch.profile.start.x, -inchFrame.circumference * 3 / 0.05, 'the Y bar right-hand slope runs the other way across')
  // The right-hand chirality itself is re-derived from physical points in
  // helpers/rotaryPatterns.test.ts, on both axes.

  // A user-specified line may run past the end of the bar: it is not clipped.
  loadRotary(MM_BAR, [vBit('mm', 'v1')])
  const barBounds = getStockBounds(store().project.stock)
  const overrun = store().addRotaryPattern({ kind: 'thread', start: 195, length: 20, pitch: 2, depth: 1 })
  assert.ok(overrun.ok, 'an overrunning thread is created')
  if (!overrun.ok) throw new Error('unreachable')
  const overrunProfile = createdFeature(overrun.featureIds[0]).sketch.profile
  const overrunEnd = (overrunProfile.segments[0] as { to: { x: number; y: number } }).to
  near(overrunProfile.start.x, barBounds.minX + 195, 'the overrunning line starts where asked')
  near(overrunEnd.x, barBounds.minX + 195 + 20, 'and keeps its requested length past the bar end')
  assert.ok(overrunEnd.x > barBounds.maxX, 'the geometry really does extend past the bar')
}

// ── flutes ────────────────────────────────────────────────────

log('Testing flutes: count, twist, straight and tool selection...')
{
  loadRotary(MM_BAR, [vBit('mm', 'v1'), { ...vBit('mm', 'ball'), id: 'ball', name: 'ball', type: 'ball_endmill', diameter: 3 }])
  const frame = rotaryPatternFrame(store().project)!
  const result = store().addRotaryPattern({ kind: 'flutes', start: 20, length: 50, count: 4, twist: 1.5, depth: 0.8, toolRef: 'ball' })
  assert.ok(result.ok, 'flutes created')
  if (!result.ok) throw new Error('unreachable')
  assert.equal(result.featureIds.length, 4, 'one line per flute')
  const folder = store().project.featureFolders.find((entry) => entry.id === result.folderId)
  assert.equal(folder?.name, 'Flutes', 'the folder is named after the flutes')
  const starts = result.featureIds.map((id) => createdFeature(id).sketch.profile.start.y)
  for (let index = 1; index < starts.length; index++) {
    near(starts[index] - starts[index - 1], frame.circumference / 4, 'flutes sit C/count apart')
  }
  for (const id of result.featureIds) {
    const profile = createdFeature(id).sketch.profile
    const end = (profile.segments[0] as { to: { x: number; y: number } }).to
    near(Math.abs(end.y - profile.start.y), 1.5 * frame.circumference, 'each flute spans twist*C across')
  }
  const operation = store().project.operations.at(-1)!
  assert.equal(operation.toolRef, 'ball', 'the explicitly selected tool is used')
  assert.equal(operation.kind, 'follow_line', 'flutes cut with an Engrave')
  assert.deepEqual(operation.target.featureIds, result.featureIds, 'all flutes are one target')

  // Straight flutes stay on their own meridian, negative twist reverses.
  const straight = store().addRotaryPattern({ kind: 'flutes', start: 0, length: 20, count: 2, twist: 0, depth: 0.5, toolRef: 'ball' })
  assert.ok(straight.ok, 'straight flutes created')
  if (!straight.ok) throw new Error('unreachable')
  for (const id of straight.featureIds) {
    const profile = createdFeature(id).sketch.profile
    const end = (profile.segments[0] as { to: { x: number; y: number } }).to
    near(end.y, profile.start.y, 'a straight flute keeps its across coordinate')
  }
  const reversed = store().addRotaryPattern({ kind: 'flutes', start: 0, length: 20, count: 1, twist: -1, depth: 0.5, toolRef: 'ball' })
  assert.ok(reversed.ok, 'negative-twist flute created')
  if (!reversed.ok) throw new Error('unreachable')
  const reversedProfile = createdFeature(reversed.featureIds[0]).sketch.profile
  const reversedEnd = (reversedProfile.segments[0] as { to: { x: number; y: number } }).to
  near(reversedEnd.y - reversedProfile.start.y, -frame.circumference, 'negative twist reverses the across direction')
}

// ── refusals and tool resolution ──────────────────────────────

log('Testing refusals, V-bit resolution and imported tools...')
{
  // No V-bit anywhere: refuse atomically.
  loadRotary(MM_BAR, [])
  const before = store().project
  const historyBefore = store().history.past.length
  const noTool = store().addRotaryPattern({ kind: 'thread', start: 0, length: 20, pitch: 1, depth: 1 })
  assert.equal(noTool.ok, false, 'a thread without a V-bit is refused')
  assert.equal(noTool.ok === false && noTool.reason, 'noVBitTool', 'with the V-bit reason')
  assert.equal(store().project, before, 'the refusal does not touch the project')
  assert.equal(store().history.past.length, historyBefore, 'the refusal adds no history')

  // The same thread imports the bundled V-bit in the same undo step.
  const imported = store().addRotaryPattern({ kind: 'thread', start: 0, length: 20, pitch: 1, depth: 1 }, [vBitLibrary('mm')])
  assert.ok(imported.ok, 'the library V-bit is imported')
  if (!imported.ok) throw new Error('unreachable')
  assert.equal(store().history.past.length, historyBefore + 1, 'the import is part of the same history step')
  const importedTool = store().project.tools.find((tool) => tool.id === store().project.operations[0].toolRef)
  assert.equal(importedTool?.type, 'v_bit', 'the operation carries the imported V-bit')
  store().undo()
  assert.equal(store().project.tools.length, 0, 'one undo removes the imported tool too')

  // Flutes: missing and incompatible tools refuse.
  loadRotary(MM_BAR, [{ ...vBit('mm', 'v1'), id: 'plasma', type: 'plasma' } as Tool])
  const missing = store().addRotaryPattern({ kind: 'flutes', start: 0, length: 10, count: 1, twist: 0, depth: 0.5, toolRef: 'nope' })
  assert.equal(missing.ok === false && missing.reason, 'toolNotFound', 'an unknown tool is refused')
  const incompatible = store().addRotaryPattern({ kind: 'flutes', start: 0, length: 10, count: 1, twist: 0, depth: 0.5, toolRef: 'plasma' })
  assert.equal(incompatible.ok === false && incompatible.reason, 'toolIncompatible', 'a plasma torch is refused')

  // Creation away from an available Around leaves state untouched.
  loadRotary(MM_BAR, [vBit('mm', 'v1')])
  store().setActiveSetup(store().project.setups.find((setup) => setup.id !== undefined && setup.kind !== 'around')?.id ?? provisionalSetupId('top'))
  assert.notEqual(activeFace(store().project), 'around', 'the fixture is away from Around')
  const awayBefore = store().project
  const away = store().addRotaryPattern({ kind: 'thread', start: 0, length: 10, pitch: 1, depth: 0.5 })
  assert.equal(away.ok === false && away.reason, 'aroundNotActive', 'creation away from Around is refused')
  assert.equal(store().project, awayBefore, 'and leaves the project untouched')

  // A milling project has no Around at all.
  const milling = newProject('Milling', 'mm')
  store().loadProject(milling)
  const unavailable = store().addRotaryPattern({ kind: 'thread', start: 0, length: 10, pitch: 1, depth: 0.5 })
  assert.equal(unavailable.ok === false && unavailable.reason, 'aroundUnavailable', 'a non-rotary project is refused')
  resetStore(newProject())
}

// ── the real generation and export seam ───────────────────────

log('Testing generation and export through the real seam...')
{
  for (const [label, axis, units, spec, pitch, length] of [
    ['mm X', 'x', 'mm', MM_BAR, 2, 60],
    ['inch Y', 'y', 'inch', INCH_BAR, 0.05, 3],
  ] as const) {
    loadRotary(spec, [vBit(units, 'v1')])
    const depth = units === 'mm' ? 1.2 : 0.1
    const created = store().addRotaryPattern({ kind: 'thread', start: 10, length, pitch, starts: 1, depth })
    assert.ok(created.ok, `${label}: thread created`)
    if (!created.ok) throw new Error('unreachable')
    const project = store().project
    const operation = project.operations[0]
    assert.equal(aroundUnavailableReason(project), null, `${label}: Around stays available`)

    const envelope = computeOperationToolpath(project, operation)
    assert.ok(envelope, `${label}: generation returns an envelope`)
    const path = envelope.result
    assert.ok(path.moves.length > 0, `${label}: nonempty moves`)
    assert.deepEqual(path.warnings, [], `${label}: no generation warnings`)
    assert.ok(path.moves.every((move) => move.from.a !== undefined && move.to.a !== undefined), `${label}: every point carries a`)

    const axisOf = (point: { x: number; y: number }) => (axis === 'x' ? point.x : point.y)
    let along = 0
    let swept = 0
    const cutZs: number[] = []
    for (const move of path.moves) {
      const deltaAlong = Math.abs(axisOf(move.to) - axisOf(move.from))
      if (deltaAlong > 1e-9 && move.kind !== 'rapid') {
        along += deltaAlong
        swept += Math.abs(move.to.a! - move.from.a!)
      }
      if (move.kind === 'cut') cutZs.push(move.to.z)
    }
    assert.ok(along > 0, `${label}: the path follows the bar`)
    near(swept / along, 360 / pitch, `${label}: 360 degrees per pitch along the bar`, 1e-6 * 360 / pitch)

    // Depth passes: the documented level rule, at the requested floor. Distinct
    // levels are grouped at a micron — the generator's last step can land one
    // ULP off the arithmetic floor and emit a near-duplicate final pass.
    const distinctCutZ = [...new Set(cutZs.map((z) => Math.round(z / 1e-6)))]
    const deepest = Math.min(...cutZs)
    near(deepest, project.stock.thickness - depth, `${label}: the deepest pass is the requested depth`, 1e-9)
    const expectedLevels = carveLevels(project.stock.thickness / 2, project.stock.thickness / 2 - depth, operation.stepdown ?? depth)
    assert.ok(expectedLevels.length > 1, `${label}: more than one documented pass`)
    assert.ok(cutZs.length > 1, `${label}: the thread is cut in depth passes`)
    assert.ok(distinctCutZ.length > 1, `${label}: the passes reach different depths`)
    assert.ok(distinctCutZ.length <= expectedLevels.length, `${label}: no more distinct levels than stepdown passes`)
    assert.ok(Math.max(...cutZs) < project.stock.thickness, `${label}: the first pass is below the surface`)

    // Safe retracts at or above the bar surface, and the last move retracts.
    const rapids = path.moves.filter((move) => move.kind === 'rapid')
    assert.ok(rapids.length > 0, `${label}: the path retracts`)
    for (const move of rapids) {
      assert.ok(move.to.z >= project.stock.thickness - 1e-9, `${label}: a rapid stays clear of the bar`)
    }
    assert.equal(path.moves.at(-1)!.kind, 'rapid', `${label}: the last move is a retract`)

    // Export through the real post-processor, own-A and borrowed motor.
    for (const [drive, definition] of [
      ['own', rotaryMachine(axis, 'own')],
      ['borrowed', rotaryMachine(axis, 'borrowed')],
    ] as const) {
      const tool = normalizeToolForProject(project.tools.find((entry) => entry.id === operation.toolRef)!, project)
      const exported = runPostProcessor({
        project,
        definition,
        operations: [{ operation, tool, toolpath: path }],
        options: { emitToolChanges: false, emitCoolant: false, programName: project.meta.name },
      })
      const rotaryRefusals = exported.warnings.filter((warning) => warning.code.startsWith('postRotary'))
      assert.deepEqual(rotaryRefusals, [], `${label}/${drive}: no rotary refusal`)
      assert.ok(exported.gcode.includes('G93'), `${label}/${drive}: turning cuts run in inverse time`)
      const word = rotaryWord(definition)
      assert.ok(word !== null, `${label}/${drive}: the machine has a rotary word`)
      const angles = [...exported.gcode.matchAll(new RegExp(`\\b${word}(-?[0-9.]+)`, 'g'))].map((match) => Number(match[1]))
      assert.ok(angles.some((angle) => Math.abs(angle) > 360), `${label}/${drive}: the program writes angles past one turn`)
    }

    // The same toolpath generates no warning at any severity.
    assert.deepEqual(path.warnings.filter((warning) => warningSeverity(warning.code) !== 'info'), [], `${label}: nothing above info`)
  }
}

log('All rotary pattern store tests passed.')
