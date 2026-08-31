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
 * Tests for shared STL mesh slicing.
 *
 * Run with: npx tsx src/engine/toolpaths/meshSlicing.test.ts
 */

import { buildMeshSliceIndex, sliceMeshAtZ, sliceMeshAtZDetailed } from './meshSlicing'
import { cpuRatio } from '../../test/cpuRatio'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(a: number, b: number, epsilon = 1e-6): boolean {
  return Math.abs(a - b) < epsilon
}

function polygonArea(poly: Array<[number, number]>): number {
  let area = 0
  for (let i = 0; i < poly.length - 1; i += 1) {
    const a = poly[i]
    const b = poly[i + 1]
    area += a[0] * b[1] - b[0] * a[1]
  }
  return Math.abs(area) / 2
}

function polygonBounds(poly: Array<[number, number]>): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const [x, y] of poly) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return { minX, maxX, minY, maxY }
}

function appendBox(
  vertices: number[],
  indices: number[],
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  minZ: number,
  maxZ: number,
): void {
  const offset = vertices.length / 3
  vertices.push(
    minX, minY, minZ,
    maxX, minY, minZ,
    maxX, maxY, minZ,
    minX, maxY, minZ,
    minX, minY, maxZ,
    maxX, minY, maxZ,
    maxX, maxY, maxZ,
    minX, maxY, maxZ,
  )

  const faces = [
    [0, 1, 2], [0, 2, 3],
    [4, 6, 5], [4, 7, 6],
    [0, 4, 5], [0, 5, 1],
    [1, 5, 6], [1, 6, 2],
    [2, 6, 7], [2, 7, 3],
    [3, 7, 4], [3, 4, 0],
  ]

  for (const face of faces) {
    indices.push(offset + face[0], offset + face[1], offset + face[2])
  }
}

function makeBoxes(boxes: Array<[number, number, number, number, number, number]>): { positions: Float32Array; index: Uint32Array } {
  const vertices: number[] = []
  const indices: number[] = []
  for (const box of boxes) {
    appendBox(vertices, indices, ...box)
  }
  return {
    positions: new Float32Array(vertices),
    index: new Uint32Array(indices),
  }
}

function appendVerticalQuad(
  vertices: number[],
  indices: number[],
  a: [number, number],
  b: [number, number],
  minZ = -1,
  maxZ = 1,
): void {
  const offset = vertices.length / 3
  vertices.push(
    a[0], a[1], minZ,
    b[0], b[1], minZ,
    b[0], b[1], maxZ,
    a[0], a[1], maxZ,
  )
  indices.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3)
}

// ── issue #689: an open contour must arrive as one chain ───────────────────
//
// `chainSegments` leaves its start node in one direction. On a closed ring that
// is invisible, because the walk arrives back where it began. On an open one it
// decides everything: `chooseStartNode` can prefer a real endpoint only when the
// first unvisited edge happens to touch one, so the walk starts mid-chain and
// stops as soon as it runs into its own visited edges, and the outer loop emits
// the remainder two edges at a time. `stitchOpenChains` is cubic in that count.
//
// One node split by a `ptKey` rounding tie is enough to reach it. On the
// 14,000-point relief in `finishSurfaceWaterlineDecimation.test.ts` a crossing
// landed on x = 30.5447945 — exactly the boundary `toFixed(6)` rounds at — which
// put a 28,000-segment ring in as 12,333 chains, and the operation never
// returned.

/** Columns of a vertical wall, evenly spaced around `span` radians. */
function ringColumns(count: number, radius: number, span: number): Array<[number, number]> {
  const columns: Array<[number, number]> = []
  for (let i = 0; i < count; i += 1) {
    const theta = (i / count) * span
    columns.push([radius * Math.cos(theta), radius * Math.sin(theta)])
  }
  return columns
}

/** One vertical quad per column pair; `closed` adds the wrap-around quad. */
function wallMesh(
  columns: Array<[number, number]>,
  closed: boolean,
): { positions: Float32Array; index: Uint32Array } {
  const vertices: number[] = []
  const indices: number[] = []
  const quads = closed ? columns.length : columns.length - 1
  for (let i = 0; i < quads; i += 1) {
    appendVerticalQuad(vertices, indices, columns[i], columns[(i + 1) % columns.length])
  }
  return { positions: new Float32Array(vertices), index: new Uint32Array(indices) }
}

/**
 * Subject and reference size for the cost ratio below, in quads. Big enough
 * that a regression is unmistakable, small enough that it fails rather than
 * hangs: at 400 quads the fragmented walk takes seconds, not minutes.
 */
const OPEN_CONTOUR_RATIO_QUADS = 400

/**
 * How much more the open contour may cost than the closed one.
 *
 * Measured over four runs each, node v26.0.0 on an i7-8850H, this file run on
 * its own. Worst row of each — highest baseline against lowest regression:
 *
 *     second walk present   subject 2.3ms     reference 2.2ms   ratio 1.07
 *     second walk deleted   subject 2759.5ms  reference 2.3ms   ratio 1184
 *
 * The reference does not move across that mutation, which is why it is the
 * right one: a closed ring returns `closed` from the first walk and never
 * reaches the stitcher, so it cannot benefit from the fix being guarded. The
 * geometric mid-point of that pair is sqrt(1.07 * 1184) = 35.6, leaving 33x of
 * headroom over the baseline and 34x under the regression.
 */
const MAX_OPEN_CONTOUR_COST_RATIO = 35

function testCubeMidSlice(): void {
  console.log('Testing cube mid-slice...')

  const mesh = makeBoxes([[0, 10, 0, 10, -5, 5]])
  const sliceIndex = buildMeshSliceIndex(mesh.positions, mesh.index)
  const polygons = sliceMeshAtZ(sliceIndex, 0)

  assert(polygons.length === 1, `expected 1 polygon, got ${polygons.length}`)
  assert(polygons[0].length >= 5, `expected closed polygon, got ${polygons[0].length} points`)

  const first = polygons[0][0]
  const last = polygons[0][polygons[0].length - 1]
  assert(approx(first[0], last[0]) && approx(first[1], last[1]), 'polygon should be explicitly closed')
  assert(approx(polygonArea(polygons[0]), 100), `expected area 100, got ${polygonArea(polygons[0])}`)

  const bounds = polygonBounds(polygons[0])
  assert(approx(bounds.minX, 0) && approx(bounds.maxX, 10), `unexpected X bounds ${bounds.minX}..${bounds.maxX}`)
  assert(approx(bounds.minY, 0) && approx(bounds.maxY, 10), `unexpected Y bounds ${bounds.minY}..${bounds.maxY}`)
}

function testSliceCacheReuse(): void {
  console.log('Testing slice cache reuse...')

  const mesh = makeBoxes([[0, 10, 0, 10, -5, 5]])
  const sliceIndex = buildMeshSliceIndex(mesh.positions, mesh.index)
  const first = sliceMeshAtZ(sliceIndex, 0)
  const second = sliceMeshAtZ(sliceIndex, 0)

  assert(first === second, 'same Z slice should reuse cached polygon array')
}

function testSeparatedIslands(): void {
  console.log('Testing separated island slices...')

  const mesh = makeBoxes([
    [0, 10, 0, 10, -5, 5],
    [20, 25, 20, 25, -5, 5],
  ])
  const sliceIndex = buildMeshSliceIndex(mesh.positions, mesh.index)
  const polygons = sliceMeshAtZ(sliceIndex, 0)
  const areas = polygons.map(polygonArea).sort((a, b) => a - b)

  assert(polygons.length === 2, `expected 2 polygons, got ${polygons.length}`)
  assert(approx(areas[0], 25), `expected smaller area 25, got ${areas[0]}`)
  assert(approx(areas[1], 100), `expected larger area 100, got ${areas[1]}`)
}

function testSmallOpenGapsAreStitched(): void {
  console.log('Testing small open gaps are stitched...')

  const gap = 1e-5
  const vertices: number[] = []
  const indices: number[] = []
  appendVerticalQuad(vertices, indices, [0, 0], [10, 0])
  appendVerticalQuad(vertices, indices, [10 + gap, 0], [10 + gap, 10])
  appendVerticalQuad(vertices, indices, [10, 10 + gap], [0, 10 + gap])
  appendVerticalQuad(vertices, indices, [-gap, 10], [-gap, 0])

  const sliceIndex = buildMeshSliceIndex(new Float32Array(vertices), new Uint32Array(indices))
  const result = sliceMeshAtZDetailed(sliceIndex, 0)

  assert(result.polygons.length === 1, `expected stitched polygon, got ${result.polygons.length}`)
  assert(result.openChainCount === 0, `expected no remaining open chains, got ${result.openChainCount}`)
  assert(approx(polygonArea(result.polygons[0]), 100, 1e-3), `expected area near 100, got ${polygonArea(result.polygons[0])}`)
}

function testMultipleSmallGapLoopsStaySeparate(): void {
  console.log('Testing multiple small-gap loops stay separate...')

  const gap = 1e-5
  const vertices: number[] = []
  const indices: number[] = []
  appendVerticalQuad(vertices, indices, [0, 0], [10, 0])
  appendVerticalQuad(vertices, indices, [10 + gap, 0], [10 + gap, 10])
  appendVerticalQuad(vertices, indices, [10, 10 + gap], [0, 10 + gap])
  appendVerticalQuad(vertices, indices, [-gap, 10], [-gap, 0])
  appendVerticalQuad(vertices, indices, [20, 20], [25, 20])
  appendVerticalQuad(vertices, indices, [25 + gap, 20], [25 + gap, 25])
  appendVerticalQuad(vertices, indices, [25, 25 + gap], [20, 25 + gap])
  appendVerticalQuad(vertices, indices, [20 - gap, 25], [20 - gap, 20])

  const sliceIndex = buildMeshSliceIndex(new Float32Array(vertices), new Uint32Array(indices))
  const result = sliceMeshAtZDetailed(sliceIndex, 0)
  const areas = result.polygons.map(polygonArea).sort((a, b) => a - b)

  assert(result.polygons.length === 2, `expected two separate stitched polygons, got ${result.polygons.length}`)
  assert(result.openChainCount === 0, `expected no remaining open chains, got ${result.openChainCount}`)
  assert(approx(areas[0], 25, 1e-3), `expected smaller area near 25, got ${areas[0]}`)
  assert(approx(areas[1], 100, 1e-3), `expected larger area near 100, got ${areas[1]}`)
}

function testOpenSliceIsNotClosedWithShortcut(): void {
  console.log('Testing open slice is not closed with shortcut...')

  const positions = new Float32Array([
    0, 0, -1,
    10, 0, -1,
    10, 5, -1,
    0, 0, 1,
    10, 0, 1,
    10, 5, 1,
  ])
  const index = new Uint32Array([
    0, 1, 4,
    0, 4, 3,
    1, 2, 5,
    1, 5, 4,
  ])
  const sliceIndex = buildMeshSliceIndex(positions, index)
  const result = sliceMeshAtZDetailed(sliceIndex, 0)
  const polygons = result.polygons

  assert(polygons.length === 0, `expected no closed polygons from open sliced wall, got ${polygons.length}`)
  assert(result.openChainCount > 0, 'expected open chains to be reported')
}

/**
 * A ring broken at exactly one node still slices to one contour.
 *
 * Issue #689's topology without its floating-point coincidence: the corner
 * shared by two neighbouring quads is displaced in one of them by more than
 * `ptKey`'s 1e-6 quantum and less than the stitch tolerance, so the ring
 * reaches `chainSegments` as a single open path and the stitcher closes it
 * again. What this pins is the join — the second walk's half is prepended
 * reversed, and getting that backwards folds the contour and wrecks its area.
 */
function testRingSplitAtOneNodeSlicesAsOneContour(): void {
  console.log('Testing a ring split at one node slices as one contour...')

  const half = 10
  const perSide = 8
  const corners: Array<[number, number]> = [[-half, -half], [half, -half], [half, half], [-half, half]]
  const columns: Array<[number, number]> = []
  for (let side = 0; side < 4; side += 1) {
    const from = corners[side]
    const to = corners[(side + 1) % 4]
    for (let step = 0; step < perSide; step += 1) {
      const t = step / perSide
      columns.push([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t])
    }
  }

  const split = 1e-5
  const vertices: number[] = []
  const indices: number[] = []
  for (let i = 0; i < columns.length; i += 1) {
    const a = columns[i]
    const b = columns[(i + 1) % columns.length]
    const start: [number, number] = i === 1 ? [a[0], a[1] + split] : a
    appendVerticalQuad(vertices, indices, start, b)
  }

  const sliceIndex = buildMeshSliceIndex(new Float32Array(vertices), new Uint32Array(indices))
  const result = sliceMeshAtZDetailed(sliceIndex, 0)

  assert(result.polygons.length === 1, `expected one contour, got ${result.polygons.length}`)
  assert(result.openChainCount === 0, `expected the split to stitch closed, got ${result.openChainCount} open`)

  const polygon = result.polygons[0]
  // Two crossings per quad — one on the shared vertical edge, one on the quad's
  // diagonal — plus the node the split adds, plus the explicit closing point.
  assert(polygon.length >= columns.length * 2,
    `expected every crossing kept, got ${polygon.length} points`)
  assert(approx(polygonArea(polygon), (half * 2) ** 2, 1e-2),
    `expected area near ${(half * 2) ** 2}, got ${polygonArea(polygon)}`)
}

/**
 * An open contour costs about what the same wall costs closed.
 *
 * Both halves are the same wall at the same segment count through the same
 * code; only whether the ring wraps differs. See `MAX_OPEN_CONTOUR_COST_RATIO`
 * for the measured rows.
 */
function testOpenContourCostsWhatTheClosedRingCosts(): void {
  console.log('Testing open-contour slicing cost against the closed ring...')

  const openMesh = wallMesh(ringColumns(OPEN_CONTOUR_RATIO_QUADS + 1, 10, Math.PI * 2), false)
  const closedMesh = wallMesh(ringColumns(OPEN_CONTOUR_RATIO_QUADS, 10, Math.PI * 2), true)
  const openIndex = buildMeshSliceIndex(openMesh.positions, openMesh.index)
  const closedIndex = buildMeshSliceIndex(closedMesh.positions, closedMesh.index)

  const openResult = sliceMeshAtZDetailed(openIndex, 0)
  const closedResult = sliceMeshAtZDetailed(closedIndex, 0)
  assert(openResult.segmentCount === closedResult.segmentCount,
    `subject and reference must slice the same segment count, `
    + `${openResult.segmentCount} vs ${closedResult.segmentCount}`)
  assert(openResult.openChainCount === 1,
    `subject must slice to one open contour, got ${openResult.openChainCount}`)
  assert(closedResult.openChainCount === 0,
    `reference must slice closed, got ${closedResult.openChainCount}`)

  const { ratio, subjectMs, referenceMs } = cpuRatio(
    { run: () => { sliceMeshAtZDetailed(openIndex, 0) }, setup: () => openIndex.sliceCache.clear() },
    { run: () => { sliceMeshAtZDetailed(closedIndex, 0) }, setup: () => closedIndex.sliceCache.clear() },
  )
  console.log(`  open ${subjectMs.toFixed(1)}ms / closed ${referenceMs.toFixed(1)}ms = ${ratio.toFixed(2)}x`)

  assert(ratio < MAX_OPEN_CONTOUR_COST_RATIO,
    `open contour cost ${ratio.toFixed(2)}x the closed ring `
    + `(${subjectMs.toFixed(1)}ms vs ${referenceMs.toFixed(1)}ms), budget ${MAX_OPEN_CONTOUR_COST_RATIO}x`)
}

testCubeMidSlice()
testSliceCacheReuse()
testSeparatedIslands()
testSmallOpenGapsAreStitched()
testMultipleSmallGapLoopsStaySeparate()
testOpenSliceIsNotClosedWithShortcut()
testRingSplitAtOneNodeSlicesAsOneContour()
testOpenContourCostsWhatTheClosedRingCosts()

console.log('meshSlicing tests passed')
