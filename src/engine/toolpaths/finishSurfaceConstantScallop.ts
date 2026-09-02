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

import type { Operation, Point, Project, SketchFeature } from '../../types/project'
import type { ToolpathWarning } from './warningCodes'
import type { ClipperPath, NormalizedTool, ToolpathMove, ToolpathPoint } from './types'
import { appendAll } from './appendAll'
import { DEFAULT_CLIPPER_SCALE, applyContourDirectionBySide } from './geometry'
import { buildRegionMask } from './regions'
import { resolveRegionDomainCentre } from './regionDomain'
import {
  buildProtectedFootprintPaths,
  clipperPathsToTupleContours,
  differenceClipperPaths,
} from './modelProtection'
import {
  buildSurfaceSlopeDomain,
  createSurfaceDomainLinkCheck,
  intersectSurfaceSlopeDomain,
} from './finishSurfaceSlope'
import {
  chooseHeightMapCellSize,
  computeXYBounds,
  getCachedHeightMap,
  modelSilhouettePathsForFinishSurface,
  safeToolTipZAt,
  type FinishSurfaceParallelCacheHost,
  type HeightMap,
} from './finishSurfaceParallel'
import { retractToSafe, transitionToCutEntry } from './pocket'
import {
  buildGeodesicDistanceField,
  extractConstantDistanceContours,
  type ConstantDistanceContour,
  type ConstantScallopGrid,
} from './constantScallopField'

interface PlannedContour {
  level: number
  points: Point[]
  closed: boolean
  boundary: boolean
}

interface LiftedContour {
  points: ToolpathPoint[]
  closed: boolean
}

function rowIntersections(paths: ClipperPath[], y: number): number[] {
  const intersections: number[] = []
  const scaledY = y * DEFAULT_CLIPPER_SCALE
  for (const path of paths) {
    for (let index = 0; index < path.length; index += 1) {
      const a = path[index]
      const b = path[(index + 1) % path.length]
      if (a.Y === b.Y) continue
      const crosses = (a.Y <= scaledY && b.Y > scaledY) || (b.Y <= scaledY && a.Y > scaledY)
      if (!crosses) continue
      const t = (scaledY - a.Y) / (b.Y - a.Y)
      intersections.push((a.X + (b.X - a.X) * t) / DEFAULT_CLIPPER_SCALE)
    }
  }
  return intersections.sort((left, right) => left - right)
}

function markDomainRow(mask: Uint8Array, heightMap: HeightMap, row: number, paths: ClipperPath[]): void {
  const y = heightMap.originY + (row + 0.5) * heightMap.cellSize
  const intersections = rowIntersections(paths, y)
  for (let index = 0; index + 1 < intersections.length; index += 2) {
    const first = Math.max(0, Math.ceil((intersections[index] - heightMap.originX) / heightMap.cellSize - 0.5))
    const last = Math.min(
      heightMap.width - 1,
      Math.floor((intersections[index + 1] - heightMap.originX) / heightMap.cellSize - 0.5),
    )
    for (let col = first; col <= last; col += 1) mask[row * heightMap.width + col] = 1
  }
}

function buildCutterLocationGrid(
  heightMap: HeightMap,
  domain: ClipperPath[],
  tool: NormalizedTool,
  axialLeave: number,
): ConstantScallopGrid | null {
  const cellCount = heightMap.width * heightMap.height
  const valid = new Uint8Array(cellCount)
  for (let row = 0; row < heightMap.height; row += 1) markDomainRow(valid, heightMap, row, domain)
  const cutterLocationZ = new Float64Array(cellCount)
  cutterLocationZ.fill(NaN)
  let validCells = 0
  for (let row = 0; row < heightMap.height; row += 1) {
    for (let col = 0; col < heightMap.width; col += 1) {
      const at = row * heightMap.width + col
      if (valid[at] === 0) continue
      const x = heightMap.originX + (col + 0.5) * heightMap.cellSize
      const y = heightMap.originY + (row + 0.5) * heightMap.cellSize
      const z = safeToolTipZAt(x, y, heightMap, tool)
      if (!Number.isFinite(z)) {
        valid[at] = 0
        continue
      }
      cutterLocationZ[at] = z + axialLeave
      validCells += 1
    }
  }
  if (validCells === 0) return null
  return {
    width: heightMap.width,
    height: heightMap.height,
    originX: heightMap.originX,
    originY: heightMap.originY,
    cellSize: heightMap.cellSize,
    cutterLocationZ,
    valid,
  }
}

function clipperBoundaryContours(paths: ClipperPath[]): PlannedContour[] {
  return clipperPathsToTupleContours(paths)
    .filter((points) => points.length >= 3)
    .map((points) => ({
      level: 0,
      points: points.map(([x, y]) => ({ x, y })),
      closed: true,
      boundary: true,
    }))
}

function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const a = polygon[index]
    const b = polygon[previous]
    const crosses = (a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x
    if (crosses) inside = !inside
  }
  return inside
}

function containmentRoles(contours: Point[][]): boolean[] {
  return contours.map((contour, index) => {
    const point = contour[0]
    let depth = 0
    for (let other = 0; other < contours.length; other += 1) {
      if (other !== index && pointInPolygon(point, contours[other])) depth += 1
    }
    return depth % 2 === 0
  })
}

function orientContourBatch(contours: PlannedContour[], direction: Operation['cutDirection']): PlannedContour[] {
  const points = contours.map((contour) => contour.points)
  const closed = contours.map((contour) => contour.closed)
  const roles = containmentRoles(points)
  const oriented = applyContourDirectionBySide(points, direction, 'tool-inside', closed, undefined, roles)
  return contours.map((contour, index) => ({ ...contour, points: oriented[index] }))
}

function plannedSort(left: PlannedContour, right: PlannedContour): number {
  if (left.level !== right.level) return left.level - right.level
  const leftPoint = left.points.reduce((best, point) => point.y < best.y || (point.y === best.y && point.x < best.x) ? point : best)
  const rightPoint = right.points.reduce((best, point) => point.y < best.y || (point.y === best.y && point.x < best.x) ? point : best)
  return leftPoint.y - rightPoint.y || leftPoint.x - rightPoint.x || left.points.length - right.points.length
}

function planContours(domain: ClipperPath[], distanceContours: ConstantDistanceContour[]): PlannedContour[] {
  const byLevel = new Map<number, PlannedContour[]>()
  const append = (contour: PlannedContour): void => {
    const entries = byLevel.get(contour.level) ?? []
    entries.push(contour)
    byLevel.set(contour.level, entries)
  }
  clipperBoundaryContours(domain).forEach(append)
  distanceContours.forEach((contour) => append({ ...contour, boundary: false }))
  const planned: PlannedContour[] = []
  for (const entries of byLevel.values()) appendAll(planned, orientContourBatch(entries, 'conventional'))
  return planned.sort(plannedSort)
}

function applyDirection(contours: PlannedContour[], direction: Operation['cutDirection']): PlannedContour[] {
  if (direction === 'conventional') return contours
  const byLevel = new Map<number, PlannedContour[]>()
  for (const contour of contours) {
    const entries = byLevel.get(contour.level) ?? []
    entries.push(contour)
    byLevel.set(contour.level, entries)
  }
  const directed: PlannedContour[] = []
  for (const entries of byLevel.values()) appendAll(directed, orientContourBatch(entries, direction))
  return directed.sort(plannedSort)
}

function densify(points: Point[], closed: boolean, maximumStep: number): Point[] {
  const dense: Point[] = []
  const segmentCount = closed ? points.length : points.length - 1
  for (let index = 0; index < segmentCount; index += 1) {
    const from = points[index]
    const to = points[(index + 1) % points.length]
    const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / maximumStep))
    for (let step = 0; step < steps; step += 1) {
      const t = step / steps
      dense.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t })
    }
  }
  if (!closed) dense.push(points[points.length - 1])
  return dense
}

function splitByDomain(
  contour: PlannedContour,
  linkInside: (from: Point, to: Point) => boolean,
): Array<{ points: Point[]; closed: boolean }> {
  if (contour.boundary) return [{ points: contour.points, closed: true }]
  const points = contour.points
  const edgeCount = contour.closed ? points.length : points.length - 1
  const fragments: Array<{ points: Point[]; closed: boolean }> = []
  let current: Point[] = []
  let allInside = true
  const flush = (): void => {
    if (current.length >= 2) fragments.push({ points: current, closed: false })
    current = []
  }
  for (let index = 0; index < edgeCount; index += 1) {
    const from = points[index]
    const to = points[(index + 1) % points.length]
    if (!linkInside(from, to)) {
      allInside = false
      flush()
      continue
    }
    if (current.length === 0) current.push(from)
    current.push(to)
  }
  if (allInside && contour.closed) return [{ points, closed: true }]
  flush()
  return fragments
}

function liftFragment(
  fragment: { points: Point[]; closed: boolean },
  heightMap: HeightMap,
  tool: NormalizedTool,
  axialLeave: number,
  minCutZAtPoint: (point: Point) => number,
): LiftedContour[] {
  const lifted: LiftedContour[] = []
  let current: ToolpathPoint[] = []
  let previousFloor: number | null = null
  const flush = (closed = false): void => {
    if (current.length >= (closed ? 3 : 2)) lifted.push({ points: current, closed })
    current = []
    previousFloor = null
  }
  for (const point of fragment.points) {
    const surfaceZ = safeToolTipZAt(point.x, point.y, heightMap, tool)
    if (!Number.isFinite(surfaceZ)) {
      flush()
      continue
    }
    const floor = minCutZAtPoint(point)
    if (previousFloor !== null && Math.abs(previousFloor - floor) > 1e-9) flush()
    current.push({ x: point.x, y: point.y, z: Math.max(surfaceZ + axialLeave, floor) })
    previousFloor = floor
  }
  flush(fragment.closed && lifted.length === 0)
  return lifted
}

function toCutMoves(contour: LiftedContour): ToolpathMove[] {
  const moves: ToolpathMove[] = []
  const edgeCount = contour.closed ? contour.points.length : contour.points.length - 1
  for (let index = 0; index < edgeCount; index += 1) {
    moves.push({ kind: 'cut', from: contour.points[index], to: contour.points[(index + 1) % contour.points.length] })
  }
  return moves
}

function emitContours(
  contours: PlannedContour[],
  domain: ClipperPath[],
  heightMap: HeightMap,
  tool: NormalizedTool,
  operation: Operation,
  safeZ: number,
  minCutZAtPoint: (point: Point) => number,
): { moves: ToolpathMove[]; stepLevels: Set<number> } {
  const moves: ToolpathMove[] = []
  const stepLevels = new Set<number>()
  const linkInside = createSurfaceDomainLinkCheck(domain)
  let position: ToolpathPoint | null = null
  for (const contour of applyDirection(contours, operation.cutDirection)) {
    const dense = { ...contour, points: densify(contour.points, contour.closed, heightMap.cellSize) }
    for (const fragment of splitByDomain(dense, linkInside)) {
      for (const lifted of liftFragment(
        fragment,
        heightMap,
        tool,
        Math.max(0, operation.stockToLeaveAxial),
        minCutZAtPoint,
      )) {
        position = transitionToCutEntry(moves, position, lifted.points[0], safeZ, 0)
        appendAll(moves, toCutMoves(lifted))
        for (const point of lifted.points) stepLevels.add(point.z)
        position = retractToSafe(moves, lifted.points[lifted.points.length - 1], safeZ)
      }
    }
  }
  return { moves, stepLevels }
}

function resolveDomain(
  project: Project,
  operation: Operation,
  modelFeature: SketchFeature,
  regionFeatures: SketchFeature[],
  tool: NormalizedTool,
  heightMap: HeightMap,
  warnings: ToolpathWarning[],
): ClipperPath[] {
  const silhouette = modelSilhouettePathsForFinishSurface(modelFeature)
  const regionMask = buildRegionMask(regionFeatures)
  const centreInset = tool.radius + Math.max(0, operation.stockToLeaveRadial ?? 0)
  let domain = resolveRegionDomainCentre(silhouette, regionMask, centreInset)
  const slope = buildSurfaceSlopeDomain(
    operation,
    heightMap,
    (x, y) => safeToolTipZAt(x, y, heightMap, tool),
    warnings,
  )
  if (slope !== null) domain = intersectSurfaceSlopeDomain(domain, slope)
  const protectedPaths = buildProtectedFootprintPaths(project, {
    targetFeatureIds: new Set(operation.target.source === 'features' ? operation.target.featureIds : []),
    featureExpansion: centreInset,
    clampExpansion: tool.radius,
    includeTabs: false,
    machiningEnvelopePaths: silhouette,
  })
  return differenceClipperPaths(domain, protectedPaths)
}

export function generateFinishSurfaceConstantScallop(
  project: Project,
  operation: Operation,
  modelFeature: SketchFeature,
  regionFeatures: SketchFeature[],
  tool: NormalizedTool,
  transformedPos: Float32Array,
  index: Uint32Array,
  cacheHost: FinishSurfaceParallelCacheHost,
  safeZ: number,
  minCutZAtPoint: (point: Point) => number,
  warnings: ToolpathWarning[],
): { moves: ToolpathMove[]; stepLevels: Set<number> } {
  const stepoverRatio = operation.stepover ?? 0.5
  const spacing = stepoverRatio * tool.diameter
  if (!(spacing > 0) || !Number.isFinite(spacing)) {
    warnings.push({ code: 'stepoverRatioRange' })
    return { moves: [], stepLevels: new Set() }
  }
  const bounds = computeXYBounds(transformedPos)
  const requestedCellSize = Math.max(1e-6, Math.min(tool.radius / 5, spacing))
  const cellSize = chooseHeightMapCellSize(bounds, requestedCellSize, warnings)
  if (cellSize > spacing + 1e-9) {
    warnings.push({
      code: 'constantScallopResolutionTooCoarse',
      params: { spacing: spacing.toFixed(4), cellSize: cellSize.toFixed(4) },
    })
    return { moves: [], stepLevels: new Set() }
  }
  const heightMap = getCachedHeightMap(cacheHost, transformedPos, index, bounds, cellSize)
  const domain = resolveDomain(project, operation, modelFeature, regionFeatures, tool, heightMap, warnings)
  if (domain.length === 0) {
    if (!warnings.some((warning) => warning.code === 'finishSlopeEmpty')) {
      warnings.push({ code: 'constantScallopEmpty' })
    }
    return { moves: [], stepLevels: new Set() }
  }
  const grid = buildCutterLocationGrid(heightMap, domain, tool, Math.max(0, operation.stockToLeaveAxial))
  const field = grid ? buildGeodesicDistanceField(grid) : null
  if (!field) {
    warnings.push({ code: 'constantScallopEmpty' })
    return { moves: [], stepLevels: new Set() }
  }
  const contours = planContours(domain, extractConstantDistanceContours(field, spacing))
  return emitContours(contours, domain, heightMap, tool, operation, safeZ, minCutZAtPoint)
}
