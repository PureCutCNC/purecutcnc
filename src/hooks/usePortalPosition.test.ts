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
 * Unit tests for the React-free cores of usePortalPosition.
 * Run with: npx tsx src/hooks/usePortalPosition.test.ts
 *
 * The hook itself needs a React renderer (not available in this harness), but its
 * closed→null derivation and scroll/resize dedupe contract live entirely in
 * selectPortalCoords / nextPortalCoords, exercised directly here.
 */

import { selectPortalCoords, nextPortalCoords } from './usePortalPosition'

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

// ---- selectPortalCoords: closed → null, open → measured ----

function testSelectClosedIsNull() {
  console.log('Testing selectPortalCoords returns null when closed...')

  assert(selectPortalCoords(false, null) === null, 'closed + no measurement → null')
  assert(selectPortalCoords(false, { top: 10, left: 20 }) === null, 'closed → null even with a stale measurement')

  console.log('selectPortalCoords closed → null: PASSED')
}

function testSelectOpenIsMeasured() {
  console.log('Testing selectPortalCoords returns the measurement when open...')

  const measured = { top: 10, left: 20 }
  assert(selectPortalCoords(true, measured) === measured, 'open → the measured value (same ref)')
  assert(selectPortalCoords(true, null) === null, 'open but not yet measured → null')

  console.log('selectPortalCoords open → measured: PASSED')
}

// ---- nextPortalCoords: dedupe unchanged positions, accept changed ones ----

function testNextDeduplicatesEqual() {
  console.log('Testing nextPortalCoords keeps the previous ref when unchanged...')

  const prev = { top: 5, left: 6 }
  assert(nextPortalCoords(prev, { top: 5, left: 6 }) === prev, 'equal position → previous ref (no re-render)')

  console.log('nextPortalCoords dedupe equal: PASSED')
}

function testNextAcceptsChanged() {
  console.log('Testing nextPortalCoords returns the new value when changed...')

  const prev = { top: 5, left: 6 }
  const next = { top: 5, left: 7 }
  assert(nextPortalCoords(prev, next) === next, 'changed left → new value')
  assert(nextPortalCoords(null, next) === next, 'no previous → new value')

  console.log('nextPortalCoords accept changed: PASSED')
}

try {
  testSelectClosedIsNull()
  testSelectOpenIsMeasured()
  testNextDeduplicatesEqual()
  testNextAcceptsChanged()
  console.log('\nAll usePortalPosition core tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
