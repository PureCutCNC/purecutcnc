import type { Point } from '../../../types/project'
import type { PreparedVCarveRegion } from './types'

const EPSILON = 1e-9

export function vec(x: number, y: number): Point {
  return { x, y }
}

export function add(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y }
}

export function sub(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y }
}

export function scale(a: Point, scalar: number): Point {
  return { x: a.x * scalar, y: a.y * scalar }
}

export function dot(a: Point, b: Point): number {
  return a.x * b.x + a.y * b.y
}

export function cross(a: Point, b: Point): number {
  return a.x * b.y - a.y * b.x
}

export function length(a: Point): number {
  return Math.hypot(a.x, a.y)
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function normalize(a: Point): Point {
  const len = length(a)
  if (len <= EPSILON) {
    return { x: 0, y: 0 }
  }
  return { x: a.x / len, y: a.y / len }
}

export function leftNormal(direction: Point): Point {
  return normalize({ x: -direction.y, y: direction.x })
}

export function rightNormal(direction: Point): Point {
  return normalize({ x: direction.y, y: -direction.x })
}

export function signedArea(points: Point[]): number {
  if (points.length < 3) {
    return 0
  }
  let area = 0
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index]
    const b = points[(index + 1) % points.length]
    area += a.x * b.y - b.x * a.y
  }
  return area / 2
}

export function isClockwise(points: Point[]): boolean {
  return signedArea(points) < 0
}

export function closeRing(points: Point[]): Point[] {
  if (points.length === 0) {
    return []
  }
  const first = points[0]
  const last = points[points.length - 1]
  if (Math.abs(first.x - last.x) <= EPSILON && Math.abs(first.y - last.y) <= EPSILON) {
    return points.slice(0, -1)
  }
  return [...points]
}

export function removeDuplicateVertices(points: Point[], epsilon = 1e-7): Point[] {
  if (points.length === 0) {
    return []
  }
  const deduped: Point[] = []
  for (const point of closeRing(points)) {
    const last = deduped[deduped.length - 1]
    if (!last || distance(last, point) > epsilon) {
      deduped.push({ x: point.x, y: point.y })
    }
  }
  if (deduped.length > 1 && distance(deduped[0], deduped[deduped.length - 1]) <= epsilon) {
    deduped.pop()
  }
  return deduped
}

export function removeCollinearVertices(points: Point[], epsilon = 1e-7): Point[] {
  const ring = removeDuplicateVertices(points, epsilon)
  if (ring.length < 3) {
    return ring
  }

  const cleaned: Point[] = []
  for (let index = 0; index < ring.length; index += 1) {
    const prev = ring[(index - 1 + ring.length) % ring.length]
    const current = ring[index]
    const next = ring[(index + 1) % ring.length]
    const a = sub(current, prev)
    const b = sub(next, current)
    if (Math.abs(cross(a, b)) <= epsilon && dot(a, b) >= 0) {
      continue
    }
    cleaned.push(current)
  }

  return cleaned.length >= 3 ? cleaned : ring
}

export function rayLineIntersection(
  rayOrigin: Point,
  rayDirection: Point,
  linePoint: Point,
  lineDirection: Point,
): { point: Point; rayT: number; lineT: number } | null {
  const denom = cross(rayDirection, lineDirection)
  if (Math.abs(denom) <= EPSILON) {
    return null
  }
  const delta = sub(linePoint, rayOrigin)
  const rayT = cross(delta, lineDirection) / denom
  const lineT = cross(delta, rayDirection) / denom
  return {
    point: add(rayOrigin, scale(rayDirection, rayT)),
    rayT,
    lineT,
  }
}

export function pointOnSegment(point: Point, start: Point, end: Point, epsilon = 1e-7): boolean {
  const segment = sub(end, start)
  const toPoint = sub(point, start)
  const segmentLength = length(segment)
  if (segmentLength <= epsilon) {
    return distance(point, start) <= epsilon
  }
  if (Math.abs(cross(toPoint, segment)) > epsilon * segmentLength) {
    return false
  }
  const projection = dot(toPoint, segment)
  if (projection < -epsilon) {
    return false
  }
  return projection <= dot(segment, segment) + epsilon
}

export function pointOnRingBoundary(point: Point, ring: Point[], epsilon = 1e-7): boolean {
  for (let index = 0; index < ring.length; index += 1) {
    const start = ring[index]
    const end = ring[(index + 1) % ring.length]
    if (pointOnSegment(point, start, end, epsilon)) {
      return true
    }
  }
  return false
}

export function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i]
    const b = polygon[j]
    const intersects = ((a.y > point.y) !== (b.y > point.y))
      && (point.x < ((b.x - a.x) * (point.y - a.y)) / ((b.y - a.y) || Number.EPSILON) + a.x)
    if (intersects) {
      inside = !inside
    }
  }
  return inside
}

export function pointInPreparedRegion(point: Point, region: PreparedVCarveRegion): boolean {
  if (pointOnRingBoundary(point, region.outer)) {
    return true
  }
  for (const hole of region.holes) {
    if (pointOnRingBoundary(point, hole)) {
      return true
    }
  }
  if (!pointInPolygon(point, region.outer)) {
    return false
  }
  for (const hole of region.holes) {
    if (pointInPolygon(point, hole)) {
      return false
    }
  }
  return true
}

export function segmentInsidePreparedRegion(
  start: Point,
  end: Point,
  region: PreparedVCarveRegion,
  samples = 12,
): boolean {
  const safeSamples = Math.max(2, samples)
  for (let index = 0; index <= safeSamples; index += 1) {
    const t = index / safeSamples
    const point = {
      x: start.x + (end.x - start.x) * t,
      y: start.y + (end.y - start.y) * t,
    }
    if (!pointInPreparedRegion(point, region)) {
      return false
    }
  }
  return true
}

export function angleBisector(
  prevDirection: Point,
  nextDirection: Point,
  prevInwardNormal: Point,
  hole: boolean,
): { direction: Point; reflex: boolean; speedScale: number } {
  const nextInwardNormal = hole ? rightNormal(nextDirection) : leftNormal(nextDirection)
  const turn = cross(prevDirection, nextDirection)
  const reflex = hole ? turn > 0 : turn < 0

  let direction = normalize(add(prevInwardNormal, nextInwardNormal))
  if (length(direction) <= EPSILON) {
    direction = prevInwardNormal
  }
  if (reflex) {
    direction = scale(direction, -1)
  }

  const denom = dot(direction, prevInwardNormal)
  const speedScale = Math.abs(denom) > EPSILON ? 1 / denom : Number.POSITIVE_INFINITY

  return {
    direction,
    reflex,
    speedScale,
  }
}
