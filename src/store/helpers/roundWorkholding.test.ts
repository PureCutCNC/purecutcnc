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
 * A chuck and a tailstock on a round bar (#392 slice C): their default place
 * and size, the sync that keeps them centred with a derived height, the shape
 * switch that gains a chuck and loses both, and that the existing engine clamp
 * check needs no round case.
 *
 * Run with: npx tsx src/store/helpers/roundWorkholding.test.ts
 */

import assert from 'node:assert/strict'
import {
  defaultOrigin,
  getStockBounds,
  isRoundStock,
  newProject,
  roundStock,
  roundStockCentre,
  type BarStock,
  type Clamp,
  type MachineOrigin,
  type Project,
  type RoundStock,
  type Stock,
} from '../../types/project'
import { barCentre, barPivotZ, isSquareStock, squareStock } from '../../types/barStock'
import { convertLength } from '../../utils/units'
import { applyClampWarnings, expandedClampBounds } from '../../engine/toolpaths/clamps'
import type { ToolpathMove, ToolpathResult } from '../../engine/toolpaths/types'
import { useProjectStore } from '../projectStore'
import { normalizeProject } from './projectFormat'
import {
  defaultRoundWorkholding,
  isRoundWorkholding,
  roundWorkholdingDiameter,
  syncRoundWorkholding,
  transposeRoundWorkholding,
} from './roundWorkholding'
import { projectWithStockShape, resizeRoundStock, resizeSquareStock } from './stockShape'

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

function seed(project: Project): void {
  useProjectStore.setState({ project, dirty: false, history: { past: [], future: [], transactionStart: null } })
}

function stockOf(): Stock {
  return useProjectStore.getState().project.stock
}

function clampsOf(): Clamp[] {
  return useProjectStore.getState().project.clamps
}

function originOf(): MachineOrigin {
  return useProjectStore.getState().project.origin
}

/** A bar with one chuck and one tailstock at their defaults. */
function barWithWorkholding(): { project: Project; bar: RoundStock; chuck: Clamp } {
  const bar = roundStock(20, 100, 'x', { x: 0, y: 0 })
  const chuck: Clamp = {
    id: 'cl-chuck',
    name: 'Chuck',
    visible: true,
    ...defaultRoundWorkholding('chuck', bar, 'mm'),
  }
  const tailstock: Clamp = {
    id: 'cl-tail',
    name: 'Tailstock',
    visible: true,
    ...defaultRoundWorkholding('tailstock', bar, 'mm'),
  }
  return { project: { ...newProject('bar', 'mm'), stock: bar, clamps: [chuck, tailstock] }, bar, chuck }
}

/** A Y bar with one chuck and one tailstock at their defaults. */
function yBarWithWorkholding(): { project: Project; bar: RoundStock } {
  const bar = roundStock(20, 100, 'y', { x: 0, y: 0 })
  const chuck: Clamp = {
    id: 'cl-chuck',
    name: 'Chuck',
    visible: true,
    ...defaultRoundWorkholding('chuck', bar, 'mm'),
  }
  const tailstock: Clamp = {
    id: 'cl-tail',
    name: 'Tailstock',
    visible: true,
    ...defaultRoundWorkholding('tailstock', bar, 'mm'),
  }
  return { project: { ...newProject('bar-y', 'mm'), stock: bar, clamps: [chuck, tailstock] }, bar }
}

/** Re-aim the seeded bar through the same store path the Axis control uses. */
function reaimStock(axis: 'x' | 'y'): void {
  const state = useProjectStore.getState()
  const stock = state.project.stock
  if (isRoundStock(stock)) {
    state.setStockAndOrigin(resizeRoundStock(stock, { axis }), state.project.origin)
  } else if (isSquareStock(stock)) {
    state.setStockAndOrigin(resizeSquareStock(stock, { axis }), state.project.origin)
  } else {
    throw new Error('reaimStock: the seed is not a bar')
  }
}

/**
 * A clamp's interval from the bar's start end, in the direction the bar runs:
 * increasing X from minX, decreasing Y from maxY (the ends
 * `defaultRoundWorkholding` treats as the start).
 */
function alongOf(clamp: Clamp, stock: BarStock): { low: number; size: number; diameter: number } {
  const bounds = getStockBounds(stock)
  return stock.axis === 'x'
    ? { low: clamp.x - bounds.minX, size: clamp.w, diameter: clamp.h }
    : { low: bounds.maxY - (clamp.y + clamp.h), size: clamp.h, diameter: clamp.w }
}

// ── Defaults ──────────────────────────────────────────────────

console.log('\nDefault chuck and tailstock')

test('a 20 × 100 mm bar on X gets the smallest standard chuck with a 15 mm grip', () => {
  const bar = roundStock(20, 100, 'x', { x: 0, y: 0 })
  const chuck = defaultRoundWorkholding('chuck', bar, 'mm')
  assert.equal(chuck.type, 'chuck', 'it is a chuck')
  assert.equal(chuck.h, convertLength(3.15, 'inch', 'mm'), 'Bison 3 inch body A')
  assert.equal(chuck.x, -convertLength(1.73, 'inch', 'mm'), 'the documented body reaches past the bar end')
  assert.equal(chuck.x + chuck.w, 15, 'the grip reaches 15 into the bar')
  assert.equal(chuck.y + chuck.h / 2, roundStockCentre(bar), 'centred on the centreline')
  assert.equal(chuck.height, 10 + convertLength(3.15, 'inch', 'mm') / 2, 'bar radius plus its own')

  const tailstock = defaultRoundWorkholding('tailstock', bar, 'mm')
  assert.equal(tailstock.type, 'tailstock', 'it is a tailstock')
  assert.equal(tailstock.x, 100, 'It touches the far end face')
  assert.equal(tailstock.w, 40, 'it extends the body beyond it')
  assert.equal(tailstock.h, 50, '50 across')
  assert.equal(tailstock.y + tailstock.h / 2, roundStockCentre(bar), 'centred on the centreline')
  assert.equal(tailstock.height, 10 + 25, 'the same height rule')
})

test('a 40 mm bar needs the 5 inch standard chuck', () => {
  const bar = roundStock(40, 100, 'x', { x: 0, y: 0 })
  assert.equal(defaultRoundWorkholding('chuck', bar, 'mm').h, convertLength(4.92, 'inch', 'mm'), '5 inch body A')
  assert.equal(defaultRoundWorkholding('chuck', bar, 'mm').height, 20 + convertLength(4.92, 'inch', 'mm') / 2, 'the height follows it')
})

test('a 30 mm long bar grips 7.5', () => {
  const bar = roundStock(20, 30, 'x', { x: 0, y: 0 })
  const chuck = defaultRoundWorkholding('chuck', bar, 'mm')
  assert.equal(chuck.x, -convertLength(1.73, 'inch', 'mm'), 'the body is unchanged')
  assert.equal(chuck.x + chuck.w, 7.5, 'a quarter of the length, not 15')
  assert.equal(chuck.w, convertLength(1.73, 'inch', 'mm') + 7.5, 'body plus grip')
})

test('the defaults are converted for an inch project', () => {
  const body = 1.73
  const grip = Math.min(convertLength(15, 'mm', 'inch'), 4 / 4)
  const own = 3.15
  const bar = roundStock(0.75, 4, 'x', { x: 0, y: 0 })
  const chuck = defaultRoundWorkholding('chuck', bar, 'inch')
  assert.equal(chuck.w, body + grip, 'body plus grip in inches')
  assert.equal(chuck.h, own, 'the diameter floor in inches')
  assert.equal(chuck.x, -body, 'the body past the end in inches')
  assert.ok(Math.abs(chuck.x + chuck.w - grip) < 1e-12, 'the grip inside the bar')
  assert.equal(chuck.height, 0.75 / 2 + own / 2, 'the height in inches')

  const tailstock = defaultRoundWorkholding('tailstock', bar, 'inch')
  assert.equal(tailstock.x, 4, 'touches the far end face')
  assert.equal(tailstock.w, convertLength(40, 'mm', 'inch'), 'body beyond it')
  assert.equal(tailstock.h, convertLength(50, 'mm', 'inch'), 'the diameter floor')
})

test('an axis Y bar starts at maxY and sits across X', () => {
  const bar = roundStock(20, 100, 'y', { x: 0, y: 0 })
  assert.equal(roundStockCentre(bar), 10, 'the centreline is a Y bar X of 10')
  const chuck = defaultRoundWorkholding('chuck', bar, 'mm')
  assert.equal(chuck.y, 100 - 15, 'the grip starts at the start end (maxY)')
  assert.equal(chuck.y + chuck.h, 100 + convertLength(1.73, 'inch', 'mm'), 'the body reaches past it')
  assert.equal(chuck.x, 10 - convertLength(3.15, 'inch', 'mm') / 2, 'centred across X')
  assert.equal(chuck.w, convertLength(3.15, 'inch', 'mm'), '3 inch body A')

  const tailstock = defaultRoundWorkholding('tailstock', bar, 'mm')
  assert.equal(tailstock.y, 0 - 40, 'the tailstock sits past the far end (minY)')
  assert.equal(tailstock.y + tailstock.h, 0, 'touching it')
  assert.equal(tailstock.x + tailstock.w / 2, 10, 'centred across X')
})

// ── syncRoundWorkholding ──────────────────────────────────────

console.log('\nKeeping round workholding in place')

test('a chuck dragged off the centreline is recentred and keeps its across-size', () => {
  const { project, bar } = barWithWorkholding()
  const dragged = { ...project.clamps[0], y: 3, height: 12 }
  const next = syncRoundWorkholding({ ...project, clamps: [dragged, project.clamps[1]] })
  assert.equal(next.clamps[0].h, dragged.h, 'the across-size is kept')
  assert.equal(next.clamps[0].y, roundStockCentre(bar) - dragged.h / 2, 'it is centred again')
  assert.equal(next.clamps[0].height, bar.thickness / 2 + dragged.h / 2, 'the height is derived')
  assert.equal(next.clamps[0].x, dragged.x, 'the along-axis position is untouched')
  assert.equal(next.clamps[0].w, dragged.w, 'the along-axis size is untouched')
})

test('the height follows a diameter change', () => {
  const { project } = barWithWorkholding()
  const wider = { ...project.stock, thickness: 30, profile: { ...project.stock.profile } } as RoundStock
  const next = syncRoundWorkholding({ ...project, stock: wider })
  assert.equal(next.clamps[0].height, 15 + convertLength(3.15, 'inch', 'mm') / 2, 'bar radius plus the clamp radius')
})

test('a step clamp is left alone', () => {
  const { project } = barWithWorkholding()
  const step: Clamp = { id: 'cl-step', name: 'Step', type: 'step_clamp', x: 1, y: 2, w: 10, h: 10, height: 3, visible: true }
  const next = syncRoundWorkholding({ ...project, clamps: [...project.clamps, step] })
  assert.equal(next.clamps[2], step, 'the same object comes back')
  assert.deepEqual(next.clamps[2], step, 'and it is unchanged')
})

test('nothing to change returns the same project object', () => {
  const { project } = barWithWorkholding()
  assert.equal(syncRoundWorkholding(project), project, 'an already-synced bar')

  const noChuck = { ...project, clamps: project.clamps.filter((clamp) => clamp.type !== 'chuck') }
  assert.equal(syncRoundWorkholding(noChuck), noChuck, 'a bar with no chuck')

  const blockStock = { ...project.stock, shape: undefined, axis: undefined } as unknown as Stock
  const block = { ...project, stock: blockStock, clamps: project.clamps }
  assert.equal(syncRoundWorkholding(block), block, 'a block project')
})

test('an unchanged clamp keeps its identity when a sibling changes', () => {
  const { project } = barWithWorkholding()
  const movedChuck = { ...project.clamps[0], y: 3 }
  const next = syncRoundWorkholding({ ...project, clamps: [movedChuck, project.clamps[1]] })
  assert.notEqual(next, project, 'the project is new')
  assert.notEqual(next.clamps[0], movedChuck, 'the moved clamp is new')
  assert.equal(next.clamps[1], project.clamps[1], 'the synced sibling is the same object')
})

test('roundWorkholdingDiameter is the across-axis size', () => {
  const xBar = roundStock(20, 100, 'x', { x: 0, y: 0 })
  const yBar = roundStock(20, 100, 'y', { x: 0, y: 0 })
  const clamp: Clamp = { id: 'c', name: 'c', type: 'chuck', x: 0, y: 0, w: 55, h: 50, height: 35, visible: true }
  assert.equal(roundWorkholdingDiameter(clamp, xBar), 50, 'h across an X bar')
  assert.equal(roundWorkholdingDiameter(clamp, yBar), 55, 'w across a Y bar')
  assert.equal(isRoundWorkholding(clamp), true, 'a chuck is round workholding')
  assert.equal(isRoundWorkholding({ ...clamp, type: 'toe_clamp' }), false, 'a toe clamp is not')
})

// ── Re-aiming the bar ─────────────────────────────────────────

console.log('\nRe-aiming the bar turns its workholding')

test('X → Y → X returns the exact original chuck and tailstock', () => {
  const { project, bar } = barWithWorkholding()
  const chuck = { ...project.clamps[0], x: 7.25, w: 61.5 }
  const tailstock = { ...project.clamps[1], x: 104.75, w: 43.25 }
  seed({ ...project, clamps: [chuck, tailstock] })
  const original = clampsOf()

  reaimStock('y')
  reaimStock('x')

  assert.deepEqual(clampsOf(), original, 'the non-default along positions came back exactly')
  assert.equal((stockOf() as RoundStock).axis, 'x', 'the bar is back on X')
  assert.notEqual(alongOf(original[0], bar).low, alongOf(project.clamps[0], bar).low,
    'the chuck really was at a non-default along position')
})

test('Y → X → Y returns the exact original chuck and tailstock', () => {
  const { project } = yBarWithWorkholding()
  const chuck = { ...project.clamps[0], y: 77.5, h: 61.5 }
  const tailstock = { ...project.clamps[1], y: -47.25, h: 43.25 }
  seed({ ...project, clamps: [chuck, tailstock] })
  const original = clampsOf()

  reaimStock('x')
  reaimStock('y')

  assert.deepEqual(clampsOf(), original, 'the non-default along positions came back exactly')
  assert.equal((stockOf() as RoundStock).axis, 'y', 'the bar is back on Y')
})

test('after X → Y the chuck lies along Y, gripping the same distance from the start end', () => {
  const { project, bar } = barWithWorkholding()
  const chuck = { ...project.clamps[0], x: 7.25, w: 61.5 }
  seed({ ...project, clamps: [chuck, project.clamps[1]] })

  reaimStock('y')

  const yBar = stockOf() as BarStock
  const after = clampsOf()[0]
  assert.deepEqual(alongOf(after, yBar), alongOf(chuck, bar),
    'the same along interval from the start end, with its own diameter')
  assert.equal(after.x + after.w / 2, barCentre(yBar), 'centred across the Y bar')
  assert.equal(after.w, chuck.h, 'the across dimension became the width')
  assert.equal(after.h, chuck.w, 'the along dimension became the height')
  assert.equal(after.height, barPivotZ(yBar) + chuck.h / 2, 'the height follows the new pivot')
})

test('a block clamp does not turn with the bar', () => {
  const { project } = barWithWorkholding()
  const step: Clamp = {
    id: 'cl-step', name: 'Step', type: 'step_clamp', x: 12.5, y: 3.25, w: 9.75, h: 8.5, height: 4.25, visible: true,
  }
  seed({ ...project, clamps: [...project.clamps, step] })
  const before = clampsOf()[2]

  reaimStock('y')

  const after = clampsOf()[2]
  assert.equal(after, before, 'the same object came back')
  assert.deepEqual(after, before, 'an ordinary clamp is untouched')
})

test('a same-axis resize keeps the clamps byte-for-byte', () => {
  const { project, bar } = barWithWorkholding()
  seed(project)
  const before = clampsOf()

  const longer = resizeRoundStock(bar, { length: 140 })
  useProjectStore.getState().setStockAndOrigin(longer, project.origin)

  assert.deepEqual(clampsOf(), before, 'a length change is not a re-aim')

  const wider = resizeRoundStock(longer, { diameter: 30 })
  useProjectStore.getState().setStockAndOrigin(wider, project.origin)
  const afterDiameter = clampsOf()
  assert.equal(afterDiameter[0].x, before[0].x, 'the along position is untouched')
  assert.equal(afterDiameter[0].w, before[0].w, 'the along size is untouched')
  assert.equal(afterDiameter[0].h, before[0].h, 'the diameter is untouched')
  assert.equal(afterDiameter[0].y, roundStockCentre(wider) - before[0].h / 2, 'it is only recentred')
  assert.equal(afterDiameter[0].height, 15 + convertLength(3.15, 'inch', 'mm') / 2, 'the height follows the new bar diameter')

  const sameAxis = { ...project, stock: longer }
  assert.equal(transposeRoundWorkholding(bar, sameAxis), sameAxis,
    'the transpose leaves a same-axis project alone')
  assert.equal(transposeRoundWorkholding(bar, project), project, 'and an unchanged project too')
})

test('a square blank X → Y → X returns the exact original chuck', () => {
  const blank = squareStock(20, 100, 'x', { x: 5, y: 7 })
  const chuck: Clamp = {
    id: 'cl-chuck',
    name: 'Chuck',
    visible: true,
    ...defaultRoundWorkholding('chuck', blank, 'mm'),
  }
  const moved = { ...chuck, x: 8.5, w: 61.5 }
  seed({ ...newProject('square', 'mm'), stock: blank, clamps: [moved] })
  const original = clampsOf()

  reaimStock('y')
  reaimStock('x')

  assert.deepEqual(clampsOf(), original, 'the square blank keeps the same chuck')
  assert.equal((stockOf() as { axis?: string }).axis, 'x', 'the blank is back on X')
})

test('an axis change undoes and redoes without transposing the restored clamps twice', () => {
  const { project } = barWithWorkholding()
  const chuck = { ...project.clamps[0], x: 7.25, w: 61.5 }
  const tailstock = { ...project.clamps[1], x: 104.75, w: 43.25 }
  seed({ ...project, clamps: [chuck, tailstock] })
  const original = useProjectStore.getState().project

  reaimStock('y')
  const reaimed = useProjectStore.getState().project
  assert.notDeepEqual(reaimed.clamps, original.clamps, 'the axis change did transpose the clamps')

  useProjectStore.getState().undo()
  assert.deepEqual(useProjectStore.getState().project, original, 'undo restores the whole project')

  useProjectStore.getState().redo()
  assert.deepEqual(useProjectStore.getState().project, reaimed, 'redo restores the re-aimed project')
})

// ── projectWithStockShape ─────────────────────────────────────

console.log('\nSwitching the stock shape')

test('to round adds exactly one chuck and moves the origin to the bar default', () => {
  const block = { ...newProject('block', 'mm'), origin: { ...newProject('block', 'mm').origin, name: 'My origin', visible: false } }
  const next = projectWithStockShape(block, 'round')
  assert.notEqual(next, block, 'a new project comes back')
  assert.equal(isRoundStock(next.stock), true, 'the stock is a bar')
  assert.equal(next.clamps.length, 1, 'exactly one clamp was added')
  assert.equal(next.clamps[0].name, 'Chuck', 'named Chuck')
  assert.equal(next.clamps[0].type, 'chuck', 'of type chuck')
  assert.equal(next.clamps[0].visible, true, 'and visible')
  assert.deepEqual(next.origin, { ...defaultOrigin(next.stock), name: 'My origin', visible: false },
    'the origin moves to the bar default, keeping name and visibility')
})

test('to round does not add a second chuck when one already exists', () => {
  const { project } = barWithWorkholding()
  const block = { ...project, stock: { profile: project.stock.profile, thickness: 20, material: project.stock.material, color: project.stock.color, visible: true, origin: project.stock.origin } as Stock }
  const next = projectWithStockShape(block, 'round')
  assert.equal(next.clamps.filter((clamp) => clamp.type === 'chuck').length, 1, 'still one chuck')
  assert.equal(next.clamps.length, 2, 'nothing else was touched')
})

test('to block removes every chuck and tailstock and keeps other clamps', () => {
  const { project } = barWithWorkholding()
  const step: Clamp = { id: 'cl-step', name: 'Step', type: 'step_clamp', x: 1, y: 2, w: 10, h: 10, height: 3, visible: true }
  const next = projectWithStockShape({ ...project, clamps: [...project.clamps, step] }, 'block')
  assert.equal(isRoundStock(next.stock), false, 'the stock is a block')
  assert.equal('shape' in next.stock, false, 'no shape key')
  assert.deepEqual(next.clamps, [step], 'only the ordinary clamp is left')
  assert.notEqual(next.origin, project.origin, 'the origin followed')
})

test('the same shape returns the same project object', () => {
  const block = newProject('block', 'mm')
  assert.equal(projectWithStockShape(block, 'block'), block, 'a block stays a block')
  const { project } = barWithWorkholding()
  assert.equal(projectWithStockShape(project, 'round'), project, 'a bar stays a bar')
})

// ── The existing engine clamp check covers a chuck ────────────

console.log('\nThe existing clamp check')

test('a cut through the chuck below its top is warned; above it or beside it is not', () => {
  const { project } = barWithWorkholding()
  const [bounds] = expandedClampBounds(project, 0)
  assert.equal(bounds.clamp.type, 'chuck', 'the expanded bounds include the chuck')
  assert.equal(bounds.requiredZ, bounds.clamp.height + project.meta.clampClearanceZ, 'required Z is the top plus clearance')

  const result = (move: ToolpathMove): ToolpathResult => ({ operationId: 'op-1', moves: [move], warnings: [], bounds: null })
  const cutAt = (x: number, z: number): ToolpathMove => ({
    kind: 'cut',
    from: { x, y: roundStockCentre(project.stock as RoundStock), z },
    to: { x: x + 20, y: roundStockCentre(project.stock as RoundStock), z },
  })

  // Inside the chuck, below its top: the cut is reported.
  const through = applyClampWarnings(project, result(cutAt(-30, 0)))
  assert(through.warnings.some((warning) => warning.params?.name === 'Chuck'),
    `the cut through the chuck is warned (${JSON.stringify(through.warnings)})`)

  // The same cut lifted clear above height + clearance is not.
  const clear = applyClampWarnings(project, result(cutAt(-30, bounds.requiredZ)))
  assert.equal(clear.warnings.length, 0, 'a cut above the clearance is clear')

  // Beside the chuck but over the bar is not.
  const beside = applyClampWarnings(project, result(cutAt(50, 0)))
  assert.equal(beside.warnings.length, 0, 'a cut beside the chuck is clear')
})

// ── Store level ───────────────────────────────────────────────

console.log('\nThe store paths')

test('Block → Round bar → undo restores stock, origin and clamps in one step', () => {
  seed(newProject('switch', 'mm'))
  const store = useProjectStore.getState()
  const beforeOrigin = originOf()

  store.setStockShape('round')

  assert.equal(isRoundStock(stockOf()), true, 'the stock is a bar')
  assert.equal(clampsOf().length, 1, 'a chuck was added')
  assert.equal(clampsOf()[0].name, 'Chuck', 'named Chuck')
  assert.deepEqual(originOf(), { ...defaultOrigin(stockOf()), name: beforeOrigin.name, visible: beforeOrigin.visible },
    'the origin moved to the bar default')
  assert.equal(useProjectStore.getState().history.past.length, 1, 'exactly one history entry')

  store.undo()

  assert.equal(isRoundStock(stockOf()), false, 'undo restores the block')
  assert.equal(clampsOf().length, 0, 'undo removes the chuck')
  assert.deepEqual(originOf(), beforeOrigin, 'undo restores the origin')
})

test('resizing the bar diameter through the store recentres the chuck with the new height', () => {
  const bar = roundStock(20, 100, 'x', { x: 5, y: 7 })
  const chuck: Clamp = { id: 'cl-chuck', name: 'Chuck', visible: true, ...defaultRoundWorkholding('chuck', bar, 'mm') }
  seed({ ...newProject('resize', 'mm'), stock: bar, clamps: [chuck] })

  useProjectStore.getState().setRectStockDimension('height', 30, 'top')

  const resized = stockOf() as RoundStock
  const after = clampsOf()[0]
  assert.equal(resized.thickness, 30, 'the diameter followed')
  assert.equal(after.h, chuck.h, 'the across-size is kept')
  assert.equal(after.y, roundStockCentre(resized) - after.h / 2, 'centred on the new centreline')
  assert.equal(after.height, 15 + convertLength(3.15, 'inch', 'mm') / 2, 'the height derives from the new diameter')
})

test('moveClampControl on a chuck leaves it centred with a derived height', () => {
  const bar = roundStock(20, 100, 'x', { x: 5, y: 7 })
  const chuck: Clamp = { id: 'cl-chuck', name: 'Chuck', visible: true, ...defaultRoundWorkholding('chuck', bar, 'mm') }
  seed({ ...newProject('drag', 'mm'), stock: bar, clamps: [chuck] })

  useProjectStore.getState().moveClampControl('cl-chuck', { kind: 'anchor', index: 0 }, { x: -50, y: -20 })

  const after = clampsOf()[0]
  assert.equal(after.h, 77.005, 'the dragged across-size is kept')
  assert.equal(after.y + after.h / 2, roundStockCentre(bar), 'centred after the drag')
  assert.equal(after.height, 10 + 77.005 / 2, 'the height derives from the dragged size')
  assert.equal(after.w, 70, 'the along-axis size is the drag result')
})

test('loading a saved bar project whose chuck is off-centre repairs it', () => {
  const { project, bar } = barWithWorkholding()
  const offCentre = { ...project.clamps[0], y: 4, height: 7 }
  const normalized = normalizeProject({ ...project, clamps: [offCentre, project.clamps[1]] })
  assert.equal(normalized.clamps[0].y, roundStockCentre(bar) - offCentre.h / 2, 'the loaded chuck is recentred')
  assert.equal(normalized.clamps[0].height, bar.thickness / 2 + offCentre.h / 2, 'and its height is derived')
})

test('a block project with ordinary clamps is unchanged by normalization', () => {
  const step: Clamp = { id: 'cl-step', name: 'Step', type: 'step_clamp', x: 12, y: 34, w: 10, h: 10, height: 6, visible: true }
  const project = { ...newProject('block', 'mm'), clamps: [step] }
  const normalized = normalizeProject(project)
  assert.equal(isRoundStock(normalized.stock), false, 'the stock is still a block')
  assert.deepEqual(normalized.clamps, [step], 'the ordinary clamp is untouched')
  assert.deepEqual(getStockBounds(normalized.stock), getStockBounds(project.stock), 'the stock box is untouched')
})

console.log(`\nRound workholding: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
