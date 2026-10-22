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
 * provably disjoint one passes. The ordinary-clamp verdict is witnessed
 * analytically — the cutter body the emitted move implies is measured against
 * the clamp box — rather than only through the guard's predicate, both for a
 * clamp in the finite cutter overhang past the blank's end and for one beyond
 * it. Stale posted output is exercised directly too: a missing project tool
 * row, an empty `toolRef`, a different larger emitted cutter, a same-radius
 * cutter of the other supported shape, an unsupported `v_bit` on either side, a
 * body whose radius is not half its diameter, a non-finite dimension, a row
 * naming another valid project tool (whose `id` selects the program's tool
 * number, so a real tool-change program is refused) and a normalized row
 * labelled in another unit system all fail closed, while a legitimately
 * unit-converted flat or ball row under its own id still posts. The flat/ball
 * difference is witnessed geometrically as well — at a nonzero tangential
 * offset a ball's lower surface stands `r − √(r² − d²)` above the tip the flat
 * still passes through — so the shape check is load-bearing geometry, not enum
 * equality.
 *
 * The round bar is the frozen baseline: every matrix cell posts byte-identical
 * text to the value captured from the base commit before this slice's guards
 * existed (`SQUARE_ROTARY_PRINT_ROUND=1` reprints it from either tree).
 *
 * Run with: npx tsx src/engine/gcode/squareRotaryOutput.test.ts
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { computeMeshBounds, serializeImportedMesh } from '../importedMesh'
import { decodeProjectFormat } from '../../store/helpers/projectFormat'
import { defaultTool, getStockBounds, newProject, rectProfile } from '../../types/project'
import type { Clamp, Operation, OperationKind, Project, SquareStock, Tool, ToolType } from '../../types/project'
import { barCentre, barMaxRadius, barPivotZ, squareStock } from '../../types/barStock'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { defaultRoundWorkholding } from '../../store/helpers/roundWorkholding'
import { projectWithFeatures } from '../../test/projectFixtures'
import { computeOperationToolpath } from '../toolpaths/generateOperation'
import { rotaryTravelZ } from '../toolpaths/squareRotaryStock'
import { setupGenerationBlock } from '../setupTargets'
import { normalizeToolForProject } from '../toolpaths/geometry'
import { warningSeverity } from '../toolpaths/warningCodes'
import type { NormalizedTool, ToolpathMove, ToolpathPoint, ToolpathResult } from '../toolpaths/types'
import { BUNDLED_DEFINITIONS } from './definitions'
import { inverseTimeFeedValue, rotaryCentreline } from './motionPipeline'
import { runPostProcessor } from './postprocessor'
import { formatGCodeNumber } from './utils'
import { rotaryDirection, rotaryWord, validateMachineDefinition } from './types'
import type { MachineDefinition, PostProcessorResult, RotaryDefinition } from './types'
import { convertLength, convertToolUnits, exportGeometryTolerance, MM_PER_INCH } from '../../utils/units'

// ── fixtures ──────────────────────────────────────────────────

type Axis = 'x' | 'y'
type Units = 'mm' | 'inch'
type MachineKind = 'own' | 'borrowed' | 'reversed'
/** The two cutter shapes a square turning rough/finish supports. */
type SupportedCutter = Extract<ToolType, 'flat_endmill' | 'ball_endmill'>

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
  /** The referenced project cutter shape; the fixture default is a ball. */
  toolType?: SupportedCutter
}

/**
 * A real rotary project on a square blank (or the same box as a round bar),
 * with an Around setup, a model target and the S2 default workholding.
 */
function fixture(options: FixtureOptions): { project: Project; operation: Operation; stock: SquareStock; tool: Tool } {
  const { axis, units, kind, at = { x: 0, y: 0 }, round = false, toolType = 'ball_endmill' } = options
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
    type: toolType,
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

/** Post several prepared operations as one program, preserving the entry angle. */
function postSequence(
  project: Project,
  definition: MachineDefinition,
  sequence: Array<{ operation: Operation; moves: ToolpathMove[] }>,
): PostProcessorResult {
  return runPostProcessor({
    project,
    definition,
    operations: sequence.map(({ operation, moves }) => ({
      operation,
      tool: normalizeToolForProject(project.tools.find((entry) => entry.id === operation.toolRef)!, project),
      toolpath: toolpathOf(operation, moves),
    })),
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

/**
 * Program motion/text fingerprint that never normalises geometry or feeds. The
 * generated-date comment is the one wall-clock byte in the program, so it is
 * pinned the way `legacyMachineParity.test.ts` pins it; every other output byte
 * is compared.
 */
function fingerprint(project: Project, definition: MachineDefinition, operation: Operation): string {
  const envelope = computeOperationToolpath(project, operation)
  assert.ok(envelope, 'fixture: the dispatch answers')
  if (!envelope) throw new Error('unreachable')
  const result = post(project, definition, operation, envelope.result)
  const moves = envelope.result.moves.map((move) => [move.kind, ...Object.values(move.from), ...Object.values(move.to)])
  return [
    `moves=${hash(JSON.stringify(moves))}`,
    `warnings=${envelope.result.warnings.map((warning) => warning.code).join(',')}`,
    `gcode=${hash(result.gcode.replace(/\d{4}-\d{2}-\d{2}/g, '2000-01-01'))}`,
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
 *
 * Re-captured on the #1045 integration sync so all 24 entries include both
 * changes: #1045 slice D's C2-F7 cutter-centre pull-in, now applied to a round
 * bar's retained ends too, starts and ends each grid one cutter radius inside
 * the stubbed faces (every fixture's band ends inside the bar); #1054 fix 3's
 * closing machine-coordinate retract writes the definition's
 * `motion.machineSafeZ` (default 0) rather than a project height, so only that
 * line moved again. The operation parameters, the layer count and the posted
 * feed/word structure are unchanged; the move grid follows the pulled span and
 * the closing retract follows the machine Safe Z.
 *
 * Re-captured again for the 2026-10-22 decision: the twelve round **finish**
 * entries only. The finish no longer clears, so its motion is its
 * model-following passes; #1045 slice D's round retained-end pull-in still
 * starts and ends the band one cutter radius inside the stubbed faces, and a
 * finish-only program carries `rotaryFinishWithoutRough`. The rough entries are
 * byte-identical.
 *
 * Re-captured once more for #1091, which removes the closing unwind: the
 * trailing machine-coordinate retract (`G53 G0 Z…`) and the `G0 A0` turn are
 * gone. Only those two motion lines disappear, so every `gcode=` value moves
 * while every `moves=` value stays exactly as integration posted it.
 */
const ROUND_BASELINE: Record<string, string> = {
  'x/mm/rotary_rough/own': 'moves=2ddc872aefafcae0|warnings=|gcode=201adf07b70f4211|post=',
  'x/mm/rotary_rough/borrowed': 'moves=2ddc872aefafcae0|warnings=|gcode=e9b15fe2139fe5ec|post=',
  'x/mm/rotary_rough/reversed': 'moves=2ddc872aefafcae0|warnings=|gcode=01401871865fadfe|post=',
  'x/mm/rotary_finish/own': 'moves=c8db8c9ec52bb897|warnings=rotaryFinishWithoutRough|gcode=5b71325054e64b0a|post=',
  'x/mm/rotary_finish/borrowed': 'moves=c8db8c9ec52bb897|warnings=rotaryFinishWithoutRough|gcode=768c6dd120d6af70|post=',
  'x/mm/rotary_finish/reversed': 'moves=c8db8c9ec52bb897|warnings=rotaryFinishWithoutRough|gcode=c955a06282724b6a|post=',
  'x/inch/rotary_rough/own': 'moves=05ea63889d726fd8|warnings=|gcode=07689cb099b4a294|post=',
  'x/inch/rotary_rough/borrowed': 'moves=05ea63889d726fd8|warnings=|gcode=9ddab487b84b982b|post=',
  'x/inch/rotary_rough/reversed': 'moves=05ea63889d726fd8|warnings=|gcode=0b3192cb53e0a31d|post=',
  'x/inch/rotary_finish/own': 'moves=eb73cc7eedddf910|warnings=rotaryFinishWithoutRough|gcode=183ee50a9e9dd376|post=',
  'x/inch/rotary_finish/borrowed': 'moves=eb73cc7eedddf910|warnings=rotaryFinishWithoutRough|gcode=b8a26899f1354d22|post=',
  'x/inch/rotary_finish/reversed': 'moves=eb73cc7eedddf910|warnings=rotaryFinishWithoutRough|gcode=61d4273220b04b16|post=',
  'y/mm/rotary_rough/own': 'moves=9d9ac8c20cff3d77|warnings=|gcode=74bb84e782f7f587|post=',
  'y/mm/rotary_rough/borrowed': 'moves=9d9ac8c20cff3d77|warnings=|gcode=4a862b8b625226c3|post=',
  'y/mm/rotary_rough/reversed': 'moves=9d9ac8c20cff3d77|warnings=|gcode=9a8c0ce42dded274|post=',
  'y/mm/rotary_finish/own': 'moves=2148c63ced005328|warnings=rotaryFinishWithoutRough|gcode=28bb9691a7397980|post=',
  'y/mm/rotary_finish/borrowed': 'moves=2148c63ced005328|warnings=rotaryFinishWithoutRough|gcode=68f985caa670e59e|post=',
  'y/mm/rotary_finish/reversed': 'moves=2148c63ced005328|warnings=rotaryFinishWithoutRough|gcode=4a2da2c245d0c570|post=',
  'y/inch/rotary_rough/own': 'moves=3d8c197a1a5b511d|warnings=|gcode=023ff1bd865cd9ea|post=',
  'y/inch/rotary_rough/borrowed': 'moves=3d8c197a1a5b511d|warnings=|gcode=769ddb30015f7e66|post=',
  'y/inch/rotary_rough/reversed': 'moves=3d8c197a1a5b511d|warnings=|gcode=bf06b9906b22a3e4|post=',
  'y/inch/rotary_finish/own': 'moves=0dff884df13dfeda|warnings=rotaryFinishWithoutRough|gcode=ff1bc457fa41eb12|post=',
  'y/inch/rotary_finish/borrowed': 'moves=0dff884df13dfeda|warnings=rotaryFinishWithoutRough|gcode=112f6f1f742994ac|post=',
  'y/inch/rotary_finish/reversed': 'moves=0dff884df13dfeda|warnings=rotaryFinishWithoutRough|gcode=50a229c813a26759|post=',
}

if (process.env.SQUARE_ROTARY_PRINT_ROUND === '1') {
  for (const cell of MATRIX_CELLS) {
    const { project, operation } = fixture({ ...cell, round: true })
    const key = `${cell.axis}/${cell.units}/${cell.kind}/${cell.machine}`
    console.log(`${key} ${fingerprint(project, machine(cell.machine, cell.axis), operation)}`)
  }
  process.exit(0)
}

/** Every generated square rough/finish fixture: both axes, units and cutters. */
const SQUARE_SHAPE_CELLS: Array<{ axis: Axis; units: Units; kind: OperationKind; toolType: SupportedCutter }> = []
for (const axis of ['x', 'y'] as const) {
  for (const units of ['mm', 'inch'] as const) {
    for (const kind of ['rotary_rough', 'rotary_finish'] as const) {
      for (const toolType of ['flat_endmill', 'ball_endmill'] as const) {
        SQUARE_SHAPE_CELLS.push({ axis, units, kind, toolType })
      }
    }
  }
}

/**
 * The square blank's generated rough/finish programs, pinned when the
 * modal-rapid and travel-clearance guard was added (#1016 C2). The guard must
 * accept every one of them unchanged: the generators' travel height and every
 * posted coordinate must not move, so any drift here is a real change, not a
 * normalisation.
 *
 * The eight `rotary_rough` entries were re-captured for #1016 C2-F2, which
 * removes the air layers at the start of each flat pass. The four ball `rough`
 * entries were re-captured again for #1016 C2-F2c, whose exact ball contact
 * removes the air layers the flat cylinder bound still spent above the ball;
 * the flat rough and every `rotary_finish` entry did not move. All sixteen were
 * re-captured for #1016 C2-F6, whose exact retained-stub floor and stub-adjacent
 * stepped moves add motion the discrete sampler used to miss. All sixteen moved
 * again for #1016 C2-F7, which pulls the cutter centre one radius inside each
 * stubbed end: the band-edge staircase and the stepped stub moves go, so every
 * program is shorter. All sixteen moved once more for #1016 C2-F7b, which
 * rounds the cutter-centre pull outward by a tiny relative margin so the along
 * grid cannot land an ulp inside the stub; the pull itself and every posted
 * G-code word are unchanged, only the raw move coordinates carry the margin.
 * All sixteen square entries and all twenty-four round entries above were
 * re-captured once more for #1054 fix 3: the closing machine-coordinate retract
 * is now the definition's own Safe Z (`G53 Z0`, the top of travel after homing)
 * instead of a project height mapped through the origin. No other coordinate
 * moved; the generators' travel height is unchanged.
 *
 * The eight square **finish** entries were re-captured for #1045 slice R and
 * are now **restored to their pre-#1045 motion** by the 2026-10-22 decision:
 * their moves and posted G-code equal the base commit's values; only the
 * `warnings=` field gains `rotaryFinishWithoutRough`. The eight rough entries
 * are byte-identical throughout.
 *
 * Verified once more on the #1045 integration sync: every value below was
 * regenerated from the merged code and still matches, so each entry includes
 * #1054 fix 3's closing retract. #1045's retained-end pull-in moved the round
 * baselines above, not this square matrix, whose C2-F7 pull-in already
 * applied; the square generator and every posted word are unchanged.
 *
 * Re-captured again for #1091, which removes the closing unwind. As above, only
 * the program's last two motion lines (`G53 G0 Z…` and `G0 A0`) are gone; every
 * `moves=` value, the generators' travel height and every posted coordinate
 * are unchanged.
 */
const SQUARE_BASELINE: Record<string, string> = {
  'x/mm/rotary_rough/flat_endmill': 'moves=2b1d6147d679cf8c|warnings=|gcode=fd1d9709670daf3c|post=',
  'x/mm/rotary_rough/ball_endmill': 'moves=586e2d0c75187c41|warnings=|gcode=02bcf4646e5df327|post=',
  'x/mm/rotary_finish/flat_endmill': 'moves=76b5619be346db35|warnings=rotaryFinishWithoutRough|gcode=5cab59aa787a150b|post=',
  'x/mm/rotary_finish/ball_endmill': 'moves=91e82b497c5e49e9|warnings=rotaryFinishWithoutRough|gcode=1c0fafcfe760c8fb|post=',
  'x/inch/rotary_rough/flat_endmill': 'moves=ed2b69428c6fc022|warnings=|gcode=306a80b9cea79b8a|post=',
  'x/inch/rotary_rough/ball_endmill': 'moves=3513daab8597d235|warnings=|gcode=af9af2964df816ab|post=',
  'x/inch/rotary_finish/flat_endmill': 'moves=744293ceeb1c6651|warnings=rotaryFinishWithoutRough|gcode=64223fd0f349046c|post=',
  'x/inch/rotary_finish/ball_endmill': 'moves=9459d0d08d24b863|warnings=rotaryFinishWithoutRough|gcode=fa5e326f24d8d220|post=',
  'y/mm/rotary_rough/flat_endmill': 'moves=15cfb4d4c44f4a45|warnings=|gcode=951e906369df36f3|post=',
  'y/mm/rotary_rough/ball_endmill': 'moves=f9bfe34099fa1f28|warnings=|gcode=40cf52c43135af9e|post=',
  'y/mm/rotary_finish/flat_endmill': 'moves=33358f8ea7e988ef|warnings=rotaryFinishWithoutRough|gcode=3c1f0d16d56c8be4|post=',
  'y/mm/rotary_finish/ball_endmill': 'moves=884abac6dce74e4a|warnings=rotaryFinishWithoutRough|gcode=bcbd90c0f2262673|post=',
  'y/inch/rotary_rough/flat_endmill': 'moves=c21237696b28785d|warnings=|gcode=76f444b9829d3403|post=',
  'y/inch/rotary_rough/ball_endmill': 'moves=7c74d1e96c07107e|warnings=|gcode=df0abbb4bb2f8579|post=',
  'y/inch/rotary_finish/flat_endmill': 'moves=4c0d75554bb80afe|warnings=rotaryFinishWithoutRough|gcode=06477434ba04a292|post=',
  'y/inch/rotary_finish/ball_endmill': 'moves=6da72cdfb688a239|warnings=rotaryFinishWithoutRough|gcode=798784816be2be32|post=',
}

if (process.env.SQUARE_ROTARY_PRINT_SQUARE === '1') {
  for (const cell of SQUARE_SHAPE_CELLS) {
    const { project, operation } = fixture(cell)
    const key = `${cell.axis}/${cell.units}/${cell.kind}/${cell.toolType}`
    console.log(`${key} ${fingerprint(project, machine('own', cell.axis), operation)}`)
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
  // A finish-only fixture carries the advisory that it cuts to full depth in
  // one pass; anything else is a refusal, which this matrix must not admit.
  assert.deepEqual(
    envelope.result.warnings.map((warning) => warning.code).filter((code) => code !== 'rotaryFinishWithoutRough'),
    [],
    `${label}: admitted, not a shape/kind/setup refusal`,
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

  // #1091: the program ends where its last move left it. The last angle in the
  // text is the last toolpath move's angle — no trailing A0 unwind — and the
  // final motion is the operation's own retract, a Z-only block.
  const lastMove = envelope.result.moves[envelope.result.moves.length - 1]
  assert.equal(lastMove.kind, 'rapid', `${label}: the generated path ends with a rapid retract`)
  assert.equal(lastMove.from.x, lastMove.to.x, `${label}: the retract does not travel across the bar`)
  assert.equal(lastMove.from.y, lastMove.to.y, `${label}: the retract does not travel along the bar`)
  assert.ok(lastMove.to.z > lastMove.from.z, `${label}: the last move is a retract, not a cut`)
  assert.ok(lastMove.to.a !== undefined, `${label}: the retract keeps the last angle`)
  const lastWritten = [...result.gcode.matchAll(new RegExp(`(?:^|[\\s])${word!}(-?[0-9]+(?:\\.[0-9]+)?)`, 'gm'))]
    .map((match) => Number(match[1]))
  assert.equal(
    lastWritten[lastWritten.length - 1],
    Number(formatGCodeNumber(lastMove.to.a! * rotaryDirection(definition), definition, cell.units)),
    `${label}: the last angle written is the last toolpath angle, with no closing unwind`,
  )
  const axisLines = motionLines(result.gcode).filter((line) => /[XYZ]/.test(line))
  const finalMotion = axisLines[axisLines.length - 1]
  assert.match(finalMotion, /^(?:G0\s+)?Z/, `${label}: the final motion is the Z retract, got ${finalMotion}`)
  assert.doesNotMatch(finalMotion, new RegExp(`${word}`), `${label}: the retract carries no angle word`)

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

// ── 2b. every generated square fixture still posts unchanged ──

console.log('Testing the generated square baseline across axes, units and cutters...')
for (const cell of SQUARE_SHAPE_CELLS) {
  const { project, operation } = fixture(cell)
  const key = `${cell.axis}/${cell.units}/${cell.kind}/${cell.toolType}`
  const expected = SQUARE_BASELINE[key]
  assert.ok(expected, `fixture: a captured square baseline for ${key}`)
  assert.equal(
    fingerprint(project, machine('own', cell.axis), operation),
    expected,
    `${key}: the generated square program is unchanged`,
  )
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
    'squareRotaryUnsupported',
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
  // (h) a synthetic angle-bearing path on an ordinary Top operation: the
  // operation's face does not make the motion square turning, so it is refused
  // however legitimate the Top operation itself is.
  const topSynthetic: Operation = {
    ...operation,
    id: 'top-synthetic',
    name: 'Top synthetic',
    kind: 'pocket',
    setupId: project.setups[0].id,
    target: { source: 'stock' },
  }
  assert.deepEqual(
    codes(post(project, machine('own', 'x'), topSynthetic, envelope.result)),
    ['postSetupOperationRefused'],
    'a synthetic A path on an ordinary Top operation is refused',
  )
  // The same operation with angle-free moves stays ordinary Top machining.
  const topFlat: ToolpathMove[] = [{ kind: 'cut', from: { x: 4, y: 6, z: 12 }, to: { x: 20, y: 6, z: 12 } }]
  assert.deepEqual(
    codes(post(project, machine('own', 'x'), topSynthetic, toolpathOf(topSynthetic, topFlat))),
    [],
    'and an angle-free Top operation is untouched',
  )
}

// ── 3b. a square turn must clear the generator's travel height ─

console.log('Testing square turning height against the generator travel clearance...')
{
  const { project, operation, stock } = fixture({ axis: 'x', units: 'mm', kind: 'rotary_finish' })
  const definition = machine('own', 'x')
  const centre = barCentre(stock)
  const envelope = barPivotZ(stock) + barMaxRadius(stock)
  // The generator's height, written out independently of the shared helper so
  // a wrong helper cannot move both the guard and its witness together.
  const travelZ = barPivotZ(stock) + barMaxRadius(stock) + convertLength(1, 'mm', 'mm')
  assert.equal(rotaryTravelZ(stock, 'mm'), travelZ, 'fixture: the shared travel helper matches the generator height')
  const halfStep = 0.5 * 10 ** -definition.numberFormat.decimalPlaces.mm
  const high = travelZ + 5
  // A rapid establishes A0 clear of the blank, then a feed turns the blank from
  // A0 to A45 at the probe height. The cut is the operation's real turning move,
  // so it is the one that reaches the program under G93.
  const turnAt = (z: number): ToolpathMove[] => [
    { kind: 'rapid', from: { x: 15, y: centre, z: high, a: 0 }, to: { x: 15, y: centre, z: high, a: 0 } },
    { kind: 'cut', from: { x: 15, y: centre, z, a: 0 }, to: { x: 15, y: centre, z, a: 45 } },
  ]
  const codes = (result: PostProcessorResult) => result.warnings.map((warning) => warning.code)
  assert.ok(12 < travelZ - 0.5, 'fixture: Z12 is below the generator travel height')
  assert.ok(envelope < travelZ, 'fixture: the bare corner envelope is below the travel height')

  const refused = post(project, definition, operation, toolpathOf(operation, turnAt(12)))
  assert.deepEqual(codes(refused), ['postRotarySquareTurnBelowEnvelope'], 'the Z12 A0 -> A45 probe is refused at export')
  assert.ok(!postsAngle(refused.gcode, 'A'), 'none of the too-low turn is posted')
  assert.equal(warningSeverity('postRotarySquareTurnBelowEnvelope'), 'error', 'the refusal blocks a save')

  const accepted = post(project, definition, operation, toolpathOf(operation, turnAt(travelZ)))
  assert.deepEqual(accepted.warnings, [], 'a turn at the generator travel height is accepted')
  assert.ok(postsAngle(accepted.gcode, 'A'), 'and the accepted turn is posted')
  assert.match(accepted.gcode, /G93/, 'the accepted turning cut uses inverse time')

  // The emitted Z is written with the machine's decimal places: a turn within
  // half of the last decimal is emitted *at* the travel height, not below it.
  const rounded = post(project, definition, operation, toolpathOf(operation, turnAt(travelZ - halfStep / 2)))
  assert.deepEqual(rounded.warnings, [], 'a turn within half the last emitted Z decimal rounds to the travel height')

  // Modal rapid bypass: the controller is at A0 and the tool at Z12, but the
  // rapid is labelled `from.a = to.a = 45`. Equal endpoints do not make it a
  // no-op — the emitter writes A45 from A0 — so it turns the blank at Z12.
  for (const toolType of ['flat_endmill', 'ball_endmill'] as const) {
    const probe = fixture({ axis: 'x', units: 'mm', kind: 'rotary_finish', toolType })
    const modal: ToolpathMove[] = [
      { kind: 'rapid', from: { x: 15, y: centre, z: high, a: 0 }, to: { x: 15, y: centre, z: high, a: 0 } },
      { kind: 'rapid', from: { x: 15, y: centre, z: high, a: 0 }, to: { x: 15, y: centre, z: 12, a: 0 } },
      { kind: 'rapid', from: { x: 15, y: centre, z: 12, a: 45 }, to: { x: 16, y: centre, z: 12, a: 45 } },
    ]
    const result = post(probe.project, definition, probe.operation, toolpathOf(probe.operation, modal))
    assert.deepEqual(
      codes(result),
      ['postRotarySquareTurnBelowEnvelope'],
      `${toolType}: a same-endpoint rapid from A0 to A45 at Z12 is a turn and is refused`,
    )
    assert.ok(!postsAngle(result.gcode, 'A'), `${toolType}: the unsafe rapid posts no A45`)
  }

  // A same-angle rapid is genuinely stale once the controller is already at
  // that angle: it commands no new angle, so it stays accepted at Z12.
  const staleSameAngle: ToolpathMove[] = [
    { kind: 'rapid', from: { x: 15, y: centre, z: high, a: 0 }, to: { x: 15, y: centre, z: high, a: 45 } },
    { kind: 'rapid', from: { x: 15, y: centre, z: high, a: 45 }, to: { x: 15, y: centre, z: 12, a: 45 } },
    { kind: 'rapid', from: { x: 15, y: centre, z: 12, a: 45 }, to: { x: 16, y: centre, z: 12, a: 45 } },
  ]
  const staleResult = post(project, definition, operation, toolpathOf(operation, staleSameAngle))
  assert.deepEqual(staleResult.warnings, [], 'a rapid already at the controller angle is not a turn')
  assert.equal((staleResult.gcode.match(/A45/g) ?? []).length, 1, 'the stale same-angle rapid writes no second A45')

  // The entry angle is the one the previous operation handed in (`trackedAngle`),
  // not a fresh tracker per operation: a prior A45 makes the next same-angle
  // rapid stale, while a prior A0 leaves the identical move a real turn.
  const prior: Operation = { ...operation, id: 'prior-angle', name: 'Prior angle' }
  const next: Operation = { ...operation, id: 'next-angle', name: 'Next angle' }
  const atHigh = (a: number): ToolpathPoint => ({ x: 15, y: centre, z: high, a })
  const from45 = postSequence(project, definition, [
    { operation: prior, moves: [{ kind: 'rapid', from: atHigh(0), to: atHigh(45) }] },
    { operation: next, moves: staleSameAngle.slice(1) },
  ])
  assert.deepEqual(from45.warnings, [], 'the entry angle A45 makes the next same-angle rapid stale')
  const from0 = postSequence(project, definition, [
    { operation: prior, moves: [{ kind: 'rapid', from: atHigh(0), to: atHigh(0) }] },
    {
      operation: next,
      moves: [
        { kind: 'rapid', from: atHigh(0), to: { ...atHigh(0), z: 12 } },
        { kind: 'rapid', from: { ...atHigh(45), z: 12 }, to: { ...atHigh(45), z: 12, x: 16 } },
      ],
    },
  ])
  assert.deepEqual(
    codes(from0),
    ['postRotarySquareTurnBelowEnvelope'],
    'the entry angle A0 leaves the same 45/45 rapid a real turn at Z12',
  )

  // Round output is frozen: a round bar has no square clearance guard, so the
  // same low turn on the same box still posts exactly as before.
  const round = fixture({ axis: 'x', units: 'mm', kind: 'rotary_finish', round: true })
  const roundResult = post(round.project, definition, round.operation, toolpathOf(round.operation, turnAt(12)))
  assert.deepEqual(roundResult.warnings, [], 'the round bar is not given the square clearance guard')
  assert.ok(postsAngle(roundResult.gcode, 'A'), 'the round turn is still posted')
}

// ── 3c. a turn is judged by its lower end, in project units ───

console.log('Testing square turning height on both endpoints and in both unit systems...')
for (const units of ['mm', 'inch'] as const) {
  const { project, operation, stock } = fixture({ axis: 'x', units, kind: 'rotary_finish' })
  const definition = machine('own', 'x')
  const centre = barCentre(stock)
  const envelope = barPivotZ(stock) + barMaxRadius(stock)
  // Written out independently of the shared helper: a helper with the unit
  // conversion missing must not also move the test's expected height.
  const travelZ = barPivotZ(stock) + barMaxRadius(stock) + convertLength(1, 'mm', units)
  assert.equal(rotaryTravelZ(stock, units), travelZ, `${units}: the shared travel helper matches the generator height`)
  const halfStep = 0.5 * 10 ** -definition.numberFormat.decimalPlaces[units]
  const below = convertLength(12, 'mm', units)
  const wellAbove = travelZ + convertLength(2, 'mm', units)
  const along = convertLength(15, 'mm', units)
  const codes = (result: PostProcessorResult) => result.warnings.map((warning) => warning.code)

  // A rapid establishes A0 clear of the blank, then the A-changing cut runs
  // between the two heights under test. Every coordinate is in the project's
  // own unit system, the way the generators and the guard both read it.
  const turn = (fromZ: number, toZ: number): ToolpathMove[] => [
    { kind: 'rapid', from: { x: along, y: centre, z: wellAbove, a: 0 }, to: { x: along, y: centre, z: wellAbove, a: 0 } },
    { kind: 'cut', from: { x: along, y: centre, z: fromZ, a: 0 }, to: { x: along, y: centre, z: toZ, a: 45 } },
  ]
  const refusedTurn = (fromZ: number, toZ: number, label: string) => {
    const result = post(project, definition, operation, toolpathOf(operation, turn(fromZ, toZ)))
    assert.deepEqual(codes(result), ['postRotarySquareTurnBelowEnvelope'], `${units}: ${label} is refused`)
    assert.ok(!postsAngle(result.gcode, 'A'), `${units}: ${label} posts no angle`)
  }
  const acceptedTurn = (fromZ: number, toZ: number, label: string) => {
    const result = post(project, definition, operation, toolpathOf(operation, turn(fromZ, toZ)))
    assert.deepEqual(result.warnings, [], `${units}: ${label} is accepted`)
    assert.ok(postsAngle(result.gcode, 'A'), `${units}: ${label} posts its angle`)
    assert.match(result.gcode, /G93/, `${units}: ${label} uses inverse time`)
  }

  assert.ok(below < travelZ - convertLength(0.5, 'mm', units), `${units}: fixture: Z12 is below the travel height`)
  assert.ok(wellAbove > travelZ, `${units}: fixture: 2 mm above is above the travel height`)

  // (a)/(b) Either endpoint below the travel height makes the turn too low: a
  // descending turn is not waved through because its *upper* end is clear, and
  // neither is the reverse ascent.
  refusedTurn(wellAbove, below, 'a descending turn from above the travel height to Z12')
  refusedTurn(below, wellAbove, 'an ascending turn from Z12 to above the travel height')

  // (c) A turn at or above the travel height is accepted. A value within half
  // of the last emitted Z decimal rounds to the travel height and is accepted
  // too; the allowance is a length in the project's own units.
  acceptedTurn(travelZ, travelZ, 'a turn at the travel height')
  acceptedTurn(travelZ + convertLength(0.01, 'mm', units), travelZ + convertLength(0.01, 'mm', units), 'a turn 0.01 mm above the travel height')
  acceptedTurn(travelZ - halfStep / 2, travelZ - halfStep / 2, 'a turn within half the last emitted Z decimal')

  // (d) Just below the travel height is refused. 0.01 mm is well under the
  // height but still above the bare corner envelope, so a guard that only
  // checked the envelope would wrongly admit it.
  refusedTurn(
    travelZ - convertLength(0.01, 'mm', units),
    travelZ - convertLength(0.01, 'mm', units),
    'a turn 0.01 mm below the travel height',
  )

  // (e) The bare corner envelope is not a safe turning height: half a
  // thousandth of a millimetre below it is refused, even though that is inside
  // the old bare-envelope tolerance.
  const bareBelow = envelope - convertLength(0.0005, 'mm', units)
  assert.ok(
    bareBelow > envelope - convertLength(0.001, 'mm', units),
    `${units}: fixture: the probe is within the old bare-envelope tolerance`,
  )
  refusedTurn(bareBelow, bareBelow, 'a turn 0.0005 mm below the bare corner envelope')
  refusedTurn(envelope, envelope, 'a turn exactly on the bare corner envelope')

  // (f) The guard is about turning only. A straight plunge from the same clear
  // height to Z12 at a constant A is not this guard's refusal.
  const plunge: ToolpathMove[] = [
    { kind: 'rapid', from: { x: along, y: centre, z: wellAbove, a: 0 }, to: { x: along, y: centre, z: wellAbove, a: 0 } },
    { kind: 'cut', from: { x: along, y: centre, z: wellAbove, a: 0 }, to: { x: along, y: centre, z: below, a: 0 } },
  ]
  const plungeResult = post(project, definition, operation, toolpathOf(operation, plunge))
  assert.deepEqual(plungeResult.warnings, [], `${units}: a non-turning descent below the travel height posts`)
  assert.ok(!codes(plungeResult).includes('postRotarySquareTurnBelowEnvelope'), `${units}: and does not trip this guard`)
}

// ── 3d. a program starts at A0, not at its first move's angle ─

console.log('Testing the controller start angle at the start of a program...')
for (const units of ['mm', 'inch'] as const) {
  const { project, operation, stock } = fixture({ axis: 'x', units, kind: 'rotary_finish' })
  const definition = machine('own', 'x')
  const centre = barCentre(stock)
  // Written out independently of the shared helper, as in 3b/3c.
  const travelZ = barPivotZ(stock) + barMaxRadius(stock) + convertLength(1, 'mm', units)
  const below = convertLength(12, 'mm', units)
  const along = convertLength(15, 'mm', units)
  const codes = (result: PostProcessorResult) => result.warnings.map((warning) => warning.code)
  // The first angle-bearing move of the program, with nothing before it, so the
  // controller has not been turned yet and starts at A0. Equal endpoints do not
  // make the move a no-op: the block it writes still commands its own angle
  // from the controller's A0, so it turns the blank.
  const firstMove = (kind: 'rapid' | 'cut', angle: number, z: number): ToolpathMove[] => [
    { kind, from: { x: along, y: centre, z, a: angle }, to: { x: along, y: centre, z, a: angle } },
  ]
  assert.ok(below < travelZ - convertLength(0.5, 'mm', units), `${units}: fixture: Z12 is below the travel height`)

  // (a) A first move labelled A45 -> A45 turns the blank from the controller's
  // A0, and at Z12 that turn sweeps the standing corner into the cutter. The
  // move's own equal endpoints must not be read as "already there".
  for (const kind of ['rapid', 'cut'] as const) {
    const refused = post(project, definition, operation, toolpathOf(operation, firstMove(kind, 45, below)))
    assert.deepEqual(
      codes(refused),
      ['postRotarySquareTurnBelowEnvelope'],
      `${units}: the first ${kind} of the program labelled A45 -> A45 at Z12 is refused`,
    )
    assert.ok(!postsAngle(refused.gcode, 'A'), `${units}: the too-low first ${kind} posts no A45`)
  }

  // (b) A0 -> A0 commands no turn at all, so this height guard must not fire.
  // The feed is still refused for the older reason — a feed cannot start before
  // the controller is at its angle — and that is a different rule, not this one.
  const flatRapid = post(project, definition, operation, toolpathOf(operation, firstMove('rapid', 0, below)))
  assert.deepEqual(flatRapid.warnings, [], `${units}: the first rapid of the program at A0 -> A0 Z12 posts`)
  const flatFeed = post(project, definition, operation, toolpathOf(operation, firstMove('cut', 0, below)))
  assert.ok(
    !codes(flatFeed).includes('postRotarySquareTurnBelowEnvelope'),
    `${units}: the first feed of the program at A0 -> A0 Z12 is not this guard's refusal`,
  )
  assert.deepEqual(codes(flatFeed), ['postRotaryAngleNotEstablished'], `${units}: it is still an unestablished feed`)

  // (c) The guard judges height, not angle: the same A45 first move at the
  // generator's travel height is admitted. A rapid establishes A45 for the
  // program; a feed that starts at A45 before any turn has happened is still
  // the older unestablished-feed refusal, so it is only checked against this
  // guard.
  const highRapid = post(project, definition, operation, toolpathOf(operation, firstMove('rapid', 45, travelZ)))
  assert.deepEqual(highRapid.warnings, [], `${units}: the first rapid labelled A45 -> A45 at the travel height is accepted`)
  assert.match(highRapid.gcode, /A45/, `${units}: and posts its A45`)
  const highFeed = post(project, definition, operation, toolpathOf(operation, firstMove('cut', 45, travelZ)))
  assert.ok(
    !codes(highFeed).includes('postRotarySquareTurnBelowEnvelope'),
    `${units}: the first feed labelled A45 -> A45 at the travel height is not refused by this guard`,
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
  assert.deepEqual(envelope.result.warnings.map((warning) => warning.code), ['workholdingDiameter'], 'and names the diameter problem')
  assert.equal(warningSeverity('workholdingDiameter'), 'error', 'the refusal blocks a save')
  assert.equal(warningSeverity('aroundStockMismatch'), 'warning', 'the old round/flat mismatch stays a warning')
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

console.log("Testing Frank's measured C2 F3 project (inch 2 in square, 50 mm chuck)...")
{
  // The real project from the UI test, loaded from format 3.3 exactly as the
  // shape switch left it: the chuck was minted on a round bar and kept its
  // 50 mm (1.9685 in) diameter across the round→square switch. No synthetic
  // fixture, and no shape switch here — the file is the measured state.
  const file = new URL('./squareRotaryChuckSwitch.fixture.camj', import.meta.url)
  const { project } = decodeProjectFormat(JSON.parse(readFileSync(file, 'utf8')))
  const stock = project.stock as SquareStock
  assert.equal(stock.shape, 'square', 'the project is on a square blank')
  assert.equal(stock.thickness, 2, 'the blank is 2 in across')
  assert.equal(project.meta.units, 'inch', 'in inch units')
  const chuck = project.clamps[0]
  assert.equal(chuck.type, 'chuck', 'one chuck')
  assert.equal(chuck.name, 'Chuck', 'named Chuck')
  assert.ok(Math.abs(chuck.h - convertLength(50, 'mm', 'inch')) <= 1e-12, 'its 50 mm diameter survived the shape switch')

  for (const operation of project.operations) {
    assert.equal(operation.kind.startsWith('rotary_'), true, `${operation.name}: a rotary operation`)
    const envelope = computeOperationToolpath(project, operation)!
    assert.equal(envelope.result.moves.length, 0, `${operation.name}: no motion for the refused setup`)
    assert.deepEqual(
      envelope.result.warnings.map((warning) => warning.code),
      ['workholdingDiameter'],
      `${operation.name}: names the diameter problem, not the generic text`,
    )
    const warning = envelope.result.warnings[0]
    assert.equal(warning.params?.operation, operation.name, `${operation.name}: names the operation`)
    assert.equal(warning.params?.clamp, 'Chuck', `${operation.name}: names the clamp`)
    assert.equal(warning.params?.diameter, '1.9685', `${operation.name}: the existing diameter, in project units`)
    assert.equal(warning.params?.required, '2.8284', `${operation.name}: the corner-envelope diameter it must clear`)
    assert.equal(warningSeverity('workholdingDiameter'), 'error', `${operation.name}: the refusal blocks a save`)
  }

  // The same measured project with the chuck off the true pivot gets its own
  // code: a placement problem is not reported as a diameter problem.
  const moved = {
    ...project,
    clamps: [{ ...chuck, y: chuck.y + 0.5 }],
  }
  const placed = computeOperationToolpath(moved, project.operations[0])!
  assert.deepEqual(placed.result.warnings.map((warning) => warning.code), ['workholdingPlacement'], 'a moved chuck names the placement problem')
  assert.equal(placed.result.warnings[0].params?.clamp, 'Chuck', 'and still names the clamp')
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
  assert.equal(computeOperationToolpath(withClamps([offCentre]), base.operation)!.result.warnings[0]?.code, 'workholdingPlacement', 'an off-centre clamp is refused')
  // A height not derived from the true pivot.
  const wrongHeight: Clamp = { ...small, height: barPivotZ(stock) + 3 + 1 }
  assert.equal(computeOperationToolpath(withClamps([wrongHeight]), base.operation)!.result.warnings[0]?.code, 'workholdingPlacement', 'a pivot-derived height is required')
  // Invalid dimensions fail closed.
  for (const bad of [NaN, Infinity, 0, -1]) {
    const invalid: Clamp = { ...small, h: bad }
    assert.equal(computeOperationToolpath(withClamps([invalid]), base.operation)!.result.warnings[0]?.code, 'postSetupOperationRefused', `an invalid chuck dimension (${bad}) is refused`)
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
    'ordinaryClampOverlap',
    'an ordinary clamp inside the swept envelope is refused',
  )
  // Across the bar, outside the envelope: provably disjoint, allowed.
  const clear = strictClear(base)
  assert.ok(
    computeOperationToolpath(withClamps([clear]), base.operation)!.result.moves.length > 0,
    'an ordinary clamp across the bar, outside the corner envelope, is clear',
  )
  // Along-disjoint from the blank *beyond the finite cutter overhang*: allowed
  // even on the centreline. `x: max + 5` is past the (radius + clearance)
  // envelope the guard grows the blank by, so it is provably distant.
  const beyond = ordinary({ x: bounds.max + 5 })
  assert.ok(
    computeOperationToolpath(withClamps([beyond]), base.operation)!.result.moves.length > 0,
    'an ordinary clamp past the blank end, beyond the cutter overhang, is clear',
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

/** Post one operation with an explicit tool row — the stale entry an emitter would write. */
function postWithTool(
  project: Project,
  definition: MachineDefinition,
  operation: Operation,
  tool: NormalizedTool,
  toolpath: ToolpathResult,
  options: { emitToolChanges?: boolean } = {},
): PostProcessorResult {
  return runPostProcessor({
    project,
    definition,
    operations: [{ operation, tool, toolpath }],
    options: { emitToolChanges: options.emitToolChanges ?? false, emitCoolant: false, programName: project.meta.name },
  })
}

/** The cut move reaching furthest in `direction` along the bar's own axis. */
function extremeCut(moves: readonly ToolpathMove[], axis: Axis, direction: 1 | -1): ToolpathMove | null {
  const at = (point: ToolpathPoint) => (axis === 'x' ? point.x : point.y)
  let best: ToolpathMove | null = null
  let bestValue = direction === 1 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY
  for (const move of moves) {
    if (move.kind === 'rapid') continue
    const value = direction === 1
      ? Math.max(at(move.from), at(move.to))
      : Math.min(at(move.from), at(move.to))
    if (direction === 1 ? value > bestValue : value < bestValue) {
      best = move
      bestValue = value
    }
  }
  return best
}

/**
 * The physical witness, independent of the guard's own predicates: the tool tip
 * stands a vertical cylinder of `radius` out of the bed, the clamp is its
 * stored box, and the two collide when their XY footprints meet with the
 * clamp's height reaching the tip. Both ends of the move are tested; a straight
 * cut at constant across the bar is closest to the clamp at one of them.
 */
function cutterBodyOverlapsClamp(move: ToolpathMove, radius: number, clamp: Clamp): boolean {
  const maxX = clamp.x + clamp.w
  const maxY = clamp.y + clamp.h
  return [move.from, move.to].some((tip) => {
    const nearX = Math.min(Math.max(tip.x, clamp.x), maxX)
    const nearY = Math.min(Math.max(tip.y, clamp.y), maxY)
    const dx = tip.x - nearX
    const dy = tip.y - nearY
    return dx * dx + dy * dy <= radius * radius && clamp.height >= tip.z
  })
}

// ── 4b. ordinary clamps past an end: the finite cutter overhang ─

console.log('Testing ordinary clamps past the blank end against the cutter-body overhang...')
for (const axis of ['x', 'y'] as const) {
  for (const units of ['mm', 'inch'] as const) {
    const { project, operation, tool } = fixture({ axis, units, kind: 'rotary_rough' })
    const stock = project.stock as SquareStock
    const definition = machine('own', axis)
    const bounds = getStockBounds(stock)
    const alongMin = axis === 'x' ? bounds.minX : bounds.minY
    const alongMax = axis === 'x' ? bounds.maxX : bounds.maxY
    const centre = barCentre(stock)
    const radius = tool.diameter / 2
    const clearance = project.meta.clampClearanceXY
    const expand = radius + clearance
    const label = `${axis}/${units}`
    const codes = (result: PostProcessorResult) => result.warnings.map((warning) => warning.code)
    const clean = computeOperationToolpath(project, operation)!
    assert.ok(clean.result.moves.length > 0, `${label}: fixture generates`)

    const pastEnd = (along: number): Clamp => axis === 'x'
      ? { id: 'end', name: 'End clamp', type: 'step_clamp', x: along, y: centre - 1, w: 2, h: 2, height: 20, visible: true }
      : { id: 'end', name: 'End clamp', type: 'step_clamp', x: centre - 1, y: along, w: 2, h: 2, height: 20, visible: true }

    // This fixture's model stops short of the blank end, so the *analytic*
    // witness lives at the farthest cut the path actually makes; the guard is
    // still conservative about the whole blank (asserted below).
    const reach = clean.result.moves
      .filter((move) => move.kind !== 'rapid')
      .reduce((max, move) => Math.max(max, axis === 'x' ? move.to.x : move.to.y), Number.NEGATIVE_INFINITY)
    assert.ok(reach < alongMax && reach > alongMin, `${label}: fixture: the cut stops short of the blank end`)

    // Half a cutter radius past the farthest cut: the cutter body reaches it.
    const colliding = pastEnd(reach + radius / 2)
    const blocked = { ...project, clamps: [colliding] }
    assert.equal(computeOperationToolpath(blocked, operation)!.result.moves.length, 0, `${label}: generation refuses a clamp in the overhang`)
    assert.deepEqual(computeOperationToolpath(blocked, operation)!.result.warnings.map((warning) => warning.code), ['ordinaryClampOverlap'], `${label}: and names the clamp overlap`)
    const stale = postWithTool(blocked, definition, operation, normalizeToolForProject(tool, project), clean.result)
    assert.deepEqual(codes(stale), ['postSetupOperationRefused'], `${label}: stale posted output refuses too`)
    assert.equal(stale.stats.moveCount, 0, `${label}: none of the affected motion is posted`)

    // The witness is geometry, not the predicate: the terminal cut's cutter
    // body overlaps the clamp box.
    const terminal = extremeCut(clean.result.moves, axis, 1)
    assert.ok(terminal && cutterBodyOverlapsClamp(terminal, radius, colliding), `${label}: the analytic cutter body overlaps the clamp at the far end`)

    // The growth is symmetric: a clamp before the near end, within the same
    // finite overhang, is refused too, and the near-end cut witnesses it.
    const reachMin = clean.result.moves
      .filter((move) => move.kind !== 'rapid')
      .reduce((min, move) => Math.min(min, axis === 'x' ? move.to.x : move.to.y), Number.POSITIVE_INFINITY)
    const near = pastEnd(reachMin - radius / 2)
    assert.equal(computeOperationToolpath({ ...project, clamps: [near] }, operation)!.result.moves.length, 0, `${label}: a clamp before the near end is refused too`)
    const start = extremeCut(clean.result.moves, axis, -1)
    assert.ok(start && cutterBodyOverlapsClamp(start, radius, near), `${label}: and the near-end cutter body overlaps it`)

    // With zero XY clearance the finite overhang is exactly the cutter radius:
    // the clamp a quarter-radius past the farthest cut still refuses, and one a
    // full radius + margin beyond it is clear.
    const noClearance = { ...project, meta: { ...project.meta, clampClearanceXY: 0 } }
    const zeroOverhang = pastEnd(reach + radius / 4)
    assert.equal(computeOperationToolpath({ ...noClearance, clamps: [zeroOverhang] }, operation)!.result.moves.length, 0, `${label}: zero clearance still refuses the cutter overhang`)
    const zeroClear = pastEnd(alongMax + 2 * radius)
    assert.ok(computeOperationToolpath({ ...noClearance, clamps: [zeroClear] }, operation)!.result.moves.length > 0, `${label}: and clears past the finite radius`)

    // Conservative over the whole blank: a clamp past the end face but inside
    // the finite cutter + clearance overhang is refused even though this
    // fixture's own path stopped short of the end.
    const atBlankEnd = pastEnd(alongMax + expand / 4)
    assert.equal(computeOperationToolpath({ ...project, clamps: [atBlankEnd] }, operation)!.result.moves.length, 0, `${label}: the blank-envelope overhang is refused too`)

    // A hidden clamp is still physical.
    const hidden = { ...project, clamps: [{ ...colliding, visible: false }] }
    assert.equal(computeOperationToolpath(hidden, operation)!.result.moves.length, 0, `${label}: a hidden clamp is still refused`)

    // A reversed machine refuses the same stale path.
    const reversed = postWithTool(blocked, machine('reversed', axis), operation, normalizeToolForProject(tool, project), clean.result)
    assert.deepEqual(codes(reversed), ['postSetupOperationRefused'], `${label}: reversed output refuses`)

    // Past the finite overhang the fixture is provably distant, and the
    // witness agrees: no endpoint's cutter body reaches it.
    const clear = pastEnd(alongMax + expand + 2 * clearance)
    assert.ok(computeOperationToolpath({ ...project, clamps: [clear] }, operation)!.result.moves.length > 0, `${label}: a clamp past the overhang is clear`)
    assert.ok(terminal && !cutterBodyOverlapsClamp(terminal, radius, clear), `${label}: and the cutter body does not reach it`)
  }
}

// ── 4c. the emitted cutter reference on square output ─────────

console.log('Testing the emitted cutter row on square output...')
{
  const { project, operation, tool } = fixture({ axis: 'x', units: 'mm', kind: 'rotary_finish' })
  const definition = machine('own', 'x')
  const toolpath = computeOperationToolpath(project, operation)!.result
  assert.ok(toolpath.moves.length > 0, 'fixture: the clean square path generates')
  const emitted = normalizeToolForProject(tool, project)
  const codes = (result: PostProcessorResult) => result.warnings.map((warning) => warning.code)

  // (a) The project row the operation references is gone. The physical guard
  // cannot resolve the cutter it must prove clear, and output must not post.
  const removed = postWithTool({ ...project, tools: [] }, definition, operation, emitted, toolpath)
  assert.deepEqual(codes(removed), ['postSetupOperationRefused'], 'a removed project tool refuses square output')
  assert.equal(removed.stats.moveCount, 0, 'and posts no motion')

  // (b) An empty toolRef names no cutter at all.
  const emptyRef = postWithTool(project, definition, { ...operation, toolRef: '' }, emitted, toolpath)
  assert.deepEqual(codes(emptyRef), ['postSetupOperationRefused'], 'an empty toolRef refuses square output')
  assert.equal(emptyRef.stats.moveCount, 0, 'and posts no motion')

  // (c) A stale entry carrying a *larger* cutter than the referenced row: the
  // guard could prove the 2 mm cutter clear and the emitter write an 8 mm one.
  const larger: NormalizedTool = { ...emitted, diameter: emitted.diameter * 4, radius: emitted.radius * 4 }
  const largerResult = postWithTool(project, definition, operation, larger, toolpath)
  assert.deepEqual(codes(largerResult), ['postSetupOperationRefused'], 'a stale larger cutter refuses square output')
  assert.equal(largerResult.stats.moveCount, 0, 'and posts no motion')

  // (d) A legitimate row in another unit system is converted, not a mismatch:
  // the inch record normalizes to exactly the mm radius the project's own
  // generation used.
  const inchTool = { ...tool, units: 'inch' as const, diameter: tool.diameter / MM_PER_INCH }
  const inchProject = { ...project, tools: [inchTool] }
  const inchPath = computeOperationToolpath(inchProject, operation)!.result
  const converted = postWithTool(inchProject, definition, operation, normalizeToolForProject(inchTool, inchProject), inchPath)
  assert.deepEqual(codes(converted), [], 'an inch tool row in an mm project is converted, not refused')
  assert.ok(converted.stats.moveCount > 0, 'and its motion posts')

  // (e) The measured stale case: zero project clamp clearances, a 4 mm flat
  // tool whose envelope reaches an ordinary clamp, then the project tool
  // removed. Both must refuse; the missing tool must not post 25 moves.
  const flatTool = { ...tool, type: 'flat_endmill' as const, diameter: 4 }
  const flatProject = { ...project, tools: [flatTool], meta: { ...project.meta, clampClearanceXY: 0, clampClearanceZ: 0 } }
  const clampIn = { id: 'flat', name: 'Flat clamp', type: 'step_clamp' as const, x: 8, y: barCentre(flatProject.stock as SquareStock) + 8.5, w: 5, h: 2, height: 30, visible: true }
  const flatPath = computeOperationToolpath(flatProject, operation)!.result
  assert.ok(flatPath.moves.length > 0, 'fixture: the 4 mm tool generates without the clamp')
  const flatEmitted = normalizeToolForProject(flatTool, flatProject)
  const withFlatClamp = { ...flatProject, clamps: [clampIn] }
  assert.deepEqual(
    codes(postWithTool(withFlatClamp, definition, operation, flatEmitted, flatPath)),
    ['postSetupOperationRefused'],
    'the 4 mm cutter envelope reaches the ordinary clamp',
  )
  assert.deepEqual(
    codes(postWithTool({ ...withFlatClamp, tools: [] }, definition, operation, flatEmitted, flatPath)),
    ['postSetupOperationRefused'],
    'and removing the project tool still refuses instead of posting the path',
  )
}

// ── 4e. the emitted cutter body on square output ──────────────

console.log('Testing the emitted cutter shape on square output...')

/**
 * The analytic lowest surface a cutter leaves, measured above the tool tip, at
 * a horizontal (tangential) offset `d` from the tool axis. A flat endmill's
 * bottom is a plane through the tip, so its surface is the tip at every offset
 * within its radius. A ball endmill of radius `r` touches the tip only on its
 * axis; at offset `d` its lowest point has risen by `r − √(r² − d²)`. The two
 * bodies therefore coincide at `d = 0` and differ for every `0 < d < r`: equal
 * radii are not interchangeable shapes. This witness is independent of the
 * guard — it is the geometry the same-radius substitution changes.
 */
function lowestSurfaceAboveTip(type: SupportedCutter, radius: number, offset: number): number {
  return type === 'flat_endmill' ? 0 : radius - Math.sqrt(Math.max(0, radius * radius - offset * offset))
}

{
  const radius = 2
  assert.equal(lowestSurfaceAboveTip('ball_endmill', radius, 0), 0, 'witness: both bodies reach the tip on the axis')
  const offset = radius * Math.sqrt(3) / 2
  const ball = lowestSurfaceAboveTip('ball_endmill', radius, offset)
  const flat = lowestSurfaceAboveTip('flat_endmill', radius, offset)
  assert.ok(ball - flat > 0, 'witness: a ball leaves stock the flat removes at a nonzero tangential offset')
  assert.ok(Math.abs(ball - radius / 2) < 1e-12, 'witness: the ball surface is exactly r/2 above the tip at d = r·√3/2')
  let witnessed = 0
  for (let step = 1; step < 40; step += 1) {
    const d = radius * step / 40
    assert.ok(
      lowestSurfaceAboveTip('ball_endmill', radius, d) > lowestSurfaceAboveTip('flat_endmill', radius, d),
      `witness: the flat and ball bodies differ at d = ${d.toFixed(4)}`,
    )
    witnessed += 1
  }
  console.log(`   ${witnessed} off-axis offsets confirm the ball stands ${ball.toFixed(4)} above the flat at d = r·√3/2`)
}

for (const axis of ['x', 'y'] as const) {
  for (const units of ['mm', 'inch'] as const) {
    for (const kind of ['rotary_rough', 'rotary_finish'] as const) {
      for (const toolType of ['flat_endmill', 'ball_endmill'] as const) {
        const label = `${axis}/${units}/${kind}/${toolType}`
        const { project, operation, tool } = fixture({ axis, units, kind, toolType })
        const definition = machine('own', axis)
        const envelope = computeOperationToolpath(project, operation)!
        assert.ok(envelope.result.moves.length > 0, `${label}: the fixture generates a real square turning path`)
        const emitted = normalizeToolForProject(tool, project)
        const clean = postWithTool(project, definition, operation, emitted, envelope.result)
        assert.deepEqual(clean.warnings, [], `${label}: the project's own supported shape posts`)
        assert.ok(clean.stats.moveCount > 0, `${label}: and posts its motion`)

        const codes = (result: PostProcessorResult) => result.warnings.map((warning) => warning.code)
        const refuses = (name: string, result: PostProcessorResult) => {
          assert.deepEqual(codes(result), ['postSetupOperationRefused'], `${label}: ${name} refuses`)
          assert.equal(result.stats.moveCount, 0, `${label}: ${name} posts no affected motion`)
        }

        // The same radius with the other supported shape: a ball where a flat
        // was referenced, or a flat where a ball was, removes a different solid
        // from the same tip. The equal radius does not make them one body.
        const other: SupportedCutter = toolType === 'flat_endmill' ? 'ball_endmill' : 'flat_endmill'
        refuses('a same-radius substituted shape', postWithTool(project, definition, operation, { ...emitted, type: other }, envelope.result))

        // An unsupported shape cannot be validated as another body: neither on
        // the emitted entry nor on the referenced project row.
        refuses('an unsupported emitted V bit', postWithTool(project, definition, operation, { ...emitted, type: 'v_bit' }, envelope.result))
        const vBitProject = { ...project, tools: [{ ...tool, type: 'v_bit' as const }] }
        refuses('an unsupported referenced V bit', postWithTool(vBitProject, definition, operation, { ...emitted, type: 'v_bit' }, envelope.result))

        // A body whose radius is not half its diameter is not one cutter — even
        // though that radius still matches the referenced row, so a radius-only
        // check would wave it through.
        const inconsistent = { ...emitted, diameter: emitted.diameter * 4, radius: emitted.radius }
        assert.ok(
          Math.abs(inconsistent.radius - emitted.radius) <= exportGeometryTolerance(units),
          `${label}: witness: the inconsistent body still matches the referenced radius`,
        )
        refuses('a radius that is not half its diameter', postWithTool(project, definition, operation, inconsistent, envelope.result))
        // Every non-finite or non-positive normalized dimension fails closed.
        for (const bad of [NaN, Infinity, 0, -1]) {
          refuses(`a radius of ${bad}`, postWithTool(project, definition, operation, { ...emitted, radius: bad }, envelope.result))
          refuses(`a diameter of ${bad}`, postWithTool(project, definition, operation, { ...emitted, diameter: bad }, envelope.result))
        }
        // Internally consistent but a different size from the referenced row.
        refuses('a consistently larger body', postWithTool(project, definition, operation, { ...emitted, diameter: emitted.diameter * 2, radius: emitted.radius * 2 }, envelope.result))

        // The row's identity is not cosmetic: `planProgramSequence` selects the
        // programme's tool number from the emitted `id`, so an entry naming
        // another *valid* project row writes a wrong-tool instruction even when
        // its shape and size were spoofed to match. The refusal is posted
        // output with tool changes enabled, where the wrong number would appear.
        const secondRecord: Tool = { ...tool, id: 't2', name: 'Second cutter' }
        const twoToolProject = { ...project, tools: [tool, secondRecord] }
        const wrongId = { ...emitted, id: 't2' }
        assert.equal(wrongId.type, emitted.type, `${label}: witness: the wrong-id row keeps the referenced shape`)
        assert.equal(wrongId.diameter, emitted.diameter, `${label}: witness: and the referenced diameter`)
        refuses(
          'an emitted row naming another valid tool row',
          postWithTool(twoToolProject, definition, operation, wrongId, envelope.result, { emitToolChanges: true }),
        )
        const correctId = postWithTool(twoToolProject, definition, operation, emitted, envelope.result, { emitToolChanges: true })
        assert.deepEqual(correctId.warnings, [], `${label}: the operation's own row posts with tool changes on`)
        assert.match(correctId.gcode, /; Tool 1:/, `${label}: and writes its own tool number`)

        // The normalized unit label is not cosmetic either: the same numbers
        // labelled in another system are a different body to the machine.
        const wrongUnits = { ...emitted, units: units === 'mm' ? 'inch' as const : 'mm' as const }
        assert.equal(wrongUnits.radius, emitted.radius, `${label}: witness: the wrong-unit row keeps the same numbers`)
        refuses('a normalized row labelled in another unit system', postWithTool(project, definition, operation, wrongUnits, envelope.result))

        // A genuine row written in the other unit system is converted, not a
        // mismatch: the same physical flat or ball, under the same id, posts.
        const otherRecord = convertToolUnits(tool, units === 'mm' ? 'inch' : 'mm')
        assert.equal(otherRecord.id, tool.id, `${label}: witness: conversion keeps the referenced identity`)
        const otherProject = { ...project, tools: [otherRecord] }
        const otherPath = computeOperationToolpath(otherProject, operation)!.result
        const converted = postWithTool(otherProject, definition, operation, normalizeToolForProject(otherRecord, otherProject), otherPath)
        assert.deepEqual(converted.warnings, [], `${label}: a converted-locale row is not a stale cutter`)
        assert.ok(converted.stats.moveCount > 0, `${label}: and its motion posts`)
      }
    }
  }
}

// ── 4d. invalid project dimensions and clearances fail closed ─

console.log('Testing invalid project dimensions and clearances fail closed...')
{
  const base = fixture({ axis: 'x', units: 'mm', kind: 'rotary_rough' })
  const centre = barCentre(base.stock)
  const refused = (overrides: Partial<Project>): string | undefined =>
    computeOperationToolpath({ ...base.project, ...overrides }, base.operation)!.result.warnings[0]?.code
  const bad = (overrides: Partial<Clamp>): Clamp => ({
    id: 'bad', name: 'Bad clamp', type: 'step_clamp',
    x: 200, y: centre - 1, w: 2, h: 2, height: 10, visible: true,
    ...overrides,
  })
  // Axially far from the blank: the row must still be judged, not skipped.
  for (const height of [0, -1, NaN, Infinity]) {
    assert.equal(refused({ clamps: [bad({ height })] }), 'postSetupOperationRefused', `a clamp height of ${height} fails closed even when distant`)
  }
  for (const [key, value] of [
    ['w', 0], ['w', NaN], ['w', -3], ['h', 0], ['h', Infinity],
  ] as const) {
    assert.equal(refused({ clamps: [bad({ [key]: value })] }), 'postSetupOperationRefused', `a clamp ${key} of ${value} fails closed`)
  }
  // A far corner that overflows to infinity is not a finite box.
  assert.equal(refused({ clamps: [bad({ x: 1e308, w: 1e308 })] }), 'postSetupOperationRefused', 'an overflowing far corner fails closed')
  // Non-finite clearances must not silently shrink the swept envelope.
  for (const clampClearanceXY of [NaN, Infinity, -Infinity]) {
    assert.equal(refused({ meta: { ...base.project.meta, clampClearanceXY } }), 'postSetupOperationRefused', `an XY clearance of ${clampClearanceXY} fails closed`)
  }
  for (const clampClearanceZ of [NaN, Infinity, -Infinity]) {
    assert.equal(refused({ meta: { ...base.project.meta, clampClearanceZ } }), 'postSetupOperationRefused', `a Z clearance of ${clampClearanceZ} fails closed`)
  }
  // A blank with no axial extent has no envelope to prove anything against.
  const degenerate = { ...base.project, stock: { ...base.stock, profile: rectProfile(0, 0, 0, 12) } }
  assert.equal(
    computeOperationToolpath(degenerate, base.operation)!.result.warnings[0]?.code,
    'postSetupOperationRefused',
    'a blank with no axial extent fails closed',
  )
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
