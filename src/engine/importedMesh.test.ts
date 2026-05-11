/**
 * Tests for shared imported mesh parsing.
 *
 * Run with: npx tsx src/engine/importedMesh.test.ts
 */

import {
  loadImportedBufferGeometry,
  loadImportedTriangleMesh,
  loadObjBufferGeometry,
  loadObjTriangleMesh,
  loadPersistedBufferGeometry,
  loadPersistedTriangleMesh,
  loadStlBufferGeometry,
  loadStlTriangleMesh,
  normalizeImportedMeshForStorage,
  serializeImportedMesh,
  type ModelAxisOrientation,
} from './importedMesh'

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

function makeObjBase64(text: string): string {
  return btoa(text)
}

function makeObjBuffer(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

function makeWedgeObjBase64(): string {
  return makeObjBase64(`# wedge
v 0 0 0
v 2 0 0
v 0 3 4
f 1 2 3
`)
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

function testObjBounds(axisOrientation: ModelAxisOrientation, expected: { maxX: number; maxY: number; maxZ: number }): void {
  const mesh = loadObjTriangleMesh(makeWedgeObjBase64(), axisOrientation)
  if (!mesh) throw new Error(`OBJ mesh should parse for axis ${axisOrientation}`)
  assert(approx(mesh.bounds.minX, 0), `OBJ minX should be 0 for ${axisOrientation}`)
  assert(approx(mesh.bounds.minY, 0), `OBJ minY should be 0 for ${axisOrientation}`)
  assert(approx(mesh.bounds.minZ, 0), `OBJ minZ should be 0 for ${axisOrientation}`)
  assert(approx(mesh.bounds.maxX, expected.maxX), `OBJ maxX should be ${expected.maxX} for ${axisOrientation}, got ${mesh.bounds.maxX}`)
  assert(approx(mesh.bounds.maxY, expected.maxY), `OBJ maxY should be ${expected.maxY} for ${axisOrientation}, got ${mesh.bounds.maxY}`)
  assert(approx(mesh.bounds.maxZ, expected.maxZ), `OBJ maxZ should be ${expected.maxZ} for ${axisOrientation}, got ${mesh.bounds.maxZ}`)
}

function testAxisOrientations(): void {
  console.log('Testing STL axis orientation bounds...')
  testBounds('none', { maxX: 2, maxY: 3, maxZ: 4 })
  testBounds('yz', { maxX: 2, maxY: 4, maxZ: 3 })
  testBounds('xz', { maxX: 4, maxY: 3, maxZ: 2 })
  testBounds('xy', { maxX: 3, maxY: 2, maxZ: 4 })

  console.log('Testing OBJ axis orientation bounds...')
  testObjBounds('none', { maxX: 2, maxY: 3, maxZ: 4 })
  testObjBounds('yz', { maxX: 2, maxY: 4, maxZ: 3 })
  testObjBounds('xz', { maxX: 4, maxY: 3, maxZ: 2 })
  testObjBounds('xy', { maxX: 3, maxY: 2, maxZ: 4 })
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

function testGenericFormatDispatch(): void {
  console.log('Testing generic imported model format dispatch...')
  const base64 = makeAsciiStlBase64()
  const mesh = loadImportedTriangleMesh('stl', base64, 'none')
  const geometry = loadImportedBufferGeometry('stl', base64, 'none', true)
  assert(mesh !== null, 'generic triangle mesh dispatch should load STL')
  assert(geometry !== null, 'generic buffer geometry dispatch should load STL')

  const objBase64 = makeWedgeObjBase64()
  const objMesh = loadImportedTriangleMesh('obj', objBase64, 'none')
  const objGeometry = loadImportedBufferGeometry('obj', objBase64, 'none', true)
  assert(objMesh !== null, 'generic triangle mesh dispatch should load OBJ')
  assert(objGeometry !== null, 'generic buffer geometry dispatch should load OBJ')
}

function testArrayBufferModelInput(): void {
  console.log('Testing ArrayBuffer model input...')
  const objBuffer = makeObjBuffer(`# wedge
v 0 0 0
v 2 0 0
v 0 3 4
f 1 2 3
`)
  const mesh = loadImportedTriangleMesh('obj', objBuffer, 'none')
  const geometry = loadImportedBufferGeometry('obj', objBuffer, 'none', false)
  assert(mesh !== null, 'ArrayBuffer OBJ input should parse')
  assert(geometry !== null, 'ArrayBuffer OBJ input should build geometry')
  assert(mesh !== null && approx(mesh.bounds.maxZ, 4), `expected ArrayBuffer OBJ maxZ=4, got ${mesh?.bounds.maxZ}`)
}

function testObjFaceSyntaxAndTriangulation(): void {
  console.log('Testing OBJ face syntax and triangulation...')
  const obj = makeObjBase64(`
# square with texture and normal indices
v 0 0 0
v 2 0 0
v 2 2 0
v 0 2 0
v 1 3 0
vt 0 0
vn 0 0 1
o part
g main
s off
usemtl ignored
f 1/1/1 2/1/1 3/1/1 4/1/1 5/1/1
f -5//1 -4//1 -3//1
`)
  const mesh = loadObjTriangleMesh(obj, 'none')
  if (!mesh) throw new Error('OBJ mesh should parse common face syntax')
  assert(mesh.index.length === 12, `expected 4 triangles from n-gon plus negative-index triangle, got ${mesh.index.length / 3}`)
  assert(approx(mesh.bounds.maxX, 2), `expected OBJ maxX=2, got ${mesh.bounds.maxX}`)
  assert(approx(mesh.bounds.maxY, 3), `expected OBJ maxY=3, got ${mesh.bounds.maxY}`)
}

function testObjInvalidFaces(): void {
  console.log('Testing OBJ invalid faces are rejected...')
  const obj = makeObjBase64(`
v 0 0 0
v 1 0 0
v 0 1 0
f 0 1 2
`)
  assert(loadObjTriangleMesh(obj, 'none') === null, 'OBJ with only invalid face index 0 should not load')
}

function testObjGeometryCloneCache(): void {
  console.log('Testing OBJ buffer geometry cache clone behavior...')
  const base64 = makeWedgeObjBase64()
  const first = loadObjBufferGeometry(base64, 'none', false)
  const second = loadObjBufferGeometry(base64, 'none', false)
  if (!first || !second) throw new Error('OBJ geometry should parse')
  assert(first !== second, 'OBJ buffer geometry cache should return clones for mutable callers')

  first.translate(100, 0, 0)
  first.computeBoundingBox()
  second.computeBoundingBox()
  const firstBounds = first.boundingBox
  const secondBounds = second.boundingBox
  if (!firstBounds || !secondBounds) throw new Error('OBJ bounding boxes should compute')
  assert(firstBounds.min.x > 99, 'first OBJ geometry should be translated')
  assert(approx(secondBounds.min.x, 0), 'second OBJ geometry should not inherit first geometry mutation')
}

function testPersistedMeshRoundTrip(): void {
  console.log('Testing persisted imported mesh round trip...')
  const parsed = loadObjTriangleMesh(makeWedgeObjBase64(), 'none')
  if (!parsed) throw new Error('OBJ mesh should parse')

  const normalized = normalizeImportedMeshForStorage(parsed, 2)
  const persisted = serializeImportedMesh(normalized, 'obj')
  const decoded = loadPersistedTriangleMesh(persisted)
  if (!decoded) throw new Error('persisted mesh should decode')

  assert(decoded.positions.length === normalized.positions.length, 'decoded positions length should match')
  assert(decoded.index.length === normalized.index.length, 'decoded index length should match')
  assert(approx(decoded.bounds.maxX, 4), `expected decoded maxX=4, got ${decoded.bounds.maxX}`)
  assert(approx(decoded.bounds.maxY, 6), `expected decoded maxY=6, got ${decoded.bounds.maxY}`)
  assert(approx(decoded.bounds.maxZ, 8), `expected decoded maxZ=8, got ${decoded.bounds.maxZ}`)

  const firstGeometry = loadPersistedBufferGeometry(persisted, false)
  const secondGeometry = loadPersistedBufferGeometry(persisted, false)
  if (!firstGeometry || !secondGeometry) throw new Error('persisted geometry should load')
  assert(firstGeometry !== secondGeometry, 'persisted geometry cache should return mutable clones')
}

testAxisOrientations()
testTriangleMeshCacheReuse()
testGeometryCloneCache()
testGenericFormatDispatch()
testArrayBufferModelInput()
testObjFaceSyntaxAndTriangulation()
testObjInvalidFaces()
testObjGeometryCloneCache()
testPersistedMeshRoundTrip()

console.log('importedMesh tests passed')
