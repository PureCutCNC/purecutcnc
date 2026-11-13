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
 * The rows the machine manager shows, as a pure value (#1119).
 *
 * The list is the application library plus, when it has to be visible, the
 * project's own embedded copy. That copy used to be shown only when its id was
 * missing from the library, which made a template-invalid project copy
 * unreachable as soon as a library entry had the same id: the only row a user
 * could open was the library's, and editing that one never touches the project.
 * A copy that still breaks a template rule therefore always gets its own row,
 * so it can be repaired in place.
 *
 * Row keys are prefixed (`library:` / `project:`) because both rows may carry
 * the same machine id at the same time.
 */

import { machineExportDiagnostics } from '../../engine/gcode/types'
import type { MachineDefinition } from '../../engine/gcode/types'
import type { MachineTemplateDiagnostic } from '../../engine/gcode/templateRules'

export interface MachineManagerRow {
  /** Unique row identity; a library and a project row can share an id. */
  key: string
  definition: MachineDefinition
  /** True for the project's embedded snapshot, false for a library entry. */
  projectCopy: boolean
  /** Template-rule diagnostics that block this machine's export. */
  diagnostics: MachineTemplateDiagnostic[]
}

export function machineManagerRowKey(
  definition: Pick<MachineDefinition, 'id'>,
  projectCopy: boolean,
): string {
  return `${projectCopy ? 'project' : 'library'}:${definition.id}`
}

export function buildMachineManagerRows(
  library: readonly MachineDefinition[],
  projectMachine: MachineDefinition | null,
): MachineManagerRow[] {
  const rows: MachineManagerRow[] = library.map((definition) => ({
    key: machineManagerRowKey(definition, false),
    definition,
    projectCopy: false,
    diagnostics: machineExportDiagnostics(definition),
  }))
  if (!projectMachine) return rows

  const diagnostics = machineExportDiagnostics(projectMachine)
  const inLibrary = library.some((definition) => definition.id === projectMachine.id)
  // A project-only machine is always listed (it is the only copy). A machine
  // that also exists in the library needs its own row only when it is invalid:
  // a valid differing copy is offered as the "Update project copy" comparison.
  if (!inLibrary || diagnostics.length > 0) {
    rows.push({
      key: machineManagerRowKey(projectMachine, true),
      definition: projectMachine,
      projectCopy: true,
      diagnostics,
    })
  }
  return rows
}

/**
 * The row the manager opens on. A project row wins: either it is the only copy
 * and needs to be usable, or it is invalid and is the thing to repair. A
 * focus request (the update notice) always means the library copy, which is
 * the one being compared.
 */
export function defaultMachineManagerKey(
  rows: readonly MachineManagerRow[],
  focusMachineId: string | null,
): string | null {
  if (focusMachineId) {
    const focused = rows.find((row) => (
      !row.projectCopy && row.definition.id === focusMachineId
    ))
    return focused?.key ?? rows[0]?.key ?? null
  }
  return rows.find((row) => row.projectCopy)?.key ?? rows[0]?.key ?? null
}
