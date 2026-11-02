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
 * The main thread's half of the browser angle pool (issue #1115, slice p-d3).
 *
 * The design puts **worker creation and termination on the main thread** and the
 * coordinator in the generation worker. This module is the first half: it owns
 * the `Worker` objects, wires each one's `ready` handshake, and transfers the
 * coordinator's port into it. It never sees a mesh, an angle or a height map —
 * the only thing it ever posts is the port.
 *
 * Two facts make the split work:
 *
 * - the `MessageChannel` is made by the coordinator, so the port it hands over
 *   is already the channel the pool will talk on; the main thread is a relay,
 *   not a proxy, and no result ever passes through this thread;
 * - a worker that cannot start, or that dies, is reported back to the
 *   coordinator as a **failure**, which is the pool's signal to rerun the batch
 *   serially. A browser that cannot start a module worker (a missing chunk, a
 *   CSP refusal, a webview with workers disabled) therefore still generates.
 *
 * The default factory is the only browser-specific line in the file, and it is
 * the `new URL(..., import.meta.url)` form the bundler statically recognises —
 * the shape that keeps the chunk resolvable under the app's relative `base`,
 * static hosting under a nested path, and the packaged Tauri asset protocol.
 */

import { ROTARY_ANGLE_PROTOCOL_VERSION } from '../../engine/toolpaths/rotaryAngleProtocol'

/** How long a created worker has to report `ready`. Startup only. */
export const ROTARY_ANGLE_WORKER_STARTUP_TIMEOUT_MS = 10_000

/** A created angle worker, as both a browser `Worker` and Node expose it. */
export interface RotaryAngleHostWorker {
  postMessage(message: unknown, transfer?: Transferable[]): void
  addEventListener(type: 'message', handler: (event: MessageEvent<unknown>) => void): void
  addEventListener(type: 'error', handler: (event: unknown) => void): void
  addEventListener(type: 'messageerror', handler: (event: unknown) => void): void
  terminate(): void
}

export type RotaryAngleHostWorkerFactory = () => RotaryAngleHostWorker

/**
 * The production factory. The `new URL(..., import.meta.url)` form is required:
 * it is what the bundler statically recognises as a worker entry, so the angle
 * worker becomes its own content-hashed chunk resolved relative to the app —
 * the same reason `workerExecutor.ts`'s generation worker is built that way.
 */
export function createDefaultRotaryAngleWorker(): RotaryAngleHostWorker {
  return new Worker(
    new URL('./rotaryAngle.worker.ts', import.meta.url),
    { type: 'module' },
  ) as unknown as RotaryAngleHostWorker
}

export interface RotaryAnglePoolHostOptions {
  /** Injected by tests; production uses the module worker factory above. */
  readonly createWorker?: RotaryAngleHostWorkerFactory
  readonly startupTimeoutMs?: number
  /**
   * The coordinator could not use the slot. The executor forwards this to the
   * generation worker, which turns it into the pool's serial retry.
   */
  readonly onFailure: (slot: number, message: string) => void
}

export interface RotaryAnglePoolHost {
  /**
   * Create the angle worker for one pool slot around the coordinator's port.
   * Replaces a worker already living at that slot.
   */
  attach(slot: number, port: MessagePort): void
  /** Stop one slot, or every slot when `slot` is omitted. */
  release(slot?: number): void
  /** Stop every worker and refuse new ones. */
  terminate(): void
  /** Workers created minus workers stopped; diagnostics and tests. */
  liveWorkers(): number
}

function messageOf(event: unknown): string {
  if (event instanceof Error) return event.message
  if (typeof event === 'object' && event !== null) {
    const candidate = event as { message?: unknown; error?: unknown }
    if (typeof candidate.message === 'string') return candidate.message
    if (candidate.error instanceof Error) return candidate.error.message
  }
  return 'the angle worker failed'
}

export function createRotaryAnglePoolHost(
  options: RotaryAnglePoolHostOptions,
): RotaryAnglePoolHost {
  const createWorker = options.createWorker ?? createDefaultRotaryAngleWorker
  const startupTimeoutMs = options.startupTimeoutMs ?? ROTARY_ANGLE_WORKER_STARTUP_TIMEOUT_MS
  /**
   * One live slot. `abandon` is what makes replacement safe: terminating a
   * worker mid-handshake must also silence that handshake's timeout, or it
   * fires later against a slot the *next* pool now owns and reports a
   * failure the new pool never had (a real bug this suite caught).
   */
  const workers = new Map<number, { worker: RotaryAngleHostWorker; abandon: () => void }>()
  let disposed = false

  const stop = (slot: number): void => {
    const record = workers.get(slot)
    if (record === undefined) return
    workers.delete(slot)
    record.abandon()
    try {
      record.worker.terminate()
    } catch {
      // A worker that cannot be stopped has already stopped.
    }
  }

  const attach = (slot: number, port: MessagePort): void => {
    if (disposed) {
      port.close?.()
      return
    }
    // A slot's worker is replaced rather than reused, which is what keeps one
    // operation's geometry out of the next.
    stop(slot)

    let worker: RotaryAngleHostWorker
    try {
      worker = createWorker()
    } catch (error) {
      port.close?.()
      options.onFailure(slot, `the angle worker could not be created: ${messageOf(error)}`)
      return
    }
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const abandon = (): void => {
      settled = true
      if (timer !== null) clearTimeout(timer)
    }
    workers.set(slot, { worker, abandon })

    const finish = (failure: string | null): void => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      if (failure === null) return
      stop(slot)
      options.onFailure(slot, failure)
      port.close?.()
    }

    timer = setTimeout(() => {
      finish('the angle worker did not report ready')
    }, startupTimeoutMs)

    worker.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (settled) return
      const message = event.data as { kind?: unknown; protocolVersion?: unknown } | null
      if (typeof message !== 'object' || message === null) return
      if (message.kind !== 'ready') return
      if (message.protocolVersion !== ROTARY_ANGLE_PROTOCOL_VERSION) {
        finish(
          'the angle worker speaks a different protocol version'
          + ` (expected ${ROTARY_ANGLE_PROTOCOL_VERSION}, got ${String(message.protocolVersion)})`,
        )
        return
      }
      settled = true
      if (timer !== null) clearTimeout(timer)
      try {
        // Hand the coordinator's port to the worker. From here on neither this
        // thread nor this map sees a message — only the worker handle.
        worker.postMessage({ kind: 'attach', port }, [port])
      } catch (error) {
        stop(slot)
        options.onFailure(slot, `the angle worker could not be given its channel: ${messageOf(error)}`)
        port.close?.()
      }
    })
    worker.addEventListener('error', (event: unknown) => {
      if (!settled) {
        finish(`the angle worker failed to start: ${messageOf(event)}`)
        return
      }
      // Started, then died: the slot is gone and the coordinator must rerun the
      // batch serially rather than wait for a reply that cannot come.
      stop(slot)
      options.onFailure(slot, `the angle worker stopped: ${messageOf(event)}`)
    })
    worker.addEventListener('messageerror', () => {
      if (!settled) {
        finish('the angle worker answered with a message that failed validation')
        return
      }
      stop(slot)
      options.onFailure(slot, 'the angle worker sent a message that failed validation')
    })
  }

  return {
    attach,
    release(slot) {
      if (slot === undefined) {
        for (const key of [...workers.keys()]) stop(key)
        return
      }
      stop(slot)
    },
    terminate() {
      disposed = true
      for (const key of [...workers.keys()]) stop(key)
    },
    liveWorkers() {
      return workers.size
    },
  }
}
