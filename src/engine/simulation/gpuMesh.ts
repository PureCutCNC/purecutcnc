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

/** One flat top quad per heightfield cell, with no shared vertices across cells.
 * A shared corner samples only one neighboring texel; on a one-cell-wide tab
 * it drags the other three corners to cut-through height and paints a false
 * sloped hole. Row instancing keeps the template O(cols) at high detail.
 * position encodes (column, x corner, y corner); gl_InstanceID supplies row.
 */
export function createStockPlaneGeometry(grid: SimulationGrid): THREE.InstancedBufferGeometry {
  const geometry = new THREE.InstancedBufferGeometry()
  const positions = new Float32Array(grid.cols * 4 * 3)
  const indices = grid.cols * 4 <= 65535
    ? new Uint16Array(grid.cols * 6)
    : new Uint32Array(grid.cols * 6)
  for (let col = 0; col < grid.cols; col += 1) {
    const vertex = col * 4
    positions.set([
      col, 0, 0,
      col, 1, 0,
      col, 0, 1,
      col, 1, 1,
    ], vertex * 3)
    indices.set([vertex, vertex + 2, vertex + 1, vertex + 1, vertex + 2, vertex + 3], col * 6)
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setIndex(new THREE.BufferAttribute(indices, 1))
  geometry.instanceCount = grid.rows
  geometry.boundingBox = new THREE.Box3(
    new THREE.Vector3(grid.originX, grid.stockBottomZ, grid.originY),
    new THREE.Vector3(grid.originX + grid.cols * grid.cellSize, grid.stockTopZ, grid.originY + grid.rows * grid.cellSize),
  )
  geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere())
  return geometry
}

export function createStockPlaneGeometries(grid: SimulationGrid): THREE.BufferGeometry[] {
  return [createStockPlaneGeometry(grid)]
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
