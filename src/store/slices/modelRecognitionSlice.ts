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
import { cloneProject } from '../helpers/normalize'
import { planRecognizedFeatures } from '../helpers/recognizedFeatures'
import type { ProjectStore } from '../types'
import { createIdAllocator, createNameAllocator } from './importMergeSlice'

export type ModelRecognitionSlice = Pick<ProjectStore, 'addRecognizedFeatures'>

/**
 * Draws the pockets and holes found on an imported model (issue #1206): one
 * new folder after the model, one history entry, the new shapes selected.
 */
export function createModelRecognitionSlice(
  set: Parameters<StateCreator<ProjectStore>>[0],
  get: Parameters<StateCreator<ProjectStore>>[1],
): ModelRecognitionSlice {
  return {
    addRecognizedFeatures: (input) => {
      const { project } = get()
      const plan = planRecognizedFeatures(
        project,
        input,
        createIdAllocator(project),
        createNameAllocator(project.features.map((feature) => feature.name)),
        createNameAllocator(project.featureFolders.map((folder) => folder.name)),
      )
      if (!plan) return []

      set((current) => ({
        project: plan.project,
        selection: {
          ...current.selection,
          selectedFeatureId: plan.createdIds.at(-1) ?? null,
          selectedFeatureIds: plan.createdIds,
          selectedNode: { type: 'folder', folderId: plan.folderId },
          mode: 'feature',
          activeControl: null,
        },
        history: {
          past: [...current.history.past, cloneProject(current.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }))
      return plan.createdIds
    },
  }
}
