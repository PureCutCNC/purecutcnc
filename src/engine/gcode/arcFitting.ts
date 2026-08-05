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
 * Export-stage arc fitting: recognises constant-Z cutting polylines in
 * machine-coordinate ToolpathMove sequences and replaces qualifying chord
 * runs with arc descriptors (G2/G3).  The caller (postprocessor) is
 * responsible for transforming moves into machine coordinates before
 * calling this module, and for emitting the correct command words.
 *
 * Design contract:
 * - Only `cut` moves participate in arc fitting.
 * - A candidate run must be contiguous, share one source tag and
 *   feedScale, stay at constant Z, and contain ≥ 3 chord segments
 *   (4 points: from of the first move + to of every move in the run).
 * - Fitting uses the Kasa algebraic circle (linear least-squares).
 * - A run is rejected when any point is non-planar (Z varies),
 *   any point’s residual exceeds the supplied tolerance, the total
 *   angular sweep is below the collinearity threshold, or the
 *   direction is ambiguous.
 * - Every fitted run is split into sub-arcs of ≤ 90° — the caller
 *   chooses the maximum sweep.
 * - Residual moves (rapid, plunge, lead, rejected runs) pass through
 *   as linear descriptors with the same source / feedScale metadata.
 */

import type { ToolpathMove, ToolpathPoint } from '../toolpaths/types'
import { findArcRunsInPoints } from '../toolpaths/arcReconstruction'
import type { Point } from '../../types/project'

// ── public types ──────────────────────────────────────────────

export interface ArcMoveDescriptor {
  kind: 'arc'
  /** Start point of this arc segment (machine coordinates). */
  startPoint: ToolpathPoint
  /** End point of this arc segment (machine coordinates). */
  endPoint: ToolpathPoint
  /** I/J centre offsets relative to startPoint (machine coordinates). */
  centerOffsets: { i: number; j: number }
  /** True when the arc turns clockwise in machine coordinates. */
  clockwise: boolean
  /** Source tag carried from the original moves (may be undefined). */
  source?: string
  /** Feed-scale carried from the original moves (may be undefined). */
  feedScale?: number
  /** Identifier shared by every sub-arc split out of one fitted run.
   *  Validation and fallback are per *run*, never per sub-arc. */
  runId: number
  /** The original linear moves this run replaced, in order.  Emitted
   *  verbatim when post-format validation rejects any sub-arc of the run.
   *  Shared by reference across the run's sub-arcs.
   *
   *  Fallback must be whole-run: sub-arc boundaries are synthesised points
   *  on the fitted circle that match no source point, so a partial fallback
   *  would strand the controller somewhere no original G1 move reaches. */
  runFallback: readonly LinearMoveDescriptor[]
}

export interface LinearMoveDescriptor {
  kind: 'linear'
  /** End point in machine coordinates. */
  point: ToolpathPoint
  /** Original ToolpathMoveKind so the postprocessor can distinguish
   *  rapids from plunges / cuts / leads without re-deriving. */
  moveKind: ToolpathMove['kind']
  source?: string
  feedScale?: number
}

export type FittedMoveDescriptor = ArcMoveDescriptor | LinearMoveDescriptor

// ── run predicates ────────────────────────────────────────────

/**
 * True when two moves belong to the same fitting run: both are `cut`,
 * at the same Z, share source and feedScale, and are spatially
 * contiguous (the `from` of the second matches the `to` of the first).
 */
function sameRun(prev: ToolpathMove, next: ToolpathMove): boolean {
  if (next.kind !== 'cut') return false
  if (!pointsEq(prev.to, next.from)) return false
  if (!sameZ(prev.to, next.to)) return false
  if (prev.source !== next.source) return false
  if (prev.feedScale !== next.feedScale) return false
  return true
}

function sameZ(a: ToolpathPoint, b: ToolpathPoint, epsilon = 1e-9): boolean {
  return Math.abs(a.z - b.z) <= epsilon
}

function toLinear(move: ToolpathMove): LinearMoveDescriptor {
  return {
    kind: 'linear',
    point: move.to,
    moveKind: move.kind,
    source: move.source,
    feedScale: move.feedScale,
  }
}

// ── arc splitting helpers ────────────────────────────────────

const TWO_PI = Math.PI * 2

/** Minimum total angular sweep (radians) required to accept a fitted
 *  arc.  A residual-only fit can turn a very shallow bend into a
 *  huge-radius arc; this scale-independent gate rejects candidates
 *  whose total accumulated chord-to-chord angle is below 0.5°. */
const MIN_TOTAL_SWEEP_RAD = Math.PI / 360

function pointsEq(a: ToolpathPoint, b: ToolpathPoint, eps = 1e-9): boolean {
  return Math.abs(a.x - b.x) <= eps
    && Math.abs(a.y - b.y) <= eps
    && Math.abs(a.z - b.z) <= eps
}

/**
 * Angular sweep between two points around a centre, in radians.
 * Sign follows standard math: positive = CCW, negative = CW.
 */
function signedSweep(
  start: ToolpathPoint,
  end: ToolpathPoint,
  center: { x: number; y: number },
): number {
  const a0 = Math.atan2(start.y - center.y, start.x - center.x)
  const a1 = Math.atan2(end.y - center.y, end.x - center.x)
  let sweep = a1 - a0
  // Normalise to (-π, π]   (don't assume short/long arc yet)
  while (sweep > Math.PI) sweep -= TWO_PI
  while (sweep <= -Math.PI) sweep += TWO_PI
  return sweep
}

/**
 * Split a full arc (defined by centre, start, end, and the *intended*
 * direction) into disjoint sub-arcs each ≤ `maxSweepDeg` degrees.
 */
function splitArc(
  start: ToolpathPoint,
  end: ToolpathPoint,
  center: { x: number; y: number },
  clockwise: boolean,
  maxSweepDeg: number,
): Array<{ endPt: ToolpathPoint; centerOffsets: { i: number; j: number } }> {
  const radius = Math.hypot(start.x - center.x, start.y - center.y)
  const maxSweep = (maxSweepDeg * Math.PI) / 180
  const rawSweep = signedSweep(start, end, center)

  // Adjust the raw sweep so its sign matches the confirmed direction.
  let fullSweep = rawSweep
  if (clockwise && fullSweep > 0) fullSweep -= TWO_PI
  else if (!clockwise && fullSweep < 0) fullSweep += TWO_PI

  // A near-zero sweep with start ≈ end means a full circle.
  if (Math.abs(fullSweep) < 1e-12) {
    fullSweep = clockwise ? -TWO_PI : TWO_PI
  }

  const absSweep = Math.abs(fullSweep)
  // Subtract a tiny epsilon to avoid ceil(1.0000000000000002) = 2 at the
  // 90° boundary when the fitted centre is slightly off.
  const segments = Math.max(1, Math.ceil(absSweep / maxSweep - 1e-12))
  const step = fullSweep / segments

  const a0 = Math.atan2(start.y - center.y, start.x - center.x)
  const segments_out: Array<{ endPt: ToolpathPoint; centerOffsets: { i: number; j: number } }> = []

  let segStart = start
  for (let s = 1; s <= segments; s++) {
    const angle = a0 + step * s
    // The final sub-arc lands on the caller's end point exactly. With an
    // endpoint-constrained fit the projected point already equals it to
    // floating-point precision; using `end` verbatim removes the last path
    // by which an emitted run could drift off its source geometry.
    const ep: ToolpathPoint = s === segments
      ? { x: end.x, y: end.y, z: start.z }
      : {
        x: center.x + Math.cos(angle) * radius,
        y: center.y + Math.sin(angle) * radius,
        z: start.z,
      }
    segments_out.push({
      endPt: ep,
      centerOffsets: {
        i: center.x - segStart.x,
        j: center.y - segStart.y,
      },
    })
    segStart = ep
  }

  return segments_out
}

// ── emitted-arc self-consistency ─────────────────────────────

/**
 * An arc block is over-determined: start (modal), end (X/Y) and centre (I/J)
 * supply one more constraint than a circular arc needs, so the numbers can
 * contradict each other.  Controllers absorb a little contradiction as
 * rounding noise and reject the rest — a large disagreement means a spiral,
 * and cutting one because the file was wrong gouges the part.
 *
 * These are *export invariants*, not a dialect gate: they apply to every
 * machine definition, and no controller benefits from receiving an arc that
 * fails them.  The values are GRBL's published limits (`gcode.c`), which are
 * the tightest among the controllers shipped in `definitions/`; satisfying
 * them satisfies the more permissive ones.  Snapping (below) keeps emitted
 * arcs one to two orders of magnitude inside this budget, so the exact
 * numbers do not change any real outcome — if a stricter controller ever
 * turns up, tightening them here is the whole change.
 */
export const ARC_RADIUS_CONSISTENCY_TOLERANCE_MM = 0.005

/** Above this absolute disagreement no relative allowance applies. */
export const ARC_RADIUS_GROSS_MM = 0.5

/** Relative allowance between the floor and the gross limit (0.1 % of radius). */
export const ARC_RADIUS_RELATIVE_TOLERANCE = 0.001

/** How far around the naively rounded I/J the snap search looks, in grid steps. */
const SNAP_SEARCH_STEPS = 2

export interface EmittedArcOptions {
  /** Formats a value exactly as the postprocessor will, parsed back to a
   *  number, so the values judged here are the values written to the file. */
  format: (value: number) => number
  arcFormat: 'ij' | 'r'
  /** 1 for millimetre output, 25.4 for inch.  Controllers convert to
   *  millimetres before checking, so an inch program faces the same budget —
   *  and inch at 4 dp has a *coarser* grid in millimetres (0.00254) than
   *  millimetre output at 3 dp (0.001). */
  mmPerOutputUnit: number
  /** Output grid step in output units (10^-decimalPlaces).  Enables I/J
   *  snapping; pass 0 to disable it. */
  quantum: number
}

export interface EmittedArcGeometry {
  /** I offset to emit, relative to the *previously emitted* position. */
  i: number
  /** J offset to emit, relative to the *previously emitted* position. */
  j: number
  /** Radius to emit in R-format dialects. */
  radius: number
  /** False when the controller would reject the formatted block. */
  accepted: boolean
  /** Radius disagreement the controller would compute, in millimetres. */
  deltaRmm: number
}

/** The radius disagreement a controller computes from a formatted I/J block. */
function radiusDisagreement(
  startX: number, startY: number,
  targetX: number, targetY: number,
  i: number, j: number,
): number {
  return Math.abs(
    Math.hypot(targetX - (startX + i), targetY - (startY + j)) - Math.hypot(i, j),
  )
}

/**
 * Choose the I/J the file should carry.
 *
 * I and J are *ours to pick*: the only hard requirement is that the emitted
 * block be self-consistent. Naive rounding takes whatever the grid happens to
 * give and can land the two radii further apart than necessary, so instead we
 * search the grid neighbourhood and keep the pair that agrees best. Ties go to
 * the smaller displacement, which bounds the centre shift to at most
 * {@link SNAP_SEARCH_STEPS} output quanta — the same rounding that already
 * constrains every number in the file.
 */
function snapOffsets(
  startX: number, startY: number,
  targetX: number, targetY: number,
  rawI: number, rawJ: number,
  format: (value: number) => number,
  quantum: number,
): { i: number; j: number } {
  const baseI = format(rawI)
  const baseJ = format(rawJ)
  if (!(quantum > 0)) return { i: baseI, j: baseJ }

  let best = { i: baseI, j: baseJ }
  let bestDelta = radiusDisagreement(startX, startY, targetX, targetY, baseI, baseJ)
  let bestSteps = 0

  for (let di = -SNAP_SEARCH_STEPS; di <= SNAP_SEARCH_STEPS; di++) {
    for (let dj = -SNAP_SEARCH_STEPS; dj <= SNAP_SEARCH_STEPS; dj++) {
      if (di === 0 && dj === 0) continue
      // Re-format so the candidate is exactly on the output grid rather than
      // a float a hair off it.
      const i = format(baseI + di * quantum)
      const j = format(baseJ + dj * quantum)
      const delta = radiusDisagreement(startX, startY, targetX, targetY, i, j)
      const steps = Math.abs(di) + Math.abs(dj)
      if (delta < bestDelta - 1e-12
        || (delta <= bestDelta + 1e-12 && steps < bestSteps)) {
        best = { i, j }
        bestDelta = delta
        bestSteps = steps
      }
    }
  }

  return best
}

/**
 * Resolve the words an arc will emit, and decide whether the controller will
 * accept them — by reproducing its arithmetic on the *formatted* values.
 *
 * Both halves live here so they cannot diverge: the postprocessor emits the
 * values returned, formatted with the same `format` used to judge them.
 *
 * @param previousEmitted  Where the controller actually is — the formatted
 *                         endpoint of the preceding block, not the arc's own
 *                         declared start.  This distinction is the defect in
 *                         issue #447.
 */
export function resolveEmittedArc(
  arc: ArcMoveDescriptor,
  previousEmitted: { x: number; y: number },
  opts: EmittedArcOptions,
): EmittedArcGeometry {
  const { format, arcFormat, mmPerOutputUnit, quantum } = opts
  const center = {
    x: arc.startPoint.x + arc.centerOffsets.i,
    y: arc.startPoint.y + arc.centerOffsets.j,
  }
  const rawI = center.x - previousEmitted.x
  const rawJ = center.y - previousEmitted.y

  // What the controller reads off the line.
  const startX = format(previousEmitted.x)
  const startY = format(previousEmitted.y)
  const targetX = format(arc.endPoint.x)
  const targetY = format(arc.endPoint.y)

  if (arcFormat === 'r') {
    // In R mode the controller derives the centre itself, and cannot when the
    // chord is longer than the diameter. Rounding the radius *down* can cause
    // that on its own, so nudge up to the smallest grid radius spanning the
    // chord — but only when the shortfall is rounding-sized. A larger gap
    // means the descriptor is genuinely inconsistent, and widening R there
    // would silently swap the intended arc for a different, larger one.
    const chord = Math.hypot(targetX - startX, targetY - startY)
    const rounded = format(Math.hypot(rawI, rawJ))
    const spanning = quantum > 0
      ? Math.ceil((chord / 2) / quantum) * quantum
      : chord / 2
    const repairable = quantum > 0 && spanning - rounded <= SNAP_SEARCH_STEPS * quantum
    const radius = repairable ? Math.max(rounded, spanning) : rounded
    const overshoot = (chord - 2 * format(radius)) * mmPerOutputUnit
    return {
      i: rawI,
      j: rawJ,
      radius,
      accepted: overshoot <= 0,
      deltaRmm: Math.max(0, overshoot),
    }
  }

  const { i, j } = snapOffsets(
    startX, startY, targetX, targetY, rawI, rawJ, format, quantum,
  )
  const startRadius = Math.hypot(i, j)
  const deltaRmm = radiusDisagreement(startX, startY, targetX, targetY, i, j) * mmPerOutputUnit

  let accepted: boolean
  if (deltaRmm <= ARC_RADIUS_CONSISTENCY_TOLERANCE_MM) {
    accepted = true
  } else if (deltaRmm > ARC_RADIUS_GROSS_MM) {
    accepted = false
  } else {
    accepted = deltaRmm <= ARC_RADIUS_RELATIVE_TOLERANCE * startRadius * mmPerOutputUnit
  }

  return { i, j, radius: Math.hypot(rawI, rawJ), accepted, deltaRmm }
}

/**
 * Walk a run's sub-arcs from a known emitted position and report whether every
 * one of them survives formatting.  Rejecting the run as a whole keeps the
 * fallback aligned to real source points — see {@link ArcMoveDescriptor.runFallback}.
 */
export function runSurvivesFormatting(
  runArcs: readonly ArcMoveDescriptor[],
  previousEmitted: { x: number; y: number },
  opts: EmittedArcOptions,
): boolean {
  let position = previousEmitted
  for (const arc of runArcs) {
    if (!resolveEmittedArc(arc, position, opts).accepted) return false
    position = { x: opts.format(arc.endPoint.x), y: opts.format(arc.endPoint.y) }
  }
  return true
}

export interface ArcFallbackResult {
  /** Descriptors as they will actually be emitted: runs the controller would
   *  reject are replaced by the original linear moves they had fitted. */
  descriptors: FittedMoveDescriptor[]
  /** How many fitted runs were replaced. */
  fallbackRuns: number
}

/**
 * Resolve a fitted descriptor sequence into the sequence that can safely be
 * emitted, replacing any run whose formatted output the controller would
 * reject with the original G1 moves for that span.
 *
 * Both the emission path and the exported-motion debug trace call this, so the
 * debug view can never show an arc on a span that was emitted as G1.
 */
export function applyEmittedArcFallback(
  descriptors: readonly FittedMoveDescriptor[],
  opts: EmittedArcOptions,
  /** Where the controller already is when this sequence begins — the emitted
   *  position carried over from earlier operations.  Omitting it would judge
   *  a leading arc from its own declared start, the very conflation this
   *  function exists to prevent. */
  startPosition?: { x: number; y: number } | null,
): ArcFallbackResult {
  const { format } = opts
  const out: FittedMoveDescriptor[] = []
  let fallbackRuns = 0
  // Where the controller believes it is, tracked in formatted values.
  let position: { x: number; y: number } | null = startPosition ?? null
  let index = 0

  while (index < descriptors.length) {
    const descriptor = descriptors[index]

    if (descriptor.kind === 'linear') {
      out.push(descriptor)
      position = { x: format(descriptor.point.x), y: format(descriptor.point.y) }
      index += 1
      continue
    }

    // Gather the whole fitted run — validation and fallback are per run.
    const runId = descriptor.runId
    const runArcs: ArcMoveDescriptor[] = []
    while (index < descriptors.length) {
      const next = descriptors[index]
      if (next.kind !== 'arc' || next.runId !== runId) break
      runArcs.push(next)
      index += 1
    }

    const start = position ?? {
      x: format(runArcs[0].startPoint.x),
      y: format(runArcs[0].startPoint.y),
    }

    if (runSurvivesFormatting(runArcs, start, opts)) {
      out.push(...runArcs)
    } else {
      fallbackRuns += 1
      out.push(...runArcs[0].runFallback)
    }

    const last = out[out.length - 1]
    position = last.kind === 'arc'
      ? { x: format(last.endPoint.x), y: format(last.endPoint.y) }
      : { x: format(last.point.x), y: format(last.point.y) }
  }

  return { descriptors: out, fallbackRuns }
}

// ── public API ────────────────────────────────────────────────

/**
 * Walk a *machine-coordinate* move array and return a mixed sequence
 * of arc and linear descriptors.
 *
 * @param machineMoves  Moves whose from/to are already in machine
 *                      coordinates (project→machine transform already
 *                      applied).
 * @param tolerance     Maximum chordal deviation (radial residual)
 *                      allowed for any point on a candidate run, in
 *                      the current project units.
 * @param maxSweepDeg   Maximum arc sweep per emitted sub-arc, in
 *                      degrees (typically 90).
 */
export function fitArcsInMachineMoves(
  machineMoves: readonly ToolpathMove[],
  tolerance: number,
  maxSweepDeg: number,
): FittedMoveDescriptor[] {
  const result: FittedMoveDescriptor[] = []
  const n = machineMoves.length
  let i = 0
  let nextRunId = 0

  while (i < n) {
    const move = machineMoves[i]

    // Non-cut moves pass through as linear.
    if (move.kind !== 'cut') {
      result.push(toLinear(move))
      i++
      continue
    }

    // Build the longest qualifying run starting at i.
    const run: ToolpathMove[] = [move]
    let j = i + 1
    while (j < n && sameRun(run[run.length - 1], machineMoves[j])) {
      run.push(machineMoves[j])
      j++
    }

    // Fewer than 3 chord segments → linear pass-through.
    if (run.length < 3) {
      for (const m of run) result.push(toLinear(m))
      i = j
      continue
    }

    // Build the full point list: from of first move + to of every move.
    const points: ToolpathPoint[] = [run[0].from]
    for (const m of run) points.push(m.to)

    // 0. Planarity gate: every cut must have from.z === to.z within
    //    epsilon and all points in the run must share the same Z.
    //    The fitter never emits helical or ramping arcs.
    const refZ = points[0].z
    if (points.some(p => Math.abs(p.z - refZ) > 1e-9)) {
      for (const m of run) result.push(toLinear(m))
      i = j
      continue
    }

    // Convert ToolpathPoint[] → Point[] for the shared geometry function
    // (drops Z — planarity was already verified above).
    const xyPoints: Point[] = points.map(p => ({ x: p.x, y: p.y }))

    // Partial-run arc search via the shared geometry function.
    // sourceCenters is omitted — export has no source-circle metadata.
    const arcRuns = findArcRunsInPoints(xyPoints, {
      minArcPoints: 4,           // ≥ 3 chord segments = 4 points
      maxResidual: tolerance,
      maxSegmentAngleDeg: 90,    // individual chord step must be ≤ 90°
      minChordRatio: 0.15,       // reject tiny-chord fits
      minTotalSweepRad: MIN_TOTAL_SWEEP_RAD,
      maxAngularStepRatio: 4,    // never blend a long G1 with tiny corner chords
      endpointConstrained: true, // arcs must pass through their source endpoints
    })

    const source = run[0].source
    const feedScale = run[0].feedScale

    if (arcRuns.length === 0) {
      // No arc runs found → all linear.
      for (const m of run) result.push(toLinear(m))
      i = j
      continue
    }

    // Emit descriptors: walk through the point indices, emitting linear
    // for gaps and arcs for found runs.
    let moveIdx = 0
    for (const arcRun of arcRuns) {
      // Linear moves before this arc run.
      while (moveIdx < arcRun.startIndex) {
        result.push(toLinear(run[moveIdx]))
        moveIdx++
      }

      // Arc sub-segments for the found run.
      const arcStart = points[arcRun.startIndex]
      const arcEnd = points[arcRun.endIndex]
      const subArcs = splitArc(
        arcStart, arcEnd,
        { x: arcRun.center.x, y: arcRun.center.y },
        arcRun.clockwise,
        maxSweepDeg,
      )

      // Original moves this run replaces — move k spans points k → k+1, so the
      // point range [startIndex, endIndex] is covered by moves
      // [startIndex, endIndex).  Shared by reference across the run's sub-arcs.
      const runFallback: readonly LinearMoveDescriptor[] =
        run.slice(arcRun.startIndex, arcRun.endIndex).map(toLinear)
      const runId = nextRunId++

      let prevEnd = arcStart
      for (const seg of subArcs) {
        result.push({
          kind: 'arc',
          startPoint: prevEnd,
          endPoint: seg.endPt,
          centerOffsets: seg.centerOffsets,
          clockwise: arcRun.clockwise,
          source,
          feedScale,
          runId,
          runFallback,
        })
        prevEnd = seg.endPt
      }

      moveIdx = arcRun.endIndex
    }

    // Remaining linear moves after the last arc run.
    while (moveIdx < run.length) {
      result.push(toLinear(run[moveIdx]))
      moveIdx++
    }

    i = j
  }

  return result
}
