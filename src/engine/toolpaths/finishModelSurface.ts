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
 * top down. An around-the-bar rotary operation is the one exception, and it
 * does not join them here: it samples its neighbour models through
 * `resolveRotaryNeighbourMesh` and hands them to the rotary generator apart
 * from the target surface (#1155).
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
 *
 * The key always carries two segments, `targets|neighbours`, so a target-only
 * mesh and a mesh an around operation joined from neighbour models can never
 * share an entry (#1155): they differ in the list their ids came from even
 * when one list is empty, and the ids of one set are never in the other.
 */
const joinedCache = new Map<string, { parts: STLTransformedData[]; mesh: FinishMesh }>()
const JOINED_CACHE_LIMIT = 8

/** The loaded geometry of `features`, or null when one cannot be loaded. */
function loadGeometries(project: Project, features: readonly SketchFeature[]): STLTransformedData[] | null {
  const parts: STLTransformedData[] = []
  for (const feature of features) {
    const geometry = loadSTLTransformedGeometry(feature, project)
    if (!geometry) return null
    parts.push(geometry)
  }
  return parts
}

/**
 * The one mesh for `parts`, or the lone part's own geometry object. `key` names
 * the set the parts came from; `parts.length === 1` needs no entry because the
 * geometry object already carries the caches (and its identity is the cache).
 */
function joinedMesh(key: string, parts: STLTransformedData[]): FinishMesh {
  if (parts.length === 1) return parts[0]
  const cached = joinedCache.get(key)
  if (cached && cached.parts.length === parts.length && cached.parts.every((part, i) => part === parts[i])) {
    return cached.mesh
  }
  const mesh = concatMeshes(parts)
  if (joinedCache.size >= JOINED_CACHE_LIMIT) {
    const oldest = joinedCache.keys().next().value
    if (oldest !== undefined) joinedCache.delete(oldest)
  }
  joinedCache.set(key, { parts, mesh })
  return mesh
}

/** The surface a finish over `targets` works on, or null when a mesh cannot be loaded. */
export function resolveFinishModelSurface(project: Project, targets: SketchFeature[]): FinishModelSurface | null {
  const parts = loadGeometries(project, targets)
  if (!parts) return null
  const key = `${targets.map((feature) => feature.id).join(',')}|`
  return { targets, mesh: joinedMesh(key, parts) }
}

/**
 * The neighbour models an around-the-bar rotary operation must not cut into,
 * sampled as one mesh (#1155).
 *
 * It is deliberately a **separate** mesh from the target surface: the rotary
 * generator joins it after the target and before the retained bar stubs, so
 * the operation's along range, its `rotaryModelOutsideBar` warning and the
 * models the preceding-rough advisory names all stay the target's. The cache
 * key names the neighbour set in the key's second segment, which is what keeps
 * these entries apart from a target-only joined surface even if the same model
 * is one operation's target and another's neighbour.
 *
 * Null when there is no neighbour, or when one of them has no loadable mesh --
 * a model the sampler cannot sample is not material it can protect.
 */
export function resolveRotaryNeighbourMesh(
  project: Project,
  neighbours: SketchFeature[],
): FinishMesh | null {
  if (neighbours.length === 0) return null
  const parts = loadGeometries(project, neighbours)
  if (!parts) return null
  return joinedMesh(`|${neighbours.map((feature) => feature.id).join(',')}`, parts)
}
