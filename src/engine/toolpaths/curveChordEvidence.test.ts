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

// `offsetPathsWithCurves` hooks private ClipperOffset internals. Its guards
// skip the hooks silently, so a clipper-lib change would drop every offset
// chord's evidence and quietly turn offset arcs back into G1 moves. These
// checks fail loudly instead (#1253 review).

import assert from 'node:assert/strict'
import ClipperLib from 'clipper-lib'
import { circleProfile, rectProfile } from '../../types/project'
import type { Point } from '../../types/project'
import { curveChordError, offsetPathsWithCurves } from './curveChordEvidence'
import { DEFAULT_CLIPPER_SCALE, flattenProfile, fromClipperPath, toClipperPath } from './geometry'

const prototype = ClipperLib.ClipperOffset.prototype as unknown as Record<string, unknown>
for (const method of ['OffsetPoint', 'DoRound']) {
  assert.equal(typeof prototype[method], 'function', `ClipperOffset.${method} is gone; update offsetPathsWithCurves`)
}
const instance = new ClipperLib.ClipperOffset() as unknown as Record<string, unknown>
for (const field of ['m_srcPoly', 'm_destPoly', 'm_normals']) {
  assert(Array.isArray(instance[field]), `ClipperOffset.${field} is gone; update offsetPathsWithCurves`)
}
assert.equal(typeof instance.m_delta, 'number', 'ClipperOffset.m_delta is gone; update offsetPathsWithCurves')

function evidenced(points: Point[]): Array<{ from: Point; to: Point; error: number }> {
  const chords = []
  for (let i = 0; i < points.length; i++) {
    const from = points[i], to = points[(i + 1) % points.length]
    const error = curveChordError(from, to)
    if (error !== undefined) chords.push({ from, to, error })
  }
  return chords
}

function offset(points: Point[], delta: number, joinType: number): Point[] {
  const paths = offsetPathsWithCurves([toClipperPath(points)], delta * DEFAULT_CLIPPER_SCALE, joinType,
    0.01 * DEFAULT_CLIPPER_SCALE)
  assert.equal(paths.length, 1)
  return fromClipperPath(paths[0])
}

// DoRound: an outward round offset of a square records its four corner joins.
const square = flattenProfile(rectProfile(0, 0, 40, 40)).points
assert.equal(evidenced(square).length, 0, 'an authored square has no curve evidence')
const rounded = offset(square, 3, ClipperLib.JoinType.jtRound)
const joins = evidenced(rounded)
assert(joins.length >= 8, `round joins must carry evidence (got ${joins.length} chords)`)
for (const { from, to } of joins) {
  const inside = (p: Point): boolean => p.x > 0 && p.x < 40 && p.y > 0 && p.y < 40
  assert(!inside(from) && !inside(to), 'join chords lie outside the square')
}
const straightSides = rounded.length - joins.length
assert(straightSides >= 4, 'the shifted straight sides must stay unevidenced')

// OffsetPoint: an inward offset of a sampled circle keeps its source chords.
const circle = flattenProfile(circleProfile(0, 0, 20)).points
assert.equal(evidenced(circle).length, circle.length)
for (const joinType of [ClipperLib.JoinType.jtRound, ClipperLib.JoinType.jtMiter]) {
  const inner = offset(circle, -2, joinType)
  const chords = evidenced(inner)
  assert(chords.length >= inner.length * 0.9,
    `shifted circle chords must carry evidence (${chords.length} of ${inner.length}, join ${joinType})`)
}

console.log('Offset hooks record round joins and shifted curve chords: PASSED')
