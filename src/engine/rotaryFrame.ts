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
 * The rotary sign convention, frozen (issue #393).
 *
 * A toolpath point `{x, y, z, a}` says: the tool tip is at `(x, y, z)` in the
 * project's frame while the stock is turned to `a` degrees. `stockSpacePoint`
 * says which point of the *unturned* stock is under that tip, and
 * `toolSpacePoint` is its exact inverse.
 *
 * With `c` the bar's centreline across its axis and `h = thickness / 2` its
 * height, a positive angle brings material on the positive side of the bar up
 * under the tool: with the tool straight above the centreline at radius `r`,
 * the stock point is `r·sin a` across and `r·cos a` up. Material is taken
 * positive across the bar's own frame, whichever project axis the bar lies
 * along, so this is the frame the "Around" face (#395) unrolls in and every
 * wrap of a flat toolpath back onto the bar must use it.
 *
 * The frame is a rigid rotation about the bar's true turning pivot, so it is
 * the same map for a round bar and a square blank (#1016 C2-S3): the pivot is
 * the box centre — `barCentre` across and `barPivotZ = thickness / 2` up — and
 * the rotation moves any point with it whatever the blank's cross-section is.
 * A square blank's corners are material at a radius the round bar does not
 * have; they are *not* a different pivot. Nothing here reads the blank's
 * surface, so widening the argument to `BarStock` leaves every round point
 * bit-identical and never moves a square pivot to the corner radius.
 */

import { barCentre, barPivotZ } from '../types/barStock'
import type { BarStock } from '../types/project'
import type { ToolpathPoint } from './toolpaths/types'

/** A point of the unturned stock. */
export interface StockSpacePoint {
  x: number
  y: number
  z: number
}

/**
 * The point of the unturned stock that is under the tool tip at `point`
 * (issue #393).
 *
 * A point with no `a` has no rotary component and is returned unchanged as
 * `{x, y, z}`.
 */
export function stockSpacePoint(point: ToolpathPoint, stock: BarStock): StockSpacePoint {
  if (point.a === undefined) {
    return { x: point.x, y: point.y, z: point.z }
  }
  const centre = barCentre(stock)
  const height = barPivotZ(stock)
  const t = (point.a * Math.PI) / 180
  const cos = Math.cos(t)
  const sin = Math.sin(t)
  if (stock.axis === 'x') {
    const across = point.y - centre
    const up = point.z - height
    return {
      x: point.x,
      y: centre + across * cos + up * sin,
      z: height - across * sin + up * cos,
    }
  }
  const across = point.x - centre
  const up = point.z - height
  return {
    x: centre + across * cos + up * sin,
    y: point.y,
    z: height - across * sin + up * cos,
  }
}

/**
 * Where the tool must be, with the stock turned to `a`, to touch `stockPoint`
 * — the exact inverse of {@link stockSpacePoint}. The returned point always
 * carries `a`.
 */
export function toolSpacePoint(stockPoint: StockSpacePoint, a: number, stock: BarStock): ToolpathPoint {
  const centre = barCentre(stock)
  const height = barPivotZ(stock)
  const t = (a * Math.PI) / 180
  const cos = Math.cos(t)
  const sin = Math.sin(t)
  if (stock.axis === 'x') {
    const across = stockPoint.y - centre
    const up = stockPoint.z - height
    return {
      x: stockPoint.x,
      y: centre + across * cos - up * sin,
      z: height + across * sin + up * cos,
      a,
    }
  }
  const across = stockPoint.x - centre
  const up = stockPoint.z - height
  return {
    x: centre + across * cos - up * sin,
    y: stockPoint.y,
    z: height + across * sin + up * cos,
    a,
  }
}
