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
 * A single parallel-strategy path is used:
 *
 *   Parallel (pocketPattern === 'parallel'):
 *     1. Use the model's projected silhouette, clipped by selected regions
 *     2. For a given scanline angle, rotate coverage contours by -angle
 *     3. Scan across the rotated coverage box at stepover intervals
 *     4. At each scanline Y, find X-intervals inside the coverage contours
 *     5. Sample the top height map along each interval
 *     6. Emit each interval as its own 3D cut segment
 */

import ClipperLib from 'clipper-lib'
import { getProfileBounds, type Operation, type Point, type Project, type SketchFeature } from '../../types/project'
import type { ClipperPath, PocketToolpathResult, ToolpathBounds, ToolpathMove, ToolpathPoint } from './types'
import {
  DEFAULT_CLIPPER_SCALE,
  flattenProfile,
  getOperationSafeZ,
  normalizeToolForProject,
  normalizeWinding,
  toClipperPath,
} from './geometry'
import {
  generateStepLevels,
  retractToSafe,
  transitionToCutEntry,
  updateBounds,
} from './pocket'
import { loadSTLTransformedGeometry } from '../csg'
import { significantSilhouettePaths } from './silhouette'

function buildRegionUnionPaths(regionFeatures: SketchFeature[] | SketchFeature): ClipperPath[] {
  const regions = Array.isArray(regionFeatures) ? regionFeatures : [regionFeatures]
  if (regions.length === 0) return []

  const clipperUnion = new ClipperLib.Clipper()
  const regionPaths: ClipperPath[] = []
  for (const region of regions) {
    const flattened = flattenProfile(region.sketch.profile)
    const path = toClipperPath(normalizeWinding(flattened.points, false), DEFAULT_CLIPPER_SCALE)
    regionPaths.push(path)
  }
  clipperUnion.AddPaths(regionPaths, ClipperLib.PolyType.ptSubject, true)
  const unionSolution = new ClipperLib.Paths()
  clipperUnion.Execute(
    ClipperLib.ClipType.ctUnion,
    unionSolution,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  )
  return unionSolution as ClipperPath[]
}

/**
 * Clip (intersect) slice contours against pre-unioned region boundary paths.
 * Returns the intersection of each slice contour with the allowed region.
 */
function clipToRegionPaths(
  slicePolygons: Array<Array<[number, number]>>,
  regionPaths: ClipperPath[],
): Array<Array<[number, number]>> {
  if (slicePolygons.length === 0 || regionPaths.length === 0) return []

  // Intersect slice polygons with the unioned region boundary
  const clipper = new ClipperLib.Clipper()
  const subjectPaths = slicePolygons.map((poly) =>
    poly.map(([x, y]) => ({
      X: Math.round(x * DEFAULT_CLIPPER_SCALE),
      Y: Math.round(y * DEFAULT_CLIPPER_SCALE),
    })),
  )
  clipper.AddPaths(subjectPaths as ClipperPath[], ClipperLib.PolyType.ptSubject, true)
  clipper.AddPaths(regionPaths, ClipperLib.PolyType.ptClip, true)

  const solution = new ClipperLib.Paths()
  clipper.Execute(ClipperLib.ClipType.ctIntersection, solution, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)

  const result: Array<Array<[number, number]>> = []
  for (const path of solution as ClipperPath[]) {
    const pts: Array<[number, number]> = path.map((p) => [p.X / DEFAULT_CLIPPER_SCALE, p.Y / DEFAULT_CLIPPER_SCALE])
    if (pts.length >= 3) result.push(pts)
  }
  return result
}

function computeContourBounds(
  contours: Iterable<Array<Array<[number, number]>>>,
): { minX: number; maxX: number; minY: number; maxY: number } | null {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const contourSet of contours) {
    for (const contour of contourSet) {
      for (const [x, y] of contour) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  return Number.isFinite(minX) && Number.isFinite(maxX) && Number.isFinite(minY) && Number.isFinite(maxY)
    ? { minX, maxX, minY, maxY }
    : null
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

function computeRegionFeatureBounds(regionFeatures: SketchFeature[]): { minX: number; maxX: number; minY: number; maxY: number } | null {
  if (regionFeatures.length === 0) return null

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const region of regionFeatures) {
    const bounds = getProfileBounds(region.sketch.profile)
    if (bounds.minX < minX) minX = bounds.minX
    if (bounds.maxX > maxX) maxX = bounds.maxX
    if (bounds.minY < minY) minY = bounds.minY
    if (bounds.maxY > maxY) maxY = bounds.maxY
  }

  return Number.isFinite(minX) && Number.isFinite(maxX) && Number.isFinite(minY) && Number.isFinite(maxY)
    ? { minX, maxX, minY, maxY }
    : null
}

function clampExpandedBoundsToModel(
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
  modelBounds: { minX: number; maxX: number; minY: number; maxY: number },
  padding: number,
): { minX: number; maxX: number; minY: number; maxY: number } {
  const expanded = {
    minX: Math.max(modelBounds.minX, bounds.minX - padding),
    maxX: Math.min(modelBounds.maxX, bounds.maxX + padding),
    minY: Math.max(modelBounds.minY, bounds.minY - padding),
    maxY: Math.min(modelBounds.maxY, bounds.maxY + padding),
  }

  return expanded.maxX > expanded.minX && expanded.maxY > expanded.minY
    ? expanded
    : modelBounds
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

// ── Height map for gouge protection ──────────────────────────────────────

const MAX_HEIGHT_MAP_CELLS = 1_000_000

interface HeightMap {
  data: Float32Array
  width: number
  height: number
  originX: number
  originY: number
  cellSize: number
}

type CoverageContours = Array<Array<[number, number]>>
type HeightMapCacheHost = { finishHeightMapCache?: Map<string, HeightMap> }

function chooseHeightMapCellSize(
  bbox: { minX: number; maxX: number; minY: number; maxY: number },
  requestedCellSize: number,
  warnings: string[],
): number {
  let cellSize = Math.max(requestedCellSize, 1e-6)
  const spanX = Math.max(0, bbox.maxX - bbox.minX)
  const spanY = Math.max(0, bbox.maxY - bbox.minY)
  const requestedWidth = Math.max(1, Math.ceil(spanX / cellSize))
  const requestedHeight = Math.max(1, Math.ceil(spanY / cellSize))
  const requestedCells = requestedWidth * requestedHeight
  if (requestedCells <= MAX_HEIGHT_MAP_CELLS) return cellSize

  cellSize *= Math.sqrt(requestedCells / MAX_HEIGHT_MAP_CELLS)
  warnings.push(
    `Finish surface height map reduced from ${requestedCells.toLocaleString()} to about ${MAX_HEIGHT_MAP_CELLS.toLocaleString()} cells for performance`,
  )
  return cellSize
}

/**
 * Rasterize mesh triangles onto a regular 2D grid. Each cell stores the
 * topmost surface Z at that XY position. Used by gouge protection to query
 * surface height at arbitrary points within the tool radius.
 *
 * Cell size should be tool.radius / 3 for a good balance of accuracy and
 * performance.
 */
function buildHeightMap(
  positions: Float32Array,
  index: Uint32Array,
  bbox: { minX: number; maxX: number; minY: number; maxY: number },
  cellSize: number,
): HeightMap {
  const width = Math.max(1, Math.ceil((bbox.maxX - bbox.minX) / cellSize))
  const height = Math.max(1, Math.ceil((bbox.maxY - bbox.minY) / cellSize))
  const data = new Float32Array(width * height)
  data.fill(-Infinity)

  for (let i = 0; i < index.length; i += 3) {
    const i0 = index[i] * 3
    const i1 = index[i + 1] * 3
    const i2 = index[i + 2] * 3

    const v0x = positions[i0],     v0y = positions[i0 + 1], v0z = positions[i0 + 2]
    const v1x = positions[i1],     v1y = positions[i1 + 1], v1z = positions[i1 + 2]
    const v2x = positions[i2],     v2y = positions[i2 + 1], v2z = positions[i2 + 2]

    // Triangle XY bounding box
    const tMinX = Math.min(v0x, v1x, v2x)
    const tMaxX = Math.max(v0x, v1x, v2x)
    const tMinY = Math.min(v0y, v1y, v2y)
    const tMaxY = Math.max(v0y, v1y, v2y)

    // Clamp to overall bbox grid bounds
    const colStart = Math.max(0, Math.floor((tMinX - bbox.minX) / cellSize))
    const colEnd   = Math.min(width - 1, Math.floor((tMaxX - bbox.minX) / cellSize))
    const rowStart = Math.max(0, Math.floor((tMinY - bbox.minY) / cellSize))
    const rowEnd   = Math.min(height - 1, Math.floor((tMaxY - bbox.minY) / cellSize))

    // Edge vectors for barycentric test
    const e0x = v1x - v0x, e0y = v1y - v0y
    const e1x = v2x - v0x, e1y = v2y - v0y
    const denom = e0x * e1y - e0y * e1x
    if (Math.abs(denom) < 1e-15) continue

    for (let row = rowStart; row <= rowEnd; row++) {
      for (let col = colStart; col <= colEnd; col++) {
        const cx = bbox.minX + (col + 0.5) * cellSize
        const cy = bbox.minY + (row + 0.5) * cellSize

        // Barycentric coordinates: P = v0 + u*(v1-v0) + v*(v2-v0)
        const px = cx - v0x, py = cy - v0y
        const u = (px * e1y - py * e1x) / denom
        const v = (py * e0x - px * e0y) / denom
        if (u < 0 || v < 0 || u + v > 1) continue

        const w = 1 - u - v
        const z = w * v0z + u * v1z + v * v2z
        const idx = row * width + col
        if (z > data[idx]) data[idx] = z
      }
    }
  }

  return { data, width, height, originX: bbox.minX, originY: bbox.minY, cellSize }
}

function heightMapCacheKey(
  bbox: { minX: number; maxX: number; minY: number; maxY: number },
  cellSize: number,
): string {
  return [
    bbox.minX,
    bbox.maxX,
    bbox.minY,
    bbox.maxY,
    cellSize,
  ].map((value) => value.toFixed(6)).join('|')
}

function getCachedHeightMap(
  host: HeightMapCacheHost,
  positions: Float32Array,
  index: Uint32Array,
  bbox: { minX: number; maxX: number; minY: number; maxY: number },
  cellSize: number,
): HeightMap {
  const key = heightMapCacheKey(bbox, cellSize)
  const cached = host.finishHeightMapCache?.get(key)
  if (cached) return cached

  const heightMap = buildHeightMap(positions, index, bbox, cellSize)
  if (!host.finishHeightMapCache) {
    host.finishHeightMapCache = new Map()
  }
  host.finishHeightMapCache.set(key, heightMap)
  return heightMap
}

/**
 * Apply ball-end gouge protection to a set of scanline points using a
 * pre-computed height map.
 *
 * For each point P at (x, y) with surface height z_s(P) and ball end mill
 * radius R, the safe Z is the maximum over all neighboring grid cells Q
 * within distance d ≤ R of:
 *
 *   z_s(Q) - R + sqrt(R² - d²)
 *
 * This raises the tool tip in narrow valleys where the tool body would
 * collide with valley walls.
 */
function applyGougeProtection(
  scanPoints: Array<{ x: number; y: number; z: number; rotX: number }>,
  heightMap: HeightMap,
  toolRadius: number,
): void {
  const neighborCells = Math.ceil(toolRadius / heightMap.cellSize)
  const radiusSq = toolRadius * toolRadius

  for (let pi = 0; pi < scanPoints.length; pi++) {
    const sp = scanPoints[pi]
    const col = Math.floor((sp.x - heightMap.originX) / heightMap.cellSize)
    const row = Math.floor((sp.y - heightMap.originY) / heightMap.cellSize)

    let safeZ = sp.z

    const minC = Math.max(0, col - neighborCells)
    const maxC = Math.min(heightMap.width - 1, col + neighborCells)
    const minR = Math.max(0, row - neighborCells)
    const maxR = Math.min(heightMap.height - 1, row + neighborCells)

    for (let nr = minR; nr <= maxR; nr++) {
      for (let nc = minC; nc <= maxC; nc++) {
        const cellZ = heightMap.data[nr * heightMap.width + nc]
        if (!isFinite(cellZ)) continue

        // Cell center in world coordinates
        const cx = heightMap.originX + (nc + 0.5) * heightMap.cellSize
        const cy = heightMap.originY + (nr + 0.5) * heightMap.cellSize

        const dx = cx - sp.x
        const dy = cy - sp.y
        const dSq = dx * dx + dy * dy
        if (dSq > radiusSq) continue

        const constrained = cellZ - toolRadius + Math.sqrt(radiusSq - dSq)
        if (constrained > safeZ) safeZ = constrained
      }
    }

    sp.z = safeZ
  }
}

function queryHeightMapTopZ(heightMap: HeightMap, x: number, y: number): number | null {
  const col = Math.floor((x - heightMap.originX) / heightMap.cellSize)
  const row = Math.floor((y - heightMap.originY) / heightMap.cellSize)
  if (col < 0 || col >= heightMap.width || row < 0 || row >= heightMap.height) return null

  const z = heightMap.data[row * heightMap.width + col]
  return isFinite(z) ? z : null
}

function buildTopSurfaceSegment(
  x1: number,
  x2: number,
  rotY: number,
  cosPos: number,
  sinPos: number,
  heightMap: HeightMap,
  sampleDistance: number,
): Array<{ x: number; y: number; z: number; rotX: number }> {
  const length = Math.abs(x2 - x1)
  const sampleCount = Math.max(1, Math.ceil(length / sampleDistance))
  const points: Array<{ x: number; y: number; z: number; rotX: number }> = []

  for (let index = 0; index <= sampleCount; index += 1) {
    const t = index / sampleCount
    const rotX = x1 + (x2 - x1) * t
    const point = rotatePoint({ x: rotX, y: rotY }, cosPos, sinPos)
    const topZ = queryHeightMapTopZ(heightMap, point.x, point.y)
    if (topZ === null) continue

    points.push({
      x: point.x,
      y: point.y,
      z: topZ,
      rotX,
    })
  }

  return points
}

function modelSilhouetteContours(modelFeature: SketchFeature): CoverageContours {
  if (modelFeature.kind === 'stl' && modelFeature.stl?.silhouettePaths?.length) {
    return significantSilhouettePaths(modelFeature.stl.silhouettePaths)
      .map((path) => path.map((point) => [point.x, point.y]))
  }

  const flattened = flattenProfile(modelFeature.sketch.profile)
  return flattened.points.length >= 3
    ? [flattened.points.map((point) => [point.x, point.y])]
    : []
}

/**
 * Parallel strategy for finish surface.
 *
 * Generates 3D parallel passes where the tool follows the model surface
 * along parallel scanlines at a configurable angle. At each step-down Z
 * level, the scanline is intersected with the model's projected coverage to
 * produce 3D intervals. Each interval is sampled from the top height map.
 */
function generateFinishSurfaceParallel(
  _project: Project,
  operation: Operation,
  modelFeature: SketchFeature,
  regionFeatures: SketchFeature[],
  tool: ReturnType<typeof normalizeToolForProject>,
  _stepLevels: number[],
  transformedPos: Float32Array,
  index: Uint32Array,
  sliceIndexHost: HeightMapCacheHost,
  safeZ: number,
  _maxLinkDistance: number,
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

  // ── Build height map for ball-end gouge protection ────────────────────
  //     Cell size = tool.radius / 3 balances accuracy vs performance.
  //     Built once per operation (not per scanline).
  const modelBbox = computeXYBounds(transformedPos)
  const regionBounds = computeRegionFeatureBounds(regionFeatures)
  const heightMapBbox = regionBounds
    ? clampExpandedBoundsToModel(regionBounds, modelBbox, tool.radius)
    : modelBbox
  const heightMapCellSize = chooseHeightMapCellSize(heightMapBbox, tool.radius / 3, warnings)
  const heightMap = getCachedHeightMap(sliceIndexHost, transformedPos, index, heightMapBbox, heightMapCellSize)
  const topSurfaceSampleDistance = Math.max(heightMapCellSize, Math.min(stepoverDistance, tool.radius * 0.5))

  // ── Rotation parameters for angled scanlines ─────────────────────────

  const angleRad = (angleDeg * Math.PI) / 180
  const cosNeg = Math.cos(-angleRad)
  const sinNeg = Math.sin(-angleRad)
  const cosPos = Math.cos(angleRad)
  const sinPos = Math.sin(angleRad)

  // ── Helper: generate scanlines for a coverage contour set & bbox ─────

  function emitScanlines(
    contours: CoverageContours,
    bbox: { minX: number; maxX: number; minY: number; maxY: number },
    startScanIndex: number,
    moves: ToolpathMove[],
    outStepLevels: Set<number>,
    position: ToolpathPoint | null,
  ): ToolpathPoint | null {
    const corners = [
      { x: bbox.minX, y: bbox.minY },
      { x: bbox.maxX, y: bbox.minY },
      { x: bbox.maxX, y: bbox.maxY },
      { x: bbox.minX, y: bbox.maxY },
    ].map((p) => rotatePoint(p, cosNeg, sinNeg))

    const rotMinY = Math.min(...corners.map((c) => c.y))
    const rotMaxY = Math.max(...corners.map((c) => c.y))
    const rotatedContours = contours.map((contour) => contour.map(([x, y]) => rotatePoint({ x, y }, cosNeg, sinNeg)))
    let scanIndex = startScanIndex
    let pos = position

    for (
      let rotY = rotMinY + stepoverDistance / 2;
      rotY < rotMaxY;
      rotY += stepoverDistance, scanIndex += 1
    ) {
      const scanSegments: Array<Array<{ x: number; y: number; z: number; rotX: number }>> = []

      for (const contour of rotatedContours) {
        const intervals = scanlineIntervals(contour, rotY)
        for (const [x1, x2] of intervals) {
          const segment = buildTopSurfaceSegment(x1, x2, rotY, cosPos, sinPos, heightMap, topSurfaceSampleDistance)
          if (segment.length >= 2) scanSegments.push(segment)
        }
      }

      if (scanSegments.length === 0) continue

      scanSegments.sort((a, b) => a[0].rotX - b[0].rotX)

      if (scanIndex % 2 === 1) {
        scanSegments.reverse()
        for (const segment of scanSegments) {
          segment.reverse()
        }
      }

      for (const segment of scanSegments) {
        applyGougeProtection(segment, heightMap, tool.radius)

        for (const sp of segment) {
          outStepLevels.add(sp.z)
        }

        const cutPoints3D: ToolpathPoint[] = segment.map((sp) => ({
          x: sp.x,
          y: sp.y,
          z: sp.z,
        }))
        const entryPoint = cutPoints3D[0]

        pos = transitionToCutEntry(moves, pos, entryPoint, safeZ, 0)
        moves.push(...toOpenCutMoves3D(cutPoints3D))
        pos = cutPoints3D[cutPoints3D.length - 1]
      }
    }

    return pos
  }

  // ── Generate per-region or whole-model scanlines ────────────────────

  const allMoves: ToolpathMove[] = []
  const allStepLevels = new Set<number>()
  let currentPosition: ToolpathPoint | null = null
  let scanIndex = 0
  const baseContours = modelSilhouetteContours(modelFeature)
  const baseBounds = computeContourBounds([baseContours])
  if (!baseBounds) {
    warnings.push('Model silhouette is degenerate — no finish surface coverage generated')
    return { moves: allMoves, stepLevels: allStepLevels }
  }

  if (regionFeatures.length === 0) {
    // No regions — process entire model as one
    currentPosition = emitScanlines(baseContours, baseBounds, scanIndex, allMoves, allStepLevels, currentPosition)
  } else {
    // Region-first ordering: finish all scanlines for one region, then move to next.
    for (let ri = 0; ri < regionFeatures.length; ri++) {
      const region = regionFeatures[ri]
      const regionPaths = buildRegionUnionPaths(region)
      const clippedContours = clipToRegionPaths(baseContours, regionPaths)

      const clippedBounds = computeContourBounds([clippedContours])
      if (clippedBounds) {
        currentPosition = emitScanlines(clippedContours, clippedBounds, scanIndex, allMoves, allStepLevels, currentPosition)
      } else if (operation.debugToolpath) {
        warnings.push(`Debug: region ${region.name} does not intersect the model silhouette`)
      }

      // Retract to safeZ between regions (but not after the last)
      if (ri < regionFeatures.length - 1) {
        currentPosition = retractToSafe(allMoves, currentPosition, safeZ)
      }
    }
  }

  return { moves: allMoves, stepLevels: allStepLevels }
}

// ── Main entry point ────────────────────────────────────────────────────

export function generateFinishSurfaceToolpath(
  project: Project,
  operation: Operation,
): PocketToolpathResult {
  const target = operation.target
  if (target.source !== 'features' || target.featureIds.length === 0) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['Finish surface requires a model feature and optionally one or more region features'],
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
  const regionFeatures = targetFeatures.filter((f) => f.operation === 'region' && f.sketch.profile.closed)

  if (!modelFeature) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['Finish surface requires a model feature (imported STL)'],
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

  const warnings: string[] = []

  // ── Generate parallel finish toolpath ─────────────────────────────────

  const parallelResult = generateFinishSurfaceParallel(
    project,
    operation,
    modelFeature,
    regionFeatures,
    tool,
    stepLevels,
    transformedPos,
    index,
    stlData as HeightMapCacheHost,
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
