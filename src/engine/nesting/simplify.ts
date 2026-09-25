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
// Ramer–Douglas–Peucker simplification for nesting footprints. Every dropped
// vertex lies within `tolerance` of the kept chord, so the simplified ring's
// boundary stays within `tolerance` of the original — which is what lets
// `expandByHalfGap` grow first and simplify after without losing clearance.

import type { Point } from '../../types/project'
import type { NestRing } from './types'

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSq = dx * dx + dy * dy
  if (lengthSq === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq))
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)
}

/** Simplifies an open polyline, keeping both ends. Iterative, so long chains cannot overflow the stack. */
function simplifyChain(points: Point[], tolerance: number): Point[] {
  if (points.length < 3) return points
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack: [number, number][] = [[0, points.length - 1]]
  while (stack.length > 0) {
    const [first, last] = stack.pop()!
    let farthest = -1
    let farthestDistance = tolerance
    for (let index = first + 1; index < last; index += 1) {
      const distance = distanceToSegment(points[index], points[first], points[last])
      if (distance > farthestDistance) {
        farthest = index
        farthestDistance = distance
      }
    }
    if (farthest < 0) continue
    keep[farthest] = 1
    stack.push([first, farthest], [farthest, last])
  }
  return points.filter((_, index) => keep[index] === 1)
}

/**
 * Simplifies a closed ring within `tolerance`. The ring is split at its first
 * vertex and the vertex farthest from it, so both halves are proper chains.
 */
export function simplifyRing(ring: NestRing, tolerance: number): NestRing {
  if (!(tolerance > 0) || ring.length < 4) return ring
  let far = 0
  let farDistance = -1
  for (let index = 1; index < ring.length; index += 1) {
    const distance = Math.hypot(ring[index].x - ring[0].x, ring[index].y - ring[0].y)
    if (distance > farDistance) {
      far = index
      farDistance = distance
    }
  }
  const firstHalf = simplifyChain(ring.slice(0, far + 1), tolerance)
  const secondHalf = simplifyChain([...ring.slice(far), ring[0]], tolerance)
  const simplified = [...firstHalf.slice(0, -1), ...secondHalf.slice(0, -1)]
  return simplified.length >= 3 ? simplified : ring
}
