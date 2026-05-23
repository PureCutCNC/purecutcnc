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

import type { Operation, Point, Project } from '../../types/project'
import type { PocketToolpathResult, ResolvedPocketRegion, ToolpathBounds, ToolpathMove, ToolpathPoint } from './types'
import { DEFAULT_CLIPPER_SCALE, applyContourDirection, normalizeWinding, toClipperPath } from './geometry'
import {
  buildPocketFloorContours,
  buildPocketParallelSegments,
  contourStartPoint,
  executeDifference,
  orderClosedContoursGreedy,
  orderOpenSegmentsGreedy,
  polyTreeToRegions,
  retractToSafe,
  toClosedCutMoves,
  toOpenCutMoves,
  transitionToCutEntry,
  updateBounds,
} from './pocket'
import {
  calculateClipperArea,
  differenceClipperPaths,
  featureFootprintPaths,
  intersectClipperPaths,
  relatedIntersectingAddFeatures,
  unionClipperPaths,
} from './modelProtection'
import { splitFeatureTargets } from './regions'
import { resolve3DSurfaceStepdown } from './surfaceStepdown3d'
import type { Resolved3DSurfaceLevel } from './surfaceStepdown3d'
import type { ClipperPath } from './types'

const KEY_SCALE = 1_000
const WALL_COLUMN_OVERLAP_THRESHOLD = 0.5

interface CleanupWallContour {
  z: number
  contour: Point[]
  path: ReturnType<typeof contourPath>
  area: number
  bbox: {
    minX: number
    maxX: number
    minY: number
    maxY: number
  }
}

interface CleanupWallColumn {
  deepest: CleanupWallContour
}

function roundedKey(value: number): string {
  return (Math.round(value * KEY_SCALE) / KEY_SCALE).toFixed(3)
}

function trimClosedLoop(points: Point[]): Point[] {
  if (points.length > 1) {
    const first = points[0]
    const last = points[points.length - 1]
    if (Math.abs(first.x - last.x) <= 1e-9 && Math.abs(first.y - last.y) <= 1e-9) {
      return points.slice(0, -1)
    }
  }
  return points
}

function bestRotatedKey(keys: string[]): string {
  if (keys.length === 0) {
    return ''
  }

  let best = ''
  for (let start = 0; start < keys.length; start += 1) {
    const rotated = keys.slice(start).concat(keys.slice(0, start)).join('|')
    if (best === '' || rotated < best) {
      best = rotated
    }
  }
  return best
}

function contourKey(points: Point[]): string {
  const trimmed = trimClosedLoop(points)
  const keys = trimmed.map((point) => `${roundedKey(point.x)},${roundedKey(point.y)}`)
  const forward = bestRotatedKey(keys)
  const reversed = bestRotatedKey([...keys].reverse())
  return forward < reversed ? forward : reversed
}

function contourPath(points: Point[]) {
  return toClipperPath(normalizeWinding(trimClosedLoop(points), false), DEFAULT_CLIPPER_SCALE)
}

function regionAreaPaths(region: ResolvedPocketRegion) {
  return differenceClipperPaths(
    [contourPath(region.outer)],
    region.islands.map((island) => contourPath(island)),
  )
}

function contourOverlapScore(left: CleanupWallContour, right: CleanupWallContour): number {
  let areaScore = 0
  if (left.area > 1e-6 && right.area > 1e-6) {
    const intersectionArea = Math.abs(calculateClipperArea(
      intersectClipperPaths([left.path], [right.path]),
    ))
    if (intersectionArea > 1e-6) {
      const unionArea = left.area + right.area - intersectionArea
      areaScore = unionArea > 1e-6 ? intersectionArea / unionArea : 0
    }
  }

  const intersectionWidth = Math.max(0, Math.min(left.bbox.maxX, right.bbox.maxX) - Math.max(left.bbox.minX, right.bbox.minX))
  const intersectionHeight = Math.max(0, Math.min(left.bbox.maxY, right.bbox.maxY) - Math.max(left.bbox.minY, right.bbox.minY))
  const intersectionArea = intersectionWidth * intersectionHeight
  const leftBBoxArea = Math.max(0, left.bbox.maxX - left.bbox.minX) * Math.max(0, left.bbox.maxY - left.bbox.minY)
  const rightBBoxArea = Math.max(0, right.bbox.maxX - right.bbox.minX) * Math.max(0, right.bbox.maxY - right.bbox.minY)
  const bboxUnionArea = leftBBoxArea + rightBBoxArea - intersectionArea
  const bboxScore = bboxUnionArea > 1e-9 ? intersectionArea / bboxUnionArea : 0

  return Math.max(areaScore, bboxScore)
}

function pushMapArrayValue<T>(map: Map<number, T[]>, z: number, value: T): void {
  const existing = map.get(z)
  if (existing) {
    existing.push(value)
    return
  }
  map.set(z, [value])
}

function regionIntersectsTargetFootprint(
  region: ResolvedPocketRegion,
  targetFootprintPaths: ClipperPath[],
): boolean {
  if (targetFootprintPaths.length === 0) {
    return false
  }
  const intersection = intersectClipperPaths(regionAreaPaths(region), targetFootprintPaths)
  return Math.abs(calculateClipperArea(intersection)) > 1e-6
}

function wallContoursForRegion(
  region: ResolvedPocketRegion,
  targetFootprintPaths: ClipperPath[],
): Point[][] {
  const regionTouchesTargetInterior = regionIntersectsTargetFootprint(region, targetFootprintPaths)
  return regionTouchesTargetInterior
    ? [
      region.outer,
      ...region.islands,
    ].filter((contour) => contour.length >= 3)
    : region.islands.length > 0
      ? region.islands.filter((contour) => contour.length >= 3)
      : region.outer.length >= 3
        ? [region.outer]
        : []
}

function collectCleanupWallContours(
  descendingLevels: Resolved3DSurfaceLevel[],
  targetFootprintPaths: ClipperPath[],
): Map<number, Point[][]> {
  const wallContoursByZ = new Map<number, Point[][]>()
  const columns: CleanupWallColumn[] = []

  for (const level of descendingLevels) {
    const uniqueContours = new Map<string, CleanupWallContour>()
    for (const region of level.insetRegions) {
      for (const contour of wallContoursForRegion(region, targetFootprintPaths)) {
        const key = contourKey(contour)
        if (uniqueContours.has(key)) {
          continue
        }
        const path = contourPath(contour)
        const xs = contour.map((point) => point.x)
        const ys = contour.map((point) => point.y)
        uniqueContours.set(key, {
          z: level.z,
          contour,
          path,
          area: Math.abs(calculateClipperArea([path])),
          bbox: {
            minX: Math.min(...xs),
            maxX: Math.max(...xs),
            minY: Math.min(...ys),
            maxY: Math.max(...ys),
          },
        })
      }
    }

    const levelContours = [...uniqueContours.values()]
    const candidateMatches: Array<{ columnIndex: number; contourIndex: number; score: number }> = []
    for (let contourIndex = 0; contourIndex < levelContours.length; contourIndex += 1) {
      const contour = levelContours[contourIndex]
      for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
        const score = contourOverlapScore(contour, columns[columnIndex].deepest)
        if (score >= WALL_COLUMN_OVERLAP_THRESHOLD) {
          candidateMatches.push({ columnIndex, contourIndex, score })
        }
      }
    }

    candidateMatches.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score
      }
      if (right.contourIndex !== left.contourIndex) {
        return right.contourIndex - left.contourIndex
      }
      return right.columnIndex - left.columnIndex
    })

    const assignedColumns = new Set<number>()
    const assignedContours = new Set<number>()
    for (const match of candidateMatches) {
      if (assignedColumns.has(match.columnIndex) || assignedContours.has(match.contourIndex)) {
        continue
      }

      columns[match.columnIndex].deepest = levelContours[match.contourIndex]
      assignedColumns.add(match.columnIndex)
      assignedContours.add(match.contourIndex)
    }

    for (let contourIndex = 0; contourIndex < levelContours.length; contourIndex += 1) {
      if (assignedContours.has(contourIndex)) {
        continue
      }
      columns.push({
        deepest: levelContours[contourIndex],
      })
    }
  }

  for (const column of columns) {
    pushMapArrayValue(wallContoursByZ, column.deepest.z, column.deepest.contour)
  }

  return wallContoursByZ
}

export function generateFinishSurfaceCleanupToolpath(
  project: Project,
  operation: Operation,
): PocketToolpathResult {
  const resolvedResult = resolve3DSurfaceStepdown(project, operation, {
    operationLabel: '3D surface cleanup',
  })
  if (!resolvedResult.ok) {
    return resolvedResult.result
  }

  if (!operation.finishWalls && !operation.finishFloor) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['Finish operation has both Finish Walls and Finish Floor disabled'],
      bounds: null,
      stepLevels: [],
    }
  }

  const { resolved } = resolvedResult
  const warnings = [...resolved.warnings]
  const descendingLevels = [...resolved.levels].sort((a, b) => b.z - a.z)
  const splitTargets = operation.target.source === 'features'
    ? splitFeatureTargets(project, operation.target.featureIds)
    : null
  const modelFeature = splitTargets?.machiningFeatures.find(
    (feature) => feature.operation === 'model' && feature.kind === 'stl',
  ) ?? null
  const modelFootprintPaths = modelFeature ? featureFootprintPaths(modelFeature) : []
  const intersectingAddPaths = modelFeature
    ? relatedIntersectingAddFeatures(
      project,
      new Set(operation.target.source === 'features' ? operation.target.featureIds : []),
      modelFootprintPaths,
    ).flatMap((feature) => feature.paths)
    : []
  const targetFootprintPaths = unionClipperPaths([
    ...modelFootprintPaths,
    ...intersectingAddPaths,
  ])

  const wallContoursByZ = operation.finishWalls
    ? collectCleanupWallContours(
      descendingLevels,
      targetFootprintPaths,
    )
    : new Map<number, Point[][]>()

  const floorRegionsByZ = new Map<number, ResolvedPocketRegion[]>()
  if (operation.finishFloor) {
    let coveredByDeeper: ReturnType<typeof regionAreaPaths> = []
    for (const level of [...resolved.levels].sort((a, b) => a.z - b.z)) {
      if (!level.isCriticalFloorLevel) {
        continue
      }

      const currentLevelPaths = unionClipperPaths(level.insetRegions.flatMap((region) => regionAreaPaths(region)))
      const residualPaths = coveredByDeeper.length > 0
        ? differenceClipperPaths(currentLevelPaths, coveredByDeeper)
        : currentLevelPaths

      if (residualPaths.length > 0) {
        const residualRegions = polyTreeToRegions(executeDifference(residualPaths, []), [], [])
        for (const region of residualRegions) {
          if (!regionIntersectsTargetFootprint(region, targetFootprintPaths)) {
            continue
          }
          pushMapArrayValue(floorRegionsByZ, level.z, region)
        }
      }

      coveredByDeeper = unionClipperPaths([
        ...coveredByDeeper,
        ...currentLevelPaths,
      ])
    }
  }

  const stepLevels = new Set<number>([
    ...wallContoursByZ.keys(),
    ...floorRegionsByZ.keys(),
  ])
  if (stepLevels.size === 0) {
    warnings.push('No cleanup contours available for this 3D surface operation')
    return {
      operationId: resolved.operationId,
      moves: [],
      warnings,
      bounds: null,
      stepLevels: [],
    }
  }

  const sortedLevels = [...stepLevels].sort((a, b) => b - a)
  const moves: ToolpathMove[] = []
  let currentPosition: ToolpathPoint | null = null

  for (const z of sortedLevels) {
    const wallContours = wallContoursByZ.get(z) ?? []
    if (wallContours.length > 0) {
      const directedContours = applyContourDirection(wallContours, resolved.direction)
      const orderedContours = orderClosedContoursGreedy(
        directedContours,
        currentPosition ? { x: currentPosition.x, y: currentPosition.y } : null,
      )

      for (const contour of orderedContours) {
        const entryPoint = contourStartPoint(contour, z)
        currentPosition = transitionToCutEntry(
          moves,
          currentPosition,
          entryPoint,
          resolved.safeZ,
          resolved.maxLinkDistance,
        )
        const cutMoves = toClosedCutMoves(contour, z)
        moves.push(...cutMoves)
        currentPosition = cutMoves.at(-1)?.to ?? currentPosition
      }

      currentPosition = retractToSafe(moves, currentPosition, resolved.safeZ)
    }

    const floorRegions = floorRegionsByZ.get(z) ?? []
    if (floorRegions.length === 0) {
      continue
    }

    const floorContours = operation.pocketPattern === 'offset'
      ? applyContourDirection(
        buildPocketFloorContours(floorRegions, 0, resolved.effectiveStepover),
        resolved.direction,
      )
      : []
    const floorSegments = operation.pocketPattern === 'parallel'
      ? buildPocketParallelSegments(floorRegions, resolved.effectiveStepover, operation.pocketAngle)
      : []

    const orderedFloorContours = orderClosedContoursGreedy(
      floorContours,
      currentPosition ? { x: currentPosition.x, y: currentPosition.y } : null,
    )
    for (const contour of orderedFloorContours) {
      const entryPoint = contourStartPoint(contour, z)
      currentPosition = transitionToCutEntry(
        moves,
        currentPosition,
        entryPoint,
        resolved.safeZ,
        resolved.maxLinkDistance,
      )
      const cutMoves = toClosedCutMoves(contour, z)
      moves.push(...cutMoves)
      currentPosition = cutMoves.at(-1)?.to ?? currentPosition
    }

    const orderedFloorSegments = orderOpenSegmentsGreedy(
      floorSegments,
      currentPosition ? { x: currentPosition.x, y: currentPosition.y } : null,
    )
    for (const segment of orderedFloorSegments) {
      const entryPoint = contourStartPoint(segment, z)
      currentPosition = transitionToCutEntry(
        moves,
        currentPosition,
        entryPoint,
        resolved.safeZ,
        resolved.maxLinkDistance,
      )
      const cutMoves = toOpenCutMoves(segment, z)
      moves.push(...cutMoves)
      currentPosition = cutMoves.at(-1)?.to ?? currentPosition
    }

    currentPosition = retractToSafe(moves, currentPosition, resolved.safeZ)
  }

  if (currentPosition && currentPosition.z !== resolved.safeZ) {
    retractToSafe(moves, currentPosition, resolved.safeZ)
  }

  let bounds: ToolpathBounds | null = null
  for (const move of moves) {
    bounds = updateBounds(bounds, move.from)
    bounds = updateBounds(bounds, move.to)
  }

  return {
    operationId: resolved.operationId,
    moves,
    warnings,
    bounds,
    stepLevels: sortedLevels,
  }
}
