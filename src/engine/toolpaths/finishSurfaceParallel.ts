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

import { getProfileBounds, type Operation, type Point, type Project, type SketchFeature } from '../../types/project'
import type { ClipperPath, NormalizedTool, ToolpathMove, ToolpathPoint } from './types'
import { DEFAULT_CLIPPER_SCALE, flattenProfile, normalizeWinding, toClipperPath } from './geometry'
import { retractToSafe, transitionToCutEntry } from './pocket'
import { buildRegionMask, clipTupleContoursToRegionMask } from './regions'
import { significantSilhouettePaths } from './silhouette'
import { buildProtectedFootprintPaths, clipperPathsToTupleContours, differenceClipperPaths, unionClipperPaths } from './modelProtection'

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

function pointEpsilonEqual(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9
}

function rotatePoint(point: Point, cosTheta: number, sinTheta: number): Point {
  return {
    x: point.x * cosTheta - point.y * sinTheta,
    y: point.x * sinTheta + point.y * cosTheta,
  }
}

function scanlineIntervalsForContours(contours: Point[][], y: number): Array<[number, number]> {
  const intersections: number[] = []
  for (const contour of contours) {
    const closed = contour.length > 0 && pointEpsilonEqual(contour[0], contour[contour.length - 1])
      ? contour
      : [...contour, contour[0]]

    for (let index = 0; index < closed.length - 1; index += 1) {
      const a = closed[index]
      const b = closed[index + 1]

      if (Math.abs(a.y - b.y) <= 1e-9) continue

      const intersects = (a.y <= y && b.y > y) || (b.y <= y && a.y > y)
      if (!intersects) continue

      const t = (y - a.y) / (b.y - a.y)
      intersections.push(a.x + (b.x - a.x) * t)
    }
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

function clampSurfaceSegmentToMinZ(
  segment: Array<{ x: number; y: number; z: number; rotX: number }>,
  minZAtPoint: (point: Point) => number,
): Array<{ x: number; y: number; z: number; rotX: number }> {
  return segment.map((point) => ({
    ...point,
    z: Math.max(point.z, minZAtPoint(point)),
  }))
}

function splitAndClampSurfaceSegmentToMinZ(
  segment: Array<{ x: number; y: number; z: number; rotX: number }>,
  minZAtPoint: (point: Point) => number,
): Array<Array<{ x: number; y: number; z: number; rotX: number }>> {
  const chunks: Array<Array<{ x: number; y: number; z: number; rotX: number }>> = []
  let current: Array<{ x: number; y: number; z: number; rotX: number }> = []
  let currentFloor: number | null = null

  for (const point of segment) {
    const floorZ = minZAtPoint(point)
    const clampedPoint = {
      ...point,
      z: Math.max(point.z, floorZ),
    }

    if (currentFloor !== null && Math.abs(floorZ - currentFloor) > 1e-9) {
      if (current.length >= 2) {
        chunks.push(current)
      }
      current = []
    }

    current.push(clampedPoint)
    currentFloor = floorZ
  }

  if (current.length >= 2) {
    chunks.push(current)
  }

  return chunks
}

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
export type FinishSurfaceParallelCacheHost = { finishHeightMapCache?: Map<string, HeightMap> }

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

    const tMinX = Math.min(v0x, v1x, v2x)
    const tMaxX = Math.max(v0x, v1x, v2x)
    const tMinY = Math.min(v0y, v1y, v2y)
    const tMaxY = Math.max(v0y, v1y, v2y)

    const colStart = Math.max(0, Math.floor((tMinX - bbox.minX) / cellSize))
    const colEnd   = Math.min(width - 1, Math.floor((tMaxX - bbox.minX) / cellSize))
    const rowStart = Math.max(0, Math.floor((tMinY - bbox.minY) / cellSize))
    const rowEnd   = Math.min(height - 1, Math.floor((tMaxY - bbox.minY) / cellSize))

    const e0x = v1x - v0x, e0y = v1y - v0y
    const e1x = v2x - v0x, e1y = v2y - v0y
    const denom = e0x * e1y - e0y * e1x
    if (Math.abs(denom) < 1e-15) continue

    for (let row = rowStart; row <= rowEnd; row++) {
      for (let col = colStart; col <= colEnd; col++) {
        const cx = bbox.minX + (col + 0.5) * cellSize
        const cy = bbox.minY + (row + 0.5) * cellSize

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
  host: FinishSurfaceParallelCacheHost,
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
 * Minimum tool-tip Z at (x, y) given the height map and tool kinematics.
 * Same logic as `applyGougeProtection` but for a single XY query. Returns
 * `-Infinity` if no model cells fall under the tool footprint (free travel).
 */
function safeToolTipZAt(
  x: number,
  y: number,
  heightMap: HeightMap,
  tool: NormalizedTool,
): number {
  const toolRadius = tool.radius
  const neighborCells = Math.ceil(toolRadius / heightMap.cellSize)
  const radiusSq = toolRadius * toolRadius
  const isBall = tool.type === 'ball_endmill'
  const vBitHalfAngleDeg = tool.type === 'v_bit' && tool.vBitAngle && tool.vBitAngle > 0
    ? tool.vBitAngle / 2
    : 0
  const cotHalfAngle = vBitHalfAngleDeg > 0
    ? 1 / Math.tan((vBitHalfAngleDeg * Math.PI) / 180)
    : 0

  const col = Math.floor((x - heightMap.originX) / heightMap.cellSize)
  const row = Math.floor((y - heightMap.originY) / heightMap.cellSize)

  let safeZ = Number.NEGATIVE_INFINITY
  const minC = Math.max(0, col - neighborCells)
  const maxC = Math.min(heightMap.width - 1, col + neighborCells)
  const minR = Math.max(0, row - neighborCells)
  const maxR = Math.min(heightMap.height - 1, row + neighborCells)

  for (let nr = minR; nr <= maxR; nr += 1) {
    for (let nc = minC; nc <= maxC; nc += 1) {
      const cellZ = heightMap.data[nr * heightMap.width + nc]
      if (!isFinite(cellZ)) continue
      const cx = heightMap.originX + (nc + 0.5) * heightMap.cellSize
      const cy = heightMap.originY + (nr + 0.5) * heightMap.cellSize
      const dx = cx - x
      const dy = cy - y
      const dSq = dx * dx + dy * dy
      if (dSq > radiusSq) continue
      let constrained: number
      if (isBall) {
        constrained = cellZ - toolRadius + Math.sqrt(radiusSq - dSq)
      } else if (cotHalfAngle > 0) {
        constrained = cellZ - Math.sqrt(dSq) * cotHalfAngle
      } else {
        constrained = cellZ
      }
      if (constrained > safeZ) safeZ = constrained
    }
  }

  return safeZ
}

function applyGougeProtection(
  scanPoints: Array<{ x: number; y: number; z: number; rotX: number }>,
  heightMap: HeightMap,
  tool: NormalizedTool,
): void {
  const toolRadius = tool.radius
  const neighborCells = Math.ceil(toolRadius / heightMap.cellSize)
  const radiusSq = toolRadius * toolRadius
  // Kinematic constraint depends on tool geometry. For a model cell at lateral
  // distance d (d <= R) and height cellZ, the constraint on the tool-tip Z is:
  //   - Ball endmill:  sp.z >= cellZ - R + sqrt(R² - d²)   (sphere clearance)
  //   - Flat endmill:  sp.z >= cellZ                       (cylinder clearance)
  //   - V-bit (cone θ): sp.z >= cellZ - d / tan(θ/2)
  //   - Other:         fall back to flat (conservative — never gouges)
  const isBall = tool.type === 'ball_endmill'
  const vBitHalfAngleDeg = tool.type === 'v_bit' && tool.vBitAngle && tool.vBitAngle > 0
    ? tool.vBitAngle / 2
    : 0
  const cotHalfAngle = vBitHalfAngleDeg > 0
    ? 1 / Math.tan((vBitHalfAngleDeg * Math.PI) / 180)
    : 0

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

        const cx = heightMap.originX + (nc + 0.5) * heightMap.cellSize
        const cy = heightMap.originY + (nr + 0.5) * heightMap.cellSize

        const dx = cx - sp.x
        const dy = cy - sp.y
        const dSq = dx * dx + dy * dy
        if (dSq > radiusSq) continue

        let constrained: number
        if (isBall) {
          constrained = cellZ - toolRadius + Math.sqrt(radiusSq - dSq)
        } else if (cotHalfAngle > 0) {
          constrained = cellZ - Math.sqrt(dSq) * cotHalfAngle
        } else {
          // Flat endmill (and conservative fallback): any model material at
          // lateral distance <= R must be at or below the tool tip.
          constrained = cellZ
        }
        if (constrained > safeZ) safeZ = constrained
      }
    }

    sp.z = safeZ
  }
}

function queryHeightMapTopZ(heightMap: HeightMap, x: number, y: number): number | null {
  const gridX = (x - heightMap.originX) / heightMap.cellSize - 0.5
  const gridY = (y - heightMap.originY) / heightMap.cellSize - 0.5

  const col0 = Math.floor(gridX)
  const row0 = Math.floor(gridY)
  const col1 = col0 + 1
  const row1 = row0 + 1
  const tx = gridX - col0
  const ty = gridY - row0

  const samples: Array<{ z: number; weight: number }> = []
  const pushSample = (col: number, row: number, weight: number): void => {
    if (weight <= 1e-12) return
    if (col < 0 || col >= heightMap.width || row < 0 || row >= heightMap.height) return
    const z = heightMap.data[row * heightMap.width + col]
    if (!isFinite(z)) return
    samples.push({ z, weight })
  }

  pushSample(col0, row0, (1 - tx) * (1 - ty))
  pushSample(col1, row0, tx * (1 - ty))
  pushSample(col0, row1, (1 - tx) * ty)
  pushSample(col1, row1, tx * ty)

  if (samples.length === 0) {
    const centerCol = Math.floor((x - heightMap.originX) / heightMap.cellSize)
    const centerRow = Math.floor((y - heightMap.originY) / heightMap.cellSize)
    let nearestZ: number | null = null
    let nearestDistSq = Infinity

    for (let r = Math.max(0, centerRow - 2); r <= Math.min(heightMap.height - 1, centerRow + 2); r += 1) {
      for (let c = Math.max(0, centerCol - 2); c <= Math.min(heightMap.width - 1, centerCol + 2); c += 1) {
        const z = heightMap.data[r * heightMap.width + c]
        if (!isFinite(z)) continue
        const cx = heightMap.originX + (c + 0.5) * heightMap.cellSize
        const cy = heightMap.originY + (r + 0.5) * heightMap.cellSize
        const dx = cx - x
        const dy = cy - y
        const distSq = dx * dx + dy * dy
        if (distSq < nearestDistSq) {
          nearestDistSq = distSq
          nearestZ = z
        }
      }
    }

    return nearestZ
  }

  let weightedZ = 0
  let totalWeight = 0
  for (const sample of samples) {
    weightedZ += sample.z * sample.weight
    totalWeight += sample.weight
  }
  return totalWeight > 1e-12 ? weightedZ / totalWeight : null
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

function coverageContoursToClipperPaths(contours: CoverageContours): ClipperPath[] {
  return contours
    .filter((contour) => contour.length >= 3)
    .map((contour) => toClipperPath(
      normalizeWinding(contour.map(([x, y]) => ({ x, y })), false),
      DEFAULT_CLIPPER_SCALE,
    ))
}

export function modelSilhouettePathsForFinishSurface(modelFeature: SketchFeature): ClipperPath[] {
  return unionClipperPaths(coverageContoursToClipperPaths(modelSilhouetteContours(modelFeature)))
}

function subtractProtectedContours(contours: CoverageContours, protectedPaths: ClipperPath[]): CoverageContours {
  if (contours.length === 0 || protectedPaths.length === 0) return contours
  const clipped = differenceClipperPaths(
    unionClipperPaths(coverageContoursToClipperPaths(contours)),
    protectedPaths,
  )
  return clipperPathsToTupleContours(clipped)
}

export function generateFinishSurfaceParallel(
  project: Project,
  operation: Operation,
  modelFeature: SketchFeature,
  regionFeatures: SketchFeature[],
  tool: NormalizedTool,
  transformedPos: Float32Array,
  index: Uint32Array,
  sliceIndexHost: FinishSurfaceParallelCacheHost,
  safeZ: number,
  minCutZAtPoint: (point: Point) => number,
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

  const modelBbox = computeXYBounds(transformedPos)
  const regionBounds = computeRegionFeatureBounds(regionFeatures)
  const heightMapBbox = regionBounds
    ? clampExpandedBoundsToModel(regionBounds, modelBbox, tool.radius)
    : modelBbox
  const requestedWaterlineCellSize = Math.min(tool.radius / 3, stepoverDistance * 0.5)
  const heightMapCellSize = chooseHeightMapCellSize(heightMapBbox, requestedWaterlineCellSize, warnings)
  const heightMap = getCachedHeightMap(sliceIndexHost, transformedPos, index, heightMapBbox, heightMapCellSize)
  const topSurfaceSampleDistance = Math.max(heightMapCellSize, Math.min(stepoverDistance, tool.radius * 0.5))

  // Safe link check for scanline → scanline transitions. The straight 3D
  // segment from one scanline's end to the next scanline's start (already
  // gouge-protected at the endpoints) is allowed when the linearly
  // interpolated link Z stays above the kinematic safe Z along the way. The
  // common flat-pocket-floor case: surface Z = link Z everywhere, link is
  // accepted, and the tool moves straight across at constant Z instead of
  // retracting and re-plunging on every scanline.
  const linkSampleSpacing = Math.max(heightMapCellSize, tool.radius * 0.5)
  const linkCushion = Math.max(heightMapCellSize * 0.5, 1e-3)
  const safeLinkCheck = (from: ToolpathPoint, to: ToolpathPoint): boolean => {
    const dx = to.x - from.x
    const dy = to.y - from.y
    const dz = to.z - from.z
    const length = Math.hypot(dx, dy)
    if (length === 0) return true
    const steps = Math.max(1, Math.ceil(length / linkSampleSpacing))
    for (let i = 1; i < steps; i += 1) {
      const t = i / steps
      const sx = from.x + dx * t
      const sy = from.y + dy * t
      const sz = from.z + dz * t
      const required = safeToolTipZAt(sx, sy, heightMap, tool)
      if (sz + linkCushion < required) return false
    }
    return true
  }
  // Allow the link to extend up to a couple of stepovers — slightly more than
  // the natural Y jump between adjacent scanlines so segments with small X
  // misalignment still link. The kinematic check above is the real guard.
  const linkMaxDistance = stepoverDistance * 2

  const angleRad = (angleDeg * Math.PI) / 180
  const cosNeg = Math.cos(-angleRad)
  const sinNeg = Math.sin(-angleRad)
  const cosPos = Math.cos(angleRad)
  const sinPos = Math.sin(angleRad)

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
    let pos = position
    // startScanIndex is preserved on the signature for API stability but no
    // longer drives an even/odd zigzag flip — phase 5 of the link-optimization
    // plan replaces that with closer-endpoint pickup per segment.
    void startScanIndex

    for (
      let rotY = rotMinY + stepoverDistance / 2;
      rotY < rotMaxY;
      rotY += stepoverDistance
    ) {
      const scanSegments: Array<Array<{ x: number; y: number; z: number; rotX: number }>> = []

      const intervals = scanlineIntervalsForContours(rotatedContours, rotY)
      for (const [x1, x2] of intervals) {
        const segment = buildTopSurfaceSegment(x1, x2, rotY, cosPos, sinPos, heightMap, topSurfaceSampleDistance)
        if (segment.length >= 2) {
          scanSegments.push(...splitAndClampSurfaceSegmentToMinZ(segment, minCutZAtPoint))
        }
      }

      if (scanSegments.length === 0) continue

      scanSegments.sort((a, b) => a[0].rotX - b[0].rotX)

      // Closer-endpoint pickup. Instead of always cutting segments in their
      // sorted-rotX order with a blanket reverse on odd scanlines, pick the
      // next segment whose nearest endpoint is closest to the current tool
      // position and reverse the segment only if its end is nearer than its
      // start. This preserves the zigzag macro-pattern (the geometric reason
      // we still chose to keep zigzag) while shortening cross-table travel
      // between segments, especially on scanlines split by protected regions.
      const remainingSegments = [...scanSegments]
      while (remainingSegments.length > 0) {
        let bestIdx = 0
        let bestReverse = false
        let bestDist = Number.POSITIVE_INFINITY
        for (let i = 0; i < remainingSegments.length; i += 1) {
          const seg = remainingSegments[i]
          const startP = seg[0]
          const endP = seg[seg.length - 1]
          const dStart = pos ? (startP.x - pos.x) ** 2 + (startP.y - pos.y) ** 2 : 0
          const dEnd = pos ? (endP.x - pos.x) ** 2 + (endP.y - pos.y) ** 2 : 0
          const local = Math.min(dStart, dEnd)
          if (local < bestDist) {
            bestDist = local
            bestIdx = i
            bestReverse = dEnd < dStart
          }
        }
        const segment = remainingSegments.splice(bestIdx, 1)[0]
        if (bestReverse) segment.reverse()

        applyGougeProtection(segment, heightMap, tool)
        const clampedSegment = clampSurfaceSegmentToMinZ(segment, minCutZAtPoint)

        for (const sp of clampedSegment) {
          outStepLevels.add(sp.z)
        }

        const cutPoints3D: ToolpathPoint[] = clampedSegment.map((sp) => ({
          x: sp.x,
          y: sp.y,
          z: sp.z,
        }))
        const entryPoint = cutPoints3D[0]

        pos = transitionToCutEntry(moves, pos, entryPoint, safeZ, linkMaxDistance, safeLinkCheck)
        moves.push(...toOpenCutMoves3D(cutPoints3D))
        pos = cutPoints3D[cutPoints3D.length - 1]
      }
    }

    return pos
  }

  const allMoves: ToolpathMove[] = []
  const allStepLevels = new Set<number>()
  let currentPosition: ToolpathPoint | null = null
  const scanIndex = 0
  const baseContours = modelSilhouetteContours(modelFeature)
  const baseCoveragePaths = unionClipperPaths(coverageContoursToClipperPaths(baseContours))
  // Tabs are NOT 2D-subtracted from coverage here — they were being subtracted
  // unconditionally, which carved a hole above every tab regardless of how far
  // below the cut surface the tab actually sat. Tab preservation is instead
  // handled per-point via minCutZAtPoint, which clamps cut Z up to tab.z_top
  // only where the surface would otherwise dip into a tab.
  const protectedPaths = buildProtectedFootprintPaths(project, {
    targetFeatureIds: new Set(operation.target.source === 'features' ? operation.target.featureIds : []),
    featureExpansion: tool.radius + Math.max(0, operation.stockToLeaveRadial),
    clampExpansion: tool.radius,
    includeTabs: false,
    machiningEnvelopePaths: baseCoveragePaths,
  })
  const baseBounds = computeContourBounds([baseContours])
  if (!baseBounds) {
    warnings.push('Model silhouette is degenerate — no finish surface coverage generated')
    return { moves: allMoves, stepLevels: allStepLevels }
  }

  if (regionFeatures.length === 0) {
    const clippedContours = subtractProtectedContours(baseContours, protectedPaths)
    const clippedBounds = computeContourBounds([clippedContours])
    if (clippedBounds) {
      currentPosition = emitScanlines(clippedContours, clippedBounds, scanIndex, allMoves, allStepLevels, currentPosition)
    } else if (operation.debugToolpath) {
      warnings.push('Debug: protected footprints remove all finish surface coverage')
    }
  } else {
    for (let ri = 0; ri < regionFeatures.length; ri++) {
      const region = regionFeatures[ri]
      const regionContours = clipTupleContoursToRegionMask(baseContours, buildRegionMask([region]))
      const clippedContours = subtractProtectedContours(regionContours, protectedPaths)

      const clippedBounds = computeContourBounds([clippedContours])
      if (clippedBounds) {
        currentPosition = emitScanlines(clippedContours, clippedBounds, scanIndex, allMoves, allStepLevels, currentPosition)
      } else if (operation.debugToolpath) {
        warnings.push(`Debug: region ${region.name} does not intersect the model silhouette`)
      }

      if (ri < regionFeatures.length - 1) {
        currentPosition = retractToSafe(allMoves, currentPosition, safeZ)
      }
    }
  }

  return { moves: allMoves, stepLevels: allStepLevels }
}
