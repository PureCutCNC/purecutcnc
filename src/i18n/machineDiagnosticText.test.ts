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
 * Every machine-load diagnostic gets a catalog key and a real French sentence
 * (#1119 Codex review, P2). Run with:
 *   npx tsx src/i18n/machineDiagnosticText.test.ts
 *
 * The manager and the open-time load alert both resolve through
 * `machineDiagnosticMessage`; this test walks every `MachineLoadDiagnosticKind`
 * and fails if any one falls back to the English data sentence.
 */

import type { MachineLoadDiagnostic, MachineLoadDiagnosticKind } from '../machine/diagnostics'
import { enMessages } from './locales/en'
import { machineDiagnosticMessage, machineLoadWarning } from './machineDiagnosticText'
import { resetI18nStoreForTests, setActiveLocale, translate } from './store'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function diagnostic(kind: MachineLoadDiagnosticKind, extra: Partial<MachineLoadDiagnostic> = {}): MachineLoadDiagnostic {
  return {
    severity: 'warning',
    kind,
    machineId: 'avid-mach4',
    machineName: 'Avid Mach4',
    message: 'engine English sentence that must not reach the user',
    ...extra,
  }
}

const templateDiagnostic = {
  path: ['program', 'header', 1],
  field: 'program.header[1]',
  line: 2,
  text: 'G90.1',
  word: 'G90.1',
  ruleCode: 'header' as const,
  message: 'program.header[1]: line 2: the word "G90.1" is not allowed in the program header.',
}

const cases: Array<{ label: string, diagnostic: MachineLoadDiagnostic }> = [
  {
    label: 'retained invalid, one line',
    diagnostic: diagnostic('machine-retained-invalid', { templateDiagnostics: [templateDiagnostic] }),
  },
  {
    label: 'retained invalid, several lines',
    diagnostic: diagnostic('machine-retained-invalid', {
      templateDiagnostics: [templateDiagnostic, { ...templateDiagnostic, line: 3 }],
    }),
  },
  { label: 'moved to library', diagnostic: diagnostic('machine-moved-to-library') },
  { label: 're-keyed', diagnostic: diagnostic('machine-rekeyed', { nextId: 'avid-mach4-2' }) },
  { label: 'consolidated', diagnostic: diagnostic('machine-consolidated') },
  { label: 'unresolved selection', diagnostic: diagnostic('machine-selection-unresolved') },
  { label: 'structural error', diagnostic: diagnostic('machine-structural-error', { index: 1 }) },
  { label: 'library unreadable', diagnostic: diagnostic('machine-library-unreadable') },
  { label: 'library entry unreadable', diagnostic: diagnostic('machine-library-unreadable', { index: 1 }) },
  { label: 'library change blocked', diagnostic: diagnostic('machine-library-blocked') },
  { label: 'library write failed', diagnostic: diagnostic('machine-library-write-failed') },
  { label: 'kept in project', diagnostic: diagnostic('machine-kept-in-project') },
]

setActiveLocale('fr')
for (const { label, diagnostic: entry } of cases) {
  const message = machineDiagnosticMessage(entry)
  const english = enMessages[message.key]
  const french = translate(message.key, message.params)
  assert(french !== english, `${label}: the French sentence differs from English`)
  assert(!french.includes('engine English sentence'), `${label}: the English data sentence is not used`)
  assert(!french.includes('was kept and stays selected'), `${label}: no English fallback reaches the user`)
}

const frenchWarning = machineLoadWarning(cases.map(({ diagnostic: entry }) => entry))
assert(frenchWarning !== null, 'the load warning exists')
assert(frenchWarning!.includes('La machine « Avid Mach4 »'), 'the load warning names the machine in French')
assert(frenchWarning!.split('\n\n').length === cases.length, 'each report is its own paragraph')
assert(!frenchWarning!.includes('was kept and stays selected'), 'the load warning never falls back to English')

resetI18nStoreForTests()
console.log('machine diagnostic text tests passed')
