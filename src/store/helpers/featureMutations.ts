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

import type {
  FeatureDefinition,
  FeatureInstance,
  FeatureOperation,
  Project,
  SketchFeature,
} from '../../types/project'
import {
  propagateConstraintsOnTranslate,
  validateConstraintsOnFeature,
  type FeatureOffset,
} from '../../sketch/constraintSolver'
import { transformProfile } from './transform'
import { moveDelta, multiplyMatrix } from './instanceTransforms'
import { isImportedModelFeature } from './modelAssets'
import { folderIdForOperation } from './operationDefaults'
import { isSolid } from './featureRoles'
import { resolvedProjectFeatures } from './resolveFeatures'

function updateDefinitionFromFeaturePatch(
  definition: FeatureDefinition,
  patch: Partial<SketchFeature>,
): FeatureDefinition {
  const operation = patch.operation ?? definition.operation
  return {
    ...definition,
    kind: patch.kind ?? definition.kind,
    profile: patch.sketch?.profile ?? definition.profile,
    dimensions: patch.sketch?.dimensions ?? definition.dimensions,
    text: patch.text !== undefined ? patch.text : definition.text,
    stl: patch.stl !== undefined ? patch.stl : definition.stl,
    operation,
    regionMaskMode: operation === 'region'
      ? (patch.regionMaskMode ?? definition.regionMaskMode ?? 'include')
      : undefined,
  }
}

function updateInstanceFromFeaturePatch(
  project: Project,
  instance: FeatureInstance,
  patch: Partial<SketchFeature>,
  operation: FeatureOperation,
): FeatureInstance {
  const keepZ = operation === 'region' || operation === 'construction'
  const next: FeatureInstance = {
    ...instance,
    name: patch.name ?? instance.name,
    constraints: patch.sketch?.constraints ?? instance.constraints,
    z_top: keepZ ? instance.z_top : (patch.z_top ?? instance.z_top),
    z_bottom: keepZ ? instance.z_bottom : (patch.z_bottom ?? instance.z_bottom),
    folderId: folderIdForOperation(
      project,
      patch.folderId !== undefined ? patch.folderId : instance.folderId,
      operation,
    ),
    visible: patch.visible ?? instance.visible,
    locked: patch.locked ?? instance.locked,
  }
  if (
    typeof next.z_top === 'number'
    && typeof next.z_bottom === 'number'
    && next.z_top < next.z_bottom
  ) {
    return { ...next, z_top: next.z_bottom, z_bottom: next.z_top }
  }
  return next
}

export function applyFeaturePatch(
  project: Project,
  ids: ReadonlySet<string>,
  patch: Partial<SketchFeature>,
): { features: FeatureInstance[]; featureDefinitions: Record<string, FeatureDefinition> } {
  let featureDefinitions = { ...project.featureDefinitions }
  const changedDefinitionIds = new Set<string>()

  for (const instance of project.features) {
    if (!ids.has(instance.id)) continue
    const definition = featureDefinitions[instance.definitionId]
    if (!definition) continue
    featureDefinitions[instance.definitionId] = updateDefinitionFromFeaturePatch(definition, patch)
    changedDefinitionIds.add(instance.definitionId)
  }

  let features = project.features.map((instance) => {
    const definition = featureDefinitions[instance.definitionId]
    if (!definition) return instance
    if (ids.has(instance.id)) {
      return updateInstanceFromFeaturePatch(project, instance, patch, definition.operation)
    }
    if (patch.operation !== undefined && changedDefinitionIds.has(instance.definitionId)) {
      const folderId = folderIdForOperation(project, instance.folderId, definition.operation)
      return folderId === instance.folderId ? instance : { ...instance, folderId }
    }
    return instance
  })

  const firstSolid = resolvedProjectFeatures({
    ...project,
    features,
    featureDefinitions,
  }).find(isSolid)
  if (
    firstSolid
    && firstSolid.operation !== 'add'
    && !isImportedModelFeature(firstSolid)
  ) {
    const baseDefinition = featureDefinitions[firstSolid.definitionId]
    featureDefinitions = {
      ...featureDefinitions,
      [firstSolid.definitionId]: {
        ...baseDefinition,
        operation: 'add',
        regionMaskMode: undefined,
      },
    }
    features = features.map((instance) => (
      instance.definitionId === firstSolid.definitionId
        ? { ...instance, folderId: folderIdForOperation(project, instance.folderId, 'add') }
        : instance
    ))
  }

  return { features, featureDefinitions }
}

export function applyTranslatedFeatureOffsets(
  project: Project,
  movedOffsets: Map<string, FeatureOffset>,
): FeatureInstance[] {
  const resolved = resolvedProjectFeatures(project)
  const translated = resolved.map((feature) => {
    const offset = movedOffsets.get(feature.id)
    if (!offset) return feature
    return {
      ...feature,
      sketch: {
        ...feature.sketch,
        profile: transformProfile(feature.sketch.profile, (point) => ({
          x: point.x + offset.dx,
          y: point.y + offset.dy,
        })),
      },
    }
  })
  const propagated = propagateConstraintsOnTranslate(translated, movedOffsets, { transformProfile })
  const propagatedById = new Map<string, SketchFeature>(
    propagated.map((feature) => [feature.id, feature]),
  )
  const validated = propagated.map((feature) => (
    feature.sketch.constraints.some((constraint) => constraint.type === 'fixed_distance')
      ? validateConstraintsOnFeature(feature, propagatedById)
      : feature
  ))
  const originalById = new Map(resolved.map((feature) => [feature.id, feature]))
  const validatedById = new Map(validated.map((feature) => [feature.id, feature]))

  return project.features.map((instance) => {
    const original = originalById.get(instance.id)
    const next = validatedById.get(instance.id)
    if (!original || !next) return instance
    const dx = next.sketch.profile.start.x - original.sketch.profile.start.x
    const dy = next.sketch.profile.start.y - original.sketch.profile.start.y
    const transform = dx === 0 && dy === 0
      ? instance.transform
      : multiplyMatrix(moveDelta(dx, dy), instance.transform)
    return {
      ...instance,
      transform,
      constraints: next.sketch.constraints.map((constraint) => ({ ...constraint })),
    }
  })
}
