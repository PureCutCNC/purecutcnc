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
 * Shape-action (join / cut) selection eligibility — the single source of truth
 * for "has the selection already said enough to skip the workflow panel?"
 * (issue #522).
 *
 * The join panel does two different jobs. With no group selected it is a
 * *picking mode*: clicking shapes on canvas builds the group. With the group
 * already selected it is only a *confirmation*, and that is the half an
 * external report asked us to drop — "if I've already decided that I want to
 * unite two shapes, why do I still get asked whether I want to unite two
 * shapes?"
 *
 * Every clause below exists so the shortcut does exactly what confirming the
 * panel at its defaults would have done, and **drops nothing**. Anything that
 * fails falls back to the panel unchanged, so no capability is removed — the
 * panel is short-circuited, never replaced.
 *
 * Both predicates must stay in this file. Join is reachable from the toolbar,
 * the feature-tree context menu, keyboard commands, and the e2e test hooks; a
 * rule re-spelled per call site would drift.
 */

import type { Project } from '../../types/project'
import { featuresFormConnectedOverlapGroup } from './clipping'
import { resolveFeatureInstances } from './resolveFeatures'

/**
 * True when `featureIds` can be joined immediately, with no confirmation panel.
 *
 * Requires, in order:
 * 1. at least two features — one shape is a picking session, not a join;
 * 2. every id resolves — a stale id would silently shrink the operation;
 * 3. every profile closed — `mergeSelectedFeatures` filters open profiles out,
 *    so an open member would vanish with no prompt;
 * 4. nothing locked — matches the feature-tree context menu, which already
 *    disables Join on a locked selection;
 * 5. no text feature and no imported model — the union discards the text/mesh
 *    identity and leaves a plain profile, which is too surprising to do silently;
 * 6. one shared operation — the union inherits the first feature's operation, so
 *    a mixed add/subtract selection silently reassigns roles. This also subsumes
 *    the tree-section rule: same operation implies same section;
 * 7. one connected overlap group — `startJoinSelectedFeatures` otherwise narrows
 *    to the *largest* connected group, so a selection with a stray member is a
 *    partial qualification and must keep its confirmation.
 */
export function selectionQualifiesForImmediateJoin(project: Project, featureIds: string[]): boolean {
  if (featureIds.length < 2) {
    return false
  }

  const features = resolveFeatureInstances(project, featureIds)
  if (features.length !== featureIds.length) {
    return false
  }

  if (features.some((feature) => !feature.sketch.profile.closed || feature.locked)) {
    return false
  }

  if (features.some((feature) => feature.kind === 'text' || feature.operation === 'model')) {
    return false
  }

  const operation = features[0].operation
  if (features.some((feature) => feature.operation !== operation)) {
    return false
  }

  return featuresFormConnectedOverlapGroup(features)
}

/**
 * True when `featureIds` unambiguously names the cutter for a cut, letting the
 * flow open straight on target selection instead of re-asking for cutters.
 *
 * Deliberately limited to a single feature. With two or more selected, which
 * ones are cutters and which are targets is genuinely ambiguous — the two cut
 * paths in the store already disagree (`startCutSelectedFeatures` treats the
 * whole selection as cutters, `cutSelectedFeatures` treats the last as the
 * cutter and the rest as targets) — so that case keeps the cutter phase.
 *
 * The cut itself is never skipped: targets cannot be inferred from a selection
 * that was consumed as the cutter.
 */
export function selectionQualifiesAsCutCutter(project: Project, featureIds: string[]): boolean {
  if (featureIds.length !== 1) {
    return false
  }

  const features = resolveFeatureInstances(project, featureIds)
  return features.length === 1 && !features[0].locked
}
