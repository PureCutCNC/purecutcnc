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

import ClipperLib from 'clipper-lib'
import type { Operation, Point, Project } from '../../types/project'
import { convertLength } from '../../utils/units'
import type { ResolvedPocketRegion, ToolpathBounds, ToolpathMove, ToolpathResult } from './types'
import { DEFAULT_CLIPPER_SCALE, checkMaxCutDepthWarning, getOperationSafeZ, normalizeToolForProject, toClipperPath } from './geometry'
import { pushRapidAndPlunge, retractToSafe, updateBounds } from './pocket'
import { resolvePocketRegions } from './resolver'
import type { ResolvedPocketResult } from './types'

const DEFAULT_BOUNDARY_RESOLUTION_MM = 0.05
const DEFAULT_GRID_RESOLUTION_MM = 0.1
const MIN_PATH_POINTS = 3
const MAX_REGION_PATHS = 64
const MAX_ESTIMATED_SCAN_STEPS = 250000
const MAX_ESTIMATED_BOUNDARY_POINTS = 12000
const BINARY_SEARCH_ITERATIONS = 10
const BINARY_SEARCH_NEIGHBOR_COUNT = 12
const CORNER_RAY_MIN_TURN_ANGLE = Math.PI / 6
const clipperPointInPolygon = (ClipperLib.Clipper as typeof ClipperLib.Clipper & {
  PointInPolygon: (point: { X: number; Y: number }, path: MatClipperPath) => number
}).PointInPolygon

export interface MatBoundaryPoint extends Point {
  contourType: 'outer' | 'island'
  contourIndex: number
  sampleIndex: number
}

export interface MatSpinePoint extends Point {
  z: number
  radius: number
  bandIndex: number
  regionIndex: number
}

interface MatBoundaryContour {
  contourType: MatBoundaryPoint['contourType']
  contourIndex: number
  points: MatBoundaryPoint[]
}

interface MatBoundaryIndex {
  cellSize: number
  minX: number
  minY: number
  maxCellX: number
  maxCellY: number
  gridWidth: number
  cells: Map<number, number[]>
}

type MatClipperPath = ReturnType<typeof toClipperPath>

interface MatRegionMaterial {
  outerPath: MatClipperPath
  islandPaths: MatClipperPath[]
}

interface MatDetectionStats {
  scannedRayCount: number
  medialHitCount: number
}

export interface MatRegionAnalysis {
  regionIndex: number
  boundaryPoints: MatBoundaryPoint[]
  scanStep: number
  lowBracketPoints: MatSpinePoint[]
  highBracketPoints: MatSpinePoint[]
  probePoints: MatSpinePoint[]
  rawSpinePoints: MatSpinePoint[]
  rawSpinePaths: MatSpinePoint[][]
  spinePoints: MatSpinePoint[]
  spinePaths: MatSpinePoint[][]
  detection: MatDetectionStats
}

export interface MatAnalysisResult {
  operationId: string
  regions: MatRegionAnalysis[]
  warnings: string[]
}

interface MatComplexityEstimate {
  scanSteps: number
  boundaryPoints: number
}

interface MatSamplingProfile {
  boundaryResolution: number
  scanStep: number
}

interface MatRaySource {
  contourType: MatBoundaryPoint['contourType']
  contourIndex: number
  contourLength: number
  sampleIndices: number[]
  segments: Array<{ start: Point; end: Point }>
}

type RayPointClassification =
  | { kind: 'candidate'; sameWallDistance: number; otherWallDistance: number }
  | { kind: 'source-dominated'; sameWallDistance: number; otherWallDistance: number }
  | { kind: 'other-dominated'; sameWallDistance: number; otherWallDistance: number }
  | { kind: 'invalid' }

function computeBounds(moves: ToolpathMove[]): ToolpathBounds | null {
  let bounds: ToolpathBounds | null = null
  for (const move of moves) {
    bounds = updateBounds(bounds, move.from)
    bounds = updateBounds(bounds, move.to)
  }
  return bounds
}

function estimateRegionScanSteps(region: ResolvedPocketRegion, boundaryPointCount: number, stepSize: number): number {
  const bounds = regionBounds(region)
  if (!bounds || !(stepSize > 1e-9)) {
    return 0
  }

  const width = Math.max(0, bounds.maxX - bounds.minX)
  const height = Math.max(0, bounds.maxY - bounds.minY)
  const diagonal = Math.hypot(width, height)
  return boundaryPointCount * Math.ceil(diagonal / stepSize)
}

function estimateMatComplexity(
  resolved: ResolvedPocketResult,
  boundaryResolution: number,
  scanStep: number,
): MatComplexityEstimate {
  let boundaryPoints = 0
  let scanSteps = 0

  for (const band of resolved.bands) {
    for (const region of band.regions) {
      const contourPointCount = [region.outer, ...region.islands].reduce((sum, contour) => {
        if (contour.length < 2) {
          return sum
        }

        let contourSamples = 0
        for (let index = 0; index < contour.length; index++) {
          const start = contour[index]
          const end = contour[(index + 1) % contour.length]
          contourSamples += Math.max(1, Math.ceil(Math.hypot(end.x - start.x, end.y - start.y) / Math.max(boundaryResolution, 1e-9)))
        }
        return sum + contourSamples
      }, 0)

      boundaryPoints += contourPointCount
      scanSteps += estimateRegionScanSteps(region, contourPointCount, scanStep)
    }
  }

  return { scanSteps, boundaryPoints }
}

function boundaryResolutionForProject(project: Project): number {
  return convertLength(DEFAULT_BOUNDARY_RESOLUTION_MM, 'mm', project.meta.units)
}

function scanStepForProject(project: Project): number {
  return convertLength(DEFAULT_GRID_RESOLUTION_MM, 'mm', project.meta.units)
}

function samplingProfileForOperation(project: Project, operation: Operation): MatSamplingProfile {
  const operationStep = operation.stepover > 1e-9 ? operation.stepover : 0
  if (operation.debugToolpath && operationStep > 0) {
    return {
      boundaryResolution: operationStep,
      scanStep: operationStep,
    }
  }

  return {
    boundaryResolution: boundaryResolutionForProject(project),
    scanStep: scanStepForProject(project),
  }
}

function closeContour(points: Point[]): Point[] {
  if (points.length === 0) {
    return []
  }
  const first = points[0]
  const last = points[points.length - 1]
  if (first.x === last.x && first.y === last.y) {
    return points
  }
  return [...points, first]
}

function subdivideClosedContour(
  contour: Point[],
  resolution: number,
  contourType: MatBoundaryPoint['contourType'],
  contourIndex: number,
): MatBoundaryPoint[] {
  const closed = closeContour(contour)
  if (closed.length < 2) {
    return []
  }

  const samples: MatBoundaryPoint[] = []
  let sampleIndex = 0

  for (let i = 0; i < closed.length - 1; i++) {
    const start = closed[i]
    const end = closed[i + 1]
    const dx = end.x - start.x
    const dy = end.y - start.y
    const length = Math.hypot(dx, dy)
    const steps = Math.max(1, Math.ceil(length / Math.max(resolution, 1e-9)))

    for (let step = 0; step < steps; step++) {
      const t = step / steps
      samples.push({
        x: start.x + dx * t,
        y: start.y + dy * t,
        contourType,
        contourIndex,
        sampleIndex,
      })
      sampleIndex += 1
    }
  }

  return samples
}

function buildBoundaryContours(region: ResolvedPocketRegion, resolution: number): MatBoundaryContour[] {
  const contours: MatBoundaryContour[] = []
  const outer = subdivideClosedContour(region.outer, resolution, 'outer', 0)
  if (outer.length > 0) {
    contours.push({
      contourType: 'outer',
      contourIndex: 0,
      points: outer,
    })
  }

  region.islands.forEach((island, index) => {
    const points = subdivideClosedContour(island, resolution, 'island', index)
    if (points.length > 0) {
      contours.push({
        contourType: 'island',
        contourIndex: index,
        points,
      })
    }
  })

  return contours
}

function buildBoundaryIndex(boundaryPoints: MatBoundaryPoint[], cellSize: number): MatBoundaryIndex {
  const cells = new Map<number, number[]>()
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  for (const point of boundaryPoints) {
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return {
      cellSize,
      minX: 0,
      minY: 0,
      maxCellX: -1,
      maxCellY: -1,
      gridWidth: 0,
      cells,
    }
  }

  const maxCellX = Math.floor((maxX - minX) / cellSize)
  const maxCellY = Math.floor((maxY - minY) / cellSize)
  const gridWidth = maxCellX + 1

  const cellKey = (cellX: number, cellY: number) => cellY * gridWidth + cellX

  boundaryPoints.forEach((point, index) => {
    const cellX = Math.floor((point.x - minX) / cellSize)
    const cellY = Math.floor((point.y - minY) / cellSize)
    const key = cellKey(cellX, cellY)
    const bucket = cells.get(key)
    if (bucket) {
      bucket.push(index)
    } else {
      cells.set(key, [index])
    }
  })

  return {
    cellSize,
    minX,
    minY,
    maxCellX,
    maxCellY,
    gridWidth,
    cells,
  }
}

function buildRegionMaterial(region: ResolvedPocketRegion): MatRegionMaterial {
  return {
    outerPath: toClipperPath(region.outer),
    islandPaths: region.islands.map((island) => toClipperPath(island)),
  }
}

function pointInRegionMaterial(point: Point, material: MatRegionMaterial): boolean {
  const clipperPoint = { X: Math.round(point.x * DEFAULT_CLIPPER_SCALE), Y: Math.round(point.y * DEFAULT_CLIPPER_SCALE) }
  const insideOuter = clipperPointInPolygon(clipperPoint, material.outerPath) !== 0
  if (!insideOuter) {
    return false
  }

  for (const islandPath of material.islandPaths) {
    if (clipperPointInPolygon(clipperPoint, islandPath) !== 0) {
      return false
    }
  }

  return true
}

function regionBounds(region: ResolvedPocketRegion): ToolpathBounds | null {
  const allPoints = [region.outer, ...region.islands].flat()
  if (allPoints.length === 0) {
    return null
  }

  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const point of allPoints) {
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }

  return {
    minX,
    minY,
    minZ: 0,
    maxX,
    maxY,
    maxZ: 0,
  }
}

function nearestBoundaryPoint(
  point: Point,
  boundaryPoints: MatBoundaryPoint[],
  boundaryIndex: MatBoundaryIndex,
): { point: MatBoundaryPoint; distance: number } | null {
  if (boundaryPoints.length === 0 || boundaryIndex.maxCellX < 0 || boundaryIndex.maxCellY < 0) {
    return null
  }

  const queryCellX = Math.max(0, Math.min(boundaryIndex.maxCellX, Math.floor((point.x - boundaryIndex.minX) / boundaryIndex.cellSize)))
  const queryCellY = Math.max(0, Math.min(boundaryIndex.maxCellY, Math.floor((point.y - boundaryIndex.minY) / boundaryIndex.cellSize)))
  const visited = new Set<number>()
  const maxRing = Math.max(boundaryIndex.maxCellX, boundaryIndex.maxCellY) + 1
  let bestPoint: MatBoundaryPoint | null = null
  let bestDistanceSquared = Number.POSITIVE_INFINITY
  const cellKey = (cellX: number, cellY: number) => cellY * boundaryIndex.gridWidth + cellX

  for (let ring = 0; ring <= maxRing; ring++) {
    const minCellX = Math.max(0, queryCellX - ring)
    const maxCellX = Math.min(boundaryIndex.maxCellX, queryCellX + ring)
    const minCellY = Math.max(0, queryCellY - ring)
    const maxCellY = Math.min(boundaryIndex.maxCellY, queryCellY + ring)

    for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
      for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
        if (
          ring > 0
          && cellX > minCellX
          && cellX < maxCellX
          && cellY > minCellY
          && cellY < maxCellY
        ) {
          continue
        }

        const bucket = boundaryIndex.cells.get(cellKey(cellX, cellY))
        if (!bucket) {
          continue
        }

        for (const index of bucket) {
          if (visited.has(index)) {
            continue
          }
          visited.add(index)

          const boundaryPoint = boundaryPoints[index]
          const dx = boundaryPoint.x - point.x
          const dy = boundaryPoint.y - point.y
          const distanceSquared = dx * dx + dy * dy
          if (distanceSquared < bestDistanceSquared) {
            bestDistanceSquared = distanceSquared
            bestPoint = boundaryPoint
          }
        }
      }
    }

    if (!bestPoint) {
      continue
    }

    const searchMinX = boundaryIndex.minX + minCellX * boundaryIndex.cellSize
    const searchMinY = boundaryIndex.minY + minCellY * boundaryIndex.cellSize
    const searchMaxX = boundaryIndex.minX + (maxCellX + 1) * boundaryIndex.cellSize
    const searchMaxY = boundaryIndex.minY + (maxCellY + 1) * boundaryIndex.cellSize
    const nearestOutsideDistance = Math.min(
      point.x - searchMinX,
      searchMaxX - point.x,
      point.y - searchMinY,
      searchMaxY - point.y,
    )

    const nearestOutsideDistanceSquared = nearestOutsideDistance * nearestOutsideDistance
    if (bestDistanceSquared <= nearestOutsideDistanceSquared + 1e-9 || ring === maxRing) {
      return {
        point: bestPoint,
        distance: Math.sqrt(bestDistanceSquared),
      }
    }
  }

  let fallbackPoint: MatBoundaryPoint | null = null
  let fallbackDistanceSquared = Number.POSITIVE_INFINITY
  for (const boundaryPoint of boundaryPoints) {
    const dx = boundaryPoint.x - point.x
    const dy = boundaryPoint.y - point.y
    const distanceSquared = dx * dx + dy * dy
    if (distanceSquared < fallbackDistanceSquared) {
      fallbackDistanceSquared = distanceSquared
      fallbackPoint = boundaryPoint
    }
  }
  return fallbackPoint
    ? { point: fallbackPoint, distance: Math.sqrt(fallbackDistanceSquared) }
    : null
}

function nearestBoundaryPoints(
  point: Point,
  boundaryPoints: MatBoundaryPoint[],
  boundaryIndex: MatBoundaryIndex,
  count: number,
): Array<{ point: MatBoundaryPoint; distance: number }> {
  if (boundaryPoints.length === 0 || boundaryIndex.maxCellX < 0 || boundaryIndex.maxCellY < 0) {
    return []
  }
  if (count <= 0) {
    return []
  }

  const queryCellX = Math.max(0, Math.min(boundaryIndex.maxCellX, Math.floor((point.x - boundaryIndex.minX) / boundaryIndex.cellSize)))
  const queryCellY = Math.max(0, Math.min(boundaryIndex.maxCellY, Math.floor((point.y - boundaryIndex.minY) / boundaryIndex.cellSize)))
  const visited = new Set<number>()
  const maxRing = Math.max(boundaryIndex.maxCellX, boundaryIndex.maxCellY) + 1
  const candidates: Array<{ point: MatBoundaryPoint; distanceSquared: number }> = []
  const cellKey = (cellX: number, cellY: number) => cellY * boundaryIndex.gridWidth + cellX
  const insertCandidate = (candidate: { point: MatBoundaryPoint; distanceSquared: number }) => {
    if (candidates.length === count && candidate.distanceSquared >= (candidates[candidates.length - 1]?.distanceSquared ?? Number.POSITIVE_INFINITY)) {
      return
    }

    let insertIndex = candidates.length
    while (insertIndex > 0 && candidates[insertIndex - 1]!.distanceSquared > candidate.distanceSquared) {
      insertIndex -= 1
    }
    candidates.splice(insertIndex, 0, candidate)
    if (candidates.length > count) {
      candidates.pop()
    }
  }

  for (let ring = 0; ring <= maxRing; ring++) {
    const minCellX = Math.max(0, queryCellX - ring)
    const maxCellX = Math.min(boundaryIndex.maxCellX, queryCellX + ring)
    const minCellY = Math.max(0, queryCellY - ring)
    const maxCellY = Math.min(boundaryIndex.maxCellY, queryCellY + ring)

    for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
      for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
        if (
          ring > 0
          && cellX > minCellX
          && cellX < maxCellX
          && cellY > minCellY
          && cellY < maxCellY
        ) {
          continue
        }

        const bucket = boundaryIndex.cells.get(cellKey(cellX, cellY))
        if (!bucket) {
          continue
        }

        for (const index of bucket) {
          if (visited.has(index)) {
            continue
          }
          visited.add(index)
          const boundaryPoint = boundaryPoints[index]
          const dx = boundaryPoint.x - point.x
          const dy = boundaryPoint.y - point.y
          insertCandidate({
            point: boundaryPoint,
            distanceSquared: dx * dx + dy * dy,
          })
        }
      }
    }

    if (candidates.length < count) {
      continue
    }

    const kthDistanceSquared = candidates[count - 1]?.distanceSquared ?? Number.POSITIVE_INFINITY
    const searchMinX = boundaryIndex.minX + minCellX * boundaryIndex.cellSize
    const searchMinY = boundaryIndex.minY + minCellY * boundaryIndex.cellSize
    const searchMaxX = boundaryIndex.minX + (maxCellX + 1) * boundaryIndex.cellSize
    const searchMaxY = boundaryIndex.minY + (maxCellY + 1) * boundaryIndex.cellSize
    const nearestOutsideDistance = Math.min(
      point.x - searchMinX,
      searchMaxX - point.x,
      point.y - searchMinY,
      searchMaxY - point.y,
    )

    const nearestOutsideDistanceSquared = nearestOutsideDistance * nearestOutsideDistance
    if (kthDistanceSquared <= nearestOutsideDistanceSquared + 1e-9 || ring === maxRing) {
      return candidates.slice(0, count).map((candidate) => ({
        point: candidate.point,
        distance: Math.sqrt(candidate.distanceSquared),
      }))
    }
  }

  return candidates.map((candidate) => ({
    point: candidate.point,
    distance: Math.sqrt(candidate.distanceSquared),
  }))
}

// Utility functions below commented out as no longer needed with simplified algorithm
// function wrappedSampleDistance(a: number, b: number, length: number): number {
//   const linear = Math.abs(a - b)
//   return Math.min(linear, Math.max(0, length - linear))
// }

// function minWrappedSampleDistance(sampleIndex: number, sourceIndices: number[], contourLength: number): number {
//   let best = Number.POSITIVE_INFINITY
//   for (const sourceIndex of sourceIndices) {
//     best = Math.min(best, wrappedSampleDistance(sampleIndex, sourceIndex, contourLength))
//   }
//   return best
// }

// function isSameWallNeighborhood(candidate: MatBoundaryPoint, source: MatRaySource): boolean {
//   return candidate.contourType === source.contourType
//     && candidate.contourIndex === source.contourIndex
//     && minWrappedSampleDistance(candidate.sampleIndex, source.sampleIndices, source.contourLength) <= SAME_WALL_WINDOW
// }

function midpoint(a: Point, b: Point): Point {
  return {
    x: (a.x + b.x) * 0.5,
    y: (a.y + b.y) * 0.5,
  }
}

function offsetPoint(origin: Point, normal: Point, distance: number): Point {
  return {
    x: origin.x + normal.x * distance,
    y: origin.y + normal.y * distance,
  }
}

function inwardNormalForSegment(start: Point, end: Point, material: MatRegionMaterial, testDistance: number): Point | null {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const length = Math.hypot(dx, dy)
  if (!(length > 1e-9)) {
    return null
  }

  const origin = midpoint(start, end)
  const left = { x: -dy / length, y: dx / length }
  const right = { x: dy / length, y: -dx / length }
  const leftInside = pointInRegionMaterial(offsetPoint(origin, left, testDistance), material)
  const rightInside = pointInRegionMaterial(offsetPoint(origin, right, testDistance), material)

  if (leftInside === rightInside) {
    return null
  }

  return leftInside ? left : right
}

function inwardNormalForPoint(previous: Point, current: Point, next: Point, material: MatRegionMaterial, testDistance: number): Point | null {
  // Calculate normal using three points for smoother direction
  const incomingX = current.x - previous.x
  const incomingY = current.y - previous.y
  const outgoingX = next.x - current.x
  const outgoingY = next.y - current.y
  
  // Average direction
  const avgX = incomingX + outgoingX
  const avgY = incomingY + outgoingY
  const avgLength = Math.hypot(avgX, avgY)
  
  if (!(avgLength > 1e-9)) {
    return null
  }
  
  // Perpendicular to average direction
  const left = { x: -avgY / avgLength, y: avgX / avgLength }
  const right = { x: avgY / avgLength, y: -avgX / avgLength }
  
  const leftInside = pointInRegionMaterial(offsetPoint(current, left, testDistance), material)
  const rightInside = pointInRegionMaterial(offsetPoint(current, right, testDistance), material)
  
  if (leftInside === rightInside) {
    return null
  }
  
  return leftInside ? left : right
}

function turnAngleAtVertex(previous: Point, current: Point, next: Point): number {
  const incomingX = current.x - previous.x
  const incomingY = current.y - previous.y
  const outgoingX = next.x - current.x
  const outgoingY = next.y - current.y
  const incomingLength = Math.hypot(incomingX, incomingY)
  const outgoingLength = Math.hypot(outgoingX, outgoingY)
  if (!(incomingLength > 1e-9) || !(outgoingLength > 1e-9)) {
    return 0
  }

  const cosine = Math.max(
    -1,
    Math.min(1, (incomingX * outgoingX + incomingY * outgoingY) / (incomingLength * outgoingLength)),
  )
  return Math.acos(cosine)
}

function inwardBisectorAtVertex(previous: Point, current: Point, next: Point, material: MatRegionMaterial, testDistance: number): Point | null {
  const previousNormal = inwardNormalForSegment(previous, current, material, testDistance)
  const nextNormal = inwardNormalForSegment(current, next, material, testDistance)
  if (!previousNormal && !nextNormal) {
    return null
  }
  if (!previousNormal) {
    return nextNormal
  }
  if (!nextNormal) {
    return previousNormal
  }

  const bisector = {
    x: previousNormal.x + nextNormal.x,
    y: previousNormal.y + nextNormal.y,
  }
  const length = Math.hypot(bisector.x, bisector.y)
  if (!(length > 1e-9)) {
    return previousNormal
  }

  const normalized = { x: bisector.x / length, y: bisector.y / length }
  if (pointInRegionMaterial(offsetPoint(current, normalized, testDistance), material)) {
    return normalized
  }
  if (pointInRegionMaterial(offsetPoint(current, previousNormal, testDistance), material)) {
    return previousNormal
  }
  if (pointInRegionMaterial(offsetPoint(current, nextNormal, testDistance), material)) {
    return nextNormal
  }
  return null
}

function cross2d(a: Point, b: Point): number {
  return a.x * b.y - a.y * b.x
}

function raySegmentIntersectionDistance(
  origin: Point,
  direction: Point,
  start: Point,
  end: Point,
): number | null {
  const segment = {
    x: end.x - start.x,
    y: end.y - start.y,
  }
  const diff = {
    x: start.x - origin.x,
    y: start.y - origin.y,
  }
  const denominator = cross2d(direction, segment)
  if (Math.abs(denominator) <= 1e-9) {
    return null
  }

  const t = cross2d(diff, segment) / denominator
  const u = cross2d(diff, direction) / denominator
  if (t <= 1e-6 || u < -1e-6 || u > 1 + 1e-6) {
    return null
  }

  return t
}

function nearestRayExitDistance(
  origin: Point,
  normal: Point,
  contours: MatBoundaryContour[],
  sourceContour: MatBoundaryContour,
  ignoredSegmentIndices: number[],
): number | null {
  let bestDistance = Number.POSITIVE_INFINITY

  for (const contour of contours) {
    for (let index = 0; index < contour.points.length; index++) {
      if (
        contour.contourType === sourceContour.contourType
        && contour.contourIndex === sourceContour.contourIndex
        && ignoredSegmentIndices.includes(index)
      ) {
        continue
      }

      const start = contour.points[index]
      const end = contour.points[(index + 1) % contour.points.length]
      const distance = raySegmentIntersectionDistance(origin, normal, start, end)
      if (distance !== null && distance < bestDistance) {
        bestDistance = distance
      }
    }
  }

  return Number.isFinite(bestDistance) ? bestDistance : null
}

/* the baseline code */
/*
function classifyRayPoint(
  point: Point,
  source: MatRaySource,
  boundaryPoints: MatBoundaryPoint[],
  boundaryIndex: MatBoundaryIndex,
  tolerance: number,
  rayOrigin?: Point,
  rayNormal?: Point,
): RayPointClassification {
  const nearest = nearestBoundaryPoints(point, boundaryPoints, boundaryIndex, BINARY_SEARCH_NEIGHBOR_COUNT)
  if (nearest.length < 2 || !rayOrigin) {
    return { kind: 'invalid' }
  }

  // STEP 1: Use distance strictly to the ray start point (origin)
  const sameWallDistance = Math.hypot(point.x - rayOrigin.x, point.y - rayOrigin.y)
  
  let otherWallDistance = Number.POSITIVE_INFINITY

  // We keep the existing search for the "Other" wall distance
  for (const candidate of nearest) {
    // Standard check to ensure we don't hit the starting point itself
    const isSourceNeighbor = 
      candidate.point.contourType === source.contourType &&
      candidate.point.contourIndex === source.contourIndex &&
      Math.abs(candidate.point.sampleIndex - source.sampleIndices[0]) <= 1 // Keeping original window for now
    
    let isAlongRay = true
    if (rayNormal) {
      const toPoint = { x: candidate.point.x - rayOrigin.x, y: candidate.point.y - rayOrigin.y }
      const dotProduct = toPoint.x * rayNormal.x + toPoint.y * rayNormal.y
      isAlongRay = dotProduct > -1e-6 
    }
    
    if (!isSourceNeighbor && isAlongRay) {
      otherWallDistance = Math.min(otherWallDistance, candidate.distance)
    }
  }

  if (!Number.isFinite(sameWallDistance) || !Number.isFinite(otherWallDistance)) {
    return { kind: 'invalid' }
  }

  if (Math.abs(sameWallDistance - otherWallDistance) <= tolerance) {
    return { kind: 'candidate', sameWallDistance, otherWallDistance }
  }

  return otherWallDistance > sameWallDistance 
    ? { kind: 'source-dominated', sameWallDistance, otherWallDistance }
    : { kind: 'other-dominated', sameWallDistance, otherWallDistance }
}
*/

/* work in progress, ideas, etc */
function classifyRayPoint(
  point: Point,
  source: MatRaySource,
  boundaryPoints: MatBoundaryPoint[],
  boundaryIndex: MatBoundaryIndex,
  tolerance: number,
  rayOrigin?: Point,
  rayNormal?: Point,
): RayPointClassification {
  const nearest = nearestBoundaryPoints(point, boundaryPoints, boundaryIndex, BINARY_SEARCH_NEIGHBOR_COUNT);
  
  if (nearest.length < 2 || !rayOrigin) {
    return { kind: 'invalid' };
  }

  // 1. SOURCE: Strict distance back to the Ray Origin point
  const sameWallDistance = Math.hypot(point.x - rayOrigin.x, point.y - rayOrigin.y);
  
  let otherWallDistance = Number.POSITIVE_INFINITY;
  const SAME_WALL_WINDOW = 3; 

  for (const candidate of nearest) {
    const bp = candidate.point;

    // 2. EXCLUSION: Skip points part of the source vertex neighborhood
    const isSourceNeighbor = 
      bp.contourType === source.contourType &&
      bp.contourIndex === source.contourIndex &&
      Math.abs(bp.sampleIndex - source.sampleIndices[0]) <= SAME_WALL_WINDOW;
    
    if (isSourceNeighbor) continue;

    // 3. OTHER SIDE: Segment Calculation
    // Find the next point in the global boundaryPoints array to form a segment.
    // We must ensure the next point belongs to the same contour.
    const currentIdx = boundaryPoints.indexOf(bp);
    const nextIdx = currentIdx + 1;
    
    let p2 = bp; // Fallback to point distance if no segment found
    if (nextIdx < boundaryPoints.length) {
      const candidateNext = boundaryPoints[nextIdx];
      // Only use as a segment if it's the same contour and sequential
      if (candidateNext.contourIndex === bp.contourIndex && 
          candidateNext.contourType === bp.contourType) {
        p2 = candidateNext;
      }
    }

    // Measure distance to the segment if p1 != p2, otherwise just point distance
    const distToOpposing = (bp.x === p2.x && bp.y === p2.y)
      ? Math.hypot(point.x - bp.x, point.y - bp.y)
      : distanceToSegment(point, bp, p2);

    otherWallDistance = Math.min(otherWallDistance, distToOpposing);
  }

  if (!Number.isFinite(sameWallDistance) || !Number.isFinite(otherWallDistance)) {
    return { kind: 'invalid' };
  }

  // 4. COMPARISON: Balance Point distance vs Segment distance
  if (Math.abs(sameWallDistance - otherWallDistance) <= tolerance) {
    return { kind: 'candidate', sameWallDistance, otherWallDistance };
  }

  return otherWallDistance > sameWallDistance 
    ? { kind: 'source-dominated', sameWallDistance, otherWallDistance }
    : { kind: 'other-dominated', sameWallDistance, otherWallDistance };
}

function refineMedialPoint(
  origin: Point,
  normal: Point,
  lowDistance: number,
  highDistance: number,
  source: MatRaySource,
  boundaryPoints: MatBoundaryPoint[],
  boundaryIndex: MatBoundaryIndex,
  tolerance: number,
  probePoints: MatSpinePoint[],
  bandTopZ: number,
  maxBandDepth: number,
  slope: number,
  bandIndex: number,
  regionIndex: number,
): Point | null {
  let low = lowDistance
  let high = highDistance
  let foundDistance: number | null = null

  for (let iteration = 0; iteration < BINARY_SEARCH_ITERATIONS; iteration++) {
    const mid = (low + high) * 0.5
    const point = offsetPoint(origin, normal, mid)
    const nearestAtProbe = nearestBoundaryPoint(point, boundaryPoints, boundaryIndex)
    if (nearestAtProbe) {
      const probeDepth = Math.min(maxBandDepth, nearestAtProbe.distance / slope)
      probePoints.push({
        x: point.x,
        y: point.y,
        z: bandTopZ - probeDepth,
        radius: nearestAtProbe.distance,
        bandIndex,
        regionIndex,
      })
    }
    const classification = classifyRayPoint(
      point,
      source,
      boundaryPoints,
      boundaryIndex,
      tolerance,
      origin,
      normal,
    )
    if (classification.kind === 'candidate') {
      foundDistance = mid
      break
    }
    if (classification.kind === 'source-dominated') {
      low = mid
    } else if (classification.kind === 'other-dominated') {
      high = mid
    } else {
      break
    }

    if (high - low <= tolerance) {
      foundDistance = (low + high) * 0.5
      break
    }
  }

  return foundDistance === null ? null : offsetPoint(origin, normal, foundDistance)
}

function traceRaySpinePoint(
  origin: Point,
  normal: Point,
  sourceContour: MatBoundaryContour,
  ignoredSegmentIndices: number[],
  source: MatRaySource,
  boundaryPoints: MatBoundaryPoint[],
  boundaryIndex: MatBoundaryIndex,
  contours: MatBoundaryContour[],
  bandTopZ: number,
  maxBandDepth: number,
  slope: number,
  medialTolerance: number,
  bandIndex: number,
  regionIndex: number,
  lowBracketPoints: MatSpinePoint[],
  highBracketPoints: MatSpinePoint[],
  probePoints: MatSpinePoint[],
): MatSpinePoint | null {
  const exitDistance = nearestRayExitDistance(origin, normal, contours, sourceContour, ignoredSegmentIndices)
  if (exitDistance === null || exitDistance <= 1e-9) {
    return null
  }

  const lowNearest = nearestBoundaryPoint(origin, boundaryPoints, boundaryIndex)
  if (lowNearest) {
    lowBracketPoints.push({
      x: origin.x,
      y: origin.y,
      z: bandTopZ - Math.min(maxBandDepth, lowNearest.distance / slope),
      radius: lowNearest.distance,
      bandIndex,
      regionIndex,
    })
  }

  const highPoint = offsetPoint(origin, normal, exitDistance)
  const highNearest = nearestBoundaryPoint(highPoint, boundaryPoints, boundaryIndex)
  if (highNearest) {
    highBracketPoints.push({
      x: highPoint.x,
      y: highPoint.y,
      z: bandTopZ - Math.min(maxBandDepth, highNearest.distance / slope),
      radius: highNearest.distance,
      bandIndex,
      regionIndex,
    })
  }

  const refinedPoint = refineMedialPoint(
    origin,
    normal,
    0,
    exitDistance,
    source,
    boundaryPoints,
    boundaryIndex,
    medialTolerance,
    probePoints,
    bandTopZ,
    maxBandDepth,
    slope,
    bandIndex,
    regionIndex,
  )
  if (!refinedPoint) {
    return null
  }

  const refinedNearest = nearestBoundaryPoint(refinedPoint, boundaryPoints, boundaryIndex)
  if (!refinedNearest) {
    return null
  }

  const radius = refinedNearest.distance
  const depth = Math.min(maxBandDepth, radius / slope)
  if (!(depth > 0)) {
    return null
  }

  return {
    x: refinedPoint.x,
    y: refinedPoint.y,
    z: bandTopZ - depth,
    radius,
    bandIndex,
    regionIndex,
  }
}

function scanContourSpinePath(
  contour: MatBoundaryContour,
  contours: MatBoundaryContour[],
  region: ResolvedPocketRegion,
  material: MatRegionMaterial,
  boundaryPoints: MatBoundaryPoint[],
  boundaryIndex: MatBoundaryIndex,
  bandTopZ: number,
  maxBandDepth: number,
  slope: number,
  scanStep: number,
  contourStride: number,
  bandIndex: number,
  regionIndex: number,
): {
  path: MatSpinePoint[]
  lowBracketPoints: MatSpinePoint[]
  highBracketPoints: MatSpinePoint[]
  probePoints: MatSpinePoint[]
  rays: number
  hits: number
} {
  const path: MatSpinePoint[] = []
  const lowBracketPoints: MatSpinePoint[] = []
  const highBracketPoints: MatSpinePoint[] = []
  const probePoints: MatSpinePoint[] = []
  
  const bounds = regionBounds(region)
  if (!bounds || contour.points.length < 3) {
    return { path, lowBracketPoints, highBracketPoints, probePoints, rays: 0, hits: 0 }
  }

  const normalProbe = Math.max(scanStep * 0.5, 1e-4)
  const medialTolerance = scanStep * 0.3 
  let rays = 0
  let hits = 0

  for (let index = 0; index < contour.points.length; index++) {
    // Standardize: Every ray is emitted from a vertex at the given stride
    if (index % contourStride !== 0) {
      continue
    }

    const current = contour.points[index]
    const previous = contour.points[(index - 1 + contour.points.length) % contour.points.length]
    const next = contour.points[(index + 1) % contour.points.length]

    // Calculate direction using the 3-point angle (bisector)
    const direction = inwardBisectorAtVertex(previous, current, next, material, normalProbe)

    if (direction) {
      rays += 1

      const vertexSource: MatRaySource = {
        contourType: contour.contourType,
        contourIndex: contour.contourIndex,
        contourLength: contour.points.length,
        sampleIndices: [current.sampleIndex],
        segments: [
          { start: previous, end: current },
          { start: current, end: next }
        ],
      }

      // traceRaySpinePoint now uses the vertex 'current' as the startPoint
      const hit = traceRaySpinePoint(
        current,   // Origin: Start point of the vertex
        direction, // Direction: Angle bisector
        contour,
        [(index - 1 + contour.points.length) % contour.points.length, index], 
        vertexSource,
        boundaryPoints,
        boundaryIndex,
        contours,
        bandTopZ,
        maxBandDepth,
        slope,
        medialTolerance,
        bandIndex,
        regionIndex,
        lowBracketPoints,
        highBracketPoints,
        probePoints,
      )

      if (hit) {
        path.push(hit)
        hits += 1
      }
    }
  }

  return { path, lowBracketPoints, highBracketPoints, probePoints, rays, hits }
}

function collapseDuplicatePoints(path: MatSpinePoint[], tolerance: number): MatSpinePoint[] {
  if (path.length === 0) {
    return []
  }

  const collapsed = [path[0]]
  for (let index = 1; index < path.length; index++) {
    const previous = collapsed[collapsed.length - 1]
    const current = path[index]
    if (
      Math.hypot(current.x - previous.x, current.y - previous.y) <= tolerance
      && Math.abs(current.z - previous.z) <= tolerance
    ) {
      continue
    }
    collapsed.push(current)
  }

  return collapsed
}

function distanceToSegment(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared <= 1e-12) {
    return Math.hypot(point.x - start.x, point.y - start.y)
  }

  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared))
  const projectionX = start.x + dx * t
  const projectionY = start.y + dy * t
  return Math.hypot(point.x - projectionX, point.y - projectionY)
}

function simplifyPath(path: MatSpinePoint[], tolerance: number): MatSpinePoint[] {
  if (path.length <= 2) {
    return path
  }

  let splitIndex = -1
  let maxDistance = -1
  for (let index = 1; index < path.length - 1; index++) {
    const distance = distanceToSegment(path[index], path[0], path[path.length - 1])
    if (distance > maxDistance) {
      maxDistance = distance
      splitIndex = index
    }
  }

  if (maxDistance <= tolerance || splitIndex < 0) {
    return [path[0], path[path.length - 1]]
  }

  const left = simplifyPath(path.slice(0, splitIndex + 1), tolerance)
  const right = simplifyPath(path.slice(splitIndex), tolerance)
  return [...left.slice(0, -1), ...right]
}

function pointDistance(a: MatSpinePoint, b: MatSpinePoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function pathArcLength(path: MatSpinePoint[]): number {
  let length = 0
  for (let index = 1; index < path.length; index++) {
    length += pointDistance(path[index - 1], path[index])
  }
  return length
}

function averagePoints(a: MatSpinePoint, b: MatSpinePoint): MatSpinePoint {
  return {
    x: (a.x + b.x) * 0.5,
    y: (a.y + b.y) * 0.5,
    z: (a.z + b.z) * 0.5,
    radius: (a.radius + b.radius) * 0.5,
    bandIndex: a.bandIndex,
    regionIndex: a.regionIndex,
  }
}

function smoothPathSafely(path: MatSpinePoint[], tolerance: number): MatSpinePoint[] {
  if (path.length < 5) {
    return path
  }

  const maxShift = tolerance * 0.35
  const maxTurnAngle = Math.PI / 3
  const smoothed: MatSpinePoint[] = [path[0]]

  for (let index = 1; index < path.length - 1; index++) {
    const previous = path[index - 1]
    const current = path[index]
    const next = path[index + 1]
    const prevLength = pointDistance(previous, current)
    const nextLength = pointDistance(current, next)

    if (prevLength <= 1e-9 || nextLength <= 1e-9) {
      smoothed.push(current)
      continue
    }

    const prevDirX = (current.x - previous.x) / prevLength
    const prevDirY = (current.y - previous.y) / prevLength
    const nextDirX = (next.x - current.x) / nextLength
    const nextDirY = (next.y - current.y) / nextLength
    const cosine = Math.max(-1, Math.min(1, prevDirX * nextDirX + prevDirY * nextDirY))
    const turnAngle = Math.acos(cosine)

    if (turnAngle > maxTurnAngle) {
      smoothed.push(current)
      continue
    }

    const targetX = (previous.x + current.x * 2 + next.x) * 0.25
    const targetY = (previous.y + current.y * 2 + next.y) * 0.25
    let deltaX = targetX - current.x
    let deltaY = targetY - current.y
    const shift = Math.hypot(deltaX, deltaY)

    if (shift > maxShift && shift > 1e-9) {
      const scale = maxShift / shift
      deltaX *= scale
      deltaY *= scale
    }

    smoothed.push({
      x: current.x + deltaX,
      y: current.y + deltaY,
      z: (previous.z + current.z * 2 + next.z) * 0.25,
      radius: (previous.radius + current.radius * 2 + next.radius) * 0.25,
      bandIndex: current.bandIndex,
      regionIndex: current.regionIndex,
    })
  }

  smoothed.push(path[path.length - 1])
  return smoothed
}

function tryMergeParallelPaths(a: MatSpinePoint[], b: MatSpinePoint[], tolerance: number): MatSpinePoint[] | null {
  if (a.length < MIN_PATH_POINTS || b.length < MIN_PATH_POINTS) {
    return null
  }

  const reversed = pointDistance(a[0], b[b.length - 1]) + pointDistance(a[a.length - 1], b[0])
    < pointDistance(a[0], b[0]) + pointDistance(a[a.length - 1], b[b.length - 1])
  const alignedB = reversed ? [...b].reverse() : b
  const sampleCount = Math.min(a.length, alignedB.length)
  if (sampleCount < MIN_PATH_POINTS) {
    return null
  }

  const merged: MatSpinePoint[] = []
  let closeSamples = 0

  for (let index = 0; index < sampleCount; index++) {
    const aIndex = Math.round((index * (a.length - 1)) / Math.max(1, sampleCount - 1))
    const bIndex = Math.round((index * (alignedB.length - 1)) / Math.max(1, sampleCount - 1))
    const aPoint = a[aIndex]
    const bPoint = alignedB[bIndex]
    if (pointDistance(aPoint, bPoint) > tolerance) {
      return null
    }
    merged.push(averagePoints(aPoint, bPoint))
    closeSamples += 1
  }

  return closeSamples >= MIN_PATH_POINTS ? merged : null
}

function mergeNearbyParallelPaths(paths: MatSpinePoint[][], tolerance: number): MatSpinePoint[][] {
  const remaining = [...paths]
  const merged: MatSpinePoint[][] = []

  while (remaining.length > 0) {
    const current = remaining.shift()!
    let mergedCurrent = current
    let didMerge = false

    for (let index = 0; index < remaining.length; index++) {
      const candidate = remaining[index]
      const combined = tryMergeParallelPaths(mergedCurrent, candidate, tolerance)
      if (!combined) {
        continue
      }

      mergedCurrent = combined
      remaining.splice(index, 1)
      didMerge = true
      index -= 1
    }

    merged.push(didMerge ? collapseDuplicatePoints(mergedCurrent, tolerance) : mergedCurrent)
  }

  return merged
}

function arePathsEquivalent(a: MatSpinePoint[], b: MatSpinePoint[], tolerance: number): boolean {
  if (a.length === 0 || b.length === 0) {
    return false
  }

  const direct = Math.hypot(a[0].x - b[0].x, a[0].y - b[0].y) <= tolerance
    && Math.hypot(a[a.length - 1].x - b[b.length - 1].x, a[a.length - 1].y - b[b.length - 1].y) <= tolerance
  const reversed = Math.hypot(a[0].x - b[b.length - 1].x, a[0].y - b[b.length - 1].y) <= tolerance
    && Math.hypot(a[a.length - 1].x - b[0].x, a[a.length - 1].y - b[0].y) <= tolerance

  return direct || reversed
}

function connectRegionSpinePaths(paths: MatSpinePoint[][], scanStep: number): MatSpinePoint[][] {
  if (paths.length === 0) {
    return []
  }

  const tolerance = scanStep * 0.75
  const cleaned = mergeNearbyParallelPaths(paths, tolerance)
    .map((path) => collapseDuplicatePoints(path, tolerance))
    .map((path) => simplifyPath(path, tolerance))
    .map((path) => smoothPathSafely(path, tolerance))
    .map((path) => collapseDuplicatePoints(path, tolerance))
    .filter((path) => path.length >= MIN_PATH_POINTS || pathArcLength(path) >= scanStep * 2)
    .sort((left, right) => right.length - left.length)

  const unique: MatSpinePoint[][] = []
  for (const path of cleaned) {
    if (unique.some((existing) => arePathsEquivalent(existing, path, tolerance))) {
      continue
    }
    unique.push(path)
    if (unique.length >= MAX_REGION_PATHS) {
      break
    }
  }

  return unique
}

function detectRegionSpinePaths(
  region: ResolvedPocketRegion,
  contours: MatBoundaryContour[],
  boundaryPoints: MatBoundaryPoint[],
  boundaryIndex: MatBoundaryIndex,
  bandTopZ: number,
  maxBandDepth: number,
  slope: number,
  scanStep: number,
  contourStride: number,
  bandIndex: number,
  regionIndex: number,
): {
  lowBracketPoints: MatSpinePoint[]
  highBracketPoints: MatSpinePoint[]
  probePoints: MatSpinePoint[]
  spinePaths: MatSpinePoint[][]
  detection: MatDetectionStats
} {
  const provisionalPaths: MatSpinePoint[][] = []
  const lowBracketPoints: MatSpinePoint[] = []
  const highBracketPoints: MatSpinePoint[] = []
  const probePoints: MatSpinePoint[] = []
  let scannedRayCount = 0
  let medialHitCount = 0
  const material = buildRegionMaterial(region)

  for (const contour of contours) {
    const scan = scanContourSpinePath(
      contour,
      contours,
      region,
      material,
      boundaryPoints,
      boundaryIndex,
      bandTopZ,
      maxBandDepth,
      slope,
      scanStep,
      contourStride,
      bandIndex,
      regionIndex,
    )
    scannedRayCount += scan.rays
    medialHitCount += scan.hits
    lowBracketPoints.push(...scan.lowBracketPoints)
    highBracketPoints.push(...scan.highBracketPoints)
    probePoints.push(...scan.probePoints)
    if (scan.path.length > 0) {
      provisionalPaths.push(scan.path)
    }
  }

  return {
    lowBracketPoints,
    highBracketPoints,
    probePoints,
    spinePaths: provisionalPaths,
    detection: {
      scannedRayCount,
      medialHitCount,
    },
  }
}

function appendDebugPointMarkers(
  points: MatSpinePoint[],
  scanStep: number,
  safeZ: number,
  moves: ToolpathMove[],
  currentPosition: ToolpathMove['to'] | null,
): ToolpathMove['to'] | null {
  let position = currentPosition
  const markerHalfSize = Math.max(scanStep * 0.25, 1e-4)

  for (const point of points) {
    const startA = { x: point.x - markerHalfSize, y: point.y - markerHalfSize, z: point.z }
    const endA = { x: point.x + markerHalfSize, y: point.y + markerHalfSize, z: point.z }
    const startB = { x: point.x - markerHalfSize, y: point.y + markerHalfSize, z: point.z }
    const endB = { x: point.x + markerHalfSize, y: point.y - markerHalfSize, z: point.z }

    position = retractToSafe(moves, position, safeZ)
    position = pushRapidAndPlunge(moves, position, startA, safeZ)
    moves.push({ kind: 'cut', from: startA, to: endA })
    position = endA
    position = retractToSafe(moves, position, safeZ)
    position = pushRapidAndPlunge(moves, position, startB, safeZ)
    moves.push({ kind: 'cut', from: startB, to: endB })
    position = endB
  }

  return retractToSafe(moves, position, safeZ)
}

function appendDebugProbeMarkers(
  points: MatSpinePoint[],
  scanStep: number,
  safeZ: number,
  moves: ToolpathMove[],
  currentPosition: ToolpathMove['to'] | null,
): ToolpathMove['to'] | null {
  let position = currentPosition
  const markerSize = Math.max(scanStep * 0.3, 1e-4)

  for (const point of points) {
    const top = { x: point.x, y: point.y + markerSize, z: point.z }
    const left = { x: point.x - markerSize, y: point.y - markerSize, z: point.z }
    const right = { x: point.x + markerSize, y: point.y - markerSize, z: point.z }

    position = retractToSafe(moves, position, safeZ)
    position = pushRapidAndPlunge(moves, position, top, safeZ)
    moves.push({ kind: 'cut', from: top, to: left })
    moves.push({ kind: 'cut', from: left, to: right })
    moves.push({ kind: 'cut', from: right, to: top })
    position = top
  }

  return retractToSafe(moves, position, safeZ)
}

function appendDebugSquareMarkers(
  points: MatSpinePoint[],
  scanStep: number,
  safeZ: number,
  moves: ToolpathMove[],
  currentPosition: ToolpathMove['to'] | null,
): ToolpathMove['to'] | null {
  let position = currentPosition
  const markerSize = Math.max(scanStep * 0.25, 1e-4)

  for (const point of points) {
    const topLeft = { x: point.x - markerSize, y: point.y + markerSize, z: point.z }
    const topRight = { x: point.x + markerSize, y: point.y + markerSize, z: point.z }
    const bottomRight = { x: point.x + markerSize, y: point.y - markerSize, z: point.z }
    const bottomLeft = { x: point.x - markerSize, y: point.y - markerSize, z: point.z }

    position = retractToSafe(moves, position, safeZ)
    position = pushRapidAndPlunge(moves, position, topLeft, safeZ)
    moves.push({ kind: 'cut', from: topLeft, to: topRight })
    moves.push({ kind: 'cut', from: topRight, to: bottomRight })
    moves.push({ kind: 'cut', from: bottomRight, to: bottomLeft })
    moves.push({ kind: 'cut', from: bottomLeft, to: topLeft })
    position = topLeft
  }

  return retractToSafe(moves, position, safeZ)
}

function appendDebugDiamondMarkers(
  points: MatSpinePoint[],
  scanStep: number,
  safeZ: number,
  moves: ToolpathMove[],
  currentPosition: ToolpathMove['to'] | null,
): ToolpathMove['to'] | null {
  let position = currentPosition
  const markerSize = Math.max(scanStep * 0.28, 1e-4)

  for (const point of points) {
    const top = { x: point.x, y: point.y + markerSize, z: point.z }
    const right = { x: point.x + markerSize, y: point.y, z: point.z }
    const bottom = { x: point.x, y: point.y - markerSize, z: point.z }
    const left = { x: point.x - markerSize, y: point.y, z: point.z }

    position = retractToSafe(moves, position, safeZ)
    position = pushRapidAndPlunge(moves, position, top, safeZ)
    moves.push({ kind: 'cut', from: top, to: right })
    moves.push({ kind: 'cut', from: right, to: bottom })
    moves.push({ kind: 'cut', from: bottom, to: left })
    moves.push({ kind: 'cut', from: left, to: top })
    position = top
  }

  return retractToSafe(moves, position, safeZ)
}

function appendSpinePathsAsMoves(
  paths: MatSpinePoint[][],
  safeZ: number,
  moves: ToolpathMove[],
  currentPosition: ToolpathMove['to'] | null,
): ToolpathMove['to'] | null {
  let position = currentPosition

  for (const path of paths) {
    if (path.length === 0) {
      continue
    }

    const entry = path[0]
    position = retractToSafe(moves, position, safeZ)
    position = pushRapidAndPlunge(moves, position, entry, safeZ)

    for (let index = 1; index < path.length; index++) {
      moves.push({
        kind: 'cut',
        from: path[index - 1],
        to: path[index],
      })
      position = path[index]
    }
  }

  return retractToSafe(moves, position, safeZ)
}

function analyzeResolvedVCarveMat(project: Project, operation: Operation, resolved: ResolvedPocketResult): MatAnalysisResult {
  const warnings = [...resolved.warnings]
  const regions: MatRegionAnalysis[] = []

  const toolRecord = operation.toolRef
    ? project.tools.find((tool) => tool.id === operation.toolRef) ?? null
    : null

  if (!toolRecord) {
    return {
      operationId: operation.id,
      regions: [],
      warnings: [...warnings, 'No tool assigned to this operation'],
    }
  }

  const tool = normalizeToolForProject(toolRecord, project)
  if (tool.type !== 'v_bit' || !(tool.vBitAngle && tool.vBitAngle > 0 && tool.vBitAngle < 180)) {
    return {
      operationId: operation.id,
      regions: [],
      warnings: [...warnings, 'MAT V-carve analysis requires a valid V-bit tool'],
    }
  }

  const halfAngleRadians = (tool.vBitAngle * Math.PI) / 360
  const slope = Math.tan(halfAngleRadians)
  if (!(slope > 1e-9)) {
    return {
      operationId: operation.id,
      regions: [],
      warnings: [...warnings, 'V-bit angle produces an invalid carving slope'],
    }
  }

  const { boundaryResolution, scanStep } = samplingProfileForOperation(project, operation)
  const raySpacing = Math.max(scanStep, operation.stepover)
  const contourStride = Math.max(1, Math.ceil(raySpacing / Math.max(boundaryResolution, 1e-9)))

  resolved.bands.forEach((band, bandIndex) => {
    const maxBandDepth = Math.max(0, Math.min(operation.maxCarveDepth, band.topZ - band.bottomZ))
    if (!(maxBandDepth > 0)) {
      return
    }

    band.regions.forEach((region, regionIndex) => {
      const contours = buildBoundaryContours(region, boundaryResolution)
      const boundaryPoints = contours.flatMap((contour) => contour.points)
      const boundaryIndex = buildBoundaryIndex(boundaryPoints, Math.max(boundaryResolution * 2, scanStep))
      const scan = detectRegionSpinePaths(
        region,
        contours,
        boundaryPoints,
        boundaryIndex,
        band.topZ,
        maxBandDepth,
        slope,
        scanStep,
        contourStride,
        bandIndex,
        regionIndex,
      )
      const rawSpinePaths = scan.spinePaths
      const spinePaths = connectRegionSpinePaths(rawSpinePaths, scanStep)
      const rawSpinePoints = rawSpinePaths.flat()
      const spinePoints = spinePaths.flat()

      regions.push({
        regionIndex,
        boundaryPoints,
        scanStep,
        lowBracketPoints: scan.lowBracketPoints,
        highBracketPoints: scan.highBracketPoints,
        probePoints: scan.probePoints,
        rawSpinePoints,
        rawSpinePaths,
        spinePoints,
        spinePaths,
        detection: scan.detection,
      })
    })
  })

  return {
    operationId: operation.id,
    regions,
    warnings,
  }
}

export function analyzeVCarveMat(project: Project, operation: Operation): MatAnalysisResult {
  return analyzeResolvedVCarveMat(project, operation, resolvePocketRegions(project, operation))
}

export function generateVCarveMatToolpath(project: Project, operation: Operation): ToolpathResult {
  if (operation.kind !== 'v_carve_recursive') {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['MAT V-carve solver currently targets v_carve_recursive operations only'],
      bounds: null,
    }
  }

  if (!operation.debugToolpath) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['MAT solver disabled for preview. Enable Debug toolpath to run it.'],
      bounds: null,
    }
  }

  const resolved = resolvePocketRegions(project, operation)
  const { boundaryResolution, scanStep } = samplingProfileForOperation(project, operation)
  const estimate = estimateMatComplexity(resolved, boundaryResolution, scanStep)
  if (
    estimate.scanSteps > MAX_ESTIMATED_SCAN_STEPS
    || estimate.boundaryPoints > MAX_ESTIMATED_BOUNDARY_POINTS
  ) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [
        ...resolved.warnings,
        `MAT debug aborted: estimated ${estimate.scanSteps} scan steps and ${estimate.boundaryPoints} boundary points exceed temporary limits`,
      ],
      bounds: null,
    }
  }

  const analysis = analyzeResolvedVCarveMat(project, operation, resolved)
  const toolRecord = operation.toolRef
    ? project.tools.find((tool) => tool.id === operation.toolRef) ?? null
    : null
  const warnings = [...analysis.warnings]
  const moves: ToolpathMove[] = []
  let currentPosition: ToolpathMove['to'] | null = null
  const safeZ = getOperationSafeZ(project)

  if (toolRecord) {
    const tool = normalizeToolForProject(toolRecord, project)
    const depthWarning = checkMaxCutDepthWarning(tool, operation.maxCarveDepth)
    if (depthWarning) {
      warnings.push(depthWarning)
    }
  }

  const scannedRayCount = analysis.regions.reduce((sum, region) => sum + region.detection.scannedRayCount, 0)
  const medialHitCount = analysis.regions.reduce((sum, region) => sum + region.detection.medialHitCount, 0)
  const rawPointCount = analysis.regions.reduce((sum, region) => sum + region.rawSpinePoints.length, 0)
  const candidateCount = analysis.regions.reduce((sum, region) => sum + region.spinePoints.length, 0)
  const pathCount = analysis.regions.reduce((sum, region) => sum + region.spinePaths.length, 0)
  analysis.regions.forEach((region) => {
    if (operation.debugOverlay) {
      currentPosition = appendDebugSquareMarkers(region.lowBracketPoints, region.scanStep, safeZ, moves, currentPosition)
      currentPosition = appendDebugDiamondMarkers(region.highBracketPoints, region.scanStep, safeZ, moves, currentPosition)
      currentPosition = appendDebugProbeMarkers(region.probePoints, region.scanStep, safeZ, moves, currentPosition)
      currentPosition = appendDebugPointMarkers(region.rawSpinePoints, region.scanStep, safeZ, moves, currentPosition)
    }
    currentPosition = appendSpinePathsAsMoves(region.spinePaths, safeZ, moves, currentPosition)
  })
  warnings.push(`MAT scaffold kept ${candidateCount}/${rawPointCount}/${medialHitCount}/${scannedRayCount} spine points (final/raw/hits/rays) across ${pathCount} provisional paths`)

  return {
    operationId: operation.id,
    moves,
    warnings,
    bounds: computeBounds(moves),
  }
}
