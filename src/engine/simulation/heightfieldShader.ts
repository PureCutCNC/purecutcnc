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
import type { SimulationGrid } from './types'

// theme-exempt: scene lighting reference — matches SimulationViewport light rig
// Shared lighting code matching the scene lights in SimulationViewport:
//   AmbientLight(0xffffff, 0.7) // theme-exempt: scene lighting reference
//   DirectionalLight(0xffffff, 0.9) at (120, 180, 120) // theme-exempt: scene lighting reference
//   DirectionalLight(0x96b6ff, 0.35) at (-120, 80, -80) // theme-exempt: scene lighting reference
export const LIGHTING_GLSL = /* glsl */ `
  vec3 calcLighting(vec3 normal) {
    vec3 keyDir = normalize(vec3(120.0, 180.0, 120.0));
    vec3 fillDir = normalize(vec3(-120.0, 80.0, -80.0));
    vec3 fillColor = vec3(0.588, 0.714, 1.0);

    float diff1 = max(dot(normal, keyDir), 0.0);
    float diff2 = max(dot(normal, fillDir), 0.0);

    return vec3(0.7) + vec3(0.9) * diff1 + fillColor * 0.35 * diff2;
  }
`

/**
 * One predicate decides whether a grid edge is a vertical step, shared by the
 * surface sheet and the wall mesh so the two can never disagree about it: the
 * surface shades a slope, the wall draws a step. If they disagree, the loser's
 * shading shows up as a dark rim on a flat top — a tab's stock-to-tab wall
 * painted its own normal onto the 20 mm top beside it (issue #829).
 *
 * An edge is a slope when its step continues the gradient on either side of it
 * (same sign, comparable magnitude), which is what a V-flank or a ball
 * roundover looks like across many cells. An isolated step is a wall, and so is
 * any step onto a cell whose material has been removed entirely.
 */
export const STEP_GLSL = /* glsl */ `
  bool edgeIsStep(float hNear, float hFar, float hNearBeyond, float hFarBeyond, float stockBottomZ) {
    float dCenter = hFar - hNear;
    if (dCenter == 0.0) {
      // Adjacent cells at equal height — nothing here for either mesh to draw.
      return false;
    }
    float dNear = hNear - hNearBeyond;
    float dFar = hFarBeyond - hFar;
    bool slopeContinues =
      (dNear * dCenter > 0.0 && abs(dCenter) <= 4.0 * abs(dNear)) ||
      (dFar * dCenter > 0.0 && abs(dCenter) <= 4.0 * abs(dFar));
    bool cutThroughRim = min(hNear, hFar) <= stockBottomZ + 0.000001;
    return !slopeContinues || cutThroughRim;
  }
`

const vertexShader = /* glsl */ `
  uniform sampler2D uHeightfield;
  uniform vec2 uOrigin;
  uniform float uCellSize;

  flat out ivec2 vCell;
  out float vHeight;

  void main() {
    vCell = ivec2(int(position.x + 0.5), gl_InstanceID);
    float height = texelFetch(uHeightfield, vCell, 0).r;
    vHeight = height;

    vec3 displaced = vec3(
      uOrigin.x + (position.x + position.y) * uCellSize,
      height,
      uOrigin.y + (float(gl_InstanceID) + position.z) * uCellSize
    );

    gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
  }
`

const fragmentShader = /* glsl */ `
  uniform sampler2D uHeightfield;
  uniform vec3 uColor;
  uniform float uStockBottomZ;
  uniform float uStockTopZ;
  uniform float uCellSize;

  flat in ivec2 vCell;
  in float vHeight;
  out vec4 fragColor;

  ${LIGHTING_GLSL}

  ${STEP_GLSL}

  void main() {
    float threshold = uStockBottomZ + 0.000001;
    if (vHeight <= threshold) {
      discard;
    }

    ivec2 lastCell = textureSize(uHeightfield, 0) - ivec2(1);
    float hL = texelFetch(uHeightfield, clamp(vCell + ivec2(-1, 0), ivec2(0), lastCell), 0).r;
    float hR = texelFetch(uHeightfield, clamp(vCell + ivec2(1, 0), ivec2(0), lastCell), 0).r;
    float hD = texelFetch(uHeightfield, clamp(vCell + ivec2(0, -1), ivec2(0), lastCell), 0).r;
    float hU = texelFetch(uHeightfield, clamp(vCell + ivec2(0, 1), ivec2(0), lastCell), 0).r;

    // Second ring: a step is only a slope if it continues the gradient beyond
    // it, and that cannot be judged from the immediate neighbors alone.
    float hLL = texelFetch(uHeightfield, clamp(vCell + ivec2(-2, 0), ivec2(0), lastCell), 0).r;
    float hRR = texelFetch(uHeightfield, clamp(vCell + ivec2(2, 0), ivec2(0), lastCell), 0).r;
    float hDD = texelFetch(uHeightfield, clamp(vCell + ivec2(0, -2), ivec2(0), lastCell), 0).r;
    float hUU = texelFetch(uHeightfield, clamp(vCell + ivec2(0, 2), ivec2(0), lastCell), 0).r;

    // This cell is a flat tread. An axis bounded by a step takes no gradient
    // from it — the wall mesh draws that riser, and borrowing its normal is
    // what painted a dark band along every tab. Only a slope the surface
    // itself renders still tilts the normal.
    bool stepX =
      edgeIsStep(hL, vHeight, hLL, hR, uStockBottomZ) ||
      edgeIsStep(vHeight, hR, hL, hRR, uStockBottomZ);
    bool stepZ =
      edgeIsStep(hD, vHeight, hDD, hU, uStockBottomZ) ||
      edgeIsStep(vHeight, hU, hD, hUU, uStockBottomZ);
    if (stepX) {
      hL = vHeight;
      hR = vHeight;
    }
    if (stepZ) {
      hD = vHeight;
      hU = vHeight;
    }

    float dhdx = (hR - hL) / (2.0 * uCellSize);
    float dhdz = (hU - hD) / (2.0 * uCellSize);

    vec3 normal = normalize(vec3(-dhdx, 1.0, -dhdz));

    vec3 lighting = calcLighting(normal);

    float depthRatio = clamp((uStockTopZ - vHeight) / max(uStockTopZ - uStockBottomZ, 0.001), 0.0, 1.0);
    float depthDarken = 1.0 - depthRatio * 0.12;

    fragColor = vec4(uColor * lighting * depthDarken, 1.0);
  }
`

export function createHeightfieldMaterial(
  heightfieldTexture: THREE.DataTexture,
  grid: SimulationGrid,
  stockColor: THREE.Color,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uHeightfield: { value: heightfieldTexture },
      uColor: { value: stockColor },
      uStockBottomZ: { value: grid.stockBottomZ },
      uStockTopZ: { value: grid.stockTopZ },
      uOrigin: { value: new THREE.Vector2(grid.originX, grid.originY) },
      uCellSize: { value: grid.cellSize },
    },
    vertexShader,
    fragmentShader,
    glslVersion: THREE.GLSL3,
    side: THREE.DoubleSide,
  })
}
