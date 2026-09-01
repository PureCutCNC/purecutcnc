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

// XY lead-in / lead-out for clearing entries (issue #695).
//
// The Z-entry strategies (#412) answer "how does the cutter get DOWN"; they all
// arrive at final depth on the first ring vertex the generator happened to
// emit, which is an arbitrary corner approached from an arbitrary direction.
// This module answers the other half: WHERE at final depth the descent lands,
// and how the cutter reaches the ring from there.
//
// The lead is the ring-to-ring S of #545 turned around. A lead-OUT departs the
// finished ring along its own travel tangent, arcs away, optionally runs
// straight, and arcs back parallel — ending on a staging point the retract can
// happen from. A lead-IN is the same construction run from a candidate ring
// vertex along the REVERSED ring tangent and then reversed, so it arrives on
// the ring tangent-continuously; its far end is the staging point handed to
// plunge/helix/ramp synthesis as the descent target. One shape, one validator,
// mirrored — an exit that disagreed with its entry would be a second geometry
// to keep sound.
//
// A candidate survives only if every tessellated vertex AND every interpolated
// sample between vertices lies inside the exact tool-centre-safe domain, the
// path fits the S-link length budget on the S-link floor radius, and the lead
// is a real non-zero displacement. Nothing qualifying means no lead at all:
// the generator emits its ordinary direct final-depth entry or retract, keeps
// the ring order it intended, and the caller reports a structured warning.

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
 * Turn angles tried for each lead arc, largest first, degrees.
 *
 * Largest first because a wider turn puts the staging point further off the
 * ring, which is the whole point of the feature: the descent wants room that
 * the ring's own corner does not have. The list stops at 30 deg — below that
 * the staging point is barely off the ring and the lead stops earning the
 * extra motion.
 */
const LEAD_TURN_DEGREES = [90, 60, 45, 30] as const

/** Straight middle run, as multiples of the floor radius; longest first. */
const LEAD_STRAIGHT_FACTORS = [1, 0] as const

/** Which way the lead turns off the ring. Both are tried; the domain decides. */
const LEAD_TURN_SIDES = [1, -1] as const

/**
 * How far past the ring's seam the exit lead may start looking for a departure,
 * as multiples of the floor radius. Zero first — the cheapest exit is the one
 * that leaves the moment the ring closes.
 *
 * A closed ring ends where it began, and a ring seamed at a corner arrives at
 * that corner pointing STRAIGHT AT the wall it was cutting: no tangent-
 * continuous departure exists there at any radius, because the first
 * infinitesimal step already leaves the domain. Every rectangular pocket seams
 * at a corner, so a zero-overlap-only exit would fall back on the commonest
 * shape there is. Continuing a little way along the ring the cutter has just
 * cut costs motion through its own kerf and nothing else, and it is what gives
 * the exit the same freedom to choose its ring position that the entry has.
 */
const LEAD_OVERLAP_FACTORS = [0, 1, 2, 4] as const

/**
 * A lead must move the staging point at least this far off the ring, as a
 * fraction of the floor radius. Without it a degenerate shape that returns to
 * within float dust of its ring vertex would count as a lead and the descent
 * would land back on the ring it was supposed to stage away from.
 */
const MIN_LEAD_OFFSET_FRACTION = 0.5

export interface XyLeadOptions {
  /** Floor radius for both lead arcs — the S-link's, so the two agree. */
  minRadius: number
  /** Total path length budget for one lead, project units. */
  maxLength: number
  /** Angular tessellation step for the lead arcs, radians. */
  arcStepRadians: number
  /** Operation cut feed, for the lead's feed ramp. */
  cutFeed: number
  /** Operation plunge feed, for the lead's constrained initial feed. */
  plungeFeed: number
  /** True when a tool-centre position lies inside the cleared domain. */
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
 * Lead options for one clearing pass, or undefined when the operation has not
 * opted in. Undefined is byte-identical legacy output — a missing or `'none'`
 * `xyLeadStrategy` never reaches the planner at all.
 *
 * The geometry budget is the S-link's (`pocketTangentLinkOptions`) on purpose:
 * a lead and a ring-to-ring link are the same curve in the same domain, and two
 * separately tuned budgets would drift into disagreeing about what fits.
 */
export function xyLeadOptions(
  operation: Operation,
  toolDiameter: number,
  domainRegions: TangentLinkDomainRegion[],
): XyLeadOptions | undefined {
  if (operation.xyLeadStrategy !== 'tangent_s') return undefined
  if (!supportsXyLead(operation)) return undefined
  if (!(toolDiameter > 0) || domainRegions.length === 0) return undefined
  return {
    minRadius: toolDiameter * 0.25,
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
  if (operation.xyLeadStrategy !== 'tangent_s') return true
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
 * Plan the lead that arrives on `ring` tangent-continuously.
 *
 * Candidate order is shape-major, vertex-minor, and the first fully valid
 * candidate wins: the widest lead the domain accepts anywhere on the ring beats
 * a narrower one that happens to fit at a lower vertex index. A closed ring can
 * be re-seamed at any vertex at no cost, so lead quality is the thing worth
 * ordering on — and the search never assumes the source contour's first vertex,
 * it only reaches it in the same fixed order as every other vertex.
 */
export function planXyLeadIn(ring: Point[], options: XyLeadOptions): XyLeadPlan | null {
  if (ring.length < 3) return null
  const chordBudget = domainChordBudget(options.minRadius, options.arcStepRadians)

  for (const shape of leadShapes(options)) {
    for (let index = 0; index < ring.length; index += 1) {
      const anchor = ring[index]
      const forward = ringTangent(ring, index)
      if (forward === null) continue
      // Built backwards from the ring, then reversed: the path that leaves the
      // ring along -t is exactly the path that arrives along +t.
      const departing = buildTangentLeadPath(
        anchor,
        { x: -forward.x, y: -forward.y },
        shape,
        options.arcStepRadians,
      )
      const validated = validateLead(anchor, departing, chordBudget, options)
      if (validated === null) continue
      const points = [...departing].reverse()
      return { points, staging: points[0], arrivalIndex: index }
    }
  }
  return null
}

/**
 * Plan the lead that leaves `ring` — the last ring emitted at this level, in
 * emission order, so `ring[0]` is where its cut ended.
 *
 * Same shapes, same order, same validator as the entry. The one addition is the
 * overlap: the departure point may sit a short way along the ring past its
 * seam, which is the exit's counterpart to the entry's freedom to pick which
 * vertex it arrives on. Smallest overlap first, so a clean departure at the
 * seam always wins over one that re-traverses.
 */
export function planXyLeadOut(ring: Point[], options: XyLeadOptions): XyLeadPlan | null {
  if (ring.length < 3) return null
  const chordBudget = domainChordBudget(options.minRadius, options.arcStepRadians)

  for (const factor of LEAD_OVERLAP_FACTORS) {
    const departure = ringDeparture(ring, factor * options.minRadius)
    if (departure === null) continue
    for (const shape of leadShapes(options)) {
      const lead = buildTangentLeadPath(
        departure.point,
        departure.tangent,
        shape,
        options.arcStepRadians,
      )
      const points = [...departure.overlap, ...lead.slice(1)]
      if (validateLead(departure.point, points, chordBudget, options) === null) continue
      return { points, staging: points[points.length - 1], arrivalIndex: 0 }
    }
  }
  return null
}

/**
 * Where a lead-out departs after running `distance` along `ring` from its seam,
 * with the tangent it arrives on and the overlap polyline that gets it there.
 *
 * At distance zero that tangent is the ring's CLOSING chord — the direction the
 * cutter is actually travelling as the ring shuts — not the first edge's, which
 * is where it would be going next.
 */
function ringDeparture(
  ring: Point[],
  distance: number,
): { point: Point; tangent: Point; overlap: Point[] } | null {
  const seam = ring[0]
  if (!(distance > LEAD_EPSILON)) {
    const closing = ring[ring.length - 1]
    const dx = seam.x - closing.x
    const dy = seam.y - closing.y
    const length = Math.hypot(dx, dy)
    if (!(length > LEAD_EPSILON)) return null
    return { point: seam, tangent: { x: dx / length, y: dy / length }, overlap: [seam] }
  }

  const overlap: Point[] = [seam]
  let travelled = 0
  for (let step = 0; step < ring.length; step += 1) {
    const from = ring[step]
    const to = ring[(step + 1) % ring.length]
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
 * Feed ramps linearly across the lead between the constrained initial feed —
 * `min(plungeFeed / feed, 1)`, the same ceiling a vertical entry move already
 * respects — and full cut feed, rising on the way in and falling on the way
 * out. The ramp is sampled at segment midpoints so a one-segment lead lands on
 * the middle of the ramp instead of on whichever end the indexing happened to
 * favour. Vertical motion is not this module's: the descent stays `plunge` at
 * plunge feed.
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
  const initialScale = leadInitialFeedScale(options)
  let current: ToolpathPoint = from
  for (let index = 0; index < segments; index += 1) {
    const ratio = (index + 0.5) / segments
    const rising = kind === 'lead_in' ? ratio : 1 - ratio
    const scale = initialScale + (1 - initialScale) * rising
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

/** The feed ceiling a lead starts from (entry) or falls back to (exit). */
export function leadInitialFeedScale(options: XyLeadOptions): number {
  if (!(options.cutFeed > 0) || !(options.plungeFeed > 0)) return 1
  return Math.min(1, options.plungeFeed / options.cutFeed)
}

/**
 * The lead shape family, in candidate order: widest turn first, longest
 * straight first, then the turn side. One radius pinned to the S-link floor,
 * exactly as the ring-to-ring solver pins one of its two; the second arc
 * mirrors the first so the lead leaves parallel to the ring tangent and the
 * staging direction is a real direction rather than an artefact of the turn.
 */
function* leadShapes(options: XyLeadOptions): Generator<TangentLeadShape> {
  const radius = options.minRadius
  if (!(radius > LEAD_EPSILON)) return
  for (const degrees of LEAD_TURN_DEGREES) {
    const turn = (degrees * Math.PI) / 180
    for (const factor of LEAD_STRAIGHT_FACTORS) {
      for (const side of LEAD_TURN_SIDES) {
        yield {
          turn1: side * turn,
          radius1: side * radius,
          straight: factor * radius,
          turn2: -side * turn,
          radius2: -side * radius,
        }
      }
    }
  }
}

/** Ring travel tangent leaving vertex `index`, or null on a degenerate edge. */
function ringTangent(ring: Point[], index: number): Point | null {
  const from = ring[index]
  const to = ring[(index + 1) % ring.length]
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy)
  if (!(length > LEAD_EPSILON)) return null
  return { x: dx / length, y: dy / length }
}

/**
 * Accept a candidate only when it is a real lead that stays sound end to end:
 * inside the tool-centre-safe domain at every vertex and every sample between
 * them, inside the length budget, and far enough off the ring to be worth
 * emitting. Returns the path length, or null to reject the candidate whole.
 */
function validateLead(
  anchor: Point,
  path: Point[],
  chordBudget: number,
  options: XyLeadOptions,
): number | null {
  if (path.length < 2) return null
  const far = path[path.length - 1]
  const offset = Math.hypot(far.x - anchor.x, far.y - anchor.y)
  if (!(offset > options.minRadius * MIN_LEAD_OFFSET_FRACTION)) return null
  const length = domainSafePathLength(path, chordBudget, options.isInsideDomain)
  if (length === null || length > options.maxLength) return null
  return length
}
