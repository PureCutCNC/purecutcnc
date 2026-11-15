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
 * The two-face run (issue #1206 slice 4): one worker per face, one after the
 * other, the second looking at the mesh with Z negated; one progress bar that
 * gives the first face the first half; and a cancel that starts nothing more.
 *
 * Mutation checks (each made the named test fail, then was reverted):
 * - `recognizeFaces.ts`, both faces run at once (no `await`)  -> the run order
 * - `recognizeFaces.ts`, the Bottom run fed the original mesh  -> the turned mesh
 * - `recognizeFaces.ts`, progress passed through unwrapped     -> progress
 * - `recognizeFaces.ts`, the first run's rejection swallowed   -> cancel
 *
 * Run with: npx tsx src/components/modelRecognition/recognizeFaces.test.ts
 */

import type { RecognitionMesh } from '../../engine/modelRecognition'
import { RecognitionCancelledError, type RecognitionWorkerLike } from './recognitionClient'
import type { RecognitionWorkerRequest, RecognitionWorkerResponse } from './recognition.worker'
import { recognizeModelFaces } from './recognizeFaces'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

/** A 10 x 10 x 4 box: a closed mesh with nothing to find. */
function boxMesh(): RecognitionMesh {
  const positions = new Float32Array([
    0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0,
    0, 0, 4, 10, 0, 4, 10, 10, 4, 0, 10, 4,
  ])
  const index = new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ])
  return { positions, index }
}

/** Answers each request with a scripted list of messages, one microtask apart. */
class FakeWorker implements RecognitionWorkerLike {
  onmessage: ((event: MessageEvent<RecognitionWorkerResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  posted: RecognitionWorkerRequest[] = []
  /** The values as they were before the transfer detached the buffers. */
  sent: Array<{ positions: number[]; index: number[] }> = []
  terminated = 0
  private readonly reply: (request: RecognitionWorkerRequest) => RecognitionWorkerResponse[]
  constructor(reply: (request: RecognitionWorkerRequest) => RecognitionWorkerResponse[]) {
    this.reply = reply
  }
  postMessage(message: RecognitionWorkerRequest, transfer: Transferable[]): void {
    this.posted.push(message)
    this.sent.push({ positions: Array.from(message.positions), index: Array.from(message.index) })
    // A real worker takes the transferred buffers away from the sender.
    for (const buffer of transfer) structuredClone(buffer, { transfer: [buffer] })
    const replies = this.reply(message)
    void (async () => {
      for (const data of replies) {
        await Promise.resolve()
        if (this.terminated > 0) return
        this.onmessage?.({ data } as MessageEvent<RecognitionWorkerResponse>)
      }
    })()
  }
  terminate(): void {
    this.terminated += 1
  }
}

const EMPTY = { cavities: [], skipped: [], solids: [], skippedSolids: [], levelsTruncated: false, meshOpen: false }
const STEPS: RecognitionWorkerResponse[] = [
  { type: 'progress', fraction: 0.25 },
  { type: 'progress', fraction: 0.5 },
  { type: 'progress', fraction: 1 },
  { type: 'result', result: EMPTY },
]

async function testOneFaceOneRequest(): Promise<void> {
  const workers: FakeWorker[] = []
  const heard: number[] = []
  const combined = await recognizeModelFaces(boxMesh(), ['top'], 'mm', {
    createWorker: () => {
      const worker = new FakeWorker(() => STEPS)
      workers.push(worker)
      return worker
    },
    onProgress: (fraction) => heard.push(fraction),
  })
  assert(workers.length === 1, `one face: one worker, got ${workers.length}`)
  assert(workers[0].posted.length === 1 && workers[0].posted[0].type === 'recognize', 'one face: one request posted')
  assert(combined.candidates.length === 0, 'one face: an empty result is combined')
  assert(heard.join(',') === '0.25,0.5,1', `one face: progress passes through, got ${heard.join(',')}`)
}

async function testTwoFacesTurnedMesh(): Promise<void> {
  const workers: FakeWorker[] = []
  const aliveAtCreation: number[] = []
  await recognizeModelFaces(boxMesh(), ['top', 'bottom'], 'mm', {
    createWorker: () => {
      aliveAtCreation.push(workers.filter((worker) => worker.terminated === 0).length)
      const worker = new FakeWorker(() => STEPS)
      workers.push(worker)
      return worker
    },
  })
  assert(workers.length === 2, `two faces: two workers, got ${workers.length}`)
  assert(workers[0].posted.length === 1 && workers[1].posted.length === 1, 'two faces: one request each')
  const top = workers[0].sent[0]
  const bottom = workers[1].sent[0]
  assert(
    bottom.positions.every((value, i) => (
      i % 3 === 2 ? value === -top.positions[i] || (value === 0 && top.positions[i] === 0) : value === top.positions[i]
    )),
    'two faces: the second request has every Z of the first negated, and the same X and Y',
  )
  assert(
    bottom.index.every((value, i) => value === (i % 3 === 1
      ? top.index[i + 1]
      : i % 3 === 2 ? top.index[i - 1] : value)) && bottom.index.length === top.index.length,
    'two faces: the winding is reversed, so the faces still point outward',
  )
  assert(aliveAtCreation[1] === 0, 'two faces: the first worker is dead before the second starts')
  assert(workers[0].terminated === 1 && workers[1].terminated === 1, 'two faces: both workers are terminated')
}

async function testProgressHalves(): Promise<void> {
  const heard: number[] = []
  let heardAtSecondStart = -1
  const workers: FakeWorker[] = []
  await recognizeModelFaces(boxMesh(), ['top', 'bottom'], 'mm', {
    createWorker: () => {
      if (workers.length === 1) heardAtSecondStart = heard.length
      const worker = new FakeWorker(() => STEPS)
      workers.push(worker)
      return worker
    },
    onProgress: (fraction) => heard.push(fraction),
  })
  assert(heard.length === 6, `progress: every step is heard once, got ${heard.length}`)
  assert(
    heard.every((fraction, i) => i === 0 || fraction >= heard[i - 1]),
    `progress: non-decreasing, got ${heard.join(',')}`,
  )
  assert(heard[heardAtSecondStart - 1] === 0.5, `progress: the first face ends at 0.5, got ${heard[heardAtSecondStart - 1]}`)
  assert(heard[heard.length - 1] === 1, 'progress: the second face reaches 1')
}

async function testCancelStartsNothingMore(): Promise<void> {
  const controller = new AbortController()
  let created = 0
  let cancelled = false
  try {
    await recognizeModelFaces(boxMesh(), ['top', 'bottom'], 'mm', {
      createWorker: () => {
        created += 1
        return new FakeWorker(() => STEPS)
      },
      signal: controller.signal,
      onProgress: () => controller.abort(),
    })
  } catch (error: unknown) {
    cancelled = error instanceof RecognitionCancelledError
  }
  assert(cancelled, 'cancel: rejects with RecognitionCancelledError')
  assert(created === 1, `cancel: no second request is posted, got ${created} worker(s)`)
}

await testOneFaceOneRequest()
await testTwoFacesTurnedMesh()
await testProgressHalves()
await testCancelStartsNothingMore()
console.log('modelRecognition/recognizeFaces.test.ts: all assertions passed')
