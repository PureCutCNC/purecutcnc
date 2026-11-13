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
 * Feature References Resolver — composes definition + instance transform into
 * world-space resolved features for canvas, hit testing, toolpaths, and export.
 *
 * All read paths that need world geometry should go through these helpers.
 * Serialized rows are always lightweight instances; resolved geometry is an
 * ephemeral runtime view and must not be stored in the project or history.
 */

import type {
  FeatureDefinition,
  FeatureInstance,
  Matrix2D,
  Point,
  Project,
  Sketch,
  SketchFeature,
  SketchProfile,
  STLFeatureData,
} from '../../types/project'
import { cloneCannedShapeData, cloneTextFeatureData, cloneTextLayout } from '../../types/project'
import { transformProfile as transformProfileAffine } from '../../geometry/profile'
import { applyMatrixToPoint, transformProfileByMatrix } from '../../geometry/profileMatrix'

export {
  applyMatrixToPoint,
  isIdentityMatrix,
  isCirclePreservingTransform,
  isMirrorTransform,
  transformProfileByMatrix,
} from '../../geometry/profileMatrix'
import { getTextFrameProfile } from '../../text'
import { cannedShapeFrame } from '../../cannedShapes'
import { multiplyMatrix, translateMatrix } from './instanceTransforms'

// ============================================================================
// Resolved feature shape
// ============================================================================

/**
 * World-space read model derived from a definition and a lightweight instance.
 * It must never be stored back into Project or undo history.
 */
export interface ResolvedSketchFeature {
  /** Instance (feature row) ID. */
  id: string
  /** Instance name. */
  name: string
  /** Source definition ID. */
  definitionId: string
  /** Instance / feature row ID (same as `id`). Kept for clarity. */
  instanceId: string
  transform: Matrix2D
  kind: FeatureDefinition['kind']
  text: FeatureDefinition['text']
  /** Canned-shape kind and parameters (definition-owned). */
  canned: FeatureDefinition['canned']
  /** Per-instance curved baseline, resolved into world space alongside `sketch`. */
  textLayout: FeatureInstance['textLayout']
  stl: FeatureDefinition['stl']
  folderId: FeatureInstance['folderId']
  /** World-space sketch — profile is the resolved definition profile. */
  sketch: Sketch
  operation: FeatureDefinition['operation']
  regionMaskMode: FeatureDefinition['regionMaskMode']
  z_top: FeatureInstance['z_top']
  z_bottom: FeatureInstance['z_bottom']
  authoringFace: FeatureInstance['authoringFace']
  visible: FeatureInstance['visible']
  locked: FeatureInstance['locked']
}

/**
 * Ephemeral project read model with world-space feature geometry. This view is
 * safe to pass through rendering and CAM code, but must never be persisted or
 * stored in undo history.
 */
export type ResolvedProject = Omit<Project, 'features'> & {
  features: ResolvedSketchFeature[]
}

/**
 * Resolve a definition's canonical profile through an instance transform into
 * world-space geometry.
 *
 * - Lines: endpoints are transformed directly.
 * - Beziers: control points and endpoints are transformed directly.
 * - Arcs: converted to beziers first (affine transforms turn arcs into
 *   elliptical arcs which the profile representation cannot express), then
 *   each bezier is transformed.
 * - Circles: if the transform is circle-preserving the result stays a native
 *   circle (center / start / radius recomputed).  Otherwise the circle is
 *   converted to four bezier segments and each is transformed.
 * - Mirror transforms flip `clockwise` on circle segments.
 */
export function resolveProfile(
  definition: FeatureDefinition,
  transform: Matrix2D,
): SketchProfile {
  return transformProfileByMatrix(definition.profile, transform)
}

/**
 * Build a resolved world-space {@link Sketch} from a definition and transform.
 *
 * - `profile` — definition profile resolved through the transform.
 * - `origin` — set to {0, 0} (placement is fully encoded in the transform).
 * - `orientationAngle` — set to 0.
 * - `dimensions` — copied from the definition (canonical dimensions).
 * - `constraints` — empty; per-instance constraints are layered on by the
 *    feature-instance resolver.
 */
export function resolveSketch(
  definition: FeatureDefinition,
  transform: Matrix2D,
): Sketch {
  return {
    profile: resolveProfile(definition, transform),
    origin: { x: 0, y: 0 },
    orientationAngle: 0,
    dimensions: definition.dimensions.map((d) => ({ ...d })),
    constraints: [],
  }
}

// ============================================================================
// Feature resolution
// ============================================================================

/**
 * Look up a feature definition by ID.  Returns `null` when not found.
 */
export function resolveFeatureDefinition(
  project: Project,
  definitionId: string,
): FeatureDefinition | null {
  return project.featureDefinitions[definitionId] ?? null
}

/**
 * Determine the definition and transform for an authoritative instance.
 * Returns `null` when its required definition is missing.
 */
function resolveDefinitionAndTransform(
  project: Project,
  feature: FeatureInstance,
): { definition: FeatureDefinition; transform: Matrix2D } | null {
  const definition = project.featureDefinitions[feature.definitionId]
  if (!definition) return null

  return {
    definition,
    transform: feature.transform,
  }
}

/** Copy STL data, transforming silhouette paths if present. */
function resolveStlData(
  stl: STLFeatureData | null | undefined,
  transformPoint: (p: Point) => Point,
): STLFeatureData | null {
  if (!stl) return null
  const resolved: STLFeatureData = { ...stl }
  if (resolved.silhouettePaths) {
    resolved.silhouettePaths = resolved.silhouettePaths.map((path) =>
      path.map((p) => transformPoint(p)),
    )
  }
  return resolved
}

/**
 * Resolve a single feature row into a world-space {@link ResolvedSketchFeature}.
 *
 * - Finds the matching definition by the instance's required `definitionId`.
 * - Applies the required instance transform.
 * - Returns `null` when the definition is missing.
 */
export function resolveFeatureInstance(
  project: Project,
  instanceOrFeatureId: string,
): ResolvedSketchFeature | null {
  const feature = project.features.find((f) => f.id === instanceOrFeatureId)
  if (!feature) return null

  return resolveFeatureRow(project, feature)
}

/** Resolve an authoritative row that is stored outside Project.features (stock source). */
export function resolveFeatureRow(
  project: Project,
  feature: FeatureInstance,
): ResolvedSketchFeature | null {

  const resolved = resolveDefinitionAndTransform(project, feature)
  if (!resolved) return null

  const { definition, transform } = resolved
  const sketch = resolveSketch(definition, transform)

  // A curved run's frame is *derived*, not stored. The frame is the only thing
  // setting a run's proportions, so the definition's straight rect would squeeze
  // the bent template into the wrong aspect. Deriving it from the bent template
  // in definition-local space and letting the instance transform carry it into
  // the world makes the template-bounds-to-frame mapping exactly that transform
  // — and keeps the baseline per-instance, since the frame is per-instance too.
  if (definition.text && feature.textLayout) {
    sketch.profile = transformProfileAffine(
      getTextFrameProfile({
        text: definition.text.text,
        style: definition.text.style,
        fontId: definition.text.fontId,
        size: definition.text.size,
        operation: definition.operation,
        layout: feature.textLayout,
      }, { x: 0, y: 0 }),
      (point) => applyMatrixToPoint(transform, point),
    )
  }

  // A canned shape's frame is derived from its parameters for the same reason:
  // the parameters are authoritative, so a stale stored frame can never make
  // selection bounds or placement lag behind the geometry (issue #1112).
  if (definition.canned) {
    const frame = cannedShapeFrame(definition.canned)
    if (frame) {
      sketch.profile = transformProfileAffine(frame, (point) => applyMatrixToPoint(transform, point))
    }
  }
  // Layer per-instance constraints onto the resolved sketch.
  sketch.constraints = feature.constraints.map((c) => ({ ...c }))

  const transformPoint = (p: Point) => applyMatrixToPoint(transform, p)

  return {
    id: feature.id,
    name: feature.name,
    definitionId: definition.id,
    instanceId: feature.id,
    transform,
    kind: definition.kind,
    text: cloneTextFeatureData(definition.text),
    canned: cloneCannedShapeData(definition.canned),
    // The baseline is the instance's, not the definition's, so two copies of
    // one text run can wrap two different circles.
    textLayout: cloneTextLayout(feature.textLayout),
    stl: resolveStlData(definition.stl, transformPoint),
    folderId: feature.folderId,
    sketch,
    operation: definition.operation,
    regionMaskMode: definition.operation === 'region' ? (definition.regionMaskMode ?? 'include') : undefined,
    z_top: feature.z_top,
    z_bottom: feature.z_bottom,
    authoringFace: feature.authoringFace,
    visible: feature.visible,
    locked: feature.locked,
  }
}

/**
 * Resolve multiple feature rows.
 *
 * - When `ids` is omitted every feature row is resolved.
 * - Features whose definition is missing are **skipped** (not present in the
 *   result array) so callers don't crash on missing data.
 * - Preserves the order of `ids` when provided, or the project feature order
 *   when resolving all.
 */
export function resolveFeatureInstances(
  project: Project,
  ids?: string[],
): ResolvedSketchFeature[] {
  if (!ids) return resolvedProjectFeatures(project)
  const featureById = new Map(project.features.map((feature) => [feature.id, feature]))
  const result: ResolvedSketchFeature[] = []
  for (const id of ids) {
    const feature = featureById.get(id)
    const resolved = feature ? resolveFeatureRow(project, feature) : null
    if (resolved) result.push(resolved)
  }
  return result
}

/**
 * Resolve every feature row in the project into a world-space
 * {@link ResolvedSketchFeature}.  Read paths that need placed/world geometry
 * should use this (or {@link resolvedFeatureMap}) instead of reading
 * `project.features` directly.
 * Instances with missing definitions are omitted.
 */
export function resolvedProjectFeatures(project: Project): ResolvedSketchFeature[] {
  return project.features.flatMap((feature) => {
    const resolved = resolveFeatureRow(project, feature)
    return resolved ? [resolved] : []
  })
}

/** Build an ephemeral geometry-bearing project view for legacy read APIs. */
export function resolveProject(project: Project): ResolvedProject {
  return {
    ...project,
    features: resolvedProjectFeatures(project),
  }
}

/** Convert a resolved read row back to its lightweight authoritative row. */
export function featureInstanceFromResolved(
  feature: ResolvedSketchFeature,
): FeatureInstance {
  return {
    id: feature.id,
    name: feature.name,
    definitionId: feature.definitionId,
    transform: { ...feature.transform },
    textLayout: cloneTextLayout(feature.textLayout),
    constraints: feature.sketch.constraints.map((constraint) => ({ ...constraint })),
    z_top: feature.z_top,
    z_bottom: feature.z_bottom,
    authoringFace: feature.authoringFace,
    folderId: feature.folderId,
    visible: feature.visible,
    locked: feature.locked,
  }
}

/** Reattach resolver-only metadata after a legacy geometry helper returns rows. */
export function restoreResolvedFeatureMetadata(
  source: ResolvedSketchFeature[],
  features: SketchFeature[],
): ResolvedSketchFeature[] {
  const sourceById = new Map(source.map((feature) => [feature.id, feature]))
  return features.flatMap((feature) => {
    const resolved = sourceById.get(feature.id)
    if (!resolved) return []
    return [{
      ...resolved,
      ...feature,
      sketch: feature.sketch,
    }]
  })
}

function matricesEqual(a: Matrix2D, b: Matrix2D): boolean {
  return a.a === b.a && a.b === b.b && a.c === b.c && a.d === b.d
    && a.e === b.e && a.f === b.f
}

/**
 * Fold an edited resolved view back into lightweight instance state. Definition
 * geometry is intentionally untouched; profile translation deltas become
 * instance transforms and constraints remain per-instance.
 */
export function commitResolvedInstances(
  project: Project,
  editedFeatures: ResolvedSketchFeature[],
): FeatureInstance[] {
  const expected = resolvedFeatureMap(project)
  const edited = new Map(editedFeatures.map((feature) => [feature.id, feature]))
  return project.features.flatMap((instance) => {
    const expectedFeature = expected.get(instance.id)
    const editedFeature = edited.get(instance.id)
    if (!editedFeature) return [instance]
    if (!expectedFeature) return [instance]

    const transformChanged = !matricesEqual(instance.transform, editedFeature.transform)
    const dx = editedFeature.sketch.profile.start.x - expectedFeature.sketch.profile.start.x
    const dy = editedFeature.sketch.profile.start.y - expectedFeature.sketch.profile.start.y
    const transform = transformChanged
      ? { ...editedFeature.transform }
      : dx === 0 && dy === 0
        ? instance.transform
        : multiplyMatrix(translateMatrix(dx, dy), instance.transform)

    return [{
      id: editedFeature.id,
      name: editedFeature.name,
      definitionId: editedFeature.definitionId,
      transform,
      constraints: editedFeature.sketch.constraints.map((constraint) => ({ ...constraint })),
      z_top: editedFeature.z_top,
      z_bottom: editedFeature.z_bottom,
      authoringFace: editedFeature.authoringFace,
      folderId: editedFeature.folderId,
      visible: editedFeature.visible,
      locked: editedFeature.locked,
    }]
  })
}

/**
 * Resolve every feature row into a `Map<featureId, ResolvedSketchFeature>` for
 * O(1) lookup. Explicit missing-definition features are omitted.
 */
export function resolvedFeatureMap(project: Project): Map<string, ResolvedSketchFeature> {
  const map = new Map<string, ResolvedSketchFeature>()
  for (const resolved of resolvedProjectFeatures(project)) {
    map.set(resolved.id, resolved)
  }
  return map
}
