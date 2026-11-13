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
 * The CPU-built predecessor emitted ~18 vertices × ~48 B of attributes per
 * cell — hundreds of MB of typed arrays at high detail, a multi-second build
 * stall on "Play tool", and a hard cell cap above which walls silently
 * degraded. Here the geometry carries NO per-cell attribute data: one indexed
 * quad per edge is packed into a row-strip template and instanced once per grid
 * row, and the vertex shader derives each edge's position, its two adjacent
 * cells, and their current heights from `gl_InstanceID` + the heightfield
 * texture (GLSL3 `texelFetch`). Template memory is O(cols), build time is a
 * couple of small allocations, and any detail level is playable. (Row strips
 * rather than one instance per edge: millions of 2-triangle instances bottleneck
 * on per-instance dispatch — see `createWallStripTemplate`.)
 *
 * The underside is one full-grid quad whose fragments discard where the cell
 * has been cut through — replacing the old per-cell floor quads (which were
 * fragment-discarded anyway). A flat round bar gets no underside quad at all:
 * its flat stock bottom is not a face of a cylinder, and the static lower half
 * is its underside (issue #1049).
 */

import * as THREE from 'three'
import type { AroundFrame } from '../aroundFrame'
import { AROUND_CELL_GLSL, AROUND_FRAME_GLSL, aroundBounds, aroundShader, aroundUniforms } from './aroundWrap'
import {
  CELL_HEIGHT_GLSL,
  LIGHTING_GLSL,
  ROUND_BAR_SILHOUETTE_GLSL,
  SLOPE_GRADIENT_GLSL,
  SQUARE_BLANK_SILHOUETTE_GLSL,
  STEP_GLSL,
  SURFACE_NORMAL_GLSL,
} from './heightfieldShader'
import type { FlatRoundBarDescriptor, SimulationGrid } from './types'

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
/**
 * A flat round bar's wall floor: the static lower half's cylindrical surface
 * (issue #1049). The heightfield's outer edge and the half-cylinder must meet
 * without a gap, so a wall stops on the cylinder rather than at the equator
 * plane — the same value at the silhouette (`|across| = radius`), a little
 * lower where the grid boundary falls inside the bar. An outermost boundary
 * that overshoots the radius is pulled back onto the silhouette, so the join
 * is the bar's real circle at any grid spacing. `wallEdgeCollapsed` is the same
 * rule the wall shader applies, written as a scalar so the tests can run this
 * exact text.
 */
export const ROUND_BAR_WALL_JOIN_GLSL = /* glsl */ `
  ${ROUND_BAR_SILHOUETTE_GLSL}

  float roundBarWallFloorZ(float pivot, float radius, float across, bool alongEnd, float baseFloorZ, float stockBottomZ) {
    if (alongEnd) return baseFloorZ;
    float dropSquared = radius * radius - across * across;
    float drop = dropSquared > 0.0 ? sqrt(dropSquared) : 0.0;
    float floorZ = pivot - drop;
    return floorZ > stockBottomZ ? floorZ : stockBottomZ;
  }

  bool wallEdgeCollapsed(float hNear, float hFar, float floorZ) {
    float top = max(hNear, hFar);
    float bottom = max(min(hNear, hFar), floorZ);
    return top <= bottom + 0.000001;
  }
`

const wallVertexShader = (flatRoundBar: boolean, squareBlank: boolean): string => /* glsl */ `
  uniform sampler2D uHeightfield;
  uniform float uStockBottomZ;
  // The lowest Y a heightfield wall may reach. The stock bottom for every
  // block, square and Around grid; for a flat round bar it is the equator,
  // where the static lower half takes over (issue #1049).
  uniform float uWallFloorZ;
  uniform vec2 uOrigin;
  uniform float uCellSize;
  // 1.0 → vertical edges (wall plane ⊥ X), 0.0 → horizontal edges (⊥ Z).
  uniform float uVertical;
${flatRoundBar ? `  // Flat round-bar join (issue #1049): the lower half the walls must land on,
  // the bar's axis (0 = X, 1 = Y) and the grid size for detecting the two
  // along ends, whose flat end caps already reach the equator.
  uniform float uBarPivot;
  uniform float uBarRadius;
  uniform float uBarCentre;
  uniform float uBarAxis;
  uniform int uCols;
  uniform int uRows;
` : ''}${squareBlank ? `  // The square blank's side, for the silhouette its own cross-section draws.
  uniform float uBlankSide;
` : ''}${squareBlank ? SQUARE_BLANK_SILHOUETTE_GLSL : ''}
  ${AROUND_FRAME_GLSL}
#ifdef AROUND_WRAP
  out float vAcross;
#endif
  out vec3 vNormal;
  out float vWallHeight;
  out float vHeight;
  // > 0.5 when this edge is a riser inside a slope rather than a step.
  flat out float vSlope;
  // The cell on the far side of the edge, and the position inside it.
  flat out ivec2 vCell;
  out vec2 vLocal;
  out vec3 vPositionInCells;

  ${STEP_GLSL}
${flatRoundBar ? ROUND_BAR_WALL_JOIN_GLSL : ''}
  ${CELL_HEIGHT_GLSL}

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
${flatRoundBar ? `    // A flat round bar's heightfield carries only the machinable upper half.
    // Its walls land on the static lower half: on the cylindrical surface
    // along the sides (the silhouette where the grid edge is the radius, a
    // little below it where the cell boundary falls short of the radius) and
    // on the flat end caps' equator at the two along ends. An outermost cell
    // boundary that overshoots the radius is pulled back onto the silhouette,
    // so the wall and the lower half meet on the bar's real circle whatever
    // the grid spacing. Edges with no material above that surface collapse.
    vec3 pos = edgeStart + edgeAlong * position.y;
    float across = uBarAxis < 0.5 ? pos.z : pos.x;
    across = roundBarSilhouetteAcross(across, uBarCentre, uBarRadius);
    if (uBarAxis < 0.5) {
      pos.z = across;
    } else {
      pos.x = across;
    }
    bool alongEnd = uBarAxis < 0.5
      ? uVertical > 0.5 && (edgeCol == 0 || edgeCol == uCols)
      : uVertical < 0.5 && (edgeRow == 0 || edgeRow == uRows);
    float wallFloor = roundBarWallFloorZ(
      uBarPivot, uBarRadius, across - uBarCentre, alongEnd, uWallFloorZ, uStockBottomZ
    );
    bottom = max(bottom, wallFloor);
    bool collapsed = wallEdgeCollapsed(hNear, hFar, wallFloor);
    if (collapsed) bottom = top;` : `    // A flat round bar's heightfield carries only the machinable upper half;
    // nothing below its equator is represented, so its walls stop there and
    // the static half-cylinder draws the rest. Edges entirely below the floor
    // still exist in the strip template — collapse them so they discard.
    bottom = max(bottom, uWallFloorZ);
    bool collapsed = top <= bottom + 0.000001;
    if (collapsed) bottom = top;`}

    // Risers inside a machined slope: a V-flank, a ball roundover or a finished
    // 3D surface crosses many cells, so every edge inside it has a small height
    // step. Lit as a wall, each one is a sliver whose axis-aligned normal differs
    // sharply from the surface around it (corduroy striping on V/ball walls, a
    // grid of dark lines on a finished surface). Left out, the flat cell tops
    // leave a slit between them that shows the stock underside. So the riser is
    // drawn, but shaded as the surface it is part of: the fragment shader lights
    // it with the same smoothed normal the tops on either side use.
    // Isolated steps (pocket walls, stepdown terraces, cut-through rims, a
    // tab's stock-to-tab wall) keep their own wall normal.
    //
    // The surface sheet asks the same predicate before it takes a gradient
    // across an edge (issue #829), so "wall lit as a wall" and "surface stays
    // flat" are one decision rather than two that can drift apart.
    float hNearBeyond = cellHeight(nearCell - perpStep);
    float hFarBeyond = cellHeight(farCell + perpStep);
    bool isStep = edgeIsStep(hNear, hFar, hNearBeyond, hFarBeyond, uStockBottomZ, uCellSize);

${flatRoundBar ? '' : `    vec3 pos = edgeStart + edgeAlong * position.y;
`}    pos.y = mix(bottom, top, position.z);

    // Light the face looking into the trough (away from the taller side).
    float direction = hNear >= hFar ? 1.0 : -1.0;
${flatRoundBar ? `    // A flat round bar lights in world space like the lower half and the tops,
    // so the two surfaces meet at the equator under one normal (issue #1049).
` : ''}    vNormal = normalize(${flatRoundBar ? 'mat3(modelMatrix)' : 'normalMatrix'} * (direction * edgePerp));
    vWallHeight = top - bottom;
    vHeight = pos.y;
    vSlope = collapsed || isStep ? 0.0 : 1.0;
    vCell = farCell;
    vLocal = uVertical > 0.5 ? vec2(0.0, position.y) : vec2(position.y, 0.0);
    vPositionInCells = pos / uCellSize;

#ifdef AROUND_WRAP
    int aroundCount = int(ceil(uAroundPeriod / uCellSize));
    bool extraAcrossEdge = uAroundX
      ? uVertical < 0.5 && edgeRow > aroundCount
      : uVertical > 0.5 && edgeCol > aroundCount;
    if (extraAcrossEdge) {
      vWallHeight = 0.0;
      vSlope = 0.0;
    }
    pos = aroundClampSheet(pos);
${squareBlank ? `    // A square blank's section is widest at its cell centres, so a wall can
    // straddle the blank's true surface: clamp it back onto the square the
    // heightfield stands for, and the fin under the uncut ends is gone
    // (issue #1112 rt3-b).
    pos.y = squareBlankSilhouetteRadius(uBlankSide, 6.283185307179586 * ((uAroundX ? pos.z : pos.x) - uAroundZero) / uAroundPeriod, pos.y);
` : ''}    vAcross = uAroundX ? pos.z : pos.x;
    vNormal = normalize(mat3(modelMatrix) * aroundSurfaceNormal(direction * edgePerp, vAcross));
    pos = aroundPosition(pos);
#endif
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`

// NOTE: with glslVersion GLSL3, three does NOT alias gl_FragColor for custom
// ShaderMaterials — the fragment shader must declare its own out variable.
const wallFragmentShader = (flatRoundBar: boolean): string => /* glsl */ `
  uniform sampler2D uHeightfield;
  uniform vec3 uColor;
  uniform float uStockBottomZ;
  uniform float uStockTopZ;
  uniform float uCellSize;

  ${AROUND_FRAME_GLSL}
#ifdef AROUND_WRAP
  in float vAcross;
  uniform mat4 modelMatrix;
#endif
  ${AROUND_CELL_GLSL}
  in vec3 vNormal;
  in float vWallHeight;
  in float vHeight;
  flat in float vSlope;
  flat in ivec2 vCell;
  in vec2 vLocal;
  in vec3 vPositionInCells;

  out vec4 fragColor;

  ${LIGHTING_GLSL}

  ${STEP_GLSL}

  ${SLOPE_GRADIENT_GLSL}

  ${SURFACE_NORMAL_GLSL}

  void main() {
    if (vSlope > 0.5) {
      // A riser inside a slope is a piece of the surface, not a wall.
      float wide = gradientWidening(vPositionInCells);
      vec3 lighting = calcLighting(surfaceNormal(vCell, vLocal, wide));
#ifdef AROUND_WRAP
      lighting = calcLighting(normalize(mat3(modelMatrix) * aroundSurfaceNormal(surfaceNormal(vCell, vLocal, wide), vAcross)));
#endif
      fragColor = vec4(uColor * lighting * depthDarken(vHeight, uStockTopZ), 1.0);
      return;
    }
    if (vWallHeight < 0.0001) {
      // Adjacent cells at equal height — the wall has zero extent.
      discard;
    }
    vec3 lighting = calcLighting(normalize(vNormal));
${flatRoundBar ? `    // A flat round bar's step wall takes the same depth darkening as the lower
    // half it meets, so the equator join has no brightness step either (#1049).
` : ''}    fragColor = vec4(uColor * lighting${flatRoundBar ? ' * depthDarken(vHeight, uStockTopZ)' : ''}, 1.0);
  }
`

const floorVertexShader = /* glsl */ `
  ${AROUND_FRAME_GLSL}
  varying vec2 vUv;
  varying vec3 vNormal;

  void main() {
    vUv = uv;
    vNormal = normalize(normalMatrix * normal);
#ifdef AROUND_WRAP
    vec3 sheet = aroundClampSheet(position);
    float across = uAroundX ? sheet.z : sheet.x;
    vNormal = normalize(mat3(modelMatrix) * aroundSurfaceNormal(normal, across));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(aroundPosition(sheet), 1.0);
#else
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
#endif
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
    uStockTopZ: { value: grid.stockTopZ },
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
  frame?: AroundFrame,
  wallFloorZ?: number,
  flatRoundBar?: FlatRoundBarDescriptor,
  squareBlankSide?: number,
): THREE.ShaderMaterial {
  const roundBar = flatRoundBar !== undefined
  // The wrapped bar view of a square blank is the only scene that can draw a
  // wall outside the blank; everything else compiles the shader it always has.
  const blankSide = frame === undefined ? undefined : squareBlankSide
  return new THREE.ShaderMaterial({
    ...(frame ? { defines: { AROUND_WRAP: 1 } } : {}),
    uniforms: {
      ...sharedUniforms(heightfieldTexture, grid, stockColor),
      ...aroundUniforms(frame),
      uVertical: { value: vertical ? 1 : 0 },
      // The along ends' floor is the equator; the sides use the bar's circle.
      uWallFloorZ: { value: wallFloorZ ?? (flatRoundBar ? flatRoundBar.pivot : grid.stockBottomZ) },
      ...(flatRoundBar
        ? {
            uBarPivot: { value: flatRoundBar.pivot },
            uBarRadius: { value: flatRoundBar.radius },
            uBarCentre: { value: flatRoundBar.centre },
            uBarAxis: { value: flatRoundBar.axis === 'x' ? 0 : 1 },
          }
        : {}),
      ...(blankSide !== undefined ? { uBlankSide: { value: blankSide } } : {}),
    },
    vertexShader: aroundShader(wallVertexShader(roundBar, blankSide !== undefined), frame),
    fragmentShader: aroundShader(wallFragmentShader(roundBar), frame),
    glslVersion: THREE.GLSL3,
    side: THREE.DoubleSide,
  })
}

export function createFloorMaterial(
  heightfieldTexture: THREE.DataTexture,
  grid: SimulationGrid,
  stockColor: THREE.Color,
  frame?: AroundFrame,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    ...(frame ? { defines: { AROUND_WRAP: 1 } } : {}),
    uniforms: { ...sharedUniforms(heightfieldTexture, grid, stockColor), ...aroundUniforms(frame) },
    vertexShader: aroundShader(floorVertexShader, frame),
    fragmentShader: aroundShader(floorFragmentShader, frame),
    glslVersion: THREE.GLSL3,
    side: THREE.DoubleSide,
  })
}

/**
 * Build the complete boundary as one group: two instanced wall-strip meshes
 * (vertical + horizontal edges) and, for every stock with a flat underside,
 * the stock underside quad. All track the heightfield texture, so the group is
 * built once per grid and never rebuilt while cutting. `wallFloorZ` defaults
 * to the stock bottom; a flat round bar passes its equator, which is the floor
 * of its two along-end walls (issue #1049).
 *
 * A flat round bar (`flatRoundBar`) has no flat underside at all: its stock
 * bottom is the lower half's cylindrical surface, so the group carries no
 * floor quad and its walls land on that surface instead of the equator plane
 * (issue #1049 follow-up). A block, square blank or Around grid passes no
 * descriptor and builds exactly the same three meshes it always has.
 *
 * `squareBlankSide` (issue #1112 rt3-b) only changes the two wall shaders, and
 * only in the wrapped view: each wall is clamped onto the blank's own
 * cross-section, so the bar view cannot draw a wall outside the square it
 * represents. No mesh is added or removed, and a block or a round bar passes
 * nothing.
 */
export function createInstancedBoundaryGroup(
  heightfieldTexture: THREE.DataTexture,
  grid: SimulationGrid,
  stockColor: THREE.Color,
  frame?: AroundFrame,
  wallFloorZ?: number,
  flatRoundBar?: FlatRoundBarDescriptor,
  squareBlankSide?: number,
): THREE.Group {
  const roundBar = flatRoundBar !== undefined
  const group = new THREE.Group()
  group.name = 'instancedBoundary'

  // Vertical edges: (cols+1) per row × rows instances.
  const verticalWalls = new THREE.Mesh(
    createWallStripTemplate(grid, grid.cols + 1, grid.rows),
    createInstancedWallMaterial(heightfieldTexture, grid, stockColor, true, frame, wallFloorZ, flatRoundBar, squareBlankSide),
  )
  verticalWalls.frustumCulled = false
  group.add(verticalWalls)

  // Horizontal edges: cols per row boundary × (rows+1) instances.
  const horizontalWalls = new THREE.Mesh(
    createWallStripTemplate(grid, grid.cols, grid.rows + 1),
    createInstancedWallMaterial(heightfieldTexture, grid, stockColor, false, frame, wallFloorZ, flatRoundBar, squareBlankSide),
  )
  horizontalWalls.frustumCulled = false
  group.add(horizontalWalls)

  // The flat stock underside. A round bar's underside is its static lower
  // half, so drawing this quad would leave a flat sheet under the bar.
  if (!roundBar) {
    const floor = new THREE.Mesh(
      createFloorGeometry(grid),
      createFloorMaterial(heightfieldTexture, grid, stockColor, frame),
    )
    group.add(floor)
  }

  if (frame) {
    // The bar's culling bounds reach the grid's radial envelope (the corner
    // radius on a square blank, the bar radius on a round one) so no raised
    // corner is clipped; the pivot stays `frame.radius`.
    const bounds = aroundBounds(grid, frame)
    for (const child of group.children) {
      if (!(child instanceof THREE.Mesh)) continue
      child.geometry.boundingBox = bounds.clone()
      child.geometry.boundingSphere = bounds.getBoundingSphere(new THREE.Sphere())
    }
  }
  return group
}
