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
    if (turns) {
      if (!around) return { admitted: false, reason: 'turn' }
      // A full turn at one along position and one tip radius visits every cell
      // in its band; the per-step loop below would pay for the same cells on
      // every one of its ~720 samples. `cutFullTurn` produces exactly the same
      // grid and engagement in one pass over the band (#1045 slice G). Only a
      // move whose tip and along are constant qualifies: with either varying,
      // the nearest sample is not the cell's lowest contact and the shortcut's
      // bound no longer holds.
      const tipChange = Math.abs(move.to.z - move.from.z)
      if (alongTo === alongFrom && tipChange <= bandTipVariation(state)) {
        const lowTip = Math.min(move.from.z, move.to.z) - pivot
        const highTip = Math.max(move.from.z, move.to.z) - pivot
        const engagement = cutBand(state, alongFrom, controller, end, lowTip, highTip, cutterRadius, ball)
        if (engagement > bound) return { admitted: false, reason: 'turn' }
      } else {
        for (let step = 0; step <= steps; step++) {
          const fraction = step / steps
          // Scalars, not a sample object: this loop runs millions of times on a
          // long stubbed rough, and the guard allocates nothing per sample.
          const along = alongFrom + (alongTo - alongFrom) * fraction
          const angle = controller + (end - controller) * fraction
          const tip = move.from.z + (move.to.z - move.from.z) * fraction - pivot
          const engagement = cutSample(state, along, angle, tip, cutterRadius, ball)
          if (engagement > bound) return { admitted: false, reason: 'turn' }
        }
      }
    } else {
      for (let step = 0; step <= steps; step++) {
        const fraction = step / steps
        cutSample(
          state,
          alongFrom + (alongTo - alongFrom) * fraction,
          controller + (end - controller) * fraction,
          move.from.z + (move.to.z - move.from.z) * fraction - pivot,
          cutterRadius,
          ball,
        )
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
/** Scratch for one sample: the rotated cosines, their squared sines, and the
 * per-sample product that scales them. Grown as needed and reused, so the cell
 * loop allocates nothing. */
let offsetScratch = new Float64Array(0)
let sinSqScratch = new Float64Array(0)
let radialScratch = new Float64Array(0)
let inverseScratch = new Float64Array(0)
let inverseSineScratch = new Float64Array(0)
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
 * Lower the grid to what one cutter sample leaves, and report the sample's
 * radial engagement: the deepest standing material found inside the cutter's
 * footprint before it is removed.
 *
 * A cell is evaluated at **its own** along coordinate and angular ray: the
 * contact is the radius at which that ray meets the cutter's lower surface, and
 * the cut only writes the cell down to it when the body's outer wall stands at
 * or above the cell's material. Material above the wall -- the outer side of a
 * slot the cutter has not reached -- survives, so a grazing cut is never
 * recorded as a full-depth plunge.
 *
 * The lower surface is the flat's **disc at the tip** (`tip / cos(dTheta)`,
 * while the ray is still inside the cutter's radius, `|tip tan| <= reach`) or
 * the ball's **sphere** near root (`centre cos - sqrt(reach^2 - centre^2
 * sin^2)`). The outer wall is the flat's cylinder, or for a ball the union of
 * the sphere's far root and the **shank** above its equator. Recording `tip`
 * instead of the disc's radial contact is the slice-E defect the review found;
 * omitting the wall lets a grazing side cut look like a full-depth plunge and
 * leaves material the grid has already written off. `reach = sqrt(r^2 - dx^2)`
 * is the row's cross-section radius, `centre = tip + r` the ball's centre.
 *
 * The cell holds the **largest** material anywhere in it, so reading that value
 * against the sample's own ray is what makes the engagement an over-estimate:
 * a corner cusp carried at the cell's edge is charged at full radius even when
 * the sample's ray is a fraction of a bin away. The angular resolution rule in
 * {@link createSquareSweepState} keeps that over-estimate within the tolerance
 * {@link guardSquareOperation} states for it.
 *
 * This is the export check's hot path -- on a 1 m stubbed rough virtually all of
 * the guard's time is here (#1045 slice G) -- so the terms that do not depend on
 * the cell are hoisted (the sample's tip and centre; each row's reach; each
 * offset's `sin^2` and the two products that only use it), the contact and wall
 * are one inlined calculation instead of two helper calls, a cell whose contact
 * cannot reach its material is skipped before the wall is computed, a ray the
 * row's cross-section does not reach is rejected by one comparison, and bin
 * indices wrap with integer arithmetic. Only the cells a row's footprint covers
 * are ever read, and nothing is allocated per cell.
 */
function cutSample(
  state: SquareSweepState,
  along: number,
  angle: number,
  tip: number,
  cutterRadius: number,
  ball: boolean,
): number {
  if (!(cutterRadius > 0) || !Number.isFinite(cutterRadius)) return Number.NEGATIVE_INFINITY
  if (!Number.isFinite(tip) || !Number.isFinite(along) || !Number.isFinite(angle)) {
    return Number.NEGATIVE_INFINITY
  }
  const { material, angleBins, alongBins, alongBin, alongStart, angleBinDegrees } = state
  const radius = cutterRadius
  const radiusSq = radius * radius
  const alongIndex = Math.floor((along - alongStart) / alongBin)
  const spanAlong = Math.ceil(radius / alongBin) + 1
  const i0 = Math.max(0, alongIndex - spanAlong)
  const i1 = Math.min(alongBins - 1, alongIndex + spanAlong)
  if (i1 < i0) return Number.NEGATIVE_INFINITY
  // The widest angular offset the body can reach, from the axis ray at dx = 0:
  // `asin(r / tip)` for a flat, `asin(r / (tip + r))` for a ball (both clamped,
  // and a tip at or below the pivot can reach the whole turn). One extra bin on
  // each side covers the cell's own angular extent.
  let halfSpan = Math.PI
  if (tip > 0) {
    halfSpan = ball ? Math.asin(Math.min(1, radius / (tip + radius))) : Math.asin(Math.min(1, radius / tip))
  }
  const halfSpanBins = Math.min(angleBins, Math.ceil(halfSpan / GUARD_ANGLE_BIN_RADIANS) + 1)
  const wrapped = ((angle % 360) + 360) % 360
  const sampleBin = wrapped / angleBinDegrees
  const firstBin = Math.floor(sampleBin)
  const tables = guardTrig()
  // The centre of the first bin in the window sits `phase` radians from the
  // sample; every later bin adds exactly one bin. Cosine of that sequence is a
  // rotation of the precomputed bin table, so the cell loop is arithmetic only.
  const phase = (firstBin + 0.5 - sampleBin) * GUARD_ANGLE_BIN_RADIANS
  const sinPhase = Math.sin(phase)
  const cosPhase = Math.cos(phase)
  const width = 2 * halfSpanBins + 1
  if (offsetScratch.length < width) {
    offsetScratch = new Float64Array(width)
    sinSqScratch = new Float64Array(width)
    radialScratch = new Float64Array(width)
    inverseScratch = new Float64Array(width)
    inverseSineScratch = new Float64Array(width)
  }
  const cosines = offsetScratch
  const sinSquares = sinSqScratch
  const radialProducts = radialScratch
  const inverseCosines = inverseScratch
  const inverseSines = inverseSineScratch
  // Per-sample terms: the ball's centre and the two products that scale a cell's
  // squared sine by a constant for the whole sample. The reciprocals are per
  // angular offset alone, so the cell loop never divides.
  const centre = ball ? tip + radius : 0
  const centreSq = centre * centre
  const tipSq = tip * tip
  for (let j = 0; j < width; j++) {
    const offset = j - halfSpanBins
    const index = wrapBin(offset)
    const cosDelta = Math.max(-1, Math.min(1, cosPhase * tables.cos[index] - sinPhase * tables.sin[index]))
    const sinSq = Math.max(0, 1 - cosDelta * cosDelta)
    cosines[j] = cosDelta
    sinSquares[j] = sinSq
    radialProducts[j] = ball ? centreSq * sinSq : tipSq * sinSq
    inverseCosines[j] = cosDelta > 0 ? 1 / cosDelta : Number.POSITIVE_INFINITY
    inverseSines[j] = sinSq > 0 ? 1 / Math.sqrt(sinSq) : Number.POSITIVE_INFINITY
  }
  let engagement = Number.NEGATIVE_INFINITY
  for (let i = i0; i <= i1; i++) {
    const alongDelta = alongStart + (i + 0.5) * alongBin - along
    const alongSq = alongDelta * alongDelta
    if (alongSq >= radiusSq) continue
    const reachSq = radiusSq - alongSq
    const reach = Math.sqrt(reachSq)
    // Only the cells this row's cutter cross-section reaches: a flat's disc
    // covers the ray while `|tip tan| <= reach`, a ball's sphere while
    // `centre sin <= reach`. The angular half-extent turned into a bin range
    // means a row never iterates a cell outside its own footprint.
    let rowHalf = Math.PI
    if (tip > 0) {
      rowHalf = ball
        ? (centre > 0 ? Math.asin(Math.min(1, reach / centre)) : 0)
        : Math.atan2(reach, tip)
    }
    const firstSlot = Math.max(0, Math.ceil((phase - rowHalf) / GUARD_ANGLE_BIN_RADIANS) + halfSpanBins - 1)
    const lastSlot = Math.min(width - 1, Math.floor((phase + rowHalf) / GUARD_ANGLE_BIN_RADIANS) + halfSpanBins + 1)
    if (lastSlot < firstSlot) continue
    const rowOffset = i * angleBins
    // A row's window is at most `rowHalf + 2.5 bins` either side. Below 80
    // degrees the cosine of that is still positive, so the shoulder test is not
    // needed at all -- the common case for a generated cutter.
    const needsAxisCheck = rowHalf > 1.4
    let index = firstBin + firstSlot - halfSpanBins
    while (index < 0) index += angleBins
    while (index >= angleBins) index -= angleBins
    for (let slot = firstSlot; slot <= lastSlot; slot++, index++) {
      if (index === angleBins) index = 0
      const cosDelta = cosines[slot]
      if (needsAxisCheck && !(cosDelta > 1e-9)) continue
      const materialRadius = material[rowOffset + index]
      let contact: number
      if (ball) {
        if (!(centre > 0)) continue
        const discriminant = reachSq - radialProducts[slot]
        if (discriminant < 0) continue
        // The contact clears the cell unless `centre cos - sqrt(d)` is below
        // the material. Square that comparison so the square root -- and the
        // wall below -- is only paid for a cell this cut actually reaches.
        const delta = centre * cosDelta - materialRadius
        if (delta > 0 && delta * delta >= discriminant) continue
        const root = Math.sqrt(discriminant)
        contact = centre * cosDelta - root
        if (contact < 0) contact = 0
        if (!(materialRadius > contact)) continue
        // The body ends at the farther of the sphere's far root and the shank
        // above its equator; the cell stands only if that wall is below it.
        const sphereExit = centre * cosDelta + root
        const shankExit = reach * inverseSines[slot]
        const shankStart = centre * inverseCosines[slot]
        const exit = shankStart <= shankExit ? Math.max(sphereExit, shankExit) : sphereExit
        if (exit < materialRadius) continue
      } else {
        // The ray must still be inside the disc (`|tip tan| <= reach`), and the
        // material is cleared only when `tip < material * cos`, so the division
        // is only paid for a cell this cut actually reaches.
        if (radialProducts[slot] > reachSq * cosDelta * cosDelta) continue
        if (!(tip < materialRadius * cosDelta)) continue
        contact = tip * inverseCosines[slot]
        if (contact < 0) contact = 0
        const exit = reach * inverseSines[slot]
        if (exit < materialRadius) continue
      }
      const engagementHere = materialRadius - contact
      if (engagementHere > engagement) engagement = engagementHere
      material[rowOffset + index] = contact
    }
  }
  return engagement
}

/**
 * The largest tip change across one around move the band pass may absorb: a
 * tenth of the guard's own angular tolerance. Both of the band pass's errors --
 * the engagement over-estimate and the lowering over-estimate -- scale with this
 * change, so holding it to a tenth of the tolerance keeps them far inside the
 * bound the operation is judged against.
 */
function bandTipVariation(state: SquareSweepState): number {
  return 0.1 * state.maxMaterial * (state.angleBinDegrees * Math.PI / 180)
}

/**
 * Apply one around move at a constant along position in a single pass over its
 * band (#1045 slice G).
 *
 * A move's commanded samples are `(end - start) / steps` degrees apart. For any
 * cell the cutter's contact falls as a sample approaches the cell's angle and
 * rises again after it passes, so the **lowest** contact the move reaches there
 * is the contact at the nearest sample; the move's engagement at that cell is
 * `material - that contact`, and the material it leaves is that contact. Walking
 * every sample therefore repeats the same cell calculation as each sample passes
 * over it: this function visits each cell of the move's band **once** and takes
 * the nearest sample's contact. A 360-degree ring, a 5-degree wobble segment and
 * the merge's flat rings all reduce to the same pass, and on a 1 m stubbed rough
 * this is most of the export check's cell visits.
 *
 * A cell outside the move's angle interval is reached only by an endpoint
 * sample, so its nearest sample is that endpoint. The band is the interval
 * widened by the row's own footprint and is walked once (its width is below a
 * turn unless the tip is at or below the pivot, and then every cell is in it).
 *
 * The move's tip is not exactly constant -- a generated ring's height map
 * wobbles by a few thousandths of a millimetre -- so the caller passes the
 * move's low and high tip. The engagement is measured from `tipLow`, a lower
 * contact than any sample's, so it **over**-estimates; the material is lowered
 * to the contact at `tipHigh`, an upper contact, so the grid never under-states
 * what stands. The caller bounds the tip variation to a tenth of the guard's own
 * angular tolerance, so both errors stay well inside it.
 */
function cutBand(
  state: SquareSweepState,
  along: number,
  angleStart: number,
  angleEnd: number,
  tipLow: number,
  tipHigh: number,
  cutterRadius: number,
  ball: boolean,
): number {
  if (!(cutterRadius > 0) || !Number.isFinite(cutterRadius)) return Number.NEGATIVE_INFINITY
  if (!Number.isFinite(tipLow) || !Number.isFinite(tipHigh) || !Number.isFinite(along)
    || !Number.isFinite(angleStart) || !Number.isFinite(angleEnd)) {
    return Number.NEGATIVE_INFINITY
  }
  const { material, angleBins, alongBins, alongBin, alongStart, angleBinDegrees } = state
  const radius = cutterRadius
  const radiusSq = radius * radius
  const a0 = Math.min(angleStart, angleEnd)
  const a1 = Math.max(angleStart, angleEnd)
  const span = a1 - a0
  const steps = Math.max(1, Math.ceil(span / GUARD_ANGLE_BIN_DEGREES))
  const stepDegrees = span / steps
  const alongIndex = Math.floor((along - alongStart) / alongBin)
  const spanAlong = Math.ceil(radius / alongBin) + 1
  const i0 = Math.max(0, alongIndex - spanAlong)
  const i1 = Math.min(alongBins - 1, alongIndex + spanAlong)
  if (i1 < i0) return Number.NEGATIVE_INFINITY
  // The cutter's footprint is widest at the move's lowest tip, so that is the
  // one the band must cover.
  const lowCentre = ball ? tipLow + radius : 0
  const lowCentreSq = lowCentre * lowCentre
  const highCentre = ball ? tipHigh + radius : 0
  const highCentreSq = highCentre * highCentre
  const highTipSq = tipHigh * tipHigh
  let engagement = Number.NEGATIVE_INFINITY
  for (let i = i0; i <= i1; i++) {
    const alongDelta = alongStart + (i + 0.5) * alongBin - along
    const alongSq = alongDelta * alongDelta
    if (alongSq >= radiusSq) continue
    const reachSq = radiusSq - alongSq
    const reach = Math.sqrt(reachSq)
    const rowHalf = tipLow > 0
      ? (ball ? (lowCentre > 0 ? Math.asin(Math.min(1, reach / lowCentre)) : 0) : Math.atan2(reach, tipLow))
      : Math.PI
    const rowHalfDegrees = Math.min(180, rowHalf * 180 / Math.PI)
    const rowOffset = i * angleBins
    // The cells this row's footprint can reach: the move's interval widened by
    // the row's own half-extent, plus one bin for the cell it sits in. A band at
    // least a full turn wide is simply every bin, walked once.
    const loDegrees = a0 - rowHalfDegrees
    const hiDegrees = a1 + rowHalfDegrees
    const firstCell = hiDegrees - loDegrees >= 360
      ? 0
      : Math.ceil(loDegrees / angleBinDegrees - 0.5) - 1
    const lastCell = hiDegrees - loDegrees >= 360
      ? angleBins - 1
      : Math.floor(hiDegrees / angleBinDegrees - 0.5) + 1
    for (let cell = firstCell; cell <= lastCell; cell++) {
      const k = ((cell % angleBins) + angleBins) % angleBins
      const cellAngle = (k + 0.5) * angleBinDegrees
      // The distance from the move's start, on the circle, and then the nearest
      // sample's signed angular offset: inside the interval the nearest of the
      // evenly spaced samples, outside it the nearer endpoint.
      const fromStart = ((cellAngle - a0) % 360 + 360) % 360
      let offset: number
      if (fromStart <= span) {
        offset = fromStart - Math.round(fromStart / stepDegrees) * stepDegrees
      } else {
        const toStart = 360 - fromStart
        const toEnd = fromStart - span
        offset = toStart <= toEnd ? -toStart : toEnd
      }
      const offsetRadians = offset * Math.PI / 180
      if (Math.abs(offsetRadians) > rowHalf + GUARD_ANGLE_BIN_RADIANS) continue
      const cosDelta = Math.cos(offsetRadians)
      if (!(cosDelta > 1e-9)) continue
      const index = rowOffset + k
      const materialRadius = material[index]
      const sinSq = Math.max(0, 1 - cosDelta * cosDelta)
      let contactHigh = Number.POSITIVE_INFINITY
      let covers = false
      if (ball) {
        if (highCentre > 0) {
          const discriminant = reachSq - highCentreSq * sinSq
          if (discriminant >= 0) {
            const root = Math.sqrt(discriminant)
            contactHigh = highCentre * cosDelta - root
            if (contactHigh < 0) contactHigh = 0
            const sphereExit = highCentre * cosDelta + root
            const sinTheta = Math.sqrt(sinSq)
            const shankStart = highCentre / cosDelta
            const shankExit = sinTheta > 1e-12 ? reach / sinTheta : Number.POSITIVE_INFINITY
            const exit = shankStart <= shankExit ? Math.max(sphereExit, shankExit) : sphereExit
            covers = exit >= materialRadius
          }
        }
      } else {
        if (highTipSq * sinSq <= reachSq * cosDelta * cosDelta) {
          contactHigh = highTipSq > 0 ? tipHigh / cosDelta : 0
          const exit = sinSq > 0 ? reach / Math.sqrt(sinSq) : Number.POSITIVE_INFINITY
          covers = exit >= materialRadius
        }
      }
      // The engagement is measured from the lowest contact the move can have,
      // which over-states it; a cut the wall keeps off the cell cannot lower it.
      let crossed = false
      let contactLow = 0
      if (ball) {
        if (lowCentre > 0) {
          const discriminant = reachSq - lowCentreSq * sinSq
          if (discriminant >= 0) {
            contactLow = lowCentre * cosDelta - Math.sqrt(discriminant)
            if (contactLow < 0) contactLow = 0
            crossed = true
          }
        }
      } else if (!(tipLow * tipLow * sinSq > reachSq * cosDelta * cosDelta)) {
        contactLow = tipLow > 0 ? tipLow / cosDelta : 0
        crossed = true
      }
      if (crossed && materialRadius > contactLow) {
        const depth = materialRadius - contactLow
        if (depth > engagement) engagement = depth
      }
      if (covers && materialRadius > contactHigh) material[index] = contactHigh
    }
  }
  return engagement
}

/** Wrap a whole-bin offset into the precomputed table's range. */
function wrapBin(offset: number): number {
  const bins = GUARD_ANGLE_BIN_COUNT
  return ((offset % bins) + bins) % bins
}
