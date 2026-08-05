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
import { XY_EPSILON, samePointXY } from './geometry'

const MIN_STEPS_PER_LOOP = 36
const GEOMETRY_EPSILON = XY_EPSILON

export const DEFAULT_TROCHOIDAL_POINT_BUDGET = 500_000

export type TrochoidalContourError = 'invalid-guide' | 'move-budget'

export interface TrochoidalContourOptions {
  orbitRadius: number
  advance: number
  /** The cutter diameter determines the orbit chord bound (0.1 × diameter). */
  toolDiameter: number
  angularDirection: 1 | -1
  closed?: boolean
  maxPoints?: number
}

export interface TrochoidalContourResult {
  points: Point[]
  entryCenter: Point | null
  loopCount: number
  actualAdvance: number
  error?: TrochoidalContourError
}

interface ArcLengthPath {
  points: Point[]
  cumulative: number[]
  length: number
  closed: boolean
}

const samePoint = samePointXY

function normalizeContour(contour: Point[], closed: boolean): Point[] {
  const points: Point[] = []
  for (const point of contour) {
    if (points.length === 0 || !samePoint(points.at(-1)!, point)) {
      points.push({ x: point.x, y: point.y })
    }
  }
  if (closed && points.length > 1 && samePoint(points[0], points.at(-1)!)) {
    points.pop()
  }
  return points
}

function buildArcLengthPath(contour: Point[], closed: boolean): ArcLengthPath | null {
  const points = normalizeContour(contour, closed)
  if (points.length < (closed ? 3 : 2)) return null

  const cumulative = [0]
  let length = 0
  const segmentCount = closed ? points.length : points.length - 1
  for (let index = 0; index < segmentCount; index += 1) {
    const from = points[index]
    const to = points[(index + 1) % points.length]
    const segmentLength = Math.hypot(to.x - from.x, to.y - from.y)
    if (segmentLength <= GEOMETRY_EPSILON) return null
    length += segmentLength
    cumulative.push(length)
  }

  return length > GEOMETRY_EPSILON ? { points, cumulative, length, closed } : null
}

function wrappedDistance(distance: number, length: number): number {
  const wrapped = distance % length
  return wrapped < 0 ? wrapped + length : wrapped
}

function samplePosition(path: ArcLengthPath, distance: number): Point {
  const target = path.closed
    ? wrappedDistance(distance, path.length)
    : Math.max(0, Math.min(path.length, distance))
  if (!path.closed && target >= path.length) return { ...path.points.at(-1)! }

  let low = 0
  let high = path.points.length - 1
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2)
    if (path.cumulative[middle] <= target) low = middle
    else high = middle - 1
  }

  const from = path.points[low]
  const to = path.points[(low + 1) % path.points.length]
  const segmentStart = path.cumulative[low]
  const segmentLength = path.cumulative[low + 1] - segmentStart
  const t = (target - segmentStart) / segmentLength
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
  }
}

function sampleFrame(path: ArcLengthPath, distance: number, lookaround: number): { tangent: Point; normal: Point } | null {
  const before = samplePosition(path, distance - lookaround)
  const after = samplePosition(path, distance + lookaround)
  const dx = after.x - before.x
  const dy = after.y - before.y
  const magnitude = Math.hypot(dx, dy)
  if (!(magnitude > GEOMETRY_EPSILON)) return null

  const tangent = { x: dx / magnitude, y: dy / magnitude }
  return { tangent, normal: { x: -tangent.y, y: tangent.x } }
}

function orbitPoint(center: Point, tangent: Point, normal: Point, radius: number, phase: number): Point {
  return {
    x: center.x + radius * (Math.cos(phase) * tangent.x + Math.sin(phase) * normal.x),
    y: center.y + radius * (Math.cos(phase) * tangent.y + Math.sin(phase) * normal.y),
  }
}

/**
 * Generates a bounded overlapping-orbit path around an already-safe guide.
 * Safety validation and entry synthesis stay with the edge-route integration:
 * clipping this output would break the orbit and can create an unsafe re-entry.
 */
export function buildTrochoidalContour(
  contour: Point[],
  options: TrochoidalContourOptions,
): TrochoidalContourResult {
  const closed = options.closed ?? true
  const path = buildArcLengthPath(contour, closed)
  if (!path || !(options.orbitRadius > 0) || !(options.advance > 0) || !(options.toolDiameter > 0)) {
    return { points: [], entryCenter: null, loopCount: 0, actualAdvance: 0, error: 'invalid-guide' }
  }

  const loopCount = Math.max(1, Math.ceil(path.length / options.advance))
  const actualAdvance = path.length / loopCount
  const maxChord = Math.max(options.toolDiameter * 0.1, GEOMETRY_EPSILON)
  const stepsPerLoop = Math.max(
    MIN_STEPS_PER_LOOP,
    Math.ceil(2 * Math.PI * options.orbitRadius / maxChord),
  )
  const movingSteps = loopCount * stepsPerLoop
  const maxPoints = Math.min(DEFAULT_TROCHOIDAL_POINT_BUDGET, options.maxPoints ?? DEFAULT_TROCHOIDAL_POINT_BUDGET)
  const stationarySteps = stepsPerLoop * (closed ? 1 : 2)
  if (movingSteps + stationarySteps + 1 > maxPoints) {
    return { points: [], entryCenter: null, loopCount, actualAdvance, error: 'move-budget' }
  }

  const frameLookaround = Math.min(
    path.length / 100,
    Math.max(actualAdvance / stepsPerLoop, options.toolDiameter * 0.01),
  )
  const entryCenter = samplePosition(path, 0)
  const entryFrame = sampleFrame(path, 0, frameLookaround)
  if (!entryFrame) {
    return { points: [], entryCenter: null, loopCount, actualAdvance, error: 'invalid-guide' }
  }

  const points: Point[] = [orbitPoint(entryCenter, entryFrame.tangent, entryFrame.normal, options.orbitRadius, 0)]
  for (let step = 1; step <= stepsPerLoop; step += 1) {
    const phase = options.angularDirection * 2 * Math.PI * step / stepsPerLoop
    points.push(orbitPoint(entryCenter, entryFrame.tangent, entryFrame.normal, options.orbitRadius, phase))
  }

  for (let step = 1; step <= movingSteps; step += 1) {
    const distance = path.length * step / movingSteps
    const center = samplePosition(path, distance)
    const frame = sampleFrame(path, distance, frameLookaround)
    if (!frame) return { points: [], entryCenter: null, loopCount, actualAdvance, error: 'invalid-guide' }
    const phase = options.angularDirection * 2 * Math.PI * step / stepsPerLoop
    points.push(orbitPoint(center, frame.tangent, frame.normal, options.orbitRadius, phase))
  }

  if (!closed) {
    const exitCenter = samplePosition(path, path.length)
    const exitFrame = sampleFrame(path, path.length, frameLookaround)
    if (!exitFrame) return { points: [], entryCenter: null, loopCount, actualAdvance, error: 'invalid-guide' }
    for (let step = 1; step <= stepsPerLoop; step += 1) {
      const phase = options.angularDirection * 2 * Math.PI * step / stepsPerLoop
      points.push(orbitPoint(exitCenter, exitFrame.tangent, exitFrame.normal, options.orbitRadius, phase))
    }
  }

  if (closed) points[points.length - 1] = { ...points[0] }
  return { points, entryCenter, loopCount, actualAdvance }
}
