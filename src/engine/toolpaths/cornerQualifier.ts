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
 * Corner qualifier for inside corners of offset rings (issue #499, slice S2).
 * Pure module in the sense `engagement.ts` is pure: no `Project`/`Operation`
 * imports, no generator coupling, no I/O, fully deterministic. It takes ring
 * polylines plus an engagement measurement and returns the corners that would
 * qualify for corner unwinding. **Detection only** — nothing here changes any
 * move, feed, or point; the unwinding generator is a later slice.
 *
 * Input is the emitted ring geometry: per Z level, the closed cut polylines
 * of the offset rings in emission order, each with a consistent orientation
 * (the generator emits every ring of a level with one direction). A ring's
 * first point is its start/closure point, where the inter-ring link lands;
 * its turn is measured with the ring's own closure edge — the physically
 * emitted path — so no link geometry is needed as input.
 *
 * Qualification, in order (each corner must pass every step):
 *
 * 1. **Ring selection by emitted half-size, never by ordinal** (the slice-1
 *    trap: the generator emits innermost-first, inverted from #498's prose).
 *    Per level, the ring with the smallest half-size — the innermost ring,
 *    a true full-width slot, whose `peak` engagement reads π nearly
 *    everywhere and is not a corner-severity signal — and the ring with the
 *    largest half-size — the wall-adjacent ring, whose engagement the
 *    estimator overstates by counting retained material beyond the wall —
 *    are excluded from qualification. Half-size is the ring's bounding-box
 *    half-extent, the translation-invariant form of slice 1's
 *    `max |coordinate|` measure.
 * 2. **Turn angle** at the vertex must reach `TURN_ANGLE_THRESHOLD_RAD` and
 *    turn the same way as the ring's winding (an *inside* corner, per the
 *    issue). The magnitude check is what keeps tessellated arcs out (the
 *    pack's capsule rings turn ~5° per chord); the sign check rejects
 *    outside corners and direction artifacts.
 * 3. **Measured engagement** above the straight-wall value for the
 *    stepover: `nominalEngagement(stepover, toolRadius)` plus the shipped
 *    `ENGAGEMENT_ESTIMATE_EPSILON` deadband (the same margin slice 1's spike
 *    runs use). Measured as the larger of the vertex reading and a reading
 *    one sample step back along the approach direction — the estimator's
 *    coincidence special case zeroes a query at an exactly previously
 *    indexed disc centre, which the ring's closure vertex is when the
 *    caller's measurement includes the incoming link.
 * 4. **Span** — the length of the above-nominal engagement run around the
 *    corner, walked along the ring in both directions at the slice-1
 *    sampling resolution (a quarter tool diameter per sample) until the
 *    engagement returns to at most nominal, or the whole ring has been
 *    walked. A corner whose raw two-sided walk exceeds
 *    `SPAN_MAX_TOOL_DIAMETERS` tool diameters while still above nominal sits
 *    in a slotting stretch, not a corner spike, and does not qualify.
 *
 * Thresholds are derived from the slice-1 measured table (see the constants
 * below), never guessed — the original tier ranking guessed a 2d boundary
 * and inverted its own answer.
 */

import { ENGAGEMENT_ESTIMATE_EPSILON } from './engagement'

/**
 * Minimum interior turn angle for a qualifying corner, in radians.
 *
 * Derived from the slice-1 measurement, both bounds measured on the emitted
 * rings of the fixture pack at d = 6, stepover 0.4:
 *
 * - The tessellated arcs of `curvedCorner` (the capsule — the negative
 *   control, where the qualifier must **not** fire) turn at most 5.1° per
 *   chord. The island ring of `islandPinch` (a tessellated circle) measures
 *   the same 5° ceiling, so 5.1° is the pack-wide tessellation bound.
 * - The smallest genuine corner that must qualify is the rectangular
 *   fixture's right angle, 90°.
 *
 * The threshold sits at the geometric midpoint of the two measured bounds:
 * `sqrt(5.1° × 90°) ≈ 21.4°` = 0.3738 rad. A threshold tuned only on the
 * acute fixture (116.6° corners) or only on the capsule would sit too close
 * to one bound; the midpoint leaves ~16° of headroom on both sides.
 */
export const TURN_ANGLE_THRESHOLD_RAD = Math.sqrt((5.1 * Math.PI / 180) * (Math.PI / 2))

/**
 * Maximum span, in tool diameters, of the above-nominal engagement run
 * around a qualifying corner.
 *
 * Derived from the slice-1 measured table (interior rings, d = 6 mm,
 * stepover 0.4): the longest measured corner run is 7.39d on
 * `largeComplex` — which the #499 handoff designates as the case that sets
 * this threshold, because it carries the long tail (p95 4.88d, max 7.39d)
 * and is the realistic case; `acuteCorner` tops out at 3.12d and a threshold
 * derived from it would reject the cases that matter. The threshold is the
 * smallest whole tool diameter above the measured maximum: 8d. Runs longer
 * than that were never measured as corner spikes — they are slotting
 * stretches (#501's territory), and a corner embedded in one is declined.
 */
export const SPAN_MAX_TOOL_DIAMETERS = 8

/**
 * Engagement sampling step as a fraction of the tool diameter: `d/4`, the
 * slice-1 measurement's resolution, which the measured span table was
 * captured at. Spans reported here are therefore directly comparable to
 * that table.
 */
export const ENGAGEMENT_SAMPLE_STEP_FRACTION = 0.25

/** One ring vertex. */
export interface CornerQualifierPoint {
  x: number
  y: number
}

/**
 * One emitted offset ring: its closed polyline, the level it belongs to,
 * and the engagement measurement against which it is qualified. Ring
 * selection (innermost slotting ring / wall-adjacent ring) runs per level,
 * so every ring must carry the level it was cut at.
 */
export interface CornerQualifierRing {
  /** Closed polyline in emission order, at least 3 distinct points. */
  points: ReadonlyArray<CornerQualifierPoint>
  /** The level this ring was cut at (any grouping key; Z is natural). */
  level: number
  /**
   * Engagement measurement, in radians, for a cutter at `(x, y)` heading
   * `(dirX, dirY)` (need not be unit length) against the material swept
   * before this ring was cut at its level. Pure function of its arguments;
   * the qualifier only ever queries positions on the ring itself.
   */
  engagementAt: (x: number, y: number, dirX: number, dirY: number) => number
}

/** Inputs for one qualification run. */
export interface CornerQualifierOptions {
  /** Tool diameter in project units; the span threshold and sample step derive from it. */
  toolDiameter: number
  /** Straight-wall engagement for the stepover: `nominalEngagement(stepover · diameter, diameter / 2)`. */
  nominalEngagement: number
}

/** One corner that qualifies for unwinding. */
export interface QualifyingCorner {
  /** Index into the `rings` input. */
  ringIndex: number
  /** Index into that ring's `points`. */
  vertexIndex: number
  x: number
  y: number
  /**
   * Signed interior turn angle at the vertex, radians, in `[−π, π]`; its
   * sign matches the ring's winding by construction.
   */
  turnAngle: number
  /** Measured engagement at the corner, radians — above nominal by construction. */
  engagement: number
  /**
   * Length of the above-nominal engagement run around the corner, in
   * project units, walked along the ring in both directions.
   */
  span: number
}

/** One side of the span walk. */
const WALK_DIRECTIONS = [-1, 1] as const

/**
 * Identify the corners of the given rings that qualify for unwinding.
 * Deterministic: stable iteration order, no randomness, no clock.
 */
export function qualifyCorners(
  rings: ReadonlyArray<CornerQualifierRing>,
  options: CornerQualifierOptions,
): QualifyingCorner[] {
  if (!Number.isFinite(options.toolDiameter) || options.toolDiameter <= 0) {
    throw new RangeError(`qualifyCorners: toolDiameter must be positive and finite, got ${options.toolDiameter}`)
  }
  if (!Number.isFinite(options.nominalEngagement) || options.nominalEngagement < 0) {
    throw new RangeError(`qualifyCorners: nominalEngagement must be finite and non-negative, got ${options.nominalEngagement}`)
  }
  const step = options.toolDiameter * ENGAGEMENT_SAMPLE_STEP_FRACTION
  const spanMax = options.toolDiameter * SPAN_MAX_TOOL_DIAMETERS

  // ── Ring selection: per level, exclude the innermost slotting ring
  // (smallest half-size) and the wall-adjacent ring (largest half-size).
  const ringsByLevel = new Map<number, number[]>()
  rings.forEach((ring, index) => {
    if (ring.points.length < 3) return
    const indices = ringsByLevel.get(ring.level)
    if (indices) {
      indices.push(index)
    } else {
      ringsByLevel.set(ring.level, [index])
    }
  })
  const selected = new Set<number>()
  for (const indices of ringsByLevel.values()) {
    let minHalf = Number.POSITIVE_INFINITY
    let maxHalf = Number.NEGATIVE_INFINITY
    const halves = indices.map((index) => {
      const half = ringHalfExtent(rings[index].points)
      minHalf = Math.min(minHalf, half)
      maxHalf = Math.max(maxHalf, half)
      return { index, half }
    })
    for (const { index, half } of halves) {
      if (half <= minHalf + 1e-9 || half >= maxHalf - 1e-9) continue
      selected.add(index)
    }
  }

  const results: QualifyingCorner[] = []
  rings.forEach((ring, ringIndex) => {
    if (!selected.has(ringIndex)) return
    const points = ring.points
    const count = points.length
    const windingSign = Math.sign(ringWinding(points))
    const perimeter = ringPerimeter(points)
    for (let vertexIndex = 0; vertexIndex < count; vertexIndex += 1) {
      const corner = evaluateVertex(
        points,
        vertexIndex,
        windingSign,
        perimeter,
        step,
        spanMax,
        ring.engagementAt,
        options,
      )
      if (corner === null) continue
      results.push({
        ringIndex,
        vertexIndex,
        x: corner.x,
        y: corner.y,
        turnAngle: corner.turn,
        engagement: corner.engagement,
        span: corner.span,
      })
    }
  })
  return results
}

interface EvaluatedCorner {
  x: number
  y: number
  turn: number
  engagement: number
  span: number
}

/** Apply the turn, engagement, and span qualifiers to one vertex; null when it fails any. */
function evaluateVertex(
  points: ReadonlyArray<CornerQualifierPoint>,
  vertexIndex: number,
  windingSign: number,
  perimeter: number,
  step: number,
  spanMax: number,
  engagementAt: (x: number, y: number, dirX: number, dirY: number) => number,
  options: CornerQualifierOptions,
): EvaluatedCorner | null {
  const count = points.length
  const current = points[vertexIndex]
  const previous = points[(vertexIndex - 1 + count) % count]
  const next = points[(vertexIndex + 1) % count]
  const incomingX = current.x - previous.x
  const incomingY = current.y - previous.y
  const outgoingX = next.x - current.x
  const outgoingY = next.y - current.y
  const incomingLength = Math.hypot(incomingX, incomingY)
  const outgoingLength = Math.hypot(outgoingX, outgoingY)
  if (incomingLength <= 1e-9 || outgoingLength <= 1e-9) return null

  // Turn angle: magnitude past the threshold, and the turn must go the same
  // way as the ring's winding — an inside corner. The sign check is what
  // keeps outside corners and direction artifacts from qualifying.
  const cross = incomingX * outgoingY - incomingY * outgoingX
  const turn = Math.atan2(cross, incomingX * outgoingX + incomingY * outgoingY)
  if (Math.abs(turn) < TURN_ANGLE_THRESHOLD_RAD) return null
  if (Math.sign(cross) !== windingSign) return null

  // Measured engagement: the vertex reading and a reading one sample step
  // back along the approach direction, taking the larger. The fallback
  // covers the estimator's coincidence special case (a query exactly at a
  // previously indexed swept-disc centre reads 0), which the closure vertex
  // hits when the caller's measurement includes the incoming link.
  const approachX = incomingX / incomingLength
  const approachY = incomingY / incomingLength
  const atVertex = engagementAt(current.x, current.y, approachX, approachY)
  const beforeVertex = engagementAt(
    current.x - approachX * step,
    current.y - approachY * step,
    approachX,
    approachY,
  )
  const engagement = Math.max(atVertex, beforeVertex)
  if (!(engagement > options.nominalEngagement + ENGAGEMENT_ESTIMATE_EPSILON)) return null

  // Span: walk the ring away from the vertex in both directions, one sample
  // step at a time, while the engagement stays above nominal. Each side is
  // bounded by the ring's own perimeter (on a ring whose every point reads
  // above nominal the walk would otherwise loop forever). The raw total of
  // the two sides past the span threshold means the corner sits in a
  // slotting stretch; the reported span is capped at the perimeter, since
  // both walks live inside the same ring.
  let rawSpan = 0
  for (const direction of WALK_DIRECTIONS) {
    let distance = step / 2
    let walked = 0
    for (;;) {
      if (walked + step > perimeter + 1e-9) break
      const sample = pointAtArcDistance(points, vertexIndex, direction * distance)
      const heading = directionAtArcDistance(points, vertexIndex, direction * distance)
      const measured = engagementAt(sample.x, sample.y, heading.x, heading.y)
      if (!(measured > options.nominalEngagement + ENGAGEMENT_ESTIMATE_EPSILON)) break
      walked += step
      rawSpan += step
      distance += step
    }
  }
  if (rawSpan > spanMax + 1e-9) return null

  return {
    x: current.x,
    y: current.y,
    turn,
    engagement,
    span: Math.min(rawSpan, perimeter),
  }
}

/** Bounding-box half-extent — the emitted half-size proxy, translation-invariant. */
function ringHalfExtent(points: ReadonlyArray<CornerQualifierPoint>): number {
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const point of points) {
    minX = Math.min(minX, point.x)
    maxX = Math.max(maxX, point.x)
    minY = Math.min(minY, point.y)
    maxY = Math.max(maxY, point.y)
  }
  return Math.max((maxX - minX) / 2, (maxY - minY) / 2)
}

/** Signed shoelace area of the ring; its sign is the winding direction. */
function ringWinding(points: ReadonlyArray<CornerQualifierPoint>): number {
  let sum = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    sum += current.x * next.y - next.x * current.y
  }
  return sum
}

/** Total path length of the closed ring. */
function ringPerimeter(points: ReadonlyArray<CornerQualifierPoint>): number {
  let total = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    total += Math.hypot(next.x - current.x, next.y - current.y)
  }
  return total
}

/** Point on the ring at arc distance `t` from vertex `index` (t > 0 forward). */
function pointAtArcDistance(
  points: ReadonlyArray<CornerQualifierPoint>,
  index: number,
  t: number,
): CornerQualifierPoint {
  const count = points.length
  let remaining = t
  if (t >= 0) {
    let current = points[index]
    for (let offset = 0; offset < count; offset += 1) {
      const next = points[(index + 1 + offset) % count]
      const dx = next.x - current.x
      const dy = next.y - current.y
      const length = Math.hypot(dx, dy)
      if (remaining <= length) {
        const fraction = length > 1e-9 ? remaining / length : 0
        return { x: current.x + dx * fraction, y: current.y + dy * fraction }
      }
      remaining -= length
      current = next
    }
    return points[index]
  }
  let remainingBackward = -t
  let current = points[index]
  for (let offset = 0; offset < count; offset += 1) {
    const previous = points[(index - 1 - offset + count) % count]
    const dx = previous.x - current.x
    const dy = previous.y - current.y
    const length = Math.hypot(dx, dy)
    if (remainingBackward <= length) {
      const fraction = length > 1e-9 ? remainingBackward / length : 0
      return { x: current.x + dx * fraction, y: current.y + dy * fraction }
    }
    remainingBackward -= length
    current = previous
  }
  return points[index]
}

/** The ring's forward direction at arc distance `t` from vertex `index` (t > 0 forward). */
function directionAtArcDistance(
  points: ReadonlyArray<CornerQualifierPoint>,
  index: number,
  t: number,
): CornerQualifierPoint {
  const count = points.length
  if (t >= 0) {
    let remaining = t
    let current = points[index]
    for (let offset = 0; offset < count; offset += 1) {
      const next = points[(index + 1 + offset) % count]
      const dx = next.x - current.x
      const dy = next.y - current.y
      const length = Math.hypot(dx, dy)
      if (remaining <= length) {
        if (length <= 1e-9) return { x: 1, y: 0 }
        return { x: dx / length, y: dy / length }
      }
      remaining -= length
      current = next
    }
  } else {
    let remainingBackward = -t
    let current = points[index]
    for (let offset = 0; offset < count; offset += 1) {
      const previous = points[(index - 1 - offset + count) % count]
      const dx = current.x - previous.x
      const dy = current.y - previous.y
      const length = Math.hypot(dx, dy)
      if (remainingBackward <= length) {
        if (length <= 1e-9) return { x: 1, y: 0 }
        return { x: dx / length, y: dy / length }
      }
      remainingBackward -= length
      current = previous
    }
  }
  return { x: 1, y: 0 }
}
