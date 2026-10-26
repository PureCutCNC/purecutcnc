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
  geometry.axisCells = range
  geometry.axisBBoxCells = bbox
  geometry.axisCellSize = cellSize
  geometry.axisCellOrigin = fixedMin
  return range
}

/** Reused candidate index list; one map is rasterised at a time (see #1050 C). */
let rotaryCandidateScratch: Int32Array | undefined

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
  options?: HeightMapBuildOptions,
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
        const next = Math.max(triangleCount, current !== undefined ? current.length * 2 : 4096)
        candidates = new Int32Array(next)
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
  for (let n = 0; n < triangleCount; n++) {
    const t = triangles ? triangles[n] / 3 : n
    const coverageBit: 1 | 2 = wallStart !== undefined && t >= wallStart ? 2 : 1
    const fixedBBoxFirst = axisBBox[t * 2]
    const fixedBBoxLast = axisBBox[t * 2 + 1]
    if (fixedBBoxLast < axisMin || fixedBBoxFirst > axisMax) continue
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
    for (let k = 0; k < candidateCount; k++) {
      const t = candidates[k]
      const coverageBit: 1 | 2 = wallStart !== undefined && t >= wallStart ? 2 : 1
      const limit = coverageBit === 1 && modelPeakLimit !== undefined ? modelPeakLimit : peakLimit
      if (limit === undefined) continue
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
