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
 * - the imported V-bit converted with the library entry's own units instead of
 *   the project's → the cross-unit import tests fail;
 * - the rotary drive sign dropped (a reversed definition ignored) → the parsed
 *   export sign tests fail;
 * - a posted angle reduced modulo 360, or written under the wrong rotary word →
 *   the parsed lead tests fail;
 * - `direction: 'left'` ignored (the posted ratio sign not reversed) → the
 *   left-hand ratio assertion fails;
 * - an explicit `direction: 'right'` not identical to an omitted one → the
 *   paired byte-identity assertion fails.
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
import { normalizeToolForProject, resolveDimensionRef } from '../engine/toolpaths/geometry'
import { parseGcodeMotion } from '../engine/gcode/gcodeMotionParser'
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

const MM_AT = { x: 10, y: 30 }
const INCH_AT = { x: 3, y: 5 }
const MM_X_BAR: BarSpec = { axis: 'x', units: 'mm', at: MM_AT }
const MM_Y_BAR: BarSpec = { axis: 'y', units: 'mm', at: MM_AT }
const INCH_X_BAR: BarSpec = { axis: 'x', units: 'inch', at: INCH_AT }
const INCH_Y_BAR: BarSpec = { axis: 'y', units: 'inch', at: INCH_AT }
const MM_BAR = MM_X_BAR
const INCH_BAR = INCH_Y_BAR

function barStock(spec: BarSpec): ReturnType<typeof roundStock> {
  // The diameter and length follow the units, the orientation follows the axis.
  const [diameter, length] = spec.units === 'mm' ? [40, 200] : [2, 8]
  return roundStock(diameter, length, spec.axis, spec.at)
}

function barFor(axis: 'x' | 'y', units: 'mm' | 'inch'): BarSpec {
  if (axis === 'x') return units === 'mm' ? MM_X_BAR : INCH_X_BAR
  return units === 'mm' ? MM_Y_BAR : INCH_Y_BAR
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

/**
 * A bundled-library V-bit written in `units`, with every converted length
 * distinct from its same-unit twin so a wrong conversion target cannot hide
 * behind an equal number. `maxCutDepth` is deliberately non-zero: on the
 * library entry it is a real ceiling, so it must convert like any other length.
 */
function importVBit(units: 'mm' | 'inch', key: string): ToolLibraryEntry {
  const { id: _id, ...entry } = vBit(units, key)
  void _id
  return { ...entry, key, maxCutDepth: units === 'mm' ? 10 : 0.5 }
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
  near(resolveDimensionRef(project, feature.z_bottom), project.stock.thickness - 1.2, 'z_bottom is the requested depth below the surface')

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
  for (const field of ['"pitch"', '"starts"', '"twist"', '"length"', '"direction"', 'threadParams', 'fluteParams']) {
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
  assert.equal(operation.target.source, 'features', 'the multi-start Engrave targets features')
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
  assert.equal(operation.target.source, 'features', 'all flutes target features')
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

  // A bundled V-bit written in the other unit system is converted into the
  // project's units before it is stored, and the Engrave seeded from it is in
  // project units too (issue #1016 C1 A1). The library entry's own `units` must
  // never be the conversion target: doing that would store an inch tool in a mm
  // project (and vice versa), unscaled.
  const MM_PER_INCH = 25.4
  const crossUnit = [
    {
      label: 'inch library into an mm bar',
      spec: MM_BAR,
      libraryUnits: 'inch' as const,
      projectUnits: 'mm' as const,
      expected: {
        diameter: 0.25 * MM_PER_INCH,
        feed: 24 * MM_PER_INCH,
        plungeFeed: 8 * MM_PER_INCH,
        stepdown: 0.02 * MM_PER_INCH,
        maxCutDepth: 0.5 * MM_PER_INCH,
      },
      request: { start: 0, length: 20, pitch: 1, depth: 1 },
    },
    {
      label: 'mm library into an inch bar',
      spec: INCH_BAR,
      libraryUnits: 'mm' as const,
      projectUnits: 'inch' as const,
      expected: {
        diameter: 6 / MM_PER_INCH,
        feed: 600 / MM_PER_INCH,
        plungeFeed: 200 / MM_PER_INCH,
        stepdown: 0.4 / MM_PER_INCH,
        maxCutDepth: 10 / MM_PER_INCH,
      },
      request: { start: 0, length: 1, pitch: 0.05, depth: 0.05 },
    },
  ]
  for (const entry of crossUnit) {
    loadRotary(entry.spec, [])
    const stepBefore = store().history.past.length
    const result = store().addRotaryPattern(
      { kind: 'thread', ...entry.request },
      [importVBit(entry.libraryUnits, `cross-${entry.libraryUnits}`)],
    )
    assert.ok(result.ok, `${entry.label}: the library V-bit is imported`)
    if (!result.ok) throw new Error('unreachable')
    const project = store().project
    const operation = project.operations[0]
    const tool = project.tools.find((candidate) => candidate.id === operation.toolRef)
    assert.ok(tool, `${entry.label}: the imported tool is stored`)
    if (!tool) throw new Error('unreachable')
    assert.equal(tool.units, entry.projectUnits, `${entry.label}: the stored tool declares the project's units`)
    assert.equal(tool.type, 'v_bit', `${entry.label}: it is still a V-bit`)
    assert.equal(tool.vBitAngle, 60, `${entry.label}: the V angle is an angle, not a converted length`)
    near(tool.diameter, entry.expected.diameter, `${entry.label}: the diameter is converted into project units`)
    near(tool.defaultFeed, entry.expected.feed, `${entry.label}: the default feed is converted`)
    near(tool.defaultPlungeFeed, entry.expected.plungeFeed, `${entry.label}: the plunge feed is converted`)
    near(tool.defaultStepdown, entry.expected.stepdown, `${entry.label}: the stepdown is converted`)
    near(tool.maxCutDepth, entry.expected.maxCutDepth, `${entry.label}: the max cut depth is converted`)
    // The Engrave is seeded from the converted tool, so every length it carries
    // is in project units without a second conversion.
    near(operation.feed, entry.expected.feed, `${entry.label}: the operation feed is in project units`)
    near(operation.plungeFeed, entry.expected.plungeFeed, `${entry.label}: the operation plunge feed is in project units`)
    near(operation.stepdown, entry.expected.stepdown, `${entry.label}: the operation stepdown is in project units`)
    assert.equal(store().history.past.length, stepBefore + 1, `${entry.label}: the import is one history step`)
    store().undo()
    assert.equal(store().project.tools.length, 0, `${entry.label}: one undo removes the imported tool`)
    assert.equal(store().project.features.length, 0, `${entry.label}: and every created line`)
    assert.equal(store().project.operations.length, 0, `${entry.label}: and the Engrave operation`)
  }

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

// ── posted-program helpers ────────────────────────────────────

/**
 * `+1`/`-1`: what a positive physical angle is multiplied by on its way into
 * the program, restated from the definition's own fields — a reversed axis
 * flips it, and a borrowed motor riding a negated coordinate entry flips it
 * again. Deliberately not `rotaryDirection`: this is the expected value the
 * export is checked against, derived here rather than read back.
 */
function expectedDriveSign(definition: MachineDefinition): 1 | -1 {
  const rotary = definition.rotary
  assert.ok(rotary, 'the export machine has a rotary block')
  if (!rotary) throw new Error('unreachable')
  let sign: 1 | -1 = rotary.reversed ? -1 : 1
  if (rotary.drive === 'borrowed') {
    const entry = rotary.about === 'x' ? definition.coordinateSystem.yAxis : definition.coordinateSystem.xAxis
    if (entry.startsWith('-')) sign = sign === 1 ? -1 : 1
  }
  return sign
}

/**
 * `+1`/`-1`: the machine along coordinate's sign against the physical along
 * direction. Project X is physical X, but project Y is physical −Y (the project
 * frame is Y-down), so a machine Y delta is already the physical along delta. A
 * negated coordinate entry flips either.
 */
function alongAxisSign(axis: 'x' | 'y', definition: MachineDefinition): 1 | -1 {
  const entry = axis === 'x' ? definition.coordinateSystem.xAxis : definition.coordinateSystem.yAxis
  assert.equal(entry, axis.toUpperCase(), `the bar's along axis maps to machine ${axis.toUpperCase()}`)
  return entry.startsWith('-') ? -1 : 1
}

/**
 * Create one thread through the store, generate it, export it, and read the
 * literal program back with the motion parser. Every value the assertions use
 * comes from the text (or from the definition's own fields), never from the
 * toolpath the post-processor was handed.
 */
function assertExportedHelix(
  axis: 'x' | 'y',
  units: 'mm' | 'inch',
  drive: 'own' | 'borrowed',
  reversed: boolean,
  starts: number,
  direction?: 'right' | 'left',
): string {
  const spec = barFor(axis, units)
  const pitch = units === 'mm' ? 2 : 0.05
  const depth = units === 'mm' ? 1.2 : 0.1
  const start = units === 'mm' ? 10 : 1
  const length = units === 'mm' ? 60 : 3
  const label = `${axis}/${units}/${drive}${reversed ? '/reversed' : ''}/starts=${starts}${direction ? `/${direction}` : ''}`

  loadRotary(spec, [vBit(units, 'v1')])
  const created = store().addRotaryPattern(
    direction
      ? { kind: 'thread', start, length, pitch, starts, depth, direction }
      : { kind: 'thread', start, length, pitch, starts, depth },
  )
  assert.ok(created.ok, `${label}: thread created`)
  if (!created.ok) throw new Error('unreachable')
  const project = store().project
  const operation = project.operations[0]
  const envelope = computeOperationToolpath(project, operation)
  assert.ok(envelope, `${label}: generation returns an envelope`)
  if (!envelope) throw new Error('unreachable')
  const path = envelope.result
  assert.deepEqual(path.warnings, [], `${label}: no generation warnings`)

  const definition = rotaryMachine(axis, drive, reversed)
  const tool = normalizeToolForProject(project.tools.find((entry) => entry.id === operation.toolRef)!, project)
  const exported = runPostProcessor({
    project,
    definition,
    operations: [{ operation, tool, toolpath: path }],
    options: { emitToolChanges: false, emitCoolant: false, programName: project.meta.name },
  })
  const rotaryRefusals = exported.warnings.filter((warning) => warning.code.startsWith('postRotary'))
  assert.deepEqual(rotaryRefusals, [], `${label}: no rotary refusal`)
  assert.ok(exported.gcode.includes('G93'), `${label}: turning cuts run in inverse time`)
  // Nothing nonfinite reached the text at all.
  assert.doesNotMatch(exported.gcode, /NaN|Infinity|undefined/, `${label}: no nonfinite token in the program`)

  // The letter the rotation is posted under, derived from the drive alone.
  const word: 'A' | 'X' | 'Y' = drive === 'own' ? 'A' : axis === 'x' ? 'Y' : 'X'
  assert.equal(rotaryWord(definition), word, `${label}: the machine posts the rotation under ${word}`)

  // Read the literal program back: modal coordinates, and the angle under the
  // independently expected rotary word.
  const parsed = parseGcodeMotion(
    exported.gcode,
    definition.motion.arcFormat,
    definition.program.commentPrefix,
    definition.program.commentSuffix,
    { word, inverseTimeFeed: definition.rotary?.inverseTimeFeed ?? null },
  )
  // The helix ends at a non-zero angle, so the program carries the closing
  // machine-coordinate retract (#1054 fix 2). A G53 block is not a work
  // position, so the parse is not reported as verified (#1054 fix 4); every
  // other block must still reconstruct.
  assert.equal(parsed.status, 'unsupported', `${label}: the program parses around the machine retract (${parsed.warnings.join('; ')})`)
  assert.ok(
    parsed.warnings.length > 0 && parsed.warnings.every((warning) => warning.includes('G53')),
    `${label}: the only warnings are the machine-coordinate retract (${parsed.warnings.join('; ')})`,
  )

  // 360 degrees per physical lead: over one lead (`starts * pitch`) of physical
  // travel the bar turns exactly one revolution. The posted angle carries the
  // independently derived drive sign; the machine along coordinate carries the
  // along-axis sign; the two combine into the expected signed ratio.
  const lead = starts * pitch
  // A left-hand thread reverses the physical hand, so the posted angle-vs-along
  // ratio flips sign while the lead magnitude is unchanged.
  const handSign = direction === 'left' ? -1 : 1
  const expectedRatio = handSign * expectedDriveSign(definition) * alongAxisSign(axis, definition) * 360 / lead
  let feeding = 0
  for (const move of parsed.moves) {
    for (const point of [move.from, move.to]) {
      assert.ok(
        Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z),
        `${label}: every posted coordinate is finite`,
      )
      if (point.a !== undefined) assert.ok(Number.isFinite(point.a), `${label}: every posted angle is finite`)
    }
    if (move.kind !== 'linear') continue
    const deltaAlong = axis === 'x' ? move.to.x - move.from.x : move.to.y - move.from.y
    if (Math.abs(deltaAlong) <= 1e-9) continue
    const fromAngle = move.from.a
    const toAngle = move.to.a
    assert.ok(fromAngle !== undefined && toAngle !== undefined, `${label}: a feeding move along the bar posts its angle`)
    if (fromAngle === undefined || toAngle === undefined) throw new Error('unreachable')
    const ratio = (toAngle - fromAngle) / deltaAlong
    const tolerance = Math.abs(expectedRatio) * 1e-6
    assert.ok(
      Math.abs(ratio - expectedRatio) <= tolerance,
      `${label}: the posted angle advances one turn per physical lead (${ratio} != ${expectedRatio})`,
    )
    feeding += 1
  }
  assert.ok(feeding > 0, `${label}: the program contains feeding moves along the bar`)

  // The turn is never reduced modulo one revolution: the travel spans several
  // turns and the largest posted angle is well past 360.
  const posted = parsed.moves
    .map((move) => move.to.a)
    .filter((angle): angle is number => angle !== undefined)
  assert.ok(posted.length > 0, `${label}: the program posts the angle`)
  assert.ok(Math.max(...posted.map(Math.abs)) > 360, `${label}: the program keeps turning past one revolution`)

  return exported.gcode
}

// ── the real generation and export seam ───────────────────────

log('Testing generation and export through the real seam...')
{
  for (const [label, axis, units, spec, pitch, length, direction] of [
    ['mm X right', 'x', 'mm', MM_BAR, 2, 60, undefined],
    ['mm X left', 'x', 'mm', MM_BAR, 2, 60, 'left'],
    ['inch Y right', 'y', 'inch', INCH_BAR, 0.05, 3, undefined],
    ['inch Y left', 'y', 'inch', INCH_BAR, 0.05, 3, 'left'],
  ] as const) {
    loadRotary(spec, [vBit(units, 'v1')])
    const depth = units === 'mm' ? 1.2 : 0.1
    const created = store().addRotaryPattern(
      direction
        ? { kind: 'thread', start: 10, length, pitch, starts: 1, depth, direction }
        : { kind: 'thread', start: 10, length, pitch, starts: 1, depth },
    )
    assert.ok(created.ok, `${label}: thread created`)
    if (!created.ok) throw new Error('unreachable')
    const project = store().project
    const operation = project.operations[0]
    assert.equal(aroundUnavailableReason(project), null, `${label}: Around stays available`)

    const envelope = computeOperationToolpath(project, operation)
    assert.ok(envelope, `${label}: generation returns an envelope`)
    const path = envelope.result
    assert.ok(path.moves.length > 0, `${label}: nonempty moves`)
    // warningSeverity has no 'info' level — its domain is 'warning' | 'error' —
    // so "no generation warning above info" is exactly "no warnings at all".
    assert.deepEqual(
      path.warnings.map((warning) => warningSeverity(warning.code)),
      [],
      `${label}: generation emits no warning at any severity`,
    )
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

    // The exported program text itself — parsed posted coordinates and rotary
    // words across every axis/units/drive/reversal/start combination — is
    // checked in the matrix below.
  }
}

// ── the posted program, read back ─────────────────────────────

log('Testing the exported program text: posted modal coordinates and rotary words...')
{
  // A bounded matrix: both bar axes, both unit systems, own-A and borrowed
  // motor, normal and reversed rotation, single and multiple starts. Each case
  // is generated through the store and read back from the literal program.
  for (const axis of ['x', 'y'] as const) {
    for (const units of ['mm', 'inch'] as const) {
      for (const drive of ['own', 'borrowed'] as const) {
        for (const reversed of [false, true]) {
          for (const starts of [1, 3]) {
            // The existing 32 cases stay exactly as they were: an omitted
            // direction is the default right hand.
            const omitted = assertExportedHelix(axis, units, drive, reversed, starts)
            // An explicit right hand is the same program, byte for byte; the
            // left hand is the same geometry with the posted ratio reversed.
            const explicitRight = assertExportedHelix(axis, units, drive, reversed, starts, 'right')
            assert.equal(
              explicitRight,
              omitted,
              `${axis}/${units}/${drive}${reversed ? '/reversed' : ''}/starts=${starts}: an explicit right is byte-identical to omitted`,
            )
            assertExportedHelix(axis, units, drive, reversed, starts, 'left')
          }
        }
      }
    }
  }
}

log('All rotary pattern store tests passed.')
