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
import { applyNestToProject, discardNestFromProject } from '../helpers/nestApply'
import { nextPlacementSession } from '../helpers/ids'
import { cloneProject } from '../helpers/normalize'
import type { ProjectStore } from '../types'
import { sanitizeSelection } from './selectionSlice'

export type NestingSlice = Pick<ProjectStore, 'pendingNest' | 'startNest' | 'cancelNest' | 'applyNest' | 'discardNest'>

/** Sheet nesting commits (issue #741). Each action is exactly one history entry. */
export function createNestingSlice(
  set: Parameters<StateCreator<ProjectStore>>[0],
): NestingSlice {
  return {
    pendingNest: null,

    startNest: () => set((s) => {
      const sourceIds = s.selection.selectedFeatureIds
      if (sourceIds.length === 0) return {}
      return {
        pendingAdd: null,
        pendingMove: null,
        pendingTransform: null,
        pendingOffset: null,
        pendingShapeAction: null,
        pendingFeatureDistribution: null,
        sketchEditSession: null,
        pendingNest: { sourceIds: [...sourceIds], session: nextPlacementSession() },
      }
    }),

    cancelNest: () => set({ pendingNest: null }),

    applyNest: (input) => {
      let nestId: string | null = null
      set((s) => {
        const result = applyNestToProject(s.project, input)
        if (!result) return {}
        nestId = result.nestId
        const selectedIds = [...input.parts.flatMap((part) => part.featureIds), ...result.copyIds]
        const primaryId = selectedIds.at(-1) ?? null
        return {
          project: result.project,
          selection: {
            ...s.selection,
            selectedFeatureId: primaryId,
            selectedFeatureIds: selectedIds,
            selectedNode: primaryId ? { type: 'feature' as const, featureId: primaryId } : null,
            mode: 'feature' as const,
            activeControl: null,
          },
          history: {
            past: [...s.history.past, cloneProject(s.project)].slice(-100),
            future: [],
            transactionStart: null,
          },
        }
      })
      return nestId
    },

    discardNest: (nestId) => set((s) => {
      const project = discardNestFromProject(s.project, nestId)
      if (!project) return {}
      return {
        project,
        selection: sanitizeSelection(project, s.selection),
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),
  }
}
