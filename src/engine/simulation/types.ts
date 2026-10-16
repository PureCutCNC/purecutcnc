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
import type { AroundFrame } from '../aroundFrame'
import type { ToolpathWarning } from '../toolpaths/warningCodes'

/**
 * A square blank being simulated (issue #1016 C2-R1). Transient simulation
 * input — it is never persisted in a project and never reaches the `.camj`
 * format.
 *
 * `side` is the blank's physical side. `frame` is the Around unroll frame the
 * unrolled sheet is framed in: its nominal reference cylinder keeps
 * `radius = side/2` and `circumference = π·side`, which is only the coordinate
 * mapping — the blank's real corners reach `side/√2` from the pivot. The true
 * turning axis stays at `frame.radius`, never at the corner radius.
 */
export interface SquareBarDescriptor {
  side: number
  frame: AroundFrame
}

export interface SimulationGrid {
  originX: number
  originY: number
  cellSize: number
  cols: number
  rows: number
  stockBottomZ: number
  stockTopZ: number
  wrap?: { axis: 'x' | 'y'; period: number }
  /**
   * Present only on a square-blank grid. Flat and round grids keep their exact
   * original keys and values.
   */
  squareBar?: SquareBarDescriptor
  /**
   * The immutable virgin square baseline, one radial height per cell. Present
   * only with `squareBar`; the physical cell values are a true square cross
   * section, so statistics compare each cell against its own baseline rather
   * than a uniform stock top. Never written after grid creation;
   * `topZ` is the mutable copy the cutter lowers.
   */
  initialTopZ?: Float32Array
  /**
   * The square blank's remaining canonical radial intervals (issue #1016
   * C2-R1F), present only with `squareBar`. Each entry is a cell's ordered,
   * disjoint `[lo, hi]` endpoint pairs; a missing key is virgin material and
   * an empty array is fully removed. Values are immutable after assignment: a
   * cut replaces a cell's canonical array, so a shared array can never alias
   * two grids. Never persisted — this is transient simulation state.
   *
   * `topZ` stays as the derived outermost remaining radial endpoint, for the
   * render envelope and compatibility only; it is never authoritative square
   * material and a physical removal that leaves the outer endpoint unchanged
   * still counts.
   */
  squareMaterial?: Map<number, readonly number[]>
  topZ: Float32Array
}

export interface DirtyRegion {
  colMin: number
  colMax: number
  rowMin: number
  rowMax: number
}

export interface SimulationBuildOptions {
  wrap?: SimulationGrid['wrap']
  targetLongAxisCells?: number
  /**
   * Simulate a square blank instead of a round bar (issue #1016 C2-R1).
   * Transient; validated at grid creation and never persisted.
   */
  squareBar?: SquareBarDescriptor
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
  warnings: ToolpathWarning[]
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
