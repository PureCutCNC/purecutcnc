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
import {
  defaultGrid,
  defaultOrigin,
  defaultStock,
  type Project,
} from '../../types/project'
import type { ProjectStore } from '../types'
import {
  clearProjectMemoryCaches,
  cloneProject,
  instantiateProjectTemplate,
  projectsEqual,
} from '../helpers/normalize'
import { pruneUnusedModelAssets } from '../helpers/modelAssets'
import { emptySelection } from './selectionSlice'

export interface ProjectLifecycleSliceDependencies {
  rawSet: Parameters<StateCreator<ProjectStore>>[0]
  normalizeProject: (project: Project) => Project
}

export type ProjectLifecycleSlice = Pick<
  ProjectStore,
  | 'createNewProject'
  | 'setProjectName'
  | 'setProjectClearances'
  | 'setShowDimensions'
  | 'setShowFeatureInfo'
  | 'loadProject'
  | 'saveProject'
  | 'openProjectFromText'
  | 'markSaved'
  | 'markExported'
  | 'markModelExported'
>

export function createProjectLifecycleSlice(
  set: Parameters<StateCreator<ProjectStore>>[0],
  get: Parameters<StateCreator<ProjectStore>>[1],
  deps: ProjectLifecycleSliceDependencies,
): ProjectLifecycleSlice {
  const {
    normalizeProject,
  } = deps

  return {
    createNewProject: (template, name) =>
      set((state) => {
        clearProjectMemoryCaches()
        const nextProject = normalizeProject(instantiateProjectTemplate(template, name))
        return {
          project: nextProject,
          dirty: false,
          filePath: null,
          pendingAdd: null,
          pendingMove: null,
          pendingTransform: null,
          pendingOffset: null,
          selection: emptySelection(),
          projectKey: state.projectKey + 1,
          history: {
            past: [],
            future: [],
            transactionStart: null,
          },
        }
      }),

    setProjectName: (name) =>
      set((s) => {
        const nextProject = {
          ...s.project,
          meta: { ...s.project.meta, name, modified: new Date().toISOString() },
        }
        if (projectsEqual(nextProject, s.project)) {
          return {}
        }
        if (s.history.transactionStart) {
          return { project: nextProject }
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

    setProjectClearances: (patch) =>
      set((s) => {
        const nextProject = {
          ...s.project,
          meta: {
            ...s.project.meta,
            ...patch,
            modified: new Date().toISOString(),
          },
        }
        if (projectsEqual(nextProject, s.project)) {
          return {}
        }
        if (s.history.transactionStart) {
          return { project: nextProject }
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

    setShowDimensions: (visible) =>
      set((s) => {
        const nextProject = {
          ...s.project,
          meta: {
            ...s.project.meta,
            showDimensions: visible,
            modified: new Date().toISOString(),
          },
        }
        if (projectsEqual(nextProject, s.project)) {
          return {}
        }
        if (s.history.transactionStart) {
          return { project: nextProject }
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

    setShowFeatureInfo: (visible) =>
      set((s) => {
        const nextProject = {
          ...s.project,
          meta: {
            ...s.project.meta,
            showFeatureInfo: visible,
            modified: new Date().toISOString(),
          },
        }
        if (projectsEqual(nextProject, s.project)) {
          return {}
        }
        if (s.history.transactionStart) {
          return { project: nextProject }
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

    loadProject: (p) =>
      set((state) => {
        clearProjectMemoryCaches()
        const normalizedProject = normalizeProject(p)
        const stockDefaults = defaultStock(undefined, undefined, undefined, normalizedProject.meta.units)
        const gridDefaults = defaultGrid(normalizedProject.meta.units)
        const nextProject = {
          ...normalizedProject,
          grid: {
            ...gridDefaults,
            ...normalizedProject.grid,
          },
          stock: {
            ...stockDefaults,
            ...normalizedProject.stock,
            origin: normalizedProject.stock?.origin ?? stockDefaults.origin,
            profile: normalizedProject.stock?.profile ?? stockDefaults.profile,
          },
          origin: normalizedProject.origin ?? defaultOrigin(normalizedProject.stock ?? stockDefaults),
        }
        clearProjectMemoryCaches()
        return {
          project: nextProject,
          pendingAdd: null,
          pendingMove: null,
          pendingTransform: null,
          pendingOffset: null,
          selection: emptySelection(),
          projectKey: state.projectKey + 1,
          history: {
            past: [],
            future: [],
            transactionStart: null,
          },
        }
      }),

    saveProject: () => {
      const p = pruneUnusedModelAssets(get().project)
      const updated = {
        ...p,
        meta: { ...p.meta, modified: new Date().toISOString() },
      }
      return JSON.stringify(updated, null, 2)
    },

    openProjectFromText: (content, path) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(content)
      } catch {
        throw new Error('Failed to parse project file.')
      }
      const normalized = normalizeProject(parsed as ReturnType<typeof normalizeProject>)
      const stockDefaults = defaultStock(undefined, undefined, undefined, normalized.meta.units)
      const gridDefaults = defaultGrid(normalized.meta.units)
      clearProjectMemoryCaches()
      set((state) => ({
        project: {
          ...normalized,
          grid: { ...gridDefaults, ...normalized.grid },
          stock: {
            ...stockDefaults,
            ...normalized.stock,
            origin: normalized.stock?.origin ?? stockDefaults.origin,
            profile: normalized.stock?.profile ?? stockDefaults.profile,
          },
          origin: normalized.origin ?? defaultOrigin(normalized.stock ?? stockDefaults),
        },
        filePath: path,
        dirty: false,
        pendingAdd: null,
        pendingMove: null,
        pendingTransform: null,
        pendingOffset: null,
        selection: emptySelection(),
        projectKey: state.projectKey + 1,
        history: {
          past: [],
          future: [],
          transactionStart: null,
        },
      }))
    },

    markSaved: (path) =>
      deps.rawSet({ filePath: path, dirty: false }),

    markExported: (path) =>
      set({ lastExportPath: path }),

    markModelExported: (path) =>
      set({ lastModelExportPath: path }),
  }
}
