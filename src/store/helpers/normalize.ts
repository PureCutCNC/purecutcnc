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

import { defaultTool, inferFeatureKind, profileVertices } from '../../types/project'
import type { Point, Project, SketchFeature, Tool } from '../../types/project'
import { normalizeTextFontId } from '../../text'

export function normalizeAngleDegrees(angle: number): number {
  const normalized = angle % 360
  return normalized < 0 ? normalized + 360 : normalized
}

export function angleToPoint(angleDegrees: number): Point {
  const radians = (angleDegrees * Math.PI) / 180
  return {
    x: Math.cos(radians),
    y: Math.sin(radians),
  }
}

export function inferProfileOrientationAngle(profile: SketchFeature['sketch']['profile']): number {
  const vertices = profileVertices(profile)
  let bestDirection: Point | null = null
  let bestLength = 0

  for (let index = 0; index < vertices.length; index += 1) {
    const start = vertices[index]
    const end = vertices[(index + 1) % vertices.length]
    const dx = end.x - start.x
    const dy = end.y - start.y
    const length = Math.hypot(dx, dy)
    if (length > bestLength) {
      bestLength = length
      bestDirection = { x: dx / length, y: dy / length }
    }
  }

  if (!bestDirection) {
    return 90
  }

  const xAxisAngle = Math.atan2(bestDirection.y, bestDirection.x) * (180 / Math.PI)
  return normalizeAngleDegrees(xAxisAngle + 90)
}

export function normalizeFeatureZRange(feature: SketchFeature): SketchFeature {
  const safeFeature = {
    ...feature,
    text: feature.kind === 'text' && feature.text
      ? {
        ...feature.text,
        text: feature.text.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\s*\n+\s*/g, ' ').trim() || 'TEXT',
        fontId: normalizeTextFontId(feature.text.fontId, feature.text.style),
      }
      : null,
    sketch: {
      ...feature.sketch,
      orientationAngle: normalizeAngleDegrees(
        feature.sketch.orientationAngle ?? inferProfileOrientationAngle(feature.sketch.profile),
      ),
      profile: {
        ...feature.sketch.profile,
        closed: feature.sketch.profile.closed ?? true,
      },
    },
    kind: feature.kind ?? inferFeatureKind(feature.sketch.profile),
    folderId: feature.folderId ?? null,
  }
  const { z_top, z_bottom } = safeFeature
  if (typeof z_top === 'number' && typeof z_bottom === 'number' && z_top < z_bottom) {
    return {
      ...safeFeature,
      z_top: z_bottom,
      z_bottom: z_top,
    }
  }

  return safeFeature
}

export function normalizeTool(tool: Tool, units: Project['meta']['units'], index: number): Tool {
  const defaults = defaultTool(units, index + 1)
  return {
    ...defaults,
    ...tool,
    vBitAngle: (tool.type ?? defaults.type) === 'v_bit' ? (tool.vBitAngle ?? 60) : null,
  }
}
