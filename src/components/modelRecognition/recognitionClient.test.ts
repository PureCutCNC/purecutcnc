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
 * Recognition worker client (issue #1206): every way out terminates the
 * worker, a cancel rejects with RecognitionCancelledError, progress is
 * forwarded, the caller's mesh buffers survive the hand-over, and without a
 * Worker the run happens inline with the same result.
 *
 * Mutation checks (each made the named test fail, then was reverted):
 * - the mesh transferred without `slice()`        -> buffers
 * - `terminate()` dropped from `finish`          -> result, failure, cancel
 * - the inline fallback removed                   -> inline
 *
 * Run with: npx tsx src/components/modelRecognition/recognitionClient.test.ts
 */

import { recognizeCavities, type RecognitionMesh } from '../../engine/modelRecognition'
import type { RecognitionWorkerRequest, RecognitionWorkerResponse } from './recognition.worker'
import { RecognitionCancelledError, runModelRecognition, type RecognitionWorkerLike } from './recognitionClient'

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

/** Answers the request with a scripted list of messages, one microtask apart. */
class FakeWorker implements RecognitionWorkerLike {
  onmessage: ((event: MessageEvent<RecognitionWorkerResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  posted: RecognitionWorkerRequest[] = []
  transferred: Transferable[][] = []
  terminated = 0
  private readonly reply: (request: RecognitionWorkerRequest) => RecognitionWorkerResponse[]
  constructor(reply: (request: RecognitionWorkerRequest) => RecognitionWorkerResponse[]) {
    this.reply = reply
  }
  postMessage(message: RecognitionWorkerRequest, transfer: Transferable[]): void {
    this.posted.push(message)
    this.transferred.push(transfer)
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

async function testResultAndProgress(): Promise<void> {
  const worker = new FakeWorker(() => [
    { type: 'progress', fraction: 0.5 },
    { type: 'progress', fraction: 1 },
    { type: 'result', result: EMPTY },
  ])
  const heard: number[] = []
  const result = await runModelRecognition(boxMesh(), {
    createWorker: () => worker,
    onProgress: (fraction) => heard.push(fraction),
  })
  assert(result === EMPTY, 'result: the worker\'s result is returned')
  assert(heard.join(',') === '0.5,1', `result: progress is forwarded in order, got ${heard.join(',')}`)
  assert(worker.posted.length === 1 && worker.posted[0].type === 'recognize', 'result: one request posted')
  assert(worker.terminated === 1, 'result: worker terminated after')
}

async function testBuffersSurvive(): Promise<void> {
  const mesh = boxMesh()
  const worker = new FakeWorker(() => [{ type: 'result', result: EMPTY }])
  await runModelRecognition(mesh, { createWorker: () => worker })
  assert(mesh.positions.length === 24 && mesh.index.length === 36, 'buffers: the caller\'s mesh is intact after the hand-over')
  assert(worker.transferred[0].length === 2, 'buffers: both copies were transferred')
  assert(worker.posted[0].positions !== mesh.positions, 'buffers: the worker got a copy')
}

async function testFailure(): Promise<void> {
  const worker = new FakeWorker(() => [{ type: 'error', message: 'boom' }])
  let message = ''
  try {
    await runModelRecognition(boxMesh(), { createWorker: () => worker })
  } catch (error: unknown) {
    message = error instanceof Error ? error.message : ''
  }
  assert(message === 'boom', 'failure: the worker\'s message is the rejection')
  assert(worker.terminated === 1, 'failure: worker terminated after')
}

async function testCancel(): Promise<void> {
  const worker = new FakeWorker(() => [
    { type: 'progress', fraction: 0.25 },
    { type: 'progress', fraction: 0.5 },
    { type: 'result', result: EMPTY },
  ])
  const controller = new AbortController()
  const heard: number[] = []
  const run = runModelRecognition(boxMesh(), {
    createWorker: () => worker,
    signal: controller.signal,
    onProgress: (fraction) => {
      heard.push(fraction)
      controller.abort()
    },
  })
  let cancelled = false
  try {
    await run
  } catch (error: unknown) {
    cancelled = error instanceof RecognitionCancelledError
  }
  assert(cancelled, 'cancel: rejects with RecognitionCancelledError')
  assert(worker.terminated === 1, 'cancel: worker terminated')
  assert(heard.length === 1, 'cancel: nothing is heard after the cancel')

  const already = new AbortController()
  already.abort()
  let created = 0
  let refused = false
  try {
    await runModelRecognition(boxMesh(), { signal: already.signal, createWorker: () => { created += 1; return worker } })
  } catch (error: unknown) {
    refused = error instanceof RecognitionCancelledError
  }
  assert(refused && created === 0, 'cancel: an already-aborted run starts no worker')
}

async function testInline(): Promise<void> {
  const mesh = boxMesh()
  const heard: number[] = []
  const inline = await runModelRecognition(mesh, { createWorker: () => null, onProgress: (fraction) => heard.push(fraction) })
  assert(JSON.stringify(inline) === JSON.stringify(recognizeCavities(mesh)), 'inline: the same result as the detector')
  assert(heard.length > 0 && heard[heard.length - 1] === 1, 'inline: progress reaches 1')
  const throwing = await runModelRecognition(mesh, { createWorker: () => { throw new Error('no workers here') } })
  assert(throwing.cavities.length === 0, 'inline: a factory that throws falls back too')
}

await testResultAndProgress()
await testBuffersSurvive()
await testFailure()
await testCancel()
await testInline()
console.log('modelRecognition/recognitionClient.test.ts: all assertions passed')
