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
import type { ToolpathVisibility } from '../toolpathVisibility'
import { getFeatureGeometryBounds, getFeatureGeometryProfiles } from '../../text'
import {
  getProfileBounds,
  splineProfile,
  slotProfile,
  ngonProfile,
} from '../../types/project'
import { roundedRectProfile, chamferedRectProfile } from '../../store/helpers/cannedRectProfiles'
import type { Point, Segment, SketchFeature, SketchProfile } from '../../types/project'
import { formatLength } from '../../utils/units'
import { buildGearProfile, type GearCreationParams } from '../../sketch/gearProfile'
import {
  drawLineLengthMeasurement,
} from './measurements'
import { appendSplineDraftSegment } from './draftGeometry'
import { pointsEqual } from './hitTest'
import { appendProfilePath, traceProfilePath } from './profilePrimitives'
import { worldToCanvas } from './viewTransform'
import type { ViewTransform } from './viewTransform'
import { canvasColors, canvasRgba, parseRgb } from './canvasPalette'

export function featureUsesSketchFill(operation: SketchFeature['operation']): boolean {
  return operation !== 'line' && operation !== 'construction'
}

export function drawLineFeatureBatch(
  ctx: CanvasRenderingContext2D,
  features: SketchFeature[],
  vt: ViewTransform,
): void {
  if (features.length === 0) return
  const batchSize = 128
  ctx.strokeStyle = canvasColors().featureCutStroke
  ctx.lineWidth = 1.8
  ctx.setLineDash([])
  for (let start = 0; start < features.length; start += batchSize) {
    ctx.beginPath()
    const end = Math.min(start + batchSize, features.length)
    for (let index = start; index < end; index += 1) {
      for (const profile of getFeatureGeometryProfiles(features[index])) {
        appendProfilePath(ctx, profile, vt)
      }
    }
    ctx.stroke()
  }
}

export function drawFeatureInfo(
  ctx: CanvasRenderingContext2D,
  feature: SketchFeature,
  vt: ViewTransform,
  units: 'mm' | 'inch',
): void {
  const zTop = typeof feature.z_top === 'number' ? feature.z_top : 5
  const zBottom = typeof feature.z_bottom === 'number' ? feature.z_bottom : 0
  const bounds = getFeatureGeometryBounds(feature)
  const center = worldToCanvas(
    { x: bounds.minX + (bounds.maxX - bounds.minX) / 2, y: bounds.minY + (bounds.maxY - bounds.minY) / 2 },
    vt,
  )

  ctx.fillStyle = canvasColors().featureInfoText
  ctx.font = '11px "IBM Plex Mono", "SFMono-Regular", Consolas, monospace'
  ctx.textAlign = 'center'
  ctx.fillText(feature.name, center.cx, center.cy - 5)
  if (feature.operation !== 'construction') {
    ctx.fillStyle = canvasColors().featureInfoSubText
    ctx.fillText(`z ${formatLength(zTop, units)} → ${formatLength(zBottom, units)}`, center.cx, center.cy + 10)
  }
}

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
  groupSelected: boolean,
): void {
  const zTop = typeof feature.z_top === 'number' ? feature.z_top : 5
  const zBottom = typeof feature.z_bottom === 'number' ? feature.z_bottom : 0
  const depthWeight = Math.min(Math.max(Math.abs(zTop - zBottom) / 30, 0), 1)
  // Construction geometry reads as reference marks: muted grey-blue, dashed,
  // thinner, never filled — visibly "not material" next to regular features.
  const construction = feature.operation === 'construction'
  const p = canvasColors()

  let fill = p.featureCutFill
  let stroke = p.featureCutStroke
  let lineDash: number[] = []

  if (feature.operation === 'add') {
    fill = p.featureAddFill
    stroke = p.featureAddStroke
  }

  if (feature.operation === 'model') {
    fill = p.featureModelFill
    stroke = p.featureModelStroke
  }

  if (feature.operation === 'region') {
    const excludeRegion = feature.regionMaskMode === 'exclude'
    fill = excludeRegion ? canvasRgba('featureRegionStroke', 0.10) : p.featureRegionFill
    stroke = excludeRegion ? p.featureRegionExcludeStroke : p.featureRegionStroke
    lineDash = excludeRegion ? [7, 5] : []
  }

  if (construction) {
    stroke = p.featureConstructionStroke
  }

  if (groupSelected) {
    fill = p.featureGroupFill
    stroke = p.featureGroupStroke
  }

  if (hovered) {
    fill = hexToRgba(p.draft, 0.35)
    stroke = p.draft
  }

  if (selected) {
    fill = hexToRgba(p.active, 0.45)
    stroke = p.active
  }

  if (editing) {
    fill = hexToRgba(p.activeStrong, 0.30)
    stroke = p.activeStrong
  }

  if (feature.operation === 'subtract' && !selected && !hovered && !editing) {
    // Base RGB mirrors featureCutFill (78, 126, 170); vary G/B by depth.
    // Deepen the cut fill with depth, shifted from the themed base colour.
    const base = parseRgb(p.featureCutFill)
    const g = Math.round(base.g - 45 * depthWeight)
    const b = Math.round(base.b + 35 * depthWeight)
    fill = `rgba(${base.r}, ${g}, ${b}, 0.44)`
  }

  const profiles = getFeatureGeometryProfiles(feature)
  for (const profile of profiles) {
    traceProfilePath(ctx, profile, vt)
    if (profile.closed && featureUsesSketchFill(feature.operation)) {
      ctx.fillStyle = fill
      ctx.fill()
    }

    ctx.strokeStyle = stroke
    ctx.lineWidth = construction
      ? editing || selected ? 1.8 : 1.2
      : editing || selected ? 2.5 : 1.8
    ctx.setLineDash(construction ? [6, 4] : lineDash)
    ctx.stroke()
    ctx.setLineDash([])
  }

  if (showInfo) {
    drawFeatureInfo(ctx, feature, vt, units)
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
    ctx.fillStyle = hexToRgba(canvasColors().draft, 0.18)
    ctx.fill()
  }
  ctx.setLineDash([8, 5])
  ctx.strokeStyle = canvasColors().draft
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

  ctx.fillStyle = hexToRgba(canvasColors().draftStrong, 0.95)
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
  const p = canvasColors()
  const strokeColor = highlighted ? p.activeStrong : p.draft
  const fillColor = highlighted ? canvasRgba('activeStrong', 0.28) : hexToRgba(p.draft, 0.25)
  const crossColor = highlighted ? canvasRgba('draftStrong', 0.95) : hexToRgba(p.draft, 0.9)

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
  color = hexToRgba(canvasColors().draft, 0.75),
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
  strokeColor = canvasColors().draft,
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
    ctx.fillStyle = isStart ? hexToRgba(canvasColors().draft, 0.32) : canvasColors().vertexFill
    ctx.fill()
    ctx.strokeStyle = isCloseTarget ? canvasColors().draftStrong : isStart ? canvasColors().draft : canvasColors().vertexStroke
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
  strokeColor = canvasColors().draft,
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
    ctx.fillStyle = isStart ? hexToRgba(canvasColors().draft, 0.32) : canvasColors().vertexFill
    ctx.fill()
    ctx.strokeStyle = isCloseTarget ? canvasColors().draftStrong : isStart ? canvasColors().draft : canvasColors().vertexStroke
    ctx.lineWidth = 2
    ctx.stroke()
  }
}

/** Map a DIAG source tag to a fill colour. Allowlisted diagnostics — not themeable. */
function sourceMarkerColor(source: string): string {
  if (source.includes('tryDirectLink'))   return '#ff6b35'   // theme-exempt: debug legend
  if (source.includes('bridgeSplitArms'))  return '#ff6b6b'  // theme-exempt: debug legend
  if (source.includes('siblingBridge'))   return '#ffd93d'   // theme-exempt: debug legend
  if (source.includes('sameChildBridge')) return '#00f2ff'   // theme-exempt: debug legend
  if (source.includes('bootstrap'))       return '#6bcb77'   // theme-exempt: debug legend
  if (source.includes('stepArms'))        return '#4d96ff'   // theme-exempt: debug legend
  if (source.includes('intCornerBridge')) return '#ff8fab'   // theme-exempt: debug legend
  if (source.includes('contour'))         return '#c084fc'   // theme-exempt: debug legend
  if (source.includes('microContour'))    return '#a8a8a8'   // theme-exempt: debug legend
  return '#ffffff'  // theme-exempt: debug legend fallback
}

/**
 * Draw a small shape at (cx,cy) on the 2D canvas context.
 */
function drawSourceMarker(ctx: CanvasRenderingContext2D, cx: number, cy: number, shape: string, color: string, r: number): void {
  ctx.save()
  ctx.fillStyle = color
  ctx.strokeStyle = color
  ctx.lineWidth = Math.max(1.5, r * 0.2)
  ctx.beginPath()

  switch (shape) {
    case 'circle':
      ctx.arc(cx, cy, r, 0, Math.PI * 2)
      ctx.fill()
      break
    case 'diamond':
      ctx.moveTo(cx, cy - r)
      ctx.lineTo(cx + r, cy)
      ctx.lineTo(cx, cy + r)
      ctx.lineTo(cx - r, cy)
      ctx.closePath()
      ctx.fill()
      break
    case 'triangle-up':
      ctx.moveTo(cx, cy - r)
      ctx.lineTo(cx + r * 0.866, cy + r * 0.5)
      ctx.lineTo(cx - r * 0.866, cy + r * 0.5)
      ctx.closePath()
      ctx.fill()
      break
    case 'triangle-down':
      ctx.moveTo(cx, cy + r)
      ctx.lineTo(cx + r * 0.866, cy - r * 0.5)
      ctx.lineTo(cx - r * 0.866, cy - r * 0.5)
      ctx.closePath()
      ctx.fill()
      break
    case 'square':
      ctx.rect(cx - r, cy - r, r * 2, r * 2)
      ctx.fill()
      break
    case 'pentagon':
      for (let i = 0; i < 5; i++) {
        const a = (i * 2 * Math.PI) / 5 - Math.PI / 2
        const px = cx + r * Math.cos(a)
        const py = cy + r * Math.sin(a)
        if (i === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      }
      ctx.closePath()
      ctx.fill()
      break
    case 'x':
      ctx.moveTo(cx - r, cy - r)
      ctx.lineTo(cx + r, cy + r)
      ctx.moveTo(cx + r, cy - r)
      ctx.lineTo(cx - r, cy + r)
      ctx.stroke()
      break
    case 'star': {
      for (let i = 0; i < 10; i++) {
        const a = (i * Math.PI) / 5 - Math.PI / 2
        const radius = i % 2 === 0 ? r : r * 0.45
        const px = cx + radius * Math.cos(a)
        const py = cy + radius * Math.sin(a)
        if (i === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      }
      ctx.closePath()
      ctx.fill()
      break
    }
    case 'circle-outline':
      ctx.arc(cx, cy, r * 0.7, 0, Math.PI * 2)
      ctx.stroke()
      break
    default: // dot
      ctx.arc(cx, cy, r * 0.5, 0, Math.PI * 2)
      ctx.fill()
      break
  }

  ctx.restore()
}

export function drawToolpath(
  ctx: CanvasRenderingContext2D,
  toolpath: ToolpathResult,
  vt: ViewTransform,
  emphasized: boolean,
  visibility: ToolpathVisibility,
): void {
  const layers: Array<{
    kinds: ToolpathResult['moves'][number]['kind'][]
    stroke: string
    lineWidth: number
    dash: number[]
    visible: boolean
    horizontalOnly?: boolean
    retractOnly?: boolean
  }> = [
    { kinds: ['cut', 'lead_in', 'lead_out'], stroke: canvasColors().toolpathCut, lineWidth: 2.1, dash: [], visible: visibility.cuts },
    { kinds: ['rapid'], stroke: canvasColors().toolpathRapid, lineWidth: 1.3, dash: [8, 6], visible: visibility.rapids, horizontalOnly: true },
    { kinds: ['plunge'], stroke: canvasColors().toolpathPlunge, lineWidth: 1.5, dash: [3, 4], visible: visibility.plunges },
    { kinds: ['rapid'], stroke: canvasColors().toolpathRapid, lineWidth: 1.3, dash: [8, 6], visible: visibility.retractions, retractOnly: true },
  ]

  for (const layer of layers) {
    if (!layer.visible) continue

    let moves = toolpath.moves.filter((move) => layer.kinds.includes(move.kind))

    if (layer.horizontalOnly) {
      moves = moves.filter((move) => Math.abs(move.from.z - move.to.z) < 1e-9)
    }
    if (layer.retractOnly) {
      moves = moves.filter((move) => move.to.z > move.from.z + 1e-9)
    }

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

  // Collision warning overlay: segments that cross a clamp zone below required
  // clearance are re-drawn in red on top, regardless of layer visibility.
  if (toolpath.collidingMoveIndices && toolpath.collidingMoveIndices.length > 0) {
    ctx.beginPath()
    for (const index of toolpath.collidingMoveIndices) {
      const move = toolpath.moves[index]
      if (!move) continue
      const from = worldToCanvas({ x: move.from.x, y: move.from.y }, vt)
      const to = worldToCanvas({ x: move.to.x, y: move.to.y }, vt)
      ctx.moveTo(from.cx, from.cy)
      ctx.lineTo(to.cx, to.cy)
    }
    ctx.strokeStyle = canvasColors().toolpathCollision
    ctx.globalAlpha = emphasized ? 1 : 0.55
    ctx.lineWidth = emphasized ? 3 : 2.2
    ctx.setLineDash([])
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  if (!emphasized || !toolpath.bounds || !visibility.directions) {
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

    // Respect visibility toggles
    if (move.kind === 'cut' && !visibility.cuts) continue
    if (move.kind === 'rapid') {
      const isRetraction = move.to.z > move.from.z + 1e-9
      if (isRetraction && !visibility.retractions) continue
      if (!isRetraction && !visibility.rapids) continue
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
      move.kind === 'rapid' ? canvasRgba('toolpathRapid', 0.95) : canvasRgba('toolpathCut', 0.98),
    )
    distanceSinceLastArrowByKind[move.kind] = 0
  }

  // --- Debug source-tag markers (shown when the operation has debugToolpath enabled) ---
  if (toolpath.debugToolpath) {
    const markerR = Math.max(3.5, Math.min(9, span * vt.scale * 0.025))
    for (const move of toolpath.moves) {
      if (move.kind !== 'cut' || !move.source) continue
      const from = worldToCanvas({ x: move.from.x, y: move.from.y }, vt)
      const to = worldToCanvas({ x: move.to.x, y: move.to.y }, vt)
      const mx = (from.cx + to.cx) / 2
      const my = (from.cy + to.cy) / 2
      let shape = 'dot'
      if (move.source.includes('bridgeSplitArms'))   shape = 'circle'
      else if (move.source.includes('siblingBridge')) shape = 'diamond'
      else if (move.source.includes('sameChildBridge')) shape = 'triangle-down'
      else if (move.source.includes('bootstrap'))     shape = 'triangle-up'
      else if (move.source.includes('stepArms'))      shape = 'square'
      else if (move.source.includes('intCornerBridge')) shape = 'pentagon'
      else if (move.source.includes('contour'))       shape = 'x'
      else if (move.source.includes('tryDirectLink')) shape = 'star'
      else if (move.source.includes('microContour'))  shape = 'circle-outline'
      drawSourceMarker(ctx, mx, my, shape, sourceMarkerColor(move.source), markerR)
    }
  }
}

export function hexToRgba(hex: string, alpha: number): string {
  const normalized = hex.replace('#', '')
  if (normalized.length !== 6) return `rgba(136, 153, 170, ${alpha})` // theme-exempt: fallback for a malformed colour string

  const r = Number.parseInt(normalized.slice(0, 2), 16)
  const g = Number.parseInt(normalized.slice(2, 4), 16)
  const b = Number.parseInt(normalized.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export function drawPendingSlotAxis(
  ctx: CanvasRenderingContext2D,
  p1: Point,
  p2cursor: Point,
  vt: ViewTransform,
  units: 'mm' | 'inch',
): void {
  drawLineLengthMeasurement(ctx, p1, p2cursor, vt, units)
}

export function drawPendingSlotWidth(
  ctx: CanvasRenderingContext2D,
  p1: Point,
  p2: Point,
  cursorPoint: Point,
  vt: ViewTransform,
  units: 'mm' | 'inch',
): void {
  const axisX = p2.x - p1.x
  const axisY = p2.y - p1.y
  const axisLen = Math.hypot(axisX, axisY)
  const minWidth = units === 'mm' ? 6 : 0.25
  const width = axisLen > 1e-10
    ? Math.max(2 * Math.abs((cursorPoint.x - p1.x) * axisY - (cursorPoint.y - p1.y) * axisX) / axisLen, 0.001)
    : minWidth

  const profile = slotProfile(p1, p2, width)
  drawPreviewProfile(ctx, profile, vt, `W = ${formatLength(width, units)}`)
}

export function drawPendingNgon(
  ctx: CanvasRenderingContext2D,
  anchor: Point,
  cursorPoint: Point,
  sides: number,
  vt: ViewTransform,
  units: 'mm' | 'inch',
): void {
  const circumradius = Math.hypot(cursorPoint.x - anchor.x, cursorPoint.y - anchor.y)
  if (circumradius < 1e-10) return
  const firstVertexAngle = Math.atan2(cursorPoint.y - anchor.y, cursorPoint.x - anchor.x)
  const profile = ngonProfile(anchor.x, anchor.y, sides, circumradius, firstVertexAngle)
  drawPreviewProfile(ctx, profile, vt, `R = ${formatLength(circumradius, units)}`)
  drawLineLengthMeasurement(ctx, anchor, cursorPoint, vt, units)
}

export function drawPendingGear(
  ctx: CanvasRenderingContext2D,
  anchor: Point,
  cursorPoint: Point,
  params: GearCreationParams,
  vt: ViewTransform,
  units: 'mm' | 'inch',
): void {
  const outsideRadius = Math.hypot(cursorPoint.x - anchor.x, cursorPoint.y - anchor.y)
  if (outsideRadius < 1e-10) return
  try {
    const profile = buildGearProfile({
      ...params,
      center: anchor,
      outsideRadius,
    })
    drawPreviewProfile(ctx, profile, vt, `OD R = ${formatLength(outsideRadius, units)}`)
  } catch {
    // Invalid parameter combinations are surfaced in the workflow panel.
  }
  drawLineLengthMeasurement(ctx, anchor, cursorPoint, vt, units)
}

export function drawPendingRoundRect(
  ctx: CanvasRenderingContext2D,
  anchor: Point,
  cursorPoint: Point,
  corner: number,
  vt: ViewTransform,
  units: 'mm' | 'inch',
): void {
  const w = Math.abs(cursorPoint.x - anchor.x)
  const h = Math.abs(cursorPoint.y - anchor.y)
  const minDim = Math.max(w, h)
  if (minDim < 1e-10) return
  const profile = roundedRectProfile(anchor, cursorPoint, corner)
  const label = `W=${formatLength(w, units)}, H=${formatLength(h, units)}`
  drawPreviewProfile(ctx, profile, vt, label)
  drawLineLengthMeasurement(ctx, anchor, { x: anchor.x + w, y: anchor.y }, vt, units)
  drawLineLengthMeasurement(ctx, anchor, { x: anchor.x, y: anchor.y + h }, vt, units)
}

export function drawPendingChamferRect(
  ctx: CanvasRenderingContext2D,
  anchor: Point,
  cursorPoint: Point,
  corner: number,
  vt: ViewTransform,
  units: 'mm' | 'inch',
): void {
  const w = Math.abs(cursorPoint.x - anchor.x)
  const h = Math.abs(cursorPoint.y - anchor.y)
  const minDim = Math.max(w, h)
  if (minDim < 1e-10) return
  const profile = chamferedRectProfile(anchor, cursorPoint, corner)
  const label = `W=${formatLength(w, units)}, H=${formatLength(h, units)}`
  drawPreviewProfile(ctx, profile, vt, label)
  drawLineLengthMeasurement(ctx, anchor, { x: anchor.x + w, y: anchor.y }, vt, units)
  drawLineLengthMeasurement(ctx, anchor, { x: anchor.x, y: anchor.y + h }, vt, units)
}
