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

import { barCentre } from '../../types/barStock'
import type { BarStock } from '../../types/project'
import { alongCoordinate } from './rotaryModelMotion'
import type { RotaryRegionMask } from './rotaryModelParams'
import { turnAngle } from './rotaryModelTargetSampling'
import type { ToolpathPoint } from './types'

/**
 * Is this tool position inside the operation's region (#1096)?
 *
 * The mask is drawn on the Around sketch's unwrapped sheet, so a position is
 * tested at `(along, across)` for either bar axis -- the same mapping
 * `wrapPoint`/`unwrapPoint` use in `aroundFrame.ts`: across is the bar's
 * centreline plus `a / 360` of one circumference, never reduced to one turn.
 *
 * A tool's A runs 0..360 while the sheet spans one circumference centred on
 * A0, so the same bar surface is reachable from both ends of the sheet. The
 * mask handed in by the adapter has its geometry repeated one circumference
 * each way (`buildRegionMask`'s `repeat`), so this mapping is a single test:
 * a region that crosses the sheet seam, or is drawn past either edge of it,
 * means one continuous area of the bar.
 */
export function rotaryRegionContains(
  mask: RotaryRegionMask,
  stock: BarStock,
  along: number,
  angleDeg: number,
): boolean {
  const across = barCentre(stock) + angleDeg * Math.PI * stock.thickness / 360
  return mask.containsPoint(stock.axis === 'x' ? { x: along, y: across } : { x: across, y: along })
}

/**
 * Is the whole along-bar span at one angle inside the operation's region
 * (#1096 review, P2)?
 *
 * A surface link is one straight cut at one angle, so its membership must be
 * decided for the segment, not for the dense row's sample points: an excluded
 * strip 0.02 mm wide between two samples is still cut by the link that steps
 * over it. The mask exposes its own boundary test (`containsSegment`); `null`
 * means the mask has none, and the caller keeps its point check, so a
 * hand-built mask with only point membership behaves exactly as before.
 */
export function rotaryRegionSegmentContains(
  mask: RotaryRegionMask,
  stock: BarStock,
  fromAlong: number,
  toAlong: number,
  angleDeg: number,
): boolean | null {
  if (mask.containsSegment === undefined) return null
  const across = barCentre(stock) + angleDeg * Math.PI * stock.thickness / 360
  return stock.axis === 'x'
    ? mask.containsSegment({ x: fromAlong, y: across }, { x: toAlong, y: across })
    : mask.containsSegment({ x: across, y: fromAlong }, { x: across, y: toAlong })
}

/**
 * Is an A-changing link's **whole swept path** inside the operation's region
 * (#1117 rl-e correction, review finding 1)?
 *
 * The link is one commanded straight move in `(along, A)`. The sheet's across
 * coordinate is affine in A -- `centre + a * pi * thickness / 360` -- so that
 * move is one straight segment on the sheet: the path's angle at every along
 * position lies exactly on the segment from `(fromAlong, across(fromAngle))` to
 * `(toAlong, across(toAngle))`. The mask's boundary test therefore decides the
 * whole path at once, and can see an excluded strip narrower than the sample
 * spacing that a point-by-point check of the emitted waypoints steps over.
 *
 * `null` means the mask has no boundary test, and the caller keeps its
 * per-sample point check.
 */
export function rotaryRegionSlopeContains(
  mask: RotaryRegionMask,
  stock: BarStock,
  fromAlong: number,
  fromAngle: number,
  toAlong: number,
  toAngle: number,
): boolean | null {
  if (mask.containsSegment === undefined) return null
  const acrossAt = (angleDeg: number): number => barCentre(stock) + angleDeg * Math.PI * stock.thickness / 360
  const fromAcross = acrossAt(fromAngle)
  const toAcross = acrossAt(toAngle)
  return stock.axis === 'x'
    ? mask.containsSegment({ x: fromAlong, y: fromAcross }, { x: toAlong, y: toAcross })
    : mask.containsSegment({ x: fromAcross, y: fromAlong }, { x: toAcross, y: toAlong })
}

/**
 * Is every move of a continuous path inside the operation's region (#1103
 * slice ca-c)?
 *
 * A helix is one straight move in `(along, A)` per segment, so the mask's own
 * boundary test decides the **whole swept path** of each segment -- the same
 * rule `rotaryRegionSlopeContains` already applies to the rough's A-changing
 * links. A mask without a boundary test (`null`) cannot prove a band, and the
 * caller keeps rings there. This is what lets a region that excludes nothing
 * (the whole sheet) keep the region-free motion, while a region that trims part
 * of the band is refused and its rings stay forward-only.
 */
export function continuousPathInsideRegion(
  mask: RotaryRegionMask,
  stock: BarStock,
  points: readonly ToolpathPoint[],
  startAngle: number,
): boolean {
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1]
    const to = points[i]
    const fromAngle = turnAngle((from.a ?? startAngle) - startAngle)
    const toAngle = fromAngle + ((to.a ?? startAngle) - (from.a ?? startAngle))
    const inside = rotaryRegionSlopeContains(
      mask, stock, alongCoordinate(stock, from), fromAngle, alongCoordinate(stock, to), toAngle,
    )
    if (inside !== true) return false
  }
  return true
}
