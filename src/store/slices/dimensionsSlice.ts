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
import { nextUniqueGeneratedId } from '../helpers/ids'
import { cloneProject } from '../helpers/normalize'
import type { ProjectStore } from '../types'

export type DimensionsSlice = Pick<
  ProjectStore,
  | 'selectedAnnotationId'
  | 'addDimensionAnnotation'
  | 'updateDimensionAnnotation'
  | 'deleteDimensionAnnotation'
  | 'selectAnnotation'
>

export function createDimensionsSlice(
  set: Parameters<StateCreator<ProjectStore>>[0],
  get: Parameters<StateCreator<ProjectStore>>[1],
): DimensionsSlice {

  /** Build a history-aware state patch for a project mutation. */
  function commit(s: ProjectStore, nextProject: Project): Partial<ProjectStore> {
    const project = { ...nextProject, meta: { ...nextProject.meta, modified: new Date().toISOString() } }
    if (s.history.transactionStart) {
      return { project }
    }
    return {
      project,
      history: {
        past: [...s.history.past, cloneProject(s.project)].slice(-100),
        future: [],
        transactionStart: null,
      },
    }
  }

  return {
    selectedAnnotationId: null,

    addDimensionAnnotation: (annotation) => {
      const id = nextUniqueGeneratedId(get().project, 'dim')
      set((s) => ({
        ...commit(s, {
          ...s.project,
          annotations: [...s.project.annotations, { ...annotation, id }],
        }),
        selectedAnnotationId: id,
      }))
      return id
    },

    updateDimensionAnnotation: (id, patch) =>
      set((s) => {
        const exists = s.project.annotations.some((a) => a.id === id)
        if (!exists) return {}
        return commit(s, {
          ...s.project,
          annotations: s.project.annotations.map((a) => (a.id === id ? { ...a, ...patch, id: a.id } : a)),
        })
      }),

    deleteDimensionAnnotation: (id) =>
      set((s) => {
        if (!s.project.annotations.some((a) => a.id === id)) return {}
        return {
          ...commit(s, {
            ...s.project,
            annotations: s.project.annotations.filter((a) => a.id !== id),
          }),
          selectedAnnotationId: s.selectedAnnotationId === id ? null : s.selectedAnnotationId,
        }
      }),

    selectAnnotation: (id) =>
      set(() => ({ selectedAnnotationId: id })),
  }
}
