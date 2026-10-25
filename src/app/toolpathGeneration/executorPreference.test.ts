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
 * How the stored backend resolves, now that there is no choice (issue #1102
 * slice D1).
 *
 * Three things have to stay true together: production always uses the worker
 * when the runtime has one (a stored `inline` from an older build is ignored),
 * a runtime without a `Worker` still runs on the main thread, and a development
 * build still honours a stored `inline` so the parity spec can force the main
 * thread. The shipped default is still `worker`, which is what a fresh profile
 * gets written on first load.
 *
 * Run with: npx tsx src/app/toolpathGeneration/executorPreference.test.ts
 */

import assert from 'node:assert/strict'
import {
  DEFAULT_EXECUTOR_KIND,
  EXECUTOR_PREFERENCE_STORAGE_KEY,
  effectiveExecutorKind,
  parseExecutorPreference,
  serializeExecutorPreference,
  workerBackendAvailable,
} from './executorPreference'

assert.equal(EXECUTOR_PREFERENCE_STORAGE_KEY, 'purecut.generation.executor')
assert.equal(DEFAULT_EXECUTOR_KIND, 'worker', 'a fresh profile must get the worker backend')

// A stored value still round-trips through the codec: development depends on
// it, even though production ignores what it resolves to.
for (const kind of ['inline', 'worker'] as const) {
  assert.equal(parseExecutorPreference(kind), kind, `a stored ${kind} must survive parsing`)
  assert.equal(parseExecutorPreference(serializeExecutorPreference(kind)), kind)
}

// Unrecognised and older text falls back to the shipped default instead of
// throwing.
for (const raw of [null, '', 'inline ', ' INLINE', 'thread', 'gpu', '{"kind":"inline"}', 'null']) {
  assert.equal(parseExecutorPreference(raw), DEFAULT_EXECUTOR_KIND, `unrecognised value ${String(raw)} must fall back`)
}

// The availability check is what makes an unsupported runtime work without
// asking the user to change a setting.
assert.equal(workerBackendAvailable({}), false)
assert.equal(workerBackendAvailable({ Worker: function Worker() {} }), true)

// Production: the stored value cannot pick the main thread. This is the rule
// that makes a build from before #1102 behave like a fresh one.
assert.equal(effectiveExecutorKind('inline', true, false), 'worker', 'production ignores a stored inline')
assert.equal(effectiveExecutorKind('worker', true, false), 'worker')
assert.equal(effectiveExecutorKind('inline', false, false), 'inline', 'no Worker means inline')
assert.equal(effectiveExecutorKind('worker', false, false), 'inline', 'no Worker means inline')

// Development: a stored inline is honoured, which is the parity spec's seam.
assert.equal(effectiveExecutorKind('inline', true, true), 'inline', 'development honours a stored inline')
assert.equal(effectiveExecutorKind('worker', true, true), 'worker')
assert.equal(effectiveExecutorKind('inline', false, true), 'inline', 'development has no Worker to use')

console.log('executorPreference tests passed')
