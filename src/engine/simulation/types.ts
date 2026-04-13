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
  vBitAngle: number | null
  toolpath: import('../toolpaths/types').ToolpathResult
}
