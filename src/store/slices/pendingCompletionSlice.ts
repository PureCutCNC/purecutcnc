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
import type { Clamp, Point, Project, SketchFeature, Tab } from '../../types/project'
import {
  cutFeaturesByCutterGrouped,
  insertDerivedFeaturesAfterSources,
  insertDerivedFeatureTreeEntries,
} from '../helpers/derivedFeatures'
import type { DerivedFeatureGroup } from '../helpers/derivedFeatures'
import type { ProjectStore } from '../types'

export interface PendingCompletionSliceDependencies {
  cloneProject: (project: Project) => Project
  projectsEqual: (a: Project, b: Project) => boolean
  clearStaleConstraints: (features: SketchFeature[], movedIds: Set<string>) => SketchFeature[]
  propagateConstraintsOnTranslate: (features: SketchFeature[], movedOffsets: Map<string, { dx: number; dy: number }>) => SketchFeature[]
  translateProfile: (profile: SketchFeature['sketch']['profile'], dx: number, dy: number) => SketchFeature['sketch']['profile']
  translateClamp: (clamp: Clamp, dx: number, dy: number) => Clamp
  translateTab: (tab: Tab, dx: number, dy: number) => Tab
  buildCopiedFeatures: (
    sourceFeatures: SketchFeature[],
    existingFeatures: SketchFeature[],
    dx: number,
    dy: number,
    copyCount: number,
  ) => SketchFeature[]
  buildCopiedClamps: (
    sourceClamps: Clamp[],
    existingClamps: Clamp[],
    project: Project,
    dx: number,
    dy: number,
    copyCount: number,
  ) => Clamp[]
  buildCopiedTabs: (
    sourceTabs: Tab[],
    existingTabs: Tab[],
    project: Project,
    dx: number,
    dy: number,
    copyCount: number,
  ) => Tab[]
  resizeBackdropFromReference: (
    backdrop: NonNullable<Project['backdrop']>,
    referenceStart: Point,
    referenceEnd: Point,
    previewPoint: Point,
  ) => Project['backdrop']
  rotateBackdropFromReference: (
    backdrop: NonNullable<Project['backdrop']>,
    referenceStart: Point,
    referenceEnd: Point,
    previewPoint: Point,
  ) => Project['backdrop']
  resizeFeatureFromReference: (
    feature: SketchFeature,
    referenceStart: Point,
    referenceEnd: Point,
    previewPoint: Point,
  ) => SketchFeature | null
  rotateFeatureFromReference: (
    feature: SketchFeature,
    referenceStart: Point,
    referenceEnd: Point,
    previewPoint: Point,
  ) => SketchFeature | null
  previewOffsetFeatures: (project: Project, featureIds: string[], distance: number) => SketchFeature[]
  syncFeatureTreeProject: (project: Project) => Project
  createDerivedFeature: (
    project: Project,
    baseFeature: SketchFeature,
    profile: SketchFeature['sketch']['profile'],
    operation: SketchFeature['operation'],
    name: string,
  ) => SketchFeature
}

export type PendingCompletionSlice = Pick<
  ProjectStore,
  | 'completePendingMove'
  | 'completePendingTransform'
  | 'completePendingOffset'
  | 'completePendingShapeAction'
>

function featureById(project: Project, id: string): SketchFeature | null {
  return project.features.find((feature) => feature.id === id) ?? null
}

export function createPendingCompletionSlice(
  set: Parameters<StateCreator<ProjectStore>>[0],
  get: Parameters<StateCreator<ProjectStore>>[1],
  deps: PendingCompletionSliceDependencies,
): PendingCompletionSlice {
  return {
    completePendingMove: (toPoint, copyCount = 1) =>
      set((s) => {
        if (!s.pendingMove?.fromPoint) {
          return {}
        }

        const { entityIds, entityType, fromPoint, mode } = s.pendingMove
        const dx = toPoint.x - fromPoint.x
        const dy = toPoint.y - fromPoint.y

        if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) {
          return { pendingMove: null }
        }

        const normalizedCopyCount = Math.max(1, Math.floor(copyCount))
        if (entityType === 'backdrop') {
          if (!s.project.backdrop || mode !== 'move') {
            return { pendingMove: null }
          }

          const nextProject = {
            ...s.project,
            backdrop: {
              ...s.project.backdrop,
              center: {
                x: s.project.backdrop.center.x + dx,
                y: s.project.backdrop.center.y + dy,
              },
            },
            meta: { ...s.project.meta, modified: new Date().toISOString() },
          }

          if (deps.projectsEqual(nextProject, s.project)) {
            return { pendingMove: null }
          }

          return {
            project: nextProject,
            pendingMove: null,
            history: {
              past: [...s.history.past, deps.cloneProject(s.project)].slice(-100),
              future: [],
              transactionStart: null,
            },
          }
        }

        if (entityType === 'feature') {
          const sourceFeatures = entityIds
            .map((featureId) => featureById(s.project, featureId))
            .filter((feature): feature is SketchFeature => feature !== null)
          if (sourceFeatures.length !== entityIds.length) {
            return { pendingMove: null }
          }

          const createdFeatures =
            mode === 'copy'
              ? deps.buildCopiedFeatures(sourceFeatures, s.project.features, dx, dy, normalizedCopyCount)
              : []

          const translatedFeatures =
            mode === 'copy'
              ? [...s.project.features, ...createdFeatures]
              : s.project.features.map((feature) => {
                  if (!entityIds.includes(feature.id) || feature.locked) {
                    return feature
                  }

                  return {
                    ...feature,
                    sketch: {
                      ...feature.sketch,
                      profile: deps.translateProfile(feature.sketch.profile, dx, dy),
                    },
                  }
                })
          const resolvedFeatures =
            mode === 'copy'
              ? deps.clearStaleConstraints(translatedFeatures, new Set(createdFeatures.map((f) => f.id)))
              : deps.propagateConstraintsOnTranslate(
                  translatedFeatures,
                  new Map(entityIds.filter((id) => !s.project.features.find((f) => f.id === id)?.locked).map((id) => [id, { dx, dy }])),
                )
          const nextProject = {
            ...s.project,
            features: resolvedFeatures,
            featureTree:
              mode === 'copy'
                ? [
                    ...s.project.featureTree,
                    ...createdFeatures.map((feature) => ({ type: 'feature' as const, featureId: feature.id })),
                  ]
                : s.project.featureTree,
            meta: { ...s.project.meta, modified: new Date().toISOString() },
          }

          if (deps.projectsEqual(nextProject, s.project)) {
            return { pendingMove: null }
          }

          return {
            project: nextProject,
            pendingMove: null,
            selection:
              mode === 'copy'
                ? {
                    ...s.selection,
                    selectedFeatureId: createdFeatures.at(-1)?.id ?? s.selection.selectedFeatureId,
                    selectedFeatureIds: createdFeatures.map((feature) => feature.id),
                    selectedNode: createdFeatures.at(-1)
                      ? { type: 'feature', featureId: createdFeatures.at(-1)!.id }
                      : s.selection.selectedNode,
                  }
                : s.selection,
            history: {
              past: [...s.history.past, deps.cloneProject(s.project)].slice(-100),
              future: [],
              transactionStart: null,
            },
          }
        }

        if (entityType === 'tab') {
          const sourceTabs = entityIds
            .map((tabId) => s.project.tabs.find((tab) => tab.id === tabId) ?? null)
            .filter((tab): tab is Tab => tab !== null)
          if (sourceTabs.length !== entityIds.length) {
            return { pendingMove: null }
          }

          const createdTabs =
            mode === 'copy'
              ? deps.buildCopiedTabs(sourceTabs, s.project.tabs, s.project, dx, dy, normalizedCopyCount)
              : []

          const nextProject = {
            ...s.project,
            tabs:
              mode === 'copy'
                ? [...s.project.tabs, ...createdTabs]
                : s.project.tabs.map((tab) => (
                    entityIds.includes(tab.id) ? deps.translateTab(tab, dx, dy) : tab
                  )),
            meta: { ...s.project.meta, modified: new Date().toISOString() },
          }

          if (deps.projectsEqual(nextProject, s.project)) {
            return { pendingMove: null }
          }

          return {
            project: nextProject,
            pendingMove: null,
            selection:
              mode === 'copy'
                ? {
                    ...s.selection,
                    selectedFeatureId: null,
                    selectedFeatureIds: [],
                    selectedNode: createdTabs.at(-1)
                      ? { type: 'tab', tabId: createdTabs.at(-1)!.id }
                      : s.selection.selectedNode,
                  }
                : s.selection,
            history: {
              past: [...s.history.past, deps.cloneProject(s.project)].slice(-100),
              future: [],
              transactionStart: null,
            },
          }
        }

        const sourceClamps = entityIds
          .map((clampId) => s.project.clamps.find((clamp) => clamp.id === clampId) ?? null)
          .filter((clamp): clamp is Clamp => clamp !== null)
        if (sourceClamps.length !== entityIds.length) {
          return { pendingMove: null }
        }

        const createdClamps =
          mode === 'copy'
            ? deps.buildCopiedClamps(sourceClamps, s.project.clamps, s.project, dx, dy, normalizedCopyCount)
            : []

        const nextProject = {
          ...s.project,
          clamps:
            mode === 'copy'
              ? [...s.project.clamps, ...createdClamps]
              : s.project.clamps.map((clamp) => (
                  entityIds.includes(clamp.id) ? deps.translateClamp(clamp, dx, dy) : clamp
                )),
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        }

        if (deps.projectsEqual(nextProject, s.project)) {
          return { pendingMove: null }
        }

        return {
          project: nextProject,
          pendingMove: null,
          selection:
            mode === 'copy'
              ? {
                  ...s.selection,
                  selectedFeatureId: null,
                  selectedFeatureIds: [],
                  selectedNode: createdClamps.at(-1)
                    ? { type: 'clamp', clampId: createdClamps.at(-1)!.id }
                    : s.selection.selectedNode,
                }
              : s.selection,
          history: {
            past: [...s.history.past, deps.cloneProject(s.project)].slice(-100),
            future: [],
            transactionStart: null,
          },
        }
      }),

    completePendingTransform: (previewPoint) =>
      set((s) => {
        const pendingTransform = s.pendingTransform
        if (!pendingTransform?.referenceStart || !pendingTransform.referenceEnd) {
          return {}
        }

        if (pendingTransform.entityType === 'backdrop') {
          if (!s.project.backdrop) {
            return { pendingTransform: null }
          }

          const nextBackdrop =
            pendingTransform.mode === 'resize'
              ? deps.resizeBackdropFromReference(s.project.backdrop, pendingTransform.referenceStart, pendingTransform.referenceEnd, previewPoint)
              : deps.rotateBackdropFromReference(s.project.backdrop, pendingTransform.referenceStart, pendingTransform.referenceEnd, previewPoint)

          if (!nextBackdrop) {
            return { pendingTransform: null }
          }

          const nextProject = {
            ...s.project,
            backdrop: nextBackdrop,
            meta: { ...s.project.meta, modified: new Date().toISOString() },
          }

          if (deps.projectsEqual(nextProject, s.project)) {
            return { pendingTransform: null }
          }

          return {
            project: nextProject,
            pendingTransform: null,
            history: {
              past: [...s.history.past, deps.cloneProject(s.project)].slice(-100),
              future: [],
              transactionStart: null,
            },
          }
        }

        const sourceFeatures = pendingTransform.entityIds
          .map((featureId) => featureById(s.project, featureId))
          .filter((feature): feature is SketchFeature => feature !== null)
        if (sourceFeatures.length !== pendingTransform.entityIds.length) {
          return { pendingTransform: null }
        }

        const transformedFeatures = new Map<string, SketchFeature>()
        for (const feature of sourceFeatures) {
          const transformed =
            pendingTransform.mode === 'resize'
              ? deps.resizeFeatureFromReference(feature, pendingTransform.referenceStart, pendingTransform.referenceEnd, previewPoint)
              : deps.rotateFeatureFromReference(feature, pendingTransform.referenceStart, pendingTransform.referenceEnd, previewPoint)
          if (!transformed) {
            return { pendingTransform: null }
          }
          transformedFeatures.set(feature.id, transformed)
        }

        const movedTransformedIds = new Set(transformedFeatures.keys())
        const nextProject = {
          ...s.project,
          features: deps.clearStaleConstraints(
            s.project.features.map((feature) => transformedFeatures.get(feature.id) ?? feature),
            movedTransformedIds,
          ),
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        }

        if (deps.projectsEqual(nextProject, s.project)) {
          return { pendingTransform: null }
        }

        return {
          project: nextProject,
          pendingTransform: null,
          history: {
            past: [...s.history.past, deps.cloneProject(s.project)].slice(-100),
            future: [],
            transactionStart: null,
          },
        }
      }),

    completePendingOffset: (distance) => {
      const state = get()
      if (!state.pendingOffset) {
        return []
      }

      const createdFeatures = deps.previewOffsetFeatures(state.project, state.pendingOffset.entityIds, distance)
      if (createdFeatures.length === 0) {
        set({ pendingOffset: null })
        return []
      }

      set((s) => {
        const nextProject = deps.syncFeatureTreeProject({
          ...s.project,
          features: [...s.project.features, ...createdFeatures],
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        })
        const createdIds = createdFeatures.map((feature) => feature.id)
        const primaryId = createdIds.at(-1) ?? null
        return {
          project: nextProject,
          pendingOffset: null,
          selection: {
            ...s.selection,
            selectedFeatureId: primaryId,
            selectedFeatureIds: createdIds,
            selectedNode: primaryId ? { type: 'feature', featureId: primaryId } : null,
            mode: 'feature',
            activeControl: null,
          },
          history: {
            past: [...s.history.past, deps.cloneProject(s.project)].slice(-100),
            future: [],
            transactionStart: null,
          },
        }
      })

      return createdFeatures.map((feature) => feature.id)
    },

    completePendingShapeAction: () => {
      const state = get()
      const pendingShapeAction = state.pendingShapeAction
      if (!pendingShapeAction) {
        return []
      }

      if (pendingShapeAction.kind === 'join') {
        if (pendingShapeAction.entityIds.length < 2) {
          return []
        }

        state.selectFeatures(pendingShapeAction.entityIds)
        const result = get().mergeSelectedFeatures(pendingShapeAction.keepOriginals)
        set({ pendingShapeAction: null })
        return result
      }

      if (!pendingShapeAction.cutterId || pendingShapeAction.targetIds.length === 0) {
        return []
      }

      const cutter = featureById(state.project, pendingShapeAction.cutterId)
      const targets = pendingShapeAction.targetIds
        .map((featureId) => featureById(state.project, featureId))
        .filter((feature): feature is SketchFeature => feature !== null)
        .filter((feature) => feature.sketch.profile.closed)
      if (!cutter || !cutter.sketch.profile.closed || targets.length !== pendingShapeAction.targetIds.length) {
        return []
      }

      const createdGroups: DerivedFeatureGroup[] = cutFeaturesByCutterGrouped(
        state.project,
        cutter,
        targets,
        deps.createDerivedFeature,
      )
      const createdFeatures = createdGroups.flatMap((group) => group.features)
      if (createdFeatures.length === 0) {
        set({ pendingShapeAction: null })
        return []
      }

      set((s) => {
        const idsToReplace = new Set(
          pendingShapeAction.keepOriginals
            ? []
            : pendingShapeAction.targetIds,
        )
        const nextProject = deps.syncFeatureTreeProject({
          ...s.project,
          features: insertDerivedFeaturesAfterSources(s.project.features, createdGroups, idsToReplace),
          featureTree: insertDerivedFeatureTreeEntries(s.project.featureTree, s.project.features, createdGroups, idsToReplace),
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        })
        const createdIds = createdFeatures.map((feature) => feature.id)
        const primaryId = createdIds.at(-1) ?? null
        return {
          project: nextProject,
          pendingShapeAction: null,
          selection: {
            ...s.selection,
            selectedFeatureId: primaryId,
            selectedFeatureIds: createdIds,
            selectedNode: primaryId ? { type: 'feature', featureId: primaryId } : null,
            mode: 'feature',
            activeControl: null,
          },
          history: {
            past: [...s.history.past, deps.cloneProject(s.project)].slice(-100),
            future: [],
            transactionStart: null,
          },
        }
      })

      return createdFeatures.map((feature) => feature.id)
    },
  }
}
