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
 * The dialect labels' experimental note (issue #1191).
 *
 * A ShopBot part file is not G-code and has not been run on a real ShopBot, so
 * the export dialog says so up front. Only the `opensbp` dialect carries that
 * warning: the G-code dialects are proven output, and a note on every export
 * would be noise. The warning is a translated sentence, so its key has to
 * exist in every locale rather than falling back to English.
 *
 * Run with: npx tsx src/components/export/exportDialectLabels.test.ts
 */

import assert from 'node:assert/strict'
import { bundledMachines } from '../../machine/registry'
import { resolveOutputDialect } from '../../engine/gcode/types'
import type { OutputDialect } from '../../engine/gcode/types'
import type { MessageKey } from '../../i18n/locales/en'
import { enMessages } from '../../i18n/locales/en'
import { de } from '../../i18n/locales/de'
import { es } from '../../i18n/locales/es'
import { fr } from '../../i18n/locales/fr'
import { zhCN } from '../../i18n/locales/zh-CN'
import { exportDialectLabels } from './exportDialectLabels'

const NOTE_KEY: MessageKey = 'dialogs.export.opensbpExperimental'

// Only the unproven dialect carries the note, whichever bundled machine asks.
const dialects = new Set<OutputDialect>()
for (const machine of bundledMachines()) {
  const dialect = resolveOutputDialect(machine)
  dialects.add(dialect)
  const note = exportDialectLabels(machine).experimentalNote
  if (dialect === 'opensbp') {
    assert.equal(note, NOTE_KEY, `${machine.id} exports SBP, so it must carry the experimental note`)
  } else {
    assert.equal(note, undefined, `${machine.id} exports ${dialect}, so it must not carry the experimental note`)
  }
}

// Guard against the loop going vacuous: the bundled library must contain both
// an SBP machine and a G-code machine for the assertions above to mean anything.
assert(dialects.has('opensbp'), 'the bundled library ships a ShopBot machine')
assert(dialects.has('gcode'), 'the bundled library ships a G-code machine')

// No machine selected resolves to G-code wording, so the note must be absent.
assert.equal(exportDialectLabels(null).experimentalNote, undefined, 'the no-machine fallback has no experimental note')

// The warning is translated like the rest of the dialog, not left in English.
const locales: [string, Record<MessageKey, string>][] = [
  ['en', enMessages],
  ['de', de],
  ['es', es],
  ['fr', fr],
  ['zh-CN', zhCN],
]
for (const [id, messages] of locales) {
  const text: string = messages[NOTE_KEY]
  assert.equal(typeof text, 'string', `${id} must define ${NOTE_KEY}`)
  assert.ok(text.trim().length > 0, `${id} must not leave ${NOTE_KEY} empty`)
  if (id !== 'en') {
    assert.notEqual(text, enMessages[NOTE_KEY], `${id} must translate ${NOTE_KEY}`)
  }
}

console.log('export dialect label tests passed')
