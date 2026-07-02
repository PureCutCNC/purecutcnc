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
 * Tests for playback move preparation.
 *
 * Run with: npx tsx src/engine/simulation/playback.test.ts
 */

import { subdivideMoves } from './playback'
import type { ToolpathMove } from '../toolpaths/types'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(a: number, b: number, epsilon = 1e-9): boolean {
  return Math.abs(a - b) < epsilon
}

function testSubdividePreservesMoveMetadata(): void {
  console.log('Testing subdivideMoves preserves feedScale and source on sub-segments...')
  const moves: ToolpathMove[] = [
    { kind: 'cut', from: { x: 0, y: 0, z: 0 }, to: { x: 10, y: 0, z: 0 }, feedScale: 0.1, source: 'slot' },
  ]
  const out = subdivideMoves(moves, 2)

  assert(out.length === 5, `expected 5 sub-segments, got ${out.length}`)
  assert(out.every((move) => move.feedScale === 0.1), 'every sub-segment should carry the source move feedScale')
  assert(out.every((move) => move.source === 'slot'), 'every sub-segment should carry the source move source tag')
  assert(out.every((move) => move.kind === 'cut'), 'every sub-segment should keep the move kind')
  // Sub-segments tile the original move contiguously from start to end.
  assert(approx(out[0].from.x, 0) && approx(out[out.length - 1].to.x, 10), 'sub-segments should span the original move')
  for (let i = 1; i < out.length; i += 1) {
    assert(approx(out[i].from.x, out[i - 1].to.x), 'sub-segments should be contiguous')
  }
  console.log('subdivideMoves preserves move metadata: PASSED')
}

function testSubdivideLeavesShortMovesUntouched(): void {
  console.log('Testing subdivideMoves leaves short moves (and their metadata) untouched...')
  const move: ToolpathMove = { kind: 'cut', from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 0, z: 0 }, feedScale: 0.5 }
  const out = subdivideMoves([move], 2)
  assert(out.length === 1, 'a move shorter than the max segment length should not be split')
  assert(out[0].feedScale === 0.5, 'short move should retain feedScale')
  console.log('subdivideMoves short-move passthrough: PASSED')
}

try {
  testSubdividePreservesMoveMetadata()
  testSubdivideLeavesShortMovesUntouched()
  console.log('\nAll playback tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
