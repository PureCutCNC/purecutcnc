import ClipperLib from 'clipper-lib'
import type { Operation, Project } from '../../types/project'
import type { ToolpathBounds, ToolpathMove, ToolpathPoint, ToolpathResult } from './types'
import { applyContourDirection, getOperationSafeZ, normalizeToolForProject } from './geometry'
import { buildContourLoops, buildInsetRegions, contourStartPoint, pushRapidAndPlunge, retractToSafe, toClosedCutMoves, updateBounds } from './pocket'
import { resolvePocketRegions } from './resolver'

function computeBounds(moves: ToolpathMove[]): ToolpathBounds | null {
  let bounds: ToolpathBounds | null = null
  for (const move of moves) {
    bounds = updateBounds(bounds, move.from)
    bounds = updateBounds(bounds, move.to)
  }
  return bounds
}

export function generateVCarveToolpath(project: Project, operation: Operation): ToolpathResult {
  if (operation.kind !== 'v_carve') {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['Only V-carve operations can be resolved by the V-carve generator'],
      bounds: null,
    }
  }

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
    }
  }

  const tool = normalizeToolForProject(toolRecord, project)
  if (tool.type !== 'v_bit') {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...resolved.warnings, 'V-Carve requires a V-bit tool'],
      bounds: null,
    }
  }

  if (!(tool.vBitAngle && tool.vBitAngle > 0 && tool.vBitAngle < 180)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...resolved.warnings, 'V-bit angle must be between 0 and 180 degrees'],
      bounds: null,
    }
  }

  if (!(operation.maxCarveDepth > 0)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...resolved.warnings, 'Max carve depth must be greater than zero'],
      bounds: null,
    }
  }

  if (!(operation.stepover > 0)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...resolved.warnings, 'Contour spacing must be greater than zero'],
      bounds: null,
    }
  }

  const halfAngleRadians = (tool.vBitAngle * Math.PI) / 360
  const slope = Math.tan(halfAngleRadians)
  if (!(slope > 1e-9)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...resolved.warnings, 'V-bit angle produces an invalid carving slope'],
      bounds: null,
    }
  }

  const safeZ = getOperationSafeZ(project)
  // stepover is the absolute contour spacing distance in project units.
  const stepoverDistance = operation.stepover
  const direction = operation.cutDirection ?? 'conventional'
  const moves: ToolpathMove[] = []
  const warnings = [...resolved.warnings]
  let currentPosition: ToolpathPoint | null = null

  for (const band of resolved.bands) {
    const maxBandDepth = Math.max(0, Math.min(operation.maxCarveDepth, band.topZ - band.bottomZ))
    if (!(maxBandDepth > 0)) {
      warnings.push(`Band ${band.topZ} -> ${band.bottomZ} leaves no usable V-carve depth`)
      continue
    }

    const vcarveJoinType = ClipperLib.JoinType.jtRound
    let currentDepth = Math.min(stepoverDistance / slope, maxBandDepth)
    let currentRegions = band.regions.flatMap((region) => buildInsetRegions(region, currentDepth * slope, vcarveJoinType))

    while (currentRegions.length > 0 && currentDepth <= maxBandDepth + 1e-9) {
      const rawContours = buildContourLoops(currentRegions)
      if (rawContours.length === 0) {
        break
      }

      const contours = applyContourDirection(rawContours, direction)
      const z = band.topZ - currentDepth
      for (const contour of contours) {
        const entryPoint = contourStartPoint(contour, z)
        const safePosition = retractToSafe(moves, currentPosition, safeZ)
        currentPosition = pushRapidAndPlunge(moves, safePosition, entryPoint, safeZ)
        const cutMoves = toClosedCutMoves(contour, z)
        moves.push(...cutMoves)
        currentPosition = cutMoves.at(-1)?.to ?? currentPosition
        currentPosition = retractToSafe(moves, currentPosition, safeZ)
      }
      currentDepth += stepoverDistance / slope
      if (currentDepth > maxBandDepth + 1e-9) {
        break
      }
      currentRegions = currentRegions.flatMap((region) => buildInsetRegions(region, stepoverDistance, vcarveJoinType))
    }
  }

  if (moves.length === 0) {
    warnings.push('V-carve generator produced no toolpath moves')
  }

  return {
    operationId: operation.id,
    moves,
    warnings,
    bounds: computeBounds(moves),
  }
}
