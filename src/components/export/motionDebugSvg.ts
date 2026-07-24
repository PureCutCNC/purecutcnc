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

import type { MotionDebugSegment } from '../../engine/gcode/motionDebug'

/** Round to 4dp for compact, stable SVG path output. */
function f(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 1e4) / 1e4 : 0
}

/**
 * Build an SVG path `d` string for a set of planar debug segments in project
 * coordinates. Project space is Y-down (screen), matching SVG's coordinate
 * system, so points map 1:1 — no axis flip. Arcs use the SVG `A` command with
 * `sweep-flag = clockwise ? 1 : 0` (SVG sweep=1 is clockwise in Y-down space).
 *
 * A new subpath (`M`) is started only when a segment is discontinuous from the
 * previous one (rapid/level breaks); otherwise the path continues, so connected
 * cut contours stroke as a single polyline/arc chain.
 */
export function buildMotionLayerPathD(segments: MotionDebugSegment[]): string {
  if (segments.length === 0) return ''
  let d = ''
  let prevTo: { x: number; y: number } | null = null
  for (const seg of segments) {
    const from = seg.from
    const to = seg.to
    if (
      prevTo === null
      || Math.abs(prevTo.x - from.x) > 1e-9
      || Math.abs(prevTo.y - from.y) > 1e-9
    ) {
      d += `M${f(from.x)} ${f(from.y)}`
    }
    if (
      seg.kind === 'arc'
      && seg.radius !== undefined
      && seg.clockwise !== undefined
      && seg.largeArc !== undefined
    ) {
      const large = seg.largeArc ? 1 : 0
      const sweep = seg.clockwise ? 1 : 0
      d += `A${f(seg.radius)} ${f(seg.radius)} 0 ${large} ${sweep} ${f(to.x)} ${f(to.y)}`
    } else {
      d += `L${f(to.x)} ${f(to.y)}`
    }
    prevTo = to
  }
  return d
}
