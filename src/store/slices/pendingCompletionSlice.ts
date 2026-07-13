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
import type { Clamp, FeatureDefinition, FeatureFolder, FeatureInstance, Point, Project, SketchFeature, Tab } from '../../types/project'
import {
  cloneProject,
  projectsEqual,
  syncFeatureTreeProject,
} from '../helpers/normalize'
import {
  cutFeaturesByCutterGrouped,
  insertDerivedFeaturesAfterSources,
  insertDerivedFeatureTreeEntries,
} from '../helpers/derivedFeatures'
import type { DerivedFeatureGroup } from '../helpers/derivedFeatures'
import { createFeatureInstance, gcOrphanedDefinitions } from '../helpers/featureDefinitions'
import { nextUniqueGeneratedId } from '../helpers/ids'
import type { ProjectStore } from '../types'
import { transformProfile, translateClamp, translateTab } from '../helpers/transform'
import { moveDelta, multiplyMatrix } from '../helpers/instanceTransforms'
import {
  mirrorFeatureFromReference,
  resizeBackdropFromReference,
  resizeFeatureFromReference,
  rotateBackdropFromReference,
  rotateFeatureFromReference,
} from '../helpers/referenceTransforms'
import {
  buildCopiedClamps,
  buildCopiedFeatures,
  buildCopiedTabs,
  buildMirroredCopies,
  buildRotatedCopies,
  extractClonedDefinitions,
  type ReferencedSketchFeature,
} from '../helpers/copyFeatures'
import { uniqueFolderName } from '../helpers/naming'
import {
  commitResolvedInstances,
  resolveFeatureInstance,
  resolvedProjectFeatures,
  restoreResolvedFeatureMetadata,
  type ResolvedSketchFeature,
} from '../helpers/resolveFeatures'

export interface PendingCompletionSliceDependencies {
  clearStaleConstraints: (features: SketchFeature[], movedIds: Set<string>) => SketchFeature[]
  propagateConstraintsOnTranslate: (features: SketchFeature[], movedOffsets: Map<string, { dx: number; dy: number }>) => SketchFeature[]
  propagateConstraintsOnRotate: (features: SketchFeature[], movedRotations: Map<string, { pivot: Point, angle: number }>) => SketchFeature[]
  validateAllConstraints: (features: SketchFeature[]) => SketchFeature[]
  previewOffsetFeatures: (project: Project, featureIds: string[], distance: number) => { features: SketchFeature[]; definitions: FeatureDefinition[] }
  createDerivedFeature: (
    project: Project,
    baseFeature: SketchFeature,
    profile: SketchFeature['sketch']['profile'],
    operation: SketchFeature['operation'],
    name: string,
  ) => { feature: SketchFeature; definition: FeatureDefinition }
}

export type PendingCompletionSlice = Pick<
  ProjectStore,
  | 'completePendingMove'
  | 'completePendingTransform'
  | 'completePendingOffset'
  | 'completePendingShapeAction'
>

function featureById(project: Project, id: string): ResolvedSketchFeature | null {
  return resolveFeatureInstance(project, id)
}

function instanceFromReferencedDraft(feature: ReferencedSketchFeature): FeatureInstance {
  return createFeatureInstance(
    feature,
    feature.definitionId,
    feature.transform,
  )
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

          if (projectsEqual(nextProject, s.project)) {
            return { pendingMove: null }
          }

          return {
            project: nextProject,
            pendingMove: null,
            history: {
              past: [...s.history.past, cloneProject(s.project)].slice(-100),
              future: [],
              transactionStart: null,
            },
          }
        }

        if (entityType === 'feature') {
          const sourceFeatures = entityIds
            .map((featureId) => featureById(s.project, featureId))
            .filter((feature): feature is ResolvedSketchFeature => feature !== null)
          if (sourceFeatures.length !== entityIds.length) {
            return { pendingMove: null }
          }

          const effectiveCopyMode = s.pendingMove.copyMode ?? s.project.meta.copyMode

          const createdFeatures =
            mode === 'copy'
              ? buildCopiedFeatures(
                  sourceFeatures,
                  resolvedProjectFeatures(s.project),
                  dx,
                  dy,
                  normalizedCopyCount,
                  s.project.featureDefinitions,
                  effectiveCopyMode,
                )
              : []

          // Merge cloned definitions for independent copies.
          const clonedDefs = mode === 'copy' ? extractClonedDefinitions(createdFeatures) : {}
          // Strip the _clonedDefinition temporary key from created features.
          const cleanedCreatedFeatures = mode === 'copy'
            ? createdFeatures.map((f) => {
                const { _clonedDefinition, ...rest } = f
                return rest
              })
            : []

          // Detect group copy: the sources are the ENTIRE membership of one
          // grouped folder. Only then do the copies get their own new grouped
          // folder. Copying a subset (e.g. a single member) keeps the copies
          // in the original's folder instead — buildCopiedFeatures already
          // preserves each source's folderId.
          let finalCreatedFeatures: ReferencedSketchFeature[] = cleanedCreatedFeatures
          let groupCopyFolder: FeatureFolder | null = null

          if (mode === 'copy' && cleanedCreatedFeatures.length > 0) {
            const firstFolderId = sourceFeatures[0].folderId
            if (
              firstFolderId != null &&
              sourceFeatures.every((f) => f.folderId === firstFolderId)
            ) {
              const sourceFolder = s.project.featureFolders.find(
                (f) => f.id === firstFolderId,
              )
              const sourceIdSet = new Set(sourceFeatures.map((f) => f.id))
              const copiesWholeGroup = s.project.features
                .filter((f) => f.folderId === firstFolderId)
                .every((f) => sourceIdSet.has(f.id))
              if (sourceFolder?.grouped === true && copiesWholeGroup) {
                const newFolderId = nextUniqueGeneratedId(s.project, 'fd')
                const newFolderName = uniqueFolderName(
                  `${sourceFolder.name} Copy`,
                  s.project.featureFolders,
                )
                groupCopyFolder = {
                  id: newFolderId,
                  name: newFolderName,
                  collapsed: false,
                  section: sourceFolder.section,
                  grouped: true,
                }
                finalCreatedFeatures = cleanedCreatedFeatures.map((f) => ({
                  ...f,
                  folderId: newFolderId,
                }))
              }
            }
          }

          const isGroupCopy = groupCopyFolder !== null
          const createdInstances = finalCreatedFeatures.map(instanceFromReferencedDraft)

          const translatedFeatures =
            mode === 'copy'
              ? []
              : resolvedProjectFeatures(s.project).map((feature) => {
                  if (!entityIds.includes(feature.id) || feature.locked) {
                    return feature
                  }

                  return {
                    ...feature,
                    sketch: {
                      ...feature.sketch,
                      origin: ['text', 'stl'].includes(feature.kind)
                        ? { x: feature.sketch.origin.x + dx, y: feature.sketch.origin.y + dy }
                        : feature.sketch.origin,
                      profile: transformProfile(feature.sketch.profile, (p) => ({ x: p.x + dx, y: p.y + dy })),
                    },
                    transform: multiplyMatrix(moveDelta(dx, dy), feature.transform),
                  }
                })
          const resolvedFeatures =
            mode === 'copy'
              ? []
              : restoreResolvedFeatureMetadata(
                  translatedFeatures,
                  deps.validateAllConstraints(deps.propagateConstraintsOnTranslate(
                    translatedFeatures,
                    new Map(entityIds.filter((id) => !s.project.features.find((f) => f.id === id)?.locked).map((id) => [id, { dx, dy }])),
                  )),
                )
          const nextFeatureDefinitions = {
            ...s.project.featureDefinitions,
            ...clonedDefs,
          }
          const nextProject = {
            ...s.project,
            features: mode === 'copy'
              ? [...s.project.features, ...createdInstances]
              : commitResolvedInstances(s.project, resolvedFeatures),
            featureDefinitions: nextFeatureDefinitions,
            featureFolders:
              isGroupCopy
                ? [...s.project.featureFolders, groupCopyFolder!]
                : s.project.featureFolders,
            featureTree:
              isGroupCopy
                ? [
                    ...s.project.featureTree,
                    { type: 'folder' as const, folderId: groupCopyFolder!.id },
                  ]
                : mode === 'copy'
                  ? [
                      ...s.project.featureTree,
                      // Foldered copies get no root entry — folder children
                      // render from the features array, and a stray root
                      // entry would double-list them.
                      ...createdInstances
                        .filter((feature) => feature.folderId === null)
                        .map((feature) => ({ type: 'feature' as const, featureId: feature.id })),
                    ]
                  : s.project.featureTree,
            meta: { ...s.project.meta, modified: new Date().toISOString() },
          }

          if (projectsEqual(nextProject, s.project)) {
            return { pendingMove: null }
          }

          return {
            project: nextProject,
            pendingMove: null,
            selection:
              mode === 'copy'
                ? {
                    ...s.selection,
                    selectedFeatureId: finalCreatedFeatures.at(-1)?.id ?? s.selection.selectedFeatureId,
                    selectedFeatureIds: finalCreatedFeatures.map((f) => f.id),
                    selectedNode: isGroupCopy
                      ? { type: 'folder', folderId: groupCopyFolder!.id }
                      : finalCreatedFeatures.at(-1)
                        ? { type: 'feature', featureId: finalCreatedFeatures.at(-1)!.id }
                        : s.selection.selectedNode,
                    groupFolderId: isGroupCopy ? groupCopyFolder!.id : undefined,
                  }
                : s.selection,
            history: {
              past: [...s.history.past, cloneProject(s.project)].slice(-100),
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
              ? buildCopiedTabs(sourceTabs, s.project.tabs, s.project, dx, dy, normalizedCopyCount)
              : []

          const nextProject = {
            ...s.project,
            tabs:
              mode === 'copy'
                ? [...s.project.tabs, ...createdTabs]
                : s.project.tabs.map((tab) => (
                    entityIds.includes(tab.id) ? translateTab(tab, dx, dy) : tab
                  )),
            meta: { ...s.project.meta, modified: new Date().toISOString() },
          }

          if (projectsEqual(nextProject, s.project)) {
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
              past: [...s.history.past, cloneProject(s.project)].slice(-100),
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
            ? buildCopiedClamps(sourceClamps, s.project.clamps, s.project, dx, dy, normalizedCopyCount)
            : []

        const nextProject = {
          ...s.project,
          clamps:
            mode === 'copy'
              ? [...s.project.clamps, ...createdClamps]
              : s.project.clamps.map((clamp) => (
                  entityIds.includes(clamp.id) ? translateClamp(clamp, dx, dy) : clamp
                )),
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        }

        if (projectsEqual(nextProject, s.project)) {
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
            past: [...s.history.past, cloneProject(s.project)].slice(-100),
            future: [],
            transactionStart: null,
          },
        }
      }),

    completePendingTransform: (previewPoint, copyCount = 1) =>
      set((s) => {
        const pendingTransform = s.pendingTransform
        if (!pendingTransform?.referenceStart || !pendingTransform.referenceEnd) {
          return {}
        }

        if (pendingTransform.entityType === 'backdrop') {
          if (!s.project.backdrop) {
            return { pendingTransform: null }
          }
          if (pendingTransform.mode === 'mirror') {
            return { pendingTransform: null }
          }

          const nextBackdrop =
            pendingTransform.mode === 'resize'
              ? resizeBackdropFromReference(s.project.backdrop, pendingTransform.referenceStart, pendingTransform.referenceEnd, previewPoint)
              : rotateBackdropFromReference(s.project.backdrop, pendingTransform.referenceStart, pendingTransform.referenceEnd, previewPoint)

          if (!nextBackdrop) {
            return { pendingTransform: null }
          }

          const nextProject = {
            ...s.project,
            backdrop: nextBackdrop,
            meta: { ...s.project.meta, modified: new Date().toISOString() },
          }

          if (projectsEqual(nextProject, s.project)) {
            return { pendingTransform: null }
          }

          return {
            project: nextProject,
            pendingTransform: null,
            history: {
              past: [...s.history.past, cloneProject(s.project)].slice(-100),
              future: [],
              transactionStart: null,
            },
          }
        }

        const sourceFeatures = pendingTransform.entityIds
          .map((featureId) => featureById(s.project, featureId))
          .filter((feature): feature is ResolvedSketchFeature => feature !== null)
        if (sourceFeatures.length !== pendingTransform.entityIds.length) {
          return { pendingTransform: null }
        }

        // Rotate+copy: keep originals and add rotated copies
        if (pendingTransform.mode === 'rotate' && pendingTransform.keepOriginals) {
          const startVector = {
            x: pendingTransform.referenceEnd.x - pendingTransform.referenceStart.x,
            y: pendingTransform.referenceEnd.y - pendingTransform.referenceStart.y,
          }
          const endVector = {
            x: previewPoint.x - pendingTransform.referenceStart.x,
            y: previewPoint.y - pendingTransform.referenceStart.y,
          }
          const cross = startVector.x * endVector.y - startVector.y * endVector.x
          const dot = startVector.x * endVector.x + startVector.y * endVector.y
          const angle = Math.atan2(cross, dot)
          if (!Number.isFinite(angle) || Math.abs(angle) < 1e-9) {
            return { pendingTransform: null }
          }
          const normalizedCopyCount = Math.max(1, Math.floor(copyCount))
          const createdFeatures = buildRotatedCopies(
            sourceFeatures,
            resolvedProjectFeatures(s.project),
            pendingTransform.referenceStart,
            angle,
            normalizedCopyCount,
          )
          if (createdFeatures.length === 0) {
            return { pendingTransform: null }
          }
          const createdInstances = createdFeatures.map(instanceFromReferencedDraft)
          const nextProject = {
            ...s.project,
            features: [...s.project.features, ...createdInstances],
            featureTree: [
              ...s.project.featureTree,
              // Copies keep their source's folderId; only root copies get a
              // tree entry (folder children render from the features array).
              ...createdInstances
                .filter((feature) => feature.folderId === null)
                .map((feature) => ({ type: 'feature' as const, featureId: feature.id })),
            ],
            meta: { ...s.project.meta, modified: new Date().toISOString() },
          }
          return {
            project: nextProject,
            pendingTransform: null,
            selection: {
              ...s.selection,
              selectedFeatureId: createdFeatures.at(-1)?.id ?? s.selection.selectedFeatureId,
              selectedFeatureIds: createdFeatures.map((f) => f.id),
              selectedNode: createdFeatures.at(-1)
                ? { type: 'feature', featureId: createdFeatures.at(-1)!.id }
                : s.selection.selectedNode,
            },
            history: {
              past: [...s.history.past, cloneProject(s.project)].slice(-100),
              future: [],
              transactionStart: null,
            },
          }
        }

        // Mirror+copy: keep originals and add one mirrored copy of each selected feature.
        if (pendingTransform.mode === 'mirror' && pendingTransform.keepOriginals) {
          const createdFeatures = buildMirroredCopies(
            sourceFeatures,
            resolvedProjectFeatures(s.project),
            pendingTransform.referenceStart,
            pendingTransform.referenceEnd,
          )
          if (createdFeatures.length === 0) {
            return { pendingTransform: null }
          }
          const createdInstances = createdFeatures.map(instanceFromReferencedDraft)
          const nextProject = {
            ...s.project,
            features: [...s.project.features, ...createdInstances],
            featureTree: [
              ...s.project.featureTree,
              // Copies keep their source's folderId; only root copies get a
              // tree entry (folder children render from the features array).
              ...createdInstances
                .filter((feature) => feature.folderId === null)
                .map((feature) => ({ type: 'feature' as const, featureId: feature.id })),
            ],
            meta: { ...s.project.meta, modified: new Date().toISOString() },
          }
          return {
            project: nextProject,
            pendingTransform: null,
            selection: {
              ...s.selection,
              selectedFeatureId: createdFeatures.at(-1)?.id ?? s.selection.selectedFeatureId,
              selectedFeatureIds: createdFeatures.map((f) => f.id),
              selectedNode: createdFeatures.at(-1)
                ? { type: 'feature', featureId: createdFeatures.at(-1)!.id }
                : s.selection.selectedNode,
            },
            history: {
              past: [...s.history.past, cloneProject(s.project)].slice(-100),
              future: [],
              transactionStart: null,
            },
          }
        }

        const transformedFeatures = new Map<string, SketchFeature>()
        for (const feature of sourceFeatures) {
          const transformed =
            pendingTransform.mode === 'resize'
              ? resizeFeatureFromReference(feature, pendingTransform.referenceStart, pendingTransform.referenceEnd, previewPoint)
              : pendingTransform.mode === 'rotate'
                ? rotateFeatureFromReference(feature, pendingTransform.referenceStart, pendingTransform.referenceEnd, previewPoint)
                : mirrorFeatureFromReference(feature, pendingTransform.referenceStart, pendingTransform.referenceEnd)
          if (!transformed) {
            return { pendingTransform: null }
          }
          transformedFeatures.set(feature.id, transformed)
        }

        const movedTransformedIds = new Set(transformedFeatures.keys())
        const sourceResolvedFeatures = resolvedProjectFeatures(s.project)
        const nextFeatures = sourceResolvedFeatures.map((feature) => {
          const transformed = transformedFeatures.get(feature.id)
          if (!transformed) return feature
          return { ...feature, ...transformed }
        })
        let resolvedFeatures
        if (pendingTransform.mode === 'rotate') {
          const startVector = {
            x: pendingTransform.referenceEnd.x - pendingTransform.referenceStart.x,
            y: pendingTransform.referenceEnd.y - pendingTransform.referenceStart.y,
          }
          const endVector = {
            x: previewPoint.x - pendingTransform.referenceStart.x,
            y: previewPoint.y - pendingTransform.referenceStart.y,
          }
          const cross = startVector.x * endVector.y - startVector.y * endVector.x
          const dot = startVector.x * endVector.x + startVector.y * endVector.y
          const angle = Math.atan2(cross, dot)
          const pivot = pendingTransform.referenceStart
          const movedRotations = new Map([...movedTransformedIds].map(id => [id, { pivot, angle }]))
          resolvedFeatures = restoreResolvedFeatureMetadata(
            nextFeatures,
            deps.validateAllConstraints(deps.propagateConstraintsOnRotate(nextFeatures, movedRotations)),
          )
        } else {
          resolvedFeatures = restoreResolvedFeatureMetadata(
            nextFeatures,
            deps.validateAllConstraints(deps.clearStaleConstraints(nextFeatures, movedTransformedIds)),
          )
        }
        const nextProject = {
          ...s.project,
          features: commitResolvedInstances(s.project, resolvedFeatures),
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        }

        if (projectsEqual(nextProject, s.project)) {
          return { pendingTransform: null }
        }

        return {
          project: nextProject,
          pendingTransform: null,
          history: {
            past: [...s.history.past, cloneProject(s.project)].slice(-100),
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

      const offsetResult = deps.previewOffsetFeatures(state.project, state.pendingOffset.entityIds, distance)
      const createdFeatures = offsetResult.features
      const createdInstances = createdFeatures.map((feature, index) => {
        const definition = offsetResult.definitions[index]
        if (!definition) {
          throw new Error(`Missing offset definition for feature ${feature.id}`)
        }
        return createFeatureInstance(feature, definition.id)
      })
      if (createdFeatures.length === 0) {
        set({ pendingOffset: null })
        return []
      }

      set((s) => {
        const nextDefinitions = { ...s.project.featureDefinitions }
        for (const definition of offsetResult.definitions) {
          nextDefinitions[definition.id] = definition
        }
        const nextProject = syncFeatureTreeProject({
          ...s.project,
          features: [...s.project.features, ...createdInstances],
          featureDefinitions: nextDefinitions,
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
            past: [...s.history.past, cloneProject(s.project)].slice(-100),
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

      if (pendingShapeAction.cutterIds.length === 0 || pendingShapeAction.targetIds.length === 0) {
        return []
      }

      const cutters = pendingShapeAction.cutterIds
        .map((cId) => featureById(state.project, cId))
        .filter((feature): feature is ResolvedSketchFeature => feature !== null)
      const targets = pendingShapeAction.targetIds
        .map((featureId) => featureById(state.project, featureId))
        .filter((feature): feature is ResolvedSketchFeature => feature !== null)
      if (cutters.length !== pendingShapeAction.cutterIds.length || targets.length !== pendingShapeAction.targetIds.length) {
        return []
      }

      const cutResult = cutFeaturesByCutterGrouped(
        state.project,
        cutters,
        targets,
        deps.createDerivedFeature,
      )
      const createdGroups: DerivedFeatureGroup[] = cutResult.groups
      const createdFeatures = createdGroups.flatMap((group) => group.features)
      let definitionIndex = 0
      const createdInstanceGroups: Array<DerivedFeatureGroup<FeatureInstance>> = createdGroups.map((group) => ({
        sourceId: group.sourceId,
        features: group.features.map((feature) => {
          const definition = cutResult.definitions[definitionIndex]
          definitionIndex += 1
          if (!definition) {
            throw new Error(`Missing cut definition for feature ${feature.id}`)
          }
          return createFeatureInstance(feature, definition.id)
        }),
      }))
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
        const nextFeatures = insertDerivedFeaturesAfterSources(s.project.features, createdInstanceGroups, idsToReplace)
        const nextFeatureTree = insertDerivedFeatureTreeEntries(s.project.featureTree, s.project.features, createdInstanceGroups, idsToReplace)
        const nextDefinitions = { ...s.project.featureDefinitions }
        for (const definition of cutResult.definitions) {
          nextDefinitions[definition.id] = definition
        }
        const finalDefinitions = pendingShapeAction.keepOriginals
          ? nextDefinitions
          : gcOrphanedDefinitions(nextFeatures, nextDefinitions, s.project.stock.sourceFeature).definitions
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
            past: [...s.history.past, cloneProject(s.project)].slice(-100),
            future: [],
            transactionStart: null,
          },
        }
      })

      return createdFeatures.map((feature) => feature.id)
    },
  }
}
