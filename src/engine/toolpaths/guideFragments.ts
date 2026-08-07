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

import type { Point } from '../../types/project'
import { DEFAULT_CLIPPER_SCALE, XY_EPSILON, samePointXY } from './geometry'
import type { ClipperPath } from './types'

const EPSILON = XY_EPSILON

/** An outside span of a closed guide. `closed` is true only when nothing split the guide. */
export interface ClosedGuideFragment {
  points: Point[]
  closed: boolean
}

export type GuideFragmentKeep = 'outside' | 'inside'

const samePoint = samePointXY

function clonePoint(point: Point): Point {
  return { x: point.x, y: point.y }
}

function normalizeClosedGuide(guide: Point[]): Point[] {
  const points: Point[] = []
  for (const point of guide) {
    if (points.length === 0 || !samePoint(points.at(-1)!, point)) {
      points.push(clonePoint(point))
    }
  }
  if (points.length > 1 && samePoint(points[0], points.at(-1)!)) {
    points.pop()
  }
  return points
}

export function normalizeClipperPath(path: ClipperPath, scale: number): Point[] {
  const points: Point[] = []
  for (const point of path) {
    const converted = { x: point.X / scale, y: point.Y / scale }
    if (points.length === 0 || !samePoint(points.at(-1)!, converted)) {
      points.push(converted)
    }
  }
  if (points.length > 1 && samePoint(points[0], points.at(-1)!)) {
    points.pop()
  }
  return points
}

function pointOnSegment(point: Point, from: Point, to: Point): boolean {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const cross = (point.x - from.x) * dy - (point.y - from.y) * dx
  if (Math.abs(cross) > EPSILON) return false

  const dot = (point.x - from.x) * dx + (point.y - from.y) * dy
  if (dot < -EPSILON) return false
  return dot <= dx * dx + dy * dy + EPSILON
}

function pointInPath(point: Point, path: Point[]): boolean {
  let inside = false
  for (let index = 0; index < path.length; index += 1) {
    const from = path[index]
    const to = path[(index + 1) % path.length]
    if (pointOnSegment(point, from, to)) return true

    if ((from.y > point.y) === (to.y > point.y)) continue
    const crossingX = from.x + (point.y - from.y) * (to.x - from.x) / (to.y - from.y)
    if (crossingX > point.x) inside = !inside
  }
  return inside
}

/**
 * Forbidden paths are already the result of a Clipper union. Even-odd parity
 * preserves any holes that Clipper represents as separate contours.
 */
export function pointInForbiddenPaths(point: Point, paths: Point[][]): boolean {
  let inside = false
  for (const path of paths) {
    if (pointInPath(point, path)) inside = !inside
  }
  return inside
}

export function segmentIntersectionParameters(from: Point, to: Point, edgeFrom: Point, edgeTo: Point): number[] {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const edgeDx = edgeTo.x - edgeFrom.x
  const edgeDy = edgeTo.y - edgeFrom.y
  const denominator = dx * edgeDy - dy * edgeDx
  const offsetX = edgeFrom.x - from.x
  const offsetY = edgeFrom.y - from.y

  if (Math.abs(denominator) <= EPSILON) {
    const collinear = Math.abs(offsetX * dy - offsetY * dx) <= EPSILON
    const lengthSquared = dx * dx + dy * dy
    if (!collinear || lengthSquared <= EPSILON) return []

    const first = (offsetX * dx + offsetY * dy) / lengthSquared
    const second = ((edgeTo.x - from.x) * dx + (edgeTo.y - from.y) * dy) / lengthSquared
    const start = Math.max(0, Math.min(first, second))
    const end = Math.min(1, Math.max(first, second))
    return end - start > EPSILON ? [start, end] : []
  }

  const t = (offsetX * edgeDy - offsetY * edgeDx) / denominator
  const u = (offsetX * dy - offsetY * dx) / denominator
  if (t < -EPSILON || t > 1 + EPSILON || u < -EPSILON || u > 1 + EPSILON) return []
  return [Math.max(0, Math.min(1, t))]
}

export function distinctSorted(values: number[]): number[] {
  const sorted = values.sort((left, right) => left - right)
  const result: number[] = []
  for (const value of sorted) {
    if (result.length === 0 || value - result.at(-1)! > EPSILON) {
      result.push(value)
    }
  }
  return result
}

export function pointAt(from: Point, to: Point, t: number): Point {
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
  }
}

/**
 * Split a closed ordered guide against already-unioned forbidden Clipper paths.
 *
 * The result retains every requested span in cyclic order. A repeated final
 * guide vertex is accepted and removed. With no retained/discarded boundary,
 * the sole result remains closed; otherwise every result is an open span with
 * exact boundary intersections as its endpoints.
 */
export function splitClosedGuideByForbiddenPaths(
  guide: Point[],
  forbiddenPaths: ClipperPath[],
  keep: GuideFragmentKeep = 'outside',
  clipperScale: number = DEFAULT_CLIPPER_SCALE,
): ClosedGuideFragment[] {
  const normalizedGuide = normalizeClosedGuide(guide)
  if (normalizedGuide.length < 3 || !(clipperScale > 0)) return []

  const forbidden = forbiddenPaths
    .map((path) => normalizeClipperPath(path, clipperScale))
    .filter((path) => path.length >= 3)
  if (forbidden.length === 0) {
    return keep === 'outside' ? [{ points: normalizedGuide, closed: true }] : []
  }

  const fragments: Point[][] = []
  let current: Point[] | null = null
  let hasRetainedInterval = false
  let hasDiscardedInterval = false

  const finishCurrent = () => {
    if (current !== null && current.length >= 2) {
      fragments.push(current)
    }
    current = null
  }

  for (let index = 0; index < normalizedGuide.length; index += 1) {
    const from = normalizedGuide[index]
    const to = normalizedGuide[(index + 1) % normalizedGuide.length]
    const parameters = [0, 1]
    for (const path of forbidden) {
      for (let edgeIndex = 0; edgeIndex < path.length; edgeIndex += 1) {
        parameters.push(...segmentIntersectionParameters(
          from,
          to,
          path[edgeIndex],
          path[(edgeIndex + 1) % path.length],
        ))
      }
    }

    const breakpoints = distinctSorted(parameters)
    for (let breakpointIndex = 0; breakpointIndex < breakpoints.length - 1; breakpointIndex += 1) {
      const start = breakpoints[breakpointIndex]
      const end = breakpoints[breakpointIndex + 1]
      if (end - start <= EPSILON) continue

      const startPoint = pointAt(from, to, start)
      const endPoint = pointAt(from, to, end)
      const midpoint = pointAt(from, to, (start + end) / 2)
      const forbiddenAtMidpoint = pointInForbiddenPaths(midpoint, forbidden)
      const retain = keep === 'inside' ? forbiddenAtMidpoint : !forbiddenAtMidpoint
      if (!retain) {
        hasDiscardedInterval = true
        finishCurrent()
        continue
      }
      hasRetainedInterval = true

      if (current === null) {
        current = [startPoint, endPoint]
      } else if (samePoint(current.at(-1)!, startPoint)) {
        current.push(endPoint)
      } else {
        finishCurrent()
        current = [startPoint, endPoint]
      }
    }
  }
  finishCurrent()

  if (!hasRetainedInterval) return []
  if (!hasDiscardedInterval) {
    return [{ points: normalizedGuide, closed: true }]
  }
  if (fragments.length <= 1) {
    return fragments.map((points) => ({ points, closed: false }))
  }

  const first = fragments[0]
  const last = fragments.at(-1)!
  if (samePoint(last.at(-1)!, first[0])) {
    const seamMerged = [...last, ...first.slice(1)]
    return [seamMerged, ...fragments.slice(1, -1)].map((points) => ({ points, closed: false }))
  }
  return fragments.map((points) => ({ points, closed: false }))
}
