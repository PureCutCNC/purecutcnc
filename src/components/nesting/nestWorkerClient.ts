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
// Main-thread half of the nesting worker (issue #848). A nest of a hundred
// copies of a detailed part takes seconds (#844), so it never runs on the UI
// thread when a Worker is available. Cancellation is `terminate()`: the packer
// is synchronous and would never see a message.

import { improveNest, nest, requestFromJob, type NestJob, type NestResult } from '../../engine/nesting'
import type { NestWorkerRequest, NestWorkerResponse } from './nest.worker'

export class NestCancelledError extends Error {
  constructor() {
    super('Nesting was cancelled')
    this.name = 'NestCancelledError'
  }
}

export interface NestWorkerLike {
  postMessage(message: NestWorkerRequest): void
  terminate(): void
  onmessage: ((event: MessageEvent<NestWorkerResponse>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
}

export type NestWorkerFactory = () => NestWorkerLike | null

/** The bundled worker, or null where workers are unavailable. */
export function createDefaultNestWorker(): NestWorkerLike | null {
  if (typeof Worker === 'undefined') return null
  return new Worker(new URL('./nest.worker.ts', import.meta.url), { type: 'module' }) as unknown as NestWorkerLike
}

interface WorkerOptions {
  signal?: AbortSignal
  createWorker?: NestWorkerFactory
}

function startWorker(options: WorkerOptions): NestWorkerLike | null {
  try {
    return (options.createWorker ?? createDefaultNestWorker)()
  } catch {
    return null
  }
}

/**
 * Posts one request and settles on its first final message. `onMessage`
 * returns the value to resolve with, or undefined to keep listening. Every way
 * out terminates the worker.
 */
function converse<T>(
  worker: NestWorkerLike,
  request: NestWorkerRequest,
  signal: AbortSignal | undefined,
  onMessage: (response: NestWorkerResponse) => T | undefined,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const finish = (outcome: () => void) => {
      worker.terminate()
      signal?.removeEventListener('abort', onAbort)
      outcome()
    }
    const onAbort = () => finish(() => reject(new NestCancelledError()))
    signal?.addEventListener('abort', onAbort, { once: true })
    worker.onmessage = (event) => {
      const response = event.data
      if (response.type === 'error') {
        finish(() => reject(new Error(response.message)))
        return
      }
      let value: T | undefined
      try {
        value = onMessage(response)
      } catch (error: unknown) {
        finish(() => reject(error))
        return
      }
      // A listener may have aborted: the abort already settled the promise.
      if (value !== undefined && !signal?.aborted) finish(() => resolve(value))
    }
    worker.onerror = (event) => finish(() => reject(new Error(event.message || 'Nesting worker failed')))
    worker.postMessage(request)
  })
}

/**
 * Runs one nest job off the main thread; falls back to running inline without
 * a Worker. `onPlacing` hears how many copies have been tried (#869), a few
 * times a second.
 */
export function runNestJob(
  job: NestJob,
  options: WorkerOptions & { onPlacing?: (done: number, total: number) => void } = {},
): Promise<NestResult> {
  if (options.signal?.aborted) return Promise.reject(new NestCancelledError())
  const worker = startWorker(options)
  if (!worker) {
    try {
      return Promise.resolve(nest(requestFromJob(job)))
    } catch (error: unknown) {
      return Promise.reject(error)
    }
  }
  return converse(worker, { type: 'nest', job }, options.signal, (response) => {
    if (response.type === 'placing') options.onPlacing?.(response.done, response.total)
    return response.type === 'result' ? response.result : undefined
  })
}

export interface NestImproveUpdate {
  /** Layouts placed so far, the first answer included. */
  evaluated: number
  /** Present on the first layout (the one-shot answer) and on every improvement. */
  best?: NestResult
}

/**
 * Keeps searching for a better layout of `job` (#862) until the search stalls
 * or `signal` aborts. Resolves with the number of layouts tried. Without a
 * Worker it runs inline, yielding to the event loop between layouts.
 */
export function improveNestJob(
  job: NestJob,
  options: WorkerOptions & { seed?: number; onProgress: (update: NestImproveUpdate) => void },
): Promise<number> {
  if (options.signal?.aborted) return Promise.reject(new NestCancelledError())
  const worker = startWorker(options)
  if (!worker) return improveInline(job, options)
  return converse(worker, { type: 'improve', job, seed: options.seed }, options.signal, (response) => {
    if (response.type === 'progress') {
      options.onProgress(response.best ? { evaluated: response.evaluated, best: response.best } : { evaluated: response.evaluated })
      return undefined
    }
    return response.type === 'done' ? response.evaluated : undefined
  })
}

async function improveInline(
  job: NestJob,
  options: { signal?: AbortSignal; seed?: number; onProgress: (update: NestImproveUpdate) => void },
): Promise<number> {
  let evaluated = 0
  for (const step of improveNest(requestFromJob(job), { seed: options.seed })) {
    if (options.signal?.aborted) throw new NestCancelledError()
    evaluated = step.evaluated
    options.onProgress(step.improved || evaluated === 1 ? { evaluated, best: step.best } : { evaluated })
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  if (options.signal?.aborted) throw new NestCancelledError()
  return evaluated
}
