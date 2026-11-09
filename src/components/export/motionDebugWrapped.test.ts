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
 * Tests for the 3D wrapped view's move conversion (issue #1179).
 *
 * The point of the view is that a rotary program is seen on the bar, so the
 * tests read a real exported program back and require the wrapped pieces to lie
 * on the bar at the angles the program commanded. They fail if the conversion
 * drops the angle (one piece, all at A0) or if the wrap stops subdividing a
 * turning move (one chord whose ends only touch the bar at A0 and A90).
 *
 * Run with: npx tsx src/components/export/motionDebugWrapped.test.ts
 */

import type { MachineOrigin, Operation, Project, RoundStock } from '../../types/project'
import { defaultTool, newProject, roundStock } from '../../types/project'
import { squareStock } from '../../types/barStock'
import {
  pinRotaryAxis,
  validateMachineDefinition,
  type MachineDefinition,
  type PinnedMachineDefinition,
} from '../../engine/gcode/types'
import { runPostProcessor } from '../../engine/gcode/postprocessor'
import { parseExportedMotion } from '../../engine/gcode/motionDebug'
import { parseGcodeMotion } from '../../engine/gcode/gcodeMotionParser'
import { normalizeToolForProject } from '../../engine/toolpaths/geometry'
import type { ToolpathMove, ToolpathPoint } from '../../engine/toolpaths/types'
import {
  angleRangeOfMoves,
  barOutline,
  buildWrappedMotion,
  exportedMotionMoves,
  filterWrappedPieces,
  wrapMoves,
} from './motionDebugWrapped'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}
function approx(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps
}

function grblDefinition(): MachineDefinition {
  return validateMachineDefinition({
    id: 'test-grbl',
    name: 'TestGRBL',
    description: 'Test GRBL controller',
    fileExtension: 'nc',
    coordinateSystem: { xAxis: 'X', yAxis: 'Y', zAxis: 'Z' },
    numberFormat: { decimalPlaces: { mm: 3, inch: 4 }, trailingZeros: false, leadingZero: true },
    units: { mmCommand: 'G21', inchCommand: 'G20' },
    program: { header: [], footer: [], commentPrefix: '(', commentSuffix: ')', lineNumbers: false, lineNumberIncrement: 10 },
    workCoordinates: { selectCommand: null },
    motion: { rapidCommand: 'G0', linearCommand: 'G1', cwArcCommand: 'G2', ccwArcCommand: 'G3', arcFormat: 'ij', modalMotion: true, arcInterpolation: true },
    feedSpeed: { feedCommand: 'F', rpmCommand: 'S', spindleOnCW: 'M3', spindleOnCCW: 'M4', spindleOff: 'M5', inlineWithMotion: true, modalFeedSpeed: true },
    toolChange: { commands: [], stopSpindleFirst: true, pauseAfterChange: false, pauseCommand: 'M0' },
    cannedCycles: null,
    coolant: null,
    stop: { programEndCommand: 'M30' },
  })
}

/** The grbl fixture plus a rotary axis about X, turning A (own) or Y (borrowed). */
function rotaryDefinition(drive: 'own' | 'borrowed'): MachineDefinition {
  const definition = grblDefinition()
  definition.rotary = { about: 'x', drive, reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } }
  return definition
}

const BAR_RADIUS = 10
const BAR_CENTRE = 10
/** A 20 mm round bar along X, its top at z=20 and its centreline at y=10. */
const BAR: RoundStock = roundStock(BAR_RADIUS * 2, 100, 'x')
const ORIGIN: MachineOrigin = { name: 'Origin', x: 0, y: 10, z: 20, visible: true }

function rotaryProject(): Project {
  const project = newProject('Rotary wrap', 'mm')
  project.stock = BAR
  project.origin = { ...ORIGIN }
  project.tools = [{ ...defaultTool('mm', 1), id: 't1', name: 'Test End Mill' }]
  return project
}

function rotaryOperation(): Operation {
  return {
    id: 'op-rotary',
    name: 'Rotary',
    description: '',
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'stock' },
    toolRef: 't1',
    stepdown: 1,
    stepover: 0.4,
    feed: 600,
    plungeFeed: 180,
    rpm: 12000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 1,
    maxCarveDepth: 1,
  }
}

function rpt(x: number, y: number, z: number, a: number): ToolpathPoint {
  return { x, y, z, a }
}

/**
 * A path on the bar's surface whose second cut turns the stock 90° while the
 * tool stays put at (x=0→10, y=10, z=20) — a helix on the part, which the
 * program writes as one inverse-time move.
 */
function turningMoves(): ToolpathMove[] {
  return [
    { kind: 'rapid', from: rpt(0, BAR_CENTRE, 30, 0), to: rpt(0, BAR_CENTRE, 30, 0) },
    { kind: 'plunge', from: rpt(0, BAR_CENTRE, 30, 0), to: rpt(0, BAR_CENTRE, 20, 0) },
    { kind: 'cut', from: rpt(0, BAR_CENTRE, 20, 0), to: rpt(10, BAR_CENTRE, 20, 90) },
    { kind: 'cut', from: rpt(10, BAR_CENTRE, 20, 90), to: rpt(20, BAR_CENTRE, 20, 90) },
    { kind: 'rapid', from: rpt(20, BAR_CENTRE, 20, 90), to: rpt(20, BAR_CENTRE, 30, 90) },
  ]
}

/** Export the fixture path and parse the program back in its own dialect. */
function exportAndParse(drive: 'own' | 'borrowed'): {
  parsed: ReturnType<typeof parseExportedMotion>
  definition: PinnedMachineDefinition
  gcode: string
} {
  const project = rotaryProject()
  const definition = rotaryDefinition(drive)
  const result = runPostProcessor({
    project,
    definition,
    operations: [{
      operation: rotaryOperation(),
      tool: normalizeToolForProject(project.tools[0], project),
      toolpath: { operationId: 'op-rotary', warnings: [], bounds: null, moves: turningMoves() },
    }],
    options: { emitToolChanges: false, emitCoolant: false, captureMotionTrace: true },
  })
  const pinned = pinRotaryAxis(definition, project.stock)
  return { parsed: parseExportedMotion(result.gcode, pinned), definition: pinned, gcode: result.gcode }
}

/**
 * A G93 program's turning move becomes 5° pieces that sit on the bar's radius
 * at the commanded angles (issue #1179).
 *
 * The program is the real export of the fixture path, so the angle also makes
 * the machine→project round trip: a turn the exporter wrote as A90 (or Y90 on a
 * borrowed motor) must come back as a 90° turn of the stock.
 */
function testTurningMoveWrapsAtTheCommandedAngles(): void {
  console.log('Testing a G93 turning move wraps onto the bar at the right angles (issue #1179)...')
  for (const drive of ['own', 'borrowed'] as const) {
    const { parsed, definition } = exportAndParse(drive)
    assert(parsed.moves.some((m) => m.inverseTimeFeed !== undefined),
      `${drive}: the exported program runs the turn in inverse time`)
    const moves = exportedMotionMoves(parsed, ORIGIN, definition)
    const turning = moves.find((m) => m.from.a !== undefined && m.to.a !== undefined && m.from.a !== m.to.a)
    assert(turning !== undefined, `${drive}: the turning cut survives the read-back`)
    assert(approx(turning!.from.a!, 0) && approx(turning!.to.a!, 90),
      `${drive}: the turn reads back as A0 -> A90, got ${turning!.from.a} -> ${turning!.to.a}`)

    const pieces = wrapMoves([turning!], BAR)
    // One piece per 5° of turn (MAX_WRAPPED_PIECE_TURN_DEGREES): 90° -> 18.
    // A dropped angle leaves one piece; a removed subdivision leaves one chord
    // whose ends alone touch the bar, which the angle checks below also catch.
    assert(pieces.length === 18, `${drive}: a 90° turn draws 18 pieces, got ${pieces.length}`)
    pieces.forEach((piece, index) => {
      for (const [end, endIndex] of [[piece.from, 0], [piece.to, 1]] as const) {
        // The tool tip rides the bar's surface: every drawn point is one radius
        // from the turning axis, at the angle the piece has reached.
        const across = end.y - BAR_CENTRE
        const up = end.z - BAR_CENTRE
        assert(approx(Math.hypot(across, up), BAR_RADIUS, 1e-6),
          `${drive}: piece ${index} ${endIndex === 0 ? 'start' : 'end'} is on the bar radius, got ${Math.hypot(across, up)}`)
        const angle = (Math.atan2(across, up) * 180) / Math.PI
        const expected = endIndex === 0 ? index * 5 : (index + 1) * 5
        assert(approx(angle, expected, 1e-6),
          `${drive}: piece ${index} ${endIndex === 0 ? 'start' : 'end'} is at A${expected}, got ${angle}`)
      }
    })
    // The readout repeats the angle the program commanded at each piece end.
    assert(pieces[0].aFrom === 0 && approx(pieces[0].aTo!, 5), `${drive}: first piece A0 -> A5`)
    assert(approx(pieces[17].aTo!, 90), `${drive}: last piece ends at A90`)

    // The program's own span covers the turn, so the readout's range does too.
    const range = angleRangeOfMoves(moves)
    assert(range !== null && range.min === 0 && range.max >= 90,
      `${drive}: the program's A span covers the turn, got ${JSON.stringify(range)}`)
  }
}

/** A plan program with no rotary word has nothing to wrap: no 3D view. */
function testAngleFreeProgramHasNoWrappedView(): void {
  console.log('Testing a flat program offers no wrapped view...')
  const definition = pinRotaryAxis(grblDefinition(), BAR)
  const parsed = parseGcodeMotion('G21\nG0 X0 Y0 Z5\nG1 X10 Y0 Z5 F100\nG1 X10 Y10 Z5', 'ij', '(', ')')
  assert(angleRangeOfMoves(exportedMotionMoves(parsed, ORIGIN, definition)) === null,
    'a flat program carries no angle')
  assert(buildWrappedMotion({
    parsed,
    origin: ORIGIN,
    definition,
    stock: BAR,
  }) === null, 'a flat program has no wrapped model')
}

/** The model's exported layer and span, which the dialog's toggle is gated on. */
function testWrappedModel(): void {
  console.log('Testing the wrapped model carries the exported layer and its A span...')
  const { parsed, definition } = exportAndParse('own')
  const model = buildWrappedMotion({
    parsed,
    origin: ORIGIN,
    definition,
    stock: BAR,
  })
  assert(model !== null, 'a rotary program has a wrapped model')
  assert(model!.layers.exported.length > 0, 'the exported layer has pieces')
  assert(model!.layers.generated.length === 0 && model!.layers.optimized.length === 0,
    'without a trace the source layers are simply empty')
  assert(model!.aRange !== null && model!.aRange.min === 0,
    `the span starts at the first commanded angle, got ${JSON.stringify(model!.aRange)}`)
}

/** An arc that turns the stock becomes chords with the angle interpolated. */
function testTurningArcBecomesChords(): void {
  console.log('Testing a turning arc becomes chords that carry the angle...')
  const definition = pinRotaryAxis(rotaryDefinition('own'), BAR)
  // A half circle from (0,0) to (10,0) about (5,0), turning the stock 90°.
  const parsed = parseGcodeMotion(
    'G21\nG0 X0 Y0 Z0 A0\nG1 X0 Y0 Z0 A0 F100\nG3 X10 Y0 I5 J0 A90 F100',
    'ij', '(', ')', { word: 'A', inverseTimeFeed: null },
  )
  const moves = exportedMotionMoves(parsed, ORIGIN, definition)
  const arcMoves = moves.filter((m) => m.from.a !== undefined)
  assert(arcMoves.length >= 37, `a 180° arc is at least 36 chords plus the move before it, got ${arcMoves.length}`)
  const first = arcMoves.find((m) => m.from.a !== undefined && m.from.a < 90)!
  assert(first.from.a !== undefined, 'the chords carry an angle')
  const last = arcMoves[arcMoves.length - 1]
  assert(approx(last.to.a!, 90), `the arc ends at A90, got ${last.to.a}`)
  // The machine arc is a half circle of radius 5 about (5, 0); its chords stay
  // on that circle, so the view draws the arc the program really runs.
  for (const move of arcMoves) {
    const radius = Math.hypot(move.to.x - 5, move.to.y - ORIGIN.y)
    assert(approx(radius, 5, 1e-6), `chord end lies on the arc, got radius ${radius}`)
  }
}

/**
 * The wrapped pieces carry the two fields the dialog's sidebar filters need
 * (review of #1179): the commanded (pre-wrap) Z level and whether the move cuts.
 *
 * The Z is deliberately the level the program commanded, not the wrapped point's
 * own z — wrapping turns the point about the bar, so the drawn z is a position
 * on the bar, never a cutting level.
 */
function testWrappedPiecesCarryTheSidebarFilters(): void {
  console.log('Testing the wrapped pieces carry the sidebar filters...')
  const pieces = wrapMoves(turningMoves(), BAR)
  const cutting = pieces.filter((piece) => piece.cutting)
  const rapids = pieces.filter((piece) => !piece.cutting)
  assert(cutting.length > 0 && rapids.length > 0, 'the fixture has both cutting and rapid pieces')
  assert(cutting.every((piece) => approx(piece.z, 20) || approx(piece.z, 30)),
    'cuts carry their commanded level')
  // The plunge starts at Z30 and the retract rapid at Z20: the level is the
  // move's start, exactly as the 2D segment's `z` is.
  assert(pieces.filter((piece) => piece.cutting && approx(piece.z, 30)).length > 0,
    'the plunge keeps the level it started at')
  assert(rapids.every((piece) => approx(piece.z, 20) || approx(piece.z, 30)),
    'rapids carry the level they started at')

  const level20 = filterWrappedPieces(pieces, 20, false)
  assert(level20.length > 0 && level20.every((piece) => piece.cutting && approx(piece.z, 20)),
    'the selected level draws only its own cutting pieces')
  const otherLevel = filterWrappedPieces(pieces, 25, false)
  assert(otherLevel.length === 0, 'a level with no moves draws nothing')
  assert(filterWrappedPieces(pieces, 'all', false).length === cutting.length,
    'all cutting levels hides the rapids')
  assert(filterWrappedPieces(pieces, 'all', true).length === pieces.length,
    'non-cutting moves brings the rapids back')
}

/** The faint reference outline follows the blank: round bar or square one. */
function testBarOutline(): void {  console.log('Testing the bar outline follows the blank...')
  const round = BAR
  const outline = barOutline(round)
  assert(outline.shape === 'round' && outline.axis === 'x', 'a round bar lies along x')
  assert(approx(outline.radius, BAR_RADIUS) && approx(outline.maxRadius, BAR_RADIUS),
    'a round bar has one radius')
  assert(approx(outline.centre, BAR_CENTRE) && approx(outline.pivotZ, BAR_RADIUS),
    'the pivot is the box centre')
  assert(approx(outline.alongMin, 0) && approx(outline.alongMax, 100), 'the outline spans the bar')

  const square = barOutline(squareStock(20, 80, 'y', { x: 0, y: 0 }))
  assert(square.shape === 'square' && square.axis === 'y', 'a square blank keeps its axis')
  assert(approx(square.radius, 10), 'the inscribed radius is half the side')
  assert(approx(square.maxRadius, 20 * Math.SQRT1_2), 'the corner radius is side × √½')
}

testTurningMoveWrapsAtTheCommandedAngles()
testAngleFreeProgramHasNoWrappedView()
testWrappedModel()
testTurningArcBecomesChords()
testWrappedPiecesCarryTheSidebarFilters()
testBarOutline()

console.log('motionDebugWrapped tests passed')
