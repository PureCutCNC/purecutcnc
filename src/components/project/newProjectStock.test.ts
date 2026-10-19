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
 * Issue #1046 slice A: the New project dialog's blank template stock.
 *
 * A rotary blank template builds the bar its own fields describe — shape,
 * diameter or side, length and axis — with no block intermediate, while
 * milling and plasma blank creation stays byte-for-byte what it was. The
 * values pinned here are the dialog's defaults and the numbers a user types.
 *
 * Run with: npx tsx src/components/project/newProjectStock.test.ts
 */

import assert from 'node:assert/strict'
import {
  defaultOrigin,
  defaultStock,
  getStockBounds,
  isRoundStock,
  newProject,
  normalizeRoundStock,
  roundStock,
  type Clamp,
  type Project,
  type ProjectType,
  type Stock,
} from '../../types/project'
import { isSquareStock, normalizeSquareStock } from '../../types/barStock'
import { projectWithProjectType } from '../../store/helpers/projectTypeApply'
import { instantiateProjectTemplate } from '../../store/helpers/normalize'
import { projectWithStockShape } from '../../store/helpers/stockShape'
import {
  blankBarStock,
  blankTemplateProject,
  blankTemplateStock,
  defaultBlankStockDraft,
  type BlankStockDraft,
  type BlankStockShape,
  type BlockStockDraft,
} from './newProjectStock'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`   \u2713 ${name}`)
  } catch (error: unknown) {
    failed += 1
    console.log(`   \u2717 ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const METRIC = newProject('Untitled', 'mm')
const IMPERIAL = newProject('Untitled', 'inch')

/** The block fields at their template defaults (100 × 80 × 20 mm / 4 × 3 × 0.75 in). */
const BLOCK_MM: BlockStockDraft = { width: '100', height: '80', thickness: '20' }
/** The bar fields at the dialog's millimetre defaults: Ø 40 × 200 along X. */
const BAR_MM: BlankStockDraft = { shape: 'round', size: '40', length: '200', axis: 'x' }

/** A project with a volatile timestamp made comparable. */
function withoutTimestamp(project: Project): Project {
  return { ...project, meta: { ...project.meta, modified: 'timestamp' } }
}

/** The length along the bar's axis and the across dimension from its bounds. */
function barBox(stock: Stock): { length: number; across: number } {
  const bounds = getStockBounds(stock)
  const length = 'axis' in stock && stock.axis === 'y'
    ? bounds.maxY - bounds.minY
    : bounds.maxX - bounds.minX
  return { length, across: stock.thickness }
}

function assertOrigin(stock: Stock, project: Project, label: string): void {
  assert.deepEqual(project.origin, defaultOrigin(stock), `${label}: the origin is the stock's own default`)
}

/** A clamp without its generated id, which differs between two separate mints. */
function withoutId(clamp: Clamp): Omit<Clamp, 'id'> {
  const { id: _id, ...rest } = clamp
  return rest
}

/**
 * The chuck the old block→bar path mints for the same bar: a block whose long
 * side is the length and whose thickness is the diameter or side, converted by
 * `projectWithStockShape` — the helper #1046's bar stock replaced.
 */
function convertedChuck(template: Project, shape: BlankStockShape, draft: BlankStockDraft): Clamp {
  const size = Number(draft.size)
  const length = Number(draft.length)
  const block = defaultStock(
    draft.axis === 'x' ? length : size,
    draft.axis === 'x' ? size : length,
    size,
  )
  const converted = projectWithStockShape(
    { ...template, stock: block, origin: defaultOrigin(block), clamps: [] },
    shape,
  )
  assert.equal(converted.clamps.length, 1, 'the block→bar conversion mints exactly one chuck')
  return converted.clamps[0]
}

console.log('\nBlank template stock (issue #1046)')

test('a rotary round blank in millimetres is Ø 40 × 200 along X', () => {
  const project = blankTemplateProject(METRIC, 'rotary', [], BLOCK_MM, BAR_MM)
  assert.ok(project, 'the default draft creates a project')
  assert.equal(project.meta.projectType, 'rotary', 'the stored type is rotary')
  assert.equal(project.meta.units, 'mm', 'the units are the template\'s')

  const stock = project.stock
  assert.equal(isRoundStock(stock), true, 'the stock is a round bar, not a block')
  if (!isRoundStock(stock)) throw new Error('unreachable')
  assert.deepEqual({ length: barBox(stock).length, across: barBox(stock).across }, { length: 200, across: 40 }, 'Ø 40 × 200')
  assert.equal(stock.axis, 'x', 'the length runs along X')
  assert.deepEqual(normalizeRoundStock(stock), stock, 'the bar is canonical')
  assertOrigin(stock, project, 'round mm')
})

test('a rotary round blank in inches is Ø 1.5 × 8', () => {
  const draft = defaultBlankStockDraft('inch')
  assert.deepEqual(draft, { shape: 'round', size: '1.5', length: '8', axis: 'x' }, 'the inch defaults')

  const project = blankTemplateProject(IMPERIAL, 'rotary', [], BLOCK_MM, draft)
  assert.ok(project, 'the inch draft creates a project')
  assert.equal(project.meta.units, 'inch', 'the units are the template\'s')
  const stock = project.stock
  assert.equal(isRoundStock(stock), true, 'a round bar')
  assert.deepEqual({ length: barBox(stock).length, across: barBox(stock).across }, { length: 8, across: 1.5 }, 'Ø 1.5 × 8')
  assertOrigin(stock, project, 'round inch')
})

test('a rotary square blank takes the side and stays square, on both axes and units', () => {
  const cases = [
    { label: 'mm X', template: METRIC, units: 'mm', draft: { shape: 'square', size: '40', length: '200', axis: 'x' }, length: 200 },
    { label: 'mm Y', template: METRIC, units: 'mm', draft: { shape: 'square', size: '25', length: '120', axis: 'y' }, length: 120 },
    { label: 'inch X', template: IMPERIAL, units: 'inch', draft: { shape: 'square', size: '1.5', length: '8', axis: 'x' }, length: 8 },
    { label: 'inch Y', template: IMPERIAL, units: 'inch', draft: { shape: 'square', size: '2', length: '6', axis: 'y' }, length: 6 },
  ] as const
  for (const entry of cases) {
    const project = blankTemplateProject(entry.template, 'rotary', [], BLOCK_MM, entry.draft)
    assert.ok(project, `${entry.label}: the draft creates a project`)
    assert.equal(project.meta.units, entry.units, `${entry.label}: the units follow the template`)
    const stock = project.stock
    assert.equal(isSquareStock(stock), true, `${entry.label}: the stock is a square blank`)
    if (!isSquareStock(stock)) throw new Error('unreachable')
    assert.equal(stock.thickness, Number(entry.draft.size), `${entry.label}: thickness is the physical side`)
    assert.equal(stock.axis, entry.draft.axis, `${entry.label}: the axis is as typed`)
    assert.deepEqual(barBox(stock), { length: entry.length, across: Number(entry.draft.size) }, `${entry.label}: side × length`)
    assert.deepEqual(normalizeSquareStock(stock), stock, `${entry.label}: the blank is canonical`)
    assertOrigin(stock, project, entry.label)
  }
})

test('a rotary round bar takes a typed diameter, length and axis exactly', () => {
  const stock = blankBarStock({ shape: 'round', size: '37.5', length: '123.25', axis: 'y' })
  assert.ok(stock, 'the draft is valid')
  if (!isRoundStock(stock)) throw new Error('the round draft makes a round bar')
  assert.equal(stock.thickness, 37.5, 'the typed diameter')
  assert.equal(stock.axis, 'y', 'the typed axis')
  assert.deepEqual(barBox(stock), { length: 123.25, across: 37.5 }, 'length along Y, diameter across')
})

test('milling and plasma blank creation is unchanged', () => {
  const block: BlockStockDraft = { width: '254', height: '127', thickness: '19' }
  for (const type of ['milling', 'plasma'] as ProjectType[]) {
    // The path before #1046: the typed block, then the type applied to it.
    const before = projectWithProjectType({ ...METRIC, stock: defaultStock(254, 127, 19) }, type, [])
    const after = blankTemplateProject(METRIC, type, [], block, BAR_MM)
    assert.ok(after, `${type}: the block draft creates a project`)
    assert.deepEqual(withoutTimestamp(after), withoutTimestamp(before), `${type}: the created project is unchanged`)
    assert.equal('shape' in after.stock, false, `${type}: still a plain block`)
    assert.deepEqual(getStockBounds(after.stock), getStockBounds(defaultStock(254, 127, 19)), `${type}: the typed box`)
  }
})

test('the bar draft defaults are the dialog defaults and survive a shape change', () => {
  assert.deepEqual(defaultBlankStockDraft('mm'), { shape: 'round', size: '40', length: '200', axis: 'x' }, 'metric round')
  assert.deepEqual(defaultBlankStockDraft('inch'), { shape: 'round', size: '1.5', length: '8', axis: 'x' }, 'imperial round')
  const square = defaultBlankStockDraft('mm', 'square')
  assert.equal(square.shape, 'square', 'the shape is kept')
  assert.equal(square.size, '40', 'the size carries over as the side')
  assert.equal(square.length, '200', 'and the length is unchanged')
})

test('a non-positive or unparseable length creates nothing', () => {
  const invalidBars: BlankStockDraft[] = [
    { ...BAR_MM, size: '0' },
    { ...BAR_MM, size: '-5' },
    { ...BAR_MM, size: 'nope' },
    { ...BAR_MM, length: '' },
    { ...BAR_MM, length: '0' },
    { ...BAR_MM, length: '-1' },
  ]
  for (const draft of invalidBars) {
    assert.equal(blankBarStock(draft), null, `bar ${JSON.stringify(draft)} is refused`)
    assert.equal(blankTemplateProject(METRIC, 'rotary', [], BLOCK_MM, draft), null, 'and creates no project')
  }

  const invalidBlocks: BlockStockDraft[] = [
    { ...BLOCK_MM, width: '0' },
    { ...BLOCK_MM, height: '' },
    { ...BLOCK_MM, thickness: '-2' },
  ]
  for (const draft of invalidBlocks) {
    assert.equal(blankTemplateStock('milling', draft, BAR_MM), null, `block ${JSON.stringify(draft)} is refused`)
    assert.equal(blankTemplateProject(METRIC, 'milling', [], draft, BAR_MM), null, 'and creates no project')
    assert.equal(blankTemplateProject(METRIC, 'plasma', [], draft, BAR_MM), null, 'plasma refuses it too')
  }
})

test('the type, not the draft, decides whether the blank is a bar or a block', () => {
  for (const type of ['milling', 'plasma'] as ProjectType[]) {
    const stock = blankTemplateStock(type, BLOCK_MM, { ...BAR_MM, shape: 'square' })
    assert.ok(stock, `${type}: the block draft is valid`)
    assert.equal('shape' in stock, false, `${type}: a block even with a bar draft filled in`)
  }
  const rotary = blankTemplateStock('rotary', BLOCK_MM, { ...BAR_MM, shape: 'square' })
  assert.ok(rotary, 'rotary reads the bar draft')
  assert.equal(isSquareStock(rotary), true, 'as a square blank')
})

test('a created rotary blank starts with the one chuck its block→bar conversion gives it', () => {
  const cases: ReadonlyArray<{ label: string; template: Project; shape: BlankStockShape; draft: BlankStockDraft }> = [
    { label: 'round mm X', template: METRIC, shape: 'round', draft: { shape: 'round', size: '37.5', length: '123.25', axis: 'x' } },
    { label: 'round mm Y', template: METRIC, shape: 'round', draft: { shape: 'round', size: '18', length: '90', axis: 'y' } },
    { label: 'square mm X', template: METRIC, shape: 'square', draft: { shape: 'square', size: '30', length: '160', axis: 'x' } },
    { label: 'square mm Y', template: METRIC, shape: 'square', draft: { shape: 'square', size: '22', length: '110', axis: 'y' } },
    { label: 'round inch X', template: IMPERIAL, shape: 'round', draft: { shape: 'round', size: '1.25', length: '7', axis: 'x' } },
    { label: 'round inch Y', template: IMPERIAL, shape: 'round', draft: { shape: 'round', size: '0.75', length: '5', axis: 'y' } },
    { label: 'square inch X', template: IMPERIAL, shape: 'square', draft: { shape: 'square', size: '1', length: '9', axis: 'x' } },
    { label: 'square inch Y', template: IMPERIAL, shape: 'square', draft: { shape: 'square', size: '2', length: '4', axis: 'y' } },
  ]

  for (const entry of cases) {
    const template = blankTemplateProject(entry.template, 'rotary', [], BLOCK_MM, entry.draft)
    assert.ok(template, `${entry.label}: the draft creates a project`)
    const created = instantiateProjectTemplate(template)
    assert.equal(created.clamps.length, 1, `${entry.label}: exactly one clamp, not none and not two`)
    const chuck = created.clamps[0]
    assert.equal(chuck.type, 'chuck', `${entry.label}: the clamp is a chuck`)
    assert.equal(chuck.name, 'Chuck', `${entry.label}: named as the conversion names it`)
    assert.deepEqual(
      withoutId(chuck),
      withoutId(convertedChuck(entry.template, entry.shape, entry.draft)),
      `${entry.label}: the same chuck the block→bar conversion mints for that bar`,
    )
  }
})

test('a created milling or plasma blank has no clamps', () => {
  for (const type of ['milling', 'plasma'] as ProjectType[]) {
    const template = blankTemplateProject(METRIC, type, [], BLOCK_MM, BAR_MM)
    assert.ok(template, `${type}: the block draft creates a project`)
    assert.equal(instantiateProjectTemplate(template).clamps.length, 0, `${type}: a block has no workholding`)
  }
})

test('an instantiated template already on a bar gets one chuck; a block gets none', () => {
  const bar = roundStock(25, 140, 'y')
  const fromBar = instantiateProjectTemplate({ ...METRIC, stock: bar, origin: defaultOrigin(bar), clamps: [] })
  assert.equal(fromBar.clamps.length, 1, 'a bar template cannot start without its chuck')
  assert.equal(fromBar.clamps[0].type, 'chuck', 'the minted clamp is a chuck')

  const fromBlock = instantiateProjectTemplate({ ...METRIC, stock: defaultStock(80, 60, 12), clamps: [] })
  assert.equal(fromBlock.clamps.length, 0, 'a block template gets no clamps')
})

console.log(`\nBlank template stock: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
