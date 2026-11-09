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
 * The Export dialog's "Inspect exported motion" gate (issue #1179 correction
 * round 3).
 *
 * The gate used the plan view's eligibility, which refuses variable-Z cutting —
 * and every rotary rough/finish turns with a Z that changes from move to move.
 * The button was therefore missing for exactly the operations the 3D wrapped
 * view exists for. The gate now offers any motion carrying rotary angles,
 * whatever its Z profile, and refuses only motion with nothing to draw.
 *
 * Mutation checked: the gate put back to `getExportedMotionEligibility(...)`
 * alone → the variable-Z rotary cases below are refused and fail.
 *
 * Run with: npx tsx src/components/export/inspectMotionPlan.test.ts
 */

import type { ToolpathMove, ToolpathPoint } from '../../engine/toolpaths/types'
import { carriesRotaryAngles, planInspectMotion } from './inspectMotionPlan'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function pt(x: number, y: number, z: number, a?: number): ToolpathPoint {
  return a === undefined ? { x, y, z } : { x, y, z, a }
}

/** A rotary rough: every cutting move turns the stock and changes Z. */
function variableZRotary(): ToolpathMove[] {
  return [
    { kind: 'rapid', from: pt(0, 10, 25, 0), to: pt(0, 10, 25, 0) },
    { kind: 'plunge', from: pt(0, 10, 25, 0), to: pt(0, 10, 15, 0) },
    { kind: 'cut', from: pt(0, 10, 15, 0), to: pt(5, 10, 16, 45) },
    { kind: 'cut', from: pt(5, 10, 16, 45), to: pt(10, 10, 17, 90) },
  ]
}

/** The same variable-Z path with no rotary angle: a flat 3D surface cut. */
function variableZFlat(): ToolpathMove[] {
  return [
    { kind: 'rapid', from: pt(0, 10, 25), to: pt(0, 10, 25) },
    { kind: 'cut', from: pt(0, 10, 15), to: pt(5, 10, 16) },
    { kind: 'cut', from: pt(5, 10, 16), to: pt(10, 10, 17) },
  ]
}

/** An Around pocket: one cutting level, wrapped by the angle. */
function constantZRotary(): ToolpathMove[] {
  return [
    { kind: 'rapid', from: pt(0, 10, 20, 0), to: pt(0, 10, 20, 0) },
    { kind: 'cut', from: pt(0, 10, 16, 0), to: pt(5, 10, 16, 45) },
    { kind: 'cut', from: pt(5, 10, 16, 45), to: pt(10, 10, 16, 90) },
  ]
}

/** A flat milling route: constant Z, no angle. */
function constantZFlat(): ToolpathMove[] {
  return [
    { kind: 'rapid', from: pt(0, 10, 20), to: pt(0, 10, 20) },
    { kind: 'cut', from: pt(0, 10, 16), to: pt(5, 10, 16) },
    { kind: 'cut', from: pt(5, 10, 16), to: pt(10, 10, 16) },
  ]
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

test('a variable-Z rotary rough is offered the wrapped view', () => {
  const plan = planInspectMotion(variableZRotary())
  assert(plan.offer, 'the Inspect motion button is offered for a rotary rough')
  assert(plan.wrapped, 'and the dialog opens on the wrapped view')
  assert(plan.reason === null, 'with no refusal reason')
})

test('the wrapped offer comes from the angle, not from a Z that happens to vary', () => {
  // The control: the same shape of motion without the angle is a flat
  // variable-Z cut, which the plan view cannot draw and which must stay refused.
  const plan = planInspectMotion(variableZFlat())
  assert(!plan.offer, 'a flat variable-Z cut is still refused')
  assert(!plan.wrapped, 'and it has no wrapped view')
  assert(plan.reason === 'variableZ', `the refusal names the Z profile, got ${plan.reason}`)
})

test('a constant-Z rotary program is offered and opens wrapped', () => {
  const plan = planInspectMotion(constantZRotary())
  assert(plan.offer && plan.wrapped, 'an Around pocket keeps its 3D view and now opens on it')
})

test('a flat operation is offered the plan view only, exactly as before', () => {
  const plan = planInspectMotion(constantZFlat())
  assert(plan.offer, 'an eligible flat route is still offered')
  assert(!plan.wrapped, 'and it does not open on a wrapped view')
  assert(plan.reason === null, 'with no refusal reason')
})

test('rotary motion with nothing to cut is still refused', () => {
  const moves: ToolpathMove[] = [
    { kind: 'rapid', from: pt(0, 10, 25, 0), to: pt(10, 10, 25, 90) },
  ]
  const plan = planInspectMotion(moves)
  assert(!plan.offer, 'a rotary rapid-only motion offers nothing')
  assert(plan.reason === 'noCutMoves', `the reason is the missing cut, got ${plan.reason}`)
})

test('a canned-cycle trace stays refused even when it carries angles', () => {
  const plan = planInspectMotion({
    moves: variableZRotary(),
    drillCycles: [{ holes: [] }],
  })
  assert(!plan.offer, 'a drill cycle cannot be drawn as moves')
  assert(plan.reason === 'drilling', `the reason is drilling, got ${plan.reason}`)
})

test('the angle test reads either end of a move', () => {
  assert(carriesRotaryAngles([
    { kind: 'rapid', from: pt(0, 10, 25), to: pt(0, 10, 25) },
    { kind: 'cut', from: pt(0, 10, 16), to: pt(5, 10, 16, 90) },
  ]), 'an angle on the move end counts')
  assert(!carriesRotaryAngles(constantZFlat()), 'a motion with no angle on any point does not')
})

if (failed > 0) {
  console.error(`inspectMotionPlan tests failed: ${failed} of ${passed + failed}`)
  process.exit(1)
}
console.log(`inspectMotionPlan tests passed (${passed})`)
