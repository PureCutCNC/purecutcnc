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
 * Runs the real generation worker inside a Node `worker_threads` thread, for
 * `workerRuntime.test.ts`.
 *
 * The two runtimes differ only in how a thread is addressed — `self.postMessage`
 * in a browser, `parentPort.postMessage` here — so a shim over the three members
 * the worker uses is enough to run **the shipped module, unmodified** on a real
 * second thread, with the same structured-clone algorithm carrying the payload.
 *
 * What this does not cover, and what still needs a browser: bundling, the
 * `new URL(..., import.meta.url)` asset resolution, and startup under the
 * packaged app. Those are e2e concerns and arrive with the consumer migration.
 */

import { parentPort } from 'node:worker_threads'
import { tsImport } from 'tsx/esm/api'

interface WorkerScopeShim {
  postMessage(message: unknown): void
  onmessage: ((event: { data: unknown }) => void) | null
  onmessageerror: ((event: { data: unknown }) => void) | null
}

const shim: WorkerScopeShim = {
  postMessage: (message: unknown) => { parentPort?.postMessage(message) },
  onmessage: null,
  onmessageerror: null,
}

;(globalThis as unknown as { self: WorkerScopeShim }).self = shim

parentPort?.on('message', (data: unknown) => {
  shim.onmessage?.({ data })
})

// Imported after the shim is installed: the worker posts its `ready` handshake
// at module scope, so `self` has to exist before it evaluates.
//
// `tsImport` rather than a plain dynamic import: the parent process's TypeScript
// loader does not extend into a `worker_threads` thread, so without it the
// worker's own extensionless relative imports fail to resolve here. This is a
// property of running TypeScript under Node, not of the worker.
await tsImport('./toolpath.worker.ts', import.meta.url)
