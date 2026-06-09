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
import type { OperationKind, OperationPass, Project } from '../../types/project'
import { featureHasClosedGeometry } from '../../text'

export function operationKindLabel(kind: OperationKind): string {
  switch (kind) {
    case 'pocket':
      return 'Pocket'
    case 'v_carve':
      return 'V-Carve offset'
    case 'v_carve_recursive':
      return 'V-Carve skeleton'
    case 'edge_route_inside':
      return 'Edge route inside'
    case 'edge_route_outside':
      return 'Edge route outside'
    case 'surface_clean':
      return 'Surface clean'
    case 'rough_surface':
      return '3D Surface rough'
    case 'finish_surface':
      return '3D Surface finish'
    case 'finish_surface_cleanup':
      return '3D Surface cleanup'
    case 'follow_line':
      return 'Engrave'
    case 'drilling':
      return 'Drill'
    default:
      return 'Unknown'
  }
}

export function operationRequiresClosedProfiles(kind: OperationKind): boolean {
  return kind === 'pocket' || kind === 'v_carve' || kind === 'v_carve_recursive' || kind === 'edge_route_inside' || kind === 'edge_route_outside' || kind === 'surface_clean'
}

export function getOperationAddHint(project: Project, selection: SelectionState, kind: OperationKind): string | null {
  if (kind === 'drilling') {
    if (selection.selectedFeatureIds.length === 0) {
      return 'Select one or more circle features first'
    }

    const features = selection.selectedFeatureIds
      .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
      .filter((feature): feature is Project['features'][number] => feature !== null)

    const machiningFeatures = features.filter((feature) => feature.operation !== 'region')
    const regionFeatures = features.filter((feature) => feature.operation === 'region')
    return machiningFeatures.length > 0
      && machiningFeatures.every((feature) => feature.kind === 'circle')
      && regionFeatures.every((feature) => featureHasClosedGeometry(feature))
      ? null
      : 'Drilling requires circle features; closed regions are optional filters'
  }

  if (kind === 'follow_line') {
    if (selection.selectedFeatureIds.length === 0) {
      return 'Select one or more open or closed features first; closed regions are optional filters'
    }
    const features = selection.selectedFeatureIds
      .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
      .filter((feature): feature is Project['features'][number] => feature !== null)
    const machiningFeatures = features.filter((feature) => feature.operation !== 'region')
    const regionFeatures = features.filter((feature) => feature.operation === 'region')
    return machiningFeatures.length > 0 && regionFeatures.every((feature) => featureHasClosedGeometry(feature))
      ? null
      : 'Engrave requires at least one path feature; closed regions are optional filters'
  }

  if (kind === 'surface_clean') {
    if (selection.selectedFeatureIds.length === 0) {
      return 'Select one or more add/model features first; closed regions are optional filters'
    }

    const features = selection.selectedFeatureIds
      .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
      .filter((feature): feature is Project['features'][number] => feature !== null)

    const machiningFeatures = features.filter((feature) => feature.operation !== 'region')
    const regionFeatures = features.filter((feature) => feature.operation === 'region')
    if (machiningFeatures.length === 0) {
      return 'Surface clean requires at least one add/model feature; regions are only filters'
    }
    if (!machiningFeatures.every((feature) => feature.operation === 'add' || feature.operation === 'model')) {
      return 'Surface clean only accepts add/model features plus optional closed regions'
    }
    if (!regionFeatures.every((feature) => featureHasClosedGeometry(feature))) {
      return 'Region filters must be closed profiles'
    }

    return machiningFeatures.every((feature) => featureHasClosedGeometry(feature))
      ? null
      : 'Surface clean only accepts closed profiles'
  }

  if (kind === 'v_carve' || kind === 'v_carve_recursive') {
    if (selection.selectedFeatureIds.length === 0) {
      return 'Select one or more closed subtract features first'
    }

    const features = selection.selectedFeatureIds
      .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
      .filter((feature): feature is Project['features'][number] => feature !== null)

    const machiningFeatures = features.filter((feature) => feature.operation !== 'region')
    const regionFeatures = features.filter((feature) => feature.operation === 'region')
    if (machiningFeatures.length === 0) {
      return `${operationKindLabel(kind)} requires at least one subtract feature; regions are only filters`
    }
    if (!machiningFeatures.every((feature) => feature.operation === 'subtract')) {
      return `${operationKindLabel(kind)} only accepts subtract features plus optional closed regions`
    }
    if (!regionFeatures.every((feature) => featureHasClosedGeometry(feature))) {
      return 'Region filters must be closed profiles'
    }

    return machiningFeatures.every((feature) => featureHasClosedGeometry(feature))
      ? null
      : `${operationKindLabel(kind)} only accepts closed profiles`
  }

  if (kind === 'rough_surface') {
    if (selection.selectedFeatureIds.length === 0) {
      return 'Select an imported model feature first'
    }

    const features = selection.selectedFeatureIds
      .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
      .filter((feature): feature is Project['features'][number] => feature !== null)

    if (features.length !== selection.selectedFeatureIds.length) {
      return 'One or more selected features not found'
    }

    const machiningFeatures = features.filter((feature) => feature.operation !== 'region')
    const regionFeatures = features.filter((feature) => feature.operation === 'region')
    const hasModel = machiningFeatures.some((f) => f.operation === 'model' && f.kind === 'stl')

    if (!hasModel) {
      return 'Rough surface requires at least one imported model feature; closed regions are optional filters'
    }
    if (!regionFeatures.every((feature) => featureHasClosedGeometry(feature))) {
      return 'Region filters must be closed profiles'
    }

    return null
  }

  if (kind === 'finish_surface' || kind === 'finish_surface_cleanup') {
    if (selection.selectedFeatureIds.length === 0) {
      return 'Select an imported model feature first'
    }

    const features = selection.selectedFeatureIds
      .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
      .filter((feature): feature is Project['features'][number] => feature !== null)

    if (features.length !== selection.selectedFeatureIds.length) {
      return 'One or more selected features not found'
    }

    const modelCount = features.filter((feature) => feature.operation === 'model' && feature.kind === 'stl').length
    const regionFeatures = features.filter((feature) => feature.operation === 'region')

    if (modelCount !== 1) {
      return `${operationKindLabel(kind)} requires exactly one imported model feature; closed regions are optional filters`
    }
    if (!regionFeatures.every((feature) => featureHasClosedGeometry(feature))) {
      return 'Region filters must be closed profiles'
    }
    if (!features.every((feature) => (
      (feature.operation === 'model' && feature.kind === 'stl')
      || feature.operation === 'region'
    ))) {
      return `${operationKindLabel(kind)} only accepts one imported model plus optional closed regions`
    }

    return null
  }

  if (selection.selectedFeatureIds.length === 0) {
    return 'Select one or more compatible features first'
  }

  const features = selection.selectedFeatureIds
    .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
    .filter((feature): feature is Project['features'][number] => feature !== null)

  const wantsSubtract = kind === 'pocket' || kind === 'edge_route_inside'
  const expectedOperation = wantsSubtract ? 'subtract' : 'add'
  const acceptsOperation = (feature: Project['features'][number]) => (
    feature.operation === expectedOperation
    || (kind === 'edge_route_outside' && feature.operation === 'model')
  )
  const machiningFeatures = features.filter((feature) => feature.operation !== 'region')
  const regionFeatures = features.filter((feature) => feature.operation === 'region')
  if (machiningFeatures.length === 0) {
    return wantsSubtract
      ? 'Select at least one subtract feature; closed regions are optional filters'
      : kind === 'edge_route_outside'
        ? 'Select at least one add/model feature; closed regions are optional filters'
        : 'Select at least one add feature; closed regions are optional filters'
  }
  if (!machiningFeatures.every(acceptsOperation)) {
    return wantsSubtract
      ? 'This operation only accepts subtract features plus optional closed regions'
      : kind === 'edge_route_outside'
        ? 'This operation only accepts add/model features plus optional closed regions'
        : 'This operation only accepts add features plus optional closed regions'
  }
  if (!regionFeatures.every((feature) => featureHasClosedGeometry(feature))) {
    return 'Region filters must be closed profiles'
  }

  if (operationRequiresClosedProfiles(kind) && !machiningFeatures.every((feature) => featureHasClosedGeometry(feature))) {
    return `${operationKindLabel(kind)} only accepts closed profiles`
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
  'v_carve_recursive',
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
      return 'Create Pocket'
    case 'edge_route_inside':
      return 'Create Inside Route'
    case 'edge_route_outside':
      return 'Create Outside Route'
    case 'v_carve':
      return 'Create V-Carve (offset)'
    case 'v_carve_recursive':
      return 'Create V-Carve (skeleton)'
    case 'surface_clean':
      return 'Create Surface Clean'
    case 'follow_line':
      return 'Create Engraving'
    case 'drilling':
      return 'Create Drilling'
    case 'rough_surface':
      return 'Create Rough Surface'
    case 'finish_surface':
      return 'Create Finish Surface'
    case 'finish_surface_cleanup':
      return 'Create Finish Surface Cleanup'
    default:
      return `Create ${operationKindLabel(kind)}`
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
  const feature = project.features.find((item) => item.id === featureId)
  if (!feature) {
    return []
  }

  const selection = singleFeatureSelection(featureId)
  return QUICK_OPERATION_KINDS
    .filter((kind) => getOperationAddHint(project, selection, kind) === null)
    .map((kind) => ({ kind, pass: 'rough' as OperationPass, label: quickOperationLabel(kind) }))
}
