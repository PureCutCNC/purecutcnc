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
import { validateMachineDefinition } from './types'
import type { MachineDefinition, PostProcessorResult, RotaryDefinition } from './types'
import { warningSeverity } from '../toolpaths/warningCodes'
import {
  createArcEmitOptions,
  inverseTimeFeedValue,
  planOperationMotion,
  planRotaryRefusals,
  rotaryCentreline,
} from './motionPipeline'
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

  // The rapid carries the angle but no feed word.
  const rapid = lines.find((line) => line.startsWith('G0') && /A45\b/.test(line))
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
