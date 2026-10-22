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
 * The shipped backend default and how a stored choice is read (issue #1087).
 *
 * The default moved from `inline` to `worker` in 0.6.0. The thing that has to
 * stay true alongside it is the promise made to someone who chose `inline`
 * deliberately: their stored value is still what they get, and an environment
 * that has no `Worker` still resolves to the main thread rather than failing.
 */

import assert from 'node:assert/strict'
import {
  DEFAULT_EXECUTOR_KIND,
  EXECUTOR_PREFERENCE_STORAGE_KEY,
  parseExecutorPreference,
  resolveExecutorKind,
  serializeExecutorPreference,
  workerBackendAvailable,
} from './executorPreference'

assert.equal(EXECUTOR_PREFERENCE_STORAGE_KEY, 'purecut.generation.executor')
assert.equal(DEFAULT_EXECUTOR_KIND, 'worker', 'a fresh profile must get the worker backend')

// A stored choice survives. `inline` is the explicit opt-out, not a stale value.
for (const kind of ['inline', 'worker'] as const) {
  assert.equal(parseExecutorPreference(kind), kind, `a stored ${kind} preference must be kept`)
  assert.equal(parseExecutorPreference(serializeExecutorPreference(kind)), kind)
}

// Unrecognised and older text falls back to the shipped default instead of
// throwing or wedging the user into an unusable backend.
for (const raw of [null, '', 'inline ', ' INLINE', 'thread', 'gpu', '{"kind":"inline"}', 'null']) {
  assert.equal(parseExecutorPreference(raw), DEFAULT_EXECUTOR_KIND, `unrecognised value ${String(raw)} must fall back`)
}

// The availability check is what makes an unsupported runtime work without
// asking the user to change a setting.
assert.equal(workerBackendAvailable({}), false)
assert.equal(workerBackendAvailable({ Worker: function Worker() {} }), true)
assert.equal(resolveExecutorKind('worker', true), 'worker')
assert.equal(resolveExecutorKind('worker', false), 'inline', 'no Worker means inline')
assert.equal(resolveExecutorKind('inline', true), 'inline')
assert.equal(resolveExecutorKind('inline', false), 'inline')

console.log('executorPreference tests passed')
