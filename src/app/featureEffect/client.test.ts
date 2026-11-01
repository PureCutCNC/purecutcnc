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
 * burst, an answer for an older edit never reaches the tree, every result
 * carries the input snapshot it was computed from, and a worker failure
 * clears the current snapshot instead of leaving its old warning visible.
 *
 * Run with: npx tsx src/app/featureEffect/client.test.ts
 */

import type { FeatureEffectFeature } from '../../engine/featureEffect'
import {
  FeatureEffectClient,
  type FeatureEffectSnapshot,
  type FeatureEffectWorkerLike,
} from './client'
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
const SNAPSHOT_A: FeatureEffectSnapshot = {}
const SNAPSHOT_B: FeatureEffectSnapshot = {}

interface RecordedResult {
  warnings: string[]
  snapshot: FeatureEffectSnapshot
}

interface Harness {
  worker: FakeWorker
  client: FeatureEffectClient
  results: RecordedResult[]
  errors: string[]
  runTimer: () => void
  pending: () => boolean
}

function harness(): Harness {
  const worker = new FakeWorker()
  const results: RecordedResult[] = []
  const errors: string[] = []
  let timer: (() => void) | null = null
  const client = new FeatureEffectClient({
    onResult: (warnings, snapshot) => results.push({ warnings: [...warnings], snapshot }),
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
  test.client.request(SNAPSHOT_A, () => NO_FEATURES)
  test.client.request(SNAPSHOT_B, () => NO_FEATURES)
  assertEqual(test.worker.messages.length, 0, 'nothing is sent before the debounce fires')
  test.runTimer()
  assertEqual(test.worker.messages.length, 1, 'the burst produced one request')
  assertEqual(test.worker.messages[0].requestId, 2, 'the request carries the latest id')
}

// An answer for an edit that has since been superseded is dropped.
{
  const test = harness()
  test.client.request(SNAPSHOT_A, () => NO_FEATURES)
  test.runTimer()
  assertEqual(test.worker.messages[0].requestId, 1, 'the first request was sent')

  // A newer edit arrives while the first analysis is still in flight.
  test.client.request(SNAPSHOT_B, () => NO_FEATURES)
  assert(test.pending(), 'the newer edit is waiting on its debounce')
  test.worker.receive({ type: 'result', requestId: 1, warnings: ['stale'] })
  assertEqual(test.results.length, 0, 'the stale result did not reach the tree')

  test.runTimer()
  test.worker.receive({ type: 'result', requestId: 2, warnings: ['fresh'] })
  assertEqual(test.results.length, 1, 'the current result reached the tree')
  assertEqual(test.results[0].warnings.join(','), 'fresh', 'the current result is the newer one')
  assert(test.results[0].snapshot === SNAPSHOT_B, 'the result carries the snapshot it was computed from')
}

// The result is tagged with its own snapshot even after a newer request is
// queued but not yet sent.
{
  const test = harness()
  test.client.request(SNAPSHOT_A, () => NO_FEATURES)
  test.runTimer()
  test.worker.receive({ type: 'result', requestId: 1, warnings: ['covered'] })
  assertEqual(test.results.length, 1, 'the first result reached the tree')
  assert(test.results[0].snapshot === SNAPSHOT_A, 'the result keeps snapshot A')

  test.client.request(SNAPSHOT_B, () => NO_FEATURES)
  test.runTimer()
  test.worker.receive({ type: 'result', requestId: 2, warnings: [] })
  assertEqual(test.results.length, 2, 'the newer result reached the tree')
  assert(test.results[1].snapshot === SNAPSHOT_B, 'the newer result carries snapshot B')
}

// A stale error is equally not the current answer.
{
  const test = harness()
  test.client.request(SNAPSHOT_A, () => NO_FEATURES)
  test.runTimer()
  test.client.request(SNAPSHOT_B, () => NO_FEATURES)
  test.worker.receive({ type: 'error', requestId: 1, message: 'stale failure' })
  assertEqual(test.errors.length, 0, 'a stale error is dropped')
  test.runTimer()
  test.worker.receive({ type: 'error', requestId: 2, message: 'current failure' })
  assertEqual(test.errors.length, 1, 'the current error reaches the caller')
  assertEqual(test.results.length, 1, 'the current error also clears the snapshot')
  assertEqual(test.results[0].warnings.length, 0, 'the cleared snapshot shows no warnings')
  assert(test.results[0].snapshot === SNAPSHOT_B, 'the clear belongs to the current snapshot')
}

// A dead worker clears the warning instead of leaving it on screen forever.
{
  const test = harness()
  test.client.request(SNAPSHOT_A, () => NO_FEATURES)
  test.runTimer()
  test.worker.receive({ type: 'result', requestId: 1, warnings: ['covered'] })
  assertEqual(test.results.length, 1, 'the covered warning is shown')
  assertEqual(test.results[0].warnings.join(','), 'covered', 'the warning reached the tree')

  test.worker.onerror?.({} as Event)

  assertEqual(test.results.length, 2, 'the failure publishes a cleared result')
  assertEqual(test.results[1].warnings.length, 0, 'the old warning is cleared')
  assert(test.results[1].snapshot === SNAPSHOT_A, 'the clear belongs to the current snapshot')
  assertEqual(test.errors.length, 1, 'the failure is still reported')
  assert(test.worker.terminated, 'the dead worker is terminated')
}

// Disposing cancels the pending request and terminates the worker.
{
  const test = harness()
  test.client.request(SNAPSHOT_A, () => NO_FEATURES)
  test.client.dispose()
  assert(!test.pending(), 'dispose cancels the debounce')
  test.runTimer()
  assertEqual(test.worker.messages.length, 0, 'no request is sent after dispose')
}

console.log('client.test.ts: all assertions passed')
