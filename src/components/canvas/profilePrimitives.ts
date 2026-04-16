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

import type { Point, Segment, SketchProfile } from '../../types/project'
import { worldToCanvas } from './viewTransform'
import type { ViewTransform } from './viewTransform'

export function anchorPointForIndex(profile: SketchProfile, index: number): Point {
  if (index === 0) return profile.start
  const seg = profile.segments[index - 1]
  if (seg.type === 'circle') return profile.start
  return (seg as any).to
}

export function arcControlPoint(start: Point, segment: Extract<Segment, { type: 'arc' | 'circle' }>): Point {
  const startAngle = Math.atan2(start.y - segment.center.y, start.x - segment.center.x)
  const endAngle = Math.atan2(segment.to.y - segment.center.y, segment.to.x - segment.center.x)
  const radius = Math.hypot(start.x - segment.center.x, start.y - segment.center.y)

  let sweep = endAngle - startAngle
  if (segment.type === 'circle') {
    sweep = segment.clockwise ? -Math.PI * 2 : Math.PI * 2
  } else {
    if (segment.clockwise && sweep > 0) {
      sweep -= Math.PI * 2
    } else if (!segment.clockwise && sweep < 0) {
      sweep += Math.PI * 2
    }
  }

  const midAngle = startAngle + sweep / 2
  return {
    x: segment.center.x + Math.cos(midAngle) * radius,
    y: segment.center.y + Math.sin(midAngle) * radius,
  }
}

export function traceProfilePath(
  ctx: CanvasRenderingContext2D,
  profile: SketchProfile,
  vt: ViewTransform,
): void {
  ctx.beginPath()
  const start = worldToCanvas(profile.start, vt)
  ctx.moveTo(start.cx, start.cy)

  let current = profile.start

  for (const segment of profile.segments) {
    if (segment.type === 'line') {
      const to = worldToCanvas(segment.to, vt)
      ctx.lineTo(to.cx, to.cy)
      current = segment.to
      continue
    }

    if (segment.type === 'bezier') {
      const to = worldToCanvas(segment.to, vt)
      const control1 = worldToCanvas(segment.control1, vt)
      const control2 = worldToCanvas(segment.control2, vt)
      ctx.bezierCurveTo(control1.cx, control1.cy, control2.cx, control2.cy, to.cx, to.cy)
      current = segment.to
      continue
    }

    if (segment.type === 'circle') {
      const center = worldToCanvas(segment.center, vt)
      const radius = Math.hypot(current.x - segment.center.x, current.y - segment.center.y) * vt.scale
      const startAngle = Math.atan2(current.y - segment.center.y, current.x - segment.center.x)
      const endAngle = startAngle + (segment.clockwise ? -Math.PI * 2 : Math.PI * 2)
      ctx.arc(center.cx, center.cy, radius, startAngle, endAngle, segment.clockwise)
      current = profile.start
      continue
    }

    const center = worldToCanvas(segment.center, vt)
    const radius = Math.hypot(current.x - segment.center.x, current.y - segment.center.y) * vt.scale
    const startAngle = Math.atan2(current.y - segment.center.y, current.x - segment.center.x)
    const endAngle = Math.atan2(segment.to.y - segment.center.y, segment.to.x - segment.center.x)

    ctx.arc(center.cx, center.cy, radius, startAngle, endAngle, segment.clockwise)
    current = segment.to
  }

  if (profile.closed) {
    ctx.closePath()
  }
}
