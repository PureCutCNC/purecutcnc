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
 * from the p-a worktree) to run it. It compares the two drivers' moves, warnings
 * and posted programs on both operations of both files.
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
  createRotarySamplingPrep,
  refineAroundSampling,
  refineAroundSamplingAsync,
  runRotaryAngleJob,
  sampleAnglesWithPrep,
  sampleRotaryModel,
  sampleRotaryModelAsync,
  serialRotaryBatches,
} from './rotarySampling'
import type { RotaryBatchFactory, RotaryModelMesh, RotarySampleOptions } from './rotarySampling'
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

if (process.env.ROTARY_PARITY_FIXTURES === '1') {
  const fixtures = ['busto-rect-stock.camj', 'busto-round-stock.camj']
  for (const name of fixtures) {
    const path = join(ROOT, 'work', name)
    if (!existsSync(path)) {
      assert.fail(`${path} is missing: copy the p-a work/ fixtures before running ROTARY_PARITY_FIXTURES=1`)
    }
    const project = normalizeProject(JSON.parse(readFileSync(path, 'utf8')))
    for (const operation of project.operations.filter((candidate) => candidate.kind === 'rotary_rough' || candidate.kind === 'rotary_finish')) {
      const label = `${name} ${operation.id}`
      console.log(`${label}: generating synchronously…`)
      const sync = computeOperationToolpath(project, operation)
      assert.ok(sync, `${label}: the synchronous entry generates`)
      console.log(`${label}: generating asynchronously…`)
      const asyncEnvelope = await computeOperationToolpathAsync(project, operation)
      assert.ok(asyncEnvelope, `${label}: the asynchronous entry generates`)
      assert.ok(sync.result.moves.length > 0, `${label}: emits motion`)
      assert.deepEqual(asyncEnvelope.result.moves, sync.result.moves, `${label}: moves`)
      assert.deepEqual(asyncEnvelope.result.warnings, sync.result.warnings, `${label}: warnings`)
      assert.equal(post(project, operation, asyncEnvelope.result), post(project, operation, sync.result),
        `${label}: posted program`)
      console.log(`${label}: ${sync.result.moves.length} moves identical on both drivers`)
    }
  }
} else {
  console.log('rotarySamplingParity: p-a fixture parity skipped (set ROTARY_PARITY_FIXTURES=1 with work/ fixtures present)')
}

console.log('rotarySamplingParity.test.ts: all assertions passed')
