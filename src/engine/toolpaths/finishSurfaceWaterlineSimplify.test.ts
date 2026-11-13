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
 * The waterline cut simplifier must not simplify a rotation away (issue #393).
 *
 * `simplifyContiguousCutMoves` drops zero-XYZ-length cuts and merges collinear
 * ones by XYZ alone. Its generator emits no angles today, so nothing reaches it
 * with one — but it is the last pass before the moves are emitted, and a move
 * whose ends differ in angle is the stock turning: dropping it deletes the
 * rotation, and merging it rewrites the span's second angle. Absent is not zero,
 * so the rules below compare `a` for identity, not truthiness.
 *
 * Run with: npx tsx src/engine/toolpaths/finishSurfaceWaterlineSimplify.test.ts
 */

import type { ToolpathMove } from './types'
import { simplifyContiguousCutMoves } from './finishSurfaceWaterline'
import { deepStrictEqual } from 'node:assert/strict'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

// ── The angle (issue #393) ────────────────────────────────────

function testZeroLengthTurnIsKept(): void {
  // Two moves, because the function returns a lone move unchanged; the second
  // is the zero-length turn that the drop rule would otherwise delete.
  const kept = simplifyContiguousCutMoves([
    { kind: 'cut', from: { x: 0, y: 0, z: 0 }, to: { x: 5, y: 5, z: 0 } },
    { kind: 'cut', from: { x: 5, y: 5, z: 0, a: 0 }, to: { x: 5, y: 5, z: 0, a: 90 } },
  ])
  assert(kept.length === 2, `a zero-length turn is real motion, got ${kept.length} moves`)
  assert(kept[1].from.a === 0 && kept[1].to.a === 90, 'and it keeps both of its angles')
  console.log('a zero-length cut that turns is kept: PASSED')
}

function testZeroLengthWithoutATurnIsStillDropped(): void {
  const absent = simplifyContiguousCutMoves([
    { kind: 'cut', from: { x: 0, y: 0, z: 0 }, to: { x: 5, y: 0, z: 0 } },
    { kind: 'cut', from: { x: 5, y: 0, z: 0 }, to: { x: 5, y: 0, z: 0 } },
  ])
  assert(absent.length === 1, `a zero-length cut with no angle is still nothing happening, got ${absent.length}`)
  const equal = simplifyContiguousCutMoves([
    { kind: 'cut', from: { x: 0, y: 0, z: 0, a: 5 }, to: { x: 5, y: 0, z: 0, a: 5 } },
    { kind: 'cut', from: { x: 5, y: 0, z: 0, a: 5 }, to: { x: 5, y: 0, z: 0, a: 5 } },
  ])
  assert(equal.length === 1, `a zero-length cut that does not turn is still dropped, got ${equal.length}`)
  console.log('a zero-length cut with no turn is dropped as before: PASSED')
}

function testTurningCutsAreNotMerged(): void {
  const moves: ToolpathMove[] = [
    { kind: 'cut', from: { x: 0, y: 0, z: 0, a: 0 }, to: { x: 5, y: 0, z: 0, a: 45 } },
    { kind: 'cut', from: { x: 5, y: 0, z: 0, a: 45 }, to: { x: 10, y: 0, z: 0, a: 90 } },
  ]
  const out = simplifyContiguousCutMoves(moves)
  assert(out.length === 2, `collinear turning cuts must not merge, got ${out.length} moves`)
  assert(out[0].to.a === 45 && out[1].from.a === 45, 'the shared intermediate angle survives')
  console.log('collinear turning cuts are not merged: PASSED')
}

function testACutWithOnlyOneAngleStillBlocksAMerge(): void {
  const moves: ToolpathMove[] = [
    { kind: 'cut', from: { x: 0, y: 0, z: 0 }, to: { x: 5, y: 0, z: 0 } },
    { kind: 'cut', from: { x: 5, y: 0, z: 0, a: 90 }, to: { x: 10, y: 0, z: 0, a: 90 } },
  ]
  const out = simplifyContiguousCutMoves(moves)
  assert(out.length === 2, `an angled cut is never merged away, got ${out.length} moves`)
  assert(!('a' in out[0].to) && out[1].from.a === 90, 'the absent and written angles both survive')
  console.log('one angle is enough to block a merge: PASSED')
}

/**
 * The output of an angle-free input on this branch before the rotary change,
 * captured verbatim so the new conditions are proven not to touch it. The
 * simplifier always writes a `source` key, so the angle-free baseline carries
 * `source: undefined` on the moves that have none.
 */
const ANGLE_FREE_OUTPUT: ToolpathMove[] = [
  { kind: 'cut', from: { x: 0, y: 0, z: 0 }, to: { x: 10, y: 0, z: 0 }, source: undefined },
  { kind: 'rapid', from: { x: 10, y: 0, z: 0 }, to: { x: 10, y: 5, z: 0 }, source: undefined },
  { kind: 'cut', from: { x: 10, y: 5, z: 0 }, to: { x: 15, y: 5, z: 0 }, source: 'tag' },
]

function testAngleFreeInputSimplifiesExactlyAsBefore(): void {
  const input: ToolpathMove[] = [
    { kind: 'cut', from: { x: 0, y: 0, z: 0 }, to: { x: 5, y: 0, z: 0 } },
    { kind: 'cut', from: { x: 5, y: 0, z: 0 }, to: { x: 10, y: 0, z: 0 } },
    { kind: 'cut', from: { x: 10, y: 0, z: 0 }, to: { x: 10, y: 0, z: 0 } },
    { kind: 'rapid', from: { x: 10, y: 0, z: 0 }, to: { x: 10, y: 5, z: 0 } },
    { kind: 'cut', from: { x: 10, y: 5, z: 0 }, to: { x: 15, y: 5, z: 0 }, source: 'tag' },
  ]
  const out = simplifyContiguousCutMoves(input)
  deepStrictEqual(out, ANGLE_FREE_OUTPUT)
  assert(out.every((move) => !('a' in move.from) && !('a' in move.to)), 'no point gains an angle key')
  console.log('an angle-free input simplifies exactly as before: PASSED')
}

try {
  testZeroLengthTurnIsKept()
  testZeroLengthWithoutATurnIsStillDropped()
  testTurningCutsAreNotMerged()
  testACutWithOnlyOneAngleStillBlocksAMerge()
  testAngleFreeInputSimplifiesExactlyAsBefore()
  console.log('\nAll waterline-simplify angle tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
