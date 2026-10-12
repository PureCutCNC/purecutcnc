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
 * A chuck and a tailstock on a round bar (#392 slice C). Both are round about
 * the bar's axis, so seen from above each is a rectangle centred on the bar's
 * centreline that looks the same at every index angle. Their height follows
 * from the bar's diameter and their own: the bar's radius plus their own, so
 * the existing clamp check in `engine/toolpaths/clamps.ts` needs no round case.
 */

import {
  getStockBounds,
  isRoundStock,
  roundStockCentre,
  roundStockDiameter,
  roundStockLength,
  type Clamp,
  type Project,
  type ProjectMeta,
  type RoundStock,
} from '../../types/project'
import { convertLength } from '../../utils/units'

/** True for the two round workholding types: a chuck or a tailstock. */
export function isRoundWorkholding(clamp: Clamp): boolean {
  return clamp.type === 'chuck' || clamp.type === 'tailstock'
}

/** The clamp's diameter: its size across the bar's axis (h for axis 'x', w for axis 'y'). */
export function roundWorkholdingDiameter(clamp: Clamp, stock: RoundStock): number {
  return stock.axis === 'x' ? clamp.h : clamp.w
}

/**
 * A chuck or tailstock at its default place and size on this bar. The default
 * body is 40 mm and the diameter the larger of twice the bar's and 50 mm. A
 * chuck grips the bar's start end — 15 mm inside it, never more than a quarter
 * of its length — and reaches the body past the end; a tailstock touches the
 * far end face and reaches the body beyond it. Either way the height is the
 * bar's radius plus its own, and it is centred on the centreline.
 */
export function defaultRoundWorkholding(
  type: 'chuck' | 'tailstock',
  stock: RoundStock,
  units: ProjectMeta['units'],
): Pick<Clamp, 'type' | 'x' | 'y' | 'w' | 'h' | 'height'> {
  const barDiameter = roundStockDiameter(stock)
  const ownDiameter = Math.max(2 * barDiameter, convertLength(50, 'mm', units))
  const body = convertLength(40, 'mm', units)
  const bounds = getStockBounds(stock)
  const centre = roundStockCentre(stock)
  const height = barDiameter / 2 + ownDiameter / 2
  const grip = Math.min(convertLength(15, 'mm', units), roundStockLength(stock) / 4)

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
 * Every chuck and tailstock centred on the bar's centreline with its height
 * derived from the bar's diameter. Its position and size along the axis are
 * never touched, and other clamps never are. A block is left alone. Returns
 * the same project object when nothing needs changing, so a write that does
 * not affect workholding does not churn identity.
 */
export function syncRoundWorkholding(project: Project): Project {
  if (!isRoundStock(project.stock)) return project
  const stock = project.stock
  const centre = roundStockCentre(stock)
  let changed = false

  const clamps = project.clamps.map((clamp) => {
    if (!isRoundWorkholding(clamp)) return clamp
    const ownDiameter = roundWorkholdingDiameter(clamp, stock)
    const across = centre - ownDiameter / 2
    const height = stock.thickness / 2 + ownDiameter / 2
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
