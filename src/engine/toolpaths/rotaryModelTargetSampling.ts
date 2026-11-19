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

import { barCentre, barInscribedRadius, barMaxRadius, isSquareStock } from '../../types/barStock'
import { type BarStock, getStockBounds } from '../../types/project'
import { convertLength, type Units } from '../../utils/units'
import { chooseHeightMapCellSize } from './finishSurfaceParallel'
import type { RotaryFinishParams } from './rotaryModelParams'
import {
  alongExtremes,
  AROUND_ANGLE_TOLERANCE_MM,
  MAX_ROTARY_SAMPLES,
  type RotaryModelMesh,
  type RotarySamplingPrep,
  sampleAnglesWithPrep,
} from './rotarySampling'
import type { NormalizedTool } from './types'
import type { ToolpathWarning } from './warningCodes'

/**
 * A commanded A wrapped into one turn, in `(-180, 180]`, for a region test.
 *
 * The sheet's across coordinate is affine in the **physical** angle, and the
 * mask repeats one circumference each way, so a move is tested on the turn it
 * is actually swept on. `(-180, 180]` puts the A0/A360 seam at the turn's ends
 * rather than inside it: a segment that crosses the seam reads as, say,
 * `-1.4 -> 0`, the short way round, instead of `358.6 -> 360` (or worse, a
 * `359.9999` from an inexact division being floored to the wrong turn).
 */
export function turnAngle(commanded: number): number {
  const wrapped = commanded - 360 * Math.round(commanded / 360)
  return wrapped === -180 ? 180 : wrapped
}

/**
 * The angle step of an around grid, as an arc length on the blank's surface
 * (#1045 slice D): `params.sampleSpacing`, capped so the straight move between
 * two angle samples stays within {@link AROUND_ANGLE_TOLERANCE_MM} of a convex
 * surface. `R dTheta^2 / 8 = arc^2 / (8R) <= tolerance` gives
 * `arc <= sqrt(8 R tolerance)`; `R` is `barMaxRadius` -- the largest radius the
 * blank reaches at any angle -- so a square blank's corners are covered by the
 * same bound. The tolerance is converted from millimetres into the operation's
 * units before the square root. A non-finite or non-positive cap (which a
 * caller that slipped past `rotaryRefusal` could produce) leaves the requested
 * spacing in place, so the old grid is the fallback rather than no grid at all.
 */
export function aroundArcStep(stock: BarStock, params: RotaryFinishParams, units: Units): number {
  const radius = barMaxRadius(stock)
  const tolerance = convertLength(AROUND_ANGLE_TOLERANCE_MM, 'mm', units)
  const cap = Math.sqrt(8 * radius * tolerance)
  return Number.isFinite(cap) && cap > 0 ? Math.min(params.sampleSpacing, cap) : params.sampleSpacing
}

/**
 * The around-mode sampling grid (#1045 slice A): one along position every
 * `stepover` over the cutter span, and one angle every `sampleSpacing` of
 * surface distance round the blank, both endpoints included so a ring closes at
 * 360 degrees. `null` when either count is unbounded or the two together exceed
 * the sample budget, which the caller refuses with the existing
 * `operationStepoverRatioRange`. The angle count is derived from the blank's
 * largest radius -- the conservative radius the along pass's pass count already
 * uses, and the surface a square blank's corners stand at. The angle step is
 * capped by `aroundArcStep` (#1045 slice D), so a safe pair of endpoints is
 * also a safe sweep between them.
 */
export function aroundGrid(
  stock: BarStock,
  span: { readonly start: number; readonly end: number },
  params: RotaryFinishParams,
  units: Units,
): { along: number[]; angles: number[] } | null {
  const angular = boundedIntervals(2 * Math.PI * barMaxRadius(stock), aroundArcStep(stock, params, units))
  const axial = boundedIntervals(span.end - span.start, params.stepover)
  if (angular === null || axial === null) return null
  if ((angular + 1) * (axial + 1) > MAX_ROTARY_SAMPLES) return null
  const angles = Array.from({ length: angular + 1 }, (_, k) => 360 * k / angular)
  const along = Array.from({ length: axial + 1 }, (_, i) => span.start + (span.end - span.start) * i / axial)
  return { along, angles }
}

/**
 * #1173 fix 3: how many angle rows the exact layer floor may visit, and how
 * close to the grid minimum a row's own minimum must be to count as a
 * candidate. A smooth bar ties every angle (the conservative rise is the same
 * per angle there), and the first row already gives the floor, so the cap is
 * what keeps the read at a handful of rows; the tie is in project units and
 * only ever admits rows the conservative grid calls equally deep.
 */
const MAX_LAYER_FLOOR_ROWS = 4
const LAYER_FLOOR_TIE = 1e-9

/**
 * Per-shoulder cap on the extra along samples the square-blank refinement adds,
 * so a very small requested cell under a large cutter still cannot allocate an
 * unbounded grid; the spacing is widened to `zone / MAX_SHOULDER_SAMPLES`.
 */
const MAX_SHOULDER_SAMPLES = 4096

/**
 * The along grid's interval count at `spacing`, or null when it is not a
 * finite, bounded, positive count. `Math.max(spacing, 1e-9)` mirrors the floors
 * the generators apply, so a caller that slipped past `rotaryRefusal` still
 * cannot reach an infinite count here.
 */
export function boundedIntervals(span: number, spacing: number): number | null {
  const intervals = Math.ceil(Math.abs(span) / Math.max(spacing, 1e-9))
  if (!Number.isFinite(intervals) || intervals > MAX_ROTARY_SAMPLES) return null
  return Math.max(1, intervals)
}

/**
 * The along positions the sampler reads for one operation, over the
 * cutter-centre span `rotaryCutterSpan` returns.
 *
 * On a round bar this is the uniform grid `sampleSpacing` asks for, over the
 * span the pull-in leaves: the run starts and ends one cutter radius inside a
 * stubbed end (#1045 slice D) and reaches the bar's own ends where there is no
 * stub.
 *
 * A square blank's stubbed end starts the required tip at the shoulder height:
 * the first sample sits one cutter radius inside the band, and while its
 * footprint still reaches the model at the band's edge the tip is the material
 * there -- the blank's own surface when the target itself meets the blank at
 * that edge. It falls to the model as the footprint clears, over the first
 * cutter footprint plus the height map's cell. Both stubbed ends keep the F6
 * refinement at that same fine resolution: with the centre one radius off the
 * stub the exact floor no longer binds, but the along density and the
 * `MAX_SHOULDER_SAMPLES` cap stay as they were and a steep rise at a band edge
 * is still resolved. The rest of the span and every unstubbed end are
 * untouched; the shoulder refinement itself stays square-only.
 *
 * Returns `null` when `MAX_SHOULDER_SAMPLES` would widen the added spacing past
 * the cell the sampler actually uses: the residual is then larger than the
 * one-cell allowance the refinement exists to hold, so the caller refuses
 * (`operationStepoverRatioRange`) instead of accepting a coarser tolerance in
 * silence.
 */
export function rotaryAlongPositions(
  mesh: RotaryModelMesh,
  stock: BarStock,
  tool: NormalizedTool,
  params: RotaryFinishParams,
  span: { readonly start: number; readonly end: number },
): number[] | null {
  const start = span.start
  const end = span.end
  const intervals = boundedIntervals(end - start, params.sampleSpacing) ?? 1
  const base: number[] = []
  for (let i = 0; i <= intervals; i++) base.push(start + (end - start) * i / intervals)
  if (!isSquareStock(stock)) return base
  const stockBounds = getStockBounds(stock)
  const meshAlong = alongExtremes(mesh.positions, stock)
  const lower = Math.min(stock.axis === 'x' ? stockBounds.minX : stockBounds.minY, meshAlong.min)
  const upper = Math.max(stock.axis === 'x' ? stockBounds.maxX : stockBounds.maxY, meshAlong.max)
  // Only a real stub makes a shoulder: `withRetainedBar` leaves one out where
  // the cut range already meets the bar's end, and then there is no shoulder to
  // refine and no cap to prove. `rotaryCutterSpan` has already pulled the
  // centre off that stub face, so this compares the *span* with the bar's ends.
  const startShoulder = start > lower
  const endShoulder = end < upper
  if (!startShoulder && !endShoulder) return base
  // The sampler's own resolution for the sampling bbox: the requested cell,
  // clamped and widened by `chooseHeightMapCellSize` when the grid would exceed
  // its cell cap. The sampling mesh's along extent contains the stock's (the
  // retained stubs fill it) and its cross extent never passes `barMaxRadius`
  // from the centre while the model is inside the blank, so this box contains
  // every angle's turned bbox and its cell is at least the sampler's. The fine
  // spacing is the requested cell, at most that cell, so the residual the
  // refinement leaves is no larger than the sampler's own discretization.
  const envelope = barMaxRadius(stock)
  const centre = barCentre(stock)
  const samplingBounds = stock.axis === 'x'
    ? { minX: lower, maxX: upper, minY: centre - envelope, maxY: centre + envelope }
    : { minX: centre - envelope, maxX: centre + envelope, minY: lower, maxY: upper }
  const cell = chooseHeightMapCellSize(samplingBounds, params.requestedCellSize, [])
  const fine = Math.max(params.requestedCellSize, 1e-6)
  // A grid already at or below the resolution resolves the shoulder by itself.
  if (!(params.sampleSpacing > fine)) return base
  // The sampler widens the tool by `stockToLeave` (see `rotaryTargets`), so the
  // shoulder sits one *enlarged* footprint inside the span.
  const zone = tool.radius + Math.max(0, params.stockToLeave) + cell
  if (!Number.isFinite(zone) || !(zone > 0)) return base
  let step = fine
  if (!(zone / step <= MAX_SHOULDER_SAMPLES)) step = zone / MAX_SHOULDER_SAMPLES
  if (!Number.isFinite(step) || !(step > 0)) return base
  // The cap can widen `step` past the cell the sampler will actually use. The
  // sampler's own cell is smallest at a flat -- the turned blank spans `side`
  // there and `side * sqrt(2)` at a corner -- so the flat-aligned box gives the
  // smallest cell any angle can have, and comparing `step` with it proves the
  // one-cell bound at every angle. A spacing that cannot honour it is refused
  // rather than accepted at a coarser tolerance.
  const inscribed = barInscribedRadius(stock)
  const flatBounds = stock.axis === 'x'
    ? { minX: lower, maxX: upper, minY: centre - inscribed, maxY: centre + inscribed }
    : { minX: centre - inscribed, maxX: centre + inscribed, minY: lower, maxY: upper }
  const effectiveCell = chooseHeightMapCellSize(flatBounds, params.requestedCellSize, [])
  if (step > effectiveCell) return null
  const addShoulder = (from: number, to: number, direction: number): void => {
    for (let k = 1; k * step < zone; k++) {
      const x = from + direction * k * step
      if (direction > 0 ? x >= to : x <= to) break
      base.push(x)
    }
  }
  if (startShoulder) addShoulder(start, end, 1)
  if (endShoulder) addShoulder(end, start, -1)
  base.sort((a, b) => a - b)
  const unique: number[] = []
  for (const x of base) {
    if (unique.length === 0 || x - unique[unique.length - 1] > 1e-9) unique.push(x)
  }
  return unique
}

/**
 * Whether this operation samples its height map as the top of each cell rather
 * than at its centre (#1045 slice F, #1155).
 *
 * Around mode always does. **Along** mode does whenever a neighbour is in the
 * mesh: its old centre-sampled read left a pass one cutter radius past a
 * neighbour's end face blind to the half cell that face covers, and the cutter
 * stepped into the face by up to that cell (#1155 correction). An along
 * operation with no neighbour keeps the old path byte for byte.
 *
 * Exported because the focused suite asserts the margin itself: on a target
 * with a neighbour wholly inside it no sample may come out lower, and in along
 * mode the conservative read is the neighbour's doing, so the margin must be
 * there (#1155 acceptance 2).
 */
export function rotaryConservativeSampling(
  params: Pick<RotaryFinishParams, 'passDirection' | 'neighbours'>,
): boolean {
  return params.passDirection === 'around' || (params.neighbours !== undefined && params.neighbours.length > 0)
}

/**
 * #1173 fix 3: the exact footprint minimum the last layer's floor may reach.
 *
 * The layer plan below (`roughFromTargets`) counts layers from the lowest
 * sample and clamps the last layer's radius to it. That sample is the ring
 * grid's read, which is conservative by its per-angle cell rise: on a smooth
 * Ø1 shank it stands 0.0094 in (0.24 mm) above the surface the helix's exact
 * rows cut, so the last layer was planned one conservative cell high. Worse, a
 * neighbour that reaches no shank column could still move the floor: its
 * wall-foot ring is read exactly, and when that ring was the grid's lowest
 * sample the whole bar's last layer dropped with it. The same project with the
 * neighbour removed has no such column, so the two programs' deepest layers
 * differed by exactly that margin -- a control failure, and the reason the
 * unfiltered with/without-neighbour comparison could not pass.
 *
 * The floor is a property of the **target**, so it is read on the target and
 * stubs alone (`floorPrep`, the same mesh the base grid reads) and at the
 * target's own along grid (`floorAlong`): the neighbour cannot move it, and a
 * program with the neighbour removed reads exactly the same positions and gets
 * exactly the same value. The read is the exact footprint at the angle rows
 * that attain the grid minimum -- at most `MAX_LAYER_FLOOR_ROWS` rows, because
 * a smooth bar ties every angle and the floor is already the surface there --
 * through the same stock offset and clamp every sample takes.
 *
 * It only ever **lowers** the floor (`Math.min` with the grid's own minimum),
 * and cutting a layer at `max(sample, floor)` can never go below a sample, so
 * no output can gouge through this: a floor that misses the true minimum leaves
 * material, exactly as the conservative grid read did before.
 */
export function exactLayerFloor(
  prep: RotarySamplingPrep,
  angles: readonly number[],
  rows: readonly Float32Array[],
  stockToLeave: number,
  maxRadius: number,
  warnings: ToolpathWarning[],
): number | null {
  const samplingValue = (raw: number): number => Math.min(Math.max(raw + stockToLeave, 0), maxRadius)
  let gridLowest = Number.POSITIVE_INFINITY
  for (const row of rows) {
    for (const raw of row) {
      if (!Number.isFinite(raw)) continue
      const value = samplingValue(raw)
      if (value < gridLowest) gridLowest = value
    }
  }
  if (!Number.isFinite(gridLowest)) return null
  const candidates: number[] = []
  for (let k = 0; k < angles.length && candidates.length < MAX_LAYER_FLOOR_ROWS; k++) {
    let rowLowest = Number.POSITIVE_INFINITY
    for (const raw of rows[k]) {
      if (!Number.isFinite(raw)) continue
      const value = samplingValue(raw)
      if (value < rowLowest) rowLowest = value
    }
    if (rowLowest <= gridLowest + LAYER_FLOOR_TIE) candidates.push(angles[k])
  }
  if (candidates.length === 0) return null
  // The stop hook is not threaded here, exactly as the wall-foot reads are not:
  // this is at most a handful of exact rows, and both callers check a stop
  // immediately before and after the base grid.
  const exact = sampleAnglesWithPrep(prep, candidates, warnings)
  if (!exact.valid) return null
  let lowest = gridLowest
  for (const row of exact.tipRadius) {
    for (const raw of row) {
      if (!Number.isFinite(raw)) continue
      const value = samplingValue(raw)
      if (value < lowest) lowest = value
    }
  }
  return lowest
}

/** The share of a rough's stock to leave its chords may dip between samples (#1185 R2). */
export const ROUGH_REFINEMENT_LEAVE_SHARE = 0.25

/**
 * The least between-sample tolerance of an around refinement, in the
 * operation's units (#1185 R2, decided by Frank on 2026-11-09).
 *
 * A **finish** keeps the stated 0.005 mm surface bound, whatever stock it
 * leaves: its surface is the product.
 *
 * A **rough** takes the larger of that bound and a quarter of its radial stock
 * to leave. Every sample of a rough already stands the whole leave above the
 * model (the sampler's cutter is enlarged by it), so a chord that dips a
 * quarter of the leave below its samples still leaves three quarters of it on
 * the part -- stock the finish is there to remove. Holding a rough that leaves
 * 0.5 mm to 0.005 mm between samples cost most of its generation time and half
 * of its moves, for a surface nobody keeps. A rough with no leave has no stock
 * to spend and keeps the surface bound.
 *
 * Only the target's own grid takes it. The columns a neighbour model can reach
 * (`mergeNeighbourColumns`) keep the surface bound: a neighbour is not this
 * operation's material to be approximate about.
 */
export function rotaryRefinementToleranceFloor(
  params: Pick<RotaryFinishParams, 'stockToLeave'> & { readonly stepdown?: number },
  units: Units,
): number {
  const surface = convertLength(AROUND_ANGLE_TOLERANCE_MM, 'mm', units)
  if (!('stepdown' in params)) return surface
  const leave = params.stockToLeave
  if (!Number.isFinite(leave) || !(leave > 0)) return surface
  return Math.max(surface, leave * ROUGH_REFINEMENT_LEAVE_SHARE)
}
