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
 * `roundWorkholdingDiameter` is the clamp's **outer** diameter. The criterion
 * below is a *supported-setup restriction*, deliberately weaker than a claim
 * about the hardware: it is neither a measured bore/capacity nor a proof that
 * a particular jaw intersects the blank at a particular angle. What it does
 * say is that a diameter clearing `2 × barMaxRadius` about the true pivot is
 * the smallest claim this module makes about a support that grips the blank.
 *
 * Ordinary clamps (step, toe, vacuum, vise) are not workholding a turning job
 * holds the bar with, and rotary generation bypasses `applyClampWarnings`
 * entirely. So the same guard asks whether any ordinary clamp reaches into the
 * region the blank sweeps as it turns, grown by the cutter's own body and the
 * project's clamp clearance. That region is the **circumscribed cylinder** of
 * the corner envelope — the blank's cross-section is entirely inside it at
 * every angle — so it is conservative for the blank, and it is not a general
 * 4-axis collision model.
 *
 * Being past the blank's end face is **not** by itself clear: the last cut can
 * sit on the end face while a finite cutter body reaches one tool radius plus
 * the XY clearance beyond it. The along span is therefore grown by that same
 * cutter + clearance envelope before a clamp is called distant, and only a
 * fixture with a real gap left between the two is passed.
 *
 * Visibility is never consulted: a hidden chuck still holds the bar, and
 * `rotaryAlongRange` already ignores `visible` for the same reason.
 *
 * Everything here fails closed. A NaN or non-finite clamp dimension, a
 * non-positive width, depth or **height**, a far corner that overflows to
 * infinity, a clamp off the true centreline, a height not derived from the
 * pivot, a blank whose axial extent or bounds do not read, a project whose own
 * clamp clearances are not finite, or a referenced tool that names no usable
 * row is refused rather than repaired — the stored placement is what the
 * machine would actually be set up with. A non-finite clearance used to be
 * floored to zero, which made it *less* conservative than the declared value;
 * it now refuses instead.
 *
 * The cutter is a **body**, not a number. Equal radii do not make two shapes
 * interchangeable: at a horizontal offset `d` from the tool axis, a flat
 * endmill's bottom is still the tip plane, while a ball endmill's lowest
 * surface has risen to `tip + r − √(r² − d²)`. The two leave different stock
 * for every `0 < d < r`, so the shape the geometry was generated with and the
 * shape the emitter writes must be the same supported cutter, and its radius
 * must be the half-diameter of the body it claims to be.
 */

import {
  barCentre,
  barMaxRadius,
  barPivotZ,
  isSquareStock,
} from '../types/barStock'
import { getStockBounds, roundStockDiameter } from '../types/project'
import type { BarStock, Clamp, Operation, Project, SquareStock, ToolType } from '../types/project'
import { convertToolUnits, exportGeometryTolerance } from '../utils/units'
import type { Units } from '../utils/units'

/** Why a square blank's physical setup is not one this build supports. */
export type SquareRotarySafetyReason =
  /** The blank's own dimensions are unreadable: no pivot, centre, envelope or axial extent. */
  | 'blankEnvelope'
  /** The project's own clamp clearances are not finite, so the swept envelope is unknown. */
  | 'projectInvalid'
  /** A clamp row carries a non-finite or non-positive dimension. */
  | 'clampInvalid'
  /** A chuck/tailstock is off the true centreline or its height is not pivot-derived. */
  | 'workholdingPlacement'
  /** A chuck/tailstock's outer diameter is smaller than the square corner envelope. */
  | 'workholdingDiameter'
  /** An ordinary clamp reaches into the swept blank/cutter envelope. */
  | 'ordinaryClampOverlap'
  /**
   * The cutter the emitter holds is missing, unusable, the wrong shape, named
   * by another project row, in another unit system, or not the project's
   * referenced row.
   */
  | 'cutterStale'

/** The clamp (if any) the verdict names. `clampId`/`clampName` are empty for a blank or cutter verdict. */
export interface SquareRotarySafetyRefusal {
  reason: SquareRotarySafetyReason
  clampId: string
  clampName: string
  /**
   * `workholdingDiameter` only: the clamp's outer diameter, in project units —
   * the number the operation warning names (never re-formatted here).
   */
  diameter?: number
  /** `workholdingDiameter` only: the corner-envelope diameter it must clear, in project units. */
  required?: number
}

/** True for the two round workholding types (`store/helpers/roundWorkholding.ts`). */
function isWorkholding(clamp: Clamp): boolean {
  return clamp.type === 'chuck' || clamp.type === 'tailstock'
}

/**
 * The outer diameter a chuck or tailstock must reach to hold this bar, in
 * project units: the square blank's corner envelope (`2 × barMaxRadius`), or
 * the round bar's own diameter (#1016 C2 F3b). The guard below refuses a
 * support whose diameter is below this by more than the export tolerance, and
 * the round ↔ square stock switch re-mints on exactly the same rule — one
 * threshold, never a second formula. Exported for that caller; the comparison
 * itself stays here because the tolerance is the guard's own.
 */
export function requiredWorkholdingDiameter(stock: BarStock): number {
  return isSquareStock(stock) ? 2 * barMaxRadius(stock) : roundStockDiameter(stock)
}

/** The clamp's size across the bar (`roundWorkholdingDiameter`, inlined: engine never imports the store). */
function workholdingDiameter(clamp: Clamp, stock: SquareStock): number {
  return stock.axis === 'x' ? clamp.h : clamp.w
}

function finite(...values: number[]): boolean {
  return values.every((value) => Number.isFinite(value))
}

/**
 * The cutter radius the swept envelope is grown by, in project units.
 *
 * A `toolRef` that names no row, or names one whose diameter is not a usable
 * positive finite length, is **unknown**, not zero: the swept envelope cannot
 * be computed, so no ordinary clamp may be called clear. Generation's own
 * `noToolAssigned` refusal is not a substitute — a stale `ToolpathResult` can
 * reach the postprocessor with no project tool row at all, and the physical
 * verdict must not depend on a downstream guard that never ran.
 */
function operationToolRadius(project: Pick<Project, 'tools' | 'meta'>, operation: Pick<Operation, 'toolRef'>): number {
  const record = operation.toolRef ? project.tools.find((tool) => tool.id === operation.toolRef) : undefined
  if (!record) return Number.POSITIVE_INFINITY
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

/**
 * True when the two spans leave a real gap: a gap no wider than the safety
 * tolerance is judged, so a tangency is refused, and only a fixture that is
 * provably further away than that is passed.
 */
function spansAreApart(a: Span, b: Span, tolerance: number): boolean {
  return spanOverlap(a, b) < -tolerance
}

/**
 * True when a clamp row is a box the guard can reason about: finite
 * coordinates, positive finite width, depth and **height**, and finite far
 * corners. A non-positive height is refused rather than read as a zero-height
 * box, and `x + w` / `y + h` are checked so a huge coordinate cannot overflow
 * to infinity and compare its way to "clear".
 */
function clampBoxIsSane(clamp: Clamp): boolean {
  return finite(clamp.x, clamp.y, clamp.w, clamp.h, clamp.height)
    && clamp.w > 0 && clamp.h > 0 && clamp.height > 0
    && finite(clamp.x + clamp.w, clamp.y + clamp.h)
}

/** The rectangle a clamp occupies in the plane the bar turns in. */
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
 *
 * The engagement span is the blank's own. A cutter's overhang past the end is
 * an *ordinary-clamp* question: a chuck that no longer touches the blank is
 * clear of it even when the cutter sweeps past, because the support has
 * stopped holding it.
 */
function workholdingRefusal(
  stock: SquareStock,
  centre: number,
  pivot: number,
  clamp: Clamp,
  stockAlong: Span,
  tolerance: number,
): SquareRotarySafetyRefusal | null {
  if (!clampBoxIsSane(clamp)) return verdict('clampInvalid', clamp)
  if (spanOverlap(clampSpan(clamp, stock.axis), stockAlong) <= tolerance) return null
  const across = stock.axis === 'x' ? clamp.y + clamp.h / 2 : clamp.x + clamp.w / 2
  const diameter = workholdingDiameter(clamp, stock)
  if (Math.abs(across - centre) > tolerance) return verdict('workholdingPlacement', clamp)
  if (Math.abs(clamp.height - (pivot + diameter / 2)) > tolerance) return verdict('workholdingPlacement', clamp)
  const required = requiredWorkholdingDiameter(stock)
  if (diameter < required - tolerance) {
    // The numbers ride the verdict, not just its name: the operation warning
    // names both lengths (#1016 C2 F3), and generation must not have to
    // re-derive them from a project that may have moved on.
    return { ...verdict('workholdingDiameter', clamp), diameter, required }
  }
  return null
}

/**
 * Why an ordinary clamp cannot be ignored on this square blank, or `null` when
 * it is provably clear. The blank's corners sweep a cylinder of radius
 * `barMaxRadius` about the true pivot; growing that **circle** by the cutter's
 * body and the project's XY clearance is the conservative envelope of the
 * swept blank, and a clamp whose along span still misses the blank's own span
 * grown by the same amount is clear.
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
  if (!clampBoxIsSane(clamp)) return verdict('clampInvalid', clamp)
  // Past the end face is not clear on its own: the last cut sits on that face
  // and the cutter body reaches `toolRadius + clearanceXY` beyond it.
  const sweptAlong: Span = { min: stockAlong.min - expand, max: stockAlong.max + expand }
  if (spansAreApart(clampSpan(clamp, stock.axis), sweptAlong, tolerance)) return null
  const rectangle: CrossSection = {
    minAcross: stock.axis === 'x' ? clamp.y : clamp.x,
    maxAcross: stock.axis === 'x' ? clamp.y + clamp.h : clamp.x + clamp.w,
    // Every clamp stands on the bed at stock Z 0 and rises to its own height.
    minUp: 0,
    maxUp: clamp.height + clampClearanceZ,
  }
  return rectangleTouchesCircle(rectangle, centre, pivot, cornerRadius + expand, tolerance)
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
  const alongLength = stockAlong.max - stockAlong.min
  if (!(stock.thickness > 0) || !finite(stock.thickness, centre, pivot, cornerRadius)
    || !finite(bounds.minX, bounds.maxX, bounds.minY, bounds.maxY)
    || cornerRadius <= 0
    || !finite(stockAlong.min, stockAlong.max)
    || !(alongLength > 0) || !Number.isFinite(alongLength)) {
    return verdict('blankEnvelope')
  }
  // The clearances are the values the swept envelope is grown by. A non-finite
  // one cannot be allowed to make the grown rectangle NaN — a NaN comparison
  // is false and would silently clear every clamp — and flooring it to 0 would
  // claim *less* clearance than the project declares, so it fails closed.
  if (!Number.isFinite(project.meta.clampClearanceXY) || !Number.isFinite(project.meta.clampClearanceZ)) {
    return verdict('projectInvalid')
  }
  const clearanceXY = Math.max(0, project.meta.clampClearanceXY)
  const clearanceZ = Math.max(0, project.meta.clampClearanceZ)
  const expand = clearanceXY + operationToolRadius(project, operation)
  const tolerance = exportGeometryTolerance(project.meta.units)
  for (const clamp of project.clamps) {
    const refusal = isWorkholding(clamp)
      ? workholdingRefusal(stock, centre, pivot, clamp, stockAlong, tolerance)
      : ordinaryClampRefusal(stock, centre, pivot, cornerRadius, clamp, stockAlong, expand, clearanceZ, tolerance)
    if (refusal) return refusal
  }
  return null
}

/**
 * The normalized cutter body the emitter is about to write, reduced to the
 * fields this physical guard reasons about: which project row it is, the unit
 * system its numbers are in, and the physical shape and size it will drive.
 * Passed explicitly by the caller (`gcode/motionPipeline.ts`), never inferred
 * from the stored operation or the moves.
 */
export interface EmittedSquareCutter {
  /** The project tool row the emitter's tool number is selected from. */
  id: string
  /** The unit system the diameter and radius below are expressed in. */
  units: Units
  /** The cutter's physical shape, as normalized for the project. */
  type: ToolType
  /** The normalized outside diameter, in project units. */
  diameter: number
  /** The normalized tip radius, in project units. */
  radius: number
}

/** The only cutter shapes a square turning rough/finish is generated with. */
const SQUARE_ROTARY_CUTTER_TYPES: readonly ToolType[] = ['flat_endmill', 'ball_endmill']

/**
 * Why the cutter the emitter is about to write must not cut this square blank,
 * or `null` when it is the project's own referenced row. Asked only by output.
 *
 * The postprocessor holds the normalized tool row it will actually emit; the
 * physical guard above resolves the same reference from the project. When they
 * disagree — a row removed from the project, an unusable diameter, or a stale
 * entry carrying a different cutter — the guard could prove one cutter clear
 * and the emitter then write another. A square angle-bearing program fails
 * closed instead. Round output never asks this.
 *
 * Identity is not cosmetic. `planProgramSequence` selects the program's tool
 * number from the emitted row's `id`, so an entry naming a *different* project
 * row writes a wrong-tool instruction — a `; Tool 2` and a manual change stop —
 * even when its shape, diameter and radius were spoofed to match. The emitted
 * `id` must therefore be the operation's own `toolRef`, and its normalized
 * `units` must be the project's: a row labelled in another unit system while
 * the project is not is a different body to the machine. `sourceUnits` is the
 * record's own storage label and may legitimately differ after conversion, so
 * it is deliberately not compared. This is the row's identity and physical
 * body only — never its display name, feeds or material.
 *
 * Equal radii are not enough either. The emitted body's **shape** must be the
 * same supported cutter as the referenced row: a ball substituted for a
 * referenced flat (or a flat for a ball) removes a different solid at the same
 * tip position, and an unsupported shape (`v_bit`, `drill`) has no definition
 * this build can cut a turning pass with at all. The emitted row's own radius
 * and diameter must also describe one body — a radius that is not the half of
 * its diameter is not a cutter this guard can reason about. Every one of those
 * is refused with the same `cutterStale`.
 *
 * The emitted row is read field by field from the normalized row the caller
 * will post. Its type is never inferred from the stored operation or from the
 * moves: only the shape the emitter actually holds can describe what the
 * machine will drive.
 */
export function squareRotaryCutterRefusal(
  project: Pick<Project, 'tools' | 'meta'>,
  operation: Pick<Operation, 'toolRef'>,
  emitted: EmittedSquareCutter,
): SquareRotarySafetyRefusal | null {
  const tolerance = exportGeometryTolerance(project.meta.units)
  // The row's identity and the system its numbers are in come first: a
  // different tool number or a foreign unit label is a different cutter to the
  // machine however equal its numbers look.
  if (emitted.id !== operation.toolRef) return verdict('cutterStale')
  if (emitted.units !== project.meta.units) return verdict('cutterStale')
  // The body the emitter writes must be a shape this build turns with, and its
  // own radius/diameter pair must describe that one body.
  if (!SQUARE_ROTARY_CUTTER_TYPES.includes(emitted.type)) return verdict('cutterStale')
  if (!Number.isFinite(emitted.radius) || emitted.radius <= 0) return verdict('cutterStale')
  if (!Number.isFinite(emitted.diameter) || emitted.diameter <= 0) return verdict('cutterStale')
  if (Math.abs(emitted.diameter / 2 - emitted.radius) > tolerance) return verdict('cutterStale')
  const record = operation.toolRef ? project.tools.find((tool) => tool.id === operation.toolRef) : undefined
  if (!record) return verdict('cutterStale')
  const referenced = convertToolUnits(record, project.meta.units)
  // The referenced row's shape is what the geometry was generated with: it must
  // be supported too, and identical to the emitted body. The comparison is the
  // physical shape and the normalized radius only — not a broad metadata
  // equality over name, feeds or material.
  if (!SQUARE_ROTARY_CUTTER_TYPES.includes(referenced.type)) return verdict('cutterStale')
  if (referenced.type !== emitted.type) return verdict('cutterStale')
  const referencedRadius = referenced.diameter / 2
  if (!Number.isFinite(referencedRadius) || referencedRadius <= 0) return verdict('cutterStale')
  return Math.abs(referencedRadius - emitted.radius) <= tolerance
    ? null
    : verdict('cutterStale')
}
