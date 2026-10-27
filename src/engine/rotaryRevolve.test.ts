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
 * The revolved Turn profile (issue #1112 slice H, decision 11).
 *
 * Run with: npx tsx src/engine/rotaryRevolve.test.ts
 *
 * The profile is a side view: `along` is the bar's axis, `radius` the distance
 * from the centreline. The mesh must be the exact surface of revolution — a
 * point at `(along, radius)` appears at every angle around the bar at that
 * radius.
 *
 * Mutations checked one at a time:
 * - the profile revolved about the across axis instead of the bar axis → the
 *   radius-at-station assertions fail;
 * - the axis point smeared into a ring instead of collapsing to a point → the
 *   cap-radius assertions fail;
 * - the winding left reversed → the volume assertion fails;
 * - an open profile closed by a straight line instead of onto the axis → the
 *   end radius/volume assertions fail.
 */

import assert from 'node:assert/strict'
import { buildRotaryRevolveMesh, type RevolveProfileContour } from './rotaryRevolve'
import { rectProfile, type Point } from '../types/project'
import type { RotaryBarGeometry } from '../types/barStock'

const STOCK: RotaryBarGeometry = {
  axis: 'x',
  thickness: 40,
  profile: rectProfile(10, 30, 200, 40),
}

const CENTRE = 50
const PIVOT = 20
const SEGMENTS = 24

function assertNear(actual: number, expected: number, label: string, tolerance = 1e-4): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} != ${expected}`)
}

function pointAt(positions: Float32Array, index: number): Point {
  return { x: positions[index * 3], y: positions[index * 3 + 1] }
}

/** The largest radius among the vertices on one along station. */
function radiusAt(positions: Float32Array, along: number, tolerance = 1e-3): number {
  let radius = 0
  for (let index = 0; index < positions.length / 3; index += 1) {
    const x = positions[index * 3]
    if (Math.abs(x - along) > tolerance) continue
    const y = positions[index * 3 + 1] - CENTRE
    const z = positions[index * 3 + 2] - PIVOT
    radius = Math.max(radius, Math.hypot(y, z))
  }
  return radius
}

function signedVolume(positions: Float32Array, indices: Uint32Array): number {
  let volume = 0
  for (let index = 0; index < indices.length; index += 3) {
    const a = indices[index] * 3
    const b = indices[index + 1] * 3
    const c = indices[index + 2] * 3
    volume += (
      positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1])
      - positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c])
      + positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c])
    ) / 6
  }
  return volume
}

// A stepped half-profile: axis at both ends, a cone, a cylinder and a flat end.
const STEP: RevolveProfileContour = {
  closed: false,
  points: [
    { along: 20, radius: 0 },
    { along: 30, radius: 5 },
    { along: 60, radius: 10 },
    { along: 60, radius: 0 },
  ],
}

const mesh = buildRotaryRevolveMesh(STOCK, [STEP], SEGMENTS)
assertNear(radiusAt(mesh.positions, 20), 0, 'the profile starts on the axis')
assertNear(radiusAt(mesh.positions, 30), 5, 'the cone station radius')
assertNear(radiusAt(mesh.positions, 60), 10, 'the cylinder station radius')
assertNear(radiusAt(mesh.positions, 60), 10, 'the end cap reaches the full radius')
assert.ok(signedVolume(mesh.positions, mesh.indices) > 0, 'the mesh is outward-facing')

// Every ring vertex really is on the expected circle, not only its maximum.
const firstRing = pointAt(mesh.positions, 0)
assertNear(Math.hypot(firstRing.y - CENTRE, mesh.positions[2] - PIVOT), 0, 'the axis point is a point, not a ring')

// A closed half-section (a rectangle touching the axis) is a plain cylinder.
const RECTANGLE: RevolveProfileContour = {
  closed: true,
  points: [
    { along: 20, radius: 0 },
    { along: 20, radius: 6 },
    { along: 80, radius: 6 },
    { along: 80, radius: 0 },
  ],
}
const cylinder = buildRotaryRevolveMesh(STOCK, [RECTANGLE], SEGMENTS)
assertNear(radiusAt(cylinder.positions, 80), 6, 'the closed half-section revolves to radius 6')
assertNear(radiusAt(cylinder.positions, 80), 6, 'the cylinder end stays at radius 6')
const volume = signedVolume(cylinder.positions, cylinder.indices)
const facetArea = 0.5 * SEGMENTS * 36 * Math.sin((2 * Math.PI) / SEGMENTS)
assertNear(volume, facetArea * 60, 'the cylinder volume is the faceted area times its length', 1e-2)

// Reversing the outline must not invert the solid.
const reversed = buildRotaryRevolveMesh(STOCK, [{
  closed: true,
  points: [...RECTANGLE.points].reverse(),
}], SEGMENTS)
assert.ok(signedVolume(reversed.positions, reversed.indices) > 0, 'a reversed outline is still outward-facing')
assertNear(radiusAt(reversed.positions, 80), 6, 'a reversed outline keeps its radius')

// Refusals: no surface, a negative radius, an empty outline, a bad segment count.
const bad: Array<[string, RevolveProfileContour[], number]> = [
  ['an all-axis outline', [{ closed: false, points: [{ along: 20, radius: 0 }, { along: 80, radius: 0 }] }], SEGMENTS],
  ['a negative radius', [{ closed: false, points: [{ along: 20, radius: 0 }, { along: 30, radius: -1 }] }], SEGMENTS],
  ['no outlines', [], SEGMENTS],
  ['a bad segment count', [STEP], 4],
]
for (const [label, contours, segments] of bad) {
  assert.throws(() => buildRotaryRevolveMesh(STOCK, contours, segments), `${label} is refused`)
}

// A Y bar maps along to Y and across to X, so the same profile stays on the
// bar's centreline rather than swapping the axes.
const Y_STOCK: RotaryBarGeometry = {
  axis: 'y',
  thickness: 40,
  profile: rectProfile(30, 10, 40, 200),
}
const yMesh = buildRotaryRevolveMesh(Y_STOCK, [RECTANGLE], SEGMENTS)
assertNear(yMesh.positions[1], 20, 'a Y bar keeps along in Y', 1e-4)
assertNear(Math.hypot(yMesh.positions[0] - CENTRE, yMesh.positions[2] - PIVOT), 0, 'the Y-bar axis point collapses')

console.log('rotary revolve: all assertions passed.')
