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
 * The physical polar cut kernel for a square blank (issue #1016 C2-R1).
 *
 * A round bar's unrolled heightfield is a flat sheet, so the ordinary kernel
 * can treat a move as a disc swept in the (along, across) plane. A square
 * blank is not: the same radial height sits on material whose distance from
 * the turning axis changes with the blank's angle. Seeding the true square
 * cross section and then running the flat kernel would cut grooves that do not
 * exist — the manager measured 838 false cells, up to 4.06 mm of radial loss,
 * on a flat cutter that only *touches* the blank's top face. The ray radius is
 * virgin material geometry, not finite-cutter support.
 *
 * So a square grid replays through this kernel instead. Every cell is a radial
 * ray from the true pivot (`frame.radius`, never the corner radius) at the
 * angle its across coordinate names. A move carries the tool tip's radial
 * coordinate (`z`), and this kernel asks, for each cell, where the finite
 * flat or ball cutter body actually crosses that ray in turned stock space:
 *
 *   - the blank frame angle of a material point is `a = (across − zero)·2π/C`;
 *   - at the instant the program is at across `u`, a material point at radius
 *     `r`, angle `a` sits at machine angle `θ = a − angle(u)`, at height above
 *     the pivot `r·cos θ` and across offset `r·sin θ`;
 *   - a flat cutter is a vertical cylinder of radius `rt` whose bottom plane
 *     is at the tip height, so it removes the radial band
 *     `[z/cos θ, √(rt²−Δx²)/|sin θ|]` (the tip plane crossing to the cylinder
 *     wall);
 *   - a ball cutter is a sphere of radius `rt` centred one radius above its
 *     tip, so it removes the band where that sphere crosses the ray.
 *
 * Only the outer surface is kept. Material at radius `r > r_hi` survives — the
 * tool never reached it — so a removal that does not reach the cell's current
 * surface does not lower it by itself: a pass can cut an internal groove and
 * leave the lip above it standing. Sweeping the passes to a fixed point is what
 * then lets a *later* pass whose removal meets that groove carry the surface
 * down with it, exactly as a solid would collapse the lip. The kernel therefore
 * tracks the connected removed band that reaches the surface, never gouges
 * material a physical tool left standing, and converges in a few sweeps for
 * every regime the square generators emit (constant-angle axial cuts and
 * plunges in one; an arbitrary diagonal cutting submove, which is not emitted,
 * is capped and then stops conservatively).
 *
 * A move whose across coordinate changes is split at a resolution derived from
 * the grid's own across cell size (never a fixed sample count), so a diagonal
 * submove delivered by playback converges below the grid resolution while a
 * constant-angle generator cut is evaluated exactly in closed form.
 */

import type { ToolType } from '../../types/project'
import type { ToolpathMove } from '../toolpaths/types'
import type { SquareBarDescriptor } from './types'
import type { DirtyRegion, SimulationGrid } from './types'

const TWO_PI = Math.PI * 2

/**
 * Runaway guard on the removed-band fixed-point sweep. The linear regimes the
 * generators emit converge in a handful of sweeps (a constant-angle cut in one)
 * and never approach this; only an arbitrary diagonal cutting submove, which is
 * not generated, can be cut short — and then conservatively.
 */
const MAX_SQUARE_SWEEPS = 16

export interface SquareApplyResult {
  changedCount: number
  dirtyRegion: DirtyRegion | null
}

const ZERO_RESULT: SquareApplyResult = { changedCount: 0, dirtyRegion: null }

/**
 * Radial distance from the pivot to the surface of a square blank of `side` at
 * `angle` radians: `halfSide / max(|sin|,|cos|)` — half the side on a flat,
 * `side/√2` at a corner. Raw blank geometry, not a cutter-support height.
 */
export function squareSurfaceRadius(side: number, angle: number): number {
  return (side / 2) / Math.max(Math.abs(Math.sin(angle)), Math.abs(Math.cos(angle)))
}

/**
 * Validate a transient square descriptor before it initializes a grid: the
 * side must be finite and positive, and the frame must be the square's own
 * nominal reference cylinder (`radius = side/2`, `circumference = π·side`).
 * Throws a `RangeError` on anything else — a mismatched frame would silently
 * map every cell to the wrong angle.
 */
export function validateSquareBar(descriptor: SquareBarDescriptor): void {
  const { side, frame } = descriptor
  if (!Number.isFinite(side) || side <= 0) {
    throw new RangeError(`squareBar: side must be a positive finite number, got ${side}`)
  }
  if (!frame) {
    throw new RangeError('squareBar: frame is required')
  }
  if (frame.axis !== 'x' && frame.axis !== 'y') {
    throw new RangeError(`squareBar: frame.axis must be 'x' or 'y', got ${String(frame.axis)}`)
  }
  const scale = Math.max(1, side)
  const radiusTolerance = 1e-9 * scale
  if (!Number.isFinite(frame.radius) || Math.abs(frame.radius - side / 2) > radiusTolerance) {
    throw new RangeError(`squareBar: frame.radius must be side/2 (${side / 2}), got ${frame.radius}`)
  }
  if (!Number.isFinite(frame.circumference) || Math.abs(frame.circumference - Math.PI * side) > radiusTolerance) {
    throw new RangeError(`squareBar: frame.circumference must be π·side (${Math.PI * side}), got ${frame.circumference}`)
  }
  for (const [name, value] of [['zero', frame.zero], ['centre', frame.centre], ['sheetStart', frame.sheetStart]] as const) {
    if (!Number.isFinite(value)) {
      throw new RangeError(`squareBar: frame.${name} must be finite, got ${value}`)
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function pointToCellRange(min: number, max: number, origin: number, cellSize: number, count: number): [number, number] {
  const start = clamp(Math.floor((min - origin) / cellSize), 0, count - 1)
  const end = clamp(Math.floor((max - origin) / cellSize), 0, count - 1)
  return [Math.min(start, end), Math.max(start, end)]
}

/** Wrap an angle difference into (-π, π]; the blank is periodic. */
function wrapPi(angle: number): number {
  let wrapped = angle % TWO_PI
  if (wrapped > Math.PI) wrapped -= TWO_PI
  else if (wrapped <= -Math.PI) wrapped += TWO_PI
  return wrapped
}

/**
 * The t-interval inside [0, 1] over which a constant-angle submove's along
 * coordinate stays within `reach` of `cellAlong`, or null when it never does.
 */
function alongReachInterval(cellAlong: number, alongA: number, alongB: number, reach: number): [number, number] | null {
  const low = cellAlong - reach
  const high = cellAlong + reach
  if (alongA === alongB) {
    return alongA >= low && alongA <= high ? [0, 1] : null
  }
  const tLow = (low - alongA) / (alongB - alongA)
  const tHigh = (high - alongA) / (alongB - alongA)
  const tMin = Math.max(0, Math.min(tLow, tHigh))
  const tMax = Math.min(1, Math.max(tLow, tHigh))
  return tMin <= tMax ? [tMin, tMax] : null
}

function interpolate(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/**
 * New radial height for one cell under one constant-angle cutter pass.
 *
 * `zA`/`zB` are the tip's radial coordinate at the submove's ends; `alongA`/
 * `alongB` its along coordinate. The tool is a flat cylinder or a ball of
 * radius `rt`. Returns `height` unchanged when the tool body never reaches the
 * cell's outer surface.
 */
function removalHeightForPass(
  height: number,
  cellAlong: number,
  theta: number,
  alongA: number,
  alongB: number,
  zA: number,
  zB: number,
  rt: number,
  ball: boolean,
  bottom: number,
): number {
  const cosTheta = Math.cos(theta)
  if (cosTheta <= 0) {
    // The ray leans away from the cutter's tip plane: `r·cos θ ≤ 0 ≤ z` for a
    // tip at or above the pivot, so no material on it is ever above the plane.
    return height
  }

  if (!ball) {
    const sinAbs = Math.abs(Math.sin(theta))
    // The tip plane is reached at z/cosθ; the cylinder wall at √(rt²−Δx²)/|sinθ|.
    // The surface is removed only where the wall reaches it.
    const reachSq = rt * rt - height * height * sinAbs * sinAbs
    if (!(reachSq > 0)) return height
    const interval = alongReachInterval(cellAlong, alongA, alongB, Math.sqrt(reachSq))
    if (!interval) return height
    // z is linear in t, so the deepest removal in the reachable interval is at
    // one of its ends.
    const zMin = Math.min(
      interpolate(zA, zB, interval[0]),
      interpolate(zA, zB, interval[1]),
    )
    const radialFloor = zMin / cosTheta
    if (radialFloor >= height) return height
    return Math.max(bottom, radialFloor)
  }

  // Ball: sphere of radius rt centred one radius above the tip along the tool
  // axis, at radial coordinate c0 = z + rt.
  const sinAbs = Math.abs(Math.sin(theta))
  const zMin = Math.min(zA, zB)
  const c0 = zMin + rt
  const b = c0 * cosTheta
  const beyond = height - b
  const beyondSq = beyond > 0 ? beyond * beyond : 0
  const reachSq = rt * rt - c0 * c0 * sinAbs * sinAbs - beyondSq
  if (!(reachSq > 0)) return height
  const interval = alongReachInterval(cellAlong, alongA, alongB, Math.sqrt(reachSq))
  if (!interval) return height
  // The deepest removal is at the smallest axial offset inside that interval.
  const alongAtMin = interpolate(alongA, alongB, interval[0])
  const alongAtMax = interpolate(alongA, alongB, interval[1])
  const dxMin = cellAlong < alongAtMin ? alongAtMin - cellAlong : cellAlong > alongAtMax ? cellAlong - alongAtMax : 0
  const disc = rt * rt - dxMin * dxMin - c0 * c0 * sinAbs * sinAbs
  if (!(disc >= 0)) return height
  const radialFloor = b - Math.sqrt(disc)
  if (radialFloor >= height) return height
  return Math.max(bottom, radialFloor)
}

/**
 * The physical square cut kernel. `move` is in the unrolled Around sheet: its
 * along coordinate is the bar axis, its across coordinate names the program
 * angle, and `z` is the tool tip's radius above the pivot. Returns the changed
 * cell count and the dirty rectangle, exactly like the flat/round kernel.
 *
 * Only flat and ball tools are modelled (the square contract is the existing
 * rotary rough/finish); any other type is treated as a flat cylinder, and the
 * upstream square guards refuse those operations. A grid without a square
 * descriptor is the flat/round caller's, which never reaches here.
 */
export function applySquareMoveToGrid(
  grid: SimulationGrid,
  move: ToolpathMove,
  toolRadius: number,
  toolType: ToolType,
): SquareApplyResult {
  const bar = grid.squareBar
  if (!bar || !(toolRadius > 0) || grid.cols <= 0 || grid.rows <= 0) {
    return ZERO_RESULT
  }

  const frame = bar.frame
  const xAxis = frame.axis === 'x'
  const ball = toolType === 'ball_endmill'
  const rt = toolRadius
  const cellSize = grid.cellSize
  const alongCount = xAxis ? grid.cols : grid.rows
  const acrossCount = xAxis ? grid.rows : grid.cols
  const alongOrigin = xAxis ? grid.originX : grid.originY
  const acrossOrigin = xAxis ? grid.originY : grid.originX

  const fromAlong = xAxis ? move.from.x : move.from.y
  const toAlong = xAxis ? move.to.x : move.to.y
  const fromAcross = xAxis ? move.from.y : move.from.x
  const toAcross = xAxis ? move.to.y : move.to.x

  // A tip above the whole blank can never reach any cell's outer surface: the
  // tip plane crossing z/cos θ is then above the material everywhere. This is
  // the above-envelope link the generators retract through, and it costs O(1)
  // rather than one pass per across cell.
  if (Math.min(move.from.z, move.to.z) >= grid.stockTopZ) {
    return ZERO_RESULT
  }

  // A diagonal submove is split below the grid's own across resolution, so no
  // cell's angular window is stepped over. A constant-angle cut stays one pass
  // and is solved in closed form.
  const acrossSpan = Math.abs(toAcross - fromAcross)
  const passes = Math.max(1, Math.ceil(acrossSpan / (cellSize * 0.05)))
  const anglePerAcross = TWO_PI / frame.circumference

  const topZ = grid.topZ
  const bottom = grid.stockBottomZ
  let changed = 0
  // A cell can be lowered more than once (several passes, or several sweeps);
  // count each cell once, as the flat kernel does.
  let counted: Uint8Array | null = null
  let dirtyColMin = grid.cols
  let dirtyColMax = -1
  let dirtyRowMin = grid.rows
  let dirtyRowMax = -1

  /**
   * Sweep the passes until the removed band stops growing.
   *
   * Along a cell's ray the cutter removes a radial interval per instant, and
   * the cell's height is the lower edge of the band that *reaches* the cell's
   * surface. A pass whose removal does not reach the surface cuts an internal
   * groove and leaves the cell alone; but a later pass whose removal meets that
   * groove carries the band down with it. One time-ordered sweep misses a
   * bridge whose groove came first, so sweep again until nothing more is
   * removed. Every sweep that changes a cell resolves at least one link of such
   * a chain, and there are at most `passes` intervals, so `passes + 1` sweeps
   * bound the iteration; the linear generator regimes converge in a few and a
   * constant-angle cut (one pass) finishes in one. The `MAX_SQUARE_SWEEPS` cap
   * is a runaway guard only — a diagonal *cutting* submove, which the square
   * generators never emit, then stops conservatively short rather than hanging.
   */
  const maxSweeps = Math.min(passes + 1, MAX_SQUARE_SWEEPS)
  for (let sweep = 0; sweep < maxSweeps; sweep += 1) {
    let changedInSweep = false
    for (let pass = 0; pass < passes; pass += 1) {
      const t0 = pass / passes
      const t1 = (pass + 1) / passes
      const passAlongA = interpolate(fromAlong, toAlong, t0)
      const passAlongB = interpolate(fromAlong, toAlong, t1)
      const passAcross = interpolate(fromAcross, toAcross, (t0 + t1) / 2)
      const zA = interpolate(move.from.z, move.to.z, t0)
      const zB = interpolate(move.from.z, move.to.z, t1)

      // The pass only touches cells within the tool radius of its own along span,
      // so a diagonal move does not re-scan the whole axial extent per pass.
      const [alongStart, alongEnd] = pointToCellRange(
        Math.min(passAlongA, passAlongB) - rt,
        Math.max(passAlongA, passAlongB) + rt,
        alongOrigin,
        cellSize,
        alongCount,
      )

      // The across loop covers the whole circumference. Cells more than a
      // quarter circumference away face the cutter's tip plane from below
      // (|θ| ≥ π/2) and are skipped by the kernel's own angle test, so no index
      // window is needed and a move whose across coordinate sits outside the
      // sheet (a multi-turn program) still wraps correctly.
      for (let a = alongStart; a <= alongEnd; a += 1) {
        const along = alongOrigin + (a + 0.5) * cellSize
        for (let c = 0; c < acrossCount; c += 1) {
          const across = acrossOrigin + (c + 0.5) * cellSize
          const col = xAxis ? a : c
          const row = xAxis ? c : a
          const idx = row * grid.cols + col
          const height = topZ[idx]
          if (!(height > bottom + 1e-12)) continue
          const theta = wrapPi((across - passAcross) * anglePerAcross)
          const next = removalHeightForPass(height, along, theta, passAlongA, passAlongB, zA, zB, rt, ball, bottom)
          if (next < height - 1e-9) {
            // Count only a stored change: a boundary just-touch computes a value
            // a hair below the cell's Float32 height but rounds to the same cell,
            // and must not be reported as removed material or drive another
            // sweep.
            topZ[idx] = next
            if (topZ[idx] < height) {
              changedInSweep = true
              let firstWrite = true
              if (passes > 1 || sweep > 0) {
                if (counted === null) counted = new Uint8Array(grid.cols * grid.rows)
                if (counted[idx] !== 0) firstWrite = false
                else counted[idx] = 1
              }
              if (firstWrite) changed += 1
              if (col < dirtyColMin) dirtyColMin = col
              if (col > dirtyColMax) dirtyColMax = col
              if (row < dirtyRowMin) dirtyRowMin = row
              if (row > dirtyRowMax) dirtyRowMax = row
            }
          }
        }
      }
    }
    if (!changedInSweep) break
  }

  return {
    changedCount: changed,
    dirtyRegion: changed > 0 ? { colMin: dirtyColMin, colMax: dirtyColMax, rowMin: dirtyRowMin, rowMax: dirtyRowMax } : null,
  }
}
