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
import { createImportedFeature, isProfileDegenerate, mergeCamjFolders } from '../../import'
import type {
  FeatureDefinition,
  FeatureFolder,
  FeatureOperation,
  Project,
  SketchFeature,
} from '../../types/project'
import { createDefinitionForFeatureWithId, createFeatureInstance } from '../helpers/featureDefinitions'
import { genId } from '../helpers/ids'
import { cloneProject, normalizeFeatureZRange, syncFeatureTreeProject } from '../helpers/normalize'
import type { ProjectStore } from '../types'

/** Imports at this size avoid expanded folders and multi-item selection. */
export const LARGE_IMPORT_THRESHOLD = 500

export type ImportMergeSlice = Pick<ProjectStore, 'importShapes' | 'importCamjFolders'>

function createNameAllocator(existingNames: Iterable<string>): (preferred: string) => string {
  const taken = new Set(existingNames)
  const nextSuffix = new Map<string, number>()
  return (preferred) => {
    const base = preferred.trim() || 'Imported'
    if (!taken.has(base)) {
      taken.add(base)
      return base
    }
    let suffix = nextSuffix.get(base) ?? 2
    while (taken.has(`${base} ${suffix}`)) suffix += 1
    const name = `${base} ${suffix}`
    taken.add(name)
    nextSuffix.set(base, suffix + 1)
    return name
  }
}

function createIdAllocator(project: Project): (prefix: string) => string {
  const used = new Set([
    ...project.features.map((feature) => feature.id),
    ...Object.keys(project.featureDefinitions),
    ...project.featureFolders.map((folder) => folder.id),
    ...project.tools.map((tool) => tool.id),
    ...project.operations.map((operation) => operation.id),
    ...project.tabs.map((tab) => tab.id),
    ...project.clamps.map((clamp) => clamp.id),
  ])
  return (prefix) => {
    let id = genId(prefix)
    while (used.has(id)) id = genId(prefix)
    used.add(id)
    return id
  }
}

export function createImportMergeSlice(
  set: Parameters<StateCreator<ProjectStore>>[0],
  get: Parameters<StateCreator<ProjectStore>>[1],
): ImportMergeSlice {
  return {
    importShapes: (input) => {
      const state = get()
      const sourceShapes = input.shapes.filter((shape) => !isProfileDegenerate(shape.profile))
      if (sourceShapes.length === 0) return []

      const allocateId = createIdAllocator(state.project)
      const allocateFeatureName = createNameAllocator(state.project.features.map((feature) => feature.name))
      const allocateFolderName = createNameAllocator(state.project.featureFolders.map((folder) => folder.name))
      const newFolders: FeatureFolder[] = []
      const createdFeatures: SketchFeature[] = []

      if (input.classified && input.classified.length > 0) {
        const validClassified = input.classified.filter((shape) => !isProfileDegenerate(shape.profile))
        if (validClassified.length === 0) return []
        const isLargeImport = validClassified.length >= LARGE_IMPORT_THRESHOLD
        const layerFolderMap = new Map<string, FeatureFolder>()

        for (const shape of validClassified) {
          const layerKey = shape.layerName ?? '0'
          if (!layerFolderMap.has(layerKey)) {
            const folder: FeatureFolder = {
              id: allocateId('fd'),
              name: allocateFolderName(layerKey || '0'),
              collapsed: isLargeImport,
            }
            layerFolderMap.set(layerKey, folder)
            newFolders.push(folder)
          }
        }

        // The classifier owns global parent-before-child order, including
        // cross-layer nesting. Preserve that order while attaching folders.
        for (const shape of validClassified) {
          const layerKey = shape.layerName ?? '0'
          const folder = layerFolderMap.get(layerKey)
          if (!folder) throw new Error(`Missing import folder for layer ${layerKey}`)
          createdFeatures.push(normalizeFeatureZRange({
            ...createImportedFeature(
              {
                name: shape.name,
                sourceType: shape.sourceType,
                layerName: shape.layerName,
                profile: shape.profile,
              },
              state.project,
              folder.id,
              allocateFeatureName(shape.name || layerKey),
              shape.operation,
            ),
            id: allocateId('f'),
          }))
        }
      } else {
        const isLargeImport = sourceShapes.length >= LARGE_IMPORT_THRESHOLD
        const layerGroups = new Map<string, typeof sourceShapes>()
        for (const shape of sourceShapes) {
          const layerKey = shape.layerName ?? '0'
          const group = layerGroups.get(layerKey)
          if (group) group.push(shape)
          else layerGroups.set(layerKey, [shape])
        }

        for (const [layerKey, layerShapes] of layerGroups) {
          const folder: FeatureFolder = {
            id: allocateId('fd'),
            name: allocateFolderName(layerKey || '0'),
            collapsed: isLargeImport,
          }
          newFolders.push(folder)
          for (const shape of layerShapes) {
            const operation: FeatureOperation = shape.profile.closed ? 'add' : 'line'
            createdFeatures.push(normalizeFeatureZRange({
              ...createImportedFeature(
                shape,
                state.project,
                folder.id,
                allocateFeatureName(shape.name || layerKey),
                operation,
              ),
              id: allocateId('f'),
            }))
          }
        }
      }

      if (createdFeatures.length === 0) return []

      const definitions: Record<string, FeatureDefinition> = {}
      const featureInstances = createdFeatures.map((feature) => {
          const definitionId = allocateId('f-')
          const { definition } = createDefinitionForFeatureWithId(feature, definitionId)
          definitions[definitionId] = definition
          return createFeatureInstance(feature, definitionId)
        })
      const createdIds = createdFeatures.map((feature) => feature.id)
      const isLargeImport = createdIds.length >= LARGE_IMPORT_THRESHOLD
      const primaryId = createdIds.at(-1) ?? null
      const primaryFolderId = newFolders.at(-1)?.id ?? null

      set((current) => {
        const nextProject = syncFeatureTreeProject({
          ...current.project,
          featureFolders: [...current.project.featureFolders, ...newFolders],
          featureTree: [
            ...current.project.featureTree,
            ...newFolders.map((folder) => ({ type: 'folder' as const, folderId: folder.id })),
          ],
          features: [...current.project.features, ...featureInstances],
          featureDefinitions: { ...current.project.featureDefinitions, ...definitions },
          meta: { ...current.project.meta, modified: new Date().toISOString() },
        })
        return {
          project: nextProject,
          selection: {
            ...current.selection,
            selectedFeatureId: isLargeImport ? null : primaryId,
            selectedFeatureIds: isLargeImport ? [] : createdIds,
            selectedNode: isLargeImport && primaryFolderId
              ? { type: 'folder', folderId: primaryFolderId }
              : primaryId
                ? { type: 'feature', featureId: primaryId }
                : primaryFolderId
                  ? { type: 'folder', folderId: primaryFolderId }
                  : current.selection.selectedNode,
            mode: 'feature',
            activeControl: null,
          },
          history: {
            past: [...current.history.past, cloneProject(current.project)].slice(-100),
            future: [],
            transactionStart: null,
          },
        }
      })

      return createdIds
    },

    importCamjFolders: (input) => {
      const state = get()
      const merge = mergeCamjFolders({
        currentProject: state.project,
        sourceProject: input.sourceProject,
        selectedFolderIds: input.selectedFolderIds,
        importStock: input.importStock,
      })
      if (merge.createdFeatureIds.length === 0 && !merge.stockReplaced) return []

      set((current) => {
        const nextProject = syncFeatureTreeProject(merge.project)
        const createdIds = merge.createdFeatureIds
        const primaryId = createdIds.at(-1) ?? null
        const primaryFolderId = merge.createdFolderIds.at(-1) ?? null
        return {
          project: nextProject,
          selection: {
            ...current.selection,
            selectedFeatureId: primaryId,
            selectedFeatureIds: createdIds,
            selectedNode: primaryId
              ? { type: 'feature', featureId: primaryId }
              : primaryFolderId
                ? { type: 'folder', folderId: primaryFolderId }
                : current.selection.selectedNode,
            mode: 'feature',
            activeControl: null,
          },
          history: {
            past: [...current.history.past, cloneProject(current.project)].slice(-100),
            future: [],
            transactionStart: null,
          },
        }
      })

      return merge.createdFeatureIds
    },
  }
}
