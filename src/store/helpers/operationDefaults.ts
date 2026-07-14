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

import { featureHasClosedGeometry } from '../../text'
import { convertLength } from '../../utils/units'
import { defaultTool } from '../../types/project'
import { isConstruction, isMachinable, isRegion, sectionForOperation } from './featureRoles'
import { isVCarveCompatibleFeature } from './vcarveTargets'
import { resolveProject } from './resolveFeatures'
import type {
  FeatureOperation,
  Operation,
  OperationKind,
  OperationPass,
  OperationTarget,
  Project,
  Tool,
} from '../../types/project'

export function folderIdForOperation(project: Project, folderId: string | null, operation: FeatureOperation | undefined): string | null {
  if (!folderId) return null
  const folder = project.featureFolders.find((entry) => entry.id === folderId) ?? null
  if (!folder) return null
  const folderSection = folder.section ?? 'features'
  return folderSection === sectionForOperation(operation) ? folderId : null
}

/**
 * Per-feature folder assignment for a bulk "move these features to folder X"
 * — each feature keeps the folder only when it matches its own tree section,
 * otherwise it falls back to that section's root (null).
 */
export function resolveFolderAssignments(authoritativeProject: Project, featureIds: string[], folderId: string | null): Map<string, string | null> {
  const project = resolveProject(authoritativeProject)
  return new Map(featureIds.map((id) => {
    const feature = project.features.find((entry) => entry.id === id)
    return [id, folderIdForOperation(authoritativeProject, folderId, feature?.operation)] as const
  }))
}

export function toolMatchesTemplate(existingTool: Tool, candidate: Omit<Tool, 'id'>): boolean {
  return (
    existingTool.name === candidate.name
    && existingTool.units === candidate.units
    && existingTool.type === candidate.type
    && existingTool.diameter === candidate.diameter
    && existingTool.vBitAngle === candidate.vBitAngle
    && existingTool.flutes === candidate.flutes
    && existingTool.material === candidate.material
    && existingTool.defaultRpm === candidate.defaultRpm
    && existingTool.defaultFeed === candidate.defaultFeed
    && existingTool.defaultPlungeFeed === candidate.defaultPlungeFeed
    && existingTool.defaultStepdown === candidate.defaultStepdown
    && existingTool.defaultStepover === candidate.defaultStepover
  )
}

export function operationKindLabel(kind: OperationKind): string {
  switch (kind) {
    case 'pocket':
      return 'Pocket'
    case 'v_carve':
      return 'V-Carve offset'
    case 'v_carve_medial':
      return 'V-Carve medial'
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
  }
}

export function isOperationTargetValid(authoritativeProject: Project, kind: OperationKind, target: OperationTarget): boolean {
  const project = resolveProject(authoritativeProject)
  // Construction geometry is sketch-only reference geometry — it can never be
  // an operation target (issue #199). One guard covers every kind below.
  if (target.source === 'features' && target.featureIds.some((featureId) => {
    const feature = project.features.find((entry) => entry.id === featureId)
    return feature !== undefined && isConstruction(feature)
  })) {
    return false
  }

  if (kind === 'drilling') {
    if (target.source !== 'features' || target.featureIds.length === 0) {
      return false
    }

    const features = target.featureIds
      .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
      .filter((feature) => feature !== null)

    if (features.length !== target.featureIds.length) {
      return false
    }

    const machiningFeatures = features.filter(isMachinable)
    const regionFeatures = features.filter(isRegion)
    return machiningFeatures.length > 0
      && machiningFeatures.every((feature) => feature.kind === 'circle')
      && regionFeatures.every((feature) => feature.sketch.profile.closed)
  }

  if (kind === 'follow_line') {
    if (target.source !== 'features' || target.featureIds.length === 0) {
      return false
    }

    const features = target.featureIds
      .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
      .filter((feature) => feature !== null)

    const machiningFeatures = features.filter(isMachinable)
    const regionFeatures = features.filter(isRegion)
    return features.length === target.featureIds.length
      && machiningFeatures.length > 0
      && regionFeatures.every((feature) => feature.sketch.profile.closed)
  }

  if (kind === 'surface_clean') {
    if (target.source !== 'features' || target.featureIds.length === 0) {
      return false
    }

    const features = target.featureIds
      .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
      .filter((feature) => feature !== null)

    if (features.length !== target.featureIds.length) {
      return false
    }

    const machiningFeatures = features.filter(isMachinable)
    const regionFeatures = features.filter(isRegion)
    return machiningFeatures.length > 0
      && machiningFeatures.every((feature) => (feature.operation === 'add' || feature.operation === 'model') && feature.sketch.profile.closed)
      && regionFeatures.every((feature) => feature.sketch.profile.closed)
  }

  if (kind === 'finish_surface' || kind === 'finish_surface_cleanup') {
    if (target.source !== 'features' || target.featureIds.length === 0) {
      return false
    }

    const features = target.featureIds
      .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
      .filter((feature) => feature !== null)

    if (features.length !== target.featureIds.length) {
      return false
    }

    const modelCount = features.filter((f) => f.operation === 'model' && f.kind === 'stl').length
    const allValid = features.every((f) =>
      (f.operation === 'model' && f.kind === 'stl') ||
      (f.operation === 'region' && f.sketch.profile.closed)
    )

    if (modelCount !== 1) return false
    if (!allValid) return false
    return true
  }

  if (kind === 'rough_surface') {
    if (target.source !== 'features' || target.featureIds.length === 0) {
      return false
    }

    const features = target.featureIds
      .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
      .filter((feature) => feature !== null)

    if (features.length !== target.featureIds.length) {
      return false
    }

    const machiningFeatures = features.filter(isMachinable)
    const regionFeatures = features.filter(isRegion)
    return machiningFeatures.some((feature) => feature.operation === 'model' && feature.kind === 'stl')
      && regionFeatures.every((feature) => feature.sketch.profile.closed)
  }

  if (kind === 'v_carve' || kind === 'v_carve_medial') {
    if (target.source !== 'features' || target.featureIds.length === 0) {
      return false
    }

    const features = target.featureIds
      .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
      .filter((feature) => feature !== null)

    if (features.length !== target.featureIds.length) {
      return false
    }

    const machiningFeatures = features.filter(isMachinable)
    const regionFeatures = features.filter(isRegion)
    return machiningFeatures.length > 0
      && machiningFeatures.every((feature) => isVCarveCompatibleFeature(feature))
      && regionFeatures.every((feature) => featureHasClosedGeometry(feature))
  }

  if (target.source !== 'features' || target.featureIds.length === 0) {
    return false
  }

  const features = target.featureIds
    .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
    .filter((feature) => feature !== null)

  if (features.length !== target.featureIds.length) {
    return false
  }

  if (kind === 'pocket' || kind === 'edge_route_inside') {
    const machiningFeatures = features.filter(isMachinable)
    const regionFeatures = features.filter(isRegion)
    return machiningFeatures.length > 0
      && machiningFeatures.every((feature) => feature.operation === 'subtract' && feature.sketch.profile.closed)
      && regionFeatures.every((feature) => feature.sketch.profile.closed)
  }

  const machiningFeatures = features.filter(isMachinable)
  const regionFeatures = features.filter(isRegion)
  return machiningFeatures.length > 0
    && machiningFeatures.every((feature) => (feature.operation === 'add' || feature.operation === 'model') && feature.sketch.profile.closed)
    && regionFeatures.every((feature) => feature.sketch.profile.closed)
}

export function defaultOperationName(kind: OperationKind, pass: OperationPass, operations: Operation[]): string {
  const baseName = kind === 'follow_line' || kind === 'v_carve' || kind === 'v_carve_medial' || kind === 'drilling' || kind === 'rough_surface' || kind === 'finish_surface'
    || kind === 'finish_surface_cleanup'
    ? operationKindLabel(kind)
    : `${operationKindLabel(kind)} ${pass === 'rough' ? 'Rough' : 'Finish'}`
  if (!operations.some((operation) => operation.name === baseName)) {
    return baseName
  }

  let index = 2
  while (operations.some((operation) => operation.name === `${baseName} ${index}`)) {
    index += 1
  }
  return `${baseName} ${index}`
}

function defaultWaterlineMicroStepover(tool: Tool): number {
  return Math.max(0, tool.defaultStepover * tool.diameter)
}

export function defaultOperationForTarget(
  project: Project,
  kind: OperationKind,
  pass: OperationPass,
  target: OperationTarget,
  index: number,
  resolved?: { tool: Tool; toolRef: string | null },
): Operation {
  const tool = resolved?.tool ?? project.tools[0] ?? defaultTool(project.meta.units, 1)
  const toolRef = resolved ? resolved.toolRef : (project.tools[0]?.id ?? null)

  const isVCarve = kind === 'v_carve' || kind === 'v_carve_medial'
  const vCarveMaxDepth = tool.maxCutDepth > 0
    ? tool.maxCutDepth
    : (project.stock.thickness > 0 ? project.stock.thickness : convertLength(1, 'mm', project.meta.units))

  return {
    id: `op${index + 1}`,
    name: defaultOperationName(kind, pass, project.operations),
    description: '',
    kind,
    pass,
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target,
    toolRef,
    stepdown: kind === 'finish_surface_cleanup'
      ? convertLength(1, 'mm', project.meta.units)
      : tool.defaultStepdown,
    // For the medial-axis v-carve, stepover is the skeleton sampling step —
    // cap the tool default so the skeleton starts at engraving resolution.
    stepover: kind === 'v_carve_medial'
      ? Math.min(tool.defaultStepover, convertLength(0.4, 'mm', project.meta.units))
      : tool.defaultStepover,
    feed: tool.defaultFeed,
    plungeFeed: tool.defaultPlungeFeed,
    rpm: tool.defaultRpm,
    pocketPattern: kind === 'finish_surface' || kind === 'finish_surface_cleanup' ? 'parallel' : 'offset',
    pocketAngle: 0,
    pocketSlotFeedPercent: 100,
    roundOutsideCorners: false,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: convertLength(1, 'mm', project.meta.units),
    maxCarveDepth: isVCarve ? vCarveMaxDepth : convertLength(1, 'mm', project.meta.units),
    cutDirection: 'conventional',
    machiningOrder: 'feature_first',
    waterlineAdaptiveRefinement: true,
    waterlineMicroStepover: defaultWaterlineMicroStepover(tool),
    waterlineRefinementThreshold: 0,
    waterlineMaxRingsPerBand: 0,
    waterlineTipStepdown: 0,
    ...(kind === 'drilling' ? {
      drillType: 'simple' as const,
      peckDepth: convertLength(2, 'mm', project.meta.units),
      dwellTime: 0.5,
      retractHeight: project.stock.thickness + convertLength(1, 'mm', project.meta.units),
    } : {}),
  }
}

export function fallbackOperationTarget(authoritativeProject: Project, kind: OperationKind): OperationTarget {
  const project = resolveProject(authoritativeProject)
  if (kind === 'drilling') {
    const firstCircle = project.features.find((feature) => feature.kind === 'circle')
    return firstCircle
      ? { source: 'features', featureIds: [firstCircle.id] }
      : { source: 'stock' }
  }

  if (kind === 'follow_line') {
    const firstFeature = project.features.find(isMachinable)
    return firstFeature
      ? { source: 'features', featureIds: [firstFeature.id] }
      : { source: 'stock' }
  }

  if (kind === 'v_carve' || kind === 'v_carve_medial') {
    const firstCompatibleFeature = project.features.find((feature) => isVCarveCompatibleFeature(feature))
    return firstCompatibleFeature
      ? { source: 'features', featureIds: [firstCompatibleFeature.id] }
      : { source: 'stock' }
  }

  if (kind === 'finish_surface' || kind === 'finish_surface_cleanup') {
    const modelFeature = project.features.find((feature) => feature.operation === 'model' && feature.kind === 'stl')
    if (modelFeature) {
      const regionFeature = project.features.find((feature) => feature.operation === 'region' && feature.sketch.profile.closed)
      if (regionFeature) {
        return { source: 'features', featureIds: [modelFeature.id, regionFeature.id] }
      }
      return { source: 'features', featureIds: [modelFeature.id] }
    }
  }

  if (kind === 'rough_surface') {
    const modelFeature = project.features.find((feature) => feature.operation === 'model' && feature.kind === 'stl')
    if (modelFeature) {
      const regionFeature = project.features.find((feature) => feature.operation === 'region' && feature.sketch.profile.closed)
      if (regionFeature) {
        return { source: 'features', featureIds: [modelFeature.id, regionFeature.id] }
      }
      return { source: 'features', featureIds: [modelFeature.id] }
    }
  }

  if (kind === 'surface_clean' || kind === 'edge_route_outside') {
    const firstAddOrModelFeature = project.features.find((feature) => (
      (feature.operation === 'add' || (kind === 'edge_route_outside' && feature.operation === 'model'))
      && feature.sketch.profile.closed
    ))
    if (firstAddOrModelFeature) {
      return { source: 'features', featureIds: [firstAddOrModelFeature.id] }
    }
  }

  if (kind === 'pocket' || kind === 'edge_route_inside') {
    const firstSubtractFeature = project.features.find((feature) => feature.operation === 'subtract' && feature.sketch.profile.closed)
    if (firstSubtractFeature) {
      return { source: 'features', featureIds: [firstSubtractFeature.id] }
    }
  }

  const firstFeature = project.features.find((feature) => isMachinable(feature) && feature.sketch.profile.closed)
  return firstFeature
    ? { source: 'features', featureIds: [firstFeature.id] }
    : { source: 'stock' }
}
