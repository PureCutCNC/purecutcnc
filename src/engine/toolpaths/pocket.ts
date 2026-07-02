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
import type { CutDirection, Operation, Point, Project } from '../../types/project'
import type {
  ClipperPath,
  PocketToolpathResult,
  ResolvedPocketBand,
  ResolvedPocketRegion,
  ToolpathBounds,
  ToolpathMove,
  ToolpathPoint,
} from './types'
import {
  DEFAULT_CLIPPER_SCALE,
  applyContourDirection,
  checkMaxCutDepthWarning,
  fromClipperPath,
  getOperationSafeZ,
  normalizeWinding,
  normalizeToolForProject,
  resolveFeatureZSpan,
  toClipperPath,
} from './geometry'
import { isFeatureFirst, mergePocketToolpathResults, perFeatureOperations } from './multiFeature'
import { resolvePocketRegions } from './resolver'
import { buildRegionMask, clipToolpathResultToRegionMask, splitCutMoveAtContours, splitFeatureTargets } from './regions'

interface PolyTreeNode {
  IsHole(): boolean
  Contour(): ClipperPath
  Childs?: () => PolyTreeNode[]
  m_Childs?: PolyTreeNode[]
}

function getChildren(node: PolyTreeNode): PolyTreeNode[] {
  return node.Childs ? node.Childs() : (node.m_Childs ?? [])
}

/**
 * Remove consecutive vertices that are closer than minDist (in integer Clipper units).
 * Reduces noise introduced by Clipper offset operations.
 */
function cleanClipperPath(path: ClipperPath, minDist: number): ClipperPath {
  if (path.length === 0) return path
  const out: ClipperPath = [path[0]]
  for (let i = 1; i < path.length; i++) {
    const prev = out[out.length - 1]
    const cur = path[i]
    const dx = cur.X - prev.X
    const dy = cur.Y - prev.Y
    if (Math.sqrt(dx * dx + dy * dy) >= minDist) {
      out.push(cur)
    }
  }
  return out
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
  offset.AddPaths(paths, joinType, ClipperLib.EndType.etClosedPolygon)
  const solution = new ClipperLib.Paths()
  offset.Execute(solution, delta)
  // Filter near-duplicate vertices (threshold: 1 Clipper unit ≈ 1/scale project units)
  return (solution as ClipperPath[]).map((path) => cleanClipperPath(path, 1.0))
}

export function executeDifference(subjectPaths: ClipperPath[], clipPaths: ClipperPath[]): PolyTreeNode {
  const clipper = new ClipperLib.Clipper()
  if (subjectPaths.length > 0) {
    clipper.AddPaths(subjectPaths, ClipperLib.PolyType.ptSubject, true)
  }
  if (clipPaths.length > 0) {
    clipper.AddPaths(clipPaths, ClipperLib.PolyType.ptClip, true)
  }

  const polyTree = new ClipperLib.PolyTree()
  clipper.Execute(
    ClipperLib.ClipType.ctDifference,
    polyTree,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  )

  return polyTree as PolyTreeNode
}

export function polyTreeToRegions(
  node: PolyTreeNode,
  targetFeatureIds: string[],
  islandFeatureIds: string[],
  scale = DEFAULT_CLIPPER_SCALE,
): ResolvedPocketRegion[] {
  const regions: ResolvedPocketRegion[] = []
  const contour = node.Contour()

  if (contour.length > 0 && !node.IsHole()) {
    const children = getChildren(node)
    const islands = children
      .filter((child) => child.IsHole())
      .map((child) => fromClipperPath(child.Contour(), scale))

    regions.push({
      outer: fromClipperPath(contour, scale),
      islands,
      targetFeatureIds,
      islandFeatureIds,
    })
  }

  for (const child of getChildren(node)) {
    regions.push(...polyTreeToRegions(child, targetFeatureIds, islandFeatureIds, scale))
  }

  return regions
}

export function contourStartPoint(points: Point[], z: number): ToolpathPoint {
  const first = points[0] ?? { x: 0, y: 0 }
  return { x: first.x, y: first.y, z }
}

export function toClosedCutMoves(points: Point[], z: number): ToolpathMove[] {
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

export function pushRapidAndPlunge(
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

export function retractToSafe(moves: ToolpathMove[], from: ToolpathPoint | null, safeZ: number): ToolpathPoint | null {
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

/**
 * Optional callback for deciding whether a straight tool-center segment from
 * `from` to `to` can be cut directly at Z (skipping retract/plunge). Returns
 * true when the segment is known to lie inside already-cleared material.
 */
export type SafeLinkCheck = (from: ToolpathPoint, to: ToolpathPoint) => boolean

type OffsetTraversalMode = 'outer-first' | 'inner-first'

const XY_ALIGN_EPS = 1e-6

/**
 * A cut is "adjacent to cleared material" when it runs within one stepover of
 * an already-cleared child offset region. The factor adds tolerance for the
 * Clipper round-trip (inset by stepover, expand back by stepover) not being a
 * perfect identity at corners.
 */
const SLOT_FEED_ADJACENCY_FACTOR = 1.05

export interface SlotFeedOptions {
  /** Multiplier (0..1) applied to fully engaged cut moves. */
  scale: number
  /** Distance treated as "adjacent to cleared material": one stepover plus tolerance. */
  adjacency: number
}

/**
 * Resolve the operation's slot-feed percentage into a cut-feed multiplier.
 * Returns null when the reduction is disabled (non-pocket kinds, undefined,
 * out-of-range, or 100%), which callers use to skip all slot-feed work so the
 * generated move stream is byte-identical to the pre-feature output.
 */
export function resolveSlotFeedScale(operation: Operation): number | null {
  if (operation.kind !== 'pocket') return null
  const percent = operation.pocketSlotFeedPercent
  if (percent === undefined || !(percent > 0) || percent >= 100) return null
  return percent / 100
}

interface EngagementMask {
  contours: Point[][]
  contains(point: Point): boolean
}

function pointInContour(point: Point, contour: Point[]): boolean {
  let inside = false
  for (let index = 0, previous = contour.length - 1; index < contour.length; previous = index, index += 1) {
    const a = contour[index]
    const b = contour[previous]
    const crosses = (a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    if (crosses) inside = !inside
  }
  return inside
}

/**
 * Build the cleared-adjacency mask from the regions already machined at this
 * level (the current node's child offset regions, expanded by the adjacency
 * distance). A point inside the mask is within one stepover of cleared
 * material, so a cut through it has normal stepover engagement; a point
 * outside is virgin material, so a cut through it is fully engaged.
 */
function buildEngagementMask(clearedRegions: ResolvedPocketRegion[]): EngagementMask {
  const contours: Point[][] = []
  for (const region of clearedRegions) {
    if (region.outer.length >= 3) contours.push(region.outer)
    for (const island of region.islands) {
      if (island.length >= 3) contours.push(island)
    }
  }
  return {
    contours,
    contains: (point) => clearedRegions.some((region) =>
      region.outer.length >= 3
      && pointInContour(point, region.outer)
      && !region.islands.some((island) => island.length >= 3 && pointInContour(point, island))),
  }
}

/**
 * Re-stamp the cut moves appended since startIndex: fragments outside the
 * cleared-adjacency mask are fully engaged and get the reduced slot feed;
 * fragments inside keep the normal feed. Moves spanning both zones are split
 * at the mask boundary. With no mask (or an empty one) everything is virgin
 * material and every cut move in the range is stamped. Rapids and plunges
 * are left untouched.
 */
function applySlotFeedScale(
  moves: ToolpathMove[],
  startIndex: number,
  scale: number,
  mask: EngagementMask | null,
): void {
  if (startIndex >= moves.length) return

  const stamped: ToolpathMove[] = []
  for (let index = startIndex; index < moves.length; index += 1) {
    const move = moves[index]
    if (move.kind !== 'cut') {
      stamped.push(move)
      continue
    }

    if (!mask || mask.contours.length === 0) {
      stamped.push({ ...move, feedScale: scale })
      continue
    }

    for (const fragment of splitCutMoveAtContours(move, mask.contours, mask.contains)) {
      stamped.push(fragment.inside
        ? { ...move, from: fragment.from, to: fragment.to }
        : { ...move, from: fragment.from, to: fragment.to, feedScale: scale })
    }
  }

  moves.length = startIndex
  for (const move of stamped) {
    moves.push(move)
  }
}

export function transitionToCutEntry(
  moves: ToolpathMove[],
  from: ToolpathPoint | null,
  toXY: ToolpathPoint,
  safeZ: number,
  maxLinkDistance: number,
  safeLinkCheck?: SafeLinkCheck,
): ToolpathPoint {
  if (from) {
    const dx = toXY.x - from.x
    const dy = toXY.y - from.y
    const distance = Math.hypot(dx, dy)
    const dz = toXY.z - from.z

    // Same XY (within epsilon): no XY travel needed. If Z descends, plunge
    // straight down to the next cut start rather than retracting to safe Z
    // and re-plunging. If Z ascends, rapid up. Same Z: no-op.
    if (distance <= XY_ALIGN_EPS) {
      if (dz < -XY_ALIGN_EPS) {
        moves.push({ kind: 'plunge', from, to: toXY })
      } else if (dz > XY_ALIGN_EPS) {
        moves.push({ kind: 'rapid', from, to: toXY })
      }
      return toXY
    }

    const isStartingFromSafeZ = Math.abs(from.z - safeZ) <= XY_ALIGN_EPS
    const isDescendingToCut = toXY.z < safeZ - XY_ALIGN_EPS
    if (isStartingFromSafeZ && isDescendingToCut) {
      // After a level retract, keep XY travel at safe Z and enter the next level vertically.
      return pushRapidAndPlunge(moves, from, toXY, safeZ)
    }

    if (distance <= maxLinkDistance) {
      // Direct cut link — works across Z levels (3D cut moves are valid
      // for ramping between layers in roughing/surface operations). When
      // a safe-link check is supplied it must also approve the segment;
      // this is the path used by 3D roughing to link offset rings at Z
      // inside the previously cleared area instead of round-tripping
      // through safe Z.
      if (!safeLinkCheck || safeLinkCheck(from, toXY)) {
        moves.push({
          kind: 'cut',
          from,
          to: toXY,
        })
        return toXY
      }
    }
  }

  const safePosition = retractToSafe(moves, from, safeZ)
  return pushRapidAndPlunge(moves, safePosition, toXY, safeZ)
}

export function generateStepLevels(topZ: number, bottomZ: number, stepdown: number): number[] {
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

export function resolveBandBottomZ(band: ResolvedPocketBand, operation: Operation): number | null {
  const descending = band.bottomZ < band.topZ
  const axialLeave = Math.max(0, operation.stockToLeaveAxial)
  const effectiveBottom = descending
    ? band.bottomZ + axialLeave
    : band.bottomZ - axialLeave

  if (descending && effectiveBottom >= band.topZ) {
    return null
  }

  if (!descending && effectiveBottom <= band.topZ) {
    return null
  }

  return effectiveBottom
}

export function updateBounds(bounds: ToolpathBounds | null, point: ToolpathPoint): ToolpathBounds {
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

export function buildInsetRegions(
  region: ResolvedPocketRegion,
  delta: number,
  joinType: number = ClipperLib.JoinType.jtMiter,
): ResolvedPocketRegion[] {
  const scale = DEFAULT_CLIPPER_SCALE
  const outerPath = toClipperPath(normalizeWinding(region.outer, false), scale)
  const islandPaths = region.islands.map((island) => toClipperPath(normalizeWinding(island, false), scale))

  const insetOuterPaths = offsetPaths([outerPath], -delta * scale, joinType)
  if (insetOuterPaths.length === 0) {
    return []
  }

  const expandedIslandPaths = offsetPaths(islandPaths, delta * scale, joinType)
  const clipped = executeDifference(insetOuterPaths, expandedIslandPaths)
  return polyTreeToRegions(clipped, region.targetFeatureIds, region.islandFeatureIds, scale)
    .filter((nextRegion) => nextRegion.outer.length >= 3)
}

export function buildContourLoops(regions: ResolvedPocketRegion[]): Point[][] {
  const contours: Point[][] = []

  for (const region of regions) {
    if (region.outer.length >= 3) {
      contours.push(region.outer)
    }

    for (const island of region.islands) {
      if (island.length >= 3) {
        contours.push(island)
      }
    }
  }

  return contours
}

export function buildOuterContours(regions: ResolvedPocketRegion[]): Point[][] {
  return regions
    .map((region) => region.outer)
    .filter((contour) => contour.length >= 3)
}

export function buildPocketFloorContours(
  regions: ResolvedPocketRegion[],
  initialInset: number,
  stepoverDistance: number,
): Point[][] {
  const contours: Point[][] = []
  const minStepover = 1 / DEFAULT_CLIPPER_SCALE
  const effectiveStepover = Math.max(stepoverDistance, minStepover)
  let currentRegions = regions.flatMap((region) => buildInsetRegions(region, initialInset))

  // Floor cleanup should not implicitly double as a wall-finish contour.
  // Start one stepover inside the finish boundary so "Finish Floor" can be
  // used independently from "Finish Walls".
  currentRegions = currentRegions.flatMap((region) => buildInsetRegions(region, effectiveStepover))

  while (currentRegions.length > 0) {
    const loops = buildOuterContours(currentRegions)
    if (loops.length === 0) {
      break
    }

    contours.push(...loops)
    currentRegions = currentRegions.flatMap((region) => buildInsetRegions(region, effectiveStepover))
  }

  return contours
}

function pointEpsilonEqual(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) <= 1e-9 && Math.abs(a.y - b.y) <= 1e-9
}

function polygonYBounds(points: Point[]): { minY: number; maxY: number } | null {
  if (points.length < 3) {
    return null
  }

  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const point of points) {
    minY = Math.min(minY, point.y)
    maxY = Math.max(maxY, point.y)
  }

  return Number.isFinite(minY) && Number.isFinite(maxY) ? { minY, maxY } : null
}

function scanlineIntervals(points: Point[], y: number): Array<[number, number]> {
  const intersections: number[] = []
  const closed =
    points.length > 0 && pointEpsilonEqual(points[0], points[points.length - 1])
      ? points
      : [...points, points[0]]

  for (let index = 0; index < closed.length - 1; index += 1) {
    const a = closed[index]
    const b = closed[index + 1]

    if (Math.abs(a.y - b.y) <= 1e-9) {
      continue
    }

    const intersects =
      (a.y <= y && b.y > y) ||
      (b.y <= y && a.y > y)

    if (!intersects) {
      continue
    }

    const t = (y - a.y) / (b.y - a.y)
    intersections.push(a.x + (b.x - a.x) * t)
  }

  intersections.sort((left, right) => left - right)

  const intervals: Array<[number, number]> = []
  for (let index = 0; index + 1 < intersections.length; index += 2) {
    const start = intersections[index]
    const end = intersections[index + 1]
    if (end - start > 1e-9) {
      intervals.push([start, end])
    }
  }

  return intervals
}

function subtractIntervals(
  baseIntervals: Array<[number, number]>,
  clipIntervals: Array<[number, number]>,
): Array<[number, number]> {
  let remaining = [...baseIntervals]

  for (const [clipStart, clipEnd] of clipIntervals) {
    const next: Array<[number, number]> = []
    for (const [start, end] of remaining) {
      if (clipEnd <= start || clipStart >= end) {
        next.push([start, end])
        continue
      }

      if (clipStart > start) {
        next.push([start, clipStart])
      }
      if (clipEnd < end) {
        next.push([clipEnd, end])
      }
    }
    remaining = next
  }

  return remaining.filter(([start, end]) => end - start > 1e-9)
}

function rotatePoint(point: Point, cosTheta: number, sinTheta: number): Point {
  return {
    x: point.x * cosTheta - point.y * sinTheta,
    y: point.x * sinTheta + point.y * cosTheta,
  }
}

function distanceSquared(a: Point, b: Point): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return dx * dx + dy * dy
}

function contourNearestVertexIndex(points: Point[], anchor: Point): { index: number; distance: number } {
  let bestIndex = 0
  let bestDistance = Number.POSITIVE_INFINITY

  for (let index = 0; index < points.length; index += 1) {
    const distance = distanceSquared(anchor, points[index])
    if (distance < bestDistance) {
      bestIndex = index
      bestDistance = distance
    }
  }

  return { index: bestIndex, distance: bestDistance }
}

function contourNearestVertexDistance(points: Point[], anchor: Point): number {
  return contourNearestVertexIndex(points, anchor).distance
}

function rotateClosedContour(points: Point[], startIndex: number): Point[] {
  if (points.length <= 1 || startIndex <= 0 || startIndex >= points.length) {
    return points
  }

  return [...points.slice(startIndex), ...points.slice(0, startIndex)]
}

function contourEntryDistanceSquared(points: Point[], anchor: Point): number {
  if (points.length === 0) {
    return Number.POSITIVE_INFINITY
  }

  return contourNearestVertexDistance(points, anchor)
}

export function rotateContourToNearestEntry(points: Point[], anchor: Point | null): Point[] {
  if (points.length === 0 || anchor === null) {
    return points
  }

  const { index } = contourNearestVertexIndex(points, anchor)
  return rotateClosedContour(points, index)
}

function rotateContourToBestEntry(
  points: Point[],
  fromAnchor: Point | null,
  nextAnchors: Point[],
): Point[] {
  if (points.length === 0) {
    return points
  }

  let bestIndex = 0
  let bestScore = Number.POSITIVE_INFINITY

  for (let index = 0; index < points.length; index += 1) {
    const candidate = points[index]
    const fromDistance = fromAnchor ? distanceSquared(fromAnchor, candidate) : 0
    const nextDistance = nextAnchors.length > 0
      ? Math.min(...nextAnchors.map((anchor) => distanceSquared(anchor, candidate)))
      : 0
    const score = fromDistance + nextDistance

    if (score < bestScore) {
      bestIndex = index
      bestScore = score
    }
  }

  return rotateClosedContour(points, bestIndex)
}

function contourAnchorPoint(points: Point[]): Point | null {
  const first = points[0]
  return first ? { x: first.x, y: first.y } : null
}

function regionEntryDistanceSquared(region: ResolvedPocketRegion, anchor: Point): number {
  return contourEntryDistanceSquared(region.outer, anchor)
}

export function orderRegionsGreedy(regions: ResolvedPocketRegion[], start: Point | null): ResolvedPocketRegion[] {
  if (regions.length <= 1 || start === null) {
    return regions
  }

  const remaining = [...regions]
  const ordered: ResolvedPocketRegion[] = []
  let current = start

  while (remaining.length > 0) {
    let bestIndex = 0
    let bestDistance = Number.POSITIVE_INFINITY

    for (let index = 0; index < remaining.length; index += 1) {
      const distance = regionEntryDistanceSquared(remaining[index], current)
      if (distance < bestDistance) {
        bestIndex = index
        bestDistance = distance
      }
    }

    const [nextRegion] = remaining.splice(bestIndex, 1)
    ordered.push(nextRegion)
    current = contourAnchorPoint(nextRegion.outer) ?? current
  }

  return ordered
}

export function orderClosedContoursGreedy(contours: Point[][], start: Point | null): Point[][] {
  if (contours.length <= 1 || start === null) {
    return contours
  }

  const remaining = contours
    .filter((contour) => contour.length >= 3)
    .map((contour) => [...contour])
  const ordered: Point[][] = []
  let current = start

  while (remaining.length > 0) {
    let bestIndex = 0
    let bestDistance = Number.POSITIVE_INFINITY

    for (let index = 0; index < remaining.length; index += 1) {
      const distance = contourEntryDistanceSquared(remaining[index], current)
      if (distance < bestDistance) {
        bestIndex = index
        bestDistance = distance
      }
    }

    const [nextContour] = remaining.splice(bestIndex, 1)
    const rotated = rotateContourToNearestEntry(nextContour, current)
    ordered.push(rotated)
    current = contourAnchorPoint(rotated) ?? current
  }

  return ordered
}

function orderClosedContoursGreedyPreservingRotation(contours: Point[][], start: Point | null): Point[][] {
  if (contours.length <= 1 || start === null) {
    return contours
  }

  const remaining = contours
    .filter((contour) => contour.length >= 3)
    .map((contour) => [...contour])
  const ordered: Point[][] = []
  let current = start

  while (remaining.length > 0) {
    let bestIndex = 0
    let bestDistance = Number.POSITIVE_INFINITY

    for (let index = 0; index < remaining.length; index += 1) {
      const distance = contourEntryDistanceSquared(remaining[index], current)
      if (distance < bestDistance) {
        bestIndex = index
        bestDistance = distance
      }
    }

    const [nextContour] = remaining.splice(bestIndex, 1)
    ordered.push(nextContour)
    current = contourAnchorPoint(nextContour) ?? current
  }

  return ordered
}

export interface TaggedOpenSegment {
  points: Point[]
  /** Index of the source region within the regions array the segments were built from. */
  regionIndex: number
}

function orderTaggedOpenSegmentsGreedy(segments: TaggedOpenSegment[], start: Point | null): TaggedOpenSegment[] {
  if (segments.length <= 1 || start === null) {
    return segments
  }

  const remaining = segments
    .filter((segment) => segment.points.length >= 2)
    .map((segment) => ({ ...segment, points: [...segment.points] }))
  const ordered: TaggedOpenSegment[] = []
  let current = start

  while (remaining.length > 0) {
    let bestIndex = 0
    let bestReverse = false
    let bestDistance = Number.POSITIVE_INFINITY

    for (let index = 0; index < remaining.length; index += 1) {
      const segment = remaining[index].points
      const first = segment[0]
      const last = segment[segment.length - 1]
      const forwardDistance = distanceSquared(current, first)
      if (forwardDistance < bestDistance) {
        bestIndex = index
        bestReverse = false
        bestDistance = forwardDistance
      }

      const reverseDistance = distanceSquared(current, last)
      if (reverseDistance < bestDistance) {
        bestIndex = index
        bestReverse = true
        bestDistance = reverseDistance
      }
    }

    const [nextSegment] = remaining.splice(bestIndex, 1)
    const orderedSegment = bestReverse
      ? { ...nextSegment, points: [...nextSegment.points].reverse() }
      : nextSegment
    ordered.push(orderedSegment)
    current = orderedSegment.points[orderedSegment.points.length - 1]
  }

  return ordered
}

export function orderOpenSegmentsGreedy(segments: Point[][], start: Point | null): Point[][] {
  if (segments.length <= 1 || start === null) {
    return segments
  }

  return orderTaggedOpenSegmentsGreedy(
    segments.map((points) => ({ points, regionIndex: 0 })),
    start,
  ).map((segment) => segment.points)
}

export function buildPocketParallelSegmentsTagged(
  regions: ResolvedPocketRegion[],
  stepoverDistance: number,
  angleDeg: number,
): TaggedOpenSegment[] {
  const segments: TaggedOpenSegment[] = []
  const minStepover = 1 / DEFAULT_CLIPPER_SCALE
  const step = Math.max(stepoverDistance, minStepover)
  const angleRad = (angleDeg * Math.PI) / 180
  const cosForward = Math.cos(angleRad)
  const sinForward = Math.sin(angleRad)
  const cosInverse = Math.cos(-angleRad)
  const sinInverse = Math.sin(-angleRad)

  regions.forEach((region, regionIndex) => {
    const rotatedOuter = region.outer.map((point) => rotatePoint(point, cosInverse, sinInverse))
    const rotatedIslands = region.islands.map((island) => island.map((point) => rotatePoint(point, cosInverse, sinInverse)))
    const bounds = polygonYBounds(rotatedOuter)
    if (!bounds) {
      return
    }

    let scanIndex = 0
    for (let y = bounds.minY + step / 2; y < bounds.maxY - step / 2 + 1e-9; y += step) {
      const outerIntervals = scanlineIntervals(rotatedOuter, y)
      if (outerIntervals.length === 0) {
        scanIndex += 1
        continue
      }

      const islandIntervals = rotatedIslands.flatMap((island) => scanlineIntervals(island, y))
      const fillIntervals = subtractIntervals(outerIntervals, islandIntervals)

      for (const [startX, endX] of fillIntervals) {
        const left = rotatePoint({ x: startX, y }, cosForward, sinForward)
        const right = rotatePoint({ x: endX, y }, cosForward, sinForward)
        const reverse = (regionIndex + scanIndex) % 2 === 1
        segments.push({ points: reverse ? [right, left] : [left, right], regionIndex })
      }

      scanIndex += 1
    }
  })

  return segments
}

export function buildPocketParallelSegments(
  regions: ResolvedPocketRegion[],
  stepoverDistance: number,
  angleDeg: number,
): Point[][] {
  return buildPocketParallelSegmentsTagged(regions, stepoverDistance, angleDeg)
    .map((segment) => segment.points)
}

export function cutClosedContours(
  moves: ToolpathMove[],
  contours: Point[][],
  z: number,
  safeZ: number,
  maxLinkDistance: number,
  currentPosition: ToolpathPoint | null,
  preserveContourRotation = false,
  direction: CutDirection = 'conventional',
  safeLinkCheck?: SafeLinkCheck,
): ToolpathPoint | null {
  const directedContours = applyContourDirection(contours, direction)
  const start = currentPosition ? { x: currentPosition.x, y: currentPosition.y } : null
  const orderedContours = preserveContourRotation
    ? orderClosedContoursGreedyPreservingRotation(directedContours, start)
    : orderClosedContoursGreedy(directedContours, start)

  let nextPosition = currentPosition
  for (const contour of orderedContours) {
    const entryPoint = contourStartPoint(contour, z)
    nextPosition = transitionToCutEntry(moves, nextPosition, entryPoint, safeZ, maxLinkDistance, safeLinkCheck)
    const cutMoves = toClosedCutMoves(contour, z)
    moves.push(...cutMoves)
    nextPosition = cutMoves.at(-1)?.to ?? nextPosition
  }

  return nextPosition
}

interface OffsetRegionNode {
  region: ResolvedPocketRegion
  children: OffsetRegionNode[]
  /** Cleared-adjacency mask for slot-feed classification; null when slot feed is off. */
  engagementMask: EngagementMask | null
}

/**
 * Precompute the offset ring tree for a region. The tree (successive insets
 * and, when slot feed is active, the per-node engagement masks) depends only
 * on the region geometry and stepover — not on Z — so callers cutting several
 * step levels build it once and traverse it per level instead of redoing the
 * Clipper offsets at every level.
 */
function buildOffsetRegionTree(
  region: ResolvedPocketRegion,
  stepoverDistance: number,
  slotFeed?: SlotFeedOptions,
): OffsetRegionNode {
  const childRegions = buildInsetRegions(region, stepoverDistance)
  return {
    region,
    children: childRegions.map((child) => buildOffsetRegionTree(child, stepoverDistance, slotFeed)),
    // In inner-first traversal the children are cut before this region's own
    // loops, so material within one stepover of a child region is already
    // cleared. Everything else this node's loops touch is virgin: the whole
    // loop for leaf regions (no children), and pinch corridors of parent
    // rings where the inset split into disjoint children.
    engagementMask: slotFeed
      ? buildEngagementMask(childRegions.flatMap((child) => buildInsetRegions(child, -slotFeed.adjacency)))
      : null,
  }
}

function orderNodesGreedy(nodes: OffsetRegionNode[], start: Point | null): OffsetRegionNode[] {
  if (nodes.length <= 1 || start === null) {
    return nodes
  }
  const byRegion = new Map(nodes.map((node) => [node.region, node]))
  return orderRegionsGreedy(nodes.map((node) => node.region), start)
    .map((region) => byRegion.get(region) as OffsetRegionNode)
}

function cutOffsetRegionNode(
  moves: ToolpathMove[],
  node: OffsetRegionNode,
  z: number,
  safeZ: number,
  maxLinkDistance: number,
  currentPosition: ToolpathPoint | null,
  direction: CutDirection,
  safeLinkCheck: SafeLinkCheck | undefined,
  traversalMode: OffsetTraversalMode,
  slotScale: number | null,
): ToolpathPoint | null {
  const cutCurrentRegion = (fromPosition: ToolpathPoint | null): ToolpathPoint | null => {
    const childAnchors = traversalMode === 'outer-first'
      ? node.children
        .map((child) => child.region.outer)
        .filter((contour) => contour.length > 0)
        .map((contour) => contour[0])
      : []
    const preparedContours = buildContourLoops([node.region]).map((contour) => rotateContourToBestEntry(
      contour,
      fromPosition ? { x: fromPosition.x, y: fromPosition.y } : null,
      childAnchors,
    ))

    const startIndex = moves.length
    const endPosition = cutClosedContours(
      moves,
      preparedContours,
      z,
      safeZ,
      maxLinkDistance,
      fromPosition,
      true,
      direction,
      safeLinkCheck,
    )

    if (slotScale !== null && traversalMode === 'inner-first') {
      applySlotFeedScale(moves, startIndex, slotScale, node.engagementMask)
    }

    return endPosition
  }

  let nextPosition = currentPosition
  if (traversalMode === 'outer-first') {
    nextPosition = cutCurrentRegion(nextPosition)
  }

  const orderedChildren = orderNodesGreedy(
    node.children,
    nextPosition ? { x: nextPosition.x, y: nextPosition.y } : null,
  )

  for (const childNode of orderedChildren) {
    nextPosition = cutOffsetRegionNode(
      moves,
      childNode,
      z,
      safeZ,
      maxLinkDistance,
      nextPosition,
      direction,
      safeLinkCheck,
      traversalMode,
      slotScale,
    )
  }

  if (traversalMode === 'inner-first') {
    nextPosition = cutCurrentRegion(nextPosition)
  }

  return nextPosition
}

export function cutOffsetRegionRecursive(
  moves: ToolpathMove[],
  region: ResolvedPocketRegion,
  z: number,
  safeZ: number,
  stepoverDistance: number,
  maxLinkDistance: number,
  currentPosition: ToolpathPoint | null,
  direction: CutDirection = 'conventional',
  safeLinkCheck?: SafeLinkCheck,
  traversalMode: OffsetTraversalMode = 'outer-first',
  slotFeed?: SlotFeedOptions,
): ToolpathPoint | null {
  return cutOffsetRegionNode(
    moves,
    buildOffsetRegionTree(region, stepoverDistance, slotFeed),
    z,
    safeZ,
    maxLinkDistance,
    currentPosition,
    direction,
    safeLinkCheck,
    traversalMode,
    slotFeed ? slotFeed.scale : null,
  )
}

export function toOpenCutMoves(points: Point[], z: number): ToolpathMove[] {
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

  return moves
}

function generateRoughBandMoves(
  band: ResolvedPocketBand,
  operation: Operation,
  safeZ: number,
  stepdown: number,
  toolRadius: number,
  stepoverDistance: number,
  maxLinkDistance: number,
  direction: CutDirection = 'conventional',
): { moves: ToolpathMove[]; stepLevels: number[]; warnings: string[] } {
  const moves: ToolpathMove[] = []
  const warnings: string[] = []
  const effectiveBottom = resolveBandBottomZ(band, operation)
  if (effectiveBottom === null) {
    return {
      moves,
      stepLevels: [],
      warnings: [`Band ${band.topZ} -> ${band.bottomZ} leaves no roughing depth after axial stock-to-leave`],
    }
  }

  const radialLeave = Math.max(0, operation.stockToLeaveRadial)
  const initialInset = toolRadius + radialLeave
  const stepLevels = generateStepLevels(band.topZ, effectiveBottom, stepdown)
  const minStepover = 1 / DEFAULT_CLIPPER_SCALE
  const effectiveStepover = Math.max(stepoverDistance, minStepover)
  const slotScale = resolveSlotFeedScale(operation)
  let currentPosition: ToolpathPoint | null = null

  if (operation.kind === 'pocket' && operation.pocketPattern === 'parallel') {
    const roughRegions = band.regions.flatMap((region) => buildInsetRegions(region, initialInset))
    if (roughRegions.length === 0) {
      return {
        moves,
        stepLevels,
        warnings: [`No machinable parallel floor region for band ${band.topZ} -> ${band.bottomZ}`],
      }
    }

    const boundaryContours = applyContourDirection(buildContourLoops(roughRegions), direction)
    const segments = buildPocketParallelSegmentsTagged(roughRegions, effectiveStepover, operation.pocketAngle)
    if (segments.length === 0) {
      return {
        moves,
        stepLevels,
        warnings: [`No machinable parallel floor segments for band ${band.topZ} -> ${band.bottomZ}`],
      }
    }

    for (const z of stepLevels) {
      // The boundary pass is cut before anything is cleared at this level, so
      // every boundary loop is a full-slot cut.
      const boundaryStartIndex = moves.length
      for (const contour of boundaryContours) {
        const entryPoint = contourStartPoint(contour, z)
        currentPosition = transitionToCutEntry(moves, currentPosition, entryPoint, safeZ, maxLinkDistance)
        const cutMoves = toClosedCutMoves(contour, z)
        moves.push(...cutMoves)
        currentPosition = cutMoves.at(-1)?.to ?? currentPosition
      }
      if (slotScale !== null) {
        applySlotFeedScale(moves, boundaryStartIndex, slotScale, null)
      }

      const orderedSegments = orderTaggedOpenSegmentsGreedy(
        segments,
        currentPosition ? { x: currentPosition.x, y: currentPosition.y } : null,
      )

      // The first fill line cut in each region is a full-slot cut; later
      // lines overlap the previously cleared band by the stepover.
      const slottedRegions = new Set<number>()
      for (const { points: segment, regionIndex } of orderedSegments) {
        const segmentStartIndex = moves.length
        const entryPoint = contourStartPoint(segment, z)
        currentPosition = transitionToCutEntry(moves, currentPosition, entryPoint, safeZ, maxLinkDistance)
        const cutMoves = toOpenCutMoves(segment, z)
        moves.push(...cutMoves)
        currentPosition = cutMoves.at(-1)?.to ?? currentPosition
        if (slotScale !== null && !slottedRegions.has(regionIndex)) {
          slottedRegions.add(regionIndex)
          applySlotFeedScale(moves, segmentStartIndex, slotScale, null)
        }
      }

      currentPosition = retractToSafe(moves, currentPosition, safeZ)
    }

    return { moves, stepLevels, warnings }
  }

  const slotFeed = slotScale !== null
    ? { scale: slotScale, adjacency: effectiveStepover * SLOT_FEED_ADJACENCY_FACTOR }
    : undefined

  // The offset ring tree is identical at every step level — build it (and
  // the slot-feed engagement masks) once and traverse it per level.
  const regionTrees = band.regions
    .flatMap((region) => buildInsetRegions(region, initialInset))
    .map((region) => buildOffsetRegionTree(region, effectiveStepover, slotFeed))

  for (const z of stepLevels) {
    if (regionTrees.length === 0) {
      warnings.push(`No machinable offset contours for band ${band.topZ} -> ${band.bottomZ}`)
      currentPosition = retractToSafe(moves, currentPosition, safeZ)
      continue
    }

    const orderedTrees = orderNodesGreedy(
      regionTrees,
      currentPosition ? { x: currentPosition.x, y: currentPosition.y } : null,
    )

    for (const tree of orderedTrees) {
      currentPosition = cutOffsetRegionNode(
        moves,
        tree,
        z,
        safeZ,
        maxLinkDistance,
        currentPosition,
        direction,
        undefined,
        'inner-first',
        slotScale,
      )
    }

    currentPosition = retractToSafe(moves, currentPosition, safeZ)
  }

  return { moves, stepLevels, warnings }
}

function generateFinishBandMoves(
  band: ResolvedPocketBand,
  operation: Operation,
  safeZ: number,
  _stepdown: number,
  toolRadius: number,
  stepoverDistance: number,
  maxLinkDistance: number,
  direction: CutDirection = 'conventional',
): { moves: ToolpathMove[]; stepLevels: number[]; warnings: string[] } {
  const moves: ToolpathMove[] = []
  const warnings: string[] = []
  const effectiveBottom = resolveBandBottomZ(band, operation)
  if (effectiveBottom === null) {
    return {
      moves,
      stepLevels: [],
      warnings: [`Band ${band.topZ} -> ${band.bottomZ} leaves no finish depth after axial stock-to-leave`],
    }
  }

  if (!operation.finishWalls && !operation.finishFloor) {
    return {
      moves,
      stepLevels: [],
      warnings: ['Finish operation has both Finish Walls and Finish Floor disabled'],
    }
  }

  const radialLeave = Math.max(0, operation.stockToLeaveRadial)
  const finishDelta = toolRadius + radialLeave
  const finishRegions = band.regions.flatMap((region) => buildInsetRegions(region, finishDelta))
  const slotScale = resolveSlotFeedScale(operation)
  const isParallelPocket = operation.kind === 'pocket' && operation.pocketPattern === 'parallel'
  const wallContours = operation.finishWalls ? buildContourLoops(finishRegions) : []
  // Per-region floor groups are built only when the slot feed is active; the
  // disabled path keeps today's single global greedy ordering untouched.
  const floorContourGroups = slotScale !== null && operation.finishFloor && !isParallelPocket
    ? finishRegions
      .map((region) => buildPocketFloorContours([region], 0, stepoverDistance))
      .filter((group) => group.length > 0)
    : null
  const floorContours = floorContourGroups !== null
    ? floorContourGroups.flat()
    : operation.finishFloor && !isParallelPocket
      ? buildPocketFloorContours(finishRegions, 0, stepoverDistance)
      : []
  const floorSegments = operation.finishFloor && isParallelPocket
    ? buildPocketParallelSegmentsTagged(finishRegions, stepoverDistance, operation.pocketAngle)
    : []
  if (wallContours.length === 0 && floorContours.length === 0 && floorSegments.length === 0) {
    return {
      moves,
      stepLevels: [],
      warnings: [`No finish contours available for band ${band.topZ} -> ${band.bottomZ}`],
    }
  }

  const wallStepLevels = operation.finishWalls ? [effectiveBottom] : []
  const floorStepLevels = operation.finishFloor ? [effectiveBottom] : []
  let currentPosition: ToolpathPoint | null = null

  // Floor before walls: when roughing left axial stock, a wall pass at final
  // depth would slot through the uncleared floor skin at full feed. Cutting
  // the floor first removes that skin (with its first pass at the reduced
  // slot feed), so the wall pass only shaves the radial stock — and cutting
  // walls last leaves the cleanest final wall surface.
  for (const z of floorStepLevels) {
    if (floorContourGroups !== null && slotScale !== null) {
      // Visit floor regions nearest-first; the first floor loop cut in each
      // region crosses the full remaining skin width (fully engaged), later
      // loops overlap the cleared band by the stepover.
      const remainingGroups = [...floorContourGroups]
      while (remainingGroups.length > 0) {
        const anchor = currentPosition ? { x: currentPosition.x, y: currentPosition.y } : null
        let bestIndex = 0
        if (anchor !== null) {
          let bestDistance = Number.POSITIVE_INFINITY
          for (let index = 0; index < remainingGroups.length; index += 1) {
            const distance = Math.min(
              ...remainingGroups[index].map((contour) => contourEntryDistanceSquared(contour, anchor)),
            )
            if (distance < bestDistance) {
              bestIndex = index
              bestDistance = distance
            }
          }
        }
        const [group] = remainingGroups.splice(bestIndex, 1)
        const orderedGroup = orderClosedContoursGreedy(group, anchor)
        if (orderedGroup.length === 0) {
          continue
        }
        const startIndex = moves.length
        currentPosition = cutClosedContours(moves, [orderedGroup[0]], z, safeZ, maxLinkDistance, currentPosition, false, direction)
        applySlotFeedScale(moves, startIndex, slotScale, null)
        if (orderedGroup.length > 1) {
          currentPosition = cutClosedContours(moves, orderedGroup.slice(1), z, safeZ, maxLinkDistance, currentPosition, false, direction)
        }
      }
    } else {
      currentPosition = cutClosedContours(moves, floorContours, z, safeZ, maxLinkDistance, currentPosition, false, direction)
    }

    const orderedFloorSegments = orderTaggedOpenSegmentsGreedy(
      floorSegments,
      currentPosition ? { x: currentPosition.x, y: currentPosition.y } : null,
    )

    // The first floor fill line cut in each region crosses the full skin
    // width; later lines overlap the cleared band by the stepover.
    const slottedRegions = new Set<number>()
    for (const { points: segment, regionIndex } of orderedFloorSegments) {
      const segmentStartIndex = moves.length
      const entryPoint = contourStartPoint(segment, z)
      currentPosition = transitionToCutEntry(moves, currentPosition, entryPoint, safeZ, maxLinkDistance)
      const cutMoves = toOpenCutMoves(segment, z)
      moves.push(...cutMoves)
      currentPosition = cutMoves.at(-1)?.to ?? currentPosition
      if (slotScale !== null && !slottedRegions.has(regionIndex)) {
        slottedRegions.add(regionIndex)
        applySlotFeedScale(moves, segmentStartIndex, slotScale, null)
      }
    }

    currentPosition = retractToSafe(moves, currentPosition, safeZ)
  }

  for (const z of wallStepLevels) {
    currentPosition = cutClosedContours(moves, wallContours, z, safeZ, maxLinkDistance, currentPosition, false, direction)

    currentPosition = retractToSafe(moves, currentPosition, safeZ)
  }

  return {
    moves,
    stepLevels: [...new Set([...wallStepLevels, ...floorStepLevels])].sort((a, b) => b - a),
    warnings,
  }
}

export function generatePocketToolpath(project: Project, operation: Operation): PocketToolpathResult {
  if (isFeatureFirst(operation)) {
    const parts = perFeatureOperations(operation, project).map((subOp) =>
      generatePocketToolpathSingle(project, subOp),
    )
    return mergePocketToolpathResults(operation.id, parts, { orderBlocks: 'nearest' })
  }
  return generatePocketToolpathSingle(project, operation)
}

function generatePocketToolpathSingle(project: Project, operation: Operation): PocketToolpathResult {
  const resolved = resolvePocketRegions(project, operation)
  const regionMask = operation.target.source === 'features'
    ? buildRegionMask(splitFeatureTargets(project, operation.target.featureIds).regionFeatures)
    : null
  const toolRecord = operation.toolRef
    ? project.tools.find((tool) => tool.id === operation.toolRef) ?? null
    : null

  if (!toolRecord) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...resolved.warnings, 'No tool assigned to this operation'],
      bounds: null,
      stepLevels: [],
    }
  }

  const tool = normalizeToolForProject(toolRecord, project)
  if (!(tool.diameter > 0)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...resolved.warnings, 'Tool diameter must be greater than zero'],
      bounds: null,
      stepLevels: [],
    }
  }

  if (!(operation.stepdown > 0)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...resolved.warnings, 'Operation stepdown must be greater than zero'],
      bounds: null,
      stepLevels: [],
    }
  }

  if (!(operation.stepover > 0 && operation.stepover <= 1)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...resolved.warnings, 'Operation stepover ratio must be between 0 and 1'],
      bounds: null,
      stepLevels: [],
    }
  }

  const safeZ = getOperationSafeZ(project)
  const stepoverDistance = tool.diameter * operation.stepover
  const maxLinkDistance = tool.diameter
  const direction = operation.cutDirection ?? 'conventional'
  const allMoves: ToolpathMove[] = []
  const warnings = [...resolved.warnings]
  const maxBandDepth = resolved.bands.reduce((max, band) => Math.max(max, Math.abs(band.topZ - band.bottomZ)), 0)
  const depthWarning = checkMaxCutDepthWarning(tool, maxBandDepth)
  if (depthWarning) {
    warnings.push(depthWarning)
  }
  const allStepLevels = new Set<number>()

  const formatZ = (value: number) => Number(value.toFixed(6)).toString()
  const formatFeatureSpan = (featureId: string) => {
    const feature = project.features.find((entry) => entry.id === featureId)
    if (!feature) {
      return `${featureId} [missing]`
    }

    const span = resolveFeatureZSpan(project, feature)
    return `${feature.name} (${feature.id}) [${formatZ(span.max)} -> ${formatZ(span.min)}]`
  }

  const formatIslandSpan = (id: string) => {
    const feature = project.features.find((entry) => entry.id === id)
    if (feature) {
      const span = resolveFeatureZSpan(project, feature)
      return `${feature.name} (${feature.id}) [${formatZ(span.max)} -> ${formatZ(span.min)}]`
    }

    const tab = project.tabs.find((entry) => entry.id === id)
    if (tab) {
      return `${tab.name} (${tab.id}) [${formatZ(Math.max(tab.z_top, tab.z_bottom))} -> ${formatZ(Math.min(tab.z_top, tab.z_bottom))}]`
    }

    return `${id} [missing]`
  }

  if (operation.debugToolpath) {
    const resolvedBandSummary = resolved.bands
      .map((band) => `${formatZ(band.topZ)} -> ${formatZ(band.bottomZ)}`)
      .join(', ')

    if (resolved.bands.length > 0) {
      warnings.push(`Debug: resolved pocket bands = ${resolvedBandSummary}`)
    }
  }

  for (const band of resolved.bands) {
    const result = operation.pass === 'finish'
      ? generateFinishBandMoves(
        band,
        operation,
        safeZ,
        operation.stepdown,
        tool.radius,
        stepoverDistance,
        maxLinkDistance,
        direction,
      )
      : generateRoughBandMoves(
        band,
        operation,
        safeZ,
        operation.stepdown,
        tool.radius,
        stepoverDistance,
        maxLinkDistance,
        direction,
      )
    const { moves, stepLevels, warnings: bandWarnings } = result
    moves.forEach((move) => allMoves.push(move))
    stepLevels.forEach((level) => allStepLevels.add(level))
    warnings.push(...bandWarnings)
    if (operation.debugToolpath) {
      warnings.push(
        `Debug: band ${formatZ(band.topZ)} -> ${formatZ(band.bottomZ)} cut levels = ${
          stepLevels.length > 0 ? stepLevels.map((level) => formatZ(level)).join(', ') : 'none'
        }`,
      )
      warnings.push(
        `Debug: band ${formatZ(band.topZ)} -> ${formatZ(band.bottomZ)} targets = ${
          band.targetFeatureIds.length > 0 ? band.targetFeatureIds.map((id) => formatFeatureSpan(id)).join('; ') : 'none'
        }`,
      )
      warnings.push(
        `Debug: band ${formatZ(band.topZ)} -> ${formatZ(band.bottomZ)} islands = ${
          band.islandFeatureIds.length > 0 ? band.islandFeatureIds.map((id) => formatIslandSpan(id)).join('; ') : 'none'
        }`,
      )
    }
  }

  let bounds: ToolpathBounds | null = null
  for (const move of allMoves) {
    bounds = updateBounds(bounds, move.from)
    bounds = updateBounds(bounds, move.to)
  }

  const result: PocketToolpathResult = {
    operationId: operation.id,
    moves: allMoves,
    warnings,
    bounds,
    stepLevels: [...allStepLevels].sort((a, b) => b - a),
  }
  return clipToolpathResultToRegionMask(project, result, regionMask) as PocketToolpathResult
}
