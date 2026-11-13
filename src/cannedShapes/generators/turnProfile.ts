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
 * The Turn's copied side profile (issue #1112 slice H, decision 11).
 *
 * The dialog picks a drawn outline on the bar's side view and copies it into
 * the Turn as a list of `(along, radius)` points. The copy is authoritative:
 * moving, expanding or deleting the source cannot change the Turn. The source
 * id is remembered only so the dialog can offer **Refresh**, which copies the
 * current source again (and is refused with a reason when the source is gone).
 *
 * Point conversion and the refusals live here rather than in the dialog so the
 * dialog, the store and the generator validate one rule set:
 *
 * - **crossing the axis** — the outline has points on both sides of the bar
 *   centreline (or, for an open half-profile, is not wholly on one side);
 * - **doubling back along the bar** — an open outline's along coordinate
 *   reverses direction, so it is not a turning profile;
 * - **past the stock** — a radius larger than the bar's half thickness, or an
 *   along position outside the bar's ends.
 *
 * A closed outline is revolved as the region it encloses (which may be a ring
 * when it does not touch the axis); an open outline is closed onto the axis.
 */

import type { RotarySolidFrame } from './rotarySolidParams'

/** One point in the bar's side view: along its axis, distance from the axis. */
export interface TurnProfilePoint {
  along: number
  radius: number
}

/** One copied outline. `closed` follows the source outline. */
export interface TurnProfileContour {
  points: TurnProfilePoint[]
  closed: boolean
}

/** The stored profile copy plus the source it was copied from. */
export interface TurnCannedProfile {
  /** The feature the copy was taken from; `Refresh` re-reads it. */
  sourceFeatureId: string
  /** The source's name at pick time, used when the source no longer exists. */
  sourceName?: string
  contours: TurnProfileContour[]
}

/** Why a drawn outline cannot be revolved, in the dialog's own terms. */
export type TurnProfileProblem =
  | 'profileEmpty'
  | 'profileCrossesAxis'
  | 'profileDoublesBack'
  | 'profileMultipleOutlines'
  | 'profileExceedsStock'
  | 'profileOutOfBar'

/** Numeric slack for the side-view checks. */
export const TURN_PROFILE_TOLERANCE = 1e-6

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function near(a: number, b: number, tolerance = TURN_PROFILE_TOLERANCE): boolean {
  return Math.abs(a - b) <= tolerance
}

/**
 * The one place an outline is judged. `points` are **signed** at this point:
 * a negative radius means the outline is on the other side of the axis. The
 * stored copy is unsigned, so the crossing check only happens while picking.
 */
export function checkPickedContour(
  points: readonly { along: number; radius: number }[],
  closed: boolean,
  frame: RotarySolidFrame,
): TurnProfileProblem | null {
  if (points.length < 2) return 'profileEmpty'
  for (const point of points) {
    if (!isFiniteNumber(point.along) || !isFiniteNumber(point.radius)) return 'profileEmpty'
  }

  const half = frame.thickness / 2 + TURN_PROFILE_TOLERANCE
  let hasPositive = false
  let hasNegative = false
  for (const point of points) {
    if (point.radius > TURN_PROFILE_TOLERANCE) hasPositive = true
    if (point.radius < -TURN_PROFILE_TOLERANCE) hasNegative = true
    if (Math.abs(point.radius) > half) return 'profileExceedsStock'
    if (point.along < frame.alongMin - TURN_PROFILE_TOLERANCE
      || point.along > frame.alongMax + TURN_PROFILE_TOLERANCE) {
      return 'profileOutOfBar'
    }
  }
  if (hasPositive && hasNegative) return 'profileCrossesAxis'
  if (!hasPositive && !hasNegative) return 'profileEmpty'

  const first = points[0]
  const last = points[points.length - 1]
  if (!first || !last) return 'profileEmpty'

  if (!closed) {
    let ascending = 0
    let descending = 0
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1]
      const current = points[index]
      if (!previous || !current) continue
      const delta = current.along - previous.along
      if (delta > TURN_PROFILE_TOLERANCE) ascending += 1
      if (delta < -TURN_PROFILE_TOLERANCE) descending += 1
    }
    if (ascending > 0 && descending > 0) return 'profileDoublesBack'
  }

  let minAlong = Number.POSITIVE_INFINITY
  let maxAlong = Number.NEGATIVE_INFINITY
  for (const point of points) {
    minAlong = Math.min(minAlong, point.along)
    maxAlong = Math.max(maxAlong, point.along)
  }
  if (!(maxAlong - minAlong > TURN_PROFILE_TOLERANCE)) return 'profileEmpty'
  return null
}

/** The stored profile's own problem, after conversion: no signed side remains. */
export function turnProfileProblem(
  profile: TurnCannedProfile,
  frame: RotarySolidFrame,
): TurnProfileProblem | null {
  if (!Array.isArray(profile.contours) || profile.contours.length === 0) return 'profileEmpty'
  const half = frame.thickness / 2 + TURN_PROFILE_TOLERANCE
  let minAlong = Number.POSITIVE_INFINITY
  let maxAlong = Number.NEGATIVE_INFINITY
  let maxRadius = 0
  for (const contour of profile.contours) {
    if (contour.points.length < 2) return 'profileEmpty'
    for (const point of contour.points) {
      if (!isFiniteNumber(point.along) || !isFiniteNumber(point.radius)) return 'profileEmpty'
      if (point.radius < -TURN_PROFILE_TOLERANCE) return 'profileCrossesAxis'
      if (point.radius > half) return 'profileExceedsStock'
      if (point.along < frame.alongMin - TURN_PROFILE_TOLERANCE
        || point.along > frame.alongMax + TURN_PROFILE_TOLERANCE) {
        return 'profileOutOfBar'
      }
      minAlong = Math.min(minAlong, point.along)
      maxAlong = Math.max(maxAlong, point.along)
      maxRadius = Math.max(maxRadius, point.radius)
    }
    if (!contour.closed) {
      let ascending = 0
      let descending = 0
      for (let index = 1; index < contour.points.length; index += 1) {
        const previous = contour.points[index - 1]
        const current = contour.points[index]
        if (!previous || !current) continue
        const delta = current.along - previous.along
        if (delta > TURN_PROFILE_TOLERANCE) ascending += 1
        if (delta < -TURN_PROFILE_TOLERANCE) descending += 1
      }
      if (ascending > 0 && descending > 0) return 'profileDoublesBack'
    }
  }
  if (!(maxAlong - minAlong > TURN_PROFILE_TOLERANCE)) return 'profileEmpty'
  if (!(maxRadius > TURN_PROFILE_TOLERANCE)) return 'profileEmpty'
  return null
}

/**
 * Validate untrusted stored profile data. Returns `null` when the copy cannot
 * be revolved, so a corrupt file never draws a different Turn.
 */
export function normalizeTurnCannedProfile(
  raw: unknown,
  frame: RotarySolidFrame,
): TurnCannedProfile | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const candidate = raw as Record<string, unknown>
  if (typeof candidate.sourceFeatureId !== 'string' || candidate.sourceFeatureId.length === 0) return null
  if (!Array.isArray(candidate.contours)) return null
  const contours: TurnProfileContour[] = []
  for (const rawContour of candidate.contours) {
    if (rawContour === null || typeof rawContour !== 'object' || Array.isArray(rawContour)) return null
    const contour = rawContour as Record<string, unknown>
    if (typeof contour.closed !== 'boolean' || !Array.isArray(contour.points)) return null
    const points: TurnProfilePoint[] = []
    for (const rawPoint of contour.points) {
      if (rawPoint === null || typeof rawPoint !== 'object' || Array.isArray(rawPoint)) return null
      const point = rawPoint as Record<string, unknown>
      if (!isFiniteNumber(point.along) || !isFiniteNumber(point.radius)) return null
      points.push({ along: point.along, radius: point.radius })
    }
    contours.push({ points, closed: contour.closed })
  }
  const profile: TurnCannedProfile = {
    sourceFeatureId: candidate.sourceFeatureId,
    contours,
  }
  if (typeof candidate.sourceName === 'string' && candidate.sourceName.length > 0) {
    profile.sourceName = candidate.sourceName
  }
  return turnProfileProblem(profile, frame) === null ? profile : null
}

/** Absolute along extent of the copied profile. */
export function turnProfileAlongRange(profile: TurnCannedProfile): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const contour of profile.contours) {
    for (const point of contour.points) {
      min = Math.min(min, point.along)
      max = Math.max(max, point.along)
    }
  }
  return { min, max }
}

/** The largest radius the copied profile reaches. */
export function turnProfileMaxRadius(profile: TurnCannedProfile): number {
  let max = 0
  for (const contour of profile.contours) {
    for (const point of contour.points) max = Math.max(max, point.radius)
  }
  return max
}

/**
 * The dialog numbers a copied profile stands for: start and length from the
 * chuck end, diameter at its widest. These are stored with the profile so
 * Properties, unit conversion and older readers keep a meaningful summary;
 * the profile itself is the geometry.
 */
export function turnProfileBand(
  frame: RotarySolidFrame,
  profile: TurnCannedProfile,
): { start: number; length: number; diameter: number } {
  const { min, max } = turnProfileAlongRange(profile)
  const length = max - min
  return {
    start: frame.axis === 'x' ? min - frame.alongMin : frame.alongMax - max,
    length,
    diameter: 2 * turnProfileMaxRadius(profile),
  }
}

/** The outer radius of the revolved solid at one along position, or null. */
export function turnProfileRadiusAt(
  profile: TurnCannedProfile,
  along: number,
): number | null {
  let best: number | null = null
  for (const contour of profile.contours) {
    const points = contour.points
    if (points.length === 0) continue
    const edgeCount = contour.closed ? points.length : points.length - 1
    for (let index = 0; index < edgeCount; index += 1) {
      const start = points[index]
      const end = points[(index + 1) % points.length]
      if (!start || !end) continue
      if (near(start.along, end.along)) {
        if (near(along, start.along)) {
          best = Math.max(best ?? 0, start.radius, end.radius)
        }
        continue
      }
      const low = Math.min(start.along, end.along)
      const high = Math.max(start.along, end.along)
      if (along < low - TURN_PROFILE_TOLERANCE || along > high + TURN_PROFILE_TOLERANCE) continue
      const span = end.along - start.along
      const t = Math.min(1, Math.max(0, (along - start.along) / span))
      const radius = start.radius + t * (end.radius - start.radius)
      best = Math.max(best ?? 0, radius)
    }
  }
  return best
}

interface ProfileSpan {
  low: number
  high: number
  /** Radius at the span's low end. */
  lowRadius: number
  /** Radius at the span's high end. */
  highRadius: number
}

/**
 * The radius range over a band, and whether the profile has a vertical step in
 * it (a diameter change, as opposed to a taper). Used by Thread/Flutes to
 * decide whether they can take a Turn's diameter automatically.
 *
 * The range is read from the profile's actual segments, not from samples: a
 * short groove or taper between two samples is part of the surface and must be
 * classified. `turnProfileRadiusAt` only sees one station at a time, so this
 * walks the linear pieces of the outer envelope instead.
 *
 * Thread/Flutes are already refused when two Turns overlap, so this function
 * only has to resolve one copied profile's own contours: the outer envelope is
 * the maximum radius of every segment covering an along position.
 */
export function turnProfileRadiusRange(
  profile: TurnCannedProfile,
  alongStart: number,
  alongEnd: number,
): { min: number; max: number; step: boolean } | null {
  const low = Math.min(alongStart, alongEnd)
  const high = Math.max(alongStart, alongEnd)
  const spans: ProfileSpan[] = []
  let step = false
  for (const contour of profile.contours) {
    const points = contour.points
    const edgeCount = contour.closed ? points.length : points.length - 1
    for (let index = 0; index < edgeCount; index += 1) {
      const start = points[index]
      const end = points[(index + 1) % points.length]
      if (!start || !end) continue
      if (near(start.along, end.along)) {
        // A vertical face changes the diameter, but the radii on either side
        // belong to the segments that touch it; the face itself has no width.
        if (Math.abs(start.radius - end.radius) <= TURN_PROFILE_TOLERANCE) continue
        if (start.along < low - TURN_PROFILE_TOLERANCE || start.along > high + TURN_PROFILE_TOLERANCE) continue
        step = true
        continue
      }
      const spanLow = Math.min(start.along, end.along)
      const spanHigh = Math.max(start.along, end.along)
      if (spanHigh < low - TURN_PROFILE_TOLERANCE || spanLow > high + TURN_PROFILE_TOLERANCE) continue
      spans.push({
        low: spanLow,
        high: spanHigh,
        lowRadius: start.along <= end.along ? start.radius : end.radius,
        highRadius: start.along <= end.along ? end.radius : start.radius,
      })
    }
  }
  if (spans.length === 0) return null

  const radiusAt = (span: ProfileSpan, along: number): number => (
    span.lowRadius
    + ((along - span.low) / (span.high - span.low)) * (span.highRadius - span.lowRadius)
  )

  // The envelope is piecewise linear with breaks at every segment end and at
  // every crossing of two overlapping pieces. Between two breaks it is one
  // line, so its one-sided limits at the breaks give the exact range. Those
  // limits matter: a groove's floor is the limit inside the groove, while the
  // exact vertex is shared with the vertical face.
  const breaks = new Set<number>([low, high])
  for (const span of spans) {
    for (const value of [span.low, span.high]) {
      if (value > low + TURN_PROFILE_TOLERANCE && value < high - TURN_PROFILE_TOLERANCE) breaks.add(value)
    }
  }
  for (let first = 0; first < spans.length; first += 1) {
    for (let second = first + 1; second < spans.length; second += 1) {
      const a = spans[first]
      const b = spans[second]
      if (!a || !b) continue
      const slopeA = (a.highRadius - a.lowRadius) / (a.high - a.low)
      const slopeB = (b.highRadius - b.lowRadius) / (b.high - b.low)
      if (Math.abs(slopeA - slopeB) <= TURN_PROFILE_TOLERANCE) continue
      const overlapLow = Math.max(low, a.low, b.low)
      const overlapHigh = Math.min(high, a.high, b.high)
      if (overlapHigh < overlapLow - TURN_PROFILE_TOLERANCE) continue
      const crossing = (b.lowRadius - a.lowRadius + slopeA * a.low - slopeB * b.low) / (slopeA - slopeB)
      if (crossing > low && crossing < high) breaks.add(crossing)
    }
  }

  const stations = [...breaks].sort((a, b) => a - b)
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  let found = false
  const consider = (radius: number): void => {
    found = true
    min = Math.min(min, radius)
    max = Math.max(max, radius)
  }
  for (let index = 0; index < stations.length - 1; index += 1) {
    const start = stations[index]
    const end = stations[index + 1]
    if (start === undefined || end === undefined || end - start <= TURN_PROFILE_TOLERANCE) continue
    const middle = (start + end) / 2
    const active = spans.filter((span) => span.low <= middle && span.high >= middle)
    if (active.length === 0) continue
    for (const station of [start, end]) {
      let envelope = Number.NEGATIVE_INFINITY
      for (const span of active) envelope = Math.max(envelope, radiusAt(span, station))
      consider(envelope)
    }
  }
  if (!found) return null
  return { min, max, step }
}

/** Convert stored profile parameters when the project changes units. */
export function convertTurnCannedProfile(
  profile: TurnCannedProfile,
  convertLength: (value: number) => number,
): TurnCannedProfile {
  return {
    ...profile,
    contours: profile.contours.map((contour) => ({
      closed: contour.closed,
      points: contour.points.map((point) => ({
        along: convertLength(point.along),
        radius: convertLength(point.radius),
      })),
    })),
  }
}
