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
import type { Project, SketchFeature } from '../../types/project'
import type { ProjectStore, SelectionState } from '../types'
import { featuresFormConnectedOverlapGroup, featuresOverlap } from '../helpers/clipping'

export interface SelectionSliceDependencies {
  cloneProject: (project: Project) => Project
  normalizeProject: (project: Project) => Project
}

export type SelectionSlice = Pick<
  ProjectStore,
  | 'selection'
  | 'sketchEditSession'
  | 'selectFeature'
  | 'selectFeatures'
  | 'selectProject'
  | 'selectGrid'
  | 'selectStock'
  | 'selectOrigin'
  | 'selectBackdrop'
  | 'selectFeaturesRoot'
  | 'selectRegionsRoot'
  | 'selectTabsRoot'
  | 'selectClampsRoot'
  | 'selectFeatureFolder'
  | 'selectTab'
  | 'selectClamp'
  | 'hoverFeature'
  | 'enterSketchEdit'
  | 'enterClampEdit'
  | 'enterTabEdit'
  | 'applySketchEdit'
  | 'cancelSketchEdit'
  | 'setSketchEditTool'
  | 'setActiveControl'
>

export function emptySelection(): SelectionState {
  return {
    mode: 'feature',
    selectedFeatureId: null,
    selectedFeatureIds: [],
    selectedNode: null,
    hoveredFeatureId: null,
    sketchEditTool: null,
    activeControl: null,
  }
}

export function sanitizeSelection(project: Project, selection: SelectionState): SelectionState {
  const selectedNode = selection.selectedNode
  const selectedFeatureIds = selection.selectedFeatureIds.filter((featureId) =>
    project.features.some((feature) => feature.id === featureId)
  )
  const selectedFeatureId =
    selection.selectedFeatureId && selectedFeatureIds.includes(selection.selectedFeatureId)
      ? selection.selectedFeatureId
      : selectedFeatureIds.at(-1) ?? null

  if (selectedNode?.type === 'feature') {
    if (selectedFeatureIds.length === 0 || !selectedFeatureId) {
      return {
        ...selection,
        mode: 'feature',
        selectedFeatureId: null,
        selectedFeatureIds: [],
        selectedNode: null,
        hoveredFeatureId: null,
        sketchEditTool: null,
        activeControl: null,
      }
    }
  }

  const hoveredFeatureId =
    selection.hoveredFeatureId && project.features.some((feature) => feature.id === selection.hoveredFeatureId)
      ? selection.hoveredFeatureId
      : null

  const safeSelectedNode =
    selectedNode?.type === 'folder'
      ? project.featureFolders.some((folder) => folder.id === selectedNode.folderId)
        ? selectedNode
        : null
      : selectedNode?.type === 'tab'
        ? project.tabs.some((tab) => tab.id === selectedNode.tabId)
          ? selectedNode
          : null
      : selectedNode?.type === 'tabs_root'
        ? selectedNode
      : selectedNode?.type === 'clamp'
        ? project.clamps.some((clamp) => clamp.id === selectedNode.clampId)
          ? selectedNode
          : null
      : selectedNode?.type === 'clamps_root'
        ? selectedNode
      : selectedNode?.type === 'origin'
        ? selectedNode
      : selectedNode?.type === 'backdrop'
        ? project.backdrop
          ? selectedNode
          : null
      : selectedNode?.type === 'features_root'
        ? selectedNode
      : selectedNode?.type === 'regions_root'
        ? selectedNode
      : selectedNode

  return {
    ...selection,
    mode:
      selectedFeatureIds.length === 1 && selection.selectedNode?.type === 'feature'
        ? selection.mode
        : 'feature',
    selectedFeatureId,
    selectedFeatureIds,
    selectedNode:
      selectedFeatureId
        ? { type: 'feature', featureId: selectedFeatureId }
        : selection.selectedNode?.type === 'feature'
          ? null
          : safeSelectedNode,
    hoveredFeatureId,
    sketchEditTool: selection.mode === 'sketch_edit' ? selection.sketchEditTool : null,
    activeControl: null,
  }
}

function featureById(project: Project, id: string): SketchFeature | null {
  return project.features.find((feature) => feature.id === id) ?? null
}

export function createSelectionSlice(
  set: Parameters<StateCreator<ProjectStore>>[0],
  _get: Parameters<StateCreator<ProjectStore>>[1],
  deps: SelectionSliceDependencies,
): SelectionSlice {
  return {
    selection: emptySelection(),
    sketchEditSession: null,

    selectFeature: (id, additive = false) =>
      set((s) => {
        const joinMode = s.pendingShapeAction?.kind === 'join'
        const cutMode = s.pendingShapeAction?.kind === 'cut'
        const selectedFeature = id ? featureById(s.project, id) : null

        if (joinMode) {
          if (selectedFeature && (!selectedFeature.sketch.profile.closed || selectedFeature.locked)) {
            return {}
          }

          const proposedIds =
            !id
              ? []
              : additive
                ? s.selection.selectedFeatureIds.includes(id)
                  ? s.selection.selectedFeatureIds.filter((featureId) => featureId !== id)
                  : [...s.selection.selectedFeatureIds, id]
                : [id]
          const proposedFeatures = proposedIds
            .map((featureId) => featureById(s.project, featureId))
            .filter((feature): feature is SketchFeature => feature !== null)
          const nextIds = featuresFormConnectedOverlapGroup(proposedFeatures)
            ? proposedIds
            : s.selection.selectedFeatureIds
          const nextPrimaryId = nextIds.at(-1) ?? null

          return {
            pendingOffset: null,
            pendingShapeAction: s.pendingShapeAction ? { ...s.pendingShapeAction, entityIds: nextIds } : null,
            selection: {
              ...s.selection,
              selectedFeatureId: nextPrimaryId,
              selectedFeatureIds: nextIds,
              selectedNode: nextPrimaryId ? { type: 'feature', featureId: nextPrimaryId } : null,
              mode: 'feature',
              activeControl: null,
            },
          }
        }

        if (cutMode) {
          const pendingShapeAction = s.pendingShapeAction
          if (!pendingShapeAction || pendingShapeAction.kind !== 'cut') {
            return {}
          }

          if (selectedFeature && (!selectedFeature.sketch.profile.closed || selectedFeature.locked)) {
            return {}
          }

          if (!id) {
            return {
              pendingOffset: null,
              pendingShapeAction: { ...pendingShapeAction, cutterId: null, targetIds: [] },
              selection: {
                ...s.selection,
                selectedFeatureId: null,
                selectedFeatureIds: [],
                selectedNode: null,
                mode: 'feature',
                activeControl: null,
              },
            }
          }

          if (!pendingShapeAction.cutterId) {
            return {
              pendingOffset: null,
              pendingShapeAction: { ...pendingShapeAction, cutterId: id, targetIds: [] },
              selection: {
                ...s.selection,
                selectedFeatureId: id,
                selectedFeatureIds: [id],
                selectedNode: { type: 'feature', featureId: id },
                mode: 'feature',
                activeControl: null,
              },
            }
          }

          if (id === pendingShapeAction.cutterId) {
            if (additive) {
              return {}
            }
            return {
              pendingOffset: null,
              pendingShapeAction: { ...pendingShapeAction, cutterId: id, targetIds: [] },
              selection: {
                ...s.selection,
                selectedFeatureId: id,
                selectedFeatureIds: [id],
                selectedNode: { type: 'feature', featureId: id },
                mode: 'feature',
                activeControl: null,
              },
            }
          }

          const cutter = featureById(s.project, pendingShapeAction.cutterId)
          if (!cutter || !selectedFeature || !featuresOverlap(cutter, selectedFeature)) {
            return {}
          }

          const nextTargetIds = additive
            ? pendingShapeAction.targetIds.includes(id)
              ? pendingShapeAction.targetIds.filter((featureId) => featureId !== id)
              : [...pendingShapeAction.targetIds, id]
            : [id]
          const nextSelectedIds = [pendingShapeAction.cutterId, ...nextTargetIds]
          const nextPrimaryId = nextTargetIds.at(-1) ?? pendingShapeAction.cutterId

          return {
            pendingOffset: null,
            pendingShapeAction: { ...pendingShapeAction, targetIds: nextTargetIds },
            selection: {
              ...s.selection,
              selectedFeatureId: nextPrimaryId,
              selectedFeatureIds: nextSelectedIds,
              selectedNode: nextPrimaryId ? { type: 'feature', featureId: nextPrimaryId } : null,
              mode: 'feature',
              activeControl: null,
            },
          }
        }

        return {
          pendingOffset: null,
          pendingShapeAction: null,
          selection: {
            ...s.selection,
            ...(id
              ? additive
                ? (() => {
                    const nextIds = s.selection.selectedFeatureIds.includes(id)
                      ? s.selection.selectedFeatureIds.filter((featureId) => featureId !== id)
                      : [...s.selection.selectedFeatureIds, id]
                    const nextPrimaryId =
                      nextIds.length === 0
                        ? null
                        : s.selection.selectedFeatureId === id && s.selection.selectedFeatureIds.includes(id)
                          ? nextIds.at(-1) ?? null
                          : id
                    return {
                      selectedFeatureId: nextPrimaryId,
                      selectedFeatureIds: nextIds,
                      selectedNode: nextPrimaryId ? { type: 'feature', featureId: nextPrimaryId } : null,
                    }
                  })()
                : {
                    selectedFeatureId: id,
                    selectedFeatureIds: [id],
                    selectedNode: { type: 'feature', featureId: id },
                  }
              : {
                  selectedFeatureId: null,
                  selectedFeatureIds: [],
                  selectedNode: null,
                }),
            mode: 'feature',
            activeControl: null,
          },
        }
      }),

    selectFeatures: (ids) =>
      set((s) => {
        const joinMode = s.pendingShapeAction?.kind === 'join'
        const nextIds = ids.filter((id, index) => {
          const feature = featureById(s.project, id)
          if (!feature || ids.indexOf(id) !== index) {
            return false
          }
          return joinMode ? feature.sketch.profile.closed && !feature.locked : true
        })
        const validJoinIds =
          joinMode
            ? (() => {
                const nextFeatures = nextIds
                  .map((id) => featureById(s.project, id))
                  .filter((feature): feature is SketchFeature => feature !== null)
                return featuresFormConnectedOverlapGroup(nextFeatures)
                  ? nextIds
                  : s.selection.selectedFeatureIds
              })()
            : nextIds
        const nextPrimaryId = validJoinIds.at(-1) ?? null

        return {
          pendingOffset: null,
          pendingShapeAction: joinMode && s.pendingShapeAction ? { ...s.pendingShapeAction, entityIds: validJoinIds } : null,
          selection: {
            ...s.selection,
            selectedFeatureId: nextPrimaryId,
            selectedFeatureIds: validJoinIds,
            selectedNode: nextPrimaryId ? { type: 'feature', featureId: nextPrimaryId } : null,
            mode: 'feature',
            activeControl: null,
          },
        }
      }),

    selectProject: () =>
      set((s) => ({
        pendingOffset: null,
        pendingShapeAction: null,
        selection: {
          ...s.selection,
          selectedFeatureId: null,
          selectedFeatureIds: [],
          selectedNode: { type: 'project' },
          mode: 'feature',
          activeControl: null,
        },
        sketchEditSession: null,
      })),

    selectGrid: () =>
      set((s) => ({
        pendingOffset: null,
        pendingShapeAction: null,
        selection: {
          ...s.selection,
          selectedFeatureId: null,
          selectedFeatureIds: [],
          selectedNode: { type: 'grid' },
          mode: 'feature',
        },
        sketchEditSession: null,
      })),

    selectStock: () =>
      set((s) => ({
        pendingOffset: null,
        pendingShapeAction: null,
        selection: {
          ...s.selection,
          selectedFeatureId: null,
          selectedFeatureIds: [],
          selectedNode: { type: 'stock' },
          mode: 'feature',
        },
        sketchEditSession: null,
      })),

    selectOrigin: () =>
      set((s) => ({
        pendingOffset: null,
        pendingShapeAction: null,
        selection: {
          ...s.selection,
          selectedFeatureId: null,
          selectedFeatureIds: [],
          selectedNode: { type: 'origin' },
          mode: 'feature',
          activeControl: null,
        },
        sketchEditSession: null,
      })),

    selectBackdrop: () =>
      set((s) => ({
        pendingOffset: null,
        pendingShapeAction: null,
        selection: {
          ...s.selection,
          selectedFeatureId: null,
          selectedFeatureIds: [],
          selectedNode: { type: 'backdrop' },
          mode: 'feature',
          activeControl: null,
        },
        sketchEditSession: null,
      })),

    selectFeaturesRoot: () =>
      set((s) => ({
        pendingOffset: null,
        selection: {
          ...s.selection,
          selectedFeatureId: null,
          selectedFeatureIds: [],
          selectedNode: { type: 'features_root' },
          mode: 'feature',
          activeControl: null,
        },
        sketchEditSession: null,
      })),

    selectTabsRoot: () =>
      set((s) => ({
        pendingOffset: null,
        selection: {
          ...s.selection,
          selectedFeatureId: null,
          selectedFeatureIds: [],
          selectedNode: { type: 'tabs_root' },
          mode: 'feature',
          activeControl: null,
        },
        sketchEditSession: null,
      })),

    selectRegionsRoot: () =>
      set((s) => ({
        pendingOffset: null,
        selection: {
          ...s.selection,
          selectedFeatureId: null,
          selectedFeatureIds: [],
          selectedNode: { type: 'regions_root' },
          mode: 'feature',
          activeControl: null,
        },
        sketchEditSession: null,
      })),

    selectClampsRoot: () =>
      set((s) => ({
        pendingOffset: null,
        selection: {
          ...s.selection,
          selectedFeatureId: null,
          selectedFeatureIds: [],
          selectedNode: { type: 'clamps_root' },
          mode: 'feature',
          activeControl: null,
        },
        sketchEditSession: null,
      })),

    selectFeatureFolder: (id) =>
      set((s) => ({
        pendingOffset: null,
        selection: {
          ...s.selection,
          selectedFeatureId: null,
          selectedFeatureIds: [],
          selectedNode: { type: 'folder', folderId: id },
          mode: 'feature',
          activeControl: null,
        },
        sketchEditSession: null,
      })),

    selectTab: (id) =>
      set((s) => ({
        pendingOffset: null,
        selection: {
          ...s.selection,
          selectedFeatureId: null,
          selectedFeatureIds: [],
          selectedNode: { type: 'tab', tabId: id },
          mode: 'feature',
          activeControl: null,
        },
        sketchEditSession: null,
      })),

    selectClamp: (id) =>
      set((s) => ({
        pendingOffset: null,
        selection: {
          ...s.selection,
          selectedFeatureId: null,
          selectedFeatureIds: [],
          selectedNode: { type: 'clamp', clampId: id },
          mode: 'feature',
          activeControl: null,
        },
        sketchEditSession: null,
      })),

    hoverFeature: (id) =>
      set((s) => {
        if (s.selection.hoveredFeatureId === id) {
          return {}
        }

        return {
          selection: { ...s.selection, hoveredFeatureId: id },
        }
      }),

    enterSketchEdit: (id) =>
      set((s) => ({
        pendingTransform: null,
        pendingOffset: null,
        selection: {
          ...s.selection,
          selectedFeatureId: id,
          selectedFeatureIds: [id],
          selectedNode: { type: 'feature', featureId: id },
          mode: 'sketch_edit',
          sketchEditTool: null,
          activeControl: null,
        },
        sketchEditSession: {
          entityType: 'feature',
          entityId: id,
          snapshot: deps.cloneProject(s.project),
          pastLength: s.history.past.length,
        },
      })),

    enterClampEdit: (id) =>
      set((s) => ({
        pendingTransform: null,
        pendingOffset: null,
        selection: {
          ...s.selection,
          selectedFeatureId: null,
          selectedFeatureIds: [],
          selectedNode: { type: 'clamp', clampId: id },
          mode: 'sketch_edit',
          sketchEditTool: null,
          activeControl: null,
        },
        sketchEditSession: {
          entityType: 'clamp',
          entityId: id,
          snapshot: deps.cloneProject(s.project),
          pastLength: s.history.past.length,
        },
      })),

    enterTabEdit: (id) =>
      set((s) => ({
        pendingTransform: null,
        pendingOffset: null,
        selection: {
          ...s.selection,
          selectedFeatureId: null,
          selectedFeatureIds: [],
          selectedNode: { type: 'tab', tabId: id },
          mode: 'sketch_edit',
          sketchEditTool: null,
          activeControl: null,
        },
        sketchEditSession: {
          entityType: 'tab',
          entityId: id,
          snapshot: deps.cloneProject(s.project),
          pastLength: s.history.past.length,
        },
      })),

    applySketchEdit: () =>
      set((s) => ({
        selection: { ...s.selection, mode: 'feature', sketchEditTool: null, activeControl: null },
        sketchEditSession: null,
        pendingConstraint: null,
      })),

    cancelSketchEdit: () =>
      set((s) => {
        if (!s.sketchEditSession) {
          return {
            selection: { ...s.selection, mode: 'feature', sketchEditTool: null, activeControl: null },
            sketchEditSession: null,
            pendingConstraint: null,
          }
        }

        const restored = deps.normalizeProject(deps.cloneProject(s.sketchEditSession.snapshot))
        return {
          project: restored,
          selection: {
            ...sanitizeSelection(restored, s.selection),
            mode: 'feature',
            sketchEditTool: null,
            activeControl: null,
          },
          sketchEditSession: null,
          pendingConstraint: null,
          history: {
            past: s.history.past.slice(0, s.sketchEditSession.pastLength),
            future: [],
            transactionStart: null,
          },
        }
      }),

    setSketchEditTool: (tool) =>
      set((s) => ({
        selection: {
          ...s.selection,
          sketchEditTool: s.selection.mode === 'sketch_edit' ? tool : null,
          activeControl: null,
        },
      })),

    setActiveControl: (control) =>
      set((s) => ({
        selection: { ...s.selection, activeControl: control },
      })),
  }
}
