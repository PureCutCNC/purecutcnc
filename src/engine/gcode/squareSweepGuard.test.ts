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
 * Boundary tests for the square turn guard's engagement bound (#1045 slice E,
 * manager review pass).
 *
 * The guard's only over-bound repro used to be a cut 5.142 mm past a 2 mm
 * stepdown, so a mutation that doubled the bound (`operation.stepdown * 2`)
 * survived every suite. These tests put a hand-built around-mode turning cut
 * **just above** and **just below** the operation's own bound on the 20 mm
 * square blank, for a rough and for a finish after a rough, and measure the
 * cut's true engagement from the blank's own corner geometry — never from the
 * guard's grid or its tolerance.
 *
 * A turning cut at a constant tip over A0→A45 sweeps the blank's corner at
 * A45. Its true engagement is therefore `halfSide * √2 - tip`, the corner
 * radius less the tip: the deepest standing material the cut removes. (The
 * guard's 0.5° grid samples the corner at 44.75°/45.25°, just under that
 * radius; its own angular tolerance is what covers the difference, and the
 * "just above" cases are placed above that tolerance-inclusive bound too.)
 *
 * The finish case also pins the rough allowance: a rough at x 5 is admitted
 * (its own 2 mm layer is within its 2 mm bound), which sets the allowance a
 * finish over the same target may take. The finish cuts the still-raw blank at
 * x 20, so its engagement is measured against the blank, not against the
 * rough's cut. Its "just above" engagement is `stockToLeave + allowance +
 * 0.2 mm`, which is above the finish's nominal bound by less than the old
 * `+ alongBin` term (0.5 mm) used to add, so restoring that term makes this
 * test fail.
 *
 * Run with: npx tsx src/engine/gcode/squareSweepGuard.test.ts
 */

import assert from 'node:assert/strict'
import { defaultTool, newProject } from '../../types/project'
import type { Operation, OperationTarget, Project } from '../../types/project'
import { barCentre, barPivotZ, squareStock } from '../../types/barStock'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { operationTargetKey } from '../setupTargets'
import type { ToolpathMove } from '../toolpaths/types'
import { createSquareSweepState, guardSquareOperation } from './squareSweepGuard'
import type { SquareSweepState } from './squareSweepGuard'
import type { EmittedSquareCutter } from '../squareRotarySafety'

// ── fixture: the 20 mm square blank, a Ø4 flat, one rough and one finish ──

const STOCK = squareStock(20, 40, 'x', { x: 0, y: 0 })
const PIVOT = barPivotZ(STOCK)
const CENTRE = barCentre(STOCK)
const HALF_SIDE = STOCK.thickness / 2
/** The blank's own corner radius: `halfSide * √2`, written independently of the guard. */
const CORNER = HALF_SIDE * Math.SQRT2
const TRAVEL_Z = PIVOT + CORNER + 1
const ROUNDING = 0.0005

const project: Project = newProject('square sweep guard boundary', 'mm')
project.meta.projectType = 'rotary'
project.stock = STOCK
const tool = {
  ...defaultTool('mm', 1),
  id: 'flat-4',
  name: 'Flat 4',
  units: 'mm' as const,
  type: 'flat_endmill' as const,
  diameter: 4,
}
project.tools = [tool]
const target: OperationTarget = { source: 'stock' }

const rough: Operation = {
  ...defaultOperationForTarget(project, 'rotary_rough', 'rough', target, 0),
  rotaryPassDirection: 'around',
  stepdown: 2,
  stockToLeaveRadial: 0,
}
const finish: Operation = {
  ...defaultOperationForTarget(project, 'rotary_finish', 'finish', target, 1),
  rotaryPassDirection: 'around',
  stockToLeaveRadial: 0,
}

const CUTTER: EmittedSquareCutter = {
  id: tool.id,
  units: tool.units,
  type: tool.type,
  diameter: tool.diameter,
  radius: tool.diameter / 2,
}

/** One point on the bar's centreline, in project units. */
function at(along: number, tip: number, angle: number) {
  return { x: along, y: CENTRE, z: PIVOT + tip, a: angle }
}

/**
 * A rapid into position at a safe height, then one constant-tip turning cut.
 * The rapid does not turn (both ends carry the same A), so the guard skips it;
 * the cut is the move under test.
 */
function turningCut(along: number, tip: number, fromAngle: number, toAngle: number): ToolpathMove[] {
  return [
    { kind: 'rapid', from: at(along, CORNER + 1.5, fromAngle), to: at(along, CORNER + 1.5, fromAngle) },
    { kind: 'cut', from: at(along, tip, fromAngle), to: at(along, tip, toAngle) },
  ]
}

function freshState(): SquareSweepState {
  return createSquareSweepState(STOCK, CUTTER.radius)
}

function admit(state: SquareSweepState, operation: Operation, moves: ToolpathMove[], entryAngle: number | null): boolean {
  return guardSquareOperation(state, {
    operation,
    moves,
    cutter: CUTTER,
    entryAngle,
    direction: 1,
    travelZ: TRAVEL_Z,
    roundingAllowance: ROUNDING,
  })
}

/**
 * Run the prior rough at x 5 and return the state it fed. Its 2 mm layer at the
 * corner is exactly its `stepdown`, so it is admitted and leaves a 2 mm
 * allowance for a finish over the same target. It is 15 mm away from the
 * finish's x 20, so the finish still sees the raw blank there.
 */
function stateAfterRough(): SquareSweepState {
  const state = freshState()
  const admitted = admit(state, rough, turningCut(5, CORNER - rough.stepdown, 0, 45), null)
  assert.equal(admitted, true, 'fixture: the prior rough takes one stepdown and is admitted')
  assert.equal(
    state.roughAllowance.get(operationTargetKey(rough.target)),
    rough.stepdown + rough.stockToLeaveRadial,
    'fixture: the admitted rough leaves its stepdown plus radial stock as the allowance',
  )
  return state
}

/** The blank's own surface radius along the ray at `angleDeg`, from its half-side. */
function blankRadius(angleDeg: number): number {
  const radians = angleDeg * Math.PI / 180
  return HALF_SIDE / Math.max(Math.abs(Math.cos(radians)), Math.abs(Math.sin(radians)))
}

/**
 * The true engagement of a constant-tip turn over an angle range: the highest
 * material radius the sweep reaches on the **blank's own surface**, less the
 * tip. Sampled from the blank geometry, never from the guard's grid.
 */
function trueEngagement(fromAngle: number, toAngle: number, tip: number): number {
  const steps = 10000
  let material = Number.NEGATIVE_INFINITY
  for (let i = 0; i <= steps; i++) {
    material = Math.max(material, blankRadius(fromAngle + (toAngle - fromAngle) * i / steps))
  }
  return material - tip
}

// ── 1. the rough's bound is its own stepdown ──────────────────

console.log('Testing the rough engagement boundary on the 20 mm square blank...')
{
  const stepdown = rough.stepdown
  const above = 1.25 * stepdown
  const below = 0.9 * stepdown
  assert.ok(above > stepdown && above < 1.5 * stepdown, 'fixture: the rough probe is just above one stepdown')
  assert.ok(below < stepdown, 'fixture: the rough probe below is one stepdown at most')

  const refused = admit(freshState(), rough, turningCut(20, CORNER - above, 0, 45), null)
  assert.equal(
    refused,
    false,
    `a rough cut taking ${above.toFixed(3)} mm (1.25 x stepdown ${stepdown}) is refused`,
  )

  const admitted = admit(freshState(), rough, turningCut(20, CORNER - below, 0, 45), null)
  assert.equal(
    admitted,
    true,
    `a rough cut taking ${below.toFixed(3)} mm (0.9 x stepdown ${stepdown}) is admitted`,
  )

  // The two probes differ only in their tip, and the engagement is read from
  // the blank's own surface over the same A0 -> A45 sweep -- not from the
  // guard's grid and not from the guard's own tolerance.
  assert.ok(Math.abs(trueEngagement(0, 45, CORNER - above) - above) < 1e-6,
    `the blank surface gives the above probe ${trueEngagement(0, 45, CORNER - above).toFixed(6)} mm`)
  assert.ok(Math.abs(trueEngagement(0, 45, CORNER - below) - below) < 1e-6,
    `the blank surface gives the below probe ${trueEngagement(0, 45, CORNER - below).toFixed(6)} mm`)
}

// ── 2. the finish's bound is stockToLeave + the rough's allowance ──

console.log('Testing the finish engagement boundary on the 20 mm square blank...')
{
  const allowance = rough.stepdown + rough.stockToLeaveRadial
  const nominal = finish.stockToLeaveRadial + allowance
  const above = nominal + 0.2
  const below = 0.9 * nominal
  assert.ok(above > nominal, 'fixture: the finish probe is just above its nominal bound')
  assert.ok(above - nominal < 0.5, 'fixture: and it is inside the old + alongBin term so that term bites')
  assert.ok(below < nominal, 'fixture: the finish probe below is under its nominal bound')

  // The finish starts at the corner (A45, handed over by the prior rough) and
  // turns to the flat at A90, so its cut sweeps the corner.
  const refused = admit(stateAfterRough(), finish, turningCut(20, CORNER - above, 45, 90), 45)
  assert.equal(
    refused,
    false,
    `a finish cut taking ${above.toFixed(3)} mm (stockToLeave ${finish.stockToLeaveRadial} + allowance ${allowance} + 0.2) is refused`,
  )

  const admitted = admit(stateAfterRough(), finish, turningCut(20, CORNER - below, 45, 90), 45)
  assert.equal(
    admitted,
    true,
    `a finish cut taking ${below.toFixed(3)} mm (0.9 x its ${nominal.toFixed(3)} bound) is admitted`,
  )

  assert.ok(Math.abs(trueEngagement(45, 90, CORNER - above) - above) < 1e-6,
    `the blank surface gives the above probe ${trueEngagement(45, 90, CORNER - above).toFixed(6)} mm`)
  assert.ok(Math.abs(trueEngagement(45, 90, CORNER - below) - below) < 1e-6,
    `the blank surface gives the below probe ${trueEngagement(45, 90, CORNER - below).toFixed(6)} mm`)
}

console.log('engine/gcode/squareSweepGuard.test.ts: all assertions passed')
