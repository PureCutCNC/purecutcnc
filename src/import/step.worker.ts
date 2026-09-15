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
 * The STEP tessellation worker (issue #784).
 *
 * One request per worker: the owner creates it for an import and terminates it
 * when that import settles or is cancelled. Terminating is the only way to give
 * the Open CASCADE heap back — WASM memory grows but never shrinks — and the
 * only way to stop a read that is still inside synchronous OCCT code.
 *
 * The runtime loads on the request, not at module start, so a malformed request
 * never pays for the `.wasm` fetch. Its URL comes from a Vite `?url` import,
 * which makes it a content-hashed build asset resolved under the app's relative
 * base; handing the bytes over as `wasmBinary` means the Emscripten glue never
 * looks for the file beside its own script, where the bundler does not put it.
 *
 * Imports stay minimal: the glue and the tessellation core, nothing from the
 * mesh engine, the store or the UI.
 */

import occtimportjs, { type OcctImportModule } from 'occt-import-js'
import occtWasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url'
import {
  StepImportError,
  isStepTessellateRequest,
  type StepImportErrorPayload,
  type StepWorkerResponse,
} from './stepProtocol'
import { tessellateStep } from './stepTessellation'

/**
 * The worker scope, declared locally for the same reason as in
 * `toolpath.worker.ts`: the `WebWorker` lib collides with `DOM` project-wide.
 */
interface StepWorkerScope {
  /** `transfer` hands the mesh buffers to the main thread instead of copying them. */
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void
  onmessage: ((event: MessageEvent<unknown>) => void) | null
}

declare const self: StepWorkerScope

function post(message: StepWorkerResponse, transfer: ArrayBuffer[] = []): void {
  self.postMessage(message, transfer)
}

function fail(error: StepImportErrorPayload): void {
  post({ kind: 'failed', error })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function loadRuntime(diagnostics: string[]): Promise<OcctImportModule> {
  const response = await fetch(occtWasmUrl)
  if (!response.ok) throw new Error(`HTTP ${response.status} while fetching the STEP runtime`)
  return occtimportjs({
    wasmBinary: await response.arrayBuffer(),
    print: (line) => diagnostics.push(line),
    printErr: (line) => diagnostics.push(line),
  })
}

async function handleMessage(data: unknown): Promise<void> {
  if (!isStepTessellateRequest(data)) {
    fail({ code: 'worker-failed', detail: 'the STEP worker received a malformed request' })
    return
  }

  const diagnostics: string[] = []
  let occt: OcctImportModule
  try {
    occt = await loadRuntime(diagnostics)
  } catch (error: unknown) {
    fail({ code: 'runtime-unavailable', detail: messageOf(error) })
    return
  }

  try {
    const bodies = tessellateStep(occt, new Uint8Array(data.bytes), {
      outputUnit: data.outputUnit,
      linearDeflection: data.linearDeflection,
      maxTriangles: data.maxTriangles,
    }, diagnostics)
    post({ kind: 'completed', bodies }, bodies.flatMap((body) => [body.positions.buffer, body.index.buffer]))
  } catch (error: unknown) {
    fail(error instanceof StepImportError
      ? error.toPayload()
      : { code: 'tessellation-failed', detail: messageOf(error) })
  }
}

self.onmessage = (event) => {
  void handleMessage(event.data)
}
