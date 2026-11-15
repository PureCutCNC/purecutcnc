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
 * The dialog's decisions, kept out of the component so they can be tested
 * without a DOM (issue #1206): which rows start checked, what a row's size
 * reads as, and which shapes a set of checked rows draws.
 */

import type { DrawnFeature, RecognitionCandidate, SkipReason, SkippedCavity } from '../../engine/modelRecognition'
import { resolveFeatureZSpan } from '../../engine/toolpaths/geometry'
import type { RecognizedShapeInput } from '../../store/helpers/recognizedFeatures'
import { resolvedProjectFeatures } from '../../store/helpers/resolveFeatures'
import type { Project } from '../../types/project'

/** Every add and subtract already in the project, as the "already drawn" check reads them. */
export function drawnFeaturesOf(project: Project): DrawnFeature[] {
  return resolvedProjectFeatures(project)
    .filter((feature) => feature.operation === 'add' || feature.operation === 'subtract')
    .map((feature) => {
      const span = resolveFeatureZSpan(project, feature)
      return {
        face: feature.authoringFace ?? 'top',
        operation: feature.operation,
        profile: feature.sketch.profile,
        zTop: span.max,
        zBottom: span.min,
      }
    })
}

/** Cavities start checked unless they are already drawn. Islands have no box of their own. */
export function defaultCheckedIds(candidates: readonly RecognitionCandidate[]): string[] {
  return candidates
    .filter((candidate) => candidate.parentId === null && !candidate.alreadyDrawn)
    .map((candidate) => candidate.id)
}

export type CandidateSize =
  | { kind: 'diameter'; diameter: number }
  | { kind: 'box'; width: number; height: number }

export function candidateSize(candidate: RecognitionCandidate): CandidateSize {
  if (candidate.circle) return { kind: 'diameter', diameter: candidate.circle.radius * 2 }
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const point of candidate.outline) {
    if (point.x < minX) minX = point.x
    if (point.x > maxX) maxX = point.x
    if (point.y < minY) minY = point.y
    if (point.y > maxY) maxY = point.y
  }
  return { kind: 'box', width: maxX - minX, height: maxY - minY }
}

/**
 * The shapes the checked rows draw, in tree order. A boss is drawn exactly
 * when its pocket is: a pocket without its boss would cut the boss away, and a
 * boss without its pocket is material in the middle of nothing. A boss that is
 * already in the project is left alone.
 */
export function shapesToDraw(
  candidates: readonly RecognitionCandidate[],
  checkedIds: ReadonlySet<string>,
  nameOf: (candidate: RecognitionCandidate) => string,
): RecognizedShapeInput[] {
  return candidates
    .filter((candidate) => (
      candidate.parentId === null
        ? checkedIds.has(candidate.id)
        : checkedIds.has(candidate.parentId) && !candidate.alreadyDrawn
    ))
    .map((candidate) => ({
      name: nameOf(candidate),
      profile: candidate.profile,
      operation: candidate.operation,
      zTop: candidate.zTop,
      zBottom: candidate.zBottom,
      face: candidate.face,
    }))
}

const SKIP_ORDER: readonly SkipReason[] = ['taperedWalls', 'undercut', 'openMesh']

/** How many voids were seen but not offered, per reason, in a fixed order. */
export function skippedCounts(skipped: readonly SkippedCavity[]): Array<{ reason: SkipReason; count: number }> {
  return SKIP_ORDER
    .map((reason) => ({ reason, count: skipped.filter((entry) => entry.reason === reason).length }))
    .filter((entry) => entry.count > 0)
}
