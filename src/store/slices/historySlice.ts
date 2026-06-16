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
import { cloneProject, projectsEqual } from '../helpers/normalize'
import { sanitizeSelection } from './selectionSlice'

export interface HistorySliceDependencies {
  normalizeProject: (project: Project) => Project
}

export type HistorySlice = Pick<
  ProjectStore,
  | 'undo'
  | 'redo'
  | 'beginHistoryTransaction'
  | 'commitHistoryTransaction'
  | 'cancelHistoryTransaction'
>

export function createHistorySlice(
  set: Parameters<StateCreator<ProjectStore>>[0],
  _get: Parameters<StateCreator<ProjectStore>>[1],
  deps: HistorySliceDependencies,
): HistorySlice {
  const {
    normalizeProject,
  } = deps

  return {
    undo: () =>
      set((state) => {
        const previous = state.history.past.at(-1)
        if (!previous) {
          return {}
        }
        const restored = normalizeProject(cloneProject(previous))
        return {
          project: restored,
          pendingAdd: null,
          pendingMove: null,
          pendingTransform: null,
          pendingOffset: null,
          selection: sanitizeSelection(restored, state.selection),
          history: {
            past: state.history.past.slice(0, -1),
            future: [cloneProject(state.project), ...state.history.future].slice(0, 100),
            transactionStart: null,
          },
        }
      }),

    redo: () =>
      set((state) => {
        const next = state.history.future[0]
        if (!next) {
          return {}
        }
        const restored = normalizeProject(cloneProject(next))
        return {
          project: restored,
          pendingAdd: null,
          pendingMove: null,
          pendingTransform: null,
          pendingOffset: null,
          selection: sanitizeSelection(restored, state.selection),
          history: {
            past: [...state.history.past, cloneProject(state.project)].slice(-100),
            future: state.history.future.slice(1),
            transactionStart: null,
          },
        }
      }),

    beginHistoryTransaction: () =>
      set((state) => {
        if (state.history.transactionStart) {
          return {}
        }
        return {
          history: {
            ...state.history,
            transactionStart: cloneProject(state.project),
          },
        }
      }),

    commitHistoryTransaction: () =>
      set((state) => {
        const { transactionStart } = state.history
        if (!transactionStart) {
          return {}
        }
        if (projectsEqual(transactionStart, state.project)) {
          return {
            history: {
              ...state.history,
              transactionStart: null,
            },
          }
        }
        return {
          history: {
            past: [...state.history.past, cloneProject(transactionStart)].slice(-100),
            future: [],
            transactionStart: null,
          },
        }
      }),

    cancelHistoryTransaction: () =>
      set((state) => {
        const { transactionStart } = state.history
        if (!transactionStart) {
          return {}
        }
        const restored = normalizeProject(cloneProject(transactionStart))
        return {
          project: restored,
          pendingAdd: null,
          pendingMove: null,
          pendingTransform: null,
          pendingOffset: null,
          selection: sanitizeSelection(restored, state.selection),
          history: {
            ...state.history,
            transactionStart: null,
          },
        }
      }),
  }
}
