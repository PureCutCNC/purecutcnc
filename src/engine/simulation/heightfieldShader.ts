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

    // A cut-through neighbor is a vertical rim, not a continuation of the
    // top surface. Keep that axis flat even when the opposite neighbor is
    // taller; a one-cell tab otherwise acquires a false sloped, dark top.
    if (hL <= threshold || hR <= threshold) {
      hL = vHeight;
      hR = vHeight;
    }
    if (hD <= threshold || hU <= threshold) {
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
