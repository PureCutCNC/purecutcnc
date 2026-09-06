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
 * The generation service (issue #675): one queue, one authoritative cache, one
 * executor, and the rules about what may become a current result.
 *
 * Framework-independent on purpose. React subscribes to immutable status
 * snapshots; it does not own any of this. The worker owns none of it either —
 * it returns moves and nothing else, because the cache is keyed on main-thread
 * object identity that does not survive a structured clone.
 *
 * ## The rule that matters
 *
 * Generation is now asynchronous, so between submitting a job and receiving its
 * answer the document can change, be replaced, or be closed. A returned result
 * is therefore never attached to whatever project happens to be current when it
 * arrives. It is attached to the inputs captured at *submission*, and installed
 * only when all of these still hold:
 *
 *  1. its identity still matches the active job (epoch included, so a message
 *     from a terminated worker cannot land);
 *  2. its document key is still current — opening even the same file again ends
 *     the previous session;
 *  3. it has not been cancelled or superseded, and some consumer still wants it;
 *  4. for live consumers, the operation still exists and the captured inputs are
 *     still valid against the latest project.
 *
 * Failing any of these settles the request as `superseded` rather than
 * installing a result that describes a document nobody is looking at.
 */

import type { ToolpathResult } from '../../engine/toolpaths'
import type { Operation, Project } from '../../types/project'
import {
  captureCacheInputs,
  cacheInputsValid,
  type ToolpathCacheEntry,
  type ToolpathCacheInputs,
} from './cacheInputs'
import { createInlineExecutor } from './inlineExecutor'
import { createWorkerExecutor, type WorkerFactory } from './workerExecutor'
import type { GenerationExecutor } from './executor'
import type {
  ExecutorKind,
  GenerationFailure,
  GenerationOutcome,
  GenerationPurpose,
  GenerationStage,
  GenerationStatusSnapshot,
  OperationGenerationStatus,
  RequestIdentity,
} from './types'

/** The main-thread facts a job is submitted against. */
export interface GenerationContext {
  project: Project
  /** The store's `projectKey`. Changes on new/load/open. */
  documentKey: number
}

export interface RequestOptions {
  purpose: GenerationPurpose
  /** Ask for the pre-optimization path too. Trace and non-trace requests are never coalesced. */
  trace?: boolean
  /** Drop this consumer's interest. Does not cancel a job another consumer still needs. */
  signal?: AbortSignal
}

interface Consumer {
  purpose: GenerationPurpose
  settle: (outcome: GenerationOutcome) => void
  detach: () => void
}

type Priority = 'foreground' | 'automatic'

interface Job {
  identity: RequestIdentity
  /** Captured at submission from the main-thread project — the result's provenance. */
  inputs: ToolpathCacheInputs
  project: Project
  operationId: string
  traceMode: boolean
  priority: Priority
  /** FIFO within a priority class. */
  seq: number
  consumers: Set<Consumer>
}

export interface ServiceOptions {
  /** Reads the latest project/documentKey at completion time, without waiting for a React effect. */
  getCurrentContext: () => GenerationContext
  executor?: ExecutorKind
  workerFactory?: WorkerFactory
  /** Test seam: substitute the whole executor. */
  createExecutor?: (kind: ExecutorKind, epoch: number) => GenerationExecutor
}

export interface ToolpathGenerationService {
  setAutomaticDemand(context: GenerationContext, orderedOperationIds: string[], deferred: boolean): void
  request(context: GenerationContext, operationId: string, options: RequestOptions): Promise<GenerationOutcome>
  /** Cache-validated read. Never starts work, never returns a stale path. */
  peekCurrent(context: GenerationContext, operationId: string): ToolpathResult | null
  /**
   * The last result for an operation whether or not it is still valid.
   * **Display only** — named separately from `peekCurrent` so an export,
   * simulation, booklet or debug path cannot reach a stale toolpath by accident.
   */
  peekDisplayOnly(operationId: string): ToolpathResult | null
  stopAutomaticGeneration(): void
  resumeAutomaticGeneration(): void
  retryAfterFailure(): void
  setExecutorKind(kind: ExecutorKind): void
  subscribe(listener: () => void): () => void
  getSnapshot(): GenerationStatusSnapshot
  dispose(): void
}

export function createToolpathGenerationService(options: ServiceOptions): ToolpathGenerationService {
  const cache = new Map<string, ToolpathCacheEntry>()
  const queue: Job[] = []
  const listeners = new Set<() => void>()
  const statuses = new Map<string, OperationGenerationStatus>()
  /**
   * Operations the preview currently wants. Automatic jobs carry no consumer —
   * nobody is awaiting a Promise for them — so this set *is* their demand, and
   * without it they would be indistinguishable from abandoned work.
   */
  const automaticDemand = new Set<string>()

  let executorKind: ExecutorKind = options.executor ?? 'inline'
  let epoch = 0
  let executor: GenerationExecutor | null = null
  let activeJob: Job | null = null
  let activeStage: GenerationStage | null = null
  let executorFailure: GenerationFailure | null = null
  let automaticPaused = false
  let disposed = false
  let nextRequestId = 1
  let nextSeq = 1

  // Snapshot identity tracks the project *reference*, not its contents: it only
  // tells the worker which captured project to resolve an operation from, so a
  // new reference is a new snapshot and that is all it has to mean.
  let snapshotProject: Project | null = null
  let snapshotId = 0

  let snapshot: GenerationStatusSnapshot = buildSnapshot()

  function buildSnapshot(): GenerationStatusSnapshot {
    return {
      operations: new Map(statuses),
      activeOperationId: activeJob?.operationId ?? null,
      activeStage,
      queuedCount: queue.length,
      automaticPaused,
      executorFailure,
      executorKind,
    }
  }

  function emit(): void {
    snapshot = buildSnapshot()
    for (const listener of listeners) listener()
  }

  function setStatus(operationId: string, status: OperationGenerationStatus): void {
    statuses.set(operationId, status)
  }

  function snapshotIdFor(project: Project): number {
    if (snapshotProject !== project) {
      snapshotProject = project
      snapshotId += 1
    }
    return snapshotId
  }

  function ensureExecutor(): GenerationExecutor {
    if (!executor) {
      executor = options.createExecutor
        ? options.createExecutor(executorKind, epoch)
        : executorKind === 'worker'
          ? createWorkerExecutor(epoch, options.workerFactory)
          : createInlineExecutor(epoch)
    }
    return executor
  }

  /** End the current executor epoch. In-flight work settles as cancelled. */
  function replaceExecutor(): void {
    executor?.terminate()
    executor?.dispose()
    executor = null
    epoch += 1
  }

  function settleJob(job: Job, outcome: GenerationOutcome): void {
    for (const consumer of job.consumers) {
      consumer.detach()
      consumer.settle(outcome)
    }
    job.consumers.clear()
  }

  function removeQueued(job: Job): void {
    const index = queue.indexOf(job)
    if (index >= 0) queue.splice(index, 1)
  }

  /**
   * Is this job still worth running? A job with no consumers is not, and
   * neither is one whose captured inputs no longer describe the live project.
   */
  function jobStillWanted(job: Job): boolean {
    const demanded = job.consumers.size > 0
      || (job.priority === 'automatic' && automaticDemand.has(job.operationId))
    if (!demanded) return false
    const current = options.getCurrentContext()
    if (current.documentKey !== job.identity.documentKey) return false
    const operation = current.project.operations.find((candidate) => candidate.id === job.operationId)
    if (!operation) return false
    return cacheInputsValid(job.inputs, operation, current.project)
  }

  function pump(): void {
    if (disposed || activeJob) return

    // Foreground first, then FIFO. An explicit export or booklet request should
    // not wait behind a queue of preview work the user is not looking at, but
    // ordering within a class stays submission order so results are predictable.
    let bestIndex = -1
    for (let index = 0; index < queue.length; index += 1) {
      const candidate = queue[index]
      // Dropped here rather than at edit time: demand changes constantly, and
      // deciding once, at dispatch, is what keeps "is this still worth doing"
      // in a single place.
      if (!jobStillWanted(candidate)) {
        queue.splice(index, 1)
        index -= 1
        settleJob(candidate, { status: 'superseded' })
        continue
      }
      if (bestIndex < 0) { bestIndex = index; continue }
      const best = queue[bestIndex]
      if (candidate.priority === 'foreground' && best.priority !== 'foreground') bestIndex = index
      else if (candidate.priority === best.priority && candidate.seq < best.seq) bestIndex = index
    }
    if (bestIndex < 0) {
      activeStage = null
      return
    }

    const job = queue.splice(bestIndex, 1)[0]
    activeJob = job
    setStatus(job.operationId, 'running')
    activeStage = 'loading-inputs'
    emit()

    void runJob(job)
  }

  async function runJob(job: Job): Promise<void> {
    const runner = ensureExecutor()
    const outcome = await runner.run(
      { identity: job.identity, project: job.project },
      (stage) => {
        if (activeJob === job) {
          activeStage = stage
          emit()
        }
      },
    )

    // The job was superseded, cancelled or the executor replaced while it ran.
    if (activeJob !== job) {
      settleJob(job, { status: 'superseded' })
      return
    }
    activeJob = null
    activeStage = null

    if (outcome.status === 'completed') {
      const current = options.getCurrentContext()
      const stillCurrent = current.documentKey === job.identity.documentKey
      const operation = stillCurrent
        ? current.project.operations.find((candidate) => candidate.id === job.operationId) ?? null
        : null
      const valid = operation !== null && cacheInputsValid(job.inputs, operation, current.project)

      if (!valid) {
        // The answer is correct for the question that was asked, but the
        // question has changed. It is never attached to the project that
        // happens to be current now.
        setStatus(job.operationId, 'stale')
        settleJob(job, { status: 'superseded' })
      } else if (job.consumers.size === 0) {
        // Nobody is waiting any more, but the work is done and provably valid,
        // so keep it: throwing it away would mean regenerating it on the next
        // glance at the same operation.
        cache.set(job.operationId, { ...job.inputs, result: outcome.result })
        setStatus(job.operationId, 'ready')
      } else {
        cache.set(job.operationId, { ...job.inputs, result: outcome.result })
        setStatus(job.operationId, 'ready')
        settleJob(job, outcome)
      }
    } else if (outcome.status === 'cancelled') {
      setStatus(job.operationId, 'cancelled')
      settleJob(job, outcome)
    } else if (outcome.status === 'superseded') {
      setStatus(job.operationId, 'stale')
      settleJob(job, outcome)
    } else {
      // A failure stays a failure until a new relevant request or an explicit
      // Retry. Re-queueing on staleness alone is how a broken worker becomes an
      // infinite restart loop.
      setStatus(job.operationId, 'failed')
      if (outcome.failure.category !== 'computation') {
        executorFailure = outcome.failure
        replaceExecutor()
      }
      settleJob(job, outcome)
    }

    emit()
    pump()
  }

  /** Find a queued or active job this request can share. */
  function findCoalescible(operationId: string, traceMode: boolean, context: GenerationContext): Job | null {
    const operation = context.project.operations.find((candidate) => candidate.id === operationId)
    if (!operation) return null
    const candidates = activeJob ? [activeJob, ...queue] : queue
    for (const job of candidates) {
      if (job.operationId !== operationId) continue
      // A preview job cannot answer a debug request: it was not asked to keep
      // the raw path, so it has nothing to hand back.
      if (job.traceMode !== traceMode) continue
      if (job.identity.documentKey !== context.documentKey) continue
      if (!cacheInputsValid(job.inputs, operation, context.project)) continue
      return job
    }
    return null
  }

  function attach(job: Job, options_: RequestOptions, settle: (outcome: GenerationOutcome) => void): void {
    const signal = options_.signal
    const consumer: Consumer = {
      purpose: options_.purpose,
      settle,
      detach: () => {
        if (signal && onAbort) signal.removeEventListener('abort', onAbort)
      },
    }
    const onAbort = signal
      ? (): void => {
          if (!job.consumers.has(consumer)) return
          job.consumers.delete(consumer)
          consumer.detach()
          consumer.settle({ status: 'cancelled' })
          // Cancelling one consumer never kills a job another still needs.
          if (jobStillWanted(job)) return
          if (activeJob === job && executor?.supportsHardCancellation) {
            activeJob = null
            replaceExecutor()
            setStatus(job.operationId, 'cancelled')
            emit()
            pump()
          } else {
            removeQueued(job)
            emit()
          }
        }
      : null
    if (signal && onAbort) {
      if (signal.aborted) {
        settle({ status: 'cancelled' })
        return
      }
      signal.addEventListener('abort', onAbort)
    }
    job.consumers.add(consumer)
  }

  function submit(
    context: GenerationContext,
    operation: Operation,
    priority: Priority,
    traceMode: boolean,
  ): Job {
    const identity: RequestIdentity = {
      documentKey: context.documentKey,
      workerEpoch: epoch,
      requestId: nextRequestId,
      snapshotId: snapshotIdFor(context.project),
      operationId: operation.id,
      traceMode,
    }
    nextRequestId += 1
    const job: Job = {
      identity,
      inputs: captureCacheInputs(context.project, operation),
      project: context.project,
      operationId: operation.id,
      traceMode,
      priority,
      seq: nextSeq,
      consumers: new Set(),
    }
    nextSeq += 1
    queue.push(job)
    setStatus(operation.id, 'queued')
    return job
  }

  return {
    setAutomaticDemand(context, orderedOperationIds, deferred): void {
      if (disposed) return

      // While a gesture is open the store rewrites `project` on every pointer
      // move. Queueing per frame would restart generation mid-drag, so demand
      // is simply not accepted until the gesture commits — one regeneration for
      // one gesture, which is what the shipped deferral did.
      if (deferred || automaticPaused) return

      const wanted = new Set(orderedOperationIds)
      automaticDemand.clear()
      for (const operationId of orderedOperationIds) automaticDemand.add(operationId)
      // Obsolete automatic work is removed rather than left to run: it is no
      // longer demanded by anything.
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        const job = queue[index]
        if (job.priority === 'automatic' && !wanted.has(job.operationId)) {
          queue.splice(index, 1)
          settleJob(job, { status: 'superseded' })
        }
      }

      for (const operationId of orderedOperationIds) {
        const operation = context.project.operations.find((candidate) => candidate.id === operationId)
        if (!operation) continue

        const entry = cache.get(operationId)
        if (entry && cacheInputsValid(entry, operation, context.project)) {
          setStatus(operationId, 'ready')
          continue
        }
        if (findCoalescible(operationId, false, context)) continue
        setStatus(operationId, entry ? 'stale' : 'queued')
        submit(context, operation, 'automatic', false)
      }
      emit()
      pump()
    },

    request(context, operationId, requestOptions): Promise<GenerationOutcome> {
      if (disposed) {
        return Promise.resolve({
          status: 'failed',
          failure: { category: 'computation', message: 'generation service disposed' },
        })
      }
      const traceMode = requestOptions.trace === true
      const operation = context.project.operations.find((candidate) => candidate.id === operationId)
      if (!operation) {
        return Promise.resolve({
          status: 'failed',
          failure: { category: 'computation', message: 'no such operation', detail: operationId },
        })
      }

      // A cache hit still returns a Promise. Callers get one shape regardless,
      // so none of them grows a synchronous fast path that later has to be
      // unpicked.
      if (!traceMode) {
        const entry = cache.get(operationId)
        if (entry && cacheInputsValid(entry, operation, context.project)) {
          setStatus(operationId, 'ready')
          return Promise.resolve({ status: 'completed', result: entry.result, raw: null })
        }
      }

      return new Promise<GenerationOutcome>((resolve) => {
        const shared = findCoalescible(operationId, traceMode, context)
        const job = shared ?? submit(context, operation, 'foreground', traceMode)
        // An explicit request promotes work already queued as background
        // preview: the user is now waiting on it.
        if (shared && shared.priority === 'automatic') shared.priority = 'foreground'
        attach(job, requestOptions, resolve)
        emit()
        pump()
      })
    },

    peekCurrent(context, operationId): ToolpathResult | null {
      const entry = cache.get(operationId)
      if (!entry) return null
      const operation = context.project.operations.find((candidate) => candidate.id === operationId)
      if (!operation) return null
      return cacheInputsValid(entry, operation, context.project) ? entry.result : null
    },

    peekDisplayOnly(operationId): ToolpathResult | null {
      return cache.get(operationId)?.result ?? null
    },

    stopAutomaticGeneration(): void {
      automaticPaused = true
      automaticDemand.clear()
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        const job = queue[index]
        if (job.priority !== 'automatic') continue
        queue.splice(index, 1)
        setStatus(job.operationId, 'cancelled')
        settleJob(job, { status: 'cancelled' })
      }
      // Stop pauses *automatic* work. Foreground work the user explicitly
      // asked for keeps running, and the UI must keep showing it as running
      // rather than announce that everything has stopped.
      if (activeJob && activeJob.priority === 'automatic') {
        const job = activeJob
        activeJob = null
        activeStage = null
        setStatus(job.operationId, 'cancelled')
        if (executor?.supportsHardCancellation) replaceExecutor()
        else executor?.terminate()
        settleJob(job, { status: 'cancelled' })
      }
      emit()
      pump()
    },

    resumeAutomaticGeneration(): void {
      automaticPaused = false
      emit()
    },

    retryAfterFailure(): void {
      executorFailure = null
      for (const [operationId, status] of statuses) {
        if (status === 'failed' || status === 'cancelled') statuses.set(operationId, 'stale')
      }
      emit()
    },

    setExecutorKind(kind): void {
      if (kind === executorKind) return
      executorKind = kind
      // Switching backends ends the epoch, cancels consumers and clears the
      // result cache, so recovery starts from an unambiguous baseline. It does
      // not touch the project.
      if (activeJob) {
        const job = activeJob
        activeJob = null
        settleJob(job, { status: 'cancelled' })
      }
      for (const job of queue.splice(0)) settleJob(job, { status: 'cancelled' })
      automaticDemand.clear()
      replaceExecutor()
      cache.clear()
      statuses.clear()
      executorFailure = null
      emit()
    },

    subscribe(listener): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },

    getSnapshot(): GenerationStatusSnapshot {
      return snapshot
    },

    dispose(): void {
      disposed = true
      if (activeJob) {
        const job = activeJob
        activeJob = null
        settleJob(job, { status: 'cancelled' })
      }
      for (const job of queue.splice(0)) settleJob(job, { status: 'cancelled' })
      executor?.terminate()
      executor?.dispose()
      executor = null
      automaticDemand.clear()
      cache.clear()
      statuses.clear()
      listeners.clear()
    },
  }
}
