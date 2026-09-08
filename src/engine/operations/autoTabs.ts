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

import type { Operation, Project, SketchFeature, Tab } from '../../types/project'
import { getProfileBounds } from '../../types/project'
import { convertLength } from '../../utils/units'
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

function tabRectsAt(
  count: 2 | 4,
  size: number,
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
  cx: number,
  cy: number,
  widthIsLongest: boolean,
): TabRect[] {
  if (count === 2) {
    return widthIsLongest
      ? [
          { x: cx - size / 2, y: bounds.minY - size / 2, w: size, h: size },
          { x: cx - size / 2, y: bounds.maxY - size / 2, w: size, h: size },
        ]
      : [
          { x: bounds.minX - size / 2, y: cy - size / 2, w: size, h: size },
          { x: bounds.maxX - size / 2, y: cy - size / 2, w: size, h: size },
        ]
  }
  return [
    { x: cx - size / 2, y: bounds.minY - size / 2, w: size, h: size },
    { x: cx - size / 2, y: bounds.maxY - size / 2, w: size, h: size },
    { x: bounds.minX - size / 2, y: cy - size / 2, w: size, h: size },
    { x: bounds.maxX - size / 2, y: cy - size / 2, w: size, h: size },
  ]
}

/** Pure tab drafts shared by the manual command and CAM Plan preview. */
export function buildAutoTabsForFeature(
  feature: SketchFeature,
  project: Project,
  operation: Operation,
  existingTabs: Tab[],
): Tab[] {
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
  const contours = toolCentreContours(
    flattenProfile(feature.sketch.profile).points,
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
    .map((candidate) => tabRectsAt(candidate.count, candidate.size, bounds, cx, cy, widthIsLongest))
    .find((rects) => tabLayoutFreeFraction(contours, rects, toolRadius) >= MIN_FREE_PATH_FRACTION)
    ?? tabRectsAt(2, minSize, bounds, cx, cy, widthIsLongest)

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
