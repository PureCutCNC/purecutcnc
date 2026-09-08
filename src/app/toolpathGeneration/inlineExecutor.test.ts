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
 * The inline backend yields the thread before it takes it (issue #675).
 *
 * This pins a regression that unit tests could not see and that the browser
 * found immediately. Every other suite here injects a fake executor, so the
 * real inline one was never on the path; when it yielded only a **microtask**
 * before running a generator, control never actually left the current task.
 * Anything already waiting on the main thread — in the failing case, the
 * `page.evaluate` that had just loaded the project — was still blocked when the
 * generator started, and never got to finish.
 *
 * The shipped rAF pipeline this backend replaced waited for a real paint for
 * exactly this reason. That guarantee is not an implementation detail of the
 * old code; it is what makes a blocking backend usable at all, and it is
 * trivial to delete by "simplifying" the await.
 */

import { createInlineExecutor } from './inlineExecutor'
import { makeOperation, projectWith } from './testSupport'
import type { RequestIdentity } from './types'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail: string): void {
  if (condition) { passed += 1; console.log(`   ✓ ${name}`); return }
  failed += 1
  console.log(`   ✗ ${name}: ${detail}`)
}

const identity: RequestIdentity = {
  documentKey: 1,
  workerEpoch: 0,
  requestId: 1,
  snapshotId: 1,
  operationId: 'a',
  traceMode: false,
}

async function main(): Promise<void> {
  console.log('\nInline executor yields before blocking')

  const project = projectWith([makeOperation('a')])
  const executor = createInlineExecutor(0)

  let settled = false
  const running = executor.run({ identity, project }).then((outcome) => {
    settled = true
    return outcome
  })

  // Draining the microtask queue must not be enough to make it run. If it is,
  // the backend never left the caller's task.
  for (let index = 0; index < 50; index += 1) await Promise.resolve()
  check(
    'a microtask drain does not start the computation',
    !settled,
    'the inline backend settled without crossing a macrotask boundary — the paint gap is gone',
  )

  const outcome = await running
  check(
    'the computation still completes once the thread is released',
    outcome.status === 'completed' || outcome.status === 'failed',
    `expected a terminal outcome, got ${outcome.status}`,
  )

  // Terminate must still settle a request that has not been dispatched.
  const second = createInlineExecutor(1)
  const pending = second.run({ identity: { ...identity, requestId: 2 }, project })
  second.terminate()
  const cancelled = await pending
  check(
    'terminating before dispatch cancels the request',
    cancelled.status === 'cancelled',
    `expected cancelled, got ${cancelled.status}`,
  )

  check(
    'the inline backend reports that it cannot hard-cancel',
    createInlineExecutor(2).supportsHardCancellation === false,
    'a backend that cannot interrupt a running generator must not claim it can',
  )

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
