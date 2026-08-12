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

import ClipperLib from 'clipper-lib'
import { inferNestedSolidOperation } from '../../import/classifier'
import type { DimensionRef, FeatureOperation, Project, SketchProfile } from '../../types/project'
import {
  DEFAULT_CLIPPER_SCALE,
  flattenProfile,
  normalizeWinding,
  toClipperPath,
} from '../../engine/toolpaths/geometry'
import { resolveFeatureInstances } from './resolveFeatures'

const clipperPointInPolygon = (ClipperLib.Clipper as unknown as {
  PointInPolygon(point: { X: number; Y: number }, path: Array<{ X: number; Y: number }>): number
}).PointInPolygon

/** Infer a newly-created closed feature's role from resolved existing solids. */
export function inferManualFeatureOperation(
  project: Project,
  profile: SketchProfile,
): FeatureOperation {
  const existingSolids = resolveFeatureInstances(project)
    .filter((feature) => feature.operation === 'add' || feature.operation === 'subtract')
    .map((feature) => ({
      profile: feature.sketch.profile,
      operation: feature.operation as 'add' | 'subtract',
    }))
  return inferNestedSolidOperation(profile, existingSolids)
}

/**
 * Resolve a Z dimension ref to a number without throwing. Returns `null`
 * for a named ref that is missing from `project.dimensions` (a corrupt or
 * partially-loaded project), so a broken enclosing feature never blocks the
 * default-Z fallback.
 */
function safeResolveZ(project: Pick<Project, 'dimensions'>, value: DimensionRef): number | null {
  if (typeof value === 'number') return value
  return project.dimensions[value]?.value ?? null
}

/**
 * Pick the initial `z_top` for a newly-created Line (open or closed) by
 * inheriting it from the smallest enclosing solid feature (issue #351).
 *
 * - Enclosing **subtract** (pocket): the Line engraves on the pocket floor,
 *   so it inherits the subtract's `z_bottom`.
 * - Enclosing **add** (raised solid): the Line engraves on the solid's top
 *   surface, so it inherits the add's `z_top`.
 * - Smallest-area enclosing solid wins (most specific pocket/island), mirroring
 *   {@link inferNestedSolidOperation}.
 * - A point is "inside" when it is strictly inside *or on* the container
 *   boundary (Clipper returns non-zero): a Line drawn along a pocket wall
 *   still inherits the pocket floor.
 * - With no enclosing solid, `defaultTopZ` is returned unchanged.
 */
export function inferLineTopZFromEnclosingFeature(
  project: Project,
  profile: SketchProfile,
  defaultTopZ: number,
): number {
  const linePoints = flattenProfile(profile).points
  if (linePoints.length === 0) return defaultTopZ

  const lineClipperPoints = linePoints.map((p) => ({
    X: Math.round(p.x * DEFAULT_CLIPPER_SCALE),
    Y: Math.round(p.y * DEFAULT_CLIPPER_SCALE),
  }))

  let bestArea = Infinity
  let bestZ: number | null = null

  for (const feature of resolveFeatureInstances(project)) {
    if (feature.operation !== 'add' && feature.operation !== 'subtract') continue
    if (!feature.sketch.profile.closed) continue

    const containerPath = toClipperPath(
      normalizeWinding(flattenProfile(feature.sketch.profile).points, false),
      DEFAULT_CLIPPER_SCALE,
    )

    let allInside = true
    for (const point of lineClipperPoints) {
      if (clipperPointInPolygon(point, containerPath) === 0) {
        allInside = false
        break
      }
    }
    if (!allInside) continue

    const area = Math.abs(ClipperLib.Clipper.Area(containerPath))
    if (area >= bestArea) continue

    const zRaw = feature.operation === 'subtract' ? feature.z_bottom : feature.z_top
    const resolved = safeResolveZ(project, zRaw)
    if (resolved === null) continue

    bestArea = area
    bestZ = resolved
  }

  return bestZ ?? defaultTopZ
}
