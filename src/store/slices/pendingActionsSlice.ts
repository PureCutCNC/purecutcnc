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
import type { Clamp, Project, SketchFeature, Tab } from '../../types/project'
import { selectedClosedFeaturesFromIds } from '../helpers/derivedFeatures'
import { nextPlacementSession } from '../helpers/ids'
import type { ProjectStore } from '../types'

export type PendingActionsSlice = Pick<
  ProjectStore,
  | 'pendingMove'
  | 'pendingTransform'
  | 'pendingOffset'
  | 'pendingShapeAction'
  | 'startMoveFeature'
  | 'startCopyFeature'
  | 'startResizeFeature'
  | 'startRotateFeature'
  | 'startMoveBackdrop'
  | 'startResizeBackdrop'
  | 'startRotateBackdrop'
  | 'startJoinSelectedFeatures'
  | 'startCutSelectedFeatures'
  | 'startOffsetSelectedFeatures'
  | 'startMoveClamp'
  | 'startCopyClamp'
  | 'startMoveTab'
  | 'startCopyTab'
  | 'cancelPendingMove'
  | 'cancelPendingTransform'
  | 'cancelPendingShapeAction'
  | 'setPendingShapeActionKeepOriginals'
  | 'cancelPendingOffset'
  | 'setPendingMoveFrom'
  | 'setPendingMoveTo'
  | 'setPendingTransformReferenceStart'
  | 'setPendingTransformReferenceEnd'
>

function featureById(project: Project, id: string): SketchFeature | null {
  return project.features.find((feature) => feature.id === id) ?? null
}

function clampById(project: Project, id: string): Clamp | null {
  return project.clamps.find((clamp) => clamp.id === id) ?? null
}

function tabById(project: Project, id: string): Tab | null {
  return project.tabs.find((tab) => tab.id === id) ?? null
}

export function createPendingActionsSlice(
  set: Parameters<StateCreator<ProjectStore>>[0],
  _get: Parameters<StateCreator<ProjectStore>>[1],
): PendingActionsSlice {
  return {
    pendingMove: null,
    pendingTransform: null,
    pendingOffset: null,
    pendingShapeAction: null,

    startMoveFeature: (featureId) =>
      set((s) => {
        const featureIds = s.selection.selectedFeatureIds.includes(featureId)
          ? s.selection.selectedFeatureIds
          : [featureId]
        const features = featureIds
          .map((id) => featureById(s.project, id))
          .filter((feature): feature is SketchFeature => feature !== null)
        if (features.length !== featureIds.length || features.some((feature) => feature.locked)) {
          return {}
        }

        return {
          pendingAdd: null,
          sketchEditSession: null,
          pendingMove: { mode: 'move', entityType: 'feature', entityIds: featureIds, fromPoint: null, toPoint: null, session: nextPlacementSession() },
          pendingTransform: null,
          pendingOffset: null,
          pendingShapeAction: null,
          selection: {
            ...s.selection,
            selectedFeatureId: featureId,
            selectedFeatureIds: featureIds,
            selectedNode: { type: 'feature', featureId },
            mode: 'feature',
            hoveredFeatureId: null,
            activeControl: null,
          },
        }
      }),

    startCopyFeature: (featureId) =>
      set((s) => {
        const featureIds = s.selection.selectedFeatureIds.includes(featureId)
          ? s.selection.selectedFeatureIds
          : [featureId]
        const features = featureIds
          .map((id) => featureById(s.project, id))
          .filter((feature): feature is SketchFeature => feature !== null)
        if (features.length !== featureIds.length) {
          return {}
        }

        return {
          pendingAdd: null,
          sketchEditSession: null,
          pendingMove: { mode: 'copy', entityType: 'feature', entityIds: featureIds, fromPoint: null, toPoint: null, session: nextPlacementSession() },
          pendingTransform: null,
          pendingOffset: null,
          pendingShapeAction: null,
          selection: {
            ...s.selection,
            selectedFeatureId: featureId,
            selectedFeatureIds: featureIds,
            selectedNode: { type: 'feature', featureId },
            mode: 'feature',
            hoveredFeatureId: null,
            activeControl: null,
          },
        }
      }),

    startResizeFeature: (featureId) =>
      set((s) => {
        const featureIds = s.selection.selectedFeatureIds.includes(featureId)
          ? s.selection.selectedFeatureIds
          : [featureId]
        const features = featureIds
          .map((id) => featureById(s.project, id))
          .filter((feature): feature is SketchFeature => feature !== null)
        if (features.length !== featureIds.length || features.some((feature) => feature.locked)) {
          return {}
        }

        return {
          pendingAdd: null,
          pendingMove: null,
          pendingTransform: { mode: 'resize', entityType: 'feature', entityIds: featureIds, referenceStart: null, referenceEnd: null, session: nextPlacementSession() },
          pendingOffset: null,
          pendingShapeAction: null,
          sketchEditSession: null,
          selection: {
            ...s.selection,
            selectedFeatureId: featureId,
            selectedFeatureIds: featureIds,
            selectedNode: { type: 'feature', featureId },
            mode: 'feature',
            hoveredFeatureId: null,
            activeControl: null,
          },
        }
      }),

    startRotateFeature: (featureId) =>
      set((s) => {
        const featureIds = s.selection.selectedFeatureIds.includes(featureId)
          ? s.selection.selectedFeatureIds
          : [featureId]
        const features = featureIds
          .map((id) => featureById(s.project, id))
          .filter((feature): feature is SketchFeature => feature !== null)
        if (features.length !== featureIds.length || features.some((feature) => feature.locked)) {
          return {}
        }

        return {
          pendingAdd: null,
          pendingMove: null,
          pendingTransform: { mode: 'rotate', entityType: 'feature', entityIds: featureIds, referenceStart: null, referenceEnd: null, session: nextPlacementSession() },
          pendingOffset: null,
          pendingShapeAction: null,
          sketchEditSession: null,
          selection: {
            ...s.selection,
            selectedFeatureId: featureId,
            selectedFeatureIds: featureIds,
            selectedNode: { type: 'feature', featureId },
            mode: 'feature',
            hoveredFeatureId: null,
            activeControl: null,
          },
        }
      }),

    startMoveBackdrop: () =>
      set((s) => {
        if (!s.project.backdrop) {
          return {}
        }

        return {
          pendingAdd: null,
          sketchEditSession: null,
          pendingMove: { mode: 'move', entityType: 'backdrop', entityIds: ['backdrop'], fromPoint: null, toPoint: null, session: nextPlacementSession() },
          pendingTransform: null,
          pendingOffset: null,
          pendingShapeAction: null,
          selection: {
            ...s.selection,
            selectedFeatureId: null,
            selectedFeatureIds: [],
            selectedNode: { type: 'backdrop' },
            mode: 'feature',
            hoveredFeatureId: null,
            activeControl: null,
          },
        }
      }),

    startResizeBackdrop: () =>
      set((s) => {
        if (!s.project.backdrop) {
          return {}
        }

        return {
          pendingAdd: null,
          pendingMove: null,
          pendingTransform: { mode: 'resize', entityType: 'backdrop', entityIds: [], referenceStart: null, referenceEnd: null, session: nextPlacementSession() },
          pendingOffset: null,
          pendingShapeAction: null,
          sketchEditSession: null,
          selection: {
            ...s.selection,
            selectedFeatureId: null,
            selectedFeatureIds: [],
            selectedNode: { type: 'backdrop' },
            mode: 'feature',
            hoveredFeatureId: null,
            activeControl: null,
          },
        }
      }),

    startRotateBackdrop: () =>
      set((s) => {
        if (!s.project.backdrop) {
          return {}
        }

        return {
          pendingAdd: null,
          pendingMove: null,
          pendingTransform: { mode: 'rotate', entityType: 'backdrop', entityIds: [], referenceStart: null, referenceEnd: null, session: nextPlacementSession() },
          pendingOffset: null,
          pendingShapeAction: null,
          sketchEditSession: null,
          selection: {
            ...s.selection,
            selectedFeatureId: null,
            selectedFeatureIds: [],
            selectedNode: { type: 'backdrop' },
            mode: 'feature',
            hoveredFeatureId: null,
            activeControl: null,
          },
        }
      }),

    startJoinSelectedFeatures: () =>
      set((s) => {
        const featureIds = selectedClosedFeaturesFromIds(s.project, s.selection.selectedFeatureIds).map((feature) => feature.id)

        return {
          pendingAdd: null,
          pendingMove: null,
          pendingTransform: null,
          pendingOffset: null,
          pendingShapeAction: { kind: 'join', entityIds: featureIds, keepOriginals: false, session: nextPlacementSession() },
          sketchEditSession: null,
          selection: {
            ...s.selection,
            selectedFeatureId: featureIds.at(-1) ?? null,
            selectedFeatureIds: featureIds,
            selectedNode: featureIds.at(-1) ? { type: 'feature', featureId: featureIds.at(-1)! } : null,
            mode: 'feature',
            hoveredFeatureId: null,
            activeControl: null,
          },
        }
      }),

    startCutSelectedFeatures: () =>
      set((s) => ({
        pendingAdd: null,
        pendingMove: null,
        pendingTransform: null,
        pendingOffset: null,
        pendingShapeAction: { kind: 'cut', cutterId: null, targetIds: [], keepOriginals: false, session: nextPlacementSession() },
        sketchEditSession: null,
        selection: {
          ...s.selection,
          selectedFeatureId: null,
          selectedFeatureIds: [],
          selectedNode: null,
          mode: 'feature',
          hoveredFeatureId: null,
          activeControl: null,
        },
      })),

    startOffsetSelectedFeatures: () =>
      set((s) => {
        const featureIds = s.selection.selectedFeatureIds
        const features = selectedClosedFeaturesFromIds(s.project, featureIds)
        if (features.length === 0 || features.some((feature) => feature.locked || feature.kind === 'text')) {
          return {}
        }

        return {
          pendingAdd: null,
          pendingMove: null,
          pendingTransform: null,
          pendingShapeAction: null,
          pendingOffset: { entityIds: featureIds, session: nextPlacementSession() },
          sketchEditSession: null,
          selection: {
            ...s.selection,
            selectedFeatureId: featureIds.at(-1) ?? null,
            selectedFeatureIds: featureIds,
            selectedNode: featureIds.at(-1) ? { type: 'feature', featureId: featureIds.at(-1)! } : null,
            mode: 'feature',
            hoveredFeatureId: null,
            activeControl: null,
          },
        }
      }),

    startMoveClamp: (clampId) =>
      set((s) => {
        if (!clampById(s.project, clampId)) {
          return {}
        }

        return {
          pendingAdd: null,
          sketchEditSession: null,
          pendingMove: { mode: 'move', entityType: 'clamp', entityIds: [clampId], fromPoint: null, toPoint: null, session: nextPlacementSession() },
          pendingTransform: null,
          pendingOffset: null,
          selection: {
            ...s.selection,
            selectedFeatureId: null,
            selectedFeatureIds: [],
            selectedNode: { type: 'clamp', clampId },
            mode: 'feature',
            hoveredFeatureId: null,
            activeControl: null,
          },
        }
      }),

    startCopyClamp: (clampId) =>
      set((s) => {
        if (!clampById(s.project, clampId)) {
          return {}
        }

        return {
          pendingAdd: null,
          sketchEditSession: null,
          pendingMove: { mode: 'copy', entityType: 'clamp', entityIds: [clampId], fromPoint: null, toPoint: null, session: nextPlacementSession() },
          pendingTransform: null,
          pendingOffset: null,
          selection: {
            ...s.selection,
            selectedFeatureId: null,
            selectedFeatureIds: [],
            selectedNode: { type: 'clamp', clampId },
            mode: 'feature',
            hoveredFeatureId: null,
            activeControl: null,
          },
        }
      }),

    startMoveTab: (tabId) =>
      set((s) => {
        if (!tabById(s.project, tabId)) {
          return {}
        }

        return {
          pendingAdd: null,
          sketchEditSession: null,
          pendingMove: { mode: 'move', entityType: 'tab', entityIds: [tabId], fromPoint: null, toPoint: null, session: nextPlacementSession() },
          pendingTransform: null,
          pendingOffset: null,
          selection: {
            ...s.selection,
            selectedFeatureId: null,
            selectedFeatureIds: [],
            selectedNode: { type: 'tab', tabId },
            mode: 'feature',
            hoveredFeatureId: null,
            activeControl: null,
          },
        }
      }),

    startCopyTab: (tabId) =>
      set((s) => {
        if (!tabById(s.project, tabId)) {
          return {}
        }

        return {
          pendingAdd: null,
          sketchEditSession: null,
          pendingMove: { mode: 'copy', entityType: 'tab', entityIds: [tabId], fromPoint: null, toPoint: null, session: nextPlacementSession() },
          pendingTransform: null,
          pendingOffset: null,
          selection: {
            ...s.selection,
            selectedFeatureId: null,
            selectedFeatureIds: [],
            selectedNode: { type: 'tab', tabId },
            mode: 'feature',
            hoveredFeatureId: null,
            activeControl: null,
          },
        }
      }),

    cancelPendingMove: () => set({ pendingMove: null }),

    cancelPendingTransform: () => set({ pendingTransform: null }),

    cancelPendingShapeAction: () => set({ pendingShapeAction: null }),

    setPendingShapeActionKeepOriginals: (keepOriginals) =>
      set((s) => ({
        pendingShapeAction: s.pendingShapeAction ? { ...s.pendingShapeAction, keepOriginals } : null,
      })),

    cancelPendingOffset: () => set({ pendingOffset: null }),

    setPendingMoveFrom: (point) =>
      set((s) => ({
        pendingMove: s.pendingMove ? { ...s.pendingMove, fromPoint: point } : null,
      })),

    setPendingMoveTo: (point) =>
      set((s) => ({
        pendingMove: s.pendingMove ? { ...s.pendingMove, toPoint: point } : null,
      })),

    setPendingTransformReferenceStart: (point) =>
      set((s) => ({
        pendingTransform: s.pendingTransform ? { ...s.pendingTransform, referenceStart: point } : null,
      })),

    setPendingTransformReferenceEnd: (point) =>
      set((s) => ({
        pendingTransform: s.pendingTransform ? { ...s.pendingTransform, referenceEnd: point } : null,
      })),
  }
}
