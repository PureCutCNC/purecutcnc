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
 * The viewport's owned square-material surface (issue #1016 C2-R2V).
 *
 * The resource contract itself is #1016 C2-R2M's; this file covers the caller
 * adapter the viewport uses: exact physical stock ends (never the grid's
 * rounded-up cell count), a key that distinguishes a square blank from the
 * round bar of the same box, null/undefined/dirty-region updates, the actual
 * corner and flat geometry on the true pivot, and idempotent disposal.
 *
 * Mutations these assertions were checked against, each applied on its own and
 * reverted:
 * - `squarePreviewKey` dropping the stock's shape/side → "a square and a round
 *   bar of the same box are different keys" and "a side change is a new key"
 *   fail;
 * - `squarePreviewAlongBounds` using `grid.cols * grid.cellSize` → "the
 *   resource ends at the real stock ends" fails;
 * - the adapter disposing geometry itself before/after `resource.dispose()` →
 *   the exact disposal-counter assertion fails;
 * - `aroundBounds` on a nominal radius → "the square envelope reaches the
 *   corners about the true pivot" fails.
 *
 * Run with: npx tsx src/components/simulation/squarePreview.test.ts
 */

import assert from 'node:assert/strict'
import * as THREE from 'three'
import { aroundFrame, unrolledProject } from '../../engine/aroundFrame'
import { aroundBounds } from '../../engine/simulation/aroundWrap'
import { createSimulationGrid } from '../../engine/simulation/grid'
import { squareMaterialChunkIndicesForDirtyRegion, resolveSquareMaterialLayout } from '../../engine/simulation/squareMaterialGeometry'
import type { SimulationGrid } from '../../engine/simulation/types'
import { newProject, getStockBounds, roundStock, type Project, type SquareStock } from '../../types/project'
import { squareStock } from '../../types/barStock'
import { aroundFrameKey } from './aroundView'
import {
  createSquarePreviewSurface,
  squarePreviewAlongBounds,
  squarePreviewKey,
} from './squarePreview'

function near(actual: number, expected: number, label: string, epsilon = 1e-4): void {
  assert(Math.abs(actual - expected) <= epsilon, `${label}: expected ${expected}, got ${actual}`)
}

/** A cheap accepted square grid on the unrolled sheet. */
function squareGrid(stock: SquareStock, targetLongAxisCells = 40): SimulationGrid {
  const frame = aroundFrame(stock)
  const project: Project = { ...newProject('preview', 'mm'), stock }
  return createSimulationGrid(unrolledProject(project, frame), {
    targetLongAxisCells,
    squareBar: { side: stock.thickness, frame },
  })
}

// ---------------------------------------------------------------------------
// 1. The key distinguishes shape and side; the legacy round key is unchanged
// ---------------------------------------------------------------------------

{
  const frame = aroundFrame(roundStock(20, 100, 'x', { x: 5, y: 7 }))
  const roundBar = roundStock(20, 100, 'x', { x: 5, y: 7 })
  const squareBar = squareStock(20, 100, 'x', { x: 5, y: 7 })
  assert.equal(
    aroundFrameKey(frame),
    `${frame.axis}:${frame.centre}:${frame.radius}:${frame.zero}:${frame.sheetStart}:${frame.circumference}`,
    'the legacy frame-only key is byte-identical for the round/flat effects',
  )
  assert.notEqual(
    aroundFrameKey(frame, squareBar),
    aroundFrameKey(frame, roundBar),
    'a square and a round bar of the same box are different keys',
  )
  const grid = squareGrid(squareBar)
  assert.notEqual(
    squarePreviewKey(grid, squareBar),
    squarePreviewKey(grid, { ...squareBar, thickness: 24, profile: squareStock(24, 100, 'x', { x: 5, y: 7 }).profile }),
    'a side change is a new key',
  )
  assert.notEqual(
    squarePreviewKey(grid, squareBar),
    squarePreviewKey(grid, { ...squareBar, shape: 'round' }),
    'a conversion to round is a new key',
  )
}

// ---------------------------------------------------------------------------
// 2. Exact physical ends; the surface is the actual blank, not a cylinder
// ---------------------------------------------------------------------------

for (const axis of ['x', 'y'] as const) {
  // A blank whose circumference is the long axis: the along-cell count then
  // rounds up, so `cols * cellSize` overshoots the real stock end.
  const stock = squareStock(40, 100, axis, { x: 5, y: 7 })
  const grid = squareGrid(stock)
  const frame = grid.squareBar!.frame
  const along = squarePreviewAlongBounds(stock)
  const bounds = getStockBounds(stock)
  const expectedAlong = axis === 'x' ? { min: bounds.minX, max: bounds.maxX } : { min: bounds.minY, max: bounds.maxY }
  assert.deepEqual(along, expectedAlong, `${axis}: along bounds come from the physical stock`)

  // The grid's cell count rounds up, so `cols * cellSize` is not the stock end.
  const alongCount = axis === 'x' ? grid.cols : grid.rows
  const gridEnd = (axis === 'x' ? grid.originX : grid.originY) + alongCount * grid.cellSize
  assert(
    Math.abs(gridEnd - expectedAlong.max) > 1e-6,
    `${axis}: fixture has a rounded-up grid end (${gridEnd} vs ${expectedAlong.max})`,
  )

  const surface = createSquarePreviewSurface(grid, stock, 'gray')
  const resourceBounds = surface.resource.bounds
  const alongMin = axis === 'x' ? resourceBounds.min.x : resourceBounds.min.z
  const alongMax = axis === 'x' ? resourceBounds.max.x : resourceBounds.max.z
  near(alongMin, expectedAlong.min, `${axis}: the resource starts at the real stock end`, 1e-6)
  near(alongMax, expectedAlong.max, `${axis}: the resource ends at the real stock end`, 1e-6)

  // Corners are the actual blank: on the true pivot (`side/2`), reaching
  // `side/sqrt(2)`, with a real flat at `side/2` on the 0/90 rays.
  const maxRadius = stock.thickness * Math.SQRT1_2
  near(resourceBounds.max.y - frame.radius, maxRadius, `${axis}: the envelope reaches the corners about the true pivot`)
  near(frame.radius - resourceBounds.min.y, maxRadius, `${axis}: and grows downward about the same pivot`)
  const acrossMin = axis === 'x' ? resourceBounds.min.z : resourceBounds.min.x
  const acrossMax = axis === 'x' ? resourceBounds.max.z : resourceBounds.max.x
  near(acrossMax - frame.centre, maxRadius, `${axis}: across reaches the corners from the centreline`)
  near(frame.centre - acrossMin, maxRadius, `${axis}: on both sides`)
  // The old heightfield bounds would have used the nominal radius only.
  const nominal = aroundBounds(grid, frame)
  assert(
    resourceBounds.max.y > nominal.max.y + 1e-3,
    `${axis}: the actual blank is taller than the nominal cylinder bounds`,
  )
  assert(
    nominal.max.y < resourceBounds.max.y,
    `${axis}: the actual corners extend past the nominal cylinder`,
  )

  // Sample the geometry itself at a flat and at a corner.
  let flatVertices = 0
  let cornerRadius = 0
  const vertex = new THREE.Vector3()
  for (const child of surface.object.children) {
    const attribute = (child as THREE.Mesh).geometry.getAttribute('position')
    for (let i = 0; i < attribute.count; i += 1) {
      vertex.fromBufferAttribute(attribute as THREE.BufferAttribute, i)
      const radial = Math.hypot(vertex.y - frame.radius, axis === 'x' ? vertex.z - frame.centre : vertex.x - frame.centre)
      if (radial > cornerRadius) cornerRadius = radial
      const onFlatRay = axis === 'x'
        ? Math.abs(vertex.z - frame.centre) < 1e-3 && Math.abs(vertex.y - frame.radius - stock.thickness / 2) < 1e-3
        : Math.abs(vertex.x - frame.centre) < 1e-3 && Math.abs(vertex.y - frame.radius - stock.thickness / 2) < 1e-3
      if (onFlatRay) flatVertices += 1
      // No vertex may sit outside the actual blank.
      assert(radial <= maxRadius + 1e-3, `${axis}: no vertex escapes the blank corner at ${radial}`)
    }
  }
  near(cornerRadius, maxRadius, `${axis}: a real corner reaches side/sqrt(2)`)
  assert(flatVertices > 0, `${axis}: a real flat sits at side/2 on the 0/90 ray`)

  surface.dispose()
}

// ---------------------------------------------------------------------------
// 3. Null no-op, dirty-region rebuilds and full reset
// ---------------------------------------------------------------------------

{
  const stock = squareStock(20, 100, 'x', { x: 5, y: 7 })
  const grid = squareGrid(stock)
  const parent = new THREE.Group()
  const owned = createSquarePreviewSurface(grid, stock, 'gray')
  parent.add(owned.object)
  assert.equal(owned.object.parent, parent, 'the surface is attached to the turn content')

  const geometryIdentities = owned.object.children.map((child) => (child as THREE.Mesh).geometry)
  const created = owned.resource.stats.geometriesCreated

  // Explicit unchanged: nothing is rebuilt, no counter moves.
  owned.update(grid, null)
  assert.equal(owned.resource.stats.geometriesCreated, created, 'a null region is an unconditional no-op')
  owned.object.children.forEach((child, index) => {
    assert.equal((child as THREE.Mesh).geometry, geometryIdentities[index], `chunk ${index} identity survives a null update`)
  })

  // A small material-only change rebuilds the touched chunk and its angular
  // neighbour, and leaves distant chunks sharing their geometry object.
  const layout = resolveSquareMaterialLayout(grid, { alongBounds: squarePreviewAlongBounds(stock) })
  const acrossCount = layout.axis === 'x' ? grid.rows : grid.cols
  const targetRow = Math.floor(acrossCount / 2)
  const targetCol = Math.floor((layout.axis === 'x' ? grid.cols : grid.rows) / 2)
  const targetIndex = layout.axis === 'x'
    ? targetRow * grid.cols + targetCol
    : targetCol * grid.cols + targetRow
  const baseline = grid.initialTopZ![targetIndex]
  // Remove an interior band, keeping the outer shell: exactly the interval-only
  // case the old heightfield cannot represent.
  grid.squareMaterial!.set(targetIndex, [0, baseline * 0.3, baseline * 0.5, baseline])
  const region = { colMin: targetCol, colMax: targetCol, rowMin: targetRow, rowMax: targetRow }
  const touched = new Set(squareMaterialChunkIndicesForDirtyRegion(layout, 8, region))
  const before = owned.object.children.map((child) => (child as THREE.Mesh).geometry)
  const targetChunk = Math.floor(targetRow / 8)
  const beforeTriangles = (before[targetChunk] as THREE.BufferGeometry).getAttribute('position').count
  owned.update(grid, region)
  assert(owned.resource.stats.geometriesCreated > created, 'a dirty region rebuilds geometry')
  owned.object.children.forEach((child, index) => {
    if (!touched.has(index)) {
      assert.equal((child as THREE.Mesh).geometry, before[index], `untouched chunk ${index} keeps its geometry`)
    }
  })
  assert(touched.size >= 1, 'the dirty region selects at least its own chunk')
  // The resource reads the mutable map through the interval accessor, so an
  // in-place change is seen even though the map's identity never changed.
  const afterTriangles = (owned.object.children[targetChunk] as THREE.Mesh).geometry.getAttribute('position').count
  assert(afterTriangles !== beforeTriangles, 'an in-place material change is picked up by the dirty update')

  // Undo restores the material map in place; a full reset rebuilds the original
  // virgin geometry.
  grid.squareMaterial!.clear()
  owned.update(grid, undefined)
  const restoredTriangles = (owned.object.children[targetChunk] as THREE.Mesh).geometry.getAttribute('position').count
  assert.equal(restoredTriangles, beforeTriangles, 'a full reset restores the untouched square geometry')

  // Undefined is a full reset, even for an unchanged material map.
  const afterDirty = owned.resource.stats.geometriesCreated
  owned.update(grid, undefined)
  assert.equal(owned.resource.stats.geometriesCreated, afterDirty + owned.object.children.length, 'undefined rebuilds every chunk')

  // Dispose: object detached, geometries and the one material released once.
  const finalCreated = owned.resource.stats.geometriesCreated
  owned.dispose()
  assert.equal(owned.object.parent, null, 'dispose detaches the object')
  assert(owned.disposed, 'the surface reports itself disposed')
  assert.equal(owned.resource.stats.geometryDisposals, finalCreated, 'exactly the created geometries are released once')
  assert.equal(owned.resource.stats.materialDisposals, 1, 'the shared material is released once')
  owned.dispose()
  assert.equal(owned.resource.stats.geometryDisposals, finalCreated, 'a second dispose frees nothing twice')
  assert.equal(owned.resource.stats.materialDisposals, 1, 'and the material stays released once')
  assert.throws(() => owned.update(grid, null), RangeError, 'updating a disposed surface is refused')

  // The round/flat path never gets this surface.
  const roundBar = roundStock(20, 100, 'x', { x: 5, y: 7 })
  const roundProject: Project = { ...newProject('round', 'mm'), stock: roundBar }
  const roundGrid = createSimulationGrid(unrolledProject(roundProject, aroundFrame(roundBar)), { targetLongAxisCells: 20 })
  assert.throws(() => createSquarePreviewSurface(roundGrid, roundBar, 'gray'), RangeError, 'a round grid is refused')
  assert.throws(() => createSquarePreviewSurface(grid, roundBar, 'gray'), RangeError, 'a round stock is refused')
}

console.log('square preview tests passed')
