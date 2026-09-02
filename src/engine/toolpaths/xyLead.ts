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

// XY lead-in / lead-out: a tangent arc onto and off a finished surface
// (issue #695).
//
// A plunge on a FLOOR is axial, into material the tool is about to remove, and
// it lands at the depth the floor is going to anyway. A plunge on a WALL puts
// the full flute radially against a surface that stays, at zero XY feed: the
// tool deflects into it and rubs a vertical witness line. That is dimensional,
// not just cosmetic, and stopping and retracting on the wall does the same on
// the way up. So this module answers one question for both ends of a pass:
// where does the cutter reach depth, and how does it meet the surface from
// there.
//
// The lead is a SINGLE circular arc, tangent to the contour at the point it
// joins. A lead has only one constrained end — the arrival — so the S-link's
// second arc, which exists to return a ring-to-ring link to a parallel
// heading, buys nothing here and costs space. Radius is the parameter that
// matters: approaching a straight wall on a tangent arc the gap between cutter
// and wall at arc-distance d back from tangency is about d^2 / 2R, so a wider
// arc halves the engagement at every point of the approach. That gentler ramp
// is what prevents the mark, which is why the radius ladder is tried
// LARGEST-first and the sweep only breaks ties within one radius.
//
// The turn side is predicted, not guessed: a probe to either side of the
// contour says which one the domain allows, and only where both are free — an
// interior ring standing in open space — are both tried. A tangent arc on the
// free side curves AWAY from the contour it approaches, so it cannot gouge it.
//
// A candidate survives only if every tessellated vertex AND every interpolated
// sample between vertices lies inside the tool-centre-safe domain, the arc fits
// the length budget, and it is a real displacement off the contour. Nothing
// qualifying means no lead at all: the generator emits its ordinary direct
// entry or retract, keeps the cut order it intended, and the caller reports a
// structured warning.
//
// Feed is ONE constant reduced value across the whole lead, not a ramp. Arc
// fitting groups a run by equal feedScale, so a per-move ramp would linearise
// the arc into a string of G1 chords — and a faceted approach on a finished
// wall is its own source of marking. One constant-radius arc at one feed is
// what round-trips to a single G2/G3.

import type { Operation, OperationKind, Point } from '../../types/project'
import { usesTangentLinks } from './pocketPatterns'
import {
  buildOffsetDomainCheck,
  buildTangentLeadPath,
  domainChordBudget,
  domainSafePathLength,
  type TangentLeadShape,
  type TangentLinkDomainRegion,
} from './tangentLink'
import { DEFAULT_FLATTEN_ARC_STEP } from './geometry'
import type { ToolpathMove, ToolpathPoint } from './types'
import type { ToolpathWarning } from './warningCodes'

const LEAD_EPSILON = 1e-9

/** Operation kinds that carry the shared clearing-entry seam this lead hooks. */
const XY_LEAD_KINDS: readonly OperationKind[] = ['pocket', 'surface_clean', 'rough_surface']

/**
 * Arc radii tried, as multiples of tool diameter, LARGEST first.
 *
 * Radius sets how fast the cutter engages on the approach (see the header), so
 * the widest arc the space allows is always the best one. The ladder falls back
 * rather than giving up: a wall with room gets a full diameter of arc, a narrow
 * neck still gets a quarter of one.
 */
const LEAD_RADIUS_FACTORS = [1, 0.75, 0.5, 0.25] as const

/**
 * Sweep angles tried within one radius, widest first, degrees. 90 deg is the
 * conventional wall lead; the shorter sweeps only exist so a candidate that is
 * blocked at its far end can still be taken at the same radius rather than
 * dropping to a tighter one.
 */
const LEAD_SWEEP_DEGREES = [90, 60, 45] as const

/**
 * How far past a ring's seam the exit lead may start looking for a departure,
 * as multiples of the tool diameter. Zero first — the cheapest exit leaves the
 * moment the contour closes.
 *
 * A closed contour ends where it began, and one seamed at a corner arrives
 * pointing STRAIGHT AT the wall it was cutting: no tangent departure exists
 * there at any radius, because the first infinitesimal step already leaves the
 * domain. Clearing rings are seamed by the traversal, not by this module, so
 * they keep this fallback; continuing a little way along the ring the cutter
 * has just cut costs motion through its own kerf and nothing else.
 */
const LEAD_OVERLAP_FACTORS = [0, 0.25, 0.5, 1] as const

/**
 * Probe distance either side of the contour when predicting the free side, as a
 * fraction of tool diameter. Large enough to clear the domain predicate's own
 * boundary tolerance, small enough that it asks about the contour rather than
 * about something a millimetre away.
 */
const LEAD_SIDE_PROBE_FRACTION = 0.05

/**
 * Fraction of the tessellation chord used as the domain-sampling budget.
 *
 * `domainChordBudget` returns exactly one tessellation chord, so on an arc it
 * yields no samples BETWEEN vertices — the segment is never longer than the
 * budget. That is what the ring-to-ring S-link uses and it is fine for a link
 * that runs through cleared material. A lead runs against a surface that stays,
 * where the whole point is that the cutter does not touch it early, so leads
 * halve the budget and get an interior sample on every chord. The cost is one
 * extra domain check per chord on a path emitted a handful of times per level.
 */
const LEAD_SAMPLE_REFINEMENT = 0.5

const MIN_LEAD_OFFSET_FRACTION = 0.5

export interface XyLeadOptions {
  /** Cutter diameter; the radius ladder is expressed in multiples of it. */
  toolDiameter: number
  /** Total path length budget for one lead, project units. */
  maxLength: number
  /** Angular tessellation step for the lead arc, radians. */
  arcStepRadians: number
  /** Operation cut feed, for the lead's constant reduced feed. */
  cutFeed: number
  /** Operation plunge feed, for the lead's constant reduced feed. */
  plungeFeed: number
  /** True when a tool-centre position lies inside the safe domain. */
  isInsideDomain: (x: number, y: number) => boolean
}

export interface XyLeadPlan {
  /**
   * Tessellated lead, both ends inclusive. A lead-in runs staging -> ring; a
   * lead-out runs ring -> staging.
   */
  points: Point[]
  /** Where the descent lands (lead-in) or the retract happens (lead-out). */
  staging: Point
  /** Ring vertex the lead joins; the ring re-seams there. Lead-in only. */
  arrivalIndex: number
}

/**
 * One level's lead state. `entryPending` is the latch that makes the lead-in
 * happen on the level's FIRST clearing ring and nowhere else: the ring-to-ring
 * transitions inside a level keep their existing at-depth link rules, which the
 * lead has no business touching.
 */
export interface XyLeadContext {
  options: XyLeadOptions
  entryPending: boolean
  /**
   * The last closed ring emitted at this level and where its cut ended. The
   * exit lead needs the ring, not just the endpoint, because it may depart from
   * a point further along it. Kept as a record rather than threaded through the
   * traversal because a level has several possible endings — rings, seed
   * stacks, leftover excursions — and only the last one to write here wins.
   */
  exit: { ring: Point[]; end: ToolpathPoint } | null
  onWarning: (warning: ToolpathWarning) => void
}

/**
 * Lead options for one pass, or undefined when the operation has not opted in.
 * Undefined is byte-identical legacy output — a missing or `'none'`
 * `xyLeadStrategy` never reaches the planner at all.
 *
 * The length budget stays the S-link's 2.5x diameter: a lead and a ring-to-ring
 * link move through the same domain, and two separately tuned budgets would
 * drift into disagreeing about what fits. The widest arc in the ladder needs
 * only 1.57x, so the budget binds on the overlap, not on the arc.
 */
export function xyLeadOptions(
  operation: Operation,
  toolDiameter: number,
  domainRegions: TangentLinkDomainRegion[],
): XyLeadOptions | undefined {
  if (operation.xyLeadStrategy !== 'arc') return undefined
  if (!supportsXyLead(operation)) return undefined
  if (!(toolDiameter > 0) || domainRegions.length === 0) return undefined
  return {
    toolDiameter,
    maxLength: toolDiameter * 2.5,
    arcStepRadians: DEFAULT_FLATTEN_ARC_STEP,
    cutFeed: operation.feed,
    plungeFeed: operation.plungeFeed,
    isInsideDomain: buildOffsetDomainCheck(domainRegions),
  }
}

/**
 * Does this operation's kind and pattern carry XY leads at all?
 *
 * A lead attaches to a closed clearing ring, so the ring patterns qualify and
 * the raster pattern does not — `usesTangentLinks` already draws exactly that
 * line for the S-link and there is no second answer to give here. Finish passes
 * are out of v1 scope: they are not clearing entries.
 */
export function supportsXyLead(operation: Operation): boolean {
  if (!XY_LEAD_KINDS.includes(operation.kind)) return false
  if (operation.pass !== 'rough') return false
  return usesTangentLinks(operation.kind, operation.pocketPattern)
}

/**
 * The operation's lead options once every gate has had its say, warning on each
 * gate that turns a requested lead down. Called once per clearing pass, not per
 * level: it builds the domain predicate's bounding boxes.
 *
 * A non-null region mask disables leads and warns. The masked domain is
 * resolved before generation, but the mask's own clipping seam discards
 * `lead_in`/`lead_out` moves, which would leave the descent staged off the ring
 * with no lead left to reach it — an unsound vertical entry reintroduced by a
 * later stage. Region-aware leads are separate work at the pre-generation
 * domain seam.
 */
export function resolveXyLeadOptions(
  operation: Operation,
  toolDiameter: number,
  domainRegions: TangentLinkDomainRegion[],
  hasRegionMask: boolean,
  onWarning: (warning: ToolpathWarning) => void,
): XyLeadOptions | undefined {
  if (warnXyLeadDeclined(operation, hasRegionMask, onWarning)) return undefined
  return xyLeadOptions(operation, toolDiameter, domainRegions)
}

/**
 * Report a requested lead the caller will not honour, and say so: true means
 * declined. A generator that cannot carry leads at all — a raster clearing
 * branch — calls this on its own so the request is answered rather than
 * dropped. An operation that asked for nothing is not a refusal and is silent.
 */
export function warnXyLeadDeclined(
  operation: Operation,
  hasRegionMask: boolean,
  onWarning: (warning: ToolpathWarning) => void,
): boolean {
  if (operation.xyLeadStrategy !== 'arc') return true
  if (!supportsXyLead(operation)) {
    onWarning({ code: 'xyLeadUnsupported' })
    return true
  }
  if (hasRegionMask) {
    onWarning({ code: 'xyLeadRegionMask' })
    return true
  }
  return false
}

/**
 * Arm one level's lead state. The latch is per level because each level enters
 * the material afresh: the level's first ring takes the lead-in, and the level
 * ends with a lead-out before its retract.
 */
export function beginXyLeadLevel(
  options: XyLeadOptions | undefined,
  onWarning: (warning: ToolpathWarning) => void,
): XyLeadContext | undefined {
  return options ? { options, entryPending: true, exit: null, onWarning } : undefined
}

/**
 * Emit the level's lead-out, if one fits, immediately before the retract.
 * Returns the position the retract should start from — unchanged when no lead
 * was emitted, so a caller can always assign the result back.
 *
 * The entry and exit leads are planned independently on purpose. They are
 * placed at opposite ends of the level against different local geometry, and a
 * level whose entry ring had no room is not thereby a level that must also give
 * up its exit.
 */
export function emitXyLeadOut(
  moves: ToolpathMove[],
  from: ToolpathPoint | null,
  z: number,
  context: XyLeadContext | undefined,
): ToolpathPoint | null {
  if (!context || from === null) return from
  const exit = context.exit
  if (exit === null) return from
  // The recorded ring is only the exit's ring if the cutter is still standing
  // where that ring ended. Anything emitted afterwards — a leftover excursion,
  // a retract, an open raster run — moves the tool off it and this check
  // declines rather than leading off a ring that is no longer the tail.
  if (Math.abs(exit.end.x - from.x) > LEAD_EPSILON
    || Math.abs(exit.end.y - from.y) > LEAD_EPSILON
    || Math.abs(exit.end.z - from.z) > LEAD_EPSILON
    || Math.abs(exit.end.z - z) > LEAD_EPSILON) {
    return from
  }
  const plan = planXyLeadOut(exit.ring, context.options)
  if (plan === null) {
    context.onWarning({ code: 'xyLeadNoViablePath' })
    return from
  }
  return emitXyLead(moves, from, plan, z, context.options, 'lead_out')
}

/**
 * Record the ring a lead-out may leave from. Called after each closed ring is
 * appended; the vertices are read back out of the emitted moves so the record
 * always describes what was actually cut, re-seamed by an S-link splice or not.
 * Anything that is not a planar closed ring clears the record.
 */
export function recordXyLeadExit(
  context: XyLeadContext | undefined,
  cutMoves: ToolpathMove[],
): void {
  if (!context) return
  context.exit = closedRingFromMoves(cutMoves)
}

function closedRingFromMoves(
  cutMoves: ToolpathMove[],
): { ring: Point[]; end: ToolpathPoint } | null {
  if (cutMoves.length < 3) return null
  const z = cutMoves[0].from.z
  for (const move of cutMoves) {
    if (Math.abs(move.from.z - z) > LEAD_EPSILON || Math.abs(move.to.z - z) > LEAD_EPSILON) return null
  }
  const end = cutMoves[cutMoves.length - 1].to
  const seam = cutMoves[0].from
  if (Math.abs(end.x - seam.x) > LEAD_EPSILON || Math.abs(end.y - seam.y) > LEAD_EPSILON) return null
  return { ring: cutMoves.map((move) => ({ x: move.from.x, y: move.from.y })), end }
}

/**
 * Consume the level's one lead-in attempt against `contour`, or null when the
 * context is spent, absent, or nothing valid fits. The latch is spent either
 * way: a level whose first ring cannot take a lead does not go hunting through
 * the rest of its rings for one, because that would move the descent to a ring
 * the schedule did not choose to start on.
 */
export function takeXyLeadIn(
  context: XyLeadContext | undefined,
  contour: Point[],
): XyLeadPlan | null {
  if (!context || !context.entryPending) return null
  context.entryPending = false
  const plan = planXyLeadIn(contour, context.options)
  if (plan === null) context.onWarning({ code: 'xyLeadNoViablePath' })
  return plan
}

/**
 * Re-seam `ring` at the vertex a lead-in plans to arrive on. Returns the ring
 * unchanged when there is no plan, so a call site can apply it unconditionally.
 */
export function rotateRingForLead(ring: Point[], plan: XyLeadPlan | null): Point[] {
  if (plan === null || plan.arrivalIndex <= 0 || plan.arrivalIndex >= ring.length) return ring
  return [...ring.slice(plan.arrivalIndex), ...ring.slice(0, plan.arrivalIndex)]
}

/**
 * Plan the arc that arrives on `contour` tangent-continuously.
 *
 * Candidate order is radius-major, sweep next, contour position last, and the
 * first fully valid candidate wins: the widest arc the domain accepts anywhere
 * on the contour beats a narrower one that happens to fit at a lower index.
 * A closed contour can be re-seamed at any vertex at no cost, so arc quality is
 * the thing worth ordering on — and the search never assumes the source
 * contour's first vertex, it only reaches it in the same fixed order as every
 * other one.
 */
export function planXyLeadIn(contour: Point[], options: XyLeadOptions): XyLeadPlan | null {
  if (contour.length < 3) return null

  for (const arc of leadArcs(options)) {
    const chordBudget = domainChordBudget(arc.radius, options.arcStepRadians) * LEAD_SAMPLE_REFINEMENT
    for (let index = 0; index < contour.length; index += 1) {
      const anchor = contour[index]
      const forward = contourTangent(contour, index)
      if (forward === null) continue
      // Built backwards from the contour and then reversed: the path that
      // leaves along -t is exactly the path that arrives along +t. The sign
      // flips with it, so the arc still curves to the free side.
      const reversed = { x: -forward.x, y: -forward.y }
      for (const side of orderedSides(anchor, forward, options)) {
        const departing = buildTangentLeadPath(
          anchor,
          reversed,
          arcShape(-side, arc),
          options.arcStepRadians,
        )
        if (validateLead(anchor, departing, arc.radius, chordBudget, options) === null) continue
        const points = [...departing].reverse()
        return { points, staging: points[0], arrivalIndex: index }
      }
    }
  }
  return null
}

/**
 * Plan the arc that leaves `contour` — in emission order, so `contour[0]` is
 * where its cut ended.
 *
 * Same ladder, same validator as the entry. The one addition is the overlap:
 * the departure may sit a short way along the contour past its seam, which is
 * the exit's counterpart to the entry's freedom to pick where it arrives.
 * Smallest overlap first, so a clean departure at the seam always wins over one
 * that re-traverses.
 */
export function planXyLeadOut(contour: Point[], options: XyLeadOptions): XyLeadPlan | null {
  if (contour.length < 3) return null

  for (const arc of leadArcs(options)) {
    const chordBudget = domainChordBudget(arc.radius, options.arcStepRadians) * LEAD_SAMPLE_REFINEMENT
    for (const factor of LEAD_OVERLAP_FACTORS) {
      const departure = contourDeparture(contour, factor * options.toolDiameter)
      if (departure === null) continue
      for (const side of orderedSides(departure.point, departure.tangent, options)) {
        const lead = buildTangentLeadPath(
          departure.point,
          departure.tangent,
          arcShape(side, arc),
          options.arcStepRadians,
        )
        const points = [...departure.overlap, ...lead.slice(1)]
        if (validateLead(departure.point, points, arc.radius, chordBudget, options) === null) continue
        return { points, staging: points[points.length - 1], arrivalIndex: 0 }
      }
    }
  }
  return null
}

/** One lead arc as a degenerate `TangentLeadShape`: no straight, no second arc. */
function arcShape(side: number, arc: { radius: number; sweep: number }): TangentLeadShape {
  return {
    turn1: side * arc.sweep,
    radius1: side * arc.radius,
    straight: 0,
    turn2: 0,
    radius2: 0,
  }
}

/** The radius ladder crossed with the sweep list, widest radius first. */
function* leadArcs(options: XyLeadOptions): Generator<{ radius: number; sweep: number }> {
  for (const factor of LEAD_RADIUS_FACTORS) {
    const radius = options.toolDiameter * factor
    if (!(radius > LEAD_EPSILON)) continue
    for (const degrees of LEAD_SWEEP_DEGREES) {
      yield { radius, sweep: (degrees * Math.PI) / 180 }
    }
  }
}

/**
 * Which way the arc should turn off the contour, best guess first.
 *
 * A probe either side says which one the domain allows. On a wall exactly one
 * answers — the material side is not in the domain — so the side is decided
 * rather than searched, and the arc provably curves away from the surface it is
 * approaching. Where both answer, the contour is standing in open space (an
 * interior clearing ring) and either turn is sound, so both are offered in a
 * fixed order. Where neither answers there is nothing to try.
 *
 * The probe only orders the candidates. The domain check over the whole
 * tessellated path is what actually accepts one.
 */
function orderedSides(anchor: Point, tangent: Point, options: XyLeadOptions): readonly number[] {
  const probe = options.toolDiameter * LEAD_SIDE_PROBE_FRACTION
  // Left of travel in screen coordinates, and its opposite.
  const left = options.isInsideDomain(anchor.x - tangent.y * probe, anchor.y + tangent.x * probe)
  const right = options.isInsideDomain(anchor.x + tangent.y * probe, anchor.y - tangent.x * probe)
  if (left && !right) return [1]
  if (right && !left) return [-1]
  if (!left && !right) return []
  return [1, -1]
}

/** Contour travel tangent leaving vertex `index`, or null on a degenerate edge. */
function contourTangent(contour: Point[], index: number): Point | null {
  const from = contour[index]
  const to = contour[(index + 1) % contour.length]
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy)
  if (!(length > LEAD_EPSILON)) return null
  return { x: dx / length, y: dy / length }
}

/**
 * Where a lead-out departs after running `distance` along `contour` from its
 * seam, with the tangent it arrives on and the overlap polyline that gets it
 * there.
 *
 * At distance zero that tangent is the contour's CLOSING chord — the direction
 * the cutter is actually travelling as the contour shuts — not the first edge's,
 * which is where it would be going next.
 */
function contourDeparture(
  contour: Point[],
  distance: number,
): { point: Point; tangent: Point; overlap: Point[] } | null {
  const seam = contour[0]
  if (!(distance > LEAD_EPSILON)) {
    const closing = contour[contour.length - 1]
    const dx = seam.x - closing.x
    const dy = seam.y - closing.y
    const length = Math.hypot(dx, dy)
    if (!(length > LEAD_EPSILON)) return null
    return { point: seam, tangent: { x: dx / length, y: dy / length }, overlap: [seam] }
  }

  const overlap: Point[] = [seam]
  let travelled = 0
  for (let step = 0; step < contour.length; step += 1) {
    const from = contour[step]
    const to = contour[(step + 1) % contour.length]
    const dx = to.x - from.x
    const dy = to.y - from.y
    const edge = Math.hypot(dx, dy)
    if (!(edge > LEAD_EPSILON)) continue
    if (travelled + edge < distance) {
      travelled += edge
      overlap.push(to)
      continue
    }
    const along = (distance - travelled) / edge
    const point = { x: from.x + dx * along, y: from.y + dy * along }
    overlap.push(point)
    return { point, tangent: { x: dx / edge, y: dy / edge }, overlap }
  }
  return null
}

/**
 * Emit one planned lead as `lead_in` / `lead_out` moves at `z`.
 *
 * Every move carries the SAME feed scale — `min(plungeFeed / feed, 1)`, the
 * ceiling a vertical entry move already respects. A ramp across the lead was
 * tried and dropped: arc fitting groups a run by equal `feedScale`, so a
 * per-move ramp linearises the arc into G1 chords, and a faceted approach on a
 * finished wall marks it as surely as the plunge this replaces. One arc, one
 * feed, one G2/G3. Vertical motion is not this module's: the descent stays
 * `plunge` at plunge feed.
 */
export function emitXyLead(
  moves: ToolpathMove[],
  from: ToolpathPoint,
  plan: XyLeadPlan,
  z: number,
  options: XyLeadOptions,
  kind: 'lead_in' | 'lead_out',
): ToolpathPoint {
  const segments = plan.points.length - 1
  if (segments < 1) return from
  const scale = leadFeedScale(options)
  let current: ToolpathPoint = from
  for (let index = 0; index < segments; index += 1) {
    const next: ToolpathPoint = { x: plan.points[index + 1].x, y: plan.points[index + 1].y, z }
    moves.push({
      kind,
      from: current,
      to: next,
      ...(scale < 1 ? { feedScale: scale } : {}),
    })
    current = next
  }
  return current
}

/** The one feed scale a lead runs at, entry and exit alike. */
export function leadFeedScale(options: XyLeadOptions): number {
  if (!(options.cutFeed > 0) || !(options.plungeFeed > 0)) return 1
  return Math.min(1, options.plungeFeed / options.cutFeed)
}

/**
 * Accept a candidate only when it is a real lead that stays sound end to end:
 * inside the tool-centre-safe domain at every vertex and every sample between
 * them, inside the length budget, and far enough off the contour to be worth
 * emitting. Returns the path length, or null to reject the candidate whole.
 */
function validateLead(
  anchor: Point,
  path: Point[],
  radius: number,
  chordBudget: number,
  options: XyLeadOptions,
): number | null {
  if (path.length < 2) return null
  const far = path[path.length - 1]
  const offset = Math.hypot(far.x - anchor.x, far.y - anchor.y)
  if (!(offset > radius * MIN_LEAD_OFFSET_FRACTION)) return null
  const length = domainSafePathLength(path, chordBudget, options.isInsideDomain)
  if (length === null || length > options.maxLength) return null
  return length
}
