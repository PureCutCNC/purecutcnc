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
 * Feature Definition Helpers — definition/instance creation, operation
 * propagation, definition clone, and Make Unique logic for feature references
 * definition/instance split.
 *
 * Reuses resolution helpers from {@link resolveFeatures.ts} rather than
 * duplicating profile/matrix math.
 */

import type {
  FeatureDefinition,
  FeatureInstance,
  FeatureKind,
  FeatureOperation,
  LocalDimension,
  Matrix2D,
  Point,
  Project,
  RegionMaskMode,
  SketchFeature,
  SketchProfile,
} from '../../types/project'
import { IDENTITY_MATRIX } from '../../types/project'
import { nextUniqueGeneratedId } from './ids'

// ============================================================================
// Definition ID resolution
// ============================================================================

/**
 * Determine the definition ID for an authoritative feature instance.
 */
export function getDefinitionId(feature: Pick<FeatureInstance, 'definitionId'>): string {
  return feature.definitionId
}

// ============================================================================
// Instance lookup
// ============================================================================

/**
 * Return the IDs of every feature instance that references `definitionId`.
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

/**
 * For a bulk operation edit, write the requested operation to every definition
 * referenced by `changedIds`. Linked sibling instances share that definition,
 * so only their folder placement must be reconciled to the new tree section.
 */
export function propagateOperationToLinkedInstances(
  features: FeatureInstance[],
  definitions: Record<string, FeatureDefinition>,
  changedIds: ReadonlySet<string>,
  operation: FeatureOperation,
  reconcileFolderId: (folderId: string | null, operation: FeatureOperation) => string | null,
): { features: FeatureInstance[]; definitions: Record<string, FeatureDefinition> } {
  const changedDefinitionIds = new Set<string>()
  for (const feature of features) {
    if (!changedIds.has(feature.id)) continue
    if (definitions[feature.definitionId] !== undefined) {
      changedDefinitionIds.add(feature.definitionId)
    }
  }
  if (changedDefinitionIds.size === 0) {
    return { features, definitions }
  }

  let nextDefinitions = definitions
  for (const defId of changedDefinitionIds) {
    nextDefinitions = {
      ...nextDefinitions,
      [defId]: {
        ...nextDefinitions[defId],
        operation,
        regionMaskMode: operation === 'region' ? (nextDefinitions[defId].regionMaskMode ?? 'include') : undefined,
      },
    }
  }

  const nextFeatures = features.map((feature) => {
    if (!changedDefinitionIds.has(feature.definitionId)) return feature
    const folderId = reconcileFolderId(feature.folderId, operation)
    if (folderId === feature.folderId) return feature
    return {
      ...feature,
      folderId,
    }
  })

  return { features: nextFeatures, definitions: nextDefinitions }
}

// ============================================================================
// Definition creation (snapshot + live-feature minting)
// ============================================================================

export interface CreateSnapshotDefinitionParams {
  profile: SketchProfile
  kind: FeatureKind
  operation: FeatureOperation
  regionMaskMode?: RegionMaskMode
}

function definitionRegionMaskMode(
  operation: FeatureOperation,
  mode?: RegionMaskMode,
): RegionMaskMode | undefined {
  if (operation !== 'region') {
    return undefined
  }
  return mode === 'exclude' ? 'exclude' : 'include'
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
    regionMaskMode: definitionRegionMaskMode(params.operation, params.regionMaskMode),
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
  return createDefinitionForFeatureWithId(feature, definitionId)
}

/**
 * Build a feature definition with an ID reserved by a caller-owned bulk
 * allocator. This keeps definition cloning policy centralized without doing
 * a full project ID scan for every feature in a large import.
 */
export function createDefinitionForFeatureWithId(
  feature: SketchFeature,
  definitionId: string,
): { definitionId: string; definition: FeatureDefinition } {
  const definition: FeatureDefinition = {
    id: definitionId,
    kind: feature.kind,
    profile: cloneProfile(feature.sketch.profile),
    dimensions: cloneDimensions(feature.sketch.dimensions),
    text: feature.text ? { ...feature.text } : null,
    stl: feature.stl ? { ...feature.stl } : null,
    operation: feature.operation,
    regionMaskMode: definitionRegionMaskMode(feature.operation, feature.regionMaskMode),
  }
  return { definitionId, definition }
}

/**
 * Create the lightweight project row for a geometry-bearing feature draft.
 * Shape data remains exclusively in the matching definition.
 */
export function createFeatureInstance(
  feature: SketchFeature,
  definitionId: string,
  transform: Matrix2D = IDENTITY_MATRIX,
): FeatureInstance {
  return {
    id: feature.id,
    name: feature.name,
    definitionId,
    transform: { ...transform },
    constraints: feature.sketch.constraints.map((constraint) => ({ ...constraint })),
    z_top: feature.z_top,
    z_bottom: feature.z_bottom,
    folderId: feature.folderId,
    visible: feature.visible,
    locked: feature.locked,
  }
}

// ============================================================================
// Definition GC
// ============================================================================

/**
 * Given a list of feature rows after removing consumed instances, remove
 * definitions with no remaining tree instance or feature-based stock source.
 *
 * Returns the updated definitions map and a set of removed definition IDs
 * (useful for undo/redo sanity checks).
 */
export function gcOrphanedDefinitions(
  features: FeatureInstance[],
  definitions: Record<string, FeatureDefinition>,
  stockSource: FeatureInstance | null | undefined = null,
): { definitions: Record<string, FeatureDefinition>; removedIds: Set<string> } {
  const referenced = new Set<string>()
  for (const feature of features) {
    const defId = getDefinitionId(feature)
    if (defId && definitions[defId]) {
      referenced.add(defId)
    }
  }
  if (stockSource && definitions[stockSource.definitionId]) {
    referenced.add(stockSource.definitionId)
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
  features: FeatureInstance[]
}

/**
 * Clone the definition and repoint the selected instance so subsequent
 * definition edits no longer affect it.
 *
 * - Clones the definition under a fresh ID.
 * - Sets the instance's explicit `definitionId` to the clone.
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

  const updatedFeature: FeatureInstance = {
    ...feature,
    definitionId: newId,
  }

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
