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
import { newProject, roundStock, defaultOrigin, type Clamp } from '../../types/project'
import { squareStock, barCentre, barPivotZ } from '../../types/barStock'
import { convertLength, convertProjectUnits } from '../../utils/units'
import { useProjectStore } from '../projectStore'
import { newChuck, projectWithStockShape } from './stockShape'
import { normalizeProject, decodeProjectFormat } from './projectFormat'
import { expandedClampBounds } from '../../engine/toolpaths/clamps'
import { STANDARD_CHUCKS, chuckGripDiameter, chuckOutOfRange, chuckSizePatch, syncRoundWorkholding } from './roundWorkholding'

function fixture(diameter = 20, units: 'mm' | 'inch' = 'mm', axis: 'x' | 'y' = 'x') {
  const stock = roundStock(diameter, diameter * 8, axis, { x: 7, y: 11 })
  const project = { ...newProject('Chuck', units), stock, origin: defaultOrigin(stock) }
  return { ...project, clamps: [newChuck(project, stock)] }
}

test('new project takes the smallest fitting actual equipment, at each capacity boundary on both axes and units', () => {
  for (const units of ['mm', 'inch'] as const) for (const axis of ['x', 'y'] as const) {
    for (const diameterIn of [0.1, 1.06, 1.061, 1.3, 1.301, 1.97, 1.971, 2.52, 2.521, 3.54, 3.541, 4.6, 4.601, 5.2]) {
      const project = fixture(convertLength(diameterIn, 'inch', units), units, axis)
      useProjectStore.getState().createNewProject(project, 'New rotary project')
      const chuck = useProjectStore.getState().project.clamps[0]
      const expected = STANDARD_CHUCKS.find((size) => diameterIn >= size.minIn && diameterIn <= size.maxIn)
      assert.equal(chuck.chuck?.size, expected?.id)
      assert.equal(axis === 'x' ? chuck.h : chuck.w, convertLength(expected!.diameterIn, 'inch', units))
    }
  }
})

test('stock resize, axis and shape changes preserve chosen equipment, including a too-small legacy chuck', () => {
  for (const axis of ['x', 'y'] as const) {
    const project = fixture(20, 'mm', axis)
    useProjectStore.setState({ project, history: { past: [], future: [], transactionStart: null } })
    useProjectStore.getState().setRectStockDimension(axis === 'x' ? 'height' : 'width', 70, 'top')
    const resized = useProjectStore.getState().project
    const chuck = resized.clamps[0]
    assert.equal(axis === 'x' ? chuck.h : chuck.w, axis === 'x' ? project.clamps[0].h : project.clamps[0].w)
    assert.deepEqual(chuck.chuck, project.clamps[0].chuck)
    assert.equal((axis === 'x' ? chuck.y + chuck.h / 2 : chuck.x + chuck.w / 2), barCentre(resized.stock as typeof project.stock))
    assert.equal(chuck.height, barPivotZ(resized.stock as typeof project.stock) + (axis === 'x' ? chuck.h : chuck.w) / 2)
    assert.ok(chuckOutOfRange(chuck, resized.stock, 'mm'))
    const square = syncRoundWorkholding(projectWithStockShape(resized, 'square'))
    assert.equal(axis === 'x' ? square.clamps[0].h : square.clamps[0].w, axis === 'x' ? chuck.h : chuck.w)
    const legacy: Clamp = { ...chuck, h: 5, w: 5 }
    delete legacy.chuck
    const switched = projectWithStockShape({ ...project, clamps: [legacy] }, 'square')
    assert.equal(switched.clamps[0], legacy)
  }
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
