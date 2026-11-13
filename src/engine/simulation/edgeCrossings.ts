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
 * Where the cut really ends between two cells (issue #973).
 *
 * A cell holds one height: what its centre sees. That alone cannot say where
 * between two cell centres a wall stands, so a wall drawn from heights alone
 * zigzags along the cell edges. When the flat replay kernel stamps a move it
 * knows the tool's swept boundary exactly, so it records it: for the line from
 * a cell's centre to its east neighbour's centre and to its south neighbour's,
 * the fraction along that line where the boundary crosses, and the boundary's
 * direction there. The corner pass (`outlineCorners.ts`) places every wall
 * corner from these by dual contouring.
 *
 * Layout: `grid.edgeCrossings`, 4 bytes per cell in the heightfield's cell
 * order — east position, east normal, south position, south normal. A position
 * byte of 0 means no crossing is known (that edge then stays on the cell
 * edge); 1..255 is the fraction (code - 1) / 254 from this cell's centre toward
 * the neighbour's. A normal byte is the boundary normal's angle in the grid's
 * (x, y) plane over a full turn, in 256 steps. The heights themselves are
 * untouched.
 */

import { SHALLOW_SLOPE_CELLS } from './stepThreshold'

/** Bytes per cell in `grid.edgeCrossings`. */
export const EDGE_CROSSING_STRIDE = 4

/** Position byte meaning "no crossing recorded". */
export const EDGE_CROSSING_NONE = 0

/** Byte offsets within a cell's four. */
export const EDGE_CROSSING_EAST = 0
export const EDGE_CROSSING_SOUTH = 2

export function encodeCrossingPosition(fraction: number): number {
  return 1 + Math.round(Math.min(1, Math.max(0, fraction)) * 254)
}

export function decodeCrossingPosition(code: number): number {
  return (code - 1) / 254
}

export function encodeCrossingAngle(normalX: number, normalY: number): number {
  const turn = Math.atan2(normalY, normalX) / (2 * Math.PI)
  return Math.round((turn < 0 ? turn + 1 : turn) * 256) & 255
}

export function decodeCrossingAngle(code: number): number {
  return (code * 2 * Math.PI) / 256
}

/**
 * One move's cutter, as the stamping kernel sees it, for the crossing search:
 * the same profile math as the kernel's own loop. One instance is reused for
 * every move (`set`), so the kernel allocates nothing and its loop variables
 * stay out of any closure.
 */
export class SweptCutter {
  private x0 = 0
  private y0 = 0
  private z0 = 0
  private segDx = 0
  private segDy = 0
  private segDz = 0
  private invSegLengthSq = 0
  private stationary = true
  private stationaryZ = 0
  private reachSq = 0
  private radius = 0
  private radiusSq = 0
  /** 0 flat (endmill, drill), 1 ball, 2 V-bit, 3 plasma. */
  private profile = 0
  private vBitInvSlope = 0
  private stockBottomZ = 0
  /** Unit normal of the path, and its angle byte either way, for side exits. */
  private perpX = 0
  private perpY = 0
  private perpCode = 0
  /** The boundary normal's angle byte where `exitFraction` last left the tool. */
  exitAngleCode = 0

  set(
    x0: number, y0: number, z0: number, segDx: number, segDy: number, segDz: number,
    invSegLengthSq: number, stationary: boolean, stationaryZ: number,
    reachSq: number, radius: number, profile: number, vBitInvSlope: number, stockBottomZ: number,
  ): void {
    this.x0 = x0
    this.y0 = y0
    this.z0 = z0
    this.segDx = segDx
    this.segDy = segDy
    this.segDz = segDz
    this.invSegLengthSq = invSegLengthSq
    this.stationary = stationary
    this.stationaryZ = stationaryZ
    this.reachSq = reachSq
    this.radius = radius
    this.radiusSq = radius * radius
    this.profile = profile
    this.vBitInvSlope = vBitInvSlope
    this.stockBottomZ = stockBottomZ
    if (!stationary) {
      const length = Math.sqrt(segDx * segDx + segDy * segDy)
      this.perpX = -segDy / length
      this.perpY = segDx / length
      this.perpCode = encodeCrossingAngle(this.perpX, this.perpY)
    }
  }

  /** Where along the path the point is nearest, 0..1. */
  private along(x: number, y: number): number {
    if (this.stationary) return 0
    const t = ((x - this.x0) * this.segDx + (y - this.y0) * this.segDy) * this.invSegLengthSq
    return t < 0 ? 0 : t > 1 ? 1 : t
  }

  /** The tool's unclamped cut height at a point, or +Infinity outside its reach. */
  cutAt(x: number, y: number): number {
    const t = this.along(x, y)
    const dx = x - (this.x0 + this.segDx * t)
    const dy = y - (this.y0 + this.segDy * t)
    const distanceSq = dx * dx + dy * dy
    if (distanceSq > this.reachSq) return Infinity
    const centerZ = this.profile === 3 ? this.stockBottomZ : this.stationary ? this.stationaryZ : this.z0 + this.segDz * t
    if (this.profile === 1) return centerZ + this.radius - Math.sqrt(this.radiusSq - Math.min(this.radiusSq, distanceSq))
    if (this.profile === 2) return centerZ + Math.sqrt(distanceSq) * this.vBitInvSlope
    return centerZ
  }

  /**
   * How far along the line from (ax, ay) to (nx, ny) the tool's surface first
   * rises above `level`, as a fraction 0..1. The start must be at or below it.
   * The surface is a function of distance from the path, so this is where the
   * line leaves the swept region within distance `reach` of the path — a
   * capsule — solved in closed form: a slab along the path and a disc at each
   * end. The height along the path is taken where the start is nearest it.
   */
  exitFraction(ax: number, ay: number, nx: number, ny: number, level: number): number {
    const t = this.along(ax, ay)
    const centerZ = this.profile === 3 ? this.stockBottomZ : this.stationary ? this.stationaryZ : this.z0 + this.segDz * t
    const rise = level - centerZ
    let reach = Math.sqrt(this.reachSq)
    if (this.profile === 1 && rise < this.radius) {
      const below = this.radius - Math.max(0, rise)
      reach = Math.sqrt(Math.max(0, this.radiusSq - below * below))
    } else if (this.profile === 2 && this.vBitInvSlope > 0) {
      reach = Math.min(reach, Math.max(0, rise) / this.vBitInvSlope)
    }
    const dx = nx - ax
    const dy = ny - ay
    const reachSq = reach * reach
    // Most crossings leave through the side of the path, not round an end:
    // then the exit is one division and the normal the path's own.
    let s0 = 0
    let s1 = 0
    let u0 = 0
    let u1 = 0
    if (!this.stationary) {
      s0 = (ax - this.x0) * this.perpX + (ay - this.y0) * this.perpY
      s1 = dx * this.perpX + dy * this.perpY
      u0 = ((ax - this.x0) * this.segDx + (ay - this.y0) * this.segDy) * this.invSegLengthSq
      u1 = (dx * this.segDx + dy * this.segDy) * this.invSegLengthSq
      if (s1 !== 0 && s0 >= -reach && s0 <= reach && u0 >= 0 && u0 <= 1) {
        const side = ((s1 > 0 ? reach : -reach) - s0) / s1
        const u = u0 + u1 * side
        if (u >= 0 && u <= 1) {
          this.exitAngleCode = s1 > 0 ? this.perpCode : (this.perpCode + 128) & 255
          return side < 0 ? 0 : side > 1 ? 1 : side
        }
      }
    }
    // Intervals of the line inside each piece, chained from the start.
    let slabLow = 1
    let slabHigh = -1
    if (!this.stationary) {
      // |s0 + s1 t| <= reach across the path, 0 <= u0 + u1 t <= 1 along it.
      slabLow = -Infinity
      slabHigh = Infinity
      if (s1 === 0) {
        if (s0 < -reach || s0 > reach) slabHigh = -Infinity
      } else {
        const ta = (-reach - s0) / s1
        const tb = (reach - s0) / s1
        slabLow = ta < tb ? ta : tb
        slabHigh = ta < tb ? tb : ta
      }
      if (u1 === 0) {
        if (u0 < 0 || u0 > 1) slabHigh = -Infinity
      } else {
        const ta = -u0 / u1
        const tb = (1 - u0) / u1
        slabLow = Math.max(slabLow, ta < tb ? ta : tb)
        slabHigh = Math.min(slabHigh, ta < tb ? tb : ta)
      }
    }
    // Disc at each end of the path: |a + t d - p|^2 <= reach^2.
    const lineSq = dx * dx + dy * dy
    let fx = ax - this.x0
    let fy = ay - this.y0
    let half = (fx * dx + fy * dy) / lineSq
    let disc = half * half - (fx * fx + fy * fy - reachSq) / lineSq
    const startLow = disc < 0 ? 1 : -half - Math.sqrt(disc)
    const startHigh = disc < 0 ? -1 : -half + Math.sqrt(disc)
    let endLow = 1
    let endHigh = -1
    if (!this.stationary) {
      fx = ax - (this.x0 + this.segDx)
      fy = ay - (this.y0 + this.segDy)
      half = (fx * dx + fy * dy) / lineSq
      disc = half * half - (fx * fx + fy * fy - reachSq) / lineSq
      if (disc >= 0) {
        endLow = -half - Math.sqrt(disc)
        endHigh = -half + Math.sqrt(disc)
      }
    }
    let end = 0
    for (let pass = 0; pass < 3; pass += 1) {
      if (slabLow <= end + 1e-12 && slabHigh > end) end = slabHigh
      if (startLow <= end + 1e-12 && startHigh > end) end = startHigh
      if (endLow <= end + 1e-12 && endHigh > end) end = endHigh
    }
    const fraction = end < 0 ? 0 : end > 1 ? 1 : end
    const px = ax + dx * fraction
    const py = ay + dy * fraction
    const nearest = this.along(px, py)
    const normalX = px - (this.x0 + this.segDx * nearest)
    const normalY = py - (this.y0 + this.segDy * nearest)
    this.exitAngleCode = normalX === 0 && normalY === 0 ? encodeCrossingAngle(dx, dy) : encodeCrossingAngle(normalX, normalY)
    return fraction
  }

  /** The nearest point of the tool's path. */
  axisX(x: number, y: number): number {
    return this.x0 + this.segDx * this.along(x, y)
  }

  axisY(x: number, y: number): number {
    return this.y0 + this.segDy * this.along(x, y)
  }
}

/**
 * Record where this move's boundary crosses the lines from cell `(col, row)`
 * toward the neighbours that lie outward from the tool. Called by the kernel
 * only for cells this move cut to their current height (`heightA`), near the
 * edge of its reach or where it bottoms out. `lowered` says the move lowered
 * the cell: a crossing it finds replaces the old one; otherwise the move only
 * matched an earlier cut at the same depth, and the crossing that reaches
 * further toward the neighbour wins (the union of the two cuts).
 *
 * Only edges the shared step test could call a wall are searched — one side on
 * the stock bottom, or a rise steeper than `SHALLOW_SLOPE_CELLS` — the same
 * cheap test `edgeMayBeStep` makes on the GPU. Returns the cells it wrote, as
 * a bit per neighbour (1 horizontal, 2 vertical), or 0.
 */
export function stampEdgeCrossings(
  crossings: Uint8Array,
  topZ: Float32Array,
  cols: number,
  rows: number,
  originX: number,
  originY: number,
  cellSize: number,
  stockBottomZ: number,
  cutter: SweptCutter,
  col: number,
  row: number,
  heightA: number,
  lowered: boolean,
  outwardX: number,
  outwardY: number,
): number {
  let written = 0
  const ax = originX + (col + 0.5) * cellSize
  const ay = originY + (row + 0.5) * cellSize
  for (let axis = 0; axis < 2; axis += 1) {
    const outward = axis === 0 ? outwardX : outwardY
    if (outward === 0) continue
    const step = outward > 0 ? 1 : -1
    const nCol = axis === 0 ? col + step : col
    const nRow = axis === 0 ? row : row + step
    if (nCol < 0 || nCol >= cols || nRow < 0 || nRow >= rows) continue
    const heightNow = topZ[nRow * cols + nCol]
    if (heightNow <= heightA + 1e-9) continue
    // The neighbour can only end lower than it is now, so a rise too small to
    // be a step now never will be: decided without evaluating the cutter.
    const throughA = heightA <= stockBottomZ + 1e-6
    if (!throughA && heightNow - heightA <= SHALLOW_SLOPE_CELLS * cellSize) continue
    const nx = axis === 0 ? ax + step * cellSize : ax
    const ny = axis === 0 ? ay : ay + step * cellSize
    const cutN = cutter.cutAt(nx, ny)
    const stampedN = cutN > stockBottomZ ? cutN : stockBottomZ
    const heightN = stampedN < heightNow ? stampedN : heightNow
    if (heightN <= heightA + 1e-9) continue
    if (!throughA && heightN - heightA <= SHALLOW_SLOPE_CELLS * cellSize) continue

    // The tool's surface rises through this level exactly once on the way
    // out; for a flat cutter that is its rim. Beside a through cut the hole
    // ends where the surface leaves the stock bottom, however thin the skin
    // past it; between two floors, halfway up the rise.
    const level = throughA ? stockBottomZ + 1e-6 : (heightA + heightN) / 2

    // The edge is stored on its low-index cell, measured from that cell's centre.
    const ownerCol = step > 0 ? col : nCol
    const ownerRow = step > 0 ? row : nRow
    const offset = (ownerRow * cols + ownerCol) * EDGE_CROSSING_STRIDE + (axis === 0 ? EDGE_CROSSING_EAST : EDGE_CROSSING_SOUTH)
    if (!lowered) {
      // A pass matching an earlier one's depth matters only if it reaches
      // past the crossing already there; most overlapping passes do not, and
      // one probe a code step further out says so.
      const existing = crossings[offset]
      if (existing !== EDGE_CROSSING_NONE) {
        const existingFromA = step > 0 ? decodeCrossingPosition(existing) : 1 - decodeCrossingPosition(existing)
        const probe = existingFromA + 1 / 254
        if (probe >= 1 || cutter.cutAt(ax + (nx - ax) * probe, ay + (ny - ay) * probe) > level) continue
      }
    }
    const fraction = cutter.exitFraction(ax, ay, nx, ny, level)
    const fromOwner = step > 0 ? fraction : 1 - fraction
    if (!lowered) {
      // A pass matching an earlier one's depth wins only if it reaches further.
      const existing = crossings[offset]
      if (existing !== EDGE_CROSSING_NONE) {
        const existingFromA = step > 0 ? decodeCrossingPosition(existing) : 1 - decodeCrossingPosition(existing)
        if (existingFromA >= fraction) continue
      }
    }
    crossings[offset] = encodeCrossingPosition(fromOwner)
    crossings[offset + 1] = cutter.exitAngleCode
    written |= axis === 0 ? 1 : 2
  }
  return written
}
