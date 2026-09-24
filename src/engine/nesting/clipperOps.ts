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

// Integer-domain polygon operations for the packer. Everything here works on
// Clipper paths already scaled by NEST_SCALE; conversion happens at the edges
// of `packer.ts`.

import ClipperLib from 'clipper-lib'
import { DEFAULT_CLIPPER_SCALE } from '../toolpaths/geometry'
import type { ClipperPath, ClipperPoint } from '../toolpaths/types'
import { convexSum } from './convex'
import type { NestRing } from './types'

export const NEST_SCALE = DEFAULT_CLIPPER_SCALE

export interface IntBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export function ringToPath(ring: NestRing): ClipperPath {
  const path = ring.map((p) => ({ X: Math.round(p.x * NEST_SCALE), Y: Math.round(p.y * NEST_SCALE) }))
  const first = path[0]
  const last = path[path.length - 1]
  if (path.length > 1 && first.X === last.X && first.Y === last.Y) path.pop()
  return path
}

export function pathToRing(path: ClipperPath): NestRing {
  return path.map((p) => ({ x: p.X / NEST_SCALE, y: p.Y / NEST_SCALE }))
}

/**
 * Rotates a ring about the origin. Quarter turns use exact values so a 90°
 * placement does not pick up `cos(90°) = 6e-17` noise.
 */
export function rotateRing(ring: NestRing, degrees: number): NestRing {
  const quarter = ((Math.round(degrees / 90) % 4) + 4) % 4
  if (Math.abs(degrees / 90 - Math.round(degrees / 90)) < 1e-12) {
    const [c, s] = [[1, 0], [0, 1], [-1, 0], [0, -1]][quarter]
    return ring.map((p) => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c }))
  }
  const radians = (degrees * Math.PI) / 180
  const c = Math.cos(radians)
  const s = Math.sin(radians)
  return ring.map((p) => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c }))
}

function execute(clipType: number, subject: ClipperPath[], clip: ClipperPath[]): ClipperPath[] {
  const clipper = new ClipperLib.Clipper()
  clipper.AddPaths(subject, ClipperLib.PolyType.ptSubject, true)
  if (clip.length > 0) clipper.AddPaths(clip, ClipperLib.PolyType.ptClip, true)
  const solution = new ClipperLib.Paths()
  clipper.Execute(clipType, solution, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)
  return solution
}

export function unionPaths(paths: ClipperPath[]): ClipperPath[] {
  if (paths.length === 0) return []
  return execute(ClipperLib.ClipType.ctUnion, paths, [])
}

export function differencePaths(subject: ClipperPath[], clip: ClipperPath[]): ClipperPath[] {
  if (subject.length === 0) return []
  return execute(ClipperLib.ClipType.ctDifference, subject, clip)
}

/**
 * The outer boundaries of the union of `paths`, with every hole filled in.
 * Filling is the conservative direction for both footprints and no-fit
 * polygons: it can only forbid a position, never permit an overlap.
 */
export function outerContours(paths: ClipperPath[]): ClipperPath[] {
  if (paths.length === 0) return []
  const clipper = new ClipperLib.Clipper()
  clipper.AddPaths(paths, ClipperLib.PolyType.ptSubject, true)
  const tree = new ClipperLib.PolyTree()
  clipper.Execute(
    ClipperLib.ClipType.ctUnion,
    tree,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  )
  const children = tree.Childs?.() ?? tree.m_Childs ?? []
  return children.map((node) => orientPositive(node.Contour()))
}

function orientPositive(path: ClipperPath): ClipperPath {
  return ClipperLib.Clipper.Area(path) < 0 ? [...path].reverse() : path
}

/** Grows closed paths outward by `delta` integer units with square joins. */
export function growPaths(paths: ClipperPath[], delta: number): ClipperPath[] {
  if (paths.length === 0 || delta === 0) return paths
  const offset = new ClipperLib.ClipperOffset()
  offset.AddPaths(paths, ClipperLib.JoinType.jtSquare, ClipperLib.EndType.etClosedPolygon)
  const solution = new ClipperLib.Paths()
  offset.Execute(solution, delta)
  return solution
}

export function translatePaths(paths: ClipperPath[], dx: number, dy: number): ClipperPath[] {
  return paths.map((path) => path.map((p) => ({ X: p.X + dx, Y: p.Y + dy })))
}

export function pathsBox(paths: ClipperPath[]): IntBox {
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  for (const path of paths) {
    for (const p of path) {
      if (p.X < box.minX) box.minX = p.X
      if (p.Y < box.minY) box.minY = p.Y
      if (p.X > box.maxX) box.maxX = p.X
      if (p.Y > box.maxY) box.maxY = p.Y
    }
  }
  return box
}

function negate(path: ClipperPath): ClipperPath {
  return path.map((p) => ({ X: -p.X, Y: -p.Y }))
}

/**
 * No-fit polygon of `moving` around `fixed`: the translations at which the two
 * shapes' interiors overlap, `fixed ⊕ (−moving)`. Both are given as convex
 * pieces (see `convexPieces`); the result is filled (see {@link outerContours}).
 */
export function noFitPolygon(fixedPieces: ClipperPath[], movingPieces: ClipperPath[]): ClipperPath[] {
  if (fixedPieces.length === 0 || movingPieces.length === 0) return []
  // Union per moving piece, then merge pairwise. One Clipper union of every
  // sum at once is far slower on heavily overlapping input: 53 × 53 pieces
  // took 15 s that way and 105 ms this way, for the same region (#853).
  let level = movingPieces.map((moving) => {
    const reflected = negate(moving)
    return unionPaths(fixedPieces.map((fixed) => convexSum(fixed, reflected)))
  })
  while (level.length > 1) {
    const next: ClipperPath[][] = []
    for (let index = 0; index < level.length; index += 2) {
      next.push(index + 1 < level.length ? unionPaths([...level[index], ...level[index + 1]]) : level[index])
    }
    level = next
  }
  return outerContours(level[0])
}

/** Rotates integer paths about the origin (via the exact-quarter-turn ring rotation). */
export function rotatePaths(paths: ClipperPath[], degrees: number): ClipperPath[] {
  if (degrees === 0) return paths
  return paths.map((path) => ringToPath(rotateRing(pathToRing(path), degrees)))
}

export function rectPath(box: IntBox): ClipperPath {
  const points: ClipperPoint[] = [
    { X: box.minX, Y: box.minY },
    { X: box.maxX, Y: box.minY },
    { X: box.maxX, Y: box.maxY },
    { X: box.minX, Y: box.maxY },
  ]
  return points
}
