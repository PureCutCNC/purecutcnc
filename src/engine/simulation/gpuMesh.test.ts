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

function testOneIndependentTopPerCell(): void {
  const grid = makeGrid(280, 140)
  const geometry = createStockPlaneGeometry(grid)
  const position = geometry.getAttribute('position')
  const index = geometry.getIndex()
  if (!index) throw new Error('Assertion failed: expected indexed geometry')
  assert(position.count === grid.cols * 4, 'each cell in the row needs four private top vertices')
  assert(index.count === grid.cols * 6, 'each cell needs two top triangles')
  assert(geometry.instanceCount === grid.rows, 'row template should be instanced for every row')
  assert(index.array instanceof Uint16Array, 'row template should fit Uint16 indices')
  const p = position.array
  assert(p[0] === 0 && p[12] === 1, 'neighboring cells must not share top vertices')
  geometry.dispose()
}

function testHighDetailUsesOneSmallRowTemplate(): void {
  const geometries = createStockPlaneGeometries(makeGrid(280, 280))
  assert(geometries.length === 1, 'high detail should keep one instanced row template')
  assert(geometries[0].getAttribute('position').count === 280 * 4, 'template size must scale by row width')
  geometries[0].dispose()
}

function testStockPlaneBoundsCoverDisplacedHeight(): void {
  const grid = makeGrid(280, 280)
  const geometries = createStockPlaneGeometries(grid)

  for (const geometry of geometries) {
    const box = geometry.boundingBox
    if (!box) throw new Error('Assertion failed: stock plane must carry a bounding box')
    assert(
      Math.abs(box.min.y - grid.stockBottomZ) < 1e-6,
      `bounding box min Y should sit at stockBottomZ (${grid.stockBottomZ}), got ${box.min.y}`,
    )
    assert(
      Math.abs(box.max.y - grid.stockTopZ) < 1e-6,
      `bounding box max Y should reach stockTopZ (${grid.stockTopZ}), got ${box.max.y}`,
    )
    const sphere = geometry.boundingSphere
    if (!sphere) throw new Error('Assertion failed: stock plane must carry a bounding sphere')
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

testOneIndependentTopPerCell()
testHighDetailUsesOneSmallRowTemplate()
testStockPlaneBoundsCoverDisplacedHeight()
console.log('gpu mesh tests passed')
