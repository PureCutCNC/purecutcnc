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
import { polygonProfile, type Operation, type Point, type Project, type SketchFeature } from '../../types/project'
import {
  DEFAULT_CLIPPER_SCALE,
  normalizeToolForProject,
  normalizeWinding,
  toClipperPath,
} from './geometry'
import { buildInsetRegions } from './pocket'
import { differenceClipperPaths, unionClipperPaths, clipperPathsToPointContours } from './modelProtection'
import { resolvePocketRegions } from './resolver'
import type { ClipperPath, ResolvedPocketRegion } from './types'

export interface RestRegionDraft {
  profile: SketchFeature['sketch']['profile']
  sourceOperationId: string
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

  const sourceAreaPaths: ClipperPath[] = []
  const reachableAreaPaths: ClipperPath[] = []
  const toolRadius = tool.radius
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

  const sourceUnion = unionClipperPaths(sourceAreaPaths)
  if (sourceUnion.length === 0) {
    return { drafts: [], warnings: [...resolved.warnings, 'No pocket area found for rest-region generation'] }
  }

  const reachableUnion = unionClipperPaths(reachableAreaPaths)
  const restPaths = unionClipperPaths(differenceClipperPaths(sourceUnion, reachableUnion))
  const minArea = Math.max((100 / DEFAULT_CLIPPER_SCALE) ** 2, tool.diameter * tool.diameter * 0.0001)
  const simplifyTolerance = Math.max(5 / DEFAULT_CLIPPER_SCALE, toolRadius * 0.35)
  const contours = clipperPathsToPointContours(restPaths)
    .filter((contour) => contour.length >= 3)
    .filter((contour) => pathArea(toClipperPath(contour, DEFAULT_CLIPPER_SCALE)) >= minArea)
    .map((contour) => simplifyClosedContour(contour, simplifyTolerance))
    .map(cleanClosedContour)
    .filter((contour) => contour.length >= 3)

  return {
    drafts: contours.map((contour) => ({
      profile: polygonProfile(contour),
      sourceOperationId: operation.id,
    })),
    warnings: resolved.warnings,
  }
}
