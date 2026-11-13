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
 * A square blank being simulated (issue #1016 C2). Transient simulation
 * initialization input — it is never persisted in a project and never reaches
 * the `.camj` format.
 *
 * `side` is the blank's physical side. `frame` is the Around unroll frame the
 * unrolled sheet is framed in: its nominal reference cylinder keeps
 * `radius = side/2` and `circumference = π·side`, which is only the coordinate
 * mapping — the blank's real corners reach `side/√2` from the pivot. The true
 * turning axis stays at `frame.radius`, never at the corner radius.
 *
 * The descriptor seeds the grid's starting heights in `createSimulationGrid`
 * and then leaves the picture: a square grid is simulated by the same radial
 * heightfield as the round bar, so nothing downstream needs to know the blank
 * was square.
 */
export interface SquareBarDescriptor {
  side: number
  frame: AroundFrame
}

/**
 * A round bar being simulated from a flat (Top or Bottom) setup (issue #1049).
 * Transient simulation initialization input — never persisted, never carried on
 * the grid.
 *
 * A flat setup simulates on the top-down heightfield, so the bar's bounding
 * rectangle used to seed every cell at the full stock thickness: the round bar
 * was drawn as a square block. This descriptor is the bar's real profile as
 * seen from that face — the upper half of the cylinder — so the grid starts
 * curved instead.
 *
 * `pivot` is the turning axis height (`barPivotZ`), `radius` is the bar radius
 * (`barInscribedRadius`) and `length` is the bar's extent along `axis`
 * (`barLength`), all in project units. `centre` is the centreline coordinate
 * across the bar: a Y value for axis `'x'`, an X value for axis `'y'`, in the
 * setup-local frame the grid is built in. A Bottom setup sees the same profile
 * as Top, because a round bar is symmetric about its axis.
 *
 * The grid seeds only from `pivot`/`radius`/`centre`; `length` is what the
 * static lower half (the half a cutter from above cannot reach) has to span.
 */
export interface FlatRoundBarDescriptor {
  axis: 'x' | 'y'
  pivot: number
  radius: number
  centre: number
  length: number
}

export interface SimulationGrid {
  originX: number
  originY: number
  cellSize: number
  cols: number
  rows: number
  stockBottomZ: number
  /**
   * The grid's enclosing radial maximum. For a round or flat grid this is the
   * uniform starting height; for a square blank it is the corner radius
   * (`side/√2`) while the true turning pivot stays at `frame.radius`. Render
   * bounds and framing read it; the cutter never does.
   */
  stockTopZ: number
  wrap?: { axis: 'x' | 'y'; period: number }
  /**
   * An immutable starting baseline, one height per cell, present only when the
   * cells do not all start at `stockTopZ` — i.e. a square blank's true cross
   * section (issue #1016 C2). Used ONLY by removal statistics, which compare
   * each cell against its own start rather than a uniform top. Never written
   * after grid creation; `topZ` is the mutable copy the cutter lowers.
   */
  initialTopZ?: Float32Array
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
   * Seed the grid with a square blank's true cross section instead of a
   * uniform `stockTopZ` (issue #1016 C2). Initialization only — validated at
   * grid creation, never persisted, and never carried on the grid.
   */
  squareBar?: SquareBarDescriptor
  /**
   * Seed a flat (Top/Bottom) grid with a round bar's true profile instead of
   * its bounding box (issue #1049). Initialization only — validated at grid
   * creation, never persisted, and never carried on the grid. Mutually
   * exclusive with `squareBar` and with `wrap`.
   */
  flatRoundBar?: FlatRoundBarDescriptor
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
