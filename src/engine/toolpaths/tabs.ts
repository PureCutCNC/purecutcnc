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
import type { Operation, Point, Project } from '../../types/project'
import { rectProfile, sampleProfilePoints } from '../../types/project'
import type { ToolpathBounds, ToolpathMove, ToolpathPoint, ToolpathResult } from './types'
import { DEFAULT_CLIPPER_SCALE, fromClipperPath, normalizeToolForProject, normalizeWinding, toClipperPath } from './geometry'

interface PreservedObstacle {
  id: string
  name: string
  points: Point[]
  zTop: number
  zBottom: number
}

function offsetObstaclePoints(points: Point[], delta: number): Point[] {
  if (!(delta > 1e-9) || points.length < 3) {
    return points
  }

  const offset = new ClipperLib.ClipperOffset()
  offset.AddPaths(
    [toClipperPath(normalizeWinding(points, false), DEFAULT_CLIPPER_SCALE)],
    ClipperLib.JoinType.jtMiter,
    ClipperLib.EndType.etClosedPolygon,
  )
  const solution = new ClipperLib.Paths()
  offset.Execute(solution, delta * DEFAULT_CLIPPER_SCALE)
  const expanded = (solution as unknown as { X: number; Y: number }[][])[0]
  return expanded ? fromClipperPath(expanded, DEFAULT_CLIPPER_SCALE) : points
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
    points: sampleProfilePoints(rectProfile(tab.x, tab.y, tab.w, tab.h)),
    zTop: tab.z_top,
    zBottom: tab.z_bottom,
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
  return kind === 'edge_route_inside' || kind === 'edge_route_outside' || kind === 'pocket'
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

  const adjustedMoves: ToolpathMove[] = []
  let changed = false

  for (const move of result.moves) {
    const previousTo = adjustedMoves.at(-1)?.to ?? null
    const actualFrom =
      previousTo && pointsEqualXY(previousTo, move.from)
        ? previousTo
        : move.from

    if (move.kind === 'cut' && Math.abs(move.from.z - move.to.z) <= 1e-9) {
      const splitMoves = splitCutMoveAcrossTabsFrom(move, obstacles, actualFrom)
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

  return {
    ...result,
    moves: adjustedMoves,
    bounds: computeBounds(adjustedMoves),
  }
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
      warnings.push(`Tab "${tab.name}" has invalid Z range (${tab.zBottom.toFixed(3)} -> ${tab.zTop.toFixed(3)}).`)
      continue
    }

    if (tab.zBottom < 0) {
      warnings.push(`Tab "${tab.name}" extends below stock bottom (Z Bottom ${tab.zBottom.toFixed(3)}).`)
    }

    if (tab.zTop > project.stock.thickness) {
      warnings.push(`Tab "${tab.name}" extends above stock top (Z Top ${tab.zTop.toFixed(3)}, stock top ${project.stock.thickness.toFixed(3)}).`)
    }

    const intersectsCutPath = cutMoves.some((move) => clipSegmentPolygon2D(move.from.x, move.from.y, move.to.x, move.to.y, entry.points) !== null)
    if (!intersectsCutPath) {
      warnings.push(`Tab "${tab.name}" does not intersect the selected operation toolpath.`)
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
        warnings.push(`Tab "${tab.name}" is relevant to this operation, but tabs are only applied to edge-route operations right now.`)
      }
    }
  }

  if (xyOnlyTabNames.length > 0 && Number.isFinite(cutMinZ) && Number.isFinite(cutMaxZ)) {
    const listedTabNames = xyOnlyTabNames.slice(0, 3).map((name) => `"${name}"`).join(', ')
    const remainingCount = xyOnlyTabNames.length - Math.min(xyOnlyTabNames.length, 3)

    if (xyOnlyTabNames.length === 1) {
      warnings.push(
        `Nearby tab ${listedTabNames} overlaps the toolpath footprint but is outside the cut Z range (${cutMinZ.toFixed(3)} -> ${cutMaxZ.toFixed(3)}).`,
      )
    } else {
      warnings.push(
        `${xyOnlyTabNames.length} nearby tabs overlap the toolpath footprint but are outside the cut Z range (${cutMinZ.toFixed(3)} -> ${cutMaxZ.toFixed(3)})${listedTabNames ? `: ${listedTabNames}${remainingCount > 0 ? `, and ${remainingCount} more` : ''}` : ''}.`,
      )
    }
  }

  for (let index = 0; index < depthRelevantTabs.length; index += 1) {
    const entry = depthRelevantTabs[index]
    const tab = entry
    for (let otherIndex = index + 1; otherIndex < depthRelevantTabs.length; otherIndex += 1) {
      const other = depthRelevantTabs[otherIndex]
      if (rectsOverlap(entry, other)) {
        warnings.push(`Tabs "${tab.name}" and "${other.name}" overlap in a way that may produce ambiguous output.`)
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
