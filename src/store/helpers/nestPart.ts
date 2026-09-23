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

// Sheet nesting, project side (issue #846, step 2 of #741): turns a selection
// into one rigid part and a packer request. Pure — the store slice commits.

import ClipperLib from 'clipper-lib'
import {
  expandByHalfGap,
  flattenProfileWithin,
  largestFirst,
  type NestPlacement,
  type NestRequest,
  type NestRing,
} from '../../engine/nesting'
import { differencePaths, NEST_SCALE, outerContours, pathToRing, ringToPath } from '../../engine/nesting/clipperOps'
import { normalizeToolForProject } from '../../engine/toolpaths/geometry'
import type { ClipperPath } from '../../engine/toolpaths/types'
import { getFeatureGeometryProfiles } from '../../text'
import type { LocalConstraint, Matrix2D, NestSettings, Point, Project } from '../../types/project'
import { isMachinable } from './featureRoles'
import { resolvedProjectFeatures, type ResolvedSketchFeature } from './resolveFeatures'

/**
 * Chord tolerance for flattening curves, in project units. Parts grow and the
 * sheet shrinks by it, so flattening never costs clearance.
 */
export function nestFlattenTolerance(project: Pick<Project, 'meta'>): number {
  return project.meta.units === 'inch' ? 0.0004 : 0.01
}

export type NestPartRefusal = 'empty' | 'locked' | 'model' | 'external-constraint' | 'no-closed-geometry'

export type NestPartResolution =
  | { ok: true; featureIds: string[]; footprint: NestRing[] }
  | { ok: false; refusal: NestPartRefusal; featureId?: string }

function featureRings(feature: ResolvedSketchFeature, tolerance: number): { ring: NestRing; closed: boolean }[] {
  return getFeatureGeometryProfiles(feature)
    .filter((profile) => profile.segments.length > 0)
    .map((profile) => ({ ring: flattenProfileWithin(profile, tolerance), closed: profile.closed }))
}

function closedPaths(feature: ResolvedSketchFeature, tolerance: number): ClipperPath[] {
  return featureRings(feature, tolerance)
    .filter((entry) => entry.closed && entry.ring.length >= 3)
    .map((entry) => ringToPath(entry.ring))
}

function pathsArea(paths: ClipperPath[]): number {
  return paths.reduce((sum, path) => sum + Math.abs(ClipperLib.Clipper.Area(path)), 0)
}

function pointInPaths(point: Point, paths: ClipperPath[]): boolean {
  const x = point.x * NEST_SCALE
  const y = point.y * NEST_SCALE
  let inside = false
  for (const path of paths) {
    for (let i = 0, j = path.length - 1; i < path.length; j = i, i += 1) {
      const a = path[i]
      const b = path[j]
      if ((a.Y > y) !== (b.Y > y) && x < ((b.X - a.X) * (y - a.Y)) / (b.Y - a.Y) + a.X) inside = !inside
    }
  }
  return inside
}

function perimeter(ring: NestRing): number {
  return ring.reduce((sum, point, index) => {
    const next = ring[(index + 1) % ring.length]
    return sum + Math.hypot(next.x - point.x, next.y - point.y)
  }, 0)
}

/**
 * Integer-unit area two independently flattened copies of the same boundary
 * can disagree by: a sliver no wider than twice the chord tolerance.
 */
function flatteningSlack(ring: NestRing, tolerance: number): number {
  return 2 * tolerance * perimeter(ring) * NEST_SCALE * NEST_SCALE
}

/** Every closed ring lies within `outline` and every open polyline's points do too. */
function liesWithin(feature: ResolvedSketchFeature, outline: ClipperPath[], tolerance: number): boolean {
  const rings = featureRings(feature, tolerance)
  if (rings.length === 0) return false
  return rings.every(({ ring, closed }) => (
    closed && ring.length >= 3
      ? pathsArea(differencePaths([ringToPath(ring)], outline)) <= flatteningSlack(ring, tolerance)
      : ring.every((point) => pointInPaths(point, outline))
  ))
}

/** The feature a constraint measures from, if any (fixed-distance rows mirror it in segment_ids[0]). */
export function constraintReference(constraint: LocalConstraint): string | undefined {
  return constraint.reference_feature_id ?? (constraint.type === 'fixed_distance' ? constraint.segment_ids[0] : undefined)
}

/**
 * Resolves a selection into one rigid part (#741 decision 1): the selection,
 * every member of a grouped folder it touches, and every feature lying inside
 * its closed outline. Parts the nest must not move are refused.
 */
export function resolveNestPart(project: Project, selectedIds: string[]): NestPartResolution {
  const resolved = resolvedProjectFeatures(project)
  const byId = new Map(resolved.map((feature) => [feature.id, feature]))
  const ids = new Set(selectedIds.filter((id) => byId.has(id)))
  if (ids.size === 0) return { ok: false, refusal: 'empty' }

  const groupedFolders = new Set(project.featureFolders.filter((folder) => folder.grouped).map((folder) => folder.id))
  for (const feature of resolved) {
    const selectedSibling = feature.folderId && groupedFolders.has(feature.folderId)
      && resolved.some((other) => ids.has(other.id) && other.folderId === feature.folderId)
    if (selectedSibling) ids.add(feature.id)
  }

  const tolerance = nestFlattenTolerance(project)
  const outline = outerContours(
    [...ids].flatMap((id) => (isMachinable(byId.get(id)!) ? closedPaths(byId.get(id)!, tolerance) : [])),
  )
  if (outline.length === 0) return { ok: false, refusal: 'no-closed-geometry' }

  for (const feature of resolved) {
    if (!ids.has(feature.id) && liesWithin(feature, outline, tolerance)) ids.add(feature.id)
  }

  const featureIds = project.features.map((feature) => feature.id).filter((id) => ids.has(id))
  for (const id of featureIds) {
    const feature = byId.get(id)!
    if (feature.locked) return { ok: false, refusal: 'locked', featureId: id }
    if (feature.kind === 'stl') return { ok: false, refusal: 'model', featureId: id }
    const external = feature.sketch.constraints.some((constraint) => {
      const reference = constraintReference(constraint)
      return reference !== undefined && reference !== id && !ids.has(reference)
    })
    if (external) return { ok: false, refusal: 'external-constraint', featureId: id }
  }
  const spanning = project.global_constraints.find((constraint) => (
    constraint.feature_ids.some((id) => ids.has(id)) && constraint.feature_ids.some((id) => !ids.has(id))
  ))
  if (spanning) {
    return { ok: false, refusal: 'external-constraint', featureId: spanning.feature_ids.find((id) => ids.has(id)) }
  }

  return { ok: true, featureIds, footprint: outline.map(pathToRing) }
}

/**
 * Clearance the tool needs between two parts (#741 decision 6): the largest
 * cutter diameter plus radial stock-to-leave on both sides, over the outside
 * edge routes that cut the part. Null when nothing cuts its outline.
 */
export function nestGapForPart(project: Project, featureIds: string[]): number | null {
  const ids = new Set(featureIds)
  let gap: number | null = null
  for (const operation of project.operations) {
    if (operation.kind !== 'edge_route_outside' || operation.target.source !== 'features') continue
    if (!operation.target.featureIds.some((id) => ids.has(id))) continue
    const tool = project.tools.find((candidate) => candidate.id === operation.toolRef)
    if (!tool) continue
    const needed = normalizeToolForProject(tool, project).diameter + 2 * Math.max(0, operation.stockToLeaveRadial)
    gap = gap === null ? needed : Math.max(gap, needed)
  }
  return gap
}

function offsetRings(rings: NestRing[], delta: number): NestRing[] {
  const offset = new ClipperLib.ClipperOffset()
  offset.AddPaths(rings.map(ringToPath), ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon)
  const solution: ClipperPath[] = new ClipperLib.Paths()
  offset.Execute(solution, delta * NEST_SCALE)
  return solution.map(pathToRing)
}

/**
 * Everything the part must keep clear of: clamps grown by the clamp XY
 * clearance, and every other closed machinable feature on the stock —
 * including the part itself when its originals stay in place. A feature that
 * contains the part (a sheet outline drawn as a feature) is not an obstacle.
 */
export function nestObstacleRings(
  project: Project,
  partIds: string[],
  footprint: NestRing[],
  keepOriginals: boolean,
): NestRing[] {
  const tolerance = nestFlattenTolerance(project)
  const part = new Set(partIds)
  const partPaths = footprint.map(ringToPath)
  const clearance = project.meta.clampClearanceXY
  const clamps = project.clamps.map((clamp) => [
    { x: clamp.x - clearance, y: clamp.y - clearance },
    { x: clamp.x + clamp.w + clearance, y: clamp.y - clearance },
    { x: clamp.x + clamp.w + clearance, y: clamp.y + clamp.h + clearance },
    { x: clamp.x - clearance, y: clamp.y + clamp.h + clearance },
  ])
  const features = resolvedProjectFeatures(project).flatMap((feature) => {
    if (!isMachinable(feature) || (part.has(feature.id) && !keepOriginals)) return []
    const paths = closedPaths(feature, tolerance)
    const slack = footprint.reduce((sum, ring) => sum + flatteningSlack(ring, tolerance), 0)
    if (!part.has(feature.id) && paths.length > 0 && pathsArea(differencePaths(partPaths, paths)) <= slack) return []
    return paths.map(pathToRing)
  })
  return [...clamps, ...features]
}

/** The stock outline, shrunk by the flattening tolerance. */
export function nestSheetRing(project: Project): NestRing | null {
  const tolerance = nestFlattenTolerance(project)
  const stock = flattenProfileWithin(project.stock.profile, tolerance)
  const shrunk = offsetRings([stock], -tolerance)
  if (shrunk.length === 0) return null
  return shrunk.reduce((best, ring) => (
    Math.abs(ClipperLib.Clipper.Area(ringToPath(ring))) > Math.abs(ClipperLib.Clipper.Area(ringToPath(best))) ? ring : best
  ))
}

/** A ready-to-run packer request for one resolved part. */
export function buildNestRequest(
  project: Project,
  part: { featureIds: string[]; footprint: NestRing[] },
  settings: NestSettings,
): NestRequest | null {
  const sheet = nestSheetRing(project)
  if (!sheet) return null
  const tolerance = nestFlattenTolerance(project)
  return {
    sheet,
    obstacles: nestObstacleRings(project, part.featureIds, part.footprint, settings.keepOriginals),
    parts: [{
      id: 'part',
      footprint: part.footprint,
      quantity: Math.max(0, settings.keepOriginals ? settings.quantity - 1 : settings.quantity),
      rotations: settings.rotations,
    }],
    minimumGap: settings.minimumGap,
    expandFootprint: (rings, minimumGap) => expandByHalfGap(rings, minimumGap + 2 * tolerance),
    orderParts: largestFirst,
  }
}

/** The world-space transform a placement applies: rotate about the origin, then translate. */
export function nestPlacementMatrix(placement: NestPlacement): Matrix2D {
  const quarter = placement.rotation / 90
  const exact = Math.abs(quarter - Math.round(quarter)) < 1e-12
  const turns = ((Math.round(quarter) % 4) + 4) % 4
  const radians = (placement.rotation * Math.PI) / 180
  const cos = exact ? [1, 0, -1, 0][turns] : Math.cos(radians)
  const sin = exact ? [0, 1, 0, -1][turns] : Math.sin(radians)
  return { a: cos, b: sin, c: -sin, d: cos, e: placement.translation.x, f: placement.translation.y }
}
