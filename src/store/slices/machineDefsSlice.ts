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
import { validateMachineDefinition } from '../../engine/gcode/types'
import { cloneProject } from '../helpers/normalize'

export type MachineDefsSlice = Pick<ProjectStore, 'setProjectMachine'>

export function createMachineDefsSlice(
  set: Parameters<StateCreator<ProjectStore>>[0],
): MachineDefsSlice {

  return {
    setProjectMachine: (definition) =>
      set((s) => {
        // Snapshot by value: later library edits cannot reach back into the
        // project, and the embedded copy stays authoritative for export.
        const snapshot = definition
          ? validateMachineDefinition(structuredClone(definition))
          : null
        const current = s.project.meta.machineDefinitions[0] ?? null
        const unchanged = (snapshot?.id ?? null) === (s.project.meta.selectedMachineId ?? null)
          && JSON.stringify(current) === JSON.stringify(snapshot)
        if (unchanged) {
          return {}
        }

        const nextProject = {
          ...s.project,
          meta: {
            ...s.project.meta,
            machineDefinitions: snapshot ? [snapshot] : [],
            selectedMachineId: snapshot?.id ?? null,
            modified: new Date().toISOString(),
          },
        }
        return {
          project: nextProject,
          history: {
            past: [...s.history.past, cloneProject(s.project)].slice(-100),
            future: [],
            transactionStart: null,
          },
        }
      }),
  }
}
