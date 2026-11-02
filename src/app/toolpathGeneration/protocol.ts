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
 * The main-thread ↔ worker message contract (issue #675).
 *
 * Both ends validate every message before acting on it. That is not defensive
 * boilerplate: a malformed or mismatched message means the two sides disagree
 * about what is being computed, and the only safe response is to reject it.
 * Nothing here ever *repairs* a message — no coordinate is coerced, no missing
 * metadata is defaulted, no partial result is cached. A message that does not
 * validate settles its request as a `protocol` failure and is otherwise dropped.
 *
 * The payloads cross by **structured clone**, not `JSON.stringify`. JSON would
 * silently turn `undefined` into a dropped key and `NaN`/`Infinity` into
 * `null` — all three occur in real toolpath metadata — and would cost a full
 * serialise/parse of paths that reach a million moves.
 */

import type { Operation, Project } from '../../types/project'
import type { ToolpathResult } from '../../engine/toolpaths'
import { isPackedMoves, type TransportedResult } from './moveTransport'
import type { GenerationFailure, GenerationStage, RequestIdentity } from './types'

/**
 * Bumped whenever a message shape changes. The handshake compares it, so a
 * stale worker chunk left in a browser cache after a deploy is rejected at
 * startup rather than misread halfway through a job.
 *
 * v2 (issue #675, slice 6): `completed` carries packed, transferable moves
 * instead of a cloned move array. The move-kind table in `moveTransport.ts` is
 * part of this version — reordering it changes what an index means.
 *
 * v3 (issue #1115, slice p-d3): the angle-worker handshake. The generation
 * worker asks the main thread to create an angle worker and transfers one end
 * of a `MessageChannel`; the main thread answers with the angle worker itself,
 * or with `rotaryWorkerFailed`. `completed` optionally reports which way the
 * angle pool ran.
 *
 * v4 (issue #1115, slice p-d3 fix 2): `rotaryCancelled` reports that a
 * superseded rotary generation has actually finished. A cancelled generation
 * waits on an angle batch, so without that message the main thread could not
 * tell "cancelled and stopped" from "cancelled and still holding the previous
 * operation's data"; the bump is what stops a cached v3 worker from posting a
 * kind its main thread would reject.
 */
export const TOOLPATH_PROTOCOL_VERSION = 4

// ── Worker → main ────────────────────────────────────────────────────

export interface ReadyMessage {
  kind: 'ready'
  protocolVersion: number
  workerEpoch: number
}

export interface SnapshotReadyMessage {
  kind: 'snapshotReady'
  documentKey: number
  snapshotId: number
}

export interface ProgressMessage {
  kind: 'progress'
  identity: RequestIdentity
  stage: GenerationStage
}

export interface CompletedMessage {
  kind: 'completed'
  identity: RequestIdentity
  /**
   * Moves travel packed and transferred; everything else in the envelope still
   * clones. Deep-cloning a large move array cost more on the main thread than
   * generating it there did — see `moveTransport.ts`.
   */
  result: TransportedResult
  raw: TransportedResult | null
  /**
   * How the rotary angle pool ran, when the operation used one (#1115 p-d3).
   *
   * Absent for every non-rotary operation. Present for a rotary one even when
   * the pool chose serial execution, because "eight workers were requested and
   * one fitted the budget" is the fact a benchmark or a fallback report needs.
   */
  rotary?: RotaryPoolReport
}

/**
 * What the coordinator observed about the angle pool (#1115 p-d3).
 *
 * `batches` counts batches dispatched to workers, so `batches > 0` is evidence
 * that angle workers really sampled and answered rather than merely started.
 */
export interface RotaryPoolReport {
  readonly mode: 'serial' | 'parallel'
  readonly workers: number
  readonly batches: number
  readonly fallback: 'none' | 'startup'
}

/**
 * The generation worker asks the main thread to create one angle worker
 * (#1115 p-d3), carrying one end of a `MessageChannel` the coordinator made.
 *
 * The port travels **inside the message**, not merely in the transfer list, so
 * a browser main thread and a Node `worker_threads` test harness read it the
 * same way (`event.data.port`). The main thread creates the worker and
 * transfers the port into it; from then on the angle worker and the coordinator
 * talk directly, and no mesh data crosses the main thread.
 */
export interface RotaryWorkerRequestMessage {
  kind: 'rotaryWorker'
  /**
   * A **generation-unique** slot id, not the pool's worker index.
   *
   * Worker indices restart at 0 with every pool, and a superseded pool's
   * releases are posted while its successor is already asking for workers
   * (`pool.dispose()` awaits each termination). Keying the main thread's map by
   * index let an old pool's release stop the new pool's worker — a real
   * collision this suite caught. The slot id is minted by the coordinator and
   * never reused, so a release can only ever name its own worker.
   */
  slot: number
  port: MessagePort
}

/**
 * The coordinator has stopped using one angle worker, or all of them: a batch
 * was cancelled, the pool degraded to serial, or the operation finished.
 */
export interface RotaryReleaseMessage {
  kind: 'rotaryRelease'
  /** The slot to stop. Unique for the life of the generation worker. */
  slot: number
}

export interface FailedMessage {
  kind: 'failed'
  identity: RequestIdentity
  failure: GenerationFailure
}

/**
 * A superseded rotary generation has finished (#1115 p-d3 fix 2).
 *
 * Cancellation is only real if the cancelled computation reaches its end: its
 * angle batch is rejected by `pool.dispose()`, the async driver unwinds, and the
 * operation's prepared geometry is released. Until that happens the worker is
 * still holding one cancelled operation's data while the next one runs.
 *
 * Posted for a **superseded** generation only, and only for rotary ones (every
 * other kind is synchronous, so it cannot be cancelled mid-flight). It never
 * carries a result and never settles a request — the request it names was
 * settled as cancelled by the main thread when its successor was sent; this
 * message is the proof that the worker's half stopped.
 */
export interface RotaryCancelledMessage {
  kind: 'rotaryCancelled'
  identity: RequestIdentity
}

export type WorkerToMain =
  | ReadyMessage
  | SnapshotReadyMessage
  | ProgressMessage
  | CompletedMessage
  | FailedMessage
  | RotaryWorkerRequestMessage
  | RotaryReleaseMessage
  | RotaryCancelledMessage

// ── Main → worker ────────────────────────────────────────────────────

export interface LoadSnapshotMessage {
  kind: 'loadSnapshot'
  documentKey: number
  snapshotId: number
  /**
   * The full captured project.
   *
   * Deliberately not a projection. An improvised field whitelist risks omitting
   * a dependency some generator reads — resolution, text layout and imported
   * meshes between them touch most of the document — and a toolpath generated
   * from a project missing a field it needed is a wrong program, not a slow
   * one. Measure the clone cost first; narrowing it is an amendment with
   * evidence, not something to slip in while wiring the transport.
   */
  project: Project
}

export interface GenerateMessage {
  kind: 'generate'
  identity: RequestIdentity
  /**
   * The operation is resolved from the installed snapshot by
   * `identity.operationId` — it is **not** sent alongside. A separately cloned
   * copy could disagree with `project.operations`, and then which one the
   * worker generated from would depend on which the code happened to read.
   *
   * `rotary` is the machine's parallelism answer for the angle pool (#1115
   * p-d3). The pool's worker count is `min(angles, 8, max(1, parallelism - 2))`,
   * so that number has to reach the coordinator; omitted, or unknown to the
   * main thread, the operation runs serially — a pool that guesses can create
   * more workers than the machine can hold.
   */
  rotary?: { availableParallelism?: number }
}

/**
 * The main thread could not create an angle worker, or the one it created
 * failed before or while it sampled (#1115 p-d3).
 *
 * A failure rather than a reply on the angle port: before the worker exists
 * there is nothing on the other end of that port, and after it dies its end is
 * closed. The coordinator turns this into the pool's setup-failure signal, so
 * the batch reruns serially and the operation still generates.
 */
export interface RotaryWorkerFailedMessage {
  kind: 'rotaryWorkerFailed'
  slot: number
  message: string
}

export type MainToWorker = LoadSnapshotMessage | GenerateMessage | RotaryWorkerFailedMessage

// ── Validation ───────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Structural check on a request identity. Every field must be present and sane. */
export function isRequestIdentity(value: unknown): value is RequestIdentity {
  if (!isRecord(value)) return false
  return isFiniteNumber(value.documentKey)
    && isFiniteNumber(value.workerEpoch)
    && isFiniteNumber(value.requestId)
    && isFiniteNumber(value.snapshotId)
    && typeof value.operationId === 'string'
    && value.operationId.length > 0
    && typeof value.traceMode === 'boolean'
}

/** True when two identities name the same computation in every field. */
export function identityEquals(a: RequestIdentity, b: RequestIdentity): boolean {
  return a.documentKey === b.documentKey
    && a.workerEpoch === b.workerEpoch
    && a.requestId === b.requestId
    && a.snapshotId === b.snapshotId
    && a.operationId === b.operationId
    && a.traceMode === b.traceMode
}

/**
 * Shape check on a returned toolpath. Deliberately shallow: it proves the
 * envelope survived transport with its required fields, and does not re-derive
 * a second numerical model of what a toolpath is. Full-value fidelity is
 * covered by the parity corpus round-trip, which compares real results rather
 * than a handwritten schema.
 */
export function isToolpathResultShape(value: unknown): value is ToolpathResult {
  if (!isRecord(value)) return false
  return typeof value.operationId === 'string'
    && Array.isArray(value.moves)
    && Array.isArray(value.warnings)
    && (value.bounds === null || isRecord(value.bounds))
}

/** The same check for a transported result, whose moves arrive packed. */
export function isTransportedResultShape(value: unknown): value is TransportedResult {
  if (!isRecord(value)) return false
  return typeof value.operationId === 'string'
    && isPackedMoves(value.packedMoves)
    && Array.isArray(value.warnings)
    && (value.bounds === null || isRecord(value.bounds))
}

export function isWorkerToMain(value: unknown): value is WorkerToMain {
  if (!isRecord(value)) return false
  switch (value.kind) {
    case 'ready':
      return isFiniteNumber(value.protocolVersion) && isFiniteNumber(value.workerEpoch)
    case 'snapshotReady':
      return isFiniteNumber(value.documentKey) && isFiniteNumber(value.snapshotId)
    case 'progress':
      return isRequestIdentity(value.identity) && typeof value.stage === 'string'
    case 'completed':
      return isRequestIdentity(value.identity)
        && isTransportedResultShape(value.result)
        && (value.raw === null || isTransportedResultShape(value.raw))
        && (value.rotary === undefined || isRotaryPoolReport(value.rotary))
    case 'failed':
      return isRequestIdentity(value.identity)
        && isRecord(value.failure)
        && typeof value.failure.category === 'string'
        && typeof value.failure.message === 'string'
    case 'rotaryWorker':
      // A duck check rather than `instanceof MessagePort`: the class the main
      // thread sees is its runtime's own, and the pool's port is the one thing
      // here that cannot be revalidated by shape beyond "it can post".
      return isFiniteNumber(value.slot)
        && isRecord(value.port)
        && typeof (value.port as { postMessage?: unknown }).postMessage === 'function'
    case 'rotaryRelease':
      return isFiniteNumber(value.slot)
    case 'rotaryCancelled':
      return isRequestIdentity(value.identity)
    default:
      return false
  }
}

/** A completed message's pool report, or `undefined` when it carried none. */
export function isRotaryPoolReport(value: unknown): value is RotaryPoolReport {
  if (!isRecord(value)) return false
  return (value.mode === 'serial' || value.mode === 'parallel')
    && isFiniteNumber(value.workers)
    && isFiniteNumber(value.batches)
    && (value.fallback === 'none' || value.fallback === 'startup')
}

export function isMainToWorker(value: unknown): value is MainToWorker {
  if (!isRecord(value)) return false
  switch (value.kind) {
    case 'loadSnapshot':
      return isFiniteNumber(value.documentKey)
        && isFiniteNumber(value.snapshotId)
        && isRecord(value.project)
        && Array.isArray((value.project as Partial<Project>).operations)
    case 'generate': {
      if (!isRequestIdentity(value.identity)) return false
      if (value.rotary === undefined) return true
      if (!isRecord(value.rotary)) return false
      return value.rotary.availableParallelism === undefined
        || isFiniteNumber(value.rotary.availableParallelism)
    }
    case 'rotaryWorkerFailed':
      return isFiniteNumber(value.slot) && typeof value.message === 'string'
    default:
      return false
  }
}

/**
 * A `completed` message whose trace flag disagrees with what it carries is
 * rejected rather than tolerated: it means the two sides disagree about what
 * was asked for, and silently accepting it would hand a debug consumer a
 * missing raw path or a preview consumer one it never wanted.
 */
export function completedMatchesTraceMode(message: CompletedMessage): boolean {
  return message.identity.traceMode ? message.raw !== null : message.raw === null
}

/** Find the operation a request names inside the installed snapshot. */
export function resolveOperation(project: Project, operationId: string): Operation | null {
  return project.operations.find((operation) => operation.id === operationId) ?? null
}
