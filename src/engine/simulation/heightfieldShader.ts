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

// Shared lighting code matching the scene lights in SimulationViewport:
//   AmbientLight(0xffffff, 0.7)
//   DirectionalLight(0xffffff, 0.9) at (120, 180, 120)
//   DirectionalLight(0x96b6ff, 0.35) at (-120, 80, -80)
const LIGHTING_GLSL = /* glsl */ `
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

  varying vec2 vUv;
  varying float vHeight;

  void main() {
    vUv = uv;
    float height = texture2D(uHeightfield, uv).r;
    vHeight = height;

    vec3 displaced = position;
    displaced.y = height;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
  }
`

const fragmentShader = /* glsl */ `
  uniform sampler2D uHeightfield;
  uniform vec3 uColor;
  uniform float uStockBottomZ;
  uniform float uStockTopZ;
  uniform vec2 uTexelSize;
  uniform float uCellSize;

  varying vec2 vUv;
  varying float vHeight;

  ${LIGHTING_GLSL}

  void main() {
    float threshold = uStockBottomZ + 0.000001;
    vec2 maxCellIndex = (vec2(1.0) / uTexelSize) - vec2(1.0);
    vec2 cellIndex = floor(clamp(vUv / uTexelSize, vec2(0.0), maxCellIndex));
    vec2 cellUv = (cellIndex + vec2(0.5)) * uTexelSize;
    float cellHeight = texture2D(uHeightfield, cellUv).r;

    if (cellHeight <= threshold) {
      discard;
    }

    float hL = texture2D(uHeightfield, vUv - vec2(uTexelSize.x, 0.0)).r;
    float hR = texture2D(uHeightfield, vUv + vec2(uTexelSize.x, 0.0)).r;
    float hD = texture2D(uHeightfield, vUv - vec2(0.0, uTexelSize.y)).r;
    float hU = texture2D(uHeightfield, vUv + vec2(0.0, uTexelSize.y)).r;

    if (hL <= threshold) hL = vHeight;
    if (hR <= threshold) hR = vHeight;
    if (hD <= threshold) hD = vHeight;
    if (hU <= threshold) hU = vHeight;

    float dhdx = (hR - hL) / (2.0 * uCellSize);
    float dhdz = (hU - hD) / (2.0 * uCellSize);

    vec3 normal = normalize(vec3(-dhdx, 1.0, -dhdz));

    vec3 lighting = calcLighting(normal);

    float depthRatio = clamp((uStockTopZ - vHeight) / max(uStockTopZ - uStockBottomZ, 0.001), 0.0, 1.0);
    float depthDarken = 1.0 - depthRatio * 0.12;

    gl_FragColor = vec4(uColor * lighting * depthDarken, 1.0);
  }
`

const boundaryVertexShader = /* glsl */ `
  varying vec3 vNormal;

  void main() {
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const boundaryFragmentShader = /* glsl */ `
  uniform vec3 uColor;

  varying vec3 vNormal;

  ${LIGHTING_GLSL}

  void main() {
    vec3 lighting = calcLighting(normalize(vNormal));
    gl_FragColor = vec4(uColor * lighting, 1.0);
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
      uTexelSize: { value: new THREE.Vector2(1 / grid.cols, 1 / grid.rows) },
      uCellSize: { value: grid.cellSize },
    },
    vertexShader,
    fragmentShader,
    side: THREE.DoubleSide,
  })
}

export function createBoundaryMaterial(stockColor: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: stockColor },
    },
    vertexShader: boundaryVertexShader,
    fragmentShader: boundaryFragmentShader,
    side: THREE.DoubleSide,
  })
}

const dynamicBoundaryVertexShader = /* glsl */ `
  uniform sampler2D uHeightfield;
  uniform float uStockBottomZ;

  attribute vec2 aCellUv;
  attribute float aIsTop;

  varying vec3 vNormal;
  varying vec2 vCellUv;

  void main() {
    vNormal = normalize(normalMatrix * normal);
    vCellUv = aCellUv;

    float cellHeight = texture2D(uHeightfield, aCellUv).r;
    float y = mix(uStockBottomZ, cellHeight, aIsTop);

    vec3 pos = vec3(position.x, y, position.z);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`

const dynamicBoundaryFragmentShader = /* glsl */ `
  uniform sampler2D uHeightfield;
  uniform float uStockBottomZ;
  uniform vec3 uColor;

  varying vec3 vNormal;
  varying vec2 vCellUv;

  ${LIGHTING_GLSL}

  void main() {
    float cellHeight = texture2D(uHeightfield, vCellUv).r;
    if (cellHeight <= uStockBottomZ + 0.000001) discard;

    vec3 lighting = calcLighting(normalize(vNormal));
    gl_FragColor = vec4(uColor * lighting, 1.0);
  }
`

export function createDynamicBoundaryMaterial(
  heightfieldTexture: THREE.DataTexture,
  grid: SimulationGrid,
  stockColor: THREE.Color,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uHeightfield: { value: heightfieldTexture },
      uStockBottomZ: { value: grid.stockBottomZ },
      uColor: { value: stockColor },
    },
    vertexShader: dynamicBoundaryVertexShader,
    fragmentShader: dynamicBoundaryFragmentShader,
    side: THREE.DoubleSide,
  })
}

// Shader-driven walls. The mesh emits one wall quad per grid edge (interior +
// outer) plus one floor quad per cell, all at build time. The vertex shader
// samples both adjacent cells' heightfields, drawing the wall from the lower
// side's height up to the higher side's height (or discarding when they're
// equal). The floor face is discarded by the fragment shader whenever its
// cell still has material. As a result, all wall/floor transitions during
// playback are handled by the GPU and the mesh is never rebuilt.
//
// Sentinel: aLeftUv.x or aRightUv.x < 0 means "outside the grid" — treated as
// stockBottomZ (always empty). Used by edges at the stock perimeter.
const shaderDrivenBoundaryVertexShader = /* glsl */ `
  uniform sampler2D uHeightfield;
  uniform float uStockBottomZ;

  attribute vec2 aLeftUv;
  attribute vec2 aRightUv;
  attribute float aIsTop;
  attribute float aIsFloor;

  varying vec3 vNormal;
  varying vec2 vLeftUv;
  varying float vIsFloor;
  varying float vWallHeight;

  void main() {
    vLeftUv = aLeftUv;
    vIsFloor = aIsFloor;

    float hLeft = aLeftUv.x < 0.0 ? uStockBottomZ : texture2D(uHeightfield, aLeftUv).r;
    float hRight = aRightUv.x < 0.0 ? uStockBottomZ : texture2D(uHeightfield, aRightUv).r;

    vec3 pos = position;
    if (aIsFloor > 0.5) {
      pos.y = uStockBottomZ;
      vNormal = normalize(normalMatrix * normal);
      vWallHeight = 1.0;
    } else {
      float top = max(hLeft, hRight);
      float bottom = max(min(hLeft, hRight), uStockBottomZ);
      pos.y = mix(bottom, top, aIsTop);
      // Flip the supplied perpendicular toward the lower side so the lit face
      // is the one facing into the trough (away from the taller material).
      float dir = sign(hLeft - hRight);
      vec3 wallNormal = dir * normal;
      vNormal = normalize(normalMatrix * wallNormal);
      vWallHeight = top - bottom;
    }

    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`

const shaderDrivenBoundaryFragmentShader = /* glsl */ `
  uniform sampler2D uHeightfield;
  uniform float uStockBottomZ;
  uniform vec3 uColor;

  varying vec3 vNormal;
  varying vec2 vLeftUv;
  varying float vIsFloor;
  varying float vWallHeight;

  ${LIGHTING_GLSL}

  void main() {
    if (vIsFloor > 0.5) {
      float h = vLeftUv.x < 0.0 ? uStockBottomZ : texture2D(uHeightfield, vLeftUv).r;
      // Floor shows the underside of the stock — visible while the cell still
      // has material. Cells cut all the way through become holes (no floor).
      if (h <= uStockBottomZ + 0.000001) discard;
    } else if (vWallHeight < 0.0001) {
      // Both sides have equal height — wall has zero extent, would z-fight.
      discard;
    }
    vec3 lighting = calcLighting(normalize(vNormal));
    gl_FragColor = vec4(uColor * lighting, 1.0);
  }
`

export function createShaderDrivenBoundaryMaterial(
  heightfieldTexture: THREE.DataTexture,
  grid: SimulationGrid,
  stockColor: THREE.Color,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uHeightfield: { value: heightfieldTexture },
      uStockBottomZ: { value: grid.stockBottomZ },
      uColor: { value: stockColor },
    },
    vertexShader: shaderDrivenBoundaryVertexShader,
    fragmentShader: shaderDrivenBoundaryFragmentShader,
    side: THREE.DoubleSide,
  })
}
