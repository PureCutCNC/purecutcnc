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
import type {
  FeatureDefinition,
  FeatureFolder,
  FeatureOperation,
  FeatureTreeEntry,
  Matrix2D,
  Project,
  SketchFeature,
} from '../../types/project'
import type { ProjectStore } from '../types'
import { nextUniqueGeneratedId } from '../helpers/ids'
import {
  cloneProject,
  normalizeFeatureZRange,
  projectsEqual,
  syncFeatureTreeProject,
  syncStockFromSourceFeature,
} from '../helpers/normalize'
import {
  getStockBounds,
  rectProfile,
  circleProfile,
  ellipseProfile,
  polygonProfile,
  slotProfile,
  splineProfile,
  ngonProfile,
  getProfileBounds,
  IDENTITY_MATRIX,
} from '../../types/project'
import { roundedRectProfile, chamferedRectProfile } from '../helpers/cannedRectProfiles'
import { translateProfile } from '../../components/canvas/previewPrimitives'
import { uniqueName } from '../../import'
import { buildShapeFeature } from '../helpers/buildShapeFeature'
import { commonSectionOfIds, isMachinable, sectionForOperation } from '../helpers/featureRoles'
import {
  normalizeDerivedFeatureNameStem,
  insertDerivedFeaturesAfterSources,
  insertDerivedFeatureTreeEntries,
  cutFeaturesByCutterGrouped,
  createDerivedFeature,
  previewOffsetFeatures,
  type DerivedFeatureGroup,
} from '../helpers/derivedFeatures'
import { createDefinitionForFeature, gcOrphanedDefinitions, getDefinitionId, getInstanceIdsForDefinition } from '../helpers/featureDefinitions'
import { resolveFeatureInstances } from '../helpers/resolveFeatures'
import { expandTextFeature } from '../helpers/textExpansion'
import {
  buildSegmentAnnotations,
  clipperContourToProfile,
  clipperContourToProfilePreserving,
} from '../../engine/toolpaths/arcReconstruction'
import { unionClipperPaths, flattenFeatureToClipperPath } from '../helpers/clipping'
import { transformProfile } from '../helpers/transform'
import { moveDelta, multiplyMatrix } from '../helpers/instanceTransforms'
import { isImportedModelFeature, normalizeImportedModelStorage, pruneUnusedModelAssets } from '../helpers/modelAssets'
import { folderIdForOperation, resolveFolderAssignments } from '../helpers/operationDefaults'
import {
  propagateConstraintsOnTranslate,
  validateConstraintsOnFeature,
  type FeatureOffset,
} from '../../sketch/constraintSolver'

export type FeatureSlice = Pick<
  ProjectStore,
  | 'addFeature'
  | 'updateFeature'
  | 'updateFeatures'
  | 'deleteFeature'
  | 'deleteFeatures'
  | 'reorderFeatures'
  | 'addFeatureFolder'
  | 'updateFeatureFolder'
  | 'deleteFeatureFolder'
  | 'assignFeaturesToFolder'
  | 'moveFeatureTreeFeature'
  | 'reorderFeatureTreeEntries'
  | 'setAllFeaturesVisible'
  | 'groupSelectedFeaturesIntoNewFolder'
  | 'addRectFeature'
  | 'addCircleFeature'
  | 'addEllipseFeature'
  | 'addPolygonFeature'
  | 'addSplineFeature'
  | 'addSlotFeature'
  | 'addNgonFeature'
  | 'addRoundRectFeature'
  | 'addChamferRectFeature'
  | 'alignFeatures'
  | 'distributeFeatures'
  | 'mergeSelectedFeatures'
  | 'cutSelectedFeatures'
  | 'offsetSelectedFeatures'
  | 'expandTextFeature'
>

export function createFeatureSlice(
  set: Parameters<StateCreator<ProjectStore>>[0],
  get: Parameters<StateCreator<ProjectStore>>[1],
): FeatureSlice {

  return {
    // ── Feature folders ──────────────────────────────────────

    addFeatureFolder: (section = 'features') => {
      const state = get()
      const nextId = nextUniqueGeneratedId(state.project, 'fd')
      const existingSectionFolders = state.project.featureFolders.filter((folder) => (folder.section ?? 'features') === section)
      const folder: FeatureFolder = {
        id: nextId,
        name: `${section === 'regions' ? 'Region Folder' : section === 'construction' ? 'Construction Folder' : 'Folder'} ${existingSectionFolders.length + 1}`,
        collapsed: false,
        section,
      }

      set((s) => {
        const nextProject = syncFeatureTreeProject({
          ...s.project,
          featureFolders: [...s.project.featureFolders, folder],
          featureTree: [...s.project.featureTree, { type: 'folder', folderId: nextId }],
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        })
        return {
          project: nextProject,
          pendingShapeAction: null,
          selection: {
            ...s.selection,
            selectedFeatureId: null,
            selectedFeatureIds: [],
            selectedNode: { type: 'folder', folderId: nextId },
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

      return nextId
    },

    updateFeatureFolder: (id, patch) =>
      set((s) => {
        const nextProject = {
          ...s.project,
          featureFolders: s.project.featureFolders.map((folder) => (
            folder.id === id ? { ...folder, ...patch } : folder
          )),
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

    deleteFeatureFolder: (id) =>
      set((s) => {
        const folderFeatures = s.project.features.filter((feature) => feature.folderId === id)
        const nextFeatureTree = s.project.featureTree.flatMap((entry) => (
          entry.type === 'folder' && entry.folderId === id
            ? folderFeatures.map((feature) => ({ type: 'feature', featureId: feature.id } as FeatureTreeEntry))
            : [entry]
        ))
        const nextProject = syncFeatureTreeProject({
          ...s.project,
          featureFolders: s.project.featureFolders.filter((folder) => folder.id !== id),
          featureTree: nextFeatureTree,
          features: s.project.features.map((feature) => (
            feature.folderId === id ? { ...feature, folderId: null } : feature
          )),
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        })
        return {
          project: nextProject,
          selection: {
            ...s.selection,
            selectedNode: s.selection.selectedNode?.type === 'folder' && s.selection.selectedNode.folderId === id
              ? { type: 'features_root' }
              : s.selection.selectedNode,
            selectedFeatureId: s.selection.selectedFeatureId,
            selectedFeatureIds: s.selection.selectedFeatureIds,
            mode: 'feature',
            activeControl: null,
          },
          history: {
            past: [...s.history.past, cloneProject(s.project)].slice(-100),
            future: [],
            transactionStart: null,
          },
        }
      }),

    assignFeaturesToFolder: (featureIds, folderId) =>
      set((s) => {
        const ids = featureIds.filter((id, index) => featureIds.indexOf(id) === index)
        if (ids.length === 0) {
          return {}
        }
        // P2-1: skip features that are in a grouped folder and would be moved to a different folder.
        // Reorder within the same folder (folderId === feature.folderId) stays allowed. Root features
        // (folderId === null) are never in a grouped folder so they always pass.
        const movableIds = ids.filter((id) => {
          const feature = s.project.features.find((f) => f.id === id)
          if (!feature) return false
          if (feature.folderId === null || feature.folderId === folderId) return true
          const currentFolder = s.project.featureFolders.find((f) => f.id === feature.folderId)
          return !currentFolder?.grouped
        })
        if (movableIds.length === 0) {
          return {}
        }
        // A feature may only live in a folder of its own tree section — a
        // section-mismatched assignment falls back to that section's root.
        const resolvedFolderIds = resolveFolderAssignments(s.project, movableIds, folderId)
        const rootAssignedIds = movableIds.filter((id) => (resolvedFolderIds.get(id) ?? null) === null)
        const nextProject = syncFeatureTreeProject({
          ...s.project,
          features: s.project.features.map((feature) => (
            movableIds.includes(feature.id) ? { ...feature, folderId: resolvedFolderIds.get(feature.id) ?? null } : feature
          )),
          featureTree: [
            ...s.project.featureTree.filter((entry) => !(entry.type === 'feature' && movableIds.includes(entry.featureId))),
            ...rootAssignedIds.map((featureId) => ({ type: 'feature', featureId } as FeatureTreeEntry)),
          ],
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        })
        return {
          project: nextProject,
          history: {
            past: [...s.history.past, cloneProject(s.project)].slice(-100),
            future: [],
            transactionStart: null,
          },
        }
      }),

    moveFeatureTreeFeature: (featureId, folderId, beforeFeatureId = null) =>
      set((s) => {
        const sourceFeature = s.project.features.find((feature) => feature.id === featureId)
        if (!sourceFeature) {
          return {}
        }
        if (folderId !== null && !s.project.featureFolders.some((folder) => folder.id === folderId)) {
          return {}
        }
        // Features can only live in folders of their own tree section
        // (features / regions / construction) — reject cross-section moves.
        if (folderId !== null) {
          const targetFolder = s.project.featureFolders.find((folder) => folder.id === folderId)
          if ((targetFolder?.section ?? 'features') !== sectionForOperation(sourceFeature.operation)) {
            return {}
          }
        }

        // P2-1: features in a grouped folder cannot be moved to a different folder or root.
        // Reordering within the same grouped folder (folderId === sourceFeature.folderId) stays allowed.
        const currentFolder = sourceFeature.folderId
          ? s.project.featureFolders.find((f) => f.id === sourceFeature.folderId)
          : null
        if (currentFolder?.grouped && folderId !== sourceFeature.folderId) {
          return {}
        }

        const remainingFeatures = s.project.features.filter((feature) => feature.id !== featureId)
        const nextSourceFeature = { ...sourceFeature, folderId }
        let insertIndex = remainingFeatures.length

        if (beforeFeatureId) {
          const beforeIndex = remainingFeatures.findIndex((feature) => feature.id === beforeFeatureId)
          const beforeFeature = remainingFeatures.find((feature) => feature.id === beforeFeatureId)
          if (beforeIndex !== -1 && beforeFeature && beforeFeature.folderId === folderId) {
            insertIndex = beforeIndex
          }
        } else if (folderId !== null) {
          const folderIndexes = remainingFeatures
            .map((feature, index) => (feature.folderId === folderId ? index : -1))
            .filter((index) => index !== -1)
          if (folderIndexes.length > 0) {
            insertIndex = folderIndexes[folderIndexes.length - 1] + 1
          }
        }

        const nextFeatures = [...remainingFeatures]
        nextFeatures.splice(insertIndex, 0, nextSourceFeature)

        const rootEntries = s.project.featureTree.filter((entry) => (
          entry.type === 'folder' ||
          (entry.type === 'feature' && entry.featureId !== featureId)
        ))

        let nextFeatureTree = rootEntries
        if (folderId === null) {
          const nextEntry: FeatureTreeEntry = { type: 'feature', featureId }
          if (beforeFeatureId) {
            const targetRootIndex = rootEntries.findIndex((entry) => entry.type === 'feature' && entry.featureId === beforeFeatureId)
            if (targetRootIndex !== -1) {
              nextFeatureTree = [...rootEntries]
              nextFeatureTree.splice(targetRootIndex, 0, nextEntry)
            } else {
              nextFeatureTree = [...rootEntries, nextEntry]
            }
          } else {
            nextFeatureTree = [...rootEntries, nextEntry]
          }
        }

        const nextProject = syncFeatureTreeProject({
          ...s.project,
          features: nextFeatures,
          featureTree: nextFeatureTree,
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        })

        return {
          project: nextProject,
          history: {
            past: [...s.history.past, cloneProject(s.project)].slice(-100),
            future: [],
            transactionStart: null,
          },
        }
      }),

    reorderFeatureTreeEntries: (entries) =>
      set((s) => {
        const nextProject = syncFeatureTreeProject({
          ...s.project,
          featureTree: entries,
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        })
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

    groupSelectedFeaturesIntoNewFolder: () => {
      const state = get()
      const selectedIds = state.selection.selectedFeatureIds
      if (selectedIds.length < 2) {
        return ''
      }
      // Groups are single-section: machining features, regions, and
      // construction geometry each only group with their own kind (issue
      // #199). A mixed-section selection is a no-op.
      const section = commonSectionOfIds(state.project, selectedIds)
      if (section === null) {
        return ''
      }
      const nextId = nextUniqueGeneratedId(state.project, 'fd')
      const existingSectionFolders = state.project.featureFolders.filter(
        (folder) => (folder.section ?? 'features') === section,
      )
      const folder: FeatureFolder = {
        id: nextId,
        name: `Group ${existingSectionFolders.length + 1}`,
        collapsed: false,
        section,
        grouped: true,
      }

      set((s) => {
        const idSet = new Set(selectedIds)
        const nextProject = syncFeatureTreeProject({
          ...s.project,
          featureFolders: [...s.project.featureFolders, folder],
          features: s.project.features.map((feature) => (
            idSet.has(feature.id) ? { ...feature, folderId: nextId } : feature
          )),
          featureTree: [
            ...s.project.featureTree.filter((entry) => !(entry.type === 'feature' && idSet.has(entry.featureId))),
            { type: 'folder' as const, folderId: nextId },
          ],
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        })
        return {
          project: nextProject,
          pendingShapeAction: null,
          selection: {
            ...s.selection,
            selectedFeatureId: selectedIds[selectedIds.length - 1],
            selectedFeatureIds: [...selectedIds],
            selectedNode: { type: 'folder', folderId: nextId },
            mode: 'feature',
            activeControl: null,
            groupFolderId: nextId,
          },
          history: {
            past: [...s.history.past, cloneProject(s.project)].slice(-100),
            future: [],
            transactionStart: null,
          },
        }
      })

      return nextId
    },

    setAllFeaturesVisible: (visible) =>
      set((s) => {
        const nextProject = {
          ...s.project,
          features: s.project.features.map((feature) => (
            isMachinable(feature) ? { ...feature, visible } : feature
          )),
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

    // ── Feature CRUD ─────────────────────────────────────────

    addFeature: (feature) =>
      set((s) => {
        const { _clonedDefinition: clonedDefinition, ...featureForInsert } =
          feature as SketchFeature & { _clonedDefinition?: FeatureDefinition }
        const safeId = s.project.features.some((existing) => existing.id === featureForInsert.id)
          ? nextUniqueGeneratedId(s.project, 'f')
          : featureForInsert.id
        const isFirstMachiningFeature = isMachinable(featureForInsert)
          && !s.project.features.some(isMachinable)
        const preserveImportedModelOperation = isFirstMachiningFeature && isImportedModelFeature(featureForInsert)
        const selectedNode = s.selection.selectedNode
        let effectiveFolderId: string | null = featureForInsert.folderId ?? null
        let insertAfterFeatureId: string | null = null
        if (selectedNode?.type === 'folder') {
          effectiveFolderId = selectedNode.folderId
        } else if (selectedNode?.type === 'feature') {
          const selectedFeature = s.project.features.find((f) => f.id === selectedNode.featureId)
          effectiveFolderId = selectedFeature?.folderId ?? null
          insertAfterFeatureId = selectedNode.featureId
        }
        const effectiveFolder = effectiveFolderId
          ? s.project.featureFolders.find((folder) => folder.id === effectiveFolderId) ?? null
          : null
        const effectiveFolderSection = effectiveFolder?.section ?? 'features'
        if (effectiveFolderSection !== sectionForOperation(featureForInsert.operation)) {
          effectiveFolderId = null
        }
        const safeFeatureBase: SketchFeature = isFirstMachiningFeature && !preserveImportedModelOperation
          ? normalizeFeatureZRange({ ...featureForInsert, id: safeId, folderId: effectiveFolderId, operation: 'add' })
          : normalizeFeatureZRange({ ...featureForInsert, id: safeId, folderId: effectiveFolderId })
        const nextModelAssets = { ...s.project.modelAssets }
        let safeFeature: SketchFeature = {
          ...safeFeatureBase,
          stl: normalizeImportedModelStorage(safeFeatureBase.id, safeFeatureBase.stl, nextModelAssets),
        }

        // Mint a FeatureDefinition for features that don't already have one
        // (idempotent — snapshot results and migrated features already carry
        // an explicit definitionId and are left untouched).
        const featureHasExplicitDefId =
          (featureForInsert as SketchFeature & { definitionId?: string }).definitionId !== undefined
        let nextDefinitions = { ...s.project.featureDefinitions }

        if (!featureHasExplicitDefId) {
          const minted = createDefinitionForFeature(s.project, safeFeature)
          safeFeature = {
            ...safeFeature,
            definitionId: minted.definitionId,
            transform: IDENTITY_MATRIX,
          } as SketchFeature & { definitionId?: string; transform?: Matrix2D }
          nextDefinitions = { ...nextDefinitions, [minted.definitionId]: minted.definition }
        } else if (clonedDefinition) {
          nextDefinitions = { ...nextDefinitions, [clonedDefinition.id]: clonedDefinition }
        }

        let nextFeatures: SketchFeature[]
        let nextTree: FeatureTreeEntry[]
        if (insertAfterFeatureId !== null) {
          const idx = s.project.features.findIndex((f) => f.id === insertAfterFeatureId)
          nextFeatures = idx >= 0
            ? [...s.project.features.slice(0, idx + 1), safeFeature, ...s.project.features.slice(idx + 1)]
            : [...s.project.features, safeFeature]
          if (effectiveFolderId === null) {
            const treeIdx = s.project.featureTree.findIndex(
              (e) => e.type === 'feature' && e.featureId === insertAfterFeatureId
            )
            nextTree = treeIdx >= 0
              ? [...s.project.featureTree.slice(0, treeIdx + 1), { type: 'feature', featureId: safeFeature.id }, ...s.project.featureTree.slice(treeIdx + 1)]
              : [...s.project.featureTree, { type: 'feature', featureId: safeFeature.id }]
          } else {
            nextTree = [...s.project.featureTree, { type: 'feature', featureId: safeFeature.id }]
          }
        } else {
          nextFeatures = [...s.project.features, safeFeature]
          nextTree = [...s.project.featureTree, { type: 'feature', featureId: safeFeature.id }]
        }
        const nextProject = syncFeatureTreeProject({
          ...s.project,
          modelAssets: nextModelAssets,
          features: nextFeatures,
          featureTree: nextTree,
          featureDefinitions: nextDefinitions,
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        })
        const result = {
          project: nextProject,
          selection: {
            ...s.selection,
            selectedFeatureId: safeFeature.id,
            selectedFeatureIds: [safeFeature.id],
            selectedNode: { type: 'feature' as const, featureId: safeFeature.id },
            mode: 'feature' as const,
            activeControl: null,
          },
        }

        if (s.history.transactionStart) {
          return result
        }

        return {
          ...result,
          history: {
            past: [...s.history.past, cloneProject(s.project)].slice(-100),
            future: [],
            transactionStart: null,
          },
        }
      }),

    updateFeature: (id, patch) =>
      set((s) => {
        const features = s.project.features
        const isFirst = features.length > 0 && features[0].id === id
        const existingFeature = features.find((feature) => feature.id === id) ?? null
        const nextOperation = patch.operation ?? existingFeature?.operation
        const nextKind = patch.kind ?? existingFeature?.kind
        const nextIsImportedModel = nextKind === 'stl' && nextOperation === 'model'
        const zSafePatch = nextOperation === 'region' || nextOperation === 'construction'
          ? Object.fromEntries(Object.entries(patch).filter(([key]) => key !== 'z_top' && key !== 'z_bottom')) as Partial<SketchFeature>
          : patch
        // The first-row "must be add" guard only applies when the row stays
        // machinable — converting it to construction takes it out of the model.
        const safePatch: Partial<SketchFeature> =
          isFirst && !nextIsImportedModel && zSafePatch.operation !== undefined && zSafePatch.operation !== 'add' && zSafePatch.operation !== 'construction'
            ? { ...zSafePatch, operation: 'add' }
            : zSafePatch
        const safeOperation = safePatch.operation ?? existingFeature?.operation

        // P1b: when operation changes on a linked instance, propagate to the
        // definition and all siblings so the raw rows agree with the
        // definition-owned operation (resolveFeatures.ts:436).
        const defId = (existingFeature as SketchFeature & { definitionId?: string })?.definitionId
        const opExplicitlyChanged =
          safePatch.operation !== undefined && safePatch.operation !== existingFeature?.operation
        const shouldPropagateOp = opExplicitlyChanged && defId !== undefined

        // P1b-text: when a text feature's `text` changes, propagate it to the
        // shared definition and every linked instance. Text geometry is
        // rendered from the raw per-instance `feature.text`, so without this a
        // linked copy edited in isolation would diverge from its siblings
        // (issue #228). The frame profile is left unchanged. `getDefinitionId`
        // also covers migrated text features that resolve via the feature-id
        // fallback rather than an explicit `definitionId`.
        const textDefId = existingFeature ? getDefinitionId(existingFeature) : undefined
        const shouldPropagateText =
          safePatch.text !== undefined &&
          existingFeature?.kind === 'text' &&
          textDefId !== undefined &&
          s.project.featureDefinitions[textDefId] !== undefined

        let nextDefinitions: Record<string, FeatureDefinition> = s.project.featureDefinitions
        if (shouldPropagateOp) {
          nextDefinitions = {
            ...nextDefinitions,
            [defId!]: {
              ...nextDefinitions[defId!],
              operation: safeOperation as FeatureOperation,
            },
          }
        }
        if (shouldPropagateText) {
          nextDefinitions = {
            ...nextDefinitions,
            [textDefId!]: {
              ...nextDefinitions[textDefId!],
              text: safePatch.text ? { ...safePatch.text } : null,
            },
          }
        }

        const linkedSiblingIds: Set<string> | null = shouldPropagateOp
          ? new Set(getInstanceIdsForDefinition(s.project, defId!))
          : null
        const textSiblingIds: Set<string> | null = shouldPropagateText
          ? new Set(getInstanceIdsForDefinition(s.project, textDefId!))
          : null

        let nextProject: Project = {
          ...s.project,
          featureDefinitions: nextDefinitions,
          features: features.map((f, fi) => {
            const isEdited = f.id === id

            if (isEdited) {
              return normalizeFeatureZRange({
                ...f,
                ...safePatch,
                folderId: folderIdForOperation(s.project, safePatch.folderId ?? f.folderId, safeOperation),
              })
            }

            const isOpSibling =
              shouldPropagateOp && linkedSiblingIds !== null && linkedSiblingIds.has(f.id)
            const isTextSibling =
              shouldPropagateText && textSiblingIds !== null && textSiblingIds.has(f.id)

            if (!isOpSibling && !isTextSibling) {
              return f
            }

            let sibling = f
            if (isOpSibling) {
              // Apply the same operation to the sibling, with its own isFirst
              // guard (first feature in the tree can't be subtract).
              const siblingIsFirst = fi === 0
              const op = safeOperation as FeatureOperation
              const siblingOp =
                siblingIsFirst && op !== 'add' && op !== 'construction' ? ('add' as const) : op
              sibling = normalizeFeatureZRange({
                ...sibling,
                operation: siblingOp,
                folderId: folderIdForOperation(s.project, sibling.folderId, siblingOp),
              })
            }
            if (isTextSibling) {
              sibling = {
                ...sibling,
                text: safePatch.text ? { ...safePatch.text } : null,
              }
            }
            return sibling
          }),
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        }
        nextProject = syncStockFromSourceFeature(nextProject, id)
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

    updateFeatures: (ids, patch) =>
      set((s) => {
        if (ids.length === 0) {
          return {}
        }

        const selectedIds = new Set(ids)
        const features = s.project.features
        const nextProject = {
          ...s.project,
          features: features.map((feature, index) => {
            if (!selectedIds.has(feature.id)) {
              return feature
            }

            const nextOperation = patch.operation ?? feature.operation
            const nextKind = patch.kind ?? feature.kind
            const nextIsImportedModel = nextKind === 'stl' && nextOperation === 'model'
            const zSafePatch = nextOperation === 'region' || nextOperation === 'construction'
              ? Object.fromEntries(Object.entries(patch).filter(([key]) => key !== 'z_top' && key !== 'z_bottom')) as Partial<SketchFeature>
              : patch
            const safePatch: Partial<SketchFeature> =
              index === 0 && !nextIsImportedModel && zSafePatch.operation !== undefined && zSafePatch.operation !== 'add' && zSafePatch.operation !== 'construction'
                ? { ...zSafePatch, operation: 'add' }
                : zSafePatch
            const safeOperation = safePatch.operation ?? feature.operation

            return normalizeFeatureZRange({
              ...feature,
              ...safePatch,
              folderId: folderIdForOperation(s.project, safePatch.folderId ?? feature.folderId, safeOperation),
            })
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

    deleteFeature: (id) =>
      get().deleteFeatures([id]),

    deleteFeatures: (ids) =>
      set((s) => {
        const idsToDelete = new Set(ids)
        const featuresWithInvalidatedConstraints = s.project.features
          .filter((feature) => !idsToDelete.has(feature.id))
          .map((feature) => {
            const updatedConstraints = feature.sketch.constraints.map((c) => {
              if (c.type !== 'fixed_distance') return c
              const refId = c.reference_feature_id ?? c.segment_ids[0]
              if (refId && idsToDelete.has(refId)) {
                return { ...c, is_invalid: true, error_message: 'Reference feature was deleted' }
              }
              return c
            })
            if (updatedConstraints.some((c, i) => c !== feature.sketch.constraints[i])) {
              return { ...feature, sketch: { ...feature.sketch, constraints: updatedConstraints } }
            }
            return feature
          })

        let stock = s.project.stock
        if (stock.sourceFeatureId && idsToDelete.has(stock.sourceFeatureId)) {
          const stockBounds = getStockBounds(stock)
          const width = Math.max(stockBounds.maxX - stockBounds.minX, 1)
          const height = Math.max(stockBounds.maxY - stockBounds.minY, 1)
          stock = {
            ...stock,
            profile: rectProfile(stockBounds.minX, stockBounds.minY, width, height),
            sourceFeatureId: null as string | null | undefined,
            sourceFeature: null as SketchFeature | null | undefined,
          }
        }

        const nextProject = pruneUnusedModelAssets(syncFeatureTreeProject({
          ...s.project,
          stock,
          features: featuresWithInvalidatedConstraints,
          featureDefinitions: gcOrphanedDefinitions(
            featuresWithInvalidatedConstraints,
            s.project.featureDefinitions,
          ).definitions,
          featureTree: s.project.featureTree.filter((entry) => !(entry.type === 'feature' && idsToDelete.has(entry.featureId))),
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        }))
        if (projectsEqual(nextProject, s.project)) {
          return {}
        }
        const remainingSelectedIds = s.selection.selectedFeatureIds.filter((featureId) => !idsToDelete.has(featureId))
        const nextPrimaryId =
          s.selection.selectedFeatureId && !idsToDelete.has(s.selection.selectedFeatureId)
            ? s.selection.selectedFeatureId
            : remainingSelectedIds.at(-1) ?? null
        return {
          project: nextProject,
          selection: {
            ...s.selection,
            selectedFeatureId: nextPrimaryId,
            selectedFeatureIds: remainingSelectedIds,
            selectedNode: nextPrimaryId ? { type: 'feature', featureId: nextPrimaryId } : null,
            mode: nextPrimaryId && remainingSelectedIds.length === 1 ? s.selection.mode : 'feature',
            activeControl: nextPrimaryId && remainingSelectedIds.length === 1 ? s.selection.activeControl : null,
          },
          history: {
            past: [...s.history.past, cloneProject(s.project)].slice(-100),
            future: [],
            transactionStart: null,
          },
        }
      }),

    // ── Boolean / derived ────────────────────────────────────

    mergeSelectedFeatures: (keepOriginals = false) => {
      const state = get()
      const selectedFeatures = resolveFeatureInstances(state.project, state.selection.selectedFeatureIds)
        .map((feature) => feature as unknown as SketchFeature)
        .filter((feature) => feature.sketch.profile.closed)

      if (selectedFeatures.length < 2) {
        return []
      }

      const anchorFeature = selectedFeatures[0]
      const baseFeature = anchorFeature
      const joinNameStem = normalizeDerivedFeatureNameStem(baseFeature.name)
      const segAnnotations = buildSegmentAnnotations(selectedFeatures)
      const unionPaths = unionClipperPaths(selectedFeatures.map((feature) => flattenFeatureToClipperPath(feature)))
      const createdResults = unionPaths
        .map((path, index) => {
          const profile = clipperContourToProfilePreserving(path, selectedFeatures, segAnnotations)
            ?? clipperContourToProfile(path)
          if (!profile) {
            return null
          }
          const nextProject = { ...state.project, features: [...state.project.features] }
          return createDerivedFeature(
            nextProject,
            baseFeature,
            profile,
            baseFeature.operation,
            uniqueName(index === 0 ? `${joinNameStem} Join` : `${joinNameStem} Join ${index + 1}`, [
              ...state.project.features.map((feature) => feature.name),
            ]),
          )
        })
        .filter((result): result is NonNullable<typeof result> => result !== null)
      const createdFeatures = createdResults.map((result) => result.feature)
      const newDefinitions = createdResults.map((result) => result.definition)

      if (createdFeatures.length === 0) {
        return []
      }

      set((s) => {
        const idsToReplace = new Set(keepOriginals ? [] : selectedFeatures.map((feature) => feature.id))
        const createdGroups: DerivedFeatureGroup[] = [{ sourceId: anchorFeature.id, features: createdFeatures }]
        const nextFeatures = insertDerivedFeaturesAfterSources(s.project.features, createdGroups, idsToReplace)
        const nextFeatureTree = insertDerivedFeatureTreeEntries(s.project.featureTree, s.project.features, createdGroups, idsToReplace)
        const nextDefinitions = { ...s.project.featureDefinitions }
        for (const definition of newDefinitions) {
          nextDefinitions[definition.id] = definition
        }
        const finalDefinitions = keepOriginals
          ? nextDefinitions
          : gcOrphanedDefinitions(nextFeatures, nextDefinitions).definitions
        const nextProject = syncFeatureTreeProject({
          ...s.project,
          features: nextFeatures,
          featureTree: nextFeatureTree,
          featureDefinitions: finalDefinitions,
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        })
        const createdIds = createdFeatures.map((feature) => feature.id)
        const primaryId = createdIds.at(-1) ?? null
        return {
          project: nextProject,
          selection: {
            ...s.selection,
            selectedFeatureId: primaryId,
            selectedFeatureIds: createdIds,
            selectedNode: primaryId ? { type: 'feature', featureId: primaryId } : null,
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

      return createdFeatures.map((feature) => feature.id)
    },

    cutSelectedFeatures: (keepOriginals = false) => {
      const state = get()
      const selectedFeatures = resolveFeatureInstances(state.project, state.selection.selectedFeatureIds)
        .map((feature) => feature as unknown as SketchFeature)

      if (selectedFeatures.length < 2) {
        return []
      }

      const cutter = selectedFeatures[selectedFeatures.length - 1]
      const targets = selectedFeatures.filter((feature) => {
        if (feature.id === cutter.id) return false
        if (feature.sketch.profile.closed) return true
        return cutter.sketch.profile.closed
      })
      const cutResult = cutFeaturesByCutterGrouped(state.project, [cutter], targets, createDerivedFeature)
      const createdGroups = cutResult.groups
      const createdFeatures = createdGroups.flatMap((group) => group.features)

      if (createdFeatures.length === 0) {
        return []
      }

      set((s) => {
        const idsToReplace = new Set(keepOriginals ? [] : targets.map((feature) => feature.id))
        const nextFeatures = insertDerivedFeaturesAfterSources(s.project.features, createdGroups, idsToReplace)
        const nextFeatureTree = insertDerivedFeatureTreeEntries(s.project.featureTree, s.project.features, createdGroups, idsToReplace)
        const nextDefinitions = { ...s.project.featureDefinitions }
        for (const definition of cutResult.definitions) {
          nextDefinitions[definition.id] = definition
        }
        const finalDefinitions = keepOriginals
          ? nextDefinitions
          : gcOrphanedDefinitions(nextFeatures, nextDefinitions).definitions
        const nextProject = syncFeatureTreeProject({
          ...s.project,
          features: nextFeatures,
          featureTree: nextFeatureTree,
          featureDefinitions: finalDefinitions,
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        })
        const createdIds = createdFeatures.map((feature) => feature.id)
        const primaryId = createdIds.at(-1) ?? null
        return {
          project: nextProject,
          selection: {
            ...s.selection,
            selectedFeatureId: primaryId,
            selectedFeatureIds: createdIds,
            selectedNode: primaryId ? { type: 'feature', featureId: primaryId } : null,
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

      return createdFeatures.map((feature) => feature.id)
    },

    offsetSelectedFeatures: (distance) => {
      const state = get()
      const offsetResult = previewOffsetFeatures(state.project, state.selection.selectedFeatureIds, distance)
      const createdFeatures = offsetResult.features

      if (createdFeatures.length === 0) {
        return []
      }

      set((s) => {
        const nextDefinitions = { ...s.project.featureDefinitions }
        for (const definition of offsetResult.definitions) {
          nextDefinitions[definition.id] = definition
        }
        const nextProject = syncFeatureTreeProject({
          ...s.project,
          features: [...s.project.features, ...createdFeatures],
          featureDefinitions: nextDefinitions,
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        })
        const createdIds = createdFeatures.map((feature) => feature.id)
        const primaryId = createdIds.at(-1) ?? null
        return {
          project: nextProject,
          selection: {
            ...s.selection,
            selectedFeatureId: primaryId,
            selectedFeatureIds: createdIds,
            selectedNode: primaryId ? { type: 'feature', featureId: primaryId } : null,
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

      return createdFeatures.map((feature) => feature.id)
    },

    // ── Reorder ──────────────────────────────────────────────

    reorderFeatures: (ids) =>
      set((s) => {
        const map = new Map(s.project.features.map((f) => [f.id, f]))
        const reordered = ids.map((id) => map.get(id)!).filter(Boolean)
        const firstMachiningIndex = reordered.findIndex(isMachinable)
        if (
          firstMachiningIndex !== -1
          && reordered[firstMachiningIndex].operation !== 'add'
          && !isImportedModelFeature(reordered[firstMachiningIndex])
        ) {
          reordered[firstMachiningIndex] = { ...reordered[firstMachiningIndex], operation: 'add' }
        }
        return {
          project: syncFeatureTreeProject({
            ...s.project,
            features: reordered,
            meta: { ...s.project.meta, modified: new Date().toISOString() },
          }),
          history: {
            past: [...s.history.past, cloneProject(s.project)].slice(-100),
            future: [],
            transactionStart: null,
          },
        }
      }),

    // ── Arrange ──────────────────────────────────────────────

    alignFeatures: (ids, alignment) =>
      set((s) => {
        const idSet = new Set(ids)
        const movedOffsets = new Map<string, FeatureOffset>()
        const eligibleFeatures = s.project.features.filter((feature) => idSet.has(feature.id) && !feature.locked)
        if (eligibleFeatures.length < 2) {
          return {}
        }

        const featureBounds = new Map(
          eligibleFeatures.map((feature) => [feature.id, getProfileBounds(feature.sketch.profile)] as const),
        )

        let refMinX = Infinity
        let refMaxX = -Infinity
        let refMinY = Infinity
        let refMaxY = -Infinity
        for (const bounds of featureBounds.values()) {
          if (bounds.minX < refMinX) refMinX = bounds.minX
          if (bounds.maxX > refMaxX) refMaxX = bounds.maxX
          if (bounds.minY < refMinY) refMinY = bounds.minY
          if (bounds.maxY > refMaxY) refMaxY = bounds.maxY
        }
        const refCenterX = (refMinX + refMaxX) / 2
        const refCenterY = (refMinY + refMaxY) / 2

        const nextFeatures = s.project.features.map((feature) => {
          const bounds = featureBounds.get(feature.id)
          if (!bounds) {
            return feature
          }
          let dx = 0
          let dy = 0
          switch (alignment) {
            case 'left':
              dx = refMinX - bounds.minX
              break
            case 'right':
              dx = refMaxX - bounds.maxX
              break
            case 'center_horizontal':
              dx = refCenterX - (bounds.minX + bounds.maxX) / 2
              break
            case 'top':
              dy = refMinY - bounds.minY
              break
            case 'bottom':
              dy = refMaxY - bounds.maxY
              break
            case 'center_vertical':
              dy = refCenterY - (bounds.minY + bounds.maxY) / 2
              break
          }
          if (dx === 0 && dy === 0) {
            return feature
          }
          movedOffsets.set(feature.id, { dx, dy })
          const currentTransform = (feature as SketchFeature & { transform?: Matrix2D }).transform ?? IDENTITY_MATRIX
          return {
            ...feature,
            sketch: {
              ...feature.sketch,
              profile: translateProfile(feature.sketch.profile, dx, dy),
            },
            transform: multiplyMatrix(moveDelta(dx, dy), currentTransform),
          } as SketchFeature & { transform: Matrix2D }
        })

        const cleaned = propagateConstraintsOnTranslate(nextFeatures, movedOffsets, { transformProfile })
        const cleanedByIdAlign = new Map(cleaned.map((f) => [f.id, f]))
        const validatedAlign = cleaned.map((f) => {
          if (f.sketch.constraints.every((c) => c.type !== 'fixed_distance')) return f
          return validateConstraintsOnFeature(f, cleanedByIdAlign)
        })
        const nextProject = {
          ...s.project,
          features: validatedAlign,
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

    distributeFeatures: (ids, distribution) =>
      set((s) => {
        const idSet = new Set(ids)
        const movedOffsetsDist = new Map<string, FeatureOffset>()
        const eligibleFeatures = s.project.features.filter((feature) => idSet.has(feature.id) && !feature.locked)
        if (eligibleFeatures.length < 3) {
          return {}
        }

        const axis: 'x' | 'y' =
          distribution === 'horizontal_gaps' || distribution === 'horizontal_centers' ? 'x' : 'y'
        const mode: 'gaps' | 'centers' =
          distribution === 'horizontal_gaps' || distribution === 'vertical_gaps' ? 'gaps' : 'centers'

        const entries = eligibleFeatures.map((feature) => {
          const bounds = getProfileBounds(feature.sketch.profile)
          const min = axis === 'x' ? bounds.minX : bounds.minY
          const max = axis === 'x' ? bounds.maxX : bounds.maxY
          return { feature, bounds, min, max, center: (min + max) / 2, size: max - min }
        })

        entries.sort((a, b) => (mode === 'centers' ? a.center - b.center : a.min - b.min))

        const offsets = new Map<string, number>()
        if (mode === 'centers') {
          const firstCenter = entries[0].center
          const lastCenter = entries[entries.length - 1].center
          const step = (lastCenter - firstCenter) / (entries.length - 1)
          entries.forEach((entry, index) => {
            if (index === 0 || index === entries.length - 1) {
              return
            }
            const targetCenter = firstCenter + step * index
            const delta = targetCenter - entry.center
            if (delta !== 0) {
              offsets.set(entry.feature.id, delta)
            }
          })
        } else {
          const spanStart = entries[0].min
          const spanEnd = entries[entries.length - 1].max
          const totalSize = entries.reduce((sum, entry) => sum + entry.size, 0)
          const gap = (spanEnd - spanStart - totalSize) / (entries.length - 1)
          let cursor = entries[0].max
          for (let index = 1; index < entries.length - 1; index++) {
            const entry = entries[index]
            const targetMin = cursor + gap
            const delta = targetMin - entry.min
            if (delta !== 0) {
              offsets.set(entry.feature.id, delta)
            }
            cursor = targetMin + entry.size
          }
        }

        if (offsets.size === 0) {
          return {}
        }

        const nextFeatures = s.project.features.map((feature) => {
          const delta = offsets.get(feature.id)
          if (delta === undefined) {
            return feature
          }
          const dx = axis === 'x' ? delta : 0
          const dy = axis === 'y' ? delta : 0
          movedOffsetsDist.set(feature.id, { dx, dy })
          const currentTransform = (feature as SketchFeature & { transform?: Matrix2D }).transform ?? IDENTITY_MATRIX
          return {
            ...feature,
            sketch: {
              ...feature.sketch,
              profile: translateProfile(feature.sketch.profile, dx, dy),
            },
            transform: multiplyMatrix(moveDelta(dx, dy), currentTransform),
          } as SketchFeature & { transform: Matrix2D }
        })

        const cleanedDist = propagateConstraintsOnTranslate(nextFeatures, movedOffsetsDist, { transformProfile })
        const cleanedDistById = new Map(cleanedDist.map((f) => [f.id, f]))
        const validatedDist = cleanedDist.map((f) => {
          if (f.sketch.constraints.every((c) => c.type !== 'fixed_distance')) return f
          return validateConstraintsOnFeature(f, cleanedDistById)
        })
        const nextProject = {
          ...s.project,
          features: validatedDist,
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

    // ── Convenience constructors ── delegate to buildShapeFeature ─

    addRectFeature: (name, x, y, w, h, depth) => {
      get().addFeature(buildShapeFeature(get().project, get().creationTarget, 'rect', rectProfile(x, y, w, h), name, depth))
    },

    addCircleFeature: (name, cx, cy, r, depth) => {
      get().addFeature(buildShapeFeature(get().project, get().creationTarget, 'circle', circleProfile(cx, cy, r), name, depth))
    },

    addEllipseFeature: (name, cx, cy, rx, ry, depth) => {
      get().addFeature(buildShapeFeature(get().project, get().creationTarget, 'ellipse', ellipseProfile(cx, cy, rx, ry), name, depth))
    },

    addPolygonFeature: (name, points, depth) => {
      get().addFeature(buildShapeFeature(get().project, get().creationTarget, 'polygon', polygonProfile(points), name, depth))
    },

    addSplineFeature: (name, points, depth) => {
      get().addFeature(buildShapeFeature(get().project, get().creationTarget, 'spline', splineProfile(points), name, depth))
    },

    addSlotFeature: (name, p1, p2, width, depth) => {
      get().addFeature(buildShapeFeature(get().project, get().creationTarget, 'composite', slotProfile(p1, p2, width), name, depth))
    },

    addNgonFeature: (name, cx, cy, sides, circumradius, firstVertexAngle, depth) => {
      get().addFeature(buildShapeFeature(get().project, get().creationTarget, 'polygon', ngonProfile(cx, cy, sides, circumradius, firstVertexAngle), name, depth))
    },

    addRoundRectFeature: (name, x, y, w, h, corner, depth) => {
      get().addFeature(buildShapeFeature(get().project, get().creationTarget, 'composite', roundedRectProfile({ x, y }, { x: x + w, y: y + h }, corner), name, depth))
    },

    addChamferRectFeature: (name, x, y, w, h, corner, depth) => {
      get().addFeature(buildShapeFeature(get().project, get().creationTarget, 'composite', chamferedRectProfile({ x, y }, { x: x + w, y: y + h }, corner), name, depth))
    },

    expandTextFeature: (textFeatureId) => {
      const state = get()
      const textFeature = state.project.features.find((f) => f.id === textFeatureId)

      if (!textFeature || !textFeature.text) {
        return
      }

      const { folders, features, definitions } = expandTextFeature(state.project, textFeature)

      if (features.length === 0) {
        return
      }

      set((s) => {
        // Add new folders
        const nextFeatureFolders = [...s.project.featureFolders, ...folders]

        // Add feature definitions to the project
        const nextFeatureDefinitions = {
          ...s.project.featureDefinitions,
          ...definitions,
        }

        // Find the position of the original text feature in the feature tree
        const textFeatureTreeIndex = s.project.featureTree.findIndex(
          (entry) => entry.type === 'feature' && entry.featureId === textFeatureId,
        )

        // Build new feature tree entries: insert folder entries right after the original text feature
        const newTreeEntries: FeatureTreeEntry[] = folders.map((folder) => ({
          type: 'folder' as const,
          folderId: folder.id,
        }))

        let nextFeatureTree: FeatureTreeEntry[]
        if (textFeatureTreeIndex >= 0) {
          // Always keep the original text feature; insert new folders after it
          nextFeatureTree = [
            ...s.project.featureTree.slice(0, textFeatureTreeIndex + 1),
            ...newTreeEntries,
            ...s.project.featureTree.slice(textFeatureTreeIndex + 1),
          ]
        } else {
          // Feature not in tree (shouldn't happen), just append
          nextFeatureTree = [...s.project.featureTree, ...newTreeEntries]
        }

        // Add new features
        const nextFeatures = [...s.project.features, ...features]

        const nextProject = syncFeatureTreeProject({
          ...s.project,
          featureFolders: nextFeatureFolders,
          featureDefinitions: nextFeatureDefinitions,
          features: nextFeatures,
          featureTree: nextFeatureTree,
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        })

        return {
          project: nextProject,
          selection: {
            ...s.selection,
            selectedFeatureId: null,
            selectedFeatureIds: [],
            selectedNode: null,
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
    },
  }
}
