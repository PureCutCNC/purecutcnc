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
import { createImportedFeature, isProfileDegenerate, mergeCamjFolders, uniqueName } from '../../import'
import type { FeatureFolder, FeatureOperation, Project, SketchFeature } from '../../types/project'
import { nextUniqueGeneratedId } from '../helpers/ids'
import { normalizeFeatureZRange } from '../helpers/normalize'
import { uniqueFolderName } from '../helpers/naming'
import type { ProjectStore } from '../types'

export interface ImportMergeSliceDependencies {
  cloneProject: (project: Project) => Project
  syncFeatureTreeProject: (project: Project) => Project
}

export type ImportMergeSlice = Pick<
  ProjectStore,
  | 'importShapes'
  | 'importCamjFolders'
>

export function createImportMergeSlice(
  set: Parameters<StateCreator<ProjectStore>>[0],
  get: Parameters<StateCreator<ProjectStore>>[1],
  deps: ImportMergeSliceDependencies,
): ImportMergeSlice {
  const { cloneProject, syncFeatureTreeProject } = deps

  return {
    importShapes: (input) => {
      const state = get()
      const sourceShapes = input.shapes.filter((shape) => !isProfileDegenerate(shape.profile))
      if (sourceShapes.length === 0) {
        return []
      }

      // Group shapes by layer name. Null layer (DXF layer "0") → keyed as '0'.
      const layerGroups = new Map<string, typeof sourceShapes>()
      for (const shape of sourceShapes) {
        const key = shape.layerName ?? '0'
        const existing = layerGroups.get(key)
        if (existing) {
          existing.push(shape)
        } else {
          layerGroups.set(key, [shape])
        }
      }

      const existingFeatureNames = state.project.features.map((f) => f.name)
      const newFolders: FeatureFolder[] = []
      const createdFeatures: SketchFeature[] = []

      let nextProjectLike: Project = {
        ...state.project,
        features: [...state.project.features],
        featureFolders: [...state.project.featureFolders],
      }

      for (const [layerKey, layerShapes] of layerGroups) {
        const folderDisplayName = layerKey || '0'
        const folderId = nextUniqueGeneratedId(nextProjectLike, 'fd')
        const folderName = uniqueFolderName(folderDisplayName, nextProjectLike.featureFolders)
        const folder: FeatureFolder = { id: folderId, name: folderName, collapsed: false }

        newFolders.push(folder)
        nextProjectLike = { ...nextProjectLike, featureFolders: [...nextProjectLike.featureFolders, folder] }

        for (const shape of layerShapes) {
          const featureName = uniqueName(
            shape.name || folderDisplayName,
            [...existingFeatureNames, ...createdFeatures.map((f) => f.name)],
          )
          // All closed profiles import as 'add'; open profiles as 'line'.
          const operation: FeatureOperation = shape.profile.closed ? 'add' : 'line'
          const nextId = nextUniqueGeneratedId(nextProjectLike, 'f')
          const feature = normalizeFeatureZRange({
            ...createImportedFeature(shape, state.project, folderId, featureName, operation),
            id: nextId,
          })

          createdFeatures.push(feature)
          nextProjectLike = { ...nextProjectLike, features: [...nextProjectLike.features, feature] }
        }
      }

      if (createdFeatures.length === 0) {
        return []
      }

      set((s) => {
        const nextProject = syncFeatureTreeProject({
          ...s.project,
          featureFolders: [...s.project.featureFolders, ...newFolders],
          featureTree: [
            ...s.project.featureTree,
            ...newFolders.map((f) => ({ type: 'folder' as const, folderId: f.id })),
          ],
          features: [...s.project.features, ...createdFeatures],
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        })
        const createdIds = createdFeatures.map((f) => f.id)
        const primaryId = createdIds.at(-1) ?? null
        const primaryFolderId = newFolders.at(-1)?.id ?? null

        return {
          project: nextProject,
          selection: {
            ...s.selection,
            selectedFeatureId: primaryId,
            selectedFeatureIds: createdIds,
            selectedNode: primaryId
              ? { type: 'feature', featureId: primaryId }
              : primaryFolderId
                ? { type: 'folder', folderId: primaryFolderId }
                : s.selection.selectedNode,
            mode: 'feature',
            activeControl: null,
          },
          history: {
            past: [...s.history.past, cloneProject(s.project)].slice(-100),
            future: [],
            transactionStart: null,
          },
        }
      })

      return createdFeatures.map((f) => f.id)
    },

    importCamjFolders: (input) => {
      const state = get()
      const merge = mergeCamjFolders({
        currentProject: state.project,
        sourceProject: input.sourceProject,
        selectedFolderIds: input.selectedFolderIds,
        importStock: input.importStock,
      })
      if (merge.createdFeatureIds.length === 0 && !merge.stockReplaced) {
        return []
      }

      set((s) => {
        const nextProject = syncFeatureTreeProject(merge.project)
        const createdIds = merge.createdFeatureIds
        const primaryId = createdIds.at(-1) ?? null
        const primaryFolderId = merge.createdFolderIds.at(-1) ?? null
        return {
          project: nextProject,
          selection: {
            ...s.selection,
            selectedFeatureId: primaryId,
            selectedFeatureIds: createdIds,
            selectedNode: primaryId
              ? { type: 'feature', featureId: primaryId }
              : primaryFolderId
                ? { type: 'folder', folderId: primaryFolderId }
                : s.selection.selectedNode,
            mode: 'feature',
            activeControl: null,
          },
          history: {
            past: [...s.history.past, cloneProject(s.project)].slice(-100),
            future: [],
            transactionStart: null,
          },
        }
      })

      return merge.createdFeatureIds
    },
  }
}
