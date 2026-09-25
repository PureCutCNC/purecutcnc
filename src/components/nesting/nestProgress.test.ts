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
 * Nest panel running line helpers (#869).
 *
 * Run with: npx tsx src/components/nesting/nestProgress.test.ts
 */

import { formatElapsed, throttle } from './nestProgress'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function testFormatElapsed(): void {
  assert(formatElapsed(0) === '0:00', 'zero')
  assert(formatElapsed(999) === '0:00', 'whole seconds only')
  assert(formatElapsed(36_400) === '0:36', 'seconds')
  assert(formatElapsed(65_000) === '1:05', 'minutes pad the seconds')
  assert(formatElapsed(3_723_000) === '1:02:03', 'hours pad the minutes')
  assert(formatElapsed(-5) === '0:00', 'never negative')
  console.log('format elapsed: PASSED')
}

function testThrottle(): void {
  let clock = 1000
  const seen: number[] = []
  const post = throttle((value: number) => seen.push(value), 250, () => clock)
  post(0)
  clock += 100
  post(1)
  clock += 149
  post(2)
  clock += 1
  post(3)
  clock += 1000
  post(4)
  assert(seen.join() === '0,3,4', `first call passes, then one per interval, got ${seen.join()}`)
  console.log('throttle: PASSED')
}

testFormatElapsed()
testThrottle()
console.log('All nest progress tests passed')
