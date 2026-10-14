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
import type { AroundFrame } from '../aroundFrame'
import type { SimulationGrid } from './types'

/** Scalar components let tests execute the GPU's own transform, on either axis. */
export const AROUND_WRAP_GLSL = /* glsl */ `
  float aroundClampAcross(float across, float sheetStart, float circumference) {
    return clamp(across, sheetStart, sheetStart + circumference);
  }

  float aroundWrap(float x, float h, float z, float centre, float radius, float sheetStart, float circumference, bool xAxis, int component) {
    float across = xAxis ? z : x;
    float angle = 6.283185307179586 * (across - sheetStart) / circumference;
    float side = centre + h * sin(angle);
    float up = radius + h * cos(angle);
    if (component == 1) return up;
    if (component == 0) return xAxis ? x : side;
    return xAxis ? side : z;
  }

  float aroundNormal(float nx, float ny, float nz, float across, float sheetStart, float circumference, bool xAxis, int component) {
    float angle = 6.283185307179586 * (across - sheetStart) / circumference;
    float tangent = xAxis ? nz : nx;
    float side = ny * sin(angle) + tangent * cos(angle);
    float up = ny * cos(angle) - tangent * sin(angle);
    if (component == 1) return up;
    if (component == 0) return xAxis ? nx : side;
    return xAxis ? side : nz;
  }
`

/** Included only in the compile-time Around variant of each shader. */
export const AROUND_FRAME_GLSL = /* glsl */ `#ifdef AROUND_WRAP
  uniform float uAroundCentre;
  uniform float uAroundRadius;
  uniform float uAroundStart;
  uniform float uAroundPeriod;
  uniform bool uAroundX;
  ${AROUND_WRAP_GLSL}

  vec3 aroundClampSheet(vec3 sheet) {
    if (uAroundX) sheet.z = aroundClampAcross(sheet.z, uAroundStart, uAroundPeriod);
    else sheet.x = aroundClampAcross(sheet.x, uAroundStart, uAroundPeriod);
    return sheet;
  }

  vec3 aroundPosition(vec3 sheet) {
    return vec3(
      aroundWrap(sheet.x, sheet.y, sheet.z, uAroundCentre, uAroundRadius, uAroundStart, uAroundPeriod, uAroundX, 0),
      aroundWrap(sheet.x, sheet.y, sheet.z, uAroundCentre, uAroundRadius, uAroundStart, uAroundPeriod, uAroundX, 1),
      aroundWrap(sheet.x, sheet.y, sheet.z, uAroundCentre, uAroundRadius, uAroundStart, uAroundPeriod, uAroundX, 2)
    );
  }

  vec3 aroundSurfaceNormal(vec3 n, float across) {
    return vec3(
      aroundNormal(n.x, n.y, n.z, across, uAroundStart, uAroundPeriod, uAroundX, 0),
      aroundNormal(n.x, n.y, n.z, across, uAroundStart, uAroundPeriod, uAroundX, 1),
      aroundNormal(n.x, n.y, n.z, across, uAroundStart, uAroundPeriod, uAroundX, 2)
    );
  }
#endif`

/**
 * Periodic neighbor lookup, only for bar materials; along edges stay open.
 * Preprocessor-free so `glslScalar.testSupport.ts` can run the very integer
 * code the GPU compiles (issue #395 G3); the `#ifdef` wrapper is added by
 * `AROUND_CELL_GLSL` below.
 */
export const AROUND_CELL_INDEX_GLSL = /* glsl */ `
  ivec2 aroundCell(ivec2 cell) {
    int count = int(ceil(uAroundPeriod / uCellSize));
    if (uAroundX) cell.y = ((cell.y % count) + count) % count;
    else cell.x = ((cell.x % count) + count) % count;
    return cell;
  }
`

export const AROUND_CELL_GLSL = /* glsl */ `#ifdef AROUND_WRAP
${AROUND_CELL_INDEX_GLSL}
#endif`

export function aroundUniforms(frame?: AroundFrame): Record<string, THREE.IUniform> {
  return frame ? {
    uAroundCentre: { value: frame.centre },
    uAroundRadius: { value: frame.radius },
    uAroundStart: { value: frame.sheetStart },
    uAroundPeriod: { value: frame.circumference },
    uAroundX: { value: frame.axis === 'x' },
  } : {}
}

/** Bounds enclose shader-displaced positions, including the back of the bar. */
export function aroundBounds(grid: SimulationGrid, frame: AroundFrame): THREE.Box3 {
  return frame.axis === 'x' ? new THREE.Box3(
    new THREE.Vector3(grid.originX, 0, frame.centre - frame.radius),
    new THREE.Vector3(grid.originX + grid.cols * grid.cellSize, 2 * frame.radius, frame.centre + frame.radius),
  ) : new THREE.Box3(
    new THREE.Vector3(frame.centre - frame.radius, 0, grid.originY),
    new THREE.Vector3(frame.centre + frame.radius, 2 * frame.radius, grid.originY + grid.rows * grid.cellSize),
  )
}

/** Flat shaders retain their exact source: no extra code or runtime branch. */
export function aroundShader(source: string, frame?: AroundFrame): string {
  if (frame) {
    return source
      .replace('float cellHeight(ivec2 cell) {', `${AROUND_CELL_GLSL}
  float cellHeight(ivec2 cell) {
#ifdef AROUND_WRAP
    cell = aroundCell(cell);
#endif`)
      .replace('float stencilHeight(ivec2 cell, ivec2 lastCell) {', `float stencilHeight(ivec2 cell, ivec2 lastCell) {
#ifdef AROUND_WRAP
    cell = aroundCell(cell);
#endif`)
  }
  return source.replace(/^[ \t]*#ifdef AROUND_WRAP([\s\S]*?)#endif\n?/gm, (_block, code: string) => code.includes('#else\n') ? code.split('#else\n')[1] : '')
}
