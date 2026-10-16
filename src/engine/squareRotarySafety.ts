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
 * The physical-setup guard for a **square** blank on the rotary axis (#1016
 * C2-S4). One pure verdict, asked by generation (`setupTargets.ts`, before any
 * motion exists) and by output (`motionPipeline.ts`, before any motion is
 * posted), so the two can never disagree about whether the setup is supported.
 *
 * A square blank is not a cylinder: its corners reach `side × √½` from the
 * pivot, so a chuck or tailstock whose outer diameter is smaller than the
 * corner envelope cannot hold it — the corners pass through the jaws as the
 * blank turns. The S2 store slice deliberately preserves a manually sized
 * chuck, so this guard is where such a clamp is reported and refused; it never
 * resizes the clamp and never moves the pivot (Frank's C2-S2 contract,
 * 2026-10-15).
 *
 * `roundWorkholdingDiameter` is the clamp's **outer** diameter, not a bore or
 * a capacity: the check is a *supported-setup envelope criterion*, not a proof
 * that the jaws intersect the blank at a particular angle. That distinction is
 * deliberate — a diameter that clears `2 × barMaxRadius` about the true pivot
 * is the smallest claim this module makes.
 *
 * Ordinary clamps (step, toe, vacuum, vise) are not workholding a turning job
 * holds the bar with, and rotary generation bypasses `applyClampWarnings`
 * entirely. So the same guard asks whether any ordinary clamp reaches into the
 * region the blank sweeps as it turns, grown by the cutter's own body and the
 * project's XY clamp clearance. That region is the **circumscribed cylinder**
 * of the corner envelope — the blank's cross-section is entirely inside it at
 * every angle — so it is conservative for the blank, and it is not a general
 * 4-axis collision model. A clamp provably outside it (across the bar, or past
 * the blank's ends) passes.
 *
 * Visibility is never consulted: a hidden chuck still holds the bar, and
 * `rotaryAlongRange` already ignores `visible` for the same reason.
 *
 * Everything here fails closed. A NaN, a non-finite or non-positive clamp
 * dimension, a clamp off the true centreline, or a height not derived from the
 * pivot is refused rather than repaired — the stored placement is what the
 * machine would actually be set up with.
 */

import {
  barCentre,
  barMaxRadius,
  barPivotZ,
  isSquareStock,
} from '../types/barStock'
import { getStockBounds } from '../types/project'
import type { Clamp, Operation, Project, SquareStock } from '../types/project'
import { convertToolUnits, exportGeometryTolerance } from '../utils/units'

/** Why a square blank's physical setup is not one this build supports. */
export type SquareRotarySafetyReason =
  /** The blank's own dimensions are unreadable: no pivot, centre or envelope. */
  | 'blankEnvelope'
  /** A clamp row carries a non-finite or non-positive dimension. */
  | 'clampInvalid'
  /** A chuck/tailstock is off the true centreline or its height is not pivot-derived. */
  | 'workholdingPlacement'
  /** A chuck/tailstock's outer diameter is smaller than the square corner envelope. */
  | 'workholdingDiameter'
  /** An ordinary clamp reaches into the swept blank/cutter envelope. */
  | 'ordinaryClampOverlap'

/** The clamp (if any) the verdict names. `clampId`/`clampName` are empty for a blank verdict. */
export interface SquareRotarySafetyRefusal {
  reason: SquareRotarySafetyReason
  clampId: string
  clampName: string
}

/** True for the two round workholding types (`store/helpers/roundWorkholding.ts`). */
function isWorkholding(clamp: Clamp): boolean {
  return clamp.type === 'chuck' || clamp.type === 'tailstock'
}

/** The clamp's size across the bar (`roundWorkholdingDiameter`, inlined: engine never imports the store). */
function workholdingDiameter(clamp: Clamp, stock: SquareStock): number {
  return stock.axis === 'x' ? clamp.h : clamp.w
}

function finite(...values: number[]): boolean {
  return values.every((value) => Number.isFinite(value))
}

/**
 * The cutter radius the swept envelope is grown by, in project units. Zero for
 * an operation with no tool row at all: the blank's own envelope is still
 * checked, and the caller's own "no tool" refusal fires before any motion. A
 * tool row that exists but carries an unusable diameter fails closed — the
 * swept envelope is unknown, so no ordinary clamp may be called clear.
 */
function operationToolRadius(project: Pick<Project, 'tools' | 'meta'>, operation: Pick<Operation, 'toolRef'>): number {
  const record = project.tools.find((tool) => tool.id === operation.toolRef)
  if (!record) return 0
  // The same section `normalizeToolForProject` computes, without importing the
  // clipper-backed geometry module into a pure setup guard.
  const radius = convertToolUnits(record, project.meta.units).diameter / 2
  return Number.isFinite(radius) && radius > 0 ? radius : Number.POSITIVE_INFINITY
}

/** The two ends of a clamp or blank, along the bar's own axis. */
interface Span {
  min: number
  max: number
}

function clampSpan(clamp: Clamp, axis: 'x' | 'y'): Span {
  const min = axis === 'x' ? clamp.x : clamp.y
  return { min, max: min + (axis === 'x' ? clamp.w : clamp.h) }
}

function spanOverlap(a: Span, b: Span): number {
  return Math.min(a.max, b.max) - Math.max(a.min, b.min)
}

/** The rectangle a clamp occupies in the plane the bar turns in, grown by `expand`. */
interface CrossSection {
  minAcross: number
  maxAcross: number
  minUp: number
  maxUp: number
}

/**
 * True when the rectangle comes within `radius + tolerance` of the circle
 * centred at `(centre, pivot)` — the rectangle's nearest point to the centre.
 */
function rectangleTouchesCircle(
  rectangle: CrossSection,
  centre: number,
  pivot: number,
  radius: number,
  tolerance: number,
): boolean {
  const nearestAcross = Math.min(Math.max(centre, rectangle.minAcross), rectangle.maxAcross)
  const nearestUp = Math.min(Math.max(pivot, rectangle.minUp), rectangle.maxUp)
  const across = centre - nearestAcross
  const up = pivot - nearestUp
  const reach = radius + tolerance
  return across * across + up * up <= reach * reach
}

function verdict(reason: SquareRotarySafetyReason, clamp?: Clamp): SquareRotarySafetyRefusal {
  return { reason, clampId: clamp?.id ?? '', clampName: clamp?.name ?? '' }
}

/**
 * Why a chuck or tailstock on this square blank is not a supported turning
 * setup, or `null` when it is. Only clamps that **axially overlap the blank**
 * are judged: a support that sits wholly past the end face is not holding the
 * bar (the default tailstock only touches its end face and is therefore
 * skipped), while the default chuck, which grips inside the end, is judged.
 */
function workholdingRefusal(
  stock: SquareStock,
  centre: number,
  pivot: number,
  cornerRadius: number,
  clamp: Clamp,
  stockAlong: Span,
  tolerance: number,
): SquareRotarySafetyRefusal | null {
  if (!finite(clamp.x, clamp.y, clamp.w, clamp.h, clamp.height) || !(clamp.w > 0) || !(clamp.h > 0)) {
    return verdict('clampInvalid', clamp)
  }
  if (spanOverlap(clampSpan(clamp, stock.axis), stockAlong) <= tolerance) return null
  const across = stock.axis === 'x' ? clamp.y + clamp.h / 2 : clamp.x + clamp.w / 2
  const diameter = workholdingDiameter(clamp, stock)
  if (Math.abs(across - centre) > tolerance) return verdict('workholdingPlacement', clamp)
  if (Math.abs(clamp.height - (pivot + diameter / 2)) > tolerance) return verdict('workholdingPlacement', clamp)
  if (diameter < 2 * cornerRadius - tolerance) return verdict('workholdingDiameter', clamp)
  return null
}

/**
 * Why an ordinary clamp cannot be ignored on this square blank, or `null` when
 * it is provably clear. The blank's corners sweep a cylinder of radius
 * `barMaxRadius` about the true pivot; the clamp's footprint is grown by the
 * cutter's body and the project's XY clearance, and a clamp whose along span
 * misses the blank entirely is clear.
 */
function ordinaryClampRefusal(
  stock: SquareStock,
  centre: number,
  pivot: number,
  cornerRadius: number,
  clamp: Clamp,
  stockAlong: Span,
  expand: number,
  clampClearanceZ: number,
  tolerance: number,
): SquareRotarySafetyRefusal | null {
  if (!finite(clamp.x, clamp.y, clamp.w, clamp.h, clamp.height) || !(clamp.w > 0) || !(clamp.h > 0)) {
    return verdict('clampInvalid', clamp)
  }
  if (spanOverlap(clampSpan(clamp, stock.axis), stockAlong) <= tolerance) return null
  const acrossCentre = stock.axis === 'x' ? clamp.y + clamp.h / 2 : clamp.x + clamp.w / 2
  const acrossHalf = (stock.axis === 'x' ? clamp.h : clamp.w) / 2 + expand
  const rectangle: CrossSection = {
    minAcross: acrossCentre - acrossHalf,
    maxAcross: acrossCentre + acrossHalf,
    // Every clamp stands on the bed at stock Z 0 and rises to its own height.
    minUp: 0,
    maxUp: clamp.height + clampClearanceZ,
  }
  return rectangleTouchesCircle(rectangle, centre, pivot, cornerRadius, tolerance)
    ? verdict('ordinaryClampOverlap', clamp)
    : null
}

/**
 * The physical-setup verdict for a square blank, or `null` when the stock is
 * not a square (a round bar's output is unchanged), the setup is clear, or the
 * caller is asking about a project with no clamps.
 *
 * `operation` supplies the cutter whose body the swept envelope must include.
 */
export function squareRotarySafetyRefusal(
  project: Pick<Project, 'stock' | 'clamps' | 'meta' | 'tools'>,
  operation: Pick<Operation, 'toolRef'>,
): SquareRotarySafetyRefusal | null {
  const stock = project.stock
  if (!isSquareStock(stock)) return null
  const bounds = getStockBounds(stock)
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const cornerRadius = barMaxRadius(stock)
  const stockAlong: Span = stock.axis === 'x'
    ? { min: bounds.minX, max: bounds.maxX }
    : { min: bounds.minY, max: bounds.maxY }
  if (!(stock.thickness > 0) || !finite(stock.thickness, centre, pivot, cornerRadius)
    || cornerRadius <= 0 || !finite(stockAlong.min, stockAlong.max)) {
    return verdict('blankEnvelope')
  }
  const tolerance = exportGeometryTolerance(project.meta.units)
  // The clearances are read the way the flat clamp check reads them. A
  // non-finite value cannot be allowed to make the grown rectangle NaN — a
  // NaN comparison is false and would silently clear every clamp — so it is
  // floored to 0, the least clearance the project actually declares.
  const clearanceXY = Number.isFinite(project.meta.clampClearanceXY) ? Math.max(0, project.meta.clampClearanceXY) : 0
  const clearanceZ = Number.isFinite(project.meta.clampClearanceZ) ? Math.max(0, project.meta.clampClearanceZ) : 0
  const expand = clearanceXY + operationToolRadius(project, operation)
  const clampClearanceZ = clearanceZ
  for (const clamp of project.clamps) {
    const refusal = isWorkholding(clamp)
      ? workholdingRefusal(stock, centre, pivot, cornerRadius, clamp, stockAlong, tolerance)
      : ordinaryClampRefusal(stock, centre, pivot, cornerRadius, clamp, stockAlong, expand, clampClearanceZ, tolerance)
    if (refusal) return refusal
  }
  return null
}
