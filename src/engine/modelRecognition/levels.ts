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
 * Candidate levels for model recognition (issue #1206).
 *
 * A prismatic cavity can only start or stop at a height where the mesh has an
 * edge: the Z of a horizontal face (a floor, a step, the top), or the Z where a
 * vertical wall begins or ends (the start of a chamfer, of a drill-point cone,
 * of a floor fillet). Between two neighbouring levels every wall is therefore
 * either vertical all the way or not vertical at all, and one section near
 * each end of the slab is enough to tell which.
 *
 * Levels come from triangle normals, not from every vertex Z, so a relief or a
 * sculpted surface does not turn into thousands of levels. They are still
 * capped; see `MAX_LEVELS`.
 */

import type { Point } from '../../types/project'
import type { RecognitionMesh } from './types'

/** |unit normal Z| at or above this is a horizontal face (within about 0.26 degrees). */
const HORIZONTAL_NORMAL_Z = 0.99999
/** |unit normal Z| at or below this is a vertical wall (within about 0.29 degrees). */
const VERTICAL_NORMAL_Z = 0.005
/**
 * Most levels examined. Each costs two mesh sections, and a part with real
 * prismatic features has a few dozen at most.
 */
export const MAX_LEVELS = 192

/** Neighbouring levels closer than this many `zTol` are one level. */
const MIN_LEVEL_SPACING_TOLERANCES = 10

export interface MeshBounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
  minZ: number
  maxZ: number
}

export interface LevelPlan {
  /** Ascending. The first is the mesh's lowest Z and the last its highest. */
  levels: number[]
  truncated: boolean
}

export function meshBounds(mesh: RecognitionMesh): MeshBounds {
  const bounds: MeshBounds = {
    minX: Infinity, maxX: -Infinity,
    minY: Infinity, maxY: -Infinity,
    minZ: Infinity, maxZ: -Infinity,
  }
  const { positions } = mesh
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i]
    const y = positions[i + 1]
    const z = positions[i + 2]
    if (x < bounds.minX) bounds.minX = x
    if (x > bounds.maxX) bounds.maxX = x
    if (y < bounds.minY) bounds.minY = y
    if (y > bounds.maxY) bounds.maxY = y
    if (z < bounds.minZ) bounds.minZ = z
    if (z > bounds.maxZ) bounds.maxZ = z
  }
  return bounds
}

interface WeightedZ {
  z: number
  weight: number
}

/** Calls `visit` with each triangle's corners, unit-normal Z and area. */
function forEachTriangle(
  mesh: RecognitionMesh,
  visit: (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    normalZ: number, area: number,
  ) => void,
): void {
  const { positions, index } = mesh
  for (let i = 0; i + 2 < index.length; i += 3) {
    const a = index[i] * 3
    const b = index[i + 1] * 3
    const c = index[i + 2] * 3
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2]
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2]
    const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2]
    const ux = bx - ax, uy = by - ay, uz = bz - az
    const vx = cx - ax, vy = cy - ay, vz = cz - az
    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx
    const length = Math.hypot(nx, ny, nz)
    if (!(length > 0)) continue
    visit(ax, ay, az, bx, by, bz, cx, cy, cz, nz / length, length / 2)
  }
}

/**
 * Merges samples that fall within `zTol` of a cluster's first sample. Fixed
 * windows, not chaining: a run of closely spaced samples must not collapse
 * into one level a long way from its ends.
 */
function clusterByZ(samples: WeightedZ[], zTol: number): WeightedZ[] {
  const sorted = [...samples].sort((a, b) => a.z - b.z)
  const clusters: WeightedZ[] = []
  let start = Number.NEGATIVE_INFINITY
  let sumZ = 0
  let sumWeight = 0
  const flush = (): void => {
    if (sumWeight > 0) clusters.push({ z: sumZ / sumWeight, weight: sumWeight })
    sumZ = 0
    sumWeight = 0
  }
  for (const sample of sorted) {
    if (sample.z - start > zTol) {
      flush()
      start = sample.z
    }
    sumZ += sample.z * sample.weight
    sumWeight += sample.weight
  }
  flush()
  return clusters
}

export function collectLevels(mesh: RecognitionMesh, bounds: MeshBounds, zTol: number): LevelPlan {
  const samples: WeightedZ[] = []
  forEachTriangle(mesh, (_ax, _ay, az, _bx, _by, bz, _cx, _cy, cz, normalZ, area) => {
    const steepness = Math.abs(normalZ)
    if (steepness >= HORIZONTAL_NORMAL_Z) {
      samples.push({ z: (az + bz + cz) / 3, weight: area })
    } else if (steepness <= VERTICAL_NORMAL_Z) {
      const share = area / 3
      samples.push({ z: az, weight: share }, { z: bz, weight: share }, { z: cz, weight: share })
    }
  })

  const spacing = zTol * MIN_LEVEL_SPACING_TOLERANCES
  const interior = clusterByZ(samples, zTol)
    .filter((level) => level.z - bounds.minZ > spacing && bounds.maxZ - level.z > spacing)

  // Two levels closer than the spacing cannot hold a slab between them; the
  // one carrying more surface wins.
  const spaced: WeightedZ[] = []
  for (const level of interior) {
    const previous = spaced[spaced.length - 1]
    if (previous && level.z - previous.z <= spacing) {
      if (level.weight > previous.weight) spaced[spaced.length - 1] = level
      continue
    }
    spaced.push(level)
  }

  const room = MAX_LEVELS - 2
  const truncated = spaced.length > room
  const kept = truncated
    ? [...spaced].sort((a, b) => b.weight - a.weight).slice(0, room)
    : spaced

  const levels = [bounds.minZ, ...kept.map((level) => level.z).sort((a, b) => a - b), bounds.maxZ]
  return { levels, truncated }
}

/**
 * The upward-facing flat triangles at each level, in plan. These are the
 * floors: what a cavity's straight walls can stand on.
 */
export function collectFloorTriangles(
  mesh: RecognitionMesh,
  levels: readonly number[],
  zTol: number,
): Point[][][] {
  const floors: Point[][][] = levels.map(() => [])
  forEachTriangle(mesh, (ax, ay, az, bx, by, bz, cx, cy, cz, normalZ) => {
    if (normalZ < HORIZONTAL_NORMAL_Z) return
    const z = (az + bz + cz) / 3
    const levelIndex = nearestLevelIndex(levels, z)
    if (Math.abs(levels[levelIndex] - z) > zTol * 2) return
    floors[levelIndex].push([{ x: ax, y: ay }, { x: bx, y: by }, { x: cx, y: cy }])
  })
  return floors
}

function nearestLevelIndex(levels: readonly number[], z: number): number {
  let low = 0
  let high = levels.length - 1
  while (high - low > 1) {
    const mid = (low + high) >> 1
    if (levels[mid] <= z) low = mid
    else high = mid
  }
  return Math.abs(levels[low] - z) <= Math.abs(levels[high] - z) ? low : high
}
