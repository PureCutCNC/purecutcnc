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
import { rectProfile, type Point, type Project, type SketchFeature } from '../../types/project'
import type { ClipperPath } from './types'
import {
  DEFAULT_CLIPPER_SCALE,
  flattenProfile,
  normalizeWinding,
  resolveFeatureZSpan,
  toClipperPath,
} from './geometry'
import { significantSilhouettePaths } from './silhouette'

export interface ProtectedFootprintOptions {
  targetFeatureIds: Set<string>
  z?: number
  featureExpansion?: number
  clampExpansion?: number
  tabExpansion?: number
  machiningEnvelopePaths?: ClipperPath[]
}

export function offsetClipperPaths(paths: ClipperPath[], delta: number): ClipperPath[] {
  if (paths.length === 0) return []
  if (Math.abs(delta) <= 1e-9) return paths

  const offset = new ClipperLib.ClipperOffset()
  offset.AddPaths(paths, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon)
  const solution = new ClipperLib.Paths()
  offset.Execute(solution, Math.round(delta * DEFAULT_CLIPPER_SCALE))
  return solution as ClipperPath[]
}

export function unionClipperPaths(paths: ClipperPath[]): ClipperPath[] {
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

export function differenceClipperPaths(subjectPaths: ClipperPath[], clipPaths: ClipperPath[]): ClipperPath[] {
  if (subjectPaths.length === 0 || clipPaths.length === 0) return subjectPaths

  const clipper = new ClipperLib.Clipper()
  clipper.AddPaths(subjectPaths, ClipperLib.PolyType.ptSubject, true)
  clipper.AddPaths(clipPaths, ClipperLib.PolyType.ptClip, true)
  const solution = new ClipperLib.Paths()
  clipper.Execute(
    ClipperLib.ClipType.ctDifference,
    solution,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  )
  return solution as ClipperPath[]
}

export function intersectClipperPaths(subjectPaths: ClipperPath[], clipPaths: ClipperPath[]): ClipperPath[] {
  if (subjectPaths.length === 0 || clipPaths.length === 0) return []

  const clipper = new ClipperLib.Clipper()
  clipper.AddPaths(subjectPaths, ClipperLib.PolyType.ptSubject, true)
  clipper.AddPaths(clipPaths, ClipperLib.PolyType.ptClip, true)
  const solution = new ClipperLib.Paths()
  clipper.Execute(
    ClipperLib.ClipType.ctIntersection,
    solution,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  )
  return solution as ClipperPath[]
}

export function clipperPathsToPointContours(paths: ClipperPath[]): Point[][] {
  return paths
    .filter((path) => path.length >= 3)
    .map((path) => path.map((point) => ({ x: point.X / DEFAULT_CLIPPER_SCALE, y: point.Y / DEFAULT_CLIPPER_SCALE })))
}

export function clipperPathsToTupleContours(paths: ClipperPath[]): Array<Array<[number, number]>> {
  return paths
    .filter((path) => path.length >= 3)
    .map((path) => path.map((point) => [point.X / DEFAULT_CLIPPER_SCALE, point.Y / DEFAULT_CLIPPER_SCALE]))
}

export function featureFootprintPaths(feature: SketchFeature): ClipperPath[] {
  if (feature.kind === 'stl' && feature.stl?.silhouettePaths?.length) {
    return significantSilhouettePaths(feature.stl.silhouettePaths)
      .map((path) => toClipperPath(normalizeWinding(path, true), DEFAULT_CLIPPER_SCALE))
  }

  if (!feature.sketch.profile.closed) return []
  const flattened = flattenProfile(feature.sketch.profile)
  if (flattened.points.length < 3) return []
  return [toClipperPath(normalizeWinding(flattened.points, false), DEFAULT_CLIPPER_SCALE)]
}

function isActiveAtZ(project: Project, feature: SketchFeature, z: number | undefined): boolean {
  if (z === undefined) return true
  const span = resolveFeatureZSpan(project, feature)
  return z <= span.max + 1e-9 && z >= span.min - 1e-9
}

function appendExpanded(paths: ClipperPath[], nextPaths: ClipperPath[], expansion: number): void {
  paths.push(...offsetClipperPaths(nextPaths, Math.max(0, expansion)))
}

export function pathsContainEnvelope(candidatePaths: ClipperPath[], envelopePaths: ClipperPath[] | undefined): boolean {
  if (candidatePaths.length === 0 || !envelopePaths || envelopePaths.length === 0) return false
  return differenceClipperPaths(envelopePaths, candidatePaths).length === 0
}

export function containingSubtractBottomZ(
  project: Project,
  targetFeatureIds: Set<string>,
  machiningEnvelopePaths: ClipperPath[],
): number | null {
  let bottom: number | null = null

  for (const feature of project.features) {
    if (targetFeatureIds.has(feature.id)) continue
    if (feature.operation !== 'subtract') continue

    const footprintPaths = featureFootprintPaths(feature)
    if (!pathsContainEnvelope(footprintPaths, machiningEnvelopePaths)) continue

    const span = resolveFeatureZSpan(project, feature)
    bottom = bottom === null ? span.min : Math.min(bottom, span.min)
  }

  return bottom
}

export function relatedSubtractFeatures(
  project: Project,
  targetFeatureIds: Set<string>,
  modelFootprintPaths: ClipperPath[],
): Array<{ feature: SketchFeature; paths: ClipperPath[]; bottomZ: number; topZ: number; clearancePaths?: ClipperPath[] }> {
  const related: Array<{ feature: SketchFeature; paths: ClipperPath[]; bottomZ: number; topZ: number; clearancePaths?: ClipperPath[] }> = []

  for (const feature of project.features) {
    if (targetFeatureIds.has(feature.id)) continue
    if (feature.operation !== 'subtract') continue

    const paths = featureFootprintPaths(feature)
    if (paths.length === 0 || intersectClipperPaths(modelFootprintPaths, paths).length === 0) continue

    const span = resolveFeatureZSpan(project, feature)
    related.push({
      feature,
      paths,
      bottomZ: span.min,
      topZ: span.max,
    })
  }

  return related
}

export function subtractBottomZAtPoint(
  subtracts: Array<{ paths: ClipperPath[]; bottomZ: number; clearancePaths?: ClipperPath[] }>,
  point: Point,
): number | null {
  const clipperPoint = {
    X: Math.round(point.x * DEFAULT_CLIPPER_SCALE),
    Y: Math.round(point.y * DEFAULT_CLIPPER_SCALE),
  }
  let bottom: number | null = null

  for (const subtract of subtracts) {
    const inside = subtract.paths.some((path) => (
      (ClipperLib.Clipper as unknown as { PointInPolygon(point: { X: number; Y: number }, path: ClipperPath): number })
        .PointInPolygon(clipperPoint, path) !== 0
    ))
    if (!inside) continue
    bottom = bottom === null ? subtract.bottomZ : Math.min(bottom, subtract.bottomZ)
  }

  return bottom
}

export function safeSubtractBottomZAtPoint(
  subtracts: Array<{ paths: ClipperPath[]; bottomZ: number; clearancePaths?: ClipperPath[] }>,
  point: Point,
): number | null {
  const clipperPoint = {
    X: Math.round(point.x * DEFAULT_CLIPPER_SCALE),
    Y: Math.round(point.y * DEFAULT_CLIPPER_SCALE),
  }
  let deepestClearanceBottom: number | null = null
  let shallowestContainingBottom: number | null = null

  for (const subtract of subtracts) {
    const insideOriginal = subtract.paths.some((path) => (
      (ClipperLib.Clipper as unknown as { PointInPolygon(point: { X: number; Y: number }, path: ClipperPath): number })
        .PointInPolygon(clipperPoint, path) !== 0
    ))
    if (!insideOriginal) continue

    shallowestContainingBottom = shallowestContainingBottom === null
      ? subtract.bottomZ
      : Math.max(shallowestContainingBottom, subtract.bottomZ)

    const clearancePaths = subtract.clearancePaths ?? subtract.paths
    const insideClearance = clearancePaths.some((path) => (
      (ClipperLib.Clipper as unknown as { PointInPolygon(point: { X: number; Y: number }, path: ClipperPath): number })
        .PointInPolygon(clipperPoint, path) !== 0
    ))
    if (!insideClearance) continue

    deepestClearanceBottom = deepestClearanceBottom === null
      ? subtract.bottomZ
      : Math.min(deepestClearanceBottom, subtract.bottomZ)
  }

  return deepestClearanceBottom ?? shallowestContainingBottom
}

export function buildProtectedFootprintPaths(
  project: Project,
  options: ProtectedFootprintOptions,
): ClipperPath[] {
  const protectedPaths: ClipperPath[] = []
  const featureExpansion = Math.max(0, options.featureExpansion ?? 0)
  const tabExpansion = Math.max(0, options.tabExpansion ?? featureExpansion)
  const clampExpansion = Math.max(0, options.clampExpansion ?? featureExpansion)

  for (const feature of project.features) {
    if (options.targetFeatureIds.has(feature.id)) continue
    if (feature.operation !== 'add' && feature.operation !== 'model') continue
    if (!isActiveAtZ(project, feature, options.z)) continue

    const expandedFootprints = offsetClipperPaths(featureFootprintPaths(feature), featureExpansion)
    if (pathsContainEnvelope(expandedFootprints, options.machiningEnvelopePaths)) continue
    protectedPaths.push(...expandedFootprints)
  }

  for (const tab of project.tabs) {
    if (!tab.visible) continue
    if (options.z !== undefined) {
      const minZ = Math.min(tab.z_bottom, tab.z_top)
      const maxZ = Math.max(tab.z_bottom, tab.z_top)
      if (options.z < minZ - 1e-9 || options.z > maxZ + 1e-9) continue
    }
    const profile = rectProfile(tab.x, tab.y, tab.w, tab.h)
    appendExpanded(
      protectedPaths,
      [toClipperPath(normalizeWinding(flattenProfile(profile).points, false), DEFAULT_CLIPPER_SCALE)],
      tabExpansion,
    )
  }

  const clampBaseExpansion = Math.max(0, project.meta.clampClearanceXY)
  for (const clamp of project.clamps) {
    if (!clamp.visible) continue
    const profile = rectProfile(clamp.x, clamp.y, clamp.w, clamp.h)
    appendExpanded(
      protectedPaths,
      [toClipperPath(normalizeWinding(flattenProfile(profile).points, false), DEFAULT_CLIPPER_SCALE)],
      clampBaseExpansion + clampExpansion,
    )
  }

  return unionClipperPaths(protectedPaths)
}
