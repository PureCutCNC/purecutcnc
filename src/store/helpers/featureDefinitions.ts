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
 * Feature Definition Helpers — definition mutation, instance re-bake,
 * definition clone, and Make Unique logic for the feature references
 * definition/instance split.
 *
 * Reuses resolution helpers from {@link resolveFeatures.ts} rather than
 * duplicating profile/matrix math.
 */

import type {
  FeatureDefinition,
  FeatureKind,
  FeatureOperation,
  LocalDimension,
  Matrix2D,
  Point,
  Project,
  SketchFeature,
  SketchProfile,
} from '../../types/project'
import { IDENTITY_MATRIX, inferFeatureKind } from '../../types/project'
import { nextUniqueGeneratedId } from './ids'
import { resolveProfile } from './resolveFeatures'

// ============================================================================
// Definition ID resolution
// ============================================================================

/**
 * Determine the definition ID for a feature row.
 *
 * - Explicit `definitionId` takes precedence.
 * - Transitional rows without an explicit `definitionId` fall back to
 *   `feature.id` (the slice 01 migration creates one definition per legacy
 *   feature under the feature ID).
 */
export function getDefinitionId(feature: SketchFeature): string {
  const withRefs = feature as SketchFeature & {
    definitionId?: string
    transform?: Matrix2D
  }
  return withRefs.definitionId ?? feature.id
}

// ============================================================================
// Instance lookup
// ============================================================================

/**
 * Return the IDs of every feature row in `project.features` that references
 * `definitionId` (either via explicit `definitionId` or transitional fallback
 * to `feature.id`).
 */
export function getInstanceIdsForDefinition(
  project: Project,
  definitionId: string,
): string[] {
  const ids: string[] = []
  for (const feature of project.features) {
    if (getDefinitionId(feature) === definitionId) {
      ids.push(feature.id)
    }
  }
  return ids
}

// ============================================================================
// Definition creation (snapshot + live-feature minting)
// ============================================================================

export interface CreateSnapshotDefinitionParams {
  profile: SketchProfile
  kind: FeatureKind
  operation: FeatureOperation
}

/**
 * Mint a new definition ID (reusing the project id system) and create a
 * snapshot {@link FeatureDefinition} whose profile is the world-space
 * result of a boolean / offset / join operation.
 *
 * The returned definition is NOT yet merged into
 * `project.featureDefinitions` — callers merge it in the same store
 * mutation that creates the result feature rows.
 */
export function createSnapshotDefinition(
  project: Project,
  params: CreateSnapshotDefinitionParams,
): { definitionId: string; definition: FeatureDefinition } {
  const definitionId = nextUniqueGeneratedId(project, 'def-')
  const definition: FeatureDefinition = {
    id: definitionId,
    kind: params.kind,
    profile: cloneProfile(params.profile),
    dimensions: [],
    text: null,
    stl: null,
    operation: params.operation,
  }
  return { definitionId, definition }
}

/**
 * Mint a {@link FeatureDefinition} from a fully-normalized runtime
 * {@link SketchFeature}.  This is the shared helper used by `addFeature`
 * (central creation chokepoint) and by import bulk paths so that every
 * created feature gets a definition + identity-transform instance.
 *
 * The returned definition is NOT yet merged into
 * `project.featureDefinitions` — callers merge it in the same store
 * mutation that inserts the feature row.
 */
export function createDefinitionForFeature(
  project: Project,
  feature: SketchFeature,
): { definitionId: string; definition: FeatureDefinition } {
  const definitionId = nextUniqueGeneratedId(project, 'f-')
  const definition: FeatureDefinition = {
    id: definitionId,
    kind: feature.kind,
    profile: cloneProfile(feature.sketch.profile),
    dimensions: cloneDimensions(feature.sketch.dimensions),
    text: feature.text ? { ...feature.text } : null,
    stl: feature.stl ? { ...feature.stl } : null,
    operation: feature.operation,
  }
  return { definitionId, definition }
}

// ============================================================================
// Definition GC
// ============================================================================

/**
 * Given a list of feature rows after removing consumed instances, remove
 * any definitions that have zero remaining instances.
 *
 * Returns the updated definitions map and a set of removed definition IDs
 * (useful for undo/redo sanity checks).
 */
export function gcOrphanedDefinitions(
  features: SketchFeature[],
  definitions: Record<string, FeatureDefinition>,
): { definitions: Record<string, FeatureDefinition>; removedIds: Set<string> } {
  const referenced = new Set<string>()
  for (const feature of features) {
    const defId = getDefinitionId(feature)
    if (defId && definitions[defId]) {
      referenced.add(defId)
    }
  }

  const nextDefinitions = { ...definitions }
  const removedIds = new Set<string>()
  for (const defId of Object.keys(nextDefinitions)) {
    if (!referenced.has(defId)) {
      delete nextDefinitions[defId]
      removedIds.add(defId)
    }
  }

  return { definitions: nextDefinitions, removedIds }
}

// ============================================================================
// Re-bake
// ============================================================================

export interface RebakeOptions {
  /**
   * When set, this feature's compatibility profile is baked with the
   * **identity** transform so the canvas shows definition-local geometry
   * during sketch edit.  All other instances still bake through their own
   * transform.
   */
  editingFeatureId?: string
}

/**
 * Re-bake the compatibility `sketch.profile` (and `kind` / `origin` /
 * `orientationAngle`) of every feature row that references `definitionId`.
 *
 * Each instance's profile is recomputed via
 * {@link resolveProfile}(definition, instance.transform) so linked instances
 * and un-migrated direct readers all stay correct after a definition edit.
 *
 * When `options.editingFeatureId` is provided that feature gets the raw
 * definition-local profile (identity transform) so the sketch editor can
 * operate in canonical definition space.
 */
export function rebakeAllInstances(
  project: Project,
  definitionId: string,
  options?: RebakeOptions,
): SketchFeature[] {
  const definition = project.featureDefinitions[definitionId]
  if (!definition) return project.features

  const editingId = options?.editingFeatureId

  return project.features.map((feature) => {
    if (getDefinitionId(feature) !== definitionId) return feature

    const withRefs = feature as SketchFeature & {
      definitionId?: string
      transform?: Matrix2D
    }
    const transform: Matrix2D =
      editingId && feature.id === editingId
        ? IDENTITY_MATRIX
        : withRefs.transform ?? IDENTITY_MATRIX

    const profile = resolveProfile(definition, transform)

    // Rebuild the compatibility sketch from the resolved profile.
    const sketch = {
      ...feature.sketch,
      profile,
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
    }

    return {
      ...feature,
      kind:
        feature.kind === 'text' || feature.kind === 'stl'
          ? feature.kind
          : inferFeatureKind(profile),
      sketch,
    }
  })
}

// ============================================================================
// Definition clone
// ============================================================================

let nextDefinitionCloneSuffix = 1

function generateDefinitionCloneId(project: Project): string {
  while (
    project.featureDefinitions[
      `def-clone-${nextDefinitionCloneSuffix}`
    ] !== undefined
  ) {
    nextDefinitionCloneSuffix += 1
  }
  return `def-clone-${nextDefinitionCloneSuffix}`
}

/** Deep-clone a definition under a new ID. */
function cloneDefinition(
  definition: FeatureDefinition,
  newId: string,
): FeatureDefinition {
  return {
    ...definition,
    id: newId,
    profile: cloneProfile(definition.profile),
    dimensions: definition.dimensions.map((d) => ({ ...d })),
    text: definition.text ? { ...definition.text } : null,
    stl: definition.stl ? { ...definition.stl } : null,
  }
}

// ============================================================================
// Make Unique
// ============================================================================

export interface MakeUniqueResult {
  /** The new definition id. */
  newDefinitionId: string
  /** The cloned definition. */
  clonedDefinition: FeatureDefinition
  /** Features array with the instance repointed to the cloned definition. */
  features: SketchFeature[]
}

/**
 * Clone the definition and repoint the selected instance so subsequent
 * definition edits no longer affect it.
 *
 * - Clones the definition under a fresh ID.
 * - Sets the instance's explicit `definitionId` to the clone.
 * - Re-bakes the instance's compatibility profile.
 *
 * Other instances of the original definition are unaffected.
 */
export function makeUnique(
  project: Project,
  instanceId: string,
): MakeUniqueResult | null {
  const feature = project.features.find((f) => f.id === instanceId)
  if (!feature) return null

  const definitionId = getDefinitionId(feature)
  const definition = project.featureDefinitions[definitionId]
  if (!definition) return null

  const newId = generateDefinitionCloneId(project)
  const clonedDef = cloneDefinition(definition, newId)

  const withRefs = feature as SketchFeature & {
    definitionId?: string
    transform?: Matrix2D
  }
  const transform = withRefs.transform ?? IDENTITY_MATRIX
  const profile = resolveProfile(clonedDef, transform)

  const updatedFeature = {
    ...feature,
    definitionId: newId,
    kind:
      feature.kind === 'text' || feature.kind === 'stl'
        ? feature.kind
        : inferFeatureKind(profile),
    sketch: {
      ...feature.sketch,
      profile,
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
    },
  } as SketchFeature & { definitionId?: string; transform?: Matrix2D }

  const features = project.features.map((f) =>
    f.id === instanceId ? updatedFeature : f,
  )

  return {
    newDefinitionId: newId,
    clonedDefinition: clonedDef,
    features,
  }
}

// ============================================================================
// Profile utilities (inline to avoid circular deps)
// ============================================================================

function clonePoint(p: Point): Point {
  return { x: p.x, y: p.y }
}

function cloneSegment(
  seg: SketchProfile['segments'][number],
): SketchProfile['segments'][number] {
  const cloned = { ...seg } as Record<string, unknown>
  // Clone nested Point objects
  for (const key of Object.keys(cloned)) {
    const val = cloned[key]
    if (val && typeof val === 'object' && 'x' in (val as object)) {
      cloned[key] = clonePoint(val as unknown as Point)
    }
  }
  return cloned as SketchProfile['segments'][number]
}

function cloneProfile(profile: SketchProfile): SketchProfile {
  return {
    start: clonePoint(profile.start),
    segments: profile.segments.map(cloneSegment),
    closed: profile.closed,
  }
}

function cloneDimensions(dimensions: LocalDimension[]): LocalDimension[] {
  return dimensions.map((d) => ({ ...d }))
}
