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
 * Main-thread half of the square-blank simulation worker (issue #1016 C2 P2).
 *
 * A square replay blocks the UI thread for 66 s to open the Simulation tab and
 * 86 s after a length resize in the CPU profile, so it runs in a worker when
 * one is available. Cancellation is `terminate()`: the replay is synchronous
 * and would never see a message. Without a Worker (Node tests) or when one
 * cannot be created, the same job runs in-thread through the same
 * `runSquareSimulationJob`, so the answer is identical either way.
 */

import { runSquareSimulationJob, type SquareSimulationDeliverable, type SquareSimulationJob } from '../simulationCompute'
import type { SquareSimulationWorkerRequest, SquareSimulationWorkerResponse } from './squareSimulation.worker'

export class SquareSimulationCancelledError extends Error {
  constructor() {
    super('The square simulation was cancelled')
    this.name = 'SquareSimulationCancelledError'
  }
}

export interface SquareSimulationWorkerLike {
  postMessage(message: SquareSimulationWorkerRequest): void
  terminate(): void
  onmessage: ((event: MessageEvent<SquareSimulationWorkerResponse>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
}

export type SquareSimulationWorkerFactory = () => SquareSimulationWorkerLike | null

/** The bundled worker, or null where workers are unavailable. */
export function createDefaultSquareSimulationWorker(): SquareSimulationWorkerLike | null {
  if (typeof Worker === 'undefined') return null
  return new Worker(new URL('./squareSimulation.worker.ts', import.meta.url), { type: 'module' }) as unknown as SquareSimulationWorkerLike
}

export interface SquareSimulationOptions {
  signal?: AbortSignal
  /** Injected so tests can drive a fake worker. */
  createWorker?: SquareSimulationWorkerFactory
}

function startWorker(options: SquareSimulationOptions): SquareSimulationWorkerLike | null {
  try {
    return (options.createWorker ?? createDefaultSquareSimulationWorker)()
  } catch {
    return null
  }
}

/**
 * Runs one square simulation job off the main thread, or in-thread when no
 * Worker can be created. Every way out terminates the worker: success,
 * failure, a crash and cancellation.
 */
export function runSquareSimulation(
  job: SquareSimulationJob,
  options: SquareSimulationOptions = {},
): Promise<SquareSimulationDeliverable> {
  if (options.signal?.aborted) return Promise.reject(new SquareSimulationCancelledError())
  const worker = startWorker(options)
  if (worker === null) {
    try {
      return Promise.resolve(runSquareSimulationJob(job))
    } catch (error: unknown) {
      return Promise.reject(error)
    }
  }
  const activeWorker = worker

  return new Promise<SquareSimulationDeliverable>((resolve, reject) => {
    let settled = false
    const settle = (outcome: () => void): void => {
      if (settled) return
      settled = true
      activeWorker.terminate()
      options.signal?.removeEventListener('abort', onAbort)
      // A terminated worker's late message must never reach a settled promise.
      activeWorker.onmessage = null
      activeWorker.onerror = null
      outcome()
    }
    const onAbort = (): void => settle(() => reject(new SquareSimulationCancelledError()))
    options.signal?.addEventListener('abort', onAbort, { once: true })

    activeWorker.onmessage = (event) => {
      const response = event.data
      if (response?.type === 'error') {
        settle(() => reject(new Error(response.message)))
        return
      }
      if (response?.type !== 'result') {
        settle(() => reject(new Error('The square simulation worker sent a malformed response')))
        return
      }
      settle(() => resolve({ result: response.result, startingStock: response.startingStock }))
    }
    activeWorker.onerror = (event) => settle(() => reject(new Error(event.message || 'Square simulation worker failed')))
    try {
      activeWorker.postMessage({ type: 'run', job })
    } catch (error: unknown) {
      settle(() => reject(error))
    }
  })
}
