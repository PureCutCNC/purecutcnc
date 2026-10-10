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
 * Tests for the dialect-neutral export pipeline (issue #953): program
 * sequencing, the drill-cycle transform and the safe-Z split of a rapid.
 *
 * These hold the decisions themselves. That every dialect writes them out is
 * held by the emitter tests, and the last test here checks both emitters
 * against one sequence so they cannot drift apart again.
 *
 * Run with: npx tsx src/engine/gcode/motionPipeline.test.ts
 */

import { defaultTool, newProject } from '../../types/project'
import type { Operation, Project, Tool } from '../../types/project'
import { normalizeToolForProject } from '../toolpaths/geometry'
import type { DrillCycle, ToolpathMove, ToolpathResult } from '../toolpaths/types'
import { BUNDLED_DEFINITIONS } from './definitions'
import { planDrillCycles, planPlasmaGcodeCut, planProgramSequence, plasmaSheetZ, splitRapid } from './motionPipeline'
import type { OperationSequence } from './motionPipeline'
import { runPostProcessor } from './postprocessor'
import { validateMachineDefinition } from './types'
import type { MachineDefinition, PostProcessorInput, PostProcessorOptions } from './types'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
  )
}

// ── Fixtures ──────────────────────────────────────────────────

function bundled(id: string, overrides?: Partial<MachineDefinition>): MachineDefinition {
  const found = BUNDLED_DEFINITIONS.find((definition) => definition.id === id)
  if (!found) throw new Error(`Fixture error: no bundled definition "${id}"`)
  return validateMachineDefinition({ ...structuredClone(found), ...overrides })
}

function makeProject(toolCount: number): Project {
  const project = newProject('Sequence Test', 'mm')
  project.origin = { ...project.origin, x: 0, y: 0, z: 0 }
  project.tools = Array.from({ length: toolCount }, (_, index): Tool => ({
    ...defaultTool('mm', index + 1),
    id: `t${index + 1}`,
    name: `Tool ${index + 1}`,
  }))
  return project
}

function makeOperation(id: string, toolRef: string, overrides?: Partial<Operation>): Operation {
  return {
    id,
    name: `Op ${id}`,
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'stock' },
    toolRef,
    stepdown: 1,
    stepover: 0.4,
    feed: 600,
    plungeFeed: 180,
    rpm: 12000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 1,
    maxCarveDepth: 1,
    ...overrides,
  }
}

const MOVES: ToolpathMove[] = [
  { kind: 'rapid', from: { x: 0, y: 0, z: 5 }, to: { x: 10, y: 5, z: 5 } },
  { kind: 'plunge', from: { x: 10, y: 5, z: 5 }, to: { x: 10, y: 5, z: -1 } },
  { kind: 'cut', from: { x: 10, y: 5, z: -1 }, to: { x: 20, y: 5, z: -1 } },
  { kind: 'rapid', from: { x: 20, y: 5, z: -1 }, to: { x: 20, y: 5, z: 5 } },
]

/** `[toolRef, rpm]` per operation, as a postprocessor input. */
function programInput(
  spec: Array<[string, number]>,
  options: Partial<PostProcessorOptions> = {},
  toolCount = 2,
): Omit<PostProcessorInput, 'definition'> {
  const project = makeProject(toolCount)
  return {
    project,
    operations: spec.map(([toolRef, rpm], index) => {
      const toolRecord = project.tools.find((tool) => tool.id === toolRef)
      if (!toolRecord) throw new Error(`Fixture error: no tool "${toolRef}"`)
      const operation = makeOperation(`op${index + 1}`, toolRef, { rpm })
      const toolpath: ToolpathResult = { operationId: operation.id, warnings: [], bounds: null, moves: MOVES }
      return { operation, tool: normalizeToolForProject(toolRecord, project), toolpath }
    }),
    options: { emitToolChanges: true, emitCoolant: false, ...options },
  }
}

function sequenceOf(
  spec: Array<[string, number]>,
  options: Partial<PostProcessorOptions> = {},
  coolant = false,
): OperationSequence[] {
  return planProgramSequence(programInput(spec, options), { coolant })
}

/** The spindle decisions of a sequence, one compact row per operation. */
function spindleRows(sequence: OperationSequence[]): string[] {
  return sequence.map((step) => [
    step.changeTool ? `change:T${step.toolNumber}` : 'keep',
    step.startSpindle ? `start:${step.rpm}` : 'running',
    step.stopSpindleAfter ? 'stop' : 'run-on',
  ].join(' '))
}

// ── Program sequencing ────────────────────────────────────────

function testSpindleSpeedChangeIsRestated(): void {
  console.log('Testing a speed change between operations on one tool restates the spindle...')
  // The defect this file exists for: 12000 then 18000 on the same tool. The
  // second operation must not inherit the first one's speed.
  assertEqual(spindleRows(sequenceOf([['t1', 12000], ['t1', 18000], ['t1', 18000]])), [
    'change:T1 start:12000 run-on',
    'keep start:18000 run-on',
    'keep running stop',
  ], 'same tool, new speed')

  // The dangerous direction with tool changes off: a second tool that would
  // otherwise inherit the first tool's speed.
  const disabled = sequenceOf([['t1', 18000], ['t2', 9000]], { emitToolChanges: false })
  assertEqual(spindleRows(disabled), ['keep start:18000 run-on', 'keep start:9000 stop'], 'tool changes off')
  assertEqual(disabled[0].warnings, [], 'the first operation holds whatever tool is in the machine')
  assertEqual(disabled[1].warnings.map((warning) => warning.code), ['postToolChangesDisabled'],
    'the change that is not written is reported')
}

function testSpindleStopsAroundToolChanges(): void {
  console.log('Testing the spindle is stopped before a written tool change and at the end...')
  const sequence = sequenceOf([['t1', 12000], ['t2', 12000], ['t2', 12000], ['t1', 12000]])
  assertEqual(spindleRows(sequence), [
    'change:T1 start:12000 stop',
    // Same speed as before, but the spindle was stopped for the change.
    'change:T2 start:12000 run-on',
    'keep running stop',
    'change:T1 start:12000 stop',
  ], 'tool changes')
  // The stop belongs to the operation *before* the change, so the spindle is
  // never running when a tool change is reached.
  assert(sequence.every((step) => !step.spindleRunningAtToolChange), 'no tool change is reached with the spindle running')
  assert(sequence.every((step) => step.warnings.length === 0), 'a written tool change is not a warning')

  // Without tool changes the spindle runs through and stops once, at the end.
  assertEqual(
    spindleRows(sequenceOf([['t1', 12000], ['t2', 12000], ['t1', 12000]], { emitToolChanges: false })),
    ['keep start:12000 run-on', 'keep running run-on', 'keep running stop'],
    'tool changes off',
  )
  assertEqual(planProgramSequence(programInput([]), { coolant: false }), [], 'an empty program has no sequence')
}

function testToolChangeTrackingWithChangesOff(): void {
  console.log('Testing the held tool is tracked even when changes are not written (issue #755)...')
  // t1, t2, t2, t1: two real changes. Returning to t2 is not a third.
  const sequence = sequenceOf([['t1', 12000], ['t2', 12000], ['t2', 12000], ['t1', 12000]], { emitToolChanges: false })
  assertEqual(sequence.map((step) => step.warnings.length), [0, 1, 0, 1], 'one warning per unwritten change')
  assertEqual(sequence[1].warnings[0], {
    code: 'postToolChangesDisabled',
    params: { operation: 'Op op2', tool: 'Tool 2' },
  }, 'the warning names the operation and the tool it needs')
}

function testCoolant(): void {
  console.log('Testing coolant starts once where it exists and is reported where it does not...')
  const spec: Array<[string, number]> = [['t1', 12000], ['t1', 12000], ['t2', 12000]]
  const withCoolant = sequenceOf(spec, { emitCoolant: true }, true)
  assertEqual(withCoolant.map((step) => step.startCoolant), [true, false, false], 'coolant comes on once')
  assert(withCoolant.every((step) => step.warnings.length === 0), 'nothing to report when the machine has coolant')

  const without = sequenceOf(spec, { emitCoolant: true }, false)
  assertEqual(without.map((step) => step.startCoolant), [false, false, false], 'nothing to start without coolant commands')
  assertEqual(without.map((step) => step.warnings.map((warning) => warning.code)), [
    ['postNoCoolantCommands'], ['postNoCoolantCommands'], ['postNoCoolantCommands'],
  ], 'the request is reported for every operation, never dropped')

  const notAsked = sequenceOf(spec, { emitCoolant: false }, true)
  assertEqual(notAsked.map((step) => step.startCoolant), [false, false, false], 'coolant is not started unasked')
}

function testFeedsSpeedsAndToolNumbers(): void {
  console.log('Testing feeds, speed and tool number fall back the same way for every dialect...')
  const input = programInput([['t2', 12000]])
  const { operation, tool } = input.operations[0]
  const [own] = planProgramSequence(input, { coolant: false })
  assertEqual([own.toolNumber, own.rpm, own.cutFeed, own.plungeFeed], [2, 12000, 600, 180], 'the operation’s own values')

  // Zero means "use the tool's".
  Object.assign(operation, { feed: 0, plungeFeed: 0, rpm: 0 })
  const [fallback] = planProgramSequence(input, { coolant: false })
  assertEqual(
    [fallback.rpm, fallback.cutFeed, fallback.plungeFeed],
    [tool.defaultRpm, tool.defaultFeed, tool.defaultPlungeFeed],
    'tool defaults',
  )

  // A tool that is not in the project's list is written as tool 1.
  input.project.tools = []
  assert(planProgramSequence(input, { coolant: false })[0].toolNumber === 1, 'an unlisted tool is tool 1')
}

// ── Both emitters follow the one sequence ─────────────────────

/** Spindle and tool-change lines of a program, reduced to dialect-neutral events. */
function sequenceEvents(program: string, dialect: 'gcode' | 'opensbp'): string[] {
  const events: string[] = []
  const lines = program.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (dialect === 'gcode') {
      const start = /^M3 S(\d+)/.exec(line)
      if (start) events.push(`start:${Number(start[1])}`)
      else if (line === 'M5') events.push('stop')
      else if (/^M6\b/.test(line) || /^T\d+ M6/.test(line)) events.push('change')
    } else {
      const speed = /^TR,(\d+)$/.exec(line)
      if (speed) {
        assert(lines[index + 1] === 'C6', `TR on line ${index + 1} must be followed by C6, got "${lines[index + 1]}"`)
        events.push(`start:${Number(speed[1])}`)
      } else if (line === 'C7') events.push('stop')
      else if (line === 'C9') events.push('change')
      else if (line === 'END') break
    }
  }
  return events
}

function expectedEvents(sequence: OperationSequence[]): string[] {
  return sequence.flatMap((step) => [
    ...(step.changeTool ? ['change'] : []),
    ...(step.startSpindle ? [`start:${step.rpm}`] : []),
    ...(step.stopSpindleAfter ? ['stop'] : []),
  ])
}

function testBothDialectsWriteTheSameSequence(): void {
  console.log('Testing the G-code and ShopBot emitters write the same spindle and tool sequence...')
  // A G-code machine whose tool change is a bare M6, so every M5 in the
  // program is a spindle stop the sequence asked for.
  const grbl = bundled('grbl')
  const gcode = validateMachineDefinition({
    ...grbl,
    toolChange: { ...grbl.toolChange, commands: ['M6'], pauseAfterChange: false },
  })
  const shopbot = bundled('shopbot')

  const programs: Array<[string, Array<[string, number]>, Partial<PostProcessorOptions>]> = [
    ['one tool, speed changes', [['t1', 12000], ['t1', 18000], ['t1', 18000], ['t1', 9000]], {}],
    ['tool changes', [['t1', 12000], ['t2', 16000], ['t2', 16000], ['t1', 12000]], {}],
    ['tool changes off', [['t1', 18000], ['t2', 9000], ['t2', 9000]], { emitToolChanges: false }],
    ['single operation', [['t1', 12000]], {}],
  ]
  for (const [label, spec, options] of programs) {
    const input = programInput(spec, options)
    const expected = expectedEvents(planProgramSequence(input, { coolant: false }))
    assert(expected.some((event) => event.startsWith('start:')), `${label}: fixture should start the spindle`)
    assertEqual(sequenceEvents(runPostProcessor({ ...input, definition: gcode }).gcode, 'gcode'), expected, `${label}: G-code`)
    assertEqual(sequenceEvents(runPostProcessor({ ...input, definition: shopbot }).gcode, 'opensbp'), expected, `${label}: ShopBot`)
  }
}

function testGcodeCoolantStartsOnce(): void {
  console.log('Testing G-code turns coolant on once, where the machine has it...')
  const grbl = bundled('grbl')
  const withCoolant = validateMachineDefinition({
    ...grbl,
    coolant: { floodOnCommand: 'M8', mistOnCommand: 'M7', coolantOffCommand: 'M9' },
  })
  const input = programInput([['t1', 12000], ['t1', 12000], ['t2', 12000]], { emitCoolant: true })
  const result = runPostProcessor({ ...input, definition: withCoolant })
  assertEqual(result.gcode.split('\n').filter((line) => line === 'M8'), ['M8'], 'flood coolant lines')
  assertEqual(result.warnings, [], 'nothing to report')

  // The same program on a machine without coolant commands writes none and says so.
  const without = runPostProcessor({ ...input, definition: grbl })
  assert(!without.gcode.split('\n').includes('M8'), 'no coolant line without coolant commands')
  assertEqual(without.warnings.map((warning) => warning.code),
    ['postNoCoolantCommands', 'postNoCoolantCommands', 'postNoCoolantCommands'], 'the request is reported')

  // And not at all when coolant was not asked for.
  const notAsked = runPostProcessor({ ...programInput([['t1', 12000]]), definition: withCoolant })
  assert(!notAsked.gcode.split('\n').includes('M8'), 'coolant is not written unasked')
}

// ── Drill cycles ──────────────────────────────────────────────

function testDrillCycleTransform(): void {
  console.log('Testing drill cycles are transformed into machine coordinates...')
  const project = makeProject(1)
  project.origin = { ...project.origin, x: 5, y: 100, z: 20 }
  const cycles: DrillCycle[] = [
    { x: 25, y: 40, clearZ: 30, retractZ: 22, bottomZ: 8, drillType: 'peck', peckDepth: 2 },
    { x: 45, y: 70, clearZ: 30, retractZ: 22, bottomZ: 14, drillType: 'peck', peckDepth: 2 },
  ]
  // Machine = (x − origin.x, origin.y − y, z − origin.z): project Y is down.
  const operation = makeOperation('drill', 't1', { kind: 'drilling' })
  const planned = planDrillCycles(project, bundled('grbl'), cycles, operation)
  assertEqual(planned.map(({ at, clear, bottomZ, retractZ }) => ({ at, clear, bottomZ, retractZ })), [
    { at: { x: 20, y: 60 }, clear: { x: 20, y: 60, z: 10 }, bottomZ: -12, retractZ: 2 },
    { at: { x: 40, y: 30 }, clear: { x: 40, y: 30, z: 10 }, bottomZ: -6, retractZ: 2 },
  ], 'identity axes')
  assert(planned[0].cycle === cycles[0], 'the source cycle rides along for its drill type and peck depth')

  // A mirrored X axis mirrors the hole positions and nothing else.
  const mirrored = bundled('grbl', { coordinateSystem: { xAxis: '-X', yAxis: 'Y', zAxis: 'Z' } })
  assertEqual(planDrillCycles(project, mirrored, cycles, operation).map((cycle) => [cycle.at, cycle.bottomZ]), [
    [{ x: -20, y: 60 }, -12],
    [{ x: -40, y: 30 }, -6],
  ], 'mirrored X')
}

// ── Rapid split ───────────────────────────────────────────────

function testSplitRapid(): void {
  console.log('Testing a rapid is split into Z first, then XY...')
  const at = { x: 1, y: 2, z: 5 }
  assertEqual(splitRapid(null, { x: 10, y: 20, z: 5 }), [{ z: 5 }, { x: 10, y: 20 }], 'from an unknown position both blocks are written')
  assertEqual(splitRapid(at, { x: 10, y: 20, z: 30 }), [{ z: 30 }, { x: 10, y: 20 }], 'Z and XY together: Z first')
  assertEqual(splitRapid(at, { x: 1, y: 2, z: 30 }), [{ z: 30 }], 'Z alone')
  assertEqual(splitRapid(at, { x: 10, y: 2, z: 5 }), [{ x: 10, y: 2 }], 'X alone moves the XY pair')
  assertEqual(splitRapid(at, { x: 1, y: 20, z: 5 }), [{ x: 1, y: 20 }], 'Y alone moves the XY pair')
  assertEqual(splitRapid(at, { ...at }), [], 'a rapid to where the tool already is writes nothing')
}

function testGcodeRapidsUseTheSplit(): void {
  console.log('Testing G-code rapids are written Z first, then XY...')
  // Held here as well as in the ShopBot tests: the safe-Z order of a G-code
  // program must not depend on another dialect's test to stay correct.
  const input = programInput([['t1', 12000]])
  input.operations[0].toolpath.moves = [
    { kind: 'rapid', from: { x: 0, y: 0, z: 5 }, to: { x: 10, y: 5, z: 5 } },
    { kind: 'plunge', from: { x: 10, y: 5, z: 5 }, to: { x: 10, y: 5, z: -1 } },
    // One rapid that rises and travels: it must rise before it travels.
    { kind: 'rapid', from: { x: 10, y: 5, z: -1 }, to: { x: 40, y: 25, z: 5 } },
  ]
  const program = runPostProcessor({ ...input, definition: bundled('grbl', { motion: { ...bundled('grbl').motion, modalMotion: false } }) }).gcode
  const rapids = program.split('\n').filter((line) => line.startsWith('G0 '))
  assertEqual(rapids, ['G0 Z5.000', 'G0 X10.000 Y-5.000', 'G0 Z5.000', 'G0 X40.000 Y-25.000'], 'G0 blocks')
}

testSpindleSpeedChangeIsRestated()
testSpindleStopsAroundToolChanges()
testToolChangeTrackingWithChangesOff()
testCoolant()
testFeedsSpeedsAndToolNumbers()
testBothDialectsWriteTheSameSequence()
testGcodeCoolantStartsOnce()
testDrillCycleTransform()
testSplitRapid()
testGcodeRapidsUseTheSplit()

console.log('motion pipeline tests passed')


// Both plasma pierce modes are delivered now (#959, #983). A plasma machine
// takes the shared plasma sequence, so a milling operation is skipped with a
// warning and nothing of it is emitted.
{
  const input = programInput([['t1', 12000], ['t2', 12000]])
  const result = runPostProcessor({ ...input, definition: bundled('grbl-plasma') })
  assertEqual(result.warnings, [
    { code: 'postPlasmaOperationSkipped', params: { operation: 'Op op1' } },
    { code: 'postPlasmaOperationSkipped', params: { operation: 'Op op2' } },
  ], 'a G-code pierce machine skips milling operations and reports nothing else')
  assert(!/^G[0-3]\b|^M[345]\b/m.test(result.gcode), 'a skipped operation emits no motion, spindle or torch')
}

// The sheet surface of a G-code pierce cut (#983) is the stock top mapped like
// any toolpath point, so it follows the origin and the machine's own Z axis.
// The safe height measured from it is what a program writes after a touch-off.
{
  const project = makeProject(1)
  project.stock.thickness = 6
  const operation = makeOperation('op1', 't1', { kind: 'plasma_profile' })
  const grblPlasma = bundled('grbl-plasma')
  for (const originZ of [6, 0, 26]) {
    const placed = { ...project, origin: { ...project.origin, z: originZ } }
    assertEqual(plasmaSheetZ(placed, grblPlasma, operation), 6 - originZ, `sheet surface with Z zero at ${originZ}`)
    const inverted = { ...grblPlasma, coordinateSystem: { ...grblPlasma.coordinateSystem, zAxis: '-Z' as const } }
    assertEqual(plasmaSheetZ(placed, inverted, operation), originZ - 6, `sheet surface on an inverted Z axis, Z zero at ${originZ}`)
    // Toolpath safe Z 11 in project Z is 11 - originZ on the machine, and 5
    // above the sheet wherever the operator's zero is.
    const cut = planPlasmaGcodeCut({
      tool: normalizeToolForProject(placed.tools[0], placed),
      touchOff: grblPlasma.plasma!.touchOff!,
      units: 'mm',
      safeZ: 11 - originZ,
      sheetZ: plasmaSheetZ(placed, grblPlasma, operation),
    })
    assertEqual([cut.safeZ, cut.sheetSafeZ], [11 - originZ, 5], `safe height in both frames, Z zero at ${originZ}`)
  }
}

// Tool-change capability on a router: an empty or comment-only change sequence
// cannot execute a change, so the actual second tool is disclosed; an
// executable command or a pause clears it, and one tool raises nothing. Held
// here with a router definition, since a plasma machine ignores the flag.
{
  const input = programInput([['t1', 12000], ['t2', 12000]])
  const definition = bundled('grbl', { toolChange: { ...bundled('grbl').toolChange, commands: [], pauseAfterChange: false } })
  for (const commands of [[], [' ', '; comment only', ';also a comment']]) {
    const silent = runPostProcessor({ ...input, definition: { ...definition, toolChange: { ...definition.toolChange, commands } } })
    assertEqual(silent.warnings.filter((warning) => warning.code === 'postNoToolChangeCommands'), [{ code: 'postNoToolChangeCommands', params: { operation: 'Op op2', tool: 'Tool 2' } }], 'comments do not execute a tool change')
  }
  const sameTool = runPostProcessor({ ...programInput([['t1', 12000], ['t1', 12000]]), definition })
  assert(!sameTool.warnings.some((warning) => warning.code === 'postNoToolChangeCommands'), 'no false change warning on one tool')
  for (const toolChange of [{ ...definition.toolChange, commands: ['T{toolNumber} M6'] }, { ...definition.toolChange, pauseAfterChange: true }]) {
    const executable = runPostProcessor({ ...input, definition: { ...definition, toolChange } })
    assert(!executable.warnings.some((warning) => warning.code === 'postNoToolChangeCommands'), 'executable change or pause clears warning')
  }
}

// A QtPlasmaC program writes its torch path (#959): milling operations have
// none, so each is left out with a warning and nothing of it is emitted.
{
  const input = programInput([['t1', 12000], ['t2', 12000]])
  const result = runPostProcessor({ ...input, definition: bundled('qtplasmac') })
  assertEqual(result.warnings, [
    { code: 'postPlasmaOperationSkipped', params: { operation: 'Op op1' } },
    { code: 'postPlasmaOperationSkipped', params: { operation: 'Op op2' } },
  ], 'every milling operation is skipped, and nothing else is reported')
  assert(!/^G[0-3]\b|^M[345]\b/m.test(result.gcode), 'a skipped operation emits no motion, spindle or torch')
}
