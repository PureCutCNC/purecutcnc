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

import type { SketchProfile, Point } from '../../types/project'
import { segmentEndPoint } from '../../types/project'
import type { ResolvedSeg, LineSeg, ArcSeg } from './segmentIntersection'

const TWO_PI = 2 * Math.PI

/**
 * Resolve every profile segment into a {@link ResolvedSeg} (or `null` for
 * unsupported types, currently only bezier).
 *
 * The returned array has **exactly one entry per `profile.segments` entry**
 * (1:1 index alignment).  Consumers that need the true segment index (e.g.
 * `profile.segments[segmentIndex]`) can use the array index directly.
 */
export function resolveProfileSegments(
  profile: SketchProfile,
): Array<ResolvedSeg | null> {
  const { start, segments } = profile
  const result: Array<ResolvedSeg | null> = new Array(segments.length)

  let current: Point = start

  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i]
    const segStart = current

    switch (seg.type) {
      case 'line': {
        result[i] = {
          kind: 'line',
          p0: segStart,
          p1: seg.to,
        } satisfies LineSeg
        current = seg.to
        break
      }

      case 'arc': {
        const radius = Math.hypot(segStart.x - seg.center.x, segStart.y - seg.center.y)
        const a0 = Math.atan2(segStart.y - seg.center.y, segStart.x - seg.center.x)
        const a1 = Math.atan2(seg.to.y - seg.center.y, seg.to.x - seg.center.x)
        result[i] = {
          kind: 'arc',
          center: seg.center,
          radius,
          a0,
          a1,
          ccw: !seg.clockwise,
        } satisfies ArcSeg
        current = seg.to
        break
      }

      case 'circle': {
        const radius = Math.hypot(segStart.x - seg.center.x, segStart.y - seg.center.y)
        const a0 = Math.atan2(segStart.y - seg.center.y, segStart.x - seg.center.x)
        // Full circle: sweep is ±2π consistent with seg.clockwise
        const a1 = seg.clockwise ? a0 - TWO_PI : a0 + TWO_PI
        result[i] = {
          kind: 'arc',
          center: seg.center,
          radius,
          a0,
          a1,
          ccw: !seg.clockwise,
        } satisfies ArcSeg
        // Circle closes back on itself; next segment (if any) starts at the
        // same point — but we use segmentEndPoint to match the rest of the
        // profile system.
        current = segmentEndPoint(seg, start)
        break
      }

      case 'bezier':
      default: {
        result[i] = null
        // Advance current for any subsequent segments (bezier always has a
        // well-defined endpoint).
        if (seg.type === 'bezier') {
          current = seg.to
        }
        break
      }
    }
  }

  return result
}
