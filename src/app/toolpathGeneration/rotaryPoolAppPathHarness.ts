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
 * The app path's worker harness (#1115 slice p-d3): the generation worker and
 * the main-thread pool host, wired the way the app wires them, on real threads.
 *
 * It lives beside the code instead of inside `rotaryPoolAppPath.test.ts` for two
 * reasons: the suite's subject is the rotary generation path, not how a Node
 * thread is bootstrapped, and `src/app/**` carries a max-lines ratchet that the
 * harness alone would cross. Nothing in the app imports this module — the vite
 * entry graph never reaches it — so it adds no browser code; it exists for the
 * worker suites that need the shipped modules on a Node `worker_threads` thread:
 *
 * - `toolpath.worker.ts` through `workerThreadAdapter.ts`, and
 * - the angle workers through `rotaryAngleWorkerThreadAdapter.ts` or, when a
 *   test needs to control the reply timing, the in-process fakes below.
 *
 * Only runtime-specific `Worker` construction differs from production, which is
 * the same seam `workerRuntime.test.ts` accepts for the generation worker.
 */

import { Worker } from 'node:worker_threads'

import { ROTARY_ANGLE_PROTOCOL_VERSION } from '../../engine/toolpaths/rotaryAngleProtocol'
import { isWorkerToMain } from './protocol'
import type { RotaryCancelledMessage, WorkerToMain } from './protocol'
import { createRotaryAnglePoolHost } from './rotaryAngleBrowserTransport'
import type { RotaryAngleHostWorker, RotaryAnglePoolHost } from './rotaryAngleBrowserTransport'
import type { RotaryAngleMessagePort } from './rotaryAnglePortTransport'

/** The generation worker on a real thread, through the shipped adapter. */
const GENERATION_ADAPTER_URL = new URL('./workerThreadAdapter.ts', import.meta.url).href
const ANGLE_ADAPTER_URL = new URL('./rotaryAngleWorkerThreadAdapter.ts', import.meta.url).href

/**
 * A plain-JavaScript bootstrap, evaluated as the worker's entry. Pointing
 * `new Worker()` at a TypeScript module fails on Node 20 (the entry resolves
 * before `--import tsx` registers), so the adapter is imported from an
 * already-running plain-JS entry. The catch turns a load failure into a message
 * the test would otherwise have to explain as a bare timeout.
 */
function bootstrap(adapterUrl: string): string {
  return `
    import('tsx/esm/api')
      .then((tsx) => tsx.tsImport(${JSON.stringify(adapterUrl)}, ${JSON.stringify(import.meta.url)}))
      .catch((error) => {
        require('node:worker_threads').parentPort.postMessage({
          kind: 'bootstrapFailed',
          message: String(error && error.stack ? error.stack : error),
        })
      })
  `
}

/** A main-thread generation driver: send, and await the message that answers. */
export interface GenerationDriver {
  worker: Worker
  ready: Promise<WorkerToMain & { kind: 'ready' }>
  send: (message: unknown) => void
  await: (predicate: (message: WorkerToMain) => boolean) => Promise<WorkerToMain>
  close: () => Promise<void>
}

export function createGenerationDriver(): GenerationDriver {
  const worker = new Worker(bootstrap(GENERATION_ADAPTER_URL), { eval: true })
  worker.on('message', (data: unknown) => {
    const message = data as { kind?: string; message?: string }
    if (message?.kind !== 'bootstrapFailed') return
    console.log(`   ✗ generation worker bootstrap failed: ${message.message ?? 'unknown'}`)
    process.exit(1)
  })
  const waiting: { predicate: (message: WorkerToMain) => boolean; resolve: (message: WorkerToMain) => void }[] = []
  const buffered: WorkerToMain[] = []

  worker.on('message', (data: unknown) => {
    if (!isWorkerToMain(data)) return
    const index = waiting.findIndex((entry) => entry.predicate(data))
    if (index >= 0) waiting.splice(index, 1)[0].resolve(data)
    else buffered.push(data)
  })

  const awaitMessage = (predicate: (message: WorkerToMain) => boolean): Promise<WorkerToMain> => {
    const index = buffered.findIndex(predicate)
    if (index >= 0) return Promise.resolve(buffered.splice(index, 1)[0])
    return new Promise((resolve) => { waiting.push({ predicate, resolve }) })
  }

  return {
    worker,
    ready: awaitMessage((message) => message.kind === 'ready') as Promise<WorkerToMain & { kind: 'ready' }>,
    send: (message: unknown) => { worker.postMessage(message) },
    await: awaitMessage,
    close: async () => { await worker.terminate() },
  }
}

/** The generation worker plus the main-thread pool host, wired as the app wires them. */
export interface AppPath {
  readonly driver: GenerationDriver
  readonly host: RotaryAnglePoolHost
  /** Every terminal message this worker posted, in arrival order. */
  readonly terminal: WorkerToMain[]
  /**
   * `rotaryWorkerFailed` messages forwarded to the coordinator. A startup
   * failure has to reach the pool as a *failure*, not as a reply that never
   * comes: without this, a test would still pass on the port transport's own
   * 30 s startup backstop and prove nothing about the failure path.
   */
  readonly failures: string[]
  /**
   * `rotaryCancelled` messages, in arrival order (#1115 p-d3 fix 2). Each one is
   * a superseded rotary generation that reached its end; a cancelled generation
   * whose batch was left pending never posts one.
   */
  readonly cancelled: RotaryCancelledMessage[]
  /**
   * Slot ids the coordinator asked the main thread to create angle workers for,
   * in order. A superseded pool's slots are never reused (`nextSlot` is global),
   * so a new id after a cancellation is the successor's own pool.
   */
  readonly requestedSlots: number[]
  close(): Promise<void>
}

export interface AppPathOptions {
  /** Replace the angle worker construction; production uses the module worker. */
  readonly createAngleWorker?: () => RotaryAngleHostWorker
  readonly startupTimeoutMs?: number
}

/**
 * Adapt a Node `worker_threads` worker to the main thread's `Worker` contract.
 *
 * The one difference that matters is event shape: a browser worker delivers
 * `MessageEvent`s, while `worker_threads` passes the value itself.
 */
function adaptWorker(worker: Worker): RotaryAngleHostWorker {
  return {
    postMessage: (message: unknown, transfer?: Transferable[]) => {
      worker.postMessage(message, transfer as never)
    },
    addEventListener: (type: string, handler: (event: never) => void) => {
      if (type === 'message') {
        worker.on('message', (value: unknown) => { (handler as (event: unknown) => void)({ data: value }) })
      } else if (type === 'error') {
        worker.on('error', (error: Error) => { (handler as (event: unknown) => void)(error) })
      } else if (type === 'messageerror') {
        worker.on('messageerror', (error: Error) => { (handler as (event: unknown) => void)(error) })
      }
    },
    terminate: () => { void worker.terminate() },
  }
}

export function createAppPath(options: AppPathOptions = {}): AppPath {
  const driver = createGenerationDriver()
  const createAngleWorker = options.createAngleWorker
  const terminal: WorkerToMain[] = []
  const failures: string[] = []
  const cancelled: RotaryCancelledMessage[] = []
  const requestedSlots: number[] = []
  let host: RotaryAnglePoolHost | null = null
  host = createRotaryAnglePoolHost({
    ...(createAngleWorker !== undefined ? { createWorker: createAngleWorker } : {}),
    ...(options.startupTimeoutMs !== undefined ? { startupTimeoutMs: options.startupTimeoutMs } : {}),
    onFailure: (slot, message) => {
      failures.push(message)
      driver.send({ kind: 'rotaryWorkerFailed', slot, message })
    },
  })

  driver.worker.on('message', (data: unknown) => {
    if (!isWorkerToMain(data)) return
    if (data.kind === 'completed' || data.kind === 'failed') terminal.push(data)
    if (data.kind === 'rotaryWorker') {
      requestedSlots.push(data.slot)
      host?.attach(data.slot, data.port)
      return
    }
    if (data.kind === 'rotaryRelease') host?.release(data.slot)
    if (data.kind === 'rotaryCancelled') cancelled.push(data)
  })

  return {
    driver,
    get host() { return host as RotaryAnglePoolHost },
    terminal,
    failures,
    cancelled,
    requestedSlots,
    close: async () => {
      host?.terminate()
      await driver.close()
    },
  }
}

/** A Node angle worker running the shipped browser module. */
export function angleWorker(): RotaryAngleHostWorker {
  return adaptWorker(new Worker(bootstrap(ANGLE_ADAPTER_URL), { eval: true }))
}

/** A fake angle worker that answers a batch with a computation error. */
export function failingKernelWorker(): RotaryAngleHostWorker {
  const script = `
    const { parentPort } = require('node:worker_threads')
    const VERSION = ${JSON.stringify(ROTARY_ANGLE_PROTOCOL_VERSION)}
    parentPort.postMessage({ kind: 'ready', protocolVersion: VERSION })
    parentPort.on('message', (value) => {
      const port = value && value.port
      if (!port) return
      port.onmessage = (event) => {
        const request = event.data
        if (request.kind === 'install') port.postMessage({ kind: 'installed', protocolVersion: VERSION })
        else if (request.kind === 'plan') port.postMessage({ kind: 'planApplied', revision: request.revision })
        else if (request.kind === 'batch') {
          port.postMessage({
            kind: 'error',
            epoch: request.epoch,
            batchId: request.batchId,
            phase: 'compute',
            message: 'kernel boom',
          })
        }
      }
      port.start && port.start()
    })
  `
  return adaptWorker(new Worker(script, { eval: true }))
}

/**
 * A fake angle worker that answers the install with an error carrying **no
 * epoch** — a reply from a generation the pool cannot name.
 *
 * That is the one reply shape a coordinator must refuse rather than queue: there
 * is no batch it could belong to, and dropping it leaves the install waiting.
 */
export function unnameableEpochWorker(): RotaryAngleHostWorker {
  const script = `
    const { parentPort } = require('node:worker_threads')
    const VERSION = ${JSON.stringify(ROTARY_ANGLE_PROTOCOL_VERSION)}
    parentPort.postMessage({ kind: 'ready', protocolVersion: VERSION })
    parentPort.on('message', (value) => {
      const port = value && value.port
      if (!port) return
      port.onmessage = (event) => {
        const request = event.data
        if (request.kind === 'install') {
          port.postMessage({ kind: 'error', epoch: -1, batchId: -1, phase: 'install', message: 'from an older generation' })
        }
      }
      port.start && port.start()
    })
  `
  return adaptWorker(new Worker(script, { eval: true }))
}

/** A worker that fails while its module loads, as a broken bundle would. */
export function brokenWorker(): RotaryAngleHostWorker {
  return adaptWorker(new Worker('throw new Error("the angle worker module is missing")', { eval: true }))
}

/** One batch request a holding worker received and did not answer. */
export interface HeldBatch {
  readonly worker: number
  /** The channel the request arrived on: answering here is the late reply. */
  readonly port: RotaryAngleMessagePort
  readonly epoch: number
  readonly batchId: number
  readonly jobs: readonly { index: number; angle: number }[]
  /** The installed setup's along positions, so a released row is the right length. */
  readonly alongLength: number
}

/**
 * An angle worker that answers the setup, then **holds** every batch it is given
 * (#1115 p-d3 fix 1).
 *
 * Cancellation coverage has to cancel a batch that really reached a worker.
 * Holding the `rotaryWorker` requests before `attach` keeps the pool in its
 * install phase, so disposal is proven only against a pending phase wait: no
 * batch is dispatched, no reply is outstanding, and the mid-batch rejection and
 * late-result paths are never entered. This worker acknowledges `install` and
 * `plan` exactly as the shipped one does, and only records `batch`;
 * {@link releaseHeldBatch} answers it later, with the epoch and batch the
 * cancelled pool asked for.
 */
export function holdingAngleWorker(held: HeldBatch[], worker: number): RotaryAngleHostWorker {
  let alongLength = 0
  const readyHandler: { current: ((event: { data: unknown }) => void) | null } = { current: null }
  return {
    postMessage: (message: unknown) => {
      const attach = message as { kind?: unknown; port?: RotaryAngleMessagePort } | null
      if (attach === null || attach.kind !== 'attach' || attach.port === undefined) return
      const port = attach.port
      port.onmessage = (event: { data: unknown }) => {
        const request = event.data as {
          kind: string
          epoch?: number
          batchId?: number
          revision?: number
          jobs?: readonly { index: number; angle: number }[]
          setup?: { along: readonly number[] }
        }
        if (request.kind === 'install') {
          alongLength = request.setup?.along.length ?? 0
          port.postMessage({ kind: 'installed', protocolVersion: ROTARY_ANGLE_PROTOCOL_VERSION })
          return
        }
        if (request.kind === 'plan') {
          port.postMessage({ kind: 'planApplied', revision: request.revision })
          return
        }
        if (request.kind === 'batch') {
          held.push({
            worker,
            port,
            epoch: request.epoch ?? -1,
            batchId: request.batchId ?? -1,
            jobs: request.jobs ?? [],
            alongLength,
          })
        }
      }
      port.start?.()
    },
    addEventListener: (type: string, handler: (event: never) => void) => {
      if (type !== 'message') return
      readyHandler.current = handler as (event: { data: unknown }) => void
      // A worker reports ready on its own turn, after the host has attached its
      // listeners; a synchronous call would arrive before the host could queue it.
      setTimeout(() => {
        readyHandler.current?.({ data: { kind: 'ready', protocolVersion: ROTARY_ANGLE_PROTOCOL_VERSION } })
      }, 0)
    },
    terminate: () => {
      // The port belongs to the coordinator and is closed by its disposal. A
      // held request stays held on purpose: the test decides when it is answered.
    },
  }
}

/**
 * Answer a held batch as a real worker would, with rows a real kernel could have
 * produced. The epoch and batch id are the cancelled request's own, so the only
 * thing that can refuse it is the cancellation itself.
 */
export function releaseHeldBatch(batch: HeldBatch): void {
  batch.port.postMessage({
    kind: 'result',
    epoch: batch.epoch,
    batchId: batch.batchId,
    samples: batch.jobs.map((job) => ({
      index: job.index,
      // A value no real sample would hold, so acceptance of this reply would be
      // visible in the assembled rows rather than merely missing from a count.
      row: new Float32Array(batch.alongLength).fill(321),
      lift: 0,
      warnings: [],
    })),
  })
}
