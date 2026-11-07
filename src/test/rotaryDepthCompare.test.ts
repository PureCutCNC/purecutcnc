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
 * `compareRotaryDepth`'s interpolation between baseline passes (#1155 rn-a).
 *
 * A point between two baseline rings is compared with the **adjacent** rings on
 * either side, never with a deeper one further away: bridging past a raised
 * section would put the reference under it and let a cut into that section
 * pass. At one ring position the deepest layer is the one compared with.
 *
 * Mutation: pick the deepest crossing on each side instead of the adjacent one
 * (the 083eb1a7 helper) -> the raised-section check fails.
 *
 * Run with: npx tsx src/test/rotaryDepthCompare.test.ts
 */

import assert from 'node:assert/strict'
import { barPivotZ } from '../types/barStock'
import { roundStock } from '../types/project'
import type { ToolpathMove } from '../engine/toolpaths/types'
import { compareRotaryDepth } from './rotaryDepthCompare'

const stock = roundStock(40, 10, 'x')
const pivot = barPivotZ(stock)

/** A full ring at `along`, cut at tip radius `tip`, in 30-degree moves. */
function ring(along: number, tip: number): ToolpathMove[] {
  const moves: ToolpathMove[] = []
  for (let a = 0; a < 360; a += 30) {
    moves.push({
      kind: 'cut',
      from: { x: along, y: 0, z: pivot + tip, a },
      to: { x: along, y: 0, z: pivot + tip, a: a + 30 },
    })
  }
  return moves
}

/** One short cut at `along`, tip `tip`, from A 90 to A 91. */
function point(along: number, tip: number): ToolpathMove[] {
  return [{ kind: 'cut', from: { x: along, y: 0, z: pivot + tip, a: 90 }, to: { x: along, y: 0, z: pivot + tip, a: 91 } }]
}

const options = { alongTolerance: 1e-6, maxAlongGap: 1, depthTolerance: 0.1, airRadius: 20 }
let failures = 0

function check(name: string, run: () => void): void {
  try {
    run()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${name}`)
    console.error(`     ${error instanceof Error ? error.message : String(error)}`)
  }
}

check('a point between two raised rings is compared with them, not bridged under them', () => {
  // Codex's counterexample: the baseline stands at 15 between along 0.4 and 0.6,
  // with deeper rings at 0 and 1. A point at 0.5 down at 5 is 10 into the raised
  // section; bridging 0 -> 1 would call it level with the baseline.
  const baseline = [...ring(0, 5), ...ring(0.4, 15), ...ring(0.6, 15), ...ring(1, 5)]
  const result = compareRotaryDepth(baseline, point(0.5, 5), stock, options)
  assert.equal(result.bracketed, 2, 'both ends of the cut lie between two baseline rings')
  assert.equal(result.tooDeep, 2, `the cut 10 below the adjacent rings was not flagged (${result.where})`)
  assert.ok(Math.abs(result.deepest - 10) < 1e-9, `deepest ${result.deepest}, expected 10`)
})

check('a point level with the adjacent rings passes', () => {
  const baseline = [...ring(0, 5), ...ring(0.4, 15), ...ring(0.6, 15), ...ring(1, 5)]
  const result = compareRotaryDepth(baseline, point(0.5, 15), stock, options)
  assert.equal(result.tooDeep, 0)
  assert.equal(result.uncoveredInMaterial, 0)
})

check('at one ring position the deepest layer is the reference', () => {
  // Two layers at along 0.4 (15, then 14) and one at 0.6 (14): the floor at 0.5
  // is 14. A point at 14 passes; one at 13.8 is 0.2 too deep.
  const baseline = [...ring(0.4, 15), ...ring(0.4, 14), ...ring(0.6, 14)]
  assert.equal(compareRotaryDepth(baseline, point(0.5, 14), stock, options).tooDeep, 0)
  assert.equal(compareRotaryDepth(baseline, point(0.5, 13.8), stock, options).tooDeep, 2)
})

check('a point with no adjacent ring on one side is uncovered, not skipped', () => {
  const result = compareRotaryDepth(ring(0.4, 15), point(0.5, 5), stock, options)
  assert.equal(result.uncoveredInMaterial, 2)
})

if (failures > 0) {
  console.error(`rotaryDepthCompare.test.ts: ${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('rotaryDepthCompare.test.ts: all checks passed')
}
