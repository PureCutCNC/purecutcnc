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
 * `appendAll` tests — issue #668.
 *
 * The point of the helper is the one case a spread cannot do: an array past
 * the engine's argument limit. The size below is checked against the limit
 * measured on the running engine, so the test cannot decay into appending an
 * array the spread would have handled anyway.
 *
 * Run with: npx tsx src/engine/toolpaths/appendAll.test.ts
 */

import { maxSpreadableLength } from '../../test/spreadLimit'
import { appendAll } from './appendAll'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`   ✓ ${name}`)
  } catch (err: unknown) {
    failed += 1
    console.log(`   ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Comfortably past the 124,413 measured on node v26.0.0, and past its spread on any engine we run. */
const OVERSIZE = 200_000

test('the fixture size really does exceed this engine\'s argument limit', () => {
  const limit = maxSpreadableLength()
  assert(OVERSIZE > limit,
    `fixture no longer exceeds the engine's spread limit (${limit}) — grow OVERSIZE past it`)

  const source = new Array<number>(OVERSIZE).fill(0)
  let threw = false
  try {
    const target: number[] = []
    target.push(...source)
  } catch (err: unknown) {
    threw = err instanceof RangeError
  }
  assert(threw, 'spreading the oversize fixture into push() must still throw RangeError')
})

test('appends an array past the argument limit without throwing', () => {
  const source = Array.from({ length: OVERSIZE }, (_, index) => ({ index }))
  const target = [{ index: -3 }, { index: -2 }, { index: -1 }]

  appendAll(target, source)

  assert(target.length === OVERSIZE + 3, `expected ${OVERSIZE + 3} elements, got ${target.length}`)
  assert(target[0].index === -3, 'existing elements must stay in front')
  assert(target[3] === source[0], 'appended elements must be the same objects, in order')
  assert(target[OVERSIZE / 2 + 3] === source[OVERSIZE / 2], 'mid-array order must be preserved')
  assert(target.at(-1) === source.at(-1), 'last appended element must be the source\'s last')
})

test('appends nothing for an empty source and returns the target', () => {
  const target = [1, 2, 3]
  const returned = appendAll(target, [])
  assert(returned === target, 'must return the same array it appended onto')
  assert(target.length === 3, 'empty source must leave the target untouched')
})

test('accepts any iterable, not just arrays', () => {
  const source = new Map([['a', 1], ['b', 2]])
  const target: number[] = [0]
  appendAll(target, source.values())
  assert(target.join(',') === '0,1,2', `expected 0,1,2, got ${target.join(',')}`)
})

console.log(`\nappendAll: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
