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
 * Find the vertex in `candidates` closest to `pt`.
 */
function findClosestVertex(pt: Point, candidates: Point[]): Point {
  let best = candidates[0]
  let bestDist = Infinity
  for (const c of candidates) {
    const d = Math.hypot(c.x - pt.x, c.y - pt.y)
    if (d < bestDist) {
      bestDist = d
      best = c
    }
  }
  return best
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
 * Emit one diagonal skeleton-arm cut per active corner.
 *
 * The original corner position is used as the search reference for BOTH
 * endpoints, but each endpoint is snapped to the nearest vertex on its
 * respective contour. This guarantees short cuts (≈ stepSize) that are
 * always anchored to real contour geometry — no long diagonal destruction
 * cuts when the original corner position drifts far from the current shape.
 *
 * The original corners are passed unchanged to the next recursive level so
 * they remain a stable reference throughout the recursion.
 */
function stepCorners(
  activeCorners: Point[],
  currentContour: Point[],
  nextContour: Point[],
  currentZ: number,
  nextZ: number,
): Path3D[] {
  if (activeCorners.length === 0 || currentContour.length === 0 || nextContour.length === 0) return []
  const cuts: Path3D[] = []
  for (const corner of activeCorners) {
    const inCurrent = findClosestVertex(corner, currentContour)
    const inNext = findClosestVertex(corner, nextContour)
    cuts.push([
      { x: inCurrent.x, y: inCurrent.y, z: currentZ },
      { x: inNext.x, y: inNext.y, z: nextZ },
    ])
  }
  return cuts
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
  corners?: Point[],  // detected once from the original shape, passed through recursion
): void {
  if (depth > MAX_RECURSION_DEPTH) return

  // Detect corners exactly once — from the original unmodified contour.
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

  paths.push(...stepCorners(activeCorners, region.outer, nextRegion.outer, currentZ, nextZ))

  traceRegion(nextRegion, topZ, slope, maxDepth, stepSize, nextOffset, depth + 1, paths, activeCorners)
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

  for (const path of paths) {
    if (path.length < 2) continue

    const entry: ToolpathPoint = path[0]
    pos = retractToSafe(moves, pos, safeZ)
    pos = pushRapidAndPlunge(moves, pos, entry, safeZ)

    for (let i = 1; i < path.length; i++) {
      const from = path[i - 1]
      const to = path[i]
      moves.push({ kind: 'cut', from, to })
      pos = to
    }

    pos = retractToSafe(moves, pos, safeZ)
  }

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
