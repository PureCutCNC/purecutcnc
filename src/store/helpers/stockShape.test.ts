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
 * Choosing and sizing round stock (#392 slice B): the block↔bar conversion,
 * resizing a bar, the origin that follows a stock edit, and the reducer paths
 * that must keep a bar canonical and a block free of `shape`/`axis`.
 *
 * Run with: npx tsx src/store/helpers/stockShape.test.ts
 */

import assert from 'node:assert/strict'
import {
  defaultOrigin,
  defaultStock,
  getProfileBounds,
  getStockBounds,
  isRoundStock,
  newProject,
  normalizeRoundStock,
  rectProfile,
  roundStock,
  roundStockCentre,
  roundStockDiameter,
  roundStockLength,
  type MachineOrigin,
  type Project,
  type RoundStock,
  type SketchFeature,
  type Stock,
} from '../../types/project'
import { useProjectStore } from '../projectStore'
import { projectWithFeatures } from '../../test/projectFixtures'
import {
  originAfterStockEdit,
  resizeRoundStock,
  toBlockStock,
  toRoundStock,
} from './stockShape'

function assertCanonical(bar: RoundStock, label: string): void {
  assert.deepEqual(normalizeRoundStock(bar), bar, `${label}: normalizeRoundStock(r) deep-equals r`)
}

function seed(project: Project): void {
  useProjectStore.setState({ project, dirty: false, history: { past: [], future: [], transactionStart: null } })
}

function stockOf(): Stock {
  return useProjectStore.getState().project.stock
}

function originOf(): MachineOrigin {
  return useProjectStore.getState().project.origin
}

// ── toRoundStock ──────────────────────────────────────────────

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`   ✓ ${name}`)
  } catch (error: unknown) {
    failed += 1
    console.error(`   ✗ ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log('\nConverting a block to a round bar')

test('a 100 × 80 block becomes a 100 long, 20 diameter bar along X at its min corner', () => {
  const bar = toRoundStock(defaultStock(100, 80, 20))
  assert.equal(bar.axis, 'x', 'the long side runs along X')
  assert.equal(roundStockLength(bar), 100, 'length is the long side')
  assert.equal(roundStockDiameter(bar), 20, 'diameter is the block thickness')
  assert.deepEqual(getStockBounds(bar), { minX: 0, maxX: 100, minY: 0, maxY: 20 },
    'the bar box starts at the block min corner')
  assertCanonical(bar, 'a converted bar')
})

test('a 60 × 100 block becomes a bar along Y', () => {
  const bar = toRoundStock(defaultStock(60, 100, 20))
  assert.equal(bar.axis, 'y', 'the long side runs along Y')
  assert.equal(roundStockLength(bar), 100, 'length is the long side')
  assert.deepEqual(getStockBounds(bar), { minX: 0, maxX: 20, minY: 0, maxY: 100 }, 'the box is the block box')
})

test('a square block becomes a bar along X', () => {
  assert.equal(toRoundStock(defaultStock(80, 80, 20)).axis, 'x', 'a tie picks X')
})

test('a block carrying a feature source loses it, and colour, material and visibility survive', () => {
  const block: Stock = {
    ...defaultStock(100, 80, 20),
    material: 'steel_1018',
    color: '#123456',
    visible: false,
    sourceFeatureId: 'f-source',
    sourceFeature: null,
  }
  const bar = toRoundStock(block)
  assert.equal('sourceFeatureId' in bar, false, 'sourceFeatureId is dropped')
  assert.equal('sourceFeature' in bar, false, 'sourceFeature is dropped')
  assert.equal(bar.material, 'steel_1018', 'material survives')
  assert.equal(bar.color, '#123456', 'colour survives')
  assert.equal(bar.visible, false, 'visibility survives')
  assert.deepEqual(bar.origin, block.origin, 'the stock origin point survives')
})

test('an already-round stock is returned unchanged', () => {
  const bar = roundStock(20, 100, 'x', { x: 5, y: 7 })
  assert.equal(toRoundStock(bar), bar, 'the same object comes back')
})

// ── toBlockStock ──────────────────────────────────────────────

console.log('\nConverting a round bar back to a block')

test('toBlockStock(toRoundStock(block)) has the bar box and no shape or axis key', () => {
  const block = defaultStock(100, 80, 20)
  const bar = toRoundStock(block)
  const back = toBlockStock(bar)
  assert.deepEqual(getStockBounds(back), getStockBounds(bar), 'the bar box is kept')
  assert.equal(back.thickness, roundStockDiameter(bar), 'thickness is the diameter')
  assert.equal('shape' in back, false, 'no shape key')
  assert.equal('axis' in back, false, 'no axis key')
  assert.equal(isRoundStock(back), false, 'it is not round')
})

test('an already-block stock is returned unchanged', () => {
  const block = defaultStock(60, 100, 20)
  assert.equal(toBlockStock(block), block, 'the same object comes back')
})

// ── resizeRoundStock ──────────────────────────────────────────

console.log('\nResizing a round bar')

test('a diameter change keeps the centreline and the length', () => {
  const bar = roundStock(20, 100, 'x', { x: 5, y: 7 })
  const wider = resizeRoundStock(bar, { diameter: 30 })
  assert.equal(roundStockDiameter(wider), 30, 'the diameter is the new value')
  assert.equal(roundStockLength(wider), 100, 'the length is kept')
  assert.equal(roundStockCentre(wider), roundStockCentre(bar), 'the centreline is kept')
  assert.equal(getStockBounds(wider).minX, 5, 'the start end is kept')
  assertCanonical(wider, 'a diameter change on an X bar')

  const yBar = roundStock(20, 100, 'y', { x: 5, y: 7 })
  const yWider = resizeRoundStock(yBar, { diameter: 30 })
  assert.equal(roundStockCentre(yWider), roundStockCentre(yBar), 'a Y bar keeps its centreline too')
  assert.equal(roundStockLength(yWider), 100, 'a Y bar keeps its length')
  assertCanonical(yWider, 'a diameter change on a Y bar')
})

test('a length change keeps the centreline and the start end, for both axes', () => {
  const xBar = roundStock(20, 100, 'x', { x: 5, y: 7 })
  const xLonger = resizeRoundStock(xBar, { length: 140 })
  assert.deepEqual(getStockBounds(xLonger), { minX: 5, maxX: 145, minY: 7, maxY: 27 },
    'an X bar keeps minX (its start end) and grows towards +X')
  assert.equal(roundStockCentre(xLonger), roundStockCentre(xBar), 'the centreline is kept')
  assert.equal(roundStockDiameter(xLonger), 20, 'the diameter is kept')
  assertCanonical(xLonger, 'a length change on an X bar')

  const yBar = roundStock(20, 100, 'y', { x: 5, y: 7 })
  const yLonger = resizeRoundStock(yBar, { length: 140 })
  assert.deepEqual(getStockBounds(yLonger), { minX: 5, maxX: 25, minY: -33, maxY: 107 },
    'a Y bar keeps maxY (its start end) and grows towards -Y')
  assert.equal(roundStockCentre(yLonger), roundStockCentre(yBar), 'the centreline is kept')
  assert.equal(roundStockDiameter(yLonger), 20, 'the diameter is kept')
  assertCanonical(yLonger, 'a length change on a Y bar')
})

test('an axis change keeps the min corner, the length and the diameter', () => {
  const bar = roundStock(20, 100, 'x', { x: 5, y: 7 })
  const reaimed = resizeRoundStock(bar, { axis: 'y' })
  assert.deepEqual(getStockBounds(reaimed), { minX: 5, maxX: 25, minY: 7, maxY: 107 },
    'the min corner is kept and the bar now runs along Y')
  assert.equal(roundStockLength(reaimed), 100, 'the length is kept')
  assert.equal(roundStockDiameter(reaimed), 20, 'the diameter is kept')
  assertCanonical(reaimed, 'an axis change')
})

test('a bar that is not canonical is repaired before it is resized', () => {
  const widened: RoundStock = { ...roundStock(20, 100, 'x'), profile: rectProfile(0, 0, 100, 50) }
  const resized = resizeRoundStock(widened, { length: 60 })
  assert.equal(roundStockLength(resized), 60, 'the requested length is applied')
  assert.equal(roundStockCentre(resized), roundStockCentre(widened), 'the repaired centreline drives the result')
  assertCanonical(resized, 'a resize of a non-canonical bar')
})

// ── originAfterStockEdit ──────────────────────────────────────

console.log('\nThe origin after a stock edit')

test('an origin on the default place follows the new stock on x, y and z', () => {
  const before = defaultStock(100, 80, 20)
  const after = toRoundStock(before)
  const origin: MachineOrigin = { ...defaultOrigin(before), name: 'My origin', visible: false }
  const next = originAfterStockEdit(origin, before, after)
  assert.deepEqual(next, { ...origin, ...defaultOrigin(after), name: 'My origin', visible: false },
    'x, y and z follow; name and visibility are kept')
  assert.equal(next.name, 'My origin', 'the name is kept')
  assert.equal(next.visible, false, 'visibility is kept')
})

test('an origin the user moved is left alone, as the same object', () => {
  const before = defaultStock(100, 80, 20)
  const after = toRoundStock(before)
  const moved: MachineOrigin = { ...defaultOrigin(before), x: 12.5, y: -3 }
  assert.equal(originAfterStockEdit(moved, before, after), moved, 'the same object comes back')
})

// ── Reducer level ─────────────────────────────────────────────

console.log('\nThe store paths')

test('Block → Round bar is one undo step, and undo restores both stock and origin', () => {
  seed(newProject())
  const store = useProjectStore.getState()
  const beforeStock = stockOf()
  const beforeOrigin = originOf()

  const next = toRoundStock(beforeStock)
  store.setStockAndOrigin(next, {
    ...beforeOrigin,
    ...defaultOrigin(next),
    name: beforeOrigin.name,
    visible: beforeOrigin.visible,
  })

  assert.equal(isRoundStock(stockOf()), true, 'the stock is a bar')
  assert.deepEqual(originOf(), { ...beforeOrigin, ...defaultOrigin(next), name: beforeOrigin.name, visible: beforeOrigin.visible },
    'the origin moved to the bar default')
  assert.equal(useProjectStore.getState().history.past.length, 1, 'exactly one history entry')

  store.undo()
  assert.equal(isRoundStock(stockOf()), false, 'undo restores the block')
  assert.equal('shape' in stockOf(), false, 'the restored block carries no shape key')
  assert.deepEqual(originOf(), beforeOrigin, 'undo restores the origin')
})

test('setRectStockDimension across a bar axis changes the diameter and stays canonical', () => {
  seed({ ...newProject(), stock: roundStock(20, 100, 'x', { x: 5, y: 7 }) })
  const store = useProjectStore.getState()

  store.setRectStockDimension('height', 30, 'top')

  const bar = stockOf()
  assert.equal(isRoundStock(bar), true, 'it is still a bar')
  assert.equal(bar.thickness, 30, 'the diameter follows the across-axis value')
  assert.equal(getStockBounds(bar).minY, 7, 'the held side (top) is kept')
  assertCanonical(bar as RoundStock, 'a resized bar')

  store.setRectStockDimension('width', 140, 'left')
  const longer = stockOf() as RoundStock
  assert.equal(roundStockLength(longer), 140, 'an along-axis change is a length change')
  assert.equal(roundStockDiameter(longer), 30, 'the diameter is untouched by a length change')
  assert.equal(getStockBounds(longer).minX, 5, 'the held side (left) is kept')
  assertCanonical(longer, 'a lengthened bar')
})

test('making a feature the stock of a round project yields a block with no shape or axis', () => {
  const source: SketchFeature = {
    id: 'f-stock-source',
    name: 'Stock source',
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(0, 0, 40, 30),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'add',
    z_top: 10,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
  const withFeature = projectWithFeatures(newProject(), [source])
  seed({ ...withFeature, stock: roundStock(20, 100, 'x', { x: 5, y: 7 }) })
  const store = useProjectStore.getState()

  store.setStockSourceFeature(source.id)

  const stock = stockOf()
  assert.equal(stock.sourceFeatureId, source.id, 'the feature became the stock source')
  assert.equal(isRoundStock(stock), false, 'a feature stock is a block')
  assert.equal('shape' in stock, false, 'no shape key')
  assert.equal('axis' in stock, false, 'no axis key')
  assert.deepEqual(getStockBounds(stock), getProfileBounds(source.sketch.profile), 'the block is the feature outline box')
})

console.log(`\nRound stock shape helpers: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
