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
 * The round ↔ square switch keeps the selected chuck even below the new
 * envelope (#1112 M). The existing physical safety guard still refuses that
 * setup; a stock change never chooses different equipment for the operator.
 */

import assert from 'node:assert/strict'
import {
  defaultOrigin,
  getStockBounds,
  isRoundStock,
  newProject,
  roundStock,
  type BarStock,
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
import { convertLength, exportGeometryTolerance } from '../../utils/units'
import { useProjectStore } from '../projectStore'
import { projectWithStockShape } from './stockShape'
import {
  defaultRoundWorkholding,
  roundWorkholdingDiameter,
  syncRoundWorkholding,
} from './roundWorkholding'
import { requiredWorkholdingDiameter } from '../../engine/squareRotarySafety'

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

/**
 * A chuck of a chosen outer diameter on a bar, centred on the bar's true
 * centreline with the pivot-derived height the sync and the safety guard
 * expect. Used to exercise the round ↔ square threshold directly.
 */
function chuckOnBar(stock: BarStock, diameter: number, id = 'cl-chuck'): Clamp {
  const across = barCentre(stock) - diameter / 2
  const height = barPivotZ(stock) + diameter / 2
  return stock.axis === 'x'
    ? { id, name: 'Chuck', type: 'chuck', x: -5, y: across, w: 10, h: diameter, height, visible: true }
    : { id, name: 'Chuck', type: 'chuck', x: across, y: -5, w: diameter, h: 10, height, visible: true }
}

/** A one-chuck project on `stock`, in its project units. */
function projectOnStock(
  name: string,
  stock: BarStock,
  clamps: Clamp[],
  units: Project['meta']['units'] = 'mm',
): Project {
  return { ...newProject(name, units), stock, origin: defaultOrigin(stock), clamps }
}

// ── Defaults ──────────────────────────────────────────────────

console.log('\nDefault workholding on a square blank')

test('a 20 mm square on X gets the smallest fitting standard chuck, gripped 15 inside, centred on the true pivot', () => {
  const stock = squareStock(20, 100, 'x', { x: 5, y: 7 })
  const own = convertLength(3.94, 'inch', 'mm')

  const chuck = defaultRoundWorkholding('chuck', stock, 'mm')
  assert.equal(chuck.type, 'chuck', 'it is a chuck')
  closeTo(chuck.h, own, 'the across-size is the corner-clearing diameter')
  assert.equal(chuck.x, 5 - convertLength(1.97, 'inch', 'mm'), 'the documented body reaches past the blank end')
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

test('a small square takes the 4 inch starter too, held across flats', () => {
  const stock = squareStock(10, 100, 'x', { x: 0, y: 0 })
  const chuck = defaultRoundWorkholding('chuck', stock, 'mm')
  // #1112 R2 item 23: 10 mm across flats is inside the 4 inch range (0.12–1.3
  // in), so the square keeps the starter rather than a smaller body.
  assert.equal(chuck.h, convertLength(3.94, 'inch', 'mm'), 'the 4 inch preset holds this blank')
  assert.equal(chuck.height, 5 + convertLength(3.94, 'inch', 'mm') / 2, 'the height follows the body and the pivot')
})

test('the defaults are converted for an inch blank', () => {
  const stock = squareStock(0.75, 4, 'x', { x: 0.5, y: 1 })
  const own = 3.94
  const body = 1.97
  const grip = Math.min(convertLength(15, 'mm', 'inch'), 1)
  const chuck = defaultRoundWorkholding('chuck', stock, 'inch')
  closeTo(chuck.h, own, 'the corner-clearing diameter in inches')
  closeTo(chuck.w, body + grip, 'body plus grip in inches')
  assert.equal(chuck.x, 0.5 - body, 'the body past the end in inches')
  closeTo(chuck.x + chuck.w, 0.5 + grip, 'the grip inside the blank')
  closeTo(chuck.height, 0.375 + own / 2, 'the height in inches')

  const tailstock = defaultRoundWorkholding('tailstock', stock, 'inch')
  assert.equal(tailstock.x, 4.5, 'it touches the far end face')
  closeTo(tailstock.w, convertLength(40, 'mm', 'inch'), 'body beyond it')
  closeTo(tailstock.h, 4 * barMaxRadius(stock), 'the corner-clearing diameter')
})

test('a square on Y starts at maxY and sits across X', () => {
  const stock = squareStock(20, 100, 'y', { x: 5, y: 7 })
  const own = convertLength(3.94, 'inch', 'mm')
  assert.equal(barCentre(stock), 15, 'the centreline is an X value of 15')
  const chuck = defaultRoundWorkholding('chuck', stock, 'mm')
  assert.equal(chuck.y, 107 - 15, 'the grip starts at the start end (maxY)')
  assert.equal(chuck.y + chuck.h, 107 + convertLength(1.97, 'inch', 'mm'), 'the body reaches past it')
  closeTo(chuck.x, 15 - own / 2, 'centred across X')
  closeTo(chuck.w, own, 'the across-size on a Y blank is the width')

  const tailstock = defaultRoundWorkholding('tailstock', stock, 'mm')
  assert.equal(tailstock.y, 7 - 40, 'the tailstock sits past the far end (minY)')
  assert.equal(tailstock.y + tailstock.h, 7, 'touching it')
  closeTo(tailstock.x + tailstock.w / 2, 15, 'centred across X')
})

test('the square default clears the corner envelope the round one need not', () => {
  const square = squareStock(20, 100, 'x', { x: 0, y: 0 })
  const bar = roundStock(20, 100, 'x', { x: 0, y: 0 })
  const squareChuck = defaultRoundWorkholding('chuck', square, 'mm')
  const roundChuck = defaultRoundWorkholding('chuck', bar, 'mm')
  assert.equal(roundChuck.h, convertLength(3.94, 'inch', 'mm'), 'the 4 inch starter on a round bar')
  // Both bars take the starter here, so the square's claim is not that it is
  // bigger — it is that its body clears the corners the round one need not.
  assert.ok(squareChuck.h / 2 >= barMaxRadius(square), 'the square body clears the corner radius')
  assert.ok(roundChuck.h / 2 >= barMaxRadius(bar), 'and the round one covers its diameter')
  assert.equal(squareChuck.chuck?.jawCount, 4, 'the square default is the 4-jaw set')
  assert.equal(roundChuck.chuck?.jawCount, 3, 'the round default is the 3-jaw set')
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
  const own = defaultRoundWorkholding('chuck', next.stock, 'mm').h
  closeTo(next.clamps[0].h, own, 'the default diameter clears the corners')
  closeTo(next.clamps[0].height, barPivotZ(next.stock) + own / 2, 'raised to the true pivot')
})

// ── Round ↔ square: keep selected chuck equipment (#1112 M) ─

console.log('\nKeeping chosen chucks on a round ↔ square switch')

test('round → square keeps even a 50 mm chuck below the 2 in corner envelope', () => {
  const round = roundStock(2, 6, 'x', { x: 0, y: 0 })
  const fifty = convertLength(50, 'mm', 'inch')
  const chuck: Clamp = {
    id: 'cl0017', name: 'Chuck', type: 'chuck',
    x: -1.5748, y: barCentre(round) - fifty / 2, w: 2.1654, h: fifty,
    height: barPivotZ(round) + fifty / 2, visible: false,
  }
  const step: Clamp = { id: 'cl-step', name: 'Step', type: 'step_clamp', x: 1, y: 2, w: 3, h: 4, height: 5, visible: true }
  const project: Project = { ...newProject('switch', 'inch'), stock: round, origin: defaultOrigin(round), clamps: [chuck, step] }

  const next = projectWithStockShape(project, 'square')
  assert.ok(isSquareStock(next.stock), 'the stock is a square blank')
  const reminted = next.clamps[0]
  assert.equal(reminted, chuck, 'even a too-small chuck keeps its selected equipment')
  assert.equal(reminted.id, 'cl0017', 'its id survives')
  assert.equal(reminted.name, 'Chuck', 'its name survives')
  assert.equal(reminted.visible, false, 'its visibility survives')
  assert.equal(reminted.x, chuck.x, 'its along position survives')
  assert.equal(reminted.w, chuck.w, 'its along size survives')
  assert.equal(reminted.h, chuck.h, 'body diameter is never silently resized')
  closeTo(reminted.y + reminted.h / 2, barCentre(next.stock), 'centred on the true centreline')
  closeTo(reminted.height, barPivotZ(next.stock) + reminted.h / 2, 'its height is pivot-derived')
  assert.equal(next.clamps[1], step, 'an ordinary clamp is untouched')
})

test('round → square leaves a chuck that already clears exactly as it is', () => {
  const round = roundStock(2, 6, 'x', { x: 0, y: 0 })
  const wide: Clamp = {
    id: 'cl-wide', name: 'Wide chuck', type: 'chuck',
    x: -2, y: barCentre(round) - 3, w: 4, h: 6,
    height: barPivotZ(round) + 3, visible: true,
  }
  assert.ok(wide.h > 4 * barMaxRadius(squareStock(2, 6, 'x')), 'the fixture already clears the blank default')
  const project: Project = { ...newProject('switch', 'inch'), stock: round, origin: defaultOrigin(round), clamps: [wide] }

  const next = projectWithStockShape(project, 'square')
  assert.ok(isSquareStock(next.stock), 'the stock is a square blank')
  assert.equal(next.clamps[0], wide, 'the clearing chuck object is returned unchanged')
  assert.equal(next.clamps[0].h, 6, 'and its diameter is not enlarged')
})

test('square → round keeps chucks both below and above the round bar', () => {
  const square = squareStock(20, 100, 'x', { x: 0, y: 0 })
  const small = chuckOnBar(square, 15, 'cl-small')
  const smaller = projectWithStockShape(projectOnStock('switch', square, [small]), 'round')
  assert.ok(isRoundStock(smaller.stock), 'the stock is a round bar')
  assert.equal(smaller.clamps[0], small, 'a 15 mm chuck stays 15 mm on stock change')
  closeTo(roundWorkholdingDiameter(smaller.clamps[0], smaller.stock), 15,
    'the selected diameter stays unchanged')
  closeTo(smaller.clamps[0].y + smaller.clamps[0].h / 2, barCentre(smaller.stock), 'centred on the round centreline')
  assert.equal(smaller.clamps[0].id, 'cl-small', 'its identity survives')

  const large = chuckOnBar(square, 25, 'cl-large')
  const larger = projectWithStockShape(projectOnStock('switch', square, [large]), 'round')
  assert.ok(isRoundStock(larger.stock), 'the stock is a round bar')
  assert.equal(larger.clamps[0], large, 'a 25 mm chuck above the 20 mm bar is kept byte-identical')
  assert.equal(roundWorkholdingDiameter(larger.clamps[0], larger.stock), 25, 'it keeps its own diameter')
})

test("Codex's 30 mm chuck on a 20 mm square stays 30 mm on both axes", () => {
  for (const axis of ['x', 'y'] as const) {
    const round = roundStock(20, 100, axis, { x: 0, y: 0 })
    const chuck = chuckOnBar(round, 30)
    const project = projectOnStock(`switch-${axis}`, round, [chuck])
    const next = projectWithStockShape(project, 'square')
    assert.ok(isSquareStock(next.stock), `the stock is a square blank (${axis})`)
    closeTo(requiredWorkholdingDiameter(next.stock), 20 * Math.SQRT2,
      `the blank's required clearance is the 28.284 mm corner envelope (${axis})`)
    assert.equal(next.clamps[0], chuck, `the 30 mm chuck clears the envelope and is the same object (${axis})`)
    assert.equal(roundWorkholdingDiameter(next.clamps[0], next.stock), 30,
      `its 30 mm diameter is not enlarged (${axis})`)
  }
})

test('round → square keeps a 25 mm chuck below the corner envelope', () => {
  const round = roundStock(20, 100, 'x', { x: 0, y: 0 })
  const chuck = chuckOnBar(round, 25)
  const project = projectOnStock('switch', round, [chuck])

  const next = projectWithStockShape(project, 'square')
  assert.ok(isSquareStock(next.stock), 'the stock is a square blank')
  assert.equal(next.clamps[0], chuck, 'a 25 mm chuck stays selected below the envelope')
  assert.equal(roundWorkholdingDiameter(next.clamps[0], next.stock), 25, 'body diameter is kept')
  assert.equal(next.clamps[0].id, 'cl-chuck', 'its identity survives')
})

test('a chuck exactly at the envelope and exactly at the safety boundary is kept', () => {
  const square = squareStock(20, 100, 'x', { x: 0, y: 0 })
  const envelope = requiredWorkholdingDiameter(square)
  const tolerance = exportGeometryTolerance('mm')
  const cases = [
    ['exactly at the envelope', envelope],
    ['exactly at the safety boundary', envelope - tolerance],
  ] as const
  for (const [label, diameter] of cases) {
    const round = roundStock(20, 100, 'x', { x: 0, y: 0 })
    const chuck = chuckOnBar(round, diameter, 'cl-boundary')
    const next = projectWithStockShape(projectOnStock('switch', round, [chuck]), 'square')
    assert.ok(isSquareStock(next.stock), 'the stock is a square blank')
    assert.equal(next.clamps[0], chuck, `a chuck ${label} (${diameter}) is kept`)
    assert.equal(roundWorkholdingDiameter(next.clamps[0], next.stock), diameter,
      `its diameter is not enlarged (${label})`)
  }
})

test('inch round → square keeps chucks above and below the envelope', () => {
  const side = convertLength(20, 'mm', 'inch')
  const round = roundStock(side, 6, 'x', { x: 0, y: 0 })
  const kept = chuckOnBar(round, convertLength(30, 'mm', 'inch'), 'cl-in-kept')
  const afterKeep = projectWithStockShape(projectOnStock('switch-inch', round, [kept], 'inch'), 'square')
  assert.ok(isSquareStock(afterKeep.stock), 'the stock is a square blank')
  assert.equal(afterKeep.clamps[0], kept, 'the 30 mm-equivalent chuck clears the inch envelope and is kept')
  assert.equal(roundWorkholdingDiameter(afterKeep.clamps[0], afterKeep.stock), convertLength(30, 'mm', 'inch'),
    'its diameter is unchanged')

  const below = chuckOnBar(round, convertLength(25, 'mm', 'inch'), 'cl-in-below')
  const afterRemint = projectWithStockShape(projectOnStock('switch-inch-2', round, [below], 'inch'), 'square')
  assert.ok(isSquareStock(afterRemint.stock), 'the stock is a square blank')
  assert.equal(afterRemint.clamps[0], below, 'inch equipment stays selected below the envelope')
  assert.equal(roundWorkholdingDiameter(afterRemint.clamps[0], afterRemint.stock), convertLength(25, 'mm', 'inch'),
    'the selected diameter stays unchanged in inches')
})

test('a kept clamp is byte-identical through the switch and undo restores the project', () => {
  const round = roundStock(20, 100, 'x', { x: 0, y: 0 })
  const chuck = chuckOnBar(round, 30)
  const project = projectOnStock('switch-undo', round, [chuck])
  seed(project)

  useProjectStore.getState().setStockShape('square')
  assert.equal(useProjectStore.getState().project.clamps[0], chuck, 'the clearing clamp is the same object')
  assert.equal(useProjectStore.getState().project.clamps.length, 1, 'no second chuck is minted')

  useProjectStore.getState().undo()
  assert.deepEqual(useProjectStore.getState().project, project, 'undo restores the round project exactly')
})

test('the shape switch is one undo step and restores the chuck', () => {
  const round = roundStock(2, 6, 'x', { x: 0, y: 0 })
  const fifty = convertLength(50, 'mm', 'inch')
  const chuck: Clamp = {
    id: 'cl0017', name: 'Chuck', type: 'chuck',
    x: -1.5748, y: barCentre(round) - fifty / 2, w: 2.1654, h: fifty,
    height: barPivotZ(round) + fifty / 2, visible: true,
  }
  const project: Project = { ...newProject('switch', 'inch'), stock: round, origin: defaultOrigin(round), clamps: [chuck] }
  seed(project)

  useProjectStore.getState().setStockShape('square')
  assert.equal(useProjectStore.getState().project.clamps[0]?.h, fifty, 'the switch keeps the chosen chuck')

  useProjectStore.getState().undo()
  assert.deepEqual(useProjectStore.getState().project, project, 'undo restores the round project and its chuck exactly')
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
