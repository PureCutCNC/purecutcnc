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

function cornerTurnAngle(contour: Point[], index: number): number | null {
  const n = contour.length
  if (n < 3) return null

  const prev = contour[(index - 1 + n) % n]
  const curr = contour[index]
  const next = contour[(index + 1) % n]
  const v1 = { x: prev.x - curr.x, y: prev.y - curr.y }
  const v2 = { x: next.x - curr.x, y: next.y - curr.y }
  const len1 = Math.hypot(v1.x, v1.y)
  const len2 = Math.hypot(v2.x, v2.y)
  if (len1 < 1e-9 || len2 < 1e-9) return null

  const cos = (v1.x * v2.x + v1.y * v2.y) / (len1 * len2)
  return Math.acos(Math.max(-1, Math.min(1, cos)))
}

function maxCornerJumpDistance(currentContour: Point[], corner: Point, stepSize: number): number {
  const minCornerJumpDist = stepSize * 3
  const maxCornerJumpDist = stepSize * 10
  const cornerIndex = findNearestContourVertexIndex(currentContour, corner)
  const angle = cornerTurnAngle(currentContour, cornerIndex)
  if (!angle) {
    return minCornerJumpDist
  }

  const sinHalf = Math.sin(angle / 2)
  if (!(sinHalf > 1e-6)) {
    return maxCornerJumpDist
  }

  // Offsetting a convex corner moves it along the angle bisector by d/sin(a/2).
  // Acute tips legitimately travel much farther than 3× stepSize, so scale the
  // guard from that geometric expectation but keep a hard cap for safety.
  return Math.max(minCornerJumpDist, Math.min(maxCornerJumpDist, (stepSize / sinHalf) * 1.25))
}

function cornerSmoothingDistance(stepSize: number): number {
  return Math.max(MIN_CORNER_SMOOTHING_DISTANCE, stepSize * CORNER_SMOOTHING_FRACTION)
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
    if (angle > CORNER_ANGLE_THRESHOLD_RAD) {
      corners.push({ ...curr })
    }
  }
  return smoothingDistance > 0 ? mergeCorners(corners, smoothingDistance * 0.75) : corners
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

interface SplitCornerTarget {
  childIndex: number
  point: Point
}

export function stepCorners(
  activeCorners: Point[],
  currentContour: Point[],
  nextContour: Point[],
  currentZ: number,
  nextZ: number,
  stepSize: number,
): { cuts: Path3D[], nextCorners: Point[], rejected: RejectedCorner[] } {
  if (activeCorners.length === 0 || nextContour.length === 0) {
    return { cuts: [], nextCorners: [], rejected: [] }
  }

  const candidateCorners = detectCorners(nextContour, cornerSmoothingDistance(stepSize))
  // Tighter guard for the fallback (smooth-vertex) case — a round-offset
  // step moves the tracking point by ~stepSize, so 1.5× is generous without
  // allowing cross-shape jumps.
  const vertexMaxJumpDist = stepSize * 1.5

  const cuts: Path3D[] = []
  const nextCorners: Point[] = []
  const rejected: RejectedCorner[] = []

  for (const corner of activeCorners) {
    const cornerMaxJumpDist = maxCornerJumpDistance(currentContour, corner, stepSize)
    let inNext: Point | null = null
    let rejectTarget: Point | null = null
    let rejectDist = Infinity
    let rejectMaxJumpDist = vertexMaxJumpDist

    if (candidateCorners.length > 0) {
      const nearestCorner = findNearestPoint(corner, candidateCorners)
      if (nearestCorner.target && nearestCorner.dist <= cornerMaxJumpDist) {
        inNext = nearestCorner.target
      } else if (nearestCorner.target) {
        rejectTarget = nearestCorner.target
        rejectDist = nearestCorner.dist
        rejectMaxJumpDist = cornerMaxJumpDist
      }
    }

    if (!inNext) {
      const nearestVertex = findNearestPoint(corner, nextContour)
      if (nearestVertex.target && nearestVertex.dist <= vertexMaxJumpDist) {
        inNext = nearestVertex.target
      } else if (nearestVertex.target && nearestVertex.dist < rejectDist) {
        rejectTarget = nearestVertex.target
        rejectDist = nearestVertex.dist
        rejectMaxJumpDist = vertexMaxJumpDist
      }
    }

    if (!inNext) {
      rejected.push({
        corner: { ...corner },
        bestTarget: rejectTarget ? { ...rejectTarget } : null,
        bestDist: rejectDist,
        maxJumpDist: rejectMaxJumpDist,
        hadCornerCandidates: candidateCorners.length > 0,
      })
      continue
    }

    cuts.push([
      { x: corner.x, y: corner.y, z: currentZ },
      { x: inNext.x, y: inNext.y, z: nextZ },
    ])
    nextCorners.push({ ...inNext })
  }

  // Dedup only truly coincident points (two arms converging to the same
  // corner). The old stepSize*0.5 threshold was too aggressive and dropped
  // valid nearby-but-distinct corner chains.
  return { cuts, nextCorners: mergeCorners(nextCorners, 1e-9), rejected }
}

function bridgeSplitCorners(
  activeCorners: Point[],
  currentContour: Point[],
  nextRegions: ResolvedPocketRegion[],
  currentZ: number,
  nextZ: number,
  stepSize: number,
): { cuts: Path3D[], childCorners: Point[][], rejected: RejectedCorner[] } {
  const childCorners = nextRegions.map((): Point[] => [])
  if (activeCorners.length === 0 || nextRegions.length === 0) {
    return { cuts: [], childCorners, rejected: [] }
  }

  const smoothingDistance = cornerSmoothingDistance(stepSize)
  const targets: SplitCornerTarget[] = nextRegions.flatMap((nextRegion, childIndex) =>
    detectCorners(nextRegion.outer, smoothingDistance).map((point) => ({ childIndex, point })),
  )

  if (targets.length === 0) {
    return {
      cuts: [],
      childCorners,
      rejected: activeCorners.map((corner) => ({
        corner: { ...corner },
        bestTarget: null,
        bestDist: Infinity,
        maxJumpDist: maxCornerJumpDistance(currentContour, corner, stepSize),
        hadCornerCandidates: false,
      })),
    }
  }

  const cuts: Path3D[] = []
  const rejected: RejectedCorner[] = []
  for (const corner of activeCorners) {
    const maxJumpDist = maxCornerJumpDistance(currentContour, corner, stepSize)
    let bestTarget: SplitCornerTarget | null = null
    let bestDist = Infinity
    for (const target of targets) {
      const dist = Math.hypot(target.point.x - corner.x, target.point.y - corner.y)
      if (dist < bestDist) {
        bestDist = dist
        bestTarget = target
      }
    }

    if (!bestTarget || bestDist > maxJumpDist) {
      rejected.push({
        corner: { ...corner },
        bestTarget: bestTarget ? { ...bestTarget.point } : null,
        bestDist,
        maxJumpDist,
        hadCornerCandidates: targets.length > 0,
      })
      continue
    }

    cuts.push([
      { x: corner.x, y: corner.y, z: currentZ },
      { x: bestTarget.point.x, y: bestTarget.point.y, z: nextZ },
    ])
    childCorners[bestTarget.childIndex].push({ ...bestTarget.point })
  }

  return { cuts, childCorners: childCorners.map((corners) => mergeCorners(corners, 1e-9)), rejected }
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


// ---------------------------------------------------------------------------
// Collapse handler
// ---------------------------------------------------------------------------

/**
 * Called when a region produces no further inset. Performs a micro-inset to
 * capture the residual spine, falling back to the region's current contour.
 */
function emitCollapseGeometry(
  region: ResolvedPocketRegion,
  activeCorners: Point[],
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
    if (microRegions.length === 1 && activeCorners.length > 0) {
      const { cuts, rejected } = stepCorners(activeCorners, region.outer, microRegions[0].outer, currentZ, microZ, microStep)
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
  corners?: Point[],  // at depth 0: detected from original shape; thereafter: chain-tracked inNext positions
): void {
  if (depth > MAX_RECURSION_DEPTH) return

  // At depth 0, detect corners from the original contour.
  // At depth N, corners are the inNext positions from the previous level —
  // they are already vertices of region.outer (guaranteed by chain tracking).
  const activeCorners = corners ?? detectCorners(region.outer, cornerSmoothingDistance(stepSize))

  const currentZ = topZ - Math.min(maxDepth, totalOffset / slope)
  const nextOffset = totalOffset + stepSize
  const nextZ = topZ - Math.min(maxDepth, nextOffset / slope)

  const nextRegions = buildInsetRegions(region, stepSize, ClipperLib.JoinType.jtRound)

  // ---- COLLAPSE ----
  if (nextRegions.length === 0) {
    emitCollapseGeometry(region, activeCorners, topZ, slope, maxDepth, totalOffset, stepSize, paths, debugShowRejected)
    return
  }

  // ---- SPLIT ----
  if (nextRegions.length > 1) {
    const { cuts, childCorners, rejected } = bridgeSplitCorners(activeCorners, region.outer, nextRegions, currentZ, nextZ, stepSize)
    paths.push(...cuts)

    if (debugShowRejected && rejected.length > 0) {
      for (const r of rejected) {
        paths.push(...buildXMarker(r.corner, currentZ, stepSize))
      }
    }

    // Each child is a new shape with its own corners. Prefer any corners that
    // were explicitly bridged into that child; otherwise detect fresh from the
    // child's boundary so pointed tips introduced by the split are captured.
    for (let childIndex = 0; childIndex < nextRegions.length; childIndex += 1) {
      const nextRegion = nextRegions[childIndex]
      const bridgedCorners = childCorners[childIndex]
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
        bridgedCorners.length > 0 ? bridgedCorners : detectCorners(nextRegion.outer, cornerSmoothingDistance(stepSize)),
      )
    }
    return
  }

  // ---- CONTINUE ----
  const nextRegion = nextRegions[0]

  const { cuts, nextCorners, rejected } = stepCorners(activeCorners, region.outer, nextRegion.outer, currentZ, nextZ, stepSize)
  paths.push(...cuts)

  if (debugShowRejected && rejected.length > 0) {
    for (const r of rejected) {
      paths.push(...buildXMarker(r.corner, currentZ, stepSize))
    }
  }

  // Pass nextCorners forward to continue chain tracking. If empty (all arms
  // collapsed or jumped too far), pass undefined so the next level re-detects
  // corners fresh from its own contour.
  traceRegion(nextRegion, topZ, slope, maxDepth, stepSize, nextOffset, depth + 1, paths, debugShowRejected,
    nextCorners.length > 0 ? nextCorners : undefined)
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
      traceRegion(region, band.topZ, slope, maxBandDepth, stepSize, 0, 0, paths, operation.debugShowRejectedCorners === true)
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
