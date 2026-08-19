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

// Full-radius corner arcs across tessellated source geometry (issue #546).
//
// A corner reached through a chain of short tessellation edges has nothing to
// set back into: each edge is a fraction of the requested radius, so a fillet
// built from the two edges adjacent to the apex comes out at a few percent of
// the request. The fix is not to read the shoulder direction from further out
// and fit an arc to those two extended lines — the approach curves, so the
// lines leave the polyline and the arc meets the path at a kink on each side.
//
// Instead, roll a circle of the requested radius into the corner until it
// jams. It ends up tangent to one real source edge before the corner and one
// real source edge after it, so both junctions are tangent-continuous by
// construction, and the source vertices between the two tangent points are cut
// away. That leaves a tip of material, which is the caller's problem: this
// module reports the span it cut so the caller can clean it.
//
// The jam is found by solving, for a pair of edges, the centre that sits at
// exactly the requested radius inside both, then rejecting the solution unless
// both tangent points land inside their own segments, the sweep matches the
// source path's own accumulated turn, and no part of the ring pokes inside the
// circle. In practice that leaves exactly one candidate per corner; where the
// ring is narrower than two radii — the innermost slivers of a pocket — it
// leaves none, and the corner keeps whatever geometry it already had.

import type { Point } from '../../types/project'

const EPS = 1e-9
/** Fraction of the radius a tangent point may sit outside its own segment. */
const CONTAINMENT_TOL = 1e-9
/** Allowed mismatch between the arc sweep and the source path's own turn. */
const SWEEP_TOL = 1e-6
/** How far either side of the corner an edge may be picked, in radii. */
const DEFAULT_REACH_RADII = 6

export interface BroadCornerArcRequest {
  /** Closed source ring: distinct vertices, no duplicated closing point. */
  points: Point[]
  /** First source index of the corner being replaced. */
  apexFirst: number
  /** Last source index of the corner being replaced (cyclic; may wrap). */
  apexLast: number
  /** Sign of the corner's signed turn: +1 counterclockwise, -1 clockwise. */
  turnSign: number
  /** The radius to emit. The arc is emitted at exactly this or not at all. */
  radius: number
  /** Arc-length window either side of the corner. Default 6 radii. */
  reach?: number
}

export interface BroadCornerArc {
  /** Source edge (points[entryEdge] -> points[entryEdge + 1]) the arc leaves. */
  entryEdge: number
  /** Source edge (points[exitEdge] -> points[exitEdge + 1]) the arc rejoins. */
  exitEdge: number
  /** Tangent point on `entryEdge`. */
  entry: Point
  /** Tangent point on `exitEdge`. */
  exit: Point
  centre: Point
  radius: number
  /** Signed sweep from entry to exit, radians, sign matching `turnSign`. */
  sweep: number
  /** Number of source edges between the two tangent edges, inclusive. */
  span: number
}

interface Edge {
  from: Point
  to: Point
  ux: number
  uy: number
  length: number
}

function normalizeSignedAngle(angle: number): number {
  let value = angle
  while (value > Math.PI) value -= 2 * Math.PI
  while (value <= -Math.PI) value += 2 * Math.PI
  return value
}

function pointSegmentDistance(px: number, py: number, edge: Edge): number {
  const dx = edge.to.x - edge.from.x
  const dy = edge.to.y - edge.from.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared <= EPS * EPS) return Math.hypot(px - edge.from.x, py - edge.from.y)
  const t = Math.max(0, Math.min(1,
    ((px - edge.from.x) * dx + (py - edge.from.y) * dy) / lengthSquared))
  return Math.hypot(px - (edge.from.x + dx * t), py - (edge.from.y + dy * t))
}

/**
 * Find the full-radius arc that cuts the corner at `apexFirst..apexLast`.
 *
 * Returns null whenever no circle of exactly `radius` jams into the corner
 * against two real source edges — a ring narrower than two radii is the common
 * case — so the caller keeps its existing geometry rather than emitting
 * something narrower than asked for.
 */
export function findBroadCornerArc(request: BroadCornerArcRequest): BroadCornerArc | null {
  const { points, apexFirst, apexLast, turnSign, radius } = request
  const count = points.length
  if (count < 3 || !(radius > 0) || !Number.isFinite(radius)) return null
  if (turnSign !== 1 && turnSign !== -1) return null
  if (apexFirst < 0 || apexFirst >= count || apexLast < 0 || apexLast >= count) return null

  const edges: Edge[] = points.map((from, index) => {
    const to = points[(index + 1) % count]
    const length = Math.hypot(to.x - from.x, to.y - from.y)
    return { from, to, ux: length > EPS ? (to.x - from.x) / length : 0, uy: length > EPS ? (to.y - from.y) / length : 0, length }
  })
  if (edges.some((edge) => !(edge.length > EPS))) return null

  const reach = request.reach ?? DEFAULT_REACH_RADII * radius
  const apexSpan = ((apexLast - apexFirst) + count) % count

  // Walk out from the corner by arc length, never by vertex count: on a
  // tessellated approach a fixed number of vertices is a fixed number of
  // nothing, and on a coarse one it walks past the neighbouring corner.
  const walk = (start: number, step: -1 | 1): number[] => {
    const indices: number[] = []
    let travelled = 0
    for (let offset = 0; offset < count - apexSpan - 1; offset += 1) {
      const index = ((start + step * offset) % count + count) % count
      indices.push(index)
      travelled += edges[index].length
      if (travelled > reach) break
    }
    return indices
  }
  const entryEdges = walk(((apexFirst - 1) % count + count) % count, -1)
  const exitEdges = walk(apexLast % count, 1)

  const candidates: BroadCornerArc[] = []
  for (const entryEdge of entryEdges) {
    const first = edges[entryEdge]
    // Inward normal: the side the corner turns toward, so the centre of the
    // arc that cuts this corner lies at +radius along it from both edges.
    const nix = -turnSign * first.uy
    const niy = turnSign * first.ux
    for (const exitEdge of exitEdges) {
      const second = edges[exitEdge]
      const njx = -turnSign * second.uy
      const njy = turnSign * second.ux
      const determinant = nix * njy - niy * njx
      if (Math.abs(determinant) <= EPS) continue
      const c1 = radius + first.from.x * nix + first.from.y * niy
      const c2 = radius + second.from.x * njx + second.from.y * njy
      const centre = {
        x: (c1 * njy - c2 * niy) / determinant,
        y: (nix * c2 - njx * c1) / determinant,
      }
      if (!Number.isFinite(centre.x) || !Number.isFinite(centre.y)) continue
      const entry = { x: centre.x - radius * nix, y: centre.y - radius * niy }
      const exit = { x: centre.x - radius * njx, y: centre.y - radius * njy }
      // Both tangent points have to sit on the segments themselves. This is
      // what declines a ring narrower than two radii: the offset lines still
      // cross, but they cross off the end of the edges.
      const entryT = ((entry.x - first.from.x) * first.ux + (entry.y - first.from.y) * first.uy) / first.length
      const exitT = ((exit.x - second.from.x) * second.ux + (exit.y - second.from.y) * second.uy) / second.length
      if (entryT < -CONTAINMENT_TOL || entryT > 1 + CONTAINMENT_TOL) continue
      if (exitT < -CONTAINMENT_TOL || exitT > 1 + CONTAINMENT_TOL) continue
      const span = ((exitEdge - entryEdge) + count) % count
      if (span < 1 || span > count - 2) continue
      // The corner being replaced must lie inside the span, or the circle has
      // jammed into some neighbouring corner instead of this one.
      if (((apexFirst - entryEdge) + count) % count > span) continue
      if (((apexLast - entryEdge) + count) % count > span) continue
      candidates.push({ entryEdge, exitEdge, entry, exit, centre, radius, sweep: 0, span })
    }
  }
  if (candidates.length === 0) return null

  // Prefer the shallowest jam — the arc that cuts away the fewest source
  // vertices leaves the least material behind. Ties break on coordinates so
  // the choice travels with the geometry rather than with the seam.
  candidates.sort((a, b) =>
    a.span - b.span
    || a.entry.x - b.entry.x
    || a.entry.y - b.entry.y)

  for (const candidate of candidates) {
    const startAngle = Math.atan2(candidate.entry.y - candidate.centre.y, candidate.entry.x - candidate.centre.x)
    const endAngle = Math.atan2(candidate.exit.y - candidate.centre.y, candidate.exit.x - candidate.centre.x)
    let sweep = normalizeSignedAngle(endAngle - startAngle)
    if (Math.sign(sweep) !== turnSign && Math.abs(sweep) > EPS) {
      sweep += turnSign * 2 * Math.PI
    }
    // The arc has to turn by as much as the source path it replaces. Without
    // this an arc that wraps the long way round the circle looks tangent at
    // both ends and is wildly wrong in between.
    let sourceTurn = 0
    for (let offset = 1; offset <= candidate.span; offset += 1) {
      const index = (candidate.entryEdge + offset) % count
      const previous = edges[(index - 1 + count) % count]
      const next = edges[index]
      sourceTurn += normalizeSignedAngle(
        Math.atan2(next.uy, next.ux) - Math.atan2(previous.uy, previous.ux),
      )
    }
    if (Math.abs(sweep - sourceTurn) > SWEEP_TOL) continue

    // Nothing may poke inside the circle: the arc is meant to cut the corner
    // off, not to cross the ring somewhere else. Checked against the whole
    // ring, because in a pinched region the segment that blocks the arc is
    // the far wall, which is nowhere near it in index order.
    let clear = true
    for (let index = 0; index < count && clear; index += 1) {
      if (index === candidate.entryEdge || index === candidate.exitEdge) continue
      const edge = edges[index]
      if (Math.min(edge.from.x, edge.to.x) - candidate.centre.x > radius) continue
      if (candidate.centre.x - Math.max(edge.from.x, edge.to.x) > radius) continue
      if (Math.min(edge.from.y, edge.to.y) - candidate.centre.y > radius) continue
      if (candidate.centre.y - Math.max(edge.from.y, edge.to.y) > radius) continue
      if (pointSegmentDistance(candidate.centre.x, candidate.centre.y, edge) < radius - 1e-7) {
        clear = false
      }
    }
    if (!clear) continue

    return { ...candidate, sweep }
  }
  return null
}
