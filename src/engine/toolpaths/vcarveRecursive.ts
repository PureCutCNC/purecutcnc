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
 * Recursive Skeleton V-Carve Generator
 *
 * Approximates the straight skeleton by recursively stepping inward with
 * Clipper offsets (jtRound), emitting diagonal "skeleton arm" cuts at corner
 * vertices between consecutive frames, and resolving collapse / split topology
 * events.
 *
 * Algorithm per region:
 *  1. Inset region by stepSize (jtRound).
 *  2a. CONTINUE (1 → 1): detect corners (angle > 15°) in currentContour, emit
 *      diagonal 3D segment to the closest vertex in nextContour. Recurse.
 *  2b. SPLIT (1 → N): emit the pre-split contour as a horizontal bridge at
 *      currentZ, then recurse independently into each child.
 *  2c. COLLAPSE (1 → 0): do a micro-inset (stepSize / 10) to capture the
 *      residual spine; emit whatever survives at the deepest Z.
 */

import ClipperLib from 'clipper-lib'
import type { Operation, Point, Project } from '../../types/project'
import type {
  ResolvedPocketRegion,
  ToolpathBounds,
  ToolpathMove,
  ToolpathPoint,
  ToolpathResult,
} from './types'
import { checkMaxCutDepthWarning, getOperationSafeZ, normalizeToolForProject } from './geometry'
import { isFeatureFirst, mergeToolpathResults, perFeatureOperations } from './multiFeature'
import {
  buildInsetRegions,
  pushRapidAndPlunge,
  retractToSafe,
  updateBounds,
} from './pocket'
import { resolvePocketRegions } from './resolver'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RECURSION_DEPTH = 200
const CORNER_ANGLE_THRESHOLD_RAD = (15 * Math.PI) / 180
const MICRO_FRACTION = 0.1  // fraction of stepSize used for collapse micro-offset
const CORNER_SMOOTHING_FRACTION = 0.25
const MIN_CORNER_SMOOTHING_DISTANCE = 1e-4
// Bootstrap rescues bridge fresh-seed corners that emerge at deeper offsets to
// existing parent arms via medial-axis walks. Capped tightly: long walks
// produce visually-winding paths that effectively cross between children of a
// recent split — better to leave such corners as orphan chain heads (their
// own outgoing chain still gets emitted by the standard fresh-seed flow) and
// revisit them when child-to-child split connections are implemented.
const BOOTSTRAP_MAX_RESCUE_STEPS = 48
// Tighter cap for the parent-to-child split bridge: 8 stepSizes of medial
// walk, just past the 4× direct-connect budget so rescue can find paths
// around small obstacles but cannot snake across a band-shaped parent contour
// to a far-away child's corner.
const SPLIT_BRIDGE_MAX_RESCUE_STEPS = 8
const MIN_INTERIOR_CORNER_BRIDGE_STEPS = 2
const MIN_INTERIOR_CORNER_BRIDGE_ARC_RATIO = 1.6
const MIN_INTERIOR_CORNER_BRIDGE_ARC_EXTRA_STEPS = 1.5
const ENABLE_SPLIT_CONNECTIONS = true

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Point3D {
  x: number
  y: number
  z: number
}

/** A polyline of 3D points to be cut in sequence. */
type Path3D = Point3D[]

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function computeBounds(moves: ToolpathMove[]): ToolpathBounds | null {
  let bounds: ToolpathBounds | null = null
  for (const move of moves) {
    bounds = updateBounds(bounds, move.from)
    bounds = updateBounds(bounds, move.to)
  }
  return bounds
}

function contourToPath3D(contour: Point[], z: number): Path3D {
  if (contour.length === 0) return []
  const pts: Point3D[] = contour.map((p) => ({ x: p.x, y: p.y, z }))
  pts.push({ ...pts[0] })
  return pts
}

function contourLengthXY(contour: Point[]): number {
  if (contour.length < 2) {
    return 0
  }

  let length = 0
  for (let i = 0; i < contour.length; i += 1) {
    const next = contour[(i + 1) % contour.length]
    length += Math.hypot(next.x - contour[i].x, next.y - contour[i].y)
  }
  return length
}

function contourMaxSpanXY(contour: Point[]): number {
  if (contour.length === 0) {
    return 0
  }

  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const point of contour) {
    if (point.x < minX) minX = point.x
    if (point.x > maxX) maxX = point.x
    if (point.y < minY) minY = point.y
    if (point.y > maxY) maxY = point.y
  }
  return Math.max(maxX - minX, maxY - minY)
}

function isTinyRemnantContour(contour: Point[], stepSize: number): boolean {
  return contourMaxSpanXY(contour) <= stepSize * 2.5
}

function findNearestPoint(point: Point, targets: Point[]): { target: Point | null, dist: number } {
  let bestTarget: Point | null = null
  let bestDist = Infinity
  for (const target of targets) {
    const dist = Math.hypot(target.x - point.x, target.y - point.y)
    if (dist < bestDist) {
      bestDist = dist
      bestTarget = target
    }
  }
  return { target: bestTarget, dist: bestDist }
}

function findNearestContourVertexIndex(contour: Point[], point: Point): number {
  let bestIdx = 0
  let bestDist = Infinity
  for (let i = 0; i < contour.length; i += 1) {
    const dist = Math.hypot(contour[i].x - point.x, contour[i].y - point.y)
    if (dist < bestDist) {
      bestDist = dist
      bestIdx = i
    }
  }
  return bestIdx
}

/**
 * True when `contour` has at least one detectCorners-recognised corner within
 * `radius` of `target`. Used to gate wall-anchor fallbacks so they only fire
 * near real sharp features of the parent contour and not on smooth curves
 * where Clipper jtRound creates spurious vertices at deep insets.
 */
function hasNearbyContourCorner(contour: Point[], target: Point, radius: number, stepSizeForSmoothing: number): boolean {
  const corners = detectCorners(contour, Math.max(MIN_CORNER_SMOOTHING_DISTANCE, stepSizeForSmoothing * CORNER_SMOOTHING_FRACTION))
  for (const c of corners) {
    if (Math.hypot(c.x - target.x, c.y - target.y) <= radius) return true
  }
  return false
}

function closestPointOnContour(contour: Point[], target: Point): Point | null {
  if (contour.length < 2) return null
  let bestPt: Point | null = null
  let bestDistSq = Infinity
  for (let i = 0; i < contour.length; i += 1) {
    const a = contour[i]
    const b = contour[(i + 1) % contour.length]
    const abx = b.x - a.x
    const aby = b.y - a.y
    const lenSq = abx * abx + aby * aby
    if (lenSq < 1e-18) continue
    const t = Math.max(0, Math.min(1, ((target.x - a.x) * abx + (target.y - a.y) * aby) / lenSq))
    const px = a.x + abx * t
    const py = a.y + aby * t
    const distSq = (px - target.x) ** 2 + (py - target.y) ** 2
    if (distSq < bestDistSq) {
      bestDistSq = distSq
      bestPt = { x: px, y: py }
    }
  }
  return bestPt
}

function pointInPolygon(x: number, y: number, polygon: Point[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const pi = polygon[i]
    const pj = polygon[j]
    const intersects = ((pi.y > y) !== (pj.y > y))
      && (x < (((pj.x - pi.x) * (y - pi.y)) / ((pj.y - pi.y) || 1e-12)) + pi.x)
    if (intersects) {
      inside = !inside
    }
  }
  return inside
}

function cornerBisector(contour: Point[], index: number): { x: number, y: number } | null {
  const n = contour.length
  if (n < 3) return null

  const prev = contour[(index - 1 + n) % n]
  const curr = contour[index]
  const next = contour[(index + 1) % n]
  const toPrev = { x: prev.x - curr.x, y: prev.y - curr.y }
  const toNext = { x: next.x - curr.x, y: next.y - curr.y }
  const lenPrev = Math.hypot(toPrev.x, toPrev.y)
  const lenNext = Math.hypot(toNext.x, toNext.y)
  if (lenPrev < 1e-9 || lenNext < 1e-9) return null

  const sum = {
    x: (toPrev.x / lenPrev) + (toNext.x / lenNext),
    y: (toPrev.y / lenPrev) + (toNext.y / lenNext),
  }
  const sumLen = Math.hypot(sum.x, sum.y)
  if (sumLen < 1e-9) return null

  return { x: sum.x / sumLen, y: sum.y / sumLen }
}

function cornerSmoothingDistance(stepSize: number): number {
  return Math.max(MIN_CORNER_SMOOTHING_DISTANCE, stepSize * CORNER_SMOOTHING_FRACTION)
}

function recursiveLogicContour(contour: Point[], stepSize: number): Point[] {
  return simplifyContourForCornerDetection(contour, cornerSmoothingDistance(stepSize))
}

/**
 * Drop intermediate points that are within `tolerance` of the line connecting
 * their neighbours (XY plane only — Z is preserved on retained points).
 * Removes the small kinks in multi-step rescue paths where the channel midpoint
 * jitters perpendicular to the walking direction between iterations.
 */
function simplifyPath3DCollinear(points: Point3D[], tolerance: number): Point3D[] {
  if (points.length <= 2 || tolerance <= 0) return points.slice()
  const out: Point3D[] = [points[0]]
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = out[out.length - 1]
    const curr = points[i]
    const next = points[i + 1]
    const span = Math.hypot(next.x - prev.x, next.y - prev.y)
    const area2 = Math.abs((next.x - prev.x) * (curr.y - prev.y) - (next.y - prev.y) * (curr.x - prev.x))
    const deviation = span > 1e-9 ? area2 / span : Math.hypot(curr.x - prev.x, curr.y - prev.y)
    if (deviation > tolerance) {
      out.push(curr)
    }
  }
  out.push(points[points.length - 1])
  return out
}

function simplifyOpenPolyline(points: Point[], distanceTolerance: number): Point[] {
  if (points.length <= 2) {
    return points.slice()
  }

  const start = points[0]
  const end = points[points.length - 1]
  const span = Math.hypot(end.x - start.x, end.y - start.y)
  let farthestIndex = -1
  let farthestDistance = -1
  for (let i = 1; i < points.length - 1; i += 1) {
    const point = points[i]
    const area2 = Math.abs((end.x - start.x) * (point.y - start.y) - (end.y - start.y) * (point.x - start.x))
    const distance = span > 1e-9 ? area2 / span : Math.hypot(point.x - start.x, point.y - start.y)
    if (distance > farthestDistance) {
      farthestDistance = distance
      farthestIndex = i
    }
  }

  if (farthestDistance <= distanceTolerance || farthestIndex < 0) {
    return [start, end]
  }

  const left = simplifyOpenPolyline(points.slice(0, farthestIndex + 1), distanceTolerance)
  const right = simplifyOpenPolyline(points.slice(farthestIndex), distanceTolerance)
  return [...left.slice(0, -1), ...right]
}

function sliceWrapped(points: Point[], startIndex: number, endIndex: number): Point[] {
  const out: Point[] = [points[startIndex]]
  for (let index = startIndex; index !== endIndex;) {
    index = (index + 1) % points.length
    out.push(points[index])
  }
  return out
}

function simplifyClosedContour(points: Point[], distanceTolerance: number): Point[] {
  if (points.length < 4) {
    return points.slice()
  }

  let startIndex = 0
  let endIndex = 1
  let bestDistance = -1
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const distance = Math.hypot(points[j].x - points[i].x, points[j].y - points[i].y)
      if (distance > bestDistance) {
        bestDistance = distance
        startIndex = i
        endIndex = j
      }
    }
  }

  const forward = simplifyOpenPolyline(sliceWrapped(points, startIndex, endIndex), distanceTolerance)
  const backward = simplifyOpenPolyline(sliceWrapped(points, endIndex, startIndex), distanceTolerance)
  const simplified = [...forward.slice(0, -1), ...backward.slice(0, -1)]
  return simplified.length >= 3 ? simplified : points.slice()
}

function simplifyContourForCornerDetection(contour: Point[], distanceTolerance: number): Point[] {
  if (contour.length < 4 || !(distanceTolerance > 0)) {
    return contour
  }

  let simplified = simplifyClosedContour(contour, distanceTolerance)
  for (;;) {
    if (simplified.length <= 3) {
      return simplified
    }

    let changed = false
    const next: Point[] = []
    for (let i = 0; i < simplified.length; i += 1) {
      const prev = simplified[(i - 1 + simplified.length) % simplified.length]
      const curr = simplified[i]
      const after = simplified[(i + 1) % simplified.length]
      const lenPrev = Math.hypot(curr.x - prev.x, curr.y - prev.y)
      const lenNext = Math.hypot(after.x - curr.x, after.y - curr.y)
      const span = Math.hypot(after.x - prev.x, after.y - prev.y)
      const area2 = Math.abs((after.x - prev.x) * (curr.y - prev.y) - (after.y - prev.y) * (curr.x - prev.x))
      const deviation = span > 1e-9 ? area2 / span : 0

      const hasShortEdge = lenPrev <= distanceTolerance || lenNext <= distanceTolerance
      const isTinyKink = deviation <= distanceTolerance * 0.35 && Math.min(lenPrev, lenNext) <= distanceTolerance * 4
      const isNeedle = span <= distanceTolerance && Math.max(lenPrev, lenNext) <= distanceTolerance * 2

      if (simplified.length > 3 && (hasShortEdge || isTinyKink || isNeedle)) {
        changed = true
        continue
      }

      next.push(curr)
    }

    if (!changed || next.length < 3) {
      return simplified
    }
    simplified = next
  }
}


/**
 * Turn angle (in radians) at the vertex of `contour` closest to `target`. Used
 * to validate detectCorners candidates against the raw, unsimplified contour:
 * Clipper polygons approximating smooth curves have many small (3–10°) turns
 * that — when collapsed by simplification — masquerade as one big corner.
 * Reading the raw angle disambiguates real corners from this jitter.
 */
function rawCornerTurnRadians(contour: Point[], target: Point): number {
  const n = contour.length
  if (n < 3) return 0
  let bestIdx = 0
  let bestDistSq = Infinity
  for (let i = 0; i < n; i += 1) {
    const dx = contour[i].x - target.x
    const dy = contour[i].y - target.y
    const distSq = dx * dx + dy * dy
    if (distSq < bestDistSq) { bestDistSq = distSq; bestIdx = i }
  }
  const prev = contour[(bestIdx - 1 + n) % n]
  const curr = contour[bestIdx]
  const next = contour[(bestIdx + 1) % n]
  const dx1 = curr.x - prev.x
  const dy1 = curr.y - prev.y
  const dx2 = next.x - curr.x
  const dy2 = next.y - curr.y
  const len1 = Math.hypot(dx1, dy1)
  const len2 = Math.hypot(dx2, dy2)
  if (len1 < 1e-12 || len2 < 1e-12) return 0
  const cos = (dx1 * dx2 + dy1 * dy2) / (len1 * len2)
  return Math.acos(Math.max(-1, Math.min(1, cos)))
}

/**
 * Extract CONVEX corner points from a contour.
 *
 * Convexity is determined by comparing the cross-product sign at each vertex
 * against the polygon's signed area (which encodes winding direction). A
 * vertex whose cross product has the same sign as the area is a convex corner
 * (the bit plunges there). The opposite sign is a concave / armpit corner —
 * those are skipped so no spurious skeleton arms are emitted.
 */
export function detectCorners(contour: Point[], smoothingDistance = 0): Point[] {
  const prepared = smoothingDistance > 0 ? simplifyContourForCornerDetection(contour, smoothingDistance) : contour
  const n = prepared.length
  if (n < 3) return []

  // Shoelace signed area — sign encodes winding direction.
  let area = 0
  for (let i = 0; i < n; i++) {
    const a = prepared[i]
    const b = prepared[(i + 1) % n]
    area += a.x * b.y - b.x * a.y
  }
  if (Math.abs(area) < 1e-12) return []

  // Aggressive simplification can collapse 6–10 small turns on a smooth curve
  // (e.g. Clipper's polygon approximation of a circle) into one big "fake"
  // corner. The simplified angle is therefore unreliable; we cross-check each
  // candidate against the corresponding raw turn on the original contour.
  // Real corners (sharp shape features) have raw angles ≥ the threshold; jitter
  // on smooth curves has 3–10° regardless of how big the simplified angle is.
  const corners: Point[] = []
  for (let i = 0; i < n; i++) {
    const prev = prepared[(i - 1 + n) % n]
    const curr = prepared[i]
    const next = prepared[(i + 1) % n]
    const dx1 = curr.x - prev.x
    const dy1 = curr.y - prev.y
    const dx2 = next.x - curr.x
    const dy2 = next.y - curr.y
    const len1 = Math.hypot(dx1, dy1)
    const len2 = Math.hypot(dx2, dy2)
    if (len1 < 1e-12 || len2 < 1e-12) continue

    // Cross product — same sign as area means convex; opposite means concave.
    const cross = dx1 * dy2 - dy1 * dx2
    if (cross * area <= 0) continue

    const cos = (dx1 * dx2 + dy1 * dy2) / (len1 * len2)
    const angle = Math.acos(Math.max(-1, Math.min(1, cos)))
    if (angle <= CORNER_ANGLE_THRESHOLD_RAD) continue

    // Validate against raw contour: if the local turn on the original (unsimplified)
    // contour at the closest vertex is below the threshold, this is a smooth
    // curve being misread as a corner by the simplification step.
    if (smoothingDistance > 0 && rawCornerTurnRadians(contour, curr) <= CORNER_ANGLE_THRESHOLD_RAD) continue

    corners.push({ ...curr })
  }
  return smoothingDistance > 0 ? mergeCorners(corners, smoothingDistance * 0.75) : corners
}

function detectRecursiveCorners(contour: Point[], stepSize: number): Point[] {
  return detectCorners(contour, cornerSmoothingDistance(stepSize))
}

/**
 * Emit one diagonal skeleton-arm cut per active corner and advance corner
 * positions to the next offset level (chain tracking).
 *
 * Primary: connect each active corner to the nearest *actual corner* in
 * nextContour (via detectCorners). This prevents spurious cuts to smooth
 * curve vertices (the fan-of-connections bug) — only genuine skeleton arms
 * at sharp corners get emitted.
 *
 * Fallback: when the local corner has been rounded away by jtRound, fall back
 * to the nearest vertex with a tighter distance guard (1.5× stepSize). This
 * happens per active corner, even if other corners still exist elsewhere on
 * the same contour, and keeps the chain alive through rounded-offset levels
 * until collapse.
 *
 * A distance guard prevents the chain from jumping to an unrelated corner
 * across the shape when the tracked corner has actually collapsed.
 */
export interface RejectedCorner {
  corner: Point
  bestTarget: Point | null
  bestDist: number
  maxJumpDist: number
  hadCornerCandidates: boolean
}

interface TrackedArm {
  point: Point
  guide: { x: number, y: number }
  z?: number
}

interface ProjectionTarget {
  point: Point
  contour: Point[]
}

interface ProjectedTargetMatch<T extends ProjectionTarget> {
  target: T
  dist: number
  progress: number
  deviationRatio: number
  directionMismatch: number
}

interface ContourRayHit {
  point: Point
  contour: Point[]
  progress: number
  dist: number
}

function normalizeDirection(x: number, y: number): { x: number, y: number } | null {
  const length = Math.hypot(x, y)
  if (length < 1e-9) {
    return null
  }
  return { x: x / length, y: y / length }
}

function inwardDirectionForPoint(contour: Point[], point: Point): { x: number, y: number } | null {
  return cornerBisector(contour, findNearestContourVertexIndex(contour, point))
}

function inwardNormalForSegment(a: Point, b: Point): { x: number, y: number } | null {
  return normalizeDirection(-(b.y - a.y), b.x - a.x)
}

function inwardDirectionAtContourPoint(contour: Point[], point: Point): { x: number, y: number } | null {
  const vertexIndex = contour.findIndex((candidate) => Math.hypot(candidate.x - point.x, candidate.y - point.y) < 1e-6)
  if (vertexIndex >= 0) {
    return cornerBisector(contour, vertexIndex)
  }

  let bestIndex = -1
  let bestDistance = Infinity
  for (let i = 0; i < contour.length; i += 1) {
    const a = contour[i]
    const b = contour[(i + 1) % contour.length]
    const abx = b.x - a.x
    const aby = b.y - a.y
    const lengthSquared = (abx * abx) + (aby * aby)
    if (lengthSquared < 1e-12) {
      continue
    }

    const t = Math.max(0, Math.min(1, (((point.x - a.x) * abx) + ((point.y - a.y) * aby)) / lengthSquared))
    const closestX = a.x + (abx * t)
    const closestY = a.y + (aby * t)
    const distance = Math.hypot(point.x - closestX, point.y - closestY)
    if (distance < bestDistance) {
      bestDistance = distance
      bestIndex = i
    }
  }

  if (bestIndex < 0) {
    return inwardDirectionForPoint(contour, point)
  }

  return inwardNormalForSegment(contour[bestIndex], contour[(bestIndex + 1) % contour.length])
}

function blendDirections(
  primary: { x: number, y: number } | null,
  secondary: { x: number, y: number } | null,
  primaryWeight = 0.7,
): { x: number, y: number } | null {
  if (primary && secondary) {
    return normalizeDirection(
      (primary.x * primaryWeight) + (secondary.x * (1 - primaryWeight)),
      (primary.y * primaryWeight) + (secondary.y * (1 - primaryWeight)),
    )
  }
  return primary ?? secondary
}

function directionMismatch(a: { x: number, y: number } | null, b: { x: number, y: number } | null): number {
  if (!a || !b) {
    return 0
  }
  const dot = (a.x * b.x) + (a.y * b.y)
  return 1 - Math.max(-1, Math.min(1, dot))
}

function compareProjectedMatches<T extends ProjectionTarget>(
  left: ProjectedTargetMatch<T>,
  right: ProjectedTargetMatch<T>,
): number {
  if (Math.abs(left.deviationRatio - right.deviationRatio) > 1e-9) {
    return left.deviationRatio - right.deviationRatio
  }
  if (Math.abs(left.directionMismatch - right.directionMismatch) > 1e-9) {
    return left.directionMismatch - right.directionMismatch
  }
  if (Math.abs(left.progress - right.progress) > 1e-9) {
    return left.progress - right.progress
  }
  return left.dist - right.dist
}

function findProjectedTarget<T extends ProjectionTarget>(
  origin: Point,
  guide: { x: number, y: number } | null,
  currentContour: Point[],
  targets: T[],
): ProjectedTargetMatch<T> | null {
  if (targets.length === 0) {
    return null
  }

  let best: ProjectedTargetMatch<T> | null = null

  for (const target of targets) {
    const dx = target.point.x - origin.x
    const dy = target.point.y - origin.y
    const dist = Math.hypot(dx, dy)

    if (dist > 1e-9 && !segmentSamplesStayInsideContour(origin, target.point, currentContour)) {
      continue
    }

    let progress = dist
    let deviationRatio = 0
    if (guide) {
      progress = (dx * guide.x) + (dy * guide.y)
      if (progress <= 1e-9) {
        continue
      }

      const lateral = Math.abs((dx * guide.y) - (dy * guide.x))
      deviationRatio = lateral / progress
    }

    const match: ProjectedTargetMatch<T> = {
      target,
      dist,
      progress,
      deviationRatio,
      directionMismatch: directionMismatch(guide, inwardDirectionAtContourPoint(target.contour, target.point)),
    }

    if (!best || compareProjectedMatches(match, best) < 0) {
      best = match
    }
  }

  return best
}

function findNearestInsideTarget<T extends ProjectionTarget>(
  origin: Point,
  currentContour: Point[],
  targets: T[],
): ProjectedTargetMatch<T> | null {
  let best: ProjectedTargetMatch<T> | null = null

  for (const target of targets) {
    const dx = target.point.x - origin.x
    const dy = target.point.y - origin.y
    const dist = Math.hypot(dx, dy)
    if (dist > 1e-9 && !segmentSamplesStayInsideContour(origin, target.point, currentContour)) {
      continue
    }

    const match: ProjectedTargetMatch<T> = {
      target,
      dist,
      progress: dist,
      deviationRatio: Infinity,
      directionMismatch: 0,
    }

    if (!best || match.dist < best.dist) {
      best = match
    }
  }

  return best
}

function raySegmentIntersection(
  origin: Point,
  guide: { x: number, y: number },
  a: Point,
  b: Point,
): { point: Point, progress: number } | null {
  const sx = b.x - a.x
  const sy = b.y - a.y
  const denom = (guide.x * sy) - (guide.y * sx)
  const qpx = a.x - origin.x
  const qpy = a.y - origin.y

  if (Math.abs(denom) < 1e-9) {
    return null
  }

  const progress = ((qpx * sy) - (qpy * sx)) / denom
  const segmentT = ((qpx * guide.y) - (qpy * guide.x)) / denom
  if (progress <= 1e-9 || segmentT < -1e-9 || segmentT > 1 + 1e-9) {
    return null
  }

  return {
    point: {
      x: origin.x + (guide.x * progress),
      y: origin.y + (guide.y * progress),
    },
    progress,
  }
}

function findContourRayHit(
  origin: Point,
  guide: { x: number, y: number },
  currentContour: Point[],
  targetContour: Point[],
): ContourRayHit | null {
  let best: ContourRayHit | null = null

  for (let i = 0; i < targetContour.length; i += 1) {
    const hit = raySegmentIntersection(origin, guide, targetContour[i], targetContour[(i + 1) % targetContour.length])
    if (!hit) {
      continue
    }
    if (!segmentSamplesStayInsideContour(origin, hit.point, currentContour)) {
      continue
    }

    const candidate: ContourRayHit = {
      point: hit.point,
      contour: targetContour,
      progress: hit.progress,
      dist: hit.progress,
    }
    if (!best || candidate.progress < best.progress) {
      best = candidate
    }
  }

  return best
}

function snapRayHitToCorner(
  origin: Point,
  guide: { x: number, y: number },
  currentContour: Point[],
  hit: ContourRayHit,
  candidateCorners: Point[],
  stepSize: number,
): Point {
  if (candidateCorners.length === 0) {
    return hit.point
  }

  const cornerTargets = candidateCorners.map((point) => ({ point, contour: hit.contour }))
  const bestCorner = findProjectedTarget(origin, guide, currentContour, cornerTargets)
  if (!bestCorner) {
    return hit.point
  }

  const snapDistance = Math.hypot(bestCorner.target.point.x - hit.point.x, bestCorner.target.point.y - hit.point.y)
  const maxSnapDistance = Math.max(stepSize * 0.75, hit.progress * 0.15)
  return snapDistance <= maxSnapDistance ? bestCorner.target.point : hit.point
}

function createTrackedArm(
  contour: Point[],
  point: Point,
  previousGuide?: { x: number, y: number } | null,
  z?: number,
  guideContour?: Point[],
): TrackedArm | null {
  const localGuide = inwardDirectionAtContourPoint(guideContour ?? contour, point)
  const guide = localGuide ?? previousGuide ?? null
  if (!guide) {
    return null
  }
  return {
    point: { ...point },
    guide,
    z,
  }
}

function mergeTrackedArms(arms: TrackedArm[], threshold: number): TrackedArm[] {
  const result: TrackedArm[] = []
  for (const arm of arms) {
    const existing = result.find((candidate) => Math.hypot(candidate.point.x - arm.point.x, candidate.point.y - arm.point.y) < threshold)
    if (existing) {
      existing.guide = blendDirections(existing.guide, arm.guide, 0.5) ?? existing.guide
      if (arm.z !== undefined) {
        existing.z = existing.z === undefined ? arm.z : Math.min(existing.z, arm.z)
      }
      continue
    }
    result.push({
      point: { ...arm.point },
      guide: { ...arm.guide },
      z: arm.z,
    })
  }
  return result
}

function createTrackedArms(contour: Point[], points: Point[], dedupe = true, z?: number, guideContour?: Point[]): TrackedArm[] {
  const arms = points
    .map((point) => createTrackedArm(contour, point, undefined, z, guideContour))
    .filter((arm): arm is TrackedArm => arm !== null)
  return dedupe ? mergeTrackedArms(arms, 1e-9) : arms
}

function seedTrackedArms(
  contour: Point[],
  stepSize: number,
  carriedArms: TrackedArm[] = [],
  z?: number,
): TrackedArm[] {
  const logicContour = recursiveLogicContour(contour, stepSize)
  const freshArms = createTrackedArms(contour, detectRecursiveCorners(contour, stepSize), false, z, logicContour)
  return mergeTrackedArms([...carriedArms, ...freshArms], 1e-9)
}

function splitSourceArms(
  contour: Point[],
  stepSize: number,
  fallbackArms: TrackedArm[],
  z?: number,
): TrackedArm[] {
  const logicContour = recursiveLogicContour(contour, stepSize)
  const cornerPoints = detectRecursiveCorners(contour, stepSize)
  if (cornerPoints.length === 0) {
    return fallbackArms
  }

  const snappedArms = fallbackArms
    .map((arm) => {
      const nearestCorner = findNearestPoint(arm.point, cornerPoints).target
      if (!nearestCorner) {
        return null
      }
      return createTrackedArm(contour, nearestCorner, arm.guide, arm.z ?? z, logicContour)
    })
    .filter((arm): arm is TrackedArm => arm !== null)

  if (snappedArms.length > 0) {
    return mergeTrackedArms(snappedArms, 1e-9)
  }

  return createTrackedArms(contour, cornerPoints, true, z, logicContour)
}

function findArmTarget(
  arm: TrackedArm,
  currentContour: Point[],
  nextContour: Point[],
  stepSize: number,
  allowSmoothTargets: boolean,
): { point: Point, dist: number } | null {
  const candidateCorners = detectCorners(nextContour, cornerSmoothingDistance(stepSize))
  const rayHit = findContourRayHit(arm.point, arm.guide, currentContour, nextContour)
  if (rayHit) {
    const snappedPoint = snapRayHitToCorner(arm.point, arm.guide, currentContour, rayHit, candidateCorners, stepSize)
    const snappedIsCorner = candidateCorners.some((corner) => Math.hypot(corner.x - snappedPoint.x, corner.y - snappedPoint.y) < 1e-6)
    if (snappedIsCorner || allowSmoothTargets) {
      return {
        point: snappedPoint,
        dist: Math.hypot(snappedPoint.x - arm.point.x, snappedPoint.y - arm.point.y),
      }
    }
  }

  const cornerTargets: ProjectionTarget[] = candidateCorners.map((point) => ({ point, contour: nextContour }))
  const projectedCorner = cornerTargets.length > 0
    ? findProjectedTarget(arm.point, arm.guide, currentContour, cornerTargets)
      ?? findNearestInsideTarget(arm.point, currentContour, cornerTargets)
    : null
  if (projectedCorner) {
    return {
      point: projectedCorner.target.point,
      dist: projectedCorner.dist,
    }
  }

  if (!allowSmoothTargets) {
    return null
  }

  const vertexTargets: ProjectionTarget[] = nextContour.map((point) => ({ point, contour: nextContour }))
  const projectedVertex = findProjectedTarget(arm.point, arm.guide, currentContour, vertexTargets)
    ?? findNearestInsideTarget(arm.point, currentContour, vertexTargets)
  if (projectedVertex) {
    return {
      point: projectedVertex.target.point,
      dist: projectedVertex.dist,
    }
  }

  return null
}

function stepArms(
  activeArms: TrackedArm[],
  currentContour: Point[],
  nextContour: Point[],
  currentZ: number,
  nextZ: number,
  stepSize: number,
  slope: number,
  minZ: number,
  allowSmoothTargets = false,
): { cuts: Path3D[], nextArms: TrackedArm[], rejected: RejectedCorner[] } {
  if (activeArms.length === 0 || nextContour.length === 0) {
    return { cuts: [], nextArms: [], rejected: [] }
  }

  const currentLogicContour = !allowSmoothTargets ? recursiveLogicContour(currentContour, stepSize) : currentContour
  const nextLogicContour = !allowSmoothTargets ? recursiveLogicContour(nextContour, stepSize) : nextContour
  const cuts: Path3D[] = []
  const nextArms: TrackedArm[] = []
  const rejected: RejectedCorner[] = []
  const candidateCorners = allowSmoothTargets
    ? detectCorners(nextContour, cornerSmoothingDistance(stepSize))
    : detectRecursiveCorners(nextContour, stepSize)

  for (const arm of activeArms) {
    const armZ = arm.z ?? currentZ

    if (!allowSmoothTargets) {
      if (candidateCorners.length > 0) {
        const rescue = buildCenterlineRescuePath(currentLogicContour, candidateCorners, arm, currentZ, nextZ, stepSize, slope, minZ)
        if (rescue && rescue.path.length >= 2) {
          cuts.push(rescue.path)
          const priorPoint = rescue.path[rescue.path.length - 2]
          const endGuide = normalizeDirection(
            rescue.endPoint.x - priorPoint.x,
            rescue.endPoint.y - priorPoint.y,
          )
          const nextArm = createTrackedArm(nextContour, rescue.endPoint, endGuide ?? arm.guide, rescue.endZ, nextLogicContour)
          if (nextArm) {
            nextArms.push(nextArm)
          }
          continue
        }

        // Rescue bailed (probe outside contour, segment-outside, etc.) — this
        // typically means the contour is collapsing near `arm.point` and there
        // is no centerline left to walk. If a next-offset corner is reachable
        // by a direct inside-segment within ~4× stepSize, snap to it. Matches
        // the spec's "within step size from the trace point → direct connect"
        // generalized to the case where the trace can't step forward.
        const directBudget = stepSize * 4
        const directCandidates = candidateCorners
          .map((corner) => ({
            point: corner,
            dist: Math.hypot(corner.x - arm.point.x, corner.y - arm.point.y),
          }))
          .filter((c) => c.dist > 1e-9 && c.dist <= directBudget)
          .filter((c) => segmentSamplesStayInsideContour(arm.point, c.point, currentLogicContour))
          .sort((a, b) => a.dist - b.dist)
        const directTarget = directCandidates[0]
        if (directTarget) {
          rescueTracer?.({ kind: 'fallback:hit', arm: arm.point, target: directTarget.point, dist: directTarget.dist })
          cuts.push([
            { x: arm.point.x, y: arm.point.y, z: armZ },
            { x: directTarget.point.x, y: directTarget.point.y, z: nextZ },
          ])
          const nextArm = createTrackedArm(nextContour, directTarget.point, arm.guide, nextZ, nextLogicContour)
          if (nextArm) {
            nextArms.push(nextArm)
          }
          continue
        }

        // Wall-anchor fallback: when no next-offset corner is reachable, the
        // contour is collapsing toward this arm. Connect to the closest point
        // on the next contour itself — a tiny ~stepSize cut from the depth-N
        // corner straight into the depth-(N+1) wall. Mirrors the wall-anchor
        // used during fresh-seed bootstrap, applied to stuck arms here.
        //
        // GUARD: only fire when `arm.point` is near a real corner of the
        // current contour. On smooth offset rings (e.g. circle, the apex of
        // a curved letter) jtRound creates spurious "corners" at deep insets;
        // those have no parent-corner nearby and would otherwise emit dangling
        // ~stepSize cuts perpendicular to the smooth wall.
        const wallAnchor = closestPointOnContour(nextLogicContour, arm.point)
        if (wallAnchor && hasNearbyContourCorner(currentLogicContour, arm.point, stepSize * 2, stepSize)) {
          const wallDist = Math.hypot(wallAnchor.x - arm.point.x, wallAnchor.y - arm.point.y)
          if (wallDist <= stepSize * 2 && segmentSamplesStayInsideContour(arm.point, wallAnchor, currentLogicContour)) {
            rescueTracer?.({ kind: 'fallback:wall-hit', arm: arm.point, target: wallAnchor, dist: wallDist })
            cuts.push([
              { x: arm.point.x, y: arm.point.y, z: armZ },
              { x: wallAnchor.x, y: wallAnchor.y, z: nextZ },
            ])
            const nextArm = createTrackedArm(nextContour, wallAnchor, arm.guide, nextZ, nextLogicContour)
            if (nextArm) {
              nextArms.push(nextArm)
            }
            continue
          }
        }

        // A post-split child can immediately collapse into a tiny 1->1
        // remnant whose nearest corner is much farther than the normal local
        // fallback budgets. In that case the correct continuation is still the
        // direct bridge into that remnant, as long as the segment stays inside
        // the current contour.
        if (isTinyRemnantContour(nextContour, stepSize) && candidateCorners.length > 0) {
          const nearestTinyCorner = findNearestPoint(arm.point, candidateCorners)
          if (nearestTinyCorner.target && segmentSamplesStayInsideContour(arm.point, nearestTinyCorner.target, currentLogicContour)) {
            rescueTracer?.({ kind: 'fallback:micro-hit', arm: arm.point, target: nearestTinyCorner.target, dist: nearestTinyCorner.dist })
            cuts.push([
              { x: arm.point.x, y: arm.point.y, z: armZ },
              { x: nearestTinyCorner.target.x, y: nearestTinyCorner.target.y, z: nextZ },
            ])
            const nextArm = createTrackedArm(nextContour, nearestTinyCorner.target, arm.guide, nextZ, nextLogicContour)
            if (nextArm) {
              nextArms.push(nextArm)
            }
            continue
          }
        }
        rescueTracer?.({ kind: 'fallback:miss', arm: arm.point, candidateCornerCount: candidateCorners.length, nearestDist: candidateCorners.length > 0 ? findNearestPoint(arm.point, candidateCorners).dist : Infinity })
      }

      const nearestCorner = candidateCorners.length > 0 ? findNearestPoint(arm.point, candidateCorners) : { target: null, dist: Infinity }
      rejected.push({
        corner: { ...arm.point },
        bestTarget: nearestCorner.target ? { ...nearestCorner.target } : null,
        bestDist: nearestCorner.dist,
        maxJumpDist: Infinity,
        hadCornerCandidates: candidateCorners.length > 0,
      })
      continue
    }

    const target = findArmTarget(arm, currentContour, nextContour, stepSize, allowSmoothTargets)

    if (!target) {
      const nearestCorner = candidateCorners.length > 0 ? findNearestPoint(arm.point, candidateCorners) : { target: null, dist: Infinity }
      const nearestVertex = findNearestPoint(arm.point, nextContour)
      const rejectTarget = nearestCorner.dist <= nearestVertex.dist ? nearestCorner.target : nearestVertex.target
      const rejectDist = Math.min(nearestCorner.dist, nearestVertex.dist)
      rejected.push({
        corner: { ...arm.point },
        bestTarget: rejectTarget ? { ...rejectTarget } : null,
        bestDist: rejectDist,
        maxJumpDist: Infinity,
        hadCornerCandidates: candidateCorners.length > 0,
      })
      continue
    }

    cuts.push([
      { x: arm.point.x, y: arm.point.y, z: armZ },
      { x: target.point.x, y: target.point.y, z: nextZ },
    ])
    const nextArm = createTrackedArm(nextContour, target.point, arm.guide, nextZ)
    if (nextArm) {
      nextArms.push(nextArm)
    }
  }

  return { cuts, nextArms: mergeTrackedArms(nextArms, 1e-9), rejected }
}

export function stepCorners(
  activeCorners: Point[],
  currentContour: Point[],
  nextContour: Point[],
  currentZ: number,
  nextZ: number,
  stepSize: number,
): { cuts: Path3D[], nextCorners: Point[], rejected: RejectedCorner[] } {
  const activeArms = createTrackedArms(currentContour, activeCorners, false)
  const slope = Math.abs(currentZ - nextZ) > 1e-9 ? stepSize / Math.abs(currentZ - nextZ) : Number.POSITIVE_INFINITY
  const { cuts, nextArms, rejected } = stepArms(
    activeArms,
    currentContour,
    nextContour,
    currentZ,
    nextZ,
    stepSize,
    slope,
    Number.NEGATIVE_INFINITY,
    true,
  )
  return {
    cuts,
    nextCorners: nextArms.map((arm) => ({ ...arm.point })),
    rejected,
  }
}

/**
 * Bridge parent corners across a 1 → N split into child corners, applying the
 * same rules as the 1 → 1 recursive path:
 *
 *  - corner-to-corner only (no smooth-target snapping, no wall-anchors)
 *  - centerline rescue trace through the parent contour, with the snap pool
 *    drawn from corners on ALL child contours (the medial walk picks whichever
 *    child it happens to lead to)
 *  - direct-connect fallback to nearest reachable child corner within
 *    `4 × stepSize`, segment must stay inside the parent contour
 *  - parent arms that fail both attempts are rejected (no link emitted) —
 *    the user's explicit rule is "not every child corner connects to parent".
 *
 * Children whose corners are not picked up here are still seeded fresh inside
 * their child subtree by buildFreshSeedBootstrapCuts (called per-child in the
 * caller). That keeps the recursion alive inside each child even when the
 * parent had nothing to bridge with.
 */
function bridgeSplitArms(
  activeArms: TrackedArm[],
  currentContour: Point[],
  nextRegions: ResolvedPocketRegion[],
  currentZ: number,
  nextZ: number,
  stepSize: number,
  slope: number,
  minZ: number,
): { cuts: Path3D[], childArms: TrackedArm[][], rejected: RejectedCorner[] } {
  const childArms = nextRegions.map((): TrackedArm[] => [])
  if (activeArms.length === 0 || nextRegions.length === 0) {
    return { cuts: [], childArms, rejected: [] }
  }

  const logicCurrentContour = recursiveLogicContour(currentContour, stepSize)
  const logicChildContours = nextRegions.map((nextRegion) => recursiveLogicContour(nextRegion.outer, stepSize))

  // Pool every child corner with its child-index tag. detectRecursiveCorners
  // already filters jitter (raw-angle validation in detectCorners).
  const pooledCornerPoints: Point[] = []
  const cornerToChild = new Map<string, number>()
  const cornerKey = (p: Point): string => `${p.x.toFixed(8)},${p.y.toFixed(8)}`
  nextRegions.forEach((_nextRegion, childIndex) => {
    const corners = detectRecursiveCorners(logicChildContours[childIndex], stepSize)
    for (const c of corners) {
      pooledCornerPoints.push(c)
      cornerToChild.set(cornerKey(c), childIndex)
    }
  })

  if (pooledCornerPoints.length === 0) {
    return {
      cuts: [],
      childArms,
      rejected: activeArms.map((arm) => ({
        corner: { ...arm.point },
        bestTarget: null,
        bestDist: Infinity,
        maxJumpDist: Infinity,
        hadCornerCandidates: false,
      })),
    }
  }

  const cuts: Path3D[] = []
  const rejected: RejectedCorner[] = []

  for (const arm of activeArms) {
    const armZ = arm.z ?? currentZ

    // Primary: direct-connect to the nearest pooled child corner within
    // 4 × stepSize, segment must stay inside the parent contour. This is
    // scale-correct: child corners that descend from a parent are always
    // ~1 stepSize inward, so 4× is generous regardless of letter size, and
    // the SHORT, geometrically natural neighbour wins. Same units as the
    // 1 → 1 stepArms direct-connect budget.
    const directBudget = stepSize * 4
    const directCandidates = pooledCornerPoints
      .map((point) => ({ point, dist: Math.hypot(point.x - arm.point.x, point.y - arm.point.y) }))
      .filter((c) => c.dist > 1e-9 && c.dist <= directBudget)
      .filter((c) => segmentSamplesStayInsideContour(arm.point, c.point, logicCurrentContour))
      .sort((a, b) => a.dist - b.dist)
    const direct = directCandidates[0]
    if (direct) {
      const childIndex = cornerToChild.get(cornerKey(direct.point))
      if (childIndex !== undefined) {
        cuts.push([
          { x: arm.point.x, y: arm.point.y, z: armZ },
          { x: direct.point.x, y: direct.point.y, z: nextZ },
        ])
        const nextArm = createTrackedArm(
          nextRegions[childIndex].outer,
          direct.point,
          arm.guide,
          nextZ,
          logicChildContours[childIndex],
        )
        if (nextArm) {
          childArms[childIndex].push(nextArm)
        }
        continue
      }
    }

    // Fallback: medial-axis rescue walk through the parent contour for cases
    // where the natural neighbour is just past the direct-connect budget OR
    // a small obstacle (e.g. a Clipper-jitter notch) forces a detour. Capped
    // by SPLIT_BRIDGE_MAX_RESCUE_STEPS so it cannot snake across a band to
    // a far-away child — those connections are deferred to the planned
    // child-to-child step. The cap is in stepSize units, so it scales with
    // the user's chosen resolution: `8 × stepSize` is the same fraction of
    // any letter, large or small.
    const rescue = buildCenterlineRescuePath(
      logicCurrentContour,
      pooledCornerPoints,
      arm,
      currentZ,
      nextZ,
      stepSize,
      slope,
      minZ,
      SPLIT_BRIDGE_MAX_RESCUE_STEPS,
    )
    if (rescue && rescue.reachedCorner && rescue.path.length >= 2) {
      const childIndex = cornerToChild.get(cornerKey(rescue.endPoint))
      if (childIndex !== undefined) {
        cuts.push(rescue.path)
        const priorPoint = rescue.path[rescue.path.length - 2]
        const endGuide = normalizeDirection(
          rescue.endPoint.x - priorPoint.x,
          rescue.endPoint.y - priorPoint.y,
        )
        const nextArm = createTrackedArm(
          nextRegions[childIndex].outer,
          rescue.endPoint,
          endGuide ?? arm.guide,
          rescue.endZ,
          logicChildContours[childIndex],
        )
        if (nextArm) {
          childArms[childIndex].push(nextArm)
        }
        continue
      }
    }

    // Reject — parent arm has no good child counterpart. No wall-anchor; the
    // child still gets seeded inside its own subtree by the caller.
    const nearest = pooledCornerPoints.reduce<{ pt: Point | null, dist: number }>((acc, p) => {
      const d = Math.hypot(p.x - arm.point.x, p.y - arm.point.y)
      return d < acc.dist ? { pt: p, dist: d } : acc
    }, { pt: null, dist: Infinity })
    rejected.push({
      corner: { ...arm.point },
      bestTarget: nearest.pt ? { ...nearest.pt } : null,
      bestDist: nearest.dist,
      maxJumpDist: Infinity,
      hadCornerCandidates: pooledCornerPoints.length > 0,
    })
  }

  return { cuts, childArms: childArms.map((arms) => mergeTrackedArms(arms, 1e-9)), rejected }
}

/**
 * After a 1 → N split, connect corners on sibling children through the parent
 * contour by walking outward from each child corner along its bisected angle.
 *
 * Algorithm (per corner on each child):
 *  1. Start at a corner on child i; compute the outward bisector (away from
 *     the child's interior — negated inward bisector).
 *  2. Step `stepSize` along that ray to a probe point.
 *  3. Cast a perpendicular line through the probe; intersect it with the
 *     parent contour to find the channel midpoint (medial axis point).
 *  4. If the probe is outside the parent contour, stop — this corner cannot
 *     connect through the parent.
 *  5. If any corner from a DIFFERENT child is within `stepSize` of the
 *     channel midpoint, emit the accumulated path and snap to that corner.
 *  6. Otherwise advance to the channel midpoint and repeat from step 2.
 *
 * Each corner on each child is tried independently. Duplicate A→B / B→A
 * paths are expected and will be deduplicated later.
 */
function bridgeSiblingChildren(
  parentContour: Point[],
  parentIslands: Point[][],
  nextRegions: ResolvedPocketRegion[],
  currentZ: number,
  nextZ: number,
  stepSize: number,
  slope: number,
  minZ: number,
  debugShowPartial: boolean,
): Path3D[] {
  if (nextRegions.length < 2) return []

  const logicParent = recursiveLogicContour(parentContour, stepSize)
  const logicIslands = parentIslands.map((isl) => recursiveLogicContour(isl, stepSize))
  const allParentContours = [logicParent, ...logicIslands]
  // All corners from all children, tagged with their child index.
  const allChildCorners: { point: Point, childIdx: number }[] = []
  for (let ci = 0; ci < nextRegions.length; ci += 1) {
    for (const c of detectRecursiveCorners(nextRegions[ci].outer, stepSize)) {
      allChildCorners.push({ point: c, childIdx: ci })
    }
  }

  const cuts: Path3D[] = []
  const MAX_WALK_STEPS = 256

  for (const { point: startCorner, childIdx: startChildIdx } of allChildCorners) {
    // Step 2: outward bisector = negated inward bisector from the child contour.
    const inward = inwardDirectionAtContourPoint(nextRegions[startChildIdx].outer, startCorner)
    if (!inward) continue
    const outward = { x: -inward.x, y: -inward.y }

    const path: Point3D[] = [{ x: startCorner.x, y: startCorner.y, z: nextZ }]
    let currentPoint = { ...startCorner }
    let currentGuide = { ...outward }
    let lastZ = nextZ
    let connected = false

    for (let step = 0; step < MAX_WALK_STEPS; step += 1) {
      // Step 3: probe point at stepSize along the current ray.
      const probe = {
        x: currentPoint.x + currentGuide.x * stepSize,
        y: currentPoint.y + currentGuide.y * stepSize,
      }

      // Step 4: if probe is outside the parent, this corner cannot connect further.
      if (!pointInPolygon(probe.x, probe.y, logicParent)) break

      // Steps 5-6: perpendicular through probe, intersect all parent walls
      // (outer + islands), find the narrowest bracketing channel midpoint.
      const channel = findPerpendicularChannelMidpoint(allParentContours, probe, currentGuide)
      if (!channel) break

      // Step 7: Z at this midpoint is based on the channel radius and tool angle.
      const targetZ = currentZ - channel.radius / slope
      const pointZ = Math.max(minZ, Math.min(lastZ, targetZ))

      // Step 8: check if any corner from a different child is within stepSize.
      const snapTarget = allChildCorners.find(
        (c) => c.childIdx !== startChildIdx
          && Math.hypot(c.point.x - channel.point.x, c.point.y - channel.point.y) <= stepSize,
      )

      if (snapTarget) {
        path.push({ x: channel.point.x, y: channel.point.y, z: pointZ })
        path.push({ x: snapTarget.point.x, y: snapTarget.point.y, z: nextZ })
        connected = true
        break
      }

      // Step 9: advance currentPoint to channel midpoint. Keep guide fixed —
      // the outward bisector direction is constant for this walk; updating it
      // from channel-to-currentPoint causes the probe to exit the thin parent
      // band on the next step.
      path.push({ x: channel.point.x, y: channel.point.y, z: pointZ })
      currentPoint = channel.point
      lastZ = pointZ
    }

    // Emit the path whether or not we found a target child corner.
    if (path.length >= 2) {
      if (connected) {
        cuts.push(simplifyPath3DCollinear(path, stepSize * 0.05))
      } else if (debugShowPartial) {
        cuts.push(path)
      }
    }
  }

  return cuts
}

/**
 * Build a small X-shaped pair of cut segments at point (x, y) on plane z.
 * Used as a debug marker to visualize where stepCorners rejected a chain link.
 */
function buildXMarker(p: Point, z: number, size: number): Path3D[] {
  const h = size / 2
  return [
    [
      { x: p.x - h, y: p.y - h, z },
      { x: p.x + h, y: p.y + h, z },
    ],
    [
      { x: p.x - h, y: p.y + h, z },
      { x: p.x + h, y: p.y - h, z },
    ],
  ]
}

/**
 * Remove near-duplicate points: for each point, skip it if an earlier point
 * in the list is already within `threshold` distance. O(n²) but n is small.
 */
function mergeCorners(corners: Point[], threshold: number): Point[] {
  const result: Point[] = []
  for (const c of corners) {
    if (!result.some((r) => Math.hypot(r.x - c.x, r.y - c.y) < threshold)) {
      result.push(c)
    }
  }
  return result
}

function contourArcLength(contour: Point[], fromIndex: number, toIndex: number): number {
  if (contour.length < 2) {
    return 0
  }

  let length = 0
  for (let index = fromIndex; index !== toIndex;) {
    const nextIndex = (index + 1) % contour.length
    length += Math.hypot(
      contour[nextIndex].x - contour[index].x,
      contour[nextIndex].y - contour[index].y,
    )
    index = nextIndex
  }
  return length
}

function isIndexOnForwardArc(index: number, fromIndex: number, toIndex: number, contourLength: number): boolean {
  for (let cursor = (fromIndex + 1) % contourLength; cursor !== toIndex; cursor = (cursor + 1) % contourLength) {
    if (cursor === index) {
      return true
    }
  }
  return false
}

function segmentSamplesStayInsideContour(a: Point, b: Point, contour: Point[]): boolean {
  for (const t of [0.25, 0.5, 0.75]) {
    const sampleX = a.x + ((b.x - a.x) * t)
    const sampleY = a.y + ((b.y - a.y) * t)
    if (!pointInPolygon(sampleX, sampleY, contour)) {
      return false
    }
  }
  return true
}

function lineSegmentSignedIntersection(
  origin: Point,
  direction: { x: number, y: number },
  a: Point,
  b: Point,
): number | null {
  const sx = b.x - a.x
  const sy = b.y - a.y
  const denom = (direction.x * sy) - (direction.y * sx)
  if (Math.abs(denom) < 1e-9) {
    return null
  }

  const qpx = a.x - origin.x
  const qpy = a.y - origin.y
  const lineT = ((qpx * sy) - (qpy * sx)) / denom
  const segmentT = ((qpx * direction.y) - (qpy * direction.x)) / denom
  if (segmentT < -1e-9 || segmentT > 1 + 1e-9) {
    return null
  }

  return lineT
}

function findPerpendicularChannelMidpoint(
  contours: Point[][],
  probe: Point,
  guide: { x: number, y: number },
): { point: Point, radius: number } | null {
  const normal = normalizeDirection(-guide.y, guide.x)
  if (!normal) {
    return null
  }

  const intersections: number[] = []
  for (const contour of contours) {
    for (let i = 0; i < contour.length; i += 1) {
      const t = lineSegmentSignedIntersection(probe, normal, contour[i], contour[(i + 1) % contour.length])
      if (t === null) {
        continue
      }
      if (!intersections.some((existing) => Math.abs(existing - t) < 1e-6)) {
        intersections.push(t)
      }
    }
  }

  if (intersections.length < 2) {
    return null
  }

  // Find the narrowest bracketing pair: closest negative t and closest positive t.
  // This gives the local channel walls immediately around the probe, ignoring
  // far walls of the shape (e.g. the opposite side of an O band).
  const negatives = intersections.filter((t) => t < -1e-6).sort((a, b) => b - a) // closest to 0 first
  const positives = intersections.filter((t) => t > 1e-6).sort((a, b) => a - b)  // closest to 0 first

  if (negatives.length === 0 || positives.length === 0) {
    return null
  }

  const left = negatives[0]
  const right = positives[0]
  const midpointT = (left + right) / 2
  return {
    point: {
      x: probe.x + (normal.x * midpointT),
      y: probe.y + (normal.y * midpointT),
    },
    radius: (right - left) / 2,
  }
}

let rescueTracer: ((event: Record<string, unknown>) => void) | null = null
export function setRescueTracer(fn: ((event: Record<string, unknown>) => void) | null): void {
  rescueTracer = fn
}

function buildCenterlineRescuePath(
  currentContour: Point[],
  nextCorners: Point[],
  arm: TrackedArm,
  currentZ: number,
  nextZ: number,
  stepSize: number,
  slope: number,
  minZ: number,
  maxIterationsOverride?: number,
): { path: Path3D, endPoint: Point, endZ: number, reachedCorner: boolean } | null {
  if (!(slope > 1e-9) || nextCorners.length === 0) {
    return null
  }

  const startZ = arm.z ?? currentZ
  const path: Path3D = [{ x: arm.point.x, y: arm.point.y, z: startZ }]
  let currentPoint = { ...arm.point }
  let currentGuide = inwardDirectionAtContourPoint(currentContour, arm.point) ?? { ...arm.guide }
  let lastZ = startZ
  const maxIterations = maxIterationsOverride
    ?? Math.max(
      48,
      Math.min(
        2048,
        Math.ceil(contourLengthXY(currentContour) / Math.max(stepSize, 1e-9)),
      ),
    )

  rescueTracer?.({ kind: 'rescue:start', armPoint: arm.point, guide: currentGuide, currentZ, nextZ, stepSize, nextCornerCount: nextCorners.length })

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    // Try the full step first; if probe lands outside contour or the channel
    // midpoint isn't reachable in a straight line, halve the step and retry.
    // Handles thin protrusions where stepSize would overshoot the wall.
    let effStep = stepSize
    let probe: Point | null = null
    let probeInside = false
    let channel: { point: Point, radius: number } | null = null
    let foundStep = false
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const candidate = {
        x: currentPoint.x + (currentGuide.x * effStep),
        y: currentPoint.y + (currentGuide.y * effStep),
      }
      const candidateInside = pointInPolygon(candidate.x, candidate.y, currentContour)
      if (!candidateInside) {
        effStep *= 0.5
        continue
      }
      const candidateChannel = findPerpendicularChannelMidpoint([currentContour], candidate, currentGuide)
      if (!candidateChannel) {
        effStep *= 0.5
        continue
      }
      const candidateForward = ((candidateChannel.point.x - currentPoint.x) * currentGuide.x)
        + ((candidateChannel.point.y - currentPoint.y) * currentGuide.y)
      if (candidateForward <= effStep * 0.2) {
        effStep *= 0.5
        continue
      }
      if (!segmentSamplesStayInsideContour(currentPoint, candidateChannel.point, currentContour)) {
        effStep *= 0.5
        continue
      }
      probe = candidate
      probeInside = candidateInside
      channel = candidateChannel
      foundStep = true
      break
    }

    if (!foundStep || !probe || !channel) {
      rescueTracer?.({ kind: 'rescue:bail', reason: 'no-step', iteration, currentPoint })
      // Salvage: if we already walked some midpoints, try to snap the last
      // midpoint to a nearby next-offset corner instead of throwing the whole
      // partial trace away. Budget is generous (3× stepSize) since the medial
      // axis already brought us close to the next contour.
      if (path.length >= 2) {
        const lastPt = path[path.length - 1]
        const salvage = nextCorners
          .map((c) => ({ point: c, dist: Math.hypot(c.x - lastPt.x, c.y - lastPt.y) }))
          .filter((c) => c.dist <= stepSize * 3)
          .filter((c) => segmentSamplesStayInsideContour(lastPt, c.point, currentContour))
          .sort((a, b) => a.dist - b.dist)[0]
        if (salvage) {
          path.push({ x: salvage.point.x, y: salvage.point.y, z: nextZ })
          rescueTracer?.({ kind: 'rescue:salvage', iteration, lastPt, snapTo: salvage.point, snapDist: salvage.dist })
          return {
            path: simplifyPath3DCollinear(path, stepSize * 0.05),
            endPoint: salvage.point,
            endZ: nextZ,
            reachedCorner: true,
          }
        }
      }
      return null
    }
    const forwardProgress = ((channel.point.x - currentPoint.x) * currentGuide.x)
      + ((channel.point.y - currentPoint.y) * currentGuide.y)
    rescueTracer?.({ kind: 'rescue:step', iteration, probe, probeInside, channel: channel.point, radius: channel.radius, forwardProgress, effStep })

    const targetMidpointZ = currentZ - (channel.radius / slope)
    const midpointZ = Math.max(minZ, Math.min(lastZ, targetMidpointZ))
    if (Math.hypot(channel.point.x - currentPoint.x, channel.point.y - currentPoint.y) < 1e-6) {
      return null
    }
    path.push({ x: channel.point.x, y: channel.point.y, z: midpointZ })

    const nearestReachableCorner = nextCorners
      .map((corner) => ({
        point: corner,
        dist: Math.hypot(corner.x - channel.point.x, corner.y - channel.point.y),
      }))
      .filter((candidate) => candidate.dist <= stepSize + 1e-6)
      .sort((left, right) => left.dist - right.dist)[0]

    if (nearestReachableCorner) {
      path.push({ x: nearestReachableCorner.point.x, y: nearestReachableCorner.point.y, z: nextZ })
      rescueTracer?.({ kind: 'rescue:snap', iteration, channel: channel.point, snapTo: nearestReachableCorner.point, snapDist: nearestReachableCorner.dist })
      return {
        path: simplifyPath3DCollinear(path, stepSize * 0.05),
        endPoint: nearestReachableCorner.point,
        endZ: nextZ,
        reachedCorner: true,
      }
    }

    const nextGuide = normalizeDirection(
      channel.point.x - currentPoint.x,
      channel.point.y - currentPoint.y,
    )
    if (!nextGuide) {
      return null
    }

    currentPoint = channel.point
    currentGuide = nextGuide
    lastZ = midpointZ
  }

  return null
}

function buildFreshSeedBootstrapCuts(
  currentContour: Point[],
  nextContour: Point[],
  currentArms: TrackedArm[],
  connectedNextArms: TrackedArm[],
  currentZ: number,
  nextZ: number,
  stepSize: number,
  slope: number,
  minZ: number,
  allowWallAnchorFallback = true,
): { cuts: Path3D[], seededNextArms: TrackedArm[], connectedSeededArms: TrackedArm[] } {
  const currentLogicContour = recursiveLogicContour(currentContour, stepSize)
  const seededNextArms = seedTrackedArms(nextContour, stepSize, connectedNextArms, nextZ)
  // detectCorners now validates each candidate against the raw (unsimplified)
  // contour's turn angle, so spurious "corners" produced by Clipper jtRound
  // discretization on smooth curves are already filtered at the source. We
  // accept every detected fresh corner here — including ones that emerge from
  // legitimate topology merges (e.g. the bowl of an "e" merging with the outer
  // rim) where no parent-contour corner sits nearby.
  const freshSeedArms = seededNextArms.filter((seededArm) =>
    !connectedNextArms.some((connectedArm) => Math.hypot(connectedArm.point.x - seededArm.point.x, connectedArm.point.y - seededArm.point.y) < 1e-9),
  )

  if (freshSeedArms.length === 0) {
    return { cuts: [], seededNextArms, connectedSeededArms: mergeTrackedArms(connectedNextArms, 1e-9) }
  }

  const candidateSourceArms = mergeTrackedArms(currentArms, 1e-9)
  if (candidateSourceArms.length === 0) {
    return { cuts: [], seededNextArms, connectedSeededArms: mergeTrackedArms(connectedNextArms, 1e-9) }
  }

  const cuts: Path3D[] = []
  const connectedSeededArms = mergeTrackedArms(connectedNextArms, 1e-9)
  for (const freshSeedArm of freshSeedArms) {
    rescueTracer?.({ kind: 'bootstrap:start', freshSeed: freshSeedArm.point, sourceArmCount: candidateSourceArms.length })
    const orderedSourceArms = candidateSourceArms
      .filter((sourceArm) => Math.hypot(sourceArm.point.x - freshSeedArm.point.x, sourceArm.point.y - freshSeedArm.point.y) >= 1e-9)
      .sort((left, right) =>
        Math.hypot(left.point.x - freshSeedArm.point.x, left.point.y - freshSeedArm.point.y)
        - Math.hypot(right.point.x - freshSeedArm.point.x, right.point.y - freshSeedArm.point.y),
      )

    // Order: direct-connect first (geometrically natural), rescue as fallback.
    // After-split contours have child corners ~1 stepSize from their parent
    // counterparts, so the natural neighbour is always within direct budget.
    // Walking the medial axis only matters when the natural neighbour sits
    // just past direct budget OR a small obstacle blocks the straight line.
    let connected = false
    let directRejectReason = 'no-source'
    const directBudget = stepSize * 4
    for (const sourceArm of orderedSourceArms) {
      const dist = Math.hypot(sourceArm.point.x - freshSeedArm.point.x, sourceArm.point.y - freshSeedArm.point.y)
      if (dist > directBudget) { directRejectReason = `over-budget(closest=${dist.toFixed(4)})`; break }
      if (!segmentSamplesStayInsideContour(sourceArm.point, freshSeedArm.point, currentLogicContour)) {
        directRejectReason = 'segment-outside'
        continue
      }
      cuts.push([
        { x: sourceArm.point.x, y: sourceArm.point.y, z: sourceArm.z ?? currentZ },
        { x: freshSeedArm.point.x, y: freshSeedArm.point.y, z: nextZ },
      ])
      connectedSeededArms.push(freshSeedArm)
      connected = true
      rescueTracer?.({ kind: 'bootstrap:direct-hit', freshSeed: freshSeedArm.point, source: sourceArm.point, dist })
      break
    }

    // Rescue fallback. In split-context calls (allowWallAnchorFallback=false)
    // the parent contour is the band shape that just split — a 48-step medial
    // walk can still snake from one child's territory to another's, producing
    // visually cross-child bridges. Tighten to SPLIT_BRIDGE_MAX_RESCUE_STEPS
    // so split bootstrap matches the bridgeSplitArms cap. Both caps are in
    // stepSize units, so they scale automatically with the user's resolution.
    if (!connected) {
      const rescueCap = allowWallAnchorFallback ? BOOTSTRAP_MAX_RESCUE_STEPS : SPLIT_BRIDGE_MAX_RESCUE_STEPS
      for (const sourceArm of orderedSourceArms) {
        const rescue = buildCenterlineRescuePath(
          currentLogicContour,
          [freshSeedArm.point],
          sourceArm,
          currentZ,
          nextZ,
          stepSize,
          slope,
          minZ,
          rescueCap,
        )
        if (!rescue?.reachedCorner || rescue.path.length < 2) {
          continue
        }

        cuts.push(rescue.path)
        connectedSeededArms.push(freshSeedArm)
        connected = true
        break
      }

      // Wall-anchor fallback: when no existing arm is close, the fresh seed
      // corner emerged on a smooth stretch of the parent contour with no
      // detected corner nearby. Anchor it to the closest point on the parent
      // contour itself — a tiny ~stepSize cut from outer wall into the new
      // corner. This is the V-carve behaviour for any newly-emerged corner.
      //
      // GUARD: only fire when the fresh seed sits near a real corner on the
      // CURRENT contour (i.e. it descends from a real sharp feature of the
      // parent). On smooth offset rings (circles, gentle arches) jtRound
      // discretization creates spurious vertices that pass detectCorners; we
      // refuse to emit perpendicular-to-smooth-wall cuts for those.
      if (!connected && allowWallAnchorFallback
        && hasNearbyContourCorner(currentLogicContour, freshSeedArm.point, stepSize * 2.5, stepSize)) {
        const wallAnchor = closestPointOnContour(currentLogicContour, freshSeedArm.point)
        if (wallAnchor) {
          const wallDist = Math.hypot(wallAnchor.x - freshSeedArm.point.x, wallAnchor.y - freshSeedArm.point.y)
          if (wallDist <= stepSize * 2 && segmentSamplesStayInsideContour(wallAnchor, freshSeedArm.point, currentLogicContour)) {
            cuts.push([
              { x: wallAnchor.x, y: wallAnchor.y, z: currentZ },
              { x: freshSeedArm.point.x, y: freshSeedArm.point.y, z: nextZ },
            ])
            connectedSeededArms.push(freshSeedArm)
            connected = true
            rescueTracer?.({ kind: 'bootstrap:wall-hit', freshSeed: freshSeedArm.point, anchor: wallAnchor, dist: wallDist })
          } else {
            directRejectReason = `wall-${wallDist > stepSize * 2 ? 'too-far' : 'segment-outside'}(${wallDist.toFixed(4)})`
          }
        }
      }

      if (!connected) {
        rescueTracer?.({ kind: 'bootstrap:miss', freshSeed: freshSeedArm.point, reason: directRejectReason, sourceArmCount: orderedSourceArms.length })
      }
    }
  }

  return {
    cuts,
    seededNextArms,
    connectedSeededArms: mergeTrackedArms(connectedSeededArms, 1e-9),
  }
}

export function buildInteriorCornerBridge(
  contour: Point[],
  corners: Point[],
  z: number,
  stepSize: number,
): Path3D[] {
  if (contour.length < 3 || corners.length !== 2) {
    return []
  }

  const [start, end] = corners
  const chordLength = Math.hypot(end.x - start.x, end.y - start.y)
  if (chordLength < stepSize * MIN_INTERIOR_CORNER_BRIDGE_STEPS) {
    return []
  }

  const startIndex = findNearestContourVertexIndex(contour, start)
  const endIndex = findNearestContourVertexIndex(contour, end)
  if (startIndex === endIndex) {
    return []
  }

  const forwardArcLength = contourArcLength(contour, startIndex, endIndex)
  const backwardArcLength = contourArcLength(contour, endIndex, startIndex)
  const shortArcLength = Math.min(forwardArcLength, backwardArcLength)
  const shortArcIsForward = forwardArcLength <= backwardArcLength
  if (shortArcLength <= chordLength + (stepSize * MIN_INTERIOR_CORNER_BRIDGE_ARC_EXTRA_STEPS)) {
    return []
  }

  if ((shortArcLength / chordLength) < MIN_INTERIOR_CORNER_BRIDGE_ARC_RATIO) {
    return []
  }

  const contourCornerIndices = mergeCorners(detectCorners(contour, cornerSmoothingDistance(stepSize)), 1e-6)
    .map((corner) => findNearestContourVertexIndex(contour, corner))
    .filter((index, position, indices) => indices.indexOf(index) === position)
  const shortArcInteriorCornerCount = contourCornerIndices.filter((index) => {
    if (index === startIndex || index === endIndex) {
      return false
    }
    return shortArcIsForward
      ? isIndexOnForwardArc(index, startIndex, endIndex, contour.length)
      : isIndexOnForwardArc(index, endIndex, startIndex, contour.length)
  }).length
  if (shortArcInteriorCornerCount !== 1) {
    return []
  }

  if (!segmentSamplesStayInsideContour(start, end, contour)) {
    return []
  }

  return [[
    { x: start.x, y: start.y, z },
    { x: end.x, y: end.y, z },
  ]]
}


// ---------------------------------------------------------------------------
// Collapse handler
// ---------------------------------------------------------------------------

/**
 * Called when a region produces no further inset. Performs a micro-inset to
 * capture the residual spine, falling back to the region's current contour.
 */
function emitCollapseGeometry(
  region: ResolvedPocketRegion,
  activeArms: TrackedArm[],
  topZ: number,
  slope: number,
  maxDepth: number,
  totalOffset: number,
  stepSize: number,
  paths: Path3D[],
  debugShowRejected: boolean,
): void {
  const microStep = stepSize * MICRO_FRACTION
  const currentZ = topZ - Math.min(maxDepth, totalOffset / slope)
  const microRegions = buildInsetRegions(region, microStep, ClipperLib.JoinType.jtRound)
  const microZ = topZ - Math.min(maxDepth, (totalOffset + microStep) / slope)

  if (microRegions.length > 0) {
    if (microRegions.length === 1 && activeArms.length > 0) {
      const { cuts, rejected } = stepArms(
        activeArms,
        region.outer,
        microRegions[0].outer,
        currentZ,
        microZ,
        microStep,
        slope,
        topZ - maxDepth,
      )
      paths.push(...cuts)

      if (debugShowRejected && rejected.length > 0) {
        for (const rejectedCorner of rejected) {
          paths.push(...buildXMarker(rejectedCorner.corner, currentZ, stepSize))
        }
      }
    }

    for (const r of microRegions) {
      if (r.outer.length >= 2) {
        paths.push(contourToPath3D(r.outer, microZ))
      }
    }
  } else {
    if (region.outer.length >= 2) {
      paths.push(contourToPath3D(region.outer, currentZ))
    }
  }
}

// ---------------------------------------------------------------------------
// Core recursive trace
// ---------------------------------------------------------------------------

function traceRegion(
  region: ResolvedPocketRegion,
  topZ: number,
  slope: number,
  maxDepth: number,
  stepSize: number,
  totalOffset: number,
  depth: number,
  paths: Path3D[],
  debugShowRejected: boolean,
  arms?: TrackedArm[],  // at depth 0: detected from original shape; thereafter: chain-tracked projected hits
  allowFreshSeedRestart = true,
): void {
  if (depth > MAX_RECURSION_DEPTH) return

  // When fresh-seed restart is enabled, ALSO merge fresh-detected corners on
  // top of any incoming arms. Previously `arms ?? seed(...)` short-circuited
  // when `arms` was non-undefined, which meant a bridged child entering at
  // depth N+1 missed corners that emerged on its own outer contour. Notably,
  // the e's bowl-meets-outer corners on the side that hadn't yet merged at
  // the split moment.
  const activeArms = allowFreshSeedRestart
    ? seedTrackedArms(region.outer, stepSize, arms ?? [])
    : (arms ?? [])
  if (!allowFreshSeedRestart && activeArms.length === 0) return

  const currentZ = topZ - Math.min(maxDepth, totalOffset / slope)
  const nextOffset = totalOffset + stepSize
  const nextZ = topZ - Math.min(maxDepth, nextOffset / slope)

  const nextRegions = buildInsetRegions(region, stepSize, ClipperLib.JoinType.jtRound)

  // ---- COLLAPSE ----
  if (nextRegions.length === 0) {
    emitCollapseGeometry(region, activeArms, topZ, slope, maxDepth, totalOffset, stepSize, paths, debugShowRejected)
    return
  }

  // ---- SPLIT ----
  if (nextRegions.length > 1) {
    if (ENABLE_SPLIT_CONNECTIONS) {
      const parentSplitArms = splitSourceArms(region.outer, stepSize, activeArms, currentZ)
      const { cuts, childArms, rejected } = bridgeSplitArms(
        parentSplitArms,
        region.outer,
        nextRegions,
        currentZ,
        nextZ,
        stepSize,
        slope,
        topZ - maxDepth,
      )
      paths.push(...cuts)

      // Sibling bridges: connect children to each other through their shared
      // pinch points on the parent contour. Emitted as 3-point inverted-V
      // paths (corner → medial midpoint → corner) at appropriate V-bit Zs.
      paths.push(...bridgeSiblingChildren(
        region.outer,
        region.islands ?? [],
        nextRegions,
        currentZ,
        nextZ,
        stepSize,
        slope,
        topZ - maxDepth,
        debugShowRejected,
      ))

      if (debugShowRejected && rejected.length > 0) {
        for (const r of rejected) {
          paths.push(...buildXMarker(r.corner, currentZ, stepSize))
        }
      }

      // Recurse inside each split child. Fresh-seed restart is enabled in
      // BOTH cases (with-bridge and without): the raw-angle corner filter
      // already rejects polygon-discretization jitter on smooth curves, so
      // fresh seeds inside children only fire on real shape corners. Without
      // this, children whose contour acquires new corners at deeper offsets
      // (e.g. the stem of T narrowing past the cross-arm split) lose those
      // corners and the chain dies after a few levels.
      for (let childIndex = 0; childIndex < nextRegions.length; childIndex += 1) {
        const nextRegion = nextRegions[childIndex]
        const bridgedArms = childArms[childIndex]
        const { cuts: bootstrapCuts, connectedSeededArms } = buildFreshSeedBootstrapCuts(
          region.outer,
          nextRegion.outer,
          parentSplitArms,
          bridgedArms,
          currentZ,
          nextZ,
          stepSize,
          slope,
          topZ - maxDepth,
          false,
        )
        paths.push(...bootstrapCuts)
        const childArmsForRecursion = connectedSeededArms.length > 0 ? connectedSeededArms : undefined
        traceRegion(
          nextRegion,
          topZ,
          slope,
          maxDepth,
          stepSize,
          nextOffset,
          depth + 1,
          paths,
          debugShowRejected,
          childArmsForRecursion,
          true,
        )
      }
      return
    }

    // For now, once an inset splits we restart recursion independently inside
    // each child and intentionally do not connect the parent to those children.
    for (const nextRegion of nextRegions) {
      traceRegion(
        nextRegion,
        topZ,
        slope,
        maxDepth,
        stepSize,
        nextOffset,
        depth + 1,
        paths,
        debugShowRejected,
        undefined,
        allowFreshSeedRestart,
      )
    }
    return
  }

  // ---- CONTINUE ----
  const nextRegion = nextRegions[0]

  const { cuts, nextArms, rejected } = stepArms(
    activeArms,
    region.outer,
    nextRegion.outer,
    currentZ,
    nextZ,
    stepSize,
    slope,
    topZ - maxDepth,
  )
  paths.push(...cuts)
  let seededNextArms = nextArms
  if (allowFreshSeedRestart) {
    const bootstrap = buildFreshSeedBootstrapCuts(
      region.outer,
      nextRegion.outer,
      activeArms,
      nextArms,
      currentZ,
      nextZ,
      stepSize,
      slope,
      topZ - maxDepth,
    )
    paths.push(...bootstrap.cuts)
    seededNextArms = bootstrap.seededNextArms
  }
  paths.push(...buildInteriorCornerBridge(nextRegion.outer, nextArms.map((arm) => arm.point), nextZ, stepSize))

  if (debugShowRejected && rejected.length > 0) {
    for (const r of rejected) {
      paths.push(...buildXMarker(r.corner, currentZ, stepSize))
    }
  }

  // Continue guide-driven tracking, but also re-seed any fresh corners that
  // appear on the new contour so a missed lane can restart at the next level.
  traceRegion(nextRegion, topZ, slope, maxDepth, stepSize, nextOffset, depth + 1, paths, debugShowRejected,
    seededNextArms.length > 0 ? seededNextArms : undefined,
    allowFreshSeedRestart)
}

// ---------------------------------------------------------------------------
// Path chaining — join segments that share exact endpoints
// ---------------------------------------------------------------------------

/**
 * Merge Path3D segments whose endpoints touch into longer continuous paths.
 *
 * Chain tracking guarantees that the end of arm-segment N equals the start of
 * arm-segment N+1 (same XYZ float values, same arithmetic origin). Chaining
 * them here eliminates the retract-rapid-plunge between every pair of
 * consecutive arm segments, collapsing each skeleton arm into a single
 * connected toolpath entry.
 *
 * Standalone paths (e.g. closed collapse contours) pass through unchanged.
 */
function chainPaths(paths: Path3D[]): Path3D[] {
  if (paths.length === 0) return []

  const key = (p: { x: number; y: number; z: number }): string => `${p.x},${p.y},${p.z}`

  // Only 2-point arm segments are chained. Contour paths (length > 2, emitted
  // by split-bridge and collapse handlers) are left standalone. This is
  // critical: arm endpoints share exact XYZ values with the contour vertices
  // they were snapped to, so mixing the two types would create diagonal cuts
  // through the material.
  const arms    = paths.filter((p) => p.length === 2)
  const contours = paths.filter((p) => p.length !== 2)

  const byStart = new Map<string, number>()
  const byEnd   = new Map<string, number>()
  for (let i = 0; i < arms.length; i++) {
    byStart.set(key(arms[i][0]), i)
    byEnd.set(key(arms[i][1]), i)
  }

  const used = new Set<number>()
  const chained: Path3D[] = []

  for (let seed = 0; seed < arms.length; seed++) {
    if (used.has(seed)) continue

    // Walk backward to the true head of this chain (cycle-safe).
    let head = seed
    const backSeen = new Set<number>([seed])
    for (;;) {
      const prev = byEnd.get(key(arms[head][0]))
      if (prev === undefined || used.has(prev) || backSeen.has(prev)) break
      backSeen.add(prev)
      head = prev
    }

    // Build chain forward from head.
    const pts: Array<{ x: number; y: number; z: number }> = [...arms[head]]
    used.add(head)

    for (;;) {
      const next = byStart.get(key(pts[pts.length - 1]))
      if (next === undefined || used.has(next)) break
      used.add(next)
      pts.push(arms[next][1])  // arm[1] is the only new point (arm[0] already in pts)
    }

    chained.push(pts)
  }

  return [...chained, ...contours]
}

// ---------------------------------------------------------------------------
// Paths → ToolpathMoves conversion
// ---------------------------------------------------------------------------

function pathsToMoves(
  paths: Path3D[],
  safeZ: number,
  moves: ToolpathMove[],
  startPosition: ToolpathPoint | null,
): ToolpathPoint | null {
  let pos = startPosition
  const chained = chainPaths(paths)

  for (let pi = 0; pi < chained.length; pi++) {
    const path = chained[pi]
    if (path.length < 2) continue

    const entry: ToolpathPoint = path[0]

    if (pos !== null && pos.x === entry.x && pos.y === entry.y && pos.z === entry.z) {
      pos = entry
    } else {
      pos = retractToSafe(moves, pos, safeZ)
      pos = pushRapidAndPlunge(moves, pos, entry, safeZ)
    }

    for (let i = 1; i < path.length; i++) {
      moves.push({ kind: 'cut', from: path[i - 1], to: path[i] })
      pos = path[i]
    }
  }

  pos = retractToSafe(moves, pos, safeZ)
  return pos
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function generateVCarveRecursiveToolpath(project: Project, operation: Operation): ToolpathResult {
  if (operation.kind !== 'v_carve_recursive') {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['Only V-carve recursive operations can be resolved by the recursive skeleton generator'],
      bounds: null,
    }
  }

  if (isFeatureFirst(operation)) {
    const parts = perFeatureOperations(operation).map((subOp) =>
      generateVCarveRecursiveToolpathSingle(project, subOp),
    )
    return mergeToolpathResults(operation.id, parts)
  }
  return generateVCarveRecursiveToolpathSingle(project, operation)
}

function generateVCarveRecursiveToolpathSingle(project: Project, operation: Operation): ToolpathResult {
  const resolved = resolvePocketRegions(project, operation)
  const toolRecord = operation.toolRef
    ? project.tools.find((tool) => tool.id === operation.toolRef) ?? null
    : null

  if (!toolRecord) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...resolved.warnings, 'No tool assigned to this operation'],
      bounds: null,
    }
  }

  const tool = normalizeToolForProject(toolRecord, project)
  if (tool.type !== 'v_bit') {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...resolved.warnings, 'V-Carve Recursive requires a V-bit tool'],
      bounds: null,
    }
  }

  if (!(tool.vBitAngle && tool.vBitAngle > 0 && tool.vBitAngle < 180)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...resolved.warnings, 'V-bit angle must be between 0 and 180 degrees'],
      bounds: null,
    }
  }

  if (!(operation.maxCarveDepth > 0)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...resolved.warnings, 'Max carve depth must be greater than zero'],
      bounds: null,
    }
  }

  if (!(operation.stepover > 0)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...resolved.warnings, 'Step size must be greater than zero'],
      bounds: null,
    }
  }

  const halfAngleRadians = (tool.vBitAngle * Math.PI) / 360
  const slope = Math.tan(halfAngleRadians)
  if (!(slope > 1e-9)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...resolved.warnings, 'V-bit angle produces an invalid carving slope'],
      bounds: null,
    }
  }

  const safeZ = getOperationSafeZ(project)
  const stepSize = operation.stepover   // absolute project-unit step distance
  const moves: ToolpathMove[] = []
  const warnings = [...resolved.warnings]
  const depthWarning = checkMaxCutDepthWarning(tool, operation.maxCarveDepth)
  if (depthWarning) {
    warnings.push(depthWarning)
  }
  let currentPosition: ToolpathPoint | null = null

  for (const band of resolved.bands) {
    const maxBandDepth = Math.max(0, Math.min(operation.maxCarveDepth, band.topZ - band.bottomZ))
    if (!(maxBandDepth > 0)) {
      warnings.push(`Band ${band.topZ} -> ${band.bottomZ} leaves no usable V-carve depth`)
      continue
    }

    for (const region of band.regions) {
      const paths: Path3D[] = []
      traceRegion(region, band.topZ, slope, maxBandDepth, stepSize, 0, 0, paths, operation.debugToolpath === true)
      currentPosition = pathsToMoves(paths, safeZ, moves, currentPosition)
    }
  }

  if (moves.length === 0) {
    warnings.push('V-carve recursive generator produced no toolpath moves')
  }

  return {
    operationId: operation.id,
    moves,
    warnings,
    bounds: computeBounds(moves),
  }
}
