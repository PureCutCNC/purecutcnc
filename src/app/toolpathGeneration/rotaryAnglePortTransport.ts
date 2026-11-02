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
 * The coordinator's half of the browser angle-pool transport (issue #1115,
 * slice p-d3).
 *
 * Runs inside the **generation worker**, where the pool is created. For each
 * pool slot it makes a `MessageChannel`, hands one end to the main thread via
 * {@link RotaryAnglePortTransportOptions.requestWorker}, and adapts the other
 * end to the pool's {@link RotaryAngleWorkerPort}. The main thread creates the
 * angle worker around that port; from then on requests and replies travel
 * directly between the two workers.
 *
 * Why the channel is made *here* rather than on the main thread: the
 * coordinator is the only party that knows the setup payload, and the design
 * forbids the main thread touching mesh data. This side creates the channel,
 * the main thread creates the thread, and the two never exchange geometry.
 *
 * Three behaviours the pool depends on, each with a case that would otherwise
 * hang a batch:
 *
 * - a worker that cannot be created or that attaches and then dies arrives as
 *   {@link RotaryAnglePortTransport.fail} — the pool's setup-failure signal,
 *   which discards the batch and reruns it serially;
 * - a port that is never answered at all (a host that never replies) fails on a
 *   timeout rather than leaving the install wait pending for ever;
 * - a port whose reply is not a well-formed reply fails the slot instead of
 *   being forwarded as if it were one.
 */

import type { RotaryAngleWorkerPort, RotaryAngleWorkerSource } from '../../engine/toolpaths/rotaryAnglePool'
import type {
  RotaryAngleWorkerReply,
  RotaryAngleWorkerRequest,
} from '../../engine/toolpaths/rotaryAngleProtocol'
import { isRotaryAngleWorkerReply } from '../../engine/toolpaths/rotaryAngleProtocol'

/** One end of the channel, as both a browser worker and Node expose it. */
export interface RotaryAngleMessagePort {
  postMessage(message: unknown, transfer?: Transferable[]): void
  onmessage: ((event: { data: unknown }) => void) | null
  onmessageerror?: ((event: unknown) => void) | null
  start?: () => void
  close?: () => void
}

export interface RotaryAnglePortTransportOptions {
  /**
   * The machine's parallelism, handed to the pool. Omitted means "unknown",
   * which the pool answers with serial execution rather than a guess.
   */
  readonly availableParallelism?: number
  /**
   * Send one channel end to whoever creates the worker (`self.postMessage`).
   * `slot` is unique for the life of this generation worker; see
   * `RotaryWorkerRequestMessage.slot` for why it is not the pool's index.
   */
  readonly requestWorker: (port: MessagePort, slot: number) => void
  /** Ask the creator to stop one slot. */
  readonly releaseWorker: (slot: number) => void
  /**
   * How long a slot may go without any reply before it is declared dead. The
   * main thread has its own, shorter startup budget; this one only exists so a
   * lost host cannot leave a batch pending.
   */
  readonly startupTimeoutMs?: number
}

export interface RotaryAnglePortTransport {
  /** The pool's worker source: same pool, module workers instead of threads. */
  readonly source: RotaryAngleWorkerSource
  /** Report a slot the creator could not start or has lost. */
  fail(slot: number, message: string): void
  /** Stop every slot and refuse new ones. */
  dispose(): void
  /** Slots created and not yet released; diagnostics for the coordinator. */
  readonly slots: number
}

/** A slot: its channel end, its handlers, and whether it is still usable. */
interface Slot {
  /** The pool's own worker index, used only in error messages. */
  readonly index: number
  readonly port: RotaryAngleMessagePort
  timer: ReturnType<typeof setTimeout> | null
  replyHandler: ((reply: RotaryAngleWorkerReply) => void) | null
  failureHandler: ((error: Error) => void) | null
  readonly buffered: RotaryAngleWorkerReply[]
  bufferedFailure: Error | null
  closed: boolean
}

/**
 * Slot ids, unique for the life of this realm.
 *
 * Deliberately not per-transport and not the pool's worker index: a superseded
 * pool's releases are posted while its successor is already requesting workers,
 * so the two pools' indices coexist on the wire. A release must be able to name
 * exactly one worker, and only a minted id can.
 */
let nextSlot = 1

/**
 * Create the coordinator's transport.
 *
 * `requestWorker` is the only runtime-specific call: the generation worker
 * passes `self.postMessage`, so the message shape (and its transferred port) is
 * identical in a browser and in the Node test harness that runs the shipped
 * worker module on a `worker_threads` thread.
 */
export function createRotaryAnglePortTransport(
  options: RotaryAnglePortTransportOptions,
): RotaryAnglePortTransport {
  const timeoutMs = options.startupTimeoutMs ?? 30_000
  const slots = new Map<number, Slot>()
  let disposed = false

  const clear = (slot: Slot): void => {
    if (slot.timer !== null) clearTimeout(slot.timer)
  }

  const shutdown = (slot: number, done: Slot, error: Error): void => {
    if (done.closed) return
    done.closed = true
    clear(done)
    if (done.failureHandler !== null) done.failureHandler(error)
    else done.bufferedFailure = error
    try {
      done.port.close?.()
    } catch {
      // Closing a port that is already gone is not a failure of its own.
    }
    if (slots.get(slot) === done) slots.delete(slot)
  }

  const deliver = (slot: number, entry: Slot, reply: RotaryAngleWorkerReply): void => {
    if (entry.closed) return
    if (!isRotaryAngleWorkerReply(reply)) {
      shutdown(slot, entry, new Error(`rotary angle worker ${entry.index} sent a message that failed validation`))
      return
    }
    // An error with no epoch means the sender could not name a generation: the
    // worker never attached, so there is no batch for the pool to answer. It is
    // a transport failure, not a reply the pool could match to a batch.
    if (reply.kind === 'error' && reply.epoch < 0) {
      shutdown(slot, entry, new Error(`rotary angle worker ${entry.index}: ${reply.message}`))
      return
    }
    clear(entry)
    if (entry.replyHandler !== null) entry.replyHandler(reply)
    else entry.buffered.push(reply)
  }

  const createSlot = (index: number): RotaryAngleWorkerPort => {
    if (disposed) throw new Error('rotary angle pool: the angle worker source is disposed')
    if (typeof MessageChannel === 'undefined') {
      throw new Error('rotary angle pool: this runtime has no MessageChannel')
    }
    const slot = nextSlot
    nextSlot += 1
    const channel = new MessageChannel()
    const entry: Slot = {
      index,
      port: channel.port1 as unknown as RotaryAngleMessagePort,
      timer: null,
      replyHandler: null,
      failureHandler: null,
      buffered: [],
      bufferedFailure: null,
      closed: false,
    }
    slots.set(slot, entry)
    const timer = setTimeout(() => {
      shutdown(slot, entry, new Error(`rotary angle worker ${index} did not start`))
    }, timeoutMs)
    // A pending timer must not keep a Node process alive while a batch waits on
    // real replies; the port's messages are what keep the thread busy.
    ;(timer as unknown as { unref?: () => void }).unref?.()
    entry.timer = timer

    entry.port.onmessage = (event: { data: unknown }) => {
      deliver(slot, entry, event.data as RotaryAngleWorkerReply)
    }
    entry.port.onmessageerror = () => {
      shutdown(slot, entry, new Error(`rotary angle worker ${index}: a reply could not be deserialised`))
    }
    try {
      options.requestWorker(channel.port2, slot)
    } catch (error) {
      shutdown(slot, entry, error instanceof Error ? error : new Error(String(error)))
    }
    return {
      post(message: RotaryAngleWorkerRequest, transfer: readonly ArrayBuffer[]): void {
        if (entry.closed) throw new Error(`rotary angle worker ${index} is no longer running`)
        entry.port.postMessage(message, transfer as Transferable[])
      },
      onReply(handler) {
        entry.replyHandler = handler
        while (entry.buffered.length > 0) handler(entry.buffered.shift()!)
      },
      onFailure(handler) {
        entry.failureHandler = handler
        if (entry.bufferedFailure !== null) {
          const error = entry.bufferedFailure
          entry.bufferedFailure = null
          handler(error)
        }
      },
      terminate() {
        if (entry.closed) return
        entry.closed = true
        clear(entry)
        if (slots.get(slot) === entry) slots.delete(slot)
        try {
          entry.port.close?.()
        } catch {
          // Already gone.
        }
        options.releaseWorker(slot)
      },
    }
  }

  return {
    source: {
      ...(options.availableParallelism !== undefined
        ? { availableParallelism: options.availableParallelism }
        : {}),
      create: createSlot,
    },
    fail(slot, message) {
      const entry = slots.get(slot)
      if (entry === undefined) return
      shutdown(slot, entry, new Error(message))
    },
    dispose() {
      if (disposed) return
      disposed = true
      // Only this transport's own slots are released: a wildcard here would
      // stop the workers of a pool that has already taken over.
      for (const [slot, entry] of [...slots]) {
        entry.closed = true
        clear(entry)
        try {
          entry.port.close?.()
        } catch {
          // Already gone.
        }
        slots.delete(slot)
        options.releaseWorker(slot)
      }
    },
    get slots() {
      return slots.size
    },
  }
}
