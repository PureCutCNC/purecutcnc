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
 * Square stock actions (#1016 C2-S2): the block/round/square conversions, the
 * square resize helper, the origin that follows a stock edit, and the real
 * store paths — `setStockShape`, `setStock`, `setRectStockDimension`,
 * `setStockSourceFeature` — on both axes, in mm and inch, off-origin, across
 * one undo/redo step, a transaction, a clamp selection and a project-type
 * change made through `projectWithProjectType` (the type is chosen at creation
 * since #1046, so no store action changes it).
 * No engine, frame, output or UI path is reached.
 *
 * Run with: npx tsx src/store/helpers/squareStockActions.test.ts
 */

import assert from 'node:assert/strict'
import {
  DEFAULT_SETUP_ID,
  defaultOrigin,
  defaultStock,
  getStockBounds,
  isRoundStock,
  newProject,
  rectProfile,
  roundStock,
  type Clamp,
  type MachineOrigin,
  type Operation,
  type Project,
  type Stock,
} from '../../types/project'
import {
  barCentre,
  barLength,
  barMaxRadius,
  barPivotZ,
  isSquareStock,
  normalizeSquareStock,
  squareStock,
} from '../../types/barStock'
import { projectWithFeatures } from '../../test/projectFixtures'
import { useProjectStore } from '../projectStore'
import { projectWithProjectType } from './projectTypeApply'
import {
  originAfterStockEdit,
  projectWithStockShape,
  resizeSquareStock,
  toBlockStock,
  toRoundStock,
  toSquareStock,
} from './stockShape'

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

function closeTo(actual: number, expected: number, message: string): void {
  assert.ok(Math.abs(actual - expected) <= 1e-9, `${message}: expected ${expected}, got ${actual}`)
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

function squareOf(): ReturnType<typeof squareStock> {
  const stock = stockOf()
  assert.ok(isSquareStock(stock), 'the stock is a square blank')
  return stock
}

/** A minimal enabled pocket operation on the project's Top setup, for retention checks. */
function pocketOperation(id: string): Operation {
  return {
    id,
    name: id,
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: [] },
    toolRef: 't1',
    setupId: DEFAULT_SETUP_ID,
    stepdown: 2,
    stepover: 0.4,
    feed: 800,
    plungeFeed: 300,
    rpm: 18000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 2,
    maxCarveDepth: 2,
  }
}

// ── Conversions ───────────────────────────────────────────────

console.log('\nBlock and bar conversions')

test('a 100 × 80 block becomes a square blank with the long side as length and the thickness as side', () => {
  const square = toSquareStock(defaultStock(100, 80, 20))
  assert.equal(square.shape, 'square', 'it is a square blank')
  assert.equal(square.axis, 'x', 'the long side runs along X')
  assert.equal(square.thickness, 20, 'the side is the block thickness')
  assert.equal(barLength(square), 100, 'the length is the long side')
  assert.deepEqual(getStockBounds(square), { minX: 0, maxX: 100, minY: 0, maxY: 20 },
    'the blank box starts at the block min corner')
  assert.deepEqual(normalizeSquareStock(square), square, 'the result is canonical')
})

test('a 60 × 100 block becomes a blank along Y', () => {
  const square = toSquareStock(defaultStock(60, 100, 20))
  assert.equal(square.axis, 'y', 'the long side runs along Y')
  assert.equal(barLength(square), 100, 'the length is the long side')
  assert.deepEqual(getStockBounds(square), { minX: 0, maxX: 20, minY: 0, maxY: 100 }, 'the box is the block box')
})

test('a block carrying a feature source loses it, and colour, material, visibility and the stock origin survive', () => {
  const block: Stock = {
    ...defaultStock(100, 80, 20),
    material: 'steel_1018',
    color: '#123456',
    visible: false,
    sourceFeatureId: 'f-source',
    sourceFeature: null,
  }
  const square = toSquareStock(block)
  assert.equal('sourceFeatureId' in square, false, 'sourceFeatureId is dropped')
  assert.equal('sourceFeature' in square, false, 'sourceFeature is dropped')
  assert.equal(square.material, 'steel_1018', 'material survives')
  assert.equal(square.color, '#123456', 'colour survives')
  assert.equal(square.visible, false, 'visibility survives')
  assert.deepEqual(square.origin, block.origin, 'the stock origin point survives')
})

test('round → square keeps the axis, centreline and length even when the bar is longer across than along', () => {
  const wide = roundStock(50, 20, 'x', { x: 5, y: 7 })
  const square = toSquareStock(wide)
  assert.equal(square.shape, 'square', 'it is a square blank')
  assert.equal(square.axis, 'x', 'the axis is kept, not re-chosen from the long side')
  assert.equal(square.thickness, 50, 'the side is the round diameter')
  assert.equal(barLength(square), 20, 'the length is kept, not stretched to the long side')
  assert.equal(barCentre(square), barCentre(wide), 'the centreline is kept')
  assert.deepEqual(getStockBounds(square), getStockBounds(wide), 'the box is unchanged')
})

test('square → round keeps the axis, centreline and length even when the blank is longer across than along', () => {
  const wide = squareStock(50, 20, 'x', { x: 5, y: 7 })
  const bar = toRoundStock(wide)
  assert.equal(bar.shape, 'round', 'it is a round bar')
  assert.equal(bar.axis, 'x', 'the axis is kept, not re-chosen from the long side')
  assert.equal(bar.thickness, 50, 'the diameter is the side')
  assert.equal(barLength(bar), 20, 'the length is kept')
  assert.equal(barCentre(bar), barCentre(wide), 'the centreline is kept')
  assert.deepEqual(getStockBounds(bar), getStockBounds(wide), 'the box is unchanged')
})

test('a bar of its own shape is returned unchanged', () => {
  const square = squareStock(20, 100, 'x', { x: 5, y: 7 })
  assert.equal(toSquareStock(square), square, 'a square stays the same object')
  const bar = roundStock(20, 100, 'x', { x: 5, y: 7 })
  assert.equal(toRoundStock(bar), bar, 'a round bar stays the same object')
})

test('toBlockStock turns a square into a keyless block of the same box', () => {
  const square = squareStock(20, 100, 'y', { x: 5, y: 7 })
  const block = toBlockStock(square)
  assert.equal('shape' in block, false, 'no shape key')
  assert.equal('axis' in block, false, 'no axis key')
  assert.equal(block.thickness, 20, 'the thickness is the side')
  assert.deepEqual(getStockBounds(block), getStockBounds(square), 'the box is kept')
})

// ── resizeSquareStock ─────────────────────────────────────────

console.log('\nResizing a square blank')

test('a side change keeps the centreline and the length, both axes and both units', () => {
  const cases = [
    { stock: squareStock(20, 100, 'x', { x: 5, y: 7 }), side: 30, start: 5 },
    { stock: squareStock(20, 100, 'y', { x: 5, y: 7 }), side: 30, start: 107 },
    { stock: squareStock(0.75, 4, 'x', { x: 0.5, y: 1 }), side: 1, start: 0.5 },
  ]
  for (const { stock, side, start } of cases) {
    const resized = resizeSquareStock(stock, { side })
    assert.equal(resized.thickness, side, `${stock.axis}: the side is the new value`)
    assert.equal(resized.axis, stock.axis, `${stock.axis}: the axis is kept`)
    assert.equal(barLength(resized), barLength(stock), `${stock.axis}: the length is kept`)
    assert.equal(barCentre(resized), barCentre(stock), `${stock.axis}: the centreline is kept`)
    const bounds = getStockBounds(resized)
    const startEnd = resized.axis === 'x' ? bounds.minX : bounds.maxY
    assert.equal(startEnd, start, `${stock.axis}: the start end is kept`)
    assert.deepEqual(normalizeSquareStock(resized), resized, `${stock.axis}: the result is canonical`)
  }
})

test('a length change keeps the centreline and the start end, both axes', () => {
  const xLonger = resizeSquareStock(squareStock(20, 100, 'x', { x: 5, y: 7 }), { length: 140 })
  assert.deepEqual(getStockBounds(xLonger), { minX: 5, maxX: 145, minY: 7, maxY: 27 },
    'an X blank keeps minX and grows towards +X')
  assert.equal(barCentre(xLonger), 17, 'the centreline is kept')
  assert.equal(xLonger.thickness, 20, 'the side is kept')

  const yLonger = resizeSquareStock(squareStock(20, 100, 'y', { x: 5, y: 7 }), { length: 140 })
  assert.deepEqual(getStockBounds(yLonger), { minX: 5, maxX: 25, minY: -33, maxY: 107 },
    'a Y blank keeps maxY and grows towards -Y')
  assert.equal(barCentre(yLonger), 15, 'the centreline is kept')
  assert.equal(yLonger.thickness, 20, 'the side is kept')
})

test('an axis change keeps the min corner, the length and the side', () => {
  const reaimed = resizeSquareStock(squareStock(20, 100, 'x', { x: 5, y: 7 }), { axis: 'y' })
  assert.deepEqual(getStockBounds(reaimed), { minX: 5, maxX: 25, minY: 7, maxY: 107 },
    'the min corner is kept and the blank now runs along Y')
  assert.equal(reaimed.thickness, 20, 'the side is kept')
  assert.equal(barLength(reaimed), 100, 'the length is kept')
})

test('a non-canonical blank is repaired before it is resized', () => {
  const widened = { ...squareStock(20, 100, 'x'), profile: rectProfile(0, 0, 100, 50) }
  const resized = resizeSquareStock(widened, { length: 60 })
  assert.equal(barLength(resized), 60, 'the requested length is applied')
  assert.equal(barCentre(resized), barCentre(widened), 'the repaired centreline drives the result')
  assert.deepEqual(normalizeSquareStock(resized), resized, 'the result is canonical')
})

test('a non-finite or non-positive side or length, or an unknown axis, is refused without mutating the input', () => {
  const stock = squareStock(20, 100, 'x', { x: 5, y: 7 })
  const snapshot = structuredClone(stock)
  for (const change of [{ side: 0 }, { side: -1 }, { side: Number.NaN }, { side: Number.POSITIVE_INFINITY },
    { length: 0 }, { length: Number.NaN }, { axis: 'z' as 'x' }]) {
    assert.throws(() => resizeSquareStock(stock, change), RangeError, `refused: ${JSON.stringify(change)}`)
  }
  assert.deepEqual(stock, snapshot, 'the input stock is untouched')
})

// ── originAfterStockEdit ──────────────────────────────────────

console.log('\nThe origin after a square stock edit')

test('an origin on the default place follows the new blank on x, y and z', () => {
  const before = squareStock(20, 100, 'x', { x: 5, y: 7 })
  const after = resizeSquareStock(before, { side: 30 })
  const origin: MachineOrigin = { ...defaultOrigin(before), name: 'My origin', visible: false }
  const next = originAfterStockEdit(origin, before, after)
  assert.deepEqual(next, { ...origin, ...defaultOrigin(after), name: 'My origin', visible: false },
    'x, y and z follow; name and visibility are kept')
  assert.equal(next.z, 30, 'Z follows the physical side')
  assert.equal(next.y, barCentre(after), 'Y is the new centreline on axis X')
})

test('an origin the user moved is left alone, as the same object', () => {
  const before = squareStock(20, 100, 'x', { x: 5, y: 7 })
  const after = resizeSquareStock(before, { side: 30 })
  const moved: MachineOrigin = { ...defaultOrigin(before), x: 12.5, y: -3 }
  assert.equal(originAfterStockEdit(moved, before, after), moved, 'the same object comes back')
})

test('a square default origin sits on the centreline with Z at the physical top, both axes', () => {
  const xBlank = squareStock(20, 100, 'x', { x: 5, y: 7 })
  assert.deepEqual(defaultOrigin(xBlank), { name: 'Origin', x: 5, y: 17, z: 20, visible: true },
    'axis X: X is the start end, Y the centreline, Z the side')
  const yBlank = squareStock(20, 100, 'y', { x: 5, y: 7 })
  assert.deepEqual(defaultOrigin(yBlank), { name: 'Origin', x: 15, y: 107, z: 20, visible: true },
    'axis Y: X the centreline, Y the start end, Z the side')
})

// ── projectWithStockShape ─────────────────────────────────────

console.log('\nSwitching the stock shape')

test('to square adds exactly one chuck and moves the origin to the blank default', () => {
  const block = { ...newProject('block', 'mm'), origin: { ...newProject('block', 'mm').origin, name: 'My origin', visible: false } }
  const next = projectWithStockShape(block, 'square')
  assert.equal(isSquareStock(next.stock), true, 'the stock is a square blank')
  assert.equal(next.clamps.length, 1, 'exactly one clamp was added')
  assert.equal(next.clamps[0].type, 'chuck', 'of type chuck')
  assert.deepEqual(next.origin, { ...defaultOrigin(next.stock), name: 'My origin', visible: false },
    'the origin moves to the blank default, keeping name and visibility')
  assert.deepEqual(next.origin, { name: 'My origin', x: 0, y: 10, z: 20, visible: false },
    'the default is the centreline origin')
})

test('round → square re-mints a too-small chuck and keeps exactly one', () => {
  const roundProject = projectWithStockShape(newProject('bar', 'mm'), 'round')
  const bar = roundProject.stock
  assert.ok(isRoundStock(bar), 'the project holds a round bar')
  const chuck = roundProject.clamps[0]
  assert.equal(chuck.type, 'chuck', 'the round project gained a chuck')
  // The round default (50 mm) already clears a 20 mm square's 28.284 mm corner
  // envelope, so make a genuinely too-small support: 25 mm is below the envelope.
  const small: Clamp = {
    ...chuck,
    h: 25,
    y: barCentre(bar) - 12.5,
    height: barPivotZ(bar) + 12.5,
  }
  const next = projectWithStockShape({ ...roundProject, clamps: [small] }, 'square')
  assert.ok(isSquareStock(next.stock), 'the stock is a square blank')
  assert.equal(next.clamps.filter((clamp) => clamp.type === 'chuck').length, 1, 'still one chuck')
  assert.notEqual(next.clamps[0], small, 'a chuck that no longer clears the corners is re-minted')
  assert.equal(next.clamps[0].id, small.id, 'the same clamp id is kept')
  closeTo(next.clamps[0].h, 4 * barMaxRadius(next.stock), 'the new diameter clears the corner envelope')
  closeTo(next.clamps[0].height, next.stock.thickness / 2 + next.clamps[0].h / 2, 'raised to the true pivot')

  const back = projectWithStockShape(next, 'round')
  assert.equal(back.clamps.filter((clamp) => clamp.type === 'chuck').length, 1, 'returning to round adds no second chuck')
  assert.equal(back.clamps[0], next.clamps[0], 'the square-sized chuck already clears the round bar, so it is kept as-is')
})

test('square → block removes every chuck and tailstock, keeps other clamps and follows the origin', () => {
  const square = squareStock(20, 100, 'x', { x: 5, y: 7 })
  const project = {
    ...newProject('square', 'mm'),
    stock: square,
    origin: defaultOrigin(square),
    clamps: [
      { id: 'cl-chuck', name: 'Chuck', type: 'chuck' as const, x: -40, y: 0, w: 55, h: 30, height: 20, visible: true },
      { id: 'cl-step', name: 'Step', type: 'step_clamp' as const, x: 1, y: 2, w: 10, h: 10, height: 3, visible: true },
    ],
  }
  const next = projectWithStockShape(project, 'block')
  assert.equal('shape' in next.stock, false, 'the stock is a keyless block')
  assert.equal('axis' in next.stock, false, 'no axis key')
  assert.deepEqual(next.clamps.map((clamp) => clamp.id), ['cl-step'], 'only the ordinary clamp is left')
  assert.equal(next.origin.y, getStockBounds(next.stock).maxY, 'the origin returned to the block corner')
})

test('the same shape returns the same project object', () => {
  const project = { ...newProject('square', 'mm'), stock: squareStock(20, 100, 'x') }
  assert.equal(projectWithStockShape(project, 'square'), project, 'a square stays a square')
})

test('a shape switch resets a moved origin to the new shape default (existing behaviour, only name and visibility kept)', () => {
  const block = newProject('moved', 'mm')
  const project = { ...block, origin: { ...block.origin, name: 'Mine', x: 12, y: -3, visible: false } }
  const next = projectWithStockShape(project, 'square')
  assert.deepEqual(next.origin, { ...defaultOrigin(next.stock), name: 'Mine', visible: false },
    'x, y and z are reset; name and visibility survive')
  assert.notEqual(next.origin.x, 12, 'the moved x did not survive the shape switch')
})

// ── Store actions ─────────────────────────────────────────────

console.log('\nThe store paths')

test('Block → Square is one undo step; undo restores stock, origin and clamps, redo re-applies them', () => {
  seed(newProject('switch', 'mm'))
  const store = useProjectStore.getState()
  const beforeOrigin = originOf()

  store.setStockShape('square')

  const square = squareOf()
  assert.equal(square.axis, 'x', 'the long side became the length axis')
  assert.equal(square.thickness, 20, 'the side is the block thickness')
  assert.equal(useProjectStore.getState().project.clamps.length, 1, 'a chuck was added')
  assert.deepEqual(originOf(), { ...defaultOrigin(square), name: beforeOrigin.name, visible: beforeOrigin.visible },
    'the origin moved to the blank default')
  assert.equal(useProjectStore.getState().history.past.length, 1, 'exactly one history entry')

  store.undo()
  assert.equal('shape' in stockOf(), false, 'undo restores the block')
  assert.equal(useProjectStore.getState().project.clamps.length, 0, 'undo removes the chuck')
  assert.deepEqual(originOf(), beforeOrigin, 'undo restores the origin')

  store.redo()
  assert.equal(isSquareStock(stockOf()), true, 'redo brings the square back')
  assert.equal(useProjectStore.getState().project.clamps.length, 1, 'and its chuck')
})

test('a transaction wraps a shape switch and a resize into a single undo/redo step', () => {
  seed(newProject('transaction', 'mm'))
  const store = useProjectStore.getState()

  store.beginHistoryTransaction()
  store.setStockShape('square')
  store.setRectStockDimension('height', 30, 'top')
  store.commitHistoryTransaction()

  const square = squareOf()
  assert.equal(square.thickness, 30, 'the resize is inside the transaction')
  assert.equal(barLength(square), 100, 'the length is untouched')
  assert.equal(useProjectStore.getState().history.past.length, 1, 'one undo step for the whole transaction')

  store.undo()
  assert.equal('shape' in stockOf(), false, 'undo returns to the block, not the square at side 20')
  assert.equal(useProjectStore.getState().history.past.length, 0, 'the transaction is one entry')

  store.redo()
  assert.equal(isSquareStock(stockOf()), true, 'redo returns the square')
  assert.equal(squareOf().thickness, 30, 'with the resized side, once')
})

test('setRectStockDimension across a square changes the side and the physical Z extent, holding the chosen side', () => {
  const stock = squareStock(20, 100, 'x', { x: 5, y: 7 })
  seed({ ...newProject('resize', 'mm'), stock, origin: defaultOrigin(stock) })
  const store = useProjectStore.getState()

  store.setRectStockDimension('height', 30, 'top')

  const square = squareOf()
  assert.equal(square.thickness, 30, 'the side follows the across-axis value')
  assert.equal(square.profile.start.y, 7, 'the held side (top) is kept')
  assert.equal(getStockBounds(square).maxY - getStockBounds(square).minY, 30, 'the across width equals the side')
  assert.equal(barLength(square), 100, 'the length is untouched')
  assert.deepEqual(normalizeSquareStock(square), square, 'the blank stays canonical')

  store.setRectStockDimension('width', 140, 'left')
  const longer = squareOf()
  assert.equal(barLength(longer), 140, 'an along-axis change is a length change')
  assert.equal(longer.thickness, 30, 'the side is untouched by a length change')
  assert.equal(getStockBounds(longer).minX, 5, 'the held side (left) is kept')
  assert.deepEqual(normalizeSquareStock(longer), longer, 'the blank stays canonical')
})

test('the square chuck stays on the true pivot through a side resize, keeping its own diameter', () => {
  seed(newProject('pivot', 'mm'))
  const store = useProjectStore.getState()
  store.setStockShape('square')
  const before = useProjectStore.getState().project.clamps[0]
  assert.equal(useProjectStore.getState().project.clamps.length, 1, 'the blank has a chuck')

  store.setRectStockDimension('height', 30, 'top')

  const after = useProjectStore.getState().project.clamps[0]
  const resized = squareOf()
  assert.equal(after.h, before.h, 'the user-visible diameter is preserved')
  assert.equal(after.y, barCentre(resized) - after.h / 2, 'it is recentred on the new centreline')
  assert.equal(after.height, resized.thickness / 2 + after.h / 2, 'the height is the true pivot plus its radius')
})

test('setStock keeps a written square canonical, repairing the across width onto the centreline', () => {
  seed(newProject('canonical', 'mm'))
  const store = useProjectStore.getState()
  const nonCanonical = { ...squareStock(20, 100, 'x', { x: 5, y: 7 }), profile: rectProfile(5, 7, 100, 50) }

  store.setStock(nonCanonical)

  const square = squareOf()
  assert.equal(square.thickness, 20, 'the physical side is untouched')
  assert.equal(getStockBounds(square).maxY - getStockBounds(square).minY, 20, 'the across width is repaired to the side')
  assert.equal(barCentre(square), 32, 'the old centreline is kept')
  assert.equal(useProjectStore.getState().history.past.length, 1, 'it is one undo step')
})

test('setStockAndOrigin stores the square and its origin together in one step', () => {
  seed(newProject('pair', 'mm'))
  const store = useProjectStore.getState()
  const square = squareStock(20, 100, 'y', { x: 5, y: 7 })
  const origin = { ...defaultOrigin(square), name: 'Custom' }

  store.setStockAndOrigin(square, origin)

  assert.equal(squareOf().axis, 'y', 'the square is stored')
  assert.deepEqual(originOf(), origin, 'the origin is stored as given')
  assert.equal(useProjectStore.getState().history.past.length, 1, 'one undo step')
})

test('making a feature the stock of a square project yields a keyless block, not an arbitrary square profile', () => {
  const base = newProject('source', 'mm')
  const feature = {
    id: 'f-stock-source',
    name: 'Stock source',
    kind: 'rect' as const,
    folderId: null,
    sketch: {
      profile: rectProfile(0, 0, 40, 30),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'add' as const,
    z_top: 10,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
  const withFeature = projectWithFeatures(base, [feature])
  const stock = squareStock(20, 100, 'x', { x: 5, y: 7 })
  seed({ ...withFeature, stock, origin: defaultOrigin(stock) })
  const store = useProjectStore.getState()

  store.setStockSourceFeature(feature.id)

  const next = stockOf()
  assert.equal(next.sourceFeatureId, feature.id, 'the feature became the stock source')
  assert.equal('shape' in next, false, 'the square shape is gone')
  assert.equal('axis' in next, false, 'and its axis with it')
  assert.deepEqual(getStockBounds(next), { minX: 0, maxX: 40, minY: 0, maxY: 30 }, 'the block is the feature outline box')
})

test('enterStockSketchEdit on a square blank with no source feature changes nothing', () => {
  const stock = squareStock(20, 100, 'x', { x: 5, y: 7 })
  seed({ ...newProject('square-edit', 'mm'), stock, origin: defaultOrigin(stock) })
  const store = useProjectStore.getState()
  const before = useProjectStore.getState().project

  store.enterStockSketchEdit('f-none')

  assert.equal(useProjectStore.getState().project, before, 'the project is untouched')
  assert.equal(isSquareStock(stockOf()), true, 'the blank is still square')
})

test('switching a square to a block drops the removed tailstock from the selection', () => {
  const stock = squareStock(20, 100, 'x', { x: 5, y: 7 })
  const tailstock = {
    id: 'cl-tail', name: 'Tailstock', type: 'tailstock' as const,
    x: 100, y: 0, w: 40, h: 30, height: 20, visible: true,
  }
  seed({ ...newProject('selection', 'mm'), stock, origin: defaultOrigin(stock), clamps: [tailstock] })
  const store = useProjectStore.getState()

  store.selectClamp('cl-tail')
  assert.deepEqual(useProjectStore.getState().selection.selectedClampIds, ['cl-tail'], 'the tailstock is selected')

  store.setStockShape('block')

  const selection = useProjectStore.getState().selection
  assert.deepEqual(selection.selectedClampIds, [], 'the removed clamp is dropped from the selection')
  assert.notEqual(selection.selectedNode?.type, 'clamp', 'no stale clamp stays primary')
})

// ── Project type ──────────────────────────────────────────────

console.log('\nProject type changes')

test('a type change to Rotary preserves an already-square blank', () => {
  const stock = squareStock(20, 100, 'x', { x: 5, y: 7 })
  const project = {
    ...newProject('square-rotary', 'mm'),
    stock,
    origin: defaultOrigin(stock),
    meta: { ...newProject('square-rotary', 'mm').meta, projectType: 'rotary' as const },
  }
  const next = projectWithProjectType(project, 'rotary', [])
  assert.equal(next, project, 'nothing changes, so the same project comes back')
  assert.equal(isSquareStock(next.stock), true, 'the blank is still square')
})

test('leaving Rotary converts a square to a block without deleting authored features or operations', () => {
  const stock = squareStock(20, 100, 'x', { x: 5, y: 7 })
  const feature = {
    id: 'f-authored',
    name: 'Authored',
    kind: 'rect' as const,
    folderId: null,
    sketch: {
      profile: rectProfile(10, 10, 20, 20),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract' as const,
    z_top: 10,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
  const operation = pocketOperation('op-authored')
  const built = projectWithFeatures(newProject('leave-rotary', 'mm'), [feature])
  const project: Project = {
    ...built,
    stock,
    origin: defaultOrigin(stock),
    operations: [operation],
    meta: { ...built.meta, projectType: 'rotary' },
  }

  const next = projectWithProjectType(project, 'milling', [])

  assert.equal('shape' in next.stock, false, 'the square became a block through the existing conversion')
  assert.deepEqual(next.features, project.features, 'the authored feature is kept')
  assert.deepEqual(next.operations, project.operations, 'the operation is kept')
  assert.equal(next.meta.projectType, 'milling', 'the type moved')
})

test('giving a square project Rotary again leaves it square, unchanged', () => {
  const stock = squareStock(20, 100, 'x', { x: 5, y: 7 })
  const project: Project = {
    ...newProject('type-square', 'mm'),
    stock,
    origin: defaultOrigin(stock),
    meta: { ...newProject('type-square', 'mm').meta, projectType: 'rotary' },
  }

  const next = projectWithProjectType(project, 'rotary', [])

  assert.equal(next, project, 'nothing changes, so the same project object comes back')
  assert.equal(isSquareStock(next.stock), true, 'the blank is still square')
})

test('giving a square project Milling converts it to a block', () => {
  const block = {
    ...newProject('type-leave', 'mm'),
    meta: { ...newProject('type-leave', 'mm').meta, projectType: 'rotary' as const },
  }
  const project = projectWithStockShape(block, 'square')
  const chuckCount = project.clamps.filter((clamp) => clamp.type === 'chuck').length

  const next = projectWithProjectType(project, 'milling', [])

  assert.equal('shape' in next.stock, false, 'the blank became a block')
  assert.equal(next.clamps.filter((clamp) => clamp.type === 'chuck').length, 0, 'the block has no chuck')
  assert.equal(chuckCount, 1, 'there was exactly one to lose')
})

// ── Invariant across the seams ────────────────────────────────

console.log('\nThe square box invariant')

test('every square the actions produce keeps the across width equal to the side', () => {
  const shapes: Stock[] = [
    toSquareStock(defaultStock(100, 80, 20)),
    toSquareStock(roundStock(50, 20, 'x', { x: 5, y: 7 })),
    resizeSquareStock(squareStock(20, 100, 'x', { x: 5, y: 7 }), { side: 30 }),
    resizeSquareStock(squareStock(20, 100, 'y', { x: 5, y: 7 }), { length: 140 }),
    normalizeSquareStock({ ...squareStock(20, 100, 'x'), profile: rectProfile(0, 0, 100, 50) }),
  ]
  for (const shape of shapes) {
    assert.ok(isSquareStock(shape), 'it is a square blank')
    const bounds = getStockBounds(shape)
    const across = shape.axis === 'x' ? bounds.maxY - bounds.minY : bounds.maxX - bounds.minX
    closeTo(across, shape.thickness, 'the across width equals the physical side')
    assert.deepEqual(normalizeSquareStock(shape), shape, 'and the blank is canonical')
  }
})

console.log(`\nSquare stock actions: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
