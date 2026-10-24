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
 * The generation gear's two display rules (issue #1102 slice D1).
 *
 * Both are checked by mutation in the slice that introduced them: make the gear
 * ignore a renderer fallback and the first block fails, and the same happens to
 * the per-status notice rule. Run with:
 *   npx tsx src/components/cam/generationSettingsMenu.test.ts
 */

import assert from 'node:assert/strict'
import { gearFlagged, rendererNotice } from './generationSettingsMenu'

const quiet = { paused: false, failed: false, workerFallback: false, rendererFallback: false }
assert.equal(gearFlagged(quiet), false, 'an idle, healthy pipeline leaves the gear unmarked')

for (const flag of ['paused', 'failed', 'workerFallback', 'rendererFallback'] as const) {
  assert.equal(gearFlagged({ ...quiet, [flag]: true }), true, `${flag} must mark the gear`)
}

assert.equal(
  gearFlagged({ paused: true, failed: true, workerFallback: true, rendererFallback: true }),
  true,
  'every reason at once still just marks the gear',
)

// A settled renderer says nothing extra: the selected button already says which
// one it is, so only the two in-between states get a line.
assert.equal(rendererNotice('gpu'), null)
assert.equal(rendererNotice('canvas'), null)
assert.equal(rendererNotice('loading'), 'loading')
assert.equal(rendererNotice('fallback'), 'fallback')
assert.equal(rendererNotice(null), null, 'no sketch means no notice')

console.log('generationSettingsMenu tests passed')
