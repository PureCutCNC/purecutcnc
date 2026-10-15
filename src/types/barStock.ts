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
 * Bar stock (#1016 C2-S1): the shape-agnostic geometry shared by a round bar
 * and a square blank, plus the square blank itself.
 *
 * A bar is described by the box it fits in — `profile` is the rectangle it
 * shows from above with the length along `axis`, and `thickness` is the
 * diameter (round) or the side (square). `barInscribedRadius` is the largest
 * cylinder the blank guarantees at every angle; `barMaxRadius` is the largest
 * radius it reaches at any angle (a square's corner). `barSurfaceRadius` is
 * the **ray** distance from the centreline to the surface at one angle: it is
 * raw blank geometry, **not** a cutter envelope or a tool-support height — a
 * finite cutter spans a tilted face, so a conservative toolpath envelope must
 * be derived elsewhere.
 *
 * The existing round helpers (`isRoundStock`, `normalizeRoundStock`,
 * `roundStockCentre`, …) stay exactly as they are; this module adds the square
 * case beside them and never redefines the round one.
 */

import {
  getStockBounds,
  normalizeRoundStock,
  rectProfile,
  type BarStock,
  type Point,
  type RoundStock,
  type SquareStock,
  type Stock,
  type StockAxis,
} from './project'

/** True for a square blank, false for every other stock shape. */
export function isSquareStock(stock: Stock): stock is SquareStock {
  return stock.shape === 'square'
}

/** True for either bar shape — round or square — and false for a block. */
export function isBarStock(stock: Stock): stock is BarStock {
  return stock.shape === 'round' || stock.shape === 'square'
}

function requirePositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`squareStock: ${name} must be a positive finite number, got ${value}`)
  }
}

function requireAxis(axis: StockAxis): void {
  if (axis !== 'x' && axis !== 'y') {
    throw new RangeError(`squareStock: axis must be 'x' or 'y', got ${String(axis)}`)
  }
}

function requireFinitePoint(at: Point): void {
  if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) {
    throw new RangeError(`squareStock: at must be finite, got (${at.x}, ${at.y})`)
  }
}

/**
 * A square blank of `side` and `length` lying along `axis`. `at` is the min
 * corner of the rectangle the blank shows from above; axis `'x'` puts the
 * length along X, axis `'y'` puts it along Y. `thickness` is the physical
 * side, so the box is `length × side` for axis `'x'` and `side × length` for
 * axis `'y'`. The defaults match {@link roundStock}: aluminium, the default
 * stock colour, visible, with the stock origin point at the drawing origin.
 *
 * `side` and `length` must be positive finite numbers, `axis` must be `'x'`
 * or `'y'`, and `at` must be finite; anything else throws a `RangeError`
 * before an object is built.
 */
export function squareStock(
  side: number,
  length: number,
  axis: StockAxis = 'x',
  at: Point = { x: 0, y: 0 },
): SquareStock {
  requirePositiveFinite(side, 'side')
  requirePositiveFinite(length, 'length')
  requireAxis(axis)
  requireFinitePoint(at)
  return {
    shape: 'square',
    axis,
    profile: axis === 'x'
      ? rectProfile(at.x, at.y, length, side)
      : rectProfile(at.x, at.y, side, length),
    thickness: side,
    material: 'aluminum_6061',
    color: '#b9a83c', // theme-exempt: default stock colour is project data, not UI chrome
    visible: true,
    origin: { x: 0, y: 0 },
  }
}

/**
 * The canonical square blank: a plain rectangle along `axis` that keeps the
 * current bounds' min/max, centred across `axis` on the existing centreline
 * and exactly `thickness` wide. Drops the feature source — a blank cannot be
 * derived from a feature — and maps an unknown axis to `'x'`. Idempotent.
 *
 * The repair is the round normalizer's, run on a throwaway round copy of the
 * same fields and then relabelled `'square'`, so the two shapes stay in step
 * without redefining the round helper.
 */
export function normalizeSquareStock(stock: SquareStock): SquareStock {
  const asRound: RoundStock = { ...stock, shape: 'round' }
  return { ...normalizeRoundStock(asRound), shape: 'square' }
}

/** The centreline's coordinate across the bar: a Y value for axis `'x'`, an X value for axis `'y'`. */
export function barCentre(stock: BarStock): number {
  const bounds = getStockBounds(stock)
  return stock.axis === 'x' ? (bounds.minY + bounds.maxY) / 2 : (bounds.minX + bounds.maxX) / 2
}

/** The bar's length: its extent along {@link BarStock.axis}. */
export function barLength(stock: BarStock): number {
  const bounds = getStockBounds(stock)
  return stock.axis === 'x' ? bounds.maxX - bounds.minX : bounds.maxY - bounds.minY
}

/** The Z of the turning axis: mid-thickness, the same for a round bar and a square blank. */
export function barPivotZ(stock: BarStock): number {
  return stock.thickness / 2
}

/**
 * The largest radius the blank guarantees at **every** angle: the inscribed
 * circle. Half the diameter for a round bar, half the side for a square one.
 */
export function barInscribedRadius(stock: BarStock): number {
  return stock.thickness / 2
}

/**
 * The largest radius the blank reaches at **any** angle: half the diameter for
 * a round bar, the corner radius `side × √½` for a square one.
 */
export function barMaxRadius(stock: BarStock): number {
  return isSquareStock(stock) ? stock.thickness * Math.SQRT1_2 : stock.thickness / 2
}

/**
 * The distance from the centreline to the blank's surface along the radial
 * **ray** at `angleDeg`, in **degrees**. Constant `thickness / 2` for a round
 * bar; for a square blank the ray crosses a flat, so it is
 * `halfSide / max(|cos|, |sin|)` — half the side on a flat (0°, 90°, …) and
 * `side × √½` at a corner (45°, …). Multi-turn and negative angles are
 * wrapped modulo 360 first. A non-finite angle throws a `RangeError`.
 *
 * This is raw blank geometry, not a cutter envelope: a finite cutter spans a
 * tilted flat and reaches material the ray does not, so no caller may treat
 * this as a tool-support or safe-height function.
 */
export function barSurfaceRadius(stock: BarStock, angleDeg: number): number {
  if (!Number.isFinite(angleDeg)) {
    throw new RangeError(`barSurfaceRadius: angleDeg must be a finite number of degrees, got ${angleDeg}`)
  }
  if (!isSquareStock(stock)) return stock.thickness / 2
  const radians = ((angleDeg % 360) * Math.PI) / 180
  const halfSide = stock.thickness / 2
  return halfSide / Math.max(Math.abs(Math.cos(radians)), Math.abs(Math.sin(radians)))
}
