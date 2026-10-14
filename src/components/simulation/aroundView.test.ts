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
 * The bar view's readout (issue #395): the tool as the program has it.
 *
 * X, Y and Z are the *wrapped* point in the real project origin — the same
 * sign rule the flat readout uses — so on an X bar Y reads the centreline and
 * stays constant while the bar turns, and Z is the real height one radius
 * above the sheet. A is the program's angle, never reduced to one turn.
 *
 * Mutations these assertions were checked against:
 * - reading the sheet pose instead of the wrapped one → Y stops reading the
 *   centreline and Z loses the radius;
 * - dropping the `a` passthrough → A disappears from the readout.
 *
 * Run with: npx tsx src/components/simulation/aroundView.test.ts
 */

import assert from 'node:assert/strict'
import { wrapPoint, type AroundFrame } from '../../engine/aroundFrame'
import { barReadout, simulationBarAngle } from './aroundView'

function approx(a: number, b: number, epsilon = 1e-9): boolean {
  return Math.abs(a - b) < epsilon
}

for (const axis of ['x', 'y'] as const) {
  const frame: AroundFrame = { axis, centre: 17, radius: 10, zero: 13, sheetStart: -7, circumference: 40 }
  const origin = { x: 5, y: 6, z: 7 }
  // A folded pose on the first circumference: across offset 3 is −153° from the
  // zero line at 13, and the program's unreduced angle is that plus a full turn.
  const pose = axis === 'x'
    ? { x: 23, y: frame.sheetStart + 3, z: 4, a: 387 }
    : { x: frame.sheetStart + 3, y: 23, z: 4, a: 387 }
  const wrapped = wrapPoint(pose, frame)
  const readout = barReadout(pose, frame, origin)

  assert(approx(readout.x, wrapped.x - origin.x), `${axis}: X is the wrapped point in the project origin`)
  assert(approx(readout.y, origin.y - wrapped.y), `${axis}: Y is the wrapped point with the flat readout's inverted sign`)
  assert(approx(readout.z, wrapped.z - origin.z), `${axis}: Z is the wrapped point in the project origin`)
  assert.equal(readout.a, pose.a, `${axis}: A is the program's angle, unreduced`)

  // The wrapped point is what makes the bar readout different: the sheet pose
  // would keep the across coordinate instead of the centreline.
  if (axis === 'x') {
    assert(approx(readout.y, origin.y - frame.centre), 'Y reads the centreline')
    assert(!approx(readout.y, origin.y - pose.y), 'and not the sheet across coordinate')
  } else {
    assert(approx(readout.x, frame.centre - origin.x), 'X reads the centreline')
    assert(!approx(readout.x, pose.x - origin.x), 'and not the sheet across coordinate')
  }
  assert(approx(readout.z, pose.z + frame.radius - origin.z), `${axis}: Z is the real height, one radius above the sheet`)

  // The bar turns to the program's angle when present; the across coordinate
  // is only the fallback, and names the same angle modulo one turn.
  assert.equal(simulationBarAngle(pose, frame), pose.a, `${axis}: the bar turns to the program angle`)
  assert(approx(simulationBarAngle({ x: pose.x, y: pose.y }, frame), -153), `${axis}: a pose with no angle falls back to the across coordinate`)

  // No angle on the pose means no A key on the readout.
  assert(!('a' in barReadout({ x: pose.x, y: pose.y, z: pose.z }, frame, origin)), `${axis}: no angle gives a readout with no a key`)
}

// An X bar's Y is the centreline, constant no matter where the tool is along
// or across the bar.
{
  const frame: AroundFrame = { axis: 'x', centre: 17, radius: 10, zero: 13, sheetStart: -7, circumference: 40 }
  const origin = { x: 5, y: 6, z: 7 }
  assert.equal(barReadout({ x: 10, y: -7, z: 2, a: 0 }, frame, origin).y, origin.y - frame.centre, 'Y reads the centreline')
  assert.equal(barReadout({ x: 40, y: 33, z: 9, a: 360 }, frame, origin).y, origin.y - frame.centre, 'Y stays on the centreline while the bar turns')
}

console.log('aroundView tests passed')
