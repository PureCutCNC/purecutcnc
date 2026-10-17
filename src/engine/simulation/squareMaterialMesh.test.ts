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
 * Resource, update and lifetime tests for the square-material mesh
 * (issue #1016 C2-R2M).
 *
 * These are structural: chunk and triangle counts, which chunk a dirty region
 * rebuilds, whether an untouched geometry keeps its identity, and how many
 * geometries the resource releases. No timing is asserted anywhere — the
 * manager measures real browser responsiveness separately.
 *
 * Run with: npx tsx src/engine/simulation/squareMaterialMesh.test.ts
 */

import * as THREE from 'three'
import { setSquareMaterialIntervals, squareSurfaceRadius } from './squareMaterial'
import { createSquareMaterialMesh } from './squareMaterialMesh'
import type { SimulationGrid } from './types'
import type { AroundFrame } from '../aroundFrame'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function squareSheetGrid(params: {
  side: number
  axis: 'x' | 'y'
  angularCells: number
  alongCells: number
  zero: number
  alongStart?: number
}): SimulationGrid {
  const { side, axis, angularCells, alongCells, zero } = params
  const alongStart = params.alongStart ?? 0
  const circumference = Math.PI * side
  const cellSize = circumference / angularCells
  const sheetStart = zero - circumference / 2
  const xMin = axis === 'x' ? alongStart : sheetStart
  const yMin = axis === 'x' ? sheetStart : alongStart
  const cols = axis === 'x' ? alongCells : angularCells
  const rows = axis === 'x' ? angularCells : alongCells
  const topZ = new Float32Array(cols * rows)
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const across = axis === 'x'
        ? yMin + (row + 0.5) * cellSize
        : xMin + (col + 0.5) * cellSize
      topZ[row * cols + col] = squareSurfaceRadius(side, (across - zero) / (side / 2))
    }
  }
  const frame: AroundFrame = {
    axis,
    centre: zero,
    radius: side / 2,
    zero,
    sheetStart,
    circumference,
  }
  return {
    originX: xMin,
    originY: yMin,
    cellSize,
    cols,
    rows,
    stockBottomZ: 0,
    stockTopZ: side * Math.SQRT1_2,
    squareBar: { side, frame },
    initialTopZ: new Float32Array(topZ),
    topZ,
    squareMaterial: new Map<number, readonly number[]>(),
  }
}

function optionsFor(grid: SimulationGrid, angularCellsPerChunk = 4): {
  alongBounds: { min: number; max: number }
  angularCellsPerChunk: number
} {
  const axis = grid.squareBar!.frame.axis
  const min = axis === 'x' ? grid.originX : grid.originY
  const count = axis === 'x' ? grid.cols : grid.rows
  return { alongBounds: { min, max: min + count * grid.cellSize }, angularCellsPerChunk }
}

function gridCellIndex(grid: SimulationGrid, ci: number, ai: number): number {
  return grid.squareBar!.frame.axis === 'x' ? ci * grid.cols + ai : ai * grid.cols + ci
}

/** The DirtyRegion covering one cell, in grid col/row indices. */
function regionForCell(grid: SimulationGrid, ci: number, ai: number): { colMin: number; colMax: number; rowMin: number; rowMax: number } {
  const xAxis = grid.squareBar!.frame.axis === 'x'
  return xAxis
    ? { colMin: ai, colMax: ai, rowMin: ci, rowMax: ci }
    : { colMin: ci, colMax: ci, rowMin: ai, rowMax: ai }
}

function chunkGeometries(resource: ReturnType<typeof createSquareMaterialMesh>): THREE.BufferGeometry[] {
  return resource.object.children.filter((child): child is THREE.Mesh => child instanceof THREE.Mesh).map((mesh) => mesh.geometry)
}

function testResourceStructure(): void {
  console.log('Testing the chunked resource structure...')
  const side = 20
  const grid = squareSheetGrid({ side, axis: 'x', angularCells: 32, alongCells: 16, zero: 30 })
  const options = optionsFor(grid, 4)
  const resource = createSquareMaterialMesh(grid, 0xcc8844, options)
  const meshes = resource.object.children.filter((child): child is THREE.Mesh => child instanceof THREE.Mesh)
  assert(resource.object instanceof THREE.Group, 'the resource object must be a Group')
  assert(meshes.length === 8, `32 angular cells at 4 per chunk must make 8 chunks, got ${meshes.length}`)
  assert(resource.stats.chunkCount === 8, 'the stats must report the chunk count')
  assert(resource.stats.triangleCount > 0, 'a virgin blank must have triangles')
  assert(meshes.every((mesh) => mesh.material === meshes[0].material), 'all chunks must share one owned material')
  const maxRadius = side * Math.SQRT1_2
  assert(resource.bounds.min.y <= grid.squareBar!.frame.radius - maxRadius + 1e-9, 'bounds must contain pivot - side/sqrt2')
  assert(resource.bounds.max.y >= grid.squareBar!.frame.radius + maxRadius - 1e-9, 'bounds must contain pivot + side/sqrt2')
  resource.dispose()
  console.log('chunked resource structure: PASSED')
}

function testNullUpdateIsNoOp(): void {
  console.log('Testing a null dirty region is a no-op...')
  const grid = squareSheetGrid({ side: 20, axis: 'x', angularCells: 16, alongCells: 8, zero: 30 })
  const resource = createSquareMaterialMesh(grid, 0x888888, optionsFor(grid))
  const before = chunkGeometries(resource)
  const disposals = resource.stats.geometryDisposals
  const triangles = resource.stats.triangleCount
  resource.update(grid, null)
  const after = chunkGeometries(resource)
  assert(before.length === after.length && before.every((geometry, i) => geometry === after[i]), 'a null update must not replace any geometry')
  assert(resource.stats.geometryDisposals === disposals, 'a null update must not dispose anything')
  assert(resource.stats.triangleCount === triangles, 'a null update must not change the triangle count')
  resource.dispose()
  console.log('null update no-op: PASSED')
}

function testDirtyRegionRebuildsTouchedChunksOnly(): void {
  console.log('Testing a dirty region rebuilds touched chunks plus neighbours...')
  const grid = squareSheetGrid({ side: 20, axis: 'x', angularCells: 32, alongCells: 16, zero: 30 })
  const resource = createSquareMaterialMesh(grid, 0x888888, optionsFor(grid, 4))
  const before = chunkGeometries(resource)
  const beforeTriangles = resource.stats.triangleCount

  // A material change with the outer topZ left untouched: this is exactly the
  // case a topZ-only renderer misses.
  const ci = 16
  const ai = 8
  const index = gridCellIndex(grid, ci, ai)
  const baseline = grid.initialTopZ![index]
  setSquareMaterialIntervals(grid, index, [0, 6, 12, baseline])
  grid.topZ[index] = baseline
  resource.update(grid, regionForCell(grid, ci, ai))

  const after = chunkGeometries(resource)
  // Angular 16 is chunk 4; chunks 3 and 5 share its walls, so all three rebuild.
  assert(after[4] !== before[4], 'the touched chunk must rebuild')
  assert(after[3] !== before[3], 'the lower neighbour chunk must rebuild')
  assert(after[5] !== before[5], 'the upper neighbour chunk must rebuild')
  for (const untouched of [0, 1, 2, 6, 7]) {
    assert(after[untouched] === before[untouched], `untouched chunk ${untouched} must keep its geometry identity`)
  }
  assert(resource.stats.triangleCount > beforeTriangles, 'the interior gap must add wall triangles even with topZ unchanged')
  assert(resource.stats.geometryDisposals === 3, `only three geometries may be replaced, got ${resource.stats.geometryDisposals}`)
  resource.dispose()
  console.log('dirty region chunk selection: PASSED')
}

function testAngularNeighbourGeometryDependency(): void {
  console.log('Testing an angular change reaches the neighbour chunk geometry...')
  const grid = squareSheetGrid({ side: 20, axis: 'x', angularCells: 32, alongCells: 16, zero: 30 })
  const resource = createSquareMaterialMesh(grid, 0x888888, optionsFor(grid, 4))
  const before = chunkGeometries(resource)
  const neighbourBefore = Float32Array.from(before[3].getAttribute('position').array as Float32Array)
  const farBefore = before[2]

  const ci = 16
  const ai = 8
  const index = gridCellIndex(grid, ci, ai)
  setSquareMaterialIntervals(grid, index, [0, 6, 12, grid.initialTopZ![index]])
  grid.topZ[index] = grid.initialTopZ![index]
  resource.update(grid, regionForCell(grid, ci, ai))

  const after = chunkGeometries(resource)
  const neighbourAfter = after[3].getAttribute('position').array as Float32Array
  let neighbourChanged = neighbourAfter.length !== neighbourBefore.length
  if (!neighbourChanged) {
    for (let i = 0; i < neighbourAfter.length; i += 1) {
      if (neighbourAfter[i] !== neighbourBefore[i]) {
        neighbourChanged = true
        break
      }
    }
  }
  assert(neighbourChanged, 'the shared angular wall must change the neighbour chunk geometry, not just its identity')
  assert(after[2] === farBefore, 'a chunk two angular steps away must keep its geometry identity')
  resource.dispose()
  console.log('angular neighbour geometry dependency: PASSED')
}

function testSeamAndNeighbourRebuild(): void {
  console.log('Testing the periodic seam chunk rebuilds with its neighbour...')
  const grid = squareSheetGrid({ side: 20, axis: 'x', angularCells: 32, alongCells: 8, zero: 30 })
  const resource = createSquareMaterialMesh(grid, 0x888888, optionsFor(grid, 4))
  const before = chunkGeometries(resource)

  const ai = 4
  const index = gridCellIndex(grid, 0, ai)
  const baseline = grid.initialTopZ![index]
  setSquareMaterialIntervals(grid, index, [0, 6, 12, baseline])
  resource.update(grid, regionForCell(grid, 0, ai))
  const after = chunkGeometries(resource)
  assert(after[0] !== before[0], 'the dirty seam chunk must rebuild')
  assert(after[1] !== before[1], 'the seam chunk neighbour must rebuild')
  assert(after[7] !== before[7], 'the opposite periodic seam chunk must rebuild')
  assert(after[4] === before[4], 'an untouched middle chunk must keep its geometry')
  resource.dispose()
  console.log('seam rebuild: PASSED')
}

function testFullRebuildPaths(): void {
  console.log('Testing full rebuild on undefined region and on a topology change...')
  const grid = squareSheetGrid({ side: 20, axis: 'x', angularCells: 16, alongCells: 8, zero: 30 })
  const resource = createSquareMaterialMesh(grid, 0x888888, optionsFor(grid, 4))

  const beforeUndefined = chunkGeometries(resource)
  resource.update(grid)
  const afterUndefined = chunkGeometries(resource)
  assert(afterUndefined.every((geometry, i) => geometry !== beforeUndefined[i]), 'an undefined region must rebuild every chunk')

  const beforeTopology = chunkGeometries(resource)
  grid.squareBar!.frame = { ...grid.squareBar!.frame, centre: 42 }
  resource.update(grid, regionForCell(grid, 3, 2))
  const afterTopology = chunkGeometries(resource)
  assert(afterTopology.every((geometry, i) => geometry !== beforeTopology[i]), 'a changed frame must force a full rebuild')
  assert(resource.bounds.min.z <= 42 - 20 * Math.SQRT1_2 + 1e-9, 'bounds must follow the new frame centre')
  resource.dispose()
  console.log('full rebuild paths: PASSED')
}

function testEmptyChunkAndBounds(): void {
  console.log('Testing an empty chunk and the envelope bounds...')
  const grid = squareSheetGrid({ side: 20, axis: 'y', angularCells: 16, alongCells: 8, zero: -7, alongStart: 3 })
  const resource = createSquareMaterialMesh(grid, 0x888888, optionsFor(grid, 4))
  const beforeTriangles = resource.stats.triangleCount
  // Remove two whole angular chunks, so the first chunk's own +edge interfaces
  // are air-to-air and it really carries no geometry.
  for (let ci = 0; ci < 8; ci += 1) {
    for (let ai = 0; ai < grid.rows; ai += 1) {
      const index = gridCellIndex(grid, ci, ai)
      setSquareMaterialIntervals(grid, index, [])
      grid.topZ[index] = 0
    }
  }
  resource.update(grid, { colMin: 0, colMax: 7, rowMin: 0, rowMax: grid.rows - 1 })
  assert(resource.stats.chunkCount === 4, 'the chunk count must not change for an empty chunk')
  assert(resource.stats.triangleCount < beforeTriangles, 'removing a chunk of material must remove triangles')
  const firstMesh = resource.object.children[0]
  if (!(firstMesh instanceof THREE.Mesh)) throw new Error('the empty chunk must still be a mesh resource')
  assert(firstMesh.geometry.getAttribute('position').count === 0, 'the empty chunk must carry no vertices')
  const maxRadius = 20 * Math.SQRT1_2
  assert(resource.bounds.min.x <= -7 - maxRadius + 1e-9 && resource.bounds.max.x >= -7 + maxRadius - 1e-9, 'y bounds must hold the corners')
  assert(resource.bounds.min.z <= 3 + 1e-9 && resource.bounds.max.z >= 3 + 8 * grid.cellSize - 1e-9, 'z bounds must hold the stock ends')
  resource.dispose()
  console.log('empty chunk and bounds: PASSED')
}

function testDisposeIsIdempotentAndExact(): void {
  console.log('Testing dispose is idempotent and releases every resource once...')
  const grid = squareSheetGrid({ side: 20, axis: 'x', angularCells: 16, alongCells: 8, zero: 30 })
  const resource = createSquareMaterialMesh(grid, 0x888888, optionsFor(grid, 4))
  const chunkCount = resource.stats.chunkCount

  // One rebuild first, so a replaced geometry is also counted.
  const index = gridCellIndex(grid, 5, 4)
  setSquareMaterialIntervals(grid, index, [0, 5, 10, grid.initialTopZ![index]])
  resource.update(grid, regionForCell(grid, 5, 4))
  const replaced = resource.stats.geometryDisposals
  assert(replaced > 0, 'a rebuild must dispose the replaced geometry')

  resource.dispose()
  assert(resource.disposed, 'the resource must report itself disposed')
  assert(resource.stats.geometryDisposals === replaced + chunkCount, 'dispose must release each remaining geometry exactly once')
  assert(resource.stats.materialDisposals === 1, 'dispose must release the owned material exactly once')
  assert(resource.object.children.length === 0, 'dispose must detach every mesh')

  const disposals = resource.stats.geometryDisposals
  resource.dispose()
  assert(resource.stats.geometryDisposals === disposals, 'a second dispose must be a no-op')

  let threw = false
  try {
    resource.update(grid, null)
  } catch (error) {
    threw = error instanceof RangeError
  }
  assert(threw, 'update after dispose must throw a RangeError')
  console.log('dispose lifecycle: PASSED')
}

function testResetRestoresVirginGeometry(): void {
  console.log('Testing a reset restores the virgin material geometry...')
  const grid = squareSheetGrid({ side: 20, axis: 'x', angularCells: 16, alongCells: 8, zero: 30 })
  const resource = createSquareMaterialMesh(grid, 0x888888, optionsFor(grid, 4))
  const virginPositions = Float32Array.from(
    (resource.object.children[0] as THREE.Mesh).geometry.getAttribute('position').array as Float32Array,
  )
  const virginTriangles = resource.stats.triangleCount

  const index = gridCellIndex(grid, 5, 4)
  setSquareMaterialIntervals(grid, index, [0, 5, 10, grid.initialTopZ![index]])
  resource.update(grid, regionForCell(grid, 5, 4))
  assert(resource.stats.triangleCount !== virginTriangles, 'the cut must change the geometry')

  // Reset the transient material to the virgin baseline through the map, then
  // ask for a full rebuild: the resource must come back exactly.
  grid.squareMaterial = new Map()
  grid.topZ.set(grid.initialTopZ!)
  resource.update(grid)
  assert(resource.stats.triangleCount === virginTriangles, 'a reset must restore the virgin triangle count')
  const resetPositions = (resource.object.children[0] as THREE.Mesh).geometry.getAttribute('position').array as Float32Array
  assert(
    resetPositions.length === virginPositions.length && resetPositions.every((value, i) => value === virginPositions[i]),
    'a reset must reproduce the virgin geometry bit for bit',
  )
  resource.dispose()
  console.log('reset restores virgin geometry: PASSED')
}

function testInvalidInputRefuses(): void {
  console.log('Testing invalid input refusal...')
  const grid = squareSheetGrid({ side: 20, axis: 'x', angularCells: 16, alongCells: 8, zero: 30 })
  let threw = false
  try {
    createSquareMaterialMesh(grid, 0xffffff, { alongBounds: { min: 5, max: 5 } })
  } catch (error) {
    threw = error instanceof RangeError
  }
  assert(threw, 'a degenerate alongBounds must throw a RangeError')
  const flat: SimulationGrid = { ...grid }
  delete flat.squareBar
  threw = false
  try {
    createSquareMaterialMesh(flat, 0xffffff, optionsFor(grid))
  } catch (error) {
    threw = error instanceof RangeError
  }
  assert(threw, 'a non-square grid must throw a RangeError')
  console.log('invalid input refusal: PASSED')
}

try {
  testResourceStructure()
  testNullUpdateIsNoOp()
  testDirtyRegionRebuildsTouchedChunksOnly()
  testAngularNeighbourGeometryDependency()
  testSeamAndNeighbourRebuild()
  testFullRebuildPaths()
  testEmptyChunkAndBounds()
  testDisposeIsIdempotentAndExact()
  testResetRestoresVirginGeometry()
  testInvalidInputRefuses()
  console.log('\nAll square material mesh tests PASSED.')
} catch (error) {
  console.error(error)
  throw error
}
