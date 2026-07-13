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

  // The stored geometry is flat (Y = 0 everywhere); the vertex shader displaces
  // each vertex up to its heightfield value at draw time. Computing bounds from
  // the raw positions therefore yields a zero-height slab sitting at Y = 0 —
  // roughly half the stock thickness BELOW where the surface actually renders.
  // three's frustum culler tests that stale sphere, so on a tilted view the
  // bottom-of-frame chunks fall outside the frustum and get wrongly culled,
  // and the always-drawn boundary wall shows through as a sawtooth along the
  // near edge. The error scales with detail: at low detail the chunk sphere is
  // large enough to swallow the offset, but at high detail the chunks (and
  // their spheres) shrink while the offset stays ~half the stock thickness, so
  // the artifact only appears at high detail. Bound the true displacement
  // range [stockBottomZ, stockTopZ] instead so culling stays correct.
  const minX = originX + colStart * cellSize
  const maxX = originX + (colStart + chunkCols) * cellSize
  const minZ = originY + rowStart * cellSize
  const maxZ = originY + (rowStart + chunkRows) * cellSize
  geometry.boundingBox = new THREE.Box3(
    new THREE.Vector3(minX, grid.stockBottomZ, minZ),
    new THREE.Vector3(maxX, grid.stockTopZ, maxZ),
  )
  geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere())
  return geometry
}

/**
 * Mark the whole heightfield texture as needing re-upload. Fallback path —
 * prefer `uploadHeightfieldRegion` during playback, which pushes only the
 * dirty rectangle.
 */
export function updateHeightfieldTexture(texture: THREE.DataTexture): void {
  texture.needsUpdate = true
}

/**
 * Upload only a dirty sub-rectangle of the heightfield to the GPU via
 * `texSubImage2D`, reading directly out of the shared `grid.topZ` array using
 * WebGL2 UNPACK_ROW_LENGTH / UNPACK_SKIP_* addressing. A full-grid re-upload
 * moves cols×rows×4 bytes every cutting frame (9 MB at detail 1500); the dirty
 * rect during playback is typically just the tool's footprint.
 *
 * Reaches for the renderer's live GL texture handle (`renderer.properties`) —
 * the same handle three uploads into. Returns false when that handle doesn't
 * exist yet (texture not rendered once) or the context is not WebGL2; callers
 * must then fall back to `updateHeightfieldTexture`. GL pixel-store state and
 * the active texture binding are restored before returning, so three's state
 * cache stays valid.
 */
export function uploadHeightfieldRegion(
  renderer: THREE.WebGLRenderer,
  texture: THREE.DataTexture,
  grid: SimulationGrid,
  region: DirtyRegion,
): boolean {
  const gl = renderer.getContext()
  if (!(gl instanceof WebGL2RenderingContext) || gl.isContextLost()) {
    return false
  }

  const textureProperties = renderer.properties.get(texture) as { __webglTexture?: WebGLTexture }
  const glTexture = textureProperties.__webglTexture
  if (!glTexture) {
    return false
  }

  const colMin = Math.max(0, Math.min(region.colMin, grid.cols - 1))
  const colMax = Math.max(colMin, Math.min(region.colMax, grid.cols - 1))
  const rowMin = Math.max(0, Math.min(region.rowMin, grid.rows - 1))
  const rowMax = Math.max(rowMin, Math.min(region.rowMax, grid.rows - 1))
  const width = colMax - colMin + 1
  const height = rowMax - rowMin + 1

  const previousBinding = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null
  gl.bindTexture(gl.TEXTURE_2D, glTexture)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  gl.pixelStorei(gl.UNPACK_ROW_LENGTH, grid.cols)
  gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, colMin)
  gl.pixelStorei(gl.UNPACK_SKIP_ROWS, rowMin)
  gl.texSubImage2D(gl.TEXTURE_2D, 0, colMin, rowMin, width, height, gl.RED, gl.FLOAT, grid.topZ)
  gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0)
  gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0)
  gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0)
  gl.bindTexture(gl.TEXTURE_2D, previousBinding)
  return true
}

