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

import type { StateCreator } from 'zustand'
import type { Project } from '../../types/project'
import type { ProjectStore } from '../types'
import { copyBundledDefinitions } from '../../engine/gcode/definitions'
import { validateMachineDefinition } from '../../engine/gcode/types'

export interface MachineDefsSliceDependencies {
  cloneProject: (project: Project) => Project
  projectsEqual: (a: Project, b: Project) => boolean
}

export type MachineDefsSlice = Pick<
  ProjectStore,
  | 'setSelectedMachineId'
  | 'addMachineDefinition'
  | 'removeMachineDefinition'
  | 'refreshMachineDefinitions'
>

export function createMachineDefsSlice(
  set: Parameters<StateCreator<ProjectStore>>[0],
  _get: Parameters<StateCreator<ProjectStore>>[1],
  deps: MachineDefsSliceDependencies,
): MachineDefsSlice {
  const { cloneProject, projectsEqual } = deps

  return {
    setSelectedMachineId: (id) =>
      set((s) => {
        const nextId = id && s.project.meta.machineDefinitions.some((definition) => definition.id === id)
          ? id
          : null
        const nextProject = {
          ...s.project,
          meta: { ...s.project.meta, selectedMachineId: nextId, modified: new Date().toISOString() },
        }
        if (projectsEqual(nextProject, s.project)) {
          return {}
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

    addMachineDefinition: (definition) =>
      set((s) => {
        const normalizedDefinition = validateMachineDefinition({
          ...definition,
          builtin: false,
        })
        const machineDefinitions = [
          ...s.project.meta.machineDefinitions.filter((entry) => entry.id !== normalizedDefinition.id),
          normalizedDefinition,
        ]
        const nextProject = {
          ...s.project,
          meta: {
            ...s.project.meta,
            machineDefinitions,
            selectedMachineId: normalizedDefinition.id,
            modified: new Date().toISOString(),
          },
        }
        if (projectsEqual(nextProject, s.project)) {
          return {}
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

    removeMachineDefinition: (id) =>
      set((s) => {
        const definition = s.project.meta.machineDefinitions.find((entry) => entry.id === id)
        if (!definition || definition.builtin) {
          return {}
        }

        const machineDefinitions = s.project.meta.machineDefinitions.filter((entry) => entry.id !== id)
        const nextProject = {
          ...s.project,
          meta: {
            ...s.project.meta,
            machineDefinitions,
            selectedMachineId: s.project.meta.selectedMachineId === id ? null : s.project.meta.selectedMachineId,
            modified: new Date().toISOString(),
          },
        }
        if (projectsEqual(nextProject, s.project)) {
          return {}
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

    refreshMachineDefinitions: () =>
      set((s) => {
        const bundledDefinitions = copyBundledDefinitions()
        const bundledIds = new Set(bundledDefinitions.map((definition) => definition.id))
        const customDefinitions = s.project.meta.machineDefinitions.filter(
          (definition) => !definition.builtin && !bundledIds.has(definition.id)
        )
        const machineDefinitions = [...bundledDefinitions, ...customDefinitions]
        const selectedMachineId = machineDefinitions.some(
          (definition) => definition.id === s.project.meta.selectedMachineId
        )
          ? s.project.meta.selectedMachineId
          : null
        const nextProject = {
          ...s.project,
          meta: {
            ...s.project.meta,
            machineDefinitions,
            selectedMachineId,
            modified: new Date().toISOString(),
          },
        }
        if (projectsEqual(nextProject, s.project)) {
          return {}
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
