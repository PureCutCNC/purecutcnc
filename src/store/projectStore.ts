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

import { create } from 'zustand'
import { uniqueName } from '../import'
import {
  defaultOrigin,
  defaultMaxTravelZ,
  defaultOperationClearanceZ,
  defaultClampClearanceXY,
  defaultClampClearanceZ,
  getStockBounds,
  inferFeatureKind,
  newProject,
  circleProfile,
} from '../types/project'
import type {
  Project,
  SketchProfile,
  PersistedImportedMesh,
} from '../types/project'
import type { ProfileBreakResult } from './helpers/profileEdit'
import {
  clearStaleConstraints,
  createDerivedFeature,
  insertDerivedFeaturesAfterSources,
  insertDerivedFeatureTreeEntries,
  joinOpenProfiles,
  normalizeDerivedFeatureNameStem,
  previewOffsetFeatures,
  type DerivedFeatureGroup,
} from './helpers/derivedFeatures'
import { syncIdCounter } from './helpers/ids'
import {
  cloneProject,
  dedupeProjectIds,
  normalizeClamp,
  normalizeFeatureZRange,
  normalizeMachineDefinitions,
  normalizeOperation,
  normalizeTab,
  normalizeTool,
  projectsEqual,
  syncFeatureTreeProject,
  syncStockFromSourceFeature,
} from './helpers/normalize'
import {
  transformProfile,
} from './helpers/transform'
import { normalizeImportedModelStorage, pruneUnusedModelAssets } from './helpers/modelAssets'
import { createPendingAddSlice } from './slices/pendingAddSlice'
import { createPendingActionsSlice } from './slices/pendingActionsSlice'
import { createPendingCompletionSlice } from './slices/pendingCompletionSlice'
import { createSelectionSlice, sanitizeSelection } from './slices/selectionSlice'
import { createDimensionsSlice } from './slices/dimensionsSlice'
import { createDimensionToolSlice } from './slices/dimensionToolSlice'
import { createFeatureSlice } from './slices/featureSlice'
import { createFeatureGeometrySlice } from './slices/featureGeometrySlice'
import { createConstraintsSlice } from './slices/constraintsSlice'
import { createTreeVisibilitySlice } from './slices/treeVisibilitySlice'
import { createToolsSlice } from './slices/toolsSlice'
import { createClampsSlice } from './slices/clampsSlice'
import { createTabsSlice } from './slices/tabsSlice'
import { createBackdropSlice, normalizeBackdrop } from './slices/backdropSlice'
import { createMachineDefsSlice } from './slices/machineDefsSlice'
import { createOperationsSlice } from './slices/operationsSlice'
import { createImportMergeSlice } from './slices/importMergeSlice'
import { createProjectLifecycleSlice } from './slices/projectLifecycleSlice'
import { createHistorySlice } from './slices/historySlice'
import { createWorkpieceSlice } from './slices/workpieceSlice'
import {
  propagateConstraintsOnTranslate,
  propagateConstraintsOnRotate,
  validateConstraintsOnFeature,
} from '../sketch/constraintSolver'
import type { ProjectStore } from './types'

export function normalizeProject(project: Project): Project {
  const modelAssets: Record<string, PersistedImportedMesh> = { ...(project.modelAssets ?? {}) }
  // Migration: convert 4-arc circles to native circle segments
  const upgradedFeatures = project.features.map((feature) => {
    let upgradedFeature = feature
    if (feature.kind === 'circle' && feature.sketch.profile.segments.length === 4) {
      const { profile } = feature.sketch
      const firstArc = profile.segments[0]
      if (firstArc.type === 'arc') {
        const cx = firstArc.center.x
        const cy = firstArc.center.y
        const r = Math.hypot(profile.start.x - cx, profile.start.y - cy)
        upgradedFeature = {
          ...feature,
          sketch: {
            ...feature.sketch,
            profile: circleProfile(cx, cy, r),
          },
        }
      }
    }
    // Migration: convert open profiles from 'subtract'/'add' to 'line' operation
    // (projects saved before the 'line' type was introduced)
    if (!feature.sketch.profile.closed && upgradedFeature.operation !== 'line' && upgradedFeature.operation !== 'model' && upgradedFeature.operation !== 'region') {
      upgradedFeature = {
        ...upgradedFeature,
        operation: 'line',
      }
    }
    return {
      ...upgradedFeature,
      stl: normalizeImportedModelStorage(upgradedFeature.id, upgradedFeature.stl, modelAssets),
    }
  })

  const normalizedMachines = normalizeMachineDefinitions(project)
  const meta = {
    ...project.meta,
    showFeatureInfo: project.meta.showFeatureInfo ?? true,
    showDimensions: project.meta.showDimensions ?? true,
    maxTravelZ: project.meta.maxTravelZ ?? defaultMaxTravelZ(project.meta.units),
    operationClearanceZ: project.meta.operationClearanceZ ?? defaultOperationClearanceZ(project.meta.units),
    clampClearanceXY: project.meta.clampClearanceXY ?? defaultClampClearanceXY(project.meta.units),
    clampClearanceZ: project.meta.clampClearanceZ ?? defaultClampClearanceZ(project.meta.units),
    machineDefinitions: normalizedMachines.machineDefinitions,
    selectedMachineId: normalizedMachines.selectedMachineId,
  }

  const stockBounds = getStockBounds(project.stock)
  const legacyDefaultOrigin =
    project.origin
    && project.origin.name === 'Origin'
    && project.origin.x === stockBounds.minX
    && project.origin.y === stockBounds.minY
    && project.origin.z === project.stock.thickness

  const normalizedBase = syncFeatureTreeProject(dedupeProjectIds({
    ...project,
    meta,
    modelAssets,
    annotations: project.annotations ?? [],
    stock: {
      ...project.stock,
      profile: {
        ...project.stock.profile,
        closed: project.stock.profile.closed ?? true,
      },
    },
    features: upgradedFeatures.map(normalizeFeatureZRange),
    featureFolders: project.featureFolders ?? [],
    featureTree: project.featureTree ?? [],
    tools: project.tools.map((tool, index) => normalizeTool(tool, project.meta.units, index)),
    tabs: (project.tabs ?? []).map((tab, index) => normalizeTab(tab, project.meta.units, index)),
    clamps: (project.clamps ?? []).map((clamp, index) => normalizeClamp(clamp, project.meta.units, index)),
    origin: project.origin
      ? (legacyDefaultOrigin ? defaultOrigin(project.stock) : project.origin)
      : defaultOrigin(project.stock),
  }))

  const normalizedProject = pruneUnusedModelAssets({
    ...normalizedBase,
    backdrop: normalizeBackdrop(project.backdrop, normalizedBase),
    operations: project.operations.map((operation, index) => normalizeOperation(operation, normalizedBase, index)),
  })

  syncIdCounter(normalizedProject)
  return normalizedProject
}


// ============================================================
// Store implementation
// ============================================================

// ---------------------------------------------------------------------------
// Auto-dirty helper
// Wraps Zustand's set so any patch that changes `project` also sets
// `dirty: true`, unless the patch explicitly provides a `dirty` value.
// ---------------------------------------------------------------------------
type SetFn = (
  update: Partial<ProjectStore> | ((state: ProjectStore) => Partial<ProjectStore>)
) => void

function withAutoDirty(rawSet: SetFn): SetFn {
  return (update) => {
    if (typeof update === 'function') {
      rawSet((state) => {
        const patch = update(state)
        if ('project' in patch && patch.project !== state.project && !('dirty' in patch)) {
          return { ...patch, dirty: true }
        }
        return patch
      })
    } else {
      if ('project' in update && !('dirty' in update)) {
        rawSet({ ...update, dirty: true })
      } else {
        rawSet(update)
      }
    }
  }
}

export const useProjectStore = create<ProjectStore>((rawSet, get) => {
  const set = withAutoDirty(rawSet)
  const applyProfileBreak = (
    featureId: string,
    resolveBreak: (profile: SketchProfile) => ProfileBreakResult | null,
  ) => set((s) => {
    const feature = s.project.features.find((entry) => entry.id === featureId) ?? null
    if (!feature || feature.locked) {
      return {}
    }

    const result = resolveBreak(feature.sketch.profile)
    if (!result) {
      return {}
    }

    const splitFeature = result.splitProfile
      ? createDerivedFeature(
          s.project,
          feature,
          result.splitProfile,
          feature.operation,
          uniqueName(`${normalizeDerivedFeatureNameStem(feature.name)} Split`, s.project.features.map((entry) => entry.name)),
        )
      : null

    const baseFeatures = s.project.features.map((entry) => {
      if (entry.id !== featureId) {
        return entry
      }

      return {
        ...entry,
        kind: ['text', 'stl'].includes(entry.kind) ? entry.kind : inferFeatureKind(result.profile),
        sketch: {
          ...entry.sketch,
          profile: result.profile,
        },
      }
    })
    const createdGroups: DerivedFeatureGroup[] = splitFeature ? [{ sourceId: featureId, features: [splitFeature] }] : []
    let nextProject = syncFeatureTreeProject({
      ...s.project,
      features: splitFeature
        ? insertDerivedFeaturesAfterSources(baseFeatures, createdGroups, new Set())
        : baseFeatures,
      featureTree: splitFeature
        ? insertDerivedFeatureTreeEntries(s.project.featureTree, baseFeatures, createdGroups, new Set())
        : s.project.featureTree,
      meta: { ...s.project.meta, modified: new Date().toISOString() },
    })

    nextProject = syncStockFromSourceFeature(nextProject, featureId)
    if (projectsEqual(nextProject, s.project)) {
      return {}
    }

    return {
      project: nextProject,
      selection: {
        ...s.selection,
        selectedFeatureId: featureId,
        selectedFeatureIds: [featureId],
        selectedNode: { type: 'feature' as const, featureId },
        activeControl: null,
      },
      history: s.history.transactionStart
        ? s.history
        : {
            past: [...s.history.past, cloneProject(s.project)].slice(-100),
            future: [],
            transactionStart: null,
          },
    }
  })

  return {
  project: normalizeProject(newProject()),
  creationTarget: 'feature',
  backdropImageLoading: false,
  filePath: null,
  lastExportPath: null,
  lastModelExportPath: null,
  dirty: false,
  projectLoading: false,
  projectKey: 0,
  pendingConstraint: null,
  history: {
    past: [],
    future: [],
    transactionStart: null,
  },
  ...createSelectionSlice(set, get, {
    normalizeProject,
  }),
  ...createPendingActionsSlice(set),
  ...createPendingCompletionSlice(set, get, {
    clearStaleConstraints,
    propagateConstraintsOnTranslate: (features, offsets) =>
      propagateConstraintsOnTranslate(features, offsets, { transformProfile }),
    propagateConstraintsOnRotate: (features, rotations) =>
      propagateConstraintsOnRotate(features, rotations, { transformProfile }),
    validateAllConstraints: (features) => {
      const byId = new Map(features.map((f) => [f.id, f]))
      return features.map((f) => {
        if (f.sketch.constraints.every((c) => c.type !== 'fixed_distance')) return f
        return validateConstraintsOnFeature(f, byId)
      })
    },
    previewOffsetFeatures,
    createDerivedFeature,
  }),
  ...createPendingAddSlice(set, get),
  ...createDimensionsSlice(set, get),
  ...createDimensionToolSlice(set, get),
  ...createToolsSlice(set, get),
  ...createClampsSlice(set, get),
  ...createTabsSlice(set),
  ...createBackdropSlice(set),
  ...createMachineDefsSlice(set),
  ...createOperationsSlice(set, get),
  ...createImportMergeSlice(set, get),
  ...createFeatureSlice(set, get),
  ...createFeatureGeometrySlice(set, get, {
    joinOpenProfiles,
    inferFeatureKind,
    clearStaleConstraints,
    applyProfileBreak,
  }),
  ...createConstraintsSlice(set),
  ...createTreeVisibilitySlice(set),
  ...createProjectLifecycleSlice(set, get, {
    rawSet,
    normalizeProject,
  }),
  ...createHistorySlice(set, get, {
    normalizeProject,
  }),
  ...createWorkpieceSlice(set),

  }
})

const repairedInitialProject = normalizeProject(useProjectStore.getState().project)
if (!projectsEqual(repairedInitialProject, useProjectStore.getState().project)) {
  useProjectStore.setState((state) => ({
    project: repairedInitialProject,
    selection: sanitizeSelection(repairedInitialProject, state.selection),
  }))
}
