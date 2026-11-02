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
 * **Rotary operations are the one asynchronous kind** (#1115 slice p-d3). Their
 * angle sampling runs on a pool of main-thread-created module workers, connected
 * to this thread by `MessagePort` pairs, and the pool is driven through the
 * p-d1 async driver. That makes the worker's event loop reachable *during* a
 * generation, so a second request, a new snapshot or a Stop can end the batch
 * instead of being read only after it finished. Two guards make that safe: a
 * module-level generation counter that a late result checks before it posts
 * anything, and the pool's own epoch, which refuses a reply from a disposed
 * pool. Every non-rotary kind stays synchronous and byte-identical.
 *
 * Cancellation is still `Worker.terminate()` from the owner for work that has
 * not reached an await; the generation counter is what covers the waiting part.
 * A superseded rotary generation finishes by posting `rotaryCancelled`, so the
 * main thread can prove the batch it cancelled really stopped instead of being
 * left pending with the previous operation's geometry still attached.
 */

import {
  computeOperationToolpath,
  computeOperationToolpathAsync,
} from '../../engine/toolpaths/generateOperation'
import type { OperationToolpathEnvelope } from '../../engine/toolpaths/generateOperation'
import { clearImportedModelCaches } from '../../engine/importedMesh'
import { createRotaryAnglePool } from '../../engine/toolpaths/rotaryAnglePool'
import type { RotaryAnglePool, RotaryAnglePoolStats } from '../../engine/toolpaths/rotaryAnglePool'
import { isRotaryOperationKind } from '../../types/project'
import type { Operation } from '../../types/project'
import { packResult, transferablesOf } from './moveTransport'
import { createRotaryAnglePortTransport } from './rotaryAnglePortTransport'
import type { RotaryAnglePortTransport } from './rotaryAnglePortTransport'
import type { Project } from '../../types/project'
import type {
  CompletedMessage,
  MainToWorker,
  RotaryPoolReport,
  RotaryReleaseMessage,
  RotaryWorkerRequestMessage,
  WorkerToMain,
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
 * declares it — and only the members it actually uses.
 */
interface ToolpathWorkerScope {
  /** `transfer` hands ownership to the other side instead of copying it. */
  postMessage(message: unknown, transfer?: Transferable[]): void
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

/**
 * Bumped by every generate and every snapshot install. A rotary generation
 * awaits worker replies, so the request that was running when another arrived
 * must be able to see that it is no longer the current one — and a result that
 * arrived after it stopped being current is never posted.
 */
let generation = 0

/**
 * The resources one generation owns: its pool and the transport that made its
 * angle workers.
 *
 * Owned by *generation number* on purpose. A superseded generation finishes its
 * await after the next one has already started, and it must not release the
 * resources that now belong to that next one — which is exactly what a pair of
 * shared module variables did, and what a test caught (the second request ran
 * the pool and then reported no pool at all).
 */
interface GenerationResources {
  readonly seq: number
  readonly transport: RotaryAnglePortTransport
  pool: RotaryAnglePool | null
}

let current: GenerationResources | null = null

/** Take ownership away from whoever holds it, so a stale cleanup cannot. */
function takeCurrent(): GenerationResources | null {
  const taken = current
  current = null
  return taken
}

function post(message: WorkerToMain, transfer?: Transferable[]): void {
  self.postMessage(message, transfer)
}

function fail(identity: RequestIdentity, failure: GenerationFailure): void {
  post({ kind: 'failed', identity, failure })
}

/**
 * Release one generation's angle workers and its copies of the operation's
 * geometry.
 *
 * The caller passes the resources it owns; nothing here reads the module's
 * current generation, so a superseded generation releases only its own.
 */
async function releaseResources(resources: GenerationResources | null): Promise<void> {
  if (resources === null) return
  if (resources.pool !== null) {
    try {
      await resources.pool.dispose()
    } catch {
      // Disposal is best effort: the workers are going away regardless.
    }
  }
  resources.transport.dispose()
}

/** The pool's outcome, in the shape the completed message carries. */
function poolReport(stats: RotaryAnglePoolStats | null): RotaryPoolReport | undefined {
  if (stats === null) return undefined
  return { mode: stats.mode, workers: stats.workers, batches: stats.batches, fallback: stats.fallback }
}

/**
 * Validation is duplicated here rather than imported from `protocol.ts`'s
 * `isMainToWorker` for one reason: this side must distinguish *which* field was
 * wrong to report a useful failure, and it must never trust a shape check that
 * ran on the other end of the wire.
 */
function handleLoadSnapshot(message: MainToWorker & { kind: 'loadSnapshot' }): void {
  // A new snapshot ends whatever the old one was computing: the pool's operation
  // data describes the previous project and must not be sampled again.
  generation += 1
  void releaseResources(takeCurrent())
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

/**
 * Generate one rotary operation through the angle pool.
 *
 * The pool is created inside the batch factory, which the driver calls once per
 * operation prep — that is where one worker's copy of the raster geometry and
 * bucket data is made, so it happens once per operation and never per angle.
 */
async function generateRotary(
  seq: number,
  identity: RequestIdentity,
  snapshot: InstalledSnapshot,
  operation: Operation,
  availableParallelism: number | undefined,
): Promise<void> {
  const ports = createRotaryAnglePortTransport({
    ...(availableParallelism !== undefined ? { availableParallelism } : {}),
    requestWorker: (port, slot) => {
      const request: RotaryWorkerRequestMessage = { kind: 'rotaryWorker', slot, port }
      post(request, [port])
    },
    releaseWorker: (slot) => {
      const release: RotaryReleaseMessage = { kind: 'rotaryRelease', slot }
      post(release)
    },
  })
  const resources: GenerationResources = { seq, transport: ports, pool: null }
  current = resources

  let envelope: OperationToolpathEnvelope | null = null
  let failure: GenerationFailure | null = null
  try {
    envelope = await computeOperationToolpathAsync(snapshot.project, operation, {
      trace: identity.traceMode,
      rotaryRunBatch: (prep) => {
        const pool = createRotaryAnglePool(prep, ports.source)
        resources.pool = pool
        return pool.batches
      },
    })
  } catch (error: unknown) {
    failure = {
      category: 'computation',
      message: error instanceof Error ? error.message : String(error),
      detail: error instanceof Error ? error.stack : undefined,
    }
  }

  // Read the pool's outcome before disposal, and decide whether this result is
  // still the one that was asked for. Only this generation's own resources are
  // taken: a later generation's are not this one's to release.
  const mine = current?.seq === seq ? takeCurrent() : null
  const report = poolReport(mine?.pool?.stats() ?? null)
  const stale = seq !== generation
  await releaseResources(mine)
  if (stale) {
    // The cancelled generation has actually finished. Reporting it is the
    // difference between "stopped" and "abandoned mid-await, still holding the
    // previous operation's data": the batch is rejected by `dispose()`, so this
    // is reached, and a cancelled generation that never gets here is visible
    // instead of silent (#1115 p-d3 fix 2).
    post({ kind: 'rotaryCancelled', identity })
    return
  }
  if (failure !== null) {
    fail(identity, failure)
    return
  }
  if (envelope === null) {
    fail(identity, { category: 'computation', message: 'no generator for operation kind', detail: operation.kind })
    return
  }
  postResult(identity, envelope, report)
}

/** Pack and post one finished envelope, with the pool's report attached. */
function postResult(
  identity: RequestIdentity,
  envelope: OperationToolpathEnvelope,
  rotary: RotaryPoolReport | undefined,
): void {
  post({ kind: 'progress', identity, stage: 'installing' })
  try {
    // Packed here rather than on the main thread: this is the thread that can
    // afford the walk, and what crosses is then buffers rather than ~3 objects
    // per move.
    const result = packResult(envelope.result)
    const raw = envelope.raw ? packResult(envelope.raw) : null
    const transfer = [...transferablesOf(result), ...(raw ? transferablesOf(raw) : [])]
    const completed: CompletedMessage = { kind: 'completed', identity, result, raw, ...(rotary ? { rotary } : {}) }
    // Transferring neuters these buffers here. Nothing reads the result after
    // this point, which is what makes that safe.
    post(completed, transfer)
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

async function handleGenerate(identity: RequestIdentity, availableParallelism: number | undefined): Promise<void> {
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

  generation += 1
  const seq = generation
  // A request that arrives while the previous one is waiting on angle workers
  // ends it here: the pool is disposed, which rejects its batch, and the late
  // result is dropped by the counter rather than posted.
  void releaseResources(takeCurrent())

  post({ kind: 'progress', identity, stage: 'generating' })

  if (isRotaryOperationKind(operation.kind)) {
    await generateRotary(seq, identity, installed, operation, availableParallelism)
    return
  }

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

  postResult(identity, envelope, undefined)
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
    // The async body never rejects: every path either posts an outcome or
    // deliberately drops a superseded one.
    void handleGenerate(message.identity, message.rotary?.availableParallelism)
    return
  }
  if (message.kind === 'rotaryWorkerFailed') {
    current?.transport.fail(message.slot, message.message)
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
