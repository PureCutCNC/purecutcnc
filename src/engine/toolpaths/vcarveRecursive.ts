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
import { getOperationSafeZ, normalizeToolForProject } from './geometry'
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


/**
 * Build a closed 3D loop from a 2D contour at a given Z depth.
 * The first vertex is appended again at the end to close the loop.
 */
function contourToPath3D(contour: Point[], z: number): Path3D {
  if (contour.length === 0) return []
  const pts: Point3D[] = contour.map((p) => ({ x: p.x, y: p.y, z }))
  pts.push({ ...pts[0] }) // close the loop
  return pts
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
function detectCorners(contour: Point[]): Point[] {
  const n = contour.length
  if (n < 3) return []

  // Shoelace signed area — sign encodes winding direction.
  let area = 0
  for (let i = 0; i < n; i++) {
    const a = contour[i]
    const b = contour[(i + 1) % n]
    area += a.x * b.y - b.x * a.y
  }
  if (Math.abs(area) < 1e-12) return []

  const corners: Point[] = []
  for (let i = 0; i < n; i++) {
    const prev = contour[(i - 1 + n) % n]
    const curr = contour[i]
    const next = contour[(i + 1) % n]
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
  return corners
}

/**
 * Emit one diagonal skeleton-arm cut per active corner and advance corner
 * positions to the next offset level (chain tracking).
 *
 * Each `corner` is already a vertex of `currentContour` (guaranteed by chain
 * tracking — at depth 0 corners are detected from the original contour; at
 * depth N they are the `inNext` positions returned by the previous call).
 * We therefore use `corner` directly as the "from" point and only need one
 * nearest-vertex lookup (into `nextContour`) per corner.
 *
 * This produces cuts that are consistently ~stepSize long, forming a connected
 * chain from the surface down to the collapse point — no long diagonal cuts.
 */
function stepCorners(
  activeCorners: Point[],
  nextContour: Point[],
  currentZ: number,
  nextZ: number,
  stepSize: number,
): { cuts: Path3D[], nextCorners: Point[] } {
  if (activeCorners.length === 0 || nextContour.length === 0) {
    return { cuts: [], nextCorners: [] }
  }
  const cuts: Path3D[] = []
  const nextCorners: Point[] = []

  for (const corner of activeCorners) {
    let bestIdx = 0
    let bestDist = Infinity
    for (let i = 0; i < nextContour.length; i++) {
      const d = Math.hypot(nextContour[i].x - corner.x, nextContour[i].y - corner.y)
      if (d < bestDist) { bestDist = d; bestIdx = i }
    }
    const inNext = nextContour[bestIdx]
    cuts.push([
      { x: corner.x, y: corner.y, z: currentZ },
      { x: inNext.x, y: inNext.y, z: nextZ },
    ])
    nextCorners.push({ ...inNext })
  }

  // Position-based merge: if two nextCorners have converged within half a
  // stepSize of each other they represent the same skeleton arm. Keep only
  // one so subsequent levels don't emit a fan of near-identical overlapping
  // cuts. This is safer than index-based dedup, which was dropping corners
  // belonging to different walls that happened to map to the same vertex.
  return { cuts, nextCorners: mergeCorners(nextCorners, stepSize * 0.5) }
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
  topZ: number,
  slope: number,
  maxDepth: number,
  totalOffset: number,
  stepSize: number,
  paths: Path3D[],
): void {
  const microStep = stepSize * MICRO_FRACTION
  const microRegions = buildInsetRegions(region, microStep, ClipperLib.JoinType.jtRound)
  const microZ = topZ - Math.min(maxDepth, (totalOffset + microStep) / slope)

  if (microRegions.length > 0) {
    for (const r of microRegions) {
      if (r.outer.length >= 2) {
        paths.push(contourToPath3D(r.outer, microZ))
      }
    }
  } else {
    // Nothing survived the micro-inset — emit current contour at deepest Z.
    const currentZ = topZ - Math.min(maxDepth, totalOffset / slope)
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
  corners?: Point[],  // at depth 0: detected from original shape; thereafter: chain-tracked inNext positions
): void {
  if (depth > MAX_RECURSION_DEPTH) return

  // At depth 0, detect corners from the original contour.
  // At depth N, corners are the inNext positions from the previous level —
  // they are already vertices of region.outer (guaranteed by chain tracking).
  const activeCorners = corners ?? detectCorners(region.outer)

  const currentZ = topZ - Math.min(maxDepth, totalOffset / slope)
  const nextOffset = totalOffset + stepSize
  const nextZ = topZ - Math.min(maxDepth, nextOffset / slope)

  const nextRegions = buildInsetRegions(region, stepSize, ClipperLib.JoinType.jtRound)

  // ---- COLLAPSE ----
  if (nextRegions.length === 0) {
    emitCollapseGeometry(region, topZ, slope, maxDepth, totalOffset, stepSize, paths)
    return
  }

  // ---- SPLIT ----
  if (nextRegions.length > 1) {
    // Emit the pre-split contour as a horizontal bridge at the junction depth.
    if (region.outer.length >= 2) {
      paths.push(contourToPath3D(region.outer, currentZ))
    }
    // Each child is a new shape with its own corners — detect fresh from the
    // child's boundary so pointed tips introduced by the split are captured.
    for (const nextRegion of nextRegions) {
      traceRegion(nextRegion, topZ, slope, maxDepth, stepSize, nextOffset, depth + 1, paths, detectCorners(nextRegion.outer))
    }
    return
  }

  // ---- CONTINUE ----
  const nextRegion = nextRegions[0]

  const { cuts, nextCorners } = stepCorners(activeCorners, nextRegion.outer, currentZ, nextZ, stepSize)
  paths.push(...cuts)

  // Pass nextCorners forward to continue chain tracking. If they're empty
  // (shouldn't happen without dedup, but defensive), pass undefined so the
  // next level re-detects corners fresh from its own contour.
  traceRegion(nextRegion, topZ, slope, maxDepth, stepSize, nextOffset, depth + 1, paths,
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
  maxLinkDist: number,
): ToolpathPoint | null {
  let pos = startPosition
  const chained = chainPaths(paths)

  for (let pi = 0; pi < chained.length; pi++) {
    const path = chained[pi]
    if (path.length < 2) continue

    const entry: ToolpathPoint = path[0]

    if (pos !== null) {
      const xyDist = Math.hypot(entry.x - pos.x, entry.y - pos.y)
      if (xyDist <= maxLinkDist) {
        // Direct link: skip the full retract-rapid-plunge cycle.
        // V-carve arm chains end deep and start near the surface, so the
        // direct move is almost always going shallower (withdrawing). Use a
        // rapid when rising, cut-feed when descending into material.
        const kind: ToolpathMove['kind'] = entry.z >= pos.z ? 'rapid' : 'cut'
        moves.push({ kind, from: pos, to: entry })
        pos = entry
      } else {
        pos = retractToSafe(moves, pos, safeZ)
        pos = pushRapidAndPlunge(moves, pos, entry, safeZ)
      }
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
  let currentPosition: ToolpathPoint | null = null

  for (const band of resolved.bands) {
    const maxBandDepth = Math.max(0, Math.min(operation.maxCarveDepth, band.topZ - band.bottomZ))
    if (!(maxBandDepth > 0)) {
      warnings.push(`Band ${band.topZ} -> ${band.bottomZ} leaves no usable V-carve depth`)
      continue
    }

    for (const region of band.regions) {
      const paths: Path3D[] = []
      traceRegion(region, band.topZ, slope, maxBandDepth, stepSize, 0, 0, paths)
      // Link paths within 10× stepSize without a full retract.
      // Most adjacent arm starts on a letter are within this range; anything
      // farther apart warrants a proper retract-rapid-plunge.
      currentPosition = pathsToMoves(paths, safeZ, moves, currentPosition, stepSize * 10)
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
