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
//     recursion, so the injected island needs no radius conversion: the first
//     phase-2 ring lands one stepover outside whatever radius it is given.
//     Which radius that is, is `seedIslandRadius`'s decision (issue #576) —
//     the centreline under-states what the stack cleared by a tool radius, and
//     handing the tree that under-statement is what produced the graze rings.
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

/**
 * Fewest full concentric laps worth front-loading before phase 2 takes over.
 *
 * One or two seed circles split the offset tree without clearing enough of the
 * open middle to earn the extra handoff. Keep that small remainder on the
 * regular rings instead. This is deliberately an implementation constant: the
 * seeded strategy is experimental and this threshold is not a user setting.
 */
const MIN_SEED_CIRCLES = 3

/** Sides of the coarse polygon standing in for an area already cleared. */
const SEED_EXCLUSION_SIDES = 16

/**
 * Backstop on the number of open areas seeded in one region.
 *
 * The search terminates on its own — every area consumes at least a disc of
 * `startRadius`, so the free area strictly shrinks — and on real pockets it
 * exits well inside this bound. The cap exists so a pathological region (one
 * whose tessellation lets the inscribed-circle search keep finding slivers)
 * cannot turn one operation into an unbounded run of branch-and-bound
 * searches, each of which pays for every island found before it.
 */
const MAX_SEED_AREAS = 24

export interface SeedCirclePlan {
  /** Centre of the maximum inscribed circle of the tool-centre region. */
  centre: Point
  /** Maximum inscribed radius, as reported (under-reported) by the search. */
  maxRadius: number
  /** Tool-centre radii to cut, innermost first. Always at least one entry. */
  radii: number[]
  /** Radius of the last circle — the outermost lap the seed stack cuts. */
  lastRadius: number
  /**
   * Radius of the virtual island, `>= lastRadius` (issue #576). This is the
   * exclusion the ring tree offsets around, not a lap anybody cuts.
   */
  islandRadius: number
  /**
   * The virtual island as a closed contour, wound like a region outer so
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
 * Radius of the virtual island the ring tree offsets around (issue #576).
 *
 * The seed stack's last lap is a CENTRELINE at `lastRadius`; the cutter
 * following it removes stock out to `lastRadius + toolRadius`. Injecting the
 * centreline itself as the island therefore under-states what phase 1 emptied
 * by a whole tool radius, and the ring tree spends its innermost levels
 * threading slivers through metal that is already gone — 7-18% of the seeded
 * stream's cut length removes nothing measurable.
 *
 * Extending the island to the cleared boundary less the radial leave puts the
 * first ring where there is still stock. The epsilon is deliberate and it is
 * tied to the chord tolerance rather than picked: the island is a tessellated
 * polygon whose chords already sit up to one sagitta INSIDE the true circle,
 * so subtracting the same tolerance is what makes "err toward a hairline air
 * pass, never a hairline uncut ridge" a property of the emitted geometry
 * instead of of the ideal circle.
 *
 * The island is hard for offset generation and soft for cleanup entry: its
 * interior is stock the seed stack already removed, so `seedLeftover.ts` may
 * plunge into it and cut back out. Nothing here forbids entering it.
 *
 * A radial leave at or beyond the tool radius clamps the extension to zero and
 * reproduces the pre-#576 island exactly.
 */
export function seedIslandRadius(
  lastRadius: number,
  stepover: number,
  toolRadius: number,
  stockToLeaveRadial: number,
): number {
  const leave = Math.max(0, stockToLeaveRadial)
  const epsilon = seedArcTolerance(stepover)
  // Never extend past the point where the first ring outside the island stops
  // overlapping what the stack swept. That ring's cutter reaches inward to
  // `lastRadius + extension + stepover - toolRadius`, and the stack cleared to
  // `lastRadius + toolRadius`, so an extension above `2*toolRadius - stepover`
  // opens a ridge all the way around the seed — one the probe then has to walk
  // out in full, which on a coarse stepover costs more than the graze rings the
  // extension removed. The cap only binds above a 50% stepover.
  const extension = Math.min(toolRadius - leave, 2 * toolRadius - stepover) - epsilon
  return lastRadius + Math.max(0, extension)
}

/**
 * The pre-extension island — the last seed centreline itself.
 *
 * This is the "domain minus island BEFORE" half of the leftover probe: the
 * tree built around it is the shipped behaviour, so every contour it holds is
 * a legal tool-centre path, which is what lets an excursion be a subpath of
 * one instead of newly synthesised geometry.
 */
export function seedBaselineIsland(plan: SeedCirclePlan, stepover: number): Point[] {
  return seedCircleContour(plan.centre, plan.lastRadius, seedArcTolerance(stepover))
}

/**
 * How far a later area must stand off from what an earlier one emptied.
 *
 * `toolRadius` is what phase 1's last circle physically reached past its own
 * centreline. The two stepovers are what the ring tree needs to grow a pass
 * out of each side of the gap, since `buildInsetRegions` expands every island
 * by one stepover per recursion — leave less and the two expanded islands meet,
 * the region between them collapses, and no ring is emitted in a gap the
 * cutter was nonetheless too small to have cleared. The remaining
 * `toolRadius`-wide band is what guarantees the pass exists rather than merely
 * fitting to within a rounding error.
 *
 * This is the window that leaves stock, and it only opens above a 50% stepover
 * — below it, two circles far enough apart to need a ring always have room for
 * one. Charging the full separation at every stepover costs a few seeds on
 * fine ones and keeps a single rule.
 *
 * Extending the island (issue #576) does not weaken this. `seedIslandRadius`
 * adds at most one tool radius, and the separation charged here is a tool
 * radius PLUS two stepovers measured from the same `lastRadius`, so two
 * EXTENDED islands are still at least two stepovers apart and still cannot
 * meet. `seedScheduling.test.ts` pins that as an assertion rather than a
 * comment.
 */
function seedSeparation(stepover: number, toolRadius: number): number {
  return toolRadius + 2 * stepover
}

/**
 * The area an earlier seed consumed, as a polygon that CONTAINS its disc.
 *
 * Deliberately coarse and deliberately circumscribed. Every later
 * inscribed-circle search measures against every polygon found before it, and
 * that search calls `pointToRegionDistance` once per quadtree cell over every
 * edge of every contour — so a chord-tolerance tessellation here makes the
 * whole plan quadratic in the number of areas for no benefit. A 16-gon
 * circumscribing the disc is 2% larger than it, which errs toward standing
 * further off, and that is the safe direction.
 */
function seedExclusionPolygon(centre: Point, radius: number): Point[] {
  const vertexRadius = radius / Math.cos(Math.PI / SEED_EXCLUSION_SIDES)
  const points: Point[] = []
  for (let index = 0; index < SEED_EXCLUSION_SIDES; index += 1) {
    const angle = (2 * Math.PI * index) / SEED_EXCLUSION_SIDES
    points.push({
      x: centre.x + vertexRadius * Math.cos(angle),
      y: centre.y + vertexRadius * Math.sin(angle),
    })
  }
  return normalizeWinding(points, isClockwise(points))
}

/**
 * Plan phase 1 for one tool-centre region: every open area it holds, largest
 * first, or an empty list when it holds none worth cutting.
 *
 * Each pass finds the largest inscribed circle of what is still uncut, cuts
 * the schedule that fits inside it, and then hands the disc it cleared to the
 * next pass **as an island**. That is what keeps the "never clipped" property
 * across several seeds rather than only the first: the next area's inscribed
 * radius is measured against the walls, the real islands, and everything phase
 * 1 has already removed, so its circles are whole circles standing in uncut
 * material — never arcs trimmed against a cleared disc.
 *
 * The loop is self-terminating. Every area consumes at least a disc of radius
 * `startRadius`, so the free area strictly shrinks, and the search stops as
 * soon as the largest remaining circle cannot hold even the first radius.
 * `MAX_SEED_AREAS` is a backstop against pathological tessellation, not the
 * expected exit.
 *
 * `stockToLeaveRadial` only ever reaches `seedIslandRadius`: the schedule
 * itself is bounded by the inscribed radius of a region that already has the
 * leave taken out of it, so the laps do not need it a second time.
 */
export function planSeedCircles(
  region: ResolvedPocketRegion,
  startRadius: number,
  stepover: number,
  toolDiameter: number,
  stockToLeaveRadial = 0,
): SeedCirclePlan[] {
  if (!(startRadius > 0) || !(stepover > 0) || !(toolDiameter > 0)) return []

  const precision = Math.max(MIN_SEED_CLEARANCE_PRECISION, toolDiameter * SEED_CLEARANCE_PRECISION_RATIO)
  const arcTolerance = seedArcTolerance(stepover)
  const minRadius = toolDiameter * MIN_SEED_RADIUS_RATIO
  const plans: SeedCirclePlan[] = []
  const consumed: Point[][] = []

  while (plans.length < MAX_SEED_AREAS) {
    const circle = findLargestClearanceCircle(
      [{ outer: region.outer, islands: [...region.islands, ...consumed] }],
      precision,
    )
    if (!circle) break

    // Stop at the first radius that does not fit: the schedule is bounded by
    // the inscribed radius, which is measured against the walls, the islands
    // and every disc already cleared, so no circle is ever clipped and none
    // needs its own containment test.
    const radii: number[] = []
    for (let radius = startRadius; radius <= circle.radius; radius += stepover) {
      radii.push(radius)
    }
    // This is the largest remaining open area. If it cannot produce three
    // circles, no later (smaller) area can either, so leave all of the
    // remainder on the regular offset tree instead of adding a counter-
    // productive one- or two-circle seed.
    if (radii.length < MIN_SEED_CIRCLES) break

    const lastRadius = radii[radii.length - 1]
    if (!(lastRadius >= minRadius)) break

    const islandRadius = seedIslandRadius(lastRadius, stepover, toolDiameter / 2, stockToLeaveRadial)
    plans.push({
      centre: { x: circle.center.x, y: circle.center.y },
      maxRadius: circle.radius,
      radii,
      lastRadius,
      islandRadius,
      island: seedCircleContour(circle.center, islandRadius, arcTolerance),
    })
    consumed.push(seedExclusionPolygon(
      circle.center,
      lastRadius + seedSeparation(stepover, toolDiameter / 2),
    ))
  }

  return plans
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
