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
 * Runs the shipped **browser** angle worker inside a Node `worker_threads`
 * thread, for the app-path suite (#1115 slice p-d3).
 *
 * This is the same trick `workerThreadAdapter.ts` plays for the generation
 * worker, applied to `rotaryAngle.worker.ts`: the two runtimes differ only in
 * how a thread is addressed (`self.postMessage` in a browser, `parentPort` here),
 * so a shim over the members that module uses runs the shipped module unmodified
 * on a real second thread with the same structured-clone transport.
 *
 * The pairing matters. `rotaryAngleWorkerAdapter.ts` (p-d2) runs the *kernel* on
 * a thread for the probe and the pool's own suites. This file runs the browser
 * *worker module* instead, so the app-path tests exercise the handshake the
 * application actually uses — `ready` on the worker channel, then `attach` with
 * a transferred `MessagePort` — rather than a second implementation of it.
 *
 * What it still does not cover: bundling, the `new URL(..., import.meta.url)`
 * asset resolution, and startup in the packaged app. Those stay browser checks.
 */

import { parentPort } from 'node:worker_threads'
import { tsImport } from 'tsx/esm/api'

interface WorkerScopeShim {
  postMessage(message: unknown, transfer?: Transferable[]): void
  onmessage: ((event: { data: unknown }) => void) | null
  onmessageerror: ((event: { data: unknown }) => void) | null
}

const shim: WorkerScopeShim = {
  postMessage: (message: unknown, transfer?: Transferable[]) => {
    parentPort?.postMessage(message, transfer as never)
  },
  onmessage: null,
  onmessageerror: null,
}

;(globalThis as unknown as { self: WorkerScopeShim }).self = shim

parentPort?.on('message', (data: unknown) => {
  shim.onmessage?.({ data })
})

// Imported after the shim is installed: the worker module posts its `ready`
// handshake at module scope, so `self` has to exist before it evaluates.
//
// `tsImport` rather than a plain dynamic import, for the same reason as the
// sibling adapters: the parent process's TypeScript loader does not extend into
// a `worker_threads` thread, so the module's extensionless relative imports
// would not resolve here.
await tsImport('./rotaryAngle.worker.ts', import.meta.url)
