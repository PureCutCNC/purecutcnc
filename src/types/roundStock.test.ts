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
 * The round-stock variant of the data model (#392 slice A). A round bar keeps
 * `profile`/`thickness` as the box it fits in — length × diameter, thickness =
 * diameter — so every existing reader of the stock box needs no round case.
 *
 * Run with: npx tsx src/types/roundStock.test.ts
 */

import assert from 'node:assert/strict'
import {
  defaultOrigin,
  defaultStock,
  getStockBounds,
  isRoundStock,
  normalizeRoundStock,
  rectProfile,
  roundStock,
  roundStockCentre,
  roundStockDiameter,
  roundStockLength,
  stockFromFeature,
  type RoundStock,
  type SketchFeature,
  type StockAxis,
} from './project'
import { setupPivot } from '../engine/setupOrientation'

function test(name: string, fn: () => void): void {
  fn()
  console.log(`   ✓ ${name}`)
}

test('roundStock(20, 100, x) is a bar 100 × 20 with thickness 20', () => {
  const bar = roundStock(20, 100, 'x')
  const bounds = getStockBounds(bar)
  assert.deepEqual(bounds, { minX: 0, maxX: 100, minY: 0, maxY: 20 }, 'bounds are 100 along X, 20 across')
  assert.equal(bar.thickness, 20, 'thickness is the diameter')
  assert.equal(bar.axis, 'x', 'axis is x')
  assert.equal(roundStockLength(bar), 100, 'length is the X extent')
  assert.equal(roundStockDiameter(bar), 20, 'diameter is thickness')
  assert.equal(roundStockCentre(bar), 10, 'centre is the middle across X, a Y value')
  assert.equal(bar.shape, 'round', 'shape is round')
})

test('roundStock(20, 100, y) swaps the box', () => {
  const bar = roundStock(20, 100, 'y')
  const bounds = getStockBounds(bar)
  assert.deepEqual(bounds, { minX: 0, maxX: 20, minY: 0, maxY: 100 }, 'bounds are 20 along X, 100 along Y')
  assert.equal(roundStockLength(bar), 100, 'length is the Y extent')
  assert.equal(roundStockCentre(bar), 10, 'centre is the middle across Y, an X value')
})

test('at moves the rectangle and the centre with it', () => {
  const bar = roundStock(20, 100, 'x', { x: 5, y: 7 })
  assert.deepEqual(getStockBounds(bar), { minX: 5, maxX: 105, minY: 7, maxY: 27 }, 'rectangle is translated')
  assert.equal(roundStockCentre(bar), 17, 'centre follows the rectangle')
  assert.equal(roundStockLength(bar), 100, 'length is unchanged')
})

test('a default or feature stock has no shape key at all', () => {
  const block = defaultStock()
  assert.equal(isRoundStock(block), false, 'a default stock is not round')
  assert.equal('shape' in block, false, 'no shape key is written for a block')

  const feature: SketchFeature = {
    id: 'f1',
    name: 'f1',
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(0, 0, 10, 10),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
  assert.equal('shape' in stockFromFeature(feature), false, 'a feature stock has no shape key')
  assert.equal(isRoundStock(stockFromFeature(feature)), false, 'a feature stock is not round')
})

test('normalizeRoundStock repairs the across-axis width, keeping the centreline and length', () => {
  const widenedX: RoundStock = { ...roundStock(20, 100, 'x'), profile: rectProfile(0, 0, 100, 50) }
  const repairedX = normalizeRoundStock(widenedX)
  assert.deepEqual(getStockBounds(repairedX), { minX: 0, maxX: 100, minY: 15, maxY: 35 },
    'X bar is 20 wide, centred on the old centreline 25')
  assert.equal(roundStockCentre(repairedX), 25, 'centreline is kept')
  assert.equal(roundStockLength(repairedX), 100, 'length is kept')
  assert.equal(repairedX.thickness, 20, 'thickness is kept')

  const widenedY: RoundStock = { ...roundStock(20, 100, 'y'), profile: rectProfile(0, 0, 60, 100) }
  const repairedY = normalizeRoundStock(widenedY)
  assert.deepEqual(getStockBounds(repairedY), { minX: 20, maxX: 40, minY: 0, maxY: 100 },
    'Y bar is 20 wide, centred on the old centreline 30')
  assert.equal(roundStockCentre(repairedY), 30, 'centreline is kept')
  assert.equal(roundStockLength(repairedY), 100, 'length is kept')
})

test('normalizeRoundStock strips the feature source and maps a bad axis to x', () => {
  const withSource: RoundStock = {
    ...roundStock(20, 100, 'x'),
    sourceFeatureId: 'f1',
    sourceFeature: null,
  }
  const stripped = normalizeRoundStock(withSource)
  assert.equal('sourceFeatureId' in stripped, false, 'sourceFeatureId is removed')
  assert.equal('sourceFeature' in stripped, false, 'sourceFeature is removed')

  const badAxis = normalizeRoundStock({ ...roundStock(20, 100, 'x'), axis: 'z' as unknown as StockAxis })
  assert.equal(badAxis.axis, 'x', 'an unknown axis becomes x')
  const bananaAxis = normalizeRoundStock({ ...roundStock(20, 100, 'x'), axis: 'banana' as unknown as StockAxis })
  assert.equal(bananaAxis.axis, 'x', 'a nonsense axis becomes x')
})

test('normalizeRoundStock is idempotent', () => {
  const once = normalizeRoundStock({ ...roundStock(20, 100, 'y'), profile: rectProfile(3, 4, 60, 100) })
  assert.deepEqual(normalizeRoundStock(once), once, 'normalizing its own result changes nothing')
})

test('defaultOrigin keeps the block result and moves a round bar to its centreline', () => {
  assert.deepEqual(defaultOrigin(defaultStock(100, 80, 20, 'mm')),
    { name: 'Origin', x: 0, y: 80, z: 20, visible: true },
    'a block origin is the min-X / max-Y corner at thickness')

  assert.deepEqual(defaultOrigin(roundStock(20, 100, 'x', { x: 5, y: 7 })),
    { name: 'Origin', x: 5, y: 17, z: 20, visible: true },
    'an X bar origin is the min-X end on the centreline')
  assert.deepEqual(defaultOrigin(roundStock(20, 100, 'y', { x: 5, y: 7 })),
    { name: 'Origin', x: 15, y: 107, z: 20, visible: true },
    'a Y bar origin is the max-Y end on the centreline')
})

test('setupPivot lands on the round bar centreline at mid-diameter', () => {
  assert.deepEqual(setupPivot(roundStock(20, 100, 'x', { x: 5, y: 7 })),
    { x: 55, y: 17, z: 10 }, 'X bar pivot is at mid-length, centreline and mid-diameter')
  assert.deepEqual(setupPivot(roundStock(20, 100, 'y', { x: 5, y: 7 })),
    { x: 15, y: 57, z: 10 }, 'Y bar pivot is at mid-length, centreline and mid-diameter')
})

console.log('\nAll roundStock tests PASSED.')
