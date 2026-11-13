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
 * Issue #1112 item 35: the export preview pane names the state it is in.
 *
 * The regression this pins is the sentence itself. One fallback —
 * "Select a machine in project settings to generate G-code preview" — served
 * every state without a program, so a selected machine plus any other refusal
 * told the operator to select a machine they had already selected. The table
 * below is the whole rule: the machine sentence is reachable from **one** state,
 * no machine selected at all.
 *
 * Run with: npx tsx src/components/export/exportPreviewText.test.ts
 */

import assert from 'node:assert/strict'
import { enMessages } from '../../i18n/locales/en'
import { exportPreviewMessageKey, type ExportPreviewState } from './exportPreviewText'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`   \u2713 ${name}`)
  } catch (error) {
    failed += 1
    console.log(`   \u2717 ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const MACHINE_SENTENCE = 'dialogs.export.previewPlaceholder'

function key(state: ExportPreviewState) {
  return exportPreviewMessageKey(state)
}

console.log('The export preview pane names its state (issue #1112 item 35)')

test('a posted program is shown, so the pane says nothing of its own', () => {
  assert.equal(key({ hasPreview: true, machine: 'resolved', blockReason: null }), null, 'ready with a program')
  assert.equal(
    key({ hasPreview: true, machine: 'resolved', blockReason: 'no-operations' }),
    null,
    'and a program wins over any placeholder',
  )
})

test('the machine sentence belongs to "no machine selected" alone', () => {
  assert.equal(key({ hasPreview: false, machine: 'none', blockReason: null }), MACHINE_SENTENCE, 'nothing settled')
  assert.equal(
    key({ hasPreview: false, machine: 'none', blockReason: 'no-machine' }),
    MACHINE_SENTENCE,
    'and a blocked preparation with no machine says the same thing',
  )
})

test('a selected machine never produces the machine sentence', () => {
  assert.equal(key({ hasPreview: false, machine: 'resolved', blockReason: null }), 'dialogs.export.previewPreparing', 'still preparing')
  assert.equal(
    key({ hasPreview: false, machine: 'resolved', blockReason: 'no-operations' }),
    'dialogs.export.previewNoOperations',
    'nothing ticked to export',
  )
  for (const reason of ['generation-failed', 'generation-cancelled', 'generation-superseded', 'missing-tool', 'stale'] as const) {
    assert.equal(
      key({ hasPreview: false, machine: 'resolved', blockReason: reason }),
      'dialogs.export.previewBlocked',
      `${reason} points at the Errors list instead of guessing a machine problem`,
    )
  }
})

test('a selection the project can no longer resolve says the machine is gone', () => {
  assert.equal(
    key({ hasPreview: false, machine: 'missing', blockReason: 'no-machine' }),
    'dialogs.export.previewMachineMissing',
    'an id is selected but no definition in the project matches it',
  )
  // Not the generic sentence even when the preparation happens to be blocked:
  // the operator needs to know the machine they chose is not in the file.
  assert.equal(
    key({ hasPreview: false, machine: 'missing', blockReason: null }),
    'dialogs.export.previewMachineMissing',
    'and the same while the preparation is still settling',
  )
})

test('every key the pane can return carries real text in the English catalog', () => {
  // A key that no longer exists would compile to `never` at the return site; a
  // key that exists but was never filled in would put a raw `dialogs.export.…`
  // string on screen, which is worse than the wrong sentence.
  const reachable = [
    key({ hasPreview: false, machine: 'none', blockReason: null }),
    key({ hasPreview: false, machine: 'missing', blockReason: null }),
    key({ hasPreview: false, machine: 'resolved', blockReason: null }),
    key({ hasPreview: false, machine: 'resolved', blockReason: 'no-operations' }),
    key({ hasPreview: false, machine: 'resolved', blockReason: 'generation-failed' }),
  ]
  assert.equal(new Set(reachable).size, 5, 'the five states reach five distinct keys')
  for (const messageKey of reachable) {
    assert.ok(messageKey !== null, 'a state without a preview always has a message')
    const text = enMessages[messageKey]
    assert.equal(typeof text, 'string', `${messageKey} exists in the catalog`)
    assert.ok(text.length > 0 && text !== messageKey, `${messageKey} carries text, not its own key`)
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
