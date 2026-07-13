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
 * Tests for GPU simulation mesh construction.
 *
 * Run with: npx tsx src/engine/simulation/gpuMesh.test.ts
 */

import * as THREE from 'three'
import {
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

// The stock plane geometry is stored flat (Y = 0) and displaced up to the
// heightfield in the vertex shader. Its bounding volume must therefore cover
// the true displaced Y range [stockBottomZ, stockTopZ]; if it were computed
// from the raw flat positions it would collapse to a zero-height slab at Y = 0,
// and three's frustum culler would wrongly drop bottom-of-frame chunks at high
// detail (surface teeth revealing the wall behind). Pin the Y span so that
// regression can't return.
function testStockPlaneChunkBoundsCoverDisplacedHeight(): void {
  const grid = makeGrid(280, 280) // high enough to force chunking
  const geometries = createStockPlaneGeometries(grid)
  assert(geometries.length > 1, 'expected the plane to be chunked for this test to be meaningful')

  for (const geometry of geometries) {
    const box = geometry.boundingBox
    if (!box) throw new Error('Assertion failed: stock plane chunk must carry a bounding box')
    assert(
      Math.abs(box.min.y - grid.stockBottomZ) < 1e-6,
      `chunk bounding box min Y should sit at stockBottomZ (${grid.stockBottomZ}), got ${box.min.y}`,
    )
    assert(
      Math.abs(box.max.y - grid.stockTopZ) < 1e-6,
      `chunk bounding box max Y should reach stockTopZ (${grid.stockTopZ}), got ${box.max.y}`,
    )
    const sphere = geometry.boundingSphere
    if (!sphere) throw new Error('Assertion failed: stock plane chunk must carry a bounding sphere')
    // The sphere must be centered at the true mid-height, not at Y = 0 (the old
    // flat-slab bug centered it half a thickness too low) — check the top-face
    // center sits comfortably inside.
    const midHeight = (grid.stockBottomZ + grid.stockTopZ) / 2
    assert(
      Math.abs(sphere.center.y - midHeight) < 1e-6,
      `chunk bounding sphere should be centered at mid-height (${midHeight}), got ${sphere.center.y}`,
    )
    const topCenter = new THREE.Vector3(
      (box.min.x + box.max.x) / 2,
      grid.stockTopZ,
      (box.min.z + box.max.z) / 2,
    )
    assert(
      sphere.containsPoint(topCenter),
      'chunk bounding sphere must contain the displaced top surface',
    )
    geometry.dispose()
  }
}

testUsesUint16WhenVertexIdsFit()
testChunksLargePlanesIntoUint16Geometry()
testStockPlaneChunkBoundsCoverDisplacedHeight()
console.log('gpu mesh tests passed')
