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

// A closed loop of tool-centre points with its bounds and a row-bucketed edge
// index (issue #923), for the S-link and XY-lead domain gates in
// `tangentLink.ts`.
//
// Those gates sample every candidate path at a fine chord budget and test each
// sample against the domain loops. A loop traced from a mesh silhouette has
// thousands of vertices, and walking all of them per sample dominated 3D
// roughing. The two tests below give the answers the full walks gave, from
// only the edges that can affect them:
//
// - The ray-cast toggles on an edge only when `(yi > y) !== (yj > y)`, which
//   needs the edge's closed Y range to contain `y`. Parity does not depend on
//   the order edges are visited in, so the edges of the one bucket holding `y`
//   give the same parity.
// - The on-edge test accepts a point within 1e-6 of an edge, so only edges
//   whose Y range comes within that distance of `y` can accept it. The buckets
//   searched are widened by twice that, which absorbs the rounding of the
//   clamped projection; widening only adds edges, and an added edge returns
//   exactly what it returned in the full walk.
//
// Every edge keeps the vertex pairing and the arithmetic of the original loops
// (`i` and its predecessor `j`), so each per-edge verdict is bit-for-bit the
// one the walk computed.

import type { Point } from '../../types/project'

let edgesScanned = 0

/** Read the edges-scanned probe counter. Cost assertions count work, never wall clocks. */
export function boxedLoopEdgesScanned(): number {
  return edgesScanned
}

/** Reset the edges-scanned probe counter. Tests call this before measuring. */
export function resetBoxedLoopEdgesScanned(): void {
  edgesScanned = 0
}

export interface BoxedLoop {
  points: Point[]
  minX: number
  maxX: number
  minY: number
  maxY: number
  /** Edge k joins point `k` (ix, iy) and its predecessor (jx, jy). */
  ix: Float64Array
  iy: Float64Array
  jx: Float64Array
  jy: Float64Array
  bucketCount: number
  bucketScale: number
  /** CSR layout: the edges of bucket b are `bucketEdges[bucketStart[b] .. bucketStart[b + 1])`. */
  bucketStart: Int32Array
  bucketEdges: Int32Array
}

const EDGES_PER_BUCKET = 4
const MAX_BUCKETS = 1 << 14
// The on-edge test's squared tolerance is 1e-12, i.e. 1e-6 in distance.
const ON_EDGE_SEARCH = 2e-6

/** Bounds and the edge index, computed once so each sample reads a few edges. */
export function boxLoop(points: Point[]): BoxedLoop {
  const count = points.length
  const ix = new Float64Array(count)
  const iy = new Float64Array(count)
  const jx = new Float64Array(count)
  const jy = new Float64Array(count)
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (let k = 0; k < count; k += 1) {
    const p = points[k]
    const q = points[(k + count - 1) % count]
    ix[k] = p.x
    iy[k] = p.y
    jx[k] = q.x
    jy[k] = q.y
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  const bucketCount = count === 0 || !(maxY > minY)
    ? 1
    : Math.min(MAX_BUCKETS, Math.max(1, Math.ceil(count / EDGES_PER_BUCKET)))
  const bucketScale = maxY > minY ? bucketCount / (maxY - minY) : 0
  const loop: BoxedLoop = {
    points, minX, maxX, minY, maxY, ix, iy, jx, jy, bucketCount, bucketScale,
    bucketStart: new Int32Array(bucketCount + 1),
    bucketEdges: new Int32Array(0),
  }
  const first = new Int32Array(count)
  const last = new Int32Array(count)
  for (let k = 0; k < count; k += 1) {
    first[k] = bucketOf(loop, Math.min(iy[k], jy[k]))
    last[k] = bucketOf(loop, Math.max(iy[k], jy[k]))
    for (let b = first[k]; b <= last[k]; b += 1) loop.bucketStart[b + 1] += 1
  }
  for (let b = 0; b < bucketCount; b += 1) loop.bucketStart[b + 1] += loop.bucketStart[b]
  loop.bucketEdges = new Int32Array(loop.bucketStart[bucketCount])
  const fill = loop.bucketStart.slice(0, bucketCount)
  for (let k = 0; k < count; k += 1) {
    for (let b = first[k]; b <= last[k]; b += 1) {
      loop.bucketEdges[fill[b]] = k
      fill[b] += 1
    }
  }
  return loop
}

/** Monotone in `y`, clamped to the index. */
function bucketOf(loop: Pick<BoxedLoop, 'minY' | 'bucketCount' | 'bucketScale'>, y: number): number {
  const bucket = Math.floor((y - loop.minY) * loop.bucketScale)
  return bucket < 0 ? 0 : bucket >= loop.bucketCount ? loop.bucketCount - 1 : bucket
}

/** Even-odd ray cast: is the point strictly inside the loop (boundary undecided)? */
export function pointInBoxedLoop(loop: BoxedLoop, x: number, y: number): boolean {
  // Outside the Y range no edge straddles `y`, so the walk never toggles.
  if (!(y >= loop.minY && y <= loop.maxY)) return false
  const bucket = bucketOf(loop, y)
  const end = loop.bucketStart[bucket + 1]
  let inside = false
  for (let slot = loop.bucketStart[bucket]; slot < end; slot += 1) {
    edgesScanned += 1
    const k = loop.bucketEdges[slot]
    const xi = loop.ix[k]
    const yi = loop.iy[k]
    const xj = loop.jx[k]
    const yj = loop.jy[k]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

/** Is the point on an edge of the loop, within float dust? The ring paths are
 *  cut exactly ON the domain boundary (the wall-adjacent ring IS the domain
 *  polygon, the island rings ride the island expansions), so boundary points
 *  are legitimate and the ray-cast's parity must not decide them. */
export function pointOnBoxedLoopEdge(loop: BoxedLoop, x: number, y: number): boolean {
  if (loop.ix.length === 0) return false
  const low = y - ON_EDGE_SEARCH
  const high = y + ON_EDGE_SEARCH
  if (high < loop.minY || low > loop.maxY) return false
  const firstBucket = bucketOf(loop, low)
  const lastBucket = bucketOf(loop, high)
  const end = loop.bucketStart[lastBucket + 1]
  for (let slot = loop.bucketStart[firstBucket]; slot < end; slot += 1) {
    edgesScanned += 1
    const k = loop.bucketEdges[slot]
    const ax = loop.ix[k]
    const ay = loop.iy[k]
    const bx = loop.jx[k]
    const by = loop.jy[k]
    const dx = bx - ax
    const dy = by - ay
    const lenSq = dx * dx + dy * dy
    if (lenSq <= 1e-18) continue
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lenSq))
    const qx = ax + dx * t - x
    const qy = ay + dy * t - y
    if (qx * qx + qy * qy <= 1e-12) return true
  }
  return false
}
