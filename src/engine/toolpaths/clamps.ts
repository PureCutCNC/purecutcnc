import type { Clamp, Operation, Project } from '../../types/project'
import type { ToolpathBounds, ToolpathMove, ToolpathPoint, ToolpathResult } from './types'
import { normalizeToolForProject } from './geometry'

interface ExpandedClampBounds {
  clamp: Clamp
  minX: number
  maxX: number
  minY: number
  maxY: number
  requiredZ: number
}

function buildExpandedClampBounds(project: Project, operation?: Operation | null): ExpandedClampBounds[] {
  const clearanceXY = Math.max(0, project.meta.clampClearanceXY)
  const clearanceZ = Math.max(0, project.meta.clampClearanceZ)
  const toolRecord = operation?.toolRef
    ? project.tools.find((tool) => tool.id === operation.toolRef) ?? null
    : null
  const toolRadius = toolRecord ? normalizeToolForProject(toolRecord, project).radius : 0
  const expandedXY = clearanceXY + Math.max(0, toolRadius)

  return project.clamps
    .filter((clamp) => clamp.visible)
    .map((clamp) => ({
      clamp,
      minX: clamp.x - expandedXY,
      maxX: clamp.x + clamp.w + expandedXY,
      minY: clamp.y - expandedXY,
      maxY: clamp.y + clamp.h + expandedXY,
      requiredZ: clamp.height + clearanceZ,
    }))
}

function pointInRect(x: number, y: number, rect: ExpandedClampBounds): boolean {
  return x >= rect.minX && x <= rect.maxX && y >= rect.minY && y <= rect.maxY
}

function segmentIntersectsRect2D(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rect: ExpandedClampBounds,
): boolean {
  if (pointInRect(x0, y0, rect) || pointInRect(x1, y1, rect)) {
    return true
  }

  const dx = x1 - x0
  const dy = y1 - y0
  let t0 = 0
  let t1 = 1

  const clip = (p: number, q: number): boolean => {
    if (Math.abs(p) < 1e-9) {
      return q >= 0
    }

    const r = q / p
    if (p < 0) {
      if (r > t1) return false
      if (r > t0) t0 = r
      return true
    }

    if (r < t0) return false
    if (r < t1) t1 = r
    return true
  }

  return (
    clip(-dx, x0 - rect.minX)
    && clip(dx, rect.maxX - x0)
    && clip(-dy, y0 - rect.minY)
    && clip(dy, rect.maxY - y0)
    && t0 <= t1
  )
}

function moveIntersectsClamp(move: ToolpathMove, rect: ExpandedClampBounds): boolean {
  return segmentIntersectsRect2D(
    move.from.x,
    move.from.y,
    move.to.x,
    move.to.y,
    rect,
  )
}

function describeMoveKind(kind: ToolpathMove['kind']): string {
  switch (kind) {
    case 'rapid':
      return 'rapid'
    case 'plunge':
      return 'plunge'
    case 'lead_in':
      return 'lead-in'
    case 'lead_out':
      return 'lead-out'
    case 'cut':
      return 'cut'
  }
}

function clonePoint(point: ToolpathPoint): ToolpathPoint {
  return { ...point }
}

function moveBoundsUpdate(bounds: ToolpathBounds | null, point: ToolpathPoint): ToolpathBounds {
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

function computeBounds(moves: ToolpathMove[]): ToolpathBounds | null {
  let bounds: ToolpathBounds | null = null
  for (const move of moves) {
    bounds = moveBoundsUpdate(bounds, move.from)
    bounds = moveBoundsUpdate(bounds, move.to)
  }
  return bounds
}

function intersectingClamps(move: ToolpathMove, clamps: ExpandedClampBounds[]): ExpandedClampBounds[] {
  return clamps.filter((rect) => moveIntersectsClamp(move, rect))
}

function canAutoLiftRapid(move: ToolpathMove, clamps: ExpandedClampBounds[]): boolean {
  if (move.kind !== 'rapid') {
    return false
  }

  for (const rect of clamps) {
    if ((pointInRect(move.from.x, move.from.y, rect) && move.from.z < rect.requiredZ)
      || (pointInRect(move.to.x, move.to.y, rect) && move.to.z < rect.requiredZ)) {
      return false
    }
  }

  return true
}

function liftRapidMove(move: ToolpathMove, requiredZ: number): ToolpathMove[] {
  const liftedMoves: ToolpathMove[] = []
  const traverseZ = Math.max(requiredZ, move.from.z, move.to.z)

  let current = clonePoint(move.from)

  if (current.z !== traverseZ) {
    const lifted = { x: current.x, y: current.y, z: traverseZ }
    liftedMoves.push({ kind: 'rapid', from: current, to: lifted })
    current = lifted
  }

  if (current.x !== move.to.x || current.y !== move.to.y) {
    const traverse = { x: move.to.x, y: move.to.y, z: traverseZ }
    liftedMoves.push({ kind: 'rapid', from: current, to: traverse })
    current = traverse
  }

  if (current.z !== move.to.z) {
    liftedMoves.push({ kind: 'rapid', from: current, to: clonePoint(move.to) })
  }

  return liftedMoves.length > 0 ? liftedMoves : [move]
}

export function applyClampWarnings(project: Project, result: ToolpathResult, operation?: Operation | null): ToolpathResult {
  if (result.moves.length === 0 || project.clamps.length === 0) {
    return result
  }

  const expandedClamps = buildExpandedClampBounds(project, operation)
  if (expandedClamps.length === 0) {
    return result
  }

  const maxTravelZ = Math.max(0, project.meta.maxTravelZ)
  const adjustedMoves: ToolpathMove[] = []
  const collidingClampIds = new Set<string>()
  const warningCounts = new Map<string, { clamp: Clamp; kind: ToolpathMove['kind']; count: number; minActualZ: number; requiredZ: number }>()
  const travelLimitWarnings = new Set<string>()

  for (const move of result.moves) {
    const intersections = intersectingClamps(move, expandedClamps)
    if (intersections.length === 0) {
      adjustedMoves.push(move)
      continue
    }

    const actualMinZ = Math.min(move.from.z, move.to.z)
    const unsafe = intersections.filter((rect) => actualMinZ < rect.requiredZ)
    if (unsafe.length === 0) {
      adjustedMoves.push(move)
      continue
    }

    for (const rect of unsafe) {
      collidingClampIds.add(rect.clamp.id)
    }

    const requiredZ = unsafe.reduce((max, rect) => Math.max(max, rect.requiredZ), 0)
    if (requiredZ > maxTravelZ) {
      for (const rect of unsafe) {
        if (rect.requiredZ > maxTravelZ) {
          travelLimitWarnings.add(
            `Clamp "${rect.clamp.name}" requires clearance Z ${rect.requiredZ.toFixed(3)}, which exceeds project max travel Z ${maxTravelZ.toFixed(3)}.`,
          )
        }
      }
    } else if (canAutoLiftRapid(move, unsafe)) {
      adjustedMoves.push(...liftRapidMove(move, requiredZ))
      continue
    }

    adjustedMoves.push(move)

    for (const rect of unsafe) {
      const key = `${rect.clamp.id}:${move.kind}`
      const existing = warningCounts.get(key)
      if (existing) {
        existing.count += 1
        existing.minActualZ = Math.min(existing.minActualZ, actualMinZ)
      } else {
        warningCounts.set(key, {
          clamp: rect.clamp,
          kind: move.kind,
          count: 1,
          minActualZ: actualMinZ,
          requiredZ: rect.requiredZ,
        })
      }
    }
  }

  if (warningCounts.size === 0 && adjustedMoves.length === result.moves.length) {
    return result
  }

  const warnings = [...result.warnings]
  warnings.push(...travelLimitWarnings)
  for (const entry of warningCounts.values()) {
    warnings.push(
      `Clamp "${entry.clamp.name}" is crossed by ${entry.count} ${describeMoveKind(entry.kind)} move${entry.count === 1 ? '' : 's'} below required clearance (min Z ${entry.minActualZ.toFixed(3)}, required Z ${entry.requiredZ.toFixed(3)}).`,
    )
  }

  return {
    ...result,
    moves: adjustedMoves,
    warnings,
    bounds: computeBounds(adjustedMoves),
    collidingClampIds: [...collidingClampIds],
  }
}
