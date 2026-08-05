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
import type { ToolpathWarning } from './warningCodes'
import type { Operation, Point, Project, SketchFeature, Tab } from '../../types/project'
import { expandFeatureGeometry, featureHasClosedGeometry } from '../../text'
import type { ClipperPath, ResolvedPocketRegion, ToolpathBounds, ToolpathMove, ToolpathPoint, ToolpathResult } from './types'
import {
  DEFAULT_CLIPPER_SCALE,
  applyContourDirection,
  checkMaxCutDepthWarning,
  flattenProfile,
  fromClipperPath,
  getOperationSafeZ,
  normalizeToolForProject,
  normalizeWinding,
  resolveFeatureZSpan,
  toClipperPath,
} from './geometry'
import { isFeatureFirst, mergeToolpathResults, perFeatureOperations } from './multiFeature'
import { buildInsetRegions, buildOuterContours, cutClosedContours, resolveBandBottomZ } from './pocket'
import { buildMaskFromClipperPaths, buildRegionMask, clipToolpathResultToObstaclesByLevel, clipToolpathResultToRegionMask, splitFeatureTargets } from './regions'
import { resolveInsideEdgeRegions } from './resolver'
import { significantSilhouettePaths } from './silhouette'
import { resolvedProjectFeatures } from '../../store/helpers/resolveFeatures'
import { helixAngularDirection, plungeLimitedFeedScale } from './entry'
import { splitClosedGuideByForbiddenPaths } from './guideFragments'
import { buildTrochoidalContour, DEFAULT_TROCHOIDAL_POINT_BUDGET } from './trochoidalEdge'

const MAX_ROUND_JOIN_ARC_TOLERANCE = DEFAULT_CLIPPER_SCALE * 0.01
const ROUND_JOIN_ARC_TOLERANCE_RATIO = 0.01
const TROCHOIDAL_ENTRY_STEPS_PER_REVOLUTION = 36
const MAX_TROCHOIDAL_ENTRY_MOVES = 20_000
const TROCHOIDAL_GUIDE_SAFETY_FRACTION = 0.01

const pointInPolygon = (ClipperLib.Clipper as unknown as {
  PointInPolygon(point: { X: number; Y: number }, path: ClipperPath): number
}).PointInPolygon

interface PreparedSafetyRegion {
  outer: ClipperPath
  islands: ClipperPath[]
}

interface TrochoidalOperationBudget {
  remainingPoints: number
}

function offsetPaths(
  paths: ClipperPath[],
  delta: number,
  joinType: number = ClipperLib.JoinType.jtMiter,
): ClipperPath[] {
  if (paths.length === 0) {
    return []
  }

  const offset = new ClipperLib.ClipperOffset()
  offset.ArcTolerance = Math.max(
    1,
    Math.min(MAX_ROUND_JOIN_ARC_TOLERANCE, Math.abs(delta) * ROUND_JOIN_ARC_TOLERANCE_RATIO),
  )
  offset.AddPaths(paths, joinType, ClipperLib.EndType.etClosedPolygon)
  const solution = new ClipperLib.Paths()
  offset.Execute(solution, delta)
  return solution as ClipperPath[]
}

function unionPaths(paths: ClipperPath[]): ClipperPath[] {
  if (paths.length === 0) {
    return []
  }

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

function contourStartPoint(points: Point[], z: number): ToolpathPoint {
  const first = points[0] ?? { x: 0, y: 0 }
  return { x: first.x, y: first.y, z }
}

function toClosedCutMoves(points: Point[], z: number): ToolpathMove[] {
  if (points.length < 2) {
    return []
  }

  const moves: ToolpathMove[] = []
  for (let index = 0; index < points.length - 1; index += 1) {
    moves.push({
      kind: 'cut',
      from: { x: points[index].x, y: points[index].y, z },
      to: { x: points[index + 1].x, y: points[index + 1].y, z },
    })
  }

  const first = points[0]
  const last = points[points.length - 1]
  if (first.x !== last.x || first.y !== last.y) {
    moves.push({
      kind: 'cut',
      from: { x: last.x, y: last.y, z },
      to: { x: first.x, y: first.y, z },
    })
  }

  return moves
}

function toOpenCutMoves(points: Point[], z: number): ToolpathMove[] {
  if (points.length < 2) return []
  return points.slice(1).map((point, index) => ({
    kind: 'cut' as const,
    from: { x: points[index].x, y: points[index].y, z },
    to: { x: point.x, y: point.y, z },
  }))
}

function pushRapidAndPlunge(
  moves: ToolpathMove[],
  from: ToolpathPoint | null,
  toXY: ToolpathPoint,
  safeZ: number,
): ToolpathPoint {
  const start = from ?? { x: toXY.x, y: toXY.y, z: safeZ }

  if (!from || from.x !== toXY.x || from.y !== toXY.y || from.z !== safeZ) {
    moves.push({
      kind: 'rapid',
      from: start,
      to: { x: toXY.x, y: toXY.y, z: safeZ },
    })
  }

  moves.push({
    kind: 'plunge',
    from: { x: toXY.x, y: toXY.y, z: safeZ },
    to: toXY,
  })

  return toXY
}

function retractToSafe(moves: ToolpathMove[], from: ToolpathPoint | null, safeZ: number): ToolpathPoint | null {
  if (!from) {
    return null
  }

  const safePoint = { x: from.x, y: from.y, z: safeZ }
  if (from.z !== safeZ) {
    moves.push({
      kind: 'rapid',
      from,
      to: safePoint,
    })
  }
  return safePoint
}

function transitionToCutEntry(
  moves: ToolpathMove[],
  from: ToolpathPoint | null,
  toXY: ToolpathPoint,
  safeZ: number,
  maxLinkDistance: number,
): ToolpathPoint {
  // Vertical-only move at same XY — no retraction needed
  if (from && from.x === toXY.x && from.y === toXY.y) {
    if (from.z === toXY.z) {
      return toXY
    }
    moves.push({
      kind: toXY.z < from.z ? 'plunge' : 'rapid',
      from,
      to: toXY,
    })
    return toXY
  }

  if (from) {
    const dx = toXY.x - from.x
    const dy = toXY.y - from.y
    const distance = Math.hypot(dx, dy)

    if (distance === 0) {
      return toXY
    }

    if (distance <= maxLinkDistance) {
      // Direct cut link — works across Z levels for 3D ramping
      moves.push({
        kind: 'cut',
        from,
        to: toXY,
      })
      return toXY
    }
  }

  const safePosition = retractToSafe(moves, from, safeZ)
  return pushRapidAndPlunge(moves, safePosition, toXY, safeZ)
}

function generateStepLevels(topZ: number, bottomZ: number, stepdown: number): number[] {
  if (!(stepdown > 0)) {
    return [bottomZ]
  }

  const descending = bottomZ < topZ
  if (!descending) {
    return [bottomZ]
  }

  const levels: number[] = []
  let current = topZ
  while (current - stepdown > bottomZ) {
    current -= stepdown
    levels.push(current)
  }
  levels.push(bottomZ)
  return levels
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

function featureSilhouettePaths(feature: SketchFeature): Point[][] {
  if (feature.kind === 'stl' && feature.stl?.silhouettePaths?.length) {
    return significantSilhouettePaths(feature.stl.silhouettePaths)
  }

  const flattened = flattenProfile(feature.sketch.profile)
  return [flattened.points]
}

function featureToClipperPaths(feature: SketchFeature): ClipperPath[] {
  // Clipper normalises closed paths to CCW in Y-up (its outer-polygon convention) regardless
  // of the winding supplied here, so the input orientation does not affect offset output.
  return featureSilhouettePaths(feature).map((path) =>
    toClipperPath(normalizeWinding(path, true), DEFAULT_CLIPPER_SCALE),
  )
}

function isEdgeRouteTargetFeature(feature: SketchFeature, operation: Operation): boolean {
  if (feature.operation === 'region') return true
  if (operation.kind === 'edge_route_inside') return feature.operation === 'subtract'
  return feature.operation === 'add' || feature.operation === 'model'
}

function resolveEffectiveBottom(feature: SketchFeature, project: Project, operation: Operation): number | null {
  const span = resolveFeatureZSpan(project, feature)
  const descending = span.bottom < span.top
  const axialLeave = Math.max(0, operation.stockToLeaveAxial)
  const effectiveBottom = descending
    ? span.bottom + axialLeave
    : span.bottom - axialLeave

  if (descending && effectiveBottom >= span.top) {
    return null
  }

  if (!descending && effectiveBottom <= span.top) {
    return null
  }

  return effectiveBottom
}

function depthValuesMatch(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-6
}

function toClipperPoint(point: Point): { X: number; Y: number } {
  return {
    X: Math.round(point.x * DEFAULT_CLIPPER_SCALE),
    Y: Math.round(point.y * DEFAULT_CLIPPER_SCALE),
  }
}

function prepareSafetyRegions(regions: ResolvedPocketRegion[]): PreparedSafetyRegion[] {
  return regions.map((region) => ({
    outer: toClipperPath(region.outer, DEFAULT_CLIPPER_SCALE),
    islands: region.islands.map((island) => toClipperPath(island, DEFAULT_CLIPPER_SCALE)),
  }))
}

function pointInsideSafeRegions(point: Point, regions: PreparedSafetyRegion[]): boolean {
  const candidate = toClipperPoint(point)
  return regions.some((region) => {
    if (pointInPolygon(candidate, region.outer) === 0) return false
    return region.islands.every((island) => pointInPolygon(candidate, island) !== 1)
  })
}

function pointOutsideForbiddenPaths(point: Point, paths: ClipperPath[]): boolean {
  const candidate = toClipperPoint(point)
  return paths.every((path) => pointInPolygon(candidate, path) !== 1)
}

function orientation(a: { X: number; Y: number }, b: { X: number; Y: number }, c: { X: number; Y: number }): number {
  const cross = (b.X - a.X) * (c.Y - a.Y) - (b.Y - a.Y) * (c.X - a.X)
  return Math.sign(cross)
}

function pointOnSegment(
  point: { X: number; Y: number },
  from: { X: number; Y: number },
  to: { X: number; Y: number },
): boolean {
  return point.X >= Math.min(from.X, to.X) && point.X <= Math.max(from.X, to.X)
    && point.Y >= Math.min(from.Y, to.Y) && point.Y <= Math.max(from.Y, to.Y)
}

function segmentsIntersect(
  a: { X: number; Y: number },
  b: { X: number; Y: number },
  c: { X: number; Y: number },
  d: { X: number; Y: number },
): boolean {
  const abC = orientation(a, b, c)
  const abD = orientation(a, b, d)
  const cdA = orientation(c, d, a)
  const cdB = orientation(c, d, b)
  if (abC !== abD && cdA !== cdB) return true
  return (abC === 0 && pointOnSegment(c, a, b))
    || (abD === 0 && pointOnSegment(d, a, b))
    || (cdA === 0 && pointOnSegment(a, c, d))
    || (cdB === 0 && pointOnSegment(b, c, d))
}

function segmentIntersectsPath(from: Point, to: Point, path: ClipperPath): boolean {
  const a = toClipperPoint(from)
  const b = toClipperPoint(to)
  for (let index = 0; index < path.length; index += 1) {
    if (segmentsIntersect(a, b, path[index], path[(index + 1) % path.length])) return true
  }
  return false
}

function segmentInsideSafeRegions(from: Point, to: Point, regions: PreparedSafetyRegion[]): boolean {
  return regions.some((region) => (
    pointInsideSafeRegions(from, [region])
    && pointInsideSafeRegions(to, [region])
    && !segmentIntersectsPath(from, to, region.outer)
    && region.islands.every((island) => !segmentIntersectsPath(from, to, island))
  ))
}

function segmentOutsideForbiddenPaths(from: Point, to: Point, paths: ClipperPath[]): boolean {
  return pointOutsideForbiddenPaths(from, paths)
    && pointOutsideForbiddenPaths(to, paths)
    && paths.every((path) => !segmentIntersectsPath(from, to, path))
}

function trochoidalPathIsSafe(points: Point[], isSegmentSafe: (from: Point, to: Point) => boolean): boolean {
  return points.length > 1 && points.slice(1).every((point, index) => isSegmentSafe(points[index], point))
}

function tabClipperPaths(tabs: Tab[]): ClipperPath[] {
  return tabs.map((tab) => toClipperPath([
    { x: tab.x, y: tab.y },
    { x: tab.x + tab.w, y: tab.y },
    { x: tab.x + tab.w, y: tab.y + tab.h },
    { x: tab.x, y: tab.y + tab.h },
  ], DEFAULT_CLIPPER_SCALE))
}

function expandedTabPaths(tabs: Tab[], expansion: number): ClipperPath[] {
  return unionPaths(offsetPaths(tabClipperPaths(tabs), expansion * DEFAULT_CLIPPER_SCALE, ClipperLib.JoinType.jtRound))
}

function polylineLength(points: Point[]): number {
  return points.slice(1).reduce((length, point, index) => (
    length + Math.hypot(point.x - points[index].x, point.y - points[index].y)
  ), 0)
}

interface TrochoidalGuideFragment {
  points: Point[]
  z: number
  closed: boolean
  entryStartZ: number
}

type TrochoidalFragmentPlanner = (
  contour: Point[],
  z: number,
  previousZ: number,
  orbitRadius: number,
) => TrochoidalGuideFragment[] | null

const TROCHOIDAL_TAB_EPSILON = 1e-9

function trochoidalEntryStrategy(operation: Operation): 'helix' | 'plunge' {
  return operation.entryStrategy === 'plunge' ? 'plunge' : 'helix'
}

function pointInAnyPath(point: Point, paths: ClipperPath[]): boolean {
  const candidate = toClipperPoint(point)
  return paths.some((path) => pointInPolygon(candidate, path) !== 0)
}

function appendUniqueTrochoidalWarning(warnings: ToolpathWarning[], warning: ToolpathWarning): void {
  const existing = warnings.some((entry) => (
    entry.code === warning.code
      && entry.params?.x === warning.params?.x
      && entry.params?.y === warning.params?.y
  ))
  if (!existing) warnings.push(warning)
}

function validateTrochoidalTabs(tabs: Tab[], warnings: ToolpathWarning[]): boolean {
  const invalid = tabs.find((tab) => (
    !(tab.w > 0)
      || !(tab.h > 0)
      || !(tab.z_top > tab.z_bottom)
  ))
  if (!invalid) return true
  appendUniqueTrochoidalWarning(warnings, {
    code: 'edgeTrochoidalTabUnsafe',
    params: { x: invalid.x, y: invalid.y },
  })
  return false
}

function activeTabsAtZ(tabs: Tab[], z: number): Tab[] {
  return tabs.filter((tab) => z < tab.z_top - TROCHOIDAL_TAB_EPSILON)
}

function tabCutterPathsAtZ(tabs: Tab[], z: number, cutterClearance: number): ClipperPath[] {
  return expandedTabPaths(activeTabsAtZ(tabs, z), cutterClearance)
}

function tabTopForGuideFragment(fragment: Point[], tabs: Tab[], tabGuideClearance: number): number | null {
  const length = polylineLength(fragment)
  if (!(length > 0)) return null
  let remainingLength = length / 2
  let probe: Point | undefined
  for (let index = 1; index < fragment.length; index += 1) {
    const from = fragment[index - 1]
    const to = fragment[index]
    const segmentLength = Math.hypot(to.x - from.x, to.y - from.y)
    if (remainingLength <= segmentLength) {
      const t = remainingLength / segmentLength
      probe = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }
      break
    }
    remainingLength -= segmentLength
  }
  if (!probe) return null
  const covered = tabs.filter((tab) => pointInAnyPath(probe, expandedTabPaths([tab], tabGuideClearance)))
  return covered.length > 0 ? Math.max(...covered.map((tab) => tab.z_top)) : null
}

/**
 * Every interruption is planned against the guide itself before trochoids are
 * emitted. Post-clipping a generated orbit would manufacture an unproven
 * re-entry, so these short spans are independent, helix-entered toolpaths.
 */
function createTrochoidalFragmentPlanner(
  tabs: Tab[],
  staticForbiddenPaths: ClipperPath[],
  tabGuideClearance: number,
  toolDiameter: number,
  operation: Operation,
  warnings: ToolpathWarning[],
): TrochoidalFragmentPlanner {
  return (contour, z, previousZ, orbitRadius) => {
    const activeTabs = activeTabsAtZ(tabs, z)
    const tabPaths = expandedTabPaths(activeTabs, tabGuideClearance)
    const forbidden = unionPaths([...staticForbiddenPaths, ...tabPaths])
    const depthFragments = splitClosedGuideByForbiddenPaths(contour, forbidden)
    const hasOpenDepthFragment = depthFragments.some((fragment) => !fragment.closed)
    if (hasOpenDepthFragment && trochoidalEntryStrategy(operation) !== 'helix') {
      appendUniqueTrochoidalWarning(warnings, {
        code: activeTabs.length > 0 ? 'edgeTrochoidalTabsRequireHelix' : 'edgeTrochoidalEntryStrategyUnsupported',
      })
      return null
    }

    const minimumSpanLength = Math.max(toolDiameter, orbitRadius * 2)
    const planned: TrochoidalGuideFragment[] = []
    for (const fragment of depthFragments) {
      if (!fragment.closed && polylineLength(fragment.points) < minimumSpanLength) {
        appendUniqueTrochoidalWarning(warnings, {
          code: 'edgeTrochoidalSkippedSpan',
          params: { x: fragment.points[0]?.x ?? 0, y: fragment.points[0]?.y ?? 0 },
        })
        continue
      }
      planned.push({
        points: fragment.points,
        z,
        closed: fragment.closed,
        entryStartZ: previousZ,
      })
    }

    if (planned.length === 0) {
      appendUniqueTrochoidalWarning(warnings, {
        code: 'edgeTrochoidalNoSurvivingSpan',
        params: { x: contour[0]?.x ?? 0, y: contour[0]?.y ?? 0 },
      })
      return null
    }

    // A tab is crossed only once: when this descending level first passes its
    // top. The pass at z_top is deliberately local, while every lower level
    // stays in the outside fragments above.
    const crossingTabs = tabs.filter((tab) => (
      previousZ >= tab.z_top - TROCHOIDAL_TAB_EPSILON
        && z < tab.z_top - TROCHOIDAL_TAB_EPSILON
    ))
    if (crossingTabs.length === 0) return planned

    const shallowFragments = splitClosedGuideByForbiddenPaths(
      contour,
      expandedTabPaths(crossingTabs, tabGuideClearance),
      'inside',
    )
    for (const fragment of shallowFragments) {
      const tabTop = tabTopForGuideFragment(fragment.points, crossingTabs, tabGuideClearance)
      if (tabTop === null || polylineLength(fragment.points) < minimumSpanLength) {
        appendUniqueTrochoidalWarning(warnings, {
          code: 'edgeTrochoidalSkippedSpan',
          params: { x: fragment.points[0]?.x ?? 0, y: fragment.points[0]?.y ?? 0 },
        })
        continue
      }
      planned.push({
        points: fragment.points,
        z: tabTop,
        closed: false,
        entryStartZ: tabTop,
      })
    }
    return planned
  }
}

function appendContoursAtLevels(
  moves: ToolpathMove[],
  currentPosition: ToolpathPoint | null,
  contours: Point[][],
  levels: number[],
  safeZ: number,
  maxLinkDistance: number,
): ToolpathPoint | null {
  let nextPosition = currentPosition

  for (const z of levels) {
    for (const contour of contours) {
      const entryPoint = contourStartPoint(contour, z)
      nextPosition = transitionToCutEntry(moves, nextPosition, entryPoint, safeZ, maxLinkDistance)
      const cutMoves = toClosedCutMoves(contour, z)
      moves.push(...cutMoves)
      nextPosition = cutMoves.at(-1)?.to ?? nextPosition
    }
  }

  return nextPosition
}

function hasFatalTrochoidalWarning(warnings: ToolpathWarning[]): boolean {
  return warnings.some((warning) => (
    warning.code === 'edgeTrochoidalInvalidGuide'
    || warning.code === 'edgeTrochoidalMoveBudget'
    || warning.code === 'edgeTrochoidalEntryBudget'
    || warning.code === 'edgeTrochoidalEntryStrategyUnsupported'
    || warning.code === 'edgeTrochoidalTabsRequireHelix'
    || warning.code === 'edgeTrochoidalTabUnsafe'
    || warning.code === 'edgeTrochoidalNoSurvivingSpan'
    || warning.code === 'edgeTrochoidalSafetyCheck'
    || warning.code === 'edgeTrochoidalRegionUnsupported'
    || warning.code === 'edgeTrochoidalWidthTooSmall'
    || warning.code === 'edgeTrochoidalAdvanceRange'
    || warning.code === 'targetsMissingOrWrongRole'
    || warning.code === 'edgeClosedProfilesOnly'
    || warning.code === 'edgeBandNoCutDepth'
    || warning.code === 'edgeNoInsideContour'
    || warning.code === 'edgeFeatureNoCutDepth'
    || warning.code === 'edgeNoContourForFeature'
  ))
}

function appendTrochoidalEntry(
  moves: ToolpathMove[],
  from: ToolpathPoint,
  entry: Point,
  center: Point,
  targetZ: number,
  orbitRadius: number,
  operation: Operation,
  cutSide: 'internal' | 'external',
): ToolpathPoint {
  const points = trochoidalEntryPoints(from, entry, center, targetZ, orbitRadius, operation, cutSide)
  let current = from
  for (const next of points) {
    if (points.length === 1) {
      moves.push({ kind: targetZ < current.z ? 'plunge' : 'rapid', from: current, to: next, source: 'trochoidal-entry' })
    } else {
      const angle = Math.min(45, Math.max(0.1, operation.entryRampAngle ?? 5))
      moves.push({
        kind: 'lead_in',
        from: current,
        to: next,
        feedScale: plungeLimitedFeedScale(operation.feed, operation.plungeFeed, angle),
        source: 'trochoidal-entry',
      })
    }
    current = next
  }
  return current
}

function trochoidalEntryPoints(
  from: ToolpathPoint,
  entry: Point,
  center: Point,
  targetZ: number,
  orbitRadius: number,
  operation: Operation,
  cutSide: 'internal' | 'external',
): ToolpathPoint[] {
  const target = { x: entry.x, y: entry.y, z: targetZ }
  if (targetZ >= from.z || trochoidalEntryStrategy(operation) === 'plunge') {
    return [target]
  }

  const angle = Math.min(45, Math.max(0.1, operation.entryRampAngle ?? 5))
  const pitch = 2 * Math.PI * orbitRadius * Math.tan(angle * Math.PI / 180)
  const revolutions = Math.max(1, Math.ceil((from.z - targetZ) / pitch))
  const steps = revolutions * TROCHOIDAL_ENTRY_STEPS_PER_REVOLUTION
  const startAngle = Math.atan2(entry.y - center.y, entry.x - center.x)
  const angularDirection = helixAngularDirection(operation.cutDirection ?? 'conventional', cutSide)
  const points: ToolpathPoint[] = []
  for (let step = 1; step <= steps; step += 1) {
    const progress = step / steps
    const angleAtStep = startAngle + angularDirection * 2 * Math.PI * revolutions * progress
    points.push({
      x: center.x + Math.cos(angleAtStep) * orbitRadius,
      y: center.y + Math.sin(angleAtStep) * orbitRadius,
      z: from.z + (targetZ - from.z) * progress,
    })
  }
  return points
}

function trochoidalEntryMoveCount(
  fromZ: number,
  targetZ: number,
  orbitRadius: number,
  operation: Operation,
): number {
  if (trochoidalEntryStrategy(operation) === 'plunge' || targetZ >= fromZ) return 0
  const angle = Math.min(45, Math.max(0.1, operation.entryRampAngle ?? 5))
  const pitch = 2 * Math.PI * orbitRadius * Math.tan(angle * Math.PI / 180)
  if (!(pitch > 0)) return MAX_TROCHOIDAL_ENTRY_MOVES + 1
  return Math.max(1, Math.ceil((fromZ - targetZ) / pitch)) * TROCHOIDAL_ENTRY_STEPS_PER_REVOLUTION
}

interface PreparedTrochoidalPath {
  built: ReturnType<typeof buildTrochoidalContour>
  z: number
  entryStartZ: number
  closed: boolean
}

/**
 * Prepare every level before appending moves. This preserves all-target atomicity:
 * a bad guide, unsafe cutter segment, or budget overflow cannot leave a partial cut.
 */
function appendTrochoidalContoursAtLevels(
  moves: ToolpathMove[],
  currentPosition: ToolpathPoint | null,
  contours: Point[][],
  levels: number[],
  topZ: number,
  safeZ: number,
  operation: Operation,
  toolDiameter: number,
  cutSide: 'internal' | 'external',
  warnings: ToolpathWarning[],
  isSegmentSafe: (from: Point, to: Point, z: number) => boolean,
  budget: TrochoidalOperationBudget,
  fragmentPlanner: TrochoidalFragmentPlanner | null = null,
): ToolpathPoint | null {
  const cutWidth = operation.trochoidalCutWidth ?? toolDiameter * 1.5
  const orbitRadius = (cutWidth - toolDiameter) / 2
  const advance = (operation.trochoidalAdvance ?? 0.1) * toolDiameter
  const angularDirection = helixAngularDirection(operation.cutDirection ?? 'conventional', cutSide)
  const prepared: PreparedTrochoidalPath[] = []
  let remainingPoints = budget.remainingPoints

  for (const contour of contours) {
    let previousZ = topZ
    for (const z of levels) {
      let fragments: TrochoidalGuideFragment[]
      if (fragmentPlanner) {
        const planned = fragmentPlanner(contour, z, previousZ, orbitRadius)
        if (planned === null) return currentPosition
        fragments = planned
      } else {
        fragments = [{ points: contour, z, closed: true, entryStartZ: previousZ }]
      }
      for (const fragment of fragments) {
        const entryMoves = trochoidalEntryMoveCount(fragment.entryStartZ, fragment.z, orbitRadius, operation)
        if (entryMoves > MAX_TROCHOIDAL_ENTRY_MOVES || entryMoves + 3 >= remainingPoints) {
          warnings.push({ code: 'edgeTrochoidalEntryBudget', params: { x: fragment.points[0]?.x ?? 0, y: fragment.points[0]?.y ?? 0 } })
          return currentPosition
        }
        const built = buildTrochoidalContour(fragment.points, {
          orbitRadius,
          advance,
          toolDiameter,
          angularDirection,
          closed: fragment.closed,
          maxPoints: remainingPoints - entryMoves - 3,
        })
        if (built.error || built.points.length < 2 || !built.entryCenter) {
          warnings.push({
            code: built.error === 'move-budget' ? 'edgeTrochoidalMoveBudget' : 'edgeTrochoidalInvalidGuide',
            params: { x: fragment.points[0]?.x ?? 0, y: fragment.points[0]?.y ?? 0 },
          })
          return currentPosition
        }
        if (!trochoidalPathIsSafe(built.points, (from, to) => isSegmentSafe(from, to, fragment.z))) {
          warnings.push({ code: 'edgeTrochoidalSafetyCheck', params: { x: fragment.points[0]?.x ?? 0, y: fragment.points[0]?.y ?? 0 } })
          return currentPosition
        }
        const entryAtStart = { x: built.points[0].x, y: built.points[0].y, z: fragment.entryStartZ }
        const entryPoints = trochoidalEntryPoints(
          entryAtStart,
          built.points[0],
          built.entryCenter,
          fragment.z,
          orbitRadius,
          operation,
          cutSide,
        )
        let previousEntryPoint = entryAtStart
        for (const entryPoint of entryPoints) {
          if (!isSegmentSafe(previousEntryPoint, entryPoint, fragment.z)) {
            warnings.push({
              code: 'edgeTrochoidalSafetyCheck',
              params: { x: fragment.points[0]?.x ?? 0, y: fragment.points[0]?.y ?? 0 },
            })
            return currentPosition
          }
          previousEntryPoint = entryPoint
        }
        const consumedPoints = entryMoves + built.points.length + 3
        if (consumedPoints > remainingPoints) {
          warnings.push({ code: 'edgeTrochoidalMoveBudget' })
          return currentPosition
        }
        remainingPoints -= consumedPoints
        prepared.push({ built, z: fragment.z, entryStartZ: fragment.entryStartZ, closed: fragment.closed })
      }
      previousZ = z
    }
  }
  budget.remainingPoints = remainingPoints

  let nextPosition = currentPosition
  for (const path of prepared) {
    const { built, z, entryStartZ, closed } = path
    const entry = built.points[0]
    const sameEntry = closed && nextPosition
      && Math.abs(nextPosition.x - entry.x) <= 1e-9
      && Math.abs(nextPosition.y - entry.y) <= 1e-9
    if (!sameEntry) {
      nextPosition = retractToSafe(moves, nextPosition, safeZ)
      const rapidFrom = nextPosition ?? { x: entry.x, y: entry.y, z: safeZ }
      const rapidTo = { x: entry.x, y: entry.y, z: safeZ }
      if (!nextPosition || rapidFrom.x !== rapidTo.x || rapidFrom.y !== rapidTo.y) {
        moves.push({ kind: 'rapid', from: rapidFrom, to: rapidTo, source: 'trochoidal-transition' })
      }
      nextPosition = rapidTo
      if (entryStartZ < safeZ) {
        const surfacePoint = { x: entry.x, y: entry.y, z: entryStartZ }
        moves.push({ kind: 'plunge', from: nextPosition, to: surfacePoint, source: 'trochoidal-transition' })
        nextPosition = surfacePoint
      }
    }
    if (Math.abs((nextPosition as ToolpathPoint).z - z) > 1e-9) {
      nextPosition = appendTrochoidalEntry(
        moves,
        nextPosition as ToolpathPoint,
        entry,
        built.entryCenter as Point,
        z,
        orbitRadius,
        operation,
        cutSide,
      )
    }
    const cutMoves = closed ? toClosedCutMoves(built.points, z) : toOpenCutMoves(built.points, z)
    moves.push(...cutMoves)
    nextPosition = cutMoves.at(-1)?.to ?? nextPosition
  }
  return nextPosition
}

export function generateEdgeRouteToolpath(project: Project, operation: Operation): ToolpathResult {
  if (operation.kind !== 'edge_route_inside' && operation.kind !== 'edge_route_outside') {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [{ code: 'edgeRouteWrongKind' }],
      bounds: null,
    }
  }

  // Trochoidal fragments are planned by depth so each continuation can prove an
  // entry cavity. Never route them through the feature-first block reordering.
  const isTrochoidal = operation.pass === 'rough' && operation.edgeStrategy === 'trochoidal'
  if (isFeatureFirst(operation) && !isTrochoidal) {
    const parts = perFeatureOperations(operation, project).map((subOp) =>
      generateEdgeRouteToolpathSingle(project, subOp),
    )
    return mergeToolpathResults(operation.id, parts, { orderBlocks: 'nearest' })
  }
  return generateEdgeRouteToolpathSingle(project, operation)
}

function generateEdgeRouteToolpathSingle(project: Project, operation: Operation): ToolpathResult {
  if (operation.kind !== 'edge_route_inside' && operation.kind !== 'edge_route_outside') {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [{ code: 'edgeRouteWrongKind' }],
      bounds: null,
    }
  }

  if (operation.target.source !== 'features' || operation.target.featureIds.length === 0) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [{ code: 'edgeRouteNoTargets' }],
      bounds: null,
    }
  }

  const toolRecord = operation.toolRef
    ? project.tools.find((tool) => tool.id === operation.toolRef) ?? null
    : null

  if (!toolRecord) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [{ code: 'noToolAssigned' }],
      bounds: null,
    }
  }

  const tool = normalizeToolForProject(toolRecord, project)
  if (!(tool.diameter > 0)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [{ code: 'toolDiameterPositive' }],
      bounds: null,
    }
  }

  if (!(operation.stepdown > 0)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [{ code: 'stepdownPositive' }],
      bounds: null,
    }
  }

  const isTrochoidal = operation.pass === 'rough' && operation.edgeStrategy === 'trochoidal'
  const trochoidalCutWidth = operation.trochoidalCutWidth ?? tool.diameter * 1.5
  const trochoidalAdvance = operation.trochoidalAdvance ?? 0.1
  if (isTrochoidal && !(trochoidalCutWidth >= tool.diameter * 1.15)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [{ code: 'edgeTrochoidalWidthTooSmall' }],
      bounds: null,
    }
  }
  if (isTrochoidal && !(trochoidalAdvance > 0 && trochoidalAdvance <= 1)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [{ code: 'edgeTrochoidalAdvanceRange' }],
      bounds: null,
    }
  }
  if (isTrochoidal && (!(operation.feed > 0) || !(operation.plungeFeed > 0) || !(operation.rpm > 0))) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [{ code: 'edgeTrochoidalParametersInvalid' }],
      bounds: null,
    }
  }
  if (isTrochoidal && operation.entryStrategy !== undefined && operation.entryStrategy !== 'helix' && operation.entryStrategy !== 'plunge') {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [{ code: 'edgeTrochoidalEntryStrategyUnsupported' }],
      bounds: null,
    }
  }

  const splitTargets = splitFeatureTargets(project, operation.target.featureIds)
  const selectedFeatures = splitTargets.machiningFeatures
  const regionMask = buildRegionMask(splitTargets.regionFeatures)

  const targetFeatures = selectedFeatures
    .flatMap((feature) => (feature.operation === 'model' ? [feature] : expandFeatureGeometry(feature)))
    .filter((feature) => isEdgeRouteTargetFeature(feature, operation))

  const warnings: ToolpathWarning[] = []
  const trochoidalTabs = isTrochoidal ? project.tabs : []
  if (isTrochoidal && !validateTrochoidalTabs(trochoidalTabs, warnings)) {
    return { operationId: operation.id, moves: [], warnings, bounds: null }
  }
  if (isTrochoidal && trochoidalCutWidth < tool.diameter * 1.25) {
    warnings.push({ code: 'edgeTrochoidalWidthNarrow' })
  }
  if (isTrochoidal && splitTargets.regionFeatures.length > 0) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...warnings, { code: 'edgeTrochoidalRegionUnsupported' }],
      bounds: null,
    }
  }
  const maxFeatureDepth = targetFeatures.reduce((max, feature) => {
    const span = resolveFeatureZSpan(project, feature)
    return Math.max(max, span.height)
  }, 0)
  const depthWarning = checkMaxCutDepthWarning(tool, maxFeatureDepth)
  if (depthWarning) {
    warnings.push(depthWarning)
  }

  if (splitTargets.missingFeatureIds.length > 0 || targetFeatures.length < selectedFeatures.length) {
    warnings.push({
      code: 'targetsMissingOrWrongRole',
      params: { roles: operation.kind === 'edge_route_inside' ? 'subtract/region' : 'add/model/region' },
    })
  }

  const closedTargetFeatures = targetFeatures.filter((feature) => featureHasClosedGeometry(feature))
  if (closedTargetFeatures.length !== targetFeatures.length) {
    warnings.push({ code: 'edgeClosedProfilesOnly' })
  }

  if (isTrochoidal && hasFatalTrochoidalWarning(warnings)) {
    return { operationId: operation.id, moves: [], warnings, bounds: null }
  }

  if (closedTargetFeatures.length === 0) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...warnings, { code: 'edgeRouteNoValidTargets' }],
      bounds: null,
    }
  }

  const safeZ = getOperationSafeZ(project)
  const radialLeave = Math.max(0, operation.stockToLeaveRadial)
  // This is the one guide clearance used to keep the complete orbit and cutter
  // off the retained wall. Reusing the same value in every guide calculation is
  // load-bearing: separate approximations can turn a visual seam into a gouge.
  const trochoidalGuideOffset = radialLeave
    + trochoidalCutWidth / 2
    + tool.diameter * TROCHOIDAL_GUIDE_SAFETY_FRACTION
  // Keep guide-fragment endpoints one extra epsilon away from the tab's
  // cutter footprint. The orbit closes in place at each fragment endpoint;
  // a merely tangent endpoint is therefore an intersection, not safe margin.
  const trochoidalTabGuideClearance = trochoidalCutWidth / 2
    + tool.diameter * TROCHOIDAL_GUIDE_SAFETY_FRACTION * 2
  const trochoidalTabCutterClearance = tool.radius
    + tool.diameter * TROCHOIDAL_GUIDE_SAFETY_FRACTION
  const offsetDistance =
    operation.kind === 'edge_route_inside'
      ? -(isTrochoidal ? trochoidalGuideOffset : tool.radius + radialLeave)
      : isTrochoidal ? trochoidalGuideOffset : tool.radius + radialLeave

  const moves: ToolpathMove[] = []
  const trochoidalBudget: TrochoidalOperationBudget = {
    remainingPoints: DEFAULT_TROCHOIDAL_POINT_BUDGET,
  }
  let currentPosition: ToolpathPoint | null = null
  const maxLinkDistance = tool.diameter
  const direction = operation.cutDirection ?? 'conventional'
  // Clipper's ClipperOffset always normalises closed-polygon paths to CCW in machine
  // Y-up coords (isClockwise=false) before applying the delta, so the output is always
  // CCW regardless of input winding.  CCW in Y-up = conventional for INSIDE cuts but
  // = climb for OUTSIDE cuts (where conventional requires CW in Y-up, isClockwise=true).
  // Invert the requested direction for outside so applyContourDirection maps correctly.
  const outsideDirection = (direction === 'conventional' ? 'climb' : 'conventional') as typeof direction

  if (operation.kind === 'edge_route_inside') {
    const resolved = resolveInsideEdgeRegions(project, operation)
    warnings.push(...resolved.warnings)
    const insideInset = isTrochoidal ? trochoidalGuideOffset : tool.radius + radialLeave

    for (const band of resolved.bands) {
      const effectiveBottom = resolveBandBottomZ(band, operation)
      if (effectiveBottom === null) {
        warnings.push({ code: 'edgeBandNoCutDepth', params: { topZ: band.topZ, bottomZ: band.bottomZ } })
        continue
      }

      const insetRegions = band.regions.flatMap((region) => buildInsetRegions(region, insideInset))
      const rawContours = buildOuterContours(insetRegions)
      if (rawContours.length === 0) {
        warnings.push({ code: 'edgeNoInsideContour', params: { topZ: band.topZ, bottomZ: band.bottomZ } })
        continue
      }

      const contours = applyContourDirection(rawContours, direction)
      const levels =
        operation.pass === 'finish'
          ? [effectiveBottom]
          : generateStepLevels(band.topZ, effectiveBottom, operation.stepdown)

      if (isTrochoidal) {
        const safeRegions = prepareSafetyRegions(band.regions.flatMap((region) => buildInsetRegions(
          region,
          tool.radius + radialLeave,
        )))
        currentPosition = appendTrochoidalContoursAtLevels(
          moves,
          currentPosition,
          contours,
          levels,
          band.topZ,
          safeZ,
          operation,
          tool.diameter,
          'internal',
          warnings,
          (from, to, z) => segmentInsideSafeRegions(from, to, safeRegions)
            && segmentOutsideForbiddenPaths(
              from,
              to,
              tabCutterPathsAtZ(trochoidalTabs, z, trochoidalTabCutterClearance),
            ),
          trochoidalBudget,
          createTrochoidalFragmentPlanner(
            trochoidalTabs,
            [],
            trochoidalTabGuideClearance,
            tool.diameter,
            operation,
            warnings,
          ),
        )
        if (hasFatalTrochoidalWarning(warnings)) break
      } else {
        for (const z of levels) {
          currentPosition = cutClosedContours(moves, contours, z, safeZ, maxLinkDistance, currentPosition)
        }
      }
    }

    if (isTrochoidal && hasFatalTrochoidalWarning(warnings)) {
      return { operationId: operation.id, moves: [], warnings, bounds: null }
    }

    currentPosition = retractToSafe(moves, currentPosition, safeZ)

    let bounds: ToolpathBounds | null = null
    for (const move of moves) {
      bounds = updateBounds(bounds, move.from)
      bounds = updateBounds(bounds, move.to)
    }

    const result = {
      operationId: operation.id,
      moves,
      warnings,
      bounds,
    }
    return clipToolpathResultToRegionMask(project, result, regionMask)
  }

  const routableTargets = closedTargetFeatures
    .map((feature) => {
      const effectiveBottom = resolveEffectiveBottom(feature, project, operation)
      if (effectiveBottom === null) {
        warnings.push({ code: 'edgeFeatureNoCutDepth', params: { name: feature.name } })
        return null
      }

      const span = resolveFeatureZSpan(project, feature)
      return {
        feature,
        contourPaths: featureToClipperPaths(feature),
        topZ: span.top,
        bottomZ: effectiveBottom,
      }
    })
    .filter((entry): entry is { feature: SketchFeature; contourPaths: ClipperPath[]; topZ: number; bottomZ: number } => entry !== null)

  if (routableTargets.length === 0) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...warnings, { code: 'edgeRouteNoValidTargets' }],
      bounds: null,
    }
  }

  const targetFeatureIdSet = new Set(closedTargetFeatures.map((feature) => feature.id))
  const allAdditiveObstacles = resolvedProjectFeatures(project)
    .flatMap((feature) => (feature.operation === 'model' ? [feature] : expandFeatureGeometry(feature)))
    .filter((feature) => (feature.operation === 'add' || feature.operation === 'model') && featureHasClosedGeometry(feature))
    .filter((feature) => !targetFeatureIdSet.has(feature.id))
    .map((feature) => ({
      paths: featureToClipperPaths(feature),
      span: resolveFeatureZSpan(project, feature),
    }))

  const obstacleMaskCache = new Map<string, ReturnType<typeof buildMaskFromClipperPaths>>()
  function obstacleMaskForZ(z: number) {
    const key = z.toFixed(9)
    const cached = obstacleMaskCache.get(key)
    if (cached !== undefined) return cached
    const activePaths = allAdditiveObstacles
      .filter(({ span }) => z <= span.max && z >= span.min)
      .flatMap(({ paths }) => paths)
    let mask: ReturnType<typeof buildMaskFromClipperPaths> = null
    if (activePaths.length > 0) {
      mask = buildMaskFromClipperPaths(offsetPaths(activePaths, tool.radius * DEFAULT_CLIPPER_SCALE))
    }
    obstacleMaskCache.set(key, mask)
    return mask
  }

  function trochoidalObstaclePathsForSpan(
    topZ: number,
    bottomZ: number,
    clearance: number,
  ): ClipperPath[] {
    const minZ = Math.min(topZ, bottomZ)
    const maxZ = Math.max(topZ, bottomZ)
    const activePaths = allAdditiveObstacles
      .filter(({ span }) => span.max >= minZ && span.min <= maxZ)
      .flatMap(({ paths }) => paths)
    return unionPaths(offsetPaths(
      activePaths,
      clearance * DEFAULT_CLIPPER_SCALE,
      ClipperLib.JoinType.jtRound,
    ))
  }

  const outsideJoinType = operation.roundOutsideCorners
    ? ClipperLib.JoinType.jtRound
    : ClipperLib.JoinType.jtMiter

  function resolveContourPaths(paths: ClipperPath[]): Point[][] {
    const offset = offsetPaths(paths, offsetDistance * DEFAULT_CLIPPER_SCALE, outsideJoinType)
    return offset.map((entry) => fromClipperPath(entry)).filter((points) => points.length >= 3)
  }

  const shouldAttemptCombinedOutside = operation.kind === 'edge_route_outside' && routableTargets.length > 1
  if (shouldAttemptCombinedOutside) {
    const referenceTarget = routableTargets[0]
    const canCombineOutsideTargets = routableTargets.every((target) => (
      depthValuesMatch(target.topZ, referenceTarget.topZ)
      && depthValuesMatch(target.bottomZ, referenceTarget.bottomZ)
    ))

    if (canCombineOutsideTargets) {
      const combinedPaths = unionPaths(routableTargets.flatMap((target) => target.contourPaths))
      const rawContours = resolveContourPaths(combinedPaths)

      if (rawContours.length === 0) {
        warnings.push({ code: 'edgeNoCombinedContour' })
      } else {
        const contours = applyContourDirection(rawContours, outsideDirection)
        const levels =
          operation.pass === 'finish'
            ? [referenceTarget.bottomZ]
            : generateStepLevels(referenceTarget.topZ, referenceTarget.bottomZ, operation.stepdown)

        if (isTrochoidal) {
          const retainedWall = offsetPaths(
            combinedPaths,
            (tool.radius + radialLeave) * DEFAULT_CLIPPER_SCALE,
            ClipperLib.JoinType.jtRound,
          )
          const obstacles = trochoidalObstaclePathsForSpan(
            referenceTarget.topZ,
            referenceTarget.bottomZ,
            tool.radius + radialLeave,
          )
          const guideObstacles = trochoidalObstaclePathsForSpan(
            referenceTarget.topZ,
            referenceTarget.bottomZ,
            trochoidalGuideOffset,
          )
          currentPosition = appendTrochoidalContoursAtLevels(
            moves,
            currentPosition,
            contours,
            levels,
            referenceTarget.topZ,
            safeZ,
            operation,
            tool.diameter,
            'external',
            warnings,
            (from, to, z) => segmentOutsideForbiddenPaths(from, to, retainedWall)
              && segmentOutsideForbiddenPaths(from, to, obstacles)
              && segmentOutsideForbiddenPaths(
                from,
                to,
                tabCutterPathsAtZ(trochoidalTabs, z, trochoidalTabCutterClearance),
              ),
            trochoidalBudget,
            createTrochoidalFragmentPlanner(
              trochoidalTabs,
              guideObstacles,
              trochoidalTabGuideClearance,
              tool.diameter,
              operation,
              warnings,
            ),
          )
        } else {
          currentPosition = appendContoursAtLevels(moves, currentPosition, contours, levels, safeZ, maxLinkDistance)
        }
      }
    } else {
      warnings.push(
        { code: 'edgeMixedDepthSpans' },
      )
    }
  }

  if (moves.length === 0 && !(isTrochoidal && hasFatalTrochoidalWarning(warnings))) {
    for (const target of routableTargets) {
      const rawContours = resolveContourPaths(target.contourPaths)
      if (rawContours.length === 0) {
        warnings.push({ code: 'edgeNoContourForFeature', params: { name: target.feature.name } })
        continue
      }

      const contours = applyContourDirection(rawContours, outsideDirection)
      const levels =
        operation.pass === 'finish'
          ? [target.bottomZ]
          : generateStepLevels(target.topZ, target.bottomZ, operation.stepdown)

      if (isTrochoidal) {
        const retainedWall = offsetPaths(
          target.contourPaths,
          (tool.radius + radialLeave) * DEFAULT_CLIPPER_SCALE,
          ClipperLib.JoinType.jtRound,
        )
        const obstacles = trochoidalObstaclePathsForSpan(
          target.topZ,
          target.bottomZ,
          tool.radius + radialLeave,
        )
        const guideObstacles = trochoidalObstaclePathsForSpan(
          target.topZ,
          target.bottomZ,
          trochoidalGuideOffset,
        )
        currentPosition = appendTrochoidalContoursAtLevels(
          moves,
          currentPosition,
          contours,
          levels,
          target.topZ,
          safeZ,
          operation,
          tool.diameter,
          'external',
          warnings,
          (from, to, z) => segmentOutsideForbiddenPaths(from, to, retainedWall)
            && segmentOutsideForbiddenPaths(from, to, obstacles)
            && segmentOutsideForbiddenPaths(
              from,
              to,
              tabCutterPathsAtZ(trochoidalTabs, z, trochoidalTabCutterClearance),
            ),
          trochoidalBudget,
          createTrochoidalFragmentPlanner(
            trochoidalTabs,
            guideObstacles,
            trochoidalTabGuideClearance,
            tool.diameter,
            operation,
            warnings,
          ),
        )
        if (hasFatalTrochoidalWarning(warnings)) break
      } else {
        currentPosition = appendContoursAtLevels(moves, currentPosition, contours, levels, safeZ, maxLinkDistance)
      }
    }
  }

  if (isTrochoidal && hasFatalTrochoidalWarning(warnings)) {
    return { operationId: operation.id, moves: [], warnings, bounds: null }
  }

  currentPosition = retractToSafe(moves, currentPosition, safeZ)

  let bounds: ToolpathBounds | null = null
  for (const move of moves) {
    bounds = updateBounds(bounds, move.from)
    bounds = updateBounds(bounds, move.to)
  }

  let result: ToolpathResult = {
    operationId: operation.id,
    moves,
    warnings,
    bounds,
  }
  if (!isTrochoidal && allAdditiveObstacles.length > 0) {
    result = clipToolpathResultToObstaclesByLevel(project, result, obstacleMaskForZ)
  }
  if (isTrochoidal) return result
  return clipToolpathResultToRegionMask(project, result, regionMask)
}
