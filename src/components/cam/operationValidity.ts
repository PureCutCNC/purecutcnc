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

/**
 * Operation validity helpers shared between the CAM panel's "Add operation"
 * buttons and the feature-local "Quick Operation" context-menu actions.
 *
 * `getOperationAddHint` is the single source of truth for "can this operation
 * kind be created from the current selection?": it returns `null` when the
 * operation is valid, or a human-readable reason string when it is not. It was
 * extracted verbatim from `CAMPanel.tsx` so the panel's hints are unchanged.
 */

import type { SelectionState } from '../../store/types'
import type { Operation, OperationKind, OperationPass, Project } from '../../types/project'
import { isConstruction, isMachinable, isRegion } from '../../store/helpers/featureRoles'
import { isVCarveCompatibleFeature } from '../../store/helpers/vcarveTargets'
import { featureHasClosedGeometry } from '../../text'
import { resolvedFeatureMap, type ResolvedSketchFeature } from '../../store/helpers/resolveFeatures'
import { camT } from './camI18n'

type ResolvedFeatureMap = ReadonlyMap<string, ResolvedSketchFeature>

export function operationKindLabel(kind: OperationKind): string {
  switch (kind) {
    case 'pocket':
      return camT('cam.opLabel.pocket')
    case 'v_carve':
      return camT('cam.opLabel.vCarve')
    case 'v_carve_medial':
      return camT('cam.opLabel.vCarveMedial')
    case 'edge_route_inside':
      return camT('cam.opLabel.edgeRouteInside')
    case 'edge_route_outside':
      return camT('cam.opLabel.edgeRouteOutside')
    case 'surface_clean':
      return camT('cam.opLabel.surfaceClean')
    case 'rough_surface':
      return camT('cam.opLabel.roughSurface')
    case 'finish_surface':
      return camT('cam.opLabel.finishSurface')
    case 'finish_surface_cleanup':
      return camT('cam.opLabel.finishSurfaceCleanup')
    case 'follow_line':
      return camT('cam.opLabel.followLine')
    case 'drilling':
      return camT('cam.opLabel.drilling')
    default:
      return 'Unknown'
  }
}

export function operationRequiresClosedProfiles(kind: OperationKind): boolean {
  return kind === 'pocket' || kind === 'v_carve' || kind === 'v_carve_medial' || kind === 'edge_route_inside' || kind === 'edge_route_outside' || kind === 'surface_clean'
}

function emptySelectionHint(kind: OperationKind): string {
  switch (kind) {
    case 'drilling':
      return camT('cam.hint.empty.drilling')
    case 'follow_line':
      return camT('cam.hint.empty.followLine')
    case 'surface_clean':
      return camT('cam.hint.empty.surfaceClean')
    case 'v_carve':
    case 'v_carve_medial':
      return camT('cam.hint.empty.vCarve')
    case 'rough_surface':
    case 'finish_surface':
    case 'finish_surface_cleanup':
      return camT('cam.hint.empty.roughSurface')
    default:
      return camT('cam.hint.empty.default')
  }
}

export function getOperationAddHint(
  project: Project,
  selection: SelectionState,
  kind: OperationKind,
): string | null {
  if (selection.selectedFeatureIds.length === 0) {
    return emptySelectionHint(kind)
  }

  return getOperationAddHintWithMap(selection, kind, resolvedFeatureMap(project))
}

function getOperationAddHintWithMap(
  selection: SelectionState,
  kind: OperationKind,
  featureById: ResolvedFeatureMap,
): string | null {
  // Construction geometry is sketch-only reference geometry — it can never be
  // an operation target, so any selection containing it is rejected up front
  // with one clear message (issue #199).
  if (selection.selectedFeatureIds.some((featureId) => {
    const feature = featureById.get(featureId)
    return feature !== undefined && isConstruction(feature)
  })) {
    return camT('cam.hint.construction')
  }

  if (kind === 'drilling') {
    const features = selection.selectedFeatureIds
      .map((featureId) => featureById.get(featureId))
      .filter((feature): feature is ResolvedSketchFeature => feature !== undefined)

    const machiningFeatures = features.filter(isMachinable)
    const regionFeatures = features.filter(isRegion)
    return machiningFeatures.length > 0
      && machiningFeatures.every((feature) => feature.kind === 'circle')
      && regionFeatures.every((feature) => featureHasClosedGeometry(feature))
      ? null
      : camT('cam.hint.drilling')
  }

  if (kind === 'follow_line') {
    const features = selection.selectedFeatureIds
      .map((featureId) => featureById.get(featureId))
      .filter((feature): feature is ResolvedSketchFeature => feature !== undefined)
    const machiningFeatures = features.filter(isMachinable)
    const regionFeatures = features.filter(isRegion)
    return machiningFeatures.length > 0 && regionFeatures.every((feature) => featureHasClosedGeometry(feature))
      ? null
      : camT('cam.hint.followLine')
  }

  if (kind === 'surface_clean') {
    const features = selection.selectedFeatureIds
      .map((featureId) => featureById.get(featureId))
      .filter((feature): feature is ResolvedSketchFeature => feature !== undefined)

    const machiningFeatures = features.filter(isMachinable)
    const regionFeatures = features.filter(isRegion)
    if (machiningFeatures.length === 0) {
      return camT('cam.hint.surfaceCleanNoFeature')
    }
    if (!machiningFeatures.every((feature) => feature.operation === 'add' || feature.operation === 'model')) {
      return camT('cam.hint.surfaceCleanWrongOp')
    }
    if (!regionFeatures.every((feature) => featureHasClosedGeometry(feature))) {
      return camT('cam.hint.regionNotClosed')
    }

    return machiningFeatures.every((feature) => featureHasClosedGeometry(feature))
      ? null
      : camT('cam.hint.surfaceCleanClosedOnly')
  }

  if (kind === 'v_carve' || kind === 'v_carve_medial') {
    const features = selection.selectedFeatureIds
      .map((featureId) => featureById.get(featureId))
      .filter((feature): feature is ResolvedSketchFeature => feature !== undefined)

    const machiningFeatures = features.filter(isMachinable)
    const regionFeatures = features.filter(isRegion)
    if (machiningFeatures.length === 0) {
      return camT('cam.hint.vCarveRequiresClosed', { kind: operationKindLabel(kind) })
    }
    if (!machiningFeatures.every((feature) => isVCarveCompatibleFeature(feature))) {
      return camT('cam.hint.vCarveWrongFeature', { kind: operationKindLabel(kind) })
    }
    if (!regionFeatures.every((feature) => featureHasClosedGeometry(feature))) {
      return camT('cam.hint.regionNotClosed')
    }

    return null
  }

  if (kind === 'rough_surface') {
    const features = selection.selectedFeatureIds
      .map((featureId) => featureById.get(featureId))
      .filter((feature): feature is ResolvedSketchFeature => feature !== undefined)

    if (features.length !== selection.selectedFeatureIds.length) {
      return camT('cam.hint.featuresNotFound')
    }

    const machiningFeatures = features.filter(isMachinable)
    const regionFeatures = features.filter(isRegion)
    const hasModel = machiningFeatures.some((f) => f.operation === 'model' && f.kind === 'stl')

    if (!hasModel) {
      return camT('cam.hint.roughSurfaceNoModel')
    }
    if (!regionFeatures.every((feature) => featureHasClosedGeometry(feature))) {
      return camT('cam.hint.regionNotClosed')
    }

    return null
  }

  if (kind === 'finish_surface' || kind === 'finish_surface_cleanup') {
    const features = selection.selectedFeatureIds
      .map((featureId) => featureById.get(featureId))
      .filter((feature): feature is ResolvedSketchFeature => feature !== undefined)

    if (features.length !== selection.selectedFeatureIds.length) {
      return camT('cam.hint.featuresNotFound')
    }

    const modelCount = features.filter((feature) => feature.operation === 'model' && feature.kind === 'stl').length
    const regionFeatures = features.filter((feature) => feature.operation === 'region')

    if (modelCount !== 1) {
      return camT('cam.hint.finishSurfaceCount', { kind: operationKindLabel(kind) })
    }
    if (!regionFeatures.every((feature) => featureHasClosedGeometry(feature))) {
      return camT('cam.hint.regionNotClosed')
    }
    if (!features.every((feature) => (
      (feature.operation === 'model' && feature.kind === 'stl')
      || feature.operation === 'region'
    ))) {
      return camT('cam.hint.finishSurfaceWrong', { kind: operationKindLabel(kind) })
    }

    return null
  }

  const features = selection.selectedFeatureIds
    .map((featureId) => featureById.get(featureId))
    .filter((feature): feature is ResolvedSketchFeature => feature !== undefined)

  const wantsSubtract = kind === 'pocket' || kind === 'edge_route_inside'
  const expectedOperation = wantsSubtract ? 'subtract' : 'add'
  const acceptsOperation = (feature: ResolvedSketchFeature) => (
    feature.operation === expectedOperation
    || (kind === 'edge_route_outside' && feature.operation === 'model')
  )
  const machiningFeatures = features.filter(isMachinable)
  const regionFeatures = features.filter(isRegion)
  if (machiningFeatures.length === 0) {
    return wantsSubtract
      ? camT('cam.hint.noSubtractFeature')
      : kind === 'edge_route_outside'
        ? camT('cam.hint.noAddModelFeature')
        : camT('cam.hint.noAddFeature')
  }
  if (!machiningFeatures.every(acceptsOperation)) {
    return wantsSubtract
      ? camT('cam.hint.onlySubtract')
      : kind === 'edge_route_outside'
        ? camT('cam.hint.onlyAddModel')
        : camT('cam.hint.onlyAdd')
  }
  if (!regionFeatures.every((feature) => featureHasClosedGeometry(feature))) {
    return camT('cam.hint.regionNotClosed')
  }

  if (operationRequiresClosedProfiles(kind) && !machiningFeatures.every((feature) => featureHasClosedGeometry(feature))) {
    return camT('cam.hint.closedProfilesOnly', { kind: operationKindLabel(kind) })
  }

  return null
}

/** A machining operation that can be created directly from a single feature. */
export interface QuickOperation {
  kind: OperationKind
  pass: OperationPass
  label: string
}

/**
 * Operation kinds offered as feature-local quick actions, in menu order.
 * Each is filtered through `getOperationAddHint` for the specific feature, so
 * only the kinds that are actually valid for that feature are surfaced.
 */
const QUICK_OPERATION_KINDS: OperationKind[] = [
  'pocket',
  'edge_route_inside',
  'edge_route_outside',
  'v_carve',
  'v_carve_medial',
  'surface_clean',
  'follow_line',
  'drilling',
  'rough_surface',
  'finish_surface',
  'finish_surface_cleanup',
]

/** Friendly "Create …" label for a quick-operation menu entry. */
export function quickOperationLabel(kind: OperationKind): string {
  switch (kind) {
    case 'pocket':
      return camT('cam.quickOp.pocket')
    case 'edge_route_inside':
      return camT('cam.quickOp.edgeRouteInside')
    case 'edge_route_outside':
      return camT('cam.quickOp.edgeRouteOutside')
    case 'v_carve':
      return camT('cam.quickOp.vCarve')
    case 'v_carve_medial':
      return camT('cam.quickOp.vCarveMedial')
    case 'surface_clean':
      return camT('cam.quickOp.surfaceClean')
    case 'follow_line':
      return camT('cam.quickOp.followLine')
    case 'drilling':
      return camT('cam.quickOp.drilling')
    case 'rough_surface':
      return camT('cam.quickOp.roughSurface')
    case 'finish_surface':
      return camT('cam.quickOp.finishSurface')
    case 'finish_surface_cleanup':
      return camT('cam.quickOp.finishSurfaceCleanup')
    default:
      return camT('cam.quickOp.pocket')
  }
}

/**
 * Builds the selection state that represents a single feature, matching what
 * the tree/canvas produce when exactly that feature is selected. Used to run a
 * feature through `getOperationAddHint` without touching the live selection.
 */
function singleFeatureSelection(featureId: string): SelectionState {
  return {
    mode: 'feature',
    selectedFeatureId: featureId,
    selectedFeatureIds: [featureId],
    selectedNode: null,
    hoveredFeatureId: null,
    sketchEditTool: null,
    activeControl: null,
  }
}

/**
 * Returns the machining operations that can be created directly from a single
 * feature, using the same validity rules as the CAM panel. A kind is included
 * only when `getOperationAddHint` reports it valid (hint === null) for that
 * feature on its own. Each entry carries the default pass (`rough`, matching
 * the CAM panel's single-add behaviour) and a friendly menu label.
 */
export function validQuickOperationsForFeature(project: Project, featureId: string): QuickOperation[] {
  const featureById = resolvedFeatureMap(project)
  const feature = featureById.get(featureId)
  if (!feature) {
    return []
  }

  const selection = singleFeatureSelection(featureId)
  return QUICK_OPERATION_KINDS
    .filter((kind) => getOperationAddHintWithMap(selection, kind, featureById) === null)
    .map((kind) => ({ kind, pass: 'rough' as OperationPass, label: quickOperationLabel(kind) }))
}

function compatibleFeatureIdsForOperationWithMap(
  project: Project,
  kind: OperationKind,
  featureById: ResolvedFeatureMap,
): string[] {
  return project.features
    .filter((feature) => getOperationAddHintWithMap(
      singleFeatureSelection(feature.id),
      kind,
      featureById,
    ) === null)
    .map((feature) => feature.id)
}

/**
 * Returns the ids of the features an operation kind could act on, using the
 * same validity rules as the CAM panel (a feature is compatible when
 * `getOperationAddHint` reports it valid on its own). Drives the A1.3 canvas
 * highlight that shows "what would this operation operate on?" while an
 * operation is armed in the "Add operation" menu.
 */
export function compatibleFeatureIdsForOperation(project: Project, kind: OperationKind): string[] {
  const featureById = resolvedFeatureMap(project)
  return compatibleFeatureIdsForOperationWithMap(project, kind, featureById)
}

/**
 * Returns the feature ids the "Select all" affordance in the "Add operation"
 * menu should select for an operation kind, or an empty list when the
 * affordance should not be offered. The ids are the individually compatible
 * features (`compatibleFeatureIdsForOperation`), but only when selecting them
 * all together is itself a valid selection for the kind — e.g. 3D Surface
 * finish accepts exactly one model, so with two compatible models there is no
 * unambiguous "all" to select.
 */
export function selectAllCompatibleFeatureIds(project: Project, kind: OperationKind): string[] {
  const featureById = resolvedFeatureMap(project)
  const featureIds = compatibleFeatureIdsForOperationWithMap(project, kind, featureById)
  if (featureIds.length === 0) {
    return []
  }
  const selection: SelectionState = {
    mode: 'feature',
    selectedFeatureId: featureIds[0],
    selectedFeatureIds: featureIds,
    selectedNode: null,
    hoveredFeatureId: null,
    sketchEditTool: null,
    activeControl: null,
  }
  return getOperationAddHintWithMap(selection, kind, featureById) === null ? featureIds : []
}

/**
 * True when an operation's target list includes at least one `region` feature.
 * Used by the CAM panel (A1.4) to show a plain-language note clarifying that a
 * region limits where the operation may cut rather than being machined itself.
 */
export function operationTargetsRegion(project: Project, operation: Operation): boolean {
  if (operation.target.source !== 'features') {
    return false
  }
  const featureById = resolvedFeatureMap(project)
  return operation.target.featureIds.some((featureId) =>
    featureById.get(featureId)?.operation === 'region')
}
