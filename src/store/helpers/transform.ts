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

import type { Point, Segment, SketchFeature, Clamp, Tab } from '../../types/project'
import { normalizePoint, subtractPoint, scalePoint, dotPoint } from './geometry'
import { angleToPoint, normalizeAngleDegrees } from './normalize'

export function translatePoint(point: Point, dx: number, dy: number): Point {
  return { x: point.x + dx, y: point.y + dy }
}

export function translateProfile(profile: SketchFeature['sketch']['profile'], dx: number, dy: number): SketchFeature['sketch']['profile'] {
  return {
    ...profile,
    start: translatePoint(profile.start, dx, dy),
    segments: profile.segments.map((segment) => {
      if (segment.type === 'arc' || segment.type === 'circle') {
        return {
          ...segment,
          to: translatePoint(segment.to, dx, dy),
          center: translatePoint(segment.center, dx, dy),
        }
      }

      if (segment.type === 'bezier') {
        return {
          ...segment,
          to: translatePoint(segment.to, dx, dy),
          control1: translatePoint(segment.control1, dx, dy),
          control2: translatePoint(segment.control2, dx, dy),
        }
      }

      return {
        ...segment,
        to: translatePoint(segment.to, dx, dy),
      }
    }),
  }
}

export function transformProfile(
  profile: SketchFeature['sketch']['profile'],
  transformPoint: (point: Point) => Point,
): SketchFeature['sketch']['profile'] {
  return {
    ...profile,
    start: transformPoint(profile.start),
    segments: profile.segments.map((segment) => {
      if (segment.type === 'arc' || segment.type === 'circle') {
        return {
          ...segment,
          to: transformPoint(segment.to),
          center: transformPoint(segment.center),
        }
      }

      if (segment.type === 'bezier') {
        return {
          ...segment,
          to: transformPoint(segment.to),
          control1: transformPoint(segment.control1),
          control2: transformPoint(segment.control2),
        }
      }

      return {
        ...segment,
        to: transformPoint(segment.to),
      }
    }),
  }
}

export function arcToBezierSegments(start: Point, segment: Extract<Segment, { type: 'arc' }>): Array<Extract<Segment, { type: 'bezier' }>> {
  const startAngle = Math.atan2(start.y - segment.center.y, start.x - segment.center.x)
  const endAngle = Math.atan2(segment.to.y - segment.center.y, segment.to.x - segment.center.x)
  const radius = Math.hypot(start.x - segment.center.x, start.y - segment.center.y)

  let sweep = endAngle - startAngle
  if (segment.clockwise && sweep > 0) {
    sweep -= Math.PI * 2
  } else if (!segment.clockwise && sweep < 0) {
    sweep += Math.PI * 2
  }

  const segmentCount = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)))
  const step = sweep / segmentCount
  const result: Array<Extract<Segment, { type: 'bezier' }>> = []

  for (let index = 0; index < segmentCount; index += 1) {
    const angle0 = startAngle + step * index
    const angle1 = angle0 + step
    const p0 = {
      x: segment.center.x + Math.cos(angle0) * radius,
      y: segment.center.y + Math.sin(angle0) * radius,
    }
    const p3 = {
      x: segment.center.x + Math.cos(angle1) * radius,
      y: segment.center.y + Math.sin(angle1) * radius,
    }
    const tangent0 = { x: -Math.sin(angle0), y: Math.cos(angle0) }
    const tangent1 = { x: -Math.sin(angle1), y: Math.cos(angle1) }
    const handleScale = (4 / 3) * Math.tan(step / 4) * radius

    result.push({
      type: 'bezier',
      control1: {
        x: p0.x + tangent0.x * handleScale,
        y: p0.y + tangent0.y * handleScale,
      },
      control2: {
        x: p3.x - tangent1.x * handleScale,
        y: p3.y - tangent1.y * handleScale,
      },
      to: p3,
    })
  }

  return result
}

export function transformProfileAffine(
  profile: SketchFeature['sketch']['profile'],
  transformPoint: (point: Point) => Point,
): SketchFeature['sketch']['profile'] {
  const nextSegments: Segment[] = []
  let current = profile.start

  for (const segment of profile.segments) {
    if (segment.type === 'arc') {
      const beziers = arcToBezierSegments(current, segment)
      for (const bezier of beziers) {
        nextSegments.push({
          type: 'bezier',
          control1: transformPoint(bezier.control1),
          control2: transformPoint(bezier.control2),
          to: transformPoint(bezier.to),
        })
      }
    } else if (segment.type === 'bezier') {
      nextSegments.push({
        ...segment,
        control1: transformPoint(segment.control1),
        control2: transformPoint(segment.control2),
        to: transformPoint(segment.to),
      })
    } else {
      nextSegments.push({
        ...segment,
        to: transformPoint(segment.to),
      })
    }

    current = segment.to
  }

  return {
    ...profile,
    start: transformPoint(profile.start),
    segments: nextSegments,
  }
}

export function rotatePointAround(point: Point, origin: Point, angle: number): Point {
  const local = subtractPoint(point, origin)
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return {
    x: origin.x + local.x * cos - local.y * sin,
    y: origin.y + local.x * sin + local.y * cos,
  }
}

function mirrorDirectionAcrossAxis(direction: Point, axis: Point): Point {
  const projected = scalePoint(axis, dotPoint(direction, axis))
  return subtractPoint(scalePoint(projected, 2), direction)
}

export function mirrorAngleAcrossLine(angleDegrees: number, lineStart: Point, lineEnd: Point): number | null {
  const axis = normalizePoint(subtractPoint(lineEnd, lineStart))
  if (!axis) {
    return null
  }

  const mirrored = mirrorDirectionAcrossAxis(angleToPoint(angleDegrees), axis)
  return normalizeAngleDegrees(Math.atan2(mirrored.y, mirrored.x) * (180 / Math.PI))
}

export function mirrorProfile(
  profile: SketchFeature['sketch']['profile'],
  transformPoint: (point: Point) => Point,
): SketchFeature['sketch']['profile'] {
  return {
    ...profile,
    start: transformPoint(profile.start),
    segments: profile.segments.map((segment) => {
      if (segment.type === 'arc' || segment.type === 'circle') {
        return {
          ...segment,
          to: transformPoint(segment.to),
          center: transformPoint(segment.center),
          clockwise: !segment.clockwise,
        }
      }

      if (segment.type === 'bezier') {
        return {
          ...segment,
          to: transformPoint(segment.to),
          control1: transformPoint(segment.control1),
          control2: transformPoint(segment.control2),
        }
      }

      return {
        ...segment,
        to: transformPoint(segment.to),
      }
    }),
  }
}

export function translateClamp(clamp: Clamp, dx: number, dy: number): Clamp {
  return {
    ...clamp,
    x: clamp.x + dx,
    y: clamp.y + dy,
  }
}

export function translateTab(tab: Tab, dx: number, dy: number): Tab {
  return {
    ...tab,
    x: tab.x + dx,
    y: tab.y + dy,
  }
}
