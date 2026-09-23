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
 * Nest worker client (issue #848): every way out terminates the worker, a
 * cancel rejects with NestCancelledError, and without a Worker the job runs
 * inline with the same result.
 *
 * Run with: npx tsx src/components/nesting/nestWorkerClient.test.ts
 */

import { nest, requestFromJob, type NestJob } from '../../engine/nesting'
import type { NestWorkerResponse } from './nest.worker'
import { NestCancelledError, runNestJob, type NestWorkerLike } from './nestWorkerClient'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]
const job: NestJob = {
  sheet: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 50 }],
  obstacles: [],
  parts: [{ id: 'part', footprint: [square], quantity: 4, rotations: [0] }],
  minimumGap: 3,
  growthPadding: 0.01,
}

class FakeWorker implements NestWorkerLike {
  onmessage: ((event: MessageEvent<NestWorkerResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  posted: NestJob[] = []
  terminated = 0
  private readonly reply: ((job: NestJob) => NestWorkerResponse) | null
  constructor(reply: ((job: NestJob) => NestWorkerResponse) | null) {
    this.reply = reply
  }
  postMessage(message: NestJob): void {
    this.posted.push(message)
    const reply = this.reply
    if (reply) queueMicrotask(() => this.onmessage?.({ data: reply(message) } as MessageEvent<NestWorkerResponse>))
  }
  terminate(): void {
    this.terminated += 1
  }
}

async function testResult(): Promise<void> {
  const worker = new FakeWorker((posted) => ({ type: 'result', result: nest(requestFromJob(posted)) }))
  const result = await runNestJob(job, { createWorker: () => worker })
  assert(result.placements.length === 4, 'four squares placed')
  assert(worker.posted.length === 1 && worker.terminated === 1, 'one job posted, worker terminated after')
}

async function testError(): Promise<void> {
  const worker = new FakeWorker(() => ({ type: 'error', message: 'boom' }))
  let message = ''
  try {
    await runNestJob(job, { createWorker: () => worker })
  } catch (error) {
    message = (error as Error).message
  }
  assert(message === 'boom' && worker.terminated === 1, 'worker error rejects and terminates')
}

async function testCancel(): Promise<void> {
  const worker = new FakeWorker(null) // never answers, like a long pack
  const controller = new AbortController()
  const pending = runNestJob(job, { createWorker: () => worker, signal: controller.signal })
  controller.abort()
  let cancelled = false
  try {
    await pending
  } catch (error) {
    cancelled = error instanceof NestCancelledError
  }
  assert(cancelled && worker.terminated === 1, 'cancel rejects with NestCancelledError and terminates')
}

async function testInlineFallback(): Promise<void> {
  const result = await runNestJob(job, { createWorker: () => null })
  assert(JSON.stringify(result) === JSON.stringify(nest(requestFromJob(job))), 'inline run gives the same result')
}

await testResult()
await testError()
await testCancel()
await testInlineFallback()
console.log('All nest worker client tests passed')
