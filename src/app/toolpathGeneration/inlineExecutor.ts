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
 * The compatibility backend (issue #675): generation on the main thread, the
 * way it has always run, behind the asynchronous service contract.
 *
 * It exists so consumers can be migrated to the async API in one step, with the
 * threading change as a separate, revertible decision — and so a user whose
 * platform cannot start a worker still has a working application.
 *
 * Its limitation is real and is not papered over: while a generator runs, this
 * thread is inside it. `terminate()` cannot interrupt that. What it can do is
 * guarantee the abandoned computation's result is never installed, which is
 * what makes Stop *correct* here even though it is not *immediate*.
 */

import { computeOperationToolpath } from '../../engine/toolpaths'
import { resolveOperation } from './protocol'

/**
 * Wait for a real paint before blocking the thread.
 *
 * Double rAF: the first callback fires before the current paint, the second in
 * the next frame — so the browser is guaranteed one paint in between. This is
 * the shipped behaviour the rAF pipeline provided and it is load-bearing twice
 * over. It is what lets the spinner appear before computation blocks, and it is
 * what lets anything else already queued on the main thread run to completion
 * first: yielding only a microtask hands control back inside the same task, so
 * a caller still waiting on its own promise never gets to observe it.
 *
 * Falls back to a macrotask where there is no rAF — Node tests, and any worker
 * that ends up constructing this backend.
 */
function afterNextPaint(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })
      return
    }
    setTimeout(resolve, 0)
  })
}
import type { ExecutorRequest, GenerationExecutor } from './executor'
import type { GenerationOutcome, GenerationStage } from './types'

export function createInlineExecutor(epoch: number): GenerationExecutor {
  let terminated = false
  let disposed = false

  return {
    kind: 'inline',
    epoch,
    supportsHardCancellation: false,

    async run(
      request: ExecutorRequest,
      onStage?: (stage: GenerationStage) => void,
    ): Promise<GenerationOutcome> {
      if (disposed) {
        return { status: 'failed', failure: { category: 'computation', message: 'executor disposed' } }
      }
      if (terminated) return { status: 'cancelled' }

      const operation = resolveOperation(request.project, request.identity.operationId)
      if (!operation) {
        return {
          status: 'failed',
          failure: {
            category: 'computation',
            message: 'operation is not in the submitted snapshot',
            detail: request.identity.operationId,
          },
        }
      }

      await afterNextPaint()
      if (terminated) return { status: 'cancelled' }

      onStage?.('generating')
      try {
        const envelope = computeOperationToolpath(
          request.project,
          operation,
          { trace: request.identity.traceMode },
        )
        // Checked *after* the computation, not before: the flag cannot be
        // observed while a synchronous generator holds the thread, so this is
        // the first moment the decision can be made at all.
        if (terminated) return { status: 'cancelled' }
        if (!envelope) {
          return {
            status: 'failed',
            failure: {
              category: 'computation',
              message: 'no generator for operation kind',
              detail: operation.kind,
            },
          }
        }
        onStage?.('installing')
        return { status: 'completed', result: envelope.result, raw: envelope.raw }
      } catch (error: unknown) {
        return {
          status: 'failed',
          failure: {
            category: 'computation',
            message: error instanceof Error ? error.message : String(error),
            detail: error instanceof Error ? error.stack : undefined,
          },
        }
      }
    },

    terminate(): void {
      terminated = true
    },

    dispose(): void {
      terminated = true
      disposed = true
    },
  }
}
