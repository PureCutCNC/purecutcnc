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

import { create } from 'zustand'
import { copyBundledDefinitions } from '../engine/gcode/definitions'
import { validateMachineDefinition } from '../engine/gcode/types'
import type { MachineDefinition } from '../engine/gcode/types'
import { createImportedFeature, isProfileDegenerate, stripFileExtension, uniqueName } from '../import'
import {
  type Segment,
  defaultStock,
  defaultOrigin,
  defaultGrid,
  defaultTool,
  defaultMaxTravelZ,
  defaultOperationClearanceZ,
  defaultClampClearanceXY,
  defaultClampClearanceZ,
  getStockBounds,
  inferFeatureKind,
  getProfileBounds,
  newProject,
  profileVertices,
  rectProfile,
  circleProfile,
  polygonProfile,
  splineProfile,
  type TextFeatureData,
} from '../types/project'
import type {
  BackdropImage,
  Clamp,
  FeatureOperation,
  FeatureFolder,
  FeatureTreeEntry,
  Operation,
  OperationKind,
  OperationPass,
  OperationTarget,
  Point,
  Project,
  SketchProfile,
  SketchFeature,
  Tab,
  Tool,
} from '../types/project'
import { convertProjectUnits } from '../utils/units'
import { convertLength } from '../utils/units'
import {
  featureHasClosedGeometry,
  generateTextShapes,
  getTextFrameProfile,
  type TextToolConfig,
} from '../text'
import {
  addPoint,
  clampNumber,
  clonePoint,
  crossPoint,
  dotPoint,
  lerpPoint,
  normalizePoint,
  pointLength,
  pointsEqual,
  scalePoint,
  subtractPoint,
} from './helpers/geometry'
import {
  clipperContourToProfile,
  flattenFeatureToClipperPath,
  unionClipperPaths,
} from './helpers/clipping'
import {
  cutFeaturesByCutterGrouped,
  insertDerivedFeaturesAfterSources,
  insertDerivedFeatureTreeEntries,
  normalizeDerivedFeatureNameStem,
  previewOffsetFeatures as previewOffsetFeaturesWithFactory,
  type DerivedFeatureGroup,
} from './helpers/derivedFeatures'
import { idNumericSuffix, nextPlacementSession, nextUniqueGeneratedId, syncIdCounter } from './helpers/ids'
import {
  angleToPoint,
  inferProfileOrientationAngle,
  normalizeAngleDegrees,
  normalizeFeatureZRange,
  normalizeTool,
} from './helpers/normalize'
import { createPendingAddSlice } from './slices/pendingAddSlice'
import { createPendingActionsSlice } from './slices/pendingActionsSlice'
import { createPendingCompletionSlice } from './slices/pendingCompletionSlice'
import { createSelectionSlice, emptySelection, sanitizeSelection } from './slices/selectionSlice'
import type {
  PendingAddTool,
  ProjectStore,
  SketchInsertTarget,
} from './types'

function cloneSegment(segment: Segment): Segment {
  if (segment.type === 'arc') {
    return {
      ...segment,
      to: clonePoint(segment.to),
      center: clonePoint(segment.center),
    }
  }

  if (segment.type === 'bezier') {
    return {
      ...segment,
      to: clonePoint(segment.to),
      control1: clonePoint(segment.control1),
      control2: clonePoint(segment.control2),
    }
  }

  return {
    ...segment,
    to: clonePoint(segment.to),
  }
}

function normalizeEditableProfileClosure(profile: SketchProfile): SketchProfile {
  if (profile.segments.length === 0) {
    return {
      ...profile,
      closed: false,
    }
  }

  const endAnchor = anchorPointForIndex(profile, profile.segments.length)
  const shouldClose = pointsEqual(profile.start, endAnchor)
  return {
    ...profile,
    closed: shouldClose,
  }
}

function createDerivedFeature(
  project: Project,
  baseFeature: SketchFeature,
  profile: SketchProfile,
  operation: FeatureOperation,
  name: string,
): SketchFeature {
  return normalizeFeatureZRange({
    id: nextUniqueGeneratedId(project, 'f'),
    name,
    kind: inferFeatureKind(profile),
    folderId: baseFeature.folderId,
    sketch: {
      profile,
      origin: clonePoint(baseFeature.sketch.origin),
      orientationAngle: baseFeature.sketch.orientationAngle,
      dimensions: [],
      constraints: [],
    },
    operation,
    z_top: baseFeature.z_top,
    z_bottom: baseFeature.z_bottom,
    visible: true,
    locked: false,
  })
}

export function previewOffsetFeatures(project: Project, featureIds: string[], distance: number): SketchFeature[] {
  return previewOffsetFeaturesWithFactory(project, featureIds, distance, createDerivedFeature)
}

function anchorPointForIndex(profile: SketchProfile, index: number): Point {
  if (index <= 0) {
    return profile.start
  }
  return profile.segments[index - 1]?.to ?? profile.start
}

function splitBezierSegment(start: Point, segment: Extract<Segment, { type: 'bezier' }>, t: number): [Segment, Segment] {
  const p01 = lerpPoint(start, segment.control1, t)
  const p12 = lerpPoint(segment.control1, segment.control2, t)
  const p23 = lerpPoint(segment.control2, segment.to, t)
  const p012 = lerpPoint(p01, p12, t)
  const p123 = lerpPoint(p12, p23, t)
  const splitPoint = lerpPoint(p012, p123, t)

  return [
    {
      type: 'bezier',
      control1: p01,
      control2: p012,
      to: splitPoint,
    },
    {
      type: 'bezier',
      control1: p123,
      control2: p23,
      to: clonePoint(segment.to),
    },
  ]
}

function splitArcSegment(segment: Extract<Segment, { type: 'arc' }>, point: Point): [Segment, Segment] {
  return [
    {
      type: 'arc',
      center: clonePoint(segment.center),
      clockwise: segment.clockwise,
      to: clonePoint(point),
    },
    {
      type: 'arc',
      center: clonePoint(segment.center),
      clockwise: segment.clockwise,
      to: clonePoint(segment.to),
    },
  ]
}

function extendOpenProfileAtStart(profile: SketchProfile, point: Point): SketchProfile {
  const nextPoint = clonePoint(profile.start)
  const firstSegment = profile.segments[0]
  const insertedSegment: Segment =
    firstSegment?.type === 'bezier'
      ? {
          type: 'bezier',
          control1: lerpPoint(point, nextPoint, 1 / 3),
          control2: {
            x: nextPoint.x + (nextPoint.x - firstSegment.control1.x),
            y: nextPoint.y + (nextPoint.y - firstSegment.control1.y),
          },
          to: nextPoint,
        }
      : {
          type: 'line',
          to: nextPoint,
        }

  return {
    ...profile,
    start: clonePoint(point),
    segments: [insertedSegment, ...profile.segments.map(cloneSegment)],
  }
}

function extendOpenProfileAtEnd(profile: SketchProfile, point: Point): SketchProfile {
  const nextSegments = profile.segments.map(cloneSegment)
  const lastAnchor = anchorPointForIndex(profile, profile.segments.length)
  const lastSegment = profile.segments[profile.segments.length - 1]
  const insertedSegment: Segment =
    lastSegment?.type === 'bezier'
      ? {
          type: 'bezier',
          control1: {
            x: lastAnchor.x + (lastAnchor.x - lastSegment.control2.x),
            y: lastAnchor.y + (lastAnchor.y - lastSegment.control2.y),
          },
          control2: lerpPoint(point, lastAnchor, 1 / 3),
          to: clonePoint(point),
        }
      : {
          type: 'line',
          to: clonePoint(point),
        }

  nextSegments.push(insertedSegment)
  return {
    ...profile,
    segments: nextSegments,
  }
}

function buildBridgeSegment(
  previousAnchor: Point,
  nextAnchor: Point,
  incomingSegment: Segment,
  outgoingSegment: Segment,
): Segment {
  if (incomingSegment.type === 'bezier' || outgoingSegment.type === 'bezier') {
    return {
      type: 'bezier',
      control1:
        incomingSegment.type === 'bezier'
          ? clonePoint(incomingSegment.control1)
          : lerpPoint(previousAnchor, nextAnchor, 1 / 3),
      control2:
        outgoingSegment.type === 'bezier'
          ? clonePoint(outgoingSegment.control2)
          : lerpPoint(nextAnchor, previousAnchor, 1 / 3),
      to: clonePoint(nextAnchor),
    }
  }

  return {
    type: 'line',
    to: clonePoint(nextAnchor),
  }
}

function createFilletArcSegment(start: Point, end: Point, center: Point): Segment {
  const startVector = subtractPoint(start, center)
  const endVector = subtractPoint(end, center)
  return {
    type: 'arc',
    center: clonePoint(center),
    clockwise: crossPoint(startVector, endVector) < 0,
    to: clonePoint(end),
  }
}

function applyLineCornerFillet(profile: SketchProfile, anchorIndex: number, radius: number): SketchProfile | null {
  const anchors = profileVertices(profile)
  const anchorCount = anchors.length
  if (radius <= 1e-9 || anchorIndex < 0 || anchorIndex >= anchorCount) {
    return null
  }

  const hasIncoming = profile.closed || anchorIndex > 0
  const hasOutgoing = profile.closed || anchorIndex < anchorCount - 1
  if (!hasIncoming || !hasOutgoing) {
    return null
  }

  const incomingIndex = profile.closed ? (anchorIndex - 1 + profile.segments.length) % profile.segments.length : anchorIndex - 1
  const outgoingIndex = anchorIndex
  const incomingSegment = profile.segments[incomingIndex]
  const outgoingSegment = profile.segments[outgoingIndex]
  if (!incomingSegment || !outgoingSegment || incomingSegment.type !== 'line' || outgoingSegment.type !== 'line') {
    return null
  }

  const previousAnchor = anchors[(anchorIndex - 1 + anchorCount) % anchorCount]
  const corner = anchors[anchorIndex]
  const nextAnchor = anchors[(anchorIndex + 1) % anchorCount]
  const incomingDirection = normalizePoint(subtractPoint(previousAnchor, corner))
  const outgoingDirection = normalizePoint(subtractPoint(nextAnchor, corner))
  if (!incomingDirection || !outgoingDirection) {
    return null
  }

  const turnDot = clampNumber(dotPoint(incomingDirection, outgoingDirection), -1, 1)
  const interiorAngle = Math.acos(turnDot)
  if (!Number.isFinite(interiorAngle) || interiorAngle <= 1e-3 || Math.abs(Math.PI - interiorAngle) <= 1e-3) {
    return null
  }

  const trim = radius / Math.tan(interiorAngle / 2)
  const incomingLength = pointLength(subtractPoint(previousAnchor, corner))
  const outgoingLength = pointLength(subtractPoint(nextAnchor, corner))
  if (!(trim > 0) || trim >= incomingLength || trim >= outgoingLength) {
    return null
  }

  const tangentStart = addPoint(corner, scalePoint(incomingDirection, trim))
  const tangentEnd = addPoint(corner, scalePoint(outgoingDirection, trim))
  const bisector = normalizePoint(addPoint(incomingDirection, outgoingDirection))
  if (!bisector) {
    return null
  }

  const centerDistance = radius / Math.sin(interiorAngle / 2)
  const center = addPoint(corner, scalePoint(bisector, centerDistance))
  const nextSegments = profile.segments.map(cloneSegment)
  nextSegments[incomingIndex] = { type: 'line', to: clonePoint(tangentStart) }
  nextSegments.splice(outgoingIndex, 1, createFilletArcSegment(tangentStart, tangentEnd, center), { type: 'line', to: clonePoint(nextAnchor) })

  if (profile.closed && anchorIndex === 0) {
    return normalizeEditableProfileClosure({
      ...profile,
      start: clonePoint(tangentStart),
      segments: nextSegments,
    })
  }

  if (!profile.closed && anchorIndex === 0) {
    return normalizeEditableProfileClosure({
      ...profile,
      start: clonePoint(tangentStart),
      segments: nextSegments.slice(1),
    })
  }

  return normalizeEditableProfileClosure({
    ...profile,
    segments: nextSegments,
  })
}

function insertPointIntoProfile(profile: SketchProfile, target: SketchInsertTarget): SketchProfile {
  if (!profile.closed && target.kind === 'extend_start') {
    return extendOpenProfileAtStart(profile, target.point)
  }

  if (!profile.closed && target.kind === 'extend_end') {
    return extendOpenProfileAtEnd(profile, target.point)
  }

  if (target.kind !== 'segment') {
    return profile
  }

  const segmentIndex = target.segmentIndex
  const segment = profile.segments[segmentIndex]
  const start = anchorPointForIndex(profile, segmentIndex)

  if (!segment || pointsEqual(start, target.point) || pointsEqual(segment.to, target.point)) {
    return profile
  }

  const nextSegments = profile.segments.map(cloneSegment)
  const replacements =
    segment.type === 'line'
      ? [
          { type: 'line' as const, to: clonePoint(target.point) },
          { type: 'line' as const, to: clonePoint(segment.to) },
        ]
      : segment.type === 'bezier'
        ? splitBezierSegment(start, segment, Math.min(0.999, Math.max(0.001, target.t)))
        : splitArcSegment(segment, target.point)

  nextSegments.splice(segmentIndex, 1, ...replacements)
  return {
    ...profile,
    segments: nextSegments,
  }
}

function deleteAnchorFromProfile(profile: SketchProfile, anchorIndex: number): SketchProfile | null {
  const anchors = profileVertices(profile)
  const anchorCount = anchors.length

  if (profile.closed) {
    if (anchorCount <= 3 || anchorIndex < 0 || anchorIndex >= anchorCount) {
      return null
    }

    const nextSegments = profile.segments.map(cloneSegment)
    if (anchorIndex === 0) {
      const nextStart = anchors[1]
      const removedOutgoing = nextSegments[0]
      nextSegments.shift()
      if (nextSegments.length === 0) {
        return null
      }
      const closingStart = anchors[anchorCount - 1]
      const previousClosing = nextSegments[nextSegments.length - 1]
      nextSegments[nextSegments.length - 1] = buildBridgeSegment(closingStart, nextStart, previousClosing, removedOutgoing)
      return {
        ...profile,
        start: clonePoint(nextStart),
        segments: nextSegments,
      }
    }

    const incomingIndex = anchorIndex - 1
    const outgoingIndex = anchorIndex
    const nextAnchor = anchors[(anchorIndex + 1) % anchorCount]
    const previousAnchor = anchors[(anchorIndex - 1 + anchorCount) % anchorCount]
    nextSegments[incomingIndex] = buildBridgeSegment(
      previousAnchor,
      nextAnchor,
      nextSegments[incomingIndex],
      nextSegments[outgoingIndex],
    )
    nextSegments.splice(outgoingIndex, 1)
    return {
      ...profile,
      segments: nextSegments,
    }
  }

  if (anchorCount <= 2 || anchorIndex < 0 || anchorIndex >= anchorCount) {
    return null
  }

  const nextSegments = profile.segments.map(cloneSegment)

  if (anchorIndex === 0) {
    const nextStart = anchors[1]
    nextSegments.shift()
    return {
      ...profile,
      start: clonePoint(nextStart),
      segments: nextSegments,
      closed: false,
    }
  }

  if (anchorIndex === anchorCount - 1) {
    nextSegments.pop()
    return {
      ...profile,
      segments: nextSegments,
      closed: false,
    }
  }

  const incomingIndex = anchorIndex - 1
  const outgoingIndex = anchorIndex
  const nextAnchor = anchors[anchorIndex + 1]
  const previousAnchor = anchors[anchorIndex - 1]
  nextSegments[incomingIndex] = buildBridgeSegment(
    previousAnchor,
    nextAnchor,
    nextSegments[incomingIndex],
    nextSegments[outgoingIndex],
  )
  nextSegments.splice(outgoingIndex, 1)
  return {
    ...profile,
    segments: nextSegments,
    closed: false,
  }
}

function appendSplineDraftSegment(
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

function resolveCompositeDraftSegments(draft: Extract<PendingAddTool, { shape: 'composite' }>): Segment[] | null {
  if (!draft.start || !draft.lastPoint || draft.pendingArcEnd) {
    return null
  }

  if (draft.segments.length < 2) {
    return null
  }

  if (pointsEqual(draft.lastPoint, draft.start)) {
    return draft.segments
  }

  if (draft.currentMode === 'spline') {
    return appendSplineDraftSegment(draft.start, draft.segments, draft.start)
  }

  return [...draft.segments, { type: 'line', to: clonePoint(draft.start) }]
}

function resolveOpenCompositeDraftSegments(draft: Extract<PendingAddTool, { shape: 'composite' }>): Segment[] | null {
  if (!draft.start || !draft.lastPoint || draft.pendingArcEnd) {
    return null
  }

  if (draft.segments.length < 1) {
    return null
  }

  return draft.segments
}

function buildArcSegmentFromThreePoints(start: Point, end: Point, through: Point): Segment | null {
  const ax = start.x
  const ay = start.y
  const bx = through.x
  const by = through.y
  const cx = end.x
  const cy = end.y

  const denominator = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
  if (Math.abs(denominator) < 1e-9) {
    return null
  }

  const aSq = ax * ax + ay * ay
  const bSq = bx * bx + by * by
  const cSq = cx * cx + cy * cy
  const center = {
    x: (aSq * (by - cy) + bSq * (cy - ay) + cSq * (ay - by)) / denominator,
    y: (aSq * (cx - bx) + bSq * (ax - cx) + cSq * (bx - ax)) / denominator,
  }

  const cross = (through.x - start.x) * (end.y - start.y) - (through.y - start.y) * (end.x - start.x)
  return {
    type: 'arc',
    to: end,
    center,
    clockwise: cross < 0,
  }
}

function arcControlPoint(start: Point, segment: Extract<Segment, { type: 'arc' }>): Point {
  const startAngle = Math.atan2(start.y - segment.center.y, start.x - segment.center.x)
  const endAngle = Math.atan2(segment.to.y - segment.center.y, segment.to.x - segment.center.x)
  const radius = Math.hypot(start.x - segment.center.x, start.y - segment.center.y)

  let sweep = endAngle - startAngle
  if (segment.clockwise && sweep > 0) {
    sweep -= Math.PI * 2
  } else if (!segment.clockwise && sweep < 0) {
    sweep += Math.PI * 2
  }

  const midAngle = startAngle + sweep / 2
  return {
    x: segment.center.x + Math.cos(midAngle) * radius,
    y: segment.center.y + Math.sin(midAngle) * radius,
  }
}

function translatePoint(point: Point, dx: number, dy: number): Point {
  return { x: point.x + dx, y: point.y + dy }
}

function translateProfile(profile: SketchFeature['sketch']['profile'], dx: number, dy: number): SketchFeature['sketch']['profile'] {
  return {
    ...profile,
    start: translatePoint(profile.start, dx, dy),
    segments: profile.segments.map((segment) => {
      if (segment.type === 'arc') {
        return {
          ...segment,
          to: translatePoint(segment.to, dx, dy),
          center: translatePoint(segment.center, dx, dy),
        }
      }

      if (segment.type === 'bezier') {
        return {
          ...segment,
          to: translatePoint(segment.to, dx, dy),
          control1: translatePoint(segment.control1, dx, dy),
          control2: translatePoint(segment.control2, dx, dy),
        }
      }

      return {
        ...segment,
        to: translatePoint(segment.to, dx, dy),
      }
    }),
  }
}

function transformProfile(
  profile: SketchFeature['sketch']['profile'],
  transformPoint: (point: Point) => Point,
): SketchFeature['sketch']['profile'] {
  return {
    ...profile,
    start: transformPoint(profile.start),
    segments: profile.segments.map((segment) => {
      if (segment.type === 'arc') {
        return {
          ...segment,
          to: transformPoint(segment.to),
          center: transformPoint(segment.center),
        }
      }

      if (segment.type === 'bezier') {
        return {
          ...segment,
          to: transformPoint(segment.to),
          control1: transformPoint(segment.control1),
          control2: transformPoint(segment.control2),
        }
      }

      return {
        ...segment,
        to: transformPoint(segment.to),
      }
    }),
  }
}

function arcToBezierSegments(start: Point, segment: Extract<Segment, { type: 'arc' }>): Array<Extract<Segment, { type: 'bezier' }>> {
  const startAngle = Math.atan2(start.y - segment.center.y, start.x - segment.center.x)
  const endAngle = Math.atan2(segment.to.y - segment.center.y, segment.to.x - segment.center.x)
  const radius = Math.hypot(start.x - segment.center.x, start.y - segment.center.y)

  let sweep = endAngle - startAngle
  if (segment.clockwise && sweep > 0) {
    sweep -= Math.PI * 2
  } else if (!segment.clockwise && sweep < 0) {
    sweep += Math.PI * 2
  }

  const segmentCount = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)))
  const step = sweep / segmentCount
  const result: Array<Extract<Segment, { type: 'bezier' }>> = []

  for (let index = 0; index < segmentCount; index += 1) {
    const angle0 = startAngle + step * index
    const angle1 = angle0 + step
    const p0 = {
      x: segment.center.x + Math.cos(angle0) * radius,
      y: segment.center.y + Math.sin(angle0) * radius,
    }
    const p3 = {
      x: segment.center.x + Math.cos(angle1) * radius,
      y: segment.center.y + Math.sin(angle1) * radius,
    }
    const tangent0 = { x: -Math.sin(angle0), y: Math.cos(angle0) }
    const tangent1 = { x: -Math.sin(angle1), y: Math.cos(angle1) }
    const handleScale = (4 / 3) * Math.tan(step / 4) * radius

    result.push({
      type: 'bezier',
      control1: {
        x: p0.x + tangent0.x * handleScale,
        y: p0.y + tangent0.y * handleScale,
      },
      control2: {
        x: p3.x - tangent1.x * handleScale,
        y: p3.y - tangent1.y * handleScale,
      },
      to: p3,
    })
  }

  return result
}

function transformProfileAffine(
  profile: SketchFeature['sketch']['profile'],
  transformPoint: (point: Point) => Point,
): SketchFeature['sketch']['profile'] {
  const nextSegments: Segment[] = []
  let current = profile.start

  for (const segment of profile.segments) {
    if (segment.type === 'arc') {
      const beziers = arcToBezierSegments(current, segment)
      for (const bezier of beziers) {
        nextSegments.push({
          type: 'bezier',
          control1: transformPoint(bezier.control1),
          control2: transformPoint(bezier.control2),
          to: transformPoint(bezier.to),
        })
      }
    } else if (segment.type === 'bezier') {
      nextSegments.push({
        ...segment,
        control1: transformPoint(segment.control1),
        control2: transformPoint(segment.control2),
        to: transformPoint(segment.to),
      })
    } else {
      nextSegments.push({
        ...segment,
        to: transformPoint(segment.to),
      })
    }

    current = segment.to
  }

  return {
    ...profile,
    start: transformPoint(profile.start),
    segments: nextSegments,
  }
}

function rotatePointAround(point: Point, origin: Point, angle: number): Point {
  const local = subtractPoint(point, origin)
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return {
    x: origin.x + local.x * cos - local.y * sin,
    y: origin.y + local.x * sin + local.y * cos,
  }
}

function featureResizeBasis(feature: SketchFeature): { u: Point; v: Point } {
  const orientationAngle = normalizeAngleDegrees(
    feature.sketch.orientationAngle ?? inferProfileOrientationAngle(feature.sketch.profile),
  )
  const v = angleToPoint(orientationAngle)
  const u = angleToPoint(orientationAngle - 90)
  return { u, v }
}

function snappedResizeScales(
  referenceVector: Point,
  previewVector: Point,
  u: Point,
  v: Point,
): { scaleU: number; scaleV: number } | null {
  const refU = dotPoint(referenceVector, u)
  const refV = dotPoint(referenceVector, v)
  const previewU = dotPoint(previewVector, u)
  const previewV = dotPoint(previewVector, v)

  const scaleU = Math.abs(refU) <= 1e-9 ? 1 : previewU / refU
  const scaleV = Math.abs(refV) <= 1e-9 ? 1 : previewV / refV

  const unit = normalizePoint(referenceVector)
  if (!unit) {
    return null
  }

  const axisSnapTolerance = Math.cos((12 * Math.PI) / 180)
  const alignU = Math.abs(dotPoint(unit, u))
  const alignV = Math.abs(dotPoint(unit, v))

  if (alignU >= axisSnapTolerance && alignU >= alignV) {
    return { scaleU, scaleV: 1 }
  }

  if (alignV >= axisSnapTolerance && alignV >= alignU) {
    return { scaleU: 1, scaleV }
  }

  return { scaleU, scaleV }
}

export function resizeFeatureFromReference(
  feature: SketchFeature,
  referenceStart: Point,
  referenceEnd: Point,
  previewPoint: Point,
): SketchFeature | null {
  const referenceVector = subtractPoint(referenceEnd, referenceStart)
  const referenceLength = pointLength(referenceVector)
  if (referenceLength <= 1e-9) {
    return null
  }

  const unit = scalePoint(referenceVector, 1 / referenceLength)
  const projectedLength = dotPoint(subtractPoint(previewPoint, referenceStart), unit)
  const constrainedPreview = addPoint(referenceStart, scalePoint(unit, projectedLength))
  const { u, v } = featureResizeBasis(feature)
  const previewVector = subtractPoint(constrainedPreview, referenceStart)
  const snappedScales = snappedResizeScales(referenceVector, previewVector, u, v)
  if (!snappedScales) {
    return null
  }

  const { scaleU, scaleV } = snappedScales
  if (
    !Number.isFinite(scaleU)
    || !Number.isFinite(scaleV)
    || scaleU <= 1e-6
    || scaleV <= 1e-6
  ) {
    return null
  }

  const transformPoint = (point: Point): Point => {
    const local = subtractPoint(point, referenceStart)
    const localU = dotPoint(local, u)
    const localV = dotPoint(local, v)
    return {
      x: referenceStart.x + u.x * localU * scaleU + v.x * localV * scaleV,
      y: referenceStart.y + u.y * localU * scaleU + v.y * localV * scaleV,
    }
  }

  const profile = transformProfileAffine(feature.sketch.profile, transformPoint)
  return {
    ...feature,
    kind: feature.kind === 'text' ? 'text' : inferFeatureKind(profile),
    sketch: {
      ...feature.sketch,
      origin: transformPoint(feature.sketch.origin),
      orientationAngle: normalizeAngleDegrees(
        feature.sketch.orientationAngle ?? inferProfileOrientationAngle(feature.sketch.profile),
      ),
      profile,
    },
  }
}

export function rotateFeatureFromReference(
  feature: SketchFeature,
  referenceStart: Point,
  referenceEnd: Point,
  previewPoint: Point,
): SketchFeature | null {
  const startVector = subtractPoint(referenceEnd, referenceStart)
  const endVector = subtractPoint(previewPoint, referenceStart)
  const startLength = pointLength(startVector)
  const endLength = pointLength(endVector)
  if (startLength <= 1e-9 || endLength <= 1e-9) {
    return null
  }

  const angle = Math.atan2(crossPoint(startVector, endVector), dotPoint(startVector, endVector))
  if (!Number.isFinite(angle)) {
    return null
  }

  const profile = transformProfile(feature.sketch.profile, (point) => rotatePointAround(point, referenceStart, angle))
  return {
    ...feature,
    kind: feature.kind === 'text' ? 'text' : inferFeatureKind(profile),
    sketch: {
      ...feature.sketch,
      origin: rotatePointAround(feature.sketch.origin, referenceStart, angle),
      orientationAngle: normalizeAngleDegrees(
        (feature.sketch.orientationAngle ?? inferProfileOrientationAngle(feature.sketch.profile)) + angle * (180 / Math.PI),
      ),
      profile,
    },
  }
}

function backdropResizeBasis(backdrop: BackdropImage): { u: Point; v: Point } {
  const orientationAngle = normalizeAngleDegrees(backdrop.orientationAngle ?? 90)
  return {
    u: angleToPoint(orientationAngle - 90),
    v: angleToPoint(orientationAngle),
  }
}

export function resizeBackdropFromReference(
  backdrop: BackdropImage,
  referenceStart: Point,
  referenceEnd: Point,
  previewPoint: Point,
): BackdropImage | null {
  const referenceVector = subtractPoint(referenceEnd, referenceStart)
  const referenceLength = pointLength(referenceVector)
  if (referenceLength <= 1e-9) {
    return null
  }

  const unit = scalePoint(referenceVector, 1 / referenceLength)
  const projectedLength = dotPoint(subtractPoint(previewPoint, referenceStart), unit)
  const constrainedPreview = addPoint(referenceStart, scalePoint(unit, projectedLength))
  const { u, v } = backdropResizeBasis(backdrop)
  const previewVector = subtractPoint(constrainedPreview, referenceStart)
  const snappedScales = snappedResizeScales(referenceVector, previewVector, u, v)
  if (!snappedScales) {
    return null
  }

  const { scaleU, scaleV } = snappedScales
  if (
    !Number.isFinite(scaleU)
    || !Number.isFinite(scaleV)
    || scaleU <= 1e-6
    || scaleV <= 1e-6
  ) {
    return null
  }

  const local = subtractPoint(backdrop.center, referenceStart)
  const localU = dotPoint(local, u)
  const localV = dotPoint(local, v)

  return {
    ...backdrop,
    center: {
      x: referenceStart.x + u.x * localU * scaleU + v.x * localV * scaleV,
      y: referenceStart.y + u.y * localU * scaleU + v.y * localV * scaleV,
    },
    width: backdrop.width * scaleU,
    height: backdrop.height * scaleV,
  }
}

export function rotateBackdropFromReference(
  backdrop: BackdropImage,
  referenceStart: Point,
  referenceEnd: Point,
  previewPoint: Point,
): BackdropImage | null {
  const startVector = subtractPoint(referenceEnd, referenceStart)
  const endVector = subtractPoint(previewPoint, referenceStart)
  const startLength = pointLength(startVector)
  const endLength = pointLength(endVector)
  if (startLength <= 1e-9 || endLength <= 1e-9) {
    return null
  }

  const angle = Math.atan2(crossPoint(startVector, endVector), dotPoint(startVector, endVector))
  if (!Number.isFinite(angle)) {
    return null
  }

  return {
    ...backdrop,
    center: rotatePointAround(backdrop.center, referenceStart, angle),
    orientationAngle: normalizeAngleDegrees(backdrop.orientationAngle + angle * (180 / Math.PI)),
  }
}

export function filletRadiusFromPoint(
  feature: SketchFeature,
  anchorIndex: number,
  previewPoint: Point,
): number | null {
  const profile = feature.sketch.profile
  const anchors = profileVertices(profile)
  const anchorCount = anchors.length
  const hasIncoming = profile.closed || anchorIndex > 0
  const hasOutgoing = profile.closed || anchorIndex < anchorCount - 1
  if (!hasIncoming || !hasOutgoing || anchorIndex < 0 || anchorIndex >= anchorCount) {
    return null
  }

  const corner = anchors[anchorIndex]
  const previousAnchor = anchors[(anchorIndex - 1 + anchorCount) % anchorCount]
  const nextAnchor = anchors[(anchorIndex + 1) % anchorCount]
  const incomingDirection = normalizePoint(subtractPoint(previousAnchor, corner))
  const outgoingDirection = normalizePoint(subtractPoint(nextAnchor, corner))
  if (!incomingDirection || !outgoingDirection) {
    return null
  }

  const incomingIndex = profile.closed ? (anchorIndex - 1 + profile.segments.length) % profile.segments.length : anchorIndex - 1
  const outgoingIndex = anchorIndex
  const incomingSegment = profile.segments[incomingIndex]
  const outgoingSegment = profile.segments[outgoingIndex]
  if (!incomingSegment || !outgoingSegment || incomingSegment.type !== 'line' || outgoingSegment.type !== 'line') {
    return null
  }

  const previewVector = subtractPoint(previewPoint, corner)
  const trim = Math.max(0, dotPoint(previewVector, incomingDirection), dotPoint(previewVector, outgoingDirection))
  if (!(trim > 1e-9)) {
    return null
  }

  const turnDot = clampNumber(dotPoint(incomingDirection, outgoingDirection), -1, 1)
  const interiorAngle = Math.acos(turnDot)
  if (!Number.isFinite(interiorAngle) || interiorAngle <= 1e-3 || Math.abs(Math.PI - interiorAngle) <= 1e-3) {
    return null
  }

  return trim * Math.tan(interiorAngle / 2)
}

export function filletFeatureFromPoint(
  feature: SketchFeature,
  anchorIndex: number,
  previewPoint: Point,
): SketchFeature | null {
  const radius = filletRadiusFromPoint(feature, anchorIndex, previewPoint)
  if (!radius) {
    return null
  }

  const profile = applyLineCornerFillet(feature.sketch.profile, anchorIndex, radius)
  if (!profile) {
    return null
  }

  return {
    ...feature,
    kind: inferFeatureKind(profile),
    sketch: {
      ...feature.sketch,
      profile,
    },
  }
}

function translateClamp(clamp: Clamp, dx: number, dy: number): Clamp {
  return {
    ...clamp,
    x: clamp.x + dx,
    y: clamp.y + dy,
  }
}

function translateTab(tab: Tab, dx: number, dy: number): Tab {
  return {
    ...tab,
    x: tab.x + dx,
    y: tab.y + dy,
  }
}

function duplicateFeatureName(name: string, features: SketchFeature[], totalCount: number, step: number): string {
  if (totalCount === 1) {
    // Single copy: "Name Copy"
    const baseName = `${name} Copy`
    if (!features.some((f) => f.name === baseName)) return baseName
    let index = 2
    while (features.some((f) => f.name === `${baseName} ${index}`)) index += 1
    return `${baseName} ${index}`
  }
  // Multiple copies: "Name Copy 1", "Name Copy 2", …
  let index = step
  while (features.some((f) => f.name === `${name} Copy ${index}`)) index += 1
  return `${name} Copy ${index}`
}

function uniqueFolderName(preferred: string, folders: FeatureFolder[]): string {
  return uniqueName(preferred, folders.map((folder) => folder.name))
}

function textFolderBaseName(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return 'Text'
  }
  return normalized.length > 24 ? `${normalized.slice(0, 24)}…` : normalized
}

function createTextFeatureAt(project: Project, config: TextToolConfig, anchor: Point): SketchFeature | null {
  const generatedShapes = generateTextShapes(config, { x: 0, y: 0 }).filter((shape) => !isProfileDegenerate(shape.profile))
  if (generatedShapes.length === 0) {
    return null
  }

  const featureName = uniqueName(textFolderBaseName(config.text), project.features.map((feature) => feature.name))
  const isFirstFeature = project.features.length === 0
  const textData: TextFeatureData = {
    text: config.text,
    style: config.style,
    fontId: config.fontId,
    size: config.size,
  }

  return normalizeFeatureZRange({
    id: nextUniqueGeneratedId(project, 'f'),
    name: featureName,
    kind: 'text',
    text: textData,
    folderId: null,
    sketch: {
      profile: getTextFrameProfile(config, anchor),
      origin: { x: 0, y: 0 },
      orientationAngle: 90,
      dimensions: [],
      constraints: [],
    },
    operation: isFirstFeature ? 'add' : config.operation,
    z_top: project.stock.thickness,
    z_bottom: 0,
    visible: true,
    locked: false,
  })
}

function duplicateClampName(name: string, clamps: Clamp[]): string {
  const baseName = `${name} Copy`
  if (!clamps.some((clamp) => clamp.name === baseName)) {
    return baseName
  }

  let index = 2
  while (clamps.some((clamp) => clamp.name === `${baseName} ${index}`)) {
    index += 1
  }
  return `${baseName} ${index}`
}

function duplicateTabName(name: string, tabs: Tab[]): string {
  const baseName = `${name} Copy`
  if (!tabs.some((tab) => tab.name === baseName)) {
    return baseName
  }

  let index = 2
  while (tabs.some((tab) => tab.name === `${baseName} ${index}`)) {
    index += 1
  }
  return `${baseName} ${index}`
}

function nextAutoTabName(baseName: string, tabs: Tab[]): string {
  const preferred = `${baseName} Tab`
  if (!tabs.some((tab) => tab.name === preferred)) {
    return preferred
  }

  let index = 2
  while (tabs.some((tab) => tab.name === `${preferred} ${index}`)) {
    index += 1
  }
  return `${preferred} ${index}`
}

function defaultAutoTabZTop(project: Project): number {
  return Math.min(project.stock.thickness, convertLength(3, 'mm', project.meta.units))
}

function resolveToolDiameterInProjectUnits(project: Project, operation: Operation): number | null {
  if (!operation.toolRef) {
    return null
  }

  const tool = project.tools.find((entry) => entry.id === operation.toolRef) ?? null
  if (!tool || !(tool.diameter > 0)) {
    return null
  }

  return tool.units === project.meta.units
    ? tool.diameter
    : convertLength(tool.diameter, tool.units, project.meta.units)
}

function buildAutoTabsForFeature(
  feature: SketchFeature,
  project: Project,
  operation: Operation,
  existingTabs: Tab[],
): Tab[] {
  const bounds = getProfileBounds(feature.sketch.profile)
  const width = Math.max(bounds.maxX - bounds.minX, convertLength(0.1, 'mm', project.meta.units))
  const height = Math.max(bounds.maxY - bounds.minY, convertLength(0.1, 'mm', project.meta.units))
  const cx = bounds.minX + width / 2
  const cy = bounds.minY + height / 2
  const toolDiameter = resolveToolDiameterInProjectUnits(project, operation)
  const minSize = Math.max(convertLength(3, 'mm', project.meta.units), (toolDiameter ?? 0) * 1.25)
  const maxSize = Math.max(minSize, Math.min(width, height) * 0.18)
  const size = Math.min(Math.max(minSize, Math.min(width, height) * 0.1), maxSize)
  const zTop = defaultAutoTabZTop(project)
  const zBottom = 0

  const entries: Array<Pick<Tab, 'x' | 'y' | 'w' | 'h'>> =
    Math.min(width, height) < size * 3
      ? (
          width >= height
            ? [
                { x: cx - size / 2, y: bounds.minY - size / 2, w: size, h: size },
                { x: cx - size / 2, y: bounds.maxY - size / 2, w: size, h: size },
              ]
            : [
                { x: bounds.minX - size / 2, y: cy - size / 2, w: size, h: size },
                { x: bounds.maxX - size / 2, y: cy - size / 2, w: size, h: size },
              ]
        )
      : [
          { x: cx - size / 2, y: bounds.minY - size / 2, w: size, h: size },
          { x: cx - size / 2, y: bounds.maxY - size / 2, w: size, h: size },
          { x: bounds.minX - size / 2, y: cy - size / 2, w: size, h: size },
          { x: bounds.maxX - size / 2, y: cy - size / 2, w: size, h: size },
        ]

  const created: Tab[] = []
  for (const entry of entries) {
    created.push({
      id: nextUniqueGeneratedId(
        {
          ...project,
          tabs: [...existingTabs, ...created],
        },
        'tb',
      ),
      name: nextAutoTabName(feature.name, [...existingTabs, ...created]),
      x: entry.x,
      y: entry.y,
      w: entry.w,
      h: entry.h,
      z_top: zTop,
      z_bottom: zBottom,
      visible: true,
    })
  }

  return created
}

function duplicateToolName(name: string, tools: Tool[]): string {
  const baseName = `${name} Copy`
  if (!tools.some((tool) => tool.name === baseName)) {
    return baseName
  }

  let index = 2
  while (tools.some((tool) => tool.name === `${baseName} ${index}`)) {
    index += 1
  }
  return `${baseName} ${index}`
}

function toolMatchesTemplate(existingTool: Tool, candidate: Omit<Tool, 'id'>): boolean {
  return (
    existingTool.name === candidate.name
    && existingTool.units === candidate.units
    && existingTool.type === candidate.type
    && existingTool.diameter === candidate.diameter
    && existingTool.vBitAngle === candidate.vBitAngle
    && existingTool.flutes === candidate.flutes
    && existingTool.material === candidate.material
    && existingTool.defaultRpm === candidate.defaultRpm
    && existingTool.defaultFeed === candidate.defaultFeed
    && existingTool.defaultPlungeFeed === candidate.defaultPlungeFeed
    && existingTool.defaultStepdown === candidate.defaultStepdown
    && existingTool.defaultStepover === candidate.defaultStepover
  )
}

function operationKindLabel(kind: OperationKind): string {
  switch (kind) {
    case 'pocket':
      return 'Pocket'
    case 'v_carve':
      return 'V-Carve offset'
    case 'v_carve_recursive':
      return 'V-Carve skeleton'
    case 'edge_route_inside':
      return 'Edge route inside'
    case 'edge_route_outside':
      return 'Edge route outside'
    case 'surface_clean':
      return 'Surface clean'
    case 'follow_line':
      return 'Engrave'
  }
}

function duplicateOperationName(name: string, operations: Operation[]): string {
  const baseName = `${name} Copy`
  if (!operations.some((operation) => operation.name === baseName)) {
    return baseName
  }

  let index = 2
  while (operations.some((operation) => operation.name === `${baseName} ${index}`)) {
    index += 1
  }
  return `${baseName} ${index}`
}

function isOperationTargetValid(project: Project, kind: OperationKind, target: OperationTarget): boolean {
  if (kind === 'follow_line') {
    if (target.source !== 'features' || target.featureIds.length === 0) {
      return false
    }

    const features = target.featureIds
      .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
      .filter((feature): feature is SketchFeature => feature !== null)

    return features.length === target.featureIds.length
  }

  if (kind === 'surface_clean') {
    if (target.source !== 'features' || target.featureIds.length === 0) {
      return false
    }

    const features = target.featureIds
      .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
      .filter((feature): feature is SketchFeature => feature !== null)

    if (features.length !== target.featureIds.length) {
      return false
    }

    return features.every((feature) => feature.operation === 'add' && feature.sketch.profile.closed)
  }

  if (kind === 'v_carve' || kind === 'v_carve_recursive') {
    if (target.source !== 'features' || target.featureIds.length === 0) {
      return false
    }

    const features = target.featureIds
      .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
      .filter((feature): feature is SketchFeature => feature !== null)

    if (features.length !== target.featureIds.length) {
      return false
    }

    return features.every((feature) => feature.operation === 'subtract' && featureHasClosedGeometry(feature))
  }

  if (target.source !== 'features' || target.featureIds.length === 0) {
    return false
  }

  const features = target.featureIds
    .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
    .filter((feature): feature is SketchFeature => feature !== null)

  if (features.length !== target.featureIds.length) {
    return false
  }

  if (kind === 'pocket' || kind === 'edge_route_inside') {
    return features.every((feature) => feature.operation === 'subtract' && feature.sketch.profile.closed)
  }

  return features.every((feature) => feature.operation === 'add' && feature.sketch.profile.closed)
}

function defaultOperationName(kind: OperationKind, pass: OperationPass, operations: Operation[]): string {
  const baseName = kind === 'follow_line' || kind === 'v_carve' || kind === 'v_carve_recursive'
    ? operationKindLabel(kind)
    : `${operationKindLabel(kind)} ${pass === 'rough' ? 'Rough' : 'Finish'}`
  if (!operations.some((operation) => operation.name === baseName)) {
    return baseName
  }

  let index = 2
  while (operations.some((operation) => operation.name === `${baseName} ${index}`)) {
    index += 1
  }
  return `${baseName} ${index}`
}

function defaultOperationForTarget(
  project: Project,
  kind: OperationKind,
  pass: OperationPass,
  target: OperationTarget,
  index: number,
): Operation {
  const tool = project.tools[0] ?? defaultTool(project.meta.units, 1)
  const toolRef = project.tools[0]?.id ?? null

  return {
    id: `op${index + 1}`,
    name: defaultOperationName(kind, pass, project.operations),
    kind,
    pass,
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target,
    toolRef,
    stepdown: tool.defaultStepdown,
    stepover: tool.defaultStepover,
    feed: tool.defaultFeed,
    plungeFeed: tool.defaultPlungeFeed,
    rpm: tool.defaultRpm,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: convertLength(1, 'mm', project.meta.units),
    maxCarveDepth: convertLength(1, 'mm', project.meta.units),
    cutDirection: 'conventional',
  }
}

function fallbackOperationTarget(project: Project, kind: OperationKind): OperationTarget {
  if (kind === 'follow_line') {
    const firstFeature = project.features[0]
    return firstFeature
      ? { source: 'features', featureIds: [firstFeature.id] }
      : { source: 'stock' }
  }

  if (kind === 'v_carve' || kind === 'v_carve_recursive') {
    const firstSubtractFeature = project.features.find((feature) => feature.operation === 'subtract' && featureHasClosedGeometry(feature))
    return firstSubtractFeature
      ? { source: 'features', featureIds: [firstSubtractFeature.id] }
      : { source: 'stock' }
  }

  if (kind === 'surface_clean' || kind === 'edge_route_outside') {
    const firstAddFeature = project.features.find((feature) => feature.operation === 'add' && feature.sketch.profile.closed)
    if (firstAddFeature) {
      return { source: 'features', featureIds: [firstAddFeature.id] }
    }
  }

  if (kind === 'pocket' || kind === 'edge_route_inside') {
    const firstSubtractFeature = project.features.find((feature) => feature.operation === 'subtract' && feature.sketch.profile.closed)
    if (firstSubtractFeature) {
      return { source: 'features', featureIds: [firstSubtractFeature.id] }
    }
  }

  const firstFeature = project.features.find((feature) => feature.sketch.profile.closed)
  return firstFeature
    ? { source: 'features', featureIds: [firstFeature.id] }
    : { source: 'stock' }
}

function buildCopiedFeatures(
  sourceFeatures: SketchFeature[],
  existingFeatures: SketchFeature[],
  dx: number,
  dy: number,
  count: number,
): SketchFeature[] {
  const created: SketchFeature[] = []
  const projectLike: Project = {
    ...newProject(),
    features: existingFeatures,
    tools: [],
    operations: [],
  }

  for (let step = 1; step <= count; step += 1) {
    for (const sourceFeature of sourceFeatures) {
      const nextId = nextUniqueGeneratedId(
        {
          ...projectLike,
          features: [...existingFeatures, ...created],
        },
        'f',
      )
      created.push({
        ...sourceFeature,
        id: nextId,
        name: duplicateFeatureName(sourceFeature.name, [...existingFeatures, ...created], count, step),
        folderId: sourceFeature.folderId,
        sketch: {
          ...sourceFeature.sketch,
          profile: translateProfile(sourceFeature.sketch.profile, dx * step, dy * step),
        },
        locked: false,
      })
    }
  }

  return created
}

function buildCopiedClamps(
  sourceClamps: Clamp[],
  existingClamps: Clamp[],
  project: Project,
  dx: number,
  dy: number,
  count: number,
): Clamp[] {
  const created: Clamp[] = []

  for (let step = 1; step <= count; step += 1) {
    for (const sourceClamp of sourceClamps) {
      created.push({
        ...sourceClamp,
        id: nextUniqueGeneratedId(
          {
            ...project,
            clamps: [...existingClamps, ...created],
          },
          'cl',
        ),
        name: duplicateClampName(sourceClamp.name, [...existingClamps, ...created]),
        x: sourceClamp.x + dx * step,
        y: sourceClamp.y + dy * step,
      })
    }
  }

  return created
}

function buildCopiedTabs(
  sourceTabs: Tab[],
  existingTabs: Tab[],
  project: Project,
  dx: number,
  dy: number,
  count: number,
): Tab[] {
  const created: Tab[] = []

  for (let step = 1; step <= count; step += 1) {
    for (const sourceTab of sourceTabs) {
      created.push({
        ...sourceTab,
        id: nextUniqueGeneratedId(
          {
            ...project,
            tabs: [...existingTabs, ...created],
          },
          'tb',
        ),
        name: duplicateTabName(sourceTab.name, [...existingTabs, ...created]),
        x: sourceTab.x + dx * step,
        y: sourceTab.y + dy * step,
      })
    }
  }

  return created
}

function syncFeatureTreeProject(project: Project): Project {
  const featureFolders = project.featureFolders ?? []
  const folderIdSet = new Set(featureFolders.map((folder) => folder.id))
  const features = project.features.map((feature) => (
    feature.folderId && !folderIdSet.has(feature.folderId)
      ? { ...feature, folderId: null }
      : feature
  ))

  const featureMap = new Map(features.map((feature) => [feature.id, feature]))
  const usedRootFeatures = new Set<string>()
  const usedFolders = new Set<string>()
  const normalizedTree: FeatureTreeEntry[] = []

  for (const entry of project.featureTree ?? []) {
    if (entry.type === 'folder') {
      if (folderIdSet.has(entry.folderId) && !usedFolders.has(entry.folderId)) {
        normalizedTree.push(entry)
        usedFolders.add(entry.folderId)
      }
      continue
    }

    const feature = featureMap.get(entry.featureId)
    if (!feature || feature.folderId !== null || usedRootFeatures.has(entry.featureId)) {
      continue
    }

    normalizedTree.push(entry)
    usedRootFeatures.add(entry.featureId)
  }

  for (const folder of featureFolders) {
    if (!usedFolders.has(folder.id)) {
      normalizedTree.push({ type: 'folder', folderId: folder.id })
      usedFolders.add(folder.id)
    }
  }

  for (const feature of features) {
    if (feature.folderId === null && !usedRootFeatures.has(feature.id)) {
      normalizedTree.push({ type: 'feature', featureId: feature.id })
      usedRootFeatures.add(feature.id)
    }
  }

  const orderedFeatures: SketchFeature[] = []
  const pushedFeatureIds = new Set<string>()

  for (const entry of normalizedTree) {
    if (entry.type === 'folder') {
      for (const feature of features) {
        if (feature.folderId === entry.folderId && !pushedFeatureIds.has(feature.id)) {
          orderedFeatures.push(feature)
          pushedFeatureIds.add(feature.id)
        }
      }
      continue
    }

    const feature = featureMap.get(entry.featureId)
    if (feature && !pushedFeatureIds.has(feature.id)) {
      orderedFeatures.push(feature)
      pushedFeatureIds.add(feature.id)
    }
  }

  for (const feature of features) {
    if (!pushedFeatureIds.has(feature.id)) {
      orderedFeatures.push({ ...feature, folderId: null })
    }
  }

  return {
    ...project,
    features: orderedFeatures,
    featureFolders,
    featureTree: normalizedTree,
  }
}

function dedupeProjectIds(project: Project): Project {
  let localCounter = [
    ...project.features.map((feature) => idNumericSuffix(feature.id)),
    ...project.tools.map((tool) => idNumericSuffix(tool.id)),
    ...project.operations.map((operation) => idNumericSuffix(operation.id)),
    ...project.tabs.map((tab) => idNumericSuffix(tab.id)),
    ...project.clamps.map((clamp) => idNumericSuffix(clamp.id)),
  ].reduce((max, value) => Math.max(max, value), 0) + 1

  const nextLocalId = (prefix: string) => `${prefix}${String(localCounter++).padStart(4, '0')}`

  const seenFeatureIds = new Set<string>()
  const features = project.features.map((feature) => {
    if (!seenFeatureIds.has(feature.id)) {
      seenFeatureIds.add(feature.id)
      return feature
    }

    const nextId = nextLocalId('f')
    return {
      ...feature,
      id: nextId,
    }
  })

  const seenToolIds = new Set<string>()
  const tools = project.tools.map((tool) => {
    if (!seenToolIds.has(tool.id)) {
      seenToolIds.add(tool.id)
      return tool
    }

    const nextId = nextLocalId('t')
    return {
      ...tool,
      id: nextId,
    }
  })

  const seenOperationIds = new Set<string>()
  const operations = project.operations.map((operation) => {
    if (!seenOperationIds.has(operation.id)) {
      seenOperationIds.add(operation.id)
      return {
        ...operation,
      }
    }

    const nextId = nextLocalId('op')
    return {
      ...operation,
      id: nextId,
    }
  })

  const seenClampIds = new Set<string>()
  const clamps = project.clamps.map((clamp) => {
    if (!seenClampIds.has(clamp.id)) {
      seenClampIds.add(clamp.id)
      return { ...clamp }
    }

    const nextId = nextLocalId('cl')
    return {
      ...clamp,
      id: nextId,
    }
  })

  const seenTabIds = new Set<string>()
  const tabs = project.tabs.map((tab) => {
    if (!seenTabIds.has(tab.id)) {
      seenTabIds.add(tab.id)
      return { ...tab }
    }

    const nextId = nextLocalId('tb')
    return {
      ...tab,
      id: nextId,
    }
  })

  return {
    ...project,
    features,
    tools,
    operations,
    tabs,
    clamps,
  }
}

function normalizeOperation(operation: Operation, project: Project, index: number): Operation {
  const fallbackTarget = fallbackOperationTarget(project, operation.kind)
  const defaults = defaultOperationForTarget(project, operation.kind, 'rough', fallbackTarget, index)
  const normalized = {
    ...defaults,
    ...operation,
  }

  if (!isOperationTargetValid(project, normalized.kind, normalized.target)) {
    return {
      ...normalized,
      target: fallbackTarget,
    }
  }

  return normalized
}

function normalizeClamp(clamp: Clamp, units: Project['meta']['units'], index: number): Clamp {
  const defaultSize = convertLength(12, 'mm', units)
  const defaultHeight = convertLength(8, 'mm', units)
  return {
    id: clamp.id || `cl${index + 1}`,
    name: clamp.name || `Clamp ${index + 1}`,
    type: clamp.type ?? 'step_clamp',
    x: clamp.x ?? 0,
    y: clamp.y ?? 0,
    w: Math.max(clamp.w ?? defaultSize, convertLength(0.1, 'mm', units)),
    h: Math.max(clamp.h ?? defaultSize, convertLength(0.1, 'mm', units)),
    height: Math.max(clamp.height ?? defaultHeight, convertLength(0.1, 'mm', units)),
    visible: clamp.visible ?? true,
  }
}

function normalizeTab(tab: Tab, units: Project['meta']['units'], index: number): Tab {
  const defaultSize = convertLength(6, 'mm', units)
  const defaultBottom = 0
  const defaultTop = convertLength(3, 'mm', units)
  const zBottom = tab.z_bottom ?? defaultBottom
  const zTop = tab.z_top ?? defaultTop
  return {
    id: tab.id || `tb${index + 1}`,
    name: tab.name || `Tab ${index + 1}`,
    x: tab.x ?? 0,
    y: tab.y ?? 0,
    w: Math.max(tab.w ?? defaultSize, convertLength(0.1, 'mm', units)),
    h: Math.max(tab.h ?? defaultSize, convertLength(0.1, 'mm', units)),
    z_top: Math.max(zTop, zBottom),
    z_bottom: Math.min(zTop, zBottom),
    visible: tab.visible ?? true,
  }
}

function fitBackdropSize(
  sourceWidth: number,
  sourceHeight: number,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } {
  const safeSourceWidth = Math.max(sourceWidth, 1)
  const safeSourceHeight = Math.max(sourceHeight, 1)
  const scale = Math.min(maxWidth / safeSourceWidth, maxHeight / safeSourceHeight)
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1
  return {
    width: safeSourceWidth * safeScale,
    height: safeSourceHeight * safeScale,
  }
}

function createBackdropFromImage(
  project: Project,
  input: Pick<BackdropImage, 'name' | 'mimeType' | 'imageDataUrl' | 'intrinsicWidth' | 'intrinsicHeight'>,
): BackdropImage {
  const stockBounds = getStockBounds(project.stock)
  const maxWidth = Math.max((stockBounds.maxX - stockBounds.minX) * 0.9, convertLength(10, 'mm', project.meta.units))
  const maxHeight = Math.max((stockBounds.maxY - stockBounds.minY) * 0.9, convertLength(10, 'mm', project.meta.units))
  const fitted = fitBackdropSize(input.intrinsicWidth, input.intrinsicHeight, maxWidth, maxHeight)

  return {
    ...input,
    center: {
      x: (stockBounds.minX + stockBounds.maxX) / 2,
      y: (stockBounds.minY + stockBounds.maxY) / 2,
    },
    width: fitted.width,
    height: fitted.height,
    orientationAngle: 90,
    opacity: 0.6,
    visible: true,
  }
}

function replaceBackdropImage(existing: BackdropImage, project: Project, input: Pick<BackdropImage, 'name' | 'mimeType' | 'imageDataUrl' | 'intrinsicWidth' | 'intrinsicHeight'>): BackdropImage {
  const fitted = fitBackdropSize(
    input.intrinsicWidth,
    input.intrinsicHeight,
    Math.max(existing.width, convertLength(10, 'mm', project.meta.units)),
    Math.max(existing.height, convertLength(10, 'mm', project.meta.units)),
  )

  return {
    ...existing,
    ...input,
    width: fitted.width,
    height: fitted.height,
  }
}

function normalizeBackdrop(backdrop: BackdropImage | null | undefined, project: Project): BackdropImage | null {
  if (!backdrop?.imageDataUrl) {
    return null
  }

  const stockBounds = getStockBounds(project.stock)
  const fallbackWidth = Math.max((stockBounds.maxX - stockBounds.minX) * 0.9, convertLength(10, 'mm', project.meta.units))
  const fallbackHeight = Math.max((stockBounds.maxY - stockBounds.minY) * 0.9, convertLength(10, 'mm', project.meta.units))
  const fitted = fitBackdropSize(
    backdrop.intrinsicWidth ?? 1,
    backdrop.intrinsicHeight ?? 1,
    backdrop.width ?? fallbackWidth,
    backdrop.height ?? fallbackHeight,
  )

  return {
    name: backdrop.name || 'Backdrop',
    mimeType: backdrop.mimeType || 'image/png',
    imageDataUrl: backdrop.imageDataUrl,
    intrinsicWidth: Math.max(backdrop.intrinsicWidth ?? 1, 1),
    intrinsicHeight: Math.max(backdrop.intrinsicHeight ?? 1, 1),
    center: backdrop.center ?? {
      x: (stockBounds.minX + stockBounds.maxX) / 2,
      y: (stockBounds.minY + stockBounds.maxY) / 2,
    },
    width: Math.max(backdrop.width ?? fitted.width, convertLength(1, 'mm', project.meta.units)),
    height: Math.max(backdrop.height ?? fitted.height, convertLength(1, 'mm', project.meta.units)),
    orientationAngle: normalizeAngleDegrees(backdrop.orientationAngle ?? 90),
    opacity: Math.min(Math.max(backdrop.opacity ?? 0.6, 0), 1),
    visible: backdrop.visible ?? true,
  }
}

function normalizeMachineDefinitions(project: Project): {
  machineDefinitions: MachineDefinition[]
  selectedMachineId: string | null
} {
  const legacyMeta = project.meta as Project['meta'] & {
    machineId?: string | null
    customMachineDefinition?: MachineDefinition | null
  }

  const rawDefinitions = Array.isArray(project.meta.machineDefinitions)
    ? project.meta.machineDefinitions
    : null

  if (!rawDefinitions) {
    const machineDefinitions = copyBundledDefinitions()
    let selectedMachineId: string | null = legacyMeta.machineId ?? null

    if (legacyMeta.customMachineDefinition) {
      const customDefinition = validateMachineDefinition({
        ...legacyMeta.customMachineDefinition,
        builtin: false,
      })
      machineDefinitions.push(customDefinition)
      selectedMachineId = customDefinition.id
    }

    return {
      machineDefinitions,
      selectedMachineId: machineDefinitions.some((definition) => definition.id === selectedMachineId)
        ? selectedMachineId
        : null,
    }
  }

  const definitions: MachineDefinition[] = []
  const seenIds = new Set<string>()
  for (const rawDefinition of rawDefinitions) {
    try {
      const definition = validateMachineDefinition(rawDefinition)
      if (seenIds.has(definition.id)) {
        continue
      }
      seenIds.add(definition.id)
      definitions.push(definition)
    } catch {
      continue
    }
  }

  const selectedMachineId = project.meta.selectedMachineId ?? null

  return {
    machineDefinitions: definitions,
    selectedMachineId: definitions.some((definition) => definition.id === selectedMachineId)
      ? selectedMachineId
      : null,
  }
}

function normalizeProject(project: Project): Project {
  const normalizedMachines = normalizeMachineDefinitions(project)
  const meta = {
    ...project.meta,
    showFeatureInfo: project.meta.showFeatureInfo ?? true,
    maxTravelZ: project.meta.maxTravelZ ?? defaultMaxTravelZ(project.meta.units),
    operationClearanceZ: project.meta.operationClearanceZ ?? defaultOperationClearanceZ(project.meta.units),
    clampClearanceXY: project.meta.clampClearanceXY ?? defaultClampClearanceXY(project.meta.units),
    clampClearanceZ: project.meta.clampClearanceZ ?? defaultClampClearanceZ(project.meta.units),
    machineDefinitions: normalizedMachines.machineDefinitions,
    selectedMachineId: normalizedMachines.selectedMachineId,
  }

  const stockBounds = getStockBounds(project.stock)
  const legacyDefaultOrigin =
    project.origin
    && project.origin.name === 'Origin'
    && project.origin.x === stockBounds.minX
    && project.origin.y === stockBounds.minY
    && project.origin.z === project.stock.thickness

  const normalizedBase = syncFeatureTreeProject(dedupeProjectIds({
    ...project,
    meta,
    stock: {
      ...project.stock,
      profile: {
        ...project.stock.profile,
        closed: project.stock.profile.closed ?? true,
      },
    },
    features: project.features.map(normalizeFeatureZRange),
    featureFolders: project.featureFolders ?? [],
    featureTree: project.featureTree ?? [],
    tools: project.tools.map((tool, index) => normalizeTool(tool, project.meta.units, index)),
    tabs: (project.tabs ?? []).map((tab, index) => normalizeTab(tab, project.meta.units, index)),
    clamps: (project.clamps ?? []).map((clamp, index) => normalizeClamp(clamp, project.meta.units, index)),
    origin: project.origin
      ? (legacyDefaultOrigin ? defaultOrigin(project.stock) : project.origin)
      : defaultOrigin(project.stock),
  }))

  const normalizedProject = {
    ...normalizedBase,
    backdrop: normalizeBackdrop(project.backdrop, normalizedBase),
    operations: project.operations.map((operation, index) => normalizeOperation(operation, normalizedBase, index)),
  }

  syncIdCounter(normalizedProject)
  return normalizedProject
}

function cloneProject(project: Project): Project {
  return structuredClone(project)
}

function instantiateProjectTemplate(template?: Project, name?: string): Project {
  const now = new Date().toISOString()

  if (!template) {
    return newProject(name)
  }

  const cloned = cloneProject(template)
  return {
    ...cloned,
    meta: {
      ...cloned.meta,
      name: name?.trim() || 'Untitled',
      created: now,
      modified: now,
    },
    backdrop: null,
    dimensions: {},
    features: [],
    featureFolders: [],
    featureTree: [],
    global_constraints: [],
    tools: [],
    operations: [],
    tabs: [],
    clamps: [],
    ai_history: [],
  }
}

function projectsEqual(a: Project, b: Project): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

// ============================================================
// Rule: first feature must always be 'add'
// The part model is built from the first 'add' solid — subsequent
// features add or subtract from it. Stock is a separate concept
// used only during CAM operation generation.
// ============================================================

export function isFirstFeatureValid(features: SketchFeature[]): boolean {
  if (features.length === 0) return true
  return features[0].operation === 'add'
}

// ============================================================
// Store implementation
// ============================================================

// ---------------------------------------------------------------------------
// Auto-dirty helper
// Wraps Zustand's set so any patch that changes `project` also sets
// `dirty: true`, unless the patch explicitly provides a `dirty` value.
// ---------------------------------------------------------------------------
type SetFn = (
  update: Partial<ProjectStore> | ((state: ProjectStore) => Partial<ProjectStore>)
) => void

function withAutoDirty(rawSet: SetFn): SetFn {
  return (update) => {
    if (typeof update === 'function') {
      rawSet((state) => {
        const patch = update(state)
        if ('project' in patch && patch.project !== state.project && !('dirty' in patch)) {
          return { ...patch, dirty: true }
        }
        return patch
      })
    } else {
      if ('project' in update && !('dirty' in update)) {
        rawSet({ ...update, dirty: true })
      } else {
        rawSet(update)
      }
    }
  }
}

export const useProjectStore = create<ProjectStore>((rawSet, get) => {
  const set = withAutoDirty(rawSet)
  return {
  project: normalizeProject(newProject()),
  backdropImageLoading: false,
  filePath: null,
  lastExportPath: null,
  dirty: false,
  history: {
    past: [],
    future: [],
    transactionStart: null,
  },
  ...createSelectionSlice(set, get, {
    cloneProject,
    normalizeProject,
  }),
  ...createPendingActionsSlice(set, get),
  ...createPendingCompletionSlice(set, get, {
    cloneProject,
    projectsEqual,
    translateProfile,
    translateClamp,
    translateTab,
    buildCopiedFeatures,
    buildCopiedClamps,
    buildCopiedTabs,
    resizeBackdropFromReference,
    rotateBackdropFromReference,
    resizeFeatureFromReference,
    rotateFeatureFromReference,
    previewOffsetFeatures,
    syncFeatureTreeProject,
    createDerivedFeature,
  }),
  ...createPendingAddSlice(set, get, {
    cloneProject,
    syncFeatureTreeProject,
    createTextFeatureAt,
    appendSplineDraftSegment,
    buildArcSegmentFromThreePoints,
    resolveCompositeDraftSegments,
    resolveOpenCompositeDraftSegments,
    cloneSegment,
  }),

  // ── Project ──────────────────────────────────────────────

  createNewProject: (template, name) =>
    set((state) => {
      const nextProject = normalizeProject(instantiateProjectTemplate(template, name))
      return {
        project: nextProject,
        dirty: false,
        filePath: null,
        pendingAdd: null,
        pendingMove: null,
        pendingTransform: null,
        pendingOffset: null,
        selection: emptySelection(),
        history: {
          past: [...state.history.past, cloneProject(state.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  setProjectName: (name) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        meta: { ...s.project.meta, name, modified: new Date().toISOString() },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      if (s.history.transactionStart) {
        return { project: nextProject }
      }
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  setProjectClearances: (patch) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        meta: {
          ...s.project.meta,
          ...patch,
          modified: new Date().toISOString(),
        },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      if (s.history.transactionStart) {
        return { project: nextProject }
      }
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  setShowFeatureInfo: (visible) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        meta: {
          ...s.project.meta,
          showFeatureInfo: visible,
          modified: new Date().toISOString(),
        },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      if (s.history.transactionStart) {
        return { project: nextProject }
      }
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  setOrigin: (origin) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        origin,
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      if (s.history.transactionStart) {
        return { project: nextProject }
      }
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  startPlaceOrigin: () =>
    set((s) => ({
      pendingAdd: { shape: 'origin', session: nextPlacementSession() },
      pendingMove: null,
      pendingTransform: null,
      sketchEditSession: null,
      selection: {
        ...s.selection,
        selectedFeatureId: null,
        selectedFeatureIds: [],
        selectedNode: { type: 'origin' },
        mode: 'feature',
        hoveredFeatureId: null,
        activeControl: null,
      },
    })),

  placeOriginAt: (point) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        origin: {
          ...s.project.origin,
          x: point.x,
          y: point.y,
        },
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }
      return {
        project: nextProject,
        pendingAdd: null,
        pendingTransform: null,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  loadBackdropImage: (input) =>
    set((s) => {
      const nextBackdrop = s.project.backdrop
        ? replaceBackdropImage(s.project.backdrop, s.project, input)
        : createBackdropFromImage(s.project, input)
      const nextProject = {
        ...s.project,
        backdrop: nextBackdrop,
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }
      return {
        project: nextProject,
        pendingShapeAction: null,
        selection: {
          ...s.selection,
          selectedFeatureId: null,
          selectedFeatureIds: [],
          selectedNode: { type: 'backdrop' },
          mode: 'feature',
          activeControl: null,
        },
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  setBackdropImageLoading: (loading) => set({ backdropImageLoading: loading }),

  setBackdrop: (backdrop) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        backdrop: backdrop ? normalizeBackdrop(backdrop, s.project) : null,
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      if (s.history.transactionStart) {
        return { project: nextProject }
      }
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  updateBackdrop: (patch) =>
    set((s) => {
      if (!s.project.backdrop) {
        return {}
      }

      const nextBackdrop = normalizeBackdrop({ ...s.project.backdrop, ...patch }, s.project)
      const nextProject = {
        ...s.project,
        backdrop: nextBackdrop,
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      if (s.history.transactionStart) {
        return { project: nextProject }
      }
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  deleteBackdrop: () =>
    set((s) => {
      if (!s.project.backdrop) {
        return {}
      }

      return {
        project: {
          ...s.project,
          backdrop: null,
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        },
        selection:
          s.selection.selectedNode?.type === 'backdrop'
            ? {
                ...s.selection,
                selectedNode: null,
                selectedFeatureId: null,
                selectedFeatureIds: [],
                mode: 'feature',
                activeControl: null,
              }
            : s.selection,
        pendingMove: s.pendingMove?.entityType === 'backdrop' ? null : s.pendingMove,
        pendingTransform: s.pendingTransform?.entityType === 'backdrop' ? null : s.pendingTransform,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  setSelectedMachineId: (id) =>
    set((s) => {
      const nextId = id && s.project.meta.machineDefinitions.some((definition) => definition.id === id)
        ? id
        : null
      const nextProject = {
        ...s.project,
        meta: { ...s.project.meta, selectedMachineId: nextId, modified: new Date().toISOString() },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  addMachineDefinition: (definition) =>
    set((s) => {
      const normalizedDefinition = validateMachineDefinition({
        ...definition,
        builtin: false,
      })
      const machineDefinitions = [
        ...s.project.meta.machineDefinitions.filter((entry) => entry.id !== normalizedDefinition.id),
        normalizedDefinition,
      ]
      const nextProject = {
        ...s.project,
        meta: {
          ...s.project.meta,
          machineDefinitions,
          selectedMachineId: normalizedDefinition.id,
          modified: new Date().toISOString(),
        },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  removeMachineDefinition: (id) =>
    set((s) => {
      const definition = s.project.meta.machineDefinitions.find((entry) => entry.id === id)
      if (!definition || definition.builtin) {
        return {}
      }

      const machineDefinitions = s.project.meta.machineDefinitions.filter((entry) => entry.id !== id)
      const nextProject = {
        ...s.project,
        meta: {
          ...s.project.meta,
          machineDefinitions,
          selectedMachineId: s.project.meta.selectedMachineId === id ? null : s.project.meta.selectedMachineId,
          modified: new Date().toISOString(),
        },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }

      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  refreshMachineDefinitions: () =>
    set((s) => {
      const bundledDefinitions = copyBundledDefinitions()
      const bundledIds = new Set(bundledDefinitions.map((definition) => definition.id))
      const customDefinitions = s.project.meta.machineDefinitions.filter(
        (definition) => !definition.builtin && !bundledIds.has(definition.id)
      )
      const machineDefinitions = [...bundledDefinitions, ...customDefinitions]
      const selectedMachineId = machineDefinitions.some(
        (definition) => definition.id === s.project.meta.selectedMachineId
      )
        ? s.project.meta.selectedMachineId
        : null
      const nextProject = {
        ...s.project,
        meta: {
          ...s.project.meta,
          machineDefinitions,
          selectedMachineId,
          modified: new Date().toISOString(),
        },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  loadProject: (p) =>
    set((state) => {
      const normalizedProject = normalizeProject(p)
      const stockDefaults = defaultStock(undefined, undefined, undefined, normalizedProject.meta.units)
      const gridDefaults = defaultGrid(normalizedProject.meta.units)
      const nextProject = {
        ...normalizedProject,
        grid: {
          ...gridDefaults,
          ...normalizedProject.grid,
        },
        stock: {
          ...stockDefaults,
          ...normalizedProject.stock,
          origin: normalizedProject.stock?.origin ?? stockDefaults.origin,
          profile: normalizedProject.stock?.profile ?? stockDefaults.profile,
        },
        origin: normalizedProject.origin ?? defaultOrigin(normalizedProject.stock ?? stockDefaults),
      }
      return {
        project: nextProject,
        pendingAdd: null,
        pendingMove: null,
        pendingTransform: null,
        pendingOffset: null,
        selection: emptySelection(),
        history: {
          past: [...state.history.past, cloneProject(state.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  saveProject: () => {
    const p = get().project
    const updated = {
      ...p,
      meta: { ...p.meta, modified: new Date().toISOString() },
    }
    return JSON.stringify(updated, null, 2)
  },

  openProjectFromText: (content, path) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      throw new Error('Failed to parse project file.')
    }
    const normalized = normalizeProject(parsed as ReturnType<typeof normalizeProject>)
    const stockDefaults = defaultStock(undefined, undefined, undefined, normalized.meta.units)
    const gridDefaults = defaultGrid(normalized.meta.units)
    set((state) => ({
      project: {
        ...normalized,
        grid: { ...gridDefaults, ...normalized.grid },
        stock: {
          ...stockDefaults,
          ...normalized.stock,
          origin: normalized.stock?.origin ?? stockDefaults.origin,
          profile: normalized.stock?.profile ?? stockDefaults.profile,
        },
        origin: normalized.origin ?? defaultOrigin(normalized.stock ?? stockDefaults),
      },
      filePath: path,
      dirty: false,
      pendingAdd: null,
      pendingMove: null,
      pendingTransform: null,
      pendingOffset: null,
      selection: emptySelection(),
      history: {
        past: [...state.history.past, cloneProject(state.project)].slice(-100),
        future: [],
        transactionStart: null,
      },
    }))
  },

  markSaved: (path) =>
    rawSet({ filePath: path, dirty: false }),

  markExported: (path) =>
    set({ lastExportPath: path }),

  undo: () =>
    set((state) => {
      const previous = state.history.past.at(-1)
      if (!previous) {
        return {}
      }
      const restored = normalizeProject(cloneProject(previous))
      return {
        project: restored,
        pendingAdd: null,
        pendingMove: null,
        pendingTransform: null,
        pendingOffset: null,
        selection: sanitizeSelection(restored, state.selection),
        history: {
          past: state.history.past.slice(0, -1),
          future: [cloneProject(state.project), ...state.history.future].slice(0, 100),
          transactionStart: null,
        },
      }
    }),

  redo: () =>
    set((state) => {
      const next = state.history.future[0]
      if (!next) {
        return {}
      }
      const restored = normalizeProject(cloneProject(next))
      return {
        project: restored,
        pendingAdd: null,
        pendingMove: null,
        pendingTransform: null,
        pendingOffset: null,
        selection: sanitizeSelection(restored, state.selection),
        history: {
          past: [...state.history.past, cloneProject(state.project)].slice(-100),
          future: state.history.future.slice(1),
          transactionStart: null,
        },
      }
    }),

  beginHistoryTransaction: () =>
    set((state) => {
      if (state.history.transactionStart) {
        return {}
      }
      return {
        history: {
          ...state.history,
          transactionStart: cloneProject(state.project),
        },
      }
    }),

  commitHistoryTransaction: () =>
    set((state) => {
      const { transactionStart } = state.history
      if (!transactionStart) {
        return {}
      }
      if (projectsEqual(transactionStart, state.project)) {
        return {
          history: {
            ...state.history,
            transactionStart: null,
          },
        }
      }
      return {
        history: {
          past: [...state.history.past, cloneProject(transactionStart)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  cancelHistoryTransaction: () =>
    set((state) => {
      const { transactionStart } = state.history
      if (!transactionStart) {
        return {}
      }
      const restored = normalizeProject(cloneProject(transactionStart))
      return {
        project: restored,
        pendingAdd: null,
        pendingMove: null,
        pendingTransform: null,
        pendingOffset: null,
        selection: sanitizeSelection(restored, state.selection),
        history: {
          ...state.history,
          transactionStart: null,
        },
      }
    }),

  // ── Stock ────────────────────────────────────────────────

  setStock: (stock) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        stock,
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      if (s.history.transactionStart) {
        return { project: nextProject }
      }
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  setGrid: (grid) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        grid,
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      if (s.history.transactionStart) {
        return { project: nextProject }
      }
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  setUnits: (units) =>
    set((s) => {
      if (s.project.meta.units === units) {
        return {}
      }

      const convertedProject = convertProjectUnits(s.project, units)
      const nextProject = {
        ...convertedProject,
        meta: { ...convertedProject.meta, modified: new Date().toISOString() },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      if (s.history.transactionStart) {
        return { project: nextProject }
      }
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  addTool: () => {
    const state = get()
    const nextId = nextUniqueGeneratedId(state.project, 't')
    const template = defaultTool(state.project.meta.units, state.project.tools.length + 1)
    const tool: Tool = {
      ...template,
      id: nextId,
    }

    set((s) => {
      const nextProject = {
        ...s.project,
        tools: [...s.project.tools, tool],
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    })

    return nextId
  },

  importTools: (tools) => {
    const state = get()
    const imported: Tool[] = []
    let nextProject = state.project

    for (const sourceTool of tools) {
      if (nextProject.tools.some((tool) => toolMatchesTemplate(tool, sourceTool))) {
        continue
      }

      const nextId = nextUniqueGeneratedId(nextProject, 't')
      const tool = normalizeTool(
        {
          ...sourceTool,
          id: nextId,
        },
        sourceTool.units,
        nextProject.tools.length,
      )

      imported.push(tool)
      nextProject = {
        ...nextProject,
        tools: [...nextProject.tools, tool],
      }
    }

    if (imported.length === 0) {
      return []
    }

    set((s) => ({
      project: {
        ...nextProject,
        meta: { ...nextProject.meta, modified: new Date().toISOString() },
      },
      history: {
        past: [...s.history.past, cloneProject(s.project)].slice(-100),
        future: [],
        transactionStart: null,
      },
    }))

    return imported.map((tool) => tool.id)
  },

  updateTool: (id, patch) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        tools: s.project.tools.map((tool) => (tool.id === id ? { ...tool, ...patch } : tool)),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      if (s.history.transactionStart) {
        return { project: nextProject }
      }
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  deleteTool: (id) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        tools: s.project.tools.filter((tool) => tool.id !== id),
        operations: s.project.operations.map((operation) =>
          operation.toolRef === id ? { ...operation, toolRef: null } : operation
        ),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  duplicateTool: (id) => {
    const state = get()
    const sourceTool = state.project.tools.find((tool) => tool.id === id)
    if (!sourceTool) {
      return null
    }

    const nextId = nextUniqueGeneratedId(state.project, 't')
    const duplicate: Tool = {
      ...sourceTool,
      id: nextId,
      name: duplicateToolName(sourceTool.name, state.project.tools),
    }

    set((s) => ({
      project: {
        ...s.project,
        tools: [...s.project.tools, duplicate],
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      },
      history: {
        past: [...s.history.past, cloneProject(s.project)].slice(-100),
        future: [],
        transactionStart: null,
      },
    }))

    return nextId
  },

  addOperation: (kind, pass, target) => {
    const state = get()
    if (!isOperationTargetValid(state.project, kind, target)) {
      return null
    }

    const nextId = nextUniqueGeneratedId(state.project, 'op')
    const template = defaultOperationForTarget(state.project, kind, pass, target, state.project.operations.length)
    const operation: Operation = {
      ...template,
      id: nextId,
      showToolpath: true,
      pass,
    }

    set((s) => ({
      project: {
        ...s.project,
        operations: [...s.project.operations, operation],
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      },
      history: {
        past: [...s.history.past, cloneProject(s.project)].slice(-100),
        future: [],
        transactionStart: null,
      },
    }))

    return nextId
  },

  updateOperation: (id, patch) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        operations: s.project.operations.map((operation) => {
          if (operation.id !== id) {
            return operation
          }

          const nextOperation = { ...operation, ...patch }
          return isOperationTargetValid(s.project, nextOperation.kind, nextOperation.target)
            ? nextOperation
            : operation
        }),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  setAllOperationToolpathVisibility: (visible) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        operations: s.project.operations.map((operation) => ({
          ...operation,
          showToolpath: visible,
        })),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  deleteOperation: (id) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        operations: s.project.operations.filter((operation) => operation.id !== id),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  duplicateOperation: (id) => {
    const state = get()
    const sourceOperation = state.project.operations.find((operation) => operation.id === id)
    if (!sourceOperation) {
      return null
    }

    const nextId = nextUniqueGeneratedId(state.project, 'op')
    const duplicate: Operation = {
      ...sourceOperation,
      id: nextId,
      name: duplicateOperationName(sourceOperation.name, state.project.operations),
      showToolpath: true,
    }

    set((s) => ({
      project: {
        ...s.project,
        operations: [...s.project.operations, duplicate],
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      },
      history: {
        past: [...s.history.past, cloneProject(s.project)].slice(-100),
        future: [],
        transactionStart: null,
      },
    }))

    return nextId
  },

  reorderOperations: (ids) =>
    set((s) => {
      const byId = new Map(s.project.operations.map((operation) => [operation.id, operation]))
      const reordered = ids
        .map((id) => byId.get(id))
        .filter((operation): operation is Operation => Boolean(operation))

      const untouched = s.project.operations.filter((operation) => !ids.includes(operation.id))
      const nextOperations = [...reordered, ...untouched]
      const nextProject = {
        ...s.project,
        operations: nextOperations,
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  // ── Features ─────────────────────────────────────────────

  addFeatureFolder: () => {
    const state = get()
    const nextId = nextUniqueGeneratedId(state.project, 'fd')
    const folder: FeatureFolder = {
      id: nextId,
      name: `Folder ${state.project.featureFolders.length + 1}`,
      collapsed: false,
    }

    set((s) => {
      const nextProject = syncFeatureTreeProject({
        ...s.project,
        featureFolders: [...s.project.featureFolders, folder],
        featureTree: [...s.project.featureTree, { type: 'folder', folderId: nextId }],
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      })
      return {
        project: nextProject,
        pendingShapeAction: null,
        selection: {
          ...s.selection,
          selectedFeatureId: null,
          selectedFeatureIds: [],
          selectedNode: { type: 'folder', folderId: nextId },
          mode: 'feature',
          activeControl: null,
        },
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    })

    return nextId
  },

  updateFeatureFolder: (id, patch) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        featureFolders: s.project.featureFolders.map((folder) => (
          folder.id === id ? { ...folder, ...patch } : folder
        )),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  deleteFeatureFolder: (id) =>
    set((s) => {
      const folderFeatures = s.project.features.filter((feature) => feature.folderId === id)
      const nextFeatureTree = s.project.featureTree.flatMap((entry) => (
        entry.type === 'folder' && entry.folderId === id
          ? folderFeatures.map((feature) => ({ type: 'feature', featureId: feature.id } as FeatureTreeEntry))
          : [entry]
      ))
      const nextProject = syncFeatureTreeProject({
        ...s.project,
        featureFolders: s.project.featureFolders.filter((folder) => folder.id !== id),
        featureTree: nextFeatureTree,
        features: s.project.features.map((feature) => (
          feature.folderId === id ? { ...feature, folderId: null } : feature
        )),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      })
      return {
        project: nextProject,
        selection: {
          ...s.selection,
          selectedNode: s.selection.selectedNode?.type === 'folder' && s.selection.selectedNode.folderId === id
            ? { type: 'features_root' }
            : s.selection.selectedNode,
          selectedFeatureId: s.selection.selectedFeatureId,
          selectedFeatureIds: s.selection.selectedFeatureIds,
          mode: 'feature',
          activeControl: null,
        },
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  assignFeaturesToFolder: (featureIds, folderId) =>
    set((s) => {
      const ids = featureIds.filter((id, index) => featureIds.indexOf(id) === index)
      if (ids.length === 0) {
        return {}
      }
      const nextProject = syncFeatureTreeProject({
        ...s.project,
        features: s.project.features.map((feature) => (
          ids.includes(feature.id) ? { ...feature, folderId } : feature
        )),
        featureTree: [
          ...s.project.featureTree.filter((entry) => !(entry.type === 'feature' && ids.includes(entry.featureId))),
          ...(folderId === null ? ids.map((featureId) => ({ type: 'feature', featureId } as FeatureTreeEntry)) : []),
        ],
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      })
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  moveFeatureTreeFeature: (featureId, folderId, beforeFeatureId = null) =>
    set((s) => {
      const sourceFeature = s.project.features.find((feature) => feature.id === featureId)
      if (!sourceFeature) {
        return {}
      }
      if (folderId !== null && !s.project.featureFolders.some((folder) => folder.id === folderId)) {
        return {}
      }

      const remainingFeatures = s.project.features.filter((feature) => feature.id !== featureId)
      const nextSourceFeature = { ...sourceFeature, folderId }
      let insertIndex = remainingFeatures.length

      if (beforeFeatureId) {
        const beforeIndex = remainingFeatures.findIndex((feature) => feature.id === beforeFeatureId)
        const beforeFeature = remainingFeatures.find((feature) => feature.id === beforeFeatureId)
        if (beforeIndex !== -1 && beforeFeature && beforeFeature.folderId === folderId) {
          insertIndex = beforeIndex
        }
      } else if (folderId !== null) {
        const folderIndexes = remainingFeatures
          .map((feature, index) => (feature.folderId === folderId ? index : -1))
          .filter((index) => index !== -1)
        if (folderIndexes.length > 0) {
          insertIndex = folderIndexes[folderIndexes.length - 1] + 1
        }
      }

      const nextFeatures = [...remainingFeatures]
      nextFeatures.splice(insertIndex, 0, nextSourceFeature)

      const rootEntries = s.project.featureTree.filter((entry) => (
        entry.type === 'folder' ||
        (entry.type === 'feature' && entry.featureId !== featureId)
      ))

      let nextFeatureTree = rootEntries
      if (folderId === null) {
        const nextEntry: FeatureTreeEntry = { type: 'feature', featureId }
        if (beforeFeatureId) {
          const targetRootIndex = rootEntries.findIndex((entry) => entry.type === 'feature' && entry.featureId === beforeFeatureId)
          if (targetRootIndex !== -1) {
            nextFeatureTree = [...rootEntries]
            nextFeatureTree.splice(targetRootIndex, 0, nextEntry)
          } else {
            nextFeatureTree = [...rootEntries, nextEntry]
          }
        } else {
          nextFeatureTree = [...rootEntries, nextEntry]
        }
      }

      const nextProject = syncFeatureTreeProject({
        ...s.project,
        features: nextFeatures,
        featureTree: nextFeatureTree,
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      })

      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  reorderFeatureTreeEntries: (entries) =>
    set((s) => {
      const nextProject = syncFeatureTreeProject({
        ...s.project,
        featureTree: entries,
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      })
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  setAllFeaturesVisible: (visible) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        features: s.project.features.map((feature) => ({ ...feature, visible })),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  toggleFolderVisible: (folderId) =>
    set((s) => {
      const folderFeatures = s.project.features.filter((f) => f.folderId === folderId)
      const anyVisible = folderFeatures.some((f) => f.visible)
      const nextVisible = !anyVisible
      const nextProject = {
        ...s.project,
        features: s.project.features.map((f) =>
          f.folderId === folderId ? { ...f, visible: nextVisible } : f
        ),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  selectFolderFeatures: (folderId) =>
    set((s) => {
      const ids = s.project.features
        .filter((f) => f.folderId === folderId)
        .map((f) => f.id)
      if (ids.length === 0) {
        return {}
      }
      const primaryId = ids.at(-1) ?? null
      return {
        pendingOffset: null,
        pendingShapeAction: null,
        selection: {
          ...s.selection,
          selectedFeatureId: primaryId,
          selectedFeatureIds: ids,
          selectedNode: primaryId ? { type: 'feature', featureId: primaryId } : null,
          mode: 'feature',
          activeControl: null,
        },
        sketchEditSession: null,
      }
    }),

  addFeature: (feature) =>
    set((s) => {
      const safeId = s.project.features.some((existing) => existing.id === feature.id)
        ? nextUniqueGeneratedId(s.project, 'f')
        : feature.id
      // First feature must always be 'add' — it is the base solid of the part model.
      const isFirst = s.project.features.length === 0
      // Determine folder context and insertion point from current selection.
      const selectedNode = !isFirst ? s.selection.selectedNode : null
      let effectiveFolderId: string | null = feature.folderId ?? null
      let insertAfterFeatureId: string | null = null
      if (selectedNode?.type === 'folder') {
        effectiveFolderId = selectedNode.folderId
      } else if (selectedNode?.type === 'feature') {
        const selectedFeature = s.project.features.find((f) => f.id === selectedNode.featureId)
        effectiveFolderId = selectedFeature?.folderId ?? null
        insertAfterFeatureId = selectedNode.featureId
      }
      const safeFeature: SketchFeature = isFirst
        ? normalizeFeatureZRange({ ...feature, id: safeId, folderId: null, operation: 'add' })
        : normalizeFeatureZRange({ ...feature, id: safeId, folderId: effectiveFolderId })
      // Build features and featureTree arrays with correct insertion position.
      let nextFeatures: SketchFeature[]
      let nextTree: FeatureTreeEntry[]
      if (insertAfterFeatureId !== null) {
        const idx = s.project.features.findIndex((f) => f.id === insertAfterFeatureId)
        nextFeatures = idx >= 0
          ? [...s.project.features.slice(0, idx + 1), safeFeature, ...s.project.features.slice(idx + 1)]
          : [...s.project.features, safeFeature]
        if (effectiveFolderId === null) {
          // Root-level: insert tree entry immediately after selected feature's entry.
          const treeIdx = s.project.featureTree.findIndex(
            (e) => e.type === 'feature' && e.featureId === insertAfterFeatureId
          )
          nextTree = treeIdx >= 0
            ? [...s.project.featureTree.slice(0, treeIdx + 1), { type: 'feature', featureId: safeFeature.id }, ...s.project.featureTree.slice(treeIdx + 1)]
            : [...s.project.featureTree, { type: 'feature', featureId: safeFeature.id }]
        } else {
          // Folder feature: sync handles ordering by features[] position; tree entry will be dropped.
          nextTree = [...s.project.featureTree, { type: 'feature', featureId: safeFeature.id }]
        }
      } else {
        nextFeatures = [...s.project.features, safeFeature]
        nextTree = [...s.project.featureTree, { type: 'feature', featureId: safeFeature.id }]
      }
      const nextProject = syncFeatureTreeProject({
        ...s.project,
        features: nextFeatures,
        featureTree: nextTree,
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      })
      return {
        project: nextProject,
        selection: {
          ...s.selection,
          selectedFeatureId: safeFeature.id,
          selectedFeatureIds: [safeFeature.id],
          selectedNode: { type: 'feature', featureId: safeFeature.id },
          mode: 'feature',
          activeControl: null,
        },
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  importShapes: (input) => {
    const state = get()
    const sourceShapes = input.shapes.filter((shape) => !isProfileDegenerate(shape.profile))
    if (sourceShapes.length === 0) {
      return []
    }

    const folderId = nextUniqueGeneratedId(state.project, 'fd')
    const folderName = uniqueFolderName(stripFileExtension(input.fileName), state.project.featureFolders)
    const folder: FeatureFolder = {
      id: folderId,
      name: folderName,
      collapsed: false,
    }

    const existingNames = state.project.features.map((feature) => feature.name)
    const createdFeatures: SketchFeature[] = []
    let nextProjectLike: Project = {
      ...state.project,
      features: [...state.project.features],
      featureFolders: [...state.project.featureFolders, folder],
    }

    sourceShapes.forEach((shape, index) => {
      const featureName = uniqueName(
        shape.name || `${input.sourceType.toUpperCase()} ${index + 1}`,
        [...existingNames, ...createdFeatures.map((feature) => feature.name)],
      )
      const isFirstFeature = state.project.features.length === 0 && createdFeatures.length === 0

      const nextId = nextUniqueGeneratedId(nextProjectLike, 'f')
      const feature = normalizeFeatureZRange({
        ...createImportedFeature(shape, state.project, folderId, featureName, isFirstFeature ? 'add' : 'subtract'),
        id: nextId,
      })

      createdFeatures.push(feature)
      nextProjectLike = {
        ...nextProjectLike,
        features: [...nextProjectLike.features, feature],
      }
    })

    if (createdFeatures.length === 0) {
      return []
    }

    set((s) => {
      const nextProject = syncFeatureTreeProject({
        ...s.project,
        featureFolders: [...s.project.featureFolders, folder],
        featureTree: [...s.project.featureTree, { type: 'folder', folderId }],
        features: [...s.project.features, ...createdFeatures],
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      })
      const createdIds = createdFeatures.map((feature) => feature.id)
      const primaryId = createdIds.at(-1) ?? null

      return {
        project: nextProject,
        selection: {
          ...s.selection,
          selectedFeatureId: primaryId,
          selectedFeatureIds: createdIds,
          selectedNode: primaryId ? { type: 'feature', featureId: primaryId } : { type: 'folder', folderId },
          mode: 'feature',
          activeControl: null,
        },
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    })

    return createdFeatures.map((feature) => feature.id)
  },

  updateFeature: (id, patch) =>
    set((s) => {
      const features = s.project.features
      const isFirst = features.length > 0 && features[0].id === id
      // Prevent changing the first feature's operation away from 'add'
      const safePatch: Partial<SketchFeature> =
        isFirst && patch.operation !== undefined && patch.operation !== 'add'
          ? { ...patch, operation: 'add' }
          : patch
      const nextProject = {
        ...s.project,
        features: features.map((f) =>
          f.id === id ? normalizeFeatureZRange({ ...f, ...safePatch }) : f
        ),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      if (s.history.transactionStart) {
        return { project: nextProject }
      }
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  deleteFeature: (id) =>
    get().deleteFeatures([id]),

  deleteFeatures: (ids) =>
    set((s) => {
      const idsToDelete = new Set(ids)
      const nextProject = syncFeatureTreeProject({
        ...s.project,
        features: s.project.features.filter((feature) => !idsToDelete.has(feature.id)),
        featureTree: s.project.featureTree.filter((entry) => !(entry.type === 'feature' && idsToDelete.has(entry.featureId))),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      })
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      const remainingSelectedIds = s.selection.selectedFeatureIds.filter((featureId) => !idsToDelete.has(featureId))
      const nextPrimaryId =
        s.selection.selectedFeatureId && !idsToDelete.has(s.selection.selectedFeatureId)
          ? s.selection.selectedFeatureId
          : remainingSelectedIds.at(-1) ?? null
      return {
        project: nextProject,
        selection: {
          ...s.selection,
          selectedFeatureId: nextPrimaryId,
          selectedFeatureIds: remainingSelectedIds,
          selectedNode: nextPrimaryId ? { type: 'feature', featureId: nextPrimaryId } : null,
          mode: nextPrimaryId && remainingSelectedIds.length === 1 ? s.selection.mode : 'feature',
          activeControl: nextPrimaryId && remainingSelectedIds.length === 1 ? s.selection.activeControl : null,
        },
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  mergeSelectedFeatures: (keepOriginals = false) => {
    const state = get()
    const selectedIdSet = new Set(state.selection.selectedFeatureIds)
    const selectedFeatures = state.project.features
      .filter((feature) => selectedIdSet.has(feature.id))
      .filter((feature) => feature.sketch.profile.closed)

    if (selectedFeatures.length < 2) {
      return []
    }

    const anchorFeature = selectedFeatures[0]
    const baseFeature = anchorFeature
    const joinNameStem = normalizeDerivedFeatureNameStem(baseFeature.name)
    const unionPaths = unionClipperPaths(selectedFeatures.map((feature) => flattenFeatureToClipperPath(feature)))
    const createdFeatures = unionPaths
      .map((path, index) => {
        const profile = clipperContourToProfile(path)
        if (!profile) {
          return null
        }
        const nextProject = { ...state.project, features: [...state.project.features] }
        return createDerivedFeature(
          nextProject,
          baseFeature,
          profile,
          baseFeature.operation,
          uniqueName(index === 0 ? `${joinNameStem} Join` : `${joinNameStem} Join ${index + 1}`, [
            ...state.project.features.map((feature) => feature.name),
          ]),
        )
      })
      .filter((feature): feature is SketchFeature => feature !== null)

    if (createdFeatures.length === 0) {
      return []
    }

    set((s) => {
      const idsToReplace = new Set(keepOriginals ? [] : selectedFeatures.map((feature) => feature.id))
      const createdGroups: DerivedFeatureGroup[] = [{ sourceId: anchorFeature.id, features: createdFeatures }]
      const nextProject = syncFeatureTreeProject({
        ...s.project,
        features: insertDerivedFeaturesAfterSources(s.project.features, createdGroups, idsToReplace),
        featureTree: insertDerivedFeatureTreeEntries(s.project.featureTree, s.project.features, createdGroups, idsToReplace),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      })
      const createdIds = createdFeatures.map((feature) => feature.id)
      const primaryId = createdIds.at(-1) ?? null
      return {
        project: nextProject,
        selection: {
          ...s.selection,
          selectedFeatureId: primaryId,
          selectedFeatureIds: createdIds,
          selectedNode: primaryId ? { type: 'feature', featureId: primaryId } : null,
          mode: 'feature',
          activeControl: null,
        },
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    })

    return createdFeatures.map((feature) => feature.id)
  },

  cutSelectedFeatures: (keepOriginals = false) => {
    const state = get()
    const selectedFeatures = state.selection.selectedFeatureIds
      .map((featureId) => state.project.features.find((feature) => feature.id === featureId) ?? null)
      .filter((feature): feature is SketchFeature => feature !== null)
      .filter((feature) => feature.sketch.profile.closed)

    if (selectedFeatures.length < 2) {
      return []
    }

    const cutter = selectedFeatures[selectedFeatures.length - 1]
    const targets = selectedFeatures.filter((feature) => feature.id !== cutter.id)
    const createdGroups = cutFeaturesByCutterGrouped(state.project, cutter, targets, createDerivedFeature)
    const createdFeatures = createdGroups.flatMap((group) => group.features)

    if (createdFeatures.length === 0) {
      return []
    }

    set((s) => {
      const idsToReplace = new Set(keepOriginals ? [] : targets.map((feature) => feature.id))
      const nextProject = syncFeatureTreeProject({
        ...s.project,
        features: insertDerivedFeaturesAfterSources(s.project.features, createdGroups, idsToReplace),
        featureTree: insertDerivedFeatureTreeEntries(s.project.featureTree, s.project.features, createdGroups, idsToReplace),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      })
      const createdIds = createdFeatures.map((feature) => feature.id)
      const primaryId = createdIds.at(-1) ?? null
      return {
        project: nextProject,
        selection: {
          ...s.selection,
          selectedFeatureId: primaryId,
          selectedFeatureIds: createdIds,
          selectedNode: primaryId ? { type: 'feature', featureId: primaryId } : null,
          mode: 'feature',
          activeControl: null,
        },
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    })

    return createdFeatures.map((feature) => feature.id)
  },

  offsetSelectedFeatures: (distance) => {
    const state = get()
    const createdFeatures = previewOffsetFeatures(state.project, state.selection.selectedFeatureIds, distance)

    if (createdFeatures.length === 0) {
      return []
    }

    set((s) => {
      const nextProject = syncFeatureTreeProject({
        ...s.project,
        features: [...s.project.features, ...createdFeatures],
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      })
      const createdIds = createdFeatures.map((feature) => feature.id)
      const primaryId = createdIds.at(-1) ?? null
      return {
        project: nextProject,
        selection: {
          ...s.selection,
          selectedFeatureId: primaryId,
          selectedFeatureIds: createdIds,
          selectedNode: primaryId ? { type: 'feature', featureId: primaryId } : null,
          mode: 'feature',
          activeControl: null,
        },
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    })

    return createdFeatures.map((feature) => feature.id)
  },

  reorderFeatures: (ids) =>
    set((s) => {
      const map = new Map(s.project.features.map((f) => [f.id, f]))
      const reordered = ids.map((id) => map.get(id)!).filter(Boolean)
      // If reorder would put a subtract feature first, silently promote it to add.
      // This is safer than blocking the reorder or showing an error mid-drag.
      if (reordered.length > 0 && reordered[0].operation !== 'add') {
        reordered[0] = { ...reordered[0], operation: 'add' }
      }
      return {
        project: syncFeatureTreeProject({
          ...s.project,
          features: reordered,
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        }),
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  addClamp: () => {
    const state = get()
    const bounds = getStockBounds(state.project.stock)
    const units = state.project.meta.units
    const width = convertLength(12, 'mm', units)
    const depth = convertLength(12, 'mm', units)
    const clampHeight = Math.min(
      Math.max(convertLength(8, 'mm', units), convertLength(0.1, 'mm', units)),
      state.project.stock.thickness,
    )
    const id = nextUniqueGeneratedId(state.project, 'cl')
    const clamp: Clamp = {
      id,
      name: `Clamp ${state.project.clamps.length + 1}`,
      type: 'step_clamp',
      x: bounds.minX + convertLength(4, 'mm', units),
      y: bounds.minY + convertLength(4, 'mm', units),
      w: width,
      h: depth,
      height: clampHeight,
      visible: true,
    }

    set((s) => ({
      project: {
        ...s.project,
        clamps: [...s.project.clamps, clamp],
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      },
      selection: {
        ...s.selection,
        selectedFeatureId: null,
        selectedFeatureIds: [],
        selectedNode: { type: 'clamp', clampId: id },
        mode: 'feature',
        activeControl: null,
      },
      sketchEditSession: null,
      history: {
        past: [...s.history.past, cloneProject(s.project)].slice(-100),
        future: [],
        transactionStart: null,
      },
    }))

    return id
  },

  updateClamp: (id, patch) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        clamps: s.project.clamps.map((clamp) => (clamp.id === id ? { ...clamp, ...patch } : clamp)),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  deleteClamp: (id) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        clamps: s.project.clamps.filter((clamp) => clamp.id !== id),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      const nextSelection =
        s.selection.selectedNode?.type === 'clamp' && s.selection.selectedNode.clampId === id
          ? emptySelection()
          : sanitizeSelection(nextProject, s.selection)
      return {
        project: nextProject,
        selection: nextSelection,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  duplicateClamp: (id) => {
    const state = get()
    const sourceClamp = state.project.clamps.find((clamp) => clamp.id === id)
    if (!sourceClamp) {
      return null
    }

    const nextId = nextUniqueGeneratedId(state.project, 'cl')
    const duplicate: Clamp = {
      ...sourceClamp,
      id: nextId,
      name: duplicateClampName(sourceClamp.name, state.project.clamps),
      x: sourceClamp.x + convertLength(4, 'mm', state.project.meta.units),
      y: sourceClamp.y + convertLength(4, 'mm', state.project.meta.units),
    }

    set((s) => ({
      project: {
        ...s.project,
        clamps: [...s.project.clamps, duplicate],
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      },
      selection: {
        ...s.selection,
        selectedFeatureId: null,
        selectedFeatureIds: [],
        selectedNode: { type: 'clamp', clampId: nextId },
        mode: 'feature',
        hoveredFeatureId: null,
        activeControl: null,
      },
      history: {
        past: [...s.history.past, cloneProject(s.project)].slice(-100),
        future: [],
        transactionStart: null,
      },
    }))

    return nextId
  },

  updateTab: (id, patch) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        tabs: s.project.tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  deleteTab: (id) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        tabs: s.project.tabs.filter((tab) => tab.id !== id),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      const nextSelection =
        s.selection.selectedNode?.type === 'tab' && s.selection.selectedNode.tabId === id
          ? emptySelection()
          : sanitizeSelection(nextProject, s.selection)
      return {
        project: nextProject,
        selection: nextSelection,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  setAllTabsVisible: (visible) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        tabs: s.project.tabs.map((tab) => ({ ...tab, visible })),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  setAllClampsVisible: (visible) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        clamps: s.project.clamps.map((clamp) => ({ ...clamp, visible })),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  moveFeatureControl: (featureId, control, point) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        features: s.project.features.map((feature) => {
          if (feature.id !== featureId || feature.locked) return feature

          const { profile } = feature.sketch
          const nextProfile = {
            ...profile,
            start: clonePoint(profile.start),
            segments: profile.segments.map(cloneSegment),
          }

          const anchorCount = profileVertices(nextProfile).length
          const segmentCount = nextProfile.segments.length
          if (anchorCount === 0) {
            return feature
          }

          function moveAnchor(anchorIndex: number, nextPoint: Point): void {
            const currentAnchor = anchorPointForIndex(nextProfile, anchorIndex)
            const incomingIndex = nextProfile.closed
              ? (anchorIndex - 1 + segmentCount) % segmentCount
              : anchorIndex > 0
                ? anchorIndex - 1
                : null
            const outgoingIndex = anchorIndex < segmentCount ? anchorIndex : null
            const originalIncoming = incomingIndex !== null ? nextProfile.segments[incomingIndex] : null
            const originalOutgoing = outgoingIndex !== null ? nextProfile.segments[outgoingIndex] : null
            const originalIncomingStart =
              incomingIndex === null
                ? null
                : incomingIndex === 0
                  ? nextProfile.start
                  : nextProfile.segments[incomingIndex - 1]?.to
            const incomingArcThrough =
              originalIncoming?.type === 'arc' && originalIncomingStart
                ? arcControlPoint(originalIncomingStart, originalIncoming)
                : null
            const outgoingArcThrough =
              originalOutgoing?.type === 'arc'
                ? arcControlPoint(currentAnchor, originalOutgoing)
                : null

            const dx = nextPoint.x - currentAnchor.x
            const dy = nextPoint.y - currentAnchor.y

            if (anchorIndex === 0) {
              nextProfile.start = nextPoint
              const closingSegment = nextProfile.closed ? nextProfile.segments[segmentCount - 1] : null
              if (closingSegment) {
                closingSegment.to = nextPoint
                if (closingSegment.type === 'bezier') {
                  closingSegment.control2 = translatePoint(closingSegment.control2, dx, dy)
                }
              }
            } else if (anchorIndex === anchorCount - 1 && !nextProfile.closed) {
              nextProfile.segments[segmentCount - 1].to = nextPoint
              const incomingSegment = nextProfile.segments[segmentCount - 1]
              if (incomingSegment.type === 'bezier') {
                incomingSegment.control2 = translatePoint(incomingSegment.control2, dx, dy)
              }
            } else if (anchorIndex > 0) {
              nextProfile.segments[anchorIndex - 1].to = nextPoint
              const incomingSegment = nextProfile.segments[anchorIndex - 1]
              if (incomingSegment.type === 'bezier') {
                incomingSegment.control2 = translatePoint(incomingSegment.control2, dx, dy)
              }
            }

            const incomingSegment = incomingIndex !== null ? nextProfile.segments[incomingIndex] : null
            if (incomingSegment?.type === 'arc' && incomingArcThrough) {
              const incomingStart =
                incomingIndex !== null && incomingIndex === 0
                  ? nextProfile.start
                  : incomingIndex !== null
                    ? nextProfile.segments[incomingIndex - 1]?.to
                    : null
              if (incomingStart) {
                const rebuiltIncoming = buildArcSegmentFromThreePoints(incomingStart, incomingSegment.to, incomingArcThrough)
                if (rebuiltIncoming && incomingIndex !== null) {
                  nextProfile.segments[incomingIndex] = rebuiltIncoming
                }
              }
            }

            const outgoingSegment = outgoingIndex !== null ? nextProfile.segments[outgoingIndex] : null
            if (outgoingSegment?.type === 'arc' && outgoingArcThrough) {
              const outgoingStart = anchorIndex === 0 ? nextProfile.start : nextProfile.segments[anchorIndex - 1]?.to
              if (outgoingStart) {
                const rebuiltOutgoing = buildArcSegmentFromThreePoints(outgoingStart, outgoingSegment.to, outgoingArcThrough)
                if (rebuiltOutgoing && outgoingIndex !== null) {
                  nextProfile.segments[outgoingIndex] = rebuiltOutgoing
                }
              }
            }

            if (outgoingSegment?.type === 'bezier') {
              outgoingSegment.control1 = translatePoint(outgoingSegment.control1, dx, dy)
            }
          }

          if (control.kind === 'anchor') {
            moveAnchor(control.index, point)
          } else if (control.kind === 'segment') {
            const segment = nextProfile.segments[control.index]
            if (segment?.type !== 'line') {
              return feature
            }

            const segmentStartIndex = control.index
            const segmentEndIndex = nextProfile.closed ? (control.index + 1) % anchorCount : control.index + 1
            const segmentStart = anchorPointForIndex(nextProfile, segmentStartIndex)
            const hitPoint = lerpPoint(segmentStart, segment.to, Math.max(0, Math.min(1, control.t ?? 0.5)))
            const dx = point.x - hitPoint.x
            const dy = point.y - hitPoint.y
            moveAnchor(segmentStartIndex, translatePoint(segmentStart, dx, dy))
            moveAnchor(segmentEndIndex, translatePoint(segment.to, dx, dy))
          } else if (control.kind === 'out_handle') {
            const outgoingSegment = nextProfile.segments[control.index]
            if (outgoingSegment?.type === 'bezier') {
              outgoingSegment.control1 = point

              const incomingSegment =
                nextProfile.closed
                  ? nextProfile.segments[(control.index - 1 + segmentCount) % segmentCount]
                  : control.index > 0
                    ? nextProfile.segments[control.index - 1]
                    : null
              const anchor = anchorPointForIndex(nextProfile, control.index)

              if (incomingSegment?.type === 'bezier' && anchor) {
                const oppositeLength = pointLength(subtractPoint(incomingSegment.control2, anchor))
                const direction = normalizePoint(subtractPoint(point, anchor))
                if (direction && oppositeLength > 1e-9) {
                  incomingSegment.control2 = subtractPoint(anchor, scalePoint(direction, oppositeLength))
                }
              }
            }
          } else if (control.kind === 'arc_handle') {
            const segmentIndex = control.index
            const arcSegment = nextProfile.segments[segmentIndex]
            if (arcSegment?.type === 'arc') {
              const arcStart =
                segmentIndex === 0 ? nextProfile.start : nextProfile.segments[segmentIndex - 1]?.to
              if (!arcStart) {
                return feature
              }

              const rebuiltSegment = buildArcSegmentFromThreePoints(arcStart, arcSegment.to, point)
              if (rebuiltSegment) {
                nextProfile.segments[segmentIndex] = rebuiltSegment
              }
            }
          } else {
            const incomingSegment =
              nextProfile.closed
                ? nextProfile.segments[(control.index - 1 + segmentCount) % segmentCount]
                : control.index > 0
                  ? nextProfile.segments[control.index - 1]
                  : null
            if (incomingSegment?.type === 'bezier') {
              incomingSegment.control2 = point

              const outgoingSegment = nextProfile.segments[control.index]
              const anchor = anchorPointForIndex(nextProfile, control.index)

              if (outgoingSegment?.type === 'bezier' && anchor) {
                const oppositeLength = pointLength(subtractPoint(outgoingSegment.control1, anchor))
                const direction = normalizePoint(subtractPoint(point, anchor))
                if (direction && oppositeLength > 1e-9) {
                  outgoingSegment.control1 = subtractPoint(anchor, scalePoint(direction, oppositeLength))
                }
              }
            }
          }

          const normalizedProfile = normalizeEditableProfileClosure(nextProfile)
          return {
            ...feature,
            sketch: {
              ...feature.sketch,
              profile: normalizedProfile,
            },
            kind: inferFeatureKind(normalizedProfile),
          }
        }),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      if (s.history.transactionStart) {
        return { project: nextProject }
      }
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  insertFeaturePoint: (featureId, target) =>
    set((s) => {
      let changed = false
      const nextProject = {
        ...s.project,
        features: s.project.features.map((feature) => {
          if (feature.id !== featureId || feature.locked) {
            return feature
          }

          const nextProfile = normalizeEditableProfileClosure(insertPointIntoProfile(feature.sketch.profile, target))
          if (JSON.stringify(nextProfile) === JSON.stringify(feature.sketch.profile)) {
            return feature
          }

          changed = true
          return {
            ...feature,
            kind: inferFeatureKind(nextProfile),
            sketch: {
              ...feature.sketch,
              profile: nextProfile,
            },
          }
        }),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }

      if (!changed || projectsEqual(nextProject, s.project)) {
        return {}
      }

      return {
        project: nextProject,
        selection: {
          ...s.selection,
          activeControl: null,
        },
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  deleteFeaturePoint: (featureId, anchorIndex) =>
    set((s) => {
      let changed = false
      const nextProject = {
        ...s.project,
        features: s.project.features.map((feature) => {
          if (feature.id !== featureId || feature.locked) {
            return feature
          }

          const nextProfileResult = deleteAnchorFromProfile(feature.sketch.profile, anchorIndex)
          const nextProfile = nextProfileResult ? normalizeEditableProfileClosure(nextProfileResult) : null
          if (!nextProfile) {
            return feature
          }

          changed = true
          return {
            ...feature,
            kind: inferFeatureKind(nextProfile),
            sketch: {
              ...feature.sketch,
              profile: nextProfile,
            },
          }
        }),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }

      if (!changed || projectsEqual(nextProject, s.project)) {
        return {}
      }

      return {
        project: nextProject,
        selection: {
          ...s.selection,
          activeControl: null,
        },
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  filletFeaturePoint: (featureId, anchorIndex, radius) =>
    set((s) => {
      let changed = false
      const nextProject = {
        ...s.project,
        features: s.project.features.map((feature) => {
          if (feature.id !== featureId || feature.locked) {
            return feature
          }

          const nextProfile = applyLineCornerFillet(feature.sketch.profile, anchorIndex, radius)
          if (!nextProfile || JSON.stringify(nextProfile) === JSON.stringify(feature.sketch.profile)) {
            return feature
          }

          changed = true
          return {
            ...feature,
            kind: inferFeatureKind(nextProfile),
            sketch: {
              ...feature.sketch,
              profile: nextProfile,
            },
          }
        }),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }

      if (!changed || projectsEqual(nextProject, s.project)) {
        return {}
      }

      return {
        project: nextProject,
        selection: {
          ...s.selection,
          activeControl: null,
        },
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  moveClampControl: (clampId, control, point) =>
    set((s) => {
      const minSize = convertLength(0.1, 'mm', s.project.meta.units)
      const nextProject = {
        ...s.project,
        clamps: s.project.clamps.map((clamp) => {
          if (clamp.id !== clampId) {
            return clamp
          }

          if (control.kind !== 'anchor') {
            return clamp
          }

          const corners = [
            { x: clamp.x, y: clamp.y },
            { x: clamp.x + clamp.w, y: clamp.y },
            { x: clamp.x + clamp.w, y: clamp.y + clamp.h },
            { x: clamp.x, y: clamp.y + clamp.h },
          ]
          const opposite = corners[(control.index + 2) % 4]
          const minX = Math.min(point.x, opposite.x)
          const maxX = Math.max(point.x, opposite.x)
          const minY = Math.min(point.y, opposite.y)
          const maxY = Math.max(point.y, opposite.y)

          return {
            ...clamp,
            x: minX,
            y: minY,
            w: Math.max(maxX - minX, minSize),
            h: Math.max(maxY - minY, minSize),
          }
        }),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }

      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      if (s.history.transactionStart) {
        return { project: nextProject }
      }
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  moveTabControl: (tabId, control, point) =>
    set((s) => {
      const minSize = convertLength(0.1, 'mm', s.project.meta.units)
      const nextProject = {
        ...s.project,
        tabs: s.project.tabs.map((tab) => {
          if (tab.id !== tabId) {
            return tab
          }

          if (control.kind !== 'anchor') {
            return tab
          }

          const corners = [
            { x: tab.x, y: tab.y },
            { x: tab.x + tab.w, y: tab.y },
            { x: tab.x + tab.w, y: tab.y + tab.h },
            { x: tab.x, y: tab.y + tab.h },
          ]
          const opposite = corners[(control.index + 2) % 4]
          const minX = Math.min(point.x, opposite.x)
          const maxX = Math.max(point.x, opposite.x)
          const minY = Math.min(point.y, opposite.y)
          const maxY = Math.max(point.y, opposite.y)

          return {
            ...tab,
            x: minX,
            y: minY,
            w: Math.max(maxX - minX, minSize),
            h: Math.max(maxY - minY, minSize),
          }
        }),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      if (s.history.transactionStart) {
        return { project: nextProject }
      }
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  autoPlaceTabsForOperation: (operationId) =>
    set((s) => {
      const operation = s.project.operations.find((entry) => entry.id === operationId) ?? null
      if (!operation || (operation.kind !== 'edge_route_inside' && operation.kind !== 'edge_route_outside')) {
        return {}
      }

      if (operation.target.source !== 'features' || operation.target.featureIds.length === 0) {
        return {}
      }

      const expectedOperation = operation.kind === 'edge_route_inside' ? 'subtract' : 'add'
      const targetFeatures = operation.target.featureIds
        .map((featureId) => s.project.features.find((feature) => feature.id === featureId) ?? null)
        .filter((feature): feature is SketchFeature => feature !== null)
        .filter((feature) => feature.operation === expectedOperation)

      if (targetFeatures.length === 0) {
        return {}
      }

      const createdTabs: Tab[] = []
      for (const feature of targetFeatures) {
        createdTabs.push(...buildAutoTabsForFeature(feature, s.project, operation, [...s.project.tabs, ...createdTabs]))
      }
      if (createdTabs.length === 0) {
        return {}
      }

      return {
        project: {
          ...s.project,
          tabs: [...s.project.tabs, ...createdTabs],
        },
        selection: {
          ...s.selection,
          selectedFeatureId: null,
          selectedFeatureIds: [],
          selectedNode: { type: 'tab', tabId: createdTabs[createdTabs.length - 1].id },
          mode: 'feature',
          hoveredFeatureId: null,
          activeControl: null,
        },
      }
    }),

  // ── Convenience constructors ─────────────────────────────

  addRectFeature: (name, x, y, w, h, depth) => {
    const id = nextUniqueGeneratedId(get().project, 'f')
      const feature: SketchFeature = {
        id,
        name,
        kind: 'rect',
        folderId: null,
        sketch: {
        profile: rectProfile(x, y, w, h),
        origin: { x: 0, y: 0 },
        orientationAngle: 90,
        dimensions: [],
        constraints: [],
      },
      operation: 'subtract',
      z_top: depth,
      z_bottom: 0,
      visible: true,
      locked: false,
    }
    get().addFeature(feature)
  },

  addCircleFeature: (name, cx, cy, r, depth) => {
    const id = nextUniqueGeneratedId(get().project, 'f')
      const feature: SketchFeature = {
        id,
        name,
        kind: 'circle',
        folderId: null,
        sketch: {
        profile: circleProfile(cx, cy, r),
        origin: { x: 0, y: 0 },
        orientationAngle: 90,
        dimensions: [],
        constraints: [],
      },
      operation: 'subtract',
      z_top: depth,
      z_bottom: 0,
      visible: true,
      locked: false,
    }
    get().addFeature(feature)
  },

  addPolygonFeature: (name, points, depth) => {
    const id = nextUniqueGeneratedId(get().project, 'f')
      const feature: SketchFeature = {
        id,
        name,
        kind: 'polygon',
        folderId: null,
        sketch: {
        profile: polygonProfile(points),
        origin: { x: 0, y: 0 },
        orientationAngle: 90,
        dimensions: [],
        constraints: [],
      },
      operation: 'subtract',
      z_top: depth,
      z_bottom: 0,
      visible: true,
      locked: false,
    }
    get().addFeature(feature)
  },

  addSplineFeature: (name, points, depth) => {
    const id = nextUniqueGeneratedId(get().project, 'f')
      const feature: SketchFeature = {
        id,
        name,
        kind: 'spline',
        folderId: null,
        sketch: {
        profile: splineProfile(points),
        origin: { x: 0, y: 0 },
        orientationAngle: 90,
        dimensions: [],
        constraints: [],
      },
      operation: 'subtract',
      z_top: depth,
      z_bottom: 0,
      visible: true,
      locked: false,
    }
    get().addFeature(feature)
  },
  }
})

const repairedInitialProject = normalizeProject(useProjectStore.getState().project)
if (!projectsEqual(repairedInitialProject, useProjectStore.getState().project)) {
  useProjectStore.setState((state) => ({
    project: repairedInitialProject,
    selection: sanitizeSelection(repairedInitialProject, state.selection),
  }))
}
