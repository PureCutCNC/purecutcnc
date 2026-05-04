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
  return paths.some((path) => (
    (ClipperLib.Clipper as unknown as { PointInPolygon(point: { X: number; Y: number }, path: ClipperPath): number })
      .PointInPolygon(clipperPoint, path) !== 0
  ))
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
  const paths = unionPaths(regionFeatures.flatMap((feature) => {
    if (feature.operation !== 'region' || !feature.sketch.profile.closed) return []
    const flattened = flattenProfile(feature.sketch.profile)
    if (flattened.points.length < 3) return []
    return [toClipperPath(normalizeWinding(flattened.points, false), DEFAULT_CLIPPER_SCALE)]
  }))

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

  for (const path of mask.paths) {
    const pathMask: RegionMask = {
      paths: [path],
      containsPoint: (point) => pointInClipperPaths(point, [path]),
    }

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
        current = pushSafeTransition(clippedMoves, current, fragment.from, safeZ)
        clippedMoves.push({
          ...move,
          from: fragment.from,
          to: fragment.to,
        })
        current = fragment.to
      }
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
