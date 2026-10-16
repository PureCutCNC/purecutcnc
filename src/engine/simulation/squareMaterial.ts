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
 * Square-blank material intervals and the physical finite-cutter kernel
 * (issue #1016 C2-R1F).
 *
 * `topZ` alone cannot represent square material. A pass can cut a groove part
 * way out along a cell's radial ray and leave the lip beyond it standing, so
 * one cell holds two surviving pieces — an inner core and an outer shell —
 * separated by air the cutter reached. Keeping only the outermost endpoint of
 * the connected removed band loses where the outer shell runs (manager
 * measurement: at along 50 / A0 of the actual generated rough, a 50° ray
 * loses `[9.3314, 10.4433]` while `[10.4433, 13.0541]` survives), and no
 * fixed-point sweep over an outer height can put it back.
 *
 * So square material is stored per cell as the **remaining canonical radial
 * intervals**: ordered, disjoint `[lo, hi]` endpoint pairs measured from the
 * true pivot — a 1D CSG per ray. A key missing from the map is virgin
 * material; an empty array is fully removed. Values are immutable after
 * assignment: a cut replaces a cell's canonical array and never mutates one,
 * so a shared array cannot alias two grids.
 *
 * ## The cutter
 *
 * Take the machine plane spanned by the bar axis and the pivot's radial
 * direction. A material point at radius `u` on the cell's ray, whose machine
 * angle differs from the tool's program angle by `θ`, sits at
 *
 *     radial = u·cos θ,   across = u·sin θ
 *
 * from the pivot. The tool is a **solid of revolution about the radial axis**
 * whose tip rides it at radial height `tip` (`move.z`) and which is confined
 * to `±rt` about the tool's own bar position:
 *
 *   - **flat**: the cylinder `radial ≥ tip`, radius `rt` — its radial reach on
 *     an oblique ray is `√(rt² − Δx²)/|sin θ|` (the cylinder wall) and its
 *     floor is `tip/cos θ`;
 *   - **ball**: the ball of radius `rt` centred at radial `tip + rt` (the lower
 *     hemisphere — it reaches down to `tip` on the axis), **plus the
 *     cylindrical shank beyond its equator**, `radial ≥ tip + rt` with the same
 *     radius. A bare-sphere kernel loses the shank entirely (measured:
 *     constant tip 5, radius 2 leaves radius 10 instead of 5).
 *
 * A move keeps the tip radius and the along coordinate **correlated**: at one
 * parameter the tip sits at `tip(s)`, the tool at `along(s)`, so a cell's axial
 * offset is `Δx(s) = cellAlong − along(s)`. Both the sphere and the shank cut
 * the cell's ray in a closed-form interval, and the material removed by the
 * whole move is the union of those intervals. For a constant-angle move the
 * swept body is convex, so that union is exactly `[min_s floor(s),
 * max_s reach(s)]` — solved here by a scan whose bracket is then converged, so
 * the result does not depend on the scan count. A move that changes the program
 * angle rotates the body and is split into small chunks whose sampled intervals
 * are merged.
 */

import type { ToolType } from '../../types/project'
import type { ToolpathMove, ToolpathPoint } from '../toolpaths/types'
import type { DirtyRegion, SimulationGrid } from './types'

const TWO_PI = Math.PI * 2

/**
 * Scan points across a move parameter window before the extrema are converged.
 * This is a resolution floor, not the accuracy: the winning bracket is refined
 * to machine precision afterwards.
 */
const SCAN_POINTS = 64

/** Golden-section iterations: 48 shrinks a bracket to ~1e-10 of its width. */
const REFINE_ITERATIONS = 48

/** Samples per chunk for a move whose program angle changes (chunked body). */
const ANGLED_SAMPLES = 48

/** Relative tolerance of one Float32 ulp, for "did the stored value move". */
const ULP = 2 ** -23

export interface SquareApplyResult {
  changedCount: number
  dirtyRegion: DirtyRegion | null
}

const ZERO_RESULT: SquareApplyResult = { changedCount: 0, dirtyRegion: null }

/** True for the two cutter bodies the square kernel can model physically. */
export function squareToolSupported(toolType: ToolType): boolean {
  return toolType === 'flat_endmill' || toolType === 'ball_endmill'
}

/**
 * Validate a transient square descriptor before it initializes a grid: the
 * side must be finite and positive and the frame must be the square's own
 * nominal reference cylinder (`radius = side/2`, `circumference = π·side`).
 * Throws a `RangeError` on anything else — a mismatched frame would silently
 * map every cell to the wrong angle.
 */
export function validateSquareBarDescriptor(descriptor: SquareBarDescriptorLike): void {
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

interface SquareBarDescriptorLike {
  side: number
  frame: {
    axis: 'x' | 'y'
    centre: number
    radius: number
    zero: number
    sheetStart: number
    circumference: number
  }
}

/** Validate a transient square descriptor before it initializes a grid. */
export function squareSurfaceRadius(side: number, angle: number): number {
  return (side / 2) / Math.max(Math.abs(Math.sin(angle)), Math.abs(Math.cos(angle)))
}

/**
 * The remaining radial intervals of one grid cell, always a canonical set:
 * ordered, disjoint, non-negative `[lo, hi]` pairs. A cell missing from
 * `squareMaterial` is virgin material — `[stockBottomZ, initialTopZ[index]]` —
 * and an empty array is fully removed.
 *
 * This is the frozen transient API the square renderer consumes: read every
 * pair, not just the outermost endpoint, and rebuild when the cell lands in a
 * dirty region.
 */
export function squareMaterialIntervals(grid: SimulationGrid, index: number): readonly number[] {
  const stored = grid.squareMaterial?.get(index)
  if (stored !== undefined) return stored
  const baseline = grid.initialTopZ
  if (!baseline) return [grid.stockBottomZ, grid.stockTopZ]
  return [grid.stockBottomZ, baseline[index]]
}

/**
 * Replace one cell's remaining material. `intervals` must already be
 * canonical; the array is stored as given, which is why a cut always builds a
 * new one instead of editing a live cell in place.
 */
export function setSquareMaterialIntervals(
  grid: SimulationGrid,
  index: number,
  intervals: readonly number[],
): void {
  let map = grid.squareMaterial
  if (!map) {
    map = new Map<number, readonly number[]>()
    grid.squareMaterial = map
  }
  map.set(index, intervals)
}

/** Copy a square material map; the immutable interval arrays may share. */
export function cloneSquareMaterial(
  source: ReadonlyMap<number, readonly number[]> | undefined,
): Map<number, readonly number[]> | undefined {
  if (!source) return undefined
  return new Map(source)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/** Wrap an angle difference into (-π, π]; the blank is periodic. */
function wrapPi(angle: number): number {
  let wrapped = angle % TWO_PI
  if (wrapped > Math.PI) wrapped -= TWO_PI
  else if (wrapped <= -Math.PI) wrapped += TWO_PI
  return wrapped
}

/** A move in the unrolled sheet, already resolved to along/tip/angle axes. */
interface MoveGeometry {
  fromAlong: number
  toAlong: number
  fromAcross: number
  toAcross: number
  tipFrom: number
  tipTo: number
  /**
   * The explicit rotary program angle in radians at each end, or null when the
   * move carries none — in which case the program angle is the move's own
   * across position mapped through the frame, exactly as the sheet unrolls it.
   */
  angleFrom: number | null
  angleTo: number | null
  zero: number
  anglePerAcross: number
}

/** The explicit rotary program angle at move parameter `s`, or null. */
function explicitAngleAt(geometry: MoveGeometry, s: number): number | null {
  if (geometry.angleFrom === null || geometry.angleTo === null) return null
  return geometry.angleFrom + (geometry.angleTo - geometry.angleFrom) * s
}

/**
 * The machine angle between a cell's ray and the tool's program angle, in
 * radians. When the move carries no explicit rotary coordinate the difference
 * is taken from the across coordinates themselves, so a move and the same move
 * one circumference on are bit-identical rather than differing by a wrapped
 * 2π.
 */
function thetaAt(geometry: MoveGeometry, cellAcross: number, s: number): number {
  const explicit = explicitAngleAt(geometry, s)
  if (explicit !== null) {
    const materialAngle = (cellAcross - geometry.zero) * geometry.anglePerAcross
    return wrapPi(materialAngle - explicit)
  }
  const toolAcross = geometry.fromAcross + (geometry.toAcross - geometry.fromAcross) * s
  return wrapPi((cellAcross - toolAcross) * geometry.anglePerAcross)
}

/** True when the move's program angle is constant over its whole travel. */
function angleIsConstant(geometry: MoveGeometry): boolean {
  return geometry.angleFrom !== null && geometry.angleTo !== null
    ? geometry.angleFrom === geometry.angleTo
    : geometry.fromAcross === geometry.toAcross
}

/** The radial endpoints of the interval one instant cuts, or null. */
function poseEdges(
  cellAlong: number,
  cellAcross: number,
  geometry: MoveGeometry,
  s: number,
  rt: number,
  ball: boolean,
): [number, number] | null {
  const along = geometry.fromAlong + (geometry.toAlong - geometry.fromAlong) * s
  const tip = geometry.tipFrom + (geometry.tipTo - geometry.tipFrom) * s
  const theta = thetaAt(geometry, cellAcross, s)
  const cos = Math.cos(theta)
  if (!(cos > 0)) return null
  const sinAbs = Math.abs(Math.sin(theta))
  const dx = cellAlong - along
  if (!(dx * dx <= rt * rt)) return null
  const reach = sinAbs < 1e-12 ? Infinity : Math.sqrt(rt * rt - dx * dx) / sinAbs
  if (!ball) {
    const low = tip / cos
    return low <= reach ? [low, reach] : null
  }
  const centre = tip + rt
  const disc = rt * rt - centre * centre * sinAbs * sinAbs - dx * dx
  let low = Infinity
  let high = -Infinity
  if (disc >= 0) {
    const root = Math.sqrt(disc)
    low = Math.min(low, centre * cos - root)
    high = Math.max(high, centre * cos + root)
  }
  const shankLow = centre / cos
  if (shankLow <= reach) {
    low = Math.min(low, shankLow)
    high = Math.max(high, reach)
  }
  return high >= low ? [low, high] : null
}

/**
 * The move-parameter window over which the tool's own bar position can reach a
 * cell, i.e. `|along(s) − cellAlong| ≤ rt`. Null when the move never reaches
 * it — that is the O(1) above-envelope rejection the generators rely on.
 */
function reachableWindow(cellAlong: number, geometry: MoveGeometry, rt: number): [number, number] | null {
  const d = geometry.toAlong - geometry.fromAlong
  if (d === 0) {
    return Math.abs(cellAlong - geometry.fromAlong) <= rt ? [0, 1] : null
  }
  const tLow = (cellAlong - rt - geometry.fromAlong) / d
  const tHigh = (cellAlong + rt - geometry.fromAlong) / d
  const lo = Math.max(0, Math.min(tLow, tHigh))
  const hi = Math.min(1, Math.max(tLow, tHigh))
  return hi > lo ? [lo, hi] : null
}

/** Golden-section search for the minimum of `evaluate` on [lo, hi]. */
function minimize(lo: number, hi: number, evaluate: (s: number) => number): number {
  const invPhi = (Math.sqrt(5) - 1) / 2
  let a = lo
  let b = hi
  let c = b - (b - a) * invPhi
  let d = a + (b - a) * invPhi
  let fc = evaluate(c)
  let fd = evaluate(d)
  for (let i = 0; i < REFINE_ITERATIONS; i += 1) {
    if (fc < fd) {
      b = d
      d = c
      fd = fc
      c = b - (b - a) * invPhi
      fc = evaluate(c)
    } else {
      a = c
      c = d
      fc = fd
      d = a + (b - a) * invPhi
      fd = evaluate(d)
    }
  }
  return Math.min(fc, fd, evaluate((a + b) / 2))
}

/**
 * The radial bands a move removes from one cell's ray, canonical and ascending.
 * Null when the body never meets it.
 *
 * A constant-angle move sweeps a convex body, so its removed set is one
 * interval `[min floor, max reach]`; the extrema are scanned then converged, so
 * a sloping pass keeps its tip and its axial position correlated instead of
 * collapsing onto a global `minZ`. A move whose program angle changes rotates
 * the body, so it is sampled in small chunks and the intervals merged.
 */
function removedBandsForCell(
  cellAlong: number,
  cellAcross: number,
  geometry: MoveGeometry,
  rt: number,
  ball: boolean,
): Array<[number, number]> | null {
  const window = reachableWindow(cellAlong, geometry, rt)
  if (!window) return null
  const [loS, hiS] = window

  if (angleIsConstant(geometry)) {
    const edgeAt = (s: number): number => {
      const edges = poseEdges(cellAlong, cellAcross, geometry, s, rt, ball)
      return edges ? edges[0] : Infinity
    }
    const highAt = (s: number): number => {
      const edges = poseEdges(cellAlong, cellAcross, geometry, s, rt, ball)
      return edges ? edges[1] : -Infinity
    }
    // Scan for the bracket, then converge it — the result does not depend on
    // the scan count, only on the physical endpoints.
    let low = Infinity
    let high = -Infinity
    let lowIndex = 0
    let highIndex = 0
    for (let i = 0; i <= SCAN_POINTS; i += 1) {
      const s = loS + ((hiS - loS) * i) / SCAN_POINTS
      const edges = poseEdges(cellAlong, cellAcross, geometry, s, rt, ball)
      if (!edges) continue
      if (edges[0] < low) {
        low = edges[0]
        lowIndex = i
      }
      if (edges[1] > high) {
        high = edges[1]
        highIndex = i
      }
    }
    if (!Number.isFinite(low) && !Number.isFinite(high)) return null
    const step = (hiS - loS) / SCAN_POINTS
    const lowBracket: [number, number] = [
      Math.max(loS, loS + (lowIndex - 1) * step),
      Math.min(hiS, loS + (lowIndex + 1) * step),
    ]
    const highBracket: [number, number] = [
      Math.max(loS, loS + (highIndex - 1) * step),
      Math.min(hiS, loS + (highIndex + 1) * step),
    ]
    const fixedLow = Number.isFinite(lowBracket[0]) && lowIndex > 0 && lowIndex < SCAN_POINTS
      ? minimize(lowBracket[0], lowBracket[1], edgeAt)
      : low
    const fixedHigh = Number.isFinite(highBracket[0]) && highIndex > 0 && highIndex < SCAN_POINTS
      ? -minimize(highBracket[0], highBracket[1], (s) => -highAt(s))
      : high
    const finalLow = Math.min(low, fixedLow)
    const finalHigh = Math.max(high, fixedHigh)
    if (!(finalHigh > finalLow)) return null
    return [[finalLow, finalHigh]]
  }

  // Angle-changing move: rotate the body in small chunks and merge the
  // intervals, so a diagonal submove cannot step over a band.
  const angleSpan = geometry.angleFrom !== null && geometry.angleTo !== null
    ? Math.abs(wrapPi(geometry.angleTo - geometry.angleFrom))
    : Math.abs(wrapPi((geometry.toAcross - geometry.fromAcross) * geometry.anglePerAcross))
  const chunks = Math.max(1, Math.min(64, Math.ceil(angleSpan / 0.05)))
  const bands: Array<[number, number]> = []
  for (let chunk = 0; chunk < chunks; chunk += 1) {
    const c0 = chunk / chunks
    const c1 = (chunk + 1) / chunks
    const s0 = loS + (hiS - loS) * c0
    const s1 = loS + (hiS - loS) * c1
    for (let i = 0; i <= ANGLED_SAMPLES; i += 1) {
      const s = s0 + ((s1 - s0) * i) / ANGLED_SAMPLES
      const edges = poseEdges(cellAlong, cellAcross, geometry, s, rt, ball)
      if (edges) bands.push(edges)
    }
  }
  if (bands.length === 0) return null
  return mergeIntervals(bands, 1e-9 * (1 + Math.abs(rt)))
}

/** Merge overlapping and touching intervals into a canonical ascending order. */
function mergeIntervals(intervals: Array<[number, number]>, epsilon: number): Array<[number, number]> {
  intervals.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const [lo, hi] of intervals) {
    if (!(hi > lo)) continue
    const last = merged.length > 0 ? merged[merged.length - 1] : null
    if (last && lo <= last[1] + epsilon) {
      if (hi > last[1]) last[1] = hi
    } else {
      merged.push([lo, hi])
    }
  }
  return merged
}

/**
 * Subtract one removed band from a canonical material array, returning a new
 * canonical array (or the same reference when nothing survived changed).
 */
function subtractBand(material: readonly number[], lo: number, hi: number): readonly number[] {
  let out: number[] | null = null
  for (let i = 0; i < material.length; i += 2) {
    const mLo = material[i]
    const mHi = material[i + 1]
    if (!(mHi > lo) || !(mLo < hi)) {
      // This interval is disjoint from the band and survives untouched.
      if (out) out.push(mLo, mHi)
      continue
    }
    if (!out) {
      out = []
      for (let j = 0; j < i; j += 1) out.push(material[j])
    }
    if (mLo < lo) out.push(mLo, Math.min(mHi, lo))
    if (mHi > hi) out.push(Math.max(mLo, hi), mHi)
  }
  return out ?? material
}

/**
 * Canonicalize a subtracted material array: merge bands that meet within one
 * Float32 ulp and drop intervals whose width is below it. Two geometrically
 * identical boundaries reached through different arithmetic differ by a few
 * Float32 ulps, and without this they would leave a hairline sliver that a
 * later pass could expose as a false surviving shell.
 */
function compactIntervals(intervals: number[]): number[] {
  const out: number[] = []
  for (let i = 0; i < intervals.length; i += 2) {
    const lo = intervals[i]
    const hi = intervals[i + 1]
    if (!(hi > lo)) continue
    const epsilon = Math.max(1, Math.abs(hi)) * ULP
    const last = out.length >= 2 ? out[out.length - 1] : null
    if (last !== null && lo - last <= epsilon) {
      if (hi > last) out[out.length - 1] = hi
      continue
    }
    if (hi - lo <= epsilon) continue
    out.push(lo, hi)
  }
  return out
}

/**
 * Whether two canonical interval arrays differ by more than one Float32 ulp at
 * any endpoint. The stored heights are Float32, so a removal smaller than that
 * resolves to the same value and is not a change — the just-touch boundary
 * must not count as removed material.
 */
function materialDiffers(next: readonly number[], previous: readonly number[]): boolean {
  if (next.length !== previous.length) return true
  for (let i = 0; i < next.length; i += 1) {
    const scale = Math.max(Math.abs(next[i]), Math.abs(previous[i]), 1)
    if (Math.abs(next[i] - previous[i]) > scale * ULP) return true
  }
  return false
}

function finitePoint(point: ToolpathPoint): boolean {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) return false
  if (point.a !== undefined && !Number.isFinite(point.a)) return false
  return true
}

/**
 * The physical square cut kernel. `move` is in the unrolled Around sheet: its
 * along coordinate is the bar axis, its `a` is the program angle the stock is
 * turned to, and `z` is the tool tip's radial distance above the pivot.
 * Returns the number of cells whose material actually changed and the dirty
 * rectangle, exactly like the flat/round kernel.
 *
 * A cell counts as changed whenever its remaining intervals lose material —
 * including an interior interval whose outer `topZ` is unchanged, which the
 * envelope-only representation could not report at all.
 */
export function applySquareMoveToGrid(
  grid: SimulationGrid,
  move: ToolpathMove,
  toolRadius: number,
  toolType: ToolType,
): SquareApplyResult {
  const bar = grid.squareBar
  if (!bar) return ZERO_RESULT
  if (!Number.isFinite(toolRadius) || toolRadius <= 0) {
    throw new RangeError(`square kernel: tool radius must be a positive finite number, got ${toolRadius}`)
  }
  if (!squareToolSupported(toolType)) {
    throw new RangeError(`square kernel: tool type '${toolType}' is not supported; the square kernel models flat and ball cutters only`)
  }
  if (!Number.isFinite(grid.cellSize) || grid.cellSize <= 0 || grid.cols <= 0 || grid.rows <= 0) {
    throw new RangeError('square kernel: grid cell size and dimensions must be positive and finite')
  }
  if (!finitePoint(move.from) || !finitePoint(move.to)) {
    throw new RangeError('square kernel: move coordinates must be finite')
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

  const anglePerAcross = TWO_PI / frame.circumference
  // The program angle is the move's explicit rotary coordinate when it carries
  // one, and otherwise the across position the sheet unrolls it to.
  const explicitAngle = move.from.a !== undefined && move.to.a !== undefined
  const angleFrom = explicitAngle ? (move.from.a as number) * Math.PI / 180 : null
  const angleTo = explicitAngle ? (move.to.a as number) * Math.PI / 180 : null

  // A tip above the whole blank can never reach any cell's outer surface: the
  // tip plane crossing z/cos θ is then above the material everywhere. This is
  // the above-envelope link the generators retract through, and it costs O(1).
  if (Math.min(move.from.z, move.to.z) >= grid.stockTopZ) {
    return ZERO_RESULT
  }

  const geometry: MoveGeometry = {
    fromAlong,
    toAlong,
    fromAcross,
    toAcross,
    tipFrom: move.from.z,
    tipTo: move.to.z,
    angleFrom,
    angleTo,
    zero: frame.zero,
    anglePerAcross,
  }
  const topZ = grid.topZ
  const bottom = grid.stockBottomZ
  let changed = 0
  let dirtyColMin = grid.cols
  let dirtyColMax = -1
  let dirtyRowMin = grid.rows
  let dirtyRowMax = -1

  const [alongStart, alongEnd] = pointToCellRange(
    Math.min(fromAlong, toAlong) - rt,
    Math.max(fromAlong, toAlong) + rt,
    alongOrigin,
    cellSize,
    alongCount,
  )

  for (let a = alongStart; a <= alongEnd; a += 1) {
    const along = alongOrigin + (a + 0.5) * cellSize
    for (let c = 0; c < acrossCount; c += 1) {
      const across = acrossOrigin + (c + 0.5) * cellSize
      const col = xAxis ? a : c
      const row = xAxis ? c : a
      const idx = row * grid.cols + col
      const height = topZ[idx]
      if (!(height > bottom + 1e-12)) continue

      const bands = removedBandsForCell(along, across, geometry, rt, ball)
      if (!bands) continue

      const material = squareMaterialIntervals(grid, idx)
      let next: readonly number[] = material
      for (const [bandLo, bandHi] of bands) {
        const lo = bandLo > bottom ? bandLo : bottom
        const hi = bandHi < height ? bandHi : height
        if (!(hi > lo)) continue
        next = subtractBand(next, lo, hi)
      }
      if (next !== material) next = compactIntervals([...next])
      if (!materialDiffers(next, material)) continue

      setSquareMaterialIntervals(grid, idx, next)
      topZ[idx] = next.length > 0 ? Math.fround(next[next.length - 1]) : bottom
      changed += 1
      if (col < dirtyColMin) dirtyColMin = col
      if (col > dirtyColMax) dirtyColMax = col
      if (row < dirtyRowMin) dirtyRowMin = row
      if (row > dirtyRowMax) dirtyRowMax = row
    }
  }

  return {
    changedCount: changed,
    dirtyRegion: changed > 0 ? { colMin: dirtyColMin, colMax: dirtyColMax, rowMin: dirtyRowMin, rowMax: dirtyRowMax } : null,
  }
}

function pointToCellRange(min: number, max: number, origin: number, cellSize: number, count: number): [number, number] {
  const start = clamp(Math.floor((min - origin) / cellSize), 0, count - 1)
  const end = clamp(Math.floor((max - origin) / cellSize), 0, count - 1)
  return [Math.min(start, end), Math.max(start, end)]
}
