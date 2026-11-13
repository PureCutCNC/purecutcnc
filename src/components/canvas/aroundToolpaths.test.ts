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
 * Which face's toolpaths the Sketch draws (issue #395 slice D2): a flat face
 * and the sheet share no plane, and an Around operation's wrapped path comes
 * back on the sheet.
 *
 * Mutations checked one at a time against these assertions:
 * - the face filter removed → "a Top toolpath is not drawn on Around" and "an
 *   Around toolpath is not drawn on Top" fail;
 * - the unwrap removed → "an Around path is drawn on the sheet" fails;
 * - the display cache removed → "the unwrapped result is the same object
 *   between frames" fails;
 * - a square blank refused by the bar guard, or unwrapped through the corner
 *   radius instead of the nominal `side / 2` frame → every square path
 *   assertion fails (#1016 C2-U1V).
 *
 * Run with: npx tsx src/components/canvas/aroundToolpaths.test.ts
 */

import { aroundFrame, wrapToolpath } from '../../engine/aroundFrame'
import { generateRotaryOperation } from '../../engine/toolpaths/rotaryOperation'
import { rotaryOperationFixture } from '../../test/rotaryOperationFixture'
import { squareStock } from '../../types/barStock'
import type { SquareStock } from '../../types/project'
import { DEFAULT_SETUP_ID, newProject, roundStock } from '../../types/project'
import type { MachiningSetup, Project, StockAxis } from '../../types/project'
import type { ToolpathMove, ToolpathResult } from '../../engine/toolpaths/types'
import { toolpathForActiveFace } from './aroundToolpaths'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

function near(actual: number, expected: number, message: string, epsilon = 1e-9): void {
  assert(Math.abs(actual - expected) <= epsilon, `${message}: ${actual} != ${expected}`)
}

const STOCK = roundStock(40, 200, 'x', { x: 10, y: 30 })
const AROUND_SETUP: MachiningSetup = {
  id: 'setup-around',
  name: 'Around',
  kind: 'around',
  orientation: { axis: 'x', angleDeg: 0 },
  indexing: 'manual',
  registration: [],
  notes: '',
  operationIds: [],
}
const BOTTOM_SETUP: MachiningSetup = {
  id: 'setup-bottom',
  name: 'Bottom',
  orientation: { axis: 'x', angleDeg: 180 },
  indexing: 'manual',
  registration: [],
  notes: '',
  operationIds: [],
}

function project(activeSetupId: string): Project {
  const base = newProject()
  return {
    ...base,
    stock: STOCK,
    setups: [...base.setups, AROUND_SETUP, BOTTOM_SETUP],
    activeSetupId,
    operations: [
      { id: 'op-top' } as Project['operations'][number],
      { id: 'op-around', setupId: 'setup-around' } as Project['operations'][number],
    ],
  }
}

/** A flat two-move path the around frame can wrap. */
function flatToolpath(): ToolpathResult {
  return {
    operationId: 'op-around',
    moves: [
      { kind: 'cut', from: { x: 20, y: 40, z: 10 }, to: { x: 60, y: 40, z: 10 } },
      { kind: 'cut', from: { x: 60, y: 40, z: 10 }, to: { x: 60, y: 90, z: 5 } },
    ],
    warnings: [],
    bounds: null,
  }
}

const frame = aroundFrame(STOCK)

// ── Around draws the unwrapped path ──────────────────────────

{
  const wrapped = wrapToolpath(flatToolpath(), frame)
  assert(wrapped.moves[0].from.y === frame.centre, 'the stored path is wrapped onto the centreline')
  assert(wrapped.moves[0].from.a !== undefined, 'the stored path carries its rotary angle')

  const drawn = toolpathForActiveFace(project('setup-around'), wrapped)
  assert(drawn !== null, 'an Around operation is drawn on Around')
  near(drawn!.moves[0].from.y, 40, 'the path comes back at its sheet across coordinate')
  near(drawn!.moves[0].from.z, 10, 'the path comes back at its sheet height')
  assert(drawn!.moves[0].from.a === undefined, 'a drawn path carries no rotary angle')
  const last = drawn!.moves[drawn!.moves.length - 1]
  near(last.to.y, 90, 'the last move ends at its sheet across coordinate')
  near(last.to.z, 5, 'the last move ends at its sheet height')

  assert(toolpathForActiveFace(project('setup-around'), wrapped) === drawn, 'the unwrapped result is the same object between frames')
}

// ── No cross-face drawing ────────────────────────────────────

{
  const wrapped = wrapToolpath(flatToolpath(), frame)
  assert(toolpathForActiveFace(project(DEFAULT_SETUP_ID), wrapped) === null, 'an Around toolpath is not drawn on Top')
  assert(toolpathForActiveFace(project('setup-bottom'), wrapped) === null, 'an Around toolpath is not drawn on Bottom')

  const topPath: ToolpathResult = { ...flatToolpath(), operationId: 'op-top' }
  assert(toolpathForActiveFace(project('setup-around'), topPath) === null, 'a Top toolpath is not drawn on Around')
  const drawnTop = toolpathForActiveFace(project(DEFAULT_SETUP_ID), topPath)
  assert(drawnTop === topPath, 'a Top toolpath is drawn as it is on Top')
  // Top and Bottom keep drawing each other's paths, muted (issue #947); only
  // the sheet is filtered out of a flat view.
  assert(toolpathForActiveFace(project('setup-bottom'), topPath) === topPath, 'a Top toolpath is still drawn on Bottom, as before')
}

// ── A path with no operation is left alone ───────────────────

{
  const orphan: ToolpathResult = { ...flatToolpath(), operationId: 'gone' }
  assert(toolpathForActiveFace(project('setup-around'), orphan) === orphan, 'a path whose operation is gone is left to the caller')
}

// ── A square blank draws on the nominal sheet ────────────────
//
// The drawn coordinates are checked against an oracle built from the frozen
// frame (#1016 C2-S3), not against the unwrap's own arithmetic: on the nominal
// reference cylinder flat across = zero + a · π · side / 360 and flat
// z = tool tip z − side / 2, with the Y blank keeping Y as the along
// coordinate. Mutations: the corner radius (12 · √½) in place of side / 2, or
// the physical perimeter 4 · side in place of π · side, move every one of
// these and fail; the square refused by the bar guard fails all of them too.

const SQUARE_X = squareStock(12, 30, 'x', { x: 0, y: 0 })
const SQUARE_Y = squareStock(12, 30, 'y', { x: 3, y: 5 })

/** The sheet coordinate the frozen frame maps a tool point to. */
function sheetOracle(
  point: { x: number; y: number; z: number; a?: number },
  stock: { axis: StockAxis; thickness: number },
  zero: number,
): { along: number; across: number; z: number } {
  assert(point.a !== undefined, 'the oracle only takes a wrapped point')
  const across = zero + point.a! * Math.PI * stock.thickness / 360
  return {
    along: stock.axis === 'x' ? point.x : point.y,
    across,
    z: point.z - stock.thickness / 2,
  }
}

function wrappedSquarePath(stock: { axis: StockAxis; thickness: number }, zero: number): ToolpathResult {
  // A tool on the blank's axis, 4 mm above it, through the turns the contract
  // names: the 45° corner, a negative turn, and a multi-turn negative one, so
  // the sign, the fractional angle and the never-reduced turn all have to be
  // right.
  const at = (along: number, a: number) => stock.axis === 'x'
    ? { x: along, y: zero, z: stock.thickness / 2 + 4, a }
    : { x: zero, y: along, z: stock.thickness / 2 + 4, a }
  const moves: ToolpathMove[] = [
    { kind: 'cut', from: at(6, 0), to: at(6, 180) },
    { kind: 'cut', from: at(6, 180), to: at(20, 90) },
    { kind: 'cut', from: at(20, 45), to: at(24, -45) },
    { kind: 'cut', from: at(24, -900), to: at(28, -45) },
  ]
  return { operationId: 'op-around', moves, warnings: [], bounds: null }
}

for (const [axis, stock] of [['x', SQUARE_X], ['y', SQUARE_Y]] as const) {
  const frame = aroundFrame(stock)
  const blank: Project = { ...project('setup-around'), stock }
  const source = wrappedSquarePath(stock, frame.zero)
  const drawn = toolpathForActiveFace(blank, source)
  assert(drawn !== null, `${axis}: a square blank's Around operation is drawn on Around`)
  const first = drawn!.moves[0].from
  const last = drawn!.moves[drawn!.moves.length - 1].to
  assert(first.a === undefined && last.a === undefined, `${axis}: a drawn square path carries no rotary angle`)
  const firstSheet = sheetOracle({ ...first, a: 0 }, stock, frame.zero)
  const lastSheet = sheetOracle({ ...last, a: -45 }, stock, frame.zero)
  near(axis === 'x' ? first.y : first.x, firstSheet.across, `${axis}: the drawn square start is on its sheet across coordinate`)
  near(axis === 'x' ? first.x : first.y, firstSheet.along, `${axis}: the drawn square start keeps its along coordinate`)
  near(axis === 'x' ? last.y : last.x, lastSheet.across, `${axis}: a negative turn lands on the negative side of the zero line`)
  assert((axis === 'x' ? last.y : last.x) < frame.zero, `${axis}: a negative turn is below the zero line, not mirrored onto it`)
  // The drawn height is the sheet height, the tool tip less the nominal radius.
  near(last.z, stock.thickness / 2 + 4 - stock.thickness / 2, `${axis}: the drawn square height is the sheet height`)
  // Every drawn move is the frozen frame's own sheet point for its source
  // point, checked one move at a time against the oracle rather than against
  // the unwrap's arithmetic.
  assert(drawn!.moves.length === source.moves.length, `${axis}: the wrap does not split an angle-free display path`)
  for (let index = 0; index < drawn!.moves.length; index += 1) {
    const expected = sheetOracle(source.moves[index].to, stock, frame.zero)
    const shown = drawn!.moves[index].to
    near(axis === 'x' ? shown.y : shown.x, expected.across, `${axis}: move ${index} across follows the nominal frame`)
    near(axis === 'x' ? shown.x : shown.y, expected.along, `${axis}: move ${index} along is preserved`)
    near(shown.z, expected.z, `${axis}: move ${index} height is preserved`)
  }
}

{
  // The result is still cached per wrapped object and frame, and the flat-face
  // filter is unchanged on a square blank.
  const frame = aroundFrame(SQUARE_X)
  const wrapped = wrappedSquarePath(SQUARE_X, frame.zero)
  const blank: Project = { ...project('setup-around'), stock: SQUARE_X }
  const drawn = toolpathForActiveFace(blank, wrapped)
  assert(drawn !== null, 'the square path draws')
  assert(toolpathForActiveFace(blank, wrapped) === drawn, 'the unwrapped square result is the same object between frames')
  assert(toolpathForActiveFace({ ...blank, activeSetupId: DEFAULT_SETUP_ID }, wrapped) === null,
    "a square blank's Around path is still not drawn on Top")
  // A round bar of the same physical box has the same nominal reference
  // cylinder, so it maps the very same wrapped points; what must not change is
  // the round path's own display, checked exactly in the #395 assertions above.
  const roundBlank: Project = { ...blank, stock: roundStock(12, 30, 'x') }
  const drawnRound = toolpathForActiveFace(roundBlank, wrapped)
  assert(drawnRound !== null, 'the round bar of the same box still draws')
  assert(JSON.stringify(drawnRound!.moves) === JSON.stringify(drawn!.moves),
    'the square and round mappings of the same nominal cylinder agree')
}

// ── The accepted generated square path draws on the nominal sheet ──
//
// The real thing: the accepted `generateRotaryOperation` output for an
// ordinary rotary rough/finish model on a square blank (#1016 C2-S3). The
// production dispatch on this base still refuses square — the S3 test keeps
// asserting that — and this slice does not enable it; the view is exercised
// through the engine seam it will consume once the guards land.

function generatedSquarePath(axis: StockAxis, kind: 'rotary_rough' | 'rotary_finish'): { project: Project; result: ToolpathResult } {
  const fixture = rotaryOperationFixture(axis, kind)
  const stock = squareStock(fixture.stock.thickness, 30, axis, { x: 0, y: 0 })
  const blank: Project = { ...fixture, stock }
  return { project: blank, result: generateRotaryOperation(blank, blank.operations[0]) }
}

for (const axis of ['x', 'y'] as const) {
  for (const kind of ['rotary_rough', 'rotary_finish'] as const) {
    const { project: blank, result } = generatedSquarePath(axis, kind)
    assert(result.moves.length > 0, `${axis} ${kind}: the generated square path is nonempty`)
    const stock = blank.stock as SquareStock
    const frame = aroundFrame(stock)
    const drawn = toolpathForActiveFace(blank, result)
    assert(drawn !== null, `${axis} ${kind}: the generated square path draws on Around`)
    assert(drawn!.moves.length === result.moves.length, `${axis} ${kind}: the pass count is preserved`)
    // Every drawn point is the frozen frame's sheet point for its own tool
    // point: the transform preserves the along, the sign of the turn and the
    // true pivot rather than shifting to a corner.
    for (let index = 0; index < drawn!.moves.length; index += 137) {
      const source = result.moves[index]
      const shown = drawn!.moves[index]
      assert(shown.from.a === undefined && shown.to.a === undefined, `${axis} ${kind}: drawn points carry no angle`)
      const from = sheetOracle(source.from, stock, frame.zero)
      near(axis === 'x' ? shown.from.y : shown.from.x, from.across, `${axis} ${kind}: drawn across follows the nominal frame`)
      near(axis === 'x' ? shown.from.x : shown.from.y, from.along, `${axis} ${kind}: drawn along is preserved`)
      near(shown.from.z, from.z, `${axis} ${kind}: drawn height is preserved`)
    }
    // Round trip: wrapping the drawn path back returns the generated path's own
    // sheet coordinates, so the display is the exact inverse it claims to be.
    const back = wrapToolpath(drawn!, frame)
    for (let index = 0; index < back.moves.length; index += 251) {
      const backAngle = back.moves[index].from.a
      const sourceAngle = result.moves[index].from.a
      // The wrap has to put the angle back; assert it is there rather than
      // defaulting, so a lost angle fails instead of being rounded to zero.
      assert(backAngle !== undefined && sourceAngle !== undefined,
        `${axis} ${kind}: the round trip recovers an angle`)
      near(backAngle, sourceAngle, `${axis} ${kind}: the round trip recovers the angle`)
      near(back.moves[index].from.z, result.moves[index].from.z, `${axis} ${kind}: the round trip recovers the tool height`)
    }
  }
}

console.log('aroundToolpaths: all assertions passed')
