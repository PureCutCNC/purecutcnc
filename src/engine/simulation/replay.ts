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
import { cutterRayIntervalInPlace } from './tools'
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
 * How far, in unrolled across coordinate, a wrapped cutter can reach beyond its
 * own angular position (issue #1016 C2-F8).
 *
 * The nominal footprint is the cutter radius, but a cell cut below the frame
 * radius sits on a smaller circle and needs only `r·sin(D) <= rt`, so its
 * angular reach is wider. A cell the cutter can lower has `r > floor`, where
 * `floor` is the deepest the cutter's tip can go in this move (a column is never
 * lowered below the tip or the stock bottom), so `|D| <= asin(rt / floor)` is the
 * exact bound. Above the frame radius the flat footprint already covers it.
 */
function wrappedAcrossReach(frameRadius: number, toolRadius: number, floor: number): number {
  if (floor <= toolRadius) return (Math.PI / 2) * frameRadius
  return Math.max(toolRadius, frameRadius * Math.asin(toolRadius / floor))
}

/**
 * The wrapped (Around) cut kernel (issue #1016 C2-F8): the same bounding box
 * and per-move parameterization as {@link applyMoveKernel}, but each cell is
 * resolved against the cutter's true solid instead of the flat-sheet circle.
 *
 * In the unrolled sheet an across distance `u` is arc length at the frame
 * radius `R0 = period / 2π`, i.e. an angle `u / R0`. A cell at radius `r` and
 * angle `D` from the tool line is therefore `r·sin D` across the cutter and
 * `r·cos D` along it, not `u` across and flat. `cutterRayInterval` turns that
 * into the exact radial span this column loses. A cell keeps one radius, so the
 * cutter only lowers it when it also reaches the outside (`top <= hi`); a cutter
 * that passes through the middle leaves the outer shell in place. Cells are
 * never raised.
 *
 * `sweep` is the move the cutter position is resolved against — normally the
 * move itself, but playback passes the move it subdivided or partially applied.
 * The cell's parameter along the sweep is then the same however the path was
 * cut up, so splitting a move cannot change the material (F8 keeps playback
 * exactly equal to a batch replay); a partial application still only cuts the
 * cells whose parameter lies inside it, so nothing is removed ahead of the tool.
 */
function applyWrappedMoveKernel(
  grid: SimulationGrid,
  move: ToolpathMove,
  toolRadius: number,
  toolType: SimulationReplayItem['toolType'],
  vBitAngle: number | null,
  sweep: ToolpathMove,
): ApplyMoveResult {
  // The sheet's across coordinate is arc length at the frame radius, so the
  // angular distance from the tool line is `across / R0`. The bar axis is the
  // other sheet axis; nothing downstream needs the stock shape.
  const wrap = grid.wrap
  if (!wrap) return { changedCount: 0, dirtyRegion: null }
  const acrossIsX = wrap.axis === 'x'
  const frameRadius = wrap.period / (2 * Math.PI)
  const invFrameRadius = 1 / frameRadius

  // The sweep is the full move the cutter position is resolved on; `move` only
  // bounds the cells this application may touch.
  const sweepX = sweep.from.x
  const sweepY = sweep.from.y
  const sweepDx = sweep.to.x - sweepX
  const sweepDy = sweep.to.y - sweepY
  const sweepLengthSq = sweepDx * sweepDx + sweepDy * sweepDy
  const sweepStationary = sweepLengthSq <= 1e-12
  const invSweepLengthSq = sweepStationary ? 0 : 1 / sweepLengthSq
  const sweepZ0 = sweep.from.z
  const sweepDz = sweep.to.z - sweepZ0
  // A plunge's depth is the deepest end of the piece actually applied, so its
  // sub-segments deepen progressively and their union is the full plunge.
  const stationaryZ = Math.min(move.from.z, move.to.z)

  // Axially the cutter spans one radius; across, an exact bound widens with
  // depth (see `wrappedAcrossReach`), so no cuttable cell is left outside the
  // box. The along axis keeps the plain radius.
  const tipFloor = Math.max(grid.stockBottomZ, Math.min(sweep.from.z, sweep.to.z))
  const acrossHalf = wrappedAcrossReach(frameRadius, toolRadius, tipFloor)
  const halfX = acrossIsX ? acrossHalf : toolRadius
  const halfY = acrossIsX ? toolRadius : acrossHalf
  const minX = Math.min(move.from.x, move.to.x) - halfX
  const maxX = Math.max(move.from.x, move.to.x) + halfX
  const minY = Math.min(move.from.y, move.to.y) - halfY
  const maxY = Math.max(move.from.y, move.to.y) + halfY

  const [colStart, colEnd] = pointToCellRange(minX, maxX, grid.originX, grid.cellSize, grid.cols)
  const [rowStart, rowEnd] = pointToCellRange(minY, maxY, grid.originY, grid.cellSize, grid.rows)
  let changed = 0
  let dirtyColMin = grid.cols
  let dirtyColMax = -1
  let dirtyRowMin = grid.rows
  let dirtyRowMax = -1
  const alongFrom = acrossIsX ? sweepY : sweepX
  const alongDelta = acrossIsX ? sweepDy : sweepDx
  const acrossFrom = acrossIsX ? sweepX : sweepY
  const acrossDelta = acrossIsX ? sweepDx : sweepDy

  // The span of the sweep this application covers, in sweep parameters. For a
  // whole-move replay this is exactly [0, 1]; for a playback piece it is the
  // piece's own span, so cells are cut once, at their sweep parameter.
  let tMin = 0
  let tMax = 1
  if (!sweepStationary) {
    const fromT = ((move.from.x - sweepX) * sweepDx + (move.from.y - sweepY) * sweepDy) * invSweepLengthSq
    const toT = ((move.to.x - sweepX) * sweepDx + (move.to.y - sweepY) * sweepDy) * invSweepLengthSq
    tMin = Math.min(fromT, toT) - 1e-12
    tMax = Math.max(fromT, toT) + 1e-12
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

      let t = 0
      if (!sweepStationary) {
        t = ((x - sweepX) * sweepDx + (y - sweepY) * sweepDy) * invSweepLengthSq
        if (t < 0) t = 0
        else if (t > 1) t = 1
        if (t < tMin || t > tMax) continue
      }
      const toolCenterZ = sweepStationary ? stationaryZ : sweepZ0 + sweepDz * t
      const alongCell = acrossIsX ? y : x
      const acrossCell = acrossIsX ? x : y
      const alongOffset = alongCell - (alongFrom + alongDelta * t)
      // Cheap exact reject before the trigonometric work: no profile reaches
      // further from the cutter's axial plane than the cutter's radius.
      if (alongOffset > toolRadius || alongOffset < -toolRadius) continue
      const angle = (acrossCell - (acrossFrom + acrossDelta * t)) * invFrameRadius

      const interval = cutterRayIntervalInPlace(toolType, toolRadius, toolCenterZ, vBitAngle, alongOffset, angle)
      if (interval === null) continue
      const idx = rowBase + col
      const top = topZ[idx]
      // The cutter passes through the middle of the column without reaching
      // the outside: one radius per cell cannot represent the surviving shell,
      // so leave it untouched rather than lower it.
      if (top > interval.hi) continue
      const nextZ = interval.lo > stockBottomZ ? interval.lo : stockBottomZ
      if (nextZ < top - 1e-9) {
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
 * The one cutting path, for every blank shape: a square grid is a radial
 * heightfield whose cells simply start at their true cross-section heights, so
 * it goes through this kernel and the periodic seam copies with no branch
 * (issue #1016 C2). Flat grids and the plasma torch keep the original flat
 * kernel byte-for-byte; only a wrapped milled grid resolves the cutter's true
 * solid (F8).
 *
 * `sweep` is the source move a playback piece was cut from; it defaults to
 * `move`, and replay/static callers never pass it. Resolving the cutter against
 * the source move is what keeps a subdivided or partial playback exactly equal
 * to the batch replay of the same path.
 */
export function applyMoveToGrid(
  grid: SimulationGrid,
  move: ToolpathMove,
  toolRadius: number,
  toolType: SimulationReplayItem['toolType'],
  vBitAngle: number | null,
  sweep: ToolpathMove = move,
): ApplyMoveResult {
  // A torch is a one-kerf flat through-cut with no rotary solid to resolve, and
  // a flat grid is already exact: both keep the original kernel.
  const wrapped = grid.wrap !== undefined && toolType !== 'plasma'
  const result = wrapped
    ? applyWrappedMoveKernel(grid, move, toolRadius, toolType, vBitAngle, sweep)
    : applyMoveKernel(grid, move, toolRadius, toolType, vBitAngle)
  if (!grid.wrap) return result
  // Periodic cutter overlap is dispatched outside the unchanged cell kernel.
  const { axis, period } = grid.wrap
  const low = axis === 'x' ? grid.originX : grid.originY
  // A deep wrapped cut reaches further across than the cutter radius, and its
  // seam copy has to follow that same reach.
  const acrossReach = wrapped
    ? wrappedAcrossReach(
      period / (2 * Math.PI),
      toolRadius,
      Math.max(grid.stockBottomZ, Math.min(sweep.from.z, sweep.to.z)),
    )
    : toolRadius
  const min = Math.min(move.from[axis], move.to[axis]) - acrossReach
  const max = Math.max(move.from[axis], move.to[axis]) + acrossReach
  const shifts: number[] = []
  if (min < low) shifts.push(period)
  if (max > low + period) shifts.push(-period)
  for (const shift of shifts) {
    const shifted = {
      ...move,
      from: { ...move.from, [axis]: move.from[axis] + shift },
      to: { ...move.to, [axis]: move.to[axis] + shift },
    }
    const shiftedSweep = sweep === move ? shifted : {
      ...sweep,
      from: { ...sweep.from, [axis]: sweep.from[axis] + shift },
      to: { ...sweep.to, [axis]: sweep.to[axis] + shift },
    }
    const copy = wrapped
      ? applyWrappedMoveKernel(grid, shifted, toolRadius, toolType, vBitAngle, shiftedSweep)
      : applyMoveKernel(grid, shifted, toolRadius, toolType, vBitAngle)
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
  // A grid that does not start uniformly (a square blank's true cross section)
  // carries an immutable per-cell baseline, so removal is measured against each
  // cell's own start (issue #1016 C2). `minTopZ` is the lowest current height,
  // and the depth is the deepest drop from a cell's baseline — never
  // `stockTopZ - minTopZ`, which would invent removal on virgin stock.
  const baseline = grid.initialTopZ
  if (baseline) {
    let removedCellCount = 0
    let minTopZ = grid.stockTopZ
    let maxRemovedDepth = 0
    for (let index = 0; index < grid.topZ.length; index += 1) {
      const z = grid.topZ[index]
      if (z < minTopZ) minTopZ = z
      if (z < baseline[index] - 1e-9) removedCellCount += 1
      const depth = baseline[index] - z
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
