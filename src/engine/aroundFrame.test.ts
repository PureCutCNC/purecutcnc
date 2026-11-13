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
 * Around in numbers (issue #395), including parity with an independent sheet.
 * Mutations checked one at a time against these assertions:
 * - angle sign / radius not added / `zero` dropped: testPoints
 * - the zero line taken from the sheet's first edge: the ±90° sign checks
 * - circumference from radius: testFrames
 * - non-Around features retained / heights not lowered: testUnrolledProject
 * - a fixture band limited to one circumference: testUnrolledProject
 * - drillCycles retained / split indices not remapped: testToolpaths
 * - generation branch removed: testGenerationParity
 * - square sheet built from the corner radius / a different zero line: testSquareFrames
 * Run with: npx tsx src/engine/aroundFrame.test.ts
 */

import { deepStrictEqual } from 'node:assert'
import { circleProfile, defaultTool, getStockBounds, isAroundSetup, newProject, rectProfile, roundStock } from '../types/project'
import type { MachiningSetup, Operation, Project, SketchFeature, SketchProfile } from '../types/project'
import { squareStock } from '../types/barStock'
import { projectWithFeatures, withBottomSetup } from '../test/projectFixtures'
import { aroundFrame, aroundFrameForOperation, unrolledProject, unwrapPoint, unwrapToolpath, wrapPoint, wrapToolpath } from './aroundFrame'
import type { AroundFrame } from './aroundFrame'
import { stockSpacePoint, toolSpacePoint } from './rotaryFrame'
import { setupFace, setupFrameForOperation } from './setupOrientation'
import { computeOperationToolpath } from './toolpaths/generateOperation'
import { expandedClampBounds } from './toolpaths/clamps'
import type { PocketToolpathResult, ToolpathMove, ToolpathPoint, ToolpathResult } from './toolpaths/types'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function equal<T>(actual: T, expected: T, label: string): void {
  deepStrictEqual(actual, expected, label)
}

function near(actual: number, expected: number, label: string): void {
  assert(Math.abs(actual - expected) <= 1e-9, `${label}: ${actual} != ${expected}`)
}

function nearPoint(actual: { x: number; y: number; z: number }, expected: { x: number; y: number; z: number }, label: string): void {
  near(actual.x, expected.x, `${label} x`)
  near(actual.y, expected.y, `${label} y`)
  near(actual.z, expected.z, `${label} z`)
}

function throws(fn: () => unknown, label: string): void {
  let threw = false
  try { fn() } catch { threw = true }
  assert(threw, label)
}

const X_BAR = roundStock(40, 200, 'x', { x: 10, y: 30 })
const Y_BAR = roundStock(2, 8, 'y', { x: 3, y: 5 })

function setup(axis: 'x' | 'y'): MachiningSetup {
  return {
    id: 'around', name: 'Around', kind: 'around', orientation: { axis, angleDeg: 0 },
    indexing: 'manual', registration: [], notes: '', operationIds: [],
  }
}

function feature(id: string, kind: SketchFeature['kind'], profile: SketchProfile, top: number | string, bottom: number | string): SketchFeature {
  return {
    id, name: id, kind, folderId: null,
    sketch: { profile, origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: 'subtract', z_top: top, z_bottom: bottom, visible: true, locked: false,
  }
}

function operation(kind: Operation['kind'], featureId = 'target'): Operation {
  return {
    id: 'op', name: 'Operation', kind, setupId: 'around', pass: 'rough', enabled: true,
    showToolpath: true, debugToolpath: false, target: { source: 'features', featureIds: [featureId] },
    toolRef: 't1', stepdown: 2, stepover: 0.4, feed: 600, plungeFeed: 180, rpm: 12000,
    pocketPattern: 'offset', pocketAngle: 0, stockToLeaveRadial: 0, stockToLeaveAxial: 0,
    finishWalls: true, finishFloor: true, carveDepth: 1, maxCarveDepth: 1, entryStrategy: 'plunge',
  }
}

function testFrames(): void {
  console.log('Testing frame numbers...')
  equal(aroundFrame(X_BAR), { axis: 'x', centre: 50, radius: 20, zero: 50, sheetStart: 50 - 20 * Math.PI, circumference: 40 * Math.PI }, 'X/mm frame')
  equal(aroundFrame(Y_BAR), { axis: 'y', centre: 4, radius: 1, zero: 4, sheetStart: 4 - Math.PI, circumference: 2 * Math.PI }, 'Y/inch frame')
}

/**
 * The square blank's sheet is its *nominal reference cylinder* (#1016 C2-S3):
 * radius = side / 2 (inscribed), circumference = π · side, zero = the box
 * centre. It is a coordinate mapping for the angle a sheet column stands for,
 * not a claim about the blank's surfaces — so it is exactly the round bar's
 * frame on the same box, and the corner radius never appears in it.
 */
function testSquareFrames(): void {
  console.log('Testing the square blank sheet (nominal reference cylinder)...')
  for (const [side, length, axis, at] of [
    [20, 100, 'x', { x: 0, y: 0 }],
    [2, 8, 'y', { x: 3, y: 5 }],
    [40, 200, 'x', { x: 10, y: 30 }],
  ] as const) {
    const square = squareStock(side, length, axis, at)
    const sameBoxRound = roundStock(side, length, axis, at)
    const zero = aroundFrame(sameBoxRound).centre
    equal(aroundFrame(square), {
      axis,
      centre: zero,
      radius: side / 2,
      zero,
      sheetStart: zero - Math.PI * side / 2,
      circumference: Math.PI * side,
    }, `${axis} square frame is the inscribed radius and π·side`)
    // The mapping is the box's, not the blank's shape: the same box's round
    // bar frames it identically. A circumscribed (corner-radius) envelope or a
    // different zero line fails here.
    equal(aroundFrame(square), aroundFrame(sameBoxRound), `${axis} square sheet ≡ round sheet on the same box`)
    const frame = aroundFrame(square)
    // A quarter sheet is a quarter turn, and a flat point is raised by the
    // nominal radius — never by the corner radius.
    const quarter = flatPoint(frame, at.x + length / 4, frame.zero + frame.circumference / 4, 3)
    const wrapped = wrapPoint(quarter, frame)
    near(wrapped.a!, 90, `${axis} quarter sheet is +90°`)
    equal(frame.axis === 'x' ? wrapped.y : wrapped.x, frame.centre, `${axis} wraps onto the pivot`)
    equal(wrapped.z, 3 + side / 2, `${axis} flat height raised by the nominal radius`)
    nearPoint(unwrapPoint(wrapped, frame), quarter, `${axis} square round trip`)
    // An Around operation on a square blank axis-matched gets the frame; a
    // mismatched axis is still refused, and a block still throws (testSetups).
    const project = makeProject(sameBoxRound)
    const op = operation('pocket', 'around')
    equal(aroundFrameForOperation({ ...project, stock: square }, op), frame, `${axis} Around frame on a square blank`)
    const otherAxis = axis === 'x' ? 'y' : 'x'
    throws(() => aroundFrameForOperation(
      { ...project, stock: squareStock(side, length, otherAxis, at) }, op,
    ), `${axis} mismatched square axis refused`)
  }
}

function flatPoint(frame: AroundFrame, along: number, across: number, z: number): ToolpathPoint {
  return frame.axis === 'x' ? { x: along, y: across, z } : { x: across, y: along, z }
}

function testPoints(): void {
  console.log('Testing the zero line, point offsets, unbounded angles and rotary agreement...')
  for (const stock of [X_BAR, Y_BAR]) {
    const frame = aroundFrame(stock)
    // The zero line is the bar's centreline (issue #1026): a point on it wraps
    // to a = 0, and one a quarter circumference to either side to ±90°. The
    // signs are the frozen rotaryFrame convention — positive across the bar.
    const onZero = flatPoint(frame, 17, frame.zero, frame.radius / 2)
    near(wrapPoint(onZero, frame).a!, 0, 'the zero line wraps to a = 0')
    near(wrapPoint(flatPoint(frame, 17, frame.zero + frame.circumference / 4, frame.radius / 2), frame).a!, 90, 'a quarter turn to the +across side is +90')
    near(wrapPoint(flatPoint(frame, 17, frame.zero - frame.circumference / 4, frame.radius / 2), frame).a!, -90, 'a quarter turn to the other side is -90')
    for (const [turns, expectedAngle] of [[0, 0], [0.25, 90], [2.5, 900], [-0.25, -90]]) {
      const flat = flatPoint(frame, 17, frame.zero + frame.circumference * turns, frame.radius / 2)
      const wrapped = wrapPoint(flat, frame)
      near(wrapped.a!, expectedAngle, 'angle sign and turns')
      equal(frame.axis === 'x' ? wrapped.y : wrapped.x, frame.centre, 'exact centreline')
      equal(wrapped.z, frame.radius * 1.5, 'radius added')
      nearPoint(unwrapPoint(wrapped, frame), flat, 'round trip')
      assert(!('a' in unwrapPoint(wrapped, frame)), 'inverse has no a key')
    }
    // Integer sheet offset gives a bit-exact round trip, including its zero line.
    const exact = flatPoint(frame, 17, frame.zero, frame.radius / 2)
    equal(unwrapPoint(wrapPoint(exact, frame), frame), exact, 'exact round trip')
    throws(() => unwrapPoint(exact, frame), 'missing angle fails closed')
    for (const r of [0, frame.radius / 2, frame.radius, frame.radius + 3]) {
      for (const angle of [-90, 0, 30, 90, 180, 270, 900]) {
        const flat = flatPoint(frame, 17, frame.zero + frame.circumference * angle / 360, r)
        const wrapped = wrapPoint(flat, frame)
        const across = frame.centre + r * Math.sin(angle * Math.PI / 180)
        const expected = flatPoint(frame, 17, across, frame.radius + r * Math.cos(angle * Math.PI / 180))
        nearPoint(stockSpacePoint(wrapped, stock), expected, 'stockSpacePoint agreement')
        const tool = toolSpacePoint(expected, angle, stock)
        nearPoint(wrapped, tool, 'toolSpacePoint agreement')
        near(wrapped.a!, tool.a!, 'inverse angle agreement')
      }
    }
  }
}

function makeProject(stock = X_BAR): Project {
  const base = newProject('Around', stock.axis === 'x' ? 'mm' : 'inch')
  base.stock = stock
  // The Around face and its features exist only in a rotary project (issue #1028).
  base.meta.projectType = 'rotary'
  base.dimensions = { floor: { id: 'floor', name: 'floor', value: stock.thickness * 0.75, formula: null } }
  const built = projectWithFeatures(base, [
    feature('around', 'rect', rectProfile(20, 40, 30, 10), stock.thickness, 'floor'),
    feature('top', 'rect', rectProfile(70, 40, 20, 10), stock.thickness, 0),
  ])
  return {
    ...built,
    features: built.features.map((f) => ({ ...f, authoringFace: f.id === 'around' ? 'around' : 'top' })),
    setups: [...built.setups, setup(stock.axis)],
    tabs: [{ id: 'tab', name: 'Tab', x: 25, y: 40, w: 5, h: 5, z_top: 3, z_bottom: 0, visible: true }],
    clamps: [
      { id: 'chuck', name: 'Chuck', type: 'chuck', x: 0, y: 28, w: 10, h: 44, height: stock.thickness + 2, visible: true },
      { id: 'tail', name: 'Tailstock', type: 'tailstock', x: 210, y: 27, w: 12, h: 46, height: stock.thickness + 4, visible: true },
      { id: 'step', name: 'Step', type: 'step_clamp', x: 100, y: 40, w: 5, h: 5, height: 50, visible: true },
    ],
    origin: { ...built.origin, x: 12, y: 34, z: stock.thickness },
  }
}

function testUnrolledProject(): void {
  console.log('Testing transient stock, heights, bands and input immutability...')
  for (const stock of [X_BAR, Y_BAR]) {
    const project = makeProject(stock)
    const before = structuredClone(project)
    const frame = aroundFrame(stock)
    const flat = unrolledProject(project, frame)
    const radius = stock.axis === 'x' ? 20 : 1
    const circumference = stock.axis === 'x' ? 40 * Math.PI : 2 * Math.PI
    equal(getStockBounds(flat.stock), stock.axis === 'x'
      ? { minX: 10, minY: frame.sheetStart, maxX: 210, maxY: frame.sheetStart + circumference }
      : { minX: frame.sheetStart, minY: 5, maxX: frame.sheetStart + circumference, maxY: 13 }, 'stock box length and circumference')
    equal(flat.stock.thickness, radius, 'flat thickness')
    equal(flat.meta.maxTravelZ, Math.max(0, project.meta.maxTravelZ - radius), 'travel ceiling lowered by radius')
    equal(unrolledProject({ ...project, meta: { ...project.meta, maxTravelZ: radius / 2 } }, aroundFrame(stock)).meta.maxTravelZ, 0, 'travel ceiling floored at zero')
    for (const key of ['shape', 'axis', 'sourceFeature']) assert(!(key in flat.stock), `plain block has no ${key}`)
    equal(flat.features.map((f) => f.id), ['around'], 'only Around features')
    equal(flat.features[0].z_top, radius, 'surface lowered')
    equal(flat.features[0].z_bottom, radius / 2, 'named height resolved and lowered')
    equal(flat.features[0].transform, project.features[0].transform, 'XY never swapped or transformed')
    equal(flat.featureDefinitions, project.featureDefinitions, 'definitions pass through')
    equal(flat.operations, project.operations, 'operations pass through')
    equal(flat.tabs, [], 'no tabs')
    equal(flat.clamps.map((c) => c.id), ['chuck', 'tail'], 'only rotary fixtures')
    // A fixture band covers every turn the job can reach: one circumference
    // below the lowest across coordinate of anything on the sheet and one above
    // the highest (the sheet's own edges, or the feature's bounds on the short
    // Y bar).
    const acrossMin = frame.sheetStart - circumference
    const acrossMax = stock.axis === 'x' ? frame.sheetStart + 2 * circumference : 50 + circumference
    equal(flat.clamps, project.clamps.slice(0, 2).map((c) => ({ ...c, height: c.height - radius,
      ...(stock.axis === 'x' ? { y: acrossMin, h: acrossMax - acrossMin } : { x: acrossMin, w: acrossMax - acrossMin }),
    })), 'multi-turn clamp bands and top heights')
    const checked = expandedClampBounds(flat, 0)
    equal(checked[0].requiredZ, flat.clamps[0].height + flat.meta.clampClearanceZ, 'height is absolute top Z')
    equal(flat.clamps[0].height - flat.stock.thickness, project.clamps[0].height - stock.thickness, 'same height above stock')
    equal(flat.origin, { ...project.origin, z: radius }, 'only origin Z lowered')
    const around = flat.setups.find((s) => s.id === 'around')!
    assert(!('kind' in around), 'kind removed')
    equal(setupFace(around), 'top', 'unrolled setup reads as Top')
    equal(project, before, 'input not mutated')
    assert(flat.setups[0] === project.setups[0], 'Top setup passes through')
  }
}

function testToolpaths(): void {
  console.log('Testing path splitting, metadata, collisions and inverse...')
  for (const stock of [X_BAR, Y_BAR]) {
    const frame = aroundFrame(stock)
    // The sheet is framed one circumference with the zero line in the middle
    // (issue #1026), and the inverse names the same window, so a path is
    // measured from the zero line here.
    const point = (along: number, across: number, z: number) => flatPoint(frame, along, frame.zero + across, z)
    const turn: ToolpathMove = { kind: 'cut', from: point(10, 0, 20), to: point(15, 10, 20), source: 'turn' }
    const ramp: ToolpathMove = { kind: 'lead_in', from: point(15, 10, 20), to: point(25, 30, 10), source: 'ramp', feedScale: 0.5 }
    const plunge: ToolpathMove = { kind: 'plunge', from: point(25, 30, 10), to: point(25, 30, 5) }
    const result: PocketToolpathResult = {
      operationId: 'op', moves: [turn, ramp, plunge], warnings: [], bounds: null,
      stepLevels: [20, 10, 5], collidingClampIds: ['fixture'], collidingMoveIndices: [1, 2],
      drillCycles: [{ x: 25, y: 30, clearZ: 20, retractZ: 19, bottomZ: 5, drillType: 'simple' }],
    }
    const before = structuredClone(result)
    const wrapped = wrapToolpath(result, frame)
    equal(wrapped.moves.length, 12, 'only ramp splits into ten pieces')
    equal(wrapped.moves.map((m) => m.kind), ['cut', ...Array<string>(10).fill('lead_in'), 'plunge'], 'order and kinds')
    equal(wrapped.moves[0], { ...turn, from: wrapPoint(turn.from, frame), to: wrapPoint(turn.to, frame) }, 'turn not split')
    equal(wrapped.moves[11], { ...plunge, from: wrapPoint(plunge.from, frame), to: wrapPoint(plunge.to, frame) }, 'plunge not split')
    equal(wrapped.collidingMoveIndices, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 'split collision indices remapped')
    for (let i = 1; i <= 10; i++) {
      equal(wrapped.moves[i].feedScale, 0.5, 'piece feedScale')
      equal(wrapped.moves[i].source, 'ramp', 'piece source')
      equal(wrapped.moves[i].from.z, 21 - i + frame.radius, 'piece starts at equal flat fraction')
      equal(wrapped.moves[i].to.z, 20 - i + frame.radius, 'piece ends at equal flat fraction')
      if (i > 1) equal(wrapped.moves[i].from, wrapped.moves[i - 1].to, 'pieces stay connected')
    }
    equal(wrapped.bounds, stock.axis === 'x'
      ? { minX: 10, minY: 50, minZ: 25, maxX: 25, maxY: 50, maxZ: 40 }
      : { minX: 4, minY: 10, minZ: 6, maxX: 4, maxY: 25, maxZ: 21 }, 'wrapped bounds remeasured')
    assert(!('drillCycles' in wrapped), 'drillCycles removed')
    equal(wrapped.stepLevels, [20 + frame.radius, 10 + frame.radius, 5 + frame.radius], 'step levels raised')
    const unwrapped = unwrapToolpath(wrapped, frame)
    equal(unwrapped.stepLevels, [20, 10, 5], 'step levels lowered')
    equal(unwrapped.collidingMoveIndices, wrapped.collidingMoveIndices, 'pieces and indices stay split')
    for (const move of unwrapped.moves) for (const p of [move.from, move.to]) assert(!('a' in p), 'no unwrapped angle key')
    nearPoint(unwrapped.moves[0].from, turn.from, 'inverse first point')
    nearPoint(unwrapped.moves[11].to, plunge.to, 'inverse last point')
    for (let i = 1; i <= 10; i++) {
      nearPoint(unwrapped.moves[i].from, point(14 + i, 8 + 2 * i, 21 - i), 'inverse split from')
      nearPoint(unwrapped.moves[i].to, point(15 + i, 10 + 2 * i, 20 - i), 'inverse split to')
    }
    near(unwrapped.bounds!.minX, stock.axis === 'x' ? 10 : 4, 'inverse minX')
    near(unwrapped.bounds!.maxY, stock.axis === 'x' ? 80 : 25, 'inverse maxY')
    equal(result, before, 'input result not mutated')
    const nearCentre: ToolpathResult = { operationId: 'op', moves: [{ ...ramp, from: point(0, 0, 0), to: point(0, 1, 1) }], warnings: [], bounds: null }
    equal(wrapToolpath(nearCentre, frame).moves.length, 64, 'epsilon and split cap at centreline')
    equal(wrapToolpath({ ...result, moves: [] }, frame).bounds, null, 'empty bounds')
  }
}

function testGenerationParity(): void {
  console.log('Testing real seam parity for pocket, follow-line, edge route and drill...')
  for (const stock of [X_BAR, Y_BAR]) {
    const units = stock.axis === 'x' ? 'mm' : 'inch'
    const top = stock.axis === 'x' ? 40 : 2
    const radius = stock.axis === 'x' ? 20 : 1
    const depth = stock.axis === 'x' ? 4 : 0.2
    const toolDiameter = stock.axis === 'x' ? 3 : 0.125
    for (const kind of ['pocket', 'follow_line', 'edge_route_outside', 'drilling'] as const) {
      const profile = kind === 'drilling'
        ? circleProfile(stock.axis === 'x' ? 50 : 4, stock.axis === 'x' ? 50 : 8, toolDiameter / 2)
        : stock.axis === 'x' ? rectProfile(40, 40, 30, 20) : rectProfile(3.5, 7, 1, 2)
      const draft = feature('target', kind === 'drilling' ? 'circle' : 'rect', profile, top, top - depth)
      if (kind === 'follow_line') draft.operation = 'line'
      if (kind === 'edge_route_outside') draft.operation = 'add'
      const base = newProject('Parity', units)
      base.stock = stock
      base.meta.projectType = 'rotary'
      base.tools = [{ ...defaultTool(units, 1), id: 't1', diameter: toolDiameter, type: kind === 'drilling' ? 'drill' : 'flat_endmill' }]
      const op = { ...operation(kind), stepdown: depth / 2, carveDepth: depth, maxCarveDepth: depth, drillType: 'peck' as const, peckDepth: depth / 2 }
      // Apply Around after fixture normalization: loading Around is slice B.
      const built = projectWithFeatures(base, [draft])
      const project: Project = { ...built, features: built.features.map((f) => ({ ...f, authoringFace: 'around' })),
        setups: [setup(stock.axis)], activeSetupId: 'around', operations: [op] }
      const flatBase = newProject('Parity', units)
      flatBase.stock = {
        profile: stock.axis === 'x' ? rectProfile(10, 30, 200, 40 * Math.PI) : rectProfile(3, 5, 2 * Math.PI, 8),
        thickness: radius, material: stock.material, color: stock.color, visible: stock.visible, origin: { ...stock.origin },
      }
      flatBase.origin = { ...base.origin, z: base.origin.z - radius }
      flatBase.tools = base.tools
      const flatBuilt = projectWithFeatures(flatBase, [{ ...draft, authoringFace: 'top', z_top: radius, z_bottom: top - depth - radius }])
      const topSetup: MachiningSetup = { id: 'around', name: 'Around', orientation: { axis: stock.axis, angleDeg: 0 }, indexing: 'manual', registration: [], notes: '', operationIds: [] }
      const independent: Project = { ...flatBuilt, setups: [topSetup], activeSetupId: 'around', operations: [op] }
      const envelope = computeOperationToolpath(project, op, { trace: true })
      const flatEnvelope = computeOperationToolpath(independent, op, { trace: true })
      assert(envelope && flatEnvelope, `${kind} returns envelopes`)
      assert(flatEnvelope.result.moves.length > 0, `${kind} parity is not vacuous`)
      equal(envelope.result, wrapToolpath(flatEnvelope.result, aroundFrame(stock)), `${kind} result parity`)
      assert(envelope.raw && flatEnvelope.raw, `${kind} trace is captured`)
      equal(envelope.raw, wrapToolpath(flatEnvelope.raw, aroundFrame(stock)), `${kind} raw parity`)
      equal(computeOperationToolpath(project, op)!.raw, null, `${kind} no-trace stays null`)
      for (const path of [envelope.result, envelope.raw]) for (const move of path.moves) for (const point of [move.from, move.to]) {
        assert(point.a !== undefined, `${kind} every point has a`)
        equal(stock.axis === 'x' ? point.y : point.x, stock.axis === 'x' ? 50 : 4, `${kind} exact centreline`)
        assert(point.z >= radius, `${kind} none below centreline`)
      }
      if (kind === 'drilling') {
        assert(flatEnvelope.result.drillCycles!.length > 0, 'flat drilling has canned metadata')
        assert(flatEnvelope.result.moves.some((m) => m.kind === 'plunge' && m.to.z === top - depth - radius), 'expanded drill reaches bottom')
        assert(flatEnvelope.result.moves.at(-1)!.kind === 'rapid', 'expanded drill retracts')
        assert(!('drillCycles' in envelope.result), 'real seam drops drill cycles')
      }
    }
  }
}

function testSetups(): void {
  console.log('Testing setup kinds and fail-closed operation frames...')
  const project = withBottomSetup(makeProject())
  const top = project.setups[0]
  const bottom = project.setups.at(-1)!
  const around = project.setups.find((s) => s.id === 'around')!
  equal(setupFace(top), 'top', 'Top face')
  equal(setupFace(bottom), 'bottom', 'Bottom face')
  equal(setupFace(around), 'around', 'Around face')
  assert(isAroundSetup(around) && !isAroundSetup(top) && !isAroundSetup(bottom), 'Around guard')
  const op = operation('pocket', 'around')
  equal(setupFrameForOperation(project, op), undefined, 'Around is not a rigid turn')
  equal(aroundFrameForOperation(project, op), aroundFrame(X_BAR), 'Around operation frame')
  for (const setupId of [undefined, top.id, bottom.id]) {
    equal(aroundFrameForOperation(project, { ...op, setupId }), undefined, 'flat setups have no Around frame')
  }
  throws(() => aroundFrameForOperation({ ...project, stock: newProject().stock }, op), 'block stock rejected')
  throws(() => aroundFrameForOperation({ ...project, stock: Y_BAR }, op), 'mismatched axis rejected')
}

testFrames()
testSquareFrames()
testPoints()
testUnrolledProject()
testToolpaths()
testGenerationParity()
testSetups()
console.log('All Around frame tests passed.')
