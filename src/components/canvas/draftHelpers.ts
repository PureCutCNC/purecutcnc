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

import { convertLength } from '../../utils/units'
import type { Point, Segment, SketchProfile } from '../../types/project'
import { circleProfile, polygonProfile, profileVertices, rectProfile, splineProfile } from '../../types/project'
import type { PendingAddTool, SketchControlRef } from '../../store/types'
import type { ResolvedSnap } from './snappingHelpers'
import { drawArcRadiusMeasurement, drawLineLengthMeasurement } from './measurements'
import { appendSplineDraftSegment } from './draftGeometry'
import { distance2, pointsEqual } from './hitTest'
import { anchorPointForIndex } from './profilePrimitives'
import { drawPendingPoint, drawPreviewProfile, traceDraftSegments } from './previewPrimitives'
import { worldToCanvas } from './viewTransform'
import type { ViewTransform } from './viewTransform'

const EXTEND_HIT_RADIUS = 14

export interface PendingSketchExtension {
  kind: 'extend_start' | 'extend_end'
  anchor: Point
}

export type EditDimStep =
  | { kind: 'endpoint'; control: SketchControlRef; fromAnchorIndex: number }
  | { kind: 'arc_radius'; control: SketchControlRef; arcStartAnchorIndex: number }

type ClosedPendingAddShape = Extract<NonNullable<PendingAddTool>, { shape: 'rect' | 'circle' | 'tab' | 'clamp' }>
type CompositePendingAdd = Extract<NonNullable<PendingAddTool>, { shape: 'composite' }>

function drawDiamond(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
): void {
  ctx.beginPath()
  ctx.moveTo(cx, cy - radius)
  ctx.lineTo(cx + radius, cy)
  ctx.lineTo(cx, cy + radius)
  ctx.lineTo(cx - radius, cy)
  ctx.closePath()
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

export function computeEditDimSteps(profile: SketchProfile, anchorIndex: number): EditDimStep[] {
  const steps: EditDimStep[] = []
  const n = profile.segments.length
  const vertices = profileVertices(profile)

  // Native Circle special case
  if (n === 1 && profile.segments[0].type === 'circle') {
    steps.push({
      kind: 'arc_radius',
      control: { kind: 'anchor', index: 0 },
      arcStartAnchorIndex: 0,
    })
    return steps
  }

  const hasIncoming = profile.closed || anchorIndex > 0
  if (hasIncoming) {
    const incomingSegIdx = profile.closed ? (anchorIndex - 1 + n) % n : anchorIndex - 1
    const seg = profile.segments[incomingSegIdx]
    if (seg.type === 'line' || seg.type === 'bezier') {
      steps.push({ kind: 'endpoint', control: { kind: 'anchor', index: anchorIndex }, fromAnchorIndex: incomingSegIdx })
    } else if (seg.type === 'arc') {
      steps.push({ kind: 'arc_radius', control: { kind: 'arc_handle', index: incomingSegIdx }, arcStartAnchorIndex: incomingSegIdx })
    }
  }

  const hasOutgoing = profile.closed ? n > 0 : anchorIndex < n
  if (hasOutgoing) {
    const outgoingSegIdx = anchorIndex
    const seg = profile.segments[outgoingSegIdx]
    const nextAnchorIdx = profile.closed ? (anchorIndex + 1) % vertices.length : anchorIndex + 1
    if (seg.type === 'line' || seg.type === 'bezier') {
      steps.push({ kind: 'endpoint', control: { kind: 'anchor', index: nextAnchorIdx }, fromAnchorIndex: anchorIndex })
    } else if (seg.type === 'arc') {
      steps.push({ kind: 'arc_radius', control: { kind: 'arc_handle', index: outgoingSegIdx }, arcStartAnchorIndex: anchorIndex })
    }
  }

  return steps
}

export function buildPendingProfile(
  pendingAdd: ClosedPendingAddShape,
  previewPoint: Point,
  units: 'mm' | 'inch',
): SketchProfile {
  const minSize = convertLength(0.01, 'mm', units)
  const anchor = pendingAdd.anchor ?? previewPoint
  const current = previewPoint

  if (pendingAdd.shape === 'rect' || pendingAdd.shape === 'tab' || pendingAdd.shape === 'clamp') {
    const x = Math.min(anchor.x, current.x)
    const y = Math.min(anchor.y, current.y)
    return rectProfile(
      x,
      y,
      Math.max(Math.abs(current.x - anchor.x), minSize),
      Math.max(Math.abs(current.y - anchor.y), minSize),
    )
  }

  const radius = Math.max(Math.hypot(current.x - anchor.x, current.y - anchor.y), minSize)
  return circleProfile(anchor.x, anchor.y, radius)
}

export function compositeDraftPoints(pendingAdd: CompositePendingAdd): Point[] {
  if (!pendingAdd.start) return []
  return [pendingAdd.start, ...pendingAdd.segments.map((segment) => segment.to)]
}

export function drawCompositeDraft(
  ctx: CanvasRenderingContext2D,
  pendingAdd: CompositePendingAdd,
  previewPoint: Point | null,
  vt: ViewTransform,
  units: 'mm' | 'inch',
  previewHighlighted = false,
  strokeColor = '#efbc7a',
): void {
  if (!pendingAdd.start) {
    if (previewPoint) {
      drawPendingPoint(ctx, previewPoint, vt, previewHighlighted)
    }
    return
  }

  let previewSegments = [...pendingAdd.segments]
  const lastPoint = pendingAdd.lastPoint ?? pendingAdd.start

  if (!pendingAdd.closed && previewPoint) {
    if (pendingAdd.currentMode === 'arc') {
      if (pendingAdd.pendingArcEnd) {
        const previewArc = buildArcSegmentFromThreePoints(lastPoint, pendingAdd.pendingArcEnd, previewPoint)
        if (previewArc) {
          previewSegments = [...previewSegments, previewArc]
        } else if (!pointsEqual(lastPoint, pendingAdd.pendingArcEnd)) {
          previewSegments = [...previewSegments, { type: 'line', to: pendingAdd.pendingArcEnd }]
        }
      } else if (!pointsEqual(lastPoint, previewPoint)) {
        previewSegments = [...previewSegments, { type: 'line', to: previewPoint }]
      }
    } else if (!pointsEqual(lastPoint, previewPoint)) {
      previewSegments =
        pendingAdd.currentMode === 'spline'
          ? appendSplineDraftSegment(pendingAdd.start, previewSegments, previewPoint)
          : [...previewSegments, { type: 'line', to: previewPoint }]
    }
  }

  if (pendingAdd.closed) {
    drawPreviewProfile(
      ctx,
      { start: pendingAdd.start, segments: pendingAdd.segments, closed: true },
      vt,
      'Pending composite',
    )
  } else {
    traceDraftSegments(ctx, pendingAdd.start, previewSegments, vt)
    ctx.strokeStyle = strokeColor
    ctx.lineWidth = 2
    ctx.setLineDash([8, 5])
    ctx.stroke()
    ctx.setLineDash([])
  }

  let current = pendingAdd.start
  for (const segment of previewSegments) {
    if (segment.type === 'line') {
      drawLineLengthMeasurement(ctx, current, segment.to, vt, units)
    } else if (segment.type === 'arc') {
      drawArcRadiusMeasurement(ctx, current, segment, vt, units)
    } else if (segment.type === 'bezier') {
      drawLineLengthMeasurement(ctx, current, segment.to, vt, units)
    }
    current = segment.to
  }

  const points = compositeDraftPoints(pendingAdd)
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]
    const vertex = worldToCanvas(point, vt)
    const isStart = index === 0
    ctx.beginPath()
    ctx.arc(vertex.cx, vertex.cy, isStart ? 5.5 : 5, 0, Math.PI * 2)
    ctx.fillStyle = isStart ? 'rgba(239, 188, 122, 0.28)' : 'rgba(210, 221, 230, 0.2)'
    ctx.fill()
    ctx.strokeStyle = isStart ? '#efbc7a' : '#d2dde6'
    ctx.lineWidth = 2
    ctx.stroke()
  }

  if (pendingAdd.pendingArcEnd) {
    drawPendingPoint(ctx, pendingAdd.pendingArcEnd, vt)
  } else if (previewPoint && !pendingAdd.closed) {
    drawPendingPoint(ctx, previewPoint, vt, previewHighlighted)
  }
}

export function resolveCompositeDraftSegmentsForWarning(
  pendingAdd: CompositePendingAdd,
): Segment[] | null {
  if (!pendingAdd.start || !pendingAdd.lastPoint || pendingAdd.pendingArcEnd) {
    return null
  }

  if (pendingAdd.segments.length < 2) {
    return null
  }

  if (pointsEqual(pendingAdd.lastPoint, pendingAdd.start)) {
    return pendingAdd.segments
  }

  if (pendingAdd.currentMode === 'spline') {
    return appendSplineDraftSegment(pendingAdd.start, pendingAdd.segments, pendingAdd.start)
  }

  return [...pendingAdd.segments, { type: 'line', to: pendingAdd.start }]
}

export function findOpenProfileExtensionEndpoint(
  profile: SketchProfile,
  rawPoint: Point,
  vt: ViewTransform,
): PendingSketchExtension | null {
  if (profile.closed) {
    return null
  }

  const rawCanvas = worldToCanvas(rawPoint, vt)
  const startCanvas = worldToCanvas(profile.start, vt)
  if (distance2(rawCanvas, startCanvas) <= EXTEND_HIT_RADIUS * EXTEND_HIT_RADIUS) {
    return { kind: 'extend_start', anchor: profile.start }
  }

  const endAnchor = anchorPointForIndex(profile, profile.segments.length)
  const endCanvas = worldToCanvas(endAnchor, vt)
  if (distance2(rawCanvas, endCanvas) <= EXTEND_HIT_RADIUS * EXTEND_HIT_RADIUS) {
    return { kind: 'extend_end', anchor: endAnchor }
  }

  return null
}

export function drawSnapIndicator(
  ctx: CanvasRenderingContext2D,
  resolvedSnap: ResolvedSnap | null,
  vt: ViewTransform,
): void {
  if (!resolvedSnap?.mode) {
    return
  }

  if (resolvedSnap.guide) {
    const from = worldToCanvas(resolvedSnap.guide.from, vt)
    const to = worldToCanvas(resolvedSnap.guide.to, vt)
    ctx.save()
    ctx.setLineDash(resolvedSnap.mode === 'perpendicular' ? [4, 3] : [6, 4])
    ctx.strokeStyle = resolvedSnap.mode === 'perpendicular' ? 'rgba(170, 221, 255, 0.9)' : 'rgba(242, 185, 92, 0.72)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(from.cx, from.cy)
    ctx.lineTo(to.cx, to.cy)
    ctx.stroke()
    ctx.restore()
  }

  const { cx, cy } = worldToCanvas(resolvedSnap.point, vt)
  ctx.save()
  ctx.strokeStyle = '#f7d394'
  ctx.fillStyle = 'rgba(242, 185, 92, 0.18)'
  ctx.lineWidth = 2

  if (resolvedSnap.mode === 'midpoint') {
    drawDiamond(ctx, cx, cy, 6)
    ctx.fill()
    ctx.stroke()
  } else if (resolvedSnap.mode === 'center') {
    ctx.beginPath()
    ctx.arc(cx, cy, 6, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(cx - 4, cy)
    ctx.lineTo(cx + 4, cy)
    ctx.moveTo(cx, cy - 4)
    ctx.lineTo(cx, cy + 4)
    ctx.stroke()
  } else if (resolvedSnap.mode === 'perpendicular') {
    ctx.beginPath()
    ctx.rect(cx - 4, cy - 4, 8, 8)
    ctx.fill()
    ctx.stroke()
  } else {
    ctx.beginPath()
    ctx.arc(cx, cy, 5, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  }

  ctx.restore()
}

export function buildPendingDraftProfile(
  pendingAdd: PendingAddTool | null,
  previewPoint: Point | null,
  units: 'mm' | 'inch',
): SketchProfile | null {
  return pendingAdd?.shape === 'polygon' && pendingAdd.points.length >= 3
    ? polygonProfile(pendingAdd.points)
    : pendingAdd?.shape === 'spline' && pendingAdd.points.length >= 3
      ? splineProfile(pendingAdd.points)
      : (pendingAdd?.shape === 'rect' || pendingAdd?.shape === 'circle' || pendingAdd?.shape === 'tab' || pendingAdd?.shape === 'clamp')
          && pendingAdd.anchor
          && previewPoint
        ? buildPendingProfile(pendingAdd, previewPoint, units)
        : pendingAdd?.shape === 'composite' && pendingAdd.start
          ? (() => {
              const segments = resolveCompositeDraftSegmentsForWarning(pendingAdd)
              return segments
                ? {
                    start: pendingAdd.start,
                    segments,
                    closed: pendingAdd.closed,
                  }
                : null
            })()
          : null
}
