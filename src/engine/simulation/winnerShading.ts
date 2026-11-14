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
 * GPU data for winner-move shading (issue #1209): the per-cell winner texture
 * (R32UI, uploaded with the heightfield's dirty region) and the move table
 * texture (RGBA32F, two texels per move, uploaded once). The surface material
 * reads them through `uniforms`; `winnerShader.ts` holds the GLSL.
 *
 * `createWinnerShading` returns null — and the scene keeps today's shader —
 * when the grid records no winners, or when the table would not fit WebGL2's
 * guaranteed texture size (`MOVE_TABLE_TEXTURE_MAX_ROWS`). The second case is
 * logged once with the move count, so a very long program says why.
 */

import * as THREE from 'three'
import { uploadTextureRegion } from './gpuMesh'
import { MOVE_TABLE_MAX_TOOLS, MOVE_TABLE_STRIDE, type MoveTableTool } from './moveTable'
import type { DirtyRegion, SimulationGrid } from './types'
import { MOVE_TABLE_TEXTURE_MAX_ROWS, MOVE_TABLE_TEXTURE_WIDTH } from './winnerShader'

export interface WinnerShading {
  /** The surface material's extra uniforms; shared objects, so updates show. */
  uniforms: Record<string, THREE.IUniform>
  /** Mark winners stale after a heightfield upload (the whole grid without a region). */
  invalidate(region?: DirtyRegion): void
  /** Upload stale winners before a draw. */
  update(renderer: THREE.WebGLRenderer): void
  /** Playback progress through the move table (`PlaybackController.getWinnerProgress`). */
  setProgress(index: number, fraction: number): void
  dispose(): void
}

/** The tool slot's shader profile: code, radius, V-bit inverse slope. */
export function moveToolUniform(tool: MoveTableTool | undefined): THREE.Vector3 {
  if (!tool) return new THREE.Vector3()
  const code = tool.toolType === 'ball_endmill' ? 1 : tool.toolType === 'v_bit' ? 2 : tool.toolType === 'plasma' ? 3 : 0
  let invSlope = 0
  if (tool.toolType === 'v_bit') {
    const angle = Math.max(1, Math.min(179, tool.vBitAngle ?? 60))
    const slope = Math.tan((angle * Math.PI) / 360)
    invSlope = slope > 1e-9 ? 1 / slope : 0
  }
  return new THREE.Vector3(code, tool.toolRadius, invSlope)
}

let loggedTooLarge = false

export function createWinnerShading(grid: SimulationGrid): WinnerShading | null {
  const winners = grid.winners
  const table = grid.moveTable
  if (!winners || !table || grid.wrap) return null

  const rows = Math.max(1, Math.ceil((table.count * 2) / MOVE_TABLE_TEXTURE_WIDTH))
  if (rows > MOVE_TABLE_TEXTURE_MAX_ROWS) {
    if (!loggedTooLarge) {
      loggedTooLarge = true
      console.info(`Simulation: ${table.count} moves exceed the sub-cell shading table; using cell-sampled shading.`)
    }
    return null
  }
  const needed = rows * MOVE_TABLE_TEXTURE_WIDTH * 4
  let tableData: Float32Array
  if (table.data.length >= needed) {
    tableData = table.data.subarray(0, needed)
  } else {
    tableData = new Float32Array(needed)
    tableData.set(table.data.subarray(0, table.count * MOVE_TABLE_STRIDE))
  }
  const tableTexture = new THREE.DataTexture(tableData, MOVE_TABLE_TEXTURE_WIDTH, rows, THREE.RGBAFormat, THREE.FloatType)
  tableTexture.minFilter = THREE.NearestFilter
  tableTexture.magFilter = THREE.NearestFilter
  tableTexture.name = 'simulationMoveTable'
  tableTexture.needsUpdate = true

  const winnerTexture = new THREE.DataTexture(winners, grid.cols, grid.rows, THREE.RedIntegerFormat, THREE.UnsignedIntType)
  winnerTexture.internalFormat = 'R32UI'
  winnerTexture.minFilter = THREE.NearestFilter
  winnerTexture.magFilter = THREE.NearestFilter
  winnerTexture.name = 'simulationWinners'
  winnerTexture.needsUpdate = true

  const tools = Array.from({ length: MOVE_TABLE_MAX_TOOLS }, (_, slot) => moveToolUniform(table.tools[slot]))
  const uniforms: Record<string, THREE.IUniform> = {
    uWinners: { value: winnerTexture },
    uMoveTable: { value: tableTexture },
    uMoveTools: { value: tools },
    uMoveCount: { value: table.count },
    uMoveCurrent: { value: table.count },
    uMoveElapsed: { value: 1 },
  }

  let stale: DirtyRegion | null = null
  let whole = false
  return {
    uniforms,
    invalidate(region?: DirtyRegion) {
      if (!region) {
        whole = true
        return
      }
      stale = stale
        ? {
            colMin: Math.min(stale.colMin, region.colMin),
            colMax: Math.max(stale.colMax, region.colMax),
            rowMin: Math.min(stale.rowMin, region.rowMin),
            rowMax: Math.max(stale.rowMax, region.rowMax),
          }
        : { ...region }
    },
    update(renderer: THREE.WebGLRenderer) {
      if (!whole && !stale) return
      const gl = renderer.getContext()
      const uploaded = !whole && stale !== null && gl instanceof WebGL2RenderingContext && uploadTextureRegion(
        renderer, winnerTexture, grid.cols, grid.rows, stale, gl.RED_INTEGER, gl.UNSIGNED_INT, winners,
      )
      // No GL texture yet, or a whole-grid change: three uploads it all on use.
      if (!uploaded) winnerTexture.needsUpdate = true
      stale = null
      whole = false
    },
    setProgress(index: number, fraction: number) {
      uniforms.uMoveCurrent.value = index
      uniforms.uMoveElapsed.value = fraction
    },
    dispose() {
      winnerTexture.dispose()
      tableTexture.dispose()
    },
  }
}
