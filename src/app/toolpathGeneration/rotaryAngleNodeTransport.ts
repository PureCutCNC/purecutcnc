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
 * The Node `worker_threads` transport for the angle pool (#1115 slice p-d2).
 *
 * This is the parent half of the pair: it creates one `worker_threads` worker per
 * pool slot and adapts it to {@link RotaryAngleWorkerPort}. The worker half is
 * `rotaryAngleWorkerAdapter.ts`, which runs the shipped kernel module unmodified.
 * The pattern is the one `workerThreadAdapter.ts` established for the generation
 * worker (issue #675), and it is deliberately the *only* Node-specific piece of
 * the pool: p-d3 supplies a browser source instead, and nothing in the engine
 * learns which runtime it is on.
 *
 * Two properties matter and are pinned by the pool tests:
 *
 * - a worker that never starts, or exits, is reported as a **failure** rather
 *   than becoming a reply that never comes, so the pool can fall back serially;
 * - a message posted before the worker's module has run is buffered by
 *   `MessagePort`, not dropped, so the install can be sent immediately.
 */

import { availableParallelism } from 'node:os'
import { Worker } from 'node:worker_threads'

import type { RotaryAngleWorkerPort, RotaryAngleWorkerSource } from '../../engine/toolpaths/rotaryAnglePool'
import type { RotaryAngleWorkerReply, RotaryAngleWorkerRequest } from '../../engine/toolpaths/rotaryAngleProtocol'
import { isRotaryAngleWorkerReply } from '../../engine/toolpaths/rotaryAngleProtocol'

const ADAPTER_URL = new URL('./rotaryAngleWorkerAdapter.ts', import.meta.url).href

/**
 * A plain-JavaScript bootstrap, evaluated as the worker's entry.
 *
 * Pointing `new Worker()` straight at the TypeScript adapter works on Node 26
 * but fails on Node 20 — which is what CI runs — with
 * `ERR_UNKNOWN_FILE_EXTENSION`: the worker's entry is resolved before the
 * TypeScript hooks `--import tsx` registers are in effect. A dynamic `import()`
 * from an already-running plain-JS entry happens after registration, so it does.
 * An unhandled rejection here would otherwise surface as a worker that simply
 * never answers, which the pool would report as a timeout-shaped failure with no
 * cause.
 */
const BOOTSTRAP = `
  import('tsx/esm/api')
    .then((tsx) => tsx.tsImport(${JSON.stringify(ADAPTER_URL)}, ${JSON.stringify(import.meta.url)}))
    .catch((error) => {
      require('node:worker_threads').parentPort.postMessage({
        kind: 'error',
        epoch: -1,
        batchId: -1,
        phase: 'install',
        message: 'rotary angle worker bootstrap failed: ' + String(error && error.stack ? error.stack : error),
      })
    })
`

/** One Node worker, adapted to the pool's port contract. */
class NodeRotaryAngleWorkerPort implements RotaryAngleWorkerPort {
  private readonly worker: Worker
  private replyHandler: ((reply: RotaryAngleWorkerReply) => void) | null = null
  private failureHandler: ((error: Error) => void) | null = null
  private readonly bufferedReplies: RotaryAngleWorkerReply[] = []
  private bufferedFailure: Error | null = null
  private terminated = false

  constructor() {
    this.worker = new Worker(BOOTSTRAP, { eval: true })
    this.worker.on('message', (data: unknown) => {
      if (isRotaryAngleWorkerReply(data)) this.deliver(data)
    })
    this.worker.on('error', (error: Error) => {
      this.fail(error)
    })
    this.worker.on('exit', (code: number) => {
      if (this.terminated) return
      this.fail(new Error(`rotary angle worker exited with code ${code}`))
    })
  }

  private deliver(reply: RotaryAngleWorkerReply): void {
    if (this.replyHandler === null) this.bufferedReplies.push(reply)
    else this.replyHandler(reply)
  }

  private fail(error: Error): void {
    if (this.terminated) return
    this.terminated = true
    if (this.failureHandler === null) this.bufferedFailure = error
    else this.failureHandler(error)
  }

  post(message: RotaryAngleWorkerRequest, transfer: readonly ArrayBuffer[]): void {
    this.worker.postMessage(message, transfer as ArrayBuffer[])
  }

  onReply(handler: (reply: RotaryAngleWorkerReply) => void): void {
    this.replyHandler = handler
    while (this.bufferedReplies.length > 0) handler(this.bufferedReplies.shift()!)
  }

  onFailure(handler: (error: Error) => void): void {
    this.failureHandler = handler
    if (this.bufferedFailure !== null) {
      const error = this.bufferedFailure
      this.bufferedFailure = null
      handler(error)
    }
  }

  async terminate(): Promise<void> {
    if (this.terminated) return
    this.terminated = true
    await this.worker.terminate()
  }
}

/**
 * A source that starts Node `worker_threads` workers.
 *
 * `availableParallelism` is the OS answer (`os.availableParallelism()`, which
 * respects the process's own CPU affinity rather than the whole machine); the
 * pool subtracts its two reserved cores from it. A caller may override it to
 * pin a measurement to a chosen number of workers.
 */
export function createNodeRotaryAngleWorkerSource(options: {
  readonly availableParallelism?: number
} = {}): RotaryAngleWorkerSource {
  return {
    availableParallelism: options.availableParallelism ?? availableParallelism(),
    create: () => new NodeRotaryAngleWorkerPort(),
  }
}
