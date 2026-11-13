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
 * The wall-outline corner textures (issue #973).
 *
 * Two textures of one texel per grid corner, `(cols + 1) × (rows + 1)`:
 *
 * - the corner texture (RG8): R holds the turn code `OUTLINE_TURN_GLSL` gives
 *   the corner — 0 where it stays on the grid, 1..4 for the diagonal it moves
 *   along — and G the bits of which of its four edges are walls. The top
 *   surface, both wall strips and the underside place corners from R;
 * - the normal texture (R8): the wall's direction at the corner, smoothed along
 *   the outline by `OUTLINE_TANGENT_GLSL` from the first texture. The wall
 *   strips light themselves with it. Lighting only: no geometry reads it.
 *
 * GPU passes compute both whenever the heightfield changes — the whole grid
 * when the scene is built, the dirty rectangle plus the rule's reach after a
 * playback upload — and the meshes only read them. Evaluated per vertex
 * instead, the corner rule alone tripled the guitar project's frame time
 * (issue #939 part 2).
 *
 * The corner pass compiles the very `STEP_GLSL` the meshes use, so "which
 * edges are walls" stays one decision (issue #829). The heightfield texture,
 * the grid and its memory layout are untouched; these are derived textures.
 */

import * as THREE from 'three'
import {
  CELL_HEIGHT_GLSL,
  OUTLINE_CODE_SCALE,
  OUTLINE_CORNER_GLSL,
  OUTLINE_LOOKUP_GLSL,
  OUTLINE_NORMAL_NONE,
  OUTLINE_SMOOTH_STEPS,
  OUTLINE_TANGENT_GLSL,
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

/** The corner pass: one fragment per grid corner writes its turn code and wall bits. */
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
    int walls = outlineCornerWallMask(corner.x, corner.y, uStockBottomZ, uCellSize);
    fragColor = vec4(
      float(turn) / ${OUTLINE_CODE_SCALE.toFixed(1)},
      float(walls) / ${OUTLINE_CODE_SCALE.toFixed(1)},
      0.0,
      1.0
    );
  }
`

/** The normal pass: one fragment per corner writes the smoothed wall direction. */
export const OUTLINE_NORMAL_PASS_FRAGMENT_GLSL = /* glsl */ `
  uniform sampler2D uOutlineCorners;
  out vec4 fragColor;

  ${OUTLINE_CORNER_GLSL}

  int cornerWallMask(int x, int z) {
    ivec2 corner = ivec2(x, z);
    ivec2 inside = clamp(corner, ivec2(0), textureSize(uOutlineCorners, 0) - ivec2(1));
    return inside == corner ? int(texelFetch(uOutlineCorners, inside, 0).g * ${OUTLINE_CODE_SCALE.toFixed(1)} + 0.5) : 0;
  }

  int cornerTurn(int x, int z) {
    ivec2 corner = ivec2(x, z);
    ivec2 inside = clamp(corner, ivec2(0), textureSize(uOutlineCorners, 0) - ivec2(1));
    return inside == corner ? int(texelFetch(uOutlineCorners, inside, 0).r * ${OUTLINE_CODE_SCALE.toFixed(1)} + 0.5) : 0;
  }

  float cornerPositionX(int x, int z) {
    return float(x) + outlineCornerOffset(ivec2(x, z)).x;
  }

  float cornerPositionZ(int x, int z) {
    return float(z) + outlineCornerOffset(ivec2(x, z)).y;
  }

  ${OUTLINE_TANGENT_GLSL}

  void main() {
    ivec2 corner = ivec2(gl_FragCoord.xy);
    float angle = outlineTangentAngle(corner.x, corner.y);
    float code = angle < 0.0
      ? ${OUTLINE_NORMAL_NONE.toFixed(1)}
      : min(floor(angle * (254.0 / 3.141592653589793) + 0.5), 254.0);
    fragColor = vec4(code / 255.0, 0.0, 0.0, 1.0);
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
  /** The corner texture (turn code, wall bits) the meshes place corners from. */
  readonly texture: THREE.Texture
  /** The smoothed wall-direction texture the wall strips light from. */
  readonly normals: THREE.Texture
  /**
   * Mark corners stale after a height change: a dirty cell rectangle, or the
   * whole grid when no region is given (a full re-upload, a lost context).
   */
  invalidate(region?: DirtyRegion): void
  /** Run the passes over whatever is stale; a no-op when nothing is. */
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

/**
 * The corners whose smoothed direction can change when the corners in `rect`
 * do: a walk reaches `OUTLINE_SMOOTH_STEPS` corners each way. Exported for the
 * tests.
 */
export function outlineNormalRect(grid: Pick<SimulationGrid, 'cols' | 'rows'>, rect: CornerRect): CornerRect {
  return {
    xMin: Math.max(0, rect.xMin - OUTLINE_SMOOTH_STEPS),
    xMax: Math.min(grid.cols, rect.xMax + OUTLINE_SMOOTH_STEPS),
    yMin: Math.max(0, rect.yMin - OUTLINE_SMOOTH_STEPS),
    yMax: Math.min(grid.rows, rect.yMax + OUTLINE_SMOOTH_STEPS),
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

function cornerTarget(width: number, height: number, format: THREE.PixelFormat, name: string): THREE.WebGLRenderTarget {
  const target = new THREE.WebGLRenderTarget(width, height, {
    format,
    type: THREE.UnsignedByteType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  })
  target.texture.name = name
  return target
}

function passMaterial(fragmentShader: string, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: passVertexShader,
    fragmentShader,
    glslVersion: THREE.GLSL3,
    depthTest: false,
    depthWrite: false,
  })
}

export function createOutlineCorners(
  heightfieldTexture: THREE.Texture,
  grid: SimulationGrid,
): OutlineCorners {
  const width = grid.cols + 1
  const height = grid.rows + 1
  const cornerRT = cornerTarget(width, height, THREE.RGFormat, 'simulationOutlineCorners')
  const normalRT = cornerTarget(width, height, THREE.RedFormat, 'simulationOutlineNormals')

  const cornerMaterial = passMaterial(OUTLINE_PASS_FRAGMENT_GLSL, {
    uHeightfield: { value: heightfieldTexture },
    uStockBottomZ: { value: grid.stockBottomZ },
    uCellSize: { value: grid.cellSize },
  })
  const normalMaterial = passMaterial(OUTLINE_NORMAL_PASS_FRAGMENT_GLSL, {
    uOutlineCorners: { value: cornerRT.texture },
  })
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), cornerMaterial)
  quad.frustumCulled = false
  const scene = new THREE.Scene()
  scene.add(quad)
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  const full: CornerRect = { xMin: 0, xMax: width - 1, yMin: 0, yMax: height - 1 }

  let staleCorners: CornerRect | null = full
  let staleNormals: CornerRect | null = full

  const run = (renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget, material: THREE.ShaderMaterial, rect: CornerRect) => {
    quad.material = material
    target.viewport.set(0, 0, width, height)
    target.scissor.set(rect.xMin, rect.yMin, rect.xMax - rect.xMin + 1, rect.yMax - rect.yMin + 1)
    target.scissorTest = true
    renderer.setRenderTarget(target)
    renderer.render(scene, camera)
  }

  return {
    texture: cornerRT.texture,
    normals: normalRT.texture,
    get pending() {
      return staleCorners !== null || staleNormals !== null
    },
    invalidate(region?: DirtyRegion) {
      const corners = region ? outlineCornerRect(grid, region) : full
      staleCorners = union(staleCorners, corners)
      staleNormals = union(staleNormals, outlineNormalRect(grid, corners))
    },
    update(renderer: THREE.WebGLRenderer) {
      if (!staleCorners && !staleNormals) return
      const previousTarget = renderer.getRenderTarget()
      const previousAutoClear = renderer.autoClear
      // Every texel in a rectangle is written, so nothing needs clearing.
      renderer.autoClear = false
      // Corners first: the normal pass walks the corner texture.
      if (staleCorners) run(renderer, cornerRT, cornerMaterial, staleCorners)
      if (staleNormals) run(renderer, normalRT, normalMaterial, staleNormals)
      staleCorners = null
      staleNormals = null
      renderer.setRenderTarget(previousTarget)
      renderer.autoClear = previousAutoClear
    },
    dispose() {
      cornerRT.dispose()
      normalRT.dispose()
      cornerMaterial.dispose()
      normalMaterial.dispose()
      quad.geometry.dispose()
    },
  }
}
