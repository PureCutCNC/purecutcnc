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
 * Canned Thread/Flutes store flow and old-command equivalence (issue #1112 F).
 *
 * Load-bearing properties:
 *
 * 1. **Creation adds one feature, no operation and no tool.** The dialog's
 *    numbers land as one canned `thread`/`flutes` definition drawing every
 *    line, in exactly one history step.
 * 2. **The generated lines equal the old command's lines** for several
 *    parameter sets. The old command measured start from the stock's minimum
 *    along coordinate; the new canned shape measures it from the chuck end
 *    (decision 4), so a Y bar is compared on the same physical band.
 * 3. **A Follow line operation on the canned feature cuts what the old
 *    folder's operation cut**: the same moves and the same posted G-code,
 *    with the date pinned.
 * 4. **Save → load → regenerate is exact, per kind** — the round-trip test the
 *    canned model requires.
 * 5. **Edit and Expand** work through the ordinary feature paths: a parameter
 *    change regenerates the lines and the Z span, and Expand gives the plain
 *    lines back.
 * 6. **Every target path reaches the same depth rule** (FG3): Add, Use current
 *    selection and Add to operation all read the canned depth, the deepest
 *    wins when patterns differ, and a mixed target keeps its own depth.
 *
 * Mutations checked one at a time:
 * - start measured from the minimum end on Y → the Y equivalence and chuck-end
 *   assertions fail;
 * - a folder / per-line features created again → the "one feature" assertions
 *   fail;
 * - an operation or tool added by creation → the operation/tool counts fail;
 * - stored parameters dropped → the round-trip geometry differs;
 * - a Follow line taking today's 1 mm default instead of the feature's depth →
 *   the move/G-code parity and the operation-depth assertions fail;
 * - `updateOperation` applying a target change without the depth rule → the
 *   retarget and Add-to-operation assertions fail;
 * - `twist` sign or `hand` ignored → the geometry and toolpath comparisons
 *   fail;
 * - Expand emitting one piece per feature instead of per outline → the
 *   expanded line count fails.
 *
 * Run with: npx tsx src/store/rotaryPatterns.test.ts
 */

import assert from 'node:assert/strict'
import {
  IDENTITY_MATRIX,
  defaultTool,
  getStockBounds,
  newProject,
  roundStock,
} from '../types/project'
import type {
  CannedShapeParams,
  FeatureDefinition,
  FeatureFolder,
  FeatureInstance,
  OperationTarget,
  Project,
  SketchProfile,
  Tool,
} from '../types/project'
import { bundledMachines } from '../machine/registry'
import { validateMachineDefinition } from '../engine/gcode/types'
import type { MachineDefinition } from '../engine/gcode/types'
import { projectWithFeatures } from '../test/projectFixtures'
import { computeOperationToolpath } from '../engine/toolpaths/generateOperation'
import { normalizeToolForProject, resolveDimensionRef } from '../engine/toolpaths/geometry'
import { runPostProcessor } from '../engine/gcode/postprocessor'
import { createCamPlan } from '../engine/operations/camPlan'
import { buildRotaryPatternLines, rotaryPatternFrame, rotarySheetPoint } from '../engine/rotaryPatterns'
import type { RotaryPatternFrame } from '../engine/rotaryPatterns'
import { switchWorkspaceFace } from './workspaceFace'
import { resolveFeatureInstance } from './helpers/resolveFeatures'
import type { RotaryPatternInput } from './helpers/rotaryPatterns'
import { useProjectStore } from './projectStore'
import {
  resolveCannedShapeProfiles,
} from '../cannedShapes'
import { FLUTES_CANNED_KIND, THREAD_CANNED_KIND } from '../cannedShapes/generators/kinds'
import { normalizeThreadCannedParams } from '../cannedShapes/generators/thread'
import { normalizeFlutesCannedParams } from '../cannedShapes/generators/flutes'

const store = () => useProjectStore.getState()

let passCount = 0
let failCount = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`✓ ${name}`)
    passCount += 1
  } catch (error) {
    console.error(`✗ ${name}`)
    console.error(`  ${(error as Error).stack ?? (error as Error).message}`)
    failCount += 1
  }
}

function near(actual: number, expected: number, label: string, tolerance = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} != ${expected}`)
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
const INCH_Y_BAR: BarSpec = { axis: 'y', units: 'inch', at: INCH_AT }

function barStock(spec: BarSpec): ReturnType<typeof roundStock> {
  const [diameter, length] = spec.units === 'mm' ? [40, 200] : [2, 8]
  return roundStock(diameter, length, spec.axis, spec.at)
}

function rotaryMachine(axis: 'x' | 'y'): MachineDefinition {
  const base = structuredClone(bundledMachines()[0])
  return validateMachineDefinition({
    ...base,
    id: `around-${axis}-canned`,
    rotary: { about: axis, drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
  })
}

function cutter(units: 'mm' | 'inch', id: string, type: Tool['type']): Tool {
  return {
    ...defaultTool(units, 1),
    id,
    name: `${id} ${type}`,
    units,
    type,
    diameter: units === 'mm' ? 6 : 0.25,
    vBitAngle: type === 'v_bit' ? 60 : null,
    maxCutDepth: 0,
    defaultStepdown: units === 'mm' ? 0.4 : 0.02,
    defaultFeed: units === 'mm' ? 600 : 24,
    defaultPlungeFeed: units === 'mm' ? 200 : 8,
  }
}

/** A rotary project with one cutter, loaded and switched onto Around. */
function loadRotary(spec: BarSpec, tool: Tool): Project {
  const base = newProject(`Patterns ${spec.axis}`, spec.units)
  base.meta.projectType = 'rotary'
  base.stock = barStock(spec)
  const machine = rotaryMachine(spec.axis)
  base.meta.machineDefinitions = [machine]
  base.meta.selectedMachineId = machine.id
  base.tools = [tool]
  store().loadProject(projectWithFeatures(base, []))
  assert.equal(switchWorkspaceFace('around'), true, 'the workspace enters Around')
  return store().project
}

/** The frame the pre-canned command used: start from the stock minimum on either axis. */
function oldFrame(project: Project): RotaryPatternFrame {
  const frame = rotaryPatternFrame(project)
  assert.ok(frame, 'the fixture is a bar')
  const bounds = getStockBounds(project.stock)
  return {
    ...frame,
    alongOrigin: frame.axis === 'x' ? bounds.minX : bounds.minY,
    alongDirection: 1,
  }
}

/** The line profile the old command created for one sheet line. */
function lineProfile(frame: RotaryPatternFrame, line: {
  alongStart: number
  alongEnd: number
  acrossStart: number
  acrossEnd: number
}): SketchProfile {
  return {
    start: rotarySheetPoint(frame, line.alongStart, line.acrossStart),
    segments: [{
      type: 'line',
      to: rotarySheetPoint(frame, line.alongEnd, line.acrossEnd),
    }],
    closed: false,
  }
}

/**
 * Build the old project shape — a named folder of ordinary open lines — so
 * its operation can be compared with the canned feature's. This is the
 * pre-canned creation result, not a path the app still offers.
 */
function oldPatternProject(spec: BarSpec, input: RotaryPatternInput, toolId: string): Project {
  const baseProject = newProject(`Patterns ${spec.axis}`, spec.units)
  baseProject.meta.projectType = 'rotary'
  baseProject.stock = barStock(spec)
  const machine = rotaryMachine(spec.axis)
  baseProject.meta.machineDefinitions = [machine]
  baseProject.meta.selectedMachineId = machine.id
  baseProject.tools = [cutter(spec.units, toolId, input.kind === 'thread' ? 'v_bit' : 'ball_endmill')]
  const project = projectWithFeatures(baseProject, [])
  const frame = oldFrame(project)
  const built = buildRotaryPatternLines(frame, input)
  assert.ok(built.ok, 'the old fixture builds its lines')

  const folder: FeatureFolder = {
    id: 'old-folder',
    name: input.kind === 'thread' ? 'Thread' : 'Flutes',
    collapsed: false,
    section: 'features',
  }
  const definitions: Record<string, FeatureDefinition> = {}
  const features: FeatureInstance[] = []
  const thickness = project.stock.thickness
  built.lines.forEach((line, index) => {
    const definitionId = `old-def-${index}`
    const featureId = `old-f-${index}`
    const profile = lineProfile(frame, line)
    definitions[definitionId] = {
      id: definitionId,
      kind: 'composite',
      profile,
      dimensions: [],
      text: null,
      stl: null,
      operation: 'line',
    }
    features.push({
      id: featureId,
      name: input.kind === 'thread' ? `Thread Start ${index + 1}` : `Flutes Flute ${index + 1}`,
      definitionId,
      transform: { ...IDENTITY_MATRIX },
      constraints: [],
      folderId: folder.id,
      z_top: thickness,
      z_bottom: thickness - input.depth,
      authoringFace: 'around',
      visible: true,
      locked: false,
    })
  })
  return {
    ...project,
    featureFolders: [folder],
    features,
    featureDefinitions: definitions,
    featureTree: [{ type: 'folder', folderId: folder.id }],
  }
}

function followLineTarget(featureIds: string[]): OperationTarget {
  return { source: 'features', featureIds }
}

/** Load a project, enter Around and add one Follow line operation for `ids`. */
function addEngrave(project: Project, ids: string[]): { project: Project; operationId: string } {
  store().loadProject(project)
  assert.equal(switchWorkspaceFace('around'), true, 'the workspace enters Around')
  const operationId = store().addOperation('follow_line', 'rough', followLineTarget(ids))
  assert.ok(operationId, 'the Follow line operation is created')
  return { project: store().project, operationId }
}

/**
 * The old command's operation, exactly as it created it: a Follow line whose
 * `carveDepth` (and `maxCarveDepth`) came from the requested depth, not from
 * today's default. Only the name is left at the store default so the posted
 * program's comment lines match the new operation; the name is presentation,
 * the depth is what cuts.
 */
function addOldEngrave(
  project: Project,
  ids: string[],
  depth: number,
): { project: Project; operationId: string } {
  const run = addEngrave(project, ids)
  store().updateOperation(run.operationId, { carveDepth: depth, maxCarveDepth: depth })
  return { project: store().project, operationId: run.operationId }
}

/** Pin the program date so a midnight boundary cannot flake an export compare. */
function pinDate(gcode: string): string {
  return gcode.replace(/\b\d{4}-\d{2}-\d{2}\b/g, 'YYYY-MM-DD')
}

/** Add one plain open Line on the Around face, for the mixed-target test. */
function addPlainLineFeature(): string {
  const thickness = store().project.stock.thickness
  store().addFeature({
    id: 'plain-line',
    name: 'Plain Line',
    kind: 'polygon',
    folderId: null,
    sketch: {
      profile: {
        start: { x: 0, y: 0 },
        segments: [{ type: 'line', to: { x: 10, y: 0 } }],
        closed: false,
      },
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'line',
    z_top: thickness,
    z_bottom: thickness - 1,
    authoringFace: 'around',
    visible: true,
    locked: false,
  })
  return 'plain-line'
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
  return { moves: envelope.result.moves, gcode: pinDate(result.gcode) }
}

function onlyCannedFeature(): FeatureInstance {
  const features = store().project.features
  assert.equal(features.length, 1, `exactly one canned feature (got ${features.length})`)
  return features[0]
}

function resolvedCanned(featureId: string) {
  const project = store().project
  const feature = resolveFeatureInstance(project, featureId)
  assert.ok(feature, 'the canned feature resolves')
  return feature
}

// ── creation ─────────────────────────────────────────────────

test('a thread creates one canned feature, no folder, no operation and no tool', () => {
  loadRotary(MM_X_BAR, cutter('mm', 'v1', 'v_bit'))
  const before = store().project
  const historyBefore = store().history.past.length
  const result = store().addRotaryPattern({ kind: 'thread', start: 25, length: 60, pitch: 2, starts: 2, depth: 1.2 })
  assert.ok(result.ok, `thread created (${result.ok ? '' : result.reason})`)
  if (!result.ok) return

  const project = store().project
  assert.equal(store().history.past.length, historyBefore + 1, 'exactly one history entry')
  assert.equal(project.featureFolders.length, before.featureFolders.length, 'no folder is created')
  assert.equal(project.operations.length, before.operations.length, 'no operation is created')
  assert.deepEqual(project.tools, before.tools, 'no tool is added or changed')
  const feature = onlyCannedFeature()
  assert.equal(feature.id, result.featureId, 'the returned id is the feature')
  const definition = project.featureDefinitions[feature.definitionId]
  assert.equal(definition.operation, 'line', 'an ordinary Line')
  assert.equal(feature.authoringFace, 'around', 'authored on Around')
  assert.equal(feature.folderId, null, 'not inside a folder')
  near(resolveDimensionRef(project, feature.z_top), project.stock.thickness, 'z_top is the bar surface')
  near(
    resolveDimensionRef(project, feature.z_bottom),
    project.stock.thickness - 1.2,
    'z_bottom is the requested depth below the surface',
  )

  assert.equal(definition.canned?.kind, THREAD_CANNED_KIND, 'stored kind')
  const params = normalizeThreadCannedParams(definition.canned?.params ?? {})
  assert.ok(params, 'stored parameters normalize')
  assert.deepEqual(
    { start: params.start, length: params.length, pitch: params.pitch, starts: params.starts, depth: params.depth, hand: params.hand },
    { start: 25, length: 60, pitch: 2, starts: 2, depth: 1.2, hand: 'right' },
    'the dialog numbers are stored',
  )

  const frame = rotaryPatternFrame(project)
  assert.ok(frame, 'the fixture is a bar')
  const profiles = resolveCannedShapeProfiles(resolvedCanned(result.featureId))
  assert.equal(profiles.length, 2, 'one open outline per start')
  for (const profile of profiles) assert.equal(profile.closed, false, 'every outline is open')
  assert.equal(profiles[0].segments.length, 1, 'each outline is one line')
  const starts = profiles.map((profile) => profile.start)
  const lead = 2 * 2
  near(
    Math.abs(starts[1].y - starts[0].y),
    frame.circumference / 2,
    'two starts sit half a circumference apart',
  )
  const end = profiles[0].segments[0].type === 'line' ? profiles[0].segments[0].to : starts[0]
  near(Math.abs(end.y - starts[0].y), frame.circumference * 60 / lead, 'the lead is starts × pitch')

  // Undo/redo are one step for the whole feature.
  store().undo()
  assert.equal(store().project.features.length, 0, 'undo removes the feature')
  assert.equal(store().history.past.length, historyBefore, 'undo restores history')
  store().redo()
  assert.equal(store().project.features.length, 1, 'redo restores the feature')
  assert.equal(store().project.operations.length, before.operations.length, 'redo adds no operation')

  // A refusal changes nothing.
  const refusedBefore = store().project
  const refusedHistory = store().history.past.length
  const refused = store().addRotaryPattern({ kind: 'thread', start: 0, length: 10, pitch: 2, depth: frame.radius })
  assert.equal(refused.ok, false, 'a depth at the radius is refused')
  assert.equal(refused.ok === false && refused.reason, 'depthReachesCentreline', 'with the centreline reason')
  assert.equal(store().project, refusedBefore, 'a refusal does not touch the project')
  assert.equal(store().history.past.length, refusedHistory, 'a refusal adds no history')
})

test('flutes store signed twist and one feature per pattern', () => {
  loadRotary(MM_X_BAR, cutter('mm', 'ball', 'ball_endmill'))
  const result = store().addRotaryPattern({ kind: 'flutes', start: 20, length: 50, count: 4, twist: -1.5, depth: 0.8 })
  assert.ok(result.ok, 'flutes created')
  if (!result.ok) return
  const feature = onlyCannedFeature()
  const definition = store().project.featureDefinitions[feature.definitionId]
  assert.equal(definition.operation, 'line', 'an ordinary Line')
  assert.equal(definition.canned?.kind, FLUTES_CANNED_KIND, 'stored kind')
  const params = normalizeFlutesCannedParams(definition.canned?.params ?? {})
  assert.ok(params, 'stored parameters normalize')
  assert.equal(params.twist, -1.5, 'the signed twist is stored')
  assert.equal(params.count, 4, 'the count is stored')
  assert.equal(resolveCannedShapeProfiles(resolvedCanned(result.featureId)).length, 4, 'one outline per flute')
})

test('a single straight flute is a valid canned feature and edits', () => {
  loadRotary(MM_X_BAR, cutter('mm', 'ball', 'ball_endmill'))
  const result = store().addRotaryPattern({
    kind: 'flutes',
    start: 0,
    length: 10,
    count: 1,
    twist: 0,
    depth: 0.5,
  })
  assert.ok(result.ok, 'a single straight flute is created')
  if (!result.ok) return
  const feature = onlyCannedFeature()
  const definition = store().project.featureDefinitions[feature.definitionId]
  assert.equal(definition.canned?.kind, FLUTES_CANNED_KIND, 'stored kind')
  const before = resolveCannedShapeProfiles(resolvedCanned(result.featureId))
  assert.equal(before.length, 1, 'one outline')
  assert.equal(before[0].closed, false, 'the outline is open')

  const stored = normalizeFlutesCannedParams(definition.canned?.params ?? {})
  assert.ok(stored, 'stored parameters normalize')
  const next = normalizeFlutesCannedParams({
    ...stored,
    length: 20,
  } as unknown as CannedShapeParams)
  assert.ok(next, 'the edited parameters normalize')
  store().updateFeature(result.featureId, {
    canned: { kind: FLUTES_CANNED_KIND, params: next },
  })
  const after = resolveCannedShapeProfiles(resolvedCanned(result.featureId))[0]
  const end = after.segments[0].type === 'line' ? after.segments[0].to : after.start
  near(Math.abs(end.x - after.start.x), 20, 'the edited length is applied')
})

test('a Y bar measures start from the chuck end, not the minimum', () => {
  loadRotary(MM_Y_BAR, cutter('mm', 'v1', 'v_bit'))
  const frame = rotaryPatternFrame(store().project)
  assert.ok(frame, 'the fixture is a bar')
  const bounds = getStockBounds(store().project.stock)
  near(frame.alongOrigin, bounds.maxY, 'the chuck end is the stock maximum on a Y bar')
  assert.equal(frame.alongDirection, -1, 'length runs away from the chuck end')

  const result = store().addRotaryPattern({ kind: 'thread', start: 10, length: 30, pitch: 2, depth: 1 })
  assert.ok(result.ok, 'Y thread created')
  if (!result.ok) return
  const profile = resolveCannedShapeProfiles(resolvedCanned(result.featureId))[0]
  const end = profile.segments[0].type === 'line' ? profile.segments[0].to : profile.start
  const band = [profile.start.y, end.y].sort((a, b) => a - b)
  near(band[0], bounds.maxY - 40, 'the 30 long band starts 40 from the chuck end')
  near(band[1], bounds.maxY - 10, 'and ends 10 from the chuck end')
  near(end.y - profile.start.y, 30, 'the line is still drawn low to high in stock coordinates')
})

// ── equivalence with the old command ─────────────────────────

interface EquivalenceCase {
  label: string
  spec: BarSpec
  input: RotaryPatternInput
}

const THREAD_CASES: EquivalenceCase[] = [
  {
    label: 'mm X single start',
    spec: MM_X_BAR,
    input: { kind: 'thread', start: 25, length: 60, pitch: 2, depth: 1.2 },
  },
  {
    label: 'mm X two start, left hand',
    spec: MM_X_BAR,
    input: { kind: 'thread', start: 40, length: 30, pitch: 1.25, starts: 2, hand: 'left', depth: 1 },
  },
  {
    label: 'inch Y three start',
    spec: INCH_Y_BAR,
    input: { kind: 'thread', start: 1.5, length: 3, pitch: 0.05, starts: 3, depth: 0.1 },
  },
]

const FLUTE_CASES: EquivalenceCase[] = [
  {
    label: 'mm X twisted',
    spec: MM_X_BAR,
    input: { kind: 'flutes', start: 20, length: 50, count: 4, twist: 1.5, depth: 0.8 },
  },
  {
    label: 'mm X left twist',
    spec: MM_X_BAR,
    input: { kind: 'flutes', start: 5, length: 20, count: 3, twist: -0.75, depth: 0.5 },
  },
  {
    label: 'inch Y straight',
    spec: INCH_Y_BAR,
    input: { kind: 'flutes', start: 1, length: 2, count: 2, twist: 0, depth: 0.1 },
  },
]

test('the canned generator draws the old command lines, for several parameter sets', () => {
  for (const [index, testCase] of [...THREAD_CASES, ...FLUTE_CASES].entries()) {
    const toolType = testCase.input.kind === 'thread' ? 'v_bit' : 'ball_endmill'
    const toolId = `t${index}`
    loadRotary(testCase.spec, cutter(testCase.spec.units, toolId, toolType))
    const frame = rotaryPatternFrame(store().project)
    assert.ok(frame, `${testCase.label}: fixture is a bar`)
    const bounds = getStockBounds(store().project.stock)
    const barLength = testCase.spec.axis === 'x' ? bounds.maxX - bounds.minX : bounds.maxY - bounds.minY

    // The old command measured from the stock minimum on both axes.
    const old = oldFrame(store().project)
    const oldStart = testCase.input.start
    const newStart = testCase.spec.axis === 'x' ? oldStart : barLength - oldStart - testCase.input.length
    const newInput: RotaryPatternInput = { ...testCase.input, start: newStart }

    const oldLines = buildRotaryPatternLines(old, testCase.input)
    assert.ok(oldLines.ok, `${testCase.label}: old command lines build`)
    const expected = oldLines.lines.map((line) => lineProfile(old, line))

    const result = store().addRotaryPattern(newInput)
    assert.ok(result.ok, `${testCase.label}: canned feature created (${result.ok ? '' : result.reason})`)
    if (!result.ok) continue
    const actual = resolveCannedShapeProfiles(resolvedCanned(result.featureId))
    assert.deepEqual(actual, expected, `${testCase.label}: generated lines equal the old command's`)
  }
})

test('a Follow line on the canned feature cuts the old folder operation, moves and G-code', () => {
  for (const [index, testCase] of [...THREAD_CASES, ...FLUTE_CASES].entries()) {
    const toolType = testCase.input.kind === 'thread' ? 'v_bit' : 'ball_endmill'
    const toolId = `t${index}`
    const spec = testCase.spec
    const cutterTool = cutter(spec.units, toolId, toolType)

    // Old shape: folder + one line per start/flute + an Engrave on all of them,
    // with the depth the old dialog wrote onto the operation.
    const oldProject = oldPatternProject(spec, testCase.input, toolId)
    const oldIds = oldProject.features.map((feature) => feature.id)
    const oldRun = addOldEngrave(oldProject, oldIds, testCase.input.depth)
    const oldOperation = oldRun.project.operations.find((operation) => operation.id === oldRun.operationId)
    assert.ok(oldOperation, `${testCase.label}: the old operation exists`)
    assert.equal(oldOperation.carveDepth, testCase.input.depth, `${testCase.label}: the old depth is explicit`)
    const oldResult = movesAndGcode(oldRun.project, oldRun.operationId)

    // New shape: one canned feature + an Engrave on the feature.
    loadRotary(spec, cutterTool)
    const bounds = getStockBounds(store().project.stock)
    const barLength = spec.axis === 'x' ? bounds.maxX - bounds.minX : bounds.maxY - bounds.minY
    const newStart = spec.axis === 'x'
      ? testCase.input.start
      : barLength - testCase.input.start - testCase.input.length
    const created = store().addRotaryPattern({ ...testCase.input, start: newStart })
    assert.ok(created.ok, `${testCase.label}: canned feature created`)
    if (!created.ok) continue
    const newRun = addEngrave(store().project, [created.featureId])
    const newOperation = newRun.project.operations.find((operation) => operation.id === newRun.operationId)
    assert.ok(newOperation, `${testCase.label}: the new operation exists`)
    assert.equal(
      newOperation.carveDepth,
      testCase.input.depth,
      `${testCase.label}: the Follow line depth comes from the feature`,
    )
    const newResult = movesAndGcode(newRun.project, newRun.operationId)

    assert.deepEqual(newResult.moves, oldResult.moves, `${testCase.label}: identical toolpath moves`)
    assert.equal(newResult.gcode, oldResult.gcode, `${testCase.label}: identical posted G-code (date pinned)`)
  }
})

// ── the Follow line depth rule on every target path (FG3) ────
//
// Decision 3 (#1112): a Follow line whose every target is a canned Thread or
// Flutes cuts at the pattern's stored depth, and the deepest one when they
// differ. The rule lives in the store, so a target set through Add, Use
// current selection or Add to operation reaches the same code. The mutation
// that must fail: `updateOperation` applying the target without the rule.

test('select-then-Add puts the canned Thread depth on a new Follow line', () => {
  loadRotary(MM_X_BAR, cutter('mm', 'v1', 'v_bit'))
  const created = store().addRotaryPattern({ kind: 'thread', start: 25, length: 60, pitch: 2, starts: 2, depth: 1.2 })
  assert.ok(created.ok, 'thread created')
  if (!created.ok) return
  const run = addEngrave(store().project, [created.featureId])
  const operation = store().project.operations.find((entry) => entry.id === run.operationId)
  assert.ok(operation, 'the Follow line exists')
  assert.equal(operation.carveDepth, 1.2, 'the new operation cuts the pattern depth')
  assert.equal(operation.maxCarveDepth, 1.2, 'and stores it as its maximum')
})

test('Use current selection retargets an existing 1 mm Follow line to the Thread depth', () => {
  loadRotary(MM_X_BAR, cutter('mm', 'v1', 'v_bit'))
  const plainLineId = addPlainLineFeature()
  // The CAMPanel handler calls exactly this: updateOperation(id, { target }).
  const run = addEngrave(store().project, [plainLineId])
  const before = store().project.operations.find((entry) => entry.id === run.operationId)
  assert.ok(before, 'the Follow line exists')
  assert.equal(before.carveDepth, 1, 'a plain Line keeps the default depth')

  const created = store().addRotaryPattern({ kind: 'thread', start: 25, length: 60, pitch: 2, starts: 2, depth: 1.2 })
  assert.ok(created.ok, 'thread created')
  if (!created.ok) return
  store().updateOperation(run.operationId, { target: followLineTarget([created.featureId]) })

  const after = store().project.operations.find((entry) => entry.id === run.operationId)
  assert.ok(after, 'the operation still exists')
  assert.equal(after.carveDepth, 1.2, 'retargeting reads the Thread depth')
  assert.equal(after.maxCarveDepth, 1.2, 'and its maximum')
})

test('right-click Add to operation re-reads the deepest canned depth', () => {
  loadRotary(MM_X_BAR, cutter('mm', 'v1', 'v_bit'))
  const shallow = store().addRotaryPattern({ kind: 'thread', start: 25, length: 30, pitch: 2, depth: 0.5 })
  assert.ok(shallow.ok, 'the shallow thread is created')
  if (!shallow.ok) return
  const run = addEngrave(store().project, [shallow.featureId])
  const deep = store().addRotaryPattern({ kind: 'thread', start: 25, length: 60, pitch: 2, starts: 2, depth: 1.2 })
  assert.ok(deep.ok, 'the deep thread is created')
  if (!deep.ok) return

  // The context menu merges the row into the existing target, then calls
  // updateOperation with the combined set (useFeatureTreeActions).
  store().updateOperation(run.operationId, {
    target: followLineTarget([shallow.featureId, deep.featureId]),
  })
  const operation = store().project.operations.find((entry) => entry.id === run.operationId)
  assert.ok(operation, 'the operation still exists')
  assert.equal(operation.carveDepth, 1.2, 'the deepest pattern names the one cutting depth')
  assert.equal(operation.maxCarveDepth, 1.2, 'and its maximum')
})

test('a target set with a plain Line keeps the operation depth', () => {
  loadRotary(MM_X_BAR, cutter('mm', 'v1', 'v_bit'))
  const created = store().addRotaryPattern({ kind: 'thread', start: 25, length: 60, pitch: 2, starts: 2, depth: 1.2 })
  assert.ok(created.ok, 'thread created')
  if (!created.ok) return
  const run = addEngrave(store().project, [created.featureId])
  store().updateOperation(run.operationId, { carveDepth: 1, maxCarveDepth: 1 })
  const plainLineId = addPlainLineFeature()

  store().updateOperation(run.operationId, {
    target: followLineTarget([created.featureId, plainLineId]),
  })
  const operation = store().project.operations.find((entry) => entry.id === run.operationId)
  assert.ok(operation, 'the operation still exists')
  assert.equal(operation.carveDepth, 1, 'a mixed target has no pattern depth to name')
  assert.equal(operation.maxCarveDepth, 1, 'so both stored depths stay as they were')
})

test('reapplying the same target does not reset a manual depth', () => {
  loadRotary(MM_X_BAR, cutter('mm', 'v1', 'v_bit'))
  const created = store().addRotaryPattern({ kind: 'thread', start: 25, length: 60, pitch: 2, starts: 2, depth: 1.2 })
  assert.ok(created.ok, 'thread created')
  if (!created.ok) return
  const run = addEngrave(store().project, [created.featureId])
  store().updateOperation(run.operationId, { carveDepth: 0.9, maxCarveDepth: 0.9 })

  store().updateOperation(run.operationId, { target: followLineTarget([created.featureId]) })
  const operation = store().project.operations.find((entry) => entry.id === run.operationId)
  assert.ok(operation, 'the operation still exists')
  assert.equal(operation.carveDepth, 0.9, 'an unchanged target is not a target change')
  assert.equal(operation.maxCarveDepth, 0.9, 'so the manual depth survives')
})

test('CAM Plan proposes the Follow line at the canned depth (#1112 J)', () => {
  loadRotary(MM_X_BAR, cutter('mm', 'v1', 'v_bit'))
  const created = store().addRotaryPattern({ kind: 'thread', start: 25, length: 60, pitch: 2, starts: 2, depth: 1.2 })
  assert.ok(created.ok, 'thread created')
  if (!created.ok) return

  // Decision 3: Thread/Flutes are planned as a Follow line with a V-bit. The
  // depth comes from the same store rule every manual target path uses, so the
  // applied operation cuts what the old command cut.
  const plan = createCamPlan(store().project, [])
  const drafts = plan.operations.filter((draft) => draft.operation.kind === 'follow_line')
  assert.equal(drafts.length, 1, 'the pattern is one Engrave')
  const draft = drafts[0]!
  assert.deepEqual(draft.operation.target, followLineTarget([created.featureId]), 'targets the canned pattern')
  assert.equal(draft.operation.toolRef, 'v1', 'uses the V-bit')
  assert.equal(draft.operation.carveDepth, 1.2, 'the plan depth is the pattern depth')
  assert.equal(draft.operation.maxCarveDepth, 1.2, 'and its maximum')

  const applied = store().applyCamPlan(plan)
  assert(applied.ok, 'the plan applies')
  const operation = store().project.operations.find((entry) => entry.id === applied.operationIds[0])
  assert.equal(operation?.kind, 'follow_line', 'the created operation is the Engrave')
  assert.equal(operation?.carveDepth, 1.2, 'and keeps the pattern depth')
})

// ── round trip, edit and expand ──────────────────────────────

test('an old folder of lines plus its Engrave stays folder + lines + operation', () => {
  const oldProject = oldPatternProject(
    MM_X_BAR,
    { kind: 'thread', start: 25, length: 60, pitch: 2, starts: 2, depth: 1.2 },
    'v1',
  )
  const oldIds = oldProject.features.map((feature) => feature.id)
  const run = addOldEngrave(oldProject, oldIds, 1.2)
  const profiles = run.project.features.map(
    (feature) => run.project.featureDefinitions[feature.definitionId].profile,
  )

  const saved = store().saveProject()
  store().openProjectFromText(saved, null)
  const after = store().project
  assert.equal(after.featureFolders.length, 1, 'the old folder stays')
  assert.equal(after.features.length, oldIds.length, 'the old lines stay')
  assert.equal(after.operations.length, 1, 'the old Engrave stays')
  assert.deepEqual(
    after.features.map((feature) => after.featureDefinitions[feature.definitionId].profile),
    profiles,
    'the old plain line geometry is unchanged',
  )
  const operation = after.operations[0]
  assert.equal(operation.kind, 'follow_line', 'the operation kind is unchanged')
  assert.equal(operation.carveDepth, 1.2, 'the old Engrave keeps its explicit depth')
  assert.deepEqual(
    operation.target.source === 'features' ? operation.target.featureIds : [],
    oldIds,
    'the operation still targets the old lines',
  )
  for (const feature of after.features) {
    assert.equal(
      after.featureDefinitions[feature.definitionId].canned,
      undefined,
      'no canned data is invented for an old project',
    )
  }
})

const ROUND_TRIP_CASES: Array<{ label: string; spec: BarSpec; input: RotaryPatternInput; kind: string }> = [
  {
    label: 'thread',
    spec: MM_X_BAR,
    input: { kind: 'thread', start: 25, length: 60, pitch: 2, starts: 2, depth: 1.2 },
    kind: THREAD_CANNED_KIND,
  },
  {
    label: 'flutes',
    spec: MM_X_BAR,
    input: { kind: 'flutes', start: 20, length: 50, count: 4, twist: -1.5, depth: 0.8 },
    kind: FLUTES_CANNED_KIND,
  },
]

test('save, load, regenerate: the same lines per canned kind', () => {
  for (const testCase of ROUND_TRIP_CASES) {
    loadRotary(testCase.spec, cutter(testCase.spec.units, 't1', testCase.input.kind === 'thread' ? 'v_bit' : 'ball_endmill'))
    const created = store().addRotaryPattern(testCase.input)
    assert.ok(created.ok, `${testCase.label}: created`)
    if (!created.ok) continue
    const before = resolveCannedShapeProfiles(resolvedCanned(created.featureId))
    assert.ok(before.length > 0, `${testCase.label}: draws lines before saving`)

    const file = store().saveProject()
    const saved = JSON.parse(file) as Project
    const savedFeature = saved.features.find((feature) => feature.id === created.featureId)
    assert.ok(savedFeature, `${testCase.label}: the feature is saved`)
    assert.equal(
      saved.featureDefinitions[savedFeature.definitionId].canned?.kind,
      testCase.kind,
      `${testCase.label}: kind is saved`,
    )

    store().openProjectFromText(file, null)
    const after = resolveCannedShapeProfiles(resolvedCanned(created.featureId))
    assert.deepEqual(after, before, `${testCase.label}: same lines after load and regenerate`)
    assert.equal(store().project.features.length, 1, `${testCase.label}: no extra rows appear`)
    assert.equal(store().project.operations.length, 0, `${testCase.label}: no operation is created on load`)
  }
})

test('editing the parameters regenerates the lines and the Z span', () => {
  loadRotary(MM_X_BAR, cutter('mm', 'v1', 'v_bit'))
  const created = store().addRotaryPattern({ kind: 'thread', start: 25, length: 20, pitch: 2, depth: 1 })
  assert.ok(created.ok, 'thread created')
  if (!created.ok) return
  const before = resolveCannedShapeProfiles(resolvedCanned(created.featureId))
  const feature = onlyCannedFeature()
  const definition = store().project.featureDefinitions[feature.definitionId]
  const stored = normalizeThreadCannedParams(definition.canned?.params ?? {})
  assert.ok(stored, 'stored parameters normalize')

  const next = normalizeThreadCannedParams({
    ...stored,
    start: 40,
    length: 30,
    pitch: 1.5,
    starts: 3,
    depth: 1.4,
  } as unknown as CannedShapeParams)
  assert.ok(next, 'the edited parameters normalize')
  store().updateFeature(created.featureId, {
    canned: { kind: THREAD_CANNED_KIND, params: next },
    z_top: store().project.stock.thickness,
    z_bottom: store().project.stock.thickness - 1.4,
  })

  const after = resolveCannedShapeProfiles(resolvedCanned(created.featureId))
  assert.equal(after.length, 3, 'the new start count regenerates the lines')
  assert.notDeepEqual(after, before, 'the lines moved')
  const edited = store().project.features[0]
  near(resolveDimensionRef(store().project, edited.z_bottom), store().project.stock.thickness - 1.4, 'the Z span follows the depth')
  const frame = rotaryPatternFrame(store().project)
  assert.ok(frame, 'the fixture is a bar')
  const bounds = getStockBounds(store().project.stock)
  near(after[0].start.x, bounds.minX + 40, 'the edited start is applied')
  near(
    (after[0].segments[0] as { to: { x: number } }).to.x,
    bounds.minX + 40 + 30,
    'the edited length is applied',
  )
})

test('Expand to features gives the plain lines back', () => {
  loadRotary(MM_X_BAR, cutter('mm', 'v1', 'v_bit'))
  const created = store().addRotaryPattern({ kind: 'thread', start: 25, length: 60, pitch: 2, starts: 2, depth: 1.2 })
  assert.ok(created.ok, 'thread created')
  if (!created.ok) return
  const expected = resolveCannedShapeProfiles(resolvedCanned(created.featureId))
  store().expandCannedFeature(created.featureId)
  const project = store().project
  const plain = project.features.filter((feature) => {
    const definition = project.featureDefinitions[feature.definitionId]
    return definition.canned === undefined || definition.canned === null
  })
  assert.equal(plain.length, expected.length, 'one plain feature per generated line')
  for (const feature of plain) {
    const definition = project.featureDefinitions[feature.definitionId]
    assert.equal(definition.operation, 'line', 'the expanded rows are Lines')
    assert.equal(feature.authoringFace, 'around', 'they stay on Around')
  }
  assert.equal(project.features.some((feature) => feature.id === created.featureId), true, 'the source row is kept')
  assert.ok(
    project.featureFolders.some((folder) => folder.grouped === true),
    'the plain lines go into a grouped folder',
  )
})

console.log(`\n${passCount} passed, ${failCount} failed.`)
if (failCount > 0) process.exitCode = 1
