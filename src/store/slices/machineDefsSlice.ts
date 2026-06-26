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
import type { MachineDefinition } from '../../engine/gcode/types'
import type { ProjectStore } from '../types'
import { copyBundledDefinitions } from '../../engine/gcode/definitions'
import { validateMachineDefinition } from '../../engine/gcode/types'
import { cloneProject, projectsEqual } from '../helpers/normalize'

/** Turn a machine name into a URL-safe id slug (lowercase, hyphens). */
export function slugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
}

/** Allocate a unique machine-definition id from a name, deduping against existing ids. */
export function allocateMachineId(name: string, existingIds: Set<string>): string {
  const base = slugFromName(name) || 'custom-machine'
  let candidate = base
  let n = 2
  while (existingIds.has(candidate)) {
    candidate = `${base}-${n}`
    n += 1
  }
  return candidate
}

export type MachineDefsSlice = Pick<
  ProjectStore,
  | 'setSelectedMachineId'
  | 'addMachineDefinition'
  | 'removeMachineDefinition'
  | 'updateMachineDefinition'
  | 'duplicateMachineDefinition'
  | 'refreshMachineDefinitions'
>

export function createMachineDefsSlice(
  set: Parameters<StateCreator<ProjectStore>>[0],
): MachineDefsSlice {

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

    updateMachineDefinition: (id, patch) =>
      set((s) => {
        const index = s.project.meta.machineDefinitions.findIndex((entry) => entry.id === id)
        const existing = s.project.meta.machineDefinitions[index]
        // Guard: must exist and be custom (not builtin).
        if (!existing || existing.builtin) {
          return {}
        }
        // Ignore id changes in the patch — the entry keeps its original id.
        const validated = validateMachineDefinition({ ...patch, id: existing.id, builtin: false })
        const machineDefinitions = [...s.project.meta.machineDefinitions]
        // Replace in place to preserve array order.
        machineDefinitions[index] = validated
        const nextProject = {
          ...s.project,
          meta: {
            ...s.project.meta,
            machineDefinitions,
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

    duplicateMachineDefinition: (id) =>
      set((s) => {
        const source = s.project.meta.machineDefinitions.find((entry) => entry.id === id)
        if (!source) {
          return {}
        }

        const existingIds = new Set(s.project.meta.machineDefinitions.map((entry) => entry.id))
        const suffix = ' (copy)'
        const newId = allocateMachineId(`${source.name}${suffix}`, existingIds)

        const clone: MachineDefinition = validateMachineDefinition({
          ...JSON.parse(JSON.stringify(source)),
          id: newId,
          name: `${source.name}${suffix}`,
          builtin: false,
        })
        existingIds.add(newId)

        const machineDefinitions = [...s.project.meta.machineDefinitions, clone]
        const nextProject = {
          ...s.project,
          meta: {
            ...s.project.meta,
            machineDefinitions,
            selectedMachineId: newId,
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
