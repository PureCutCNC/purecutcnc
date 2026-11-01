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
 * The main-thread half of the "no effect" analysis input (issue #1112 N).
 *
 * The engine module is pure and only needs closed outlines, operations, spans
 * and faces. Resolving those belongs on this side: Text and canned flat shapes
 * generate several real outlines (a gear and its bore, a run of glyphs), and a
 * placement frame would be exactly the kind of approximation that produces a
 * wrong warning. `resolveFeatureGeometryShapes` is the same seam the model,
 * CAM and line rendering read, so the warning is judged on the geometry that
 * is actually folded.
 *
 * Models (imported STL and the canned Turn/Polygon) are excluded here rather
 * than filtered later: they carry a mesh, not a flat outline, and decision 12
 * says they are never warned about.
 */

import { resolveFeatureGeometryShapes } from '../../text'
import { aroundFeaturesActive } from '../../store/helpers/projectType'
import type { ResolvedSketchFeature } from '../../store/helpers/resolveFeatures'
import { isRoundStock, type DimensionRef, type Project } from '../../types/project'
import type { FeatureEffectFeature, FeatureEffectShape } from '../../engine/featureEffect'

/**
 * The same Z resolution the model uses (`csg.ts`): a named dimension first, a
 * finite numeric string second. This is deliberately not the throwing
 * `resolveDimensionRef`, so a row with a dangling name is left out of the
 * analysis instead of taking the tree down for a warning that may not matter.
 */
function zValue(project: Project, ref: DimensionRef): number | null {
  if (typeof ref === 'number') return Number.isFinite(ref) ? ref : null
  const named = project.dimensions[ref]
  if (named) return named.value
  const parsed = Number.parseFloat(ref)
  return Number.isFinite(parsed) ? parsed : null
}

function effectShapes(feature: ResolvedSketchFeature): FeatureEffectShape[] {
  return resolveFeatureGeometryShapes(feature).map((shape) => ({
    profile: shape.profile,
    operation: shape.operation,
  }))
}

/**
 * Build the analysis input in tree-fold order. Every flat add/subtract row is
 * included — hidden rows too, so an unrelated visibility toggle does not
 * renumber the rest of the tree — while models, Lines, Regions, construction
 * geometry and Around rows on a project that does not model the sheet are
 * absent. The engine decides everything else.
 */
export function buildEffectFeatures(
  project: Project,
  features: readonly ResolvedSketchFeature[],
): FeatureEffectFeature[] {
  const aroundModelled = isRoundStock(project.stock) && aroundFeaturesActive(project)
  const result: FeatureEffectFeature[] = []

  for (const feature of features) {
    if (feature.operation !== 'add' && feature.operation !== 'subtract') continue
    if (feature.kind === 'stl') continue
    const face = feature.authoringFace ?? 'top'
    // Around work only folds on a rotary round bar (#395/#1052). On any other
    // stock its rows are kept but not modelled, which is the K warning's
    // subject, not this one.
    if (face === 'around' && !aroundModelled) continue

    const zTop = zValue(project, feature.z_top)
    const zBottom = zValue(project, feature.z_bottom)
    // A dangling dimension reference is a malformed file; leave the row out
    // rather than inventing a span and warning on it.
    if (zTop === null || zBottom === null) continue

    result.push({
      id: feature.id,
      operation: feature.operation,
      face,
      zTop,
      zBottom,
      visible: feature.visible,
      shapes: effectShapes(feature),
    })
  }
  return result
}
