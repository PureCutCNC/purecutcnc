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
import { isMachinable, isRegion } from '../../store/helpers/featureRoles'
import { resolveFeatureInstances } from '../../store/helpers/resolveFeatures'
import type { Point, Project, SketchFeature } from '../../types/project'
import type { ClipperPath } from './types'
import {
  DEFAULT_CLIPPER_SCALE,
  flattenProfile,
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
  hasIncludeRegions: boolean
  excludePaths: ClipperPath[]
  boundaryPaths: ClipperPath[]
  baseIncludesSubject: boolean
  entries: RegionMaskEntry[]
  containsPoint(point: Point): boolean
}

interface RegionMaskEntry {
  mode: 'include' | 'exclude'
  paths: ClipperPath[]
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
  const featureOrder = new Map(project.features.map((feature, index) => [feature.id, index]))
  const resolvedById = new Map(
    resolveFeatureInstances(project, featureIds).map((feature) => [feature.id, feature]),
  )

  for (const featureId of featureIds) {
    const feature = resolvedById.get(featureId) ?? null
    if (feature) {
      features.push(feature)
    } else {
      missingFeatureIds.push(featureId)
    }
  }

  return {
    features,
    // Construction geometry lands in NEITHER list — it is not machinable and
    // not a region mask, so it can never leak into a toolpath (issue #199).
    machiningFeatures: features.filter(isMachinable),
    regionFeatures: features
      .filter(isRegion)
      .sort((left, right) => (featureOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER)
        - (featureOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER)),
    missingFeatureIds,
  }
}

/** Repeat a region's geometry every `period` along one axis (#1096). */
export interface RegionRepeat {
  /** The coordinate the geometry repeats along: across the bar for rotary. */
  readonly axis: 'x' | 'y'
  readonly period: number
}

/**
 * The mask a set of region features builds (#1096 carries a second caller).
 *
 * `repeat` replicates every feature's geometry one period each way. A rotary
 * operation's region is drawn on the Around sheet, which is one circumference
 * wide and centred on A0: the same bar surface is reachable at `a`, `a - 360`
 * and `a + 360`, so the mask is tested at a position that may be one sheet turn
 * away from the drawn shape. Replicating the **geometry** before the ordered
 * include/exclude composition is what makes an `exclude` region mean the same
 * area on every sheet turn; replicating the point instead would turn an
 * exclude's "not here" into a match at a neighbouring turn. Absent, the mask
 * is exactly the pre-#1096 geometry.
 */
export function buildRegionMask(
  regionFeatures: SketchFeature[],
  repeat?: RegionRepeat,
): RegionMask | null {
  let paths: ClipperPath[] = []
  let excludePaths: ClipperPath[] = []
  let boundaryPaths: ClipperPath[] = []
  const entries: RegionMaskEntry[] = []
  let hasIncludeRegions = false
  let baseIncludesSubject = false
  let sawValidRegion = false
  const repeatShifts = repeat === undefined ? [0] : [-repeat.period, 0, repeat.period]

  for (const feature of regionFeatures) {
    if (feature.operation !== 'region' || !feature.sketch.profile.closed) continue
    const flattened = flattenProfile(feature.sketch.profile)
    if (flattened.points.length < 3) continue
    const featurePaths = repeatShifts.map((shift) => toClipperPath(normalizeWinding(
      repeat === undefined || shift === 0
        ? flattened.points
        : flattened.points.map((point) => (repeat.axis === 'y'
          ? { x: point.x, y: point.y + shift }
          : { x: point.x + shift, y: point.y })),
      false,
    ), DEFAULT_CLIPPER_SCALE))
    const mode = feature.regionMaskMode ?? 'include'
    if (!sawValidRegion) {
      baseIncludesSubject = mode === 'exclude'
      sawValidRegion = true
    }
    entries.push({ mode, paths: featurePaths })
    boundaryPaths = [...boundaryPaths, ...featurePaths]

    if (mode === 'exclude') {
      paths = executeClipPaths(paths, featurePaths, ClipperLib.ClipType.ctDifference)
      excludePaths = unionPaths([...excludePaths, ...featurePaths])
    } else {
      hasIncludeRegions = true
      paths = unionPaths([...paths, ...featurePaths])
    }
  }

  if (!sawValidRegion) return null
  const clipPaths = hasIncludeRegions ? paths : excludePaths
  return {
    paths: clipPaths,
    hasIncludeRegions,
    excludePaths,
    boundaryPaths,
    baseIncludesSubject,
    entries,
    containsPoint: (point) => {
      let included = baseIncludesSubject
      for (const entry of entries) {
        if (!pointInClipperPaths(point, entry.paths)) continue
        included = entry.mode === 'include'
      }
      return included
    },
  }
}

export function buildMaskFromClipperPaths(paths: ClipperPath[]): RegionMask | null {
  if (paths.length === 0) return null
  return {
    paths,
    hasIncludeRegions: true,
    excludePaths: [],
    boundaryPaths: paths,
    baseIncludesSubject: false,
    entries: [{ mode: 'include', paths }],
    containsPoint: (point) => pointInClipperPaths(point, paths),
  }
}

export function applyRegionMaskToPaths(subjectPaths: ClipperPath[], mask: RegionMask | null): ClipperPath[] {
  if (subjectPaths.length === 0 || !mask) return subjectPaths
  let result = mask.baseIncludesSubject ? subjectPaths : []
  for (const entry of mask.entries) {
    if (entry.mode === 'include') {
      const includedSubject = executeClipPaths(subjectPaths, entry.paths, ClipperLib.ClipType.ctIntersection)
      result = unionPaths([...result, ...includedSubject])
    } else {
      result = executeClipPaths(result, entry.paths, ClipperLib.ClipType.ctDifference)
    }
  }
  return result
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
  if (contours.length === 0 || !mask) return []

  const subjectPaths = contours
    .filter((contour) => contour.length >= 3)
    .map((contour) => contour.map(([x, y]) => ({
      X: Math.round(x * DEFAULT_CLIPPER_SCALE),
      Y: Math.round(y * DEFAULT_CLIPPER_SCALE),
    }))) as ClipperPath[]

  if (subjectPaths.length === 0) return []

  return applyRegionMaskToPaths(subjectPaths, mask)
    .map((path) => path.map((point) => [
      point.X / DEFAULT_CLIPPER_SCALE,
      point.Y / DEFAULT_CLIPPER_SCALE,
    ] as [number, number]))
    .filter((contour) => contour.length >= 3)
}
