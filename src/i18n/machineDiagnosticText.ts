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
 * The single presentation mapper for machine-load diagnostics (#1119).
 *
 * The machine layer reports a stable `kind` plus structured fields (machine
 * name, index, next id); it never decides the sentence a user reads. Both the
 * machine manager and the one-time load alert resolve the diagnostic through
 * this table, so every language pack owns the wording and a French user never
 * sees an English reason.
 */

import type { MachineLoadDiagnostic } from '../machine/diagnostics'
import type { MessageParams } from './catalog'
import type { MessageKey } from './locales/en'
import { translate } from './store'

export interface MachineDiagnosticMessage {
  key: MessageKey
  params?: MessageParams
}

function machineNameOf(diagnostic: MachineLoadDiagnostic): string {
  return diagnostic.machineName ?? diagnostic.machineId ?? ''
}

/**
 * Resolve one diagnostic to its catalog key and parameters. Callers that need
 * a translated string at a specific moment use `machineDiagnosticText`;
 * callers that render through React keep the key and call `t` themselves so a
 * language switch re-renders the text.
 */
export function machineDiagnosticMessage(diagnostic: MachineLoadDiagnostic): MachineDiagnosticMessage {
  switch (diagnostic.kind) {
    case 'machine-retained-invalid': {
      const count = diagnostic.templateDiagnostics?.length ?? 0
      return count === 1
        ? {
          key: 'dialogs.machineDiagnostics.load.retainedInvalid.one',
          params: { name: machineNameOf(diagnostic) },
        }
        : {
          key: 'dialogs.machineDiagnostics.load.retainedInvalid.other',
          params: { name: machineNameOf(diagnostic), count },
        }
    }
    case 'machine-moved-to-library':
      return {
        key: 'dialogs.machineDiagnostics.load.movedToLibrary',
        params: { name: machineNameOf(diagnostic) },
      }
    case 'machine-rekeyed':
      return {
        key: 'dialogs.machineDiagnostics.load.rekeyed',
        params: { name: machineNameOf(diagnostic), id: diagnostic.nextId ?? '' },
      }
    case 'machine-consolidated':
      return {
        key: 'dialogs.machineDiagnostics.load.consolidated',
        params: { name: machineNameOf(diagnostic) },
      }
    case 'machine-selection-unresolved':
      return {
        key: 'dialogs.machineDiagnostics.load.selectionUnresolved',
        params: { id: diagnostic.machineId ?? '' },
      }
    case 'machine-structural-error':
      return { key: 'dialogs.machineDiagnostics.load.structuralError' }
    case 'machine-library-unreadable':
      return diagnostic.index === undefined
        ? { key: 'dialogs.machineDiagnostics.load.libraryUnreadable' }
        : {
          key: 'dialogs.machineDiagnostics.load.libraryEntryUnreadable',
          params: { index: diagnostic.index + 1 },
        }
    case 'machine-library-blocked':
      return { key: 'dialogs.machineDiagnostics.load.libraryBlocked' }
    case 'machine-library-write-failed':
      return { key: 'dialogs.machineDiagnostics.load.libraryWriteFailed' }
    case 'machine-kept-in-project':
      return {
        key: 'dialogs.machineDiagnostics.load.keptInProject',
        params: { name: machineNameOf(diagnostic) },
      }
  }
}

/** The localized sentence for one diagnostic in the active locale. */
export function machineDiagnosticText(diagnostic: MachineLoadDiagnostic): string {
  const { key, params } = machineDiagnosticMessage(diagnostic)
  return translate(key, params)
}

/**
 * Join diagnostics into the one-string load-warning surface. Every report is
 * included, including the `info` ones: a rescued machine, a re-keyed id and a
 * consolidated duplicate are exactly what a one-time load alert is for.
 */
export function machineLoadWarning(diagnostics: readonly MachineLoadDiagnostic[]): string | null {
  const messages = diagnostics.map(machineDiagnosticText)
  return messages.length > 0 ? messages.join('\n\n') : null
}
