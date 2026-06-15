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
import {
  clearImportedModelCaches,
  loadImportedTriangleMesh,
  normalizeImportedMeshForStorage,
  serializeImportedMesh,
  type ImportedModelFormat,
} from '../engine/importedMesh'
import { clearSTLTransformedGeometryCache } from '../engine/csg'
import { createImportedFeature, isProfileDegenerate, mergeCamjFolders, uniqueName } from '../import'
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
  stockFromFeature,
  type TextFeatureData,
} from '../types/project'
import type {
  BackdropImage,
  Clamp,
  FeatureOperation,
  FeatureFolder,
  FeatureTreeEntry,
  LocalConstraint,
  Operation,
  OperationKind,
  OperationPass,
  OperationTarget,
  Point,
  Project,
  SketchProfile,
  SketchFeature,
  PersistedImportedMesh,
  STLFeatureData,
  Tab,
  Tool,
} from '../types/project'
import type { OpenProfileEndpoint } from './types'
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
import { generateEdgeRestRegionDrafts, generatePocketRestRegionDrafts } from '../engine/toolpaths/restRegions'
import { selectToolForOperation } from '../engine/operations/toolSelection'
import {
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
import { createDimensionsSlice } from './slices/dimensionsSlice'
import { createDimensionToolSlice } from './slices/dimensionToolSlice'
import { createFeatureSlice } from './slices/featureSlice'
import { createToolsSlice } from './slices/toolsSlice'
import { propagateConstraintsOnTranslate, propagateConstraintsOnRotate, rederiveConstraintGeometry, inferSemanticIndices, validateConstraintsOnFeature, solveFeatureTranslation, type ConstraintInput } from '../sketch/constraintSolver'
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

  if (segment.type === 'circle') {
    return {
      ...segment,
      center: clonePoint(segment.center),
      to: clonePoint(segment.to),
    }
  }

  return {
    ...segment,
    to: clonePoint(segment.to),
  }
}

function normalizeEditableProfileClosure(profile: SketchProfile): SketchProfile {
  if (profile.segments.length === 1 && profile.segments[0].type === 'circle') {
    return { ...profile, closed: true }
  }

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

export function createDerivedFeature(
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

function splitArcSegment(segment: Extract<Segment, { type: 'arc' | 'circle' }>, point: Point): [Segment, Segment] {
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

function reverseOpenProfile(profile: SketchProfile): SketchProfile {
  const anchors = [profile.start, ...profile.segments.map((segment) => segment.to)]
  const lastAnchor = anchors[anchors.length - 1] ?? profile.start
  const segments: Segment[] = []

  for (let index = profile.segments.length - 1; index >= 0; index -= 1) {
    const segment = profile.segments[index]
    const previousAnchor = anchors[index]
    if (!segment || !previousAnchor) {
      continue
    }

    if (segment.type === 'line') {
      segments.push({ type: 'line', to: clonePoint(previousAnchor) })
      continue
    }

    if (segment.type === 'bezier') {
      segments.push({
        type: 'bezier',
        control1: clonePoint(segment.control2),
        control2: clonePoint(segment.control1),
        to: clonePoint(previousAnchor),
      })
      continue
    }

    if (segment.type === 'arc') {
      segments.push({
        type: 'arc',
        center: clonePoint(segment.center),
        clockwise: !segment.clockwise,
        to: clonePoint(previousAnchor),
      })
    }
  }

  return {
    ...profile,
    start: clonePoint(lastAnchor),
    segments,
    closed: false,
  }
}

function endPointForOpenProfile(profile: SketchProfile): Point {
  return anchorPointForIndex(profile, profile.segments.length)
}

function orientOpenProfileTowardEndpoint(profile: SketchProfile, endpoint: OpenProfileEndpoint): SketchProfile {
  return endpoint === 'end'
    ? {
        ...profile,
        start: clonePoint(profile.start),
        segments: profile.segments.map(cloneSegment),
        closed: false,
      }
    : reverseOpenProfile(profile)
}

function orientOpenProfileFromEndpoint(profile: SketchProfile, endpoint: OpenProfileEndpoint): SketchProfile {
  return endpoint === 'start'
    ? {
        ...profile,
        start: clonePoint(profile.start),
        segments: profile.segments.map(cloneSegment),
        closed: false,
      }
    : reverseOpenProfile(profile)
}

function closeOpenProfile(profile: SketchProfile): SketchProfile | null {
  if (profile.closed || profile.segments.length === 0) {
    return null
  }

  const endPoint = endPointForOpenProfile(profile)
  const segments = profile.segments.map(cloneSegment)
  if (!pointsEqual(endPoint, profile.start)) {
    segments.push({ type: 'line', to: clonePoint(profile.start) })
  }

  return normalizeEditableProfileClosure({
    ...profile,
    start: clonePoint(profile.start),
    segments,
    closed: true,
  })
}

export function joinOpenProfiles(
  profile: SketchProfile,
  endpoint: OpenProfileEndpoint,
  targetProfile: SketchProfile,
  targetEndpoint: OpenProfileEndpoint,
): SketchProfile | null {
  if (profile.closed || targetProfile.closed || profile.segments.length === 0 || targetProfile.segments.length === 0) {
    return null
  }

  const leading = orientOpenProfileTowardEndpoint(profile, endpoint)
  const trailing = orientOpenProfileFromEndpoint(targetProfile, targetEndpoint)
  const leadingEnd = endPointForOpenProfile(leading)
  const trailingStart = trailing.start
  const segments = leading.segments.map(cloneSegment)

  if (!pointsEqual(leadingEnd, trailingStart)) {
    segments.push({ type: 'line', to: clonePoint(trailingStart) })
  }

  segments.push(...trailing.segments.map(cloneSegment))

  return normalizeEditableProfileClosure({
    ...profile,
    start: clonePoint(leading.start),
    segments,
    closed: false,
  })
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

interface ProfileBreakResult {
  profile: SketchProfile
  splitProfile: SketchProfile | null
}

function profileFromOpenSegments(start: Point, segments: Segment[]): SketchProfile | null {
  if (segments.length === 0) {
    return null
  }

  return {
    start: clonePoint(start),
    segments: segments.map(cloneSegment),
    closed: false,
  }
}

function deleteSegmentFromProfile(profile: SketchProfile, segmentIndex: number): ProfileBreakResult | null {
  if (segmentIndex < 0 || segmentIndex >= profile.segments.length || profile.segments.length <= 1) {
    return null
  }

  const segment = profile.segments[segmentIndex]
  if (!segment || segment.type === 'circle') {
    return null
  }

  if (profile.closed) {
    const nextSegments: Segment[] = []
    for (let offset = 1; offset < profile.segments.length; offset += 1) {
      const nextSegment = profile.segments[(segmentIndex + offset) % profile.segments.length]
      if (nextSegment) {
        nextSegments.push(cloneSegment(nextSegment))
      }
    }

    return {
      profile: {
        ...profile,
        start: clonePoint(segment.to),
        segments: nextSegments,
        closed: false,
      },
      splitProfile: null,
    }
  }

  const leading = profileFromOpenSegments(profile.start, profile.segments.slice(0, segmentIndex))
  const trailing = profileFromOpenSegments(segment.to, profile.segments.slice(segmentIndex + 1))
  const primaryProfile = leading ?? trailing
  if (!primaryProfile) {
    return null
  }

  return {
    profile: primaryProfile,
    splitProfile: leading && trailing ? trailing : null,
  }
}

function disconnectProfileAtAnchor(profile: SketchProfile, anchorIndex: number): ProfileBreakResult | null {
  const anchors = profileVertices(profile)
  if (anchorIndex < 0 || anchorIndex >= anchors.length || profile.segments.length === 0) {
    return null
  }

  if (profile.segments.length === 1 && profile.segments[0].type === 'circle') {
    return null
  }

  if (profile.closed) {
    const nextSegments: Segment[] = []
    for (let offset = 0; offset < profile.segments.length; offset += 1) {
      const segment = profile.segments[(anchorIndex + offset) % profile.segments.length]
      if (segment) {
        nextSegments.push(cloneSegment(segment))
      }
    }

    return {
      profile: {
        ...profile,
        start: clonePoint(anchors[anchorIndex]),
        segments: nextSegments,
        closed: false,
      },
      splitProfile: null,
    }
  }

  if (anchorIndex === 0 || anchorIndex === anchors.length - 1) {
    return null
  }

  const leading = profileFromOpenSegments(profile.start, profile.segments.slice(0, anchorIndex))
  const trailing = profileFromOpenSegments(anchors[anchorIndex], profile.segments.slice(anchorIndex))
  if (!leading || !trailing) {
    return null
  }

  return {
    profile: leading,
    splitProfile: trailing,
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
      if (segment.type === 'arc' || segment.type === 'circle') {
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

function clearStaleConstraints(features: SketchFeature[], movedIds: Set<string>): SketchFeature[] {
  // Policy: when the OWNER is moved/edited, update constraint value to new distance.
  // Do NOT delete constraints — they persist as persistent dimensions.
  if (movedIds.size === 0) return features
  let anyChanged = false
  const featureById = new Map(features.map((f) => [f.id, f]))
  const next = features.map((feature) => {
    if (!movedIds.has(feature.id)) return feature
    // This feature was moved — update constraint values to reflect new distances
    const updatedConstraints = feature.sketch.constraints.map((c) => {
      if (c.type !== 'fixed_distance') return c
      // Issue 11: Never update invalid constraints — keep them frozen at last valid position
      if (c.is_invalid) return c
      const refFeatureId = c.reference_feature_id ?? c.segment_ids[0]
      const refFeature = refFeatureId ? featureById.get(refFeatureId) : null
      // Re-derive geometry to get current positions
      const result = rederiveConstraintGeometry(
        feature.sketch.profile,
        refFeature?.sketch.profile ?? null,
        c,
      )
      if (result && result.isValid) {
        // Compute new distance from re-derived geometry
        let newValue: number | undefined
        if (result.referenceSegment) {
          const { a, b } = result.referenceSegment
          const sx = b.x - a.x
          const sy = b.y - a.y
          const segLen = Math.hypot(sx, sy)
          if (segLen > 1e-12) {
            const nx = -sy / segLen
            const ny = sx / segLen
            const rawSigned = (result.anchorPoint.x - a.x) * nx + (result.anchorPoint.y - a.y) * ny
            // Issue 14: Preserve the original sign — only update the magnitude.
            // This prevents the side from flipping when the feature drifts near the segment.
            const originalSign = (c.value ?? 0) >= 0 ? 1 : -1
            newValue = originalSign * Math.abs(rawSigned)
          }
        } else if (result.referencePoint) {
          newValue = Math.hypot(
            result.anchorPoint.x - result.referencePoint.x,
            result.anchorPoint.y - result.referencePoint.y,
          )
        }
        if (newValue !== undefined && Math.abs((c.value ?? 0) - newValue) > 1e-9) {
          anyChanged = true
          return {
            ...c,
            value: newValue,
            anchor_point: result.anchorPoint,
            reference_point: result.referencePoint,
            reference_segment: result.referenceSegment,
            is_invalid: false,
            error_message: undefined,
          }
        }
        // Update cached coords even if value unchanged
        return {
          ...c,
          anchor_point: result.anchorPoint,
          reference_point: result.referencePoint,
          reference_segment: result.referenceSegment,
          is_invalid: false,
          error_message: undefined,
        }
      }
      // No semantic fields — fall back to legacy coordinate update
      if (!c.anchor_point) return c
      let newValue: number | undefined
      if (c.reference_segment) {
        const { a, b } = c.reference_segment
        const sx = b.x - a.x
        const sy = b.y - a.y
        const segLen = Math.hypot(sx, sy)
        if (segLen > 1e-12) {
          const nx = -sy / segLen
          const ny = sx / segLen
          const rawSigned = (c.anchor_point.x - a.x) * nx + (c.anchor_point.y - a.y) * ny
          const originalSign = (c.value ?? 0) >= 0 ? 1 : -1
          newValue = originalSign * Math.abs(rawSigned)
        }
      } else if (c.reference_point) {
        newValue = Math.hypot(
          c.anchor_point.x - c.reference_point.x,
          c.anchor_point.y - c.reference_point.y,
        )
      }
      if (newValue !== undefined && Math.abs((c.value ?? 0) - newValue) > 1e-9) {
        anyChanged = true
        return { ...c, value: newValue }
      }
      return c
    })
    if (updatedConstraints.some((c, i) => c !== feature.sketch.constraints[i])) {
      anyChanged = true
      return { ...feature, sketch: { ...feature.sketch, constraints: updatedConstraints } }
    }
    return feature
  })
  return anyChanged ? next : features
}

export function transformProfile(
  profile: SketchFeature['sketch']['profile'],
  transformPoint: (point: Point) => Point,
): SketchFeature['sketch']['profile'] {
  return {
    ...profile,
    start: transformPoint(profile.start),
    segments: profile.segments.map((segment) => {
      if (segment.type === 'arc' || segment.type === 'circle') {
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

function transformStlFeatureData(
  stl: STLFeatureData | null | undefined,
  transformPoint: (point: Point) => Point,
): STLFeatureData | null | undefined {
  if (!stl?.silhouettePaths) return stl
  return {
    ...stl,
    silhouettePaths: stl.silhouettePaths.map((path) => path.map(transformPoint)),
  }
}

function modelAssetIdForFeature(featureId: string): string {
  return `model-asset-${featureId}`
}

export function normalizeImportedModelStorage(
  featureId: string,
  stl: STLFeatureData | null | undefined,
  modelAssets: Record<string, PersistedImportedMesh>,
): STLFeatureData | null | undefined {
  if (!stl) return stl
  if (stl.meshAssetId && modelAssets[stl.meshAssetId]) {
    const { mesh, fileData, filePath, ...rest } = stl
    return rest
  }

  const transientMesh = stl.mesh
  if (transientMesh) {
    const meshAssetId = stl.meshAssetId ?? modelAssetIdForFeature(featureId)
    modelAssets[meshAssetId] = transientMesh
    const { mesh, fileData, filePath, ...rest } = stl
    return {
      ...rest,
      meshAssetId,
      scale: stl.scale ?? 1,
      axisSwap: 'none',
    }
  }

  if (!stl.fileData) return stl

  const format: ImportedModelFormat = stl.format ?? 'stl'
  const mesh = loadImportedTriangleMesh(format, stl.fileData, stl.axisSwap ?? 'none')
  if (!mesh) return stl

  const normalizedMesh = normalizeImportedMeshForStorage(mesh, stl.scale ?? 1)
  const meshAssetId = stl.meshAssetId ?? modelAssetIdForFeature(featureId)
  modelAssets[meshAssetId] = serializeImportedMesh(normalizedMesh, format)
  return {
    ...stl,
    format,
    meshAssetId,
    filePath: undefined,
    fileData: undefined,
    mesh: undefined,
    scale: 1,
    axisSwap: 'none',
  }
}

export function pruneUnusedModelAssets(project: Project): Project {
  const usedAssetIds = new Set(
    project.features
      .map((feature) => feature.stl?.meshAssetId ?? null)
      .filter((id): id is string => id !== null),
  )
  const nextAssets: Record<string, PersistedImportedMesh> = {}
  for (const [id, asset] of Object.entries(project.modelAssets ?? {})) {
    if (usedAssetIds.has(id)) {
      nextAssets[id] = asset
    }
  }
  if (Object.keys(nextAssets).length === Object.keys(project.modelAssets ?? {}).length) {
    return project
  }
  return { ...project, modelAssets: nextAssets }
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

function mirrorDirectionAcrossAxis(direction: Point, axis: Point): Point {
  const projected = scalePoint(axis, dotPoint(direction, axis))
  return subtractPoint(scalePoint(projected, 2), direction)
}

function mirrorAngleAcrossLine(angleDegrees: number, lineStart: Point, lineEnd: Point): number | null {
  const axis = normalizePoint(subtractPoint(lineEnd, lineStart))
  if (!axis) {
    return null
  }

  const mirrored = mirrorDirectionAcrossAxis(angleToPoint(angleDegrees), axis)
  return normalizeAngleDegrees(Math.atan2(mirrored.y, mirrored.x) * (180 / Math.PI))
}

function mirrorProfile(
  profile: SketchFeature['sketch']['profile'],
  transformPoint: (point: Point) => Point,
): SketchFeature['sketch']['profile'] {
  return {
    ...profile,
    start: transformPoint(profile.start),
    segments: profile.segments.map((segment) => {
      if (segment.type === 'arc' || segment.type === 'circle') {
        return {
          ...segment,
          to: transformPoint(segment.to),
          center: transformPoint(segment.center),
          clockwise: !segment.clockwise,
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

function scaleNumericZSpan(
  zTop: SketchFeature['z_top'],
  zBottom: SketchFeature['z_bottom'],
  scale: number,
): Pick<SketchFeature, 'z_top' | 'z_bottom'> {
  if (typeof zTop !== 'number' || typeof zBottom !== 'number') {
    return { z_top: zTop, z_bottom: zBottom }
  }

  return {
    z_top: zBottom + (zTop - zBottom) * scale,
    z_bottom: zBottom,
  }
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

  const uniformModelScale = feature.kind === 'stl'
    ? projectedLength / referenceLength
    : null
  const scaleU = uniformModelScale ?? snappedScales.scaleU
  const scaleV = uniformModelScale ?? snappedScales.scaleV
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
  const resizedZ = feature.kind === 'stl'
    ? scaleNumericZSpan(feature.z_top, feature.z_bottom, scaleU)
    : { z_top: feature.z_top, z_bottom: feature.z_bottom }

  return {
    ...feature,
    kind: feature.kind === 'text' ? 'text' : (feature.kind === 'stl' ? 'stl' : inferFeatureKind(profile)),
    stl: feature.stl
      ? {
          ...transformStlFeatureData(feature.stl, transformPoint)!,
          scale: feature.stl.scale * scaleU,
        }
      : feature.stl,
    z_top: resizedZ.z_top,
    z_bottom: resizedZ.z_bottom,
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

  const rotatePoint = (point: Point) => rotatePointAround(point, referenceStart, angle)
  const profile = transformProfile(feature.sketch.profile, rotatePoint)
  return {
    ...feature,
    kind: ['text', 'stl'].includes(feature.kind) ? feature.kind : inferFeatureKind(profile),
    stl: transformStlFeatureData(feature.stl, rotatePoint),
    sketch: {
      ...feature.sketch,
      origin: rotatePoint(feature.sketch.origin),
      orientationAngle: normalizeAngleDegrees(
        (feature.sketch.orientationAngle ?? inferProfileOrientationAngle(feature.sketch.profile)) + angle * (180 / Math.PI),
      ),
      profile,
    },
  }
}

export function mirrorFeatureFromReference(
  feature: SketchFeature,
  referenceStart: Point,
  referenceEnd: Point,
): SketchFeature | null {
  const axis = normalizePoint(subtractPoint(referenceEnd, referenceStart))
  if (!axis) {
    return null
  }

  const mirrorPoint = (point: Point): Point => {
    const local = subtractPoint(point, referenceStart)
    const projected = scalePoint(axis, dotPoint(local, axis))
    return addPoint(referenceStart, subtractPoint(scalePoint(projected, 2), local))
  }
  const profile = mirrorProfile(feature.sketch.profile, mirrorPoint)
  const orientationAngle = mirrorAngleAcrossLine(
    feature.sketch.orientationAngle ?? inferProfileOrientationAngle(feature.sketch.profile),
    referenceStart,
    referenceEnd,
  )
  if (orientationAngle === null) {
    return null
  }

  return {
    ...feature,
    kind: ['text', 'stl'].includes(feature.kind) ? feature.kind : inferFeatureKind(profile),
    stl: transformStlFeatureData(feature.stl, mirrorPoint),
    sketch: {
      ...feature.sketch,
      origin: mirrorPoint(feature.sketch.origin),
      orientationAngle,
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

  return filletFeatureFromRadius(feature, anchorIndex, radius)
}

export function filletFeatureFromRadius(
  feature: SketchFeature,
  anchorIndex: number,
  radius: number,
): SketchFeature | null {
  const profile = applyLineCornerFillet(feature.sketch.profile, anchorIndex, radius)
  if (!profile) {
    return null
  }

  return {
    ...feature,
    kind: ['text', 'stl'].includes(feature.kind) ? feature.kind : inferFeatureKind(profile),
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
  const isFirstMachiningFeature = !project.features.some((feature) => feature.operation !== 'region')
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
    operation: isFirstMachiningFeature ? 'add' : config.operation,
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

export function folderIdForOperation(project: Project, folderId: string | null, operation: FeatureOperation | undefined): string | null {
  if (!folderId) return null
  const folder = project.featureFolders.find((entry) => entry.id === folderId) ?? null
  if (!folder) return null
  const folderSection = folder.section ?? 'features'
  return operation === 'region'
    ? folderSection === 'regions' ? folderId : null
    : folderSection === 'regions' ? null : folderId
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
    case 'rough_surface':
      return '3D Surface rough'
    case 'finish_surface':
      return '3D Surface finish'
    case 'finish_surface_cleanup':
      return '3D Surface cleanup'
    case 'follow_line':
      return 'Engrave'
    case 'drilling':
      return 'Drill'
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
  if (kind === 'drilling') {
    if (target.source !== 'features' || target.featureIds.length === 0) {
      return false
    }

    const features = target.featureIds
      .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
      .filter((feature): feature is SketchFeature => feature !== null)

    if (features.length !== target.featureIds.length) {
      return false
    }

    const machiningFeatures = features.filter((feature) => feature.operation !== 'region')
    const regionFeatures = features.filter((feature) => feature.operation === 'region')
    return machiningFeatures.length > 0
      && machiningFeatures.every((feature) => feature.kind === 'circle')
      && regionFeatures.every((feature) => feature.sketch.profile.closed)
  }

  if (kind === 'follow_line') {
    if (target.source !== 'features' || target.featureIds.length === 0) {
      return false
    }

    const features = target.featureIds
      .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
      .filter((feature): feature is SketchFeature => feature !== null)

    const machiningFeatures = features.filter((feature) => feature.operation !== 'region')
    const regionFeatures = features.filter((feature) => feature.operation === 'region')
    return features.length === target.featureIds.length
      && machiningFeatures.length > 0
      && regionFeatures.every((feature) => feature.sketch.profile.closed)
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

    const machiningFeatures = features.filter((feature) => feature.operation !== 'region')
    const regionFeatures = features.filter((feature) => feature.operation === 'region')
    return machiningFeatures.length > 0
      && machiningFeatures.every((feature) => (feature.operation === 'add' || feature.operation === 'model') && feature.sketch.profile.closed)
      && regionFeatures.every((feature) => feature.sketch.profile.closed)
  }

  if (kind === 'finish_surface' || kind === 'finish_surface_cleanup') {
    if (target.source !== 'features' || target.featureIds.length === 0) {
      return false
    }

    const features = target.featureIds
      .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
      .filter((feature): feature is SketchFeature => feature !== null)

    if (features.length !== target.featureIds.length) {
      return false
    }

    const modelCount = features.filter((f) => f.operation === 'model' && f.kind === 'stl').length
    const allValid = features.every((f) =>
      (f.operation === 'model' && f.kind === 'stl') ||
      (f.operation === 'region' && f.sketch.profile.closed)
    )

    if (modelCount !== 1) return false
    if (!allValid) return false
    return true
  }

  if (kind === 'rough_surface') {
    if (target.source !== 'features' || target.featureIds.length === 0) {
      return false
    }

    const features = target.featureIds
      .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
      .filter((feature): feature is SketchFeature => feature !== null)

    if (features.length !== target.featureIds.length) {
      return false
    }

    const machiningFeatures = features.filter((feature) => feature.operation !== 'region')
    const regionFeatures = features.filter((feature) => feature.operation === 'region')
    return machiningFeatures.some((feature) => feature.operation === 'model' && feature.kind === 'stl')
      && regionFeatures.every((feature) => feature.sketch.profile.closed)
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

    const machiningFeatures = features.filter((feature) => feature.operation !== 'region')
    const regionFeatures = features.filter((feature) => feature.operation === 'region')
    return machiningFeatures.length > 0
      && machiningFeatures.every((feature) => feature.operation === 'subtract' && featureHasClosedGeometry(feature))
      && regionFeatures.every((feature) => featureHasClosedGeometry(feature))
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
    const machiningFeatures = features.filter((feature) => feature.operation !== 'region')
    const regionFeatures = features.filter((feature) => feature.operation === 'region')
    return machiningFeatures.length > 0
      && machiningFeatures.every((feature) => feature.operation === 'subtract' && feature.sketch.profile.closed)
      && regionFeatures.every((feature) => feature.sketch.profile.closed)
  }

  const machiningFeatures = features.filter((feature) => feature.operation !== 'region')
  const regionFeatures = features.filter((feature) => feature.operation === 'region')
  return machiningFeatures.length > 0
    && machiningFeatures.every((feature) => (feature.operation === 'add' || feature.operation === 'model') && feature.sketch.profile.closed)
    && regionFeatures.every((feature) => feature.sketch.profile.closed)
}

function defaultOperationName(kind: OperationKind, pass: OperationPass, operations: Operation[]): string {
  const baseName = kind === 'follow_line' || kind === 'v_carve' || kind === 'v_carve_recursive' || kind === 'drilling' || kind === 'rough_surface' || kind === 'finish_surface'
    || kind === 'finish_surface_cleanup'
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

function defaultWaterlineMicroStepover(tool: Tool): number {
  return Math.max(0, tool.defaultStepover * tool.diameter)
}

function defaultOperationForTarget(
  project: Project,
  kind: OperationKind,
  pass: OperationPass,
  target: OperationTarget,
  index: number,
  resolved?: { tool: Tool; toolRef: string | null },
): Operation {
  const tool = resolved?.tool ?? project.tools[0] ?? defaultTool(project.meta.units, 1)
  const toolRef = resolved ? resolved.toolRef : (project.tools[0]?.id ?? null)

  // V-carves should carve to a useful depth, not the 1 mm engrave default. Mirror
  // the tool-change handler in CAMPanel: derive the cap from the tool's max cut
  // depth, falling back to the stock thickness so wide areas aren't clipped shallow.
  const isVCarve = kind === 'v_carve' || kind === 'v_carve_recursive'
  const vCarveMaxDepth = tool.maxCutDepth > 0
    ? tool.maxCutDepth
    : (project.stock.thickness > 0 ? project.stock.thickness : convertLength(1, 'mm', project.meta.units))

  return {
    id: `op${index + 1}`,
    name: defaultOperationName(kind, pass, project.operations),
    description: '',
    kind,
    pass,
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target,
    toolRef,
    stepdown: kind === 'finish_surface_cleanup'
      ? convertLength(1, 'mm', project.meta.units)
      : tool.defaultStepdown,
    stepover: tool.defaultStepover,
    feed: tool.defaultFeed,
    plungeFeed: tool.defaultPlungeFeed,
    rpm: tool.defaultRpm,
    pocketPattern: kind === 'finish_surface' || kind === 'finish_surface_cleanup' ? 'parallel' : 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: convertLength(1, 'mm', project.meta.units),
    maxCarveDepth: isVCarve ? vCarveMaxDepth : convertLength(1, 'mm', project.meta.units),
    cutDirection: 'conventional',
    machiningOrder: 'feature_first',
    waterlineAdaptiveRefinement: true,
    waterlineMicroStepover: defaultWaterlineMicroStepover(tool),
    waterlineRefinementThreshold: 0,
    waterlineMaxRingsPerBand: 0,
    waterlineTipStepdown: 0,
    ...(kind === 'drilling' ? {
      drillType: 'simple' as const,
      peckDepth: convertLength(2, 'mm', project.meta.units),
      dwellTime: 0.5,
      retractHeight: project.stock.thickness + convertLength(1, 'mm', project.meta.units),
    } : {}),
  }
}

function fallbackOperationTarget(project: Project, kind: OperationKind): OperationTarget {
  if (kind === 'drilling') {
    const firstCircle = project.features.find((feature) => feature.kind === 'circle')
    return firstCircle
      ? { source: 'features', featureIds: [firstCircle.id] }
      : { source: 'stock' }
  }

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

  if (kind === 'finish_surface' || kind === 'finish_surface_cleanup') {
    const modelFeature = project.features.find((feature) => feature.operation === 'model' && feature.kind === 'stl')
    if (modelFeature) {
      // Optionally include a region if one exists
      const regionFeature = project.features.find((feature) => feature.operation === 'region' && feature.sketch.profile.closed)
      if (regionFeature) {
        return { source: 'features', featureIds: [modelFeature.id, regionFeature.id] }
      }
      return { source: 'features', featureIds: [modelFeature.id] }
    }
  }

  if (kind === 'rough_surface') {
    const modelFeature = project.features.find((feature) => feature.operation === 'model' && feature.kind === 'stl')
    if (modelFeature) {
      // Optionally include a region if one exists (for constraining the outer boundary)
      const regionFeature = project.features.find((feature) => feature.operation === 'region' && feature.sketch.profile.closed)
      if (regionFeature) {
        return { source: 'features', featureIds: [modelFeature.id, regionFeature.id] }
      }
      return { source: 'features', featureIds: [modelFeature.id] }
    }
  }

  if (kind === 'surface_clean' || kind === 'edge_route_outside') {
    const firstAddOrModelFeature = project.features.find((feature) => (
      (feature.operation === 'add' || (kind === 'edge_route_outside' && feature.operation === 'model'))
      && feature.sketch.profile.closed
    ))
    if (firstAddOrModelFeature) {
      return { source: 'features', featureIds: [firstAddOrModelFeature.id] }
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

function buildRotatedCopies(
  sourceFeatures: SketchFeature[],
  existingFeatures: SketchFeature[],
  pivot: Point,
  angle: number,
  count: number,
): SketchFeature[] {
  const created: SketchFeature[] = []
  const projectLike: Project = { ...newProject(), features: existingFeatures, tools: [], operations: [] }

  for (let step = 1; step <= count; step += 1) {
    const stepAngle = angle * step
    const rotatePoint = (point: Point) => rotatePointAround(point, pivot, stepAngle)
    for (const sourceFeature of sourceFeatures) {
      const nextId = nextUniqueGeneratedId(
        { ...projectLike, features: [...existingFeatures, ...created] },
        'f',
      )
      const profile = transformProfile(sourceFeature.sketch.profile, rotatePoint)
      created.push({
        ...sourceFeature,
        id: nextId,
        name: duplicateFeatureName(sourceFeature.name, [...existingFeatures, ...created], count, step),
        folderId: sourceFeature.folderId,
        stl: transformStlFeatureData(sourceFeature.stl, rotatePoint),
        sketch: {
          ...sourceFeature.sketch,
          origin: rotatePoint(sourceFeature.sketch.origin),
          orientationAngle: normalizeAngleDegrees(
            (sourceFeature.sketch.orientationAngle ?? inferProfileOrientationAngle(sourceFeature.sketch.profile)) + stepAngle * (180 / Math.PI),
          ),
          profile,
        },
        locked: false,
      })
    }
  }

  return created
}

function buildMirroredCopies(
  sourceFeatures: SketchFeature[],
  existingFeatures: SketchFeature[],
  lineStart: Point,
  lineEnd: Point,
): SketchFeature[] {
  const created: SketchFeature[] = []
  const projectLike: Project = { ...newProject(), features: existingFeatures, tools: [], operations: [] }

  for (const sourceFeature of sourceFeatures) {
    const nextId = nextUniqueGeneratedId(
      { ...projectLike, features: [...existingFeatures, ...created] },
      'f',
    )
    const mirrored = mirrorFeatureFromReference(sourceFeature, lineStart, lineEnd)
    if (!mirrored) {
      continue
    }

    created.push({
      ...mirrored,
      id: nextId,
      name: duplicateFeatureName(sourceFeature.name, [...existingFeatures, ...created], 1, 1),
      folderId: sourceFeature.folderId,
      locked: false,
    })
  }

  return created
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
        stl: transformStlFeatureData(sourceFeature.stl, (point) => translatePoint(point, dx * step, dy * step)),
        sketch: {
          ...sourceFeature.sketch,
          origin: ['text', 'stl'].includes(sourceFeature.kind)
            ? { x: sourceFeature.sketch.origin.x + dx * step, y: sourceFeature.sketch.origin.y + dy * step }
            : sourceFeature.sketch.origin,
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

export function syncFeatureTreeProject(project: Project): Project {
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

/**
 * When a feature that serves as the stock source is modified, sync the stock
 * profile and thickness to match. Returns the updated project, or the original
 * if the featureId does not match the stock source.
 */
export function syncStockFromSourceFeature(project: Project, featureId: string): Project {
  const stock = project.stock
  if (!stock.sourceFeature || stock.sourceFeatureId !== featureId) {
    return project
  }

  // Find the updated source feature (it may be in features temporarily during sketch edit)
  const updatedFeature = project.features.find((f) => f.id === featureId)
  if (updatedFeature) {
    // Feature was temporarily restored for editing; update sourceFeature copy.
    // Use the feature's profile directly — it's already in world coordinates.
    const syncedStock = {
      ...stock,
      sourceFeature: updatedFeature,
      profile: updatedFeature.sketch.profile,
      thickness: typeof updatedFeature.z_top === 'number' ? updatedFeature.z_top : stock.thickness,
    }
    return {
      ...project,
      stock: syncedStock,
    }
  }

  // Feature is not in features array — sync from stock.sourceFeature directly
  const source = stock.sourceFeature
  return {
    ...project,
    stock: {
      ...stock,
      profile: source.sketch.profile,
      thickness: typeof source.z_top === 'number' ? source.z_top : stock.thickness,
    },
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
    description: operation.description ?? '',
    machiningOrder: operation.machiningOrder ?? 'level_first',
    waterlineAdaptiveRefinement: operation.waterlineAdaptiveRefinement ?? true,
    waterlineMicroStepover: operation.waterlineMicroStepover ?? 0,
    waterlineRefinementThreshold: operation.waterlineRefinementThreshold ?? 0,
    waterlineMaxRingsPerBand: operation.waterlineMaxRingsPerBand ?? 0,
    waterlineTipStepdown: operation.waterlineTipStepdown ?? 0,
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

export function normalizeProject(project: Project): Project {
  const modelAssets: Record<string, PersistedImportedMesh> = { ...(project.modelAssets ?? {}) }
  // Migration: convert 4-arc circles to native circle segments
  const upgradedFeatures = project.features.map((feature) => {
    let upgradedFeature = feature
    if (feature.kind === 'circle' && feature.sketch.profile.segments.length === 4) {
      const { profile } = feature.sketch
      const firstArc = profile.segments[0]
      if (firstArc.type === 'arc') {
        const cx = firstArc.center.x
        const cy = firstArc.center.y
        const r = Math.hypot(profile.start.x - cx, profile.start.y - cy)
        upgradedFeature = {
          ...feature,
          sketch: {
            ...feature.sketch,
            profile: circleProfile(cx, cy, r),
          },
        }
      }
    }
    // Migration: convert open profiles from 'subtract'/'add' to 'line' operation
    // (projects saved before the 'line' type was introduced)
    if (!feature.sketch.profile.closed && upgradedFeature.operation !== 'line' && upgradedFeature.operation !== 'model' && upgradedFeature.operation !== 'region') {
      upgradedFeature = {
        ...upgradedFeature,
        operation: 'line',
      }
    }
    return {
      ...upgradedFeature,
      stl: normalizeImportedModelStorage(upgradedFeature.id, upgradedFeature.stl, modelAssets),
    }
  })

  const normalizedMachines = normalizeMachineDefinitions(project)
  const meta = {
    ...project.meta,
    showFeatureInfo: project.meta.showFeatureInfo ?? true,
    showDimensions: project.meta.showDimensions ?? true,
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
    modelAssets,
    annotations: project.annotations ?? [],
    stock: {
      ...project.stock,
      profile: {
        ...project.stock.profile,
        closed: project.stock.profile.closed ?? true,
      },
    },
    features: upgradedFeatures.map(normalizeFeatureZRange),
    featureFolders: project.featureFolders ?? [],
    featureTree: project.featureTree ?? [],
    tools: project.tools.map((tool, index) => normalizeTool(tool, project.meta.units, index)),
    tabs: (project.tabs ?? []).map((tab, index) => normalizeTab(tab, project.meta.units, index)),
    clamps: (project.clamps ?? []).map((clamp, index) => normalizeClamp(clamp, project.meta.units, index)),
    origin: project.origin
      ? (legacyDefaultOrigin ? defaultOrigin(project.stock) : project.origin)
      : defaultOrigin(project.stock),
  }))

  const normalizedProject = pruneUnusedModelAssets({
    ...normalizedBase,
    backdrop: normalizeBackdrop(project.backdrop, normalizedBase),
    operations: project.operations.map((operation, index) => normalizeOperation(operation, normalizedBase, index)),
  })

  syncIdCounter(normalizedProject)
  return normalizedProject
}

export function cloneProject(project: Project): Project {
  const cloned = structuredClone(project)
  cloned.modelAssets = project.modelAssets
  return cloned
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
    annotations: [],
    modelAssets: {},
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

export function clearProjectMemoryCaches(): void {
  clearImportedModelCaches()
  clearSTLTransformedGeometryCache()
}

export function projectsEqual(a: Project, b: Project): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

// ============================================================
// Rule: the first 2.5D feature must be 'add'.
// Imported STL model features are standalone 3D model targets and may be the
// only feature in a project, so they are exempt from the base-solid rule.
// ============================================================

export function isImportedModelFeature(feature: SketchFeature): boolean {
  return feature.kind === 'stl' && feature.operation === 'model'
}

export function isFirstFeatureValid(features: SketchFeature[]): boolean {
  const firstMachiningFeature = features.find((feature) => feature.operation !== 'region')
  if (!firstMachiningFeature) return true
  return firstMachiningFeature.operation === 'add' || isImportedModelFeature(firstMachiningFeature)
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
  const applyProfileBreak = (
    featureId: string,
    resolveBreak: (profile: SketchProfile) => ProfileBreakResult | null,
  ) => set((s) => {
    const feature = s.project.features.find((entry) => entry.id === featureId) ?? null
    if (!feature || feature.locked) {
      return {}
    }

    const result = resolveBreak(feature.sketch.profile)
    if (!result) {
      return {}
    }

    const splitFeature = result.splitProfile
      ? createDerivedFeature(
          s.project,
          feature,
          result.splitProfile,
          feature.operation,
          uniqueName(`${normalizeDerivedFeatureNameStem(feature.name)} Split`, s.project.features.map((entry) => entry.name)),
        )
      : null

    const baseFeatures = s.project.features.map((entry) => {
      if (entry.id !== featureId) {
        return entry
      }

      return {
        ...entry,
        kind: ['text', 'stl'].includes(entry.kind) ? entry.kind : inferFeatureKind(result.profile),
        sketch: {
          ...entry.sketch,
          profile: result.profile,
        },
      }
    })
    const createdGroups: DerivedFeatureGroup[] = splitFeature ? [{ sourceId: featureId, features: [splitFeature] }] : []
    let nextProject = syncFeatureTreeProject({
      ...s.project,
      features: splitFeature
        ? insertDerivedFeaturesAfterSources(baseFeatures, createdGroups, new Set())
        : baseFeatures,
      featureTree: splitFeature
        ? insertDerivedFeatureTreeEntries(s.project.featureTree, baseFeatures, createdGroups, new Set())
        : s.project.featureTree,
      meta: { ...s.project.meta, modified: new Date().toISOString() },
    })

    nextProject = syncStockFromSourceFeature(nextProject, featureId)
    if (projectsEqual(nextProject, s.project)) {
      return {}
    }

    return {
      project: nextProject,
      selection: {
        ...s.selection,
        selectedFeatureId: featureId,
        selectedFeatureIds: [featureId],
        selectedNode: { type: 'feature' as const, featureId },
        activeControl: null,
      },
      history: s.history.transactionStart
        ? s.history
        : {
            past: [...s.history.past, cloneProject(s.project)].slice(-100),
            future: [],
            transactionStart: null,
          },
    }
  })

  return {
  project: normalizeProject(newProject()),
  creationTarget: 'feature',
  backdropImageLoading: false,
  filePath: null,
  lastExportPath: null,
  lastModelExportPath: null,
  dirty: false,
  projectLoading: false,
  projectKey: 0,
  pendingConstraint: null,
  history: {
    past: [],
    future: [],
    transactionStart: null,
  },
  setCreationTarget: (target) =>
    set(() => ({
      creationTarget: target,
      pendingAdd: null,
    })),
  ...createSelectionSlice(set, get, {
    cloneProject,
    normalizeProject,
  }),
  ...createPendingActionsSlice(set),
  ...createPendingCompletionSlice(set, get, {
    cloneProject,
    projectsEqual,
    clearStaleConstraints,
    propagateConstraintsOnTranslate: (features, offsets) =>
      propagateConstraintsOnTranslate(features, offsets, { transformProfile }),
    propagateConstraintsOnRotate: (features, rotations) =>
      propagateConstraintsOnRotate(features, rotations, { transformProfile }),
    validateAllConstraints: (features) => {
      const byId = new Map(features.map((f) => [f.id, f]))
      return features.map((f) => {
        if (f.sketch.constraints.every((c) => c.type !== 'fixed_distance')) return f
        return validateConstraintsOnFeature(f, byId)
      })
    },
    transformProfile,
    translateClamp,
    translateTab,
    buildCopiedFeatures,
    buildCopiedClamps,
    buildCopiedTabs,
    buildRotatedCopies,
    buildMirroredCopies,
    resizeBackdropFromReference,
    rotateBackdropFromReference,
    resizeFeatureFromReference,
    rotateFeatureFromReference,
    mirrorFeatureFromReference,
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
  ...createDimensionsSlice(set, get, { cloneProject }),
  ...createDimensionToolSlice(set, get),
  ...createToolsSlice(set, get, { cloneProject, projectsEqual, toolMatchesTemplate }),
  ...createFeatureSlice(set, get, {
    cloneProject,
    syncFeatureTreeProject,
    projectsEqual,
    createDerivedFeature,
    isImportedModelFeature,
    normalizeImportedModelStorage,
    folderIdForOperation,
    syncStockFromSourceFeature,
    transformProfile,
    pruneUnusedModelAssets,
  }),

  // ── Project ──────────────────────────────────────────────

  createNewProject: (template, name) =>
    set((state) => {
      clearProjectMemoryCaches()
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
        projectKey: state.projectKey + 1,
        history: {
          past: [],
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

  setShowDimensions: (visible) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        meta: {
          ...s.project.meta,
          showDimensions: visible,
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
      clearProjectMemoryCaches()
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
      clearProjectMemoryCaches()
      return {
        project: nextProject,
        pendingAdd: null,
        pendingMove: null,
        pendingTransform: null,
        pendingOffset: null,
        selection: emptySelection(),
        projectKey: state.projectKey + 1,
        history: {
          past: [],
          future: [],
          transactionStart: null,
        },
      }
    }),

  saveProject: () => {
    const p = pruneUnusedModelAssets(get().project)
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
    clearProjectMemoryCaches()
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
      projectKey: state.projectKey + 1,
      history: {
        past: [],
        future: [],
        transactionStart: null,
      },
    }))
  },

  markSaved: (path) =>
    rawSet({ filePath: path, dirty: false }),

  markExported: (path) =>
    set({ lastExportPath: path }),

  markModelExported: (path) =>
    set({ lastModelExportPath: path }),

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

  /**
   * Set a feature as the stock source. The feature is removed from project.features
   * and its geometry is used as the stock profile/thickness.
   * Pass null to reset to rectangle stock (restores the feature to the tree).
   *
   * This is a single undo-able action that captures full before/after state.
   */
  setStockSourceFeature: (featureId: string | null) =>
    set((s) => {
      if (featureId === null) {
        // Reset to rectangle stock
        if (!s.project.stock.sourceFeatureId && !s.project.stock.sourceFeature) {
          return {} // Already rectangle stock, no-op
        }

        const restoredFeature = s.project.stock.sourceFeature
        if (!restoredFeature) return {}

        const stockBounds = getStockBounds(s.project.stock)
        const width = stockBounds.maxX - stockBounds.minX
        const height = stockBounds.maxY - stockBounds.minY
        const rectW = Math.max(width, 1)
        const rectH = Math.max(height, 1)

        const nextStock = {
          ...s.project.stock,
          profile: rectProfile(stockBounds.minX, stockBounds.minY, rectW, rectH),
          sourceFeatureId: null as string | null | undefined,
          sourceFeature: null as SketchFeature | null | undefined,
        }

        const nextProject = syncFeatureTreeProject({
          ...s.project,
          stock: nextStock,
          features: [...s.project.features, restoredFeature],
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        })

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
      }

      // Set a feature as stock source
      const feature = s.project.features.find((f) => f.id === featureId)
      if (!feature) return {}
      if (!feature.sketch.profile.closed) return {} // Only closed profiles can be stock

      // If another feature is already the stock source, restore it first
      let features = s.project.features
      let stock = { ...s.project.stock }

      if (stock.sourceFeature && stock.sourceFeatureId) {
        // Restore old source feature to features array
        features = [...features, stock.sourceFeature]
      }

      // Remove the new source feature from features and tree
      features = features.filter((f) => f.id !== featureId)
      const featureTree = s.project.featureTree.filter(
        (entry) => !(entry.type === 'feature' && entry.featureId === featureId)
      )

      // Build stock from feature
      const newStock = stockFromFeature(feature)
      stock = {
        ...stock,
        profile: newStock.profile,
        thickness: newStock.thickness,
        sourceFeatureId: feature.id,
        sourceFeature: feature,
      }

      const nextProject = syncFeatureTreeProject({
        ...s.project,
        stock,
        features,
        featureTree,
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      })

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

  /**
   * Enter sketch edit mode for the stock source feature.
   * Temporarily adds the source feature back to project.features and project.featureTree
   * so that mutation actions (moveFeatureControl, insertFeaturePoint, etc.) can find and edit it.
   * The feature is removed from features/tree on applySketchEdit (handled in selectionSlice).
   */
  enterStockSketchEdit: (featureId: string) =>
    set((s) => {
      const stock = s.project.stock
      if (stock.sourceFeatureId !== featureId || !stock.sourceFeature) {
        return {}
      }

      const feature = stock.sourceFeature

      // Temporarily add the feature to features array and feature tree for editing
      const nextProject = syncFeatureTreeProject({
        ...s.project,
        features: [...s.project.features, feature],
        featureTree: [...s.project.featureTree, { type: 'feature' as const, featureId: feature.id }],
      })

      return {
        project: nextProject,
        pendingTransform: null,
        pendingOffset: null,
        selection: {
          ...s.selection,
          selectedFeatureId: featureId,
          selectedFeatureIds: [featureId],
          selectedNode: { type: 'feature', featureId },
          mode: 'sketch_edit',
          sketchEditTool: null,
          activeControl: null,
        },
        sketchEditSession: {
          entityType: 'feature',
          entityId: featureId,
          snapshot: cloneProject(s.project),
          pastLength: s.history.past.length,
        },
        pendingConstraint: null,
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

  addOperation: (kind, pass, target, libraryTools) => {
    const state = get()
    if (!isOperationTargetValid(state.project, kind, target)) {
      return null
    }

    const nextId = nextUniqueGeneratedId(state.project, 'op')

    // Choose a proper tool for this operation (type/units/feature size) instead
    // of always using tools[0]. An 'import' result is added to the project's
    // tool list in the same undo step; operation defaults derive from it.
    const selection = selectToolForOperation(state.project, kind, target, libraryTools ?? [])
    let toolToAdd: Tool | null = null
    let resolvedTool: Tool
    let resolvedToolRef: string | null

    if (selection?.source === 'existing') {
      resolvedTool = state.project.tools.find((tool) => tool.id === selection.toolId) ?? defaultTool(state.project.meta.units, 1)
      resolvedToolRef = selection.toolId
    } else if (selection?.source === 'import') {
      const existingMatch = state.project.tools.find((tool) => toolMatchesTemplate(tool, selection.tool))
      if (existingMatch) {
        resolvedTool = existingMatch
        resolvedToolRef = existingMatch.id
      } else {
        toolToAdd = { ...selection.tool, id: nextUniqueGeneratedId(state.project, 't') }
        resolvedTool = toolToAdd
        resolvedToolRef = toolToAdd.id
      }
    } else {
      resolvedTool = state.project.tools[0] ?? defaultTool(state.project.meta.units, 1)
      resolvedToolRef = state.project.tools[0]?.id ?? null
    }

    const template = defaultOperationForTarget(
      state.project,
      kind,
      pass,
      target,
      state.project.operations.length,
      { tool: resolvedTool, toolRef: resolvedToolRef },
    )
    const operation: Operation = {
      ...template,
      id: nextId,
      showToolpath: true,
      pass,
    }

    set((s) => ({
      project: {
        ...s.project,
        tools: toolToAdd ? [...s.project.tools, toolToAdd] : s.project.tools,
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

  createRestOperation: (operationId) => {
    const state = get()
    const operation = state.project.operations.find((item) => item.id === operationId)
    if (!operation) {
      return { operationId: null, regionIds: [], warnings: ['Operation not found'] }
    }
    if ((operation.kind !== 'pocket' && operation.kind !== 'edge_route_inside' && operation.kind !== 'edge_route_outside') || operation.target.source !== 'features') {
      return { operationId: null, regionIds: [], warnings: ['Rest operations can only be created from pocket or edge-route operations with feature targets'] }
    }

    if (operation.kind === 'edge_route_inside' || operation.kind === 'edge_route_outside') {
      const result = generateEdgeRestRegionDrafts(state.project, operation)
      if (result.drafts.length === 0) {
        return { operationId: null, regionIds: [], warnings: result.warnings }
      }

      let nextProjectLike = state.project
      const targetFeatures = operation.target.featureIds
        .map((featureId) => state.project.features.find((item) => item.id === featureId) ?? null)
        .filter((feature): feature is SketchFeature => feature !== null)
      const machiningTargetIds = targetFeatures
        .filter((feature) => feature.operation !== 'region')
        .map((feature) => feature.id)
      const restFolderId = nextUniqueGeneratedId(nextProjectLike, 'fd')
      const restFolder: FeatureFolder = {
        id: restFolderId,
        name: uniqueFolderName(`${operation.name || defaultOperationName(operation.kind, operation.pass, state.project.operations)} Rest Regions`, state.project.featureFolders),
        collapsed: false,
        section: 'regions',
      }
      nextProjectLike = {
        ...nextProjectLike,
        featureFolders: [...nextProjectLike.featureFolders, restFolder],
      }
      const createdFeatures: SketchFeature[] = result.drafts.map((draft, index) => {
        const id = nextUniqueGeneratedId(nextProjectLike, 'f')
        const feature = normalizeFeatureZRange({
          id,
          name: uniqueName(
            `${operation.name || defaultOperationName(operation.kind, operation.pass, state.project.operations)} Rest Region${result.drafts.length > 1 ? ` ${index + 1}` : ''}`,
            nextProjectLike.features.map((feature) => feature.name),
          ),
          kind: inferFeatureKind(draft.profile),
          folderId: restFolderId,
          sketch: {
            profile: draft.profile,
            origin: { x: 0, y: 0 },
            orientationAngle: 0,
            dimensions: [],
            constraints: [],
          },
          operation: 'region',
          z_top: state.project.stock.thickness,
          z_bottom: 0,
          visible: true,
          locked: false,
        })
        nextProjectLike = {
          ...nextProjectLike,
          features: [...nextProjectLike.features, feature],
        }
        return feature
      })
      const createdIds = createdFeatures.map((feature) => feature.id)
      const restTarget: OperationTarget = {
        source: 'features',
        featureIds: [...machiningTargetIds, ...createdIds],
      }
      const nextOperationId = nextUniqueGeneratedId(nextProjectLike, 'op')
      const restOperation: Operation = {
        ...operation,
        id: nextOperationId,
        name: uniqueName(`${operation.name || defaultOperationName(operation.kind, operation.pass, state.project.operations)} Rest`, state.project.operations.map((item) => item.name)),
        showToolpath: true,
        target: restTarget,
        toolRef: null,
      }

      set((s) => {
        const nextProject = syncFeatureTreeProject({
          ...s.project,
          featureFolders: [...s.project.featureFolders, restFolder],
          features: [...s.project.features, ...createdFeatures],
          operations: [...s.project.operations, restOperation],
          featureTree: [...s.project.featureTree, { type: 'folder', folderId: restFolder.id }],
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
      })

      return { operationId: nextOperationId, regionIds: createdIds, warnings: result.warnings }
    }

    const result = generatePocketRestRegionDrafts(state.project, operation)
    if (result.drafts.length === 0) {
      return { operationId: null, regionIds: [], warnings: result.warnings }
    }

    let nextProjectLike = state.project
    const restFolderId = nextUniqueGeneratedId(nextProjectLike, 'fd')
    const restFolder: FeatureFolder = {
      id: restFolderId,
      name: uniqueFolderName(`${operation.name || 'Pocket'} Rest Regions`, state.project.featureFolders),
      collapsed: false,
      section: 'regions',
    }
    nextProjectLike = {
      ...nextProjectLike,
      featureFolders: [...nextProjectLike.featureFolders, restFolder],
    }
    const createdFeatures: SketchFeature[] = result.drafts.map((draft, index) => {
      const id = nextUniqueGeneratedId(nextProjectLike, 'f')
      const feature = normalizeFeatureZRange({
        id,
        name: uniqueName(
          `${operation.name || 'Pocket'} Rest Region${result.drafts.length > 1 ? ` ${index + 1}` : ''}`,
          nextProjectLike.features.map((feature) => feature.name),
        ),
        kind: inferFeatureKind(draft.profile),
        folderId: restFolderId,
        sketch: {
          profile: draft.profile,
          origin: { x: 0, y: 0 },
          orientationAngle: 0,
          dimensions: [],
          constraints: [],
        },
        operation: 'region',
        z_top: state.project.stock.thickness,
        z_bottom: 0,
        visible: true,
        locked: false,
      })
      nextProjectLike = {
        ...nextProjectLike,
        features: [...nextProjectLike.features, feature],
      }
      return feature
    })
    const createdIds = createdFeatures.map((feature) => feature.id)
    const machiningTargetIds = operation.target.featureIds.filter((featureId) => {
      const feature = state.project.features.find((item) => item.id === featureId)
      return feature?.operation !== 'region'
    })
    const restTarget: OperationTarget = {
      source: 'features',
      featureIds: [...machiningTargetIds, ...createdIds],
    }
    const nextOperationId = nextUniqueGeneratedId(nextProjectLike, 'op')
    const restOperation: Operation = {
      ...operation,
      id: nextOperationId,
      name: uniqueName(`${operation.name || 'Pocket'} Rest`, state.project.operations.map((item) => item.name)),
      pass: 'rough',
      showToolpath: true,
      target: restTarget,
      toolRef: null,
    }

    set((s) => {
      const nextProject = syncFeatureTreeProject({
        ...s.project,
        featureFolders: [...s.project.featureFolders, restFolder],
        features: [...s.project.features, ...createdFeatures],
        operations: [...s.project.operations, restOperation],
        featureTree: [
          ...s.project.featureTree,
          { type: 'folder', folderId: restFolderId },
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
    })

    return { operationId: nextOperationId, regionIds: createdIds, warnings: result.warnings }
  },

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

  setAllRegionsVisible: (visible) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        features: s.project.features.map((feature) => (
          feature.operation === 'region' ? { ...feature, visible } : feature
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

  toggleRegionFolderVisible: (folderId) =>
    set((s) => {
      const folderFeatures = s.project.features.filter((f) => f.folderId === folderId && f.operation === 'region')
      const anyVisible = folderFeatures.some((f) => f.visible)
      const nextVisible = !anyVisible
      const nextProject = {
        ...s.project,
        features: s.project.features.map((f) =>
          f.folderId === folderId && f.operation === 'region' ? { ...f, visible: nextVisible } : f
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


  importShapes: (input) => {
    const state = get()
    const sourceShapes = input.shapes.filter((shape) => !isProfileDegenerate(shape.profile))
    if (sourceShapes.length === 0) {
      return []
    }

    // Group shapes by layer name. Null layer (DXF layer "0") → keyed as '0'.
    const layerGroups = new Map<string, typeof sourceShapes>()
    for (const shape of sourceShapes) {
      const key = shape.layerName ?? '0'
      const existing = layerGroups.get(key)
      if (existing) {
        existing.push(shape)
      } else {
        layerGroups.set(key, [shape])
      }
    }

    const existingFeatureNames = state.project.features.map((f) => f.name)
    const newFolders: FeatureFolder[] = []
    const createdFeatures: SketchFeature[] = []

    let nextProjectLike: Project = {
      ...state.project,
      features: [...state.project.features],
      featureFolders: [...state.project.featureFolders],
    }

    for (const [layerKey, layerShapes] of layerGroups) {
      const folderDisplayName = layerKey || '0'
      const folderId = nextUniqueGeneratedId(nextProjectLike, 'fd')
      const folderName = uniqueFolderName(folderDisplayName, nextProjectLike.featureFolders)
      const folder: FeatureFolder = { id: folderId, name: folderName, collapsed: false }

      newFolders.push(folder)
      nextProjectLike = { ...nextProjectLike, featureFolders: [...nextProjectLike.featureFolders, folder] }

      for (const shape of layerShapes) {
        const featureName = uniqueName(
          shape.name || folderDisplayName,
          [...existingFeatureNames, ...createdFeatures.map((f) => f.name)],
        )
        // All closed profiles import as 'add'; open profiles as 'line'.
        const operation: FeatureOperation = shape.profile.closed ? 'add' : 'line'
        const nextId = nextUniqueGeneratedId(nextProjectLike, 'f')
        const feature = normalizeFeatureZRange({
          ...createImportedFeature(shape, state.project, folderId, featureName, operation),
          id: nextId,
        })

        createdFeatures.push(feature)
        nextProjectLike = { ...nextProjectLike, features: [...nextProjectLike.features, feature] }
      }
    }

    if (createdFeatures.length === 0) {
      return []
    }

    set((s) => {
      const nextProject = syncFeatureTreeProject({
        ...s.project,
        featureFolders: [...s.project.featureFolders, ...newFolders],
        featureTree: [
          ...s.project.featureTree,
          ...newFolders.map((f) => ({ type: 'folder' as const, folderId: f.id })),
        ],
        features: [...s.project.features, ...createdFeatures],
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      })
      const createdIds = createdFeatures.map((f) => f.id)
      const primaryId = createdIds.at(-1) ?? null
      const primaryFolderId = newFolders.at(-1)?.id ?? null

      return {
        project: nextProject,
        selection: {
          ...s.selection,
          selectedFeatureId: primaryId,
          selectedFeatureIds: createdIds,
          selectedNode: primaryId
            ? { type: 'feature', featureId: primaryId }
            : primaryFolderId
              ? { type: 'folder', folderId: primaryFolderId }
              : s.selection.selectedNode,
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

    return createdFeatures.map((f) => f.id)
  },

  importCamjFolders: (input) => {
    const state = get()
    const merge = mergeCamjFolders({
      currentProject: state.project,
      sourceProject: input.sourceProject,
      selectedFolderIds: input.selectedFolderIds,
      importStock: input.importStock,
    })
    if (merge.createdFeatureIds.length === 0 && !merge.stockReplaced) {
      return []
    }

    set((s) => {
      const nextProject = syncFeatureTreeProject(merge.project)
      const createdIds = merge.createdFeatureIds
      const primaryId = createdIds.at(-1) ?? null
      const primaryFolderId = merge.createdFolderIds.at(-1) ?? null
      return {
        project: nextProject,
        selection: {
          ...s.selection,
          selectedFeatureId: primaryId,
          selectedFeatureIds: createdIds,
          selectedNode: primaryId
            ? { type: 'feature', featureId: primaryId }
            : primaryFolderId
              ? { type: 'folder', folderId: primaryFolderId }
              : s.selection.selectedNode,
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

    return merge.createdFeatureIds
  },

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
      let nextProject = {
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
          } else if (control.kind === 'circle_center') {
            const seg = nextProfile.segments[control.index]
            if (seg?.type === 'circle') {
              const dx = point.x - seg.center.x
              const dy = point.y - seg.center.y
              seg.center = point
              nextProfile.start = translatePoint(nextProfile.start, dx, dy)
              seg.to = nextProfile.start
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
            kind: ['text', 'stl'].includes(feature.kind) ? feature.kind : inferFeatureKind(normalizedProfile),
          }
        }),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }
      // Update owner constraint values to reflect new geometry (Policy #1: owner edited → update value)
      nextProject.features = clearStaleConstraints(nextProject.features, new Set([featureId]))
      // Propagate to features that depend on the edited feature (Policy #2: reference edited → dependents follow)
      nextProject.features = propagateConstraintsOnTranslate(
        nextProject.features,
        new Map([[featureId, { dx: 0, dy: 0 }]]),
        { transformProfile },
      )
      // Validate all constraints and mark invalid ones red
      const featureByIdMap = new Map(nextProject.features.map((f) => [f.id, f]))
      nextProject.features = nextProject.features.map((f) => {
        if (f.sketch.constraints.every((c) => c.type !== 'fixed_distance')) return f
        return validateConstraintsOnFeature(f, featureByIdMap)
      })
      // Sync stock if the edited feature is the stock source
      nextProject = syncStockFromSourceFeature(nextProject, featureId)
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
      let nextProject = {
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
            kind: ['text', 'stl'].includes(feature.kind) ? feature.kind : inferFeatureKind(nextProfile),
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

      nextProject = syncStockFromSourceFeature(nextProject, featureId)

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

  joinOpenFeatureEndpoints: (featureId, endpoint, targetFeatureId, targetEndpoint) => {
    let didJoin = false
    set((s) => {
      const feature = s.project.features.find((entry) => entry.id === featureId) ?? null
      const targetFeature = s.project.features.find((entry) => entry.id === targetFeatureId) ?? null
      if (
        !feature
        || !targetFeature
        || feature.locked
        || targetFeature.locked
        || feature.sketch.profile.closed
        || targetFeature.sketch.profile.closed
      ) {
        return {}
      }

      const nextProfile =
        featureId === targetFeatureId
          ? endpoint === targetEndpoint
            ? null
            : closeOpenProfile(feature.sketch.profile)
          : joinOpenProfiles(feature.sketch.profile, endpoint, targetFeature.sketch.profile, targetEndpoint)
      if (!nextProfile) {
        return {}
      }

      const removedFeatureIds = new Set(featureId === targetFeatureId ? [] : [targetFeatureId])
      let nextProject = syncFeatureTreeProject({
        ...s.project,
        features: s.project.features
          .filter((entry) => !removedFeatureIds.has(entry.id))
          .map((entry) => {
            if (entry.id === featureId) {
              // If closing an open profile (line), reset operation to 'subtract'
              const updatedOperation = entry.operation === 'line' && nextProfile.closed ? 'subtract' : entry.operation
              return {
                ...entry,
                operation: updatedOperation,
                kind: ['text', 'stl'].includes(entry.kind) ? entry.kind : inferFeatureKind(nextProfile),
                sketch: {
                  ...entry.sketch,
                  profile: nextProfile,
                  constraints: entry.sketch.constraints.map((constraint) => {
                    const refId = constraint.reference_feature_id ?? constraint.segment_ids[0]
                    if (constraint.type === 'fixed_distance' && refId && removedFeatureIds.has(refId)) {
                      return {
                        ...constraint,
                        is_invalid: true,
                        error_message: 'Reference feature was joined into another feature',
                      }
                    }
                    return constraint
                  }),
                },
              }
            }

            if (removedFeatureIds.size === 0 || entry.sketch.constraints.every((constraint) => constraint.type !== 'fixed_distance')) {
              return entry
            }

            const constraints = entry.sketch.constraints.map((constraint) => {
              const refId = constraint.reference_feature_id ?? constraint.segment_ids[0]
              if (constraint.type === 'fixed_distance' && refId && removedFeatureIds.has(refId)) {
                return {
                  ...constraint,
                  is_invalid: true,
                  error_message: 'Reference feature was joined into another feature',
                }
              }
              return constraint
            })

            return {
              ...entry,
              sketch: {
                ...entry.sketch,
                constraints,
              },
            }
          }),
        featureTree: s.project.featureTree.filter((entry) => !(entry.type === 'feature' && removedFeatureIds.has(entry.featureId))),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      })

      nextProject = syncStockFromSourceFeature(nextProject, featureId)
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }

      didJoin = true
      return {
        project: nextProject,
        selection: {
          ...s.selection,
          selectedFeatureId: featureId,
          selectedFeatureIds: [featureId],
          selectedNode: { type: 'feature', featureId },
          activeControl: null,
        },
        history: s.history.transactionStart
          ? s.history
          : {
              past: [...s.history.past, cloneProject(s.project)].slice(-100),
              future: [],
              transactionStart: null,
            },
      }
    })

    return didJoin
  },

  deleteFeaturePoint: (featureId, anchorIndex) =>
    set((s) => {
      let changed = false
      let nextProject = {
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
            kind: ['text', 'stl'].includes(feature.kind) ? feature.kind : inferFeatureKind(nextProfile),
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

      nextProject = syncStockFromSourceFeature(nextProject, featureId)

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

  deleteFeatureSegment: (featureId, segmentIndex) =>
    applyProfileBreak(featureId, (profile) => deleteSegmentFromProfile(profile, segmentIndex)),

  disconnectFeaturePoint: (featureId, anchorIndex) =>
    applyProfileBreak(featureId, (profile) => disconnectProfileAtAnchor(profile, anchorIndex)),

  filletFeaturePoint: (featureId, anchorIndex, radius) =>
    set((s) => {
      let changed = false
      let nextProject = {
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
            kind: ['text', 'stl'].includes(feature.kind) ? feature.kind : inferFeatureKind(nextProfile),
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

      nextProject = syncStockFromSourceFeature(nextProject, featureId)

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
        .filter((feature) => feature.operation === expectedOperation || feature.operation === 'model' || feature.operation === 'region')

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

  // ── Constraints ──────────────────────────────────────────

  beginConstraint: (featureId) =>
    set((s) => {
      const feature = s.project.features.find((f) => f.id === featureId)
      if (!feature || feature.locked) {
        return {}
      }
      return {
        pendingConstraint: {
          featureId,
          anchor: null,
          reference: null,
          session: nextPlacementSession(),
        },
      }
    }),

  setConstraintAnchor: (anchor) =>
    set((s) => {
      if (!s.pendingConstraint) {
        return {}
      }
      return {
        pendingConstraint: { ...s.pendingConstraint, anchor },
      }
    }),

  setConstraintReference: (reference) =>
    set((s) => {
      if (!s.pendingConstraint || !s.pendingConstraint.anchor) {
        return {}
      }
      if (s.pendingConstraint.featureId === reference.featureId) {
        return {}
      }
      return {
        pendingConstraint: { ...s.pendingConstraint, reference },
      }
    }),

  commitConstraintDistance: (distance) =>
    set((s) => {
      const pending = s.pendingConstraint
      if (!pending || !pending.anchor || !pending.reference || !Number.isFinite(distance) || distance < 0) {
        return {}
      }
      const feature = s.project.features.find((f) => f.id === pending.featureId)
      if (!feature || feature.locked) {
        return { pendingConstraint: null }
      }

      const anchor = pending.anchor.point
      const ref = pending.reference.point
      const segment = pending.reference.segment
      let storedValue = distance
      if (segment) {
        const sx = segment.b.x - segment.a.x
        const sy = segment.b.y - segment.a.y
        const segLen = Math.hypot(sx, sy)
        let nx = 0
        let ny = 1
        if (segLen > 1e-9) {
          nx = -sy / segLen
          ny = sx / segLen
        }
        const signedDist = (anchor.x - segment.a.x) * nx + (anchor.y - segment.a.y) * ny
        const side = signedDist >= 0 ? 1 : -1
        storedValue = side * distance
      }

      const constraintId = nextUniqueGeneratedId(s.project, 'c')
      const referenceIds = pending.reference.featureId
        ? [pending.reference.featureId]
        : []

      // Infer semantic indices from snap modes
      const refFeature = pending.reference.featureId
        ? s.project.features.find((f) => f.id === pending.reference!.featureId) ?? null
        : null
      const semanticIndices = inferSemanticIndices(
        feature.sketch.profile,
        refFeature?.sketch.profile ?? null,
        anchor,
        ref,
        pending.anchor.snapMode,
        pending.reference.snapMode,
        segment,
      )

      const newConstraint: LocalConstraint = {
        id: constraintId,
        type: 'fixed_distance',
        segment_ids: referenceIds,
        value: storedValue,
        anchor_point: anchor, // placeholder — updated after multi-constraint solve
        reference_point: segment
          ? (() => {
              const sx = segment.b.x - segment.a.x
              const sy = segment.b.y - segment.a.y
              const segLen = Math.hypot(sx, sy)
              if (segLen < 1e-12) return ref
              const nx = -sy / segLen
              const ny = sx / segLen
              const signedDist = (anchor.x - segment.a.x) * nx + (anchor.y - segment.a.y) * ny
              return { x: anchor.x - signedDist * nx, y: anchor.y - signedDist * ny }
            })()
          : ref,
        reference_segment: segment,
        anchor_index: semanticIndices.anchor_index,
        anchor_type: semanticIndices.anchor_type,
        reference_feature_id: pending.reference.featureId ?? undefined,
        reference_index: semanticIndices.reference_index,
        reference_type: semanticIndices.reference_type,
        reference_t: semanticIndices.reference_t,
      }

      // Solve ALL constraints simultaneously (existing + new) to find the position
      // that satisfies all of them without modifying any stored values.
      const allConstraints = [...feature.sketch.constraints, newConstraint]
      const featureByIdSolve = new Map(s.project.features.map((f) => [f.id, f]))
      const solverInputs: ConstraintInput[] = []
      for (const c of allConstraints) {
        if (c.type !== 'fixed_distance') continue
        const cRefId = c.reference_feature_id ?? c.segment_ids[0]
        const cRefFeature = cRefId ? featureByIdSolve.get(cRefId) : null
        const rederived = rederiveConstraintGeometry(
          feature.sketch.profile,
          cRefFeature?.sketch.profile ?? null,
          c,
        )
        if (rederived && rederived.isValid) {
          if (rederived.referenceSegment) {
            solverInputs.push({
              kind: 'segment',
              anchor: rederived.anchorPoint,
              segmentA: rederived.referenceSegment.a,
              segmentB: rederived.referenceSegment.b,
              signedDistance: c.value ?? 0,
            })
          } else if (rederived.referencePoint) {
            solverInputs.push({
              kind: 'point',
              anchor: rederived.anchorPoint,
              reference: rederived.referencePoint,
              distance: Math.abs(c.value ?? 0),
            })
          }
        } else if (c.anchor_point) {
          if (c.reference_segment) {
            solverInputs.push({
              kind: 'segment',
              anchor: c.anchor_point,
              segmentA: c.reference_segment.a,
              segmentB: c.reference_segment.b,
              signedDistance: c.value ?? 0,
            })
          } else if (c.reference_point) {
            solverInputs.push({
              kind: 'point',
              anchor: c.anchor_point,
              reference: c.reference_point,
              distance: Math.abs(c.value ?? 0),
            })
          }
        }
      }
      const { dx: translateDx, dy: translateDy } = solveFeatureTranslation(solverInputs)

      const nextFeatures = s.project.features.map((f) => {
        if (f.id !== pending.featureId) return f
        const nextProfile =
          Math.abs(translateDx) < 1e-9 && Math.abs(translateDy) < 1e-9
            ? f.sketch.profile
            : translateProfile(f.sketch.profile, translateDx, translateDy)
        // Refresh all constraint caches from the solved position — values are never touched
        const featureByIdNext = new Map([...featureByIdSolve, [f.id, { ...f, sketch: { ...f.sketch, profile: nextProfile } }]])
        const refreshedConstraints = allConstraints.map((c) => {
          if (c.type !== 'fixed_distance') return c
          const cRefId = c.reference_feature_id ?? c.segment_ids[0]
          const cRefFeature = cRefId ? featureByIdNext.get(cRefId) : null
          const result = rederiveConstraintGeometry(nextProfile, cRefFeature?.sketch.profile ?? null, c)
          if (!result || !result.isValid) return c
          return {
            ...c,
            anchor_point: result.anchorPoint,
            reference_point: result.referencePoint,
            reference_segment: result.referenceSegment,
            is_invalid: false,
            error_message: undefined,
          }
        })
        return { ...f, sketch: { ...f.sketch, profile: nextProfile, constraints: refreshedConstraints } }
      })
      const refreshedFeatures = nextFeatures

      const nextProject = {
        ...s.project,
        features: refreshedFeatures,
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }

      return {
        project: nextProject,
        pendingConstraint: null,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  cancelPendingConstraint: () =>
    set((s) => (s.pendingConstraint ? { pendingConstraint: null } : {})),

  deleteConstraint: (featureId, constraintId) =>
    set((s) => {
      const feature = s.project.features.find((f) => f.id === featureId)
      if (!feature) return {}
      const nextConstraints = feature.sketch.constraints.filter((c) => c.id !== constraintId)
      if (nextConstraints.length === feature.sketch.constraints.length) return {}
      const nextProject = {
        ...s.project,
        features: s.project.features.map((f) =>
          f.id === featureId
            ? { ...f, sketch: { ...f.sketch, constraints: nextConstraints } }
            : f
        ),
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
    }),

  updateConstraintValue: (featureId, constraintId, newValue) =>
    set((s) => {
      if (!Number.isFinite(newValue)) return {}
      const feature = s.project.features.find((f) => f.id === featureId)
      if (!feature || feature.locked) return {}
      const constraint = feature.sketch.constraints.find((c) => c.id === constraintId)
      if (!constraint || constraint.type !== 'fixed_distance') return {}

      const refFeatureId = constraint.reference_feature_id ?? constraint.segment_ids[0]
      const refFeature = refFeatureId ? s.project.features.find((f) => f.id === refFeatureId) : null

      // Re-derive current geometry for the edited constraint
      const rederived = rederiveConstraintGeometry(
        feature.sketch.profile,
        refFeature?.sketch.profile ?? null,
        constraint,
      )

      let translateDx = 0
      let translateDy = 0
      let storedValue = newValue

      if (rederived && rederived.isValid) {
        const anchor = rederived.anchorPoint
        if (rederived.referenceSegment) {
          const { a, b } = rederived.referenceSegment
          const sx = b.x - a.x; const sy = b.y - a.y
          const segLen = Math.hypot(sx, sy)
          if (segLen > 1e-12) {
            const nx = -sy / segLen; const ny = sx / segLen
            const signedDist = (anchor.x - a.x) * nx + (anchor.y - a.y) * ny
            // Preserve the current side; user types positive magnitude
            const side = signedDist >= 0 ? 1 : -1
            const foot = { x: anchor.x - signedDist * nx, y: anchor.y - signedDist * ny }
            const newAnchor = { x: foot.x + side * Math.abs(newValue) * nx, y: foot.y + side * Math.abs(newValue) * ny }
            translateDx = newAnchor.x - anchor.x; translateDy = newAnchor.y - anchor.y
            storedValue = side * Math.abs(newValue)
          }
        } else if (rederived.referencePoint) {
          const ref = rederived.referencePoint
          const dx = anchor.x - ref.x; const dy = anchor.y - ref.y
          const currentLen = Math.hypot(dx, dy)
          let ux = 1, uy = 0
          if (currentLen > 1e-9) { ux = dx / currentLen; uy = dy / currentLen }
          const newAnchor = { x: ref.x + ux * newValue, y: ref.y + uy * newValue }
          translateDx = newAnchor.x - anchor.x; translateDy = newAnchor.y - anchor.y
        }
      } else if (constraint.anchor_point) {
        const anchor = constraint.anchor_point
        if (constraint.reference_segment) {
          const { a, b } = constraint.reference_segment
          const sx = b.x - a.x; const sy = b.y - a.y
          const segLen = Math.hypot(sx, sy)
          if (segLen > 1e-12) {
            const nx = -sy / segLen; const ny = sx / segLen
            const signedDist = (anchor.x - a.x) * nx + (anchor.y - a.y) * ny
            const side = signedDist >= 0 ? 1 : -1
            const foot = { x: anchor.x - signedDist * nx, y: anchor.y - signedDist * ny }
            const newAnchor = { x: foot.x + side * newValue * nx, y: foot.y + side * newValue * ny }
            translateDx = newAnchor.x - anchor.x; translateDy = newAnchor.y - anchor.y
          }
        } else if (constraint.reference_point) {
          const ref = constraint.reference_point
          const dx = anchor.x - ref.x; const dy = anchor.y - ref.y
          const currentLen = Math.hypot(dx, dy)
          let ux = 1, uy = 0
          if (currentLen > 1e-9) { ux = dx / currentLen; uy = dy / currentLen }
          const newAnchor = { x: ref.x + ux * newValue, y: ref.y + uy * newValue }
          translateDx = newAnchor.x - anchor.x; translateDy = newAnchor.y - anchor.y
        }
      }

      // 1. Translate the feature and update the edited constraint's value
      const updatedConstraint = { ...constraint, value: storedValue, is_invalid: false, error_message: undefined }
      let nextFeatures = s.project.features.map((f) => {
        if (f.id !== featureId) return f
        const nextProfile = Math.abs(translateDx) < 1e-9 && Math.abs(translateDy) < 1e-9
          ? f.sketch.profile
          : translateProfile(f.sketch.profile, translateDx, translateDy)
        return {
          ...f,
          sketch: {
            ...f.sketch,
            profile: nextProfile,
            constraints: f.sketch.constraints.map((c) => c.id === constraintId ? updatedConstraint : c),
          },
        }
      })

      // 2. Refresh all constraint caches on the moved feature and validate other constraints
      //    (do NOT update their values — they should be marked invalid if unsatisfied)
      const featureById = new Map(nextFeatures.map((f) => [f.id, f]))
      nextFeatures = nextFeatures.map((f) => {
        if (f.id !== featureId) return f
        return validateConstraintsOnFeature(f, featureById)
      })

      // 3. Propagate only to features that depend on the moved feature (not the moved feature itself)
      //    Use dx:0,dy:0 seed so propagation re-derives reference geometry without treating it as a manual move
      nextFeatures = propagateConstraintsOnTranslate(
        nextFeatures,
        new Map([[featureId, { dx: 0, dy: 0 }]]),
        { transformProfile },
      )

      // 4. Validate all features that have constraints (catch any that became invalid after propagation)
      const featureById2 = new Map(nextFeatures.map((f) => [f.id, f]))
      nextFeatures = nextFeatures.map((f) => {
        if (f.sketch.constraints.every((c) => c.type !== 'fixed_distance')) return f
        return validateConstraintsOnFeature(f, featureById2)
      })

      const nextProject = {
        ...s.project,
        features: nextFeatures,
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
    }),
  }
})

const repairedInitialProject = normalizeProject(useProjectStore.getState().project)
if (!projectsEqual(repairedInitialProject, useProjectStore.getState().project)) {
  useProjectStore.setState((state) => ({
    project: repairedInitialProject,
    selection: sanitizeSelection(repairedInitialProject, state.selection),
  }))
}
