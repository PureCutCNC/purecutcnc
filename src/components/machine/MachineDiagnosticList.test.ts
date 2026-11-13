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
 * The shared machine-diagnostic list renders no English rule text in French
 * (#1119 Codex review, P2). Run with:
 *   npx tsx src/components/machine/MachineDiagnosticList.test.ts
 *
 * The engine now emits a stable `ruleCode`; this test renders one diagnostic
 * for every code in the French catalog and fails if the English rule label
 * appears anywhere in the markup. That is the mutation that matters: putting
 * one rule label back into the component, or leaving one code without a
 * translated name, shows English text and fails here.
 */

import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BUNDLED_DEFINITIONS } from '../../engine/gcode/definitions'
import { machineTemplateDiagnostics, MACHINE_TEMPLATE_RULE_CODES } from '../../engine/gcode/templateRules'
import type { MachineTemplateDiagnostic, MachineTemplateRuleCode } from '../../engine/gcode/templateRules'
import type { MachineDefinition } from '../../engine/gcode/types'
import { I18nProvider } from '../../i18n/I18nProvider'
import { enMessages } from '../../i18n/locales/en'
import { resetI18nStoreForTests, setActiveLocale, translate } from '../../i18n/store'
import { MachineDiagnosticList } from './MachineDiagnosticList'
import { MACHINE_TEMPLATE_RULE_KEY } from './machineDiagnosticRuleKeys'

// tsx transpiles this file with the classic JSX runtime, which asks for a
// global `React`; the app itself uses the automatic runtime.
const globalWithReact = globalThis as typeof globalThis & { React?: typeof React }
globalWithReact.React = React

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function diagnostic(ruleCode: MachineTemplateRuleCode, index: number): MachineTemplateDiagnostic {
  return {
    path: ['program', 'header', index],
    field: `program.header[${index}]`,
    line: index + 1,
    text: 'G90.1',
    word: 'G90.1',
    ruleCode,
    message: 'engine text is not part of the rendered list',
  }
}

function renderList(diagnostics: readonly MachineTemplateDiagnostic[]): string {
  return renderToStaticMarkup(createElement(
    I18nProvider,
    null,
    createElement(MachineDiagnosticList, { diagnostics }),
  ))
}

// --- the engine returns codes, not user-visible labels -------------------

{
  const grbl = BUNDLED_DEFINITIONS.find((definition) => definition.id === 'grbl')
  assert(grbl !== undefined, 'the build ships GRBL')
  const definition: MachineDefinition = {
    ...structuredClone(grbl),
    program: { ...structuredClone(grbl.program), header: ['G90', 'G90.1'] },
  }
  const diagnostics = machineTemplateDiagnostics(definition)
  assert(diagnostics.length === 1, 'one header line breaks the rule')
  assert(diagnostics[0].ruleCode === 'header', `the diagnostic carries the code: ${diagnostics[0].ruleCode}`)
  assert(!('rule' in diagnostics[0]), 'the diagnostic no longer carries an English rule label')
}

// --- French renders every rule name from the catalog --------------------

{
  const diagnostics = MACHINE_TEMPLATE_RULE_CODES.map(diagnostic)

  setActiveLocale('fr')
  // React escapes apostrophes in text nodes; compare the text the user reads.
  const markup = renderList(diagnostics)
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')

  assert(markup.includes('règle :'), 'the rule prefix is French')
  assert(!markup.includes('rule:'), 'the English rule prefix is absent')
  assert(markup.includes('mot fautif :'), 'the offending-word prefix is French')

  for (const code of MACHINE_TEMPLATE_RULE_CODES) {
    const key = MACHINE_TEMPLATE_RULE_KEY[code]
    const english = enMessages[key]
    const french = translate(key)
    assert(french !== english, `${code}: the French rule name differs from English`)
    assert(!markup.includes(english), `${code}: French markup contains the English rule text "${english}"`)
    assert(markup.includes(french), `${code}: French markup contains "${french}"`)
  }

  // The exact regression the review reported.
  assert(!markup.includes('program header'), 'French markup never shows "program header"')
  assert(markup.includes('en-tête du programme'), 'French markup names the program header in French')

  resetI18nStoreForTests()
}

console.log('machine diagnostic list localization tests passed')
