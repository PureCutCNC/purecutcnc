/**
 * Tests for shared imported mesh parsing.
 *
 * Run with: npx tsx src/engine/importedMesh.test.ts
 */

import { loadStlBufferGeometry, loadStlTriangleMesh, type ModelAxisOrientation } from './importedMesh'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(a: number, b: number, epsilon = 1e-6): boolean {
  return Math.abs(a - b) < epsilon
}

function makeAsciiStlBase64(): string {
  const stl = `solid wedge
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 2 0 0
      vertex 0 3 4
    endloop
  endfacet
endsolid wedge
`
  return btoa(stl)
}

function testBounds(axisOrientation: ModelAxisOrientation, expected: { maxX: number; maxY: number; maxZ: number }): void {
  const mesh = loadStlTriangleMesh(makeAsciiStlBase64(), axisOrientation)
  if (!mesh) throw new Error(`mesh should parse for axis ${axisOrientation}`)
  assert(approx(mesh.bounds.minX, 0), `minX should be 0 for ${axisOrientation}`)
  assert(approx(mesh.bounds.minY, 0), `minY should be 0 for ${axisOrientation}`)
  assert(approx(mesh.bounds.minZ, 0), `minZ should be 0 for ${axisOrientation}`)
  assert(approx(mesh.bounds.maxX, expected.maxX), `maxX should be ${expected.maxX} for ${axisOrientation}, got ${mesh.bounds.maxX}`)
  assert(approx(mesh.bounds.maxY, expected.maxY), `maxY should be ${expected.maxY} for ${axisOrientation}, got ${mesh.bounds.maxY}`)
  assert(approx(mesh.bounds.maxZ, expected.maxZ), `maxZ should be ${expected.maxZ} for ${axisOrientation}, got ${mesh.bounds.maxZ}`)
}

function testAxisOrientations(): void {
  console.log('Testing STL axis orientation bounds...')
  testBounds('none', { maxX: 2, maxY: 3, maxZ: 4 })
  testBounds('yz', { maxX: 2, maxY: 4, maxZ: 3 })
  testBounds('xz', { maxX: 4, maxY: 3, maxZ: 2 })
  testBounds('xy', { maxX: 3, maxY: 2, maxZ: 4 })
}

function testTriangleMeshCacheReuse(): void {
  console.log('Testing triangle mesh cache reuse...')
  const base64 = makeAsciiStlBase64()
  const first = loadStlTriangleMesh(base64, 'none')
  const second = loadStlTriangleMesh(base64, 'none')
  if (!first || !second) throw new Error('mesh should parse')
  assert(first === second, 'triangle mesh cache should return the same immutable mesh object')
}

function testGeometryCloneCache(): void {
  console.log('Testing buffer geometry cache clone behavior...')
  const base64 = makeAsciiStlBase64()
  const first = loadStlBufferGeometry(base64, 'none', false)
  const second = loadStlBufferGeometry(base64, 'none', false)
  if (!first || !second) throw new Error('geometry should parse')
  assert(first !== second, 'buffer geometry cache should return clones for mutable callers')

  first.translate(100, 0, 0)
  first.computeBoundingBox()
  second.computeBoundingBox()
  const firstBounds = first.boundingBox
  const secondBounds = second.boundingBox
  if (!firstBounds || !secondBounds) throw new Error('bounding boxes should compute')
  assert(firstBounds.min.x > 99, 'first geometry should be translated')
  assert(approx(secondBounds.min.x, 0), 'second geometry should not inherit first geometry mutation')
}

testAxisOrientations()
testTriangleMeshCacheReuse()
testGeometryCloneCache()

console.log('importedMesh tests passed')
