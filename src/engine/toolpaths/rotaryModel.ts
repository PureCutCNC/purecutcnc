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

import { barCentre, barInscribedRadius, barMaxRadius, barPivotZ, isSquareStock } from '../../types/barStock'
import { type BarStock, type Clamp, getStockBounds } from '../../types/project'
import { convertLength, type Units } from '../../utils/units'
import {
  buildContinuousHelix,
  type ContinuousBandInput,
  type ContinuousHelix,
  type ContinuousHelixSpend,
  walkContinuousBand,
} from './rotaryContinuous'
import { finishFromTargets } from './rotaryModelFinish'
import {
  alongCoordinate,
  boundsOf,
  continuousHelixStepover,
  continuousHelixStubFloor,
  emitRotaryRuns,
  retainedStubStepForced,
  ringRuns,
  type RotaryLinkStep,
  type RotaryRun,
} from './rotaryModelMotion'
import type { RotaryFinishParams, RotaryRoughParams } from './rotaryModelParams'
import {
  continuousPathInsideRegion,
  rotaryRegionContains,
  rotaryRegionSegmentContains,
  rotaryRegionSlopeContains,
} from './rotaryModelRegion'
import { AROUND_RAISE_TOLERANCE_MM, mergeCollinearCuts, raiseShortAroundSegments } from './rotaryModelSimplify'
import {
  MAX_LINK_WORK,
  type RotaryLinkRow,
  rotaryTargets,
  type RotaryTargets,
  rotaryTargetsAsync,
} from './rotaryModelTargets'
import { aroundArcStep, boundedIntervals, rotaryRefinementToleranceFloor } from './rotaryModelTargetSampling'
import {
  MAX_ROTARY_SAMPLES,
  type RotaryBatchFactory,
  type RotaryModelMesh,
  type RotarySampleOptions,
  serialRotaryBatches,
} from './rotarySampling'
import { rotaryTravelZ, squareRotaryTouchRadius } from './squareRotaryStock'
import type { NormalizedTool, ToolpathMove, ToolpathPoint, ToolpathResult } from './types'
import type { ToolpathWarning, ToolpathWarningCode } from './warningCodes'

export { rotaryRegionContains, rotaryRegionSegmentContains, rotaryRegionSlopeContains } from './rotaryModelRegion'
export { mergeCollinearCuts, raiseShortAroundSegments } from './rotaryModelSimplify'

export type { RotaryFinishParams, RotaryRegionMask, RotaryRoughParams } from './rotaryModelParams'
export { rotarySampledMesh } from './rotaryModelTargetGeometry'
export { linkRowBudget, type RotaryLinkBucket, type RotaryLinkRow } from './rotaryModelTargets'
export {
  rotaryConservativeSampling,
  rotaryRefinementToleranceFloor,
  ROUGH_REFINEMENT_LEAVE_SHARE,
} from './rotaryModelTargetSampling'

/**
 * The sampling half of rotary generation lives in `rotarySampling.ts` since
 * #1115 slice p-d1: preparation, the per-angle job, ordered assembly and the
 * refinement decisions, with a synchronous and an asynchronous driver. This
 * module owns the public entry points and roughing. Shared target planning
 * lives in rotaryModelTargets.ts, and finishing in rotaryModelFinish.ts.
 *
 * The sampler's public surface is re-exported here so every existing import
 * site keeps working: the generators, `rotaryOperation.ts` and the focused
 * suites all read it from this module.
 */
export { sampleRotaryModel, serialRotaryBatches, turnedModelPositions } from './rotarySampling'
export type {
  RotaryAngleBatch,
  RotaryAngleJob,
  RotaryAngleSample,
  RotaryBatchFactory,
  RotaryModelMesh,
  RotarySampleOptions,
  RotarySampling,
  RotarySamplingPrep,
  RotarySamplingSetup,
} from './rotarySampling'

/** Both controller spellings of the same physical bar rotation (A0 and A360). */
function sameRotaryAngle(a: number, b: number): boolean {
  const delta = ((b - a) % 360 + 360) % 360
  return delta <= 1e-9 || delta >= 360 - 1e-9
}

/**
 * Feed a rough ring through its short air gaps instead of retracting (#1173).
 *
 * A gap between two cutting runs of one ring is a span where the model stands
 * at or above the previous layer (`tip >= previousRadius`), so this layer has
 * nothing to cut there. Every link planner joins **rings** (`toAlong >
 * fromAlong`), so such a gap used to go to travel height: on Frank's bolt the
 * Hex corners split the overlap rings into six runs and the tool lifted to Z1,
 * rapided about 20 degrees and plunged at the plunge feed at every corner.
 *
 * A gap of at most `MAX_LINK_ACROSS_DEG` is instead fed through at the gap
 * samples' own tips. Each of those tips is the drop-cutter height on the model
 * (stock to leave included), and it is below the blank, so an earlier layer cut
 * exactly there: the first layer whose radius is at or below the tip cut that
 * sample to the tip itself. The feed therefore runs in space the earlier layers
 * cleared, on the same refined angle grid -- and so the same between-sample
 * chord check -- as every cut. A gap sample that is air for another reason is
 * not fed: no model under the tool (`NaN`), a tip at the blank's own radius,
 * or a sample outside the #1096 region, where no layer cut at all. The caller
 * skips square blanks, whose gaps are the corner gate's air.
 *
 * `samples` is changed in place; `tips[k][column]` is the transformed tip.
 */
export function feedThroughRingGaps(
  samples: (ToolpathPoint | null)[],
  tips: readonly (readonly number[])[],
  column: number,
  angles: readonly number[],
  previousRadius: number,
  maxRadius: number,
  insideRegion: ((alongValue: number, angle: number) => boolean) | null,
  alongValue: number,
  point: (alongPosition: number, tip: number, angle: number) => ToolpathPoint,
): void {
  const last = samples.length - 1
  let k = 0
  while (k <= last) {
    if (samples[k] !== null) {
      k++
      continue
    }
    let end = k
    while (end <= last && samples[end] === null) end++
    // Interior gaps only: a gap touching either ring end is the seam, which the
    // ring-to-ring links handle.
    if (k > 0 && end <= last && angles[end] - angles[k - 1] <= MAX_LINK_ACROSS_DEG) {
      let air = true
      for (let j = k; j < end && air; j++) {
        const tip = tips[j][column]
        air = Number.isFinite(tip) && tip >= previousRadius && tip < maxRadius
          && (insideRegion === null || insideRegion(alongValue, angles[j]))
      }
      if (air) {
        for (let j = k; j < end; j++) samples[j] = point(alongValue, tips[j][column], angles[j])
      }
    }
    k = end
  }
}

/**
 * How far round the bar a cutter's body reaches past its own pose, in degrees,
 * with its tip at radius `tip` (#1177). A ball's sphere, centred `tip + r` from
 * the axis, touches rays up to `asin(r / (tip + r))` away; a flat's bottom disc
 * reaches its rim at `atan(r / tip)`. Both grow as the tip goes down.
 */
export function rotaryBodyAngularReachDeg(tool: NormalizedTool, tip: number): number {
  const r = Math.max(0, tool.radius)
  const reach = tool.type === 'ball_endmill'
    ? Math.asin(Math.min(1, r / Math.max(tip + r, 1e-12)))
    : Math.atan2(r, Math.max(tip, 0))
  return reach * 180 / Math.PI
}

/**
 * The most cutter-body window work one around operation may spend (#1093).
 * The windowed leftover walk costs `linkRow x along x windowRows` per computed
 * angle window, and the link plan asks for it at every ring boundary. Caching by
 * the window's row span (not the per-link `required`) shares the walk between
 * links whose body reaches the same rows; this budget bounds the sum that the
 * per-call `MAX_LINK_WORK` cannot. Past it the remaining links retract through
 * the old travel path, so a long, fine job stays finite instead of running a
 * quadratic pass for every ring.
 *
 * #1117 fix 1 (P2): **each** link path gets its own budget -- the raised link
 * and the at-layer candidate. The at-layer candidate can be rejected after its
 * walk, and the raised link is the fallback for every boundary it does not win;
 * charging both to one counter let a rejected attempt starve a later raised
 * link, which then dropped to the travel height instead of the raised height the
 * baseline gave it.
 *
 * #1117 fix 2 (P2): the raised bucket also has to advance for an **accepted**
 * at-layer link. The candidate is an addition to the link plan, not a
 * replacement for the raised plan's accounting: the baseline (`805abe6a`)
 * charged the raised walk at every eligible boundary, so skipping it wherever
 * the candidate won left the bucket under-spent and a later rejected boundary
 * found material the baseline had already refused to walk. The fix computes the
 * raised plan first, at every eligible boundary, and only then overrides the
 * **emitted** steps with the at-layer candidate; the raised walk's charge and
 * cache entries therefore reproduce the baseline exactly, wherever the boundary
 * lands. The candidate's own bucket and cache keys stay separate, so it can
 * never spend what the raised plan needs.
 */
const MAX_LINK_WINDOW_WORK = 4 * MAX_LINK_WORK

/**
 * The widest A change a **round** bar's at-layer link may sweep (#1117 rl-e).
 *
 * An A-changing link is the partial-ring case: one ring's run ends where the
 * material crosses this layer's radius, and the next ring's run starts at the
 * angle that crossing has moved to. A few degrees of drift is that case. A wide
 * change is a different transition -- a lobe boundary jumping most of the bar --
 * and nothing in this slice proves that swept **surface**; past this bound the
 * round bar keeps the raised link, exactly as it would today.
 *
 * A **square** blank's wide change is the model gap between two rings of one
 * layer: the ring's cut span is the complement of the gap, so the forward step
 * from one ring's last cut to the next ring's first is the gap's width (up to a
 * good part of the circle). The at-layer proof below samples every row the
 * sweep crosses and the row budget, not this bound, decides whether it can be
 * proven (#1103 ca-d fix 1, review P2).
 */
const MAX_LINK_ACROSS_DEG = 45

/**
 * The most model rows one around operation may sample for A-changing links
 * (#1117 rl-e). Each candidate needs a link row per grid angle its path
 * crosses, and the rows are not shared between boundaries the way a full ring's
 * single shared angle is. Past the budget the remaining candidates keep the
 * raised link, which is the pre-slice behaviour, so a long job cannot turn the
 * link plan into an unbounded number of model passes; the per-candidate cap
 * keeps one wide drift from spending the whole budget.
 */
// #1103 ca-d fix 1: sized for the square blank's wide model gaps, which the
// drift bound no longer refuses. Measured on busto-rect: the 44 wide gaps of
// its last layers cross 469 rows at most and 15 678 rows in total, so the
// operation budget admits every one and the per-link cap admits the largest
// with room to spare. A gap over either budget keeps the raised link, exactly
// as before; rows another candidate already sampled cost nothing.
const MAX_LINK_ACROSS_ROWS = 24_000
const MAX_LINK_ACROSS_ROWS_PER_LINK = 1_024

/**
 * The A-grid rows one A-changing link crosses, and each row's angle unwrapped
 * into the link's commanded frame (#1103 ca-d fix 1).
 *
 * A forward-only ring turns A the same way as the ring before it, so a boundary
 * that ends just below A360 and the next ring's start just above it is a short
 * forward step **across the seam** (A346 -> A7). `pointIndexAt` maps both ends
 * into the 0..360 grid, and physical row indices run 157 -> 0 for that step, so
 * a walk from one index to the other goes the long way round the bar: it samples
 * rows hundreds of degrees from the pose and charges the whole circumference
 * against the per-link row budget. This helper instead walks in the commanded
 * direction `delta`, wrapping at the seam (row 0 is both A0 and A360), and
 * returns every row's angle unwrapped **in traversal order** so the result is
 * monotone in `delta` -- even for a sweep wider than 180 degrees -- and
 * bracketing a commanded pose reads the rows it actually crosses.
 *
 * Exported for the seam-sampling regression in
 * `rotaryAcrossAngleLinks.test.ts`; the caller is `linkAcrossAngle`.
 */
export function rotaryLinkRowSweep(
  angles: readonly number[],
  fromK: number,
  toK: number,
  fromA: number,
  delta: number,
): { readonly rows: number[]; readonly angles: number[] } | null {
  const rowCount = angles.length - 1
  if (rowCount < 1 || !Number.isFinite(fromA) || !Number.isFinite(delta) || delta === 0) return null
  if (fromK < 0 || toK < 0 || fromK >= angles.length || toK >= angles.length) return null
  const step = delta > 0 ? 1 : -1
  const canonical = (k: number): number => (k >= rowCount ? k - rowCount : k)
  const target = canonical(toK)
  const rows: number[] = [canonical(fromK)]
  let k = rows[0]
  while (k !== target && rows.length <= rowCount) {
    k += step
    if (k >= rowCount) k -= rowCount
    else if (k < 0) k += rowCount
    rows.push(k)
  }
  // A guard, not a case: the canonical wrap reaches the target within one grid
  // turn for any pair of row indices.
  if (rows[rows.length - 1] !== target) return null
  // Unwrap each row **from the one before it**, not from the start angle (#1103
  // ca-d correction 2, review P1). Shifting every row to the turn nearest
  // `fromA` is monotone only while the sweep stays inside half a turn: past
  // 180 degrees two adjacent rows sit on opposite sides of the rounding
  // boundary and the later one is moved back a whole turn, so the returned
  // angles jump backwards (the ring suite's accepted A17967.115 -> A18235.385
  // link produced A18145.385 -> A17788.846). The monotone cursor that consumes
  // these angles then stops early and brackets the pose with the wrong rows.
  // Stepping each row's grid increment along the commanded direction keeps the
  // sequence monotone by construction, however wide the sweep, and the grid
  // seam (row 0 is both A0 and A360) is crossed as the short forward step it is.
  const rowAngles: number[] = [angles[rows[0]] + 360 * Math.round((fromA - angles[rows[0]]) / 360)]
  for (let i = 1; i < rows.length; i++) {
    let stepDegrees = angles[rows[i]] - angles[rows[i - 1]]
    if (step > 0 && stepDegrees <= 0) stepDegrees += 360
    else if (step < 0 && stepDegrees >= 0) stepDegrees -= 360
    rowAngles.push(rowAngles[i - 1] + stepDegrees)
  }
  return { rows, angles: rowAngles }
}

// Bound emission as well as sampling: every layer revisits the entire sampled
// grid, even when the touch gate ultimately skips it (#1045 slice N). Both this
// budget and `MIN_ROTARY_STEPDOWN_MM` are **around-mode** bounds (#1045 slice
// P): along mode keeps the emission it always had, because those caps can
// refuse a job along mode used to accept (the 0.009 mm fixture below).
const MAX_ROTARY_EMISSION_WORK = 16_000_000
const MIN_ROTARY_STEPDOWN_MM = 0.01

/**
 * Refuse a job whose sample count would be unbounded, and a bar with no surface
 * to cut. `stepover` becomes the angle step (`ceil(2 pi R / stepover)` passes)
 * and `sampleSpacing` the along interval count (`ceil(span / sampleSpacing)`);
 * flooring either at 1e-9 rather than refusing it asks for about 6e10 samples
 * and hangs the worker mid-generation. A bar with no positive radius has no
 * centreline the wrapped points could be placed on.
 *
 * The positivity checks alone do not bound those counts: `sampleSpacing = 1e-9`
 * is positive and finite and asks for 2.4e10 intervals, so the derived counts
 * themselves are checked here before any grid is allocated (#1016 C2-S3
 * correction).
 *
 * This is the **uniform** bound, cheap enough to run before the along positions
 * are built. `rotaryTargets` re-checks the budget against the square blank's
 * actual refined along count, because the shoulder zones add up to `2 *
 * MAX_SHOULDER_SAMPLES` positions this quotient does not see; keeping this
 * check as well stops a huge uniform grid from being materialised just to be
 * refused there.
 */
function rotaryRefusal(stock: BarStock, params: RotaryFinishParams, units: Units): ToolpathWarningCode | null {
  const radius = barInscribedRadius(stock)
  if (!(radius > 0) || !Number.isFinite(radius)) return 'aroundStockMismatch'
  if (!(params.stepover > 0) || !Number.isFinite(params.stepover)) return 'operationStepoverRatioRange'
  if (!(params.sampleSpacing > 0) || !Number.isFinite(params.sampleSpacing)) return 'operationStepoverRatioRange'
  // A non-finite cell makes the height map's own derived width/height
  // non-finite, which `Array` cannot size; `chooseHeightMapCellSize` clamps a
  // zero or negative request to 1e-6 but passes a non-finite one through.
  if (!Number.isFinite(params.requestedCellSize)) return 'operationStepoverRatioRange'
  // Around mode swaps the two roles: `sampleSpacing` is the angular step round
  // the blank and `stepover` the step along it (#1045 slice A). The along
  // counts checked here are the mode's own, so an around job is neither refused
  // for a pass count it does not have nor allowed an unbounded one. The angle
  // step is the capped one `aroundGrid` builds (#1045 slice D), so this check
  // bounds exactly the grid that is about to be allocated.
  if (params.passDirection === 'around') {
    const angular = boundedIntervals(2 * Math.PI * barMaxRadius(stock), aroundArcStep(stock, params, units))
    const axial = boundedIntervals(params.alongEnd - params.alongStart, params.stepover)
    if (angular === null || axial === null) return 'operationStepoverRatioRange'
    if ((angular + 1) * (axial + 1) > MAX_ROTARY_SAMPLES) return 'operationStepoverRatioRange'
    return null
  }
  const passes = Math.ceil((2 * Math.PI * barMaxRadius(stock)) / params.stepover)
  const intervals = boundedIntervals(params.alongEnd - params.alongStart, params.sampleSpacing)
  if (!Number.isFinite(passes) || passes > MAX_ROTARY_SAMPLES || intervals === null) return 'operationStepoverRatioRange'
  if (passes * (intervals + 1) > MAX_ROTARY_SAMPLES) return 'operationStepoverRatioRange'
  return null
}

/**
 * The checks both finish drivers run before any sampling. A result means
 * "refuse, emit this and nothing else" (#1115 slice p-d1).
 */
function finishRefusal(
  operationId: string,
  stock: BarStock,
  tool: NormalizedTool,
  params: RotaryFinishParams,
): ToolpathResult | null {
  if (tool.type !== 'ball_endmill' && tool.type !== 'flat_endmill') {
    return {
      operationId,
      moves: [],
      warnings: [{ code: 'rotaryToolUnsupported', params: { operation: operationId } }],
      bounds: null,
    }
  }
  const refusal = rotaryRefusal(stock, params, tool.units)
  if (refusal) {
    return { operationId, moves: [], warnings: [{ code: refusal, params: { operation: operationId } }], bounds: null }
  }
  if (params.alongEnd <= params.alongStart) {
    return { operationId, moves: [], warnings: [{ code: 'rotaryNoRoom', params: { operation: operationId } }], bounds: null }
  }
  return null
}

/**
 * The continuous helix's operation-wide input for one roughing layer (#1103
 * slices ca-d, ca-g and ca-j).
 *
 * Same prep as the ring grid -- same mesh, tool, cell size, retained-wall
 * metadata and shared workspace -- with the layer's own two rules supplied per
 * attempt through {@link ContinuousHelixLayer}: every pose is floored at
 * `radius` and a pose with no material above `previousRadius` refuses the band.
 * A square blank adds its retained-stub floor here (as the finish does) and its
 * material-touch gate on the layer itself, because that gate depends on the
 * layer's radius, and its turns overlap (`continuousHelixStepover`). `null` when
 * the targets carry no prep (a refusal/cancellation never reaches here), and the
 * band walk then keeps every ring of the band.
 */
function continuousRoughInput(
  sampling: RotaryTargets,
  params: RotaryRoughParams,
  tool: NormalizedTool,
  warnings: ToolpathWarning[],
  hooks: Pick<RotarySampleOptions, 'onAngle' | 'shouldStop'>,
): ContinuousBandInput | null {
  const prep = sampling.prep
  if (prep === null) return null
  const stubFloor = continuousHelixStubFloor(prep.stock, tool, params)
  return {
    prep,
    tool,
    stepover: continuousHelixStepover(prep.stock, tool, params.stepover),
    sampleSpacing: params.sampleSpacing,
    stockToLeave: sampling.stockToLeave,
    // #1185 R2: the helix is held to the bound the rough's rings are.
    toleranceFloor: rotaryRefinementToleranceFloor(params, tool.units),
    // #1173/#1177: the same exact read as the finish's, for the same reasons --
    // including the ball's, and including the pad being the flat's alone.
    ...(isSquareStock(prep.stock)
      ? {}
      : {
        readExactRows: true,
        ...(tool.type === 'ball_endmill'
          ? {}
          : { exactTipPad: params.requestedCellSize * 1.25 }),
      }),
    warnings,
    ...(stubFloor !== undefined ? { stubFloor } : {}),
    ...(hooks.shouldStop !== undefined ? { shouldStop: hooks.shouldStop } : {}),
  }
}

/**
 * Rotary finishing (issue #1015 slice B): passes run along the bar and step
 * round it, so a ball nose leaves its best surface along a long part.
 *
 * The height sampler is the only thing that knows the model. Its cells hold the
 * raw model height, so stock to leave is applied by sampling with the tool's
 * radius enlarged by `s` and then adding `s` back at the tip. For a ball nose
 * that composition is the offset the surface actually gets: the centre of the
 * enlarged ball is the real ball's centre moved outward along the surface normal
 * by exactly `s`, so the enlarged ball's tip plus `s` is the real ball's tip
 * offset by `s` normal to the surface. On a convex contact -- where the ball
 * touches at a single high point -- that normal is vertical, so the result is
 * also a plain vertical `s`; in a valley it is not, and the enlarged ball sits
 * higher on the walls than the plain ball plus a vertical `s` would. A flat end
 * mill has no ball centre to move, so this is the enlargement's approximation
 * for it. A call with zero stock is bit-identical to the sampler's own value,
 * which is the contract every caller of the sampler relies on.
 *
 * A `NaN` sample -- no model under the tool -- is not cut. The finish follows
 * the model, and taking waste off an off-axis part is the rough's job, so each
 * pass is cut as runs of finite samples: between runs, and from one pass to the
 * next when they do not join at the same bar end, the tool rises to the bar's
 * surface plus a clearance, traverses there and plunges; only the operation's
 * first positioning move and its final retract go to the rapid height, the
 * higher of `safeRadius` and that clearance. A pass with
 * no finite sample emits nothing. Cutting the centreline instead would be
 * full-width, full-depth slotting with a finishing tool, silently.
 *
 * With `passDirection: 'around'` (#1045 slice A) the pass runs round the bar
 * instead: one **ring** per along position, the angle sweeping the whole turn,
 * then a step along. Since #1103 slice ca-c A never reverses: every ring turns
 * the same way and the next ring continues from the angle the last one reached,
 * so commanded A grows by one turn per ring and is never wrapped modulo 360
 * (#1091 -- the controller owns the A range). A band of rings whose every
 * sample is the model under the tool (and whose region, if the operation has
 * one, contains the whole band) is cut by one **continuous helix**
 * (`buildContinuousHelix`): a one-way turn that advances along the bar with a
 * pitch no larger than the stepover, closed by a complete ring at each axial
 * end. Its poses are sampled at the actual combined `(along, A)` position, and
 * every segment is refined against the operation's between-sample tolerance, so
 * a ridge that falls between two ring positions is followed rather than
 * interpolated. A band the helix refuses -- a budget that runs out, a pose with
 * no model, a partial ring, a region that trims the band, a square blank --
 * keeps its rings, now forward-only. Since #1103 slice ca-g a band is no longer
 * helix-or-nothing: when the attempt's refinement is still unresolved on some
 * segments it reports where, and the band is cut as helices on the runs that do
 * verify with forward-only rings around the spans that do not
 * (`walkContinuousBand`). Only a tolerance refusal says where to split; the
 * other refusals above still cost the whole band its helix.
 *
 * A full ring's end (`A = 360k`) and the next ring's start (`A = 360(k+1)`) are
 * the same **commanded** angle, which is exactly #1093's constant-A
 * precondition, so those rings still link with a feed along the bar that follows
 * the model at that angle through a sample row no coarser than the ring spacing
 * or a quarter of the tool radius. A ring the model splits into runs, or the
 * region trims to an interior arc, ends at an angle whose next occurrence is a
 * full turn away, so the exact-A link no longer applies and the emitter's
 * travel-height transition handles it (the plan's "safe gaps" for partial
 * rings). A **region** (#1096 slice D) that contains the whole band keeps the
 * helix: every segment's swept path is proved against the mask's own boundary
 * test, the same rule the rough's A-changing links use. A region that trims the
 * band, a ring the model leaves as several pieces, and an arc wrapping the
 * A0/A360 seam all retract as before. A `NaN` sample is still not cut, the
 * layer links are the same emitter's, and the steep-step rule measures their
 * surface distance along the arc rather than across X/Y. A saved operation
 * without the field keeps the along motion above byte for byte -- the shape of
 * the motion, not its band: the slice-D retained-end pull applies to both modes
 * and is a safety fix.
 *
 * A **square** blank supports around mode too (#1045 slice C). Each sample is
 * already floored at its own exact retained-stub contact by `rotaryTargets`
 * (the C2-F6 floor), so a ring near a stubbed end cannot cut the square that
 * holds the part. A square blank cannot be helixed (its corners are not a
 * surface of revolution and its retained-corner floor belongs to the ring path),
 * so its rings stay rings, forward-only with the emitter's travel-height
 * transition where the exact-A link does not hold; the along *step* is the
 * operation's own `stepover`, and the stub's angular profile is resolved by
 * `sampleSpacing`.
 *
 * A finish only follows the model. It emits no clearing layers and reads no
 * other operation: its motion is the model-following passes below, in along and
 * around mode, on a round bar and a square blank alike. A finish that runs
 * without an earlier rough therefore cuts to full depth in one pass; the
 * operation adapter (`rotaryOperation.ts`) warns about that from the project's
 * operation list, and that warning is advisory only -- it changes no motion.
 * This is the 2026-10-22 decision that replaced the self-protecting finish
 * rules of #1045 slices M/P/R/R2. Its radial stock to leave follows the same
 * rule as the rough's (#1095): it applies to the model surface only, so the
 * retained end walls keep their real size and the pass beside them is not
 * lifted over a wall thickened by the leave.
 */

/**
 * The finish's synchronous driver (#1115 slice p-d1): the checks, the sampling
 * and the emission are three shared stages, so the asynchronous driver below
 * cannot drift from this one.
 */
export function generateRotaryFinish(
  operationId: string,
  mesh: RotaryModelMesh,
  stock: BarStock,
  tool: NormalizedTool,
  params: RotaryFinishParams,
  hooks: Pick<RotarySampleOptions, 'onAngle' | 'shouldStop'>,
): ToolpathResult {
  const refused = finishRefusal(operationId, stock, tool, params)
  if (refused) return refused
  const warnings: ToolpathWarning[] = []
  const sampling = rotaryTargets(operationId, mesh, stock, tool, params, hooks, warnings)
  return finishFromTargets(operationId, stock, tool, params, hooks, sampling, warnings)
}

/**
 * Rotary finishing through an injected batch factory (#1115 slice p-d1): the
 * same checks, the same per-angle job and the same emission, with each angle
 * batch awaited instead of run inline.
 *
 * Nothing calls it on the generation path yet; p-d2's pool supplies the factory
 * and p-d3 wires the worker. The default is the in-process serial runner.
 */
export async function generateRotaryFinishAsync(
  operationId: string,
  mesh: RotaryModelMesh,
  stock: BarStock,
  tool: NormalizedTool,
  params: RotaryFinishParams,
  hooks: Pick<RotarySampleOptions, 'onAngle' | 'shouldStop'>,
  factory: RotaryBatchFactory = serialRotaryBatches,
): Promise<ToolpathResult> {
  const refused = finishRefusal(operationId, stock, tool, params)
  if (refused) return refused
  const warnings: ToolpathWarning[] = []
  const sampling = await rotaryTargetsAsync(operationId, mesh, stock, tool, params, hooks, warnings, factory)
  return finishFromTargets(operationId, stock, tool, params, hooks, sampling, warnings)
}

export interface RotarySupports {
  /** Bar length kept uncut at the chuck end, measured from that end of the bar. */
  readonly chuckEnd: number
  /** Bar length kept uncut at the tail end. */
  readonly tailEnd: number
}

export function rotaryAlongRange(
  stock: BarStock,
  clamps: readonly Clamp[],
  modelAlong: { readonly min: number; readonly max: number },
  tool: NormalizedTool,
  supports: RotarySupports,
): { start: number; end: number } | null {
  const bounds = getStockBounds(stock)
  const lower = stock.axis === 'x' ? bounds.minX : bounds.minY
  const upper = stock.axis === 'x' ? bounds.maxX : bounds.maxY
  const clampEnds = (clamp: Clamp): { min: number; max: number } => {
    const min = stock.axis === 'x' ? clamp.x : clamp.y
    return { min, max: min + (stock.axis === 'x' ? clamp.w : clamp.h) }
  }
  const chuck = clamps.find((clamp) => clamp.type === 'chuck')
  const chuckBounds = chuck && clampEnds(chuck)
  const chuckLower = !chuckBounds || (chuckBounds.min + chuckBounds.max) / 2 <= (lower + upper) / 2
  const supportAtStart = chuckLower ? supports.chuckEnd : supports.tailEnd
  const supportAtEnd = chuckLower ? supports.tailEnd : supports.chuckEnd
  // The tool's side must not enter a support either, so a support length is
  // kept clear by the tool's radius as well as by its own. A support of zero
  // means "no support": the model's own extent still limits the range, and
  // nothing here reserves a radius for a support that does not exist.
  const clearance = (support: number): number => support > 0 ? support + tool.radius : 0
  let start = lower + clearance(supportAtStart)
  let end = upper - clearance(supportAtEnd)
  for (const clamp of clamps) {
    if (clamp.type !== 'chuck' && clamp.type !== 'tailstock') continue
    const edge = clampEnds(clamp)
    if ((edge.min + edge.max) / 2 <= (lower + upper) / 2) start = Math.max(start, edge.max + tool.radius)
    else end = Math.min(end, edge.min - tool.radius)
  }
  // Beyond the model there is nothing under the tool: a pass would cut down
  // to the centreline and part the work. Keep that bar at full radius so the
  // model stays attached to its end supports.
  start = Math.max(start, modelAlong.min)
  end = Math.min(end, modelAlong.max)
  return start < end ? { start, end } : null
}

/**
 * The checks both rough drivers run before any sampling; a result means "refuse,
 * emit this and nothing else" (#1115 slice p-d1).
 */
function roughRefusal(
  operationId: string,
  stock: BarStock,
  tool: NormalizedTool,
  params: RotaryRoughParams,
): ToolpathResult | null {
  if (tool.type !== 'ball_endmill' && tool.type !== 'flat_endmill') {
    return { operationId, moves: [], warnings: [{ code: 'rotaryToolUnsupported', params: { operation: operationId } }], bounds: null }
  }
  const refusal = rotaryRefusal(stock, params, tool.units)
  if (refusal) {
    return { operationId, moves: [], warnings: [{ code: refusal, params: { operation: operationId } }], bounds: null }
  }
  if (params.alongEnd <= params.alongStart) {
    return { operationId, moves: [], warnings: [{ code: 'rotaryNoRoom', params: { operation: operationId } }], bounds: null }
  }
  if (!Number.isFinite(params.stepdown) || params.stepdown <= 0) {
    return { operationId, moves: [], warnings: [{ code: 'stepdownPositive', params: { operation: operationId } }], bounds: null }
  }
  // The 0.01 mm floor and the emission budget below exist for the **around**
  // path, whose layer count is derived from the stepdown and whose rings revisit
  // the whole sampled grid (#1045 slices N/P). Along mode keeps the emission it
  // had before slice N: a saved 0.009 mm job that generated 27,804 moves at
  // 9345c132 is accepted here again, and a job that was slow before is slow, not
  // refused. Both bounds are therefore around-only.
  const around = params.passDirection === 'around'
  if (around && params.stepdown < convertLength(MIN_ROTARY_STEPDOWN_MM, 'mm', tool.units)) {
    return { operationId, moves: [], warnings: [{ code: 'rotaryStepdownBelowMinimum', params: { operation: operationId } }], bounds: null }
  }
  return null
}

/**
 * The rough's motion from sampled targets (#1115 slice p-d1). Both drivers end
 * here, so the layer walk, the links and the merged output cannot differ between
 * them.
 */
function roughFromTargets(
  operationId: string,
  stock: BarStock,
  tool: NormalizedTool,
  params: RotaryRoughParams,
  hooks: Pick<RotarySampleOptions, 'onAngle' | 'shouldStop'>,
  sampling: RotaryTargets,
  warnings: ToolpathWarning[],
): ToolpathResult {
  if (sampling.refusal) {
    return { operationId, moves: [], warnings: [{ code: sampling.refusal, params: { operation: operationId } }], bounds: null }
  }
  if (sampling.stopped) return { operationId, moves: [], warnings: [], bounds: null }
  const around = params.passDirection === 'around'
  // A `NaN` sample means "no model under the tool", which for the rough is the
  // pivot: it removes the layer down to the axis there. The finish does
  // the opposite -- a `NaN` sample is not cut -- because only the rough exists
  // to take waste off. Where a square blank's retained stub reaches the sample
  // the axis fallback is not allowed -- the cutter's side would enter the stub --
  // so the effective tip is the higher of the fallback and the exact contact
  // (#1016 C2-F6b). `stubFloor` is `null` on a round bar and `-Infinity`
  // wherever no stub reaches, which leaves the old fallback byte for byte.
  const stubFloor = sampling.stubFloor
  const tips = sampling.tips.map((row, k) => row.map((tip, i) =>
    Number.isFinite(tip) ? tip : Math.max(0, stubFloor ? stubFloor[k][i] : Number.NEGATIVE_INFINITY)))
  const { angles, along } = sampling
  const pivot = barPivotZ(stock)
  const maxRadius = barMaxRadius(stock)
  const centre = barCentre(stock)
  const square = isSquareStock(stock)
  // Every move between runs at every layer -- a turning link, the retract off a
  // run, or the traverse to the next run -- travels at the blank's largest
  // surface plus a clearance, for the same reason the finish does: the model
  // between the two pass angles is not otherwise checked, and a full retract to
  // `safeRadius` on every gap dominates a many-layer rough. `safeRadius` is
  // never allowed to cap it down towards the bar; the first positioning move
  // and the final retract go to the higher of the two heights.
  const travelZ = rotaryTravelZ(stock, tool.units)
  const safeZ = Math.max(pivot + params.safeRadius, travelZ)
  // The layer count and the band each layer cuts are still counted from the
  // blank's largest radius, so a square blank's corners are covered from the
  // first layer (#1016 C2-S3). What changes for a square is *which* of those
  // bands a pass actually cuts: a flat's bottom is a disc at the tip, so a pass
  // skips a band whose tip is at or above the inside-slab material height the
  // blank reaches at that angle (#1016 C2-F2, C2-F2b); a ball's lower surface
  // is a sphere, so the same call returns its exact contact height instead of
  // that upper bound (#1016 C2-F2c). A round bar's footprint radius is
  // constant, so it keeps the old output byte for byte and the helper is not
  // even called.
  let lowest = maxRadius
  for (const row of tips) for (const tip of row) lowest = Math.min(lowest, tip)
  // #1173 fix 3: the floor is the **target's** exact minimum, not the ring
  // grid's conservative one. The grid's read lifts every sample by its angle's
  // cell rise, so its minimum stands that much above the surface the helix's
  // exact rows cut; and an exact neighbour or wall-foot column could pull it
  // down instead, moving the whole bar's last layer with the neighbour's
  // presence. `layerFloor` is read on the target and stubs at the target's own
  // along grid (see `exactLayerFloor`), so the floor is the same with or
  // without a neighbour and sits on the surface the helix cuts. It only ever
  // lowers this minimum: the last layer still never cuts below a sample.
  if (sampling.layerFloor !== null) lowest = Math.min(lowest, sampling.layerFloor)
  const layers = Math.ceil((maxRadius - lowest) / params.stepdown)
  // #1177: a region's angular edge drafts inwards as the layers go down. The
  // region bounds the cutter's **centre**, but its body reaches further round
  // the bar the lower its tip (`rotaryBodyAngularReachDeg`), so a deeper layer
  // cut to the same edge buries its flank in wall no layer above it opened: on
  // a D1.5 ball reaching the model at r2 under a 1.5 stepdown that was a 2.0 mm
  // undercut at 10.4 degrees past the edge. Each layer's edge therefore stands
  // in from the region's by the reach it gained over the first layer, so it
  // only reaches rays the first layer already reached. The first layer, and
  // any operation without a region, is unchanged.
  const firstLayerRadius = Math.max(lowest, maxRadius - params.stepdown)
  const firstLayerReach = rotaryBodyAngularReachDeg(tool, firstLayerRadius)
  const cutsInRegion = (alongPosition: number, angle: number, cutTip: number): boolean => {
    if (insideRegion === null) return true
    if (!insideRegion(alongPosition, angle)) return false
    const draft = rotaryBodyAngularReachDeg(tool, cutTip) - firstLayerReach
    if (!(draft > 1e-9)) return true
    return insideRegion(alongPosition, angle - draft) && insideRegion(alongPosition, angle + draft)
  }
  // A non-finite layer count is not a job any version of this generator ever
  // finished: it is `Number.MIN_VALUE`-sized stepdown, and the loop would never
  // terminate. Refusing that is a hang guard, not the work budget (#1045 slice
  // P keeps the 16M cap for around mode only: along mode used to accept larger
  // jobs, so capping it would refuse output that worked before).
  if (!Number.isFinite(layers)) {
    return { operationId, moves: [], warnings: [{ code: 'rotaryWorkBudgetExceeded', params: { operation: operationId } }], bounds: null }
  }
  if (around && layers * angles.length * along.length > MAX_ROTARY_EMISSION_WORK) {
    return { operationId, moves: [], warnings: [{ code: 'rotaryWorkBudgetExceeded', params: { operation: operationId } }], bounds: null }
  }
  const forceStep = retainedStubStepForced(stock, params, tool)
  // #1096: a sample outside the operation's region is not cut, at any layer.
  // The mask is null when the operation targets no region, and then nothing
  // below reads it -- the motion is exactly the pre-region output.
  const region = params.region ?? null
  const insideRegion = region === null
    ? null
    : (alongPosition: number, angle: number) => rotaryRegionContains(region, stock, alongPosition, angle)
  const moves: ToolpathMove[] = []
  let here: ToolpathPoint | undefined
  const point = (position: number, tip: number, angle: number): ToolpathPoint => stock.axis === 'x'
    ? { x: position, y: centre, z: pivot + tip, a: angle }
    : { x: centre, y: position, z: pivot + tip, a: angle }
  // #1093: a link between cuts of this operation rises only to the highest
  // material this operation's own earlier layers can still leave on the link's
  // along span, plus the clearance every travel move uses today, and never
  // below the two cuts it joins. The link angle is the one both cuts share -- a
  // full ring's end and the next ring's start, or a square corner arc's touch
  // gate boundary -- so the row is sampled on demand at that angle and cached.
  // The leftover at a layer is derived from the rings' own sampled tips: each
  // earlier layer's cut lowers the material over its cutter footprint (with the
  // ball's rise at the ring offset). The first layer has nothing removed in
  // front of it and keeps today's travel height.
  const linkRowAt = sampling.linkRowAt
  const clearance = convertLength(1, 'mm', tool.units)
  const pointIndexAt = (angleDeg: number): number => {
    const exact = angles.indexOf(angleDeg)
    if (exact >= 0) return exact
    for (let k = 0; k < angles.length; k++) {
      if (sameRotaryAngle(angles[k], angleDeg)) return k
    }
    return -1
  }
  const leftoverCache = new Map<string, number[]>()
  // #1117 fix 1 (P2): two operation budgets, not one. The at-layer candidate is
  // an **attempt**: it may be rejected after its walk, and the raised link that
  // replaces it has to be the link the operation would have emitted without the
  // attempt -- the handoff requires every link that does not qualify to stay
  // byte-identical. Sharing one counter with the raised link let a rejected
  // attempt consume the budget the fallback needed, so a later raised link ran
  // out of budget, `linkLeftoverAt` returned `[]`, and the boundary fell back
  // further, to the travel height. Each bucket also gets its own cache entries:
  // a shared entry would skip the raised link's own charge and change which
  // links get its budget, so the fallback would still drift from the baseline.
  //
  // #1117 fix 2 (P2): the raised charge must also happen when the candidate
  // **wins**. The caller therefore computes the raised plan first and overlays
  // the at-layer steps on top of it, so `raised` collects the same sequence of
  // charges and cache hits the baseline did over the whole operation. An
  // accepted candidate is an overlay, never a skipped charge.
  const linkWindowWork = { raised: 0, atLayer: 0 }
  // #1117 rl-e: the model rows the A-changing candidates have sampled, against
  // `MAX_LINK_ACROSS_ROWS`. Only an A-changing attempt draws on it, so an
  // equal-angle link keeps the row budget and the cache entries it had.
  let linkAcrossRows = 0
  const linkAcrossSampled = new Set<number>()
  /**
   * The widest angle off its axis at which the cutter body can meet any
   * material at all (#1093). A ball's sphere and shank stay inside the cylinder
   * of radius `r` about its axis, so the reach is `asin(r / (tip + r))`; a flat's
   * body is that same cylinder, so `atan(r / tip)` bounds the bottom face's
   * reach. The link height is sized from this window, not from the link's own
   * ray: on a square or box model the material at a neighbouring angle is
   * higher, and running the link through it is a gouge.
   */
  const bodyReachDeg = (tip: number): number => {
    if (tool.type === 'ball_endmill') {
      const centre = tip + tool.radius
      return centre > tool.radius ? Math.min(90, Math.asin(tool.radius / centre) * 180 / Math.PI) : 90
    }
    if (!(tip > 0)) return 90
    return Math.min(90, Math.atan(tool.radius / tip) * 180 / Math.PI)
  }
  /** The ring angle rows whose material the cutter body can reach at `reachDeg`. */
  const angleWindow = (k: number, reachDeg: number): number[] => {
    if (!(reachDeg > 0)) return [k]
    const target = angles[k]
    const windowRows: number[] = []
    for (let kk = 0; kk < angles.length; kk++) {
      let delta = ((angles[kk] - target) % 360 + 360) % 360
      if (delta > 180) delta = 360 - delta
      if (delta <= reachDeg + 1e-9) windowRows.push(kk)
    }
    if (!windowRows.includes(k)) windowRows.push(k)
    return windowRows
  }
  // #1117 (square links): the at-layer walk's per-row envelope, cached by angle
  // row and layer. A row's envelope -- the lowest contact any earlier layer
  // made over each along sample, starting from the blank at that angle -- does
  // not depend on which window asked for it, and a square blank's whole rings
  // and an A-changing link's widened reach ask for many overlapping windows. So
  // each row is walked once per layer and every window takes the maximum of the
  // envelopes it covers. Only rows walked for the first time are charged.
  const rowEnvelopes = new Map<string, number[]>()
  /**
   * The at-layer leftover without a region (#1117 rl-e): per row, the minimum
   * over its cutting positions of `cutTip + rise`, starting from `blankAt`;
   * over the window, the maximum of those rows. Same value the rl-e walk
   * computed; the work is charged per newly walked row against the at-layer
   * bucket, never the raised one. The result is keyed by the link row and the
   * window's row **count** -- for one link row the window only grows with the
   * reach, so the count names the row set, including a window that wraps the
   * 0/360 seam, where the first/last index pair does not.
   */
  const atLayerLeftover = (
    row: RotaryLinkRow,
    k: number,
    layer: number,
    windowed: boolean,
    windowRows: readonly number[],
  ): number[] => {
    const key = `${k}:${layer}:n${windowRows.length}:atLayerEnvelope`
    const cached = leftoverCache.get(key)
    if (cached) return cached
    const fresh = windowRows.filter((kk) => !rowEnvelopes.has(`${kk}:${layer}`))
    const work = row.along.length * along.length * fresh.length
    if (windowed) {
      // The per-call cap bounds what one link may walk; the operation budget
      // bounds the sum, and its refusal is cached so the link does not retry.
      if (work > MAX_LINK_WORK) return []
      if (linkWindowWork.atLayer + work > MAX_LINK_WINDOW_WORK) {
        leftoverCache.set(key, [])
        return []
      }
      linkWindowWork.atLayer += work
    }
    // #1117 rl-e: the at-layer test asks what an earlier layer actually
    // **left** standing, not how high it could have left it. The raised link
    // needs the opposite -- an upper bound, so it clears everything -- and
    // taking the maximum over the ring positions that reached x is exactly
    // that bound. It is the wrong question here: with a ball, the ring one
    // radius away contributes `cutTip + radius`, so the "leftover" never falls
    // below the bar radius, and on a bar much larger than the model every
    // candidate past the first layer is refused against the uncut blank
    // (measured on busto-round layer 2: leftover 1.000 in while the layer cut
    // the whole ring to 0.925 in, allowance 0.0966 in).
    //
    // A pass leaves the **lowest** of its own contact at x: material above a
    // lower pass is gone, and the ball's rise only matters where no nearer
    // pass cut deeper. So each angle row's own envelope is the minimum over
    // its cutting positions of `cutTip + rise`, starting from what stood
    // before the first layer (`blankAt` -- the uncut blank on a round bar, the
    // gate's touch radius on a square one, so a row no layer cuts keeps all of
    // it, exactly as the region walk below does). The cutter body's window
    // then takes the **highest** of those per-row envelopes: it reaches every
    // row, so it must clear the tallest thing any of them leaves.
    //
    // The raised bucket keeps the maximum-of-contacts computation below, byte
    // for byte, so every link it decides is unchanged. The two buckets already
    // have separate cache keys (#1117 fix 1).
    const radius = tool.radius
    const ball = tool.type === 'ball_endmill'
    for (const kk of fresh) {
      const blank = square ? squareRotaryTouchRadius(stock, angles[kk], tool.radius, tool.type) : maxRadius
      const surface = new Array<number>(row.along.length).fill(blank)
      const rowTips = tips[kk]
      for (let j = 1; j < layer; j++) {
        const layerRadius = Math.max(lowest, maxRadius - j * params.stepdown)
        const previousRadius = maxRadius - (j - 1) * params.stepdown
        if (square && !(layerRadius < blank)) continue
        for (let p = 0; p < along.length; p++) {
          // No cut at this layer at p: the material keeps whatever stood
          // before it, so this pass lowers nothing at x.
          if (!(rowTips[p] < previousRadius)) continue
          const cutTip = Math.max(rowTips[p], layerRadius)
          for (let i = 0; i < row.along.length; i++) {
            const dx = row.along[i] - along[p]
            if (Math.abs(dx) > radius) continue
            const rise = ball ? radius - Math.sqrt(Math.max(0, radius * radius - dx * dx)) : 0
            const contact = cutTip + rise
            if (contact < surface[i]) surface[i] = contact
          }
        }
      }
      rowEnvelopes.set(`${kk}:${layer}`, surface)
    }
    const remaining = new Array<number>(row.along.length).fill(Number.NEGATIVE_INFINITY)
    for (const kk of windowRows) {
      const surface = rowEnvelopes.get(`${kk}:${layer}`)
      if (!surface) return []
      for (let i = 0; i < row.along.length; i++) {
        if (surface[i] > remaining[i]) remaining[i] = surface[i]
      }
    }
    leftoverCache.set(key, remaining)
    return remaining
  }
  const linkLeftoverAt = (
    row: RotaryLinkRow,
    angleDeg: number,
    layer: number,
    reachDeg = 0,
    budget: 'raised' | 'atLayer' = 'raised',
  ): number[] => {
    const k = pointIndexAt(angleDeg)
    if (k < 0) return []
    // The base walk reads the link angle's own row and is already bounded by
    // `linkRowAt`'s `row.along x along` budget. Only the body window multiplies
    // that by the angle span, so only the window needs its own caps (#1093).
    const windowed = reachDeg > 0
    const windowRows = windowed ? angleWindow(k, reachDeg) : [k]
    if (budget === 'atLayer' && insideRegion === null) return atLayerLeftover(row, k, layer, windowed, windowRows)
    const work = row.along.length * along.length * windowRows.length
    if (windowed && work > MAX_LINK_WORK) return []
    // Two reaches that select the same angle rows leave the same material, so
    // the key is the row span rather than the per-link height. Without this a
    // long job recomputes the whole walk for every ring boundary. The budget
    // bucket is part of the key so an at-layer walk never stands in for the
    // raised link's own charge (#1117 fix 1).
    const key = `${
      windowed
        ? `${k}:${layer}:w${windowRows[0]}-${windowRows[windowRows.length - 1]}`
        : `${k}:${layer}`
    }:${budget}`
    const cached = leftoverCache.get(key)
    if (cached) return cached
    if (windowed) {
      // The per-call cap above cannot bound the operation: the link plan asks
      // at every ring boundary. Past the operation budget the rest of the links
      // retract, and the empty answer is cached so they do not retry the walk.
      if (linkWindowWork[budget] + work > MAX_LINK_WINDOW_WORK) {
        leftoverCache.set(key, [])
        return []
      }
      linkWindowWork[budget] += work
    }
    // The blank's own height over the body's window: a square blank's corner is
    // higher than its face, and an earlier layer that did not cut at a face
    // angle leaves that support standing.
    const blankAt = (kk: number): number => square
      ? squareRotaryTouchRadius(stock, angles[kk], tool.radius, tool.type)
      : maxRadius
    let support = maxRadius
    if (square) {
      support = Number.NEGATIVE_INFINITY
      for (const kk of windowRows) support = Math.max(support, blankAt(kk))
    }
    if (insideRegion !== null) {
      // #1096 review (P1): outside the operation's region no layer removes
      // anything, so the link must clear the **uncut blank** there, not the
      // model height the earlier layers would have reached on a full-bar job.
      // A link between two region bands crosses the gap between them; sizing it
      // from the model sent it through stock no pass had touched.
      //
      // Per window angle, the remaining top at each along position is the
      // blank where the mask never cut and the shallowest cut where it did;
      // the body must clear the highest of those tops over the whole window.
      // This also covers a narrow angular region: the link's own ray can be
      // inside the mask while the cutter body reaches material outside it,
      // which must still stand at the blank's height.
      const remaining = new Array<number>(row.along.length).fill(Number.NEGATIVE_INFINITY)
      const radius = tool.radius
      const ball = tool.type === 'ball_endmill'
      for (const kk of windowRows) {
        const angle = angles[kk]
        const surface = new Array<number>(row.along.length).fill(blankAt(kk))
        const rowTips = tips[kk]
        for (let j = 1; j < layer; j++) {
          const layerRadius = Math.max(lowest, maxRadius - j * params.stepdown)
          const previousRadius = maxRadius - (j - 1) * params.stepdown
          if (square && !(layerRadius < blankAt(kk))) continue
          for (let p = 0; p < along.length; p++) {
            // No cut at this layer, or no cut permitted here by the mask: the
            // material at this angle keeps whatever stood before it.
            if (!(rowTips[p] < previousRadius)) continue
            if (!insideRegion(along[p], angle)) continue
            const cutTip = Math.max(rowTips[p], layerRadius)
            for (let i = 0; i < row.along.length; i++) {
              const dx = row.along[i] - along[p]
              if (Math.abs(dx) > radius) continue
              const rise = ball ? radius - Math.sqrt(Math.max(0, radius * radius - dx * dx)) : 0
              const contact = cutTip + rise
              if (contact < surface[i]) surface[i] = contact
            }
          }
        }
        for (let i = 0; i < row.along.length; i++) {
          if (surface[i] > remaining[i]) remaining[i] = surface[i]
        }
      }
      leftoverCache.set(key, remaining)
      return remaining
    }
    const leftover = new Array<number>(row.along.length).fill(support)
    const radius = tool.radius
    const ball = tool.type === 'ball_endmill'
    for (let j = 1; j < layer; j++) {
      const layerRadius = Math.max(lowest, maxRadius - j * params.stepdown)
      const previousRadius = maxRadius - (j - 1) * params.stepdown
      const cuts: number[] = []
      for (const kk of windowRows) {
        if (square && !(layerRadius < squareRotaryTouchRadius(stock, angles[kk], tool.radius, tool.type))) continue
        cuts.push(kk)
      }
      if (cuts.length === 0) continue
      for (let i = 0; i < row.along.length; i++) {
        const x = row.along[i]
        // The material this layer leaves at x is the *shallowest* contact any of
        // its rings makes over x -- an upper bound on what remains standing, so
        // the next link clears it. The ball's rise at the ring offset keeps a
        // between-rings ridge from being missed. The window is the rows whose
        // material the cutter body can reach at the link height, so the link
        // clears the body too, not only its own ray.
        let contact = Number.NEGATIVE_INFINITY
        for (const kk of cuts) {
          const rowTips = tips[kk]
          for (let p = 0; p < along.length; p++) {
            const dx = x - along[p]
            if (Math.abs(dx) > radius) continue
            if (!(rowTips[p] < previousRadius)) continue
            const cutTip = Math.max(rowTips[p], layerRadius)
            const rise = ball ? radius - Math.sqrt(Math.max(0, radius * radius - dx * dx)) : 0
            if (cutTip + rise > contact) contact = cutTip + rise
          }
        }
        if (contact > Number.NEGATIVE_INFINITY && contact < leftover[i]) leftover[i] = contact
      }
    }
    leftoverCache.set(key, leftover)
    return leftover
  }
  /**
   * Whether grid angle `k` is a square blank's touch-gate boundary at this layer
   * (#1117 slice B): the sample one step outward -- in the previous ring's
   * traversal direction -- is one the gate does not cut. The 0/360 grid sample
   * is duplicated, so the physical neighbour of either end is one step inside
   * the seam. The caller has checked `angles.length >= 2`.
   */
  const gateBoundary = (k: number, layerRadius: number, outward: number): boolean => {
    const last = angles.length - 1
    const neighbour = outward < 0 ? (k === 0 ? last - 1 : k - 1) : (k === last ? 1 : k + 1)
    return !(layerRadius < squareRotaryTouchRadius(stock, angles[neighbour], tool.radius, tool.type))
  }
  /**
   * #1117 rl-e: the at-layer link **across an A change**, for two partial rings
   * of one layer whose run ends do not share an angle.
   *
   * On a model that is not a solid of revolution a ring cuts only the arc where
   * the material stands below the previous layer's radius, so its run ends where
   * that boundary crosses this layer. The boundary moves along the bar, and the
   * next ring -- traversed the other way -- starts where its own arc ends. Both
   * ends are therefore genuine cut points of this layer, but a few degrees apart
   * (measured on busto-round: median 1.98 deg, p90 5.09, max 12.03), and the
   * equal-angle rule refused every one of them: the link retracted although the
   * two rings it joins are the same stay-down transition.
   *
   * The path is the one straight commanded move from `from` to `to`, so it
   * changes along **and** A together, and its samples are cut at
   * `max(model, layerRadius)` exactly as the equal-angle link's are. It is
   * accepted only when the **whole swept path** passes the same rules:
   *
   * - **One band of material, over the whole body.** `linkLeftoverAt` is asked
   *   with the body's reach **widened by the drift**, so one window covers every
   *   angle the path visits; a row the drift uncovers can only make the check
   *   stricter, never looser. The material left over the path may exceed the cut
   *   height by at most this layer's stepdown plus the between-ring scallop and
   *   one sampling cell -- what the layer removes at its own rings. A sector the
   *   earlier layers never reached stands at the blank and is refused, which is
   *   the "model stands above the layer" case: those boundaries keep the raised
   *   link.
   * - **The model is protected.** Each waypoint cuts at or above the model at its
   *   own angle, read from the two grid rows that bracket that angle (the same
   *   rows the emitted rings are cut on; the sampler's own refinement holds the
   *   surface within the chord tolerance between them, so the higher of the two
   *   is at or above the surface on the way). A `NaN` row sample -- no model under
   *   the tool there -- refuses the link: that is a model gap, and the equal-angle
   *   rule refuses it too.
   * - **The region.** The path is a slope in `(along, A)`, not one angle's
   *   segment, so every dense path sample must be inside the mask (the rule
   *   `followLink` uses where the mask has no boundary test). A mask that can
   *   prove a whole segment (`containsSegment`) decides the **entire path**: the
   *   slope in `(along, A)` is one straight segment on the sheet, because across
   *   is affine in A, so `rotaryRegionSlopeContains` sees an excluded strip
   *   narrower than the sample spacing that the waypoint checks step over.
   * - **A square blank**: a link whose ends are both corner-arc boundaries of
   *   the touch gate keeps the allowance above. With a region that is required;
   *   without one, any other link (rings the model splits below the corner
   *   layers) is proved under `linkAtLayer`'s stricter rule instead -- one
   *   stepdown and nothing more, and rings no further apart than the cutter
   *   (#1117 square links).
   *
   * A0 and A360 are one physical rotation, so a link between them is a commanded
   * full turn rather than a partial ring's drift; it keeps the raised link. A
   * round bar's drift wider than `MAX_LINK_ACROSS_DEG` does too -- nothing here
   * proves that swept surface -- while a **square** blank's wide model gap goes
   * through the row proof and is bounded by the row budgets instead. A path that
   * needs more rows than the per-link or per-operation budget, and a span the
   * dense row cannot cover with an interior sample, keep the raised link. Every
   * refusal is the pre-slice motion.
   */
  const linkAcrossAngle = (
    layer: number,
    layerRadius: number,
    fromAlong: number,
    from: ToolpathPoint,
    to: ToolpathPoint,
    outward: number,
  ): readonly RotaryLinkStep[] | null => {
    if (from.a === undefined || to.a === undefined) return null
    const fromA = from.a
    const toA = to.a
    const delta = toA - fromA
    if (sameRotaryAngle(fromA, toA) || !(Math.abs(delta) > 1e-9)) return null
    if (alongCoordinate(stock, from) !== fromAlong) return null
    const toAlong = alongCoordinate(stock, to)
    if (!(toAlong > fromAlong)) return null
    const fromK = pointIndexAt(fromA)
    const toK = pointIndexAt(toA)
    if (fromK < 0 || toK < 0 || angles.length < 2) return null
    // #1103 slice ca-d: a **square** blank's forward-only transition is the seam
    // gap between the ring's last corner arc and the next ring's first one. That
    // gap can be wider than `MAX_LINK_ACROSS_DEG`, but it is not the drift this
    // bound was written for: on the blank the whole sector is **air at this
    // layer**, because the touch gate does not cut a single angle row between
    // the two ends. The turn then needs no model row at all -- the blank, and
    // the model inside it, stand below the layer radius across the sector -- so
    // it is one straight cut at or above the layer and it keeps the ring-to-ring
    // link this slice would otherwise lose. Every other wide A change (a round
    // bar's protrusion, a square sector an earlier layer left standing, a
    // region's excluded span) keeps its retract.
    const wide = Math.abs(delta) > MAX_LINK_ACROSS_DEG
    // #1103 ca-d correction (review P1): sample the rows the **commanded** sweep
    // crosses -- the long way round the physical indices sampled rows hundreds
    // of degrees from the pose and charged the whole circumference against the
    // per-link row budget. See `rotaryLinkRowSweep`.
    const sweep = rotaryLinkRowSweep(angles, fromK, toK, fromA, delta)
    if (sweep === null) return null
    const rows = sweep.rows
    const stepK = delta > 0 ? 1 : -1
    // The gate's air sector does not care how wide the gap is: a narrow one has
    // every row it crosses below the layer too. Try it first for a square blank,
    // then fall through to the drift proof (or the retract) when a row cuts.
    // The sector is exactly the rows the sweep crosses, so only those are read;
    // reading the rest of the circumference refused a short forward step
    // whenever a corner stood anywhere else on the blank (#1103 ca-d fix 1).
    if (square) {
      let air = true
      for (let i = 1; i + 1 < rows.length && air; i++) {
        if (layerRadius < squareRotaryTouchRadius(stock, angles[rows[i]], tool.radius, tool.type)) air = false
      }
      // The air proof is about riding the **layer's** radius through the gap, so
      // both ends have to be at or below the layer: a pose the model lifted
      // above it is not that proof, and falls through to the row proof below.
      if (air && (from.z - pivot > layerRadius + 1e-6 || to.z - pivot > layerRadius + 1e-6)) air = false
      if (air) {
        if (region !== null && insideRegion !== null) {
          if (!insideRegion(fromAlong, fromA) || !insideRegion(toAlong, toA)) return null
          // A mask without a boundary test cannot prove a swept sector, so it
          // keeps the retract; the point check would step over an excluded strip.
          if (rotaryRegionSlopeContains(region, stock, fromAlong, fromA, toAlong, toA) !== true) return null
        }
        // Both ends are this layer's own cut points, so each is at or above the
        // layer radius; the straight move between them never dips below it and
        // every angle it sweeps is air. One move, no sampled row.
        return [{ to, kind: 'cut' }]
      }
    }
    if (wide && !square) {
      // A round bar's wide A change is a lobe boundary jumping most of the bar;
      // nothing in this slice proves that swept surface, so it keeps the raised
      // link. A **square** blank's wide change is a model gap between two rings
      // of one layer (the ring's cut span is the complement): the at-layer proof
      // below samples every row the sweep crosses, and the row budget -- not the
      // 45 degree drift bound -- is what decides whether it can be proven
      // (#1103 ca-d fix 1, review P2: the bound refused 44 links busto-rect had
      // at ca-a, 15 678 rows in total).
      return null
    }
    // The sweep's rows, each angle unwrapped into the frame the path commands in
    // (#1103 ca-d fix 1), so a pose at commanded A364 is bracketed by the rows
    // at 362 and 364 and never by the A344/346 rows the physical wrap visited.
    const rowAngles = sweep.angles
    if (rows.length < 2 || rows.length > MAX_LINK_ACROSS_ROWS_PER_LINK) return null
    // #1117 (square links): a row another A-changing candidate already sampled
    // costs nothing; only the rows this path samples first are charged.
    const freshRows = rows.filter((k) => !linkAcrossSampled.has(k))
    if (linkAcrossRows + freshRows.length > MAX_LINK_ACROSS_ROWS) return null
    // #1096/#1117: a mask without a boundary test falls back to per-sample point
    // membership; the dense path samples below are that check, and the two ends
    // are part of it.
    if (region !== null && insideRegion !== null) {
      if (!insideRegion(fromAlong, fromA) || !insideRegion(toAlong, toA)) return null
      // #1117 rl-e correction (review finding 1): the whole swept path is one
      // segment on the sheet. Checking only the emitted waypoints let a link cut
      // across an excluded slit that fell between two samples; the mask's own
      // boundary test decides the path, exactly as it does for the equal-angle
      // link. `null` (a point-only mask) keeps the per-waypoint check below.
      if (rotaryRegionSlopeContains(region, stock, fromAlong, fromA, toAlong, toA) === false) return null
    }
    // A square blank's corner-arc link joins two touch-gate boundaries, so
    // each end is one: `outward` is the previous ring's traversal direction,
    // which is also the step from an arc's start back out of it. With a region
    // that is still required; without one, a link whose ends are not both gate
    // boundaries is proved under the one-stepdown bound instead (#1117 square
    // links, see `linkAtLayer`).
    let oneStepdown = false
    if (square) {
      if (angles.length < 2) return null
      if (!gateBoundary(fromK, layerRadius, outward) || !gateBoundary(toK, layerRadius, outward)) {
        if (region !== null) return null
        // Rings further apart than the cutter leave a strip no ring touches;
        // see `linkAtLayer`.
        if (toAlong - fromAlong > 2 * tool.radius) return null
        oneStepdown = true
      }
    }
    const row = linkRowAt(fromA, 'atLayer')
    if (!row) return null
    // The body reaches `bodyReachDeg` either side at the link's lowest height;
    // widening that by the drift makes one window cover every angle the path
    // visits. Charged to the at-layer bucket, never the raised one (#1117 fix 1).
    const reach = bodyReachDeg(layerRadius) + Math.abs(delta)
    const leftover = linkLeftoverAt(row, fromA, layer, reach, 'atLayer')
    if (leftover.length === 0) return null
    // #1117 rl-e (rl-c's footprint rule, applied to the link's **height**): the
    // link may not ride at the model its own ray finds while the body reaches
    // higher material a few degrees away. A ball's surface at an angular offset
    // is at or above its tip, so keeping the whole window's height at or above
    // the tallest material in it is safe without any rise discount. Read from the
    // ring grid, which is the same conservative cell bound the rings cut at.
    const windowRows: number[] = []
    {
      const k = pointIndexAt(fromA)
      if (k < 0) return null
      const span = bodyReachDeg(layerRadius) + Math.abs(delta)
      for (let kk = 0; kk < angles.length; kk++) {
        let offset = ((angles[kk] - angles[k]) % 360 + 360) % 360
        if (offset > 180) offset = 360 - offset
        if (offset <= span + 1e-9) windowRows.push(kk)
      }
      if (!windowRows.includes(k)) windowRows.push(k)
    }
    let alongIndex = 0
    // One model row per grid angle the path crosses. `linkRowAt` builds every row
    // on the same along grid, so one index is one along position in all of them.
    const rowsData: RotaryLinkRow[] = []
    for (const k of rows) {
      const angleRow = linkRowAt(angles[k], 'atLayer')
      if (!angleRow) return null
      rowsData.push(angleRow)
    }
    for (const k of freshRows) linkAcrossSampled.add(k)
    linkAcrossRows += freshRows.length
    const scallop = tool.type === 'ball_endmill'
      ? tool.radius - Math.sqrt(Math.max(0, tool.radius * tool.radius - Math.min((toAlong - fromAlong) / 2, tool.radius) ** 2))
      : 0
    const allowance = oneStepdown ? params.stepdown : params.stepdown + scallop + params.requestedCellSize
    const steps: RotaryLinkStep[] = []
    // The path's angle is monotone in `x`, so a moving cursor finds the two rows
    // that bracket it without rescanning.
    let cursor = 0
    let interior = 0
    for (let i = 0; i < row.along.length; i++) {
      const x = row.along[i]
      if (x < fromAlong - 1e-12 || x > toAlong + 1e-12) continue
      const angle = fromA + delta * (x - fromAlong) / (toAlong - fromAlong)
      while (cursor + 1 < rows.length
        && (stepK > 0 ? rowAngles[cursor + 1] < angle : rowAngles[cursor + 1] > angle)) cursor++
      const here = rowsData[cursor]
      const next = rowsData[Math.min(cursor + 1, rowsData.length - 1)]
      const tipHere = here.tips[i]
      const tipNext = next.tips[i]
      // No model under the tool at either bracketing row: a gap in the reachable
      // surface is not crossed at the layer.
      if (!Number.isFinite(tipHere) || !Number.isFinite(tipNext)) return null
      // The tallest material the body can reach at this along position: the grid
      // rows' own tips, which is what the height has to clear.
      while (alongIndex + 1 < along.length && Math.abs(along[alongIndex + 1] - x) < Math.abs(along[alongIndex] - x)) alongIndex++
      let reachHeight = layerRadius
      // #1117 rl-f: redundant with `safeToolTipZAt` for sampled poses -- `linkRowAt`
      // already carries the footprint-convolved safe tip -- and kept as defence in
      // depth between samples, which is not proven either way.
      for (const kk of windowRows) {
        const gridTip = tips[kk][alongIndex]
        if (Number.isFinite(gridTip) && gridTip > reachHeight) reachHeight = gridTip
      }
      const height = Math.max(tipHere, tipNext, reachHeight)
      if (leftover[i] - height > allowance + 1e-9) return null
      if (region !== null && insideRegion !== null && !insideRegion(x, angle)) return null
      if (x <= fromAlong + 1e-12 || x >= toAlong - 1e-12) continue
      steps.push({ to: point(x, height, angle), kind: 'cut' })
      interior++
    }
    // The same span-coverage rule the equal-angle link applies: a transition
    // longer than the row's sample interval must be bridged by an interior
    // sample, or the straight cut runs through material nothing examined.
    const sampleInterval = row.along.length > 1
      ? row.along[1] - row.along[0]
      : Number.POSITIVE_INFINITY
    if (interior === 0 && toAlong - fromAlong > sampleInterval + 1e-9) return null
    steps.push({ to, kind: 'cut' })
    return steps
  }
  /**
   * #1117: the at-layer cutting link, tried before the raised one.
   *
   * The finish already follows the model between rings (#1093); a rough rose
   * above whatever its own earlier layers left and rapid across, because the
   * link may have to remove a layer's band. It does not have to: the standing
   * stock at any along position before this layer is `max(model,
   * previousRadius)`, so a cut at `max(currentLayerRadius, rowTip)` removes
   * exactly the band this layer removes at its own rings -- full lateral
   * engagement, no deeper cut, no new feed (decision 1 of the approved plan).
   * The `max` with `layerRadius` is the layer clamp: where the model is lower
   * than this layer the link stays at the layer instead of diving to the model,
   * and where the model rises above it the link follows the model, so the rise
   * is protected rather than cut through.
   *
   * The row is the same dense, cutter-safe `linkRowAt` row the raised link and
   * the finish use, so it carries the stock allowance, the steep-step rule the
   * emitter applies to its legs, and the retained-stub floors. It is never
   * derived by removing clearance from the raised candidate: the raised height
   * is about earlier layers, and this candidate is about the current one.
   *
   * **What the cutter may meet** is proved from the same leftover walk the
   * raised link uses: the material the earlier layers can have left over this
   * span (`linkLeftoverAt`, already the ring grid's own tips, the cutter's along
   * footprint and the ball's rise). At every sample it may exceed the link's
   * height by at most **one layer's band** -- a stepdown -- plus the scallop the
   * tool leaves between the two adjoining rings (the ball's rise at half this
   * transition's own span) and one sampling cell. More than that means the
   * earlier layers did not cut there at all -- a plateau above the layer -- and a
   * stay-down link would plunge through it at depth, which is exactly the
   * engagement spike the plan forbids. The first layer's leftover is the blank,
   * so its links remove one band by construction.
   *
   * Everything that makes a stay-down cut unsafe or unprovable keeps the raised
   * link: a `NaN` row sample (no model under the tool there, so the ring at that
   * along position removes nothing and the link would cut uncut blank), a
   * transition that the row cannot actually sample (see the inclusive scan and
   * its span-coverage rule below), more than one band of material to remove, a
   * region span outside the mask, a square transition with a region that is
   * not two corner arcs meeting at the touch gate's boundary, a changed angle (A0 to A360 is a
   * commanded turn, not equal), a row the work budget refused, and a transition
   * between rings that are not adjacent. The caller passes the previous ring's
   * own along coordinate, so a ring that emitted nothing -- a skipped ring --
   * leaves `current` at an earlier along position and cannot link across the
   * gap; a partial ring whose last run is the adjoining one is fine, exactly as
   * the raised link already links partial runs at their shared angle.
   *
   * **Square blanks** (#1117 slice B) cut short arcs around the corners, so
   * every ring is split and the only link that can stay down joins two of those
   * arcs at their **shared boundary angle**. The gate is angle-only, so the
   * neighbouring ring's first cut is exactly the previous ring's last cut: a
   * ring traverses its arcs in order, and the angle it ends on is where
   * `squareRotaryTouchRadius` falls to the layer radius. The check below asks
   * that the sample just outside that run is one the gate no longer cuts, which
   * is what makes the shared angle a *corner-arc* boundary rather than the
   * ring's own end.
   *
   * The link then cuts at the same height the two rings already cut at there,
   * `max(model, layerRadius)`, and the blank's corner envelope above it is at
   * most the one band this layer removes -- the leftover check below is what
   * proves it. Once a layer's radius is at or below the blank's inscribed
   * radius the gate no longer splits the ring: it is one whole turn at A0/A360,
   * and a link there is not between corner arcs; below the corner layers the
   * model splits rings too, at run ends that are not gate boundaries. Without a
   * region those links are no longer refused (#1117 square links): they are
   * proved under the stricter rule spelled out at the check below. (The
   * stage-descent failure this paragraph used to cite was the descent checker
   * judging a straight along move at its two ends only; it now samples the move
   * like an along pass, and the footprint proof is unchanged.)
   *
   * **Regions** (#1096, #1117 slice B) are a mask on the tool position, so the
   * link is a cut from one along position to another at one angle and its
   * **whole span** must be inside the region -- the same rule the finish's
   * `followLink` applies, including a narrow excluded strip that falls between
   * two samples. A gap between two region bands is therefore never cut across;
   * it keeps the raised link, whose height comes from `linkLeftoverAt`'s region
   * walk and so clears the **uncut blank** that stands there. The same walk
   * treats every angular cell outside the mask as blank, so the cutter body
   * reaching material outside the region is part of the one-band check: past
   * the first layer that material is above the link by more than one band, and
   * the link is refused.
   */
  const linkAtLayer = (layer: number, layerRadius: number, fromAlong: number, from: ToolpathPoint, to: ToolpathPoint, outward: number): readonly RotaryLinkStep[] | null => {
    if (from.a === undefined || to.a === undefined) return null
    // #1117 rl-e: the boundary between a partial ring's end and the next ring's
    // start is not two equal angles. That case is proved on the swept path, as a
    // slope in (along, A), and falls back to the raised link exactly as every
    // refusal here does; the equal-angle rule below is unchanged.
    if (from.a !== to.a) return linkAcrossAngle(layer, layerRadius, fromAlong, from, to, outward)
    if (alongCoordinate(stock, from) !== fromAlong) return null
    const toAlong = alongCoordinate(stock, to)
    if (!(toAlong > fromAlong)) return null
    // #1096: the link is one straight cut at one angle, so the region decides
    // on the segment, not on the dense row's samples. `null` from the mask means
    // it has no boundary test, and then the row samples get the point test.
    let pointOnlyRegion = false
    if (region !== null && insideRegion !== null) {
      if (!insideRegion(fromAlong, from.a) || !insideRegion(toAlong, from.a)) return null
      const segment = rotaryRegionSegmentContains(region, stock, fromAlong, toAlong, from.a)
      if (segment === false) return null
      pointOnlyRegion = segment === null
    }
    // A square blank's corner-arc link joins two arcs at the touch gate's own
    // boundary: the sample just outside this ring's last run is one the gate no
    // longer cuts. `outward` is the previous ring's traversal direction in the
    // angle grid, so this is the sample that ring would have cut next.
    //
    // #1117 (square links): that rule used to be a prerequisite, and it refused
    // every **complete** ring (its end's neighbour is cut by the gate) and every
    // ring the model splits below the corner layers -- busto-rect retracted at
    // all 308 ring boundaries of its layers 6-17. With a region it still is: the
    // caller blocks a region's split rings, and its whole rings were never
    // proved here. Without a region such a link is proved under a **stricter**
    // material bound instead of being refused. At a gate boundary the material
    // the link meets is the blank right at the layer radius; between two whole
    // rings it is what their cuts left, including the scallop a ball leaves
    // between them -- material the rings themselves never take. So the link may
    // take one stepdown from what the earlier layers left and nothing more: no
    // scallop and no cell allowance (the independent proof in
    // `squareAroundGenerator.property.test.ts` refused the looser bound on a
    // ball with full-diameter ring spacing: 4.03 mm removed at stepdown 3). A
    // face an earlier layer passed over in air stands at the blank in the walk
    // below and is refused by the same bound.
    //
    // The walk only knows what **rings** cut, read at the dense row's samples.
    // That is the material only where every point of the span is within a
    // cutter radius of a ring: rings further apart than the cutter's diameter
    // leave a strip between them that no ring touches, narrow enough to fall
    // between two row samples, and what stands there is whatever an earlier
    // layer's **link** left -- or the blank. So such a link keeps the raised
    // form (the seeded square property in `rotarySquareAroundPasses.test.ts`
    // caught a ball link 1.56 mm deep through that strip at stepdown 0.70, with
    // rings 0.694 mm apart and a 0.633 mm ball).
    let oneStepdown = false
    if (square) {
      const k = pointIndexAt(from.a)
      if (k < 0 || angles.length < 2) return null
      if (!gateBoundary(k, layerRadius, outward)) {
        if (region !== null) return null
        if (toAlong - fromAlong > 2 * tool.radius) return null
        oneStepdown = true
      }
    }
    const row = linkRowAt(from.a, 'atLayer')
    if (!row) return null
    // The material the earlier layers left, over **the whole cutter body** at
    // this height, not only the link's own ray: the body reaches material a few
    // degrees either side, and on a model that is not a solid of revolution the
    // neighbouring angle can stand higher than the ray does. The reach shrinks
    // as the height rises, and the link's lowest height is the layer radius, so
    // that height's window is the widest one this link can need.
    const reach = bodyReachDeg(layerRadius)
    // #1117 fix 1 (P2): this walk is charged to the at-layer bucket, never to
    // the raised link's. This candidate can still be rejected below, and the
    // raised link that takes over must keep the budget and the cache entries
    // the baseline gave it. #1117 fix 2 (P2): that is true when the candidate
    // **wins** too -- the caller has already computed the raised plan, so an
    // accepted candidate only overrides the emitted steps and cannot unspend a
    // baseline charge.
    const leftover = linkLeftoverAt(row, from.a, layer, reach, 'atLayer')
    if (leftover.length === 0) return null
    // The scallop the tool leaves between two rings: a ball cuts lowest at its
    // own along position and rises by `r - sqrt(r^2 - dx^2)` at either side, so
    // the material between the two adjoining rings stands up to this much above
    // the layer's previous radius. A flat leaves none.
    const halfSpan = (toAlong - fromAlong) / 2
    const scallop = tool.type === 'ball_endmill'
      ? tool.radius - Math.sqrt(Math.max(0, tool.radius * tool.radius - Math.min(halfSpan, tool.radius) ** 2))
      : 0
    const allowance = oneStepdown ? params.stepdown : params.stepdown + scallop + params.requestedCellSize
    // #1117 (square links): a link the gate-boundary rule did not admit is
    // judged on the material it actually meets, and that includes the ring it
    // starts from. That ring is this layer's, it is fully emitted before the
    // link runs, and the walk above only counts **earlier** layers -- so between
    // two close rings it reads the previous layer's ridge where this layer's
    // ring has already cut a stepdown off it. The ring's own contact at x is its
    // cut height plus the ball's rise at the offset, at every window row; the
    // window takes the highest, and a row the ring did not cut (or an offset
    // past the cutter radius) leaves it unbounded. Taking the lower of that and
    // the walk is at or above the true per-row minimum, so it never under-reads.
    const ringIndex = oneStepdown ? along.indexOf(fromAlong) : -1
    let ringTop = Number.POSITIVE_INFINITY
    if (ringIndex >= 0) {
      const previousRadius = maxRadius - (layer - 1) * params.stepdown
      ringTop = Number.NEGATIVE_INFINITY
      for (const kk of angleWindow(pointIndexAt(from.a), reach)) {
        const tip = tips[kk][ringIndex]
        const cut = tip < previousRadius && layerRadius < squareRotaryTouchRadius(stock, angles[kk], tool.radius, tool.type)
        if (!cut) {
          ringTop = Number.POSITIVE_INFINITY
          break
        }
        ringTop = Math.max(ringTop, Math.max(tip, layerRadius))
      }
    }
    const ringLevel = (x: number): number => {
      const dx = Math.abs(x - fromAlong)
      if (!Number.isFinite(ringTop) || dx > tool.radius) return Number.POSITIVE_INFINITY
      const rise = tool.type === 'ball_endmill' ? tool.radius - Math.sqrt(Math.max(0, tool.radius * tool.radius - dx * dx)) : 0
      return ringTop + rise
    }
    const steps: RotaryLinkStep[] = []
    // #1117 review (P1): sample the transition **inclusively**. The dense row
    // and the ring grid can be the same points -- at a stepover of the tool
    // radius or less the row is spaced by the stepover and starts where the
    // rings start -- and the old strict inequalities skipped every one of
    // them. The candidate then degenerated to one straight cut with no leftover
    // sample examined at all, so a model gap was crossed as if it were already
    // cleared. A boundary sample is validated but not emitted: it is where the
    // two ring cuts already are.
    let interior = 0
    for (let i = 0; i < row.along.length; i++) {
      const x = row.along[i]
      if (x < fromAlong - 1e-12 || x > toAlong + 1e-12) continue
      // A mask with no boundary test keeps the finish's old per-sample rule.
      if (pointOnlyRegion && insideRegion !== null && !insideRegion(x, from.a)) return null
      const tip = row.tips[i]
      if (!Number.isFinite(tip)) return null
      const height = Math.max(tip, layerRadius)
      const material = oneStepdown ? Math.min(leftover[i], ringLevel(x)) : leftover[i]
      if (material - height > allowance + 1e-9) return null
      if (x <= fromAlong + 1e-12 || x >= toAlong - 1e-12) continue
      steps.push({ to: point(x, height, from.a), kind: 'cut' })
      interior++
    }
    // Sufficient span coverage: the row's own sample interval is the widest
    // stretch the surface can be read across. A transition longer than that
    // must be bridged by an interior sample; if it has none -- because the row
    // was filtered, not because the span is short -- the straight cut would run
    // through unexamined material, so the candidate is refused and the caller
    // keeps the raised link.
    const sampleInterval = row.along.length > 1
      ? row.along[1] - row.along[0]
      : Number.POSITIVE_INFINITY
    if (interior === 0 && toAlong - fromAlong > sampleInterval + 1e-9) return null
    steps.push({ to, kind: 'cut' })
    return steps
  }
  /** The raised link (#1093): rise to the earlier layers' leftover, rapid across, drop. */
  const raisedLinkPlan = (layer: number) => (from: ToolpathPoint, to: ToolpathPoint): readonly RotaryLinkStep[] | null => {
    if (from.a === undefined || to.a === undefined || from.a !== to.a) return null
    const fromAlong = alongCoordinate(stock, from)
    const toAlong = alongCoordinate(stock, to)
    if (!(toAlong > fromAlong)) return null
    const row = linkRowAt(from.a)
    if (!row) return null
    let required = maxRadius
    if (layer > 1) {
      const leftover = linkLeftoverAt(row, from.a, layer)
      if (leftover.length === 0) return null
      required = Number.NEGATIVE_INFINITY
      for (let i = 0; i < row.along.length; i++) {
        const x = row.along[i]
        if (x < fromAlong - 1e-12 || x > toAlong + 1e-12) continue
        if (leftover[i] > required) required = leftover[i]
      }
      // The ring's own ray is not enough on a **square blank**: its raised
      // envelope at a neighbouring angle is not in the model's sampler tips, so
      // an earlier layer that did not cut at the face leaves that support
      // standing where the cutter body can still meet it. Size the link from
      // the widest window the body can meet at this height. The reach shrinks
      // as the height rises, so the window found at the ray's height is the
      // widest one the final height can need. A round bar does not need it: its
      // cross-section is the same at every angle, so the sampler's own
      // two-dimensional tip already clears the lateral reach (#1093 review).
      if (square && Number.isFinite(required) && required > 0) {
        const reach = bodyReachDeg(required)
        if (reach > 0) {
          const bodyLeftover = linkLeftoverAt(row, from.a, layer, reach)
          if (bodyLeftover.length === 0) return null
          for (let i = 0; i < row.along.length; i++) {
            const x = row.along[i]
            if (x < fromAlong - 1e-12 || x > toAlong + 1e-12) continue
            if (bodyLeftover[i] > required) required = bodyLeftover[i]
          }
        }
      }
      required = Math.max(required, from.z - pivot, to.z - pivot)
    }
    const highZ = pivot + required + clearance
    // The middle leg runs at one height and one angle, above everything this
    // operation's earlier layers can leave on the span by `clearance`, and at
    // or above both cuts: `required` is the maximum of the leftover material and
    // the two end tips (the first layer takes the blank's largest radius). It is
    // therefore always in air, so it is a rapid. The rise to it and the drop to
    // the next ring stay feeds.
    const steps: RotaryLinkStep[] = []
    if (highZ > from.z) steps.push({ to: { ...from, z: highZ }, kind: 'cut' })
    steps.push({ to: { ...to, z: Math.max(highZ, to.z) }, kind: 'rapid' })
    if (Math.max(highZ, to.z) > to.z) steps.push({ to, kind: 'cut' })
    return steps
  }
  if (params.passDirection === 'around') {
    // A ring is one along position (#1045 slice A), so the layer loop keeps its
    // layers and the rings run along inside each one.
    //
    // #1103 slice ca-d: A never reverses in the rough either. Every ring turns
    // the same way, and the next ring continues from the angle the last one
    // reached -- the A cursor grows one full turn per along position and is
    // never wrapped modulo 360 (the A range is the controller's job, #1091).
    // Where a ring is a **whole** ring of material and its neighbours are too,
    // the band is cut by one **continuous helix** (`buildContinuousHelix`), one
    // per layer and clamped to that layer's depth: `ContinuousHelixLayer` gives
    // the builder the layer radius (a pose never cuts below it) and the previous
    // layer's radius (a pose with no material standing above it refuses the
    // band, so the ring path keeps its air skip). On a round bar that is the
    // same uninterrupted ring the finish helices; a layer change still retracts,
    // and the next layer resumes at the forward-equivalent angle the cursor is
    // at, so nothing rewinds. A **square blank** is helixed too since #1103
    // slice ca-j, once a layer has become round: the band is a whole ring at
    // every angle under the blank's touch gate (`ContinuousHelixLayer.material`
    // re-checks it at each helix pose), and every pose takes the retained-stub
    // contact floor the ring sample takes. A layer whose corners are still
    // standing has no whole ring, so it keeps forward-only corner arcs with the
    // gate's safe gaps exactly as before.
    //
    // Each sample keeps its own angle row's height at the ring's own along
    // index, and the same `needsCut`/layer rule as an along pass: material still
    // standing at this layer is cut, a sample already at the layer radius is
    // not.
    //
    // A **square** blank's standing material is not the same at every angle
    // (#1045 slice C): the corners reach `barMaxRadius` while a flat is only
    // half the side. The along pass asks `squareRotaryTouchRadius` at its own
    // pass angle; the ring asks it per sample at **that sample's** angle, so a
    // layer above the material standing there is air and emits nothing. The
    // gate is computed once per layer -- it depends on the layer radius and the
    // angle, never on the along position -- and is `null` on a round bar.
    const last = angles.length - 1
    // The A cursor: the commanded angle every point of the next unit is built
    // from. It is never reduced modulo 360. A whole ring advances it one turn
    // (its A360 is the next ring's A0); a partial ring or a helix advances it
    // only as far as the next unit's first cut needs (`unitBase`), so a
    // transition is never charged a full extra turn it does not sweep.
    let angleBase = 0
    // The A of the last point the operation actually emitted. The next unit
    // starts at the smallest whole-turn representative of its own first angle
    // that is at or ahead of this (#1103 ca-d fix 1): see `unitBase`.
    let lastCommandedA: number | undefined
    // #1155 rn-d: a wall-foot column is cut as its own ring, and no layer's
    // helix band starts, ends or runs through it. The foot is the position from
    // which the tool first follows the target's own surface at that depth, and a
    // helix pose there is resampled onto the wall it is tangent to (which the
    // layer's air rule then refuses outright, dropping the whole band to rings).
    const wallFootAt = sampling.ringOnlyIndices.length > 0
      ? new Set(sampling.ringOnlyIndices)
      : null
    // #1177: the shoulder-cleanup rings are emitted at the end of each layer,
    // not in grid order -- see `shoulderCleanIndices`.
    const cleanAt = sampling.shoulderCleanIndices.length > 0
      ? new Set(sampling.shoulderCleanIndices)
      : null
    const roughBand = continuousRoughInput(sampling, params, tool, warnings, hooks)
    for (let layer = 1; layer <= layers; layer++) {
      if (hooks.shouldStop?.()) return { operationId, moves: [], warnings: [], bounds: null }
      const previousRadius = maxRadius - (layer - 1) * params.stepdown
      const layerRadius = Math.max(lowest, maxRadius - layer * params.stepdown)
      const touchesMaterial = square
        ? angles.map((angle) => layerRadius < squareRotaryTouchRadius(stock, angle, tool.radius, tool.type))
        : null
      // This layer's rings, sampled once in **forward** order: every ring turns
      // A the same way, so the last cut of one ring is where the next begins.
      // `full` is a whole uninterrupted ring of material -- every angle cuts and
      // the cuts are one run -- which is the only shape a helix may replace.
      interface LayerRing {
        readonly runs: RotaryRun[]
        readonly full: boolean
      }
      const layerRings: LayerRing[] = []
      for (let i = 0; i < along.length; i++) {
        const samples: (ToolpathPoint | null)[] = []
        let full = true
        for (let k = 0; k <= last; k++) {
          const tip = tips[k][i]
          const cuts = tip < previousRadius && (touchesMaterial === null || touchesMaterial[k])
            && cutsInRegion(along[i], angles[k], Math.max(tip, layerRadius))
          if (!cuts) full = false
          samples.push(cuts ? point(along[i], Math.max(tip, layerRadius), angles[k]) : null)
        }
        if (!square) feedThroughRingGaps(samples, tips, i, angles, previousRadius, maxRadius, insideRegion, along[i], point)
        const runs = ringRuns(samples)
        layerRings.push({ runs, full: full && runs.length === 1 })
      }
      // A new layer never links to the previous one, however its last ring ended.
      let previousEndedAtEnd = false
      // #1117 review (P2): the at-layer candidate joins two **adjoining rings**
      // of this layer, so under a **region** both must be eligible. A split ring
      // is a ring whose cut runs are separated by angular sectors the mask (or
      // the model) does not remove; the mask's own split can leave a first/last
      // run that shares an angle with the neighbouring ring while the transition
      // itself is not an end-to-end ring link, so the raised link is the
      // fallback there. #1103 slice ca-f leaves that rule exactly as it was: a
      // region's rings are the mask's arcs, and none of the forward-only ring
      // work below re-proves them.
      //
      // Without a region the candidate's own proof decides, split ring or not.
      // Every ring turns forward now, so the point the previous ring left is its
      // last run's end and this ring's first point is its first run's start --
      // the boundary the forward path really crosses -- and #1117's material
      // walk proves the transition on the facts. The old gate refused that on a
      // **round** bar too, which lost #1117's same-A links as soon as a helix
      // took the whole-ring bands and left only the split rings behind it
      // (busto-round op0025, #1103 ca-f); a square blank had already been
      // released from the gate for the same reason (#1117 square links). A
      // boundary the geometry cannot prove -- a wide A change on a round bar
      // (`MAX_LINK_ACROSS_DEG`), a lobe between the runs, a region without a
      // boundary test -- still keeps the raised link.
      let previousRingSplit = false
      let previousRingEmitted = false
      const layerLink = raisedLinkPlan(layer)
      /**
       * The link into a unit at `from`: the raised plan is always computed first
       * (#1117 fix 2's accounting) and the at-layer candidate overlays it only
       * where the boundary is provable. `previousRingSplit` gates the transition
       * only under a region; without one the candidate's own walk proves it,
       * split ring or not (#1103 ca-f, see `previousRingSplit`).
       */
      const unitLink = (from: ToolpathPoint, to: ToolpathPoint, split: boolean): readonly RotaryLinkStep[] | null => {
        const raised = layerLink(from, to)
        const splitBlocked = (previousRingSplit || split) && region !== null
        if (splitBlocked) return raised
        return linkAtLayer(layer, layerRadius, alongCoordinate(stock, from), from, to, 1) ?? raised
      }
      /**
       * The forward-equivalent A offset for a unit whose first sample is at
       * `firstPhysical` degrees: the smallest whole-turn representative that is
       * at or ahead of the last commanded A (#1103 ca-d fix 1, review P2).
       *
       * The old unconditional `angleBase += 360` charged a full extra turn
       * between every pair of rings whichever way the cut happened to end. For
       * a partial ring that ends **behind** the next one's first cut (the usual
       * case: the ring's last run ends at its high-angle boundary, the next
       * ring's first run starts at its low-angle one) that made the ring-to-ring
       * transition a 380 degree sweep -- past `MAX_LINK_ACROSS_DEG`, so the
       * #1117 at-layer link could not be kept and busto-rect lost 82 of them.
       * The smallest representative instead asks only for the physical step the
       * next ring needs, and a whole ring (which ends on this ring's A360, i.e.
       * exactly the next ring's A0) still advances one turn, byte for byte.
       */
      const unitBase = (firstPhysical: number): number => lastCommandedA === undefined
        ? angleBase
        : angleBase + 360 * Math.ceil((lastCommandedA - (angleBase + firstPhysical)) / 360 - 1e-9)
      /** Emit one ring at the A cursor, then move the cursor to its last cut. */
      const emitRing = (index: number): void => {
        const ring = layerRings[index]
        if (ring.runs.length > 0) {
          const first = ring.runs[0].points[0]
          angleBase = unitBase(first.a ?? 0)
        }
        const runs = ring.runs.map((run) => ({
          ...run,
          points: run.points.map((sample) => ({ ...sample, a: (sample.a ?? 0) + angleBase })),
        }))
        const splitRing = ring.runs.length > 1
        // #1117: the at-layer cut joins the preceding ring **of this layer** to
        // this one -- `previousRingEmitted` makes a skipped ring's wider gap
        // explicit -- and the candidate itself checks that the emitted previous
        // point is the adjoining ring's. The first ring of a layer never links.
        const ringLink = index === 0 || !previousRingEmitted
          ? layerLink
          : (from: ToolpathPoint, to: ToolpathPoint): readonly RotaryLinkStep[] | null =>
            unitLink(from, to, splitRing)
        const emitted = emitRotaryRuns(moves, here, runs, safeZ, travelZ, previousEndedAtEnd, forceStep, pivot, ringLink, index > 0)
        here = emitted.here
        previousEndedAtEnd = emitted.endedAtEnd
        previousRingSplit = splitRing
        previousRingEmitted = runs.length > 0
        if (runs.length > 0) {
          const lastRun = runs[runs.length - 1]
          lastCommandedA = lastRun.points[lastRun.points.length - 1].a
        }
      }
      let ringIndex = 0
      while (ringIndex < along.length) {
        if (hooks.shouldStop?.()) return { operationId, moves: [], warnings: [], bounds: null }
        // #1155 rn-d: a wall-foot ring is cut as its own ring, never as a helix
        // boundary -- the helix resamples its poses on the operation's mesh, so
        // one starting at the foot rides the wall it is tangent to (and, at a
        // roughing layer below the wall's top, the layer's air rule refuses the
        // whole band instead).
        if (cleanAt !== null && cleanAt.has(ringIndex)) {
          ringIndex++
          continue
        }
        if (wallFootAt !== null && wallFootAt.has(ringIndex)) {
          emitRing(ringIndex)
          ringIndex++
          continue
        }
        if (layerRings[ringIndex].full) {
          let band = ringIndex
          while (band + 1 < along.length && layerRings[band + 1].full
            && (wallFootAt === null || !wallFootAt.has(band + 1))
            && (cleanAt === null || !cleanAt.has(band + 1))) band++
          // A band of one ring is just a ring: a helix needs an axial step to
          // turn into a pitch, and its two complete end rings would otherwise
          // add a full turn over no advance at all.
          if (band > ringIndex) {
            // #1103 slice ca-g: split a band the helix cannot verify everywhere,
            // exactly as the finish does, one layer at a time. Only a tolerance
            // refusal says where to split; a spent budget, cancellation, no
            // material standing at this layer and the region keep the whole
            // band's rings, so the layer's air skip is never relaxed.
            const walked = walkContinuousBand({
              along,
              attempt: (from: number, to: number, spent: ContinuousHelixSpend): ContinuousHelix | null =>
                roughBand === null ? null : buildContinuousHelix({
                  ...roughBand,
                  band: { start: along[from], end: along[to] },
                  // A helix opens on a whole turn at its band's start (physical
                  // A0), so its forward-equivalent base is `unitBase(0)`.
                  startAngle: unitBase(0),
                  // #1103 ca-j: a square blank's layer keeps the ring path's
                  // material-touch gate at every helix pose. The gate is the
                  // layer's air skip -- `touchesMaterial` above is the same test
                  // at the ring grid's angles -- so a pose where the blank has no
                  // material standing at this radius refuses the band and the
                  // layer's rings are kept, exactly as a pose with no material
                  // under the tool already does.
                  layer: {
                    radius: layerRadius,
                    previousRadius,
                    ...(square
                      ? {
                        material: (angle: number): boolean =>
                          layerRadius < squareRotaryTouchRadius(stock, angle, tool.radius, tool.type),
                      }
                      : {}),
                  },
                  spent,
                }),
              accept: (helix) => region === null
                || continuousPathInsideRegion(region, stock, helix.points, angleBase),
              // The helix is one run of this layer's cuts. The link into it is
              // the ring boundary's, on the same rules: the band's first ring is
              // a whole ring, so a still-standing predecessor may link at it.
              emitHelix: (helix) => {
                const helixBase = unitBase(0)
                const linkFromPrevious = previousRingEmitted
                const helixLink = linkFromPrevious
                  ? (from: ToolpathPoint, to: ToolpathPoint): readonly RotaryLinkStep[] | null =>
                    unitLink(from, to, true)
                  : layerLink
                const emitted = emitRotaryRuns(
                  moves, here, [{ points: helix.points, atStart: true, atEnd: true }],
                  safeZ, travelZ, previousEndedAtEnd, forceStep, pivot, helixLink, linkFromPrevious,
                )
                here = emitted.here
                previousEndedAtEnd = emitted.endedAtEnd
                previousRingSplit = false
                previousRingEmitted = true
                angleBase = helixBase
                lastCommandedA = helix.points[helix.points.length - 1].a
              },
              emitRing,
              ...(hooks.shouldStop !== undefined ? { shouldStop: hooks.shouldStop } : {}),
            }, ringIndex, band)
            if (walked.stopped) return { operationId, moves: [], warnings: [], bounds: null }
            ringIndex = band + 1
            continue
          }
        }
        emitRing(ringIndex)
        ringIndex++
      }
      // #1177: the layer's shoulder-cleanup rings, on the material its own
      // passes have already removed (see `shoulderCleanIndices`).
      if (cleanAt !== null) {
        for (const index of sampling.shoulderCleanIndices) {
          if (hooks.shouldStop?.()) return { operationId, moves: [], warnings: [], bounds: null }
          emitRing(index)
        }
      }
    }
  } else {
    // #1098: along layers alternate the direction of their angle sequence, so
    // layer 2 runs the angles last-to-first and starts where layer 1 ended. A
    // stays within [0, 360] for the whole operation -- no `(layer - 1) * 360` is
    // added -- and no full turn separates two layers. The along direction
    // alternates across the layer boundary too (one global pass counter), so a
    // layer starts at the bar end the previous one finished at; the step between
    // layers keeps the ordinary travel-height retract/plunge.
    //
    // Rotary rough and finish have **no cut direction setting**: passes and
    // layers alternate direction on purpose, mixing climb and conventional, to
    // keep A within one turn and avoid air moves (decided 2026-10-23, #1098).
    // #1103 (continuous A, not in 0.6.0) may later replace the alternation.
    for (let layer = 1; layer <= layers; layer++) {
      if (hooks.shouldStop?.()) return { operationId, moves: [], warnings: [], bounds: null }
      const previousRadius = maxRadius - (layer - 1) * params.stepdown
      const layerRadius = Math.max(lowest, maxRadius - layer * params.stepdown)
      // A new layer never links to the previous one, however its last pass ended.
      let previousEndedAtEnd = false
      const reversed = layer % 2 === 0
      const layerPass = (layer - 1) * angles.length
      for (let pass = 0; pass < angles.length; pass++) {
        if (hooks.shouldStop?.()) return { operationId, moves: [], warnings: [], bounds: null }
        const angleIndex = reversed ? angles.length - 1 - pass : pass
        const angle = angles[angleIndex]
        const touchesMaterial = !square
          || layerRadius < squareRotaryTouchRadius(stock, angle, tool.radius, tool.type)
        const indexAt = (i: number): number => (layerPass + pass) % 2 === 0 ? i : along.length - 1 - i
        const needsCut = (i: number): boolean =>
          touchesMaterial && tips[angleIndex][indexAt(i)] < previousRadius
          && cutsInRegion(along[indexAt(i)], angle, Math.max(tips[angleIndex][indexAt(i)], layerRadius))
        const at = (i: number): ToolpathPoint => {
          const index = indexAt(i)
          return point(along[index], Math.max(tips[angleIndex][index], layerRadius), angle)
        }
        const runs: RotaryRun[] = []
        let i = 0
        while (i < along.length) {
          if (!needsCut(i)) { i++; continue }
          const start = i
          while (i + 1 < along.length && needsCut(i + 1)) i++
          const end = i
          const points: ToolpathPoint[] = []
          for (let j = start; j <= end; j++) points.push(at(j))
          runs.push({ points, atStart: start === 0, atEnd: end === along.length - 1 })
          i++
        }
        const emitted = emitRotaryRuns(moves, here, runs, safeZ, travelZ, previousEndedAtEnd, forceStep)
        here = emitted.here
        previousEndedAtEnd = emitted.endedAtEnd
      }
    }
  }
  if (here) moves.push({ kind: 'rapid', from: here, to: { ...here, z: safeZ } })
  const merged = mergeCollinearCuts(
    moves,
    convertLength(0.001, 'mm', tool.units),
    params.passDirection === 'around' ? pivot : undefined,
  )
  const finalMoves = params.passDirection === 'around'
    ? raiseShortAroundSegments(merged.moves, sampling.baseAngleStep,
      convertLength(AROUND_RAISE_TOLERANCE_MM, 'mm', tool.units), convertLength(0.001, 'mm', tool.units))
    : merged.moves
  return {
    operationId,
    moves: finalMoves,
    warnings,
    bounds: boundsOf(finalMoves),
  }
}

/**
 * Sample once, then remove only the material still standing at each layer.
 *
 * `passDirection: 'around'` replaces each layer's along passes with rings at one
 * along position (#1045 slice A): the per-sample `needsCut`/layer rule is the
 * along pass's, the direction alternation continues across layers (no
 * `(layer - 1) * 360` is added, so A never leaves [0, 360]), and every sample
 * reads its own angle row. Consecutive rings are linked (#1093) at the
 * angle their runs share -- a full ring's end and the next ring's start, or a
 * square corner arc's touch-gate boundary. Where the link can stay at the layer
 * it is a **cutting feed** at `max(this layer's radius, the model)` along the
 * bar (#1117): that removes only the band this layer removes anyway, so it
 * neither cuts deeper nor adds a feed, and it is the common case on a round bar.
 * A **square** blank's rings are corner arcs, so a link between two of them at
 * the gate's boundary angle is tried too. Without a region, a layer below the
 * blank's inscribed radius (one whole turn at A0/A360) and a ring the model
 * splits link as well, under a stricter bound: one stepdown from the material
 * the earlier layers and the ring it starts from left, no scallop or cell
 * allowance, and rings no further apart than the cutter (#1117 square links).
 * A **region** limits the link the same way it limits a ring: the whole
 * along span must be inside the mask, and the material outside it stands as the
 * uncut blank in the one-band check, so a link at a later layer is raised over
 * it. Everything that cannot be proved safe keeps the raised link: it rises to
 * the highest material this operation's own earlier layers left on the path,
 * plus the 1 mm clearance, rapids across and drops back. The constant-height
 * traverse is a **rapid**: it is in air by construction, and a feed through air
 * makes the machine creep. Its rise and drop stay feeds; the first layer has
 * nothing removed in front of it and, where no at-layer cut qualifies, keeps the
 * travel height, and an A-changing link is left to the old travel-height rule
 * (or its retract), because a surface link requires one exact angle.
 * Missing
 * keeps the along motion byte
 * for byte -- the shape of the motion, not its band: the slice-D retained-end
 * pull applies to both modes and is a safety fix.
 *
 * Along-the-bar layers alternate the direction of their angle sequence (#1098):
 * layer 1 runs the angles in ascending order, layer 2 in descending order from
 * where layer 1 ended, and so on. No `(layer - 1) * 360` is added, so A stays
 * within [0, 360] for the whole operation instead of growing by a full turn per
 * layer. The along direction alternates across the layer boundary as well, so a
 * layer starts at the bar end the previous one finished at; the step between
 * layers keeps the ordinary travel-height retract/plunge. **Rotary rough and
 * finish have no cut direction setting**: passes and layers alternate direction
 * on purpose, mixing climb and conventional, to keep A within one turn and
 * avoid air moves (decided 2026-10-23, #1098). #1103 (continuous A, not in
 * 0.6.0) may later replace the alternation.
 *
 * A **square** blank supports around mode too (#1045 slice C): a sample is cut
 * only when the layer radius is below `squareRotaryTouchRadius` at that
 * sample's own angle (the along pass's air skip, applied per angle instead of
 * per pass) and its tip is below the layer above. Because a layer is exactly
 * one `stepdown` below the previous one and the first layer starts at the
 * blank's corner radius, a sample can never take more than one `stepdown` out
 * of the material standing at its angle -- the engagement bound the output
 * guard re-checks. The layer count and radii stay counted from
 * `barMaxRadius`, so the corners are covered from the first layer.
 *
 */

/**
 * The rough's synchronous driver (#1115 slice p-d1): the checks, the sampling
 * and the emission are three shared stages, so the asynchronous driver below
 * cannot drift from this one. `rotaryTargets` applies the #1095 rule that the
 * radial leave belongs to the model surface alone on a rough too.
 */
export function generateRotaryRough(
  operationId: string,
  mesh: RotaryModelMesh,
  stock: BarStock,
  tool: NormalizedTool,
  params: RotaryRoughParams,
  hooks: Pick<RotarySampleOptions, 'onAngle' | 'shouldStop'>,
): ToolpathResult {
  const refused = roughRefusal(operationId, stock, tool, params)
  if (refused) return refused
  const warnings: ToolpathWarning[] = []
  const sampling = rotaryTargets(operationId, mesh, stock, tool, params, hooks, warnings)
  return roughFromTargets(operationId, stock, tool, params, hooks, sampling, warnings)
}

/**
 * Rotary roughing through an injected batch factory (#1115 slice p-d1): the same
 * checks, the same per-angle job and the same emission, with each angle batch
 * awaited instead of run inline.
 *
 * Nothing calls it on the generation path yet; p-d2's pool supplies the factory
 * and p-d3 wires the worker. The default is the in-process serial runner.
 */
export async function generateRotaryRoughAsync(
  operationId: string,
  mesh: RotaryModelMesh,
  stock: BarStock,
  tool: NormalizedTool,
  params: RotaryRoughParams,
  hooks: Pick<RotarySampleOptions, 'onAngle' | 'shouldStop'>,
  factory: RotaryBatchFactory = serialRotaryBatches,
): Promise<ToolpathResult> {
  const refused = roughRefusal(operationId, stock, tool, params)
  if (refused) return refused
  const warnings: ToolpathWarning[] = []
  const sampling = await rotaryTargetsAsync(operationId, mesh, stock, tool, params, hooks, warnings, factory)
  return roughFromTargets(operationId, stock, tool, params, hooks, sampling, warnings)
}
