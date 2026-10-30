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
  type ChuckData,
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
 * BISON 3204 hard solid jaws, external gripping with the OD jaw set. The range
 * is the jaw set's *full* external one — `d1` (the first step) is the minimum,
 * `d3` (the larger step) the maximum. Taking `d1` as the maximum made a 4"
 * claim 1.30" of capacity and pushed a Ø40 mm bar up to the 5" body (issue
 * #1112 rt3-e item 28).
 *
 * Body A and body length B: https://www.bison-america.com/pdf/Chapter_1/1_9.pdf p9.
 * d1..d3 capacities, inch table p142:
 * https://www.bison-america.com/pdf/Chapter_1/Specs_1_1.pdf
 * metric table p132:
 * https://store.bison-chuck.com/uk/en/amfile/file/download/file/1272/product/3115/
 *
 * The inch and the metric range are both **as published**, in their own
 * columns: the catalogue rounds the two independently (2.80 in / 71 mm), so
 * neither is derived from the other. `minIn`/`maxIn` are the inch column;
 * `minMm`/`maxMm` are the metric one, and are what a project's
 * `clampingRangeMm` stores. Judging a bar by one column while the warning
 * judged the other made a 6.30" bar take the 6" preset and immediately report
 * out of range (160.02 mm past the metric 160 mm — Codex review of #1112
 * rt3-e). So a listed size holds a bar when *either* published column holds it:
 * `presetHoldsBar` is that one rule, used by the defaults and by
 * `chuckOutOfRange` whenever the stored capacity is still a preset's published
 * one. The 10"/12" rows are the exception: the d3 step was not published for
 * them in the handed-over table, so they still carry the `d1` maximum, with the
 * metric value derived from it.
 *
 * Four jaws use the same ranges: BISON 3604 self-centering 4-jaw publishes
 * identical ranges at 5-8", while the 3"/4" 4-jaw ranges are not published
 * reliably, so those two sizes use the 3-jaw values (manager's decision,
 * 2026-10-29).
 *
 * These are starter equipment presets, not a claim that other jaw sets share
 * this capacity.
 *
 * The label is the size alone — `4"`, not `BISON 3204 · 4"` (issue #1112 R2
 * item 13): the picked field is a *size*, and the catalogue entry behind it
 * stays in this table (the ids and the two source links above), not in the
 * picker's text.
 */
export const STANDARD_CHUCKS = [
  { id: 'bison-3204-3', label: '3"', diameterIn: 3.15, bodyIn: 1.73, minIn: 0.08, maxIn: 2.8, minMm: 2, maxMm: 71 },
  { id: 'bison-3204-4', label: '4"', diameterIn: 3.94, bodyIn: 1.97, minIn: 0.12, maxIn: 3.66, minMm: 3, maxMm: 93 },
  { id: 'bison-3204-5', label: '5"', diameterIn: 4.92, bodyIn: 2.2, minIn: 0.12, maxIn: 4.92, minMm: 3, maxMm: 125 },
  { id: 'bison-3204-6', label: '6"', diameterIn: 6.3, bodyIn: 2.54, minIn: 0.12, maxIn: 6.3, minMm: 3, maxMm: 160 },
  { id: 'bison-3204-8', label: '8"', diameterIn: 7.87, bodyIn: 2.95, minIn: 0.16, maxIn: 7.87, minMm: 4, maxMm: 200 },
  { id: 'bison-3204-10', label: '10"', diameterIn: 9.84, bodyIn: 3.35, minIn: 0.2, maxIn: 4.6, minMm: 5.08, maxMm: 116.84 },
  { id: 'bison-3204-12', label: '12"', diameterIn: 12.4, bodyIn: 3.7, minIn: 0.4, maxIn: 5.2, minMm: 10.16, maxMm: 132.08 },
] as const

/** One listed chuck: its catalogue id, its size label and its published dimensions. */
export type ChuckPreset = (typeof STANDARD_CHUCKS)[number]

/**
 * Numeric slack for comparing a bar against the catalogue's rounded columns.
 * The two columns describe the same capacity in different units, but 6.30 in is
 * 160.01999999999998 mm in IEEE arithmetic, so an exact `<=` would reject the
 * equivalent value typed in the other unit — the same published boundary the
 * review found disagreeing.
 */
const RANGE_EPSILON = 1e-9

/**
 * Whether a listed size's published capacity holds a bar of `gripDiameter`.
 *
 * The catalogue prints one capacity in two independently rounded columns, so a
 * bar can sit inside one and just outside the other. Either column holding it
 * means the jaw set grips it — the same rule for picking a default and for the
 * out-of-range warning, so equipment a default picks is never immediately
 * reported past its capacity (Codex review of #1112 rt3-e: 6.30 in is the inch
 * column's maximum, and 160.02 mm is past the metric column's 160 mm).
 */
export function presetHoldsBar(
  size: ChuckPreset,
  gripDiameter: number,
  units: ProjectMeta['units'],
): boolean {
  const diameterIn = convertLength(gripDiameter, units, 'inch')
  const diameterMm = convertLength(gripDiameter, units, 'mm')
  return (diameterIn >= size.minIn - RANGE_EPSILON && diameterIn <= size.maxIn + RANGE_EPSILON)
    || (diameterMm >= size.minMm - RANGE_EPSILON && diameterMm <= size.maxMm + RANGE_EPSILON)
}

/**
 * The preset a new chuck takes whenever the bar fits it (#1112 R2 item 23):
 * Frank's 4 inch starter, a 100 mm body. A bar outside its capacity falls back
 * to the smallest preset whose range holds it.
 */
export const DEFAULT_CHUCK_ID = 'bison-3204-4'

/**
 * The jaw count a bar shape starts from: four for a square blank, whose four
 * jaws grip across flats, and three for a round bar.
 */
export function defaultJawCount(stock: BarStock): 3 | 4 {
  return isSquareStock(stock) ? 4 : 3
}

/** Square capacity is across flats for four jaws, the corner circle otherwise. */
export function chuckGripDiameter(stock: BarStock, jaws: 3 | 4 | 6): number {
  return isSquareStock(stock) && jaws === 4 ? stock.thickness : 2 * barMaxRadius(stock)
}

/**
 * The smallest listed size whose published capacity holds `stock`, skipping
 * sizes the caller's `accept` filter rejects (the square blank's corner
 * clearance, when called from `defaultChuckSize`).
 *
 * A candidate must also have a body wider than the bar it grips: the
 * catalogue's metric maximum can exceed the body by its independent rounding
 * (125 mm against a 4.92 in / 124.97 mm body), and a body narrower than the
 * stock would sit inside the material. Every inch maximum is at or inside its
 * body, so this only rules out that metric-column rounding fringe.
 */
export function smallestFittingChuck(
  stock: BarStock,
  units: ProjectMeta['units'],
  jaws: 3 | 4 | 6 = 3,
  accept: (size: ChuckPreset) => boolean = () => true,
): ChuckPreset | null {
  const gripDiameter = chuckGripDiameter(stock, jaws)
  const diameterIn = convertLength(gripDiameter, units, 'inch')
  const fitting = STANDARD_CHUCKS.find((size) => accept(size)
    && presetHoldsBar(size, gripDiameter, units)
    && size.diameterIn >= diameterIn - RANGE_EPSILON)
  if (fitting) return fitting
  // Outside every listed jaw range: the nearest end preset, so the panel can
  // say the bar is out of its capacity — but only while that preset's own
  // *body* still reaches past the bar and the caller accepts it. A body
  // narrower than the stock it grips would sit inside the material; on a square
  // blank the corner guard then refuses the whole setup, so the default must
  // never be that. Such a bar gets the stock-derived body instead: no preset is
  // claimed, and the caller still reports it past the largest listed capacity.
  const nearest = diameterIn < STANDARD_CHUCKS[0].minIn
    ? STANDARD_CHUCKS[0]
    : STANDARD_CHUCKS[STANDARD_CHUCKS.length - 1]
  return accept(nearest) && nearest.diameterIn >= diameterIn - RANGE_EPSILON ? nearest : null
}

/**
 * The size a new chuck on `stock` takes (#1112 R2 item 23): the 4 inch preset
 * unless the bar is outside its capacity, in which case the smallest preset
 * whose range holds the bar. `jaws` decides which grip diameter the capacity is
 * measured against — the matching rule of `chuckGripDiameter` — so a square
 * blank held in four jaws is judged across flats, not by its corner circle.
 *
 * A square blank's corners reach further than its flats, so a candidate body
 * must also clear the corner envelope: a body narrower than the corners would
 * sit inside the material, and the square guard refuses that setup outright.
 * That is a filter on the search, not a verdict on the first candidate — the
 * next listed range may still hold the flats with a body that clears them (a
 * 75 mm blank: the 4 inch holds its flats but not its 100.1 mm corner
 * envelope, while the 5 inch holds both). Null only when no listed preset can
 * do both; the stock-derived fallback and its warning then stand.
 */
export function defaultChuckSize(
  stock: BarStock,
  units: ProjectMeta['units'],
  jaws: 3 | 4 | 6 = defaultJawCount(stock),
): ChuckPreset | null {
  const gripDiameter = chuckGripDiameter(stock, jaws)
  const diameterIn = convertLength(gripDiameter, units, 'inch')
  const clearsCorners = (size: ChuckPreset): boolean =>
    !isSquareStock(stock)
    || convertLength(size.diameterIn, 'inch', units) >= 2 * barMaxRadius(stock) - RANGE_EPSILON
  const preferred = STANDARD_CHUCKS.find((size) => size.id === DEFAULT_CHUCK_ID)
  if (preferred && presetHoldsBar(preferred, gripDiameter, units)
    && preferred.diameterIn >= diameterIn - RANGE_EPSILON && clearsCorners(preferred)) {
    return preferred
  }
  // Continue past a body the blank's corners reject: the next listed range may
  // still hold the bar with a body that clears them.
  return smallestFittingChuck(stock, units, jaws, clearsCorners)
}

export function chuckOutOfRange(clamp: Clamp, stock: Stock, units: ProjectMeta['units']): boolean {
  const data = clamp.chuck
  if (clamp.type !== 'chuck' || !isBarStock(stock) || !data?.clampingRangeMm) return false
  const gripDiameter = chuckGripDiameter(stock, data.jawCount ?? 3)
  const range = data.clampingRangeMm
  // Listed equipment still carrying its published capacity is judged by the
  // same rule the default used, so no column's rounding can warn against the
  // size the pick itself accepted. A capacity the operator typed — or one a
  // saved project kept from an older build — keeps its own strict limits.
  const listed = STANDARD_CHUCKS.find((size) => size.id === data.size)
  if (listed && range.min === listed.minMm && range.max === listed.maxMm) {
    return !presetHoldsBar(listed, gripDiameter, units)
  }
  const diameter = convertLength(gripDiameter, units, 'mm')
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
 *
 * The jaw count starts from the bar shape's default (#1112 R2 item 23), unless
 * the caller carries one through. `manual` records that the operator chose this
 * chuck, so a later stock change leaves its equipment alone; a default minted
 * here is left without it.
 */
export function chuckSizePatch(
  sizeId: string,
  stock: BarStock,
  units: ProjectMeta['units'],
  options: { jawCount?: 3 | 4 | 6; manual?: boolean } = {},
): ChuckSizePatch {
  const size = STANDARD_CHUCKS.find((entry) => entry.id === sizeId)
  if (!size) throw new RangeError('Unknown standard chuck size')
  const diameter = convertLength(size.diameterIn, 'inch', units)
  const body = convertLength(size.bodyIn, 'inch', units)
  return {
    ...chuckPlacement(stock, units, diameter, body),
    chuck: {
      size: size.id,
      // The catalogue's own metric range, not the inch range converted.
      clampingRangeMm: { min: size.minMm, max: size.maxMm },
      jawCount: options.jawCount ?? defaultJawCount(stock),
      ...(options.manual ? { manual: true } : {}),
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
 * New chucks take the 4 inch starter, or the smallest fitting BISON preset when
 * the bar is outside it (#1112 R2 item 23); a bar no preset's *body* can reach
 * (see `smallestFittingChuck`) and every tailstock keep the stock-derived
 * default. A stock-derived chuck carries the largest listed capacity without
 * claiming its size, so such a bar is still reported out of range. The grip is
 * 15 mm, at most a quarter of the bar length. Existing fixtures never pass
 * through this creation helper on load.
 */
export function defaultRoundWorkholding(
  type: 'chuck' | 'tailstock',
  stock: BarStock,
  units: ProjectMeta['units'],
): Pick<Clamp, 'type' | 'x' | 'y' | 'w' | 'h' | 'height' | 'chuck'> {
  const size = type === 'chuck' ? defaultChuckSize(stock, units) : null
  // A chuck and a size pick share one envelope: the published body past the
  // start end plus its grip inside it.
  if (size) return { ...chuckSizePatch(size.id, stock, units), type }

  // No listed equipment is claimed for a bar no listed body can reach, so the
  // stock-derived body below stands in for it. It still carries the largest
  // listed capacity, which the bar is inevitably outside of: without that
  // metadata `chuckOutOfRange` has nothing to compare, the tree/properties
  // warning vanishes, and decision 9 ("no standard range holds the bar → warn")
  // silently stops holding for exactly the bars that need it most.
  const largest = STANDARD_CHUCKS[STANDARD_CHUCKS.length - 1]
  const capacity: Pick<Clamp, 'chuck'> = type === 'chuck'
    ? {
      chuck: {
        clampingRangeMm: { min: largest.minMm, max: largest.maxMm },
        jawCount: defaultJawCount(stock),
      },
    }
    : {}

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
  const alongFrom = stock.axis === 'x'
    ? (type === 'chuck' ? bounds.minX - body : bounds.maxX)
    : (type === 'chuck' ? bounds.maxY - grip : bounds.minY - body)
  const alongSize = type === 'chuck' ? body + grip : body

  return stock.axis === 'x'
    ? { ...capacity, type, x: alongFrom, y: centre - ownDiameter / 2, w: alongSize, h: ownDiameter, height }
    : { ...capacity, type, x: centre - ownDiameter / 2, y: alongFrom, w: ownDiameter, h: alongSize, height }
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

/**
 * A hand-set jaw count that the previous shape's default cannot explain is
 * taken as the operator's choice. This is the pre-flag reading (#1112 R2 item
 * 23): a file saved before `ChuckData.manual` existed records no hand edit, so
 * a square blank's 3-jaw chuck — a sibling build's pick, not the 4-jaw default
 * — must keep its jaws rather than be re-defaulted. Every chuck this build
 * mints matches its shape's default, so the test stays quiet for them.
 */
function jawsChosenByHand(previous: BarStock, data: ChuckData): boolean {
  return data.jawCount !== undefined && data.jawCount !== defaultJawCount(previous)
}

/**
 * Keeps a *default* chuck in step with the bar it holds (#1112 R2 item 23): the
 * 4 inch starter — or the smallest preset whose range fits — and the bar
 * shape's jaw count (four on a square blank's flats, three on a round bar).
 * It runs on a stock *transition* only, never on load, so a saved project keeps
 * the jaw count it stored.
 *
 * A chuck the operator described by hand (`ChuckData.manual`: a size pick, a
 * jaw count, a typed capacity or a dragged body) is never touched, and neither
 * is a legacy clamp with no chuck data — the 3.3 rule that missing equipment is
 * never inferred. Nor is a tailstock. When no listed preset holds the new bar,
 * today's behaviour stands: the clamp is left as it is and reported out of
 * range rather than silently replaced by a body that cannot reach the stock.
 * Returns the same project object when no chuck follows.
 */
export function followBarChuck(previous: Stock, next: Project): Project {
  const stock = next.stock
  if (!isBarStock(stock) || !isBarStock(previous)) return next
  const shapeChanged = previous.shape !== stock.shape
  const sizeChanged = previous.thickness !== stock.thickness
  if (!shapeChanged && !sizeChanged) return next
  const units = next.meta.units
  let changed = false

  const clamps = next.clamps.map((clamp) => {
    if (clamp.type !== 'chuck' || !clamp.chuck) return clamp
    const data = clamp.chuck
    const byHand = data.manual === true || jawsChosenByHand(previous, data)
    const jaws = shapeChanged && !byHand ? defaultJawCount(stock) : data.jawCount
    const size = defaultChuckSize(stock, units, jaws ?? defaultJawCount(stock))
    if (!byHand && size && size.id !== data.size) {
      changed = true
      // New equipment: its published body replaces the old one, so the whole
      // default envelope is rebuilt. The jaws it already had are carried over;
      // a chuck that never recorded any takes the shape's default, which is the
      // jaw count its capacity was just measured against.
      return { ...clamp, ...chuckSizePatch(size.id, stock, units, { jawCount: jaws ?? defaultJawCount(stock) }) }
    }
    if (jaws !== undefined && jaws !== data.jawCount) {
      changed = true
      return { ...clamp, chuck: { ...data, jawCount: jaws } }
    }
    return clamp
  })

  return changed ? { ...next, clamps } : next
}
