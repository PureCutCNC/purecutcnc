import type { SketchControlRef } from '../../store/types'
import { getStockBounds, profileVertices, rectProfile } from '../../types/project'
import type { BackdropImage, Clamp, GridSettings, Point, SketchProfile, Stock, Tab } from '../../types/project'
import { arcControlPoint, anchorPointForIndex, traceProfilePath } from './profilePrimitives'
import { worldToCanvas } from './viewTransform'
import type { ViewTransform } from './viewTransform'

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

export function drawSketchEditPreviewPoint(
  ctx: CanvasRenderingContext2D,
  preview: { point: Point; mode: 'add_point' | 'delete_point' | 'fillet' },
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

export function drawGrid(
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

export function drawBackdropImage(
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
