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

import { nest, requestFromJob, type NestJob, type NestResult } from '../../engine/nesting'
import type { NestWorkerResponse } from './nest.worker'

export class NestCancelledError extends Error {
  constructor() {
    super('Nesting was cancelled')
    this.name = 'NestCancelledError'
  }
}

export interface NestWorkerLike {
  postMessage(message: NestJob): void
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

/** Runs one nest job off the main thread; falls back to running inline without a Worker. */
export function runNestJob(
  job: NestJob,
  options: { signal?: AbortSignal; createWorker?: NestWorkerFactory } = {},
): Promise<NestResult> {
  if (options.signal?.aborted) return Promise.reject(new NestCancelledError())
  let worker: NestWorkerLike | null = null
  try {
    worker = (options.createWorker ?? createDefaultNestWorker)()
  } catch {
    worker = null
  }
  if (!worker) {
    try {
      return Promise.resolve(nest(requestFromJob(job)))
    } catch (error: unknown) {
      return Promise.reject(error)
    }
  }

  const active = worker
  return new Promise<NestResult>((resolve, reject) => {
    const finish = (outcome: () => void) => {
      active.terminate()
      options.signal?.removeEventListener('abort', onAbort)
      outcome()
    }
    const onAbort = () => finish(() => reject(new NestCancelledError()))
    options.signal?.addEventListener('abort', onAbort, { once: true })
    active.onmessage = (event) => {
      const response = event.data
      finish(() => (response.type === 'result'
        ? resolve(response.result)
        : reject(new Error(response.message))))
    }
    active.onerror = (event) => finish(() => reject(new Error(event.message || 'Nesting worker failed')))
    active.postMessage(job)
  })
}
