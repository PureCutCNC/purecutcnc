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
 * Geometric medial axis of a polygonal region, computed from the Voronoi
 * diagram of a dense boundary sampling (the classic Delaunay-dual
 * construction, as used by F-Engrave and most engraving CAM packages).
 *
 * Pipeline:
 *  1. Resample every boundary loop (outer + islands) at `resolution` spacing,
 *     preserving original vertices exactly so corners stay sharp.
 *  2. Delaunay-triangulate the samples (delaunator). Circumcenters of
 *     triangles that fall inside the region converge to the interior medial
 *     axis as the sampling densifies; adjacent interior triangles yield the
 *     axis edges.
 *  3. Compute each node's clearance as the EXACT distance to the original
 *     boundary segments (not to the samples) — depth accuracy is therefore
 *     independent of the sampling step.
 *  4. Filter nodes by contact spread (a λ-medial-axis criterion evaluated
 *     against the exact boundary, not the samples): a genuine medial point
 *     has boundary contacts at least the corner-threshold angle apart, all at
 *     distance ≈ clearance. Vertices introduced by curve flattening (circles,
 *     fillets, font beziers) spawn spokes whose nodes see the boundary only
 *     in one narrow direction — those filter out, while genuine corners (the
 *     sharper, the wider the spread) and osculating tips (rounded stroke
 *     terminals, where the boundary hugs the medial ball over a wide arc)
 *     always survive.
 *  5. Contract numerically-coincident nodes, prune sampling-noise spurs, and
 *     extend branch tips into convex corners at zero clearance so a V-bit
 *     rises exactly to the surface in sharp corners.
 *
 * Unlike the Clipper offset-stepping approximations (vcarve.ts contour bands,
 * vcarveRecursive.ts topology-event tracking) this computes the medial axis
 * directly: junctions, branches and depth fall out of the Voronoi structure
 * with no event heuristics, and accuracy is controlled by one parameter.
 */

import Delaunator from 'delaunator'
import type { Point } from '../../../types/project'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MedialAxisRegion {
  /** Closed outer boundary of the carve region. */
  outer: Point[]
  /** Closed hole boundaries (material to keep) inside the outer loop. */
  islands: Point[][]
}

export interface MedialAxisOptions {
  /** Boundary sampling step in project units. Controls skeleton resolution. */
  resolution: number
  /**
   * Leaf edges shorter than `pruneFactor * resolution` whose tip does not
   * descend toward a boundary feature are removed as sampling noise.
   * Default 1.5.
   */
  pruneFactor?: number
  /**
   * Minimum turn angle (radians) for a boundary vertex to count as a convex
   * corner that receives a zero-clearance skeleton tip. Default 15°.
   */
  cornerAngleRad?: number
}

export interface MedialNode {
  x: number
  y: number
  /** Exact distance from this node to the nearest boundary segment. */
  clearance: number
}

export interface MedialGraph {
  nodes: MedialNode[]
  /** adjacency[i] lists the node indices connected to node i (symmetric). */
  adjacency: number[][]
}

const DEFAULT_PRUNE_FACTOR = 1.5
const DEFAULT_CORNER_ANGLE_RAD = (15 * Math.PI) / 180
const MAX_PRUNE_ITERATIONS = 32

export function emptyMedialGraph(): MedialGraph {
  return { nodes: [], adjacency: [] }
}

// ---------------------------------------------------------------------------
// Boundary preparation
// ---------------------------------------------------------------------------

/** Drop consecutive duplicate vertices and an explicit closing vertex. */
function cleanLoop(loop: Point[]): Point[] {
  const out: Point[] = []
  for (const p of loop) {
    const prev = out[out.length - 1]
    if (prev && Math.hypot(p.x - prev.x, p.y - prev.y) < 1e-9) continue
    out.push({ x: p.x, y: p.y })
  }
  while (out.length >= 2) {
    const first = out[0]
    const last = out[out.length - 1]
    if (Math.hypot(first.x - last.x, first.y - last.y) < 1e-9) out.pop()
    else break
  }
  return out
}

/**
 * Subdivide every edge of a closed loop into segments no longer than `step`.
 * Original vertices are always kept, so corner geometry is preserved exactly.
 */
function resampleLoop(loop: Point[], step: number): Point[] {
  const out: Point[] = []
  for (let i = 0; i < loop.length; i += 1) {
    const a = loop[i]
    const b = loop[(i + 1) % loop.length]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    const pieces = Math.max(1, Math.ceil(len / step))
    for (let k = 0; k < pieces; k += 1) {
      const t = k / pieces
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
    }
  }
  return out
}

/** Even-odd point-in-region test over every boundary loop (outer + islands). */
export function pointInRegionLoops(x: number, y: number, loops: Point[][]): boolean {
  let inside = false
  for (const loop of loops) {
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i, i += 1) {
      const pi = loop[i]
      const pj = loop[j]
      if ((pi.y > y) !== (pj.y > y)
        && x < ((pj.x - pi.x) * (y - pi.y)) / (pj.y - pi.y) + pi.x) {
        inside = !inside
      }
    }
  }
  return inside
}

// ---------------------------------------------------------------------------
// Exact distance-to-boundary queries (uniform grid over short segments)
// ---------------------------------------------------------------------------

function closestPointOnSegment(
  px: number, py: number, ax: number, ay: number, bx: number, by: number,
): { x: number; y: number } {
  const abx = bx - ax
  const aby = by - ay
  const lenSq = abx * abx + aby * aby
  const t = lenSq > 1e-18
    ? Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / lenSq))
    : 0
  return { x: ax + abx * t, y: ay + aby * t }
}

function pointSegmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const q = closestPointOnSegment(px, py, ax, ay, bx, by)
  return Math.hypot(px - q.x, py - q.y)
}

/**
 * Uniform-grid spatial index over the resampled boundary segments (each at
 * most `resolution` long, so a segment spans very few cells). Queries expand
 * outward ring by ring and stop as soon as the found distance is provably
 * minimal. Query points are expected to lie inside the boundary bbox.
 */
class SegmentDistanceGrid {
  private readonly cells: number[][]
  private readonly cols: number
  private readonly rows: number
  private readonly cellSize: number
  private readonly minX: number
  private readonly minY: number
  /** Flat segment storage: [ax, ay, bx, by] per segment. */
  private readonly segs: Float64Array

  constructor(segments: Float64Array, cellSize: number) {
    this.segs = segments
    const count = segments.length / 4
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (let s = 0; s < count; s += 1) {
      minX = Math.min(minX, segments[s * 4], segments[s * 4 + 2])
      maxX = Math.max(maxX, segments[s * 4], segments[s * 4 + 2])
      minY = Math.min(minY, segments[s * 4 + 1], segments[s * 4 + 3])
      maxY = Math.max(maxY, segments[s * 4 + 1], segments[s * 4 + 3])
    }
    const spanX = Math.max(maxX - minX, 1e-9)
    const spanY = Math.max(maxY - minY, 1e-9)
    // Keep the grid bounded even for pathological resolution choices.
    const size = Math.max(cellSize, spanX / 512, spanY / 512)
    this.cellSize = size
    this.minX = minX
    this.minY = minY
    this.cols = Math.max(1, Math.ceil(spanX / size))
    this.rows = Math.max(1, Math.ceil(spanY / size))
    this.cells = new Array<number[]>(this.cols * this.rows)
    for (let s = 0; s < count; s += 1) {
      const x0 = Math.min(segments[s * 4], segments[s * 4 + 2])
      const x1 = Math.max(segments[s * 4], segments[s * 4 + 2])
      const y0 = Math.min(segments[s * 4 + 1], segments[s * 4 + 3])
      const y1 = Math.max(segments[s * 4 + 1], segments[s * 4 + 3])
      const c0 = this.clampCol(Math.floor((x0 - minX) / size))
      const c1 = this.clampCol(Math.floor((x1 - minX) / size))
      const r0 = this.clampRow(Math.floor((y0 - minY) / size))
      const r1 = this.clampRow(Math.floor((y1 - minY) / size))
      for (let r = r0; r <= r1; r += 1) {
        for (let c = c0; c <= c1; c += 1) {
          const idx = r * this.cols + c
          const bucket = this.cells[idx] ?? (this.cells[idx] = [])
          bucket.push(s)
        }
      }
    }
  }

  private clampCol(c: number): number {
    return Math.max(0, Math.min(this.cols - 1, c))
  }

  private clampRow(r: number): number {
    return Math.max(0, Math.min(this.rows - 1, r))
  }

  distanceTo(x: number, y: number): number {
    const cc = this.clampCol(Math.floor((x - this.minX) / this.cellSize))
    const cr = this.clampRow(Math.floor((y - this.minY) / this.cellSize))
    const maxRing = this.cols + this.rows
    let best = Infinity
    for (let ring = 0; ring <= maxRing; ring += 1) {
      // Every cell in ring `ring` is at least (ring - 1) * cellSize away from
      // a query point inside cell (cc, cr); once `best` beats that bound no
      // farther ring can improve it.
      if (best <= (ring - 1) * this.cellSize) break
      const r0 = cr - ring
      const r1 = cr + ring
      const c0 = cc - ring
      const c1 = cc + ring
      for (let r = r0; r <= r1; r += 1) {
        if (r < 0 || r >= this.rows) continue
        const onRowEdge = r === r0 || r === r1
        for (let c = c0; c <= c1; c += 1) {
          if (c < 0 || c >= this.cols) continue
          if (!onRowEdge && c !== c0 && c !== c1) continue
          const bucket = this.cells[r * this.cols + c]
          if (!bucket) continue
          for (const s of bucket) {
            const d = pointSegmentDistance(
              x, y,
              this.segs[s * 4], this.segs[s * 4 + 1],
              this.segs[s * 4 + 2], this.segs[s * 4 + 3],
            )
            if (d < best) best = d
          }
        }
      }
    }
    return best
  }

  /**
   * True when the boundary stays within `clearance * (1 + tolRatio)` of the
   * query point over an angular spread of at least `minAngleRad` — i.e. there
   * is a second contact direction at least that far from the nearest one.
   * This is what distinguishes genuine medial-axis points (two walls, a
   * corner wedge, or an osculating arc) from spoke noise generated by curve
   * flattening (boundary close in one narrow direction only).
   */
  hasContactSpread(x: number, y: number, clearance: number, minAngleRad: number, tolRatio: number): boolean {
    const limit = clearance * (1 + tolRatio) + 1e-9
    const cc = this.clampCol(Math.floor((x - this.minX) / this.cellSize))
    const cr = this.clampRow(Math.floor((y - this.minY) / this.cellSize))
    const maxRing = Math.min(this.cols + this.rows, Math.ceil(limit / this.cellSize) + 1)

    // Collect the closest point of every segment within the limit annulus.
    const contacts: number[] = []
    let bestDist = Infinity
    let bestX = 0
    let bestY = 0
    for (let ring = 0; ring <= maxRing; ring += 1) {
      const r0 = cr - ring
      const r1 = cr + ring
      const c0 = cc - ring
      const c1 = cc + ring
      for (let r = r0; r <= r1; r += 1) {
        if (r < 0 || r >= this.rows) continue
        const onRowEdge = r === r0 || r === r1
        for (let c = c0; c <= c1; c += 1) {
          if (c < 0 || c >= this.cols) continue
          if (!onRowEdge && c !== c0 && c !== c1) continue
          const bucket = this.cells[r * this.cols + c]
          if (!bucket) continue
          for (const s of bucket) {
            const q = closestPointOnSegment(
              x, y,
              this.segs[s * 4], this.segs[s * 4 + 1],
              this.segs[s * 4 + 2], this.segs[s * 4 + 3],
            )
            const d = Math.hypot(x - q.x, y - q.y)
            if (d > limit) continue
            contacts.push(q.x, q.y, d)
            if (d < bestDist) {
              bestDist = d
              bestX = q.x
              bestY = q.y
            }
          }
        }
      }
    }
    if (bestDist === Infinity) return false

    const ux = (bestX - x) / bestDist
    const uy = (bestY - y) / bestDist
    const maxCos = Math.cos(minAngleRad)
    for (let i = 0; i < contacts.length; i += 3) {
      const d = contacts[i + 2]
      if (d < 1e-12) continue
      const cos = ((contacts[i] - x) * ux + (contacts[i + 1] - y) * uy) / d
      if (cos <= maxCos) return true
    }
    return false
  }
}

// ---------------------------------------------------------------------------
// Convex-corner detection (for zero-clearance skeleton tips)
// ---------------------------------------------------------------------------

export interface RegionCorner {
  point: Point
  /** Turn angle in radians (0 = straight). */
  turnRad: number
}

/**
 * Vertices of the region boundary where the material forms a convex corner
 * (interior angle < 180°) sharper than `angleThresholdRad`. On the outer loop
 * these are its convex vertices; on island loops they are the island's
 * concave vertices (the region wraps convexly around those). The medial axis
 * terminates exactly at such corners with zero clearance.
 */
export function regionConvexCorners(
  region: MedialAxisRegion,
  angleThresholdRad: number = DEFAULT_CORNER_ANGLE_RAD,
): RegionCorner[] {
  const corners: RegionCorner[] = []
  const loops: Array<{ pts: Point[]; island: boolean }> = [
    { pts: cleanLoop(region.outer), island: false },
    ...region.islands.map((island) => ({ pts: cleanLoop(island), island: true })),
  ]

  for (const { pts, island } of loops) {
    const n = pts.length
    if (n < 3) continue
    let area = 0
    for (let i = 0; i < n; i += 1) {
      const a = pts[i]
      const b = pts[(i + 1) % n]
      area += a.x * b.y - b.x * a.y
    }
    if (Math.abs(area) < 1e-12) continue

    for (let i = 0; i < n; i += 1) {
      const prev = pts[(i - 1 + n) % n]
      const curr = pts[i]
      const next = pts[(i + 1) % n]
      const dx1 = curr.x - prev.x
      const dy1 = curr.y - prev.y
      const dx2 = next.x - curr.x
      const dy2 = next.y - curr.y
      const len1 = Math.hypot(dx1, dy1)
      const len2 = Math.hypot(dx2, dy2)
      if (len1 < 1e-12 || len2 < 1e-12) continue

      const cross = dx1 * dy2 - dy1 * dx2
      const convexIntoRegion = island ? cross * area < 0 : cross * area > 0
      if (!convexIntoRegion) continue

      const cos = (dx1 * dx2 + dy1 * dy2) / (len1 * len2)
      const turnRad = Math.acos(Math.max(-1, Math.min(1, cos)))
      if (turnRad <= angleThresholdRad) continue
      corners.push({ point: { x: curr.x, y: curr.y }, turnRad })
    }
  }
  return corners
}

// ---------------------------------------------------------------------------
// Graph assembly helpers
// ---------------------------------------------------------------------------

interface GraphBuilder {
  xs: number[]
  ys: number[]
  clearances: number[]
  edges: Set<number>
  edgeCapacity: number
}

function edgeKey(builder: GraphBuilder, a: number, b: number): number {
  return a < b ? a * builder.edgeCapacity + b : b * builder.edgeCapacity + a
}

function circumcenter(
  ax: number, ay: number, bx: number, by: number, cx: number, cy: number,
): { x: number; y: number } | null {
  const dx = bx - ax
  const dy = by - ay
  const ex = cx - ax
  const ey = cy - ay
  const bl = dx * dx + dy * dy
  const cl = ex * ex + ey * ey
  const d = dx * ey - dy * ex
  if (Math.abs(d) <= 1e-9 * Math.max(bl, cl)) return null
  const half = 0.5 / d
  return {
    x: ax + (ey * bl - dy * cl) * half,
    y: ay + (dx * cl - ex * bl) * half,
  }
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function computeMedialAxis(region: MedialAxisRegion, options: MedialAxisOptions): MedialGraph {
  const resolution = options.resolution
  if (!(resolution > 0)) return emptyMedialGraph()
  const pruneFactor = options.pruneFactor ?? DEFAULT_PRUNE_FACTOR
  const cornerAngleRad = options.cornerAngleRad ?? DEFAULT_CORNER_ANGLE_RAD

  const outer = cleanLoop(region.outer)
  if (outer.length < 3) return emptyMedialGraph()
  const islands = region.islands.map(cleanLoop).filter((loop) => loop.length >= 3)
  const loops = [outer, ...islands]

  // --- 1. Sample the boundary ---------------------------------------------
  const samples: Point[] = []
  const segCoords: number[] = []
  const seen = new Set<string>()
  for (const loop of loops) {
    const resampled = resampleLoop(loop, resolution)
    for (let i = 0; i < resampled.length; i += 1) {
      const a = resampled[i]
      const b = resampled[(i + 1) % resampled.length]
      segCoords.push(a.x, a.y, b.x, b.y)
      const key = `${Math.round(a.x * 1e7)}:${Math.round(a.y * 1e7)}`
      if (!seen.has(key)) {
        seen.add(key)
        samples.push(a)
      }
    }
  }
  if (samples.length < 3) return emptyMedialGraph()

  const distanceGrid = new SegmentDistanceGrid(new Float64Array(segCoords), resolution * 2)

  // --- 2. Delaunay triangulation -------------------------------------------
  const coords = new Float64Array(samples.length * 2)
  for (let i = 0; i < samples.length; i += 1) {
    coords[i * 2] = samples[i].x
    coords[i * 2 + 1] = samples[i].y
  }
  let delaunay: Delaunator<Float64Array>
  try {
    delaunay = new Delaunator(coords)
  } catch {
    return emptyMedialGraph()
  }
  const triangles = delaunay.triangles
  const halfedges = delaunay.halfedges
  const triangleCount = triangles.length / 3
  if (triangleCount === 0) return emptyMedialGraph()

  // --- 3. Interior circumcenters become medial nodes -----------------------
  const rawXs: number[] = []
  const rawYs: number[] = []
  const nodeOfTriangle = new Int32Array(triangleCount).fill(-1)
  const nodeByPosition = new Map<string, number>()
  for (let t = 0; t < triangleCount; t += 1) {
    const i0 = triangles[t * 3] * 2
    const i1 = triangles[t * 3 + 1] * 2
    const i2 = triangles[t * 3 + 2] * 2
    const cc = circumcenter(coords[i0], coords[i0 + 1], coords[i1], coords[i1 + 1], coords[i2], coords[i2 + 1])
    if (!cc) continue
    if (!pointInRegionLoops(cc.x, cc.y, loops)) continue
    const key = `${Math.round(cc.x * 1e7)}:${Math.round(cc.y * 1e7)}`
    let node = nodeByPosition.get(key)
    if (node === undefined) {
      node = rawXs.length
      nodeByPosition.set(key, node)
      rawXs.push(cc.x)
      rawYs.push(cc.y)
    }
    nodeOfTriangle[t] = node
  }

  // --- 4. Contact-spread filter (λ-medial axis on exact geometry) ----------
  // Slightly below the corner threshold so sampling wobble on a borderline
  // corner branch cannot fragment it. The tolerance ratio covers the node
  // position error caused by sampling a curved wall with chords (sagitta
  // h²/8R with R >= clearance) plus a small constant floor.
  const spreadThreshold = cornerAngleRad * 0.75
  const builder: GraphBuilder = { xs: [], ys: [], clearances: [], edges: new Set(), edgeCapacity: 0 }
  const keptIndex = new Int32Array(rawXs.length).fill(-1)
  for (let i = 0; i < rawXs.length; i += 1) {
    const clearance = distanceGrid.distanceTo(rawXs[i], rawYs[i])
    if (clearance < resolution * 1e-3) continue
    const tolRatio = 0.003 + ((resolution / clearance) ** 2) / 8
    if (!distanceGrid.hasContactSpread(rawXs[i], rawYs[i], clearance, spreadThreshold, tolRatio)) continue
    keptIndex[i] = builder.xs.length
    builder.xs.push(rawXs[i])
    builder.ys.push(rawYs[i])
    builder.clearances.push(clearance)
  }
  for (let t = 0; t < triangleCount; t += 1) {
    nodeOfTriangle[t] = nodeOfTriangle[t] >= 0 ? keptIndex[nodeOfTriangle[t]] : -1
  }
  builder.edgeCapacity = builder.xs.length + 1

  // --- 4. Edges between adjacent interior triangles ------------------------
  for (let e = 0; e < halfedges.length; e += 1) {
    if (halfedges[e] <= e) continue // hull edge (-1) or pair already visited
    const a = nodeOfTriangle[Math.floor(e / 3)]
    const b = nodeOfTriangle[Math.floor(halfedges[e] / 3)]
    if (a < 0 || b < 0 || a === b) continue
    // Guard against edges that cut a reflex-corner pocket: both endpoints
    // inside, connecting segment briefly outside.
    const mx = (builder.xs[a] + builder.xs[b]) / 2
    const my = (builder.ys[a] + builder.ys[b]) / 2
    if (!pointInRegionLoops(mx, my, loops)) continue
    builder.edges.add(edgeKey(builder, a, b))
  }

  // --- 5. Contract sub-resolution node clusters -----------------------------
  const contracted = contractMicroClusters(builder, resolution * 0.75)

  // --- 6. Prune sampling-noise spurs ---------------------------------------
  pruneSpurs(contracted, resolution, pruneFactor)

  // --- 7. Drop leftover fragments of filtered flattening spokes ------------
  dropSmallComponents(contracted, resolution * 4)

  // --- 8. Extend branch tips into sharp convex corners ---------------------
  extendIntoCorners(contracted, regionConvexCorners(region, cornerAngleRad), loops, resolution)

  return finalizeGraph(contracted, resolution)
}

// ---------------------------------------------------------------------------
// Post-processing passes
// ---------------------------------------------------------------------------

interface MutableGraph {
  xs: number[]
  ys: number[]
  clearances: number[]
  adjacency: Array<Set<number>>
}

/**
 * Merge nodes that fall into the same `cellSize` grid cell. Braided parallel
 * chains, micro-rings and terminal blobs — Voronoi noise below toolpath
 * resolution — collapse into single chains/points, while genuine chains only
 * lose sub-cell duplicate nodes: clustering by cell bounds the merge diameter,
 * so a long chain of short edges can never collapse transitively the way
 * edge-length union-find would. Each cluster is represented by its deepest
 * member: the true medial axis locally maximizes clearance, so that member is
 * the best approximation in the cell and its exact clearance carries over.
 */
function contractMicroClusters(builder: GraphBuilder, cellSize: number): MutableGraph {
  const count = builder.xs.length
  const clusterOf = new Map<string, number>()
  const representative: number[] = []
  const mapped = new Int32Array(count)
  for (let i = 0; i < count; i += 1) {
    const key = `${Math.round(builder.xs[i] / cellSize)}:${Math.round(builder.ys[i] / cellSize)}`
    let idx = clusterOf.get(key)
    if (idx === undefined) {
      idx = representative.length
      clusterOf.set(key, idx)
      representative.push(i)
    } else if (builder.clearances[i] > builder.clearances[representative[idx]]) {
      representative[idx] = i
    }
    mapped[i] = idx
  }

  const xs = representative.map((r) => builder.xs[r])
  const ys = representative.map((r) => builder.ys[r])
  const clearances = representative.map((r) => builder.clearances[r])
  const adjacency: Array<Set<number>> = Array.from({ length: xs.length }, () => new Set<number>())
  for (const key of builder.edges) {
    const a = mapped[Math.floor(key / builder.edgeCapacity)]
    const b = mapped[key % builder.edgeCapacity]
    if (a === b) continue
    adjacency[a].add(b)
    adjacency[b].add(a)
  }
  return { xs, ys, clearances, adjacency }
}

/**
 * Remove short leaf branches that do not descend toward a boundary feature.
 * Genuine corner branches lose clearance toward the tip (the medial ball
 * shrinks into the corner); discretization spurs keep roughly the clearance
 * of their junction and are never longer than a couple of sampling steps.
 */
function pruneSpurs(graph: MutableGraph, resolution: number, pruneFactor: number): void {
  const maxLen = pruneFactor * resolution
  for (let iter = 0; iter < MAX_PRUNE_ITERATIONS; iter += 1) {
    let removed = 0
    for (let leaf = 0; leaf < graph.adjacency.length; leaf += 1) {
      if (graph.adjacency[leaf].size !== 1) continue
      const junction = graph.adjacency[leaf].values().next().value as number
      const len = Math.hypot(graph.xs[leaf] - graph.xs[junction], graph.ys[leaf] - graph.ys[junction])
      if (len >= maxLen) continue
      const descends = graph.clearances[leaf] < graph.clearances[junction] - 0.25 * len
      if (descends) continue
      graph.adjacency[leaf].delete(junction)
      graph.adjacency[junction].delete(leaf)
      removed += 1
    }
    if (removed === 0) break
  }
}

/**
 * The medial axis of a connected region is connected, so any small isolated
 * component left after filtering and pruning is a remnant of a discretization
 * spoke — drop it. If everything is small (a genuinely tiny region), the
 * component containing the deepest node is kept.
 */
function dropSmallComponents(graph: MutableGraph, minTotalLength: number): void {
  const count = graph.xs.length
  const componentOf = new Int32Array(count).fill(-1)
  const componentLengths: number[] = []
  for (let start = 0; start < count; start += 1) {
    if (componentOf[start] >= 0 || graph.adjacency[start].size === 0) continue
    const component = componentLengths.length
    let length = 0
    const queue = [start]
    componentOf[start] = component
    while (queue.length > 0) {
      const node = queue.pop() as number
      for (const neighbor of graph.adjacency[node]) {
        length += Math.hypot(graph.xs[node] - graph.xs[neighbor], graph.ys[node] - graph.ys[neighbor]) / 2
        if (componentOf[neighbor] < 0) {
          componentOf[neighbor] = component
          queue.push(neighbor)
        }
      }
    }
    componentLengths.push(length)
  }
  if (componentLengths.length === 0) return

  const keepComponent = componentLengths.map((length) => length >= minTotalLength)
  if (!keepComponent.some(Boolean)) {
    let deepest = -1
    for (let i = 0; i < count; i += 1) {
      if (componentOf[i] < 0) continue
      if (deepest < 0 || graph.clearances[i] > graph.clearances[deepest]) deepest = i
    }
    if (deepest >= 0) keepComponent[componentOf[deepest]] = true
  }

  for (let i = 0; i < count; i += 1) {
    if (componentOf[i] >= 0 && !keepComponent[componentOf[i]]) {
      graph.adjacency[i].clear()
    }
  }
}

/**
 * Connect the medial graph to each sharp convex corner of the boundary with a
 * zero-clearance tip node. The sampled Voronoi branch stops ~one sampling
 * step short of the corner; the added segment continues the corner bisector
 * so the V-bit surfaces exactly at the corner point.
 */
function extendIntoCorners(
  graph: MutableGraph,
  corners: RegionCorner[],
  loops: Point[][],
  resolution: number,
): void {
  for (const corner of corners) {
    let best = -1
    let bestDist = Infinity
    for (let i = 0; i < graph.xs.length; i += 1) {
      if (graph.adjacency[i].size === 0 && graph.xs.length > 1) continue
      const d = Math.hypot(graph.xs[i] - corner.point.x, graph.ys[i] - corner.point.y)
      if (d < bestDist) {
        bestDist = d
        best = i
      }
    }
    if (best < 0) continue
    // The corner must lie on (or near) the candidate node's medial ball —
    // otherwise this corner's branch was absorbed elsewhere and a link would
    // cut across foreign geometry.
    if (bestDist > graph.clearances[best] + 1.5 * resolution) continue
    const mx = (graph.xs[best] + corner.point.x) / 2
    const my = (graph.ys[best] + corner.point.y) / 2
    if (bestDist > resolution * 0.05 && !pointInRegionLoops(mx, my, loops)) continue

    const tip = graph.xs.length
    graph.xs.push(corner.point.x)
    graph.ys.push(corner.point.y)
    graph.clearances.push(0)
    graph.adjacency.push(new Set([best]))
    graph.adjacency[best].add(tip)
  }
}

function finalizeGraph(graph: MutableGraph, resolution: number): MedialGraph {
  const hasEdges = graph.adjacency.some((set) => set.size > 0)
  let keep: number[] = []
  if (hasEdges) {
    for (let i = 0; i < graph.xs.length; i += 1) {
      if (graph.adjacency[i].size > 0) keep.push(i)
    }
  } else if (graph.xs.length > 0) {
    // Dot-like region (circle, period): the whole axis collapses to a point.
    let best = 0
    for (let i = 1; i < graph.xs.length; i += 1) {
      if (graph.clearances[i] > graph.clearances[best]) best = i
    }
    keep.push(best)
  }

  // A skeleton whose entire extent is a few sampling steps is sub-resolution
  // detail (the dot of an "i", a period): a cluster of micro chains there only
  // produces tiny cuts and retracts. Replace it with one plunge at the
  // deepest point.
  if (keep.length > 1) {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const i of keep) {
      minX = Math.min(minX, graph.xs[i])
      minY = Math.min(minY, graph.ys[i])
      maxX = Math.max(maxX, graph.xs[i])
      maxY = Math.max(maxY, graph.ys[i])
    }
    if (Math.max(maxX - minX, maxY - minY) <= resolution * 3) {
      const deepest = keep.reduce((best, i) => (graph.clearances[i] > graph.clearances[best] ? i : best))
      graph.adjacency[deepest].clear()
      keep = [deepest]
    }
  }

  const remap = new Int32Array(graph.xs.length).fill(-1)
  keep.forEach((old, idx) => { remap[old] = idx })
  const nodes: MedialNode[] = keep.map((old) => ({
    x: graph.xs[old],
    y: graph.ys[old],
    clearance: graph.clearances[old],
  }))
  const adjacency: number[][] = keep.map((old) =>
    [...graph.adjacency[old]]
      .map((n) => remap[n])
      .filter((n) => n >= 0)
      .sort((a, b) => a - b),
  )
  return { nodes, adjacency }
}
