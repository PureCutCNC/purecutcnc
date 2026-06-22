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

import { profileVertices, type Point, type Segment, type SketchProfile } from '../../types/project'
import type { OpenProfileEndpoint, PendingAddTool, SketchInsertTarget } from '../types'
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
} from './geometry'

export function cloneSegment(segment: Segment): Segment {
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

export function normalizeEditableProfileClosure(profile: SketchProfile): SketchProfile {
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


export function anchorPointForIndex(profile: SketchProfile, index: number): Point {
  if (index <= 0) {
    return profile.start
  }
  return profile.segments[index - 1]?.to ?? profile.start
}

export function splitBezierSegment(start: Point, segment: Extract<Segment, { type: 'bezier' }>, t: number): [Segment, Segment] {
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

export function splitArcSegment(segment: Extract<Segment, { type: 'arc' | 'circle' }>, point: Point): [Segment, Segment] {
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

export function extendOpenProfileAtStart(profile: SketchProfile, point: Point): SketchProfile {
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

export function extendOpenProfileAtEnd(profile: SketchProfile, point: Point): SketchProfile {
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

export function reverseOpenProfile(profile: SketchProfile): SketchProfile {
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

export function endPointForOpenProfile(profile: SketchProfile): Point {
  return anchorPointForIndex(profile, profile.segments.length)
}

export function orientOpenProfileTowardEndpoint(profile: SketchProfile, endpoint: OpenProfileEndpoint): SketchProfile {
  return endpoint === 'end'
    ? {
        ...profile,
        start: clonePoint(profile.start),
        segments: profile.segments.map(cloneSegment),
        closed: false,
      }
    : reverseOpenProfile(profile)
}

export function orientOpenProfileFromEndpoint(profile: SketchProfile, endpoint: OpenProfileEndpoint): SketchProfile {
  return endpoint === 'start'
    ? {
        ...profile,
        start: clonePoint(profile.start),
        segments: profile.segments.map(cloneSegment),
        closed: false,
      }
    : reverseOpenProfile(profile)
}

export function closeOpenProfile(profile: SketchProfile): SketchProfile | null {
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


export function buildBridgeSegment(
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

export function createFilletArcSegment(start: Point, end: Point, center: Point): Segment {
  const startVector = subtractPoint(start, center)
  const endVector = subtractPoint(end, center)
  return {
    type: 'arc',
    center: clonePoint(center),
    clockwise: crossPoint(startVector, endVector) < 0,
    to: clonePoint(end),
  }
}

export function applyLineCornerFillet(profile: SketchProfile, anchorIndex: number, radius: number): SketchProfile | null {
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

export function applyLineCornerChamfer(profile: SketchProfile, anchorIndex: number, distance: number): SketchProfile | null {
  const anchors = profileVertices(profile)
  const anchorCount = anchors.length
  if (distance <= 1e-9 || anchorIndex < 0 || anchorIndex >= anchorCount) {
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

  const incomingLength = pointLength(subtractPoint(previousAnchor, corner))
  const outgoingLength = pointLength(subtractPoint(nextAnchor, corner))
  if (distance >= incomingLength || distance >= outgoingLength) {
    return null
  }

  const trimStart = addPoint(corner, scalePoint(incomingDirection, distance))
  const trimEnd = addPoint(corner, scalePoint(outgoingDirection, distance))
  const nextSegments = profile.segments.map(cloneSegment)
  nextSegments[incomingIndex] = { type: 'line', to: clonePoint(trimStart) }
  nextSegments.splice(
    outgoingIndex,
    1,
    { type: 'line', to: clonePoint(trimEnd) },
    { type: 'line', to: clonePoint(nextAnchor) },
  )

  if (profile.closed && anchorIndex === 0) {
    return normalizeEditableProfileClosure({
      ...profile,
      start: clonePoint(trimStart),
      segments: nextSegments,
    })
  }

  return normalizeEditableProfileClosure({
    ...profile,
    segments: nextSegments,
  })
}

export function insertPointIntoProfile(profile: SketchProfile, target: SketchInsertTarget): SketchProfile {
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

export function deleteAnchorFromProfile(profile: SketchProfile, anchorIndex: number): SketchProfile | null {
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

export interface ProfileBreakResult {
  profile: SketchProfile
  splitProfile: SketchProfile | null
}

export function profileFromOpenSegments(start: Point, segments: Segment[]): SketchProfile | null {
  if (segments.length === 0) {
    return null
  }

  return {
    start: clonePoint(start),
    segments: segments.map(cloneSegment),
    closed: false,
  }
}

export function deleteSegmentFromProfile(profile: SketchProfile, segmentIndex: number): ProfileBreakResult | null {
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

export function disconnectProfileAtAnchor(profile: SketchProfile, anchorIndex: number): ProfileBreakResult | null {
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

export function resolveCompositeDraftSegments(draft: Extract<PendingAddTool, { shape: 'composite' }>): Segment[] | null {
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

export function resolveOpenCompositeDraftSegments(draft: Extract<PendingAddTool, { shape: 'composite' }>): Segment[] | null {
  if (!draft.start || !draft.lastPoint || draft.pendingArcEnd) {
    return null
  }

  if (draft.segments.length < 1) {
    return null
  }

  return draft.segments
}

export function buildArcSegmentFromThreePoints(start: Point, end: Point, through: Point): Segment | null {
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

export function arcControlPoint(start: Point, segment: Extract<Segment, { type: 'arc' }>): Point {
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
