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
import type { BackdropImage, BarStock, Bounds2D, Clamp, GridSettings, Point, Project, SketchProfile, Stock, Tab } from '../../types/project'
import { barCentre, isBarStock } from '../../types/barStock'
import type { ResolvedSketchFeature } from '../../store/helpers/resolveFeatures'
import type { Units } from '../../utils/units'
import { formatLength } from '../../utils/units'
import { hexToRgba } from './previewPrimitives'
import type { AroundSheet } from './aroundSheet'
import { arcControlPoint, anchorPointForIndex, traceProfilePath } from './profilePrimitives'
import { applyViewMirror, worldArcToCanvas, worldToCanvas } from './viewTransform'
import type { ViewTransform } from './viewTransform'
import type { CanvasThemePalette } from '../../theme/palette'
import { canvasColors } from './canvasPalette'
import { expandedClampBounds, worstCaseClampCheckToolRadius } from '../../engine/toolpaths/clamps'

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
      ctx.strokeStyle = palette.activeStrong
      ctx.lineWidth = 5
      ctx.lineCap = 'round'
      ctx.stroke()

      ctx.beginPath()
      ctx.moveTo(start.cx, start.cy)
      ctx.lineTo(end.cx, end.cy)
      ctx.strokeStyle = palette.active
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
      ctx.strokeStyle = canvasColors().handleGuide
      ctx.lineWidth = 1
      ctx.stroke()
    }

    if (incomingSegment?.type === 'bezier') {
      const handle = worldToCanvas(incomingSegment.control2, vt)
      ctx.beginPath()
      ctx.moveTo(anchor.cx, anchor.cy)
      ctx.lineTo(handle.cx, handle.cy)
      ctx.strokeStyle = canvasColors().handleGuide
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
    ctx.arc(center.cx, center.cy, radius, ...worldArcToCanvas(startAngle, endAngle, seg.clockwise, vt))
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
    ctx.strokeStyle = active ? palette.active : palette.mutedGeometry
    ctx.lineWidth = active ? 2 : 1.2
    ctx.stroke()
  }

  for (let index = 0; index < vertices.length; index += 1) {
    const vertex = vertices[index]
    const { cx, cy } = worldToCanvas(vertex, vt)
    const active = activeControl?.kind === 'anchor' && activeControl.index === index

    ctx.beginPath()
    ctx.arc(cx, cy, active ? NODE_RADIUS + 2 : NODE_RADIUS, 0, Math.PI * 2)
    ctx.fillStyle = active ? palette.active : palette.mutedGeometry
    ctx.fill()
    ctx.strokeStyle = active ? palette.activeStrong : canvasColors().nodeStroke
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
    ctx.fillStyle = active ? palette.active : canvasColors().handleFill
    ctx.fill()
    ctx.strokeStyle = active ? palette.activeStrong : canvasColors().handleStroke
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
      ctx.fillStyle = active ? palette.active : canvasColors().handleFill
      ctx.fill()
      ctx.strokeStyle = active ? palette.activeStrong : canvasColors().handleStroke
      ctx.lineWidth = 1.5
      ctx.stroke()
    }

    if (incomingSegment?.type === 'bezier') {
      const point = worldToCanvas(incomingSegment.control2, vt)
      const active = activeControl?.kind === 'in_handle' && activeControl.index === index
      drawDiamond(ctx, point.cx, point.cy, active ? HANDLE_RADIUS + 1.5 : HANDLE_RADIUS)
      ctx.fillStyle = active ? palette.active : canvasColors().handleFill
      ctx.fill()
      ctx.strokeStyle = active ? palette.activeStrong : canvasColors().handleStroke
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
  }
}

/**
 * A canned ellipse's two radius handles (issue #1112 slice w3e-a). The shape is
 * committed geometry, not an editable sketch, so the handles are drawn against
 * the placed axes: a dashed radius from the placed centre to each axis end and
 * a diamond at that end, the same marker an arc handle uses.
 */
export function drawEllipseRadiusHandles(
  ctx: CanvasRenderingContext2D,
  centre: Point,
  handles: readonly { axis: 'rx' | 'ry'; world: Point }[],
  vt: ViewTransform,
  activeAxis: 'rx' | 'ry' | null,
  palette: CanvasThemePalette,
): void {
  const centreCanvas = worldToCanvas(centre, vt)

  ctx.save()
  for (const handle of handles) {
    const point = worldToCanvas(handle.world, vt)
    ctx.beginPath()
    ctx.moveTo(centreCanvas.cx, centreCanvas.cy)
    ctx.lineTo(point.cx, point.cy)
    ctx.strokeStyle = canvasColors().handleGuide
    ctx.lineWidth = 1
    ctx.setLineDash([4, 4])
    ctx.stroke()
    ctx.setLineDash([])
  }

  // The placed centre, so a rotated ellipse's handles read as its own axes.
  const crossSize = activeAxis ? 8 : 6
  ctx.beginPath()
  ctx.moveTo(centreCanvas.cx - crossSize, centreCanvas.cy)
  ctx.lineTo(centreCanvas.cx + crossSize, centreCanvas.cy)
  ctx.moveTo(centreCanvas.cx, centreCanvas.cy - crossSize)
  ctx.lineTo(centreCanvas.cx, centreCanvas.cy + crossSize)
  ctx.strokeStyle = activeAxis ? palette.active : palette.mutedGeometry
  ctx.lineWidth = activeAxis ? 2 : 1.2
  ctx.stroke()

  for (const handle of handles) {
    const point = worldToCanvas(handle.world, vt)
    const active = handle.axis === activeAxis
    drawDiamond(ctx, point.cx, point.cy, active ? HANDLE_RADIUS + 1.5 : HANDLE_RADIUS)
    ctx.fillStyle = active ? palette.active : canvasColors().handleFill
    ctx.fill()
    ctx.strokeStyle = active ? palette.activeStrong : canvasColors().handleStroke
    ctx.lineWidth = 1.5
    ctx.stroke()
  }
  ctx.restore()
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
  ctx.fillStyle = destructive ? canvasColors().editDeleteFill : preview.mode === 'disconnect' ? canvasColors().editDisconnectFill : canvasColors().editAddFill
  ctx.fill()
  ctx.strokeStyle = destructive ? canvasColors().editDeleteStroke : preview.mode === 'disconnect' ? canvasColors().editDisconnectStroke : canvasColors().editAddStroke
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
function stockExceededStroke(): string { return canvasColors().stockExceeded }

/** A hit-testable rectangle for a stock dimension label. */
export interface StockLabelRect {
  axis: 'width' | 'height'
  cx: number
  cy: number
  halfW: number
  halfH: number
}

/** The stock fields a dimension label reads. */
type DimensionLabelStock = Pick<Stock, 'shape'> & Partial<Pick<BarStock, 'axis'>>

/**
 * The stock's two dimension labels. A round bar's dimension **across** its
 * axis is a diameter and carries the Ø on that side only; the along dimension
 * is a plain length. A square blank's cross dimension is its side, never a
 * diameter, so it carries no Ø (#1016 C2-U1V); a block, which has no bar axis,
 * is plain on both sides.
 */
export function barDimensionLabels(
  stock: DimensionLabelStock,
  width: number,
  height: number,
  units: Units,
): { width: string; height: string } {
  const unitSuffix = units === 'inch' ? 'in' : 'mm'
  const barAxis = stock.shape === 'round' ? stock.axis : null
  return {
    width: `${barAxis === 'y' ? 'Ø' : ''}${formatLength(width, units)} ${unitSuffix}`,
    height: `${barAxis === 'x' ? 'Ø' : ''}${formatLength(height, units)} ${unitSuffix}`,
  }
}

/**
 * The line a bar turns about, down its whole length, or null for a block. A
 * round bar and a square blank turn about the same true pivot — the box centre
 * — so both answer the same centreline (#1016 C2-U1V).
 */
export function barCentreline(stock: Stock): { from: Point; to: Point } | null {
  if (!isBarStock(stock)) return null
  const bounds = getStockBounds(stock)
  const centre = barCentre(stock)
  return stock.axis === 'x'
    ? { from: { x: bounds.minX, y: centre }, to: { x: bounds.maxX, y: centre } }
    : { from: { x: centre, y: bounds.minY }, to: { x: centre, y: bounds.maxY } }
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
  ctx.strokeStyle = exceeded ? stockExceededStroke() : hexToRgba(stock.color, 0.7)
  ctx.lineWidth = 2
  ctx.setLineDash([7, 4])
  ctx.stroke()
  ctx.setLineDash([])

  traceProfilePath(ctx, stock.profile, vt)
  ctx.fillStyle = hexToRgba(stock.color, 0.12)
  ctx.fill()

  const bounds = getStockBounds(stock)

  const centreline = barCentreline(stock)
  if (centreline) {
    // The centreline the bar turns about, dash-dot down its whole length: the
    // same line for a round bar and a square blank, both turning about their
    // box centre at the true pivot (#1016 C2-U1V).
    const from = worldToCanvas(centreline.from, vt)
    const to = worldToCanvas(centreline.to, vt)
    ctx.strokeStyle = exceeded ? stockExceededStroke() : hexToRgba(stock.color, 0.7)
    ctx.lineWidth = 1
    ctx.setLineDash([8, 3, 2, 3])
    ctx.beginPath()
    ctx.moveTo(from.cx, from.cy)
    ctx.lineTo(to.cx, to.cy)
    ctx.stroke()
    ctx.setLineDash([])
  }

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
  const labels = barDimensionLabels(stock, widthWorld, heightWorld, units)
  const widthLabelText = labels.width
  const heightLabelText = labels.height

  ctx.save()
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

/**
 * A line across the unrolled sheet at every full turn (issue #395). `k = 0` is
 * the zero line — the top of the bar with the rotary at zero — and runs through
 * the middle of the sheet; it is drawn solid so it reads as the datum, and the
 * rest are dashed and faint. The two at k = ±1 lie on the sheet's edges, which
 * are the seam (the bottom of the bar, a = ±180°) since issue #1026.
 */
export function drawAroundTurnLines(
  ctx: CanvasRenderingContext2D,
  sheet: Pick<AroundSheet, 'axis' | 'along' | 'turnLines'>,
  vt: ViewTransform,
  stockColor: string,
): void {
  if (sheet.turnLines.length === 0) return
  ctx.save()
  for (const line of sheet.turnLines) {
    const from = sheet.axis === 'x'
      ? worldToCanvas({ x: sheet.along.min, y: line.across }, vt)
      : worldToCanvas({ x: line.across, y: sheet.along.min }, vt)
    const to = sheet.axis === 'x'
      ? worldToCanvas({ x: sheet.along.max, y: line.across }, vt)
      : worldToCanvas({ x: line.across, y: sheet.along.max }, vt)
    ctx.beginPath()
    ctx.moveTo(from.cx, from.cy)
    ctx.lineTo(to.cx, to.cy)
    ctx.strokeStyle = hexToRgba(stockColor, line.solid ? 0.6 : 0.3)
    ctx.lineWidth = line.solid ? 1.5 : 1
    ctx.setLineDash(line.solid ? [] : [5, 4])
    ctx.stroke()
  }
  ctx.restore()
}

/** The band label's type size, and the inset that keeps it off the band edge. */
const MODEL_BAND_LABEL_FONT = '11px "IBM Plex Mono", "SFMono-Regular", Consolas, monospace'
const MODEL_BAND_LABEL_LINE = 13
const MODEL_BAND_LABEL_PAD = 5

/**
 * The imported models machined inside the bar, as bands on the Around sheet
 * (issue #1015 slice K). The model's geometry lives inside the bar, so it can
 * neither be drawn nor selected there; a band at its extent along the bar, one
 * circumference across, is what tells the user where it is. The band is
 * reference only — never hit-tested, snapped to, or given a context menu.
 *
 * `label` names a model for the note drawn at the top-left of the part of the
 * band that is on screen. The note is left out when it does not fit that
 * visible part, so a short model does not get a label wider than the thing it
 * labels, and an off-screen band gets none at all.
 */
export function drawAroundModelBands(
  ctx: CanvasRenderingContext2D,
  sheet: Pick<AroundSheet, 'axis' | 'sheetStart' | 'circumference' | 'modelBands'>,
  vt: ViewTransform,
  label: (name: string) => string,
): void {
  if (sheet.modelBands.length === 0) return
  const palette = canvasColors()
  ctx.save()
  ctx.font = MODEL_BAND_LABEL_FONT
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  for (const band of sheet.modelBands) {
    const from = sheet.axis === 'x'
      ? worldToCanvas({ x: band.along.min, y: sheet.sheetStart }, vt)
      : worldToCanvas({ x: sheet.sheetStart, y: band.along.min }, vt)
    const to = sheet.axis === 'x'
      ? worldToCanvas({ x: band.along.max, y: sheet.sheetStart + sheet.circumference }, vt)
      : worldToCanvas({ x: sheet.sheetStart + sheet.circumference, y: band.along.max }, vt)
    const x = Math.min(from.cx, to.cx)
    const y = Math.min(from.cy, to.cy)
    const width = Math.abs(to.cx - from.cx)
    const height = Math.abs(to.cy - from.cy)
    ctx.fillStyle = hexToRgba(palette.featureModelFill, 0.14)
    ctx.strokeStyle = hexToRgba(palette.featureModelStroke, 0.6)
    ctx.lineWidth = 1.4
    ctx.setLineDash([6, 4])
    ctx.fillRect(x, y, width, height)
    ctx.strokeRect(x, y, width, height)
    ctx.setLineDash([])
    const text = label(band.name)
    const textWidth = ctx.measureText(text).width
    // The note sits at the top-left of the band's *visible* part, not of the
    // band itself: zoomed in far enough that the band's own corner is off
    // screen, a label pinned to that corner is drawn off screen and vanishes
    // (the manager saw this). The canvas is measured in CSS pixels, as the
    // other canvas draw helpers here measure it (`ctx.canvas.width/height`).
    const visibleX = Math.max(x, 0)
    const visibleY = Math.max(y, 0)
    const visibleWidth = Math.min(x + width, ctx.canvas.width) - visibleX
    const visibleHeight = Math.min(y + height, ctx.canvas.height) - visibleY
    // Readable only where the visible part can hold it: a short model along the
    // bar (or a very thin one, on a Y bar) has no room for the note at the
    // default zoom, so it is left out rather than spilling past what it
    // describes. An off-screen band has nothing visible to hold it either.
    if (visibleWidth < textWidth + MODEL_BAND_LABEL_PAD * 2 || visibleHeight < MODEL_BAND_LABEL_LINE) continue
    ctx.fillStyle = palette.labelBackground
    ctx.fillRect(visibleX, visibleY, textWidth + MODEL_BAND_LABEL_PAD * 2, MODEL_BAND_LABEL_LINE)
    ctx.fillStyle = palette.labelText
    ctx.fillText(text, visibleX + MODEL_BAND_LABEL_PAD, visibleY + 1)
  }
  ctx.restore()
}

/**
 * The stock outline the view frames (issue #395): the unrolled sheet on
 * Around, with its turn lines and without click-to-edit size labels (the
 * sheet's extents are the bar's diameter and its circumference), and the
 * stock's own rectangle otherwise.
 */
export function drawViewStockOutline(
  ctx: CanvasRenderingContext2D,
  stock: Stock,
  sheet: AroundSheet | null,
  vt: ViewTransform,
  units: Units,
  exceeded: boolean,
  palette: CanvasThemePalette,
  stockLabelRects?: StockLabelRect[],
): void {
  drawStockOutline(ctx, stock, vt, units, exceeded, palette, sheet ? undefined : stockLabelRects)
  if (sheet) drawAroundTurnLines(ctx, sheet, vt, stock.color)
}

/**
 * The outlines of what the clamp collision test actually checks: each clamp
 * grown by `clampClearanceXY` **and the tool radius**, which is why they sit so
 * much wider than the clamp boxes inside them. Drawing only the boxes is what
 * let issue #458 be mis-diagnosed as "nothing is anywhere near the clamp".
 *
 * The radius is the widest enabled operation's — a viewport has to draw one
 * shape, and that is the footprint every operation has to clear.
 */
export function drawClampClearanceOutlines(
  ctx: CanvasRenderingContext2D,
  project: Project,
  vt: ViewTransform,
): void {
  ctx.strokeStyle = canvasColors().clampClearanceStroke
  ctx.lineWidth = 1
  ctx.setLineDash([2, 5])
  for (const bounds of expandedClampBounds(project, worstCaseClampCheckToolRadius(project))) {
    traceProfilePath(
      ctx,
      rectProfile(bounds.minX, bounds.minY, bounds.maxX - bounds.minX, bounds.maxY - bounds.minY),
      vt,
    )
    ctx.stroke()
  }
  ctx.setLineDash([])
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
  const p = canvasColors()
  ctx.fillStyle = colliding
    ? (selected ? p.clampCollidingSelectedFill : p.clampCollidingFill)
    : (selected ? p.clampSelectedFill : p.clampFill)
  ctx.fill()
  ctx.strokeStyle = colliding
    ? (selected ? p.clampCollidingSelectedStroke : p.clampCollidingStroke)
    : (selected ? p.clampSelectedStroke : p.clampStroke)
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
  const p = canvasColors()
  ctx.fillStyle = selected ? p.tabSelectedFill : p.tabFill
  ctx.fill()
  ctx.strokeStyle = selected ? p.tabSelectedStroke : p.tabStroke
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
  ctx.strokeStyle = palette.originAxisX
  ctx.lineWidth = 2
  ctx.stroke()

  ctx.beginPath()
  ctx.moveTo(anchor.cx + axisLength, anchor.cy)
  ctx.lineTo(anchor.cx + axisLength - 6, anchor.cy - 3)
  ctx.lineTo(anchor.cx + axisLength - 6, anchor.cy + 3)
  ctx.closePath()
  ctx.fillStyle = palette.originAxisX
  ctx.fill()

  ctx.beginPath()
  ctx.moveTo(anchor.cx, anchor.cy)
  ctx.lineTo(anchor.cx, anchor.cy - axisLength)
  ctx.strokeStyle = palette.originAxisY
  ctx.lineWidth = 2
  ctx.stroke()

  ctx.beginPath()
  ctx.moveTo(anchor.cx, anchor.cy - axisLength)
  ctx.lineTo(anchor.cx - 3, anchor.cy - axisLength + 6)
  ctx.lineTo(anchor.cx + 3, anchor.cy - axisLength + 6)
  ctx.closePath()
  ctx.fillStyle = palette.originAxisY
  ctx.fill()

  ctx.beginPath()
  ctx.arc(anchor.cx, anchor.cy, 4, 0, Math.PI * 2)
  ctx.fillStyle = palette.originCenter
  ctx.fill()
  ctx.strokeStyle = palette.labelText
  ctx.lineWidth = 1.5
  ctx.stroke()

  ctx.font = '10px "IBM Plex Mono", "SFMono-Regular", Consolas, monospace'
  ctx.fillStyle = palette.originAxisX
  ctx.fillText('X', anchor.cx + axisLength + 4, anchor.cy + 3)
  ctx.fillStyle = palette.originAxisY
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
  applyViewMirror(ctx, vt)
  ctx.rotate(rotation)
  ctx.globalAlpha = Math.min(Math.max(backdrop.opacity, 0), 1)
  ctx.drawImage(image, -width / 2, -height / 2, width, height)
  ctx.restore()

  if (selected) {
    ctx.save()
    ctx.translate(center.cx, center.cy)
    applyViewMirror(ctx, vt)
    ctx.rotate(rotation)
    ctx.beginPath()
    ctx.rect(-width / 2, -height / 2, width, height)
    ctx.strokeStyle = palette.active
    ctx.lineWidth = 2
    ctx.setLineDash([8, 5])
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = hexToRgba(palette.active, 0.06)
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
