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
 * A chuck and a tailstock on a bar (#392 slice C, square blank #1016 C2-S2).
 * Both are round about the bar's axis, so seen from above each is a rectangle
 * centred on the bar's centreline that looks the same at every index angle.
 * Their height follows from the bar's pivot and their own radius — the bar's
 * half-thickness plus their own — so the existing clamp check in
 * `engine/toolpaths/clamps.ts` needs no bar case.
 *
 * A square blank is not a cylinder: its centreline is still the pivot (Z =
 * side/2) and that is where the workholding stays. Its corners reach further
 * than the pivot, so a *new* square chuck is sized to clear the corner
 * envelope (the circumscribed circle), while an existing chuck keeps whatever
 * diameter the user gave it — the sync never enlarges it.
 */

import {
  getStockBounds,
  roundStockDiameter,
  type BarStock,
  type Clamp,
  type Project,
  type ProjectMeta,
  type Stock,
} from '../../types/project'
import {
  barCentre,
  barLength,
  barMaxRadius,
  barPivotZ,
  isBarStock,
  isSquareStock,
} from '../../types/barStock'
import { convertLength } from '../../utils/units'

/** True for the two round workholding types: a chuck or a tailstock. */
export function isRoundWorkholding(clamp: Clamp): boolean {
  return clamp.type === 'chuck' || clamp.type === 'tailstock'
}

/** The clamp's diameter: its size across the bar's axis (h for axis 'x', w for axis 'y'). */
export function roundWorkholdingDiameter(clamp: Clamp, stock: BarStock): number {
  return stock.axis === 'x' ? clamp.h : clamp.w
}

/**
 * A chuck or tailstock at its default place and size on this bar. The default
 * body is 40 mm and the diameter the larger of twice the bar's and 50 mm — for
 * a square blank, twice the *corner* envelope diameter, so the clamp clears the
 * corners the blank reaches. A chuck grips the bar's start end — 15 mm inside
 * it, never more than a quarter of its length — and reaches the body past the
 * end; a tailstock touches the far end face and reaches the body beyond it.
 * Either way the height is the pivot (`side`/`diameter` over two) plus the
 * clamp's own radius, so it is centred on the centreline at the true pivot, not
 * at the corner radius. A round bar's numbers are unchanged.
 */
export function defaultRoundWorkholding(
  type: 'chuck' | 'tailstock',
  stock: BarStock,
  units: ProjectMeta['units'],
): Pick<Clamp, 'type' | 'x' | 'y' | 'w' | 'h' | 'height'> {
  const ownDiameter = isSquareStock(stock)
    ? Math.max(4 * barMaxRadius(stock), convertLength(50, 'mm', units))
    : Math.max(2 * roundStockDiameter(stock), convertLength(50, 'mm', units))
  const body = convertLength(40, 'mm', units)
  const bounds = getStockBounds(stock)
  const centre = barCentre(stock)
  const height = barPivotZ(stock) + ownDiameter / 2
  const grip = Math.min(convertLength(15, 'mm', units), barLength(stock) / 4)

  // Along the axis: a chuck covers `grip` inside the start end plus the body
  // past it; a tailstock stops at the far end face and adds only the body.
  let alongFrom: number
  let alongSize: number
  if (stock.axis === 'x') {
    alongFrom = type === 'chuck' ? bounds.minX - body : bounds.maxX
    alongSize = type === 'chuck' ? body + grip : body
  } else {
    alongFrom = type === 'chuck' ? bounds.maxY - grip : bounds.minY - body
    alongSize = type === 'chuck' ? body + grip : body
  }

  return stock.axis === 'x'
    ? { type, x: alongFrom, y: centre - ownDiameter / 2, w: alongSize, h: ownDiameter, height }
    : { type, x: centre - ownDiameter / 2, y: alongFrom, w: ownDiameter, h: alongSize, height }
}

/**
 * Re-aiming a bar on the other axis turns its workholding with it (#1016 C2).
 * On an axis change the clamp values are still expressed in the previous axis,
 * so without this a Y write would only re-centre the old X footprint and lose
 * the along position.
 *
 * `defaultRoundWorkholding` treats the start end as `minX` on X and `maxY` on Y
 * — the end a chuck grips from — so the direction the bar runs is +X there and
 * −Y here. A chuck or tailstock keeps its signed distance from that start end,
 * its size along the bar, and its own diameter; the diameter crosses over to
 * the new across dimension (`w` and `h` swap). The existing centring and height
 * rule then applies as usual.
 *
 * Returns `next` unchanged when there is no bar-to-bar axis change, so a
 * same-axis write is byte-identical to before. A block, step, toe or vacuum
 * clamp is never touched.
 */
export function transposeRoundWorkholding(previous: Stock, next: Project): Project {
  const nextStock = next.stock
  if (!isBarStock(previous) || !isBarStock(nextStock) || previous.axis === nextStock.axis) {
    return next
  }
  const fromBounds = getStockBounds(previous)
  const toBounds = getStockBounds(nextStock)
  const fromStart = previous.axis === 'x' ? fromBounds.minX : fromBounds.maxY
  const toStart = nextStock.axis === 'x' ? toBounds.minX : toBounds.maxY
  const centre = barCentre(nextStock)
  let changed = false

  const clamps = next.clamps.map((clamp) => {
    if (!isRoundWorkholding(clamp)) return clamp
    const along = previous.axis === 'x' ? clamp.x : clamp.y
    const alongSize = previous.axis === 'x' ? clamp.w : clamp.h
    const diameter = roundWorkholdingDiameter(clamp, previous)
    // The low edge of the clamp measured from the start end in the direction
    // the bar runs: +X from minX, −Y from maxY.
    const fromStartLow = previous.axis === 'x'
      ? along - fromStart
      : fromStart - (along + alongSize)
    changed = true
    if (nextStock.axis === 'x') {
      return {
        ...clamp,
        x: toStart + fromStartLow,
        w: alongSize,
        y: centre - diameter / 2,
        h: diameter,
      }
    }
    return {
      ...clamp,
      y: toStart - fromStartLow - alongSize,
      h: alongSize,
      x: centre - diameter / 2,
      w: diameter,
    }
  })

  return changed ? { ...next, clamps } : next
}

/**
 * Every chuck and tailstock centred on the bar's centreline with its height
 * derived from the bar's pivot. Its position and size along the axis — and its
 * across diameter, which the user may have set by hand — are never touched, and
 * other clamps never are. On a square blank the centre is the true pivot
 * (`side`/2), not the corner radius; the clamp keeps its own diameter, so
 * nothing is silently enlarged. A block is left alone. Returns the same project
 * object when nothing needs changing, so a write that does not affect
 * workholding does not churn identity.
 */
export function syncRoundWorkholding(project: Project): Project {
  if (!isBarStock(project.stock)) return project
  const stock = project.stock
  const centre = barCentre(stock)
  let changed = false

  const clamps = project.clamps.map((clamp) => {
    if (!isRoundWorkholding(clamp)) return clamp
    const ownDiameter = roundWorkholdingDiameter(clamp, stock)
    const across = centre - ownDiameter / 2
    const height = barPivotZ(stock) + ownDiameter / 2
    if (stock.axis === 'x') {
      if (clamp.y === across && clamp.height === height) return clamp
      changed = true
      return { ...clamp, y: across, height }
    }
    if (clamp.x === across && clamp.height === height) return clamp
    changed = true
    return { ...clamp, x: across, height }
  })

  return changed ? { ...project, clamps } : project
}
