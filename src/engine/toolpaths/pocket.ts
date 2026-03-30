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

export function buildInsetRegions(region: ResolvedPocketRegion, delta: number): ResolvedPocketRegion[] {
  const scale = DEFAULT_CLIPPER_SCALE
  const outerPath = toClipperPath(normalizeWinding(region.outer, false), scale)
  const islandPaths = region.islands.map((island) => toClipperPath(normalizeWinding(island, false), scale))

  const insetOuterPaths = offsetPaths([outerPath], -delta * scale)
  if (insetOuterPaths.length === 0) {
    return []
  }

  const expandedIslandPaths = offsetPaths(islandPaths, delta * scale)
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
  const initialInset = toolRadius + radialLeave
  const stepLevels = generateStepLevels(band.topZ, effectiveBottom, stepdown)
  const minStepover = 1 / DEFAULT_CLIPPER_SCALE
  const effectiveStepover = Math.max(stepoverDistance, minStepover)
  let currentPosition: ToolpathPoint | null = null

  for (const z of stepLevels) {
    let currentRegions = band.regions.flatMap((region) => buildInsetRegions(region, initialInset))
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
  _stepdown: number,
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
  const finishDelta = toolRadius + radialLeave
  const finishRegions = band.regions.flatMap((region) => buildInsetRegions(region, finishDelta))
  const wallContours = operation.finishWalls ? buildContourLoops(finishRegions) : []
  const floorContours = operation.finishFloor
    ? buildPocketFloorContours(finishRegions, 0, stepoverDistance)
    : []
  if (wallContours.length === 0 && floorContours.length === 0) {
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
      currentPosition = pushRapidAndPlunge(moves, currentPosition, entryPoint, safeZ)
      const cutMoves = toClosedCutMoves(contour, z)
      moves.push(...cutMoves)
      currentPosition = cutMoves.at(-1)?.to ?? currentPosition
      currentPosition = retractToSafe(moves, currentPosition, safeZ)
    }
  }

  for (const z of floorStepLevels) {
    for (const contour of floorContours) {
      const entryPoint = contourStartPoint(contour, z)
      currentPosition = pushRapidAndPlunge(moves, currentPosition, entryPoint, safeZ)
      const cutMoves = toClosedCutMoves(contour, z)
      moves.push(...cutMoves)
      currentPosition = cutMoves.at(-1)?.to ?? currentPosition
      currentPosition = retractToSafe(moves, currentPosition, safeZ)
    }
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
