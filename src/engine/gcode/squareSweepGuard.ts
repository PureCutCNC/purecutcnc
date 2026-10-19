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
 * The square blank's standing-material grid, and the export guard that walks a
 * whole program's commanded motion through it (#1045 slices E and F).
 *
 * Slice C decided whether an around pass was safe by **licensing**: an earlier
 * program rough on the same target was taken as proof that the material a
 * finish would sweep was already gone. A later review found the flaw: a rough
 * whose own supports (or whose cut range) covered only part of the band
 * licensed a finish over the whole band. One global minimum tip cannot answer a
 * question that is local in both along position and angle.
 *
 * This module keeps **material accounting** instead. For a square blank it
 * keeps a grid of the material still standing — along-bar bins by angle bins,
 * each cell the largest material radius above the turning pivot anywhere in the
 * cell — initialised from the raw blank (the square's corner envelope, each
 * cell taking the **maximum** over its angular span so a corner cusp is never
 * lost between bin centres, retained ends included). It walks every move of
 * every square turning operation in program order, samples the **actual
 * commanded motion** (linear in along, A and Z; A as commanded, so an A0->A360
 * move is a full revolution, never a modulo shortcut), and at each sample:
 *
 * - reads every cell the cutter's body can reach and measures its engagement
 *   against the **exact ray/cutter intersection**: a flat's bottom face meets a
 *   cell's angular ray at `tip / cos(dTheta)` (the disc, while the ray is within
 *   the cutter's radius), a ball's sphere at the near root of
 *   `(R cos dTheta - (tip + r))^2 + (R sin dTheta)^2 + dx^2 = r^2`. Recording the
 *   tip radius instead — the slice-E model — leaves the off-axis material higher
 *   than the grid says, which is exactly the review's "flat at tip 9 leaves
 *   radius 9/cos(phi)" defect;
 * - lowers a cell only to what the cut leaves **everywhere** in it: the contact
 *   at the cell's far corner, and only when the cutter body covers that corner.
 *   A cell the cutter merely grazes keeps the material its uncovered edge still
 *   stands, so the grid never under-states standing material;
 * - refuses a **turning cut** below the blank's travel height whose engagement
 *   exceeds the operation's own bound (a rough's `stepdown`; a finish's
 *   `stockToLeave` plus the scallop a rough that actually covered that spot
 *   would leave).
 *
 * Resolution is conservative by construction, never widened to fit a budget.
 * The along bin is at most a quarter of the smallest cutter radius in the
 * program, and the angular bin is narrower than the cutter's footprint at the
 * blank's corner (`2 asin(r / barMaxRadius)`), so a cell centre is always inside
 * a footprint that could hold material. When either would need more bins than
 * {@link GUARD_MAX_ALONG_BINS} / {@link GUARD_ANGLE_BIN_COUNT} allow, the grid
 * refuses to be built and every operation reports
 * `postRotarySquareGuardResolution` — a longer blank with a small cutter is a
 * program the check cannot answer, not a program it may approximate.
 *
 * A turn that removes nothing — a rapid, or a turn on an along-mode operation —
 * keeps the old refusal exactly. A non-turning cut (a plunge, or an along pass)
 * is never refused here but **does** lower the grid, which is what lets an
 * along rough clear material for a later around finish.
 *
 * The tolerance the guard adds to an operation's own bound is stated in
 * {@link guardSquareOperation}: one angular bin's worst-case change of the
 * blank's surface, the ball's own radial change across half an along bin, and
 * the emitted Z's rounding. The grid itself cannot make a cut look deeper than
 * it is: engagement uses the cell's **near** corner contact (the smallest
 * radius the cut reaches in that cell) and lowering uses its **far** corner, so
 * both the refusal and the material left afterwards err toward refusing.
 */

import { barMaxRadius, barPivotZ, barSurfaceRadius } from '../../types/barStock'
import { getStockBounds } from '../../types/project'
import type { BarStock, Operation } from '../../types/project'
import { operationTargetKey } from '../setupTargets'
import type { EmittedSquareCutter } from '../squareRotarySafety'
import type { ToolpathMove } from '../toolpaths/types'

/**
 * Angular resolution of the standing-material grid. Half a degree is twice as
 * fine as the "at most 1 degree" the slice-E design names; on a 60 mm square
 * blank's corner (42.4 mm) one bin spans 0.37 mm of surface, under a fifth of a
 * typical 2 mm layer. It is fixed rather than derived so the precomputed trig
 * tables stay shared, and a cutter whose footprint at the blank's corner is
 * narrower than one bin is refused (see {@link createSquareSweepState}) rather
 * than allowed to slip between bins.
 */
export const GUARD_ANGLE_BIN_DEGREES = 0.5
const GUARD_ANGLE_BIN_COUNT = Math.round(360 / GUARD_ANGLE_BIN_DEGREES)
const GUARD_ANGLE_BIN_RADIANS = GUARD_ANGLE_BIN_DEGREES * Math.PI / 180

/**
 * Along-bar resolution. One bin is at most a quarter of the smallest cutter
 * radius in the program, so the cutter body always spans at least four bins and
 * consecutive samples' footprints overlap. A very long bar with a tiny cutter
 * would otherwise allocate millions of rows: the guard **refuses** rather than
 * widening the bin past the cutter, because a bin wider than the cutter can
 * hold a sample entirely between two cell centres and miss the cut (the
 * review's 20 x 1,000 mm square blank with a 0.2 mm flat). The caps below leave
 * room for a 1 m bar with a 1 mm-radius cutter (4,000 bins, 2.88 M cells).
 */
const GUARD_MAX_ALONG_BINS = 4096
const GUARD_MAX_CELLS = 3_000_000

/**
 * The largest commanded angle change one turning **cut** below the envelope may
 * make and still be read as an around pass's sample-to-sample ring move. A
 * generated ring steps a few degrees; a move that sweeps more than two
 * revolutions is not a sampled ring (a stale or hand-edited path), and refusing
 * it also keeps the guard's own sampling bounded.
 */
export const MAX_GUARD_SWEEP_DEGREES = 720

/** One sample of a move: the commanded along position, angle and tip radius. */
interface GuardSample {
  along: number
  /** Program-direction angle in degrees (the project A word times the machine's direction). */
  angle: number
  /** Cutter tip radius from the turning pivot. */
  tip: number
}

/**
 * Why the guard refused an operation. `resolution` is not a statement about the
 * cut: the blank and cutter need a finer grid than the guard may allocate, so
 * it cannot prove the cut safe and the operation is refused with its own
 * message instead.
 */
export type SquareGuardRefusal = 'turn' | 'resolution'

/** The guard's answer for one operation. */
export type SquareGuardVerdict =
  | { admitted: true }
  | { admitted: false; reason: SquareGuardRefusal }

/**
 * The square blank's material account for one export program (#1045 slice E).
 *
 * `material[alongBin * angleBins + angleBin]` is the **largest** outer radius
 * of the material still standing anywhere in that cell, measured from the
 * turning pivot. A cell is lowered only, never raised: a cut removes material.
 */
export interface SquareSweepState {
  readonly stock: BarStock
  readonly angleBins: number
  readonly angleBinDegrees: number
  readonly alongBins: number
  readonly alongBin: number
  /** The bar's lower along coordinate (the first cell's start). */
  readonly alongStart: number
  readonly material: Float64Array
  /**
   * The largest value `material` can hold — the blank's corner radius. Kept once
   * so the sample loop never recomputes it.
   */
  readonly maxMaterial: number
  /**
   * The scallop allowance left by the strongest earlier enabled rough for each
   * target key: its `stepdown` plus its own radial stock to leave. A finish
   * over that rough may take exactly that much in one turning pass.
   */
  readonly roughAllowance: Map<string, number>
  /**
   * Set when the grid cannot resolve the program's smallest cutter within the
   * guard's budget. Every operation is then refused with `resolution`; the
   * grid's cells are not meaningful and must not be read.
   */
  readonly resolutionRefused: boolean
}

/**
 * Build the blank's grid. `minCutterRadius` is the smallest cutter radius among
 * the program's square turning operations; both the along bin and the footprint
 * coverage are derived from it.
 *
 * The two resolution rules are necessary, not cosmetic:
 *
 * - an along bin wider than the cutter leaves a sample between two cell
 *   centres, where every cell lies outside the footprint and the cut is
 *   invisible (the review's repro);
 * - an angular bin wider than the cutter's footprint at the blank's corner
 *   (`barMaxRadius`) lets the footprint fall between two angular bin centres
 *   even when the along direction does resolve it.
 *
 * A program that needs more than {@link GUARD_MAX_ALONG_BINS} along bins (or
 * more cells than {@link GUARD_MAX_CELLS}) gets a state with
 * `resolutionRefused`, never a widened bin.
 */
export function createSquareSweepState(stock: BarStock, minCutterRadius: number): SquareSweepState {
  const bounds = stockBoundsAlong(stock)
  const length = Math.max(0, bounds.upper - bounds.lower)
  const maxMaterial = barMaxRadius(stock)
  const radius = Number.isFinite(minCutterRadius) && minCutterRadius > 0 ? minCutterRadius : 1
  const alongBinWanted = radius * 0.25
  const alongBinsWanted = Math.max(1, Math.ceil(length / Math.max(alongBinWanted, 1e-9)))
  // The cutter's angular footprint at the blank's largest radius. A cutter
  // radius at or above that radius subtends the whole turn (`asin` clamps to
  // one), so it can never slip between angular bins.
  const footprintHalfAngle = Math.asin(Math.min(1, radius / Math.max(maxMaterial, 1e-9)))
  const angularResolved = 2 * footprintHalfAngle * (180 / Math.PI) >= GUARD_ANGLE_BIN_DEGREES
  const resolutionRefused = alongBinsWanted > GUARD_MAX_ALONG_BINS
    || alongBinsWanted * GUARD_ANGLE_BIN_COUNT > GUARD_MAX_CELLS
    || !angularResolved
    || !(length > 0)
  if (resolutionRefused) {
    return {
      stock,
      angleBins: GUARD_ANGLE_BIN_COUNT,
      angleBinDegrees: GUARD_ANGLE_BIN_DEGREES,
      alongBins: 1,
      alongBin: Math.max(length, 1e-9),
      alongStart: bounds.lower,
      material: new Float64Array(0),
      maxMaterial,
      roughAllowance: new Map(),
      resolutionRefused: true,
    }
  }
  const alongBins = alongBinsWanted
  const alongBin = length / alongBins
  const angleBins = GUARD_ANGLE_BIN_COUNT
  const material = new Float64Array(alongBins * angleBins)
  // The blank is the same cross-section at every along position, retained ends
  // included: the grid covers the bar's whole length, so an end the program
  // never cuts simply keeps the blank there. A cell is the surface at its own
  // angular ray, the coordinate every cut is also measured at; the corner cusp
  // a cell boundary may hide is what the stated `barMaxRadius * angleBin`
  // tolerance covers.
  const row = new Float64Array(angleBins)
  for (let k = 0; k < angleBins; k++) {
    row[k] = barSurfaceRadius(stock, (k + 0.5) * GUARD_ANGLE_BIN_DEGREES)
  }
  for (let i = 0; i < alongBins; i++) material.set(row, i * angleBins)
  return {
    stock,
    angleBins,
    angleBinDegrees: GUARD_ANGLE_BIN_DEGREES,
    alongBins,
    alongBin,
    alongStart: bounds.lower,
    material,
    maxMaterial,
    roughAllowance: new Map(),
    resolutionRefused: false,
  }
}

function stockBoundsAlong(stock: BarStock): { lower: number; upper: number } {
  const bounds = getStockBounds(stock)
  return stock.axis === 'x'
    ? { lower: bounds.minX, upper: bounds.maxX }
    : { lower: bounds.minY, upper: bounds.maxY }
}

export interface GuardOperationInput {
  operation: Operation
  moves: readonly ToolpathMove[]
  cutter: EmittedSquareCutter
  /** The controller angle the program hands in, or `null` at program start. */
  entryAngle: number | null
  /** +1 or -1: the factor the project A word is written with. */
  direction: 1 | -1
  /** The height above the pivot every between-run move travels at. */
  travelZ: number
  /** Half a decimal place of the emitted Z, in project units. */
  roundingAllowance: number
}

/**
 * Decide whether one square turning operation's commanded motion is safe, and
 * fold its cuts into the program's standing-material grid.
 *
 * The operation's own bound is:
 * - a **rough**: `stepdown`;
 * - a **finish**: `stockToLeave` plus the scallop allowance of the strongest
 *   earlier enabled rough on the same target (`stepdown` plus that rough's own
 *   radial stock to leave — what a rough that actually covered the spot leaves),
 *   or just `stockToLeave` when no such rough ran.
 *
 * The guard adds one stated tolerance: `barMaxRadius * angleBin` for the
 * material's change across one angular cell, the cutter's own radial change
 * across half an along bin, and `roundingAllowance` for the emitted Z. A rough
 * therefore admits a bite of `stepdown + tolerance`; a finish
 * `stockToLeave + scallop + tolerance`. The material term is deliberately
 * measured against `barMaxRadius`: one cell can hold a corner cusp at the
 * blank's largest radius, and its engagement is compared with the smallest
 * contact the sample reaches in that cell, so the pair can differ by up to one
 * cell's worth of the blank's steepest surface. The along term is the
 * **cutter's** change, not the bin length: a flat's lower surface does not
 * change with along offset, so its term is zero; a ball's sphere rises across
 * the bin and the term covers the part of it the near-corner contact still
 * leaves out.
 *
 * Returns `{ admitted: false, reason: 'resolution' }` when the grid could not be
 * built, and `{ admitted: false, reason: 'turn' }` — keeping
 * `postRotarySquareTurnBelowEnvelope` — for a turning rapid, a turn on an
 * operation that does not run around the bar, or a turning cut that takes more
 * than its bound. A feed move that carries its angle on one end only is
 * skipped: the caller refuses it later as `postRotaryAngleNotEstablished`, and
 * a move the emitter cannot write has no commanded motion to account for.
 */
export function guardSquareOperation(state: SquareSweepState, input: GuardOperationInput): SquareGuardVerdict {
  if (state.resolutionRefused) return { admitted: false, reason: 'resolution' }
  const { operation, moves, cutter, direction, travelZ, roundingAllowance } = input
  const finish = operation.kind === 'rotary_finish'
  const around = operation.rotaryPassDirection === 'around'
    && (operation.kind === 'rotary_rough' || operation.kind === 'rotary_finish')
  const stockToLeave = finish ? operation.stockToLeaveRadial : 0
  if (finish && (!Number.isFinite(stockToLeave) || stockToLeave < 0)) {
    return { admitted: false, reason: 'turn' }
  }
  if (!finish && (!Number.isFinite(operation.stepdown) || operation.stepdown <= 0)) {
    return { admitted: false, reason: 'turn' }
  }
  const targetKey = operationTargetKey(operation.target)
  const scallop = finish ? state.roughAllowance.get(targetKey) ?? 0 : 0
  const cutterRadius = cutter.type === 'ball_endmill' || cutter.type === 'flat_endmill' ? cutter.radius : 0
  const ball = cutter.type === 'ball_endmill'
  const bound = (finish ? stockToLeave + scallop : operation.stepdown)
    + state.maxMaterial * (state.angleBinDegrees * Math.PI / 180)
    + alongBinRadialError(ball, cutterRadius, state.alongBin)
    + roundingAllowance
  const pivot = barPivotZ(state.stock)
  const travelTip = travelZ - pivot
  let controller = input.entryAngle ?? 0
  for (const move of moves) {
    const hasAngle = move.from.a !== undefined || move.to.a !== undefined
    // A feed move carrying A on one end only is refused later as
    // `postRotaryAngleNotEstablished`, before any feed is planned; the guard
    // must not relabel that refusal, and a move the emitter cannot write has no
    // commanded motion to account for.
    if (move.kind !== 'rapid' && (move.from.a === undefined) !== (move.to.a === undefined)) continue
    const end = !hasAngle || move.to.a === undefined ? controller : move.to.a * direction
    const turns = end !== controller
    const lowTip = Math.min(move.from.z, move.to.z) - pivot
    if (move.kind === 'rapid') {
      // A rapid that turns under the blank's envelope removes nothing, so
      // nothing can license it. A rapid that stays above it is untouched, and
      // is never sampled: a long program's entry angle can make its sweep tens
      // of thousands of degrees, which is a straight line in air.
      if (turns && lowTip < travelTip - roundingAllowance) return { admitted: false, reason: 'turn' }
      controller = end
      continue
    }
    // A move that never descends under the envelope is a link: it removes
    // nothing, so it neither lowers the grid nor needs its interior sampled.
    if (lowTip >= travelTip - roundingAllowance) {
      controller = end
      continue
    }
    // A turning cut that sweeps more than two revolutions below the envelope is
    // not a sampled around pass (a generated ring is a few degrees per move);
    // it is a stale or hand-edited path. Refusing it also bounds the guard's
    // own work, which is why the old shorter-arc bound existed.
    if (turns && Math.abs(end - controller) > MAX_GUARD_SWEEP_DEGREES) {
      return { admitted: false, reason: 'turn' }
    }
    const alongFrom = alongOf(state.stock, move.from)
    const alongTo = alongOf(state.stock, move.to)
    // Steps no coarser than one grid bin in angle and along, so consecutive
    // sampled footprints overlap and a short sweep cannot slip between samples.
    const steps = Math.max(1, Math.ceil(Math.abs(end - controller) / state.angleBinDegrees),
      Math.ceil(Math.abs(alongTo - alongFrom) / state.alongBin))
    for (let step = 0; step <= steps; step++) {
      const fraction = step / steps
      const sample: GuardSample = {
        along: alongFrom + (alongTo - alongFrom) * fraction,
        angle: controller + (end - controller) * fraction,
        tip: move.from.z + (move.to.z - move.from.z) * fraction - pivot,
      }
      if (turns) {
        if (!around) return { admitted: false, reason: 'turn' }
        const engagement = cutSample(state, sample, cutterRadius, ball)
        if (engagement > bound) return { admitted: false, reason: 'turn' }
      } else {
        cutSample(state, sample, cutterRadius, ball)
      }
    }
    controller = end
  }
  // An admitted rough leaves the program an allowance a later finish may take.
  if (!finish) {
    const allowance = (Number.isFinite(operation.stepdown) && operation.stepdown > 0 ? operation.stepdown : 0)
      + (Number.isFinite(operation.stockToLeaveRadial) && operation.stockToLeaveRadial > 0
        ? operation.stockToLeaveRadial
        : 0)
    state.roughAllowance.set(targetKey, Math.max(state.roughAllowance.get(targetKey) ?? 0, allowance))
  }
  return { admitted: true }
}

/**
 * The radial error one along bin can hide, for the cutter shape in use.
 *
 * The grid lowers a cell to the contact at its far corner, so the along bin's
 * own position is accounted for. What the guard still shares between samples is
 * the cutter's lower surface across the bin, because a ball's contact radius
 * rises with the along offset: from the bin centre to its edge that is at most
 * `r - sqrt(r² - (alongBin/2)²)`. A flat's lower surface does not change with
 * along offset, so its term is zero. (When a capped grid made the bin wider
 * than the ball, the bound saturates at `r`.)
 */
function alongBinRadialError(ball: boolean, cutterRadius: number, alongBin: number): number {
  if (!ball || !(cutterRadius > 0) || !Number.isFinite(cutterRadius) || !(alongBin > 0)) return 0
  const half = alongBin / 2
  return cutterRadius - Math.sqrt(Math.max(0, cutterRadius * cutterRadius - half * half))
}

function alongOf(stock: BarStock, point: { x: number; y: number }): number {
  return stock.axis === 'x' ? point.x : point.y
}

/** Precomputed sin/cos of whole angle bins, so the cell loop never calls `Math.sin`. */
interface GuardTrig {
  sin: Float64Array
  cos: Float64Array
}

let trig: GuardTrig | null = null
/** Scratch for one sample's angular offsets; grown as needed and reused. */
let offsetScratch = new Float64Array(0)
function guardTrig(): GuardTrig {
  if (trig) return trig
  const sin = new Float64Array(GUARD_ANGLE_BIN_COUNT)
  const cos = new Float64Array(GUARD_ANGLE_BIN_COUNT)
  for (let k = 0; k < GUARD_ANGLE_BIN_COUNT; k++) {
    const angle = k * GUARD_ANGLE_BIN_DEGREES * Math.PI / 180
    sin[k] = Math.sin(angle)
    cos[k] = Math.cos(angle)
  }
  trig = { sin, cos }
  return trig
}

/**
 * The radius at which a cell's angular ray meets the cutter's **lower surface**,
 * or `null` when the body does not reach that ray.
 *
 * A flat end mill's cutting face is the disc at the tip, perpendicular to the
 * tool axis: along a ray `dTheta` off that axis the face is at
 * `tip / cos(dTheta)`, while the ray is still inside the cutter's radius
 * (`|tip tan dTheta| <= sqrt(r^2 - dx^2)`). That is the material the face
 * leaves — not `tip`, which is only its on-axis depth. A ball's lower surface is
 * the sphere of radius `r` centred `tip + r` above the pivot on the tool axis;
 * the near root of the quadratic is the contact radius along the ray, and the
 * shank above its equator is a cylinder of the same radius (see {@link exitAt}).
 *
 * `cosTheta`/`sinSqTheta` are the ray's cosine and squared sine, so the caller
 * reuses its rotated bin tables instead of calling trigonometry per cell. `dx`
 * is the cell's along offset from the sample: both shapes are evaluated at the
 * cell's own coordinate, so a cell never records another point's contact.
 */
function contactAt(
  ball: boolean,
  cutterRadius: number,
  tip: number,
  cosTheta: number,
  sinSqTheta: number,
  dx: number,
): number | null {
  if (!(cutterRadius > 0) || !Number.isFinite(cutterRadius)) return null
  if (!Number.isFinite(tip) || !Number.isFinite(cosTheta) || !Number.isFinite(dx)) return null
  // A ray at or behind the cutter's shoulder (90 degrees or more off the axis)
  // is not reached by the tool's lower surface.
  if (!(cosTheta > 1e-9)) return null
  const radiusSq = cutterRadius * cutterRadius
  const alongSq = dx * dx
  if (alongSq >= radiusSq) return null
  if (!ball) {
    const reachSq = radiusSq - alongSq
    // `|tip tan dTheta| <= reach`, squared so the cell loop never calls `tan`.
    if (tip * tip * sinSqTheta > reachSq * cosTheta * cosTheta) return null
    return Math.max(0, tip / cosTheta)
  }
  const centre = tip + cutterRadius
  if (!(centre > 0)) return null
  const discriminant = radiusSq - alongSq - centre * centre * sinSqTheta
  if (discriminant < 0) return null
  return Math.max(0, centre * cosTheta - Math.sqrt(discriminant))
}

/**
 * The **outer** radius at which the cutter body ends along a cell's ray, or
 * `null` when the body does not reach that ray.
 *
 * The body occupies the radial interval between the lower surface
 * ({@link contactAt}) and this exit: a flat's cylinder, or for a ball the union
 * of the sphere's far root and the **shank** above its equator (a cylinder of
 * the same radius, which a ray near the axis meets at any radius above the ball
 * centre). Material *above* the exit is beyond the cutter's flank and stays; a
 * single-value cell may only be written down to the contact when the exit is at
 * or above the material's top, i.e. when the cut removes the whole standing
 * column and not just an interval inside it. This is the "disc at the tip **and
 * the cylinder**" half of the radial model: omitting it lets a grazing side cut
 * look like a full-depth plunge and leaves material the grid has already
 * written off.
 */
function exitAt(
  ball: boolean,
  cutterRadius: number,
  tip: number,
  cosTheta: number,
  sinSqTheta: number,
  dx: number,
): number | null {
  if (contactAt(ball, cutterRadius, tip, cosTheta, sinSqTheta, dx) === null) return null
  const radiusSq = cutterRadius * cutterRadius
  const alongSq = dx * dx
  if (!ball) {
    // A flat's exit is its cylinder: `sqrt(r^2 - dx^2) / |sin dTheta|`, infinite
    // on the tool's own ray (the cylinder is parallel to it).
    if (!(sinSqTheta > 0)) return Number.POSITIVE_INFINITY
    return Math.sqrt(radiusSq - alongSq) / Math.sqrt(sinSqTheta)
  }
  const centre = tip + cutterRadius
  const discriminant = radiusSq - alongSq - centre * centre * sinSqTheta
  if (!(discriminant >= 0)) return null
  const sphereExit = centre * cosTheta + Math.sqrt(discriminant)
  // Above the sphere the tool is a cylinder of the same radius (the shank): a
  // ray that passes through the shank's radius outside the ball still meets the
  // body, so the material above the sphere's far root is not automatically left
  // standing. The shank's interval starts where the ball's equator begins
  // (`(tip + r) / cos`) and ends at the cylinder's wall.
  const sinTheta = Math.sqrt(sinSqTheta)
  const shankStart = centre / cosTheta
  const shankExit = sinTheta > 1e-12 ? Math.sqrt(radiusSq - alongSq) / sinTheta : Number.POSITIVE_INFINITY
  return shankStart <= shankExit ? Math.max(sphereExit, shankExit) : sphereExit
}

/**
 * Lower the grid to what one cutter sample leaves, and report the sample's
 * radial engagement: the deepest standing material found inside the cutter's
 * footprint before it is removed.
 *
 * A cell is evaluated at **its own** along coordinate and angular ray, exactly
 * as the slice-E design asks: the contact is the radius at which that ray meets
 * the cutter's lower surface ({@link contactAt}), and the cut only writes the
 * cell down to it when the body's outer wall ({@link exitAt}) stands at or above
 * the cell's material. Material above the wall — the outer side of a slot the
 * cutter has not reached — survives, so a grazing cut is never recorded as a
 * full-depth plunge.
 *
 * The cell holds the **largest** material anywhere in it, so reading that value
 * against the sample's own ray is what makes the engagement an over-estimate:
 * a corner cusp carried at the cell's edge is charged at full radius even when
 * the sample's ray is a fraction of a bin away. The angular resolution rule in
 * {@link createSquareSweepState} keeps that over-estimate within the tolerance
 * {@link guardSquareOperation} states for it.
 */
function cutSample(
  state: SquareSweepState,
  sample: GuardSample,
  cutterRadius: number,
  ball: boolean,
): number {
  if (!(cutterRadius > 0) || !Number.isFinite(cutterRadius)) return Number.NEGATIVE_INFINITY
  if (!Number.isFinite(sample.tip) || !Number.isFinite(sample.along) || !Number.isFinite(sample.angle)) {
    return Number.NEGATIVE_INFINITY
  }
  const { material, angleBins, alongBins, alongBin, alongStart, angleBinDegrees } = state
  const radius = cutterRadius
  const alongIndex = Math.floor((sample.along - alongStart) / alongBin)
  const spanAlong = Math.ceil(radius / alongBin) + 1
  const i0 = Math.max(0, alongIndex - spanAlong)
  const i1 = Math.min(alongBins - 1, alongIndex + spanAlong)
  if (i1 < i0) return Number.NEGATIVE_INFINITY
  // The widest angular offset the body can reach, from the axis ray at dx = 0:
  // `asin(r / tip)` for a flat, `asin(r / (tip + r))` for a ball (both clamped,
  // and a tip at or below the pivot can reach the whole turn). One extra bin on
  // each side covers the cell's own angular extent.
  const tip = sample.tip
  let halfSpan = Math.PI
  if (tip > 0) {
    halfSpan = ball
      ? Math.asin(Math.min(1, radius / (tip + radius)))
      : Math.asin(Math.min(1, radius / tip))
  }
  const halfSpanBins = Math.min(angleBins, Math.ceil(halfSpan / GUARD_ANGLE_BIN_RADIANS) + 1)
  const wrapped = ((sample.angle % 360) + 360) % 360
  const sampleBin = wrapped / angleBinDegrees
  const firstBin = Math.floor(sampleBin)
  const tables = guardTrig()
  // The centre of the first bin in the window sits `phase` radians from the
  // sample; every later bin adds exactly one bin. Cosine of that sequence is a
  // rotation of the precomputed bin table, so the hot loop is arithmetic only.
  const phase = (firstBin + 0.5 - sampleBin) * GUARD_ANGLE_BIN_RADIANS
  const sinPhase = Math.sin(phase)
  const cosPhase = Math.cos(phase)
  const width = 2 * halfSpanBins + 1
  if (offsetScratch.length < width) offsetScratch = new Float64Array(width)
  const cosines = offsetScratch
  for (let j = 0; j < width; j++) {
    const offset = j - halfSpanBins
    const index = wrapBin(offset)
    cosines[j] = cosPhase * tables.cos[index] - sinPhase * tables.sin[index]
  }
  let engagement = Number.NEGATIVE_INFINITY
  for (let i = i0; i <= i1; i++) {
    const alongDelta = alongStart + (i + 0.5) * alongBin - sample.along
    if (Math.abs(alongDelta) >= radius) continue
    const rowOffset = i * angleBins
    for (let offset = -halfSpanBins; offset <= halfSpanBins; offset++) {
      const index = wrapBin(firstBin + offset)
      const materialRadius = material[rowOffset + index]
      if (!(materialRadius > 0)) continue
      const cosDelta = Math.max(-1, Math.min(1, cosines[offset + halfSpanBins]))
      const sinSqDelta = Math.max(0, 1 - cosDelta * cosDelta)
      const contact = contactAt(ball, radius, tip, cosDelta, sinSqDelta, alongDelta)
      if (contact === null) continue
      const exit = exitAt(ball, radius, tip, cosDelta, sinSqDelta, alongDelta)
      if (exit === null || exit < materialRadius) continue
      const engagementHere = materialRadius - contact
      if (engagementHere > engagement) engagement = engagementHere
      if (contact < materialRadius) material[rowOffset + index] = contact
    }
  }
  return engagement
}

/** Wrap a whole-bin offset into the precomputed table's range. */
function wrapBin(offset: number): number {
  const bins = GUARD_ANGLE_BIN_COUNT
  return ((offset % bins) + bins) % bins
}
