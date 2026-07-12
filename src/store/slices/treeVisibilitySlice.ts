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
import type { ProjectStore } from '../types'
import { isConstruction } from '../helpers/featureRoles'
import { cloneProject, projectsEqual } from '../helpers/normalize'

export type TreeVisibilitySlice = Pick<
  ProjectStore,
  | 'setAllRegionsVisible'
  | 'setAllConstructionVisible'
  | 'toggleFolderVisible'
  | 'toggleRegionFolderVisible'
  | 'toggleConstructionFolderVisible'
  | 'selectFolderFeatures'
  | 'toggleFolderGrouped'
  | 'revealFeatureFolder'
>

export function createTreeVisibilitySlice(
  set: Parameters<StateCreator<ProjectStore>>[0],
): TreeVisibilitySlice {

  return {
  setAllRegionsVisible: (visible) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        features: s.project.features.map((feature) => (
          feature.operation === 'region' ? { ...feature, visible } : feature
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

  setAllConstructionVisible: (visible) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        features: s.project.features.map((feature) => (
          isConstruction(feature) ? { ...feature, visible } : feature
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

  toggleFolderVisible: (folderId) =>
    set((s) => {
      const folderFeatures = s.project.features.filter((f) => f.folderId === folderId)
      const anyVisible = folderFeatures.some((f) => f.visible)
      const nextVisible = !anyVisible
      const nextProject = {
        ...s.project,
        features: s.project.features.map((f) =>
          f.folderId === folderId ? { ...f, visible: nextVisible } : f
        ),
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

  toggleRegionFolderVisible: (folderId) =>
    set((s) => {
      const folderFeatures = s.project.features.filter((f) => f.folderId === folderId && f.operation === 'region')
      const anyVisible = folderFeatures.some((f) => f.visible)
      const nextVisible = !anyVisible
      const nextProject = {
        ...s.project,
        features: s.project.features.map((f) =>
          f.folderId === folderId && f.operation === 'region' ? { ...f, visible: nextVisible } : f
        ),
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

  toggleConstructionFolderVisible: (folderId) =>
    set((s) => {
      const folderFeatures = s.project.features.filter((f) => f.folderId === folderId && isConstruction(f))
      const anyVisible = folderFeatures.some((f) => f.visible)
      const nextVisible = !anyVisible
      const nextProject = {
        ...s.project,
        features: s.project.features.map((f) =>
          f.folderId === folderId && isConstruction(f) ? { ...f, visible: nextVisible } : f
        ),
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

  selectFolderFeatures: (folderId) =>
    set((s) => {
      const ids = s.project.features
        .filter((f) => f.folderId === folderId)
        .map((f) => f.id)
      if (ids.length === 0) {
        return {}
      }
      const primaryId = ids.at(-1) ?? null
      const folder = s.project.featureFolders.find((f) => f.id === folderId)
      const isGrouped = folder?.grouped ?? false
      return {
        pendingOffset: null,
        pendingShapeAction: null,
        selection: {
          ...s.selection,
          selectedFeatureId: primaryId,
          selectedFeatureIds: ids,
          selectedNode: primaryId ? { type: 'feature', featureId: primaryId } : null,
          mode: 'feature',
          activeControl: null,
          groupFolderId: isGrouped ? folderId : null,
        },
        sketchEditSession: null,
      }
    }),

  toggleFolderGrouped: (folderId) =>
    set((s) => {
      const folder = s.project.featureFolders.find((f) => f.id === folderId)
      if (!folder) {
        return {}
      }
      const nextGrouped = !(folder.grouped ?? false)
      const nextProject = {
        ...s.project,
        featureFolders: s.project.featureFolders.map((f) =>
          f.id === folderId ? { ...f, grouped: nextGrouped } : f
        ),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }
      // Reconcile selection.groupFolderId with the new grouped state.
      let nextGroupFolderId = s.selection.groupFolderId
      if (!nextGrouped && s.selection.groupFolderId === folderId) {
        // Folder is being turned OFF while it was the active group selection.
        nextGroupFolderId = null
      } else if (nextGrouped) {
        // Folder is being turned ON; if every currently selected feature belongs
        // to this folder, set the group highlight.
        const selectedIds = s.selection.selectedFeatureIds
        if (selectedIds.length > 0) {
          const allInFolder = selectedIds.every((id) => {
            const feat = s.project.features.find((f) => f.id === id)
            return feat !== undefined && feat.folderId === folderId
          })
          if (allInFolder) {
            nextGroupFolderId = folderId
          }
        }
      }
      const selectionChanged = nextGroupFolderId !== s.selection.groupFolderId
      const base = {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
      return selectionChanged
        ? { ...base, selection: { ...s.selection, groupFolderId: nextGroupFolderId } }
        : base
    }),

  // Selection-driven reveal (#276): expands a collapsed folder WITHOUT pushing
  // undo history — Cmd+Z after clicking a feature in the sketch must undo a
  // real edit, not this UI-state change.
  revealFeatureFolder: (folderId) =>
    set((s) => {
      const folder = s.project.featureFolders.find((f) => f.id === folderId)
      if (!folder || !folder.collapsed) {
        return {}
      }
      return {
        project: {
          ...s.project,
          featureFolders: s.project.featureFolders.map((f) =>
            f.id === folderId ? { ...f, collapsed: false } : f
          ),
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        },
      }
    }),

  }
}
