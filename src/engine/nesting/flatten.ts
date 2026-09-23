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

// Tolerance-bounded flattening of sketch profiles for nesting. The packer works
// on polygons, so every curve becomes chords; bounding the chord error lets the
// caller fold it into the gap (grow parts by it, shrink the sheet by it) and
// keep the promised clearance exact.

import type { Point, Segment, SketchProfile } from '../../types/project'
import type { NestRing } from './types'

const MAX_BEZIER_DEPTH = 16

/**
 * Flattens a profile so no point of the true curve is farther than
 * `tolerance` from the polygon. Arcs use the sagitta bound; béziers are split
 * until their control points lie within `tolerance` of the chord, which by
 * the convex-hull property bounds the curve too.
 */
export function flattenProfileWithin(profile: SketchProfile, tolerance: number): NestRing {
  if (!(tolerance > 0)) throw new Error('flattenProfileWithin: tolerance must be positive')
  const points: Point[] = [{ ...profile.start }]
  let current = profile.start
  for (const segment of profile.segments) {
    appendSegment(points, current, segment, tolerance)
    current = segment.to
  }
  const first = points[0]
  const last = points[points.length - 1]
  if (points.length > 1 && Math.hypot(first.x - last.x, first.y - last.y) < 1e-12) points.pop()
  return points
}

function appendSegment(points: Point[], from: Point, segment: Segment, tolerance: number): void {
  if (segment.type === 'line') {
    points.push({ ...segment.to })
    return
  }
  if (segment.type === 'bezier') {
    appendBezier(points, from, segment.control1, segment.control2, segment.to, tolerance, 0)
    return
  }
  const { center, clockwise } = segment
  const radius = Math.hypot(from.x - center.x, from.y - center.y)
  const startAngle = Math.atan2(from.y - center.y, from.x - center.x)
  let sweep: number
  if (segment.type === 'circle') {
    sweep = clockwise ? -Math.PI * 2 : Math.PI * 2
  } else {
    const endAngle = Math.atan2(segment.to.y - center.y, segment.to.x - center.x)
    sweep = endAngle - startAngle
    if (clockwise && sweep > 0) sweep -= Math.PI * 2
    else if (!clockwise && sweep < 0) sweep += Math.PI * 2
  }
  // A chord spanning angle θ deviates from its arc by r·(1 − cos(θ/2)).
  const maxStep = radius > tolerance ? 2 * Math.acos(1 - tolerance / radius) : Math.PI
  const count = Math.max(1, Math.ceil(Math.abs(sweep) / maxStep))
  for (let index = 1; index < count; index += 1) {
    const angle = startAngle + (sweep * index) / count
    points.push({ x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius })
  }
  points.push(segment.type === 'circle' ? { ...from } : { ...segment.to })
}

function distanceToChord(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length = Math.hypot(dx, dy)
  if (length === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / length
}

function appendBezier(
  points: Point[], p0: Point, p1: Point, p2: Point, p3: Point, tolerance: number, depth: number,
): void {
  const flat = Math.max(distanceToChord(p1, p0, p3), distanceToChord(p2, p0, p3)) <= tolerance
  if (flat || depth >= MAX_BEZIER_DEPTH) {
    points.push({ ...p3 })
    return
  }
  const mid = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
  const p01 = mid(p0, p1)
  const p12 = mid(p1, p2)
  const p23 = mid(p2, p3)
  const p012 = mid(p01, p12)
  const p123 = mid(p12, p23)
  const split = mid(p012, p123)
  appendBezier(points, p0, p01, p012, split, tolerance, depth + 1)
  appendBezier(points, split, p123, p23, p3, tolerance, depth + 1)
}
