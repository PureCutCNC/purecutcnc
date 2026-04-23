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

import type { ToolpathResult } from '../../engine/toolpaths/types'
import { getFeatureGeometryBounds, getFeatureGeometryProfiles } from '../../text'
import {
  getProfileBounds,
  splineProfile,
} from '../../types/project'
import type { Point, Segment, SketchFeature, SketchProfile } from '../../types/project'
import { formatLength } from '../../utils/units'
import {
  drawLineLengthMeasurement,
} from './measurements'
import { appendSplineDraftSegment } from './draftGeometry'
import { pointsEqual } from './hitTest'
import { traceProfilePath } from './profilePrimitives'
import { worldToCanvas } from './viewTransform'
import type { ViewTransform } from './viewTransform'

export function translateProfile(profile: SketchProfile, dx: number, dy: number): SketchProfile {
  return {
    ...profile,
    start: { x: profile.start.x + dx, y: profile.start.y + dy },
    segments: profile.segments.map((segment) => {
      if (segment.type === 'arc' || segment.type === 'circle') {
        return {
          ...segment,
          to: { x: segment.to.x + dx, y: segment.to.y + dy },
          center: { x: segment.center.x + dx, y: segment.center.y + dy },
        }
      }

      if (segment.type === 'bezier') {
        return {
          ...segment,
          to: { x: segment.to.x + dx, y: segment.to.y + dy },
          control1: { x: segment.control1.x + dx, y: segment.control1.y + dy },
          control2: { x: segment.control2.x + dx, y: segment.control2.y + dy },
        }
      }

      return {
        ...segment,
        to: { x: segment.to.x + dx, y: segment.to.y + dy },
      }
    }),
  }
}

export function drawFeature(
  ctx: CanvasRenderingContext2D,
  feature: SketchFeature,
  vt: ViewTransform,
  units: 'mm' | 'inch',
  showInfo: boolean,
  selected: boolean,
  hovered: boolean,
  editing: boolean,
): void {
  const zTop = typeof feature.z_top === 'number' ? feature.z_top : 5
  const zBottom = typeof feature.z_bottom === 'number' ? feature.z_bottom : 0
  const depthWeight = Math.min(Math.max(Math.abs(zTop - zBottom) / 30, 0), 1)

  let fill = 'rgba(78, 126, 170, 0.42)'
  let stroke = '#4e8dc1'

  if (feature.operation === 'add') {
    fill = 'rgba(92, 165, 115, 0.43)'
    stroke = '#63b176'
  }

  if (hovered) {
    fill = 'rgba(203, 148, 86, 0.35)'
    stroke = '#d2a064'
  }

  if (selected) {
    fill = 'rgba(234, 170, 97, 0.45)'
    stroke = '#efbc7a'
  }

  if (editing) {
    fill = 'rgba(247, 201, 132, 0.30)'
    stroke = '#f7cd87'
  }

  if (feature.operation === 'subtract' && !selected && !hovered && !editing) {
    const g = Math.round(126 - 45 * depthWeight)
    const b = Math.round(170 + 35 * depthWeight)
    fill = `rgba(78, ${g}, ${b}, 0.44)`
  }

  const profiles = getFeatureGeometryProfiles(feature)
  for (const profile of profiles) {
    traceProfilePath(ctx, profile, vt)
    if (profile.closed) {
      ctx.fillStyle = fill
      ctx.fill()
    }

    ctx.strokeStyle = stroke
    ctx.lineWidth = editing || selected ? 2.5 : 1.8
    ctx.stroke()
  }

  if (showInfo) {
    const bounds = getFeatureGeometryBounds(feature)
    const center = worldToCanvas(
      { x: bounds.minX + (bounds.maxX - bounds.minX) / 2, y: bounds.minY + (bounds.maxY - bounds.minY) / 2 },
      vt,
    )

    ctx.fillStyle = 'rgba(228, 236, 244, 0.9)'
    ctx.font = '11px "IBM Plex Mono", "SFMono-Regular", Consolas, monospace'
    ctx.textAlign = 'center'
    ctx.fillText(feature.name, center.cx, center.cy - 5)
    ctx.fillStyle = 'rgba(171, 194, 213, 0.9)'
    ctx.fillText(`z ${formatLength(zTop, units)} → ${formatLength(zBottom, units)}`, center.cx, center.cy + 10)
  }
}

export function drawPreviewProfile(
  ctx: CanvasRenderingContext2D,
  profile: SketchProfile,
  vt: ViewTransform,
  label: string,
): void {
  traceProfilePath(ctx, profile, vt)
  if (profile.closed) {
    ctx.fillStyle = 'rgba(236, 184, 122, 0.18)'
    ctx.fill()
  }
  ctx.setLineDash([8, 5])
  ctx.strokeStyle = '#efbc7a'
  ctx.lineWidth = 2
  ctx.stroke()
  ctx.setLineDash([])

  const bounds = getProfileBounds(profile)
  const center = worldToCanvas(
    {
      x: bounds.minX + (bounds.maxX - bounds.minX) / 2,
      y: bounds.minY + (bounds.maxY - bounds.minY) / 2,
    },
    vt,
  )

  ctx.fillStyle = 'rgba(245, 216, 183, 0.95)'
  ctx.font = '11px "IBM Plex Mono", "SFMono-Regular", Consolas, monospace'
  ctx.textAlign = 'center'
  if (label) {
    ctx.fillText(label, center.cx, center.cy)
  }
}

export function drawPendingPoint(
  ctx: CanvasRenderingContext2D,
  point: Point,
  vt: ViewTransform,
  highlighted = false,
): void {
  const { cx, cy } = worldToCanvas(point, vt)
  const strokeColor = highlighted ? '#8fd6ff' : '#efbc7a'
  const fillColor = highlighted ? 'rgba(143, 214, 255, 0.28)' : 'rgba(239, 188, 122, 0.25)'
  const crossColor = highlighted ? 'rgba(170, 233, 255, 0.95)' : 'rgba(239, 188, 122, 0.9)'

  ctx.beginPath()
  ctx.arc(cx, cy, 6, 0, Math.PI * 2)
  ctx.fillStyle = fillColor
  ctx.fill()
  ctx.strokeStyle = strokeColor
  ctx.lineWidth = 2
  ctx.stroke()

  ctx.beginPath()
  ctx.moveTo(cx - 10, cy)
  ctx.lineTo(cx + 10, cy)
  ctx.moveTo(cx, cy - 10)
  ctx.lineTo(cx, cy + 10)
  ctx.strokeStyle = crossColor
  ctx.lineWidth = 1
  ctx.stroke()
}

export function drawMoveGuide(
  ctx: CanvasRenderingContext2D,
  fromPoint: Point,
  toPoint: Point,
  vt: ViewTransform,
  color = 'rgba(239, 188, 122, 0.75)',
): void {
  const start = worldToCanvas(fromPoint, vt)
  const end = worldToCanvas(toPoint, vt)

  ctx.beginPath()
  ctx.moveTo(start.cx, start.cy)
  ctx.lineTo(end.cx, end.cy)
  ctx.strokeStyle = color
  ctx.lineWidth = 1.5
  ctx.setLineDash([8, 5])
  ctx.stroke()
  ctx.setLineDash([])
}

function buildSplineDraftSegments(points: Point[], previewPoint: Point | null): Segment[] {
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

export function traceDraftSegments(
  ctx: CanvasRenderingContext2D,
  start: Point,
  segments: Segment[],
  vt: ViewTransform,
): void {
  ctx.beginPath()
  const startCanvas = worldToCanvas(start, vt)
  ctx.moveTo(startCanvas.cx, startCanvas.cy)

  let current = start
  for (const segment of segments) {
    const to = worldToCanvas(segment.to, vt)

    if (segment.type === 'line') {
      ctx.lineTo(to.cx, to.cy)
      current = segment.to
      continue
    }

    if (segment.type === 'bezier') {
      const control1 = worldToCanvas(segment.control1, vt)
      const control2 = worldToCanvas(segment.control2, vt)
      ctx.bezierCurveTo(control1.cx, control1.cy, control2.cx, control2.cy, to.cx, to.cy)
      current = segment.to
      continue
    }

    const center = worldToCanvas(segment.center, vt)
    const radius = Math.hypot(current.x - segment.center.x, current.y - segment.center.y) * vt.scale
    const startAngle = Math.atan2(current.y - segment.center.y, current.x - segment.center.x)
    if (segment.type === 'circle') {
      ctx.arc(center.cx, center.cy, radius, startAngle, startAngle + Math.PI * 2, segment.clockwise)
    } else {
      const endAngle = Math.atan2(segment.to.y - segment.center.y, segment.to.x - segment.center.x)
      ctx.arc(center.cx, center.cy, radius, startAngle, endAngle, segment.clockwise)
    }
    current = segment.to
  }
}

export function drawPendingPathLoop(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  previewPoint: Point | null,
  vt: ViewTransform,
  closePreview: boolean,
  previewProfileFactory: (points: Point[]) => SketchProfile,
  label: string,
  units: 'mm' | 'inch',
  previewHighlighted = false,
  strokeColor = '#efbc7a',
): void {
  if (points.length === 0) return

  ctx.beginPath()
  const start = worldToCanvas(points[0], vt)
  ctx.moveTo(start.cx, start.cy)

  for (let index = 1; index < points.length; index += 1) {
    const vertex = worldToCanvas(points[index], vt)
    ctx.lineTo(vertex.cx, vertex.cy)
  }

  if (previewPoint) {
    const preview = worldToCanvas(closePreview ? points[0] : previewPoint, vt)
    ctx.lineTo(preview.cx, preview.cy)
  }

  ctx.strokeStyle = strokeColor
  ctx.lineWidth = 2
  ctx.setLineDash([8, 5])
  ctx.stroke()
  ctx.setLineDash([])

  if (previewPoint && !closePreview) {
    drawPendingPoint(ctx, previewPoint, vt, previewHighlighted)
  }

  for (let index = 1; index < points.length; index += 1) {
    drawLineLengthMeasurement(ctx, points[index - 1], points[index], vt, units)
  }

  if (previewPoint) {
    drawLineLengthMeasurement(ctx, points[points.length - 1], closePreview ? points[0] : previewPoint, vt, units)
  }

  if (points.length >= 3 && previewPoint && closePreview) {
    const profile = previewProfileFactory(points)
    ctx.save()
    ctx.globalAlpha = 0.85
    drawPreviewProfile(ctx, profile, vt, label)
    ctx.restore()
  }

  for (let index = 0; index < points.length; index += 1) {
    const vertex = worldToCanvas(points[index], vt)
    const isStart = index === 0
    const isCloseTarget = isStart && points.length >= 3 && closePreview
    ctx.beginPath()
    ctx.arc(vertex.cx, vertex.cy, isCloseTarget ? 7 : 5, 0, Math.PI * 2)
    ctx.fillStyle = isStart ? 'rgba(239, 188, 122, 0.32)' : 'rgba(210, 221, 230, 0.22)'
    ctx.fill()
    ctx.strokeStyle = isCloseTarget ? '#ffd095' : isStart ? '#efbc7a' : '#d2dde6'
    ctx.lineWidth = 2
    ctx.stroke()
  }
}

export function drawPendingSplineLoop(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  previewPoint: Point | null,
  vt: ViewTransform,
  closePreview: boolean,
  units: 'mm' | 'inch',
  previewHighlighted = false,
  strokeColor = '#efbc7a',
): void {
  if (points.length === 0) return

  const previewSegments = buildSplineDraftSegments(points, closePreview ? null : previewPoint)
  if (previewSegments.length > 0) {
    traceDraftSegments(ctx, points[0], previewSegments, vt)
    ctx.strokeStyle = strokeColor
    ctx.lineWidth = 2
    ctx.setLineDash([8, 5])
    ctx.stroke()
    ctx.setLineDash([])
  }

  if (previewPoint && !closePreview) {
    drawPendingPoint(ctx, previewPoint, vt, previewHighlighted)
  }

  if (points.length >= 3 && previewPoint && closePreview) {
    const profile = splineProfile(points)
    ctx.save()
    ctx.globalAlpha = 0.85
    drawPreviewProfile(ctx, profile, vt, 'Pending spline')
    ctx.restore()
  }

  for (let index = 1; index < points.length; index += 1) {
    drawLineLengthMeasurement(ctx, points[index - 1], points[index], vt, units)
  }
  if (previewPoint) {
    drawLineLengthMeasurement(ctx, points[points.length - 1], closePreview ? points[0] : previewPoint, vt, units)
  }

  for (let index = 0; index < points.length; index += 1) {
    const vertex = worldToCanvas(points[index], vt)
    const isStart = index === 0
    const isCloseTarget = isStart && points.length >= 3 && closePreview
    ctx.beginPath()
    ctx.arc(vertex.cx, vertex.cy, isCloseTarget ? 7 : 5, 0, Math.PI * 2)
    ctx.fillStyle = isStart ? 'rgba(239, 188, 122, 0.32)' : 'rgba(210, 221, 230, 0.22)'
    ctx.fill()
    ctx.strokeStyle = isCloseTarget ? '#ffd095' : isStart ? '#efbc7a' : '#d2dde6'
    ctx.lineWidth = 2
    ctx.stroke()
  }
}

export function drawToolpath(
  ctx: CanvasRenderingContext2D,
  toolpath: ToolpathResult,
  vt: ViewTransform,
  emphasized: boolean,
): void {
  const layers: Array<{
    kinds: ToolpathResult['moves'][number]['kind'][]
    stroke: string
    lineWidth: number
    dash: number[]
  }> = [
    { kinds: ['rapid'], stroke: 'rgba(124, 184, 222, 0.8)', lineWidth: 1.3, dash: [8, 6] },
    { kinds: ['plunge'], stroke: 'rgba(213, 131, 223, 0.95)', lineWidth: 1.5, dash: [3, 4] },
    { kinds: ['lead_in', 'lead_out'], stroke: 'rgba(255, 177, 92, 0.95)', lineWidth: 1.7, dash: [6, 4] },
    { kinds: ['cut'], stroke: 'rgba(255, 115, 92, 0.96)', lineWidth: 2.1, dash: [] },
  ]

  for (const layer of layers) {
    const moves = toolpath.moves.filter((move) => layer.kinds.includes(move.kind))
    if (moves.length === 0) {
      continue
    }

    ctx.beginPath()
    for (const move of moves) {
      const from = worldToCanvas({ x: move.from.x, y: move.from.y }, vt)
      const to = worldToCanvas({ x: move.to.x, y: move.to.y }, vt)
      ctx.moveTo(from.cx, from.cy)
      ctx.lineTo(to.cx, to.cy)
    }
    ctx.strokeStyle = layer.stroke
    ctx.globalAlpha = emphasized ? 1 : 0.34
    ctx.lineWidth = emphasized ? layer.lineWidth + 0.35 : Math.max(1, layer.lineWidth - 0.35)
    ctx.setLineDash(layer.dash)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.globalAlpha = 1
  }

  if (!emphasized || !toolpath.bounds) {
    return
  }

  const span = Math.max(
    toolpath.bounds.maxX - toolpath.bounds.minX,
    toolpath.bounds.maxY - toolpath.bounds.minY,
    toolpath.bounds.maxZ - toolpath.bounds.minZ,
  )
  const preferredSpacing = Math.max(12, Math.min(40, span * vt.scale * 0.09))
  const preferredArrowLength = Math.max(8.5, Math.min(18, span * vt.scale * 0.03))
  const distanceSinceLastArrowByKind: Record<'cut' | 'rapid', number> = {
    cut: 0,
    rapid: 0,
  }

  function drawDirectionArrow(fromX: number, fromY: number, toX: number, toY: number, color: string) {
    const dx = toX - fromX
    const dy = toY - fromY
    const length = Math.hypot(dx, dy)
    if (length <= 0.001) {
      return
    }

    const ux = dx / length
    const uy = dy / length
    const markerLength = Math.max(6.5, Math.min(preferredArrowLength, Math.max(length * 0.6, preferredArrowLength * 0.58)))
    const headLength = markerLength * 0.52
    const headWidth = markerLength * 0.28
    const centerX = (fromX + toX) / 2
    const centerY = (fromY + toY) / 2
    const tailX = centerX - ux * markerLength * 0.5
    const tailY = centerY - uy * markerLength * 0.5
    const tipX = centerX + ux * markerLength * 0.5
    const tipY = centerY + uy * markerLength * 0.5
    const leftX = tipX - ux * headLength - uy * headWidth
    const leftY = tipY - uy * headLength + ux * headWidth
    const rightX = tipX - ux * headLength + uy * headWidth
    const rightY = tipY - uy * headLength - ux * headWidth

    ctx.save()
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineWidth = 1.4
    ctx.globalAlpha = 0.95
    ctx.beginPath()
    ctx.moveTo(tailX, tailY)
    ctx.lineTo(tipX, tipY)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(tipX, tipY)
    ctx.lineTo(leftX, leftY)
    ctx.lineTo(rightX, rightY)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }

  function moveCanvasDelta(move: ToolpathResult['moves'][number]) {
    const from = worldToCanvas({ x: move.from.x, y: move.from.y }, vt)
    const to = worldToCanvas({ x: move.to.x, y: move.to.y }, vt)
    return {
      from,
      to,
      dx: to.cx - from.cx,
      dy: to.cy - from.cy,
      length: Math.hypot(to.cx - from.cx, to.cy - from.cy),
    }
  }

  function normalizedMoveDirection(move: ToolpathResult['moves'][number] | undefined): { x: number; y: number } | null {
    if (!move || (move.kind !== 'cut' && move.kind !== 'rapid')) {
      return null
    }

    const delta = moveCanvasDelta(move)
    if (delta.length <= 0.001) {
      return null
    }

    return { x: delta.dx / delta.length, y: delta.dy / delta.length }
  }

  for (let moveIndex = 0; moveIndex < toolpath.moves.length; moveIndex += 1) {
    const move = toolpath.moves[moveIndex]
    if (move.kind !== 'cut' && move.kind !== 'rapid') {
      continue
    }

    const delta = moveCanvasDelta(move)
    if (delta.length < 0.5) {
      continue
    }

    distanceSinceLastArrowByKind[move.kind] += delta.length
    const previousDirection = normalizedMoveDirection(toolpath.moves[moveIndex - 1])
    const nextDirection = normalizedMoveDirection(toolpath.moves[moveIndex + 1])
    const direction = { x: delta.dx / delta.length, y: delta.dy / delta.length }
    const directionTurn = previousDirection && nextDirection
      ? Math.min(
        Math.acos(Math.max(-1, Math.min(1, direction.x * previousDirection.x + direction.y * previousDirection.y))),
        Math.acos(Math.max(-1, Math.min(1, direction.x * nextDirection.x + direction.y * nextDirection.y))),
      )
      : null
    const isConnectorCut =
      move.kind === 'cut'
      && delta.length <= preferredSpacing * 0.8
      && directionTurn !== null
      && directionTurn >= Math.PI / 10
    const shouldForceArrow = delta.length >= preferredArrowLength * 1.1
    const shouldPlaceBySpacing = distanceSinceLastArrowByKind[move.kind] >= preferredSpacing

    if (!shouldForceArrow && !shouldPlaceBySpacing && !isConnectorCut) {
      continue
    }

    drawDirectionArrow(
      delta.from.cx,
      delta.from.cy,
      delta.to.cx,
      delta.to.cy,
      move.kind === 'rapid' ? 'rgba(124, 184, 222, 0.95)' : 'rgba(255, 115, 92, 0.98)',
    )
    distanceSinceLastArrowByKind[move.kind] = 0
  }
}

export function hexToRgba(hex: string, alpha: number): string {
  const normalized = hex.replace('#', '')
  if (normalized.length !== 6) return `rgba(136, 153, 170, ${alpha})`

  const r = Number.parseInt(normalized.slice(0, 2), 16)
  const g = Number.parseInt(normalized.slice(2, 4), 16)
  const b = Number.parseInt(normalized.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
