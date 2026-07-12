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

import { inferNestedSolidOperation } from '../../import/classifier'
import type { FeatureOperation, Project, SketchProfile } from '../../types/project'
import { resolveFeatureInstances } from './resolveFeatures'

/** Infer a newly-created closed feature's role from resolved existing solids. */
export function inferManualFeatureOperation(
  project: Project,
  profile: SketchProfile,
): FeatureOperation {
  const existingSolids = resolveFeatureInstances(project)
    .filter((feature) => feature.operation === 'add' || feature.operation === 'subtract')
    .map((feature) => ({
      profile: feature.sketch.profile,
      operation: feature.operation as 'add' | 'subtract',
    }))
  return inferNestedSolidOperation(profile, existingSolids)
}
