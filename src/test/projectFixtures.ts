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

import { IDENTITY_MATRIX, type FeatureInstance, type Project, type SketchFeature } from '../types/project'
import { normalizeProject } from '../store/helpers/projectFormat'
import {
  createDefinitionForFeatureWithId,
  createFeatureInstance,
} from '../store/helpers/featureDefinitions'
import {
  resolveFeatureInstance,
  resolvedProjectFeatures,
  type ResolvedSketchFeature,
} from '../store/helpers/resolveFeatures'
import type { LegacyFeatureRow, ProjectFormatInput } from '../store/helpers/projectFormat'

export type TestFeatureRow = FeatureInstance | LegacyFeatureRow

function withAuthoritativeFeatures(base: Project, features: TestFeatureRow[]): Project {
  const featureDefinitions = { ...base.featureDefinitions }
  const instances = features.map((feature) => {
    if (!('sketch' in feature)) return feature
    const definitionId = feature.definitionId ?? feature.id
    if (!featureDefinitions[definitionId]) {
      featureDefinitions[definitionId] = createDefinitionForFeatureWithId(feature, definitionId).definition
    }
    return createFeatureInstance(feature, definitionId, feature.transform ?? IDENTITY_MATRIX)
  })
  return normalizeProject({
    ...base,
    version: '3.0',
    featureDefinitions,
    features: instances,
  } as ProjectFormatInput)
}

/** Build an authoritative 3.0 project from concise geometry-bearing test drafts. */
export function projectWithFeatures(base: Project, features: TestFeatureRow[]): Project {
  return withAuthoritativeFeatures(base, features)
}

/** Replace all test features while keeping the serialized project authoritative. */
export function replaceProjectFeatures(project: Project, features: TestFeatureRow[]): void {
  const base = {
    ...project,
    featureDefinitions: { ...project.featureDefinitions },
  }
  for (const feature of features) {
    if ('sketch' in feature) delete base.featureDefinitions[feature.definitionId ?? feature.id]
  }
  const normalized = withAuthoritativeFeatures(base, features)
  Object.assign(project, normalized)
}

export function resolvedFeature(project: Project, featureId: string): ResolvedSketchFeature {
  const feature = resolveFeatureInstance(project, featureId)
  if (!feature) throw new Error(`Expected resolved test feature ${featureId}.`)
  return feature
}

export function resolvedFeatures(project: Project): ResolvedSketchFeature[] {
  return resolvedProjectFeatures(project)
}

/** Adapt the ephemeral resolved read model to geometry helpers used by tests. */
export function asSketchFeature(feature: ResolvedSketchFeature): SketchFeature {
  return feature
}
