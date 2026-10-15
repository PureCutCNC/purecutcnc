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
 * Turning the stock between a block and a round bar, and keeping a stock edit
 * and the machine origin in step (#392 slice B). A round bar keeps
 * `profile`/`thickness` as the box it fits in — length × diameter, thickness =
 * diameter — so every helper here is expressed in that box.
 */

import {
  defaultOrigin,
  getStockBounds,
  isRoundStock,
  normalizeRoundStock,
  rectProfile,
  roundStock,
  roundStockCentre,
  type BlockStock,
  type Clamp,
  type MachineOrigin,
  type Point,
  type Project,
  type RoundStock,
  type Stock,
  type StockAxis,
} from '../../types/project'
import { nextUniqueGeneratedId } from './ids'
import { isBarStock } from '../../types/barStock'
import { defaultRoundWorkholding, isRoundWorkholding } from './roundWorkholding'

/** A block turned into a bar: the long side becomes the length, the thickness the diameter. */
export function toRoundStock(stock: Stock): RoundStock {
  if (isRoundStock(stock)) return stock
  const bounds = getStockBounds(stock)
  const width = bounds.maxX - bounds.minX
  const height = bounds.maxY - bounds.minY
  const axis: StockAxis = width >= height ? 'x' : 'y'
  const at: Point = { x: bounds.minX, y: bounds.minY }
  return {
    ...roundStock(stock.thickness, Math.max(width, height), axis, at),
    material: stock.material,
    color: stock.color,
    visible: stock.visible,
    origin: stock.origin,
  }
}

/** A bar turned back into a block of the same box. */
export function toBlockStock(stock: Stock): BlockStock {
  if (!isBarStock(stock)) return stock
  const bounds = getStockBounds(stock)
  const { shape: _shape, axis: _axis, ...rest } = stock
  return {
    ...rest,
    profile: rectProfile(bounds.minX, bounds.minY, bounds.maxX - bounds.minX, bounds.maxY - bounds.minY),
  }
}

/**
 * A bar resized or re-aimed. A new diameter keeps the centreline and the
 * length; a new length keeps the centreline and the start end (`minX` for
 * axis `'x'`, `maxY` for `'y'`); a new axis keeps the bounds' min corner, the
 * length and the diameter. The result is always canonical.
 */
export function resizeRoundStock(
  stock: RoundStock,
  change: { diameter?: number; length?: number; axis?: StockAxis },
): RoundStock {
  const current = normalizeRoundStock(stock)
  const bounds = getStockBounds(current)
  const axis: StockAxis = change.axis ?? current.axis
  const diameter = change.diameter ?? current.thickness
  const currentLength = current.axis === 'x'
    ? bounds.maxX - bounds.minX
    : bounds.maxY - bounds.minY
  const length = change.length ?? currentLength

  let at: Point
  if (axis !== current.axis) {
    at = { x: bounds.minX, y: bounds.minY }
  } else if (axis === 'x') {
    at = { x: bounds.minX, y: roundStockCentre(current) - diameter / 2 }
  } else {
    at = { x: roundStockCentre(current) - diameter / 2, y: bounds.maxY - length }
  }

  return normalizeRoundStock({
    ...current,
    axis,
    thickness: diameter,
    profile: axis === 'x'
      ? rectProfile(at.x, at.y, length, diameter)
      : rectProfile(at.x, at.y, diameter, length),
  })
}

/**
 * The origin after a stock edit: it follows the stock while it sits on the
 * stock's default origin, and is left alone once the user has moved it.
 */
export function originAfterStockEdit(origin: MachineOrigin, before: Stock, after: Stock): MachineOrigin {
  const previous = defaultOrigin(before)
  if (origin.x !== previous.x || origin.y !== previous.y || origin.z !== previous.z) {
    return origin
  }
  const next = defaultOrigin(after)
  return { ...origin, x: next.x, y: next.y, z: next.z }
}

/** The new stock's default origin, keeping the current origin's name and visibility. */
function originForShape(origin: MachineOrigin, stock: Stock): MachineOrigin {
  return { ...origin, ...defaultOrigin(stock), name: origin.name, visible: origin.visible }
}

/** A clamp row, as `clampsSlice.addClamp` mints one. */
function newChuck(project: Project, stock: RoundStock): Clamp {
  return {
    id: nextUniqueGeneratedId(project, 'cl'),
    name: 'Chuck',
    visible: true,
    ...defaultRoundWorkholding('chuck', stock, project.meta.units),
  }
}

/**
 * The project with its stock switched to a block or a round bar (#392 slice C).
 * Choosing a bar moves the origin to the bar's default and guarantees exactly
 * one chuck; choosing a block moves the origin the same way and removes every
 * chuck and tailstock, which cannot exist on a block. Any other clamp is kept
 * on either shape. The same shape returns the same project object.
 */
export function projectWithStockShape(project: Project, shape: 'block' | 'round'): Project {
  if (shape === 'round') {
    if (isRoundStock(project.stock)) return project
    const stock = toRoundStock(project.stock)
    const origin = originForShape(project.origin, stock)
    if (project.clamps.some((clamp) => clamp.type === 'chuck')) {
      return { ...project, stock, origin }
    }
    return { ...project, stock, origin, clamps: [...project.clamps, newChuck(project, stock)] }
  }

  if (!isRoundStock(project.stock)) return project
  const stock = toBlockStock(project.stock)
  const origin = originForShape(project.origin, stock)
  const clamps = project.clamps.filter((clamp) => !isRoundWorkholding(clamp))
  return { ...project, stock, origin, clamps }
}
