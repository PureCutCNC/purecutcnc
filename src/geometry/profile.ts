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

/**
 * Layer-neutral profile geometry primitives.
 *
 * These are pure functions over `SketchProfile` with no store or rendering
 * semantics, so they live outside `store/helpers/` — both the store (a profile
 * consumer) and `src/text/` (a profile producer) import them from here. Keeping
 * them neutral avoids a `text -> store` dependency that would invert the
 * layering.
 *
 * Every segment kind that carries points beyond `to` must be handled here:
 * `arc` and `circle` both carry a `center`, `bezier` carries two controls.
 * Missing one silently leaves those points untransformed.
 */

import type { Point, SketchProfile } from '../types/project'

export function clonePoint(point: Point): Point {
  return { ...point }
}

export function translatePoint(point: Point, dx: number, dy: number): Point {
  return { x: point.x + dx, y: point.y + dy }
}

export function transformProfile(
  profile: SketchProfile,
  transformPoint: (point: Point) => Point,
): SketchProfile {
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

export function translateProfile(profile: SketchProfile, dx: number, dy: number): SketchProfile {
  return transformProfile(profile, (point) => translatePoint(point, dx, dy))
}

/**
 * Copies a profile's points into fresh objects. Note this is *not* a deep clone:
 * segments are shallow-spread, so any non-`Point` nested value a segment grows
 * in future would still be shared with the source.
 */
export function cloneProfile(profile: SketchProfile): SketchProfile {
  return transformProfile(profile, clonePoint)
}
