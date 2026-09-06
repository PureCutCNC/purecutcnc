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
import type { GenerationFailure, GenerationStage, RequestIdentity } from './types'

/**
 * Bumped whenever a message shape changes. The handshake compares it, so a
 * stale worker chunk left in a browser cache after a deploy is rejected at
 * startup rather than misread halfway through a job.
 */
export const TOOLPATH_PROTOCOL_VERSION = 1

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
  result: ToolpathResult
  raw: ToolpathResult | null
}

export interface FailedMessage {
  kind: 'failed'
  identity: RequestIdentity
  failure: GenerationFailure
}

export type WorkerToMain =
  | ReadyMessage
  | SnapshotReadyMessage
  | ProgressMessage
  | CompletedMessage
  | FailedMessage

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
   */
}

export type MainToWorker = LoadSnapshotMessage | GenerateMessage

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
        && isToolpathResultShape(value.result)
        && (value.raw === null || isToolpathResultShape(value.raw))
    case 'failed':
      return isRequestIdentity(value.identity)
        && isRecord(value.failure)
        && typeof value.failure.category === 'string'
        && typeof value.failure.message === 'string'
    default:
      return false
  }
}

export function isMainToWorker(value: unknown): value is MainToWorker {
  if (!isRecord(value)) return false
  switch (value.kind) {
    case 'loadSnapshot':
      return isFiniteNumber(value.documentKey)
        && isFiniteNumber(value.snapshotId)
        && isRecord(value.project)
        && Array.isArray((value.project as Partial<Project>).operations)
    case 'generate':
      return isRequestIdentity(value.identity)
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
