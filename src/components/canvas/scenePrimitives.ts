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

import type { SketchControlRef } from '../../store/types'
import { getProfileBounds, getStockBounds, profileVertices, rectProfile } from '../../types/project'
import type { BackdropImage, Bounds2D, Clamp, GridSettings, Point, SketchProfile, Stock, Tab } from '../../types/project'
import type { ResolvedSketchFeature } from '../../store/helpers/resolveFeatures'
import type { Units } from '../../utils/units'
import { formatLength } from '../../utils/units'
import { hexToRgba } from './previewPrimitives'
import { arcControlPoint, anchorPointForIndex, traceProfilePath } from './profilePrimitives'
import { worldToCanvas } from './viewTransform'
import type { ViewTransform } from './viewTransform'
import type { CanvasThemePalette } from '../../theme/palette'

const NODE_RADIUS = 5
const HANDLE_RADIUS = 4

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

export function drawSketchControls(
  ctx: CanvasRenderingContext2D,
  profile: SketchProfile,
  vt: ViewTransform,
  activeControl: SketchControlRef | null,
  palette: CanvasThemePalette,
): void {
  const vertices = profileVertices(profile)

  if (activeControl?.kind === 'segment') {
    const segment = profile.segments[activeControl.index]
    if (segment?.type === 'line') {
      const start = worldToCanvas(anchorPointForIndex(profile, activeControl.index), vt)
      const end = worldToCanvas(segment.to, vt)
      ctx.beginPath()
      ctx.moveTo(start.cx, start.cy)
      ctx.lineTo(end.cx, end.cy)
      ctx.strokeStyle = '#f7d394'
      ctx.lineWidth = 5
      ctx.lineCap = 'round'
      ctx.stroke()

      ctx.beginPath()
      ctx.moveTo(start.cx, start.cy)
      ctx.lineTo(end.cx, end.cy)
      ctx.strokeStyle = '#f2b95c'
      ctx.lineWidth = 3
      ctx.lineCap = 'round'
      ctx.stroke()
    }
  }

  for (let index = 0; index < profile.segments.length; index += 1) {
    const anchor = worldToCanvas(anchorPointForIndex(profile, index), vt)
    const outgoingSegment = profile.segments[index]
    const incomingSegment =
      profile.closed
        ? profile.segments[(index - 1 + profile.segments.length) % profile.segments.length]
        : index > 0
          ? profile.segments[index - 1]
          : null

    if (outgoingSegment.type === 'bezier') {
      const handle = worldToCanvas(outgoingSegment.control1, vt)
      ctx.beginPath()
      ctx.moveTo(anchor.cx, anchor.cy)
      ctx.lineTo(handle.cx, handle.cy)
      ctx.strokeStyle = 'rgba(125, 159, 189, 0.55)'
      ctx.lineWidth = 1
      ctx.stroke()
    }

    if (incomingSegment?.type === 'bezier') {
      const handle = worldToCanvas(incomingSegment.control2, vt)
      ctx.beginPath()
      ctx.moveTo(anchor.cx, anchor.cy)
      ctx.lineTo(handle.cx, handle.cy)
      ctx.strokeStyle = 'rgba(125, 159, 189, 0.55)'
      ctx.lineWidth = 1
      ctx.stroke()
    }
  }

  // Native Circle special rendering
  if (profile.segments.length === 1 && profile.segments[0].type === 'circle') {
    const seg = profile.segments[0]
    const center = worldToCanvas(seg.center, vt)
    const radius = Math.hypot(profile.start.x - seg.center.x, profile.start.y - seg.center.y) * vt.scale

    const startAngle = Math.atan2(profile.start.y - seg.center.y, profile.start.x - seg.center.x)
    const endAngle = startAngle + (seg.clockwise ? -Math.PI * 2 : Math.PI * 2)

    // Dashed outline
    ctx.beginPath()
    ctx.arc(center.cx, center.cy, radius, startAngle, endAngle, seg.clockwise)
    ctx.setLineDash([5, 5])
    ctx.strokeStyle = palette.mutedGeometry
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.setLineDash([])

    // Center crosshair
    const active = activeControl?.kind === 'circle_center' && activeControl.index === 0
    const crossSize = active ? 8 : 6
    ctx.beginPath()
    ctx.moveTo(center.cx - crossSize, center.cy)
    ctx.lineTo(center.cx + crossSize, center.cy)
    ctx.moveTo(center.cx, center.cy - crossSize)
    ctx.lineTo(center.cx, center.cy + crossSize)
    ctx.strokeStyle = active ? '#f2b95c' : palette.mutedGeometry
    ctx.lineWidth = active ? 2 : 1.2
    ctx.stroke()
  }

  for (let index = 0; index < vertices.length; index += 1) {
    const vertex = vertices[index]
    const { cx, cy } = worldToCanvas(vertex, vt)
    const active = activeControl?.kind === 'anchor' && activeControl.index === index

    ctx.beginPath()
    ctx.arc(cx, cy, active ? NODE_RADIUS + 2 : NODE_RADIUS, 0, Math.PI * 2)
    ctx.fillStyle = active ? '#f2b95c' : palette.mutedGeometry
    ctx.fill()
    ctx.strokeStyle = active ? '#f7d394' : '#3f708f'
    ctx.lineWidth = 2
    ctx.stroke()
  }

  for (let index = 0; index < profile.segments.length; index += 1) {
    const segment = profile.segments[index]
    if (segment.type !== 'arc') {
      continue
    }

    const start = anchorPointForIndex(profile, index)
    const control = worldToCanvas(arcControlPoint(start, segment), vt)
    const active = activeControl?.kind === 'arc_handle' && activeControl.index === index
    drawDiamond(ctx, control.cx, control.cy, active ? HANDLE_RADIUS + 1.5 : HANDLE_RADIUS)
    ctx.fillStyle = active ? '#f2b95c' : '#9bc0dd'
    ctx.fill()
    ctx.strokeStyle = active ? '#f7d394' : '#6f8fa9'
    ctx.lineWidth = 1.5
    ctx.stroke()
  }

  for (let index = 0; index < profile.segments.length; index += 1) {
    const outgoingSegment = profile.segments[index]
    const incomingSegment =
      profile.closed
        ? profile.segments[(index - 1 + profile.segments.length) % profile.segments.length]
        : index > 0
          ? profile.segments[index - 1]
          : null

    if (outgoingSegment.type === 'bezier') {
      const point = worldToCanvas(outgoingSegment.control1, vt)
      const active = activeControl?.kind === 'out_handle' && activeControl.index === index
      drawDiamond(ctx, point.cx, point.cy, active ? HANDLE_RADIUS + 1.5 : HANDLE_RADIUS)
      ctx.fillStyle = active ? '#f2b95c' : '#9bc0dd'
      ctx.fill()
      ctx.strokeStyle = active ? '#f7d394' : '#6f8fa9'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }

    if (incomingSegment?.type === 'bezier') {
      const point = worldToCanvas(incomingSegment.control2, vt)
      const active = activeControl?.kind === 'in_handle' && activeControl.index === index
      drawDiamond(ctx, point.cx, point.cy, active ? HANDLE_RADIUS + 1.5 : HANDLE_RADIUS)
      ctx.fillStyle = active ? '#f2b95c' : '#9bc0dd'
      ctx.fill()
      ctx.strokeStyle = active ? '#f7d394' : '#6f8fa9'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
  }
}

export function drawSketchEditPreviewPoint(
  ctx: CanvasRenderingContext2D,
  preview: { point: Point; mode: 'add_point' | 'delete_point' | 'delete_segment' | 'disconnect' | 'fillet' | 'chamfer' | 'trim' | 'extend' },
  vt: ViewTransform,
): void {
  const { cx, cy } = worldToCanvas(preview.point, vt)
  ctx.beginPath()
  ctx.arc(cx, cy, NODE_RADIUS + 2, 0, Math.PI * 2)
  const destructive = preview.mode === 'delete_point' || preview.mode === 'delete_segment'
  ctx.fillStyle = destructive ? '#d66c6c' : preview.mode === 'disconnect' ? '#d9945e' : '#5daeea'
  ctx.fill()
  ctx.strokeStyle = destructive ? '#efb0b0' : preview.mode === 'disconnect' ? '#f1c59d' : '#a9d2f5'
  ctx.lineWidth = 2
  ctx.stroke()
}

/**
 * Compute the union bounding box of all resolved feature world-space profiles.
 * Returns `null` when there are no features whose bounds should affect the grid.
 * Skips invisible features.
 */
export function getFeaturesWorldBounds(
  features: ResolvedSketchFeature[],
): Bounds2D | null {
  let bounds: Bounds2D | null = null

  for (const feature of features) {
    if (!feature.visible) continue

    const profileBounds = getProfileBounds(feature.sketch.profile)

    if (!bounds) {
      bounds = { ...profileBounds }
    } else {
      if (profileBounds.minX < bounds.minX) bounds.minX = profileBounds.minX
      if (profileBounds.maxX > bounds.maxX) bounds.maxX = profileBounds.maxX
      if (profileBounds.minY < bounds.minY) bounds.minY = profileBounds.minY
      if (profileBounds.maxY > bounds.maxY) bounds.maxY = profileBounds.maxY
    }
  }

  return bounds
}

export function drawGrid(
  ctx: CanvasRenderingContext2D,
  vt: ViewTransform,
  canvasW: number,
  canvasH: number,
  stock: Stock,
  grid: GridSettings,
  palette: CanvasThemePalette,
  featureWorldBounds?: Bounds2D | null,
): void {
  if (!grid.visible) return

  const bounds = getStockBounds(stock)
  const centerX = bounds.minX + (bounds.maxX - bounds.minX) / 2
  const centerY = bounds.minY + (bounds.maxY - bounds.minY) / 2
  const defaultHalfExtent = Math.max(grid.extent / 2, 10)
  let halfExtent = defaultHalfExtent

  // Dynamically extend the grid to cover feature geometry on all sides.
  if (featureWorldBounds) {
    const toLeft = Math.abs(featureWorldBounds.minX - centerX)
    const toRight = Math.abs(featureWorldBounds.maxX - centerX)
    const toTop = Math.abs(featureWorldBounds.minY - centerY)
    const toBottom = Math.abs(featureWorldBounds.maxY - centerY)
    const neededReach = Math.max(toLeft, toRight, toTop, toBottom)
    const padding = grid.majorSpacing
    halfExtent = Math.max(defaultHalfExtent, neededReach + padding)
  }
  const minX = centerX - halfExtent
  const maxX = centerX + halfExtent
  const minY = centerY - halfExtent
  const maxY = centerY + halfExtent
  const minorSpacing = Math.max(grid.minorSpacing, 0.0001)
  const majorSpacing = Math.max(grid.majorSpacing, minorSpacing)
  const startX = Math.floor(minX / minorSpacing) * minorSpacing
  const endX = Math.ceil(maxX / minorSpacing) * minorSpacing
  const startY = Math.floor(minY / minorSpacing) * minorSpacing
  const endY = Math.ceil(maxY / minorSpacing) * minorSpacing
  const tolerance = minorSpacing * 0.001

  for (let x = startX; x <= endX + tolerance; x += minorSpacing) {
    const normalized = Math.abs(x / majorSpacing - Math.round(x / majorSpacing))
    const isMajor = normalized < tolerance / Math.max(majorSpacing, 1)
    const p0 = worldToCanvas({ x, y: minY }, vt)
    const p1 = worldToCanvas({ x, y: maxY }, vt)
    ctx.beginPath()
    ctx.moveTo(p0.cx, 0)
    ctx.lineTo(p1.cx, canvasH)
    ctx.strokeStyle = isMajor ? palette.gridMajor : palette.gridMinor
    ctx.lineWidth = isMajor ? 1.2 : 1
    ctx.stroke()
  }

  for (let y = startY; y <= endY + tolerance; y += minorSpacing) {
    const normalized = Math.abs(y / majorSpacing - Math.round(y / majorSpacing))
    const isMajor = normalized < tolerance / Math.max(majorSpacing, 1)
    const p0 = worldToCanvas({ x: minX, y }, vt)
    const p1 = worldToCanvas({ x: maxX, y }, vt)
    ctx.beginPath()
    ctx.moveTo(0, p0.cy)
    ctx.lineTo(canvasW, p1.cy)
    ctx.strokeStyle = isMajor ? palette.gridMajor : palette.gridMinor
    ctx.lineWidth = isMajor ? 1.2 : 1
    ctx.stroke()
  }
}

const STOCK_LABEL_MIN_WIDTH_PX = 200
const STOCK_EXCEEDED_STROKE = 'rgba(240, 160, 40, 0.9)'

/** A hit-testable rectangle for a stock dimension label. */
export interface StockLabelRect {
  axis: 'width' | 'height'
  cx: number
  cy: number
  halfW: number
  halfH: number
}

function drawStockDimensionLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  palette: CanvasThemePalette,
): void {
  ctx.font = '11px sans-serif'
  const metrics = ctx.measureText(text)
  const halfW = metrics.width / 2 + 4
  const halfH = 9
  ctx.fillStyle = palette.labelBackground
  ctx.fillRect(cx - halfW, cy - halfH, halfW * 2, halfH * 2)
  ctx.fillStyle = palette.labelText
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, cx, cy)
}

export function drawStockOutline(
  ctx: CanvasRenderingContext2D,
  stock: Stock,
  vt: ViewTransform,
  units: Units,
  exceeded: boolean,
  palette: CanvasThemePalette,
  stockLabelRects?: StockLabelRect[],
): void {
  traceProfilePath(ctx, stock.profile, vt)
  ctx.strokeStyle = exceeded ? STOCK_EXCEEDED_STROKE : hexToRgba(stock.color, 0.7)
  ctx.lineWidth = 2
  ctx.setLineDash([7, 4])
  ctx.stroke()
  ctx.setLineDash([])

  traceProfilePath(ctx, stock.profile, vt)
  ctx.fillStyle = hexToRgba(stock.color, 0.12)
  ctx.fill()

  const bounds = getStockBounds(stock)
  const widthWorld = bounds.maxX - bounds.minX
  const heightWorld = bounds.maxY - bounds.minY
  if (widthWorld * vt.scale < STOCK_LABEL_MIN_WIDTH_PX) {
    return
  }

  const cornerA = worldToCanvas({ x: bounds.minX, y: bounds.minY }, vt)
  const cornerB = worldToCanvas({ x: bounds.maxX, y: bounds.maxY }, vt)
  const minCx = Math.min(cornerA.cx, cornerB.cx)
  const maxCx = Math.max(cornerA.cx, cornerB.cx)
  const minCy = Math.min(cornerA.cy, cornerB.cy)
  const maxCy = Math.max(cornerA.cy, cornerB.cy)
  const unitSuffix = units === 'inch' ? 'in' : 'mm'

  ctx.save()
  const widthLabelText = `${formatLength(widthWorld, units)} ${unitSuffix}`
  const heightLabelText = `${formatLength(heightWorld, units)} ${unitSuffix}`
  const widthCx = (minCx + maxCx) / 2
  const widthCy = minCy - 12
  drawStockDimensionLabel(
    ctx,
    widthLabelText,
    widthCx,
    widthCy,
    palette,
  )
  const heightCx = maxCx + 8 + ctx.measureText(heightLabelText).width / 2
  const heightCy = (minCy + maxCy) / 2
  drawStockDimensionLabel(
    ctx,
    heightLabelText,
    heightCx,
    heightCy,
    palette,
  )
  ctx.restore()

  // Record hit rects for click-to-edit
  if (stockLabelRects) {
    const labelFont = '11px sans-serif'
    ctx.font = labelFont
    const wMetrics = ctx.measureText(widthLabelText)
    const hMetrics = ctx.measureText(heightLabelText)
    stockLabelRects.push({
      axis: 'width',
      cx: widthCx,
      cy: widthCy,
      halfW: wMetrics.width / 2 + 4,
      halfH: 9,
    })
    stockLabelRects.push({
      axis: 'height',
      cx: heightCx,
      cy: heightCy,
      halfW: hMetrics.width / 2 + 4,
      halfH: 9,
    })
  }
}

export function drawClampFootprint(
  ctx: CanvasRenderingContext2D,
  clamp: Clamp,
  vt: ViewTransform,
  selected: boolean,
  colliding: boolean,
): void {
  const profile = rectProfile(clamp.x, clamp.y, clamp.w, clamp.h)
  traceProfilePath(ctx, profile, vt)
  ctx.fillStyle = colliding
    ? (selected ? 'rgba(209, 118, 118, 0.28)' : 'rgba(184, 98, 98, 0.18)')
    : (selected ? 'rgba(118, 144, 209, 0.24)' : 'rgba(86, 110, 168, 0.14)')
  ctx.fill()
  ctx.strokeStyle = colliding
    ? (selected ? '#ffb0b0' : 'rgba(235, 122, 122, 0.92)')
    : (selected ? '#9db9ff' : 'rgba(122, 151, 224, 0.88)')
  ctx.lineWidth = selected ? 2.2 : 1.6
  ctx.setLineDash([6, 4])
  ctx.stroke()
  ctx.setLineDash([])
}

export function drawTabFootprint(
  ctx: CanvasRenderingContext2D,
  tab: Tab,
  vt: ViewTransform,
  selected: boolean,
): void {
  const profile = rectProfile(tab.x, tab.y, tab.w, tab.h)
  traceProfilePath(ctx, profile, vt)
  ctx.fillStyle = selected ? 'rgba(168, 208, 110, 0.24)' : 'rgba(128, 175, 82, 0.14)'
  ctx.fill()
  ctx.strokeStyle = selected ? '#c7ef94' : 'rgba(156, 205, 103, 0.88)'
  ctx.lineWidth = selected ? 2.2 : 1.6
  ctx.setLineDash([6, 4])
  ctx.stroke()
  ctx.setLineDash([])
}

export function drawOriginMarker(
  ctx: CanvasRenderingContext2D,
  origin: { x: number; y: number; name: string },
  vt: ViewTransform,
  palette: CanvasThemePalette,
): void {
  const anchor = worldToCanvas({ x: origin.x, y: origin.y }, vt)
  const axisLength = 20

  ctx.save()
  ctx.lineCap = 'round'

  ctx.beginPath()
  ctx.moveTo(anchor.cx, anchor.cy)
  ctx.lineTo(anchor.cx + axisLength, anchor.cy)
  ctx.strokeStyle = '#e35b5b'
  ctx.lineWidth = 2
  ctx.stroke()

  ctx.beginPath()
  ctx.moveTo(anchor.cx + axisLength, anchor.cy)
  ctx.lineTo(anchor.cx + axisLength - 6, anchor.cy - 3)
  ctx.lineTo(anchor.cx + axisLength - 6, anchor.cy + 3)
  ctx.closePath()
  ctx.fillStyle = '#e35b5b'
  ctx.fill()

  ctx.beginPath()
  ctx.moveTo(anchor.cx, anchor.cy)
  ctx.lineTo(anchor.cx, anchor.cy - axisLength)
  ctx.strokeStyle = '#63c07a'
  ctx.lineWidth = 2
  ctx.stroke()

  ctx.beginPath()
  ctx.moveTo(anchor.cx, anchor.cy - axisLength)
  ctx.lineTo(anchor.cx - 3, anchor.cy - axisLength + 6)
  ctx.lineTo(anchor.cx + 3, anchor.cy - axisLength + 6)
  ctx.closePath()
  ctx.fillStyle = '#63c07a'
  ctx.fill()

  ctx.beginPath()
  ctx.arc(anchor.cx, anchor.cy, 4, 0, Math.PI * 2)
  ctx.fillStyle = '#5b90e3'
  ctx.fill()
  ctx.strokeStyle = palette.labelText
  ctx.lineWidth = 1.5
  ctx.stroke()

  ctx.font = '10px "IBM Plex Mono", "SFMono-Regular", Consolas, monospace'
  ctx.fillStyle = '#e35b5b'
  ctx.fillText('X', anchor.cx + axisLength + 4, anchor.cy + 3)
  ctx.fillStyle = '#63c07a'
  ctx.fillText('Y', anchor.cx - 3, anchor.cy - axisLength - 4)

  ctx.fillStyle = palette.labelText
  ctx.fillText(origin.name, anchor.cx + 10, anchor.cy - 8)
  ctx.restore()
}

function backdropRotationRadians(backdrop: BackdropImage): number {
  return ((backdrop.orientationAngle ?? 90) - 90) * (Math.PI / 180)
}

export function drawBackdropImage(
  ctx: CanvasRenderingContext2D,
  backdrop: BackdropImage,
  image: HTMLImageElement,
  vt: ViewTransform,
  selected: boolean,
  palette: CanvasThemePalette,
  label = 'Backdrop',
): void {
  const center = worldToCanvas(backdrop.center, vt)
  const width = backdrop.width * vt.scale
  const height = backdrop.height * vt.scale
  const rotation = backdropRotationRadians(backdrop)

  ctx.save()
  ctx.translate(center.cx, center.cy)
  ctx.rotate(rotation)
  ctx.globalAlpha = Math.min(Math.max(backdrop.opacity, 0), 1)
  ctx.drawImage(image, -width / 2, -height / 2, width, height)
  ctx.restore()

  if (selected) {
    ctx.save()
    ctx.translate(center.cx, center.cy)
    ctx.rotate(rotation)
    ctx.beginPath()
    ctx.rect(-width / 2, -height / 2, width, height)
    ctx.strokeStyle = '#efbc7a'
    ctx.lineWidth = 2
    ctx.setLineDash([8, 5])
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = 'rgba(239, 188, 122, 0.06)'
    ctx.fill()
    ctx.restore()

    ctx.fillStyle = palette.labelBackground
    ctx.fillRect(center.cx - 38, center.cy - 14, 76, 18)
    ctx.fillStyle = palette.labelText
    ctx.font = '11px monospace'
    ctx.textAlign = 'center'
    ctx.fillText(label, center.cx, center.cy - 1)
  }
}

export function hitBackdrop(point: Point, backdrop: BackdropImage): boolean {
  const angle = -backdropRotationRadians(backdrop)
  const local = {
    x: point.x - backdrop.center.x,
    y: point.y - backdrop.center.y,
  }
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const rotated = {
    x: local.x * cos - local.y * sin,
    y: local.x * sin + local.y * cos,
  }

  return (
    Math.abs(rotated.x) <= backdrop.width / 2
    && Math.abs(rotated.y) <= backdrop.height / 2
  )
}
