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
 * Nest worker client (issues #848, #862): every way out terminates the worker,
 * a cancel rejects with NestCancelledError, without a Worker the job runs
 * inline with the same result, and an improve run forwards its progress.
 *
 * Run with: npx tsx src/components/nesting/nestWorkerClient.test.ts
 */

import { nest, requestFromJob, type NestJob } from '../../engine/nesting'
import type { NestWorkerRequest, NestWorkerResponse } from './nest.worker'
import { improveNestJob, NestCancelledError, runNestJob, type NestImproveUpdate, type NestWorkerLike } from './nestWorkerClient'

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

/** Answers each request with a scripted list of messages, one microtask apart. */
class FakeWorker implements NestWorkerLike {
  onmessage: ((event: MessageEvent<NestWorkerResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  posted: NestWorkerRequest[] = []
  terminated = 0
  private readonly reply: ((request: NestWorkerRequest) => NestWorkerResponse[]) | null
  constructor(reply: ((request: NestWorkerRequest) => NestWorkerResponse[]) | null) {
    this.reply = reply
  }
  postMessage(message: NestWorkerRequest): void {
    this.posted.push(message)
    const replies = this.reply?.(message) ?? []
    void (async () => {
      for (const data of replies) {
        await Promise.resolve()
        if (this.terminated > 0) return
        this.onmessage?.({ data } as MessageEvent<NestWorkerResponse>)
      }
    })()
  }
  terminate(): void {
    this.terminated += 1
  }
}

async function testResult(): Promise<void> {
  const worker = new FakeWorker((posted) => [{ type: 'result', result: nest(requestFromJob(posted.job)) }])
  const result = await runNestJob(job, { createWorker: () => worker })
  assert(result.placements.length === 4, 'four squares placed')
  assert(worker.posted.length === 1 && worker.posted[0].type === 'nest', 'one nest request posted')
  assert(worker.terminated === 1, 'worker terminated after')
}

async function testPlacingProgress(): Promise<void> {
  const worker = new FakeWorker((posted) => [
    { type: 'placing', done: 0, total: 4 },
    { type: 'placing', done: 3, total: 4 },
    { type: 'result', result: nest(requestFromJob(posted.job)) },
  ])
  const seen: string[] = []
  const result = await runNestJob(job, { createWorker: () => worker, onPlacing: (done, total) => seen.push(`${done}/${total}`) })
  assert(seen.join() === '0/4,3/4', `placing progress is forwarded, got ${seen.join()}`)
  assert(result.placements.length === 4 && worker.terminated === 1, 'the result still settles the run')
}

async function testError(): Promise<void> {
  const worker = new FakeWorker(() => [{ type: 'error', message: 'boom' }])
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

async function testImprove(): Promise<void> {
  const first = nest(requestFromJob(job))
  const better = { ...first, usedArea: first.usedArea / 2 }
  const worker = new FakeWorker(() => [
    { type: 'progress', evaluated: 1, best: first },
    { type: 'progress', evaluated: 2 },
    { type: 'progress', evaluated: 3, best: better },
    { type: 'done', evaluated: 3 },
  ])
  const updates: NestImproveUpdate[] = []
  const evaluated = await improveNestJob(job, { createWorker: () => worker, seed: 4, onProgress: (update) => updates.push(update) })
  assert(evaluated === 3, 'resolves with the layouts tried')
  assert(updates.map((update) => `${update.evaluated}:${update.best?.usedArea ?? '-'}`).join() === `1:${first.usedArea},2:-,3:${better.usedArea}`, 'progress is forwarded in order')
  const [request] = worker.posted
  assert(request.type === 'improve' && request.seed === 4, 'an improve request carries the seed')
  assert(worker.terminated === 1, 'worker terminated when the search stalls')
}

async function testImproveStopFromProgress(): Promise<void> {
  // The panel stops from inside a progress callback when the project changes.
  const worker = new FakeWorker(() => [
    { type: 'progress', evaluated: 1, best: nest(requestFromJob(job)) },
    { type: 'progress', evaluated: 2 },
    { type: 'progress', evaluated: 3 },
  ])
  const controller = new AbortController()
  const seen: number[] = []
  let cancelled = false
  try {
    await improveNestJob(job, {
      createWorker: () => worker,
      signal: controller.signal,
      onProgress: (update) => {
        seen.push(update.evaluated)
        if (update.evaluated === 2) controller.abort()
      },
    })
  } catch (error) {
    cancelled = error instanceof NestCancelledError
  }
  assert(cancelled && worker.terminated === 1, 'aborting from progress cancels and terminates')
  assert(seen.join() === '1,2', `nothing after the stop is reported, got ${seen.join()}`)
}

async function testImproveInline(): Promise<void> {
  const controller = new AbortController()
  const updates: NestImproveUpdate[] = []
  let cancelled = false
  try {
    await improveNestJob(job, {
      createWorker: () => null,
      signal: controller.signal,
      onProgress: (update) => {
        updates.push(update)
        if (update.evaluated === 5) controller.abort()
      },
    })
  } catch (error) {
    cancelled = error instanceof NestCancelledError
  }
  assert(cancelled && updates.length === 5, `inline search runs until stopped, got ${updates.length}`)
  assert(JSON.stringify(updates[0].best) === JSON.stringify(nest(requestFromJob(job))), 'its first layout is the one-shot answer')
}

await testResult()
await testPlacingProgress()
await testError()
await testCancel()
await testInlineFallback()
await testImprove()
await testImproveStopFromProgress()
await testImproveInline()
console.log('All nest worker client tests passed')
