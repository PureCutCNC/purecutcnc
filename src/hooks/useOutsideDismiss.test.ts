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
 * Unit tests for the React-free cores of useOutsideDismiss.
 * Run with: npx tsx src/hooks/useOutsideDismiss.test.ts
 *
 * The hook needs a React renderer + DOM (not available in this harness), but its
 * decision logic — inside-vs-outside across one or more containers, and the
 * Escape gate — lives entirely in isOutside / isDismissKey, exercised directly
 * against fake `contains`-able containers here.
 */

import { isOutside, isDismissKey } from './useOutsideDismiss'

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

/**
 * Fake container whose `contains` returns true for a fixed set of node
 * identities — enough to model "the target is inside this element".
 */
function container(...owned: object[]) {
  const set = new Set<object>(owned)
  return {
    contains: (node: Node | null): boolean => node !== null && set.has(node as unknown as object),
  }
}

// Stand-in DOM nodes (identity is all isOutside cares about).
const triggerNode = { id: 'trigger' } as unknown as Node
const popoverNode = { id: 'popover' } as unknown as Node
const elsewhereNode = { id: 'elsewhere' } as unknown as Node

// ---- isOutside: single container ----

function testOutsideSingleContainer() {
  console.log('Testing isOutside with a single container...')

  const host = container(triggerNode, popoverNode)

  assert(isOutside(triggerNode, [host]) === false, 'target inside the host → not outside')
  assert(isOutside(elsewhereNode, [host]) === true, 'target elsewhere → outside')

  console.log('isOutside single container: PASSED')
}

// ---- isOutside: multiple containers (trigger + portaled popover) ----

function testOutsideMultipleContainers() {
  console.log('Testing isOutside across a trigger + a separate portaled popover...')

  const trigger = container(triggerNode)
  const popover = container(popoverNode)

  assert(isOutside(triggerNode, [trigger, popover]) === false, 'inside the trigger → not outside')
  assert(isOutside(popoverNode, [trigger, popover]) === false, 'inside the portaled popover → not outside')
  assert(isOutside(elsewhereNode, [trigger, popover]) === true, 'inside neither → outside')

  console.log('isOutside multiple containers: PASSED')
}

// ---- isOutside: null refs and null target ----

function testOutsideNullHandling() {
  console.log('Testing isOutside skips null containers and handles a null target...')

  const popover = container(popoverNode)

  // An unmounted ref (null) is skipped; the other container still decides.
  assert(isOutside(popoverNode, [null, popover]) === false, 'null container skipped, real one matches → not outside')
  assert(isOutside(elsewhereNode, [null, popover]) === true, 'null container skipped, no match → outside')

  // No containers at all → everything is outside.
  assert(isOutside(triggerNode, [null]) === true, 'only null containers → outside')
  assert(isOutside(triggerNode, []) === true, 'empty container list → outside')

  // A null target is never contained (matches DOM `contains(null) === false`).
  assert(isOutside(null, [popover]) === true, 'null target → outside')

  console.log('isOutside null handling: PASSED')
}

// ---- isDismissKey: Escape only ----

function testDismissKey() {
  console.log('Testing isDismissKey gates on Escape...')

  assert(isDismissKey('Escape') === true, 'Escape → dismiss')
  assert(isDismissKey('Enter') === false, 'Enter → no dismiss')
  assert(isDismissKey('Esc') === false, 'legacy "Esc" → no dismiss (sites check "Escape")')
  assert(isDismissKey('a') === false, 'other key → no dismiss')

  console.log('isDismissKey Escape gate: PASSED')
}

try {
  testOutsideSingleContainer()
  testOutsideMultipleContainers()
  testOutsideNullHandling()
  testDismissKey()
  console.log('\nAll useOutsideDismiss core tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
