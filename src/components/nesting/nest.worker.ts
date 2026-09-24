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
// Worker entry for sheet nesting (issue #848). One job per worker: the client
// terminates it on completion, failure and cancellation. An improve job
// (#862) runs until the search stalls, reporting every layout it places.

import { improveNest, nest, requestFromJob, type NestJob, type NestResult } from '../../engine/nesting'
import { throttle } from './nestProgress'

/** How often a one-shot nest reports how many copies it has tried (#869). */
const PLACING_INTERVAL_MS = 250

export type NestWorkerRequest =
  | { type: 'nest'; job: NestJob }
  | { type: 'improve'; job: NestJob; seed?: number }

export type NestWorkerResponse =
  | { type: 'result'; result: NestResult }
  /** A one-shot nest has tried `done` of `total` copies; throttled. */
  | { type: 'placing'; done: number; total: number }
  /** One per layout placed; `best` rides along on the first and on each improvement. */
  | { type: 'progress'; evaluated: number; best?: NestResult }
  | { type: 'done'; evaluated: number }
  | { type: 'error'; message: string }

interface NestWorkerScope {
  postMessage(message: NestWorkerResponse): void
  onmessage: ((event: MessageEvent<NestWorkerRequest>) => void) | null
}

declare const self: NestWorkerScope

self.onmessage = (event) => {
  const message = event.data
  try {
    if (message.type === 'nest') {
      const placing = throttle((done: number, total: number) => {
        self.postMessage({ type: 'placing', done, total })
      }, PLACING_INTERVAL_MS)
      self.postMessage({ type: 'result', result: nest(requestFromJob(message.job), placing) })
      return
    }
    let evaluated = 0
    for (const step of improveNest(requestFromJob(message.job), { seed: message.seed })) {
      evaluated = step.evaluated
      self.postMessage(step.improved || evaluated === 1
        ? { type: 'progress', evaluated, best: step.best }
        : { type: 'progress', evaluated })
    }
    self.postMessage({ type: 'done', evaluated })
  } catch (error: unknown) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}
