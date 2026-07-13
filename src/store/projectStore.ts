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
  inferFeatureKind,
  newProject,
} from '../types/project'
import type {
  FeatureInstance,
  SketchProfile,
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
import { createFeatureInstance, getDefinitionId } from './helpers/featureDefinitions'
import {
  cloneProject,
  projectsEqual,
  syncFeatureTreeProject,
  syncFeatureBasedStock,
} from './helpers/normalize'
import {
  transformProfile,
} from './helpers/transform'
import { resolveFeatureInstance } from './helpers/resolveFeatures'
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
import { createBackdropSlice } from './slices/backdropSlice'
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
import { normalizeProject } from './helpers/projectFormat'
export { normalizeProject } from './helpers/projectFormat'


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
    const featureInstance = s.project.features.find((entry) => entry.id === featureId) ?? null
    const feature = resolveFeatureInstance(s.project, featureId)
    if (!featureInstance || !feature || featureInstance.locked) {
      return {}
    }

    const definitionId = getDefinitionId(featureInstance)
    const definition = s.project.featureDefinitions[definitionId]
    if (!definition) {
      return {}
    }

    const result = resolveBreak(definition.profile)
    if (!result) {
      return {}
    }

    const splitResult = result.splitProfile
      ? createDerivedFeature(
          s.project,
          feature,
          result.splitProfile,
          feature.operation,
          uniqueName(`${normalizeDerivedFeatureNameStem(feature.name)} Split`, s.project.features.map((entry) => entry.name)),
        )
      : null
    const splitFeature = splitResult?.feature ?? null
    const splitDefinition = splitResult?.definition ?? null
    const splitInstance = splitFeature && splitDefinition
      ? createFeatureInstance(splitFeature, splitDefinition.id)
      : null

    const editedFeatureKind = ['text', 'stl'].includes(feature.kind) ? feature.kind : inferFeatureKind(result.profile)
    const nextDefinition = {
      ...definition,
      kind: editedFeatureKind,
      profile: result.profile,
      dimensions: feature.sketch.dimensions.map((dimension) => ({ ...dimension })),
      text: feature.text ? { ...feature.text } : null,
      stl: feature.stl ? { ...feature.stl } : null,
      operation: feature.operation,
    }
    const nextDefinitions = {
      ...s.project.featureDefinitions,
      [definitionId]: nextDefinition,
    }
    if (splitDefinition) {
      nextDefinitions[splitDefinition.id] = splitDefinition
    }
    const baseFeatures = s.project.features
    const createdGroups: Array<DerivedFeatureGroup<FeatureInstance>> = splitInstance
      ? [{ sourceId: featureId, features: [splitInstance] }]
      : []
    let nextProject = syncFeatureTreeProject({
      ...s.project,
      featureDefinitions: nextDefinitions,
      features: splitInstance
        ? insertDerivedFeaturesAfterSources(baseFeatures, createdGroups, new Set())
        : baseFeatures,
      featureTree: splitInstance
        ? insertDerivedFeatureTreeEntries(s.project.featureTree, baseFeatures, createdGroups, new Set())
        : s.project.featureTree,
      meta: { ...s.project.meta, modified: new Date().toISOString() },
    })

    nextProject = syncFeatureBasedStock(nextProject)
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
  loadWarning: null,
  projectKey: 0,
  pendingConstraint: null,
  pendingSketchEdit: null,
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
