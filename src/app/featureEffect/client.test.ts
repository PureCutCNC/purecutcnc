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

/// <reference types="node" />

/**
 * The feature-effect client's ordering rules (issue #1112 N).
 *
 * The worker is mocked and the debounce timer is driven by hand, so these
 * assertions are about the protocol, not about timing: one request after a
 * burst, and an answer for an older edit never reaches the tree.
 *
 * Run with: npx tsx src/app/featureEffect/client.test.ts
 */

import type { FeatureEffectFeature } from '../../engine/featureEffect'
import { FeatureEffectClient, type FeatureEffectWorkerLike } from './client'
import type { FeatureEffectRequest, FeatureEffectResponse } from './protocol'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`)
}

class FakeWorker implements FeatureEffectWorkerLike {
  readonly messages: FeatureEffectRequest[] = []
  terminated = false
  onmessage: ((event: MessageEvent<FeatureEffectResponse>) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  postMessage(message: FeatureEffectRequest): void {
    this.messages.push(message)
  }

  terminate(): void {
    this.terminated = true
  }

  receive(response: FeatureEffectResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<FeatureEffectResponse>)
  }
}

const NO_FEATURES: FeatureEffectFeature[] = []

interface Harness {
  worker: FakeWorker
  client: FeatureEffectClient
  results: string[][]
  errors: string[]
  runTimer: () => void
  pending: () => boolean
}

function harness(): Harness {
  const worker = new FakeWorker()
  const results: string[][] = []
  const errors: string[] = []
  let timer: (() => void) | null = null
  const client = new FeatureEffectClient({
    onResult: (warnings) => results.push([...warnings]),
    onError: (message) => errors.push(message),
    createWorker: () => worker,
    schedule: (callback) => {
      timer = callback
      return 1
    },
    cancel: () => {
      timer = null
    },
  })
  return {
    worker,
    client,
    results,
    errors,
    runTimer: () => {
      const callback = timer
      timer = null
      callback?.()
    },
    pending: () => timer !== null,
  }
}

// A burst of edits becomes one analysis, carrying the latest request id.
{
  const test = harness()
  test.client.request(() => NO_FEATURES)
  test.client.request(() => NO_FEATURES)
  assertEqual(test.worker.messages.length, 0, 'nothing is sent before the debounce fires')
  test.runTimer()
  assertEqual(test.worker.messages.length, 1, 'the burst produced one request')
  assertEqual(test.worker.messages[0].requestId, 2, 'the request carries the latest id')
}

// An answer for an edit that has since been superseded is dropped.
{
  const test = harness()
  test.client.request(() => NO_FEATURES)
  test.runTimer()
  assertEqual(test.worker.messages[0].requestId, 1, 'the first request was sent')

  // A newer edit arrives while the first analysis is still in flight.
  test.client.request(() => NO_FEATURES)
  assert(test.pending(), 'the newer edit is waiting on its debounce')
  test.worker.receive({ type: 'result', requestId: 1, warnings: ['stale'] })
  assertEqual(test.results.length, 0, 'the stale result did not reach the tree')

  test.runTimer()
  test.worker.receive({ type: 'result', requestId: 2, warnings: ['fresh'] })
  assertEqual(test.results.length, 1, 'the current result reached the tree')
  assertEqual(test.results[0].join(','), 'fresh', 'the current result is the newer one')
}

// A stale error is equally not the current answer.
{
  const test = harness()
  test.client.request(() => NO_FEATURES)
  test.runTimer()
  test.client.request(() => NO_FEATURES)
  test.worker.receive({ type: 'error', requestId: 1, message: 'stale failure' })
  assertEqual(test.errors.length, 0, 'a stale error is dropped')
  test.runTimer()
  test.worker.receive({ type: 'error', requestId: 2, message: 'current failure' })
  assertEqual(test.errors.length, 1, 'the current error reaches the caller')
}

// Disposing cancels the pending request and terminates the worker.
{
  const test = harness()
  test.client.request(() => NO_FEATURES)
  test.client.dispose()
  assert(!test.pending(), 'dispose cancels the debounce')
  test.runTimer()
  assertEqual(test.worker.messages.length, 0, 'no request is sent after dispose')
}

console.log('client.test.ts: all assertions passed')
