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
 * #1103 slice ca-h, parts 2 and 3: the operation hand-off (#1152).
 *
 * An operation that commands A must leave the bar at a known orientation, and
 * the next operation must be able to start from it:
 *
 *  - after its own final retract the emitter proves clearance in machine
 *    coordinates (#1054) and turns the stock **forward** to the next whole
 *    turn — 0 up — then tells the operator where A is. No off-by-a-turn, no
 *    rewind, and nothing at all when the operation already ends on a whole
 *    turn (only the instruction);
 *  - a machine whose rotary block carries a **Zero A** line runs it at the
 *    start of every rotary operation, after a clearance retract and before the
 *    first turn; a machine without one pauses (`M0`) between two rotary
 *    operations so the operator can zero A by hand. There is no pause after
 *    the last rotary operation;
 *  - the Zero A line is machine text, so it is validated like the other
 *    templates: only the forms that set A zero and move nothing are accepted.
 *
 * Mutations proved caught by hand (see the slice report): dropping the pause
 * (the "M0 between two rotary operations" assertion fails), writing the Zero A
 * line before the clearance retract (the ordering assertion fails), turning
 * backward or before the retract (the end-turn assertions fail), and a moving
 * Zero A line (the template assertions fail).
 *
 * Run with: npx tsx src/engine/gcode/rotaryOperationHandoff.test.ts
 */

import assert from 'node:assert/strict'
import { defaultTool, getStockBounds, newProject, roundStock } from '../../types/project'
import type { MachineOrigin, Operation, Project, RoundStock, Stock } from '../../types/project'
import { BUNDLED_DEFINITIONS } from './definitions'
import { normalizeToolForProject } from '../toolpaths/geometry'
import { runPostProcessor } from './postprocessor'
import { validateMachineDefinition } from './types'
import type { MachineDefinition, PostProcessorResult, RotaryDefinition } from './types'
import type { ToolpathMove, ToolpathPoint, ToolpathResult } from '../toolpaths/types'
import { formatGCodeNumber } from './utils'

// ── fixtures ──────────────────────────────────────────────────

const byId = (id: string): MachineDefinition => {
  const raw = BUNDLED_DEFINITIONS.find((definition) => definition.id === id)
  assert.ok(raw, `bundled definition ${id} exists`)
  return validateMachineDefinition(raw)
}

const GRBL = byId('grbl')
const LINUXCNC = byId('linuxcnc')

const OWN_AXIS: RotaryDefinition = {
  about: 'x',
  drive: 'own',
  reversed: false,
  inverseTimeFeed: { on: 'G93', off: 'G94' },
}

function machine(base: MachineDefinition, rotary: Partial<RotaryDefinition> = {}): MachineDefinition {
  return validateMachineDefinition({ ...structuredClone(base), rotary: { ...OWN_AXIS, ...rotary } })
}

function bar(): RoundStock {
  return roundStock(20, 100, 'x')
}

function originFor(stock: Stock): MachineOrigin {
  const bounds = getStockBounds(stock)
  return {
    name: 'Origin',
    x: bounds.minX,
    y: (bounds.minY + bounds.maxY) / 2,
    z: stock.thickness,
    visible: true,
  }
}

function projectWith(stock: Stock = bar()): Project {
  const project = newProject('Handoff Test', 'mm')
  project.stock = stock
  project.origin = originFor(stock)
  project.tools = [{ ...defaultTool('mm', 1), id: 't1', name: 'Test End Mill' }]
  return project
}

function operation(name: string, overrides: Partial<Operation> = {}): Operation {
  return {
    id: name.toLowerCase().replace(/\W+/g, '-'),
    name,
    description: '',
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'stock' },
    toolRef: 't1',
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

function at(x: number, y: number, z: number, a?: number): ToolpathPoint {
  return a === undefined ? { x, y, z } : { x, y, z, a }
}

/** `moves` prefixed by the rapid that establishes the bar's starting angle. */
function established(moves: ToolpathMove[]): ToolpathMove[] {
  const first = moves[0]
  if (!first || first.from.a === undefined) return moves
  return [{ kind: 'rapid', from: { ...first.from }, to: { ...first.from } }, ...moves]
}

function toolpathOf(op: Operation, moves: ToolpathMove[]): ToolpathResult {
  return { operationId: op.id, warnings: [], bounds: null, moves }
}

function exportProgram(
  project: Project,
  definition: MachineDefinition,
  entries: Array<{ operation: Operation; moves: ToolpathMove[] }>,
): PostProcessorResult {
  const tools = new Map(project.tools.map((tool) => [tool.id, normalizeToolForProject(tool, project)]))
  return runPostProcessor({
    project,
    definition,
    operations: entries.map(({ operation: op, moves }) => ({
      operation: op,
      tool: tools.get(op.toolRef ?? '')!,
      toolpath: toolpathOf(op, moves),
    })),
    options: { emitToolChanges: false, emitCoolant: false, programName: project.meta.name },
  })
}

/** One operation that cuts a quarter turn at Z20 and retracts to Z30. */
function turningMoves(fromA = 0, toA = 90): ToolpathMove[] {
  return established([
    { kind: 'cut', from: at(0, 10, 20, fromA), to: at(10, 10, 20, toA) },
    { kind: 'rapid', from: at(10, 10, 20, toA), to: at(10, 10, 30, toA) },
  ])
}

// ── 1. the end turn ───────────────────────────────────────────

console.log('Testing the forward end turn to 0 up...')
{
  const project = projectWith()
  const result = exportProgram(project, machine(GRBL), [{ operation: operation('Turn'), moves: turningMoves() }])
  assert.deepEqual(result.warnings, [], 'the turning program posts')

  const g53 = formatGCodeNumber(GRBL.motion.machineSafeZ, GRBL, 'mm')
  const lines = result.gcode.split('\n')
  const retractAt = lines.indexOf(`G53 G0 Z${g53}`)
  assert.ok(retractAt > 0, `the end turn retracts in machine coordinates:\n${lines.slice(-6).join('\n')}`)
  assert.equal(lines[retractAt + 1], 'G0 A360.000', 'then turns forward to the next whole turn')
  assert.equal(lines[retractAt + 2], '; A is at 360.000, 0 up. Zero A before the next operation.',
    'and tells the operator where A is')
  assert.equal(lines[lines.length - 1], 'M30', 'the program end is still last')
  assert.equal(lines[lines.length - 2], 'M5', 'after the spindle stop')

  // The turn is a rapid: it must not run in inverse-time mode.
  assert.ok(!lines.slice(0, retractAt).slice(-1).some((line) => line === 'G93'),
    'the turn does not run in inverse-time mode')

  // Never below the last commanded angle, always on a whole turn.
  const lastA = turningMoves().at(-1)!.to.a!
  assert.ok(360 >= lastA, `the end turn never rewinds (${lastA} -> 360)`)

  // Already on a whole turn: no retract and no turn, only the instruction.
  const zeroEnd = exportProgram(project, machine(GRBL), [
    { operation: operation('Whole'), moves: turningMoves(0, 360) },
  ])
  assert.ok(!zeroEnd.gcode.includes('G53'), 'a program that already ends at 0 up writes no retract')
  assert.ok(!zeroEnd.gcode.split('\n').some((line) => /^G0\s+A360/.test(line)),
    'and no separate A360 rapid (the cut itself carries the angle)')
  assert.ok(zeroEnd.gcode.includes('; A is at 360.000, 0 up. Zero A before the next operation.'),
    'but the instruction is still written')

  // The comment follows the dialect's own comment syntax, never a nested
  // parenthesised pair (which would end the comment and post code).
  const paren = exportProgram(project, machine(LINUXCNC), [{ operation: operation('Turn'), moves: turningMoves() }])
  const comment = paren.gcode.split('\n').find((line) => line.includes('Zero A before the next operation'))
  assert.ok(comment !== undefined, 'a parenthesised dialect writes the instruction')
  assert.ok(comment!.startsWith('('), `in its own comment syntax: ${comment}`)
  assert.equal((comment!.match(/\(/g) ?? []).length, 1, `with exactly one opening bracket: ${comment}`)
}

// ── 2. Zero A filled ──────────────────────────────────────────

console.log('Testing the machine Zero A line...')
{
  const project = projectWith()
  const zeroA = 'G10 L20 P1 A0'
  // The line writes P1, so the machine has to prove the program runs in G54:
  // an unspecified selection is unknown, not G54 (#1152 correction round 2,
  // finding 2). A user who wants this line adds G54 to the header.
  const selectingG54 = validateMachineDefinition({
    ...structuredClone(GRBL),
    workCoordinates: { selectCommand: 'G54' },
  })
  const definition = machine(selectingG54, { zeroA })
  const result = exportProgram(project, definition, [
    { operation: operation('First'), moves: turningMoves(0, 30) },
    { operation: operation('Second'), moves: turningMoves(30, 60) },
  ])
  assert.deepEqual(result.warnings, [], 'both turning operations post')
  const lines = result.gcode.split('\n')
  const zeroes = lines.filter((line) => line === zeroA)
  assert.equal(zeroes.length, 2, `the Zero A line is emitted once per rotary operation, got ${zeroes.length}`)
  assert.ok(!lines.includes('M0'), 'and no pause is needed when the machine zeroes itself')

  // Every Zero A line sits after a clearance retract and before that
  // operation's first turn.
  let searchFrom = 0
  for (const operationName of ['First', 'Second']) {
    const header = lines.findIndex((line, index) => index >= searchFrom && line.includes(operationName))
    assert.ok(header > 0, `${operationName}: the operation header is in the program`)
    const zero = lines.findIndex((line, index) => index > header && line === zeroA)
    assert.ok(zero > header, `${operationName}: the Zero A line opens the operation`)
    const retract = lines.slice(header, zero).findIndex((line) => /^G53\b.*Z|^(?:G0\s+)?Z/.test(line))
    assert.ok(retract >= 0, `${operationName}: a clearance retract precedes it`)
    const turn = lines.findIndex((line, index) => index > zero && /\bA-?[0-9]/.test(line))
    assert.ok(turn > zero, `${operationName}: and the first turn follows it`)
    searchFrom = zero
  }

  // A borrowed motor's rotary word is the other axis, and its Zero A line names
  // that letter; the emitter writes it once per rotary operation, unchanged.
  const borrowedZero = 'G10 L20 P1 Y0'
  const borrowedResult = exportProgram(project, machine(selectingG54, { drive: 'borrowed', zeroA: borrowedZero }), [
    { operation: operation('Borrowed'), moves: turningMoves(0, 30) },
  ])
  assert.equal((borrowedResult.gcode.match(new RegExp(`^${borrowedZero}$`, 'gm')) ?? []).length, 1,
    'a borrowed-motor machine writes its own Zero A letter once')
}

// ── 3. Zero A empty: the pause ────────────────────────────────

console.log('Testing the pause between rotary operations...')
{
  const project = projectWith()
  const definition = machine(GRBL)
  const result = exportProgram(project, definition, [
    { operation: operation('First'), moves: turningMoves(0, 30) },
    { operation: operation('Second'), moves: turningMoves(30, 60) },
  ])
  assert.deepEqual(result.warnings, [], 'both turning operations post')
  const lines = result.gcode.split('\n')
  const pauses = lines.filter((line) => line === 'M0')
  assert.equal(pauses.length, 1, `exactly one pause, between the two rotary operations (got ${pauses.length})`)
  const pauseAt = lines.indexOf('M0')
  const secondAt = lines.findIndex((line) => line.includes('Second'))
  const firstTurnEnd = lines.findIndex((line) => line === 'G0 A360.000')
  assert.ok(firstTurnEnd > 0 && firstTurnEnd < pauseAt, 'the pause follows the first operation\'s end turn')
  assert.ok(pauseAt < secondAt, 'and precedes the second operation')
  assert.equal(lines[pauseAt - 1], '; Zero A at 0 up, then resume.', 'the pause carries its instruction')
  // The last rotary operation does not pause.
  assert.ok(!lines.slice(secondAt).includes('M0'), 'no pause after the last rotary operation')

  // A trailing non-rotary operation is not a reason to pause either: there is
  // nothing to zero for between two rotary operations.
  const mixed = exportProgram(project, definition, [
    { operation: operation('First'), moves: turningMoves(0, 30) },
    {
      operation: operation('Flat'),
      moves: [{ kind: 'cut', from: at(0, 10, 20), to: at(10, 10, 20) }],
    },
  ])
  assert.ok(!mixed.gcode.split('\n').includes('M0'),
    'no pause when the following operation does not turn the bar')
}

// ── 3b. the pause resets the tracked A (#1152 correction round 1) ──

console.log('Testing that the manual zeroing resets the controller state...')
{
  const project = projectWith()
  const definition = machine(GRBL)
  // The second operation's own plan starts at a whole turn, exactly where the
  // first one's end turn left the *old* tracking. After the operator zeroes A
  // the controller reads 0, so this word must be written again: before the fix
  // it was suppressed and the cut below was commanded as A450 from A0.
  const secondStartsAtTurn = established([
    { kind: 'cut', from: at(0, 10, 20, 360), to: at(10, 10, 20, 450) },
    { kind: 'rapid', from: at(10, 10, 20, 450), to: at(10, 10, 30, 450) },
  ])
  const result = exportProgram(project, definition, [
    { operation: operation('First'), moves: turningMoves(0, 90) },
    { operation: operation('Second'), moves: secondStartsAtTurn },
  ])
  assert.deepEqual(result.warnings, [], 'both turning operations post')
  const lines = result.gcode.split('\n')
  const pauseAt = lines.indexOf('M0')
  const secondAt = lines.findIndex((line) => line.includes('Second'))
  assert.ok(pauseAt > 0 && secondAt > pauseAt, 'the pause still separates the two operations')
  const startWord = lines.findIndex((line, index) => index > secondAt && /\bA-?[0-9]/.test(line))
  assert.ok(startWord > secondAt, 'the second operation commands A at all')
  assert.equal(lines[startWord], 'X0.000 A360.000',
    'the operation states its own start angle again: the operator zeroed A at the pause, '
    + 'so the emitter must not assume the pre-pause number is still what the controller reads')
  assert.ok(lines.slice(pauseAt + 1).some((line) => /G0 A720\.000/.test(line)),
    'and it still ends forward on a whole turn')
}

// ── 3c. an empty pause template still stops the machine ───────

console.log('Testing the mandatory pause when the machine has no pause template...')
{
  const project = projectWith()
  const silent = validateMachineDefinition({
    ...structuredClone(GRBL),
    toolChange: { ...structuredClone(GRBL.toolChange), pauseCommand: '' },
    rotary: { ...OWN_AXIS },
  })
  const result = exportProgram(project, silent, [
    { operation: operation('First'), moves: turningMoves(0, 30) },
    { operation: operation('Second'), moves: turningMoves(30, 60) },
  ])
  assert.deepEqual(result.warnings, [], 'both turning operations post')
  const lines = result.gcode.split('\n')
  assert.equal(lines.filter((line) => line === 'M0').length, 1,
    `an empty pause template still stops the machine once between the rotary operations `
    + `(got ${JSON.stringify(lines.filter((line) => line === 'M0'))})`)
  assert.equal(lines[lines.indexOf('M0') - 1], '; Zero A at 0 up, then resume.',
    'and the stop carries the zeroing instruction')
  assert.ok(lines.indexOf('M0') < lines.findIndex((line) => line.includes('Second')),
    'before the second operation')

  // A template that is only a comment is just as silent: the program must not
  // rely on prose to stop a machine.
  const commented = validateMachineDefinition({
    ...structuredClone(GRBL),
    toolChange: { ...structuredClone(GRBL.toolChange), pauseCommand: '(pause)' },
    rotary: { ...OWN_AXIS },
  })
  const commentedResult = exportProgram(project, commented, [
    { operation: operation('First'), moves: turningMoves(0, 30) },
    { operation: operation('Second'), moves: turningMoves(30, 60) },
  ])
  assert.ok(commentedResult.gcode.split('\n').includes('M0'),
    'a comment-only pause template still emits a real stop')

  // A pause command that runs code but does not *stop* is not a pause
  // (#1152 correction round 2, finding 1). `M5` only stops the spindle and
  // `M1` is an optional stop — with the machine's optional-stop switch off it
  // runs straight through — so neither is allowed to stand in for the stop that
  // gives the operator the bar to zero. Each machine still gets one `M0`.
  for (const pauseCommand of ['M5', 'M1']) {
    const nonStopping = validateMachineDefinition({
      ...structuredClone(GRBL),
      toolChange: { ...structuredClone(GRBL.toolChange), pauseCommand },
      rotary: { ...OWN_AXIS },
    })
    const nonStoppingResult = exportProgram(project, nonStopping, [
      { operation: operation('First'), moves: turningMoves(0, 30) },
      { operation: operation('Second'), moves: turningMoves(30, 60) },
    ])
    assert.deepEqual(nonStoppingResult.warnings, [],
      `${pauseCommand}: both turning operations post`)
    const lines = nonStoppingResult.gcode.split('\n')
    const stops = lines.filter((line) => line === 'M0')
    assert.equal(stops.length, 1,
      `a ${pauseCommand} pause template carries no mandatory stop, so the program writes M0 `
      + `instead (got ${JSON.stringify(stops)})`)
    assert.ok(lines.indexOf('M0') < lines.findIndex((line) => line.includes('Second')),
      `${pauseCommand}: the stop precedes the second operation`)
    assert.ok(lines.includes('; Zero A at 0 up, then resume.'),
      `${pauseCommand}: and carries the zeroing instruction`)
  }

  // A commented M0 is not a stop (#1103 ca-h fix 3). LinuxCNC declares `(` as
  // its comment prefix but still reads `;` to end of line as a comment, so
  // both forms must be stripped before looking for M0, whatever the
  // definition's own prefix is.
  for (const pauseCommand of ['M5 ; M0', 'M5 (M0)']) {
    const commentedStop = validateMachineDefinition({
      ...structuredClone(LINUXCNC),
      toolChange: { ...structuredClone(LINUXCNC.toolChange), pauseCommand },
      rotary: { ...OWN_AXIS },
    })
    const commentedStopResult = exportProgram(project, commentedStop, [
      { operation: operation('First'), moves: turningMoves(0, 30) },
      { operation: operation('Second'), moves: turningMoves(30, 60) },
    ])
    assert.deepEqual(commentedStopResult.warnings, [],
      `${pauseCommand}: both turning operations post`)
    const lines = commentedStopResult.gcode.split('\n')
    assert.ok(!lines.includes(pauseCommand),
      `${JSON.stringify(pauseCommand)} only comments its M0, so it is not used as the stop`)
    assert.equal(lines.filter((line) => line === 'M0').length, 1,
      `${JSON.stringify(pauseCommand)}: the program writes the fallback M0 instead`)
    assert.ok(lines.indexOf('M0') < lines.findIndex((line) => line.includes('Second')),
      `${JSON.stringify(pauseCommand)}: the stop precedes the second operation`)
  }

  // A pause template that does carry the mandatory stop is written exactly as
  // the machine defines it, so a machine-specific comment or modal word is not
  // replaced by the generic fallback.
  const stopping = validateMachineDefinition({
    ...structuredClone(GRBL),
    toolChange: { ...structuredClone(GRBL.toolChange), pauseCommand: 'M0 (zero the bar)' },
    rotary: { ...OWN_AXIS },
  })
  const stoppingResult = exportProgram(project, stopping, [
    { operation: operation('First'), moves: turningMoves(0, 30) },
    { operation: operation('Second'), moves: turningMoves(30, 60) },
  ])
  const stoppingLines = stoppingResult.gcode.split('\n')
  assert.equal(stoppingLines.filter((line) => line === 'M0 (zero the bar)').length, 1,
    'a pause template containing M0 is used as written')
}

// ── 4. machine format: the Zero A field and its rule ──────────

console.log('Testing the Zero A machine field and template rule...')
{
  const base = structuredClone(GRBL)
  // P1 is only proven on a machine whose program names the system it runs in:
  // with no selection the active offset is unknown (#1152 correction round 2,
  // finding 2). The bundled GRBL carries no selection, so this fixture adds
  // G54 — exactly what a user running the P1 line would add to its header.
  const selectingG54 = { ...base, workCoordinates: { selectCommand: 'G54' } }
  const withZero = validateMachineDefinition({
    ...selectingG54,
    rotary: { ...OWN_AXIS, zeroA: 'G10 L20 P1 A0' },
  })
  assert.equal(withZero.rotary?.zeroA, 'G10 L20 P1 A0', 'the field persists through the strict schema')
  const roundTrip = validateMachineDefinition(JSON.parse(JSON.stringify(withZero)))
  assert.equal(roundTrip.rotary?.zeroA, 'G10 L20 P1 A0', 'and survives a JSON round trip')
  const withoutZero = validateMachineDefinition({ ...base, rotary: { ...OWN_AXIS } })
  assert.equal(withoutZero.rotary?.zeroA, undefined,
    'a rotary block saved before the field existed reads as unset, with no format change')

  const accepted = [
    'G10 L20 P1 A0',
    'g10l20p1a0',
    'G10 L20 P0 A0.0',
    'G92 A0',
    'G10 L20 P1 A0 (zero the rotary)',
    '  ',
  ]
  for (const zeroA of accepted) {
    assert.doesNotThrow(
      () => validateMachineDefinition({ ...selectingG54, rotary: { ...OWN_AXIS, zeroA } }),
      `the Zero A line "${zeroA}" is accepted`,
    )
  }
  const refused = [
    'G0 Z-5',
    'G1 X10',
    'G10 L20 P1 A5',
    'G10 L20 P1 A0 X0',
    'G10 L2 P1 A0',
    'G92.1 A0',
    '; only a comment',
    'G10 L20 P1 A0\nG0 Z-5',
    // The line must zero *this* machine's rotary axis: an own-drive machine
    // turns A, so zeroing X would shift a real work coordinate (#1103 ca-h).
    'G92 X0',
    'G10 L20 P1 Y0',
  ]
  for (const zeroA of refused) {
    assert.throws(
      () => validateMachineDefinition({ ...selectingG54, rotary: { ...OWN_AXIS, zeroA } }),
      /zero-a|Zero A/,
      `the Zero A line "${zeroA}" is refused`,
    )
  }

  // A borrowed motor's rotary is the other horizontal axis, so its Zero A line
  // names that letter; naming A there would be an axis the machine may not have.
  const borrowed = (zeroA: string): MachineDefinition => validateMachineDefinition({
    ...selectingG54,
    rotary: { ...OWN_AXIS, drive: 'borrowed', zeroA },
  })
  assert.equal(borrowed('G10 L20 P1 Y0').rotary?.zeroA, 'G10 L20 P1 Y0',
    'a borrowed-motor machine zeroes its borrowed axis')
  assert.throws(() => borrowed('G10 L20 P1 A0'), /zero-a|Zero A/,
    'and refuses a line that zeroes A instead')

  // #1152 correction round 1, finding 3: `G10 L20 P<n>` writes offset n, it
  // does not follow the selected system. A machine that runs in G55 needs P2
  // (or P0, the active-system form); P1 would silently change G54 and leave
  // the bar's A untouched, while the filled line suppresses the pauses.
  function selecting(selectCommand: string | null, zeroA: string): MachineDefinition {
    return validateMachineDefinition({
      ...structuredClone(GRBL),
      workCoordinates: { selectCommand },
      rotary: { ...OWN_AXIS, zeroA },
    })
  }
  assert.throws(() => selecting('G55', 'G10 L20 P1 A0'), /zero-a|Zero A/,
    'a G55 program refuses a Zero A line that writes G54')
  for (const zeroA of ['G10 L20 P2 A0', 'G10 L20 P0 A0', 'G92 A0']) {
    assert.equal(selecting('G55', zeroA).rotary?.zeroA, zeroA,
      `a G55 program accepts the ${JSON.stringify(zeroA)} form`)
  }
  // No selection is *unknown*, not the controller default: the program may
  // start in whatever system the machine was left in, so a P1 line could zero
  // G54 while G55 stays active and the pauses are suppressed for nothing
  // (#1152 correction round 2, finding 2). Only the active-system forms are
  // provable then.
  assert.throws(() => selecting(null, 'G10 L20 P1 A0'), /zero-a|Zero A/,
    'an unspecified selection refuses a fixed P')
  for (const zeroA of ['G10 L20 P0 A0', 'G92 A0']) {
    assert.equal(selecting(null, zeroA).rotary?.zeroA, zeroA,
      `an unspecified selection still accepts the active-system form ${JSON.stringify(zeroA)}`)
  }
  // A commented G5x selects nothing (#1103 ca-h fix 3): the controller reads
  // `; G54` as prose, so the active system stays unknown and a fixed P is
  // refused, in both comment forms.
  for (const selectCommand of ['; G54', '(G54)']) {
    assert.throws(() => selecting(selectCommand, 'G10 L20 P1 A0'), /zero-a|Zero A/,
      `a commented selection ${JSON.stringify(selectCommand)} refuses a fixed P`)
  }
  // A selection that names no G54…G59 leaves the active system unknown too.
  assert.throws(() => selecting('G90', 'G10 L20 P1 A0'), /zero-a|Zero A/,
    'an unknown active system refuses a fixed P')
  for (const zeroA of ['G10 L20 P0 A0', 'G92 A0']) {
    assert.equal(selecting('G90', zeroA).rotary?.zeroA, zeroA,
      `an unknown active system still accepts the ${JSON.stringify(zeroA)} form`)
  }
}

console.log('rotary operation handoff tests passed')
