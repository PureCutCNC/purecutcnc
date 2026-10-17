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
 * The square blank through the saved-operation adapter (#1016 C2-S3), and the
 * production dispatch that now admits it (#1016 C2-S4).
 *
 * `generateRotaryOperation` is the seam `generateOperation.ts` calls for
 * `rotary_rough` / `rotary_finish` only, so accepting a square blank here
 * cannot enable a wrapped 2D path: a non-rotary kind never reaches it. The
 * production dispatch in front of it (`setupGenerationBlock`,
 * `src/engine/setupTargets.ts`) additionally requires a bar on the matching
 * Around axis, a real model target, and a physical workholding / ordinary-clamp
 * setup the square corner envelope supports; the store / UI guards
 * (`activeFace.ts`, `operationValidity.ts`, the CSG and overlay readers) still
 * refuse square stock and are the required off-scope integration guards
 * reported with this slice — not silently widened.
 *
 * Mutations checked: `safeRadius` from the inscribed radius (the low-rapid
 * assertion fails), the adapter still gated on `isRoundStock` (every square
 * case fails), max-corner clearance dropped (the low-rapid assertion fails).
 * Run with: npx tsx src/engine/toolpaths/squareRotaryOperation.test.ts
 */

import assert from 'node:assert/strict'
import { isDeepStrictEqual } from 'node:util'
import { barCentre, barMaxRadius, barPivotZ, squareStock } from '../../types/barStock'
import { isRoundStock, newProject } from '../../types/project'
import type { Clamp, RoundStock, SquareStock } from '../../types/project'
import { rotaryOperationFixture } from '../../test/rotaryOperationFixture'
import { defaultRoundWorkholding } from '../../store/helpers/roundWorkholding'
import { computeOperationToolpath } from './generateOperation'
import { generateRotaryOperation } from './rotaryOperation'
import { rotaryAlongRange } from './rotaryModel'
import { normalizeToolForProject } from './geometry'
import type { ToolpathMove } from './types'

function approx(actual: number, expected: number, label: string, tolerance = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: got ${actual}, expected ${expected}`)
}

function distinctAngles(moves: readonly ToolpathMove[]): number {
  return new Set(moves.filter((m) => m.to.a !== undefined).map((m) => Math.round(m.to.a! % 360 * 1e6) / 1e6)).size
}

/**
 * The fixture's blank relabelled to a square of the same physical box, with the
 * S2 default square workholding: a chuck centred on the true pivot whose outer
 * diameter clears the corner envelope. The round-sized fixture chuck is too
 * small for a square blank, so it is replaced — the physical guard's refusal of
 * exactly that case is exercised in `squareRotaryOutput.test.ts`.
 */
function squareProject(axis: 'x' | 'y', kind: 'rotary_rough' | 'rotary_finish', at = { x: 0, y: 0 }) {
  const project = rotaryOperationFixture(axis, kind)
  const stock = project.stock
  assert.ok(isRoundStock(stock), 'the fixture ships a round bar')
  const square: SquareStock = squareStock(stock.thickness, 30, axis, at)
  const chuck: Clamp = { ...defaultRoundWorkholding('chuck', square, 'mm'), id: 'chuck', name: 'Chuck', visible: true }
  return { project: { ...project, stock: square, clamps: [chuck] }, square, chuck }
}

for (const axis of ['x', 'y'] as const) {
  for (const kind of ['rotary_rough', 'rotary_finish'] as const) {
    const { project, square } = squareProject(axis, kind)
    const operation = project.operations[0]
    const centre = barCentre(square)
    // The pivot and envelope from the blank's own side, not the helpers, so a
    // pivot/envelope mutation cannot move the expectation with it.
    const pivot = square.thickness / 2
    const maxRadius = square.thickness * Math.SQRT1_2
    assert.equal(barPivotZ(square), pivot, `${axis} ${kind} barPivotZ is side / 2`)
    approx(barMaxRadius(square), maxRadius, `${axis} ${kind} barMaxRadius is the corner radius`)
    const tool = normalizeToolForProject(project.tools[0], project)
    const result = generateRotaryOperation(project, operation)
    assert.ok(result.moves.length > 0, `${axis} ${kind} square blank produces moves`)
    assert.ok(!result.warnings.some((w) => w.code === 'rotaryModelOutsideBar'), `${axis} ${kind} model is inside the blank`)
    for (const move of result.moves) {
      for (const point of [move.from, move.to]) {
        assert.ok(point.a !== undefined, `${axis} ${kind} every endpoint carries A`)
        assert.equal(axis === 'x' ? point.y : point.x, centre, `${axis} ${kind} across stays on the pivot`)
        assert.ok(point.z >= pivot - 1e-9, `${axis} ${kind} never cuts below the pivot`)
      }
    }
    const along = (point: { x: number; y: number }) => axis === 'x' ? point.x : point.y
    const range = rotaryAlongRange(square, project.clamps, { min: 3, max: 27 }, tool, { chuckEnd: 0, tailEnd: 0 })!
    for (const move of result.moves) for (const point of [move.from, move.to]) {
      assert.ok(along(point) >= range.start - 1e-9 && along(point) <= range.end + 1e-9, `${axis} ${kind} respects the along range`)
    }
    // The saved rapid height is a tip radius from the pivot; whatever the
    // project's ceiling, the first positioning move clears the corner envelope.
    const firstZ = result.moves[0].to.z
    assert.ok(firstZ >= pivot + maxRadius, `${axis} ${kind} opens above the corner envelope`)
    console.log(`square op ${axis} ${kind}: ${result.moves.length} moves, ${distinctAngles(result.moves)} angles, first Z ${firstZ.toFixed(4)}`)
  }
}

// ── safeRadius is relative to the pivot, with maxRadius clearance ─────
for (const axis of ['x', 'y'] as const) {
  for (const kind of ['rotary_rough', 'rotary_finish'] as const) {
    const { project, square } = squareProject(axis, kind)
    const operation = project.operations[0]
    const pivot = square.thickness / 2
    const maxRadius = square.thickness * Math.SQRT1_2
    assert.equal(barPivotZ(square), pivot, `${axis} ${kind} barPivotZ is side / 2`)
    const tool = normalizeToolForProject(project.tools[0], project)
    // A saved ceiling below the blank's corners cannot clear them: the fallback
    // is one tool diameter above the corner envelope (the inscribed radius on a
    // round bar would be too low).
    const low = generateRotaryOperation({ ...project, meta: { ...project.meta, maxTravelZ: 5 } }, operation)
    assert.ok(low.moves.length > 0, `${axis} ${kind} low ceiling still produces moves`)
    approx(low.moves[0].to.z, pivot + maxRadius + tool.diameter, `${axis} ${kind} low rapid clears the corners`, 1e-9)
    const roundLow = generateRotaryOperation(
      { ...project, stock: { ...square, shape: 'round' } as RoundStock, meta: { ...project.meta, maxTravelZ: 5 } },
      operation,
    )
    approx(roundLow.moves[0].to.z, pivot + pivot + tool.diameter, `${axis} ${kind} round low rapid is unchanged`, 1e-9)
    // A ceiling above the blank is used as-is, on a square as on a round bar.
    const high = generateRotaryOperation(project, operation)
    approx(high.moves[0].to.z, project.meta.maxTravelZ, `${axis} ${kind} a high ceiling is honoured`, 1e-9)
  }
}

// ── conservative angular sampling at the corner radius ────────────────
{
  const { project, square } = squareProject('x', 'rotary_finish')
  const operation = project.operations[0]
  const squareResult = generateRotaryOperation(project, operation)
  const round: RoundStock = { ...square, shape: 'round' }
  const roundResult = generateRotaryOperation({ ...project, stock: round }, operation)
  assert.ok(distinctAngles(squareResult.moves) > distinctAngles(roundResult.moves),
    'the square blank demands more passes than the round bar of the same box')
  console.log(`square op: ${distinctAngles(squareResult.moves)} square passes > ${distinctAngles(roundResult.moves)} round`)
}

// ── existing refusals still refuse a square blank ─────────────────────
{
  const { project } = squareProject('x', 'rotary_rough')
  const operation = project.operations[0]
  const code = (result: { warnings: Array<{ code: string }> }) => result.warnings[0]?.code
  assert.equal(code(generateRotaryOperation({ ...project, stock: newProject().stock }, operation)), 'aroundStockMismatch',
    'a block is still refused')
  assert.equal(code(generateRotaryOperation(project, { ...operation, setupId: project.setups[0].id })), 'aroundStockMismatch',
    'a non-Around setup is still refused')
  assert.equal(code(generateRotaryOperation({ ...project, tools: [{ ...project.tools[0], type: 'v_bit' }] }, operation)), 'rotaryToolUnsupported',
    'an unsupported tool is still refused')
  assert.equal(code(generateRotaryOperation({ ...project, tools: [] }, operation)), 'noToolAssigned',
    'a missing tool is still refused')
  assert.equal(code(generateRotaryOperation(project, { ...operation, target: { source: 'features', featureIds: [] } })), 'finishNeedsModel',
    'an empty target is still refused')
  assert.equal(code(generateRotaryOperation(project, { ...operation, rotaryChuckSupport: 30 })), 'rotaryNoRoom',
    'no room between the supports is still refused')
  assert.equal(code(generateRotaryOperation({ ...project, stock: { ...project.stock, shape: undefined } }, operation)), 'aroundStockMismatch',
    'a legacy block (no shape) is still refused')
}

// ── off-origin, inch, and response to inputs ──────────────────────────
{
  const offOrigin = squareProject('x', 'rotary_rough', { x: 3, y: -4 })
  const operation = offOrigin.project.operations[0]
  const result = generateRotaryOperation(offOrigin.project, operation)
  assert.ok(result.moves.length > 0, 'an off-origin square blank produces moves')
  assert.equal(barCentre(offOrigin.square), -4 + 6, 'the off-origin pivot is the box centre')
  for (const move of result.moves) assert.equal(move.to.y, barCentre(offOrigin.square), 'across stays on the off-origin pivot')
  const changed = generateRotaryOperation(offOrigin.project, { ...operation, stockToLeaveRadial: 1.2 })
  assert.ok(!isDeepStrictEqual(changed.moves, result.moves), 'radial stock changes the square output')
  const finer = generateRotaryOperation(offOrigin.project, { ...operation, stepdown: 0.4 })
  assert.ok(!isDeepStrictEqual(finer.moves, result.moves), 'stepdown changes the square rough output')
  console.log('square op: off-origin pivot, radial stock and stepdown all reach the square path')
}

// ── the production dispatch accepts the safe square blank ────────────
{
  const { project } = squareProject('x', 'rotary_finish')
  const operation = project.operations[0]
  const envelope = computeOperationToolpath(project, operation)
  assert.ok(envelope, 'the dispatch returns an envelope')
  assert.ok(envelope.result.moves.length > 0, 'the production dispatch generates the square blank')
  assert.ok(
    !envelope.result.warnings.some((warning) => warning.code === 'aroundStockMismatch'),
    'and does not report a stock/setup mismatch',
  )
  assert.equal(envelope.raw, null, 'the rotary dispatch never carries a flat trace')
  for (const move of envelope.result.moves) {
    assert.ok(move.to.a !== undefined, 'every dispatched move carries an angle')
    assert.equal(move.to.y, barCentre(project.stock as SquareStock), 'and stays on the true pivot across the bar')
  }
  console.log(`square op: production dispatch generates ${envelope.result.moves.length} moves, `
    + `${distinctAngles(envelope.result.moves)} angles`)
}

// ── an unusable radial allowance refuses at the operation seam ─────────
//
// The saved operation's allowance reaches `rotaryTargets` unchanged. The
// fixture's ball is 2 mm across, so -2 leaves a negative sampling radius, -1
// leaves zero, and NaN / Infinity fail finiteness: every one must refuse with
// no motion rather than let the rough read "no model" everywhere and cut to
// the pivot (#1016 C2 correction M1). A valid allowance still generates.
for (const kind of ['rotary_rough', 'rotary_finish'] as const) {
  const { project } = squareProject('x', kind)
  const operation = project.operations[0]
  assert.ok(generateRotaryOperation(project, operation).moves.length > 0, `${kind}: the fixture generates`)
  for (const allow of [-2, -1, NaN, Infinity]) {
    const result = generateRotaryOperation(project, { ...operation, stockToLeaveRadial: allow })
    assert.deepEqual(result.moves, [], `${kind}: allowance ${String(allow)} emits no moves`)
    assert.equal(result.warnings[0]?.code, 'rotaryStockToLeaveInvalid', `${kind}: allowance ${String(allow)} says why`)
    assert.equal(result.bounds, null, `${kind}: allowance ${String(allow)} has no bounds`)
  }
  const valid = generateRotaryOperation(project, { ...operation, stockToLeaveRadial: 0.5 })
  assert.ok(valid.moves.length > 0, `${kind}: a valid allowance still generates`)
  assert.deepEqual(valid.warnings, [], `${kind}: a valid allowance raises no warning`)
}

console.log('engine/toolpaths/squareRotaryOperation.test.ts: all assertions passed')
