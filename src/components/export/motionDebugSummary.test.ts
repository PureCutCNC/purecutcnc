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
 * The count-only model a variable-Z rotary path is described with (issue #1179
 * correction round 3).
 *
 * The per-level plan model is not built for such a path — a 12,700-move rotary
 * rough yields 4,378 levels and takes seconds to compare — but the sidebar
 * still has to report the program. This suite holds the two properties that
 * keep that honest: the counts follow the plan model's own rules, and the model
 * carries no layers, no levels and no verdict, so the dialog cannot draw or
 * claim anything from it.
 *
 * Run with: npx tsx src/components/export/motionDebugSummary.test.ts
 */

import type { ParsedGcodeMotion } from '../../engine/gcode'
import type { ToolpathGenerationTrace, ToolpathMove } from '../../engine/toolpaths/types'
import { summaryMotionModel } from './motionDebugSummary'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function move(kind: ToolpathMove['kind'], a: number, b: number): ToolpathMove {
  return { kind, from: { x: a, y: 10, z: 16 }, to: { x: b, y: 10, z: 16 } }
}

function trace(): ToolpathGenerationTrace {
  const result = (moves: ToolpathMove[]) => ({ operationId: 'op', moves, warnings: [], bounds: null })
  return { operationId: 'op', raw: result([move('cut', 0, 1), move('cut', 1, 2)]), optimized: result([move('cut', 0, 2)]) }
}

const PARSED: ParsedGcodeMotion = {
  status: 'verified',
  moves: [
    { kind: 'rapid', from: { x: 0, y: 10, z: 25 }, to: { x: 0, y: 10, z: 16 } },
    { kind: 'linear', from: { x: 0, y: 10, z: 16 }, to: { x: 1, y: 10, z: 17 } },
    { kind: 'arc', from: { x: 1, y: 10, z: 17 }, to: { x: 2, y: 10, z: 18 }, center: { x: 1.5, y: 10 }, radius: 0.5, clockwise: true, largeArc: false },
    { kind: 'arc', from: { x: 2, y: 10, z: 18 }, to: { x: 3, y: 10, z: 19 }, center: { x: 2.5, y: 10 }, radius: 0.5, clockwise: false, largeArc: false },
  ],
  warnings: [],
}

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`   \u2713 ${name}`)
  } catch (error) {
    failed += 1
    console.log(`   \u2717 ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

test('the counts follow the plan model\'s own rules', () => {
  const model = summaryMotionModel(trace(), PARSED)
  assert(model.metrics.rawMoveCount === 2, `raw counts every generated move, got ${model.metrics.rawMoveCount}`)
  assert(model.metrics.optimizedMoveCount === 1, `optimized counts the final path, got ${model.metrics.optimizedMoveCount}`)
  assert(model.metrics.removedMoveCount === 1, `removed is raw minus optimized, got ${model.metrics.removedMoveCount}`)
  assert(model.metrics.emitted.rapid === 1, 'one rapid is emitted')
  assert(model.metrics.emitted.linear === 1, 'one linear is emitted')
  assert(model.metrics.emitted.arcCw === 1 && model.metrics.emitted.arcCcw === 1,
    `arcs split by direction, got cw=${model.metrics.emitted.arcCw} ccw=${model.metrics.emitted.arcCcw}`)
})

test('there is nothing to draw, select or verify in it', () => {
  const model = summaryMotionModel(trace(), PARSED)
  for (const id of ['generated', 'optimized', 'exported'] as const) {
    assert(model.layers[id].segments.length === 0, `the ${id} layer is empty: there is no plan model`)
  }
  assert(model.zLevels.length === 0, 'no cutting-level list is offered')
  assert(model.zLevelStats.length === 0, 'and no per-level rows')
  assert(model.bounds === null, 'and no plan bounds, so a 2D view cannot frame anything')
  assert(model.diagnostic.warnings.length === 0, 'no comparison warnings are invented')
})

if (failed > 0) {
  console.error(`motionDebugSummary tests failed: ${failed} of ${passed + failed}`)
  process.exit(1)
}
console.log(`motionDebugSummary tests passed (${passed})`)
