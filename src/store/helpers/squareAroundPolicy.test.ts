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
 * The pure square-blank Around workflow policy (issue #1016 C2-U1).
 *
 * Two rules that used to be one are separated here: the Around face's
 * **workflow availability** (`aroundUnavailableReason`) admits either bar, and
 * its **sheet authoring** (`aroundSketchAuthoringAvailable`) stays round-only.
 * The blank's axis is read from either bar, and a square blank's non-rotary
 * Around operations stop counting as part of the job while staying stored.
 *
 * Mutations checked one at a time against these assertions:
 * - `aroundSketchAuthoringAvailable` answered from `aroundUnavailableReason`
 *   (i.e. the workflow guard used as the sketch permission) → the
 *   square-blank authoring refusals below fail;
 * - `defaultSetupForFace` / `syncProjectSetups` defaulting a square blank's
 *   Around axis to `'x'` → the Y-axis provisional and axis-repair assertions
 *   fail;
 * - `operationCutsInProject` letting a non-rotary operation on a square
 *   blank's Around setup count → the disabled-retained assertion fails.
 *
 * Run with: npx tsx src/store/helpers/squareAroundPolicy.test.ts
 */

import assert from 'node:assert/strict'
import { newProject, roundStock } from '../../types/project'
import { squareStock } from '../../types/barStock'
import type { MachiningSetup, Project, Stock } from '../../types/project'
import {
  aroundSketchAuthoringAvailable,
  aroundSketchAuthoringRefused,
  aroundUnavailableReason,
} from './activeFace'
import { defaultSetupForFace } from './provisionalSetup'
import { syncProjectSetups } from './setups'
import { defaultOperationForTarget } from './operationDefaults'
import { operationCutsInProject, stockShapesForProjectType } from './projectType'

function log(message: string): void {
  console.log(message)
}

const BLOCK: Stock = newProject('Block', 'mm').stock
const ROUND_X = roundStock(40, 200, 'x')
const ROUND_Y = roundStock(40, 200, 'y')
const SQUARE_X = squareStock(40, 200, 'x')
const SQUARE_Y = squareStock(40, 200, 'y')

function projectOfType(type: 'milling' | 'plasma' | 'rotary', stock: Stock): Project {
  const base = newProject('Policy fixture', 'mm')
  return { ...base, meta: { ...base.meta, projectType: type }, stock }
}

function aroundSetup(axis: 'x' | 'y'): MachiningSetup {
  return {
    id: 'around',
    name: 'Around',
    kind: 'around',
    orientation: { axis, angleDeg: 0 },
    indexing: 'manual',
    registration: [],
    notes: '',
    operationIds: [],
  }
}

function withAround(stock: Stock, axis: 'x' | 'y'): Project {
  return { ...projectOfType('rotary', stock), setups: [aroundSetup(axis)], activeSetupId: 'around' }
}

// ── 1. Workflow availability vs sheet authoring ───────────────

log('Testing Around workflow availability against square-blank authoring...')

assert.equal(aroundSketchAuthoringAvailable(projectOfType('rotary', ROUND_X)), true, 'a round bar authors the sheet')
assert.equal(aroundSketchAuthoringAvailable(projectOfType('rotary', SQUARE_X)), false, 'a square blank does not')
assert.equal(aroundSketchAuthoringAvailable(projectOfType('rotary', BLOCK)), false, 'a block does not')
assert.equal(aroundSketchAuthoringAvailable(projectOfType('milling', ROUND_X)), false, 'a milling project does not')
assert.equal(aroundSketchAuthoringAvailable(projectOfType('plasma', ROUND_X)), false, 'a plasma project does not')

assert.equal(aroundUnavailableReason(projectOfType('rotary', ROUND_X)), null, 'a round bar is available')
assert.equal(
  aroundUnavailableReason(projectOfType('rotary', SQUARE_X)),
  null,
  'a square blank is a turning job, so the face is workflow-available (#1016 C2-U1)',
)
assert.equal(
  aroundUnavailableReason(projectOfType('rotary', BLOCK)),
  'needsRoundBar',
  'the compatibility reason string is kept for "not a bar at all"',
)
assert.equal(aroundUnavailableReason(projectOfType('milling', ROUND_X)), 'needsRotaryProject', 'type is asked first')
assert.equal(aroundUnavailableReason(projectOfType('plasma', ROUND_X)), 'needsRotaryProject', 'plasma has no Around')

assert.equal(aroundSketchAuthoringRefused(projectOfType('rotary', SQUARE_X), 'around'), true, 'square Around drawing is refused')
assert.equal(aroundSketchAuthoringRefused(projectOfType('rotary', ROUND_X), 'around'), false, 'round Around drawing is allowed')
assert.equal(
  aroundSketchAuthoringRefused(projectOfType('rotary', BLOCK), 'around'),
  false,
  'a block is refused by availability, not by this round-only rule',
)
assert.equal(aroundSketchAuthoringRefused(projectOfType('milling', SQUARE_X), 'around'), false, 'other types are untouched')
assert.equal(aroundSketchAuthoringRefused(projectOfType('rotary', SQUARE_X), 'top'), false, 'only the Around face is concerned')

// ── 2. The Around axis follows either bar ─────────────────────

log('Testing the Around axis on a square blank...')

assert.deepEqual(defaultSetupForFace('around', { stock: SQUARE_X }).orientation, { axis: 'x', angleDeg: 0 })
assert.deepEqual(
  defaultSetupForFace('around', { stock: SQUARE_Y }).orientation,
  { axis: 'y', angleDeg: 0 },
  'a Y square blank provisional setup turns about Y, not a defaulted X',
)
assert.deepEqual(defaultSetupForFace('around', { stock: ROUND_Y }).orientation, { axis: 'y', angleDeg: 0 }, 'the round case is unchanged')
assert.deepEqual(defaultSetupForFace('around', { stock: BLOCK }).orientation, { axis: 'x', angleDeg: 0 }, 'a block keeps the X default')

const emptySquareY = withAround(SQUARE_Y, 'x')
assert.equal(
  syncProjectSetups(emptySquareY).setups[0].orientation.axis,
  'y',
  'an empty Around setup follows a square blank',
)
const emptySquareX = withAround(SQUARE_X, 'y')
assert.equal(syncProjectSetups(emptySquareX).setups[0].orientation.axis, 'x', 'and follows it on X')
const emptyRoundY = withAround(ROUND_Y, 'x')
assert.equal(syncProjectSetups(emptyRoundY).setups[0].orientation.axis, 'y', 'the round repair is unchanged')

const pinnedSquare = {
  ...withAround(SQUARE_Y, 'x'),
  operations: [
    { ...defaultOperationForTarget(withAround(SQUARE_Y, 'x'), 'pocket', 'rough', { source: 'stock' }, 0), id: 'op-around', setupId: 'around' },
  ],
}
assert.equal(
  syncProjectSetups(pinnedSquare).setups[0].orientation.axis,
  'x',
  'a non-empty Around setup keeps its axis: geometry is never silently transposed',
)

// ── 3. Stock shapes offered, and disabled operations retained ─

log('Testing stock shapes and the disabled square Around operations...')

assert.deepEqual([...stockShapesForProjectType('milling')], ['block'], 'milling cuts a block')
assert.deepEqual([...stockShapesForProjectType('plasma')], ['block'], 'plasma cuts a block')
assert.deepEqual([...stockShapesForProjectType('rotary')], ['round', 'square'], 'rotary turns either bar')
assert.equal(stockShapesForProjectType('rotary')[0], 'round', 'round stays the default')

const squareAround = withAround(SQUARE_X, 'x')
assert.equal(
  operationCutsInProject(squareAround, { kind: 'rotary_rough', setupId: 'around' }),
  true,
  'a rotary model operation still cuts on a square Around sheet',
)
assert.equal(
  operationCutsInProject(squareAround, { kind: 'rotary_finish', setupId: 'around' }),
  true,
  'rough and finish both cut',
)
assert.equal(
  operationCutsInProject(squareAround, { kind: 'pocket', setupId: 'around' }),
  false,
  'a non-rotary operation on a square Around sheet is disabled while it stays stored',
)
assert.equal(
  operationCutsInProject(squareAround, { kind: 'follow_line', setupId: 'around' }),
  false,
  'every non-rotary kind is disabled there',
)
assert.equal(
  operationCutsInProject(withAround(ROUND_X, 'x'), { kind: 'pocket', setupId: 'around' }),
  true,
  'the round-bar behavior is unchanged',
)
assert.equal(
  operationCutsInProject(
    { ...projectOfType('milling', SQUARE_X), setups: [aroundSetup('x')] },
    { kind: 'pocket', setupId: 'around' },
  ),
  false,
  'a non-rotary project already hides it, and is untouched',
)

log('squareAroundPolicy: all assertions passed.')
