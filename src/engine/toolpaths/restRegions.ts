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
import { polygonProfile, type Operation, type Point, type Project, type SketchFeature } from '../../types/project'
import { expandFeatureGeometry, featureHasClosedGeometry } from '../../text'
import {
  DEFAULT_CLIPPER_SCALE,
  flattenProfile,
  normalizeToolForProject,
  normalizeWinding,
  toClipperPath,
} from './geometry'
import { buildInsetRegions } from './pocket'
import { differenceClipperPaths, intersectClipperPaths, unionClipperPaths, clipperPathsToPointContours } from './modelProtection'
import { buildRegionMask, splitFeatureTargets } from './regions'
import { resolveInsideEdgeRegions, resolvePocketRegions } from './resolver'
import { significantSilhouettePaths } from './silhouette'
import type { ClipperPath, ResolvedPocketRegion, ResolvedPocketResult } from './types'

export interface RestRegionDraft {
  profile: SketchFeature['sketch']['profile']
  sourceOperationId: string
}

export interface RestRegionDraftResult {
  drafts: RestRegionDraft[]
  warnings: string[]
}

function pocketRegionToAreaPaths(region: ResolvedPocketRegion): ClipperPath[] {
  const outerPath = toClipperPath(normalizeWinding(region.outer, false), DEFAULT_CLIPPER_SCALE)
  const islandPaths = region.islands
    .filter((island) => island.length >= 3)
    .map((island) => toClipperPath(normalizeWinding(island, false), DEFAULT_CLIPPER_SCALE))
  return differenceClipperPaths([outerPath], islandPaths)
}

function pathArea(path: ClipperPath): number {
  return Math.abs((ClipperLib.Clipper as unknown as { Area(path: ClipperPath): number }).Area(path))
    / (DEFAULT_CLIPPER_SCALE * DEFAULT_CLIPPER_SCALE)
}

function offsetClosedPaths(paths: ClipperPath[], delta: number, joinType: number): ClipperPath[] {
  if (paths.length === 0) return []
  if (Math.abs(delta) <= 1e-9) return paths

  const offset = new ClipperLib.ClipperOffset()
  offset.AddPaths(paths, joinType, ClipperLib.EndType.etClosedPolygon)
  const solution = new ClipperLib.Paths()
  offset.Execute(solution, Math.round(delta * DEFAULT_CLIPPER_SCALE))
  return solution as ClipperPath[]
}

function splitNarrowConnections(paths: ClipperPath[], clearance: number): ClipperPath[] {
  if (paths.length === 0 || clearance <= 0) return paths

  const eroded = offsetClosedPaths(paths, -clearance, ClipperLib.JoinType.jtMiter)
  if (eroded.length === 0) return paths

  const restored = offsetClosedPaths(eroded, clearance, ClipperLib.JoinType.jtMiter)
  return restored.length > 0 ? unionClipperPaths(restored) : paths
}

function clipperPathBounds(path: ClipperPath): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (path.length === 0) return null

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const point of path) {
    minX = Math.min(minX, point.X)
    minY = Math.min(minY, point.Y)
    maxX = Math.max(maxX, point.X)
    maxY = Math.max(maxY, point.Y)
  }
  return { minX, minY, maxX, maxY }
}

function rectanglePath(bounds: { minX: number; minY: number; maxX: number; maxY: number }, expansion: number): ClipperPath {
  const delta = Math.round(expansion * DEFAULT_CLIPPER_SCALE)
  const minX = bounds.minX - delta
  const minY = bounds.minY - delta
  const maxX = bounds.maxX + delta
  const maxY = bounds.maxY + delta
  return [
    { X: minX, Y: minY },
    { X: maxX, Y: minY },
    { X: maxX, Y: maxY },
    { X: minX, Y: maxY },
  ]
}

function rebuildOriginalRestComponents(restPaths: ClipperPath[], splitPaths: ClipperPath[], expansion: number): ClipperPath[] {
  const rebuilt: ClipperPath[] = []

  for (const path of splitPaths) {
    const bounds = clipperPathBounds(path)
    if (!bounds) continue
    const localRest = intersectClipperPaths(restPaths, [rectanglePath(bounds, expansion)])
    rebuilt.push(...localRest)
  }

  const rebuiltUnion = unionClipperPaths(rebuilt)
  const missingRest = differenceClipperPaths(restPaths, offsetClosedPaths(rebuiltUnion, expansion, ClipperLib.JoinType.jtMiter))
  return unionClipperPaths([...rebuiltUnion, ...missingRest])
}

function squaredDistance(a: Point, b: Point): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return dx * dx + dy * dy
}

function perpendicularDistance(point: Point, lineStart: Point, lineEnd: Point): number {
  const dx = lineEnd.x - lineStart.x
  const dy = lineEnd.y - lineStart.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared <= 1e-18) {
    return Math.sqrt(squaredDistance(point, lineStart))
  }

  const t = ((point.x - lineStart.x) * dx + (point.y - lineStart.y) * dy) / lengthSquared
  const projected = {
    x: lineStart.x + t * dx,
    y: lineStart.y + t * dy,
  }
  return Math.sqrt(squaredDistance(point, projected))
}

function simplifyOpenContour(points: Point[], tolerance: number): Point[] {
  if (points.length <= 2) return points

  let maxDistance = -Infinity
  let splitIndex = -1
  const first = points[0]
  const last = points[points.length - 1]

  for (let index = 1; index < points.length - 1; index += 1) {
    const distance = perpendicularDistance(points[index], first, last)
    if (distance > maxDistance) {
      maxDistance = distance
      splitIndex = index
    }
  }

  if (maxDistance <= tolerance || splitIndex === -1) {
    return [first, last]
  }

  const left = simplifyOpenContour(points.slice(0, splitIndex + 1), tolerance)
  const right = simplifyOpenContour(points.slice(splitIndex), tolerance)
  return [...left.slice(0, -1), ...right]
}

function simplifyClosedContour(contour: Point[], tolerance: number): Point[] {
  if (contour.length <= 3 || tolerance <= 0) return contour

  let firstAnchor = 0
  let secondAnchor = 1
  let maxDistance = -Infinity
  for (let left = 0; left < contour.length; left += 1) {
    for (let right = left + 1; right < contour.length; right += 1) {
      const distance = squaredDistance(contour[left], contour[right])
      if (distance > maxDistance) {
        maxDistance = distance
        firstAnchor = left
        secondAnchor = right
      }
    }
  }

  const forward = contour.slice(firstAnchor, secondAnchor + 1)
  const backward = [...contour.slice(secondAnchor), ...contour.slice(0, firstAnchor + 1)]
  const simplifiedForward = simplifyOpenContour(forward, tolerance)
  const simplifiedBackward = simplifyOpenContour(backward, tolerance)
  const simplified = [...simplifiedForward.slice(0, -1), ...simplifiedBackward.slice(0, -1)]
  return simplified.length >= 3 ? simplified : contour
}

function cleanClosedContour(contour: Point[]): Point[] {
  const cleaned: Point[] = []
  for (const point of contour) {
    const previous = cleaned[cleaned.length - 1]
    if (previous && squaredDistance(previous, point) <= 1e-18) continue
    cleaned.push(point)
  }
  if (cleaned.length > 1 && squaredDistance(cleaned[0], cleaned[cleaned.length - 1]) <= 1e-18) {
    cleaned.pop()
  }
  return cleaned
}

function cross(origin: Point, a: Point, b: Point): number {
  return (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x)
}

function convexHull(points: Point[]): Point[] {
  const sorted = [...points]
    .sort((left, right) => left.x === right.x ? left.y - right.y : left.x - right.x)
    .filter((point, index, list) => (
      index === 0 || squaredDistance(point, list[index - 1]) > 1e-18
    ))

  if (sorted.length <= 3) return sorted

  const lower: Point[] = []
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
      lower.pop()
    }
    lower.push(point)
  }

  const upper: Point[] = []
  for (const point of [...sorted].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
      upper.pop()
    }
    upper.push(point)
  }

  return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}

function restPathsToDrafts(paths: ClipperPath[], toolDiameter: number, operation: Operation): RestRegionDraft[] {
  const minArea = Math.max((100 / DEFAULT_CLIPPER_SCALE) ** 2, toolDiameter * toolDiameter * 0.0001)
  const simplifyTolerance = Math.max(5 / DEFAULT_CLIPPER_SCALE, toolDiameter * 0.4)
  const contours = clipperPathsToPointContours(paths)
    .filter((contour) => contour.length >= 3)
    .filter((contour) => pathArea(toClipperPath(contour, DEFAULT_CLIPPER_SCALE)) >= minArea)
    .map((contour) => simplifyClosedContour(contour, simplifyTolerance))
    .map(cleanClosedContour)
    .map(convexHull)
    .filter((contour) => contour.length >= 3)

  return contours.map((contour) => ({
    profile: polygonProfile(contour),
    sourceOperationId: operation.id,
  }))
}

function generateAreaRestRegionDrafts(
  resolved: ResolvedPocketResult,
  operation: Operation,
  toolRadius: number,
  sourceMaskPaths: ClipperPath[] | null = null,
): RestRegionDraft[] {
  const sourceAreaPaths: ClipperPath[] = []
  const reachableAreaPaths: ClipperPath[] = []
  const radialLeave = Math.max(0, operation.stockToLeaveRadial)
  const centerInset = toolRadius + radialLeave

  for (const band of resolved.bands) {
    for (const region of band.regions) {
      sourceAreaPaths.push(...pocketRegionToAreaPaths(region))

      const centerRegions = buildInsetRegions(region, centerInset)
      const centerAreaPaths = centerRegions.flatMap(pocketRegionToAreaPaths)
      reachableAreaPaths.push(...offsetClosedPaths(centerAreaPaths, toolRadius, ClipperLib.JoinType.jtRound))
    }
  }

  let sourceUnion = unionClipperPaths(sourceAreaPaths)
  if (sourceMaskPaths && sourceMaskPaths.length > 0) {
    sourceUnion = intersectClipperPaths(sourceUnion, sourceMaskPaths)
  }
  if (sourceUnion.length === 0) return []

  let reachableUnion = unionClipperPaths(reachableAreaPaths)
  if (sourceMaskPaths && sourceMaskPaths.length > 0) {
    reachableUnion = intersectClipperPaths(reachableUnion, sourceMaskPaths)
  }
  const restPaths = unionClipperPaths(differenceClipperPaths(sourceUnion, reachableUnion))
  const splitClearance = Math.max(3 / DEFAULT_CLIPPER_SCALE, toolRadius * 0.08)
  const splitRestPaths = splitNarrowConnections(restPaths, splitClearance)
  const outputRestPaths = rebuildOriginalRestComponents(restPaths, splitRestPaths, Math.max(splitClearance * 2, toolRadius * 0.6))
  return restPathsToDrafts(outputRestPaths, toolRadius * 2, operation)
}

export function generatePocketRestRegionDrafts(project: Project, operation: Operation): RestRegionDraftResult {
  if (operation.kind !== 'pocket') {
    return {
      drafts: [],
      warnings: ['Rest regions can only be generated for pocket operations'],
    }
  }

  const resolved = resolvePocketRegions(project, operation)
  const toolRecord = operation.toolRef
    ? project.tools.find((tool) => tool.id === operation.toolRef) ?? null
    : null

  if (!toolRecord) {
    return { drafts: [], warnings: [...resolved.warnings, 'No tool assigned to this operation'] }
  }

  const tool = normalizeToolForProject(toolRecord, project)
  if (!(tool.diameter > 0)) {
    return { drafts: [], warnings: [...resolved.warnings, 'Tool diameter must be greater than zero'] }
  }

  const toolRadius = tool.radius
  const drafts = generateAreaRestRegionDrafts(resolved, operation, toolRadius)

  return {
    drafts,
    warnings: resolved.warnings,
  }
}

function featureSilhouettePaths(feature: SketchFeature): Point[][] {
  if (feature.kind === 'stl' && feature.stl?.silhouettePaths?.length) {
    return significantSilhouettePaths(feature.stl.silhouettePaths)
  }

  return [flattenProfile(feature.sketch.profile).points]
}

function featureToAreaPaths(feature: SketchFeature): ClipperPath[] {
  return featureSilhouettePaths(feature)
    .filter((path) => path.length >= 3)
    .map((path) => toClipperPath(normalizeWinding(path, false), DEFAULT_CLIPPER_SCALE))
}

function generateOutsideEdgeRestRegionDrafts(project: Project, operation: Operation, toolRadius: number): RestRegionDraftResult {
  const splitTargets = operation.target.source === 'features'
    ? splitFeatureTargets(project, operation.target.featureIds)
    : null
  const regionMask = splitTargets ? buildRegionMask(splitTargets.regionFeatures) : null
  const sourceFeatures = splitTargets
    ? splitTargets.machiningFeatures
      .flatMap((feature) => (feature.operation === 'model' ? [feature] : expandFeatureGeometry(feature)))
      .filter((feature) => (feature.operation === 'add' || feature.operation === 'model') && featureHasClosedGeometry(feature))
    : []

  if (sourceFeatures.length === 0) {
    return { drafts: [], warnings: ['No valid add/model features were found for this outside edge-route operation'] }
  }

  const radialLeave = Math.max(0, operation.stockToLeaveRadial)
  const sourcePaths = unionClipperPaths(sourceFeatures.flatMap(featureToAreaPaths))
  const outerLimit = offsetClosedPaths(sourcePaths, toolRadius + radialLeave, ClipperLib.JoinType.jtMiter)
  let sourceBand = differenceClipperPaths(outerLimit, sourcePaths)
  const centerPaths = offsetClosedPaths(sourcePaths, toolRadius + radialLeave, ClipperLib.JoinType.jtMiter)
  const sweptOuter = offsetClosedPaths(centerPaths, toolRadius, ClipperLib.JoinType.jtRound)
  const sweptInner = offsetClosedPaths(centerPaths, -toolRadius, ClipperLib.JoinType.jtRound)
  let reachableBand = differenceClipperPaths(sweptOuter, sweptInner)

  if (regionMask) {
    sourceBand = intersectClipperPaths(sourceBand, regionMask.paths)
    reachableBand = intersectClipperPaths(reachableBand, regionMask.paths)
  }

  const restPaths = unionClipperPaths(differenceClipperPaths(sourceBand, reachableBand))
  const splitClearance = Math.max(3 / DEFAULT_CLIPPER_SCALE, toolRadius * 0.08)
  const splitRestPaths = splitNarrowConnections(restPaths, splitClearance)
  const outputRestPaths = rebuildOriginalRestComponents(restPaths, splitRestPaths, Math.max(splitClearance * 2, toolRadius * 0.6))

  return {
    drafts: restPathsToDrafts(outputRestPaths, toolRadius * 2, operation),
    warnings: splitTargets && splitTargets.missingFeatureIds.length > 0
      ? ['Some selected target features are missing or are not add/model/region features']
      : [],
  }
}

export function generateEdgeRestRegionDrafts(project: Project, operation: Operation): RestRegionDraftResult {
  if (operation.kind !== 'edge_route_inside' && operation.kind !== 'edge_route_outside') {
    return {
      drafts: [],
      warnings: ['Rest regions can only be generated for edge-route operations'],
    }
  }

  const toolRecord = operation.toolRef
    ? project.tools.find((tool) => tool.id === operation.toolRef) ?? null
    : null

  if (!toolRecord) {
    return { drafts: [], warnings: ['No tool assigned to this operation'] }
  }

  const tool = normalizeToolForProject(toolRecord, project)
  if (!(tool.diameter > 0)) {
    return { drafts: [], warnings: ['Tool diameter must be greater than zero'] }
  }

  if (operation.kind === 'edge_route_outside') {
    return generateOutsideEdgeRestRegionDrafts(project, operation, tool.radius)
  }

  const resolved = resolveInsideEdgeRegions(project, operation)
  const splitTargets = operation.target.source === 'features'
    ? splitFeatureTargets(project, operation.target.featureIds)
    : null
  const regionMask = splitTargets ? buildRegionMask(splitTargets.regionFeatures) : null
  const drafts = generateAreaRestRegionDrafts(resolved, operation, tool.radius, regionMask?.paths ?? null)

  return {
    drafts,
    warnings: resolved.warnings,
  }
}
