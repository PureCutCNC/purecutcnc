import type { ToolType } from '../../types/project'

export interface SimulationGrid {
  originX: number
  originY: number
  cellSize: number
  cols: number
  rows: number
  stockBottomZ: number
  stockTopZ: number
  topZ: Float32Array
}

export interface SimulationBuildOptions {
  targetLongAxisCells?: number
}

export interface SimulationStats {
  removedCellCount: number
  minTopZ: number
  maxRemovedDepth: number
  processedMoveCount: number
}

export interface SimulationResult {
  grid: SimulationGrid
  stats: SimulationStats
  warnings: string[]
}

export interface SimulationReplayItem {
  operationId: string
  operationName: string
  toolRef: string | null
  toolType: ToolType
  toolRadius: number
  toolpath: import('../toolpaths/types').ToolpathResult
}
