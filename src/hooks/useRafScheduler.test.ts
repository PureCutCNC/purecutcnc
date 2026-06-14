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
 * Unit tests for the React-free core of useRafScheduler.
 * Run with: npx tsx src/hooks/useRafScheduler.test.ts
 *
 * The hook itself needs a React renderer (not available in this harness), but
 * its coalescing / cancellation contract lives entirely in createRafScheduler,
 * which is exercised directly here against a fake requestAnimationFrame.
 */

import { createRafScheduler } from './useRafScheduler'

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

/** Minimal deterministic rAF: queues callbacks; `flush()` runs and clears them. */
function makeFakeRaf() {
  const pending = new Map<number, FrameRequestCallback>()
  let nextHandle = 1
  const raf = (cb: FrameRequestCallback): number => {
    const handle = nextHandle++
    pending.set(handle, cb)
    return handle
  }
  const caf = (handle: number): void => {
    pending.delete(handle)
  }
  const flush = (): void => {
    const callbacks = [...pending.values()]
    pending.clear()
    for (const cb of callbacks) cb(performance.now())
  }
  return { raf, caf, flush, pendingCount: () => pending.size }
}

// ---- coalescing: many schedule() within one frame → one rAF + one run ----

function testCoalescesIntoSingleFrame() {
  console.log('Testing schedule() coalesces into a single frame...')

  let runs = 0
  const fake = makeFakeRaf()
  const { schedule } = createRafScheduler(() => { runs++ }, fake.raf, fake.caf)

  schedule()
  schedule()
  schedule()
  assert(fake.pendingCount() === 1, 'three schedule() calls queue exactly one frame')
  assert(runs === 0, 'callback has not run before the frame fires')

  fake.flush()
  assert(runs === 1, 'callback ran exactly once for the coalesced frame')

  console.log('coalesces into single frame: PASSED')
}

// ---- a fresh schedule() after the frame fires schedules again ----

function testReschedulesAfterFlush() {
  console.log('Testing schedule() works again after the frame fires...')

  let runs = 0
  const fake = makeFakeRaf()
  const { schedule } = createRafScheduler(() => { runs++ }, fake.raf, fake.caf)

  schedule()
  fake.flush()
  assert(runs === 1, 'first frame ran')

  schedule()
  assert(fake.pendingCount() === 1, 'a new frame is queued after the previous one fired')
  fake.flush()
  assert(runs === 2, 'second frame ran')

  console.log('reschedules after flush: PASSED')
}

// ---- run() always sees the latest behavior (closure-over-mutable) ----

function testRunsLatestCallback() {
  console.log('Testing the scheduler runs the provided run() body...')

  const calls: string[] = []
  let label = 'first'
  const fake = makeFakeRaf()
  const { schedule } = createRafScheduler(() => calls.push(label), fake.raf, fake.caf)

  label = 'second'
  schedule()
  fake.flush()

  assert(calls.length === 1 && calls[0] === 'second', 'run() reads the latest closed-over state')

  console.log('runs latest callback: PASSED')
}

// ---- cancel() drops a pending frame ----

function testCancelDropsPendingFrame() {
  console.log('Testing cancel() drops a pending frame...')

  let runs = 0
  const fake = makeFakeRaf()
  const { schedule, cancel } = createRafScheduler(() => { runs++ }, fake.raf, fake.caf)

  schedule()
  assert(fake.pendingCount() === 1, 'a frame is pending')
  cancel()
  assert(fake.pendingCount() === 0, 'cancel removed the pending frame')

  fake.flush()
  assert(runs === 0, 'callback never ran after cancel')

  // cancel() with nothing pending is a no-op; schedule() still works afterwards.
  cancel()
  schedule()
  fake.flush()
  assert(runs === 1, 'scheduler still usable after a cancel')

  console.log('cancel drops pending frame: PASSED')
}

try {
  testCoalescesIntoSingleFrame()
  testReschedulesAfterFlush()
  testRunsLatestCallback()
  testCancelDropsPendingFrame()
  console.log('\nAll useRafScheduler core tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
