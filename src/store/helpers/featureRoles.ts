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
 * Feature-role predicates — the single source of truth for "what kind of
 * entity is this feature?" (issue #199).
 *
 * The codebase used to treat `operation !== 'region'` as the de-facto
 * "machinable feature" test. With the construction role added, that test is
 * wrong: construction geometry is sketch-only reference geometry that must
 * NEVER be consumed by CSG, toolpaths, simulation, or export. Every site that
 * needs to distinguish roles goes through these helpers so the exclusion is
 * structural rather than a convention. The guard test
 * (`src/engine/constructionExclusion.test.ts`) fails the build if construction
 * geometry leaks into a model/CAM input.
 */

import type { FeatureOperation, Project, SketchFeature } from '../../types/project'
import { resolveFeatureInstances } from './resolveFeatures'

/** Anything carrying an operation — SketchFeature or FeatureDefinition. */
interface HasOperation {
  operation: FeatureOperation
}

export type FeatureTreeSection = 'features' | 'regions' | 'construction'

/** Sketch-only reference geometry. Snappable/dimensionable, never machined. */
export function isConstruction(entity: HasOperation): boolean {
  return entity.operation === 'construction'
}

/** Machining-area filter (mask). Not machined itself, but consumed by CAM as a clip. */
export function isRegion(entity: HasOperation): boolean {
  return entity.operation === 'region'
}

/**
 * A real, cuttable feature: add/subtract/model/line. The replacement for the
 * historical `operation !== 'region'` check — regions AND construction are
 * both excluded.
 */
export function isMachinable(entity: HasOperation): boolean {
  return entity.operation !== 'region' && entity.operation !== 'construction'
}

/**
 * A feature that is part of the solid tree for base-solid ordering (add,
 * subtract) or a placeholder solid (imported model). Only add/subtract
 * participate in Manifold boolean CSG; imported Model entries are rendered
 * as overlays and skipped by the boolean pipeline. Line features are
 * machinable path geometry that renders as flat 3D line overlays and never
 * contributes to the solid model.
 */
export function isSolid(entity: HasOperation): boolean {
  return entity.operation === 'add' || entity.operation === 'subtract' || entity.operation === 'model'
}

/**
 * Features the 3D model pipeline (CSG → preview/simulation) may consume.
 * Regions stay included — they render display-only walls — but construction
 * geometry is fully absent from the model.
 */
export function modelFeatures(features: SketchFeature[]): SketchFeature[] {
  return features.filter((feature) => !isConstruction(feature))
}

/** Which feature-tree section an operation belongs to. */
export function sectionForOperation(operation: FeatureOperation | undefined): FeatureTreeSection {
  if (operation === 'region') return 'regions'
  if (operation === 'construction') return 'construction'
  return 'features'
}

/**
 * The shared tree section of a set of features, or null when the set is empty
 * or spans sections. Folders and groups are single-section: machining
 * features, regions, and construction geometry each only group with their own
 * kind.
 */
export function commonSection(entities: HasOperation[]): FeatureTreeSection | null {
  if (entities.length === 0) return null
  const first = sectionForOperation(entities[0].operation)
  return entities.every((entity) => sectionForOperation(entity.operation) === first) ? first : null
}

/** {@link commonSection} over feature ids; unknown ids are ignored. */
export function commonSectionOfIds(project: Project, featureIds: string[]): FeatureTreeSection | null {
  return commonSection(resolveFeatureInstances(project, featureIds))
}
