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
 * Plasma cut order (issue #958): inside contours first, part by part,
 * nearest next from the machine origin, with a preference for travel that
 * does not pass over a piece already cut loose.
 *
 * Two halves. The first drives `plasmaOrder.ts` with hand-placed rings and
 * pierce points, so each rule is pinned on geometry chosen to separate it
 * from the others. The second drives the real generator, where the claim is
 * different: ordering changes the sequence and nothing else.
 *
 * Mutations these are written to fail under, each run by hand: children
 * emitted after their parent; nearest-next replaced by selection order; the
 * part grouping replaced by one sheet-wide nearest-ready choice; the travel
 * preference removed; its "piece being left" exemption removed; the origin
 * ignored for the first cut; the bounding-box prefilter removed; the
 * generator ignoring the order; the cross-operation warning removed.
 *
 * Run with: npx tsx src/engine/toolpaths/plasmaOrder.test.ts
 */

import assert from 'node:assert/strict'
import type { Operation, Point, Project, SketchFeature, SketchProfile } from '../../types/project'
import { defaultTool, newProject } from '../../types/project'
import { defaultPlasmaTool } from '../../toolPolicy'
import { projectWithFeatures } from '../../test/projectFixtures'
import { exportPlasma, PLASMA_EXPORT_SCENARIOS } from '../../test/plasmaExportFixtures'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { computeOperationToolpath } from './generateOperation'
import { generatePlasmaProfileToolpath } from './plasma'
import { distanceToContour } from './plasmaGeometry'
import { orderPlasmaCuts, outlinesEnclosingLaterCuts, plasmaContainmentParents } from './plasmaOrder'
import type { PlasmaOrderContour, PlasmaOrderStats } from './plasmaOrder'
import type { ToolpathMove, ToolpathResult } from './types'
import { warningSeverity } from './warningCodes'

// Every case runs, so one broken rule shows every assertion it breaks.
const failures: string[] = []
function test(name: string, body: () => void): void {
  try { body() } catch (error) {
    failures.push(name)
    console.log(`   ✗ ${name}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }
}

// ── Part 1: the ordering module on hand-placed contours ─────────────────────

const ring = (x: number, y: number, w: number, h = w): Point[] =>
  [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }]
/** A contour that pierces and ends at one point, unless an end is given. */
const contour = (points: Point[], pierce: Point, end: Point = pierce): PlasmaOrderContour => ({ ring: points, pierce, end })
const at = (x: number, y: number): Point => ({ x, y })
const ORIGIN = at(0, 0)

/** Order by name, so an assertion reads as the sequence the torch follows. */
function sequence(named: Record<string, PlasmaOrderContour>, origin = ORIGIN, stats?: PlasmaOrderStats): string[] {
  const names = Object.keys(named)
  return orderPlasmaCuts(names.map((name) => named[name]), origin, stats).map((index) => names[index])
}

// Holes before the outline, although the outline is selected first. The holes
// are selected nearest first, so only containment can move the outline.
test('holes before the outline', () => {
  assert.deepEqual(sequence({
    outline: contour(ring(0, 0, 100), at(-5, 50)),
    near: contour(ring(10, 10, 20), at(20, 20)),
    far: contour(ring(60, 60, 20), at(70, 70)),
  }), ['near', 'far', 'outline'], 'holes are cut before the outline that frees the part')
})

// A hole inside a part inside a frame: innermost first, at every depth.
test('a hole inside a part inside a frame', () => {
  assert.deepEqual(sequence({
    frame: contour(ring(0, 0, 200), at(-5, 100)),
    part: contour(ring(50, 50, 100), at(45, 100)),
    hole: contour(ring(80, 80, 20), at(90, 90)),
  }), ['hole', 'part', 'frame'], 'a hole in a part in a frame is cut hole, part, frame')
})

// A part sitting in another part's hole. The inner part and its own hole go
// first, then the hole it sits in, and the outer outline last. `corner` is a
// second hole of the outer part, nearer the origin than anything else: it is
// cut first, and the inner part is still finished before the outer outline.
test('a part inside another part\'s hole', () => {
  const order = sequence({
    outer: contour(ring(0, 0, 200), at(-5, 100)),
    window: contour(ring(40, 40, 120), at(50, 100)),
    inner: contour(ring(60, 60, 80), at(57, 100)),
    innerHole: contour(ring(90, 90, 20), at(100, 100)),
    corner: contour(ring(5, 5, 20), at(15, 15)),
  })
  assert.deepEqual(order, ['corner', 'innerHole', 'inner', 'window', 'outer'], 'inner part, then the hole it sits in, then the outer outline')
})

// A nested sheet is cut part by part. After part A's two holes the nearest
// pierce on the sheet is part B's first hole (50 away); A's own outline
// pierces 90 away, on its far side. A sheet-wide nearest choice would leave A
// unfinished and start on B.
test('a nested sheet is cut part by part', () => {
  const nest = {
    a: contour(ring(0, 0, 100), at(-10, 50)),
    b: contour(ring(110, 0, 100), at(220, 50)),
    a1: contour(ring(10, 40, 20), at(20, 50)),
    b1: contour(ring(120, 40, 20), at(130, 50)),
    a2: contour(ring(70, 40, 20), at(80, 50)),
    b2: contour(ring(180, 40, 20), at(190, 50)),
  }
  const order = sequence(nest)
  assert.deepEqual(order, ['a1', 'a2', 'a', 'b1', 'b2', 'b'], 'part A is finished, outline included, before part B starts')
  const firstB = order.findIndex((name) => name.startsWith('b'))
  assert.ok(order.slice(firstB).every((name) => name.startsWith('b')), 'no contour of part A after part B has started')
})

// Nearest next among holes: the first selected is also the nearest to the
// origin, and the rest are selected out of sequence but cut as a chain.
test('nearest next among holes', () => {
  assert.deepEqual(sequence({
    outline: contour(ring(0, 0, 100), at(-5, 50)),
    h1: contour(ring(10, 40, 20), at(20, 50)),
    h3: contour(ring(70, 40, 20), at(80, 50)),
    h2: contour(ring(40, 40, 20), at(50, 50)),
  }), ['h1', 'h2', 'h3', 'outline'], 'holes are cut nearest next, not in selection order')
})

// Nearest next among parts, measured from where the previous cut ended: each
// part ends on its right edge, so the chain runs left to right.
test('nearest next among parts', () => {
  assert.deepEqual(sequence({
    p1: contour(ring(0, 0, 20), at(-2, 10), at(22, 10)),
    p3: contour(ring(80, 0, 20), at(78, 10), at(102, 10)),
    p2: contour(ring(40, 0, 20), at(38, 10), at(62, 10)),
  }), ['p1', 'p2', 'p3'], 'parts are cut nearest next, not in selection order')
})
// The distance is taken from the end of the previous cut, not from its pierce:
// `left` ends over on the right, which makes `right` the nearer next part.
test('nearest is measured from the end of the previous cut', () => {
  assert.deepEqual(sequence({
    left: contour(ring(0, 0, 20), at(-2, 10), at(60, -5)),
    middle: contour(ring(30, 0, 20), at(28, 10)),
    right: contour(ring(70, 0, 20), at(68, 10)),
  }), ['left', 'right', 'middle'], 'nearest is measured from where the torch finished')
})

// The first cut is the one nearest the machine origin, wherever that is.
test('the first cut is nearest the origin', () => {
  const row = {
    left: contour(ring(0, 0, 20), at(-2, 10)),
    middle: contour(ring(40, 0, 20), at(38, 10)),
    right: contour(ring(80, 0, 20), at(78, 10)),
  }
  assert.equal(sequence(row, at(0, 0))[0], 'left', 'origin at the left: leftmost part first')
  assert.equal(sequence(row, at(120, 0))[0], 'right', 'origin at the right: rightmost part first')
  assert.deepEqual(sequence(row, at(120, 0)), ['right', 'middle', 'left'])
  assert.equal(sequence(row, at(45, 10))[0], 'middle', 'origin in the middle: middle part first')
})

// Ties follow the selection order: two parts exactly as far from the torch.
test('ties follow the selection order', () => {
  const p = contour(ring(5, -5, 10), at(4, 0))
  const q = contour(ring(-15, -5, 10), at(-4, 0))
  assert.deepEqual(sequence({ p, q }), ['p', 'q'], 'tie: first selected wins')
  assert.deepEqual(sequence({ q, p }), ['q', 'p'], 'tie: first selected wins, the other way round')
  // Clipper rounds pierce points to its grid, so "equal" distances differ by
  // noise far below it. That noise must not decide: `second` is nearer by a
  // hundredth of a grid step and still comes second.
  const first = contour(ring(5, -5, 10), at(4.000001, 0))
  const second = contour(ring(-15, -5, 10), at(-4, 0))
  assert.deepEqual(sequence({ first, second }), ['first', 'second'], 'a sub-grid difference is a tie')
  // A real difference is not a tie.
  assert.deepEqual(sequence({ first: contour(ring(5, -5, 10), at(4.01, 0)), second }), ['second', 'first'])
})

// The travel preference. `wall` is cut first and the torch ends on its left.
// `behind` is the nearer part but a straight rapid to it passes over `wall`,
// now loose; `clear` is farther and reached without crossing anything.
const wall = contour(ring(40, -50, 20, 100), at(35, 0))
const behind = contour(ring(70, -5, 10), at(68, 0))
const clear = contour(ring(-20, -5, 10), at(-8, 0))
test('travel preference: a clear travel is taken over a nearer one across a cut-out part', () => {
  assert.deepEqual(sequence({ wall, behind, clear }, at(30, 0)), ['wall', 'clear', 'behind'], 'the farther part is taken when the nearer one lies across a cut-out part')
})
test('travel preference: when every travel crosses, the nearest is taken', () => {
  const alsoBehind = contour(ring(70, 20, 10), at(68, 25))
  assert.deepEqual(sequence({ wall, alsoBehind, behind }, at(30, 0)), ['wall', 'behind', 'alsoBehind'], 'when every travel crosses a cut-out part, the nearest is taken')
})
test('travel preference: nothing is avoided that is not crossed', () => {
  // `near` is the nearer of two clear choices and is selected last.
  const near = contour(ring(15, 20, 10), at(20, 18))
  assert.deepEqual(sequence({ wall, clear, near }, at(30, 0)), ['wall', 'near', 'clear'])
  // Passing a cut-out part's corner is not passing over it: the rapid to
  // `pastCorner` runs through the wall's bounding box and misses the wall.
  const tall = contour(ring(40, -50, 20, 100), at(35, 45))
  const pastCorner = contour(ring(45, 78, 10), at(50, 75))
  const away = contour(ring(-15, 40, 10), at(-4, 45))
  assert.deepEqual(sequence({ tall, away, pastCorner }, at(30, 45)), ['tall', 'pastCorner', 'away'], 'a travel that only passes the corner is not a crossing')
})
// The piece the torch has just cut is not an obstacle to leaving it. After
// `h1` the torch is inside h1's slug, so every way out crosses h1. If that
// counted, every choice would "cross" and the nearest, `h2`, would be taken;
// h2 lies beyond `h0`, already cut, and `h3` is the clear choice.
test('travel preference: leaving the piece just cut is not a crossing', () => {
  assert.deepEqual(sequence({
    plate: contour(ring(-40, -40, 120, 80), at(-45, 0)),
    h0: contour(ring(-5, -5, 10), at(0, 0)),
    h1: contour(ring(10, -5, 10), at(15, 0)),
    h2: contour(ring(-25, -5, 10), at(-20, 0)),
    h3: contour(ring(50, -5, 10), at(55, 0)),
  }), ['h0', 'h1', 'h3', 'h2', 'plate'], 'leaving the hole just cut does not count as crossing a loose piece')
})

test('degenerate input and the containment tree', () => {
  // Nothing, one contour, and twins that must not form a cycle.
  assert.deepEqual(orderPlasmaCuts([], ORIGIN), [])
  assert.deepEqual(orderPlasmaCuts([contour(ring(0, 0, 10), at(-2, 5))], ORIGIN), [0])
  assert.deepEqual(plasmaContainmentParents([ring(0, 0, 10), ring(0, 0, 10)]), [-1, -1], 'identical contours do not enclose each other')
  assert.deepEqual(orderPlasmaCuts([contour(ring(0, 0, 10), at(-2, 5)), contour(ring(0, 0, 10), at(-2, 5))], ORIGIN), [0, 1])
  // The immediate parent is the smallest enclosing contour, whatever the listing order.
  assert.deepEqual(plasmaContainmentParents([ring(80, 80, 20), ring(0, 0, 200), ring(50, 50, 100)]), [2, -1, 1])
  // Overlapping without enclosing is not containment.
  assert.deepEqual(plasmaContainmentParents([ring(0, 0, 50), ring(40, 40, 50)]), [-1, -1])
})

// A 200-part nest, two holes each, is ordered with about one ring test per
// contour: a hole is tested against its own part and nothing else, a part
// against nothing. Counted, not timed. Without the bounding-box prefilter the
// same nest costs one test per pair of different size.
test('a 200-part nest orders cheaply', () => {
  const nest: PlasmaOrderContour[] = []
  const partOf: number[] = []
  for (let row = 0; row < 10; row += 1) {
    for (let column = 0; column < 20; column += 1) {
      const x = column * 60, y = row * 60, part = nest.length
      nest.push(contour(ring(x, y, 50), at(x - 3, y + 25)))
      nest.push(contour(ring(x + 8, y + 15, 12), at(x + 14, y + 21)))
      nest.push(contour(ring(x + 30, y + 15, 12), at(x + 36, y + 21)))
      partOf.push(part, part, part)
    }
  }
  const stats: PlasmaOrderStats = { containmentTests: 0 }
  const order = orderPlasmaCuts(nest, ORIGIN, stats)
  assert.equal(nest.length, 600)
  assert.equal(stats.containmentTests, 400, 'one containment test per hole, none per part')
  assert.deepEqual([...order].sort((a, b) => a - b), nest.map((_, index) => index), 'every contour is cut exactly once')
  // Part by part: 200 runs of three, each ending on its outline.
  for (let i = 0; i < order.length; i += 3) {
    const run = order.slice(i, i + 3)
    assert.ok(run.every((index) => partOf[index] === partOf[run[0]]), 'a part is finished before the next starts')
    assert.equal(run[2], partOf[run[0]], 'the outline is the last cut of its part')
  }
  // The same nest inside one frame still costs one test per contour.
  const framed: PlasmaOrderStats = { containmentTests: 0 }
  const framedOrder = orderPlasmaCuts([...nest, contour(ring(-20, -20, 1250, 650), at(-25, 300))], ORIGIN, framed)
  assert.equal(framed.containmentTests, 600, 'a frame adds one test per part, and the holes still find their part first')
  assert.equal(framedOrder.at(-1), 600, 'the frame is cut last')
})

test('the cross-operation check, as geometry', () => {
  assert.deepEqual(outlinesEnclosingLaterCuts([ring(0, 0, 100), ring(200, 0, 100)], [ring(220, 20, 20)]), [1])
  assert.deepEqual(outlinesEnclosingLaterCuts([ring(0, 0, 100), ring(200, 0, 100)], []), [])
  assert.deepEqual(outlinesEnclosingLaterCuts([ring(0, 0, 100)], [ring(150, 0, 20)]), [], 'a later cut beside the outline is no problem')
  assert.deepEqual(outlinesEnclosingLaterCuts([ring(10, 10, 20)], [ring(0, 0, 100)]), [], 'a later cut around this one is the right order')
  assert.deepEqual(outlinesEnclosingLaterCuts([ring(0, 0, 100)], [ring(0, 0, 100)]), [], 'the same contour again is not something inside it')
})

// ── Part 2: the generator ───────────────────────────────────────────────────

function rectangle(x: number, y: number, w: number, h = w): SketchProfile {
  return { start: { x, y }, segments: [
    { type: 'line', to: { x: x + w, y } }, { type: 'line', to: { x: x + w, y: y + h } },
    { type: 'line', to: { x, y: y + h } }, { type: 'line', to: { x, y } },
  ], closed: true }
}
interface Shape { id: string; operation: SketchFeature['operation']; box: [number, number, number, number] }
const add = (id: string, x: number, y: number, w: number, h = w): Shape => ({ id, operation: 'add', box: [x, y, w, h] })
const subtract = (id: string, x: number, y: number, w: number, h = w): Shape => ({ id, operation: 'subtract', box: [x, y, w, h] })
function sheet(shapes: Shape[], origin = ORIGIN): Project {
  const project = newProject('Plasma order', 'mm')
  project.stock.thickness = 6
  project.origin = { ...project.origin, x: origin.x, y: origin.y }
  project.tools = [{ ...defaultPlasmaTool('mm'), id: 'torch', name: 'Torch', diameter: 2, cutHeight: 1.5, defaultFeed: 2200 }, defaultTool('mm')]
  return projectWithFeatures(project, shapes.map((shape): SketchFeature => ({
    id: shape.id, name: shape.id, kind: 'rect', operation: shape.operation, folderId: null, visible: true, locked: false, z_top: 6, z_bottom: 0,
    sketch: { profile: rectangle(...shape.box), dimensions: [], constraints: [], origin: { x: 0, y: 0 }, orientationAngle: 0 },
  })))
}
function plasmaOp(project: Project, featureIds: string[], patch: Partial<Operation> = {}): Operation {
  return { ...defaultOperationForTarget(project, 'plasma_profile', 'rough', { source: 'features', featureIds }, 0), ...patch }
}
/** One block per cut: the pierce plunge through to the retract that follows the torch-off. */
function cutBlocks(result: ToolpathResult): ToolpathMove[][] {
  const blocks: ToolpathMove[][] = []
  for (const move of result.moves) {
    if (move.kind === 'plunge') blocks.push([])
    else if (blocks.length === 0 || blocks.at(-1)!.at(-1)?.kind === 'rapid') continue // the travel between two cuts
    blocks.at(-1)!.push(move)
  }
  return blocks
}
/** Which drawn contour a block cuts: the one its kerf centreline runs half a kerf from. */
function cutOrder(shapes: Shape[], result: ToolpathResult): string[] {
  return cutBlocks(result).map((block) => {
    const start = block.find((move) => move.kind === 'cut')!.from
    const owner = shapes.find((shape) => Math.abs(distanceToContour(start, ring(...shape.box)) - 1) < 1e-6)
    assert.ok(owner, 'every cut block follows one drawn contour at half a kerf')
    return owner.id
  })
}
const codes = (result: ToolpathResult): string[] => result.warnings.map((warning) => warning.code)

// A part in a frame's window, with a hole of its own: four levels of nesting
// through the real generator, selected outermost first.
const NESTED = [add('frame', 0, 0, 200), subtract('window', 20, 20, 160), add('part', 60, 60, 80), subtract('hole', 85, 85, 30)]
test('generator: a part in a frame\'s window is cut innermost first', () => {
  const project = sheet(NESTED)
  const result = generatePlasmaProfileToolpath(project, plasmaOp(project, ['frame', 'window', 'part', 'hole']))
  assert.deepEqual(codes(result), [], 'the nested fixture cuts without a warning')
  assert.deepEqual(cutOrder(NESTED, result), ['hole', 'part', 'window', 'frame'], 'generator: innermost first, the frame last')
  // The same through the dispatch the application calls.
  const dispatched = computeOperationToolpath(project, plasmaOp(project, ['frame', 'window', 'part', 'hole']))!.result
  assert.deepEqual(cutOrder(NESTED, dispatched), ['hole', 'part', 'window', 'frame'])
})

// Two parts with two holes each, selected outlines first and interleaved.
const TWO_PARTS = [
  add('a', 20, 20, 100, 60), subtract('a1', 30, 35, 30), subtract('a2', 80, 35, 30),
  add('b', 150, 20, 100, 60), subtract('b1', 160, 35, 30), subtract('b2', 210, 35, 30),
]
const INTERLEAVED = ['a', 'b', 'a1', 'b1', 'a2', 'b2']
test('generator: two parts with holes are cut part by part', () => {
  const project = sheet(TWO_PARTS)
  const order = cutOrder(TWO_PARTS, generatePlasmaProfileToolpath(project, plasmaOp(project, INTERLEAVED)))
  assert.equal(order.length, 6)
  assert.deepEqual(order.map((id) => id[0]), ['a', 'a', 'a', 'b', 'b', 'b'], 'generator: part A complete before part B')
  assert.equal(order[2], 'a', 'each outline closes its part')
  assert.equal(order[5], 'b')
})
// The machine origin decides where cutting starts: moved to the right-hand
// end of the sheet, the same selection starts with part B.
test('generator: the first cut is nearest the machine origin', () => {
  const fromRight = sheet(TWO_PARTS, at(270, 50))
  const reversed = cutOrder(TWO_PARTS, generatePlasmaProfileToolpath(fromRight, plasmaOp(fromRight, INTERLEAVED)))
  assert.deepEqual(reversed.map((id) => id[0]), ['b', 'b', 'b', 'a', 'a', 'a'], 'generator: the first cut is nearest the machine origin')
  assert.equal(reversed[0], 'b2')
})

// Ordering never changes a cut. Each contour generated on its own gives the
// block it must have; the multi-contour program is exactly those blocks, in
// some order, joined by one safe-height rapid each. Kerf side, direction,
// start point, leads and pierce are all inside the block.
for (const [label, shapes, selection] of [['nested', NESTED, ['frame', 'window', 'part', 'hole']], ['two parts', TWO_PARTS, INTERLEAVED]] as const) test(`generator: every cut block is the one its contour has on its own (${label})`, () => {
  const project = sheet([...shapes])
  const together = generatePlasmaProfileToolpath(project, plasmaOp(project, [...selection]))
  const alone = new Map(selection.map((id) => {
    const single = generatePlasmaProfileToolpath(project, plasmaOp(project, [id]))
    assert.equal(cutBlocks(single).length, 1)
    assert.deepEqual(single.moves, cutBlocks(single)[0], 'a single contour is one block and no travel')
    return [id, JSON.stringify(cutBlocks(single)[0])]
  }))
  const blocks = cutBlocks(together)
  const order = cutOrder([...shapes], together)
  assert.equal(blocks.length, selection.length)
  blocks.forEach((block, index) => assert.equal(JSON.stringify(block), alone.get(order[index]), `${order[index]}: the block is the one this contour has on its own`))
  // What is left is the travel: one rapid per gap, at safe height, from where
  // the previous block retracted to above the next pierce.
  const travel = together.moves.filter((move) => !blocks.some((block) => block.includes(move)))
  assert.equal(travel.length, selection.length - 1)
  travel.forEach((move, index) => {
    assert.equal(move.kind, 'rapid')
    assert.deepEqual(move.from, blocks[index].at(-1)!.to, 'travel starts where the previous cut retracted')
    assert.deepEqual(move.to, blocks[index + 1][0].from, 'travel ends above the next pierce')
    assert.equal(move.from.z, move.to.z, 'travel stays at safe height')
  })
  // And the selection order is not an input to the sequence here: any
  // listing of the same contours gives the same program.
  const relisted = generatePlasmaProfileToolpath(project, plasmaOp(project, [...selection].reverse()))
  assert.deepEqual(relisted.moves, together.moves, 'the same contours listed in another order cut identically')
})

// The shared export fixtures, which the QtPlasmaC simulator and the Grbl
// conformance corpus also run. Their programs no longer depend on how the
// scenario lists its contours.
test('export fixtures: the program does not depend on the listing order', () => {
  for (const machineId of ['qtplasmac', 'grbl-plasma']) {
    for (const name of ['part-with-holes', 'nested-sheet', 'small-hole']) {
      const spec = { ...PLASMA_EXPORT_SCENARIOS[name](), machineId }
      const relisted = { ...spec, operations: spec.operations.map((operation) => ({ ...operation, featureIds: [...operation.featureIds].reverse() })) }
      assert.equal(exportPlasma(relisted).result.gcode, exportPlasma(spec).result.gcode, `${name} on ${machineId}: same program for the reversed listing`)
    }
  }
  // Part with holes: both holes, then the plate. The plate's block is the one
  // whose cut spans the whole 120 x 80 plate.
  const span = (block: ToolpathMove[]): number => {
    const xs = block.filter((move) => move.kind === 'cut').map((move) => move.from.x)
    return Math.max(...xs) - Math.min(...xs)
  }
  const holed = cutBlocks(exportPlasma(PLASMA_EXPORT_SCENARIOS['part-with-holes']()).input.operations[0].toolpath)
  assert.deepEqual(holed.map((block) => span(block) > 100), [false, false, true], 'part with holes: hole, hole, outline')
  // Nested sheet: the machine origin is at the bottom-left of the sheet, so
  // part-c (the lower row, project Y 80-120) is nearest and is cut first.
  const nested = cutBlocks(exportPlasma(PLASMA_EXPORT_SCENARIOS['nested-sheet']()).input.operations[0].toolpath)
  const rowAndColumn = nested.map((block) => { const start = block.find((move) => move.kind === 'cut')!.from; return `${start.y > 70 ? 'lower' : 'upper'}-${start.x > 90 ? 'right' : 'left'}` })
  assert.deepEqual(rowAndColumn, ['lower-left', 'upper-left', 'upper-right'], 'nested sheet: part-c, part-a, part-b')
})

// Per-contour warnings still come out in selection order, whatever order the
// contours are cut in: they are raised while each contour is resolved.
test('generator: per-contour warnings stay in selection order', () => {
  const shapes = [add('plate', 20, 20, 160, 80), subtract('tiny', 40, 50, 8), subtract('mid', 120, 45, 14)]
  const project = sheet(shapes)
  const selection = ['plate', 'mid', 'tiny']
  const result = generatePlasmaProfileToolpath(project, plasmaOp(project, selection))
  assert.equal(cutOrder(shapes, result).at(-1), 'plate')
  const expected = selection.flatMap((id) => generatePlasmaProfileToolpath(project, plasmaOp(project, [id])).warnings)
  assert.ok(expected.length >= 3, 'the fixture raises warnings on both holes')
  assert.deepEqual(result.warnings, expected, 'warnings are those of each contour, in selection order')
})

// The cross-operation warning: outlines in one operation, their holes in a later one.
const WARNING = 'plasmaOutlineBeforeHole'
const OPS_SHAPES = [add('plate', 20, 20, 100, 60), subtract('h1', 30, 35, 30), subtract('h2', 80, 35, 30), add('other', 150, 20, 60)]
const base = sheet(OPS_SHAPES)
const outlines = plasmaOp(base, ['plate', 'other'], { id: 'outlines', name: 'Outlines' })
const holes = plasmaOp(base, ['h1', 'h2'], { id: 'holes', name: 'Holes' })
const withOps = (operations: Operation[]): Project => ({ ...base, operations })
const warns = (project: Project, operation: Operation): boolean => codes(generatePlasmaProfileToolpath(project, operation)).includes(WARNING)

test('warning: outlines in operation 1, their holes in operation 2', () => {
  assert.equal(warningSeverity(WARNING), 'warning', 'a warning, not an export block')
  const wrongOrder = generatePlasmaProfileToolpath(withOps([outlines, holes]), outlines)
  assert.deepEqual(
    wrongOrder.warnings.filter((warning) => warning.code === WARNING),
    [{ code: WARNING, params: { name: 'plate', operation: 'Holes' } }],
    'the outline whose holes are cut later is named once, with the operation that cuts them; the part with no holes is not',
  )
  assert.equal(cutBlocks(wrongOrder).length, 2, 'the warning does not stop the cut')
  assert.deepEqual(codes(computeOperationToolpath(withOps([outlines, holes]), outlines)!.result).filter((code) => code === WARNING), [WARNING], 'the dispatch carries it')
  // The later operation itself has nothing to say.
  assert.ok(!warns(withOps([outlines, holes]), holes))
  // One hole here and one later: the later one still means a loose part.
  const partly = plasmaOp(base, ['plate', 'h1'], { id: 'partly', name: 'Partly' })
  assert.ok(warns(withOps([partly, holes]), partly), 'a hole left to a later operation is warned even when another is cut here')
  // Two later operations inside one outline: one warning, naming the first.
  const h2Only = plasmaOp(base, ['h2'], { id: 'h2-only', name: 'Second hole' })
  const h1Only = plasmaOp(base, ['h1'], { id: 'h1-only', name: 'First hole' })
  assert.deepEqual(
    generatePlasmaProfileToolpath(withOps([outlines, h1Only, h2Only]), outlines).warnings.filter((warning) => warning.code === WARNING),
    [{ code: WARNING, params: { name: 'plate', operation: 'First hole' } }],
  )
})
test('warning: absent when the holes are cut first', () => {
  assert.ok(!warns(withOps([holes, outlines]), outlines), 'no warning when the holes are cut first')
})
test('warning: absent when the holes are not cut at all', () => {
  assert.ok(!warns(withOps([outlines]), outlines), 'no warning when the holes are not cut at all')
  // An operation that is not in the project has no "later".
  assert.ok(!warns(base, outlines))
})
test('warning: only a later, enabled plasma operation of the same setup counts', () => {
  // A disabled operation cuts nothing.
  assert.ok(!warns(withOps([outlines, { ...holes, enabled: false }]), outlines), 'no warning for a disabled later operation')
  // Another setup is another program.
  assert.ok(!warns(withOps([outlines, { ...holes, setupId: 'another-setup' }]), outlines), 'no warning across setups')
  // Only a plasma operation cuts the sheet through.
  assert.ok(!warns(withOps([outlines, { ...holes, kind: 'pocket' }]), outlines), 'no warning for a later milling operation')
})
test('warning: absent for holes this operation cuts itself', () => {
  // They are cut first here, whatever comes later.
  const everything = plasmaOp(base, ['plate', 'h1', 'h2'], { id: 'everything', name: 'Everything' })
  assert.ok(!warns(withOps([everything, holes]), everything), 'no warning when this operation cuts the holes too')
})

if (failures.length > 0) {
  console.log(`plasma cut order: ${failures.length} case(s) FAILED`)
  process.exit(1)
}
console.log('plasma cut order: containment, part grouping, nearest next, origin, ties, travel preference, block identity and the cross-operation warning passed')
