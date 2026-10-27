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
 * One machine's template-rule diagnostics, rendered the same way in the
 * machine manager, the machine editor and the export dialog (#1119).
 *
 * Every entry names the template path, its one-based line, the offending text
 * and word, and the rule that refused it, so the three surfaces cannot tell
 * the user different stories about why export is blocked. The raw values are
 * also carried as data attributes, which is what the browser smokes assert.
 */

import type { MachineTemplateDiagnostic } from '../../engine/gcode/templateRules'
import { useI18n } from '../../i18n/i18nContext'
import { dialogsEn } from '../../i18n/locales/en/dialogs'

export interface MachineDiagnosticListProps {
  diagnostics: readonly MachineTemplateDiagnostic[]
}

export function MachineDiagnosticList({ diagnostics }: MachineDiagnosticListProps) {
  const { t } = useI18n()

  function td(key: keyof typeof dialogsEn, params?: Record<string, string | number>): string {
    return t(key, params)
  }

  if (diagnostics.length === 0) return null

  return (
    <ul className="machine-diagnostics" data-testid="machine-diagnostics">
      {diagnostics.map((diagnostic, index) => (
        <li
          key={`${diagnostic.field}:${diagnostic.line}:${diagnostic.word}:${index}`}
          className="machine-diagnostic"
          data-testid="machine-diagnostic"
          data-field={diagnostic.field}
          data-line={diagnostic.line}
          data-word={diagnostic.word}
          data-rule={diagnostic.rule}
        >
          <div className="machine-diagnostic-location">
            <code className="machine-diagnostic-field">{diagnostic.field}</code>
            <span>{td('dialogs.machineDiagnostics.line', { line: diagnostic.line })}</span>
            <span className="machine-diagnostic-rule">{td('dialogs.machineDiagnostics.rule', { rule: diagnostic.rule })}</span>
          </div>
          <pre className="machine-diagnostic-text">{diagnostic.text}</pre>
          <div className="machine-diagnostic-word">
            {td('dialogs.machineDiagnostics.word', { word: diagnostic.word })}
          </div>
        </li>
      ))}
    </ul>
  )
}
