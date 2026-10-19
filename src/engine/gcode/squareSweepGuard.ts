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
 * - rasterises conservatively (#1045 slice H). A cell is a rectangle in
 *   (along, angle), not a point at its centre. A cut **lowers** a cell only when
 *   its body covers the **whole** cell along and in angle, and then only to the
 *   highest contact radius it leaves anywhere in it (the far corner: a flat's
 *   `tip / cos(dTheta)` and a ball's contact both rise away from the sample).
 *   A cell the cutter touches only in part keeps its standing material, so a
 *   ridge the cutter cannot reach is never written off. **Engagement** is
 *   measured against the highest material of every cell the cutter touches at
 *   all -- the cell's `material` is that highest radius -- less the **near**
 *   corner's contact, the deepest point the sample reaches in the cell. Charging
 *   the whole-cell maximum at the nearest point is the over-estimate that keeps
 *   the grid from ever under-stating a bite;
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
 * blank's surface, the ball's own radial change across one along cell, and
 * the emitted Z's rounding. The grid itself cannot make a cut look deeper than
 * it is: a cut that covers the **whole** cell is charged against the cell's
 * **highest** material at the far corner, and lowering writes that same far
 * corner; a cut that covers only part of the cell is charged against the cell's
 * along-centre sample, which follows the last cut that reached that part, and
 * only that sample is lowered. Neither direction can make a cut look deeper
 * than it is. The angular term is exactly the material variation the whole-cell
 * maximisation can hide inside one bin.
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
  /**
   * The along interval the **whole program** can remove material in: every cut
   * move's along position plus its cutter radius. Material outside it is never
   * touched (#1045 slice H), so a cell that straddles this boundary may ignore
   * its outside part -- otherwise the retained shoulder at the end of a rough's
   * cut range would be charged against every later layer there.
   */
  readonly materialAlongLow: number
  readonly materialAlongHigh: number
  readonly material: Float64Array
  /**
   * The standing material at the cell's **along centre** (#1045 slice H). A cut
   * that only partly covers a cell lowers this sample and is charged against it,
   * so a `stepdown` at the covered part is not charged against blank material
   * that stands a cell away at the far edge. A cut that covers the whole cell
   * uses `material`, the cell's true maximum, so the untouched far side can
   * never be written off by a centre evaluation.
   */
  readonly centreMaterial: Float64Array
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
export function createSquareSweepState(
  stock: BarStock,
  minCutterRadius: number,
  materialAlongRange?: { readonly low: number; readonly high: number },
): SquareSweepState {
  const bounds = stockBoundsAlong(stock)
  const length = Math.max(0, bounds.upper - bounds.lower)
  // The program's cut range, clamped to the stock. Without one, no range is
  // assumed and every cell is treated as reachable (the caller did not say).
  const rangeLow = materialAlongRange && Number.isFinite(materialAlongRange.low)
    ? Math.min(bounds.upper, Math.max(bounds.lower, materialAlongRange.low))
    : bounds.lower
  const rangeHigh = materialAlongRange && Number.isFinite(materialAlongRange.high)
    ? Math.min(bounds.upper, Math.max(bounds.lower, materialAlongRange.high))
    : bounds.upper
  const materialAlongLow = Math.min(rangeLow, rangeHigh)
  const materialAlongHigh = Math.max(rangeLow, rangeHigh)
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
      materialAlongLow,
      materialAlongHigh,
      material: new Float64Array(0),
      centreMaterial: new Float64Array(0),
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
  // never cuts simply keeps the blank there. A cell is the **largest** blank
  // radius anywhere in its angular span, so a corner cusp that falls between two
  // bin centres is carried at full radius rather than lost (#1045 slice H).
  const row = new Float64Array(angleBins)
  for (let k = 0; k < angleBins; k++) {
    row[k] = blankCellRadius(stock, k * GUARD_ANGLE_BIN_DEGREES, (k + 1) * GUARD_ANGLE_BIN_DEGREES)
  }
  const centreMaterial = new Float64Array(alongBins * angleBins)
  for (let i = 0; i < alongBins; i++) {
    const base = i * angleBins
    material.set(row, base)
    centreMaterial.set(row, base)
  }
  return {
    stock,
    angleBins,
    angleBinDegrees: GUARD_ANGLE_BIN_DEGREES,
    alongBins,
    alongBin,
    alongStart: bounds.lower,
    materialAlongLow,
    materialAlongHigh,
    material,
    centreMaterial,
    maxMaterial,
    roughAllowance: new Map(),
    resolutionRefused: false,
  }
}

/**
 * The along interval the whole program can remove material in: every **cut**
 * move's along position plus its cutter radius (#1045 slice H). A rapid removes
 * nothing and is excluded (a traverse would otherwise widen the range to the
 * whole bar). Material outside this interval is never touched by the program,
 * so the guard may ignore it at a cell that straddles the boundary; without it,
 * the retained shoulder at the end of a rough's cut range would be charged
 * against every later layer there and a normal rough would be refused.
 *
 * Returns `undefined` when the operations carry no cut move.
 */
export function squareMaterialAlongRange(
  stock: BarStock,
  operations: ReadonlyArray<{ readonly moves: readonly ToolpathMove[]; readonly radius: number }>,
): { low: number; high: number } | undefined {
  let low = Number.POSITIVE_INFINITY
  let high = Number.NEGATIVE_INFINITY
  let found = false
  for (const entry of operations) {
    const radius = Number.isFinite(entry.radius) && entry.radius > 0 ? entry.radius : 0
    for (const move of entry.moves) {
      if (move.kind !== 'cut') continue
      const from = alongOf(stock, move.from)
      const to = alongOf(stock, move.to)
      low = Math.min(low, Math.min(from, to) - radius)
      high = Math.max(high, Math.max(from, to) + radius)
      found = true
    }
  }
  return found ? { low, high } : undefined
}

function stockBoundsAlong(stock: BarStock): { lower: number; upper: number } {
  const bounds = getStockBounds(stock)
  return stock.axis === 'x'
    ? { lower: bounds.minX, upper: bounds.maxX }
    : { lower: bounds.minY, upper: bounds.maxY }
}

/**
 * The largest blank radius anywhere in the angular cell `[startDeg, endDeg]`.
 *
 * A cell holds one radius, so it must hold the largest one it can still stand:
 * the maximum of the ray radius over the cell, which for a square blank is an
 * endpoint or a corner (`45 + 90n`) inside the span. Taking the bin centre --
 * the slice-G model -- under-states a corner that falls between centres, so a
 * cut at the corner could be charged against flat-side material (#1045 slice H).
 */
function blankCellRadius(stock: BarStock, startDeg: number, endDeg: number): number {
  let max = Math.max(barSurfaceRadius(stock, startDeg), barSurfaceRadius(stock, endDeg))
  for (let corner = 45; corner < 360; corner += 90) {
    if (corner > startDeg && corner < endDeg) max = Math.max(max, barSurfaceRadius(stock, corner))
  }
  return max
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
 * The radial error one along cell can hide, for the cutter shape in use.
 *
 * Engagement is measured at the cell's **far** along corner (#1045 slice H),
 * which is where a whole-cell cut leaves the highest material; if the standing
 * material is instead at the near corner, the measurement is low by the ball's
 * own rise across the cell, `r - sqrt(r² - alongBin²)`. A flat's lower surface
 * does not change with along offset, so its term is zero. (When a grid was
 * capped wider than the ball, the bound saturates at `r`.)
 */
function alongBinRadialError(ball: boolean, cutterRadius: number, alongBin: number): number {
  if (!ball || !(cutterRadius > 0) || !Number.isFinite(cutterRadius) || !(alongBin > 0)) return 0
  return cutterRadius - Math.sqrt(Math.max(0, cutterRadius * cutterRadius - alongBin * alongBin))
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
/** Scratch for one sample: the rotated cosines of whole cell **edges** (not
 * centres), grown as needed and reused, so the cell loop allocates nothing. */
let edgeCosScratch = new Float64Array(0)
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
 * radial engagement: the deepest standing material the cutter body touches
 * before it is removed (#1045 slices E, F and H).
 *
 * A grid **cell** is a rectangle in (along, angle): `[i*alongBin, (i+1)*alongBin]`
 * by `[k*bin, (k+1)*bin]`. The slice-G loop evaluated the rectangle at its
 * centre, which let a cut write off a cell it only grazed and left material the
 * grid had already forgotten (#1045 slice H: two cuts leaving a 0.05 mm strip
 * untouched still lowered the cells around it). Both operations now use the
 * cell's corners:
 *
 * - a cut that covers the **whole** cell (the near corner and the **far**
 *   corner, at the far along corner's smaller cross-section) is charged against
 *   the cell's `material`, the highest radius anywhere in it, at the **far**
 *   corner's contact -- the point the cut leaves highest. Lowering writes that
 *   same far corner, the highest radius the cut leaves in the rectangle;
 * - a cut that covers only part of the cell cannot write the far side off. It is
 *   charged against `centreMaterial`, the cell's along-centre sample, and lowers
 *   only that sample. The cell's whole-cell `material` keeps whatever the far
 *   side still stands, so the uncut strip between two cells can no longer be
 *   erased by a centre evaluation (the review's 0.05 mm strip), while a normal
 *   layer boundary does not charge blank material a whole cell away.
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
 * This is the export check's hot path -- on a 1 m stubbed rough virtually all of
 * the guard's time is here (#1045 slice G) -- so the terms that do not depend on
 * the cell are hoisted, the contact and wall are one inlined calculation instead
 * of two helper calls, the cosine of each cell **edge** is a rotation of the
 * precomputed bin table (so the loop never calls `Math.sin` or `Math.cos`), and
 * bin indices wrap with integer arithmetic. Nothing is allocated per cell.
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
  const halfAlongBin = alongBin * 0.5
  const alongIndex = Math.floor((along - alongStart) / alongBin)
  const spanAlong = Math.ceil(radius / alongBin) + 1
  const i0 = Math.max(0, alongIndex - spanAlong)
  const i1 = Math.min(alongBins - 1, alongIndex + spanAlong)
  if (i1 < i0) return Number.NEGATIVE_INFINITY
  // The widest angular offset the body can reach, from the axis ray at dx = 0:
  // `asin(r / tip)` for a flat, `asin(r / (tip + r))` for a ball (both clamped,
  // and a tip at or below the pivot can reach the whole turn). One extra cell on
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
  // The left edge of the first cell in the window sits `phase` radians from the
  // sample; every later edge adds exactly one bin, so its cosine is a rotation
  // of the precomputed bin table and the cell loop is arithmetic only.
  const edgeBase = firstBin - halfSpanBins - 1
  const phase = (edgeBase - sampleBin) * GUARD_ANGLE_BIN_RADIANS
  const sinPhase = Math.sin(phase)
  const cosPhase = Math.cos(phase)
  const cells = 2 * halfSpanBins + 3
  if (edgeCosScratch.length < cells + 1) edgeCosScratch = new Float64Array(cells + 1)
  const edgeCos = edgeCosScratch
  for (let j = 0; j <= cells; j++) {
    const index = wrapBin(j)
    const cosDelta = Math.max(-1, Math.min(1, cosPhase * tables.cos[index] - sinPhase * tables.sin[index]))
    edgeCos[j] = cosDelta
  }
  const centre = ball ? tip + radius : 0
  const centreSq = centre * centre
  const tipSq = tip * tip
  let engagement = Number.NEGATIVE_INFINITY
  for (let i = i0; i <= i1; i++) {
    const cellCentre = alongStart + (i + 0.5) * alongBin
    // Only the part of the cell inside the program's material range can ever be
    // cut; the retained shoulder beyond it is not this program's material.
    const insideLow = Math.max(cellCentre - halfAlongBin, state.materialAlongLow)
    const insideHigh = Math.min(cellCentre + halfAlongBin, state.materialAlongHigh)
    if (!(insideHigh > insideLow)) continue
    const distanceAlong = along < insideLow ? insideLow - along : along > insideHigh ? along - insideHigh : 0
    // A cell is *touched* when its nearest reachable along edge is inside the
    // body, and *covered* only when its farthest one is. Both corners matter.
    const dxNear = distanceAlong
    if (!(dxNear < radius)) continue
    const reachNearSq = radiusSq - dxNear * dxNear
    const reachNear = Math.sqrt(reachNearSq)
    const dxFar = Math.max(Math.abs(along - insideLow), Math.abs(along - insideHigh))
    const fullAlong = dxFar < radius
    const reachFarSq = fullAlong ? radiusSq - dxFar * dxFar : 0
    const reachFar = fullAlong ? Math.sqrt(reachFarSq) : 0
    // The angular half-extent this row reaches at the near along edge. The whole
    // cell is only covered at the far corner, whose half-extent is narrower.
    let rowHalf = Math.PI
    if (tip > 0) {
      rowHalf = ball
        ? (centre > 0 ? Math.asin(Math.min(1, reachNear / centre)) : 0)
        : Math.atan2(reachNear, tip)
    }
    const cosRowHalf = tip > 0 ? Math.cos(rowHalf) : -1
    const firstSlot = Math.max(0, Math.floor((-rowHalf - phase) / GUARD_ANGLE_BIN_RADIANS) - 1)
    const lastSlot = Math.min(cells - 1, Math.floor((rowHalf - phase) / GUARD_ANGLE_BIN_RADIANS) + 1)
    if (lastSlot < firstSlot) continue
    const rowOffset = i * angleBins
    let index = edgeBase + firstSlot
    while (index < 0) index += angleBins
    while (index >= angleBins) index -= angleBins
    for (let slot = firstSlot; slot <= lastSlot; slot++, index++) {
      if (index === angleBins) index = 0
      const left = edgeCos[slot]
      const right = edgeCos[slot + 1]
      // The near edge is the one closer to the sample's angle; its cosine is
      // larger. The far edge is the other one.
      const cosNear = left > right ? left : right
      if (cosNear < cosRowHalf) continue
      if (!(cosNear > 1e-9)) continue
      const cellIndex = rowOffset + index
      const materialRadius = material[cellIndex]
      const sinSqNear = Math.max(0, 1 - cosNear * cosNear)
      let contactNear: number
      if (ball) {
        if (!(centre > 0)) continue
        const discriminant = reachNearSq - centreSq * sinSqNear
        if (discriminant < 0) continue
        contactNear = centre * cosNear - Math.sqrt(discriminant)
        if (contactNear < 0) contactNear = 0
      } else {
        // The near ray must still be inside the disc (`|tip tan| <= reach`).
        if (tipSq * sinSqNear > reachNearSq * cosNear * cosNear) continue
        contactNear = tip > 0 ? tip / cosNear : 0
      }
      const cosFar = left < right ? left : right
      const sinSqFar = cosFar > 1e-9 ? Math.max(0, 1 - cosFar * cosFar) : 0
      const sinFar = Math.sqrt(sinSqFar)
      if (!fullAlong) {
        const centreMaterial = state.centreMaterial[cellIndex]
        const engagementHere = centreMaterial - contactNear
        if (engagementHere > engagement) engagement = engagementHere
        // (debug) A partial cut still lowers the cell's along centre, where it does
        // reach; the whole-cell `material` stays so a later full-coverage cut
        // still sees the far side.
        const centreAlong = (insideLow + insideHigh) * 0.5
        const dxCentre = Math.abs(centreAlong - along)
        if (dxCentre < radius && cosFar > 1e-9) {
          const reachCentreSq = radiusSq - dxCentre * dxCentre
          let contactCentre = Number.POSITIVE_INFINITY
          let covered = false
          if (ball) {
            if (centre > 0) {
              const discriminant = reachCentreSq - centreSq * sinSqFar
              if (discriminant >= 0) {
                const root = Math.sqrt(discriminant)
                contactCentre = centre * cosFar - root
                if (contactCentre < 0) contactCentre = 0
                const sphereExit = centre * cosFar + root
                const shankExit = sinFar > 1e-12 ? Math.sqrt(reachCentreSq) / sinFar : Number.POSITIVE_INFINITY
                const shankStart = centre / cosFar
                const exit = shankStart <= shankExit ? Math.max(sphereExit, shankExit) : sphereExit
                covered = exit >= centreMaterial
              }
            }
          } else if (!(tipSq * sinSqFar > reachCentreSq * cosFar * cosFar)) {
            contactCentre = tip > 0 ? tip / cosFar : 0
            const exit = sinFar > 1e-12 ? Math.sqrt(reachCentreSq) / sinFar : Number.POSITIVE_INFINITY
            covered = exit >= centreMaterial
          }
          if (covered && centreMaterial > contactCentre) state.centreMaterial[cellIndex] = contactCentre
        }
        continue
      }
      let contactFar: number
      if (ball) {
        const discriminant = reachFarSq - centreSq * sinSqFar
        if (discriminant < 0) {
          const engagementHere = materialRadius - contactNear
          if (engagementHere > engagement) engagement = engagementHere
          continue
        }
        const root = Math.sqrt(discriminant)
        const sphereExit = centre * cosFar + root
        contactFar = centre * cosFar - root
        if (contactFar < 0) contactFar = 0
        // The material's highest remaining point after a whole-cell cut is the
        // far corner, so the bite is measured there against the same contact.
        const engagementHere = materialRadius - contactFar
        if (engagementHere > engagement) engagement = engagementHere
        if (!(materialRadius > contactFar)) continue
        // The body ends at the farther of the sphere's far root and the shank
        // above its equator; the cell stands only if that wall is below it.
        const shankExit = sinFar > 1e-12 ? reachFar / sinFar : Number.POSITIVE_INFINITY
        const shankStart = centre / cosFar
        const exit = shankStart <= shankExit ? Math.max(sphereExit, shankExit) : sphereExit
        if (exit < materialRadius) continue
      } else {
        // The far ray must still be inside the disc; that is the hardest corner
        // of the rectangle, so it also covers the rest of the cell.
        if (tipSq * sinSqFar > reachFarSq * cosFar * cosFar) {
          const engagementHere = materialRadius - contactNear
          if (engagementHere > engagement) engagement = engagementHere
          continue
        }
        contactFar = tip > 0 ? tip / cosFar : 0
        const engagementHere = materialRadius - contactFar
        if (engagementHere > engagement) engagement = engagementHere
        if (!(materialRadius > contactFar)) continue
        const exit = sinFar > 1e-12 ? reachFar / sinFar : Number.POSITIVE_INFINITY
        if (exit < materialRadius) continue
      }
      material[cellIndex] = contactFar
      state.centreMaterial[cellIndex] = contactFar
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
 * band (#1045 slices G and H).
 *
 * A move's commanded samples are `(end - start) / steps` degrees apart. For any
 * cell the cutter's contact falls as a sample approaches the cell and rises
 * again after it passes, so the **lowest** contact the move reaches there is the
 * contact at the sample nearest the cell's **near edge**; the move's engagement
 * at that cell is `material - that contact`, and the material it leaves is the
 * contact at the cell's **far edge**. Walking every sample would repeat the same
 * cell calculation as each sample passes over it: this function visits each cell
 * of the move's band **once**. A 360-degree ring, a 5-degree wobble segment and
 * the merge's flat rings all reduce to the same pass, and on a 1 m stubbed rough
 * this is most of the export check's cell visits.
 *
 * The cell is a rectangle, exactly as in {@link cutSample} (#1045 slice H):
 * engagement is charged against the cell's highest material at the near-edge
 * contact, every cell the footprint touches at all; the grid is lowered only
 * when one sample covers the whole cell -- its far edge within that sample's
 * footprint -- and then only to the far-edge contact, the highest radius left
 * anywhere in the rectangle. A cell outside the move's angle interval is reached
 * only by an endpoint sample, so its nearest sample is that endpoint.
 *
 * The move's tip is not exactly constant -- a generated ring's height map
 * wobbles by a few thousandths of a millimetre -- so the caller passes the
 * move's low and high tip. The engagement is measured from `tipLow`, a lower
 * contact than any sample's, so it **over**-estimates; the whole-cell coverage
 * and the material are taken at `tipHigh`, whose contact is an upper bound, so
 * the grid never under-states what stands. The caller bounds the tip variation
 * to a tenth of the guard's own angular tolerance, so both errors stay well
 * inside it.
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
  const halfAlongBin = alongBin * 0.5
  const halfBinDegrees = angleBinDegrees * 0.5
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
  // Engagement uses the widest footprint (the lowest tip); whole-cell coverage
  // and the material use the highest tip, whose contact is the largest.
  const lowCentre = ball ? tipLow + radius : 0
  const lowCentreSq = lowCentre * lowCentre
  const highCentre = ball ? tipHigh + radius : 0
  const highCentreSq = highCentre * highCentre
  const highTipSq = tipHigh * tipHigh
  let engagement = Number.NEGATIVE_INFINITY
  for (let i = i0; i <= i1; i++) {
    const cellCentre = alongStart + (i + 0.5) * alongBin
    const insideLow = Math.max(cellCentre - halfAlongBin, state.materialAlongLow)
    const insideHigh = Math.min(cellCentre + halfAlongBin, state.materialAlongHigh)
    if (!(insideHigh > insideLow)) continue
    const distanceAlong = along < insideLow ? insideLow - along : along > insideHigh ? along - insideHigh : 0
    const dxNear = distanceAlong
    if (!(dxNear < radius)) continue
    const reachNearSq = radiusSq - dxNear * dxNear
    const reachNear = Math.sqrt(reachNearSq)
    const dxFar = Math.max(Math.abs(along - insideLow), Math.abs(along - insideHigh))
    const fullAlong = dxFar < radius
    const reachFarSq = fullAlong ? radiusSq - dxFar * dxFar : 0
    const reachFar = fullAlong ? Math.sqrt(reachFarSq) : 0
    const rowHalf = tipLow > 0
      ? (ball ? (lowCentre > 0 ? Math.asin(Math.min(1, reachNear / lowCentre)) : 0) : Math.atan2(reachNear, tipLow))
      : Math.PI
    const rowHalfDegrees = Math.min(180, rowHalf * 180 / Math.PI)
    // The cells this row's footprint can touch: the move's interval widened by
    // the row's half-extent, plus one bin for the cell's own extent. A band at
    // least a full turn wide is simply every bin, walked once.
    const loDegrees = a0 - rowHalfDegrees - angleBinDegrees
    const hiDegrees = a1 + rowHalfDegrees + angleBinDegrees
    const firstCell = hiDegrees - loDegrees >= 360 ? 0 : Math.ceil(loDegrees / angleBinDegrees) - 1
    const lastCell = hiDegrees - loDegrees >= 360 ? angleBins - 1 : Math.floor(hiDegrees / angleBinDegrees)
    const rowOffset = i * angleBins
    for (let cell = firstCell; cell <= lastCell; cell++) {
      const k = ((cell % angleBins) + angleBins) % angleBins
      const leftAngle = k * angleBinDegrees
      const rightAngle = leftAngle + angleBinDegrees
      const index = rowOffset + k
      const materialRadius = material[index]
      // A cell whose **whole angular span** lies inside the commanded turn is
      // swept continuously: the controller interpolates A, so for every angle in
      // the cell there is a commanded sample at that angle, even between the
      // guard's samples. Its angular coverage is therefore complete and the
      // deepest contact is on the axis ray (`dTheta = 0`), not at a cell corner.
      // Only cells beyond an endpoint -- outside the sweep, or straddling it --
      // depend on the endpoint's discrete footprint.
      const fromStart = ((leftAngle - a0) % 360 + 360) % 360
      if (fromStart + angleBinDegrees <= span + 1e-9) {
        if (!(dxNear < radius)) continue
        // A continuous ring reaches its own along edge: at `dx = r` the tool
        // shank covers the axis ray at every angle as the turn passes, but the
        // material one angular bin away from the axis ray still stands. A cell
        // whose far edge is only reached at `dx = r` therefore gets the partial
        // treatment, as in {@link cutSample}, not the cell's whole-cell maximum.
        const coveredAlong = dxFar < radius
        if (!coveredAlong) {
          const edgeNear = state.centreMaterial[index]
          const contactNear = ball
            ? (lowCentre > 0 ? Math.max(0, lowCentre - reachNear) : Number.NaN)
            : (tipLow > 0 ? tipLow : 0)
          if (!Number.isNaN(contactNear) && edgeNear > contactNear) {
            const depth = edgeNear - contactNear
            if (depth > engagement) engagement = depth
          }
          // The ring still cuts the covered part: lower the cell's along centre
          // to the contact there, so the next layer's partial pass sees a
          // stepdown rather than the blank.
          const centreAlong = (insideLow + insideHigh) * 0.5
          const dxCentre = Math.abs(centreAlong - along)
          if (dxCentre < radius) {
            const centreContact = ball
              ? (highCentre > 0 ? Math.max(0, highCentre - Math.sqrt(Math.max(0, radiusSq - dxCentre * dxCentre))) : Number.NaN)
              : (tipHigh > 0 ? tipHigh : 0)
            if (!Number.isNaN(centreContact) && edgeNear > centreContact) {
              state.centreMaterial[index] = Math.min(state.centreMaterial[index], centreContact)
            }
          }
          continue
        }
        let contactLow: number
        if (ball) {
          if (!(lowCentre > 0)) continue
          contactLow = lowCentre - reachFar
          if (contactLow < 0) contactLow = 0
        } else {
          contactLow = tipLow > 0 ? tipLow : 0
        }
        if (materialRadius > contactLow) {
          const depth = materialRadius - contactLow
          if (depth > engagement) engagement = depth
        }
        let contactHigh: number
        if (ball) {
          if (!(highCentre > 0)) continue
          contactHigh = highCentre - reachFar
          if (contactHigh < 0) contactHigh = 0
        } else {
          contactHigh = tipHigh > 0 ? tipHigh : 0
        }
        if (materialRadius > contactHigh) {
          material[index] = contactHigh
          state.centreMaterial[index] = contactHigh
        }
        continue
      }
      // Each cell edge's signed distance to the nearest commanded sample. The
      // near edge is the nearer of the two: it is the deepest point the move
      // reaches in the cell, so it carries the engagement.
      const leftOffset = nearestSampleOffset(leftAngle, a0, span, stepDegrees)
      const rightOffset = nearestSampleOffset(rightAngle, a0, span, stepDegrees)
      const nearDegrees = Math.min(Math.abs(leftOffset), Math.abs(rightOffset))
      if (nearDegrees > rowHalfDegrees + 1e-9) continue
      const nearRadians = nearDegrees * Math.PI / 180
      const cosNear = Math.cos(nearRadians)
      if (!(cosNear > 1e-9)) continue
      const sinSqNear = Math.max(0, 1 - cosNear * cosNear)
      let contactLow: number
      if (ball) {
        if (!(lowCentre > 0)) continue
        const discriminant = reachNearSq - lowCentreSq * sinSqNear
        if (discriminant < 0) continue
        contactLow = lowCentre * cosNear - Math.sqrt(discriminant)
        if (contactLow < 0) contactLow = 0
      } else {
        if (tipLow * tipLow * sinSqNear > reachNearSq * cosNear * cosNear) continue
        contactLow = tipLow > 0 ? tipLow / cosNear : 0
      }
      if (!fullAlong) {
        const centreMaterial = state.centreMaterial[index]
        if (centreMaterial > contactLow) {
          const depth = centreMaterial - contactLow
          if (depth > engagement) engagement = depth
        }
        // The cut still lowers the covered part; record it at the cell's along
        // centre so the next layer's partial pass sees a stepdown.
        const centreAlong = (insideLow + insideHigh) * 0.5
        const dxCentre = Math.abs(centreAlong - along)
        if (dxCentre < radius) {
          const centreContact = ball
            ? (highCentre > 0 ? Math.max(0, highCentre - Math.sqrt(Math.max(0, radiusSq - dxCentre * dxCentre))) : Number.NaN)
            : (tipHigh > 0 ? tipHigh : 0)
          if (!Number.isNaN(centreContact) && centreMaterial > centreContact) {
            state.centreMaterial[index] = centreContact
          }
        }
        continue
      }
      // The sample nearest the cell's centre covers the whole cell only when its
      // far edge -- centre offset plus half a bin -- is still inside the
      // footprint. That far edge is also where the material it leaves is
      // highest.
      const centreOffset = nearestSampleOffset(leftAngle + halfBinDegrees, a0, span, stepDegrees)
      const farDegrees = Math.abs(centreOffset) + halfBinDegrees
      const farRadians = farDegrees * Math.PI / 180
      const cosFar = Math.cos(farRadians)
      if (!(cosFar > 1e-9)) {
        if (materialRadius > contactLow) {
          const depth = materialRadius - contactLow
          if (depth > engagement) engagement = depth
        }
        continue
      }
      const sinSqFar = Math.max(0, 1 - cosFar * cosFar)
      const sinFar = Math.sqrt(sinSqFar)
      let contactHigh: number
      if (ball) {
        if (!(highCentre > 0)) continue
        const discriminant = reachFarSq - highCentreSq * sinSqFar
        if (discriminant < 0) {
          if (materialRadius > contactLow) {
            const depth = materialRadius - contactLow
            if (depth > engagement) engagement = depth
          }
          continue
        }
        const root = Math.sqrt(discriminant)
        contactHigh = highCentre * cosFar - root
        if (contactHigh < 0) contactHigh = 0
        const lowContact = lowCentre > 0 ? Math.max(0, lowCentre * cosFar - root) : 0
        const depth = materialRadius - lowContact
        if (depth > engagement) engagement = depth
        if (!(materialRadius > contactHigh)) continue
        const sphereExit = highCentre * cosFar + root
        const shankExit = sinFar > 1e-12 ? reachFar / sinFar : Number.POSITIVE_INFINITY
        const shankStart = highCentre / cosFar
        const exit = shankStart <= shankExit ? Math.max(sphereExit, shankExit) : sphereExit
        if (exit < materialRadius) continue
      } else {
        if (highTipSq * sinSqFar > reachFarSq * cosFar * cosFar) {
          if (materialRadius > contactLow) {
            const depth = materialRadius - contactLow
            if (depth > engagement) engagement = depth
          }
          continue
        }
        contactHigh = highTipSq > 0 ? tipHigh / cosFar : 0
        const lowContact = tipLow > 0 ? tipLow / cosFar : 0
        const depth = materialRadius - lowContact
        if (depth > engagement) engagement = depth
        if (!(materialRadius > contactHigh)) continue
        const exit = sinFar > 1e-12 ? reachFar / sinFar : Number.POSITIVE_INFINITY
        if (exit < materialRadius) continue
      }
      material[index] = contactHigh
      state.centreMaterial[index] = contactHigh
    }
  }
  return engagement
}

/**
 * The signed angular distance from `angleDegrees` to the nearest commanded
 * sample of a move that sweeps `span` degrees from `a0` in `stepDegrees` steps.
 * Inside the sweep that is the nearest of the evenly spaced samples; outside it
 * is the nearer endpoint. The same closed-circle arithmetic as the slice-G band
 * pass, kept as a helper because the cell-edge and cell-centre samples differ.
 */
function nearestSampleOffset(angleDegrees: number, a0: number, span: number, stepDegrees: number): number {
  const fromStart = ((angleDegrees - a0) % 360 + 360) % 360
  if (fromStart <= span) return fromStart - Math.round(fromStart / stepDegrees) * stepDegrees
  const toStart = 360 - fromStart
  const toEnd = fromStart - span
  return toStart <= toEnd ? -toStart : toEnd
}

/** Wrap a whole-bin offset into the precomputed table's range. */
function wrapBin(offset: number): number {
  const bins = GUARD_ANGLE_BIN_COUNT
  return ((offset % bins) + bins) % bins
}
