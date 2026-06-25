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

import type { SnapMode, SnapSettings } from '../../sketch/snapping'
import { profileVertices, rectProfile } from '../../types/project'
import type { AnchorTarget, ConstraintIntersectionReference, DimensionAnchor, Point, Project, SketchProfile } from '../../types/project'
import { resolvedProjectFeatures } from '../../store/helpers/resolveFeatures'
import { resolveProfileSegments } from '../../store/helpers/resolveProfileSegments'
import { segmentIntersections } from '../../store/helpers/segmentIntersection'
import { distance2 } from './hitTest'
import {
  nearestPointOnPolyline,
  projectPointOntoSegment,
  sampleSegmentPolyline,
  segmentMidpoint,
} from './draftGeometry'
import { anchorPointForIndex } from './profilePrimitives'
import { worldToCanvas } from './viewTransform'
import type { ViewTransform } from './viewTransform'

export interface SnapGuide {
  kind: 'projection' | 'perpendicular'
  from: Point
  to: Point
}

export type SnapIntersectionReference = ConstraintIntersectionReference

interface SnapCandidate {
  mode: SnapMode
  point: Point
  distancePx: number
  priority: number
  guide?: SnapGuide
  perpendicularSegment?: { a: Point; b: Point }
  intersection?: SnapIntersectionReference
  // Provenance: what geometry produced this snap, so a dimension placed here can
  // anchor to it and follow the geometry when it moves. Absent for grid/line/
  // perpendicular snaps (no stable geometry identity).
  anchor?: DimensionAnchor
}

interface SnapProfileGeometry {
  profile: SketchProfile
  source?: AnchorTarget
}

type ResolvedProfileSegment = NonNullable<ReturnType<typeof resolveProfileSegments>[number]>

interface SegmentBounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

export interface ResolvedSnap {
  rawPoint: Point
  point: Point
  mode: SnapMode | null
  guide?: SnapGuide
  perpendicularSegment?: { a: Point; b: Point }
  intersection?: SnapIntersectionReference
  /** Anchor describing the snapped geometry, when the snap has stable identity. */
  anchor?: DimensionAnchor
  /** Epoch time until which the transient label should be drawn. */
  labelVisibleUntil?: number
}

function distanceToCanvas(a: { cx: number; cy: number }, b: { cx: number; cy: number }): number {
  return Math.sqrt(distance2(a, b))
}

function snapPriority(mode: SnapMode): number {
  if (mode === 'point' || mode === 'center' || mode === 'midpoint' || mode === 'intersection') {
    return 1
  }

  if (mode === 'perpendicular') {
    return 2
  }

  if (mode === 'line') {
    return 3
  }

  return 4
}

function snapValue(value: number, step: number): number {
  return Math.round(value / step) * step
}

function normalizeAngle(rad: number): number {
  let v = rad
  while (v <= -Math.PI) v += Math.PI * 2
  while (v > Math.PI) v -= Math.PI * 2
  return v
}

function pointsNear(a: Point, b: Point, tolerance = 1e-7): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) <= tolerance
}

function shouldCompareProfileSegments(
  profile: SketchProfile,
  segmentIndexA: number,
  segmentIndexB: number,
): boolean {
  if (segmentIndexA === segmentIndexB) {
    return false
  }

  if (Math.abs(segmentIndexA - segmentIndexB) === 1) {
    return false
  }

  return !(profile.closed
    && Math.min(segmentIndexA, segmentIndexB) === 0
    && Math.max(segmentIndexA, segmentIndexB) === profile.segments.length - 1)
}

function segmentBounds(segment: ResolvedProfileSegment): SegmentBounds {
  if (segment.kind === 'line') {
    return {
      minX: Math.min(segment.p0.x, segment.p1.x),
      maxX: Math.max(segment.p0.x, segment.p1.x),
      minY: Math.min(segment.p0.y, segment.p1.y),
      maxY: Math.max(segment.p0.y, segment.p1.y),
    }
  }

  return {
    minX: segment.center.x - segment.radius,
    maxX: segment.center.x + segment.radius,
    minY: segment.center.y - segment.radius,
    maxY: segment.center.y + segment.radius,
  }
}

function boundsNearPoint(bounds: SegmentBounds, point: Point, radius: number): boolean {
  return point.x >= bounds.minX - radius
    && point.x <= bounds.maxX + radius
    && point.y >= bounds.minY - radius
    && point.y <= bounds.maxY + radius
}

function boundsOverlap(a: SegmentBounds, b: SegmentBounds): boolean {
  return a.minX <= b.maxX
    && a.maxX >= b.minX
    && a.minY <= b.maxY
    && a.maxY >= b.minY
}

function pushSnapCandidate(
  candidates: SnapCandidate[],
  rawPoint: Point,
  vt: ViewTransform,
  snapRadiusPx: number,
  mode: SnapMode,
  point: Point,
  guide?: SnapGuide,
  perpendicularSegment?: { a: Point; b: Point },
  anchor?: DimensionAnchor,
  intersection?: SnapIntersectionReference,
) {
  const distancePx = distanceToCanvas(worldToCanvas(rawPoint, vt), worldToCanvas(point, vt))
  if (distancePx > snapRadiusPx) {
    return
  }

  candidates.push({
    mode,
    point,
    distancePx,
    priority: snapPriority(mode),
    guide,
    perpendicularSegment,
    intersection,
    anchor,
  })
}

function addIntersectionSnapCandidates(
  candidates: SnapCandidate[],
  profiles: SnapProfileGeometry[],
  rawPoint: Point,
  vt: ViewTransform,
  snapRadiusPx: number,
) {
  const snapRadiusWorld = snapRadiusPx / Math.max(vt.scale, 1e-9)
  const resolvedProfiles = profiles.map((entry) => ({
    ...entry,
    segments: resolveProfileSegments(entry.profile),
  }))
  const acceptedPoints: Point[] = []

  for (let profileIndexA = 0; profileIndexA < resolvedProfiles.length; profileIndexA += 1) {
    const profileA = resolvedProfiles[profileIndexA]
    for (let segmentIndexA = 0; segmentIndexA < profileA.segments.length; segmentIndexA += 1) {
      const segmentA = profileA.segments[segmentIndexA]
      if (!segmentA) {
        continue
      }
      const boundsA = segmentBounds(segmentA)
      if (!boundsNearPoint(boundsA, rawPoint, snapRadiusWorld)) {
        continue
      }

      for (let profileIndexB = profileIndexA; profileIndexB < resolvedProfiles.length; profileIndexB += 1) {
        const profileB = resolvedProfiles[profileIndexB]
        const firstSegmentB = profileIndexA === profileIndexB ? segmentIndexA + 1 : 0

        for (let segmentIndexB = firstSegmentB; segmentIndexB < profileB.segments.length; segmentIndexB += 1) {
          if (profileIndexA === profileIndexB && !shouldCompareProfileSegments(profileA.profile, segmentIndexA, segmentIndexB)) {
            continue
          }

          const segmentB = profileB.segments[segmentIndexB]
          if (!segmentB) {
            continue
          }
          const boundsB = segmentBounds(segmentB)
          if (!boundsNearPoint(boundsB, rawPoint, snapRadiusWorld) || !boundsOverlap(boundsA, boundsB)) {
            continue
          }

          for (const intersection of segmentIntersections(segmentA, segmentB)) {
            if (acceptedPoints.some((point) => pointsNear(point, intersection.point))) {
              continue
            }

            const distancePx = distanceToCanvas(worldToCanvas(rawPoint, vt), worldToCanvas(intersection.point, vt))
            if (distancePx > snapRadiusPx) {
              continue
            }

            acceptedPoints.push(intersection.point)
            const intersectionReference: SnapIntersectionReference | undefined =
              profileA.source?.source === 'feature' && profileB.source?.source === 'feature'
                ? {
                    a: { target: profileA.source, segmentIndex: segmentIndexA },
                    b: { target: profileB.source, segmentIndex: segmentIndexB },
                  }
                : undefined
            pushSnapCandidate(
              candidates,
              rawPoint,
              vt,
              snapRadiusPx,
              'intersection',
              intersection.point,
              undefined,
              undefined,
              undefined,
              intersectionReference,
            )
          }
        }
      }
    }
  }
}

function addProfileSnapCandidates(
  candidates: SnapCandidate[],
  profile: SketchProfile,
  rawPoint: Point,
  vt: ViewTransform,
  snapRadiusPx: number,
  activeModes: Set<SnapMode>,
  referencePoint: Point | null,
  source: AnchorTarget | null = null,
) {
  const vertices = profileVertices(profile)
  if (activeModes.has('point')) {
    for (let v = 0; v < vertices.length; v += 1) {
      const anchor: DimensionAnchor | undefined = source
        ? { kind: 'vertex', target: source, vertexIndex: v }
        : undefined
      pushSnapCandidate(candidates, rawPoint, vt, snapRadiusPx, 'point', vertices[v], undefined, undefined, anchor)
    }
  }

  for (let index = 0; index < profile.segments.length; index += 1) {
    const start = anchorPointForIndex(profile, index)
    const segment = profile.segments[index]

    if (activeModes.has('midpoint')) {
      const anchor: DimensionAnchor | undefined = source
        ? { kind: 'midpoint', target: source, segmentIndex: index }
        : undefined
      pushSnapCandidate(candidates, rawPoint, vt, snapRadiusPx, 'midpoint', segmentMidpoint(start, segment), undefined, undefined, anchor)
    }

    if (activeModes.has('center') && (segment.type === 'arc' || segment.type === 'circle')) {
      const anchor: DimensionAnchor | undefined = source
        ? { kind: 'center', target: source, segmentIndex: index }
        : undefined
      pushSnapCandidate(candidates, rawPoint, vt, snapRadiusPx, 'center', segment.center, undefined, undefined, anchor)
    }

    if (!activeModes.has('line') && !(activeModes.has('perpendicular') && referencePoint)) {
      continue
    }

    if (segment.type === 'line') {
      if (activeModes.has('line')) {
        const projected = projectPointOntoSegment(rawPoint, start, segment.to)
        const dx = segment.to.x - start.x
        const dy = segment.to.y - start.y
        const lenSq = dx * dx + dy * dy
        const t = lenSq > 1e-9
          ? Math.max(0, Math.min(1, ((projected.x - start.x) * dx + (projected.y - start.y) * dy) / lenSq))
          : 0
        const anchor: DimensionAnchor | undefined = source
          ? { kind: 'segmentPoint', target: source, segmentIndex: index, t }
          : undefined
        pushSnapCandidate(
          candidates,
          rawPoint,
          vt,
          snapRadiusPx,
          'line',
          projected,
          { kind: 'projection', from: rawPoint, to: projected },
          undefined,
          anchor,
        )
      }
      if (activeModes.has('perpendicular') && referencePoint) {
        const perpendicularPoint = projectPointOntoSegment(referencePoint, start, segment.to)
        pushSnapCandidate(
          candidates,
          rawPoint,
          vt,
          snapRadiusPx,
          'perpendicular',
          perpendicularPoint,
          { kind: 'perpendicular', from: referencePoint, to: perpendicularPoint },
          { a: start, b: segment.to },
        )
      }
      continue
    }

    const polyline = sampleSegmentPolyline(start, segment)

    if (activeModes.has('line')) {
      const projected = nearestPointOnPolyline(rawPoint, polyline)
      const anchor: DimensionAnchor | undefined =
        source && (segment.type === 'arc' || segment.type === 'circle')
          ? {
              kind: 'circleEdge',
              target: source,
              segmentIndex: index,
              relativeAngle: normalizeAngle(
                Math.atan2(projected.y - segment.center.y, projected.x - segment.center.x)
                  - Math.atan2(start.y - segment.center.y, start.x - segment.center.x),
              ),
            }
          : undefined
      pushSnapCandidate(
        candidates,
        rawPoint,
        vt,
        snapRadiusPx,
        'line',
        projected,
        { kind: 'projection', from: rawPoint, to: projected },
        undefined,
        anchor,
      )
    }

    if (activeModes.has('perpendicular') && referencePoint) {
      const perpendicularPoint = nearestPointOnPolyline(referencePoint, polyline)
      pushSnapCandidate(
        candidates,
        rawPoint,
        vt,
        snapRadiusPx,
        'perpendicular',
        perpendicularPoint,
        { kind: 'perpendicular', from: referencePoint, to: perpendicularPoint },
      )
    }
  }
}

export function resolveSketchSnap(input: {
  rawPoint: Point
  vt: ViewTransform
  snapSettings: SnapSettings
  project: Project
  referencePoint: Point | null
  excludeFeatureId?: string | null
  excludeTabId?: string | null
  excludeClampId?: string | null
}): ResolvedSnap {
  const {
    rawPoint,
    vt,
    snapSettings,
    project,
    referencePoint,
    excludeFeatureId = null,
    excludeTabId = null,
    excludeClampId = null,
  } = input

  if (!snapSettings.enabled || snapSettings.modes.length === 0) {
    return { rawPoint, point: rawPoint, mode: null }
  }

  const activeModes = new Set(snapSettings.modes)
  const snapRadiusPx = snapSettings.pixelRadius
  const candidates: SnapCandidate[] = []
  const snapProfiles: SnapProfileGeometry[] = []

  if (activeModes.has('grid')) {
    const gridPoint = {
      x: snapValue(rawPoint.x, project.grid.snapIncrement),
      y: snapValue(rawPoint.y, project.grid.snapIncrement),
    }
    pushSnapCandidate(candidates, rawPoint, vt, snapRadiusPx, 'grid', gridPoint)
  }

  snapProfiles.push({ profile: project.stock.profile, source: { source: 'stock' } })
  addProfileSnapCandidates(candidates, project.stock.profile, rawPoint, vt, snapRadiusPx, activeModes, referencePoint, { source: 'stock' })

  for (const feature of resolvedProjectFeatures(project)) {
    if (!feature.visible || feature.id === excludeFeatureId) {
      continue
    }
    snapProfiles.push({ profile: feature.sketch.profile, source: { source: 'feature', featureId: feature.id } })
    addProfileSnapCandidates(candidates, feature.sketch.profile, rawPoint, vt, snapRadiusPx, activeModes, referencePoint, { source: 'feature', featureId: feature.id })
  }

  for (const tab of project.tabs) {
    if (!tab.visible || tab.id === excludeTabId) {
      continue
    }
    const profile = rectProfile(tab.x, tab.y, tab.w, tab.h)
    snapProfiles.push({ profile })
    addProfileSnapCandidates(candidates, profile, rawPoint, vt, snapRadiusPx, activeModes, referencePoint)
  }

  for (const clamp of project.clamps) {
    if (!clamp.visible || clamp.id === excludeClampId) {
      continue
    }
    const profile = rectProfile(clamp.x, clamp.y, clamp.w, clamp.h)
    snapProfiles.push({ profile })
    addProfileSnapCandidates(candidates, profile, rawPoint, vt, snapRadiusPx, activeModes, referencePoint)
  }

  if (activeModes.has('point') && project.origin.visible) {
    pushSnapCandidate(candidates, rawPoint, vt, snapRadiusPx, 'point', { x: project.origin.x, y: project.origin.y }, undefined, undefined, { kind: 'origin' })
  }

  if (activeModes.has('intersection')) {
    addIntersectionSnapCandidates(candidates, snapProfiles, rawPoint, vt, snapRadiusPx)
  }

  if (candidates.length === 0) {
    return { rawPoint, point: rawPoint, mode: null }
  }

  candidates.sort((a, b) => (
    a.priority - b.priority
    || a.distancePx - b.distancePx
  ))

  const best = candidates[0]
  return {
    rawPoint,
    point: best.point,
    mode: best.mode,
    guide: best.guide,
    perpendicularSegment: best.perpendicularSegment,
    intersection: best.intersection,
    anchor: best.anchor,
  }
}
