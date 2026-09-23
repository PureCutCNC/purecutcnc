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

// Convex decomposition and convex Minkowski sums, in the integer domain.
//
// Clipper's own MinkowskiSum unions one quad per vertex pair, which for two
// 270-vertex footprints is 73k quads and tens of seconds. Splitting both
// shapes into convex pieces and summing piece pairs — each sum is just a
// convex hull — needs only (pieces × pieces) small polygons in the union.
//
// Decomposition is ear-clipping triangulation followed by Hertel–Mehlhorn
// merging (drop every diagonal whose removal keeps both sides convex), which
// is within four times the optimal piece count.

import type { ClipperPath, ClipperPoint } from '../toolpaths/types'

function cross(o: ClipperPoint, a: ClipperPoint, b: ClipperPoint): number {
  return (a.X - o.X) * (b.Y - o.Y) - (a.Y - o.Y) * (b.X - o.X)
}

/** True when `p` is inside or on triangle (a, b, c), which is positively wound. */
function inTriangle(p: ClipperPoint, a: ClipperPoint, b: ClipperPoint, c: ClipperPoint): boolean {
  return cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0
}

/**
 * Triangulates a simple, positively wound polygon. Returns vertex-index
 * triangles, or null if the polygon is too degenerate to clip cleanly.
 */
function triangulate(points: ClipperPoint[]): number[][] | null {
  const remaining = points.map((_, index) => index)
  const triangles: number[][] = []
  let guard = 0
  let cursor = 0
  while (remaining.length > 3) {
    if (guard > remaining.length) return null
    const count = remaining.length
    const i0 = remaining[(cursor + count - 1) % count]
    const i1 = remaining[cursor % count]
    const i2 = remaining[(cursor + 1) % count]
    const a = points[i0]
    const b = points[i1]
    const c = points[i2]
    const turn = cross(a, b, c)
    if (turn === 0) {
      // Collinear or a zero-width spike: dropping the vertex changes no area.
      remaining.splice(cursor % count, 1)
      guard = 0
      continue
    }
    let ear = turn > 0
    if (ear) {
      for (const index of remaining) {
        if (index === i0 || index === i1 || index === i2) continue
        const p = points[index]
        if ((p.X === a.X && p.Y === a.Y) || (p.X === b.X && p.Y === b.Y) || (p.X === c.X && p.Y === c.Y)) continue
        if (inTriangle(p, a, b, c)) {
          ear = false
          break
        }
      }
    }
    if (ear) {
      triangles.push([i0, i1, i2])
      remaining.splice(cursor % count, 1)
      guard = 0
    } else {
      cursor += 1
      guard += 1
    }
  }
  if (remaining.length === 3 && cross(points[remaining[0]], points[remaining[1]], points[remaining[2]]) > 0) {
    triangles.push([...remaining])
  }
  return triangles
}

function isConvex(cycle: number[], points: ClipperPoint[]): boolean {
  const count = cycle.length
  for (let index = 0; index < count; index += 1) {
    const o = points[cycle[index]]
    const a = points[cycle[(index + 1) % count]]
    const b = points[cycle[(index + 2) % count]]
    if (cross(o, a, b) < 0) return false
  }
  return true
}

function edgeKey(u: number, v: number): string {
  return u < v ? `${u}:${v}` : `${v}:${u}`
}

/** Rotates `cycle` so it starts at `from`; it then ends at `to` if (to, from) is an edge. */
function startAt(cycle: number[], from: number): number[] {
  const index = cycle.indexOf(from)
  return [...cycle.slice(index), ...cycle.slice(0, index)]
}

/**
 * Splits a simple, positively wound polygon into convex pieces that tile it.
 * Falls back to the polygon's convex hull only if triangulation fails, which
 * over-covers the shape and is therefore still safe for collision.
 */
export function convexPieces(path: ClipperPath): ClipperPath[] {
  if (path.length < 3) return []
  const triangles = triangulate(path)
  if (!triangles) return [convexHull(path)]

  const pieces = new Map<number, number[]>()
  const owners = new Map<string, number[]>()
  const diagonals: [number, number][] = []
  triangles.forEach((triangle, id) => {
    pieces.set(id, triangle)
    for (let index = 0; index < 3; index += 1) {
      const u = triangle[index]
      const v = triangle[(index + 1) % 3]
      const key = edgeKey(u, v)
      const list = owners.get(key)
      if (list) {
        list.push(id)
        diagonals.push([u, v])
      } else {
        owners.set(key, [id])
      }
    }
  })

  for (const [u, v] of diagonals) {
    const list = owners.get(edgeKey(u, v))
    if (!list || list.length !== 2) continue
    const [p, q] = list
    const cycleP = pieces.get(p)
    const cycleQ = pieces.get(q)
    if (!cycleP || !cycleQ) continue
    // The shared edge runs one way in P and the other way in Q.
    const pHasUV = cycleP[(cycleP.indexOf(u) + 1) % cycleP.length] === v
    const [first, second] = pHasUV ? [u, v] : [v, u]
    const fromP = startAt(cycleP, second) // second … first
    const fromQ = startAt(cycleQ, first) //  first … second
    const merged = [...fromP, ...fromQ.slice(1, -1)]
    if (!isConvex(merged, path)) continue
    pieces.set(p, merged)
    pieces.delete(q)
    owners.delete(edgeKey(u, v))
    for (let index = 0; index < cycleQ.length; index += 1) {
      const owner = owners.get(edgeKey(cycleQ[index], cycleQ[(index + 1) % cycleQ.length]))
      if (!owner) continue
      const at = owner.indexOf(q)
      if (at >= 0) owner[at] = p
    }
  }

  return [...pieces.values()].map((cycle) => cycle.map((index) => path[index]))
}

/** Convex hull, positively wound, collinear points dropped (Andrew's monotone chain). */
export function convexHull(points: ClipperPoint[]): ClipperPath {
  const sorted = [...points].sort((a, b) => a.X - b.X || a.Y - b.Y)
  if (sorted.length < 3) return sorted
  const lower: ClipperPoint[] = []
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: ClipperPoint[] = []
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const p = sorted[index]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  lower.pop()
  upper.pop()
  return [...lower, ...upper]
}

/** Minkowski sum of two convex polygons: the hull of all vertex sums. */
export function convexSum(a: ClipperPath, b: ClipperPath): ClipperPath {
  const sums: ClipperPoint[] = []
  for (const p of a) {
    for (const q of b) sums.push({ X: p.X + q.X, Y: p.Y + q.Y })
  }
  return convexHull(sums)
}
