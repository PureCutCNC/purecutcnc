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

import {
  buildPeakLimitMap,
  thinFeaturePeakThreshold,
  triangleMaxZInCell,
} from './finishSurfaceParallel'
import type { HeightMap, HeightMapBuildOptions } from './finishSurfaceParallel'

/**
 * Per-triangle source data laid out in the order a raster walks it (issue #1045
 * slice T). The height-map kernel reads one contiguous record per candidate
 * triangle instead of chasing three vertex indices through four large arrays,
 * which is the cost that dominates an around operation: the candidate set is a
 * few hundred thousand triangles per angle, each of them covering at most a
 * couple of cells.
 *
 * `section` holds `(across, up)` per corner, measured from the centreline and
 * the turning pivot exactly as the sampler's cross-section does; `along` holds
 * the coordinate on the bar's axis, which rotation leaves untouched. The
 * bar-axis coordinate is also the raster's *fixed* axis: its cell range does
 * not change with the turn, so `axisCells` caches it once per cell size.
 */
export interface RotaryRasterGeometry {
  /** 6 values per triangle: `a0, u0, a1, u1, a2, u2`. */
  readonly section: Float64Array
  /** 3 values per triangle: the axial coordinate of each corner. */
  readonly along: Float32Array
  /** Two cell indices per triangle on the bar's axis; rebuilt when the cell size or grid origin changes. */
  axisCells?: Int32Array
  /**
   * Two **overlap** cell indices per triangle on the bar's axis (the `floor`
   * range, not the centre range). Angle-independent, so it is built once with
   * `axisCells` and reused by the clip pass (issue #1050 slice C).
   */
  axisBBoxCells?: Int32Array
  axisCellSize?: number
  axisCellOrigin?: number
  /**
   * The triangles in runs of {@link CLIP_BLOCK_SIZE} consecutive indices, each
   * with a circle round its cross-section points (#1185 C1). Angle-independent,
   * built on first use by {@link rotaryClipBlocks}.
   */
  clipBlocks?: RotaryClipBlocks
  /**
   * Each block's overlap cell range on the bar's axis: two indices per block,
   * built with `axisBBoxCells` for the same cell size and origin.
   */
  blockAxisCells?: Int32Array
  /** Per block, the map (see `buildRotaryHeightMap`) whose clip pass last judged it, and how. */
  blockVerdict?: Uint32Array
  /** Counts the maps this geometry has rasterised, to date `blockVerdict` without clearing it. */
  blockEpoch?: number
  /**
   * Each triangle's least distance from the turning axis in the cross-section,
   * rounded **down** to a Float32 (#1185 F1); `0` when the axis passes through
   * it. Angle-independent, built on first use by {@link rotaryAxisDistances}.
   */
  axisDistance?: Float32Array
}

/**
 * How many consecutive triangles make one clip block (#1185 C1). A power of two,
 * so a triangle's block is a shift.
 */
export const CLIP_BLOCK_SHIFT = 3
export const CLIP_BLOCK_SIZE = 1 << CLIP_BLOCK_SHIFT

/** A circle round each block's cross-section points: `(across, up)` centre and radius. */
export interface RotaryClipBlocks {
  /** 2 values per block: the centre's `across` and `up` from the axis. */
  readonly centre: Float64Array
  /** The largest distance from the centre to any corner of any triangle in the block. */
  readonly radius: Float64Array
}

/** Bytes the clip blocks cost for a mesh of `meshTriangles`; what a pool worker is charged for them. */
export function rotaryClipBlockBytes(meshTriangles: number): number {
  const blocks = Math.ceil(Math.max(0, Math.floor(meshTriangles)) / CLIP_BLOCK_SIZE)
  // Centre (2 doubles), radius (1 double), axis cell range (2 ints), verdict (1 int).
  return blocks * (2 * 8 + 8 + 2 * 4 + 4)
}

/**
 * The clip blocks of a geometry, built once (#1185 C1).
 *
 * The clip pass asks of every triangle that covers no cell centre whether it
 * stands above the cells it overlaps by more than the peak threshold, and on a
 * fine mesh the answer is no for all but a few in ten thousand -- after
 * projecting each one to find out. Consecutive triangles of a mesh are usually
 * neighbours in space, so a run of them fits in a small circle of the
 * cross-section; turned, nothing in that circle stands above its centre's height
 * plus its radius, and nothing in it lies outside the cells the circle spans. If
 * that height does not beat the lowest limit in those cells, no triangle of the
 * run can raise a cell, and the run is skipped with one test.
 *
 * A block whose triangles are scattered has a large circle and is simply never
 * skipped; the bound is a bound either way.
 */
export function rotaryClipBlocks(geometry: RotaryRasterGeometry): RotaryClipBlocks {
  const cached = geometry.clipBlocks
  if (cached !== undefined) return cached
  const section = geometry.section
  const triangleCount = Math.floor(section.length / 6)
  const blockCount = Math.ceil(triangleCount / CLIP_BLOCK_SIZE)
  const centre = new Float64Array(blockCount * 2)
  const radius = new Float64Array(blockCount)
  for (let b = 0; b < blockCount; b++) {
    const from = b * CLIP_BLOCK_SIZE * 6
    const to = Math.min(triangleCount, (b + 1) * CLIP_BLOCK_SIZE) * 6
    let minA = Infinity
    let maxA = -Infinity
    let minU = Infinity
    let maxU = -Infinity
    for (let p = from; p < to; p += 2) {
      const a = section[p]
      const u = section[p + 1]
      if (a < minA) minA = a
      if (a > maxA) maxA = a
      if (u < minU) minU = u
      if (u > maxU) maxU = u
    }
    const ca = (minA + maxA) / 2
    const cu = (minU + maxU) / 2
    let reach = 0
    for (let p = from; p < to; p += 2) {
      const d = Math.hypot(section[p] - ca, section[p + 1] - cu)
      // A corner that is not a number compares false with everything and would
      // pass unseen; it makes the reach infinite, and it stays so.
      if (!(d <= reach)) reach = d === d ? d : Infinity
    }
    centre[b * 2] = ca
    centre[b * 2 + 1] = cu
    // Rounded up: a larger circle is a weaker, safer bound. A block with a
    // corner that is not a number bounds nothing.
    radius[b] = Number.isFinite(reach) ? reach * (1 + 1e-9) + 1e-12 : Infinity
  }
  const blocks = { centre, radius }
  geometry.clipBlocks = blocks
  return blocks
}

/** The least distance from the origin to the segment `a`-`b`. */
function originSegmentDistance(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const lengthSq = dx * dx + dy * dy
  let t = lengthSq > 0 ? -(ax * dx + ay * dy) / lengthSq : 0
  if (t < 0) t = 0
  else if (t > 1) t = 1
  const px = ax + dx * t
  const py = ay + dy * t
  return Math.sqrt(px * px + py * py)
}

/** Bytes the per-triangle axis distances cost; what a pool worker is charged for them. */
export function rotaryAxisDistanceBytes(meshTriangles: number): number {
  return Math.max(0, Math.floor(meshTriangles)) * Float32Array.BYTES_PER_ELEMENT
}

/**
 * Every triangle's least distance from the turning axis, built once per
 * geometry (#1185 F1).
 *
 * A point of the cross-section at distance `rho` from the axis, turned so that
 * it lies `across` from the centreline on the far side of the bar, stands at
 * `-sqrt(rho^2 - across^2)` from the pivot. So a triangle that is nowhere nearer
 * the axis than `d` cannot stand higher than `-sqrt(d^2 - h^2)` anywhere inside
 * a strip of half-width `h` on the far side: this distance is what bounds a
 * far-side triangle's height without projecting it.
 *
 * The value is rounded down (a smaller distance is a higher, safer bound), and a
 * triangle the axis passes through, or one whose distance is not a number, gets
 * `0`, which bounds nothing.
 */
export function rotaryAxisDistances(geometry: RotaryRasterGeometry): Float32Array {
  const cached = geometry.axisDistance
  if (cached !== undefined) return cached
  const section = geometry.section
  const triangleCount = Math.floor(section.length / 6)
  const distances = new Float32Array(triangleCount)
  for (let t = 0; t < triangleCount; t++) {
    const s = t * 6
    const a0 = section[s], u0 = section[s + 1]
    const a1 = section[s + 2], u1 = section[s + 3]
    const a2 = section[s + 4], u2 = section[s + 5]
    // Edge functions of the origin: unless all three agree in sign it is inside
    // (or on) the triangle, and the distance is zero.
    const e0 = (a1 - a0) * -u0 - (u1 - u0) * -a0
    const e1 = (a2 - a1) * -u1 - (u2 - u1) * -a1
    const e2 = (a0 - a2) * -u2 - (u0 - u2) * -a2
    if (!((e0 < 0 || e1 < 0 || e2 < 0) && (e0 > 0 || e1 > 0 || e2 > 0))) continue
    const distance = Math.min(
      originSegmentDistance(a0, u0, a1, u1),
      originSegmentDistance(a1, u1, a2, u2),
      originSegmentDistance(a2, u2, a0, u0),
    )
    if (!(distance > 0) || !Number.isFinite(distance)) continue
    const rounded = Math.fround(distance * (1 - 1e-6))
    distances[t] = rounded > distance ? 0 : rounded
  }
  geometry.axisDistance = distances
  return distances
}

/** What the fused raster accepts beyond the general kernel's options. */
export interface RotaryHeightMapBuildOptions extends HeightMapBuildOptions {
  /**
   * The position in `triangles` where the **far-only** triangles begin (#1185
   * F1): triangles that reach this turn's strip only on the far side of the bar,
   * below the axis. The caller lists them last. From there on a triangle is
   * skipped when it provably cannot change the map; see `buildRotaryHeightMap`.
   * Omitted, every triangle is rasterised, which is the old behaviour.
   */
  readonly farOnlyStart?: number
}

/** The frozen rotary frame, in the form the sampler already has it. */
export interface RotaryRasterFrame {
  readonly axis: 'x' | 'y'
  readonly centre: number
  readonly pivot: number
  readonly cos: number
  readonly sin: number
  readonly geometry: RotaryRasterGeometry
}

/**
 * Flatten a mesh into the kernel's per-triangle records once per operation.
 * The values are the same doubles the sampler's `across`/`up` arrays hold, so
 * nothing downstream changes; only the layout does.
 */
export function buildRotaryRasterGeometry(
  positions: Float32Array,
  index: Uint32Array,
  axis: 'x' | 'y',
  centre: number,
  pivot: number,
): RotaryRasterGeometry {
  const triangleCount = Math.floor(index.length / 3)
  const section = new Float64Array(triangleCount * 6)
  const along = new Float32Array(triangleCount * 3)
  const acrossOffset = axis === 'x' ? 1 : 0
  const alongOffset = axis === 'x' ? 0 : 1
  for (let t = 0; t < triangleCount; t++) {
    const s = t * 6
    const l = t * 3
    for (let j = 0; j < 3; j++) {
      const p = index[t * 3 + j] * 3
      section[s + j * 2] = positions[p + acrossOffset] - centre
      section[s + j * 2 + 1] = positions[p + 2] - pivot
      along[l + j] = positions[p + alongOffset]
    }
  }
  return { section, along }
}

/**
 * Slack, in cell widths, on the cell-*centre* bounds below. It only ever
 * includes an extra cell at a rounding boundary, which the barycentric test
 * then rejects; a missing cell would change the map.
 */
export const CENTRE_SLACK = 1e-7

/**
 * Relative slack added to a far-side triangle's height bound before it is
 * compared with the samples already in the map (#1185 F1). The bound is exact in
 * real arithmetic; the heights it is compared with are Float32. `1e-5` is over a
 * hundred Float32 steps, so rounding cannot be what lets a triangle be skipped.
 */
const FAR_SIDE_SLACK = 1e-5

/**
 * Per-triangle range of cell **centres** on the bar's axis at `cellSize`.
 *
 * This is the centre-sampling range: it is the exact axial band the raster must
 * visit to catch a triangle that covers a cell centre at some angle, because
 * rotation never moves that axis. It is **not** a cull any more: since #1050 a
 * triangle whose axial span contains no centre may still be a local peak over a
 * cell it overlaps, so the kernel also visits that triangle's bbox range when
 * it reaches the clip pass.
 *
 * It is a superset of the centres inside the triangle: a centre outside the
 * corner span is rejected by the barycentric test anyway, and the range being
 * narrower than `buildHeightMap`'s `floor` bbox cannot remove a cell whose
 * centre the map would have accepted.
 */
function axisCellRange(
  geometry: RotaryRasterGeometry,
  cellSize: number,
  fixedMin: number,
): Int32Array {
  const cached = geometry.axisCells
  if (cached && geometry.axisCellSize === cellSize && geometry.axisCellOrigin === fixedMin) return cached
  const along = geometry.along
  const triangleCount = Math.floor(along.length / 3)
  const range = new Int32Array(triangleCount * 2)
  const bbox = new Int32Array(triangleCount * 2)
  for (let t = 0; t < triangleCount; t++) {
    const l = t * 3
    const a = along[l]
    const b = along[l + 1]
    const c = along[l + 2]
    let lo = a
    let hi = a
    if (b < lo) lo = b
    else if (b > hi) hi = b
    if (c < lo) lo = c
    else if (c > hi) hi = c
    // Cell `j` has its centre at `origin + (j + 0.5) * cell`.
    range[t * 2] = Math.ceil((lo - fixedMin) / cellSize - 0.5 - CENTRE_SLACK)
    range[t * 2 + 1] = Math.floor((hi - fixedMin) / cellSize - 0.5 + CENTRE_SLACK)
    bbox[t * 2] = Math.floor((lo - fixedMin) / cellSize)
    bbox[t * 2 + 1] = Math.floor((hi - fixedMin) / cellSize)
  }
  // #1185 C1: each clip block's overlap range is the union of its triangles'.
  const blockCount = Math.ceil(triangleCount / CLIP_BLOCK_SIZE)
  const blockRange = new Int32Array(blockCount * 2)
  for (let b = 0; b < blockCount; b++) {
    let first = 2147483647
    let last = -2147483648
    const end = Math.min(triangleCount, (b + 1) * CLIP_BLOCK_SIZE)
    for (let t = b * CLIP_BLOCK_SIZE; t < end; t++) {
      if (bbox[t * 2] < first) first = bbox[t * 2]
      if (bbox[t * 2 + 1] > last) last = bbox[t * 2 + 1]
    }
    blockRange[b * 2] = first
    blockRange[b * 2 + 1] = last
  }
  geometry.axisCells = range
  geometry.axisBBoxCells = bbox
  geometry.blockAxisCells = blockRange
  geometry.axisCellSize = cellSize
  geometry.axisCellOrigin = fixedMin
  return range
}

/** Reused candidate index list; one map is rasterised at a time (see #1050 C). */
let rotaryCandidateScratch: Int32Array | undefined

/**
 * The most clip-candidate scratch one raster call can allocate for a mesh of
 * `meshTriangles` triangles, in bytes.
 *
 * The kernel collects one index per *submitted* triangle that covers no cell
 * centre, and the sampler submits `always` plus **two** buckets: the strip's own
 * direction and the one half a turn away. Those are two different bucket sets,
 * not two disjoint triangle sets -- a triangle whose padded arc spans more than
 * half the turn circle is listed in both -- so one triangle can be submitted,
 * and collected, twice. The list therefore holds at most `2 * meshTriangles`
 * entries, and that is what a pool worker's charge has to cover; charging one
 * entry per mesh triangle left half the scratch unaccounted for (issue #1115
 * slice p-e, review round 1).
 *
 * The scratch is allocated at exactly the submitted count, so within one worker
 * -- which holds one mesh's setup, and so one largest submitted list -- the
 * resident array never exceeds this bound. Growth headroom (the usual doubling)
 * is deliberately absent: at the moment it grows it would hold up to twice the
 * bytes the budget charged, which is how a budget stops being a measurement.
 * Reuse across calls still costs nothing -- a later, smaller list reads the array
 * already there.
 */
export function rotaryCandidateScratchBytes(meshTriangles: number): number {
  const count = Math.max(0, Math.floor(meshTriangles))
  return count * 2 * Int32Array.BYTES_PER_ELEMENT
}

/**
 * The capacity, in bytes, of the clip-candidate scratch currently held for
 * reuse: 0 before the first call that collects a candidate.
 *
 * This is the array {@link rotaryCandidateScratchBytes} bounds and the pool's
 * `candidates` charge pays for, and it is deliberately readable because the
 * allocation policy is the part a budget cannot assume: the allocator used to
 * round a first allocation up to 4096 entries and double a growing one, so an
 * 8-byte list could hold 16 KB -- resident in every worker, and invisible to a
 * test that only counts the *submitted* candidates or re-derives the charge
 * (issue #1115 slice p-e, review round 2). The tests compare this against both
 * the submitted count and the bound; nothing in generation calls it.
 */
export function rotaryCandidateScratchCapacityBytes(): number {
  return rotaryCandidateScratch?.byteLength ?? 0
}

/**
 * The height-map raster kernel with the rotary projection fused into its
 * triangle walk (issue #1045 slice T).
 *
 * It produces exactly the map `buildHeightMap(turnStripTriangles(...))` would
 * for the same window, cell size, triangle subset and `trackCellRise`: the
 * turned coordinates are the same Float32 values, the cells visited are exactly
 * the centres the general kernel tests (its `floor` bbox plus barycentric test),
 * and the barycentric test, interpolation and max-z update are the same. What
 * it avoids is work the general kernel pays for a mesh it must first
 * materialise:
 *
 * - the bar-axis cell range is angle-free and cached per triangle, so a
 *   candidate whose axial range misses the window is rejected before it is
 *   turned at all (the window is the strip the cutter actually reads);
 * - no turned vertex buffer is written for a triangle whose projected bounds
 *   fall outside the window, and no cell is walked for a triangle outside it;
 * - a cell's value is the maximum over the triangles covering it, so
 *   rasterising exactly the submitted subset into exactly the windowed cells
 *   keeps the map a full map would have there (issue #1015 slice L);
 * - #1050 slice B's no-centre rule is implemented identically: the centre
 *   samples are rasterised first, then a triangle that covers no cell centre
 *   anywhere may raise a cell only when its clipped maximum there beats the
 *   cell's centre sample and all eight neighbours' by
 *   {@link thinFeaturePeakThreshold} (a local peak the sampling missed). A
 *   triangle that covers a centre elsewhere on the map is left to the centre
 *   samples alone, and the peak test reads the centre-sampled map before any
 *   clipped contribution, so a windowed map agrees with a full one.
 */
export function buildRotaryHeightMap(
  frame: RotaryRasterFrame,
  bbox: { minX: number; maxX: number; minY: number; maxY: number },
  cellSize: number,
  options?: RotaryHeightMapBuildOptions,
): HeightMap {
  const width = Math.max(1, Math.ceil((bbox.maxX - bbox.minX) / cellSize))
  const height = Math.max(1, Math.ceil((bbox.maxY - bbox.minY) / cellSize))
  const data = new Float32Array(width * height)
  data.fill(-Infinity)
  let cellRise = 0
  // #1095 slice D: the same per-cell wall coverage `buildHeightMap` records, so
  // a pass the cutter only touches at a retained wall's face is not lifted to
  // the wall's top. Only allocated when the caller marks the wall triangles.
  const wallStart = options?.wallTriangleStart
  const wallCoverage = wallStart !== undefined ? new Uint8Array(width * height) : undefined
  const modelOnly = wallStart !== undefined ? new Float32Array(width * height).fill(-Infinity) : undefined

  const minRow = Math.max(0, options?.window?.minRow ?? 0)
  const maxRow = Math.min(height - 1, options?.window?.maxRow ?? height - 1)
  const minCol = Math.max(0, options?.window?.minCol ?? 0)
  const maxCol = Math.min(width - 1, options?.window?.maxCol ?? width - 1)
  if (minRow > maxRow || minCol > maxCol) {
    return {
      data, width, height, originX: bbox.minX, originY: bbox.minY, cellSize,
      ...(wallCoverage !== undefined ? { wallCoverage } : null),
      ...(modelOnly !== undefined ? { modelOnly } : null),
    }
  }

  const { axis, centre, pivot, cos, sin, geometry } = frame
  const { section, along } = geometry
  const xAxis = axis === 'x'
  const trackCellRise = options?.trackCellRise === true
  const triangles = options?.triangles
  const triangleCount = triangles ? triangles.length : Math.floor(along.length / 3)
  const minX = bbox.minX
  const minY = bbox.minY
  const cell = cellSize
  // The cell-index arithmetic below multiplies by the reciprocal instead of
  // dividing: two double divides per candidate triangle is a measurable share
  // of the raster on a fine mesh. `CENTRE_SLACK` (1e-7 cell) dwarfs the
  // reciprocal's error for any map under the 1e6-cell cap, so a centre the exact
  // quotient would include is always included; an extra cell at a boundary is
  // rejected by the barycentric test and cannot change a value.
  const invCell = 1 / cell
  // Columns are the bar axis on an X bar; rows are on a Y bar. The cached
  // range is in the same order.
  const axisFirst = axisCellRange(
    geometry,
    cell,
    xAxis ? minX : minY,
  )
  const axisBBox = geometry.axisBBoxCells ?? axisFirst
  const axisMin = xAxis ? minCol : minRow
  const axisMax = xAxis ? maxCol : maxRow
  const peakThreshold = thinFeaturePeakThreshold(cell)
  // The window's cell bounds, in the two grid axes. `axis` is the bar's axis
  // (the raster's fixed axis); `cross` is the turned radial axis.
  const windowAxisStart = xAxis ? minCol : minRow
  const windowAxisEnd = xAxis ? maxCol : maxRow
  const windowCrossStart = xAxis ? minRow : minCol
  const windowCrossEnd = xAxis ? maxRow : maxCol
  const gridAxisSize = xAxis ? width : height

  // #1050 slice C: a triangle that covers no cell centre is collected by index
  // only. A precomputed 3x3 neighbourhood-max map then rejects almost every one
  // of them with a single comparison per overlapped cell, so only the genuine
  // local peaks are ever projected a second time and clipped.
  let peakLimit: Float32Array | undefined
  let modelPeakLimit: Float32Array | undefined
  let candidates: Int32Array | undefined
  let candidateCount = 0
  const collectCandidate = (t: number): void => {
    if (candidates === undefined) {
      const current = rotaryCandidateScratch
      if (current !== undefined && current.length >= triangleCount) candidates = current
      else {
        // Exactly the submitted count, never more: the pool charges this list at
        // `rotaryCandidateScratchBytes`, and the doubling growth this used to do
        // could hold twice the charged bytes on the call that grew it. One
        // triangle is collected at most once per call, so the count suffices.
        candidates = new Int32Array(triangleCount)
        rotaryCandidateScratch = candidates
      }
    }
    candidates[candidateCount++] = t
  }

  // Centre pass. Projected inline, not through a per-triangle closure: on a real
  // mesh this loop is the whole cost. A triangle whose axial span contains no
  // cell centre cannot cover a centre anywhere (rotation leaves the axial
  // coordinate untouched), so it is a clip candidate and nothing else -- the
  // same cheap split the pre-#1050 raster got from its axial-centre range.
  // #1185 F1: the far-only triangles, listed last, reach this strip only on the
  // far side of the bar. Once the near side has been rasterised, such a triangle
  // is skipped when it cannot change the map:
  //
  // - every point of it inside the window stands at or below `farTop`, the bound
  //   its distance from the axis gives (`rotaryAxisDistances`), and
  // - every window cell in the bar-axis cells it spans already holds a centre
  //   sample at or above that bound (`farFloor`, the lowest sample of each
  //   bar-axis line; an empty cell makes the line `-Infinity`, which skips
  //   nothing).
  //
  // Then it cannot raise a centre sample, and it cannot raise a cell in the clip
  // pass either: a clipped contribution must beat the cell's peak limit, which is
  // never below the cell's own centre sample. Two things a skipped triangle would
  // still have touched decide whether skipping is allowed at all for this map:
  // the cell rise, which only matters below the cap the sampler applies
  // (`min(cellRise, cellSize)`), so the near side must already have reached the
  // cap; and the retained-wall arrays, which record coverage even where a height
  // does not win, so a map that marks walls skips nothing.
  const farOnlyStart = triangles !== undefined && options?.farOnlyStart !== undefined
    && wallStart === undefined
    ? Math.max(0, Math.min(triangleCount, options.farOnlyStart))
    : triangleCount
  let farFloor: Float32Array | undefined
  let farDistance: Float32Array | undefined
  let farHalfWidthSq = 0
  let farDecided = false
  for (let n = 0; n < triangleCount; n++) {
    const t = triangles ? triangles[n] / 3 : n
    const coverageBit: 1 | 2 = wallStart !== undefined && t >= wallStart ? 2 : 1
    const fixedBBoxFirst = axisBBox[t * 2]
    const fixedBBoxLast = axisBBox[t * 2 + 1]
    if (fixedBBoxLast < axisMin || fixedBBoxFirst > axisMax) continue
    if (n >= farOnlyStart) {
      // Decided once, on the first far-only triangle that reaches the window:
      // by then the near side is in the map and its cell rise is known.
      if (!farDecided) {
        farDecided = true
        if (!trackCellRise || cellRise >= cell) {
          // The lowest centre sample along each bar-axis line of the window.
          farFloor = new Float32Array(gridAxisSize).fill(Infinity)
          for (let row = minRow; row <= maxRow; row++) {
            for (let col = minCol; col <= maxCol; col++) {
              const value = data[row * width + col]
              const line = xAxis ? col : row
              if (value < farFloor[line]) farFloor[line] = value
            }
          }
          farDistance = rotaryAxisDistances(geometry)
          // The window's reach either side of the centreline, to its cells' edges.
          const crossMin = xAxis ? minY : minX
          const low = centre - (crossMin + windowCrossStart * cell)
          const high = crossMin + (windowCrossEnd + 1) * cell - centre
          const halfWidth = Math.max(low, high, 0)
          farHalfWidthSq = halfWidth * halfWidth
        }
      }
      if (farFloor !== undefined && farDistance !== undefined) {
        const distance = farDistance[t]
        const depthSq = distance * distance - farHalfWidthSq
        if (depthSq > 0) {
          // The slack is far above a Float32's rounding of a turned height and
          // far below any difference between two samples that matters.
          const farTop = pivot - Math.sqrt(depthSq)
          const bound = farTop + FAR_SIDE_SLACK * (1 + Math.abs(farTop))
          let hidden = true
          const from = fixedBBoxFirst < axisMin ? axisMin : fixedBBoxFirst
          const to = fixedBBoxLast > axisMax ? axisMax : fixedBBoxLast
          for (let line = from; line <= to; line++) {
            if (!(bound <= farFloor[line])) {
              hidden = false
              break
            }
          }
          if (hidden) continue
        }
      }
    }
    const fixedFirst = axisFirst[t * 2]
    const fixedLast = axisFirst[t * 2 + 1]
    if (fixedFirst > fixedLast) {
      collectCandidate(t)
      continue
    }
    const s = t * 6
    const l = t * 3
    const a0 = section[s]
    const u0 = section[s + 1]
    const a1 = section[s + 2]
    const u1 = section[s + 3]
    const a2 = section[s + 4]
    const u2 = section[s + 5]
    let v0x: number, v0y: number, v1x: number, v1y: number, v2x: number, v2y: number
    let colStart: number, colEnd: number, rowStart: number, rowEnd: number
    let fixedFullStart: number, fixedFullEnd: number
    let crossFullStart: number, crossFullEnd: number
    let tMinX: number, tMaxX: number, tMinY: number, tMaxY: number
    if (xAxis) {
      v0x = along[l]
      v1x = along[l + 1]
      v2x = along[l + 2]
      v0y = Math.fround(centre + a0 * cos - u0 * sin)
      v1y = Math.fround(centre + a1 * cos - u1 * sin)
      v2y = Math.fround(centre + a2 * cos - u2 * sin)
      tMinX = v0x
      tMaxX = v0x
      if (v1x < tMinX) tMinX = v1x
      else if (v1x > tMaxX) tMaxX = v1x
      if (v2x < tMinX) tMinX = v2x
      else if (v2x > tMaxX) tMaxX = v2x
      tMinY = v0y
      tMaxY = v0y
      if (v1y < tMinY) tMinY = v1y
      else if (v1y > tMaxY) tMaxY = v1y
      if (v2y < tMinY) tMinY = v2y
      else if (v2y > tMaxY) tMaxY = v2y
      fixedFullStart = Math.max(0, fixedFirst)
      fixedFullEnd = Math.min(width - 1, fixedLast)
      colStart = Math.max(minCol, fixedFullStart)
      colEnd = Math.min(maxCol, fixedFullEnd)
      crossFullStart = Math.max(0, Math.ceil((tMinY - minY) * invCell - 0.5 - CENTRE_SLACK))
      crossFullEnd = Math.min(height - 1, Math.floor((tMaxY - minY) * invCell - 0.5 + CENTRE_SLACK))
      rowStart = Math.max(minRow, crossFullStart)
      rowEnd = Math.min(maxRow, crossFullEnd)
    } else {
      v0y = along[l]
      v1y = along[l + 1]
      v2y = along[l + 2]
      v0x = Math.fround(centre + a0 * cos - u0 * sin)
      v1x = Math.fround(centre + a1 * cos - u1 * sin)
      v2x = Math.fround(centre + a2 * cos - u2 * sin)
      tMinX = v0x
      tMaxX = v0x
      if (v1x < tMinX) tMinX = v1x
      else if (v1x > tMaxX) tMaxX = v1x
      if (v2x < tMinX) tMinX = v2x
      else if (v2x > tMaxX) tMaxX = v2x
      tMinY = v0y
      tMaxY = v0y
      if (v1y < tMinY) tMinY = v1y
      else if (v1y > tMaxY) tMaxY = v1y
      if (v2y < tMinY) tMinY = v2y
      else if (v2y > tMaxY) tMaxY = v2y
      fixedFullStart = Math.max(0, fixedFirst)
      fixedFullEnd = Math.min(height - 1, fixedLast)
      rowStart = Math.max(minRow, fixedFullStart)
      rowEnd = Math.min(maxRow, fixedFullEnd)
      crossFullStart = Math.max(0, Math.ceil((tMinX - minX) * invCell - 0.5 - CENTRE_SLACK))
      crossFullEnd = Math.min(width - 1, Math.floor((tMaxX - minX) * invCell - 0.5 + CENTRE_SLACK))
      colStart = Math.max(minCol, crossFullStart)
      colEnd = Math.min(maxCol, crossFullEnd)
    }
    const e0x = v1x - v0x, e0y = v1y - v0y
    const e1x = v2x - v0x, e1y = v2y - v0y
    const denom = e0x * e1y - e0y * e1x
    if (Math.abs(denom) < 1e-15) continue
    let touched = false
    if (colStart <= colEnd && rowStart <= rowEnd) {
      let v0z = 0
      let v1z = 0
      let v2z = 0
      let triangleRise = 0
      for (let row = rowStart; row <= rowEnd; row++) {
        for (let col = colStart; col <= colEnd; col++) {
          const cx = minX + (col + 0.5) * cell
          const cy = minY + (row + 0.5) * cell

          const px = cx - v0x, py = cy - v0y
          const u = (px * e1y - py * e1x) / denom
          const v = (py * e0x - px * e0y) / denom
          if (u < 0 || v < 0 || u + v > 1) continue

          if (!touched) {
            v0z = Math.fround(pivot + a0 * sin + u0 * cos)
            v1z = Math.fround(pivot + a1 * sin + u1 * cos)
            v2z = Math.fround(pivot + a2 * sin + u2 * cos)
            if (trackCellRise) {
              const dz0 = v1z - v0z
              const dz1 = v2z - v0z
              const dzdx = (dz0 * e1y - dz1 * e0y) / denom
              const dzdy = (dz1 * e0x - dz0 * e1x) / denom
              const rise = (Math.abs(dzdx) + Math.abs(dzdy)) * cell / 2
              if (Number.isFinite(rise)) triangleRise = rise
            }
          }
          const w = 1 - u - v
          const z = w * v0z + u * v1z + v * v2z
          const idx = row * width + col
          if (wallCoverage !== undefined && modelOnly !== undefined) {
            const coverage = wallCoverage[idx]
            if (coverageBit === 2) {
              if ((coverage & 2) === 0) modelOnly[idx] = data[idx]
              wallCoverage[idx] = coverage | 2
            } else {
              if ((coverage & 2) !== 0 && z > modelOnly[idx]) modelOnly[idx] = z
              wallCoverage[idx] |= 1
            }
          }
          if (z > data[idx]) data[idx] = z
          touched = true
        }
      }
      if (touched) {
        // No-centre clip contributions are exact within their cell, so they add
        // no rise allowance; only a centre sample can under-read between centre
        // and cell edge (issue #1050).
        if (triangleRise > cellRise) cellRise = triangleRise
        continue
      }
    }
    // The triangle covers no cell centre in this window. If it covers one
    // outside the window, a full map would have sampled it normally and must not
    // clip, so the windowed map must not either (the strip-culled sampler is
    // asserted bit-identical to the full map).
    const fixedWinStart = xAxis ? colStart : rowStart
    const fixedWinEnd = xAxis ? colEnd : rowEnd
    const crossWinStart = xAxis ? rowStart : colStart
    const crossWinEnd = xAxis ? rowEnd : colEnd
    let centreOutsideWindow = false
    if (fixedFullStart < windowAxisStart || fixedFullEnd > windowAxisEnd
      || crossFullStart < windowCrossStart || crossFullEnd > windowCrossEnd) {
      for (let cross = crossFullStart; cross <= crossFullEnd && !centreOutsideWindow; cross++) {
        const crossInWindow = cross >= crossWinStart && cross <= crossWinEnd
        for (let fixed = fixedFullStart; fixed <= fixedFullEnd; fixed++) {
          if (crossInWindow && fixed >= fixedWinStart && fixed <= fixedWinEnd) continue
          // The cell centre in turned coordinates.
          const ccx = xAxis ? minX + (fixed + 0.5) * cell : minX + (cross + 0.5) * cell
          const ccy = xAxis ? minY + (cross + 0.5) * cell : minY + (fixed + 0.5) * cell
          const px = ccx - v0x, py = ccy - v0y
          const u = (px * e1y - py * e1x) / denom
          const v = (py * e0x - px * e0y) / denom
          if (u >= 0 && v >= 0 && u + v <= 1) {
            centreOutsideWindow = true
            break
          }
        }
      }
    }
    if (!centreOutsideWindow) collectCandidate(t)
  }

  // Clip pass, #1050 slice C. The neighbourhood-max map is built once from the
  // centre-sampled map, before any clipped contribution, so candidate order
  // cannot change the result. The triangle's global maximum upper-bounds every
  // clipped maximum, so one comparison per overlapped cell rejects almost every
  // candidate on a fine smooth mesh; only a survivor is projected again and
  // clipped exactly. Two maps only when the caller marks retained walls (#1095
  // slice D).
  if (candidates !== undefined && candidateCount > 0) {
    peakLimit = buildPeakLimitMap(data, width, height, minRow, maxRow, minCol, maxCol,
      wallCoverage !== undefined ? 2 : 1, wallCoverage, modelOnly)
    if (wallCoverage !== undefined) {
      modelPeakLimit = buildPeakLimitMap(data, width, height, minRow, maxRow, minCol, maxCol,
        1, wallCoverage, modelOnly)
    }
    const raiseCell = (idx: number, z: number, coverageBit: 1 | 2): void => {
      if (wallCoverage !== undefined && modelOnly !== undefined) {
        const coverage = wallCoverage[idx]
        if (coverageBit === 2) {
          // A clipped wall contribution never changes the model-only height: the
          // centre samples already recorded it, and `data` may hold an earlier
          // clipped raise (issue #1095 slice D).
          wallCoverage[idx] = coverage | 2
        } else {
          if ((coverage & 2) !== 0 && z > modelOnly[idx]) modelOnly[idx] = z
          wallCoverage[idx] |= 1
        }
      }
      if (z > data[idx]) data[idx] = z
    }
    // #1185 C1: judge each block of consecutive triangles once per map, on the
    // first of its candidates, and skip the rest of a block that cannot raise a
    // cell (`rotaryClipBlocks`). The verdict is dated with the map's own number,
    // so the scratch is never cleared.
    const blocks = rotaryClipBlocks(geometry)
    const blockAxis = geometry.blockAxisCells
    const blockCount = blocks.radius.length
    let verdicts = geometry.blockVerdict
    if (verdicts === undefined || verdicts.length !== blockCount) {
      verdicts = new Uint32Array(blockCount)
      geometry.blockVerdict = verdicts
      geometry.blockEpoch = 0
    }
    // Two values per map: `epoch` = judged and kept, `epoch + 1` = judged and skipped.
    let epoch = (geometry.blockEpoch ?? 0) + 2
    if (epoch > 0xfffffff0) {
      verdicts.fill(0)
      epoch = 2
    }
    geometry.blockEpoch = epoch
    const crossOrigin = xAxis ? minY : minX
    const crossCells = xAxis ? height : width
    for (let k = 0; k < candidateCount; k++) {
      const t = candidates[k]
      const coverageBit: 1 | 2 = wallStart !== undefined && t >= wallStart ? 2 : 1
      const limit = coverageBit === 1 && modelPeakLimit !== undefined ? modelPeakLimit : peakLimit
      if (limit === undefined) continue
      if (blockAxis !== undefined) {
        const b = t >> CLIP_BLOCK_SHIFT
        let verdict = verdicts[b]
        if (verdict !== epoch && verdict !== epoch + 1) {
          verdict = epoch
          const rb = blocks.radius[b]
          if (rb !== Infinity) {
            const ca = blocks.centre[b * 2]
            const cu = blocks.centre[b * 2 + 1]
            // Nothing in the block stands above this, and nothing in it lies
            // outside these cells. The slack covers the Float32 rounding of a
            // turned corner, as in the far-side skip.
            const top = pivot + ca * sin + cu * cos + rb
            const bound = top + FAR_SIDE_SLACK * (1 + Math.abs(top))
            const across = centre + ca * cos - cu * sin
            const crossSlack = FAR_SIDE_SLACK * (1 + Math.abs(across)) + rb
            let crossFirst = Math.floor((across - crossSlack - crossOrigin) * invCell)
            let crossLast = Math.floor((across + crossSlack - crossOrigin) * invCell)
            if (crossFirst < 0) crossFirst = 0
            if (crossLast > crossCells - 1) crossLast = crossCells - 1
            if (crossFirst < windowCrossStart) crossFirst = windowCrossStart
            if (crossLast > windowCrossEnd) crossLast = windowCrossEnd
            let axisFrom = blockAxis[b * 2]
            let axisTo = blockAxis[b * 2 + 1]
            if (axisFrom < 0) axisFrom = 0
            if (axisTo > gridAxisSize - 1) axisTo = gridAxisSize - 1
            if (axisFrom < windowAxisStart) axisFrom = windowAxisStart
            if (axisTo > windowAxisEnd) axisTo = windowAxisEnd
            let hidden = true
            for (let cross = crossFirst; cross <= crossLast && hidden; cross++) {
              for (let fixed = axisFrom; fixed <= axisTo; fixed++) {
                const idx = xAxis ? cross * width + fixed : fixed * width + cross
                // With retained walls a model triangle is judged against the
                // model's own limit and a wall triangle against the other; the
                // lower of the two bounds both.
                const cellLimit = modelPeakLimit !== undefined && modelPeakLimit[idx] < peakLimit[idx]
                  ? modelPeakLimit[idx]
                  : peakLimit[idx]
                if (!(bound <= cellLimit + peakThreshold)) {
                  hidden = false
                  break
                }
              }
            }
            if (hidden) verdict = epoch + 1
          }
          verdicts[b] = verdict
        }
        if (verdict === epoch + 1) continue
      }
      const s = t * 6
      const l = t * 3
      const fixedBBoxFirst = axisBBox[t * 2]
      const fixedBBoxLast = axisBBox[t * 2 + 1]
      const clipAxisStart = Math.max(windowAxisStart, Math.max(0, fixedBBoxFirst))
      const clipAxisEnd = Math.min(windowAxisEnd, Math.min(gridAxisSize - 1, fixedBBoxLast))
      if (clipAxisStart > clipAxisEnd) continue

      const a0 = section[s]
      const u0 = section[s + 1]
      const a1 = section[s + 2]
      const u1 = section[s + 3]
      const a2 = section[s + 4]
      const u2 = section[s + 5]
      const v0z = Math.fround(pivot + a0 * sin + u0 * cos)
      const v1z = Math.fround(pivot + a1 * sin + u1 * cos)
      const v2z = Math.fround(pivot + a2 * sin + u2 * cos)
      let v0x: number, v0y: number, v1x: number, v1y: number, v2x: number, v2y: number
      if (xAxis) {
        v0x = along[l]
        v1x = along[l + 1]
        v2x = along[l + 2]
        v0y = Math.fround(centre + a0 * cos - u0 * sin)
        v1y = Math.fround(centre + a1 * cos - u1 * sin)
        v2y = Math.fround(centre + a2 * cos - u2 * sin)
      } else {
        v0y = along[l]
        v1y = along[l + 1]
        v2y = along[l + 2]
        v0x = Math.fround(centre + a0 * cos - u0 * sin)
        v1x = Math.fround(centre + a1 * cos - u1 * sin)
        v2x = Math.fround(centre + a2 * cos - u2 * sin)
      }
      const tMinX = Math.min(v0x, v1x, v2x)
      const tMaxX = Math.max(v0x, v1x, v2x)
      const tMinY = Math.min(v0y, v1y, v2y)
      const tMaxY = Math.max(v0y, v1y, v2y)
      let crossBBoxFirst: number, crossBBoxLast: number
      if (xAxis) {
        crossBBoxFirst = Math.max(0, Math.floor((tMinY - minY) * invCell))
        crossBBoxLast = Math.min(height - 1, Math.floor((tMaxY - minY) * invCell))
      } else {
        crossBBoxFirst = Math.max(0, Math.floor((tMinX - minX) * invCell))
        crossBBoxLast = Math.min(width - 1, Math.floor((tMaxX - minX) * invCell))
      }
      const clipCrossStart = Math.max(windowCrossStart, crossBBoxFirst)
      const clipCrossEnd = Math.min(windowCrossEnd, crossBBoxLast)
      if (clipCrossStart > clipCrossEnd) continue
      const clipColStart = xAxis ? clipAxisStart : clipCrossStart
      const clipColEnd = xAxis ? clipAxisEnd : clipCrossEnd
      const clipRowStart = xAxis ? clipCrossStart : clipAxisStart
      const clipRowEnd = xAxis ? clipCrossEnd : clipAxisEnd
      const e0x = v1x - v0x, e0y = v1y - v0y
      const e1x = v2x - v0x, e1y = v2y - v0y
      if (Math.abs(e0x * e1y - e0y * e1x) < 1e-15) continue
      const globalMaxZ = v0z > v1z ? (v0z > v2z ? v0z : v2z) : (v1z > v2z ? v1z : v2z)
      const singleCell = clipColStart === clipColEnd && clipRowStart === clipRowEnd
        && tMinX >= minX + clipColStart * cell && tMaxX <= minX + (clipColStart + 1) * cell
        && tMinY >= minY + clipRowStart * cell && tMaxY <= minY + (clipRowStart + 1) * cell
      if (singleCell) {
        const idx = clipRowStart * width + clipColStart
        if (globalMaxZ > limit[idx] + peakThreshold) raiseCell(idx, globalMaxZ, coverageBit)
        continue
      }
      // The global maximum is an upper bound for every clipped maximum. One
      // comparison per overlapped cell rejects the smooth-surface candidates
      // before any clipping is paid for.
      let possible = false
      for (let row = clipRowStart; row <= clipRowEnd && !possible; row++) {
        for (let col = clipColStart; col <= clipColEnd; col++) {
          if (globalMaxZ > limit[row * width + col] + peakThreshold) {
            possible = true
            break
          }
        }
      }
      if (!possible) continue
      for (let row = clipRowStart; row <= clipRowEnd; row++) {
        for (let col = clipColStart; col <= clipColEnd; col++) {
          const idx = row * width + col
          const cellLimit = limit[idx]
          if (!(globalMaxZ > cellLimit + peakThreshold)) continue
          const cellMinX = minX + col * cell
          const cellMinY = minY + row * cell
          const z = triangleMaxZInCell(v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z,
            cellMinX, cellMinY, cellMinX + cell, cellMinY + cell)
          if (z === Number.NEGATIVE_INFINITY) continue
          if (!(z > cellLimit + peakThreshold)) continue
          raiseCell(idx, z, coverageBit)
        }
      }
    }
  }
  return {
    data, width, height, originX: minX, originY: minY, cellSize,
    ...(trackCellRise ? { cellRise } : null),
    ...(wallCoverage !== undefined ? { wallCoverage } : null),
    ...(modelOnly !== undefined ? { modelOnly } : null),
  }
}
