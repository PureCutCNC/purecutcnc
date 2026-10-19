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
 * whole program's commanded motion through it (#1045 slice E).
 *
 * Slice C decided whether an around pass was safe by **licensing**: an earlier
 * program rough on the same target was taken as proof that the material a
 * finish would sweep was already gone. Codex's second review found the flaw: a
 * rough whose own supports (or whose cut range) covered only part of the band
 * licensed a finish over the whole band, and its first ring swept untouched
 * square corners without a warning. One global minimum tip cannot answer a
 * question that is local in both along position and angle.
 *
 * This module replaces the licence with **material accounting**. For a square
 * blank it keeps a grid of the material still standing — along-bar bins by
 * angle bins, each cell the material's outer radius above the turning pivot —
 * initialised from the raw blank (the square's corner envelope at every angle,
 * retained ends included). It walks every move of every square turning operation
 * in program order, samples the **actual commanded motion** (linear in along, A
 * and Z; A as commanded, so an A0->A360 move is a full revolution, never a
 * modulo shortcut), and at each sample:
 *
 * - computes that sample's radial depth of cut — the deepest standing material
 *   above the cutter's lower surface inside its footprint (its along extent ±
 *   the cutter radius, and the angular extent the same radius subtends at the
 *   material's own radius);
 * - lowers the grid to what the cutter's lower surface leaves there;
 * - refuses a **turning cut** below the blank's travel height whose engagement
 *   exceeds the operation's own bound (a rough's `stepdown`; a finish's
 *   `stockToLeave` plus the scallop a rough that actually covered that spot
 *   would leave).
 *
 * A turn that removes nothing — a rapid, or a turn on an along-mode operation —
 * keeps the old refusal exactly. A non-turning cut (a plunge, or an along pass)
 * is never refused here but **does** lower the grid, which is what lets an
 * along rough clear material for a later around finish.
 *
 * The grid is bounded: angle bins are {@link GUARD_ANGLE_BIN_DEGREES} apart and
 * along bins are at most a quarter of the smallest cutter radius in the
 * program, with the along count capped so the two together stay under
 * {@link GUARD_MAX_CELLS}. The tolerance the guard adds to an operation's own
 * bound is stated in {@link guardSquareOperation}: one angle bin's worst-case
 * surface change, one along bin, and the emitted Z's rounding.
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
 * typical 2 mm layer. Finer bins buy little: the guard's tolerance already
 * carries one bin's worth of material change, and the cell loop is the guard's
 * whole cost.
 */
export const GUARD_ANGLE_BIN_DEGREES = 0.5
const GUARD_ANGLE_BIN_COUNT = Math.round(360 / GUARD_ANGLE_BIN_DEGREES)

/**
 * Along-bar resolution. One bin is at most a quarter of the smallest cutter
 * radius in the program, so the cutter body always spans at least four bins and
 * consecutive samples' footprints overlap. A very long bar with a tiny cutter
 * would otherwise allocate millions of rows: {@link GUARD_MAX_ALONG_BINS} and
 * {@link GUARD_MAX_CELLS} widen the bin, and `alongBin` below reports the
 * widening so the guard's tolerance grows with it.
 */
const GUARD_MAX_ALONG_BINS = 2048
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
 * The square blank's material account for one export program (#1045 slice E).
 *
 * `material[alongBin * angleBins + angleBin]` is the outer radius of the
 * material still standing in that cell, measured from the turning pivot. A cell
 * is lowered only, never raised: a cut removes material.
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
}

/**
 * Build the blank's grid. `minCutterRadius` is the smallest tip radius among the
 * program's square turning operations; the along bin is derived from it.
 */
export function createSquareSweepState(stock: BarStock, minCutterRadius: number): SquareSweepState {
  const bounds = stockBoundsAlong(stock)
  const length = Math.max(0, bounds.upper - bounds.lower)
  const radius = Number.isFinite(minCutterRadius) && minCutterRadius > 0 ? minCutterRadius : 1
  let alongBins = Math.max(1, Math.ceil(length / Math.max(radius * 0.25, 1e-9)))
  alongBins = Math.min(alongBins, GUARD_MAX_ALONG_BINS)
  // Keep the grid bounded. `alongBins` widens rather than the angle resolution:
  // the angular grid is what carries the corner envelope.
  if (alongBins * GUARD_ANGLE_BIN_COUNT > GUARD_MAX_CELLS) {
    alongBins = Math.max(1, Math.floor(GUARD_MAX_CELLS / GUARD_ANGLE_BIN_COUNT))
  }
  const alongBin = alongBins > 1 ? length / alongBins : Math.max(length, 1e-9)
  const angleBins = GUARD_ANGLE_BIN_COUNT
  const maxMaterial = barMaxRadius(stock)
  const material = new Float64Array(alongBins * angleBins)
  // The blank is the same cross-section at every along position, retained ends
  // included: the grid covers the bar's whole length, so an end the program
  // never cuts simply keeps the blank there.
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
 * The guard adds one stated tolerance: `barMaxRadius * angleBin + alongBin` for
 * the grid's own resolution plus `roundingAllowance` for the emitted Z. A rough
 * therefore admits a bite of `stepdown + tolerance`; a finish `stockToLeave +
 * scallop + tolerance`.
 *
 * Returns `false` — keeping `postRotarySquareTurnBelowEnvelope` — for a turning
 * rapid, a turn on an operation that does not run around the bar, or a turning
 * cut that takes more than its bound. A feed move that carries its angle on one
 * end only is skipped: the caller refuses it later as
 * `postRotaryAngleNotEstablished`, and a move the emitter cannot write has no
 * commanded motion to account for.
 */
export function guardSquareOperation(state: SquareSweepState, input: GuardOperationInput): boolean {
  const { operation, moves, cutter, direction, travelZ, roundingAllowance } = input
  const finish = operation.kind === 'rotary_finish'
  const around = operation.rotaryPassDirection === 'around'
    && (operation.kind === 'rotary_rough' || operation.kind === 'rotary_finish')
  const stockToLeave = finish ? operation.stockToLeaveRadial : 0
  if (finish && (!Number.isFinite(stockToLeave) || stockToLeave < 0)) return false
  if (!finish && (!Number.isFinite(operation.stepdown) || operation.stepdown <= 0)) return false
  const targetKey = operationTargetKey(operation.target)
  const scallop = finish ? state.roughAllowance.get(targetKey) ?? 0 : 0
  const bound = (finish ? stockToLeave + scallop : operation.stepdown)
    + state.maxMaterial * (state.angleBinDegrees * Math.PI / 180) + state.alongBin + roundingAllowance
  const pivot = barPivotZ(state.stock)
  const travelTip = travelZ - pivot
  const cutterRadius = cutter.type === 'ball_endmill' || cutter.type === 'flat_endmill' ? cutter.radius : 0
  const ball = cutter.type === 'ball_endmill'
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
      if (turns && lowTip < travelTip - roundingAllowance) return false
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
    if (turns && Math.abs(end - controller) > MAX_GUARD_SWEEP_DEGREES) return false
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
        if (!around) return false
        const engagement = cutSample(state, sample, cutterRadius, ball)
        if (engagement > bound) return false
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
  return true
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
 * Lower the grid to what one cutter sample leaves, and report the sample's
 * radial engagement: the deepest standing material found inside the cutter's
 * footprint before it is removed.
 *
 * The cutter is a flat or ball end mill with its axis on the pass ray, so a
 * cell at radius `R` and angular offset `dTheta` sits `X = R sin(dTheta)` from
 * the tool axis across the cut and `dx` along the bar. The cutter's lower
 * surface only reaches the cell when `dx² + X² <= r²`; a flat bottom then cuts
 * the whole column down to the tip, while a ball cuts it down to
 * `tip + r - sqrt(r² - dx² - X²)`.
 *
 * Only cells with `R > tip` can be touched: both lower surfaces are at or above
 * the tip, so a cell already below it is left alone. That also bounds the
 * angular neighbourhood — `asin(r / tip)` is the widest offset that can still
 * hold material above the tip — so the loop stays small.
 */
function cutSample(
  state: SquareSweepState,
  sample: GuardSample,
  cutterRadius: number,
  ball: boolean,
): number {
  if (!(cutterRadius > 0) || !Number.isFinite(cutterRadius)) return Number.NEGATIVE_INFINITY
  if (!Number.isFinite(sample.tip) || !Number.isFinite(sample.along)) return Number.NEGATIVE_INFINITY
  const { material, angleBins, alongBins, alongBin, alongStart, angleBinDegrees } = state
  const radius = cutterRadius
  const radiusSq = radius * radius
  const alongIndex = Math.floor((sample.along - alongStart) / alongBin)
  const spanAlong = Math.ceil(radius / alongBin) + 1
  const i0 = Math.max(0, alongIndex - spanAlong)
  const i1 = Math.min(alongBins - 1, alongIndex + spanAlong)
  if (i1 < i0) return Number.NEGATIVE_INFINITY
  const halfSpanBins = sample.tip > 0
    ? Math.ceil(Math.asin(Math.min(1, radius / sample.tip)) / (angleBinDegrees * Math.PI / 180)) + 1
    : Math.ceil(angleBins / 2)
  const wrapped = ((sample.angle % 360) + 360) % 360
  const sampleBin = wrapped / angleBinDegrees
  const firstBin = Math.floor(sampleBin)
  const tables = guardTrig()
  // The centre of the first bin in the window sits `phase` radians from the
  // sample; every later bin adds exactly one bin. Sin of that sequence is a
  // rotation of the precomputed bin table, so the hot loop is arithmetic only.
  const phase = (firstBin + 0.5 - sampleBin) * angleBinDegrees * Math.PI / 180
  const sinPhase = Math.sin(phase)
  const cosPhase = Math.cos(phase)
  // One sine per angular offset, not one per cell: every along row in the
  // footprint uses the same offsets. The scratch buffer is reused across
  // samples -- a fresh array per sample would be hundreds of thousands of
  // allocations on a long rough.
  const width = 2 * halfSpanBins + 1
  if (offsetScratch.length < width) offsetScratch = new Float64Array(width)
  const offsets = offsetScratch
  for (let j = 0; j < width; j++) {
    const offset = j - halfSpanBins
    offsets[j] = sinPhase * tables.cos[wrapBin(offset)] + cosPhase * tables.sin[wrapBin(offset)]
  }
  let engagement = Number.NEGATIVE_INFINITY
  for (let i = i0; i <= i1; i++) {
    const along = alongStart + (i + 0.5) * alongBin
    const dx = along - sample.along
    const dxSq = dx * dx
    const remaining = radiusSq - dxSq
    if (remaining <= 0) continue
    const rowOffset = i * angleBins
    for (let offset = -halfSpanBins; offset <= halfSpanBins; offset++) {
      const index = wrapBin(firstBin + offset)
      // The raw (unwrapped) offset is what the sine needs; the index only says
      // which cell. A window that crosses 0/360 therefore lands correctly.
      const sinOffset = offsets[offset + halfSpanBins]
      const materialRadius = material[rowOffset + index]
      if (!(materialRadius > sample.tip)) continue
      let scaled = materialRadius * sinOffset
      scaled *= scaled
      if (scaled > remaining) continue
      // The radial depth this sample takes from the cell: the material above
      // the cutter's lower surface there. Measuring against the lower surface
      // rather than the tip is what makes a ball's depth exact at the edges of
      // its footprint -- there the ball's flank stands up to a radius above the
      // tip, and charging that lift to every neighbouring cell would refuse a
      // layer that only ever takes its stepdown.
      const contact = ball
        ? sample.tip + radius - Math.sqrt(Math.max(0, remaining - scaled))
        : sample.tip
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
