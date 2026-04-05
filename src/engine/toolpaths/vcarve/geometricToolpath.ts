import type { Operation, Project } from '../../../types/project'
import type { ToolpathBounds, ToolpathMove, ToolpathResult } from '../types'
import { getOperationSafeZ, normalizeToolForProject } from '../geometry'
import { updateBounds } from '../pocket'
import { resolvePocketRegions } from '../resolver'
import { buildGeometricVCarveRegionResult } from './pipeline'
import { prepareVCarveRegion } from './prepare'

function computeBounds(moves: ToolpathMove[]): ToolpathBounds | null {
  let bounds: ToolpathBounds | null = null
  for (const move of moves) {
    bounds = updateBounds(bounds, move.from)
    bounds = updateBounds(bounds, move.to)
  }
  return bounds
}

export function generateGeometricVCarveToolpath(project: Project, operation: Operation): ToolpathResult {
  const supportedKind = operation.kind === 'v_carve' || operation.kind === 'v_carve_skeleton'
  if (!supportedKind) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['Only V-carve operations can be resolved by the geometric V-carve generator'],
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
      warnings: [...resolved.warnings, 'Geometric V-carve requires a V-bit tool'],
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

  if (!(operation.stepover > 0 && operation.stepover <= 1)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...resolved.warnings, 'Solver resolution ratio must be between 0 and 1'],
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
  const segmentLength = Math.max(tool.diameter * operation.stepover, 1e-4)
  const warnings = [...resolved.warnings]
  if (operation.kind === 'v_carve_skeleton') {
    warnings.push('V-Carve Skeleton is using the experimental geometric solver')
  }
  const moves: ToolpathMove[] = []

  for (const band of resolved.bands) {
    const maxBandDepth = Math.max(0, Math.min(operation.maxCarveDepth, band.topZ - band.bottomZ))
    if (!(maxBandDepth > 0)) {
      warnings.push(`Band ${band.topZ} -> ${band.bottomZ} leaves no usable geometric V-carve depth`)
      continue
    }

    for (const region of band.regions) {
      const preparedRegion = prepareVCarveRegion(region)
      if (!preparedRegion) {
        warnings.push('Skipped a geometric V-carve region because its polygon preparation failed')
        continue
      }
      if (preparedRegion.holes.length > 0) {
        warnings.push('Geometric V-carve solver does not yet support regions with holes')
        continue
      }
      const result = buildGeometricVCarveRegionResult(region, {
        topZ: band.topZ,
        maxDepth: maxBandDepth,
        slope,
        safeZ,
        segmentLength,
      })
      if (!result) {
        warnings.push('Skipped a geometric V-carve region because its polygon preparation failed')
        continue
      }
      if (result.diagnostics.illegalCrossingCount > 0) {
        warnings.push(`Geometric V-carve solver produced ${result.diagnostics.illegalCrossingCount} illegal graph crossings in one target region`)
      }
      if (result.moves.length === 0) {
        warnings.push('Geometric V-carve solver produced no usable branches for one target region')
        continue
      }
      moves.push(...result.moves)
    }
  }

  if (moves.length === 0) {
    warnings.push('Geometric V-carve generator produced no toolpath moves')
  }

  return {
    operationId: operation.id,
    moves,
    warnings,
    bounds: computeBounds(moves),
  }
}
