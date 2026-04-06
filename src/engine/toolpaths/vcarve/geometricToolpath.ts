import type { Operation, Project } from '../../../types/project'
import type { ResolvedPocketRegion, ToolpathBounds, ToolpathMove, ToolpathPoint, ToolpathResult } from '../types'
import { getOperationSafeZ, normalizeToolForProject } from '../geometry'
import { buildContourLoops, buildInsetRegions, contourStartPoint, pushRapidAndPlunge, retractToSafe, toClosedCutMoves, updateBounds } from '../pocket'
import { resolvePocketRegions } from '../resolver'

function computeBounds(moves: ToolpathMove[]): ToolpathBounds | null {
  let bounds: ToolpathBounds | null = null
  for (const move of moves) {
    bounds = updateBounds(bounds, move.from)
    bounds = updateBounds(bounds, move.to)
  }
  return bounds
}

function emitContour(
  contour: { x: number; y: number }[],
  depth: number,
  topZ: number,
  safeZ: number,
  moves: ToolpathMove[],
  currentPosition: ToolpathPoint | null,
): ToolpathPoint | null {
  const z = topZ - depth
  const entryPoint = contourStartPoint(contour, z)
  let pos = retractToSafe(moves, currentPosition, safeZ)
  pos = pushRapidAndPlunge(moves, pos, entryPoint, safeZ)
  const cutMoves = toClosedCutMoves(contour, z)
  moves.push(...cutMoves)
  pos = cutMoves.at(-1)?.to ?? pos
  return retractToSafe(moves, pos, safeZ)
}

/**
 * Hybrid V-carve: step inward, hold the last single-contour offset, emit it
 * when a split or collapse is detected, then continue with normal parallel
 * offsets through the remaining regions.
 *
 * Rules per region:
 *  1. Single contour  → remember it, advance
 *  2. Multiple contours (split) → emit remembered, then emit all subsequent
 *     offsets as normal parallel loops
 *  3. No contours (collapse) → emit remembered
 */
function buildHybridMovesForRegion(
  initialRegion: ResolvedPocketRegion,
  topZ: number,
  maxDepth: number,
  slope: number,
  safeZ: number,
  stepoverDistance: number,
  moves: ToolpathMove[],
  startPosition: ToolpathPoint | null,
  regionDepth: number = 0,
): ToolpathPoint | null {
  let pos = startPosition

  // Pre-populate remembered only for recursive calls (regionDepth > 0), where
  // the child region at its split depth is a meaningful contour to fall back to.
  // For top-level calls (regionDepth = 0) start null — if the stepover is too
  // large and the shape collapses immediately we emit nothing rather than
  // cutting the original boundary at z = topZ.
  const initialContours = regionDepth > 0 ? buildContourLoops([initialRegion]) : []
  let rememberedContours: { x: number; y: number }[][] | null =
    initialContours.length > 0 ? initialContours : null
  let rememberedDepth = Math.min(regionDepth, maxDepth)
  let terminalEmitted = false

  let currentRegions: ResolvedPocketRegion[] = buildInsetRegions(initialRegion, stepoverDistance)
  let depth = regionDepth + stepoverDistance / slope

  while (depth <= maxDepth + 1e-9) {
    const cappedDepth = Math.min(depth, maxDepth)
    const regionCount = currentRegions.length

    if (regionCount === 0) {
      // Collapse — emit the remembered contours.
      if (rememberedContours) {
        for (const contour of rememberedContours) {
          pos = emitContour(contour, rememberedDepth, topZ, safeZ, moves, pos)
        }
        terminalEmitted = true
      }
      break
    }

    if (regionCount === 1) {
      // Single region — update remembered.
      rememberedContours = buildContourLoops(currentRegions)
      rememberedDepth = cappedDepth
    } else {
      // Split — emit the pre-split contour (covers the full stroke width at
      // junction depth), then recurse into each child for its own spine.
      if (rememberedContours) {
        for (const contour of rememberedContours) {
          pos = emitContour(contour, rememberedDepth, topZ, safeZ, moves, pos)
        }
      }
      for (const childRegion of currentRegions) {
        pos = buildHybridMovesForRegion(
          childRegion, topZ, maxDepth, slope, safeZ, stepoverDistance, moves, pos, cappedDepth,
        )
      }
      terminalEmitted = true
      break
    }

    if (depth >= maxDepth - 1e-9) break

    currentRegions = currentRegions.flatMap((r) => buildInsetRegions(r, stepoverDistance))
    depth += stepoverDistance / slope
  }

  // Reached maxDepth without split or collapse — emit the last remembered pass.
  if (!terminalEmitted && rememberedContours) {
    for (const contour of rememberedContours) {
      pos = emitContour(contour, Math.min(rememberedDepth, maxDepth), topZ, safeZ, moves, pos)
    }
  }

  return pos
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

  if (!(operation.stepover > 0)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...resolved.warnings, 'Skeleton resolution must be greater than zero'],
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
  // stepover is the absolute offset step distance in project units (not a ratio).
  const stepoverDistance = operation.stepover
  const moves: ToolpathMove[] = []
  const warnings = [...resolved.warnings]
  let currentPosition: ToolpathPoint | null = null

  for (const band of resolved.bands) {
    const maxBandDepth = Math.max(0, Math.min(operation.maxCarveDepth, band.topZ - band.bottomZ))
    if (!(maxBandDepth > 0)) {
      warnings.push(`Band ${band.topZ} -> ${band.bottomZ} leaves no usable geometric V-carve depth`)
      continue
    }

    for (const region of band.regions) {
      currentPosition = buildHybridMovesForRegion(
        region,
        band.topZ,
        maxBandDepth,
        slope,
        safeZ,
        stepoverDistance,
        moves,
        currentPosition,
      )
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
