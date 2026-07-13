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

import { bezierPoint } from '../types/project'
import type { Segment, SketchProfile } from '../types/project'

export const DEFAULT_ARC_STEP_RADIANS = Math.PI / 18
const DEFAULT_BEZIER_SEGMENTS = 18

/** Flatten a sketch profile using the same curve tolerance as the 3D model. */
export function profileToPolygon(
  profile: SketchProfile,
  arcStepRadians: number = DEFAULT_ARC_STEP_RADIANS,
): [number, number][] {
  const points: [number, number][] = [[profile.start.x, profile.start.y]]
  let current = profile.start

  const bezierSegments = Math.max(
    8,
    Math.round(DEFAULT_BEZIER_SEGMENTS * (DEFAULT_ARC_STEP_RADIANS / arcStepRadians)),
  )

  for (const segment of profile.segments) {
    if (segment.type === 'line') {
      points.push([segment.to.x, segment.to.y])
      current = segment.to
      continue
    }

    if (segment.type === 'bezier') {
      for (let index = 1; index <= bezierSegments; index += 1) {
        const point = bezierPoint(
          current,
          segment.control1,
          segment.control2,
          segment.to,
          index / bezierSegments,
        )
        points.push([point.x, point.y])
      }
      current = segment.to
      continue
    }

    const { type, to, center, clockwise } = segment as Extract<Segment, { type: 'arc' | 'circle' }>
    const startAngle = Math.atan2(current.y - center.y, current.x - center.x)
    const endAngle = Math.atan2(to.y - center.y, to.x - center.x)
    const radius = Math.hypot(current.x - center.x, current.y - center.y)

    let sweep = endAngle - startAngle
    if (type === 'circle') {
      sweep = clockwise ? -Math.PI * 2 : Math.PI * 2
    } else {
      if (clockwise && sweep > 0) sweep -= Math.PI * 2
      else if (!clockwise && sweep < 0) sweep += Math.PI * 2
    }

    const segmentCount = Math.max(8, Math.ceil(Math.abs(sweep) / arcStepRadians))
    for (let index = 1; index <= segmentCount; index += 1) {
      const angle = startAngle + (sweep * index) / segmentCount
      points.push([
        center.x + Math.cos(angle) * radius,
        center.y + Math.sin(angle) * radius,
      ])
    }
    current = to
  }

  const first = points[0]
  const last = points.at(-1)
  if (last && Math.hypot(last[0] - first[0], last[1] - first[1]) < 1e-6) {
    points.pop()
  }

  return points
}

/** Append the first point when an independent-segment batch must close a contour. */
export function closeLinePolygonIfNeeded(
  polygon: [number, number][],
  shouldClose: boolean,
): [number, number][] {
  if (!shouldClose || polygon.length === 0) return polygon
  const result = polygon.slice()
  result.push([...polygon[0]])
  return result
}
