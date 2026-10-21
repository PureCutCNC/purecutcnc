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
 * The widest sheet-space angle any cell this move can lower may sit at (issue
 * #1016 C2-F8, F8b). This is the across bound of the per-move search box: the
 * tighter its profile, the fewer cells the hot loop touches.
 *
 * A cuttable cell always has `top > floor`, where `floor` is the deeper of the
 * stock bottom and the move's lowest tip: every profile's ray interval `lo` is
 * at or above its own tip, and a cell at or below the tip cannot be lowered. The
 * exact reach then depends on the solid, not just `rt / floor`:
 *
 *  - **Flat/drill.** The bottom face is the plane `x = tip`, radius `rt`. The
 *    widest ray from the bar axis that still meets the solid with `r >= floor`
 *    is `atan(rt / tip)` when the tip is above 0, and widens to `asin(rt/floor)`
 *    once the bottom face reaches the axis and the stock bottom is higher than
 *    the cutter. The old sheet bound `π/2 · R0` was up to twice too wide.
 *  - **Ball.** The nose's widest angular chord is the tangent from the pivot,
 *    `asin(rt / (tip + rt))`, far narrower than the flat cylinder's bound. Once
 *    the allowed radius is beyond that tangent, the shank's `asin(rt / floor)`
 *    covers it.
 *  - **V-bit.** The cone is widest at its truncation disc, so the bound is
 *    `atan(rt / (tip + rt / slope))`; a truncation at or below the pivot spans
 *    the whole half period.
 *
 * These are upper bounds on the solid, so no cuttable cell is skipped; the tests
 * check that against the dense oracle and the 25 mm square-to-round case.
 */
function wrappedAcrossReachAngle(
  toolType: SimulationReplayItem['toolType'],
  toolRadius: number,
  tipMin: number,
  tipFloor: number,
  vBitAngle: number | null,
): number {
  if (toolType === 'ball_endmill') {
    const centre = tipMin + toolRadius
    if (centre <= toolRadius) return Math.PI / 2
    const tangentRadiusSq = centre * centre - toolRadius * toolRadius
    if (tipFloor > 0 && tipFloor * tipFloor > tangentRadiusSq) {
      // The tangent is below the deepest cell the stock leaves cuttable; the
      // shank's cylinder bound is the safe one.
      return Math.asin(toolRadius / tipFloor)
    }
    return Math.asin(toolRadius / centre)
  }

  if (toolType === 'v_bit') {
    const includedAngle = Math.max(1, Math.min(179, vBitAngle ?? 60))
    const slope = Math.tan((includedAngle * Math.PI) / 360)
    if (slope <= 1e-9 || tipMin <= 0) return Math.PI / 2
    const truncation = tipMin + toolRadius / slope
    return truncation > 0 ? Math.atan(toolRadius / truncation) : Math.PI / 2
  }

  // flat_endmill and drill: a cylinder bottomed at the move's deepest tip.
  if (tipMin <= 0) {
    if (tipFloor <= 0) return Math.PI / 2
    return tipFloor <= toolRadius ? Math.PI / 2 : Math.asin(toolRadius / tipFloor)
  }
  if (tipFloor * tipFloor >= tipMin * tipMin + toolRadius * toolRadius) {
    return Math.asin(toolRadius / tipFloor)
  }
  return Math.atan(toolRadius / tipMin)
}

/** The single-event fast path, and the multi-event fixed point, in one place. */
function fixedPointTop(lo: readonly number[], hi: readonly number[], count: number, top: number, stockBottomZ: number): number {
  if (count === 0) return top
  let nextTop = top
  if (count === 1) {
    if (nextTop <= hi[0]) {
      const candidate = lo[0] > stockBottomZ ? lo[0] : stockBottomZ
      if (candidate < nextTop - 1e-9) nextTop = candidate
    }
    return nextTop
  }
  // The operators are monotone and deflationary; a fair sweep reaches their
  // greatest fixed point below `top` in at most eventCount + 1 passes. That
  // fixed point is what makes the result order-independent.
  for (let pass = 0; pass <= count; pass += 1) {
    let lowered = false
    for (let event = 0; event < count; event += 1) {
      if (nextTop > hi[event]) continue
      const candidate = lo[event] > stockBottomZ ? lo[event] : stockBottomZ
      if (candidate < nextTop - 1e-9) {
        nextTop = candidate
        lowered = true
      }
    }
    if (!lowered) break
  }
  return nextTop
}

/**
 * The interval one cutter image removes from one cell at sweep parameter `t`,
 * or `false` when that image misses the ray. Writes `wrappedRayScratch` so the
 * hot loop never allocates; read it immediately.
 */
const wrappedRayScratch = { lo: 0, hi: 0 }

function wrappedRayInterval(
  isBall: boolean,
  toolType: SimulationReplayItem['toolType'],
  toolRadius: number,
  vBitAngle: number | null,
  top: number,
  alongCell: number,
  acrossCell: number,
  alongFrom: number,
  alongDelta: number,
  acrossFrom: number,
  acrossDelta: number,
  imageShift: number,
  t: number,
  sweepStationary: boolean,
  stationaryZ: number,
  sweepZ0: number,
  sweepDz: number,
  invFrameRadius: number,
): boolean {
  const toolCenterZ = sweepStationary ? stationaryZ : sweepZ0 + sweepDz * t
  // Every profile's interval starts at or above its own tip.
  if (top <= toolCenterZ) return false
  const alongOffset = alongCell - (alongFrom + alongDelta * t)
  // No profile reaches further from its axial plane than its radius.
  if (alongOffset > toolRadius || alongOffset < -toolRadius) return false
  const angle = (acrossCell - (acrossFrom + imageShift + acrossDelta * t)) * invFrameRadius
  const absAngle = angle < 0 ? -angle : angle
  if (absAngle >= Math.PI / 2) return false
  if (isBall && toolCenterZ > 0) {
    // Cheap lower bound on the ball's entry radius on this ray. The nose entry
    // is `z + C·D²/2 - …` (C = z + rt); when the ray is beyond the sphere's
    // reach only the shank is left, whose entry is at least C. A cell at or
    // below this cannot be lowered.
    const c = toolCenterZ + toolRadius
    const absAngleSq = absAngle * absAngle
    const sinLower = absAngle - (absAngleSq * absAngle) / 6
    let loLower: number
    if (c * sinLower > toolRadius) {
      loLower = c
    } else {
      const k = (c * c) / (2 * toolRadius) - c / 2 - (c * c * absAngleSq) / (6 * toolRadius)
      loLower = toolCenterZ + (k > 0 ? absAngleSq * k : 0)
    }
    if (top <= loLower) return false
  }
  const interval = cutterRayIntervalInPlace(toolType, toolRadius, toolCenterZ, vBitAngle, alongOffset, angle)
  if (interval === null) return false
  wrappedRayScratch.lo = interval.lo
  wrappedRayScratch.hi = interval.hi
  return true
}

/**
 * Whether a move needs the swept ramp path (issue #1048 review). A move whose Z
 * changes by no more than one cell across the cutter's diameter cannot
 * under-cut by more than the grid's height resolution, so the exact nearest-pose
 * path handles it. The threshold is absolute, so a truncated replay and every
 * playback piece agree on it.
 */
export function wrappedNeedsSweep(
  grid: SimulationGrid,
  sweep: ToolpathMove,
  toolRadius: number,
): boolean {
  const pathLength = Math.hypot(sweep.to.x - sweep.from.x, sweep.to.y - sweep.from.y)
  const dz = sweep.to.z - sweep.from.z
  if (!(pathLength > 1e-6) || dz === 0) return false
  const slope = Math.abs(dz) / pathLength
  return slope * 2 * toolRadius > grid.cellSize
}

/**
 * The fraction of a source move between adjacent ramp sweep poses. It is
 * absolute — derived only from the move's slope and the grid's cell height — so
 * a truncated replay and every playback piece sample exactly the same poses.
 * Returns 0 for a move the nearest pose is accurate enough for.
 */
export function wrappedSweepStep(
  grid: SimulationGrid,
  sweep: ToolpathMove,
  toolRadius: number,
): number {
  if (!wrappedNeedsSweep(grid, sweep, toolRadius)) return 0
  const pathLength = Math.hypot(sweep.to.x - sweep.from.x, sweep.to.y - sweep.from.y)
  const dz = sweep.to.z - sweep.from.z
  // Half a cell of Z per sample keeps the swept depth well inside the grid's
  // height resolution; the sample's along position follows from the slope.
  const step = (grid.cellSize * 0.5) / (Math.abs(dz) / pathLength)
  return step / pathLength
}

/** First index of the ascending `sorted` array whose value is >= `value`. */
function sampleLowerBound(sorted: readonly number[], value: number, length = sorted.length): number {
  let low = 0
  let high = length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (sorted[mid] < value - 1e-12) low = mid + 1
    else high = mid
  }
  return low
}

/** First index of the ascending `sorted` array whose value is > `value`. */
function sampleUpperBound(sorted: readonly number[], value: number, length = sorted.length): number {
  let low = 0
  let high = length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (sorted[mid] <= value + 1e-12) low = mid + 1
    else high = mid
  }
  return low
}

/** Every absolute ramp sample fraction of `sweep`, endpoint included. */
export function wrappedSweepSampleFractions(
  grid: SimulationGrid,
  sweep: ToolpathMove,
  toolRadius: number,
): number[] {
  return sweepScheduleFor(grid, sweep, toolRadius).fractions.slice()
}

/**
 * The ramp sample schedule of one source move (issue #1048 correction 3).
 *
 * Playback applies the same source move once per rendered frame — dozens of
 * times for a long plunge or ramp — and every piece used to re-derive the
 * identical absolute schedule and allocate it afresh. The schedule is a pure
 * function of the source move and the grid (it is absolute precisely so batch
 * and playback agree), so it is cached per move object and per grid cell size.
 * A move that needs no sweep caches an empty schedule; a move that does caches
 * one array reused by every piece.
 */
interface SweepSchedule {
  cellSize: number
  toolRadius: number
  fractions: readonly number[]
}

const EMPTY_SCHEDULE: readonly number[] = []
const sweepSchedules = new WeakMap<ToolpathMove, SweepSchedule[]>()

function sweepScheduleFor(
  grid: SimulationGrid,
  sweep: ToolpathMove,
  toolRadius: number,
): SweepSchedule {
  const cellSize = grid.cellSize
  let entries = sweepSchedules.get(sweep)
  if (entries) {
    for (const entry of entries) {
      if (entry.cellSize === cellSize && entry.toolRadius === toolRadius) return entry
    }
  } else {
    entries = []
    sweepSchedules.set(sweep, entries)
  }

  const tStep = wrappedSweepStep(grid, sweep, toolRadius)
  const fractions: readonly number[] = tStep > 0
    ? buildSweepFractions(tStep)
    : EMPTY_SCHEDULE
  const entry = { cellSize, toolRadius, fractions }
  entries.push(entry)
  return entry
}

function buildSweepFractions(tStep: number): number[] {
  const out: number[] = []
  for (let k = 0; ; k += 1) {
    const t = k * tStep
    if (t > 1 + 1e-12) break
    out.push(t >= 1 - 1e-12 ? 1 : t)
    if (t >= 1 - 1e-12) break
  }
  if (out[out.length - 1] < 1 - 1e-12) out.push(1)
  return out
}

/**
 * The wrapped (Around) cut kernel (issues #1016 C2-F8 and F8b): the same
 * per-move parameterization as {@link applyMoveKernel}, but each cell is
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
 * `move` is the motion this application may remove — the whole move for a batch
 * replay, one elapsed piece (or partial piece) for playback. `sweep` is the
 * source move the cutter is resolved against, so a split path uses the same
 * cutter parameters as the unsplit one, and `elapsed` is the fraction of
 * `sweep` that this application has reached (1 for a batch replay). Every cell
 * inside the applied piece's swept footprint is evaluated against *all* the
 * source move's periodic cutter images, and the intervals are applied until
 * their cut reaches a fixed point (F8b):
 *
 *  - The fixed point depends only on the set of intervals and the incoming top,
 *    not on the order they are applied in, so overlapping seam copies cannot
 *    leave finished playback different from a batch replay. It also makes
 *    repeated application idempotent, which is what lets a playback piece cut a
 *    cell early and a later piece touch it again without changing the result.
 *  - A **ramp** (a move whose Z changes while it moves) is swept, not resolved
 *    at each cell's nearest pose. The cutter is a disk whose edge can reach a
 *    cell before or after the cell's closest approach, and on an ascending move
 *    that earlier pose is *lower* (issue #1048 review): a flat cutter at
 *    (4.95, -0.258) of the 3 mm rise from (2,0,1) to (10,0,4) is reached at
 *    x ≈ 3.95 with its bottom at 1.731, while the nearest pose is x = 4.95 at
 *    2.106. A later pose cannot put material back, so the batch must cut at the
 *    swept minimum too. The sweep has **one fixed set of sample poses**, a
 *    function of the source move and the grid only (half a cell of Z apart,
 *    {@link wrappedSweepSampleFractions}); the batch applies all of them and a
 *    playback piece applies exactly those with `t <= elapsed` plus each cell's
 *    nearest pose once the piece has reached it. It never adds the reached
 *    endpoint as an extra pose, so the union over any sequence of pieces is the
 *    batch set and the finished playback equals the batch for every step size;
 *    playback may lag the true pose by under one sample step. Cells are only
 *    evaluated against the poses whose cutter footprint can reach their current
 *    top (the along/across index range below), so the cost is proportional to
 *    the cutter's footprint, not the move's length. A move whose Z changes by
 *    less than one cell across the cutter's diameter uses the exact single-pose
 *    path (the nearest pose is then within the grid's resolution); a part-played
 *    *horizontal* move keeps that path clamped to `min(t, elapsed)`, so a
 *    thread's next turn or a ring's far seam image cannot cut a slot the cutter
 *    has not reached. Every cutter solid lies inside the cylinder of radius
 *    `toolRadius` about its axis, so a pose can only reach a cell whose current
 *    top is `h` when its along offset is within `toolRadius` and
 *    `h·|sin(angle)| <= toolRadius`; that is the per-cell index range, widened
 *    as the fixed point lowers `h`, for axial and circumferential motion alike.
 *  - A cell at or below the deepest tip this move can reach (`tipFloor`) can
 *    never be lowered, so it is rejected before the trigonometric work. The
 *    across box uses the tight profile-specific reach from
 *    {@link wrappedAcrossReachAngle}, which is exact for the ball and V-bit and
 *    much narrower than the old flat bound.
 */

function applyWrappedMoveKernel(
  grid: SimulationGrid,
  move: ToolpathMove,
  toolRadius: number,
  toolType: SimulationReplayItem['toolType'],
  vBitAngle: number | null,
  sweep: ToolpathMove,
  elapsed: number,
): ApplyMoveResult {
  // The sheet's across coordinate is arc length at the frame radius, so the
  // angular distance from the tool line is `across / R0`. The bar axis is the
  // other sheet axis; nothing downstream needs the stock shape.
  const wrap = grid.wrap
  if (!wrap) return { changedCount: 0, dirtyRegion: null }
  const acrossIsX = wrap.axis === 'x'
  const frameRadius = wrap.period / (2 * Math.PI)
  const invFrameRadius = 1 / frameRadius
  const isBall = toolType === 'ball_endmill'

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

  const alongAxis = acrossIsX ? 'y' as const : 'x' as const
  const acrossAxis = acrossIsX ? 'x' as const : 'y' as const
  const alongFrom = acrossIsX ? sweepY : sweepX
  const alongDelta = acrossIsX ? sweepDy : sweepDx
  const acrossFrom = acrossIsX ? sweepX : sweepY
  const acrossDelta = acrossIsX ? sweepDx : sweepDy

  // A cuttable cell is strictly above the deepest tip, so the tight
  // profile-specific angular reach covers every cell the solid can lower.
  const tipMin = Math.min(sweep.from.z, sweep.to.z)
  const tipFloor = Math.max(grid.stockBottomZ, tipMin)
  const acrossReach = wrappedAcrossReachAngle(toolType, toolRadius, tipMin, tipFloor, vBitAngle) * frameRadius

  // The periodic images are a property of the source move, not of the piece:
  // batch and playback must evaluate the same set. A copy is needed when the
  // move's reach crosses a sheet seam.
  const low = acrossIsX ? grid.originX : grid.originY
  const high = low + wrap.period
  const sweepAcrossMin = Math.min(sweep.from[acrossAxis], sweep.to[acrossAxis])
  const sweepAcrossMax = Math.max(sweep.from[acrossAxis], sweep.to[acrossAxis])
  const shifts: number[] = [0]
  if (sweepAcrossMin - acrossReach < low) shifts.push(wrap.period)
  if (sweepAcrossMax + acrossReach > high) shifts.push(-wrap.period)
  const imageCount = shifts.length

  const topZ = grid.topZ
  const stockBottomZ = grid.stockBottomZ
  const cellSize = grid.cellSize
  const originX = grid.originX
  const originY = grid.originY
  const gridMaxX = originX + grid.cols * cellSize
  const gridMaxY = originY + grid.rows * cellSize

  // A part-played move only cuts the part of the source move it has reached
  // (issue #1048). Fractions within a rounding step of the finish are the full
  // move, so the finished playback takes the batch path bit for bit.
  const partial = elapsed < 1
  const reached = partial ? (elapsed > 0 ? elapsed : 0) : 1
  // A flat/drill cutter at a constant Z whose across position does not change
  // removes along the same ray at every pose: its interval's lower end is
  // `tip / cos(angle)`, a function of the across angle only. The batch ceiling
  // of a partial move therefore cannot be deeper than the reached pose's own
  // fixed point, and need not be evaluated. An across move (a thread's rotation,
  // a ring) still needs it, as does a ball/V-bit whose entry depends on the along
  // offset, and any ramp.
  const capRedundant = sweepDz === 0
    && acrossDelta === 0
    && (toolType === 'flat_endmill' || toolType === 'drill')

  // Ramps are swept at sample poses (see the doc comment). The poses are an
  // absolute property of the source move and the grid — never of the playback
  // frame — so every piece applies exactly the sub-set with `t <= elapsed` and
  // the union over any sequence of pieces is the batch set. The piece's reached
  // endpoint is not added as a pose: playback may lag the true pose by less
  // than one sample step, and adding it would make the finish frame-dependent.
  //
  // The schedule itself is cached per source move (correction 3): only the
  // prefix length this piece has reached is recomputed, by binary search, so a
  // ramp that is applied once per frame allocates no schedule and derives no
  // fractions again. A stationary move (a vertical plunge, whose footprint does
  // not change with `t`) has an empty schedule and keeps the nearest-pose path.
  const schedule = sweepScheduleFor(grid, sweep, toolRadius)
  const fractions = schedule.fractions
  const ramp = fractions.length > 0
  const rampPrefixLength = ramp && reached < 1
    ? sampleUpperBound(fractions, reached)
    : fractions.length

  // Reused per cell, so the hot loop stays allocation-free. `pose*` holds every
  // interval already evaluated for this cell; `seenSample` stamps which absolute
  // poses they came from, so a widening pass never evaluates one twice. `cap*`
  // is the horizontal batch ceiling.
  const reachedLo = [0, 0, 0]
  const reachedHi = [0, 0, 0]
  const capLo = [0, 0, 0]
  const capHi = [0, 0, 0]
  // + 2 leaves room for the nearest-pose intervals and a sample that coincides
  // with one of them (duplicates only repeat an interval already in the set).
  const poseLo: number[] = ramp ? new Array<number>(imageCount * (rampPrefixLength + 2)) : []
  const poseHi: number[] = ramp ? new Array<number>(imageCount * (rampPrefixLength + 2)) : []
  const seenSample = ramp ? new Uint32Array(rampPrefixLength) : new Uint32Array(0)
  let cellSerial = 0

  let changed = 0
  let dirtyColMin = grid.cols
  let dirtyColMax = -1
  let dirtyRowMin = grid.rows
  let dirtyRowMax = -1

  // The applied piece is walked once per image whose footprint can touch the
  // grid. Every cell in that footprint is resolved against the full image set
  // at the pose the piece has reached, so a reached cell gets the same fixed
  // point as the batch replay of the truncated path. Re-walking an overlap is
  // idempotent.
  for (const shift of shifts) {
    const acrossMin = Math.min(move.from[acrossAxis], move.to[acrossAxis]) + shift - acrossReach
    const acrossMax = Math.max(move.from[acrossAxis], move.to[acrossAxis]) + shift + acrossReach
    const alongMin = Math.min(move.from[alongAxis], move.to[alongAxis]) - toolRadius
    const alongMax = Math.max(move.from[alongAxis], move.to[alongAxis]) + toolRadius
    const minX = acrossIsX ? acrossMin : alongMin
    const maxX = acrossIsX ? acrossMax : alongMax
    const minY = acrossIsX ? alongMin : acrossMin
    const maxY = acrossIsX ? alongMax : acrossMax
    if (maxX < originX || minX > gridMaxX || maxY < originY || minY > gridMaxY) continue

    const [colStart, colEnd] = pointToCellRange(minX, maxX, originX, cellSize, grid.cols)
    const [rowStart, rowEnd] = pointToCellRange(minY, maxY, originY, cellSize, grid.rows)

    for (let row = rowStart; row <= rowEnd; row += 1) {
      const y = originY + (row + 0.5) * cellSize
      const rowBase = row * grid.cols
      for (let col = colStart; col <= colEnd; col += 1) {
        const idx = rowBase + col
        const top = topZ[idx]
        // Nothing at or below the deepest tip can be lowered by this move.
        if (top <= tipFloor) continue

        const x = originX + (col + 0.5) * cellSize
        const alongCell = acrossIsX ? y : x
        const acrossCell = acrossIsX ? x : y
        let nextTop = top

        let tBase = 0
        if (!sweepStationary) {
          tBase = ((x - sweepX) * sweepDx + (y - sweepY) * sweepDy) * invSweepLengthSq
        }

        if (ramp) {
          // The source move's fixed pose set, resolved against this cell. The
          // sweep samples carry the Z variation; each image's closest approach
          // covers the along/across geometry between samples. Both are absolute
          // poses of the source move, so a truncated replay and every piece here
          // evaluate sub-sets of the one batch set.
          let poseCount = 0
          cellSerial += 1
          const serial = cellSerial

          // Each image's closest approach is a pose of the source move. It is
          // part of this piece only once the piece has reached it; a future pose
          // belongs to the piece that reaches it.
          for (let image = 0; image < imageCount; image += 1) {
            let t = 0
            if (!sweepStationary) {
              t = tBase - shifts[image] * acrossDelta * invSweepLengthSq
              if (t < 0) t = 0
              else if (t > 1) t = 1
            }
            if (t > reached + 1e-12) continue
            if (wrappedRayInterval(
              isBall, toolType, toolRadius, vBitAngle,
              top, alongCell, acrossCell,
              alongFrom, alongDelta, acrossFrom, acrossDelta, shifts[image],
              t, sweepStationary, stationaryZ, sweepZ0, sweepDz, invFrameRadius,
            )) {
              poseLo[poseCount] = wrappedRayScratch.lo
              poseHi[poseCount] = wrappedRayScratch.hi
              poseCount += 1
            }
          }

          // Every cutter solid lies inside the cylinder of radius `toolRadius`
          // about its axis, so a pose can only reach this cell's *current* top
          // `h` when its along offset is within `toolRadius` and, across the
          // unrolled sheet, `|h·sin(angle)| <= sqrt(toolRadius² - along²)`.
          // `alongMin` is the smallest along offset the source move can bring
          // the cutter to for this cell, so the bound below is the widest across
          // reach any pose can have here. That gives the index range of `t`
          // worth evaluating — for axial and circumferential motion alike. The
          // range widens as the fixed point lowers the cell, so passes repeat
          // until the top stops moving; each sample is still evaluated at most
          // once per cell.
          let alongMin: number
          if (alongDelta !== 0) {
            let tAlong = (alongCell - alongFrom) / alongDelta
            if (tAlong < 0) tAlong = 0
            else if (tAlong > 1) tAlong = 1
            alongMin = Math.abs(alongCell - (alongFrom + alongDelta * tAlong))
          } else {
            alongMin = Math.abs(alongCell - alongFrom)
          }
          const acrossSideSq = toolRadius * toolRadius - alongMin * alongMin
          const acrossSideMax = acrossSideSq > 0 ? Math.sqrt(acrossSideSq) : 0
          for (let pass = 0; pass <= rampPrefixLength + 1; pass += 1) {
            const reachAngle = nextTop > acrossSideMax ? Math.asin(acrossSideMax / nextTop) : Math.PI / 2
            const acrossReachForCell = reachAngle * frameRadius
            let alongReachable = true
            let alongFirst = 0
            let alongLast = rampPrefixLength - 1
            if (alongDelta !== 0) {
              const tA = (alongCell - toolRadius - alongFrom) / alongDelta
              const tB = (alongCell + toolRadius - alongFrom) / alongDelta
              alongFirst = sampleLowerBound(fractions, Math.min(tA, tB), rampPrefixLength)
              alongLast = sampleUpperBound(fractions, Math.max(tA, tB), rampPrefixLength) - 1
            } else if (Math.abs(alongCell - alongFrom) > toolRadius) {
              alongReachable = false
            }
            let rangeFirst = rampPrefixLength
            let rangeLast = -1
            if (alongReachable) {
              for (let image = 0; image < imageCount; image += 1) {
                let first = alongFirst
                let last = alongLast
                if (acrossDelta !== 0) {
                  const tA = (acrossCell - acrossReachForCell - acrossFrom - shifts[image]) / acrossDelta
                  const tB = (acrossCell + acrossReachForCell - acrossFrom - shifts[image]) / acrossDelta
                  first = Math.max(first, sampleLowerBound(fractions, Math.min(tA, tB), rampPrefixLength))
                  last = Math.min(last, sampleUpperBound(fractions, Math.max(tA, tB), rampPrefixLength) - 1)
                } else if (Math.abs(acrossCell - acrossFrom - shifts[image]) > acrossReachForCell) {
                  continue
                }
                if (first > last) continue
                if (first < rangeFirst) rangeFirst = first
                if (last > rangeLast) rangeLast = last
              }
            }
            if (rangeLast < rangeFirst) {
              // The nearest pose may already have lowered the cell below the
              // reach this pass was computed at. Do not give up: the next pass
              // recomputes the range at the lowered top and may include poses
              // this one did not.
              const candidate = poseCount > 0
                ? fixedPointTop(poseLo, poseHi, poseCount, top, stockBottomZ)
                : nextTop
              if (candidate >= nextTop - 1e-9) break
              nextTop = candidate
              continue
            }

            // Walk the range from the deepest tip towards the shallow end: a
            // sample at or above the cell's current best top cannot lower it
            // (every profile's interval starts at or above its own tip), and
            // every later sample in this order is at least as high, so the walk
            // stops there. The best top is updated as intervals come in, so the
            // first active sample ends the pass; the fixed point after the walk
            // still re-applies the intervals already collected, which is what
            // lets a previously inert sample become active when the cell drops.
            let scanTop = nextTop
            const direction = sweepDz >= 0 ? 1 : -1
            const firstSample = direction > 0 ? rangeFirst : rangeLast
            const lastSample = direction > 0 ? rangeLast : rangeFirst
            for (let sample = firstSample; direction > 0 ? sample <= lastSample : sample >= lastSample; sample += direction) {
              const t = fractions[sample]
              if (sweepZ0 + sweepDz * t >= scanTop) break
              if (seenSample[sample] === serial) continue
              seenSample[sample] = serial
              for (let image = 0; image < imageCount; image += 1) {
                if (wrappedRayInterval(
                  isBall, toolType, toolRadius, vBitAngle,
                  top, alongCell, acrossCell,
                  alongFrom, alongDelta, acrossFrom, acrossDelta, shifts[image],
                  t, sweepStationary, stationaryZ, sweepZ0, sweepDz, invFrameRadius,
                )) {
                  const intervalLo = wrappedRayScratch.lo
                  const intervalHi = wrappedRayScratch.hi
                  poseLo[poseCount] = intervalLo
                  poseHi[poseCount] = intervalHi
                  poseCount += 1
                  if (scanTop <= intervalHi && intervalLo < scanTop - 1e-9) {
                    scanTop = intervalLo > stockBottomZ ? intervalLo : stockBottomZ
                  }
                }
              }
            }

            const candidate = poseCount > 0
              ? fixedPointTop(poseLo, poseHi, poseCount, top, stockBottomZ)
              : nextTop
            if (candidate >= nextTop - 1e-9) break
            nextTop = candidate
          }

          if (poseCount > 0) {
            nextTop = fixedPointTop(poseLo, poseHi, poseCount, top, stockBottomZ)
          }
        } else {
          // The nearest pose is the deepest one for a horizontal move. It is
          // clamped to the elapsed end so a future turn or seam image cannot cut
          // a slot the cutter has not reached (issue #1048). A horizontal move
          // keeps the batch as its ceiling: the projection is the deepest pose,
          // and the ceiling only absorbs its sub-cell rounding, never a swept
          // cut (the ramp path above has no ceiling).
          let reachedCount = 0
          let anyFuture = false
          for (let image = 0; image < imageCount; image += 1) {
            const imageShift = shifts[image]
            // Translating the sweep across the sheet shifts the cell's projected
            // parameter by exactly `shift · (across direction) / |sweep|²`.
            let t = 0
            if (!sweepStationary) {
              t = tBase - imageShift * acrossDelta * invSweepLengthSq
              if (t < 0) t = 0
              else if (t > 1) t = 1
            }
            const future = partial && t > reached
            if (future) anyFuture = true
            // The interval test is inlined here, not routed through
            // `wrappedRayInterval`: this is the per-cell hot path for every
            // horizontal move, i.e. almost all playback of an ordinary job
            // (correction 3). The helper's argument marshalling measured a
            // large share of this job's frame cost when every cell paid it.
            const poseT = future ? reached : t
            const toolCenterZ = sweepStationary ? stationaryZ : sweepZ0 + sweepDz * poseT
            let intervalLo = 0
            let intervalHi = 0
            if (top > toolCenterZ) {
              const alongOffset = alongCell - (alongFrom + alongDelta * poseT)
              if (alongOffset <= toolRadius && alongOffset >= -toolRadius) {
                const angle = (acrossCell - (acrossFrom + imageShift + acrossDelta * poseT)) * invFrameRadius
                const absAngle = angle < 0 ? -angle : angle
                if (absAngle < Math.PI / 2) {
                  let hit = true
                  if (isBall && toolCenterZ > 0) {
                    const c = toolCenterZ + toolRadius
                    const absAngleSq = absAngle * absAngle
                    const sinLower = absAngle - (absAngleSq * absAngle) / 6
                    let loLower: number
                    if (c * sinLower > toolRadius) {
                      loLower = c
                    } else {
                      const k = (c * c) / (2 * toolRadius) - c / 2 - (c * c * absAngleSq) / (6 * toolRadius)
                      loLower = toolCenterZ + (k > 0 ? absAngleSq * k : 0)
                    }
                    hit = top > loLower
                  }
                  if (hit) {
                    const interval = cutterRayIntervalInPlace(
                      toolType, toolRadius, toolCenterZ, vBitAngle, alongOffset, angle,
                    )
                    if (interval !== null) {
                      intervalLo = interval.lo
                      intervalHi = interval.hi
                      reachedLo[reachedCount] = intervalLo
                      reachedHi[reachedCount] = intervalHi
                      reachedCount += 1
                    }
                  }
                }
              }
            }
          }
          if (reachedCount === 0) continue
          // The overwhelmingly common cell has one event; folding it here keeps
          // the per-cell cost at the inline kernel's (correction 3).
          if (reachedCount === 1) {
            if (top <= reachedHi[0]) {
              const candidate = reachedLo[0] > stockBottomZ ? reachedLo[0] : stockBottomZ
              if (candidate < top - 1e-9) nextTop = candidate
            }
          } else {
            nextTop = fixedPointTop(reachedLo, reachedHi, reachedCount, top, stockBottomZ)
          }
          if (!capRedundant && anyFuture && nextTop < top - 1e-9) {
            // The ceiling is only needed for a partial move whose projection
            // lies ahead of the reached pose. Re-derive each image's pose here
            // instead of storing five per-image arrays for every cell on the
            // chance that one cell needs them (correction 3).
            let capCount = 0
            for (let image = 0; image < imageCount; image += 1) {
              const imageShift = shifts[image]
              let t = 0
              if (!sweepStationary) {
                t = tBase - imageShift * acrossDelta * invSweepLengthSq
                if (t < 0) t = 0
                else if (t > 1) t = 1
              }
              // The ceiling is the source move's own closest pose for this
              // image, whatever the piece has reached: it is the batch value
              // the piece may never exceed.
              if (wrappedRayInterval(
                isBall, toolType, toolRadius, vBitAngle,
                top, alongCell, acrossCell,
                alongFrom, alongDelta, acrossFrom, acrossDelta, imageShift,
                t, sweepStationary, stationaryZ, sweepZ0, sweepDz, invFrameRadius,
              )) {
                capLo[capCount] = wrappedRayScratch.lo
                capHi[capCount] = wrappedRayScratch.hi
                capCount += 1
              }
            }
            const capTop = fixedPointTop(capLo, capHi, capCount, top, stockBottomZ)
            if (capTop > nextTop) nextTop = capTop
          }
        }

        if (nextTop < top - 1e-9) {
          topZ[idx] = nextTop
          changed += 1
          if (col < dirtyColMin) dirtyColMin = col
          if (col > dirtyColMax) dirtyColMax = col
          if (row < dirtyRowMin) dirtyRowMin = row
          if (row > dirtyRowMax) dirtyRowMax = row
        }
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
 * `move`, and replay/static callers never pass it. `elapsed` is the fraction of
 * `sweep` a playback piece has reached (1 for a batch replay); a partial
 * application resolves the cutter at the reached pose and uses the full move
 * only as the depth it may not pass (issue #1048). The wrapped kernel folds the
 * periodic copies into one cell pass and reaches the order-independent fixed
 * point over all the source move's images (F8b), so a subdivided, partial or
 * re-applied playback finishes exactly equal to the batch replay of the same
 * path. Flat and plasma grids keep the old separate seam-copy dispatch, which
 * is byte-identical for flat stock.
 */
export function applyMoveToGrid(
  grid: SimulationGrid,
  move: ToolpathMove,
  toolRadius: number,
  toolType: SimulationReplayItem['toolType'],
  vBitAngle: number | null,
  sweep: ToolpathMove = move,
  elapsed: number = 1,
): ApplyMoveResult {
  // A torch is a one-kerf flat through-cut with no rotary solid to resolve, and
  // a flat grid is already exact: both keep the original kernel.
  if (grid.wrap && toolType !== 'plasma') {
    return applyWrappedMoveKernel(grid, move, toolRadius, toolType, vBitAngle, sweep, elapsed)
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
