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
 * Main-thread half of STEP import (issue #784): runs one tessellation in a
 * fresh worker and turns the answer into `ImportedTriangleMesh` bodies.
 *
 * Every way out terminates the worker — success, failure, crash and
 * cancellation — because a worker only ever serves one file and terminating is
 * what releases the Open CASCADE heap (see `step.worker.ts`). Cancellation is
 * `terminate()` for the same reason as the toolpath worker's: a read inside
 * synchronous OCCT code never sees a message.
 */

import { computeMeshBounds, type ImportedTriangleMesh } from '../engine/importedMesh'
import {
  StepImportError,
  isStepWorkerResponse,
  type StepOutputUnit,
  type StepTessellateRequest,
} from './stepProtocol'

/**
 * Largest STEP file accepted, checked before a worker starts.
 *
 * The runtime's heap ceiling is 2 GiB. Measured on a synthetic 40 × 40 cylinder
 * grid, 3.3 MiB of STEP text grew the heap to 256 MiB, so files near this cap
 * fit only when they are far less dense than that; the rest fail as
 * out-of-memory inside the worker. The cap stops the obvious cases before the
 * copy and the parse.
 */
export const MAX_STEP_FILE_BYTES = 64 * 1024 * 1024

/**
 * Most triangles one import may produce, across all of its bodies.
 *
 * Measured on the same grid, tessellating 0.4 M and 0.9 M triangles took 7 s and
 * 14 s in Node on the development machine, before the mesh reaches the
 * silhouette projection, the project and the viewport. An import past this is
 * refused with a pointer to the surface tolerance, which is what the user can change.
 */
export const MAX_STEP_TRIANGLES = 2_000_000

/** Injected so tests can drive a fake worker. */
export interface StepWorkerLike {
  postMessage(message: unknown, transfer: Transferable[]): void
  terminate(): void
  addEventListener(type: 'message', handler: (event: MessageEvent<unknown>) => void): void
  addEventListener(type: 'error' | 'messageerror', handler: (event: Event) => void): void
}

export type StepWorkerFactory = () => StepWorkerLike

/**
 * The production factory. The `new URL(…, import.meta.url)` form is the shape
 * the bundler recognises as a separate worker entry; see `createDefaultWorker`
 * in the toolpath generation service.
 */
export function createDefaultStepWorker(): StepWorkerLike {
  return new Worker(new URL('./step.worker.ts', import.meta.url), { type: 'module' }) as unknown as StepWorkerLike
}

export interface StepBody {
  /** The solid's name in the file; empty when the file names none. */
  name: string
  mesh: ImportedTriangleMesh
}

export interface TessellateStepFileOptions {
  outputUnit: StepOutputUnit
  /** Absolute chordal deflection, in `outputUnit`. */
  linearDeflection: number
  signal?: AbortSignal
  maxBytes?: number
  maxTriangles?: number
  createWorker?: StepWorkerFactory
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorEventDetail(event: Event): string | undefined {
  return 'message' in event && typeof event.message === 'string' && event.message ? event.message : undefined
}

export function tessellateStepFile(buffer: ArrayBuffer, options: TessellateStepFileOptions): Promise<StepBody[]> {
  const maxBytes = options.maxBytes ?? MAX_STEP_FILE_BYTES
  const maxTriangles = options.maxTriangles ?? MAX_STEP_TRIANGLES
  if (options.signal?.aborted) return Promise.reject(new StepImportError({ code: 'cancelled' }))
  if (!Number.isFinite(options.linearDeflection) || options.linearDeflection <= 0) {
    return Promise.reject(new StepImportError({ code: 'invalid-tolerance' }))
  }
  if (buffer.byteLength > maxBytes) {
    return Promise.reject(new StepImportError({ code: 'file-too-large', limit: maxBytes }))
  }

  let worker: StepWorkerLike
  try {
    worker = (options.createWorker ?? createDefaultStepWorker)()
  } catch (error: unknown) {
    return Promise.reject(new StepImportError({ code: 'runtime-unavailable', detail: messageOf(error) }))
  }

  return new Promise<StepBody[]>((resolve, reject) => {
    let settled = false
    const settle = (outcome: () => void): void => {
      if (settled) return
      settled = true
      worker.terminate()
      options.signal?.removeEventListener('abort', onAbort)
      outcome()
    }
    const onAbort = (): void => settle(() => reject(new StepImportError({ code: 'cancelled' })))
    options.signal?.addEventListener('abort', onAbort, { once: true })

    worker.addEventListener('message', (event) => {
      const message = event.data
      if (!isStepWorkerResponse(message)) {
        settle(() => reject(new StepImportError({
          code: 'worker-failed',
          detail: 'the STEP worker sent a malformed response',
        })))
        return
      }
      if (message.kind === 'failed') {
        settle(() => reject(new StepImportError(message.error)))
        return
      }
      settle(() => resolve(message.bodies.map((body) => ({
        name: body.name,
        mesh: { positions: body.positions, index: body.index, bounds: computeMeshBounds(body.positions) },
      }))))
    })
    worker.addEventListener('error', (event) => {
      settle(() => reject(new StepImportError({ code: 'worker-failed', detail: errorEventDetail(event) })))
    })
    worker.addEventListener('messageerror', () => {
      settle(() => reject(new StepImportError({
        code: 'worker-failed',
        detail: 'a STEP worker message could not be deserialized',
      })))
    })

    // A copy is transferred so the caller keeps its buffer for a retry at another tolerance.
    const bytes = buffer.slice(0)
    const request: StepTessellateRequest = {
      kind: 'tessellate',
      bytes,
      outputUnit: options.outputUnit,
      linearDeflection: options.linearDeflection,
      maxTriangles,
    }
    worker.postMessage(request, [bytes])
  })
}
