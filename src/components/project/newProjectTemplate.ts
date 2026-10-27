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
 * Reduce a project used as a New-project template to the shape the dialog
 * creates (#1119).
 *
 * A template carries only the machine snapshot it selected — never a library.
 * The picker always reads the current application library, so a template
 * cannot decide which bundled machines exist. Any other machine the template
 * still carries is rescued into My Machines **before** the extra copies are
 * compacted away, and a template-invalid selected machine is retained exactly
 * as stored; export refuses it until it is repaired.
 *
 * When the library cannot store an unselected machine, it stays in the template
 * and the reason is returned with it (#1119). The dialog's project creation
 * runs the same seam again and surfaces the diagnostic in the store.
 */

import { rescueMachinesToLibrary } from '../../machine/store'
import type { MachineLoadDiagnostic } from '../../machine/diagnostics'
import { normalizeMachineDefinitions } from '../../store/helpers/normalize'
import type { Project } from '../../types/project'

export interface SetupOnlyTemplateResult {
  project: Project
  diagnostics: MachineLoadDiagnostic[]
}

export function setupOnlyTemplate(template: Project): SetupOnlyTemplateResult {
  const cloned = structuredClone(template)
  const selectedId = cloned.meta.selectedMachineId
  const machines = normalizeMachineDefinitions(cloned, (definitions) => (
    // The selected snapshot stays in the template, so only the *other* rescued
    // machines need a home. Merging the selected one would add a machine to My
    // Machines merely by opening this dialog.
    rescueMachinesToLibrary(definitions.filter((definition) => definition.id !== selectedId))
  ))
  // The normalization above is the one rescue-or-keep gate for this write: it
  // already moved the unselected machines into My Machines on a durable rescue,
  // or kept them in the template when the rescue failed. Re-running the write
  // gate would rescue them a second time and re-embed the originals under their
  // old ids (#1119).
  return {
    project: {
      ...cloned,
      meta: {
        ...cloned.meta,
        machineDefinitions: machines.machineDefinitions,
        selectedMachineId: machines.selectedMachineId,
      },
      dimensions: {},
      features: [],
      featureFolders: [],
      featureTree: [],
      global_constraints: [],
      operations: [],
      tabs: [],
      clamps: [],
      ai_history: [],
    },
    diagnostics: machines.diagnostics,
  }
}
