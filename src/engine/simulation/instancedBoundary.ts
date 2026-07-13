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
 * Instanced stock-boundary rendering: vertical walls at every grid edge plus
 * the stock underside, entirely GPU-driven.
 *
 * The CPU-built predecessor (`createShaderDrivenBoundaryGeometries`) emitted
 * ~18 vertices × ~48 B of attributes per cell — hundreds of MB of typed arrays
 * at high detail, a multi-second build stall on "Play Tool", and a hard cell
 * cap above which walls silently degraded. Here the per-edge wall quad carries
 * NO per-instance data at all: a 6-vertex template is instanced once per grid
 * edge, and the vertex shader derives the edge's position, its two adjacent
 * cells, and their current heights from `gl_InstanceID` + the heightfield
 * texture (GLSL3 `texelFetch`). Memory is O(1) in grid size, build time is a
 * couple of small allocations, and any detail level is playable.
 *
 * The underside is one full-grid quad whose fragments discard where the cell
 * has been cut through — replacing the old per-cell floor quads (which were
 * fragment-discarded anyway).
 */

import * as THREE from 'three'
import { LIGHTING_GLSL } from './heightfieldShader'
import type { SimulationGrid } from './types'

/**
 * One instance per interior + perimeter grid edge: vertical edges separate
 * horizontally adjacent cells ((cols+1) per row), horizontal edges separate
 * vertically adjacent cells (cols per row boundary, rows+1 boundaries).
 */
export function wallInstanceCount(grid: Pick<SimulationGrid, 'cols' | 'rows'>): number {
  return (grid.cols + 1) * grid.rows + grid.cols * (grid.rows + 1)
}

// One instance = one ROW of edges, not one edge. Millions of 2-triangle
// instances bottleneck on per-instance dispatch overhead (measured: indexing
// the per-edge template away made no fps difference at 1480 detail); a few
// thousand row-strip instances with the edge index baked into the template
// vertices keep the same shader-derived geometry with negligible dispatch
// cost. Template vertex encodes (edge index in row, along ∈ 0|1, top ∈ 0|1);
// gl_InstanceID supplies the row.
const wallVertexShader = /* glsl */ `
  uniform sampler2D uHeightfield;
  uniform float uStockBottomZ;
  uniform vec2 uOrigin;
  uniform float uCellSize;
  uniform int uCols;
  uniform int uRows;
  // 1.0 → vertical edges (wall plane ⊥ X), 0.0 → horizontal edges (⊥ Z).
  uniform float uVertical;

  varying vec3 vNormal;
  varying float vWallHeight;

  float cellHeight(ivec2 cell) {
    if (cell.x < 0 || cell.y < 0 || cell.x >= uCols || cell.y >= uRows) {
      return uStockBottomZ;
    }
    return texelFetch(uHeightfield, cell, 0).r;
  }

  void main() {
    int edgeCol = int(position.x + 0.5);
    int edgeRow = gl_InstanceID;

    vec3 edgeStart = vec3(
      uOrigin.x + float(edgeCol) * uCellSize,
      0.0,
      uOrigin.y + float(edgeRow) * uCellSize
    );
    vec3 edgeAlong;
    ivec2 nearCell;
    ivec2 farCell;
    vec3 edgePerp;

    ivec2 perpStep;
    if (uVertical > 0.5) {
      edgeAlong = vec3(0.0, 0.0, uCellSize);
      nearCell = ivec2(edgeCol - 1, edgeRow);
      farCell = ivec2(edgeCol, edgeRow);
      edgePerp = vec3(1.0, 0.0, 0.0);
      perpStep = ivec2(1, 0);
    } else {
      edgeAlong = vec3(uCellSize, 0.0, 0.0);
      nearCell = ivec2(edgeCol, edgeRow - 1);
      farCell = ivec2(edgeCol, edgeRow);
      edgePerp = vec3(0.0, 0.0, 1.0);
      perpStep = ivec2(0, 1);
    }

    float hNear = cellHeight(nearCell);
    float hFar = cellHeight(farCell);
    float top = max(hNear, hFar);
    float bottom = max(min(hNear, hFar), uStockBottomZ);

    // Fin suppression on machined slopes: a V-flank or ball roundover crosses
    // many cells, so every edge inside it has a small height step and would
    // otherwise draw a sliver wall whose axis-aligned lighting differs sharply
    // from the surface sheet's smooth per-fragment normals (reads as corduroy
    // striping on V/ball walls). A step that merely CONTINUES its neighbors'
    // gradient (same sign, comparable magnitude) is part of a slope the
    // surface already renders — collapse it. Isolated steps (pocket walls,
    // stepdown terraces, cut-through rims) keep their wall: their neighbors
    // are flat or the step dwarfs the neighbor gradient.
    float hNearBeyond = cellHeight(nearCell - perpStep);
    float hFarBeyond = cellHeight(farCell + perpStep);
    float dCenter = hFar - hNear;
    float dNear = hNear - hNearBeyond;
    float dFar = hFarBeyond - hFar;
    bool slopeContinues =
      (dNear * dCenter > 0.0 && abs(dCenter) <= 4.0 * abs(dNear)) ||
      (dFar * dCenter > 0.0 && abs(dCenter) <= 4.0 * abs(dFar));
    if (slopeContinues) {
      top = bottom;
    }

    vec3 pos = edgeStart + edgeAlong * position.y;
    pos.y = mix(bottom, top, position.z);

    // Light the face looking into the trough (away from the taller side).
    float direction = hNear >= hFar ? 1.0 : -1.0;
    vNormal = normalize(normalMatrix * (direction * edgePerp));
    vWallHeight = top - bottom;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`

// NOTE: with glslVersion GLSL3, three does NOT alias gl_FragColor for custom
// ShaderMaterials — the fragment shader must declare its own out variable.
const wallFragmentShader = /* glsl */ `
  uniform vec3 uColor;

  varying vec3 vNormal;
  varying float vWallHeight;

  out vec4 fragColor;

  ${LIGHTING_GLSL}

  void main() {
    if (vWallHeight < 0.0001) {
      // Adjacent cells at equal height — the wall has zero extent.
      discard;
    }
    vec3 lighting = calcLighting(normalize(vNormal));
    fragColor = vec4(uColor * lighting, 1.0);
  }
`

const floorVertexShader = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormal;

  void main() {
    vUv = uv;
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const floorFragmentShader = /* glsl */ `
  uniform sampler2D uHeightfield;
  uniform float uStockBottomZ;
  uniform vec3 uColor;
  uniform int uCols;
  uniform int uRows;

  varying vec2 vUv;
  varying vec3 vNormal;

  out vec4 fragColor;

  ${LIGHTING_GLSL}

  void main() {
    ivec2 cell = clamp(
      ivec2(vUv * vec2(float(uCols), float(uRows))),
      ivec2(0),
      ivec2(uCols - 1, uRows - 1)
    );
    float cellTopZ = texelFetch(uHeightfield, cell, 0).r;
    if (cellTopZ <= uStockBottomZ + 0.000001) {
      // Cut through (or outside the stock profile) — the underside is a hole.
      discard;
    }
    vec3 lighting = calcLighting(normalize(vNormal));
    fragColor = vec4(uColor * lighting, 1.0);
  }
`

function gridBoundingSphere(grid: SimulationGrid): THREE.Sphere {
  const width = grid.cols * grid.cellSize
  const depth = grid.rows * grid.cellSize
  const height = grid.stockTopZ - grid.stockBottomZ
  return new THREE.Sphere(
    new THREE.Vector3(grid.originX + width / 2, grid.stockBottomZ + height / 2, grid.originY + depth / 2),
    Math.hypot(width, height, depth) / 2 + 1,
  )
}

/**
 * Row-strip wall template: one indexed quad per edge in a single grid row,
 * instanced once per row. Vertex encodes (edge index in row, along ∈ 0|1,
 * top ∈ 0|1); real positions come from the vertex shader. Keeping instances
 * to a few thousand fat strips (instead of millions of 2-triangle quads)
 * avoids per-instance dispatch overhead on the GPU.
 */
export function createWallStripTemplate(
  grid: SimulationGrid,
  edgesPerRow: number,
  rowInstanceCount: number,
): THREE.InstancedBufferGeometry {
  const geometry = new THREE.InstancedBufferGeometry()
  const positions = new Float32Array(edgesPerRow * 4 * 3)
  const indices: number[] = []
  for (let edge = 0; edge < edgesPerRow; edge += 1) {
    const base = edge * 4
    // Corners: (along, top) = (0,0), (1,0), (1,1), (0,1)
    positions.set([
      edge, 0, 0,
      edge, 1, 0,
      edge, 1, 1,
      edge, 0, 1,
    ], base * 3)
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.instanceCount = rowInstanceCount

  // Real positions come from the vertex shader, so give the geometry a
  // bounding sphere covering the whole stock instead of the template strip.
  geometry.boundingSphere = gridBoundingSphere(grid)
  return geometry
}

function createFloorGeometry(grid: SimulationGrid): THREE.BufferGeometry {
  const x0 = grid.originX
  const x1 = grid.originX + grid.cols * grid.cellSize
  const z0 = grid.originY
  const z1 = grid.originY + grid.rows * grid.cellSize
  const y = grid.stockBottomZ

  const geometry = new THREE.BufferGeometry()
  const positions = new Float32Array([
    x0, y, z0,
    x1, y, z0,
    x1, y, z1,
    x0, y, z0,
    x1, y, z1,
    x0, y, z1,
  ])
  const normals = new Float32Array([
    0, -1, 0, 0, -1, 0, 0, -1, 0,
    0, -1, 0, 0, -1, 0, 0, -1, 0,
  ])
  const uvs = new Float32Array([
    0, 0,
    1, 0,
    1, 1,
    0, 0,
    1, 1,
    0, 1,
  ])
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

function sharedUniforms(
  heightfieldTexture: THREE.DataTexture,
  grid: SimulationGrid,
  stockColor: THREE.Color,
): Record<string, THREE.IUniform> {
  return {
    uHeightfield: { value: heightfieldTexture },
    uStockBottomZ: { value: grid.stockBottomZ },
    uColor: { value: stockColor },
    uOrigin: { value: new THREE.Vector2(grid.originX, grid.originY) },
    uCellSize: { value: grid.cellSize },
    uCols: { value: grid.cols },
    uRows: { value: grid.rows },
  }
}

export function createInstancedWallMaterial(
  heightfieldTexture: THREE.DataTexture,
  grid: SimulationGrid,
  stockColor: THREE.Color,
  vertical: boolean,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...sharedUniforms(heightfieldTexture, grid, stockColor),
      uVertical: { value: vertical ? 1 : 0 },
    },
    vertexShader: wallVertexShader,
    fragmentShader: wallFragmentShader,
    glslVersion: THREE.GLSL3,
    side: THREE.DoubleSide,
  })
}

export function createFloorMaterial(
  heightfieldTexture: THREE.DataTexture,
  grid: SimulationGrid,
  stockColor: THREE.Color,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: sharedUniforms(heightfieldTexture, grid, stockColor),
    vertexShader: floorVertexShader,
    fragmentShader: floorFragmentShader,
    glslVersion: THREE.GLSL3,
    side: THREE.DoubleSide,
  })
}

/**
 * Build the complete boundary as one group: two instanced wall-strip meshes
 * (vertical + horizontal edges) and the stock underside quad. All track the
 * heightfield texture, so the group is built once per grid and never rebuilt
 * while cutting.
 */
export function createInstancedBoundaryGroup(
  heightfieldTexture: THREE.DataTexture,
  grid: SimulationGrid,
  stockColor: THREE.Color,
): THREE.Group {
  const group = new THREE.Group()
  group.name = 'instancedBoundary'

  // Vertical edges: (cols+1) per row × rows instances.
  const verticalWalls = new THREE.Mesh(
    createWallStripTemplate(grid, grid.cols + 1, grid.rows),
    createInstancedWallMaterial(heightfieldTexture, grid, stockColor, true),
  )
  verticalWalls.frustumCulled = false
  group.add(verticalWalls)

  // Horizontal edges: cols per row boundary × (rows+1) instances.
  const horizontalWalls = new THREE.Mesh(
    createWallStripTemplate(grid, grid.cols, grid.rows + 1),
    createInstancedWallMaterial(heightfieldTexture, grid, stockColor, false),
  )
  horizontalWalls.frustumCulled = false
  group.add(horizontalWalls)

  const floor = new THREE.Mesh(
    createFloorGeometry(grid),
    createFloorMaterial(heightfieldTexture, grid, stockColor),
  )
  group.add(floor)

  return group
}
