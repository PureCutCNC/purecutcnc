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

import type { Project, SketchFeature } from '../../types/project'
import { loadSTLTransformedGeometry, type STLTransformedData } from '../csg'

/** A transformed triangle mesh, and the caches the finish strategies hang on it. */
export interface FinishMesh {
  positions: Float32Array
  index: Uint32Array
  sliceIndex?: STLTransformedData['sliceIndex']
}

/**
 * The surface a 3D finish works on: every target model as one mesh (issue
 * #934). A lone target is handed back as its own geometry object, so its
 * output and the caches on it are exactly what they were.
 *
 * Models the operation does not target are deliberately not in it. Put in the
 * height map, the cutter would ride a neighbour's real surface, and every
 * strategy that steps between samples in a straight line (parallel links,
 * waterline's flat passes) would climb a neighbour's wall in one move and clip
 * its edge (#938). A neighbour keeps its outline keep-out instead, from its
 * top down.
 */
export interface FinishModelSurface {
  targets: SketchFeature[]
  mesh: FinishMesh
}

/** One mesh from `geometries`. */
function concatMeshes(geometries: STLTransformedData[]): FinishMesh {
  let vertexCount = 0
  let indexCount = 0
  for (const geometry of geometries) {
    vertexCount += geometry.positions.length / 3
    indexCount += geometry.index.length
  }
  const positions = new Float32Array(vertexCount * 3)
  const index = new Uint32Array(indexCount)
  let vertexOffset = 0
  let indexOffset = 0
  for (const geometry of geometries) {
    positions.set(geometry.positions, vertexOffset * 3)
    for (let i = 0; i < geometry.index.length; i += 1) index[indexOffset + i] = geometry.index[i] + vertexOffset
    vertexOffset += geometry.positions.length / 3
    indexOffset += geometry.index.length
  }
  return { positions, index }
}

/**
 * Joined meshes, so the height-map and slice caches the strategies hang on
 * them survive a regenerate. Keyed by the features and checked against the
 * geometry objects themselves: `loadSTLTransformedGeometry` hands back the same
 * object until a model changes, and a changed one misses.
 */
const joinedCache = new Map<string, { parts: STLTransformedData[]; mesh: FinishMesh }>()
const JOINED_CACHE_LIMIT = 8

/** The surface a finish over `targets` works on, or null when a mesh cannot be loaded. */
export function resolveFinishModelSurface(project: Project, targets: SketchFeature[]): FinishModelSurface | null {
  const parts: STLTransformedData[] = []
  for (const feature of targets) {
    const geometry = loadSTLTransformedGeometry(feature, project)
    if (!geometry) return null
    parts.push(geometry)
  }
  if (parts.length === 1) return { targets, mesh: parts[0] }

  const key = targets.map((feature) => feature.id).join(',')
  const cached = joinedCache.get(key)
  if (cached && cached.parts.length === parts.length && cached.parts.every((part, i) => part === parts[i])) {
    return { targets, mesh: cached.mesh }
  }
  const mesh = concatMeshes(parts)
  if (joinedCache.size >= JOINED_CACHE_LIMIT) {
    const oldest = joinedCache.keys().next().value
    if (oldest !== undefined) joinedCache.delete(oldest)
  }
  joinedCache.set(key, { parts, mesh })
  return { targets, mesh }
}
