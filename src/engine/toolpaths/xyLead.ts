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
  buildClearanceCheck,
  buildKeepOutCheck,
  buildOffsetDomainCheck,
  buildTangentLeadPath,
  domainChordBudget,
  domainSafePathLength,
  type TangentLeadShape,
  type TangentLinkDomainRegion,
} from './tangentLink'
import { entryBoundarySafety } from './entry'
import { DEFAULT_FLATTEN_ARC_STEP } from './geometry'
import type { ToolpathMove, ToolpathPoint } from './types'
import type { ToolpathWarning } from './warningCodes'

const LEAD_EPSILON = 1e-9

/** Operation kinds that carry the shared clearing-entry seam this lead hooks. */
const XY_LEAD_KINDS: readonly OperationKind[] = [
  'pocket', 'surface_clean', 'rough_surface', 'edge_route_inside', 'edge_route_outside',
]

/** True when every contour `kind` cuts is a wall of the finished part. */
function everyContourIsAWall(kind: OperationKind): boolean {
  return kind === 'edge_route_inside' || kind === 'edge_route_outside'
}

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
  /**
   * The domain with the boundary-safety margin taken off — where the cutter may
   * be without touching a surface that stays. Everything but the short stretch
   * of lead nearest its join is held to this, so the arc cannot ride a SECOND
   * wall on its way past the one it is joining.
   */
  isClearOfWalls: (x: number, y: number) => boolean
}

export interface XyLeadPlan {
  /**
   * Tessellated lead, both ends inclusive. A lead-in runs staging -> ring; a
   * lead-out runs ring -> staging.
   */
  points: Point[]
  /** Where the descent lands (lead-in) or the retract happens (lead-out). */
  staging: Point
  /**
   * The contour re-seamed to begin (and so end) at the point the lead joins.
   * Null for an exit, which leaves a contour already cut.
   *
   * A join is not restricted to an existing vertex. A four-vertex wall contour
   * is all corners, and arriving AT a corner along the contour's own tangent
   * means coming from before it — which is outside the domain, since the
   * previous edge runs the other way. Landing mid-edge is what makes a lead
   * possible there at all, so the seam is a point, not an index.
   */
  seam: Point[] | null
}

/**
 * One level's lead state.
 *
 * A context is handed only to contours that DEFINE A SURFACE THAT SURVIVES —
 * wall contours, island wall contours, and the wall-adjacent ring of a roughing
 * pass that leaves no radial stock. Interior clearing rings and floors never
 * receive one, so the ring-to-ring transitions inside a level keep their
 * existing at-depth link rules untouched.
 */
export interface XyLeadContext {
  options: XyLeadOptions
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
    isClearOfWalls: buildClearanceCheck(domainRegions, entryBoundarySafety(toolDiameter)),
  }
}

/**
 * The same options with `keepOut` also forbidden — loops the lead must miss
 * that are not part of the domain the pass was offset from.
 *
 * Tab footprints are the case that needs it. A lead runs at cut depth, and the
 * tab pass that follows generation only lifts vertical moves and splits cuts;
 * it never sees a lead. A lead planned through a tab would drive straight into
 * it. Tabs stand only below their own tops, so the caller composes this per
 * level rather than once per pass.
 */
export function withKeepOut(
  options: XyLeadOptions | undefined,
  keepOut: Point[][],
): XyLeadOptions | undefined {
  if (!options || keepOut.length === 0) return options
  const blocked = buildKeepOutCheck(keepOut)
  const inDomain = options.isInsideDomain
  const clearOfWalls = options.isClearOfWalls
  // The same test feeds both: the loops arrive already grown by the cutter's own
  // clearance, so riding their boundary is tangency rather than a collision.
  return {
    ...options,
    isInsideDomain: (x, y) => inDomain(x, y) && !blocked(x, y),
    isClearOfWalls: (x, y) => clearOfWalls(x, y) && !blocked(x, y),
  }
}

/**
 * Does this operation carry XY leads at all?
 *
 * Kind only. WHERE a lead is emitted is not a property of the operation, it is
 * a property of the pass: a lead belongs wherever the cutter would otherwise
 * reach a surface that survives into the finished part by plunging onto it.
 * Each generator answers that for its own contours by passing a context, or
 * not, so this predicate deliberately says nothing about pass or pattern.
 */
export function supportsXyLead(operation: Operation): boolean {
  return XY_LEAD_KINDS.includes(operation.kind)
}

/**
 * Does a ROUGHING ring leave the finished wall behind it?
 *
 * Radial stock left means a finish pass will come back and cut the wall again,
 * so a mark the roughing ring leaves is machined away and the lead would be
 * motion spent on nothing. No radial stock means this ring IS the wall, and it
 * needs the approach exactly as a finish contour does.
 *
 * The engine cannot see whether a sibling finish operation exists, so this is
 * deliberately conservative: an operation leaving no radial stock gets the lead
 * even where the user means to finish it separately. That costs a little
 * motion. The other way round costs a marked wall.
 */
export function roughingRingIsTheFinishedWall(operation: Operation): boolean {
  if (Math.max(0, operation.stockToLeaveRadial) > LEAD_EPSILON) return false
  // A clearing pass leaves a wall behind only where it cuts offset rings; a
  // raster fill has no ring that is a wall. An edge route has nothing BUT
  // wall contours, at every level, so it needs no second term.
  return everyContourIsAWall(operation.kind)
    || usesTangentLinks(operation.kind, operation.pocketPattern)
}

/**
 * The tool-centre-safe domain on the OUTSIDE of a set of retained loops, for a
 * route that travels around material rather than inside a cavity.
 *
 * `keepOut` is everything the cutter must not enter, already grown to
 * tool-centre distance: the wall contour the route follows, other retained
 * features, and the tab footprints standing at this level. The domain has to
 * be bounded for the containment test to mean anything, so the outer loop is
 * the box those loops occupy grown by `reach` — far enough that any lead
 * within its own length budget fits, near enough that a lead cannot wander off
 * into space the caller never reasoned about.
 *
 * The boundary is deliberately generous and the keep-out deliberately strict:
 * a lead rejected here costs a fallback to the direct entry the route already
 * had, while one admitted wrongly costs a gouge.
 */
export function domainOutsideLoops(
  keepOut: Point[][],
  reach: number,
): TangentLinkDomainRegion[] {
  const loops = keepOut.filter((loop) => loop.length >= 3)
  if (loops.length === 0) return []
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const loop of loops) {
    for (const point of loop) {
      if (point.x < minX) minX = point.x
      if (point.x > maxX) maxX = point.x
      if (point.y < minY) minY = point.y
      if (point.y > maxY) maxY = point.y
    }
  }
  const lo = { x: minX - reach, y: minY - reach }
  const hi = { x: maxX + reach, y: maxY + reach }
  return [{
    outer: [lo, { x: hi.x, y: lo.y }, hi, { x: lo.x, y: hi.y }],
    islands: loops,
  }]
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
  if (warnXyLeadDeclined(operation, supportsXyLead(operation), hasRegionMask, onWarning)) return undefined
  return xyLeadOptions(operation, toolDiameter, domainRegions)
}

/**
 * Report a requested lead the caller will not honour, and say so: true means
 * declined. `carries` is the call site's own answer to "can leads happen here
 * at all" — a raster clearing branch passes false, because its fill has no
 * contour to join. An operation that asked for nothing is not a refusal and is
 * silent.
 */
export function warnXyLeadDeclined(
  operation: Operation,
  carries: boolean,
  hasRegionMask: boolean,
  onWarning: (warning: ToolpathWarning) => void,
): boolean {
  if (operation.xyLeadStrategy !== 'arc') return true
  if (!carries) {
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
 * Arm one level's lead state. Per level because each level enters the material
 * afresh and ends with its own retract.
 */
export function beginXyLeadLevel(
  options: XyLeadOptions | undefined,
  onWarning: (warning: ToolpathWarning) => void,
): XyLeadContext | undefined {
  return options ? { options, onWarning } : undefined
}

/**
 * Emit the arc that leaves `contour` immediately after it is cut, if one fits.
 * Returns the position the next transition should start from — unchanged when
 * no lead was emitted, so a caller can always assign the result back.
 *
 * Per CONTOUR, not per level. Emitting it once at the end of a level leaves
 * every wall but the last one being departed by simply stopping and travelling
 * away, which rubs the finished surface exactly as the plunge did on the way
 * in — measured on a pocket with an island, where the outer wall got an entry
 * arc and no exit at all.
 */
export function emitXyLeadOut(
  moves: ToolpathMove[],
  from: ToolpathPoint | null,
  contour: Point[],
  z: number,
  context: XyLeadContext | undefined,
): ToolpathPoint | null {
  if (!context || from === null || contour.length < 3) return from
  // The cut ends where the contour began; anything else means the caller is
  // not standing on the contour it just cut.
  if (Math.abs(contour[0].x - from.x) > LEAD_EPSILON
    || Math.abs(contour[0].y - from.y) > LEAD_EPSILON) {
    return from
  }
  const plan = planXyLeadOut(contour, context.options)
  if (plan === null) {
    context.onWarning({ code: 'xyLeadNoViablePath' })
    return from
  }
  return emitXyLead(moves, from, plan, z, context.options, 'lead_out')
}

/**
 * The closed contour a run of cut moves actually traced, in emission order, or
 * null when the run is not a planar closed loop. Read back out of the moves so
 * it always describes what was cut — re-seamed by a lead or an S-link splice
 * or not.
 */
export function closedContourFromMoves(cutMoves: ToolpathMove[]): Point[] | null {
  if (cutMoves.length < 3) return null
  const z = cutMoves[0].from.z
  for (const move of cutMoves) {
    if (Math.abs(move.from.z - z) > LEAD_EPSILON || Math.abs(move.to.z - z) > LEAD_EPSILON) return null
  }
  const end = cutMoves[cutMoves.length - 1].to
  const seam = cutMoves[0].from
  if (Math.abs(end.x - seam.x) > LEAD_EPSILON || Math.abs(end.y - seam.y) > LEAD_EPSILON) return null
  return cutMoves.map((move) => ({ x: move.from.x, y: move.from.y }))
}

/**
 * Emit the arc that leaves an OPEN wall run — the acute-island cleanup
 * segments. It departs the run's far end along that run's own last direction.
 */
export function emitOpenWallLeadOut(
  moves: ToolpathMove[],
  from: ToolpathPoint | null,
  segment: Point[],
  z: number,
  context: XyLeadContext | undefined,
): ToolpathPoint | null {
  if (!context || from === null || segment.length < 2) return from
  const options = context.options
  const end = segment[segment.length - 1]
  const previous = segment[segment.length - 2]
  const dx = end.x - previous.x
  const dy = end.y - previous.y
  const length = Math.hypot(dx, dy)
  if (!(length > LEAD_EPSILON)) return from
  if (Math.abs(end.x - from.x) > LEAD_EPSILON || Math.abs(end.y - from.y) > LEAD_EPSILON) return from
  const tangent = { x: dx / length, y: dy / length }

  for (const arc of leadArcs(options)) {
    const chordBudget = domainChordBudget(arc.radius, options.arcStepRadians) * LEAD_SAMPLE_REFINEMENT
    for (const side of orderedSides(end, tangent, options)) {
      const points = buildTangentLeadPath(end, tangent, arcShape(side, arc), options.arcStepRadians)
      if (validateLead(end, points, arc.radius, chordBudget, options) === null) continue
      return emitXyLead(moves, from, { points, staging: points[points.length - 1], seam: null },
        z, options, 'lead_out')
    }
  }
  context.onWarning({ code: 'xyLeadNoViablePath' })
  return from
}

/**
 * Plan the arc onto a wall-defining `contour`, or null when there is nothing to
 * lead from or nothing fits.
 *
 * `isFullEntry` is the caller's answer to "is the cutter about to descend onto
 * this contour". A contour reached by an at-depth link is already engaged and
 * needs no lead — the link is the S-link's business, not this module's — so
 * only a full entry is retargeted.
 */
export function planWallLeadIn(
  context: XyLeadContext | undefined,
  contour: Point[],
  isFullEntry: boolean,
  from: Point | null = null,
): XyLeadPlan | null {
  if (!context || !isFullEntry) return null
  const plan = planXyLeadIn(contour, context.options, from)
  if (plan === null) context.onWarning({ code: 'xyLeadNoViablePath' })
  return plan
}

/**
 * Plan the arc onto the start of an OPEN wall run — the acute-island corner
 * cleanup segments, which are polylines rather than loops. There is no seam to
 * slide, so the arrival is fixed at the run's own start and only the arc is
 * searched.
 */
export function planOpenWallLeadIn(
  context: XyLeadContext | undefined,
  segment: Point[],
  isFullEntry: boolean,
): XyLeadPlan | null {
  if (!context || !isFullEntry || segment.length < 2) return null
  const options = context.options
  const start = segment[0]
  const dx = segment[1].x - start.x
  const dy = segment[1].y - start.y
  const length = Math.hypot(dx, dy)
  if (!(length > LEAD_EPSILON)) return null
  const tangent = { x: dx / length, y: dy / length }
  const reversed = { x: -tangent.x, y: -tangent.y }

  for (const arc of leadArcs(options)) {
    const chordBudget = domainChordBudget(arc.radius, options.arcStepRadians) * LEAD_SAMPLE_REFINEMENT
    for (const side of orderedSides(start, tangent, options)) {
      const departing = buildTangentLeadPath(start, reversed, arcShape(-side, arc), options.arcStepRadians)
      if (validateLead(start, departing, arc.radius, chordBudget, options) === null) continue
      const points = [...departing].reverse()
      return { points, staging: points[0], seam: null }
    }
  }
  context.onWarning({ code: 'xyLeadNoViablePath' })
  return null
}

/**
 * The contour as the lead wants it seamed, or unchanged when there is no plan,
 * so a call site can apply it unconditionally.
 */
export function rotateRingForLead(contour: Point[], plan: XyLeadPlan | null): Point[] {
  return plan?.seam ?? contour
}

/**
 * Fractions along each edge at which a lead may join. Zero is the edge's own
 * vertex; the rest let the join slide off a corner, which is the only way a
 * sparse contour (a rectangle is four corners and nothing else) can take a
 * lead at all. The order here is not the candidate order — see
 * `contourArrivals`, which ranks them.
 */
const LEAD_ARRIVAL_FRACTIONS = [0, 0.5, 0.25, 0.75] as const

/**
 * How far either way along the contour counts as "at" a join, as a multiple of
 * tool diameter.
 *
 * A lead's engagement transient is local: what matters is whether the cutter is
 * turning while it takes up the cut, not whether there is a corner somewhere
 * else on the ring. One diameter is the lead's own scale — the widest arc in
 * the ladder and the length budget are both set from it.
 */
const LEAD_CORNER_WINDOW_FACTOR = 1

/**
 * Plan the arc that arrives on `contour` tangent-continuously.
 *
 * Candidate order is radius-major, then sweep, then position along the
 * contour, and the first fully valid candidate wins: the widest arc the domain
 * accepts anywhere on the contour beats a narrower one that happens to fit
 * sooner. A closed contour can be re-seamed at any point at no cost, so arc
 * quality is the thing worth ordering on — and the search never assumes the
 * source contour's first vertex, it only reaches it in the same fixed order as
 * every other position.
 */
export function planXyLeadIn(
  contour: Point[],
  options: XyLeadOptions,
  from: Point | null = null,
): XyLeadPlan | null {
  if (contour.length < 3) return null

  // Ranked once, not once per rung: the order depends on the contour and the
  // tool's position, neither of which changes as the radius ladder descends.
  const arrivals = contourArrivals(contour, options, from)
  for (const arc of leadArcs(options)) {
    const chordBudget = domainChordBudget(arc.radius, options.arcStepRadians) * LEAD_SAMPLE_REFINEMENT
    for (const arrival of arrivals) {
      // Built backwards from the contour and then reversed: the path that
      // leaves along -t is exactly the path that arrives along +t. The turn
      // sign flips with it, so the arc still curves to the free side.
      const reversed = { x: -arrival.tangent.x, y: -arrival.tangent.y }
      for (const side of orderedSides(arrival.point, arrival.tangent, options)) {
        const departing = buildTangentLeadPath(
          arrival.point,
          reversed,
          arcShape(-side, arc),
          options.arcStepRadians,
        )
        if (validateLead(arrival.point, departing, arc.radius, chordBudget, options) === null) continue
        const points = [...departing].reverse()
        return { points, staging: points[0], seam: arrivalSeam(contour, arrival) }
      }
    }
  }
  return null
}

/**
 * Every position a lead may join `contour` at, with its tangent and the
 * contour re-seamed to start there. Vertices first, then along each edge.
 */
interface LeadArrival {
  /** Index of the edge the join sits on, and how far along it. */
  index: number
  fraction: number
  point: Point
  tangent: Point
  /** Turn accumulated within a diameter either way, in tessellation steps. */
  corner: number
  /** Distance from where the cutter is now. */
  travel: number
}

/**
 * The contour re-seamed to start at `arrival`, built only for the candidate
 * that wins. Materialising a seam for every candidate would copy the whole
 * contour once per candidate, which on a tessellated ring is quadratic in
 * points for a value all but one of them throws away.
 */
function arrivalSeam(contour: Point[], arrival: LeadArrival): Point[] {
  const { index, fraction, point } = arrival
  if (fraction === 0) {
    return [...contour.slice(index), ...contour.slice(0, index)]
  }
  // Cut in at `point`, run the rest of the contour, and close over the
  // remainder of this edge — the same material, seamed elsewhere.
  return [point, ...contour.slice(index + 1), ...contour.slice(0, index + 1)]
}

/**
 * "How much does the contour turn near here", as a count of tessellation steps,
 * for any position measured in arc length from `contour[0]`.
 *
 * This is the "is this a corner" measure, and two choices in it are
 * load-bearing.
 *
 * It sums ACCUMULATED turn across a window rather than reading one vertex's
 * angle. A mitred 90 degree corner puts all 90 degrees in a single vertex; a
 * filleted one spreads the same 90 degrees over eighteen 5 degree vertices.
 * Both are corners and must rank alike, which a per-vertex threshold cannot do
 * — it reads the fillet as a smooth run and drops the join in the middle of it.
 *
 * And it is evaluated at the candidate's own position, never inherited from the
 * vertices an edge lies between. The midpoint of a 60 mm edge is 30 mm from
 * either corner, far outside the window, and is exactly the position worth
 * choosing; scoring it by its endpoints would make every candidate on that edge
 * tie with the corners themselves.
 *
 * Quantising to the tessellation step is what lets travel break ties: two
 * positions on one straight run score exactly 0, and every position on a
 * tessellated circle lands in the same bucket, so the choice falls through to
 * the distance the cutter has to travel. Without it the winner would be
 * whichever candidate's window happened to hold one fewer vertex.
 */
function turnScorer(
  contour: Point[],
  options: XyLeadOptions,
): { at: (position: number) => number; edgeStart: number[]; edgeLength: number[] } {
  const count = contour.length
  const edgeLength: number[] = new Array(count)
  const edgeStart: number[] = new Array(count)
  let perimeter = 0
  for (let index = 0; index < count; index += 1) {
    const here = contour[index]
    const next = contour[(index + 1) % count]
    edgeStart[index] = perimeter
    edgeLength[index] = Math.hypot(next.x - here.x, next.y - here.y)
    perimeter += edgeLength[index]
  }

  const turns: number[] = new Array(count)
  for (let index = 0; index < count; index += 1) {
    const previous = contour[(index + count - 1) % count]
    const here = contour[index]
    const next = contour[(index + 1) % count]
    const inX = here.x - previous.x, inY = here.y - previous.y
    const outX = next.x - here.x, outY = next.y - here.y
    const inLength = Math.hypot(inX, inY), outLength = Math.hypot(outX, outY)
    turns[index] = inLength > LEAD_EPSILON && outLength > LEAD_EPSILON
      ? Math.abs(Math.atan2(inX * outY - inY * outX, inX * outX + inY * outY))
      : 0
  }

  const window = options.toolDiameter * LEAD_CORNER_WINDOW_FACTOR
  const step = Math.max(options.arcStepRadians, LEAD_EPSILON)
  const at = (position: number): number => {
    let total = 0
    for (let index = 0; index < count; index += 1) {
      if (turns[index] <= LEAD_EPSILON) continue
      const raw = Math.abs(edgeStart[index] - position)
      // Shorter way round the ring.
      if (Math.min(raw, perimeter - raw) <= window) total += turns[index]
    }
    return Math.round(total / step)
  }
  return { at, edgeStart, edgeLength }
}

/**
 * Every position a lead may join `contour` at, best first.
 *
 * Ranked by corner clearance, then by travel. Corner first because the join is
 * where the cutter takes up the cut and where the exit's overlap re-cuts: at a
 * corner that transient lands on the feature most likely to be a datum or a
 * mating face, on top of the machine's own deceleration, and the arc has to
 * project diagonally to clear two edges at once instead of one. Travel second
 * because among positions that are equally clear of a corner — anywhere along
 * one straight edge, or anywhere at all on a circle — the nearest is free.
 *
 * Ordering by contour index, which is what this did before, means the join
 * lands on `contour[0]`: in open space every candidate is valid, so the first
 * offered wins. On an edge route that vertex is wherever Clipper's offset
 * happened to start, which is routinely a corner.
 *
 * Travel is measured to the JOIN, not to the staging point the rapid actually
 * targets, because staging depends on the radius and side that have not been
 * chosen yet. They sit within about one and a half diameters of each other.
 */
function contourArrivals(
  contour: Point[],
  options: XyLeadOptions,
  from: Point | null,
): LeadArrival[] {
  const { at, edgeStart } = turnScorer(contour, options)
  const arrivals: LeadArrival[] = []
  for (const fraction of LEAD_ARRIVAL_FRACTIONS) {
    for (let index = 0; index < contour.length; index += 1) {
      const start = contour[index]
      const end = contour[(index + 1) % contour.length]
      const dx = end.x - start.x
      const dy = end.y - start.y
      const edge = Math.hypot(dx, dy)
      if (!(edge > LEAD_EPSILON)) continue
      const point = fraction === 0
        ? start
        : { x: start.x + dx * fraction, y: start.y + dy * fraction }
      arrivals.push({
        index,
        fraction,
        point,
        tangent: { x: dx / edge, y: dy / edge },
        corner: at(edgeStart[index] + edge * fraction),
        travel: from ? Math.hypot(point.x - from.x, point.y - from.y) : 0,
      })
    }
  }
  // Index and fraction last so the order is total, and identical inputs always
  // produce an identical program.
  arrivals.sort((left, right) => left.corner - right.corner
    || left.travel - right.travel
    || left.index - right.index
    || left.fraction - right.fraction)
  return arrivals
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
        return { points, staging: points[points.length - 1], seam: null }
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

  // Two domains, switched by distance from the join.
  //
  // At the join the cutter is ON the wall — that is the tangency the lead is
  // for — so the margin cannot apply there. It must apply everywhere else, or
  // the arc is free to swing across a corridor and come to rest against the
  // wall opposite, which is exactly the contact this feature exists to prevent:
  // measured on a pocket whose island wall sits one tool diameter from the
  // pocket wall, both the entry's staging point and the exit's far end landed
  // on the opposite wall, arriving perpendicular to it.
  //
  // The switch distance is where the arc has curved clear of the wall it joins
  // by the margin on its own: for a locally straight wall the gap at arc
  // distance d is about d^2 / 2R, so `sqrt(2 * R * margin)` is the point past
  // which the margin costs nothing. Chord rather than arc length, which is
  // marginally the permissive way round and second-order at these angles.
  const margin = entryBoundarySafety(options.toolDiameter)
  const nearJoin = Math.sqrt(2 * radius * margin)
  const inDomain = (x: number, y: number): boolean =>
    (Math.hypot(x - anchor.x, y - anchor.y) <= nearJoin
      ? options.isInsideDomain(x, y)
      : options.isClearOfWalls(x, y))

  const length = domainSafePathLength(path, chordBudget, inDomain)
  if (length === null || length > options.maxLength) return null
  return length
}
