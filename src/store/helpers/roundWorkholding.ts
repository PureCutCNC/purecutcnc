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

/**
 * BISON 3204 hard solid jaws, d1 (external gripping with the first jaw step).
 * Body A and body length B: https://www.bison-america.com/pdf/Chapter_1/1_9.pdf p9.
 * d1 capacities: https://www.bison-america.com/pdf/Chapter_1/Specs_1_1.pdf p142.
 * Values below are the published INCH dimensions, converted without rounding.
 * These are starter equipment presets, not a claim that other jaw sets share
 * this capacity. In particular we do not merge the distinct d2/d3 jaw steps.
 */
export const STANDARD_CHUCKS = [
  { id: 'bison-3204-3', label: 'BISON 3204 · 3"', diameterIn: 3.15, bodyIn: 1.73, minIn: 0.08, maxIn: 1.06 },
  { id: 'bison-3204-4', label: 'BISON 3204 · 4"', diameterIn: 3.94, bodyIn: 1.97, minIn: 0.12, maxIn: 1.3 },
  { id: 'bison-3204-5', label: 'BISON 3204 · 5"', diameterIn: 4.92, bodyIn: 2.2, minIn: 0.12, maxIn: 1.97 },
  { id: 'bison-3204-6', label: 'BISON 3204 · 6"', diameterIn: 6.3, bodyIn: 2.54, minIn: 0.12, maxIn: 2.52 },
  { id: 'bison-3204-8', label: 'BISON 3204 · 8"', diameterIn: 7.87, bodyIn: 2.95, minIn: 0.16, maxIn: 3.54 },
  { id: 'bison-3204-10', label: 'BISON 3204 · 10"', diameterIn: 9.84, bodyIn: 3.35, minIn: 0.2, maxIn: 4.6 },
  { id: 'bison-3204-12', label: 'BISON 3204 · 12"', diameterIn: 12.4, bodyIn: 3.7, minIn: 0.4, maxIn: 5.2 },
] as const

/** Square capacity is across flats for four jaws, the corner circle otherwise. */
export function chuckGripDiameter(stock: BarStock, jaws: 3 | 4 | 6): number {
  return isSquareStock(stock) && jaws === 4 ? stock.thickness : 2 * barMaxRadius(stock)
}

export function smallestFittingChuck(stock: BarStock, units: ProjectMeta['units']) {
  const diameterIn = convertLength(chuckGripDiameter(stock, 3), units, 'inch')
  // Outside every listed range: use the nearest end preset and warn.
  return STANDARD_CHUCKS.find((size) => diameterIn >= size.minIn && diameterIn <= size.maxIn)
    ?? (diameterIn < STANDARD_CHUCKS[0].minIn ? STANDARD_CHUCKS[0] : STANDARD_CHUCKS[STANDARD_CHUCKS.length - 1])
}

export function chuckOutOfRange(clamp: Clamp, stock: Stock, units: ProjectMeta['units']): boolean {
  if (clamp.type !== 'chuck' || !isBarStock(stock) || !clamp.chuck?.clampingRangeMm) return false
  const diameter = convertLength(chuckGripDiameter(stock, clamp.chuck.jawCount ?? 3), units, 'mm')
  const range = clamp.chuck.clampingRangeMm
  return diameter < range.min || diameter > range.max
}

/** The axial grip into the bar: 15 mm, at most a quarter of its length. */
function chuckGrip(stock: BarStock, units: ProjectMeta['units']): number {
  return Math.min(convertLength(15, 'mm', units), barLength(stock) / 4)
}

/**
 * Where a chuck body of `body` length and `diameter` sits: past the bar's start
 * end by its body, gripping `grip` into the bar, centred across the bar and as
 * tall as the pivot plus its own radius. This is the envelope the defaults, a
 * size pick and therefore Around, 3D and collision all share.
 */
function chuckPlacement(
  stock: BarStock,
  units: ProjectMeta['units'],
  diameter: number,
  body: number,
): Pick<Clamp, 'x' | 'y' | 'w' | 'h' | 'height'> {
  const bounds = getStockBounds(stock)
  const centre = barCentre(stock)
  const grip = chuckGrip(stock, units)
  const along = body + grip
  return {
    ...(stock.axis === 'x'
      ? { x: bounds.minX - body, y: centre - diameter / 2, w: along, h: diameter }
      : { y: bounds.maxY - grip, x: centre - diameter / 2, h: along, w: diameter }),
    height: barPivotZ(stock) + diameter / 2,
  }
}

/** The fields a standard-size pick replaces: the published body envelope and its chuck data. */
export type ChuckSizePatch = Pick<Clamp, 'x' | 'y' | 'w' | 'h' | 'height' | 'chuck'>

/**
 * The user explicitly picks equipment. The size sets not only the diameter but
 * its published axial body length, and re-places the chuck against the bar end
 * so the whole envelope is real — the old length was the old chuck's. Existing
 * chucks keep their dimensions until a size is picked (format rule).
 */
export function chuckSizePatch(sizeId: string, stock: BarStock, units: ProjectMeta['units']): ChuckSizePatch {
  const size = STANDARD_CHUCKS.find((entry) => entry.id === sizeId)
  if (!size) throw new RangeError('Unknown standard chuck size')
  const diameter = convertLength(size.diameterIn, 'inch', units)
  const body = convertLength(size.bodyIn, 'inch', units)
  return {
    ...chuckPlacement(stock, units, diameter, body),
    chuck: {
      size: size.id,
      clampingRangeMm: { min: convertLength(size.minIn, 'inch', 'mm'), max: convertLength(size.maxIn, 'inch', 'mm') },
      jawCount: 3,
    },
  }
}

/** The two round workholding types: a chuck or a tailstock. */
export type RoundWorkholding = Clamp & { type: 'chuck' | 'tailstock' }

/** True for the two round workholding types: a chuck or a tailstock. */
export function isRoundWorkholding(clamp: Clamp): clamp is RoundWorkholding {
  return clamp.type === 'chuck' || clamp.type === 'tailstock'
}

/** The clamp's diameter: its size across the bar's axis (h for axis 'x', w for axis 'y'). */
export function roundWorkholdingDiameter(clamp: Clamp, stock: BarStock): number {
  return stock.axis === 'x' ? clamp.h : clamp.w
}

/**
 * New chucks take the smallest fitting BISON preset; tailstocks retain their
 * existing stock-derived default. The grip is 15 mm, at most a quarter of the
 * bar length. Existing fixtures never pass through this creation helper on load.
 */
export function defaultRoundWorkholding(
  type: 'chuck' | 'tailstock',
  stock: BarStock,
  units: ProjectMeta['units'],
): Pick<Clamp, 'type' | 'x' | 'y' | 'w' | 'h' | 'height' | 'chuck'> {
  const size = type === 'chuck' ? smallestFittingChuck(stock, units) : null
  // A chuck and a size pick share one envelope: the published body past the
  // start end plus its grip inside it.
  if (size) return { ...chuckSizePatch(size.id, stock, units), type }

  const ownDiameter = isSquareStock(stock)
    ? Math.max(4 * barMaxRadius(stock), convertLength(50, 'mm', units))
    : Math.max(2 * roundStockDiameter(stock), convertLength(50, 'mm', units))
  // A tailstock stops at the far end face and adds only the body.
  const body = convertLength(40, 'mm', units)
  const bounds = getStockBounds(stock)
  const centre = barCentre(stock)
  const height = barPivotZ(stock) + ownDiameter / 2
  return stock.axis === 'x'
    ? { type, x: bounds.maxX, y: centre - ownDiameter / 2, w: body, h: ownDiameter, height }
    : { type, x: centre - ownDiameter / 2, y: bounds.minY - body, w: ownDiameter, h: body, height }
}

/**
 * A chuck or tailstock re-minted for a different bar shape (#1016 C2 F3): its
 * across size and height become the new bar's default, so it clears the new
 * blank's corners, while its identity (`id`, `name`, `visibility`) and its
 * along-bar placement survive. The along position and size are the ones the
 * user placed; they are kept when they are finite and positive, and otherwise
 * the default along placement is the only usable one. The caller decides
 * *whether* a clamp needs re-minting (only one that no longer clears the new
 * bar); this function always builds the default body.
 */
export function remintRoundWorkholding(
  clamp: RoundWorkholding,
  stock: BarStock,
  units: ProjectMeta['units'],
): Clamp {
  const defaults = defaultRoundWorkholding(clamp.type, stock, units)
  const along = stock.axis === 'x'
    ? { start: clamp.x, size: clamp.w }
    : { start: clamp.y, size: clamp.h }
  const keepAlong = Number.isFinite(along.start) && Number.isFinite(along.size) && along.size > 0
  return {
    ...clamp,
    type: defaults.type,
    ...(stock.axis === 'x'
      ? {
        x: keepAlong ? along.start : defaults.x,
        w: keepAlong ? along.size : defaults.w,
        y: defaults.y,
        h: defaults.h,
      }
      : {
        y: keepAlong ? along.start : defaults.y,
        h: keepAlong ? along.size : defaults.h,
        x: defaults.x,
        w: defaults.w,
      }),
    height: defaults.height,
  }
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
