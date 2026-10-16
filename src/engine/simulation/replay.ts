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

import { findOperationTool } from '../../toolPolicy'
import type { Operation, Project } from '../../types/project'
import type { ToolpathWarning } from '../toolpaths/warningCodes'
import { normalizeToolForProject } from '../toolpaths/geometry'
import type { ToolpathMove, ToolpathResult } from '../toolpaths/types'
import { createSimulationGrid } from './grid'
import { applySquareMoveToGrid } from './squareMaterial'
import type { DirtyRegion, SimulationBuildOptions, SimulationGrid, SimulationReplayItem, SimulationResult, SimulationStats } from './types'

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function pointToCellRange(min: number, max: number, origin: number, cellSize: number, count: number): [number, number] {
  const start = clamp(Math.floor((min - origin) / cellSize), 0, count - 1)
  const end = clamp(Math.floor((max - origin) / cellSize), 0, count - 1)
  return [Math.min(start, end), Math.max(start, end)]
}

export function moveIsMaterialRemoving(move: ToolpathMove): boolean {
  return move.kind === 'cut' || move.kind === 'plunge' || move.kind === 'lead_in' || move.kind === 'lead_out'
}

export interface ApplyMoveResult {
  changedCount: number
  dirtyRegion: DirtyRegion | null
}

function applyMoveKernel(
  grid: SimulationGrid,
  move: ToolpathMove,
  toolRadius: number,
  toolType: SimulationReplayItem['toolType'],
  vBitAngle: number | null,
): ApplyMoveResult {
  const minX = Math.min(move.from.x, move.to.x) + -toolRadius
  const maxX = Math.max(move.from.x, move.to.x) + toolRadius
  const minY = Math.min(move.from.y, move.to.y) + -toolRadius
  const maxY = Math.max(move.from.y, move.to.y) + toolRadius

  const [colStart, colEnd] = pointToCellRange(minX, maxX, grid.originX, grid.cellSize, grid.cols)
  const [rowStart, rowEnd] = pointToCellRange(minY, maxY, grid.originY, grid.cellSize, grid.rows)
  let changed = 0
  let dirtyColMin = grid.cols
  let dirtyColMax = -1
  let dirtyRowMin = grid.rows
  let dirtyRowMax = -1

  const x0 = move.from.x
  const y0 = move.from.y
  const z0 = move.from.z
  const segDx = move.to.x - x0
  const segDy = move.to.y - y0
  const segDz = move.to.z - z0
  const segLengthSq = segDx * segDx + segDy * segDy
  const xyStationary = segLengthSq <= 1e-12
  const invSegLengthSq = xyStationary ? 0 : 1 / segLengthSq
  const stationaryZ = Math.min(move.from.z, move.to.z)

  // This is the hottest loop in the simulator (called per sub-move per frame
  // during playback and for the whole path on seeks/replays), so the cutter
  // profile is dispatched once per move and the distance math is inlined with
  // a squared-distance early-out. Flat endmills and drills never pay a sqrt.
  const radiusWithTolerance = toolRadius + 1e-9
  const radiusSqWithTolerance = radiusWithTolerance * radiusWithTolerance
  const isBall = toolType === 'ball_endmill'
  const isVBit = toolType === 'v_bit'
  // A torch is a flat through-cut: one kerf wide, the full sheet deep, at any Z
  // its path carries (the torch rides at cut height above the sheet). Like
  // `isBall`/`isVBit`, the profile is chosen once per move, not per cell.
  const isPlasma = toolType === 'plasma'
  const toolRadiusSq = toolRadius * toolRadius
  let vBitInvSlope = 0
  if (isVBit) {
    const includedAngle = Math.max(1, Math.min(179, vBitAngle ?? 60))
    const slope = Math.tan((includedAngle * Math.PI) / 360)
    vBitInvSlope = slope > 1e-9 ? 1 / slope : 0
  }

  const topZ = grid.topZ
  const stockBottomZ = grid.stockBottomZ
  const cellSize = grid.cellSize
  const originX = grid.originX
  const originY = grid.originY

  for (let row = rowStart; row <= rowEnd; row += 1) {
    const y = originY + (row + 0.5) * cellSize
    const rowBase = row * grid.cols
    for (let col = colStart; col <= colEnd; col += 1) {
      const x = originX + (col + 0.5) * cellSize

      let t: number
      if (xyStationary) {
        t = 0
      } else {
        t = ((x - x0) * segDx + (y - y0) * segDy) * invSegLengthSq
        if (t < 0) t = 0
        else if (t > 1) t = 1
      }
      const ddx = x - (x0 + segDx * t)
      const ddy = y - (y0 + segDy * t)
      const distanceSq = ddx * ddx + ddy * ddy
      if (distanceSq > radiusSqWithTolerance) {
        continue
      }

      const toolCenterZ = isPlasma
        ? stockBottomZ
        : xyStationary ? stationaryZ : z0 + segDz * t

      let cutZ: number
      if (isBall) {
        const clampedSq = Math.min(toolRadiusSq, distanceSq)
        cutZ = toolCenterZ + toolRadius - Math.sqrt(toolRadiusSq - clampedSq)
      } else if (isVBit) {
        cutZ = toolCenterZ + Math.sqrt(distanceSq) * vBitInvSlope
      } else {
        // flat_endmill, drill and the plasma torch cut a flat bottom at the
        // tool center Z (the torch's is forced to the stock bottom above).
        cutZ = toolCenterZ
      }

      const idx = rowBase + col
      const nextZ = cutZ > stockBottomZ ? cutZ : stockBottomZ
      if (nextZ < topZ[idx] - 1e-9) {
        topZ[idx] = nextZ
        changed += 1
        if (col < dirtyColMin) dirtyColMin = col
        if (col > dirtyColMax) dirtyColMax = col
        if (row < dirtyRowMin) dirtyRowMin = row
        if (row > dirtyRowMax) dirtyRowMax = row
      }
    }
  }

  return {
    changedCount: changed,
    dirtyRegion: changed > 0 ? { colMin: dirtyColMin, colMax: dirtyColMax, rowMin: dirtyRowMin, rowMax: dirtyRowMax } : null,
  }
}

/**
 * A square-blank grid replays through the physical polar kernel: a radial
 * heightfield's flat-sheet distance math would carve grooves that the finite
 * cutter never makes (issue #1016 C2-R1). Every flat/round grid keeps the
 * kernel and seam copies below byte-identical.
 */
export function applyMoveToGrid(
  grid: SimulationGrid,
  move: ToolpathMove,
  toolRadius: number,
  toolType: SimulationReplayItem['toolType'],
  vBitAngle: number | null,
): ApplyMoveResult {
  if (grid.squareBar) {
    return applySquareMoveToGrid(grid, move, toolRadius, toolType)
  }
  const result = applyMoveKernel(grid, move, toolRadius, toolType, vBitAngle)
  if (!grid.wrap) return result
  // Periodic cutter overlap is dispatched outside the unchanged cell kernel.
  const { axis, period } = grid.wrap
  const low = axis === 'x' ? grid.originX : grid.originY
  const min = Math.min(move.from[axis], move.to[axis]) - toolRadius
  const max = Math.max(move.from[axis], move.to[axis]) + toolRadius
  const shifts: number[] = []
  if (min < low) shifts.push(period)
  if (max > low + period) shifts.push(-period)
  for (const shift of shifts) {
    const shifted = {
      ...move,
      from: { ...move.from, [axis]: move.from[axis] + shift },
      to: { ...move.to, [axis]: move.to[axis] + shift },
    }
    const copy = applyMoveKernel(grid, shifted, toolRadius, toolType, vBitAngle)
    result.changedCount += copy.changedCount
    if (copy.dirtyRegion) {
      const region = result.dirtyRegion
      result.dirtyRegion = region ? {
        colMin: Math.min(region.colMin, copy.dirtyRegion.colMin),
        colMax: Math.max(region.colMax, copy.dirtyRegion.colMax),
        rowMin: Math.min(region.rowMin, copy.dirtyRegion.rowMin),
        rowMax: Math.max(region.rowMax, copy.dirtyRegion.rowMax),
      } : copy.dirtyRegion
    }
  }
  return result
}

function computeStats(grid: SimulationGrid, processedMoveCount: number): SimulationStats {
  // A square blank's virgin surface is its true cross section, not a uniform
  // stock top, so each cell is measured against the immutable baseline (issue
  // #1016 C2-R1). A physical removal counts even when it only takes an interior
  // radial band and leaves the cell's outer `topZ` unchanged, which is why the
  // count reads the remaining canonical intervals rather than `topZ`.
  if (grid.squareBar && grid.initialTopZ) {
    const baseline = grid.initialTopZ
    let removedCellCount = 0
    let minTopZ = grid.stockTopZ
    let maxRemovedDepth = 0
    for (let index = 0; index < grid.topZ.length; index += 1) {
      const z = grid.topZ[index]
      if (z < minTopZ) minTopZ = z
      // Only a cell the cutter actually changed is ever written into the map,
      // so a present key is a physical removal — even when the cell's outer
      // endpoint did not move.
      const intervals = grid.squareMaterial?.get(index)
      if (intervals === undefined) continue
      removedCellCount += 1
      // The deepest removed radial point: when the core still reaches the stock
      // bottom it is the low edge of the first removed band; otherwise the
      // material below the innermost kept interval was cut to the bottom.
      let deepestRemoved = grid.stockBottomZ
      if (intervals.length >= 2 && intervals[0] <= grid.stockBottomZ + 1e-9) {
        deepestRemoved = intervals[1]
      }
      const depth = baseline[index] - deepestRemoved
      if (depth > maxRemovedDepth) maxRemovedDepth = depth
    }
    return { removedCellCount, minTopZ, maxRemovedDepth, processedMoveCount }
  }

  let removedCellCount = 0
  let minTopZ = grid.stockTopZ

  for (let index = 0; index < grid.topZ.length; index += 1) {
    const z = grid.topZ[index]
    minTopZ = Math.min(minTopZ, z)
    if (z < grid.stockTopZ - 1e-9) {
      removedCellCount += 1
    }
  }

  return {
    removedCellCount,
    minTopZ,
    maxRemovedDepth: Math.max(0, grid.stockTopZ - minTopZ),
    processedMoveCount,
  }
}

function replayItemIntoGrid(grid: SimulationGrid, item: SimulationReplayItem): { processedMoveCount: number; warnings: ToolpathWarning[] } {
  const warnings: ToolpathWarning[] = []
  let processedMoveCount = 0
  for (const move of item.toolpath.moves) {
    if (!moveIsMaterialRemoving(move)) {
      continue
    }

    applyMoveToGrid(grid, move, item.toolRadius, item.toolType, item.vBitAngle)
    processedMoveCount += 1
  }

  return { processedMoveCount, warnings }
}

export function simulateReplayItemsHeightfield(
  project: Project,
  items: SimulationReplayItem[],
  options: SimulationBuildOptions = {},
): SimulationResult {
  const grid = createSimulationGrid(project, options)
  const warnings: ToolpathWarning[] = []
  let processedMoveCount = 0

  for (const item of items) {
    const replay = replayItemIntoGrid(grid, item)
    processedMoveCount += replay.processedMoveCount
    warnings.push(...replay.warnings)
  }

  return {
    grid,
    stats: computeStats(grid, processedMoveCount),
    warnings,
  }
}

export function simulateOperationHeightfield(
  project: Project,
  operation: Operation,
  toolpath: ToolpathResult,
  options: SimulationBuildOptions = {},
): SimulationResult {
  const grid = createSimulationGrid(project, options)
  const warnings: ToolpathWarning[] = []
  const toolRecord = findOperationTool(project, operation)

  if (!toolRecord) {
    warnings.push({ code: 'replayNoTool' })
    return { grid, stats: computeStats(grid, 0), warnings }
  }

  const tool = normalizeToolForProject(toolRecord, project)
  const replay = replayItemIntoGrid(grid, {
    operationId: operation.id,
    operationName: operation.name,
    toolRef: toolRecord.id,
    toolType: toolRecord.type,
    toolRadius: tool.radius,
    vBitAngle: tool.vBitAngle,
    toolpath,
  })
  warnings.push(...replay.warnings)

  return {
    grid,
    stats: computeStats(grid, replay.processedMoveCount),
    warnings,
  }
}
