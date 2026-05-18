/**
 * Tests for GPU simulation mesh construction.
 *
 * Run with: npx tsx src/engine/simulation/gpuMesh.test.ts
 */

import { createDynamicProfileBoundaryGeometries, createStockPlaneGeometries, createStockPlaneGeometry } from './gpuMesh'
import type { SimulationGrid } from './types'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function makeGrid(cols: number, rows: number): SimulationGrid {
  return {
    originX: 0,
    originY: 0,
    cellSize: 1,
    cols,
    rows,
    stockBottomZ: 0,
    stockTopZ: 10,
    topZ: new Float32Array(cols * rows).fill(10),
  }
}

function testUsesUint16WhenVertexIdsFit(): void {
  const geometry = createStockPlaneGeometry(makeGrid(280, 140))
  const index = geometry.getIndex()
  if (!index) throw new Error('Assertion failed: expected indexed geometry')
  assert(index.array instanceof Uint16Array, 'expected Uint16 indices when all vertex ids fit in 16 bits')
  geometry.dispose()
}

function testChunksLargePlanesIntoUint16Geometry(): void {
  const geometries = createStockPlaneGeometries(makeGrid(280, 280))
  assert(geometries.length > 1, 'expected square high-detail plane to be chunked')

  for (const geometry of geometries) {
    const position = geometry.getAttribute('position')
    const index = geometry.getIndex()
    assert(position.count <= 65535, `expected chunk vertex count to fit in Uint16, got ${position.count}`)
    if (!index) throw new Error('Assertion failed: expected indexed chunk geometry')
    assert(index.array instanceof Uint16Array, 'expected chunk to use Uint16 indices')
    geometry.dispose()
  }
}

function testChunksLargeDynamicProfileBoundaries(): void {
  const geometries = createDynamicProfileBoundaryGeometries(makeGrid(280, 280))
  assert(geometries.length > 1, 'expected high-detail dynamic profile boundary to be chunked')

  for (const geometry of geometries) {
    const position = geometry.getAttribute('position')
    assert(position.count <= 65535, `expected boundary chunk vertex count to stay small, got ${position.count}`)
    geometry.dispose()
  }
}

testUsesUint16WhenVertexIdsFit()
testChunksLargePlanesIntoUint16Geometry()
testChunksLargeDynamicProfileBoundaries()
console.log('gpu mesh tests passed')
