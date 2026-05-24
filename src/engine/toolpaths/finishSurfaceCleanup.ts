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
  buildContourLoops,
  buildInsetRegions,
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
  pointInClipperPaths,
  relatedSubtractFeatures,
  relatedIntersectingAddFeatures,
  unionClipperPaths,
} from './modelProtection'
import { splitFeatureTargets } from './regions'
import { resolve3DSurfaceStepdown } from './surfaceStepdown3d'
import type { Resolved3DSurfaceLevel } from './surfaceStepdown3d'
import type { ClipperPath } from './types'

const KEY_SCALE = 1_000
const CLEANUP_SAMPLE_LEVEL_COUNT = 32
const WALL_COLUMN_OVERLAP_THRESHOLD = 0.5
const WALL_PROBE_EPSILON = 1e-3

interface CleanupWallPath {
  z: number
  points: Point[]
  closed: boolean
  path: ReturnType<typeof contourPath> | null
  area: number
  bbox: {
    minX: number
    maxX: number
    minY: number
    maxY: number
  }
}

interface CleanupWallColumn {
  deepest: CleanupWallPath
}

interface CleanupFloorOffsetPasses {
  contours: Point[][]
  segments: Point[][]
}

interface CleanupLevelContext {
  targetFootprintPaths: ClipperPath[]
}

function resolveCleanupSamplingStepdown(modelTopZ: number, effectiveBottom: number): number {
  const machinableHeight = Math.max(modelTopZ - effectiveBottom, 0)
  return Math.max(machinableHeight / CLEANUP_SAMPLE_LEVEL_COUNT, 1 / DEFAULT_CLIPPER_SCALE)
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

function openPathKey(points: Point[]): string {
  const trimmed = trimClosedLoop(points)
  const keys = trimmed.map((point) => `${roundedKey(point.x)},${roundedKey(point.y)}`)
  const forward = keys.join('|')
  const reversed = [...keys].reverse().join('|')
  return forward < reversed ? forward : reversed
}

function pathKey(points: Point[], closed: boolean): string {
  return closed ? contourKey(points) : openPathKey(points)
}

function segmentKey(from: Point, to: Point): string {
  const forward = `${roundedKey(from.x)},${roundedKey(from.y)}|${roundedKey(to.x)},${roundedKey(to.y)}`
  const reverse = `${roundedKey(to.x)},${roundedKey(to.y)}|${roundedKey(from.x)},${roundedKey(from.y)}`
  return forward < reverse ? forward : reverse
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

function contourOverlapScore(left: CleanupWallPath, right: CleanupWallPath): number {
  let areaScore = 0
  if (left.path && right.path && left.area > 1e-6 && right.area > 1e-6) {
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

function contourBBox(points: Point[]) {
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  }
}

function simplifyOpenPath(points: Point[]): Point[] {
  if (points.length <= 2) {
    return points
  }

  const simplified = [points[0]]
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index]
    const previous = simplified[simplified.length - 1]
    if (Math.abs(previous.x - point.x) <= 1e-9 && Math.abs(previous.y - point.y) <= 1e-9) {
      continue
    }
    simplified.push(point)
  }
  return simplified
}

function extractPathsFromMask(trimmed: Point[], selected: boolean[]): Array<{ points: Point[]; closed: boolean }> {
  if (trimmed.length < 2 || selected.length !== trimmed.length) {
    return []
  }

  if (selected.every(Boolean) && trimmed.length >= 3) {
    return [{ points: trimmed, closed: true }]
  }

  const firstGapIndex = selected.findIndex((keep) => !keep)
  if (firstGapIndex === -1) {
    return []
  }

  const extracted: Array<{ points: Point[]; closed: boolean }> = []
  let current: Point[] = []

  for (let offset = 1; offset <= trimmed.length; offset += 1) {
    const segmentIndex = (firstGapIndex + offset) % trimmed.length
    if (selected[segmentIndex]) {
      if (current.length === 0) {
        current.push(trimmed[segmentIndex])
      }
      current.push(trimmed[(segmentIndex + 1) % trimmed.length])
      continue
    }

    const simplified = simplifyOpenPath(current)
    if (simplified.length >= 2) {
      extracted.push({ points: simplified, closed: false })
    }
    current = []
  }

  return extracted
}

function classifyTargetSide(
  from: Point,
  to: Point,
  targetFootprintPaths: ClipperPath[],
  probeDistance: number,
): 'left' | 'right' | 'none' | 'both' {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy)
  if (length <= 1e-9 || targetFootprintPaths.length === 0) {
    return 'none'
  }

  const midpoint = {
    x: (from.x + to.x) * 0.5,
    y: (from.y + to.y) * 0.5,
  }
  const leftNormal = { x: -dy / length, y: dx / length }
  const rightNormal = { x: dy / length, y: -dx / length }
  const leftProbe = {
    x: midpoint.x + leftNormal.x * probeDistance,
    y: midpoint.y + leftNormal.y * probeDistance,
  }
  const rightProbe = {
    x: midpoint.x + rightNormal.x * probeDistance,
    y: midpoint.y + rightNormal.y * probeDistance,
  }
  const leftInside = pointInClipperPaths(targetFootprintPaths, leftProbe)
  const rightInside = pointInClipperPaths(targetFootprintPaths, rightProbe)

  if (leftInside && rightInside) return 'both'
  if (leftInside) return 'left'
  if (rightInside) return 'right'
  return 'none'
}

function extractTargetFacingPaths(
  contour: Point[],
  targetFootprintPaths: ClipperPath[],
  probeDistance: number,
): Array<{ points: Point[]; closed: boolean }> {
  const trimmed = trimClosedLoop(contour)
  if (trimmed.length < 2) {
    return []
  }

  const segmentSides = trimmed.map((point, index) => {
    const next = trimmed[(index + 1) % trimmed.length]
    return classifyTargetSide(point, next, targetFootprintPaths, probeDistance)
  })

  const leftCount = segmentSides.filter((side) => side === 'left').length
  const rightCount = segmentSides.filter((side) => side === 'right').length
  const bothCount = segmentSides.filter((side) => side === 'both').length

  if (leftCount === 0 && rightCount === 0) {
    return bothCount > 0 && trimmed.length >= 3
      ? [{ points: trimmed, closed: true }]
      : []
  }

  const extracted = new Map<string, { points: Point[]; closed: boolean }>()
  const selectedMasks = leftCount === rightCount
    ? [
      segmentSides.map((side) => side === 'left' || side === 'both'),
      segmentSides.map((side) => side === 'right' || side === 'both'),
    ]
    : [segmentSides.map((side) => side === (leftCount > rightCount ? 'left' : 'right') || side === 'both')]

  for (const selected of selectedMasks) {
    for (const path of extractPathsFromMask(trimmed, selected)) {
      extracted.set(pathKey(path.points, path.closed), path)
    }
  }

  return [...extracted.values()]
}

function splitContourBySuppressedSegments(
  contour: Point[],
  suppressedSegments: ReadonlySet<string>,
): Array<{ points: Point[]; closed: boolean }> {
  const trimmed = trimClosedLoop(contour)
  if (trimmed.length < 2) {
    return []
  }

  if (suppressedSegments.size === 0) {
    return trimmed.length >= 3 ? [{ points: trimmed, closed: true }] : []
  }

  const selected = trimmed.map((point, index) => {
    const next = trimmed[(index + 1) % trimmed.length]
    return !suppressedSegments.has(segmentKey(point, next))
  })

  return extractPathsFromMask(trimmed, selected)
}

function buildCleanupFloorOffsetPasses(
  regions: ResolvedPocketRegion[],
  stepoverDistance: number,
  suppressedBoundarySegments: ReadonlySet<string>,
): CleanupFloorOffsetPasses {
  const uniqueContours = new Map<string, Point[]>()
  const uniqueSegments = new Map<string, Point[]>()

  const pushPass = (pass: { points: Point[]; closed: boolean }): void => {
    const key = pathKey(pass.points, pass.closed)
    if (pass.closed) {
      if (!uniqueContours.has(key)) {
        uniqueContours.set(key, pass.points)
      }
      return
    }
    if (!uniqueSegments.has(key)) {
      uniqueSegments.set(key, pass.points)
    }
  }

  const visitRegion = (region: ResolvedPocketRegion, depth: number): void => {
    const boundaryContours = [region.outer, ...region.islands].filter((points) => points.length >= 3)
    for (const contour of boundaryContours) {
      if (depth === 0) {
        for (const pass of splitContourBySuppressedSegments(contour, suppressedBoundarySegments)) {
          pushPass(pass)
        }
      } else {
        pushPass({ points: contour, closed: true })
      }
    }

    for (const child of buildInsetRegions(region, stepoverDistance)) {
      visitRegion(child, depth + 1)
    }
  }

  for (const region of regions) {
    visitRegion(region, 0)
  }

  return {
    contours: [...uniqueContours.values()],
    segments: [...uniqueSegments.values()],
  }
}

function collectCleanupWallPaths(
  descendingLevels: Resolved3DSurfaceLevel[],
  levelContexts: ReadonlyMap<number, CleanupLevelContext>,
  probeDistance: number,
  direction: Operation['cutDirection'],
): Map<number, CleanupWallPath[]> {
  const wallPathsByZ = new Map<number, CleanupWallPath[]>()
  const columns: CleanupWallColumn[] = []

  for (const level of descendingLevels) {
    const levelContext = levelContexts.get(level.z)
    const targetFootprintPaths = levelContext?.targetFootprintPaths ?? []
    const uniqueContours = new Map<string, CleanupWallPath>()
    for (const region of level.insetRegions) {
      for (const rawContour of buildContourLoops([region])) {
        const contour = applyContourDirection([rawContour], direction ?? 'conventional')[0]
        const extractedPaths = extractTargetFacingPaths(
          contour,
          targetFootprintPaths,
          probeDistance,
        )
        for (const extractedPath of extractedPaths) {
          const key = pathKey(extractedPath.points, extractedPath.closed)
          if (uniqueContours.has(key)) {
            continue
          }

          const bbox = contourBBox(extractedPath.points)
          const path = extractedPath.closed ? contourPath(extractedPath.points) : null
          uniqueContours.set(key, {
            z: level.z,
            points: extractedPath.points,
            closed: extractedPath.closed,
            path,
            area: path ? Math.abs(calculateClipperArea([path])) : 0,
            bbox,
          })
        }
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
    pushMapArrayValue(wallPathsByZ, column.deepest.z, column.deepest)
  }

  for (const [z, paths] of wallPathsByZ.entries()) {
    wallPathsByZ.set(z, pruneDuplicateWallPaths(paths))
  }

  return wallPathsByZ
}

function pruneDuplicateWallPaths(paths: CleanupWallPath[]): CleanupWallPath[] {
  const kept: CleanupWallPath[] = []
  const seenKeys = new Set<string>()
  const sorted = [...paths].sort((left, right) => {
    if (left.closed !== right.closed) {
      return left.closed ? -1 : 1
    }
    return left.area - right.area
  })

  for (const candidate of sorted) {
    const candidateKey = pathKey(candidate.points, candidate.closed)
    if (seenKeys.has(candidateKey)) {
      continue
    }
    const duplicate = kept.some((existing) => {
      if (!candidate.closed || !existing.closed) {
        return false
      }
      if (!candidate.path || !existing.path) {
        return false
      }
      return contourOverlapScore(candidate, existing) >= 0.98
    })
    if (!duplicate) {
      seenKeys.add(candidateKey)
      kept.push(candidate)
    }
  }

  return kept
}

export function generateFinishSurfaceCleanupToolpath(
  project: Project,
  operation: Operation,
): PocketToolpathResult {
  const resolvedResult = resolve3DSurfaceStepdown(project, operation, {
    operationLabel: '3D surface cleanup',
    resolveStepdown: ({ modelTopZ, effectiveBottom }) => resolveCleanupSamplingStepdown(modelTopZ, effectiveBottom),
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
  if (operation.stockToLeaveRadial > 0 || operation.stockToLeaveAxial > 0) {
    warnings.push('3D surface cleanup uses stock-to-leave values; non-zero radial or axial leave offsets cleanup from the final surface')
  }
  const descendingLevels = [...resolved.levels].sort((a, b) => b.z - a.z)
  const splitTargets = operation.target.source === 'features'
    ? splitFeatureTargets(project, operation.target.featureIds)
    : null
  const modelFeature = splitTargets?.machiningFeatures.find(
    (feature) => feature.operation === 'model' && feature.kind === 'stl',
  ) ?? null
  const modelFootprintPaths = modelFeature ? featureFootprintPaths(modelFeature) : []
  const relatedSubtracts = modelFeature
    ? relatedSubtractFeatures(
      project,
      new Set(operation.target.source === 'features' ? operation.target.featureIds : []),
      modelFootprintPaths,
    )
    : []
  const intersectingAdds = modelFeature
    ? relatedIntersectingAddFeatures(
      project,
      new Set(operation.target.source === 'features' ? operation.target.featureIds : []),
      modelFootprintPaths,
    )
    : []
  const levelContexts = new Map<number, CleanupLevelContext>()
  for (const level of resolved.levels) {
    const activeSubtractPaths = unionClipperPaths(
      relatedSubtracts
        .filter((subtract) => level.z <= subtract.topZ + 1e-9 && level.z >= subtract.bottomZ - 1e-9)
        .flatMap((subtract) => subtract.paths),
    )
    const activeIntersectingAddPaths = intersectingAdds
      .filter((feature) => level.z <= feature.topZ + 1e-9 && level.z >= feature.bottomZ - 1e-9)
      .flatMap((feature) => feature.paths)
    levelContexts.set(level.z, {
      targetFootprintPaths: unionClipperPaths([
        ...modelFootprintPaths,
        ...activeSubtractPaths,
        ...activeIntersectingAddPaths,
      ]),
    })
  }

  const wallProbeDistance = resolved.tool.radius + Math.max(0, operation.stockToLeaveRadial) + WALL_PROBE_EPSILON
  const wallPathsByZ = operation.finishWalls
    ? collectCleanupWallPaths(
      descendingLevels,
      levelContexts,
      wallProbeDistance,
      resolved.direction,
    )
    : new Map<number, CleanupWallPath[]>()

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
        const levelTargetFootprintPaths = levelContexts.get(level.z)?.targetFootprintPaths ?? []
        for (const region of residualRegions) {
          if (!regionIntersectsTargetFootprint(region, levelTargetFootprintPaths)) {
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
    ...wallPathsByZ.keys(),
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
    const wallPaths = wallPathsByZ.get(z) ?? []
    const wallContours = wallPaths
      .filter((path) => path.closed)
      .map((path) => path.points)
    const wallSegments = wallPaths
      .filter((path) => !path.closed)
      .map((path) => path.points)

    if (wallContours.length > 0) {
      const orderedContours = orderClosedContoursGreedy(
        wallContours,
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

    if (wallSegments.length > 0) {
      const orderedSegments = orderOpenSegmentsGreedy(
        wallSegments,
        currentPosition ? { x: currentPosition.x, y: currentPosition.y } : null,
      )
      for (const segment of orderedSegments) {
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

    const floorRegions = floorRegionsByZ.get(z) ?? []
    if (floorRegions.length === 0) {
      continue
    }

    const suppressedWallSegments = new Set<string>()
    for (const wallPath of wallPaths) {
      const trimmed = trimClosedLoop(wallPath.points)
      if (trimmed.length < 2) {
        continue
      }
      const segmentCount = wallPath.closed ? trimmed.length : trimmed.length - 1
      for (let index = 0; index < segmentCount; index += 1) {
        const nextIndex = wallPath.closed ? (index + 1) % trimmed.length : index + 1
        suppressedWallSegments.add(segmentKey(trimmed[index], trimmed[nextIndex]))
      }
    }

    const offsetFloorPasses = operation.pocketPattern === 'offset'
      ? buildCleanupFloorOffsetPasses(floorRegions, resolved.effectiveStepover, suppressedWallSegments)
      : { contours: [], segments: [] }
    const floorContours = operation.pocketPattern === 'offset'
      ? applyContourDirection(offsetFloorPasses.contours, resolved.direction)
      : []
    const floorSegments = operation.pocketPattern === 'parallel'
      ? buildPocketParallelSegments(floorRegions, resolved.effectiveStepover, operation.pocketAngle)
      : operation.pocketPattern === 'offset'
        ? applyContourDirection(offsetFloorPasses.segments, resolved.direction)
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
