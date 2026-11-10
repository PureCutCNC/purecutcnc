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
 * #1103 slice ca-i: maps a worker builds fill the **parent** cache.
 *
 * The bug this slice fixes is a cache that never filled. The around grid samples
 * its rows in worker threads, each worker's `RotarySamplingPrep` is rebuilt from
 * a payload with `angleMaps: 'off'`, and the helix that follows reads the
 * **parent** workspace's cache -- which stayed empty, so every helix row
 * rasterised a map the ring grid had already built and the band's
 * `MAX_HELIX_RASTER_WORK` was spent proving a band it then refused. The app and
 * the node path therefore disagreed on the same file.
 *
 * What this file pins, block by block:
 *
 * 1. **Parity with the serial path on real threads.** The ring grid and its
 *    refinement sample through the shipped Node transport and worker adapter;
 *    the parent cache must equal the cache the serial runner leaves (key for
 *    key, byte for byte), and the helix built on it must be the same path with
 *    the same number of reused rows. On a pool that dropped the returned maps
 *    the cache is empty and both comparisons fail.
 * 2. **Insertion is in job order.** With a byte budget small enough to fill and
 *    latch, a scripted source answers in reverse completion order; the cache
 *    contents must equal the serial cache, so an insert in arrival order (which
 *    keeps whichever worker finished first) fails.
 * 3. **A `read-write` hit is never dispatched.** A row the parent already holds
 *    is answered here with the serial job, so it reports `reused` and
 *    `rasterWork: 0`; sending it to a worker reports a raster and charges work
 *    the serial path does not, which is what the totals comparison catches.
 * 3b. **A physical angle repeated inside one batch reuses the batch's own map.**
 *    A0 and A360 are one turned surface, so serial rasterises once and answers
 *    the repeat from the map it just cached. The partition runs before dispatch,
 *    so a cache read alone would send both rows to workers -- two rasters, no
 *    reuse, and raster work the serial path never charges. The repeat is
 *    deferred until the batch's maps are inserted, then reported as the serial
 *    hit (or the serial rebuild, when the cache refused the map). The reported
 *    case is A0/A360; a two-pair batch and a reverse-completion run pin the job
 *    order the decision has to use.
 * 4. **An `'off'` prep transfers nothing.** No map on a sample, no cache
 *    created, no `emitAngleMaps` in the setup, `stats().maps === 0`.
 * 5. **A malformed map fails its batch** instead of entering the cache.
 * 6. **A real operation** -- the small rotary fixture forced `around` on a round
 *    bar, so the grid really is `'write'` -- generates identical moves through
 *    the pool, with a non-zero map transfer and the same helix share.
 *
 * Run with: npx tsx src/engine/toolpaths/rotaryAngleMapTransport.test.ts
 */

import assert from 'node:assert/strict'

import { roundStock } from '../../types/project'
import type { BarStock, Operation, Project } from '../../types/project'
import { barPivotZ } from '../../types/barStock'
import { rotaryOperationFixture } from '../../test/rotaryOperationFixture'
import { createNodeRotaryAngleWorkerSource } from '../../app/toolpathGeneration/rotaryAngleNodeTransport'
import { computeOperationToolpath, computeOperationToolpathAsync } from './generateOperation'
import {
  createRotarySamplingPrep,
  refineAroundSampling,
  refineAroundSamplingAsync,
  sampleAnglesWithPrep,
  sampleAnglesWithPrepAsync,
  serialRotaryBatches,
  storeRotaryAngleBatchMaps,
} from './rotarySampling'
import type {
  RotaryAngleJob,
  RotaryAngleSample,
  RotaryModelMesh,
  RotarySamplingPrep,
  RotarySamplingWorkspace,
} from './rotarySampling'
import type { NormalizedTool } from './types'
import { createRotaryAngleKernel } from './rotaryAngleKernel'
import type { RotaryAngleKernel } from './rotaryAngleKernel'
import { buildContinuousHelix } from './rotaryContinuous'
import type { ContinuousHelix } from './rotaryContinuous'
import {
  ROTARY_ANGLE_PROTOCOL_VERSION,
  buildRotaryAngleSetup,
  isRotaryAngleWorkerReply,
} from './rotaryAngleProtocol'
import type { RotaryAngleWorkerReply, RotaryAngleWorkerRequest } from './rotaryAngleProtocol'
import { createRotaryAnglePool } from './rotaryAnglePool'
import type { RotaryAnglePool, RotaryAngleWorkerPort, RotaryAngleWorkerSource } from './rotaryAnglePool'

const TOOL: NormalizedTool = {
  id: 't1', name: 't1', sourceUnits: 'mm', units: 'mm', type: 'ball_endmill',
  diameter: 2, radius: 1, vBitAngle: null, flutes: 2, material: 'carbide',
  defaultRpm: 0, defaultFeed: 0, defaultPlungeFeed: 0, defaultStepdown: 0,
  defaultStepover: 0, maxCutDepth: 0,
}

/** A turned cylinder of `radius` from `from` to `to`, 64 facets (the ca-e fixture). */
function lathe(stock: BarStock, radius: number, from: number, to: number): RotaryModelMesh {
  const centre = stock.thickness / 2
  const pivot = barPivotZ(stock)
  const positions: number[] = []
  const index: number[] = []
  for (const along of [from, to]) {
    for (let j = 0; j < 64; j++) {
      const t = 2 * Math.PI * j / 64
      positions.push(along, centre + radius * Math.cos(t), pivot + radius * Math.sin(t))
    }
  }
  for (let j = 0; j < 64; j++) {
    const next = (j + 1) % 64
    index.push(j, next, 64 + next, j, 64 + next, 64 + j)
  }
  return { positions: new Float32Array(positions), index: new Uint32Array(index) }
}

const STOCK = roundStock(20, 40, 'x')
const MESH = lathe(STOCK, 6, 12, 28)
const BAND = { start: 12, end: 28 }
const CELL = 0.1
const ALONG = Array.from({ length: 9 }, (_, i) => BAND.start + (BAND.end - BAND.start) * i / 8)

/** The ring grid's angle list, built the way `aroundGrid` builds it. */
function ringAngles(sampleSpacing: number): number[] {
  const radius = STOCK.thickness / 2
  const cap = Math.sqrt(8 * radius * 0.005)
  const step = Math.min(sampleSpacing, cap)
  const intervals = Math.ceil((2 * Math.PI * radius) / Math.max(step, 1e-9))
  return Array.from({ length: intervals + 1 }, (_, k) => 360 * k / intervals)
}

function prepFor(
  workspace: RotarySamplingWorkspace,
  mode: 'off' | 'write' | 'read-write',
  along: readonly number[] = ALONG,
): RotarySamplingPrep {
  return createRotarySamplingPrep(MESH, STOCK, TOOL, {
    along,
    requestedCellSize: CELL,
    conservativeCellBounds: true,
    angleMaps: mode,
    workspace,
  })
}

function jobsFor(angles: readonly number[]): RotaryAngleJob[] {
  return angles.map((angle, index) => ({ index, angle }))
}

const pools: RotaryAnglePool[] = []

/** One pool on real worker threads; `workers` decides the count exactly. */
function nodePool(prep: RotarySamplingPrep, workers: number): RotaryAnglePool {
  const pool = createRotaryAnglePool(
    prep,
    createNodeRotaryAngleWorkerSource({ availableParallelism: workers + 2 }),
    { maxWorkers: workers },
  )
  pools.push(pool)
  return pool
}

/** The cache's keys, ascending, and each map's bytes -- what "the same cache" means. */
function cacheShape(workspace: RotarySamplingWorkspace): { keys: number[]; bytes: number } {
  const cache = workspace.angleMaps
  if (cache === undefined) return { keys: [], bytes: 0 }
  return { keys: [...cache.maps.keys()].sort((a, b) => a - b), bytes: cache.bytes }
}

/** Every stored map equal, cell for cell, between two caches. */
function assertCachesEqual(
  actual: RotarySamplingWorkspace,
  expected: RotarySamplingWorkspace,
  label: string,
): void {
  const shape = cacheShape(actual)
  assert.deepEqual(shape, cacheShape(expected), `${label}: the same keys and byte total`)
  for (const [key, expectedMap] of expected.angleMaps?.maps ?? []) {
    const actualMap = actual.angleMaps?.maps.get(key)
    assert.ok(actualMap !== undefined, `${label}: key ${key} is cached`)
    assert.equal(actualMap.width, expectedMap.width, `${label}: key ${key} width`)
    assert.equal(actualMap.height, expectedMap.height, `${label}: key ${key} height`)
    assert.equal(actualMap.originX, expectedMap.originX, `${label}: key ${key} origin X`)
    assert.equal(actualMap.originY, expectedMap.originY, `${label}: key ${key} origin Y`)
    assert.equal(actualMap.cellSize, expectedMap.cellSize, `${label}: key ${key} cell size`)
    assert.equal(actualMap.cellRise, expectedMap.cellRise, `${label}: key ${key} cell rise`)
    assert.deepEqual(actualMap.data, expectedMap.data, `${label}: key ${key} cells`)
    assert.deepEqual(actualMap.wallCoverage, expectedMap.wallCoverage, `${label}: key ${key} coverage`)
    assert.deepEqual(actualMap.modelOnly, expectedMap.modelOnly, `${label}: key ${key} model-only cells`)
  }
}

/** One helix's points, compared exactly: the same cache must give the same path. */
function assertHelixIdentical(actual: ContinuousHelix, expected: ContinuousHelix, label: string): void {
  assert.equal(actual.points.length, expected.points.length, `${label}: point count`)
  for (let i = 0; i < actual.points.length; i++) {
    for (const axis of ['x', 'y', 'z', 'a'] as const) {
      assert.equal(actual.points[i][axis], expected.points[i][axis], `${label}: point ${i} ${axis}`)
    }
  }
}

// ── a scripted in-process source: the real kernel, a chosen completion order ──

/**
 * One fake worker: the shipped kernel and protocol, a scripted reply order.
 *
 * `latePort` answers last rather than first, which makes the pool's arrival
 * order the opposite of its assignment order -- the condition a completion-order
 * insert would keep. `mangleMaps` corrupts the first returned map, for the
 * validator block.
 */
class ScriptedPort implements RotaryAngleWorkerPort {
  private kernel: RotaryAngleKernel | null = null
  private replyHandler: ((reply: RotaryAngleWorkerReply) => void) | null = null
  private terminated = false
  readonly served: string[] = []
  private readonly index: number
  private readonly portCount: number
  private readonly reverse: boolean
  private readonly mangleMaps: boolean

  constructor(index: number, portCount: number, reverse: boolean, mangleMaps: boolean) {
    this.index = index
    this.portCount = portCount
    this.reverse = reverse
    this.mangleMaps = mangleMaps
  }

  post(message: RotaryAngleWorkerRequest): void {
    if (this.terminated) return
    const delay = this.reverse ? (this.portCount - this.index) * 3 : 0
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
        let samples = this.kernel.run(message.jobs)
        if (this.mangleMaps && this.index === 0) {
          samples = samples.map((sample, position) => (position === 0 && sample.map !== undefined
            ? { ...sample, map: { ...sample.map, bytes: Number.NaN } }
            : sample))
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

  /** This fake never reports a failure: the failure paths are the pool suite's. */
  onFailure(): void {}

  terminate(): void {
    this.terminated = true
  }
}

function scriptedSource(
  workers: number,
  options: { reverse?: boolean; mangleMaps?: boolean } = {},
): { source: RotaryAngleWorkerSource; ports: ScriptedPort[] } {
  const ports: ScriptedPort[] = []
  return {
    ports,
    source: {
      availableParallelism: workers + 2,
      create: (index: number) => {
        const port = new ScriptedPort(index, workers, options.reverse === true, options.mangleMaps === true)
        ports.push(port)
        return port
      },
    },
  }
}

// ── block 1: real threads fill the parent cache, and the helix reads it ─────

{
  const angles = ringAngles(1)
  const pooledWorkspace: RotarySamplingWorkspace = {}
  const serialWorkspace: RotarySamplingWorkspace = {}
  const pooledPrep = prepFor(pooledWorkspace, 'write')
  const serialPrep = prepFor(serialWorkspace, 'write')

  // The pooled run: the base grid and every refinement round through the pool,
  // exactly as the generator drives them (`rotaryTargetsAsync`).
  const pool = nodePool(pooledPrep, 2)
  const pooled = await sampleAnglesWithPrepAsync(pooledPrep, angles, [], {}, pool.batches)
  assert.ok(pooled.valid, 'the pooled grid samples')
  const pooledRefined = await refineAroundSamplingAsync({
    prep: pooledPrep,
    stock: STOCK,
    tool: TOOL,
    warnings: [],
    angles: pooled.anglesDeg,
    tips: pooled.tipRadius,
  }, pool.batches)
  assert.ok(pooledRefined !== null, 'the pooled refinement samples')
  const stats = pool.stats()
  assert.equal(stats.mode, 'parallel', 'the grid really ran on workers, or this proves nothing')
  assert.equal(stats.workers, 2, 'two real worker threads')

  // The serial control, the same calls with the in-process runner.
  const serial = sampleAnglesWithPrep(serialPrep, angles, [])
  assert.ok(serial.valid, 'the serial grid samples')
  const serialRefined = refineAroundSampling({
    prep: serialPrep,
    stock: STOCK,
    tool: TOOL,
    warnings: [],
    angles: serial.anglesDeg,
    tips: serial.tipRadius,
  })
  assert.ok(serialRefined !== null, 'the serial refinement samples')

  // The rows are the serial rows -- the maps only change what a row costs.
  assert.deepEqual(Array.from(pooled.anglesDeg), Array.from(serial.anglesDeg), 'the same base angles')
  for (let k = 0; k < serial.tipRadius.length; k++) {
    assert.deepEqual(Array.from(pooled.tipRadius[k]), Array.from(serial.tipRadius[k]), `base row ${k}`)
  }
  assert.deepEqual(pooledRefined.angles, serialRefined.angles, 'the same refined angles')

  // The cache is the point: it must hold exactly what the serial runner holds.
  assert.ok(pooledWorkspace.angleMaps !== undefined, 'the pooled grid created the parent cache')
  assert.ok((pooledWorkspace.angleMaps?.maps.size ?? 0) > 100,
    `the workers' maps reached the parent cache (${pooledWorkspace.angleMaps?.maps.size ?? 0} entries)`)
  assertCachesEqual(pooledWorkspace, serialWorkspace, 'pool versus serial cache')
  assert.ok(stats.maps > 0, 'the pool reports the maps its workers returned')
  assert.ok(stats.mapBytes > 0, 'the pool reports the bytes those maps carried')
  assert.ok(stats.mapBytes >= (pooledWorkspace.angleMaps?.bytes ?? 0),
    'the transfer covers everything that was cached')

  // And it is the cache the helix's read-write rows need: every helix row is a
  // read, on either workspace, and both build the same path.
  const pooledHelix = buildContinuousHelix({
    prep: pooledPrep, tool: TOOL, band: BAND, stepover: 2, sampleSpacing: 1, stockToLeave: 0, warnings: [],
  })
  const serialHelix = buildContinuousHelix({
    prep: serialPrep, tool: TOOL, band: BAND, stepover: 2, sampleSpacing: 1, stockToLeave: 0, warnings: [],
  })
  assert.ok(pooledHelix !== null && serialHelix !== null, 'the band is helix-applicable on both workspaces')
  assert.ok(pooledHelix.reusedRows >= pooledHelix.rows - 1,
    `the helix reads the workers' maps (${pooledHelix.reusedRows} of ${pooledHelix.rows} rows)`)
  assert.equal(pooledHelix.reusedRows, serialHelix.reusedRows, 'the same reuse the serial path gets')
  assert.equal(pooledHelix.rasterWork, serialHelix.rasterWork, 'the same raster work charged')
  assertHelixIdentical(pooledHelix, serialHelix, 'pooled versus serial helix')
  console.log(`  cache parity: ${pooledWorkspace.angleMaps?.maps.size} maps, ${stats.mapBytes} map bytes`
    + ` transferred, helix ${pooledHelix.reusedRows}/${pooledHelix.rows} rows reused, path identical`)
}

// ── block 2: insertion is in job order, not completion order ───────────────

{
  const angles = ringAngles(1)
  // One map's cost, measured: the budget below is a few of them, so the cache
  // fills and latches -- which is what makes insertion order observable.
  const probeWorkspace: RotarySamplingWorkspace = {}
  sampleAnglesWithPrep(prepFor(probeWorkspace, 'write'), angles, [])
  const probeCache = probeWorkspace.angleMaps
  assert.ok(probeCache !== undefined && probeCache.maps.size > 1, 'the probe filled the cache')
  const perMap = probeCache.bytes / probeCache.maps.size
  const budget = Math.ceil(perMap * 3)
  const tinyCache = (): RotarySamplingWorkspace => ({
    angleMaps: { maps: new Map(), bytes: 0, budgetBytes: budget, full: false },
  })

  const serialWorkspace = tinyCache()
  sampleAnglesWithPrep(prepFor(serialWorkspace, 'write'), angles, [])
  const serialShape = cacheShape(serialWorkspace)
  assert.ok(serialShape.keys.length > 0, 'the serial cache keeps some maps')
  assert.ok(serialShape.keys.length < angles.length, 'the budget is small enough that it must refuse some')
  assert.equal(serialWorkspace.angleMaps?.full, true, 'the serial cache latched full')

  for (const reverse of [false, true]) {
    const workspace = tinyCache()
    const prep = prepFor(workspace, 'write')
    const scripted = scriptedSource(3, { reverse })
    const pool = createRotaryAnglePool(prep, scripted.source, { maxWorkers: 3 })
    pools.push(pool)
    const sampled = await sampleAnglesWithPrepAsync(prep, angles, [], {}, pool.batches)
    assert.ok(sampled.valid, `the ${reverse ? 'reverse' : 'forward'} batch samples`)
    assert.deepEqual(cacheShape(workspace), serialShape,
      `a ${reverse ? 'reverse' : 'forward'}-completion batch caches exactly what the serial one does`)
    assert.equal(workspace.angleMaps?.full, true, 'the pool latched the cache full too')
    assert.ok(pool.stats().maps > 0, 'the scripted workers returned maps')
  }
  console.log(`  job-order insertion: ${serialShape.keys.length} maps kept of ${angles.length},`
    + ` ${serialShape.bytes} bytes, reverse completion identical`)
}

// ── block 3: a read-write hit stays in this realm and costs nothing ─────────

{
  const angles = ringAngles(1).slice(0, 12)
  const workspace: RotarySamplingWorkspace = {}
  sampleAnglesWithPrep(prepFor(workspace, 'write'), angles, [])
  assert.equal(workspace.angleMaps?.maps.size, angles.length,
    'the write pass cached one map per physical angle')

  const prep = prepFor(workspace, 'read-write')
  const scripted = scriptedSource(2)
  const pool = createRotaryAnglePool(prep, scripted.source, { maxWorkers: 2 })
  pools.push(pool)
  const pooled = await sampleAnglesWithPrepAsync(prep, angles, [], {}, pool.batches)
  const serial = sampleAnglesWithPrep(prepFor(workspace, 'read-write'), angles, [])
  assert.ok(pooled.valid && serial.valid, 'both read-write batches sample')
  assert.equal(pooled.reused, serial.reused, 'the same reused count as the serial path')
  assert.equal(pooled.rasterWork, serial.rasterWork, 'the same raster work as the serial path')
  assert.equal(pooled.reused, angles.length, 'every row is served from a cached map')
  assert.equal(pooled.rasterWork, 0, 'a hit charges no raster work')
  const stats = pool.stats()
  assert.equal(stats.batches, 0, 'a cached row is never sent to a worker')
  assert.equal(stats.mode, 'serial', 'nothing was installed, because nothing had to be sampled')
  assert.ok(scripted.ports.every((port) => port.served.length === 0), 'no worker saw a message')
  for (let k = 0; k < serial.tipRadius.length; k++) {
    assert.deepEqual(Array.from(pooled.tipRadius[k]), Array.from(serial.tipRadius[k]), `row ${k}`)
  }
  console.log(`  read-write hits: ${pooled.reused}/${angles.length} rows served here,`
    + ` 0 raster work, no worker contacted`)
}

// ── block 3b: a repeat of one physical angle reuses the batch's own map ────

{
  const cases = [
    // The reported case, literally: an empty read-write cache and A0/A360. On an
    // unfixed partition both rows are dispatched, so the pool reports two rasters
    // and no reuse where serial reports one of each. After the fix the batch has
    // one row to sample, which is below the pool's two-angle floor, so it runs
    // serial -- still the serial accounting, which is the requirement.
    { angles: [0, 360], repeats: 1, label: 'A0/A360' },
    // Two repeats in one batch, so the pool really runs on two workers and the
    // deferred rows still have to report the serial hit at their own positions.
    { angles: [0, 45, 360, 405], repeats: 2, label: 'two repeated angles, one batch' },
  ] as const

  for (const { angles, repeats, label } of cases) {
    const pooledWorkspace: RotarySamplingWorkspace = {}
    const serialWorkspace: RotarySamplingWorkspace = {}
    const pooledPrep = prepFor(pooledWorkspace, 'read-write')
    const serialPrep = prepFor(serialWorkspace, 'read-write')
    const jobs = jobsFor(angles)
    // The serial control, sample by sample: the repeat's `reused`/`rasterWork`
    // are what the pool has to reproduce, not just the batch totals.
    const serial = await serialRotaryBatches(serialPrep)(jobs)

    const captured: { jobs: readonly RotaryAngleJob[]; samples: readonly RotaryAngleSample[] }[] = []
    const pool = nodePool(pooledPrep, 2)
    const runner = pool.batches
    const capture: typeof runner = async (batchJobs) => {
      const samples = await runner(batchJobs)
      // The driver's assembly adds each row's lift in place, so keep the raw row
      // to compare against the serial runner's raw row.
      captured.push({ jobs: batchJobs, samples: samples.map((sample) => ({ ...sample, row: sample.row.slice() })) })
      return samples
    }
    const pooled = await sampleAnglesWithPrepAsync(pooledPrep, angles, [], {}, capture)

    assert.ok(pooled.valid, `${label}: the pooled batch samples`)
    assert.equal(serial.length, jobs.length, `${label}: every serial job answered`)
    assert.equal(serial.filter((sample) => sample.reused).length, repeats,
      `${label}: the serial control reuses ${repeats} row(s), or this proves nothing`)
    assert.equal(pooled.reused, repeats,
      `${label}: the pool reuses the repeated angle's map (${pooled.reused} of ${angles.length} rows)`)
    assert.equal(pooled.rasterWork, serial.reduce((sum, sample) => sum + (sample.rasterWork ?? 0), 0),
      `${label}: the pool charges the serial raster work (${pooled.rasterWork})`)

    const base = captured[0]
    assert.ok(base, `${label}: the pool dispatched a batch`)
    assert.equal(base.samples.length, jobs.length, `${label}: every pooled job answered`)
    for (let k = 0; k < jobs.length; k++) {
      const pooledSample = base.samples[k]
      assert.equal(pooledSample.index, jobs[k].index, `${label}: result ${k} is in job order`)
      assert.equal(pooledSample.reused, serial[k].reused, `${label}: job ${k} reuse flag`)
      assert.equal(pooledSample.rasterWork, serial[k].rasterWork, `${label}: job ${k} raster work`)
      assert.deepEqual(pooledSample.row, serial[k].row, `${label}: job ${k} row`)
    }
    // The repeat costs no raster: exactly the serial symptom's shape.
    for (let k = 0; k < jobs.length; k++) {
      if (serial[k].reused) {
        assert.equal(base.samples[k].rasterWork, 0, `${label}: the repeated row ${k} rasterises nothing`)
      }
    }
    // The cache the batch built is the serial cache: the repeat did not insert a
    // second entry, and the maps the workers returned are the serial maps.
    assertCachesEqual(pooledWorkspace, serialWorkspace, `${label}: pool versus serial cache`)
    if (angles.length > 2) {
      const stats = pool.stats()
      assert.equal(stats.mode, 'parallel', `${label}: the repeat still ran on workers`)
      assert.equal(stats.workers, 2, `${label}: two real worker threads`)
      assert.equal(stats.maps, angles.length - repeats,
        `${label}: only the distinct angles' maps crossed the wire (${stats.maps})`)
    }
    console.log(`  repeated angle ${label}: ${pooled.reused}/${angles.length} rows reused,`
      + ` ${pooled.rasterWork} raster work, same cache as serial`)
  }

  // Completion order must not decide which row owns the map. With the second
  // worker answering first, the batch still reuses the earliest job's map in
  // **job order**; a partition or an insertion that followed arrival would
  // either rasterise the repeat or cache the later job's map under its key.
  {
    const angles = [0, 45, 360, 405]
    const workspace: RotarySamplingWorkspace = {}
    const prep = prepFor(workspace, 'read-write')
    const scripted = scriptedSource(2, { reverse: true })
    const pool = createRotaryAnglePool(prep, scripted.source, { maxWorkers: 2 })
    pools.push(pool)
    const pooled = await sampleAnglesWithPrepAsync(prep, angles, [], {}, pool.batches)
    const serialWorkspace: RotarySamplingWorkspace = {}
    const serial = sampleAnglesWithPrep(prepFor(serialWorkspace, 'read-write'), angles, [])
    assert.equal(pooled.reused, serial.reused, 'reverse completion: the same reuse as serial')
    assert.equal(pooled.rasterWork, serial.rasterWork, 'reverse completion: the same raster work as serial')
    assert.equal(pooled.reused, 2, 'reverse completion: both repeats are still hits')
    assertCachesEqual(workspace, serialWorkspace, 'reverse completion: the serial cache')
    assert.ok(pool.stats().maps > 0, 'reverse completion: the distinct angles crossed the wire')
    console.log(`  repeated angle, reverse completion: ${pooled.reused}/4 rows reused,`
      + ` ${pooled.rasterWork} raster work`)
  }
  // The deferred row is a real cache read, not an assumption of reuse: with a
  // cache that cannot hold a map, serial rebuilds the repeat and charges for it,
  // and the pool must do the same rather than reporting a hit it does not have.
  {
    const angles = [0, 45, 360, 405]
    const zeroBudget = (): RotarySamplingWorkspace => ({
      angleMaps: { maps: new Map(), bytes: 0, budgetBytes: 0, full: false },
    })
    const workspace = zeroBudget()
    const prep = prepFor(workspace, 'read-write')
    const pool = nodePool(prep, 2)
    const pooled = await sampleAnglesWithPrepAsync(prep, angles, [], {}, pool.batches)
    const serialWorkspace = zeroBudget()
    const serial = sampleAnglesWithPrep(prepFor(serialWorkspace, 'read-write'), angles, [])
    assert.equal(serial.reused, 0, 'the control: a cache that cannot hold a map reuses nothing')
    assert.equal(pooled.reused, 0, 'the pool reports the rebuild, not a hit it does not have')
    assert.equal(pooled.rasterWork, serial.rasterWork, 'the rebuild is charged exactly as serial charges it')
    assert.equal(workspace.angleMaps?.full, true, 'the pool latched the cache full as serial did')
    assertCachesEqual(workspace, serialWorkspace, 'zero-budget cache: pool versus serial')
    assert.equal(pool.stats().mode, 'parallel', 'the repeats were still dispatched and then rebuilt here')
    console.log(`  repeated angle, no cache room: 0/4 rows reused, ${pooled.rasterWork} raster work`
      + ' -- the same rebuild as serial')
  }
}

// ── block 4: an 'off' prep never moves a map ───────────────────────────────

{
  const workspace: RotarySamplingWorkspace = {}
  const prep = prepFor(workspace, 'off')
  const angles = ringAngles(1).slice(0, 8)
  const jobs = jobsFor(angles)
  // The setup the pool would install must not ask for maps at all.
  assert.equal(buildRotaryAngleSetup(prep, prep.planFor(angles)).emitAngleMaps, undefined,
    "an 'off' prep's setup carries no emit flag")
  const pool = nodePool(prep, 2)
  const samples = await pool.batches(jobs)
  assert.equal(samples.length, jobs.length, 'every job answered')
  assert.ok(samples.every((sample: RotaryAngleSample) => sample.map === undefined),
    "no 'off' sample carries a map")
  assert.equal(workspace.angleMaps, undefined, "an 'off' prep's workspace gets no cache")
  assert.equal(pool.stats().maps, 0, 'nothing was transferred')
  assert.equal(pool.stats().mapBytes, 0, 'no bytes were transferred')
  // The cache helper refuses maps even when a sample somehow carries one, so a
  // stray emit cannot fill a cache the prep never opted into.
  storeRotaryAngleBatchMaps(prep, [{
    index: 0,
    row: new Float32Array(1),
    lift: 0,
    warnings: [],
    map: {
      key: 0,
      bytes: 4,
      map: { data: new Float32Array(1), width: 1, height: 1, originX: 0, originY: 0, cellSize: 1 },
    },
  }])
  assert.equal(workspace.angleMaps, undefined, 'a forced sample cannot create the cache either')
  console.log("  'off' prep: no map on any sample, no cache, 0 bytes transferred")
}

// ── block 5: a malformed map fails its batch instead of being cached ────────

{
  const workspace: RotarySamplingWorkspace = {}
  const prep = prepFor(workspace, 'write')
  const angles = ringAngles(1).slice(0, 4)
  const scripted = scriptedSource(2, { mangleMaps: true })
  const pool = createRotaryAnglePool(prep, scripted.source, { maxWorkers: 2 })
  pools.push(pool)
  await assert.rejects(
    () => pool.batches(jobsFor(angles)),
    /malformed angle map/,
    'a map that cannot be cached is refused, not inserted',
  )
  console.log('  malformed map: the batch is refused')
}

// ── block 6: a real operation reaches the same motion with the maps on ──────

/** Cut moves that turn and advance at once, over all cut moves: the helix share. */
function helixShare(moves: readonly { kind: string; from: { x: number; y: number; a?: number }; to: { x: number; y: number; a?: number } }[], axis: 'x' | 'y'): number {
  let cuts = 0
  let helix = 0
  for (const move of moves) {
    if (move.kind !== 'cut') continue
    cuts += 1
    const along = axis === 'x' ? move.to.x - move.from.x : move.to.y - move.from.y
    const turn = (move.to.a ?? 0) - (move.from.a ?? 0)
    if (Math.abs(turn) > 1e-9 && Math.abs(along) > 1e-9) helix += 1
  }
  return cuts === 0 ? 0 : helix / cuts
}

{
  const fixture: Project = rotaryOperationFixture('x', 'rotary_finish')
  // #1177: a **flat** finish. A ball's ring grid reads exact rows since #1177,
  // and an exact row never builds a height map, so a ball finish has no maps to
  // send back and this check would have nothing to carry. A flat's ring grid is
  // still the conservative map read this block exists for. (The ball's pooled
  // motion is checked against the serial one in `rotaryAnglePool.test.ts`.)
  const project: Project = {
    ...fixture,
    tools: fixture.tools.map((tool) => ({ ...tool, type: 'flat_endmill' as const })),
  }
  const operation: Operation = { ...project.operations[0], rotaryPassDirection: 'around' }
  const axis = (project.stock as { axis?: 'x' | 'y' }).axis ?? 'x'
  const sync = computeOperationToolpath(project, operation)
  assert.ok(sync, 'the synchronous entry generates the fixture')
  assert.ok(sync.result.moves.length > 0, 'the fixture emits motion')

  let captured: RotarySamplingPrep | null = null
  let pool: RotaryAnglePool | null = null
  const pooled = await computeOperationToolpathAsync(project, operation, {
    rotaryRunBatch: (prep) => {
      captured = prep
      pool = nodePool(prep, 2)
      return pool.batches
    },
  })
  assert.ok(pooled, 'the asynchronous entry generates the fixture through the pool')
  assert.deepEqual(pooled.result.moves, sync.result.moves, 'the pool reaches the same motion')
  assert.deepEqual(pooled.result.warnings, sync.result.warnings, 'the pool reaches the same warnings')
  const prep = captured as RotarySamplingPrep | null
  assert.ok(prep, 'the operation installed a prep')
  assert.equal(prep.angleMaps, 'write', "the fixture's around grid is the write-only client")
  const cache = prep.workspace.angleMaps
  assert.ok(cache !== undefined && cache.maps.size > 0, 'the operation cached the ring grid maps')
  const installed = pool as RotaryAnglePool | null
  assert.ok(installed !== null, 'the pool factory ran')
  const stats = installed.stats()
  assert.ok(stats.maps > 0 && stats.mapBytes > 0, 'the maps crossed the wire')
  const syncShare = helixShare(sync.result.moves, axis)
  const pooledShare = helixShare(pooled.result.moves, axis)
  assert.equal(pooledShare, syncShare, 'the same helix share')
  console.log(`  operation: ${sync.result.moves.length} moves identical, ${(pooledShare * 100).toFixed(1)}% helix,`
    + ` ${cache.maps.size} maps through the pool (${stats.mapBytes} bytes)`)
}

for (const pool of pools) await pool.dispose()

console.log('engine/toolpaths/rotaryAngleMapTransport.test.ts: all assertions passed')
