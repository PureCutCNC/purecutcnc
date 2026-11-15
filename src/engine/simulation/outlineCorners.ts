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
 * One RGBA8 texel per grid corner, `(cols + 1) × (rows + 1)`: R and G hold the
 * corner's offset on X and Z, B the wall's direction there (for lighting), from
 * `outlineCornerSolve` in `OUTLINE_WALL_GLSL`. The top surface, both wall
 * strips and the underside place corners from R and G; the wall strips light
 * from B.
 *
 * The solve reads the heights and the grid's edge crossings (`edgeCrossings.ts`),
 * which this module keeps on the GPU as a `cols × rows` RGBA8 texture backed by
 * the grid's own array. A GPU pass solves the corners whenever the heightfield
 * changes — the whole grid when the scene is built, the dirty rectangle plus
 * the solve's reach after a playback upload — and the meshes only read the
 * result. Evaluated per vertex instead, an outline rule tripled the guitar
 * project's frame time (issue #939 part 2).
 *
 * The pass compiles the very `STEP_GLSL` the meshes use, so "which edges are
 * walls" stays one decision (issue #829). The heightfield texture and the
 * height data's memory layout are untouched.
 */

import * as THREE from 'three'
import { EDGE_CROSSING_STRIDE } from './edgeCrossings'
import { uploadTextureRegion } from './gpuMesh'
import {
  CELL_HEIGHT_GLSL,
  OUTLINE_LOOKUP_GLSL,
  OUTLINE_WALL_GLSL,
  STEP_GLSL,
} from './heightfieldShader'
import type { DirtyRegion, SimulationGrid } from './types'

/**
 * How many cells away a height change can still change a corner. The solve
 * reads `wallFrom` on the four edges leaving a corner, which reads two cells
 * beyond each edge (`edgeIsStep`), so cell `c` affects corners `c - 1 .. c + 2`.
 * Kept at 2, with a cell to spare: `outlineCorners.test.ts` fails at 0.
 */
export const OUTLINE_REACH_CELLS = 2

const passVertexShader = /* glsl */ `
  void main() {
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

/** The corner pass: one fragment per grid corner writes its offset and wall direction. */
export const OUTLINE_PASS_FRAGMENT_GLSL = /* glsl */ `
  uniform sampler2D uHeightfield;
  uniform sampler2D uEdgeCrossings;
  uniform float uStockBottomZ;
  uniform float uCellSize;
  out vec4 fragColor;

  ${STEP_GLSL}
  ${CELL_HEIGHT_GLSL}
  ${OUTLINE_LOOKUP_GLSL}

  // One byte of a cell's edge crossings; 0 (none) outside the grid.
  int cellCrossing(int x, int z, int channel) {
    ivec2 cell = ivec2(x, z);
    ivec2 inside = clamp(cell, ivec2(0), textureSize(uEdgeCrossings, 0) - ivec2(1));
    if (inside != cell) {
      return 0;
    }
    vec4 bytes = texelFetch(uEdgeCrossings, inside, 0);
    float value = channel == 0 ? bytes.r : (channel == 1 ? bytes.g : (channel == 2 ? bytes.b : bytes.a));
    return int(value * 255.0 + 0.5);
  }

  ${OUTLINE_WALL_GLSL}

  void main() {
    // One fragment per corner: texel (x, z) is the corner at the low-X low-Z
    // corner of cell (x, z), the same indexing the heightfield uses.
    ivec2 corner = ivec2(gl_FragCoord.xy);
    float packed = outlineCornerSolve(corner.x, corner.y, uStockBottomZ, uCellSize);
    float direction = floor(packed / 65536.0);
    float zCode = floor((packed - direction * 65536.0) / 256.0);
    float xCode = packed - direction * 65536.0 - zCode * 256.0;
    fragColor = vec4(xCode, zCode, direction, 255.0) / 255.0;
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
  /** The corner texture (offset, wall direction) the meshes read. */
  readonly texture: THREE.Texture
  /**
   * Mark corners stale after the heights or edge crossings change: a dirty cell
   * rectangle, or the whole grid when no region is given (a full re-upload, a
   * lost context). The crossings in that rectangle are uploaded on `update`.
   */
  invalidate(region?: DirtyRegion): void
  /** Upload stale crossings and solve whatever corners are stale; a no-op when nothing is. */
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

function unionRect<T extends CornerRect | DirtyRegion>(a: T | null, b: T, keys: [keyof T, keyof T, keyof T, keyof T]): T {
  if (!a) return b
  const [minA, maxA, minB, maxB] = keys
  return {
    ...a,
    [minA]: Math.min(a[minA] as number, b[minA] as number),
    [maxA]: Math.max(a[maxA] as number, b[maxA] as number),
    [minB]: Math.min(a[minB] as number, b[minB] as number),
    [maxB]: Math.max(a[maxB] as number, b[maxB] as number),
  }
}

/** The texture a flat grid's edge crossings live in; a lone "none" texel without them. */
function createCrossingTexture(grid: SimulationGrid): THREE.DataTexture {
  const data = grid.edgeCrossings ?? new Uint8Array(EDGE_CROSSING_STRIDE)
  const texture = new THREE.DataTexture(
    data,
    grid.edgeCrossings ? grid.cols : 1,
    grid.edgeCrossings ? grid.rows : 1,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  )
  texture.minFilter = THREE.NearestFilter
  texture.magFilter = THREE.NearestFilter
  texture.name = 'simulationEdgeCrossings'
  texture.needsUpdate = true
  return texture
}

export function createOutlineCorners(
  heightfieldTexture: THREE.Texture,
  grid: SimulationGrid,
): OutlineCorners {
  const width = grid.cols + 1
  const height = grid.rows + 1
  const cornerRT = new THREE.WebGLRenderTarget(width, height, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  })
  cornerRT.texture.name = 'simulationOutlineCorners'
  const crossingTexture = createCrossingTexture(grid)

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uHeightfield: { value: heightfieldTexture },
      uEdgeCrossings: { value: crossingTexture },
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

  let staleCorners: CornerRect | null = full
  // Crossings already go up whole with the texture's first use.
  let staleCrossings: DirtyRegion | null = null
  let crossingsWhole = false

  return {
    texture: cornerRT.texture,
    get pending() {
      return staleCorners !== null
    },
    invalidate(region?: DirtyRegion) {
      staleCorners = unionRect(staleCorners, region ? outlineCornerRect(grid, region) : full, ['xMin', 'xMax', 'yMin', 'yMax'])
      if (!grid.edgeCrossings) return
      if (region) staleCrossings = unionRect(staleCrossings, region, ['colMin', 'colMax', 'rowMin', 'rowMax'])
      else crossingsWhole = true
    },
    update(renderer: THREE.WebGLRenderer) {
      if (!staleCorners) return
      if (grid.edgeCrossings && (crossingsWhole || staleCrossings)) {
        const gl = renderer.getContext()
        const uploaded = !crossingsWhole && staleCrossings !== null && uploadTextureRegion(
          renderer, crossingTexture, grid.cols, grid.rows, staleCrossings,
          gl.RGBA, gl.UNSIGNED_BYTE, grid.edgeCrossings,
        )
        // No GL texture yet, or a whole-grid change: three uploads it all on use.
        if (!uploaded) crossingTexture.needsUpdate = true
        staleCrossings = null
        crossingsWhole = false
      }
      const previousTarget = renderer.getRenderTarget()
      const previousAutoClear = renderer.autoClear
      // Every texel in the rectangle is written, so nothing needs clearing.
      renderer.autoClear = false
      cornerRT.viewport.set(0, 0, width, height)
      cornerRT.scissor.set(staleCorners.xMin, staleCorners.yMin, staleCorners.xMax - staleCorners.xMin + 1, staleCorners.yMax - staleCorners.yMin + 1)
      cornerRT.scissorTest = true
      renderer.setRenderTarget(cornerRT)
      renderer.render(scene, camera)
      staleCorners = null
      renderer.setRenderTarget(previousTarget)
      renderer.autoClear = previousAutoClear
    },
    dispose() {
      cornerRT.dispose()
      crossingTexture.dispose()
      material.dispose()
      quad.geometry.dispose()
    },
  }
}
