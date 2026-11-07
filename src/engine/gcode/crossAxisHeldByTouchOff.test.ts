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
 * #1156: an own-A program never writes its cross axis.
 *
 * gSender treats a whole file as four-axis when its text — with only `( … )`
 * comments removed — matches an A word **and** a Y word anywhere, and refuses
 * it. An around-the-bar program writes the bar's cross coordinate on every
 * motion line even though it never moves; the value is the centreline zero, so
 * the file carried 2,080 `Y0.0000` words and was refused. The program now writes
 * no cross word at all when the axis is held by touch-off, and the operator
 * zeroes it on the centreline exactly as a borrowed-motor program already asks.
 *
 * The golden this suite reads was frozen from the base commit **before** the
 * rule existed (`work/` script, one freeze, then this file). For a program the
 * rule holds, the emitted text must be that golden with every cross word
 * removed, plus the operator line slice ny-b adds, byte for byte — not merely
 * "no cross word", which a lost motion line would also satisfy. For a control,
 * one of the rule's four conditions fails and the bytes must be exactly the
 * golden's.
 *
 * Slice ny-b gives the rule programs a header line after `TOUCH OFF:` telling
 * the operator to zero that axis on the centreline, and rewords the measured
 * touch-off fallback so its `;` comment carries no `Y<digit>`/`Y <digit>` (or,
 * on a bar along Y, `X<digit>`) word. gSender strips only `( … )` comments
 * before its four-axis test, so the engine's own comment text has to pass it
 * too. User text — project, operation and tool names, setup notes — is not
 * sanitised; this suite's fixtures are chosen to carry none.
 *
 * Run with: npx tsx src/engine/gcode/crossAxisHeldByTouchOff.test.ts
 */

import assert from 'node:assert/strict'
import golden from './crossAxisHeldPrograms.golden.json'
import { parseGcodeMotion } from './gcodeMotionParser'
import type { ParsedGcodeMove } from './gcodeMotionParser'
import { createEmittedValueFormatter, crossAxisHeldByTouchOff } from './motionPipeline'
import { fitArcsInMachineMoves } from './arcFitting'
import { projectToMachinePoint } from './utils'
import { setupFrameForOperation } from '../setupOrientation'
import { exportGeometryTolerance } from '../../utils/units'
import { ownAMachine, machineWithToolChangeCommands } from '../../test/crossAxisPrograms'
import {
  crossAxisArcProgram,
  crossAxisJitterProgram,
  crossAxisLetter,
  crossAxisPrograms,
  renderCrossAxisProgram,
} from '../../test/crossAxisPrograms'
import type { CrossAxisProgram } from '../../test/crossAxisPrograms'
import { BUNDLED_DEFINITIONS } from './definitions'
import { validateMachineDefinition } from './types'
import type { MachineDefinition, PostProcessorInput } from './types'
import { defaultTool, newProject, rectProfile } from '../../types/project'
import type { MachineOrigin, Project } from '../../types/project'
import { setupHeaderLines } from './setupPrograms'
import { runPostProcessor } from './postprocessor'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { normalizeToolForProject } from '../toolpaths/geometry'
import type { ToolpathMove } from '../toolpaths/types'
import { pinRotaryAxis } from './types'

/** The rotary options every program here is parsed with: own-A grbl. */
const ROTARY_PARSE = {
  word: 'A' as const,
  inverseTimeFeed: { on: 'G93', off: 'G94' },
} as const

/** The emitted header carries the wall-clock date; nothing else is normalized. */
function normalizeDate(gcode: string): string {
  return gcode.replace(/\d{4}-\d{2}-\d{2}/g, '2000-01-01')
}

/** What gSender itself does before its axis test: drop `( … )` comments only. */
function withoutParenthesisedComments(text: string): string {
  return text.replace(/\([^)]*\)/g, ' ')
}

/**
 * The base commit's text with every cross-axis word removed, exactly as the
 * emitter would have written the block without it: a word in the middle of a
 * line takes the space that preceded it, and a leading word — a bar along Y
 * writes `X0.000` first — takes the space that followed it.
 */
function withoutCrossWords(text: string, letter: 'X' | 'Y'): string {
  const word = `${letter}-?[0-9.]+`
  return text
    .replace(new RegExp(`^${word} ?`, 'gm'), '')
    .replace(new RegExp(` ${word}`, 'g'), '')
}

function parsed(text: string): ParsedGcodeMove[] {
  // A program that retracts in machine coordinates or ends in inverse time is
  // reported as `unsupported`; the moves it did read are still the trace, and
  // the two texts are read the same way either way.
  return parseGcodeMotion(text, 'ij', ';', '', ROTARY_PARSE).moves
}

/** Every parsed position, block by block: X, Y, Z and A. */
function positions(moves: readonly ParsedGcodeMove[]): Array<Record<string, number | undefined>> {
  return moves.flatMap((move) => [
    { x: move.from.x, y: move.from.y, z: move.from.z, a: move.from.a },
    { x: move.to.x, y: move.to.y, z: move.to.z, a: move.to.a },
  ])
}

const PROGRAMS = crossAxisPrograms()

/** The operator line slice ny-b writes into a rule program's header. */
function heldCrossAxisLine(letter: 'X' | 'Y'): string {
  return `${letter} IS NOT WRITTEN: ZERO ${letter} ON THE BAR'S CENTRELINE AND LEAVE IT THERE`
}

/** The base commit's text with the operator line added after `TOUCH OFF:`. All
 *  the frozen rule programs sit on a named origin, so their touch-off text is
 *  unchanged by ny-b; the reworded fallback has its own case below. */
function withHeldCrossAxisLine(text: string, letter: 'X' | 'Y'): string {
  const lines = text.split('\n')
  const at = lines.findIndex((line) => line.includes('TOUCH OFF:'))
  assert.ok(at >= 0, 'the frozen program carries a touch-off line')
  return [...lines.slice(0, at + 1), `; ${heldCrossAxisLine(letter)}`, ...lines.slice(at + 1)].join('\n')
}

/** Every `IS NOT WRITTEN` line a program carries. */
function heldCrossAxisLinesIn(text: string): string[] {
  return text.split('\n').filter((line) => line.includes('IS NOT WRITTEN'))
}

// ── The frozen programs ───────────────────────────────────────

console.log('Testing every frozen program against the base commit...')
for (const program of PROGRAMS) {
  const result = renderCrossAxisProgram(program)
  assert.deepEqual(
    result.warnings,
    [],
    `${program.name}: the fixture must post cleanly, got ${JSON.stringify(result.warnings)}`,
  )
  const base = golden[program.name as keyof typeof golden]
  assert.ok(base !== undefined, `${program.name}: frozen in the golden`)
  const text = normalizeDate(result.gcode)
  const letter = crossAxisLetter(program)
  const gcodeOnly = withoutParenthesisedComments(text)

  if (program.holdsCrossAxis) {
    // 1. Today's text minus the cross words, plus the ny-b operator line,
    //    exactly. This is the assertion a lost motion line or a re-spaced block
    //    cannot sneak past.
    assert.equal(
      text,
      withHeldCrossAxisLine(withoutCrossWords(base, letter), letter),
      `${program.name}: the program is the base commit's with every ${letter} word removed and the operator line added`,
    )
    assert.notEqual(text, base, `${program.name}: the base text really did write the cross axis`)
    // 2. The controller's own test: the whole file, with only parenthesised
    //    comments removed, carries no cross word. A `;` comment counts, which is
    //    why the engine-written header must not spell one either.
    assert.ok(
      !new RegExp(`${letter}-?\\d`).test(gcodeOnly),
      `${program.name}: no ${letter}<digit> word anywhere in the file`,
    )
    assert.ok(
      !new RegExp(`${letter} \\d`).test(gcodeOnly),
      `${program.name}: no spaced ${letter} <digit> word either`,
    )
    // 3. The header says it once, and only a rule program gets it.
    assert.deepEqual(
      heldCrossAxisLinesIn(text),
      [`; ${heldCrossAxisLine(letter)}`],
      `${program.name}: exactly one operator line names the held axis`,
    )
    // 4. The position is unchanged: the parser reads the same X, Y, Z and A
    //    after every block of the new text as after the base commit's.
    const after = positions(parsed(text))
    const before = positions(parsed(base))
    assert.equal(after.length, before.length, `${program.name}: same block count as the base`)
    for (let index = 0; index < after.length; index += 1) {
      assert.deepEqual(
        after[index],
        before[index],
        `${program.name}: parsed position ${index} is unchanged (X, Y, Z and A)`,
      )
    }
  } else {
    // A control: one of the four conditions fails, so the bytes are today's.
    assert.equal(text, base, `${program.name}: unchanged — a control keeps the base commit's bytes`)
    assert.ok(
      new RegExp(`${letter}-?\\d`).test(gcodeOnly),
      `${program.name}: and still writes the cross axis`,
    )
    assert.deepEqual(
      heldCrossAxisLinesIn(text),
      [],
      `${program.name}: a control gets no operator line`,
    )
  }
}

// ── A bar along Y drops X, not Y ──────────────────────────────

console.log('Testing a bar along Y: the cross axis is X, the travel axis is Y...')
{
  const program = PROGRAMS.find((entry) => entry.name === 'along-bar-y-rough-mm')
  assert.ok(program, 'the bar-along-Y program is in the fixture set')
  assert.equal(crossAxisLetter(program), 'X', 'its cross axis is the machine X')
  const text = normalizeDate(renderCrossAxisProgram(program).gcode)
  const motion = withoutParenthesisedComments(text)
  assert.ok(!/X-?\d/.test(motion), 'no X word is written')
  assert.match(motion, /^Y[0-9.]+/m, 'and Y travel is still written, as a real axis')
  assert.ok(
    (motion.match(/\bY-?[0-9.]+/g) ?? []).length > 10,
    'the along-the-bar travel survives on many blocks',
  )
}

// ── The measured touch-off sentence (#1156 ny-b) ─────────────

console.log('Testing the reworded touch-off and the block control...')
{
  const grbl = bundledDefinition('grbl')
  const moved = (name: string, origin: Partial<MachineOrigin>): CrossAxisProgram => {
    const found = PROGRAMS.find((entry) => entry.name === name)
    assert.ok(found, `${name} is in the fixture set`)
    return {
      ...found,
      project: { ...found.project, origin: { ...found.project.origin, ...origin } },
    }
  }

  // A bar along X whose origin is 7 mm from the left end, on the centreline: the
  // named corner/edge positions do not describe it, so the measured fallback is
  // used — and a rule program must say the measured distance without spelling a
  // Y word in its `;` comment.
  const barX = moved('around-rough-mm', { x: 7 })
  const barXText = normalizeDate(renderCrossAxisProgram(barX).gcode)
  assert.equal(
    crossAxisHeldByTouchOff({
      project: barX.project,
      definition: barX.definition,
      operations: barX.operations,
      manualIndexAngle: null,
    }),
    'y',
    'an origin off the named X positions still holds Y on the centreline',
  )
  assert.ok(
    barXText.includes('; TOUCH OFF: X7 MM FROM THE LEFT END, Y ON THE CENTRELINE OF THE BAR SEEN FROM ABOVE, Z0 ON TOP OF THE BAR'),
    `the reworded touch-off line, exactly:\n${barXText.split('\n').slice(0, 8).join('\n')}`,
  )
  assert.ok(
    barXText.includes(`; ${heldCrossAxisLine('Y')}`),
    'and the header still names the held axis',
  )

  // A bar along Y: the cross axis is X and the along-bar distance is Y, which
  // may not be spelled as a Y word either. The sentence names the distance
  // without a letter and puts X on the centreline.
  const barY = moved('along-bar-y-rough-mm', { y: 7 })
  const barYText = normalizeDate(renderCrossAxisProgram(barY).gcode)
  assert.equal(
    crossAxisHeldByTouchOff({
      project: barY.project,
      definition: barY.definition,
      operations: barY.operations,
      manualIndexAngle: null,
    }),
    'x',
    'an origin off the named Y positions still holds X on the centreline',
  )
  assert.ok(
    barYText.includes('; TOUCH OFF: 23 MM FROM THE FRONT, X ON THE CENTRELINE OF THE BAR SEEN FROM ABOVE, Z0 ON TOP OF THE BAR'),
    `the reworded touch-off line on a bar along Y:\n${barYText.split('\n').slice(0, 8).join('\n')}`,
  )

  // The control: the same off-named placement on block stock, which the rule
  // never covers. Its header keeps today's `X… Y… FROM THE FRONT-LEFT CORNER`.
  const block = blockControlProgram()
  const blockHeader = setupHeaderLines(block.project, block.project.setups[0], grbl)
  assert.deepEqual(blockHeader, [
    'SETUP 01: Top - TOP FACE UP',
    'REGISTRATION: NONE DECLARED',
    'TOUCH OFF: X7 Y10 MM FROM THE FRONT-LEFT CORNER OF THE TOP FACE AS MOUNTED, Z0 ON THAT FACE',
  ], 'a block program keeps the measured corner sentence')
  const blockText = normalizeDate(runPostProcessor({
    project: block.project,
    definition: grbl,
    operations: block.operations,
    options: { emitToolChanges: false, emitCoolant: false, programName: block.project.meta.name },
  }).gcode)
  assert.ok(
    blockText.includes('; TOUCH OFF: X7 Y10 MM FROM THE FRONT-LEFT CORNER OF THE TOP FACE AS MOUNTED, Z0 ON THAT FACE'),
    'the block program really writes that sentence',
  )
  assert.deepEqual(heldCrossAxisLinesIn(blockText), [], 'and no operator line')
}

// ── The operator line only where the rule holds ──────────────

console.log('Testing that the operator line appears only in a rule program...')
{
  const holds = PROGRAMS.find((entry) => entry.name === 'smoke-rule-holds')
  assert.ok(holds, 'the smoke program is in the fixture set')
  const borrowedMachine: MachineDefinition = validateMachineDefinition({
    ...ownAMachine('x'),
    rotary: { ...ownAMachine('x').rotary!, drive: 'borrowed' },
  })
  const borrowedDecision = crossAxisHeldByTouchOff({
    project: holds.project,
    definition: borrowedMachine,
    operations: holds.operations,
    manualIndexAngle: null,
  })
  assert.equal(borrowedDecision, null, 'a borrowed-Y program is not the rule\'s (condition 1)')
  const borrowedHeader = setupHeaderLines(
    holds.project,
    holds.project.setups.find((setup) => setup.id === holds.project.activeSetupId)!,
    borrowedMachine,
    true,
    borrowedDecision,
  )
  assert.deepEqual(
    heldCrossAxisLinesIn(borrowedHeader.join('\n')),
    [],
    'so its header carries no operator line',
  )

  // Every bundled machine is non-rotary: a flat program on any of them can never
  // hold a cross axis, whatever the stock.
  const { project, operations } = blockControlProgram()
  for (const definition of BUNDLED_DEFINITIONS) {
    const decision = crossAxisHeldByTouchOff({
      project,
      definition,
      operations,
      manualIndexAngle: null,
    })
    assert.equal(decision, null, `${definition.id}: a non-rotary machine holds no cross axis`)
    const header = setupHeaderLines(project, project.setups[0], definition, true, decision)
    assert.deepEqual(
      heldCrossAxisLinesIn(header.join('\n')),
      [],
      `${definition.id}: and its header carries no operator line`,
    )
  }
}

/** One bundled machine definition, cloned and validated for a fixture. */
function bundledDefinition(id: string): MachineDefinition {
  const found = BUNDLED_DEFINITIONS.find((definition) => definition.id === id)
  assert.ok(found, `bundled definition ${id} exists`)
  return validateMachineDefinition(structuredClone(found))
}

/**
 * A block-stock project with two setups, so its program carries a header, and a
 * short flat toolpath — the control a rule program is compared with. Its origin
 * is off the named positions on both axes, like the rule program above.
 */
function blockControlProgram(): {
  project: Project
  operations: PostProcessorInput['operations']
} {
  const base = newProject('Block control', 'mm')
  const stock = { ...base.stock, profile: rectProfile(0, 0, 100, 80), thickness: 20 }
  const tool = {
    ...defaultTool('mm', 1),
    id: 't1',
    name: 'Flat',
    units: 'mm' as const,
    type: 'flat_endmill' as const,
    diameter: 3,
  }
  const secondSetup = { ...base.setups[0], id: 'setup-2', name: 'Second' }
  const project: Project = {
    ...base,
    stock,
    origin: { name: 'Origin', x: 7, y: 70, z: 20, visible: true },
    tools: [tool],
    setups: [base.setups[0], secondSetup],
    activeSetupId: base.setups[0].id,
  }
  const operation = {
    ...defaultOperationForTarget({ ...project, stock }, 'pocket', 'rough', { source: 'stock' }, 0),
    id: 'flat',
    name: 'Flat',
    setupId: base.setups[0].id,
    toolRef: 't1',
  }
  const moves: ToolpathMove[] = [
    { kind: 'rapid', from: { x: 10, y: 10, z: 20 }, to: { x: 20, y: 10, z: 20 } },
    { kind: 'cut', from: { x: 20, y: 10, z: 20 }, to: { x: 40, y: 20, z: 15 } },
  ]
  return {
    project: { ...project, operations: [operation] },
    operations: [{
      operation,
      tool: normalizeToolForProject(tool, project),
      toolpath: { operationId: operation.id, warnings: [], bounds: null, moves },
    }],
  }
}

// ── The decision itself ───────────────────────────────────────

console.log('Testing the decision directly: each condition withholds the rule...')
{
  const withName = (name: string): CrossAxisProgram => {
    const found = PROGRAMS.find((entry) => entry.name === name)
    assert.ok(found, `${name} is in the fixture set`)
    return found
  }
  const holds = withName('smoke-rule-holds')
  assert.equal(
    crossAxisHeldByTouchOff({
      project: holds.project,
      definition: holds.definition,
      operations: holds.operations,
      manualIndexAngle: null,
    }),
    'y',
    'an own-A around program on a centred bar holds Y',
  )
  assert.equal(
    crossAxisHeldByTouchOff({
      project: holds.project,
      definition: holds.definition,
      operations: holds.operations,
      manualIndexAngle: 0,
    }),
    null,
    'a manual-index program does not (condition 2)',
  )
  const offCentre = withName('control-origin-off-centreline')
  assert.equal(
    crossAxisHeldByTouchOff({
      project: offCentre.project,
      definition: offCentre.definition,
      operations: offCentre.operations,
      manualIndexAngle: null,
    }),
    null,
    'an origin off the centreline does not (condition 3)',
  )
  const toolChange = withName('control-tool-change-names-cross-axis')
  assert.equal(
    crossAxisHeldByTouchOff({
      project: toolChange.project,
      definition: toolChange.definition,
      operations: toolChange.operations,
      manualIndexAngle: null,
    }),
    null,
    'a tool-change template that names the cross letter does not (condition 4)',
  )
  // Condition 1: a borrowed motor is excluded because the letter carries the
  // angle there, which the borrowed path already handles on its own.
  const borrowed = {
    ...holds.definition.rotary!,
    drive: 'borrowed' as const,
  }
  assert.equal(
    crossAxisHeldByTouchOff({
      project: holds.project,
      definition: { ...holds.definition, rotary: borrowed },
      operations: holds.operations,
      manualIndexAngle: null,
    }),
    null,
    'a borrowed motor is not the rule\'s business (condition 1)',
  )
  // A manual-index program is the one machine case whose own opening turn writes
  // the angle; without any angle at all the program is not a turning one.
  const noAngle = holds.operations.map((entry) => ({
    ...entry,
    toolpath: {
      ...entry.toolpath,
      moves: entry.toolpath.moves.map((move) => {
        const { a: _a, ...from } = move.from
        const { a: _b, ...to } = move.to
        return { ...move, from, to }
      }),
    },
  }))
  assert.equal(
    crossAxisHeldByTouchOff({
      project: holds.project,
      definition: holds.definition,
      operations: noAngle,
      manualIndexAngle: null,
    }),
    null,
    'a program that never writes A is not a rotary program (condition 2)',
  )
}

// ── Physical lines and complete G-code words ─────────────────

console.log('Testing the template scan: physical lines and complete G-code words...')
{
  const holds = PROGRAMS.find((entry) => entry.name === 'smoke-rule-holds')
  assert.ok(holds, 'the smoke program is in the fixture set')
  const decision = (commands: string[]): 'x' | 'y' | null => crossAxisHeldByTouchOff({
    project: holds.project,
    definition: machineWithToolChangeCommands(...commands),
    operations: holds.operations,
    manualIndexAngle: null,
  })

  // The comment marker ends a *physical line*, not the template entry. Slicing
  // the entry at the first `;` hid the code on every later line, so the rule
  // held while the tool change moved Y and never restored the centreline
  // (#1156 correction round, finding 1).
  assert.equal(
    decision(['; comment\nG53 G0 Y-10']),
    null,
    'a cross-axis word after a line comment on the first physical line still counts',
  )
  // A home is a complete G-code word, not a substring: `G90G28` is G90 then
  // G28, `G028` is G28, and `G90G30` is G90 then G30. Each moves axes the line
  // does not name, so each withholds the rule.
  for (const home of ['G28', 'G90G28', 'G028', 'G90G30', 'G30', 'G28.1']) {
    assert.equal(
      decision([home]),
      null,
      `${home} homes the machine, so the program cannot hold its cross axis`,
    )
  }
  // The controls stay controls: prose is prose, and a line that moves no axis
  // of the cross pair changes nothing.
  assert.equal(decision(['; G53 G0 Y-10\n; G28']), 'y', 'comment prose is not code')
  assert.equal(decision(['G53 G0 X0']), 'y', 'a line that moves only the along axis is harmless')

  // Withheld means byte-identical: the added command is written and the
  // program keeps writing its cross words, exactly as before the rule.
  const control = {
    ...holds,
    definition: machineWithToolChangeCommands('; comment\nG53 G0 Y-10'),
  }
  assert.deepEqual(renderCrossAxisProgram(control).warnings, [], 'the control posts cleanly')
  const controlText = normalizeDate(renderCrossAxisProgram(control).gcode)
  assert.match(controlText, /G53 G0 Y-10/, 'the multi-line tool-change command is written')
  assert.match(controlText, /Y0\.000/, 'and the program keeps writing its cross words')
}

// ── The word goes, the block stays ───────────────────────────

console.log('Testing a sub-format cross move: only its word is removed...')
{
  // One rapid out to Y + 0.0001 mm and one back. Every point formats as the
  // machine's zero, so the rule holds; the two rapids are blocks of their own
  // because the *unformatted* cross coordinate changed, and each repeats the X
  // it already stated. Removing the coordinate from the plan instead of the
  // word dropped both blocks, including that X repetition
  // (#1156 correction round, finding 2).
  const held = crossAxisJitterProgram(0)
  const control = crossAxisJitterProgram(1)
  assert.equal(
    crossAxisHeldByTouchOff({
      project: held.project,
      definition: held.definition,
      operations: held.operations,
      manualIndexAngle: null,
    }),
    'y',
    'a cross coordinate that formats as zero holds the axis even when it jitters',
  )
  assert.equal(
    crossAxisHeldByTouchOff({
      project: control.project,
      definition: control.definition,
      operations: control.operations,
      manualIndexAngle: null,
    }),
    null,
    'shifting the origin off the centreline withholds the rule, giving today\'s bytes',
  )

  const heldText = normalizeDate(renderCrossAxisProgram(held).gcode)
  const controlText = normalizeDate(renderCrossAxisProgram(control).gcode)
  // The setup header names the origin, and the control's origin really moved,
  // so only the program body — from the first operation's comment on — is the
  // same input. Every motion block lives there.
  const body = (text: string): string => text.slice(text.search(/^; Operation 1:/m))
  // The control is today's block structure with a constant cross offset; the
  // held program must be that text with only the cross words removed.
  assert.equal(
    body(heldText),
    withoutCrossWords(body(controlText), 'Y'),
    'the held program body is the control with every Y word removed, byte for byte',
  )
  // The blocks the sub-format moves create are not one-offs: today's emitter
  // repeats its X word on each, and the held program must keep repeating it.
  // Three: the operation's own rapid and the two sub-format moves.
  const repeated = controlText.split('\n').filter((line) => line === 'X20.000 Y1.000')
  assert.ok(repeated.length >= 3, 'the control repeats X on the sub-format cross blocks')
  const kept = heldText.split('\n').filter((line) => line === 'X20.000')
  assert.ok(kept.length >= 3, 'and the held program keeps every one of those X words')
}

// ── The arc clause is a deciding half of condition 3 ────────

console.log('Testing that a fitted arc withholds the rule even when every cross word is zero...')
{
  /** How many emitted arc descriptors the planner's own fitting produces for a
   *  program, using the rule's probe inputs. */
  const machineArcs = (program: CrossAxisProgram): number => {
    const tolerance = exportGeometryTolerance(program.project.meta.units)
    let arcs = 0
    for (const { operation, toolpath } of program.operations) {
      const setup = setupFrameForOperation(program.project, operation)
      const moves = toolpath.moves.map((move) => ({
        ...move,
        from: projectToMachinePoint(move.from, program.project.origin, pinRotaryAxis(program.definition, null), setup),
        to: projectToMachinePoint(move.to, program.project.origin, pinRotaryAxis(program.definition, null), setup),
      }))
      arcs += fitArcsInMachineMoves(moves, tolerance, 90)
        .filter((step) => step.kind === 'arc').length
    }
    return arcs
  }

  /** The machine-frame cross coordinate of every planned point, formatted with
   *  the machine's own grid — condition 3's format half, read directly. */
  const machineCrossValues = (program: CrossAxisProgram): number[] => {
    const format = createEmittedValueFormatter(program.definition, program.project.meta.units)
    const letter = crossAxisLetter(program) === 'X' ? 'x' : 'y'
    const values: number[] = []
    for (const { operation, toolpath } of program.operations) {
      const setup = setupFrameForOperation(program.project, operation)
      for (const move of toolpath.moves) {
        for (const point of [move.from, move.to]) {
          const machine = projectToMachinePoint(
            point, program.project.origin, pinRotaryAxis(program.definition, null), setup,
          )
          values.push(format(machine[letter]))
        }
      }
    }
    return values
  }

  // Every program the rule holds has one constant machine coordinate in the XY
  // plane the fitter reads, so no run in it is an arc.
  for (const program of PROGRAMS.filter((entry) => entry.holdsCrossAxis)) {
    assert.equal(
      machineArcs(program),
      0,
      `${program.name}: a held cross axis leaves nothing to fit as an arc`,
    )
  }

  // A real 5 mm circle moves the cross coordinate off the centreline by the
  // radius, so condition 3's *format* half already withholds the rule.
  const arc = crossAxisArcProgram()
  assert.ok(machineArcs(arc) > 0, 'the arc-shaped program really is fitted as arcs')
  assert.equal(
    crossAxisHeldByTouchOff({
      project: arc.project,
      definition: arc.definition,
      operations: arc.operations,
      manualIndexAngle: null,
    }),
    null,
    'and it cannot hold the cross axis: its cross coordinate moves off the centreline',
  )

  // The same circle at radius 0.0004 mm — a quarter of the 0.001 mm grid the
  // default mm machine writes. The fitter's collinearity tolerance is 0.01 mm,
  // far coarser than the grid, so the crop is still fitted as four arcs while
  // every vertex formats as 0.000: the format half holds, and only the arc
  // clause withholds the rule. This is acceptance item 4's arc control; delete
  // the arc exclusion and the decision below flips to 'y'.
  const subFormatArc = crossAxisArcProgram(0.0004)
  assert.ok(machineArcs(subFormatArc) > 0, 'a sub-format circle is still fitted as arcs')
  const formatted = machineCrossValues(subFormatArc)
  assert.ok(formatted.length > 0, 'the sub-format program plans points')
  assert.deepEqual(
    [...new Set(formatted)],
    [0],
    'every formatted cross coordinate is the machine zero, so condition 3\'s format half holds',
  )
  assert.equal(
    crossAxisHeldByTouchOff({
      project: subFormatArc.project,
      definition: subFormatArc.definition,
      operations: subFormatArc.operations,
      manualIndexAngle: null,
    }),
    null,
    'a fitted arc withholds the rule on its own: an arc block writes both X and Y',
  )
}

// ── The control programs are only one condition away ─────────

console.log('Testing the controls differ from the rule program by one condition...')
{
  const holds = PROGRAMS.find((entry) => entry.name === 'smoke-rule-holds')
  const toolChange = PROGRAMS.find((entry) => entry.name === 'control-tool-change-names-cross-axis')
  const offCentre = PROGRAMS.find((entry) => entry.name === 'control-origin-off-centreline')
  const manualIndex = PROGRAMS.find((entry) => entry.name === 'control-manual-index-top-setup')
  assert.ok(holds && toolChange && offCentre && manualIndex, 'all four smoke programs are present')
  assert.notEqual(toolChange.definition, holds.definition, 'the tool-change control has its own machine')
  assert.notEqual(
    toolChange.definition.toolChange.commands,
    holds.definition.toolChange.commands,
    'only its tool-change commands differ',
  )
  assert.notEqual(offCentre.project.origin.y, holds.project.origin.y, 'the off-centre control moved the origin')
  assert.notEqual(manualIndex.project.activeSetupId, holds.project.activeSetupId, 'the manual-index control moved the setup')
  assert.equal(ownAMachine('x').rotary?.drive, 'own', 'the fixture machine is the own-drive one the issue names')
}
