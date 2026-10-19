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
 * Turning the stock between a block, a round bar and a square blank, and
 * keeping a stock edit and the machine origin in step (#392 slice B, square
 * blank #1016 C2-S2). A bar keeps `profile`/`thickness` as the box it fits in
 * — length × diameter (round) or length × side (square), thickness = the
 * across dimension — so every helper here is expressed in that box.
 *
 * The two bar shapes share the same box convention, so switching between them
 * is a relabel: the axis, the centreline and the length are preserved, even
 * when the bar is shorter than it is wide. Only the block conversion chooses
 * the long side as the length.
 */

import {
  defaultOrigin,
  getStockBounds,
  isRoundStock,
  normalizeRoundStock,
  rectProfile,
  roundStock,
  roundStockCentre,
  type BarStock,
  type BlockStock,
  type Clamp,
  type MachineOrigin,
  type Point,
  type Project,
  type RoundStock,
  type SquareStock,
  type Stock,
  type StockAxis,
} from '../../types/project'
import { nextUniqueGeneratedId } from './ids'
import {
  barCentre,
  isBarStock,
  isSquareStock,
  normalizeSquareStock,
  squareStock,
} from '../../types/barStock'
import {
  defaultRoundWorkholding,
  isRoundWorkholding,
  remintRoundWorkholding,
  roundWorkholdingDiameter,
} from './roundWorkholding'
import { requiredWorkholdingDiameter } from '../../engine/squareRotarySafety'
import { exportGeometryTolerance } from '../../utils/units'

/** A block turned into a bar: the long side becomes the length, the thickness the diameter. */
export function toRoundStock(stock: Stock): RoundStock {
  if (isRoundStock(stock)) return stock
  // A square blank keeps its axis, centreline and length: relabelling the box
  // is the whole change, so a blank shorter than its side does not flip to the
  // other axis or stretch to the long side.
  if (isSquareStock(stock)) return { ...normalizeSquareStock(stock), shape: 'round' }
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

/**
 * A block turned into a square blank: the long side becomes the length, the
 * thickness the side, exactly as {@link toRoundStock} does for a bar. A round
 * bar relabels to a square of the same box, preserving its axis, centreline and
 * length.
 */
export function toSquareStock(stock: Stock): SquareStock {
  if (isSquareStock(stock)) return stock
  if (isRoundStock(stock)) return { ...normalizeRoundStock(stock), shape: 'square' }
  const bounds = getStockBounds(stock)
  const width = bounds.maxX - bounds.minX
  const height = bounds.maxY - bounds.minY
  const axis: StockAxis = width >= height ? 'x' : 'y'
  const at: Point = { x: bounds.minX, y: bounds.minY }
  return {
    ...squareStock(stock.thickness, Math.max(width, height), axis, at),
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

function requirePositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`resizeSquareStock: ${name} must be a positive finite number, got ${value}`)
  }
}

/**
 * A square blank resized or re-aimed, with the same conventions as
 * {@link resizeRoundStock}: a new side keeps the centreline and the length; a
 * new length keeps the centreline and the start end (`minX` for axis `'x'`,
 * `maxY` for `'y'`); a new axis keeps the bounds' min corner, the length and
 * the side. The result is always canonical, so the profile's across width
 * always equals `thickness`. A non-finite or non-positive side/length and an
 * unknown axis are refused with a `RangeError` before anything is built.
 */
export function resizeSquareStock(
  stock: SquareStock,
  change: { side?: number; length?: number; axis?: StockAxis },
): SquareStock {
  if (change.side !== undefined) requirePositiveFinite(change.side, 'side')
  if (change.length !== undefined) requirePositiveFinite(change.length, 'length')
  if (change.axis !== undefined && change.axis !== 'x' && change.axis !== 'y') {
    throw new RangeError(`resizeSquareStock: axis must be 'x' or 'y', got ${String(change.axis)}`)
  }

  const current = normalizeSquareStock(stock)
  const bounds = getStockBounds(current)
  const axis: StockAxis = change.axis ?? current.axis
  const side = change.side ?? current.thickness
  const currentLength = current.axis === 'x'
    ? bounds.maxX - bounds.minX
    : bounds.maxY - bounds.minY
  const length = change.length ?? currentLength

  let at: Point
  if (axis !== current.axis) {
    at = { x: bounds.minX, y: bounds.minY }
  } else if (axis === 'x') {
    at = { x: bounds.minX, y: barCentre(current) - side / 2 }
  } else {
    at = { x: barCentre(current) - side / 2, y: bounds.maxY - length }
  }

  return normalizeSquareStock({
    ...current,
    axis,
    thickness: side,
    profile: axis === 'x'
      ? rectProfile(at.x, at.y, length, side)
      : rectProfile(at.x, at.y, side, length),
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
function newChuck(project: Project, stock: BarStock): Clamp {
  return {
    id: nextUniqueGeneratedId(project, 'cl'),
    name: 'Chuck',
    visible: true,
    ...defaultRoundWorkholding('chuck', stock, project.meta.units),
  }
}

/**
 * The project with its stock switched to a block or either bar shape (#392
 * slice C, square blank #1016 C2-S2). Choosing a bar moves the origin to the
 * bar's default and guarantees exactly one chuck; choosing a block moves the
 * origin the same way and removes every chuck and tailstock, which cannot exist
 * on a block. Switching between the two bar shapes re-mints only a chuck or
 * tailstock that does **not clear** the new bar (#1016 C2 F3b): the same
 * `requiredWorkholdingDiameter` threshold the square safety guard refuses on —
 * the blank's corner envelope, or the round bar's diameter — with the same
 * export tolerance. A support that already clears is kept exactly as it is,
 * with its own diameter, so a 30 mm chuck that holds a 20 mm square's 28.284 mm
 * envelope is not enlarged; ordinary clamps are never touched. Any other clamp
 * is kept on either shape. The same shape returns the same project object.
 */
export function projectWithStockShape(project: Project, shape: 'block' | 'round' | 'square'): Project {
  if (shape === 'round' || shape === 'square') {
    if (shape === 'round' ? isRoundStock(project.stock) : isSquareStock(project.stock)) return project
    const stock = shape === 'round' ? toRoundStock(project.stock) : toSquareStock(project.stock)
    const origin = originForShape(project.origin, stock)
    // Only a switch between the two bar shapes compares an existing support
    // with a previous bar. A block entering a bar shape has no workholding yet,
    // so the add-or-keep path below is unchanged for it.
    const previous = isBarStock(project.stock) ? project.stock : null
    const clamps = previous && previous.shape !== stock.shape
      ? project.clamps.map((clamp) => {
        if (!isRoundWorkholding(clamp)) return clamp
        const existingDiameter = roundWorkholdingDiameter(clamp, previous)
        // Exactly the guard's rule (`squareRotarySafetyRefusal`): a diameter
        // within the export tolerance of the required clearance is clear.
        const required = requiredWorkholdingDiameter(stock)
        const tolerance = exportGeometryTolerance(project.meta.units)
        return existingDiameter < required - tolerance
          ? remintRoundWorkholding(clamp, stock, project.meta.units)
          : clamp
      })
      : project.clamps
    if (clamps.some((clamp) => clamp.type === 'chuck')) {
      return { ...project, stock, origin, clamps }
    }
    return { ...project, stock, origin, clamps: [...clamps, newChuck(project, stock)] }
  }

  if (!isBarStock(project.stock)) return project
  const stock = toBlockStock(project.stock)
  const origin = originForShape(project.origin, stock)
  const clamps = project.clamps.filter((clamp) => !isRoundWorkholding(clamp))
  return { ...project, stock, origin, clamps }
}
