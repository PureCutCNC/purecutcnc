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
 * The worker backend's main-thread half (issue #675).
 *
 * Owns one worker, one installed snapshot and at most one in-flight request.
 * The snapshot is re-sent only when the request names a different one, so a
 * burst of edits to the same document does not re-clone the project per
 * operation.
 *
 * **Cancellation is `terminate()`, not a message.** A worker inside synchronous
 * geometry code cannot reach its own event loop, so a `cancel` message would be
 * processed only after the work it was meant to stop had finished. Killing the
 * thread is what makes Stop real. The cost is that the next request pays for a
 * fresh worker and a fresh snapshot, which is why the service creates one
 * lazily rather than eagerly after a stop.
 */

import {
  TOOLPATH_PROTOCOL_VERSION,
  isWorkerToMain,
  identityEquals,
  completedMatchesTraceMode,
  type LoadSnapshotMessage,
  type GenerateMessage,
} from './protocol'
import { unpackResult } from './moveTransport'
import type { ExecutorRequest, GenerationExecutor } from './executor'
import type { GenerationFailure, GenerationOutcome, GenerationStage } from './types'

/** How long to wait for the worker's handshake before declaring it dead. */
const HANDSHAKE_TIMEOUT_MS = 10_000

/**
 * Injected so tests can drive a fake worker. Production passes the real
 * constructor below; nothing else may substitute one.
 */
export interface WorkerLike {
  postMessage(message: unknown): void
  terminate(): void
  addEventListener(type: 'message', handler: (event: MessageEvent<unknown>) => void): void
  addEventListener(type: 'error', handler: (event: unknown) => void): void
  addEventListener(type: 'messageerror', handler: (event: unknown) => void): void
}

export type WorkerFactory = () => WorkerLike

/**
 * The production factory.
 *
 * The `new URL(..., import.meta.url)` form is required, not stylistic: it is
 * the shape the bundler statically recognises, which is what makes the worker
 * a separately built, content-hashed asset resolved correctly under the app's
 * relative `base` — a hardcoded dev URL or a root-relative path breaks the
 * packaged desktop build and static hosting under a nested path.
 */
export function createDefaultWorker(): WorkerLike {
  return new Worker(new URL('./toolpath.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike
}

interface PendingRequest {
  identity: ExecutorRequest['identity']
  settle: (outcome: GenerationOutcome) => void
  onStage?: (stage: GenerationStage) => void
}

export function createWorkerExecutor(epoch: number, factory: WorkerFactory = createDefaultWorker): GenerationExecutor {
  let worker: WorkerLike | null = null
  let disposed = false
  let pending: PendingRequest | null = null
  let installedSnapshotId: number | null = null
  let installedDocumentKey: number | null = null
  let handshake: Promise<GenerationFailure | null> | null = null

  /** Settle whatever is in flight and forget it. Called exactly once per request. */
  function settlePending(outcome: GenerationOutcome): void {
    const request = pending
    pending = null
    request?.settle(outcome)
  }

  function destroyWorker(): void {
    worker?.terminate()
    worker = null
    handshake = null
    // The next worker starts with nothing installed. Forgetting this is how a
    // `generate` gets sent to a fresh worker that has no snapshot.
    installedSnapshotId = null
    installedDocumentKey = null
  }

  function onMessage(event: MessageEvent<unknown>): void {
    const message = event.data
    if (!isWorkerToMain(message)) {
      if (pending) {
        settlePending({
          status: 'failed',
          failure: { category: 'protocol', message: 'worker sent a message that failed validation' },
        })
      }
      return
    }

    if (message.kind === 'ready' || message.kind === 'snapshotReady') return

    // Late messages from a worker that has since been replaced carry a stale
    // epoch. Matching on request id alone would accept them, because ids
    // restart with each executor.
    if (!pending || !identityEquals(message.identity, pending.identity)) return

    if (message.kind === 'progress') {
      pending.onStage?.(message.stage)
      return
    }
    if (message.kind === 'failed') {
      settlePending({ status: 'failed', failure: message.failure })
      return
    }
    if (message.kind === 'completed') {
      if (!completedMatchesTraceMode(message)) {
        settlePending({
          status: 'failed',
          failure: {
            category: 'protocol',
            message: 'completed result disagrees with the requested trace mode',
          },
        })
        return
      }
      // Unpacked on arrival so nothing above this layer knows moves ever
      // travelled packed; the service and every consumer still see a plain
      // ToolpathResult.
      settlePending({
        status: 'completed',
        result: unpackResult(message.result),
        raw: message.raw ? unpackResult(message.raw) : null,
      })
    }
  }

  function onWorkerError(): void {
    // The worker faulted. It cannot be trusted to answer anything else, so it
    // is destroyed; the next request builds a clean one rather than retrying
    // into a broken realm.
    destroyWorker()
    settlePending({
      status: 'failed',
      failure: { category: 'worker-crash', message: 'the generation worker stopped unexpectedly' },
    })
  }

  /** Build the worker and wait for its handshake. Resolves to a failure, or null on success. */
  function ensureWorker(): Promise<GenerationFailure | null> {
    if (handshake) return handshake
    handshake = new Promise<GenerationFailure | null>((resolve) => {
      let settled = false
      const finish = (failure: GenerationFailure | null): void => {
        if (settled) return
        settled = true
        resolve(failure)
      }

      let created: WorkerLike
      try {
        created = factory()
      } catch (error: unknown) {
        finish({
          category: 'worker-startup',
          message: 'the generation worker could not be created',
          detail: error instanceof Error ? error.message : String(error),
        })
        return
      }
      worker = created

      // A startup-only budget. Computation has no elapsed-time kill: a slow
      // operation is not a broken one, and a worker that is quiet because it is
      // busy must stay stoppable rather than be killed on a timer.
      const timer = setTimeout(() => {
        finish({ category: 'worker-startup', message: 'the generation worker did not report ready' })
      }, HANDSHAKE_TIMEOUT_MS)

      created.addEventListener('message', (event: MessageEvent<unknown>) => {
        const message = event.data
        if (!settled) {
          if (isWorkerToMain(message) && message.kind === 'ready') {
            clearTimeout(timer)
            finish(
              message.protocolVersion === TOOLPATH_PROTOCOL_VERSION
                ? null
                : {
                    category: 'protocol',
                    message: 'the generation worker speaks a different protocol version',
                    detail: `expected ${TOOLPATH_PROTOCOL_VERSION}, got ${message.protocolVersion}`,
                  },
            )
          }
          return
        }
        onMessage(event)
      })
      created.addEventListener('error', () => {
        clearTimeout(timer)
        finish({ category: 'worker-startup', message: 'the generation worker failed to start' })
        onWorkerError()
      })
      created.addEventListener('messageerror', () => {
        if (pending) {
          settlePending({
            status: 'failed',
            failure: { category: 'clone', message: 'a worker message could not be deserialised' },
          })
        }
      })
    })
    return handshake
  }

  return {
    kind: 'worker',
    epoch,
    supportsHardCancellation: true,

    async run(request: ExecutorRequest, onStage?: (stage: GenerationStage) => void): Promise<GenerationOutcome> {
      if (disposed) {
        return { status: 'failed', failure: { category: 'worker-crash', message: 'executor disposed' } }
      }

      onStage?.('loading-inputs')
      const failure = await ensureWorker()
      if (failure) return { status: 'failed', failure }
      const active = worker
      if (!active) return { status: 'cancelled' }

      return new Promise<GenerationOutcome>((resolve) => {
        pending = { identity: request.identity, settle: resolve, onStage }

        try {
          if (
            installedSnapshotId !== request.identity.snapshotId
            || installedDocumentKey !== request.identity.documentKey
          ) {
            const load: LoadSnapshotMessage = {
              kind: 'loadSnapshot',
              documentKey: request.identity.documentKey,
              snapshotId: request.identity.snapshotId,
              project: request.project,
            }
            active.postMessage(load)
            installedSnapshotId = request.identity.snapshotId
            installedDocumentKey = request.identity.documentKey
          }
          const generate: GenerateMessage = { kind: 'generate', identity: request.identity }
          active.postMessage(generate)
        } catch (error: unknown) {
          // The project could not be structured-cloned. That is a hard failure,
          // never a silent fallback to inline computation: the user has to know
          // the worker did not run this.
          installedSnapshotId = null
          installedDocumentKey = null
          settlePending({
            status: 'failed',
            failure: {
              category: 'clone',
              message: 'the project could not be sent to the generation worker',
              detail: error instanceof Error ? error.message : String(error),
            },
          })
        }
      })
    },

    terminate(): void {
      destroyWorker()
      settlePending({ status: 'cancelled' })
    },

    dispose(): void {
      disposed = true
      destroyWorker()
      settlePending({ status: 'cancelled' })
    },
  }
}
