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
 * Tests for the read-only G-code motion parser (issue #356).
 *
 * Run with: npx tsx src/engine/gcode/gcodeMotionParser.test.ts
 */

import { parseGcodeMotion } from './gcodeMotionParser'
import type { GcodeCannedCycleParseOptions, GcodeRotaryParseOptions, ParsedArcMove, ParsedGcodeMotion } from './gcodeMotionParser'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}
function approx(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps
}

function testModalLinear(): void {
  console.log('Testing modal linear motion...')
  const r = parseGcodeMotion('G0 X0 Y0 Z5\nG1 X10 Y0 Z0 F100\nY5', 'ij', '(', ')')
  assert(r.status === 'verified', `status ${r.status}`)
  assert(r.moves.length === 3, `move count ${r.moves.length}`)
  const m = r.moves
  assert(m[0].kind === 'rapid' && approx(m[0].to.x, 0) && approx(m[0].to.z, 5), 'rapid to (0,0,5)')
  assert(m[1].kind === 'linear' && approx(m[1].to.x, 10) && approx(m[1].to.z, 0), 'linear to (10,0,0)')
  // Third line omits the G-word (modal): continues G1, Y-only update.
  assert(m[2].kind === 'linear' && approx(m[2].to.x, 10) && approx(m[2].to.y, 5), 'modal linear to (10,5,0)')
}

function testArcIJ(): void {
  console.log('Testing G2 arc with I/J...')
  const r = parseGcodeMotion('G0 X0 Y0 Z0\nG2 X5 Y5 I5 J0 F100', 'ij', '(', ')')
  assert(r.status === 'verified', `status ${r.status}`)
  assert(r.moves.length === 2, `move count ${r.moves.length}`)
  const arc = r.moves[1] as ParsedArcMove
  assert(arc.kind === 'arc', 'second move is arc')
  assert(approx(arc.center.x, 5) && approx(arc.center.y, 0), `center ${JSON.stringify(arc.center)}`)
  assert(approx(arc.radius, 5), `radius ${arc.radius}`)
  assert(arc.clockwise === true, 'clockwise')
  assert(arc.largeArc === false, 'not large arc')
}

function testArcCCWRadius(): void {
  console.log('Testing G3 arc with R...')
  const r = parseGcodeMotion('G0 X0 Y0 Z0\nG3 X5 Y5 R5', 'r', '(', ')')
  assert(r.status === 'verified', `status ${r.status}`)
  const arc = r.moves[1] as ParsedArcMove
  assert(arc.kind === 'arc', 'second move is arc')
  assert(arc.clockwise === false, 'CCW')
  assert(approx(arc.radius, 5, 1e-4), `radius ${arc.radius}`)
  // Centre must be one of the two points equidistant (5) from both endpoints.
  const dStart = Math.hypot(arc.center.x - 0, arc.center.y - 0)
  const dEnd = Math.hypot(arc.center.x - 5, arc.center.y - 5)
  assert(approx(dStart, 5, 1e-4) && approx(dEnd, 5, 1e-4), `centre equidistant: ${dStart}, ${dEnd}`)
}

function testLargeArc(): void {
  console.log('Testing large-arc flag on a near-full circle...')
  // Start (5,0), centre (0,0), CW the long way to a point just past start.
  const r = parseGcodeMotion('G0 X5 Y0 Z0\nG2 X4.9 Y0.1 I-5 J0', 'ij', '(', ')')
  assert(r.status === 'verified', `status ${r.status}`)
  const arc = r.moves[1] as ParsedArcMove
  assert(arc.kind === 'arc', 'arc')
  assert(arc.largeArc === true, `expected largeArc=true, got ${arc.largeArc}`)
}

function testUnsupportedCannedCycle(): void {
  console.log('Testing unsupported canned cycle...')
  const r = parseGcodeMotion('G81 X1 Y1 Z-1 R1 F50', 'ij', '(', ')')
  assert(r.status === 'unsupported', `expected unsupported, got ${r.status}`)
  assert(r.warnings.length > 0, 'has a warning')
}

function testArcMissingCenter(): void {
  console.log('Testing arc with no centre word -> unsupported, not verified...')
  const r = parseGcodeMotion('G0 X0 Y0 Z0\nG2 X5 Y5', 'ij', '(', ')')
  assert(r.status === 'unsupported', `expected unsupported for arc missing centre, got ${r.status}`)
  // A fallback linear segment keeps the trace continuous; the status downgrade
  // is what guarantees the viewer never claims "verified" for a partial parse.
  assert(r.moves.some((m) => m.kind === 'linear' || m.kind === 'rapid'), 'fallback move emitted')
}

function testCommentsAndLineNumbers(): void {
  console.log('Testing comments and line numbers are ignored...')
  const r = parseGcodeMotion(
    'N10 G0 X0 Y0 Z5 ; setup\nN20 (first move) G1 X10 Z0 F100',
    'ij', ';', '',
  )
  assert(r.status === 'verified', `status ${r.status}`)
  assert(r.moves.length === 2, `move count ${r.moves.length}`)
  assert(approx(r.moves[1].to.x, 10) && approx(r.moves[1].to.z, 0), 'second move to (10,0)')
}

function testNonMotionSetupCodes(): void {
  console.log('Testing non-motion setup codes (G21/G54/G43/M3) are skipped, not unsupported...')
  // G43 (tool-length comp), G54 (WCS), G21 (units), M3 (spindle) are setup, not
  // motion. They must not downgrade the trace to "unsupported".
  const r = parseGcodeMotion(
    'G21 G54\nG43 H1\nM3 S1000\nG0 X0 Y0 Z5\nG1 X10 Z0 F100',
    'ij', '(', ')',
  )
  assert(r.status === 'verified', `expected verified, got ${r.status} ${JSON.stringify(r.warnings)}`)
  assert(r.warnings.length === 0, `unexpected warnings ${JSON.stringify(r.warnings)}`)
  assert(r.moves.length === 2, `expected 2 moves, got ${r.moves.length}`)
  assert(approx(r.moves[1].to.x, 10), 'second move to X10')
}

// ── Rotary programs (issue #393) ──────────────────────────────

const ROTARY_A: GcodeRotaryParseOptions = { word: 'A', inverseTimeFeed: { on: 'G93', off: 'G94' } }
const ROTARY_BORROWED_Y: GcodeRotaryParseOptions = { word: 'Y', inverseTimeFeed: { on: 'G93', off: 'G94' } }

function testRotaryAngleIsModal(): void {
  console.log('Testing the rotary word is read as a modal angle...')
  const r = parseGcodeMotion('G0 X0 Y0 Z0 A0\nG1 X10 Z0 F100 A90\nG1 X20 A370', 'ij', '(', ')', ROTARY_A)
  assert(r.status === 'verified', `status ${r.status} ${JSON.stringify(r.warnings)}`)
  assert(r.warnings.length === 0, 'the rotary word is not reported as unsupported')
  assert(r.moves.length === 3, `move count ${r.moves.length}`)
  assert(r.moves[0].to.a === 0, 'the first angle is read')
  assert(r.moves[1].to.a === 90, 'the next angle is read')
  // A block with no angle word keeps the last one, like X/Y/Z, and the angle is
  // never reduced to 0-360.
  assert(r.moves[2].to.a === 370, `the angle is never reduced, got ${r.moves[2].to.a}`)
  assert(r.moves[2].from.a === 90, 'the previous angle is the next move start')
  assert(!('a' in r.moves[0].from), 'a program that opens without an angle has no a key')
}

function testRotaryRotationOnlyBlock(): void {
  console.log('Testing a rotation-only block is a move...')
  const r = parseGcodeMotion('G0 X0 Y0 Z0\nA45', 'ij', '(', ')', ROTARY_A)
  assert(r.status === 'verified', `status ${r.status}`)
  assert(r.moves.length === 2, `move count ${r.moves.length}`)
  assert(r.moves[1].to.a === 45 && approx(r.moves[1].to.x, 0) && approx(r.moves[1].to.z, 0),
    'the angle block moves nothing but the angle')
}

function testBorrowedLetterIsAnAngle(): void {
  console.log('Testing a borrowed motor\'s letter carries the angle, not a coordinate...')
  const borrowed = parseGcodeMotion('G0 X0 Y0 Z0\nG1 X20 Y45 F100', 'ij', '(', ')', ROTARY_BORROWED_Y)
  assert(borrowed.moves[1].to.a === 45, 'the borrowed letter carries the angle')
  assert(approx(borrowed.moves[1].to.y, 0), 'the borrowed letter is never read as linear Y')

  // The same program without the definition's rotary options reads Y as an
  // ordinary linear axis, exactly as before.
  const plain = parseGcodeMotion('G0 X0 Y0 Z0\nG1 X20 Y45 F100', 'ij', '(', ')')
  assert(plain.moves[1].to.y === 45, 'a plain parse still reads Y as linear')
  assert(plain.moves[1].to.a === undefined, 'and gains no angle')
}

function testInverseTimeFeedMode(): void {
  console.log('Testing G93/G94 switch the feed mode...')
  const r = parseGcodeMotion(
    'G0 X0 Y0 Z0\nG1 X10 F600\nG93\nG1 X10 A90 F0.5\nG94\nG1 X20 F600',
    'ij', '(', ')', ROTARY_A,
  )
  assert(r.status === 'verified', `status ${r.status} ${JSON.stringify(r.warnings)}`)
  assert(r.moves[1].inverseTimeFeed === undefined, 'an ordinary feed is not inverse time')
  assert(r.moves[2].inverseTimeFeed === 0.5, `a G93 F is kept as inverse time, got ${r.moves[2].inverseTimeFeed}`)
  assert(r.moves[3].inverseTimeFeed === undefined, 'G94 leaves inverse-time mode')
  assert(r.moves[3].to.a === 90, 'the angle stays modal across the mode switch')
}

function testPlainProgramIsUnchanged(): void {
  console.log('Testing a program with no rotary word and no G93 parses exactly as today...')
  const r = parseGcodeMotion('G0 X0 Y0 Z0\nG1 X10 Y5 F100', 'ij', '(', ')')
  assert(!('a' in r.moves[1].to) && !('a' in r.moves[1].from), 'no angle key is added')
  assert(!('inverseTimeFeed' in r.moves[1]), 'no inverse-time key is added')
  // Passing rotary options alone must not change a program that never turns.
  const withOptions = parseGcodeMotion('G0 X0 Y0 Z0\nG1 X10 Y5 F100', 'ij', '(', ')', ROTARY_A)
  assert(!('a' in withOptions.moves[1].to) && !('inverseTimeFeed' in withOptions.moves[1]),
    'rotary options alone do not change a plain program')
}

function testInverseTimeFeedIsNotModal(): void {
  console.log('Testing an inverse-time F does not carry to the next feed block...')
  const r = parseGcodeMotion('G0 A0\nG93\nG1 A90 F2\nG1 A180', 'ij', '(', ')', ROTARY_A)
  assert(r.moves.length === 3, `move count ${r.moves.length}`)
  assert(r.moves[1].inverseTimeFeed === 2, `the block that writes F keeps it, got ${r.moves[1].inverseTimeFeed}`)
  assert(r.moves[2].inverseTimeFeed === undefined, 'the next block does not borrow the previous F')
  assert(r.status === 'unsupported', `a controller rejects that block, so the parse downgrades, got ${r.status}`)
  assert(r.warnings.some((warning) => warning.includes('inverse-time')),
    `the reason is reported, got ${JSON.stringify(r.warnings)}`)
}

function testStandaloneFeedLineDoesNotFeedTheMove(): void {
  console.log('Testing an F on its own line does not count for the next move...')
  const r = parseGcodeMotion('G0 A0\nG93\nF2\nG1 A90', 'ij', '(', ')', ROTARY_A)
  assert(r.moves.length === 2, `move count ${r.moves.length}`)
  assert(r.moves[1].inverseTimeFeed === undefined, 'no F is borrowed from the standalone line')
  assert(r.status === 'unsupported', `the move still needs its own F, got ${r.status}`)
}

function testCorrectInverseTimeProgramStillVerifies(): void {
  console.log('Testing a correct inverse-time program still parses as before...')
  const r = parseGcodeMotion('G0 A0\nG93\nG1 A90 F2\nG1 A180 F1.5\nG94\nG1 A270 F600', 'ij', '(', ')', ROTARY_A)
  assert(r.status === 'verified', `status ${r.status} ${JSON.stringify(r.warnings)}`)
  assert(r.warnings.length === 0, `no warnings for a program the controller accepts, got ${JSON.stringify(r.warnings)}`)
  assert(r.moves[1].inverseTimeFeed === 2, `first turning feed, got ${r.moves[1].inverseTimeFeed}`)
  assert(r.moves[2].inverseTimeFeed === 1.5, `second turning feed, got ${r.moves[2].inverseTimeFeed}`)
  assert(r.moves[3].inverseTimeFeed === undefined, 'G94 restores the ordinary feed')
}

function testMachineCoordinateMoveIsNotWorkZ(): void {
  console.log('Testing a G53 move is machine-coordinate and leaves the work Z unknown...')
  // The #1054 retract: a work Z5, then `G53 G0 Z0` to the machine's top, then
  // the A turn. The retract's Z0 is NOT a work Z — reading it as one is what
  // made the turn look verified at work Z0. Since #1261 a Z-only G53 rapid is
  // understood as a retract and the rapid after it as travel at the machine
  // height: both are noted, neither downgrades the parse.
  const r = parseGcodeMotion('G0 X0 Y0 Z5\nG53 G0 Z0\nG0 A180', 'ij', '(', ')', ROTARY_A)
  assert(r.status === 'verified', `a Z-only machine retract is understood, got ${r.status}`)
  assert(r.warnings.some((warning) => warning.includes('G53')), `the reason names G53, got ${JSON.stringify(r.warnings)}`)
  assert(
    JSON.stringify((r.notes ?? []).map((note) => note.code))
      === JSON.stringify(['machineCoordinateRetract', 'rapidAfterMachineRetract']),
    `the retract and the rapid after it are noted, got ${JSON.stringify(r.notes)}`,
  )
  assert(
    !r.moves.some((move) => move.from.z === 5 && move.to.z === 0),
    'the G53 block is not emitted as a work-coordinate move to Z0',
  )
  const turn = r.moves.find((move) => move.to.a === 180)
  assert(turn !== undefined, 'the A turn is still parsed')
  assert(approx(turn!.from.z, 5) && approx(turn!.to.z, 5),
    `the turn does not inherit the machine retract's Z0, got ${turn!.from.z}->${turn!.to.z}`)
  assert(turn!.kind === 'rapid' && turn!.workZUnknown === true, 'the turn is marked as travelling at an unknown work Z')
  assert(
    r.warnings.some((warning) => warning.includes('does not state Z')),
    `the unprovable work Z is reported, got ${JSON.stringify(r.warnings)}`,
  )

  // A *feed* after the retract that does not state Z would cut at a height the
  // program never gives, so it still downgrades (#1054 fix 4).
  const fedBlind = parseGcodeMotion('G0 X0 Y0 Z5\nG53 G0 Z0\nG1 X10 F100', 'ij', '(', ')')
  assert(fedBlind.status === 'unsupported', `a feed at an unknown work Z is not verified, got ${fedBlind.status}`)
  assert((fedBlind.notes ?? []).some((note) => note.code === 'workZUnknown' && note.severity === 'unsupported'), 'and is noted')

  // A later block that states Z re-establishes the work frame.
  const resumed = parseGcodeMotion('G0 X0 Y0 Z5\nG53 G0 Z0\nG0 X10 Z3', 'ij', '(', ')')
  assert(resumed.status === 'verified', `the retract and a restated Z verify, got ${resumed.status}`)
  assert(approx(resumed.moves[resumed.moves.length - 1].to.z, 3), 'a stated Z is read again after the G53')

  // A G53 that is not a Z-only rapid still cannot be placed in the work frame.
  const bare = parseGcodeMotion('G53\nG0 X1 Y0 Z0', 'ij', '(', ')')
  assert(bare.status === 'unsupported', 'the bare G53 downgrades the parse')
  assert(bare.moves.length === 1, 'and moves nothing in the work frame itself')
  const sideways = parseGcodeMotion('G0 X0 Y0 Z5\nG53 G0 X0 Z0', 'ij', '(', ')')
  assert(sideways.status === 'unsupported', 'a G53 that moves X is not a retract')
  assert((sideways.notes ?? []).some((note) => note.code === 'machineCoordinateMove'), 'and is noted as a machine move')
  const fed = parseGcodeMotion('G0 X0 Y0 Z5\nG53 G1 Z0 F100', 'ij', '(', ')')
  assert(fed.status === 'unsupported', 'a G53 feed is not a retract')
}

function testCompactWordsWithoutWhitespace(): void {
  console.log('Testing compact G-code words are read without whitespace...')
  // The reviewer's repro (#1054 fix 5): controllers write `G53G0Z0` with no
  // spaces. Splitting on whitespace dropped the whole block, so the machine
  // retract became a work-coordinate move to Z0 and the read-back stayed
  // verified. Both spellings must downgrade.
  const spaced = parseGcodeMotion('G0 Z5\nG53 G0 Z0\nG0 A180', 'ij', '(', ')', ROTARY_A)
  const compact = parseGcodeMotion('G0 Z5\nG53G0 Z0\nG0 A180', 'ij', '(', ')', ROTARY_A)
  for (const [label, parsed] of [['spaced', spaced], ['compact', compact]] as const) {
    // Both spellings are read as the machine retract (verified since #1261),
    // never as a work move to Z0.
    assert(parsed.status === 'verified', `${label}: a machine-coordinate retract is understood, got ${parsed.status}`)
    assert(
      (parsed.notes ?? []).some((note) => note.code === 'machineCoordinateRetract'),
      `${label}: the retract is noted, got ${JSON.stringify(parsed.notes)}`,
    )
    assert(
      parsed.warnings.some((warning) => warning.includes('G53')),
      `${label}: the reason names G53, got ${JSON.stringify(parsed.warnings)}`,
    )
    const turn = parsed.moves.find((move) => move.to.a === 180)
    assert(turn !== undefined, `${label}: the A turn is parsed`)
    assert(
      approx(turn!.from.z, 5) && approx(turn!.to.z, 5),
      `${label}: the turn is not placed at the machine retract's Z0, got ${turn!.from.z}->${turn!.to.z}`,
    )
  }

  // Compact settings and axis words are read as words, not dropped or refused.
  const settings = parseGcodeMotion('G0 X0 Y0 Z0\nG90G49\nG1 X1.5Y-2 Z-1 F100', 'ij', '(', ')')
  assert(
    settings.status === 'verified',
    `compact G90G49 and X1.5Y-2 are understood, got ${settings.status} ${JSON.stringify(settings.warnings)}`,
  )
  assert(settings.moves.length === 2, `move count ${settings.moves.length}`)
  assert(
    approx(settings.moves[1].to.x, 1.5) && approx(settings.moves[1].to.y, -2) && approx(settings.moves[1].to.z, -1),
    'compact axis words land on the same point',
  )

  // The UCCNC/Mach3 program delimiter and program name are not unreadable text.
  const delimited = parseGcodeMotion('%\nO0001 (program)\nG0 X0 Y0 Z0\nG1 X5 Z-1 F100\n%', 'ij', '(', ')')
  assert(
    delimited.status === 'verified',
    `a %-delimited program still verifies, got ${delimited.status} ${JSON.stringify(delimited.warnings)}`,
  )

  // Anything the tokenizer cannot read downgrades the read-back instead of
  // being silently dropped.
  const unknown = parseGcodeMotion('G0 X0 Y0 Z0\nG1 X5 HELLO\nG1 X10', 'ij', '(', ')')
  assert(unknown.status === 'unsupported', `an unknown word is not verified, got ${unknown.status}`)
  assert(
    unknown.warnings.some((warning) => warning.includes('HELLO')),
    `the unknown text is reported, got ${JSON.stringify(unknown.warnings)}`,
  )

  // An unterminated comment is text the tokenizer cannot read, not a clean
  // comment that may be skipped.
  const brokenComment = parseGcodeMotion('G0 X0 Y0 Z0\n(unterminated comment\nG1 X5', 'ij', '(', ')')
  assert(
    brokenComment.status === 'unsupported',
    `an unterminated comment is not verified, got ${brokenComment.status}`,
  )
  assert(
    brokenComment.warnings.some((warning) => warning.includes('unterminated comment')),
    `the unreadable text is reported, got ${JSON.stringify(brokenComment.warnings)}`,
  )
}

// ── Canned cycles, probes and offsets (issue #1261) ───────────

/** The bundled LinuxCNC/Mach3/UCCNC cycle block. */
const CANNED: GcodeCannedCycleParseOptions = {
  drillCommand: 'G81',
  drillWithDwellCommand: 'G82',
  peckDrillCommand: 'G83',
  chipBreakDrillCommand: 'G73',
  peckStepWord: 'Q',
  cancelCommand: 'G80',
}

/** The moves as `kind from.z->to.z @x,y`, for exact sequence assertions. */
function zTrace(parsed: ParsedGcodeMotion): string[] {
  return parsed.moves.map((move) => `${move.kind} ${move.from.z}->${move.to.z} @${move.to.x},${move.to.y}`)
}

function canned(program: string, options: GcodeCannedCycleParseOptions | null = CANNED): ParsedGcodeMotion {
  return parseGcodeMotion(program, 'ij', '(', ')', undefined, options)
}

function testDrillCycleG98(): void {
  console.log('Testing G81 under G98 returns to the starting Z and repeats at a new X/Y...')
  const r = canned('G21\nG0 X0 Y0 Z10\nG98\nG81 X5 Y5 Z-3 R2 F120\nX15 Y5\nG80\nG0 X0 Y0')
  assert(r.status === 'verified', `status ${r.status} ${JSON.stringify(r.warnings)}`)
  assert(JSON.stringify(zTrace(r)) === JSON.stringify([
    'rapid 0->10 @0,0',
    'rapid 10->10 @5,5', 'rapid 10->2 @5,5', 'linear 2->-3 @5,5', 'rapid -3->10 @5,5',
    'rapid 10->10 @15,5', 'rapid 10->2 @15,5', 'linear 2->-3 @15,5', 'rapid -3->10 @15,5',
    'rapid 10->10 @0,0',
  ]), `the G81 sequence, got ${JSON.stringify(zTrace(r))}`)
  const feeds = r.moves.filter((move) => move.kind === 'linear').map((move) => move.feed)
  assert(JSON.stringify(feeds) === '[120,120]', `every drill feed keeps its F, got ${JSON.stringify(feeds)}`)
  assert(r.statedAxes?.x === true && r.statedAxes.y && r.statedAxes.z, 'the cycle states X, Y and Z')
}

function testDrillCycleG99(): void {
  console.log('Testing G99 retracts to R between holes, and G98 to the higher of R and the start...')
  const r = canned('G0 X0 Y0 Z10\nG99 G81 X5 Y5 Z-3 R2 F120\nX15')
  assert(r.status === 'verified', `status ${r.status} ${JSON.stringify(r.warnings)}`)
  const retracts = r.moves.slice(1).filter((move) => move.kind === 'rapid' && move.to.z > move.from.z).map((move) => move.to.z)
  assert(JSON.stringify(retracts) === '[2,2]', `G99 returns to R, got ${JSON.stringify(retracts)}`)
  // Starting below R, G98 retracts to R: the higher of the two.
  const low = canned('G0 X0 Y0 Z1\nG98 G81 X5 Y5 Z-3 R2 F120')
  assert(JSON.stringify(zTrace(low)) === JSON.stringify([
    'rapid 0->1 @0,0', 'rapid 1->2 @0,0', 'rapid 2->2 @5,5', 'linear 2->-3 @5,5', 'rapid -3->2 @5,5',
  ]), `below R the cycle first rises to R, got ${JSON.stringify(zTrace(low))}`)
}

function testDwellCycle(): void {
  console.log('Testing G82 drills like G81 and its P is not a coordinate...')
  const r = canned('G0 X0 Y0 Z10\nG98\nG82 X5 Y5 Z-3 R2 P0.5 F120\nG80')
  assert(r.status === 'verified', `status ${r.status}`)
  assert(r.moves.filter((move) => move.kind === 'linear').length === 1, 'one feed to the bottom')
}

function testPeckCycle(): void {
  console.log('Testing G83 pecks Q at a time, back to R and down to just above the last depth...')
  const r = canned('G21\nG0 X0 Y0 Z10\nG98\nG83 X5 Y5 Z-3 R2 Q2 F120\nG80')
  assert(r.status === 'verified', `status ${r.status} ${JSON.stringify(r.warnings)}`)
  assert(JSON.stringify(zTrace(r)) === JSON.stringify([
    'rapid 0->10 @0,0',
    'rapid 10->10 @5,5', 'rapid 10->2 @5,5',
    'linear 2->0 @5,5', 'rapid 0->2 @5,5', 'rapid 2->0.254 @5,5',
    'linear 0.254->-2 @5,5', 'rapid -2->2 @5,5', 'rapid 2->-1.746 @5,5',
    'linear -1.746->-3 @5,5', 'rapid -3->10 @5,5',
  ]), `the G83 sequence, got ${JSON.stringify(zTrace(r))}`)
  // The clearance is the controller's 0.010 in, in the program's own units.
  const inch = canned('G20\nG0 X0 Y0 Z1\nG98\nG83 X0.2 Y0.2 Z-0.3 R0.1 Q0.2 F5\nG80')
  const reEntry = inch.moves.find((move) => move.kind === 'rapid' && move.to.z < move.from.z && move.from.z === 0.1 && move.to.z < 0)
  assert(reEntry !== undefined && approx(reEntry.to.z, -0.1 + 0.01), `an inch re-entry stops 0.010 in above the depth, got ${JSON.stringify(zTrace(inch))}`)
}

function testChipBreakCycleIsApproximate(): void {
  console.log('Testing G73 backs off between pecks and is flagged approximate...')
  const r = canned('G21\nG0 X0 Y0 Z10\nG98\nG73 X5 Y5 Z-3 R2 Q2 F120\nG80')
  assert(r.status === 'verified', `an approximate in-hole retract does not downgrade, got ${r.status}`)
  assert(JSON.stringify(zTrace(r)) === JSON.stringify([
    'rapid 0->10 @0,0',
    'rapid 10->10 @5,5', 'rapid 10->2 @5,5',
    'linear 2->0 @5,5', 'rapid 0->0.254 @5,5',
    'linear 0.254->-2 @5,5', 'rapid -2->-1.746 @5,5',
    'linear -1.746->-3 @5,5', 'rapid -3->10 @5,5',
  ]), `the G73 sequence, got ${JSON.stringify(zTrace(r))}`)
  assert(
    (r.notes ?? []).some((note) => note.code === 'chipBreakRetractApproximate' && note.severity === 'info' && note.command === 'G73'),
    `the approximation is noted, got ${JSON.stringify(r.notes)}`,
  )
}

function testCannedCycleEdges(): void {
  console.log('Testing canned-cycle cancel, missing words, retract mode and the definition\'s own words...')
  // After G80 a block with coordinates and no motion word has no mode.
  const cancelled = canned('G0 X0 Y0 Z10\nG98\nG81 X5 Y5 Z-3 R2 F120\nG80\nX20')
  assert(cancelled.status === 'unsupported', 'G80 ends the cycle: a bare X is not another hole')
  assert((cancelled.notes ?? []).some((note) => note.code === 'motionWithoutMode'), 'and is noted')
  // An explicit G0 also ends the run.
  const ended = canned('G0 X0 Y0 Z10\nG98\nG81 X5 Y5 Z-3 R2 F120\nG0 X20 Z10')
  assert(ended.status === 'verified' && ended.moves[ended.moves.length - 1].kind === 'rapid', 'G0 after the cycle is a rapid')
  // No R: the cycle cannot be expanded.
  const noR = canned('G0 X0 Y0 Z10\nG98\nG81 X5 Y5 Z-3 F120')
  assert(noR.status === 'unsupported' && (noR.notes ?? []).some((note) => note.code === 'cannedCycleIncomplete'), 'a cycle without R is incomplete')
  const noQ = canned('G0 X0 Y0 Z10\nG98\nG83 X5 Y5 Z-3 R2 F120')
  assert(noQ.status === 'unsupported', 'a peck cycle without Q is incomplete')
  // No G98/G99 in the program: G98 is assumed and said.
  const assumed = canned('G0 X0 Y0 Z10\nG81 X5 Y5 Z-3 R2 F120')
  assert(assumed.status === 'verified', 'an assumed retract mode does not downgrade')
  assert((assumed.notes ?? []).some((note) => note.code === 'cannedRetractModeAssumed'), 'the assumption is noted')
  // A cycle the definition does not have is not expanded.
  const missing = canned('G0 X0 Y0 Z10\nG98\nG73 X5 Y5 Z-3 R2 Q1 F120', { ...CANNED, chipBreakDrillCommand: null })
  assert(missing.status === 'unsupported', 'a cycle the machine lacks stays unsupported')
  // The peck word is the definition's own.
  const kWord = canned('G0 X0 Y0 Z10\nG98\nG83 X5 Y5 Z-3 R2 K2 F120\nG80', { ...CANNED, peckStepWord: 'K' })
  assert(kWord.status === 'verified' && kWord.moves.filter((move) => move.kind === 'linear').length === 3, 'the K peck word is read')
}

function testFeedIsKeptOnEveryFeedMove(): void {
  console.log('Testing the modal F rides on every feed move, never on a rapid...')
  const r = parseGcodeMotion('G0 X0 Y0 Z5\nG1 Z0 F100\nX10 F600\nG2 X20 Y0 I5 J0\nG0 Z5', 'ij', '(', ')')
  assert(JSON.stringify(r.moves.map((move) => move.feed ?? null)) === '[null,100,600,600,null]', `feeds ${JSON.stringify(r.moves.map((move) => move.feed))}`)
  const lone = parseGcodeMotion('G0 X0 Y0 Z5\nF250\nG1 Z0', 'ij', '(', ')')
  assert(lone.moves[1].feed === 250, 'an F on its own line sets the feed of the next move')
}

function testProbeAndTouchOff(): void {
  console.log('Testing a probe and its touch-off are not moves to their Z words...')
  const r = parseGcodeMotion('G0 X0 Y0 Z5\nX10 Y10\nG38.2 Z-30 F100\nG10 L20 P0 Z0\nG0 Z3.8\nG1 Z1.5 F300\nX20 F2000', 'ij', ';', '')
  assert(r.status === 'verified', `status ${r.status} ${JSON.stringify(r.warnings)}`)
  assert(!r.moves.some((move) => move.to.z === -30 || (move.to.z === 0 && move.from.z !== 0)), 'neither the probe nor the touch-off is a move')
  assert(JSON.stringify((r.notes ?? []).map((note) => note.code)) === JSON.stringify(['probeMove', 'touchOffZ']), `notes ${JSON.stringify(r.notes)}`)
  const after = r.moves.filter((move) => move.touchOffZ !== undefined)
  assert(after.length === 3 && after.every((move) => move.touchOffZ === 0), 'every move after the touch-off is measured from the probed surface')
  assert(r.moves[2].from.z === 0, 'the touch-off sets the tool at the Z it names')
  // A work-offset change that is not a touch-off is not understood.
  const offset = parseGcodeMotion('G0 X0 Y0 Z5\nG92 X0 Y0', 'ij', '(', ')')
  assert(offset.status === 'unsupported' && (offset.notes ?? []).some((note) => note.code === 'workOffsetChange'), 'G92 X0 Y0 is unsupported')
  // A home move goes through a position the program does not state.
  const home = parseGcodeMotion('G0 X0 Y0 Z5\nG28 Z10', 'ij', '(', ')')
  assert(home.status === 'unsupported' && !home.moves.some((move) => move.to.z === 10), 'G28 is unsupported and not a move to Z10')
}

function testRotaryZero(): void {
  console.log('Testing G92 A0 zeroes the angle without turning the bar...')
  const r = parseGcodeMotion('G0 X0 Y0 Z5 A90\nG92 A0\nG0 A10', 'ij', '(', ')', ROTARY_A)
  assert(r.status === 'verified', `status ${r.status} ${JSON.stringify(r.warnings)}`)
  assert(r.moves.length === 2, 'the zero is not a move')
  assert(r.moves[1].from.a === 90 && r.moves[1].to.a === 100, `A10 after zeroing at 90 is 100 physically, got ${r.moves[1].to.a}`)
  assert((r.notes ?? []).some((note) => note.code === 'rotaryZeroed'), 'the zero is noted')
}

testModalLinear()
testArcIJ()
testArcCCWRadius()
testLargeArc()
testUnsupportedCannedCycle()
testArcMissingCenter()
testCommentsAndLineNumbers()
testNonMotionSetupCodes()
testRotaryAngleIsModal()
testRotaryRotationOnlyBlock()
testBorrowedLetterIsAnAngle()
testInverseTimeFeedMode()
testInverseTimeFeedIsNotModal()
testStandaloneFeedLineDoesNotFeedTheMove()
testCorrectInverseTimeProgramStillVerifies()
testMachineCoordinateMoveIsNotWorkZ()
testCompactWordsWithoutWhitespace()
testPlainProgramIsUnchanged()
testDrillCycleG98()
testDrillCycleG99()
testDwellCycle()
testPeckCycle()
testChipBreakCycleIsApproximate()
testCannedCycleEdges()
testFeedIsKeptOnEveryFeedMove()
testProbeAndTouchOff()
testRotaryZero()

console.log('gcodeMotionParser tests passed')
