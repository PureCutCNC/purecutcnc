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
 * The angle kernel on a Node `worker_threads` thread, for the probe and the
 * pool tests (#1115 slice p-d2).
 *
 * The shipped angle worker for a browser is p-d3's; this is the Node half of the
 * same protocol, and it deliberately runs the same kernel module through the
 * same message shapes. Only the transport differs -- `parentPort.postMessage`
 * here, `self.postMessage` in a worker -- so a parity result measured on this
 * thread is evidence about the kernel and the protocol, not about a second
 * implementation.
 *
 * The module is loaded through `tsImport` rather than a plain static import: a
 * `worker_threads` thread does not inherit the parent process's TypeScript
 * loader, so its own extensionless relative imports (`./rotarySampling`) would
 * not resolve. `rotaryAngleNodeTransport.ts` imports this file through the same
 * helper, which is what makes the chain work on Node 20 and 22 alike.
 */

import { parentPort } from 'node:worker_threads'
import { tsImport } from 'tsx/esm/api'

import type { RotaryAngleKernel } from '../../engine/toolpaths/rotaryAngleKernel'
import type {
  RotaryAnglePlanPayload,
  RotaryAngleWorkerReply,
  RotaryAngleWorkerRequest,
} from '../../engine/toolpaths/rotaryAngleProtocol'

const protocol = await tsImport(
  '../../engine/toolpaths/rotaryAngleProtocol.ts',
  import.meta.url,
) as typeof import('../../engine/toolpaths/rotaryAngleProtocol')

const kernels = await tsImport(
  '../../engine/toolpaths/rotaryAngleKernel.ts',
  import.meta.url,
) as typeof import('../../engine/toolpaths/rotaryAngleKernel')

let kernel: RotaryAngleKernel | null = null

function post(reply: RotaryAngleWorkerReply, transfer: readonly ArrayBuffer[] = []): void {
  parentPort?.postMessage(reply, transfer as ArrayBuffer[])
}

function reportError(
  request: { epoch: number; batchId: number } | null,
  phase: 'install' | 'plan' | 'compute',
  error: unknown,
): void {
  post({
    kind: 'error',
    epoch: request?.epoch ?? -1,
    batchId: request?.batchId ?? -1,
    phase,
    message: error instanceof Error ? error.stack ?? error.message : String(error),
  })
}

post({ kind: 'ready', protocolVersion: protocol.ROTARY_ANGLE_PROTOCOL_VERSION })

parentPort?.on('message', (message: unknown) => {
  if (!protocol.isRotaryAngleWorkerRequest(message)) {
    reportError(null, 'compute', new Error(`rotary angle worker: unreadable request ${String(message)}`))
    return
  }
  const request: RotaryAngleWorkerRequest = message
  try {
    switch (request.kind) {
      case 'install':
        if (request.protocolVersion !== protocol.ROTARY_ANGLE_PROTOCOL_VERSION) {
          throw new Error(
            `rotary angle worker: protocol version ${request.protocolVersion}`
            + ` is not ${protocol.ROTARY_ANGLE_PROTOCOL_VERSION}`,
          )
        }
        kernel = kernels.createRotaryAngleKernel(request.setup)
        post({ kind: 'installed', protocolVersion: protocol.ROTARY_ANGLE_PROTOCOL_VERSION })
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
        // Rows, and any maps the parent asked for (#1103 slice ca-i), are this
        // thread's own freshly allocated arrays: transfer them rather than let
        // the clone copy each one. Nothing here reads a sample after posting.
        post(
          { kind: 'result', epoch: request.epoch, batchId: request.batchId, samples },
          protocol.rotaryAngleSampleTransfer(samples),
        )
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
})
