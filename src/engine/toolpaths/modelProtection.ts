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
import type { ToolpathWarning } from './warningCodes'
import {
  DEFAULT_CLIPPER_SCALE,
  flattenProfile,
  normalizeWinding,
  resolveFeatureZSpan,
  toClipperPath,
} from './geometry'
import { significantSilhouettePaths } from './silhouette'
import { resolvedProjectFeatures } from '../../store/helpers/resolveFeatures'
import { appendAll } from './appendAll'

// clipper-lib exposes pftEvenOdd at runtime, but its TS type only includes pftNonZero.
const POLY_FILL_EVEN_ODD = 0

export interface ProtectedFootprintOptions {
  targetFeatureIds: Set<string>
  z?: number
  featureExpansion?: number
  clampExpansion?: number
  tabExpansion?: number
  includeTabs?: boolean
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

export function unionClipperPathsEvenOdd(paths: ClipperPath[]): ClipperPath[] {
  if (paths.length === 0) return []

  const clipper = new ClipperLib.Clipper()
  clipper.AddPaths(paths, ClipperLib.PolyType.ptSubject, true)
  const solution = new ClipperLib.Paths()
  clipper.Execute(
    ClipperLib.ClipType.ctUnion,
    solution,
    POLY_FILL_EVEN_ODD,
    POLY_FILL_EVEN_ODD,
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
  appendAll(paths, offsetClipperPaths(nextPaths, Math.max(0, expansion)))
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

  for (const feature of resolvedProjectFeatures(project)) {
    if (targetFeatureIds.has(feature.id)) continue
    if (feature.operation !== 'subtract') continue

    const footprintPaths = featureFootprintPaths(feature)
    if (!pathsContainEnvelope(footprintPaths, machiningEnvelopePaths)) continue

    const span = resolveFeatureZSpan(project, feature)
    bottom = bottom === null ? span.min : Math.min(bottom, span.min)
  }

  return bottom
}

/**
 * Returns true if `subjectPaths` is fully contained within any non-target add
 * feature's footprint — i.e. the subtract is "owned by" that add feature
 * (it represents the add's own pocket) rather than carving into the model.
 * Used to exclude such subtracts from the 3D operation's Z-range calculation,
 * so an add-feature pocket that happens to fall within the model's XY
 * silhouette does not incorrectly pull the model operation's bottom Z deeper.
 */
/**
 * True if some non-target add feature "owns" the subject footprint — i.e. the
 * add feature strictly contains the subject AND the add feature does not
 * itself cover the entire model footprint. The latter distinguishes an
 * "intersecting" topographic add (a small boss/island on or near the model)
 * from a "containing" base feature (stock-defining envelope around the
 * model). A subtract inside the former is the add's own pocket and must not
 * pull the model operation's Z range deeper. A subtract co-extensive with a
 * containing add is the user's model-pocket and must keep constraining Z.
 */
export function isFootprintInsideAddFeature(
  project: Project,
  subjectPaths: ClipperPath[],
  targetFeatureIds: Set<string>,
  modelFootprintPaths: ClipperPath[],
): boolean {
  if (subjectPaths.length === 0) return false
  for (const feature of resolvedProjectFeatures(project)) {
    if (targetFeatureIds.has(feature.id)) continue
    if (feature.operation !== 'add') continue
    const addPaths = featureFootprintPaths(feature)
    if (addPaths.length === 0) continue
    // Add must strictly contain the subject (so the subject is internal to
    // the add, with material around it).
    if (differenceClipperPaths(subjectPaths, addPaths).length !== 0) continue
    if (differenceClipperPaths(addPaths, subjectPaths).length === 0) continue
    // Add must NOT also cover the entire model footprint — that pattern is
    // the user defining stock geometry around the model, not a topographic
    // feature with its own pocket.
    if (modelFootprintPaths.length > 0
      && differenceClipperPaths(modelFootprintPaths, addPaths).length === 0) {
      continue
    }
    return true
  }
  return false
}

export function relatedSubtractFeatures(
  project: Project,
  targetFeatureIds: Set<string>,
  modelFootprintPaths: ClipperPath[],
): Array<{ feature: SketchFeature; paths: ClipperPath[]; bottomZ: number; topZ: number; clearancePaths?: ClipperPath[] }> {
  const related: Array<{ feature: SketchFeature; paths: ClipperPath[]; bottomZ: number; topZ: number; clearancePaths?: ClipperPath[] }> = []

  for (const feature of resolvedProjectFeatures(project)) {
    if (targetFeatureIds.has(feature.id)) continue
    if (feature.operation !== 'subtract') continue

    const paths = featureFootprintPaths(feature)
    if (paths.length === 0 || intersectClipperPaths(modelFootprintPaths, paths).length === 0) continue
    // A subtract that lives entirely within an add feature's footprint is the
    // add's own pocket — its depth must not constrain the 3D model operation's
    // Z range, even though its XY footprint overlaps the model silhouette.
    if (isFootprintInsideAddFeature(project, paths, targetFeatureIds, modelFootprintPaths)) continue

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

/**
 * Non-target add features whose footprint intersects the 3D model silhouette
 * — these create vertical walls inside the model's machining envelope and
 * must be finished alongside the model's own walls. Some callers can exclude
 * add features that fully contain the model footprint when those should be
 * treated as base/stock geometry rather than intersecting model walls.
 */
export function relatedIntersectingAddFeatures(
  project: Project,
  targetFeatureIds: Set<string>,
  modelFootprintPaths: ClipperPath[],
  options: { excludeContainingAddFeatures?: boolean } = {},
): Array<{ feature: SketchFeature; paths: ClipperPath[]; bottomZ: number; topZ: number }> {
  const related: Array<{ feature: SketchFeature; paths: ClipperPath[]; bottomZ: number; topZ: number }> = []

  for (const feature of resolvedProjectFeatures(project)) {
    if (targetFeatureIds.has(feature.id)) continue
    if (feature.operation !== 'add') continue

    const paths = featureFootprintPaths(feature)
    if (paths.length === 0) continue
    if (intersectClipperPaths(modelFootprintPaths, paths).length === 0) continue
    if (options.excludeContainingAddFeatures && pathsContainEnvelope(paths, modelFootprintPaths)) continue

    const span = resolveFeatureZSpan(project, feature)
    related.push({ feature, paths, bottomZ: span.min, topZ: span.max })
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

/**
 * Even-odd point-in-region test for a `ClipperPath[]` that represents a
 * polygon-with-holes (outer rings + hole rings, mixed). Each `PointInPolygon`
 * hit toggles "inside" — a point inside an outer alone is inside; a point
 * inside both an outer and a hole nested in it cancels out to outside.
 */
export function pointInClipperPaths(paths: ClipperPath[], point: Point): boolean {
  if (paths.length === 0) return false
  const cp = {
    X: Math.round(point.x * DEFAULT_CLIPPER_SCALE),
    Y: Math.round(point.y * DEFAULT_CLIPPER_SCALE),
  }
  let inside = false
  for (const path of paths) {
    const res = (ClipperLib.Clipper as unknown as { PointInPolygon(point: { X: number; Y: number }, path: ClipperPath): number })
      .PointInPolygon(cp, path)
    if (res !== 0) inside = !inside
  }
  return inside
}

/**
 * Returns true if every point on the segment `from`→`to` is inside the region
 * defined by `paths`. Samples both endpoints plus interior points spaced at
 * roughly `sampleSpacing` units. The caller is responsible for inflating the
 * region inward by tool radius before passing it here — `paths` is treated as
 * the *tool-center safe zone*, not the cut boundary.
 */
export function segmentInsideClipperPaths(
  paths: ClipperPath[],
  from: Point,
  to: Point,
  sampleSpacing: number,
): boolean {
  if (paths.length === 0) return false
  if (!pointInClipperPaths(paths, from)) return false
  if (!pointInClipperPaths(paths, to)) return false
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy)
  if (length === 0) return true
  const spacing = Math.max(sampleSpacing, length * 1e-3)
  const steps = Math.max(1, Math.ceil(length / spacing))
  for (let i = 1; i < steps; i += 1) {
    const t = i / steps
    if (!pointInClipperPaths(paths, { x: from.x + dx * t, y: from.y + dy * t })) {
      return false
    }
  }
  return true
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

export interface ExpandedTabFootprint {
  paths: ClipperPath[]
  topZ: number
}

export function buildExpandedTabFootprints(
  project: Project,
  tabExpansion: number,
): ExpandedTabFootprint[] {
  const expansion = Math.max(0, tabExpansion)
  const footprints: ExpandedTabFootprint[] = []
  for (const tab of project.tabs) {
    if (!tab.visible) continue
    const profile = rectProfile(tab.x, tab.y, tab.w, tab.h)
    const rawPath = toClipperPath(
      normalizeWinding(flattenProfile(profile).points, false),
      DEFAULT_CLIPPER_SCALE,
    )
    const expanded = expansion > 0 ? offsetClipperPaths([rawPath], expansion) : [rawPath]
    if (expanded.length === 0) continue
    footprints.push({ paths: expanded, topZ: tab.z_top })
  }
  return footprints
}

export function tabTopZAtPoint(
  footprints: ExpandedTabFootprint[],
  point: Point,
): number | null {
  if (footprints.length === 0) return null
  const clipperPoint = {
    X: Math.round(point.x * DEFAULT_CLIPPER_SCALE),
    Y: Math.round(point.y * DEFAULT_CLIPPER_SCALE),
  }
  let highest: number | null = null
  for (const footprint of footprints) {
    const inside = footprint.paths.some((path) => (
      (ClipperLib.Clipper as unknown as { PointInPolygon(point: { X: number; Y: number }, path: ClipperPath): number })
        .PointInPolygon(clipperPoint, path) !== 0
    ))
    if (!inside) continue
    highest = highest === null ? footprint.topZ : Math.max(highest, footprint.topZ)
  }
  return highest
}

/**
 * The margin by which a generation-time clamp keep-out overshoots the footprint
 * `applyClampWarnings` checks against.
 *
 * `segmentIntersectsRect2D` in `clamps.ts` is inclusive on the boundary, so a
 * path that correctly stops *at* the keep-out edge still counts as crossing it.
 * Measured on `main` @ 055c1b4: a waterline finish whose deepest penetration into
 * the checked footprint is 0.0000 raised 840 `clampCrossed*` warnings purely from
 * that tangency. Four Clipper units of overshoot puts the path outside the test
 * without moving the cut anywhere a user would see.
 */
export const CLAMP_KEEPOUT_EPSILON = 4 / DEFAULT_CLIPPER_SCALE

export interface ClampKeepOutOptions {
  /**
   * The level being cut. A clamp constrains it only while the cut sits below
   * the clamp's required clearance; omit to constrain every level, which is the
   * conservative answer for a caller with no single Z.
   */
  z?: number
  /**
   * Distance from the tool centre to the far side of whatever the caller is
   * keeping out — `tool.radius` for a tool-centre path, the trochoidal guide
   * offset for an orbit guide, `0` for a caller that offsets the result itself.
   */
  expansion: number
}

/**
 * Clamp footprints grown to a keep-out the tool centre must stay out of:
 * `clamp ⊕ (clampClearanceXY + expansion + CLAMP_KEEPOUT_EPSILON)`.
 *
 * The single source of truth for "where a clamp forbids cutting". It matches
 * `buildExpandedClampBounds` in `clamps.ts` — the backstop that judges the
 * finished toolpath — because a generator that avoids a *different* footprint
 * from the one being checked is worse than one that avoids nothing: it would
 * lose cut without silencing the warning.
 *
 * **Returns `[]` when the project has no visible clamp**, so every caller can
 * short-circuit and a project without clamps runs not one Clipper operation more
 * than it did before. That is what keeps no-clamp output byte-identical.
 */
export function clampKeepOutPaths(project: Project, options: ClampKeepOutOptions): ClipperPath[] {
  const keepOuts = clampKeepOuts(project, options)
  if (keepOuts.length === 0) return []
  return unionClipperPaths(keepOuts.flatMap((keepOut) => keepOut.paths))
}

/**
 * Report each clamp that took material out of an operation, once per operation.
 *
 * Deduped by name because a clamp typically blocks several bands or levels of
 * the same operation, and six identical lines in the panel say no more than one.
 */
export function appendClampBlockedWarnings(
  warnings: ToolpathWarning[],
  blocking: ClampKeepOut[],
): void {
  for (const keepOut of blocking) {
    const already = warnings.some(
      (warning) => warning.code === 'clampBlockedCut' && warning.params?.name === keepOut.clampName,
    )
    if (already) continue
    warnings.push({ code: 'clampBlockedCut', params: { name: keepOut.clampName } })
  }
}

/**
 * The clamps whose keep-out actually removes part of `domain` — the ones worth
 * naming to the user, as opposed to the ones that merely exist.
 *
 * Reported rather than inferred: a clamp sitting harmlessly beside the work must
 * not raise "material was left uncut", and a clamp that really did eat into a
 * pocket must not stay silent. Only an intersection with the domain about to be
 * cut tells those apart.
 */
export function clampsBlockingArea(
  project: Project,
  domain: ClipperPath[],
  options: ClampKeepOutOptions,
): ClampKeepOut[] {
  if (domain.length === 0) return []
  return clampKeepOuts(project, options)
    .filter((keepOut) => intersectClipperPaths(keepOut.paths, domain).length > 0)
}

export interface ClampKeepOut {
  clampId: string
  clampName: string
  paths: ClipperPath[]
  /** Cutting at or above this Z clears the clamp; below it the footprint is forbidden. */
  requiredZ: number
}

/**
 * {@link clampKeepOutPaths} split per clamp, for callers that carry a Z span
 * rather than a single level — an obstacle set filtered per cut level, say —
 * and so need each clamp's own `requiredZ` instead of one merged polygon.
 */
export function clampKeepOuts(project: Project, options: ClampKeepOutOptions): ClampKeepOut[] {
  const clearanceXY = Math.max(0, project.meta.clampClearanceXY)
  const clearanceZ = Math.max(0, project.meta.clampClearanceZ)
  const expansion = Math.max(0, options.expansion)
  const keepOuts: ClampKeepOut[] = []

  for (const clamp of project.clamps) {
    if (!clamp.visible) continue
    const requiredZ = clamp.height + clearanceZ
    // A clamp is a solid standing on the table, so it blocks every level below
    // its required clearance and none above it. `undefined` means the caller has
    // no single level to judge and takes the whole clamp.
    if (options.z !== undefined && options.z >= requiredZ) continue
    const profile = rectProfile(clamp.x, clamp.y, clamp.w, clamp.h)
    const paths: ClipperPath[] = []
    appendExpanded(
      paths,
      [toClipperPath(normalizeWinding(flattenProfile(profile).points, false), DEFAULT_CLIPPER_SCALE)],
      clearanceXY + expansion + CLAMP_KEEPOUT_EPSILON,
    )
    if (paths.length === 0) continue
    keepOuts.push({ clampId: clamp.id, clampName: clamp.name, paths, requiredZ })
  }

  return keepOuts
}

export function buildProtectedFootprintPaths(
  project: Project,
  options: ProtectedFootprintOptions,
): ClipperPath[] {
  const protectedPaths: ClipperPath[] = []
  const featureExpansion = Math.max(0, options.featureExpansion ?? 0)
  const tabExpansion = Math.max(0, options.tabExpansion ?? featureExpansion)
  const clampExpansion = Math.max(0, options.clampExpansion ?? featureExpansion)

  for (const feature of resolvedProjectFeatures(project)) {
    if (options.targetFeatureIds.has(feature.id)) continue
    if (feature.operation !== 'add' && feature.operation !== 'model') continue
    if (!isActiveAtZ(project, feature, options.z)) continue

    const expandedFootprints = offsetClipperPaths(featureFootprintPaths(feature), featureExpansion)
    if (pathsContainEnvelope(expandedFootprints, options.machiningEnvelopePaths)) continue
    appendAll(protectedPaths, expandedFootprints)
  }

  if (options.includeTabs !== false) {
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
  }

  appendAll(protectedPaths, clampKeepOutPaths(project, { z: options.z, expansion: clampExpansion }))

  return unionClipperPaths(protectedPaths)
}

export function calculateClipperArea(paths: ClipperPath[]): number {
  let total = 0
  for (const path of paths) {
    // Area() returns positive for CW, negative for CCW
    total += ClipperLib.Clipper.Area(path)
  }
  // If the outer contour is CCW, total will be negative.
  return Math.abs(total) / (DEFAULT_CLIPPER_SCALE * DEFAULT_CLIPPER_SCALE)
}
