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
 * A chuck and a tailstock on a square blank (#1016 C2-S2): their default size
 * and place on both axes and in both units, that the default clears the corner
 * envelope but stays centred at the true pivot (side/2), and that the sync
 * recentres without ever enlarging a diameter the user set by hand. The round
 * numbers and the existing round tests are unchanged.
 *
 * Run with: npx tsx src/store/helpers/squareWorkholding.test.ts
 */

import assert from 'node:assert/strict'
import {
  defaultOrigin,
  getStockBounds,
  newProject,
  roundStock,
  type Clamp,
  type Project,
} from '../../types/project'
import {
  barCentre,
  barMaxRadius,
  barPivotZ,
  isSquareStock,
  squareStock,
} from '../../types/barStock'
import { convertLength } from '../../utils/units'
import { useProjectStore } from '../projectStore'
import { projectWithStockShape } from './stockShape'
import {
  defaultRoundWorkholding,
  roundWorkholdingDiameter,
  syncRoundWorkholding,
} from './roundWorkholding'

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

/** A square blank with one chuck at the blank's real default — as the shape switch mints it. */
function squareWithChuck(side: number, length: number, axis: 'x' | 'y'): { project: Project; chunk: Clamp } {
  const stock = squareStock(side, length, axis, { x: 5, y: 7 })
  const chuck: Clamp = {
    id: 'cl-chuck',
    name: 'Chuck',
    visible: true,
    ...defaultRoundWorkholding('chuck', stock, 'mm'),
  }
  return { project: { ...newProject('square', 'mm'), stock, origin: defaultOrigin(stock), clamps: [chuck] }, chunk: chuck }
}

// ── Defaults ──────────────────────────────────────────────────

console.log('\nDefault workholding on a square blank')

test('a 20 mm square on X gets a 56.5685 across chuck, gripped 15 inside, centred and raised to the true pivot', () => {
  const stock = squareStock(20, 100, 'x', { x: 5, y: 7 })
  const own = 4 * barMaxRadius(stock)
  closeTo(own, 56.568542494923804, 'the default diameter is twice the corner envelope diameter')

  const chuck = defaultRoundWorkholding('chuck', stock, 'mm')
  assert.equal(chuck.type, 'chuck', 'it is a chuck')
  closeTo(chuck.h, own, 'the across-size is the corner-clearing diameter')
  assert.equal(chuck.x, 5 - 40, 'the body reaches 40 past the blank end')
  assert.equal(chuck.x + chuck.w, 5 + 15, 'the grip reaches 15 into the blank')
  closeTo(chuck.y + chuck.h / 2, barCentre(stock), 'centred on the centreline')
  closeTo(chuck.height, barPivotZ(stock) + own / 2, 'the height is the true pivot plus its own radius')
  assert.equal(chuck.height, 10 + own / 2, 'the pivot is side/2 = 10')
})

test('the default clears the corner envelope and is never raised to the corner radius', () => {
  for (const side of [10, 20, 40, 0.75]) {
    const stock = squareStock(side, side * 5, 'x')
    const chuck = defaultRoundWorkholding('chuck', stock, 'mm')
    assert.ok(chuck.h / 2 >= barMaxRadius(stock),
      `side ${side}: the clamp reaches past the corner radius (${chuck.h / 2} >= ${barMaxRadius(stock)})`)
    closeTo(chuck.height, barPivotZ(stock) + chuck.h / 2, `side ${side}: the top is the pivot plus the radius`)
    assert.ok(chuck.height < barMaxRadius(stock) + chuck.h / 2,
      `side ${side}: the centre is the pivot, not the corner radius`)
  }
})

test('a small square takes the 50 mm floor', () => {
  const stock = squareStock(10, 100, 'x', { x: 0, y: 0 })
  const chuck = defaultRoundWorkholding('chuck', stock, 'mm')
  assert.equal(chuck.h, 50, 'twice the corner envelope is under the floor, so 50 wins')
  assert.equal(chuck.height, 5 + 25, 'the height follows the floor and the pivot')
})

test('the defaults are converted for an inch blank', () => {
  const stock = squareStock(0.75, 4, 'x', { x: 0.5, y: 1 })
  const own = 4 * barMaxRadius(stock)
  const body = convertLength(40, 'mm', 'inch')
  const grip = Math.min(convertLength(15, 'mm', 'inch'), 1)
  const chuck = defaultRoundWorkholding('chuck', stock, 'inch')
  closeTo(chuck.h, own, 'the corner-clearing diameter in inches')
  closeTo(chuck.w, body + grip, 'body plus grip in inches')
  assert.equal(chuck.x, 0.5 - body, 'the body past the end in inches')
  closeTo(chuck.x + chuck.w, 0.5 + grip, 'the grip inside the blank')
  closeTo(chuck.height, 0.375 + own / 2, 'the height in inches')

  const tailstock = defaultRoundWorkholding('tailstock', stock, 'inch')
  assert.equal(tailstock.x, 4.5, 'it touches the far end face')
  closeTo(tailstock.w, body, 'body beyond it')
  closeTo(tailstock.h, own, 'the corner-clearing diameter')
})

test('a square on Y starts at maxY and sits across X', () => {
  const stock = squareStock(20, 100, 'y', { x: 5, y: 7 })
  const own = 4 * barMaxRadius(stock)
  assert.equal(barCentre(stock), 15, 'the centreline is an X value of 15')
  const chuck = defaultRoundWorkholding('chuck', stock, 'mm')
  assert.equal(chuck.y, 107 - 15, 'the grip starts at the start end (maxY)')
  assert.equal(chuck.y + chuck.h, 107 + 40, 'the body reaches past it')
  closeTo(chuck.x, 15 - own / 2, 'centred across X')
  closeTo(chuck.w, own, 'the across-size on a Y blank is the width')

  const tailstock = defaultRoundWorkholding('tailstock', stock, 'mm')
  assert.equal(tailstock.y, 7 - 40, 'the tailstock sits past the far end (minY)')
  assert.equal(tailstock.y + tailstock.h, 7, 'touching it')
  closeTo(tailstock.x + tailstock.w / 2, 15, 'centred across X')
})

test('the square default is larger than the round default on the same nominal bar', () => {
  const square = squareStock(20, 100, 'x', { x: 0, y: 0 })
  const bar = roundStock(20, 100, 'x', { x: 0, y: 0 })
  const squareChuck = defaultRoundWorkholding('chuck', square, 'mm')
  const roundChuck = defaultRoundWorkholding('chuck', bar, 'mm')
  assert.equal(roundChuck.h, 50, 'the round default is unchanged (twice the diameter)')
  assert.ok(squareChuck.h > roundChuck.h, 'the square default clears corners the round one need not')
})

// ── syncRoundWorkholding ──────────────────────────────────────

console.log('\nKeeping square workholding in place')

test('a square chuck dragged off the centreline is recentred at the pivot and keeps its across-size', () => {
  const { project, chunk } = squareWithChuck(20, 100, 'x')
  const dragged = { ...chunk, y: 3, height: 12 }
  const next = syncRoundWorkholding({ ...project, clamps: [dragged] })
  const stock = project.stock
  assert.ok(isSquareStock(stock), 'the stock is a square blank')
  assert.equal(next.clamps[0].h, dragged.h, 'the across-size is kept')
  closeTo(next.clamps[0].y, barCentre(stock) - dragged.h / 2, 'it is centred again')
  closeTo(next.clamps[0].height, barPivotZ(stock) + dragged.h / 2, 'the height is the true pivot plus its radius')
  assert.equal(next.clamps[0].x, dragged.x, 'the along-axis position is untouched')
  assert.equal(next.clamps[0].w, dragged.w, 'the along-axis size is untouched')
})

test('the sync never enlarges a diameter the user set by hand', () => {
  const { project, chunk } = squareWithChuck(20, 100, 'x')
  const manual = { ...chunk, h: 30 }
  const next = syncRoundWorkholding({ ...project, clamps: [manual] })
  assert.equal(next.clamps[0].h, 30, 'the manual diameter survives')
  closeTo(next.clamps[0].height, 10 + 15, 'the height follows the manual diameter, not the default')
  assert.ok(isSquareStock(project.stock), 'the stock is a square blank')
  assert.ok(next.clamps[0].h < 4 * barMaxRadius(project.stock), 'the default would have been larger')
})

test('nothing to change returns the same project object', () => {
  const { project } = squareWithChuck(20, 100, 'x')
  assert.equal(syncRoundWorkholding(project), project, 'an already-synced square blank')

  const noChuck = { ...project, clamps: [] }
  assert.equal(syncRoundWorkholding(noChuck), noChuck, 'a blank with no workholding')

  const block = { ...project, stock: newProject('block', 'mm').stock }
  assert.equal(syncRoundWorkholding(block), block, 'a block project')
})

test('roundWorkholdingDiameter is the across-axis size on a square blank too', () => {
  const xSquare = squareStock(20, 100, 'x', { x: 0, y: 0 })
  const ySquare = squareStock(20, 100, 'y', { x: 0, y: 0 })
  const clamp: Clamp = { id: 'c', name: 'c', type: 'chuck', x: 0, y: 0, w: 55, h: 50, height: 35, visible: true }
  assert.equal(roundWorkholdingDiameter(clamp, xSquare), 50, 'h across an X blank')
  assert.equal(roundWorkholdingDiameter(clamp, ySquare), 55, 'w across a Y blank')
})

// ── The shape switch and the store ────────────────────────────

console.log('\nThe shape switch and the store')

test('to square mints a chuck with the corner-clearing default on the blank it made', () => {
  const next = projectWithStockShape(newProject('block', 'mm'), 'square')
  assert.ok(isSquareStock(next.stock), 'the stock is a square blank')
  assert.equal(next.clamps.length, 1, 'exactly one chuck')
  const own = 4 * barMaxRadius(next.stock)
  closeTo(next.clamps[0].h, own, 'the default diameter clears the corners')
  closeTo(next.clamps[0].height, barPivotZ(next.stock) + own / 2, 'raised to the true pivot')
})

test('a store resize keeps the manual square chuck diameter and moves it to the new pivot', () => {
  const { project, chunk } = squareWithChuck(20, 100, 'x')
  seed({ ...project, clamps: [{ ...chunk, h: 70 }] })

  useProjectStore.getState().setRectStockDimension('height', 30, 'top')

  const after = useProjectStore.getState().project.clamps[0]
  const stock = useProjectStore.getState().project.stock
  assert.ok(isSquareStock(stock), 'the stock is a square blank')
  assert.equal(after.h, 70, 'the manual diameter is untouched by the sync')
  closeTo(after.y, barCentre(stock) - 35, 'recentred on the new centreline')
  closeTo(after.height, 15 + 35, 'the height follows the new physical pivot')
})

test('a plain write to a square project leaves its synced workholding identical', () => {
  const { project } = squareWithChuck(20, 100, 'x')
  seed(project)
  const before = useProjectStore.getState().project.clamps[0]

  useProjectStore.getState().setGrid({ ...project.grid, snapIncrement: project.grid.snapIncrement * 2 })

  const after = useProjectStore.getState().project.clamps[0]
  assert.equal(after, before, 'the synced clamp object is the same one')
  assert.deepEqual(getStockBounds(useProjectStore.getState().project.stock), getStockBounds(project.stock),
    'the blank box is untouched')
})

console.log(`\nSquare workholding: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
