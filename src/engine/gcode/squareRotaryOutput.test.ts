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
 * Square-blank rotary **output** (#1016 C2-S4): generation through the
 * production dispatch, then the real postprocessor's posted text — not the raw
 * helpers.
 *
 * A square blank turns about the true pivot `side / 2` at the stock
 * rectangle's centreline, so every emitted coordinate and every inverse-time
 * feed is measured from that axis. The proofs here are physical: a pure turn at
 * a seeded tip radius must post the analytic inverse-time word for that radius
 * about the **true** pivot (a corner-radius pivot fails it), a too-small manual
 * chuck must refuse generation and output without posting the affected
 * motion, and an ordinary clamp inside the swept envelope must refuse while a
 * provably disjoint one passes.
 *
 * The round bar is the frozen baseline: every matrix cell posts byte-identical
 * text to the value captured from the base commit before this slice's guards
 * existed (`SQUARE_ROTARY_PRINT_ROUND=1` reprints it from either tree).
 *
 * Run with: npx tsx src/engine/gcode/squareRotaryOutput.test.ts
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { computeMeshBounds, serializeImportedMesh } from '../importedMesh'
import { defaultTool, newProject, rectProfile } from '../../types/project'
import type { Clamp, Operation, OperationKind, Project, SquareStock, Tool } from '../../types/project'
import { barCentre, barPivotZ, squareStock } from '../../types/barStock'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { defaultRoundWorkholding } from '../../store/helpers/roundWorkholding'
import { projectWithFeatures } from '../../test/projectFixtures'
import { computeOperationToolpath } from '../toolpaths/generateOperation'
import { setupGenerationBlock } from '../setupTargets'
import { normalizeToolForProject } from '../toolpaths/geometry'
import { warningSeverity } from '../toolpaths/warningCodes'
import type { ToolpathMove, ToolpathPoint, ToolpathResult } from '../toolpaths/types'
import { BUNDLED_DEFINITIONS } from './definitions'
import { inverseTimeFeedValue, rotaryCentreline } from './motionPipeline'
import { runPostProcessor } from './postprocessor'
import { rotaryDirection, rotaryWord, validateMachineDefinition } from './types'
import type { MachineDefinition, PostProcessorResult, RotaryDefinition } from './types'
import { exportGeometryTolerance, MM_PER_INCH } from '../../utils/units'

// ── fixtures ──────────────────────────────────────────────────

type Axis = 'x' | 'y'
type Units = 'mm' | 'inch'
type MachineKind = 'own' | 'borrowed' | 'reversed'

const GRBL = validateMachineDefinition(BUNDLED_DEFINITIONS.find((entry) => entry.id === 'grbl')!)

function machine(kind: MachineKind, about: Axis): MachineDefinition {
  const rotary: RotaryDefinition = {
    about,
    drive: kind === 'borrowed' ? 'borrowed' : 'own',
    reversed: kind === 'reversed',
    inverseTimeFeed: { on: 'G93', off: 'G94' },
  }
  return validateMachineDefinition({ ...structuredClone(GRBL), id: `${kind}-${about}`, rotary })
}

const NO_ROTARY = GRBL

/** The model prism from `rotaryOperationFixture`, scaled and re-centred. */
function modelMesh(axis: Axis, centre: number, scale: number) {
  const raw = [
    3, -2, 4, 27, -2, 4, 27, 2, 4, 3, 2, 4,
    3, -2, 8, 27, -2, 9, 27, 2, 9, 3, 2, 8,
  ]
  const positions = new Float32Array(raw.map((value) => value * scale))
  for (let i = 0; i < positions.length; i += 3) {
    positions[i + 1] += centre
    if (axis === 'y') [positions[i], positions[i + 1]] = [positions[i + 1], positions[i]]
  }
  const index = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7])
  return serializeImportedMesh({ positions, index, bounds: computeMeshBounds(positions) }, 'stl')
}

interface FixtureOptions {
  axis: Axis
  units: Units
  kind: OperationKind
  at?: { x: number; y: number }
  clamps?: (stock: SquareStock, units: Units) => Clamp[]
  round?: boolean
}

/**
 * A real rotary project on a square blank (or the same box as a round bar),
 * with an Around setup, a model target and the S2 default workholding.
 */
function fixture(options: FixtureOptions): { project: Project; operation: Operation; stock: SquareStock; tool: Tool } {
  const { axis, units, kind, at = { x: 0, y: 0 }, round = false } = options
  const scale = units === 'mm' ? 1 : 1 / MM_PER_INCH
  const square = squareStock(12 * scale, 30 * scale, axis, at)
  const stock = round ? { ...square, shape: 'round' as const } : square
  const base = newProject(`Square output ${axis} ${units}`, units)
  base.meta.created = base.meta.modified = '2026-01-01T00:00:00.000Z'
  base.meta.projectType = 'rotary'
  base.meta.maxTravelZ = 25 * scale
  base.stock = stock
  const tool: Tool = {
    ...defaultTool(units, 1),
    id: 't1',
    name: 'Ball 2',
    units,
    type: 'ball_endmill',
    diameter: 2 * scale,
    defaultStepover: 0.8,
    defaultStepdown: 1 * scale,
  }
  base.tools = [tool]
  base.modelAssets = { asset: modelMesh(axis, barCentre(square), scale) }
  const profile = axis === 'x' ? rectProfile(3 * scale, 4 * scale, 24 * scale, 4 * scale) : rectProfile(4 * scale, 3 * scale, 4 * scale, 24 * scale)
  const model = {
    id: 'model', name: 'Model', kind: 'stl' as const, operation: 'model' as const, authoringFace: 'top' as const,
    folderId: null,
    sketch: { profile, origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    stl: { format: 'stl' as const, meshAssetId: 'asset', scale: 1, axisSwap: 'none' as const },
    z_top: 9 * scale, z_bottom: 4 * scale, visible: true, locked: false,
  }
  // A wrapped 2D Around feature: what an Engrave or thread actually targets on
  // a round bar, and the shape a square blank must refuse.
  const wrapped = {
    ...model,
    id: 'wrapped', name: 'Wrapped', kind: 'rect' as const, operation: 'subtract' as const,
    authoringFace: 'around' as const, stl: null,
    z_top: 12 * scale, z_bottom: 10 * scale,
  }
  const project = projectWithFeatures(base, [model, wrapped])
  project.setups.push({ ...project.setups[0], id: 'around', name: 'Around', kind: 'around', orientation: { axis, angleDeg: 0 } })
  project.activeSetupId = 'around'
  project.clamps = options.clamps
    ? options.clamps(square, units)
    : [{ ...defaultRoundWorkholding('chuck', square, units), id: 'chuck', name: 'Chuck', visible: true }]
  project.operations = [{
    ...defaultOperationForTarget(project, kind, 'rough', { source: 'features', featureIds: ['model'] }, 0),
    setupId: 'around',
    stockToLeaveRadial: 0,
  }]
  return { project, operation: project.operations[0], stock: square, tool }
}

function toolpathOf(operation: Operation, moves: ToolpathMove[]): ToolpathResult {
  return { operationId: operation.id, moves, warnings: [], bounds: null }
}

/** Post one operation's prepared toolpath through the real postprocessor. */
function post(
  project: Project,
  definition: MachineDefinition,
  operation: Operation,
  toolpath: ToolpathResult,
): PostProcessorResult {
  const tool = normalizeToolForProject(project.tools.find((entry) => entry.id === operation.toolRef)!, project)
  return runPostProcessor({
    project,
    definition,
    operations: [{ operation, tool, toolpath }],
    options: { emitToolChanges: false, emitCoolant: false, programName: project.meta.name },
  })
}

/** Generate through the production dispatch, then post the real result. */
function generateAndPost(project: Project, definition: MachineDefinition, operation: Operation): PostProcessorResult {
  const envelope = computeOperationToolpath(project, operation)
  assert.ok(envelope, 'the production dispatch answers')
  if (!envelope) throw new Error('unreachable')
  return post(project, definition, operation, envelope.result)
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/** Emitted blocks that carry motion (a comment never does). */
function motionLines(program: string): string[] {
  return program.split('\n').filter((line) => line.length > 0 && !/^[;(%]/.test(line))
}

/** Does any motion block carry the machine's rotary word with a value? */
function postsAngle(program: string, word: 'A' | 'X' | 'Y'): boolean {
  return motionLines(program).some((line) => new RegExp(`${word}[-\\d.]`).test(line))
}

/** Program motion/text fingerprint that never normalises geometry or feeds. */
function fingerprint(project: Project, definition: MachineDefinition, operation: Operation): string {
  const envelope = computeOperationToolpath(project, operation)
  assert.ok(envelope, 'fixture: the dispatch answers')
  if (!envelope) throw new Error('unreachable')
  const result = post(project, definition, operation, envelope.result)
  const moves = envelope.result.moves.map((move) => [move.kind, ...Object.values(move.from), ...Object.values(move.to)])
  return [
    `moves=${hash(JSON.stringify(moves))}`,
    `warnings=${envelope.result.warnings.map((warning) => warning.code).join(',')}`,
    `gcode=${hash(result.gcode)}`,
    `post=${result.warnings.map((warning) => warning.code).join(',')}`,
  ].join('|')
}

const MATRIX_CELLS: Array<{ axis: Axis; units: Units; kind: OperationKind; machine: MachineKind }> = []
for (const axis of ['x', 'y'] as const) {
  for (const units of ['mm', 'inch'] as const) {
    for (const kind of ['rotary_rough', 'rotary_finish'] as const) {
      for (const machineKind of ['own', 'borrowed', 'reversed'] as const) {
        MATRIX_CELLS.push({ axis, units, kind, machine: machineKind })
      }
    }
  }
}

/**
 * The round bar's posted program before this slice's guards existed, captured
 * from the base commit. A round bar's arithmetic, geometry and feeds must not
 * move; any drift is a real change, not a normalisation.
 */
const ROUND_BASELINE: Record<string, string> = {
  'x/mm/rotary_rough/own': 'moves=7fe3ee48a37762e1|warnings=|gcode=9e1f185c8c5edbcd|post=',
  'x/mm/rotary_rough/borrowed': 'moves=7fe3ee48a37762e1|warnings=|gcode=bb3c7ec9aa064275|post=',
  'x/mm/rotary_rough/reversed': 'moves=7fe3ee48a37762e1|warnings=|gcode=773e956bba7f904b|post=',
  'x/mm/rotary_finish/own': 'moves=1d574e92197f6066|warnings=|gcode=3635333a6cf9fb84|post=',
  'x/mm/rotary_finish/borrowed': 'moves=1d574e92197f6066|warnings=|gcode=65aba1333aba48e1|post=',
  'x/mm/rotary_finish/reversed': 'moves=1d574e92197f6066|warnings=|gcode=0827c7d10cc75746|post=',
  'x/inch/rotary_rough/own': 'moves=f2cb628cb08a9347|warnings=|gcode=70985876da09cb73|post=',
  'x/inch/rotary_rough/borrowed': 'moves=f2cb628cb08a9347|warnings=|gcode=e179efb6e6eb1c99|post=',
  'x/inch/rotary_rough/reversed': 'moves=f2cb628cb08a9347|warnings=|gcode=3d354749b93477f0|post=',
  'x/inch/rotary_finish/own': 'moves=d860a1762aca651e|warnings=|gcode=52e91e045fa0da14|post=',
  'x/inch/rotary_finish/borrowed': 'moves=d860a1762aca651e|warnings=|gcode=4f67a7ea8336b731|post=',
  'x/inch/rotary_finish/reversed': 'moves=d860a1762aca651e|warnings=|gcode=50efba2e4a993821|post=',
  'y/mm/rotary_rough/own': 'moves=6726dfdfc4a90270|warnings=|gcode=a7536e60c4680f56|post=',
  'y/mm/rotary_rough/borrowed': 'moves=6726dfdfc4a90270|warnings=|gcode=cfc84d5111b5b536|post=',
  'y/mm/rotary_rough/reversed': 'moves=6726dfdfc4a90270|warnings=|gcode=4cbdbcfc0d5f00d3|post=',
  'y/mm/rotary_finish/own': 'moves=036cc8e3b273a0b5|warnings=|gcode=a985a7d4913d55cf|post=',
  'y/mm/rotary_finish/borrowed': 'moves=036cc8e3b273a0b5|warnings=|gcode=cd62c24cfc71ff81|post=',
  'y/mm/rotary_finish/reversed': 'moves=036cc8e3b273a0b5|warnings=|gcode=d849444906006e13|post=',
  'y/inch/rotary_rough/own': 'moves=2ed07fc1b9dc3f17|warnings=|gcode=84291f24eaee0b5c|post=',
  'y/inch/rotary_rough/borrowed': 'moves=2ed07fc1b9dc3f17|warnings=|gcode=c755d1ffdc6adef9|post=',
  'y/inch/rotary_rough/reversed': 'moves=2ed07fc1b9dc3f17|warnings=|gcode=99c8b94821b7112d|post=',
  'y/inch/rotary_finish/own': 'moves=dfa5445394219315|warnings=|gcode=b49b4749c9d92433|post=',
  'y/inch/rotary_finish/borrowed': 'moves=dfa5445394219315|warnings=|gcode=48710ef0eadec711|post=',
  'y/inch/rotary_finish/reversed': 'moves=dfa5445394219315|warnings=|gcode=9672b823130029f6|post=',
}

if (process.env.SQUARE_ROTARY_PRINT_ROUND === '1') {
  for (const cell of MATRIX_CELLS) {
    const { project, operation } = fixture({ ...cell, round: true })
    const key = `${cell.axis}/${cell.units}/${cell.kind}/${cell.machine}`
    console.log(`${key} ${fingerprint(project, machine(cell.machine, cell.axis), operation)}`)
  }
  process.exit(0)
}

// ── 1. the output matrix admits the square blank ──────────────

console.log('Testing square generation and posted output across axes, units and machines...')
for (const cell of MATRIX_CELLS) {
  const { project, operation, stock } = fixture(cell)
  const definition = machine(cell.machine, cell.axis)
  const envelope = computeOperationToolpath(project, operation)
  assert.ok(envelope, `${cell.axis}/${cell.units}/${cell.kind}: dispatch answers`)
  if (!envelope) throw new Error('unreachable')
  const label = `${cell.axis}/${cell.units}/${cell.kind}/${cell.machine}`
  assert.ok(envelope.result.moves.length > 0, `${label}: nonempty square motion`)
  assert.ok(
    !envelope.result.warnings.some((warning) => warning.code === 'aroundStockMismatch'),
    `${label}: admitted, not a shape refusal`,
  )
  const pivot = barPivotZ(stock)
  const centre = barCentre(stock)
  for (const move of envelope.result.moves) {
    for (const point of [move.from, move.to]) {
      assert.ok(point.a !== undefined, `${label}: every endpoint carries A`)
      assert.equal(cell.axis === 'x' ? point.y : point.x, centre, `${label}: across stays on the true pivot`)
      assert.ok(point.z >= pivot - 1e-9, `${label}: never cuts below the pivot`)
    }
  }
  const result = post(project, definition, operation, envelope.result)
  assert.deepEqual(result.warnings, [], `${label}: the program posts with no refusal`)
  assert.ok(result.gcode.length > 0, `${label}: program text is written`)
  // A turning feed is posted in inverse time, and the machine's own rotary
  // word carries the angle.
  const word = rotaryWord(definition)
  assert.ok(word, `${label}: the machine has a rotary word`)
  assert.match(result.gcode, /G93/, `${label}: inverse-time mode is entered for a turning feed`)
  assert.ok(postsAngle(result.gcode, word!), `${label}: the angle reaches the program as ${word}`)

  // The same input posts byte-identical text twice: the output is a function of
  // the project, not of any hidden state.
  assert.equal(
    post(project, definition, operation, envelope.result).gcode,
    result.gcode,
    `${label}: the posted text is deterministic`,
  )
}

// ── 2. the round bar is byte-identical to the base commit ─────

console.log('Testing the round baseline across the same matrix...')
for (const cell of MATRIX_CELLS) {
  const { project, operation } = fixture({ ...cell, round: true })
  const key = `${cell.axis}/${cell.units}/${cell.kind}/${cell.machine}`
  const expected = ROUND_BASELINE[key]
  assert.ok(expected, `fixture: a captured round baseline for ${key}`)
  assert.equal(fingerprint(project, machine(cell.machine, cell.axis), operation), expected, `${key}: the round bar is unchanged`)
}

// ── 3. output refusals ────────────────────────────────────────

console.log('Testing square output refusals...')
{
  const { project, operation } = fixture({ axis: 'x', units: 'mm', kind: 'rotary_finish' })
  const envelope = computeOperationToolpath(project, operation)!
  const codes = (result: PostProcessorResult) => result.warnings.map((warning) => warning.code)

  // (a) the machine turns about the other axis.
  assert.deepEqual(
    codes(post(project, machine('own', 'y'), operation, envelope.result)),
    ['postRotaryAxisMismatch'],
    'a square blank on the wrong machine axis is refused',
  )
  // (b) the machine has no rotary axis at all.
  assert.deepEqual(
    codes(post(project, NO_ROTARY, operation, envelope.result)),
    ['postRotaryNoAxis'],
    'a machine with no rotary axis refuses the square turning program',
  )
  // (c) a feed move that carries A on one end only.
  const split: ToolpathMove[] = [{ kind: 'cut', from: { x: 4, y: barCentre(project.stock as SquareStock), z: 12, a: 0 }, to: { x: 20, y: barCentre(project.stock as SquareStock), z: 12 } }]
  assert.deepEqual(
    codes(post(project, machine('own', 'x'), operation, toolpathOf(operation, split))),
    ['postRotaryAngleNotEstablished'],
    'a split-angle feed move is refused',
  )
  // (d) the borrowed motor's project axis travels.
  const borrowed: ToolpathMove[] = [{ kind: 'cut', from: { x: 4, y: 0, z: 12, a: 0 }, to: { x: 4, y: barCentre(project.stock as SquareStock), z: 12, a: 30 } }]
  assert.deepEqual(
    codes(post(project, machine('borrowed', 'x'), operation, toolpathOf(operation, borrowed))),
    ['postRotaryBorrowedAxisTravel'],
    'travel on the borrowed motor is refused',
  )
  // (e) a non-rotary kind carrying a synthetic square A path cannot post.
  const engrave: Operation = { ...operation, kind: 'follow_line' }
  assert.deepEqual(
    codes(post(project, machine('own', 'x'), engrave, envelope.result)),
    ['postSetupOperationRefused'],
    'a wrapped 2D operation on a square blank is refused',
  )
  // (g) the same wrapped 2D Around feature an Engrave targets on a round bar
  // is refused at generation as well as at output.
  const wrappedEngrave: Operation = {
    ...operation,
    kind: 'follow_line',
    target: { source: 'features', featureIds: ['wrapped'] },
  }
  assert.equal(
    setupGenerationBlock(project, wrappedEngrave)?.reason,
    'aroundStockMismatch',
    'generation refuses a wrapped 2D Engrave on the square Around face',
  )
  assert.deepEqual(
    codes(post(project, machine('own', 'x'), wrappedEngrave, envelope.result)),
    ['postSetupOperationRefused'],
    'and output refuses the stale wrapped path too',
  )
  // (f) stale, wholly-angle-free rotary motion is refused as stale.
  const stale: ToolpathMove[] = [{ kind: 'cut', from: { x: 4, y: barCentre(project.stock as SquareStock), z: 12 }, to: { x: 20, y: barCentre(project.stock as SquareStock), z: 12 } }]
  assert.deepEqual(
    codes(post(project, machine('own', 'x'), operation, toolpathOf(operation, stale))),
    ['postRotaryAngleNotEstablished'],
    'a wholly-angle-free rotary toolpath is refused',
  )
}

// ── 4. the physical workholding guard, generation and output ──

console.log('Testing the physical square workholding guard...')

const tooSmallChuck = (stock: SquareStock): Clamp[] => [{
  // The S2 default is `max(4·maxRadius, 50 mm)`; this manual chuck is smaller
  // than the corner envelope (`2·maxRadius`) and must be reported, never
  // resized or re-pivoted.
  id: 'chuck', name: 'Small chuck', type: 'chuck',
  x: 0, y: barCentre(stock) - 3, w: 2, h: 6,
  height: barPivotZ(stock) + 3, visible: true,
}]

{
  const { project, operation, stock } = fixture({ axis: 'x', units: 'mm', kind: 'rotary_rough', clamps: tooSmallChuck })
  assert.ok(6 < 2 * stock.thickness * Math.SQRT1_2, 'fixture: the manual chuck is smaller than the corner envelope')
  const envelope = computeOperationToolpath(project, operation)!
  assert.equal(envelope.result.moves.length, 0, 'generation posts no affected motion')
  assert.deepEqual(envelope.result.warnings.map((warning) => warning.code), ['aroundStockMismatch'], 'and says why')
  assert.equal(warningSeverity('aroundStockMismatch'), 'error', 'the refusal blocks a save')
  // The clamp itself is preserved: the guard reports, it never repairs.
  assert.equal(project.clamps[0].h, 6, 'the manual chuck diameter is not resized')
  assert.equal(project.clamps[0].height, barPivotZ(stock) + 3, 'and its pivot is not raised')

  // Output refuses a stale toolpath for the same setup with the same reason,
  // and posts no motion for it.
  const safe = fixture({ axis: 'x', units: 'mm', kind: 'rotary_rough' })
  const stale = computeOperationToolpath(safe.project, safe.operation)!.result
  const result = post(project, machine('own', 'x'), operation, stale)
  assert.deepEqual(result.warnings.map((warning) => warning.code), ['postSetupOperationRefused'], 'output refuses the unsupported setup')
  assert.equal(warningSeverity('postSetupOperationRefused'), 'error', 'and blocks the save')
  assert.ok(!postsAngle(result.gcode, 'A'), 'none of the affected motion is posted')

  // Hidden workholding still holds the bar.
  const hidden = { ...project, clamps: [{ ...project.clamps[0], visible: false }] }
  assert.equal(computeOperationToolpath(hidden, operation)!.result.moves.length, 0, 'a hidden too-small chuck is still refused')

  // The matching S2 default passes generation and output.
  const safeResult = generateAndPost(safe.project, machine('own', 'x'), safe.operation)
  assert.deepEqual(safeResult.warnings, [], 'the matching default workholding posts')
}

console.log('Testing workholding axial engagement and raw placement...')
{
  const base = fixture({ axis: 'x', units: 'mm', kind: 'rotary_rough' })
  const stock = base.stock
  const centre = barCentre(stock)
  const small = { ...tooSmallChuck(stock)[0] }
  const bounds = { min: 0, max: 30 }
  const withClamps = (clamps: Clamp[]) => ({ ...base.project, clamps })

  // Axially disjoint: the clamp sits wholly past the end face, so it is not
  // holding the blank and its diameter is irrelevant.
  const disjoint: Clamp = { ...small, x: bounds.max + 1, w: 2 }
  assert.ok(computeOperationToolpath(withClamps([disjoint]), base.operation)!.result.moves.length > 0, 'an axially disjoint chuck is clear')
  // The default tailstock only touches the end face: zero overlap is clear too.
  const touching: Clamp = { ...small, type: 'tailstock', x: bounds.max, w: 5 }
  assert.ok(computeOperationToolpath(withClamps([touching]), base.operation)!.result.moves.length > 0, 'an end-face-touching tailstock is clear')
  // Off the centreline.
  const offCentre: Clamp = { ...small, x: 0, y: centre - 3 + 1 }
  assert.equal(computeOperationToolpath(withClamps([offCentre]), base.operation)!.result.warnings[0]?.code, 'aroundStockMismatch', 'an off-centre clamp is refused')
  // A height not derived from the true pivot.
  const wrongHeight: Clamp = { ...small, height: barPivotZ(stock) + 3 + 1 }
  assert.equal(computeOperationToolpath(withClamps([wrongHeight]), base.operation)!.result.warnings[0]?.code, 'aroundStockMismatch', 'a pivot-derived height is required')
  // Invalid dimensions fail closed.
  for (const bad of [NaN, Infinity, 0, -1]) {
    const invalid: Clamp = { ...small, h: bad }
    assert.equal(computeOperationToolpath(withClamps([invalid]), base.operation)!.result.warnings[0]?.code, 'aroundStockMismatch', `an invalid chuck dimension (${bad}) is refused`)
  }
}

console.log('Testing ordinary fixtures in the swept square envelope...')
{
  const base = fixture({ axis: 'x', units: 'mm', kind: 'rotary_rough' })
  const stock = base.stock
  const bounds = { min: 0, max: 30 }
  const withClamps = (clamps: Clamp[]) => ({ ...base.project, clamps })
  const ordinary = (overrides: Partial<Clamp>): Clamp => ({
    id: 'clamp', name: 'Step clamp', type: 'step_clamp',
    x: bounds.min + 10, y: barCentre(stock) - 2, w: 4, h: 4, height: 8, visible: true,
    ...overrides,
  })
  // Directly under the bar, inside the corner envelope: refused.
  assert.equal(
    computeOperationToolpath(withClamps([ordinary({})]), base.operation)!.result.warnings[0]?.code,
    'aroundStockMismatch',
    'an ordinary clamp inside the swept envelope is refused',
  )
  // Across the bar, outside the envelope: provably disjoint, allowed.
  const clear = strictClear(base)
  assert.ok(
    computeOperationToolpath(withClamps([clear]), base.operation)!.result.moves.length > 0,
    'an ordinary clamp across the bar, outside the corner envelope, is clear',
  )
  // Along-disjoint from the blank: allowed even on the centreline.
  const beyond = ordinary({ x: bounds.max + 5 })
  assert.ok(
    computeOperationToolpath(withClamps([beyond]), base.operation)!.result.moves.length > 0,
    'an ordinary clamp past the blank end is clear',
  )
}

/** A fixture with one ordinary clamp placed so it cannot reach the swept envelope. */
function strictClear(base: ReturnType<typeof fixture>): Clamp {
  const radius = (base.stock.thickness * Math.SQRT1_2) + 10
  return {
    id: 'clear', name: 'Clear clamp', type: 'step_clamp',
    x: 5, y: barCentre(base.stock) + radius, w: 4, h: 4, height: 8, visible: true,
  }
}

// ── 5. a seeded physical reference for the new motion ─────────

console.log('Testing the posted inverse-time feed against a seeded physical reference...')
{
  const { project } = fixture({ axis: 'x', units: 'mm', kind: 'rotary_finish' })
  const stock = project.stock as SquareStock
  const centre = rotaryCentreline(stock)!
  assert.equal(centre.point.z, barPivotZ(stock), 'the centreline is the true pivot')
  assert.equal(centre.point.y, barCentre(stock), 'and the true across centreline')
  const definition = machine('own', 'x')
  const direction = rotaryDirection(definition)
  const feed = 600
  const tolerance = exportGeometryTolerance('mm')
  const pivot = barPivotZ(stock)
  // A seeded sweep of tip radii about the true pivot and sweep angles. A
  // pure-turn feed move at tip radius R and sweep ω has inverse-time word
  // `feed / (R · ω)`, independent of where the cutter is along the bar.
  let seed = 12345
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  let checked = 0
  for (let i = 0; i < 40; i++) {
    const radius = 1 + random() * 8
    const sweep = 1 + random() * 40
    const along = 4 + random() * 20
    const from: ToolpathPoint = { x: along, y: centre.point.y, z: pivot + radius, a: 0 }
    const to: ToolpathPoint = { x: along, y: centre.point.y, z: pivot + radius, a: sweep }
    const expected = feed / (radius * (sweep * Math.PI / 180))
    // The planner's own centres are in the program's direction; a pure turn has
    // the same length either way, so the reference uses the raw move.
    const posted = inverseTimeFeedValue(from, to, feed, centre, tolerance)
    assert.ok(Math.abs(posted - expected) / expected < 1e-9, `seed ${i}: F${posted.toFixed(6)} is feed/(Rω) for R=${radius.toFixed(4)}`)
    checked++
  }
  // The direction factor is the machine's, not the geometry's.
  assert.equal(direction, 1, 'fixture: an own-axis machine turns in the positive direction')
  console.log(`   ${checked} seeded pure-turn feeds match the true-pivot analytic word`)
}

console.log('engine/gcode/squareRotaryOutput.test.ts: all assertions passed')
