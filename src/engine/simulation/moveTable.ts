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

/**
 * Winner-move shading data (issue #1209). The flat replay records, per cell,
 * which move set the cell's height (`SimulationGrid.winners`); this table holds
 * those moves so the surface shader can evaluate their exact cutter surfaces at
 * any point inside a cell, not only at its centre.
 *
 * Layout matches the GPU texture: 8 floats per move, `from.xyz, toolSlot,
 * to.xyz, 0`. Tool slots carry the cutter profile once per tool, not per move.
 */

import type { ToolpathMove } from '../toolpaths/types'
import type { SimulationReplayItem } from './types'

/** A cell no move has cut: the shader takes the stock top there. */
export const WINNER_NONE = 0xffffffff
/**
 * A cell lowered by a move the table does not hold (a caller that cut without
 * a winner index). The shader keeps the cell-sampled surface wherever it sees
 * one, so a missing index can never paint uncut stock.
 */
export const WINNER_UNKNOWN = 0xfffffffe
/** Floats per move in `data`, and two RGBA texels on the GPU. */
export const MOVE_TABLE_STRIDE = 8
/** The most tool slots one table holds (the shader's uniform array size). */
export const MOVE_TABLE_MAX_TOOLS = 8

export interface MoveTableTool {
  toolType: SimulationReplayItem['toolType']
  toolRadius: number
  vBitAngle: number | null
}

export interface SimulationMoveTable {
  /** `count × MOVE_TABLE_STRIDE` floats; capacity may exceed `count`. */
  data: Float32Array
  count: number
  tools: MoveTableTool[]
}

export function createMoveTable(capacity = 1024): SimulationMoveTable {
  return { data: new Float32Array(Math.max(1, capacity) * MOVE_TABLE_STRIDE), count: 0, tools: [] }
}

/**
 * A copy of `source` that further moves can be appended to without touching
 * it: playback appends the played operation to the prior operations' table,
 * so the base grid's winner indices stay valid in the live grid.
 */
export function extendMoveTable(source: SimulationMoveTable | undefined, extra: number): SimulationMoveTable {
  const count = source?.count ?? 0
  const table = createMoveTable(count + Math.max(0, extra))
  if (source) {
    table.data.set(source.data.subarray(0, count * MOVE_TABLE_STRIDE))
    table.count = count
    table.tools = source.tools.slice()
  }
  return table
}

/**
 * The slot for a cutter, added on first use. Returns -1 once the table holds
 * `MOVE_TABLE_MAX_TOOLS` other cutters; the caller then records no winners.
 */
export function moveTableToolSlot(table: SimulationMoveTable, tool: MoveTableTool): number {
  const found = table.tools.findIndex((entry) =>
    entry.toolType === tool.toolType && entry.toolRadius === tool.toolRadius && entry.vBitAngle === tool.vBitAngle)
  if (found >= 0) return found
  if (table.tools.length >= MOVE_TABLE_MAX_TOOLS) return -1
  table.tools.push({ toolType: tool.toolType, toolRadius: tool.toolRadius, vBitAngle: tool.vBitAngle })
  return table.tools.length - 1
}

/** Append one move and return its index. */
export function appendMoveTableEntry(table: SimulationMoveTable, move: ToolpathMove, slot: number): number {
  if ((table.count + 1) * MOVE_TABLE_STRIDE > table.data.length) {
    const grown = new Float32Array(Math.max(table.data.length * 2, (table.count + 1) * MOVE_TABLE_STRIDE))
    grown.set(table.data)
    table.data = grown
  }
  const o = table.count * MOVE_TABLE_STRIDE
  const data = table.data
  data[o] = move.from.x
  data[o + 1] = move.from.y
  data[o + 2] = move.from.z
  data[o + 3] = slot
  data[o + 4] = move.to.x
  data[o + 5] = move.to.y
  data[o + 6] = move.to.z
  data[o + 7] = 0
  table.count += 1
  return table.count - 1
}

/** Squared XY distance from (x, y) to table move `index`'s segment. */
export function moveTableDistanceSq(table: SimulationMoveTable, index: number, x: number, y: number): number {
  const data = table.data
  const o = index * MOVE_TABLE_STRIDE
  const x0 = data[o]
  const y0 = data[o + 1]
  const dx = data[o + 4] - x0
  const dy = data[o + 5] - y0
  const lengthSq = dx * dx + dy * dy
  let t = lengthSq > 1e-12 ? ((x - x0) * dx + (y - y0) * dy) / lengthSq : 0
  if (t < 0) t = 0
  else if (t > 1) t = 1
  const ex = x - (x0 + dx * t)
  const ey = y - (y0 + dy * t)
  return ex * ex + ey * ey
}

/** The tool radius of table move `index`. */
export function moveTableRadius(table: SimulationMoveTable, index: number): number {
  return table.tools[table.data[index * MOVE_TABLE_STRIDE + 3]].toolRadius
}

/**
 * How deeply the cell centre at (x, y) sits inside table move `index`'s
 * footprint: its tool radius minus the distance to the move's segment. The
 * flat kernel's tie rule compares this between two moves that leave a cell at
 * the same height.
 */
export function moveTableReach(table: SimulationMoveTable, index: number, x: number, y: number): number {
  return moveTableRadius(table, index) - Math.sqrt(moveTableDistanceSq(table, index, x, y))
}

/** Room for `extra` more moves without regrowing (a replay knows its count up front). */
export function reserveMoveTable(table: SimulationMoveTable, extra: number): void {
  const needed = (table.count + extra) * MOVE_TABLE_STRIDE
  if (needed <= table.data.length) return
  const grown = new Float32Array(needed)
  grown.set(table.data.subarray(0, table.count * MOVE_TABLE_STRIDE))
  table.data = grown
}
