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

import type { Operation, Point, Project, SketchFeature, Tab } from '../../types/project'
import { getProfileBounds } from '../../types/project'
import { convertLength } from '../../utils/units'
import { expandFeatureGeometry, isTextFeature } from '../../text'
import { nextUniqueGeneratedId } from '../../store/helpers/ids'
import { flattenProfile } from '../toolpaths/geometry'
import { tabLayoutFreeFraction, toolCentreContours, type TabRect } from '../toolpaths/tabs'

function nextAutoTabName(baseName: string, tabs: Tab[]): string {
  const preferred = `${baseName} Tab`
  if (!tabs.some((tab) => tab.name === preferred)) return preferred
  let index = 2
  while (tabs.some((tab) => tab.name === `${preferred} ${index}`)) index += 1
  return `${preferred} ${index}`
}

function defaultAutoTabZTop(project: Project): number {
  return Math.min(project.stock.thickness, convertLength(3, 'mm', project.meta.units))
}

function resolveToolDiameter(project: Project, operation: Operation): number | null {
  if (!operation.toolRef) return null
  const tool = project.tools.find((entry) => entry.id === operation.toolRef) ?? null
  if (!tool || !(tool.diameter > 0)) return null
  return tool.units === project.meta.units
    ? tool.diameter
    : convertLength(tool.diameter, tool.units, project.meta.units)
}

const MIN_FREE_PATH_FRACTION = 0.15
const MIN_TAB_ROUTE_COVERAGE_FRACTION = 1e-6

function nearestPerimeterPoint(points: Point[], target: Point): Point | null {
  const first = points[0]
  if (!first || points.length < 2) return null

  let nearest: Point | null = null
  let nearestDistanceSquared = Number.POSITIVE_INFINITY
  for (const [index, start] of points.entries()) {
    const end = points[(index + 1) % points.length] ?? first
    const dx = end.x - start.x
    const dy = end.y - start.y
    const lengthSquared = dx * dx + dy * dy
    const fraction = lengthSquared > 1e-9
      ? Math.max(0, Math.min(1, ((target.x - start.x) * dx + (target.y - start.y) * dy) / lengthSquared))
      : 0
    const candidate = { x: start.x + dx * fraction, y: start.y + dy * fraction }
    const distanceSquared = (target.x - candidate.x) ** 2 + (target.y - candidate.y) ** 2
    if (distanceSquared < nearestDistanceSquared) {
      nearest = candidate
      nearestDistanceSquared = distanceSquared
    }
  }
  return nearest
}

function tabRectsAt(
  count: 2 | 4,
  size: number,
  profilePoints: Point[],
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
  cx: number,
  cy: number,
  widthIsLongest: boolean,
): TabRect[] {
  const preferred = count === 4
    ? [
        { x: cx, y: bounds.minY },
        { x: cx, y: bounds.maxY },
        { x: bounds.minX, y: cy },
        { x: bounds.maxX, y: cy },
      ]
    : widthIsLongest
      ? [{ x: cx, y: bounds.minY }, { x: cx, y: bounds.maxY }]
      : [{ x: bounds.minX, y: cy }, { x: bounds.maxX, y: cy }]
  const anchors = preferred
    .map((target) => nearestPerimeterPoint(profilePoints, target))
    .filter((anchor): anchor is Point => anchor !== null)
    .filter((anchor, index, all) => all.findIndex((other) => Math.hypot(other.x - anchor.x, other.y - anchor.y) < 1e-6) === index)
  return anchors.map((anchor) => ({
    x: anchor.x - size / 2,
    y: anchor.y - size / 2,
    w: size,
    h: size,
  }))
}

function layoutSafelyBlocksRoute(contours: Point[][], rects: TabRect[], toolRadius: number): boolean {
  if (rects.length === 0 || tabLayoutFreeFraction(contours, rects, toolRadius) < MIN_FREE_PATH_FRACTION) {
    return false
  }
  return rects.every((rect) => (
    1 - tabLayoutFreeFraction(contours, [rect], toolRadius) > MIN_TAB_ROUTE_COVERAGE_FRACTION
  ))
}

/** Pure tab drafts shared by the manual command and CAM Plan preview. */
export function buildAutoTabsForFeature(
  feature: SketchFeature,
  project: Project,
  operation: Operation,
  existingTabs: Tab[],
): Tab[] {
  // A text feature's own profile is its frame; the edge route cuts its glyph
  // shapes, so each glyph the route targets gets its own tabs.
  if (isTextFeature(feature)) {
    const wanted = operation.kind === 'edge_route_inside' ? 'subtract' : 'add'
    const created: Tab[] = []
    for (const glyph of expandFeatureGeometry(feature)) {
      if (glyph.operation !== wanted && glyph.operation !== 'region') continue
      created.push(...buildAutoTabsForFeature(glyph, project, operation, [...existingTabs, ...created]))
    }
    return created
  }
  const bounds = getProfileBounds(feature.sketch.profile)
  const width = Math.max(bounds.maxX - bounds.minX, convertLength(0.1, 'mm', project.meta.units))
  const height = Math.max(bounds.maxY - bounds.minY, convertLength(0.1, 'mm', project.meta.units))
  const cx = bounds.minX + width / 2
  const cy = bounds.minY + height / 2
  const toolDiameter = resolveToolDiameter(project, operation)
  const minSize = Math.max(convertLength(3, 'mm', project.meta.units), (toolDiameter ?? 0) * 1.25)
  const maxSize = Math.max(minSize, Math.min(width, height) * 0.18)
  const size = Math.min(Math.max(minSize, Math.min(width, height) * 0.1), maxSize)
  const toolRadius = (toolDiameter ?? 0) / 2
  const profilePoints = flattenProfile(feature.sketch.profile).points
  const contours = toolCentreContours(
    profilePoints,
    operation.kind === 'edge_route_inside' ? -toolRadius : toolRadius,
  )
  const widthIsLongest = width >= height
  const candidates: Array<{ count: 2 | 4; size: number }> = [
    { count: 4, size },
    { count: 2, size },
  ]
  if (size > minSize + 1e-9) {
    candidates.push({ count: 4, size: minSize }, { count: 2, size: minSize })
  }
  const entries = candidates
    .map((candidate) => ({
      candidate,
      rects: tabRectsAt(candidate.count, candidate.size, profilePoints, bounds, cx, cy, widthIsLongest),
    }))
    .find(({ candidate, rects }) => rects.length === candidate.count && layoutSafelyBlocksRoute(contours, rects, toolRadius))
    ?.rects
    ?? []

  const created: Tab[] = []
  for (const entry of entries) {
    created.push({
      id: nextUniqueGeneratedId({ ...project, tabs: [...existingTabs, ...created] }, 'tb'),
      name: nextAutoTabName(feature.name, [...existingTabs, ...created]),
      x: entry.x,
      y: entry.y,
      w: entry.w,
      h: entry.h,
      z_top: defaultAutoTabZTop(project),
      z_bottom: 0,
      visible: true,
      shape: 'rect',
    })
  }
  return created
}
