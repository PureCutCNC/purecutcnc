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
 * removed, byte for byte — not merely "no cross word", which a lost motion line
 * would also satisfy. For a control, one of the rule's four conditions fails and
 * the bytes must be exactly the golden's.
 *
 * Run with: npx tsx src/engine/gcode/crossAxisHeldByTouchOff.test.ts
 */

import assert from 'node:assert/strict'
import golden from './crossAxisHeldPrograms.golden.json'
import { parseGcodeMotion } from './gcodeMotionParser'
import type { ParsedGcodeMove } from './gcodeMotionParser'
import { crossAxisHeldByTouchOff } from './motionPipeline'
import { ownAMachine } from '../../test/crossAxisPrograms'
import {
  crossAxisLetter,
  crossAxisPrograms,
  renderCrossAxisProgram,
} from '../../test/crossAxisPrograms'
import type { CrossAxisProgram } from '../../test/crossAxisPrograms'

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
    // 1. Today's text minus the cross words, exactly. This is the assertion a
    //    lost motion line or a re-spaced block cannot sneak past.
    assert.equal(
      text,
      withoutCrossWords(base, letter),
      `${program.name}: the program is the base commit's with every ${letter} word removed`,
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
    // 3. The position is unchanged: the parser reads the same X, Y, Z and A
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
