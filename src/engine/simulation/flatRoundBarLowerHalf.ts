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
 * The fixed lower half of a round bar on a flat (Top or Bottom) setup (issue
 * #1049).
 *
 * A flat setup simulates the bar's machinable upper half as the usual top-down
 * heightfield (`seedFlatRoundBarTopZ`). Nothing in that heightfield represents
 * the material below the equator — the half a cutter approaching from above
 * cannot reach — so its boundary walls used to run straight down to the stock
 * bottom and the bar read as a mailbox. This module supplies the missing half
 * as one static surface: a half-cylinder of the bar's own radius, along the
 * bar's length, closed by half-disc end caps. It is built from the same
 * descriptor that seeds the grid, shares the heightfield's colour and light
 * rig, and never changes while the job is cut.
 *
 * Block, square and Around grids have no flat round-bar descriptor and get
 * `null`, so their scenes are untouched.
 */

import * as THREE from 'three'
import { DEPTH_DARKEN_GLSL, LIGHTING_GLSL } from './heightfieldShader'
import type { FlatRoundBarDescriptor, SimulationGrid } from './types'

/** Name of the mesh, so the scene can be told apart in tests and smoke checks. */
export const FLAT_ROUND_BAR_LOWER_HALF_NAME = 'flatRoundBarLowerHalf'

/**
 * Radial samples around the semicircle. The wall mesh's floor follows the
 * analytic circle, so enough segments keep this polyline within a hair of it
 * and the two surfaces meet at the silhouette without a visible fin. 1024
 * keeps the polyline's vertical error under 2e-4 project units at the grid
 * boundaries these joins land on, so the join has no measurable overlap.
 */
export const FLAT_ROUND_BAR_RADIAL_SEGMENTS = 1024

function lowerHalfMaterial(stockColor: THREE.Color, grid: SimulationGrid): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: stockColor },
      uStockBottomZ: { value: grid.stockBottomZ },
      uStockTopZ: { value: grid.stockTopZ },
    },
    // World-space normals: the heightfield surface lights its cells with
    // world-space normals and the same LIGHTING_GLSL rig, so the two surfaces
    // meet at the equator under identical shading. The authored normals are
    // always outward and DoubleSide is only so a camera below the stock still
    // sees the shell — no facing-dependent flip, exactly like the heightfield
    // surface, so the two meshes cannot disagree about how a face is lit.
    vertexShader: /* glsl */ `
      out vec3 vNormal;
      out float vHeight;

      void main() {
        vNormal = normalize(mat3(modelMatrix) * normal);
        vHeight = (modelMatrix * vec4(position, 1.0)).y;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uStockBottomZ;
      uniform float uStockTopZ;

      in vec3 vNormal;
      in float vHeight;

      out vec4 fragColor;

      ${LIGHTING_GLSL}

      ${DEPTH_DARKEN_GLSL}

      void main() {
        fragColor = vec4(uColor * calcLighting(normalize(vNormal)) * depthDarken(vHeight, uStockTopZ), 1.0);
      }
    `,
    glslVersion: THREE.GLSL3,
    side: THREE.DoubleSide,
  })
}

/** World-space (along, across, up) of one point on the lower half. */
interface LowerHalfAxes {
  /** Along the bar: world X for an X bar, world Z for a Y bar. */
  alongMin: number
  /** Convert local (along, across, up) into a world position. */
  toWorld(along: number, across: number, up: number): [number, number, number]
  /** Convert a local (along, across, up) normal into world space. */
  normalToWorld(nAlong: number, nAcross: number, nUp: number): [number, number, number]
}

function lowerHalfAxes(grid: SimulationGrid, descriptor: FlatRoundBarDescriptor): LowerHalfAxes {
  const { axis, pivot, centre } = descriptor
  if (axis === 'x') {
    return {
      alongMin: grid.originX,
      toWorld: (along, across, up) => [along, pivot + up, centre + across],
      normalToWorld: (nAlong, nAcross, nUp) => [nAlong, nUp, nAcross],
    }
  }
  return {
    alongMin: grid.originY,
    toWorld: (along, across, up) => [centre + across, pivot + up, along],
    normalToWorld: (nAlong, nAcross, nUp) => [nAcross, nUp, nAlong],
  }
}

/**
 * Build the static lower half of a round bar for a flat setup, or `null` when
 * this grid is not a flat round bar. The centreline sits at `pivot` (world Y)
 * and `centre` (across), the curved surface spans the lower semicircle of
 * `radius`, and the solid runs `length` along `axis` from the grid's own start.
 */
export function createFlatRoundBarLowerHalf(
  grid: SimulationGrid,
  flatRoundBar: FlatRoundBarDescriptor | undefined,
  stockColor: THREE.Color,
  radialSegments: number = FLAT_ROUND_BAR_RADIAL_SEGMENTS,
): THREE.Mesh | null {
  if (!flatRoundBar) return null

  const { radius, length } = flatRoundBar
  const { alongMin, toWorld, normalToWorld } = lowerHalfAxes(grid, flatRoundBar)
  const alongMax = alongMin + length
  const segments = Math.max(2, Math.round(radialSegments))
  const ringCount = segments + 1

  // Two rings (start/end) for the curved surface, plus a centre vertex and a
  // duplicate ring for each half-disc end cap.
  const sideVertexCount = ringCount * 2
  const capVertexCount = ringCount + 1
  const vertexCount = sideVertexCount + capVertexCount * 2
  const positions = new Float32Array(vertexCount * 3)
  const normals = new Float32Array(vertexCount * 3)
  const indices: number[] = []

  const write = (
    vertex: number,
    along: number,
    across: number,
    up: number,
    nAlong: number,
    nAcross: number,
    nUp: number,
  ): void => {
    const [x, y, z] = toWorld(along, across, up)
    positions[vertex * 3] = x
    positions[vertex * 3 + 1] = y
    positions[vertex * 3 + 2] = z
    const [nx, ny, nz] = normalToWorld(nAlong, nAcross, nUp)
    normals[vertex * 3] = nx
    normals[vertex * 3 + 1] = ny
    normals[vertex * 3 + 2] = nz
  }

  // Curved surface: theta from π to 2π sweeps the lower semicircle, so every
  // vertex is at or below the equator (`up <= 0`).
  for (let index = 0; index < ringCount; index += 1) {
    const theta = Math.PI + (Math.PI * index) / segments
    const cos = Math.cos(theta)
    const sin = Math.sin(theta)
    const across = radius * cos
    const up = radius * sin
    write(index * 2, alongMin, across, up, 0, cos, sin)
    write(index * 2 + 1, alongMax, across, up, 0, cos, sin)
  }
  for (let index = 0; index < segments; index += 1) {
    const base = index * 2
    // Winding is immaterial: the material is DoubleSide and lights the authored
    // outward normals, so an axis-Y bar cannot end up lit from the inside.
    indices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3)
  }

  // End caps: a half-disc of the same radius at each end, facing outwards.
  const startCentre = sideVertexCount
  write(startCentre, alongMin, 0, 0, -1, 0, 0)
  for (let index = 0; index < ringCount; index += 1) {
    const theta = Math.PI + (Math.PI * index) / segments
    write(startCentre + 1 + index, alongMin, radius * Math.cos(theta), radius * Math.sin(theta), -1, 0, 0)
    if (index < segments) {
      indices.push(startCentre, startCentre + 1 + index, startCentre + 2 + index)
    }
  }

  const endCentre = startCentre + capVertexCount
  write(endCentre, alongMax, 0, 0, 1, 0, 0)
  for (let index = 0; index < ringCount; index += 1) {
    const theta = Math.PI + (Math.PI * index) / segments
    write(endCentre + 1 + index, alongMax, radius * Math.cos(theta), radius * Math.sin(theta), 1, 0, 0)
    if (index < segments) {
      indices.push(endCentre, endCentre + 2 + index, endCentre + 1 + index)
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geometry.setIndex(indices)
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()

  const mesh = new THREE.Mesh(geometry, lowerHalfMaterial(stockColor, grid))
  mesh.name = FLAT_ROUND_BAR_LOWER_HALF_NAME
  mesh.userData.flatRoundBarLowerHalf = {
    axis: flatRoundBar.axis,
    pivot: flatRoundBar.pivot,
    radius,
    centre: flatRoundBar.centre,
    length,
  }
  return mesh
}
