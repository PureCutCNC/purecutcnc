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
 * The main-thread half of the "no effect" worker (issue #1112 N).
 *
 * Two rules make the warning trustworthy while the user edits:
 *
 * - **Debounced after edits settle.** A request only reaches the worker
 *   `debounceMs` after the last edit, so a drag or a burst of property changes
 *   produces one analysis instead of one per keystroke.
 * - **A stale answer never lands.** Every request gets a monotonically
 *   increasing id; a result or error whose id is not the latest is dropped.
 *   The previous warnings stay visible until the newer answer arrives, so the
 *   tree does not flicker on every edit.
 *
 * Cancellation is `terminate()`: the analysis is synchronous in the worker and
 * would never see a cancel message in time. Disposing is the only teardown.
 */

import type { FeatureEffectFeature } from '../../engine/featureEffect'
import type { FeatureEffectRequest, FeatureEffectResponse } from './protocol'

export interface FeatureEffectWorkerLike {
  postMessage(message: FeatureEffectRequest): void
  terminate(): void
  onmessage: ((event: MessageEvent<FeatureEffectResponse>) => void) | null
  onerror: ((event: Event) => void) | null
}

export type FeatureEffectWorkerFactory = () => FeatureEffectWorkerLike | null

/** The bundled worker, or null where a Worker cannot be constructed. */
export function createDefaultFeatureEffectWorker(): FeatureEffectWorkerLike | null {
  if (typeof Worker === 'undefined') return null
  return new Worker(
    new URL('./featureEffect.worker.ts', import.meta.url),
    { type: 'module' },
  ) as unknown as FeatureEffectWorkerLike
}

export interface FeatureEffectClientOptions {
  onResult: (warnings: ReadonlySet<string>) => void
  onError?: (message: string) => void
  /** Quiet period after the last edit before the tree is sent. */
  debounceMs?: number
  createWorker?: FeatureEffectWorkerFactory
  /** Injected so a test can drive the debounce without real timers. */
  schedule?: (callback: () => void, delayMs: number) => unknown
  cancel?: (handle: unknown) => void
}

const DEFAULT_DEBOUNCE_MS = 200

export class FeatureEffectClient {
  private readonly options: FeatureEffectClientOptions
  private worker: FeatureEffectWorkerLike | null = null
  private latestRequestId = 0
  private timer: unknown = null
  private disposed = false

  constructor(options: FeatureEffectClientOptions) {
    this.options = options
  }

  /**
   * Queue an analysis of the current tree. `produce` runs only when the
   * debounce fires, so the expensive part of resolving Text and canned
   * outlines is paid once, after the edit settles.
   */
  request(produce: () => readonly FeatureEffectFeature[]): void {
    if (this.disposed) return
    this.latestRequestId += 1
    const requestId = this.latestRequestId
    this.cancelTimer()
    const schedule = this.options.schedule
      ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs))
    this.timer = schedule(() => {
      this.timer = null
      if (this.disposed) return
      let features: readonly FeatureEffectFeature[]
      try {
        features = produce()
      } catch (error: unknown) {
        this.fail(error instanceof Error ? error.message : String(error))
        return
      }
      const worker = this.ensureWorker()
      if (!worker) {
        this.fail('the feature-effect worker is unavailable')
        return
      }
      worker.postMessage({ type: 'analyze', requestId, features })
    }, this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS)
  }

  dispose(): void {
    this.disposed = true
    this.cancelTimer()
    this.worker?.terminate()
    this.worker = null
  }

  private cancelTimer(): void {
    if (this.timer === null) return
    const cancel = this.options.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    cancel(this.timer)
    this.timer = null
  }

  private ensureWorker(): FeatureEffectWorkerLike | null {
    if (this.worker) return this.worker
    try {
      this.worker = (this.options.createWorker ?? createDefaultFeatureEffectWorker)()
    } catch {
      this.worker = null
    }
    if (!this.worker) return null
    this.worker.onmessage = (event) => this.receive(event.data)
    this.worker.onerror = () => {
      // A dead worker answers nothing, so drop it: the next edit gets a fresh
      // one instead of posting into a thread that will never reply.
      const failed = this.worker
      this.worker = null
      failed?.terminate()
      this.fail('the feature-effect worker failed')
    }
    return this.worker
  }

  private receive(message: FeatureEffectResponse | undefined): void {
    if (this.disposed || !message) return
    // The one line that makes a stale answer impossible to show: a result for
    // an edit the user has already superseded is not the current tree.
    if (message.requestId !== this.latestRequestId) return
    if (message.type === 'result') {
      this.options.onResult(new Set(message.warnings))
    } else {
      this.options.onError?.(message.message)
    }
  }

  private fail(message: string): void {
    if (this.disposed) return
    this.options.onError?.(message)
  }
}
