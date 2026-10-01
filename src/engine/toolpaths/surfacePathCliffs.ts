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

import type { ToolpathPoint } from './types'

/**
 * Keep a surface-following pass from cutting across a cliff (issue #938).
 *
 * A finish pass that follows the surface is a polyline whose vertices sit on
 * the cutter-location surface, sampled every so often. Each vertex is right;
 * the straight move between two of them is not when they straddle a cliff.
 * Partway across, the cutter is still beside a face it has not yet passed and
 * already below its top, and it takes the corner off. On a guitar top that
 * was a 0.6" drop into a cavity over one 0.062" sample, cutting 0.2" into the
 * cavity's edge.
 *
 * A segment is examined only when its ends differ in height by more than a
 * quarter cell. The cutter-location surface spreads every feature over the
 * cutter's width, wider than any pass samples, so a feature between two
 * vertices raises at least one of them; a level segment cannot hide one.
 *
 * An examined segment is checked against `requiredZ` every half cell. Where
 * the straight line runs more than a quarter cell below it, the worst point
 * is lifted onto the surface and both halves are examined again, down to a
 * quarter-cell length. Anything smaller is the height map's own resolution,
 * which places a wall to within a cell, so a smooth surface is left exactly
 * as it was: a tighter bound split ordinary curvature into extra moves for
 * nothing the map can resolve.
 *
 * `requiredZ` is the strategy's own Z for a vertex at that point, with every
 * clamp it applies, so a vertex added here is one the strategy would itself
 * have placed. A non-finite value means nothing constrains the point.
 */
export function refineSurfacePathAtCliffs(
  points: ToolpathPoint[],
  requiredZ: (x: number, y: number) => number,
  cellSize: number,
  closed = false,
): ToolpathPoint[] {
  if (points.length < 2 || !(cellSize > 0)) return points
  const tolerance = Math.max(1e-6, cellSize / 4)
  const sampleSpacing = cellSize / 2
  const minimumLength = cellSize / 4
  const out: ToolpathPoint[] = [points[0]]
  let changed = false

  const required = (x: number, y: number): number => {
    const z = requiredZ(x, y)
    return Number.isFinite(z) ? z : Number.NEGATIVE_INFINITY
  }

  /** The point along a to b the line runs furthest under, or null if it never does. */
  const worstViolation = (a: ToolpathPoint, b: ToolpathPoint): { t: number; z: number } | null => {
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    const steps = Math.max(2, Math.ceil(length / sampleSpacing))
    let worst: { t: number; z: number; under: number } | null = null
    for (let i = 1; i < steps; i += 1) {
      const t = i / steps
      const z = required(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)
      const under = z - (a.z + (b.z - a.z) * t)
      if (under > tolerance && (worst === null || under > worst.under)) worst = { t, z, under }
    }
    return worst
  }

  const refine = (a: ToolpathPoint, b: ToolpathPoint, depth: number): void => {
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    if (Math.abs(b.z - a.z) <= tolerance) {
      out.push(b)
      return
    }
    const violation = worstViolation(a, b)
    // Shorter than a quarter cell, what is left is within the height map's
    // own resolution, which places a wall to within a cell.
    if (violation === null || length <= minimumLength || depth >= 32) {
      out.push(b)
      return
    }
    changed = true
    const lifted: ToolpathPoint = {
      x: a.x + (b.x - a.x) * violation.t,
      y: a.y + (b.y - a.y) * violation.t,
      z: violation.z,
    }
    refine(a, lifted, depth + 1)
    refine(lifted, b, depth + 1)
  }

  const count = closed ? points.length : points.length - 1
  for (let i = 0; i < count; i += 1) {
    refine(points[i], points[(i + 1) % points.length], 0)
  }
  if (!changed) return points
  // A closed ring came back to its first vertex; keep the ring's own shape.
  if (closed) out.pop()
  return out
}
