import { addPoint, scalePoint, subtractPoint } from './draftGeometry'
import type { CanvasPoint } from './viewTransform'
import type { Point, Segment } from '../../types/project'
import { parseLengthInput } from '../../utils/units'

export interface DimensionEditState {
  shape: 'rect' | 'circle' | 'tab' | 'clamp' | 'polygon' | 'spline' | 'composite'
  anchor: Point
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
  angle: string
}

export type OperationDimEdit =
  | { kind: 'move' | 'copy'; distance: string }
  | { kind: 'scale'; factor: string }
  | { kind: 'rotate'; angle: string }
  | { kind: 'offset'; distance: string }

export function unitDirection(from: Point, to: Point): Point {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const len = Math.hypot(dx, dy)
  if (len <= 1e-9) {
    return { x: 1, y: 0 }
  }
  return { x: dx / len, y: dy / len }
}

export function rotateVector(vector: Point, angleRadians: number): Point {
  const cos = Math.cos(angleRadians)
  const sin = Math.sin(angleRadians)
  return {
    x: vector.x * cos - vector.y * sin,
    y: vector.x * sin + vector.y * cos,
  }
}

export function arcHandleFromRadius(
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

export function computeDimensionEditPreviewPoint(
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

export function computeMoveDistancePreviewPoint(
  fromPoint: Point,
  previewPoint: Point,
  distance: number,
): Point {
  const direction = unitDirection(fromPoint, previewPoint)
  return {
    x: fromPoint.x + direction.x * Math.abs(distance),
    y: fromPoint.y + direction.y * Math.abs(distance),
  }
}

export function computeScalePreviewPoint(
  referenceStart: Point,
  referenceEnd: Point,
  factor: number,
): Point {
  const refVec = subtractPoint(referenceEnd, referenceStart)
  return addPoint(referenceStart, scalePoint(refVec, factor))
}

export function computeScaleFactorFromPreview(
  referenceStart: Point,
  referenceEnd: Point,
  previewPoint: Point,
): string {
  const refVec = subtractPoint(referenceEnd, referenceStart)
  const refLen = Math.hypot(refVec.x, refVec.y)
  if (refLen <= 1e-9) {
    return '1'
  }
  const unit = scalePoint(refVec, 1 / refLen)
  const delta = subtractPoint(previewPoint, referenceStart)
  const projLen = delta.x * unit.x + delta.y * unit.y
  const factor = projLen / refLen
  return factor.toFixed(4).replace(/\.?0+$/, '')
}

export function computeRotatePreviewPoint(
  referenceStart: Point,
  referenceEnd: Point,
  angleDegrees: number,
): Point {
  const refVec = subtractPoint(referenceEnd, referenceStart)
  const rotated = rotateVector(refVec, angleDegrees * Math.PI / 180)
  return addPoint(referenceStart, rotated)
}

export function computeRotateDegreesFromPreview(
  referenceStart: Point,
  referenceEnd: Point,
  previewPoint: Point,
): string {
  const startVec = subtractPoint(referenceEnd, referenceStart)
  const previewVec = subtractPoint(previewPoint, referenceStart)
  const startAngle = Math.atan2(startVec.y, startVec.x)
  const previewAngle = Math.atan2(previewVec.y, previewVec.x)
  let delta = (previewAngle - startAngle) * (180 / Math.PI)
  while (delta <= -180) delta += 360
  while (delta > 180) delta -= 360
  return delta.toFixed(2).replace(/\.?0+$/, '')
}

function normalizeReadableAngle(rawAngle: number): number {
  return rawAngle > Math.PI / 2 || rawAngle < -Math.PI / 2 ? rawAngle + Math.PI : rawAngle
}

export function computeLinearInputLabel(
  from: CanvasPoint,
  to: CanvasPoint,
  offsetPx: number,
  minDisplayLength = 0,
): {
  labelX: number
  labelY: number
  angle: number
  dirX: number
  dirY: number
  perpX: number
  perpY: number
  midX: number
  midY: number
  displayLen: number
} {
  const rawDx = to.cx - from.cx
  const rawDy = to.cy - from.cy
  const rawLen = Math.hypot(rawDx, rawDy)
  const displayLen = Math.max(rawLen, minDisplayLength)
  const dirX = rawLen > 0 ? rawDx / rawLen : 1
  const dirY = rawLen > 0 ? rawDy / rawLen : 0
  const midX = from.cx + dirX * displayLen / 2
  const midY = from.cy + dirY * displayLen / 2
  const perpX = -dirY
  const perpY = dirX
  const angle = normalizeReadableAngle(Math.atan2(dirY, dirX))

  return {
    labelX: midX + perpX * offsetPx,
    labelY: midY + perpY * offsetPx,
    angle,
    dirX,
    dirY,
    perpX,
    perpY,
    midX,
    midY,
    displayLen,
  }
}
