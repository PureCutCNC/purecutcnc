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
 * The square-material render resource (issue #1016 C2-R2M): one bounded
 * `BufferGeometry` per angular chunk instead of a mesh per cell or interval.
 *
 * `squareMaterialGeometry.ts` builds the triangles; this module owns the Three
 * objects, the update policy, and the lifetime. The update contract is frozen:
 *
 *   - `undefined` dirtyRegion -> full reset/rebuild;
 *   - `null` -> explicitly unchanged, a no-op (object and geometry identities
 *     and the disposal counters are untouched);
 *   - a `DirtyRegion` -> rebuild the touched chunks plus their angular
 *     neighbours (their shared walls changed) and the periodic seam chunk;
 *   - a changed frame or topology -> full rebuild even with a region.
 *
 * The grid is read through the accepted `squareMaterialIntervals` accessor on
 * every rebuild, so an in-place `squareMaterial` map update is picked up
 * without swapping the grid or the map. No material state is read from `topZ`.
 *
 * The resource owns every geometry and the single shared material; the caller
 * must not dispose either. `dispose()` is idempotent and disposes each resource
 * exactly once.
 */

import * as THREE from 'three'
import {
  DEFAULT_SQUARE_ANGULAR_CELLS_PER_CHUNK,
  buildSquareMaterialChunk,
  resolveSquareMaterialLayout,
  squareMaterialChunkAngularRange,
  squareMaterialChunkCount,
  squareMaterialChunkIndicesForDirtyRegion,
  squareMaterialEnvelope,
  squareMaterialLayoutSignature,
} from './squareMaterialGeometry'
import type {
  SquareMaterialChunkBuffer,
  SquareMaterialGeometryOptions,
  SquareMaterialLayout,
} from './squareMaterialGeometry'
import type { DirtyRegion, SimulationGrid } from './types'

export interface SquareMaterialMeshOptions extends SquareMaterialGeometryOptions {
  /** Angular cells per BufferGeometry resource. Defaults to 8. */
  angularCellsPerChunk?: number
}

/** Structural resource counters; no timing is involved anywhere. */
export interface SquareMaterialMeshStats {
  chunkCount: number
  triangleCount: number
  geometriesCreated: number
  /** Cumulative geometries released (rebuild replacements and dispose). */
  geometryDisposals: number
  materialDisposals: number
}

export interface SquareMaterialMeshResource {
  /** The square-material group; turn/placement is attached by the caller. */
  object: THREE.Group
  /** Conservative render envelope, on the true pivot, corners included. */
  bounds: THREE.Box3
  stats: SquareMaterialMeshStats
  disposed: boolean
  update(grid: SimulationGrid, dirtyRegion?: DirtyRegion | null): void
  dispose(): void
}

/**
 * Build the square-material resource from an accepted square grid. `color` is
 * any Three color representation. Invalid input throws a `RangeError` before
 * allocating a resource.
 */
export function createSquareMaterialMesh(
  grid: SimulationGrid,
  color: THREE.ColorRepresentation,
  options: SquareMaterialMeshOptions,
): SquareMaterialMeshResource {
  if (!grid.squareBar) {
    throw new RangeError('square material mesh: grid has no squareBar descriptor')
  }
  const angularCellsPerChunk = Math.max(
    1,
    Math.floor(options.angularCellsPerChunk ?? DEFAULT_SQUARE_ANGULAR_CELLS_PER_CHUNK),
  )
  let layout: SquareMaterialLayout = resolveSquareMaterialLayout(grid, options)
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.85,
    metalness: 0.05,
    side: THREE.DoubleSide,
  })
  const group = new THREE.Group()
  group.name = 'squareMaterial'
  const meshes: THREE.Mesh[] = []
  const triangles: number[] = []
  const stats: SquareMaterialMeshStats = {
    chunkCount: 0,
    triangleCount: 0,
    geometriesCreated: 0,
    geometryDisposals: 0,
    materialDisposals: 0,
  }
  const bounds = new THREE.Box3()

  const refreshCounts = (): void => {
    let total = 0
    for (const count of triangles) total += count
    stats.triangleCount = total
    stats.chunkCount = meshes.length
  }

  const applyEnvelope = (): void => {
    const envelope = squareMaterialEnvelope(layout)
    bounds.min.set(envelope.min[0], envelope.min[1], envelope.min[2])
    bounds.max.set(envelope.max[0], envelope.max[1], envelope.max[2])
  }

  const releaseGeometry = (mesh: THREE.Mesh): void => {
    mesh.geometry.dispose()
    stats.geometryDisposals += 1
  }

  const rebuildAll = (source: SimulationGrid): void => {
    layout = resolveSquareMaterialLayout(source, options)
    for (const mesh of meshes) releaseGeometry(mesh)
    group.clear()
    meshes.length = 0
    triangles.length = 0
    const chunkCount = squareMaterialChunkCount(layout, angularCellsPerChunk)
    for (let c = 0; c < chunkCount; c += 1) {
      const [start, end] = squareMaterialChunkAngularRange(layout, angularCellsPerChunk, c)
      const buffer = buildSquareMaterialChunk(source, layout, options, start, end)
      const mesh = new THREE.Mesh(bufferToGeometry(buffer), material)
      mesh.name = `squareMaterial-chunk-${c}`
      meshes.push(mesh)
      triangles.push(buffer.triangleCount)
      stats.geometriesCreated += 1
      group.add(mesh)
    }
    refreshCounts()
    applyEnvelope()
  }

  const rebuildChunk = (source: SimulationGrid, chunkIndex: number): void => {
    const mesh = meshes[chunkIndex]
    if (!mesh) return
    releaseGeometry(mesh)
    const [start, end] = squareMaterialChunkAngularRange(layout, angularCellsPerChunk, chunkIndex)
    const buffer = buildSquareMaterialChunk(source, layout, options, start, end)
    mesh.geometry = bufferToGeometry(buffer)
    triangles[chunkIndex] = buffer.triangleCount
    stats.geometriesCreated += 1
    refreshCounts()
  }

  const resource: SquareMaterialMeshResource = {
    object: group,
    bounds,
    stats,
    disposed: false,
    update(source: SimulationGrid, dirtyRegion?: DirtyRegion | null): void {
      if (resource.disposed) {
        throw new RangeError('square material mesh: update() called after dispose()')
      }
      if (dirtyRegion === null) return
      const signature = squareMaterialLayoutSignature(source, options)
      const chunkCount = squareMaterialChunkCount(layout, angularCellsPerChunk)
      if (dirtyRegion === undefined || signature !== layout.signature || chunkCount !== meshes.length) {
        rebuildAll(source)
        return
      }
      const indices = squareMaterialChunkIndicesForDirtyRegion(layout, angularCellsPerChunk, dirtyRegion)
      for (const chunkIndex of indices) rebuildChunk(source, chunkIndex)
    },
    dispose(): void {
      if (resource.disposed) return
      for (const mesh of meshes) releaseGeometry(mesh)
      material.dispose()
      stats.materialDisposals += 1
      group.clear()
      meshes.length = 0
      triangles.length = 0
      refreshCounts()
      resource.disposed = true
    },
  }

  rebuildAll(grid)
  return resource
}

function bufferToGeometry(buffer: SquareMaterialChunkBuffer): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(buffer.positions, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(buffer.normals, 3))
  if (buffer.triangleCount > 0) {
    geometry.boundingBox = new THREE.Box3(
      new THREE.Vector3(buffer.min[0], buffer.min[1], buffer.min[2]),
      new THREE.Vector3(buffer.max[0], buffer.max[1], buffer.max[2]),
    )
    geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere())
  } else {
    geometry.boundingBox = new THREE.Box3()
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0)
  }
  return geometry
}
