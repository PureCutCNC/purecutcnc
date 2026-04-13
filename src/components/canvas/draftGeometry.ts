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

import type { SnapMode } from '../../sketch/snapping'
import type { SketchInsertTarget } from '../../store/types'
import { bezierPoint, sampleProfilePoints } from '../../types/project'
import type { Point, Segment, SketchFeature, SketchProfile } from '../../types/project'
import { anchorPointForIndex, arcControlPoint } from './profilePrimitives'
import { distance2, pointInProfile, pointsEqual } from './hitTest'
import { worldToCanvas } from './viewTransform'
import type { CanvasPoint, ViewTransform } from './viewTransform'

export function addPoint(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y }
}

export function subtractPoint(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y }
}

export function scalePoint(point: Point, scale: number): Point {
  return { x: point.x * scale, y: point.y * scale }
}

export function lerpPoint(a: Point, b: Point, t: number): Point {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  }
}

function dotPoint(a: Point, b: Point): number {
  return a.x * b.x + a.y * b.y
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

export function appendSplineDraftSegment(
  start: Point,
  segments: Segment[],
  to: Point,
): Segment[] {
  const anchors = [start, ...segments.map((segment) => segment.to)]
  const current = anchors[anchors.length - 1]
  const previous = anchors.length >= 2 ? anchors[anchors.length - 2] : current

  const tangent = scalePoint(subtractPoint(to, previous), 1 / 6)
  const nextSegment: Segment = {
    type: 'bezier',
    control1: addPoint(current, tangent),
    control2: subtractPoint(to, scalePoint(subtractPoint(to, current), 1 / 6)),
    to,
  }

  if (segments.length === 0 || segments[segments.length - 1].type !== 'bezier') {
    return [...segments, nextSegment]
  }

  const updatedSegments = [...segments]
  const previousSegment = updatedSegments[updatedSegments.length - 1]
  if (previousSegment.type === 'bezier') {
    updatedSegments[updatedSegments.length - 1] = {
      ...previousSegment,
      control2: subtractPoint(current, tangent),
    }
  }

  updatedSegments.push(nextSegment)
  return updatedSegments
}

export function buildSplineDraftSegments(points: Point[], previewPoint: Point | null): Segment[] {
  if (points.length === 0) {
    return []
  }

  let segments: Segment[] = []
  for (let index = 1; index < points.length; index += 1) {
    segments = appendSplineDraftSegment(points[0], segments, points[index])
  }

  if (previewPoint && !pointsEqual(previewPoint, points[points.length - 1])) {
    segments = appendSplineDraftSegment(points[0], segments, previewPoint)
  }

  return segments
}

export function isLoopCloseCandidate(
  point: CanvasPoint,
  loopPoints: Point[],
  vt: ViewTransform,
  closeRadiusPx: number,
): boolean {
  if (loopPoints.length < 3) return false
  const start = worldToCanvas(loopPoints[0], vt)
  return distance2(point, start) <= closeRadiusPx * closeRadiusPx
}

export function midpoint(a: Point, b: Point): Point {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  }
}

export function segmentMidpoint(start: Point, segment: Segment): Point {
  if (segment.type === 'line') {
    return midpoint(start, segment.to)
  }

  if (segment.type === 'bezier') {
    return bezierPoint(start, segment.control1, segment.control2, segment.to, 0.5)
  }

  return arcControlPoint(start, segment)
}

export function projectPointOntoLine(point: Point, lineStart: Point, lineEnd: Point): Point {
  const direction = subtractPoint(lineEnd, lineStart)
  const lengthSq = dotPoint(direction, direction)
  if (lengthSq <= 1e-9) {
    return lineStart
  }

  const t = dotPoint(subtractPoint(point, lineStart), direction) / lengthSq
  return addPoint(lineStart, scalePoint(direction, t))
}

export function projectPointOntoSegment(point: Point, lineStart: Point, lineEnd: Point): Point {
  const direction = subtractPoint(lineEnd, lineStart)
  const lengthSq = dotPoint(direction, direction)
  if (lengthSq <= 1e-9) {
    return lineStart
  }

  const t = clamp01(dotPoint(subtractPoint(point, lineStart), direction) / lengthSq)
  return addPoint(lineStart, scalePoint(direction, t))
}

export function sampleSegmentPolyline(start: Point, segment: Segment): Point[] {
  if (segment.type === 'line') {
    return [start, segment.to]
  }

  if (segment.type === 'bezier') {
    const points: Point[] = [start]
    for (let sample = 1; sample <= 12; sample += 1) {
      points.push(bezierPoint(start, segment.control1, segment.control2, segment.to, sample / 12))
    }
    return points
  }

  const profile: SketchProfile = {
    start,
    segments: [segment],
    closed: false,
  }
  return sampleProfilePoints(profile, 12, Math.PI / 18)
}

export function nearestPointOnPolyline(point: Point, polyline: Point[]): Point {
  let bestPoint = polyline[0]
  let bestDistanceSq = Infinity

  for (let index = 0; index < polyline.length - 1; index += 1) {
    const projected = projectPointOntoSegment(point, polyline[index], polyline[index + 1])
    const dx = projected.x - point.x
    const dy = projected.y - point.y
    const distanceSq = dx * dx + dy * dy
    if (distanceSq < bestDistanceSq) {
      bestDistanceSq = distanceSq
      bestPoint = projected
    }
  }

  return bestPoint
}

export function segmentPointAt(start: Point, segment: Segment, t: number): Point {
  if (segment.type === 'line') {
    return lerpPoint(start, segment.to, t)
  }

  if (segment.type === 'bezier') {
    return bezierPoint(start, segment.control1, segment.control2, segment.to, t)
  }

  const startAngle = Math.atan2(start.y - segment.center.y, start.x - segment.center.x)
  const endAngle = Math.atan2(segment.to.y - segment.center.y, segment.to.x - segment.center.x)
  const radius = Math.hypot(start.x - segment.center.x, start.y - segment.center.y)

  let sweep = endAngle - startAngle
  if (segment.clockwise && sweep > 0) {
    sweep -= Math.PI * 2
  } else if (!segment.clockwise && sweep < 0) {
    sweep += Math.PI * 2
  }

  const angle = startAngle + sweep * t
  return {
    x: segment.center.x + Math.cos(angle) * radius,
    y: segment.center.y + Math.sin(angle) * radius,
  }
}

export function nearestPointOnSegmentWithT(
  point: Point,
  start: Point,
  segment: Segment,
  vt: ViewTransform,
): { point: Point; t: number; distanceSqPx: number } {
  if (segment.type === 'line') {
    const direction = subtractPoint(segment.to, start)
    const lengthSq = dotPoint(direction, direction)
    const t = lengthSq <= 1e-9 ? 0 : clamp01(dotPoint(subtractPoint(point, start), direction) / lengthSq)
    const projected = addPoint(start, scalePoint(direction, t))
    return {
      point: projected,
      t,
      distanceSqPx: distance2(worldToCanvas(projected, vt), worldToCanvas(point, vt)),
    }
  }

  let bestT = 0
  let bestPoint = start
  let bestDistanceSqPx = Infinity

  for (let step = 1; step < 48; step += 1) {
    const t = step / 48
    const candidate = segmentPointAt(start, segment, t)
    const distanceSqPx = distance2(worldToCanvas(candidate, vt), worldToCanvas(point, vt))
    if (distanceSqPx < bestDistanceSqPx) {
      bestT = t
      bestPoint = candidate
      bestDistanceSqPx = distanceSqPx
    }
  }

  return {
    point: bestPoint,
    t: bestT,
    distanceSqPx: bestDistanceSqPx,
  }
}

function nearestPointOnProfileBoundary(point: Point, profile: SketchProfile, vt: ViewTransform): { point: Point; distance: number } | null {
  if (profile.segments.length === 0) {
    return null
  }

  let bestPoint: Point | null = null
  let bestDistanceSq = Infinity

  for (let index = 0; index < profile.segments.length; index += 1) {
    const start = anchorPointForIndex(profile, index)
    const segment = profile.segments[index]
    const candidate = nearestPointOnSegmentWithT(point, start, segment, vt)
    const dx = candidate.point.x - point.x
    const dy = candidate.point.y - point.y
    const distanceSq = dx * dx + dy * dy
    if (distanceSq < bestDistanceSq) {
      bestDistanceSq = distanceSq
      bestPoint = candidate.point
    }
  }

  return bestPoint ? { point: bestPoint, distance: Math.sqrt(bestDistanceSq) } : null
}

function resolveOffsetPreviewInput(features: SketchFeature[], point: Point, vt: ViewTransform): {
  nearestPoint: Point
  distance: number
  signedDistance: number
  direction: 'in' | 'out'
} | null {
  let nearestPoint: Point | null = null
  let nearestDistance = Infinity

  for (const feature of features) {
    const candidate = nearestPointOnProfileBoundary(point, feature.sketch.profile, vt)
    if (!candidate) {
      continue
    }
    if (candidate.distance < nearestDistance) {
      nearestDistance = candidate.distance
      nearestPoint = candidate.point
    }
  }

  if (!nearestPoint || !Number.isFinite(nearestDistance) || nearestDistance <= 1e-9) {
    return null
  }

  const direction = features.some((feature) => pointInProfile(point.x, point.y, feature.sketch.profile)) ? 'in' : 'out'
  return {
    nearestPoint,
    distance: nearestDistance,
    signedDistance: direction === 'in' ? -nearestDistance : nearestDistance,
    direction,
  }
}

export function resolveOffsetPreview(
  features: SketchFeature[],
  rawPoint: Point,
  snappedPoint: Point,
  snapMode: SnapMode | null,
  vt: ViewTransform,
): {
  nearestPoint: Point
  distance: number
  signedDistance: number
  direction: 'in' | 'out'
} | null {
  const snappedPreview = resolveOffsetPreviewInput(features, snappedPoint, vt)
  if (snapMode && snapMode !== 'line' && snapMode !== 'perpendicular') {
    return snappedPreview
  }

  if (!snappedPreview) {
    return resolveOffsetPreviewInput(features, rawPoint, vt)
  }

  if (snappedPreview.distance > 1e-5 || pointsEqual(rawPoint, snappedPoint, 1e-9)) {
    return snappedPreview
  }

  if (snapMode === 'line' || snapMode === 'perpendicular') {
    return resolveOffsetPreviewInput(features, rawPoint, vt) ?? snappedPreview
  }

  return snappedPreview
}

export function findSketchInsertTarget(
  profile: SketchProfile,
  snappedPoint: Point,
  vt: ViewTransform,
): SketchInsertTarget | null {
  let best: SketchInsertTarget | null = null
  let bestDistanceSqPx = 9 * 9

  for (let index = 0; index < profile.segments.length; index += 1) {
    const start = anchorPointForIndex(profile, index)
    const segment = profile.segments[index]
    const candidate = nearestPointOnSegmentWithT(snappedPoint, start, segment, vt)
    if (candidate.distanceSqPx >= bestDistanceSqPx) {
      continue
    }
    if (candidate.t <= 1e-3 || candidate.t >= 1 - 1e-3) {
      continue
    }
    bestDistanceSqPx = candidate.distanceSqPx
    best = {
      kind: 'segment',
      segmentIndex: index,
      point: candidate.point,
      t: candidate.t,
    }
  }

  return best
}
