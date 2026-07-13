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

import type { CreationTarget } from '../types'
import type { FeatureOperation, Project, SketchFeature, SketchProfile } from '../../types/project'
import { isConstruction, isRegion } from './featureRoles'
import { nextUniqueGeneratedId } from './ids'
import { inferManualFeatureOperation } from './manualFeatureOperation'

export type ShapeKind = 'rect' | 'circle' | 'ellipse' | 'polygon' | 'spline' | 'composite'

/**
 * Build a SketchFeature for a shape-based convenience constructor.
 * Consolidates the duplicated pattern shared by addRectFeature,
 * addCircleFeature, etc. into one place.
 */
export function buildShapeFeature(
  project: Project,
  creationTarget: CreationTarget,
  kind: ShapeKind,
  profile: SketchProfile,
  baseName: string,
  depth: number,
): SketchFeature {
  const operation: FeatureOperation =
    creationTarget === 'region' ? 'region'
    : creationTarget === 'construction' ? 'construction'
    : creationTarget === 'line' ? 'line'
    : profile.closed ? inferManualFeatureOperation(project, profile)
    : 'line'
  const resolvedName =
    operation === 'region'
      ? `Region ${project.features.filter(isRegion).length + 1}`
      : operation === 'construction'
        ? `Construction ${project.features.filter(isConstruction).length + 1}`
        : baseName
  const id = nextUniqueGeneratedId(project, 'f')
  return {
    id,
    name: resolvedName,
    kind,
    folderId: null,
    sketch: {
      profile,
      origin: { x: 0, y: 0 },
      orientationAngle: 90,
      dimensions: [],
      constraints: [],
    },
    operation,
    z_top: depth,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}
