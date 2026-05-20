/**
 * Tests for the STL writer used by the model export pipeline.
 *
 * Run with: npx tsx src/engine/modelExport/stl.test.ts
 */

import { writeAsciiStl, writeBinaryStl } from './stl'
import type { ExportTriangleMesh } from './types'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(a: number, b: number, epsilon = 1e-5): boolean {
  return Math.abs(a - b) < epsilon
}

// Unit cube (8 verts, 12 triangles), Z-up.
function unitCubeMesh(): ExportTriangleMesh {
  const positions = new Float32Array([
    0, 0, 0,  1, 0, 0,  1, 1, 0,  0, 1, 0,
    0, 0, 1,  1, 0, 1,  1, 1, 1,  0, 1, 1,
  ])
  const index = new Uint32Array([
    0, 2, 1,  0, 3, 2, // bottom (-Z)
    4, 5, 6,  4, 6, 7, // top (+Z)
    0, 1, 5,  0, 5, 4, // -Y
    1, 2, 6,  1, 6, 5, // +X
    2, 3, 7,  2, 7, 6, // +Y
    3, 0, 4,  3, 4, 7, // -X
  ])
  return { positions, index }
}

interface ParsedStl {
  triangleCount: number
  vertexCount: number
  bounds: { min: [number, number, number], max: [number, number, number] }
  normals: Array<[number, number, number]>
}

function parseBinaryStl(bytes: Uint8Array): ParsedStl {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const triCount = view.getUint32(80, true)
  let offset = 84
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  const normals: Array<[number, number, number]> = []
  for (let t = 0; t < triCount; t += 1) {
    const nx = view.getFloat32(offset, true); offset += 4
    const ny = view.getFloat32(offset, true); offset += 4
    const nz = view.getFloat32(offset, true); offset += 4
    normals.push([nx, ny, nz])
    for (let v = 0; v < 3; v += 1) {
      const x = view.getFloat32(offset, true); offset += 4
      const y = view.getFloat32(offset, true); offset += 4
      const z = view.getFloat32(offset, true); offset += 4
      if (x < min[0]) min[0] = x
      if (y < min[1]) min[1] = y
      if (z < min[2]) min[2] = z
      if (x > max[0]) max[0] = x
      if (y > max[1]) max[1] = y
      if (z > max[2]) max[2] = z
    }
    offset += 2 // attribute byte count
  }
  return { triangleCount: triCount, vertexCount: triCount * 3, bounds: { min, max }, normals }
}

function parseAsciiStl(text: string): ParsedStl {
  const lines = text.split('\n')
  let triangleCount = 0
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  const normals: Array<[number, number, number]> = []
  for (const raw of lines) {
    const line = raw.trim()
    if (line.startsWith('facet normal ')) {
      const [, , nx, ny, nz] = line.split(/\s+/)
      normals.push([Number(nx), Number(ny), Number(nz)])
      triangleCount += 1
    } else if (line.startsWith('vertex ')) {
      const [, x, y, z] = line.split(/\s+/)
      const fx = Number(x), fy = Number(y), fz = Number(z)
      if (fx < min[0]) min[0] = fx
      if (fy < min[1]) min[1] = fy
      if (fz < min[2]) min[2] = fz
      if (fx > max[0]) max[0] = fx
      if (fy > max[1]) max[1] = fy
      if (fz > max[2]) max[2] = fz
    }
  }
  return { triangleCount, vertexCount: triangleCount * 3, bounds: { min, max }, normals }
}

function testBinaryRoundTrip(): void {
  console.log('Testing binary STL writer round-trip...')
  const cube = unitCubeMesh()
  const bytes = writeBinaryStl(cube)
  assert(bytes.byteLength === 84 + 12 * 50, `unexpected byte length ${bytes.byteLength}`)
  const parsed = parseBinaryStl(bytes)
  assert(parsed.triangleCount === 12, `expected 12 triangles, got ${parsed.triangleCount}`)
  for (let i = 0; i < 3; i += 1) {
    assert(approx(parsed.bounds.min[i], 0), `min[${i}] = ${parsed.bounds.min[i]}`)
    assert(approx(parsed.bounds.max[i], 1), `max[${i}] = ${parsed.bounds.max[i]}`)
  }
  for (const [nx, ny, nz] of parsed.normals) {
    assert(approx(Math.hypot(nx, ny, nz), 1, 1e-3), `expected unit normal, got ${nx},${ny},${nz}`)
  }
}

function testAsciiRoundTrip(): void {
  console.log('Testing ASCII STL writer round-trip...')
  const cube = unitCubeMesh()
  const text = writeAsciiStl(cube, 'cube')
  assert(text.startsWith('solid cube'), 'expected solid header')
  assert(text.trimEnd().endsWith('endsolid cube'), 'expected endsolid footer')
  const parsed = parseAsciiStl(text)
  assert(parsed.triangleCount === 12, `expected 12 facets, got ${parsed.triangleCount}`)
  for (let i = 0; i < 3; i += 1) {
    assert(approx(parsed.bounds.min[i], 0), `ascii min[${i}] = ${parsed.bounds.min[i]}`)
    assert(approx(parsed.bounds.max[i], 1), `ascii max[${i}] = ${parsed.bounds.max[i]}`)
  }
}

function testEmptyMesh(): void {
  console.log('Testing empty STL writers...')
  const empty: ExportTriangleMesh = { positions: new Float32Array(0), index: new Uint32Array(0) }
  const binary = writeBinaryStl(empty)
  assert(binary.byteLength === 84, `empty binary should be 84 bytes, got ${binary.byteLength}`)
  assert(new DataView(binary.buffer).getUint32(80, true) === 0, 'empty binary should have 0 triangles')

  const text = writeAsciiStl(empty, 'empty')
  const parsed = parseAsciiStl(text)
  assert(parsed.triangleCount === 0, `empty ascii should have 0 facets, got ${parsed.triangleCount}`)
}

function testWindingNormals(): void {
  console.log('Testing per-face normal direction...')
  // Single CCW triangle in the XY plane viewed from +Z → normal should be (0,0,1).
  const mesh: ExportTriangleMesh = {
    positions: new Float32Array([0, 0, 0,  1, 0, 0,  0, 1, 0]),
    index: new Uint32Array([0, 1, 2]),
  }
  const parsed = parseBinaryStl(writeBinaryStl(mesh))
  assert(approx(parsed.normals[0][0], 0) && approx(parsed.normals[0][1], 0) && approx(parsed.normals[0][2], 1),
    `expected (0,0,1) normal, got ${parsed.normals[0].join(',')}`)
}

testBinaryRoundTrip()
testAsciiRoundTrip()
testEmptyMesh()
testWindingNormals()
console.log('model export stl writer tests passed')
