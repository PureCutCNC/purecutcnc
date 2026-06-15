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

export interface TreeVisibilitySliceDependencies {
  cloneProject: (project: Project) => Project
  projectsEqual: (a: Project, b: Project) => boolean
}

export type TreeVisibilitySlice = Pick<
  ProjectStore,
  | 'setAllRegionsVisible'
  | 'toggleFolderVisible'
  | 'toggleRegionFolderVisible'
  | 'selectFolderFeatures'
>

export function createTreeVisibilitySlice(
  set: Parameters<StateCreator<ProjectStore>>[0],
  _get: Parameters<StateCreator<ProjectStore>>[1],
  deps: TreeVisibilitySliceDependencies,
): TreeVisibilitySlice {
  const { cloneProject, projectsEqual } = deps

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

  selectFolderFeatures: (folderId) =>
    set((s) => {
      const ids = s.project.features
        .filter((f) => f.folderId === folderId)
        .map((f) => f.id)
      if (ids.length === 0) {
        return {}
      }
      const primaryId = ids.at(-1) ?? null
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
        },
        sketchEditSession: null,
      }
    }),

  }
}
