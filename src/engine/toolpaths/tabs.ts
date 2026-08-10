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
import type { Operation, Point, Project, Tab, TabShape } from '../../types/project'
import { isTrochoidalEdgeRoughing, rectProfile, sampleProfilePoints, tabShape } from '../../types/project'
import type { ClipperPath, ToolpathBounds, ToolpathMove, ToolpathPoint, ToolpathResult } from './types'
import {
  DEFAULT_CLIPPER_SCALE,
  fromClipperPath,
  normalizeToolForProject,
  normalizeWinding,
  offsetKeepOutPaths,
  toClipperPath,
} from './geometry'
import { unionClipperPaths } from './modelProtection'
import { planSmoothTabMotion, splitCutMoveWithSmoothTabs } from './tabSmoothing'
import { convertLength } from '../../utils/units'

interface PreservedObstacle {
  id: string
  name: string
  points: Point[]
  zTop: number
  zBottom: number
  shape: TabShape
}

/**
 * How far a smooth ramp's straight-line approximation may deviate from the true
 * curve, in millimetres, converted to project units at the call site.
 *
 * 0.01 mm sits an order of magnitude below any hobby CNC's positioning
 * resolution and well inside the arc tolerances the controller conformance
 * harness measures (GRBL/FluidNC 0.005 mm, LinuxCNC ~0.028 mm), so the sampled
 * ramp is indistinguishable from the ideal curve on the machine while keeping
 * the emitted move count modest — roughly 28 segments for a 3 mm tab.
 */
const SMOOTH_TAB_CHORD_TOLERANCE_MM = 0.01

// Round join, not miter: the raised zone is the set of tool-centre positions whose
// swept disc would touch the tab, i.e. the Minkowski sum of the tab rect with a
// circle of the tool radius. A miter join grows the rect by a *square* instead,
// overshooting each corner by up to (sqrt(2)-1)*radius and raising the toolpath
// where the cutter would never have reached the tab.
const TAB_FOOTPRINT_JOIN_TYPE = ClipperLib.JoinType.jtRound

function offsetObstaclePoints(points: Point[], delta: number): Point[] {
  if (!(delta > 1e-9) || points.length < 3) {
    return points
  }

  const expanded = offsetKeepOutPaths(
    [toClipperPath(normalizeWinding(points, false), DEFAULT_CLIPPER_SCALE)],
    delta * DEFAULT_CLIPPER_SCALE,
    TAB_FOOTPRINT_JOIN_TYPE,
  )[0]
  return expanded ? fromClipperPath(expanded, DEFAULT_CLIPPER_SCALE) : points
}

/**
 * Tab footprints grown by `clearance` and unioned, in Clipper units.
 *
 * This is the one definition of "how much space a tab occupies once a cutter of
 * some size has to stay clear of it". Callers supply the clearance because they
 * are answering different questions — `applyTabsToEdgeRoute` uses tool radius +
 * radial stock-to-leave (how much material the finish pass still needs), while
 * trochoidal guide fragmentation uses orbit-derived clearances (how far the
 * guide must sit so the whole orbit misses the tab). What they must NOT differ
 * on is the footprint shape or the offset tolerance, which is why both come
 * through here rather than each re-deriving the rectangle.
 */
export function expandedTabFootprints(tabs: Tab[], clearance: number): ClipperPath[] {
  if (tabs.length === 0) {
    return []
  }
  const footprints = tabs.map((tab) => toClipperPath(
    normalizeWinding(sampleProfilePoints(rectProfile(tab.x, tab.y, tab.w, tab.h)), false),
    DEFAULT_CLIPPER_SCALE,
  ))
  const grown = clearance > 1e-9
    ? offsetKeepOutPaths(footprints, clearance * DEFAULT_CLIPPER_SCALE, TAB_FOOTPRINT_JOIN_TYPE)
    : footprints
  return unionClipperPaths(grown)
}

function expandObstacles(obstacles: PreservedObstacle[], delta: number): PreservedObstacle[] {
  if (!(delta > 1e-9)) {
    return obstacles
  }

  return obstacles.map((obstacle) => ({
    ...obstacle,
    points: offsetObstaclePoints(obstacle.points, delta),
  }))
}

function buildTabObstacles(project: Project): PreservedObstacle[] {
  return project.tabs.map((tab) => ({
    id: tab.id,
    name: tab.name,
    // The footprint stays rectangular whatever the shape. Smooth tabs change how
    // Z moves across the footprint, never which XY the footprint occupies — so
    // hit-testing, cutter-envelope expansion, layout coverage, overlap warnings,
    // and auto-placement all keep working off one rectangle.
    points: sampleProfilePoints(rectProfile(tab.x, tab.y, tab.w, tab.h)),
    zTop: tab.z_top,
    zBottom: tab.z_bottom,
    shape: tabShape(tab),
  }))
}

function pointInPolygon(x: number, y: number, polygon: Point[]): boolean {
  if (polygon.length < 3) return false

  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i].x
    const yi = polygon[i].y
    const xj = polygon[j].x
    const yj = polygon[j].y
    const intersects = ((yi > y) !== (yj > y))
      && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-12) + xi)
    if (intersects) {
      inside = !inside
    }
  }

  return inside
}

function segmentIntersectionT(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  a0: Point,
  a1: Point,
): number | null {
  const rX = x1 - x0
  const rY = y1 - y0
  const sX = a1.x - a0.x
  const sY = a1.y - a0.y
  const denominator = rX * sY - rY * sX

  if (Math.abs(denominator) < 1e-9) {
    return null
  }

  const qpx = a0.x - x0
  const qpy = a0.y - y0
  const t = (qpx * sY - qpy * sX) / denominator
  const u = (qpx * rY - qpy * rX) / denominator

  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) {
    return null
  }

  return Math.max(0, Math.min(1, t))
}

function clipSegmentPolygon2D(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  polygon: Point[],
): [number, number] | null {
  if (polygon.length < 3) {
    return null
  }

  const ts = new Set<number>([0, 1])
  for (let index = 0; index < polygon.length; index += 1) {
    const a0 = polygon[index]
    const a1 = polygon[(index + 1) % polygon.length]
    const t = segmentIntersectionT(x0, y0, x1, y1, a0, a1)
    if (t !== null) {
      ts.add(Number(t.toFixed(9)))
    }
  }

  const values = Array.from(ts).sort((left, right) => left - right)
  let minInside: number | null = null
  let maxInside: number | null = null

  for (let index = 0; index < values.length - 1; index += 1) {
    const start = values[index]
    const end = values[index + 1]
    if (end - start <= 1e-9) {
      continue
    }

    const mid = (start + end) / 2
    const midX = x0 + (x1 - x0) * mid
    const midY = y0 + (y1 - y0) * mid
    if (!pointInPolygon(midX, midY, polygon)) {
      continue
    }

    minInside = minInside === null ? start : Math.min(minInside, start)
    maxInside = maxInside === null ? end : Math.max(maxInside, end)
  }

  return minInside !== null && maxInside !== null ? [minInside, maxInside] : null
}

function rangesOverlap(minA: number, maxA: number, minB: number, maxB: number): boolean {
  return Math.max(minA, minB) < Math.min(maxA, maxB) - 1e-9
}

function obstacleBounds(obstacle: PreservedObstacle) {
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  for (const point of obstacle.points) {
    minX = Math.min(minX, point.x)
    maxX = Math.max(maxX, point.x)
    minY = Math.min(minY, point.y)
    maxY = Math.max(maxY, point.y)
  }

  return { minX, maxX, minY, maxY }
}

function rectsOverlap(a: PreservedObstacle, b: PreservedObstacle): boolean {
  const boundsA = obstacleBounds(a)
  const boundsB = obstacleBounds(b)
  return rangesOverlap(boundsA.minX, boundsA.maxX, boundsB.minX, boundsB.maxX)
    && rangesOverlap(boundsA.minY, boundsA.maxY, boundsB.minY, boundsB.maxY)
    && rangesOverlap(a.zBottom, a.zTop, b.zBottom, b.zTop)
}

function obstacleOverlapsToolpathBounds(obstacle: PreservedObstacle, bounds: ToolpathBounds | null): boolean {
  if (!bounds) {
    return false
  }

  const obstacleRect = obstacleBounds(obstacle)
  return rangesOverlap(obstacleRect.minX, obstacleRect.maxX, bounds.minX, bounds.maxX)
    && rangesOverlap(obstacleRect.minY, obstacleRect.maxY, bounds.minY, bounds.maxY)
}

function isSupportedTabOperation(kind: Operation['kind']): boolean {
  return kind === 'edge_route_inside'
    || kind === 'edge_route_outside'
    || kind === 'pocket'
    || kind === 'finish_surface'
    || kind === 'finish_surface_cleanup'
}

function pointAt(move: ToolpathMove, t: number, z: number): ToolpathPoint {
  return {
    x: move.from.x + (move.to.x - move.from.x) * t,
    y: move.from.y + (move.to.y - move.from.y) * t,
    z,
  }
}

function pointsEqualXY(a: ToolpathPoint, b: ToolpathPoint): boolean {
  return Math.abs(a.x - b.x) <= 1e-9 && Math.abs(a.y - b.y) <= 1e-9
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

function splitCutMoveAcrossTabsFrom(
  move: ToolpathMove,
  obstacles: PreservedObstacle[],
  actualFrom: ToolpathPoint,
): ToolpathMove[] {
  if (move.kind !== 'cut' || Math.abs(move.from.z - move.to.z) > 1e-9) {
    return [move]
  }

  const baseZ = move.from.z
  const activeObstacles = obstacles
    .map((obstacle) => {
      if (!(baseZ < obstacle.zTop && baseZ >= obstacle.zBottom)) {
        return null
      }
      const interval = clipSegmentPolygon2D(move.from.x, move.from.y, move.to.x, move.to.y, obstacle.points)
      return interval ? { obstacle, interval } : null
    })
    .filter((entry): entry is { obstacle: PreservedObstacle; interval: [number, number] } => entry !== null)

  if (activeObstacles.length === 0) {
    return [{ ...move, from: { ...actualFrom } }]
  }

  const breakpoints = Array.from(new Set(
    [0, 1, ...activeObstacles.flatMap((entry) => [entry.interval[0], entry.interval[1]])]
      .map((value) => Math.max(0, Math.min(1, Number(value.toFixed(9))))),
  )).sort((left, right) => left - right)

  const result: ToolpathMove[] = []
  let current = { ...actualFrom }

  for (let index = 0; index < breakpoints.length - 1; index += 1) {
    const startT = breakpoints[index]
    const endT = breakpoints[index + 1]
    if (endT - startT <= 1e-9) {
      continue
    }

    const midT = (startT + endT) / 2
    const raisedZ = activeObstacles
      .filter((entry) => midT >= entry.interval[0] - 1e-9 && midT <= entry.interval[1] + 1e-9)
      .reduce<number | null>((max, entry) => (
        max === null ? entry.obstacle.zTop : Math.max(max, entry.obstacle.zTop)
      ), null)

    const segmentZ = raisedZ ?? baseZ
    const segmentStart = pointAt(move, startT, segmentZ)
    const segmentEnd = pointAt(move, endT, segmentZ)

    if (!pointsEqualXY(current, segmentStart) || Math.abs(current.z - segmentZ) > 1e-9) {
      const transitionTo = { x: segmentStart.x, y: segmentStart.y, z: segmentZ }
      result.push({
        kind: segmentZ > current.z ? 'lead_out' : 'lead_in',
        from: current,
        to: transitionTo,
      })
      current = transitionTo
    }

    if (!pointsEqualXY(segmentStart, segmentEnd)) {
      result.push({
        kind: 'cut',
        from: { ...segmentStart },
        to: { ...segmentEnd },
      })
      current = { ...segmentEnd }
    }
  }

  return result.length > 0 ? result : [move]
}

function adjustVerticalMoveForTabs(
  move: ToolpathMove,
  obstacles: PreservedObstacle[],
  actualFrom: ToolpathPoint,
): ToolpathMove {
  if (!pointsEqualXY(actualFrom, move.to)) {
    return { ...move, from: { ...actualFrom } }
  }

  if (actualFrom.z <= move.to.z) {
    return { ...move, from: { ...actualFrom } }
  }

  const requiredTop = obstacles
    .filter((obstacle) => pointInPolygon(actualFrom.x, actualFrom.y, obstacle.points))
    .reduce<number | null>((max, tab) => {
      if (actualFrom.z > tab.zTop && move.to.z < tab.zTop) {
        return max === null ? tab.zTop : Math.max(max, tab.zTop)
      }
      return max
    }, null)

  if (requiredTop === null || move.to.z >= requiredTop - 1e-9) {
    return { ...move, from: { ...actualFrom } }
  }

  return {
    ...move,
    from: { ...actualFrom },
    to: { ...move.to, z: requiredTop },
  }
}

/**
 * The tab pass for Edge Route operations.
 *
 * LOAD-BEARING: trochoidal roughing generates its own tab motion. It fragments
 * the guide around each tab *before* any orbit exists, cuts the local tab-top
 * interval, and helically re-enters afterwards. Running the shared pass over
 * that output applies tabs a second time, against a footprint expanded by a
 * different clearance, which splits finished orbits and lifts them to the tab
 * top with synthesised lead-ins — an unproven vertical re-entry into stock the
 * guide-domain design exists to prevent. Do not "simplify" this branch away.
 *
 * Callers that are not edge routes (finish-surface passes) still call
 * `applyTabsToEdgeRoute` directly; the strategy question does not arise there.
 */
export function applyEdgeRouteTabs(project: Project, operation: Operation, result: ToolpathResult): ToolpathResult {
  if (isTrochoidalEdgeRoughing(operation)) {
    return result
  }
  return applyTabsToEdgeRoute(project, operation, result)
}

export function applyTabsToEdgeRoute(project: Project, operation: Operation, result: ToolpathResult): ToolpathResult {
  if (!isSupportedTabOperation(operation.kind) || result.moves.length === 0) {
    return result
  }

  const toolRecord = operation.toolRef
    ? project.tools.find((tool) => tool.id === operation.toolRef) ?? null
    : null
  const effectiveRadius = toolRecord
    ? normalizeToolForProject(toolRecord, project).radius + Math.max(0, operation.stockToLeaveRadial)
    : Math.max(0, operation.stockToLeaveRadial)

  const obstacles = expandObstacles(buildTabObstacles(project), effectiveRadius)
  if (obstacles.length === 0) {
    return result
  }

  // A project with no smooth tab never reaches the chain-based planner at all.
  // Rectangular output is then preserved by construction rather than by a test
  // that has to notice a divergence — the same code runs that ran before #414.
  const hasSmoothTab = obstacles.some((obstacle) => obstacle.shape === 'smooth')
  const smoothPlan = hasSmoothTab
    ? planSmoothTabMotion(
        result.moves,
        obstacles,
        convertLength(SMOOTH_TAB_CHORD_TOLERANCE_MM, 'mm', project.meta.units),
        { pointInPolygon, clipSegmentPolygon2D },
      )
    : null

  const adjustedMoves: ToolpathMove[] = []
  let changed = false

  for (const [moveIndex, move] of result.moves.entries()) {
    const previousTo = adjustedMoves.at(-1)?.to ?? null
    const actualFrom =
      previousTo && pointsEqualXY(previousTo, move.from)
        ? previousTo
        : move.from

    if (move.kind === 'cut' && Math.abs(move.from.z - move.to.z) <= 1e-9) {
      const splitMoves = smoothPlan
        ? splitCutMoveWithSmoothTabs(smoothPlan, moveIndex, move, actualFrom)
        : splitCutMoveAcrossTabsFrom(move, obstacles, actualFrom)
      if (
        splitMoves.length !== 1
        || splitMoves[0].kind !== move.kind
        || Math.abs(splitMoves[0].from.z - move.from.z) > 1e-9
        || Math.abs(splitMoves[0].to.z - move.to.z) > 1e-9
      ) {
        changed = true
      }
      adjustedMoves.push(...splitMoves)
      continue
    }

    const adjustedMove = adjustVerticalMoveForTabs(move, obstacles, actualFrom)
    if (
      Math.abs(adjustedMove.from.z - move.from.z) > 1e-9
      || Math.abs(adjustedMove.to.z - move.to.z) > 1e-9
      || !pointsEqualXY(adjustedMove.from, move.from)
      || !pointsEqualXY(adjustedMove.to, move.to)
    ) {
      changed = true
    }
    adjustedMoves.push(adjustedMove)
  }

  if (!changed) {
    return result
  }

  const warnings = [...result.warnings]
  if (finalDepthIsBlocked(result.moves, adjustedMoves)) {
    warnings.push({ code: 'tabsBlockFinalDepth', params: { name: operation.name } })
  }

  return {
    ...result,
    moves: adjustedMoves,
    warnings,
    bounds: computeBounds(adjustedMoves),
  }
}

/**
 * True when every cut move that reached the deepest level before tabs were applied
 * has been raised off it. The operation then never severs the part: the final pass
 * rides the tab tops for its whole length. Tabs are meant to interrupt that pass,
 * not replace it, so full coverage is always a mistake in the tab layout.
 */
function finalDepthIsBlocked(originalMoves: ToolpathMove[], adjustedMoves: ToolpathMove[]): boolean {
  let deepestZ = Number.POSITIVE_INFINITY
  for (const move of originalMoves) {
    if (move.kind !== 'cut') continue
    deepestZ = Math.min(deepestZ, move.from.z, move.to.z)
  }

  if (!Number.isFinite(deepestZ)) {
    return false
  }

  return !adjustedMoves.some(
    (move) => move.kind === 'cut'
      && (move.from.z <= deepestZ + 1e-9 || move.to.z <= deepestZ + 1e-9),
  )
}

/** A candidate tab footprint, before it becomes a `Tab` record. */
export interface TabRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Tool-centre contours for a closed feature outline, offset the way an edge route
 * offsets it: inward by the tool radius for an inside cut, outward for an outside cut.
 * This is the path tabs actually interrupt, and it is what tab spacing has to be
 * measured against — a feature's bounding box says nothing useful about it, least of
 * all for a circle, whose offset path is `pi/4` of the box perimeter.
 */
export function toolCentreContours(profilePoints: Point[], offsetDelta: number): Point[][] {
  if (profilePoints.length < 3) {
    return []
  }

  if (Math.abs(offsetDelta) <= 1e-9) {
    return [profilePoints]
  }

  return offsetKeepOutPaths(
    [toClipperPath(normalizeWinding(profilePoints, true), DEFAULT_CLIPPER_SCALE)],
    offsetDelta * DEFAULT_CLIPPER_SCALE,
    TAB_FOOTPRINT_JOIN_TYPE,
  )
    .map((path) => fromClipperPath(path, DEFAULT_CLIPPER_SCALE))
    .filter((points) => points.length >= 3)
}

/**
 * Fraction of `contours` that the given tabs would leave free to cut, once each tab is
 * grown by the tool radius exactly as `applyTabsToEdgeRoute` grows it. Returns 0 when
 * there is no path to cut. A tab spanning a curve consumes arc length, which exceeds
 * its own width, so this has to be measured rather than inferred from tab sizes.
 */
export function tabLayoutFreeFraction(
  contours: Point[][],
  tabRects: TabRect[],
  toolRadius: number,
): number {
  const obstacles = tabRects.map((rect) =>
    offsetObstaclePoints(sampleProfilePoints(rectProfile(rect.x, rect.y, rect.w, rect.h)), Math.max(0, toolRadius)),
  )

  let pathLength = 0
  let coveredLength = 0

  for (const contour of contours) {
    for (let index = 0; index < contour.length; index += 1) {
      const start = contour[index]
      const end = contour[(index + 1) % contour.length]
      const segmentLength = Math.hypot(end.x - start.x, end.y - start.y)
      if (!(segmentLength > 0)) {
        continue
      }

      pathLength += segmentLength

      const intervals: Array<[number, number]> = []
      for (const obstacle of obstacles) {
        const interval = clipSegmentPolygon2D(start.x, start.y, end.x, end.y, obstacle)
        if (interval) {
          intervals.push(interval)
        }
      }

      coveredLength += segmentLength * unionLength(intervals)
    }
  }

  return pathLength > 0 ? Math.max(0, (pathLength - coveredLength) / pathLength) : 0
}

/** Total length of a union of [start, end] sub-intervals of [0, 1]. */
function unionLength(intervals: Array<[number, number]>): number {
  if (intervals.length === 0) {
    return 0
  }

  const sorted = [...intervals].sort((left, right) => left[0] - right[0])
  let total = 0
  let currentStart = sorted[0][0]
  let currentEnd = sorted[0][1]

  for (let index = 1; index < sorted.length; index += 1) {
    const [start, end] = sorted[index]
    if (start > currentEnd) {
      total += currentEnd - currentStart
      currentStart = start
      currentEnd = end
      continue
    }
    currentEnd = Math.max(currentEnd, end)
  }

  return Math.min(1, total + (currentEnd - currentStart))
}

export function applyTabWarnings(project: Project, operation: Operation, result: ToolpathResult): ToolpathResult {
  if (project.tabs.length === 0) {
    return result
  }

  const visibleTabs = buildTabObstacles(project)
  if (visibleTabs.length === 0) {
    return result
  }

  const warnings = [...result.warnings]
  const cutMoves = result.moves.filter(
    (move) => move.kind === 'cut' || move.kind === 'lead_in' || move.kind === 'lead_out',
  )

  let cutBounds: ToolpathBounds | null = null
  for (const move of cutMoves) {
    cutBounds = updateBounds(cutBounds, move.from)
    cutBounds = updateBounds(cutBounds, move.to)
  }

  const relevantTabs = visibleTabs.filter((entry) => obstacleOverlapsToolpathBounds(entry, cutBounds))
  if (relevantTabs.length === 0) {
    return result
  }

  let cutMinZ = Number.POSITIVE_INFINITY
  let cutMaxZ = Number.NEGATIVE_INFINITY
  for (const move of cutMoves) {
    cutMinZ = Math.min(cutMinZ, move.from.z, move.to.z)
    cutMaxZ = Math.max(cutMaxZ, move.from.z, move.to.z)
  }

  const xyOnlyTabNames: string[] = []
  const depthRelevantTabs: PreservedObstacle[] = []

  for (let index = 0; index < relevantTabs.length; index += 1) {
    const entry = relevantTabs[index]
    const tab = entry

    if (!(tab.zTop > tab.zBottom)) {
      warnings.push({ code: 'tabInvalidZRange', params: { name: tab.name, zBottom: tab.zBottom.toFixed(3), zTop: tab.zTop.toFixed(3) } })
      continue
    }

    if (tab.zBottom < 0) {
      warnings.push({ code: 'tabBelowStockBottom', params: { name: tab.name, zBottom: tab.zBottom.toFixed(3) } })
    }

    if (tab.zTop > project.stock.thickness) {
      warnings.push({ code: 'tabAboveStockTop', params: { name: tab.name, zTop: tab.zTop.toFixed(3), stockTop: project.stock.thickness.toFixed(3) } })
    }

    const intersectsCutPath = cutMoves.some((move) => clipSegmentPolygon2D(move.from.x, move.from.y, move.to.x, move.to.y, entry.points) !== null)
    if (!intersectsCutPath) {
      warnings.push({ code: 'tabNoIntersect', params: { name: tab.name } })
      continue
    }

    if (Number.isFinite(cutMinZ) && Number.isFinite(cutMaxZ)) {
      const affectsCutDepth = rangesOverlap(tab.zBottom, tab.zTop, cutMinZ, cutMaxZ)
      if (!affectsCutDepth) {
        xyOnlyTabNames.push(tab.name)
        continue
      }

      depthRelevantTabs.push(entry)

      if (!isSupportedTabOperation(operation.kind)) {
        warnings.push({ code: 'tabOnlyEdgeRoute', params: { name: tab.name } })
      }
    }
  }

  if (xyOnlyTabNames.length > 0 && Number.isFinite(cutMinZ) && Number.isFinite(cutMaxZ)) {
    const listedTabNames = xyOnlyTabNames.slice(0, 3).map((name) => `"${name}"`).join(', ')
    const remainingCount = xyOnlyTabNames.length - Math.min(xyOnlyTabNames.length, 3)

    // Sentence composition (list suffix, "and N more") lives in the message
    // templates so every shape is translatable; the engine only picks the
    // variant matching which parts exist.
    const zRangeParams = { minZ: cutMinZ.toFixed(3), maxZ: cutMaxZ.toFixed(3) }
    if (xyOnlyTabNames.length === 1) {
      warnings.push({ code: 'tabOutsideCutZ', params: { name: listedTabNames, ...zRangeParams } })
    } else if (listedTabNames === '') {
      warnings.push({ code: 'tabsOutsideCutZ', params: { count: xyOnlyTabNames.length, ...zRangeParams } })
    } else if (remainingCount > 0) {
      warnings.push({
        code: 'tabsOutsideCutZListMore',
        params: { count: xyOnlyTabNames.length, names: listedTabNames, more: remainingCount, ...zRangeParams },
      })
    } else {
      warnings.push({
        code: 'tabsOutsideCutZList',
        params: { count: xyOnlyTabNames.length, names: listedTabNames, ...zRangeParams },
      })
    }
  }

  for (let index = 0; index < depthRelevantTabs.length; index += 1) {
    const entry = depthRelevantTabs[index]
    const tab = entry
    for (let otherIndex = index + 1; otherIndex < depthRelevantTabs.length; otherIndex += 1) {
      const other = depthRelevantTabs[otherIndex]
      if (rectsOverlap(entry, other)) {
        warnings.push({ code: 'tabsOverlapAmbiguous', params: { a: tab.name, b: other.name } })
      }
    }
  }

  if (warnings.length === result.warnings.length) {
    return result
  }

  return {
    ...result,
    warnings,
  }
}
