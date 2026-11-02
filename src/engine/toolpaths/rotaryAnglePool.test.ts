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
 * The angle worker pool (#1115 slice p-d2).
 *
 * The slice's claim is narrow and has to be checked from both ends: the pool
 * changes *where* an angle is sampled, never *what* it computes, and it refuses
 * replies that cannot belong to the batch it is waiting for. So this file pins:
 *
 * - **the worker count** — the design's formula, its byte budget and its
 *   unknown-concurrency-is-serial rule as pure functions, so the ceiling is
 *   tested without allocating half a gigabyte;
 * - **identical output on real threads** — the shipped Node transport, the
 *   shipped worker adapter and the shipped kernel on round X/Y and square X/Y
 *   bars, around and along, compared row by row (and lift, and warning) against
 *   the in-process serial runner, then through the whole asynchronous driver and
 *   a real operation generation;
 * - **arrival order, duplicates and stale identity** — an in-process source
 *   answers in reverse, twice, with a poisoned stale-epoch reply, with a
 *   poisoned stale-batch reply, and with a computation error. Reverse and stale
 *   must produce the serial rows exactly; duplicates and a computation error
 *   must be refused rather than silently dropped;
 * - **retained walls** — a wall beside a floor is sampled through the pool with
 *   its `wallTriangleStart`, and the control that drops only that field must
 *   move row A0, or the check would pass on a fixture where the metadata does
 *   nothing;
 * - **thin peaks** — the 0.02 mm fin `thinFeatureHeightMap.test.ts` builds,
 *   sampled around the bar through the pool: the A0 row must still stand on the
 *   fin's 10 mm top, not on the base the cell centres miss;
 * - **failures** — a source that cannot start a worker, a worker that refuses
 *   its install, and a transport whose `post()` throws on a batch or a plan
 *   revision all fall back to serial and produce the serial rows, leaving no
 *   rejection for disposal to fire; a computation error stays an error;
 * - **the budget's arithmetic** — the per-worker charge must cover the *five*
 *   max-size arrays a retained-wall map set holds at once (the map, its coverage,
 *   the model-only map and the two peak-limit maps), and the eight-worker ceiling
 *   must survive a caller passing the machine's 32 cores.
 *
 * The mutations this file exists to catch are: assemble in arrival order; omit
 * the retained-wall metadata from what the worker is sent; accept a stale epoch;
 * drop the serial fallback; let a throwing send escape without settling its
 * batch; budget the maps without their peak-limit maps; let `maxWorkers` lift
 * the ceiling; and let the budget over-allocate workers.
 *
 * The p-a benchmark fixtures are 32 MB `.camj` files in the gitignored `work/`
 * and cost about 35 s of generation per operation, so the fixture parity run is
 * off by default: set `ROTARY_PARITY_FIXTURES=1` with
 * `work/busto-rect-stock.camj` and `work/busto-round-stock.camj` present to run
 * it. It compares the pool against the serial runner on each fixture's saved
 * operations, both the base batch's rows and the whole generated motion.
 *
 * Run with: npx tsx src/engine/toolpaths/rotaryAnglePool.test.ts
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { roundStock } from '../../types/project'
import type { BarStock, Operation, Project } from '../../types/project'
import { barCentre, barPivotZ, squareStock } from '../../types/barStock'
import { rotaryOperationFixture } from '../../test/rotaryOperationFixture'
import { normalizeProject } from '../../store/helpers/projectFormat'
import { createNodeRotaryAngleWorkerSource } from '../../app/toolpathGeneration/rotaryAngleNodeTransport'
import { computeOperationToolpath, computeOperationToolpathAsync } from './generateOperation'
import {
  assembleRotarySampling,
  createRotarySamplingPrep,
  runRotaryAngleJob,
  sampleRotaryModel,
  sampleRotaryModelAsync,
  serialRotaryBatches,
} from './rotarySampling'
import type {
  RotaryAngleJob,
  RotaryAngleSample,
  RotaryBatchFactory,
  RotaryModelMesh,
  RotarySampling,
  RotarySamplingPrep,
} from './rotarySampling'
import type { NormalizedTool } from './types'
import { createRotaryAngleKernel } from './rotaryAngleKernel'
import type { RotaryAngleKernel } from './rotaryAngleKernel'
import {
  ROTARY_ANGLE_PROTOCOL_VERSION,
  isRotaryAngleWorkerReply,
} from './rotaryAngleProtocol'
import type { RotaryAngleSetupPayload, RotaryAngleWorkerReply, RotaryAngleWorkerRequest } from './rotaryAngleProtocol'
import { MAX_HEIGHT_MAP_CELLS } from './finishSurfaceParallel'
import {
  MAX_ROTARY_ANGLE_WORKERS,
  ROTARY_ANGLE_POOL_BUDGET_BYTES,
  createRotaryAnglePool,
  estimateRotaryAngleWorkerBytes,
  planRotaryAnglePool,
} from './rotaryAnglePool'
import type { RotaryAnglePool, RotaryAngleWorkerPort, RotaryAngleWorkerSource } from './rotaryAnglePool'

const BALL: NormalizedTool = {
  id: 'ball-3', name: '3 mm ball nose', sourceUnits: 'mm', units: 'mm',
  type: 'ball_endmill', diameter: 3, radius: 1.5, vBitAngle: null,
  flutes: 2, material: 'carbide', defaultRpm: 0, defaultFeed: 0,
  defaultPlungeFeed: 0, defaultStepdown: 0, defaultStepover: 0, maxCutDepth: 0,
}

const HEX_RADIUS = 8
const HEX_SECTION = Array.from({ length: 6 }, (_, i): readonly [number, number] => {
  const t = Math.PI * i / 3
  return [HEX_RADIUS * Math.cos(t), HEX_RADIUS * Math.sin(t)]
})

const ANGLES = Array.from({ length: 24 }, (_, k) => k * 15)
const ALONG = [12, 14, 15.5, 17]

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

/** An axis-aligned box, in bar coordinates, appended to a growing mesh. */
function boxInto(
  stock: BarStock,
  positions: number[],
  index: number[],
  spec: { x0: number; x1: number; a0: number; a1: number; u0: number; u1: number },
): void {
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const base = positions.length / 3
  const corners: Array<[number, number, number]> = [
    [spec.x0, spec.a0, spec.u0], [spec.x1, spec.a0, spec.u0], [spec.x1, spec.a1, spec.u0], [spec.x0, spec.a1, spec.u0],
    [spec.x0, spec.a0, spec.u1], [spec.x1, spec.a0, spec.u1], [spec.x1, spec.a1, spec.u1], [spec.x0, spec.a1, spec.u1],
  ]
  for (const [x, a, u] of corners) positions.push(x, centre + a, pivot + u)
  for (const [a, b, c] of [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ]) index.push(base + a, base + b, base + c)
}

const STOCKS: Array<{ name: string; stock: BarStock }> = [
  { name: 'round X', stock: roundStock(40, 20, 'x', { x: 10, y: 7 }) },
  { name: 'round Y', stock: roundStock(40, 20, 'y', { x: 7, y: 10 }) },
  { name: 'square X', stock: squareStock(30, 20, 'x', { x: 10, y: 7 }) },
  { name: 'square Y', stock: squareStock(30, 20, 'y', { x: 7, y: 10 }) },
]

/** The same angles, rows, lifts and warnings, whatever produced them. */
function assertSamplesEqual(
  actual: readonly RotaryAngleSample[],
  expected: readonly RotaryAngleSample[],
  label: string,
): void {
  assert.equal(actual.length, expected.length, `${label}: result count`)
  for (let k = 0; k < expected.length; k++) {
    assert.equal(actual[k].index, expected[k].index, `${label}: result ${k} is out of order`)
    assert.equal(actual[k].lift, expected[k].lift, `${label}: result ${k} lift`)
    assert.deepEqual(actual[k].warnings, expected[k].warnings, `${label}: result ${k} warnings`)
    assert.deepEqual(actual[k].row, expected[k].row, `${label}: result ${k} row`)
  }
}

const pools: RotaryAnglePool[] = []

/** One pool per prep; `created()` is the pool the last factory built. */
function pooledFactory(
  source: RotaryAngleWorkerSource,
  poolOptions: { maxWorkers?: number; maxBufferBytes?: number } = {},
): { factory: RotaryBatchFactory; created: () => RotaryAnglePool | null } {
  let created: RotaryAnglePool | null = null
  return {
    factory: (prep) => {
      created = createRotaryAnglePool(prep, source, poolOptions)
      pools.push(created)
      return created.batches
    },
    created: () => created,
  }
}

function jobsFor(angles: readonly number[]): RotaryAngleJob[] {
  return angles.map((angle, index) => ({ index, angle }))
}

function shapeFor(
  angles: readonly number[],
  along: readonly number[],
  cellSize: number,
  around: boolean,
  wallTriangleStart?: number,
): {
  anglesDeg: readonly number[]
  along: readonly number[]
  requestedCellSize: number
  conservativeCellBounds?: boolean
  wallTriangleStart?: number
} {
  return {
    anglesDeg: angles,
    along,
    requestedCellSize: cellSize,
    ...(around ? { conservativeCellBounds: true } : {}),
    ...(wallTriangleStart !== undefined ? { wallTriangleStart } : {}),
  }
}

function prepFor(
  mesh: RotaryModelMesh,
  stock: BarStock,
  along: readonly number[],
  cellSize: number,
  around: boolean,
  wallTriangleStart?: number,
): RotarySamplingPrep {
  return createRotarySamplingPrep(mesh, stock, BALL, {
    along,
    requestedCellSize: cellSize,
    ...(around ? { conservativeCellBounds: true } : {}),
    ...(wallTriangleStart !== undefined ? { wallTriangleStart } : {}),
  })
}

// ── the worker count: the formula, the budget and the serial rules ─────────

{
  // A small charge, so the core limit is what these assertions read; the budget
  // has its own block below.
  const perWorker = 1024 * 1024
  const plan = planRotaryAnglePool

  const eight = plan({ angleCount: 720, availableParallelism: 20, perWorkerBytes: perWorker })
  assert.equal(eight.workers, MAX_ROTARY_ANGLE_WORKERS, `20 cores allow the design's eight workers (got ${eight.workers})`)
  assert.equal(eight.reason, 'parallel')
  assert.equal(eight.availableParallelism, 20, 'the machine answer is reported, not lost')

  assert.equal(plan({ angleCount: 720, availableParallelism: 4, perWorkerBytes: perWorker }).workers, 2,
    'four cores reserve two and leave two for the pool')
  assert.equal(plan({ angleCount: 720, availableParallelism: 3, perWorkerBytes: perWorker }).reason, 'serial-cores')
  assert.equal(plan({ angleCount: 3, availableParallelism: 20, perWorkerBytes: perWorker }).workers, 3,
    'a three-angle batch cannot use more than three workers')
  assert.equal(plan({ angleCount: 1, availableParallelism: 20, perWorkerBytes: perWorker }).reason, 'serial-one-angle')
  assert.equal(plan({ angleCount: 720, perWorkerBytes: perWorker }).reason, 'serial-unknown-concurrency')
  assert.equal(plan({ angleCount: 720, perWorkerBytes: perWorker }).workers, 1,
    'unknown concurrency runs serial rather than guessing')
  assert.equal(plan({ angleCount: 720, availableParallelism: 0, perWorkerBytes: perWorker }).workers, 1)

  // The 512 MiB budget is what keeps the design's eight workers from being an OOM
  // kill: the p-a bust's measured charge fits three or four, not eight.
  const bustCharge = 138 * 1024 * 1024
  const budgeted = plan({ angleCount: 720, availableParallelism: 20, perWorkerBytes: bustCharge })
  assert.equal(budgeted.budgetWorkers, Math.floor(ROTARY_ANGLE_POOL_BUDGET_BYTES / bustCharge))
  assert.equal(budgeted.workers, budgeted.budgetWorkers,
    `the budget caps the worker count (charge ${bustCharge}, workers ${budgeted.workers})`)
  assert.ok(budgeted.workers < MAX_ROTARY_ANGLE_WORKERS, 'the bust must not reach eight workers, or this pins nothing')
  assert.equal(
    plan({ angleCount: 720, availableParallelism: 20, perWorkerBytes: bustCharge * 10 }).reason,
    'serial-budget',
    'a charge that fills the budget in one worker runs serial',
  )
  // A caller may raise the ceiling or the budget, which the probe's uncapped
  // eight-worker run does.
  assert.equal(
    plan({ angleCount: 720, availableParallelism: 20, perWorkerBytes: bustCharge, maxBufferBytes: bustCharge * 8 }).workers,
    8,
    'a caller may raise the budget to reach the design ceiling',
  )
  assert.equal(plan({ angleCount: 720, availableParallelism: 20, perWorkerBytes: 1024, maxWorkers: 2 }).workers, 2)
  // The design's eight-worker ceiling is not a caller option: `maxWorkers` may
  // lower the count, never raise it. A 32-core machine that passes 32 used to
  // select 30 workers (32 - 2), a count the byte budget then has to pay for.
  const lifted = plan({ angleCount: 720, availableParallelism: 32, perWorkerBytes: 1024, maxWorkers: 32 })
  assert.equal(lifted.workers, MAX_ROTARY_ANGLE_WORKERS,
    `maxWorkers must not lift the design ceiling (32 cores asked for 32, got ${lifted.workers})`)
  assert.equal(
    plan({ angleCount: 720, availableParallelism: 32, perWorkerBytes: 1024, maxWorkers: 1_000_000 }).workers,
    MAX_ROTARY_ANGLE_WORKERS,
    'no override reaches past eight workers',
  )
  // One worker always has to fit: a budget that fits none is not a split.
  assert.equal(plan({ angleCount: 720, availableParallelism: 20, perWorkerBytes: ROTARY_ANGLE_POOL_BUDGET_BYTES * 2 }).workers, 1)

  const mesh = prism(STOCKS[0].stock, HEX_SECTION, [10, 30])
  const prep = prepFor(mesh, STOCKS[0].stock, ALONG, 0.2, true)
  const planValue = prep.planFor(ANGLES)
  const setup: RotaryAngleSetupPayload = {
    protocolVersion: ROTARY_ANGLE_PROTOCOL_VERSION,
    mode: 'around',
    stock: STOCKS[0].stock,
    tool: BALL,
    along: ALONG,
    requestedCellSize: 0.2,
    plan: {
      hull: planValue.hull, minAlong: planValue.minAlong, maxAlong: planValue.maxAlong,
      bucketStarts: planValue.bucketStarts, bucketTriangles: planValue.bucketTriangles,
      always: planValue.always, bucketWidth: planValue.bucketWidth,
    },
    raster: { section: new Float64Array(6), along: new Float32Array(3) },
  }
  const estimate = estimateRotaryAngleWorkerBytes(setup)
  // The charge includes a full height map, so it can never be smaller than the
  // cap the sampler allows: a budget built only from the setup bytes would.
  assert.ok(estimate >= MAX_HEIGHT_MAP_CELLS * (4 + 4), `the estimate must charge a height map (got ${estimate})`)

  // What one worker's maps actually hold, measured rather than assumed: the map,
  // its wall coverage, the model-only map, and the **two peak-limit maps** the
  // clip pass builds from them (#1050 slices B/C). `chooseHeightMapCellSize` caps
  // each at `MAX_HEIGHT_MAP_CELLS`, so with retained walls one worker holds five
  // max-size arrays at once -- 17,000,000 bytes -- not the 9,001,560 the three
  // named arrays cost when the peak maps are forgotten.
  const cells = MAX_HEIGHT_MAP_CELLS
  const mapBytes = new Float32Array(cells).byteLength
    + new Uint8Array(cells).byteLength
    + new Float32Array(cells).byteLength
    + new Float32Array(cells).byteLength
    + new Float32Array(cells).byteLength
  assert.equal(mapBytes, 17_000_000, 'the retained-wall map set is five max-size arrays')
  const withWalls = estimateRotaryAngleWorkerBytes({ ...setup, wallTriangleStart: 0 })
  assert.ok(withWalls >= mapBytes,
    `the charge must cover the ${mapBytes} bytes of maps a retained-wall worker holds at once (got ${withWalls})`)
  assert.equal(withWalls - estimate, MAX_HEIGHT_MAP_CELLS * (1 + 4 + 4),
    'marking retained walls charges the wall coverage, the model-only map and the second peak map')
  console.log(`worker plan: formula, budget and serial rules pinned (hex charge ${(estimate / 1048576).toFixed(2)} MB,`
    + ` with walls ${(withWalls / 1048576).toFixed(2)} MB)`)
}

// ── the pool on real worker threads: identical rows, X and Y, both modes ───

{
  const cases: Array<{ stock: BarStock; name: string; around: boolean }> = [
    { stock: STOCKS[0].stock, name: 'round X', around: true },
    { stock: STOCKS[1].stock, name: 'round Y', around: false },
    { stock: STOCKS[2].stock, name: 'square X', around: true },
    { stock: STOCKS[3].stock, name: 'square Y', around: false },
  ]
  const nodeSource = createNodeRotaryAngleWorkerSource({ availableParallelism: 4 })
  for (const { stock, name, around } of cases) {
    const mode = around ? 'around' : 'along'
    const mesh = prism(stock, HEX_SECTION, [10, 30])
    const shape = shapeFor(ANGLES, ALONG, 0.2, around)
    const jobs = jobsFor(ANGLES)
    const sync = sampleRotaryModel(mesh, stock, BALL, shape, [])
    const serial = await serialRotaryBatches(prepFor(mesh, stock, ALONG, 0.2, around))(jobs)
    const { factory, created } = pooledFactory(nodeSource, { maxWorkers: 2 })
    const pooled = await sampleRotaryModelAsync(mesh, stock, BALL, shape, [], factory)
    const pool = created()
    assert.ok(pool, `${name} ${mode}: the pool factory was used`)
    const stats = pool.stats()
    assert.equal(stats.mode, 'parallel', `${name} ${mode}: the workers ran`)
    assert.equal(stats.workers, 2, `${name} ${mode}: two workers (each starts a real thread)`)
    assert.equal(stats.fallback, 'none', `${name} ${mode}: no fallback`)
    assert.ok(stats.setupBytes > 0, `${name} ${mode}: the setup crossed the wire`)
    assert.equal(stats.batches, 1, `${name} ${mode}: the base grid is one batch`)
    // The pool's own answer, before the driver assembles it: same rows, same
    // order by job index.
    assertSamplesEqual(await pool.batches(jobs), serial, `${name} ${mode} pool batch`)
    // The whole asynchronous driver, assembled: rows, lifts and angles.
    assert.deepEqual(pooled.anglesDeg, sync.anglesDeg, `${name} ${mode}: angles`)
    assert.deepEqual(pooled.lifts, sync.lifts, `${name} ${mode}: lifts`)
    assert.equal(pooled.tipRadius.length, sync.tipRadius.length, `${name} ${mode}: row count`)
    for (let k = 0; k < sync.tipRadius.length; k++) {
      assert.deepEqual(pooled.tipRadius[k], sync.tipRadius[k], `${name} ${mode}: row ${k}`)
    }
    // Non-vacuity: the mesh is inside the bar, and around mode really lifts.
    assert.ok(sync.tipRadius.some((row) => Array.from(row).some((value) => Number.isFinite(value))),
      `${name} ${mode}: the fixture samples the model`)
    assert.equal(sync.lifts.some((lift) => lift > 0), around, `${name} ${mode}: the mode really sampled`)
    console.log(`${name} ${mode}: 2 real workers, ${stats.batches} batch, `
      + `${(stats.setupBytes / 1024).toFixed(1)} KB setup, ${stats.installMs} ms install, ${stats.awaitMs} ms await, identical rows`)
  }
}

// ── an in-process source, for orderings a real thread cannot be told to make ──

type FakeBehaviour =
  | 'in-order'
  | 'reverse'
  | 'duplicate'
  | 'stale-epoch'
  | 'stale-batch'
  | 'compute-error'
  | 'install-error'
  /** `post()` throws on a batch, like a `MessagePort` whose worker has gone. */
  | 'send-error'
  /** `post()` throws on a plan revision. */
  | 'plan-send-error'

function poisonedSamples(jobs: readonly RotaryAngleJob[], along: readonly number[]): RotaryAngleSample[] {
  return jobs.map((job) => ({
    index: job.index,
    row: new Float32Array(along.length).fill(123),
    lift: 0,
    warnings: [],
  }))
}

/** One fake worker: the real kernel and protocol, a scripted reply order. */
class FakePort implements RotaryAngleWorkerPort {
  private kernel: RotaryAngleKernel | null = null
  private replyHandler: ((reply: RotaryAngleWorkerReply) => void) | null = null
  private failureHandler: ((error: Error) => void) | null = null
  private terminated = false
  readonly served: string[] = []

  private readonly index: number
  private readonly behaviour: FakeBehaviour
  private readonly workerCount: number
  private readonly along: readonly number[]

  constructor(index: number, behaviour: FakeBehaviour, workerCount: number, along: readonly number[]) {
    this.index = index
    this.behaviour = behaviour
    this.workerCount = workerCount
    this.along = along
  }

  post(message: RotaryAngleWorkerRequest): void {
    if (this.terminated) return
    // A dead transport does not answer: `postMessage` on a closed `MessagePort`
    // (or a worker that has exited) throws. Modelling it as a reply would test a
    // failure the pool can never see.
    if (this.behaviour === 'send-error' && message.kind === 'batch') {
      throw new Error(`worker ${this.index} is gone`)
    }
    if (this.behaviour === 'plan-send-error' && message.kind === 'plan') {
      throw new Error(`worker ${this.index} is gone`)
    }
    // Asynchronously, like a thread: the pool must not depend on a reply landing
    // inside its own post call. The reverse behaviour answers the last worker
    // first, so the pool's completion order is the opposite of its job order.
    const delay = this.behaviour === 'reverse' ? (this.workerCount - this.index) * 2 : 0
    setTimeout(() => this.handle(message), delay)
  }

  private send(reply: RotaryAngleWorkerReply): void {
    assert.ok(isRotaryAngleWorkerReply(reply), 'the fake must send well-formed replies')
    this.replyHandler?.(reply)
  }

  private handle(message: RotaryAngleWorkerRequest): void {
    if (this.terminated) return
    switch (message.kind) {
      case 'install':
        this.served.push('install')
        if (this.behaviour === 'install-error') {
          this.send({ kind: 'error', epoch: message.epoch, batchId: -1, phase: 'install', message: 'no memory for a worker copy' })
          return
        }
        this.kernel = createRotaryAngleKernel(message.setup)
        this.send({ kind: 'installed', protocolVersion: ROTARY_ANGLE_PROTOCOL_VERSION })
        return
      case 'plan':
        this.served.push(`plan ${message.revision}`)
        this.kernel?.applyPlan(message.plan)
        this.send({ kind: 'planApplied', revision: message.revision })
        return
      case 'batch': {
        this.served.push(`batch ${message.batchId}`)
        if (this.kernel === null) {
          this.send({ kind: 'error', epoch: message.epoch, batchId: message.batchId, phase: 'compute', message: 'batch before setup' })
          return
        }
        if (this.behaviour === 'compute-error' && this.index === 0) {
          this.send({ kind: 'error', epoch: message.epoch, batchId: message.batchId, phase: 'compute', message: 'the sampler refused this angle' })
          return
        }
        const samples = this.kernel.run(message.jobs)
        if (this.behaviour === 'duplicate' && this.index === 0) {
          this.send({ kind: 'result', epoch: message.epoch, batchId: message.batchId, samples })
          this.send({ kind: 'result', epoch: message.epoch, batchId: message.batchId, samples })
          return
        }
        // A poisoned reply from a batch or an epoch that is not the one being
        // awaited: if the pool accepts it, its 123s reach the assembled rows.
        if (this.behaviour === 'stale-epoch' && this.index === 0) {
          this.send({
            kind: 'result',
            epoch: message.epoch - 1,
            batchId: message.batchId,
            samples: poisonedSamples(message.jobs, this.along),
          })
        }
        if (this.behaviour === 'stale-batch' && this.index === 0) {
          this.send({
            kind: 'result',
            epoch: message.epoch,
            batchId: message.batchId - 1,
            samples: poisonedSamples(message.jobs, this.along),
          })
        }
        this.send({ kind: 'result', epoch: message.epoch, batchId: message.batchId, samples })
        return
      }
      case 'dispose':
        this.terminated = true
        this.kernel = null
        return
      default:
        return
    }
  }

  onReply(handler: (reply: RotaryAngleWorkerReply) => void): void {
    this.replyHandler = handler
  }

  onFailure(handler: (error: Error) => void): void {
    this.failureHandler = handler
  }

  terminate(): void {
    this.terminated = true
  }

  /** Simulate a dead worker; the pool's fallback path is tested with it below. */
  fail(error: Error): void {
    this.failureHandler?.(error)
  }
}

/** A source whose workers are the real kernel with a scripted reply order. */
function fakeSource(
  behaviour: FakeBehaviour,
  workers: number,
  along: readonly number[] = ALONG,
  parallelism = 8,
): {
  source: RotaryAngleWorkerSource
  ports: FakePort[]
} {
  const ports: FakePort[] = []
  return {
    ports,
    source: {
      availableParallelism: parallelism,
      create(index: number) {
        const port = new FakePort(index, behaviour, workers, along)
        ports.push(port)
        return port
      },
    },
  }
}

// ── arrival order, duplicates and stale identity ───────────────────────────

{
  const stock = STOCKS[2].stock
  const mesh = prism(stock, HEX_SECTION, [10, 30])
  const jobs = jobsFor(ANGLES)
  const prep = prepFor(mesh, stock, ALONG, 0.2, true)
  const serial = await serialRotaryBatches(prep)(jobs)

  for (const behaviour of ['in-order', 'reverse', 'stale-epoch', 'stale-batch'] as const) {
    const fake = fakeSource(behaviour, 3)
    const pool = createRotaryAnglePool(prep, fake.source, { maxWorkers: 3 })
    const pooled = await pool.batches(jobs)
    assertSamplesEqual(pooled, serial, `${behaviour}: pool rows`)
    const stats = pool.stats()
    assert.equal(stats.workers, 3, `${behaviour}: three fake workers`)
    assert.equal(stats.fallback, 'none', `${behaviour}: no fallback`)
    if (behaviour === 'stale-epoch' || behaviour === 'stale-batch') {
      assert.ok(stats.rejectedReplies > 0,
        `${behaviour}: the poisoned reply must be dropped, not merged (rejected ${stats.rejectedReplies})`)
    } else {
      assert.equal(stats.rejectedReplies, 0, `${behaviour}: nothing to drop`)
    }
    console.log(`pool ordering: ${behaviour} produces the serial rows`
      + (stats.rejectedReplies > 0 ? ` (${stats.rejectedReplies} stale reply dropped)` : ''))
    await pool.dispose()
  }

  // A duplicate result is refused: two answers for one angle cannot both be true.
  {
    const fake = fakeSource('duplicate', 2)
    const pool = createRotaryAnglePool(prep, fake.source, { maxWorkers: 2 })
    await assert.rejects(
      () => pool.batches(jobs),
      (error: unknown) => error instanceof Error && /duplicate result|which it was not given/.test(error.message),
      'a duplicated result must be refused',
    )
    await pool.dispose()
    console.log('pool ordering: a duplicate result is refused')
  }

  // A computation error is an error, not a silent serial retry.
  {
    const fake = fakeSource('compute-error', 2)
    const pool = createRotaryAnglePool(prep, fake.source, { maxWorkers: 2 })
    await assert.rejects(
      () => pool.batches(jobs),
      (error: unknown) => error instanceof Error && /sampler refused this angle/.test(error.message),
      'a computation error must stay an error',
    )
    await pool.dispose()
    console.log('pool failures: a computation error stays an error')
  }

  // A worker that dies mid-batch is a resource failure: the batch is discarded
  // and rerun serially, and the rows are still the serial rows.
  {
    const fake = fakeSource('in-order', 2)
    const pool = createRotaryAnglePool(prep, fake.source, { maxWorkers: 2 })
    const promise = pool.batches(jobs)
    // Let the dispatch get in flight, then kill the first worker.
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 0))
    fake.ports[0].fail(new Error('worker was killed'))
    const rows = await promise
    assertSamplesEqual(rows, serial, 'a dead worker still produces the serial rows')
    await pool.dispose()
    console.log('pool failures: a dead worker falls back to serial')
  }

  // Disposal answers the batch it interrupts instead of leaving it pending: a
  // cancelled operation's caller must not wait forever for a result that cannot
  // come.
  {
    const fake = fakeSource('in-order', 2)
    const pool = createRotaryAnglePool(prep, fake.source, { maxWorkers: 2 })
    const promise = pool.batches(jobs)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 0))
    await pool.dispose()
    await assert.rejects(() => promise, /disposed/, 'disposing mid-batch rejects the pending batch')
    // And a batch submitted afterwards is refused rather than silently run.
    await assert.rejects(() => pool.batches(jobs), /disposed/, 'a disposed pool refuses new batches')
    console.log('pool failures: disposing mid-batch settles the batch instead of hanging')
  }
}

// ── a send that throws is a resource failure, not an error ─────────────────

{
  const stock = STOCKS[2].stock
  const mesh = prism(stock, HEX_SECTION, [10, 30])
  const jobs = jobsFor(ANGLES)
  const prep = prepFor(mesh, stock, ALONG, 0.2, true)
  const serial = await serialRotaryBatches(prep)(jobs)
  // A closed `MessagePort` reports itself by throwing from `post`, never with a
  // reply. If that escapes, the batch is rejected instead of rerun serially, and
  // the promise nobody awaited is left for disposal to reject as an unhandled
  // one -- which is a process-level failure under Node.
  const unhandled: unknown[] = []
  const collect = (reason: unknown): void => { unhandled.push(reason) }
  process.on('unhandledRejection', collect)
  try {
    const fake = fakeSource('send-error', 2)
    const pool = createRotaryAnglePool(prep, fake.source, { maxWorkers: 2 })
    assertSamplesEqual(await pool.batches(jobs), serial, 'a batch send that throws still produces the serial rows')
    const stats = pool.stats()
    assert.equal(stats.mode, 'serial', 'a throwing send moves the operation to serial')
    assert.equal(stats.fallback, 'startup', 'a throwing send is a resource failure')
    assert.equal(stats.workers, 0, 'the dead transport is not left installed')
    assert.equal(pool.stats().batches, 0, 'no batch reached the workers')
    // The serial mode is sticky, as for any other startup failure.
    assertSamplesEqual(await pool.batches(jobs), serial, 'the next batch stays serial')
    await pool.dispose()
    // The batch is settled, so disposal has nothing left to reject.
    await new Promise((settle) => setTimeout(settle, 10))
    assert.deepEqual(unhandled, [], 'a failed send must not leave a rejection for disposal to fire')
    console.log('pool failures: a batch send that throws falls back to serial and settles its batch')
  } finally {
    process.off('unhandledRejection', collect)
  }

  // The plan revision is sent the same way, so a dead transport fails it the
  // same way: the batch that needs the grown reach is discarded and rerun.
  {
    const planFor = prep.planFor.bind(prep)
    let asked = 0
    // A plan that grows on the second batch: `planFor` answers with a new object,
    // which is the pool's signal that the reach changed.
    const growing: RotarySamplingPrep = {
      ...prep,
      planFor(angles) {
        asked += 1
        const plan = planFor(angles)
        return asked === 1 ? plan : { ...plan }
      },
    }
    const fake = fakeSource('plan-send-error', 2)
    const pool = createRotaryAnglePool(growing, fake.source, { maxWorkers: 2 })
    assertSamplesEqual(await pool.batches(jobs), serial, 'the first batch still runs on the workers')
    assert.equal(pool.stats().mode, 'parallel', 'the first batch was pooled')
    assertSamplesEqual(await pool.batches(jobs), serial, 'a plan send that throws still produces the serial rows')
    const stats = pool.stats()
    assert.equal(stats.mode, 'serial', 'a throwing plan send moves the operation to serial')
    assert.equal(stats.fallback, 'startup', 'a throwing plan send is a resource failure')
    assert.equal(stats.planRevisions, 0, 'the revision never reached a worker')
    await pool.dispose()
    console.log('pool failures: a plan send that throws falls back to serial')
  }
}

// ── the eight-worker ceiling holds for the pool, not only the formula ──────

{
  const stock = STOCKS[2].stock
  const mesh = prism(stock, HEX_SECTION, [10, 30])
  const jobs = jobsFor(ANGLES)
  const prep = prepFor(mesh, stock, ALONG, 0.2, true)
  const serial = await serialRotaryBatches(prep)(jobs)
  // 32 cores and `maxWorkers: 32`: the reproduction selected 30 workers (32 - 2).
  // The pool may not create more than the design's eight, whatever the caller
  // passes and however many cores the machine has.
  const fake = fakeSource('in-order', 32, ALONG, 32)
  const pool = createRotaryAnglePool(prep, fake.source, { maxWorkers: 32 })
  const pooled = await pool.batches(jobs)
  assert.equal(fake.ports.length, MAX_ROTARY_ANGLE_WORKERS,
    `the pool may create at most ${MAX_ROTARY_ANGLE_WORKERS} workers (created ${fake.ports.length})`)
  assert.equal(pool.stats().workers, MAX_ROTARY_ANGLE_WORKERS, 'and reports what it created')
  assertSamplesEqual(pooled, serial, 'the clamped pool still produces the serial rows')
  await pool.dispose()
  console.log(`worker ceiling: 32 cores with maxWorkers: 32 still create ${fake.ports.length} workers`)
}

// ── startup failures fall back to serial and stay there ────────────────────

{
  const stock = STOCKS[0].stock
  const mesh = prism(stock, HEX_SECTION, [10, 30])
  const jobs = jobsFor(ANGLES)
  const prep = prepFor(mesh, stock, ALONG, 0.2, true)
  const serial = await serialRotaryBatches(prep)(jobs)

  // A runtime that cannot start a worker at all.
  let attempts = 0
  const cannotStart: RotaryAngleWorkerSource = {
    availableParallelism: 8,
    create() {
      attempts += 1
      throw new Error('worker_threads is unavailable')
    },
  }
  const pool = createRotaryAnglePool(prep, cannotStart, { maxWorkers: 2 })
  assertSamplesEqual(await pool.batches(jobs), serial, 'a worker that cannot start still produces the serial rows')
  assert.equal(attempts, 1, 'the pool tried to start a worker once')
  const stats = pool.stats()
  assert.equal(stats.mode, 'serial', 'the pool moved to serial')
  assert.equal(stats.fallback, 'startup', 'the fallback is reported')
  assert.equal(stats.workers, 0, 'no worker is left behind')
  // Every later batch stays serial: a pool that retried would try again here.
  await pool.batches(jobs)
  assert.equal(attempts, 1, 'the fallback is sticky: the next batch does not retry a failed transport')
  await pool.dispose()
  console.log('pool failures: a worker that cannot start falls back to serial and stays there')

  // A worker that accepts the thread but refuses the setup.
  const fake = fakeSource('install-error', 2)
  const refused = createRotaryAnglePool(prep, fake.source, { maxWorkers: 2 })
  assertSamplesEqual(await refused.batches(jobs), serial, 'a refused install still produces the serial rows')
  assert.equal(refused.stats().fallback, 'startup', 'a refused install is a startup failure')
  await refused.dispose()
  console.log('pool failures: a refused install falls back to serial')
}

// ── retained wall metadata, and the control that proves it matters ─────────

{
  const stock = roundStock(40, 20, 'x', { x: 0, y: 0 })
  const positions: number[] = []
  const index: number[] = []
  // A floor with its top at up 0, and a retained wall standing beside it with its
  // top at up 6. At A0 the wall's face is a full radius off the sample line, so
  // only a cell the padded footprint reaches but the unpadded one misses is
  // affected -- exactly the tangency #1095 slice D records the metadata for.
  boxInto(stock, positions, index, { x0: 0, x1: 20, a0: -4, a1: 4, u0: -2, u1: 0 })
  const wallTriangleStart = index.length / 3
  boxInto(stock, positions, index, { x0: 0, x1: 20, a0: 1.475, a1: 1.875, u0: -2, u1: 6 })
  const mesh: RotaryModelMesh = {
    positions: new Float32Array(positions),
    index: new Uint32Array(index),
    retainedTriangleStart: wallTriangleStart,
  }
  const wallAngles = [0, 45, 90, 135, 180, 225, 270, 315]
  const wallAlong = [8, 12, 16]
  const jobs = jobsFor(wallAngles)
  const prep = prepFor(mesh, stock, wallAlong, 0.05, true, wallTriangleStart)
  const serial = await serialRotaryBatches(prep)(jobs)
  const assembled = assembleRotarySampling(prep, jobs, serial.slice(), [], false)
  const { factory } = pooledFactory(createNodeRotaryAngleWorkerSource({ availableParallelism: 4 }), { maxWorkers: 2 })
  const pooled: RotarySampling = await sampleRotaryModelAsync(
    mesh, stock, BALL, shapeFor(wallAngles, wallAlong, 0.05, true, wallTriangleStart), [], factory)
  assert.deepEqual(pooled.tipRadius, assembled.tipRadius, 'the pool keeps the retained wall out of the sampled tip')
  assert.deepEqual(pooled.lifts, assembled.lifts, 'the wall fixture samples the same lifts through the pool')

  // The control: the same mesh and grid without the wall metadata must move the
  // A0 row, or this fixture proves nothing about the metadata crossing the wire.
  const withoutWall = prepFor(mesh, stock, wallAlong, 0.05, true)
  const noWallA0 = runRotaryAngleJob(withoutWall, withoutWall.planFor(wallAngles), { index: 0, angle: 0 })
  assert.notDeepEqual(serial[0].row, noWallA0.row,
    'the fixture must read differently without its wall metadata, or the retained-wall check is vacuous')
  assert.ok(Array.from(noWallA0.row).some((value) => value > 4),
    `without the metadata the tangent wall lifts the A0 row (${Array.from(noWallA0.row).join(', ')})`)
  console.log('retained wall: the wall metadata reaches the worker, and dropping it moves the A0 row')
}

// ── thin peaks survive the pool ────────────────────────────────────────────

{
  // The 0.02 mm fin `thinFeatureHeightMap.test.ts` builds: a base ending at up 0
  // and a fin 10 mm tall, thinner than a height-map cell.
  const stock = squareStock(30, 20, 'x')
  const positions: number[] = []
  const index: number[] = []
  boxInto(stock, positions, index, { x0: 0, x1: 20, a0: -5, a1: 5, u0: -5, u1: 0 })
  boxInto(stock, positions, index, { x0: 0, x1: 20, a0: -0.01, a1: 0.01, u0: 0, u1: 10 })
  const mesh: RotaryModelMesh = { positions: new Float32Array(positions), index: new Uint32Array(index) }
  const finAngles = [0, 90, 180, 270]
  const finAlong = [2, 6, 10, 14, 18]
  const jobs = jobsFor(finAngles)
  const prep = prepFor(mesh, stock, finAlong, 0.1, true)
  const serial = await serialRotaryBatches(prep)(jobs)
  const { factory } = pooledFactory(createNodeRotaryAngleWorkerSource({ availableParallelism: 4 }), { maxWorkers: 2 })
  const pooled = await sampleRotaryModelAsync(
    mesh, stock, BALL, shapeFor(finAngles, finAlong, 0.1, true), [], factory)
  assertSamplesEqual(await serialRotaryBatches(prep)(jobs), serial, 'thin fin: the serial control is deterministic')
  const a0 = pooled.tipRadius[0]
  // At A0 the fin stands on the sample line. Before #1050 the height map saw only
  // the base and the row read 0; through the pool it must still read its top.
  for (let i = 0; i < finAlong.length; i++) {
    assert.ok(Number.isFinite(a0[i]) && a0[i] >= 10 - 1e-3,
      `the A0 row must stand on the 10 mm fin at along ${finAlong[i]} (got ${a0[i]})`)
  }
  // The control: the same base without the fin reads the base's top, so the 10 mm
  // above is the fin and not the fixture.
  const basePositions: number[] = []
  const baseIndex: number[] = []
  boxInto(stock, basePositions, baseIndex, { x0: 0, x1: 20, a0: -5, a1: 5, u0: -5, u1: 0 })
  const baseMesh: RotaryModelMesh = { positions: new Float32Array(basePositions), index: new Uint32Array(baseIndex) }
  const basePrep = prepFor(baseMesh, stock, finAlong, 0.1, true)
  const baseA0 = runRotaryAngleJob(basePrep, basePrep.planFor(finAngles), { index: 0, angle: 0 })
  assert.ok(Array.from(baseA0.row).every((value) => value < 1),
    `without the fin the A0 row reads the base (${Array.from(baseA0.row).join(', ')})`)
  console.log('thin peaks: the A0 row through the pool stands on the 0.02 mm fin')
}

// ── the pool through a real operation generation ───────────────────────────

{
  const project: Project = rotaryOperationFixture('x', 'rotary_finish')
  const operation: Operation = { ...project.operations[0], rotaryPassDirection: 'around' }
  const sync = computeOperationToolpath(project, operation)
  assert.ok(sync, 'the synchronous entry generates the fixture')
  const { factory, created } = pooledFactory(createNodeRotaryAngleWorkerSource({ availableParallelism: 4 }), { maxWorkers: 2 })
  const pooled = await computeOperationToolpathAsync(project, operation, { rotaryRunBatch: factory })
  assert.ok(pooled, 'the asynchronous entry generates the fixture through the pool')
  assert.deepEqual(pooled.result.moves, sync.result.moves, 'the pool reaches the same motion')
  assert.deepEqual(pooled.result.warnings, sync.result.warnings, 'the pool reaches the same warnings')
  assert.deepEqual(pooled.result.bounds, sync.result.bounds, 'the pool reaches the same bounds')
  assert.ok(sync.result.moves.length > 0, 'the fixture emits motion, or the comparison is vacuous')
  const stats = created()?.stats()
  assert.ok(stats && stats.mode === 'parallel' && stats.batches >= 1,
    `the operation went through the pool (${stats?.batches ?? 0} batches)`)
  console.log(`operation generation: ${sync.result.moves.length} moves identical through ${stats?.batches ?? 0} pooled batch(es)`)
}

// ── the p-a benchmark fixtures, when asked for ─────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../../..')

if (process.env.ROTARY_PARITY_FIXTURES === '1') {
  for (const name of ['busto-rect-stock.camj', 'busto-round-stock.camj']) {
    const path = join(ROOT, 'work', name)
    if (!existsSync(path)) {
      assert.fail(`${path} is missing: copy the p-a work/ fixtures before running ROTARY_PARITY_FIXTURES=1`)
    }
    const project = normalizeProject(JSON.parse(readFileSync(path, 'utf8')))
    const operations = project.operations.filter(
      (candidate) => candidate.kind === 'rotary_rough' || candidate.kind === 'rotary_finish')
    for (const operation of operations) {
      const label = `${name} ${operation.id} ${operation.kind}`
      console.log(`${label}: generating synchronously…`)
      const sync = computeOperationToolpath(project, operation)
      assert.ok(sync, `${label}: the synchronous entry generates`)
      assert.ok(sync.result.moves.length > 0, `${label}: the synchronous entry emits motion`)

      const captured: {
        jobs: readonly RotaryAngleJob[]
        samples: readonly RotaryAngleSample[]
      }[] = []
      let serialPrep: RotarySamplingPrep | null = null
      const capture: RotaryBatchFactory = (prep) => {
        serialPrep ??= prep
        const pool = createRotaryAnglePool(
          prep, createNodeRotaryAngleWorkerSource({ availableParallelism: 4 }), { maxWorkers: 2 })
        pools.push(pool)
        const runner = pool.batches
        return async (jobs) => {
          const samples = await runner(jobs)
          captured.push({ jobs, samples: samples.map((sample) => ({ ...sample, row: sample.row.slice() })) })
          return samples
        }
      }
      console.log(`${label}: generating through the pool…`)
      const pooled = await computeOperationToolpathAsync(project, operation, { rotaryRunBatch: capture })
      assert.ok(pooled, `${label}: the asynchronous entry generates`)
      assert.deepEqual(pooled.result.moves, sync.result.moves, `${label}: moves`)
      assert.deepEqual(pooled.result.warnings, sync.result.warnings, `${label}: warnings`)
      const base = captured[0]
      assert.ok(base, `${label}: the pool dispatched a batch`)
      const capturedPrep = serialPrep as RotarySamplingPrep | null
      assert.ok(capturedPrep, `${label}: the operation's prep was captured`)
      const serial = await serialRotaryBatches(capturedPrep)(base.jobs)
      assertSamplesEqual(base.samples, serial, `${label}: base batch rows through the pool`)
      const stats = pools[pools.length - 1].stats()
      console.log(`${label}: ${sync.result.moves.length} moves identical through ${stats.workers} workers`
        + ` (${stats.batches} batches, ${stats.installMs} ms install, ${stats.awaitMs} ms await,`
        + ` ${(stats.setupBytes / 1048576).toFixed(1)} MB per worker)`)
    }
  }
} else {
  console.log('rotaryAnglePool: p-a fixture parity skipped (set ROTARY_PARITY_FIXTURES=1 with work/ fixtures present)')
}

for (const pool of pools) await pool.dispose()

console.log('rotaryAnglePool.test.ts: all assertions passed')
