import ClipperLib from 'clipper-lib'
import type { Operation, Project, SketchFeature } from '../../types/project'
import type {
  ClipperPath,
  PocketToolpathResult,
  ResolvedPocketBand,
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
  buildPocketFloorContours,
  contourStartPoint,
  generateStepLevels,
  polyTreeToRegions,
  pushRapidAndPlunge,
  retractToSafe,
  resolveBandBottomZ,
  toClosedCutMoves,
  updateBounds,
} from './pocket'

interface PolyTreeNode {
  IsHole(): boolean
  Contour(): ClipperPath
  Childs?: () => PolyTreeNode[]
  m_Childs?: PolyTreeNode[]
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

function buildSurfaceCoverageRegions(regions: ResolvedPocketBand['regions'], toolRadius: number) {
  const scale = DEFAULT_CLIPPER_SCALE
  const expandedRegions = regions.flatMap((region) => {
    const outerPath = toClipperPath(normalizeWinding(region.outer, false), scale)
    const islandPaths = region.islands.map((island) => toClipperPath(normalizeWinding(island, false), scale))

    const expandedOuterPaths = offsetPaths([outerPath], toolRadius * scale)
    if (expandedOuterPaths.length === 0) {
      return []
    }

    const expandedIslandPaths = offsetPaths(islandPaths, toolRadius * scale)
    const polyTree = executeClip(expandedOuterPaths, expandedIslandPaths, ClipperLib.ClipType.ctDifference)
    return polyTreeToRegions(polyTree, region.targetFeatureIds, region.islandFeatureIds, scale)
  })

  return expandedRegions.filter((region) => region.outer.length >= 3)
}

function resolveSurfaceCleanRegions(project: Project, operation: Operation): ResolvedPocketResult {
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

  const targetFeatures = operation.target.featureIds
    .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
    .filter((feature): feature is SketchFeature => feature !== null)
    .filter((feature) => feature.operation === 'add')
    .map((feature) => {
      const span = resolveFeatureZSpan(project, feature)
      return { feature, top: span.max }
    })

  if (targetFeatures.length !== operation.target.featureIds.length) {
    warnings.push('Some selected target features are missing or are not add features')
  }

  if (targetFeatures.length === 0) {
    return {
      operationId: operation.id,
      units: project.meta.units,
      bands: [],
      warnings: [...warnings, 'No valid add features were found for this surface-clean operation'],
    }
  }

  const allAddFeatures = project.features
    .filter((feature) => feature.operation === 'add')
    .map((feature) => {
      const span = resolveFeatureZSpan(project, feature)
      return { feature, top: span.max }
    })

  const depthLevels = [...new Set([project.stock.thickness, ...targetFeatures.map(({ top }) => top)])]
    .sort((a, b) => b - a)
  const bands: ResolvedPocketBand[] = []
  const targetIdSet = new Set(targetFeatures.map(({ feature }) => feature.id))

  for (let index = 0; index < depthLevels.length - 1; index += 1) {
    const topZ = depthLevels[index]
    const bottomZ = depthLevels[index + 1]
    if (Math.abs(topZ - bottomZ) <= Number.EPSILON) {
      continue
    }

    const activeTargets = targetFeatures.filter(({ top }) => top <= bottomZ)
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
  band: ResolvedPocketBand,
  operation: Operation,
  safeZ: number,
  stepdown: number,
  toolRadius: number,
  stepoverDistance: number,
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
  const coverageRegions = buildSurfaceCoverageRegions(band.regions, toolRadius)
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
        currentPosition = pushRapidAndPlunge(moves, currentPosition, entryPoint, safeZ)
        const cutMoves = toClosedCutMoves(contour, z)
        moves.push(...cutMoves)
        currentPosition = cutMoves.at(-1)?.to ?? currentPosition
        currentPosition = retractToSafe(moves, currentPosition, safeZ)
      }

      currentRegions = currentRegions.flatMap((region) => buildInsetRegions(region, effectiveStepover))
    }
  }

  return { moves, stepLevels, warnings }
}

function generateFinishBandMoves(
  band: ResolvedPocketBand,
  operation: Operation,
  safeZ: number,
  stepdown: number,
  toolRadius: number,
  stepoverDistance: number,
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
  const coverageRegions = buildSurfaceCoverageRegions(band.regions, toolRadius)
  const finishDelta = radialLeave
  const finishRegions = coverageRegions.flatMap((region) => buildInsetRegions(region, finishDelta))
  const wallContours = operation.finishWalls ? buildContourLoops(finishRegions) : []
  const floorContours = operation.finishFloor
    ? buildPocketFloorContours(finishRegions, 0, stepoverDistance)
    : []
  const finishContours = [
    ...wallContours.map((contour) => ({ contour, floor: false })),
    ...floorContours.map((contour) => ({ contour, floor: true })),
  ]
  if (finishContours.length === 0) {
    return {
      moves,
      stepLevels: [],
      warnings: [`No finish contours available for band ${band.topZ} -> ${band.bottomZ}`],
    }
  }

  const stepLevels = operation.finishFloor
    ? [effectiveBottom]
    : generateStepLevels(band.topZ, effectiveBottom, stepdown)
  let currentPosition: ToolpathPoint | null = null

  for (const z of stepLevels) {
    for (const entry of finishContours) {
      if (entry.floor && z !== effectiveBottom) {
        continue
      }

      const entryPoint = contourStartPoint(entry.contour, z)
      currentPosition = pushRapidAndPlunge(moves, currentPosition, entryPoint, safeZ)
      const cutMoves = toClosedCutMoves(entry.contour, z)
      moves.push(...cutMoves)
      currentPosition = cutMoves.at(-1)?.to ?? currentPosition
      currentPosition = retractToSafe(moves, currentPosition, safeZ)
    }
  }

  return { moves, stepLevels, warnings }
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
      )
      : generateRoughBandMoves(
        band,
        operation,
        safeZ,
        operation.stepdown,
        tool.radius,
        stepoverDistance,
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
