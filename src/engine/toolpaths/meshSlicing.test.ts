/**
 * Tests for shared STL mesh slicing.
 *
 * Run with: npx tsx src/engine/toolpaths/meshSlicing.test.ts
 */

import { buildMeshSliceIndex, sliceMeshAtZ, sliceMeshAtZDetailed } from './meshSlicing'

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

testCubeMidSlice()
testSliceCacheReuse()
testSeparatedIslands()
testSmallOpenGapsAreStitched()
testMultipleSmallGapLoopsStaySeparate()
testOpenSliceIsNotClosedWithShortcut()

console.log('meshSlicing tests passed')
