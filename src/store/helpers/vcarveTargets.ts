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
 * V-carve target eligibility — the single source of truth for "can this feature
 * be a V-carve machining target?" (issue #270 S2).
 *
 * Both V-carve strategies (offset and recursive/skeleton) accept:
 * - Subtract features with entirely closed geometry (existing behaviour)
 * - Line features with entirely closed geometry (new in S2)
 *
 * Open Lines, Add, Model, Region, and Construction are never valid V-carve targets.
 *
 * Every call site that decides V-carve eligibility — UI hints, quick operations,
 * compatible selection highlights, CAM panel selection validation, persisted
 * target validation, and fallback target selection — MUST go through this
 * predicate so the rule lives in exactly one place.
 */

import type { SketchFeature } from '../../types/project'
import { featureHasClosedGeometry } from '../../text'

/**
 * True when `feature` is a valid V-carve machining target: a closed Subtract
 * or a closed Line. Open geometry, Add, Model, Region, and Construction return
 * false.
 */
export function isVCarveCompatibleFeature(feature: SketchFeature): boolean {
  return (feature.operation === 'subtract' || feature.operation === 'line')
    && featureHasClosedGeometry(feature)
}
