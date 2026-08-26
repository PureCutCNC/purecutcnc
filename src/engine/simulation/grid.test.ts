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
 * Tests for createSimulationGrid stock-profile masking.
 *
 * Run with: npx tsx src/engine/simulation/grid.test.ts
 */

import { createSimulationGrid } from './grid'
import { circleProfile, newProject, rectProfile, stockFromFeature } from '../../types/project'
import type { Project, SketchProfile } from '../../types/project'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

/** Count cells that were masked (set to 0 / stockBottomZ). */
function countMaskedCells(grid: ReturnType<typeof createSimulationGrid>): number {
  let count = 0
  for (let i = 0; i < grid.topZ.length; i++) {
    if (grid.topZ[i] === 0) count += 1
  }
  return count
}

/**
 * Build a minimal project with a circular stock source feature.
 * The circle is centered in its bounding box so the test is symmetric.
 */
function projectWithCircleStock(radius = 5, thickness = 10): Project {
  const project = newProject('test', 'mm')
  const profile = circleProfile(10, 10, radius)
  const featureId = 'circle-stock'
  project.featureDefinitions[featureId] = {
    id: featureId,
    kind: 'circle',
    profile,
    dimensions: [],
    text: null,
    stl: null,
    operation: 'add',
  }
  project.features = [
    {
      id: featureId,
      name: 'Circle Stock',
      definitionId: featureId,
      transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
      constraints: [],
      z_top: thickness,
      z_bottom: 0,
      folderId: null,
      visible: true,
      locked: false,
    },
  ]
  project.stock = stockFromFeature({
    id: featureId,
    name: 'Circle Stock',
    kind: 'circle',
    sketch: {
      profile,
      origin: { x: 10, y: 10 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    text: null,
    stl: null,
    operation: 'add' as const,
    z_top: thickness,
    z_bottom: 0,
    visible: true,
    locked: false,
    folderId: null,
  })
  return project
}

function projectWithRectStock(w = 10, h = 10, thickness = 10): Project {
  const project = newProject('test', 'mm')
  const profile = rectProfile(0, 0, w, h)
  const featureId = 'rect-stock'
  project.featureDefinitions[featureId] = {
    id: featureId,
    kind: 'rect',
    profile,
    dimensions: [],
    text: null,
    stl: null,
    operation: 'add',
  }
  const rectFeature = {
    id: featureId,
    name: 'Rect Stock',
    kind: 'rect' as const,
    sketch: {
      profile,
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    text: null,
    stl: null,
    operation: 'add' as const,
    z_top: thickness,
    z_bottom: 0,
    visible: true,
    locked: false,
    folderId: null,
  }
  project.features = [
    {
      id: featureId,
      name: 'Rect Stock',
      definitionId: featureId,
      transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
      constraints: [],
      z_top: thickness,
      z_bottom: 0,
      folderId: null,
      visible: true,
      locked: false,
    },
  ]
  project.stock = stockFromFeature(rectFeature)
  return project
}

function testCircleStockMasksOutsideProfile(): void {
  console.log('Testing circle stock masks cells outside the circle ...')
  const radius = 5
  const project = projectWithCircleStock(radius)
  const grid = createSimulationGrid(project, { targetLongAxisCells: 48 })

  const totalCells = grid.cols * grid.rows
  const masked = countMaskedCells(grid)

  // A circle inscribed in its bounding box (2r × 2r = 10×10) has area πr² ≈ 78.54,
  // bbox area = 100, so ~21.5% of cells should be masked (outside the circle).
  const maskedFraction = masked / totalCells
  assert(
    maskedFraction > 0.15 && maskedFraction < 0.30,
    `expected ~21.5% masked cells for circle stock, got ${(maskedFraction * 100).toFixed(1)}% (${masked}/${totalCells})`,
  )

  // No cell should be masked above the stock bottom (0) — all masked cells are exactly 0.
  for (let i = 0; i < grid.topZ.length; i++) {
    assert(
      grid.topZ[i] === 0 || grid.topZ[i] === grid.stockTopZ,
      `cell ${i} should be either masked (0) or full stock (${grid.stockTopZ}), got ${grid.topZ[i]}`,
    )
  }
  console.log(`circle stock: ${masked}/${totalCells} cells masked (${(maskedFraction * 100).toFixed(1)}%): PASSED`)
}

function testCircleStockMasksCenter(): void {
  console.log('Testing circle stock leaves center cell unmasked...')
  const project = projectWithCircleStock(5)
  const grid = createSimulationGrid(project, { targetLongAxisCells: 48 })

  // The circle center is at (10, 10), which is the center of the grid.
  // The center cell should have stock top Z (not masked).
  const centerCol = Math.floor(grid.cols / 2)
  const centerRow = Math.floor(grid.rows / 2)
  const centerIdx = centerRow * grid.cols + centerCol
  assert(
    grid.topZ[centerIdx] === grid.stockTopZ,
    `center cell should be stock topZ (${grid.stockTopZ}), got ${grid.topZ[centerIdx]}`,
  )
  console.log('circle stock center cell unmasked: PASSED')
}

function testRectStockAllCellsFilled(): void {
  console.log('Testing rect stock fills all cells (no masking)...')
  const project = projectWithRectStock(10, 10)
  const grid = createSimulationGrid(project, { targetLongAxisCells: 48 })

  const masked = countMaskedCells(grid)
  assert(
    masked === 0,
    `rectangular stock should have 0 masked cells, got ${masked}`,
  )
  console.log('rect stock all cells filled: PASSED')
}

function testDefaultRectStockNoMasking(): void {
  console.log('Testing default (no source feature) stock has no masking...')
  const project = newProject('test', 'mm')
  const grid = createSimulationGrid(project, { targetLongAxisCells: 48 })

  const masked = countMaskedCells(grid)
  assert(
    masked === 0,
    `default stock (rect, no sourceFeatureId) should have 0 masked cells, got ${masked}`,
  )
  console.log('default rect stock no masking: PASSED')
}

function testArcProfileStockMasks(): void {
  console.log('Testing arc-bearing profile stock masks outside cells...')
  // Build a profile with an arc segment (slot-like: 2 lines + 2 arcs)
  const profile: SketchProfile = {
    start: { x: 0, y: 0 },
    segments: [
      { type: 'line', to: { x: 10, y: 0 } },
      { type: 'arc', center: { x: 10, y: 5 }, to: { x: 10, y: 10 }, clockwise: true },
      { type: 'line', to: { x: 0, y: 10 } },
      { type: 'arc', center: { x: 0, y: 5 }, to: { x: 0, y: 0 }, clockwise: true },
    ],
    closed: true,
  }

  const project = newProject('test', 'mm')
  const featureId = 'arc-stock'
  project.featureDefinitions[featureId] = {
    id: featureId,
    kind: 'composite',
    profile,
    dimensions: [],
    text: null,
    stl: null,
    operation: 'add',
  }
  project.features = [
    {
      id: featureId,
      name: 'Arc Stock',
      definitionId: featureId,
      transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
      constraints: [],
      z_top: 10,
      z_bottom: 0,
      folderId: null,
      visible: true,
      locked: false,
    },
  ]
  project.stock = stockFromFeature({
    id: featureId,
    name: 'Arc Stock',
    kind: 'composite',
    sketch: {
      profile,
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    text: null,
    stl: null,
    operation: 'add' as const,
    z_top: 10,
    z_bottom: 0,
    visible: true,
    locked: false,
    folderId: null,
  })

  const grid = createSimulationGrid(project, { targetLongAxisCells: 48 })
  const masked = countMaskedCells(grid)
  assert(
    masked > 0,
    'arc profile stock should mask some cells outside the rounded shape',
  )
  console.log(`arc stock: ${masked} cells masked: PASSED`)
}

try {
  testCircleStockMasksOutsideProfile()
  testCircleStockMasksCenter()
  testRectStockAllCellsFilled()
  testDefaultRectStockNoMasking()
  testArcProfileStockMasks()
  console.log('\nAll grid tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
