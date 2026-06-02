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
 * Pure geometry/value logic for measure & dimension annotations.
 *
 * Everything here is framework-free so it can be unit-tested by the structural
 * suite. The canvas renderer (components/canvas/dimensionRendering.ts) consumes
 * `dimensionLayout`; the store/tooling consume `resolveAnchor`/`measureValue`.
 *
 * Coordinates are project/world coordinates (Y grows downward — see
 * ARCHITECTURE.md §6). Feature profiles are already stored in world coordinates
 * (see project.ts `stockFromFeature`), so an anchor resolves by indexing into the
 * live profile — which is exactly why a dimension follows its geometry when the
 * feature is edited or moved.
 */

import {
  profileVertices,
} from '../types/project'
import type {
  AnchorTarget,
  DimensionAnchor,
  DimensionAnnotation,
  DimensionType,
  Point,
  Project,
  Segment,
  SketchProfile,
} from '../types/project'

// ────────────────────────────────────────────────────────────
// Small pure geometry helpers (kept local to avoid depending on
// the canvas layer, which carries rendering imports).
// ────────────────────────────────────────────────────────────

function lerp(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

function bezierPoint(p0: Point, c1: Point, c2: Point, p1: Point, t: number): Point {
  const u = 1 - t
  const w0 = u * u * u
  const w1 = 3 * u * u * t
  const w2 = 3 * u * t * t
  const w3 = t * t * t
  return {
    x: w0 * p0.x + w1 * c1.x + w2 * c2.x + w3 * p1.x,
    y: w0 * p0.y + w1 * c1.y + w2 * c2.y + w3 * p1.y,
  }
}

/** Start point (anchor) of the segment at `index` within a profile. */
function anchorPointForIndex(profile: SketchProfile, index: number): Point {
  if (index <= 0) return profile.start
  const seg = profile.segments[index - 1]
  if (!seg) return profile.start
  if (seg.type === 'circle') return profile.start
  return seg.to
}

/** Midpoint of a segment (arc/circle use the mid-sweep point on the curve). */
function segmentMidpoint(start: Point, segment: Segment): Point {
  if (segment.type === 'line') {
    return lerp(start, segment.to, 0.5)
  }
  if (segment.type === 'bezier') {
    return bezierPoint(start, segment.control1, segment.control2, segment.to, 0.5)
  }

  // arc / circle: point at the mid sweep angle
  const center = segment.center
  const radius = Math.hypot(start.x - center.x, start.y - center.y)
  const startAngle = Math.atan2(start.y - center.y, start.x - center.x)
  let sweep: number
  if (segment.type === 'circle') {
    sweep = segment.clockwise ? -Math.PI * 2 : Math.PI * 2
  } else {
    const endAngle = Math.atan2(segment.to.y - center.y, segment.to.x - center.x)
    sweep = endAngle - startAngle
    if (segment.clockwise && sweep > 0) sweep -= Math.PI * 2
    else if (!segment.clockwise && sweep < 0) sweep += Math.PI * 2
  }
  const midAngle = startAngle + sweep / 2
  return { x: center.x + Math.cos(midAngle) * radius, y: center.y + Math.sin(midAngle) * radius }
}

// ────────────────────────────────────────────────────────────
// Anchor resolution
// ────────────────────────────────────────────────────────────

function profileForTarget(target: AnchorTarget, project: Project): SketchProfile | null {
  if (target.source === 'stock') {
    return project.stock.profile
  }
  const feature = project.features.find((f) => f.id === target.featureId)
  return feature ? feature.sketch.profile : null
}

/**
 * Resolve an anchor to a live world point, or `null` when the reference is
 * dangling (feature deleted, index out of range). A `null` result marks the
 * whole dimension as invalid and is drawn in a warning style.
 */
export function resolveAnchor(anchor: DimensionAnchor, project: Project): Point | null {
  switch (anchor.kind) {
    case 'free':
      return anchor.point

    case 'origin':
      return { x: project.origin.x, y: project.origin.y }

    case 'vertex': {
      const profile = profileForTarget(anchor.target, project)
      if (!profile) return null
      const vertices = profileVertices(profile)
      const point = vertices[anchor.vertexIndex]
      return point ? { x: point.x, y: point.y } : null
    }

    case 'midpoint': {
      const profile = profileForTarget(anchor.target, project)
      if (!profile) return null
      const segment = profile.segments[anchor.segmentIndex]
      if (!segment) return null
      const start = anchorPointForIndex(profile, anchor.segmentIndex)
      return segmentMidpoint(start, segment)
    }

    case 'center': {
      const profile = profileForTarget(anchor.target, project)
      if (!profile) return null
      const segment = profile.segments[anchor.segmentIndex]
      if (!segment || (segment.type !== 'arc' && segment.type !== 'circle')) return null
      return { x: segment.center.x, y: segment.center.y }
    }

    default:
      return null
  }
}

// ────────────────────────────────────────────────────────────
// Value computation
// ────────────────────────────────────────────────────────────

function dist(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

/**
 * Angle in degrees at `vertex` between the rays to `p1` and `p2`, normalized to
 * the (0, 360) interior-style range as an absolute magnitude in [0, 180].
 */
export function angleBetween(vertex: Point, p1: Point, p2: Point): number {
  const a1 = Math.atan2(p1.y - vertex.y, p1.x - vertex.x)
  const a2 = Math.atan2(p2.y - vertex.y, p2.x - vertex.x)
  let delta = (a2 - a1) * (180 / Math.PI)
  while (delta <= -180) delta += 360
  while (delta > 180) delta -= 360
  return Math.abs(delta)
}

/** Live measured value, or `null` if any required anchor is dangling. */
export function measureValue(dim: DimensionAnnotation, project: Project): number | null {
  const a = resolveAnchor(dim.a, project)
  if (!a) return null

  switch (dim.type) {
    case 'aligned': {
      const b = dim.b ? resolveAnchor(dim.b, project) : null
      if (!b) return null
      return dist(a, b)
    }
    case 'horizontal': {
      const b = dim.b ? resolveAnchor(dim.b, project) : null
      if (!b) return null
      return Math.abs(b.x - a.x)
    }
    case 'vertical': {
      const b = dim.b ? resolveAnchor(dim.b, project) : null
      if (!b) return null
      return Math.abs(b.y - a.y)
    }
    case 'radius': {
      const b = dim.b ? resolveAnchor(dim.b, project) : null
      if (!b) return null
      return dist(a, b)
    }
    case 'diameter': {
      const b = dim.b ? resolveAnchor(dim.b, project) : null
      if (!b) return null
      return dist(a, b) * 2
    }
    case 'angle': {
      const b = dim.b ? resolveAnchor(dim.b, project) : null
      const c = dim.c ? resolveAnchor(dim.c, project) : null
      if (!b || !c) return null
      return angleBetween(a, b, c)
    }
    default:
      return null
  }
}

/** True if the dimension cannot be measured (any anchor dangling). */
export function isDimensionDangling(dim: DimensionAnnotation, project: Project): boolean {
  return measureValue(dim, project) === null
}

// ────────────────────────────────────────────────────────────
// Layout (pure geometry for the renderer)
// ────────────────────────────────────────────────────────────

export interface DimensionLayout {
  type: DimensionType
  value: number
  /** The two resolved measured points (for angle: the two rays' endpoints). */
  from: Point
  to: Point
  /** Endpoints of the drawn dimension line. */
  lineStart: Point
  lineEnd: Point
  /** Witness/extension lines, each `[atMeasuredPoint, atDimensionLine]`. */
  extensions: Array<[Point, Point]>
  /** Label anchor and rotation (radians, world space). */
  labelPos: Point
  labelAngle: number
  /** Angle-dimension extras. */
  vertex?: Point
  startAngle?: number
  endAngle?: number
}

function normalize(v: Point): Point {
  const len = Math.hypot(v.x, v.y)
  if (len <= 1e-9) return { x: 1, y: 0 }
  return { x: v.x / len, y: v.y / len }
}

/**
 * Compute the full drawing layout for a dimension, or `null` if it is dangling.
 * Pure: depends only on resolved anchors + the stored `offset`/`labelOffset`.
 */
export function dimensionLayout(dim: DimensionAnnotation, project: Project): DimensionLayout | null {
  const value = measureValue(dim, project)
  if (value === null) return null
  const a = resolveAnchor(dim.a, project)
  if (!a) return null
  const offset = dim.offset
  const labelOffset = dim.labelOffset ?? 0

  if (dim.type === 'aligned') {
    const b = resolveAnchor(dim.b!, project)!
    const dir = normalize({ x: b.x - a.x, y: b.y - a.y })
    const nrm = { x: -dir.y, y: dir.x }
    const shift = { x: nrm.x * offset, y: nrm.y * offset }
    const lineStart = { x: a.x + shift.x, y: a.y + shift.y }
    const lineEnd = { x: b.x + shift.x, y: b.y + shift.y }
    const mid = lerp(lineStart, lineEnd, 0.5)
    return {
      type: dim.type,
      value,
      from: a,
      to: b,
      lineStart,
      lineEnd,
      extensions: [[a, lineStart], [b, lineEnd]],
      labelPos: { x: mid.x + dir.x * labelOffset, y: mid.y + dir.y * labelOffset },
      labelAngle: Math.atan2(dir.y, dir.x),
    }
  }

  if (dim.type === 'horizontal') {
    // Dimension line is horizontal, placed `offset` from the points' mid Y.
    const b = resolveAnchor(dim.b!, project)!
    const yLine = (a.y + b.y) / 2 + offset
    const lineStart = { x: a.x, y: yLine }
    const lineEnd = { x: b.x, y: yLine }
    const mid = lerp(lineStart, lineEnd, 0.5)
    return {
      type: dim.type,
      value,
      from: a,
      to: b,
      lineStart,
      lineEnd,
      extensions: [[a, lineStart], [b, lineEnd]],
      labelPos: { x: mid.x + labelOffset, y: yLine },
      labelAngle: 0,
    }
  }

  if (dim.type === 'vertical') {
    // Dimension line is vertical, placed `offset` from the points' mid X.
    const b = resolveAnchor(dim.b!, project)!
    const xLine = (a.x + b.x) / 2 + offset
    const lineStart = { x: xLine, y: a.y }
    const lineEnd = { x: xLine, y: b.y }
    const mid = lerp(lineStart, lineEnd, 0.5)
    return {
      type: dim.type,
      value,
      from: a,
      to: b,
      lineStart,
      lineEnd,
      extensions: [[a, lineStart], [b, lineEnd]],
      labelPos: { x: xLine, y: mid.y + labelOffset },
      labelAngle: Math.PI / 2,
    }
  }

  if (dim.type === 'radius' || dim.type === 'diameter') {
    const edge = resolveAnchor(dim.b!, project)!
    const dir = normalize({ x: edge.x - a.x, y: edge.y - a.y })
    // For diameter, draw straight across the circle through the center.
    const lineStart = dim.type === 'diameter'
      ? { x: a.x - dir.x * (value / 2), y: a.y - dir.y * (value / 2) }
      : { x: a.x, y: a.y }
    const lineEnd = edge
    const mid = lerp(lineStart, lineEnd, 0.5)
    return {
      type: dim.type,
      value,
      from: a,
      to: edge,
      lineStart,
      lineEnd,
      extensions: [],
      labelPos: { x: mid.x + dir.x * labelOffset, y: mid.y + dir.y * labelOffset },
      labelAngle: Math.atan2(dir.y, dir.x),
    }
  }

  // angle
  const b = resolveAnchor(dim.b!, project)!
  const c = resolveAnchor(dim.c!, project)!
  const vertex = a
  const r1 = Math.hypot(b.x - vertex.x, b.y - vertex.y)
  const r2 = Math.hypot(c.x - vertex.x, c.y - vertex.y)
  const radius = Math.max(Math.abs(offset), Math.min(r1, r2) * 0.6, 1e-6)
  const startAngle = Math.atan2(b.y - vertex.y, b.x - vertex.x)
  const endAngle = Math.atan2(c.y - vertex.y, c.x - vertex.x)
  let delta = endAngle - startAngle
  while (delta <= -Math.PI) delta += Math.PI * 2
  while (delta > Math.PI) delta -= Math.PI * 2
  const midAngle = startAngle + delta / 2
  return {
    type: dim.type,
    value,
    from: b,
    to: c,
    lineStart: { x: vertex.x + Math.cos(startAngle) * radius, y: vertex.y + Math.sin(startAngle) * radius },
    lineEnd: { x: vertex.x + Math.cos(endAngle) * radius, y: vertex.y + Math.sin(endAngle) * radius },
    extensions: [],
    labelPos: { x: vertex.x + Math.cos(midAngle) * (radius + labelOffset), y: vertex.y + Math.sin(midAngle) * (radius + labelOffset) },
    labelAngle: 0,
    vertex,
    startAngle,
    endAngle,
  }
}

/**
 * Compute the `offset` value that would place a dimension's line at the given
 * world cursor position. Used while dragging a dimension to reposition it.
 * Returns `null` for types whose offset is not cursor-driven (radius/diameter).
 */
export function offsetForCursor(dim: DimensionAnnotation, project: Project, cursor: Point): number | null {
  const a = resolveAnchor(dim.a, project)
  if (!a) return null

  if (dim.type === 'aligned') {
    const b = dim.b ? resolveAnchor(dim.b, project) : null
    if (!b) return null
    const dir = normalize({ x: b.x - a.x, y: b.y - a.y })
    const nrm = { x: -dir.y, y: dir.x }
    return (cursor.x - a.x) * nrm.x + (cursor.y - a.y) * nrm.y
  }
  if (dim.type === 'horizontal') {
    const b = dim.b ? resolveAnchor(dim.b, project) : null
    if (!b) return null
    return cursor.y - (a.y + b.y) / 2
  }
  if (dim.type === 'vertical') {
    const b = dim.b ? resolveAnchor(dim.b, project) : null
    if (!b) return null
    return cursor.x - (a.x + b.x) / 2
  }
  if (dim.type === 'angle') {
    return Math.hypot(cursor.x - a.x, cursor.y - a.y)
  }
  return null
}

/**
 * Format the value text for a dimension's label (without unit conversion — the
 * caller supplies a formatter so this stays framework/units-agnostic).
 */
export function dimensionLabelText(
  dim: DimensionAnnotation,
  value: number,
  formatLength: (v: number) => string,
  formatAngle: (deg: number) => string,
): string {
  if (dim.textOverride) return dim.textOverride
  switch (dim.type) {
    case 'radius':
      return `R ${formatLength(value)}`
    case 'diameter':
      return `Ø ${formatLength(value)}`
    case 'angle':
      return formatAngle(value)
    default:
      return formatLength(value)
  }
}
