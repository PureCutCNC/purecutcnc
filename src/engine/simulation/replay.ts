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
 * `sweep` the playback has reached (1 for a batch replay). Every cell inside
 * the applied piece's swept footprint is evaluated against *all* the source
 * move's periodic cutter images at once, and the intervals are applied until
 * their cut reaches a fixed point (F8b):
 *
 *  - The fixed point depends only on the set of intervals and the incoming top,
 *    not on the order they are applied in, so overlapping seam copies cannot
 *    leave finished playback different from a batch replay. It also makes
 *    repeated application idempotent, which is what lets a playback piece cut a
 *    cell early and a later piece touch it again without changing the result.
 *  - The footprint, not each cell's projected sweep parameter, decides *when*
 *    some material is eligible: a cell the cutter has reached is considered in
 *    that frame, even though its closest approach lies further along the move.
 *    What it is cut *to* is the point of `elapsed` (issue #1048): a part-played
 *    move resolves every image at `min(t, elapsed)`, so a thread's next turn or
 *    a ring's far seam image cannot remove a slot the cutter has not reached.
 *    The source move's true nearest pose is still computed, but only as a
 *    ceiling — a partial frame may never show more removed than the batch
 *    eventually does. That is what keeps the finished playback exactly equal to
 *    the batch (at `elapsed = 1` both poses coincide), and it is monotone: as
 *    the piece advances the reached pose approaches its true one, so the
 *    ceiling is only ever touched, never raised.
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

  // A part-played move resolves its images at the pose the cutter has reached
  // (issue #1048). Fractions within a rounding step of the finish are the full
  // move, so the finished playback takes the batch path bit for bit.
  const partial = elapsed < 1
  const reached = partial ? (elapsed > 0 ? elapsed : 0) : 1

  // Reused per cell (at most three images), so the hot loop stays allocation-free.
  // `image*` is this cell's per-image pose and interval; `reached*` is the cut
  // from the pose the piece has reached, and `cap*` the batch ceiling's set.
  const imageT = [0, 0, 0]
  const imageFuture = [false, false, false]
  const imageReached = [false, false, false]
  const imageLo = [0, 0, 0]
  const imageHi = [0, 0, 0]
  const reachedLo = [0, 0, 0]
  const reachedHi = [0, 0, 0]
  const capLo = [0, 0, 0]
  const capHi = [0, 0, 0]

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
        let tBase = 0
        if (!sweepStationary) {
          tBase = ((x - sweepX) * sweepDx + (y - sweepY) * sweepDy) * invSweepLengthSq
        }

        // First resolve the pose the cutter has reached (the true one for a
        // batch replay, and for any image this piece has already passed). Most
        // cells in the bounding box miss it, and those pay exactly what they
        // paid before: one lookup per image and nothing else.
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
          // A future nearest pose is clamped to this piece's elapsed end, so it
          // cannot cut a slot the cutter has not reached (issue #1048).
          const future = partial && t > reached
          if (partial) {
            imageT[image] = t
            imageFuture[image] = future
            if (future) anyFuture = true
          }
          const valid = wrappedRayInterval(
            isBall, toolType, toolRadius, vBitAngle,
            top, alongCell, acrossCell,
            alongFrom, alongDelta, acrossFrom, acrossDelta, imageShift,
            future ? reached : t, sweepStationary, stationaryZ, sweepZ0, sweepDz, invFrameRadius,
          )
          if (valid) {
            const intervalLo = wrappedRayScratch.lo
            const intervalHi = wrappedRayScratch.hi
            reachedLo[reachedCount] = intervalLo
            reachedHi[reachedCount] = intervalHi
            reachedCount += 1
            if (partial) {
              imageReached[image] = true
              imageLo[image] = intervalLo
              imageHi[image] = intervalHi
            }
          } else if (partial) {
            imageReached[image] = false
          }
        }
        if (reachedCount === 0) continue
        const reachedTop = fixedPointTop(reachedLo, reachedHi, reachedCount, top, stockBottomZ)
        let nextTop = reachedTop
        if (anyFuture && reachedTop < top - 1e-9) {
          // The reached pose removes something, so the batch ceiling matters: a
          // partial frame may never cut past what the whole move eventually
          // leaves. The ceiling is the fixed point over the true poses — the
          // reached intervals already in hand for every image the piece has
          // passed, plus the true pose of each future image. At the finish the
          // two poses coincide, so this is exactly the batch.
          let capCount = 0
          for (let image = 0; image < imageCount; image += 1) {
            if (!imageFuture[image]) {
              if (imageReached[image]) {
                capLo[capCount] = imageLo[image]
                capHi[capCount] = imageHi[image]
                capCount += 1
              }
              continue
            }
            if (wrappedRayInterval(
              isBall, toolType, toolRadius, vBitAngle,
              top, alongCell, acrossCell,
              alongFrom, alongDelta, acrossFrom, acrossDelta, shifts[image],
              imageT[image], sweepStationary, stationaryZ, sweepZ0, sweepDz, invFrameRadius,
            )) {
              capLo[capCount] = wrappedRayScratch.lo
              capHi[capCount] = wrappedRayScratch.hi
              capCount += 1
            }
          }
          const capTop = fixedPointTop(capLo, capHi, capCount, top, stockBottomZ)
          if (capTop > nextTop) nextTop = capTop
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
