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
 * The angle-job wire protocol between the sampling coordinator and one angle
 * worker (#1115 slice p-d2).
 *
 * The unit a worker is set up with is one **operation**, not one angle: the
 * raster geometry, the strip plan and the scratch that outlive an angle are
 * installed once, and a job is then only its angle and its index. Copying that
 * payload per angle is what the p-d prototype had to avoid -- the design's
 * measurement is 60 bytes per triangle for the fused around raster alone, on a
 * 1.47 M-vertex bust -- so the split below is deliberate:
 *
 * - {@link RotaryAngleSetupPayload} crosses once per operation and per worker.
 *   It is transferred, never shared: each worker owns its copy, so no
 *   `SharedArrayBuffer` and no cross-origin isolation are needed (`vite.config`
 *   sets no COOP/COEP and the Tauri CSP does not either).
 * - {@link RotaryAnglePlanPayload} crosses again only when the strip plan
 *   changes, which happens only when a batch's reach grows (a refinement round
 *   that widens the strip a triangle can reach); a plan built for the same reach
 *   is the same object, so the pool compares identity and sends nothing.
 * - {@link RotaryAngleBatchRequest} carries one batch: its angle/index jobs,
 *   the plan revision they must be sampled against, and the batch and epoch
 *   they belong to. Late, duplicated and stale replies are refused by those
 *   three numbers rather than by hoping the ports are in step.
 *
 * The payload shape depends on the pass direction because the two modes read
 * different geometry, and sending both would multiply the per-worker copy for
 * nothing:
 *
 * - **around** (`conservativeCellBounds`) rasterises through the fused kernel,
 *   which needs the per-triangle `(across, up)`/along records and the strip
 *   plan's bucket index -- but no mesh, because the cross-section was already
 *   projected into those records.
 * - **along** projects the candidate triangles through `turnStripTriangles`,
 *   which needs the mesh, the per-vertex cross-section and the bucket index.
 *
 * Both shapes are a plain structured-clone payload: typed arrays, numbers and
 * strings, no functions, so the same setup runs in a `worker_threads` thread
 * (this slice) and in a browser module worker (p-d3).
 */

import type { BarStock } from '../../types/project'
import type { NormalizedTool } from './types'
import { buildRotaryRasterGeometry } from './rotaryRaster'
import type { RotaryAngleJob, RotaryAngleSample, RotarySamplingPrep } from './rotarySampling'

/**
 * Bumped when a payload's shape or meaning changes; a worker refuses another.
 *
 * Version 2 (#1103 slice ca-i) adds `emitAngleMaps` to the setup and a `map` to
 * a result sample: a worker told to emit hands each map it builds back, and the
 * pool caches it in the parent workspace.
 *
 * Version 4 (#1185 slice R3) adds `columns` to a job: the ring positions the
 * row is wanted at. A worker that did not know the field would sample the whole
 * row with the strip's own lift, which is not the row the caller asked for.
 */
export const ROTARY_ANGLE_PROTOCOL_VERSION = 4

/** Which sampling mode an installed worker is configured for. */
export type RotaryAngleMode = 'around' | 'along'

/** The strip plan a worker samples against, sliced into transferable arrays. */
export interface RotaryAnglePlanPayload {
  /** The cross-section's convex hull as `(across, up)` pairs. */
  readonly hull: Float64Array
  readonly minAlong: number
  readonly maxAlong: number
  /** One bit per (bucket, triangle); see `RotaryStripPlan.bucketBits` (#1115 p-e). */
  readonly bucketBits: Uint32Array
  /** 32-bit words per bucket. */
  readonly bucketWords: number
  /** Triangle starts that reach the strip at every turn. */
  readonly always: Uint32Array
  readonly bucketWidth: number
  /**
   * The per-vertex cross-section, **along mode only**: `turnStripTriangles`
   * projects every vertex it rasterises through these. Around mode fuses the
   * projection into its raster records and leaves them out.
   */
  readonly across?: Float64Array
  readonly up?: Float64Array
}

/** The fused around-mode raster records, transferable per worker. */
export interface RotaryAngleRasterPayload {
  /** 6 values per triangle: `a0, u0, a1, u1, a2, u2`. */
  readonly section: Float64Array
  /** 3 values per triangle: the axial coordinate of each corner. */
  readonly along: Float32Array
}

/** The sampled mesh, **along mode only**. */
export interface RotaryAngleMeshPayload {
  readonly positions: Float32Array
  readonly index: Uint32Array
}

/**
 * Everything one worker needs before it can sample an angle.
 *
 * `mode` is derived from the prep's `conservativeCellBounds`, exactly as the
 * per-angle job derives it, so a worker never has to infer which geometry it
 * was given.
 */
export interface RotaryAngleSetupPayload {
  readonly protocolVersion: number
  readonly mode: RotaryAngleMode
  readonly stock: BarStock
  readonly tool: NormalizedTool
  /** Positions along the bar's axis; every job samples these. */
  readonly along: readonly number[]
  /** Requested height-map cell size before `chooseHeightMapCellSize` caps it. */
  readonly requestedCellSize: number
  /**
   * The first retained-wall triangle of the mesh (#1095 slice D), when the
   * caller appended the wall's geometry. It must reach the worker, or a pass the
   * cutter only touches at the wall face is lifted to the wall's top -- the
   * omission the pool's wall test exists to catch.
   */
  readonly wallTriangleStart?: number
  /**
   * Read each angle row as the **exact** footprint maximum (#1177), the same
   * flag the parent's prep carries. It must reach the worker: without it the
   * worker rebuilds the prep with the flag off and reads the conservative cell
   * row, so a pooled ball path differs from the serial one (#1177 bal-a
   * correction 1 -- the round-bar preview drew 3241 segments against the 760 a
   * fresh generation gave).
   */
  readonly exactTipRows?: true
  readonly plan: RotaryAnglePlanPayload
  readonly raster?: RotaryAngleRasterPayload
  readonly mesh?: RotaryAngleMeshPayload
  /**
   * Hand every height map this worker builds back on its sample (#1103 slice
   * ca-i). Set only when the parent's prep asked for maps (`angleMaps` not
   * `'off'`) and its cache is not already full: the maps belong in the parent
   * workspace's cache, and a worker's own workspace is a copy the parent never
   * sees. Omitted, a result carries rows only, exactly as before this slice.
   */
  readonly emitAngleMaps?: boolean
}

/**
 * Install one operation's geometry into a worker. Sent once per worker.
 *
 * `epoch` travels with it so a failed install can be reported against the pool
 * generation that asked for it; a reply from a retired pool is dropped like any
 * other stale one.
 */
export interface RotaryAngleInstallRequest {
  readonly kind: 'install'
  readonly protocolVersion: number
  readonly epoch: number
  readonly setup: RotaryAngleSetupPayload
}

/** Replace the strip plan revision a worker samples against. */
export interface RotaryAnglePlanRequest {
  readonly kind: 'plan'
  readonly epoch: number
  readonly revision: number
  readonly plan: RotaryAnglePlanPayload
}

/** Sample one batch of angles. */
export interface RotaryAngleBatchRequest {
  readonly kind: 'batch'
  readonly epoch: number
  readonly batchId: number
  /** The plan revision in force for this batch (installed or last `plan` message). */
  readonly revision: number
  readonly jobs: readonly RotaryAngleJob[]
}

/** Release the worker's operation data. */
export interface RotaryAngleDisposeRequest {
  readonly kind: 'dispose'
}

export type RotaryAngleWorkerRequest =
  | RotaryAngleInstallRequest
  | RotaryAnglePlanRequest
  | RotaryAngleBatchRequest
  | RotaryAngleDisposeRequest

/** The worker's module is loaded and the protocol version matches. */
export interface RotaryAngleReadyReply {
  readonly kind: 'ready'
  readonly protocolVersion: number
}

/** The operation's setup is installed. */
export interface RotaryAngleInstalledReply {
  readonly kind: 'installed'
  readonly protocolVersion: number
}

/** A plan revision was applied. */
export interface RotaryAnglePlanAppliedReply {
  readonly kind: 'planApplied'
  readonly revision: number
}

/** One batch's samples, each carrying its own index. */
export interface RotaryAngleResultReply {
  readonly kind: 'result'
  readonly epoch: number
  readonly batchId: number
  readonly samples: readonly RotaryAngleSample[]
}

/**
 * A failure, tagged with how far the worker got. `install` and `plan` are
 * setup/resource failures -- the pool retries the batch serially -- while
 * `compute` is a real computation error and stays an error.
 */
export interface RotaryAngleErrorReply {
  readonly kind: 'error'
  readonly epoch: number
  readonly batchId: number
  readonly phase: 'install' | 'plan' | 'compute'
  readonly message: string
}

export type RotaryAngleWorkerReply =
  | RotaryAngleReadyReply
  | RotaryAngleInstalledReply
  | RotaryAnglePlanAppliedReply
  | RotaryAngleResultReply
  | RotaryAngleErrorReply

/** The plan a prep builds for a batch's angles (the sampler's own plan type). */
export type RotaryStripPlanValue = ReturnType<RotarySamplingPrep['planFor']>

/**
 * Slice a plan into the payload a worker is given.
 *
 * `mode` decides whether the per-vertex cross-section travels: only along mode
 * projects through it, and on a 1.47 M-vertex mesh those two arrays are 23.5 MB
 * per worker, so around mode leaves them behind -- unless the prep reads
 * **exact** rows (`exact`, #1177): the exact footprint read projects every
 * candidate triangle through the same cross-section in either mode.
 */
export function buildRotaryAnglePlan(
  plan: RotaryStripPlanValue,
  mode: RotaryAngleMode,
  exact = false,
): RotaryAnglePlanPayload {
  return {
    hull: plan.hull,
    minAlong: plan.minAlong,
    maxAlong: plan.maxAlong,
    bucketBits: plan.bucketBits,
    bucketWords: plan.bucketWords,
    always: plan.always,
    bucketWidth: plan.bucketWidth,
    ...(mode === 'along' || exact ? { across: plan.across, up: plan.up } : {}),
  }
}

/**
 * Build the payload one operation installs into each worker.
 *
 * The arrays are the operation's own -- no copy happens here, because the pool
 * makes one private copy per worker (see {@link copyRotaryAngleSetup}) and must
 * never transfer the prep's buffers: the synchronous driver, the in-process
 * fallback and every later batch all read them again.
 *
 * Building the payload may build the fused raster geometry, which the per-angle
 * job would otherwise build on its first angle; it is cached on the prep's
 * workspace, so nothing is paid twice.
 */
export function buildRotaryAngleSetup(
  prep: RotarySamplingPrep,
  plan: RotaryStripPlanValue,
): RotaryAngleSetupPayload {
  const mode: RotaryAngleMode = prep.conservativeCellBounds ? 'around' : 'along'
  const exact = prep.exactTipRows === true
  const planPayload = buildRotaryAnglePlan(plan, mode, exact)
  const common = {
    protocolVersion: ROTARY_ANGLE_PROTOCOL_VERSION,
    mode,
    stock: prep.stock,
    tool: prep.tool,
    along: [...prep.along],
    requestedCellSize: prep.requestedCellSize,
    ...(prep.wallTriangleStart !== undefined ? { wallTriangleStart: prep.wallTriangleStart } : {}),
    ...(prep.exactTipRows === true ? { exactTipRows: true as const } : {}),
    // #1103 slice ca-i: the parent's maps live in the parent workspace, so a
    // worker must hand its own back. A parent whose cache is already full gains
    // nothing from that and is not sent the flag at all.
    ...(prep.angleMaps !== 'off' && prep.workspace.angleMaps?.full !== true ? { emitAngleMaps: true } : {}),
    plan: planPayload,
  }
  if (mode === 'around') {
    const raster = prep.workspace.raster ??= buildRotaryRasterGeometry(
      prep.mesh.positions, prep.mesh.index, prep.stock.axis, prep.centre, prep.pivot)
    // #1177: an exact-tip row reads the mesh's own triangles, not the raster
    // records, so an around-mode worker needs the mesh as well. Without it the
    // worker's read found no triangle and every row came back empty: a pooled
    // ball finish skipped its whole band while the serial one cut it.
    return {
      ...common,
      raster: { section: raster.section, along: raster.along },
      ...(exact ? { mesh: { positions: prep.mesh.positions, index: prep.mesh.index } } : {}),
    }
  }
  return { ...common, mesh: { positions: prep.mesh.positions, index: prep.mesh.index } }
}

/** A private copy of a plan payload, its typed arrays copied too. */
export function copyRotaryAnglePlan(plan: RotaryAnglePlanPayload): RotaryAnglePlanPayload {
  return {
    hull: plan.hull.slice(),
    minAlong: plan.minAlong,
    maxAlong: plan.maxAlong,
    bucketBits: plan.bucketBits.slice(),
    bucketWords: plan.bucketWords,
    always: plan.always.slice(),
    bucketWidth: plan.bucketWidth,
    ...(plan.across !== undefined ? { across: plan.across.slice() } : {}),
    ...(plan.up !== undefined ? { up: plan.up.slice() } : {}),
  }
}

/**
 * A private copy of a setup, ready to transfer to one worker.
 *
 * Every typed array is sliced: a transfer detaches the sender's buffer, and the
 * sender's buffers belong to the operation. This is the per-worker copy the
 * design budgets at "60 bytes per triangle plus bucket data" -- one copy per
 * worker per operation, never one per angle.
 */
export function copyRotaryAngleSetup(setup: RotaryAngleSetupPayload): RotaryAngleSetupPayload {
  return {
    ...setup,
    plan: copyRotaryAnglePlan(setup.plan),
    ...(setup.raster !== undefined
      ? { raster: { section: setup.raster.section.slice(), along: setup.raster.along.slice() } }
      : {}),
    ...(setup.mesh !== undefined
      ? { mesh: { positions: setup.mesh.positions.slice(), index: setup.mesh.index.slice() } }
      : {}),
  }
}

/** Every buffer a copied plan payload owns, for a structured transfer. */
export function rotaryAnglePlanTransfer(plan: RotaryAnglePlanPayload): ArrayBuffer[] {
  return [
    plan.hull.buffer as ArrayBuffer,
    plan.bucketBits.buffer as ArrayBuffer,
    plan.always.buffer as ArrayBuffer,
    ...(plan.across !== undefined ? [plan.across.buffer as ArrayBuffer] : []),
    ...(plan.up !== undefined ? [plan.up.buffer as ArrayBuffer] : []),
  ]
}

/**
 * Every buffer a batch's samples own, for a structured transfer (#1115 p-d2,
 * extended by #1103 slice ca-i).
 *
 * A row and a returned map are freshly allocated per job and nothing reads them
 * after the reply is posted, so handing their buffers over is a move rather than
 * a copy. Only whole arrays are listed: a subarray's buffer carries cells the
 * message does not describe, and a transferred buffer is detached in the sender.
 * The map's three arrays are the ones `cropAngleMap` keeps, which are exactly
 * the ones the parent cache stores.
 */
export function rotaryAngleSampleTransfer(samples: readonly RotaryAngleSample[]): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>()
  const add = (array: { buffer: ArrayBufferLike; byteOffset: number; byteLength: number } | undefined): void => {
    if (array === undefined) return
    if (array.byteOffset !== 0 || array.byteLength !== array.buffer.byteLength) return
    buffers.add(array.buffer as ArrayBuffer)
  }
  for (const sample of samples) {
    add(sample.row)
    const map = sample.map?.map
    if (map === undefined) continue
    add(map.data)
    add(map.wallCoverage)
    add(map.modelOnly)
  }
  return [...buffers]
}

/** Every buffer a copied setup payload owns, for a structured transfer. */
export function rotaryAngleSetupTransfer(setup: RotaryAngleSetupPayload): ArrayBuffer[] {
  return [
    ...rotaryAnglePlanTransfer(setup.plan),
    ...(setup.raster !== undefined
      ? [setup.raster.section.buffer as ArrayBuffer, setup.raster.along.buffer as ArrayBuffer]
      : []),
    ...(setup.mesh !== undefined
      ? [setup.mesh.positions.buffer as ArrayBuffer, setup.mesh.index.buffer as ArrayBuffer]
      : []),
  ]
}

/** Bytes of typed buffers one setup holds; what one worker's copy costs. */
export function rotaryAngleSetupBytes(setup: RotaryAngleSetupPayload): number {
  let bytes = 0
  const add = (array: { byteLength: number } | undefined): void => {
    if (array !== undefined) bytes += array.byteLength
  }
  add(setup.plan.hull)
  add(setup.plan.bucketBits)
  add(setup.plan.always)
  add(setup.plan.across)
  add(setup.plan.up)
  add(setup.raster?.section)
  add(setup.raster?.along)
  add(setup.mesh?.positions)
  add(setup.mesh?.index)
  return bytes
}

/** Number of triangles a setup's mode can rasterise. */
export function rotaryAngleTriangleCount(setup: RotaryAngleSetupPayload): number {
  if (setup.mode === 'around') return Math.floor((setup.raster?.along.length ?? 0) / 3)
  return Math.floor((setup.mesh?.index.length ?? 0) / 3)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

/** Whether a message is a well-formed worker reply. */
export function isRotaryAngleWorkerReply(value: unknown): value is RotaryAngleWorkerReply {
  if (!isObject(value) || typeof value.kind !== 'string') return false
  switch (value.kind) {
    case 'ready':
    case 'installed':
      return typeof value.protocolVersion === 'number'
    case 'planApplied':
      return typeof value.revision === 'number'
    case 'result':
      return typeof value.epoch === 'number'
        && typeof value.batchId === 'number'
        && Array.isArray(value.samples)
    case 'error':
      return typeof value.epoch === 'number'
        && typeof value.batchId === 'number'
        && (value.phase === 'install' || value.phase === 'plan' || value.phase === 'compute')
        && typeof value.message === 'string'
    default:
      return false
  }
}

/**
 * Whether a message is a well-formed request.
 *
 * Strict because the worker must never act on a message it half understands: a
 * batch with no jobs or a plan with no buckets would sample nothing and look
 * like a legitimate empty answer.
 */
export function isRotaryAngleWorkerRequest(value: unknown): value is RotaryAngleWorkerRequest {
  if (!isObject(value) || typeof value.kind !== 'string') return false
  switch (value.kind) {
    case 'install': {
      const setup = value.setup
      return typeof value.protocolVersion === 'number' && typeof value.epoch === 'number' && isObject(setup)
        && (setup.mode === 'around' || setup.mode === 'along')
        && typeof setup.requestedCellSize === 'number'
        && Array.isArray(setup.along)
        && (setup.emitAngleMaps === undefined || typeof setup.emitAngleMaps === 'boolean')
        && isObject(setup.plan) && isObject(setup.tool) && isObject(setup.stock)
    }
    case 'plan':
      return typeof value.epoch === 'number'
        && typeof value.revision === 'number'
        && isObject(value.plan)
    case 'batch':
      return typeof value.epoch === 'number'
        && typeof value.batchId === 'number'
        && typeof value.revision === 'number'
        && Array.isArray(value.jobs)
        && value.jobs.every((job: unknown) => isObject(job)
          && typeof job.index === 'number'
          && typeof job.angle === 'number'
          // #1185 R3: the ring positions a row is wanted at, when not all of them.
          && (job.columns === undefined || (Array.isArray(job.columns)
            && job.columns.every((column: unknown) => Number.isInteger(column) && (column as number) >= 0))))
    case 'dispose':
      return true
    default:
      return false
  }
}

/**
 * The unusable setup a reply error names, without leaking payload contents.
 *
 * Kept here so both the worker and the pool describe a missing part the same
 * way, which is what makes a setup failure readable in a benchmark's stderr.
 */
export function describeRotaryAngleSetup(setup: RotaryAngleSetupPayload): string {
  const parts = [`${setup.mode} mode`]
  if (setup.mode === 'around') {
    parts.push(setup.raster === undefined ? 'no raster payload' : `${setup.raster.section.length / 6} raster triangles`)
  } else {
    parts.push(setup.mesh === undefined ? 'no mesh payload' : `${setup.mesh.index.length / 3} mesh triangles`)
    parts.push(setup.plan.across === undefined || setup.plan.up === undefined
      ? 'no cross-section'
      : `${setup.plan.across.length} cross-section points`)
  }
  parts.push(`${setup.along.length} along positions`)
  parts.push(`${setup.plan.bucketBits.length} bucket words for ${setup.plan.bucketWords} words a bucket`)
  return parts.join(', ')
}
