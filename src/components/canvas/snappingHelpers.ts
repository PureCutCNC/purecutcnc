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
import type { Point, Project, SketchProfile } from '../../types/project'
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

interface SnapCandidate {
  mode: SnapMode
  point: Point
  distancePx: number
  priority: number
  guide?: SnapGuide
  perpendicularSegment?: { a: Point; b: Point }
}

export interface ResolvedSnap {
  rawPoint: Point
  point: Point
  mode: SnapMode | null
  guide?: SnapGuide
  perpendicularSegment?: { a: Point; b: Point }
}

function distanceToCanvas(a: { cx: number; cy: number }, b: { cx: number; cy: number }): number {
  return Math.sqrt(distance2(a, b))
}

function snapPriority(mode: SnapMode): number {
  if (mode === 'point' || mode === 'center' || mode === 'midpoint') {
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

function pushSnapCandidate(
  candidates: SnapCandidate[],
  rawPoint: Point,
  vt: ViewTransform,
  snapRadiusPx: number,
  mode: SnapMode,
  point: Point,
  guide?: SnapGuide,
  perpendicularSegment?: { a: Point; b: Point },
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
  })
}

function addProfileSnapCandidates(
  candidates: SnapCandidate[],
  profile: SketchProfile,
  rawPoint: Point,
  vt: ViewTransform,
  snapRadiusPx: number,
  activeModes: Set<SnapMode>,
  referencePoint: Point | null,
) {
  const vertices = profileVertices(profile)
  if (activeModes.has('point')) {
    for (const vertex of vertices) {
      pushSnapCandidate(candidates, rawPoint, vt, snapRadiusPx, 'point', vertex)
    }
  }

  for (let index = 0; index < profile.segments.length; index += 1) {
    const start = anchorPointForIndex(profile, index)
    const segment = profile.segments[index]

    if (activeModes.has('midpoint')) {
      pushSnapCandidate(candidates, rawPoint, vt, snapRadiusPx, 'midpoint', segmentMidpoint(start, segment))
    }

    if (activeModes.has('center') && (segment.type === 'arc' || segment.type === 'circle')) {
      pushSnapCandidate(candidates, rawPoint, vt, snapRadiusPx, 'center', segment.center)
    }

    if (!activeModes.has('line') && !(activeModes.has('perpendicular') && referencePoint)) {
      continue
    }

    if (segment.type === 'line') {
      if (activeModes.has('line')) {
        const projected = projectPointOntoSegment(rawPoint, start, segment.to)
        pushSnapCandidate(
          candidates,
          rawPoint,
          vt,
          snapRadiusPx,
          'line',
          projected,
          { kind: 'projection', from: rawPoint, to: projected },
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
      pushSnapCandidate(
        candidates,
        rawPoint,
        vt,
        snapRadiusPx,
        'line',
        projected,
        { kind: 'projection', from: rawPoint, to: projected },
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

  if (activeModes.has('grid')) {
    const gridPoint = {
      x: snapValue(rawPoint.x, project.grid.snapIncrement),
      y: snapValue(rawPoint.y, project.grid.snapIncrement),
    }
    pushSnapCandidate(candidates, rawPoint, vt, snapRadiusPx, 'grid', gridPoint)
  }

  addProfileSnapCandidates(candidates, project.stock.profile, rawPoint, vt, snapRadiusPx, activeModes, referencePoint)

  for (const feature of project.features) {
    if (!feature.visible || feature.id === excludeFeatureId) {
      continue
    }
    addProfileSnapCandidates(candidates, feature.sketch.profile, rawPoint, vt, snapRadiusPx, activeModes, referencePoint)
  }

  for (const tab of project.tabs) {
    if (!tab.visible || tab.id === excludeTabId) {
      continue
    }
    addProfileSnapCandidates(candidates, rectProfile(tab.x, tab.y, tab.w, tab.h), rawPoint, vt, snapRadiusPx, activeModes, referencePoint)
  }

  for (const clamp of project.clamps) {
    if (!clamp.visible || clamp.id === excludeClampId) {
      continue
    }
    addProfileSnapCandidates(candidates, rectProfile(clamp.x, clamp.y, clamp.w, clamp.h), rawPoint, vt, snapRadiusPx, activeModes, referencePoint)
  }

  if (activeModes.has('point') && project.origin.visible) {
    pushSnapCandidate(candidates, rawPoint, vt, snapRadiusPx, 'point', { x: project.origin.x, y: project.origin.y })
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
  }
}
