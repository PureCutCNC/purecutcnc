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
 * A 2D affine matrix applied to a profile, with arcs and circles kept native
 * under a similarity and turned into Béziers otherwise. Moved out of
 * `store/helpers/resolveFeatures.ts` (which re-exports it) so the canned-shape
 * registry can use it without importing the text module and its fonts (#1131).
 */

import type { Matrix2D, Point, Segment, SketchProfile } from '../types/project'

// ============================================================================
// Matrix helpers
// ============================================================================

const EPSILON = 1e-9

/**
 * Apply a 2D affine matrix to a point.
 *   x' = a·x + c·y + e
 *   y' = b·x + d·y + f
 */
export function applyMatrixToPoint(m: Matrix2D, p: Point): Point {
  return {
    x: m.a * p.x + m.c * p.y + m.e,
    y: m.b * p.x + m.d * p.y + m.f,
  }
}

/** True when the matrix is the identity (or within epsilon). */
export function isIdentityMatrix(m: Matrix2D): boolean {
  return (
    Math.abs(m.a - 1) <= EPSILON &&
    Math.abs(m.b) <= EPSILON &&
    Math.abs(m.c) <= EPSILON &&
    Math.abs(m.d - 1) <= EPSILON &&
    Math.abs(m.e) <= EPSILON &&
    Math.abs(m.f) <= EPSILON
  )
}

/**
 * True when the linear part of the matrix maps circles to circles (no shear,
 * uniform scale).  A circle under a circle-preserving transform stays a circle
 * with a scaled radius.
 *
 * Conditions (within epsilon):
 *   a² + b² ≈ c² + d²     (equal scale in both axes — no aspect‑ratio change)
 *   a·c + b·d ≈ 0         (rows perpendicular — no shear)
 *
 * These ensure the 2×2 submatrix is a scalar multiple of an orthogonal matrix,
 * i.e.  uniform-scale · rotation · (optional mirror).
 */
export function isCirclePreservingTransform(m: Matrix2D): boolean {
  const row0Len2 = m.a * m.a + m.b * m.b
  const row1Len2 = m.c * m.c + m.d * m.d
  const dot = m.a * m.c + m.b * m.d
  return Math.abs(row0Len2 - row1Len2) <= EPSILON && Math.abs(dot) <= EPSILON
}

/**
 * True when the matrix includes a reflection (determinant < 0).
 * Mirror flips arc / circle `clockwise` so winding stays usable.
 */
export function isMirrorTransform(m: Matrix2D): boolean {
  return m.a * m.d - m.b * m.c < 0
}

// ============================================================================
// Profile / sketch resolution
// ============================================================================

/**
 * Kappa constant for bezier approximation of a quarter circle.  Same value
 * used by {@link ellipseProfile} in project.ts.
 */
const KAPPA = 0.5522847498

/**
 * Build four cubic bezier segments approximating a full circle.  This is the
 * fallback when a circle segment cannot be preserved as a circle under a
 * non‑circle‑preserving affine transform.
 */
function circleToBezierSegments(
  cx: number,
  cy: number,
  r: number,
): Array<Extract<Segment, { type: 'bezier' }>> {
  const k = r * KAPPA
  // Four quadrant anchors: right, bottom, left, top
  const pRight =  { x: cx + r, y: cy }
  const pBottom = { x: cx,     y: cy + r }
  const pLeft =   { x: cx - r, y: cy }
  const pTop =    { x: cx,     y: cy - r }

  return [
    // Q1: right → bottom (clockwise, +Y down)
    { type: 'bezier', control1: { x: cx + r, y: cy + k }, control2: { x: cx + k, y: cy + r }, to: pBottom },
    // Q2: bottom → left
    { type: 'bezier', control1: { x: cx - k, y: cy + r }, control2: { x: cx - r, y: cy + k }, to: pLeft },
    // Q3: left → top
    { type: 'bezier', control1: { x: cx - r, y: cy - k }, control2: { x: cx - k, y: cy - r }, to: pTop },
    // Q4: top → right
    { type: 'bezier', control1: { x: cx + k, y: cy - r }, control2: { x: cx + r, y: cy - k }, to: pRight },
  ]
}

/**
 * Convert an arc segment to one or more bezier segments suitable for
 * affine-transforming.  Follows the same math as {@link arcToBezierSegments}
 * in the store, inlined here so the resolver stays a pure helper with no
 * store dependency.
 */
function arcToBezierSegments(
  start: Point,
  segment: Extract<Segment, { type: 'arc' }>,
): Array<Extract<Segment, { type: 'bezier' }>> {
  const startAngle = Math.atan2(start.y - segment.center.y, start.x - segment.center.x)
  const endAngle = Math.atan2(segment.to.y - segment.center.y, segment.to.x - segment.center.x)
  const radius = Math.hypot(start.x - segment.center.x, start.y - segment.center.y)

  let sweep = endAngle - startAngle
  if (segment.clockwise && sweep > 0) {
    sweep -= Math.PI * 2
  } else if (!segment.clockwise && sweep < 0) {
    sweep += Math.PI * 2
  }

  const segmentCount = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)))
  const step = sweep / segmentCount
  const result: Array<Extract<Segment, { type: 'bezier' }>> = []

  for (let index = 0; index < segmentCount; index += 1) {
    const angle0 = startAngle + step * index
    const angle1 = angle0 + step
    const p0 = {
      x: segment.center.x + Math.cos(angle0) * radius,
      y: segment.center.y + Math.sin(angle0) * radius,
    }
    const p3 = {
      x: segment.center.x + Math.cos(angle1) * radius,
      y: segment.center.y + Math.sin(angle1) * radius,
    }
    const tangent0 = { x: -Math.sin(angle0), y: Math.cos(angle0) }
    const tangent1 = { x: -Math.sin(angle1), y: Math.cos(angle1) }
    const handleScale = (4 / 3) * Math.tan(step / 4) * radius

    result.push({
      type: 'bezier',
      control1: {
        x: p0.x + tangent0.x * handleScale,
        y: p0.y + tangent0.y * handleScale,
      },
      control2: {
        x: p3.x - tangent1.x * handleScale,
        y: p3.y - tangent1.y * handleScale,
      },
      to: p3,
    })
  }

  return result
}

/**
 * {@link resolveProfile} for a bare profile: the matrix applied with arcs and
 * circles kept native under a similarity and turned into Béziers otherwise.
 * Canned outlines use it under a non-similar placement (#1131 review: the
 * across-the-bar scale on a Turn would otherwise bend a slot's arcs).
 */
export function transformProfileByMatrix(
  profile: SketchProfile,
  transform: Matrix2D,
): SketchProfile {
  const preserveCircle = isCirclePreservingTransform(transform)
  const mirror = isMirrorTransform(transform)
  const transformPoint = (p: Point) => applyMatrixToPoint(transform, p)

  const nextSegments: Segment[] = []
  let current = profile.start

  for (const segment of profile.segments) {
    if (segment.type === 'line') {
      nextSegments.push({ ...segment, to: transformPoint(segment.to) })
    } else if (segment.type === 'bezier') {
      nextSegments.push({
        ...segment,
        control1: transformPoint(segment.control1),
        control2: transformPoint(segment.control2),
        to: transformPoint(segment.to),
      })
    } else if (segment.type === 'arc') {
      if (preserveCircle) {
        // Arc-preserving (similarity) transform — incl. identity: an arc stays an
        // arc with transformed center/endpoint (mirror flips winding).
        nextSegments.push({
          type: 'arc',
          to: transformPoint(segment.to),
          center: transformPoint(segment.center),
          clockwise: mirror ? !segment.clockwise : segment.clockwise,
        })
      } else {
        // Non-similarity (shear / non-uniform): arc can't stay an arc → beziers.
        const beziers = arcToBezierSegments(current, segment)
        for (const bezier of beziers) {
          nextSegments.push({
            ...bezier,
            control1: transformPoint(bezier.control1),
            control2: transformPoint(bezier.control2),
            to: transformPoint(bezier.to),
          })
        }
      }
    } else if (segment.type === 'circle') {
      if (preserveCircle) {
        // Circle-preserving transform: keep as native circle.
        const newCenter = transformPoint(segment.center)
        const newStart = transformPoint(profile.start)
        nextSegments.push({
          type: 'circle',
          center: newCenter,
          to: newStart,
          clockwise: mirror ? !segment.clockwise : segment.clockwise,
        })
      } else {
        // Non-circle-preserving: convert to beziers, then transform.
        const r = Math.hypot(profile.start.x - segment.center.x, profile.start.y - segment.center.y)
        const beziers = circleToBezierSegments(segment.center.x, segment.center.y, r)
        for (const bezier of beziers) {
          nextSegments.push({
            ...bezier,
            control1: transformPoint(bezier.control1),
            control2: transformPoint(bezier.control2),
            to: transformPoint(bezier.to),
          })
        }
      }
    }

    current = segment.to
  }

  return {
    start: transformPoint(profile.start),
    segments: nextSegments,
    closed: profile.closed,
  }
}
