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
 * The wall-outline corner texture (issue #973).
 *
 * One R8 texel per grid corner, `(cols + 1) × (rows + 1)`, holding the turn
 * code `OUTLINE_TURN_GLSL` gives that corner: 0 where the corner stays on the
 * grid, 1..4 for the diagonal it moves along. A GPU pass runs the rule once
 * per corner whenever the heightfield changes — the whole grid when the scene
 * is built, the dirty rectangle plus `OUTLINE_REACH_CELLS` after a playback
 * upload — and the top surface, both wall strips and the underside only read
 * the texture. Evaluated per vertex instead, the rule tripled the guitar
 * project's frame time (issue #939 part 2).
 *
 * The pass compiles the very `STEP_GLSL` the meshes use, so "which edges are
 * walls" stays one decision (issue #829). The heightfield texture, the grid
 * and its memory layout are untouched; this is a second, derived texture.
 */

import * as THREE from 'three'
import {
  CELL_HEIGHT_GLSL,
  OUTLINE_CODE_SCALE,
  OUTLINE_LOOKUP_GLSL,
  OUTLINE_TURN_GLSL,
  STEP_GLSL,
} from './heightfieldShader'
import type { DirtyRegion, SimulationGrid } from './types'

/**
 * How many cells away a height change can still change a corner's turn code.
 * The rule reads cells from three below a corner to two above it on each axis
 * (`wallFrom` at the next corner along, plus `edgeIsStep`'s cells beyond), so
 * cell `c` affects corners `c - 2 .. c + 3`: this reach either side of the
 * cell, plus the corner on its far edge. `outlineCorners.test.ts` fails at 1.
 */
export const OUTLINE_REACH_CELLS = 2

const passVertexShader = /* glsl */ `
  void main() {
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

/** The corner pass: one fragment per grid corner writes that corner's turn code. */
export const OUTLINE_PASS_FRAGMENT_GLSL = /* glsl */ `
  uniform sampler2D uHeightfield;
  uniform float uStockBottomZ;
  uniform float uCellSize;
  out vec4 fragColor;

  ${STEP_GLSL}
  ${CELL_HEIGHT_GLSL}
  ${OUTLINE_LOOKUP_GLSL}
  ${OUTLINE_TURN_GLSL}

  void main() {
    // One fragment per corner: texel (x, z) is the corner at the low-X low-Z
    // corner of cell (x, z), the same indexing the heightfield uses.
    ivec2 corner = ivec2(gl_FragCoord.xy);
    int turn = outlineCornerTurn(corner.x, corner.y, uStockBottomZ, uCellSize);
    fragColor = vec4(float(turn) / ${OUTLINE_CODE_SCALE.toFixed(1)}, 0.0, 0.0, 1.0);
  }
`

/** Corner rectangle a pass must refresh, in texels, inclusive. */
interface CornerRect {
  xMin: number
  xMax: number
  yMin: number
  yMax: number
}

export interface OutlineCorners {
  /** The corner texture the meshes read. Valid after the first `update`. */
  readonly texture: THREE.Texture
  /**
   * Mark corners stale after a height change: a dirty cell rectangle, or the
   * whole grid when no region is given (a full re-upload, a lost context).
   */
  invalidate(region?: DirtyRegion): void
  /** Run the pass over whatever is stale; a no-op when nothing is. */
  update(renderer: THREE.WebGLRenderer): void
  /** True while a change waits for `update`. */
  readonly pending: boolean
  dispose(): void
}

/**
 * Corner rectangle a dirty cell region can affect, clamped to the texture.
 * Exported for the tests.
 */
export function outlineCornerRect(
  grid: Pick<SimulationGrid, 'cols' | 'rows'>,
  region: DirtyRegion,
): CornerRect {
  const maxX = grid.cols
  const maxY = grid.rows
  return {
    // Corner x touches cells x - 1 and x; a cell's reach is OUTLINE_REACH_CELLS
    // either way, plus the one corner past its far edge.
    xMin: Math.max(0, Math.min(maxX, region.colMin - OUTLINE_REACH_CELLS)),
    xMax: Math.max(0, Math.min(maxX, region.colMax + 1 + OUTLINE_REACH_CELLS)),
    yMin: Math.max(0, Math.min(maxY, region.rowMin - OUTLINE_REACH_CELLS)),
    yMax: Math.max(0, Math.min(maxY, region.rowMax + 1 + OUTLINE_REACH_CELLS)),
  }
}

function union(a: CornerRect | null, b: CornerRect): CornerRect {
  if (!a) return b
  return {
    xMin: Math.min(a.xMin, b.xMin),
    xMax: Math.max(a.xMax, b.xMax),
    yMin: Math.min(a.yMin, b.yMin),
    yMax: Math.max(a.yMax, b.yMax),
  }
}

export function createOutlineCorners(
  heightfieldTexture: THREE.Texture,
  grid: SimulationGrid,
): OutlineCorners {
  const width = grid.cols + 1
  const height = grid.rows + 1
  const target = new THREE.WebGLRenderTarget(width, height, {
    format: THREE.RedFormat,
    type: THREE.UnsignedByteType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  })
  target.texture.name = 'simulationOutlineCorners'

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uHeightfield: { value: heightfieldTexture },
      uStockBottomZ: { value: grid.stockBottomZ },
      uCellSize: { value: grid.cellSize },
    },
    vertexShader: passVertexShader,
    fragmentShader: OUTLINE_PASS_FRAGMENT_GLSL,
    glslVersion: THREE.GLSL3,
    depthTest: false,
    depthWrite: false,
  })
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material)
  quad.frustumCulled = false
  const scene = new THREE.Scene()
  scene.add(quad)
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  const full: CornerRect = { xMin: 0, xMax: width - 1, yMin: 0, yMax: height - 1 }

  let stale: CornerRect | null = full

  return {
    texture: target.texture,
    get pending() {
      return stale !== null
    },
    invalidate(region?: DirtyRegion) {
      stale = region ? union(stale, outlineCornerRect(grid, region)) : full
    },
    update(renderer: THREE.WebGLRenderer) {
      if (!stale) return
      const rect = stale
      stale = null
      const previousTarget = renderer.getRenderTarget()
      const previousAutoClear = renderer.autoClear
      // Every texel in the rectangle is written, so nothing needs clearing.
      renderer.autoClear = false
      target.viewport.set(0, 0, width, height)
      target.scissor.set(rect.xMin, rect.yMin, rect.xMax - rect.xMin + 1, rect.yMax - rect.yMin + 1)
      target.scissorTest = true
      renderer.setRenderTarget(target)
      renderer.render(scene, camera)
      renderer.setRenderTarget(previousTarget)
      renderer.autoClear = previousAutoClear
    },
    dispose() {
      target.dispose()
      material.dispose()
      quad.geometry.dispose()
    },
  }
}
