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
 * Tests for 3D viewport toolpath overlay helpers.
 *
 * Run with: npx tsx src/components/viewport3d/toolpathOverlay.test.ts
 */

import type { ToolpathMove } from '../../engine/toolpaths/types'
import {
  buildToolpathLinePositionChunks,
  toolpathPointToWorldTuple,
} from './toolpathOverlay'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function makeMove(index: number): ToolpathMove {
  return {
    kind: 'cut',
    from: { x: index, y: index + 10, z: index + 20 },
    to: { x: index + 0.5, y: index + 10.5, z: index + 20.5 },
  }
}

function assertArrayEquals(actual: number[], expected: number[], message: string): void {
  assert(actual.length === expected.length, `${message}: expected length ${expected.length}, got ${actual.length}`)
  for (let i = 0; i < expected.length; i += 1) {
    assert(Math.abs(actual[i] - expected[i]) <= 1e-9, `${message}: index ${i}, expected ${expected[i]}, got ${actual[i]}`)
  }
}

function testPointMapping(): void {
  console.log('Testing toolpath point maps Z to 3D vertical axis...')
  assertArrayEquals(
    toolpathPointToWorldTuple({ x: 1, y: 2, z: 3 }),
    [1, 3, 2],
    'world tuple',
  )
}

function testChunkedLinePositions(): void {
  console.log('Testing toolpath line positions are chunked and mapped...')
  const moves = [0, 1, 2, 3, 4].map(makeMove)
  const chunks = buildToolpathLinePositionChunks(moves, 2)

  assert(chunks.length === 3, `expected 3 chunks, got ${chunks.length}`)
  assert(chunks[0].segmentCount === 2, `expected first chunk to have 2 segments, got ${chunks[0].segmentCount}`)
  assert(chunks[1].segmentCount === 2, `expected second chunk to have 2 segments, got ${chunks[1].segmentCount}`)
  assert(chunks[2].segmentCount === 1, `expected third chunk to have 1 segment, got ${chunks[2].segmentCount}`)

  assertArrayEquals(
    Array.from(chunks[0].positions.slice(0, 12)),
    [
      0, 20, 10,
      0.5, 20.5, 10.5,
      1, 21, 11,
      1.5, 21.5, 11.5,
    ],
    'first chunk positions',
  )
}

function testEmptyMovesDoNotAllocateChunks(): void {
  console.log('Testing empty toolpath line positions produce no chunks...')
  const chunks = buildToolpathLinePositionChunks([], 2)
  assert(chunks.length === 0, `expected no chunks, got ${chunks.length}`)
}

testPointMapping()
testChunkedLinePositions()
testEmptyMovesDoNotAllocateChunks()

console.log('toolpathOverlay tests passed')
