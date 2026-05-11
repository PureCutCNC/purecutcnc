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
const STITCH_TOLERANCE_SCALE = 1e-5

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
  sliceCache: Map<number, MeshSliceResult>
}

export interface MeshSliceIndexHost {
  positions: Float32Array
  index: Uint32Array
  sliceIndex?: MeshSliceIndex
}

export interface MeshSliceResult {
  polygons: Array<Array<[number, number]>>
  segmentCount: number
  openChainCount: number
}

interface SliceSegment {
  a: Vec3
  b: Vec3
}

interface SegmentEdge {
  a: string
  b: string
  visited: boolean
}

interface SegmentNode {
  key: string
  pt: Vec3
  edges: number[]
}

interface SegmentChain {
  points: Vec3[]
  closed: boolean
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
  return sliceMeshAtZDetailed(mesh, z).polygons
}

export function sliceMeshAtZDetailed(
  mesh: MeshSliceIndex,
  z: number,
): MeshSliceResult {
  const cacheKey = Math.round(z / Z_EPS)
  const cached = mesh.sliceCache.get(cacheKey)
  if (cached) return cached

  const segments: SliceSegment[] = []
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

      const pts: Vec3[] = []
      const e01 = edgeCrossZ(p0, p1, z)
      if (e01) pts.push(e01)
      const e12 = edgeCrossZ(p1, p2, z)
      if (e12) pts.push(e12)
      const e20 = edgeCrossZ(p2, p0, z)
      if (e20) pts.push(e20)

      if (pts.length >= 2) {
        segments.push({ a: pts[0], b: pts[1] })
      }
    }
  }

  if (bucketIndex >= 0) {
    appendSegments(mesh.buckets[bucketIndex])
    appendSegments(mesh.wideTriangles)
  } else {
    appendSegments(mesh.triangles)
  }

  const result = chainSegments(segments)
  mesh.sliceCache.set(cacheKey, result)
  return result
}

function ptKey(point: Vec3): string {
  return `${point.x.toFixed(6)},${point.y.toFixed(6)},${point.z.toFixed(6)}`
}

function distance3D(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function computeStitchTolerance(segments: SliceSegment[]): number {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity

  for (const segment of segments) {
    for (const point of [segment.a, segment.b]) {
      minX = Math.min(minX, point.x)
      maxX = Math.max(maxX, point.x)
      minY = Math.min(minY, point.y)
      maxY = Math.max(maxY, point.y)
      minZ = Math.min(minZ, point.z)
      maxZ = Math.max(maxZ, point.z)
    }
  }

  const diagonal = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ)
  return Math.max(diagonal * STITCH_TOLERANCE_SCALE, PT_EPS * 2)
}

function closeChain(points: Vec3[]): Vec3[] {
  const first = points[0]
  const last = points[points.length - 1]
  if (distance3D(first, last) <= PT_EPS) {
    return [...points.slice(0, -1), first]
  }
  return [...points, first]
}

function chainToPolygon(chain: SegmentChain): Array<[number, number]> | null {
  if (!chain.closed || chain.points.length < 3) return null
  return closeChain(chain.points).map((point) => [point.x, point.y])
}

function otherEdgeNode(edge: SegmentEdge, key: string): string {
  return edge.a === key ? edge.b : edge.a
}

function chooseStartNode(nodes: Map<string, SegmentNode>, edge: SegmentEdge): string {
  const aDegree = nodes.get(edge.a)?.edges.length ?? 0
  const bDegree = nodes.get(edge.b)?.edges.length ?? 0
  if (aDegree !== 2) return edge.a
  if (bDegree !== 2) return edge.b
  return edge.a
}

interface StitchCandidate {
  aIndex: number
  bIndex: number
  distance: number
  aEnd: 'start' | 'end'
  bEnd: 'start' | 'end'
}

function endpoint(points: Vec3[], end: 'start' | 'end'): Vec3 {
  return end === 'start' ? points[0] : points[points.length - 1]
}

function mergeChainPair(a: Vec3[], b: Vec3[], aEnd: 'start' | 'end', bEnd: 'start' | 'end'): Vec3[] {
  if (aEnd === 'end' && bEnd === 'start') return [...a, ...b]
  if (aEnd === 'end' && bEnd === 'end') return [...a, ...b.slice().reverse()]
  if (aEnd === 'start' && bEnd === 'start') return [...a.slice().reverse(), ...b]
  return [...b, ...a]
}

function findBestStitchCandidate(chains: SegmentChain[], stitchTolerance: number): StitchCandidate | null {
  let best: StitchCandidate | null = null

  function consider(candidate: StitchCandidate): void {
    if (candidate.distance > stitchTolerance) return
    if (!best || candidate.distance < best.distance) {
      best = candidate
    }
  }

  for (let i = 0; i < chains.length; i += 1) {
    if (chains[i].closed) continue
    const a = chains[i].points
    if (a.length < 2) continue

    const selfDistance = distance3D(endpoint(a, 'start'), endpoint(a, 'end'))
    consider({ aIndex: i, bIndex: i, distance: selfDistance, aEnd: 'start', bEnd: 'end' })

    for (let j = i + 1; j < chains.length; j += 1) {
      if (chains[j].closed) continue
      const b = chains[j].points
      if (b.length < 2) continue

      for (const aEnd of ['start', 'end'] as const) {
        for (const bEnd of ['start', 'end'] as const) {
          consider({
            aIndex: i,
            bIndex: j,
            distance: distance3D(endpoint(a, aEnd), endpoint(b, bEnd)),
            aEnd,
            bEnd,
          })
        }
      }
    }
  }

  return best
}

function stitchOpenChains(chains: SegmentChain[], stitchTolerance: number): SegmentChain[] {
  const stitched = chains.map((chain) => ({ points: [...chain.points], closed: chain.closed }))

  while (true) {
    const candidate = findBestStitchCandidate(stitched, stitchTolerance)
    if (!candidate) break

    const a = stitched[candidate.aIndex]
    if (candidate.aIndex === candidate.bIndex) {
      a.closed = true
      a.points = closeChain(a.points).slice(0, -1)
      continue
    }

    const b = stitched[candidate.bIndex]
    const mergedPoints = mergeChainPair(a.points, b.points, candidate.aEnd, candidate.bEnd)
    const closed = distance3D(mergedPoints[0], mergedPoints[mergedPoints.length - 1]) <= stitchTolerance
    const merged: SegmentChain = {
      points: closed ? closeChain(mergedPoints).slice(0, -1) : mergedPoints,
      closed,
    }

    stitched[candidate.aIndex] = merged
    stitched.splice(candidate.bIndex, 1)
  }

  return stitched
}

function chainSegments(
  segments: SliceSegment[],
): MeshSliceResult {
  if (segments.length === 0) return { polygons: [], segmentCount: 0, openChainCount: 0 }

  const nodes = new Map<string, SegmentNode>()
  const edges: SegmentEdge[] = []

  function ensureNode(point: Vec3): string {
    const key = ptKey(point)
    if (!nodes.has(key)) {
      nodes.set(key, { key, pt: point, edges: [] })
    }
    return key
  }

  for (const segment of segments) {
    const a = ensureNode(segment.a)
    const b = ensureNode(segment.b)
    if (a === b) continue
    const edgeIndex = edges.length
    edges.push({ a, b, visited: false })
    nodes.get(a)!.edges.push(edgeIndex)
    nodes.get(b)!.edges.push(edgeIndex)
  }

  const chains: SegmentChain[] = []
  for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex += 1) {
    const firstEdge = edges[edgeIndex]
    if (firstEdge.visited) continue

    const startKey = chooseStartNode(nodes, firstEdge)
    let currentKey = startKey
    let prevKey: string | null = null
    const points: Vec3[] = [nodes.get(startKey)!.pt]

    while (true) {
      const node = nodes.get(currentKey)!
      let nextEdgeIndex: number | null = null
      for (const candidateEdgeIndex of node.edges) {
        const candidateEdge = edges[candidateEdgeIndex]
        if (candidateEdge.visited) continue
        const nextKey = otherEdgeNode(candidateEdge, currentKey)
        if (nextKey !== prevKey || node.edges.every((index) => edges[index].visited || index === candidateEdgeIndex)) {
          nextEdgeIndex = candidateEdgeIndex
          break
        }
      }

      if (nextEdgeIndex === null) break

      const edge = edges[nextEdgeIndex]
      edge.visited = true
      const nextKey = otherEdgeNode(edge, currentKey)
      if (nextKey === startKey) {
        chains.push({ points, closed: true })
        break
      }

      points.push(nodes.get(nextKey)!.pt)
      prevKey = currentKey
      currentKey = nextKey
      if (points.length > segments.length * 2) break
    }

    if (!chains.at(-1)?.closed || chains.at(-1)?.points !== points) {
      chains.push({ points, closed: false })
    }
  }

  const stitchTolerance = computeStitchTolerance(segments)
  const stitchedChains = stitchOpenChains(chains, stitchTolerance)
  const polygons = stitchedChains
    .map(chainToPolygon)
    .filter((polygon): polygon is Array<[number, number]> => polygon !== null)
  const openChainCount = stitchedChains.filter((chain) => !chain.closed).length

  return { polygons, segmentCount: segments.length, openChainCount }
}
