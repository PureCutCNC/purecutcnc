/**
 * Tests for shared imported mesh parsing.
 *
 * Run with: npx tsx src/engine/importedMesh.test.ts
 */

import * as THREE from 'three'
import {
  MAX_UINT16_INDEX,
  loadImportedBufferGeometry,
  loadImportedTriangleMesh,
  loadObjBufferGeometry,
  loadObjTriangleMesh,
  loadPersistedBufferGeometry,
  loadPersistedBufferGeometryChunks,
  loadPersistedTriangleMesh,
  loadStlBufferGeometry,
  loadStlTriangleMesh,
  normalizeImportedMeshForStorage,
  serializeImportedMesh,
  triangleMeshToBufferGeometryChunks,
  type ImportedTriangleMesh,
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

// Render-safety invariant: every BufferGeometry destined for a Three.js Mesh
// must use a Uint16Array index buffer with at most MAX_UINT16_INDEX vertices.
// This is the structural guarantee that prevents the Chrome/macOS Uint32-index
// rendering bug from recurring.
function assertWebGLSafe(label: string, chunks: THREE.BufferGeometry[]): void {
  assert(chunks.length > 0, `${label}: expected at least one chunk`)
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i]
    const position = chunk.getAttribute('position')
    const index = chunk.getIndex()
    if (!index) throw new Error(`${label}: chunk ${i} is non-indexed`)
    assert(
      index.array instanceof Uint16Array,
      `${label}: chunk ${i} must use Uint16Array indices, got ${index.array.constructor.name}`,
    )
    assert(
      position.count <= MAX_UINT16_INDEX,
      `${label}: chunk ${i} has ${position.count} vertices, exceeds ${MAX_UINT16_INDEX}`,
    )
  }
}

function makeTriangleMesh(positions: Float32Array, index: Uint32Array): ImportedTriangleMesh {
  let minX = Infinity, maxX = -Infinity
  let minY = Infinity, maxY = -Infinity
  let minZ = Infinity, maxZ = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2]
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
  }
  return { positions, index, bounds: { minX, maxX, minY, maxY, minZ, maxZ } }
}

function testChunkerSmallMeshSingleUint16Chunk(): void {
  console.log('Testing chunker: small mesh stays single Uint16 chunk...')
  const vertexCount = 1000
  const triangleCount = 500
  const positions = new Float32Array(vertexCount * 3)
  for (let i = 0; i < vertexCount; i += 1) {
    positions[i * 3] = i
    positions[i * 3 + 1] = 0
    positions[i * 3 + 2] = 0
  }
  const index = new Uint32Array(triangleCount * 3)
  for (let t = 0; t < triangleCount; t += 1) {
    index[t * 3] = t * 2
    index[t * 3 + 1] = t * 2 + 1
    index[t * 3 + 2] = (t * 2 + 2) % vertexCount
  }
  const mesh = makeTriangleMesh(positions, index)
  const chunks = triangleMeshToBufferGeometryChunks(mesh, false)
  assert(chunks.length === 1, `expected 1 chunk, got ${chunks.length}`)
  assertWebGLSafe('small-mesh', chunks)
  const position = chunks[0].getAttribute('position')
  const idx = chunks[0].getIndex()!
  assert(position.count === vertexCount, `expected ${vertexCount} verts, got ${position.count}`)
  assert(idx.count === triangleCount * 3, `expected ${triangleCount * 3} indices, got ${idx.count}`)
  for (const chunk of chunks) chunk.dispose()
}

function testChunkerLargeMeshSplits(): void {
  console.log('Testing chunker: large mesh splits into multiple Uint16 chunks...')
  // Construct a mesh where each triangle uses three fresh vertices, forcing
  // splits as the chunker walks triangles in order.
  const triangleCount = 33334
  const vertexCount = triangleCount * 3
  const positions = new Float32Array(vertexCount * 3)
  const index = new Uint32Array(triangleCount * 3)
  for (let v = 0; v < vertexCount; v += 1) {
    positions[v * 3] = v
    positions[v * 3 + 1] = v * 0.5
    positions[v * 3 + 2] = v * 0.25
  }
  for (let t = 0; t < triangleCount; t += 1) {
    index[t * 3] = t * 3
    index[t * 3 + 1] = t * 3 + 1
    index[t * 3 + 2] = t * 3 + 2
  }
  const mesh = makeTriangleMesh(positions, index)
  const chunks = triangleMeshToBufferGeometryChunks(mesh, false)
  assert(chunks.length >= 2, `expected ≥2 chunks for ${vertexCount}-vert mesh, got ${chunks.length}`)
  assertWebGLSafe('large-mesh', chunks)

  // Sum of triangle counts across chunks must equal the input.
  let totalTriangles = 0
  for (const chunk of chunks) {
    const chunkIndex = chunk.getIndex()!
    totalTriangles += chunkIndex.count / 3
  }
  assert(
    totalTriangles === triangleCount,
    `expected ${triangleCount} triangles across chunks, got ${totalTriangles}`,
  )

  // Multiset equality of triangles: decode every chunk's triangles back into
  // world-space vertex triples and verify the set matches the input.
  const triangleKey = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): string => {
    return `${ax},${ay},${az}|${bx},${by},${bz}|${cx},${cy},${cz}`
  }
  const expected = new Set<string>()
  for (let t = 0; t < triangleCount; t += 1) {
    const a = index[t * 3], b = index[t * 3 + 1], c = index[t * 3 + 2]
    expected.add(triangleKey(
      positions[a * 3], positions[a * 3 + 1], positions[a * 3 + 2],
      positions[b * 3], positions[b * 3 + 1], positions[b * 3 + 2],
      positions[c * 3], positions[c * 3 + 1], positions[c * 3 + 2],
    ))
  }
  const seen = new Set<string>()
  for (const chunk of chunks) {
    const chunkPos = chunk.getAttribute('position').array as Float32Array
    const chunkIdx = chunk.getIndex()!.array as Uint16Array
    for (let t = 0; t < chunkIdx.length / 3; t += 1) {
      const a = chunkIdx[t * 3], b = chunkIdx[t * 3 + 1], c = chunkIdx[t * 3 + 2]
      seen.add(triangleKey(
        chunkPos[a * 3], chunkPos[a * 3 + 1], chunkPos[a * 3 + 2],
        chunkPos[b * 3], chunkPos[b * 3 + 1], chunkPos[b * 3 + 2],
        chunkPos[c * 3], chunkPos[c * 3 + 1], chunkPos[c * 3 + 2],
      ))
    }
  }
  assert(seen.size === expected.size, `expected ${expected.size} unique triangles, decoded ${seen.size}`)
  for (const key of expected) {
    assert(seen.has(key), `chunked output is missing triangle ${key}`)
  }
  for (const chunk of chunks) chunk.dispose()
}

function testChunkerVertexShared(): void {
  console.log('Testing chunker: shared-vertex mesh preserves triangle set...')
  // ~80k unique vertices, but triangles share neighbouring vertices in pairs
  // so the chunker has to track per-chunk uniqueness correctly.
  const stripVertCount = 80000
  const triangleCount = stripVertCount - 2 // triangle strip
  const positions = new Float32Array(stripVertCount * 3)
  const index = new Uint32Array(triangleCount * 3)
  for (let v = 0; v < stripVertCount; v += 1) {
    positions[v * 3] = v
    positions[v * 3 + 1] = (v % 2) * 1
    positions[v * 3 + 2] = 0
  }
  for (let t = 0; t < triangleCount; t += 1) {
    // strip pattern: (t, t+1, t+2)
    index[t * 3] = t
    index[t * 3 + 1] = t + 1
    index[t * 3 + 2] = t + 2
  }
  const mesh = makeTriangleMesh(positions, index)
  const chunks = triangleMeshToBufferGeometryChunks(mesh, false)
  assert(chunks.length >= 2, `expected ≥2 chunks for ${stripVertCount}-vert mesh, got ${chunks.length}`)
  assertWebGLSafe('shared-vertex', chunks)

  let totalTriangles = 0
  for (const chunk of chunks) {
    totalTriangles += chunk.getIndex()!.count / 3
  }
  assert(
    totalTriangles === triangleCount,
    `expected ${triangleCount} triangles, got ${totalTriangles}`,
  )
  for (const chunk of chunks) chunk.dispose()
}

function testChunkerMergeVertices(): void {
  console.log('Testing chunker: mergeVertices welds duplicates within a chunk...')
  // Six co-located triangles' worth of vertices, all at the same point.
  const vertexCount = 9
  const positions = new Float32Array(vertexCount * 3)
  for (let v = 0; v < vertexCount; v += 1) {
    // First triangle at origin, second at (1,0,0) — duplicate co-located verts.
    positions[v * 3] = v < 3 ? 0 : 1
    positions[v * 3 + 1] = 0
    positions[v * 3 + 2] = 0
  }
  // Just two degenerate triangles with duplicated verts — enough to assert
  // mergeVertices fires.
  const index = new Uint32Array([0, 1, 2, 3, 4, 5])
  const mesh = makeTriangleMesh(positions, index.slice(0, 6))

  const merged = triangleMeshToBufferGeometryChunks(mesh, true)
  assert(merged.length === 1, `expected single chunk, got ${merged.length}`)
  const mergedCount = merged[0].getAttribute('position').count
  assert(
    mergedCount < vertexCount,
    `expected mergeVertices to reduce vertex count below ${vertexCount}, got ${mergedCount}`,
  )
  assertWebGLSafe('merge-vertices', merged)
  for (const chunk of merged) chunk.dispose()
}

function testLoadPersistedBufferGeometryChunksInvariant(): void {
  console.log('Testing loadPersistedBufferGeometryChunks honours the WebGL-safe invariant...')
  // Build a >65535-vert ImportedTriangleMesh, persist it, then load through
  // the chunked loader and assert the cached result respects the invariant.
  const triangleCount = 30000
  const vertexCount = triangleCount * 3
  const positions = new Float32Array(vertexCount * 3)
  const index = new Uint32Array(triangleCount * 3)
  for (let v = 0; v < vertexCount; v += 1) {
    positions[v * 3] = v
    positions[v * 3 + 1] = 0
    positions[v * 3 + 2] = 0
  }
  for (let t = 0; t < triangleCount; t += 1) {
    index[t * 3] = t * 3
    index[t * 3 + 1] = t * 3 + 1
    index[t * 3 + 2] = t * 3 + 2
  }
  const persisted = serializeImportedMesh(makeTriangleMesh(positions, index), 'stl')
  const chunks = loadPersistedBufferGeometryChunks(persisted, false)
  if (!chunks) throw new Error('expected chunked geometry from persisted mesh')
  assert(chunks.length >= 2, `expected chunked output for ${vertexCount}-vert mesh, got ${chunks.length}`)
  assertWebGLSafe('persisted-chunks', chunks)
  for (const chunk of chunks) chunk.dispose()
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
testChunkerSmallMeshSingleUint16Chunk()
testChunkerLargeMeshSplits()
testChunkerVertexShared()
testChunkerMergeVertices()
testLoadPersistedBufferGeometryChunksInvariant()

console.log('importedMesh tests passed')
