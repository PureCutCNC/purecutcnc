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

// Worker entry for Find pockets and holes (issue #1206). One mesh per worker:
// the client terminates it on completion, failure and cancellation, because
// the detector is synchronous and would never see a message.

import { recognizeCavities, type ModelRecognitionResult } from '../../engine/modelRecognition'

export interface RecognitionWorkerRequest {
  type: 'recognize'
  positions: Float32Array
  index: Uint32Array
}

export type RecognitionWorkerResponse =
  | { type: 'progress'; fraction: number }
  | { type: 'result'; result: ModelRecognitionResult }
  | { type: 'error'; message: string }

interface RecognitionWorkerScope {
  postMessage(message: RecognitionWorkerResponse): void
  onmessage: ((event: MessageEvent<RecognitionWorkerRequest>) => void) | null
}

declare const self: RecognitionWorkerScope

self.onmessage = (event) => {
  const { positions, index } = event.data
  try {
    const result = recognizeCavities({ positions, index }, {
      onProgress: (fraction) => self.postMessage({ type: 'progress', fraction }),
    })
    self.postMessage({ type: 'result', result })
  } catch (error: unknown) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}
