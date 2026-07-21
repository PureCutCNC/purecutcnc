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

// Corner smoothing for offset clearing rings (pocket + surface).
//
// The concentric clearing rings a pocket/surface offset pass emits come from
// *inset* (negative) Clipper offsets. Clipper's round join only arcs the
// corners that open a gap on an inset — the reflex ones — so the sharp corners
// users actually see on a clearing ring (e.g. the four 90° corners of a
// rectangular pocket's rings) are the *convex* corners of the inset and stay
// pointed regardless of join type. Rounding them therefore has to be an
// explicit fillet on the emitted polyline, which is what this module does.
//
// `roundContourCorners` replaces each sharp turn on a closed contour with a
// tangent circular-arc fillet, tessellated to line segments (the toolpath move
// model is polyline-only). The radius is clamped per corner to a fraction of
// the shorter adjacent edge, so fillets on neighbouring corners never overlap
// and short edges just get a smaller (or no) fillet. It is a pure emit-time
// transform on the ring the tool follows: callers keep computing successive
// insets from the exact, unsmoothed region so nothing drifts, and the
// wall-defining passes are never routed through here.

import type { Point } from '../../types/project'
import { DEFAULT_FLATTEN_ARC_STEP } from './geometry'

export interface RoundContourOptions {
  /** Only round turns whose deflection (0 = straight, 180 = full reversal)
   *  exceeds this. Gentle turns are left as-is. */
  minDeflectionDeg?: number
  /** Angular tessellation step for the fillet arcs, in radians. */
  arcStepRadians?: number
  /** Largest share of each adjacent edge a corner's fillet may consume. At the
   *  0.5 default a fillet uses at most half of each edge, so the fillets at the
   *  two ends of a shared edge can never overlap. */
  maxEdgeFraction?: number
}

const DEFAULT_MIN_DEFLECTION_DEG = 20
const DEFAULT_MAX_EDGE_FRACTION = 0.5
const EPS = 1e-9

/**
 * Derived fillet radius for clearing-ring corner smoothing: the smaller of the
 * tool radius and the stepover. Returns undefined when smoothing is disabled or
 * the inputs are degenerate, so callers can pass the result straight through as
 * the optional `smoothRadius` (undefined = today's exact, unsmoothed output).
 *
 * The bound keeps convex-corner leftovers within the finish-stock envelope and
 * keeps concave-corner bulges inside the band the ring already sweeps, so a
 * smoothed clearing ring never gouges a wall or island the finish pass owns.
 */
export function cornerSmoothingRadius(
  enabled: boolean | undefined,
  toolRadius: number,
  stepover: number,
): number | undefined {
  if (!enabled) return undefined
  const radius = Math.min(toolRadius, stepover)
  return radius > 0 ? radius : undefined
}

function normalizeSignedAngle(angle: number): number {
  let value = angle
  while (value > Math.PI) value -= 2 * Math.PI
  while (value <= -Math.PI) value += 2 * Math.PI
  return value
}

/**
 * Round the sharp corners of a closed contour with tangent-arc fillets.
 *
 * `points` is a closed ring given as distinct vertices with no duplicated
 * closing point (the shape `buildContourLoops` produces). A non-positive
 * `radius`, a degenerate ring (< 3 points), or a corner too shallow to matter
 * returns the input vertices unchanged, so passing no radius is a no-op.
 */
export function roundContourCorners(
  points: Point[],
  radius: number,
  options: RoundContourOptions = {},
): Point[] {
  if (!(radius > 0) || points.length < 3) {
    return points
  }

  // Work on a clean cyclic ring: drop a duplicated closing vertex if present so
  // the seam corner is rounded like any other (Clipper output has none, but
  // contours from other sources may).
  const first = points[0]
  const last = points[points.length - 1]
  const ring = Math.abs(first.x - last.x) <= EPS && Math.abs(first.y - last.y) <= EPS
    ? points.slice(0, -1)
    : points
  if (ring.length < 3) {
    return points
  }

  const minDeflection = ((options.minDeflectionDeg ?? DEFAULT_MIN_DEFLECTION_DEG) * Math.PI) / 180
  const arcStep = Math.max(options.arcStepRadians ?? DEFAULT_FLATTEN_ARC_STEP, 1e-3)
  const maxEdgeFraction = options.maxEdgeFraction ?? DEFAULT_MAX_EDGE_FRACTION
  const count = ring.length
  const out: Point[] = []

  for (let index = 0; index < count; index += 1) {
    const current = ring[index]
    const previous = ring[(index + count - 1) % count]
    const next = ring[(index + 1) % count]

    // Unit vectors along the two edges, pointing away from the corner.
    const toPrev = { x: previous.x - current.x, y: previous.y - current.y }
    const toNext = { x: next.x - current.x, y: next.y - current.y }
    const prevLen = Math.hypot(toPrev.x, toPrev.y)
    const nextLen = Math.hypot(toNext.x, toNext.y)
    if (prevLen <= EPS || nextLen <= EPS) {
      out.push(current)
      continue
    }

    const uPrev = { x: toPrev.x / prevLen, y: toPrev.y / prevLen }
    const uNext = { x: toNext.x / nextLen, y: toNext.y / nextLen }

    // Interior angle between the edges, and the deflection (turn) angle.
    const cosInterior = Math.max(-1, Math.min(1, uPrev.x * uNext.x + uPrev.y * uNext.y))
    const interior = Math.acos(cosInterior)
    const deflection = Math.PI - interior
    if (deflection < minDeflection) {
      out.push(current)
      continue
    }

    const halfAngle = interior / 2
    const tanHalf = Math.tan(halfAngle)
    if (!(tanHalf > EPS)) {
      out.push(current)
      continue
    }

    // Tangent length for the requested radius, clamped two ways:
    //  - to a share of each adjacent edge, so neighbouring fillets never
    //    overlap, and
    //  - to the radius itself, which bounds how far the fillet retreats from a
    //    corner. A rounded rough ring always leaves a little stock at a corner
    //    (the exact finish pass removes it — walls are never smoothed); this cap
    //    keeps that stock within ~radius (<= tool radius) of the apex so the
    //    finish pass can reach it. Without it an acute corner (small tan(half))
    //    would pull the path far back, leaving a crescent too deep for the
    //    finish pass to clean. 90 deg and blunter corners are unaffected (their
    //    tangent is already <= radius).
    const desiredTangent = radius / tanHalf
    const maxTangent = Math.min(maxEdgeFraction * Math.min(prevLen, nextLen), radius)
    const tangent = Math.min(desiredTangent, maxTangent)
    const effectiveRadius = tangent * tanHalf
    if (!(effectiveRadius > EPS) || tangent <= EPS) {
      out.push(current)
      continue
    }

    const entry = { x: current.x + uPrev.x * tangent, y: current.y + uPrev.y * tangent }
    const exit = { x: current.x + uNext.x * tangent, y: current.y + uNext.y * tangent }

    // Arc centre sits on the interior bisector, radius/sin(halfAngle) from the
    // corner. The fillet's central angle equals the deflection angle.
    const sinHalf = Math.sin(halfAngle)
    let bisector = { x: uPrev.x + uNext.x, y: uPrev.y + uNext.y }
    const bisectorLen = Math.hypot(bisector.x, bisector.y)
    if (bisectorLen <= EPS || sinHalf <= EPS) {
      // Nearly straight-through spike; skip rather than divide by ~0.
      out.push(current)
      continue
    }
    bisector = { x: bisector.x / bisectorLen, y: bisector.y / bisectorLen }
    const centreDistance = effectiveRadius / sinHalf
    const centre = {
      x: current.x + bisector.x * centreDistance,
      y: current.y + bisector.y * centreDistance,
    }

    const startAngle = Math.atan2(entry.y - centre.y, entry.x - centre.x)
    const endAngle = Math.atan2(exit.y - centre.y, exit.x - centre.x)
    const sweep = normalizeSignedAngle(endAngle - startAngle)
    const steps = Math.max(1, Math.ceil(Math.abs(sweep) / arcStep))

    out.push(entry)
    for (let step = 1; step < steps; step += 1) {
      const angle = startAngle + (sweep * step) / steps
      out.push({
        x: centre.x + effectiveRadius * Math.cos(angle),
        y: centre.y + effectiveRadius * Math.sin(angle),
      })
    }
    out.push(exit)
  }

  return out
}
