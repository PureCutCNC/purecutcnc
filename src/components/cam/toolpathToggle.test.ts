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
 * The one-eye toolpath visibility rule (issue #1102, proposal 17).
 *
 * Run with: npx tsx src/components/cam/toolpathToggle.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { allToolpathsToggle, allToolpathsToggleEnabled } from './toolpathToggle'

const shown = { showToolpath: true }
const hidden = { showToolpath: false }

test('nothing visible: the click shows every toolpath', () => {
  assert.deepEqual(allToolpathsToggle([hidden, hidden]), { anyVisible: false, next: true })
})

test('some visible: the click hides every toolpath', () => {
  // `some`, not `every`: one visible toolpath is already enough to make
  // "hide all" the useful action.
  assert.deepEqual(allToolpathsToggle([shown, hidden]), { anyVisible: true, next: false })
})

test('all visible: the click hides every toolpath', () => {
  assert.deepEqual(allToolpathsToggle([shown, shown]), { anyVisible: true, next: false })
})

test('empty list: the eye is disabled', () => {
  assert.deepEqual(allToolpathsToggle([]), { anyVisible: false, next: true })
  assert.equal(allToolpathsToggleEnabled([]), false)
  assert.equal(allToolpathsToggleEnabled([hidden]), true)
})
