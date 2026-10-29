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

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { newProject, roundStock, defaultOrigin, type BarStock, type Clamp, type Project } from '../../types/project'
import { squareStock, barCentre, barMaxRadius, barPivotZ } from '../../types/barStock'
import { convertLength, convertProjectUnits } from '../../utils/units'
import { useProjectStore } from '../projectStore'
import { newChuck, projectWithStockShape } from './stockShape'
import { normalizeProject, decodeProjectFormat } from './projectFormat'
import { expandedClampBounds } from '../../engine/toolpaths/clamps'
import {
  DEFAULT_CHUCK_ID,
  STANDARD_CHUCKS,
  chuckGripDiameter,
  chuckOutOfRange,
  chuckSizePatch,
  defaultJawCount,
  defaultRoundWorkholding,
} from './roundWorkholding'

function fixture(diameter = 20, units: 'mm' | 'inch' = 'mm', axis: 'x' | 'y' = 'x') {
  const stock = roundStock(diameter, diameter * 8, axis, { x: 7, y: 11 })
  const project = { ...newProject('Chuck', units), stock, origin: defaultOrigin(stock) }
  return { ...project, clamps: [newChuck(project, stock)] }
}

test('new project takes the 4 inch starter, or the smallest fitting actual equipment past it, on both axes and units', () => {
  const starter = STANDARD_CHUCKS.find((size) => size.id === DEFAULT_CHUCK_ID)!
  // #1112 R2 item 23 names the size: 4 inch (100 mm), not merely "the default".
  assert.equal(starter.id, 'bison-3204-4', 'the starter is the 4 inch preset')
  for (const units of ['mm', 'inch'] as const) for (const axis of ['x', 'y'] as const) {
    for (const diameterIn of [0.1, 1.06, 1.061, 1.3, 1.301, 1.97, 1.971, 2.52, 2.521, 3.54, 3.541, 4.6, 4.601, 5.2]) {
      const project = fixture(convertLength(diameterIn, 'inch', units), units, axis)
      useProjectStore.getState().createNewProject(project, 'New rotary project')
      const chuck = useProjectStore.getState().project.clamps[0]
      // #1112 R2 item 23: the 4 inch starter unless the bar is outside its
      // gripping range; then the smallest preset whose range holds the bar.
      const expected = diameterIn >= starter.minIn && diameterIn <= starter.maxIn
        ? starter
        : STANDARD_CHUCKS.find((size) => diameterIn >= size.minIn && diameterIn <= size.maxIn)
      assert.equal(chuck.chuck?.size, expected?.id)
      assert.equal(axis === 'x' ? chuck.h : chuck.w, convertLength(expected!.diameterIn, 'inch', units))
      assert.equal(chuck.chuck?.jawCount, 3, 'a round bar starts with three jaws')
      assert.equal(chuck.chuck?.manual, undefined, 'a minted default is not hand-set')
    }
  }
})

test('a stock resize re-defaults an untouched chuck, keeps a hand-set one and never touches legacy equipment', () => {
  for (const axis of ['x', 'y'] as const) {
    const across = (clamp: Clamp): number => (axis === 'x' ? clamp.h : clamp.w)
    const project = fixture(20, 'mm', axis)
    useProjectStore.setState({ project, history: { past: [], future: [], transactionStart: null } })
    useProjectStore.getState().setRectStockDimension(axis === 'x' ? 'height' : 'width', 70, 'top')
    const resized = useProjectStore.getState().project
    const resizedBar = resized.stock as BarStock
    const followed = resized.clamps[0]
    // 70 mm is past the 4, 5 and 6 inch capacities, inside the 8 inch one.
    assert.equal(followed.chuck?.size, 'bison-3204-8', 'the default follows the bar up')
    assert.equal(across(followed), convertLength(7.87, 'inch', 'mm'), 'the 8 inch body replaces the 4 inch one')
    assert.equal((axis === 'x' ? followed.y + followed.h / 2 : followed.x + followed.w / 2), barCentre(resizedBar),
      'centred on the resized bar')
    assert.equal(followed.height, barPivotZ(resizedBar) + across(followed) / 2, 'the height derives from the body')
    assert.equal(chuckOutOfRange(followed, resized.stock, 'mm'), false, 'the new equipment holds the bar')

    // The same resize with the chuck set by hand leaves it exactly as it was.
    const manual: Clamp = { ...project.clamps[0], chuck: { ...project.clamps[0].chuck, manual: true } }
    useProjectStore.setState({ project: { ...project, clamps: [manual] }, history: { past: [], future: [], transactionStart: null } })
    useProjectStore.getState().setRectStockDimension(axis === 'x' ? 'height' : 'width', 70, 'top')
    const keptByHand = useProjectStore.getState().project.clamps[0]
    assert.equal(keptByHand.chuck?.size, DEFAULT_CHUCK_ID, 'the hand-set size survives')
    assert.equal(across(keptByHand), across(manual), 'and so does its body')
    assert.ok(chuckOutOfRange(keptByHand, useProjectStore.getState().project.stock, 'mm'),
      'the operator is told the bar is now out of range')

    // A legacy chuck carries no equipment at all: nothing is inferred onto it.
    const legacy: Clamp = { ...project.clamps[0], h: 5, w: 5 }
    delete legacy.chuck
    useProjectStore.setState({ project: { ...project, clamps: [legacy] }, history: { past: [], future: [], transactionStart: null } })
    useProjectStore.getState().setRectStockDimension(axis === 'x' ? 'height' : 'width', 70, 'top')
    const untouched = useProjectStore.getState().project.clamps[0]
    assert.equal(untouched.chuck, undefined, 'no equipment is invented for it')
    assert.equal(across(untouched), 5, 'and its body is kept, exactly as the sync keeps a hand-set diameter')
  }
})

test('a new bar setup starts from the 4 inch starter with the shape\'s jaw count', () => {
  // Both bar shapes a block can turn into (the New project dialog's rotary
  // blank and the Shape control's conversions run this same minting).
  const round = projectWithStockShape(newProject('block', 'mm'), 'round')
  assert.equal(round.clamps[0].chuck?.size, 'bison-3204-4', 'a round bar takes the 4 inch starter')
  assert.equal(round.clamps[0].chuck?.jawCount, 3, 'with three jaws')
  const square = projectWithStockShape(newProject('block', 'mm'), 'square')
  assert.equal(square.clamps[0].chuck?.size, 'bison-3204-4', 'a square blank takes it too')
  assert.equal(square.clamps[0].chuck?.jawCount, 4, 'with four jaws, gripping its flats')
  assert.equal(square.clamps[0].chuck?.manual, undefined, 'neither is recorded as a hand edit')

  // A bar past the starter's capacity takes the smallest size that holds it.
  const wide = defaultRoundWorkholding('chuck', roundStock(convertLength(1.34, 'inch', 'mm'), 100, 'x'), 'mm')
  assert.equal(wide.chuck?.size, 'bison-3204-5', '34 mm is past the 4 inch maximum (1.3 in), so 5 inch')
})

test('a chuck body dragged by hand stops following the bar', () => {
  const project = fixture(20, 'mm', 'x')
  const id = project.clamps[0].id
  useProjectStore.setState({ project, history: { past: [], future: [], transactionStart: null } })
  useProjectStore.getState().moveClampControl(id, { kind: 'anchor', index: 0 }, { x: -40, y: -30 })
  const dragged = useProjectStore.getState().project.clamps[0]
  assert.equal(dragged.chuck?.manual, true, 'a dragged body is the operator\'s chuck')

  useProjectStore.getState().setRectStockDimension('height', 70, 'top')
  assert.equal(useProjectStore.getState().project.clamps[0].chuck?.size, DEFAULT_CHUCK_ID,
    'a 70 mm bar does not re-default the size the operator sized by hand')
  useProjectStore.getState().setStockShape('square')
  assert.equal(useProjectStore.getState().project.clamps[0].chuck?.jawCount, 3,
    'and the shape does not re-default its jaws either')
})

test('an untouched chuck follows the bar shape: four jaws on a blank, three on a round bar', () => {
  useProjectStore.setState({ project: fixture(20), history: { past: [], future: [], transactionStart: null } })
  assert.equal(useProjectStore.getState().project.clamps[0].chuck?.jawCount, 3, 'a round bar starts at three')
  useProjectStore.getState().setStockShape('square')
  const blank = useProjectStore.getState().project.clamps[0]
  assert.equal(blank.chuck?.jawCount, 4, 'the square blank gets four jaws')
  assert.equal(blank.chuck?.size, DEFAULT_CHUCK_ID, 'the starter still holds it, so the size does not move')
  assert.equal(blank.chuck?.manual, undefined, 'following the shape is not a hand edit')
  useProjectStore.getState().setStockShape('round')
  assert.equal(useProjectStore.getState().project.clamps[0].chuck?.jawCount, 3, 'and back to three on the round bar')
})

test('a hand-set jaw count stays through round → square → round', () => {
  const project = fixture(20)
  const byHand: Clamp = { ...project.clamps[0], chuck: { ...project.clamps[0].chuck, jawCount: 6, manual: true } }
  useProjectStore.setState({ project: { ...project, clamps: [byHand] }, history: { past: [], future: [], transactionStart: null } })
  useProjectStore.getState().setStockShape('square')
  assert.equal(useProjectStore.getState().project.clamps[0].chuck?.jawCount, 6, 'still six jaws on the blank')
  useProjectStore.getState().setStockShape('round')
  assert.equal(useProjectStore.getState().project.clamps[0].chuck?.jawCount, 6, 'and on the round bar')
})

test('a jaw count saved before the flag existed is read as a hand pick, not re-defaulted', () => {
  // A sibling build's 3-jaw square chuck records no `manual`: the stored value
  // is what its operator saw, so a shape change must not raise it to four.
  const squareProject = projectWithStockShape(fixture(20), 'square')
  const stored: Clamp = { ...squareProject.clamps[0], chuck: { ...squareProject.clamps[0].chuck, jawCount: 3 } }
  useProjectStore.setState({ project: { ...squareProject, clamps: [stored] }, history: { past: [], future: [], transactionStart: null } })
  useProjectStore.getState().setStockShape('round')
  assert.equal(useProjectStore.getState().project.clamps[0].chuck?.jawCount, 3, 'the unexplained three jaws are kept')
})

test('a saved 3-jaw square project loads with the jaws and size it stored', () => {
  const stock = squareStock(20, 100, 'x', { x: 5, y: 7 })
  const stored: Clamp = {
    id: 'cl-chuck',
    name: 'Chuck',
    visible: true,
    type: 'chuck',
    x: -20,
    w: 45,
    y: barCentre(stock) - 30,
    h: 60,
    height: barPivotZ(stock) + 30,
    chuck: { size: 'bison-3204-5', clampingRangeMm: { min: 3.048, max: 50.038 }, jawCount: 3 },
  }
  const savedProject: Project = {
    ...newProject('saved', 'mm'),
    stock,
    origin: defaultOrigin(stock),
    clamps: [stored],
  }
  // Loading over a different document (a 40 mm round bar with its own default
  // chuck) is the transition a load must not treat as a stock edit.
  useProjectStore.setState({ project: fixture(40), history: { past: [], future: [], transactionStart: null } })
  useProjectStore.getState().loadProject(savedProject)
  const loaded = useProjectStore.getState().project.clamps[0]
  assert.equal(loaded.chuck?.jawCount, 3, 'the stored three jaws are kept')
  assert.equal(loaded.chuck?.size, 'bison-3204-5', 'and the stored size')
  assert.equal(loaded.h, 60, 'and its body')
  assert.equal(loaded.chuck?.manual, undefined, 'loading infers no hand-set flag')
  assert.equal(useProjectStore.getState().project.stock.shape, 'square', 'the file\'s own blank')

  // The save → decode → normalize round trip keeps the same record.
  useProjectStore.setState({ project: savedProject })
  const decoded = decodeProjectFormat(JSON.parse(useProjectStore.getState().saveProject())).project
  assert.deepEqual(decoded.clamps[0].chuck, stored.chuck)
})

test('the square default is measured across flats, so a 4-jaw blank takes the size its capacity holds', () => {
  // A 30 mm square: 30 mm across flats (1.18 in) is inside the 4 inch range,
  // while its 42.4 mm corner circle would need a 5 inch body. A default picked
  // by the corner circle would therefore be the wrong equipment for four jaws.
  const stock = squareStock(30, 100, 'x')
  const defaults = defaultRoundWorkholding('chuck', stock, 'mm')
  assert.equal(defaults.chuck?.size, DEFAULT_CHUCK_ID, 'the starter holds the flats')
  assert.equal(defaults.chuck?.jawCount, 4, 'the square default is the 4-jaw set')
  const clamp: Clamp = { ...fixture().clamps[0], ...defaults }
  assert.equal(chuckOutOfRange(clamp, stock, 'mm'), false, 'so the blank is inside its capacity')
  const max = defaults.chuck?.clampingRangeMm?.max ?? 0
  assert.ok(chuckGripDiameter(stock, 3) > max, 'the corner circle this blank turns through is past it')
  assert.ok(chuckGripDiameter(stock, 6) > max, 'and six jaws measure that same corner circle')
  assert.equal(defaultJawCount(stock), 4, 'four jaws are what a square blank starts with')
})

test('a square blank no preset can clear keeps the stock-derived body, not a too-small one', () => {
  // A 320 mm side turns through a 452 mm corner circle; the largest listed
  // body (12.4 in, 315 mm) cannot clear it, so no preset may be claimed for
  // the blank — the setup would be refused by the square's physical guard.
  const stock = squareStock(320, 1000, 'x')
  const defaults = defaultRoundWorkholding('chuck', stock, 'mm')
  assert.equal(defaults.chuck?.size, undefined, 'no preset is claimed')
  const body = stock.axis === 'x' ? defaults.h : defaults.w
  assert.ok(body / 2 >= barMaxRadius(stock), 'and the stock-derived body clears the corners')
  const clamp: Clamp = { ...fixture().clamps[0], ...defaults }
  assert.equal(chuckOutOfRange(clamp, stock, 'mm'), true, 'the blank is still reported past the largest capacity')
})

test('capacity uses square flats for four jaws and the corner circle for three or six; boundaries inclusive', () => {
  const stock = squareStock(20, 100, 'x')
  const clamp = fixture().clamps[0]
  for (const jawCount of [3, 4, 6] as const) {
    const diameter = chuckGripDiameter(stock, jawCount)
    assert.equal(diameter, jawCount === 4 ? 20 : 20 * Math.SQRT2)
    const chuck = { ...clamp, chuck: { jawCount, clampingRangeMm: { min: 20, max: 20 } } }
    assert.equal(chuckOutOfRange(chuck, stock, 'mm'), jawCount !== 4)
    assert.ok(chuckOutOfRange({ ...chuck, chuck: { ...chuck.chuck, clampingRangeMm: { min: diameter + 1, max: diameter + 5 } } }, stock, 'mm'))
    assert.equal(chuckOutOfRange({ ...chuck, chuck: { ...chuck.chuck, clampingRangeMm: { min: diameter, max: diameter } } }, stock, 'mm'), false)
  }
  // A bar past every listed capacity still takes the nearest end preset while
  // that preset's body can reach it, and is reported out of range.
  assert.ok(chuckOutOfRange(fixture(200).clamps[0], fixture(200).stock, 'mm'))
  // ...but a bar wider than the largest body is one no listed chuck can hold.
  // The minted default is then the stock-derived body (`smallestFittingChuck`
  // returns no preset), so the clamp never sits inside its own bar. It claims
  // no size, but it still carries the largest listed capacity and the bar is
  // past it — the tree/properties warning must not disappear (decision 9).
  const giant = fixture(1000).clamps[0]
  assert.equal(giant.chuck?.size, undefined, 'no preset is claimed for a bar no preset can reach')
  assert.ok(giant.chuck?.clampingRangeMm, 'the stock-derived chuck still has a capacity to be judged against')
  assert.ok(giant.h >= 1000, 'the stock-derived body clears the bar')
  assert.ok(chuckOutOfRange(giant, fixture(1000).stock, 'mm'), 'no standard range holds the bar, so the bar is reported')
})

test('old file stays unchanged; every new field survives the real save → decode → normalize path', () => {
  const project = normalizeProject(fixture())
  const old = structuredClone(project)
  delete old.clamps[0].chuck
  Object.assign(old.clamps[0], { h: 50, w: 55, x: -33, y: barCentre(old.stock as ReturnType<typeof roundStock>) - 25, height: barPivotZ(old.stock as ReturnType<typeof roundStock>) + 25 })
  assert.equal(JSON.stringify(decodeProjectFormat(JSON.parse(JSON.stringify(old))).project), JSON.stringify(old))
  useProjectStore.setState({ project: old })
  const oldSaved = decodeProjectFormat(JSON.parse(useProjectStore.getState().saveProject())).project
  oldSaved.meta.modified = old.meta.modified // ordinary save timestamp, unrelated to chuck data
  assert.equal(JSON.stringify(oldSaved), JSON.stringify(old), 'old file survives real save/load unchanged')
  const chuck = { ...project.clamps[0], ...chuckSizePatch('bison-3204-5', project.stock as ReturnType<typeof roundStock>, 'mm') }
  chuck.chuck = { ...chuck.chuck, jawCount: 6, clampingRangeMm: { min: 12.5, max: 44.5 } }
  useProjectStore.setState({ project: { ...project, clamps: [chuck] } })
  const saved = useProjectStore.getState().saveProject()
  const decoded = decodeProjectFormat(JSON.parse(saved))
  assert.deepEqual(decoded.project.clamps[0].chuck, chuck.chuck)
  assert.equal(decoded.project.version, '3.3')
  const inches = convertProjectUnits(decoded.project, 'inch')
  assert.deepEqual(inches.clamps[0].chuck, chuck.chuck, 'equipment capacity remains in mm')
  assert.equal(chuckOutOfRange(chuck, project.stock, 'mm'), chuckOutOfRange(inches.clamps[0], inches.stock, 'inch'))
})

test('jaw count and capacity never change the body keep-out', () => {
  const project = fixture()
  const geometry = (value: typeof project) => expandedClampBounds(value, 2).map(({ clamp, ...bounds }) => {
    void clamp // metadata is expected to differ; the collision bounds must not
    return bounds
  })
  const before = geometry(project)
  for (const jawCount of [3, 4, 6] as const) {
    const clamps = project.clamps.map((clamp) => ({ ...clamp, chuck: { ...clamp.chuck, jawCount, clampingRangeMm: { min: 1, max: 100 } } }))
    assert.deepEqual(geometry({ ...project, clamps }), before)
  }
})
