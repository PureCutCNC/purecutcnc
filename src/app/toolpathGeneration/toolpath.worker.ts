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
 * The generation worker (issue #675).
 *
 * Everything this module can reach runs in a thread with no DOM, no React and
 * no project store. That is a real constraint on its import graph, not a
 * comment — `workerGraph.test.ts` walks it and fails on a violation, naming the
 * chain that introduced it. Nothing here imports from `src/app`, `src/store` or
 * `src/components` except protocol *types*, which erase at compile time.
 *
 * `computeOperationToolpath` comes from `generateOperation.ts` directly rather
 * than the `toolpaths/index.ts` barrel. Measured, the barrel is currently clean
 * — it pulls 18 extra modules into the worker chunk but violates none of the
 * rules — so this is a size and blast-radius choice, not a correctness one. The
 * import to avoid is the store's: `projectStore.ts` reaches React in five hops
 * through `machine/store.ts` and `useLocalStorageState.ts`, and pulls in
 * `import/svg.ts`, which touches browser globals unguarded.
 *
 * It holds exactly one installed snapshot and computes one operation at a time.
 * It keeps no history of completed results: the authoritative cache is on the
 * main thread, and a second copy here would be a per-document memory leak in a
 * realm the main thread cannot clear.
 *
 * There is no `cancel` message, deliberately. A worker inside a synchronous
 * Clipper offset cannot reach its own event loop, so a cancel would sit in the
 * queue until the work it was meant to stop had already finished. Cancellation
 * is `Worker.terminate()` from the owner.
 */

import { computeOperationToolpath } from '../../engine/toolpaths/generateOperation'
import { clearImportedModelCaches } from '../../engine/importedMesh'
import { packResult, transferablesOf } from './moveTransport'
import type { Project } from '../../types/project'
import type {
  CompletedMessage,
  FailedMessage,
  MainToWorker,
  ProgressMessage,
  ReadyMessage,
  SnapshotReadyMessage,
} from './protocol'
import { TOOLPATH_PROTOCOL_VERSION } from './protocol'
import type { GenerationFailure, RequestIdentity } from './types'

/**
 * The worker scope, declared locally and minimally.
 *
 * Adding `"WebWorker"` to `lib` would apply it to every browser source in the
 * project, where it collides with `DOM` on shared globals (`self`, `fetch`,
 * `MessageEvent`) and starts producing wrong types in files that have nothing
 * to do with workers. Only this module needs the scope, so only this module
 * declares it — and only the three members it actually uses.
 */
interface ToolpathWorkerScope {
  /** `transfer` hands buffer ownership to the main thread instead of copying it. */
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null
}

declare const self: ToolpathWorkerScope

interface InstalledSnapshot {
  documentKey: number
  snapshotId: number
  project: Project
}

let installed: InstalledSnapshot | null = null

function post(
  message: ReadyMessage | SnapshotReadyMessage | ProgressMessage | CompletedMessage | FailedMessage,
  transfer?: ArrayBuffer[],
): void {
  self.postMessage(message, transfer)
}

function fail(identity: RequestIdentity, failure: GenerationFailure): void {
  post({ kind: 'failed', identity, failure })
}

/**
 * Validation is duplicated here rather than imported from `protocol.ts`'s
 * `isMainToWorker` for one reason: this side must distinguish *which* field was
 * wrong to report a useful failure, and it must never trust a shape check that
 * ran on the other end of the wire.
 */
function handleLoadSnapshot(message: MainToWorker & { kind: 'loadSnapshot' }): void {
  // Model assets decode into a module-level cache in this realm. The main
  // thread's `clearProjectMemoryCaches()` cannot see it — different realm — so
  // replacing a snapshot has to clear it here or a document's meshes accumulate
  // for the life of the worker.
  clearImportedModelCaches()
  installed = {
    documentKey: message.documentKey,
    snapshotId: message.snapshotId,
    project: message.project,
  }
  post({ kind: 'snapshotReady', documentKey: message.documentKey, snapshotId: message.snapshotId })
}

function handleGenerate(identity: RequestIdentity): void {
  if (!installed) {
    fail(identity, { category: 'protocol', message: 'generate arrived with no snapshot installed' })
    return
  }
  if (installed.documentKey !== identity.documentKey || installed.snapshotId !== identity.snapshotId) {
    fail(identity, {
      category: 'protocol',
      message: 'generate names a snapshot this worker does not have',
      detail: `installed ${installed.documentKey}/${installed.snapshotId}, asked ${identity.documentKey}/${identity.snapshotId}`,
    })
    return
  }

  // Resolved from the installed snapshot, never from a separately sent copy:
  // two copies of one operation can disagree, and then the program depends on
  // which one the code happened to read.
  const operation = installed.project.operations.find((candidate) => candidate.id === identity.operationId)
  if (!operation) {
    fail(identity, {
      category: 'protocol',
      message: 'operation is not in the installed snapshot',
      detail: identity.operationId,
    })
    return
  }

  post({ kind: 'progress', identity, stage: 'generating' })

  let envelope
  try {
    envelope = computeOperationToolpath(installed.project, operation, { trace: identity.traceMode })
  } catch (error: unknown) {
    fail(identity, {
      category: 'computation',
      message: error instanceof Error ? error.message : String(error),
      detail: error instanceof Error ? error.stack : undefined,
    })
    return
  }

  if (!envelope) {
    fail(identity, { category: 'computation', message: 'no generator for operation kind', detail: operation.kind })
    return
  }

  post({ kind: 'progress', identity, stage: 'installing' })
  try {
    // Packed here rather than on the main thread: this is the thread that can
    // afford the walk, and what crosses is then buffers rather than ~3 objects
    // per move.
    const result = packResult(envelope.result)
    const raw = envelope.raw ? packResult(envelope.raw) : null
    const transfer = [...transferablesOf(result), ...(raw ? transferablesOf(raw) : [])]
    // Transferring neuters these buffers here. Nothing reads the result after
    // this point, which is what makes that safe.
    post({ kind: 'completed', identity, result, raw }, transfer)
  } catch (error: unknown) {
    // The result computed but could not be cloned back. Reporting it as a
    // failure is the only honest option: the main thread has nothing to install
    // and must not be told the operation succeeded.
    fail(identity, {
      category: 'clone',
      message: 'result could not be posted back',
      detail: error instanceof Error ? error.message : String(error),
    })
  }
}

self.onmessage = (event: MessageEvent<unknown>): void => {
  const message = event.data as MainToWorker
  if (typeof message !== 'object' || message === null || typeof message.kind !== 'string') {
    return
  }
  if (message.kind === 'loadSnapshot') {
    handleLoadSnapshot(message)
    return
  }
  if (message.kind === 'generate') {
    handleGenerate(message.identity)
  }
}

// A structured-clone failure on the way *in* surfaces here rather than as a
// silent dropped message.
self.onmessageerror = (): void => {
  post({
    kind: 'failed',
    identity: { documentKey: -1, workerEpoch: -1, requestId: -1, snapshotId: -1, operationId: 'unknown', traceMode: false },
    failure: { category: 'clone', message: 'worker could not deserialise an incoming message' },
  })
}

post({ kind: 'ready', protocolVersion: TOOLPATH_PROTOCOL_VERSION, workerEpoch: 0 })
