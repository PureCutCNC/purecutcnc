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
import type { Point, Project, SketchFeature } from '../../types/project'
import type { ClipperPath, ToolpathBounds, ToolpathMove, ToolpathPoint, ToolpathResult } from './types'
import {
  DEFAULT_CLIPPER_SCALE,
  flattenProfile,
  getOperationSafeZ,
  normalizeWinding,
  toClipperPath,
} from './geometry'

export interface SplitFeatureTargets {
  features: SketchFeature[]
  machiningFeatures: SketchFeature[]
  regionFeatures: SketchFeature[]
  missingFeatureIds: string[]
}

export interface RegionMask {
  paths: ClipperPath[]
  containsPoint(point: Point): boolean
}

interface LineFragment {
  from: ToolpathPoint
  to: ToolpathPoint
}

function pointInClipperPaths(point: Point, paths: ClipperPath[]): boolean {
  const clipperPoint = {
    X: Math.round(point.x * DEFAULT_CLIPPER_SCALE),
    Y: Math.round(point.y * DEFAULT_CLIPPER_SCALE),
  }
  let crossings = 0
  for (const path of paths) {
    const result = (ClipperLib.Clipper as unknown as {
      PointInPolygon(point: { X: number; Y: number }, path: ClipperPath): number
    }).PointInPolygon(clipperPoint, path)
    if (result < 0) return true
    if (result > 0) crossings += 1
  }
  return crossings % 2 === 1
}

/**
 * Round x/y to the Clipper integer grid (1 / DEFAULT_CLIPPER_SCALE = 1e-4 mm).
 * Used to scrub picometre-scale FP drift out of clipped-fragment endpoints
 * (see clipToolpathResultToObstaclesByLevel). Z is left untouched because
 * levels are already exact at this stage.
 */
function snapPointToClipperGrid(point: ToolpathPoint): ToolpathPoint {
  return {
    x: Math.round(point.x * DEFAULT_CLIPPER_SCALE) / DEFAULT_CLIPPER_SCALE,
    y: Math.round(point.y * DEFAULT_CLIPPER_SCALE) / DEFAULT_CLIPPER_SCALE,
    z: point.z,
  }
}

function unionPaths(paths: ClipperPath[]): ClipperPath[] {
  if (paths.length === 0) return []
  const clipper = new ClipperLib.Clipper()
  clipper.AddPaths(paths, ClipperLib.PolyType.ptSubject, true)
  const solution = new ClipperLib.Paths()
  clipper.Execute(
    ClipperLib.ClipType.ctUnion,
    solution,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  )
  return solution as ClipperPath[]
}

function executeClipPaths(
  subjectPaths: ClipperPath[],
  clipPaths: ClipperPath[],
  clipType: number,
): ClipperPath[] {
  if (subjectPaths.length === 0) return []
  if (clipPaths.length === 0) return subjectPaths

  const clipper = new ClipperLib.Clipper()
  clipper.AddPaths(subjectPaths, ClipperLib.PolyType.ptSubject, true)
  clipper.AddPaths(clipPaths, ClipperLib.PolyType.ptClip, true)
  const solution = new ClipperLib.Paths()
  clipper.Execute(
    clipType,
    solution,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  )
  return solution as ClipperPath[]
}

export function splitFeatureTargets(project: Project, featureIds: string[]): SplitFeatureTargets {
  const features: SketchFeature[] = []
  const missingFeatureIds: string[] = []

  for (const featureId of featureIds) {
    const feature = project.features.find((entry) => entry.id === featureId) ?? null
    if (feature) {
      features.push(feature)
    } else {
      missingFeatureIds.push(featureId)
    }
  }

  return {
    features,
    machiningFeatures: features.filter((feature) => feature.operation !== 'region'),
    regionFeatures: features.filter((feature) => feature.operation === 'region'),
    missingFeatureIds,
  }
}

export function buildRegionMask(regionFeatures: SketchFeature[]): RegionMask | null {
  let paths: ClipperPath[] = []

  for (const feature of regionFeatures) {
    if (feature.operation !== 'region' || !feature.sketch.profile.closed) continue
    const flattened = flattenProfile(feature.sketch.profile)
    if (flattened.points.length < 3) continue
    const featurePaths = [toClipperPath(normalizeWinding(flattened.points, false), DEFAULT_CLIPPER_SCALE)]

    if ((feature.regionMaskMode ?? 'include') === 'exclude') {
      paths = executeClipPaths(paths, featurePaths, ClipperLib.ClipType.ctDifference)
    } else {
      paths = unionPaths([...paths, ...featurePaths])
    }
  }

  if (paths.length === 0) return null
  return {
    paths,
    containsPoint: (point) => pointInClipperPaths(point, paths),
  }
}

export function buildMaskFromClipperPaths(paths: ClipperPath[]): RegionMask | null {
  if (paths.length === 0) return null
  return {
    paths,
    containsPoint: (point) => pointInClipperPaths(point, paths),
  }
}

export function featurePathToClipper(feature: SketchFeature): ClipperPath | null {
  if (!feature.sketch.profile.closed) return null
  const flattened = flattenProfile(feature.sketch.profile)
  if (flattened.points.length < 3) return null
  return toClipperPath(normalizeWinding(flattened.points, false), DEFAULT_CLIPPER_SCALE)
}

export function isRegionOnlyTarget(project: Project, featureIds: string[]): boolean {
  const split = splitFeatureTargets(project, featureIds)
  return split.missingFeatureIds.length === 0
    && split.regionFeatures.length > 0
    && split.machiningFeatures.length === 0
}

export function clipTupleContoursToRegionMask(
  contours: Array<Array<[number, number]>>,
  mask: RegionMask | null,
): Array<Array<[number, number]>> {
  if (contours.length === 0 || !mask || mask.paths.length === 0) return []

  const subjectPaths = contours
    .filter((contour) => contour.length >= 3)
    .map((contour) => contour.map(([x, y]) => ({
      X: Math.round(x * DEFAULT_CLIPPER_SCALE),
      Y: Math.round(y * DEFAULT_CLIPPER_SCALE),
    }))) as ClipperPath[]

  if (subjectPaths.length === 0) return []

  const clipper = new ClipperLib.Clipper()
  clipper.AddPaths(subjectPaths, ClipperLib.PolyType.ptSubject, true)
  clipper.AddPaths(mask.paths, ClipperLib.PolyType.ptClip, true)

  const solution = new ClipperLib.Paths()
  clipper.Execute(
    ClipperLib.ClipType.ctIntersection,
    solution,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  )

  return (solution as ClipperPath[])
    .map((path) => path.map((point) => [
      point.X / DEFAULT_CLIPPER_SCALE,
      point.Y / DEFAULT_CLIPPER_SCALE,
    ] as [number, number]))
    .filter((contour) => contour.length >= 3)
}

function interpolatePoint(from: ToolpathPoint, to: ToolpathPoint, t: number): ToolpathPoint {
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    z: from.z + (to.z - from.z) * t,
  }
}

function segmentIntersectionT(a: ToolpathPoint, b: ToolpathPoint, c: Point, d: Point): number | null {
  const rX = b.x - a.x
  const rY = b.y - a.y
  const sX = d.x - c.x
  const sY = d.y - c.y
  const denom = rX * sY - rY * sX
  if (Math.abs(denom) < 1e-12) return null

  const cmaX = c.x - a.x
  const cmaY = c.y - a.y
  const t = (cmaX * sY - cmaY * sX) / denom
  const u = (cmaX * rY - cmaY * rX) / denom
  if (t <= 1e-9 || t >= 1 - 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null
  return t
}

function pathEdges(path: ClipperPath): Array<[Point, Point]> {
  const edges: Array<[Point, Point]> = []
  for (let index = 0; index < path.length; index += 1) {
    const current = path[index]
    const next = path[(index + 1) % path.length]
    edges.push([
      { x: current.X / DEFAULT_CLIPPER_SCALE, y: current.Y / DEFAULT_CLIPPER_SCALE },
      { x: next.X / DEFAULT_CLIPPER_SCALE, y: next.Y / DEFAULT_CLIPPER_SCALE },
    ])
  }
  return edges
}

function clipCutMoveToRegion(move: ToolpathMove, mask: RegionMask): LineFragment[] {
  const tValues = [0, 1]
  for (const path of mask.paths) {
    for (const [a, b] of pathEdges(path)) {
      const t = segmentIntersectionT(move.from, move.to, a, b)
      if (t !== null) tValues.push(t)
    }
  }

  const sorted = [...new Set(tValues.map((value) => Number(value.toFixed(12))))]
    .sort((left, right) => left - right)
  const fragments: LineFragment[] = []

  for (let index = 0; index + 1 < sorted.length; index += 1) {
    const startT = sorted[index]
    const endT = sorted[index + 1]
    if (endT - startT <= 1e-9) continue
    const mid = interpolatePoint(move.from, move.to, (startT + endT) / 2)
    if (!mask.containsPoint(mid)) continue
    fragments.push({
      from: interpolatePoint(move.from, move.to, startT),
      to: interpolatePoint(move.from, move.to, endT),
    })
  }

  return fragments
}

function pointsEqual(a: ToolpathPoint | null, b: ToolpathPoint): boolean {
  return !!a
    && Math.abs(a.x - b.x) < 1e-9
    && Math.abs(a.y - b.y) < 1e-9
    && Math.abs(a.z - b.z) < 1e-9
}

function pushSafeTransition(moves: ToolpathMove[], current: ToolpathPoint | null, target: ToolpathPoint, safeZ: number): ToolpathPoint {
  if (pointsEqual(current, target)) return target
  if (current) {
    const safeFrom = { x: current.x, y: current.y, z: safeZ }
    if (Math.abs(current.z - safeZ) > 1e-9) {
      moves.push({ kind: 'rapid', from: current, to: safeFrom })
    }
    const safeTo = { x: target.x, y: target.y, z: safeZ }
    if (Math.abs(safeFrom.x - safeTo.x) > 1e-9 || Math.abs(safeFrom.y - safeTo.y) > 1e-9) {
      moves.push({ kind: 'rapid', from: safeFrom, to: safeTo })
    }
    if (Math.abs(safeTo.z - target.z) > 1e-9) {
      moves.push({ kind: 'plunge', from: safeTo, to: target })
    }
    return target
  }

  const safeTo = { x: target.x, y: target.y, z: safeZ }
  if (Math.abs(safeTo.z - target.z) > 1e-9) {
    moves.push({ kind: 'plunge', from: safeTo, to: target })
  }
  return target
}

function updateBounds(bounds: ToolpathBounds | null, point: ToolpathPoint): ToolpathBounds {
  if (!bounds) {
    return {
      minX: point.x,
      minY: point.y,
      minZ: point.z,
      maxX: point.x,
      maxY: point.y,
      maxZ: point.z,
    }
  }
  return {
    minX: Math.min(bounds.minX, point.x),
    minY: Math.min(bounds.minY, point.y),
    minZ: Math.min(bounds.minZ, point.z),
    maxX: Math.max(bounds.maxX, point.x),
    maxY: Math.max(bounds.maxY, point.y),
    maxZ: Math.max(bounds.maxZ, point.z),
  }
}

function computeBounds(moves: ToolpathMove[]): ToolpathBounds | null {
  let bounds: ToolpathBounds | null = null
  for (const move of moves) {
    bounds = updateBounds(bounds, move.from)
    bounds = updateBounds(bounds, move.to)
  }
  return bounds
}

export function clipToolpathResultToObstaclesByLevel(
  project: Project,
  result: ToolpathResult,
  maskForZ: (z: number) => RegionMask | null,
): ToolpathResult {
  if (result.moves.length === 0) return result

  const safeZ = getOperationSafeZ(project)
  const clippedMoves: ToolpathMove[] = []
  let current: ToolpathPoint | null = null
  const cutMoves = result.moves.filter((move) => move.kind === 'cut')

  for (const move of cutMoves) {
    const mask = maskForZ(move.to.z)
    if (!mask) {
      current = pushSafeTransition(clippedMoves, current, move.from, safeZ)
      clippedMoves.push(move)
      current = move.to
      continue
    }

    const inverseMask: RegionMask = {
      paths: mask.paths,
      containsPoint: (point) => !pointInClipperPaths(point, mask.paths),
    }

    const fragments = clipCutMoveToRegion(move, inverseMask)
    for (const fragment of fragments) {
      // Snap fragment endpoints to Clipper-grid precision (1e-4 mm). The
      // segment/edge intersection in `clipCutMoveToRegion` is FP-only and
      // can drift the endpoint a few picometres past the obstacle boundary
      // (e.g. 10.000000000002 vs 10). That is far below any meaningful
      // machining tolerance, but it means cut endpoints can technically land
      // inside the obstacle's keep-away zone. Snapping the endpoints — and
      // only here, on the obstacle-clip path — pulls them onto the Clipper
      // grid so they land exactly on the obstacle boundary.
      const snappedFrom = snapPointToClipperGrid(fragment.from)
      const snappedTo = snapPointToClipperGrid(fragment.to)
      current = pushSafeTransition(clippedMoves, current, snappedFrom, safeZ)
      clippedMoves.push({
        ...move,
        from: snappedFrom,
        to: snappedTo,
      })
      current = snappedTo
    }
  }

  if (current && Math.abs(current.z - safeZ) > 1e-9) {
    clippedMoves.push({
      kind: 'rapid',
      from: current,
      to: { x: current.x, y: current.y, z: safeZ },
    })
  }

  return {
    ...result,
    moves: clippedMoves,
    bounds: computeBounds(clippedMoves),
  }
}

interface RegionCutGroup {
  moves: ToolpathMove[]
  start: ToolpathPoint
  end: ToolpathPoint
}

/**
 * Greedy nearest-neighbour ordering of per-region cut groups: keep the first
 * group, then always hop to the region whose entry point is closest to where
 * the tool currently sits. Without this, regions are machined in whatever
 * arbitrary order their mask paths happened to be in, so the tool zig-zags back
 * and forth across the part (very visible on rest operations, which produce many
 * small disjoint corner regions). Mirrors orderPartsByNearestBlock.
 */
function orderRegionCutGroupsByNearest(groups: RegionCutGroup[]): RegionCutGroup[] {
  if (groups.length <= 1) return groups

  const ordered: RegionCutGroup[] = [groups[0]]
  const remaining = groups.slice(1)
  let current = groups[0].end

  while (remaining.length > 0) {
    let bestIndex = 0
    let bestDistance = Infinity
    for (let index = 0; index < remaining.length; index += 1) {
      const dx = remaining[index].start.x - current.x
      const dy = remaining[index].start.y - current.y
      const distance = dx * dx + dy * dy
      if (distance < bestDistance) {
        bestIndex = index
        bestDistance = distance
      }
    }
    const [next] = remaining.splice(bestIndex, 1)
    ordered.push(next)
    current = next.end
  }

  return ordered
}

export function clipToolpathResultToRegionMask(
  project: Project,
  result: ToolpathResult,
  mask: RegionMask | null,
): ToolpathResult {
  if (!mask || result.moves.length === 0) return result

  const safeZ = getOperationSafeZ(project)
  const clippedMoves: ToolpathMove[] = []
  let current: ToolpathPoint | null = null
  let clippedCutCount = 0
  const cutMoves = result.moves.filter((move) => move.kind === 'cut')

  // Clip the toolpath to each region independently, keeping every region's
  // fragments in pass order, then visit the regions nearest-first.
  const groups: RegionCutGroup[] = []
  for (const path of mask.paths) {
    const pathMask: RegionMask = {
      paths: [path],
      containsPoint: (point) => pointInClipperPaths(point, [path]),
    }

    const groupMoves: ToolpathMove[] = []
    for (const move of cutMoves) {
      const fragments = clipCutMoveToRegion(move, pathMask)
      if (fragments.length === 0) {
        continue
      }

      if (fragments.length !== 1
        || Math.abs(fragments[0].from.x - move.from.x) > 1e-9
        || Math.abs(fragments[0].from.y - move.from.y) > 1e-9
        || Math.abs(fragments[0].to.x - move.to.x) > 1e-9
        || Math.abs(fragments[0].to.y - move.to.y) > 1e-9) {
        clippedCutCount += 1
      }

      for (const fragment of fragments) {
        groupMoves.push({ ...move, from: fragment.from, to: fragment.to })
      }
    }

    if (groupMoves.length > 0) {
      groups.push({
        moves: groupMoves,
        start: groupMoves[0].from,
        end: groupMoves[groupMoves.length - 1].to,
      })
    }
  }

  for (const group of orderRegionCutGroupsByNearest(groups)) {
    for (const move of group.moves) {
      current = pushSafeTransition(clippedMoves, current, move.from, safeZ)
      clippedMoves.push(move)
      current = move.to
    }
  }

  for (const move of cutMoves) {
    if (clipCutMoveToRegion(move, mask).length === 0) {
      clippedCutCount += 1
    }
  }

  if (current && Math.abs(current.z - safeZ) > 1e-9) {
    clippedMoves.push({
      kind: 'rapid',
      from: current,
      to: { x: current.x, y: current.y, z: safeZ },
    })
  }

  return {
    ...result,
    moves: clippedMoves,
    bounds: computeBounds(clippedMoves),
    warnings: clippedCutCount > 0
      ? [...result.warnings, `Region filter clipped ${clippedCutCount} cut move${clippedCutCount === 1 ? '' : 's'}.`]
      : result.warnings,
  }
}
