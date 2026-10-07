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

import type { Matrix2D, Point, SketchProfile } from '../../types/project'
import { applyMatrixToPoint } from '../../store/helpers/resolveFeatures'
import { invertMatrix } from '../../store/helpers/instanceTransforms'
import { flattenProfile } from './geometry'

export function validPlasmaStartPoint(point: Point): boolean {
  return !!point && Number.isFinite(point.x) && Number.isFinite(point.y)
}
/** Store the picked contour point in the owning instance's definition space. */
export function localPlasmaStartPoint(transform: Matrix2D, point: Point): Point | null {
  const determinant = transform.a * transform.d - transform.b * transform.c
  if (!validPlasmaStartPoint(point) || !Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return null
  const local = applyMatrixToPoint(invertMatrix(transform), point)
  return validPlasmaStartPoint(local) ? local : null
}
/** Resolve attachment, projecting onto the current contour after geometry edits. */
export function plasmaStartPointForContour(profile: SketchProfile, transform: Matrix2D, local: Point): Point | null {
  if (!profile.closed || !validPlasmaStartPoint(local) || !localPlasmaStartPoint(transform, local)) return null
  const desired = applyMatrixToPoint(transform, local)
  const ring = flattenProfile(profile).points
  if (ring.length < 3 || !ring.every(validPlasmaStartPoint)) return null
  let best: Point | null = null, distance = Infinity
  for (let index = 0; index < ring.length; index++) {
    const a = ring[index], b = ring[(index + 1) % ring.length]
    const dx = b.x - a.x, dy = b.y - a.y, lengthSquared = dx * dx + dy * dy
    const t = lengthSquared ? Math.max(0, Math.min(1, ((desired.x - a.x) * dx + (desired.y - a.y) * dy) / lengthSquared)) : 0
    const candidate = { x: a.x + t * dx, y: a.y + t * dy }
    const candidateDistance = Math.hypot(desired.x - candidate.x, desired.y - candidate.y)
    if (candidateDistance < distance) { best = candidate; distance = candidateDistance }
  }
  return best
}
