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

// "Does some other pass already reach this stock?" — a swept-envelope test
// over tool centrelines (issue #546).
//
// A cutter of radius r following a centreline removes everything within r of
// it, so a point is already machined exactly when it lies within r of some
// centreline. That one predicate decides whether a corner arc that cut across
// its own source vertices needs a cleanup loop: on a clearing ring the
// neighbouring rings sit one stepover away and sweep a tool radius, so where
// the stepover is comfortably under the radius they reach the leftover tip on
// their own and the loop is pure wasted motion. Where they do not — a stepover
// approaching the tool diameter, or a wall ring with nothing outside it — the
// caller has to clean the tip itself.
//
// Centrelines are bucketed into a uniform grid at one radius per cell, with
// each segment registered into every cell its radius-expanded bounding box
// touches, so a query reads one cell.

import type { Point } from '../../types/project'

const EPS = 1e-12

interface Segment {
  ax: number
  ay: number
  bx: number
  by: number
}

export interface SweptCoverage {
  /** True when the point lies within one tool radius of some centreline. */
  covers: (x: number, y: number) => boolean
  /** Number of centreline segments indexed; 0 means nothing is covered. */
  segmentCount: number
}

function distanceToSegment(x: number, y: number, segment: Segment): number {
  const dx = segment.bx - segment.ax
  const dy = segment.by - segment.ay
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared <= EPS) return Math.hypot(x - segment.ax, y - segment.ay)
  const t = Math.max(0, Math.min(1,
    ((x - segment.ax) * dx + (y - segment.ay) * dy) / lengthSquared))
  return Math.hypot(x - (segment.ax + dx * t), y - (segment.ay + dy * t))
}

/**
 * Index closed centreline polylines as a swept envelope of the given radius.
 *
 * An empty centreline set covers nothing, which is the safe answer: a caller
 * asking "has anything else already been here?" with nothing to compare
 * against must be told no.
 */
export function buildSweptCoverage(centrelines: Point[][], toolRadius: number): SweptCoverage {
  const segments: Segment[] = []
  if (toolRadius > 0 && Number.isFinite(toolRadius)) {
    for (const line of centrelines) {
      if (line.length < 2) continue
      for (let index = 0; index < line.length; index += 1) {
        const a = line[index]
        const b = line[(index + 1) % line.length]
        if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) continue
        if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) continue
        if (Math.hypot(b.x - a.x, b.y - a.y) <= EPS) continue
        segments.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y })
      }
    }
  }
  if (segments.length === 0) {
    return { covers: () => false, segmentCount: 0 }
  }

  const cell = toolRadius
  const cells = new Map<string, Segment[]>()
  const key = (col: number, row: number): string => `${col},${row}`
  for (const segment of segments) {
    // Expanding by the radius here is what lets a query read a single cell:
    // any point within the radius of the segment falls inside the expanded box.
    const minCol = Math.floor((Math.min(segment.ax, segment.bx) - toolRadius) / cell)
    const maxCol = Math.floor((Math.max(segment.ax, segment.bx) + toolRadius) / cell)
    const minRow = Math.floor((Math.min(segment.ay, segment.by) - toolRadius) / cell)
    const maxRow = Math.floor((Math.max(segment.ay, segment.by) + toolRadius) / cell)
    for (let col = minCol; col <= maxCol; col += 1) {
      for (let row = minRow; row <= maxRow; row += 1) {
        const id = key(col, row)
        const bucket = cells.get(id)
        if (bucket) bucket.push(segment)
        else cells.set(id, [segment])
      }
    }
  }

  return {
    segmentCount: segments.length,
    covers: (x: number, y: number): boolean => {
      const bucket = cells.get(key(Math.floor(x / cell), Math.floor(y / cell)))
      if (!bucket) return false
      for (const segment of bucket) {
        if (distanceToSegment(x, y, segment) <= toolRadius) return true
      }
      return false
    },
  }
}

/**
 * True when everything a cutter sweeping `path` would remove is already inside
 * `covered`.
 *
 * This is the question `pathIsCovered` only looks like it answers. A path whose
 * *centreline* runs through swept territory can still remove material either
 * side of it, so asking about the line is not asking about the metal. The
 * difference is not academic: a corner cleanup loop was dropped on exactly that
 * reasoning and left a 0.21 x 0.05in patch of stock standing 0.0057in proud.
 *
 * The area is rasterised rather than solved, over the path's bounding box grown
 * by one radius, and no region test is needed: callers hand this a loop that
 * has already been checked against the tool-centre domain, so every cell its
 * disc reaches is material by construction.
 */
export function sweptRegionIsCovered(
  path: Point[],
  covered: SweptCoverage,
  toolRadius: number,
  cellSize: number,
): boolean {
  if (path.length === 0 || !(toolRadius > 0) || !(cellSize > 0)) return false
  if (covered.segmentCount === 0) return false
  const swept = buildSweptCoverage([path], toolRadius)
  if (swept.segmentCount === 0) return false
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const point of path) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false
    minX = Math.min(minX, point.x)
    maxX = Math.max(maxX, point.x)
    minY = Math.min(minY, point.y)
    maxY = Math.max(maxY, point.y)
  }
  for (let x = minX - toolRadius; x <= maxX + toolRadius; x += cellSize) {
    for (let y = minY - toolRadius; y <= maxY + toolRadius; y += cellSize) {
      if (!swept.covers(x, y)) continue
      if (!covered.covers(x, y)) return false
    }
  }
  return true
}

/**
 * True when every point of `path` is inside the swept envelope.
 *
 * The path is sampled rather than solved: `sampleStep` is the spacing along
 * each segment, and the endpoints of every segment are always tested, so a
 * short segment is never skipped. A non-positive step, an empty path, or a
 * coverage with nothing in it all answer false — this question only ever gates
 * *removing* motion, so an answer it cannot establish has to be no.
 */
export function pathIsCovered(
  path: Point[],
  coverage: SweptCoverage,
  sampleStep: number,
): boolean {
  if (path.length === 0 || !(sampleStep > 0) || coverage.segmentCount === 0) return false
  if (!coverage.covers(path[0].x, path[0].y)) return false
  for (let index = 0; index + 1 < path.length; index += 1) {
    const a = path[index]
    const b = path[index + 1]
    if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) return false
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / sampleStep))
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps
      if (!coverage.covers(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)) return false
    }
  }
  return true
}
