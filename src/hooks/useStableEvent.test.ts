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
 * Unit tests for the React-free core of useStableEvent.
 * Run with: npx tsx src/hooks/useStableEvent.test.ts
 *
 * The hook itself needs a React renderer (not available in this harness), but
 * its stable-identity / latest-fn contract lives entirely in createStableEvent,
 * which is exercised directly here.
 */

import { createStableEvent } from './useStableEvent'

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

// ---- stable identity ----

function testInvokeIdentityIsStable() {
  console.log('Testing invoke identity is stable across setLatest...')

  const store = createStableEvent(() => 'a')
  const first = store.invoke
  store.setLatest(() => 'b')
  const afterUpdate = store.invoke
  store.setLatest(() => 'c')
  const afterSecondUpdate = store.invoke

  assert(first === afterUpdate, 'invoke identity unchanged after first setLatest')
  assert(first === afterSecondUpdate, 'invoke identity unchanged after second setLatest')

  console.log('invoke identity is stable: PASSED')
}

// ---- latest fn is called ----

function testInvokeCallsLatestFn() {
  console.log('Testing invoke forwards to the latest fn...')

  const store = createStableEvent(() => 1)
  assert(store.invoke() === 1, 'initial fn returns 1')

  store.setLatest(() => 2)
  assert(store.invoke() === 2, 'after setLatest returns 2')

  store.setLatest(() => 3)
  assert(store.invoke() === 3, 'only the most recent fn fires')

  console.log('invoke calls latest fn: PASSED')
}

// ---- args + return forwarding ----

function testInvokeForwardsArgsAndReturn() {
  console.log('Testing invoke forwards args and return value...')

  const store = createStableEvent((a: number, b: number) => a + b)
  assert(store.invoke(2, 3) === 5, 'forwards args to initial fn')

  store.setLatest((a: number, b: number) => a * b)
  assert(store.invoke(2, 3) === 6, 'forwards args to latest fn')

  console.log('invoke forwards args and return: PASSED')
}

// ---- side-effecting handler (the real-world case) ----

function testInvokeRunsLatestSideEffect() {
  console.log('Testing invoke runs the latest side effect only...')

  const calls: string[] = []
  const store = createStableEvent(() => calls.push('first'))
  const stable = store.invoke

  store.setLatest(() => calls.push('second'))
  stable()
  stable()

  assert(calls.length === 2, 'two invocations recorded')
  assert(calls[0] === 'second' && calls[1] === 'second', 'both invocations ran the latest fn')

  console.log('invoke runs latest side effect: PASSED')
}

try {
  testInvokeIdentityIsStable()
  testInvokeCallsLatestFn()
  testInvokeForwardsArgsAndReturn()
  testInvokeRunsLatestSideEffect()
  console.log('\nAll useStableEvent core tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
