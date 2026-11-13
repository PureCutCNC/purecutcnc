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
 * The "no effect" analysis worker (issue #1112 N, decision 12).
 *
 * It owns one `FeatureEffectAnalyzer` for the life of the worker, so the
 * per-feature cache survives across edits: the main thread sends the current
 * tree after each debounce, and only the rows a change can affect are
 * recomputed. A result carries the request id it answered, which is what lets
 * the main thread drop a stale answer for an older edit.
 *
 * No store, React or DOM: the analysis input is plain data built on the main
 * thread, and the engine module under it is pure.
 */

import { FeatureEffectAnalyzer } from '../../engine/featureEffect'
import type { FeatureEffectRequest, FeatureEffectResponse } from './protocol'

interface FeatureEffectWorkerScope {
  postMessage(message: FeatureEffectResponse): void
  onmessage: ((event: MessageEvent<FeatureEffectRequest>) => void) | null
}

declare const self: FeatureEffectWorkerScope

const analyzer = new FeatureEffectAnalyzer()

self.onmessage = (event) => {
  const message = event.data
  if (message.type !== 'analyze') return
  try {
    const warnings = [...analyzer.analyze(message.features)]
    self.postMessage({ type: 'result', requestId: message.requestId, warnings })
  } catch (error: unknown) {
    self.postMessage({
      type: 'error',
      requestId: message.requestId,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}
