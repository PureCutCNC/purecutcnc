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

import * as THREE from 'three'
import type { DirtyRegion, SimulationGrid } from './types'

const MAX_UINT16_INDEX = 65535
const STOCK_PLANE_CHUNK_CELLS = 128
const PROFILE_BOUNDARY_CHUNK_CELLS = 64

/**
 * Build a `DataTexture` backed by the grid's `topZ` Float32Array. The texture
 * uses a single RED channel so each texel stores one height value. The array is
 * shared — mutating `grid.topZ` and calling `texture.needsUpdate = true` (or
 * using `updateHeightfieldRegion`) pushes changes to the GPU.
 */
export function createHeightfieldTexture(grid: SimulationGrid): THREE.DataTexture {
  const texture = new THREE.DataTexture(
    grid.topZ,
    grid.cols,
    grid.rows,
    THREE.RedFormat,
    THREE.FloatType,
  )
  // NearestFilter is required: many mobile GPUs (including iPad) lack
  // OES_texture_float_linear, so LinearFilter on an R32F texture returns
  // garbage in vertex texture fetches. The heightfield is discrete (one
  // Z per cell) and vertices sit on cell corners, so nearest is correct.
  texture.minFilter = THREE.NearestFilter
  texture.magFilter = THREE.NearestFilter
  texture.needsUpdate = true
  return texture
}

/**
 * Build a static subdivided plane whose vertices sit at grid cell centers.
 * The vertex shader will displace world-Y from the heightfield texture, so
 * the geometry itself has Y = 0 everywhere.
 *
 * World coordinate mapping (matches the existing CPU mesh):
 *   grid col  → world X
 *   grid row  → world Z
 *   grid topZ → world Y  (displaced by shader)
 *
 * We build a custom grid rather than using `PlaneGeometry` because we need
 * vertices at cell centers with UVs that map exactly to texel centers.
 */
export function createStockPlaneGeometry(grid: SimulationGrid): THREE.BufferGeometry {
  return createStockPlaneGeometryChunk(grid, 0, 0, grid.cols, grid.rows)
}

export function createStockPlaneGeometries(grid: SimulationGrid): THREE.BufferGeometry[] {
  const fullVertexCount = (grid.cols + 1) * (grid.rows + 1)
  if (fullVertexCount <= MAX_UINT16_INDEX) {
    return [createStockPlaneGeometry(grid)]
  }

  const geometries: THREE.BufferGeometry[] = []
  for (let rowStart = 0; rowStart < grid.rows; rowStart += STOCK_PLANE_CHUNK_CELLS) {
    const chunkRows = Math.min(STOCK_PLANE_CHUNK_CELLS, grid.rows - rowStart)
    for (let colStart = 0; colStart < grid.cols; colStart += STOCK_PLANE_CHUNK_CELLS) {
      const chunkCols = Math.min(STOCK_PLANE_CHUNK_CELLS, grid.cols - colStart)
      geometries.push(createStockPlaneGeometryChunk(grid, colStart, rowStart, chunkCols, chunkRows))
    }
  }
  return geometries
}

function createStockPlaneGeometryChunk(
  grid: SimulationGrid,
  colStart: number,
  rowStart: number,
  chunkCols: number,
  chunkRows: number,
): THREE.BufferGeometry {
  const { originX, originY, cellSize, cols, rows } = grid

  // One vertex per cell corner → (cols+1) × (rows+1) vertices
  const vertCols = chunkCols + 1
  const vertRows = chunkRows + 1
  const vertexCount = vertCols * vertRows
  const positions = new Float32Array(vertexCount * 3)
  const uvs = new Float32Array(vertexCount * 2)

  for (let row = 0; row <= chunkRows; row += 1) {
    const gridRow = rowStart + row
    for (let col = 0; col <= chunkCols; col += 1) {
      const gridCol = colStart + col
      const idx = row * vertCols + col
      const worldX = originX + gridCol * cellSize
      const worldZ = originY + gridRow * cellSize

      positions[idx * 3] = worldX
      positions[idx * 3 + 1] = 0 // Y displaced by shader
      positions[idx * 3 + 2] = worldZ

      // UV maps to texel centers: col 0 → 0.5/cols, col cols → (cols-0.5)/cols
      // At cell boundaries we average neighboring texels, which is correct for
      // vertex positions sitting on cell edges.
      uvs[idx * 2] = Math.max(0, Math.min(1, gridCol / cols))
      uvs[idx * 2 + 1] = Math.max(0, Math.min(1, gridRow / rows))
    }
  }

  // Two triangles per cell
  const indexCount = chunkCols * chunkRows * 6
  const indices = vertexCount > MAX_UINT16_INDEX ? new Uint32Array(indexCount) : new Uint16Array(indexCount)
  let offset = 0
  for (let row = 0; row < chunkRows; row += 1) {
    for (let col = 0; col < chunkCols; col += 1) {
      const tl = row * vertCols + col
      const tr = tl + 1
      const bl = (row + 1) * vertCols + col
      const br = bl + 1

      indices[offset] = tl
      indices[offset + 1] = bl
      indices[offset + 2] = tr
      indices[offset + 3] = tr
      indices[offset + 4] = bl
      indices[offset + 5] = br
      offset += 6
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  geometry.setIndex(new THREE.BufferAttribute(indices, 1))
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

/**
 * Mark a sub-rectangle of the heightfield texture as needing re-upload.
 * Three.js r163+ supports partial source rects on `copyTextureToTexture`,
 * but the simplest reliable path is to flag the whole texture and let the
 * driver do the upload — the texture is small (cols×rows floats).
 *
 * For grids up to ~2000×2000 the full re-upload is a single
 * `texSubImage2D` of ~16 MB which takes <1 ms on modern GPUs. If profiling
 * shows this matters we can switch to manual `gl.texSubImage2D` on the
 * dirty rows only.
 */
export function updateHeightfieldTexture(texture: THREE.DataTexture, _dirtyRegion: DirtyRegion | null): void {
  texture.needsUpdate = true
}

/**
 * Build static side-wall and bottom-face geometry for the stock boundary.
 * These don't change during simulation — they represent the stock extents.
 */
export function createStockBoundaryGeometry(grid: SimulationGrid): THREE.BufferGeometry {
  const { originX, originY, cellSize, cols, rows, stockBottomZ, stockTopZ } = grid
  const positions: number[] = []
  const normals: number[] = []

  const x0 = originX
  const x1 = originX + cols * cellSize
  const z0 = originY
  const z1 = originY + rows * cellSize
  const yBottom = stockBottomZ
  const yTop = stockTopZ

  // Bottom face (normal pointing down)
  pushQuad(positions, normals,
    x0, yBottom, z0,
    x1, yBottom, z0,
    x1, yBottom, z1,
    x0, yBottom, z1,
    0, -1, 0,
  )

  // Front wall (z = z0, normal -Z)
  pushQuad(positions, normals,
    x0, yBottom, z0,
    x0, yTop, z0,
    x1, yTop, z0,
    x1, yBottom, z0,
    0, 0, -1,
  )

  // Back wall (z = z1, normal +Z)
  pushQuad(positions, normals,
    x1, yBottom, z1,
    x1, yTop, z1,
    x0, yTop, z1,
    x0, yBottom, z1,
    0, 0, 1,
  )

  // Left wall (x = x0, normal -X)
  pushQuad(positions, normals,
    x0, yBottom, z1,
    x0, yTop, z1,
    x0, yTop, z0,
    x0, yBottom, z0,
    -1, 0, 0,
  )

  // Right wall (x = x1, normal +X)
  pushQuad(positions, normals,
    x1, yBottom, z0,
    x1, yTop, z0,
    x1, yTop, z1,
    x1, yBottom, z1,
    1, 0, 0,
  )

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

/**
 * Build boundary geometry that follows the actual stock profile. For each cell
 * that has material, emit a bottom face. For each cell edge where the neighbor
 * is empty (outside profile or grid boundary), emit a wall quad from
 * stockBottomZ to stockTopZ.
 */
export function createProfileBoundaryGeometry(grid: SimulationGrid): THREE.BufferGeometry {
  const { originX, originY, cellSize, cols, rows, stockBottomZ } = grid
  const positions: number[] = []
  const normals: number[] = []
  const eps = 1e-6
  const yBottom = stockBottomZ

  const hasMaterial = (col: number, row: number) =>
    col >= 0 && col < cols && row >= 0 && row < rows &&
    grid.topZ[row * cols + col] > stockBottomZ + eps

  const cellHeight = (col: number, row: number) => grid.topZ[row * cols + col]

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      if (!hasMaterial(col, row)) continue

      const x0 = originX + col * cellSize
      const x1 = x0 + cellSize
      const z0 = originY + row * cellSize
      const z1 = z0 + cellSize
      const yTop = cellHeight(col, row)

      // Bottom face
      pushQuad(positions, normals,
        x0, yBottom, z0,
        x1, yBottom, z0,
        x1, yBottom, z1,
        x0, yBottom, z1,
        0, -1, 0,
      )

      // Left wall (neighbor col-1 empty)
      if (!hasMaterial(col - 1, row)) {
        pushQuad(positions, normals,
          x0, yBottom, z1,
          x0, yTop, z1,
          x0, yTop, z0,
          x0, yBottom, z0,
          -1, 0, 0,
        )
      }

      // Right wall (neighbor col+1 empty)
      if (!hasMaterial(col + 1, row)) {
        pushQuad(positions, normals,
          x1, yBottom, z0,
          x1, yTop, z0,
          x1, yTop, z1,
          x1, yBottom, z1,
          1, 0, 0,
        )
      }

      // Front wall (neighbor row-1 empty)
      if (!hasMaterial(col, row - 1)) {
        pushQuad(positions, normals,
          x0, yBottom, z0,
          x0, yTop, z0,
          x1, yTop, z0,
          x1, yBottom, z0,
          0, 0, -1,
        )
      }

      // Back wall (neighbor row+1 empty)
      if (!hasMaterial(col, row + 1)) {
        pushQuad(positions, normals,
          x1, yBottom, z1,
          x1, yTop, z1,
          x0, yTop, z1,
          x0, yBottom, z1,
          0, 0, 1,
        )
      }
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

/**
 * Build profile boundary geometry with per-vertex UV and isTop attributes so
 * a vertex shader can sample the heightfield texture. Top wall vertices read
 * their Y from the texture, so walls automatically track the current cut state
 * without geometry rebuilds.
 */
export function createDynamicProfileBoundaryGeometry(grid: SimulationGrid): THREE.BufferGeometry {
  return createDynamicProfileBoundaryGeometryChunk(grid, 0, 0, grid.cols, grid.rows)
}

export function createDynamicProfileBoundaryGeometries(grid: SimulationGrid): THREE.BufferGeometry[] {
  if (grid.cols * grid.rows * 6 <= MAX_UINT16_INDEX) {
    return [createDynamicProfileBoundaryGeometry(grid)]
  }

  const geometries: THREE.BufferGeometry[] = []
  for (let rowStart = 0; rowStart < grid.rows; rowStart += PROFILE_BOUNDARY_CHUNK_CELLS) {
    const chunkRows = Math.min(PROFILE_BOUNDARY_CHUNK_CELLS, grid.rows - rowStart)
    for (let colStart = 0; colStart < grid.cols; colStart += PROFILE_BOUNDARY_CHUNK_CELLS) {
      const chunkCols = Math.min(PROFILE_BOUNDARY_CHUNK_CELLS, grid.cols - colStart)
      const geometry = createDynamicProfileBoundaryGeometryChunk(grid, colStart, rowStart, chunkCols, chunkRows)
      if (geometry.getAttribute('position').count > 0) {
        geometries.push(geometry)
      } else {
        geometry.dispose()
      }
    }
  }
  return geometries
}

function createDynamicProfileBoundaryGeometryChunk(
  grid: SimulationGrid,
  colStart: number,
  rowStart: number,
  chunkCols: number,
  chunkRows: number,
): THREE.BufferGeometry {
  const { originX, originY, cellSize, cols, rows, stockBottomZ } = grid
  const positions: number[] = []
  const normals: number[] = []
  const cellUvs: number[] = []
  const isTops: number[] = []
  const eps = 1e-6
  const yBottom = stockBottomZ

  const hasMaterial = (col: number, row: number) =>
    col >= 0 && col < cols && row >= 0 && row < rows &&
    grid.topZ[row * cols + col] > stockBottomZ + eps

  const rowEnd = Math.min(rows, rowStart + chunkRows)
  const colEnd = Math.min(cols, colStart + chunkCols)

  for (let row = rowStart; row < rowEnd; row += 1) {
    for (let col = colStart; col < colEnd; col += 1) {
      if (!hasMaterial(col, row)) continue

      const x0 = originX + col * cellSize
      const x1 = x0 + cellSize
      const z0 = originY + row * cellSize
      const z1 = z0 + cellSize
      const u = (col + 0.5) / cols
      const v = (row + 0.5) / rows

      // Bottom face — all vertices at stockBottomZ (aIsTop = 0)
      pushDynamicQuad(positions, normals, cellUvs, isTops,
        x0, yBottom, z0,
        x1, yBottom, z0,
        x1, yBottom, z1,
        x0, yBottom, z1,
        0, -1, 0,
        u, v,
        0, 0, 0, 0,
      )

      // Left wall (neighbor col-1 empty)
      if (!hasMaterial(col - 1, row)) {
        pushDynamicQuad(positions, normals, cellUvs, isTops,
          x0, yBottom, z1,
          x0, 0, z1,
          x0, 0, z0,
          x0, yBottom, z0,
          -1, 0, 0,
          u, v,
          0, 1, 1, 0,
        )
      }

      // Right wall (neighbor col+1 empty)
      if (!hasMaterial(col + 1, row)) {
        pushDynamicQuad(positions, normals, cellUvs, isTops,
          x1, yBottom, z0,
          x1, 0, z0,
          x1, 0, z1,
          x1, yBottom, z1,
          1, 0, 0,
          u, v,
          0, 1, 1, 0,
        )
      }

      // Front wall (neighbor row-1 empty)
      if (!hasMaterial(col, row - 1)) {
        pushDynamicQuad(positions, normals, cellUvs, isTops,
          x0, yBottom, z0,
          x0, 0, z0,
          x1, 0, z0,
          x1, yBottom, z0,
          0, 0, -1,
          u, v,
          0, 1, 1, 0,
        )
      }

      // Back wall (neighbor row+1 empty)
      if (!hasMaterial(col, row + 1)) {
        pushDynamicQuad(positions, normals, cellUvs, isTops,
          x1, yBottom, z1,
          x1, 0, z1,
          x0, 0, z1,
          x0, yBottom, z1,
          0, 0, 1,
          u, v,
          0, 1, 1, 0,
        )
      }
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.setAttribute('aCellUv', new THREE.Float32BufferAttribute(cellUvs, 2))
  geometry.setAttribute('aIsTop', new THREE.Float32BufferAttribute(isTops, 1))
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

function pushDynamicQuad(
  positions: number[],
  normals: number[],
  cellUvs: number[],
  isTops: number[],
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  dx: number, dy: number, dz: number,
  nx: number, ny: number, nz: number,
  u: number, v: number,
  aTop: number, bTop: number, cTop: number, dTop: number,
): void {
  // Triangle 1: a, b, c
  positions.push(ax, ay, az, bx, by, bz, cx, cy, cz)
  normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz)
  cellUvs.push(u, v, u, v, u, v)
  isTops.push(aTop, bTop, cTop)
  // Triangle 2: a, c, d
  positions.push(ax, ay, az, cx, cy, cz, dx, dy, dz)
  normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz)
  cellUvs.push(u, v, u, v, u, v)
  isTops.push(aTop, cTop, dTop)
}

function pushQuad(
  positions: number[],
  normals: number[],
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  dx: number, dy: number, dz: number,
  nx: number, ny: number, nz: number,
): void {
  // Triangle 1: a, b, c
  positions.push(ax, ay, az, bx, by, bz, cx, cy, cz)
  normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz)
  // Triangle 2: a, c, d
  positions.push(ax, ay, az, cx, cy, cz, dx, dy, dz)
  normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz)
}

// Static, shader-driven boundary mesh — built once, never rebuilt during
// playback. Each interior + outer grid edge gets a vertical wall quad; each
// cell gets a horizontal floor quad. The vertex shader (see
// shaderDrivenBoundaryVertexShader) samples both adjacent cells' heights to
// compute the wall's top/bottom each frame, and the fragment shader discards
// floors whose cell still has material. UVs of -1 are the "outside the grid"
// sentinel (treated as stockBottomZ).
//
// Scaling: roughly 18 vertices per cell (3 quads × 6 un-indexed verts) plus a
// small boundary term. Each vertex carries 12 floats (~48 B) of attributes, so
// the per-cell cost is ~864 B. The viewport caps usage of this builder via
// SHADER_DRIVEN_BOUNDARY_MAX_CELLS (see SimulationViewport.tsx) so we don't
// allocate gigabytes of typed arrays at the upper end of the detail slider
// (e.g. 1500×1500 ≈ 2.25M cells → ~1.9 GB). TODO: pack to indexed Uint16/Uint8
// attributes to raise that ceiling.
export const SHADER_BOUNDARY_VERTICES_PER_CELL = 18
const SHADER_BOUNDARY_CHUNK_CELLS = 48

export function createShaderDrivenBoundaryGeometries(grid: SimulationGrid): THREE.BufferGeometry[] {
  const geometries: THREE.BufferGeometry[] = []
  for (let rowStart = 0; rowStart < grid.rows; rowStart += SHADER_BOUNDARY_CHUNK_CELLS) {
    const chunkRows = Math.min(SHADER_BOUNDARY_CHUNK_CELLS, grid.rows - rowStart)
    for (let colStart = 0; colStart < grid.cols; colStart += SHADER_BOUNDARY_CHUNK_CELLS) {
      const chunkCols = Math.min(SHADER_BOUNDARY_CHUNK_CELLS, grid.cols - colStart)
      const geometry = createShaderDrivenBoundaryGeometryChunk(grid, colStart, rowStart, chunkCols, chunkRows)
      if (geometry.getAttribute('position').count > 0) {
        geometries.push(geometry)
      } else {
        geometry.dispose()
      }
    }
  }
  return geometries
}

function createShaderDrivenBoundaryGeometryChunk(
  grid: SimulationGrid,
  colStart: number,
  rowStart: number,
  chunkCols: number,
  chunkRows: number,
): THREE.BufferGeometry {
  const { originX, originY, cellSize, cols, rows, stockBottomZ } = grid
  const positions: number[] = []
  const normals: number[] = []
  const leftUvs: number[] = []
  const rightUvs: number[] = []
  const isTops: number[] = []
  const isFloors: number[] = []
  const OUTSIDE_UV: [number, number] = [-1, -1]

  const cellUv = (c: number, r: number): [number, number] => [(c + 0.5) / cols, (r + 0.5) / rows]
  const edgeUv = (c: number, r: number): [number, number] =>
    c < 0 || c >= cols || r < 0 || r >= rows ? OUTSIDE_UV : cellUv(c, r)

  const pushVertex = (
    px: number, py: number, pz: number,
    nx: number, ny: number, nz: number,
    lu: number, lv: number,
    ru: number, rv: number,
    isTop: number,
    isFloor: number,
  ) => {
    positions.push(px, py, pz)
    normals.push(nx, ny, nz)
    leftUvs.push(lu, lv)
    rightUvs.push(ru, rv)
    isTops.push(isTop)
    isFloors.push(isFloor)
  }

  // Quad helper: emits 2 triangles (a,b,c) + (a,c,d). All 4 verts share the
  // wall's left/right UVs and normal; only position + aIsTop differ.
  const pushWallQuad = (
    ax: number, az: number, aTop: number,
    bx: number, bz: number, bTop: number,
    cx: number, cz: number, cTop: number,
    dx: number, dz: number, dTop: number,
    nx: number, ny: number, nz: number,
    leftUv: [number, number],
    rightUv: [number, number],
  ) => {
    const [lu, lv] = leftUv
    const [ru, rv] = rightUv
    pushVertex(ax, 0, az, nx, ny, nz, lu, lv, ru, rv, aTop, 0)
    pushVertex(bx, 0, bz, nx, ny, nz, lu, lv, ru, rv, bTop, 0)
    pushVertex(cx, 0, cz, nx, ny, nz, lu, lv, ru, rv, cTop, 0)
    pushVertex(ax, 0, az, nx, ny, nz, lu, lv, ru, rv, aTop, 0)
    pushVertex(cx, 0, cz, nx, ny, nz, lu, lv, ru, rv, cTop, 0)
    pushVertex(dx, 0, dz, nx, ny, nz, lu, lv, ru, rv, dTop, 0)
  }

  const rowEnd = Math.min(rows, rowStart + chunkRows)
  const colEnd = Math.min(cols, colStart + chunkCols)

  for (let row = rowStart; row < rowEnd; row += 1) {
    for (let col = colStart; col < colEnd; col += 1) {
      const x0 = originX + col * cellSize
      const x1 = x0 + cellSize
      const z0 = originY + row * cellSize
      const z1 = z0 + cellSize
      const cellUvHere = cellUv(col, row)
      const [cu, cv] = cellUvHere

      // Floor face — y forced to stockBottomZ in vertex shader, fragment
      // discards while the cell still has material.
      pushVertex(x0, stockBottomZ, z0, 0, -1, 0, cu, cv, cu, cv, 0, 1)
      pushVertex(x1, stockBottomZ, z0, 0, -1, 0, cu, cv, cu, cv, 0, 1)
      pushVertex(x1, stockBottomZ, z1, 0, -1, 0, cu, cv, cu, cv, 0, 1)
      pushVertex(x0, stockBottomZ, z0, 0, -1, 0, cu, cv, cu, cv, 0, 1)
      pushVertex(x1, stockBottomZ, z1, 0, -1, 0, cu, cv, cu, cv, 0, 1)
      pushVertex(x0, stockBottomZ, z1, 0, -1, 0, cu, cv, cu, cv, 0, 1)

      // Each cell owns the wall on its LEFT and TOP edges (so interior edges
      // are emitted exactly once). The cells on the right/bottom boundary of
      // the grid additionally emit their RIGHT/BOTTOM walls.

      // Left wall at x = x0, between (col-1, row) and (col, row).
      pushWallQuad(
        x0, z1, 0,
        x0, z1, 1,
        x0, z0, 1,
        x0, z0, 0,
        1, 0, 0,
        edgeUv(col - 1, row),
        cellUvHere,
      )

      // Top (z-) wall at z = z0, between (col, row-1) and (col, row).
      pushWallQuad(
        x0, z0, 0,
        x0, z0, 1,
        x1, z0, 1,
        x1, z0, 0,
        0, 0, 1,
        edgeUv(col, row - 1),
        cellUvHere,
      )

      // Outer right wall at x = x1, only on grid right edge.
      if (col === cols - 1) {
        pushWallQuad(
          x1, z0, 0,
          x1, z0, 1,
          x1, z1, 1,
          x1, z1, 0,
          1, 0, 0,
          cellUvHere,
          edgeUv(col + 1, row),
        )
      }

      // Outer bottom (z+) wall at z = z1, only on grid bottom edge.
      if (row === rows - 1) {
        pushWallQuad(
          x1, z1, 0,
          x1, z1, 1,
          x0, z1, 1,
          x0, z1, 0,
          0, 0, 1,
          cellUvHere,
          edgeUv(col, row + 1),
        )
      }
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.setAttribute('aLeftUv', new THREE.Float32BufferAttribute(leftUvs, 2))
  geometry.setAttribute('aRightUv', new THREE.Float32BufferAttribute(rightUvs, 2))
  geometry.setAttribute('aIsTop', new THREE.Float32BufferAttribute(isTops, 1))
  geometry.setAttribute('aIsFloor', new THREE.Float32BufferAttribute(isFloors, 1))
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}
