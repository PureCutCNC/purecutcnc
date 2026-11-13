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
 * Turning a shape-creation call into a canned feature (issue #1112 slice D).
 *
 * The world profile is still what decides the operation, the name and a Line's
 * Z, exactly as the plain creation path always did. The definition stores the
 * parameters, and the instance carries the placement the parameters leave out:
 * generators draw in definition-local coordinates, so this transform is the old
 * command's own position and angle, and the generated outline is the outline
 * that command cut.
 */

import type {
  CannedShapeData,
  FeatureDefinition,
  Matrix2D,
  SketchProfile,
} from '../../types/project'
import type { ProjectStore } from '../types'
import { buildShapeFeature } from './buildShapeFeature'
import { createDefinitionForFeature } from './featureDefinitions'
import type { ReferencedSketchFeature } from './copyFeatures'

/**
 * Add one canned feature: a definition that already carries the parameters
 * (`_clonedDefinition`) and the instance placement.
 */
export function addCannedShapeFeature(
  state: Pick<ProjectStore, 'project' | 'creationTarget' | 'addFeature'>,
  name: string,
  canned: CannedShapeData,
  worldProfile: SketchProfile,
  transform: Matrix2D,
  depth: number,
): void {
  const draft = buildShapeFeature(state.project, state.creationTarget, 'composite', worldProfile, name, depth)
  const { definitionId, definition } = createDefinitionForFeature(state.project, { ...draft, canned })
  state.addFeature({
    ...draft, definitionId, transform, _clonedDefinition: definition,
  } as ReferencedSketchFeature & { _clonedDefinition: FeatureDefinition })
}
