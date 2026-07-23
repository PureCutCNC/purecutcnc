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

// ── internal helpers ──────────────────────────────────────────

interface CircleFit {
  center: { x: number; y: number }
  radius: number
}

const TWO_PI = Math.PI * 2

function pointsEq(a: ToolpathPoint, b: ToolpathPoint, eps = 1e-9): boolean {
  return Math.abs(a.x - b.x) <= eps
    && Math.abs(a.y - b.y) <= eps
    && Math.abs(a.z - b.z) <= eps
}

/**
 * Kasa algebraic circle fit.
 * Minimises Σ(‖pᵢ‖² + A·xᵢ + B·yᵢ + C)².
 *
 * Returns `null` when the normal matrix is singular or the fitted radius
 * is ≤ 0 (points are effectively collinear).
 */
function fitCircleKasa(points: readonly ToolpathPoint[]): CircleFit | null {
  const n = points.length
  if (n < 3) return null

  let sx = 0, sy = 0, sx2 = 0, sy2 = 0, sxy = 0
  // Accumulate the RHS terms: Σ zᵢ with zᵢ = xᵢ² + yᵢ²
  let sz = 0, szx = 0, szy = 0

  for (const p of points) {
    const x = p.x, y = p.y
    const x2 = x * x, y2 = y * y
    const z = x2 + y2
    sx += x
    sy += y
    sx2 += x2
    sy2 += y2
    sxy += x * y
    sz += z
    szx += z * x
    szy += z * y
  }

  // Normal matrix  [[  sx2  sxy  sx  ]   [A]   [-szx]
  //                 [  sxy  sy2  sy  ] × [B] = [-szy]
  //                 [  sx   sy   n   ]]  [C]   [-sz ]

  const det = sx2 * (sy2 * n - sy * sy)
            - sxy * (sxy * n - sy * sx)
            + sx  * (sxy * sy - sy2 * sx)

  if (Math.abs(det) < 1e-20) return null

  const invDet = 1 / det
  const A = ((-szx) * (sy2 * n - sy * sy)
          -    sxy  * ((-szy) * n - sy * (-sz))
          +    sx   * ((-szy) * sy - sy2 * (-sz))) * invDet
  const B = (    sx2  * ((-szy) * n - sy * (-sz))
          -   (-szx) * (sxy * n - sy * sx)
          +    sx   * (sxy * (-sz) - (-szy) * sx)) * invDet
  const C = (    sx2  * (sy2 * (-sz) - (-szy) * sy)
          -    sxy  * (sxy * (-sz) - (-szy) * sx)
          +   (-szx) * (sxy * sy - sy2 * sx)) * invDet

  const cx = -A / 2
  const cy = -B / 2
  const rSq = (A * A + B * B) / 4 - C

  if (rSq <= 1e-24) return null

  return { center: { x: cx, y: cy }, radius: Math.sqrt(rSq) }
}

/**
 * Maximum chordal deviation of any point from the fitted circle.
 */
function maxResidual(points: readonly ToolpathPoint[], fit: CircleFit): number {
  let maxDev = 0
  for (const p of points) {
    const dx = p.x - fit.center.x
    const dy = p.y - fit.center.y
    const dev = Math.abs(Math.sqrt(dx * dx + dy * dy) - fit.radius)
    if (dev > maxDev) maxDev = dev
  }
  return maxDev
}

/**
 * Sum of absolute angular differences between consecutive points
 * around the fitted circle centre, in radians.  The result is
 * scale-independent: a full circle returns ≈ 2π regardless of
 * radius, and a near-collinear path returns a value close to 0.
 */
function computeTotalSweep(
  points: readonly ToolpathPoint[],
  fit: CircleFit,
): number {
  let total = 0
  for (let k = 0; k < points.length - 1; k++) {
    const a0 = Math.atan2(
      points[k].y - fit.center.y,
      points[k].x - fit.center.x,
    )
    const a1 = Math.atan2(
      points[k + 1].y - fit.center.y,
      points[k + 1].x - fit.center.x,
    )
    let diff = a1 - a0
    while (diff > Math.PI) diff -= TWO_PI
    while (diff <= -Math.PI) diff += TWO_PI
    total += Math.abs(diff)
  }
  return total
}

/** Minimum total angular sweep (radians) required to accept a fitted
 *  arc.  A residual-only fit can turn a very shallow bend into a
 *  huge-radius arc; this scale-independent gate rejects candidates
 *  whose total accumulated chord-to-chord angle is below 0.5°. */
const MIN_TOTAL_SWEEP_RAD = Math.PI / 360

/**
 * Signed turning direction of three consecutive points.
 * Positive → CCW (G3), negative → CW (G2), near-zero → straight.
 */
function signedTurn(a: ToolpathPoint, b: ToolpathPoint, c: ToolpathPoint): number {
  return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
}

/**
 * Determines the consistent rotation direction across all adjacent
 * chord pairs.  Returns `true` for clockwise (G2), `false` for
 * counter-clockwise (G3), or `null` when turns are inconsistent or
 * the path is effectively straight.
 */
function detectDirection(points: readonly ToolpathPoint[]): boolean | null {
  let pos = false
  let neg = false
  for (let i = 1; i < points.length - 1; i++) {
    const t = signedTurn(points[i - 1], points[i], points[i + 1])
    if (t > 1e-15) pos = true
    else if (t < -1e-15) neg = true
  }
  if (pos && neg) return null   // inconsistent
  if (!pos && !neg) return null // straight line
  return neg // CW when turns are negative (right-hand turns)
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

    // 1. Circle fit.
    const circle = fitCircleKasa(points)
    if (!circle) {
      for (const m of run) result.push(toLinear(m))
      i = j
      continue
    }

    // 2. Residual check.
    if (maxResidual(points, circle) > tolerance) {
      for (const m of run) result.push(toLinear(m))
      i = j
      continue
    }

    // 2b. Collinearity gate: a residual-only fit can turn a very
    //     shallow bend into a huge-radius arc that is practically
    //     a straight line.  Require a minimum total angular sweep
    //     (scale-independent) before accepting the fit.
    if (computeTotalSweep(points, circle) < MIN_TOTAL_SWEEP_RAD) {
      for (const m of run) result.push(toLinear(m))
      i = j
      continue
    }

    // 3. Direction detection.
    const clockwise = detectDirection(points)
    if (clockwise === null) {
      for (const m of run) result.push(toLinear(m))
      i = j
      continue
    }

    // 4. Split into ≤ maxSweepDeg sub-arcs.
    const source = run[0].source
    const feedScale = run[0].feedScale
    const startPt = points[0]
    const endPt = points[points.length - 1]
    const subArcs = splitArc(startPt, endPt, circle.center, clockwise, maxSweepDeg)

    let prevEnd = startPt
    for (const seg of subArcs) {
      result.push({
        kind: 'arc',
        startPoint: prevEnd,
        endPoint: seg.endPt,
        centerOffsets: seg.centerOffsets,
        clockwise,
        source,
        feedScale,
      })
      prevEnd = seg.endPt
    }

    i = j
  }

  return result
}
