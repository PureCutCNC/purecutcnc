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
 * All read paths that need world geometry should go through these helpers so
 * consumers never need to know whether a feature is a plain row or an instance
 * of a shared definition.
 */

import type {
  FeatureDefinition,
  Matrix2D,
  Point,
  Project,
  Segment,
  Sketch,
  SketchFeature,
  SketchProfile,
  STLFeatureData,
} from '../../types/project'
import { IDENTITY_MATRIX } from '../../types/project'

// ============================================================================
// Resolved feature shape
// ============================================================================

/**
 * World-space resolved feature — compatible with today's {@link SketchFeature}
 * consumers but carries explicit definition/instance provenance.
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
  kind: SketchFeature['kind']
  text: SketchFeature['text']
  stl: SketchFeature['stl']
  folderId: SketchFeature['folderId']
  /** World-space sketch — profile is the resolved definition profile. */
  sketch: Sketch
  operation: SketchFeature['operation']
  z_top: SketchFeature['z_top']
  z_bottom: SketchFeature['z_bottom']
  visible: SketchFeature['visible']
  locked: SketchFeature['locked']
}

// ============================================================================
// Matrix helpers
// ============================================================================

const EPSILON = 1e-9

/**
 * Apply a 2D affine matrix to a point.
 *   x' = a·x + c·y + e
 *   y' = b·x + d·y + f
 */
export function applyMatrixToPoint(m: Matrix2D, p: Point): Point {
  return {
    x: m.a * p.x + m.c * p.y + m.e,
    y: m.b * p.x + m.d * p.y + m.f,
  }
}

/** True when the matrix is the identity (or within epsilon). */
export function isIdentityMatrix(m: Matrix2D): boolean {
  return (
    Math.abs(m.a - 1) <= EPSILON &&
    Math.abs(m.b) <= EPSILON &&
    Math.abs(m.c) <= EPSILON &&
    Math.abs(m.d - 1) <= EPSILON &&
    Math.abs(m.e) <= EPSILON &&
    Math.abs(m.f) <= EPSILON
  )
}

/**
 * True when the linear part of the matrix maps circles to circles (no shear,
 * uniform scale).  A circle under a circle-preserving transform stays a circle
 * with a scaled radius.
 *
 * Conditions (within epsilon):
 *   a² + b² ≈ c² + d²     (equal scale in both axes — no aspect‑ratio change)
 *   a·c + b·d ≈ 0         (rows perpendicular — no shear)
 *
 * These ensure the 2×2 submatrix is a scalar multiple of an orthogonal matrix,
 * i.e.  uniform-scale · rotation · (optional mirror).
 */
export function isCirclePreservingTransform(m: Matrix2D): boolean {
  const row0Len2 = m.a * m.a + m.b * m.b
  const row1Len2 = m.c * m.c + m.d * m.d
  const dot = m.a * m.c + m.b * m.d
  return Math.abs(row0Len2 - row1Len2) <= EPSILON && Math.abs(dot) <= EPSILON
}

/**
 * True when the matrix includes a reflection (determinant < 0).
 * Mirror flips arc / circle `clockwise` so winding stays usable.
 */
export function isMirrorTransform(m: Matrix2D): boolean {
  return m.a * m.d - m.b * m.c < 0
}

// ============================================================================
// Profile / sketch resolution
// ============================================================================

/**
 * Kappa constant for bezier approximation of a quarter circle.  Same value
 * used by {@link ellipseProfile} in project.ts.
 */
const KAPPA = 0.5522847498

/**
 * Build four cubic bezier segments approximating a full circle.  This is the
 * fallback when a circle segment cannot be preserved as a circle under a
 * non‑circle‑preserving affine transform.
 */
function circleToBezierSegments(
  cx: number,
  cy: number,
  r: number,
): Array<Extract<Segment, { type: 'bezier' }>> {
  const k = r * KAPPA
  // Four quadrant anchors: right, bottom, left, top
  const pRight =  { x: cx + r, y: cy }
  const pBottom = { x: cx,     y: cy + r }
  const pLeft =   { x: cx - r, y: cy }
  const pTop =    { x: cx,     y: cy - r }

  return [
    // Q1: right → bottom (clockwise, +Y down)
    { type: 'bezier', control1: { x: cx + r, y: cy + k }, control2: { x: cx + k, y: cy + r }, to: pBottom },
    // Q2: bottom → left
    { type: 'bezier', control1: { x: cx - k, y: cy + r }, control2: { x: cx - r, y: cy + k }, to: pLeft },
    // Q3: left → top
    { type: 'bezier', control1: { x: cx - r, y: cy - k }, control2: { x: cx - k, y: cy - r }, to: pTop },
    // Q4: top → right
    { type: 'bezier', control1: { x: cx + k, y: cy - r }, control2: { x: cx + r, y: cy - k }, to: pRight },
  ]
}

/**
 * Convert an arc segment to one or more bezier segments suitable for
 * affine-transforming.  Follows the same math as {@link arcToBezierSegments}
 * in the store, inlined here so the resolver stays a pure helper with no
 * store dependency.
 */
function arcToBezierSegments(
  start: Point,
  segment: Extract<Segment, { type: 'arc' }>,
): Array<Extract<Segment, { type: 'bezier' }>> {
  const startAngle = Math.atan2(start.y - segment.center.y, start.x - segment.center.x)
  const endAngle = Math.atan2(segment.to.y - segment.center.y, segment.to.x - segment.center.x)
  const radius = Math.hypot(start.x - segment.center.x, start.y - segment.center.y)

  let sweep = endAngle - startAngle
  if (segment.clockwise && sweep > 0) {
    sweep -= Math.PI * 2
  } else if (!segment.clockwise && sweep < 0) {
    sweep += Math.PI * 2
  }

  const segmentCount = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)))
  const step = sweep / segmentCount
  const result: Array<Extract<Segment, { type: 'bezier' }>> = []

  for (let index = 0; index < segmentCount; index += 1) {
    const angle0 = startAngle + step * index
    const angle1 = angle0 + step
    const p0 = {
      x: segment.center.x + Math.cos(angle0) * radius,
      y: segment.center.y + Math.sin(angle0) * radius,
    }
    const p3 = {
      x: segment.center.x + Math.cos(angle1) * radius,
      y: segment.center.y + Math.sin(angle1) * radius,
    }
    const tangent0 = { x: -Math.sin(angle0), y: Math.cos(angle0) }
    const tangent1 = { x: -Math.sin(angle1), y: Math.cos(angle1) }
    const handleScale = (4 / 3) * Math.tan(step / 4) * radius

    result.push({
      type: 'bezier',
      control1: {
        x: p0.x + tangent0.x * handleScale,
        y: p0.y + tangent0.y * handleScale,
      },
      control2: {
        x: p3.x - tangent1.x * handleScale,
        y: p3.y - tangent1.y * handleScale,
      },
      to: p3,
    })
  }

  return result
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
  const preserveCircle = isCirclePreservingTransform(transform)
  const mirror = isMirrorTransform(transform)
  const transformPoint = (p: Point) => applyMatrixToPoint(transform, p)

  const { profile } = definition
  const nextSegments: Segment[] = []
  let current = profile.start

  for (const segment of profile.segments) {
    if (segment.type === 'line') {
      nextSegments.push({ ...segment, to: transformPoint(segment.to) })
    } else if (segment.type === 'bezier') {
      nextSegments.push({
        ...segment,
        control1: transformPoint(segment.control1),
        control2: transformPoint(segment.control2),
        to: transformPoint(segment.to),
      })
    } else if (segment.type === 'arc') {
      // Arcs → beziers; affine transforms don't preserve arc shape.
      const beziers = arcToBezierSegments(current, segment)
      for (const bezier of beziers) {
        nextSegments.push({
          ...bezier,
          control1: transformPoint(bezier.control1),
          control2: transformPoint(bezier.control2),
          to: transformPoint(bezier.to),
        })
      }
    } else if (segment.type === 'circle') {
      if (preserveCircle) {
        // Circle-preserving transform: keep as native circle.
        const newCenter = transformPoint(segment.center)
        const newStart = transformPoint(profile.start)
        nextSegments.push({
          type: 'circle',
          center: newCenter,
          to: newStart,
          clockwise: mirror ? !segment.clockwise : segment.clockwise,
        })
      } else {
        // Non-circle-preserving: convert to beziers, then transform.
        const r = Math.hypot(profile.start.x - segment.center.x, profile.start.y - segment.center.y)
        const beziers = circleToBezierSegments(segment.center.x, segment.center.y, r)
        for (const bezier of beziers) {
          nextSegments.push({
            ...bezier,
            control1: transformPoint(bezier.control1),
            control2: transformPoint(bezier.control2),
            to: transformPoint(bezier.to),
          })
        }
      }
    }

    current = segment.to
  }

  return {
    start: transformPoint(profile.start),
    segments: nextSegments,
    closed: profile.closed,
  }
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
 * Determine the definition and transform for a feature row, handling the
 * transitional shape where features lack explicit `definitionId` / `transform`.
 *
 * Returns `null` when no matching definition exists.
 */
function resolveDefinitionAndTransform(
  project: Project,
  feature: SketchFeature,
): { definition: FeatureDefinition; transform: Matrix2D } | null {
  const withRefs = feature as SketchFeature & {
    definitionId?: string
    transform?: Matrix2D
  }

  let definition: FeatureDefinition | undefined

  if (withRefs.definitionId) {
    // Explicit definitionId: resolve ONLY that definition — no fallback.
    definition = project.featureDefinitions[withRefs.definitionId]
    if (!definition) return null
  } else {
    // Transitional shape: no definitionId → resolve by feature ID.
    definition = project.featureDefinitions[feature.id]
    if (!definition) return null
  }

  return {
    definition,
    transform: withRefs.transform ?? IDENTITY_MATRIX,
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
 * - Finds the matching definition (by `definitionId` if present, otherwise by
 *   feature ID).
 * - Applies the instance transform (identity for transitional features).
 * - Returns `null` when the definition is missing.
 */
export function resolveFeatureInstance(
  project: Project,
  instanceOrFeatureId: string,
): ResolvedSketchFeature | null {
  const feature = project.features.find((f) => f.id === instanceOrFeatureId)
  if (!feature) return null

  const resolved = resolveDefinitionAndTransform(project, feature)
  if (!resolved) return null

  const { definition, transform } = resolved
  const sketch = resolveSketch(definition, transform)
  // Layer per-instance constraints onto the resolved sketch.
  sketch.constraints = feature.sketch.constraints.map((c) => ({ ...c }))

  const transformPoint = (p: Point) => applyMatrixToPoint(transform, p)

  return {
    id: feature.id,
    name: feature.name,
    definitionId: definition.id,
    instanceId: feature.id,
    kind: definition.kind,
    text: definition.text ? { ...definition.text } : null,
    stl: resolveStlData(definition.stl, transformPoint),
    folderId: feature.folderId,
    sketch,
    operation: definition.operation,
    z_top: feature.z_top,
    z_bottom: feature.z_bottom,
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
  const targetIds = ids ?? project.features.map((f) => f.id)
  const result: ResolvedSketchFeature[] = []
  for (const id of targetIds) {
    const resolved = resolveFeatureInstance(project, id)
    if (resolved) result.push(resolved)
  }
  return result
}

// ============================================================================
// Read-path adapters
// ============================================================================

function hasExplicitDefinitionId(feature: SketchFeature): boolean {
  return typeof (feature as SketchFeature & { definitionId?: unknown }).definitionId === 'string'
}

function rawFeatureAdapter(feature: SketchFeature): ResolvedSketchFeature {
  return {
    ...feature,
    definitionId: feature.id,
    instanceId: feature.id,
    text: feature.text ?? null,
    stl: feature.stl ?? null,
    sketch: {
      ...feature.sketch,
      profile: { ...feature.sketch.profile },
      constraints: feature.sketch.constraints.map((constraint) => ({ ...constraint })),
    },
  }
}

/**
 * Resolve every feature row in the project into a world-space
 * {@link ResolvedSketchFeature}.  Read paths that need placed/world geometry
 * should use this (or {@link resolvedFeatureMap}) instead of reading
 * `project.features` directly.
 *
 * Explicit missing-definition features are skipped. Transitional rows without
 * a definition reference retain their stored world-space geometry.
 */
export function resolvedProjectFeatures(project: Project): ResolvedSketchFeature[] {
  return project.features.flatMap((feature) => {
    const resolved = resolveFeatureInstance(project, feature.id)
    if (resolved) return [resolved]
    return hasExplicitDefinitionId(feature) ? [] : [rawFeatureAdapter(feature)]
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
