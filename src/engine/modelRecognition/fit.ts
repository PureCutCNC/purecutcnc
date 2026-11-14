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

/**
 * Turns a section loop back into a drawing (issue #1206).
 *
 * A mesh has no circles, only the corners a tessellator left on them. Those
 * corners lie on the true curve, so a circle through them is the designed
 * hole, not an approximation of the faceted one. A loop whose corners all sit
 * on one circle becomes a circle; otherwise runs of corners on a common circle
 * become arcs and the rest stay straight lines.
 */

import type { Point, Segment, SketchProfile } from '../../types/project'
import { circleProfile, polygonProfile } from '../../types/project'
import { findArcRunsInPoints } from '../toolpaths/arcReconstruction'
import type { RecognizedCircle } from './types'

/**
 * Fewest corners a loop needs to be read as a circle. A regular polygon with
 * this many sides is indistinguishable from a coarsely faceted circle, and the
 * circle is by far the likelier design.
 */
const MIN_CIRCLE_CORNERS = 12
/** Widest gap between neighbouring corners of a circle, seen from its centre. */
const MAX_CIRCLE_GAP = Math.PI / 3
/** An arc drawn as one segment turns no further than this; longer runs are split. */
const MAX_ARC_SWEEP = (Math.PI * 2) / 3

export interface FittedOutline {
  profile: SketchProfile
  circle: RecognizedCircle | null
}

/** Kasa least-squares circle. Null when the points are (nearly) on a line. */
function fitCircle(points: readonly Point[]): RecognizedCircle | null {
  const n = points.length
  if (n < 3) return null
  let meanX = 0
  let meanY = 0
  for (const point of points) {
    meanX += point.x
    meanY += point.y
  }
  meanX /= n
  meanY /= n

  let suu = 0
  let suv = 0
  let svv = 0
  let suuu = 0
  let svvv = 0
  let suvv = 0
  let svuu = 0
  for (const point of points) {
    const u = point.x - meanX
    const v = point.y - meanY
    suu += u * u
    suv += u * v
    svv += v * v
    suuu += u * u * u
    svvv += v * v * v
    suvv += u * v * v
    svuu += v * u * u
  }
  const det = suu * svv - suv * suv
  if (Math.abs(det) < 1e-18) return null
  const rhsU = (suuu + suvv) / 2
  const rhsV = (svvv + svuu) / 2
  const cu = (rhsU * svv - rhsV * suv) / det
  const cv = (rhsV * suu - rhsU * suv) / det
  const radius = Math.sqrt(cu * cu + cv * cv + (suu + svv) / n)
  if (!Number.isFinite(radius) || !(radius > 0)) return null
  return { center: { x: meanX + cu, y: meanY + cv }, radius }
}

function asCircle(outline: readonly Point[], tolerance: number): RecognizedCircle | null {
  if (outline.length < MIN_CIRCLE_CORNERS) return null
  const circle = fitCircle(outline)
  if (!circle) return null

  const angles: number[] = []
  for (const point of outline) {
    const dx = point.x - circle.center.x
    const dy = point.y - circle.center.y
    if (Math.abs(Math.hypot(dx, dy) - circle.radius) > tolerance * 2) return null
    angles.push(Math.atan2(dy, dx))
  }
  angles.sort((a, b) => a - b)
  for (let i = 0; i < angles.length; i += 1) {
    const next = i + 1 < angles.length ? angles[i + 1] : angles[0] + Math.PI * 2
    if (next - angles[i] > MAX_CIRCLE_GAP) return null
  }
  return circle
}

/**
 * The ring rotated to start where its longest edge ends. A straight edge is
 * never part of an arc, so no arc is cut in two by where the ring happens to
 * begin.
 */
function startAfterLongestEdge(outline: readonly Point[]): Point[] {
  let best = 0
  let bestLength = -1
  for (let i = 0; i < outline.length; i += 1) {
    const next = outline[(i + 1) % outline.length]
    const length = Math.hypot(next.x - outline[i].x, next.y - outline[i].y)
    if (length > bestLength) {
      bestLength = length
      best = (i + 1) % outline.length
    }
  }
  return [...outline.slice(best), ...outline.slice(0, best)]
}

function turnBetween(center: Point, from: Point, to: Point): number {
  const a = Math.atan2(from.y - center.y, from.x - center.x)
  const b = Math.atan2(to.y - center.y, to.x - center.x)
  let delta = Math.abs(b - a)
  if (delta > Math.PI) delta = Math.PI * 2 - delta
  return delta
}

function withArcs(outline: readonly Point[], tolerance: number): SketchProfile {
  const ring = startAfterLongestEdge(outline)
  const points = [...ring, ring[0]]
  const runs = findArcRunsInPoints(points, {
    minArcPoints: 4,
    maxResidual: tolerance * 2,
    maxSegmentAngleDeg: 40,
    minChordRatio: 0.15,
    minTotalSweepRad: 0.3,
    maxAngularStepRatio: 4,
    endpointConstrained: true,
  })
  if (runs.length === 0) return polygonProfile([...ring])

  const segments: Segment[] = []
  let cursor = 0
  const lineTo = (end: number): void => {
    while (cursor < end) {
      cursor += 1
      segments.push({ type: 'line', to: points[cursor] })
    }
  }
  for (const run of runs) {
    lineTo(run.startIndex)
    let swept = 0
    for (let i = run.startIndex + 1; i <= run.endIndex; i += 1) {
      swept += turnBetween(run.center, points[i - 1], points[i])
      const last = i === run.endIndex
      const nextTurn = last ? 0 : turnBetween(run.center, points[i], points[i + 1])
      if (last || swept + nextTurn > MAX_ARC_SWEEP) {
        segments.push({ type: 'arc', to: points[i], center: { ...run.center }, clockwise: run.clockwise })
        swept = 0
      }
    }
    cursor = run.endIndex
  }
  lineTo(points.length - 1)
  return { start: points[0], segments, closed: true }
}

/**
 * `outline` is a closed ring without a repeated last point; `tolerance` is the
 * detector's plan tolerance. Arc direction is the ring's own, in the mesh's XY
 * — a caller that mirrors the result into another frame flips it there.
 */
export function fitOutline(outline: readonly Point[], tolerance: number): FittedOutline {
  const circle = asCircle(outline, tolerance)
  if (circle) {
    return { profile: circleProfile(circle.center.x, circle.center.y, circle.radius), circle }
  }
  if (outline.length < 5) return { profile: polygonProfile([...outline]), circle: null }
  return { profile: withArcs(outline, tolerance), circle: null }
}
