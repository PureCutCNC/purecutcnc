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
 * Unit tests for the typed Clipper open-path seam (clipperOpenPaths.ts).
 * An open polyline crossing a closed square, intersected with that square,
 * should survive only as the portion inside the square.
 *
 * Run with: npx tsx src/engine/clipperOpenPaths.test.ts
 */

import ClipperLib from 'clipper-lib'
import type { ClipperPath } from './toolpaths/types'
import { addOpenSubject, openPathsFromPolyTree } from './clipperOpenPaths'

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function testOpenLineClippedByClosedSquare() {
  // Closed 100×100 square clip, and an open horizontal line spanning past both
  // sides at Y=50. Intersection keeps only the inside run, X∈[0,100].
  const square: ClipperPath = [
    { X: 0, Y: 0 },
    { X: 100, Y: 0 },
    { X: 100, Y: 100 },
    { X: 0, Y: 100 },
  ]
  const openLine: ClipperPath = [
    { X: -50, Y: 50 },
    { X: 150, Y: 50 },
  ]

  const clipper = new ClipperLib.Clipper()
  addOpenSubject(clipper, openLine)
  clipper.AddPaths([square], ClipperLib.PolyType.ptClip, true)

  const tree = new ClipperLib.PolyTree()
  clipper.Execute(
    ClipperLib.ClipType.ctIntersection,
    tree,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  )

  const open = openPathsFromPolyTree(tree)
  assert(open.length === 1, `one surviving open path (got ${open.length})`)

  const survivor = open[0]
  assert(survivor.length === 2, `survivor is a 2-point segment (got ${survivor.length})`)
  assert(survivor.every((p) => p.Y === 50), 'survivor stays on Y=50')

  const xs = survivor.map((p) => p.X).sort((a, b) => a - b)
  assert(xs[0] === 0 && xs[1] === 100, `survivor clipped to X∈[0,100] (got [${xs.join(', ')}])`)
  console.log('open line clipped by closed square: PASSED')
}

function testFullyOutsideLineHasNoSurvivor() {
  const square: ClipperPath = [
    { X: 0, Y: 0 },
    { X: 100, Y: 0 },
    { X: 100, Y: 100 },
    { X: 0, Y: 100 },
  ]
  const outside: ClipperPath = [
    { X: -50, Y: 200 },
    { X: 150, Y: 200 },
  ]

  const clipper = new ClipperLib.Clipper()
  addOpenSubject(clipper, outside)
  clipper.AddPaths([square], ClipperLib.PolyType.ptClip, true)

  const tree = new ClipperLib.PolyTree()
  clipper.Execute(
    ClipperLib.ClipType.ctIntersection,
    tree,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  )

  const open = openPathsFromPolyTree(tree)
  assert(open.length === 0, `line fully outside leaves no survivor (got ${open.length})`)
  console.log('fully-outside line has no survivor: PASSED')
}

try {
  testOpenLineClippedByClosedSquare()
  testFullyOutsideLineHasNoSurvivor()
  console.log('\nAll clipperOpenPaths tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
