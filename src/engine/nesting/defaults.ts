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

// Ready-made strategies a caller may pass to `nest()`. The placer never falls
// back to these on its own: spacing and order are always the caller's choice.

import ClipperLib from 'clipper-lib'
import { NEST_SCALE, outerContours, pathToRing, ringToPath, unionPaths } from './clipperOps'
import type { ClipperPath } from '../toolpaths/types'
import { simplifyRing } from './simplify'
import type { NestPart, NestRing } from './types'

/** Integer units added to the growth so rounding to the Clipper grid never shortens it. */
const GROW_ROUNDING_PAD = 2

/**
 * Grows every ring outward by half the gap, so two grown parts that touch are
 * `minimumGap` apart.
 *
 * Corners use square joins, not round ones. A square join cuts each corner
 * with a line tangent to the true arc, so it always contains the exact offset.
 * Clipper's round joins do not: the step count per corner is rounded, and a
 * 90° corner can come out as a single chord that cuts well inside the arc —
 * measured at 0.022 mm short of a 6 mm gap with a 0.05 mm arc tolerance.
 */
export function expandByHalfGap(rings: NestRing[], minimumGap: number, simplifyTolerance = 0): NestRing[] {
  const paths = outerContours(rings.map(ringToPath))
  const simplify = simplifyTolerance > 0 ? simplifyTolerance : 0
  if (minimumGap <= 0 && simplify === 0) return paths.map(pathToRing)
  const offset = new ClipperLib.ClipperOffset()
  offset.AddPaths(paths, ClipperLib.JoinType.jtSquare, ClipperLib.EndType.etClosedPolygon)
  const grown: ClipperPath[] = new ClipperLib.Paths()
  // With simplification the growth is padded by its tolerance: the
  // simplified boundary stays within one tolerance of the grown one, and
  // every point of the exact gap/2 offset is at least that far inside the
  // grown boundary, so it stays inside the simplified one too (#855).
  offset.Execute(grown, (Math.max(0, minimumGap) / 2 + simplify) * NEST_SCALE + GROW_ROUNDING_PAD)
  const contours = outerContours(grown).map(pathToRing)
  return simplify > 0 ? outerContours(contours.map((ring) => ringToPath(simplifyRing(ring, simplify)))).map(pathToRing) : contours
}

/**
 * Shrinks hole regions by half the gap (#859), so a part grown by
 * {@link expandByHalfGap} that lies inside a shrunk hole is `minimumGap` from
 * the hole's edge. Islands inside a hole grow by the same amount.
 *
 * Shrinking a hole is growing the material around it, so the square-join and
 * simplification arguments above carry over unchanged: the result lies inside
 * the exact inward offset.
 */
export function shrinkByHalfGap(rings: NestRing[], minimumGap: number, simplifyTolerance = 0): NestRing[] {
  const paths = unionPaths(rings.map(ringToPath))
  const simplify = simplifyTolerance > 0 ? simplifyTolerance : 0
  const offset = new ClipperLib.ClipperOffset()
  offset.AddPaths(paths, ClipperLib.JoinType.jtSquare, ClipperLib.EndType.etClosedPolygon)
  const shrunk: ClipperPath[] = new ClipperLib.Paths()
  offset.Execute(shrunk, -((Math.max(0, minimumGap) / 2 + simplify) * NEST_SCALE + GROW_ROUNDING_PAD))
  if (simplify === 0) return shrunk.map(pathToRing)
  return unionPaths(shrunk.map((path) => ringToPath(simplifyRing(pathToRing(path), simplify)))).map(pathToRing)
}

/** Parts with the largest footprint area first; ties keep id order. */
export function largestFirst(parts: NestPart[]): NestPart[] {
  const area = (part: NestPart) => outerContours(part.footprint.map(ringToPath))
    .reduce((sum, path) => sum + Math.abs(ClipperLib.Clipper.Area(path)), 0)
  return parts
    .map((part) => ({ part, area: area(part) }))
    .sort((a, b) => b.area - a.area || (a.part.id < b.part.id ? -1 : a.part.id > b.part.id ? 1 : 0))
    .map((entry) => entry.part)
}
