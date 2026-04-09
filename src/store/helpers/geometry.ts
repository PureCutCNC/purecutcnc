import type { Point } from '../../types/project'

export function clonePoint(point: Point): Point {
  return { ...point }
}

export function pointsEqual(a: Point, b: Point, epsilon = 1e-9): boolean {
  return Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon
}

export function addPoint(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y }
}

export function subtractPoint(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y }
}

export function scalePoint(point: Point, scale: number): Point {
  return { x: point.x * scale, y: point.y * scale }
}

export function dotPoint(a: Point, b: Point): number {
  return a.x * b.x + a.y * b.y
}

export function crossPoint(a: Point, b: Point): number {
  return a.x * b.y - a.y * b.x
}

export function pointLength(point: Point): number {
  return Math.hypot(point.x, point.y)
}

export function normalizePoint(point: Point): Point | null {
  const length = pointLength(point)
  if (length <= 1e-9) {
    return null
  }
  return scalePoint(point, 1 / length)
}

export function lerpPoint(a: Point, b: Point, t: number): Point {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  }
}

export function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
