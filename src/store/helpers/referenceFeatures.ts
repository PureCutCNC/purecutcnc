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

import type { Project } from '../../types/project'
import { ghostPredicate } from './activeFace'
import { resolvedProjectFeatures, type ResolvedSketchFeature } from './resolveFeatures'

/** Reference geometry stays canonical and never becomes an edit selection. */
export function referenceProjectFeatures(project: Project, showOtherSide: boolean): readonly ResolvedSketchFeature[] {
  const isGhost = ghostPredicate(project)
  return resolvedProjectFeatures(project).filter((feature) => (
    !isGhost(feature) || (showOtherSide && feature.operation === 'construction')
  ))
}
