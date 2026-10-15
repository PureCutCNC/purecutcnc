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
 * Existing-tool unit conversion for Thread and Flutes (issue #1016 C1 slice A2).
 *
 * A Thread's V-bit and a Flute's explicitly selected cutter are *existing*
 * tool records. An operator may have imported or authored one in the other
 * unit than the project (the project keeps its own unit; `importTools`
 * preserves the tool's). `defaultOperationForTarget` seeds the new Engrave's
 * feed, plunge feed and stepdown straight from the tool record, so passing the
 * record through unconverted copies tool-unit numbers into a project-unit
 * operation — a mm tool's 600 mm/min read as 600 in/min.
 *
 * The fix converts a throwaway copy of the tool into project units before it
 * seeds the defaults; the stored record, its id and the operation's reference
 * stay exactly as they were.
 *
 * Mutations checked one at a time against these assertions:
 * - the temporary conversion omitted (`tool` passed where `defaultsTool` is) →
 *   every converted-feed/plunge/stepdown assertion and the real-generation
 *   pass-count assertion fail;
 * - the conversion applied to the stored record instead of a copy → the
 *   "stored tool is untouched" assertions fail;
 * - the depth converted with the tool → the "depth stays in project units"
 *   assertions fail;
 * - a second `set` for the tool/operation split → the one-undo assertions fail.
 *
 * Run with: npx tsx src/store/rotaryPatternExistingUnits.test.ts
 */

import assert from 'node:assert/strict'
import { defaultTool, getStockBounds, newProject, roundStock } from '../types/project'
import type { Project, Tool } from '../types/project'
import { bundledMachines } from '../machine/registry'
import { validateMachineDefinition } from '../engine/gcode/types'
import type { MachineDefinition } from '../engine/gcode/types'
import { projectWithFeatures } from '../test/projectFixtures'
import { computeOperationToolpath } from '../engine/toolpaths/generateOperation'
import { MM_PER_INCH } from '../utils/units'
import { useProjectStore } from './projectStore'
import { switchWorkspaceFace } from './workspaceFace'

const store = () => useProjectStore.getState()

function near(actual: number, expected: number, label: string, tolerance = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} != ${expected}`)
}

// ── fixtures ──────────────────────────────────────────────────

interface BarSpec {
  axis: 'x' | 'y'
  units: 'mm' | 'inch'
  at: { x: number; y: number }
}

const MM_BAR: BarSpec = { axis: 'x', units: 'mm', at: { x: 10, y: 30 } }
const INCH_BAR: BarSpec = { axis: 'y', units: 'inch', at: { x: 3, y: 5 } }

/** The cut feeds the issue pins: a mm tool's 600/200/0.4 and an inch tool's 24/8/0.02. */
const MM_CUT = { defaultFeed: 600, defaultPlungeFeed: 200, defaultStepdown: 0.4 }
const INCH_CUT = { defaultFeed: 24, defaultPlungeFeed: 8, defaultStepdown: 0.02 }

function barStock(spec: BarSpec): ReturnType<typeof roundStock> {
  return spec.axis === 'x' ? roundStock(40, 200, 'x', spec.at) : roundStock(2, 8, 'y', spec.at)
}

function rotaryMachine(axis: 'x' | 'y'): MachineDefinition {
  const base = structuredClone(bundledMachines()[0])
  return validateMachineDefinition({
    ...base,
    id: `around-${axis}-units`,
    rotary: { about: axis, drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
  })
}

/**
 * A cutter stored in `units`. `v_bit` for a thread, `ball_endmill`/`flat_endmill`
 * for a flute — all carry the same pinned cut values so one expectation table
 * covers every tool kind.
 */
function cutter(units: 'mm' | 'inch', id: string, type: Tool['type']): Tool {
  const base = defaultTool(units, 1)
  return {
    ...base,
    id,
    name: `${id} ${type}`,
    units,
    type,
    diameter: units === 'mm' ? 6 : 0.25,
    vBitAngle: type === 'v_bit' ? 60 : null,
    maxCutDepth: 0,
    ...(units === 'mm' ? MM_CUT : INCH_CUT),
  }
}

/** A rotary project in `spec.units` whose only tools are `tools`, switched onto Around. */
function loadRotary(spec: BarSpec, tools: Tool[]): Project {
  const base = newProject(`Units ${spec.axis}`, spec.units)
  base.meta.projectType = 'rotary'
  base.stock = barStock(spec)
  const machine = rotaryMachine(spec.axis)
  base.meta.machineDefinitions = [machine]
  base.meta.selectedMachineId = machine.id
  base.tools = tools
  store().loadProject(projectWithFeatures(base, []))
  assert.equal(switchWorkspaceFace('around'), true, 'the workspace enters Around')
  return store().project
}

/** A cutter's cut values as they must read once seeded into a `projectUnits` operation. */
function expectedFor(projectUnits: 'mm' | 'inch', stored: Tool): { feed: number; plungeFeed: number; stepdown: number } {
  const factor = projectUnits === 'mm' ? MM_PER_INCH : 1 / MM_PER_INCH
  return {
    feed: stored.defaultFeed * factor,
    plungeFeed: stored.defaultPlungeFeed * factor,
    stepdown: stored.defaultStepdown * factor,
  }
}

// ── thread: existing V-bit ────────────────────────────────────

console.log('Testing an existing thread V-bit stored in the other unit...')
{
  const cases = [
    { label: 'inch project + mm V-bit', bar: INCH_BAR, toolUnits: 'mm' as const, depth: 0.1, pitch: 0.05, start: 1.5, length: 3 },
    { label: 'mm project + inch V-bit', bar: MM_BAR, toolUnits: 'inch' as const, depth: 1.2, pitch: 2, start: 25, length: 60 },
  ]

  for (const { label, bar, toolUnits, depth, pitch, start, length } of cases) {
    const stored = cutter(toolUnits, 'v1', 'v_bit')
    loadRotary(bar, [stored])
    const before = structuredClone(store().project.tools)
    const historyBefore = store().history.past.length
    const expected = expectedFor(bar.units, stored)

    const result = store().addRotaryPattern({ kind: 'thread', start, length, pitch, starts: 1, depth })
    assert.ok(result.ok, `${label}: thread created (${result.ok ? '' : result.reason})`)
    if (!result.ok) throw new Error('unreachable')

    const project = store().project
    const operation = project.operations.find((entry) => entry.id === result.operationId)
    assert.ok(operation, `${label}: the operation exists`)

    // The defect: these three carried the tool's own-unit numbers.
    near(operation.feed, expected.feed, `${label}: cut feed converted to project units`)
    near(operation.plungeFeed, expected.plungeFeed, `${label}: plunge feed converted to project units`)
    near(operation.stepdown, expected.stepdown, `${label}: stepdown converted to project units`)
    assert.notEqual(operation.stepdown, stored.defaultStepdown, `${label}: the raw tool stepdown is not reused`)

    // Depth and the geometry stay in the project's units.
    near(operation.carveDepth, depth, `${label}: carveDepth is the requested project-unit depth`)
    near(operation.maxCarveDepth, depth, `${label}: maxCarveDepth is the requested project-unit depth`)
    const feature = project.features.find((entry) => entry.id === result.featureIds[0])
    assert.ok(feature, `${label}: the line exists`)
    near(feature.z_top as number, project.stock.thickness, `${label}: z_top is the bar surface`)
    near(feature.z_bottom as number, project.stock.thickness - depth, `${label}: z_bottom is the project-unit depth below the surface`)

    // The stored record and the reference are untouched.
    assert.deepEqual(project.tools, before, `${label}: the stored tool record is unchanged`)
    assert.equal(project.tools.length, 1, `${label}: no tool was added`)
    assert.equal(project.tools[0].id, 'v1', `${label}: the tool keeps its id`)
    assert.equal(project.tools[0].units, toolUnits, `${label}: the tool keeps its own units`)
    assert.equal(operation.toolRef, 'v1', `${label}: the operation references the existing tool`)

    // One history step; undo removes it all and leaves the tool, redo restores it.
    assert.equal(store().history.past.length, historyBefore + 1, `${label}: exactly one history entry`)
    store().undo()
    assert.equal(store().project.operations.length, 0, `${label}: undo removes the operation`)
    assert.equal(store().project.features.length, 0, `${label}: undo removes the line`)
    assert.equal(store().project.featureFolders.length, 0, `${label}: undo removes the folder`)
    assert.deepEqual(store().project.tools, before, `${label}: undo leaves the stored tool untouched`)
    store().redo()
    const redone = store().project.operations[0]
    assert.ok(redone, `${label}: redo restores the operation`)
    near(redone.feed, expected.feed, `${label}: redo keeps the converted feed`)
    near(redone.stepdown, expected.stepdown, `${label}: redo keeps the converted stepdown`)
    assert.equal(redone.toolRef, 'v1', `${label}: redo keeps the reference`)
    assert.deepEqual(store().project.tools, before, `${label}: redo leaves the stored tool untouched`)
  }
}

// ── flutes: explicitly selected cutter ────────────────────────

console.log('Testing an explicitly selected flute cutter stored in the other unit...')
{
  const cases = [
    { label: 'inch project + mm ball', bar: INCH_BAR, toolUnits: 'mm' as const, type: 'ball_endmill' as const, depth: 0.1 },
    { label: 'inch project + mm flat', bar: INCH_BAR, toolUnits: 'mm' as const, type: 'flat_endmill' as const, depth: 0.1 },
    { label: 'mm project + inch ball', bar: MM_BAR, toolUnits: 'inch' as const, type: 'ball_endmill' as const, depth: 1.2 },
    { label: 'mm project + inch flat', bar: MM_BAR, toolUnits: 'inch' as const, type: 'flat_endmill' as const, depth: 1.2 },
  ]

  for (const { label, bar, toolUnits, type, depth } of cases) {
    const stored = cutter(toolUnits, 'cut', type)
    loadRotary(bar, [stored])
    const before = structuredClone(store().project.tools)
    const expected = expectedFor(bar.units, stored)

    const start = bar.units === 'inch' ? 1.5 : 20
    const length = bar.units === 'inch' ? 3 : 50
    const result = store().addRotaryPattern({ kind: 'flutes', start, length, count: 4, twist: 1.5, depth, toolRef: 'cut' })
    assert.ok(result.ok, `${label}: flutes created (${result.ok ? '' : result.reason})`)
    if (!result.ok) throw new Error('unreachable')

    const project = store().project
    const operation = project.operations.find((entry) => entry.id === result.operationId)
    assert.ok(operation, `${label}: the operation exists`)
    near(operation.feed, expected.feed, `${label}: cut feed converted to project units`)
    near(operation.plungeFeed, expected.plungeFeed, `${label}: plunge feed converted to project units`)
    near(operation.stepdown, expected.stepdown, `${label}: stepdown converted to project units`)
    near(operation.carveDepth, depth, `${label}: carveDepth stays in project units`)
    assert.equal(operation.toolRef, 'cut', `${label}: the reference is the selected tool`)
    assert.deepEqual(project.tools, before, `${label}: the stored tool record is unchanged`)
    assert.equal(project.tools.length, 1, `${label}: no tool was added`)
    assert.equal(project.tools[0].units, toolUnits, `${label}: the tool keeps its own units`)
  }
}

// ── same-unit path unchanged ──────────────────────────────────

console.log('Testing the same-unit path seeds the tool values unchanged...')
{
  const cases = [
    { label: 'mm project + mm V-bit', bar: MM_BAR, units: 'mm' as const, type: 'v_bit' as const },
    { label: 'inch project + inch V-bit', bar: INCH_BAR, units: 'inch' as const, type: 'v_bit' as const },
    { label: 'mm project + mm ball', bar: MM_BAR, units: 'mm' as const, type: 'ball_endmill' as const },
    { label: 'inch project + inch flat', bar: INCH_BAR, units: 'inch' as const, type: 'flat_endmill' as const },
  ]

  for (const { label, bar, units, type } of cases) {
    const stored = cutter(units, 'same', type)
    loadRotary(bar, [stored])
    const depth = bar.units === 'inch' ? 0.1 : 1.2
    const start = bar.units === 'inch' ? 1.5 : 20
    const length = bar.units === 'inch' ? 3 : 50
    const input = type === 'v_bit'
      ? { kind: 'thread' as const, start, length, pitch: bar.units === 'inch' ? 0.05 : 2, depth }
      : { kind: 'flutes' as const, start, length, count: 4, twist: 0, depth, toolRef: 'same' }
    const result = store().addRotaryPattern(input)
    assert.ok(result.ok, `${label}: created (${result.ok ? '' : result.reason})`)
    if (!result.ok) throw new Error('unreachable')

    const operation = store().project.operations[0]
    assert.equal(operation.feed, stored.defaultFeed, `${label}: feed is the tool's own value`)
    assert.equal(operation.plungeFeed, stored.defaultPlungeFeed, `${label}: plunge feed is the tool's own value`)
    assert.equal(operation.stepdown, stored.defaultStepdown, `${label}: stepdown is the tool's own value`)
    assert.deepEqual(store().project.tools, [stored], `${label}: the stored tool is unchanged`)
    assert.equal(operation.toolRef, 'same', `${label}: the reference is unchanged`)
  }
}

// ── the real generation seam ──────────────────────────────────

console.log('Testing the converted stepdown drives real depth passes...')
{
  // An inch project with a mm V-bit: seeded raw, its 0.4 mm stepdown would be
  // read as 0.4 in and cut the 0.1 in thread in a single pass. Converted, the
  // 0.015748 in stepdown cuts several. The fixture stays small (2 in bar,
  // 0.1 in deep) so nothing is pathological.
  loadRotary(INCH_BAR, [cutter('mm', 'v1', 'v_bit')])
  const depth = 0.1
  const created = store().addRotaryPattern({ kind: 'thread', start: 1.5, length: 3, pitch: 0.05, depth })
  assert.ok(created.ok, 'the mismatched-tool thread is created')
  if (!created.ok) throw new Error('unreachable')

  const project = store().project
  const operation = project.operations.find((entry) => entry.id === created.operationId)
  assert.ok(operation, 'the operation exists')
  const envelope = computeOperationToolpath(project, operation)
  assert.ok(envelope, 'generation returns an envelope')
  const path = envelope.result
  assert.deepEqual(path.warnings, [], 'generation has no warnings')

  const cutZs = path.moves.filter((move) => move.kind === 'cut').map((move) => move.to.z)
  assert.ok(cutZs.length > 0, 'there are cutting moves')
  const levels = [...new Set(cutZs.map((z) => Math.round(z / 1e-6)))].map((key) => key * 1e-6).sort((a, b) => b - a)
  assert.ok(levels.length > 1, `the converted stepdown cuts more than one pass (got ${levels.length})`)
  assert.ok(levels[0] - levels[1] < project.stock.thickness, 'the first stepdown is a real project-unit step, not 0.4 in')
  near(Math.min(...cutZs), project.stock.thickness - depth, 'the deepest pass reaches the requested project-unit depth')
  const documented = Math.ceil(depth / (operation.stepdown ?? depth))
  assert.ok(levels.length <= documented, `no more distinct levels than documented stepdown passes (${levels.length} <= ${documented})`)

  // The bar really is the fixture, not a huge one: bounds confirm it.
  const bounds = getStockBounds(project.stock)
  near(bounds.maxY - bounds.minY, 8, 'the inch bar is 8 in long')
}

console.log('All existing-tool unit tests passed.')
