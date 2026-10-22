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
 * The map only ever samples cell centres, so a triangle whose axial span
 * contains none cannot contribute a value at any angle -- rotation never moves
 * that axis. On a mesh finer than the cell (the 1.47 M-vertex bust has ~0.005"
 * triangles against a 0.02" cell) that is most of the mesh: three quarters of
 * the triangles are dropped once, for every angle of the operation. The range
 * is also the exact axial band the raster must visit for the triangles that
 * survive, so the kernel never walks a cell whose centre is outside them.
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
 *   fall outside the window, and no z is computed for a triangle that covers no
 *   cell centre in it (the projection of a fine mesh is dominated by triangles
 *   smaller than one cell);
 * - a cell's value is the maximum over the triangles covering it, so
 *   rasterising exactly the submitted subset into exactly the windowed cells
 *   keeps the map a full map would have there (issue #1015 slice L).
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

  const minRow = Math.max(0, options?.window?.minRow ?? 0)
  const maxRow = Math.min(height - 1, options?.window?.maxRow ?? height - 1)
  const minCol = Math.max(0, options?.window?.minCol ?? 0)
  const maxCol = Math.min(width - 1, options?.window?.maxCol ?? width - 1)
  if (minRow > maxRow || minCol > maxCol) {
    return { data, width, height, originX: bbox.minX, originY: bbox.minY, cellSize }
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
    // The bar-axis bounds never change with the turn: reject a triangle that
    // cannot touch the window before paying for its projection.
    const fixedFirst = axisFirst[t * 2]
    const fixedLast = axisFirst[t * 2 + 1]
    if (fixedLast < axisMin || fixedFirst > axisMax) continue
    const s = t * 6
    const l = t * 3
    // The same arithmetic `turnStripTriangles` writes into the turned buffer,
    // rounded the same way by the Float32 store; here it stays in registers.
    const a0 = section[s]
    const u0 = section[s + 1]
    const a1 = section[s + 2]
    const u1 = section[s + 3]
    const a2 = section[s + 4]
    const u2 = section[s + 5]
    let v0x: number, v0y: number, v1x: number, v1y: number, v2x: number, v2y: number
    let colStart: number, colEnd: number, rowStart: number, rowEnd: number
    if (xAxis) {
      v0x = along[l]
      v1x = along[l + 1]
      v2x = along[l + 2]
      v0y = Math.fround(centre + a0 * cos - u0 * sin)
      v1y = Math.fround(centre + a1 * cos - u1 * sin)
      v2y = Math.fround(centre + a2 * cos - u2 * sin)
      colStart = Math.max(minCol, fixedFirst)
      colEnd = Math.min(maxCol, fixedLast)
      let tMinY = v0y
      let tMaxY = v0y
      if (v1y < tMinY) tMinY = v1y
      else if (v1y > tMaxY) tMaxY = v1y
      if (v2y < tMinY) tMinY = v2y
      else if (v2y > tMaxY) tMaxY = v2y
      rowStart = Math.max(minRow, Math.ceil((tMinY - minY) * invCell - 0.5 - CENTRE_SLACK))
      rowEnd = Math.min(maxRow, Math.floor((tMaxY - minY) * invCell - 0.5 + CENTRE_SLACK))
    } else {
      v0y = along[l]
      v1y = along[l + 1]
      v2y = along[l + 2]
      v0x = Math.fround(centre + a0 * cos - u0 * sin)
      v1x = Math.fround(centre + a1 * cos - u1 * sin)
      v2x = Math.fround(centre + a2 * cos - u2 * sin)
      rowStart = Math.max(minRow, fixedFirst)
      rowEnd = Math.min(maxRow, fixedLast)
      let tMinX = v0x
      let tMaxX = v0x
      if (v1x < tMinX) tMinX = v1x
      else if (v1x > tMaxX) tMaxX = v1x
      if (v2x < tMinX) tMinX = v2x
      else if (v2x > tMaxX) tMaxX = v2x
      colStart = Math.max(minCol, Math.ceil((tMinX - minX) * invCell - 0.5 - CENTRE_SLACK))
      colEnd = Math.min(maxCol, Math.floor((tMaxX - minX) * invCell - 0.5 + CENTRE_SLACK))
    }
    if (colStart > colEnd || rowStart > rowEnd) continue

    const e0x = v1x - v0x, e0y = v1y - v0y
    const e1x = v2x - v0x, e1y = v2y - v0y
    const denom = e0x * e1y - e0y * e1x
    if (Math.abs(denom) < 1e-15) continue
    let v0z = 0
    let v1z = 0
    let v2z = 0
    let triangleRise = 0
    let touched = false
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
        if (z > data[idx]) data[idx] = z
        touched = true
      }
    }
    if (touched && triangleRise > cellRise) cellRise = triangleRise
  }

  return {
    data, width, height, originX: minX, originY: minY, cellSize,
    ...(trackCellRise ? { cellRise } : null),
  }
}
