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
import type { CutDirection, Operation, Project, SketchFeature } from '../../types/project'
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
  applyContourDirection,
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
  buildPocketParallelSegments,
  cutOffsetRegionRecursive,
  contourStartPoint,
  generateStepLevels,
  orderClosedContoursGreedy,
  orderOpenSegmentsGreedy,
  orderRegionsGreedy,
  polyTreeToRegions,
  retractToSafe,
  resolveBandBottomZ,
  transitionToCutEntry,
  toClosedCutMoves,
  toOpenCutMoves,
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
  direction: CutDirection = 'conventional',
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

  if (operation.pocketPattern === 'parallel') {
    const roughRegions = coverageRegions.flatMap((region) => buildInsetRegions(region, initialInset))
    if (roughRegions.length === 0) {
      return {
        moves,
        stepLevels,
        warnings: [`No machinable parallel cleanup region for band ${band.topZ} -> ${band.bottomZ}`],
      }
    }

    const boundaryContours = applyContourDirection(buildContourLoops(roughRegions), direction)
    const segments = buildPocketParallelSegments(roughRegions, effectiveStepover, operation.pocketAngle)
    if (segments.length === 0) {
      return {
        moves,
        stepLevels,
        warnings: [`No machinable parallel cleanup segments for band ${band.topZ} -> ${band.bottomZ}`],
      }
    }

    for (const z of stepLevels) {
      const orderedBoundaryContours = orderClosedContoursGreedy(
        boundaryContours,
        currentPosition ? { x: currentPosition.x, y: currentPosition.y } : null,
      )

      for (const contour of orderedBoundaryContours) {
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
    const currentRegions = coverageRegions.flatMap((region) => buildInsetRegions(region, initialInset))
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
        direction,
      )
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
  direction: CutDirection = 'conventional',
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
  const wallContours = operation.finishWalls ? applyContourDirection(buildContourLoops(finishRegions), direction) : []
  const floorContours = operation.finishFloor && operation.pocketPattern === 'offset'
    ? applyContourDirection(buildPocketFloorContours(finishRegions, 0, stepoverDistance), direction)
    : []
  const floorSegments = operation.finishFloor && operation.pocketPattern === 'parallel'
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
    const orderedWallContours = orderClosedContoursGreedy(
      wallContours,
      currentPosition ? { x: currentPosition.x, y: currentPosition.y } : null,
    )

    for (const contour of orderedWallContours) {
      const entryPoint = contourStartPoint(contour, z)
      currentPosition = transitionToCutEntry(moves, currentPosition, entryPoint, safeZ, maxLinkDistance)
      const cutMoves = toClosedCutMoves(contour, z)
      moves.push(...cutMoves)
      currentPosition = cutMoves.at(-1)?.to ?? currentPosition
    }

    currentPosition = retractToSafe(moves, currentPosition, safeZ)
  }

  for (const z of floorStepLevels) {
    const orderedFloorContours = orderClosedContoursGreedy(
      floorContours,
      currentPosition ? { x: currentPosition.x, y: currentPosition.y } : null,
    )

    for (const contour of orderedFloorContours) {
      const entryPoint = contourStartPoint(contour, z)
      currentPosition = transitionToCutEntry(moves, currentPosition, entryPoint, safeZ, maxLinkDistance)
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
  const direction = operation.cutDirection ?? 'conventional'
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
        direction,
      )
      : generateRoughBandMoves(
        band,
        operation,
        safeZ,
        operation.stepdown,
        tool.radius,
        stepoverDistance,
        maxLinkDistance,
        direction,
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
