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
 * A rapid after a Z-moving template must not trust the tracked Z (#1057).
 *
 * A machine template can move the machine behind the emitter's back. The
 * emitter marks Z unknown when one can (a Z word, a canned cycle, a macro, a
 * tool change), but the next operation's first rapid used to be split against
 * the stale position. When that rapid's target Z equalled the stale one — the
 * planned retract — the Z block was dropped and the XY rapid ran at whatever
 * height the template left, below the material in the repro.
 *
 * These tests post real programs through `runPostProcessor`, in both dialects,
 * and assert the emitted order: the retract block precedes the XY rapid.
 * Mutations that must fail them:
 * - `splitRapid` trusting the tracked Z again (no `zKnown` argument from the
 *   G-code emitter) → the two-operation G-code cases write the XY block with
 *   no preceding Z, and the failure names the missing retract;
 * - dropping the template -> unknown-Z link (`emitTemplateLine` not clearing
 *   `state.zKnown`) → all of those cases fail the same way;
 * - treating an O-word as inert (the pre-review rule only distrusted unknown
 *   `G`/`M` words) → the `o<toolchange> call` case writes the XY rapid with no
 *   preceding Z, because the scan saw no command at all;
 * - dropping the controller-owned plasma handling (the `plasmaTorch` guard in
 *   `restateSafeZBeforeTravel`) → the QtPlasmaC program grows a Z block before
 *   every XY travel, which the controller-owned test rejects;
 * - treating a motion block with no Z as Z-moving (the pre-review rule) → the
 *   `G0 X0` byte-identity case gains a Z block its comment-twin does not;
 * - dropping `!state.zKnown` from the canned-cycle or plasma safe-Z checks →
 *   their positioning rapid is written at the template's height.
 *
 * Run with: npx tsx src/engine/gcode/templateZRetract.test.ts
 */

import assert from 'node:assert/strict'
import { defaultTool, newProject, rectProfile } from '../../types/project'
import type { Operation, Project, Tool } from '../../types/project'
import { withBottomSetup } from '../../test/projectFixtures'
import { exportPlasma, rectangle } from '../../test/plasmaExportFixtures'
import { normalizeToolForProject } from '../toolpaths/geometry'
import type { ToolpathMove, ToolpathResult } from '../toolpaths/types'
import { BUNDLED_DEFINITIONS } from './definitions'
import { runPostProcessor } from './postprocessor'
import { validateMachineDefinition } from './types'
import type { MachineDefinition } from './types'

function bundled(id: string): MachineDefinition {
  return validateMachineDefinition(structuredClone(BUNDLED_DEFINITIONS.find((entry) => entry.id === id)!))
}

/** The two tools the repro changes between. */
function tools(): Tool[] {
  return [
    { ...defaultTool('mm', 1), id: 't1', name: 'Tool 1' },
    { ...defaultTool('mm', 1), id: 't2', name: 'Tool 2' },
  ]
}

function makeOperation(id: string, toolRef: string): Operation {
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
  }
}

/**
 * A 100 × 80 × 20 block at (0, 0). `bottom` moves both operations into the
 * Bottom setup; Top uses the default one. Project Z −5 is the clearance a
 * flipped (Bottom) part asks for, project Z 25 the Top one, and both map to
 * the machine's Z5 so operation two's first rapid targets the stale height.
 */
function makeProject(toolIds: readonly string[], bottom: boolean): Project {
  const base = newProject(bottom ? 'Template Z bottom' : 'Template Z top', 'mm')
  base.stock = { ...base.stock, profile: rectProfile(0, 0, 100, 80), thickness: 20 }
  base.origin = { name: 'Origin', x: 0, y: 80, z: 20, visible: true }
  base.tools = tools()
  base.operations = toolIds.map((toolId, index) => ({
    ...makeOperation(`op${index + 1}`, toolId),
    setupId: base.activeSetupId,
  }))
  return bottom
    ? withBottomSetup(base, { axis: 'x', operationIds: base.operations.map((operation) => operation.id) })
    : base
}

/**
 * The pass each operation holds: it ends at clearance, where the previous
 * operation left the tool. Operation two's planned retract to the same height
 * is the block a stale Z drops.
 */
const TOP_MOVES: ToolpathMove[] = [
  { kind: 'rapid', from: { x: 0, y: 0, z: 25 }, to: { x: 10, y: 70, z: 25 } },
  { kind: 'plunge', from: { x: 10, y: 70, z: 25 }, to: { x: 10, y: 70, z: 15 } },
  { kind: 'cut', from: { x: 10, y: 70, z: 15 }, to: { x: 30, y: 70, z: 15 } },
  { kind: 'rapid', from: { x: 30, y: 70, z: 15 }, to: { x: 30, y: 70, z: 25 } },
]

const BOTTOM_MOVES: ToolpathMove[] = [
  { kind: 'rapid', from: { x: 0, y: 0, z: -5 }, to: { x: 10, y: 70, z: -5 } },
  { kind: 'plunge', from: { x: 10, y: 70, z: -5 }, to: { x: 10, y: 70, z: 5 } },
  { kind: 'cut', from: { x: 10, y: 70, z: 5 }, to: { x: 30, y: 70, z: 5 } },
  { kind: 'rapid', from: { x: 30, y: 70, z: 5 }, to: { x: 30, y: 70, z: -5 } },
]

function post(project: Project, definition: MachineDefinition, moves: ToolpathMove[]): string {
  return runPostProcessor({
    project,
    definition,
    operations: project.operations.map((operation) => ({
      operation,
      tool: normalizeToolForProject(project.tools.find((tool) => tool.id === operation.toolRef)!, project),
      toolpath: { operationId: operation.id, warnings: [], bounds: null, moves } as ToolpathResult,
    })),
    options: { emitToolChanges: true, emitCoolant: false, programName: project.meta.name },
  }).gcode
}

/** Assert each fragment appears after the previous one, in order. */
function assertOrder(text: string, fragments: readonly string[], label: string): void {
  let at = -1
  for (const fragment of fragments) {
    const found = text.indexOf(fragment, at + 1)
    assert(found > at, `${label}: "${fragment}" must follow the previous line\n${text}`)
    at = found
  }
}

/** The program from the last occurrence of a template on, so earlier blocks cannot match. */
function afterLastTemplate(gcode: string, template: string): string {
  const at = gcode.lastIndexOf(template)
  assert(at >= 0, `fixture: the template ${JSON.stringify(template)} is written\n${gcode}`)
  return gcode.slice(at)
}

function machineWithToolChange(id: string, commands: string[]): MachineDefinition {
  const base = bundled(id)
  return { ...base, toolChange: { ...base.toolChange, commands } }
}

/** The program's code lines: blanks and dialect comments removed. */
function codeLines(gcode: string): string[] {
  return gcode.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith(';') && !line.startsWith('('))
}

/** The same bundled machine with one more operation-header template. */
function machineWithOperationHeader(id: string, template: string): MachineDefinition {
  const base = bundled(id)
  return {
    ...base,
    program: { ...base.program, operationHeader: [...base.program.operationHeader, template] },
  }
}

function testTwoToolsBottomGcode(): void {
  console.log('Testing the two-tool Bottom repro writes the retract before the XY rapid (G-code)...')
  const project = makeProject(['t1', 't2'], true)
  const definition = machineWithToolChange('grbl', ['M0 ; Tool change: {toolName}', 'G0 Z-2'])
  const tail = afterLastTemplate(post(project, definition, BOTTOM_MOVES), 'G0 Z-2')
  assertOrder(tail, ['G0 Z-2', 'Z5.000', 'X10.000 Y70.000'], 'the retract precedes the XY rapid')
  // The fixture proves the defect would move material: the rapid that follows
  // is the plunge into the part, and it must not run at the template's Z-2.
  assertOrder(tail, ['Z5.000', 'X10.000 Y70.000', 'Z-5.000'], 'the plunge follows the retract')
}

function testTwoToolsBottomShopBot(): void {
  console.log('Testing the two-tool Bottom repro writes the retract before the XY rapid (ShopBot)...')
  const project = makeProject(['t1', 't2'], true)
  const definition = machineWithToolChange('shopbot', ['M0 ; Tool change: {toolName}', 'G0 Z-2'])
  const tail = afterLastTemplate(post(project, definition, BOTTOM_MOVES), 'C9')
  // C9 is the tool-change macro and moves the machine, so the emitter already
  // treats the position as unknown. The assert pins that the shared code keeps
  // doing so after a Z-moving template is added beside it.
  assertOrder(tail, ['C9', 'JZ,5.000', 'J2,10.000,70.000'], 'the Z jog precedes the XY jog')
}

function testTwoToolsTopGcode(): void {
  console.log('Testing the two-tool Top repro writes the retract before the XY rapid (G-code)...')
  const project = makeProject(['t1', 't2'], false)
  const definition = machineWithToolChange('grbl', ['M0 ; Tool change: {toolName}', 'G0 Z-2'])
  const tail = afterLastTemplate(post(project, definition, TOP_MOVES), 'G0 Z-2')
  assertOrder(tail, ['G0 Z-2', 'Z5.000', 'X10.000 Y10.000'], 'the retract precedes the XY rapid')
}

function testSingleToolStartTemplate(): void {
  console.log('Testing a single-tool program with a Z-moving start template...')
  const project = makeProject(['t1'], false)
  const base = bundled('grbl')
  const definition: MachineDefinition = {
    ...base,
    program: { ...base.program, header: [...base.program.header, 'G0 Z-2'] },
  }
  const gcode = post(project, definition, TOP_MOVES)
  assertOrder(gcode, ['G0 Z-2', 'Z5.000', 'X10.000 Y10.000'], 'the first rapid restates Z before travelling')
}

function testSingleToolOperationHeaderTemplate(): void {
  console.log('Testing a single-tool program with a Z-moving operation template...')
  // No tool change is written (one tool), so the only Z-moving template is the
  // operation header before the second operation. Its stale tracked Z is the
  // first operation's clearance, exactly the height the next rapid targets.
  const project = makeProject(['t1', 't1'], false)
  const base = bundled('grbl')
  const definition: MachineDefinition = {
    ...base,
    program: { ...base.program, operationHeader: [...base.program.operationHeader, 'G0 Z-2'] },
  }
  const gcode = post(project, definition, TOP_MOVES)
  const second = gcode.slice(gcode.lastIndexOf('G0 Z-2'))
  assertOrder(second, ['G0 Z-2', 'Z5.000', 'X10.000 Y10.000'], 'the operation template is repaired by the next rapid')
}

function testCannedCyclePositioningAfterTemplate(): void {
  console.log('Testing canned-cycle positioning restates Z after a template...')
  // A canned cycle's positioning rapid is a rapid too: its clear plane is a
  // safe height, and the stale Z must not let the cycle start below it.
  const project = makeProject(['t1', 't1'], false)
  project.operations = project.operations.map((operation) => ({
    ...operation,
    kind: 'drilling' as const,
    drillType: 'simple' as const,
  }))
  const base = bundled('mach3')
  const definition: MachineDefinition = {
    ...base,
    program: { ...base.program, operationHeader: [...base.program.operationHeader, 'G0 Z-2'] },
  }
  const cycles = [{
    x: 20, y: 20, clearZ: 25, retractZ: 25, bottomZ: 15, drillType: 'simple' as const,
  }]
  const gcode = runPostProcessor({
    project,
    definition,
    operations: project.operations.map((operation) => ({
      operation,
      tool: normalizeToolForProject(project.tools[0], project),
      toolpath: {
        operationId: operation.id, warnings: [], bounds: null, moves: [], drillCycles: cycles,
      } as ToolpathResult,
    })),
    options: { emitToolChanges: true, emitCoolant: false, programName: project.meta.name },
  }).gcode
  const second = gcode.slice(gcode.lastIndexOf('G0 Z-2'))
  assertOrder(second, ['G0 Z-2', 'Z5.000', 'G81'], 'the cycle\'s clear plane is restored before the cycle')
}

function testPlasmaOperationHeaderTemplate(): void {
  console.log('Testing plasma per-cut positioning restates Z after a template...')
  // The G-code plasma path owns its own safe-Z rapid per cut. It is the same
  // rapid after the same template: a stale Z that equals the safe height must
  // not let the XY rapid run at the template's height.
  const { input } = exportPlasma({
    units: 'mm',
    thickness: 2,
    machineId: 'grbl-plasma',
    features: [
      { id: 'plate-a', operation: 'add', profile: rectangle(20, 20, 60, 40) },
      { id: 'plate-b', operation: 'add', profile: rectangle(100, 20, 60, 40) },
    ],
    operations: [{ featureIds: ['plate-a'] }, { featureIds: ['plate-b'] }],
  })
  const base = input.definition
  const definition: MachineDefinition = {
    ...base,
    program: { ...base.program, operationHeader: [...base.program.operationHeader, 'G0 Z-2'] },
  }
  const gcode = runPostProcessor({ ...input, definition }).gcode
  const template = 'G0 Z-2'
  const tail = gcode.slice(gcode.lastIndexOf(template) + template.length)
  const firstCodeLine = tail.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith(';') && !line.startsWith('('))
  assert.ok(firstCodeLine !== undefined, 'fixture: the second operation writes motion')
  assert.match(firstCodeLine, /^(G0 )?Z-?\d/, `the safe rapid precedes the XY rapid: ${firstCodeLine}`)
}

function testOwordCallTemplate(): void {
  console.log('Testing an O-word subroutine call in a template makes Z unknown...')
  // An O-word is the interpreter's subroutine/macro syntax. It has no G/M word
  // and no Z, so the old "unknown G/M command" scan called it inert — while the
  // subroutine it calls can move Z. The next rapid must restate Z.
  const project = makeProject(['t1', 't2'], true)
  const definition = machineWithToolChange('grbl', ['M0 ; Tool change: {toolName}', 'o<toolchange> call'])
  const tail = afterLastTemplate(post(project, definition, BOTTOM_MOVES), 'o<toolchange> call')
  assertOrder(tail, ['o<toolchange> call', 'Z5.000', 'X10.000 Y70.000'],
    'the retract precedes the XY rapid after an O-word call')
  assertOrder(tail, ['Z5.000', 'X10.000 Y70.000', 'Z-5.000'],
    'the plunge follows the retract, not the template')
}

function testControllerPlasmaZTemplate(): void {
  console.log('Testing a controller-owned plasma program leaves a template Z to the controller...')
  // Controller-owned piercing (QtPlasmaC) writes no Z of its own: the
  // controller's load filter comments out every Z word in a loaded program,
  // templates included, and keeps the torch height itself. A Z-moving template
  // therefore cannot leave an XY travel low, and the emitter must not add a
  // safe-Z block of its own (which the filter would strip anyway). The program
  // is byte-identical to the one without the template apart from the template
  // lines themselves (#1057, Codex review item 2).
  const spec = {
    units: 'mm' as const,
    thickness: 2,
    machineId: 'qtplasmac',
    features: [
      { id: 'plate-a', operation: 'add' as const, profile: rectangle(20, 20, 60, 40) },
      { id: 'plate-b', operation: 'add' as const, profile: rectangle(100, 20, 60, 40) },
    ],
    operations: [{ featureIds: ['plate-a'] }, { featureIds: ['plate-b'] }],
  }
  const template = 'G0 Z-2'
  const withTemplate = exportPlasma({
    ...spec,
    definition: (base) => ({
      ...base,
      program: { ...base.program, operationHeader: [...base.program.operationHeader, template] },
    }),
  }).result.gcode
  const plain = exportPlasma(spec).result.gcode
  const zLines = codeLines(withTemplate).filter((line) => /\bZ[-+]?[\d.]/.test(line))
  assert.deepEqual(zLines, [template, template],
    'the only Z words are the templates the controller filter strips; the emitter writes none')
  assert.deepEqual(codeLines(withTemplate).filter((line) => line !== template), codeLines(plain),
    'the controller-owned torch path is unchanged by a Z-moving template')
  // The first motion after the second operation's template is the XY rapid: no
  // safe-Z restatement, and the cut motion after torch-on writes no Z either.
  const after = codeLines(withTemplate.slice(withTemplate.lastIndexOf(template) + template.length))
  const first = after.find((line) => /^G[0-3]\b/.test(line) || /^[XY]-?\d/.test(line))
  assert.match(first ?? '', /^G0 X-?[\d.]+ Y-?[\d.]+$/, `the first motion after the template is XY only: ${first}`)
  assert.ok(after.every((line) => !/\bZ[-+]?[\d.]/.test(line)),
    'no XY or cut block after the template carries a Z')
}

function testMotionTemplateWithoutZByteIdentity(): void {
  console.log('Testing a motion template naming no Z leaves the program byte-identical...')
  // A motion block is not inert by itself, but it moves only what it names.
  // `G0 X0` names no Z, so the tracked Z is still provable and the program must
  // be byte-identical to the same program with the template written as a
  // comment: no Z block is added to the next rapid (#1057, Codex review item 3).
  const project = makeProject(['t1', 't1'], false)
  const motion = post(project, machineWithOperationHeader('grbl', 'G0 X0'), TOP_MOVES)
  const commented = post(project, machineWithOperationHeader('grbl', '; G0 X0'), TOP_MOVES)
  const without = (gcode: string, line: string) => gcode.split(/\r?\n/).filter((entry) => entry !== line)
  assert.deepEqual(without(motion, 'G0 X0'), without(commented, '; G0 X0'),
    'a motion template with no Z changes nothing but its own line')
  const after = motion.slice(motion.lastIndexOf('G0 X0') + 'G0 X0'.length)
  assert.equal(codeLines(after)[0], 'X10.000 Y10.000',
    'the next rapid states no Z because the template never moved it')
}

testTwoToolsBottomGcode()
testTwoToolsBottomShopBot()
testTwoToolsTopGcode()
testSingleToolStartTemplate()
testSingleToolOperationHeaderTemplate()
testCannedCyclePositioningAfterTemplate()
testPlasmaOperationHeaderTemplate()
testOwordCallTemplate()
testControllerPlasmaZTemplate()
testMotionTemplateWithoutZByteIdentity()

console.log('gcode template Z retract tests passed')
