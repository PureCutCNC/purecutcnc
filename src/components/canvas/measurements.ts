import type { SketchControlRef } from '../../store/types'
import type { Point, SketchProfile } from '../../types/project'
import { formatLength } from '../../utils/units'
import { arcControlPoint, anchorPointForIndex } from './profilePrimitives'
import { worldToCanvas } from './viewTransform'
import type { ViewTransform } from './viewTransform'

function lineLength(start: Point, end: Point): number {
  return Math.hypot(end.x - start.x, end.y - start.y)
}

export function drawMeasurementLabel(
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

export function drawLineLengthMeasurement(
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

export function drawArcRadiusMeasurement(
  ctx: CanvasRenderingContext2D,
  start: Point,
  segment: Extract<SketchProfile['segments'][number], { type: 'arc' }>,
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

export function drawRadiusMeasurement(
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

export function drawProfileLineMeasurements(
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

export function drawAngleMeasurement(
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

export function drawActiveEditMeasurements(
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
