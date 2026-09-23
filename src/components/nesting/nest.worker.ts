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
// terminates it on completion, failure and cancellation.

import { nest, requestFromJob, type NestJob, type NestResult } from '../../engine/nesting'

export type NestWorkerResponse =
  | { type: 'result'; result: NestResult }
  | { type: 'error'; message: string }

interface NestWorkerScope {
  postMessage(message: NestWorkerResponse): void
  onmessage: ((event: MessageEvent<NestJob>) => void) | null
}

declare const self: NestWorkerScope

self.onmessage = (event) => {
  try {
    self.postMessage({ type: 'result', result: nest(requestFromJob(event.data)) })
  } catch (error: unknown) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}
