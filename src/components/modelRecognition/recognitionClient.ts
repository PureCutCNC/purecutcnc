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

// Main-thread half of the recognition worker (issue #1206). Sectioning a large
// mesh takes long enough to freeze the interface, so it runs in a Worker when
// one is available and inline otherwise. Cancellation is `terminate()`.

import {
  recognizeCavities,
  type ModelRecognitionResult,
  type RecognitionMesh,
} from '../../engine/modelRecognition'
import type { RecognitionWorkerRequest, RecognitionWorkerResponse } from './recognition.worker'

export class RecognitionCancelledError extends Error {
  constructor() {
    super('Model recognition was cancelled')
    this.name = 'RecognitionCancelledError'
  }
}

export interface RecognitionWorkerLike {
  postMessage(message: RecognitionWorkerRequest, transfer: Transferable[]): void
  terminate(): void
  onmessage: ((event: MessageEvent<RecognitionWorkerResponse>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
}

export type RecognitionWorkerFactory = () => RecognitionWorkerLike | null

/** The bundled worker, or null where workers are unavailable. */
export function createDefaultRecognitionWorker(): RecognitionWorkerLike | null {
  if (typeof Worker === 'undefined') return null
  return new Worker(new URL('./recognition.worker.ts', import.meta.url), { type: 'module' }) as unknown as RecognitionWorkerLike
}

export interface RunRecognitionOptions {
  signal?: AbortSignal
  onProgress?: (fraction: number) => void
  createWorker?: RecognitionWorkerFactory
}

/**
 * Finds the cavities of `mesh` off the main thread. The mesh is copied before
 * it is handed over: the caller's buffers are the geometry cache's, and a
 * transferred buffer is gone from the thread that sent it.
 */
export function runModelRecognition(
  mesh: RecognitionMesh,
  options: RunRecognitionOptions = {},
): Promise<ModelRecognitionResult> {
  if (options.signal?.aborted) return Promise.reject(new RecognitionCancelledError())

  let worker: RecognitionWorkerLike | null
  try {
    worker = (options.createWorker ?? createDefaultRecognitionWorker)()
  } catch {
    worker = null
  }
  if (!worker) {
    try {
      return Promise.resolve(recognizeCavities(mesh, { onProgress: options.onProgress }))
    } catch (error: unknown) {
      return Promise.reject(error)
    }
  }

  const running = worker
  return new Promise<ModelRecognitionResult>((resolve, reject) => {
    let settled = false
    const finish = (outcome: () => void): void => {
      if (settled) return
      settled = true
      running.terminate()
      options.signal?.removeEventListener('abort', onAbort)
      outcome()
    }
    const onAbort = (): void => finish(() => reject(new RecognitionCancelledError()))
    options.signal?.addEventListener('abort', onAbort, { once: true })

    running.onmessage = (event) => {
      const response = event.data
      if (response.type === 'progress') {
        options.onProgress?.(response.fraction)
        return
      }
      if (response.type === 'error') {
        finish(() => reject(new Error(response.message)))
        return
      }
      finish(() => resolve(response.result))
    }
    running.onerror = (event) => finish(() => reject(new Error(event.message || 'Recognition worker failed')))

    const positions = mesh.positions.slice()
    const index = mesh.index.slice()
    running.postMessage({ type: 'recognize', positions, index }, [positions.buffer, index.buffer])
  })
}
