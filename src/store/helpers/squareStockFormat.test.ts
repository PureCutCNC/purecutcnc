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
 * Square stock through the real persistence seams (#1016 C2-S1): the .camj
 * save/load canonicalization in `projectFormat.ts`, the project-type inference
 * in `projectType.ts`, and the existing `convertProjectUnits` unit conversion.
 * Nothing is mocked and no schema version moves — an old block or round bar
 * must still serialize to the exact bytes it did before.
 *
 * Run with: npx tsx src/store/helpers/squareStockFormat.test.ts
 */

import assert from 'node:assert/strict'
import {
  defaultOrigin,
  defaultStock,
  getStockBounds,
  newProject,
  rectProfile,
  roundStock,
  type Project,
  type Stock,
  type StockAxis,
} from '../../types/project'
import { isSquareStock, squareStock } from '../../types/barStock'
import { convertProjectUnits, type Units } from '../../utils/units'
import { decodeProjectFormat } from './projectFormat'
import { inferProjectTypeFrom } from './projectType'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`   ✓ ${name}`)
  } catch (error: unknown) {
    failed += 1
    console.log(`   ✗ ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function closeTo(actual: number, expected: number, message: string): void {
  assert.ok(Math.abs(actual - expected) <= 1e-9, `${message}: expected ${expected}, got ${actual}`)
}

/** A whole project holding `stock`, as the store would hand it to the saver. */
function projectWithStock(stock: Stock, units: Units = 'mm'): Project {
  const base = newProject('square-stock', units)
  return { ...base, stock, origin: defaultOrigin(stock) }
}

/** The real save → JSON → load path. */
function saveAndLoad(project: Project): Project {
  return decodeProjectFormat(JSON.parse(JSON.stringify(project))).project
}

// ── The frozen baseline: an old block and an old round bar ────
//
// Captured at the C2-S1 base commit by round-tripping `defaultStock()` and
// `roundStock(...)` through `decodeProjectFormat`, so these literals are the
// actual serialized output, key order included — not a count or a shape up to
// isomorphism. A change that adds a key, drops one, or reorders the object
// fails here.

const BLOCK_BASELINE_JSON = '{"profile":{"start":{"x":0,"y":0},"segments":[{"type":"line","to":{"x":100,"y":0}},{"type":"line","to":{"x":100,"y":80}},{"type":"line","to":{"x":0,"y":80}},{"type":"line","to":{"x":0,"y":0}}],"closed":true},"thickness":20,"material":"aluminum_6061","color":"#b9a83c","visible":true,"origin":{"x":0,"y":0}}'
const ROUND_X_BASELINE_JSON = '{"shape":"round","axis":"x","profile":{"start":{"x":0,"y":0},"segments":[{"type":"line","to":{"x":100,"y":0}},{"type":"line","to":{"x":100,"y":20}},{"type":"line","to":{"x":0,"y":20}},{"type":"line","to":{"x":0,"y":0}}],"closed":true},"thickness":20,"material":"aluminum_6061","color":"#b9a83c","visible":true,"origin":{"x":0,"y":0}}'
const ROUND_Y_BASELINE_JSON = '{"shape":"round","axis":"y","profile":{"start":{"x":5,"y":7},"segments":[{"type":"line","to":{"x":25,"y":7}},{"type":"line","to":{"x":25,"y":107}},{"type":"line","to":{"x":5,"y":107}},{"type":"line","to":{"x":5,"y":7}}],"closed":true},"thickness":20,"material":"aluminum_6061","color":"#b9a83c","visible":true,"origin":{"x":0,"y":0}}'

function serializedStock(stock: Stock, units: Units = 'mm'): string {
  return JSON.stringify(saveAndLoad(projectWithStock(stock, units)).stock)
}

test('an old block still serializes byte-identically, with no shape or axis key', () => {
  const block = saveAndLoad(projectWithStock(defaultStock(undefined, undefined, undefined, 'mm'))).stock
  assert.equal(JSON.stringify(block), BLOCK_BASELINE_JSON, 'the block stock is byte-identical to the baseline')
  assert.equal('shape' in block, false, 'no shape key is invented for a block')
  assert.equal('axis' in block, false, 'no axis key is invented for a block')
})

test('an old round bar still serializes byte-identically on both axes', () => {
  assert.equal(serializedStock(roundStock(20, 100, 'x')), ROUND_X_BASELINE_JSON, 'the X bar is byte-identical')
  assert.equal(serializedStock(roundStock(20, 100, 'y', { x: 5, y: 7 })), ROUND_Y_BASELINE_JSON, 'the Y bar is byte-identical')
})

test('a file with no shape stays a block, and an unknown shape still becomes one', () => {
  const plain = saveAndLoad(projectWithStock(defaultStock(undefined, undefined, undefined, 'mm'))).stock
  assert.equal(plain.shape, undefined, 'shape stays absent')

  const raw = JSON.parse(serializedStock(roundStock(20, 100, 'x'))) as Record<string, unknown>
  raw.shape = 'banana'
  raw.axis = 'z'
  const project = projectWithStock(defaultStock(undefined, undefined, undefined, 'mm'))
  const loaded = decodeProjectFormat({ ...JSON.parse(JSON.stringify(project)), stock: raw }).project
  assert.equal('shape' in loaded.stock, false, 'an unknown shape is dropped')
  assert.equal('axis' in loaded.stock, false, 'and its axis with it')
})

// ── Square survives the load, both axes and units ─────────────

test('square stock round-trips with shape, axis and side, both axes and units', () => {
  const cases: Array<{ axis: StockAxis; units: Units; side: number; length: number; at: { x: number; y: number } }> = [
    { axis: 'x', units: 'mm', side: 20, length: 100, at: { x: 5, y: 7 } },
    { axis: 'y', units: 'mm', side: 20, length: 100, at: { x: 5, y: 7 } },
    { axis: 'x', units: 'inch', side: 0.75, length: 4, at: { x: 0.5, y: 1 } },
    { axis: 'y', units: 'inch', side: 0.75, length: 4, at: { x: 0.5, y: 1 } },
  ]
  for (const { axis, units, side, length, at } of cases) {
    const stock = squareStock(side, length, axis, at)
    const loaded = saveAndLoad(projectWithStock(stock, units)).stock
    assert.equal(loaded.shape, 'square', `${axis}/${units}: shape survives`)
    assert.ok(isSquareStock(loaded), `${axis}/${units}: the guard agrees`)
    assert.equal(loaded.axis, axis, `${axis}/${units}: axis survives`)
    assert.equal(loaded.thickness, side, `${axis}/${units}: the side survives`)
    assert.deepEqual(getStockBounds(loaded), getStockBounds(stock), `${axis}/${units}: the box survives`)
    assert.deepEqual(loaded, stock, `${axis}/${units}: the whole canonical stock survives`)
  }
})

test('a square load repairs a non-canonical profile and drops a feature source', () => {
  const widened = {
    ...squareStock(20, 100, 'x'),
    profile: rectProfile(0, 0, 100, 50),
    sourceFeatureId: 'f1',
    sourceFeature: null,
  }
  const loaded = decodeProjectFormat(JSON.parse(JSON.stringify(projectWithStock(widened)))).project.stock
  assert.deepEqual(getStockBounds(loaded), { minX: 0, maxX: 100, minY: 15, maxY: 35 },
    'the across width is repaired onto the old centreline')
  assert.equal(loaded.shape, 'square', 'the shape is kept through the repair')
  assert.equal(loaded.axis, 'x', 'the axis is kept through the repair')
  assert.equal('sourceFeatureId' in loaded, false, 'the feature source id is dropped')
  assert.equal('sourceFeature' in loaded, false, 'the feature source row is dropped')
})

// ── The existing unit seam ────────────────────────────────────

test('convertProjectUnits keeps the square shape, axis and off-origin box across mm↔inch', () => {
  const mmStock = squareStock(20, 100, 'x', { x: 5, y: 7 })
  const mmProject = projectWithStock(mmStock, 'mm')
  const inches = convertProjectUnits(mmProject, 'inch')

  assert.equal(inches.meta.units, 'inch', 'the project units moved')
  assert.equal(inches.stock.shape, 'square', 'the shape survives mm→inch')
  assert.equal(inches.stock.axis, 'x', 'the axis survives mm→inch')
  closeTo(inches.stock.thickness, 20 / 25.4, 'the side is converted')
  assert.deepEqual(getStockBounds(inches.stock), {
    minX: 5 / 25.4,
    maxX: 105 / 25.4,
    minY: 7 / 25.4,
    maxY: 27 / 25.4,
  }, 'the off-origin box is converted, not recentred')

  const back = convertProjectUnits(inches, 'mm')
  assert.equal(back.stock.shape, 'square', 'the shape survives inch→mm')
  assert.equal(back.stock.axis, 'x', 'the axis survives inch→mm')
  closeTo(back.stock.thickness, 20, 'the side returns to mm')
  const before = getStockBounds(mmStock)
  const after = getStockBounds(back.stock)
  closeTo(after.minX, before.minX, 'the min X returns to mm')
  closeTo(after.maxX, before.maxX, 'the max X returns to mm')
  closeTo(after.minY, before.minY, 'the min Y returns to mm')
  closeTo(after.maxY, before.maxY, 'the max Y returns to mm')
})

test('convertProjectUnits keeps a Y square blank square and adds no key to a block or round bar', () => {
  const inches = convertProjectUnits(projectWithStock(squareStock(0.75, 4, 'y', { x: 1, y: 0.5 }), 'inch'), 'mm')
  assert.equal(inches.stock.shape, 'square', 'the shape survives inch→mm on Y')
  assert.equal(inches.stock.axis, 'y', 'the axis survives inch→mm on Y')
  closeTo(inches.stock.thickness, 0.75 * 25.4, 'the side is converted on Y')

  const block = convertProjectUnits(projectWithStock(defaultStock(undefined, undefined, undefined, 'mm')), 'inch').stock
  assert.equal('shape' in block, false, 'a converted block gains no shape key')
  assert.equal('axis' in block, false, 'a converted block gains no axis key')

  const bar = convertProjectUnits(projectWithStock(roundStock(20, 100, 'x')), 'inch').stock
  assert.equal(bar.shape, 'round', 'a converted round bar stays round')
  assert.equal(bar.axis, 'x', 'a converted round bar keeps its axis')
  closeTo(bar.thickness, 20 / 25.4, 'a converted round bar converts its diameter')
})

// ── Inference ─────────────────────────────────────────────────

test('a square blank infers a rotary project exactly where a round bar does', () => {
  const meta = { machineDefinitions: [], selectedMachineId: null }
  assert.equal(inferProjectTypeFrom(meta, squareStock(20, 100, 'x')), 'rotary', 'a square blank is a turning job')
  assert.equal(inferProjectTypeFrom(meta, squareStock(20, 100, 'y')), 'rotary', 'on either axis')
  assert.equal(inferProjectTypeFrom(meta, roundStock(20, 100, 'x')), 'rotary', 'a round bar still is too')
  assert.equal(inferProjectTypeFrom(meta, defaultStock()), 'milling', 'a block is still milling')

  // Through the real load path, with no stored type: the field is inferred.
  const raw = JSON.parse(JSON.stringify(projectWithStock(squareStock(20, 100, 'x')))) as Record<string, unknown>
  delete (raw.meta as Record<string, unknown>).projectType
  assert.equal(decodeProjectFormat(raw).project.meta.projectType, 'rotary', 'a saved square project loads as rotary')
})

// ── A custom origin stays custom ──────────────────────────────

test('a square blank with a custom corner origin keeps it on load — the legacy block migration never applies to a bar', () => {
  const stock = squareStock(20, 100, 'x', { x: 5, y: 7 })
  const bounds = getStockBounds(stock)
  // The exact shape of the legacy block default origin: min corner, Z = thickness.
  const cornerOrigin = { name: 'Origin', x: bounds.minX, y: bounds.minY, z: stock.thickness, visible: true }
  const loaded = saveAndLoad({ ...projectWithStock(stock), origin: cornerOrigin })
  assert.deepEqual(loaded.origin, cornerOrigin, 'the square keeps the origin the user put on its corner')
  assert.notDeepEqual(defaultOrigin(loaded.stock), cornerOrigin,
    'the default origin really is elsewhere, so the migration would have moved it')

  // The same origin on a block is still migrated to the block default.
  const blockCorner = { name: 'Origin', x: 0, y: 0, z: 20, visible: true }
  const loadedBlock = saveAndLoad({ ...projectWithStock(defaultStock(100, 80, 20)), origin: blockCorner })
  assert.deepEqual(loadedBlock.origin, defaultOrigin(loadedBlock.stock),
    'a block still takes the legacy migration')
})

test('a moved square origin survives save/load and the existing unit conversion', () => {
  const stock = squareStock(20, 100, 'x', { x: 5, y: 7 })
  const moved = { name: 'Corner', x: 3, y: -2, z: 12, visible: false }
  const project = { ...projectWithStock(stock), origin: moved }

  assert.deepEqual(saveAndLoad(project).origin, moved, 'save/load keeps the moved origin exactly')

  const inches = convertProjectUnits(project, 'inch')
  closeTo(inches.origin.x, 3 / 25.4, 'the origin X converts')
  closeTo(inches.origin.y, -2 / 25.4, 'the origin Y converts')
  closeTo(inches.origin.z, 12 / 25.4, 'the origin Z converts')
  assert.equal(inches.origin.name, 'Corner', 'the name survives')
  assert.equal(inches.origin.visible, false, 'the visibility survives')
  assert.equal(inches.stock.shape, 'square', 'the blank stays square through the conversion')

  const back = saveAndLoad(convertProjectUnits(inches, 'mm'))
  closeTo(back.origin.x, 3, 'the origin X returns to mm')
  closeTo(back.origin.y, -2, 'the origin Y returns to mm')
  closeTo(back.origin.z, 12, 'the origin Z returns to mm')
  assert.equal(back.stock.shape, 'square', 'the loaded blank is still square')
  assert.equal(back.stock.axis, 'x', 'and keeps its axis')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
console.log('All squareStockFormat tests PASSED.')
