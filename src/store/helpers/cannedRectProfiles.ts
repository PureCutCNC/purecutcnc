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

import { rectProfile, type Point, type SketchProfile } from '../../types/project'
import { applyLineCornerFillet } from './profileEdit'

/**
 * Build a rounded-rectangle profile from two opposite corners.
 * Applies a uniform fillet of `radius` to all four corners via applyLineCornerFillet.
 * If radius exceeds min(W,H)/2 it is clamped so corners never overlap.
 */
export function roundedRectProfile(c1: Point, c2: Point, radius: number): SketchProfile {
  const x = Math.min(c1.x, c2.x)
  const y = Math.min(c1.y, c2.y)
  const w = Math.abs(c2.x - c1.x)
  const h = Math.abs(c2.y - c1.y)
  const clamp = Math.min(w, h) / 2
  const corner = Math.min(radius, clamp - 1e-6)

  let profile = rectProfile(x, y, w, h)

  if (corner <= 0) {
    return profile
  }

  // Process up to 4 corners via the fillet helper.
  // Each fillet replaces a line→line corner with line→arc→line.
  // Re-scanning for the next sharp corner handles the index shift;
  // the arc segment naturally breaks the line-line pattern so
  // already-processed corners are skipped.
  for (let pass = 0; pass < 4; pass += 1) {
    let idx = -1
    const segs = profile.segments
    for (let i = 0; i < segs.length; i += 1) {
      const incomingIdx = (i - 1 + segs.length) % segs.length
      if (segs[incomingIdx]?.type === 'line' && segs[i]?.type === 'line') {
        idx = i
        break
      }
    }
    if (idx < 0) break
    const next = applyLineCornerFillet(profile, idx, corner)
    if (!next) break
    profile = next
  }

  return profile
}

/**
 * Build a chamfered-rectangle profile from two opposite corners.
 * Constructs 8 line segments directly — the loop-scan approach doesn't work
 * for chamfers because intermediate chamfer vertices also form line→line
 * corners, which would cause repeated processing of the same corner.
 *
 * Profile (CCW from bottom-left corner's vertical start):
 *   start → d,0 → w-d,0 → w,d → w,h-d → w-d,h → d,h → 0,h-d → 0,d (closed)
 */
export function chamferedRectProfile(c1: Point, c2: Point, distance: number): SketchProfile {
  const x = Math.min(c1.x, c2.x)
  const y = Math.min(c1.y, c2.y)
  const w = Math.abs(c2.x - c1.x)
  const h = Math.abs(c2.y - c1.y)
  const clamp = Math.min(w, h) / 2
  const d = Math.min(distance, clamp - 1e-6)

  if (d <= 0) {
    return rectProfile(x, y, w, h)
  }

  return {
    start: { x, y: y + d },
    segments: [
      { type: 'line', to: { x: x + d, y } },
      { type: 'line', to: { x: x + w - d, y } },
      { type: 'line', to: { x: x + w, y: y + d } },
      { type: 'line', to: { x: x + w, y: y + h - d } },
      { type: 'line', to: { x: x + w - d, y: y + h } },
      { type: 'line', to: { x: x + d, y: y + h } },
      { type: 'line', to: { x, y: y + h - d } },
      { type: 'line', to: { x, y: y + d } },
    ],
    closed: true,
  }
}
