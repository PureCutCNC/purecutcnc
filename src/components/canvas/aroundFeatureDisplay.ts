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
 * The outlines the Sketch canvas draws for a feature (issue #1112 slice L).
 *
 * On the Around sheet a canned shape is drawn folded into the sheet, because
 * its generated outlines can run past the seam (a multi-turn thread). A
 * hand-drawn sketch is drawn exactly as it was drawn — no wrapped copy — so
 * this only folds a feature that stores canned parameters. Nothing here
 * changes the stored geometry or the geometry a toolpath is generated from.
 */

import { isCannedFeature } from '../../cannedShapes'
import { getFeatureGeometryProfiles } from '../../text'
import type { SketchFeature, SketchProfile } from '../../types/project'
import { foldProfileToSheet } from './aroundDisplayWrap'
import type { AroundWrapWindow } from './aroundDisplayWrap'

export function featureDisplayProfiles(
  feature: SketchFeature,
  sheet?: AroundWrapWindow | null,
): SketchProfile[] {
  const profiles = getFeatureGeometryProfiles(feature)
  if (!sheet || !isCannedFeature(feature)) return profiles
  const folded = profiles.flatMap((profile) => foldProfileToSheet(profile, sheet))
  return folded.length > 0 ? folded : profiles
}
