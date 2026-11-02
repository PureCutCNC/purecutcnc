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
 * Text on a path — its baked copy and the optional link back to the source
 * (issue #1112 slice E).
 *
 * The path stays baked into the instance's `textLayout`, exactly as before, so
 * deleting or editing the source can never change the run by itself. The
 * optional `sourceFeatureId` only lets Properties offer "Refresh", which copies
 * the source again; when the source is gone that action is refused with a
 * reason instead of silently doing nothing.
 */

import type { Project } from '../../types/project'
import { resolveFeatureInstance, type ResolvedSketchFeature } from './resolveFeatures'

export type TextPathRefreshReason =
  | 'not-a-path'
  | 'no-source'
  | 'missing-source'
  | 'empty-source'
  | 'locked'

export type TextPathRefreshState =
  | { canRefresh: true; sourceFeatureId: string; sourceName: string }
  | { canRefresh: false; reason: TextPathRefreshReason }

/**
 * Whether "Refresh" is available for a text run, and why not when it is not.
 * A run wrapped before the source id existed still renders exactly as before;
 * it simply has no Refresh, because there is no source to re-read.
 */
export function textPathRefreshState(
  project: Project,
  textFeature: Pick<ResolvedSketchFeature, 'textLayout' | 'locked'>,
): TextPathRefreshState {
  if (textFeature.textLayout?.kind !== 'path') {
    return { canRefresh: false, reason: 'not-a-path' }
  }
  const sourceFeatureId = textFeature.textLayout.sourceFeatureId
  if (!sourceFeatureId) {
    return { canRefresh: false, reason: 'no-source' }
  }
  if (textFeature.locked) {
    return { canRefresh: false, reason: 'locked' }
  }
  const source = resolveFeatureInstance(project, sourceFeatureId)
  if (!source || source.kind === 'stl') {
    return { canRefresh: false, reason: 'missing-source' }
  }
  if (source.sketch.profile.segments.length === 0) {
    return { canRefresh: false, reason: 'empty-source' }
  }
  return { canRefresh: true, sourceFeatureId, sourceName: source.name }
}
