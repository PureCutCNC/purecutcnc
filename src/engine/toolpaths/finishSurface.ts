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
 *
 * Finish Surface Operation
 *
 * A 3D finishing operation that cleans the walls of a 3D model by following
 * its true surface contour at each step-down level.
 *
 * Two path strategies are supported:
 *
 *   Contour (pocketPattern === 'offset'):
 *     1. Slice the 3D model triangle mesh at each step-down Z level
 *     2. Optionally clip the slice contours to the region boundary
 *     3. Offset outward by tool.radius + stockToLeaveRadial
 *     4. Emit as closed contour moves at each Z
 *
 *   Parallel (pocketPattern === 'parallel'):
 *     1. Slice the mesh at every step-down Z level
 *     2. For a given scanline angle, rotate all slice contours by -angle
 *     3. Scan across the rotated bounding box at stepover intervals
 *     4. At each scanline Y, find X-interval intersections with all Z-level contours
 *     5. Collect all 3D intersection points, sort along scanline direction
 *     6. Emit as 3D open cut moves connecting surface points across Z levels
 */

import ClipperLib from 'clipper-lib'
import type { CutDirection, Operation, Point, Project, SketchFeature } from '../../types/project'
import type { ClipperPath, PocketToolpathResult, ToolpathBounds, ToolpathMove, ToolpathPoint } from './types'
import {
  DEFAULT_CLIPPER_SCALE,
  applyContourDirection,
  checkMaxCutDepthWarning,
  flattenProfile,
  getOperationSafeZ,
  normalizeToolForProject,
  normalizeWinding,
  toClipperPath,
} from './geometry'
import {
  contourStartPoint,
  generateStepLevels,
  retractToSafe,
  toClosedCutMoves,
  transitionToCutEntry,
  updateBounds,
} from './pocket'
import { loadSTLTransformedGeometry } from '../csg'

// ── Constants ───────────────────────────────────────────────────────────

/** Epsilon for floating-point Z comparisons during mesh slicing. */
const Z_EPS = 1e-8

/** Epsilon for 2D point matching during segment chaining. */
const PT_EPS = 1e-6

// ── 3D → 2D mesh slicing (non-manifold safe, shared from roughSurface) ──

interface Vec3 { x: number; y: number; z: number }

function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t }
}

function edgeCrossZ(a: Vec3, b: Vec3, z: number): Vec3 | null {
  const dzA = a.z - z
  const dzB = b.z - z
  if (Math.abs(dzA) < Z_EPS) return a
  if (Math.abs(dzB) < Z_EPS) return b
  if (dzA * dzB > 0) return null
  const t = -dzA / (dzB - dzA)
  return lerp(a, b, t)
}

function sliceMeshAtZ(
  positions: Float32Array,
  index: Uint32Array,
  z: number,
): Array<Array<[number, number]>> {
  const segments: Array<[[number, number], [number, number]]> = []

  for (let i = 0; i < index.length; i += 3) {
    const i0 = index[i]
    const i1 = index[i + 1]
    const i2 = index[i + 2]

    const p0: Vec3 = {
      x: positions[i0 * 3],
      y: positions[i0 * 3 + 1],
      z: positions[i0 * 3 + 2],
    }
    const p1: Vec3 = {
      x: positions[i1 * 3],
      y: positions[i1 * 3 + 1],
      z: positions[i1 * 3 + 2],
    }
    const p2: Vec3 = {
      x: positions[i2 * 3],
      y: positions[i2 * 3 + 1],
      z: positions[i2 * 3 + 2],
    }

    const dz = [p0.z - z, p1.z - z, p2.z - z]
    const above = dz.filter((d) => d > Z_EPS).length
    const below = dz.filter((d) => d < -Z_EPS).length
    if (above === 0 || below === 0) continue

    const pts: Array<[number, number]> = []
    const e01 = edgeCrossZ(p0, p1, z)
    if (e01) pts.push([e01.x, e01.y])
    const e12 = edgeCrossZ(p1, p2, z)
    if (e12) pts.push([e12.x, e12.y])
    const e20 = edgeCrossZ(p2, p0, z)
    if (e20) pts.push([e20.x, e20.y])
    if (pts.length >= 2) {
      segments.push([pts[0], pts[1]])
    }
  }

  return chainSegments(segments)
}

function ptKey(x: number, y: number): string {
  return `${x.toFixed(6)},${y.toFixed(6)}`
}

function chainSegments(
  segments: Array<[[number, number], [number, number]]>,
): Array<Array<[number, number]>> {
  if (segments.length === 0) return []

  const graph = new Map<
    string,
    { pt: [number, number]; neighbors: Array<{ key: string; pt: [number, number] }> }
  >()

  function ensureNode(x: number, y: number): string {
    const key = ptKey(x, y)
    if (!graph.has(key)) {
      graph.set(key, { pt: [x, y], neighbors: [] })
    }
    return key
  }

  for (const [a, b] of segments) {
    const ka = ensureNode(a[0], a[1])
    const kb = ensureNode(b[0], b[1])
    graph.get(ka)!.neighbors.push({ key: kb, pt: b })
    graph.get(kb)!.neighbors.push({ key: ka, pt: a })
  }

  const visited = new Set<string>()
  const polygons: Array<Array<[number, number]>> = []

  for (const [startKey, _startNode] of graph) {
    if (visited.has(startKey)) continue

    const poly: Array<[number, number]> = []
    let currentKey = startKey
    let prevKey: string | null = null

    while (true) {
      if (visited.has(currentKey)) break
      visited.add(currentKey)

      const node = graph.get(currentKey)!
      if (poly.length === 0) {
        poly.push(node.pt)
      }

      let next: { key: string; pt: [number, number] } | null = null
      for (const n of node.neighbors) {
        if (n.key !== prevKey) {
          next = n
          break
        }
      }
      if (!next) break
      if (next.key === startKey) break

      poly.push(next.pt)
      prevKey = currentKey
      currentKey = next.key
      if (poly.length > segments.length * 2) break
    }

    if (poly.length >= 3) {
      const first = poly[0]
      const last = poly[poly.length - 1]
      if (
        Math.abs(last[0] - first[0]) > PT_EPS ||
        Math.abs(last[1] - first[1]) > PT_EPS
      ) {
        poly.push(first)
      }
      polygons.push(poly)
    }
  }

  return polygons
}

// ── Clipper helpers ─────────────────────────────────────────────────────

/**
 * Offset (expand) contours outward by the given distance.
 * Uses positive delta for outward offset.
 */
function offsetContours(polygons: Array<Array<[number, number]>>, delta: number): Array<Array<[number, number]>> {
  if (polygons.length === 0) return []

  const paths = polygons.map((poly) =>
    poly.map(([x, y]) => ({
      X: Math.round(x * DEFAULT_CLIPPER_SCALE),
      Y: Math.round(y * DEFAULT_CLIPPER_SCALE),
    })),
  )

  const offset = new ClipperLib.ClipperOffset()
  offset.AddPaths(paths as ClipperPath[], ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon)
  const solution = new ClipperLib.Paths()
  offset.Execute(solution, Math.round(delta * DEFAULT_CLIPPER_SCALE))

  const result: Array<Array<[number, number]>> = []
  for (const path of solution as ClipperPath[]) {
    const pts: Array<[number, number]> = path.map((p) => [p.X / DEFAULT_CLIPPER_SCALE, p.Y / DEFAULT_CLIPPER_SCALE])
    if (pts.length >= 3) result.push(pts)
  }
  return result
}

/**
 * Clip (intersect) slice contours against a region boundary polygon.
 * Returns the intersection of each slice contour with the region.
 */
function clipToRegion(
  slicePolygons: Array<Array<[number, number]>>,
  regionFeature: SketchFeature,
): Array<Array<[number, number]>> {
  if (slicePolygons.length === 0) return []

  // Flatten region profile to Clipper path
  const flattened = flattenProfile(regionFeature.sketch.profile)
  const regionPath = toClipperPath(normalizeWinding(flattened.points, false), DEFAULT_CLIPPER_SCALE)

  const clipper = new ClipperLib.Clipper()
  const subjectPaths = slicePolygons.map((poly) =>
    poly.map(([x, y]) => ({
      X: Math.round(x * DEFAULT_CLIPPER_SCALE),
      Y: Math.round(y * DEFAULT_CLIPPER_SCALE),
    })),
  )
  clipper.AddPaths(subjectPaths as ClipperPath[], ClipperLib.PolyType.ptSubject, true)
  clipper.AddPaths([regionPath], ClipperLib.PolyType.ptClip, true)

  const solution = new ClipperLib.Paths()
  clipper.Execute(ClipperLib.ClipType.ctIntersection, solution, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)

  const result: Array<Array<[number, number]>> = []
  for (const path of solution as ClipperPath[]) {
    const pts: Array<[number, number]> = path.map((p) => [p.X / DEFAULT_CLIPPER_SCALE, p.Y / DEFAULT_CLIPPER_SCALE])
    if (pts.length >= 3) result.push(pts)
  }
  return result
}

// ── Parallel strategy helpers ───────────────────────────────────────────

function pointEpsilonEqual(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9
}

function rotatePoint(point: Point, cosTheta: number, sinTheta: number): Point {
  return {
    x: point.x * cosTheta - point.y * sinTheta,
    y: point.x * sinTheta + point.y * cosTheta,
  }
}

/**
 * Find X-intervals where a horizontal scanline at `y` intersects a closed polygon.
 */
function scanlineIntervals(points: Point[], y: number): Array<[number, number]> {
  const intersections: number[] = []
  const closed = points.length > 0 && pointEpsilonEqual(points[0], points[points.length - 1])
    ? points
    : [...points, points[0]]

  for (let index = 0; index < closed.length - 1; index += 1) {
    const a = closed[index]
    const b = closed[index + 1]

    if (Math.abs(a.y - b.y) <= 1e-9) continue

    const intersects = (a.y <= y && b.y > y) || (b.y <= y && a.y > y)
    if (!intersects) continue

    const t = (y - a.y) / (b.y - a.y)
    intersections.push(a.x + (b.x - a.x) * t)
  }

  intersections.sort((left, right) => left - right)

  const intervals: Array<[number, number]> = []
  for (let index = 0; index + 1 < intersections.length; index += 2) {
    const start = intersections[index]
    const end = intersections[index + 1]
    if (end - start > 1e-9) {
      intervals.push([start, end])
    }
  }
  return intervals
}

/**
 * Build a minimal XY bounding box from a Float32Array of positions (stride = 3).
 */
function computeXYBounds(positions: Float32Array): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]
    const y = positions[i + 1]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return { minX, maxX, minY, maxY }
}

/**
 * Emit 3D open cut moves where each point has its own Z.
 */
function toOpenCutMoves3D(points: ToolpathPoint[]): ToolpathMove[] {
  if (points.length < 2) return []
  const moves: ToolpathMove[] = []
  for (let i = 0; i < points.length - 1; i += 1) {
    moves.push({
      kind: 'cut',
      from: points[i],
      to: points[i + 1],
    })
  }
  return moves
}

/**
 * Parallel strategy for finish surface.
 *
 * Generates 3D parallel passes where the tool follows the model surface
 * along parallel scanlines at a configurable angle. At each step-down Z
 * level, the scanline is intersected with the model's slice contours to
 * produce 3D points. These are sorted along the scanline direction and
 * emitted as 3D open cut moves.
 */
function generateFinishSurfaceParallel(
  _project: Project,
  operation: Operation,
  _modelFeature: SketchFeature,
  regionFeature: SketchFeature | undefined,
  tool: ReturnType<typeof normalizeToolForProject>,
  stepLevels: number[],
  transformedPos: Float32Array,
  index: Uint32Array,
  safeZ: number,
  maxLinkDistance: number,
  warnings: string[],
): { moves: ToolpathMove[]; stepLevels: Set<number> } {
  const stepoverRatio = operation.stepover ?? 0.5
  const stepoverDistance = Math.max(stepoverRatio * tool.diameter, 1e-3)
  const angleDeg = operation.pocketAngle ?? 0

  if (operation.debugToolpath) {
    warnings.push(
      `Debug: parallel mode, angle=${angleDeg}°, stepover=${stepoverDistance.toFixed(4)}`,
    )
  }

  // ── Pre-compute slice contours at each Z level ────────────────────────

  const sliceMap = new Map<number, Array<Array<[number, number]>>>()
  for (const z of stepLevels) {
    let polygons = sliceMeshAtZ(transformedPos, index, z)
    if (polygons.length > 0 && regionFeature) {
      polygons = clipToRegion(polygons, regionFeature)
    }
    sliceMap.set(z, polygons)
  }

  // ── XY bounding box of the model ──────────────────────────────────────

  const bbox = computeXYBounds(transformedPos)

  // ── Rotate bounding box by -angle to align scanlines with Y axis ─────

  const angleRad = (angleDeg * Math.PI) / 180
  const cosNeg = Math.cos(-angleRad)
  const sinNeg = Math.sin(-angleRad)
  const cosPos = Math.cos(angleRad)
  const sinPos = Math.sin(angleRad)

  const corners = [
    { x: bbox.minX, y: bbox.minY },
    { x: bbox.maxX, y: bbox.minY },
    { x: bbox.maxX, y: bbox.maxY },
    { x: bbox.minX, y: bbox.maxY },
  ].map((p) => rotatePoint(p, cosNeg, sinNeg))

  const rotMinY = Math.min(...corners.map((c) => c.y))
  const rotMaxY = Math.max(...corners.map((c) => c.y))

  // ── Generate scanlines ────────────────────────────────────────────────

  const allMoves: ToolpathMove[] = []
  const allStepLevels = new Set<number>()
  let currentPosition: ToolpathPoint | null = null
  let scanIndex = 0

  for (
    let rotY = rotMinY + stepoverDistance / 2;
    rotY < rotMaxY;
    rotY += stepoverDistance, scanIndex += 1
  ) {
    const scanPoints: Array<{ x: number; y: number; z: number; rotX: number }> = []

    // Collect intersection points from all Z levels for this scanline
    for (const z of stepLevels) {
      const contours = sliceMap.get(z)
      if (!contours || contours.length === 0) continue

      for (const contour of contours) {
        // Rotate contour by -angle so scanlines become horizontal
        const rotatedContour = contour.map(([x, y]) => rotatePoint({ x, y }, cosNeg, sinNeg))

        const intervals = scanlineIntervals(rotatedContour, rotY)
        for (const [x1, x2] of intervals) {
          // Convert back to original coordinates
          const p1 = rotatePoint({ x: x1, y: rotY }, cosPos, sinPos)
          const p2 = rotatePoint({ x: x2, y: rotY }, cosPos, sinPos)
          scanPoints.push({ x: p1.x, y: p1.y, z, rotX: x1 })
          scanPoints.push({ x: p2.x, y: p2.y, z, rotX: x2 })
        }
      }
    }

    if (scanPoints.length < 2) continue

    // Sort by position along scanline (rotated X coordinate)
    scanPoints.sort((a, b) => a.rotX - b.rotX)

    // Alternate direction to minimise rapids (zigzag)
    if (scanIndex % 2 === 1) {
      scanPoints.reverse()
    }

    // Record step levels touched
    for (const sp of scanPoints) {
      allStepLevels.add(sp.z)
    }

    // Build 3D points for this scanline
    const cutPoints3D: ToolpathPoint[] = scanPoints.map((sp) => ({
      x: sp.x,
      y: sp.y,
      z: sp.z,
    }))
    const entryPoint = cutPoints3D[0]

    // Link from previous position to this scanline's start.
    // transitionToCutEntry now handles 3D cut links across Z levels when
    // the XY distance is within maxLinkDistance, and falls back to
    // retract → rapid → plunge when it isn't.
    currentPosition = transitionToCutEntry(
      allMoves,
      currentPosition,
      entryPoint,
      safeZ,
      maxLinkDistance,
    )

    // Emit 3D cut moves for this scanline
    allMoves.push(...toOpenCutMoves3D(cutPoints3D))
    currentPosition = cutPoints3D[cutPoints3D.length - 1]
  }

  return { moves: allMoves, stepLevels: allStepLevels }
}

// ── Main entry point ────────────────────────────────────────────────────

export function generateFinishSurfaceToolpath(
  project: Project,
  operation: Operation,
): PocketToolpathResult {
  const target = operation.target
  if (target.source !== 'features' || target.featureIds.length === 0 || target.featureIds.length > 2) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['Finish surface requires a model feature and optionally a region feature'],
      bounds: null,
      stepLevels: [],
    }
  }

  // ── Identify features ──────────────────────────────────────────────────

  const targetFeatures = target.featureIds
    .map((id) => project.features.find((f) => f.id === id) ?? null)
    .filter((f): f is SketchFeature => f !== null)

  if (targetFeatures.length !== target.featureIds.length) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['One or more target features not found'],
      bounds: null,
      stepLevels: [],
    }
  }

  const modelFeature = targetFeatures.find((f) => f.operation === 'model' && f.kind === 'stl')
  const regionFeature = targetFeatures.find((f) => f.operation === 'region' && f.sketch.profile.closed)

  if (!modelFeature) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['Finish surface requires a model feature (imported STL)'],
      bounds: null,
      stepLevels: [],
    }
  }

  // If 2 features supplied but second is not a valid region, warn
  if (target.featureIds.length === 2 && !regionFeature) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['Second target must be a closed region feature'],
      bounds: null,
      stepLevels: [],
    }
  }

  // ── Tool validation ────────────────────────────────────────────────────

  const toolRecord =
    operation.toolRef ? project.tools.find((t) => t.id === operation.toolRef) ?? null : null
  if (!toolRecord) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['No tool assigned to this operation'],
      bounds: null,
      stepLevels: [],
    }
  }
  const tool = normalizeToolForProject(toolRecord, project)
  if (!(tool.diameter > 0)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['Tool diameter must be greater than zero'],
      bounds: null,
      stepLevels: [],
    }
  }
  if (!(operation.stepdown > 0)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['Operation stepdown must be greater than zero'],
      bounds: null,
      stepLevels: [],
    }
  }

  // ── Load transformed STL geometry (shared with 3D preview) ────────────

  const stlData = loadSTLTransformedGeometry(modelFeature, project)
  if (!stlData) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['Failed to load STL geometry'],
      bounds: null,
      stepLevels: [],
    }
  }

  const { positions: transformedPos, index } = stlData

  // ── Compute Z bounds from transformed positions ───────────────────────

  let modelTopZ = -Infinity
  let modelBottomZ = Infinity
  for (let i = 0; i < transformedPos.length; i += 3) {
    const z = transformedPos[i + 2]
    if (z > modelTopZ) modelTopZ = z
    if (z < modelBottomZ) modelBottomZ = z
  }

  // ── Operation parameters ───────────────────────────────────────────────

  const radialLeave = Math.max(0, operation.stockToLeaveRadial)
  const axialLeave = Math.max(0, operation.stockToLeaveAxial)
  const effectiveBottom = modelBottomZ + axialLeave
  if (effectiveBottom >= modelTopZ) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['Axial stock-to-leave exceeds model height — nothing to cut'],
      bounds: null,
      stepLevels: [],
    }
  }

  // ── Step levels ────────────────────────────────────────────────────────

  const stepLevels = generateStepLevels(modelTopZ, effectiveBottom, operation.stepdown)
  if (stepLevels.length === 0) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['No step levels generated'],
      bounds: null,
      stepLevels: [],
    }
  }

  // ── Cut parameters ─────────────────────────────────────────────────────

  const safeZ = getOperationSafeZ(project)
  const maxLinkDistance = tool.diameter
  const direction: CutDirection = operation.cutDirection ?? 'conventional'
  const finishOffset = tool.radius + radialLeave

  const warnings: string[] = []

  // ── Route to parallel or contour strategy ─────────────────────────────

  if (operation.pocketPattern === 'parallel') {
    const parallelResult = generateFinishSurfaceParallel(
      project,
      operation,
      modelFeature,
      regionFeature ?? undefined,
      tool,
      stepLevels,
      transformedPos,
      index,
      safeZ,
      maxLinkDistance,
      warnings,
    )

    let bounds: ToolpathBounds | null = null
    for (const move of parallelResult.moves) {
      bounds = updateBounds(bounds, move.from)
      bounds = updateBounds(bounds, move.to)
    }

    return {
      operationId: operation.id,
      moves: parallelResult.moves,
      warnings,
      bounds,
      stepLevels: [...parallelResult.stepLevels].sort((a, b) => b - a),
    }
  }

  // ── Per-level: slice → clip → offset → emit contour moves ─────────────

  const allMoves: ToolpathMove[] = []
  const allStepLevels = new Set<number>()

  const depthWarning = checkMaxCutDepthWarning(tool, Math.abs(modelTopZ - effectiveBottom))
  if (depthWarning) warnings.push(depthWarning)

  if (operation.debugToolpath) {
    warnings.push(
      `Debug: Z range ${modelTopZ.toFixed(4)} -> ${modelBottomZ.toFixed(4)}, bottom ${effectiveBottom.toFixed(4)}`,
    )
    warnings.push(`Debug: levels = ${stepLevels.map((z) => z.toFixed(4)).join(', ')}`)
    warnings.push(`Debug: mesh triangles = ${index.length / 3}`)
    warnings.push(`Debug: finishOffset = ${finishOffset.toFixed(4)}`)
    if (regionFeature) {
      warnings.push(`Debug: region ${regionFeature.name} (${regionFeature.id}) — clipping enabled`)
    }
  }

  let currentPosition: ToolpathPoint | null = null

  for (const z of stepLevels) {
    allStepLevels.add(z)

    // ═══ 1. Slice the triangle mesh at this Z ════════════════════════════
    let slicePolygons = sliceMeshAtZ(transformedPos, index, z)

    if (slicePolygons.length === 0) {
      if (operation.debugToolpath) {
        warnings.push(`Debug: Z=${z.toFixed(4)} empty slice — no model at this level`)
      }
      currentPosition = retractToSafe(allMoves, currentPosition, safeZ)
      continue
    }

    // ═══ 2. Optionally clip slice contours to region boundary ════════════
    if (regionFeature) {
      slicePolygons = clipToRegion(slicePolygons, regionFeature)
      if (slicePolygons.length === 0) {
        if (operation.debugToolpath) {
          warnings.push(`Debug: Z=${z.toFixed(4)} slice outside region — skipping`)
        }
        currentPosition = retractToSafe(allMoves, currentPosition, safeZ)
        continue
      }
    }

    // ═══ 3. Offset outward by tool.radius + radialLeave ═══════════════════
    const finishContours = offsetContours(slicePolygons, finishOffset)
    if (finishContours.length === 0) {
      if (operation.debugToolpath) {
        warnings.push(`Debug: Z=${z.toFixed(4)} offset produced empty contours`)
      }
      currentPosition = retractToSafe(allMoves, currentPosition, safeZ)
      continue
    }

    // ═══ 4. Apply cut direction and emit as closed contour moves ═════════
    const directedContours = applyContourDirection(finishContours.map((c) =>
      c.map(([x, y]) => ({ x, y }) as Point),
    ), direction)

    for (const contour of directedContours) {
      const entryPoint = contourStartPoint(contour, z)
      currentPosition = transitionToCutEntry(allMoves, currentPosition, entryPoint, safeZ, maxLinkDistance)
      const cutMoves = toClosedCutMoves(contour, z)
      allMoves.push(...cutMoves)
      currentPosition = cutMoves.at(-1)?.to ?? currentPosition
    }

    currentPosition = retractToSafe(allMoves, currentPosition, safeZ)
  }

  // ── Bounds ─────────────────────────────────────────────────────────────

  let bounds: ToolpathBounds | null = null
  for (const move of allMoves) {
    bounds = updateBounds(bounds, move.from)
    bounds = updateBounds(bounds, move.to)
  }

  return {
    operationId: operation.id,
    moves: allMoves,
    warnings,
    bounds,
    stepLevels: [...allStepLevels].sort((a, b) => b - a),
  }
}
