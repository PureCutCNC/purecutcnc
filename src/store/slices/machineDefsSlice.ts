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
 * The project's machine snapshot. A project embeds **at most one** complete
 * definition — the one selected for it — and the machine *library* lives in
 * `src/machine/` as an application preference. So this slice owns exactly one
 * action: atomically set or clear that snapshot.
 *
 * Library CRUD deliberately does not live here: editing or removing a machine
 * in My Machines must never touch a project, dirty it, or enter its undo
 * history.
 */

import type { StateCreator } from 'zustand'
import type { ProjectStore } from '../types'
import { readMachineDefinitionStructure } from '../../engine/gcode/types'
import type { MachineDefinition } from '../../engine/gcode/types'
import type { Project } from '../../types/project'
import { rescueMachinesToLibrary } from '../../machine/store'
import { cloneProject } from '../helpers/normalize'
import { projectWithMachineDefinitions } from '../helpers/machineDefinitions'

export type MachineDefsSlice = Pick<ProjectStore, 'setProjectMachine'>

/**
 * The snapshot a definition becomes in a project: read structurally and
 * copied by value, so a later library edit cannot reach back into the project
 * and the embedded copy stays authoritative for export.
 *
 * Structural rather than strict (#1119): selecting a machine whose templates
 * still break a rule must not throw or silently clear the selection. The
 * machine is embedded unchanged; the export guard reads its diagnostics.
 */
export function machineSnapshot(definition: MachineDefinition | null): MachineDefinition | null {
  return definition ? readMachineDefinitionStructure(structuredClone(definition)) : null
}

/**
 * The project with `snapshot` embedded as its machine (or cleared), without
 * touching undo history. Used by the New Project dialog through
 * `projectWithProjectType`, which selects a machine while the project is
 * created (issue #1028).
 *
 * Selection is not deletion: every definition the project already carries is
 * rescued into My Machines before it can leave, and stays in the project when
 * the library cannot make the rescue durable (#1119).
 */
export function projectWithMachine(project: Project, snapshot: MachineDefinition | null): Project {
  const result = projectWithMachineDefinitions(
    project,
    {
      machineDefinitions: snapshot ? [snapshot] : [],
      selectedMachineId: snapshot?.id ?? null,
    },
    {
      rescue: rescueMachinesToLibrary,
      // Clearing through this helper is an explicit user delete of the selected
      // machine, exactly like clearing it through the store action.
      explicitlyRemoved: snapshot || !project.meta.selectedMachineId
        ? undefined
        : new Set([project.meta.selectedMachineId]),
    },
  ).project
  return {
    ...result,
    meta: { ...result.meta, modified: new Date().toISOString() },
  }
}

export function createMachineDefsSlice(
  set: Parameters<StateCreator<ProjectStore>>[0],
): MachineDefsSlice {

  return {
    setProjectMachine: (definition) =>
      set((s) => {
        // Snapshot by value: later library edits cannot reach back into the
        // project, and the embedded copy stays authoritative for export.
        const snapshot = machineSnapshot(definition)
        const current = s.project.meta.machineDefinitions[0] ?? null
        const unchanged = (snapshot?.id ?? null) === (s.project.meta.selectedMachineId ?? null)
          && JSON.stringify(current) === JSON.stringify(snapshot)
        if (unchanged) {
          return {}
        }

        // Clearing the selection is the one explicit user delete here: the
        // chosen machine may leave without a rescue. Retained definitions that
        // are not selected still get the rescue-or-keep treatment.
        const result = projectWithMachineDefinitions(
          s.project,
          {
            machineDefinitions: snapshot ? [snapshot] : [],
            selectedMachineId: snapshot?.id ?? null,
          },
          {
            rescue: rescueMachinesToLibrary,
            explicitlyRemoved: snapshot || !s.project.meta.selectedMachineId
              ? undefined
              : new Set([s.project.meta.selectedMachineId]),
          },
        )
        return {
          project: {
            ...result.project,
            meta: { ...result.project.meta, modified: new Date().toISOString() },
          },
          ...(result.diagnostics.length > 0
            ? { machineLoadDiagnostics: [...s.machineLoadDiagnostics, ...result.diagnostics] }
            : {}),
          history: {
            past: [...s.history.past, cloneProject(s.project)].slice(-100),
            future: [],
            transactionStart: null,
          },
        }
      }),
  }
}
