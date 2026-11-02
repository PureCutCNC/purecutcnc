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
 * One angle worker (issue #1115, slice p-d3): the shipped kernel on a browser
 * module worker, also runnable on a Node `worker_threads` thread through the
 * same three-member scope shim `workerThreadAdapter.ts` uses for the generation
 * worker.
 *
 * The handshake is deliberately two-step. The main thread creates this worker
 * because the design puts worker creation and termination there, but the
 * **coordinator** owns the pool: it makes the `MessageChannel`, so the message
 * that configures this worker (which operation's geometry, which plan, which
 * angles) can travel straight from the generation worker and no mesh data ever
 * crosses the main thread.
 *
 * 1. This module posts `ready` on its own worker channel, which tells the main
 *    thread the bundle loaded and the protocol version agrees.
 * 2. The main thread transfers the coordinator's port here as
 *    `{ kind: 'attach', port }`. From then on every request arrives on that
 *    port and every reply leaves on it. Messages the coordinator posted before
 *    the attach are queued by the port, not lost, so the install can be sent
 *    immediately.
 *
 * A request that cannot be read, or a kernel that throws, is answered with the
 * protocol's `error` reply tagged by phase. The pool treats `install`/`plan` as
 * a resource failure it may rerun serially and `compute` as a real error, so the
 * tag is the whole fallback policy.
 */

import { createRotaryAngleKernel } from '../../engine/toolpaths/rotaryAngleKernel'
import type { RotaryAngleKernel } from '../../engine/toolpaths/rotaryAngleKernel'
import {
  ROTARY_ANGLE_PROTOCOL_VERSION,
  isRotaryAngleWorkerRequest,
} from '../../engine/toolpaths/rotaryAngleProtocol'
import type {
  RotaryAnglePlanPayload,
  RotaryAngleWorkerReply,
} from '../../engine/toolpaths/rotaryAngleProtocol'

/**
 * The worker scope, declared locally and minimally — the same choice
 * `toolpath.worker.ts` makes, for the same reason: adding `"WebWorker"` to
 * `lib` would collide with `DOM` across every browser source in the project.
 */
interface RotaryAngleWorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null
}

declare const self: RotaryAngleWorkerScope

/** The port the coordinator owns, once the main thread has attached it. */
interface AttachedPort {
  postMessage(message: unknown, transfer?: Transferable[]): void
  onmessage: ((event: { data: unknown }) => void) | null
  start?: () => void
  close?: () => void
}

let kernel: RotaryAngleKernel | null = null
let channel: AttachedPort | null = null

function post(reply: RotaryAngleWorkerReply, transfer: Transferable[] = []): void {
  channel?.postMessage(reply, transfer)
}

function reportError(
  request: { epoch: number; batchId: number } | null,
  phase: 'install' | 'plan' | 'compute',
  error: unknown,
): void {
  post({
    kind: 'error',
    // No request means no epoch is known; the pool's coordinator side turns a
    // negatively-epoch'd error into a transport failure rather than dropping it.
    epoch: request?.epoch ?? -1,
    batchId: request?.batchId ?? -1,
    phase,
    message: error instanceof Error ? error.stack ?? error.message : String(error),
  })
}

function serve(request: unknown): void {
  if (!isRotaryAngleWorkerRequest(request)) {
    reportError(null, 'compute', new Error(`rotary angle worker: unreadable request ${String(request)}`))
    return
  }
  try {
    switch (request.kind) {
      case 'install':
        if (request.protocolVersion !== ROTARY_ANGLE_PROTOCOL_VERSION) {
          throw new Error(
            `rotary angle worker: protocol version ${request.protocolVersion}`
            + ` is not ${ROTARY_ANGLE_PROTOCOL_VERSION}`,
          )
        }
        kernel = createRotaryAngleKernel(request.setup)
        post({ kind: 'installed', protocolVersion: ROTARY_ANGLE_PROTOCOL_VERSION })
        return
      case 'plan': {
        if (kernel === null) throw new Error('rotary angle worker: a plan arrived before the setup')
        const plan: RotaryAnglePlanPayload = request.plan
        kernel.applyPlan(plan)
        post({ kind: 'planApplied', revision: request.revision })
        return
      }
      case 'batch': {
        if (kernel === null) throw new Error('rotary angle worker: a batch arrived before the setup')
        const samples = kernel.run(request.jobs)
        // The rows are this worker's own freshly allocated arrays, so handing
        // their buffers over costs nothing and saves a copy per angle. Nothing
        // here reads a row after it has been posted.
        const transfer: Transferable[] = []
        for (const sample of samples) transfer.push(sample.row.buffer as ArrayBuffer)
        post({ kind: 'result', epoch: request.epoch, batchId: request.batchId, samples }, transfer)
        return
      }
      case 'dispose':
        kernel = null
        return
      default:
        return
    }
  } catch (error) {
    const phase = request.kind === 'install' ? 'install' : request.kind === 'plan' ? 'plan' : 'compute'
    const identity = request.kind === 'install' || request.kind === 'plan' || request.kind === 'batch'
      ? { epoch: request.epoch, batchId: request.kind === 'batch' ? request.batchId : -1 }
      : null
    reportError(identity, phase, error)
  }
}

function attach(port: AttachedPort): void {
  channel = port
  port.onmessage = (event: { data: unknown }) => { serve(event.data) }
  // A browser port auto-starts when `onmessage` is set; a Node `MessagePort`
  // documents the same, and an explicit `start()` is harmless on both.
  port.start?.()
}

self.onmessage = (event: MessageEvent<unknown>): void => {
  const message = event.data as { kind?: unknown; port?: unknown } | null
  if (typeof message !== 'object' || message === null) return
  if (message.kind !== 'attach') return
  if (typeof message.port !== 'object' || message.port === null) return
  attach(message.port as AttachedPort)
}

// Tell the main thread the module loaded and the protocol agrees. Anything it
// posts before this is queued by the worker's own channel.
self.postMessage({ kind: 'ready', protocolVersion: ROTARY_ANGLE_PROTOCOL_VERSION })

// A structured-clone failure on the way in surfaces here rather than as a
// silent dropped message; reporting it on the coordinator port is all this end
// can do about it.
self.onmessageerror = (): void => {
  reportError(null, 'compute', new Error('rotary angle worker could not deserialise an incoming message'))
}
