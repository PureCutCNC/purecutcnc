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
 * The square-blank half of the bar-stock model (#1016 C2-S1). A square blank
 * keeps `profile`/`thickness` as the box it fits in — length × side, thickness
 * = side — so every existing reader of the stock box needs no square case; the
 * new `barStock.ts` helpers add the shape-agnostic geometry beside the existing
 * round helpers without redefining them.
 *
 * Run with: npx tsx src/types/barStock.test.ts
 */

import assert from 'node:assert/strict'
import {
  defaultStock,
  getStockBounds,
  isRoundStock,
  normalizeRoundStock,
  rectProfile,
  roundStock,
  roundStockCentre,
  roundStockDiameter,
  roundStockLength,
  type RoundStock,
  type SquareStock,
  type StockAxis,
} from './project'
import {
  barCentre,
  barInscribedRadius,
  barLength,
  barMaxRadius,
  barPivotZ,
  barSurfaceRadius,
  isBarStock,
  isSquareStock,
  normalizeSquareStock,
  squareStock,
} from './barStock'

function test(name: string, fn: () => void): void {
  fn()
  console.log(`   ✓ ${name}`)
}

function closeTo(actual: number, expected: number, message: string, tolerance = 1e-12): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected}, got ${actual}`,
  )
}

// ── Shape predicates ──────────────────────────────────────────

test('isSquareStock and isBarStock read only the shape', () => {
  const block = defaultStock()
  const bar = roundStock(20, 100, 'x')
  const square = squareStock(20, 100, 'x')

  assert.equal(isSquareStock(bar), false, 'a round bar is not square')
  assert.equal(isSquareStock(square), true, 'a square blank is square')
  assert.equal(isBarStock(bar), true, 'a round bar is a bar')
  assert.equal(isBarStock(square), true, 'a square blank is a bar')
  assert.equal(isBarStock(block), false, 'a block is not a bar')
  assert.equal(isRoundStock(square), false, 'a square blank stays cylinder-only false for isRoundStock')
})

// ── Constructor geometry, both axes ───────────────────────────

test('squareStock(20, 100, x) is a blank 100 × 20 with thickness 20', () => {
  const blank = squareStock(20, 100, 'x')
  assert.deepEqual(getStockBounds(blank), { minX: 0, maxX: 100, minY: 0, maxY: 20 },
    'bounds are 100 along X, 20 across')
  assert.equal(blank.thickness, 20, 'thickness is the physical side')
  assert.equal(blank.axis, 'x', 'axis is x')
  assert.equal(blank.shape, 'square', 'shape is square')
  assert.equal(barLength(blank), 100, 'length is the X extent')
  assert.equal(barCentre(blank), 10, 'centre is the middle across X, a Y value')
  assert.equal(barPivotZ(blank), 10, 'pivot Z is half the side')
  assert.equal(barInscribedRadius(blank), 10, 'inscribed radius is half the side')
  closeTo(barMaxRadius(blank), 20 * Math.SQRT1_2, 'max radius is the corner radius side × √½')
})

test('squareStock(20, 100, y) swaps the box', () => {
  const blank = squareStock(20, 100, 'y')
  assert.deepEqual(getStockBounds(blank), { minX: 0, maxX: 20, minY: 0, maxY: 100 },
    'bounds are 20 along X, 100 along Y')
  assert.equal(barLength(blank), 100, 'length is the Y extent')
  assert.equal(barCentre(blank), 10, 'centre is the middle across Y, an X value')
  closeTo(barMaxRadius(blank), 20 * Math.SQRT1_2, 'max radius is the corner radius')
})

test('at moves the rectangle and the centre with it', () => {
  const blank = squareStock(20, 100, 'x', { x: 5, y: 7 })
  assert.deepEqual(getStockBounds(blank), { minX: 5, maxX: 105, minY: 7, maxY: 27 }, 'rectangle is translated')
  assert.equal(barCentre(blank), 17, 'centre follows the rectangle')
  assert.equal(barLength(blank), 100, 'length is unchanged')
})

test('axis defaults to x and the constructor mirrors the round defaults', () => {
  const blank = squareStock(20, 100)
  const bar = roundStock(20, 100)
  assert.equal(blank.axis, 'x', 'omitted axis is x')
  assert.equal(blank.material, bar.material, 'material matches roundStock')
  assert.equal(blank.color, bar.color, 'colour matches roundStock')
  assert.equal(blank.visible, bar.visible, 'visibility matches roundStock')
  assert.deepEqual(blank.origin, bar.origin, 'stock origin point matches roundStock')
  assert.deepEqual(getStockBounds(blank), getStockBounds(bar), 'the same box as the equivalent round bar')
})

test('inch-sized blanks keep the same box rules', () => {
  const blank = squareStock(0.75, 4, 'x', { x: 0.5, y: 1 })
  assert.deepEqual(getStockBounds(blank), { minX: 0.5, maxX: 4.5, minY: 1, maxY: 1.75 },
    'bounds are the inch numbers unchanged')
  assert.equal(barLength(blank), 4, 'length is the inch extent')
  assert.equal(barCentre(blank), 1.375, 'centre is the inch middle across')
  closeTo(barSurfaceRadius(blank, 45), 0.75 * Math.SQRT1_2, 'corner radius is the inch side over √2')
})

// ── Surface radius: flats, corners, multi-turn and negative angles ──

test('square surface radius is half the side on a flat and side/√2 at a corner', () => {
  const blank = squareStock(20, 100, 'x')
  for (const angle of [0, 90, 180, 270, 360, -90, -180, -270]) {
    closeTo(barSurfaceRadius(blank, angle), 10, `flat at ${angle}° is half the side`)
  }
  for (const angle of [45, 135, 225, 315, -45, -135, 405, 720 + 45]) {
    closeTo(barSurfaceRadius(blank, angle), 20 * Math.SQRT1_2, `corner at ${angle}° is side/√2`)
  }
})

test('multi-turn and negative angles wrap to the same radius', () => {
  const blank = squareStock(20, 100, 'y')
  closeTo(barSurfaceRadius(blank, 30), barSurfaceRadius(blank, 30 + 360 * 5), 'five extra turns are the same ray')
  closeTo(barSurfaceRadius(blank, 30), barSurfaceRadius(blank, 30 - 360 * 3), 'negative turns are the same ray')
  closeTo(barSurfaceRadius(blank, 0), barSurfaceRadius(blank, -360), 'a full negative turn is angle zero')
  closeTo(barSurfaceRadius(blank, 60), 10 / Math.max(Math.abs(Math.cos((60 * Math.PI) / 180)), Math.abs(Math.sin((60 * Math.PI) / 180))), 'the 60° radius is halfSide/max(|cos|,|sin|)')
  closeTo(barSurfaceRadius(blank, 60), 10 / Math.sin((60 * Math.PI) / 180), 'and at 60° the sine side is the crossing one')
})

test('round surface radius is constant and equals the round helpers', () => {
  const bar = roundStock(20, 100, 'x')
  for (const angle of [0, 30, 45, 90, 135, 180, 270, 405, -45, -720]) {
    closeTo(barSurfaceRadius(bar, angle), 10, `round radius at ${angle}° is the diameter/2`)
  }
  assert.equal(barInscribedRadius(bar), roundStockDiameter(bar) / 2, 'inscribed radius is diameter/2')
  closeTo(barMaxRadius(bar), roundStockDiameter(bar) / 2, 'max radius is diameter/2')
  assert.equal(barPivotZ(bar), roundStockDiameter(bar) / 2, 'pivot Z is diameter/2')
  assert.equal(barCentre(bar), roundStockCentre(bar), 'barCentre matches roundStockCentre')
  assert.equal(barLength(bar), roundStockLength(bar), 'barLength matches roundStockLength')
})

test('barMaxRadius is at least the surface radius at every angle', () => {
  const blanks = [squareStock(20, 100, 'x'), squareStock(0.75, 4, 'y', { x: 3, y: -2 }), roundStock(20, 100, 'y')]
  for (const blank of blanks) {
    const max = barMaxRadius(blank)
    for (let angle = -720; angle <= 720; angle += 1) {
      const surface = barSurfaceRadius(blank, angle)
      assert.ok(surface <= max + 1e-12, `${blank.shape} ${blank.axis}: radius at ${angle}° (${surface}) ≤ max (${max})`)
      assert.ok(surface >= barInscribedRadius(blank) - 1e-12, `${blank.shape} ${blank.axis}: radius at ${angle}° is at least inscribed`)
    }
  }
})

// ── Normalization ─────────────────────────────────────────────

test('normalizeSquareStock repairs the across-axis width, keeping the centreline and length', () => {
  const widenedX: SquareStock = { ...squareStock(20, 100, 'x'), profile: rectProfile(0, 0, 100, 50) }
  const repairedX = normalizeSquareStock(widenedX)
  assert.deepEqual(getStockBounds(repairedX), { minX: 0, maxX: 100, minY: 15, maxY: 35 },
    'X blank is 20 wide, centred on the old centreline 25')
  assert.equal(barCentre(repairedX), 25, 'centreline is kept')
  assert.equal(barLength(repairedX), 100, 'length is kept')
  assert.equal(repairedX.thickness, 20, 'side is kept')
  assert.equal(repairedX.shape, 'square', 'shape is kept')
  assert.equal(repairedX.axis, 'x', 'axis is kept')

  const widenedY: SquareStock = { ...squareStock(20, 100, 'y'), profile: rectProfile(0, 0, 60, 100) }
  const repairedY = normalizeSquareStock(widenedY)
  assert.deepEqual(getStockBounds(repairedY), { minX: 20, maxX: 40, minY: 0, maxY: 100 },
    'Y blank is 20 wide, centred on the old centreline 30')
  assert.equal(barCentre(repairedY), 30, 'centreline is kept')
  assert.equal(barLength(repairedY), 100, 'length is kept')
})

test('normalizeSquareStock strips the feature source and maps a bad axis to x', () => {
  const withSource: SquareStock = {
    ...squareStock(20, 100, 'x'),
    sourceFeatureId: 'f1',
    sourceFeature: null,
  }
  const stripped = normalizeSquareStock(withSource)
  assert.equal('sourceFeatureId' in stripped, false, 'sourceFeatureId is removed')
  assert.equal('sourceFeature' in stripped, false, 'sourceFeature is removed')

  const badAxis = normalizeSquareStock({ ...squareStock(20, 100, 'x'), axis: 'z' as unknown as StockAxis })
  assert.equal(badAxis.axis, 'x', 'an unknown axis becomes x')
  const bananaAxis = normalizeSquareStock({ ...squareStock(20, 100, 'x'), axis: 'banana' as unknown as StockAxis })
  assert.equal(bananaAxis.axis, 'x', 'a nonsense axis becomes x')
})

test('normalizeSquareStock is idempotent and does not disturb the round normalizer', () => {
  const once = normalizeSquareStock({ ...squareStock(20, 100, 'y'), profile: rectProfile(3, 4, 60, 100) })
  assert.deepEqual(normalizeSquareStock(once), once, 'normalizing its own result changes nothing')

  // The throwaway round copy must not have changed the round repair itself.
  const widenedRound: RoundStock = { ...roundStock(20, 100, 'x'), profile: rectProfile(0, 0, 100, 50) }
  const repairedRound = normalizeRoundStock(widenedRound)
  assert.deepEqual(getStockBounds(repairedRound), { minX: 0, maxX: 100, minY: 15, maxY: 35 },
    'the round normalizer still repairs the box')
  assert.equal(repairedRound.shape, 'round', 'the round normalizer still returns a round bar')
})

// ── Invalid input ─────────────────────────────────────────────

test('squareStock rejects a non-positive or non-finite side or length', () => {
  for (const side of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => squareStock(side, 100, 'x'), RangeError, `side ${side} is refused`)
  }
  for (const length of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => squareStock(20, length, 'x'), RangeError, `length ${length} is refused`)
  }
})

test('squareStock rejects a bad axis and a non-finite corner', () => {
  assert.throws(() => squareStock(20, 100, 'z' as unknown as StockAxis), RangeError, 'axis z is refused')
  assert.throws(() => squareStock(20, 100, 'banana' as unknown as StockAxis), RangeError, 'a nonsense axis is refused')
  assert.throws(() => squareStock(20, 100, 'x', { x: Number.NaN, y: 0 }), RangeError, 'a NaN corner is refused')
  assert.throws(() => squareStock(20, 100, 'x', { x: 0, y: Number.POSITIVE_INFINITY }), RangeError, 'an infinite corner is refused')
})

test('barSurfaceRadius rejects a non-finite angle', () => {
  const blank = squareStock(20, 100, 'x')
  assert.throws(() => barSurfaceRadius(blank, Number.NaN), RangeError, 'a NaN angle is refused')
  assert.throws(() => barSurfaceRadius(blank, Number.POSITIVE_INFINITY), RangeError, 'an infinite angle is refused')
})

console.log('\nAll barStock tests PASSED.')
