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

import { rectProfile, sampleProfilePoints } from '../../types/project'
import type { CannedShapeData, Clamp, FeatureOperation, Matrix2D, Point, Project, SketchProfile, Tab } from '../../types/project'
import type { CanvasPoint, ViewTransform } from './viewTransform'
import { editableProjectFeatures, activeFace } from '../../store/helpers/activeFace'
import type { ResolvedSketchFeature } from '../../store/helpers/resolveFeatures'
import { resolveProfileSegments } from '../../store/helpers/resolveProfileSegments'
import type { ArcSeg } from '../../store/helpers/segmentIntersection'
import { isCannedFeature, resolveCannedShapeShapes } from '../../cannedShapes'
import { foldProfileToSheet } from './aroundDisplayWrap'
import type { AroundWrapWindow } from './aroundDisplayWrap'
import { aroundFrame } from '../../engine/aroundFrame'
import { isBarStock } from '../../types/barStock'

export interface FeatureLike {
  id: string
  visible: boolean
  sketch: { profile: SketchProfile }
  /** Generated shapes hit-test their outlines, never the stored placement frame. */
  canned?: CannedShapeData | null
  transform?: Matrix2D
  operation?: FeatureOperation
}

export type FeatureSelectionHit =
  | { kind: 'none'; candidateIds: [] }
  | { kind: 'direct'; featureId: string; candidateIds: string[] }
  | { kind: 'ambiguous'; candidateIds: string[] }

export interface SegmentHitResult {
  featureId: string
  segmentIndex: number
  point: Point
  t: number
}

export function pointInProfile(x: number, y: number, profile: SketchProfile): boolean {
  if (!profile.closed) {
    return false
  }

  const points = sampleProfilePoints(profile)
  if (points.length < 3) return false

  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const xi = points[i].x
    const yi = points[i].y
    const xj = points[j].x
    const yj = points[j].y

    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    if (intersects) inside = !inside
  }

  return inside
}

/**
 * True when every sampled point of `inner` lies inside `outer` — i.e. `inner`
 * is fully enclosed by `outer` regardless of draw order. Coincident profiles
 * may return true in both directions; callers handle that as a tie.
 */
function profileContainedIn(inner: SketchProfile, outer: SketchProfile): boolean {
  const innerPoints = sampleProfilePoints(inner)
  if (innerPoints.length < 3) return false
  return innerPoints.every((point) => pointInProfile(point.x, point.y, outer))
}

/**
 * Picks the feature an interior hit resolves to: the unique innermost candidate
 * (fully enclosed by every other candidate, regardless of draw order) when one
 * exists, otherwise the topmost candidate — the first in `candidates`. Shared
 * by click resolution, hover, and drag-pick so the highlight always predicts
 * what a click selects.
 */
function resolveInnermostOrTopmostId(
  candidates: { id: string; profile: SketchProfile }[],
): string | null {
  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0].id

  const containingSets = candidates.map((candidate) =>
    candidates.filter(
      (other) => other !== candidate && profileContainedIn(candidate.profile, other.profile),
    ),
  )
  const maxContaining = Math.max(0, ...containingSets.map((set) => set.length))
  const innermost = candidates.filter(
    (_, index) => maxContaining > 0 && containingSets[index].length === maxContaining,
  )
  if (innermost.length === 1) return innermost[0].id
  return candidates[0].id
}

function distancePointToSegment(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x
  const dy = end.y - start.y
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) {
    return Math.hypot(point.x - start.x, point.y - start.y)
  }

  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)))
  const projection = {
    x: start.x + dx * t,
    y: start.y + dy * t,
  }
  return Math.hypot(point.x - projection.x, point.y - projection.y)
}

export function pointNearProfile(worldPoint: Point, profile: SketchProfile, vt: ViewTransform, tolerancePx = 8): boolean {
  const points = sampleProfilePoints(profile)
  if (points.length < 2) {
    return false
  }

  const toleranceWorld = tolerancePx / Math.max(vt.scale, 1e-6)
  const segmentCount = profile.closed ? points.length : points.length - 1
  for (let index = 0; index < segmentCount; index += 1) {
    const start = points[index]
    const end = points[(index + 1) % points.length]
    if (distancePointToSegment(worldPoint, start, end) <= toleranceWorld) {
      return true
    }
  }

  return false
}

// ── helpers for arc distance in segmentHitTest ────────────────────────

const TWO_PI = 2 * Math.PI
const EPS = 1e-9

function normAngle(a: number): number {
  return ((a % TWO_PI) + TWO_PI) % TWO_PI
}

/**
 * Test whether an angle lies within a resolved arc's sweep, and if so return
 * the parametric position t ∈ [0,1] along the sweep.
 */
function angleInSweepT(angle: number, arc: ArcSeg): number | null {
  const na = normAngle(angle)
  const nA0 = normAngle(arc.a0)

  let sweepAngle: number
  let distToAngle: number

  if (arc.ccw) {
    const rawDiff = arc.a1 - arc.a0
    sweepAngle = rawDiff
    while (sweepAngle < 0) sweepAngle += TWO_PI
    sweepAngle %= TWO_PI
    if (sweepAngle < EPS && Math.abs(rawDiff) + EPS >= TWO_PI) sweepAngle = TWO_PI
    if (sweepAngle < EPS) return null

    distToAngle = normAngle(na - nA0)
    if (TWO_PI - distToAngle < EPS) distToAngle = 0
  } else {
    const rawDiff = arc.a0 - arc.a1
    sweepAngle = rawDiff
    while (sweepAngle < 0) sweepAngle += TWO_PI
    sweepAngle %= TWO_PI
    if (sweepAngle < EPS && Math.abs(rawDiff) + EPS >= TWO_PI) sweepAngle = TWO_PI
    if (sweepAngle < EPS) return null

    distToAngle = normAngle(nA0 - na)
    if (TWO_PI - distToAngle < EPS) distToAngle = 0
  }

  const t = distToAngle / sweepAngle
  if (distToAngle <= sweepAngle + EPS) return Math.min(Math.max(t, 0), 1)
  return null
}

function arcEndpoint(center: Point, radius: number, angle: number): Point {
  return {
    x: center.x + Math.cos(angle) * radius,
    y: center.y + Math.sin(angle) * radius,
  }
}

/**
 * Closest-point distance from a world point to a resolved arc, with parametric
 * position `t` ∈ [0,1] and the actual closest point on the arc.
 */
function distancePointToArc(
  wp: Point,
  arc: ArcSeg,
): { dist: number; point: Point; t: number } {
  const dCenter = Math.hypot(wp.x - arc.center.x, wp.y - arc.center.y)
  const angle = Math.atan2(wp.y - arc.center.y, wp.x - arc.center.x)

  const tSweep = angleInSweepT(angle, arc)
  if (tSweep !== null) {
    // Point projects onto the arc interior
    const dist = Math.abs(dCenter - arc.radius)
    const point = arcEndpoint(arc.center, arc.radius, angle)
    return { dist, point, t: tSweep }
  }

  // Point is outside the sweep — closest to one of the endpoints
  const ep0 = arcEndpoint(arc.center, arc.radius, arc.a0)
  const ep1 = arcEndpoint(arc.center, arc.radius, arc.a1)
  const d0 = Math.hypot(wp.x - ep0.x, wp.y - ep0.y)
  const d1 = Math.hypot(wp.x - ep1.x, wp.y - ep1.y)

  if (d0 <= d1) {
    return { dist: d0, point: ep0, t: 0 }
  }
  return { dist: d1, point: ep1, t: 1 }
}

// ── segmentHitTest (true profile.segments index) ──────────────────────

export function segmentHitTest(
  worldPoint: Point,
  project: Project,
  vt: ViewTransform,
  opts: { openOnly: boolean; referenceFeatures?: readonly ResolvedSketchFeature[] },
  tolerancePx = 8,
): SegmentHitResult | null {
  const features = opts.referenceFeatures ?? editableProjectFeatures(project)
  const toleranceWorld = tolerancePx / Math.max(vt.scale, 1e-6)
  // On Around, canned outlines are drawn folded, so a folded stripe is what the
  // reference pick must find (issue #1112 L). The frame is all the fold needs;
  // building the full sheet would resolve every model band on every pick.
  const sheet = activeFace(project) === 'around' && isBarStock(project.stock)
    ? aroundFrame(project.stock)
    : null

  let bestDist = Infinity
  let best: SegmentHitResult | null = null

  for (const feature of features) {
    if (!feature.visible) continue

    // A generated shape's editable-segment index means nothing (it has no
    // editable sketch), but reference picking must still find the drawn lines
    // rather than the frame (#1112 A2).
    for (const profile of featureHitProfiles(feature, sheet)) {
      if (opts.openOnly && profile.closed) continue

      const resolved = resolveProfileSegments(profile)
      if (resolved.length === 0) continue

      for (let index = 0; index < resolved.length; index += 1) {
        const seg = resolved[index]
        if (!seg) continue // bezier → skip

        let dist: number
        let point: Point
        let t: number

        if (seg.kind === 'line') {
          const dx = seg.p1.x - seg.p0.x
          const dy = seg.p1.y - seg.p0.y
          const len2 = dx * dx + dy * dy
          if (len2 < EPS) {
            // Degenerate line (point)
            dist = Math.hypot(worldPoint.x - seg.p0.x, worldPoint.y - seg.p0.y)
            point = seg.p0
            t = 0
          } else {
            t = Math.max(0, Math.min(1,
              ((worldPoint.x - seg.p0.x) * dx + (worldPoint.y - seg.p0.y) * dy) / len2,
            ))
            point = {
              x: seg.p0.x + dx * t,
              y: seg.p0.y + dy * t,
            }
            dist = Math.hypot(worldPoint.x - point.x, worldPoint.y - point.y)
          }
        } else {
          // arc
          const result = distancePointToArc(worldPoint, seg)
          dist = result.dist
          point = result.point
          t = result.t
        }

        if (dist <= toleranceWorld && dist < bestDist) {
          bestDist = dist
          best = {
            featureId: feature.id,
            segmentIndex: index, // TRUE profile.segments index
            point,
            t,
          }
        }
      }
    }
  }

  return best
}

/**
 * The profiles a feature is actually drawn from. A generated (canned) shape
 * stores only its placement frame in `sketch.profile`; hit testing against that
 * frame would make the empty space between generated lines — or outside a
 * curved outline — clickable, so the generated outlines are used instead
 * (issue #1112 A2). On the Around sheet the drawn outlines are folded into the
 * sheet, so a folded stripe is hit where it is drawn (issue #1112 L).
 */
export function featureHitProfiles(
  feature: FeatureLike,
  sheet?: AroundWrapWindow | null,
): SketchProfile[] {
  let profiles: SketchProfile[] | null = null
  if (isCannedFeature(feature) && feature.operation) {
    const shapes = resolveCannedShapeShapes({
      operation: feature.operation,
      canned: feature.canned,
      transform: feature.transform,
    })
    if (shapes.length > 0) profiles = shapes.map((shape) => shape.profile)
  }
  if (profiles === null) profiles = [feature.sketch.profile]
  if (!sheet || !isCannedFeature(feature)) return profiles
  const folded = profiles.flatMap((profile) => foldProfileToSheet(profile, sheet))
  return folded.length > 0 ? folded : profiles
}

function featureProfileHit(
  feature: FeatureLike,
  worldPoint: Point,
  vt: ViewTransform,
  sheet?: AroundWrapWindow | null,
): {
  hit: boolean
  nearOutline: boolean
} {
  let hit = false
  let nearOutline = false
  for (const profile of featureHitProfiles(feature, sheet)) {
    if (pointNearProfile(worldPoint, profile, vt)) {
      hit = true
      nearOutline = true
    } else if (pointInProfile(worldPoint.x, worldPoint.y, profile)) {
      hit = true
    }
  }
  return { hit, nearOutline }
}

function featureContainsPoint(
  feature: FeatureLike,
  worldPoint: Point,
  vt: ViewTransform,
  sheet?: AroundWrapWindow | null,
): boolean {
  return featureProfileHit(feature, worldPoint, vt, sheet).hit
}

/**
 * Returns every visible feature at a point in topmost-first draw order.
 *
 * The selection UI uses this to disambiguate overlaps. Callers that only need
 * the topmost feature should keep using {@link findHitFeatureId}.
 */
export function findHitFeatureIds(
  worldPoint: Point,
  features: readonly FeatureLike[],
  vt: ViewTransform,
  sheet?: AroundWrapWindow | null,
): string[] {
  const hitIds: string[] = []
  for (let index = features.length - 1; index >= 0; index -= 1) {
    const feature = features[index]
    if (!feature.visible) continue
    if (featureContainsPoint(feature, worldPoint, vt, sheet)) hitIds.push(feature.id)
  }
  return hitIds
}

/**
 * Resolves ordinary feature selection without interrupting a clear outline
 * click. An interior-only click over several shapes prefers the unique
 * innermost candidate — a shape fully enclosed by the others, whatever the
 * draw order — and falls back to the topmost candidate; the hover highlight
 * uses the same resolution, so it always predicts the click (issue #521).
 * Only a click on two or more coincident outlines stays ambiguous so the
 * overlap picker can expose every candidate.
 */
export function resolveFeatureSelectionHit(
  worldPoint: Point,
  features: readonly FeatureLike[],
  vt: ViewTransform,
  sheet?: AroundWrapWindow | null,
): FeatureSelectionHit {
  const candidates: { id: string; profile: SketchProfile }[] = []
  const nearbyOutlineIds: string[] = []

  for (let index = features.length - 1; index >= 0; index -= 1) {
    const feature = features[index]
    if (!feature.visible) continue

    const profiles = featureHitProfiles(feature, sheet)
    const outlineHit = featureProfileHit(feature, worldPoint, vt, sheet)
    if (!outlineHit.hit) {
      continue
    }

    // Nesting resolution still needs one representative contour; generators
    // emit the outer contour first, so that is the shape's extent.
    candidates.push({ id: feature.id, profile: profiles[0] })
    if (outlineHit.nearOutline) nearbyOutlineIds.push(feature.id)
  }

  const candidateIds = candidates.map((candidate) => candidate.id)

  if (candidates.length === 0) {
    return { kind: 'none', candidateIds: [] }
  }
  if (candidates.length === 1) {
    return { kind: 'direct', featureId: candidates[0].id, candidateIds }
  }
  if (nearbyOutlineIds.length === 1) {
    return { kind: 'direct', featureId: nearbyOutlineIds[0], candidateIds }
  }
  if (nearbyOutlineIds.length === 0) {
    // Interior-only click across several shapes: the same innermost-or-topmost
    // resolution the hover highlight previews.
    return {
      kind: 'direct',
      featureId: resolveInnermostOrTopmostId(candidates) ?? candidates[0].id,
      candidateIds,
    }
  }
  return { kind: 'ambiguous', candidateIds }
}

export function findHitFeatureId(
  worldPoint: Point,
  features: readonly FeatureLike[],
  vt: ViewTransform,
  sheet?: AroundWrapWindow | null,
): string | null {
  const candidates: { id: string; profile: SketchProfile }[] = []
  for (let index = features.length - 1; index >= 0; index -= 1) {
    const feature = features[index]
    if (!feature.visible) continue
    if (featureContainsPoint(feature, worldPoint, vt, sheet)) {
      candidates.push({ id: feature.id, profile: featureHitProfiles(feature, sheet)[0] })
    }
  }
  return resolveInnermostOrTopmostId(candidates)
}

function pointInRect(point: Point, minX: number, minY: number, maxX: number, maxY: number): boolean {
  return point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY
}

export function featureFullyInsideRect(
  feature: FeatureLike,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  sheet?: AroundWrapWindow | null,
): boolean {
  let sawPoints = false
  for (const profile of featureHitProfiles(feature, sheet)) {
    const points = sampleProfilePoints(profile)
    if (points.length === 0) {
      return false
    }
    sawPoints = true
    if (!points.every((point) => pointInRect(point, minX, minY, maxX, maxY))) {
      return false
    }
  }
  return sawPoints
}

export function findHitClampId(worldPoint: Point, clamps: Clamp[]): string | null {
  for (let index = clamps.length - 1; index >= 0; index -= 1) {
    const clamp = clamps[index]
    if (!clamp.visible) continue
    if (pointInProfile(worldPoint.x, worldPoint.y, rectProfile(clamp.x, clamp.y, clamp.w, clamp.h))) {
      return clamp.id
    }
  }
  return null
}

export function findHitTabId(worldPoint: Point, tabs: Tab[]): string | null {
  for (let index = tabs.length - 1; index >= 0; index -= 1) {
    const tab = tabs[index]
    if (!tab.visible) continue
    if (pointInProfile(worldPoint.x, worldPoint.y, rectProfile(tab.x, tab.y, tab.w, tab.h))) {
      return tab.id
    }
  }
  return null
}

export function distance2(a: CanvasPoint, b: CanvasPoint): number {
  const dx = a.cx - b.cx
  const dy = a.cy - b.cy
  return dx * dx + dy * dy
}

export function pointsEqual(a: Point, b: Point, epsilon = 1e-9): boolean {
  return Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon
}
