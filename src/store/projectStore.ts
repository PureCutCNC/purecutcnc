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
import { cloneTextFeatureData } from '../types/project'
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
import { transformProfile } from '../geometry/profile'
import { resolveFeatureInstance } from './helpers/resolveFeatures'
import { aroundSheetAuthoringRefused, featureOperation } from './helpers/activeFace'
import { createPendingAddSlice } from './slices/pendingAddSlice'
import { createPendingActionsSlice } from './slices/pendingActionsSlice'
import { createPendingCompletionSlice } from './slices/pendingCompletionSlice'
import { createFeatureDistributionSlice } from './slices/featureDistributionSlice'
import { createNestingSlice } from './slices/nestingSlice'
import { createTextLayoutSlice } from './slices/textLayoutSlice'
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
import { createSetupsSlice, withGhostSelectionGuard, withSetupSync } from './slices/setupsSlice'
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
import { syncRotaryPatternSurfaceProject } from './helpers/rotarySurface'
export { normalizeProject } from './helpers/projectFormat'
export { toolpathGenerationDeferred } from './slices/nestingSlice'


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

/**
 * Wrap the store's `set` so every project it writes re-measures the Thread and
 * Flutes bands against the surface they lie on (#1112 H2/H3, rt6-c). Deleting,
 * moving, transforming, expanding, making unique, re-parenting or importing a
 * Turn all change which surface a band sits on, so the sync belongs after every
 * write rather than at each action. An unchanged project keeps its identity, so
 * a write that does not touch a surface is not a new history state.
 *
 * A stored span is never an override (rt6-c): every Thread/Flutes span is the
 * derived one, so opening a document measures it too — an old file whose
 * Properties Z was typed by hand gets the depth its surface gives it. Opening,
 * creating or loading a document replaces the project wholesale (`projectKey`
 * moves) and has no previous project to compare against, so the sync is given
 * none and re-derives every row.
 */
function withRotarySurfaceSync(rawSet: SetFn): SetFn {
  return (update) => {
    // Always hand the inner setter a function: only then is the project being
    // replaced still visible, and the sync needs it for the unchanged fast path.
    rawSet((state) => {
      const patch = typeof update === 'function' ? update(state) : update
      if (!patch.project) return patch
      const replaced = patch.projectKey !== undefined && patch.projectKey !== state.projectKey
      const project = syncRotaryPatternSurfaceProject(patch.project, replaced ? undefined : state.project)
      return project === patch.project ? patch : { ...patch, project }
    })
  }
}

export const useProjectStore = create<ProjectStore>((rawSet, get) => {
  // Every project written through `set` has its setups reconciled (#944), no
  // write leaves a feature from the other face selected (#945), and every
  // Thread/Flutes band follows the Turn surface it sits on.
  const wrapSet = (options: { followStockChuck?: boolean }) =>
    withAutoDirty(withRotarySurfaceSync(withSetupSync(withGhostSelectionGuard(rawSet), options)))
  const set = wrapSet({})
  // Undo, redo and a cancelled transaction put a stored snapshot back
  // (#1112 R2 item 23): its equipment is what the operator had, so it is not a
  // stock transition a default chuck follows. Everything else about the write
  // is the same, which is why this is the same pipeline with one option off
  // rather than a separate restore path.
  const setRestored = wrapSet({ followStockChuck: false })
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

    // A split inserts a new row beside the original (issue #1016 C2-U1H). On a
    // square blank the Around sheet is round-only (`aroundSheetAuthoringRefused`),
    // so the split half would be a new Around row no other Around creation path
    // admits: refuse the whole edit here — before `createDerivedFeature`, so the
    // original profile, definitions, tree, selection and history stay untouched —
    // judged by the source row's own face so a Top workspace cannot bypass it.
    // Breaks that stay in place (a closed outline opened, an end segment removed)
    // create no row and remain allowed.
    if (result.splitProfile && aroundSheetAuthoringRefused(s.project, feature.authoringFace ?? 'top', featureOperation(s.project, feature))) {
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
      text: cloneTextFeatureData(feature.text),
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
        selectedTabIds: [],
        selectedClampIds: [],
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
  machineLoadDiagnostics: [],
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
  ...createPendingActionsSlice(set, get),
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
  ...createFeatureDistributionSlice(set, get),
  ...createNestingSlice(set),
  ...createTextLayoutSlice(set, get),
  ...createPendingAddSlice(set, get),
  ...createDimensionsSlice(set, get),
  ...createDimensionToolSlice(set, get),
  ...createToolsSlice(set, get),
  ...createClampsSlice(set, get),
  ...createTabsSlice(set),
  ...createBackdropSlice(set),
  ...createMachineDefsSlice(set),
  ...createOperationsSlice(set, get),
  ...createSetupsSlice(set, get),
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
  ...createHistorySlice(setRestored, get, {
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
