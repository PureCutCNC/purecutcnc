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
import type { GcodeRotaryParseOptions, ParsedArcMove } from './gcodeMotionParser'

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
testPlainProgramIsUnchanged()

console.log('gcodeMotionParser tests passed')
