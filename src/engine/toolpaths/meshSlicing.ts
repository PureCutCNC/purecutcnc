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

const Z_EPS = 1e-8
const PT_EPS = 1e-6

interface Vec3 { x: number; y: number; z: number }

interface SliceTriangle {
  p0: Vec3
  p1: Vec3
  p2: Vec3
  minZ: number
  maxZ: number
}

export interface MeshSliceIndex {
  triangles: SliceTriangle[]
  minZ: number
  maxZ: number
  bucketStep: number
  buckets: SliceTriangle[][]
  wideTriangles: SliceTriangle[]
  sliceCache: Map<number, Array<Array<[number, number]>>>
}

export interface MeshSliceIndexHost {
  positions: Float32Array
  index: Uint32Array
  sliceIndex?: MeshSliceIndex
}

function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t }
}

function edgeCrossZ(a: Vec3, b: Vec3, z: number): Vec3 | null {
  const dzA = a.z - z
  const dzB = b.z - z
  if (Math.abs(dzA) < Z_EPS) return a
  if (Math.abs(dzB) < Z_EPS) return b
  if (dzA * dzB > 0) return null
  const t = -dzA / (dzB - dzA)
  return lerp(a, b, t)
}

export function buildMeshSliceIndex(
  positions: Float32Array,
  index: Uint32Array,
): MeshSliceIndex {
  const triangles: SliceTriangle[] = []
  let minZ = Infinity
  let maxZ = -Infinity

  for (let i = 0; i < index.length; i += 3) {
    const i0 = index[i] * 3
    const i1 = index[i + 1] * 3
    const i2 = index[i + 2] * 3
    const p0 = { x: positions[i0], y: positions[i0 + 1], z: positions[i0 + 2] }
    const p1 = { x: positions[i1], y: positions[i1 + 1], z: positions[i1 + 2] }
    const p2 = { x: positions[i2], y: positions[i2 + 1], z: positions[i2 + 2] }

    const triMinZ = Math.min(p0.z, p1.z, p2.z)
    const triMaxZ = Math.max(p0.z, p1.z, p2.z)
    if (triMinZ < minZ) minZ = triMinZ
    if (triMaxZ > maxZ) maxZ = triMaxZ

    triangles.push({
      p0,
      p1,
      p2,
      minZ: triMinZ,
      maxZ: triMaxZ,
    })
  }

  if (!Number.isFinite(minZ) || !Number.isFinite(maxZ) || maxZ - minZ <= Z_EPS) {
    return {
      triangles,
      minZ,
      maxZ,
      bucketStep: 0,
      buckets: [],
      wideTriangles: triangles,
      sliceCache: new Map(),
    }
  }

  const bucketCount = Math.max(16, Math.min(256, Math.ceil(Math.sqrt(Math.max(1, triangles.length)))))
  const bucketStep = (maxZ - minZ) / bucketCount
  const buckets: SliceTriangle[][] = Array.from({ length: bucketCount }, () => [])
  const wideTriangles: SliceTriangle[] = []

  for (const triangle of triangles) {
    const start = Math.max(0, Math.min(bucketCount - 1, Math.floor((triangle.minZ - minZ) / bucketStep)))
    const end = Math.max(0, Math.min(bucketCount - 1, Math.floor((triangle.maxZ - minZ) / bucketStep)))

    // Tall/vertical triangles spanning many buckets are cheaper to keep in a
    // shared side list than duplicated into most buckets.
    if (end - start > bucketCount / 2) {
      wideTriangles.push(triangle)
      continue
    }

    for (let bucketIndex = start; bucketIndex <= end; bucketIndex += 1) {
      buckets[bucketIndex].push(triangle)
    }
  }

  return { triangles, minZ, maxZ, bucketStep, buckets, wideTriangles, sliceCache: new Map() }
}

export function getMeshSliceIndex(host: MeshSliceIndexHost): MeshSliceIndex {
  if (!host.sliceIndex) {
    host.sliceIndex = buildMeshSliceIndex(host.positions, host.index)
  }
  return host.sliceIndex
}

export function sliceMeshAtZ(
  mesh: MeshSliceIndex,
  z: number,
): Array<Array<[number, number]>> {
  const cacheKey = Math.round(z / Z_EPS)
  const cached = mesh.sliceCache.get(cacheKey)
  if (cached) return cached

  const segments: Array<[[number, number], [number, number]]> = []
  const bucketIndex = mesh.bucketStep > 0
    ? Math.max(0, Math.min(mesh.buckets.length - 1, Math.floor((z - mesh.minZ) / mesh.bucketStep)))
    : -1

  function appendSegments(candidates: SliceTriangle[]): void {
    for (const triangle of candidates) {
      if (z < triangle.minZ - Z_EPS || z > triangle.maxZ + Z_EPS) continue

      const { p0, p1, p2 } = triangle
      const dz0 = p0.z - z
      const dz1 = p1.z - z
      const dz2 = p2.z - z
      const above = (dz0 > Z_EPS ? 1 : 0) + (dz1 > Z_EPS ? 1 : 0) + (dz2 > Z_EPS ? 1 : 0)
      const below = (dz0 < -Z_EPS ? 1 : 0) + (dz1 < -Z_EPS ? 1 : 0) + (dz2 < -Z_EPS ? 1 : 0)
      if (above === 0 || below === 0) continue

      const pts: Array<[number, number]> = []
      const e01 = edgeCrossZ(p0, p1, z)
      if (e01) pts.push([e01.x, e01.y])
      const e12 = edgeCrossZ(p1, p2, z)
      if (e12) pts.push([e12.x, e12.y])
      const e20 = edgeCrossZ(p2, p0, z)
      if (e20) pts.push([e20.x, e20.y])

      if (pts.length >= 2) {
        segments.push([pts[0], pts[1]])
      }
    }
  }

  if (bucketIndex >= 0) {
    appendSegments(mesh.buckets[bucketIndex])
    appendSegments(mesh.wideTriangles)
  } else {
    appendSegments(mesh.triangles)
  }

  const polygons = chainSegments(segments)
  mesh.sliceCache.set(cacheKey, polygons)
  return polygons
}

function ptKey(x: number, y: number): string {
  return `${x.toFixed(6)},${y.toFixed(6)}`
}

function chainSegments(
  segments: Array<[[number, number], [number, number]]>,
): Array<Array<[number, number]>> {
  if (segments.length === 0) return []

  const graph = new Map<
    string,
    { pt: [number, number]; neighbors: Array<{ key: string; pt: [number, number] }> }
  >()

  function ensureNode(x: number, y: number): string {
    const key = ptKey(x, y)
    if (!graph.has(key)) {
      graph.set(key, { pt: [x, y], neighbors: [] })
    }
    return key
  }

  for (const [a, b] of segments) {
    const ka = ensureNode(a[0], a[1])
    const kb = ensureNode(b[0], b[1])
    graph.get(ka)!.neighbors.push({ key: kb, pt: b })
    graph.get(kb)!.neighbors.push({ key: ka, pt: a })
  }

  const visited = new Set<string>()
  const polygons: Array<Array<[number, number]>> = []

  for (const [startKey] of graph) {
    if (visited.has(startKey)) continue

    const poly: Array<[number, number]> = []
    let currentKey = startKey
    let prevKey: string | null = null

    while (true) {
      if (visited.has(currentKey)) break
      visited.add(currentKey)

      const node = graph.get(currentKey)!
      if (poly.length === 0) {
        poly.push(node.pt)
      }

      let next: { key: string; pt: [number, number] } | null = null
      for (const n of node.neighbors) {
        if (n.key !== prevKey) {
          next = n
          break
        }
      }
      if (!next) break
      if (next.key === startKey) break

      poly.push(next.pt)
      prevKey = currentKey
      currentKey = next.key
      if (poly.length > segments.length * 2) break
    }

    if (poly.length >= 3) {
      const first = poly[0]
      const last = poly[poly.length - 1]
      if (
        Math.abs(last[0] - first[0]) > PT_EPS ||
        Math.abs(last[1] - first[1]) > PT_EPS
      ) {
        poly.push(first)
      }
      polygons.push(poly)
    }
  }

  return polygons
}
