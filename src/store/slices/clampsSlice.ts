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
import type { Clamp, Project } from '../../types/project'
import type { ProjectStore } from '../types'
import { getStockBounds } from '../../types/project'
import { convertLength } from '../../utils/units'
import { nextUniqueGeneratedId } from '../helpers/ids'
import { emptySelection, sanitizeSelection } from './selectionSlice'

export interface ClampsSliceDependencies {
  cloneProject: (project: Project) => Project
  projectsEqual: (a: Project, b: Project) => boolean
  duplicateClampName: (name: string, clamps: Clamp[]) => string
}

export type ClampsSlice = Pick<
  ProjectStore,
  | 'addClamp'
  | 'updateClamp'
  | 'deleteClamp'
  | 'setAllClampsVisible'
  | 'duplicateClamp'
  | 'moveClampControl'
>

export function createClampsSlice(
  set: Parameters<StateCreator<ProjectStore>>[0],
  get: Parameters<StateCreator<ProjectStore>>[1],
  deps: ClampsSliceDependencies,
): ClampsSlice {
  const { cloneProject, projectsEqual, duplicateClampName } = deps

  return {
    addClamp: () => {
      const state = get()
      const bounds = getStockBounds(state.project.stock)
      const units = state.project.meta.units
      const width = convertLength(12, 'mm', units)
      const depth = convertLength(12, 'mm', units)
      const clampHeight = Math.min(
        Math.max(convertLength(8, 'mm', units), convertLength(0.1, 'mm', units)),
        state.project.stock.thickness,
      )
      const id = nextUniqueGeneratedId(state.project, 'cl')
      const clamp: Clamp = {
        id,
        name: `Clamp ${state.project.clamps.length + 1}`,
        type: 'step_clamp',
        x: bounds.minX + convertLength(4, 'mm', units),
        y: bounds.minY + convertLength(4, 'mm', units),
        w: width,
        h: depth,
        height: clampHeight,
        visible: true,
      }

      set((s) => ({
        project: {
          ...s.project,
          clamps: [...s.project.clamps, clamp],
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        },
        selection: {
          ...s.selection,
          selectedFeatureId: null,
          selectedFeatureIds: [],
          selectedNode: { type: 'clamp', clampId: id },
          mode: 'feature',
          activeControl: null,
        },
        sketchEditSession: null,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }))

      return id
    },

    updateClamp: (id, patch) =>
      set((s) => {
        const nextProject = {
          ...s.project,
          clamps: s.project.clamps.map((clamp) => (clamp.id === id ? { ...clamp, ...patch } : clamp)),
          meta: { ...s.project.meta, modified: new Date().toISOString() },
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

    deleteClamp: (id) =>
      set((s) => {
        const nextProject = {
          ...s.project,
          clamps: s.project.clamps.filter((clamp) => clamp.id !== id),
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        }
        if (projectsEqual(nextProject, s.project)) {
          return {}
        }
        const nextSelection =
          s.selection.selectedNode?.type === 'clamp' && s.selection.selectedNode.clampId === id
            ? emptySelection()
            : sanitizeSelection(nextProject, s.selection)
        return {
          project: nextProject,
          selection: nextSelection,
          history: {
            past: [...s.history.past, cloneProject(s.project)].slice(-100),
            future: [],
            transactionStart: null,
          },
        }
      }),

    duplicateClamp: (id) => {
      const state = get()
      const sourceClamp = state.project.clamps.find((clamp) => clamp.id === id)
      if (!sourceClamp) {
        return null
      }

      const nextId = nextUniqueGeneratedId(state.project, 'cl')
      const duplicate: Clamp = {
        ...sourceClamp,
        id: nextId,
        name: duplicateClampName(sourceClamp.name, state.project.clamps),
        x: sourceClamp.x + convertLength(4, 'mm', state.project.meta.units),
        y: sourceClamp.y + convertLength(4, 'mm', state.project.meta.units),
      }

      set((s) => ({
        project: {
          ...s.project,
          clamps: [...s.project.clamps, duplicate],
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        },
        selection: {
          ...s.selection,
          selectedFeatureId: null,
          selectedFeatureIds: [],
          selectedNode: { type: 'clamp', clampId: nextId },
          mode: 'feature',
          hoveredFeatureId: null,
          activeControl: null,
        },
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }))

      return nextId
    },

    setAllClampsVisible: (visible) =>
      set((s) => {
        const nextProject = {
          ...s.project,
          clamps: s.project.clamps.map((clamp) => ({ ...clamp, visible })),
          meta: { ...s.project.meta, modified: new Date().toISOString() },
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

    moveClampControl: (clampId, control, point) =>
      set((s) => {
        const minSize = convertLength(0.1, 'mm', s.project.meta.units)
        const nextProject = {
          ...s.project,
          clamps: s.project.clamps.map((clamp) => {
            if (clamp.id !== clampId) {
              return clamp
            }

            if (control.kind !== 'anchor') {
              return clamp
            }

            const corners = [
              { x: clamp.x, y: clamp.y },
              { x: clamp.x + clamp.w, y: clamp.y },
              { x: clamp.x + clamp.w, y: clamp.y + clamp.h },
              { x: clamp.x, y: clamp.y + clamp.h },
            ]
            const opposite = corners[(control.index + 2) % 4]
            const minX = Math.min(point.x, opposite.x)
            const maxX = Math.max(point.x, opposite.x)
            const minY = Math.min(point.y, opposite.y)
            const maxY = Math.max(point.y, opposite.y)

            return {
              ...clamp,
              x: minX,
              y: minY,
              w: Math.max(maxX - minX, minSize),
              h: Math.max(maxY - minY, minSize),
            }
          }),
          meta: { ...s.project.meta, modified: new Date().toISOString() },
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
  }
}
