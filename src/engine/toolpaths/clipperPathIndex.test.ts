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

import assert from 'node:assert/strict'
import { test } from 'node:test'
import ClipperLib from 'clipper-lib'
import type { Point } from '../../types/project'
import { addOpenSubject, openPathsFromPolyTree } from '../clipperOpenPaths'
import {
  clipperPathIndexProbeCounts,
  indexClipperPath,
  indexedEdgeBoundsOverlap,
  pointInIndexedPath,
  resetClipperPathIndexProbeCounts,
} from './clipperPathIndex'
import { createSurfaceDomainCheck } from './finishSurfaceSlope'
import { DEFAULT_CLIPPER_SCALE } from './geometry'
import { pointInClipperPaths } from './modelProtection'
import type { ClipperPath } from './types'

const clipperPointInPolygon = (x: number, y: number, path: ClipperPath): number =>
  (ClipperLib.Clipper as unknown as { PointInPolygon(point: { X: number; Y: number }, path: ClipperPath): number })
    .PointInPolygon({ X: x, Y: y }, path)

/** Deterministic PRNG so a failure reproduces. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Random vertex walks on a coarse integer grid: shared rows, horizontal and
 *  vertical edges, repeated vertices and self-intersections all occur often,
 *  which is where Clipper's on-boundary and vertex-row rules live. */
function gridPolygon(next: () => number, count: number, size: number): ClipperPath {
  return Array.from({ length: count }, () => ({ X: Math.floor(next() * size), Y: Math.floor(next() * size) }))
}

test('indexed point-in-polygon returns exactly what Clipper returns, boundary -1 included', () => {
  const next = random(922)
  let boundaryHits = 0
  let insideHits = 0
  for (let trial = 0; trial < 60; trial += 1) {
    const path = gridPolygon(next, 3 + Math.floor(next() * 40), 24)
    const index = indexClipperPath(path)
    // Every grid point, one cell beyond the path on every side: vertices, points
    // on edges, points on vertex rows, and points outside the bounds.
    for (let y = -1; y <= 25; y += 1) {
      for (let x = -1; x <= 25; x += 1) {
        const expected = clipperPointInPolygon(x, y, path)
        assert.equal(pointInIndexedPath(index, x, y), expected, `trial ${trial} at (${x}, ${y})`)
        if (expected === -1) boundaryHits += 1
        if (expected === 1) insideHits += 1
      }
    }
  }
  assert(boundaryHits > 1000 && insideHits > 1000, 'the grid must exercise both the boundary and the interior')
})

test('indexed point-in-polygon matches Clipper at Clipper scale, where bucket edges are fractional', () => {
  const next = random(4242)
  for (let trial = 0; trial < 20; trial += 1) {
    const path = gridPolygon(next, 200 + Math.floor(next() * 400), 200_000)
    const index = indexClipperPath(path)
    for (let query = 0; query < 2000; query += 1) {
      // Half the queries sit on a vertex row, where the half-open rule matters.
      const y = query % 2 === 0 ? path[Math.floor(next() * path.length)].Y : Math.floor(next() * 200_000)
      const x = Math.floor(next() * 200_000)
      assert.equal(pointInIndexedPath(index, x, y), clipperPointInPolygon(x, y, path), `trial ${trial} at (${x}, ${y})`)
    }
    for (const vertex of path) {
      assert.equal(pointInIndexedPath(index, vertex.X, vertex.Y), -1)
    }
  }
})

test('degenerate paths answer as Clipper does', () => {
  for (const path of [[], [{ X: 0, Y: 0 }], [{ X: 0, Y: 0 }, { X: 5, Y: 5 }]]) {
    assert.equal(pointInIndexedPath(indexClipperPath(path), 0, 0), clipperPointInPolygon(0, 0, path))
  }
  const flat = [{ X: 0, Y: 3 }, { X: 10, Y: 3 }, { X: 4, Y: 3 }]
  const index = indexClipperPath(flat)
  for (let x = -2; x <= 12; x += 1) {
    for (const y of [2, 3, 4]) assert.equal(pointInIndexedPath(index, x, y), clipperPointInPolygon(x, y, flat))
  }
})

test('edge bounds overlap agrees with a scan of every edge', () => {
  const next = random(7)
  for (let trial = 0; trial < 40; trial += 1) {
    const path = gridPolygon(next, 3 + Math.floor(next() * 60), 50)
    const index = indexClipperPath(path)
    for (let query = 0; query < 300; query += 1) {
      const x0 = Math.floor(next() * 56) - 3
      const y0 = Math.floor(next() * 56) - 3
      // Mostly small boxes (the bucketed branch), some spanning most rows (the linear one).
      const extent = query % 5 === 0 ? 40 : 3
      const x1 = x0 + Math.floor(next() * extent)
      const y1 = y0 + Math.floor(next() * extent)
      const expected = path.some((from, i) => {
        const to = path[(i + 1) % path.length]
        return Math.min(from.X, to.X) <= x1 && Math.max(from.X, to.X) >= x0
          && Math.min(from.Y, to.Y) <= y1 && Math.max(from.Y, to.Y) >= y0
      })
      assert.equal(indexedEdgeBoundsOverlap(index, x0, y0, x1, y1), expected, `trial ${trial} box ${x0},${y0}..${x1},${y1}`)
    }
  }
})

/** The link predicate as it stood before #922: every edge's bounds, and
 *  Clipper's point test over the paths whose bounds meet the segment. */
function bruteForceLinkInside(paths: ClipperPath[], from: Point, to: Point): boolean {
  const usable = paths.filter((path) => path.length >= 3)
  const a = { X: Math.round(from.x * DEFAULT_CLIPPER_SCALE), Y: Math.round(from.y * DEFAULT_CLIPPER_SCALE) }
  const b = { X: Math.round(to.x * DEFAULT_CLIPPER_SCALE), Y: Math.round(to.y * DEFAULT_CLIPPER_SCALE) }
  const box = { minX: Math.min(a.X, b.X), minY: Math.min(a.Y, b.Y), maxX: Math.max(a.X, b.X), maxY: Math.max(a.Y, b.Y) }
  const overlaps = (minX: number, minY: number, maxX: number, maxY: number): boolean =>
    minX <= box.maxX && maxX >= box.minX && minY <= box.maxY && maxY >= box.minY
  const candidates: ClipperPath[] = []
  let mayCross = false
  for (const path of usable) {
    const xs = path.map((point) => point.X)
    const ys = path.map((point) => point.Y)
    if (!overlaps(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys))) continue
    candidates.push(path)
    mayCross ||= path.some((p, i) => {
      const q = path[(i + 1) % path.length]
      return overlaps(Math.min(p.X, q.X), Math.min(p.Y, q.Y), Math.max(p.X, q.X), Math.max(p.Y, q.Y))
    })
  }
  if (!pointInClipperPaths(candidates, from) || !pointInClipperPaths(candidates, to)) return false
  if (a.X === b.X && a.Y === b.Y || !mayCross) return true
  const clipper = new ClipperLib.Clipper()
  addOpenSubject(clipper, [a, b])
  clipper.AddPaths(candidates, ClipperLib.PolyType.ptClip, true)
  const tree = new ClipperLib.PolyTree()
  clipper.Execute(ClipperLib.ClipType.ctDifference, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftEvenOdd)
  return openPathsFromPolyTree(tree).length === 0
}

/** A dense wavy ring with a wavy hole, in project units scaled to Clipper. */
function wavyDomain(vertices: number): ClipperPath[] {
  const ring = (radius: number, wobble: number, lobes: number, reverse: boolean): ClipperPath => {
    const path = Array.from({ length: vertices }, (_, i) => {
      const angle = (i / vertices) * Math.PI * 2
      const r = radius + wobble * Math.sin(lobes * angle)
      return { X: Math.round((10 + r * Math.cos(angle)) * DEFAULT_CLIPPER_SCALE), Y: Math.round((10 + r * Math.sin(angle)) * DEFAULT_CLIPPER_SCALE) }
    })
    return reverse ? path.reverse() : path
  }
  return [ring(8, 1.2, 9, false), ring(3, 0.6, 5, true)]
}

test('the surface domain check answers every point and link exactly as the brute-force predicate', () => {
  const domain = wavyDomain(1500)
  const check = createSurfaceDomainCheck(domain)
  const next = random(31)
  let insideLinks = 0
  let rejectedLinks = 0
  for (let query = 0; query < 3000; query += 1) {
    const from = { x: next() * 22 - 1, y: next() * 22 - 1 }
    // Short links like the densified contours, and long ones like pass-to-pass joins.
    const reach = query % 3 === 0 ? 6 : 0.05
    const to = { x: from.x + (next() - 0.5) * reach, y: from.y + (next() - 0.5) * reach }
    assert.equal(check.containsPoint(from), pointInClipperPaths(domain, from), `point ${from.x}, ${from.y}`)
    const expected = bruteForceLinkInside(domain, from, to)
    assert.equal(check.linkInside(from, to), expected, `link ${from.x},${from.y} -> ${to.x},${to.y}`)
    if (expected) insideLinks += 1
    else rejectedLinks += 1
  }
  // Points exactly on a domain vertex are on the boundary, which counts as inside.
  for (const vertex of domain[0].slice(0, 200)) {
    const point = { x: vertex.X / DEFAULT_CLIPPER_SCALE, y: vertex.Y / DEFAULT_CLIPPER_SCALE }
    assert.equal(check.containsPoint(point), pointInClipperPaths(domain, point))
  }
  assert(insideLinks > 500 && rejectedLinks > 500, 'both verdicts must be exercised')
})

// Measured 2026-09-29 on this fixture: 6.7 edges scanned per containment query
// (both loops together), where the brute-force scan reads up to all 10,000. The
// bound leaves room for a bucket-size change, not for a return to the scan.
const MAX_EDGES_PER_POINT_QUERY = 20

test('a point query on a dense outline scans a handful of edges, not the outline', () => {
  const domain = wavyDomain(5000)
  const check = createSurfaceDomainCheck(domain)
  const next = random(5)
  resetClipperPathIndexProbeCounts()
  for (let query = 0; query < 2000; query += 1) check.containsPoint({ x: next() * 20, y: next() * 20 })
  const { edgesScanned, pointQueries } = clipperPathIndexProbeCounts()
  assert.equal(pointQueries, 2000 * domain.length)
  assert(edgesScanned / 2000 <= MAX_EDGES_PER_POINT_QUERY, `${edgesScanned / 2000} edges scanned per point query`)
})
