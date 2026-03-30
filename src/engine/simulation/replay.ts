import type { Operation, Project } from '../../types/project'
import { normalizeToolForProject } from '../toolpaths/geometry'
import type { ToolpathMove, ToolpathResult } from '../toolpaths/types'
import { createSimulationGrid } from './grid'
import { cutterSurfaceZ } from './tools'
import type { SimulationBuildOptions, SimulationGrid, SimulationReplayItem, SimulationResult, SimulationStats } from './types'

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function indexFor(grid: SimulationGrid, col: number, row: number): number {
  return row * grid.cols + col
}

function pointToCellRange(min: number, max: number, origin: number, cellSize: number, count: number): [number, number] {
  const start = clamp(Math.floor((min - origin) / cellSize), 0, count - 1)
  const end = clamp(Math.floor((max - origin) / cellSize), 0, count - 1)
  return [Math.min(start, end), Math.max(start, end)]
}

function pointSegmentDistanceAndT(
  px: number,
  py: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): { distance: number; t: number } {
  const dx = x1 - x0
  const dy = y1 - y0
  const lengthSq = dx * dx + dy * dy

  if (lengthSq <= 1e-12) {
    const ddx = px - x0
    const ddy = py - y0
    return { distance: Math.hypot(ddx, ddy), t: 0 }
  }

  const t = clamp(((px - x0) * dx + (py - y0) * dy) / lengthSq, 0, 1)
  const cx = x0 + dx * t
  const cy = y0 + dy * t
  return { distance: Math.hypot(px - cx, py - cy), t }
}

function moveIsMaterialRemoving(move: ToolpathMove): boolean {
  return move.kind === 'cut' || move.kind === 'plunge' || move.kind === 'lead_in' || move.kind === 'lead_out'
}

function applyMoveToGrid(grid: SimulationGrid, move: ToolpathMove, toolRadius: number, toolType: 'flat_endmill'): number {
  const minX = Math.min(move.from.x, move.to.x) + -toolRadius
  const maxX = Math.max(move.from.x, move.to.x) + toolRadius
  const minY = Math.min(move.from.y, move.to.y) + -toolRadius
  const maxY = Math.max(move.from.y, move.to.y) + toolRadius

  const [colStart, colEnd] = pointToCellRange(minX, maxX, grid.originX, grid.cellSize, grid.cols)
  const [rowStart, rowEnd] = pointToCellRange(minY, maxY, grid.originY, grid.cellSize, grid.rows)
  let changed = 0

  for (let row = rowStart; row <= rowEnd; row += 1) {
    const y = grid.originY + (row + 0.5) * grid.cellSize
    for (let col = colStart; col <= colEnd; col += 1) {
      const x = grid.originX + (col + 0.5) * grid.cellSize
      const { distance, t } = pointSegmentDistanceAndT(x, y, move.from.x, move.from.y, move.to.x, move.to.y)
      const toolCenterZ = move.from.z + (move.to.z - move.from.z) * t
      const cutZ = cutterSurfaceZ(
        toolType,
        toolRadius,
        toolCenterZ,
        distance,
      )

      if (cutZ === null) {
        continue
      }

      const idx = indexFor(grid, col, row)
      const nextZ = Math.max(grid.stockBottomZ, cutZ)
      if (nextZ < grid.topZ[idx] - 1e-9) {
        grid.topZ[idx] = nextZ
        changed += 1
      }
    }
  }

  return changed
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
  if (item.toolType !== 'flat_endmill') {
    warnings.push(`Operation "${item.operationName}" uses unsupported tool type "${item.toolType}" for simulation.`)
    return { processedMoveCount: 0, warnings }
  }

  let processedMoveCount = 0
  for (const move of item.toolpath.moves) {
    if (!moveIsMaterialRemoving(move)) {
      continue
    }

    applyMoveToGrid(grid, move, item.toolRadius, 'flat_endmill')
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
    toolpath,
  })
  warnings.push(...replay.warnings)

  return {
    grid,
    stats: computeStats(grid, replay.processedMoveCount),
    warnings,
  }
}
