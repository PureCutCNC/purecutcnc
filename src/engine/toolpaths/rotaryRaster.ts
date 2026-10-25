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

import { triangleMaxZInCell } from './finishSurfaceParallel'
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
 * triangle whose axial span contains no centre still contributes the maximum
 * over each cell it overlaps, so the kernel also visits that triangle's bbox
 * range when it reaches the clip pass.
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
  }
  geometry.axisCells = range
  geometry.axisCellSize = cellSize
  geometry.axisCellOrigin = fixedMin
  return range
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
 * - #1050's no-centre rule is implemented identically: a triangle that covers
 *   no cell centre anywhere raises every cell it overlaps to its clipped
 *   maximum, and one that covers a centre elsewhere on the map is left to the
 *   centre samples alone so a windowed map agrees with a full one.
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
  const axisMin = xAxis ? minCol : minRow
  const axisMax = xAxis ? maxCol : maxRow
  for (let n = 0; n < triangleCount; n++) {
    // `triangles` holds index offsets (multiples of 3); one triangle per 6
    // section values and 3 along values.
    const t = triangles ? triangles[n] / 3 : n
    const coverageBit = wallStart !== undefined && t >= wallStart ? 2 : 1
    // The bar-axis bounds never change with the turn: reject a triangle that
    // cannot touch the window before paying for its projection. The rejection
    // uses the triangle's **bbox** cell range, not its centre range: a
    // triangle narrower than a cell can have an empty centre range and still
    // overlap a cell (#1050).
    const fixedFirst = axisFirst[t * 2]
    const fixedLast = axisFirst[t * 2 + 1]
    const s = t * 6
    const l = t * 3
    let fixedMinAlong = along[l]
    let fixedMaxAlong = fixedMinAlong
    if (along[l + 1] < fixedMinAlong) fixedMinAlong = along[l + 1]
    else if (along[l + 1] > fixedMaxAlong) fixedMaxAlong = along[l + 1]
    if (along[l + 2] < fixedMinAlong) fixedMinAlong = along[l + 2]
    else if (along[l + 2] > fixedMaxAlong) fixedMaxAlong = along[l + 2]
    const fixedBBoxFirst = Math.floor((fixedMinAlong - (xAxis ? minX : minY)) * invCell)
    const fixedBBoxLast = Math.floor((fixedMaxAlong - (xAxis ? minX : minY)) * invCell)
    if (fixedBBoxLast < axisMin || fixedBBoxFirst > axisMax) continue
    // The same arithmetic `turnStripTriangles` writes into the turned buffer,
    // rounded the same way by the Float32 store; here it stays in registers.
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
    let colStart: number, colEnd: number, rowStart: number, rowEnd: number
    // Centre ranges over the whole grid, and the projected bounds: #1050 needs
    // both to tell a triangle that only misses this window's centres from one
    // that misses every centre, and to clip to the cells it actually overlaps.
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
    let triangleRise = 0
    if (trackCellRise) {
      const dz0 = v1z - v0z
      const dz1 = v2z - v0z
      const dzdx = (dz0 * e1y - dz1 * e0y) / denom
      const dzdy = (dz1 * e0x - dz0 * e1x) / denom
      const rise = (Math.abs(dzdx) + Math.abs(dzdy)) * cell / 2
      if (Number.isFinite(rise)) triangleRise = rise
    }
    let touched = false
    // An empty centre range is normal for a triangle narrower than a cell; it
    // still reaches the clip pass below.
    if (colStart <= colEnd && rowStart <= rowEnd) {
      for (let row = rowStart; row <= rowEnd; row++) {
        for (let col = colStart; col <= colEnd; col++) {
          const cx = minX + (col + 0.5) * cell
          const cy = minY + (row + 0.5) * cell

          const px = cx - v0x, py = cy - v0y
          const u = (px * e1y - py * e1x) / denom
          const v = (py * e0x - px * e0y) / denom
          if (u < 0 || v < 0 || u + v > 1) continue

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
    }
    if (!touched) {
      // #1050: the triangle covers no cell centre in this window. If it covers
      // one outside the window, a full map would have sampled it normally and
      // must not clip, so the windowed map must not either (the strip-culled
      // sampler is asserted bit-identical to the full map).
      let centreOutsideWindow = false
      const fixedWinStart = xAxis ? colStart : rowStart
      const fixedWinEnd = xAxis ? colEnd : rowEnd
      const crossWinStart = xAxis ? rowStart : colStart
      const crossWinEnd = xAxis ? rowEnd : colEnd
      if (fixedFullStart < fixedWinStart || fixedFullEnd > fixedWinEnd
        || crossFullStart < crossWinStart || crossFullEnd > crossWinEnd) {
        for (let row = crossFullStart; row <= crossFullEnd && !centreOutsideWindow; row++) {
          const rowInWindow = row >= rowStart && row <= rowEnd
          for (let col = fixedFullStart; col <= fixedFullEnd; col++) {
            if (rowInWindow && col >= colStart && col <= colEnd) continue
            const cx = minX + (col + 0.5) * cell
            const cy = minY + (row + 0.5) * cell
            const px = cx - v0x, py = cy - v0y
            const u = (px * e1y - py * e1x) / denom
            const v = (py * e0x - px * e0y) / denom
            if (u >= 0 && v >= 0 && u + v <= 1) {
              centreOutsideWindow = true
              break
            }
          }
        }
      }
      if (!centreOutsideWindow) {
        // The cells the triangle *overlaps* (its projected bounding box), not
        // the cells whose centres can lie inside it.
        const clipFixedBBoxFirst = Math.max(0, fixedBBoxFirst)
        const clipFixedBBoxLast = Math.min((xAxis ? width : height) - 1, fixedBBoxLast)
        let crossBBoxFirst: number, crossBBoxLast: number
        if (xAxis) {
          crossBBoxFirst = Math.max(0, Math.floor((tMinY - minY) * invCell))
          crossBBoxLast = Math.min(height - 1, Math.floor((tMaxY - minY) * invCell))
        } else {
          crossBBoxFirst = Math.max(0, Math.floor((tMinX - minX) * invCell))
          crossBBoxLast = Math.min(width - 1, Math.floor((tMaxX - minX) * invCell))
        }
        const clipColStart = Math.max(minCol, xAxis ? clipFixedBBoxFirst : crossBBoxFirst)
        const clipColEnd = Math.min(maxCol, xAxis ? clipFixedBBoxLast : crossBBoxLast)
        const clipRowStart = Math.max(minRow, xAxis ? crossBBoxFirst : clipFixedBBoxFirst)
        const clipRowEnd = Math.min(maxRow, xAxis ? crossBBoxLast : clipFixedBBoxLast)
        if (clipColStart <= clipColEnd && clipRowStart <= clipRowEnd) {
          const globalMaxZ = v0z > v1z ? (v0z > v2z ? v0z : v2z) : (v1z > v2z ? v1z : v2z)
          const singleCell = clipColStart === clipColEnd && clipRowStart === clipRowEnd
            && tMinX >= minX + clipColStart * cell && tMaxX <= minX + (clipColStart + 1) * cell
            && tMinY >= minY + clipRowStart * cell && tMaxY <= minY + (clipRowStart + 1) * cell
          for (let row = clipRowStart; row <= clipRowEnd; row++) {
            for (let col = clipColStart; col <= clipColEnd; col++) {
              const idx = row * width + col
              if (coverageBit === 1) {
                if (wallCoverage !== undefined && modelOnly !== undefined) {
                  const coveredByWall = (wallCoverage[idx] & 2) !== 0
                  if (coveredByWall ? globalMaxZ <= modelOnly[idx] : globalMaxZ <= data[idx]) continue
                } else if (globalMaxZ <= data[idx]) continue
              } else if (globalMaxZ <= data[idx] && wallCoverage !== undefined && (wallCoverage[idx] & 2) !== 0) {
                continue
              }
              const cellMinX = minX + col * cell
              const cellMinY = minY + row * cell
              const z = singleCell
                ? globalMaxZ
                : triangleMaxZInCell(v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z,
                  cellMinX, cellMinY, cellMinX + cell, cellMinY + cell)
              if (z === Number.NEGATIVE_INFINITY) continue
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
            }
          }
        }
      }
    }
    // No-centre clip contributions are exact within their cell, so they add no
    // rise allowance; only a centre sample can under-read between centre and
    // cell edge (issue #1050).
    if (touched && triangleRise > cellRise) cellRise = triangleRise
  }

  return {
    data, width, height, originX: minX, originY: minY, cellSize,
    ...(trackCellRise ? { cellRise } : null),
    ...(wallCoverage !== undefined ? { wallCoverage } : null),
    ...(modelOnly !== undefined ? { modelOnly } : null),
  }
}
