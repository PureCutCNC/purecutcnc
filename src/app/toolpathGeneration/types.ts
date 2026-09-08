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
 * Shared vocabulary for worker-backed generation (issue #675).
 *
 * The identity type here is the one thing every layer agrees on. A result is
 * only ever installed when the identity it came back with still matches an
 * active job, which is what stops a late answer to a superseded question from
 * becoming the current toolpath.
 */

import type { ToolpathResult } from '../../engine/toolpaths'

/** Who asked. Recorded so status can say what the app is waiting on. */
export type GenerationPurpose = 'preview' | 'export' | 'simulation' | 'booklet' | 'debug'

/**
 * The full identity of one computation. Every worker message carries it and
 * both ends check it.
 *
 * - `documentKey` is the store's existing `projectKey`. It changes on new/load/
 *   open, which is what ends a document session — opening the *same* file again
 *   still ends the old one, so a result in flight from before cannot land.
 * - `workerEpoch` changes whenever the executor is replaced (termination,
 *   fault, backend switch). Messages from a previous epoch are ignored rather
 *   than matched by request id, because ids restart with the executor.
 * - `snapshotId` names the immutable main-thread project the job was submitted
 *   against. It is *not* a cache key and not a hash of the project — the cache
 *   keeps using reference identity, and this only says which snapshot the
 *   worker should resolve the operation from.
 *
 * All of these are runtime-only monotonic numbers. None is ever serialised into
 * a `.camj` or undo history.
 */
export interface RequestIdentity {
  documentKey: number
  workerEpoch: number
  requestId: number
  snapshotId: number
  operationId: string
  traceMode: boolean
}

/** Why a computation failed, in terms a retry decision can be made from. */
export type FailureCategory =
  | 'worker-startup'
  | 'worker-crash'
  | 'protocol'
  | 'clone'
  | 'computation'

export interface GenerationFailure {
  category: FailureCategory
  message: string
  /** Serialisable extra context. Never an Error instance — it must survive postMessage. */
  detail?: string
}

/**
 * How a request ended. Exactly one of these settles each request, exactly once.
 *
 * `completed` with an empty path and warnings is a **successful engine result**,
 * not a failure: an operation that legitimately cuts nothing still completed.
 * Infrastructure failure is never encoded as an empty successful path, and
 * worker faults never join the CAM warning-code list.
 */
export type GenerationOutcome =
  | { status: 'completed'; result: ToolpathResult; raw: ToolpathResult | null }
  | { status: 'cancelled' }
  | { status: 'superseded' }
  | { status: 'failed'; failure: GenerationFailure }

/**
 * Per-operation state the UI renders. `stale` and `ready` both mean a path is
 * displayable; only `ready` means it is valid for export, simulation, booklet
 * or debug, which never accept a retained stale path.
 */
export type OperationGenerationStatus =
  | 'idle'
  | 'stale'
  | 'queued'
  | 'running'
  | 'ready'
  | 'cancelled'
  | 'failed'

/** A pipeline stage, reported as it is actually entered — never a synthetic percentage. */
export type GenerationStage = 'loading-inputs' | 'generating' | 'post-processing' | 'installing'

/** Immutable snapshot of service state. React subscribes to these. */
export interface GenerationStatusSnapshot {
  /** Operation id → status. */
  readonly operations: ReadonlyMap<string, OperationGenerationStatus>
  /** The operation currently being computed, if any. */
  readonly activeOperationId: string | null
  readonly activeStage: GenerationStage | null
  readonly queuedCount: number
  /** True while the user has paused automatic preview generation. */
  readonly automaticPaused: boolean
  /** Set when the executor itself faulted, so the UI can offer Retry. */
  readonly executorFailure: GenerationFailure | null
  readonly executorKind: ExecutorKind
}

export type ExecutorKind = 'inline' | 'worker'
