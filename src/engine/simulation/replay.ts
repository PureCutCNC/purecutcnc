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

import type { Operation, Project } from '../../types/project'
import { normalizeToolForProject } from '../toolpaths/geometry'
import type { ToolpathMove, ToolpathResult } from '../toolpaths/types'
import { createSimulationGrid } from './grid'
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

export function applyMoveToGrid(
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

      const toolCenterZ = xyStationary ? stationaryZ : z0 + segDz * t

      let cutZ: number
      if (isBall) {
        const clampedSq = Math.min(toolRadiusSq, distanceSq)
        cutZ = toolCenterZ + toolRadius - Math.sqrt(toolRadiusSq - clampedSq)
      } else if (isVBit) {
        cutZ = toolCenterZ + Math.sqrt(distanceSq) * vBitInvSlope
      } else {
        // flat_endmill and drill cut a flat bottom at the tool center Z.
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

function computeStats(grid: SimulationGrid, processedMoveCount: number): SimulationStats {
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

function replayItemIntoGrid(grid: SimulationGrid, item: SimulationReplayItem): { processedMoveCount: number; warnings: string[] } {
  const warnings: string[] = []
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
  const warnings: string[] = []
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
  const warnings: string[] = []
  const toolRecord = operation.toolRef
    ? project.tools.find((tool) => tool.id === operation.toolRef) ?? null
    : null

  if (!toolRecord) {
    warnings.push('No tool assigned to the selected operation.')
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
