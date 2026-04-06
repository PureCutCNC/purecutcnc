import ClipperLib from 'clipper-lib'
import type { Operation, Point, Project, SketchFeature } from '../../types/project'
import type {
  ClipperPath,
  PocketToolpathResult,
  ResolvedPocketBand,
  ResolvedPocketRegion,
  ResolvedPocketResult,
  ToolpathBounds,
  ToolpathMove,
  ToolpathPoint,
} from './types'
import {
  DEFAULT_CLIPPER_SCALE,
  flattenProfile,
  getOperationSafeZ,
  normalizeToolForProject,
  normalizeWinding,
  resolveFeatureZSpan,
  toClipperPath,
} from './geometry'
import {
  buildContourLoops,
  buildInsetRegions,
  contourStartPoint,
  generateStepLevels,
  polyTreeToRegions,
  retractToSafe,
  resolveBandBottomZ,
  transitionToCutEntry,
  toClosedCutMoves,
  updateBounds,
} from './pocket'
import { expandFeatureGeometry, featureHasClosedGeometry } from '../../text'

interface PolyTreeNode {
  IsHole(): boolean
  Contour(): ClipperPath
  Childs?: () => PolyTreeNode[]
  m_Childs?: PolyTreeNode[]
}

interface SurfaceCleanBand extends ResolvedPocketBand {
  subjectPaths: ClipperPath[]
  protectedPaths: ClipperPath[]
}

interface SurfaceCleanResult {
  operationId: string
  units: ResolvedPocketResult['units']
  bands: SurfaceCleanBand[]
  warnings: string[]
}

function executeClip(
  subjectPaths: ClipperPath[],
  clipPaths: ClipperPath[],
  clipType: number,
): PolyTreeNode {
  const clipper = new ClipperLib.Clipper()
  if (subjectPaths.length > 0) {
    clipper.AddPaths(subjectPaths, ClipperLib.PolyType.ptSubject, true)
  }
  if (clipPaths.length > 0) {
    clipper.AddPaths(clipPaths, ClipperLib.PolyType.ptClip, true)
  }

  const polyTree = new ClipperLib.PolyTree()
  clipper.Execute(
    clipType,
    polyTree,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  )
  return polyTree as PolyTreeNode
}

function offsetPaths(paths: ClipperPath[], delta: number): ClipperPath[] {
  if (paths.length === 0) {
    return []
  }

  const offset = new ClipperLib.ClipperOffset()
  offset.AddPaths(paths, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon)
  const solution = new ClipperLib.Paths()
  offset.Execute(solution, delta)
  return solution as ClipperPath[]
}

function flattenProfileToClipperPath(profile: SketchFeature['sketch']['profile'], scale = DEFAULT_CLIPPER_SCALE): ClipperPath {
  const flattened = flattenProfile(profile)
  return toClipperPath(normalizeWinding(flattened.points, false), scale)
}

function buildSurfaceCoverageRegions(
  subjectPaths: ClipperPath[],
  protectedPaths: ClipperPath[],
  regions: ResolvedPocketBand['regions'],
  toolRadius: number,
): ResolvedPocketRegion[] {
  const scale = DEFAULT_CLIPPER_SCALE

  if (subjectPaths.length === 0) {
    return []
  }

  // Expand the original subject and protected paths before subtraction so the
  // tool centre path respects the true protected-feature boundary rather than
  // the already-clipped edge.  AllowedArea = Offset(Subject, +r) - Offset(Protected, +r)
  const expandedSubjectPaths = offsetPaths(subjectPaths, toolRadius * scale)
  if (expandedSubjectPaths.length === 0) {
    return []
  }

  const expandedProtectedPaths = offsetPaths(protectedPaths, toolRadius * scale)
  const polyTree = executeClip(expandedSubjectPaths, expandedProtectedPaths, ClipperLib.ClipType.ctDifference)

  const targetFeatureIds = [...new Set(regions.flatMap((r) => r.targetFeatureIds))]
  const islandFeatureIds = [...new Set(regions.flatMap((r) => r.islandFeatureIds))]

  return polyTreeToRegions(polyTree, targetFeatureIds, islandFeatureIds, scale)
    .filter((region) => region.outer.length >= 3)
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

function buildSurfaceFloorSegments(regions: ResolvedPocketBand['regions'], stepoverDistance: number): Point[][] {
  const segments: Point[][] = []
  const minStepover = 1 / DEFAULT_CLIPPER_SCALE
  const step = Math.max(stepoverDistance, minStepover)

  regions.forEach((region, regionIndex) => {
    const bounds = polygonYBounds(region.outer)
    if (!bounds) {
      return
    }

    let scanIndex = 0
    for (let y = bounds.minY + step / 2; y < bounds.maxY - step / 2 + 1e-9; y += step) {
      const outerIntervals = scanlineIntervals(region.outer, y)
      if (outerIntervals.length === 0) {
        scanIndex += 1
        continue
      }

      const islandIntervals = region.islands.flatMap((island) => scanlineIntervals(island, y))
      const fillIntervals = subtractIntervals(outerIntervals, islandIntervals)

      for (const [startX, endX] of fillIntervals) {
        const left: Point = { x: startX, y }
        const right: Point = { x: endX, y }
        const reverse = (regionIndex + scanIndex) % 2 === 1
        segments.push(reverse ? [right, left] : [left, right])
      }

      scanIndex += 1
    }
  })

  return segments
}

function toOpenCutMoves(points: Point[], z: number): ToolpathMove[] {
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

function resolveSurfaceCleanRegions(project: Project, operation: Operation): SurfaceCleanResult {
  const warnings: string[] = []

  if (operation.kind !== 'surface_clean') {
    return {
      operationId: operation.id,
      units: project.meta.units,
      bands: [],
      warnings: ['Only surface-clean operations can be resolved by the surface-clean resolver'],
    }
  }

  if (operation.target.source !== 'features' || operation.target.featureIds.length === 0) {
    return {
      operationId: operation.id,
      units: project.meta.units,
      bands: [],
      warnings: ['Surface-clean operation has no feature targets'],
    }
  }

  const selectedTargetFeatures = operation.target.featureIds
    .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
    .filter((feature): feature is SketchFeature => feature !== null)
  const validTargetSourceFeatures = selectedTargetFeatures
    .filter((feature) => feature.operation === 'add')

  const targetFeatures = validTargetSourceFeatures
    .flatMap((feature) => expandFeatureGeometry(feature))
    .filter((feature) => feature.operation === 'add')
    .map((feature) => {
      const span = resolveFeatureZSpan(project, feature)
      return { feature, top: span.max }
    })

  if (validTargetSourceFeatures.length !== operation.target.featureIds.length) {
    warnings.push('Some selected target features are missing or are not add features')
  }

  const closedTargetFeatures = targetFeatures.filter(({ feature }) => featureHasClosedGeometry(feature))
  if (closedTargetFeatures.length !== targetFeatures.length) {
    warnings.push('Surface-clean operations only support closed target profiles')
  }

  if (closedTargetFeatures.length === 0) {
    return {
      operationId: operation.id,
      units: project.meta.units,
      bands: [],
      warnings: [...warnings, 'No valid add features were found for this surface-clean operation'],
    }
  }

  const allAddFeatures = project.features
    .flatMap((feature) => expandFeatureGeometry(feature))
    .filter((feature) => feature.operation === 'add' && featureHasClosedGeometry(feature))
    .map((feature) => {
      const span = resolveFeatureZSpan(project, feature)
      return { feature, top: span.max }
    })

  const depthLevels = [...new Set([project.stock.thickness, ...closedTargetFeatures.map(({ top }) => top)])]
    .sort((a, b) => b - a)
  const bands: SurfaceCleanBand[] = []
  const targetIdSet = new Set(closedTargetFeatures.map(({ feature }) => feature.id))

  for (let index = 0; index < depthLevels.length - 1; index += 1) {
    const topZ = depthLevels[index]
    const bottomZ = depthLevels[index + 1]
    if (Math.abs(topZ - bottomZ) <= Number.EPSILON) {
      continue
    }

    const activeTargets = closedTargetFeatures.filter(({ top }) => top <= bottomZ)
    if (activeTargets.length === 0) {
      continue
    }

    const subjectPaths = activeTargets.map(({ feature }) => flattenProfileToClipperPath(feature.sketch.profile))
    const protectedFeatures = allAddFeatures.filter(({ top, feature }) => top > bottomZ && !targetIdSet.has(feature.id))
    const protectedPaths = protectedFeatures.map(({ feature }) => flattenProfileToClipperPath(feature.sketch.profile))
    const polyTree = executeClip(subjectPaths, protectedPaths, ClipperLib.ClipType.ctDifference)
    const regions = polyTreeToRegions(
      polyTree,
      activeTargets.map(({ feature }) => feature.id),
      protectedFeatures.map(({ feature }) => feature.id),
    )

    if (regions.length === 0) {
      warnings.push(`Band ${topZ} -> ${bottomZ} resolved to no machinable regions`)
      continue
    }

    bands.push({
      topZ,
      bottomZ,
      targetFeatureIds: activeTargets.map(({ feature }) => feature.id),
      islandFeatureIds: protectedFeatures.map(({ feature }) => feature.id),
      regions,
      subjectPaths,
      protectedPaths,
    })
  }

  if (bands.length === 0) {
    warnings.push('Surface-clean resolver produced no depth bands')
  }

  return {
    operationId: operation.id,
    units: project.meta.units,
    bands,
    warnings,
  }
}

function generateRoughBandMoves(
  band: SurfaceCleanBand,
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
  const coverageRegions = buildSurfaceCoverageRegions(band.subjectPaths, band.protectedPaths, band.regions, toolRadius)
  const initialInset = radialLeave
  const stepLevels = generateStepLevels(band.topZ, effectiveBottom, stepdown)
  const minStepover = 1 / DEFAULT_CLIPPER_SCALE
  const effectiveStepover = Math.max(stepoverDistance, minStepover)
  let currentPosition: ToolpathPoint | null = null

  for (const z of stepLevels) {
    let currentRegions = coverageRegions.flatMap((region) => buildInsetRegions(region, initialInset))
    while (currentRegions.length > 0) {
      const contours = buildContourLoops(currentRegions)
      if (contours.length === 0) {
        warnings.push(`No machinable offset contours for band ${band.topZ} -> ${band.bottomZ}`)
        break
      }

      for (const contour of contours) {
        const entryPoint = contourStartPoint(contour, z)
        currentPosition = transitionToCutEntry(moves, currentPosition, entryPoint, safeZ, maxLinkDistance)
        const cutMoves = toClosedCutMoves(contour, z)
        moves.push(...cutMoves)
        currentPosition = cutMoves.at(-1)?.to ?? currentPosition
      }

      currentRegions = currentRegions.flatMap((region) => buildInsetRegions(region, effectiveStepover))
    }

    currentPosition = retractToSafe(moves, currentPosition, safeZ)
  }

  return { moves, stepLevels, warnings }
}

function generateFinishBandMoves(
  band: SurfaceCleanBand,
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
  const coverageRegions = buildSurfaceCoverageRegions(band.subjectPaths, band.protectedPaths, band.regions, toolRadius)
  const finishDelta = radialLeave
  const finishRegions = coverageRegions.flatMap((region) => buildInsetRegions(region, finishDelta))
  const wallContours = operation.finishWalls ? buildContourLoops(finishRegions) : []
  const floorSegments = operation.finishFloor
    ? buildSurfaceFloorSegments(finishRegions, stepoverDistance)
    : []
  if (wallContours.length === 0 && floorSegments.length === 0) {
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
    for (const contour of wallContours) {
      const entryPoint = contourStartPoint(contour, z)
      currentPosition = transitionToCutEntry(moves, currentPosition, entryPoint, safeZ, maxLinkDistance)
      const cutMoves = toClosedCutMoves(contour, z)
      moves.push(...cutMoves)
      currentPosition = cutMoves.at(-1)?.to ?? currentPosition
    }

    currentPosition = retractToSafe(moves, currentPosition, safeZ)
  }

  for (const z of floorStepLevels) {
    for (const segment of floorSegments) {
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

export function generateSurfaceCleanToolpath(project: Project, operation: Operation): PocketToolpathResult {
  const resolved = resolveSurfaceCleanRegions(project, operation)
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

  const safeZ = getOperationSafeZ(project)
  const stepoverDistance = tool.diameter * operation.stepover
  const maxLinkDistance = tool.diameter
  const allMoves: ToolpathMove[] = []
  const warnings = [...resolved.warnings]
  const allStepLevels = new Set<number>()

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
