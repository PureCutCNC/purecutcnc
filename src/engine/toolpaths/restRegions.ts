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
import {
  polygonProfile,
  type Operation,
  type Point,
  type Project,
  type RegionMaskMode,
  type SketchFeature,
} from '../../types/project'
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
import { applyRegionMaskToPaths, buildRegionMask, type RegionMask, splitFeatureTargets } from './regions'
import { resolveInsideEdgeRegions, resolvePocketRegions } from './resolver'
import { significantSilhouettePaths } from './silhouette'
import type { ClipperPath, ResolvedPocketRegion, ResolvedPocketResult } from './types'

export interface RestRegionDraft {
  profile: SketchFeature['sketch']['profile']
  sourceOperationId: string
  regionMaskMode?: RegionMaskMode
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

  // Erode to sever the thin necks that join otherwise-separate rest blobs (e.g.
  // the per-corner cusps of a polygon pocket), then dilate back to restore the
  // surviving cores. The corner cusps of finer polygons (hexagons, octagons)
  // are thinner than the nominal clearance, so a single fixed erosion wipes the
  // whole sliver out — `eroded` comes back empty and we lose the split, leaving
  // multiple corners fused into one blob that downstream hulls into a wedge.
  // Back the clearance off until the erosion leaves cores standing.
  let activeClearance = clearance
  let eroded: ClipperPath[] = []
  for (let attempt = 0; attempt < 6; attempt += 1) {
    eroded = offsetClosedPaths(paths, -activeClearance, ClipperLib.JoinType.jtMiter)
    if (eroded.length > 0) break
    activeClearance *= 0.5
  }
  if (eroded.length === 0) return paths

  const restored = offsetClosedPaths(eroded, activeClearance, ClipperLib.JoinType.jtMiter)
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

function unitVector(from: Point, to: Point): Point | null {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy)
  if (length <= 1e-9) return null
  return { x: dx / length, y: dy / length }
}

/**
 * Even-odd containment against a set of Clipper paths (outers + holes). Used to
 * decide which side of a boundary vertex is solid material, so corner cusps are
 * built only where the pocket is actually convex into the stock.
 */
function pointInsidePaths(point: Point, paths: ClipperPath[]): boolean {
  const probe = {
    X: Math.round(point.x * DEFAULT_CLIPPER_SCALE),
    Y: Math.round(point.y * DEFAULT_CLIPPER_SCALE),
  }
  let crossings = 0
  for (const path of paths) {
    if ((ClipperLib.Clipper as unknown as { PointInPolygon(p: { X: number; Y: number }, path: ClipperPath): number })
      .PointInPolygon(probe, path) !== 0) {
      crossings += 1
    }
  }
  return crossings % 2 === 1
}

/**
 * Build the analytical corner cusps for a single closed boundary loop. A flat
 * (cylindrical) tool of effective radius `R` rolled tight into a convex corner
 * of interior angle θ leaves a triangular cusp: apex at the vertex, with the two
 * tangent points a distance R/tan(θ/2) back along each wall. We emit that exact
 * triangle so every equal corner comes out identical, independent of the loop's
 * orientation — unlike deriving the shape from the (orientation-noisy) leftover
 * sliver. `materialPaths` marks the solid side so the same routine handles both
 * the outer wall (material inside) and islands (material outside).
 *
 * The back of the triangle is a straight chord across the two tangent points,
 * optionally pushed a little further down the walls by `backExtension` so the
 * finishing tool has a touch of engagement room. The reach down each wall is
 * capped so a neighbouring corner on a tight pocket is never met — the corners
 * stay distinct triangles instead of merging into one ring.
 */
function cornerCuspTriangles(
  loop: Point[],
  materialPaths: ClipperPath[],
  effectiveRadius: number,
  backExtension: number,
): ClipperPath[] {
  const points = cleanClosedContour(loop)
  const count = points.length
  if (count < 3) return []

  const minTurn = 0.15 // ~8.6°: ignore near-straight vertices (e.g. flattened curves)
  const probeDistance = Math.max(2 / DEFAULT_CLIPPER_SCALE, effectiveRadius * 0.02)
  const triangles: ClipperPath[] = []

  for (let index = 0; index < count; index += 1) {
    const previous = points[(index - 1 + count) % count]
    const vertex = points[index]
    const next = points[(index + 1) % count]

    const wall1 = unitVector(vertex, previous)
    const wall2 = unitVector(vertex, next)
    if (!wall1 || !wall2) continue

    const dot = Math.min(1, Math.max(-1, wall1.x * wall2.x + wall1.y * wall2.y))
    const interiorAngle = Math.acos(dot)
    if (interiorAngle > Math.PI - minTurn) continue // effectively straight — no cusp

    const bisectorX = wall1.x + wall2.x
    const bisectorY = wall1.y + wall2.y
    const bisectorLength = Math.hypot(bisectorX, bisectorY)
    if (bisectorLength <= 1e-9) continue
    const bisector = { x: bisectorX / bisectorLength, y: bisectorY / bisectorLength }

    // The cusp only exists where the solid material sits on the narrow-angle
    // side of the vertex (a convex corner). If material is on the wide-angle
    // side the corner is reflex and the tool reaches it cleanly.
    const inside = { x: vertex.x + probeDistance * bisector.x, y: vertex.y + probeDistance * bisector.y }
    const outside = { x: vertex.x - probeDistance * bisector.x, y: vertex.y - probeDistance * bisector.y }
    if (!pointInsidePaths(inside, materialPaths) || pointInsidePaths(outside, materialPaths)) continue

    const tangentDistance = effectiveRadius / Math.tan(interiorAngle / 2)
    if (!(tangentDistance > 0) || !Number.isFinite(tangentDistance)) continue

    // Reach down each wall = the tangent distance plus a small straight
    // back-extension, but capped at ~45% of the shorter adjacent wall so a
    // neighbouring corner is never met (the corners stay distinct triangles).
    const edgePrevious = Math.hypot(previous.x - vertex.x, previous.y - vertex.y)
    const edgeNext = Math.hypot(next.x - vertex.x, next.y - vertex.y)
    const reach = Math.min(tangentDistance + backExtension, 0.45 * Math.min(edgePrevious, edgeNext))
    if (!(reach > 0)) continue

    const back1 = { x: vertex.x + reach * wall1.x, y: vertex.y + reach * wall1.y }
    const back2 = { x: vertex.x + reach * wall2.x, y: vertex.y + reach * wall2.y }
    triangles.push(toClipperPath(normalizeWinding([vertex, back1, back2], false), DEFAULT_CLIPPER_SCALE))
  }

  return triangles
}

/** Morphological open: drop anything thinner than 2·clearance, keep fatter blobs. */
function removeThinSlivers(paths: ClipperPath[], clearance: number): ClipperPath[] {
  if (paths.length === 0 || clearance <= 0) return paths
  const eroded = offsetClosedPaths(paths, -clearance, ClipperLib.JoinType.jtMiter)
  if (eroded.length === 0) return []
  return offsetClosedPaths(eroded, clearance, ClipperLib.JoinType.jtMiter)
}

function signedContourArea(contour: Point[]): number {
  let area = 0
  for (let index = 0; index < contour.length; index += 1) {
    const current = contour[index]
    const next = contour[(index + 1) % contour.length]
    area += current.x * next.y - next.x * current.y
  }
  return area / 2
}

function pointInContour(point: Point, contour: Point[]): boolean {
  const clipperPoint = {
    X: Math.round(point.x * DEFAULT_CLIPPER_SCALE),
    Y: Math.round(point.y * DEFAULT_CLIPPER_SCALE),
  }
  const clipperContour = toClipperPath(contour, DEFAULT_CLIPPER_SCALE)
  return (ClipperLib.Clipper as unknown as {
    PointInPolygon(point: { X: number; Y: number }, path: ClipperPath): number
  }).PointInPolygon(clipperPoint, clipperContour) > 0
}

function areaPathsToDrafts(paths: ClipperPath[], toolRadius: number, operation: Operation): RestRegionDraft[] {
  const minArea = Math.max((100 / DEFAULT_CLIPPER_SCALE) ** 2, toolRadius * toolRadius * 0.0004)
  const simplifyTolerance = Math.max(5 / DEFAULT_CLIPPER_SCALE, toolRadius * 0.04)
  const contours = clipperPathsToPointContours(paths)
    .filter((contour) => contour.length >= 3)
    .map((contour) => simplifyClosedContour(contour, simplifyTolerance))
    .map(cleanClosedContour)
    .filter((contour) => contour.length >= 3)
    .filter((contour) => pathArea(toClipperPath(contour, DEFAULT_CLIPPER_SCALE)) >= minArea)

  return contours
    .map((contour, index) => {
      const depth = contours.reduce((count, other, otherIndex) => (
        otherIndex !== index && pointInContour(contour[0], other) ? count + 1 : count
      ), 0)
      return {
        contour,
        depth,
        index,
        area: Math.abs(signedContourArea(contour)),
      }
    })
    .sort((a, b) => a.depth - b.depth || b.area - a.area || a.index - b.index)
    .map(({ contour, depth }) => ({
      profile: polygonProfile(contour),
      sourceOperationId: operation.id,
      regionMaskMode: depth % 2 === 0 ? 'include' : 'exclude',
    }))
}

function generateAreaRestRegionDrafts(
  resolved: ResolvedPocketResult,
  operation: Operation,
  toolRadius: number,
  sourceMask: RegionMask | null = null,
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
  if (sourceMask) {
    sourceUnion = applyRegionMaskToPaths(sourceUnion, sourceMask)
  }
  if (sourceUnion.length === 0) return []

  let reachableUnion = unionClipperPaths(reachableAreaPaths)
  if (sourceMask) {
    reachableUnion = applyRegionMaskToPaths(reachableUnion, sourceMask)
  }
  const restPaths = unionClipperPaths(differenceClipperPaths(sourceUnion, reachableUnion))
  if (restPaths.length === 0) return []

  // Build one analytical cusp triangle per convex corner of every pocket
  // boundary (outer wall + islands). Each is a simple triangle — apex at the
  // corner, straight chord across the back — sized from the corner geometry and
  // the effective tool radius, so equal corners are identical regardless of how
  // the boundary happens to be oriented. The small straight back-extension gives
  // the finishing tool a little engagement room without ballooning the region.
  const backExtension = toolRadius * 0.5
  const cornerTriangles: ClipperPath[] = []
  for (const band of resolved.bands) {
    for (const region of band.regions) {
      for (const loop of [region.outer, ...region.islands]) {
        if (loop.length >= 3) {
          cornerTriangles.push(...cornerCuspTriangles(loop, sourceUnion, centerInset, backExtension))
        }
      }
    }
  }

  // The leftover sliver is only used as a placement gate: skip corners where no
  // material actually remains (already cleared by stock-to-leave, masked out, or
  // too shallow to matter). Each surviving corner triangle is clipped back to the
  // pocket so it never spills past a wall, and kept as its own region — never
  // unioned together — so a hexagon yields six separate corner regions.
  const gateArea = Math.max((100 / DEFAULT_CLIPPER_SCALE) ** 2, toolRadius * toolRadius * 0.0004)
  const cornerRegions: ClipperPath[] = []
  for (const triangle of cornerTriangles) {
    const remaining = intersectClipperPaths([triangle], restPaths)
    if (remaining.length === 0) continue
    const remainingArea = remaining.reduce((sum, path) => sum + pathArea(path), 0)
    if (remainingArea < gateArea) continue

    cornerRegions.push(...intersectClipperPaths([triangle], sourceUnion))
  }

  // Corners alone don't cover unreachable material away from a convex corner —
  // e.g. a channel narrower than the tool, or a pocket the tool can't enter at
  // all. Emit that residual too, but first open it to shed the thin corner-cusp
  // remnants, the sub-grid slivers that run along walls, and the small crumbs a
  // round tool leaves at a concave corner (all minor and visually noisy). A real
  // unreachable channel or pocket is wider than this and survives.
  const cornerUnion = unionClipperPaths(cornerRegions)
  const residual = cornerUnion.length > 0
    ? differenceClipperPaths(restPaths, cornerUnion)
    : restPaths
  const residualBlobs = removeThinSlivers(residual, Math.max(3 / DEFAULT_CLIPPER_SCALE, toolRadius * 0.4))

  return areaPathsToDrafts([...cornerRegions, ...residualBlobs], toolRadius, operation)
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
    sourceBand = applyRegionMaskToPaths(sourceBand, regionMask)
    reachableBand = applyRegionMaskToPaths(reachableBand, regionMask)
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
  const drafts = generateAreaRestRegionDrafts(resolved, operation, tool.radius, regionMask)

  return {
    drafts,
    warnings: resolved.warnings,
  }
}
