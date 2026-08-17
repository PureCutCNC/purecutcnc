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
// `planContourSmoothing` is the pure contour-level turn planner: it analyzes
// the whole closed ring first and produces the rounded contour plus metadata
// describing every changed turn. `roundContourCorners` is the compatibility
// wrapper that returns only the points. It is a pure emit-time transform on
// the ring the tool follows: callers keep computing successive insets from the
// exact, unsmoothed region so nothing drifts, and the wall-defining passes are
// never routed through here.
//
// The planner works in five stages:
//
//  1. Analyze each vertex for its signed turn, degenerate (zero-length) edges
//     and straight-through (collinear) vertices.
//  2. Group consecutive same-sign turning vertices into one geometric turn
//     run, extending greedily while the run stays valid: the accumulated turn
//     must match the turn between the run's entry/exit shoulder lines, the
//     virtual apex of those lines must sit on the corner side of the run (not
//     behind a shoulder), and the tangent points must not fall beyond the
//     run's endpoints.
//  3. Guard genuinely smooth runs: when the run's vertices track a fitted
//     circle whose radius is already at least the request, the source vertices
//     are emitted unchanged, so a large source arc is never flattened or
//     tightened merely because its accumulated turn exceeds the threshold.
//  4. Allocate straight-edge setback at contour scope. An isolated corner may
//     consume (nearly) a whole adjacent edge; when two transitions compete for
//     one edge their setbacks scale proportionally, always leaving a small
//     epsilon connector.
//  5. Emit each transition as a circular arc tangent to its entry and exit
//     shoulders, tessellated with the shared arc-step contract, then fail
//     closed to the unchanged source geometry if the planned contour
//     self-intersects or any coordinate stops being finite.

import type { Point } from '../../types/project'
import { DEFAULT_FLATTEN_ARC_STEP } from './geometry'

export interface RoundContourOptions {
  /** Only round turns whose accumulated deflection (0 = straight, 180 = full
   *  reversal) exceeds this. Gentle turns are left as-is. */
  minDeflectionDeg?: number
  /** Angular tessellation step for the fillet arcs, in radians. */
  arcStepRadians?: number
}

/** One changed turn on the smoothed contour. */
export interface ContourTurnTransition {
  /** Cyclic source index of the first vertex of the changed turn run. */
  firstIndex: number
  /** Cyclic source index of the last vertex of the changed turn run. */
  lastIndex: number
  /** Source indices of every vertex in the run, in contour order. */
  runIndices: number[]
  /** Accumulated signed turn of the run, radians, in (-π, π]. The sign is the
   *  heading rotation of the path at the run (atan2 convention: positive is
   *  counterclockwise in standard math orientation). */
  signedTurn: number
  /** The radius the transition was requested with. */
  requestedRadius: number
  /** The radius actually emitted, never larger than the request. */
  effectiveRadius: number
  /** Tangent point where the transition leaves the incoming shoulder edge. */
  entry: Point
  /** Tangent point where the transition rejoins the outgoing shoulder edge. */
  exit: Point
  /** Emitted transition points in order, entry first and exit last. */
  transitionPoints: Point[]
  /** Source edge index (the edge from firstIndex-1 to firstIndex, cyclic) the
   *  entry setback is taken from. */
  entryEdgeIndex: number
  /** Source edge index (the edge from lastIndex to lastIndex+1, cyclic) the
   *  exit setback is taken from. */
  exitEdgeIndex: number
}

/** Result of the pure contour-level turn planner. */
export interface ContourSmoothingPlan {
  /** The normalized source ring (distinct vertices, no duplicated closing
   *  point). All indices in `transitions` refer to this array, cyclically. */
  sourcePoints: Point[]
  /** The final emitted contour (same cyclic order, no duplicated closing
   *  point). When nothing changed this is the source ring itself. */
  points: Point[]
  /** The radius the plan was computed for (as passed in). */
  requestedRadius: number
  /** One entry per changed turn, in source cyclic order. */
  transitions: ContourTurnTransition[]
}

const DEFAULT_MIN_DEFLECTION_DEG = 20
const EPS = 1e-9
/** Below this magnitude of signed turn a vertex is treated as collinear. */
const STRAIGHT_TURN_EPS = 1e-6
/** Allowed mismatch between a run's accumulated turn and its shoulder turn. */
const TURN_CONSISTENCY_EPS = 1e-6
/** Fraction of each edge always reserved as a straight connector. */
const CONNECTOR_FRACTION = 1e-6
/** Max relative deviation of a run's vertices from its fitted circle before
 *  the run stops counting as genuinely smooth. */
const SMOOTH_DEV_TOL = 0.05

interface Vec {
  x: number
  y: number
}

/** Per-vertex analysis of the source ring. */
interface VertexInfo {
  point: Point
  /** True when an adjacent edge is zero-length; never part of a turn run. */
  degenerate: boolean
  /** True when the vertex is effectively collinear; breaks turn runs. */
  straight: boolean
  /** Signed turn at the vertex, radians, in (-π, π]. */
  signedTurn: number
  /** Unit direction from the vertex toward its previous neighbour. */
  uPrev: Vec | null
  /** Unit direction from the vertex toward its next neighbour. */
  uNext: Vec | null
  prevLen: number
  nextLen: number
}

/** Validated geometric description of one candidate turn run. */
interface RunGeometry {
  start: number
  end: number
  signedTurn: number
  tanHalf: number
  sinHalf: number
  /** Apex coordinate along uPrev measured from the run start vertex (<= 0). */
  apexIn: number
  /** Apex coordinate along uNext measured from the run end vertex (<= 0). */
  apexOut: number
  /** Distance of the apex beyond the run start, along the incoming shoulder. */
  dIn: number
  /** Distance of the apex beyond the run end, along the outgoing shoulder. */
  dOut: number
  /** Desired distance from the apex to each tangent point (<= request). */
  sDesired: number
}

/** A transition with its allocated setbacks and emitted arc. */
interface PlannedTransition {
  run: RunGeometry
  start: number
  end: number
  tIn: number
  tOut: number
  radius: number
  entry: Point
  exit: Point
  points: Point[]
}

function normalizeSignedAngle(angle: number): number {
  let value = angle
  while (value > Math.PI) value -= 2 * Math.PI
  while (value <= -Math.PI) value += 2 * Math.PI
  return value
}

function isFinitePoint(point: Point): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y)
}

function cross(a: Vec, b: Vec): number {
  return a.x * b.y - a.y * b.x
}

function det3(
  a11: number, a12: number, a13: number,
  a21: number, a22: number, a23: number,
  a31: number, a32: number, a33: number,
): number {
  return (
    a11 * (a22 * a33 - a23 * a32)
    - a12 * (a21 * a33 - a23 * a31)
    + a13 * (a21 * a32 - a22 * a31)
  )
}

/** Least-squares (Kasa) circle fit; null when degenerate. */
function fitCircleKasa(points: Point[]): { cx: number; cy: number; radius: number } | null {
  let sx = 0
  let sy = 0
  let sz = 0
  let sxx = 0
  let syy = 0
  let sxy = 0
  let szx = 0
  let szy = 0
  for (const point of points) {
    const { x, y } = point
    const z = x * x + y * y
    sx += x
    sy += y
    sz += z
    sxx += x * x
    syy += y * y
    sxy += x * y
    szx += z * x
    szy += z * y
  }
  const count = points.length
  const detA = det3(sxx, sxy, sx, sxy, syy, sy, sx, sy, count)
  if (Math.abs(detA) <= EPS || !Number.isFinite(detA)) return null
  const d = det3(-szx, sxy, sx, -szy, syy, sy, -sz, sy, count) / detA
  const e = det3(sxx, -szx, sx, sxy, -szy, sy, sx, -sz, count) / detA
  const f = det3(sxx, sxy, -szx, sxy, syy, -szy, sx, sy, -sz) / detA
  const cx = -d / 2
  const cy = -e / 2
  const radiusSq = (d * d + e * e) / 4 - f
  if (!(radiusSq > 0) || !Number.isFinite(radiusSq)) return null
  return { cx, cy, radius: Math.sqrt(radiusSq) }
}

function analyzeRing(ring: Point[]): VertexInfo[] {
  const count = ring.length
  return ring.map((point, index) => {
    const previous = ring[(index + count - 1) % count]
    const next = ring[(index + 1) % count]
    const toPrev = { x: previous.x - point.x, y: previous.y - point.y }
    const toNext = { x: next.x - point.x, y: next.y - point.y }
    const prevLen = Math.hypot(toPrev.x, toPrev.y)
    const nextLen = Math.hypot(toNext.x, toNext.y)
    if (prevLen <= EPS || nextLen <= EPS) {
      return {
        point,
        degenerate: true,
        straight: true,
        signedTurn: 0,
        uPrev: null,
        uNext: null,
        prevLen,
        nextLen,
      }
    }
    const uPrev = { x: toPrev.x / prevLen, y: toPrev.y / prevLen }
    const uNext = { x: toNext.x / nextLen, y: toNext.y / nextLen }
    const signedTurn = normalizeSignedAngle(
      Math.atan2(uNext.y, uNext.x) - Math.atan2(uPrev.y, uPrev.x) - Math.PI,
    )
    return {
      point,
      degenerate: false,
      straight: Math.abs(signedTurn) < STRAIGHT_TURN_EPS,
      signedTurn,
      uPrev,
      uNext,
      prevLen,
      nextLen,
    }
  })
}

/**
 * Build the geometric description of the run infos[start..end] and validate it:
 * shoulder-turn consistency, a convex virtual apex (not behind either
 * shoulder), and tangent points that do not fall beyond the run endpoints.
 * Returns null when the run is not a usable corner.
 */
function buildRun(
  infos: VertexInfo[],
  start: number,
  end: number,
  request: number,
): RunGeometry | null {
  const uPrev = infos[start].uPrev
  const uNext = infos[end].uNext
  if (!uPrev || !uNext) return null
  let signedTurn = 0
  for (let index = start; index <= end; index += 1) {
    signedTurn += infos[index].signedTurn
  }
  const shoulderTurn = normalizeSignedAngle(
    Math.atan2(uNext.y, uNext.x) - Math.atan2(uPrev.y, uPrev.x) - Math.PI,
  )
  if (Math.abs(signedTurn - shoulderTurn) > TURN_CONSISTENCY_EPS) {
    return null
  }
  const dot = Math.max(-1, Math.min(1, uPrev.x * uNext.x + uPrev.y * uNext.y))
  const interior = Math.acos(dot)
  const tanHalf = Math.tan(interior / 2)
  if (!(tanHalf > EPS) || !Number.isFinite(tanHalf)) return null
  const denom = cross(uPrev, uNext)
  if (Math.abs(denom) <= EPS) return null
  const w = {
    x: infos[end].point.x - infos[start].point.x,
    y: infos[end].point.y - infos[start].point.y,
  }
  const apexIn = cross(w, uNext) / denom
  const apexOut = cross(w, uPrev) / denom
  // A convex corner has its virtual apex on the far side of the run; an apex
  // behind a shoulder would send the tangent points backward.
  if (apexIn > EPS || apexOut > EPS || !Number.isFinite(apexIn) || !Number.isFinite(apexOut)) {
    return null
  }
  const dIn = -apexIn
  const dOut = -apexOut
  // Tangent distance from the apex, capped at the request so an acute corner
  // never retreats farther than the radius (the leftover-crescent bound).
  const sDesired = Math.min(request / tanHalf, request)
  if (sDesired < dIn - EPS || sDesired < dOut - EPS) return null
  return {
    start,
    end,
    signedTurn,
    tanHalf,
    sinHalf: Math.sin(interior / 2),
    apexIn,
    apexOut,
    dIn,
    dOut,
    sDesired,
  }
}

/** Local circle fit over the run's vertices; null for runs shorter than 3. */
function fitLocalCircle(infos: VertexInfo[], start: number, end: number): {
  radius: number
  smooth: boolean
} | null {
  if (end - start < 2) return null
  const points: Point[] = []
  for (let index = start; index <= end; index += 1) {
    points.push(infos[index].point)
  }
  const fit = fitCircleKasa(points)
  if (!fit) return null
  let maxDev = 0
  for (const point of points) {
    const dist = Math.hypot(point.x - fit.cx, point.y - fit.cy)
    maxDev = Math.max(maxDev, Math.abs(dist - fit.radius) / fit.radius)
  }
  return { radius: fit.radius, smooth: maxDev <= SMOOTH_DEV_TOL }
}

/** Group the ring into validated corner runs (indices into `infos`). */
function findTurnRuns(
  infos: VertexInfo[],
  request: number,
  minDeflection: number,
): RunGeometry[] {
  const count = infos.length
  const runs: RunGeometry[] = []
  let index = 0
  while (index < count) {
    const info = infos[index]
    if (info.degenerate || info.straight) {
      index += 1
      continue
    }
    let run = buildRun(infos, index, index, request)
    if (!run) {
      // A lone unusable vertex stays as-is.
      index += 1
      continue
    }
    let end = index
    while (end + 1 < count) {
      const next = infos[end + 1]
      if (next.degenerate || next.straight) break
      if (Math.sign(next.signedTurn) !== Math.sign(info.signedTurn)) break
      const extended = buildRun(infos, index, end + 1, request)
      if (!extended) break
      end += 1
      run = extended
    }
    if (Math.abs(run.signedTurn) < minDeflection) {
      index = end + 1
      continue
    }
    const local = fitLocalCircle(infos, index, end)
    if (local && local.smooth && local.radius >= request) {
      // The source already follows a circle at least as broad as the request;
      // leave the run's vertices untouched.
      index = end + 1
      continue
    }
    runs.push(run)
    index = end + 1
  }
  return runs
}

/**
 * True when segments [a, b] and [c, d] share an interior point (a proper
 * crossing or a collinear overlap; endpoint-only contact does not count).
 */
function segmentsProperlyIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const orientation = (p: Point, q: Point, r: Point): number =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  const strictlyInside = (p: Point, q: Point, r: Point): boolean => {
    if (Math.abs(q.x - p.x) >= Math.abs(q.y - p.y)) {
      const min = Math.min(p.x, q.x)
      const max = Math.max(p.x, q.x)
      return r.x > min && r.x < max
    }
    const min = Math.min(p.y, q.y)
    const max = Math.max(p.y, q.y)
    return r.y > min && r.y < max
  }
  const d1 = orientation(c, d, a)
  const d2 = orientation(c, d, b)
  const d3 = orientation(a, b, c)
  const d4 = orientation(a, b, d)
  if (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0))
    && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  ) {
    return true
  }
  if (d1 === 0 && strictlyInside(c, d, a)) return true
  if (d2 === 0 && strictlyInside(c, d, b)) return true
  if (d3 === 0 && strictlyInside(a, b, c)) return true
  if (d4 === 0 && strictlyInside(a, b, d)) return true
  return false
}

/** True when any newly emitted segment properly crosses any other segment. */
function plannedContourSelfIntersects(
  out: Point[],
  transitions: PlannedTransition[],
): boolean {
  if (transitions.length === 0) return false
  const count = out.length
  const newSegments = new Set<number>()
  let position = 0
  for (const transition of transitions) {
    const entryIndex = position
    for (let offset = entryIndex - 1; offset <= entryIndex + transition.points.length - 1; offset += 1) {
      newSegments.add(((offset % count) + count) % count)
    }
    position += transition.points.length
  }
  for (const segment of newSegments) {
    const a = out[segment]
    const b = out[(segment + 1) % count]
    for (let other = 0; other < count; other += 1) {
      if (other === segment) continue
      if ((other + 1) % count === segment || (segment + 1) % count === other) continue
      if (segmentsProperlyIntersect(a, b, out[other], out[(other + 1) % count])) {
        return true
      }
    }
  }
  return false
}

/**
 * Plan the corner smoothing of one closed contour.
 *
 * `points` is a closed ring given as distinct vertices with no duplicated
 * closing point (the shape `buildContourLoops` produces). A non-positive
 * `radius`, a degenerate ring (< 3 points), or corners too shallow to matter
 * return the input vertices unchanged, so passing no radius is a no-op. On any
 * validation failure the plan fails closed to the unchanged source geometry.
 */
export function planContourSmoothing(
  points: Point[],
  radius: number,
  options: RoundContourOptions = {},
): ContourSmoothingPlan {
  const identity: ContourSmoothingPlan = {
    sourcePoints: points,
    points,
    requestedRadius: radius,
    transitions: [],
  }
  if (!(radius > 0) || points.length < 3) return identity
  for (const point of points) {
    if (!isFinitePoint(point)) return identity
  }

  // Work on a clean cyclic ring: drop a duplicated closing vertex if present so
  // the seam corner is rounded like any other (Clipper output has none, but
  // contours from other sources may).
  const first = points[0]
  const last = points[points.length - 1]
  const ring = Math.abs(first.x - last.x) <= EPS && Math.abs(first.y - last.y) <= EPS
    ? points.slice(0, -1)
    : points
  if (ring.length < 3) return identity

  const minDeflection = ((options.minDeflectionDeg ?? DEFAULT_MIN_DEFLECTION_DEG) * Math.PI) / 180
  const arcStep = Math.max(options.arcStepRadians ?? DEFAULT_FLATTEN_ARC_STEP, 1e-3)
  const infos = analyzeRing(ring)
  const runs = findTurnRuns(infos, radius, minDeflection)
  if (runs.length === 0) {
    return { sourcePoints: ring, points: ring, requestedRadius: radius, transitions: [] }
  }

  // Contour-scope setback allocation. Each source edge can be consumed from
  // its start (a run's exit setback) and/or its end (a run's entry setback).
  const count = ring.length
  const edgeConsumers: Array<Array<{ run: number; side: 'in' | 'out'; tDes: number }>> =
    Array.from({ length: count }, () => [])
  runs.forEach((run, runIndex) => {
    const entryEdge = (run.start - 1 + count) % count
    const exitEdge = run.end % count
    edgeConsumers[entryEdge].push({ run: runIndex, side: 'in', tDes: run.sDesired - run.dIn })
    edgeConsumers[exitEdge].push({ run: runIndex, side: 'out', tDes: run.sDesired - run.dOut })
  })
  const allocated: Array<{ tIn: number; tOut: number }> = runs.map(() => ({ tIn: 0, tOut: 0 }))
  for (let edge = 0; edge < count; edge += 1) {
    const consumers = edgeConsumers[edge]
    if (consumers.length === 0) continue
    const next = ring[(edge + 1) % count]
    const edgeLen = Math.hypot(next.x - ring[edge].x, next.y - ring[edge].y)
    const available = edgeLen * (1 - CONNECTOR_FRACTION)
    const sum = consumers.reduce((acc, consumer) => acc + consumer.tDes, 0)
    const factor = sum > available ? available / sum : 1
    for (const consumer of consumers) {
      const value = consumer.tDes * factor
      if (consumer.side === 'in') allocated[consumer.run].tIn = value
      else allocated[consumer.run].tOut = value
    }
  }

  // Emit the tangent arc for every run whose transition survives.
  const transitions: PlannedTransition[] = []
  runs.forEach((run, runIndex) => {
    const s = Math.min(allocated[runIndex].tIn + run.dIn, allocated[runIndex].tOut + run.dOut)
    const effectiveRadius = s * run.tanHalf
    if (!(effectiveRadius > EPS) || !Number.isFinite(effectiveRadius)) return
    const uPrev = infos[run.start].uPrev
    const uNext = infos[run.end].uNext
    if (!uPrev || !uNext) return
    if (!(run.sinHalf > EPS)) return
    const tIn = s - run.dIn
    const tOut = s - run.dOut
    const entry = {
      x: ring[run.start].x + uPrev.x * tIn,
      y: ring[run.start].y + uPrev.y * tIn,
    }
    const exit = {
      x: ring[run.end].x + uNext.x * tOut,
      y: ring[run.end].y + uNext.y * tOut,
    }
    let bisector: Vec = { x: uPrev.x + uNext.x, y: uPrev.y + uNext.y }
    const bisectorLen = Math.hypot(bisector.x, bisector.y)
    if (bisectorLen <= EPS) return
    bisector = { x: bisector.x / bisectorLen, y: bisector.y / bisectorLen }
    const apex = {
      x: ring[run.start].x + run.apexIn * uPrev.x,
      y: ring[run.start].y + run.apexIn * uPrev.y,
    }
    const center = {
      x: apex.x + bisector.x * (effectiveRadius / run.sinHalf),
      y: apex.y + bisector.y * (effectiveRadius / run.sinHalf),
    }
    const startAngle = Math.atan2(entry.y - center.y, entry.x - center.x)
    const endAngle = Math.atan2(exit.y - center.y, exit.x - center.x)
    const sweep = normalizeSignedAngle(endAngle - startAngle)
    const steps = Math.max(1, Math.ceil(Math.abs(sweep) / arcStep))
    const arcPoints: Point[] = [entry]
    for (let step = 1; step < steps; step += 1) {
      const angle = startAngle + (sweep * step) / steps
      arcPoints.push({
        x: center.x + effectiveRadius * Math.cos(angle),
        y: center.y + effectiveRadius * Math.sin(angle),
      })
    }
    arcPoints.push(exit)
    if (!arcPoints.every(isFinitePoint)) return
    transitions.push({
      run,
      start: run.start,
      end: run.end,
      tIn,
      tOut,
      radius: effectiveRadius,
      entry,
      exit,
      points: arcPoints,
    })
  })

  if (transitions.length === 0) {
    return { sourcePoints: ring, points: ring, requestedRadius: radius, transitions: [] }
  }

  const out: Point[] = []
  let cursor = 0
  for (const transition of transitions) {
    while (cursor < transition.start) {
      out.push(ring[cursor])
      cursor += 1
    }
    out.push(...transition.points)
    cursor = transition.end + 1
  }
  while (cursor < count) {
    out.push(ring[cursor])
    cursor += 1
  }

  if (!out.every(isFinitePoint) || plannedContourSelfIntersects(out, transitions)) {
    return { sourcePoints: ring, points: ring, requestedRadius: radius, transitions: [] }
  }

  const metadata: ContourTurnTransition[] = transitions.map((transition) => ({
    firstIndex: transition.start,
    lastIndex: transition.end,
    runIndices: Array.from(
      { length: transition.end - transition.start + 1 },
      (_, offset) => transition.start + offset,
    ),
    signedTurn: transition.run.signedTurn,
    requestedRadius: radius,
    effectiveRadius: transition.radius,
    entry: transition.entry,
    exit: transition.exit,
    transitionPoints: transition.points,
    entryEdgeIndex: (transition.start - 1 + count) % count,
    exitEdgeIndex: transition.end % count,
  }))

  return { sourcePoints: ring, points: out, requestedRadius: radius, transitions: metadata }
}

/**
 * Round the sharp corners of a closed contour with tangent-arc fillets.
 *
 * Compatibility wrapper over `planContourSmoothing`: returns the smoothed
 * points only. See the planner for the identity/fail-closed behaviour.
 */
export function roundContourCorners(
  points: Point[],
  radius: number,
  options: RoundContourOptions = {},
): Point[] {
  return planContourSmoothing(points, radius, options).points
}

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

/**
 * Fillet the corners of every closed contour when a radius is given; otherwise
 * return the contours unchanged. undefined/0 radius = today's exact output, so
 * callers can gate smoothing by passing the derived radius straight through.
 * For flat lists of outer clearing contours (e.g. finish-floor rings) where the
 * offset-tree boundary exemption is unavailable.
 */
export function smoothClosedContours(
  contours: Point[][],
  radius: number | undefined,
  options?: RoundContourOptions,
): Point[][] {
  if (!radius) {
    return contours
  }
  return contours.map((contour) => roundContourCorners(contour, radius, options))
}
