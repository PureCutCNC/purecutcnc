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

import type { Point, Segment, SketchProfile } from '../types/project'

export interface SimplifyOptions {
  /** Minimum consecutive line segments required to attempt arc fitting. Default: 6. */
  minArcSegments: number
  /**
   * Maximum allowed point deviation from the fitted circle, expressed as a fraction of
   * the fitted radius. Default: 0.01 (1%).
   */
  radiusToleranceFraction: number
}

export const DEFAULT_SIMPLIFY_OPTIONS: SimplifyOptions = {
  minArcSegments: 6,
  radiusToleranceFraction: 0.01,
}

// ---------------------------------------------------------------------------
// Internal geometry helpers
// ---------------------------------------------------------------------------

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/**
 * Kasa least-squares circle fit.
 * Returns null when the points are nearly collinear (determinant too small) or fewer
 * than 3 points are supplied.
 */
function fitCircleLeastSquares(points: Point[]): { center: Point; radius: number } | null {
  const n = points.length
  if (n < 3) {
    return null
  }

  // Shift to centroid for numerical stability.
  let cx = 0
  let cy = 0
  for (const p of points) {
    cx += p.x
    cy += p.y
  }
  cx /= n
  cy /= n

  // Compute the centered coordinates and the sums needed for the 2×2 normal equations.
  let Suu = 0
  let Suv = 0
  let Svv = 0
  let Arhs = 0
  let Brhs = 0

  for (const p of points) {
    const u = p.x - cx
    const v = p.y - cy
    const r2 = u * u + v * v
    Suu += u * u
    Suv += u * v
    Svv += v * v
    Arhs -= u * r2
    Brhs -= v * r2
  }

  // Solve [Suu Suv; Suv Svv] * [A; B] = [Arhs; Brhs]
  const det = Suu * Svv - Suv * Suv
  if (Math.abs(det) < 1e-12) {
    return null
  }

  const A = (Arhs * Svv - Brhs * Suv) / det
  const B = (Suu * Brhs - Suv * Arhs) / det

  // Center in shifted coords; shift back.
  const cu = -A / 2
  const cv = -B / 2

  // Radius²: cu² + cv² - C, where n*C = -Σr² and we derive from the centred formula.
  let Sr2 = 0
  for (const p of points) {
    const u = p.x - cx
    const v = p.y - cy
    Sr2 += u * u + v * v
  }
  const radius2 = cu * cu + cv * cv + Sr2 / n
  if (radius2 <= 0) {
    return null
  }

  return {
    center: { x: cu + cx, y: cv + cy },
    radius: Math.sqrt(radius2),
  }
}

/**
 * Returns true when the sequence of points traverses clockwise around `center`
 * in screen coordinates (Y increases downward).
 *
 * Uses the sum of cross products of consecutive center-relative vectors, which is
 * more robust than a single three-point test.
 */
function isClockwiseScreenCoords(points: Point[], center: Point): boolean {
  let cross = 0
  const n = points.length
  for (let i = 0; i < n - 1; i += 1) {
    const v0x = points[i].x - center.x
    const v0y = points[i].y - center.y
    const v1x = points[i + 1].x - center.x
    const v1y = points[i + 1].y - center.y
    cross += v0x * v1y - v0y * v1x
  }
  // In Y-down screen coords a positive cross product sum means the traversal is clockwise.
  return cross > 0
}

// ---------------------------------------------------------------------------
// Pass 1 — merge consecutive collinear line segments
// ---------------------------------------------------------------------------

function areCollinear(a: Point, b: Point, c: Point): boolean {
  // Use the sine of the angle between AB and BC; accept if |sine| < 1e-4.
  const abx = b.x - a.x
  const aby = b.y - a.y
  const bcx = c.x - b.x
  const bcy = c.y - b.y
  const cross = abx * bcy - aby * bcx
  const dot = abx * bcx + aby * bcy
  // Same direction (dot > 0) and nearly parallel (|cross|² < (1e-4)² * |AB|² * |BC|²).
  if (dot <= 0) {
    return false
  }
  const abLen2 = abx * abx + aby * aby
  const bcLen2 = bcx * bcx + bcy * bcy
  return cross * cross < 1e-8 * abLen2 * bcLen2
}

function mergeCollinearLines(profile: SketchProfile): SketchProfile {
  if (profile.segments.length < 2) {
    return profile
  }

  const merged: Segment[] = []
  let current = profile.segments[0]
  let currentStart = profile.start

  for (let i = 1; i < profile.segments.length; i += 1) {
    const next = profile.segments[i]
    if (
      current.type === 'line'
      && next.type === 'line'
      && areCollinear(currentStart, current.to, next.to)
    ) {
      // Merge: extend the current segment to next.to, discard intermediate point.
      current = { type: 'line', to: next.to }
    } else {
      merged.push(current)
      currentStart = current.to
      current = next
    }
  }
  merged.push(current)

  return { ...profile, segments: merged }
}

// ---------------------------------------------------------------------------
// Pass 2 — arc fitting
// ---------------------------------------------------------------------------

interface ArcFitResult {
  center: Point
  clockwise: boolean
}

/**
 * Attempts to fit a single arc to the given ordered point sequence.
 * Returns null when the points are too collinear, do not all lie within the
 * configured tolerance of the fitted circle, or fewer than minArcSegments+1
 * points are supplied.
 */
function tryFitArc(points: Point[], opts: SimplifyOptions): ArcFitResult | null {
  // points has (segments + 1) entries; we need at least minArcSegments segments.
  if (points.length < opts.minArcSegments + 1) {
    return null
  }

  const fit = fitCircleLeastSquares(points)
  if (!fit) {
    return null
  }

  const { center, radius } = fit
  const tolerance = opts.radiusToleranceFraction * radius

  // Verify that every point lies on the circle within the tolerance.
  for (const p of points) {
    if (Math.abs(dist(p, center) - radius) > tolerance) {
      return null
    }
  }

  // Reject any run that contains a segment spanning more than 60° (π/3).
  // A genuine arc approximation has many short chords, each subtending a small angle.
  // A large chord (e.g. a diameter used as a "return home" segment) would subtend a
  // large angle even though its endpoints happen to lie on the circle.
  const maxSegmentAngle = Math.PI / 3  // 60°
  for (let i = 0; i < points.length - 1; i += 1) {
    const a1 = Math.atan2(points[i].y - center.y, points[i].x - center.x)
    const a2 = Math.atan2(points[i + 1].y - center.y, points[i + 1].x - center.x)
    let da = Math.abs(a2 - a1)
    if (da > Math.PI) {
      da = 2 * Math.PI - da
    }
    if (da > maxSegmentAngle) {
      return null
    }
  }

  // Guard against nearly-collinear points that fit a huge-radius circle: chord/R < 0.15
  // means span < ~9°, indistinguishable from a straight line.
  // Exception: chord ≈ 0 indicates a full circle (span ≈ 360°), which is always valid.
  const chord = dist(points[0], points[points.length - 1])
  const isFullCircle = chord <= radius * 1e-6
  if (!isFullCircle && chord < radius * 0.15) {
    return null
  }

  return {
    center,
    clockwise: isClockwiseScreenCoords(points, center),
  }
}

/**
 * Returns a contiguous slice of vertices from the profile, covering
 * segments[startSeg .. endSeg-1].
 *
 * `vertices[i]` corresponds to the start of segment `startSeg + i`.
 * `vertices[length-1]` is the end point of segment `endSeg-1`.
 */
function sliceVertices(profile: SketchProfile, startSeg: number, endSeg: number): Point[] {
  // The vertex before segment[startSeg]:
  const origin: Point = startSeg === 0 ? profile.start : (profile.segments[startSeg - 1].to as Point)
  const pts: Point[] = [origin]
  for (let i = startSeg; i < endSeg; i += 1) {
    pts.push(profile.segments[i].to)
  }
  return pts
}

function fitArcs(profile: SketchProfile, opts: SimplifyOptions): SketchProfile {
  const segs = profile.segments
  if (segs.length < opts.minArcSegments) {
    return profile
  }

  const out: Segment[] = []
  let i = 0

  while (i < segs.length) {
    // Find the end of a contiguous run of line segments starting at i.
    if (segs[i].type !== 'line') {
      out.push(segs[i])
      i += 1
      continue
    }

    let runEnd = i + 1
    while (runEnd < segs.length && segs[runEnd].type === 'line') {
      runEnd += 1
    }
    // segs[i..runEnd-1] are all lines; try to fit from longest sub-run down.

    let consumed = false
    for (let end = runEnd; end >= i + opts.minArcSegments; end -= 1) {
      const pts = sliceVertices(profile, i, end)
      const fit = tryFitArc(pts, opts)
      if (fit) {
        out.push({
          type: 'arc',
          to: pts[pts.length - 1],
          center: fit.center,
          clockwise: fit.clockwise,
        })
        i = end
        consumed = true
        break
      }
    }

    if (!consumed) {
      // Could not fit any arc starting here; emit the segment unchanged and advance.
      out.push(segs[i])
      i += 1
    }
  }

  return { ...profile, segments: out }
}

// ---------------------------------------------------------------------------
// Pass 3 — promote single full-span arc to circle
// ---------------------------------------------------------------------------

function detectCircle(profile: SketchProfile): SketchProfile {
  if (!profile.closed || profile.segments.length !== 1) {
    return profile
  }

  const seg = profile.segments[0]
  if (seg.type !== 'arc') {
    return profile
  }

  // A full-circle arc has its endpoint at profile.start (or very close to it).
  const radius = dist(profile.start, seg.center)
  if (radius <= 0) {
    return profile
  }
  if (dist(seg.to, profile.start) > 0.01 * radius) {
    return profile
  }

  return {
    start: profile.start,
    segments: [{
      type: 'circle',
      center: seg.center,
      to: profile.start,
      clockwise: seg.clockwise,
    }],
    closed: true,
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Simplifies a `SketchProfile` by:
 * 1. Merging consecutive collinear line segments into one.
 * 2. Replacing runs of ≥ `minArcSegments` line segments that lie on a common circle
 *    (within `radiusToleranceFraction × radius`) with a single arc segment.
 * 3. Converting a closed single-arc profile that spans the full circle into a
 *    `circle` segment.
 *
 * The input profile must already be in the internal coordinate system (Y-down screen
 * coords).  Segment types other than `line` are passed through unchanged.
 */
export function simplifyProfile(
  profile: SketchProfile,
  opts: SimplifyOptions = DEFAULT_SIMPLIFY_OPTIONS,
): SketchProfile {
  let result = mergeCollinearLines(profile)
  result = fitArcs(result, opts)
  result = detectCircle(result)
  return result
}
