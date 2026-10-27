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
 * The machine editor's live template diagnostics (#1119). Run with:
 *   npx tsx src/components/machine/machineEditorDiagnostics.test.ts
 *
 * The panel must describe what the user is editing right now — including a
 * raw JSON edit that is still syntactically broken — and disappear the moment
 * the last offending line is corrected.
 */

import { BUNDLED_DEFINITIONS } from '../../engine/gcode/definitions'
import type { MachineDefinition } from '../../engine/gcode/types'
import { toFormData, type MachineFormData } from './machineDefinitionForm'
import { diagnosticDefinition, machineEditorDiagnostics } from './machineEditorDiagnostics'

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const grbl = BUNDLED_DEFINITIONS.find((definition) => definition.id === 'grbl')
assert(grbl !== undefined, 'the build ships GRBL')
const definition = structuredClone(grbl)

function formWith(header: string): MachineFormData {
  return { ...toFormData(definition), header }
}

// --- a valid definition has nothing to report ---------------------------

{
  const diagnostics = machineEditorDiagnostics(definition, formWith('G90'), JSON.stringify(definition))
  assert(diagnostics.length === 0, 'a valid machine has no diagnostics')
}

// --- a raw JSON edit reports the offending line -------------------------

{
  const invalid: MachineDefinition = structuredClone(definition)
  invalid.program.header = ['G90', 'G90.1']
  const diagnostics = machineEditorDiagnostics(definition, formWith('G90'), JSON.stringify(invalid))
  assert(diagnostics.length > 0, 'the invalid JSON edit is reported')
  const first = diagnostics[0]
  assert(first.field === 'program.header[1]', `the field is named: ${first.field}`)
  assert(first.line === 2, `the line is one-based: ${first.line}`)
  assert(first.text === 'G90.1', `the offending text is shown: ${first.text}`)
  assert(first.word === 'G90.1', `the offending word is shown: ${first.word}`)
  assert(first.ruleCode === 'header', `the rule is named: ${first.ruleCode}`)

  // Repairing the raw edit removes the diagnostic.
  const repaired: MachineDefinition = structuredClone(definition)
  repaired.program.header = ['G90']
  assert(
    machineEditorDiagnostics(definition, formWith('G90'), JSON.stringify(repaired)).length === 0,
    'a repaired raw edit reports nothing',
  )
}

// --- broken JSON falls back to the focused form -------------------------

{
  // Mid-edit JSON cannot be parsed, so the form is the live picture.
  const diagnostics = machineEditorDiagnostics(definition, formWith('G90\nG90.1'), '{ "program": ')
  assert(diagnostics.length > 0, 'the focused form is reported while the JSON is broken')
  assert(diagnostics[0].word === 'G90.1', 'the focused form names the offending word')
  assert(
    machineEditorDiagnostics(definition, formWith('G90'), '{ "program": ').length === 0,
    'fixing the focused form clears the report even with broken JSON',
  )
}

// --- structurally incomplete JSON also falls back to the form -----------

{
  const structurallyBroken = JSON.stringify({ id: 'grbl', name: 'GRBL', program: {} })
  const diagnostics = machineEditorDiagnostics(definition, formWith('G90.1'), structurallyBroken)
  assert(diagnostics.length > 0, 'an incomplete raw edit is described from the form')
  assert(diagnostics[0].word === 'G90.1', 'the form supplies the line')
}

// --- the definition is described when neither source parses -------------

{
  const resolved = diagnosticDefinition(definition, formWith('G90'), '{')
  assert(resolved.id === definition.id, 'the last complete definition is the fallback')
}

console.log('machine editor diagnostics tests passed')
