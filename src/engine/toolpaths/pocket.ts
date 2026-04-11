import ClipperLib from 'clipper-lib'
import type { Operation, Point, Project } from '../../types/project'
import type {
  ClipperPath,
  PocketToolpathResult,
  ResolvedPocketBand,
  ResolvedPocketRegion,
  ToolpathBounds,
  ToolpathMove,
  ToolpathPoint,
} from './types'
import {
  DEFAULT_CLIPPER_SCALE,
  fromClipperPath,
  getOperationSafeZ,
  normalizeWinding,
  normalizeToolForProject,
  resolveFeatureZSpan,
  toClipperPath,
} from './geometry'
import { resolvePocketRegions } from './resolver'

interface PolyTreeNode {
  IsHole(): boolean
  Contour(): ClipperPath
  Childs?: () => PolyTreeNode[]
  m_Childs?: PolyTreeNode[]
}

function getChildren(node: PolyTreeNode): PolyTreeNode[] {
  return node.Childs ? node.Childs() : (node.m_Childs ?? [])
}

/**
 * Remove consecutive vertices that are closer than minDist (in integer Clipper units).
 * Reduces noise introduced by Clipper offset operations.
 */
function cleanClipperPath(path: ClipperPath, minDist: number): ClipperPath {
  if (path.length === 0) return path
  const out: ClipperPath = [path[0]]
  for (let i = 1; i < path.length; i++) {
    const prev = out[out.length - 1]
    const cur = path[i]
    const dx = cur.X - prev.X
    const dy = cur.Y - prev.Y
    if (Math.sqrt(dx * dx + dy * dy) >= minDist) {
      out.push(cur)
    }
  }
  return out
}

function offsetPaths(
  paths: ClipperPath[],
  delta: number,
  joinType: number = ClipperLib.JoinType.jtMiter,
): ClipperPath[] {
  if (paths.length === 0) {
    return []
  }

  const offset = new ClipperLib.ClipperOffset()
  offset.AddPaths(paths, joinType, ClipperLib.EndType.etClosedPolygon)
  const solution = new ClipperLib.Paths()
  offset.Execute(solution, delta)
  // Filter near-duplicate vertices (threshold: 1 Clipper unit ≈ 1/scale project units)
  return (solution as ClipperPath[]).map((path) => cleanClipperPath(path, 1.0))
}

export function executeDifference(subjectPaths: ClipperPath[], clipPaths: ClipperPath[]): PolyTreeNode {
  const clipper = new ClipperLib.Clipper()
  if (subjectPaths.length > 0) {
    clipper.AddPaths(subjectPaths, ClipperLib.PolyType.ptSubject, true)
  }
  if (clipPaths.length > 0) {
    clipper.AddPaths(clipPaths, ClipperLib.PolyType.ptClip, true)
  }

  const polyTree = new ClipperLib.PolyTree()
  clipper.Execute(
    ClipperLib.ClipType.ctDifference,
    polyTree,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  )

  return polyTree as PolyTreeNode
}

export function polyTreeToRegions(
  node: PolyTreeNode,
  targetFeatureIds: string[],
  islandFeatureIds: string[],
  scale = DEFAULT_CLIPPER_SCALE,
): ResolvedPocketRegion[] {
  const regions: ResolvedPocketRegion[] = []
  const contour = node.Contour()

  if (contour.length > 0 && !node.IsHole()) {
    const children = getChildren(node)
    const islands = children
      .filter((child) => child.IsHole())
      .map((child) => fromClipperPath(child.Contour(), scale))

    regions.push({
      outer: fromClipperPath(contour, scale),
      islands,
      targetFeatureIds,
      islandFeatureIds,
    })
  }

  for (const child of getChildren(node)) {
    regions.push(...polyTreeToRegions(child, targetFeatureIds, islandFeatureIds, scale))
  }

  return regions
}

export function contourStartPoint(points: Point[], z: number): ToolpathPoint {
  const first = points[0] ?? { x: 0, y: 0 }
  return { x: first.x, y: first.y, z }
}

export function toClosedCutMoves(points: Point[], z: number): ToolpathMove[] {
  if (points.length < 2) {
    return []
  }

  const moves: ToolpathMove[] = []
  for (let index = 0; index < points.length - 1; index += 1) {
    moves.push({
      kind: 'cut',
      from: { x: points[index].x, y: points[index].y, z },
      to: { x: points[index + 1].x, y: points[index + 1].y, z },
    })
  }

  const first = points[0]
  const last = points[points.length - 1]
  if (first.x !== last.x || first.y !== last.y) {
    moves.push({
      kind: 'cut',
      from: { x: last.x, y: last.y, z },
      to: { x: first.x, y: first.y, z },
    })
  }

  return moves
}

export function pushRapidAndPlunge(
  moves: ToolpathMove[],
  from: ToolpathPoint | null,
  toXY: ToolpathPoint,
  safeZ: number,
): ToolpathPoint {
  const start = from ?? { x: toXY.x, y: toXY.y, z: safeZ }

  if (!from || from.x !== toXY.x || from.y !== toXY.y || from.z !== safeZ) {
    moves.push({
      kind: 'rapid',
      from: start,
      to: { x: toXY.x, y: toXY.y, z: safeZ },
    })
  }

  moves.push({
    kind: 'plunge',
    from: { x: toXY.x, y: toXY.y, z: safeZ },
    to: toXY,
  })

  return toXY
}

export function retractToSafe(moves: ToolpathMove[], from: ToolpathPoint | null, safeZ: number): ToolpathPoint | null {
  if (!from) {
    return null
  }

  const safePoint = { x: from.x, y: from.y, z: safeZ }
  if (from.z !== safeZ) {
    moves.push({
      kind: 'rapid',
      from,
      to: safePoint,
    })
  }
  return safePoint
}

export function transitionToCutEntry(
  moves: ToolpathMove[],
  from: ToolpathPoint | null,
  toXY: ToolpathPoint,
  safeZ: number,
  maxLinkDistance: number,
): ToolpathPoint {
  if (from && from.z === toXY.z) {
    const dx = toXY.x - from.x
    const dy = toXY.y - from.y
    const distance = Math.hypot(dx, dy)

    if (distance === 0) {
      return toXY
    }

    if (distance <= maxLinkDistance) {
      moves.push({
        kind: 'cut',
        from,
        to: toXY,
      })
      return toXY
    }
  }

  const safePosition = retractToSafe(moves, from, safeZ)
  return pushRapidAndPlunge(moves, safePosition, toXY, safeZ)
}

export function generateStepLevels(topZ: number, bottomZ: number, stepdown: number): number[] {
  if (!(stepdown > 0)) {
    return [bottomZ]
  }

  const descending = bottomZ < topZ
  if (!descending) {
    return [bottomZ]
  }

  const levels: number[] = []
  let current = topZ
  while (current - stepdown > bottomZ) {
    current -= stepdown
    levels.push(current)
  }
  levels.push(bottomZ)
  return levels
}

export function resolveBandBottomZ(band: ResolvedPocketBand, operation: Operation): number | null {
  const descending = band.bottomZ < band.topZ
  const axialLeave = Math.max(0, operation.stockToLeaveAxial)
  const effectiveBottom = descending
    ? band.bottomZ + axialLeave
    : band.bottomZ - axialLeave

  if (descending && effectiveBottom >= band.topZ) {
    return null
  }

  if (!descending && effectiveBottom <= band.topZ) {
    return null
  }

  return effectiveBottom
}

export function updateBounds(bounds: ToolpathBounds | null, point: ToolpathPoint): ToolpathBounds {
  if (!bounds) {
    return {
      minX: point.x,
      minY: point.y,
      minZ: point.z,
      maxX: point.x,
      maxY: point.y,
      maxZ: point.z,
    }
  }

  return {
    minX: Math.min(bounds.minX, point.x),
    minY: Math.min(bounds.minY, point.y),
    minZ: Math.min(bounds.minZ, point.z),
    maxX: Math.max(bounds.maxX, point.x),
    maxY: Math.max(bounds.maxY, point.y),
    maxZ: Math.max(bounds.maxZ, point.z),
  }
}

export function buildInsetRegions(
  region: ResolvedPocketRegion,
  delta: number,
  joinType: number = ClipperLib.JoinType.jtMiter,
): ResolvedPocketRegion[] {
  const scale = DEFAULT_CLIPPER_SCALE
  const outerPath = toClipperPath(normalizeWinding(region.outer, false), scale)
  const islandPaths = region.islands.map((island) => toClipperPath(normalizeWinding(island, false), scale))

  const insetOuterPaths = offsetPaths([outerPath], -delta * scale, joinType)
  if (insetOuterPaths.length === 0) {
    return []
  }

  const expandedIslandPaths = offsetPaths(islandPaths, delta * scale, joinType)
  const clipped = executeDifference(insetOuterPaths, expandedIslandPaths)
  return polyTreeToRegions(clipped, region.targetFeatureIds, region.islandFeatureIds, scale)
    .filter((nextRegion) => nextRegion.outer.length >= 3)
}

export function buildContourLoops(regions: ResolvedPocketRegion[]): Point[][] {
  const contours: Point[][] = []

  for (const region of regions) {
    if (region.outer.length >= 3) {
      contours.push(region.outer)
    }

    for (const island of region.islands) {
      if (island.length >= 3) {
        contours.push(island)
      }
    }
  }

  return contours
}

export function buildOuterContours(regions: ResolvedPocketRegion[]): Point[][] {
  return regions
    .map((region) => region.outer)
    .filter((contour) => contour.length >= 3)
}

export function buildPocketFloorContours(
  regions: ResolvedPocketRegion[],
  initialInset: number,
  stepoverDistance: number,
): Point[][] {
  const contours: Point[][] = []
  const minStepover = 1 / DEFAULT_CLIPPER_SCALE
  const effectiveStepover = Math.max(stepoverDistance, minStepover)
  let currentRegions = regions.flatMap((region) => buildInsetRegions(region, initialInset))

  // Floor cleanup should not implicitly double as a wall-finish contour.
  // Start one stepover inside the finish boundary so "Finish Floor" can be
  // used independently from "Finish Walls".
  currentRegions = currentRegions.flatMap((region) => buildInsetRegions(region, effectiveStepover))

  while (currentRegions.length > 0) {
    const loops = buildOuterContours(currentRegions)
    if (loops.length === 0) {
      break
    }

    contours.push(...loops)
    currentRegions = currentRegions.flatMap((region) => buildInsetRegions(region, effectiveStepover))
  }

  return contours
}

function pointEpsilonEqual(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) <= 1e-9 && Math.abs(a.y - b.y) <= 1e-9
}

function polygonYBounds(points: Point[]): { minY: number; maxY: number } | null {
  if (points.length < 3) {
    return null
  }

  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const point of points) {
    minY = Math.min(minY, point.y)
    maxY = Math.max(maxY, point.y)
  }

  return Number.isFinite(minY) && Number.isFinite(maxY) ? { minY, maxY } : null
}

function scanlineIntervals(points: Point[], y: number): Array<[number, number]> {
  const intersections: number[] = []
  const closed =
    points.length > 0 && pointEpsilonEqual(points[0], points[points.length - 1])
      ? points
      : [...points, points[0]]

  for (let index = 0; index < closed.length - 1; index += 1) {
    const a = closed[index]
    const b = closed[index + 1]

    if (Math.abs(a.y - b.y) <= 1e-9) {
      continue
    }

    const intersects =
      (a.y <= y && b.y > y) ||
      (b.y <= y && a.y > y)

    if (!intersects) {
      continue
    }

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

function subtractIntervals(
  baseIntervals: Array<[number, number]>,
  clipIntervals: Array<[number, number]>,
): Array<[number, number]> {
  let remaining = [...baseIntervals]

  for (const [clipStart, clipEnd] of clipIntervals) {
    const next: Array<[number, number]> = []
    for (const [start, end] of remaining) {
      if (clipEnd <= start || clipStart >= end) {
        next.push([start, end])
        continue
      }

      if (clipStart > start) {
        next.push([start, clipStart])
      }
      if (clipEnd < end) {
        next.push([clipEnd, end])
      }
    }
    remaining = next
  }

  return remaining.filter(([start, end]) => end - start > 1e-9)
}

function rotatePoint(point: Point, cosTheta: number, sinTheta: number): Point {
  return {
    x: point.x * cosTheta - point.y * sinTheta,
    y: point.x * sinTheta + point.y * cosTheta,
  }
}

function distanceSquared(a: Point, b: Point): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return dx * dx + dy * dy
}

function contourNearestVertexIndex(points: Point[], anchor: Point): { index: number; distance: number } {
  let bestIndex = 0
  let bestDistance = Number.POSITIVE_INFINITY

  for (let index = 0; index < points.length; index += 1) {
    const distance = distanceSquared(anchor, points[index])
    if (distance < bestDistance) {
      bestIndex = index
      bestDistance = distance
    }
  }

  return { index: bestIndex, distance: bestDistance }
}

function contourNearestVertexDistance(points: Point[], anchor: Point): number {
  return contourNearestVertexIndex(points, anchor).distance
}

function rotateClosedContour(points: Point[], startIndex: number): Point[] {
  if (points.length <= 1 || startIndex <= 0 || startIndex >= points.length) {
    return points
  }

  return [...points.slice(startIndex), ...points.slice(0, startIndex)]
}

function contourEntryDistanceSquared(points: Point[], anchor: Point): number {
  if (points.length === 0) {
    return Number.POSITIVE_INFINITY
  }

  return contourNearestVertexDistance(points, anchor)
}

function rotateContourToNearestEntry(points: Point[], anchor: Point | null): Point[] {
  if (points.length === 0 || anchor === null) {
    return points
  }

  const { index } = contourNearestVertexIndex(points, anchor)
  return rotateClosedContour(points, index)
}

function rotateContourToBestEntry(
  points: Point[],
  fromAnchor: Point | null,
  nextAnchors: Point[],
): Point[] {
  if (points.length === 0) {
    return points
  }

  let bestIndex = 0
  let bestScore = Number.POSITIVE_INFINITY

  for (let index = 0; index < points.length; index += 1) {
    const candidate = points[index]
    const fromDistance = fromAnchor ? distanceSquared(fromAnchor, candidate) : 0
    const nextDistance = nextAnchors.length > 0
      ? Math.min(...nextAnchors.map((anchor) => distanceSquared(anchor, candidate)))
      : 0
    const score = fromDistance + nextDistance

    if (score < bestScore) {
      bestIndex = index
      bestScore = score
    }
  }

  return rotateClosedContour(points, bestIndex)
}

function contourAnchorPoint(points: Point[]): Point | null {
  const first = points[0]
  return first ? { x: first.x, y: first.y } : null
}

function regionEntryDistanceSquared(region: ResolvedPocketRegion, anchor: Point): number {
  return contourEntryDistanceSquared(region.outer, anchor)
}

export function orderRegionsGreedy(regions: ResolvedPocketRegion[], start: Point | null): ResolvedPocketRegion[] {
  if (regions.length <= 1 || start === null) {
    return regions
  }

  const remaining = [...regions]
  const ordered: ResolvedPocketRegion[] = []
  let current = start

  while (remaining.length > 0) {
    let bestIndex = 0
    let bestDistance = Number.POSITIVE_INFINITY

    for (let index = 0; index < remaining.length; index += 1) {
      const distance = regionEntryDistanceSquared(remaining[index], current)
      if (distance < bestDistance) {
        bestIndex = index
        bestDistance = distance
      }
    }

    const [nextRegion] = remaining.splice(bestIndex, 1)
    ordered.push(nextRegion)
    current = contourAnchorPoint(nextRegion.outer) ?? current
  }

  return ordered
}

export function orderClosedContoursGreedy(contours: Point[][], start: Point | null): Point[][] {
  if (contours.length <= 1 || start === null) {
    return contours
  }

  const remaining = contours
    .filter((contour) => contour.length >= 3)
    .map((contour) => [...contour])
  const ordered: Point[][] = []
  let current = start

  while (remaining.length > 0) {
    let bestIndex = 0
    let bestDistance = Number.POSITIVE_INFINITY

    for (let index = 0; index < remaining.length; index += 1) {
      const distance = contourEntryDistanceSquared(remaining[index], current)
      if (distance < bestDistance) {
        bestIndex = index
        bestDistance = distance
      }
    }

    const [nextContour] = remaining.splice(bestIndex, 1)
    const rotated = rotateContourToNearestEntry(nextContour, current)
    ordered.push(rotated)
    current = contourAnchorPoint(rotated) ?? current
  }

  return ordered
}

function orderClosedContoursGreedyPreservingRotation(contours: Point[][], start: Point | null): Point[][] {
  if (contours.length <= 1 || start === null) {
    return contours
  }

  const remaining = contours
    .filter((contour) => contour.length >= 3)
    .map((contour) => [...contour])
  const ordered: Point[][] = []
  let current = start

  while (remaining.length > 0) {
    let bestIndex = 0
    let bestDistance = Number.POSITIVE_INFINITY

    for (let index = 0; index < remaining.length; index += 1) {
      const distance = contourEntryDistanceSquared(remaining[index], current)
      if (distance < bestDistance) {
        bestIndex = index
        bestDistance = distance
      }
    }

    const [nextContour] = remaining.splice(bestIndex, 1)
    ordered.push(nextContour)
    current = contourAnchorPoint(nextContour) ?? current
  }

  return ordered
}

export function orderOpenSegmentsGreedy(segments: Point[][], start: Point | null): Point[][] {
  if (segments.length <= 1 || start === null) {
    return segments
  }

  const remaining = segments
    .filter((segment) => segment.length >= 2)
    .map((segment) => [...segment])
  const ordered: Point[][] = []
  let current = start

  while (remaining.length > 0) {
    let bestIndex = 0
    let bestReverse = false
    let bestDistance = Number.POSITIVE_INFINITY

    for (let index = 0; index < remaining.length; index += 1) {
      const segment = remaining[index]
      const first = segment[0]
      const last = segment[segment.length - 1]
      const forwardDistance = distanceSquared(current, first)
      if (forwardDistance < bestDistance) {
        bestIndex = index
        bestReverse = false
        bestDistance = forwardDistance
      }

      const reverseDistance = distanceSquared(current, last)
      if (reverseDistance < bestDistance) {
        bestIndex = index
        bestReverse = true
        bestDistance = reverseDistance
      }
    }

    const [nextSegment] = remaining.splice(bestIndex, 1)
    const orderedSegment = bestReverse ? [...nextSegment].reverse() : nextSegment
    ordered.push(orderedSegment)
    current = orderedSegment[orderedSegment.length - 1]
  }

  return ordered
}

export function buildPocketParallelSegments(
  regions: ResolvedPocketRegion[],
  stepoverDistance: number,
  angleDeg: number,
): Point[][] {
  const segments: Point[][] = []
  const minStepover = 1 / DEFAULT_CLIPPER_SCALE
  const step = Math.max(stepoverDistance, minStepover)
  const angleRad = (angleDeg * Math.PI) / 180
  const cosForward = Math.cos(angleRad)
  const sinForward = Math.sin(angleRad)
  const cosInverse = Math.cos(-angleRad)
  const sinInverse = Math.sin(-angleRad)

  regions.forEach((region, regionIndex) => {
    const rotatedOuter = region.outer.map((point) => rotatePoint(point, cosInverse, sinInverse))
    const rotatedIslands = region.islands.map((island) => island.map((point) => rotatePoint(point, cosInverse, sinInverse)))
    const bounds = polygonYBounds(rotatedOuter)
    if (!bounds) {
      return
    }

    let scanIndex = 0
    for (let y = bounds.minY + step / 2; y < bounds.maxY - step / 2 + 1e-9; y += step) {
      const outerIntervals = scanlineIntervals(rotatedOuter, y)
      if (outerIntervals.length === 0) {
        scanIndex += 1
        continue
      }

      const islandIntervals = rotatedIslands.flatMap((island) => scanlineIntervals(island, y))
      const fillIntervals = subtractIntervals(outerIntervals, islandIntervals)

      for (const [startX, endX] of fillIntervals) {
        const left = rotatePoint({ x: startX, y }, cosForward, sinForward)
        const right = rotatePoint({ x: endX, y }, cosForward, sinForward)
        const reverse = (regionIndex + scanIndex) % 2 === 1
        segments.push(reverse ? [right, left] : [left, right])
      }

      scanIndex += 1
    }
  })

  return segments
}

function cutClosedContours(
  moves: ToolpathMove[],
  contours: Point[][],
  z: number,
  safeZ: number,
  maxLinkDistance: number,
  currentPosition: ToolpathPoint | null,
  preserveContourRotation = false,
): ToolpathPoint | null {
  const start = currentPosition ? { x: currentPosition.x, y: currentPosition.y } : null
  const orderedContours = preserveContourRotation
    ? orderClosedContoursGreedyPreservingRotation(contours, start)
    : orderClosedContoursGreedy(contours, start)

  let nextPosition = currentPosition
  for (const contour of orderedContours) {
    const entryPoint = contourStartPoint(contour, z)
    nextPosition = transitionToCutEntry(moves, nextPosition, entryPoint, safeZ, maxLinkDistance)
    const cutMoves = toClosedCutMoves(contour, z)
    moves.push(...cutMoves)
    nextPosition = cutMoves.at(-1)?.to ?? nextPosition
  }

  return nextPosition
}

export function cutOffsetRegionRecursive(
  moves: ToolpathMove[],
  region: ResolvedPocketRegion,
  z: number,
  safeZ: number,
  stepoverDistance: number,
  maxLinkDistance: number,
  currentPosition: ToolpathPoint | null,
): ToolpathPoint | null {
  const childRegions = buildInsetRegions(region, stepoverDistance)
  const childAnchors = childRegions
    .map((child) => child.outer)
    .filter((contour) => contour.length > 0)
    .map((contour) => contour[0])
  const preparedContours = buildContourLoops([region]).map((contour) => rotateContourToBestEntry(
    contour,
    currentPosition ? { x: currentPosition.x, y: currentPosition.y } : null,
    childAnchors,
  ))

  let nextPosition = cutClosedContours(
    moves,
    preparedContours,
    z,
    safeZ,
    maxLinkDistance,
    currentPosition,
    true,
  )

  const orderedChildren = orderRegionsGreedy(
    childRegions,
    nextPosition ? { x: nextPosition.x, y: nextPosition.y } : null,
  )

  for (const childRegion of orderedChildren) {
    nextPosition = cutOffsetRegionRecursive(
      moves,
      childRegion,
      z,
      safeZ,
      stepoverDistance,
      maxLinkDistance,
      nextPosition,
    )
  }

  return nextPosition
}

export function toOpenCutMoves(points: Point[], z: number): ToolpathMove[] {
  if (points.length < 2) {
    return []
  }

  const moves: ToolpathMove[] = []
  for (let index = 0; index < points.length - 1; index += 1) {
    moves.push({
      kind: 'cut',
      from: { x: points[index].x, y: points[index].y, z },
      to: { x: points[index + 1].x, y: points[index + 1].y, z },
    })
  }

  return moves
}

function generateRoughBandMoves(
  band: ResolvedPocketBand,
  operation: Operation,
  safeZ: number,
  stepdown: number,
  toolRadius: number,
  stepoverDistance: number,
  maxLinkDistance: number,
): { moves: ToolpathMove[]; stepLevels: number[]; warnings: string[] } {
  const moves: ToolpathMove[] = []
  const warnings: string[] = []
  const effectiveBottom = resolveBandBottomZ(band, operation)
  if (effectiveBottom === null) {
    return {
      moves,
      stepLevels: [],
      warnings: [`Band ${band.topZ} -> ${band.bottomZ} leaves no roughing depth after axial stock-to-leave`],
    }
  }

  const radialLeave = Math.max(0, operation.stockToLeaveRadial)
  const initialInset = toolRadius + radialLeave
  const stepLevels = generateStepLevels(band.topZ, effectiveBottom, stepdown)
  const minStepover = 1 / DEFAULT_CLIPPER_SCALE
  const effectiveStepover = Math.max(stepoverDistance, minStepover)
  let currentPosition: ToolpathPoint | null = null

  if (operation.kind === 'pocket' && operation.pocketPattern === 'parallel') {
    const roughRegions = band.regions.flatMap((region) => buildInsetRegions(region, initialInset))
    if (roughRegions.length === 0) {
      return {
        moves,
        stepLevels,
        warnings: [`No machinable parallel floor region for band ${band.topZ} -> ${band.bottomZ}`],
      }
    }

    const boundaryContours = buildContourLoops(roughRegions)
    const segments = buildPocketParallelSegments(roughRegions, effectiveStepover, operation.pocketAngle)
    if (segments.length === 0) {
      return {
        moves,
        stepLevels,
        warnings: [`No machinable parallel floor segments for band ${band.topZ} -> ${band.bottomZ}`],
      }
    }

    for (const z of stepLevels) {
      for (const contour of boundaryContours) {
        const entryPoint = contourStartPoint(contour, z)
        currentPosition = transitionToCutEntry(moves, currentPosition, entryPoint, safeZ, maxLinkDistance)
        const cutMoves = toClosedCutMoves(contour, z)
        moves.push(...cutMoves)
        currentPosition = cutMoves.at(-1)?.to ?? currentPosition
      }

      const orderedSegments = orderOpenSegmentsGreedy(
        segments,
        currentPosition ? { x: currentPosition.x, y: currentPosition.y } : null,
      )

      for (const segment of orderedSegments) {
        const entryPoint = contourStartPoint(segment, z)
        currentPosition = transitionToCutEntry(moves, currentPosition, entryPoint, safeZ, maxLinkDistance)
        const cutMoves = toOpenCutMoves(segment, z)
        moves.push(...cutMoves)
        currentPosition = cutMoves.at(-1)?.to ?? currentPosition
      }

      currentPosition = retractToSafe(moves, currentPosition, safeZ)
    }

    return { moves, stepLevels, warnings }
  }

  for (const z of stepLevels) {
    const currentRegions = band.regions.flatMap((region) => buildInsetRegions(region, initialInset))
    if (currentRegions.length === 0) {
      warnings.push(`No machinable offset contours for band ${band.topZ} -> ${band.bottomZ}`)
      currentPosition = retractToSafe(moves, currentPosition, safeZ)
      continue
    }

    const orderedRegions = orderRegionsGreedy(
      currentRegions,
      currentPosition ? { x: currentPosition.x, y: currentPosition.y } : null,
    )

    for (const region of orderedRegions) {
      currentPosition = cutOffsetRegionRecursive(
        moves,
        region,
        z,
        safeZ,
        effectiveStepover,
        maxLinkDistance,
        currentPosition,
      )
    }

    currentPosition = retractToSafe(moves, currentPosition, safeZ)
  }

  return { moves, stepLevels, warnings }
}

function generateFinishBandMoves(
  band: ResolvedPocketBand,
  operation: Operation,
  safeZ: number,
  _stepdown: number,
  toolRadius: number,
  stepoverDistance: number,
  maxLinkDistance: number,
): { moves: ToolpathMove[]; stepLevels: number[]; warnings: string[] } {
  const moves: ToolpathMove[] = []
  const warnings: string[] = []
  const effectiveBottom = resolveBandBottomZ(band, operation)
  if (effectiveBottom === null) {
    return {
      moves,
      stepLevels: [],
      warnings: [`Band ${band.topZ} -> ${band.bottomZ} leaves no finish depth after axial stock-to-leave`],
    }
  }

  if (!operation.finishWalls && !operation.finishFloor) {
    return {
      moves,
      stepLevels: [],
      warnings: ['Finish operation has both Finish Walls and Finish Floor disabled'],
    }
  }

  const radialLeave = Math.max(0, operation.stockToLeaveRadial)
  const finishDelta = toolRadius + radialLeave
  const finishRegions = band.regions.flatMap((region) => buildInsetRegions(region, finishDelta))
  const wallContours = operation.finishWalls ? buildContourLoops(finishRegions) : []
  const floorContours = operation.finishFloor && !(operation.kind === 'pocket' && operation.pocketPattern === 'parallel')
    ? buildPocketFloorContours(finishRegions, 0, stepoverDistance)
    : []
  const floorSegments = operation.finishFloor && operation.kind === 'pocket' && operation.pocketPattern === 'parallel'
    ? buildPocketParallelSegments(finishRegions, stepoverDistance, operation.pocketAngle)
    : []
  if (wallContours.length === 0 && floorContours.length === 0 && floorSegments.length === 0) {
    return {
      moves,
      stepLevels: [],
      warnings: [`No finish contours available for band ${band.topZ} -> ${band.bottomZ}`],
    }
  }

  const wallStepLevels = operation.finishWalls ? [effectiveBottom] : []
  const floorStepLevels = operation.finishFloor ? [effectiveBottom] : []
  let currentPosition: ToolpathPoint | null = null

  for (const z of wallStepLevels) {
    currentPosition = cutClosedContours(moves, wallContours, z, safeZ, maxLinkDistance, currentPosition)

    currentPosition = retractToSafe(moves, currentPosition, safeZ)
  }

  for (const z of floorStepLevels) {
    currentPosition = cutClosedContours(moves, floorContours, z, safeZ, maxLinkDistance, currentPosition)

    const orderedFloorSegments = orderOpenSegmentsGreedy(
      floorSegments,
      currentPosition ? { x: currentPosition.x, y: currentPosition.y } : null,
    )

    for (const segment of orderedFloorSegments) {
      const entryPoint = contourStartPoint(segment, z)
      currentPosition = transitionToCutEntry(moves, currentPosition, entryPoint, safeZ, maxLinkDistance)
      const cutMoves = toOpenCutMoves(segment, z)
      moves.push(...cutMoves)
      currentPosition = cutMoves.at(-1)?.to ?? currentPosition
    }

    currentPosition = retractToSafe(moves, currentPosition, safeZ)
  }

  return {
    moves,
    stepLevels: [...new Set([...wallStepLevels, ...floorStepLevels])].sort((a, b) => b - a),
    warnings,
  }
}

export function generatePocketToolpath(project: Project, operation: Operation): PocketToolpathResult {
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
      stepLevels: [],
    }
  }

  const tool = normalizeToolForProject(toolRecord, project)
  if (!(tool.diameter > 0)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...resolved.warnings, 'Tool diameter must be greater than zero'],
      bounds: null,
      stepLevels: [],
    }
  }

  if (!(operation.stepdown > 0)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...resolved.warnings, 'Operation stepdown must be greater than zero'],
      bounds: null,
      stepLevels: [],
    }
  }

  if (!(operation.stepover > 0 && operation.stepover <= 1)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...resolved.warnings, 'Operation stepover ratio must be between 0 and 1'],
      bounds: null,
      stepLevels: [],
    }
  }

  const safeZ = getOperationSafeZ(project)
  const stepoverDistance = tool.diameter * operation.stepover
  const maxLinkDistance = tool.diameter
  const allMoves: ToolpathMove[] = []
  const warnings = [...resolved.warnings]
  const allStepLevels = new Set<number>()

  const formatZ = (value: number) => Number(value.toFixed(6)).toString()
  const formatFeatureSpan = (featureId: string) => {
    const feature = project.features.find((entry) => entry.id === featureId)
    if (!feature) {
      return `${featureId} [missing]`
    }

    const span = resolveFeatureZSpan(project, feature)
    return `${feature.name} (${feature.id}) [${formatZ(span.max)} -> ${formatZ(span.min)}]`
  }

  const formatIslandSpan = (id: string) => {
    const feature = project.features.find((entry) => entry.id === id)
    if (feature) {
      const span = resolveFeatureZSpan(project, feature)
      return `${feature.name} (${feature.id}) [${formatZ(span.max)} -> ${formatZ(span.min)}]`
    }

    const tab = project.tabs.find((entry) => entry.id === id)
    if (tab) {
      return `${tab.name} (${tab.id}) [${formatZ(Math.max(tab.z_top, tab.z_bottom))} -> ${formatZ(Math.min(tab.z_top, tab.z_bottom))}]`
    }

    return `${id} [missing]`
  }

  if (operation.debugToolpath) {
    const resolvedBandSummary = resolved.bands
      .map((band) => `${formatZ(band.topZ)} -> ${formatZ(band.bottomZ)}`)
      .join(', ')

    if (resolved.bands.length > 0) {
      warnings.push(`Debug: resolved pocket bands = ${resolvedBandSummary}`)
    }
  }

  for (const band of resolved.bands) {
    const result = operation.pass === 'finish'
      ? generateFinishBandMoves(
        band,
        operation,
        safeZ,
        operation.stepdown,
        tool.radius,
        stepoverDistance,
        maxLinkDistance,
      )
      : generateRoughBandMoves(
        band,
        operation,
        safeZ,
        operation.stepdown,
        tool.radius,
        stepoverDistance,
        maxLinkDistance,
      )
    const { moves, stepLevels, warnings: bandWarnings } = result
    moves.forEach((move) => allMoves.push(move))
    stepLevels.forEach((level) => allStepLevels.add(level))
    warnings.push(...bandWarnings)
    if (operation.debugToolpath) {
      warnings.push(
        `Debug: band ${formatZ(band.topZ)} -> ${formatZ(band.bottomZ)} cut levels = ${
          stepLevels.length > 0 ? stepLevels.map((level) => formatZ(level)).join(', ') : 'none'
        }`,
      )
      warnings.push(
        `Debug: band ${formatZ(band.topZ)} -> ${formatZ(band.bottomZ)} targets = ${
          band.targetFeatureIds.length > 0 ? band.targetFeatureIds.map((id) => formatFeatureSpan(id)).join('; ') : 'none'
        }`,
      )
      warnings.push(
        `Debug: band ${formatZ(band.topZ)} -> ${formatZ(band.bottomZ)} islands = ${
          band.islandFeatureIds.length > 0 ? band.islandFeatureIds.map((id) => formatIslandSpan(id)).join('; ') : 'none'
        }`,
      )
    }
  }

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
