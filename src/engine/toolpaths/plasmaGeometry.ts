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

import type { Point } from '../../types/project'
import { DEFAULT_CLIPPER_SCALE } from './geometry'

const EPS = 2 / DEFAULT_CLIPPER_SCALE
export function pointDistance(a: Point, b: Point): number { return Math.hypot(a.x - b.x, a.y - b.y) }
export function projectOnSegment(p: Point, a: Point, b: Point): Point {
  const dx = b.x - a.x, dy = b.y - a.y
  const d = dx * dx + dy * dy
  const t = d > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / d)) : 0
  return { x: a.x + t * dx, y: a.y + t * dy }
}
export function distanceToContour(p: Point, ring: Point[]): number {
  return Math.min(...ring.map((a, i) => pointDistance(p, projectOnSegment(p, a, ring[(i + 1) % ring.length]))))
}
export function insideContour(p: Point, ring: Point[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j]
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}
const cross = (a: Point, b: Point, p: Point): number => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b)
  if (abC * abD < 0 && cdA * cdB < 0) return true
  return [pointDistance(a, projectOnSegment(a, c, d)), pointDistance(b, projectOnSegment(b, c, d)), pointDistance(c, projectOnSegment(c, a, b)), pointDistance(d, projectOnSegment(d, a, b))].some((v) => v < 1e-9)
}
/** Exact segment/edge distance gate: a thin neighbour between samples cannot disappear. */
export function pathClearOfContour(path: Point[], ring: Point[], radius: number): boolean {
  for (let i = 0; i + 1 < path.length; i += 1) {
    const a = path[i], b = path[i + 1]
    for (let j = 0; j < ring.length; j += 1) {
      const c = ring[j], d = ring[(j + 1) % ring.length]
      if (segmentsIntersect(a, b, c, d)) return false
      const distance = Math.min(pointDistance(a, projectOnSegment(a, c, d)), pointDistance(b, projectOnSegment(b, c, d)), pointDistance(c, projectOnSegment(c, a, b)), pointDistance(d, projectOnSegment(d, a, b)))
      if (distance < radius - EPS) return false
    }
  }
  return true
}
export function pathOnScrap(path: Point[], ring: Point[], inside: boolean, radius: number): boolean {
  return path.length >= 2 && path.every((p) => insideContour(p, ring) === inside)
    && pathClearOfContour(path, ring, radius)
}

export interface PlasmaArrival { ring: Point[]; tangent: Point; normal: Point }
/** Prefer the longest straight run; a requested point projects to its nearest segment. */
export function plasmaArrivals(ring: Point[], requested?: Point): PlasmaArrival[] {
  const candidates = ring.map((a, i) => {
    const b = ring[(i + 1) % ring.length], length = pointDistance(a, b)
    const start = requested ? projectOnSegment(requested, a, b) : { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    const tangent = { x: (b.x - a.x) / length, y: (b.y - a.y) / length }
    return { length, distance: requested ? pointDistance(start, requested) : 0, ring: [start, ...ring.slice(i + 1), ...ring.slice(0, i + 1), start], tangent }
  }).filter((v) => v.length > EPS)
  candidates.sort((a, b) => requested ? a.distance - b.distance : b.length - a.length)
  // The same left/right convention works in project coordinates without naming CW.
  const area = ring.reduce((sum, a, i) => { const b = ring[(i + 1) % ring.length]; return sum + a.x * b.y - b.x * a.y }, 0)
  return candidates.map(({ ring, tangent }) => ({ ring, tangent, normal: area > 0 ? { x: tangent.y, y: -tangent.x } : { x: -tangent.y, y: tangent.x } }))
}
