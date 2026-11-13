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
 * The template diagnostics the machine editor shows while a definition is
 * being edited (#1119).
 *
 * The editor's Save button is gated on the strict schema, so an invalid
 * definition cannot be saved — but the old screen only showed the strict
 * schema's first message, with no template path, line, offending text or rule.
 * These diagnostics come from the *live* content: the Advanced JSON when it is
 * readable, otherwise the focused form merged onto the definition. They are a
 * pure function of that content, so the panel updates as the user repairs a
 * line and disappears exactly when Save becomes enabled.
 */

import {
  machineExportDiagnostics,
  readMachineDefinitionStructure,
} from '../../engine/gcode/types'
import type { MachineDefinition } from '../../engine/gcode/types'
import type { MachineTemplateDiagnostic } from '../../engine/gcode/templateRules'
import { mergeFormData, type MachineFormData } from './machineDefinitionForm'

/**
 * The definition the diagnostics should describe. A JSON syntax error (or a
 * raw edit that is not structurally a machine) falls back to the focused form,
 * which is what the editor's own validation does.
 */
export function diagnosticDefinition(
  definition: MachineDefinition,
  form: MachineFormData,
  advancedJson: string,
): MachineDefinition {
  try {
    return readMachineDefinitionStructure(JSON.parse(advancedJson))
  } catch {
    // The raw editor is mid-edit or structurally incomplete; the focused form
    // is the last complete picture of the machine.
  }
  try {
    return readMachineDefinitionStructure(mergeFormData(definition, form))
  } catch {
    return definition
  }
}

export function machineEditorDiagnostics(
  definition: MachineDefinition,
  form: MachineFormData,
  advancedJson: string,
): MachineTemplateDiagnostic[] {
  return machineExportDiagnostics(diagnosticDefinition(definition, form, advancedJson))
}
