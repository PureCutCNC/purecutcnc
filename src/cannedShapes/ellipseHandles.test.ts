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
 * A canned ellipse's radius handles (issue #1112 slice w3e-a).
 *
 * Run with: npx tsx src/cannedShapes/ellipseHandles.test.ts
 *
 * The load-bearing properties:
 *   1. Each handle sits at the end of its own local axis, placed by the
 *      instance — translation, rotation, mirror and uniform scale all included.
 *   2. A drag reads only its own axis, so the handle travels along that axis,
 *      the centre never moves, and the other radius is untouched.
 *   3. The radius stays positive: a drag onto or through the centre clamps at
 *      the minimum instead of inverting the ellipse.
 *   4. The result goes through the same normalization the Edit panel uses.
 */

import assert from 'node:assert/strict'
import type { Matrix2D } from '../types/project'
import { multiplyMatrix, rotateMatrix, translateMatrix } from '../store/helpers/instanceTransforms'
import { normalizeEllipseCannedParams, type EllipseCannedParams } from './generators/ellipse'
import {
  ELLIPSE_RADIUS_MIN,
  dragEllipseRadius,
  ellipseRadiusCentre,
  ellipseRadiusFromWorldPoint,
  ellipseRadiusHandlePoint,
  ellipseRadiusHandles,
} from './ellipseHandles'

const IDENTITY: Matrix2D = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
const PARAMS: EllipseCannedParams = { rx: 30, ry: 20 }

function close(actual: { x: number; y: number }, expected: { x: number; y: number }, message: string): void {
  assert.ok(
    Math.abs(actual.x - expected.x) < 1e-9 && Math.abs(actual.y - expected.y) < 1e-9,
    `${message}: expected (${expected.x}, ${expected.y}), got (${actual.x}, ${actual.y})`,
  )
}

// ── 1. Handle positions ────────────────────────────────────────────────

const identityHandles = ellipseRadiusHandles(PARAMS, IDENTITY)
assert.equal(identityHandles.length, 2, 'one handle for each radius')
assert.equal(identityHandles[0].axis, 'rx', 'the first handle is the local X radius')
assert.equal(identityHandles[1].axis, 'ry', 'the second handle is the local Y radius')
close(identityHandles[0].world, { x: 30, y: 0 }, 'the X handle is at (rx, 0)')
close(identityHandles[1].world, { x: 0, y: 20 }, 'the Y handle is at (0, ry)')
close(ellipseRadiusCentre(IDENTITY), { x: 0, y: 0 }, 'an unplaced ellipse has its centre at the origin')

const translated = translateMatrix(50, 60)
close(ellipseRadiusHandlePoint(PARAMS, 'rx', translated), { x: 80, y: 60 }, 'translation moves the X handle')
close(ellipseRadiusHandlePoint(PARAMS, 'ry', translated), { x: 50, y: 80 }, 'translation moves the Y handle')
close(ellipseRadiusCentre(translated), { x: 50, y: 60 }, 'the placed centre is the translation')

const rotated = multiplyMatrix(translateMatrix(60, 40), rotateMatrix(Math.PI / 6))
const cos30 = Math.cos(Math.PI / 6)
const sin30 = Math.sin(Math.PI / 6)
close(
  ellipseRadiusHandlePoint(PARAMS, 'rx', rotated),
  { x: 60 + 30 * cos30, y: 40 + 30 * sin30 },
  'a rotated instance turns the X handle with it',
)
close(
  ellipseRadiusHandlePoint(PARAMS, 'ry', rotated),
  { x: 60 - 20 * sin30, y: 40 + 20 * cos30 },
  'a rotated instance turns the Y handle with it',
)

const quarterTurn = rotateMatrix(Math.PI / 2)
close(ellipseRadiusHandlePoint(PARAMS, 'rx', quarterTurn), { x: 0, y: 30 }, 'a quarter turn puts the X handle on +Y')

// A mirror across the vertical line x = 200: x' = 200 - x.
const mirrored: Matrix2D = { a: -1, b: 0, c: 0, d: 1, e: 200, f: 0 }
close(ellipseRadiusHandlePoint(PARAMS, 'rx', mirrored), { x: 170, y: 0 }, 'a mirror flips the X handle across the centre')
close(ellipseRadiusHandlePoint(PARAMS, 'ry', mirrored), { x: 200, y: 20 }, 'a mirror leaves the Y handle on its axis')

// A uniform scale (the instance transform carries it) scales the handles.
const scaled: Matrix2D = { a: 2, b: 0, c: 0, d: 2, e: 10, f: 10 }
close(ellipseRadiusHandlePoint(PARAMS, 'rx', scaled), { x: 70, y: 10 }, 'a scaled instance scales the X handle')
close(ellipseRadiusHandlePoint(PARAMS, 'ry', scaled), { x: 10, y: 50 }, 'a scaled instance scales the Y handle')

// ── 2. Drag mapping: one axis, centre fixed ────────────────────────────

const draggedX = dragEllipseRadius(PARAMS, 'rx', ellipseRadiusHandlePoint(PARAMS, 'rx', IDENTITY), IDENTITY)
assert.ok(draggedX, 'dragging a handle maps to parameters')
assert.equal(draggedX.rx, 30, 'dragging the X handle to its own place keeps rx')
assert.equal(draggedX.ry, 20, 'dragging the X handle never touches ry')

const widened = dragEllipseRadius(PARAMS, 'rx', { x: 45, y: 0 }, IDENTITY)
assert.ok(widened, 'a drag along the X axis maps to parameters')
assert.equal(widened.rx, 45, 'the X handle reads its own axis')
assert.equal(widened.ry, 20, 'the Y radius is untouched by an X drag')

// Axis lock: a point far off the axis contributes nothing to the X radius.
const offAxis = dragEllipseRadius(PARAMS, 'rx', { x: -12, y: 999 }, IDENTITY)
assert.ok(offAxis, 'an off-axis point still maps')
assert.equal(offAxis.rx, 12, 'only the local X of the point is read')
assert.equal(offAxis.ry, 20, 'the other radius stays')

const liftedY = dragEllipseRadius(PARAMS, 'ry', { x: 999, y: 35 }, IDENTITY)
assert.ok(liftedY, 'a Y drag maps')
assert.equal(liftedY.ry, 35, 'the Y handle reads the local Y')
assert.equal(liftedY.rx, 30, 'the X radius is untouched by a Y drag')

// On a rotated instance the same rule holds in the ellipse's own frame: moving
// the pointer along the placed Y axis changes nothing on the X handle.
const rotatedXHandle = ellipseRadiusHandlePoint(PARAMS, 'rx', rotated)
const alongPlacedY = {
  x: rotatedXHandle.x - 25 * sin30,
  y: rotatedXHandle.y + 25 * cos30,
}
assert.equal(
  ellipseRadiusFromWorldPoint('rx', alongPlacedY, rotated),
  30,
  'motion along the placed Y axis leaves the placed X radius alone',
)
const alongPlacedX = {
  x: rotatedXHandle.x + 15 * cos30,
  y: rotatedXHandle.y + 15 * sin30,
}
assert.ok(Math.abs(ellipseRadiusFromWorldPoint('rx', alongPlacedX, rotated) - 45) < 1e-9,
  'motion along the placed X axis drives the X radius')

const rotatedDrag = dragEllipseRadius(PARAMS, 'rx', alongPlacedX, rotated)
assert.ok(rotatedDrag, 'a rotated instance maps a drag')
assert.equal(rotatedDrag.ry, 20, 'the other radius stays put under rotation')
assert.ok(Math.abs(rotatedDrag.rx - 45) < 1e-9, 'the radius follows the pointer in world units')

// The centre is the placement's, so a drag can never move it.
close(ellipseRadiusCentre(rotated), { x: 60, y: 40 }, 'a rotated and translated centre is the placed origin')

// ── 3. Positive radii: clamp at the minimum, never invert ──────────────

for (const axis of ['rx', 'ry'] as const) {
  const clamped = dragEllipseRadius(PARAMS, axis, { x: 0, y: 0 }, IDENTITY)
  assert.ok(clamped, `a drag onto the centre still maps for ${axis}`)
  assert.equal(clamped[axis], ELLIPSE_RADIUS_MIN, `the ${axis} radius clamps at the minimum`)
  assert.ok(clamped[axis] > 0, `the ${axis} radius stays positive`)
}

const throughCentre = dragEllipseRadius(PARAMS, 'rx', { x: -40, y: 0 }, IDENTITY)
assert.ok(throughCentre, 'a drag past the centre still maps')
assert.equal(throughCentre.rx, 40, 'the radius is the distance from the centre, so the ellipse never inverts')

// ── 4. Same normalization as the Edit panel ───────────────────────────

assert.equal(
  dragEllipseRadius(PARAMS, 'rx', { x: Number.NaN, y: 0 }, IDENTITY),
  null,
  'a non-finite pointer maps to no parameters instead of a broken one',
)
assert.equal(
  dragEllipseRadius(PARAMS, 'rx', { x: Number.POSITIVE_INFINITY, y: 0 }, IDENTITY),
  null,
  'an infinite radius is refused, exactly as the panel refuses a non-number',
)
const edited = dragEllipseRadius(PARAMS, 'ry', { x: 0, y: 7.5 }, IDENTITY)
assert.ok(edited, 'a usable drag maps')
assert.deepEqual(normalizeEllipseCannedParams(edited), edited, 'the dragged parameters pass the generator validation')

console.log('✓ ellipse radius handles: placement, axis lock, clamp and normalization')
