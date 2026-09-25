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
 * Convex decomposition and convex Minkowski sums (issue #844). The pieces must
 * be convex and tile the polygon exactly: their areas add up to the polygon's,
 * and their union is the polygon.
 *
 * Run with: npx tsx src/engine/nesting/convex.test.ts
 */

import ClipperLib from 'clipper-lib'
import type { ClipperPath } from '../toolpaths/types'
import { differencePaths, growPaths, noFitPolygon, outerContours } from './clipperOps'
import { convexHull, convexPieces, convexSum } from './convex'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const area = (path: ClipperPath) => ClipperLib.Clipper.Area(path)

function isConvex(path: ClipperPath): boolean {
  for (let i = 0; i < path.length; i += 1) {
    const o = path[i]
    const a = path[(i + 1) % path.length]
    const b = path[(i + 2) % path.length]
    if ((a.X - o.X) * (b.Y - o.Y) - (a.Y - o.Y) * (b.X - o.X) < 0) return false
  }
  return true
}

function star(points: number, outer: number, inner: number): ClipperPath {
  const path: ClipperPath = []
  for (let i = 0; i < points * 2; i += 1) {
    const angle = (i / (points * 2)) * Math.PI * 2
    const r = i % 2 === 0 ? outer : inner
    path.push({ X: Math.round(Math.cos(angle) * r), Y: Math.round(Math.sin(angle) * r) })
  }
  return path
}

function assertTiles(label: string, polygon: ClipperPath, maxPieces: number): void {
  const pieces = convexPieces(polygon)
  assert(pieces.every(isConvex), `${label}: every piece is convex`)
  const pieceArea = pieces.reduce((sum, piece) => sum + area(piece), 0)
  assert(pieceArea === area(polygon), `${label}: piece areas ${pieceArea} sum to the polygon's ${area(polygon)}`)
  const union = outerContours(pieces)
  assert(union.length === 1 && area(union[0]) === area(polygon), `${label}: pieces union back to the polygon`)
  assert(pieces.length <= maxPieces, `${label}: ${pieces.length} pieces, expected at most ${maxPieces}`)
}

function testDecomposition(): void {
  const square: ClipperPath = [{ X: 0, Y: 0 }, { X: 10, Y: 0 }, { X: 10, Y: 10 }, { X: 0, Y: 10 }]
  assertTiles('square', square, 1)
  const ell: ClipperPath = [
    { X: 0, Y: 0 }, { X: 30, Y: 0 }, { X: 30, Y: 10 }, { X: 10, Y: 10 }, { X: 10, Y: 30 }, { X: 0, Y: 30 },
  ]
  assertTiles('L', ell, 2)
  // Collinear points along an edge must not break clipping.
  const collinear: ClipperPath = [
    { X: 0, Y: 0 }, { X: 5, Y: 0 }, { X: 10, Y: 0 }, { X: 10, Y: 10 }, { X: 0, Y: 10 },
  ]
  assertTiles('collinear', collinear, 1)
  // Hertel–Mehlhorn stays within 4× optimal; a 12-point star needs 12 + 1.
  assertTiles('star', star(12, 1000, 400), 4 * 13)
}

function testConvexSum(): void {
  const a: ClipperPath = [{ X: 0, Y: 0 }, { X: 10, Y: 0 }, { X: 10, Y: 10 }, { X: 0, Y: 10 }]
  const b: ClipperPath = [{ X: 0, Y: 0 }, { X: 4, Y: 0 }, { X: 0, Y: 4 }]
  const sum = convexSum(a, b)
  assert(isConvex(sum) && area(sum) > 0, 'sum is convex and positively wound')
  // Square 10 ⊕ right triangle 4: 100 + 2·(10·4) + 8 = 188.
  assert(area(sum) === 188, `sum area is 188, got ${area(sum)}`)
  assert(convexHull([{ X: 0, Y: 0 }, { X: 5, Y: 5 }, { X: 10, Y: 0 }, { X: 5, Y: 1 }]).length === 3, 'hull drops the interior point')
}

function testNoFitPolygonMatchesOneShotUnion(): void {
  // A concave, many-piece shape: the case where the staged union matters (#853).
  const shape = star(9, 20000, 7000)
  const pieces = convexPieces(shape)
  const reflected = pieces.map((piece) => piece.map((p) => ({ X: -p.X, Y: -p.Y })))
  const oneShot = outerContours(reflected.flatMap((moving) => pieces.map((fixed) => convexSum(fixed, moving))))
  const staged = noFitPolygon(pieces, pieces)
  assert(staged.length === oneShot.length, `same number of outer contours: ${staged.length} vs ${oneShot.length}`)
  // Intersection points round differently between the two union orders, so
  // the boundaries may differ by a unit; the packer's forbidden regions are
  // grown by two. Within one unit, each must cover the other.
  const uncovered = (a: ClipperPath[], b: ClipperPath[]) => differencePaths(a, growPaths(b, 1))
    .reduce((sum, path) => sum + Math.abs(area(path)), 0)
  assert(uncovered(oneShot, staged) === 0, `staged NFP covers the one-shot NFP: ${uncovered(oneShot, staged)} left over`)
  assert(uncovered(staged, oneShot) === 0, `and adds nothing beyond it: ${uncovered(staged, oneShot)} extra`)
}

testDecomposition()
testConvexSum()
testNoFitPolygonMatchesOneShotUnion()
console.log('All convex decomposition tests passed')
