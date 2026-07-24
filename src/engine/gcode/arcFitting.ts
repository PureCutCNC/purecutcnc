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
    const ep: ToolpathPoint = {
      x: center.x + Math.cos(angle) * Math.hypot(start.x - center.x, start.y - center.y),
      y: center.y + Math.sin(angle) * Math.hypot(start.x - center.x, start.y - center.y),
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
