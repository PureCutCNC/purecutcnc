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
  FeatureFolder,
  FeatureOperation,
  FeatureTreeEntry,
  Project,
  SketchFeature,
  SketchProfile,
} from '../../types/project'
import type { ProjectStore } from '../types'
import { nextUniqueGeneratedId } from '../helpers/ids'
import { normalizeFeatureZRange } from '../helpers/normalize'
import {
  getStockBounds,
  rectProfile,
  circleProfile,
  ellipseProfile,
  polygonProfile,
  splineProfile,
  getProfileBounds,
} from '../../types/project'
import { translateProfile } from '../../components/canvas/previewPrimitives'
import { uniqueName } from '../../import'
import {
  normalizeDerivedFeatureNameStem,
  insertDerivedFeaturesAfterSources,
  insertDerivedFeatureTreeEntries,
  cutFeaturesByCutterGrouped,
  previewOffsetFeatures as previewOffsetFeaturesRaw,
  type DerivedFeatureGroup,
} from '../helpers/derivedFeatures'
import {
  buildSegmentAnnotations,
  clipperContourToProfile,
  clipperContourToProfilePreserving,
} from '../../engine/toolpaths/arcReconstruction'
import { unionClipperPaths, flattenFeatureToClipperPath } from '../helpers/clipping'
import { transformProfile } from '../helpers/transform'
import { isImportedModelFeature, normalizeImportedModelStorage, pruneUnusedModelAssets } from '../helpers/modelAssets'
import { folderIdForOperation } from '../helpers/operationDefaults'
import {
  propagateConstraintsOnTranslate,
  validateConstraintsOnFeature,
  type FeatureOffset,
} from '../../sketch/constraintSolver'

export interface FeatureSliceDependencies {
  cloneProject: (project: Project) => Project
  syncFeatureTreeProject: (project: Project) => Project
  projectsEqual: (a: Project, b: Project) => boolean
  createDerivedFeature: (
    project: Project,
    baseFeature: SketchFeature,
    profile: SketchProfile,
    operation: FeatureOperation,
    name: string,
  ) => SketchFeature
  syncStockFromSourceFeature: (project: Project, featureId: string) => Project
}

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
  | 'addRectFeature'
  | 'addCircleFeature'
  | 'addEllipseFeature'
  | 'addPolygonFeature'
  | 'addSplineFeature'
  | 'alignFeatures'
  | 'distributeFeatures'
  | 'mergeSelectedFeatures'
  | 'cutSelectedFeatures'
  | 'offsetSelectedFeatures'
>

export function createFeatureSlice(
  set: Parameters<StateCreator<ProjectStore>>[0],
  get: Parameters<StateCreator<ProjectStore>>[1],
  deps: FeatureSliceDependencies,
): FeatureSlice {
  const {
    cloneProject,
    syncFeatureTreeProject,
    projectsEqual,
    createDerivedFeature,
    syncStockFromSourceFeature,
  } = deps

  return {
    // ── Feature folders ──────────────────────────────────────

    addFeatureFolder: (section = 'features') => {
      const state = get()
      const nextId = nextUniqueGeneratedId(state.project, 'fd')
      const existingSectionFolders = state.project.featureFolders.filter((folder) => (folder.section ?? 'features') === section)
      const folder: FeatureFolder = {
        id: nextId,
        name: `${section === 'regions' ? 'Region Folder' : 'Folder'} ${existingSectionFolders.length + 1}`,
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
        const nextProject = syncFeatureTreeProject({
          ...s.project,
          features: s.project.features.map((feature) => (
            ids.includes(feature.id) ? { ...feature, folderId } : feature
          )),
          featureTree: [
            ...s.project.featureTree.filter((entry) => !(entry.type === 'feature' && ids.includes(entry.featureId))),
            ...(folderId === null ? ids.map((featureId) => ({ type: 'feature', featureId } as FeatureTreeEntry)) : []),
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

    setAllFeaturesVisible: (visible) =>
      set((s) => {
        const nextProject = {
          ...s.project,
          features: s.project.features.map((feature) => (
            feature.operation === 'region' ? feature : { ...feature, visible }
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
        const safeId = s.project.features.some((existing) => existing.id === feature.id)
          ? nextUniqueGeneratedId(s.project, 'f')
          : feature.id
        const isFirstMachiningFeature = feature.operation !== 'region'
          && !s.project.features.some((existing) => existing.operation !== 'region')
        const preserveImportedModelOperation = isFirstMachiningFeature && isImportedModelFeature(feature)
        const selectedNode = s.selection.selectedNode
        let effectiveFolderId: string | null = feature.folderId ?? null
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
        if (feature.operation === 'region' && effectiveFolderSection !== 'regions') {
          effectiveFolderId = null
        }
        if (feature.operation !== 'region' && effectiveFolderSection === 'regions') {
          effectiveFolderId = null
        }
        const safeFeatureBase: SketchFeature = isFirstMachiningFeature && !preserveImportedModelOperation
          ? normalizeFeatureZRange({ ...feature, id: safeId, folderId: effectiveFolderId, operation: 'add' })
          : normalizeFeatureZRange({ ...feature, id: safeId, folderId: effectiveFolderId })
        const nextModelAssets = { ...s.project.modelAssets }
        const safeFeature: SketchFeature = {
          ...safeFeatureBase,
          stl: normalizeImportedModelStorage(safeFeatureBase.id, safeFeatureBase.stl, nextModelAssets),
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
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        })
        return {
          project: nextProject,
          selection: {
            ...s.selection,
            selectedFeatureId: safeFeature.id,
            selectedFeatureIds: [safeFeature.id],
            selectedNode: { type: 'feature', featureId: safeFeature.id },
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

    updateFeature: (id, patch) =>
      set((s) => {
        const features = s.project.features
        const isFirst = features.length > 0 && features[0].id === id
        const existingFeature = features.find((feature) => feature.id === id) ?? null
        const nextOperation = patch.operation ?? existingFeature?.operation
        const nextKind = patch.kind ?? existingFeature?.kind
        const nextIsImportedModel = nextKind === 'stl' && nextOperation === 'model'
        const zSafePatch = nextOperation === 'region'
          ? Object.fromEntries(Object.entries(patch).filter(([key]) => key !== 'z_top' && key !== 'z_bottom')) as Partial<SketchFeature>
          : patch
        const safePatch: Partial<SketchFeature> =
          isFirst && !nextIsImportedModel && zSafePatch.operation !== undefined && zSafePatch.operation !== 'add'
            ? { ...zSafePatch, operation: 'add' }
            : zSafePatch
        const safeOperation = safePatch.operation ?? existingFeature?.operation
        let nextProject: Project = {
          ...s.project,
          features: features.map((f) =>
            f.id === id
              ? normalizeFeatureZRange({
                ...f,
                ...safePatch,
                folderId: folderIdForOperation(s.project, safePatch.folderId ?? f.folderId, safeOperation),
              })
              : f
          ),
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
            const zSafePatch = nextOperation === 'region'
              ? Object.fromEntries(Object.entries(patch).filter(([key]) => key !== 'z_top' && key !== 'z_bottom')) as Partial<SketchFeature>
              : patch
            const safePatch: Partial<SketchFeature> =
              index === 0 && !nextIsImportedModel && zSafePatch.operation !== undefined && zSafePatch.operation !== 'add'
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
      const selectedIdSet = new Set(state.selection.selectedFeatureIds)
      const selectedFeatures = state.project.features
        .filter((feature) => selectedIdSet.has(feature.id))
        .filter((feature) => feature.sketch.profile.closed)

      if (selectedFeatures.length < 2) {
        return []
      }

      const anchorFeature = selectedFeatures[0]
      const baseFeature = anchorFeature
      const joinNameStem = normalizeDerivedFeatureNameStem(baseFeature.name)
      const segAnnotations = buildSegmentAnnotations(selectedFeatures)
      const unionPaths = unionClipperPaths(selectedFeatures.map((feature) => flattenFeatureToClipperPath(feature)))
      const createdFeatures = unionPaths
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
        .filter((feature): feature is SketchFeature => feature !== null)

      if (createdFeatures.length === 0) {
        return []
      }

      set((s) => {
        const idsToReplace = new Set(keepOriginals ? [] : selectedFeatures.map((feature) => feature.id))
        const createdGroups: DerivedFeatureGroup[] = [{ sourceId: anchorFeature.id, features: createdFeatures }]
        const nextProject = syncFeatureTreeProject({
          ...s.project,
          features: insertDerivedFeaturesAfterSources(s.project.features, createdGroups, idsToReplace),
          featureTree: insertDerivedFeatureTreeEntries(s.project.featureTree, s.project.features, createdGroups, idsToReplace),
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
      const selectedFeatures = state.selection.selectedFeatureIds
        .map((featureId) => state.project.features.find((feature) => feature.id === featureId) ?? null)
        .filter((feature): feature is SketchFeature => feature !== null)

      if (selectedFeatures.length < 2) {
        return []
      }

      const cutter = selectedFeatures[selectedFeatures.length - 1]
      const targets = selectedFeatures.filter((feature) => {
        if (feature.id === cutter.id) return false
        if (feature.sketch.profile.closed) return true
        return cutter.sketch.profile.closed
      })
      const createdGroups = cutFeaturesByCutterGrouped(state.project, [cutter], targets, createDerivedFeature)
      const createdFeatures = createdGroups.flatMap((group) => group.features)

      if (createdFeatures.length === 0) {
        return []
      }

      set((s) => {
        const idsToReplace = new Set(keepOriginals ? [] : targets.map((feature) => feature.id))
        const nextProject = syncFeatureTreeProject({
          ...s.project,
          features: insertDerivedFeaturesAfterSources(s.project.features, createdGroups, idsToReplace),
          featureTree: insertDerivedFeatureTreeEntries(s.project.featureTree, s.project.features, createdGroups, idsToReplace),
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
      const createdFeatures = previewOffsetFeaturesRaw(state.project, state.selection.selectedFeatureIds, distance, createDerivedFeature)

      if (createdFeatures.length === 0) {
        return []
      }

      set((s) => {
        const nextProject = syncFeatureTreeProject({
          ...s.project,
          features: [...s.project.features, ...createdFeatures],
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
        const firstMachiningIndex = reordered.findIndex((feature) => feature.operation !== 'region')
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
          return {
            ...feature,
            sketch: {
              ...feature.sketch,
              profile: translateProfile(feature.sketch.profile, dx, dy),
            },
          }
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
          return {
            ...feature,
            sketch: {
              ...feature.sketch,
              profile: translateProfile(feature.sketch.profile, dx, dy),
            },
          }
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

    // ── Convenience constructors ─────────────────────────────

    addRectFeature: (name, x, y, w, h, depth) => {
      const operation = get().creationTarget === 'region' ? 'region' : 'subtract'
      const baseName = operation === 'region' ? `Region ${get().project.features.filter((feature) => feature.operation === 'region').length + 1}` : name
      const id = nextUniqueGeneratedId(get().project, 'f')
      const feature: SketchFeature = {
        id,
        name: baseName,
        kind: 'rect',
        folderId: null,
        sketch: {
          profile: rectProfile(x, y, w, h),
          origin: { x: 0, y: 0 },
          orientationAngle: 90,
          dimensions: [],
          constraints: [],
        },
        operation,
        z_top: depth,
        z_bottom: 0,
        visible: true,
        locked: false,
      }
      get().addFeature(feature)
    },

    addCircleFeature: (name, cx, cy, r, depth) => {
      const operation = get().creationTarget === 'region' ? 'region' : 'subtract'
      const baseName = operation === 'region' ? `Region ${get().project.features.filter((feature) => feature.operation === 'region').length + 1}` : name
      const id = nextUniqueGeneratedId(get().project, 'f')
      const feature: SketchFeature = {
        id,
        name: baseName,
        kind: 'circle',
        folderId: null,
        sketch: {
          profile: circleProfile(cx, cy, r),
          origin: { x: 0, y: 0 },
          orientationAngle: 90,
          dimensions: [],
          constraints: [],
        },
        operation,
        z_top: depth,
        z_bottom: 0,
        visible: true,
        locked: false,
      }
      get().addFeature(feature)
    },

    addEllipseFeature: (name, cx, cy, rx, ry, depth) => {
      const operation = get().creationTarget === 'region' ? 'region' : 'subtract'
      const baseName = operation === 'region' ? `Region ${get().project.features.filter((feature) => feature.operation === 'region').length + 1}` : name
      const id = nextUniqueGeneratedId(get().project, 'f')
      const feature: SketchFeature = {
        id,
        name: baseName,
        kind: 'ellipse',
        folderId: null,
        sketch: {
          profile: ellipseProfile(cx, cy, rx, ry),
          origin: { x: 0, y: 0 },
          orientationAngle: 90,
          dimensions: [],
          constraints: [],
        },
        operation,
        z_top: depth,
        z_bottom: 0,
        visible: true,
        locked: false,
      }
      get().addFeature(feature)
    },

    addPolygonFeature: (name, points, depth) => {
      const operation = get().creationTarget === 'region' ? 'region' : 'subtract'
      const baseName = operation === 'region' ? `Region ${get().project.features.filter((feature) => feature.operation === 'region').length + 1}` : name
      const id = nextUniqueGeneratedId(get().project, 'f')
      const feature: SketchFeature = {
        id,
        name: baseName,
        kind: 'polygon',
        folderId: null,
        sketch: {
          profile: polygonProfile(points),
          origin: { x: 0, y: 0 },
          orientationAngle: 90,
          dimensions: [],
          constraints: [],
        },
        operation,
        z_top: depth,
        z_bottom: 0,
        visible: true,
        locked: false,
      }
      get().addFeature(feature)
    },

    addSplineFeature: (name, points, depth) => {
      const operation = get().creationTarget === 'region' ? 'region' : 'subtract'
      const baseName = operation === 'region' ? `Region ${get().project.features.filter((feature) => feature.operation === 'region').length + 1}` : name
      const id = nextUniqueGeneratedId(get().project, 'f')
      const feature: SketchFeature = {
        id,
        name: baseName,
        kind: 'spline',
        folderId: null,
        sketch: {
          profile: splineProfile(points),
          origin: { x: 0, y: 0 },
          orientationAngle: 90,
          dimensions: [],
          constraints: [],
        },
        operation,
        z_top: depth,
        z_bottom: 0,
        visible: true,
        locked: false,
      }
      get().addFeature(feature)
    },
  }
}
