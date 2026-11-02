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
 * The angle worker pool: a {@link RotaryBatchFactory} that samples a batch on
 * several workers and assembles the results by job index (#1115 slice p-d2).
 *
 * Three things this file is responsible for, and nothing else:
 *
 * 1. **How many workers.** `min(angleCount, 8, max(1, parallelism - 2))`, further
 *    capped by a 512 MiB typed-buffer budget computed *before* any worker is
 *    created -- the design's rule. Unknown parallelism means serial: a pool that
 *    guesses can create more workers than the machine can hold, and the failure
 *    arrives as an OOM kill rather than as an error. The budget is not a guess
 *    either: it charges one private setup copy per worker (the raster records,
 *    the bucket index, the mesh) plus the scratch a worker derives while it
 *    samples (candidate lists, the turned buffer, the height map and its wall
 *    arrays, the raster's cell-range caches).
 * 2. **Which reply is real.** Every reply carries its epoch, batch and the index
 *    of the job it answers. A reply from a retired epoch or another batch is
 *    dropped; a duplicated or unexpected index is refused. Assembly then maps
 *    each job to the result that names *its* index, so completion order cannot
 *    reach the output -- which is the property the reverse-order test pins.
 * 3. **What a failure means.** A startup or resource failure (a worker that
 *    cannot be created or installed, one that dies, or a send that throws -- a
 *    closed `MessagePort` reports itself that way, not as a reply) discards the
 *    batch and reruns it serially, and every later batch stays serial: the
 *    operation still generates. A send failure has to settle whatever it left
 *    waiting first, or a discarded batch stays pending and disposal rejects a
 *    promise nobody holds. A computation error is not retried -- it is a real
 *    error in the sampler, and hiding it behind a second run would hide it from
 *    the user.
 *
 * The pool is transport-agnostic: a {@link RotaryAngleWorkerSource} creates the
 * ports, so the same pool drives Node `worker_threads` here (see
 * `src/app/toolpathGeneration/rotaryAngleNodeTransport.ts`) and a browser module
 * worker in p-d3. It never touches `globalThis`, `process` or a timer.
 */

import { MAX_HEIGHT_MAP_CELLS } from './finishSurfaceParallel'
import type { RotaryAngleJob, RotaryAngleSample, RotaryBatchFactory, RotarySamplingPrep } from './rotarySampling'
import { serialRotaryBatches } from './rotarySampling'
import type {
  RotaryAngleSetupPayload,
  RotaryAngleWorkerReply,
  RotaryAngleWorkerRequest,
  RotaryStripPlanValue,
} from './rotaryAngleProtocol'
import {
  ROTARY_ANGLE_PROTOCOL_VERSION,
  buildRotaryAnglePlan,
  buildRotaryAngleSetup,
  copyRotaryAnglePlan,
  copyRotaryAngleSetup,
  rotaryAnglePlanTransfer,
  rotaryAngleSetupBytes,
  rotaryAngleSetupTransfer,
  rotaryAngleTriangleCount,
} from './rotaryAngleProtocol'

/** The design's worker-count ceiling: beyond eight the serial share dominates. */
export const MAX_ROTARY_ANGLE_WORKERS = 8

/** The design's typed-buffer budget for one operation's whole pool, in bytes. */
export const ROTARY_ANGLE_POOL_BUDGET_BYTES = 512 * 1024 * 1024

/** One worker as the pool sees it: a message channel and a way to stop it. */
export interface RotaryAngleWorkerPort {
  post(message: RotaryAngleWorkerRequest, transfer: readonly ArrayBuffer[]): void
  onReply(handler: (reply: RotaryAngleWorkerReply) => void): void
  onFailure(handler: (error: Error) => void): void
  terminate(): void | Promise<void>
}

/**
 * Creates the pool's workers. `availableParallelism` is the caller's answer for
 * the machine (`os.availableParallelism()` under Node, a hardware-concurrency
 * hint in a browser); omitting it selects serial execution.
 */
export interface RotaryAngleWorkerSource {
  readonly availableParallelism?: number
  create(index: number): RotaryAngleWorkerPort
}

export interface RotaryAnglePoolOptions {
  /** Override the design's eight-worker ceiling (tests use it). */
  readonly maxWorkers?: number
  /** Override the design's 512 MiB budget (tests use it). */
  readonly maxBufferBytes?: number
}

/** Why the pool is running the way it is; read by the probe and by tests. */
export interface RotaryAnglePoolStats {
  /** `serial` also covers a pool that fell back after a worker failure. */
  readonly mode: 'serial' | 'parallel'
  readonly workers: number
  /** `none` unless a startup/resource failure moved the operation to serial. */
  readonly fallback: 'none' | 'startup'
  /** Typed buffers one worker's copy holds (0 when nothing was installed). */
  readonly setupBytes: number
  /** Wall time spent creating workers and installing the setup. */
  readonly installMs: number
  /** Batches dispatched to workers (serial runs are not counted). */
  readonly batches: number
  /** Wall time spent awaiting worker replies, summed over those batches. */
  readonly awaitMs: number
  /** Plan revisions sent beyond the one the install carries. */
  readonly planRevisions: number
  /** Replies dropped for a stale epoch, a stale batch or a retired pool. */
  readonly rejectedReplies: number
}

export interface RotaryAnglePool {
  readonly batches: ReturnType<RotaryBatchFactory>
  stats(): RotaryAnglePoolStats
  dispose(): Promise<void>
}

/** How many workers a batch may use, and why. */
export interface RotaryAngleWorkerPlan {
  readonly workers: number
  readonly availableParallelism: number | null
  /** The per-worker budget charge, or 0 when no worker will be created. */
  readonly perWorkerBytes: number
  /** How many workers the byte budget alone would allow. */
  readonly budgetWorkers: number
  readonly reason:
    | 'parallel'
    | 'serial-unknown-concurrency'
    | 'serial-one-angle'
    | 'serial-cores'
    | 'serial-budget'
}

function roundedMs(value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * The worker count for one operation's pool.
 *
 * `availableParallelism` is deliberately optional: a runtime that cannot say how
 * many cores it has gets serial execution, not a guess. The byte budget is
 * charged once per worker and is what keeps eight workers from turning a
 * 1.47 M-vertex bust into an OOM kill; when it allows only one, there is nothing
 * to parallelise and the pool runs serial too.
 */
export function planRotaryAnglePool(input: {
  readonly angleCount: number
  readonly availableParallelism?: number | null
  readonly perWorkerBytes: number
  readonly maxWorkers?: number
  readonly maxBufferBytes?: number
}): RotaryAngleWorkerPlan {
  // `maxWorkers` may *lower* the ceiling but never raise it: the design put the
  // ceiling at eight because past it the serial share dominates, and a caller
  // that passed the machine's 32 cores used to select 30 workers -- a count the
  // byte budget then has to pay for, not one it chose.
  const maxWorkers = Math.max(1, Math.min(MAX_ROTARY_ANGLE_WORKERS, Math.floor(input.maxWorkers ?? MAX_ROTARY_ANGLE_WORKERS)))
  const maxBufferBytes = Math.max(0, input.maxBufferBytes ?? ROTARY_ANGLE_POOL_BUDGET_BYTES)
  const perWorkerBytes = Math.max(0, input.perWorkerBytes)
  const parallelism = input.availableParallelism
  const known = typeof parallelism === 'number' && Number.isFinite(parallelism) && parallelism >= 1
  const cores = known ? Math.max(1, Math.floor(parallelism) - 2) : 0
  // One worker always has to fit: a budget too small for even one worker means
  // the operation cannot run in a worker at all, not that it runs split.
  const budgetWorkers = perWorkerBytes > 0 ? Math.max(1, Math.floor(maxBufferBytes / perWorkerBytes)) : 1
  const angles = Math.max(0, Math.floor(input.angleCount))
  const workers = Math.max(1, Math.min(angles, maxWorkers, cores, budgetWorkers))
  const reason: RotaryAngleWorkerPlan['reason'] = workers > 1
    ? 'parallel'
    : angles < 2
      ? 'serial-one-angle'
      : !known
        ? 'serial-unknown-concurrency'
        : cores < 2
          ? 'serial-cores'
          : 'serial-budget'
  return {
    workers,
    availableParallelism: known ? Math.floor(parallelism) : null,
    perWorkerBytes,
    budgetWorkers,
    reason,
  }
}

/**
 * The typed buffers one worker must be able to hold at once.
 *
 * The setup copy is what the design measures ("60 bytes per triangle" for the
 * fused raster plus bucket data), and the rest is what the job derives from it
 * on a worker: the candidate subset, the along-mode turned vertex buffer, the
 * raster's per-triangle cell-range caches, the raster's clip-candidate scratch,
 * and the height-map set -- capped at `MAX_HEIGHT_MAP_CELLS` by
 * `chooseHeightMapCellSize`, so this is the largest map a worker can be asked to
 * build. Charging all of it before dispatch is what makes "eight workers fit in
 * 512 MiB" a measurement rather than a hope.
 *
 * The map set is more than the map. The clip pass builds a **peak-limit
 * neighbourhood map** from the centre-sampled map (`buildRotaryHeightMap`'s
 * `peakLimit`, and `buildHeightMap`'s) and, when the caller marked retained
 * walls (#1095 slice D), a second one judged against the model-only surface:
 * the wall coverage `Uint8Array`, the model-only `Float32Array` and
 * `modelPeakLimit`. All five arrays are live at once, so a max-size map holds
 * **17 bytes per cell** with walls (8 without), not the 9 the map, its coverage
 * and the model-only map cost when the peak maps are forgotten -- 17,000,000
 * bytes of maps against a 9,001,560-byte charge for a single worker's cap.
 *
 * Walls are charged only where the sampler can pass them: `buildOptions` in
 * `runRotaryAngleJob` adds `wallTriangleStart` for around mode only, so an along
 * worker's map never allocates the wall arrays.
 */
export function estimateRotaryAngleWorkerBytes(setup: RotaryAngleSetupPayload): number {
  const triangles = rotaryAngleTriangleCount(setup)
  const vertices = Math.floor((setup.mesh?.positions.length ?? 0) / 3)
  let bytes = rotaryAngleSetupBytes(setup)
  // The per-angle candidate subset holds `2 * triangles` starts.
  bytes += triangles * 2 * 4
  // Along mode turns every candidate into this buffer; around mode fuses it.
  if (setup.mode === 'along') bytes += vertices * 3 * 4
  // Raster clip-candidate scratch. The along path rasterises through the general
  // kernel, which keeps a Float64 maximum, an Int32 cell and a four-Int32 box per
  // candidate (32 bytes); around mode's fused kernel collects the candidate
  // index alone and reads its box off the hit test, so it is charged the index
  // (4 bytes). Charging the flat kernel's arrays to an around worker overstated
  // it by 28 bytes a triangle -- 13.8 MB on the bust, one worker's worth of the
  // 512 MiB budget at #1115 slice p-e.
  bytes += triangles * (setup.mode === 'along' ? 32 : 4)
  // Around mode also caches the axial centre/bbox cell ranges per triangle.
  if (setup.mode === 'around') bytes += triangles * 16
  // One height map plus the peak-limit neighbourhood map the clip pass builds
  // from it (#1050 slices B/C): both modes allocate that pair, per angle.
  bytes += MAX_HEIGHT_MAP_CELLS * (4 + 4)
  // Retained walls (#1095 slice D) add the per-cell wall coverage, the
  // model-only map and the second peak-limit map the clip pass then compares a
  // model triangle against.
  if (setup.mode === 'around' && setup.wallTriangleStart !== undefined) {
    bytes += MAX_HEIGHT_MAP_CELLS * (1 + 4 + 4)
  }
  return bytes
}

/** One batch in flight. */
interface ActiveBatch {
  readonly id: number
  readonly jobs: readonly RotaryAngleJob[]
  readonly collected: Map<number, RotaryAngleSample>
  /**
   * Every sample in the order it arrived. Recorded, never assembled from: a pool
   * whose workers finish out of order must still answer in the batch's own
   * order, and this is what a test compares against that.
   */
  readonly arrival: RotaryAngleSample[]
  /** Job indices still missing, by worker slot. */
  readonly missing: Set<number>[]
  pendingWorkers: number
  settled: boolean
  resolve: (samples: readonly RotaryAngleSample[]) => void
  reject: (error: Error) => void
}

/** A wait for every worker to acknowledge an install or a plan revision. */
interface PhaseWait {
  readonly kind: 'install' | 'plan'
  readonly revision: number | null
  readonly pending: Set<number>
  resolve: () => void
  reject: (error: Error) => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Startup and resource failures get the serial retry; computation errors do not.
 *
 * The pool's own setup failures are thrown with this prefix, and a worker's
 * `install`/`plan` error or a worker's death is wrapped in it too, so one
 * predicate decides both.
 */
const SETUP_FAILURE_PREFIX = 'rotary angle pool: setup failure:'

/** Mark an error as a setup/resource failure the pool may retry serially. */
export function setupFailure(error: unknown): Error {
  return new Error(`${SETUP_FAILURE_PREFIX} ${errorMessage(error)}`)
}

/** Whether an error is a setup/resource failure (retried serially) or real. */
export function isSetupFailure(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith(SETUP_FAILURE_PREFIX)
}

/** Mark something a resource failure without stacking the prefix twice. */
function asSetupFailure(error: unknown): Error {
  return isSetupFailure(error) ? error as Error : setupFailure(error)
}

/**
 * Note that a promise's rejection will be handled, and hand it back.
 *
 * A batch or phase wait is *messaged first and awaited second*, so a send that
 * throws can settle the promise before its caller reaches `await`. Awaiting the
 * original still throws -- that is what the caller needs -- but an unobserved
 * rejection is a process-level failure under Node, and this promise is only ever
 * observed later (or by nobody, once the batch has been discarded and the jobs
 * rerun serially). The attached handler is the difference between "the fallback
 * ran" and "the fallback ran, then the process died of an unhandled rejection".
 */
function observed<T>(promise: Promise<T>): Promise<T> {
  void promise.catch(() => {})
  return promise
}

/**
 * Create one operation's pool.
 *
 * Nothing is created here: the first batch decides the worker count (it is the
 * one that knows the angle count), installs the setup and only then dispatches.
 * That keeps a cancelled or immediately-stopped operation from paying for
 * workers it never uses.
 */
export function createRotaryAnglePool(
  prep: RotarySamplingPrep,
  source: RotaryAngleWorkerSource,
  options: RotaryAnglePoolOptions = {},
): RotaryAnglePool {
  const maxWorkers = options.maxWorkers ?? MAX_ROTARY_ANGLE_WORKERS
  const maxBufferBytes = options.maxBufferBytes ?? ROTARY_ANGLE_POOL_BUDGET_BYTES
  const ports: RotaryAngleWorkerPort[] = []
  const serial: ReturnType<RotaryBatchFactory> = serialRotaryBatches(prep)
  let epoch = 1
  let mode: RotaryAnglePoolStats['mode'] = 'serial'
  let fallback: RotaryAnglePoolStats['fallback'] = 'none'
  let setupBytes = 0
  let installMs = 0
  let batches = 0
  let awaitMs = 0
  let planRevisions = 0
  let rejectedReplies = 0
  let disposed = false
  let installed = false
  let setupMode: RotaryAngleSetupPayload['mode'] = 'around'
  let planRevision = 0
  /** The plan object the workers are currently sampling against, by identity. */
  let sentPlan: RotaryStripPlanValue | null = null
  let batchCounter = 0
  let active: ActiveBatch | null = null
  let phaseWait: PhaseWait | null = null
  /** True once a startup/resource failure has moved this operation to serial. */
  let serialMode = false

  const stats = (): RotaryAnglePoolStats => ({
    mode,
    workers: ports.length,
    fallback,
    setupBytes,
    installMs: roundedMs(installMs),
    batches,
    awaitMs: roundedMs(awaitMs),
    planRevisions,
    rejectedReplies,
  })

  /** Stop using the pool; every later batch runs serially. */
  const degrade = (): void => {
    if (disposed) return
    mode = 'serial'
    fallback = 'startup'
    epoch += 1
    serialMode = true
    for (const port of ports) {
      try {
        port.terminate()
      } catch {
        // A worker that cannot be stopped must not take the failure path with it.
      }
    }
    ports.length = 0
    installed = false
    sentPlan = null
  }

  const rejectPhase = (error: Error): void => {
    const wait = phaseWait
    if (wait === null) return
    phaseWait = null
    wait.reject(error)
  }

  const rejectBatch = (error: Error): void => {
    const batch = active
    if (batch === null || batch.settled) return
    batch.settled = true
    active = null
    batch.reject(error)
  }

  const onReply = (index: number, reply: RotaryAngleWorkerReply): void => {
    if (disposed) return
    const wait = phaseWait
    switch (reply.kind) {
      case 'ready':
        return
      case 'installed':
        if (wait !== null && wait.kind === 'install') {
          wait.pending.delete(index)
          if (wait.pending.size === 0) {
            phaseWait = null
            wait.resolve()
          }
        }
        return
      case 'planApplied':
        if (wait !== null && wait.kind === 'plan' && wait.revision === reply.revision) {
          wait.pending.delete(index)
          if (wait.pending.size === 0) {
            phaseWait = null
            wait.resolve()
          }
        }
        return
      case 'error': {
        if (reply.epoch !== epoch) {
          rejectedReplies += 1
          return
        }
        const message = `rotary angle worker: ${reply.message}`
        // A setup or plan failure is a resource failure: discard and go serial.
        if (reply.phase !== 'compute') {
          if (phaseWait !== null) rejectPhase(setupFailure(message))
          else rejectBatch(setupFailure(message))
          return
        }
        const batch = active
        if (batch === null || reply.batchId !== batch.id) {
          rejectedReplies += 1
          return
        }
        rejectBatch(new Error(message))
        return
      }
      case 'result': {
        if (reply.epoch !== epoch) {
          rejectedReplies += 1
          return
        }
        const batch = active
        if (batch === null || batch.settled || reply.batchId !== batch.id) {
          rejectedReplies += 1
          return
        }
        const missing = batch.missing[index]
        if (missing === undefined) {
          rejectBatch(new Error(`rotary angle pool: a reply arrived from worker ${index}, which has no jobs in batch ${batch.id}`))
          return
        }
        for (const sample of reply.samples) {
          const jobIndex = sample.index
          if (!Number.isInteger(jobIndex)) {
            rejectBatch(new Error(`rotary angle pool: worker ${index} returned a non-integer job index ${jobIndex}`))
            return
          }
          if (!missing.has(jobIndex)) {
            rejectBatch(new Error(
              `rotary angle pool: worker ${index} returned job ${jobIndex}, which it was not given`
              + (batch.collected.has(jobIndex) ? ' (duplicate result)' : ''),
            ))
            return
          }
          if (sample.row.length !== prep.along.length) {
            rejectBatch(new Error(
              `rotary angle pool: job ${jobIndex} returned ${sample.row.length} samples for ${prep.along.length} along positions`,
            ))
            return
          }
          if (!Number.isFinite(sample.lift) || sample.lift < 0) {
            rejectBatch(new Error(`rotary angle pool: job ${jobIndex} returned lift ${sample.lift}`))
            return
          }
          if (!Array.isArray(sample.warnings)) {
            rejectBatch(new Error(`rotary angle pool: job ${jobIndex} returned no warning list`))
            return
          }
          missing.delete(jobIndex)
          batch.collected.set(jobIndex, sample)
          batch.arrival.push(sample)
        }
        if (missing.size > 0) return
        batch.pendingWorkers -= 1
        if (batch.pendingWorkers > 0) return
        // Every job answered. Assembled by index, never by arrival order.
        const ordered: RotaryAngleSample[] = []
        for (const job of batch.jobs) {
          const sample = batch.collected.get(job.index)
          if (sample === undefined) {
            rejectBatch(new Error(`rotary angle pool: job ${job.index} has no result`))
            return
          }
          ordered.push(sample)
        }
        batch.settled = true
        active = null
        batch.resolve(ordered)
        return
      }
      default:
        return
    }
  }

  /**
   * A worker died. While a batch is in flight the batch is discarded and the
   * operation moves to serial; while it is idle, the next batch does. A worker
   * dying while the setup is being installed is a startup failure.
   */
  const workerFailed = (index: number, error: Error): void => {
    if (disposed) return
    void ports[index]?.terminate()
    if (phaseWait !== null) {
      rejectPhase(setupFailure(error))
      return
    }
    if (active !== null) {
      rejectBatch(setupFailure(error))
      // The batch is discarded, but this worker's death may be the only bad one;
      // the retry is what proves it, so the pool stops using workers here too.
      degrade()
      return
    }
    degrade()
  }

  const createWorkers = (workerCount: number): void => {
    for (let index = 0; index < workerCount; index += 1) {
      let port: RotaryAngleWorkerPort
      try {
        port = source.create(index)
      } catch (error) {
        throw setupFailure(error)
      }
      port.onReply((reply) => onReply(index, reply))
      port.onFailure((error) => workerFailed(index, error))
      ports.push(port)
    }
  }

  const awaitInstall = (): Promise<void> => observed(new Promise<void>((resolve, reject) => {
    phaseWait = { kind: 'install', revision: null, pending: new Set(ports.map((_, index) => index)), resolve, reject }
  }))

  const awaitPlan = (revision: number): Promise<void> => observed(new Promise<void>((resolve, reject) => {
    phaseWait = { kind: 'plan', revision, pending: new Set(ports.map((_, index) => index)), resolve, reject }
  }))

  /**
   * Create the workers for this batch and install the setup in each.
   *
   * Each worker gets its **own** copy of the setup: the payload's arrays are
   * sliced and then transferred, so the prep's buffers are never detached and no
   * two workers share memory.
   */
  const install = async (setup: RotaryAngleSetupPayload, planValue: RotaryStripPlanValue, workerCount: number): Promise<void> => {
    const started = performance.now()
    try {
      createWorkers(workerCount)
      const wait = awaitInstall()
      for (let index = 0; index < ports.length; index += 1) {
        const copy = copyRotaryAngleSetup(setup)
        ports[index].post({
          kind: 'install',
          protocolVersion: ROTARY_ANGLE_PROTOCOL_VERSION,
          epoch,
          setup: copy,
        }, rotaryAngleSetupTransfer(copy))
      }
      await wait
    } catch (error) {
      // A send that throws leaves the install unanswered. Settle the wait here
      // (a no-op when the failure *was* the wait) so nothing is left pending,
      // then report the resource failure the serial retry exists for.
      rejectPhase(asSetupFailure(error))
      throw asSetupFailure(error)
    } finally {
      installMs += performance.now() - started
    }
    installed = true
    setupBytes = rotaryAngleSetupBytes(setup)
    setupMode = setup.mode
    sentPlan = planValue
    mode = 'parallel'
  }

  /** Send a new plan revision when the reach grew (the plan object changed). */
  const revisePlan = async (next: RotaryStripPlanValue): Promise<void> => {
    const payload = buildRotaryAnglePlan(next, setupMode)
    planRevision += 1
    const revision = planRevision
    const wait = awaitPlan(revision)
    try {
      for (let index = 0; index < ports.length; index += 1) {
        const copy = copyRotaryAnglePlan(payload)
        ports[index].post({ kind: 'plan', epoch, revision, plan: copy }, rotaryAnglePlanTransfer(copy))
      }
      await wait
    } catch (error) {
      // Same as the install: a throwing send would otherwise escape with the
      // plan wait still attached and no revision in force.
      rejectPhase(asSetupFailure(error))
      throw asSetupFailure(error)
    }
    sentPlan = next
    planRevisions += 1
  }

  const dispatch = async (jobs: readonly RotaryAngleJob[], workerCount: number): Promise<readonly RotaryAngleSample[]> => {
    batchCounter += 1
    const batchId = batchCounter
    const assignments: number[][] = []
    for (let index = 0; index < workerCount; index += 1) assignments.push([])
    jobs.forEach((job, position) => assignments[position % workerCount].push(job.index))
    const started = performance.now()
    const promise = observed(new Promise<readonly RotaryAngleSample[]>((resolve, reject) => {
      active = {
        id: batchId,
        jobs,
        collected: new Map(),
        arrival: [],
        missing: assignments.map((indices) => new Set(indices)),
        pendingWorkers: assignments.filter((indices) => indices.length > 0).length,
        settled: false,
        resolve,
        reject,
      }
    }))
    try {
      for (let index = 0; index < ports.length; index += 1) {
        const indices = new Set(assignments[index])
        const chunk = jobs.filter((job) => indices.has(job.index))
        if (chunk.length === 0) continue
        ports[index].post({
          kind: 'batch',
          epoch,
          batchId,
          revision: planRevision,
          jobs: chunk,
        }, [])
      }
    } catch (error) {
      // The batch never reached every worker: a dead transport throws here
      // rather than reporting a failure. Settle the batch so nothing is left
      // pending for disposal to reject, and report a resource failure so the
      // caller discards it and reruns the jobs serially -- exactly what a worker
      // that died mid-batch gets.
      rejectBatch(asSetupFailure(error))
      throw asSetupFailure(error)
    }
    batches += 1
    try {
      return await promise
    } finally {
      awaitMs += performance.now() - started
    }
  }

  const batchesFn = async (jobs: readonly RotaryAngleJob[]): Promise<readonly RotaryAngleSample[]> => {
    if (disposed) throw new Error('rotary angle pool: disposed before its batch ran')
    if (jobs.length === 0) return []
    if (serialMode) return serial(jobs)
    try {
      const planValue = prep.planFor(jobs.map((job) => job.angle))
      if (!installed) {
        const setup = buildRotaryAngleSetup(prep, planValue)
        const workerPlan = planRotaryAnglePool({
          angleCount: jobs.length,
          ...(source.availableParallelism !== undefined
            ? { availableParallelism: source.availableParallelism }
            : {}),
          perWorkerBytes: estimateRotaryAngleWorkerBytes(setup),
          maxWorkers,
          maxBufferBytes,
        })
        if (workerPlan.workers <= 1) {
          serialMode = true
          mode = 'serial'
          return serial(jobs)
        }
        await install(setup, planValue, workerPlan.workers)
      } else if (planValue !== sentPlan) {
        await revisePlan(planValue)
      }
      const workers = Math.min(ports.length, jobs.length)
      if (workers <= 0) {
        serialMode = true
        mode = 'serial'
        return serial(jobs)
      }
      return await dispatch(jobs, workers)
    } catch (error) {
      // A startup or resource failure discards the batch and reruns it serially.
      // A computation error is the user's problem, not a transport problem.
      if (!isSetupFailure(error)) throw error
      degrade()
      return serial(jobs)
    }
  }

  return {
    batches: batchesFn,
    stats,
    async dispose() {
      if (disposed) return
      disposed = true
      epoch += 1
      // Whatever is waiting must hear that it will not be answered: a disposed
      // pool that left a batch promise pending would hang its caller, which is
      // the one failure mode a cancellation path in p-d3 could not survive.
      rejectBatch(new Error('rotary angle pool: disposed while a batch was in flight'))
      rejectPhase(new Error('rotary angle pool: disposed while it was being installed'))
      for (const port of ports) {
        try {
          port.post({ kind: 'dispose' }, [])
        } catch {
          // A port already gone cannot be told to release anything.
        }
        try {
          await port.terminate()
        } catch {
          // Same as above: disposal is best effort.
        }
      }
      ports.length = 0
      installed = false
      sentPlan = null
    },
  }
}
