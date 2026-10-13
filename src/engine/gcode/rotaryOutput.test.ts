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
import type { BlockStock, MachineOrigin, Operation, Project, RoundStock, Stock } from '../../types/project'
import { BUNDLED_DEFINITIONS } from './definitions'
import { normalizeToolForProject } from '../toolpaths/geometry'
import { runPostProcessor } from './postprocessor'
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
import type { ToolpathMove, ToolpathPoint, ToolpathResult } from '../toolpaths/types'
import { exportGeometryTolerance } from '../../utils/units'

// ── fixtures ──────────────────────────────────────────────────

const byId = (id: string): MachineDefinition => {
  const raw = BUNDLED_DEFINITIONS.find((definition) => definition.id === id)
  assert.ok(raw, `bundled definition ${id} exists`)
  return validateMachineDefinition(raw)
}

const GRBL = byId('grbl')

/** The bundled grbl definition plus a rotary block. */
function rotaryMachine(
  rotary: RotaryDefinition,
  coordinateSystem: MachineDefinition['coordinateSystem'] = GRBL.coordinateSystem,
): MachineDefinition {
  return validateMachineDefinition({ ...structuredClone(GRBL), rotary, coordinateSystem })
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
  entries: Array<{ operation: Operation; moves: ToolpathMove[] }>,
): PostProcessorResult {
  const tools = new Map(project.tools.map((tool) => [tool.id, normalizeToolForProject(tool, project)]))
  return runPostProcessor({
    project,
    definition,
    operations: entries.map(({ operation: op, moves }) => {
      const tool = tools.get(op.toolRef ?? '')
      assert.ok(tool, `tool ${op.toolRef} exists in the project`)
      return { operation: op, tool, toolpath: toolpathOf(op, moves) }
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
  // changes here, and its letter carries the angle instead.
  const moves: ToolpathMove[] = [
    { kind: 'cut', from: at(0, 10, 30, 0), to: at(20, 10, 30, 45) },
  ]
  const result = exportProgram(project, rotaryMachine(BORROWED_Y), [{ operation: op, moves }])
  const turning = motionLines(result.gcode).filter((line) => /Y-?[0-9]/.test(line))
  assert.equal(turning.length, 1, `one turning block, got:\n${motionLines(result.gcode).join('\n')}`)
  assert.match(turning[0], /Y45\b/, 'the angle is written under the borrowed motor letter')
  assert.equal((turning[0].match(/Y-?[0-9.]+/g) ?? []).length, 1,
    'the borrowed letter is written once, as the angle — never twice as a linear value')

  // A negative borrowed output reverses the rotation, exactly as `reversed`
  // does on its own axis.
  const mirrored = rotaryMachine(BORROWED_Y, { ...GRBL.coordinateSystem, yAxis: '-Y' })
  const mirroredResult = exportProgram(project, mirrored, [{ operation: op, moves }])
  const mirroredTurning = motionLines(mirroredResult.gcode).filter((line) => /Y-?[0-9]/.test(line))
  assert.match(mirroredTurning[0], /Y-45\b/, 'a mirrored borrowed output flips the sign')
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
    moves: circleMoves(0, 10, 5, 20, 16, (index) => index * 10),
  }]).gcode
  // `G[23]\b` and not `G2|G3`: the units command `G21` also starts with `G2`.
  assert.doesNotMatch(turning, /G[23]\b/, 'a turning move is never merged into an arc')

  const constant = exportProgram(project, definition, [{
    operation: operation('Flat', { arcFittingEnabled: true }),
    moves: circleMoves(0, 10, 5, 20, 16, () => 45),
  }]).gcode
  assert.match(constant, /G[23]\b/, 'the same points at a constant angle still fit an arc')

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
  // exactly 10 mm from it.
  const moves: ToolpathMove[] = [
    { kind: 'cut', from: at(0, 10, 20, 0), to: at(0, 10, 20, 90) },
  ]
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
  const moves: ToolpathMove[] = [{ kind: 'cut', from: at(0, 10, 15, 0), to: at(0, 10, 15, 90) }]
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
  const moves: ToolpathMove[] = [{ kind: 'cut', from, to }]
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
// centreline. It plunges while it turns, so the path length is `sqrt(linear² +
// (meanRadius × Δθ)²)` — the mean of the two end radii, not either one. The
// expected word is computed here from first principles, never by calling the
// implementation. The bar's centreline sits at Z = 10 for a 20 mm bar, so the
// move runs from 10 mm above it to 5 mm above it.
{
  const project = projectWith(bar())
  const from = at(0, 10, 20, 0)
  const to = at(0, 10, 15, 90)
  const result = exportProgram(project, rotaryMachine(OWN_AXIS), [{
    operation: operation('PlungingTurn'), moves: [{ kind: 'cut', from, to }],
  }])
  const line = lineWithWord(result.gcode, /A90\b/)
  assert.ok(line, `the plunging turning move is emitted:\n${motionLines(result.gcode).join('\n')}`)
  const linear = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z)
  const meanRadius = (10 + 5) / 2
  const expected = FEED / Math.hypot(linear, meanRadius * NINETY)
  assert.equal(Number(line.match(/F([-0-9.]+)/)?.[1]), Number(expected.toFixed(3)),
    'the emitted F is feed / sqrt(linear^2 + (mean radius x angle)^2)')
  // Neither end's radius alone would produce this word.
  assert.notEqual(Number(line.match(/F([-0-9.]+)/)?.[1]), Number((FEED / Math.hypot(linear, 5 * NINETY)).toFixed(3)),
    'the end radius alone would give a different word')
}

// Two turning moves with the same sweep and radius carry the same inverse-time
// word. grbl's `modalFeedSpeed` would drop the second F as modal; rule 4 says
// every inverse-time move writes its own, so it must appear twice.
{
  const project = projectWith(bar())
  const moves: ToolpathMove[] = [
    { kind: 'cut', from: at(0, 10, 20, 0), to: at(0, 10, 20, 90) },
    { kind: 'cut', from: at(0, 10, 20, 90), to: at(0, 10, 20, 180) },
  ]
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
// feed come back before a non-turning feed move, a rapid turning move has no
// F, and the program ends out of inverse time.
{
  const project = projectWith(bar())
  const moves: ToolpathMove[] = [
    { kind: 'rapid', from: at(0, 10, 30, 0), to: at(0, 10, 30, 45) },
    { kind: 'cut', from: at(0, 10, 30, 45), to: at(0, 10, 30, 90) },
    { kind: 'cut', from: at(0, 10, 30, 90), to: at(0, 10, 30, 180) },
    { kind: 'cut', from: at(0, 10, 30, 180), to: at(5, 10, 30, 180) },
  ]
  const result = exportProgram(project, rotaryMachine(OWN_AXIS), [{
    operation: operation('Discipline'), moves,
  }])
  const lines = motionLines(result.gcode)

  // The rapid carries the angle but no feed word. The angle rides the block
  // that is emitted last — the XY block when Z is unchanged — so the word can
  // be on a modal block with no G0 of its own.
  const rapid = lines.find((line) => /A45\b/.test(line))
  assert.ok(rapid, `the rapid is a turning move:\n${lines.join('\n')}`)
  assert.doesNotMatch(rapid, /F[-0-9]/, 'a rapid turning move has no F word')

  // Both turning feed moves carry their own F, even though the second changes
  // the angle from the first. The block spells the motion word, its axis words
  // and the angle word together.
  const turning = lines.filter((line) => /A(90|180)\b/.test(line))
  assert.equal(turning.length, 2, `two turning feed moves:\n${lines.join('\n')}`)
  for (const line of turning) assert.match(line, /F[-0-9]/, 'every inverse-time move carries its own F')
  assert.match(lines.find((line) => /^G1 /.test(line)) ?? '', /X\S.*A/, 'a turning feed writes G1 with an axis and the angle')

  // G94 and the ordinary feed come back before the straight move. The motion
  // word stays modal, so the block carries only its axes.
  const straight = lines.find((line) => /X5\b/.test(line))
  assert.ok(straight, `the straight feed move is emitted:\n${lines.join('\n')}`)
  assert.match(straight, /F600\b/, 'the ordinary feed is restated after inverse time')
  const g94 = lines.indexOf('G94')
  assert.ok(g94 > -1 && g94 < lines.indexOf(straight), 'G94 is written before the straight move')

  // The straight move left inverse-time mode, so no turning move follows the
  // final G94 and the program is already out of it.
  const last = lines.lastIndexOf('G94')
  assert.ok(lines.slice(last + 1).every((line) => !/A-?[0-9]/.test(line)),
    `no turning move follows the final G94:\n${lines.join('\n')}`)
}

// A program whose last feed move turns switches inverse time off before the
// footer (rule 4: the program never ends in inverse-time mode).
{
  const project = projectWith(bar())
  const result = exportProgram(project, rotaryMachine(OWN_AXIS), [{
    operation: operation('EndsTurning'),
    moves: [{ kind: 'cut', from: at(0, 10, 20, 0), to: at(0, 10, 20, 90) }],
  }])
  assert.match(result.gcode, /G94\nM30/, 'a program ending while turning switches the mode off first')
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
  // the same height (0, 10, 20) is exactly 10 mm out.
  const atRadius = inverseTimeFeedValue(at(0, 0, 20), at(0, 0, 20, 90), 600, centre, tolerance)
  assert.equal(atRadius, 600 / (Math.hypot(10, 10) * NINETY), 'the across-axis offset is measured')
  const heightOnly = inverseTimeFeedValue(at(0, 10, 20), at(0, 10, 20, 90), 600, centre, tolerance)
  assert.equal(heightOnly, 600 / (10 * NINETY), 'a point above the centreline is 10 mm out')
  assert.notEqual(atRadius, heightOnly, 'ignoring the across-axis offset would give the wrong word')
}

// The mean of the move's two end radii, when they differ: a turning move that
// also plunges towards the centreline. Neither end's radius alone gives the
// right path length, so this pins the mean (`turningRadius(from)` and
// `turningRadius(to)` both fail it).
{
  const centre = rotaryCentreline(bar())
  assert.ok(centre, 'a round bar has a centreline')
  const tolerance = exportGeometryTolerance('mm')

  // A turning move that plunges: 10 mm above the centreline at the start, 5 mm
  // at the end, sweeping 90 degrees.
  const from = at(0, 10, 20, 0)
  const to = at(0, 10, 15, 90)
  const linear = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z)
  const meanRadius = (10 + 5) / 2
  const expected = 600 / Math.hypot(linear, meanRadius * NINETY)
  const plunging = inverseTimeFeedValue(from, to, 600, centre, tolerance)
  assert.equal(plunging, expected, 'the path length uses the mean of the two end radii')
  assert.notEqual(plunging, 600 / Math.hypot(linear, 5 * NINETY),
    'the end radius alone would give a different word')
  assert.notEqual(plunging, 600 / Math.hypot(linear, 10 * NINETY),
    'the start radius alone would give a different word')

  // The same in the other direction: a turning move that rises from 5 mm to
  // 10 mm while also moving along the bar, so a mean is not accidentally the
  // larger end and the linear travel is not along the bar's own axis.
  const rising = inverseTimeFeedValue(at(0, 10, 15, 0), at(4, 10, 20, 90), 600, centre, tolerance)
  const risingLinear = Math.hypot(4, 0, 5)
  assert.equal(rising, 600 / Math.hypot(risingLinear, meanRadius * NINETY),
    'the mean is the same whichever end is nearer the centreline, and the linear travel is kept')
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
    assert.doesNotMatch(result.gcode, /A90\b/, 'the refused operation emits no motion')
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

  // Every refusal blocks a save, not merely annotates one.
  for (const code of ['postRotaryNoAxis', 'postRotaryNoInverseTime', 'postRotaryBorrowedAxisTravel', 'postRotaryNeedsRoundStock'] as const) {
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
    moves: [{ kind: 'cut', from: at(0, 10, 20, 0), to: at(0, 10, 15, 90) }],
  }])
  assert.match(normal.gcode, /A90\b/, 'a well-paired export still emits its angle')
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

console.log('engine/gcode/rotaryOutput.test.ts: all assertions passed')
