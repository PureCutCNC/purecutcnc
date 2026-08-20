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

// Seeded circle pocket clearing, phase 1 (issue #554).
//
// Clear the open middle of a pocket region with full circles grown from its
// clearance seed, then hand the rest to the existing offset ring tree by
// recording the last circle as an island. This module owns phase 1 and the
// island it produces; `pocket.ts` owns the handoff and phase 2.
//
//   1. Query the maximum inscribed circle of the tool-centre region: centre
//      `C`, radius `R_max`.
//   2. Emit tool-centre circles at `r0, r0 + stepover, r0 + 2·stepover, …`
//      while `r <= R_max`.
//   3. Stop at the first radius that does not fit. No circle is ever clipped.
//
// Two properties of the surrounding code make this cheap, and both are load-
// bearing rather than incidental:
//
//   - The regions handed to the ring builder are already in TOOL-CENTRE space
//     (`initialInset = toolRadius + radialLeave` in `generateRoughBandMoves`),
//     and `buildInsetRegions` expands islands by exactly `stepover` per
//     recursion. Injecting the last circle as-is therefore puts the first
//     phase-2 ring at `lastRadius + stepover` — correct radial engagement with
//     no radius conversion anywhere.
//   - `findLargestClearanceCircle` measures against `[outer, ...islands]` and
//     is refined by branch-and-bound until the bound closes, so it UNDER-
//     reports `R_max` and never over-reports. One query yields the whole
//     schedule: no per-circle containment test, and no Clipper in phase 1.
//
// Core coverage is a property of the schedule, not of where the entry helix
// happened to land: the first circle sweeps the annulus
// `[r0 - toolRadius, r0 + toolRadius]`, so any `r0 <= toolRadius` reaches the
// centre on its own, and consecutive circles are one stepover apart, which is
// never more than the tool diameter. `seedStartRadius` is what guarantees the
// first half of that.

import { isClockwise, normalizeWinding } from './geometry'
import { findLargestClearanceCircle } from './entry'
import { DEFAULT_ENTRY_HELIX_DIAMETER_PERCENT } from './entry'
import type { Operation, Point } from '../../types/project'
import type { ResolvedPocketRegion } from './types'

/**
 * Precision handed to the clearance-circle search, as a fraction of the tool
 * diameter. The search is memoised per `(region, precision)`, so this must be
 * a stable value rather than one derived per call site.
 */
const SEED_CLEARANCE_PRECISION_RATIO = 0.0025

/** Floor on the clearance-circle precision, matching `findHelixPlacement`. */
const MIN_SEED_CLEARANCE_PRECISION = 1e-4

/**
 * Chord tolerance for the emitted circles, as a fraction of the stepover, with
 * the same absolute cap Clipper's round-join offsets use. Matching that rule
 * keeps the seed circle's point density in line with the rounded island
 * offsets the ring tree builds around it, so the handoff does not step from a
 * coarse polygon onto a fine one.
 */
const SEED_ARC_TOLERANCE_RATIO = 0.01
const MAX_SEED_ARC_TOLERANCE = 0.01

/** Smallest useful circle, as a fraction of the tool radius. */
const MIN_SEED_RADIUS_RATIO = 0.05

/** Fewest points in a tessellated seed circle. */
const MIN_SEED_CIRCLE_POINTS = 24

export interface SeedCirclePlan {
  /** Centre of the maximum inscribed circle of the tool-centre region. */
  centre: Point
  /** Maximum inscribed radius, as reported (under-reported) by the search. */
  maxRadius: number
  /** Tool-centre radii to cut, innermost first. Always at least one entry. */
  radii: number[]
  /** Radius of the last circle — the one injected as an island. */
  lastRadius: number
  /**
   * The last circle as a closed contour, wound like a region outer so
   * `buildInsetRegions` treats it exactly as it treats a real island.
   */
  island: Point[]
}

/**
 * Radius of the tool-centre disc the entry has already cleared when phase 1
 * starts — the schedule's `r0`.
 *
 * For a helix that is the orbit radius: `toolRadius · helixPercent / 100`,
 * which `findHelixPlacement` caps at the tool radius (its no-core cap) and can
 * only shrink from there. For plunge and ramp entries nothing circular is
 * cleared, so the schedule starts at the tool radius: the largest first circle
 * that still sweeps its own centre, and therefore the fewest circles that
 * still clear the core.
 *
 * The result is always `<= toolRadius`, which is the condition that makes core
 * coverage independent of where the entry actually went.
 */
export function seedStartRadius(operation: Operation, toolRadius: number): number {
  if (!(toolRadius > 0)) return 0
  if (operation.entryStrategy !== 'helix') return toolRadius
  const percent = operation.entryHelixDiameterPercent ?? DEFAULT_ENTRY_HELIX_DIAMETER_PERCENT
  if (!(percent > 0)) return toolRadius
  return Math.min(toolRadius, (toolRadius * percent) / 100)
}

/** Chord tolerance for a seed circle at this stepover. */
export function seedArcTolerance(stepover: number): number {
  return Math.min(MAX_SEED_ARC_TOLERANCE, Math.max(1e-6, stepover * SEED_ARC_TOLERANCE_RATIO))
}

/**
 * Tessellate a tool-centre circle as a closed contour, wound the way Clipper
 * winds a region outer. Callers apply cut direction with
 * `applyContourDirection`, exactly as they do for a ring.
 *
 * The point count comes from the chord tolerance rather than a fixed number of
 * segments, so a 30 mm circle is not sampled at a 3 mm circle's resolution.
 * Every point lies exactly on the circle, which is what lets arc
 * reconstruction recover the true G2/G3 rather than a fitted approximation.
 */
export function seedCircleContour(centre: Point, radius: number, arcTolerance: number): Point[] {
  const ratio = Math.min(0.5, Math.max(1e-9, arcTolerance / radius))
  const segments = Math.max(MIN_SEED_CIRCLE_POINTS, Math.ceil(Math.PI / Math.acos(1 - ratio)))
  const points: Point[] = []
  for (let index = 0; index < segments; index += 1) {
    const angle = (2 * Math.PI * index) / segments
    points.push({ x: centre.x + radius * Math.cos(angle), y: centre.y + radius * Math.sin(angle) })
  }
  return normalizeWinding(points, isClockwise(points))
}

/**
 * Plan phase 1 for one tool-centre region, or `null` when the region has no
 * seed worth cutting — no clearance circle at all, or one too small to hold a
 * single circle. A null plan is the signal to leave that region on today's
 * path unchanged.
 */
export function planSeedCircles(
  region: ResolvedPocketRegion,
  startRadius: number,
  stepover: number,
  toolDiameter: number,
): SeedCirclePlan | null {
  if (!(startRadius > 0) || !(stepover > 0) || !(toolDiameter > 0)) return null

  const precision = Math.max(MIN_SEED_CLEARANCE_PRECISION, toolDiameter * SEED_CLEARANCE_PRECISION_RATIO)
  const circle = findLargestClearanceCircle(
    [{ outer: region.outer, islands: region.islands }],
    precision,
  )
  if (!circle) return null

  // Stop at the first radius that does not fit: the schedule is bounded by the
  // inscribed radius, which is measured against the walls and every island, so
  // no circle is ever clipped and none needs its own containment test.
  const radii: number[] = []
  for (let radius = startRadius; radius <= circle.radius; radius += stepover) {
    radii.push(radius)
  }
  if (radii.length === 0) return null

  const lastRadius = radii[radii.length - 1]
  if (!(lastRadius >= toolDiameter * MIN_SEED_RADIUS_RATIO)) return null

  const arcTolerance = seedArcTolerance(stepover)
  return {
    centre: { x: circle.center.x, y: circle.center.y },
    maxRadius: circle.radius,
    radii,
    lastRadius,
    island: seedCircleContour(circle.center, lastRadius, arcTolerance),
  }
}

/**
 * The phase-1 contours in cut order, innermost first, before cut direction is
 * applied.
 *
 * Innermost first is what makes each circle a constant-engagement lap: it runs
 * one stepover outside the disc the previous circle left, so a whole lap
 * carries one `feedScale` and survives arc fitting as a single run. The
 * outward growth is also what makes the last circle a legal island — the
 * material outside it is exactly what phase 2 still has to remove.
 */
export function seedCircleContours(plan: SeedCirclePlan, stepover: number): Point[][] {
  const arcTolerance = seedArcTolerance(stepover)
  return plan.radii.map((radius) => seedCircleContour(plan.centre, radius, arcTolerance))
}
