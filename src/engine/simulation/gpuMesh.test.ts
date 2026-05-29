/**
 * Tests for GPU simulation mesh construction.
 *
 * Run with: npx tsx src/engine/simulation/gpuMesh.test.ts
 */

import {
  SHADER_BOUNDARY_VERTICES_PER_CELL,
  createDynamicProfileBoundaryGeometries,
  createShaderDrivenBoundaryGeometries,
  createStockPlaneGeometries,
  createStockPlaneGeometry,
} from './gpuMesh'
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

// The shader-driven playback boundary mesh emits a fixed number of vertices
// per cell (3 quads × 6 un-indexed verts per cell + a small boundary term for
// outer right/bottom walls). The viewport's high-detail guard
// (SHADER_DRIVEN_BOUNDARY_MAX_CELLS in SimulationViewport.tsx) sizes itself
// against SHADER_BOUNDARY_VERTICES_PER_CELL, so a regression that bumps the
// per-cell vertex count would silently raise memory usage at every detail
// level. Pin both the constant and the chunk shape.
function testShaderDrivenBoundaryVertexCountScales(): void {
  for (const size of [16, 24, 48]) {
    const geometries = createShaderDrivenBoundaryGeometries(makeGrid(size, size))
    const totalVerts = geometries.reduce((sum, g) => sum + g.getAttribute('position').count, 0)
    const cells = size * size
    const expectedMin = SHADER_BOUNDARY_VERTICES_PER_CELL * cells
    // Boundary cells emit extra right/bottom walls; cap at 22 verts/cell to
    // catch accidental quadratic growth without being so tight that the
    // boundary surcharge for tiny grids fails the test.
    const expectedMax = 22 * cells + 6 * 4 * size
    assert(
      totalVerts >= expectedMin && totalVerts <= expectedMax,
      `shader-driven boundary vertex count for ${size}x${size} should be in [${expectedMin}, ${expectedMax}], got ${totalVerts}`,
    )
    for (const geometry of geometries) {
      const position = geometry.getAttribute('position')
      assert(position.count <= 65535, `expected shader-driven chunk to stay under Uint16 limit, got ${position.count}`)
      geometry.dispose()
    }
  }
}

testUsesUint16WhenVertexIdsFit()
testChunksLargePlanesIntoUint16Geometry()
testChunksLargeDynamicProfileBoundaries()
testShaderDrivenBoundaryVertexCountScales()
console.log('gpu mesh tests passed')
