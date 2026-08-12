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

/**
 * Corner relief — dogbone, T-bone and longest-edge (issue #203).
 *
 * Relief is cut as a **dedicated pass appended after the operation's main
 * path**, stepping down at its own levels. It is deliberately neither a
 * modification of the cleared region nor an inline detour in the wall contour:
 *
 * - Unioning the lobe into the region silently no-ops. Eroding a radius-`r`
 *   lobe by a radius-`r` cutter collapses it to a zero-area point that Clipper
 *   discards, so the emitted path comes out identical to no relief at all.
 * - An inline detour breaks the standard workflow — rough big with radial stock
 *   and relief off, finish small with relief on, because the lobe must be sized
 *   to the tool that defines the final wall. Under that workflow the lobe is
 *   virgin material at full depth when the finish pass arrives, so an inline
 *   excursion is a full-width slot at full pocket depth with a small cutter.
 *
 * A separate stepped pass removes both problems and makes relief independent of
 * what the rough pass did.
 *
 * ## The touch-the-corner rule
 *
 * One rule for both styles: the excursion ends where the cutter *just touches*
 * the corner, and no deeper. For corner `C` with adjacent edge directions `u`
 * and `v` measured from `C`, bisector `b`, cleared-side interior angle `θ` and
 * cutter radius `r`:
 *
 * | style         | excursion ends at                     |
 * | ------------- | ------------------------------------- |
 * | dogbone       | `C + b·r`                             |
 * | t_bone        | `C + u·r` on the chosen edge          |
 * | longest_edge  | t-bone on the longer adjacent edge    |
 *
 * `r` is the exact limit, not a conservative choice: modelling the swept motion
 * against "the whole wedge interior must be cut" at θ = 150°…30° shows ending at
 * `r` clears at every angle while ending at `1.2r` leaves the corner uncut at
 * every angle. Ending short is the failure direction, which is why
 * {@link reliefExcursionEnd} takes the distance as a parameter — the test suite
 * drives it short and asserts the corner is *not* cleared.
 *
 * Ending at touch rather than driving the centre to `C` costs 0.785 r² of virgin
 * material per corner per level instead of 2.787 r², an excursion of
 * `r(1/sin(θ/2) − 1)` instead of `r(1/sin(θ/2))`, and a notch
 * `r(1 − sin(θ/2))` deep past each wall instead of `r`.
 *
 * ## Which corners qualify
 *
 * Every convex corner of the region being cleared — equivalently every concave
 * corner of the kept material. That is one sign test against which side of each
 * loop the cleared material lies on, so this module never learns which
 * operation kind called it: a pocket passes its boundary as cleared-inside and
 * its islands as cleared-outside, and an outside edge route passes the part
 * outline as cleared-outside. Reflex island corners are relieved deliberately
 * (an L-shaped island traps a cutter exactly like a boundary corner); convex
 * island corners are not, because the cutter wraps them.
 */

import type { CornerReliefStyle, Point } from '../../types/project'
import {
  DEFAULT_FLATTEN_ARC_STEP,
  DEFAULT_FLATTEN_CURVE_SAMPLES,
  signedArea,
} from './geometry'
import type { NormalizedTool, ToolpathMove, ToolpathPoint } from './types'
import type { ToolpathWarning } from './warningCodes'

/**
 * Smallest turn at a single vertex that counts as a corner rather than as a
 * tessellation step.
 *
 * Detection runs on the resolved Clipper region, not on the source profile,
 * because what traps a cutter is resolved geometry — including corners produced
 * by booleans and island subtraction. The cost is that arcs are already
 * flattened by then, so the threshold is derived from the sampling constants
 * that did the flattening rather than picked by eye: an arc steps by at most
 * `DEFAULT_FLATTEN_ARC_STEP` per vertex and a curve by at most half a turn over
 * `DEFAULT_FLATTEN_CURVE_SAMPLES` samples. Twice the larger of those leaves a
 * clear margin, and the corners it excludes (interior angle above ~165°) have a
 * notch depth `r(1 − sin(θ/2))` under 0.01 r — nothing to relieve.
 */
export const RELIEF_MIN_CORNER_TURN_RADIANS =
  2 * Math.max(DEFAULT_FLATTEN_ARC_STEP, Math.PI / DEFAULT_FLATTEN_CURVE_SAMPLES)

/**
 * Position tolerance in project length units.
 *
 * Clipper coordinates are integers on a `1 / DEFAULT_CLIPPER_SCALE` grid, so a
 * geometrically exact miter point can sit up to ~1.4e-4 project units away from
 * the vertex the offset actually produced. This is comfortably above that in
 * both mm and inch projects and still far below any real relief dimension.
 */
export const RELIEF_POSITION_TOLERANCE = 1e-3

/** Z comparison slack for "the main path cut at or below this level". */
const RELIEF_Z_TOLERANCE = 1e-6

const UNIT_EPSILON = 1e-12

/** One closed boundary loop of the region an operation clears. */
export interface ReliefLoop {
  points: Point[]
  /**
   * True when the cleared material lies inside this loop (a pocket boundary or
   * an inside edge route), false when it lies outside (a pocket island, or the
   * outline of a part being routed on the outside).
   */
  clearedInside: boolean
}

/** A corner of the cleared region, with everything the styles need. */
export interface CornerGeometry {
  /** `C` — the corner of the region this pass clears. */
  corner: Point
  /** Unit direction from `C` along one adjacent edge. */
  edgeA: Point
  /** Unit direction from `C` along the other adjacent edge. */
  edgeB: Point
  lengthA: number
  lengthB: number
  /** Unit bisector of the cleared-side wedge — always points into it. */
  bisector: Point
  /** Cleared-side interior angle at `C`, radians, always below π. */
  interiorAngle: number
}

export interface ReliefCorner extends CornerGeometry {
  /**
   * `P` — where the pass's own tool-centre path turns this corner. The relief
   * pass descends here because the main path already cut through it, so the
   * whole column is air.
   */
  descend: Point
  /** `E` — where the excursion ends, with the cutter just touching `C`. */
  end: Point
}

export interface CollectReliefCornersOptions {
  style: CornerReliefStyle
  toolRadius: number
  /**
   * Boundary of the region this pass clears — the nominal region eroded by the
   * operation's radial stock-to-leave, so relief is sized to the wall this pass
   * actually leaves behind.
   */
  clearedLoops: ReliefLoop[]
  /**
   * The pass's own tool-centre path around that region: one Clipper offset of
   * the same source region by `toolRadius + radial stock`. Taken from the
   * generator rather than recomputed here so the descend point lands on
   * geometry the operation really emitted — including a miter Clipper truncated
   * at an acute corner, and a corner `roundOutsideCorners` filleted.
   */
  wallLoops: Point[][]
}

export interface CollectReliefCornersResult {
  corners: ReliefCorner[]
  warnings: ToolpathWarning[]
}

interface Segment {
  ax: number
  ay: number
  bx: number
  by: number
}

function subtract(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y }
}

function cross(a: Point, b: Point): number {
  return a.x * b.y - a.y * b.x
}

function dot(a: Point, b: Point): number {
  return a.x * b.x + a.y * b.y
}

function length(a: Point): number {
  return Math.hypot(a.x, a.y)
}

function unit(a: Point): Point | null {
  const len = length(a)
  return len > UNIT_EPSILON ? { x: a.x / len, y: a.y / len } : null
}

function withoutClosingDuplicate(points: Point[]): Point[] {
  if (points.length < 2) return points
  const first = points[0]
  const last = points[points.length - 1]
  return Math.abs(first.x - last.x) < UNIT_EPSILON && Math.abs(first.y - last.y) < UNIT_EPSILON
    ? points.slice(0, -1)
    : points
}

/**
 * Rewrite a loop so the cleared material is always on the left of travel.
 *
 * After this, one test covers every case: the path turning left at a vertex is
 * exactly the cleared-side interior angle being below π, which is exactly the
 * corner that traps a cutter.
 */
function canonicaliseLoop(loop: ReliefLoop): Point[] {
  const points = withoutClosingDuplicate(loop.points)
  if (points.length < 3) return points
  // A CCW loop encloses its interior on the left; a CW loop on the right.
  const clearedOnLeft = loop.clearedInside === (signedArea(points) > 0)
  return clearedOnLeft ? points : [...points].reverse()
}

/**
 * The adjacent edge a T-bone slots into.
 *
 * There is no per-corner selection — regions already cover that — and v6 cut
 * the clearance parameter, so the choice has to be automatic and deterministic.
 * Plain `t_bone` takes the more nearly X-parallel edge, which is the classic
 * "T-bone in X" behaviour and keeps the slot in a predictable face;
 * `longest_edge` takes the longer edge, because a `2r × r` slot does less
 * structural and cosmetic damage on the longer wall. Ties fall through to the
 * same X-parallel rule, then to the edge with the larger components, so the
 * result never depends on which vertex the loop happened to start at.
 */
function chooseTBoneEdge(
  geometry: CornerGeometry,
  style: 't_bone' | 'longest_edge',
): { direction: Point; edgeLength: number; otherLength: number } {
  const a = { direction: geometry.edgeA, edgeLength: geometry.lengthA, otherLength: geometry.lengthB }
  const b = { direction: geometry.edgeB, edgeLength: geometry.lengthB, otherLength: geometry.lengthA }

  if (style === 'longest_edge' && Math.abs(geometry.lengthA - geometry.lengthB) > RELIEF_POSITION_TOLERANCE) {
    return geometry.lengthA > geometry.lengthB ? a : b
  }

  const offAxisA = Math.abs(geometry.edgeA.y)
  const offAxisB = Math.abs(geometry.edgeB.y)
  if (Math.abs(offAxisA - offAxisB) > UNIT_EPSILON) {
    return offAxisA < offAxisB ? a : b
  }
  if (Math.abs(geometry.edgeA.x - geometry.edgeB.x) > UNIT_EPSILON) {
    return geometry.edgeA.x > geometry.edgeB.x ? a : b
  }
  return geometry.edgeA.y >= geometry.edgeB.y ? a : b
}

/**
 * Where the excursion ends, `distance` from the corner.
 *
 * `distance` is the cutter radius in production. It is a parameter because the
 * touch-the-corner rule is only meaningful if ending short can be shown to
 * fail — the test suite drives this past and short of `r` and checks coverage of
 * the wedge either way.
 */
export function reliefExcursionEnd(
  geometry: CornerGeometry,
  style: Exclude<CornerReliefStyle, 'none'>,
  distance: number,
): Point {
  const direction = style === 'dogbone'
    ? geometry.bisector
    : chooseTBoneEdge(geometry, style).direction
  return {
    x: geometry.corner.x + direction.x * distance,
    y: geometry.corner.y + direction.y * distance,
  }
}

/**
 * The relief pass's stepdown, derived from the tool.
 *
 * `operation.stepdown` is deliberately not used: `showStepdown` hides it for
 * edge-route finish operations and `generateFinishBandMoves` ignores it, so on a
 * finish operation it holds a stale value. Driving real cutting depth from a
 * hidden stale field is how you get one giant step straight to full depth —
 * exactly the failure a stepped relief pass exists to remove. `NormalizedTool`
 * already carries both fields, already converted to project units.
 *
 * Returns null when the tool carries no usable stepdown, which fails the relief
 * closed rather than emitting one full-depth slot per corner.
 */
export function resolveReliefStepdown(tool: NormalizedTool): number | null {
  const limited = tool.maxCutDepth > 0
    ? Math.min(tool.defaultStepdown, tool.maxCutDepth)
    : tool.defaultStepdown
  return limited > 0 ? limited : null
}

function buildSegments(loops: Point[][]): Segment[] {
  const segments: Segment[] = []
  for (const loop of loops) {
    const points = withoutClosingDuplicate(loop)
    if (points.length < 2) continue
    for (let index = 0; index < points.length; index += 1) {
      const a = points[index]
      const b = points[(index + 1) % points.length]
      if (Math.abs(a.x - b.x) < UNIT_EPSILON && Math.abs(a.y - b.y) < UNIT_EPSILON) continue
      segments.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y })
    }
  }
  return segments
}

/**
 * March out from the corner along the bisector to the first point where the
 * pass's tool-centre path crosses it.
 *
 * The exact miter at `toolRadius / sin(θ/2)` is the furthest that crossing can
 * ever be — a Clipper-squared corner, a fillet and a round join all pull the
 * path *closer* to the corner — so the search window is one-sided and needs no
 * tuning. A crossing outside it means this corner's wall was never offset the
 * way the caller claimed, and the corner is rejected.
 */
function locateDescendPoint(
  geometry: CornerGeometry,
  segments: Segment[],
  toolRadius: number,
): Point | null {
  const origin = geometry.corner
  const direction = geometry.bisector
  const minT = toolRadius - RELIEF_POSITION_TOLERANCE
  const maxT = toolRadius / Math.sin(geometry.interiorAngle / 2) + RELIEF_POSITION_TOLERANCE

  let bestT = Number.POSITIVE_INFINITY
  for (const segment of segments) {
    const edge = { x: segment.bx - segment.ax, y: segment.by - segment.ay }
    const denominator = cross(direction, edge)
    if (Math.abs(denominator) < UNIT_EPSILON) continue
    const toStart = { x: segment.ax - origin.x, y: segment.ay - origin.y }
    const t = cross(toStart, edge) / denominator
    if (!(t >= minT) || t > maxT || t >= bestT) continue
    const along = cross(toStart, direction) / denominator
    const slack = RELIEF_POSITION_TOLERANCE / Math.max(length(edge), UNIT_EPSILON)
    if (along < -slack || along > 1 + slack) continue
    bestT = t
  }

  if (!Number.isFinite(bestT)) return null
  return { x: origin.x + direction.x * bestT, y: origin.y + direction.y * bestT }
}

function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i]
    const b = polygon[j]
    if (
      (a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside
    }
  }
  return inside
}

function segmentsIntersect(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const d1 = cross(subtract(p4, p3), subtract(p1, p3))
  const d2 = cross(subtract(p4, p3), subtract(p2, p3))
  const d3 = cross(subtract(p2, p1), subtract(p3, p1))
  const d4 = cross(subtract(p2, p1), subtract(p4, p1))
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))
}

/** True when the straight span from `from` to `to` touches any keep-out area. */
function spanHitsKeepOut(from: Point, to: Point, keepOut: Point[][]): boolean {
  for (const polygon of keepOut) {
    if (polygon.length < 3) continue
    if (pointInPolygon(from, polygon) || pointInPolygon(to, polygon)) return true
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
      if (segmentsIntersect(from, to, polygon[j], polygon[i])) return true
    }
  }
  return false
}

function distanceToSegmentXY(point: Point, a: ToolpathPoint, b: ToolpathPoint): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared < UNIT_EPSILON) {
    return Math.hypot(point.x - a.x, point.y - a.y)
  }
  const t = Math.min(1, Math.max(0, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared))
  return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t))
}

/**
 * The one guard: did the main path actually cut here, at or below the deepest
 * relief level?
 *
 * Descending into uncut material is the only way relief hurts anyone, so this is
 * checked against the moves the operation really emitted rather than inferred
 * from its settings. A flat cutter passing through `point` at `maxZ` opens the
 * whole column above it, so this single test is also sufficient — and without
 * naming any of them it catches a pocket finish with `finishWalls` off (the wall
 * contour is never cut), an outside route whose corner falls under a tab (the
 * contour is there but lifted above depth), and trochoidal roughing whose swept
 * channel may not include the contour position at all.
 */
export function mainPathCutsAt(
  moves: ToolpathMove[],
  point: Point,
  maxZ: number,
  tolerance = RELIEF_POSITION_TOLERANCE,
): boolean {
  const zLimit = maxZ + RELIEF_Z_TOLERANCE
  for (const move of moves) {
    if (move.kind !== 'cut' && move.kind !== 'lead_in' && move.kind !== 'lead_out') continue
    if (move.from.z > zLimit || move.to.z > zLimit) continue
    if (distanceToSegmentXY(point, move.from, move.to) <= tolerance) return true
  }
  return false
}

function formatCoordinate(value: number): string {
  return Number(value.toFixed(4)).toString()
}

function cornerParams(corner: Point): Record<string, string> {
  return { x: formatCoordinate(corner.x), y: formatCoordinate(corner.y) }
}

/**
 * Find every corner of the cleared region that qualifies for relief, and place
 * the descend point and excursion end for each.
 *
 * Corners are rejected — with a warning naming the corner and the reason —
 * rather than approximated: a relief that is not where the geometry says it
 * should be is worse than no relief.
 */
export function collectReliefCorners(
  options: CollectReliefCornersOptions,
): CollectReliefCornersResult {
  const { style, toolRadius, clearedLoops, wallLoops } = options
  const corners: ReliefCorner[] = []
  const warnings: ToolpathWarning[] = []
  if (style === 'none' || !(toolRadius > 0)) {
    return { corners, warnings }
  }

  const wallSegments = buildSegments(wallLoops)
  // The widest a notch is along either wall, in every style: a T-bone's slot
  // reaches `r` past the corner along its chosen edge and the cutter adds `r`
  // more. An edge shorter than that is either genuinely too tight to relieve or
  // is not a corner at all. Paired with the turn threshold this is what rejects
  // arc tessellation, which fails both tests.
  const minEdgeLength = toolRadius * 2

  for (const loop of clearedLoops) {
    const points = canonicaliseLoop(loop)
    const count = points.length
    if (count < 3) continue

    for (let index = 0; index < count; index += 1) {
      const corner = points[index]
      const previous = points[(index - 1 + count) % count]
      const next = points[(index + 1) % count]
      const toPrevious = subtract(previous, corner)
      const toNext = subtract(next, corner)
      const edgeA = unit(toPrevious)
      const edgeB = unit(toNext)
      if (!edgeA || !edgeB) continue

      // Turning towards the cleared side is exactly the cleared-side interior
      // angle being below π. `edgeA`/`edgeB` point away from the corner, so the
      // travel directions are `-edgeA` and `edgeB`.
      const turn = Math.atan2(-cross(edgeA, edgeB), -dot(edgeA, edgeB))
      if (!(turn > RELIEF_MIN_CORNER_TURN_RADIANS)) continue

      const bisector = unit({ x: edgeA.x + edgeB.x, y: edgeA.y + edgeB.y })
      if (!bisector) continue

      const geometry: CornerGeometry = {
        corner,
        edgeA,
        edgeB,
        lengthA: length(toPrevious),
        lengthB: length(toNext),
        bisector,
        interiorAngle: Math.PI - turn,
      }

      if (geometry.lengthA < minEdgeLength || geometry.lengthB < minEdgeLength) {
        warnings.push({ code: 'cornerReliefCornerTooTight', params: cornerParams(corner) })
        continue
      }

      const descend = locateDescendPoint(geometry, wallSegments, toolRadius)
      if (!descend) {
        warnings.push({ code: 'cornerReliefNoWallPath', params: cornerParams(corner) })
        continue
      }

      corners.push({
        ...geometry,
        descend,
        end: reliefExcursionEnd(geometry, style, toolRadius),
      })
    }
  }

  return { corners, warnings }
}

export interface ReliefPassOptions {
  corners: ReliefCorner[]
  /** Relief cut levels, descending from just below the top of the cut. */
  levels: number[]
  safeZ: number
  /** The operation's main-path moves, for the descend guard. */
  mainPathMoves: ToolpathMove[]
  /**
   * Areas the tool must not descend into or cross, already grown by the cutter
   * clearance — tab footprints on an edge route. The descend guard reads emitted
   * moves, and edge-route tabs are applied to those moves after generation, so
   * the footprint has to be supplied rather than inferred.
   */
  keepOut?: Point[][]
  /**
   * Feed multiplier for the excursion cuts. Average chip width across the
   * excursion is about `2r` — it is a slotting cut — so it carries the same slot
   * feed scale the operation applies to its other fully engaged moves.
   */
  feedScale?: number
  /** DIAG source tag, set when the operation has debugToolpath enabled. */
  source?: string
}

export interface ReliefPassResult {
  moves: ToolpathMove[]
  warnings: ToolpathWarning[]
  /** Where the tool ends up, or the input position when nothing was emitted. */
  endPosition: ToolpathPoint | null
}

/**
 * Emit the relief pass.
 *
 * Per qualifying corner, descending from the top: descend at `P`, cut out to the
 * excursion end, cut back to `P`, step down, repeat.
 *
 * Descending at `P` rather than plunging at the excursion end is the point.
 * After the wall pass the tool-centre path runs at `r` inside each wall, so the
 * finishing cutter's sweep never crosses the wall lines — only the cleared-side
 * sector of the relief is open, and a plunge at the excursion end would be
 * roughly 75% engaged for a dogbone and 50% for a T-bone. `P` is air at every
 * level, and the lateral move then builds engagement progressively.
 */
export function generateCornerReliefPass(
  currentPosition: ToolpathPoint | null,
  options: ReliefPassOptions,
): ReliefPassResult {
  const { corners, levels, safeZ, mainPathMoves, keepOut = [], feedScale, source } = options
  const moves: ToolpathMove[] = []
  const warnings: ToolpathWarning[] = []
  if (corners.length === 0 || levels.length === 0) {
    return { moves, warnings, endPosition: currentPosition }
  }

  const deepestLevel = levels.reduce((deepest, level) => Math.min(deepest, level), levels[0])
  let position = currentPosition

  for (const corner of orderCornersForTravel(corners, position)) {
    if (!mainPathCutsAt(mainPathMoves, corner.descend, deepestLevel)) {
      warnings.push({ code: 'cornerReliefCornerNotCut', params: cornerParams(corner.corner) })
      continue
    }
    if (keepOut.length > 0 && spanHitsKeepOut(corner.descend, corner.end, keepOut)) {
      warnings.push({ code: 'cornerReliefCornerObstructed', params: cornerParams(corner.corner) })
      continue
    }

    if (position && position.z !== safeZ) {
      const lifted = { x: position.x, y: position.y, z: safeZ }
      moves.push({ kind: 'rapid', from: position, to: lifted, ...(source ? { source } : {}) })
      position = lifted
    }

    // Zero-length when the previous corner sat here; kept anyway, because
    // `optimizeLinearMoves` reads a zero-length rapid as the entry-positioning
    // marker the postprocessor needs (issue #467).
    const above: ToolpathPoint = { x: corner.descend.x, y: corner.descend.y, z: safeZ }
    moves.push({
      kind: 'rapid',
      from: position ?? above,
      to: above,
      ...(source ? { source } : {}),
    })
    position = above

    for (const z of levels) {
      const at: ToolpathPoint = { x: corner.descend.x, y: corner.descend.y, z }
      moves.push({ kind: 'plunge', from: position, to: at, ...(source ? { source } : {}) })
      const out: ToolpathPoint = { x: corner.end.x, y: corner.end.y, z }
      moves.push({
        kind: 'cut',
        from: at,
        to: out,
        ...(feedScale !== undefined ? { feedScale } : {}),
        ...(source ? { source } : {}),
      })
      moves.push({
        kind: 'cut',
        from: out,
        to: at,
        ...(feedScale !== undefined ? { feedScale } : {}),
        ...(source ? { source } : {}),
      })
      position = at
    }

    moves.push({ kind: 'rapid', from: position, to: above, ...(source ? { source } : {}) })
    position = above
  }

  return { moves, warnings, endPosition: position }
}

function orderCornersForTravel(corners: ReliefCorner[], start: ToolpathPoint | null): ReliefCorner[] {
  if (corners.length <= 1) return corners
  const remaining = [...corners]
  const ordered: ReliefCorner[] = []
  let from = start ? { x: start.x, y: start.y } : remaining[0].descend

  while (remaining.length > 0) {
    let bestIndex = 0
    let bestDistance = Number.POSITIVE_INFINITY
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index].descend
      const distance = (candidate.x - from.x) ** 2 + (candidate.y - from.y) ** 2
      if (distance < bestDistance) {
        bestDistance = distance
        bestIndex = index
      }
    }
    const [next] = remaining.splice(bestIndex, 1)
    ordered.push(next)
    from = next.descend
  }

  return ordered
}
