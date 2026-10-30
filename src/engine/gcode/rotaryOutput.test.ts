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
 * Slice B of #393: an angle on a toolpath point, and exporting it.
 *
 * `ToolpathPoint.a` is the degrees the stock is turned to, about the bar's
 * axis, when the tool is at that point. No generator produces one yet (#395);
 * these tests build the projects, machines and toolpaths by hand and assert on
 * the emitted program, line by line.
 *
 * Run with: npx tsx src/engine/gcode/rotaryOutput.test.ts
 */

import assert from 'node:assert/strict'
import { defaultTool, getStockBounds, newProject, roundStock, rectProfile } from '../../types/project'
import { squareStock } from '../../types/barStock'
import type { BlockStock, MachineOrigin, Operation, Project, RoundStock, Stock } from '../../types/project'
import { BUNDLED_DEFINITIONS } from './definitions'
import { normalizeToolForProject } from '../toolpaths/geometry'
import { runPostProcessor } from './postprocessor'
import { parseGcodeMotion } from './gcodeMotionParser'
import { rotaryDirection, validateMachineDefinition } from './types'
import type { MachineDefinition, PostProcessorResult, RotaryDefinition } from './types'
import { warningSeverity } from '../toolpaths/warningCodes'
import {
  createArcEmitOptions,
  inverseTimeFeedValue,
  planOperationMotion,
  planRotaryRefusals,
  planStepFeeds,
  rotaryCentreline,
} from './motionPipeline'
import type { LinearMoveDescriptor } from './arcFitting'
import type { DrillCycle, ToolpathMove, ToolpathPoint, ToolpathResult } from '../toolpaths/types'
import { exportGeometryTolerance } from '../../utils/units'
import { stockSpacePoint } from '../rotaryFrame'

// ── fixtures ──────────────────────────────────────────────────

const byId = (id: string): MachineDefinition => {
  const raw = BUNDLED_DEFINITIONS.find((definition) => definition.id === id)
  assert.ok(raw, `bundled definition ${id} exists`)
  return validateMachineDefinition(raw)
}

const GRBL = byId('grbl')
const LINUXCNC = byId('linuxcnc')

/** The bundled grbl definition plus a rotary block. */
function rotaryMachine(
  rotary: RotaryDefinition,
  coordinateSystem: MachineDefinition['coordinateSystem'] = GRBL.coordinateSystem,
): MachineDefinition {
  return validateMachineDefinition({ ...structuredClone(GRBL), rotary, coordinateSystem })
}

/** Any bundled definition plus a rotary block. */
function rotaryOn(base: MachineDefinition, rotary: RotaryDefinition): MachineDefinition {
  return validateMachineDefinition({ ...structuredClone(base), rotary })
}

const OWN_AXIS: RotaryDefinition = {
  about: 'x',
  drive: 'own',
  reversed: false,
  inverseTimeFeed: { on: 'G93', off: 'G94' },
}

const BORROWED_Y: RotaryDefinition = {
  about: 'x',
  drive: 'borrowed',
  reversed: false,
  inverseTimeFeed: { on: 'G93', off: 'G94' },
}

/** A round bar 20 mm across, 100 mm long, along project X, at the origin. */
function bar(): RoundStock {
  return roundStock(20, 100, 'x')
}

/** A plain rectangular block of stock. */
function block(): BlockStock {
  return {
    profile: rectProfile(0, 0, 100, 20),
    thickness: 20,
    material: 'aluminum_6061',
    color: '#b9a83c',
    visible: true,
    origin: { x: 0, y: 0 },
  }
}

function projectWith(stock: Stock, name = 'Rotary Test'): Project {
  const project = newProject(name, 'mm')
  project.stock = stock
  project.origin = originFor(stock)
  const toolRecord = { ...defaultTool('mm', 1), id: 't1', name: 'Test End Mill' }
  project.tools = [toolRecord]
  return project
}

/** The origin a round bar puts on its centreline, as `defaultOrigin` does. */
function originFor(stock: Stock): MachineOrigin {
  const bounds = getStockBounds(stock)
  if (stock.shape === 'round') {
    const centre = stock.axis === 'x'
      ? (bounds.minY + bounds.maxY) / 2
      : (bounds.minX + bounds.maxX) / 2
    return {
      name: 'Origin',
      x: stock.axis === 'x' ? bounds.minX : centre,
      y: stock.axis === 'x' ? centre : bounds.maxY,
      z: stock.thickness,
      visible: true,
    }
  }
  return { name: 'Origin', x: bounds.minX, y: bounds.maxY, z: stock.thickness, visible: true }
}

function operation(name: string, overrides: Partial<Operation> = {}): Operation {
  return {
    id: name.toLowerCase().replace(/\W+/g, '-'),
    name,
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
    ...overrides,
  }
}

function toolpathOf(op: Operation, moves: ToolpathMove[]): ToolpathResult {
  return { operationId: op.id, warnings: [], bounds: null, moves }
}

/** Export a list of operations through the real postprocessor. */
function exportProgram(
  project: Project,
  definition: MachineDefinition,
  entries: Array<{ operation: Operation; moves: ToolpathMove[]; drillCycles?: DrillCycle[] }>,
): PostProcessorResult {
  const tools = new Map(project.tools.map((tool) => [tool.id, normalizeToolForProject(tool, project)]))
  return runPostProcessor({
    project,
    definition,
    operations: entries.map(({ operation: op, moves, drillCycles }) => {
      const tool = tools.get(op.toolRef ?? '')
      assert.ok(tool, `tool ${op.toolRef} exists in the project`)
      return {
        operation: op,
        tool,
        toolpath: drillCycles ? { ...toolpathOf(op, moves), drillCycles } : toolpathOf(op, moves),
      }
    }),
    options: { emitToolChanges: false, emitCoolant: false, programName: project.meta.name },
  })
}

/**
 * Emitted motion blocks: a setup line (`G90`, `G21`, `G93`…) or a block
 * carrying an axis word. Later blocks are modal and carry no motion word of
 * their own, so a `^G` filter would miss exactly the turning moves here.
 */
function motionLines(program: string): string[] {
  return program
    .split('\n')
    .filter((line) => line.length > 0 && !/^[;(%]/.test(line))
    .filter((line) => line.startsWith('G') || /[XYZA]/.test(line))
}

/** The one line whose motion word is `word`, or undefined. */
function lineWithWord(program: string, word: RegExp): string | undefined {
  return motionLines(program).find((line) => word.test(line))
}

/** `pt` with a rotary angle: a project point at height `z`, turned to `a`. */
function at(x: number, y: number, z: number, a?: number): ToolpathPoint {
  return a === undefined ? { x, y, z } : { x, y, z, a }
}

/**
 * `moves` prefixed with the rapid that establishes the bar's starting angle
 * (issue #393, rule 2): a feed move may only begin at the angle the controller
 * is already at, and the angle is unknown at program start. The rapid ends
 * where the first move begins, so the motion itself is unchanged.
 */
function established(moves: ToolpathMove[]): ToolpathMove[] {
  const first = moves[0]
  if (!first || first.from.a === undefined) return moves
  return [{ kind: 'rapid', from: { ...first.from }, to: { ...first.from } }, ...moves]
}

/**
 * The true length of the tip's path in the stock's own frame, by brute force: a
 * polyline of `chords` chords whose points are
 * `stockSpacePoint(lerp(from, to, t))` (`rotaryFrame.ts`). Independent of the
 * exporter's quadrature — the oracle the path-length checks compare against.
 */
function bruteForceStockPathLength(
  from: ToolpathPoint,
  to: ToolpathPoint,
  stock: RoundStock,
  chords = 100_000,
): number {
  const lerp = (t: number): ToolpathPoint => ({
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    z: from.z + (to.z - from.z) * t,
    a: (from.a ?? 0) + ((to.a ?? 0) - (from.a ?? 0)) * t,
  })
  let previous = stockSpacePoint(lerp(0), stock)
  let length = 0
  for (let index = 1; index <= chords; index++) {
    const point = stockSpacePoint(lerp(index / chords), stock)
    length += Math.hypot(point.x - previous.x, point.y - previous.y, point.z - previous.z)
    previous = point
  }
  return length
}

// ── 1. unchanged: a toolpath with no angle ────────────────────
//
// The rotary code path must be invisible when nothing turns. Each bundled
// definition exports the same text with a rotary block present as with it
// absent, and the whole output text is compared, not just the motion lines.

{
  const moves: ToolpathMove[] = [
    { kind: 'rapid', from: at(0, 10, 30), to: at(10, 10, 30) },
    { kind: 'plunge', from: at(10, 10, 30), to: at(10, 10, 20) },
    { kind: 'cut', from: at(10, 10, 20), to: at(30, 10, 20) },
  ]
  for (const raw of BUNDLED_DEFINITIONS) {
    const definition = validateMachineDefinition(raw)
    const project = projectWith(definition.machineKind === 'plasma' ? block() : bar())
    const op = operation('Plain')
    const plain = exportProgram(project, definition, [{ operation: op, moves }]).gcode
    const withBlock = { ...structuredClone(definition), rotary: OWN_AXIS }
    if (definition.machineKind === 'plasma' || definition.outputDialect === 'opensbp') {
      // Slice A refuses a rotary block on these dialects; that is its own test.
      assert.throws(() => validateMachineDefinition(withBlock),
        `${definition.id}: validation refuses a rotary block on this dialect`)
      continue
    }
    const rotated = validateMachineDefinition(withBlock)
    const rotatedProgram = exportProgram(project, rotated, [{ operation: op, moves }]).gcode
    assert.equal(rotatedProgram, plain,
      `${definition.id}: a toolpath with no angle exports identically with a rotary block`)
  }
}

// ── 2. own axis: the words, the sign, the modal behaviour ─────

{
  const project = projectWith(bar())
  const op = operation('Turn')
  // Each move turns the stock and also travels, so no two blocks are the same
  // and the emitted words can be read one move at a time.
  const moves: ToolpathMove[] = [
    { kind: 'rapid', from: at(0, 10, 30, 0), to: at(10, 10, 30, 0) },
    { kind: 'plunge', from: at(10, 10, 30, 0), to: at(10, 10, 20, 0) },
    { kind: 'cut', from: at(10, 10, 20, 0), to: at(10, 10, 20, 90) },
    { kind: 'cut', from: at(10, 10, 20, 90), to: at(10, 10, 20, 350) },
    { kind: 'cut', from: at(10, 10, 20, 350), to: at(10, 10, 20, 370) },
  ]
  const result = exportProgram(project, rotaryMachine(OWN_AXIS), [{ operation: op, moves }])
  const lines = motionLines(result.gcode)
  const turning = lines.filter((line) => /A-?[0-9]/.test(line))

  // The first point with an angle emits the word (on the rapid); later moves at
  // the same angle do not (modal, like X/Y/Z), and each angle change writes its
  // own value.
  assert.equal(turning.length, 4, `one A word per angle change, got:\n${lines.join('\n')}`)
  assert.match(turning[0], /A0\b/, 'the first turning block writes A0')
  assert.match(turning[1], /A90\b/, 'the next angle change writes A90')
  assert.match(turning[2], /A350\b/, 'the next writes A350')
  // 350 -> 370 is 20 degrees, not a wrap back to 10.
  assert.match(turning[3], /A370\b/, 'the angle is never reduced to 0-360')
  assert.doesNotMatch(result.gcode, /A10\b/, 'no wrapped angle is written')

  // `reversed` flips the sign on the way out.
  const reversed = exportProgram(project, rotaryMachine({ ...OWN_AXIS, reversed: true }), [{ operation: op, moves }])
  const reversedTurning = motionLines(reversed.gcode).filter((line) => /A-?[0-9]/.test(line))
  assert.equal(reversedTurning.length, 4, 'the same blocks carry an angle reversed')
  // Zero negated is still zero, and prints as `0.000`, not `-0.000`.
  assert.match(reversedTurning[0], /A-?0\b/, 'reversed writes the negated angle')
  assert.match(reversedTurning[1], /A-90\b/, 'reversed writes the negated angle')
  assert.match(reversedTurning[3], /A-370\b/, 'reversed does not wrap either')
}

// ── 3. borrowed motor ─────────────────────────────────────────

{
  const project = projectWith(bar())
  const op = operation('Borrowed')
  // The bar lies along project X, so the borrowed motor is project Y: it never
  // changes here, and its letter carries the angle instead. The leading rapid
  // establishes the starting angle (rule 2).
  const moves: ToolpathMove[] = established([
    { kind: 'cut', from: at(0, 10, 30, 0), to: at(20, 10, 30, 45) },
  ])
  const result = exportProgram(project, rotaryMachine(BORROWED_Y), [{ operation: op, moves }])
  const lines = motionLines(result.gcode)
  const turning = lines.filter((line) => /Y-?[0-9]/.test(line))
  assert.deepEqual(turning, ['X0.000 Y0.000', 'G1 X20.000 Z10.000 Y45.000 F23.593'],
    `the borrowed letter carries the angle and never a linear value:\n${lines.join('\n')}`)
  assert.equal((turning[1].match(/Y-?[0-9.]+/g) ?? []).length, 1,
    'the borrowed letter is written once, as the angle — never twice as a linear value')

  // A negative borrowed output reverses the rotation, exactly as `reversed`
  // does on its own axis.
  const mirrored = rotaryMachine(BORROWED_Y, { ...GRBL.coordinateSystem, yAxis: '-Y' })
  const mirroredResult = exportProgram(project, mirrored, [{ operation: op, moves }])
  const mirroredTurning = motionLines(mirroredResult.gcode).filter((line) => /Y-?[0-9]/.test(line))
  assert.deepEqual(mirroredTurning, ['X0.000 Y0.000', 'G1 X20.000 Z10.000 Y-45.000 F23.593'],
    'a mirrored borrowed output flips the sign')
}

// ── 3b. a feed move must carry its angle on both ends or on neither (rule 2) ─
//
// With an angle on one end only, feed planning reads the absent angle as zero
// and the emitter writes no angle word: the bar would stay where it is while
// the cut ran at the speed planned for a turn.
{
  const project = projectWith(bar())
  const definition = rotaryMachine(OWN_AXIS)
  // The establishing rapid leaves the controller at A90.
  const establishing: ToolpathMove = { kind: 'rapid', from: at(0, 10, 20, 90), to: at(0, 10, 20, 90) }
  const arrangements: Array<[string, ToolpathMove[]]> = [
    ['ends without an angle', [
      establishing,
      { kind: 'cut', from: at(0, 10, 20, 90), to: at(0, 10, 15) },
    ]],
    ['starts without an angle', [
      establishing,
      { kind: 'cut', from: at(0, 10, 15), to: at(0, 10, 20, 90) },
    ]],
  ]
  for (const [name, moves] of arrangements) {
    // With inverse-time feed and without it: the refusal names the angle rule,
    // not the missing feed mode.
    for (const machine of [definition, rotaryMachine({ ...OWN_AXIS, inverseTimeFeed: null })]) {
      const result = exportProgram(project, machine, [{ operation: operation('Partial'), moves }])
      assert.deepEqual(result.warnings, [{
        code: 'postRotaryAngleNotEstablished',
        params: { operation: 'Partial' },
      }], `a feed move that ${name} is refused`)
      assert.doesNotMatch(result.gcode, /A(15|90)\b/, `${name}: the refused operation emits no motion`)
    }
  }

  // A rapid may still carry the angle on one end: that is how the first angle
  // is established, and the same move with a whole feed pair still exports.
  const control = exportProgram(project, definition, [{
    operation: operation('Whole'),
    moves: [{ kind: 'rapid', from: at(0, 10, 30), to: at(0, 10, 30, 90) }, {
      kind: 'cut', from: at(0, 10, 30, 90), to: at(0, 10, 20, 90),
    }],
  }])
  assert.deepEqual(control.warnings, [], 'a rapid may establish an angle at one end of its own move')
  assert.match(control.gcode, /A90\b/, 'and the established angle is written')
}

// ── 4. no arc across a turning move ───────────────────────────

/** A circle of radius `r` about (cx, cy) at height `z`, as `count` chords. */
function circleMoves(
  cx: number,
  cy: number,
  r: number,
  z: number,
  count: number,
  angleAt: (index: number) => number | undefined,
): ToolpathMove[] {
  const point = (index: number): ToolpathPoint => {
    const angle = (index / count) * Math.PI * 2
    return at(cx + r * Math.cos(angle), cy + r * Math.sin(angle), z, angleAt(index))
  }
  const moves: ToolpathMove[] = []
  for (let index = 0; index < count; index++) {
    moves.push({ kind: 'cut', from: point(index), to: point(index + 1) })
  }
  return moves
}

{
  const project = projectWith(bar())
  const definition = rotaryMachine(OWN_AXIS)
  // Arc interpolation on, arc fitting on: every point lies exactly on a circle
  // in XY, so the fitter would join the run if the angle did not move.
  assert.equal(definition.motion.arcInterpolation, true, 'grbl interpolates arcs')

  const turning = exportProgram(project, definition, [{
    operation: operation('Turns', { arcFittingEnabled: true }),
    moves: established(circleMoves(0, 10, 5, 20, 16, (index) => index * 10)),
  }]).gcode
  // `G[23]\b` and not `G2|G3`: the units command `G21` also starts with `G2`.
  assert.doesNotMatch(turning, /G[23]\b/, 'a turning move is never merged into an arc')
  assert.match(turning, /G1 /, 'the turning moves are still emitted as linear motion')

  const constant = exportProgram(project, definition, [{
    operation: operation('Flat', { arcFittingEnabled: true }),
    // The angle is 45 throughout, so the establishing rapid writes it once and
    // the arcs that follow need no angle word of their own (rules 1 and 2).
    moves: established(circleMoves(0, 10, 5, 20, 16, () => 45)),
  }]).gcode
  assert.match(constant, /G[23]\b/, 'the same points at a constant angle still fit an arc')
  // The arcs are only correct because the establishing rapid wrote the angle
  // first: the emitter keeps the angle modal, so an arc carries no A word of
  // its own. Dropping that word from the rapid would leave the whole run at the
  // controller's previous angle.
  const constantLines = motionLines(constant)
  const firstArc = constantLines.findIndex((line) => /G[23]\b/.test(line))
  const writtenAngle = constantLines.findIndex((line) => /A45\b/.test(line))
  assert.ok(writtenAngle >= 0 && writtenAngle < firstArc,
    `the A45 rapid is written before the first arc:\n${constantLines.join('\n')}`)
  const constantParse = parseGcodeMotion(constant, 'ij', ';', '', {
    word: 'A',
    inverseTimeFeed: { on: 'G93', off: 'G94' },
  })
  const constantArcs = constantParse.moves.filter((move) => move.kind === 'arc')
  assert.ok(constantArcs.length > 0, 'the constant-angle run reads back as arcs')
  assert.ok(constantArcs.every((arc) => arc.from.a === 45 && arc.to.a === 45),
    'every arc read back is at 45°, established by the rapid before it')

  // A turning move must not seed a run either: the first move is never a
  // candidate for its own run, so it would otherwise join the arc the
  // constant-angle moves after it fit. It stays a linear step; the constant
  // run after it can still fit.
  const seeded = circleMoves(0, 10, 5, 20, 4, () => 10)
  seeded[0] = { ...seeded[0], from: { ...seeded[0].from, a: 0 } }
  const plan = planOperationMotion({
    project,
    definition,
    operation: operation('Seeded', { arcFittingEnabled: true }),
    toolpath: toolpathOf(operation('Seeded'), seeded),
    arcEmitOptions: createArcEmitOptions(definition, 'mm', 'ij'),
    startPosition: null,
    captureTrace: false,
  })
  assert.equal(plan.steps[0].kind, 'linear',
    'a turning move that starts a run is never merged into an arc')
  assert.ok(plan.steps.some((step) => step.kind === 'arc'),
    'the constant-angle moves after it still fit an arc')
}

// ── 5. inverse-time feed ──────────────────────────────────────
//
// A pure rotation with the tip 10 mm from the centreline: the arc the stock
// sweeps is `r * Δθ`, so a 90 degree turn travels `10 * (π/2)` mm and the
// inverse-time word is `feed / length`. Computed here from first principles,
// never from the implementation.

const FEED = 600
const NINETY = Math.PI / 2

{
  const project = projectWith(bar())
  const op = operation('Rotate')
  // The bar's centreline sits at Z = 10 for a 20 mm bar, so Z = 20 puts the tip
  // exactly 10 mm from it. The leading rapid establishes the 0° start.
  const moves: ToolpathMove[] = established([
    { kind: 'cut', from: at(0, 10, 20, 0), to: at(0, 10, 20, 90) },
  ])
  const result = exportProgram(project, rotaryMachine(OWN_AXIS), [{ operation: op, moves }])
  const lines = motionLines(result.gcode)
  const rotateIndex = lines.findIndex((line) => /A90\b/.test(line))

  assert.equal(lines.filter((line) => line.startsWith('G93')).length, 1, 'G93 is emitted once, before the first turning feed move')
  assert.ok(rotateIndex > 0 && lines[rotateIndex - 1] === 'G93', `G93 directly precedes the turning move:\n${lines.join('\n')}`)
  const expected = FEED / (10 * NINETY)
  const fWord = lines[rotateIndex].match(/F([-0-9.]+)/)
  assert.ok(fWord, 'the turning move carries its own F word')
  assert.equal(Number(fWord[1]), Number(expected.toFixed(3)), `the word is feed / (r x angle), got ${fWord[1]}`)
}

// The same at 5 mm from the centreline: the swept arc is half as long, so the
// word is twice as large.
{
  const project = projectWith(bar())
  const moves: ToolpathMove[] = established([{ kind: 'cut', from: at(0, 10, 15, 0), to: at(0, 10, 15, 90) }])
  const result = exportProgram(project, rotaryMachine(OWN_AXIS), [{
    operation: operation('RotateHalf'), moves,
  }])
  const line = lineWithWord(result.gcode, /A90\b/)
  assert.ok(line, 'the turning move is emitted')
  const expected = FEED / (5 * NINETY)
  assert.equal(Number(line.match(/F([-0-9.]+)/)?.[1]), Number(expected.toFixed(3)), 'half the radius doubles the word')
}

// A mixed move: rotation plus a straight-line distance over the linear axes
// that move. The path length is the hypotenuse of the two. The move runs along
// the bar (X), so the radius stays 10 mm at both ends.
{
  const project = projectWith(bar())
  const from = at(0, 10, 20, 0)
  const to = at(3, 10, 20, 90)
  const moves: ToolpathMove[] = established([{ kind: 'cut', from, to }])
  const result = exportProgram(project, rotaryMachine(OWN_AXIS), [{
    operation: operation('Mixed'), moves,
  }])
  const line = lineWithWord(result.gcode, /A90\b/)
  assert.ok(line, 'the mixed move is emitted')
  const linear = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z)
  const expected = FEED / Math.hypot(linear, 10 * NINETY)
  assert.equal(Number(line.match(/F([-0-9.]+)/)?.[1]), Number(expected.toFixed(3)), 'the word is feed / sqrt(linear^2 + (r x angle)^2)')
}

// A turning move whose two ends are at different distances from the
// centreline. It plunges while it turns, so the tip traces a spiral in the
// stock's frame and the path length is its arc length, not the mean-radius
// approximation. The bar's centreline sits at Z = 10 for a 20 mm bar, so the
// move runs from 10 mm above it to 5 mm above it.
//
// The expected word is derived independently (a 4,000,000-interval Simpson
// quadrature of the analytic tip speed, not this exporter): the true length is
// 12.830215525281 mm, so the word is 600 / 12.830215525281 = 46.764608...,
// written as `46.765` at grbl's three decimals.
{
  const project = projectWith(bar())
  const from = at(0, 10, 20, 0)
  const to = at(0, 10, 15, 90)
  const result = exportProgram(project, rotaryMachine(OWN_AXIS), [{
    operation: operation('PlungingTurn'), moves: established([{ kind: 'cut', from, to }]),
  }])
  const line = lineWithWord(result.gcode, /A90\b/)
  assert.ok(line, `the plunging turning move is emitted:\n${motionLines(result.gcode).join('\n')}`)
  assert.equal(Number(line.match(/F([-0-9.]+)/)?.[1]), 46.765,
    'the emitted F is feed / (the true spiral length)')
  // The mean-of-the-two-end-radii approximation gives 46.877, and neither end's
  // radius alone gives the right word either.
  const linear = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z)
  const meanRadius = (10 + 5) / 2
  const meanRadiusWord = FEED / Math.hypot(linear, meanRadius * NINETY)
  assert.notEqual(Number(meanRadiusWord.toFixed(3)), 46.765,
    'the mean radius would give a different word')
  assert.notEqual(Number(line.match(/F([-0-9.]+)/)?.[1]), Number((FEED / Math.hypot(linear, 5 * NINETY)).toFixed(3)),
    'the end radius alone would give a different word')
}

// Two turning moves with the same sweep and radius carry the same inverse-time
// word. grbl's `modalFeedSpeed` would drop the second F as modal; rule 4 says
// every inverse-time move writes its own, so it must appear twice.
{
  const project = projectWith(bar())
  const moves: ToolpathMove[] = established([
    { kind: 'cut', from: at(0, 10, 20, 0), to: at(0, 10, 20, 90) },
    { kind: 'cut', from: at(0, 10, 20, 90), to: at(0, 10, 20, 180) },
  ])
  const result = exportProgram(project, rotaryMachine(OWN_AXIS), [{
    operation: operation('SameFeed'), moves,
  }])
  const turning = motionLines(result.gcode).filter((line) => /A(90|180)\b/.test(line))
  assert.equal(turning.length, 2, `two turning moves:\n${motionLines(result.gcode).join('\n')}`)
  const expected = (FEED / (10 * NINETY)).toFixed(3)
  for (const line of turning) {
    assert.match(line, new RegExp(`F${expected}\\b`), 'every inverse-time move restates its F, even when it is unchanged')
  }
}

// Mode discipline: every turning move carries its own F, G94 and the ordinary
// feed come back before a non-turning feed move *and before a rapid*, a rapid
// carries no F, and the program ends out of inverse time.
{
  const project = projectWith(bar())
  const moves: ToolpathMove[] = [
    { kind: 'rapid', from: at(0, 10, 30, 0), to: at(0, 10, 30, 45) },
    { kind: 'cut', from: at(0, 10, 30, 45), to: at(0, 10, 30, 90) },
    // A rapid after a turning cut must not inherit G93 (rule 4).
    { kind: 'rapid', from: at(0, 10, 30, 90), to: at(5, 10, 30, 90) },
    { kind: 'cut', from: at(5, 10, 30, 90), to: at(0, 10, 30, 180) },
    { kind: 'cut', from: at(0, 10, 30, 180), to: at(5, 10, 30, 180) },
  ]
  const result = exportProgram(project, rotaryMachine(OWN_AXIS), [{
    operation: operation('Discipline'), moves,
  }])
  const lines = motionLines(result.gcode)

  // The establishing rapid carries the angle but no feed word.
  const establishing = lines.find((line) => /A45\b/.test(line))
  assert.ok(establishing, `the rapid is a turning move:\n${lines.join('\n')}`)
  assert.doesNotMatch(establishing, /F[-0-9]/, 'a rapid turning move has no F word')

  // Both turning feed moves carry their own F, even though the second changes
  // the angle from the first. The block spells the motion word, its axis words
  // and the angle word together.
  const turning = lines.filter((line) => /A(90|180)\b/.test(line))
  assert.equal(turning.length, 2, `two turning feed moves:\n${lines.join('\n')}`)
  for (const line of turning) assert.match(line, /F[-0-9]/, 'every inverse-time move carries its own F')
  assert.match(lines.find((line) => /^G1 /.test(line)) ?? '', /X\S.*A/, 'a turning feed writes G1 with an axis and the angle')

  // The rapid after the first turning cut is written in ordinary mode: G94
  // directly precedes it, and the rapid carries no feed word.
  const rapidAfterCut = lines.findIndex((line) => /^G0\b/.test(line) && /X5\b/.test(line))
  assert.ok(rapidAfterCut > 0, `the rapid after the cut is emitted:\n${lines.join('\n')}`)
  assert.equal(lines[rapidAfterCut - 1], 'G94', `G94 restores ordinary feed before the rapid:\n${lines.join('\n')}`)
  assert.doesNotMatch(lines[rapidAfterCut], /F[-0-9]/, 'the rapid carries no feed word')

  // G94 and the ordinary feed come back before the straight move too. The
  // motion word stays modal, so the block carries only its axes.
  const straight = lines.find((line) => /X5\b/.test(line) && !/^G0\b/.test(line))
  assert.ok(straight, `the straight feed move is emitted:\n${lines.join('\n')}`)
  assert.match(straight, /F600\b/, 'the ordinary feed is restated after inverse time')

  // The straight move left inverse-time mode, so no turning move follows the
  // final G94 and the program is already out of it.
  const last = lines.lastIndexOf('G94')
  assert.ok(lines.slice(last + 1).every((line) => !/A-?[0-9]/.test(line)),
    `no turning move follows the final G94:\n${lines.join('\n')}`)
}

// A program whose last feed move turns switches inverse time off *before* the
// spindle stop and the footer (rule 4: the program never ends in inverse-time
// mode, and an `M5` is not a turning move).
{
  const project = projectWith(bar())
  const result = exportProgram(project, rotaryMachine(OWN_AXIS), [{
    operation: operation('EndsTurning'),
    moves: established([{ kind: 'cut', from: at(0, 10, 20, 0), to: at(0, 10, 20, 90) }]),
  }])
  // Since #1091 nothing sits between the spindle stop and the footer.
  const raw = result.gcode.split('\n')
  const restored = raw.indexOf('G94')
  const spindleOff = raw.indexOf('M5')
  const end = raw.indexOf('M30')
  assert.ok(restored > 0 && spindleOff > restored && end > spindleOff,
    `G94 comes before the spindle stop and the program end:\n${result.gcode}`)
  assert.match(result.gcode, /G94\nM5\nM30/,
    'the spindle stop and the end are written in ordinary mode')
}

// ── 6. inverseTimeFeedValue alone ─────────────────────────────

{
  const centre = rotaryCentreline(bar())
  assert.ok(centre, 'a round bar has a centreline')
  const tolerance = exportGeometryTolerance('mm')

  // Zero rotation is the ordinary feed divided by the linear distance.
  const flat = inverseTimeFeedValue(at(0, 10, 30), at(4, 10, 30), 600, centre, tolerance)
  assert.equal(flat, 600 / 4, 'no rotation is feed / linear')

  // Zero linear travel and zero radius is finite: the tolerance floors it.
  const degenerate = inverseTimeFeedValue(at(0, 0, 10), at(0, 0, 10), 600, centre, tolerance)
  assert.ok(Number.isFinite(degenerate), 'a degenerate move yields a finite word')
  assert.equal(degenerate, 600 / tolerance, 'the tolerance is the floor')

  // The across-axis offset counts, not just the height: the corner (0, 0, 20)
  // is hypot(10, 10) from the centreline, while a point straight above it at
  // the same height (0, 10, 20) is exactly 10 mm out. Both ends carry the angle
  // (rule 2): the length is never asked to guess an absent one.
  const atRadius = inverseTimeFeedValue(at(0, 0, 20, 0), at(0, 0, 20, 90), 600, centre, tolerance)
  assert.equal(atRadius, 600 / (Math.hypot(10, 10) * NINETY), 'the across-axis offset is measured')
  const heightOnly = inverseTimeFeedValue(at(0, 10, 20, 0), at(0, 10, 20, 90), 600, centre, tolerance)
  assert.equal(heightOnly, 600 / (10 * NINETY), 'a point above the centreline is 10 mm out')
  assert.notEqual(atRadius, heightOnly, 'ignoring the across-axis offset would give the wrong word')
}

// The path the tip draws in the stock's own frame, when it plunges while it
// turns, is a spiral — not `sqrt(linear² + (meanRadius × Δθ)²)`. The functions
// below are checked against an independent brute-force polyline of 100,000
// chords through `stockSpacePoint` (issue #393, rule 4).
{
  const centre = rotaryCentreline(bar())
  assert.ok(centre, 'a round bar has a centreline')
  const tolerance = exportGeometryTolerance('mm')
  const stock = bar()

  // The review's worked case: centreline at Y10/Z10, bar along X, from 10 mm
  // above the centreline to the centreline itself over a 90° turn. The true
  // length is 13.236523505131 mm, so the word is 600 / 13.236523505131 =
  // 45.3291228… — `45.329` at three decimals. The mean-radius approximation
  // gives 47.186 instead.
  const workedFrom = at(0, 10, 20, 0)
  const workedTo = at(0, 10, 10, 90)
  const worked = inverseTimeFeedValue(workedFrom, workedTo, 600, centre, tolerance)
  assert.equal(Number(worked.toFixed(3)), 45.329, 'the worked case is the true spiral length')
  assert.notEqual(Number(worked.toFixed(3)), 47.186, 'the mean radius would give a different word')

  // The quadrature agrees with a 100,000-chord polyline of `stockSpacePoint`
  // for the worked case, a constant-radius helix, a tool off the centreline,
  // both bar axes, and a negative sweep.
  const cases: Array<[string, ToolpathPoint, ToolpathPoint, RoundStock]> = [
    ['the worked plunge', workedFrom, workedTo, stock],
    ['a constant-radius helix', at(0, 10, 20, 0), at(10, 10, 20, 270), stock],
    ['a tool off the centreline', at(0, 0, 20, 0), at(0, 0, 20, 90), stock],
    ['a bar along Y', at(0, 0, 20, 0), at(0, 0, 10, 90), roundStock(20, 100, 'y')],
    ['a negative sweep', at(0, 10, 20, 0), at(0, 10, 10, -90), stock],
  ]
  for (const [name, from, to, caseStock] of cases) {
    const caseCentre = rotaryCentreline(caseStock)
    assert.ok(caseCentre, `${name}: a round bar has a centreline`)
    const expectedLength = bruteForceStockPathLength(from, to, caseStock)
    const value = inverseTimeFeedValue(from, to, 600, caseCentre, tolerance)
    const relativeError = Math.abs(600 / value - expectedLength) / expectedLength
    assert.ok(relativeError < 1e-9,
      `${name}: quadrature and the polyline agree (relative error ${relativeError.toExponential(2)})`)
  }

  // A move that starts off the centreline and changes its across coordinate
  // *and* its height while the angle changes, with travel along the bar as
  // well: every term of the squared speed contributes, on both bar axes and
  // for both signs of sweep. The start is off the centreline on both counts,
  // and each case carries its own numbers, so a sign flip in `c1`, `c2` or
  // `beta`, a dropped `Δacross²` in `alpha`, or reading across/up from the
  // wrong axis on a bar along Y all change the length.
  const offCentreline: Array<[string, ToolpathPoint, ToolpathPoint, RoundStock]> = [
    ['a bar along X, positive sweep', at(0, 13, 21, 15), at(7, 6, 14, 140), stock],
    ['a bar along X, negative sweep', at(2, 5, 18, 20), at(12, 14, 13, -110), stock],
    ['a bar along Y, positive sweep', at(14, 2, 22, 15), at(5, 12, 16, 140), roundStock(20, 100, 'y')],
    ['a bar along Y, negative sweep', at(7, 1, 19, 20), at(15, 10, 12, -110), roundStock(20, 100, 'y')],
  ]
  for (const [name, from, to, caseStock] of offCentreline) {
    const caseCentre = rotaryCentreline(caseStock)
    assert.ok(caseCentre, `${name}: a round bar has a centreline`)
    const expectedLength = bruteForceStockPathLength(from, to, caseStock)
    const value = inverseTimeFeedValue(from, to, 600, caseCentre, tolerance)
    const relativeError = Math.abs(600 / value - expectedLength) / expectedLength
    assert.ok(relativeError < 1e-9,
      `${name}: quadrature and the polyline agree (relative error ${relativeError.toExponential(2)})`)
  }

  // A constant-radius move keeps exactly the word it had before: a pure turn is
  // `r × Δθ`, and a turn that travels along the bar over the centreline is
  // `|Δalong|`.
  const pureTurn = inverseTimeFeedValue(at(0, 10, 20, 0), at(0, 10, 20, 90), 600, centre, tolerance)
  assert.equal(pureTurn, 600 / (10 * NINETY), 'a constant-radius turn keeps its word')
  const overCentre = inverseTimeFeedValue(at(0, 10, 10, 0), at(7, 10, 10, 90), 600, centre, tolerance)
  assert.equal(overCentre, 600 / 7, 'a turn over the centreline keeps its word')

  // ── the tip speed touching zero ─────────────────────────────
  //
  // The squared speed is a sum of squares, so it can touch zero *inside* a move
  // and the integrand acquires a corner. A fixed Gauss-Legendre rule is not
  // enough there: the case below is a perfect square, the rule was off by 8e-4,
  // and the program wrote F19.084 where the true word is F19.099.
  //
  // Bar along X, centreline at Y10 / Z10, feed 600: from 20 mm across the bar
  // to 20 mm the other side over a full turn, each end 10/π below the
  // centreline. The speed is 40π·|t − ½| and the length is exactly 10π.
  const cuspFrom = at(0, 0, 10 - 10 / Math.PI, 0)
  const cuspTo = at(0, 20, 10 - 10 / Math.PI, 360)
  const cusp = inverseTimeFeedValue(cuspFrom, cuspTo, 600, centre, tolerance)
  assert.equal(Number(cusp.toFixed(3)), 19.099, 'the cusp writes F19.099, not the 32-point rule\'s F19.084')
  const cuspLength = 600 / cusp
  assert.ok(Math.abs(cuspLength - 10 * Math.PI) / (10 * Math.PI) < 1e-12,
    `the cusp length is the exact 10π (got ${cuspLength})`)

  // The same geometry with the double zero just outside each end: the minimum
  // sits at `t* = -ε` and at `t* = 1 + ε`, so the corner is off the interval.
  // The length is `40π·(½ + ε)` exactly.
  const epsilon = 1e-3
  const outsideLength = 20 * Math.PI + 40 * Math.PI * epsilon
  const outsideCases: Array<[string, ToolpathPoint, ToolpathPoint]> = [
    ['the zero just before the start', at(0, 10 + 20 * epsilon, 10 - 10 / Math.PI, 0),
      at(0, 30 + 20 * epsilon, 10 - 10 / Math.PI, 360)],
    ['the zero just after the end', at(0, -10 - 20 * epsilon, 10 - 10 / Math.PI, 0),
      at(0, 10 - 20 * epsilon, 10 - 10 / Math.PI, 360)],
  ]
  for (const [name, from, to] of outsideCases) {
    const value = inverseTimeFeedValue(from, to, 600, centre, tolerance)
    const length = 600 / value
    assert.ok(Math.abs(length - outsideLength) / outsideLength < 1e-12,
      `${name}: the closed form is exact (got ${length}, expected ${outsideLength})`)
    const expectedLength = bruteForceStockPathLength(from, to, stock)
    assert.ok(Math.abs(length - expectedLength) / expectedLength < 1e-9,
      `${name}: the polyline agrees (relative error ${(Math.abs(length - expectedLength) / expectedLength).toExponential(2)})`)
  }

  // A near miss: the minimum speed is ~1e-6 of the maximum, so the corner is
  // present but shallow — the case a split-interval quadrature would still
  // strain on.
  const nearMissFrom = at(0, 0, 10 - 10 / Math.PI, 0)
  const nearMissTo = at(0, 20 + 6.32e-5, 10 - 10 / Math.PI, 360)
  let minSpeed = Infinity
  let maxSpeed = 0
  const speedChords = 200_000
  for (let index = 0; index < speedChords; index++) {
    const previous = stockSpacePoint({
      x: 0,
      y: 0 + (20 + 6.32e-5) * (index / speedChords),
      z: 10 - 10 / Math.PI,
      a: 360 * (index / speedChords),
    }, stock)
    const next = stockSpacePoint({
      x: 0,
      y: 0 + (20 + 6.32e-5) * ((index + 1) / speedChords),
      z: 10 - 10 / Math.PI,
      a: 360 * ((index + 1) / speedChords),
    }, stock)
    const speed = Math.hypot(next.x - previous.x, next.y - previous.y, next.z - previous.z)
    if (speed < minSpeed) minSpeed = speed
    if (speed > maxSpeed) maxSpeed = speed
  }
  assert.ok(minSpeed / maxSpeed < 1e-5, `the near miss really is a near miss (ratio ${minSpeed / maxSpeed})`)
  const nearMiss = inverseTimeFeedValue(nearMissFrom, nearMissTo, 600, centre, tolerance)
  const nearMissExpected = bruteForceStockPathLength(nearMissFrom, nearMissTo, stock)
  assert.ok(Math.abs(600 / nearMiss - nearMissExpected) / nearMissExpected < 1e-9,
    `the near miss agrees with the polyline (relative error ${(Math.abs(600 / nearMiss - nearMissExpected) / nearMissExpected).toExponential(2)})`)

  // A long move: ten full turns while the tool drops from 10 mm above the
  // centreline to 5 mm above it. A 100,000-chord polyline is not enough here
  // (the chord error is ~1.6e-8), so this one uses a million.
  const longFrom = at(0, 10, 20, 0)
  const longTo = at(0, 10, 15, 3600)
  const longValue = inverseTimeFeedValue(longFrom, longTo, 600, centre, tolerance)
  const longExpected = bruteForceStockPathLength(longFrom, longTo, stock, 1_000_000)
  assert.ok(Math.abs(600 / longValue - longExpected) / longExpected < 1e-9,
    `the 3600° move agrees with the polyline (relative error ${(Math.abs(600 / longValue - longExpected) / longExpected).toExponential(2)})`)
}

// The review's cancelling case: the quadratic's minimum sits ~5e14 moves
// outside, so the closed form's two antiderivative terms swallow the length and
// it planned 18.000 mm for a true 18.6870947749 (F33.333 instead of F32.108).
{
  const centre = rotaryCentreline(bar())
  assert.ok(centre, 'a round bar has a centreline')
  const from = at(0, 11, 20, 0)
  const to = at(10, 11 + 1e-14, 20 + 1e-14, 90)
  const value = inverseTimeFeedValue(from, to, 600, centre, exportGeometryTolerance('mm'))
  const length = 600 / value
  assert.ok(Math.abs(length - 18.6870947749) / 18.6870947749 < 1e-9,
    `the cancelling move keeps its length (got ${length})`)
  assert.equal(Number(value.toFixed(3)), 32.108, 'the cancelling move writes F32.108, not the closed form\'s F33.333')
}

// The closed form cancels when the quadratic's minimum lies far outside the
// move, so the length switches to a 32-point Gauss-Legendre rule there. One
// narrow case at a time kept missing the boundary; 3000 seeded moves sweep both
// branches and both bar axes against an independent reference instead.
//
// The reference integrates the same speed written from raw geometry (a sum of
// squares, so it cannot cancel), by composite 32-point Gauss-Legendre over 64
// panels, split at the quadratic's vertex when it lies inside. No Math.random:
// a small deterministic LCG keeps a failure reproducible from the seed.
{
  const GL_NODES = [
    0.048307665687738310378, 0.14447196158279648759, 0.23928736225213706468,
    0.33186860228212766710, 0.42135127613063533270, 0.50689990893222935942,
    0.58771575724076230429, 0.66304426693021523143, 0.73218211874028971131,
    0.79448379596794238555, 0.84936761373256997043, 0.89632115576605209117,
    0.93490607593773966677, 0.96476225558750638989, 0.98561151154526838170,
    0.99726386184948156988,
  ]
  const GL_WEIGHTS = [
    0.096540088514727853686, 0.095638720079274847086, 0.093844399080804538626,
    0.091173878695763904689, 0.087652093004403741627, 0.083311924226946720839,
    0.078193895787070435976, 0.072345794108848615611, 0.065822222776361946628,
    0.058684093478535578892, 0.050998059262376153888, 0.042835898022226703841,
    0.034273862913021410637, 0.025392065309262138589, 0.016274394730905708539,
    0.0070186100094701362601,
  ]
  const panel = (lo: number, hi: number, f: (t: number) => number): number => {
    const half = (hi - lo) / 2
    const mid = (lo + hi) / 2
    let sum = 0
    for (let index = 0; index < GL_NODES.length; index++) {
      const weight = GL_WEIGHTS[index]
      const node = GL_NODES[index]
      sum += weight * (f(mid + half * node) + f(mid - half * node))
    }
    return half * sum
  }
  /**
   * The tip's path length in the stock frame, from the raw across/up/along
   * geometry — not from the exporter's `alpha`/`beta`/`gamma` arrangement.
   */
  const referenceStockPathLength = (
    from: ToolpathPoint,
    to: ToolpathPoint,
    centre: { axis: 'x' | 'y'; point: ToolpathPoint },
  ): number => {
    const acrossAt = (point: ToolpathPoint): number =>
      (centre.axis === 'x' ? point.y : point.x) - (centre.axis === 'x' ? centre.point.y : centre.point.x)
    const upAt = (point: ToolpathPoint): number => point.z - centre.point.z
    const alongAt = (point: ToolpathPoint): number => (centre.axis === 'x' ? point.x : point.y)
    const a0 = acrossAt(from)
    const u0 = upAt(from)
    const dAcross = acrossAt(to) - a0
    const dUp = upAt(to) - u0
    const dAlong = alongAt(to) - alongAt(from)
    const omega = (((to.a ?? 0) - (from.a ?? 0)) * Math.PI) / 180
    const speed = (t: number): number => {
      const across = a0 + dAcross * t
      const up = u0 + dUp * t
      return Math.sqrt(
        dAlong * dAlong + (dAcross + omega * up) ** 2 + (dUp - omega * across) ** 2,
      )
    }
    // The vertex of the squared speed, from the raw coefficients, decides where
    // to split; an exact split is what makes the corner case integrable.
    const p = dAcross + omega * u0
    const q = omega * dUp
    const r = dUp - omega * a0
    const s = -omega * dAcross
    const alpha = q * q + s * s
    const beta = 2 * (p * q + r * s)
    const vertex = alpha > 0 ? -beta / (2 * alpha) : Number.NaN
    const breaks = Number.isFinite(vertex) && vertex > 0 && vertex < 1 ? [0, vertex, 1] : [0, 1]
    const panels = 64
    let total = 0
    for (let index = 0; index < breaks.length - 1; index++) {
      const lo = breaks[index]
      const hi = breaks[index + 1]
      const step = (hi - lo) / panels
      for (let panelIndex = 0; panelIndex < panels; panelIndex++) {
        total += panel(lo + panelIndex * step, lo + (panelIndex + 1) * step, speed)
      }
    }
    return total
  }

  // Draw a signed magnitude as `sign * 10^k`, sometimes exactly zero.
  let seed = 0x2f6e2b1
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296
  }
  const offset = (): number => (random() * 2 - 1) * 20
  const delta = (): number => {
    if (random() < 0.08) return 0
    const sign = random() < 0.5 ? -1 : 1
    return sign * 10 ** (-15 + random() * 17)
  }
  const sweepDegrees = (): number => {
    if (random() < 0.08) return 0
    const sign = random() < 0.5 ? -1 : 1
    return sign * 10 ** (-12 + random() * 16.5)
  }

  let worstError = 0
  let worstCase = ''
  for (let index = 0; index < 3000; index++) {
    const stock = roundStock(20, 100, random() < 0.5 ? 'x' : 'y')
    const centre = rotaryCentreline(stock)
    assert.ok(centre, `${index}: a round bar has a centreline`)
    const startAcross = offset()
    const startUp = offset()
    const dAcross = delta()
    const dUp = delta()
    const dAlong = delta()
    const sweep = sweepDegrees()
    const from: ToolpathPoint = centre.axis === 'x'
      ? at(0, centre.point.y + startAcross, centre.point.z + startUp, 0)
      : at(centre.point.x + startAcross, 0, centre.point.z + startUp, 0)
    const to: ToolpathPoint = centre.axis === 'x'
      ? at(dAlong, from.y + dAcross, from.z + dUp, sweep)
      : at(from.x + dAcross, dAlong, from.z + dUp, sweep)
    const expected = referenceStockPathLength(from, to, centre)
    // Tolerance 0 bypasses the emitter's floor, so the length itself is judged
    // even for the sub-micron moves the random draw produces.
    const value = inverseTimeFeedValue(from, to, 600, centre, 0)
    const computed = Number.isFinite(value) ? 600 / value : 0
    if (expected === 0) {
      assert.equal(computed, 0, `case ${index}: a zero-length move stays zero`)
      continue
    }
    const absolute = Math.abs(computed - expected)
    const error = expected < 1e-3 ? absolute : absolute / expected
    if (error > worstError) {
      worstError = error
      worstCase = `#${index} axis ${centre.axis} from ${JSON.stringify(from)} to ${JSON.stringify(to)}`
    }
    const bound = expected < 1e-3 ? 1e-12 : 1e-9
    assert.ok(error < bound,
      `${worstCase}: the length is the quadrature (error ${error.toExponential(2)})`)
  }
  // The reference and the emitter are different code, so the worst case is a
  // real number to report rather than a pass/fail only.
  console.log(`   worst path-length error ${worstError.toExponential(2)} (${worstCase})`)
}

// A rapid that turns: the angle word is never written on a block that also
// carries Z. Turning the bar while Z moves turns it while the tool is still
// near the work, so the turn happens at the higher of the rapid's two Z values.
// The bar's centreline is at Z = 10 and the stock top at Z = 20, so the emitted
// Z values are (project Z - 20).
{
  const project = projectWith(bar())

  // Z rises: the Z block comes first, with no angle, and the XY block that
  // follows carries it.
  const rising = exportProgram(project, rotaryMachine(OWN_AXIS), [{
    operation: operation('RiseTurn'),
    moves: [
      { kind: 'rapid', from: at(0, 10, 20, 0), to: at(0, 10, 30, 20) },
      { kind: 'cut', from: at(0, 10, 30, 20), to: at(10, 10, 30, 20) },
    ],
  }])
  assert.deepEqual(motionLines(rising.gcode).filter((line) => line.startsWith('G0') || /A20\b/.test(line)),
    ['G0 Z10.000', 'X0.000 Y0.000 A20.000'],
    `a rising rapid writes Z first, then the XY block with the angle:\n${motionLines(rising.gcode).join('\n')}`)

  // Z falls: the XY block carrying the angle comes first, then the Z block. A
  // leading rapid establishes the starting height.
  const falling = exportProgram(project, rotaryMachine(OWN_AXIS), [{
    operation: operation('FallTurn'),
    moves: [
      { kind: 'rapid', from: at(100, 10, 30, 0), to: at(0, 10, 30, 0) },
      { kind: 'rapid', from: at(0, 10, 30, 0), to: at(10, 10, 20, 30) },
      { kind: 'cut', from: at(10, 10, 20, 30), to: at(20, 10, 20, 30) },
    ],
  }])
  assert.deepEqual(motionLines(falling.gcode).filter((line) => line.startsWith('G0')
    || line.startsWith('X') || line.startsWith('Y') || line.startsWith('Z') || /A30\b/.test(line)),
    ['G0 Z10.000', 'X0.000 Y0.000 A0.000', 'X10.000 Y0.000 A30.000', 'Z0.000'],
    `a falling rapid turns across first, then drops:\n${motionLines(falling.gcode).join('\n')}`)

  // Z rises and XY moves in the same rapid: still Z first, angle on the XY
  // block. The next rapid falls back: XY (with the angle) first, then Z.
  const both = exportProgram(project, rotaryMachine(OWN_AXIS), [{
    operation: operation('BothWays'),
    moves: [
      { kind: 'rapid', from: at(10, 10, 30, 0), to: at(30, 10, 40, 15) },
      { kind: 'rapid', from: at(30, 10, 40, 15), to: at(10, 10, 30, 0) },
      { kind: 'cut', from: at(10, 10, 30, 0), to: at(20, 10, 30, 0) },
    ],
  }])
  assert.deepEqual(motionLines(both.gcode).filter((line) => line.startsWith('G0')
    || line.startsWith('X') || line.startsWith('Y') || line.startsWith('Z') || /A(15|0)\./.test(line)),
    ['G0 Z20.000', 'X30.000 Y0.000 A15.000', 'X10.000 Y0.000 A0.000', 'Z10.000'],
    `a rising rapid puts the angle on the XY block, a falling one turns first:\n${motionLines(both.gcode).join('\n')}`)

  // No Z change at all: one XY block, angle and all; and a rotation-only rapid
  // (the tool is already there) still writes the angle, on a block of its own.
  const flatTurn = exportProgram(project, rotaryMachine(OWN_AXIS), [{
    operation: operation('FlatTurn'),
    moves: [
      { kind: 'rapid', from: at(0, 10, 30, 0), to: at(10, 10, 30, 25) },
      { kind: 'rapid', from: at(10, 10, 30, 25), to: at(10, 10, 30, 40) },
      { kind: 'cut', from: at(10, 10, 30, 40), to: at(20, 10, 30, 40) },
    ],
  }])
  assert.deepEqual(motionLines(flatTurn.gcode).filter((line) => /A(25|40)\./.test(line)),
    ['X10.000 Y0.000 A25.000', 'A40.000'],
    `an XY-only rapid carries the angle, and a rotation-only rapid writes it alone:\n${motionLines(flatTurn.gcode).join('\n')}`)
}

// ── 7. refusals ───────────────────────────────────────────────

{
  const project = projectWith(bar())
  const turning: ToolpathMove[] = [{ kind: 'cut', from: at(0, 10, 30, 0), to: at(0, 10, 30, 90) }]
  const flat: ToolpathMove[] = [{ kind: 'cut', from: at(0, 10, 30), to: at(5, 10, 30) }]

  // (a) an angle on a machine with no rotary block.
  {
    const result = exportProgram(project, GRBL, [
      { operation: operation('Refused'), moves: turning },
      { operation: operation('Kept'), moves: flat },
    ])
    assert.deepEqual(result.warnings, [{ code: 'postRotaryNoAxis', params: { operation: 'Refused' } }],
      'the turning operation is refused with the operation name')
    assert.doesNotMatch(result.gcode, /A90\b/, 'none of its motion is emitted')
    assert.match(result.gcode, /X5\b/, 'the other operation is still emitted')
  }

  // (b) a turning feed move on a controller with no inverse-time feed.
  {
    const noInverse = rotaryMachine({ ...OWN_AXIS, inverseTimeFeed: null })
    const result = exportProgram(project, noInverse, [
      { operation: operation('NoInverse'), moves: turning },
      { operation: operation('Kept'), moves: flat },
    ])
    assert.deepEqual(result.warnings, [{ code: 'postRotaryNoInverseTime', params: { operation: 'NoInverse' } }])
    assert.doesNotMatch(result.gcode, /A90\b/, 'the refused operation emits no motion')
    assert.match(result.gcode, /X5\b/, 'the other operation is still emitted')
  }

  // (c) travel along the borrowed motor's axis.
  {
    const moves: ToolpathMove[] = [{ kind: 'cut', from: at(0, 0, 30, 0), to: at(0, 20, 30, 90) }]
    const result = exportProgram(project, rotaryMachine(BORROWED_Y), [
      { operation: operation('BorrowedTravel'), moves },
      { operation: operation('Kept'), moves: flat },
    ])
    assert.deepEqual(result.warnings, [{
      code: 'postRotaryBorrowedAxisTravel',
      params: { operation: 'BorrowedTravel', axis: 'Y' },
    }])
    // The exact kept program: the refused operation writes no motion, and the
    // borrowed letter is never written as a linear coordinate. `A90` alone
    // would also be satisfied by a wrong `Y90`, so compare the lines.
    assert.deepEqual(motionLines(result.gcode),
      ['G90', 'G17', 'G21', 'G1 X5.000 Z10.000 F600.000'],
      `the refused operation emits no motion and the borrowed axis no linear word:\n${motionLines(result.gcode).join('\n')}`)
  }

  // (d) a turning cut on something that is not a round bar.
  {
    const notRound = projectWith(block())
    const result = exportProgram(notRound, rotaryMachine(OWN_AXIS), [
      { operation: operation('Block'), moves: turning },
      { operation: operation('Kept'), moves: flat },
    ])
    assert.deepEqual(result.warnings, [{ code: 'postRotaryNeedsRoundStock', params: { operation: 'Block' } }])
    assert.doesNotMatch(result.gcode, /A90\b/, 'the refused operation emits no motion')
  }

  // (e) a square blank turns about the true pivot, and the axis rule applies to
  // it exactly as to a round bar (#1016 C2-S4): the centreline is mid-side, not
  // the corner radius.
  {
    const square = squareStock(20, 100, 'x')
    assert.deepEqual(
      rotaryCentreline(square),
      { axis: 'x', point: { x: 0, y: 10, z: 10 } },
      'the square centreline is the true pivot at the stock rectangle\'s centreline',
    )
    const result = exportProgram(projectWith(square), rotaryMachine({ ...OWN_AXIS, about: 'y' }), [
      { operation: operation('Square'), moves: turning },
    ])
    assert.deepEqual(result.warnings, [{
      code: 'postRotaryAxisMismatch',
      params: { operation: 'Square', machineAxis: 'Y', stockAxis: 'X' },
    }], 'a square blank on the wrong machine axis is refused')
    assert.doesNotMatch(result.gcode, /A90\b/, 'and emits no motion')
  }

  // Every refusal blocks a save, not merely annotates one.
  for (const code of [
    'postRotaryNoAxis', 'postRotaryNoInverseTime', 'postRotaryBorrowedAxisTravel',
    'postRotaryNeedsRoundStock', 'postRotaryAngleNotEstablished', 'postRotaryTemplateUsesBorrowedAxis',
    'postRotaryDrillNotExpanded',
  ] as const) {
    assert.equal(warningSeverity(code), 'error', `${code} blocks the export`)
  }
}

// ── 8. a flat operation on a borrowed-motor machine ───────────

{
  const project = projectWith(bar())
  const definition = rotaryMachine(BORROWED_Y)
  // Along the bar, never touching the borrowed project axis: allowed.
  const along: ToolpathMove[] = [{ kind: 'cut', from: at(0, 10, 30), to: at(20, 10, 30) }]
  const allowed = exportProgram(project, definition, [{ operation: operation('Along'), moves: along }])
  assert.deepEqual(allowed.warnings, [], 'a move that leaves the borrowed axis alone is allowed')
  assert.match(allowed.gcode, /X20\b/, 'the along-bar travel is emitted')
  assert.doesNotMatch(allowed.gcode, /Y[-0-9]/, 'a borrowed axis is still never written as a linear coordinate')

  // Moving on the borrowed axis: refused however flat the operation is.
  const across: ToolpathMove[] = [{ kind: 'cut', from: at(0, 10, 30), to: at(0, 12, 30) }]
  const refused = exportProgram(project, definition, [{ operation: operation('Across'), moves: across }])
  assert.deepEqual(refused.warnings, [{
    code: 'postRotaryBorrowedAxisTravel',
    params: { operation: 'Across', axis: 'Y' },
  }], 'travel on the borrowed axis is refused')
  assert.doesNotMatch(refused.gcode, /X0|Y12/, 'the refused operation emits no motion')
}

// ── 9. a mispaired move fails loudly, not silently ─────────────
//
// `planStepFeeds` pairs the emitted steps with the operation's project moves by
// position. A drift between the two would otherwise give a turning move the
// ordinary feed, or measure its path length from another move's endpoints, so a
// linear step whose angle disagrees with the move it was paired with is an
// error rather than a wrong program.
{
  const project = projectWith(bar())
  const op = operation('Mispaired')
  const definition = rotaryMachine(OWN_AXIS)
  // The step was planned from a turning toolpath move, but the project move it
  // is paired with has no angle at all — the drift the check exists to catch.
  const mispaired: ToolpathMove[] = [
    { kind: 'cut', from: at(0, 10, 20, 0), to: at(0, 10, 15) },
  ]
  const plannedFrom: ToolpathMove[] = [
    { kind: 'cut', from: at(0, 10, 20, 0), to: at(0, 10, 15, 90) },
  ]
  const plan = planOperationMotion({
    project,
    definition,
    operation: op,
    toolpath: toolpathOf(op, plannedFrom),
    arcEmitOptions: createArcEmitOptions(definition, 'mm', 'ij'),
    startPosition: null,
    captureTrace: false,
  })
  assert.throws(
    () => planStepFeeds({
      projectMoves: mispaired,
      steps: plan.steps,
      centre: rotaryCentreline(bar()),
      tolerance: exportGeometryTolerance('mm'),
      operationName: op.name,
      direction: rotaryDirection(definition),
      effectiveFeed: () => 600,
    }),
    /Mispaired/,
    'a step whose angle disagrees with its paired move throws, naming the operation',
  )

  // A step with no paired move at all throws too. The first two steps are
  // angle-less and match the first two moves; the third has no move left.
  const flatStep = (): LinearMoveDescriptor => ({
    kind: 'linear',
    point: { x: 0, y: 0, z: -5 },
    moveKind: 'cut',
  })
  assert.throws(
    () => planStepFeeds({
      projectMoves: [
        { kind: 'cut', from: at(0, 10, 20), to: at(0, 10, 15) },
        { kind: 'cut', from: at(0, 10, 15), to: at(0, 10, 10) },
      ],
      steps: [flatStep(), flatStep(), flatStep()],
      centre: rotaryCentreline(bar()),
      tolerance: exportGeometryTolerance('mm'),
      operationName: 'Mispaired',
      direction: rotaryDirection(definition),
      effectiveFeed: () => 600,
    }),
    /Mispaired/,
    'a step with no paired move throws',
  )

  // The check is narrowed to the plan a caller actually has: a normal export
  // goes through the same function and does not throw.
  const normal = exportProgram(project, definition, [{
    operation: operation('Normal'),
    moves: established([{ kind: 'cut', from: at(0, 10, 20, 0), to: at(0, 10, 15, 90) }]),
  }])
  assert.match(normal.gcode, /A90\b/, 'a well-paired export still emits its angle')
}

// ── 10. the borrowed coordinate is one value for the program (1a) ─

{
  const project = projectWith(bar())
  const definition = rotaryMachine(BORROWED_Y)
  const along = (y: number, from: number, to: number): ToolpathMove[] => [
    { kind: 'cut', from: at(from, y, 30), to: at(to, y, 30) },
  ]

  // The first exported operation fixes the borrowed coordinate; a later one at
  // another value would silently drop the travel between them (rule 3a).
  const moved = exportProgram(project, definition, [
    { operation: operation('First'), moves: along(10, 0, 5) },
    { operation: operation('Moved'), moves: along(20, 5, 10) },
    { operation: operation('Back'), moves: along(10, 10, 15) },
  ])
  assert.deepEqual(moved.warnings, [{
    code: 'postRotaryBorrowedAxisTravel',
    params: { operation: 'Moved', axis: 'Y' },
  }], 'a later operation at another borrowed value is refused')
  assert.deepEqual(motionLines(moved.gcode),
    ['G90', 'G17', 'G21', 'G1 X5.000 Z10.000 F600.000', 'X15.000 Z10.000'],
    `only the operations at the established value are exported:\n${motionLines(moved.gcode).join('\n')}`)

  // The same value throughout is allowed.
  const same = exportProgram(project, definition, [
    { operation: operation('One'), moves: along(10, 0, 5) },
    { operation: operation('Two'), moves: along(10, 5, 10) },
  ])
  assert.deepEqual(same.warnings, [], 'operations at the same borrowed value are all exported')
  assert.match(same.gcode, /X10\b/, 'the second operation is emitted')
}

// ── 11. canned cycles are not written on a rotary program (1b) ─

{
  const project = projectWith(bar())
  const op = operation('Drill', { kind: 'drilling' })
  const cycles: DrillCycle[] = [
    { x: 0, y: 10, clearZ: 30, retractZ: 30, bottomZ: 20, drillType: 'simple' },
    { x: 20, y: 10, clearZ: 30, retractZ: 30, bottomZ: 20, drillType: 'simple' },
  ]
  // The expanded G0/G1 the same operation carries besides its cycles.
  const angled: ToolpathMove[] = established([
    { kind: 'plunge', from: at(0, 10, 30, 0), to: at(0, 10, 20, 0) },
    { kind: 'rapid', from: at(0, 10, 20, 0), to: at(0, 10, 30, 0) },
    { kind: 'rapid', from: at(0, 10, 30, 0), to: at(20, 10, 30, 0) },
    { kind: 'plunge', from: at(20, 10, 30, 0), to: at(20, 10, 20, 0) },
    { kind: 'rapid', from: at(20, 10, 20, 0), to: at(20, 10, 30, 0) },
  ])
  const flat: ToolpathMove[] = [
    { kind: 'plunge', from: at(0, 10, 30), to: at(0, 10, 20) },
    { kind: 'rapid', from: at(0, 10, 20), to: at(0, 10, 30) },
    { kind: 'rapid', from: at(0, 10, 30), to: at(20, 10, 30) },
    { kind: 'plunge', from: at(20, 10, 30), to: at(20, 10, 20) },
    { kind: 'rapid', from: at(20, 10, 20), to: at(20, 10, 30) },
  ]

  // A borrowed-motor machine never writes G81: the letter carries the angle and
  // the cycle's positioning would write it as a linear coordinate, so the
  // expanded moves are used instead — where it is suppressed. The moves carry
  // no angle, so the borrowed motor is the only thing that can disable it.
  const borrowed = exportProgram(project, rotaryOn(LINUXCNC, BORROWED_Y), [
    { operation: op, moves: flat, drillCycles: cycles },
  ])
  assert.deepEqual(borrowed.warnings, [], 'the borrowed drilling operation still exports')
  assert.doesNotMatch(borrowed.gcode, /G8[13]\b/, 'a borrowed-motor machine writes no canned cycle')
  assert.match(borrowed.gcode, /G0 |G1 /, 'its expanded moves are written instead')

  // A toolpath that carries an angle anywhere also loses the canned cycle, even
  // on an own-axis machine.
  const ownAxis = exportProgram(project, rotaryOn(LINUXCNC, OWN_AXIS), [
    { operation: op, moves: angled, drillCycles: cycles },
  ])
  assert.deepEqual(ownAxis.warnings, [], 'the own-axis drilling operation exports')
  assert.doesNotMatch(ownAxis.gcode, /G8[13]\b/, 'a toolpath carrying an angle writes no canned cycle')
  assert.match(ownAxis.gcode, /G1 /, 'its expanded moves are written instead')

  // The control: no borrowed motor and no angle anywhere keeps today's G81.
  const control = exportProgram(project, LINUXCNC, [{ operation: op, moves: flat, drillCycles: cycles }])
  assert.deepEqual(control.warnings, [])
  assert.match(control.gcode, /G81\b/, 'a plain machine still writes its canned cycle')

  // A borrowed-motor machine whose operation has drill holes but no expanded
  // moves would be silently dropped: it is refused instead, with a warning that
  // names the real reason (rule 3b) rather than travel it does not have.
  const empty = exportProgram(project, rotaryOn(LINUXCNC, BORROWED_Y), [
    { operation: op, moves: [], drillCycles: cycles },
  ])
  assert.deepEqual(empty.warnings, [{
    code: 'postRotaryDrillNotExpanded',
    params: { operation: 'Drill' },
  }], 'drill holes with no moves to expand are refused')
  assert.doesNotMatch(empty.gcode, /G8[13]\b/, 'no canned cycle is written for the refused operation')
}

// ── 12. the machine's own templates may not drive the borrowed motor (1c) ─
//
// #1057 slice F restricts every template except the tool-change block and the
// footer; those two may still write anything, so they are the ones this check
// has to catch. A definition that put a motion word in a header or an operation
// header is refused by the schema before it reaches the emitter.

{
  const project = projectWith(bar())
  const moves: ToolpathMove[] = [{ kind: 'cut', from: at(0, 10, 30), to: at(20, 10, 30) }]
  // The footer is the other template that may write anything and is always
  // emitted, so every spelling below is judged on the program it appears in.
  const withFooter = (footer: string[]): MachineDefinition => validateMachineDefinition({
    ...structuredClone(GRBL),
    rotary: BORROWED_Y,
    program: { ...structuredClone(GRBL.program), footer },
  })

  for (const line of ['G0 X0 Y0', 'G53 G0 Y0', 'G92 Y0']) {
    const result = exportProgram(project, withFooter([line]), [
      { operation: operation('One'), moves },
      { operation: operation('Two'), moves },
    ])
    assert.deepEqual(result.warnings, [{
      code: 'postRotaryTemplateUsesBorrowedAxis',
      params: { axis: 'Y' },
    }], `${line}: a template that drives the borrowed motor refuses the program once`)
    assert.doesNotMatch(result.gcode, /X20\b/, `${line}: no operation's motion is emitted`)
  }

  // A comment is not a template line: the letter there drives nothing.
  const commented = exportProgram(project, withFooter(['; G0 Y0']), [{ operation: operation('One'), moves }])
  assert.deepEqual(commented.warnings, [], 'a comment mentioning the letter does not refuse the program')
  assert.match(commented.gcode, /X20\b/, 'and the operation is exported')

  // The other axis is not the borrowed letter.
  const otherAxis = exportProgram(project, withFooter(['G0 X0']), [{ operation: operation('One'), moves }])
  assert.deepEqual(otherAxis.warnings, [], 'an X word on a machine that borrows Y is harmless')

  // The three spellings a raw-template scan missed. `G0 Y{feed}` is only a word
  // once rendered; whitespace between the letter and its value is still a word;
  // and a line that starts with a parenthesised comment still carries code.
  // `{feed}` is only a word once the tool-change context renders it, so this
  // one is written by a real tool change.
  const one = operation('One')
  const renderedText = 'G0 X0 Y{feed}'
  // Slice H: a feed value may not become an axis coordinate, so the schema
  // refuses the placeholder position outright.
  assert.throws(
    () => validateMachineDefinition({
      ...structuredClone(GRBL),
      rotary: BORROWED_Y,
      toolChange: { ...structuredClone(GRBL.toolChange), commands: [...GRBL.toolChange.commands, renderedText] },
    }),
    (error: unknown) => error instanceof Error && error.message.includes('{feed}'),
    'the schema refuses a feed placeholder in an axis word',
  )
  const rendered = runPostProcessor({
    project,
    // #1119 retains this old snapshot structurally but refuses it at export,
    // so the emitter never sees it: the template-rule diagnostics are the
    // refusal, and no program is produced.
    definition: {
      ...structuredClone(GRBL),
      rotary: BORROWED_Y,
      toolChange: { ...structuredClone(GRBL.toolChange), commands: [...GRBL.toolChange.commands, renderedText] },
    } as MachineDefinition,
    operations: [{
      operation: one,
      tool: normalizeToolForProject(project.tools[0], project),
      toolpath: toolpathOf(one, moves),
    }],
    options: { emitToolChanges: true, emitCoolant: false, programName: project.meta.name },
  })
  assert.equal(rendered.gcode, '', 'an invalid machine produces no program')
  assert.ok(
    rendered.warnings.some((warning) => warning.code === 'exportMachineTemplateInvalid'),
    'the template-rule refusal replaces the emitter-level refusal',
  )

  const spaced = exportProgram(project, withFooter(['Y 0']), [{ operation: operation('One'), moves }])
  assert.deepEqual(spaced.warnings, [{
    code: 'postRotaryTemplateUsesBorrowedAxis',
    params: { axis: 'Y' },
  }], 'whitespace between the letter and its value is still a word')

  // LINUXCNC writes `( … )` comments; a naive scan skipped such a line whole
  // even though the code after the comment is code.
  const parenMachine = validateMachineDefinition({
    ...structuredClone(LINUXCNC),
    rotary: BORROWED_Y,
    program: { ...structuredClone(LINUXCNC.program), footer: ['(position) G0 Y0'] },
  })
  const paren = exportProgram(project, parenMachine, [{ operation: operation('One'), moves }])
  assert.deepEqual(paren.warnings, [{
    code: 'postRotaryTemplateUsesBorrowedAxis',
    params: { axis: 'Y' },
  }], 'code after a leading parenthesised comment still counts')
}

// A machine with its own axis: a template that writes A turns the bar behind
// the planner's back. Operation one ends at A90, the tool change runs `G0 A0`,
// and operation two's opening rapid to A90 writes no angle word because the
// emitter still believes it is at A90 — so the second operation would cut at
// the wrong angle. Such a program is refused; an angle-free one is untouched.
{
  const project = projectWith(bar())
  const moves: ToolpathMove[] = [{ kind: 'cut', from: at(0, 10, 30), to: at(20, 10, 30) }]
  const ownAxisChange = validateMachineDefinition({
    ...structuredClone(GRBL),
    rotary: OWN_AXIS,
    toolChange: { ...structuredClone(GRBL.toolChange), commands: [...GRBL.toolChange.commands, 'G0 A0'] },
  })
  const secondTool = { ...defaultTool('mm', 2), id: 't2', name: 'Second Tool' }
  project.tools = [...project.tools, secondTool]
  const tools = new Map(project.tools.map((tool) => [tool.id, normalizeToolForProject(tool, project)]))
  const turnOp = operation('Turn')
  const nextOp = operation('Next', { toolRef: 't2' })
  const turned = runPostProcessor({
    project,
    definition: ownAxisChange,
    operations: [
      {
        operation: turnOp,
        tool: tools.get('t1')!,
        toolpath: toolpathOf(turnOp, established([
          { kind: 'cut', from: at(0, 10, 20, 0), to: at(0, 10, 20, 90) },
        ])),
      },
      {
        operation: nextOp,
        tool: tools.get('t2')!,
        toolpath: toolpathOf(nextOp, [{ kind: 'cut', from: at(0, 10, 20), to: at(5, 10, 20) }]),
      },
    ],
    options: { emitToolChanges: true, emitCoolant: false, programName: project.meta.name },
  })
  assert.deepEqual(turned.warnings, [{
    code: 'postRotaryTemplateUsesBorrowedAxis',
    params: { axis: 'A' },
  }], 'an own-axis tool-change template that writes A refuses the turning program')
  assert.equal(turned.gcode, '', 'the refused program carries no program text')

  // The same template on a program that never turns is harmless: nothing is
  // rotated, so the extra `A` word cannot contradict the planner. The footer is
  // the other template that may write anything.
  const angleFree = exportProgram(project, validateMachineDefinition({
    ...structuredClone(GRBL),
    rotary: OWN_AXIS,
    program: { ...structuredClone(GRBL.program), footer: ['G0 A0'] },
  }), [{ operation: operation('Flat'), moves }])
  assert.deepEqual(angleFree.warnings, [], 'an own-axis template that writes A is harmless while nothing turns')
  assert.match(angleFree.gcode, /G0 A0/, 'and the template is written unchanged')
}

// The canned-cycle command words are cycle selectors by schema now (#1057
// slice F), so the only canned-cycle output that reaches the axis-word check is
// a legal cycle. The control pins that it still exports on an own-axis machine
// with a turning operation elsewhere in the program.
{
  const project = projectWith(bar())
  const drillOp = operation('Drill', { kind: 'drilling' })
  const cycles: DrillCycle[] = [
    { x: 0, y: 10, clearZ: 30, retractZ: 30, bottomZ: 20, drillType: 'simple' },
    { x: 20, y: 10, clearZ: 30, retractZ: 30, bottomZ: 20, drillType: 'simple' },
  ]
  const flat: ToolpathMove[] = [
    { kind: 'plunge', from: at(0, 10, 30), to: at(0, 10, 20) },
    { kind: 'rapid', from: at(0, 10, 20), to: at(0, 10, 30) },
    { kind: 'rapid', from: at(0, 10, 30), to: at(20, 10, 30) },
    { kind: 'plunge', from: at(20, 10, 30), to: at(20, 10, 20) },
    { kind: 'rapid', from: at(20, 10, 20), to: at(20, 10, 30) },
  ]
  const turnOp = operation('Turn')
  const entries = [
    { operation: drillOp, moves: flat, drillCycles: cycles },
    {
      operation: turnOp,
      moves: established([{ kind: 'cut', from: at(0, 10, 20, 0), to: at(0, 10, 15, 90) }]),
    },
  ]
  const control = exportProgram(project, validateMachineDefinition({
    ...structuredClone(LINUXCNC),
    rotary: OWN_AXIS,
    cannedCycles: structuredClone(LINUXCNC.cannedCycles),
  }), entries)
  assert.deepEqual(control.warnings, [], 'an ordinary canned cycle does not refuse the program')
  assert.match(control.gcode, /G81\b/, 'and the cycle is written')
}

// A definition template holding several physical lines is judged line by line
// (issue #393, rule 3c): the axis-word scan stops at a line's comment marker, so
// scanning the joined text dropped the code on every later line.
{
  const project = projectWith(bar())
  const moves: ToolpathMove[] = [{ kind: 'cut', from: at(0, 10, 30), to: at(20, 10, 30) }]
  const withFooter = (footer: string[]): MachineDefinition => validateMachineDefinition({
    ...structuredClone(GRBL),
    rotary: BORROWED_Y,
    program: { ...structuredClone(GRBL.program), footer },
  })

  const multiLine = exportProgram(project, withFooter(['; note\nG0 Y0']), [
    { operation: operation('One'), moves },
  ])
  assert.deepEqual(multiLine.warnings, [{
    code: 'postRotaryTemplateUsesBorrowedAxis',
    params: { axis: 'Y' },
  }], 'code on the second physical line of a template still counts')
  assert.equal(multiLine.gcode, '', 'the refused program carries no text')

  // The comment line alone is still prose and drives nothing.
  const commentOnly = exportProgram(project, withFooter(['; note\n; G0 Y0']), [
    { operation: operation('One'), moves },
  ])
  assert.deepEqual(commentOnly.warnings, [], 'a multi-line comment does not refuse the program')
  assert.match(commentOnly.gcode, /X20\b/, 'and the operation is exported')
}

// ── 13. the angle the controller is at is reconciled (2) ──────

{
  const project = projectWith(bar())
  const definition = rotaryMachine(OWN_AXIS)

  // A constant-angle arc run at 45° with no rapid before it: the controller has
  // never been turned to 45, so the operation is refused, not cut.
  const unestablished = exportProgram(project, definition, [{
    operation: operation('Unestablished', { arcFittingEnabled: true }),
    moves: circleMoves(0, 10, 5, 20, 16, () => 45),
  }])
  assert.deepEqual(unestablished.warnings, [{
    code: 'postRotaryAngleNotEstablished',
    params: { operation: 'Unestablished' },
  }], 'a feed move at an unestablished angle is refused')
  assert.doesNotMatch(unestablished.gcode, /G[23]\b/, 'no arc is emitted for it')

  // The establishing rapid makes the same operation run.
  const establishedRun = exportProgram(project, definition, [{
    operation: operation('Established', { arcFittingEnabled: true }),
    moves: established(circleMoves(0, 10, 5, 20, 16, () => 45)),
  }])
  assert.deepEqual(establishedRun.warnings, [])
  assert.match(establishedRun.gcode, /G[23]\b/, 'the arcs are emitted once the angle is established')
  // Accepted is not enough: the rapid must actually write the angle before the
  // run, and reading the program back must show every arc at 45°.
  const establishedLines = motionLines(establishedRun.gcode)
  const establishedFirstArc = establishedLines.findIndex((line) => /G[23]\b/.test(line))
  const establishedAngle = establishedLines.findIndex((line) => /A45\b/.test(line))
  assert.ok(establishedAngle >= 0 && establishedAngle < establishedFirstArc,
    `the A45 rapid precedes the first arc:\n${establishedLines.join('\n')}`)
  const establishedParse = parseGcodeMotion(establishedRun.gcode, 'ij', ';', '', {
    word: 'A',
    inverseTimeFeed: { on: 'G93', off: 'G94' },
  })
  const establishedArcs = establishedParse.moves.filter((move) => move.kind === 'arc')
  assert.ok(establishedArcs.length > 0, 'the run reads back as arcs')
  assert.ok(establishedArcs.every((arc) => arc.from.a === 45 && arc.to.a === 45),
    'every arc read back is at 45°')
}

// A feed move that starts and ends at 90 after the program left the bar at 0
// would turn the bar inside an ordinary `G94` cut, and a machine with no
// inverse-time feed would otherwise not notice it.
{
  const project = projectWith(bar())
  const definition = rotaryMachine({ ...OWN_AXIS, inverseTimeFeed: null })
  const result = exportProgram(project, definition, [
    {
      operation: operation('Zero'),
      moves: established([{ kind: 'cut', from: at(0, 10, 30, 0), to: at(5, 10, 30, 0) }]),
    },
    {
      operation: operation('Ninety'),
      moves: [{ kind: 'cut', from: at(5, 10, 30, 90), to: at(10, 10, 30, 90) }],
    },
  ])
  assert.deepEqual(result.warnings, [{
    code: 'postRotaryAngleNotEstablished',
    params: { operation: 'Ninety' },
  }], 'a constant-angle cut at another angle would turn the bar inside an ordinary move')
  assert.doesNotMatch(result.gcode, /A90\b/, 'the refused operation emits no motion')
}

// An operation with no angle anywhere after one that left the bar at a non-zero
// angle is fine: it writes no angle word and the bar stays put.
{
  const project = projectWith(bar())
  const result = exportProgram(project, rotaryMachine(OWN_AXIS), [
    {
      operation: operation('Turned'),
      moves: established([{ kind: 'cut', from: at(0, 10, 30, 0), to: at(0, 10, 30, 45) }]),
    },
    {
      operation: operation('FlatAfter'),
      moves: [{ kind: 'cut', from: at(0, 10, 30), to: at(5, 10, 30) }],
    },
  ])
  assert.deepEqual(result.warnings, [], 'an angle-less operation after a turn is fine')
  const lines = motionLines(result.gcode)
  const turned = lines.findIndex((line) => /A45\b/.test(line))
  assert.ok(turned >= 0, `the turn is written:\n${lines.join('\n')}`)
  assert.ok(lines.slice(turned + 1).every((line) => !/A-?[0-9]/.test(line)),
    `the flat operation writes no angle and the bar stays where it was:\n${lines.join('\n')}`)
}

// A program that begins with a feed move has no established angle yet.
{
  const project = projectWith(bar())
  const result = exportProgram(project, rotaryMachine(OWN_AXIS), [{
    operation: operation('StartsCutting'),
    moves: [{ kind: 'cut', from: at(0, 10, 20, 0), to: at(0, 10, 20, 90) }],
  }])
  assert.deepEqual(result.warnings, [{
    code: 'postRotaryAngleNotEstablished',
    params: { operation: 'StartsCutting' },
  }], 'the bar angle is unknown at program start, so a feed move may not begin there')
}

// ── 14. the inverse-time F is on the motion block (3) ─────────

{
  const project = projectWith(bar())
  // A definition that writes ordinary feeds on their own line must not do that
  // with an inverse-time feed: LinuxCNC requires the F on every G1 in G93.
  const nonInline = validateMachineDefinition({
    ...structuredClone(GRBL),
    rotary: OWN_AXIS,
    feedSpeed: { ...GRBL.feedSpeed, inlineWithMotion: false },
  })
  const result = exportProgram(project, nonInline, [{
    operation: operation('NonInline'),
    moves: established([{ kind: 'cut', from: at(0, 10, 20, 0), to: at(0, 10, 20, 90) }]),
  }])
  const lines = motionLines(result.gcode)
  const turning = lines.findIndex((line) => /A90\b/.test(line))
  assert.ok(turning > 0, `the turning move is emitted:\n${lines.join('\n')}`)
  assert.equal(lines[turning - 1], 'G93', `G93 directly precedes it:\n${lines.join('\n')}`)
  // 600 / (10 × π/2) = 38.197.
  assert.match(lines[turning], /F38\.197\b/, 'the inverse-time F is on the motion block itself')
  // And nowhere on a line of its own: `motionLines` drops a bare F line, so
  // check the raw program.
  assert.ok(!result.gcode.split('\n').includes('F38.197'),
    'the inverse-time F is not written on a line of its own')
}

// ── 15. G94 is restored before non-turning output (5) ─────────

{
  const project = projectWith(bar())
  // A machine whose operation header carries a dwell (an operation's own
  // template) and a positioning move.
  const withDwellHeader = validateMachineDefinition({
    ...structuredClone(GRBL),
    rotary: OWN_AXIS,
    // A dwell is an inert operation-header template (#1057 slice F); a
    // positioning word there is refused by the schema.
    program: { ...structuredClone(GRBL.program), operationHeader: ['G4 P1'] },
  })
  const result = exportProgram(project, withDwellHeader, [
    {
      operation: operation('Turn'),
      moves: established([{ kind: 'cut', from: at(0, 10, 20, 0), to: at(0, 10, 20, 90) }]),
    },
    {
      operation: operation('Header'),
      moves: [{ kind: 'cut', from: at(0, 10, 20), to: at(5, 10, 20) }],
    },
  ])
  const lines = motionLines(result.gcode)
  const dwell = lines.lastIndexOf('G4 P1')
  assert.ok(dwell > 0, `the header dwell is emitted:\n${lines.join('\n')}`)
  assert.equal(lines[dwell - 1], 'G94', 'G94 is restored before the next operation\'s dwell template')
  // Nothing in the second operation's header turns the bar.
  assert.ok(lines.slice(dwell).every((line) => !/A-?[0-9]/.test(line)),
    'no turning move follows the restored mode')
}

// A tool change after a turning cut is written in ordinary mode too.
{
  const project = projectWith(bar())
  const secondTool = { ...defaultTool('mm', 2), id: 't2', name: 'Second Tool' }
  project.tools = [...project.tools, secondTool]
  const definition = rotaryMachine(OWN_AXIS)
  const tools = new Map(project.tools.map((tool) => [tool.id, normalizeToolForProject(tool, project)]))
  const turn = operation('Turn')
  const change = operation('Change', { toolRef: 't2' })
  const result = runPostProcessor({
    project,
    definition,
    operations: [
      {
        operation: turn,
        tool: tools.get('t1')!,
        toolpath: toolpathOf(turn, established([
          { kind: 'cut', from: at(0, 10, 20, 0), to: at(0, 10, 20, 90) },
        ])),
      },
      {
        operation: change,
        tool: tools.get('t2')!,
        toolpath: toolpathOf(change, [{ kind: 'cut', from: at(0, 10, 20), to: at(5, 10, 20) }]),
      },
    ],
    options: { emitToolChanges: true, emitCoolant: false, programName: project.meta.name },
  })
  const raw = result.gcode.split('\n')
  // The first operation loads its tool too, so the change under test is the
  // last one.
  const changeIndex = raw.reduce((found, line, index) => /Tool change/.test(line) ? index : found, -1)
  assert.ok(changeIndex > 0, `the tool change is emitted:\n${raw.join('\n')}`)
  const restored = raw.lastIndexOf('G94', changeIndex)
  assert.ok(restored > -1 && restored < changeIndex, 'G94 is restored before the tool change')
  assert.ok(raw.slice(restored, changeIndex).every((line) => !/A-?[0-9]/.test(line)),
    'no turning move is written between the restored mode and the tool change')

  // The spindle stop that ends the turning operation is itself output: it must
  // be written in ordinary mode, before the tool change, not inside `G93`.
  const turningIndex = raw.findIndex((line) => /A90\b/.test(line))
  const stopIndex = raw.findIndex((line, index) => index > turningIndex && line === 'M5')
  const modeBeforeStop = raw.lastIndexOf('G94', stopIndex)
  assert.ok(turningIndex > 0 && stopIndex > turningIndex && modeBeforeStop > turningIndex
    && modeBeforeStop < stopIndex && changeIndex > stopIndex,
    `G94 comes before the spindle stop, which comes before the tool change:\n${raw.join('\n')}`)
}

// ── the planner in isolation ──────────────────────────────────

{
  const project = projectWith(bar())
  const op = operation('Isolated')
  const plan = planRotaryRefusals({
    project,
    definition: GRBL,
    operations: [{
      operation: op,
      tool: normalizeToolForProject(project.tools[0], project),
      toolpath: toolpathOf(op, [{ kind: 'cut', from: at(0, 10, 30), to: at(0, 10, 30, 90) }]),
    }],
  })
  assert.equal(plan.operations.length, 0, 'the refused operation is dropped')
  assert.equal(plan.warnings.length, 1, 'and reported once')
}

// ── 16. no closing unwind, on any rotary program (#1091) ─────
//
// A rotary program ends where its last move left it. The bar is not returned
// to 0 before the footer, so the operator's next part is not silently turned
// by the program. The final motion is the last operation's own retract, exactly
// as a non-rotary program's is.
{
  const project = projectWith(bar())
  const result = exportProgram(project, rotaryMachine(OWN_AXIS), [{
    operation: operation('EndsAt90'),
    moves: established([{ kind: 'cut', from: at(0, 10, 20, 0), to: at(0, 10, 20, 90) }]),
  }])
  const raw = result.gcode.split('\n')
  assert.equal(raw[raw.length - 1], 'M30', 'the program end is the last line')
  assert.equal(raw[raw.length - 2], 'M5', 'nothing is written after the spindle stop')
  assert.ok(!/^G0 [AXY]0\.000$/.test(raw[raw.length - 2]), 'no closing unwind runs before the footer')
  assert.ok(!result.gcode.includes('G53'), 'and no machine-coordinate unwind retract either')
  // The last angle written is the last move's, not 0.
  const written = motionLines(result.gcode)
    .flatMap((block) => [...block.matchAll(/A(-?[0-9.]+)/g)].map((match) => Number(match[1])))
  assert.equal(written[written.length - 1], 90, 'the program ends on the last move angle')
  // The final motion is the turning cut itself, at its own height: the emitter
  // invents no retract and no turn.
  const axisLines = motionLines(result.gcode).filter((block) => /[AXYZ]/.test(block))
  assert.match(axisLines[axisLines.length - 1], /A90\.000/, 'the last motion is the toolpath move')

  // The borrowed letter is left at its last angle too.
  const borrowed = exportProgram(project, rotaryMachine(BORROWED_Y), [{
    operation: operation('EndsAt90'),
    moves: established([{ kind: 'cut', from: at(0, 10, 20, 0), to: at(0, 10, 20, 90) }]),
  }])
  assert.ok(!/\nG0 Y0\.000\nM30/.test(borrowed.gcode), 'no borrowed-letter unwind is written')
  const borrowedWritten = motionLines(borrowed.gcode)
    .flatMap((block) => [...block.matchAll(/Y(-?[0-9.]+)/g)].map((match) => Number(match[1])))
  assert.equal(borrowedWritten[borrowedWritten.length - 1], 90, 'the borrowed letter ends on the last angle')

  // A program that ends at 0 writes no extra A rapid either, for the same
  // reason: there is no closing block at all.
  const zero = exportProgram(project, rotaryMachine(OWN_AXIS), [{
    operation: operation('Zero'),
    moves: established([{ kind: 'cut', from: at(0, 10, 20, 0), to: at(5, 10, 20, 0) }]),
  }])
  assert.ok(!/\nG0 [AXY]0\.000\n/.test(zero.gcode), 'a program that ends at 0 writes no extra A rapid')
}

// ── 17. the final motion is the retract a non-rotary program uses ─
//
// #1091: removing the closing unwind must not remove or move the last
// operation's retract. The same toolpath, angle-free and at a constant angle,
// ends with the identical final motion — the operation's own retract.
{
  const project = projectWith(bar())
  const moves: ToolpathMove[] = [
    { kind: 'rapid', from: at(0, 10, 30), to: at(10, 10, 30) },
    { kind: 'cut', from: at(10, 10, 30), to: at(10, 10, 20) },
    { kind: 'rapid', from: at(10, 10, 20), to: at(10, 10, 30) },
  ]
  const flat = exportProgram(project, GRBL, [{ operation: operation('Retract'), moves }])
  const turned = exportProgram(project, rotaryMachine(OWN_AXIS), [{
    operation: operation('Retract'),
    moves: established(moves.map((move) => ({
      ...move,
      from: { ...move.from, a: 45 },
      to: { ...move.to, a: 45 },
    }))),
  }])
  const lastMotion = (program: string): string => {
    const axis = motionLines(program).filter((line) => /[XYZ]/.test(line))
    assert.ok(axis.length > 0, 'the program has axis motion')
    return axis[axis.length - 1]
  }
  assert.equal(lastMotion(turned.gcode), lastMotion(flat.gcode),
    'the rotary program ends with the identical retract a non-rotary program uses')
  const retractZ = Number(lastMotion(turned.gcode).match(/Z(-?[0-9.]+)/)![1])
  assert.ok(retractZ > 0, `the retract is above the cut depth, got Z${retractZ}`)
  assert.doesNotMatch(lastMotion(turned.gcode), /A/, 'and the retract carries no angle word')
}

console.log('engine/gcode/rotaryOutput.test.ts: all assertions passed')
