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

// Row-bucketed edge index for one closed Clipper path (issue #922).
//
// `ClipperLib.Clipper.PointInPolygon` walks every edge of the path. A domain
// traced from a mesh silhouette has thousands of edges and the finish
// strategies query it once per densified contour point, so the walk dominated
// constant-scallop generation. This index answers the SAME question from only
// the edges whose Y span can matter:
//
// - An edge affects Clipper's answer only when its closed Y range contains the
//   query Y: the on-boundary test needs `ipNext.Y === pt.Y`, the crossing test
//   needs the edge to straddle `pt.Y`. Every other edge is a no-op.
// - Clipper returns -1 at the FIRST on-boundary edge it meets, and otherwise
//   the parity of the crossings. Both are independent of edge order, so
//   visiting a subset in bucket order gives the identical result.
//
// Each edge is registered in every row bucket its Y range touches, so the one
// bucket holding the query Y contains every edge that can affect it. The
// per-edge arithmetic below is Clipper's, copied verbatim, so the result is
// the same number Clipper returns — including -1 — not merely the same
// inside/outside verdict. `clipperPathIndex.test.ts` pins that differentially.

import type { ClipperPath } from './types'

let edgesScanned = 0
let pointQueries = 0

/** Read the index probe counters. Cost assertions count work, never wall clocks. */
export function clipperPathIndexProbeCounts(): { edgesScanned: number; pointQueries: number } {
  return { edgesScanned, pointQueries }
}

/** Reset the index probe counters. Tests call this before measuring. */
export function resetClipperPathIndexProbeCounts(): void {
  edgesScanned = 0
  pointQueries = 0
}

export interface IndexedClipperPath {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
  /** Edge i runs from (fromX[i], fromY[i]) to (toX[i], toY[i]), in path order. */
  readonly fromX: Float64Array
  readonly fromY: Float64Array
  readonly toX: Float64Array
  readonly toY: Float64Array
  readonly bucketCount: number
  readonly bucketScale: number
  /** CSR layout: the edges of bucket b are `bucketEdges[bucketStart[b] .. bucketStart[b + 1])`. */
  readonly bucketStart: Int32Array
  readonly bucketEdges: Int32Array
}

// Roughly four edges per row keeps a bucket short on a smooth outline while
// bounding the index size on a jagged one.
const EDGES_PER_BUCKET = 4
const MAX_BUCKETS = 1 << 14

export function indexClipperPath(path: ClipperPath): IndexedClipperPath {
  // Clipper answers 0 for fewer than three points; an index with no edges does too.
  const count = path.length >= 3 ? path.length : 0
  const fromX = new Float64Array(count)
  const fromY = new Float64Array(count)
  const toX = new Float64Array(count)
  const toY = new Float64Array(count)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i < count; i += 1) {
    const from = path[i]
    const to = path[(i + 1) % count]
    fromX[i] = from.X
    fromY[i] = from.Y
    toX[i] = to.X
    toY[i] = to.Y
    if (from.X < minX) minX = from.X
    if (from.X > maxX) maxX = from.X
    if (from.Y < minY) minY = from.Y
    if (from.Y > maxY) maxY = from.Y
  }
  const bucketCount = count === 0 || maxY === minY
    ? 1
    : Math.min(MAX_BUCKETS, Math.max(1, Math.ceil(count / EDGES_PER_BUCKET)))
  const bucketScale = maxY > minY ? bucketCount / (maxY - minY) : 0
  const index = {
    minX, minY, maxX, maxY, fromX, fromY, toX, toY, bucketCount, bucketScale,
    bucketStart: new Int32Array(bucketCount + 1),
    bucketEdges: new Int32Array(0),
  }
  const firstBucket = new Int32Array(count)
  const lastBucket = new Int32Array(count)
  for (let i = 0; i < count; i += 1) {
    firstBucket[i] = bucketOf(index, Math.min(fromY[i], toY[i]))
    lastBucket[i] = bucketOf(index, Math.max(fromY[i], toY[i]))
    for (let b = firstBucket[i]; b <= lastBucket[i]; b += 1) index.bucketStart[b + 1] += 1
  }
  for (let b = 0; b < bucketCount; b += 1) index.bucketStart[b + 1] += index.bucketStart[b]
  index.bucketEdges = new Int32Array(index.bucketStart[bucketCount])
  const fill = index.bucketStart.slice(0, bucketCount)
  for (let i = 0; i < count; i += 1) {
    for (let b = firstBucket[i]; b <= lastBucket[i]; b += 1) {
      index.bucketEdges[fill[b]] = i
      fill[b] += 1
    }
  }
  return index
}

/** Monotone in `y`, which is what makes "the edge's buckets contain the query's
 *  bucket" follow from "the edge's Y range contains the query Y". */
function bucketOf(index: Pick<IndexedClipperPath, 'minY' | 'bucketCount' | 'bucketScale'>, y: number): number {
  const bucket = Math.floor((y - index.minY) * index.bucketScale)
  return bucket < 0 ? 0 : bucket >= index.bucketCount ? index.bucketCount - 1 : bucket
}

/**
 * `ClipperLib.Clipper.PointInPolygon(pt, path)` for the indexed path:
 * 0 outside, 1 inside, -1 on the boundary.
 */
export function pointInIndexedPath(index: IndexedClipperPath, x: number, y: number): number {
  pointQueries += 1
  // Outside the Y range no edge qualifies; right of every vertex no edge can
  // toggle or report the boundary. Clipper walks to 0 in both cases.
  if (y < index.minY || y > index.maxY || x > index.maxX) return 0
  const bucket = bucketOf(index, y)
  const end = index.bucketStart[bucket + 1]
  let result = 0
  for (let slot = index.bucketStart[bucket]; slot < end; slot += 1) {
    edgesScanned += 1
    const edge = index.bucketEdges[slot]
    const ipX = index.fromX[edge]
    const ipY = index.fromY[edge]
    const nextX = index.toX[edge]
    const nextY = index.toY[edge]
    // Verbatim from ClipperLib.Clipper.PointInPolygon (clipper-lib 6.4.2).
    if (nextY === y) {
      if (nextX === x || (ipY === y && ((nextX > x) === (ipX < x)))) return -1
    }
    if ((ipY < y) !== (nextY < y)) {
      if (ipX >= x) {
        if (nextX > x) {
          result = 1 - result
        } else {
          const d = (ipX - x) * (nextY - y) - (nextX - x) * (ipY - y)
          if (d === 0) return -1
          if ((d > 0) === (nextY > ipY)) result = 1 - result
        }
      } else if (nextX > x) {
        const d = (ipX - x) * (nextY - y) - (nextX - x) * (ipY - y)
        if (d === 0) return -1
        if ((d > 0) === (nextY > ipY)) result = 1 - result
      }
    }
  }
  return result
}

/** Does any edge's axis-aligned bounding box overlap the closed box? Exact:
 *  an edge whose Y range meets the box's is registered in a bucket the box's
 *  Y range also covers. */
export function indexedEdgeBoundsOverlap(
  index: IndexedClipperPath,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): boolean {
  if (maxX < index.minX || minX > index.maxX || maxY < index.minY || minY > index.maxY) return false
  const first = bucketOf(index, Math.max(minY, index.minY))
  const last = bucketOf(index, Math.min(maxY, index.maxY))
  // A box spanning most rows would revisit edges registered in several of
  // them; one linear pass is cheaper and answers identically.
  if ((last - first + 1) * 2 > index.bucketCount) {
    for (let edge = 0; edge < index.fromX.length; edge += 1) {
      edgesScanned += 1
      if (edgeOverlaps(index, edge, minX, minY, maxX, maxY)) return true
    }
    return false
  }
  for (let slot = index.bucketStart[first]; slot < index.bucketStart[last + 1]; slot += 1) {
    edgesScanned += 1
    if (edgeOverlaps(index, index.bucketEdges[slot], minX, minY, maxX, maxY)) return true
  }
  return false
}

function edgeOverlaps(
  index: IndexedClipperPath,
  edge: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): boolean {
  const ax = index.fromX[edge], ay = index.fromY[edge], bx = index.toX[edge], by = index.toY[edge]
  return Math.min(ax, bx) <= maxX && Math.max(ax, bx) >= minX
    && Math.min(ay, by) <= maxY && Math.max(ay, by) >= minY
}
