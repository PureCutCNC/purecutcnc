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
import type { ProjectStore, SelectionState } from '../types'
import { cloneProject } from '../helpers/normalize'
import { featuresFormConnectedOverlapGroup, featuresOverlapForCut } from '../helpers/clipping'
import { resolveFeatureInstance, type ResolvedSketchFeature } from '../helpers/resolveFeatures'

export interface SelectionSliceDependencies {
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
  | 'selectConstructionRoot'
  | 'selectTabsRoot'
  | 'selectClampsRoot'
  | 'selectFeatureFolder'
  | 'selectTab'
  | 'selectClamp'
  | 'selectTabs'
  | 'selectClamps'
  | 'selectAllTabs'
  | 'selectAllClamps'
  | 'hoverFeature'
  | 'enterSketchEdit'
  | 'enterClampEdit'
  | 'enterTabEdit'
  | 'applySketchEdit'
  | 'cancelSketchEdit'
  | 'setSketchEditTool'
  | 'setActiveControl'
  | 'setPendingSketchSubject'
  | 'cancelPendingSketchEdit'
>

export function emptySelection(): SelectionState {
  return {
    mode: 'feature',
    selectedFeatureId: null,
    selectedFeatureIds: [],
    selectedTabIds: [],
    selectedClampIds: [],
    selectedNode: null,
    hoveredFeatureId: null,
    sketchEditTool: null,
    activeControl: null,
    groupFolderId: null,
  }
}

/**
 * Centralized selection invariant boundary.
 *
 * - Filters nonexistent IDs from every collection.
 * - Enforces single-family exclusivity: never returns more than one non-empty
 *   family collection (features, tabs, or clamps).
 * - Resolves the family from a valid primary node first; when the primary is
 *   invalid or absent, falls back to any non-empty collection (features first,
 *   then tabs, then clamps).
 * - Preserves valid pending-feature-workflow state where selectedFeatureIds is
 *   non-empty but selectedNode is null.
 * - When given deliberately malformed mixed-family input, resolves
 *   deterministically based on the valid primary family.
 */
export function sanitizeSelection(project: Project, selection: SelectionState): SelectionState {
  const validFeatureIds = selection.selectedFeatureIds.filter((id) =>
    project.features.some((f) => f.id === id),
  )
  const validTabIds = selection.selectedTabIds.filter((id) =>
    project.tabs.some((t) => t.id === id),
  )
  const validClampIds = selection.selectedClampIds.filter((id) =>
    project.clamps.some((c) => c.id === id),
  )

  const primaryNode = selection.selectedNode
  const primaryType = primaryNode?.type

  // Resolve the active family and enforce single-family exclusivity.
  type Family = 'feature' | 'tab' | 'clamp'
  let activeFamily: Family | null = null
  let resolvedFeatureIds: string[] = []
  let resolvedTabIds: string[] = []
  let resolvedClampIds: string[] = []
  let resolvedPrimaryNode: SelectionState['selectedNode'] = null
  let resolvedMode: SelectionState['mode'] = 'feature'

  // 1. If the primary node declares a family AND its corresponding collection
  //    is non-empty, that family is authoritative.
  if (primaryType === 'feature' && validFeatureIds.length > 0) {
    activeFamily = 'feature'
  } else if (primaryType === 'tab' && validTabIds.length > 0) {
    activeFamily = 'tab'
  } else if (primaryType === 'clamp' && validClampIds.length > 0) {
    activeFamily = 'clamp'
  }

  if (activeFamily === 'feature') {
    resolvedFeatureIds = validFeatureIds
    resolvedTabIds = []
    resolvedClampIds = []
    const primaryId =
      selection.selectedFeatureId && validFeatureIds.includes(selection.selectedFeatureId)
        ? selection.selectedFeatureId
        : validFeatureIds.at(-1) ?? null
    resolvedPrimaryNode = primaryId ? { type: 'feature', featureId: primaryId } : null
    // Preserve sketch_edit mode when editing a single feature.
    if (validFeatureIds.length === 1 && primaryNode?.type === 'feature') {
      resolvedMode = selection.mode
    }
  } else if (activeFamily === 'tab') {
    resolvedFeatureIds = []
    resolvedTabIds = validTabIds
    resolvedClampIds = []
    const primaryId =
      primaryNode && primaryNode.type === 'tab' && validTabIds.includes(primaryNode.tabId)
        ? primaryNode.tabId
        : validTabIds.at(-1) ?? null
    resolvedPrimaryNode = primaryId ? { type: 'tab', tabId: primaryId } : null
  } else if (activeFamily === 'clamp') {
    resolvedFeatureIds = []
    resolvedTabIds = []
    resolvedClampIds = validClampIds
    const primaryId =
      primaryNode && primaryNode.type === 'clamp' && validClampIds.includes(primaryNode.clampId)
        ? primaryNode.clampId
        : validClampIds.at(-1) ?? null
    resolvedPrimaryNode = primaryId ? { type: 'clamp', clampId: primaryId } : null
  } else {
    // 2. No valid family primary — fall back to any non-empty collection.
    //    Features have priority; feature IDs with null primary is a valid
    //    pending-workflow state.
    if (validFeatureIds.length > 0) {
      resolvedFeatureIds = validFeatureIds
      resolvedTabIds = []
      resolvedClampIds = []
      // Pending-workflow shape: valid feature IDs but both selectedFeatureId
      // and selectedNode are null.  Preserve that shape — do NOT promote it
      // into an ordinary feature-primary selection.
      if (selection.selectedFeatureId === null && selection.selectedNode === null) {
        resolvedPrimaryNode = null
      } else {
        const primaryId =
          selection.selectedFeatureId && validFeatureIds.includes(selection.selectedFeatureId)
            ? selection.selectedFeatureId
            : validFeatureIds.at(-1) ?? null
        resolvedPrimaryNode = primaryId ? { type: 'feature', featureId: primaryId } : null
      }
    } else if (validTabIds.length > 0) {
      resolvedTabIds = validTabIds
      resolvedClampIds = []
      const primaryId = validTabIds.at(-1) ?? null
      resolvedPrimaryNode = primaryId ? { type: 'tab', tabId: primaryId } : null
    } else if (validClampIds.length > 0) {
      resolvedClampIds = validClampIds
      const primaryId = validClampIds.at(-1) ?? null
      resolvedPrimaryNode = primaryId ? { type: 'clamp', clampId: primaryId } : null
    } else {
      // 3. Nothing valid — validate and keep the non-family node, or null.
      resolvedPrimaryNode = validateNonFamilyNode(project, primaryNode)
    }
  }

  const hoveredFeatureId =
    selection.hoveredFeatureId && project.features.some((f) => f.id === selection.hoveredFeatureId)
      ? selection.hoveredFeatureId
      : null

  return {
    mode: resolvedMode,
    selectedFeatureId:
      resolvedPrimaryNode?.type === 'feature' ? resolvedPrimaryNode.featureId : null,
    selectedFeatureIds: resolvedFeatureIds,
    selectedTabIds: resolvedTabIds,
    selectedClampIds: resolvedClampIds,
    selectedNode: resolvedPrimaryNode,
    hoveredFeatureId,
    sketchEditTool: resolvedMode === 'sketch_edit' ? selection.sketchEditTool : null,
    activeControl: null,
    groupFolderId:
      selection.groupFolderId && resolvedPrimaryNode?.type === 'feature'
        ? selection.groupFolderId
        : null,
  }
}

/** Validate a non-family selectedNode (folder, root, backdrop, etc.) against the project. */
function validateNonFamilyNode(
  project: Project,
  node: SelectionState['selectedNode'],
): SelectionState['selectedNode'] {
  if (!node) return null
  switch (node.type) {
    case 'folder':
      return project.featureFolders.some((f) => f.id === node.folderId) ? node : null
    case 'tab':
      return project.tabs.some((t) => t.id === node.tabId) ? node : null
    case 'clamp':
      return project.clamps.some((c) => c.id === node.clampId) ? node : null
    case 'backdrop':
      return project.backdrop ? node : null
    case 'project':
    case 'grid':
    case 'stock':
    case 'origin':
    case 'features_root':
    case 'regions_root':
    case 'construction_root':
    case 'tabs_root':
    case 'clamps_root':
      return node
    default:
      return null
  }
}

function featureById(project: Project, id: string): ResolvedSketchFeature | null {
  return resolveFeatureInstance(project, id)
}

export function createSelectionSlice(
  set: Parameters<StateCreator<ProjectStore>>[0],
  _get: Parameters<StateCreator<ProjectStore>>[1],
  deps: SelectionSliceDependencies,
): SelectionSlice {
  return {
    selection: emptySelection(),
    sketchEditSession: null,

    selectFeature: (id, additive = false, expandGroup = true) =>
      set((s) => {
        const joinMode = s.pendingShapeAction?.kind === 'join'
        const cutMode = s.pendingShapeAction?.kind === 'cut'
        const selectedFeature = id ? featureById(s.project, id) : null

        if (joinMode) {
          if (selectedFeature && (!selectedFeature.sketch.profile.closed || selectedFeature.locked)) {
            return {}
          }

          const existingIds = s.pendingShapeAction?.kind === 'join' ? s.pendingShapeAction.entityIds : []
          const proposedIds =
            !id
              ? []
              : additive
                ? existingIds.includes(id)
                  ? existingIds.filter((featureId) => featureId !== id)
                  : [...existingIds, id]
                : existingIds.length === 0
                  ? [id]
                  : existingIds.includes(id)
                    ? existingIds
                    : [...existingIds, id]
          const proposedFeatures = proposedIds
            .map((featureId) => featureById(s.project, featureId))
            .filter((feature): feature is ResolvedSketchFeature => feature !== null)
          const nextIds = featuresFormConnectedOverlapGroup(proposedFeatures)
            ? proposedIds
            : existingIds
          const nextPrimaryId = nextIds.at(-1) ?? null

          return {
            pendingOffset: null,
            pendingShapeAction: s.pendingShapeAction ? { ...s.pendingShapeAction, entityIds: nextIds } : null,
            selection: {
              ...s.selection,
              selectedFeatureId: nextPrimaryId,
              selectedFeatureIds: nextIds,
              selectedTabIds: [],
              selectedClampIds: [],
              selectedNode: nextPrimaryId ? { type: 'feature', featureId: nextPrimaryId } : null,
              mode: 'feature',
              activeControl: null,
              groupFolderId: null,
            },
          }
        }

        if (cutMode) {
          const pendingShapeAction = s.pendingShapeAction
          if (!pendingShapeAction || pendingShapeAction.kind !== 'cut') {
            return {}
          }

          if (selectedFeature && selectedFeature.locked) {
            return {}
          }
          // Open features as targets are only allowed when at least one
          // selected cutter is closed (Clipper only supports trimming open
          // paths against closed clips, and an open cutter intersecting an
          // open target is geometrically degenerate).
          if (selectedFeature && pendingShapeAction.phase !== 'cutters' && !selectedFeature.sketch.profile.closed) {
            const hasClosedCutter = pendingShapeAction.cutterIds.some((cId) => {
              const f = featureById(s.project, cId)
              return f !== null && f.sketch.profile.closed
            })
            if (!hasClosedCutter) return {}
          }

          if (!id) {
            if (pendingShapeAction.phase === 'cutters') {
              return {
                pendingOffset: null,
                pendingShapeAction: { ...pendingShapeAction, cutterIds: [], targetIds: [] },
                selection: {
                  ...s.selection,
                  selectedFeatureId: null,
                  selectedFeatureIds: [],
                  selectedTabIds: [],
                  selectedClampIds: [],
                  selectedNode: null,
                  mode: 'feature',
                  activeControl: null,
                  groupFolderId: null,
                },
              }
            }
            return {
              pendingOffset: null,
              pendingShapeAction: { ...pendingShapeAction, targetIds: [] },
              selection: {
                ...s.selection,
                selectedFeatureId: null,
                selectedFeatureIds: [...pendingShapeAction.cutterIds],
                selectedTabIds: [],
                selectedClampIds: [],
                selectedNode: null,
                mode: 'feature',
                activeControl: null,
                groupFolderId: null,
              },
            }
          }

          if (pendingShapeAction.phase === 'cutters') {
            const nextCutterIds = additive
              ? pendingShapeAction.cutterIds.includes(id)
                ? pendingShapeAction.cutterIds.filter((cId) => cId !== id)
                : [...pendingShapeAction.cutterIds, id]
              : [id]
            return {
              pendingOffset: null,
              pendingShapeAction: { ...pendingShapeAction, cutterIds: nextCutterIds, targetIds: [] },
              selection: {
                ...s.selection,
                selectedFeatureId: id,
                selectedFeatureIds: nextCutterIds,
                selectedTabIds: [],
                selectedClampIds: [],
                selectedNode: { type: 'feature', featureId: id },
                mode: 'feature',
                activeControl: null,
                groupFolderId: null,
              },
            }
          }

          if (pendingShapeAction.cutterIds.includes(id)) {
            return {}
          }

          const cutters = pendingShapeAction.cutterIds
            .map((cId) => featureById(s.project, cId))
            .filter((f): f is ResolvedSketchFeature => f !== null)
          if (!selectedFeature || !cutters.some((cutter) => featuresOverlapForCut(selectedFeature, cutter))) {
            return {}
          }

          const nextTargetIds = additive
            ? pendingShapeAction.targetIds.includes(id)
              ? pendingShapeAction.targetIds.filter((featureId) => featureId !== id)
              : [...pendingShapeAction.targetIds, id]
            : [id]
          const nextSelectedIds = [...pendingShapeAction.cutterIds, ...nextTargetIds]
          const nextPrimaryId = nextTargetIds.at(-1) ?? pendingShapeAction.cutterIds.at(-1) ?? null

          return {
            pendingOffset: null,
            pendingShapeAction: { ...pendingShapeAction, targetIds: nextTargetIds },
            selection: {
              ...s.selection,
              selectedFeatureId: nextPrimaryId,
              selectedFeatureIds: nextSelectedIds,
              selectedTabIds: [],
              selectedClampIds: [],
              selectedNode: nextPrimaryId ? { type: 'feature', featureId: nextPrimaryId } : null,
              mode: 'feature',
              activeControl: null,
              groupFolderId: null,
            },
          }
        }

        // Guard: incompatible additive from a different family is a true no-op.
        // Determine the active family from the selected ID collections as well as
        // the primary node, because pending workflows can legitimately have
        // feature IDs with selectedNode: null.
        if (additive && id) {
          const nodeType = s.selection.selectedNode?.type
          const hasTabSelection = s.selection.selectedTabIds.length > 0
          const hasClampSelection = s.selection.selectedClampIds.length > 0
          if (
            nodeType === 'tab' ||
            nodeType === 'tabs_root' ||
            nodeType === 'clamp' ||
            nodeType === 'clamps_root' ||
            hasTabSelection ||
            hasClampSelection
          ) {
            return {}
          }
        }

        return {
          pendingOffset: null,
          pendingShapeAction: null,
          selection: {
            ...s.selection,
            selectedTabIds: [],
            selectedClampIds: [],
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
                      groupFolderId: null,
                    }
                  })()
                : (() => {
                    const feature = featureById(s.project, id)
                    const folderId = feature?.folderId
                    const folder = folderId ? s.project.featureFolders.find((f) => f.id === folderId) : undefined
                    if (expandGroup && folder && (folder.grouped ?? false)) {
                      const ids = s.project.features
                        .filter((f) => f.folderId === folderId)
                        .map((f) => f.id)
                      const primaryId = ids.at(-1) ?? null
                      return {
                        selectedFeatureId: primaryId,
                        selectedFeatureIds: ids,
                        selectedNode: primaryId ? { type: 'feature', featureId: primaryId } : null,
                        groupFolderId: folderId,
                      }
                    }
                    return {
                      selectedFeatureId: id,
                      selectedFeatureIds: [id],
                      selectedNode: { type: 'feature', featureId: id },
                      groupFolderId: null,
                    }
                  })()
              : {
                  selectedFeatureId: null,
                  selectedFeatureIds: [],
                  selectedNode: null,
                  groupFolderId: null,
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
                  .filter((feature): feature is ResolvedSketchFeature => feature !== null)
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
            selectedTabIds: [],
            selectedClampIds: [],
            selectedFeatureId: nextPrimaryId,
            selectedFeatureIds: validJoinIds,
            selectedNode: nextPrimaryId ? { type: 'feature', featureId: nextPrimaryId } : null,
            mode: 'feature',
            activeControl: null,
            groupFolderId: null,
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
          selectedTabIds: [],
          selectedClampIds: [],
          selectedNode: { type: 'project' },
          mode: 'feature',
          activeControl: null,
          groupFolderId: null,
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
          selectedTabIds: [],
          selectedClampIds: [],
          selectedNode: { type: 'grid' },
          mode: 'feature',
          groupFolderId: null,
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
          selectedTabIds: [],
          selectedClampIds: [],
          selectedNode: { type: 'stock' },
          mode: 'feature',
          groupFolderId: null,
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
          selectedTabIds: [],
          selectedClampIds: [],
          selectedNode: { type: 'origin' },
          mode: 'feature',
          activeControl: null,
          groupFolderId: null,
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
          selectedTabIds: [],
          selectedClampIds: [],
          selectedNode: { type: 'backdrop' },
          mode: 'feature',
          activeControl: null,
          groupFolderId: null,
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
          selectedTabIds: [],
          selectedClampIds: [],
          selectedNode: { type: 'features_root' },
          mode: 'feature',
          activeControl: null,
          groupFolderId: null,
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
          selectedTabIds: [],
          selectedClampIds: [],
          selectedNode: { type: 'tabs_root' },
          mode: 'feature',
          activeControl: null,
          groupFolderId: null,
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
          selectedTabIds: [],
          selectedClampIds: [],
          selectedNode: { type: 'regions_root' },
          mode: 'feature',
          activeControl: null,
          groupFolderId: null,
        },
        sketchEditSession: null,
      })),

    selectConstructionRoot: () =>
      set((s) => ({
        pendingOffset: null,
        selection: {
          ...s.selection,
          selectedFeatureId: null,
          selectedFeatureIds: [],
          selectedTabIds: [],
          selectedClampIds: [],
          selectedNode: { type: 'construction_root' },
          mode: 'feature',
          activeControl: null,
          groupFolderId: null,
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
          selectedTabIds: [],
          selectedClampIds: [],
          selectedNode: { type: 'clamps_root' },
          mode: 'feature',
          activeControl: null,
          groupFolderId: null,
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
          selectedTabIds: [],
          selectedClampIds: [],
          selectedNode: { type: 'folder', folderId: id },
          mode: 'feature',
          activeControl: null,
          groupFolderId: null,
        },
        sketchEditSession: null,
      })),

    selectTab: (id, additive = false) =>
      set((s) => {
        const tabExists = s.project.tabs.some((tab) => tab.id === id)
        if (!tabExists) {
          return {}
        }

        // Incompatible additive attempt — current family is not tabs.
        // Determine the active family from all three selected ID collections plus
        // the primary node (a pending workflow may have feature/clamp IDs with a
        // null primary).
        if (additive) {
          const nodeType = s.selection.selectedNode?.type
          const isFeatureNode =
            nodeType === 'feature' || nodeType === 'features_root' ||
            nodeType === 'regions_root' || nodeType === 'construction_root' ||
            nodeType === 'folder'
          const isClampNode = nodeType === 'clamp' || nodeType === 'clamps_root'
          const hasFeatureIds = s.selection.selectedFeatureIds.length > 0
          const hasClampIds = s.selection.selectedClampIds.length > 0
          if (isFeatureNode || isClampNode || hasFeatureIds || hasClampIds) {
            return {}
          }
        }

        if (additive) {
          const nextIds = s.selection.selectedTabIds.includes(id)
            ? s.selection.selectedTabIds.filter((tabId) => tabId !== id)
            : [...s.selection.selectedTabIds, id]
          const wasSelected = s.selection.selectedTabIds.includes(id)
          const nextPrimaryId =
            nextIds.length === 0
              ? null
              : wasSelected
                ? (s.selection.selectedNode?.type === 'tab' && s.selection.selectedNode.tabId === id
                    ? nextIds.at(-1) ?? null
                    : s.selection.selectedNode?.type === 'tab'
                      ? s.selection.selectedNode.tabId
                      : nextIds.at(-1) ?? null)
                : id
          return {
            pendingOffset: null,
            selection: {
              ...s.selection,
              selectedFeatureId: null,
              selectedFeatureIds: [],
              selectedTabIds: nextIds,
              selectedClampIds: [],
              selectedNode: nextPrimaryId ? { type: 'tab', tabId: nextPrimaryId } : null,
              mode: 'feature',
              activeControl: null,
              groupFolderId: null,
            },
            sketchEditSession: null,
          }
        }

        return {
          pendingOffset: null,
          selection: {
            ...s.selection,
            selectedFeatureId: null,
            selectedFeatureIds: [],
            selectedTabIds: [id],
            selectedClampIds: [],
            selectedNode: { type: 'tab', tabId: id },
            mode: 'feature',
            activeControl: null,
            groupFolderId: null,
          },
          sketchEditSession: null,
        }
      }),

    selectClamp: (id, additive = false) =>
      set((s) => {
        const clampExists = s.project.clamps.some((clamp) => clamp.id === id)
        if (!clampExists) {
          return {}
        }

        // Incompatible additive attempt — current family is not clamps.
        // Determine the active family from all three selected ID collections plus
        // the primary node (a pending workflow may have feature/tab IDs with a
        // null primary).
        if (additive) {
          const nodeType = s.selection.selectedNode?.type
          const isFeatureNode =
            nodeType === 'feature' || nodeType === 'features_root' ||
            nodeType === 'regions_root' || nodeType === 'construction_root' ||
            nodeType === 'folder'
          const isTabNode = nodeType === 'tab' || nodeType === 'tabs_root'
          const hasFeatureIds = s.selection.selectedFeatureIds.length > 0
          const hasTabIds = s.selection.selectedTabIds.length > 0
          if (isFeatureNode || isTabNode || hasFeatureIds || hasTabIds) {
            return {}
          }
        }

        if (additive) {
          const nextIds = s.selection.selectedClampIds.includes(id)
            ? s.selection.selectedClampIds.filter((clampId) => clampId !== id)
            : [...s.selection.selectedClampIds, id]
          const wasSelected = s.selection.selectedClampIds.includes(id)
          const nextPrimaryId =
            nextIds.length === 0
              ? null
              : wasSelected
                ? (s.selection.selectedNode?.type === 'clamp' && s.selection.selectedNode.clampId === id
                    ? nextIds.at(-1) ?? null
                    : s.selection.selectedNode?.type === 'clamp'
                      ? s.selection.selectedNode.clampId
                      : nextIds.at(-1) ?? null)
                : id
          return {
            pendingOffset: null,
            selection: {
              ...s.selection,
              selectedFeatureId: null,
              selectedFeatureIds: [],
              selectedTabIds: [],
              selectedClampIds: nextIds,
              selectedNode: nextPrimaryId ? { type: 'clamp', clampId: nextPrimaryId } : null,
              mode: 'feature',
              activeControl: null,
              groupFolderId: null,
            },
            sketchEditSession: null,
          }
        }

        return {
          pendingOffset: null,
          selection: {
            ...s.selection,
            selectedFeatureId: null,
            selectedFeatureIds: [],
            selectedTabIds: [],
            selectedClampIds: [id],
            selectedNode: { type: 'clamp', clampId: id },
            mode: 'feature',
            activeControl: null,
            groupFolderId: null,
          },
          sketchEditSession: null,
        }
      }),

    selectTabs: (ids) =>
      set((s) => {
        const nextIds = ids.filter((id, index) => {
          return ids.indexOf(id) === index && s.project.tabs.some((tab) => tab.id === id)
        })
        const nextPrimaryId = nextIds.at(-1) ?? null
        return {
          pendingOffset: null,
          selection: {
            ...s.selection,
            selectedFeatureId: null,
            selectedFeatureIds: [],
            selectedTabIds: nextIds,
            selectedClampIds: [],
            selectedNode: nextPrimaryId ? { type: 'tab', tabId: nextPrimaryId } : null,
            mode: 'feature',
            activeControl: null,
            groupFolderId: null,
          },
        }
      }),

    selectClamps: (ids) =>
      set((s) => {
        const nextIds = ids.filter((id, index) => {
          return ids.indexOf(id) === index && s.project.clamps.some((clamp) => clamp.id === id)
        })
        const nextPrimaryId = nextIds.at(-1) ?? null
        return {
          pendingOffset: null,
          selection: {
            ...s.selection,
            selectedFeatureId: null,
            selectedFeatureIds: [],
            selectedTabIds: [],
            selectedClampIds: nextIds,
            selectedNode: nextPrimaryId ? { type: 'clamp', clampId: nextPrimaryId } : null,
            mode: 'feature',
            activeControl: null,
            groupFolderId: null,
          },
        }
      }),

    selectAllTabs: () =>
      set((s) => {
        const visibleIds = s.project.tabs.filter((tab) => tab.visible).map((tab) => tab.id)
        const nextPrimaryId = visibleIds.at(-1) ?? null
        return {
          pendingOffset: null,
          selection: {
            ...s.selection,
            selectedFeatureId: null,
            selectedFeatureIds: [],
            selectedTabIds: visibleIds,
            selectedClampIds: [],
            selectedNode: nextPrimaryId ? { type: 'tab', tabId: nextPrimaryId } : null,
            mode: 'feature',
            activeControl: null,
            groupFolderId: null,
          },
          sketchEditSession: null,
        }
      }),

    selectAllClamps: () =>
      set((s) => {
        const visibleIds = s.project.clamps.filter((clamp) => clamp.visible).map((clamp) => clamp.id)
        const nextPrimaryId = visibleIds.at(-1) ?? null
        return {
          pendingOffset: null,
          selection: {
            ...s.selection,
            selectedFeatureId: null,
            selectedFeatureIds: [],
            selectedTabIds: [],
            selectedClampIds: visibleIds,
            selectedNode: nextPrimaryId ? { type: 'clamp', clampId: nextPrimaryId } : null,
            mode: 'feature',
            activeControl: null,
            groupFolderId: null,
          },
          sketchEditSession: null,
        }
      }),

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
      set((s) => {
        return {
          pendingTransform: null,
          pendingOffset: null,
          selection: {
            ...s.selection,
            selectedFeatureId: id,
            selectedFeatureIds: [id],
            selectedTabIds: [],
            selectedClampIds: [],
            selectedNode: { type: 'feature', featureId: id },
            mode: 'sketch_edit',
            sketchEditTool: null,
            activeControl: null,
            groupFolderId: null,
          },
          sketchEditSession: {
            entityType: 'feature',
            entityId: id,
            snapshot: cloneProject(s.project),
            pastLength: s.history.past.length,
          },
        }
      }),

    enterClampEdit: (id) =>
      set((s) => ({
        pendingTransform: null,
        pendingOffset: null,
        selection: {
          ...s.selection,
          selectedFeatureId: null,
          selectedFeatureIds: [],
          selectedTabIds: [],
          selectedClampIds: [id],
          selectedNode: { type: 'clamp', clampId: id },
          mode: 'sketch_edit',
          sketchEditTool: null,
          activeControl: null,
          groupFolderId: null,
        },
        sketchEditSession: {
          entityType: 'clamp',
          entityId: id,
          snapshot: cloneProject(s.project),
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
          selectedTabIds: [id],
          selectedClampIds: [],
          selectedNode: { type: 'tab', tabId: id },
          mode: 'sketch_edit',
          sketchEditTool: null,
          activeControl: null,
          groupFolderId: null,
        },
        sketchEditSession: {
          entityType: 'tab',
          entityId: id,
          snapshot: cloneProject(s.project),
          pastLength: s.history.past.length,
        },
      })),

    applySketchEdit: () =>
      set((s) => {
        // Check if we were editing a stock source feature (feature temporarily in features)
        const stock = s.project.stock
        if (stock.sourceFeatureId && s.project.features.some((f) => f.id === stock.sourceFeatureId)) {
          // Remove feature from features and featureTree, keep stock as-is (already synced each mutation)
          const nextFeatures = s.project.features.filter((f) => f.id !== stock.sourceFeatureId)
          const nextFeatureTree = s.project.featureTree.filter(
            (entry) => !(entry.type === 'feature' && entry.featureId === stock.sourceFeatureId),
          )

          // Capture the pre-edit snapshot as the undo point so the entire edit session is one atomic step
          const preEditSnapshot = s.sketchEditSession?.snapshot
          const pastLength = s.sketchEditSession?.pastLength ?? s.history.past.length

          return {
            project: {
              ...s.project,
              features: nextFeatures,
              featureTree: nextFeatureTree,
              meta: { ...s.project.meta, modified: new Date().toISOString() },
            },
            selection: { ...s.selection, mode: 'feature', sketchEditTool: null, activeControl: null, groupFolderId: null },
            sketchEditSession: null,
            pendingConstraint: null,
            pendingSketchEdit: null,
            history: {
              // Trim mutations during the edit session, push pre-edit state as the undo point
              past: [
                ...s.history.past.slice(0, pastLength),
                ...(preEditSnapshot ? [preEditSnapshot] : []),
              ].slice(-100),
              future: [],
              transactionStart: null,
            },
          }
        }

        if (s.sketchEditSession?.entityType === 'feature') {
          return {
            selection: { ...s.selection, mode: 'feature', sketchEditTool: null, activeControl: null, groupFolderId: null },
            sketchEditSession: null,
            pendingConstraint: null,
            pendingSketchEdit: null,
          }
        }

        // Normal case: not a stock source feature
        return {
          selection: { ...s.selection, mode: 'feature', sketchEditTool: null, activeControl: null, groupFolderId: null },
          sketchEditSession: null,
          pendingConstraint: null,
          pendingSketchEdit: null,
        }
      }),

    cancelSketchEdit: () =>
      set((s) => {
        if (!s.sketchEditSession) {
          return {
            selection: { ...s.selection, mode: 'feature', sketchEditTool: null, activeControl: null, groupFolderId: null },
            sketchEditSession: null,
            pendingConstraint: null,
            pendingSketchEdit: null,
          }
        }

        const restored = deps.normalizeProject(cloneProject(s.sketchEditSession.snapshot))
        return {
          project: restored,
          selection: {
            ...sanitizeSelection(restored, s.selection),
            mode: 'feature',
            sketchEditTool: null,
            activeControl: null,
            groupFolderId: null,
          },
          sketchEditSession: null,
          pendingConstraint: null,
          pendingSketchEdit: null,
          history: {
            past: s.history.past.slice(0, s.sketchEditSession.pastLength),
            future: [],
            transactionStart: null,
          },
        }
      }),

    setSketchEditTool: (tool) =>
      set((s) => {
        if (s.selection.mode !== 'sketch_edit') {
          return {
            selection: { ...s.selection, sketchEditTool: null, activeControl: null },
            pendingSketchEdit: null,
          }
        }
        // Initialize / clear pendingSketchEdit on tool change. Always reset when
        // switching INTO trim/extend — including trim↔extend — so a stale subject
        // from the previous tool can never be dispatched under the new tool's
        // pending.tool (see useClickPlacement reference-pick dispatch).
        let nextPendingSketchEdit = s.pendingSketchEdit
        if (tool === 'trim' || tool === 'extend') {
          nextPendingSketchEdit = { tool, phase: 'pick-subject' }
        } else {
          nextPendingSketchEdit = null
        }
        return {
          selection: {
            ...s.selection,
            sketchEditTool: tool,
            activeControl: null,
          },
          pendingSketchEdit: nextPendingSketchEdit,
        }
      }),

    setActiveControl: (control) =>
      set((s) => ({
        selection: { ...s.selection, activeControl: control },
      })),

    setPendingSketchSubject: (subject) =>
      set((s) => {
        if (!s.pendingSketchEdit || s.pendingSketchEdit.phase !== 'pick-subject') {
          return {}
        }
        return {
          pendingSketchEdit: {
            ...s.pendingSketchEdit,
            phase: 'pick-reference',
            subject,
          },
        }
      }),

    cancelPendingSketchEdit: () =>
      set((s) => {
        const isTrimExtend =
          s.selection.sketchEditTool === 'trim' || s.selection.sketchEditTool === 'extend'
        if (!s.pendingSketchEdit && !isTrimExtend) return {}
        // Fully deactivate the trim/extend tool so the toolbar button untoggles
        // and we never leave the tool active with a null pending (which would be
        // unusable). Esc and post-operation both flow through here.
        return {
          pendingSketchEdit: null,
          selection: isTrimExtend
            ? { ...s.selection, sketchEditTool: null, activeControl: null }
            : s.selection,
        }
      }),
  }
}
