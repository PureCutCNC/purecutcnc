import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent, WheelEvent } from 'react'
import type { ToolpathResult } from '../../engine/toolpaths/types'
import type { SnapMode, SnapSettings } from '../../sketch/snapping'
import type { SketchControlRef, SketchEditTool, SketchInsertTarget } from '../../store/projectStore'
import { filletFeatureFromPoint, filletRadiusFromPoint, previewOffsetFeatures, resizeBackdropFromReference, resizeFeatureFromReference, rotateBackdropFromReference, rotateFeatureFromReference, useProjectStore } from '../../store/projectStore'
import { generateTextShapes, getFeatureGeometryBounds, getFeatureGeometryProfiles } from '../../text'
import {
  bezierPoint,
  circleProfile,
  getProfileBounds,
  getStockBounds,
  polygonProfile,
  profileExceedsStock,
  profileHasSelfIntersection,
  profileVertices,
  rectProfile,
  sampleProfilePoints,
  splineProfile,
} from '../../types/project'
import type { Clamp, GridSettings, Point, Segment, SketchFeature, SketchProfile, Stock, Tab } from '../../types/project'
import type { BackdropImage } from '../../types/project'
import { convertLength, formatLength, parseLengthInput } from '../../utils/units'

const PADDING = 42
const NODE_RADIUS = 5
const NODE_HIT_RADIUS = 9
const EXTEND_HIT_RADIUS = 14
const HANDLE_RADIUS = 4
const HANDLE_HIT_RADIUS = 7
const POLYGON_CLOSE_RADIUS = 12
const MIN_SKETCH_ZOOM = 0.02

interface ViewTransform {
  scale: number
  offsetX: number
  offsetY: number
}

interface CanvasPoint {
  cx: number
  cy: number
}

interface PendingPreviewPoint {
  point: Point
  session: number
}

interface SketchEditPreviewPoint {
  point: Point
  mode: SketchEditTool
}

interface PendingSketchExtension {
  kind: 'extend_start' | 'extend_end'
  anchor: Point
}

interface PendingSketchFillet {
  anchorIndex: number
  corner: Point
}

interface SketchViewState {
  zoom: number
  panX: number
  panY: number
}

export interface SketchCanvasHandle {
  zoomToModel: () => void
}

interface DimensionEditState {
  shape: 'rect' | 'circle' | 'tab' | 'clamp' | 'polygon' | 'spline' | 'composite'
  anchor: Point  // for rect-like: anchor corner; for segments: the fromPoint
  arcStart?: Point
  arcEnd?: Point
  arcClockwise?: boolean
  signX: number
  signY: number
  activeField: 'width' | 'height' | 'radius' | 'length' | 'angle'
  width: string
  height: string
  radius: string
  length: string
  angle: string  // degrees
}

function worldToCanvas(point: Point, vt: ViewTransform): CanvasPoint {
  return {
    cx: vt.offsetX + point.x * vt.scale,
    cy: vt.offsetY + point.y * vt.scale,
  }
}

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

function canvasToWorld(cx: number, cy: number, vt: ViewTransform): Point {
  return {
    x: (cx - vt.offsetX) / vt.scale,
    y: (cy - vt.offsetY) / vt.scale,
  }
}

function translateProfile(profile: SketchProfile, dx: number, dy: number): SketchProfile {
  return {
    ...profile,
    start: { x: profile.start.x + dx, y: profile.start.y + dy },
    segments: profile.segments.map((segment) => {
      if (segment.type === 'arc') {
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

function computeBaseViewTransform(stock: Stock, canvasW: number, canvasH: number): ViewTransform {
  const bounds = getStockBounds(stock)
  const stockW = Math.max(bounds.maxX - bounds.minX, 1)
  const stockH = Math.max(bounds.maxY - bounds.minY, 1)

  const scale = Math.min(
    (canvasW - PADDING * 2) / stockW,
    (canvasH - PADDING * 2) / stockH,
  )

  return {
    scale,
    offsetX: (canvasW - stockW * scale) / 2 - bounds.minX * scale,
    offsetY: (canvasH - stockH * scale) / 2 - bounds.minY * scale,
  }
}

function computeViewTransform(
  stock: Stock,
  canvasW: number,
  canvasH: number,
  viewState: SketchViewState,
): ViewTransform {
  const base = computeBaseViewTransform(stock, canvasW, canvasH)
  return {
    scale: base.scale * viewState.zoom,
    offsetX: base.offsetX + viewState.panX,
    offsetY: base.offsetY + viewState.panY,
  }
}

function getVisibleSceneBounds2D(project: ReturnType<typeof useProjectStore.getState>['project']) {
  const profiles: SketchProfile[] = []

  if (project.stock.visible) {
    profiles.push(project.stock.profile)
  }

  for (const feature of project.features) {
    if (feature.visible) {
      profiles.push(...getFeatureGeometryProfiles(feature))
    }
  }

  for (const tab of project.tabs) {
    if (tab.visible) {
      profiles.push(rectProfile(tab.x, tab.y, tab.w, tab.h))
    }
  }

  for (const clamp of project.clamps) {
    if (clamp.visible) {
      profiles.push(rectProfile(clamp.x, clamp.y, clamp.w, clamp.h))
    }
  }

  if (profiles.length === 0) {
    profiles.push(project.stock.profile)
  }

  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity

  for (const profile of profiles) {
    const bounds = getProfileBounds(profile)
    minX = Math.min(minX, bounds.minX)
    maxX = Math.max(maxX, bounds.maxX)
    minY = Math.min(minY, bounds.minY)
    maxY = Math.max(maxY, bounds.maxY)
  }

  if (project.origin.visible) {
    minX = Math.min(minX, project.origin.x)
    maxX = Math.max(maxX, project.origin.x)
    minY = Math.min(minY, project.origin.y)
    maxY = Math.max(maxY, project.origin.y)
  }

  if (project.backdrop?.visible) {
    const halfW = project.backdrop.width / 2
    const halfH = project.backdrop.height / 2
    minX = Math.min(minX, project.backdrop.center.x - halfW)
    maxX = Math.max(maxX, project.backdrop.center.x + halfW)
    minY = Math.min(minY, project.backdrop.center.y - halfH)
    maxY = Math.max(maxY, project.backdrop.center.y + halfH)
  }

  return { minX, maxX, minY, maxY }
}

function computeFitViewState(
  project: ReturnType<typeof useProjectStore.getState>['project'],
  canvasW: number,
  canvasH: number,
): SketchViewState {
  const bounds = getVisibleSceneBounds2D(project)
  return computeFitViewStateForBounds(project.stock, bounds, canvasW, canvasH)
}

function computeFitViewStateForBounds(
  stock: Stock,
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
  canvasW: number,
  canvasH: number,
): SketchViewState {
  const base = computeBaseViewTransform(stock, canvasW, canvasH)
  const contentW = Math.max(bounds.maxX - bounds.minX, 1)
  const contentH = Math.max(bounds.maxY - bounds.minY, 1)
  const desiredScale = Math.min(
    (canvasW - PADDING * 2) / contentW,
    (canvasH - PADDING * 2) / contentH,
  )
  const desiredOffsetX = (canvasW - contentW * desiredScale) / 2 - bounds.minX * desiredScale
  const desiredOffsetY = (canvasH - contentH * desiredScale) / 2 - bounds.minY * desiredScale

  return {
    zoom: desiredScale / base.scale,
    panX: desiredOffsetX - base.offsetX,
    panY: desiredOffsetY - base.offsetY,
  }
}

function traceProfilePath(
  ctx: CanvasRenderingContext2D,
  profile: SketchProfile,
  vt: ViewTransform,
): void {
  ctx.beginPath()
  const start = worldToCanvas(profile.start, vt)
  ctx.moveTo(start.cx, start.cy)

  let current = profile.start

  for (const segment of profile.segments) {
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
    const endAngle = Math.atan2(segment.to.y - segment.center.y, segment.to.x - segment.center.x)

    ctx.arc(center.cx, center.cy, radius, startAngle, endAngle, segment.clockwise)
    current = segment.to
  }

  if (profile.closed) {
    ctx.closePath()
  }
}

function anchorPointForIndex(profile: SketchProfile, index: number): Point {
  return index === 0 ? profile.start : profile.segments[index - 1].to
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

function drawSketchControls(
  ctx: CanvasRenderingContext2D,
  profile: SketchProfile,
  vt: ViewTransform,
  activeControl: SketchControlRef | null,
): void {
  const vertices = profileVertices(profile)

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

  for (let index = 0; index < vertices.length; index += 1) {
    const vertex = vertices[index]
    const { cx, cy } = worldToCanvas(vertex, vt)
    const active = activeControl?.kind === 'anchor' && activeControl.index === index

    ctx.beginPath()
    ctx.arc(cx, cy, active ? NODE_RADIUS + 2 : NODE_RADIUS, 0, Math.PI * 2)
    ctx.fillStyle = active ? '#f2b95c' : '#d2dde6'
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

function drawSketchEditPreviewPoint(
  ctx: CanvasRenderingContext2D,
  preview: SketchEditPreviewPoint,
  vt: ViewTransform,
): void {
  const { cx, cy } = worldToCanvas(preview.point, vt)
  ctx.beginPath()
  ctx.arc(cx, cy, NODE_RADIUS + 2, 0, Math.PI * 2)
  ctx.fillStyle = preview.mode === 'delete_point' ? '#d66c6c' : '#5daeea'
  ctx.fill()
  ctx.strokeStyle = preview.mode === 'delete_point' ? '#efb0b0' : '#a9d2f5'
  ctx.lineWidth = 2
  ctx.stroke()
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  vt: ViewTransform,
  canvasW: number,
  canvasH: number,
  stock: Stock,
  grid: GridSettings,
): void {
  if (!grid.visible) return

  const bounds = getStockBounds(stock)
  const centerX = bounds.minX + (bounds.maxX - bounds.minX) / 2
  const centerY = bounds.minY + (bounds.maxY - bounds.minY) / 2
  const halfExtent = Math.max(grid.extent / 2, 10)
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
    ctx.strokeStyle = isMajor ? 'rgba(104, 132, 154, 0.34)' : 'rgba(88, 112, 130, 0.18)'
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
    ctx.strokeStyle = isMajor ? 'rgba(104, 132, 154, 0.34)' : 'rgba(88, 112, 130, 0.18)'
    ctx.lineWidth = isMajor ? 1.2 : 1
    ctx.stroke()
  }
}

function drawFeature(
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

function drawPreviewProfile(
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

function drawPendingPoint(
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

function drawMoveGuide(
  ctx: CanvasRenderingContext2D,
  fromPoint: Point,
  toPoint: Point,
  vt: ViewTransform
): void {
  const start = worldToCanvas(fromPoint, vt)
  const end = worldToCanvas(toPoint, vt)

  ctx.beginPath()
  ctx.moveTo(start.cx, start.cy)
  ctx.lineTo(end.cx, end.cy)
  ctx.strokeStyle = 'rgba(239, 188, 122, 0.75)'
  ctx.lineWidth = 1.5
  ctx.setLineDash([8, 5])
  ctx.stroke()
  ctx.setLineDash([])
}

function lineLength(start: Point, end: Point): number {
  return Math.hypot(end.x - start.x, end.y - start.y)
}

function drawMeasurementLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  angle = 0,
): void {
  const normalizedAngle =
    angle > Math.PI / 2 || angle < -Math.PI / 2
      ? angle + Math.PI
      : angle

  ctx.save()
  ctx.translate(cx, cy)
  ctx.rotate(normalizedAngle)
  ctx.font = '11px "IBM Plex Mono", "SFMono-Regular", Consolas, monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const metrics = ctx.measureText(text)
  const width = metrics.width + 12
  const height = 18
  ctx.fillStyle = 'rgba(15, 21, 29, 0.92)'
  ctx.strokeStyle = 'rgba(239, 188, 122, 0.42)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.roundRect(-width / 2, -height / 2, width, height, 5)
  ctx.fill()
  ctx.stroke()
  ctx.fillStyle = 'rgba(245, 216, 183, 0.96)'
  ctx.fillText(text, 0, 0)
  ctx.restore()
}

function drawLineLengthMeasurement(
  ctx: CanvasRenderingContext2D,
  start: Point,
  end: Point,
  vt: ViewTransform,
  units: 'mm' | 'inch',
  options?: { prefix?: string; offset?: number },
): void {
  const startCanvas = worldToCanvas(start, vt)
  const endCanvas = worldToCanvas(end, vt)
  const dx = endCanvas.cx - startCanvas.cx
  const dy = endCanvas.cy - startCanvas.cy
  const canvasLength = Math.hypot(dx, dy)
  if (canvasLength < 28) {
    return
  }

  const midX = (startCanvas.cx + endCanvas.cx) / 2
  const midY = (startCanvas.cy + endCanvas.cy) / 2
  const offset = options?.offset ?? 11
  const normalX = -dy / canvasLength
  const normalY = dx / canvasLength
  const value = formatLength(lineLength(start, end), units)
  drawMeasurementLabel(
    ctx,
    options?.prefix ? `${options.prefix} ${value}` : value,
    midX + normalX * offset,
    midY + normalY * offset,
    Math.atan2(dy, dx),
  )
}

function drawArcRadiusMeasurement(
  ctx: CanvasRenderingContext2D,
  start: Point,
  segment: Extract<Segment, { type: 'arc' }>,
  vt: ViewTransform,
  units: 'mm' | 'inch',
): void {
  const midpoint = arcControlPoint(start, segment)
  const midpointCanvas = worldToCanvas(midpoint, vt)
  const centerCanvas = worldToCanvas(segment.center, vt)
  const radiusCanvas = Math.hypot(midpointCanvas.cx - centerCanvas.cx, midpointCanvas.cy - centerCanvas.cy)
  if (radiusCanvas < 16) {
    return
  }

  const angle = Math.atan2(midpointCanvas.cy - centerCanvas.cy, midpointCanvas.cx - centerCanvas.cx)
  const offset = 14
  drawMeasurementLabel(
    ctx,
    `R ${formatLength(lineLength(start, segment.center), units)}`,
    midpointCanvas.cx + Math.cos(angle) * offset,
    midpointCanvas.cy + Math.sin(angle) * offset,
  )
}

function drawRadiusMeasurement(
  ctx: CanvasRenderingContext2D,
  center: Point,
  edgePoint: Point,
  vt: ViewTransform,
  units: 'mm' | 'inch',
): void {
  const centerCanvas = worldToCanvas(center, vt)
  const edgeCanvas = worldToCanvas(edgePoint, vt)
  const dx = edgeCanvas.cx - centerCanvas.cx
  const dy = edgeCanvas.cy - centerCanvas.cy
  const canvasLength = Math.hypot(dx, dy)
  if (canvasLength < 16) {
    return
  }

  const midX = (centerCanvas.cx + edgeCanvas.cx) / 2
  const midY = (centerCanvas.cy + edgeCanvas.cy) / 2
  const offset = 11
  drawMeasurementLabel(
    ctx,
    `R ${formatLength(lineLength(center, edgePoint), units)}`,
    midX - (dy / canvasLength) * offset,
    midY + (dx / canvasLength) * offset,
    Math.atan2(dy, dx),
  )
}

function drawProfileLineMeasurements(
  ctx: CanvasRenderingContext2D,
  profile: SketchProfile,
  vt: ViewTransform,
  units: 'mm' | 'inch',
  options?: { segmentIndices?: number[] },
): void {
  const allowed = options?.segmentIndices ? new Set(options.segmentIndices) : null
  let current = profile.start

  for (let index = 0; index < profile.segments.length; index += 1) {
    const segment = profile.segments[index]
    if (allowed && !allowed.has(index)) {
      current = segment.to
      continue
    }

    if (segment.type === 'line' || segment.type === 'bezier') {
      drawLineLengthMeasurement(ctx, current, segment.to, vt, units)
    }

    current = segment.to
  }
}

function drawAngleMeasurement(
  ctx: CanvasRenderingContext2D,
  origin: Point,
  fromPoint: Point,
  toPoint: Point,
  vt: ViewTransform,
): void {
  const startAngle = Math.atan2(fromPoint.y - origin.y, fromPoint.x - origin.x)
  const endAngle = Math.atan2(toPoint.y - origin.y, toPoint.x - origin.x)
  let delta = (endAngle - startAngle) * (180 / Math.PI)
  while (delta <= -180) delta += 360
  while (delta > 180) delta -= 360
  if (Math.abs(delta) < 0.1) {
    return
  }

  const originCanvas = worldToCanvas(origin, vt)
  const angleMid = startAngle + ((delta * Math.PI) / 180) / 2
  const radius =
    Math.min(
      Math.max(
        (Math.hypot(fromPoint.x - origin.x, fromPoint.y - origin.y) + Math.hypot(toPoint.x - origin.x, toPoint.y - origin.y)) * vt.scale * 0.2,
        24,
      ),
      56,
    )

  drawMeasurementLabel(
    ctx,
    `${delta >= 0 ? '+' : ''}${delta.toFixed(1).replace(/\.0$/, '')}°`,
    originCanvas.cx + Math.cos(angleMid) * radius,
    originCanvas.cy + Math.sin(angleMid) * radius,
  )
}

function drawActiveEditMeasurements(
  ctx: CanvasRenderingContext2D,
  profile: SketchProfile,
  vt: ViewTransform,
  units: 'mm' | 'inch',
  activeControl: SketchControlRef | null,
): void {
  if (!activeControl) {
    return
  }

  if (activeControl.kind === 'anchor') {
    const indices: number[] = []
    if (profile.closed || activeControl.index > 0) {
      indices.push((activeControl.index - 1 + profile.segments.length) % profile.segments.length)
    }
    if (activeControl.index < profile.segments.length) {
      indices.push(activeControl.index)
    }
    drawProfileLineMeasurements(ctx, profile, vt, units, { segmentIndices: indices })
    return
  }

  if (activeControl.kind === 'arc_handle') {
    const segment = profile.segments[activeControl.index]
    if (segment?.type === 'arc') {
      drawArcRadiusMeasurement(ctx, anchorPointForIndex(profile, activeControl.index), segment, vt, units)
    }
  }
}

function drawPendingPathLoop(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  previewPoint: Point | null,
  vt: ViewTransform,
  closePreview: boolean,
  previewProfileFactory: (points: Point[]) => SketchProfile,
  label: string,
  units: 'mm' | 'inch',
  previewHighlighted = false,
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

  ctx.strokeStyle = '#efbc7a'
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

function drawClampFootprint(
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

function drawTabFootprint(
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

function drawOriginMarker(
  ctx: CanvasRenderingContext2D,
  origin: ReturnType<typeof useProjectStore.getState>['project']['origin'],
  vt: ViewTransform,
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
  ctx.strokeStyle = 'rgba(230, 237, 245, 0.95)'
  ctx.lineWidth = 1.5
  ctx.stroke()

  ctx.font = '10px "IBM Plex Mono", "SFMono-Regular", Consolas, monospace'
  ctx.fillStyle = 'rgba(230, 237, 245, 0.95)'
  ctx.fillText(origin.name, anchor.cx + 10, anchor.cy - 8)
  ctx.restore()
}

function backdropRotationRadians(backdrop: BackdropImage): number {
  return ((backdrop.orientationAngle ?? 90) - 90) * (Math.PI / 180)
}

function drawBackdropImage(
  ctx: CanvasRenderingContext2D,
  backdrop: BackdropImage,
  image: HTMLImageElement,
  vt: ViewTransform,
  selected: boolean,
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

    ctx.fillStyle = 'rgba(18, 22, 29, 0.8)'
    ctx.fillRect(center.cx - 38, center.cy - 14, 76, 18)
    ctx.fillStyle = '#d8e4f0'
    ctx.font = '11px monospace'
    ctx.textAlign = 'center'
    ctx.fillText(label, center.cx, center.cy - 1)
  }
}

function hitBackdrop(point: Point, backdrop: BackdropImage): boolean {
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

function drawPendingSplineLoop(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  previewPoint: Point | null,
  vt: ViewTransform,
  closePreview: boolean,
  units: 'mm' | 'inch',
  previewHighlighted = false,
): void {
  if (points.length === 0) return

  const previewSegments = buildSplineDraftSegments(points, closePreview ? null : previewPoint)
  if (previewSegments.length > 0) {
    traceDraftSegments(ctx, points[0], previewSegments, vt)
    ctx.strokeStyle = '#efbc7a'
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

function drawDepthLegend(ctx: CanvasRenderingContext2D, canvasW: number, canvasH: number): void {
  const x = canvasW - 160
  const y = canvasH - 88
  const labels = [
    { color: '#5da5d8', text: 'Subtract shallow' },
    { color: '#3f76b4', text: 'Subtract deep' },
    { color: '#63b176', text: 'Add feature' },
  ]

  ctx.save()
  ctx.fillStyle = 'rgba(16, 22, 30, 0.65)'
  ctx.fillRect(x - 10, y - 10, 150, 68)

  ctx.font = '10px "IBM Plex Mono", "SFMono-Regular", Consolas, monospace'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  for (let index = 0; index < labels.length; index += 1) {
    const item = labels[index]
    const rowY = y + index * 18
    ctx.fillStyle = item.color
    ctx.fillRect(x, rowY, 12, 12)
    ctx.fillStyle = 'rgba(206, 220, 231, 0.95)'
    ctx.fillText(item.text, x + 18, rowY + 6)
  }
  ctx.restore()
}

function drawToolpath(
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
}

function pointInProfile(x: number, y: number, profile: SketchProfile): boolean {
  if (!profile.closed) {
    return false
  }

  const points = sampleProfilePoints(profile)
  if (points.length < 3) return false

  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const xi = points[i].x
    const yi = points[i].y
    const xj = points[j].x
    const yj = points[j].y

    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    if (intersects) inside = !inside
  }

  return inside
}

function distancePointToSegment(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x
  const dy = end.y - start.y
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) {
    return Math.hypot(point.x - start.x, point.y - start.y)
  }

  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)))
  const projection = {
    x: start.x + dx * t,
    y: start.y + dy * t,
  }
  return Math.hypot(point.x - projection.x, point.y - projection.y)
}

function pointNearProfile(worldPoint: Point, profile: SketchProfile, vt: ViewTransform, tolerancePx = 8): boolean {
  const points = sampleProfilePoints(profile)
  if (points.length < 2) {
    return false
  }

  const toleranceWorld = tolerancePx / Math.max(vt.scale, 1e-6)
  const segmentCount = profile.closed ? points.length : points.length - 1
  for (let index = 0; index < segmentCount; index += 1) {
    const start = points[index]
    const end = points[(index + 1) % points.length]
    if (distancePointToSegment(worldPoint, start, end) <= toleranceWorld) {
      return true
    }
  }

  return false
}

function nearestPointOnProfileBoundary(point: Point, profile: SketchProfile, vt: ViewTransform): { point: Point; distance: number } | null {
  if (profile.segments.length === 0) {
    return null
  }

  let bestPoint: Point | null = null
  let bestDistanceSq = Infinity

  for (let index = 0; index < profile.segments.length; index += 1) {
    const start = anchorPointForIndex(profile, index)
    const segment = profile.segments[index]
    const candidate = nearestPointOnSegmentWithT(point, start, segment, vt)
    const dx = candidate.point.x - point.x
    const dy = candidate.point.y - point.y
    const distanceSq = dx * dx + dy * dy
    if (distanceSq < bestDistanceSq) {
      bestDistanceSq = distanceSq
      bestPoint = candidate.point
    }
  }

  return bestPoint ? { point: bestPoint, distance: Math.sqrt(bestDistanceSq) } : null
}

function resolveOffsetPreviewInput(features: SketchFeature[], point: Point, vt: ViewTransform): {
  nearestPoint: Point
  distance: number
  signedDistance: number
  direction: 'in' | 'out'
} | null {
  let nearestPoint: Point | null = null
  let nearestDistance = Infinity

  for (const feature of features) {
    const candidate = nearestPointOnProfileBoundary(point, feature.sketch.profile, vt)
    if (!candidate) {
      continue
    }
    if (candidate.distance < nearestDistance) {
      nearestDistance = candidate.distance
      nearestPoint = candidate.point
    }
  }

  if (!nearestPoint || !Number.isFinite(nearestDistance) || nearestDistance <= 1e-9) {
    return null
  }

  const direction = features.some((feature) => pointInProfile(point.x, point.y, feature.sketch.profile)) ? 'in' : 'out'
  return {
    nearestPoint,
    distance: nearestDistance,
    signedDistance: direction === 'in' ? -nearestDistance : nearestDistance,
    direction,
  }
}

function resolveOffsetPreview(
  features: SketchFeature[],
  rawPoint: Point,
  snappedPoint: Point,
  snapMode: SnapMode | null,
  vt: ViewTransform,
): {
  nearestPoint: Point
  distance: number
  signedDistance: number
  direction: 'in' | 'out'
} | null {
  const snappedPreview = resolveOffsetPreviewInput(features, snappedPoint, vt)
  if (snapMode && snapMode !== 'line' && snapMode !== 'perpendicular') {
    return snappedPreview
  }

  if (!snappedPreview) {
    return resolveOffsetPreviewInput(features, rawPoint, vt)
  }

  if (snappedPreview.distance > 1e-5 || pointsEqual(rawPoint, snappedPoint, 1e-9)) {
    return snappedPreview
  }

  if (snapMode === 'line' || snapMode === 'perpendicular') {
    return resolveOffsetPreviewInput(features, rawPoint, vt) ?? snappedPreview
  }

  return snappedPreview
}

function findHitFeatureId(worldPoint: Point, features: SketchFeature[], vt: ViewTransform): string | null {
  for (let index = features.length - 1; index >= 0; index -= 1) {
    const feature = features[index]
    if (!feature.visible) continue
    if (
      pointInProfile(worldPoint.x, worldPoint.y, feature.sketch.profile)
      || pointNearProfile(worldPoint, feature.sketch.profile, vt)
    ) {
      return feature.id
    }
  }
  return null
}

function pointInRect(point: Point, minX: number, minY: number, maxX: number, maxY: number): boolean {
  return point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY
}

function featureFullyInsideRect(feature: SketchFeature, minX: number, minY: number, maxX: number, maxY: number): boolean {
  const points = sampleProfilePoints(feature.sketch.profile)
  if (points.length === 0) {
    return false
  }

  return points.every((point) => pointInRect(point, minX, minY, maxX, maxY))
}

function findHitClampId(worldPoint: Point, clamps: Clamp[]): string | null {
  for (let index = clamps.length - 1; index >= 0; index -= 1) {
    const clamp = clamps[index]
    if (!clamp.visible) continue
    if (pointInProfile(worldPoint.x, worldPoint.y, rectProfile(clamp.x, clamp.y, clamp.w, clamp.h))) {
      return clamp.id
    }
  }
  return null
}

function findHitTabId(worldPoint: Point, tabs: Tab[]): string | null {
  for (let index = tabs.length - 1; index >= 0; index -= 1) {
    const tab = tabs[index]
    if (!tab.visible) continue
    if (pointInProfile(worldPoint.x, worldPoint.y, rectProfile(tab.x, tab.y, tab.w, tab.h))) {
      return tab.id
    }
  }
  return null
}

function distance2(a: CanvasPoint, b: CanvasPoint): number {
  const dx = a.cx - b.cx
  const dy = a.cy - b.cy
  return dx * dx + dy * dy
}

function snap(value: number, step: number): number {
  return Math.round(value / step) * step
}

function hexToRgba(hex: string, alpha: number): string {
  const normalized = hex.replace('#', '')
  if (normalized.length !== 6) return `rgba(136, 153, 170, ${alpha})`

  const r = Number.parseInt(normalized.slice(0, 2), 16)
  const g = Number.parseInt(normalized.slice(2, 4), 16)
  const b = Number.parseInt(normalized.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function pointsEqual(a: Point, b: Point, epsilon = 1e-9): boolean {
  return Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon
}

function addPoint(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y }
}

function subtractPoint(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y }
}

function scalePoint(point: Point, scale: number): Point {
  return { x: point.x * scale, y: point.y * scale }
}

function lerpPoint(a: Point, b: Point, t: number): Point {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  }
}

function projectPointOntoLine(point: Point, lineStart: Point, lineEnd: Point): Point {
  const direction = subtractPoint(lineEnd, lineStart)
  const lengthSq = dotPoint(direction, direction)
  if (lengthSq <= 1e-9) {
    return lineStart
  }

  const t = dotPoint(subtractPoint(point, lineStart), direction) / lengthSq
  return addPoint(lineStart, scalePoint(direction, t))
}

function dotPoint(a: Point, b: Point): number {
  return a.x * b.x + a.y * b.y
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

type EditDimStep =
  | { kind: 'endpoint'; control: SketchControlRef; fromAnchorIndex: number }
  | { kind: 'arc_radius'; control: SketchControlRef; arcStartAnchorIndex: number }

function computeEditDimSteps(profile: SketchProfile, anchorIndex: number): EditDimStep[] {
  const steps: EditDimStep[] = []
  const n = profile.segments.length
  const vertices = profileVertices(profile)

  // Incoming segment (segment going into anchorIndex)
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

  // Outgoing segment (segment leaving anchorIndex)
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

function arcHandleFromRadius(
  arcStart: Point,
  segment: Extract<Segment, { type: 'arc' }>,
  newRadius: number,
): Point | null {
  const to = segment.to
  const midX = (arcStart.x + to.x) / 2
  const midY = (arcStart.y + to.y) / 2
  const halfChordX = (to.x - arcStart.x) / 2
  const halfChordY = (to.y - arcStart.y) / 2
  const halfChord = Math.hypot(halfChordX, halfChordY)
  if (halfChord < 1e-9 || newRadius < halfChord) return null

  const perpX = -halfChordY / halfChord
  const perpY = halfChordX / halfChord
  const side = (segment.center.x - midX) * perpX + (segment.center.y - midY) * perpY >= 0 ? 1 : -1
  const t = Math.sqrt(newRadius * newRadius - halfChord * halfChord)
  const newCenterX = midX + side * t * perpX
  const newCenterY = midY + side * t * perpY

  const startAngle = Math.atan2(arcStart.y - newCenterY, arcStart.x - newCenterX)
  const endAngle = Math.atan2(to.y - newCenterY, to.x - newCenterX)
  let sweep = endAngle - startAngle
  if (segment.clockwise && sweep > 0) sweep -= Math.PI * 2
  else if (!segment.clockwise && sweep < 0) sweep += Math.PI * 2

  const midAngle = startAngle + sweep / 2
  return {
    x: newCenterX + Math.cos(midAngle) * newRadius,
    y: newCenterY + Math.sin(midAngle) * newRadius,
  }
}

function computeDimensionEditPreviewPoint(
  edit: DimensionEditState,
  units: 'mm' | 'inch',
): Point {
  if (edit.shape === 'circle') {
    const r = Math.max(parseLengthInput(edit.radius, units) ?? 0, 0)
    if (edit.arcStart && edit.arcEnd) {
      const arcStart = edit.arcStart
      const to = edit.arcEnd
      const midX = (arcStart.x + to.x) / 2
      const midY = (arcStart.y + to.y) / 2
      const halfChordX = (to.x - arcStart.x) / 2
      const halfChordY = (to.y - arcStart.y) / 2
      const halfChord = Math.hypot(halfChordX, halfChordY)
      if (halfChord < 1e-9 || r < halfChord) return edit.anchor

      const perpX = -halfChordY / halfChord
      const perpY = halfChordX / halfChord
      // Side: we can use edit.anchor to determine which side of the chord the arc is on
      const side = (edit.anchor.x - midX) * perpX + (edit.anchor.y - midY) * perpY >= 0 ? 1 : -1
      const t = Math.sqrt(r * r - halfChord * halfChord)
      const newCenterX = midX + side * t * perpX
      const newCenterY = midY + side * t * perpY

      const startAngle = Math.atan2(arcStart.y - newCenterY, arcStart.x - newCenterX)
      const endAngle = Math.atan2(to.y - newCenterY, to.x - newCenterX)
      const clockwise = edit.arcClockwise ?? false
      let sweep = endAngle - startAngle
      if (clockwise && sweep > 0) sweep -= Math.PI * 2
      else if (!clockwise && sweep < 0) sweep += Math.PI * 2

      const midAngle = startAngle + sweep / 2
      return {
        x: newCenterX + Math.cos(midAngle) * r,
        y: newCenterY + Math.sin(midAngle) * r,
      }
    }
    return { x: edit.anchor.x + r, y: edit.anchor.y }
  }
  if (edit.shape === 'polygon' || edit.shape === 'spline' || edit.shape === 'composite') {
    const len = Math.max(parseLengthInput(edit.length, units) ?? 0, 0)
    const angleDeg = parseFloat(edit.angle) || 0
    const angleRad = angleDeg * (Math.PI / 180)
    return {
      x: edit.anchor.x + len * Math.cos(angleRad),
      y: edit.anchor.y + len * Math.sin(angleRad),
    }
  }
  const w = Math.max(parseLengthInput(edit.width, units) ?? 0, 0)
  const h = Math.max(parseLengthInput(edit.height, units) ?? 0, 0)
  return {
    x: edit.anchor.x + edit.signX * w,
    y: edit.anchor.y + edit.signY * h,
  }
}

function buildPendingProfile(
  pendingAdd: Extract<NonNullable<ReturnType<typeof useProjectStore.getState>['pendingAdd']>, { shape: 'rect' | 'circle' | 'tab' | 'clamp' }>,
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

type CompositePendingAdd = Extract<NonNullable<ReturnType<typeof useProjectStore.getState>['pendingAdd']>, { shape: 'composite' }>

function compositeDraftPoints(pendingAdd: CompositePendingAdd): Point[] {
  if (!pendingAdd.start) return []
  return [pendingAdd.start, ...pendingAdd.segments.map((segment) => segment.to)]
}

function traceDraftSegments(
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
    const endAngle = Math.atan2(segment.to.y - segment.center.y, segment.to.x - segment.center.x)
    ctx.arc(center.cx, center.cy, radius, startAngle, endAngle, segment.clockwise)
    current = segment.to
  }
}

function drawCompositeDraft(
  ctx: CanvasRenderingContext2D,
  pendingAdd: CompositePendingAdd,
  previewPoint: Point | null,
  vt: ViewTransform,
  units: 'mm' | 'inch',
  previewHighlighted = false,
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
    ctx.strokeStyle = '#efbc7a'
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

function resolveCompositeDraftSegmentsForWarning(
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

function isLoopCloseCandidate(
  point: CanvasPoint,
  loopPoints: Point[],
  vt: ViewTransform,
): boolean {
  if (loopPoints.length < 3) return false
  const start = worldToCanvas(loopPoints[0], vt)
  return distance2(point, start) <= POLYGON_CLOSE_RADIUS * POLYGON_CLOSE_RADIUS
}

interface SnapGuide {
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
}

interface ResolvedSnap {
  rawPoint: Point
  point: Point
  mode: SnapMode | null
  guide?: SnapGuide
}

function distanceToCanvas(a: CanvasPoint, b: CanvasPoint): number {
  return Math.sqrt(distance2(a, b))
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function midpoint(a: Point, b: Point): Point {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  }
}

function segmentMidpoint(start: Point, segment: Segment): Point {
  if (segment.type === 'line') {
    return midpoint(start, segment.to)
  }

  if (segment.type === 'bezier') {
    return bezierPoint(start, segment.control1, segment.control2, segment.to, 0.5)
  }

  return arcControlPoint(start, segment)
}

function projectPointOntoSegment(point: Point, lineStart: Point, lineEnd: Point): Point {
  const direction = subtractPoint(lineEnd, lineStart)
  const lengthSq = dotPoint(direction, direction)
  if (lengthSq <= 1e-9) {
    return lineStart
  }

  const t = clamp01(dotPoint(subtractPoint(point, lineStart), direction) / lengthSq)
  return addPoint(lineStart, scalePoint(direction, t))
}

function sampleSegmentPolyline(start: Point, segment: Segment): Point[] {
  if (segment.type === 'line') {
    return [start, segment.to]
  }

  if (segment.type === 'bezier') {
    const points: Point[] = [start]
    for (let sample = 1; sample <= 12; sample += 1) {
      points.push(bezierPoint(start, segment.control1, segment.control2, segment.to, sample / 12))
    }
    return points
  }

  const profile: SketchProfile = {
    start,
    segments: [segment],
    closed: false,
  }
  return sampleProfilePoints(profile, 12, Math.PI / 18)
}

function nearestPointOnPolyline(point: Point, polyline: Point[]): Point {
  let bestPoint = polyline[0]
  let bestDistanceSq = Infinity

  for (let index = 0; index < polyline.length - 1; index += 1) {
    const projected = projectPointOntoSegment(point, polyline[index], polyline[index + 1])
    const dx = projected.x - point.x
    const dy = projected.y - point.y
    const distanceSq = dx * dx + dy * dy
    if (distanceSq < bestDistanceSq) {
      bestDistanceSq = distanceSq
      bestPoint = projected
    }
  }

  return bestPoint
}

function segmentPointAt(start: Point, segment: Segment, t: number): Point {
  if (segment.type === 'line') {
    return lerpPoint(start, segment.to, t)
  }

  if (segment.type === 'bezier') {
    return bezierPoint(start, segment.control1, segment.control2, segment.to, t)
  }

  const startAngle = Math.atan2(start.y - segment.center.y, start.x - segment.center.x)
  const endAngle = Math.atan2(segment.to.y - segment.center.y, segment.to.x - segment.center.x)
  const radius = Math.hypot(start.x - segment.center.x, start.y - segment.center.y)

  let sweep = endAngle - startAngle
  if (segment.clockwise && sweep > 0) {
    sweep -= Math.PI * 2
  } else if (!segment.clockwise && sweep < 0) {
    sweep += Math.PI * 2
  }

  const angle = startAngle + sweep * t
  return {
    x: segment.center.x + Math.cos(angle) * radius,
    y: segment.center.y + Math.sin(angle) * radius,
  }
}

function nearestPointOnSegmentWithT(
  point: Point,
  start: Point,
  segment: Segment,
  vt: ViewTransform,
): { point: Point; t: number; distanceSqPx: number } {
  if (segment.type === 'line') {
    const direction = subtractPoint(segment.to, start)
    const lengthSq = dotPoint(direction, direction)
    const t = lengthSq <= 1e-9 ? 0 : clamp01(dotPoint(subtractPoint(point, start), direction) / lengthSq)
    const projected = addPoint(start, scalePoint(direction, t))
    return {
      point: projected,
      t,
      distanceSqPx: distance2(worldToCanvas(projected, vt), worldToCanvas(point, vt)),
    }
  }

  let bestT = 0
  let bestPoint = start
  let bestDistanceSqPx = Infinity

  for (let step = 1; step < 48; step += 1) {
    const t = step / 48
    const candidate = segmentPointAt(start, segment, t)
    const distanceSqPx = distance2(worldToCanvas(candidate, vt), worldToCanvas(point, vt))
    if (distanceSqPx < bestDistanceSqPx) {
      bestT = t
      bestPoint = candidate
      bestDistanceSqPx = distanceSqPx
    }
  }

  return {
    point: bestPoint,
    t: bestT,
    distanceSqPx: bestDistanceSqPx,
  }
}

function findSketchInsertTarget(
  profile: SketchProfile,
  snappedPoint: Point,
  vt: ViewTransform,
): SketchInsertTarget | null {
  let best: SketchInsertTarget | null = null
  let bestDistanceSqPx = NODE_HIT_RADIUS * NODE_HIT_RADIUS

  for (let index = 0; index < profile.segments.length; index += 1) {
    const start = anchorPointForIndex(profile, index)
    const segment = profile.segments[index]
    const candidate = nearestPointOnSegmentWithT(snappedPoint, start, segment, vt)
    if (candidate.t <= 0.001 || candidate.t >= 0.999) {
      continue
    }

    if (candidate.distanceSqPx < bestDistanceSqPx) {
      bestDistanceSqPx = candidate.distanceSqPx
      best = {
        kind: 'segment',
        segmentIndex: index,
        point: candidate.point,
        t: candidate.t,
      }
    }
  }

  return best
}

function findOpenProfileExtensionEndpoint(
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

function drawSnapIndicator(
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

interface SketchCanvasProps {
  onFeatureContextMenu?: (featureId: string, x: number, y: number) => void
  onTabContextMenu?: (tabId: string, x: number, y: number) => void
  onClampContextMenu?: (clampId: string, x: number, y: number) => void
  toolpaths?: ToolpathResult[]
  selectedOperationId?: string | null
  collidingClampIds?: string[]
  snapSettings: SnapSettings
  zoomWindowActive?: boolean
  onZoomWindowComplete?: () => void
  onActiveSnapModeChange?: (mode: SnapMode | null) => void
}

export const SketchCanvas = forwardRef<SketchCanvasHandle, SketchCanvasProps>(function SketchCanvas(
  {
    onFeatureContextMenu,
    onTabContextMenu,
    onClampContextMenu,
    toolpaths = [],
    selectedOperationId = null,
    collidingClampIds = [],
    snapSettings,
    zoomWindowActive = false,
    onZoomWindowComplete,
    onActiveSnapModeChange,
  },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const isDraggingNodeRef = useRef(false)
  const isPanningRef = useRef(false)
  const didPanRef = useRef(false)
  const lastPanPointRef = useRef<CanvasPoint | null>(null)
  const marqueeStartRef = useRef<CanvasPoint | null>(null)
  const marqueeCurrentRef = useRef<CanvasPoint | null>(null)
  const zoomWindowStartRef = useRef<CanvasPoint | null>(null)
  const zoomWindowCurrentRef = useRef<CanvasPoint | null>(null)
  const suppressClickRef = useRef(false)
  const originPreviewPointRef = useRef<PendingPreviewPoint | null>(null)
  const activeSnapRef = useRef<ResolvedSnap | null>(null)
  const sketchEditPreviewRef = useRef<SketchEditPreviewPoint | null>(null)
  const pendingSketchExtensionRef = useRef<PendingSketchExtension | null>(null)
  const pendingSketchFilletRef = useRef<PendingSketchFillet | null>(null)
  const pendingPreviewPointRef = useRef<PendingPreviewPoint | null>(null)
  const pendingMovePreviewPointRef = useRef<PendingPreviewPoint | null>(null)
  const pendingTransformPreviewPointRef = useRef<PendingPreviewPoint | null>(null)
  const pendingOffsetPreviewPointRef = useRef<PendingPreviewPoint | null>(null)
  const pendingOffsetRawPreviewPointRef = useRef<PendingPreviewPoint | null>(null)
  const livePointerWorldRef = useRef<Point | null>(null)
  const drawFrameRef = useRef<number | null>(null)
  const drawRef = useRef<() => void>(() => {})
  const [copyCountDraft, setCopyCountDraft] = useState('1')
  const [viewState, setViewState] = useState<SketchViewState>({ zoom: 1, panX: 0, panY: 0 })
  const [backdropImage, setBackdropImage] = useState<HTMLImageElement | null>(null)
  const [dimensionEdit, setDimensionEdit] = useState<DimensionEditState | null>(null)
  const copyCountInputRef = useRef<HTMLInputElement>(null)
  const dimensionEditRef = useRef<DimensionEditState | null>(null)
  const dimensionEditControlRef = useRef<SketchControlRef | null>(null)
  const dimensionEditFeatureIdRef = useRef<string | null>(null)
  const editDimStepsRef = useRef<EditDimStep[]>([])
  const editDimStepIndexRef = useRef(0)
  const widthInputRef = useRef<HTMLInputElement>(null)
  const heightInputRef = useRef<HTMLInputElement>(null)
  const radiusInputRef = useRef<HTMLInputElement>(null)

  const {
    project,
    pendingAdd,
    pendingMove,
    pendingTransform,
    pendingOffset,
    pendingShapeAction,
    selection,
    selectFeature,
    selectFeatures,
    selectBackdrop,
    selectTab,
    selectClamp,
    hoverFeature,
    enterSketchEdit,
    enterTabEdit,
    enterClampEdit,
    applySketchEdit,
    cancelSketchEdit,
    setActiveControl,
    beginHistoryTransaction,
    commitHistoryTransaction,
    cancelHistoryTransaction,
    moveFeatureControl,
    insertFeaturePoint,
    deleteFeaturePoint,
    filletFeaturePoint,
    moveTabControl,
    moveClampControl,
    setPendingAddAnchor,
    placePendingAddAt,
    placePendingTextAt,
    placeOriginAt,
    addPendingPolygonPoint,
    undoPendingPolygonPoint,
    completePendingPolygon,
    completePendingOpenPath,
    cancelPendingAdd,
    setPendingCompositeMode,
    addPendingCompositePoint,
    undoPendingCompositeStep,
    completePendingComposite,
    completePendingOpenComposite,
    setPendingMoveFrom,
    setPendingMoveTo,
    completePendingMove,
    cancelPendingMove,
    setPendingTransformReferenceStart,
    setPendingTransformReferenceEnd,
    completePendingTransform,
    cancelPendingTransform,
    completePendingOffset,
    cancelPendingOffset,
    completePendingShapeAction,
    cancelPendingShapeAction,
    setPendingShapeActionKeepOriginals,
    setBackdropImageLoading,
  } = useProjectStore()
  const copyCountPromptActive = pendingMove?.mode === 'copy' && !!pendingMove.fromPoint && !!pendingMove.toPoint
  const projectRef = useRef(project)
  const selectionRef = useRef(selection)
  const pendingAddRef = useRef(pendingAdd)
  const pendingMoveRef = useRef(pendingMove)
  const pendingTransformRef = useRef(pendingTransform)
  const pendingOffsetRef = useRef(pendingOffset)
  const pendingShapeActionRef = useRef(pendingShapeAction)
  const viewStateRef = useRef(viewState)
  const backdropImageRef = useRef(backdropImage)
  const toolpathsRef = useRef(toolpaths)
  const selectedOperationIdRef = useRef(selectedOperationId)
  const collidingClampIdsRef = useRef(collidingClampIds)
  const snapSettingsRef = useRef(snapSettings)
  const copyCountDraftRef = useRef(copyCountDraft)

  projectRef.current = project
  selectionRef.current = selection
  pendingAddRef.current = pendingAdd
  pendingMoveRef.current = pendingMove
  pendingTransformRef.current = pendingTransform
  pendingOffsetRef.current = pendingOffset
  pendingShapeActionRef.current = pendingShapeAction
  viewStateRef.current = viewState
  backdropImageRef.current = backdropImage
  toolpathsRef.current = toolpaths
  selectedOperationIdRef.current = selectedOperationId
  collidingClampIdsRef.current = collidingClampIds
  snapSettingsRef.current = snapSettings
  copyCountDraftRef.current = copyCountDraft
  dimensionEditRef.current = dimensionEdit

  function updateActiveSnap(nextSnap: ResolvedSnap | null) {
    activeSnapRef.current = nextSnap?.mode ? nextSnap : null
    onActiveSnapModeChange?.(nextSnap?.mode ?? null)
    scheduleDraw()
  }

  function setPendingPreviewPointRef(nextPoint: PendingPreviewPoint | null) {
    pendingPreviewPointRef.current = nextPoint
    scheduleDraw()
  }

  function setPendingMovePreviewPointRef(nextPoint: PendingPreviewPoint | null) {
    pendingMovePreviewPointRef.current = nextPoint
    scheduleDraw()
  }

  function setPendingTransformPreviewPointRef(nextPoint: PendingPreviewPoint | null) {
    pendingTransformPreviewPointRef.current = nextPoint
    scheduleDraw()
  }

  function setPendingOffsetPreviewPointRef(nextPoint: PendingPreviewPoint | null) {
    pendingOffsetPreviewPointRef.current = nextPoint
    scheduleDraw()
  }

  function setPendingOffsetRawPreviewPointRef(nextPoint: PendingPreviewPoint | null) {
    pendingOffsetRawPreviewPointRef.current = nextPoint
    scheduleDraw()
  }

  function isActiveSnapPoint(point: Point | null | undefined): boolean {
    return !!point && !!activeSnapRef.current?.mode && pointsEqual(point, activeSnapRef.current.point, 1e-6)
  }

  function currentSnapReferencePoint(): Point | null {
    const pendingMove = pendingMoveRef.current
    const pendingTransform = pendingTransformRef.current
    const pendingAdd = pendingAddRef.current

    if (pendingMove?.fromPoint) {
      return pendingMove.fromPoint
    }

    if (pendingTransform?.mode === 'rotate') {
      return pendingTransform.referenceStart
    }

    if ((pendingAdd?.shape === 'rect' || pendingAdd?.shape === 'circle' || pendingAdd?.shape === 'tab' || pendingAdd?.shape === 'clamp') && pendingAdd.anchor) {
      return pendingAdd.anchor
    }

    if ((pendingAdd?.shape === 'polygon' || pendingAdd?.shape === 'spline') && pendingAdd.points.length > 0) {
      return pendingAdd.points[pendingAdd.points.length - 1]
    }

    if (pendingAdd?.shape === 'composite') {
      return pendingAdd.pendingArcEnd ?? pendingAdd.lastPoint ?? pendingAdd.start ?? null
    }

    return null
  }

  function requiresResolvedSnapForPointPick(): boolean {
    const snapSettings = snapSettingsRef.current
    return snapSettings.enabled && snapSettings.modes.length > 0
  }

  function pushSnapCandidate(
    candidates: SnapCandidate[],
    rawPoint: Point,
    vt: ViewTransform,
    snapRadiusPx: number,
    mode: SnapMode,
    point: Point,
    guide?: SnapGuide,
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

      if (activeModes.has('center') && segment.type === 'arc') {
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

  function resolveSketchSnap(
    rawPoint: Point,
    vt: ViewTransform,
    options?: {
      excludeActiveEditGeometry?: boolean
    },
  ): ResolvedSnap {
    const snapSettings = snapSettingsRef.current
    const project = projectRef.current
    const selection = selectionRef.current

    if (!snapSettings.enabled || snapSettings.modes.length === 0) {
      return { rawPoint, point: rawPoint, mode: null }
    }

    const activeModes = new Set(snapSettings.modes)
    const snapRadiusPx = snapSettings.pixelRadius
    const candidates: SnapCandidate[] = []
    const referencePoint = currentSnapReferencePoint()
    const excludedFeatureId =
      options?.excludeActiveEditGeometry && selection.selectedNode?.type === 'feature'
        ? selection.selectedNode.featureId
        : null
    const excludedTabId =
      options?.excludeActiveEditGeometry && selection.selectedNode?.type === 'tab'
        ? selection.selectedNode.tabId
        : null
    const excludedClampId =
      options?.excludeActiveEditGeometry && selection.selectedNode?.type === 'clamp'
        ? selection.selectedNode.clampId
        : null

    if (activeModes.has('grid')) {
      const gridPoint = {
        x: snap(rawPoint.x, project.grid.snapIncrement),
        y: snap(rawPoint.y, project.grid.snapIncrement),
      }
      pushSnapCandidate(candidates, rawPoint, vt, snapRadiusPx, 'grid', gridPoint)
    }

    addProfileSnapCandidates(candidates, project.stock.profile, rawPoint, vt, snapRadiusPx, activeModes, referencePoint)

    for (const feature of project.features) {
      if (!feature.visible || feature.id === excludedFeatureId) {
        continue
      }
      addProfileSnapCandidates(candidates, feature.sketch.profile, rawPoint, vt, snapRadiusPx, activeModes, referencePoint)
    }

    for (const tab of project.tabs) {
      if (!tab.visible || tab.id === excludedTabId) {
        continue
      }
      addProfileSnapCandidates(candidates, rectProfile(tab.x, tab.y, tab.w, tab.h), rawPoint, vt, snapRadiusPx, activeModes, referencePoint)
    }

    for (const clamp of project.clamps) {
      if (!clamp.visible || clamp.id === excludedClampId) {
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
    }
  }

  useEffect(() => {
    if (!project.backdrop?.imageDataUrl) {
      setBackdropImage(null)
      setBackdropImageLoading(false)
      return
    }

    setBackdropImage(null)
    const image = new Image()
    image.onload = () => {
      setBackdropImage(image)
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          setBackdropImageLoading(false)
        })
      })
    }
    image.onerror = () => {
      setBackdropImage(null)
      setBackdropImageLoading(false)
    }
    image.src = project.backdrop.imageDataUrl
  }, [project.backdrop?.imageDataUrl, setBackdropImageLoading])

  useEffect(() => {
    return () => {
      onActiveSnapModeChange?.(null)
    }
  }, [onActiveSnapModeChange])

  useEffect(() => {
    scheduleDraw()
  }, [project, selection, pendingAdd, pendingMove, pendingTransform, pendingOffset, viewState, backdropImage, toolpaths, selectedOperationId, collidingClampIds, snapSettings, copyCountDraft, dimensionEdit])

  useEffect(() => {
    sketchEditPreviewRef.current = null
    pendingSketchExtensionRef.current = null
    pendingSketchFilletRef.current = null
  }, [selection.mode, selection.sketchEditTool, selection.selectedFeatureId])

  useEffect(() => {
    if (selection.mode !== 'sketch_edit') {
      dimensionEditControlRef.current = null
      dimensionEditFeatureIdRef.current = null
      editDimStepsRef.current = []
      editDimStepIndexRef.current = 0
      setDimensionEdit(null)
    }
  }, [selection.mode])

  useEffect(() => {
    pendingOffsetPreviewPointRef.current = null
    pendingOffsetRawPreviewPointRef.current = null
  }, [pendingOffset?.session])

  useEffect(() => {
    if (zoomWindowActive) {
      return
    }

    zoomWindowStartRef.current = null
    zoomWindowCurrentRef.current = null
    scheduleDraw()
  }, [zoomWindowActive])

  useEffect(() => {
    const canvas = canvasRef.current
    const livePoint = livePointerWorldRef.current
    if (!canvas || !livePoint) {
      return
    }

    const project = projectRef.current
    const selection = selectionRef.current
    const pendingAdd = pendingAddRef.current
    const pendingMove = pendingMoveRef.current
    const pendingTransform = pendingTransformRef.current
    const pendingOffset = pendingOffsetRef.current
    const vt = computeViewTransform(project.stock, canvas.width, canvas.height, viewStateRef.current)
    const resolvedSnap = resolveSketchSnap(livePoint, vt, {
      excludeActiveEditGeometry: isDraggingNodeRef.current,
    })
    const snapped = resolvedSnap.point
    const sketchEditTool = selection.sketchEditTool

    const shouldPreviewSnap =
      !!pendingAdd
      || !!pendingMove
      || !!pendingTransform
      || !!pendingOffset
      || (selection.mode === 'sketch_edit' && (sketchEditTool === 'add_point' || sketchEditTool === 'fillet'))
      || isDraggingNodeRef.current

    updateActiveSnap(shouldPreviewSnap ? resolvedSnap : null)

    if (pendingAdd) {
      if (pendingAdd.shape === 'origin') {
        originPreviewPointRef.current = { point: snapped, session: pendingAdd.session }
        scheduleDraw()
        return
      }
      setPendingPreviewPointRef({ point: snapped, session: pendingAdd.session })
      return
    }

    if (pendingMove) {
      setPendingMovePreviewPointRef({ point: snapped, session: pendingMove.session })
      return
    }

    if (pendingTransform) {
      const constrainedPoint =
        pendingTransform.mode === 'resize' && pendingTransform.referenceStart && pendingTransform.referenceEnd
          ? projectPointOntoLine(snapped, pendingTransform.referenceStart, pendingTransform.referenceEnd)
          : snapped
      setPendingTransformPreviewPointRef({ point: constrainedPoint, session: pendingTransform.session })
      return
    }

    if (pendingOffset) {
      setPendingOffsetRawPreviewPointRef({ point: livePoint, session: pendingOffset.session })
      setPendingOffsetPreviewPointRef({ point: snapped, session: pendingOffset.session })
      return
    }

    if (selection.mode === 'sketch_edit' && selection.selectedNode?.type === 'feature' && selection.selectedFeatureId) {
      const feature = editableFeature()
      if (feature && sketchEditTool === 'add_point') {
        pendingSketchFilletRef.current = null
        if (pendingSketchExtensionRef.current) {
          sketchEditPreviewRef.current = { point: snapped, mode: 'add_point' }
        } else {
          const endpoint = findOpenProfileExtensionEndpoint(feature.sketch.profile, livePoint, vt)
          if (endpoint) {
            sketchEditPreviewRef.current = { point: endpoint.anchor, mode: 'add_point' }
          } else {
            const target = findSketchInsertTarget(feature.sketch.profile, snapped, vt)
            sketchEditPreviewRef.current = target ? { point: target.point, mode: 'add_point' } : null
          }
        }
        scheduleDraw()
        return
      }

      if (feature && sketchEditTool === 'fillet') {
        pendingSketchExtensionRef.current = null
        if (pendingSketchFilletRef.current) {
          sketchEditPreviewRef.current = { point: snapped, mode: 'add_point' }
        }
        scheduleDraw()
      }
    }
  }, [snapSettings, viewState, pendingAdd, pendingMove, pendingTransform, pendingOffset, selection.mode, selection.sketchEditTool, selection.selectedFeatureId, selection.selectedNode])

  drawRef.current = () => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const project = projectRef.current
    const selection = selectionRef.current
    const pendingAdd = pendingAddRef.current
    const pendingMove = pendingMoveRef.current
    const pendingTransform = pendingTransformRef.current
    const pendingOffset = pendingOffsetRef.current
    const viewState = viewStateRef.current
    const backdropImage = backdropImageRef.current
    const toolpaths = toolpathsRef.current
    const selectedOperationId = selectedOperationIdRef.current
    const collidingClampIds = collidingClampIdsRef.current
    const copyCountDraft = copyCountDraftRef.current

    const width = canvas.width
    const height = canvas.height
    const vt = computeViewTransform(project.stock, width, height, viewState)
    const collidingClampIdSet = new Set(collidingClampIds)

    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = '#0f151d'
    ctx.fillRect(0, 0, width, height)

    drawGrid(ctx, vt, width, height, project.stock, project.grid)

    if (project.backdrop?.visible && backdropImage) {
      drawBackdropImage(
        ctx,
        project.backdrop,
        backdropImage,
        vt,
        selection.selectedNode?.type === 'backdrop',
        project.backdrop.name,
      )
    }

    if (project.stock.visible) {
      traceProfilePath(ctx, project.stock.profile, vt)
      ctx.strokeStyle = hexToRgba(project.stock.color, 0.7)
      ctx.lineWidth = 2
      ctx.setLineDash([7, 4])
      ctx.stroke()
      ctx.setLineDash([])

      traceProfilePath(ctx, project.stock.profile, vt)
      ctx.fillStyle = hexToRgba(project.stock.color, 0.12)
      ctx.fill()
    }

    if (project.origin.visible) {
      drawOriginMarker(ctx, project.origin, vt)
    }

    for (const feature of project.features) {
      if (!feature.visible) continue

      const selected = selection.selectedFeatureIds.includes(feature.id)
      const hovered = feature.id === selection.hoveredFeatureId
      const editing = selection.mode === 'sketch_edit' && feature.id === selection.selectedFeatureId

      drawFeature(ctx, feature, vt, project.meta.units, project.meta.showFeatureInfo, selected, hovered, editing)

      if (editing) {
        const editControl = isDraggingNodeRef.current ? selection.activeControl : (dimensionEditControlRef.current ?? selection.activeControl)
        drawSketchControls(ctx, feature.sketch.profile, vt, editControl)
        if (isDraggingNodeRef.current || dimensionEditControlRef.current) {
          drawActiveEditMeasurements(ctx, feature.sketch.profile, vt, project.meta.units, editControl)
        }
      }
    }

    for (const clamp of project.clamps) {
      if (!clamp.visible) continue
      const selected = selection.selectedNode?.type === 'clamp' && selection.selectedNode.clampId === clamp.id
      drawClampFootprint(ctx, clamp, vt, selected, collidingClampIdSet.has(clamp.id))
      if (selection.mode === 'sketch_edit' && selection.selectedNode?.type === 'clamp' && selection.selectedNode.clampId === clamp.id) {
        drawSketchControls(ctx, rectProfile(clamp.x, clamp.y, clamp.w, clamp.h), vt, selection.activeControl)
      }
    }

    for (const tab of project.tabs) {
      if (!tab.visible) continue
      const selected = selection.selectedNode?.type === 'tab' && selection.selectedNode.tabId === tab.id
      drawTabFootprint(ctx, tab, vt, selected)
      if (selection.mode === 'sketch_edit' && selection.selectedNode?.type === 'tab' && selection.selectedNode.tabId === tab.id) {
        drawSketchControls(ctx, rectProfile(tab.x, tab.y, tab.w, tab.h), vt, selection.activeControl)
      }
    }

    for (const toolpath of toolpaths) {
      if (toolpath.moves.length > 0) {
        drawToolpath(ctx, toolpath, vt, toolpath.operationId === selectedOperationId)
      }
    }

    if (marqueeStartRef.current && marqueeCurrentRef.current) {
      const x = Math.min(marqueeStartRef.current.cx, marqueeCurrentRef.current.cx)
      const y = Math.min(marqueeStartRef.current.cy, marqueeCurrentRef.current.cy)
      const w = Math.abs(marqueeCurrentRef.current.cx - marqueeStartRef.current.cx)
      const h = Math.abs(marqueeCurrentRef.current.cy - marqueeStartRef.current.cy)
      ctx.save()
      ctx.fillStyle = 'rgba(91, 165, 216, 0.16)'
      ctx.strokeStyle = 'rgba(123, 199, 246, 0.9)'
      ctx.lineWidth = 1.5
      ctx.setLineDash([6, 4])
      ctx.fillRect(x, y, w, h)
      ctx.strokeRect(x, y, w, h)
      ctx.restore()
    }

    if (zoomWindowStartRef.current && zoomWindowCurrentRef.current) {
      const x = Math.min(zoomWindowStartRef.current.cx, zoomWindowCurrentRef.current.cx)
      const y = Math.min(zoomWindowStartRef.current.cy, zoomWindowCurrentRef.current.cy)
      const w = Math.abs(zoomWindowCurrentRef.current.cx - zoomWindowStartRef.current.cx)
      const h = Math.abs(zoomWindowCurrentRef.current.cy - zoomWindowStartRef.current.cy)
      ctx.save()
      ctx.fillStyle = 'rgba(242, 185, 92, 0.16)'
      ctx.strokeStyle = 'rgba(247, 211, 148, 0.92)'
      ctx.lineWidth = 1.5
      ctx.setLineDash([7, 4])
      ctx.fillRect(x, y, w, h)
      ctx.strokeRect(x, y, w, h)
      ctx.restore()
    }

    const dimensionEdit = dimensionEditRef.current
    const currentPreviewPoint =
      dimensionEdit
        ? computeDimensionEditPreviewPoint(dimensionEdit, project.meta.units)
        : pendingAdd?.shape === 'origin'
          ? (
              originPreviewPointRef.current && originPreviewPointRef.current.session === pendingAdd.session
                ? originPreviewPointRef.current.point
                : null
            )
          : pendingAdd && pendingPreviewPointRef.current?.session === pendingAdd.session
            ? pendingPreviewPointRef.current.point
            : null

    if (pendingAdd?.shape === 'polygon' || pendingAdd?.shape === 'spline') {
      const closePreview =
        currentPreviewPoint && pendingAdd.points.length >= 3
          ? isLoopCloseCandidate(worldToCanvas(currentPreviewPoint, vt), pendingAdd.points, vt)
          : false
      if (pendingAdd.points.length > 0) {
        if (pendingAdd.shape === 'spline') {
          drawPendingSplineLoop(ctx, pendingAdd.points, currentPreviewPoint, vt, closePreview, project.meta.units, isActiveSnapPoint(currentPreviewPoint))
        } else {
          drawPendingPathLoop(
            ctx,
            pendingAdd.points,
            currentPreviewPoint,
            vt,
            closePreview,
            polygonProfile,
            'Pending polygon',
            project.meta.units,
            isActiveSnapPoint(currentPreviewPoint),
          )
        }
      } else if (currentPreviewPoint) {
        drawPendingPoint(ctx, currentPreviewPoint, vt, isActiveSnapPoint(currentPreviewPoint))
      }
    } else if (pendingAdd?.shape === 'composite') {
      drawCompositeDraft(ctx, pendingAdd, currentPreviewPoint, vt, project.meta.units, isActiveSnapPoint(currentPreviewPoint))
    } else if ((pendingAdd?.shape === 'rect' || pendingAdd?.shape === 'circle' || pendingAdd?.shape === 'tab' || pendingAdd?.shape === 'clamp') && pendingAdd.anchor && currentPreviewPoint) {
      const previewProfile = buildPendingProfile(pendingAdd, currentPreviewPoint, project.meta.units)
      const label =
        pendingAdd.shape === 'rect'
          ? 'Pending rectangle'
          : pendingAdd.shape === 'tab'
            ? 'Pending tab'
          : pendingAdd.shape === 'clamp'
            ? 'Pending clamp'
            : 'Pending circle'
      drawPreviewProfile(ctx, previewProfile, vt, label)
      drawPendingPoint(ctx, pendingAdd.anchor, vt)
      drawPendingPoint(ctx, currentPreviewPoint, vt, isActiveSnapPoint(currentPreviewPoint))
      if (pendingAdd.shape === 'circle') {
        drawMoveGuide(ctx, pendingAdd.anchor, currentPreviewPoint, vt)
        drawRadiusMeasurement(ctx, pendingAdd.anchor, currentPreviewPoint, vt, project.meta.units)
      } else {
        drawProfileLineMeasurements(ctx, previewProfile, vt, project.meta.units)
      }
    } else if (pendingAdd?.shape === 'text' && currentPreviewPoint) {
      const previewShapes = generateTextShapes(pendingAdd.config, currentPreviewPoint)
      for (const shape of previewShapes) {
        drawPreviewProfile(ctx, shape.profile, vt, '')
      }
      drawPendingPoint(ctx, currentPreviewPoint, vt, isActiveSnapPoint(currentPreviewPoint))
    } else if (pendingAdd && currentPreviewPoint) {
      drawPendingPoint(ctx, currentPreviewPoint, vt, isActiveSnapPoint(currentPreviewPoint))
    }

    const currentMovePreviewPoint =
      pendingMove && pendingMovePreviewPointRef.current?.session === pendingMove.session
        ? pendingMovePreviewPointRef.current.point
        : null
    const currentTransformPreviewPoint =
      pendingTransform && pendingTransformPreviewPointRef.current?.session === pendingTransform.session
        ? pendingTransformPreviewPointRef.current.point
        : null
    const currentOffsetPreviewPoint =
      pendingOffset && pendingOffsetPreviewPointRef.current?.session === pendingOffset.session
        ? pendingOffsetPreviewPointRef.current.point
        : null
    const currentOffsetRawPreviewPoint =
      pendingOffset && pendingOffsetRawPreviewPointRef.current?.session === pendingOffset.session
        ? pendingOffsetRawPreviewPointRef.current.point
        : null

    if (pendingMove) {
      const targetPoint = pendingMove.toPoint ?? currentMovePreviewPoint

      if (pendingMove.entityType === 'backdrop') {
        if (!project.backdrop || !backdropImage) {
          return
        }

        if (pendingMove.fromPoint && targetPoint) {
          drawMoveGuide(ctx, pendingMove.fromPoint, targetPoint, vt)
          drawPendingPoint(ctx, pendingMove.fromPoint, vt)
          drawLineLengthMeasurement(ctx, pendingMove.fromPoint, targetPoint, vt, project.meta.units)
          drawBackdropImage(
            ctx,
            {
              ...project.backdrop,
              center: {
                x: project.backdrop.center.x + (targetPoint.x - pendingMove.fromPoint.x),
                y: project.backdrop.center.y + (targetPoint.y - pendingMove.fromPoint.y),
              },
            },
            backdropImage,
            vt,
            true,
            'Move preview',
          )
        } else if (currentMovePreviewPoint) {
          drawPendingPoint(ctx, currentMovePreviewPoint, vt, isActiveSnapPoint(currentMovePreviewPoint))
        }
      } else if (pendingMove.entityType === 'feature') {
        const features = pendingMove.entityIds
          .map((featureId) => project.features.find((entry) => entry.id === featureId) ?? null)
          .filter((feature): feature is SketchFeature => feature !== null)
        if (features.length === 0) {
          return
        }

        if (pendingMove.fromPoint && targetPoint) {
          drawMoveGuide(ctx, pendingMove.fromPoint, targetPoint, vt)
          drawPendingPoint(ctx, pendingMove.fromPoint, vt)
          drawLineLengthMeasurement(ctx, pendingMove.fromPoint, targetPoint, vt, project.meta.units)
          for (const feature of features) {
            const previewProfile = translateProfile(
              feature.sketch.profile,
              targetPoint.x - pendingMove.fromPoint.x,
              targetPoint.y - pendingMove.fromPoint.y,
            )
            drawPreviewProfile(ctx, previewProfile, vt, pendingMove.mode === 'copy' ? 'Copy preview' : 'Move preview')
          }
          if (pendingMove.mode === 'copy' && pendingMove.toPoint) {
            const parsedCount = Math.max(1, Math.floor(Number(copyCountDraft) || 1))
            for (let index = 2; index <= parsedCount; index += 1) {
              for (const feature of features) {
                const repeatedPreview = translateProfile(
                  feature.sketch.profile,
                  (targetPoint.x - pendingMove.fromPoint.x) * index,
                  (targetPoint.y - pendingMove.fromPoint.y) * index,
                )
                drawPreviewProfile(ctx, repeatedPreview, vt, `Copy ${index}`)
              }
            }
          }
        } else if (currentMovePreviewPoint) {
          drawPendingPoint(ctx, currentMovePreviewPoint, vt, isActiveSnapPoint(currentMovePreviewPoint))
        }
      } else if (pendingMove.entityType === 'clamp') {
        const clamps = pendingMove.entityIds
          .map((clampId) => project.clamps.find((entry) => entry.id === clampId) ?? null)
          .filter((clamp): clamp is Clamp => clamp !== null)
        if (clamps.length === 0) {
          return
        }

        const targetPoint = pendingMove.toPoint ?? currentMovePreviewPoint

        if (pendingMove.fromPoint && targetPoint) {
          drawMoveGuide(ctx, pendingMove.fromPoint, targetPoint, vt)
          drawPendingPoint(ctx, pendingMove.fromPoint, vt)
          drawLineLengthMeasurement(ctx, pendingMove.fromPoint, targetPoint, vt, project.meta.units)
          for (const clamp of clamps) {
            drawClampFootprint(
              ctx,
              {
                ...clamp,
                x: clamp.x + (targetPoint.x - pendingMove.fromPoint.x),
                y: clamp.y + (targetPoint.y - pendingMove.fromPoint.y),
              },
              vt,
              true,
              false,
            )
          }
          if (pendingMove.mode === 'copy' && pendingMove.toPoint) {
            const parsedCount = Math.max(1, Math.floor(Number(copyCountDraft) || 1))
            for (let index = 2; index <= parsedCount; index += 1) {
              for (const clamp of clamps) {
                drawClampFootprint(
                  ctx,
                  {
                    ...clamp,
                    x: clamp.x + (targetPoint.x - pendingMove.fromPoint.x) * index,
                    y: clamp.y + (targetPoint.y - pendingMove.fromPoint.y) * index,
                  },
                  vt,
                  false,
                  false,
                )
              }
            }
          }
        } else if (currentMovePreviewPoint) {
          drawPendingPoint(ctx, currentMovePreviewPoint, vt, isActiveSnapPoint(currentMovePreviewPoint))
        }
      } else {
        const tabs = pendingMove.entityIds
          .map((tabId) => project.tabs.find((entry) => entry.id === tabId) ?? null)
          .filter((tab): tab is Tab => tab !== null)
        if (tabs.length === 0) {
          return
        }

        const targetPoint = pendingMove.toPoint ?? currentMovePreviewPoint

        if (pendingMove.fromPoint && targetPoint) {
          drawMoveGuide(ctx, pendingMove.fromPoint, targetPoint, vt)
          drawPendingPoint(ctx, pendingMove.fromPoint, vt)
          drawLineLengthMeasurement(ctx, pendingMove.fromPoint, targetPoint, vt, project.meta.units)
          for (const tab of tabs) {
            drawTabFootprint(
              ctx,
              {
                ...tab,
                x: tab.x + (targetPoint.x - pendingMove.fromPoint.x),
                y: tab.y + (targetPoint.y - pendingMove.fromPoint.y),
              },
              vt,
              true,
            )
          }
          if (pendingMove.mode === 'copy' && pendingMove.toPoint) {
            const parsedCount = Math.max(1, Math.floor(Number(copyCountDraft) || 1))
            for (let index = 2; index <= parsedCount; index += 1) {
              for (const tab of tabs) {
                drawTabFootprint(
                  ctx,
                  {
                    ...tab,
                    x: tab.x + (targetPoint.x - pendingMove.fromPoint.x) * index,
                    y: tab.y + (targetPoint.y - pendingMove.fromPoint.y) * index,
                  },
                  vt,
                  false,
                )
              }
            }
          }
        } else if (currentMovePreviewPoint) {
          drawPendingPoint(ctx, currentMovePreviewPoint, vt, isActiveSnapPoint(currentMovePreviewPoint))
        }
      }
    }

    if (pendingTransform) {
      if (pendingTransform.entityType === 'backdrop') {
        if (!project.backdrop || !backdropImage) {
          return
        }

        if (pendingTransform.referenceStart) {
          drawPendingPoint(ctx, pendingTransform.referenceStart, vt)
        }

        if (pendingTransform.referenceEnd) {
          drawPendingPoint(ctx, pendingTransform.referenceEnd, vt)
          drawMoveGuide(ctx, pendingTransform.referenceStart!, pendingTransform.referenceEnd, vt)
          drawLineLengthMeasurement(
            ctx,
            pendingTransform.referenceStart!,
            pendingTransform.referenceEnd,
            vt,
            project.meta.units,
            { prefix: pendingTransform.mode === 'resize' ? 'Ref' : undefined },
          )
        }

        if (pendingTransform.referenceStart && pendingTransform.referenceEnd && currentTransformPreviewPoint) {
          drawPendingPoint(ctx, currentTransformPreviewPoint, vt, isActiveSnapPoint(currentTransformPreviewPoint))
          drawMoveGuide(ctx, pendingTransform.referenceStart, currentTransformPreviewPoint, vt)
          if (pendingTransform.mode === 'resize') {
            drawLineLengthMeasurement(
              ctx,
              pendingTransform.referenceStart,
              currentTransformPreviewPoint,
              vt,
              project.meta.units,
              { prefix: 'Size' },
            )
          } else {
            drawAngleMeasurement(
              ctx,
              pendingTransform.referenceStart,
              pendingTransform.referenceEnd,
              currentTransformPreviewPoint,
              vt,
            )
          }
          const previewBackdrop =
            pendingTransform.mode === 'resize'
              ? resizeBackdropFromReference(project.backdrop, pendingTransform.referenceStart, pendingTransform.referenceEnd, currentTransformPreviewPoint)
              : rotateBackdropFromReference(project.backdrop, pendingTransform.referenceStart, pendingTransform.referenceEnd, currentTransformPreviewPoint)
          if (previewBackdrop) {
            drawBackdropImage(
              ctx,
              previewBackdrop,
              backdropImage,
              vt,
              true,
              pendingTransform.mode === 'resize' ? 'Resize preview' : 'Rotate preview',
            )
          }
        } else if (currentTransformPreviewPoint) {
          drawPendingPoint(ctx, currentTransformPreviewPoint, vt, isActiveSnapPoint(currentTransformPreviewPoint))
        }

        drawDepthLegend(ctx, width, height)
        return
      }

      const features = pendingTransform.entityIds
        .map((featureId) => project.features.find((entry) => entry.id === featureId) ?? null)
        .filter((feature): feature is SketchFeature => feature !== null)

      if (features.length === 0) {
        return
      }

      if (pendingTransform.referenceStart) {
        drawPendingPoint(ctx, pendingTransform.referenceStart, vt)
      }

      if (pendingTransform.referenceEnd) {
        drawPendingPoint(ctx, pendingTransform.referenceEnd, vt)
        drawMoveGuide(ctx, pendingTransform.referenceStart!, pendingTransform.referenceEnd, vt)
        drawLineLengthMeasurement(
          ctx,
          pendingTransform.referenceStart!,
          pendingTransform.referenceEnd,
          vt,
          project.meta.units,
          { prefix: pendingTransform.mode === 'resize' ? 'Ref' : undefined },
        )
      }

      if (pendingTransform.referenceStart && pendingTransform.referenceEnd && currentTransformPreviewPoint) {
        drawPendingPoint(ctx, currentTransformPreviewPoint, vt, isActiveSnapPoint(currentTransformPreviewPoint))
        drawMoveGuide(ctx, pendingTransform.referenceStart, currentTransformPreviewPoint, vt)
        if (pendingTransform.mode === 'resize') {
          drawLineLengthMeasurement(
            ctx,
            pendingTransform.referenceStart,
            currentTransformPreviewPoint,
            vt,
            project.meta.units,
            { prefix: 'Size' },
          )
        } else {
          drawAngleMeasurement(
            ctx,
            pendingTransform.referenceStart,
            pendingTransform.referenceEnd,
            currentTransformPreviewPoint,
            vt,
          )
        }
        for (const feature of features) {
          const previewFeature =
            pendingTransform.mode === 'resize'
              ? resizeFeatureFromReference(feature, pendingTransform.referenceStart, pendingTransform.referenceEnd, currentTransformPreviewPoint)
              : rotateFeatureFromReference(feature, pendingTransform.referenceStart, pendingTransform.referenceEnd, currentTransformPreviewPoint)
          if (previewFeature) {
            drawPreviewProfile(
              ctx,
              previewFeature.sketch.profile,
              vt,
              pendingTransform.mode === 'resize' ? 'Resize preview' : 'Rotate preview',
            )
          }
        }
      } else if (currentTransformPreviewPoint) {
        drawPendingPoint(ctx, currentTransformPreviewPoint, vt, isActiveSnapPoint(currentTransformPreviewPoint))
      }
    }

    if (pendingOffset) {
      const features = pendingOffset.entityIds
        .map((featureId) => project.features.find((entry) => entry.id === featureId) ?? null)
        .filter((feature): feature is SketchFeature => feature !== null)
        .filter((feature) => feature.sketch.profile.closed)
      const rawOffsetPoint = currentOffsetRawPreviewPoint ?? livePointerWorldRef.current ?? activeSnapRef.current?.rawPoint ?? null
      const snappedOffsetPoint = currentOffsetPreviewPoint ?? activeSnapRef.current?.point ?? rawOffsetPoint

      if (snappedOffsetPoint) {
        drawPendingPoint(ctx, snappedOffsetPoint, vt, isActiveSnapPoint(snappedOffsetPoint))
      }

      const previewInput =
        features.length > 0 && rawOffsetPoint && snappedOffsetPoint
          ? resolveOffsetPreview(features, rawOffsetPoint, snappedOffsetPoint, activeSnapRef.current?.mode ?? null, vt)
          : null

      if (previewInput) {
        drawPendingPoint(ctx, previewInput.nearestPoint, vt)
        drawMoveGuide(ctx, previewInput.nearestPoint, snappedOffsetPoint!, vt)
        drawLineLengthMeasurement(ctx, previewInput.nearestPoint, snappedOffsetPoint!, vt, project.meta.units)
        const previewFeatures = previewOffsetFeatures(project, pendingOffset.entityIds, previewInput.signedDistance)
        for (const feature of previewFeatures) {
          drawPreviewProfile(
            ctx,
            feature.sketch.profile,
            vt,
            previewInput.direction === 'in' ? 'Offset in preview' : 'Offset out preview',
          )
        }
      }
    }

    if (selection.mode === 'sketch_edit' && sketchEditPreviewRef.current) {
      if (pendingSketchExtensionRef.current) {
        drawMoveGuide(ctx, pendingSketchExtensionRef.current.anchor, sketchEditPreviewRef.current.point, vt)
        drawPendingPoint(ctx, pendingSketchExtensionRef.current.anchor, vt)
      }
      if (pendingSketchFilletRef.current && editingFeature) {
        drawPendingPoint(ctx, pendingSketchFilletRef.current.corner, vt)
        drawMoveGuide(ctx, pendingSketchFilletRef.current.corner, sketchEditPreviewRef.current.point, vt)
        const previewFeature = filletFeatureFromPoint(editingFeature, pendingSketchFilletRef.current.anchorIndex, sketchEditPreviewRef.current.point)
        if (previewFeature) {
          drawPreviewProfile(ctx, previewFeature.sketch.profile, vt, 'Fillet preview')
        }
      }
      drawSketchEditPreviewPoint(ctx, sketchEditPreviewRef.current, vt)
    }

    drawSnapIndicator(ctx, activeSnapRef.current, vt)
    drawDepthLegend(ctx, width, height)
  }

  function scheduleDraw() {
    if (drawFrameRef.current !== null) {
      return
    }

    drawFrameRef.current = window.requestAnimationFrame(() => {
      drawFrameRef.current = null
      drawRef.current()
    })
  }

  useEffect(() => {
    return () => {
      if (drawFrameRef.current !== null) {
        window.cancelAnimationFrame(drawFrameRef.current)
      }

      const canvas = canvasRef.current
      if (!canvas) {
        return
      }

      const ctx = canvas.getContext('2d')
      if (ctx && typeof (ctx as CanvasRenderingContext2D & { reset?: () => void }).reset === 'function') {
        ;(ctx as CanvasRenderingContext2D & { reset: () => void }).reset()
      }

      canvas.width = 0
      canvas.height = 0
    }
  }, [])

  useEffect(() => {
    if (pendingAdd?.shape === 'composite' && pendingAdd.closed) {
      completePendingComposite()
    }
  }, [completePendingComposite, pendingAdd])

  useEffect(() => {
    if (!copyCountPromptActive) {
      return
    }

    const frame = window.requestAnimationFrame(() => {
      copyCountInputRef.current?.focus({ preventScroll: true })
      copyCountInputRef.current?.select()
    })

    return () => window.cancelAnimationFrame(frame)
  }, [copyCountPromptActive])

  useEffect(() => {
    if (!dimensionEdit) return
    const inputRef =
      dimensionEdit.activeField === 'width' ? widthInputRef
      : dimensionEdit.activeField === 'height' ? heightInputRef
      : dimensionEdit.activeField === 'radius' ? radiusInputRef
      : dimensionEdit.activeField === 'length' ? widthInputRef
      : heightInputRef  // angle
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true })
      inputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [dimensionEdit?.activeField, !dimensionEdit])

  useEffect(() => {
    if (!pendingAdd) {
      setDimensionEdit(null)
    }
  }, [pendingAdd])

  useImperativeHandle(ref, () => ({
    zoomToModel: () => {
      const canvas = canvasRef.current
      if (!canvas) return
      setViewState(computeFitViewState(project, canvas.width, canvas.height))
    },
  }), [project])

  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return

    const resizeObserver = new ResizeObserver(() => {
      canvas.width = container.clientWidth
      canvas.height = container.clientHeight
      drawRef.current()
    })

    resizeObserver.observe(container)
    canvas.width = container.clientWidth
    canvas.height = container.clientHeight
    drawRef.current()

    return () => resizeObserver.disconnect()
  }, [])

  useEffect(() => {
    if (copyCountPromptActive) {
      return
    }

    if (selection.mode !== 'sketch_edit' && !pendingMove && !pendingTransform && !pendingOffset && !pendingShapeAction) {
      return
    }

    const frame = window.requestAnimationFrame(() => {
      canvasRef.current?.focus({ preventScroll: true })
    })

    return () => window.cancelAnimationFrame(frame)
  }, [copyCountPromptActive, pendingMove, pendingTransform, pendingOffset, pendingShapeAction, selection.mode, selection.selectedFeatureId, selection.selectedFeatureIds.length])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) {
      return
    }

    function handleNativePointerMove(event: PointerEvent) {
      const coalesced = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : []
      const sourceEvent = coalesced.length > 0 ? coalesced[coalesced.length - 1] : event
      handleCanvasPointerMove(canvasCoordinates(sourceEvent))
    }

    canvas.addEventListener('pointermove', handleNativePointerMove)
    return () => {
      canvas.removeEventListener('pointermove', handleNativePointerMove)
    }
  }, [copyCountPromptActive, pendingMove, pendingTransform, selection.mode, selection.selectedFeatureId, selection.selectedFeatureIds.length, zoomWindowActive])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) {
      return
    }

    function handleNativeWheel(event: globalThis.WheelEvent) {
      handleWheelEvent(event)
    }

    canvas.addEventListener('wheel', handleNativeWheel, { passive: false })
    return () => {
      canvas.removeEventListener('wheel', handleNativeWheel)
    }
  }, [zoomWindowActive])

  function canvasCoordinates(event: Pick<MouseEvent<HTMLCanvasElement> | WheelEvent<HTMLCanvasElement> | globalThis.WheelEvent, 'clientX' | 'clientY'>): CanvasPoint {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { cx: event.clientX - rect.left, cy: event.clientY - rect.top }
  }

  function editableFeature(): SketchFeature | null {
    const selection = selectionRef.current
    const project = projectRef.current
    if (selection.mode !== 'sketch_edit') return null
    if (selection.selectedFeatureIds.length !== 1) return null
    if (!selection.selectedFeatureId) return null
    return project.features.find((feature) => feature.id === selection.selectedFeatureId) ?? null
  }

  function editableClamp(): Clamp | null {
    const selection = selectionRef.current
    const project = projectRef.current
    if (selection.mode !== 'sketch_edit') return null
    const selectedNode = selection.selectedNode
    if (selectedNode?.type !== 'clamp') return null
    return project.clamps.find((clamp) => clamp.id === selectedNode.clampId) ?? null
  }

  function editableTab(): Tab | null {
    const selection = selectionRef.current
    const project = projectRef.current
    if (selection.mode !== 'sketch_edit') return null
    const selectedNode = selection.selectedNode
    if (selectedNode?.type !== 'tab') return null
    return project.tabs.find((tab) => tab.id === selectedNode.tabId) ?? null
  }

  function hitEditableControl(point: CanvasPoint): SketchControlRef | null {
    const feature = editableFeature()
    const clamp = editableClamp()
    const tab = editableTab()
    const canvas = canvasRef.current
    if (!canvas) return null

    const profile =
      feature
        ? feature.sketch.profile
        : clamp
          ? rectProfile(clamp.x, clamp.y, clamp.w, clamp.h)
          : tab
            ? rectProfile(tab.x, tab.y, tab.w, tab.h)
          : null
    if (!profile || (feature && feature.locked)) return null

    const vt = computeViewTransform(projectRef.current.stock, canvas.width, canvas.height, viewStateRef.current)
    const vertices = profileVertices(profile)
    let bestControl: SketchControlRef | null = null
    let bestDistanceSq = NODE_HIT_RADIUS * NODE_HIT_RADIUS

    for (let index = 0; index < vertices.length; index += 1) {
      const nodeCanvas = worldToCanvas(vertices[index], vt)
      const d2 = distance2(point, nodeCanvas)
      if (d2 <= bestDistanceSq) {
        bestDistanceSq = d2
        bestControl = { kind: 'anchor', index }
      }
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
        const handleCanvas = worldToCanvas(outgoingSegment.control1, vt)
        const d2 = distance2(point, handleCanvas)
        if (d2 <= Math.min(bestDistanceSq, HANDLE_HIT_RADIUS * HANDLE_HIT_RADIUS)) {
          bestDistanceSq = d2
          bestControl = { kind: 'out_handle', index }
        }
      }

      if (incomingSegment?.type === 'bezier') {
        const handleCanvas = worldToCanvas(incomingSegment.control2, vt)
        const d2 = distance2(point, handleCanvas)
        if (d2 <= Math.min(bestDistanceSq, HANDLE_HIT_RADIUS * HANDLE_HIT_RADIUS)) {
          bestDistanceSq = d2
          bestControl = { kind: 'in_handle', index }
        }
      }
    }

    for (let index = 0; index < profile.segments.length; index += 1) {
      const segment = profile.segments[index]
      if (segment.type !== 'arc') {
        continue
      }

      const handleCanvas = worldToCanvas(arcControlPoint(anchorPointForIndex(profile, index), segment), vt)
      const d2 = distance2(point, handleCanvas)
      if (d2 <= Math.min(bestDistanceSq, HANDLE_HIT_RADIUS * HANDLE_HIT_RADIUS)) {
        bestDistanceSq = d2
        bestControl = { kind: 'arc_handle', index }
      }
    }

    return bestControl
  }

  function handleMouseDown(event: MouseEvent<HTMLCanvasElement>) {
    const pendingShapeAction = pendingShapeActionRef.current
    const point = canvasCoordinates(event)

    if (zoomWindowActive && event.button === 0) {
      zoomWindowStartRef.current = point
      zoomWindowCurrentRef.current = point
      hoverFeature(null)
      updateActiveSnap(null)
      scheduleDraw()
      return
    }

    const shiftStartsPan = event.button === 0 && event.shiftKey && !pendingShapeAction
    if (event.button === 1 || event.button === 2 || shiftStartsPan) {
      isPanningRef.current = true
      didPanRef.current = false
      lastPanPointRef.current = point
      return
    }

    if (pendingOffsetRef.current) {
      return
    }

    if (selectionRef.current.mode === 'sketch_edit' && selectionRef.current.sketchEditTool) {
      return
    }

    const canvas = canvasRef.current
    if (!canvas) {
      return
    }

    const project = projectRef.current
    const vt = computeViewTransform(project.stock, canvas.width, canvas.height, viewStateRef.current)
    const world = canvasToWorld(point.cx, point.cy, vt)
    const control = hitEditableControl(point)
    const hitClampId = findHitClampId(world, project.clamps)
    const hitTabId = findHitTabId(world, project.tabs)
    const hitFeatureId = findHitFeatureId(world, project.features, vt)
    if (!control && !hitClampId && !hitTabId && !hitFeatureId) {
      marqueeStartRef.current = point
      marqueeCurrentRef.current = point
      scheduleDraw()
      return
    }

    if (!control) {
      return
    }

    beginHistoryTransaction()
    setActiveControl(control)
    isDraggingNodeRef.current = true
  }

  function handleCanvasPointerMove(point: CanvasPoint) {
    const canvas = canvasRef.current
    if (!canvas) return

    const project = projectRef.current
    const selection = selectionRef.current
    const pendingAdd = pendingAddRef.current
    const pendingMove = pendingMoveRef.current
    const pendingTransform = pendingTransformRef.current
    const pendingOffset = pendingOffsetRef.current
    const vt = computeViewTransform(project.stock, canvas.width, canvas.height, viewStateRef.current)
    const world = canvasToWorld(point.cx, point.cy, vt)
    livePointerWorldRef.current = world
    const sketchEditTool = selection.sketchEditTool

    if (isPanningRef.current && lastPanPointRef.current) {
      sketchEditPreviewRef.current = null
      pendingSketchExtensionRef.current = null
      pendingSketchFilletRef.current = null
      updateActiveSnap(null)
      const dx = point.cx - lastPanPointRef.current.cx
      const dy = point.cy - lastPanPointRef.current.cy
      if (dx !== 0 || dy !== 0) {
        didPanRef.current = true
      }
      lastPanPointRef.current = point
      setViewState((previous) => ({
        ...previous,
        panX: previous.panX + dx,
        panY: previous.panY + dy,
      }))
      return
    }

    if (marqueeStartRef.current) {
      marqueeCurrentRef.current = point
      sketchEditPreviewRef.current = null
      pendingSketchExtensionRef.current = null
      pendingSketchFilletRef.current = null
      hoverFeature(null)
      updateActiveSnap(null)
      scheduleDraw()
      return
    }

    if (zoomWindowStartRef.current) {
      zoomWindowCurrentRef.current = point
      sketchEditPreviewRef.current = null
      pendingSketchExtensionRef.current = null
      pendingSketchFilletRef.current = null
      hoverFeature(null)
      updateActiveSnap(null)
      scheduleDraw()
      return
    }

    const shouldPreviewSnap =
      !zoomWindowActive && (
        !!pendingAdd
        || !!pendingMove
        || !!pendingTransform
        || !!pendingOffset
        || (selection.mode === 'sketch_edit' && (sketchEditTool === 'add_point' || sketchEditTool === 'fillet'))
        || isDraggingNodeRef.current
      )
    const resolvedSnap = shouldPreviewSnap
      ? resolveSketchSnap(world, vt, {
          excludeActiveEditGeometry: isDraggingNodeRef.current,
        })
      : { rawPoint: world, point: world, mode: null as null }
    const snapped = resolvedSnap.point
    const constrainedPoint =
      requiresResolvedSnapForPointPick() && !resolvedSnap.mode
        ? null
        : snapped
    updateActiveSnap(shouldPreviewSnap ? resolvedSnap : null)

    if (pendingAdd) {
      sketchEditPreviewRef.current = null
      pendingSketchExtensionRef.current = null
      pendingSketchFilletRef.current = null
      hoverFeature(null)
      if (pendingAdd.shape === 'origin') {
        originPreviewPointRef.current = { point: snapped, session: pendingAdd.session }
        scheduleDraw()
        return
      }
      setPendingPreviewPointRef({ point: snapped, session: pendingAdd.session })
      return
    }

    if (pendingMove) {
      sketchEditPreviewRef.current = null
      pendingSketchExtensionRef.current = null
      pendingSketchFilletRef.current = null
      hoverFeature(null)
      setPendingMovePreviewPointRef({ point: snapped, session: pendingMove.session })
      return
    }

    if (pendingTransform) {
      sketchEditPreviewRef.current = null
      pendingSketchExtensionRef.current = null
      pendingSketchFilletRef.current = null
      hoverFeature(null)
      const constrainedPoint =
        pendingTransform.mode === 'resize' && pendingTransform.referenceStart && pendingTransform.referenceEnd
          ? projectPointOntoLine(snapped, pendingTransform.referenceStart, pendingTransform.referenceEnd)
          : snapped
      setPendingTransformPreviewPointRef({ point: constrainedPoint, session: pendingTransform.session })
      return
    }

    if (pendingOffset) {
      sketchEditPreviewRef.current = null
      pendingSketchExtensionRef.current = null
      pendingSketchFilletRef.current = null
      hoverFeature(null)
      setPendingOffsetRawPreviewPointRef({ point: world, session: pendingOffset.session })
      setPendingOffsetPreviewPointRef({ point: snapped, session: pendingOffset.session })
      return
    }

    if (isDraggingNodeRef.current && selection.selectedFeatureId && selection.activeControl) {
      sketchEditPreviewRef.current = null
      pendingSketchExtensionRef.current = null
      pendingSketchFilletRef.current = null
      if (!constrainedPoint) {
        scheduleDraw()
        return
      }
      moveFeatureControl(selection.selectedFeatureId, selection.activeControl, constrainedPoint)
      return
    }

    if (isDraggingNodeRef.current && selection.selectedNode?.type === 'clamp' && selection.activeControl) {
      sketchEditPreviewRef.current = null
      pendingSketchExtensionRef.current = null
      pendingSketchFilletRef.current = null
      if (!constrainedPoint) {
        scheduleDraw()
        return
      }
      moveClampControl(selection.selectedNode.clampId, selection.activeControl, constrainedPoint)
      return
    }

    if (isDraggingNodeRef.current && selection.selectedNode?.type === 'tab' && selection.activeControl) {
      sketchEditPreviewRef.current = null
      pendingSketchExtensionRef.current = null
      pendingSketchFilletRef.current = null
      if (!constrainedPoint) {
        scheduleDraw()
        return
      }
      moveTabControl(selection.selectedNode.tabId, selection.activeControl, constrainedPoint)
      return
    }

    if (selection.mode === 'sketch_edit' && selection.selectedNode?.type === 'feature' && selection.selectedFeatureId) {
      const feature = editableFeature()
      if (feature && sketchEditTool === 'add_point') {
        pendingSketchFilletRef.current = null
        if (pendingSketchExtensionRef.current) {
          sketchEditPreviewRef.current = { point: snapped, mode: 'add_point' }
        } else {
          const endpoint = findOpenProfileExtensionEndpoint(feature.sketch.profile, world, vt)
          if (endpoint) {
            sketchEditPreviewRef.current = { point: endpoint.anchor, mode: 'add_point' }
          } else {
            const target = findSketchInsertTarget(feature.sketch.profile, snapped, vt)
            sketchEditPreviewRef.current =
              target
                ? { point: target.point, mode: 'add_point' }
                : null
          }
        }
        scheduleDraw()
        hoverFeature(null)
        return
      }

      if (feature && sketchEditTool === 'delete_point') {
        pendingSketchExtensionRef.current = null
        pendingSketchFilletRef.current = null
        const control = hitEditableControl(point)
        sketchEditPreviewRef.current =
          control?.kind === 'anchor'
            ? { point: anchorPointForIndex(feature.sketch.profile, control.index), mode: 'delete_point' }
            : null
        scheduleDraw()
        hoverFeature(null)
        return
      }

      if (feature && sketchEditTool === 'fillet') {
        pendingSketchExtensionRef.current = null
        if (pendingSketchFilletRef.current) {
          sketchEditPreviewRef.current = { point: snapped, mode: 'add_point' }
        } else {
          const control = hitEditableControl(point)
          if (control?.kind === 'anchor') {
            const corner = anchorPointForIndex(feature.sketch.profile, control.index)
            sketchEditPreviewRef.current = { point: corner, mode: 'add_point' }
          } else {
            sketchEditPreviewRef.current = null
          }
        }
        scheduleDraw()
        hoverFeature(null)
        return
      }
    }

    sketchEditPreviewRef.current = null
    pendingSketchExtensionRef.current = null
    pendingSketchFilletRef.current = null

    const hitTabId = findHitTabId(world, project.tabs)
    if (hitTabId) {
      hoverFeature(null)
      return
    }

    const hitId = findHitFeatureId(world, project.features, vt)
    hoverFeature(hitId)
  }

  function stopNodeDrag() {
    if (!isDraggingNodeRef.current && selection.activeControl === null) return
    isDraggingNodeRef.current = false
    setActiveControl(null)
    commitHistoryTransaction()
  }

  function stopPan() {
    isPanningRef.current = false
    lastPanPointRef.current = null
  }

  function handleMouseUp() {
    const canvas = canvasRef.current
    const project = projectRef.current
    if (canvas && zoomWindowStartRef.current && zoomWindowCurrentRef.current) {
      const dx = zoomWindowCurrentRef.current.cx - zoomWindowStartRef.current.cx
      const dy = zoomWindowCurrentRef.current.cy - zoomWindowStartRef.current.cy
      const movedEnough = Math.hypot(dx, dy) >= 6
      if (movedEnough) {
        const vt = computeViewTransform(project.stock, canvas.width, canvas.height, viewStateRef.current)
        const startWorld = canvasToWorld(zoomWindowStartRef.current.cx, zoomWindowStartRef.current.cy, vt)
        const endWorld = canvasToWorld(zoomWindowCurrentRef.current.cx, zoomWindowCurrentRef.current.cy, vt)
        setViewState(
          computeFitViewStateForBounds(
            project.stock,
            {
              minX: Math.min(startWorld.x, endWorld.x),
              maxX: Math.max(startWorld.x, endWorld.x),
              minY: Math.min(startWorld.y, endWorld.y),
              maxY: Math.max(startWorld.y, endWorld.y),
            },
            canvas.width,
            canvas.height,
          ),
        )
      }
      suppressClickRef.current = true
      zoomWindowStartRef.current = null
      zoomWindowCurrentRef.current = null
      scheduleDraw()
      onZoomWindowComplete?.()
    }

    if (canvas && marqueeStartRef.current && marqueeCurrentRef.current) {
      const dx = marqueeCurrentRef.current.cx - marqueeStartRef.current.cx
      const dy = marqueeCurrentRef.current.cy - marqueeStartRef.current.cy
      const movedEnough = Math.hypot(dx, dy) >= 6
      if (movedEnough) {
        const vt = computeViewTransform(project.stock, canvas.width, canvas.height, viewStateRef.current)
        const startWorld = canvasToWorld(marqueeStartRef.current.cx, marqueeStartRef.current.cy, vt)
        const endWorld = canvasToWorld(marqueeCurrentRef.current.cx, marqueeCurrentRef.current.cy, vt)
        const minX = Math.min(startWorld.x, endWorld.x)
        const minY = Math.min(startWorld.y, endWorld.y)
        const maxX = Math.max(startWorld.x, endWorld.x)
        const maxY = Math.max(startWorld.y, endWorld.y)
        const enclosedIds = project.features
          .filter((feature) => feature.visible)
          .filter((feature) => featureFullyInsideRect(feature, minX, minY, maxX, maxY))
          .map((feature) => feature.id)
        const nextIds = [...selectionRef.current.selectedFeatureIds, ...enclosedIds]
          .filter((id, index, array) => array.indexOf(id) === index)
        if (nextIds.length > 0) {
          selectFeatures(nextIds)
        }
        suppressClickRef.current = true
      }
      marqueeStartRef.current = null
      marqueeCurrentRef.current = null
      scheduleDraw()
    }
    stopNodeDrag()
    stopPan()
  }

  function handleMouseLeave() {
    marqueeStartRef.current = null
    marqueeCurrentRef.current = null
    zoomWindowStartRef.current = null
    zoomWindowCurrentRef.current = null
    stopNodeDrag()
    stopPan()
    livePointerWorldRef.current = null
    sketchEditPreviewRef.current = null
    pendingSketchFilletRef.current = null
    pendingSketchExtensionRef.current = null
    setPendingOffsetPreviewPointRef(null)
    setPendingOffsetRawPreviewPointRef(null)
    hoverFeature(null)
    updateActiveSnap(null)
    if (pendingAdd?.shape === 'polygon' || pendingAdd?.shape === 'spline' || pendingAdd?.shape === 'composite') {
      setPendingPreviewPointRef(null)
    } else if (pendingAdd?.shape === 'origin') {
      originPreviewPointRef.current = null
      scheduleDraw()
    } else if ((pendingAdd?.shape === 'rect' || pendingAdd?.shape === 'circle' || pendingAdd?.shape === 'tab' || pendingAdd?.shape === 'clamp') && pendingAdd.anchor) {
      setPendingPreviewPointRef({ point: pendingAdd.anchor, session: pendingAdd.session })
    } else {
      setPendingPreviewPointRef(null)
    }
    if (pendingMove?.fromPoint) {
      setPendingMovePreviewPointRef({
        point: pendingMove.toPoint ?? pendingMove.fromPoint,
        session: pendingMove.session,
      })
    } else {
      setPendingMovePreviewPointRef(null)
    }
    if (pendingTransform?.referenceStart) {
      setPendingTransformPreviewPointRef({
        point: pendingTransform.referenceEnd ?? pendingTransform.referenceStart,
        session: pendingTransform.session,
      })
    } else {
      setPendingTransformPreviewPointRef(null)
    }
  }

  function handleClick(event: MouseEvent<HTMLCanvasElement>) {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }

    if (zoomWindowActive) {
      return
    }

    if (didPanRef.current) {
      didPanRef.current = false
      return
    }

    const selection = selectionRef.current
    const project = projectRef.current
    const pendingAdd = pendingAddRef.current
    const pendingMove = pendingMoveRef.current
    const pendingTransform = pendingTransformRef.current
    const pendingOffset = pendingOffsetRef.current
    if (isDraggingNodeRef.current) return

    const point = canvasCoordinates(event)
    const canvas = canvasRef.current
    if (!canvas) return

    const vt = computeViewTransform(project.stock, canvas.width, canvas.height, viewStateRef.current)
    const world = canvasToWorld(point.cx, point.cy, vt)
    const resolvedSnap = resolveSketchSnap(world, vt)
    const pickedPoint = requiresResolvedSnapForPointPick() && !resolvedSnap.mode ? null : resolvedSnap.point

    if (selection.mode === 'sketch_edit') {
      if (selection.selectedNode?.type === 'feature' && selection.selectedFeatureId) {
        const feature = editableFeature()
        if (feature && selection.sketchEditTool === 'add_point') {
          if (pendingSketchExtensionRef.current) {
            if (!pickedPoint) {
              return
            }
            insertFeaturePoint(selection.selectedFeatureId, {
              kind: pendingSketchExtensionRef.current.kind,
              point: pickedPoint,
            })
            pendingSketchExtensionRef.current = null
            sketchEditPreviewRef.current = null
            scheduleDraw()
            return
          }

          const endpoint = findOpenProfileExtensionEndpoint(feature.sketch.profile, world, vt)
          if (endpoint) {
            pendingSketchExtensionRef.current = endpoint
            sketchEditPreviewRef.current = { point: endpoint.anchor, mode: 'add_point' }
            scheduleDraw()
            return
          }

          if (!pickedPoint) {
            return
          }

          const target = findSketchInsertTarget(feature.sketch.profile, pickedPoint, vt)
          if (target?.kind === 'segment') {
            insertFeaturePoint(selection.selectedFeatureId, target)
          }
          return
        }

        if (feature && selection.sketchEditTool === 'delete_point') {
          const control = hitEditableControl(point)
          if (control?.kind === 'anchor') {
            deleteFeaturePoint(selection.selectedFeatureId, control.index)
          }
          return
        }

        if (feature && selection.sketchEditTool === 'fillet') {
          if (pendingSketchFilletRef.current) {
            if (!pickedPoint) {
              return
            }
            const radius = filletRadiusFromPoint(feature, pendingSketchFilletRef.current.anchorIndex, pickedPoint)
            if (radius) {
              filletFeaturePoint(selection.selectedFeatureId, pendingSketchFilletRef.current.anchorIndex, radius)
            }
            pendingSketchFilletRef.current = null
            sketchEditPreviewRef.current = null
            scheduleDraw()
            return
          }

          const control = hitEditableControl(point)
          if (control?.kind === 'anchor') {
            pendingSketchFilletRef.current = {
              anchorIndex: control.index,
              corner: anchorPointForIndex(feature.sketch.profile, control.index),
            }
            sketchEditPreviewRef.current = { point: pendingSketchFilletRef.current.corner, mode: 'add_point' }
            scheduleDraw()
          }
          return
        }
      }

      return
    }

    if (dimensionEditRef.current) {
      commitEditDimension()
      return
    }

    if (pendingAdd) {
      if (!pickedPoint) {
        return
      }

      const snapped = pickedPoint

      if (pendingAdd.shape === 'origin') {
        originPreviewPointRef.current = null
        placeOriginAt(snapped)
        setPendingPreviewPointRef(null)
        return
      }

      if (pendingAdd.shape === 'polygon' || pendingAdd.shape === 'spline') {
        const lastPoint = pendingAdd.points[pendingAdd.points.length - 1]
        if (pendingAdd.points.length >= 3 && isLoopCloseCandidate(point, pendingAdd.points, vt)) {
          completePendingPolygon()
          setPendingPreviewPointRef(null)
          return
        }
        if (!lastPoint || lastPoint.x !== snapped.x || lastPoint.y !== snapped.y) {
          addPendingPolygonPoint(snapped)
        }
        setPendingPreviewPointRef({ point: snapped, session: pendingAdd.session })
      } else if ((pendingAdd.shape === 'rect' || pendingAdd.shape === 'circle' || pendingAdd.shape === 'tab' || pendingAdd.shape === 'clamp') && !pendingAdd.anchor) {
        setPendingAddAnchor(snapped)
        setPendingPreviewPointRef({ point: snapped, session: pendingAdd.session })
      } else if (pendingAdd.shape === 'rect' || pendingAdd.shape === 'circle' || pendingAdd.shape === 'tab' || pendingAdd.shape === 'clamp') {
        placePendingAddAt(snapped)
        setPendingPreviewPointRef(null)
      } else if (pendingAdd.shape === 'text') {
        placePendingTextAt(snapped)
        setPendingPreviewPointRef(null)
      } else if (pendingAdd.shape === 'composite') {
        const draftPoints = compositeDraftPoints(pendingAdd)
        const closeCandidate =
          pendingAdd.currentMode !== 'arc' &&
          !pendingAdd.pendingArcEnd &&
          draftPoints.length >= 3 &&
          isLoopCloseCandidate(point, draftPoints, vt)

        if (closeCandidate) {
          completePendingComposite()
          setPendingPreviewPointRef(null)
          return
        }

        addPendingCompositePoint(snapped)
        setPendingPreviewPointRef({ point: snapped, session: pendingAdd.session })
      }
      return
    }

    if (pendingMove) {
      if (!pickedPoint) {
        return
      }

      const snapped = pickedPoint

      if (!pendingMove.fromPoint) {
        setPendingMoveFrom(snapped)
        setPendingMovePreviewPointRef({ point: snapped, session: pendingMove.session })
      } else if (!pendingMove.toPoint) {
        setPendingMoveTo(snapped)
        setPendingMovePreviewPointRef({ point: snapped, session: pendingMove.session })
        setCopyCountDraft('1')
        if (pendingMove.mode === 'move') {
          completePendingMove(snapped)
          setPendingMovePreviewPointRef(null)
        }
      }
      return
    }

    if (pendingTransform) {
      if (!pickedPoint) {
        return
      }

      const snapped = pickedPoint
      const constrainedPoint =
        pendingTransform.mode === 'resize' && pendingTransform.referenceStart && pendingTransform.referenceEnd
          ? projectPointOntoLine(snapped, pendingTransform.referenceStart, pendingTransform.referenceEnd)
          : snapped

      if (!pendingTransform.referenceStart) {
        setPendingTransformReferenceStart(snapped)
        setPendingTransformPreviewPointRef({ point: snapped, session: pendingTransform.session })
      } else if (!pendingTransform.referenceEnd) {
        setPendingTransformReferenceEnd(snapped)
        setPendingTransformPreviewPointRef({ point: snapped, session: pendingTransform.session })
      } else {
        completePendingTransform(constrainedPoint)
        setPendingTransformPreviewPointRef(null)
      }
      return
    }

    if (pendingOffset) {
      const sourceFeatures = pendingOffset.entityIds
        .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
        .filter((feature): feature is SketchFeature => feature !== null)
        .filter((feature) => feature.sketch.profile.closed)
      if (!pickedPoint) {
        return
      }
      const previewInput = resolveOffsetPreview(sourceFeatures, world, pickedPoint, resolvedSnap.mode, vt)
      if (previewInput) {
        completePendingOffset(previewInput.signedDistance)
      } else {
        cancelPendingOffset()
      }
      setPendingOffsetPreviewPointRef(null)
      setPendingOffsetRawPreviewPointRef(null)
      return
    }

    const hitClampId = findHitClampId(world, project.clamps)
    if (hitClampId) {
      selectClamp(hitClampId)
      return
    }

    const hitTabId = findHitTabId(world, project.tabs)
    if (hitTabId) {
      selectTab(hitTabId)
      return
    }

    const hitId = findHitFeatureId(world, project.features, vt)
    if (hitId) {
      selectFeature(hitId, event.metaKey || event.ctrlKey || event.shiftKey)
    } else if (project.backdrop?.visible && hitBackdrop(world, project.backdrop)) {
      selectBackdrop()
    } else if (!(event.metaKey || event.ctrlKey || event.shiftKey)) {
      selectFeature(null)
    }
  }

  function handleWheelEvent(event: Pick<globalThis.WheelEvent, 'clientX' | 'clientY' | 'deltaY' | 'preventDefault'>) {
    if (zoomWindowActive) {
      return
    }

    event.preventDefault()

    const canvas = canvasRef.current
    if (!canvas) return

    const point = canvasCoordinates(event)
    const project = projectRef.current
    const currentViewState = viewStateRef.current
    const base = computeBaseViewTransform(project.stock, canvas.width, canvas.height)
    const vt = computeViewTransform(project.stock, canvas.width, canvas.height, currentViewState)
    const worldBefore = canvasToWorld(point.cx, point.cy, vt)
    const zoomFactor = Math.exp(-event.deltaY * 0.0015)
    const nextZoom = Math.max(MIN_SKETCH_ZOOM, currentViewState.zoom * zoomFactor)
    const nextScale = base.scale * nextZoom

    setViewState({
      zoom: nextZoom,
      panX: point.cx - base.offsetX - worldBefore.x * nextScale,
      panY: point.cy - base.offsetY - worldBefore.y * nextScale,
    })
  }

  function handleDoubleClick(event: MouseEvent<HTMLCanvasElement>) {
    if (zoomWindowActive) {
      return
    }

    const project = projectRef.current
    const pendingAdd = pendingAddRef.current
    const pendingMove = pendingMoveRef.current
    const pendingTransform = pendingTransformRef.current
    const pendingOffset = pendingOffsetRef.current
    if (pendingAdd) {
      if ((pendingAdd.shape === 'polygon' || pendingAdd.shape === 'spline') && pendingAdd.points.length >= 2) {
        event.preventDefault()
        completePendingOpenPath()
        setPendingPreviewPointRef(null)
      }
      return
    }

    if (pendingMove || pendingTransform || pendingOffset) {
      return
    }

    const point = canvasCoordinates(event)
    const canvas = canvasRef.current
    if (!canvas) return

    const vt = computeViewTransform(project.stock, canvas.width, canvas.height, viewStateRef.current)
    const world = canvasToWorld(point.cx, point.cy, vt)
    const hitClampId = findHitClampId(world, project.clamps)
    if (hitClampId) {
      enterClampEdit(hitClampId)
      return
    }
    const hitTabId = findHitTabId(world, project.tabs)
    if (hitTabId) {
      enterTabEdit(hitTabId)
      return
    }
    const hitId = findHitFeatureId(world, project.features, vt)
    if (hitId) enterSketchEdit(hitId)
  }

  function handleContextMenu(event: MouseEvent<HTMLCanvasElement>) {
    event.preventDefault()

    if (zoomWindowActive) {
      return
    }

    if (didPanRef.current) {
      didPanRef.current = false
      return
    }

    const project = projectRef.current
    const selection = selectionRef.current
    const pendingAdd = pendingAddRef.current
    const pendingMove = pendingMoveRef.current
    const pendingTransform = pendingTransformRef.current
    const pendingOffset = pendingOffsetRef.current
    if (pendingAdd) {
      return
    }

    if (pendingMove) {
      return
    }

    if (pendingTransform) {
      return
    }

    if (pendingOffset) {
      return
    }

    const canvas = canvasRef.current
    if (!canvas) return

    const point = canvasCoordinates(event)
    const vt = computeViewTransform(project.stock, canvas.width, canvas.height, viewStateRef.current)
    const world = canvasToWorld(point.cx, point.cy, vt)
    const hitClampId = findHitClampId(world, project.clamps)
    if (hitClampId) {
      selectClamp(hitClampId)
      onClampContextMenu?.(hitClampId, event.clientX, event.clientY)
      return
    }

    const hitTabId = findHitTabId(world, project.tabs)
    if (hitTabId) {
      selectTab(hitTabId)
      onTabContextMenu?.(hitTabId, event.clientX, event.clientY)
      return
    }

    const hitId = findHitFeatureId(world, project.features, vt)
    if (!hitId) {
      return
    }

    if (!selection.selectedFeatureIds.includes(hitId)) {
      selectFeature(hitId)
    }
    onFeatureContextMenu?.(hitId, event.clientX, event.clientY)
  }

  function applyEditDimStep(stepIndex: number, steps: EditDimStep[], featureId: string, units: 'mm' | 'inch') {
    if (stepIndex >= steps.length) {
      cancelEditDimension()
      return
    }
    const step = steps[stepIndex]
    dimensionEditControlRef.current = step.control
    const feature = useProjectStore.getState().project.features.find((f) => f.id === featureId)
    if (!feature) return
    const profile = feature.sketch.profile

    if (step.kind === 'endpoint') {
      const fromPoint = anchorPointForIndex(profile, step.fromAnchorIndex)
      const anchorPos = anchorPointForIndex(profile, step.control.index)
      const dx = anchorPos.x - fromPoint.x
      const dy = anchorPos.y - fromPoint.y
      setDimensionEdit({
        shape: 'composite',
        anchor: fromPoint,
        signX: 1,
        signY: 1,
        activeField: 'length',
        width: '',
        height: '',
        radius: '',
        length: formatLength(Math.hypot(dx, dy), units),
        angle: (Math.atan2(dy, dx) * (180 / Math.PI)).toFixed(2).replace(/\.?0+$/, ''),
      })
    } else {
      const seg = profile.segments[step.control.index]
      if (!seg || seg.type !== 'arc') return
      const arcStart = anchorPointForIndex(profile, step.arcStartAnchorIndex)
      const radius = Math.hypot(arcStart.x - seg.center.x, arcStart.y - seg.center.y)
      const arcMid = arcControlPoint(arcStart, seg)
      setDimensionEdit({
        shape: 'circle',
        anchor: arcMid,
        signX: 1,
        signY: 1,
        activeField: 'radius',
        width: '',
        height: '',
        radius: formatLength(radius, units),
        length: '',
        angle: '',
      })
    }
  }

  function advanceTabInEditMode() {
    const currentEdit = dimensionEditRef.current
    const steps = editDimStepsRef.current
    const stepIndex = editDimStepIndexRef.current
    if (!currentEdit) return

    const step = steps[stepIndex]
    if (step?.kind === 'endpoint' && currentEdit.activeField === 'length') {
      setDimensionEdit({ ...currentEdit, activeField: 'angle' })
      return
    }

    const nextIndex = stepIndex + 1
    editDimStepIndexRef.current = nextIndex
    const featureId = dimensionEditFeatureIdRef.current
    const units = projectRef.current.meta.units
    if (featureId) {
      applyEditDimStep(nextIndex, steps, featureId, units)
    }
  }

  function commitEditDimension() {
    commitHistoryTransaction()
    dimensionEditControlRef.current = null
    dimensionEditFeatureIdRef.current = null
    editDimStepsRef.current = []
    editDimStepIndexRef.current = 0
    setDimensionEdit(null)
    canvasRef.current?.focus({ preventScroll: true })
  }

  function cancelEditDimension() {
    cancelHistoryTransaction()
    dimensionEditControlRef.current = null
    dimensionEditFeatureIdRef.current = null
    editDimStepsRef.current = []
    editDimStepIndexRef.current = 0
    setDimensionEdit(null)
    canvasRef.current?.focus({ preventScroll: true })
  }

  function handleKeyDown(event: KeyboardEvent<HTMLCanvasElement>) {
    const pendingOffset = pendingOffsetRef.current
    const pendingShapeAction = pendingShapeActionRef.current

    if (event.key === 'Tab' && pendingAdd) {
      const currentEdit = dimensionEditRef.current
      const units = projectRef.current.meta.units

      if (
        (pendingAdd.shape === 'rect' || pendingAdd.shape === 'circle' || pendingAdd.shape === 'tab' || pendingAdd.shape === 'clamp')
        && pendingAdd.anchor
      ) {
        event.preventDefault()
        const previewPoint = pendingPreviewPointRef.current?.point ?? pendingAdd.anchor

        if (!currentEdit) {
          if (pendingAdd.shape === 'circle') {
            const r = Math.hypot(previewPoint.x - pendingAdd.anchor.x, previewPoint.y - pendingAdd.anchor.y)
            setDimensionEdit({
              shape: 'circle',
              anchor: pendingAdd.anchor,
              signX: 1,
              signY: 1,
              activeField: 'radius',
              width: '',
              height: '',
              radius: formatLength(r, units),
              length: '',
              angle: '',
            })
          } else {
            const w = Math.abs(previewPoint.x - pendingAdd.anchor.x)
            const h = Math.abs(previewPoint.y - pendingAdd.anchor.y)
            setDimensionEdit({
              shape: pendingAdd.shape,
              anchor: pendingAdd.anchor,
              signX: previewPoint.x >= pendingAdd.anchor.x ? 1 : -1,
              signY: previewPoint.y >= pendingAdd.anchor.y ? 1 : -1,
              activeField: 'width',
              width: formatLength(w, units),
              height: formatLength(h, units),
              radius: '',
              length: '',
              angle: '',
            })
          }
        } else if (currentEdit.shape !== 'circle' && currentEdit.activeField === 'width') {
          setDimensionEdit({ ...currentEdit, activeField: 'height' })
        } else {
          setDimensionEdit(null)
          canvasRef.current?.focus({ preventScroll: true })
        }
        return
      }

      if ((pendingAdd.shape === 'polygon' || pendingAdd.shape === 'spline') && pendingAdd.points.length >= 1) {
        event.preventDefault()
        const fromPoint = pendingAdd.points[pendingAdd.points.length - 1]
        const previewPoint = pendingPreviewPointRef.current?.point ?? fromPoint

        if (!currentEdit) {
          const dx = previewPoint.x - fromPoint.x
          const dy = previewPoint.y - fromPoint.y
          const len = Math.hypot(dx, dy)
          const angleDeg = Math.atan2(dy, dx) * (180 / Math.PI)
          setDimensionEdit({
            shape: pendingAdd.shape,
            anchor: fromPoint,
            signX: 1,
            signY: 1,
            activeField: 'length',
            width: '',
            height: '',
            radius: '',
            length: formatLength(len, units),
            angle: angleDeg.toFixed(2).replace(/\.?0+$/, ''),
          })
        } else if (currentEdit.activeField === 'length') {
          setDimensionEdit({ ...currentEdit, activeField: 'angle' })
        } else {
          setDimensionEdit(null)
          canvasRef.current?.focus({ preventScroll: true })
        }
        return
      }

      if (
        pendingAdd.shape === 'composite'
        && pendingAdd.start
        && !pendingAdd.closed
        && pendingAdd.currentMode === 'arc'
        && pendingAdd.pendingArcEnd
      ) {
        // Arc phase 2: typing a radius for the arc
        event.preventDefault()
        const arcStart = pendingAdd.lastPoint ?? pendingAdd.start
        const arcEnd = pendingAdd.pendingArcEnd
        const previewPoint = pendingPreviewPointRef.current?.point ?? arcEnd

        if (!currentEdit) {
          // Estimate radius from current through-point preview
          const arcSeg = buildArcSegmentFromThreePoints(arcStart, arcEnd, previewPoint)
          const r = arcSeg && arcSeg.type === 'arc'
            ? Math.hypot(arcStart.x - arcSeg.center.x, arcStart.y - arcSeg.center.y)
            : Math.hypot(arcEnd.x - arcStart.x, arcEnd.y - arcStart.y) / 2
          // Use current preview point as anchor to determine which side of the chord the arc center lies on
          setDimensionEdit({
            shape: 'circle',
            anchor: previewPoint,
            arcStart,
            arcEnd,
            arcClockwise: arcSeg?.type === 'arc' ? arcSeg.clockwise : false,
            signX: 1,
            signY: 1,
            activeField: 'radius',
            width: '',
            height: '',
            radius: formatLength(r, units),
            length: '',
            angle: '',
          })
        } else {
          setDimensionEdit(null)
          canvasRef.current?.focus({ preventScroll: true })
        }
        return
      }

      if (
        pendingAdd.shape === 'composite'
        && pendingAdd.start
        && !pendingAdd.closed
        && (
          (pendingAdd.currentMode === 'line' && !pendingAdd.pendingArcEnd)
          || (pendingAdd.currentMode === 'arc' && !pendingAdd.pendingArcEnd)
          || pendingAdd.currentMode === 'spline'
        )
      ) {
        event.preventDefault()
        const fromPoint = pendingAdd.lastPoint ?? pendingAdd.start
        const previewPoint = pendingPreviewPointRef.current?.point ?? fromPoint

        if (!currentEdit) {
          const dx = previewPoint.x - fromPoint.x
          const dy = previewPoint.y - fromPoint.y
          const len = Math.hypot(dx, dy)
          const angleDeg = Math.atan2(dy, dx) * (180 / Math.PI)
          setDimensionEdit({
            shape: 'composite',
            anchor: fromPoint,
            signX: 1,
            signY: 1,
            activeField: 'length',
            width: '',
            height: '',
            radius: '',
            length: formatLength(len, units),
            angle: angleDeg.toFixed(2).replace(/\.?0+$/, ''),
          })
        } else if (currentEdit.activeField === 'length') {
          setDimensionEdit({ ...currentEdit, activeField: 'angle' })
        } else {
          setDimensionEdit(null)
          canvasRef.current?.focus({ preventScroll: true })
        }
        return
      }
    }

    if (event.key === 'Tab' && selection.mode === 'sketch_edit' && !pendingAdd) {
      event.preventDefault()
      const currentEdit = dimensionEditRef.current
      const units = projectRef.current.meta.units

      if (currentEdit && dimensionEditControlRef.current) {
        advanceTabInEditMode()
        return
      }

      const featureId = selection.selectedFeatureId
      if (!featureId) return
      const feature = projectRef.current.features.find((f) => f.id === featureId)
      if (!feature) return

      const profile = feature.sketch.profile
      const activeControl = selection.activeControl

      let steps: EditDimStep[] = []
      if (activeControl?.kind === 'anchor') {
        steps = computeEditDimSteps(profile, activeControl.index)
      } else if (activeControl?.kind === 'arc_handle') {
        steps = [{ kind: 'arc_radius', control: activeControl, arcStartAnchorIndex: activeControl.index }]
      }

      if (steps.length === 0) return

      editDimStepsRef.current = steps
      editDimStepIndexRef.current = 0
      dimensionEditFeatureIdRef.current = featureId
      beginHistoryTransaction()
      applyEditDimStep(0, steps, featureId, units)
      return
    }

    if (
      event.key === 'Backspace'
      && (pendingAdd?.shape === 'polygon' || pendingAdd?.shape === 'spline')
      && !event.repeat
    ) {
      event.preventDefault()
      undoPendingPolygonPoint()
      return
    }

    if (
      event.key === 'Enter'
      && (pendingAdd?.shape === 'polygon' || pendingAdd?.shape === 'spline')
      && pendingAdd.points.length >= 2
    ) {
      completePendingOpenPath()
      setPendingPreviewPointRef(null)
      return
    }

    if (pendingAdd?.shape === 'composite') {
      if (event.key === 'l' || event.key === 'L') {
        setPendingCompositeMode('line')
        return
      }
      if (event.key === 'a' || event.key === 'A') {
        setPendingCompositeMode('arc')
        return
      }
      if (event.key === 's' || event.key === 'S') {
        setPendingCompositeMode('spline')
        return
      }
      if (event.key === 'Backspace') {
        if (event.repeat) {
          return
        }
        event.preventDefault()
        undoPendingCompositeStep()
        return
      }
      if (event.key === 'Enter' && pendingAdd.segments.length >= 1 && !pendingAdd.pendingArcEnd) {
        completePendingOpenComposite()
        setPendingPreviewPointRef(null)
        return
      }
    }

    if (event.key === 'Escape' && pendingAdd) {
      originPreviewPointRef.current = null
      cancelPendingAdd()
      setPendingPreviewPointRef(null)
      setDimensionEdit(null)
      return
    }

    if (event.key === 'Escape' && pendingMove) {
      cancelPendingMove()
      setPendingMovePreviewPointRef(null)
      setCopyCountDraft('1')
      return
    }

    if (event.key === 'Escape' && pendingTransform) {
      cancelPendingTransform()
      setPendingTransformPreviewPointRef(null)
      return
    }

    if (event.key === 'Escape' && pendingOffset) {
      cancelPendingOffset()
      setPendingOffsetPreviewPointRef(null)
      setPendingOffsetRawPreviewPointRef(null)
      return
    }

    if (event.key === 'Escape' && pendingShapeAction) {
      cancelPendingShapeAction()
      return
    }

    if (
      event.key === 'Enter'
      && pendingMove?.mode === 'copy'
      && pendingMove.fromPoint
      && pendingMove.toPoint
    ) {
      const nextCount = Math.max(1, Math.floor(Number(copyCountDraft) || 1))
      completePendingMove(pendingMove.toPoint, nextCount)
      setPendingMovePreviewPointRef(null)
      setCopyCountDraft('1')
      return
    }

    if (event.key === 'Enter' && pendingShapeAction) {
      completePendingShapeAction()
      return
    }

    if (event.key === 'Enter' && selection.mode === 'sketch_edit' && dimensionEditRef.current && dimensionEditControlRef.current) {
      commitEditDimension()
      return
    }

    if (event.key === 'Escape' && selection.mode === 'sketch_edit' && dimensionEditRef.current && dimensionEditControlRef.current) {
      cancelEditDimension()
      return
    }

    if (event.key === 'Enter' && selection.mode === 'sketch_edit') {
      stopNodeDrag()
      applySketchEdit()
      return
    }

    if (event.key === 'Escape' && selection.mode === 'sketch_edit') {
      stopNodeDrag()
      cancelSketchEdit()
    }
  }

  const editingFeature =
    selection.mode === 'sketch_edit' && selection.selectedFeatureId
      ? project.features.find((feature) => feature.id === selection.selectedFeatureId) ?? null
      : null
  const editingClamp = (() => {
    if (selection.mode !== 'sketch_edit') return null
    const selectedNode = selection.selectedNode
    if (selectedNode?.type !== 'clamp') return null
    return project.clamps.find((clamp) => clamp.id === selectedNode.clampId) ?? null
  })()
  const editingTab = (() => {
    if (selection.mode !== 'sketch_edit') return null
    const selectedNode = selection.selectedNode
    if (selectedNode?.type !== 'tab') return null
    return project.tabs.find((tab) => tab.id === selectedNode.tabId) ?? null
  })()
  const editingFeatureHasSelfIntersection =
    editingFeature ? profileHasSelfIntersection(editingFeature.sketch.profile) : false
  const editingFeatureExceedsStock =
    editingFeature
      ? profileExceedsStock(editingFeature.sketch.profile, project.stock)
      : editingClamp
        ? profileExceedsStock(rectProfile(editingClamp.x, editingClamp.y, editingClamp.w, editingClamp.h), project.stock)
        : editingTab
          ? profileExceedsStock(rectProfile(editingTab.x, editingTab.y, editingTab.w, editingTab.h), project.stock)
        : false
  const pendingDraftProfile =
    pendingAdd?.shape === 'polygon' && pendingAdd.points.length >= 3
      ? polygonProfile(pendingAdd.points)
      : pendingAdd?.shape === 'spline' && pendingAdd.points.length >= 3
        ? splineProfile(pendingAdd.points)
        : (pendingAdd?.shape === 'rect' || pendingAdd?.shape === 'circle' || pendingAdd?.shape === 'tab' || pendingAdd?.shape === 'clamp')
            && pendingAdd.anchor
            && pendingPreviewPointRef.current?.session === pendingAdd.session
          ? buildPendingProfile(pendingAdd, pendingPreviewPointRef.current.point, project.meta.units)
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
  const pendingDraftHasSelfIntersection =
    pendingDraftProfile ? profileHasSelfIntersection(pendingDraftProfile) : false
  const pendingDraftExceedsStock =
    pendingDraftProfile ? profileExceedsStock(pendingDraftProfile, project.stock) : false

  return (
    <div ref={containerRef} className="sketch-canvas-container">
      <canvas
        ref={canvasRef}
        className={`sketch-canvas ${pendingAdd || pendingMove || pendingTransform || pendingOffset || pendingShapeAction ? 'sketch-canvas--placing' : ''}`}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
        onContextMenu={handleContextMenu}
        tabIndex={0}
      />
      {dimensionEdit && pendingAdd && (() => {
        const canvas = canvasRef.current
        if (!canvas) return null
        const vt = computeViewTransform(project.stock, canvas.width, canvas.height, viewState)
        const previewPt = computeDimensionEditPreviewPoint(dimensionEdit, project.meta.units)

        function commitDimensionEdit() {
          const edit = dimensionEditRef.current
          if (!edit) return
          const pt = computeDimensionEditPreviewPoint(edit, projectRef.current.meta.units)
          const pendingAdd = pendingAddRef.current
          if ((edit.shape === 'polygon' || edit.shape === 'spline') && (pendingAdd?.shape === 'polygon' || pendingAdd?.shape === 'spline')) {
            addPendingPolygonPoint(pt)
            setPendingPreviewPointRef({ point: pt, session: pendingAdd.session })
            setDimensionEdit(null)
            canvasRef.current?.focus({ preventScroll: true })
          } else if (pendingAdd?.shape === 'composite') {
            addPendingCompositePoint(pt)
            setPendingPreviewPointRef({ point: pt, session: pendingAdd.session })
            setDimensionEdit(null)
            canvasRef.current?.focus({ preventScroll: true })
          } else {
            placePendingAddAt(pt)
            setPendingPreviewPointRef(null)
            setDimensionEdit(null)
          }
        }

        function makeDimInputKeyDown(field: 'width' | 'height' | 'radius' | 'length' | 'angle') {
          return (e: KeyboardEvent<HTMLInputElement>) => {
            e.stopPropagation()
            if (e.key === 'Enter') {
              e.preventDefault()
              commitDimensionEdit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setDimensionEdit(null)
              canvasRef.current?.focus({ preventScroll: true })
            } else if (e.key === 'Tab') {
              e.preventDefault()
              const edit = dimensionEditRef.current
              if (!edit) return
              if (field === 'width') {
                setDimensionEdit({ ...edit, activeField: 'height' })
              } else if (field === 'length') {
                setDimensionEdit({ ...edit, activeField: 'angle' })
              } else {
                setDimensionEdit(null)
                canvasRef.current?.focus({ preventScroll: true })
              }
            }
          }
        }

        if (dimensionEdit.shape === 'polygon' || dimensionEdit.shape === 'spline' || dimensionEdit.shape === 'composite') {
          const fromC = worldToCanvas(dimensionEdit.anchor, vt)
          const toC = worldToCanvas(previewPt, vt)
          const rawDx = toC.cx - fromC.cx
          const rawDy = toC.cy - fromC.cy
          const rawLen = Math.hypot(rawDx, rawDy)
          const displayLen = Math.max(rawLen, 40)
          const dirX = rawLen > 0 ? rawDx / rawLen : 1
          const dirY = rawLen > 0 ? rawDy / rawLen : 0
          const midCx = fromC.cx + dirX * displayLen / 2
          const midCy = fromC.cy + dirY * displayLen / 2
          const perpX = -dirY
          const perpY = dirX
          const rawAngle = Math.atan2(dirY, dirX)
          const angle = rawAngle > Math.PI / 2 || rawAngle < -Math.PI / 2 ? rawAngle + Math.PI : rawAngle
          const lengthLabelX = midCx + perpX * 14
          const lengthLabelY = midCy + perpY * 14
          const angleLabelX = midCx + perpX * 36
          const angleLabelY = midCy + perpY * 36
          return (
            <>
              <input
                key="length"
                ref={widthInputRef}
                className="sketch-dim-input"
                style={{ left: lengthLabelX, top: lengthLabelY, transform: `translate(-50%, -50%) rotate(${angle}rad)` }}
                value={dimensionEdit.length}
                onChange={(e) => setDimensionEdit((prev) => prev ? { ...prev, length: e.target.value } : null)}
                onKeyDown={makeDimInputKeyDown('length')}
                onFocus={(e) => e.currentTarget.select()}
              />
              <input
                key="angle"
                ref={heightInputRef}
                className="sketch-dim-input"
                style={{ left: angleLabelX, top: angleLabelY, transform: `translate(-50%, -50%) rotate(${angle}rad)` }}
                value={dimensionEdit.angle}
                onChange={(e) => setDimensionEdit((prev) => prev ? { ...prev, angle: e.target.value } : null)}
                onKeyDown={makeDimInputKeyDown('angle')}
                onFocus={(e) => e.currentTarget.select()}
              />
            </>
          )
        }

        if (
          pendingAdd.shape !== 'rect' && pendingAdd.shape !== 'circle'
          && pendingAdd.shape !== 'tab' && pendingAdd.shape !== 'clamp'
          && pendingAdd.shape !== 'composite'
        ) return null
        if (pendingAdd.shape !== 'composite' && !pendingAdd.anchor) return null
        if (pendingAdd.shape === 'composite' && !pendingAdd.start) return null

        if (dimensionEdit.shape === 'circle') {
          const anchorC = worldToCanvas(dimensionEdit.anchor, vt)
          const previewC = worldToCanvas(previewPt, vt)
          const rawDx = previewC.cx - anchorC.cx
          const rawDy = previewC.cy - anchorC.cy
          const rawLen = Math.hypot(rawDx, rawDy)
          // Use a minimum display radius so the input stays visible while typing (e.g. "0.75")
          const displayLen = Math.max(rawLen, 40)
          const dirX = rawLen > 0 ? rawDx / rawLen : 1
          const dirY = rawLen > 0 ? rawDy / rawLen : 0
          const displayDx = dirX * displayLen
          const displayDy = dirY * displayLen
          const midX = anchorC.cx + displayDx / 2
          const midY = anchorC.cy + displayDy / 2
          const rawAngle = Math.atan2(displayDy, displayDx)
          const angle = rawAngle > Math.PI / 2 || rawAngle < -Math.PI / 2 ? rawAngle + Math.PI : rawAngle
          const labelX = midX - (displayDy / displayLen) * 11
          const labelY = midY + (displayDx / displayLen) * 11
          return (
            <input
              key="radius"
              ref={radiusInputRef}
              className="sketch-dim-input"
              style={{ left: labelX, top: labelY, transform: `translate(-50%, -50%) rotate(${angle}rad)` }}
              value={dimensionEdit.radius}
              onChange={(e) => setDimensionEdit((prev) => prev ? { ...prev, radius: e.target.value } : null)}
              onKeyDown={makeDimInputKeyDown('radius')}
              onFocus={(e) => e.currentTarget.select()}
            />
          )
        }

        const ax = dimensionEdit.anchor.x
        const ay = dimensionEdit.anchor.y
        const px = previewPt.x
        const py = previewPt.y
        const rectX = Math.min(ax, px)
        const rectY = Math.min(ay, py)
        const rectW = Math.abs(px - ax)
        const rectH = Math.abs(py - ay)

        const topLeft = worldToCanvas({ x: rectX, y: rectY }, vt)
        const topRight = worldToCanvas({ x: rectX + rectW, y: rectY }, vt)
        const widthLabelX = (topLeft.cx + topRight.cx) / 2
        const widthLabelY = topLeft.cy + 11

        const rightTop = worldToCanvas({ x: rectX + rectW, y: rectY }, vt)
        const rightBottom = worldToCanvas({ x: rectX + rectW, y: rectY + rectH }, vt)
        const heightLabelX = rightTop.cx - 11
        const heightLabelY = (rightTop.cy + rightBottom.cy) / 2

        return (
          <>
            <input
              key="width"
              ref={widthInputRef}
              className="sketch-dim-input"
              style={{ left: widthLabelX, top: widthLabelY, transform: 'translate(-50%, -50%)' }}
              value={dimensionEdit.width}
              onChange={(e) => setDimensionEdit((prev) => prev ? { ...prev, width: e.target.value } : null)}
              onKeyDown={makeDimInputKeyDown('width')}
              onFocus={(e) => e.currentTarget.select()}
            />
            <input
              key="height"
              ref={heightInputRef}
              className="sketch-dim-input sketch-dim-input--rotated"
              style={{ left: heightLabelX, top: heightLabelY, transform: 'translate(-50%, -50%) rotate(-90deg)' }}
              value={dimensionEdit.height}
              onChange={(e) => setDimensionEdit((prev) => prev ? { ...prev, height: e.target.value } : null)}
              onKeyDown={makeDimInputKeyDown('height')}
              onFocus={(e) => e.currentTarget.select()}
            />
          </>
        )
      })()}
      {dimensionEdit && selection.mode === 'sketch_edit' && !pendingAdd && (() => {
        const canvas = canvasRef.current
        if (!canvas) return null
        const vt = computeViewTransform(project.stock, canvas.width, canvas.height, viewState)
        const featureId = selection.selectedFeatureId
        if (!featureId) return null

        function makeEditInputKeyDown(_field: 'length' | 'angle' | 'radius') {
          return (e: KeyboardEvent<HTMLInputElement>) => {
            e.stopPropagation()
            if (e.key === 'Enter') {
              e.preventDefault()
              commitEditDimension()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              cancelEditDimension()
            } else if (e.key === 'Tab') {
              e.preventDefault()
              advanceTabInEditMode()
            }
          }
        }

        function handleLiveChange(field: 'length' | 'angle' | 'radius', value: string) {
          const prev = dimensionEditRef.current
          if (!prev) return
          const next = { ...prev, [field]: value }
          setDimensionEdit(next)
          const control = dimensionEditControlRef.current
          const fId = dimensionEditFeatureIdRef.current
          if (!control || !fId) return

          if (control.kind === 'arc_handle') {
            // Arc radius: compute new arc_handle point
            const feature = projectRef.current.features.find((f) => f.id === fId)
            if (!feature) return
            const profile = feature.sketch.profile
            const seg = profile.segments[control.index]
            if (!seg || seg.type !== 'arc') return
            const arcStart = anchorPointForIndex(profile, control.index)
            const newRadius = parseLengthInput(value, projectRef.current.meta.units) ?? 0
            if (newRadius <= 0) return
            const newHandle = arcHandleFromRadius(arcStart, seg, newRadius)
            if (newHandle) moveFeatureControl(fId, control, newHandle)
          } else {
            const pt = computeDimensionEditPreviewPoint(next, projectRef.current.meta.units)
            moveFeatureControl(fId, control, pt)
          }
        }

        // Arc radius step
        if (dimensionEdit.shape === 'circle') {
          const anchorC = worldToCanvas(dimensionEdit.anchor, vt)
          return (
            <input
              key="edit-radius"
              ref={radiusInputRef}
              className="sketch-dim-input"
              style={{ left: anchorC.cx, top: anchorC.cy, transform: 'translate(-50%, -50%)' }}
              value={dimensionEdit.radius}
              onChange={(e) => handleLiveChange('radius', e.target.value)}
              onKeyDown={makeEditInputKeyDown('radius')}
              onFocus={(e) => e.currentTarget.select()}
            />
          )
        }

        // Endpoint (length + angle) step
        const previewPt = computeDimensionEditPreviewPoint(dimensionEdit, project.meta.units)
        const fromC = worldToCanvas(dimensionEdit.anchor, vt)
        const toC = worldToCanvas(previewPt, vt)
        const rawDx = toC.cx - fromC.cx
        const rawDy = toC.cy - fromC.cy
        const rawLen = Math.hypot(rawDx, rawDy)
        const displayLen = Math.max(rawLen, 40)
        const dirX = rawLen > 0 ? rawDx / rawLen : 1
        const dirY = rawLen > 0 ? rawDy / rawLen : 0
        const midCx = fromC.cx + dirX * displayLen / 2
        const midCy = fromC.cy + dirY * displayLen / 2
        const perpX = -dirY
        const perpY = dirX
        const rawAngle = Math.atan2(dirY, dirX)
        const rotAngle = rawAngle > Math.PI / 2 || rawAngle < -Math.PI / 2 ? rawAngle + Math.PI : rawAngle
        const lengthLabelX = midCx + perpX * 14
        const lengthLabelY = midCy + perpY * 14
        const angleLabelX = midCx + perpX * 36
        const angleLabelY = midCy + perpY * 36
        return (
          <>
            <input
              key="edit-length"
              ref={widthInputRef}
              className="sketch-dim-input"
              style={{ left: lengthLabelX, top: lengthLabelY, transform: `translate(-50%, -50%) rotate(${rotAngle}rad)` }}
              value={dimensionEdit.length}
              onChange={(e) => handleLiveChange('length', e.target.value)}
              onKeyDown={makeEditInputKeyDown('length')}
              onFocus={(e) => e.currentTarget.select()}
            />
            <input
              key="edit-angle"
              ref={heightInputRef}
              className="sketch-dim-input"
              style={{ left: angleLabelX, top: angleLabelY, transform: `translate(-50%, -50%) rotate(${rotAngle}rad)` }}
              value={dimensionEdit.angle}
              onChange={(e) => handleLiveChange('angle', e.target.value)}
              onKeyDown={makeEditInputKeyDown('angle')}
              onFocus={(e) => e.currentTarget.select()}
            />
          </>
        )
      })()}
      {selection.mode === 'sketch_edit' && (
        <div className="sketch-edit-banner">
          <div>
            {selection.sketchEditTool === 'add_point'
              ? 'Add Point active. Click a segment to insert a point, or click an open-path end first to start an extension. Press '
              : selection.sketchEditTool === 'delete_point'
                ? 'Delete Point active. Click anchors to remove them. Press '
                : selection.sketchEditTool === 'fillet'
                  ? pendingSketchFilletRef.current
                    ? 'Fillet active. Click a second point to define the corner round. Press '
                    : 'Fillet active. Click a line-line corner to start. Press '
                  : 'Drag nodes to reshape. Hover a node and press Tab to type length/angle. Press '}
            <kbd>Enter</kbd> to apply or <kbd>Esc</kbd> to cancel.
          </div>
          {editingFeatureHasSelfIntersection ? (
            <div className="sketch-banner-warning">This profile self-intersects. 3D/CAM results may be invalid.</div>
          ) : null}
          {editingFeatureExceedsStock ? (
            <div className="sketch-banner-warning">This profile extends outside the stock boundary.</div>
          ) : null}
        </div>
      )}
      {pendingOffset && (
        <div className="sketch-place-banner">
          Move the mouse to preview the offset. Inside creates an inward offset, outside creates an outward offset. Click to commit or press <kbd>Esc</kbd> to cancel.
        </div>
      )}
      {pendingShapeAction && (
        <div className="sketch-place-banner">
          <span>
            {pendingShapeAction.kind === 'join'
              ? pendingShapeAction.entityIds.length < 2
                ? 'Join mode. Shift-click closed features to select at least two.'
                : `Join mode. ${pendingShapeAction.entityIds.length} closed features selected.`
              : !pendingShapeAction.cutterId
                ? 'Cut mode. Click one closed feature to use as the cutter.'
                : pendingShapeAction.targetIds.length === 0
                  ? 'Cut mode. Shift-click closed features that intersect the cutter to select targets.'
                  : `Cut mode. 1 cutter and ${pendingShapeAction.targetIds.length} target${pendingShapeAction.targetIds.length === 1 ? '' : 's'} selected.`}
            {' '}
          </span>
          <label className="sketch-place-toggle">
            <input
              type="checkbox"
              checked={pendingShapeAction.keepOriginals}
              onChange={(event) => setPendingShapeActionKeepOriginals(event.target.checked)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  completePendingShapeAction()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  cancelPendingShapeAction()
                }
              }}
            />
            <span>Keep originals</span>
          </label>
          <span>Press <kbd>Enter</kbd> to confirm or <kbd>Esc</kbd> to cancel.</span>
        </div>
      )}
      {pendingAdd && (
        <div className="sketch-place-banner">
          <div>
            {pendingAdd.shape === 'polygon' || pendingAdd.shape === 'spline'
              ? pendingAdd.points.length === 0
                ? `Click to place the first ${pendingAdd.shape} control point.`
                : pendingAdd.points.length < 2
                  ? 'Click to add one more control point. Press Tab to type length/angle.'
                  : 'Click to add control points. Press Tab to type length/angle. Click the first point to close, or press Enter / double-click to finish open.'
            : pendingAdd.shape === 'origin'
              ? 'Click the sketch to place machine X0 Y0. Z remains manual in Properties.'
            : pendingAdd.shape === 'text'
              ? 'Move the mouse to preview the text, then click to place it.'
            : (pendingAdd.shape === 'rect' || pendingAdd.shape === 'circle' || pendingAdd.shape === 'tab' || pendingAdd.shape === 'clamp') && pendingAdd.anchor
              ? pendingAdd.shape === 'rect'
                ? 'Move the mouse to size the rectangle, then click the opposite corner. Press Tab to type dimensions.'
                : pendingAdd.shape === 'tab'
                  ? 'Move the mouse to size the tab footprint, then click the opposite corner. Press Tab to type dimensions.'
                : pendingAdd.shape === 'clamp'
                  ? 'Move the mouse to size the clamp footprint, then click the opposite corner. Press Tab to type dimensions.'
                : 'Move the mouse to set the radius, then click again to confirm the circle. Press Tab to type the radius.'
              : pendingAdd.shape === 'rect'
                ? 'Click the sketch to set the rectangle corner, then click again to size it.'
                : pendingAdd.shape === 'tab'
                  ? 'Click the sketch to set the tab corner, then click again to size it.'
                : pendingAdd.shape === 'clamp'
                  ? 'Click the sketch to set the clamp corner, then click again to size it.'
                : pendingAdd.shape === 'circle'
                  ? 'Click the sketch to set the circle center, then click again to set the radius.'
                    : !pendingAdd.start
                      ? 'Click to place the first composite point. Press L for line, A for arc, or S for spline.'
                      : pendingAdd.currentMode === 'arc'
                          ? pendingAdd.pendingArcEnd
                            ? 'Click a third point on the arc to define curvature. Press Tab to type position, Backspace to undo.'
                            : 'Click to place the arc end point, then click again to define the arc. Press Tab to type position, L or S to switch modes.'
                          : pendingAdd.currentMode === 'spline'
                            ? 'Click to add a spline segment endpoint. Press Tab to type length/angle. Click the first point to close, or press Enter to finish open.'
                            : 'Click to add connected line segments. Press Tab to type length/angle. Click the first point to close, or press Enter to finish open.'}
            {' '}Press <kbd>Esc</kbd> to cancel.
          </div>
          {pendingDraftHasSelfIntersection ? (
            <div className="sketch-banner-warning">This profile self-intersects. 3D/CAM results may be invalid.</div>
          ) : null}
          {pendingDraftExceedsStock ? (
            <div className="sketch-banner-warning">This profile extends outside the stock boundary.</div>
          ) : null}
        </div>
      )}
      {pendingMove && (
        <div className="sketch-place-banner">
          {pendingMove.mode === 'copy' && pendingMove.fromPoint && pendingMove.toPoint ? (
            <>
              <span>Copies</span>
              <input
                ref={copyCountInputRef}
                className="sketch-place-count"
                type="text"
                inputMode="numeric"
                value={copyCountDraft}
                onChange={(event) => setCopyCountDraft(event.target.value.replace(/[^\d]/g, ''))}
                onFocus={(event) => event.currentTarget.select()}
                onKeyDown={(event) => {
                  event.stopPropagation()
                  if (event.key === 'Enter') {
                    const nextCount = Math.max(1, Math.floor(Number(copyCountDraft) || 1))
                    completePendingMove(pendingMove.toPoint!, nextCount)
                    setPendingMovePreviewPointRef(null)
                    setCopyCountDraft('1')
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    cancelPendingMove()
                    setPendingMovePreviewPointRef(null)
                    setCopyCountDraft('1')
                  }
                }}
                autoFocus
              />
              <span>Press <kbd>Enter</kbd> to confirm, <kbd>Esc</kbd> to cancel.</span>
            </>
          ) : (
            pendingMove.fromPoint
              ? pendingMove.mode === 'copy'
                ? 'Click the copy to point, then enter the copy count. Press Esc to cancel.'
                : 'Click the destination point to complete the move. Press Esc to cancel.'
              : pendingMove.mode === 'copy'
                ? 'Click the copy from point, then click the copy to point. Press Esc to cancel.'
                : 'Click the move from point, then click the move to point. Press Esc to cancel.'
          )}
        </div>
      )}
      {pendingTransform && (
        <div className="sketch-place-banner">
          {pendingTransform.mode === 'resize'
            ? !pendingTransform.referenceStart
              ? 'Click the first resize reference point. Press Esc to cancel.'
              : !pendingTransform.referenceEnd
                ? 'Click the second resize reference point. Press Esc to cancel.'
                : 'Move along the reference line to preview the resized feature, then click to commit. Press Esc to cancel.'
            : !pendingTransform.referenceStart
              ? 'Click the rotation origin. Press Esc to cancel.'
              : !pendingTransform.referenceEnd
                ? 'Click the reference direction point. Press Esc to cancel.'
                : 'Move to preview the rotated feature, then click to commit. Press Esc to cancel.'}
        </div>
      )}
    </div>
  )
})
