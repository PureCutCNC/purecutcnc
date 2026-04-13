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

import type {
  DimensionRef,
  Operation,
  Point,
  Project,
  SketchFeature,
  SketchProfile,
  Tool,
} from '../../types/project'
import { sampleProfilePoints } from '../../types/project'
import { convertToolUnits } from '../../utils/units'
import type {
  ClipperPath,
  FlattenedPath,
  NormalizedTool,
  ResolvedFeatureZSpan,
  ResolvedToolpathOperation,
} from './types'

export const DEFAULT_CLIPPER_SCALE = 10_000

function clonePoint(point: Point): Point {
  return { x: point.x, y: point.y }
}

export function resolveDimensionRef(project: Project, value: DimensionRef): number {
  if (typeof value === 'number') {
    return value
  }
  const named = project.dimensions[value]
  if (!named) {
    throw new Error(`Unknown dimension reference: ${value}`)
  }
  return named.value
}

export function resolveFeatureZSpan(project: Project, feature: SketchFeature): ResolvedFeatureZSpan {
  const top = resolveDimensionRef(project, feature.z_top)
  const bottom = resolveDimensionRef(project, feature.z_bottom)
  const min = Math.min(top, bottom)
  const max = Math.max(top, bottom)
  return {
    top,
    bottom,
    min,
    max,
    height: max - min,
  }
}

export function normalizeToolForProject(tool: Tool, project: Project): NormalizedTool {
  const normalizedTool = tool.units === project.meta.units ? tool : convertToolUnits(tool, project.meta.units)
  return {
    id: tool.id,
    name: tool.name,
    sourceUnits: tool.units,
    units: project.meta.units,
    type: normalizedTool.type,
    diameter: normalizedTool.diameter,
    radius: normalizedTool.diameter / 2,
    vBitAngle: normalizedTool.type === 'v_bit' ? normalizedTool.vBitAngle ?? 60 : null,
    flutes: normalizedTool.flutes,
    material: normalizedTool.material,
    defaultRpm: normalizedTool.defaultRpm,
    defaultFeed: normalizedTool.defaultFeed,
    defaultPlungeFeed: normalizedTool.defaultPlungeFeed,
    defaultStepdown: normalizedTool.defaultStepdown,
    defaultStepover: normalizedTool.defaultStepover,
  }
}

export function resolveOperationTool(project: Project, operation: Operation): ResolvedToolpathOperation {
  const tool = operation.toolRef ? project.tools.find((c) => c.id === operation.toolRef) ?? null : null
  return {
    operation,
    tool: tool ? normalizeToolForProject(tool, project) : null,
    units: project.meta.units,
  }
}

export function flattenProfile(profile: SketchProfile, curveSamples = 24, arcStepRadians = Math.PI / 36): FlattenedPath {
  const sampled = sampleProfilePoints(profile, curveSamples, arcStepRadians)
  return {
    points: sampled.map(clonePoint),
    closed: profile.closed,
  }
}

export function ensureClosedPath(points: Point[]): Point[] {
  if (points.length === 0) return []
  const first = points[0]
  const last = points[points.length - 1]
  if (first.x === last.x && first.y === last.y) return points.map(clonePoint)
  return [...points.map(clonePoint), clonePoint(first)]
}

export function signedArea(points: Point[]): number {
  if (points.length < 3) return 0
  let area = 0
  const closed = ensureClosedPath(points)
  for (let i = 0; i < closed.length - 1; i++) {
    const a = closed[i]
    const b = closed[i + 1]
    area += a.x * b.y - b.x * a.y
  }
  return area / 2
}

export function isClockwise(points: Point[]): boolean {
  return signedArea(points) < 0
}

export function normalizeWinding(points: Point[], wantClockwise: boolean): Point[] {
  const closed = ensureClosedPath(points)
  const alreadyClockwise = isClockwise(closed)
  if (alreadyClockwise === wantClockwise) return closed
  const reversed = [...closed].reverse()
  const first = reversed[0]
  const last = reversed[reversed.length - 1]
  if (first.x !== last.x || first.y !== last.y) {
    reversed.push({ x: first.x, y: first.y })
  }
  return reversed
}

export function applyContourDirection(contours: Point[][], direction: 'conventional' | 'climb' = 'conventional'): Point[][] {
  // Conventional = no-op: Clipper's natural output is CCW in machine Y-up (isClockwise=false),
  // which equals conventional direction for inside/pocket cuts.  For outside edge cuts the
  // caller must invert the direction before calling here (CCW = climb for outside cuts).
  // Climb simply reverses each contour.
  if (direction === 'conventional') {
    return contours
  }
  return contours.map((c) => normalizeWinding(c, !isClockwise(c)))
}

export function toClipperPath(points: Point[], scale = DEFAULT_CLIPPER_SCALE): ClipperPath {
  return ensureClosedPath(points).map((p) => ({ X: Math.round(p.x * scale), Y: Math.round(p.y * scale) }))
}

export function fromClipperPath(path: ClipperPath, scale = DEFAULT_CLIPPER_SCALE): Point[] {
  return path.map((p) => ({ x: p.X / scale, y: p.Y / scale }))
}

export function getOperationClearance(project: Project): number {
  return Math.max(0, project.meta.operationClearanceZ)
}

export function getOperationSafeZ(project: Project, featureSpans: ResolvedFeatureZSpan[] = []): number {
  const highestFeatureZ = featureSpans.reduce((h, span) => Math.max(h, span.max), 0)
  const stockTop = project.stock.thickness
  return Math.max(stockTop, highestFeatureZ) + getOperationClearance(project)
}
