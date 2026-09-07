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
 * Generation service races (issue #675).
 *
 * Every case here uses a **fake executor whose completions are released by
 * hand**. That is the point of the suite: the interleavings that matter — a
 * late answer to a superseded question, a document replaced mid-flight, a
 * consumer abandoning work another still needs — are the ones that never
 * reproduce on a timer. Sleeping and hoping is how these bugs ship.
 *
 * No real worker and no real generation runs here; `generateOperationParity`
 * owns whether the output is right, this owns whether the right output is
 * installed.
 */

import type { Operation, Project } from '../../types/project'
import { createToolpathGenerationService, type GenerationContext } from './service'
import type { GenerationExecutor, ExecutorRequest } from './executor'
import type { GenerationOutcome } from './testSupport'
import { makeOperation, makeResult, projectWith } from './testSupport'

let passed = 0
let failed = 0

function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; console.log(`   ✓ ${name}`) })
    .catch((error: unknown) => {
      failed += 1
      console.log(`   ✗ ${name}: ${error instanceof Error ? error.message : String(error)}`)
    })
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

/** Settle the microtask queue so service continuations run before assertions. */
async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

interface ControlledExecutor extends GenerationExecutor {
  /** Requests that have started and not yet been answered, oldest first. */
  readonly inFlight: ExecutorRequest[]
  /** Release the oldest in-flight request with this outcome. */
  release(outcome: GenerationOutcome): void
  readonly terminations: number
}

function createControlledExecutor(epoch: number, hardCancel = true): ControlledExecutor {
  const inFlight: ExecutorRequest[] = []
  const settles: ((outcome: GenerationOutcome) => void)[] = []
  let terminations = 0

  return {
    kind: hardCancel ? 'worker' : 'inline',
    epoch,
    supportsHardCancellation: hardCancel,
    inFlight,
    get terminations() { return terminations },
    run(request: ExecutorRequest): Promise<GenerationOutcome> {
      inFlight.push(request)
      return new Promise<GenerationOutcome>((resolve) => { settles.push(resolve) })
    },
    release(outcome: GenerationOutcome): void {
      const settle = settles.shift()
      inFlight.shift()
      settle?.(outcome)
    },
    terminate(): void {
      terminations += 1
      while (settles.length > 0) {
        inFlight.shift()
        settles.shift()?.({ status: 'cancelled' })
      }
    },
    dispose(): void {
      while (settles.length > 0) {
        inFlight.shift()
        settles.shift()?.({ status: 'cancelled' })
      }
    },
  }
}

function harness(initial: Project, hardCancel = true): {
  service: ReturnType<typeof createToolpathGenerationService>
  executor: () => ControlledExecutor
  context: () => GenerationContext
  setContext: (project: Project, documentKey?: number) => void
} {
  const executors: ControlledExecutor[] = []
  let current: GenerationContext = { project: initial, documentKey: 1 }
  const service = createToolpathGenerationService({
    getCurrentContext: () => current,
    createExecutor: (_kind, epoch) => {
      const made = createControlledExecutor(epoch, hardCancel)
      executors.push(made)
      return made
    },
  })
  return {
    service,
    executor: () => executors[executors.length - 1],
    context: () => current,
    setContext: (project, documentKey) => {
      current = { project, documentKey: documentKey ?? current.documentKey }
    },
  }
}

async function main(): Promise<void> {
  console.log('\nGeneration service — deterministic races')

  const opA = makeOperation('a')
  const opB = makeOperation('b')
  const base = projectWith([opA, opB])

  await test('a cache hit still resolves through a Promise', async () => {
    const h = harness(base)
    const first = h.service.request(h.context(), 'a', { purpose: 'export' })
    await flush()
    h.executor().release({ status: 'completed', result: makeResult('a', 3), raw: null })
    const outcome = await first
    assert(outcome.status === 'completed', 'first request should complete')

    const second = await h.service.request(h.context(), 'a', { purpose: 'export' })
    assert(second.status === 'completed', 'cached request should complete')
    assert(h.executor().inFlight.length === 0, 'a cache hit must not start work')
  })

  await test('a late result for an edited operation is superseded, never installed', async () => {
    const h = harness(base)
    const pending = h.service.request(h.context(), 'a', { purpose: 'preview' })
    await flush()

    // The operation changes while the job is in flight.
    const editedA: Operation = { ...opA, stepdown: opA.stepdown + 1 }
    h.setContext(projectWith([editedA, opB]))

    h.executor().release({ status: 'completed', result: makeResult('a', 3), raw: null })
    const outcome = await pending
    assert(outcome.status === 'superseded', `expected superseded, got ${outcome.status}`)
    assert(
      h.service.peekCurrent(h.context(), 'a') === null,
      'a superseded result must not be readable as current',
    )
  })

  await test('opening another document discards work in flight for the old one', async () => {
    const h = harness(base)
    const pending = h.service.request(h.context(), 'a', { purpose: 'preview' })
    await flush()

    // Same operations, new document session — projectKey is what ends it.
    h.setContext(projectWith([opA, opB]), 2)

    h.executor().release({ status: 'completed', result: makeResult('a', 3), raw: null })
    const outcome = await pending
    assert(outcome.status === 'superseded', `expected superseded, got ${outcome.status}`)
    assert(h.service.peekCurrent(h.context(), 'a') === null, 'nothing may be installed for the new document')
  })

  await test('equivalent requests share one job and both settle', async () => {
    const h = harness(base)
    const first = h.service.request(h.context(), 'a', { purpose: 'preview' })
    const second = h.service.request(h.context(), 'a', { purpose: 'export' })
    await flush()
    assert(h.executor().inFlight.length === 1, 'two equivalent requests must not start two computations')

    h.executor().release({ status: 'completed', result: makeResult('a', 3), raw: null })
    const [a, b] = await Promise.all([first, second])
    assert(a.status === 'completed' && b.status === 'completed', 'both consumers must settle')
  })

  await test('a trace request is never answered by a non-trace job', async () => {
    const h = harness(base)
    const preview = h.service.request(h.context(), 'a', { purpose: 'preview' })
    const debug = h.service.request(h.context(), 'a', { purpose: 'debug', trace: true })
    await flush()
    assert(h.executor().inFlight.length === 1, 'one at a time')
    assert(h.executor().inFlight[0].identity.traceMode === false, 'preview runs first')

    h.executor().release({ status: 'completed', result: makeResult('a', 3), raw: null })
    await flush()
    assert(h.executor().inFlight.length === 1, 'the trace request must run its own computation')
    assert(h.executor().inFlight[0].identity.traceMode === true, 'second job carries traceMode')
    h.executor().release({ status: 'completed', result: makeResult('a', 3), raw: makeResult('a', 5) })
    const [p, d] = await Promise.all([preview, debug])
    assert(p.status === 'completed' && d.status === 'completed', 'both settle')
    assert(d.status === 'completed' && d.raw !== null, 'the trace consumer receives a raw path')
  })

  await test('one consumer aborting does not kill a job another still needs', async () => {
    const h = harness(base)
    const controller = new AbortController()
    const abandoned = h.service.request(h.context(), 'a', { purpose: 'preview', signal: controller.signal })
    const kept = h.service.request(h.context(), 'a', { purpose: 'export' })
    await flush()

    controller.abort()
    const first = await abandoned
    assert(first.status === 'cancelled', 'the abandoning consumer is cancelled')
    assert(h.executor().terminations === 0, 'the shared job must not be terminated')

    h.executor().release({ status: 'completed', result: makeResult('a', 3), raw: null })
    const second = await kept
    assert(second.status === 'completed', 'the remaining consumer still gets its result')
  })

  await test('the last consumer aborting terminates the worker', async () => {
    const h = harness(base)
    const controller = new AbortController()
    const only = h.service.request(h.context(), 'a', { purpose: 'preview', signal: controller.signal })
    await flush()
    controller.abort()
    const outcome = await only
    assert(outcome.status === 'cancelled', 'the consumer is cancelled')
    assert(h.executor().terminations >= 1 || h.executor().inFlight.length === 0, 'the job is stopped')
  })

  await test('Stop pauses automatic work but leaves an explicit request running', async () => {
    const h = harness(base)
    const explicit = h.service.request(h.context(), 'a', { purpose: 'export' })
    await flush()
    h.service.setAutomaticDemand(h.context(), ['b'], false)
    await flush()

    h.service.stopAutomaticGeneration()
    assert(h.service.getSnapshot().automaticPaused, 'automatic generation is paused')
    assert(h.service.getSnapshot().activeOperationId === 'a', 'the explicit job keeps running')

    h.executor().release({ status: 'completed', result: makeResult('a', 3), raw: null })
    const outcome = await explicit
    assert(outcome.status === 'completed', 'the explicit request completes despite Stop')
  })

  await test('automatic demand is ignored while a gesture defers it', async () => {
    const h = harness(base)
    h.service.setAutomaticDemand(h.context(), ['a', 'b'], true)
    await flush()
    assert(h.service.getSnapshot().queuedCount === 0, 'a deferred gesture queues nothing')
    assert(h.executor() === undefined, 'no executor is created for deferred demand')
  })

  await test('an explicit request promotes the same operation ahead of queued preview work', async () => {
    const h = harness(base)
    h.service.setAutomaticDemand(h.context(), ['a', 'b'], false)
    await flush()
    // 'a' is running; 'b' is queued as automatic. Ask explicitly for 'b'.
    const explicit = h.service.request(h.context(), 'b', { purpose: 'booklet' })
    h.executor().release({ status: 'completed', result: makeResult('a', 3), raw: null })
    await flush()
    assert(h.executor().inFlight[0]?.identity.operationId === 'b', 'b runs next')
    h.executor().release({ status: 'completed', result: makeResult('b', 4), raw: null })
    assert((await explicit).status === 'completed', 'the promoted request completes')
  })

  await test('an infrastructure failure ends the epoch and does not auto-retry', async () => {
    const h = harness(base)
    const pending = h.service.request(h.context(), 'a', { purpose: 'preview' })
    await flush()
    const firstExecutor = h.executor()
    firstExecutor.release({
      status: 'failed',
      failure: { category: 'worker-crash', message: 'boom' },
    })
    const outcome = await pending
    assert(outcome.status === 'failed', 'the request fails')
    assert(h.service.getSnapshot().executorFailure?.category === 'worker-crash', 'the failure is surfaced')
    assert(h.service.getSnapshot().operations.get('a') === 'failed', 'the operation stays failed')
    assert(h.service.getSnapshot().queuedCount === 0, 'nothing is re-queued automatically')
  })

  await test('a computation error is reported without discarding the executor', async () => {
    const h = harness(base)
    const pending = h.service.request(h.context(), 'a', { purpose: 'preview' })
    await flush()
    const before = h.executor()
    before.release({ status: 'failed', failure: { category: 'computation', message: 'bad geometry' } })
    assert((await pending).status === 'failed', 'the request fails')
    assert(h.service.getSnapshot().executorFailure === null, 'a bad operation is not an executor fault')
  })

  await test('switching backend cancels consumers and clears the cache', async () => {
    const h = harness(base)
    const first = h.service.request(h.context(), 'a', { purpose: 'preview' })
    await flush()
    h.executor().release({ status: 'completed', result: makeResult('a', 3), raw: null })
    await first
    assert(h.service.peekCurrent(h.context(), 'a') !== null, 'result is cached')

    const pending = h.service.request(h.context(), 'b', { purpose: 'preview' })
    await flush()
    h.service.setExecutorKind('worker')
    assert((await pending).status === 'cancelled', 'in-flight consumers are cancelled')
    assert(h.service.peekCurrent(h.context(), 'a') === null, 'the cache is cleared for a clean baseline')
  })

  await test('Resume re-queues the work Stop cancelled', async () => {
    // Stop cancels outstanding preview work; Resume has to put it back. Without
    // that, Resume flips a flag and nothing else — the preview's demand effect
    // only re-runs on a project or selection change, so the operations sit on
    // spinners forever.
    const h = harness(base)
    h.service.setAutomaticDemand(h.context(), ['a', 'b'], false)
    await flush()

    h.service.stopAutomaticGeneration()
    await flush()
    assert(h.service.getSnapshot().automaticPaused, 'Stop pauses')
    assert(h.service.getSnapshot().queuedCount === 0, 'Stop clears the queue')

    h.service.resumeAutomaticGeneration()
    await flush()
    assert(!h.service.getSnapshot().automaticPaused, 'Resume unpauses')
    assert(
      h.executor().inFlight.length > 0 || h.service.getSnapshot().queuedCount > 0,
      'Resume must re-queue the work the preview still wants',
    )

    h.executor().release({ status: 'completed', result: makeResult('a', 3), raw: null })
    await flush()
    assert(h.service.peekCurrent(h.context(), 'a') !== null, 'generation completes after Resume')
  })

  await test('Retry re-queues after an infrastructure failure', async () => {
    const h = harness(base)
    h.service.setAutomaticDemand(h.context(), ['a'], false)
    await flush()
    h.executor().release({ status: 'failed', failure: { category: 'worker-crash', message: 'boom' } })
    await flush()
    assert(h.service.getSnapshot().executorFailure !== null, 'the failure is surfaced')
    assert(h.service.getSnapshot().queuedCount === 0, 'a failure does not auto-retry')

    h.service.retryAfterFailure()
    await flush()
    assert(h.service.getSnapshot().executorFailure === null, 'Retry clears the failure')
    assert(
      h.executor().inFlight.length > 0 || h.service.getSnapshot().queuedCount > 0,
      'Retry must actually re-queue the failed work',
    )
  })

  await test('switching backend re-queues the work the preview still wants', async () => {
    // The bug this pins: switching cleared the result cache *and* the automatic
    // demand, but nothing restated the demand — the preview's effect only re-runs
    // when the project or selection changes, and a backend switch changes
    // neither. The toolpaths vanished, every operation showed a spinner, and no
    // job was ever queued again. On both backends, because any switch did it.
    const h = harness(base)
    h.service.setAutomaticDemand(h.context(), ['a', 'b'], false)
    await flush()
    h.executor().release({ status: 'completed', result: makeResult('a', 3), raw: null })
    await flush()
    h.executor().release({ status: 'completed', result: makeResult('b', 4), raw: null })
    await flush()
    assert(h.service.peekCurrent(h.context(), 'a') !== null, 'both operations should be cached first')

    h.service.setExecutorKind('worker')
    await flush()

    // The cache is cleared on purpose — a switch starts from an unambiguous
    // baseline — so the work has to be queued again, not merely forgotten.
    assert(h.service.peekCurrent(h.context(), 'a') === null, 'the switch clears the cache')
    assert(
      h.executor().inFlight.length > 0 || h.service.getSnapshot().queuedCount > 0,
      'after switching, the still-demanded operations must be re-queued',
    )

    h.executor().release({ status: 'completed', result: makeResult('a', 3), raw: null })
    await flush()
    assert(
      h.service.peekCurrent(h.context(), 'a') !== null,
      'generation must actually complete on the new backend',
    )
  })

  await test('switching backend while paused does not silently resume', async () => {
    const h = harness(base)
    h.service.setAutomaticDemand(h.context(), ['a'], false)
    await flush()
    h.service.stopAutomaticGeneration()
    await flush()
    h.service.setExecutorKind('worker')
    await flush()
    assert(h.service.getSnapshot().automaticPaused, 'the pause survives a backend switch')
    assert(h.service.getSnapshot().queuedCount === 0, 'a paused service must not queue on switch')
  })

  await test('disposal settles everything and starts nothing new', async () => {
    const h = harness(base)
    const pending = h.service.request(h.context(), 'a', { purpose: 'preview' })
    await flush()
    h.service.dispose()
    assert((await pending).status === 'cancelled', 'outstanding consumers are settled')
    const after = await h.service.request(h.context(), 'a', { purpose: 'preview' })
    assert(after.status === 'failed', 'a disposed service starts no work')
  })

  await test('a stale display path is never returned as current', async () => {
    const h = harness(base)
    const first = h.service.request(h.context(), 'a', { purpose: 'preview' })
    await flush()
    h.executor().release({ status: 'completed', result: makeResult('a', 3), raw: null })
    await first

    const editedA: Operation = { ...opA, stepdown: opA.stepdown + 1 }
    h.setContext(projectWith([editedA, opB]))
    assert(h.service.peekCurrent(h.context(), 'a') === null, 'peekCurrent refuses a stale entry')
    assert(h.service.peekDisplayOnly('a') !== null, 'the display-only read still offers the old path')
  })

  await test('an unrelated edit keeps a valid cached result', async () => {
    const h = harness(base)
    const first = h.service.request(h.context(), 'a', { purpose: 'preview' })
    await flush()
    h.executor().release({ status: 'completed', result: makeResult('a', 3), raw: null })
    await first

    // Renaming another operation is display-only for 'a'.
    const renamedB: Operation = { ...opB, name: 'renamed' }
    h.setContext(projectWith([opA, renamedB]))
    assert(h.service.peekCurrent(h.context(), 'a') !== null, 'an unrelated change must not invalidate a')
  })

  await test('automatic preview demand actually runs and caches, with no consumer awaiting it', async () => {
    const h = harness(base)
    h.service.setAutomaticDemand(h.context(), ['a', 'b'], false)
    await flush()
    assert(h.executor() !== undefined, 'automatic demand must start work')
    assert(h.executor().inFlight[0]?.identity.operationId === 'a', 'the first demanded operation runs first')

    h.executor().release({ status: 'completed', result: makeResult('a', 3), raw: null })
    await flush()
    // Nothing is awaiting a Promise for automatic work, so the cache is the
    // only place the result can land — and it must.
    assert(h.service.peekCurrent(h.context(), 'a') !== null, 'a completed automatic result is cached')
    assert(h.executor().inFlight[0]?.identity.operationId === 'b', 'the queue advances to the next demanded operation')
  })

  await test('selected-first order is preserved across the queue', async () => {
    const h = harness(base)
    h.service.setAutomaticDemand(h.context(), ['b', 'a'], false)
    await flush()
    assert(h.executor().inFlight[0]?.identity.operationId === 'b', 'the caller-supplied order decides priority')
  })

  await test('dropping an operation from demand removes its queued job', async () => {
    const h = harness(base)
    h.service.setAutomaticDemand(h.context(), ['a', 'b'], false)
    await flush()
    h.service.setAutomaticDemand(h.context(), ['a'], false)
    await flush()
    h.executor().release({ status: 'completed', result: makeResult('a', 3), raw: null })
    await flush()
    assert(h.executor().inFlight.length === 0, 'the undemanded operation is not computed')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
