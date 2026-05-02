/**
 * Tests for shared STL mesh slicing.
 *
 * Run with: npx tsx src/engine/toolpaths/meshSlicing.test.ts
 */

import { buildMeshSliceIndex, sliceMeshAtZ } from './meshSlicing'

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

testCubeMidSlice()
testSliceCacheReuse()
testSeparatedIslands()

console.log('meshSlicing tests passed')
