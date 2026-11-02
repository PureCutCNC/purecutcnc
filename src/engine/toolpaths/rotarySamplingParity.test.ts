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
 * Sync/async parity for rotary sampling (#1115 slice p-d1).
 *
 * The slice reshaped rotary sampling into preparation, a per-angle job, ordered
 * assembly and shared refinement decisions, and added an asynchronous driver
 * around the same parts. The claim that lets a worker pool be built on it is
 * that the reshape changed nothing: the same rows, the same lifts, the same
 * warnings, the same moves and the same posted program, whichever driver runs
 * them. This file is where that claim is checked, and each check is the one a
 * named mutation breaks:
 *
 * - **rows, lifts and warnings** (`sampleRotaryModel` = `sampleRotaryModelAsync`)
 *   on a hexagonal prism in a round bar on both axes and on a square blank,
 *   around (`conservativeCellBounds`) and along. The lift is part of the
 *   comparison because it is no longer applied inside the angle: dropping the
 *   central application leaves every row one cell rise low and this fails.
 * - **warning preservation and merge order** against parameters derived from the
 *   geometry, not from the other driver: a tight requested cell size makes
 *   every angle raise `surfaceHeightMapReduced` with its own cell count, so the
 *   first-code-wins merge has to keep the first angle's numbers and drop the
 *   later angles' -- with batches answered in reverse too. A driver-to-driver
 *   comparison cannot see this: both drivers share the assembler, so a mutation
 *   that drops every per-angle warning from it leaves them equal.
 * - **moves and posted bytes** through `computeOperationToolpath` =
 *   `computeOperationToolpathAsync` for the canned Turn/Polygon project (an STL
 *   prism plus an Around rectangle), rough and finish, around and along, on an
 *   X bar and a Y bar -- the p-a fixture classes in miniature.
 * - **arrival order** (a runner that returns every batch reversed), on both the
 *   sampling call and a full generation. Assembling in arrival order instead of
 *   by index reverses the angle rows and fails here, and only here.
 * - **the central lift** as an identity: the assembled row is the job's row plus
 *   its lift through the Float32 store, sample by sample.
 * - **refinement** on the same hex: the refined grid must be strictly ascending,
 *   contain every base angle in order, add midpoints (non-vacuity) and equal a
 *   recorded sequence. Appending the midpoints after the whole grid, or
 *   inserting them anywhere but directly after their own segment, changes that
 *   sequence and fails -- the async twin must match too.
 *
 * The p-a benchmark fixtures are 32 MB `.camj` files in the gitignored `work/`
 * and cost about 35 s of generation per operation, so the full parity run over
 * them is off by default: set `ROTARY_PARITY_FIXTURES=1` with
 * `work/busto-rect-stock.camj` and `work/busto-round-stock.camj` present (copied
 * from the p-a worktree) to run it. Both files save their operations `around`,
 * so the matrix forces **both directions** on every operation and compares
 * every output the handoff names: the base grid's rows and lifts, its warnings,
 * the moves, the bounds and the posted bytes. The base rows and lifts also equal
 * a recorded digest, because a shared change to the sampler would otherwise
 * move both drivers together and no parity check could see it.
 *
 * Run with: npx tsx src/engine/toolpaths/rotarySamplingParity.test.ts
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { roundStock } from '../../types/project'
import type { BarStock, Operation, Project } from '../../types/project'
import { barCentre, barPivotZ, squareStock } from '../../types/barStock'
import { rotaryOperationFixture } from '../../test/rotaryOperationFixture'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { normalizeProject } from '../../store/helpers/projectFormat'
import { BUNDLED_DEFINITIONS } from '../gcode/definitions'
import { runPostProcessor } from '../gcode/postprocessor'
import { validateMachineDefinition } from '../gcode/types'
import type { MachineDefinition } from '../gcode/types'
import { normalizeToolForProject } from './geometry'
import { computeOperationToolpath, computeOperationToolpathAsync } from './generateOperation'
import {
  assembleRotarySampling,
  createRotarySamplingPrep,
  refineAroundSampling,
  refineAroundSamplingAsync,
  runRotaryAngleJob,
  sampleAnglesWithPrep,
  sampleRotaryModel,
  sampleRotaryModelAsync,
  serialRotaryBatches,
  turnedModelPositions,
} from './rotarySampling'
import type {
  RotaryAngleJob,
  RotaryAngleSample,
  RotaryBatchFactory,
  RotaryModelMesh,
  RotarySampleOptions,
  RotarySamplingPrep,
} from './rotarySampling'
import type { NormalizedTool, ToolpathResult } from './types'
import type { ToolpathWarning } from './warningCodes'

const BALL: NormalizedTool = {
  id: 'ball-3', name: '3 mm ball nose', sourceUnits: 'mm', units: 'mm',
  type: 'ball_endmill', diameter: 3, radius: 1.5, vBitAngle: null,
  flutes: 2, material: 'carbide', defaultRpm: 0, defaultFeed: 0,
  defaultPlungeFeed: 0, defaultStepdown: 0, defaultStepover: 0, maxCutDepth: 0,
}

/** A closed extrusion: two triangulated caps and triangulated side quads. */
function prism(
  stock: BarStock,
  crossSection: readonly (readonly [number, number])[],
  ends: readonly [number, number],
): RotaryModelMesh {
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const positions: number[] = []
  const index: number[] = []
  for (const along of ends) {
    for (const [across, up] of crossSection) {
      if (stock.axis === 'x') positions.push(along, centre + across, pivot + up)
      else positions.push(centre + across, along, pivot + up)
    }
  }
  const n = crossSection.length
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    index.push(i, j, n + j, i, n + j, n + i)
  }
  for (let i = 1; i < n - 1; i++) index.push(0, i + 1, i, n, n + i, n + i + 1)
  return { positions: new Float32Array(positions), index: new Uint32Array(index) }
}

/**
 * A hexagonal prism, the sharp-section fixture #1045's between-sample bound was
 * measured on: its vertices are what make the around refinement fire.
 */
const HEX_RADIUS = 8
const HEX_SECTION = Array.from({ length: 6 }, (_, i): readonly [number, number] => {
  const t = Math.PI * i / 3
  return [HEX_RADIUS * Math.cos(t), HEX_RADIUS * Math.sin(t)]
})

/** Every stock the parity claims are checked on: both axes, round and square. */
const STOCKS: Array<{ name: string; stock: BarStock }> = [
  { name: 'round X', stock: roundStock(40, 20, 'x', { x: 10, y: 7 }) },
  { name: 'round Y', stock: roundStock(40, 20, 'y', { x: 7, y: 10 }) },
  { name: 'square X', stock: squareStock(30, 20, 'x', { x: 10, y: 7 }) },
  { name: 'square Y', stock: squareStock(30, 20, 'y', { x: 7, y: 10 }) },
]

const ANGLES = [0, 15, 45, 90, 135, 180, 225, 270, 315]
const ALONG = [12, 14, 15.5, 17]

function sampleOptions(conservativeCellBounds: boolean): RotarySampleOptions {
  return {
    anglesDeg: ANGLES,
    along: ALONG,
    requestedCellSize: 0.2,
    ...(conservativeCellBounds ? { conservativeCellBounds: true } : {}),
  }
}

/**
 * A runner that answers every batch in reverse arrival order.
 *
 * The driver has to assemble by each result's own index; a driver that appends
 * results as they arrive produces the angles backwards and the rows in the wrong
 * places, which every comparison below notices.
 */
const reversedBatches: RotaryBatchFactory = (prep) => {
  const serial = serialRotaryBatches(prep)
  return async (jobs) => [...await serial(jobs)].reverse()
}

/** The same angles, rows and lifts, however they were produced. */
function assertSamplingEqual(
  actual: ReturnType<typeof sampleRotaryModel>,
  expected: ReturnType<typeof sampleRotaryModel>,
  label: string,
): void {
  assert.deepEqual(actual.anglesDeg, expected.anglesDeg, `${label}: angles`)
  assert.deepEqual(actual.along, expected.along, `${label}: along positions`)
  assert.deepEqual(actual.lifts, expected.lifts, `${label}: lifts`)
  assert.equal(actual.stopped, expected.stopped, `${label}: stopped`)
  assert.equal(actual.valid, expected.valid, `${label}: valid`)
  assert.equal(actual.tipRadius.length, expected.tipRadius.length, `${label}: row count`)
  for (let k = 0; k < expected.tipRadius.length; k++) {
    assert.deepEqual(actual.tipRadius[k], expected.tipRadius[k], `${label}: row ${k}`)
  }
}

/** A posted program with only the generation date normalised, so two runs compare. */
function normalizeDate(gcode: string): string {
  return gcode.replace(/Generated by PureCutCNC on \d{4}-\d{2}-\d{2}/g, 'Generated by PureCutCNC on <date>')
}

/** The baseline machine the probe uses: bundled grbl plus a rotary block about `axis`. */
function rotaryMachine(project: Project): MachineDefinition {
  const base = BUNDLED_DEFINITIONS.find((definition) => definition.id === 'grbl')
  assert.ok(base, 'the bundled definitions must include grbl')
  const axis = project.stock.shape === 'round' || project.stock.shape === 'square' ? project.stock.axis : 'x'
  return validateMachineDefinition({
    ...structuredClone(base),
    rotary: { about: axis ?? 'x', drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
  })
}

function post(project: Project, operation: Operation, result: ToolpathResult): string {
  const tool = normalizeToolForProject(
    project.tools.find((candidate) => candidate.id === operation.toolRef) ?? project.tools[0],
    project,
  )
  return normalizeDate(runPostProcessor({
    project,
    operations: [{ operation, tool, toolpath: result }],
    definition: rotaryMachine(project),
    options: { emitToolChanges: true, emitCoolant: false, programName: project.meta.name },
  }).gcode)
}

// ── sampling: rows, lifts and warnings ──────────────────────

for (const { name, stock } of STOCKS) {
  const mesh = prism(stock, HEX_SECTION, [10, 30])
  for (const conservativeCellBounds of [true, false]) {
    const mode = conservativeCellBounds ? 'around' : 'along'
    const syncWarnings: ToolpathWarning[] = []
    const asyncWarnings: ToolpathWarning[] = []
    const options = sampleOptions(conservativeCellBounds)
    const sync = sampleRotaryModel(mesh, stock, BALL, options, syncWarnings)
    const asyncResult = await sampleRotaryModelAsync(mesh, stock, BALL, options, asyncWarnings)
    assertSamplingEqual(asyncResult, sync, `${name} ${mode}`)
    assert.deepEqual(asyncWarnings, syncWarnings, `${name} ${mode}: warnings in angle order`)
    // Non-vacuity: the grid really produced rows, and around mode really lifted.
    assert.equal(sync.tipRadius.length, ANGLES.length, `${name} ${mode}: every angle sampled`)
    assert.ok(sync.tipRadius.every((row) => row.length === ALONG.length), `${name} ${mode}: every along sampled`)
    assert.ok(sync.tipRadius.some((row) => Array.from(row).some((value) => Number.isFinite(value))),
      `${name} ${mode}: the mesh is inside the bar`)
    if (conservativeCellBounds) {
      assert.ok(sync.lifts.some((lift) => lift > 0), `${name} ${mode}: a conservative row was lifted`)
    } else {
      assert.deepEqual(sync.lifts, ANGLES.map(() => 0), `${name} ${mode}: no cell rise without the option`)
    }
    // Arrival order is not output order.
    const reversed = await sampleRotaryModelAsync(mesh, stock, BALL, options, [], reversedBatches)
    assertSamplingEqual(reversed, sync, `${name} ${mode} reversed`)
  }
}

// ── warnings: preserved, and merged first-code-wins in angle order ─────────

/**
 * `chooseHeightMapCellSize` raises `surfaceHeightMapReduced` for every angle
 * whose turned envelope needs more than the cell budget, with **that angle's own
 * requested cell count** in `params.from`. A tight requested cell size makes
 * every angle of the hex raise the same code with different parameters -- the
 * case where "the two drivers agree" says nothing, because dropping every
 * per-angle warning from the shared assembler leaves both of them warning-free
 * and equal. So the expectations here are computed from the turned geometry and
 * compared literally, and the batch is answered in reverse as well: the merge
 * must keep the **first angle in angle order**'s parameters, not the first
 * result to arrive, which in the reversed run is the last angle's.
 */
{
  const stock = STOCKS[0].stock
  const mesh = prism(stock, HEX_SECTION, [10, 30])
  const angles = [0, 30, 60, 90, 120, 150]
  const requestedCellSize = 0.01
  const options: RotarySampleOptions = {
    anglesDeg: angles, along: ALONG, requestedCellSize, conservativeCellBounds: true,
  }
  const TO = (1_000_000).toLocaleString()
  // One `from` per angle, from the mesh turned by the same rule the job uses --
  // independent of `chooseHeightMapCellSize` and of the assembler under test.
  const expectedFrom = angles.map((angle) => {
    const turned = turnedModelPositions(mesh.positions, stock, angle)
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (let i = 0; i < turned.length; i += 3) {
      if (turned[i] < minX) minX = turned[i]
      if (turned[i] > maxX) maxX = turned[i]
      if (turned[i + 1] < minY) minY = turned[i + 1]
      if (turned[i + 1] > maxY) maxY = turned[i + 1]
    }
    const cell = Math.max(requestedCellSize, 1e-6)
    const cells = Math.max(1, Math.ceil((maxX - minX) / cell)) * Math.max(1, Math.ceil((maxY - minY) / cell))
    return cells.toLocaleString()
  })
  assert.ok(new Set(expectedFrom).size > 1,
    `the fixture must raise one code with different parameters per angle, or ordering cannot be observed (${expectedFrom.join(', ')})`)
  assert.notEqual(expectedFrom[0], expectedFrom[angles.length - 1],
    'the first and last angles must differ, or the reversed run cannot tell angle order from arrival order')
  const warningFrom = (from: string): ToolpathWarning =>
    ({ code: 'surfaceHeightMapReduced', params: { from, to: TO } })
  // Every angle's own job carries its own parameters.
  const prep = createRotarySamplingPrep(mesh, stock, BALL, {
    along: ALONG, requestedCellSize, conservativeCellBounds: true,
  })
  const plan = prep.planFor(angles)
  for (let k = 0; k < angles.length; k++) {
    const sample = runRotaryAngleJob(prep, plan, { index: k, angle: angles[k] })
    assert.deepEqual(sample.warnings, [warningFrom(expectedFrom[k])],
      `angle ${angles[k]} must raise the reduced-cell warning with its own count`)
  }
  // The assembly keeps one warning per code, in angle order: the first angle's.
  const expected: ToolpathWarning[] = [warningFrom(expectedFrom[0])]
  const syncWarnings: ToolpathWarning[] = []
  const sync = sampleAnglesWithPrep(prep, angles, syncWarnings)
  assert.equal(sync.tipRadius.length, angles.length, 'the sync driver samples every angle')
  assert.deepEqual(syncWarnings, expected, 'sync: the first angle in angle order supplies the parameters')
  for (const [label, factory] of [
    ['async', serialRotaryBatches],
    ['async reversed', reversedBatches],
  ] as const) {
    const asyncWarnings: ToolpathWarning[] = []
    const asyncResult = await sampleRotaryModelAsync(mesh, stock, BALL, options, asyncWarnings, factory)
    assert.equal(asyncResult.tipRadius.length, angles.length, `${label}: every angle sampled`)
    assert.deepEqual(asyncWarnings, expected,
      `${label}: the first angle in angle order supplies the parameters, whatever order results arrive in`)
  }
}

// ── the central lift is the whole difference between a job and its row ──

for (const { name, stock } of STOCKS) {
  const mesh = prism(stock, HEX_SECTION, [10, 30])
  const prep = createRotarySamplingPrep(mesh, stock, BALL, {
    along: ALONG,
    requestedCellSize: 0.2,
    conservativeCellBounds: true,
  })
  const plan = prep.planFor(ANGLES)
  const jobs = ANGLES.map((angle, index) => ({ index, angle }))
  const samples = jobs.map((job) => runRotaryAngleJob(prep, plan, job))
  const assembled = sampleAnglesWithPrep(prep, ANGLES, [])
  assert.deepEqual(assembled.lifts, samples.map((sample) => sample.lift), `${name}: lifts are reported as sampled`)
  let lifted = 0
  for (let k = 0; k < samples.length; k++) {
    const sample = samples[k]
    if (sample.lift > 0) lifted += 1
    for (let i = 0; i < sample.row.length; i++) {
      const raw = sample.row[i]
      // `row[i] += lift` on a Float32Array stores `Math.fround(raw + lift)`, and
      // a `NaN` (no model under the tool) stays a `NaN`.
      const expected = Number.isFinite(raw) ? Math.fround(raw + sample.lift) : NaN
      const actual = assembled.tipRadius[k][i]
      assert.ok(Object.is(actual, expected),
        `${name}: angle ${k} along ${i} assembled ${actual} but the job reported ${raw} + ${sample.lift}`)
    }
  }
  assert.ok(lifted > 0, `${name}: at least one angle carries a lift, or the central application proves nothing`)
}

// ── generation: moves, warnings and posted bytes ────────────

const AXES = ['x', 'y'] as const
const KINDS = ['rotary_finish', 'rotary_rough'] as const
const DIRECTIONS = ['around', 'along'] as const

for (const axis of AXES) {
  for (const kind of KINDS) {
    for (const direction of DIRECTIONS) {
      const project = rotaryOperationFixture(axis, kind)
      const operation: Operation = { ...project.operations[0], rotaryPassDirection: direction }
      const label = `${axis} ${kind} ${direction}`
      const sync = computeOperationToolpath(project, operation)
      const asyncEnvelope = await computeOperationToolpathAsync(project, operation)
      assert.ok(sync, `${label}: the synchronous entry generates`)
      assert.ok(asyncEnvelope, `${label}: the asynchronous entry generates`)
      assert.ok(sync.result.moves.length > 0, `${label}: emits motion`)
      assert.deepEqual(asyncEnvelope.result.moves, sync.result.moves, `${label}: moves`)
      assert.deepEqual(asyncEnvelope.result.warnings, sync.result.warnings, `${label}: warnings`)
      assert.deepEqual(asyncEnvelope.result.bounds, sync.result.bounds, `${label}: bounds`)
      assert.equal(
        post(project, operation, asyncEnvelope.result),
        post(project, operation, sync.result),
        `${label}: posted program`,
      )
      // And the same again with every batch answering in reverse.
      const reversed = await computeOperationToolpathAsync(project, operation, { rotaryRunBatch: reversedBatches })
      assert.ok(reversed, `${label} reversed: the asynchronous entry generates`)
      assert.deepEqual(reversed.result.moves, sync.result.moves, `${label} reversed: moves`)
      assert.deepEqual(reversed.result.warnings, sync.result.warnings, `${label} reversed: warnings`)
    }
  }
}

// ── the async entry changes only rotary sampling ────────────

{
  const project = rotaryOperationFixture('x', 'rotary_finish')
  const operation = project.operations[0]
  // A rotary operation whose setup blocks it is refused by the synchronous code,
  // and the asynchronous entry must return exactly that refusal rather than
  // sampling a blocked job.
  const blocked = { ...operation, setupId: project.setups[0].id }
  const blockedSync = computeOperationToolpath(project, blocked)
  const blockedAsync = await computeOperationToolpathAsync(project, blocked)
  assert.ok(blockedSync && blockedAsync, 'a blocked rotary operation still produces a result')
  assert.deepEqual(blockedAsync.result, blockedSync.result, 'a blocked rotary operation is refused identically')
  assert.ok(blockedSync.result.moves.length === 0, 'the block really refuses motion, or the comparison is vacuous')

  // Every non-rotary kind is delegated to the synchronous path untouched.
  const pocket = defaultOperationForTarget(
    project, 'pocket', 'rough', { source: 'features', featureIds: ['sketch'] }, project.operations.length,
  )
  const pocketOperation = { ...pocket, setupId: project.setups[0].id }
  const pocketSync = computeOperationToolpath(project, pocketOperation)
  const pocketAsync = await computeOperationToolpathAsync(project, pocketOperation)
  assert.deepEqual(pocketAsync?.result ?? null, pocketSync?.result ?? null,
    'a non-rotary operation runs the synchronous code')
}

// ── refinement: insertion order, cache and the async twin ───

{
  const stock = STOCKS[0].stock
  const mesh = prism(stock, HEX_SECTION, [10, 30])
  const base = Array.from({ length: 24 }, (_, k) => 360 * k / 24)
  const options: RotarySampleOptions = {
    anglesDeg: base, along: ALONG, requestedCellSize: 0.2, conservativeCellBounds: true,
  }
  const tips = sampleRotaryModel(mesh, stock, BALL, options, []).tipRadius
  const prep = createRotarySamplingPrep(mesh, stock, BALL, {
    along: ALONG, requestedCellSize: 0.2, conservativeCellBounds: true,
  })
  const args = { prep, stock, tool: BALL, warnings: [], angles: base, tips }
  const refined = refineAroundSampling(args)
  assert.ok(refined, 'the hex grid refines a round bar')
  assert.ok(refined.angles.length > base.length,
    `the hex must add at least one midpoint, else the order claim is vacuous (${refined.angles.length} angles)`)
  for (let k = 1; k < refined.angles.length; k++) {
    assert.ok(refined.angles[k] > refined.angles[k - 1],
      `refined angle ${k} (${refined.angles[k]}) must be above the one before it (${refined.angles[k - 1]})`)
  }
  // Every base angle survives, in order: refinement subdivides the grid, it does
  // not replace it.
  let cursor = 0
  for (const angle of base) {
    while (cursor < refined.angles.length && refined.angles[cursor] !== angle) cursor += 1
    assert.ok(cursor < refined.angles.length, `base angle ${angle} is missing from the refined grid`)
  }
  // The recorded grid, as a digest: it pins **which** midpoints are kept and in
  // what order. Re-record it only with a deliberate change to the refinement
  // rule, and expect the emitted motion to move with it.
  assert.equal(
    createHash('sha256').update(JSON.stringify(refined.angles)).digest('hex'),
    'e675da3980c0cdf64a8c7009805da3fef71cfcd98adb017a991ca618fc574b14',
    'the refined grid changed: which midpoints survive, or their order, moved',
  )
  // Every added angle lies strictly inside the base segment it bisects, which is
  // the property an insertion-order change breaks even when the set is right.
  const baseSet = new Set(base)
  for (let k = 0; k < refined.angles.length; k++) {
    const angle = refined.angles[k]
    if (baseSet.has(angle)) continue
    let before = -Infinity
    let after = Infinity
    for (const candidate of base) {
      if (candidate < angle) before = candidate
      else { after = candidate; break }
    }
    assert.ok(angle > before && angle < after, `added angle ${angle} must bisect a base segment`)
  }

  const asyncRefined = await refineAroundSamplingAsync(args, serialRotaryBatches(prep))
  assert.ok(asyncRefined, 'the async twin refines the same grid')
  assert.deepEqual(asyncRefined.angles, refined.angles, 'async refinement: angles')
  assert.deepEqual(asyncRefined.tips, refined.tips, 'async refinement: rows')
  const reversedRefined = await refineAroundSamplingAsync(args, reversedBatches(prep))
  assert.ok(reversedRefined, 'the async twin refines with batches reversed')
  assert.deepEqual(reversedRefined.angles, refined.angles, 'reversed refinement: angles')
  assert.deepEqual(reversedRefined.tips, refined.tips, 'reversed refinement: rows')
}

// ── the p-a benchmark fixtures, when asked for ──────────────

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../../..')

/**
 * One dispatch of the asynchronous driver, kept for the comparison: the jobs'
 * angles, and every result with its row **copied**.
 *
 * The copy matters: assembly applies each sample's lift to the `Float32Array` in
 * place, and the driver assembles the very arrays the runner returned. Keeping
 * the references would read the rows back already lifted and compare a lifted
 * row against a lifted row, which is the identity, not the check.
 */
interface CapturedRotaryBatch {
  readonly jobs: readonly RotaryAngleJob[]
  readonly samples: readonly RotaryAngleSample[]
}

/** A batch factory that records the prep and every batch it is asked to run. */
function captureRotaryBatches(): {
  readonly factory: RotaryBatchFactory
  readonly prep: () => RotarySamplingPrep | null
  readonly batches: CapturedRotaryBatch[]
} {
  let captured: RotarySamplingPrep | null = null
  const batches: CapturedRotaryBatch[] = []
  return {
    factory: (prep) => {
      captured = prep
      const serial = serialRotaryBatches(prep)
      return async (jobs) => {
        const samples = await serial(jobs)
        batches.push({
          jobs: [...jobs],
          samples: samples.map((sample) => ({ ...sample, row: sample.row.slice() })),
        })
        return samples
      }
    },
    prep: () => captured,
    batches,
  }
}

/** The same prep, with fresh scratch: the synchronous driver's install of it. */
function freshPrep(prep: RotarySamplingPrep): RotarySamplingPrep {
  return createRotarySamplingPrep(prep.mesh, prep.stock, prep.tool, {
    along: prep.along,
    requestedCellSize: prep.requestedCellSize,
    ...(prep.conservativeCellBounds ? { conservativeCellBounds: true } : {}),
    ...(prep.wallTriangleStart !== undefined ? { wallTriangleStart: prep.wallTriangleStart } : {}),
    ...(prep.gridExtra !== undefined ? { gridExtra: prep.gridExtra } : {}),
  })
}

/**
 * The base grid's rows and lifts, as a digest, per fixture operation and
 * direction.
 *
 * A driver-to-driver comparison cannot police a change to the sampler itself:
 * both drivers run the same per-angle job and the same assembly, so a shared
 * regression moves both answers together and leaves them equal. These digests
 * pin the values the pre-p-d1 synchronous code produced. The moves and posted
 * programs built on them are byte-identical to the pre-p-d1 code (commit
 * `cf06f791`) in **both** directions, and to the p-a baseline's stored hashes
 * around, so the fixture matrix fails on a shared change instead of quietly
 * agreeing with itself.
 *
 * Re-record only with a deliberate change to the sampled values, and expect the
 * emitted motion and the posted program to move with it.
 */
const FIXTURE_SAMPLING_DIGESTS: Record<string, string> = {
  'busto-rect-stock.camj op0021 around':
    '1bc17b61ef0470952340d8f4319fef5e8f52ba791d24021c92e18ddb0c5b2274',
  'busto-rect-stock.camj op0021 along':
    '4911c476d1cc05850a735d5eb0e3c769b8013e17431bec785a623f54fc11981a',
  'busto-rect-stock.camj op0022 around':
    '70420aa37793b513bcf6584fba6fb04e9ce034ec96afd65ed95f02da0a996a31',
  'busto-rect-stock.camj op0022 along':
    '133b7c67cd85de23f43ad301efafaae924d9816763b407f94ed0bf69afd3da12',
  'busto-round-stock.camj op0025 around':
    '9553bb5897b3e09bbaf08d8b0d399eac44ee27a6b23a45ba7a2c325c421f4e1c',
  'busto-round-stock.camj op0025 along':
    'b3d7fdd6a81356b728c1f985db3470c71823a29786656500a8e1c1cfcd5378c6',
  'busto-round-stock.camj op0015 around':
    '9e128e6777d9c07a1f386af96c9ce35d2655679051604af7a38b8a66bab46b0b',
  'busto-round-stock.camj op0015 along':
    'ff36ff827c12e12b4c07758ea7dfa7647761a78575794a9812affbadbdbe95f1',
};

if (process.env.ROTARY_PARITY_FIXTURES === '1') {
  const fixtures = ['busto-rect-stock.camj', 'busto-round-stock.camj']
  for (const name of fixtures) {
    const path = join(ROOT, 'work', name)
    if (!existsSync(path)) {
      assert.fail(`${path} is missing: copy the p-a work/ fixtures before running ROTARY_PARITY_FIXTURES=1`)
    }
    const project = normalizeProject(JSON.parse(readFileSync(path, 'utf8')))
    const rotaryOperations = project.operations.filter(
      (candidate) => candidate.kind === 'rotary_rough' || candidate.kind === 'rotary_finish')
    // Both files save every operation `around`; the handoff requires the along
    // cases as controls, so the matrix forces each direction over the saved row.
    for (const saved of rotaryOperations) {
      for (const direction of DIRECTIONS) {
        const operation: Operation = { ...saved, rotaryPassDirection: direction }
        const label = `${name} ${saved.id} ${saved.kind} ${direction}`
        console.log(`${label}: generating synchronously…`)
        const sync = computeOperationToolpath(project, operation)
        assert.ok(sync, `${label}: the synchronous entry generates`)
        assert.ok(sync.result.moves.length > 0, `${label}: the synchronous entry emits motion`)
        const capture = captureRotaryBatches()
        console.log(`${label}: generating asynchronously…`)
        const asyncEnvelope = await computeOperationToolpathAsync(project, operation, {
          rotaryRunBatch: capture.factory,
        })
        assert.ok(asyncEnvelope, `${label}: the asynchronous entry generates`)
        assert.ok(asyncEnvelope.result.moves.length > 0, `${label}: the asynchronous entry emits motion`)
        assert.deepEqual(asyncEnvelope.result.moves, sync.result.moves, `${label}: moves`)
        assert.deepEqual(asyncEnvelope.result.warnings, sync.result.warnings, `${label}: warnings`)
        assert.deepEqual(asyncEnvelope.result.bounds, sync.result.bounds, `${label}: bounds`)
        assert.equal(post(project, operation, asyncEnvelope.result), post(project, operation, sync.result),
          `${label}: posted program`)

        // Rows, lifts and warnings: the batch the operation's own grid produced
        // is assembled here, and the synchronous driver samples the same angle
        // list from the same prep. Every later batch is a refinement round whose
        // rows are compared through the motion they produce above: both drivers
        // run the identical refinement over them and the posted program matches.
        const prep = capture.prep()
        assert.ok(prep, `${label}: the asynchronous driver dispatched at least one batch`)
        if (direction === 'around') {
          assert.ok(capture.batches.length > 1,
            `${label}: around mode must refine, or the matrix never exercises a second batch`)
        } else {
          assert.equal(capture.batches.length, 1, `${label}: along mode dispatches one batch`)
        }
        const base = capture.batches[0]
        assert.ok(base, `${label}: the base angle batch was dispatched`)
        const syncWarnings: ToolpathWarning[] = []
        const syncSampling = sampleAnglesWithPrep(freshPrep(prep), base.jobs.map((job) => job.angle), syncWarnings)
        const asyncWarnings: ToolpathWarning[] = []
        const asyncSampling = assembleRotarySampling(prep, base.jobs, base.samples, asyncWarnings, false)
        assert.deepEqual(asyncSampling.anglesDeg, syncSampling.anglesDeg, `${label}: base angles`)
        assert.deepEqual(asyncSampling.lifts, syncSampling.lifts, `${label}: lifts`)
        assert.equal(asyncSampling.tipRadius.length, syncSampling.tipRadius.length, `${label}: base row count`)
        for (let k = 0; k < syncSampling.tipRadius.length; k++) {
          assert.deepEqual(asyncSampling.tipRadius[k], syncSampling.tipRadius[k], `${label}: base row ${k}`)
        }
        assert.deepEqual(asyncWarnings, syncWarnings, `${label}: base warnings`)
        // Non-vacuity: the grid really sampled the model, and along mode really
        // carries no cell-rise lift.
        assert.ok(asyncSampling.tipRadius.some((row) => Array.from(row).some((value) => Number.isFinite(value))),
          `${label}: the base grid samples the model`)
        if (direction === 'along') {
          assert.deepEqual(asyncSampling.lifts, base.jobs.map(() => 0),
            `${label}: along mode asks for no conservative cell rise`)
        }
        const digest = createHash('sha256').update(JSON.stringify({
          angles: asyncSampling.anglesDeg,
          lifts: asyncSampling.lifts,
          rows: asyncSampling.tipRadius.map((row) => Array.from(row)),
        })).digest('hex')
        assert.equal(digest, FIXTURE_SAMPLING_DIGESTS[`${name} ${saved.id} ${direction}`],
          `${label}: base rows and lifts moved`)
        console.log(`${label}: ${sync.result.moves.length} moves identical on both drivers; `
          + `${asyncSampling.tipRadius.length} base rows, lifts and warnings identical`)
      }
    }
  }
} else {
  console.log('rotarySamplingParity: p-a fixture parity skipped (set ROTARY_PARITY_FIXTURES=1 with work/ fixtures present)')
}

console.log('rotarySamplingParity.test.ts: all assertions passed')
