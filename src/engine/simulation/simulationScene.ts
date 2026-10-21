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
 * One simulation grid's complete renderable stock scene (issue #1049).
 *
 * The static view and the playback view draw exactly the same three pieces —
 * the heightfield surface, the instanced boundary walls and, for a flat round
 * bar, the fixed lower half below the equator — so both mount them through
 * this one builder. That is what keeps a round-bar scene from losing its lower
 * half in one path while keeping it in the other: a caller cannot forget a
 * piece the builder mounted, and the lower half is in the same group as the
 * surfaces it belongs to.
 *
 * The group owns its children only; the caller owns the group and the returned
 * heightfield texture, and disposes them with the grid.
 */

import * as THREE from 'three'
import type { AroundFrame } from '../aroundFrame'
import { createFlatRoundBarLowerHalf } from './flatRoundBarLowerHalf'
import { createHeightfieldTexture, createStockPlaneGeometries } from './gpuMesh'
import { createHeightfieldMaterial } from './heightfieldShader'
import { createInstancedBoundaryGroup } from './instancedBoundary'
import type { FlatRoundBarDescriptor, SimulationGrid } from './types'

/** Everything one simulation scene mounts, so a caller cannot drop a piece. */
export interface SimulationStockScene {
  /** The complete scene group: surface, walls and, for a round bar, the lower half. */
  group: THREE.Group
  /** The heightfield top surface, used for framing and world-space bounds. */
  surface: THREE.Object3D
  /** The instanced boundary group (two wall strips, plus the floor for a flat stock). */
  boundary: THREE.Object3D
  /** The static lower half of a flat round bar, already mounted, or null. */
  lowerHalf: THREE.Mesh | null
  /** The grid's height texture; dispose it with the scene. */
  heightfieldTexture: THREE.DataTexture
}

function buildHeightfieldSurfaceObject(
  grid: SimulationGrid,
  material: THREE.Material,
  frame?: AroundFrame,
): THREE.Object3D {
  const geometries = createStockPlaneGeometries(grid, frame)
  if (geometries.length === 1) {
    return new THREE.Mesh(geometries[0], material)
  }

  const group = new THREE.Group()
  for (const geometry of geometries) {
    group.add(new THREE.Mesh(geometry, material))
  }
  return group
}

/**
 * Build and mount the complete stock scene for one grid. Passing a flat
 * round-bar descriptor adds the static lower half and removes the flat
 * underside (the lower half is the bar's underside); no descriptor builds the
 * block, square-blank or Around scene exactly as before.
 */
export function buildSimulationStockScene(
  grid: SimulationGrid,
  stockColor: THREE.Color,
  frame?: AroundFrame,
  flatRoundBar?: FlatRoundBarDescriptor,
): SimulationStockScene {
  const heightfieldTexture = createHeightfieldTexture(grid)
  const material = createHeightfieldMaterial(heightfieldTexture, grid, stockColor, frame, flatRoundBar)
  const surface = buildHeightfieldSurfaceObject(grid, material, frame)
  const boundary = createInstancedBoundaryGroup(
    heightfieldTexture,
    grid,
    stockColor,
    frame,
    flatRoundBar?.pivot,
    flatRoundBar,
  )
  const lowerHalf = createFlatRoundBarLowerHalf(grid, flatRoundBar, stockColor)

  const group = new THREE.Group()
  group.name = 'simulationStock'
  group.add(surface)
  group.add(boundary)
  if (lowerHalf) group.add(lowerHalf)

  return { group, surface, boundary, lowerHalf, heightfieldTexture }
}
