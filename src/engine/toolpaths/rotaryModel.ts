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

import { getStockBounds } from '../../types/project'
import type { BarStock, Clamp, RotaryPassDirection, RoundStock } from '../../types/project'
import { barCentre, barInscribedRadius, barMaxRadius, barPivotZ, isSquareStock } from '../../types/barStock'
import { convertLength, type Units } from '../../utils/units'
import { minRenderHeight } from '../csg'
import { chooseHeightMapCellSize } from './finishSurfaceParallel'
import {
  AROUND_ANGLE_TOLERANCE_MM,
  MAX_ROTARY_SAMPLES,
  alongExtremes,
  createRotarySamplingPrep,
  refineAroundSampling,
  refineAroundSamplingAsync,
  sampleAnglesWithPrep,
  sampleAnglesWithPrepAsync,
  sampleRotaryModelWithWorkspace,
  serialRotaryBatches,
} from './rotarySampling'
import type {
  RotaryAngleBatch,
  RotaryBatchFactory,
  RotaryModelMesh,
  RotarySampleOptions,
  RotarySamplingPrep,
  RotarySamplingWorkspace,
} from './rotarySampling'
import { buildContinuousHelix, walkContinuousBand } from './rotaryContinuous'
import type {
  ContinuousBandInput,
  ContinuousHelix,
  ContinuousHelixSpend,
} from './rotaryContinuous'
import { rotaryTravelZ, squareBlankRetainedStub, squareBlankSectionExit, squareRotaryStubContactFloor, squareRotaryTouchRadius } from './squareRotaryStock'
import type { NormalizedTool, ToolpathMove, ToolpathPoint, ToolpathResult } from './types'
import type { ToolpathWarning, ToolpathWarningCode } from './warningCodes'

/**
 * The sampling half of rotary generation lives in `rotarySampling.ts` since
 * #1115 slice p-d1: preparation, the per-angle job, ordered assembly and the
 * refinement decisions, with a synchronous and an asynchronous driver. This
 * module owns the motion -- the sampling grid, the retained-bar stubs, the
 * target rows and the two generators -- and drives the sampler through the
 * same prep for the base grid and every refinement round.
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

export interface RotaryFinishParams {
  /** Distance between passes, measured round the bar's surface. */
  readonly stepover: number
  /**
   * Distance between samples along a pass. In around mode it is the angular
   * step round the blank, capped so the straight move between two samples stays
   * within 0.005 mm of a convex section (#1045 slice D).
   */
  readonly sampleSpacing: number
  /** Material left on the model, measured normal to its surface. */
  readonly stockToLeave: number
  /** The along range the passes cover; the caller (a later slice) derives it from the model and the end supports. */
  readonly alongStart: number
  readonly alongEnd: number
  /**
   * Tool-tip radius from the turning pivot for the operation's first
   * positioning move and its final retract; must be above the blank's surface.
   * Every move between runs -- a retract, a traverse or a turning link --
   * travels at the blank's largest surface plus a clearance, and the first and
   * last moves go to the higher of this and that clearance.
   */
  readonly safeRadius: number
  /** Requested height-map cell size, passed to the sampler. */
  readonly requestedCellSize: number
  /**
   * Whether each pass runs along the bar (the original motion) or around it: a
   * ring at one along position, turning A round the bar, then a step along
   * (#1045 slice A). Missing reads as `'along'`, so a saved operation's motion
   * is unchanged.
   */
  readonly passDirection?: RotaryPassDirection
  /**
   * The operation target's region features as one mask, in the Around sheet's
   * **unwrapped** coordinates (#1096): along is the bar's axis, across is
   * `zero + a * pi * thickness / 360` -- the same convention the 2.5D Around
   * operations use. Omitted or null means no region and cuts the whole sampled
   * surface exactly as before.
   */
  readonly region?: RotaryRegionMask | null
}

/**
 * A region mask in the Around sheet's unwrapped coordinates (#1096).
 *
 * `RegionMask` in `regions.ts` satisfies this structurally, so the rotary
 * engine does not depend on Clipper. A **cut** link is a straight segment, and
 * a mask that can prove a whole segment inside answers that as well; point
 * membership alone is not enough there, because a strip narrower than the
 * sampling can fall between two tested points (#1096 review, P2).
 */
export interface RotaryRegionMask {
  containsPoint(point: { x: number; y: number }): boolean
  containsSegment?(from: { x: number; y: number }, to: { x: number; y: number }): boolean
}

/** Perpendicular distance of `point` from the line through `a` and `b`. */
function distanceFromLine(
  point: { x: number; y: number; z: number },
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const abz = b.z - a.z
  const apx = point.x - a.x
  const apy = point.y - a.y
  const apz = point.z - a.z
  const lengthSq = abx * abx + aby * aby + abz * abz
  if (lengthSq <= 1e-18) return Math.hypot(apx, apy, apz)
  const crossX = apy * abz - apz * aby
  const crossY = apz * abx - apx * abz
  const crossZ = apx * aby - apy * abx
  return Math.hypot(crossX, crossY, crossZ) / Math.sqrt(lengthSq)
}

/**
 * The error a merged around move makes at one original sample (#1045 slice H).
 *
 * The controller interpolates A and Z linearly along one move, so the sample's
 * own A fixes the fraction: the merged move is interrogated **at that A** and
 * the difference in Z (and in the along coordinate) is the real tool-position
 * error. Slice G measured the perpendicular distance in (along, A, Z) space
 * instead. That is not the same test: an error in Z can be hidden by the A
 * component of the perpendicular, so at a fixed A the move commanded more Z
 * error than the tolerance. Codex's three tips -- (A0, 10), (A0.1, 10.0151),
 * (A0.2, 10.028) -- collapse to one perpendicular distance of 0.000858 mm under
 * the old metric yet command 10.014 at A0.1: 0.0011 mm off the 0.001 mm
 * tolerance. Interpolating at the sample's own A keeps the middle point.
 *
 * When A does not change (a stepped leg has its own run), the fraction comes
 * from the along motion, and a point outside the segment's A span is never
 * dropped (it has no commanded position on the merged move).
 */
function interpolationErrorAtOwnAngle(
  point: { x: number; y: number; z: number; a?: number },
  a: { x: number; y: number; z: number; a?: number },
  b: { x: number; y: number; z: number; a?: number },
): number {
  const deltaAngle = (b.a ?? 0) - (a.a ?? 0)
  let fraction: number
  if (deltaAngle !== 0) {
    fraction = ((point.a ?? 0) - (a.a ?? 0)) / deltaAngle
  } else {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const lengthSq = dx * dx + dy * dy
    if (lengthSq <= 1e-18) return Math.hypot(point.x - a.x, point.y - a.y, point.z - a.z)
    fraction = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq
  }
  if (!(fraction >= -1e-9 && fraction <= 1 + 1e-9)) return Number.POSITIVE_INFINITY
  const f = Math.min(1, Math.max(0, fraction))
  return Math.max(
    Math.abs(point.x - (a.x + (b.x - a.x) * f)),
    Math.abs(point.y - (a.y + (b.y - a.y) * f)),
    Math.abs(point.z - (a.z + (b.z - a.z) * f)),
  )
}

/**
 * Drop the collinear interior points of every run of `cut` moves that share one
 * pass, keeping the run's first and last point. A run never crosses a move that
 * turns the stock -- the same rule `linearMoveOptimization` follows (issue
 * #393): the merged move would keep only one endpoint's angle, and every angle
 * this toolpath emits is a command the machine must reach. Runs also stop where
 * the tool reverses along the bar, so a merge can never join two passes that
 * happen to line up in X through the link between them.
 *
 * With `pivot` (an around pass, #1045 slice G) a run *is* allowed to turn: the
 * controller interpolates A and Z linearly, so consecutive cut moves inside one
 * ring are one straight move in (along, A, Z). Runs still stop where A reverses
 * and at a stepped leg (A constant, Z or along moving), so the emitter's
 * rise/traverse/drop links are never joined into one diagonal. Along mode and
 * round bars pass no pivot and keep the old rule and the old distance exactly.
 */
export function mergeCollinearCuts(
  moves: readonly ToolpathMove[],
  tolerance: number,
  pivot?: number,
): { moves: ToolpathMove[]; dropped: number } {
  const angular = pivot !== undefined
  const merged: ToolpathMove[] = []
  let index = 0
  while (index < moves.length) {
    const first = moves[index]
    if (first.kind !== 'cut' || (!angular && first.from.a !== first.to.a)) {
      merged.push(first)
      index++
      continue
    }
    const direction = angular
      ? angularDirection(first.from, first.to)
      : Math.sign((first.to.x - first.from.x) + (first.to.y - first.from.y))
    let end = index
    while (
      end + 1 < moves.length
      && moves[end + 1].kind === 'cut'
      && moves[end + 1].from.x === moves[end].to.x
      && moves[end + 1].from.y === moves[end].to.y
      && (!angular || moves[end + 1].from.z === moves[end].to.z)
      && (!angular || moves[end + 1].from.a === moves[end].to.a)
      && (!angular || angularDirection(moves[end + 1].from, moves[end + 1].to) === direction)
      && (angular
        || (moves[end + 1].from.a === moves[end + 1].to.a
          && moves[end + 1].from.a === first.from.a
          && Math.sign((moves[end + 1].to.x - moves[end + 1].from.x) + (moves[end + 1].to.y - moves[end + 1].from.y)) === direction))
    ) end++
    const points: ToolpathPoint[] = [moves[index].from]
    for (let i = index; i <= end; i++) points.push(moves[i].to)
    // An around run interpolates at each sample's own A; the along and round-bar
    // paths keep the original 3D perpendicular distance byte for byte.
    const kept = simplifyRun(points, tolerance, angular)
    for (let i = 0; i + 1 < kept.length; i++) {
      merged.push({ kind: 'cut', from: kept[i], to: kept[i + 1] })
    }
    index = end + 1
  }
  return { moves: merged, dropped: moves.length - merged.length }
}

/**
 * The direction of one move for the around-pass merge: A when the move turns the
 * blank, otherwise the along/centre motion the old rule used. A stepped leg (A
 * constant, a pure Z move) yields zero, so it always starts its own run and is
 * never folded into a ring chord.
 */
function angularDirection(from: ToolpathPoint, to: ToolpathPoint): number {
  const deltaAngle = (to.a ?? from.a ?? 0) - (from.a ?? 0)
  if (deltaAngle !== 0) return Math.sign(deltaAngle)
  return Math.sign((to.x - from.x) + (to.y - from.y))
}

/**
 * Douglas--Peucker: a straight segment replaces the points it spans only when
 * **every** one of them is within `tolerance` of it, so the merged path can
 * never drift further from a dropped point than the tolerance. The check this
 * replaced tested each point against the *next original* point only, so on a
 * gently curved profile (`r(x) = 6 - 0.001 (x - 20)^2`, 0.05 mm samples) every
 * step looked straight and the whole run collapsed into one chord 0.0995 mm
 * below the surface -- 100 times the 0.001 mm the merge promises.
 *
 * Cost on the slice-B fixture (the merge over every pass at once): Douglas--
 * Peucker took 15 ms from 78,624 pre-merge moves to 7,296 on the finish, and
 * 2.8 ms from 36,282 to 2,136 on the rough, against the old neighbour scan's
 * single pass. The farthest-point split makes it near `n log n` per run rather
 * than `n`, which the fixture's 252 passes and 751 samples do not notice.
 *
 * `interpolate` (an around pass) measures each point as the merged move's error
 * **at that point's own A**, as {@link interpolationErrorAtOwnAngle} describes.
 * Without it the distance is the original 3D one, to the bit.
 */
function simplifyRun(points: readonly ToolpathPoint[], tolerance: number, interpolate = false): ToolpathPoint[] {
  const distance = interpolate
    ? (point: ToolpathPoint, a: ToolpathPoint, b: ToolpathPoint): number => interpolationErrorAtOwnAngle(point, a, b)
    : (point: ToolpathPoint, a: ToolpathPoint, b: ToolpathPoint): number => distanceFromLine(point, a, b)
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack: Array<[number, number]> = [[0, points.length - 1]]
  while (stack.length > 0) {
    const [first, last] = stack.pop() as [number, number]
    let split = -1
    let farthest = tolerance
    for (let i = first + 1; i < last; i++) {
      const pointDistance = distance(points[i], points[first], points[last])
      if (pointDistance > farthest) {
        farthest = pointDistance
        split = i
      }
    }
    if (split < 0) continue
    keep[split] = 1
    stack.push([first, split], [split, last])
  }
  const kept: ToolpathPoint[] = []
  for (let i = 0; i < points.length; i++) if (keep[i]) kept.push(points[i])
  return kept
}

function boundsOf(moves: readonly ToolpathMove[]): ToolpathResult['bounds'] {
  if (moves.length === 0) return null
  const bounds = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity }
  for (const move of moves) {
    for (const point of [move.from, move.to]) {
      if (point.x < bounds.minX) bounds.minX = point.x
      if (point.x > bounds.maxX) bounds.maxX = point.x
      if (point.y < bounds.minY) bounds.minY = point.y
      if (point.y > bounds.maxY) bounds.maxY = point.y
      if (point.z < bounds.minZ) bounds.minZ = point.z
      if (point.z > bounds.maxZ) bounds.maxZ = point.z
    }
  }
  return bounds
}

/**
 * One run of a pass: its cut points in traversal order, and whether the run
 * touches the pass's first / last sample. Both generators cut a pass in runs --
 * the rough where material is still standing at a layer, the finish where the
 * model leaves the line over the centreline -- and the shared emitter below is
 * the unit that links two runs or retracts between them.
 *
 * A finish ring that a region cuts to one contiguous arc (#1096 slice D) is
 * marked both `atStart` and `atEnd`: the region-clipped piece *is* the ring the
 * operation cuts there, and its boundary angle is exactly where the reversed
 * next ring's piece begins. `followLink` still decides whether those angles
 * really match and the path stays inside the region, so a ring the region or a
 * model gap splits into several runs keeps the old retract.
 */
interface RotaryRun {
  readonly points: readonly ToolpathPoint[]
  readonly atStart: boolean
  readonly atEnd: boolean
}

/**
 * Dense model samples along the bar at the physical angle every around ring
 * ends on (#1093). Rings alternate direction, so ring `i` always finishes at
 * one of the two representations of the same physical rotation -- A0 or A360 --
 * and ring `i + 1` starts there. The link between them is a feed along the bar
 * at that shared angle, and this row is the safe tip height the link follows.
 *
 * `tips` is the same transformed value the rings cut at (stock to leave added,
 * floored at the pivot, capped at the blank's largest radius, and -- on a
 * square blank -- floored at the retained stub's exact contact); `NaN` still
 * means "no model under the tool".
 */
export interface RotaryLinkRow {
  readonly along: readonly number[]
  readonly tips: readonly number[]
}

/**
 * The link path a budget belongs to (#1117 fix 1): the raised link, whose
 * accounting must match the pre-#1117 operation, or the at-layer candidate.
 */
export type RotaryLinkBucket = 'raised' | 'atLayer'

/**
 * One commanded leg of a ring-to-ring link (#1093). The finish's surface-
 * following legs are feeds; the rough's in-air traverse is a rapid, because it
 * is above every material its own earlier layers can leave on the span by the
 * clearance -- the same reason the old travel-height traverse was a rapid.
 */
interface RotaryLinkStep {
  readonly to: ToolpathPoint
  readonly kind: 'cut' | 'rapid'
}

/** Both controller spellings of the same physical bar rotation (A0 and A360). */
function sameRotaryAngle(a: number, b: number): boolean {
  const delta = ((b - a) % 360 + 360) % 360
  return delta <= 1e-9 || delta >= 360 - 1e-9
}

/** The along-bar coordinate of a point on either bar axis. */
function alongCoordinate(stock: BarStock, point: { x: number; y: number }): number {
  return stock.axis === 'x' ? point.x : point.y
}

/**
 * Is this tool position inside the operation's region (#1096)?
 *
 * The mask is drawn on the Around sketch's unwrapped sheet, so a position is
 * tested at `(along, across)` for either bar axis -- the same mapping
 * `wrapPoint`/`unwrapPoint` use in `aroundFrame.ts`: across is the bar's
 * centreline plus `a / 360` of one circumference, never reduced to one turn.
 *
 * A tool's A runs 0..360 while the sheet spans one circumference centred on
 * A0, so the same bar surface is reachable from both ends of the sheet. The
 * mask handed in by the adapter has its geometry repeated one circumference
 * each way (`buildRegionMask`'s `repeat`), so this mapping is a single test:
 * a region that crosses the sheet seam, or is drawn past either edge of it,
 * means one continuous area of the bar.
 */
export function rotaryRegionContains(
  mask: RotaryRegionMask,
  stock: BarStock,
  along: number,
  angleDeg: number,
): boolean {
  const across = barCentre(stock) + angleDeg * Math.PI * stock.thickness / 360
  return mask.containsPoint(stock.axis === 'x' ? { x: along, y: across } : { x: across, y: along })
}

/**
 * Is the whole along-bar span at one angle inside the operation's region
 * (#1096 review, P2)?
 *
 * A surface link is one straight cut at one angle, so its membership must be
 * decided for the segment, not for the dense row's sample points: an excluded
 * strip 0.02 mm wide between two samples is still cut by the link that steps
 * over it. The mask exposes its own boundary test (`containsSegment`); `null`
 * means the mask has none, and the caller keeps its point check, so a
 * hand-built mask with only point membership behaves exactly as before.
 */
export function rotaryRegionSegmentContains(
  mask: RotaryRegionMask,
  stock: BarStock,
  fromAlong: number,
  toAlong: number,
  angleDeg: number,
): boolean | null {
  if (mask.containsSegment === undefined) return null
  const across = barCentre(stock) + angleDeg * Math.PI * stock.thickness / 360
  return stock.axis === 'x'
    ? mask.containsSegment({ x: fromAlong, y: across }, { x: toAlong, y: across })
    : mask.containsSegment({ x: across, y: fromAlong }, { x: across, y: toAlong })
}

/**
 * Is an A-changing link's **whole swept path** inside the operation's region
 * (#1117 rl-e correction, review finding 1)?
 *
 * The link is one commanded straight move in `(along, A)`. The sheet's across
 * coordinate is affine in A -- `centre + a * pi * thickness / 360` -- so that
 * move is one straight segment on the sheet: the path's angle at every along
 * position lies exactly on the segment from `(fromAlong, across(fromAngle))` to
 * `(toAlong, across(toAngle))`. The mask's boundary test therefore decides the
 * whole path at once, and can see an excluded strip narrower than the sample
 * spacing that a point-by-point check of the emitted waypoints steps over.
 *
 * `null` means the mask has no boundary test, and the caller keeps its
 * per-sample point check.
 */
export function rotaryRegionSlopeContains(
  mask: RotaryRegionMask,
  stock: BarStock,
  fromAlong: number,
  fromAngle: number,
  toAlong: number,
  toAngle: number,
): boolean | null {
  if (mask.containsSegment === undefined) return null
  const acrossAt = (angleDeg: number): number => barCentre(stock) + angleDeg * Math.PI * stock.thickness / 360
  const fromAcross = acrossAt(fromAngle)
  const toAcross = acrossAt(toAngle)
  return stock.axis === 'x'
    ? mask.containsSegment({ x: fromAlong, y: fromAcross }, { x: toAlong, y: toAcross })
    : mask.containsSegment({ x: fromAcross, y: fromAlong }, { x: toAcross, y: toAlong })
}

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
function turnAngle(commanded: number): number {
  const wrapped = commanded - 360 * Math.round(commanded / 360)
  return wrapped === -180 ? 180 : wrapped
}

/**
 * Is every move of a continuous path inside the operation's region (#1103
 * slice ca-c)?
 *
 * A helix is one straight move in `(along, A)` per segment, so the mask's own
 * boundary test decides the **whole swept path** of each segment -- the same
 * rule `rotaryRegionSlopeContains` already applies to the rough's A-changing
 * links. A mask without a boundary test (`null`) cannot prove a band, and the
 * caller keeps rings there. This is what lets a region that excludes nothing
 * (the whole sheet) keep the region-free motion, while a region that trims part
 * of the band is refused and its rings stay forward-only.
 */
function continuousPathInsideRegion(
  mask: RotaryRegionMask,
  stock: BarStock,
  points: readonly ToolpathPoint[],
  startAngle: number,
): boolean {
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1]
    const to = points[i]
    const fromAngle = turnAngle((from.a ?? startAngle) - startAngle)
    const toAngle = fromAngle + ((to.a ?? startAngle) - (from.a ?? startAngle))
    const inside = rotaryRegionSlopeContains(
      mask, stock, alongCoordinate(stock, from), fromAngle, alongCoordinate(stock, to), toAngle,
    )
    if (inside !== true) return false
  }
  return true
}

/**
 * Emit one pass's runs, and say where the pass left the tool. A run that starts
 * where the previous pass finished links to it -- a rise to `travelZ`, a turn,
 * and a drop, each its own `cut` move so a merged move can never lose one of the
 * two angles. `travelZ` is the bar's surface plus a clearance (`2R + clearance`,
 * a tip height): nothing -- model or standing stock -- is ever above the bar's
 * surface, so the turn is always in air, and it is far shorter than a retract to
 * `safeZ`. The link used to turn at the higher of the two end tips, which is
 * *inside* the model between the two pass angles: on a square prism of half-width
 * 10 in a 40 mm bar the 34.29 -> 51.43 degree link ran at tip radius 13.598 while
 * the corner at 45 degrees needed 14.141.
 *
 * #1093 added a **forced link** for around mode: when a run ends at its ring's
 * end and the next starts at the next ring's start, the two share one physical
 * angle (rings alternate direction, so A0 and A360 are the same rotation), and
 * `link` supplies the feed path between them -- the finish follows the model at
 * that angle, the rough rises only to what its own earlier layers left. It is
 * emitted before the travel-height rules below, so a link that can stay down
 * never becomes a retract, rapid and plunge; `link` returns null for a split
 * ring, a gap in the reachable surface, an angle change or an over-budget row,
 * and that run falls through to the old motion unchanged.
 *
 * Every other run stays at `travelZ` too: the retract off the run just cut, the
 * traverse to the next run's first point and the plunge's start are all at the
 * bar's surface plus the clearance, never at `safeZ`. Material may still stand
 * above the layer between runs, but nothing stands above the bar, so the
 * traverse is in air; hopping over the bar beats the full retract to
 * `safeRadius` this used to do on every gap (on a 10-layer rough that was
 * hundreds of full retracts). `safeZ` is left for the operation's first
 * positioning move and its final retract.
 *
 * Inside a run two neighbouring samples are joined by one straight move. That
 * move is safe only while the surface between them rises gently: the tool at an
 * intermediate point is at an interpolated height, and its footprint reaches
 * terrain that neither sample's own height accounted for. So a step steeper than
 * 45 degrees (the tips differ by more than the samples are apart) is not one
 * diagonal move. Rising, the tool goes straight up at the first sample to the
 * higher tip and then runs along at that height; falling, it runs along at the
 * first sample's height and then drops at the second. The horizontal leg is safe
 * at the higher of the two heights because the cutter over the span stays inside
 * the union of the two samples' footprints, and each of those is safe at that
 * height or below (exact for a flat end mill; for a ball nose what is left is the
 * ordinary between-sample error, about `s^2 / (8r)` for sample spacing `s` and
 * ball radius `r`). Gentler steps keep the single diagonal move.
 *
 * "The samples are apart" is their distance **along the surface**, which is not
 * always their X/Y distance: in an around pass two neighbouring samples share
 * one along position and differ only in A, so their X/Y spacing is zero and
 * every rise would look steep. Passing `pivot` (the bar's turning centreline in
 * Z) adds the arc the tool tip sweeps, `rMin * |dA| * pi / 180` at the smaller
 * of the two tip radii, to that distance (#1045 slice A). The along pass never
 * passes `pivot`: its `dA` inside a run is zero, and leaving the two-argument
 * `Math.hypot` in place keeps its spacing, and so its output, byte-identical.
 */
/**
 * Emit one ring-to-ring link (#1093).
 *
 * `steps` excludes `from` and ends at the next ring's first point. A feed leg
 * is split by the same steep-step rule the rings use: a rise larger than the
 * pair's surface distance is a vertical leg plus a leg at the higher tip, so a
 * sharp shoulder cannot be undercut between two safe samples. A pair that
 * shares its along position and angle is the link's own vertical leg (the
 * rough's constant-height plan) and is emitted directly -- the ring loop's
 * split would make it a move plus a zero-length move. A rapid leg is emitted
 * as given: it is the rough's in-air traverse at one height, and the
 * steep-step rule does not apply to a move that already clears the material.
 */
function emitLinkPoints(
  moves: ToolpathMove[],
  from: ToolpathPoint,
  steps: readonly RotaryLinkStep[],
  forceStep?: (from: ToolpathPoint, to: ToolpathPoint) => boolean,
): void {
  let previous = from
  for (const step of steps) {
    const to = step.to
    if (to.x === previous.x && to.y === previous.y && to.z === previous.z && to.a === previous.a) {
      previous = to
      continue
    }
    if (step.kind === 'rapid') {
      moves.push({ kind: 'rapid', from: previous, to })
      previous = to
      continue
    }
    const spacing = Math.hypot(to.x - previous.x, to.y - previous.y)
    const rise = to.z - previous.z
    if (spacing <= 1e-12) {
      moves.push({ kind: 'cut', from: previous, to })
    } else {
      const stepped = Math.abs(rise) > spacing
        || (Math.abs(rise) > 1e-9 && forceStep?.(previous, to) === true)
      if (stepped) {
        if (rise > 0) {
          moves.push({ kind: 'cut', from: previous, to: { ...previous, z: to.z } })
          moves.push({ kind: 'cut', from: { ...previous, z: to.z }, to })
        } else {
          moves.push({ kind: 'cut', from: previous, to: { ...to, z: previous.z } })
          moves.push({ kind: 'cut', from: { ...to, z: previous.z }, to })
        }
      } else {
        moves.push({ kind: 'cut', from: previous, to })
      }
    }
    previous = to
  }
}

function emitRotaryRuns(
  moves: ToolpathMove[],
  here: ToolpathPoint | undefined,
  runs: readonly RotaryRun[],
  safeZ: number,
  travelZ: number,
  previousEndedAtEnd: boolean,
  forceStep?: (from: ToolpathPoint, to: ToolpathPoint) => boolean,
  pivot?: number,
  link?: (from: ToolpathPoint, to: ToolpathPoint) => readonly RotaryLinkStep[] | null,
  /**
   * Attempt the link from whatever point the previous ring left, not only from
   * a run that reached its ring's end (#1093). A square rough's rings cut only
   * short arcs around the corners, so their runs start and end at the touch
   * gate's boundaries rather than at A0/A360; two neighbouring rings still
   * share those boundary angles. The caller enables this only for a ring after
   * the first in its layer, so a layer boundary keeps the travel-height
   * retract. The finish leaves it off: a split ring retracts, as the issue
   * requires. The finish instead marks a region-clipped single run as its own
   * pass start and end (#1096 slice D), so the exact-angle check in `link` still
   * decides whether it links.
   */
  linkPartial?: boolean,
): { here: ToolpathPoint | undefined; endedAtEnd: boolean } {
  let current = here
  let endedAtEnd = false
  for (const run of runs) {
    const first = run.points[0]
    // #1093: a ring-to-ring link that can stay down is a feed, not a
    // retract/rapid/plunge. `link` is supplied only for around mode; it returns
    // the points to feed through (excluding `current`, ending at `first`), or
    // null when the link cannot stay down -- a gap in the reachable surface, an
    // angle change or the work budget -- in which case the old behaviour below
    // applies unchanged. A split ring never reaches this call: the finish
    // reports it as not ended at the ring's end.
    const linkPoints = current !== undefined && (linkPartial === true || (previousEndedAtEnd && run.atStart))
      ? link?.(current, first) ?? null
      : null
    // The travel-height link is the same-along turn: a square rough's corner
    // arcs are separated by an A move at one along position. `linkPartial`
    // (the rough) may use it from any run, not only from a ring end; on a
    // square blank it turns at the corner envelope, which is the existing
    // rule. The finish keeps the old gate, so a split ring still retracts.
    const canLink = current !== undefined && current.x === first.x && current.y === first.y
      && (previousEndedAtEnd && run.atStart
        || (linkPartial === true && current.a !== first.a))
    if (linkPoints && current) {
      emitLinkPoints(moves, current, linkPoints, forceStep)
      current = linkPoints[linkPoints.length - 1].to
    } else if (canLink && current) {
      const high = travelZ
      if (high > current.z) moves.push({ kind: 'cut', from: current, to: { ...current, z: high } })
      moves.push({ kind: 'cut', from: { ...current, z: high }, to: { ...first, z: high } })
      if (high > first.z) moves.push({ kind: 'cut', from: { ...first, z: high }, to: first })
    } else if (current) {
      moves.push({ kind: 'rapid', from: current, to: { ...current, z: travelZ } })
      moves.push({ kind: 'rapid', from: { ...current, z: travelZ }, to: { ...first, z: travelZ } })
      moves.push({ kind: 'plunge', from: { ...first, z: travelZ }, to: first })
    } else {
      // The operation's first positioning move: from and to the same point at
      // `safeZ`, the way `pushRapidAndPlunge` opens -- the tool is placed at
      // safe height rather than ever read as starting buried at the cutting tip
      // -- and only then plunges to the first cut. Every later gap is at
      // `travelZ` above.
      moves.push({ kind: 'rapid', from: { ...first, z: safeZ }, to: { ...first, z: safeZ } })
      moves.push({ kind: 'plunge', from: { ...first, z: safeZ }, to: first })
    }
    for (let i = 1; i < run.points.length; i++) {
      const from = run.points[i - 1]
      const to = run.points[i]
      // The distance along the surface between the two samples. Along the bar
      // that is their X/Y spacing (`pivot` is absent, exactly as before); in an
      // around pass they share an along position and differ only in A, so the
      // distance is the arc at the smaller tip radius from the pivot.
      const spacing = pivot === undefined
        ? Math.hypot(to.x - from.x, to.y - from.y)
        : Math.hypot(
            to.x - from.x,
            to.y - from.y,
            Math.max(0, Math.min(from.z, to.z) - pivot) * Math.abs((to.a ?? 0) - (from.a ?? 0)) * Math.PI / 180,
          )
      const rise = to.z - from.z
      // A square blank's retained-stub zone forces the step regardless of the
      // 45-degree rule: the exact contact chord can sag below the floor over a
      // shallower-looking drop. A horizontal move is already safe and is left
      // alone, so a forced segment only splits when it actually changes height.
      const stepped = Math.abs(rise) > spacing
        || (Math.abs(rise) > 1e-9 && forceStep?.(from, to) === true)
      if (stepped) {
        if (rise > 0) {
          // Rising: straight up at the first (lower) sample, then along at the
          // higher tip.
          moves.push({ kind: 'cut', from, to: { ...from, z: to.z } })
          moves.push({ kind: 'cut', from: { ...from, z: to.z }, to })
        } else {
          // Falling: along at the first (higher) sample's height, then straight
          // down at the second sample.
          moves.push({ kind: 'cut', from, to: { ...to, z: from.z } })
          moves.push({ kind: 'cut', from: { ...to, z: from.z }, to })
        }
      } else {
        moves.push({ kind: 'cut', from, to })
      }
    }
    current = run.points[run.points.length - 1]
    endedAtEnd = run.atEnd
  }
  return { here: current, endedAtEnd }
}

/**
 * Split one around-mode ring into the runs of contiguous samples that cut.
 * `samples` is already in the order the ring is traversed (forward or reversed),
 * so `atStart`/`atEnd` speak about that traversal: the emitter links two runs
 * only where one ends at a ring end and the next begins there. A `null` sample
 * is not cut -- the finish's "no model under the tool", or the rough's "no
 * material standing at this layer" (#1045 slice A).
 */
function ringRuns(samples: readonly (ToolpathPoint | null)[]): RotaryRun[] {
  const runs: RotaryRun[] = []
  let i = 0
  while (i < samples.length) {
    if (samples[i] === null) {
      i++
      continue
    }
    const start = i
    while (i + 1 < samples.length && samples[i + 1] !== null) i++
    const points: ToolpathPoint[] = []
    for (let j = start; j <= i; j++) {
      const sample = samples[j]
      if (sample) points.push(sample)
    }
    runs.push({ points, atStart: start === 0, atEnd: i === samples.length - 1 })
    i++
  }
  return runs
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
function aroundArcStep(stock: BarStock, params: RotaryFinishParams, units: Units): number {
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
function aroundGrid(
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
 * The most dense link samples one around operation may ask for (#1093). The
 * link row is one extra angle row over the ring along span, sampled no coarser
 * than the ring spacing or a quarter of the tool radius; a span and spacing
 * that ask for more than this fall back to the old travel-height link rather
 * than sampling a coarser row, because a coarser row would miss a feature the
 * row exists to find.
 */
const MAX_LINK_SAMPLES = 250_000

/**
 * The total link-row samples one around operation may build across every
 * shared angle it links at. A square blank links at the angles its touch gate
 * opens and closes, so several rows are built; this caps the total work rather
 * than any single row. Over the cap the remaining angles fall back to the old
 * travel-height link.
 */
const MAX_LINK_TOTAL_SAMPLES = 2_000_000

/**
 * The largest `row.length x along.length` product one link may cost (#1093).
 * The link row is walked once per ring boundary and the rough's leftover walk
 * is over the whole row for every earlier layer, so an unbounded product runs
 * for minutes on a long bar with a small cutter. Over the budget the angle
 * falls back to today's retract rather than a coarser row.
 */
const MAX_LINK_WORK = 4_000_000

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
function boundedIntervals(span: number, spacing: number): number | null {
  const intervals = Math.ceil(Math.abs(span) / Math.max(spacing, 1e-9))
  if (!Number.isFinite(intervals) || intervals > MAX_ROTARY_SAMPLES) return null
  return Math.max(1, intervals)
}

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
 * True when any vertex of the target mesh lies outside the bar: past one of
 * the bar's ends, or outside its physical cross-section. For a round bar that
 * is farther from the axis than the radius; for a square blank (#1016 C2-S3)
 * it is outside the **box** `|across − centre| ≤ side / 2`, `|up − pivot| ≤
 * side / 2` — the actual blank, not the inscribed circle. The sampler only
 * sees the bar's own surface there, so those parts are machined as air.
 * `tolerance` is the 3D view's minimum render height, so a vertex the view
 * already draws on the surface is on it, not outside it.
 */
function modelOutsideBar(mesh: RotaryModelMesh, stock: BarStock, tolerance: number): boolean {
  const bounds = getStockBounds(stock)
  const radius = barInscribedRadius(stock)
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const square = isSquareStock(stock)
  const minAlong = stock.axis === 'x' ? bounds.minX : bounds.minY
  const maxAlong = stock.axis === 'x' ? bounds.maxX : bounds.maxY
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const along = stock.axis === 'x' ? mesh.positions[i] : mesh.positions[i + 1]
    const across = stock.axis === 'x' ? mesh.positions[i + 1] : mesh.positions[i]
    const up = mesh.positions[i + 2]
    if (along < minAlong - tolerance || along > maxAlong + tolerance) return true
    if (square
      ? squareBlankSectionExit(stock, across, up, tolerance)
      : Math.hypot(across - centre, up - pivot) > radius + tolerance) return true
  }
  return false
}

/**
 * The material the blank keeps beyond the cut range, as a mesh the sampler
 * also reads: a closed cylinder of the round bar's own radius, or — for a
 * square blank (#1016 C2-S3) — the closed square prism of the blank's physical
 * cross-section, both coaxial with the turning pivot. A cylinder standing in
 * for a square blank would leave its corners unsupported and let a finite
 * cutter enter them. `null` for an empty span.
 */
function retainedBarStub(
  stock: BarStock,
  units: Units,
  alongFrom: number,
  alongTo: number,
  inset = 0,
): RotaryModelMesh | null {
  // #1095: erode the stub by `inset` in every direction — its own radius / half
  // side, and both along ends. The sampler's tool is enlarged by the same
  // amount, and a ball against an `s`-eroded solid is the real ball against the
  // real solid, so the retained wall keeps exactly the clearance the real cutter
  // needs instead of the stock to leave. A zero inset adds/subtracts exactly
  // zero, so the stock-to-leave-zero output is untouched.
  const from = alongFrom + inset
  const to = alongTo - inset
  return isSquareStock(stock)
    ? squareBlankRetainedStub(stock, from, to, inset)
    : retainedRoundStub(stock, units, from, to, inset)
}

/**
 * A closed solid cylinder of the bar's own radius, coaxial with it, spanning
 * `alongFrom` to `alongTo`. `segments` is the smallest count whose facet
 * sagitta `R (1 - cos(pi / segments))` stays within `minRenderHeight` of the
 * true surface, so the height map never reads the stub below the bar by more
 * than the 3D view's own minimum height (100 segments for a 40 mm bar at
 * 0.01 mm). `inset` erodes the cylinder by that distance (#1095): its radius and
 * both along ends move in, so a sampling tool enlarged by the same amount meets
 * the real wall exactly where the real cutter does. Returns `null` for an empty
 * span.
 */
function retainedRoundStub(
  stock: RoundStock,
  units: Units,
  alongFrom: number,
  alongTo: number,
  inset = 0,
): RotaryModelMesh | null {
  const radius = barInscribedRadius(stock) - inset
  if (!(alongTo - alongFrom > 0) || !(radius > 0)) return null
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const sagitta = minRenderHeight(units)
  const segments = Math.max(3, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - sagitta / radius))))
  const positions: number[] = []
  const index: number[] = []
  for (const along of [alongFrom, alongTo]) {
    for (let i = 0; i < segments; i++) {
      const t = 2 * Math.PI * i / segments
      const across = centre + radius * Math.cos(t)
      const up = pivot + radius * Math.sin(t)
      if (stock.axis === 'x') positions.push(along, across, up)
      else positions.push(across, along, up)
    }
  }
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments
    index.push(i, j, segments + j, i, segments + j, segments + i)
  }
  // Close both ends. The caps matter to any other consumer of the mesh; the
  // height map skips their vertical faces (`buildHeightMap`'s zero-denominator
  // test), which is why the side alone already covers it.
  for (let i = 1; i < segments - 1; i++) {
    index.push(0, i + 1, i)
    index.push(segments, segments + i, segments + i + 1)
  }
  return { positions: new Float32Array(positions), index: new Uint32Array(index) }
}

/**
 * Add the bar beyond the cut range to the mesh that is sampled. It is stock to
 * keep: it holds the part to the end supports, and the tool's side must never
 * enter it. `rotaryAlongRange` keeps the tool *centre* inside the model's
 * extent, so at the model's end the cutter's side reaches a tool radius past it
 * -- on an off-axis prism (across 8..12, up 8..12, along 10..30) the rough
 * plunges to the centreline at along 10 and the cutter takes the bar at 9.5.
 *
 * With the two stubs in the mesh the existing tool-shape sampling does the work
 * by itself: a query within a tool radius of the retained bar is lifted to the
 * bar's surface, so the cutter's side cannot enter it. The stubs run from each
 * bar end to the cut range, which is the model's own end when the end supports
 * do not bind and the support keep-out when they do. The outside-bar check
 * (`modelOutsideBar`) still looks at the model alone, not at these.
 *
 * `includeSquareStubs` is false for a **square blank in around mode** (#1045
 * slice G). `rotaryCutterSpan` already keeps the ring's centre one cutter
 * radius inside a stub face, so the cutter is tangent to the face and the exact
 * `squareRotaryStubContactFloor` is the net that catches any real overlap. The
 * square stub inside the sampling mesh is then *not* a contact: the tool's rim
 * merely touches the face, while the height map reads the whole retained square
 * across the footprint and lifts the tip to the blank's corner. On a 20 x
 * 1,000 blank with 100 mm retained ends that raised the ring's tip above its
 * layer radius, which both multiplied the emitted moves (the refinement chased
 * the raised samples) and left a corner the next layer then took more than
 * `stepdown` out of -- the overcut the export guard found. The along pass keeps
 * the stub in its mesh byte for byte.
 *
 * `wallInset` erodes both stubs by that distance (#1095). `rotaryTargets`
 * passes the stock to leave here for a rough and a finish alike, because the
 * sampler is about to enlarge its tool by the same amount:
 * `(wall ⊖ s) ⊕ (R + s) = wall ⊕ R`, so the retained wall is met by the real
 * cutter instead of one thickened by the leave. Zero adds and subtracts exactly
 * zero, so stock-to-leave-zero output is untouched.
 */
function withRetainedBar(
  mesh: RotaryModelMesh,
  stock: BarStock,
  units: Units,
  alongStart: number,
  alongEnd: number,
  includeSquareStubs = true,
  wallInset = 0,
): RotaryModelMesh {
  if (isSquareStock(stock) && !includeSquareStubs) return mesh
  const stubs = retainedBarStubs(stock, units, alongStart, alongEnd, wallInset)
  if (stubs.length === 0) return mesh
  const positions = new Float32Array(mesh.positions.length + stubs.reduce((total, stub) => total + stub.positions.length, 0))
  positions.set(mesh.positions)
  const index = new Uint32Array(mesh.index.length + stubs.reduce((total, stub) => total + stub.index.length, 0))
  index.set(mesh.index)
  let positionOffset = mesh.positions.length
  let indexOffset = mesh.index.length
  let vertexOffset = mesh.positions.length / 3
  for (const stub of stubs) {
    positions.set(stub.positions, positionOffset)
    for (let i = 0; i < stub.index.length; i++) index[indexOffset + i] = stub.index[i] + vertexOffset
    positionOffset += stub.positions.length
    indexOffset += stub.index.length
    vertexOffset += stub.positions.length / 3
  }
  // #1095 slice D: the stubs are appended after the model, so every triangle
  // from this one on is retained-wall geometry. The sampler uses the boundary to
  // tell a wall cell from a model cell; without it a pass tangent to the wall's
  // face reads the wall's top and lifts off the model.
  return { positions, index, retainedTriangleStart: mesh.index.length / 3 }
}

/**
 * The two retained stubs an operation's cut range leaves at the bar's ends,
 * each already closed, with no model attached. `wallInset` is `withRetainedBar`'s
 * erosion (#1095). `withRetainedBar` concatenates these with the model; the
 * un-eroded set is also what the height-map grid is widened back to, so the
 * erosion cannot move the grid origin.
 */
function retainedBarStubs(
  stock: BarStock,
  units: Units,
  alongStart: number,
  alongEnd: number,
  wallInset = 0,
): RotaryModelMesh[] {
  const bounds = getStockBounds(stock)
  const lower = stock.axis === 'x' ? bounds.minX : bounds.minY
  const upper = stock.axis === 'x' ? bounds.maxX : bounds.maxY
  return [
    retainedBarStub(stock, units, lower, alongStart, wallInset),
    retainedBarStub(stock, units, alongEnd, upper, wallInset),
  ].filter((stub): stub is RotaryModelMesh => stub !== null)
}

/** Concatenate meshes into one; the stubs are a few hundred vertices each. */
function concatRotaryMeshes(meshes: readonly RotaryModelMesh[]): RotaryModelMesh {
  const positions = new Float32Array(meshes.reduce((total, mesh) => total + mesh.positions.length, 0))
  const index = new Uint32Array(meshes.reduce((total, mesh) => total + mesh.index.length, 0))
  let positionOffset = 0
  let indexOffset = 0
  let vertexOffset = 0
  for (const mesh of meshes) {
    positions.set(mesh.positions, positionOffset)
    for (let i = 0; i < mesh.index.length; i++) index[indexOffset + i] = mesh.index[i] + vertexOffset
    positionOffset += mesh.positions.length
    indexOffset += mesh.index.length
    vertexOffset += mesh.positions.length / 3
  }
  return { positions, index }
}

/**
 * The span the cutter's **centre** may travel inside a cut range (#1016 C2-F7).
 *
 * A square blank keeps the bar beyond the cut range as retained stock, so a cut
 * range that ends inside the bar ends on a stub face. `rotaryAlongRange` limits
 * the centre to the model's extent, which puts it exactly on that face, and the
 * cutter then reaches a full radius into the retained square. Pulling the centre
 * one cutter radius inside each stubbed end makes the cutter's rim tangent to
 * the face: the cutter stays wholly inside the band, every sample is at or
 * beyond the F6 floor's reach (so that exact floor is a net that no longer
 * binds), and the pass starts and ends with the emitter's own plunge and
 * retract. The price, approved for this slice, is that the band within one
 * cutter radius of a stub face keeps the shoulder fillet the cutter's side
 * leaves there.
 *
 * The pull is rounded **outward** (#1016 C2-F7b): each end is placed a tiny
 * relative margin (`1e-12` of the coordinate) beyond `face +/- radius`, and the
 * computed gap is verified to be at least the radius, so `start - alongStart >=
 * radius` and `alongEnd - end >= radius` hold. `face + radius` can round one ulp
 * below `radius`, and the along grid's last sample can round a few ulps past the
 * span end; the F6 floor's strict `gap < reach` test would then lift that
 * first/last sample to the blank's height -- a shoulder tick on every pass. The
 * margin is thousands of ulps and about `1e-10 mm` on a 100 mm bar: far below
 * any real overlap, and enough that neither rounding can cross the tangency. The
 * floor stays strict; this span is what keeps every real sample at or beyond it.
 *
 * The end of a range that meets the bar's own end has no stub and is unchanged.
 * The pull is **not** square-only (#1045 slice D): a round bar keeps its own
 * retained cylinder beyond the cut range (`retainedRoundStub`), and the cutter
 * body reaches the same one-radius distance into it. On Codex's repro (Ø40 x 60
 * bar, band X18..42, Ø6 flat, 2.7 stepover, 0.75 sample spacing) the round
 * ring at X20.6667 overlapped the retained end by 0.3333 mm and still cut at
 * Z24.97 against the stub's Z40 surface -- the overlap was thinner than the
 * height-map cell, so the sampler's discrete footprint missed the sliver
 * entirely. Both around and along mode gouged at that along position (the
 * along pass at sample spacing 2.9 and at 0.5 measured the same 0.3333 mm
 * overlap below the stub). Pulling the centre in on a round bar too removes the
 * overlap exactly, and the price is the square's: the band within one cutter
 * radius of a stubbed end keeps the shoulder fillet the cutter's side leaves
 * there. Every round fixture whose band meets the bar's ends is untouched, and
 * every saved along path whose band does not loses that last radius at each
 * stubbed end -- a safety fix, so byte-identity yields.
 *
 * `null` when the two pulls cross: the caller refuses with the existing
 * `rotaryNoRoom`, exactly as for an already-empty range.
 */
function rotaryCutterSpan(
  stock: BarStock,
  tool: NormalizedTool,
  params: RotaryFinishParams,
): { start: number; end: number } | null {
  const bounds = getStockBounds(stock)
  const lower = stock.axis === 'x' ? bounds.minX : bounds.minY
  const upper = stock.axis === 'x' ? bounds.maxX : bounds.maxY
  // Both bar shapes keep stock beyond the cut range, so both need the pull;
  // only an end that meets the bar's own end has no stub to stay out of.
  const radius = tool.radius
  // `Math.nextUp`/`Math.nextDown` are only proposals, so step the raw bits: one
  // unit in the last place. The verification loops below rarely need it.
  const ulpStep = (value: number, direction: 1 | -1): number => {
    const view = new DataView(new ArrayBuffer(8))
    view.setFloat64(0, value)
    view.setBigUint64(0, view.getBigUint64(0) + BigInt(value >= 0 ? direction : -direction))
    return view.getFloat64(0)
  }
  let start = params.alongStart
  if (radius > 0 && params.alongStart > lower) {
    // The exact sum can round below the radius, and the along grid's last
    // sample (`start + (end - start) * i / intervals` in `rotaryAlongPositions`)
    // can round a few ulps past the span end, so a one-ulp pull is not enough
    // (#1016 C2-F7b). A nudge of `1e-12` of the coordinate is thousands of ulps
    // -- about `1e-10 mm` on a 100 mm bar -- and orders of magnitude below any
    // real overlap, so the strict F6 floor sees a tangency at every sampled end.
    const margin = Math.max(Math.abs(params.alongStart), radius) * 1e-12
    start = params.alongStart + radius + margin
    for (let i = 0; i < 8 && start - params.alongStart < radius; i++) start = ulpStep(start, 1)
  }
  let end = params.alongEnd
  if (radius > 0 && upper > params.alongEnd) {
    const margin = Math.max(Math.abs(params.alongEnd), radius) * 1e-12
    end = params.alongEnd - radius - margin
    for (let i = 0; i < 8 && params.alongEnd - end < radius; i++) end = ulpStep(end, -1)
  }
  return start < end ? { start, end } : null
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
function rotaryAlongPositions(
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
 * The between-sample safety net for a square blank's exact retained-stub floor
 * (#1016 C2-F6): a predicate that forces the emitter's stepped move on a
 * segment whose straight chord would sag below the stub contact.
 *
 * `rotaryTargets` floors each sample at its own exact stub contact, but two
 * neighbouring samples are joined by a straight move. The contact height falls
 * away steeply just outside a square corner, so the chord between the exact
 * values can dip below the floor in between -- on Codex's 25 mm case a 0.7 mm
 * drop over the 0.733 mm sample spacing sagged 0.12 mm into the stub. The
 * emitter's existing stepped move (run along at the higher tip, then drop
 * straight down) removes that sag, but it only fires when the rise exceeds the
 * spacing, which is a 45-degree test, not the stub's own geometry.
 *
 * The exact test is one comparison per segment. The contact floor is
 * non-increasing with distance from the stub, so the largest material height
 * anywhere on a segment is at the endpoint **nearer** the stub. Call that
 * floor `F` and the farther endpoint's tip `far`. The chord's lowest point is
 * `min(tipNear, far)`, and the near endpoint was floored, so `tipNear >= F`:
 * the chord clears the whole interval exactly when `far >= F`. When `far < F`
 * the near endpoint is also the higher tip and the stepped move's horizontal
 * leg runs at `tipNear >= F` over the whole segment, while its vertical leg
 * ends on the (also floored) far sample -- so the step is safe and no other
 * segment needs one. A horizontal segment is already safe and is not split.
 *
 * `undefined` on a round bar and when an end has no retained stub, so their
 * motion is untouched. A stub's floor is `-Infinity` beyond its cutter radius,
 * so the predicate is false everywhere the stub cannot reach.
 */
function retainedStubStepForced(
  stock: BarStock,
  params: RotaryFinishParams,
  tool: NormalizedTool,
): ((from: ToolpathPoint, to: ToolpathPoint) => boolean) | undefined {
  if (!isSquareStock(stock)) return undefined
  const bounds = getStockBounds(stock)
  const lower = stock.axis === 'x' ? bounds.minX : bounds.minY
  const upper = stock.axis === 'x' ? bounds.maxX : bounds.maxY
  const lowerStub = params.alongStart > lower
  const upperStub = upper > params.alongEnd
  if (!lowerStub && !upperStub) return undefined
  const pivot = barPivotZ(stock)
  const alongOf = (point: ToolpathPoint): number => stock.axis === 'x' ? point.x : point.y
  const tipOf = (point: ToolpathPoint): number => point.z - pivot
  // The floor at `along` for the stub whose end face is at `face`.
  const floorAt = (angle: number, face: number, along: number): number =>
    squareRotaryStubContactFloor(stock, angle, tool.radius, tool.type, Math.abs(along - face))
  return (fromPoint, toPoint) => {
    const fromAlong = alongOf(fromPoint)
    const toAlong = alongOf(toPoint)
    if (fromAlong === toAlong) return false
    const angle = fromPoint.a ?? toPoint.a ?? 0
    const fromTip = tipOf(fromPoint)
    const toTip = tipOf(toPoint)
    if (lowerStub) {
      const nearAlong = Math.min(fromAlong, toAlong)
      const farTip = fromAlong <= toAlong ? toTip : fromTip
      if (farTip < floorAt(angle, params.alongStart, nearAlong)) return true
    }
    if (upperStub) {
      const nearAlong = Math.max(fromAlong, toAlong)
      const farTip = fromAlong >= toAlong ? toTip : fromTip
      if (farTip < floorAt(angle, params.alongEnd, nearAlong)) return true
    }
    return false
  }
}

/**
 * The rows every generator emits from, and how a ring link finds its surface.
 *
 * `rotaryTargets` is the synchronous entry; `rotaryTargetsAsync` runs the same
 * stages through an injected batch factory (#1115 slice p-d1). Both call the
 * same preparation, assembly and completion, so the only thing that can differ
 * between them is where an angle's row comes from.
 */
interface RotaryTargets {
  angles: number[]
  along: number[]
  tips: number[][]
  /**
   * The exact retained-stub contact at every sample (same shape as `tips`,
   * `-Infinity` where no stub reaches), or `null` when there is no square stub.
   * Kept apart from `tips` because `NaN` means "do not cut" to the finish and
   * "cut to the axis" to the rough: the rough replaces its fallback with this
   * floor where a stub overlaps (#1016 C2-F6b).
   */
  stubFloor: number[][] | null
  /**
   * The dense link row at a ring link's shared angle, around mode only. The
   * bucket names the link path whose sample budget pays for it (#1117): the
   * at-layer candidate's rows never draw on the raised link's budget.
   */
  linkRowAt: (angleDeg: number, bucket?: RotaryLinkBucket) => RotaryLinkRow | null
  /**
   * The operation's sampling prep and the material it left on the model, so the
   * around finish can build a continuous helix on the **same** mesh, stock,
   * tool, cell size and workspace the rings were sampled with (#1103 slice
   * ca-c). `null` when the operation refused or was cancelled before sampling.
   */
  prep: RotarySamplingPrep | null
  stockToLeave: number
  stopped: boolean
  refusal: ToolpathWarningCode | null
}

/** The "refused before emitting" shape every caller returns. */
function targetRefusal(code: ToolpathWarningCode): RotaryTargets {
  return {
    angles: [], along: [], tips: [], stubFloor: null, linkRowAt: () => null,
    prep: null, stockToLeave: 0, stopped: false, refusal: code,
  }
}

/** The "cancelled" shape; the caller emits no motion and no warnings. */
function targetStopped(angles: number[], along: number[]): RotaryTargets {
  return {
    angles, along, tips: [], stubFloor: null, linkRowAt: () => null,
    prep: null, stockToLeave: 0, stopped: true, refusal: null,
  }
}

/**
 * Sampling preparation (#1115 slice p-d1): everything up to the first angle.
 *
 * The validation, the sampling grid, the stock-to-leave-enlarged tool, the
 * retained-bar mesh, the `modelOutsideBar` warning and the one workspace an
 * operation reuses across its refinement rounds are all decided here, once, for
 * both drivers. What comes out is the plan the drivers sample from: the angle and
 * along lists, the mesh and tool the sampler sees, and the prep that one batch
 * of angles runs against.
 */
interface RotaryTargetPlan {
  readonly angles: number[]
  readonly along: number[]
  readonly stockToLeave: number
  readonly maxRadius: number
  readonly samplingMesh: RotaryModelMesh
  readonly samplingTool: NormalizedTool
  /** The un-eroded grid envelope (#1095), when there is one. */
  readonly gridExtra?: RotaryModelMesh
  readonly workspace: RotarySamplingWorkspace
  readonly prep: RotarySamplingPrep
}

/** Preparation, or the warning code that refuses the operation before sampling. */
function prepareRotaryTargets(
  operationId: string,
  mesh: RotaryModelMesh,
  stock: BarStock,
  tool: NormalizedTool,
  params: RotaryFinishParams,
  warnings: ToolpathWarning[],
): { refusal: ToolpathWarningCode } | { plan: RotaryTargetPlan } {
  // The tool and its radial allowance are validated before any grid work: an
  // invalid radius makes every sample read "no model", which the rough would
  // turn into a cut down to the axis. The allowance must be finite and
  // non-negative, and the radius it derives for the sampler must still be
  // positive, or the operation refuses with no motion (issue #1016 C2
  // correction M1).
  const stockToLeave = params.stockToLeave
  if (!(tool.radius > 0) || !Number.isFinite(tool.radius)) {
    return { refusal: 'toolDiameterPositive' }
  }
  const samplingRadius = tool.radius + stockToLeave
  if (!Number.isFinite(stockToLeave) || stockToLeave < 0
    || !(samplingRadius > 0) || !Number.isFinite(samplingRadius)) {
    return { refusal: 'rotaryStockToLeaveInvalid' }
  }
  // The radius the samples are capped at and the angular step is derived from
  // is the blank's *largest* radius, not the inscribed one (#1016 C2-S3): a
  // square blank stands material out to its corners at every angle, so passes
  // spaced for the inscribed circle would step past the corners. The step is
  // therefore conservative for a square and exactly the old one for a round
  // bar (where the two radii are equal).
  // The cutter-centre span (#1016 C2-F7): the cut range pulled one cutter radius
  // inside a stubbed end -- a square blank's or, since #1045 slice D, a round
  // bar's -- so no sample overlaps the retained stock. `params.alongStart`/
  // `alongEnd` stay the *band*, and so the stub faces the sampler, the F6 floor
  // and the step predicate read. A span that collapses has no room for the
  // cutter at all and refuses like an empty range.
  const span = rotaryCutterSpan(stock, tool, params)
  if (!span) {
    return { refusal: 'rotaryNoRoom' }
  }
  const maxRadius = barMaxRadius(stock)
  // Around mode is the same sampling grid with the two roles swapped: one ring
  // per along position (`stepover` apart) and the angle sweeping round the blank
  // (`sampleSpacing` apart). `aroundGrid` carries the budget check for the
  // counts it builds (#1045 slice A).
  let angles: number[]
  let along: number[]
  if (params.passDirection === 'around') {
    const grid = aroundGrid(stock, span, params, tool.units)
    if (grid === null) {
      return { refusal: 'operationStepoverRatioRange' }
    }
    angles = grid.angles
    along = grid.along
  } else {
    const passes = Math.max(1, Math.ceil((2 * Math.PI * maxRadius) / Math.max(params.stepover, 1e-9)))
    const positions = rotaryAlongPositions(mesh, stock, tool, params, span)
    if (positions === null) {
      return { refusal: 'operationStepoverRatioRange' }
    }
    along = positions
    // The budget is checked against the *refined* along count (#1016 C2-S3
    // correction). `rotaryRefusal` bounds the uniform `passes x (intervals + 1)`
    // grid, but a square blank's shoulder zones add up to
    // `2 * MAX_SHOULDER_SAMPLES` positions on top of it, and `passes x
    // along.length` is the size of the angle-row grid allocated just below. A
    // 100,000-pass operation with 8,000 shoulder positions passed the uniform
    // bound at 300,000 samples and then asked for ~8e8; refusing here is what
    // keeps that allocation from happening.
    if (!Number.isFinite(passes) || passes > MAX_ROTARY_SAMPLES || passes * along.length > MAX_ROTARY_SAMPLES) {
      return { refusal: 'operationStepoverRatioRange' }
    }
    const angleStep = 360 / passes
    angles = Array.from({ length: passes }, (_, k) => k * angleStep)
  }
  // One warning per operation, however many vertices stick out: the user can
  // only move the model or pick a bigger bar, and the sampler's answer is the
  // same either way. This judges the model alone -- the retained-bar stubs
  // below sit on the bar's surface by construction and must not trip it.
  if (modelOutsideBar(mesh, stock, minRenderHeight(tool.units))) {
    warnings.push({ code: 'rotaryModelOutsideBar', params: { operation: operationId } })
  }
  // A ball's centre is where the tool's radius meets the model, so enlarging the
  // radius by the stock is the only way to move the whole contact outward
  // normal to the surface; adding the radius back at the tip is what turns the
  // enlarged centre into the real ball's tip.
  const samplingTool: NormalizedTool = stockToLeave === 0 ? tool : {
    ...tool,
    radius: tool.radius + stockToLeave,
    diameter: tool.diameter + 2 * stockToLeave,
  }
  // #1095: the enlarged sampling tool is what applies the leave, and it applies
  // it to the retained stubs too unless they are handed to the sampler eroded by
  // the same amount. The leave belongs to the **model surface alone** for both a
  // rough and a finish: erosion by `s` plus the sampler's tool enlargement by
  // `s` is the real cutter against the real wall, so the outermost pass -- pulled
  // in exactly one cutter radius -- is limited by the wall itself and not lifted
  // to clear a thickened top corner. A zero leave adds exactly zero, so the old
  // mesh (and its bit-identical output) is unchanged.
  const wallInset = stockToLeave
  const includeSquareStubs = !(isSquareStock(stock) && params.passDirection === 'around')
  const samplingMesh = withRetainedBar(
    mesh,
    stock,
    tool.units,
    params.alongStart,
    params.alongEnd,
    // A square blank's around rings are protected from the retained stub by the
    // cutter-centre span pull and the exact stub floor, not by the height map;
    // including the stub here lifted every ring's tip near an end to the blank's
    // corner (#1045 slice G). Along mode keeps the stub in the mesh byte for byte.
    includeSquareStubs,
    wallInset,
  )
  // #1095: the erosion must move the wall's sampled height, not the height-map
  // grid. The un-eroded stubs (the ones the stock-to-leave-zero run sampled) are
  // unioned back into the grid envelope, so every sample more than one cutter
  // radius from a retained wall keeps the exact cell it had before: the eroded
  // stub only changes the cells its own footprint can read, instead of shifting
  // the origin under the whole bar. A zero inset adds nothing, so the old
  // single-mesh path stays byte for byte.
  const unErodedStubs = wallInset !== 0 && includeSquareStubs
    ? retainedBarStubs(stock, tool.units, params.alongStart, params.alongEnd)
    : []
  const gridExtra = unErodedStubs.length > 0 ? concatRotaryMeshes(unErodedStubs) : undefined
  // One workspace for the base grid and every refinement round: the mesh, tool
  // and along positions are the same in all of them, so the hull, the strip
  // index and the candidate buffer are built once (issue #1045 slice T).
  const workspace: RotarySamplingWorkspace = {}
  const prep = createRotarySamplingPrep(samplingMesh, stock, samplingTool, {
    along,
    requestedCellSize: params.requestedCellSize,
    ...(params.passDirection === 'around' ? { conservativeCellBounds: true } : {}),
    ...((gridExtra !== undefined) ? { gridExtra } : {}),
    ...(samplingMesh.retainedTriangleStart !== undefined
      ? { wallTriangleStart: samplingMesh.retainedTriangleStart }
      : {}),
    // #1103 ca-e: an around operation may build a helix over the rings it has
    // just sampled, and the helix reads the same physical angles. Keep the
    // raster maps this grid builds so the helix can read them instead of
    // rasterising a second set (#1103 ca-e, review P1). The base grid never
    // reads the cache, so its own output stays byte for byte what it was.
    // #1103 ca-j: a square blank can helix too once a layer has become round,
    // so it keeps its maps exactly as a round bar does; a band the blank's own
    // rules refuse still costs only the stores the ring grid paid for.
    ...(params.passDirection === 'around' && along.length > 1
      ? { angleMaps: 'write' as const }
      : {}),
    workspace,
  })
  return {
    plan: {
      angles, along, stockToLeave, maxRadius,
      samplingMesh, samplingTool, workspace, prep,
      ...((gridExtra !== undefined) ? { gridExtra } : {}),
    },
  }
}

/**
 * The rows after sampling (#1115 slice p-d1): the below-centreline warning, the
 * stock offset and clamp, the square blank's exact stub floor and the lazy link
 * row. Shared by both drivers, which is what keeps their warnings and move
 * streams identical.
 */
function completeRotaryTargets(
  operationId: string,
  stock: BarStock,
  tool: NormalizedTool,
  params: RotaryFinishParams,
  plan: RotaryTargetPlan,
  angles: number[],
  tipRows: readonly Float32Array[],
  warnings: ToolpathWarning[],
): RotaryTargets {
  const { along, stockToLeave, maxRadius, samplingMesh, samplingTool, gridExtra, workspace } = plan
  // The first sample below the centreline is the only place the warning names
  // (one warning per operation, however many places need it). The value that
  // decides it carries the stock offset, so leaving stock does not hide a model
  // that needs a cut below the centreline. `tipRadius[k][i]` is the height at
  // along[i], whichever direction the pass runs.
  outer: for (let k = 0; k < angles.length; k++) {
    for (let i = 0; i < along.length; i++) {
      if (tipRows[k][i] + stockToLeave < 0) {
        warnings.push({
          code: 'rotaryBelowCentreline',
          params: {
            operation: operationId,
            along: Math.round(along[i] * 100) / 100,
            angle: Math.round(angles[k] * 100) / 100,
          },
        })
        break outer
      }
    }
  }
  // A `NaN` sample (no model under the tool) stays `NaN`: the finish treats it
  // as "do not cut" and the rough as "remove down to the pivot". Every finite
  // value is floored at the pivot and capped at the blank's largest radius, so
  // retained square corners above the inscribed radius survive (#1016 C2-S3);
  // on a round bar the cap is the surface it always was.
  const tips = tipRows.map((row) => Array.from(row, (raw) =>
    Number.isFinite(raw) ? Math.min(Math.max(raw + stockToLeave, 0), maxRadius) : NaN))
  // The retained end stubs are stock the cutter's side must never enter, and
  // the sampler's discrete footprint can miss a thin axial overlap between the
  // cutter's rim and a stub's end face (#1016 C2-F6): Codex's 25 mm repro read
  // the model's 9.999256 at `x = 20.933333` while the retained `x < 18` stub's
  // flat stands at 12.5, and the vertical plunge there put the rim 0.066667 mm
  // into the stub. `squareRotaryStubContactFloor` is the exact closed-form
  // contact height for the **real** cutter (radius `tool.radius`, not the
  // stock-to-leave-enlarged sampling tool) at this pass angle and along
  // position, so flooring the final tips -- after the normal stock offset has
  // been added back -- makes the stub contact exact instead of one cell
  // approximate. The finish reads `tips`; the rough reads `tips` and
  // `stubFloor`, and re-uses one row for every layer, so this is the one shared
  // place. A `NaN` sample stays `NaN` in `tips` -- the finish must not cut
  // there -- but its floor is still recorded in `stubFloor`, because the rough
  // turns `NaN` into "cut to the axis" and an off-axis model leaves `NaN`
  // samples inside a stub's axial reach (#1016 C2-F6b). The rough takes
  // `max(axis, floor)` from that row, so a stub that does not reach the sample
  // leaves the axis fallback exactly as it was. Round bars take the old path
  // byte for byte (`withRetainedBar` still meshes their stub, but the floor is
  // only square, and `squareRotaryStubContactFloor` never lifts a round
  // sample).
  let stubFloor: number[][] | null = null
  if (isSquareStock(stock)) {
    const bounds = getStockBounds(stock)
    const lower = stock.axis === 'x' ? bounds.minX : bounds.minY
    const upper = stock.axis === 'x' ? bounds.maxX : bounds.maxY
    // No stub exists at an end the cut range already meets; `rotaryAlongPositions`
    // draws the same line before it refines a shoulder.
    const lowerStub = params.alongStart > lower
    const upperStub = upper > params.alongEnd
    if (lowerStub || upperStub) {
      stubFloor = tips.map((row) => new Array<number>(row.length).fill(Number.NEGATIVE_INFINITY))
      for (let k = 0; k < tips.length; k++) {
        const angle = angles[k]
        const row = tips[k]
        const floors = stubFloor[k]
        for (let i = 0; i < row.length; i++) {
          let floor = Number.NEGATIVE_INFINITY
          if (lowerStub) {
            floor = Math.max(floor, squareRotaryStubContactFloor(
              stock, angle, tool.radius, tool.type, along[i] - params.alongStart))
          }
          if (upperStub) {
            floor = Math.max(floor, squareRotaryStubContactFloor(
              stock, angle, tool.radius, tool.type, params.alongEnd - along[i]))
          }
          floors[i] = floor
          if (Number.isFinite(row[i]) && floor > row[i]) row[i] = floor
        }
      }
    }
  }
  // #1093: a link row per shared angle, sampled on demand and cached. A full
  // ring's end and the next ring's start share one physical angle; on a square
  // blank the rough's corner arcs share the angle where the layer's touch gate
  // opens or closes, so the shared angle is not always A0. The row is sampled
  // **no coarser than the ring spacing or a quarter of the tool radius** --
  // the caller's `sampleSpacing` is not a safety guarantee here (it caps the
  // *angular* step; the link travels along the bar), and a ridge between two
  // rings narrower than the ring spacing would otherwise be missed and cut
  // straight through. `requestedCellSize` alone cannot promise that either.
  // The same mesh, tool, stock offset, conservative cell bounds and
  // retained-stub floor the rings use are applied, so a link follows exactly
  // the surface the ring cuts. `null` means "no surface link" for that angle:
  // a mode without rings, or a work budget that cannot afford a row this fine
  // -- the caller then keeps the old retract/rapid/plunge rather than sampling
  // a coarser, unsafe row.
  //
  // #1117 (square links): one sample budget per link path; see
  // `linkRowBudget`.
  const linkSpacing = Math.min(
    aroundArcStep(stock, params, tool.units),
    params.stepover,
    tool.radius / 4,
  )
  const linkSpan = along[along.length - 1] - along[0]
  const linkIntervals = linkSpan > 0 ? Math.ceil(linkSpan / Math.max(linkSpacing, 1e-9)) : 0
  // Every row has the same along grid, so whether a row is affordable at all
  // is one answer for the operation. The row is walked once per ring boundary,
  // and the rough's leftover walk is row x along; cap that product and retract
  // instead of running a quadratic pass on a long bar with a small cutter.
  const linkRowSamples = params.passDirection !== 'around' || along.length <= 1
    || !Number.isFinite(linkIntervals) || linkIntervals <= 0 || linkIntervals + 1 > MAX_LINK_SAMPLES
    || (linkIntervals + 1) * along.length > MAX_LINK_WORK
    ? null
    : linkIntervals + 1
  const linkRowAt = linkRowBudget(linkRowSamples, (key) => {
    const linkAlong = Array.from({ length: linkIntervals + 1 }, (_, i) => along[0] + linkSpan * i / linkIntervals)
    const sampled = sampleRotaryModelWithWorkspace(
      samplingMesh,
      stock,
      samplingTool,
      {
        anglesDeg: [key],
        along: linkAlong,
        requestedCellSize: params.requestedCellSize,
        conservativeCellBounds: true,
        ...((gridExtra !== undefined) ? { gridExtra } : {}),
        ...(samplingMesh.retainedTriangleStart !== undefined
          ? { wallTriangleStart: samplingMesh.retainedTriangleStart }
          : {}),
      },
      warnings,
      workspace,
    )
    if (sampled.stopped) return 'stopped'
    if (!sampled.valid) return null
    const raw = sampled.tipRadius[0]
    const linkTips = Array.from(raw, (tip) =>
      Number.isFinite(tip) ? Math.min(Math.max(tip + stockToLeave, 0), maxRadius) : NaN)
    if (isSquareStock(stock)) {
      const bounds = getStockBounds(stock)
      const lower = stock.axis === 'x' ? bounds.minX : bounds.minY
      const upper = stock.axis === 'x' ? bounds.maxX : bounds.maxY
      const lowerStub = params.alongStart > lower
      const upperStub = upper > params.alongEnd
      if (lowerStub || upperStub) {
        for (let i = 0; i < linkAlong.length; i++) {
          let floor = Number.NEGATIVE_INFINITY
          if (lowerStub) {
            floor = Math.max(floor, squareRotaryStubContactFloor(
              stock, key, tool.radius, tool.type, linkAlong[i] - params.alongStart))
          }
          if (upperStub) {
            floor = Math.max(floor, squareRotaryStubContactFloor(
              stock, key, tool.radius, tool.type, params.alongEnd - linkAlong[i]))
          }
          if (Number.isFinite(linkTips[i]) && floor > linkTips[i]) linkTips[i] = floor
        }
      }
    }
    return { along: linkAlong, tips: linkTips }
  })
  // #1103 slice ca-d: a link row belongs to a **physical** angle, not to the
  // commanded value. Forward-only rings command the seam at `360k`, so every
  // whole-ring boundary of one layer asks at a different number for the same
  // row; without this every boundary would sample (and pay for) its own full
  // bar-length row instead of sharing the one A0 has always shared.
  const linkRows = linkRowAt
  const linkRowAtPhysical = (angleDeg: number, bucket?: RotaryLinkBucket): RotaryLinkRow | null =>
    linkRows(turnAngle(angleDeg), bucket)
  return {
    angles, along, tips, stubFloor, linkRowAt: linkRowAtPhysical, prep: plan.prep,
    stockToLeave: plan.stockToLeave, stopped: false, refusal: null,
  }
}

/**
 * The link-row cache and its sample budgets (#1093, #1117 square links),
 * apart from the model sampling so the accounting can be tested on its own.
 *
 * `rowSamples` is the sample count every row of this operation has, or `null`
 * when no row is affordable at all. `sample` samples one angle's row and
 * returns `null` for an invalid sampling (no row at that angle, for either
 * path) or `'stopped'` for a cancelled one (not a property of the angle, so
 * not shared).
 *
 * Two sample budgets, one per link path, exactly as the leftover walk has two
 * work buckets. The at-layer candidate samples rows the raised plan never asks
 * for (every grid angle an A-changing link crosses), and a shared total would
 * let those attempts starve a later raised row, which would then fall back to
 * the travel height. Each bucket decides and charges an angle on **its own
 * first request**, so the raised bucket sees the same sequence of charges and
 * refusals it did before the at-layer candidate existed. The sampled row itself
 * is shared: it depends only on the angle, so one sampling serves both paths.
 */
export function linkRowBudget(
  rowSamples: number | null,
  sample: (key: number) => RotaryLinkRow | null | 'stopped',
  totalSamples: number = MAX_LINK_TOTAL_SAMPLES,
): (angleDeg: number, bucket?: RotaryLinkBucket) => RotaryLinkRow | null {
  const sampledRows = new Map<number, RotaryLinkRow | null>()
  const decisions = { raised: new Map<number, RotaryLinkRow | null>(), atLayer: new Map<number, RotaryLinkRow | null>() }
  const totals = { raised: 0, atLayer: 0 }
  return (angleDeg: number, bucket: RotaryLinkBucket = 'raised'): RotaryLinkRow | null => {
    const key = ((angleDeg % 360) + 360) % 360
    const linkCache = decisions[bucket]
    const cached = linkCache.get(key)
    if (cached !== undefined) return cached
    if (rowSamples === null || totals[bucket] + rowSamples > totalSamples) {
      linkCache.set(key, null)
      return null
    }
    let row = sampledRows.get(key)
    if (row === undefined) {
      const sampled = sample(key)
      if (sampled === 'stopped') {
        linkCache.set(key, null)
        return null
      }
      row = sampled
      sampledRows.set(key, row)
    }
    if (row !== null) totals[bucket] += row.along.length
    linkCache.set(key, row)
    return row
  }
}

/**
 * Sampling and normal stock offset shared by finishing and every rough layer,
 * synchronously.
 *
 * The base grid is one batch, each refinement round is another, and both go
 * through the same prep, so the hull, strip plan and raster geometry are built
 * once per operation (issue #1045 slice T).
 */
function rotaryTargets(
  operationId: string,
  mesh: RotaryModelMesh,
  stock: BarStock,
  tool: NormalizedTool,
  params: RotaryFinishParams,
  hooks: Pick<RotarySampleOptions, 'onAngle' | 'shouldStop'>,
  warnings: ToolpathWarning[],
): RotaryTargets {
  const prepared = prepareRotaryTargets(operationId, mesh, stock, tool, params, warnings)
  if ('refusal' in prepared) return targetRefusal(prepared.refusal)
  const plan = prepared.plan
  const sampling = sampleAnglesWithPrep(plan.prep, plan.angles, warnings, hooks)
  if (!sampling.valid) return targetRefusal('toolDiameterPositive')
  if (sampling.stopped) return targetStopped(plan.angles, plan.along)
  // #1045 slice E: the around path's between-sample safety is a property of the
  // emitted motion, not of the endpoint grid. Bisect every segment whose chord
  // falls more than the segment tolerance below the model at its mid angle.
  let angles = plan.angles
  let tipRows: readonly Float32Array[] = sampling.tipRadius
  if (params.passDirection === 'around' && angles.length > 1) {
    const refined = refineAroundSampling({
      prep: plan.prep,
      stock,
      tool,
      warnings,
      angles,
      tips: sampling.tipRadius,
      ...(hooks.shouldStop ? { shouldStop: hooks.shouldStop } : {}),
    })
    if (refined === null) return targetRefusal('operationStepoverRatioRange')
    if (refined.stopped) return targetStopped([], [])
    angles = refined.angles
    tipRows = refined.tips
  }
  return completeRotaryTargets(operationId, stock, tool, params, plan, angles, tipRows, warnings)
}

/**
 * `rotaryTargets` through an injected batch factory (#1115 slice p-d1).
 *
 * One runner is built from the plan's prep and used for the base grid and every
 * refinement round, so a worker pool is torn down and rebuilt once per
 * operation, not once per round. Every guard, every warning and the completion
 * step are the synchronous functions above.
 */
async function rotaryTargetsAsync(
  operationId: string,
  mesh: RotaryModelMesh,
  stock: BarStock,
  tool: NormalizedTool,
  params: RotaryFinishParams,
  hooks: Pick<RotarySampleOptions, 'onAngle' | 'shouldStop'>,
  warnings: ToolpathWarning[],
  factory: RotaryBatchFactory,
): Promise<RotaryTargets> {
  const prepared = prepareRotaryTargets(operationId, mesh, stock, tool, params, warnings)
  if ('refusal' in prepared) return targetRefusal(prepared.refusal)
  const plan = prepared.plan
  const batches: RotaryAngleBatch = factory(plan.prep)
  const sampling = await sampleAnglesWithPrepAsync(plan.prep, plan.angles, warnings, hooks, batches)
  if (!sampling.valid) return targetRefusal('toolDiameterPositive')
  if (sampling.stopped) return targetStopped(plan.angles, plan.along)
  let angles = plan.angles
  let tipRows: readonly Float32Array[] = sampling.tipRadius
  if (params.passDirection === 'around' && angles.length > 1) {
    const refined = await refineAroundSamplingAsync({
      prep: plan.prep,
      stock,
      tool,
      warnings,
      angles,
      tips: sampling.tipRadius,
      ...(hooks.shouldStop ? { shouldStop: hooks.shouldStop } : {}),
    }, batches)
    if (refined === null) return targetRefusal('operationStepoverRatioRange')
    if (refined.stopped) return targetStopped([], [])
    angles = refined.angles
    tipRows = refined.tips
  }
  return completeRotaryTargets(operationId, stock, tool, params, plan, angles, tipRows, warnings)
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
 * The square blank's retained-stub contact floor for the continuous helix
 * (#1103 slice ca-j), or `undefined` when there is nothing to lift off.
 *
 * `completeRotaryTargets` floors every ring sample at exactly this closed form
 * (the real cutter's contact height against the retained square stock beyond a
 * cut range's end). The helix samples its own poses -- angles no ring row visits,
 * along positions no ring sits on -- so it asks the same form at each of them
 * instead of reading the ring grid, and a pose can never sit lower than the ring
 * path would allow there. `undefined` on a round bar (`squareRotaryStubContactFloor`
 * answers `-Infinity` for it) and on a square blank with no retained end, so the
 * round path allocates nothing new.
 */
function continuousHelixStubFloor(
  stock: BarStock,
  tool: NormalizedTool,
  params: RotaryFinishParams,
): ((along: number, angleDeg: number) => number) | undefined {
  if (!isSquareStock(stock)) return undefined
  const bounds = getStockBounds(stock)
  const lower = stock.axis === 'x' ? bounds.minX : bounds.minY
  const upper = stock.axis === 'x' ? bounds.maxX : bounds.maxY
  // No stub exists at an end the cut range already meets; the ring path's own
  // `stubFloor` draws the same line (`completeRotaryTargets`).
  const lowerStub = params.alongStart > lower
  const upperStub = upper > params.alongEnd
  if (!lowerStub && !upperStub) return undefined
  return (along: number, angleDeg: number): number => {
    let floor = Number.NEGATIVE_INFINITY
    if (lowerStub) {
      floor = Math.max(floor, squareRotaryStubContactFloor(
        stock, angleDeg, tool.radius, tool.type, along - params.alongStart))
    }
    if (upperStub) {
      floor = Math.max(floor, squareRotaryStubContactFloor(
        stock, angleDeg, tool.radius, tool.type, params.alongEnd - along))
    }
    return floor
  }
}

/**
 * The continuous helix's stepover for one square blank (#1103 slice ca-j), or
 * the caller's own on a round bar.
 *
 * A square blank's corner shell stands above the cutter tip at every angle that
 * is not its own, so a roughing turn cannot rely on the tip alone: the blank's
 * material between two turns is cleared by the cutter's flank, which reaches one
 * cutter radius either side of its own path. Two roughing turns exactly one
 * **diameter** apart therefore leave every cell on the line halfway between them
 * outside both flanks -- a helical fin of stock at the blank's corner radius.
 * The property suite sees it as a blank-support column 4.79 mm over the
 * finished-surface bound on its 12 mm / Ø1.4 / cone case with the stepover at a
 * full diameter. Overlapping the roughing turns by one tenth of a diameter
 * closes that line; a round bar has no corner shell above the tip, so its pitch
 * stays exactly the requested stepover and its bytes do not move.
 *
 * The **finish** takes the same overlap: a finish-only program has no rough to
 * clear the shell first, so its own turns cover it the same way, and on the
 * busto-rect finish (a band the work budget refuses) the overlap's shorter pitch
 * also makes that refused attempt cheaper -- 22.5 s against 23.7 s at the
 * requested stepover, one process at a time through the pool.
 */
const SQUARE_HELIX_TURN_OVERLAP = 0.9

function continuousHelixStepover(
  stock: BarStock,
  tool: NormalizedTool,
  stepover: number,
): number {
  if (!isSquareStock(stock)) return stepover
  return Math.min(stepover, tool.radius * 2 * SQUARE_HELIX_TURN_OVERLAP)
}

/**
 * The continuous helix's operation-wide input for the finish (#1103 slices ca-c
 * and ca-g).
 *
 * It runs on the prep the ring grid was sampled with -- the same mesh, the
 * stock-to-leave-enlarged tool, the retained-wall metadata, the requested cell
 * size and the one shared workspace -- so the helix reads exactly the surface
 * the rings would and pays no second cross-section, strip plan or raster. `null`
 * when the targets carry no prep (a refusal/cancellation never reaches here),
 * and the band walk then keeps every ring of the band.
 *
 * A **square blank** is admitted since #1103 slice ca-j on the finish's own
 * rules: the band is a whole ring of the model at every angle (the ring grid's
 * eligibility, unchanged), the retained ends are floored per pose with the ring
 * path's own stub contact, and its turns overlap so the blank's corner shell
 * between them is cleared (`continuousHelixStepover`). A round bar has no such
 * floor and no corner shell, so its input is byte for byte what it was.
 *
 * The band, the A cursor and the band's shared spend are left to each attempt:
 * slice ca-g splits a band that cannot be verified everywhere, and each piece
 * opens at the A cursor of the moment it is emitted.
 */
function continuousFinishInput(
  sampling: RotaryTargets,
  params: RotaryFinishParams,
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
    warnings,
    ...(stubFloor !== undefined ? { stubFloor } : {}),
    ...(hooks.shouldStop !== undefined ? { shouldStop: hooks.shouldStop } : {}),
  }
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
    warnings,
    ...(stubFloor !== undefined ? { stubFloor } : {}),
    ...(hooks.shouldStop !== undefined ? { shouldStop: hooks.shouldStop } : {}),
  }
}

/**
 * The finish's motion from sampled targets (#1115 slice p-d1).
 *
 * Both drivers end here, so the emission -- and therefore the moves, the
 * warnings and the merged output -- cannot differ between them; only how the
 * rows were produced can.
 */
function finishFromTargets(
  operationId: string,
  stock: BarStock,
  tool: NormalizedTool,
  params: RotaryFinishParams,
  hooks: Pick<RotarySampleOptions, 'onAngle' | 'shouldStop'>,
  sampling: RotaryTargets,
  warnings: ToolpathWarning[],
): ToolpathResult {
  if (sampling.refusal) {
    return { operationId, moves: [], warnings: [{ code: sampling.refusal, params: { operation: operationId } }], bounds: null }
  }
  if (sampling.stopped) return { operationId, moves: [], warnings: [], bounds: null }
  const { angles, along } = sampling
  const pivot = barPivotZ(stock)
  const centre = barCentre(stock)
  const tolerance = convertLength(0.001, 'mm', tool.units)
  // Every move between runs -- a turning link, the retract off a run, or the
  // traverse to the next run -- travels at the blank's largest surface plus a
  // clearance, so it always clears the model and the standing stock between two
  // pass angles. The blank's turning envelope reaches its corner radius from
  // the pivot at some angle, so that -- not the inscribed radius -- is the height
  // nothing may travel below; on a round bar the two are equal. `safeRadius`
  // does not cap it: a rapid height only a fifth of a millimetre above the bar
  // would otherwise replace the clearance, and the clearance is the whole
  // reason the between-run moves are safe. The operation's first positioning
  // move and its final retract go to the higher of `safeRadius` and that travel
  // height.
  const travelZ = rotaryTravelZ(stock, tool.units)
  const safeZ = Math.max(pivot + params.safeRadius, travelZ)
  // Sample `i` of a pass sits at `along[rowIndexAt(k, i)]`: even passes run from
  // alongStart to alongEnd, odd ones back, so the row index of position `i` is
  // mirrored on a return pass. Everything that reads a height must use the same
  // index the position uses -- reading `tipRadius[k][i]` on a return pass gives
  // each position the height of its mirror, which only a model symmetric along
  // the bar hides.
  const rowIndexAt = (pass: number, positionIndex: number): number =>
    pass % 2 === 0 ? positionIndex : along.length - 1 - positionIndex
  const tipAt = (pass: number, positionIndex: number): number => sampling.tips[pass][rowIndexAt(pass, positionIndex)]
  const point = (alongPosition: number, tip: number, angle: number): ToolpathPoint => stock.axis === 'x'
    ? { x: alongPosition, y: centre, z: pivot + tip, a: angle }
    : { x: centre, y: alongPosition, z: pivot + tip, a: angle }
  const alongAt = (pass: number, positionIndex: number): number => along[rowIndexAt(pass, positionIndex)]
  const forceStep = retainedStubStepForced(stock, params, tool)
  // #1096: a region limits where the tool may cut. Every sample whose tool
  // position falls outside it is dropped before it can become a cut, so a ring
  // or pass splits into the runs that are inside. The mask is null when the
  // operation targets no region, and then nothing below reads it -- the motion
  // is exactly the pre-region output.
  const region = params.region ?? null
  const insideRegion = region === null
    ? null
    : (alongPosition: number, angle: number) => rotaryRegionContains(region, stock, alongPosition, angle)
  // #1093: link consecutive full rings with a feed along the bar at their
  // shared end angle, following the model at that angle through the dense link
  // row. The finish assumes no rough: the height is the model's own safe tip,
  // never the standing blank. A `NaN` anywhere on the span means the link
  // cannot stay down (there is no surface under the tool there), so the old
  // retract/rapid/plunge handles it; the same happens for a split ring (the
  // caller marks a ring that emitted more than one run as not ended at its end),
  // a link that changes A, and an operation whose dense row would exceed the
  // work budget (no row). Only the operation's first positioning move and its
  // final retract go to the rapid height.
  const linkRowAt = sampling.linkRowAt
  const followLink = (from: ToolpathPoint, to: ToolpathPoint): readonly RotaryLinkStep[] | null => {
    if (from.a === undefined || to.a === undefined) return null
    // A surface link keeps one angle *exactly*. A0 and A360 are the same
    // physical rotation, but a move between them is a full commanded turn; an
    // A-changing link stays on the old travel-height cut rule (or its retract).
    if (from.a !== to.a) return null
    const linkRow = linkRowAt(from.a)
    if (!linkRow) return null
    const fromAlong = alongCoordinate(stock, from)
    const toAlong = alongCoordinate(stock, to)
    if (!(toAlong > fromAlong)) return null
    // #1096 review (P2): this link is a **cut** from `fromAlong` to `toAlong`
    // at one angle, so the **whole span** must be inside the region -- not just
    // the dense row's sample points. A 0.02 mm excluded strip between two
    // samples was stepped over by a link that then cut it, because membership
    // was only ever asked at the samples. The mask's own boundary geometry
    // decides the segment; `null` means a hand-built mask with point membership
    // only, which keeps the sample check below.
    const linkAngle = turnAngle(from.a)
    if (region !== null && insideRegion !== null) {
      if (!insideRegion(fromAlong, linkAngle) || !insideRegion(toAlong, linkAngle)) return null
      if (rotaryRegionSegmentContains(region, stock, fromAlong, toAlong, linkAngle) === false) return null
    }
    const points: RotaryLinkStep[] = []
    for (let i = 0; i < linkRow.along.length; i++) {
      const x = linkRow.along[i]
      if (x <= fromAlong + 1e-12 || x >= toAlong - 1e-12) continue
      // A point-only mask still gets the old per-sample test; an exact segment
      // test above already subsumes it.
      if (insideRegion !== null && !insideRegion(x, linkAngle)) return null
      const tip = linkRow.tips[i]
      if (!Number.isFinite(tip)) return null
      points.push({ to: point(x, tip, from.a), kind: 'cut' })
    }
    points.push({ to, kind: 'cut' })
    return points
  }
  const moves: ToolpathMove[] = []
  let here: ToolpathPoint | undefined
  let previousEndedAtEnd = false
  if (params.passDirection === 'around') {
    // #1103 slice ca-c: A never reverses. Every ring turns the same way, and the
    // next ring continues from the angle the last one reached instead of
    // rewinding -- A grows by 360 per ring (or by the helix's own turns) and is
    // never wrapped modulo 360; the A range is the controller's job (#1091).
    //
    // A **continuous helix** replaces the rings wherever a whole band of rings
    // can be cut without interruption: every sample of the ring is the model
    // under the tool, and the operation's region (when it has one) contains the
    // whole band. `buildContinuousHelix` samples the actual combined (along, A)
    // poses and closes the band with a complete ring at each axial end, so the
    // band is one run with no stop. Everything else -- a partial ring, a model
    // gap, a region that trims the ring, a helix whose budget ran out -- keeps
    // its rings, now forward-only, with the emitter's safe transition between
    // them. A **square blank** is helixed too since #1103 slice ca-j, on the
    // finish's own rule: its band must be a whole ring of the model at every
    // angle, and the builder floors each pose off the retained ends with the
    // ring path's own stub contact and overlaps its turns so the blank's corner
    // shell between them is cleared by the cutter's flank. A finishing pass has
    // no layer, so the blank's material-touch gate does not apply here (the
    // finish follows the model wherever the ring grid does).
    //
    // #1103 slice ca-g splits a band the attempt could not verify everywhere:
    // the rings around the unverifiable spans, a helix on each run between them,
    // all of it charged against the band's one work budget and linked through
    // these same rules (`walkContinuousBand`).
    //
    // Only a full ring whose last angle is A360 and whose next ring starts at
    // A0 of the next turn keeps #1093's surface link: those two commands are
    // numerically equal, which is exactly the link's constant-A precondition. A
    // region-clipped ring, or one the model splits, ends at an interior angle
    // and its next ring starts at the other boundary of the arc -- a full turn
    // apart -- so it falls back to the existing travel-height transition.
    const last = angles.length - 1
    interface AroundRing {
      /** The ring's cut points at the sampled angles, shifted by the A cursor at emission. */
      readonly runs: RotaryRun[]
      /** Every sample is the model under the tool, and the region contains them all. */
      readonly eligible: boolean
    }
    const rings: AroundRing[] = []
    for (let ring = 0; ring < along.length; ring++) {
      if (hooks.shouldStop?.()) return { operationId, moves: [], warnings: [], bounds: null }
      const samples: (ToolpathPoint | null)[] = []
      // #1096 slice D: the region's own membership on this ring, counted apart
      // from the model's `NaN` samples, so a ring the *region boundary* trimmed
      // is not confused with a ring the model split.
      let regionPieces = 0
      let regionStart = -1
      let regionEnd = -1
      let regionGap = false
      let inRegion = false
      let allCovered = true
      for (let step = 0; step <= last; step++) {
        const tip = sampling.tips[step][ring]
        const finite = Number.isFinite(tip)
        const inside = insideRegion === null || insideRegion(along[ring], angles[step])
        if (!finite || !inside) allCovered = false
        if (inside) {
          if (!inRegion) {
            regionPieces++
            if (regionStart < 0) regionStart = step
          }
          inRegion = true
          regionEnd = step
          if (!finite) regionGap = true
        } else {
          inRegion = false
        }
        samples.push(finite && inside ? point(along[ring], tip, angles[step]) : null)
      }
      const runs = ringRuns(samples)
      // A ring the region cuts to **one** contiguous interior arc, with no model
      // gap inside that arc, is the ring trimmed to the region -- not a split
      // ring. Mark its run as both the start and the end of the pass it cuts:
      // the next forward ring also starts at the arc's first boundary angle, one
      // full turn later, so the emitter attempts the surface link and the
      // constant-A check refuses it unless the arc happens to close the turn. A
      // region that wraps the A0/A360 seam arrives as **two** pieces (the arc is
      // split by the ring's own ends) and is deliberately left with today's
      // retract, as is a ring split by a model gap.
      if (regionPieces === 1 && !regionGap && runs.length === 1
        && regionStart > 0 && regionEnd < last) {
        runs[0] = { ...runs[0], atStart: true, atEnd: true }
      }
      rings.push({ runs, eligible: allCovered })
    }
    // The A cursor: the commanded angle every point of the next unit is built
    // from. A ring advances it by one turn, a helix by its own complete turns.
    let angleBase = 0
    // One forward-only ring at the cursor's angle. A split ring is partial arcs:
    // its last run can still reach the ring end, but the issue's contract is
    // that a split ring retracts rather than feeding to the next ring. Only a
    // ring that emitted one run may link -- a region-clipped ring's single run
    // is marked above, so it may.
    const emitRing = (index: number): void => {
      const runs = rings[index].runs.map((run) => ({
        ...run,
        points: run.points.map((sample) => ({ ...sample, a: (sample.a ?? 0) + angleBase })),
      }))
      const emitted = emitRotaryRuns(moves, here, runs, safeZ, travelZ, previousEndedAtEnd, forceStep, pivot, followLink)
      here = emitted.here
      previousEndedAtEnd = emitted.endedAtEnd && runs.length <= 1
      angleBase += 360
    }
    const finishBand = continuousFinishInput(sampling, params, tool, warnings, hooks)
    let ring = 0
    while (ring < along.length) {
      if (hooks.shouldStop?.()) return { operationId, moves: [], warnings: [], bounds: null }
      if (rings[ring].eligible) {
        let band = ring
        while (band + 1 < along.length && rings[band + 1].eligible) band++
        // A band of one ring is just a ring: a helix needs an axial step to turn
        // into a pitch, and its two complete end rings would otherwise add a
        // full turn over no advance at all.
        if (band > ring) {
          // #1103 slice ca-g: the band is no longer helix-or-nothing. A band the
          // helix can verify everywhere is one helix; a band it cannot verify
          // **everywhere** is split at the unverifiable spans -- rings there,
          // helices on the runs between them -- and only the refusals that say
          // nothing about where to split (a spent budget, cancellation, no model
          // under the tool, the region) keep the whole band's rings. The walk
          // charges every attempt against one shared budget, so the split cannot
          // cost more speculative work than the single attempt did.
          const walked = walkContinuousBand({
            along,
            attempt: (from: number, to: number, spent: ContinuousHelixSpend): ContinuousHelix | null =>
              finishBand === null ? null : buildContinuousHelix({
                ...finishBand,
                band: { start: along[from], end: along[to] },
                startAngle: angleBase,
                spent,
              }),
            // A region that trims the piece keeps that range's rings: it is not
            // a tolerance refusal, so the walk does not split around it.
            accept: (helix) => region === null
              || continuousPathInsideRegion(region, stock, helix.points, angleBase),
            emitHelix: (helix) => {
              const emitted = emitRotaryRuns(
                moves, here, [{ points: helix.points, atStart: true, atEnd: true }],
                safeZ, travelZ, previousEndedAtEnd, forceStep, pivot, followLink,
              )
              here = emitted.here
              previousEndedAtEnd = emitted.endedAtEnd
              angleBase += 360 * (helix.turns + 2)
            },
            emitRing,
            ...(hooks.shouldStop !== undefined ? { shouldStop: hooks.shouldStop } : {}),
          }, ring, band)
          if (walked.stopped) return { operationId, moves: [], warnings: [], bounds: null }
          ring = band + 1
          continue
        }
      }
      emitRing(ring)
      ring++
    }
  } else {
    for (let k = 0; k < angles.length; k++) {
      if (hooks.shouldStop?.()) return { operationId, moves: [], warnings: [], bounds: null }
      // A `NaN` sample has no model under the tool: the finish follows the model,
      // and removing waste is the rough's job, so it is not cut. Each pass is the
      // runs of finite samples; a pass with none emits nothing at all. #1096: a
      // sample outside the operation's region is not cut for the same reason.
      const cutsAt = (i: number): boolean => Number.isFinite(tipAt(k, i))
        && (insideRegion === null || insideRegion(alongAt(k, i), angles[k]))
      const runs: RotaryRun[] = []
      let i = 0
      while (i < along.length) {
        if (!cutsAt(i)) { i++; continue }
        const start = i
        while (i + 1 < along.length && cutsAt(i + 1)) i++
        const end = i
        const points: ToolpathPoint[] = []
        for (let j = start; j <= end; j++) points.push(point(alongAt(k, j), tipAt(k, j), angles[k]))
        runs.push({ points, atStart: start === 0, atEnd: end === along.length - 1 })
        i++
      }
      const emitted = emitRotaryRuns(moves, here, runs, safeZ, travelZ, previousEndedAtEnd, forceStep)
      here = emitted.here
      previousEndedAtEnd = emitted.endedAtEnd
    }
  }
  if (here) moves.push({ kind: 'rapid', from: here, to: { ...here, z: safeZ } })
  // An around pass's moves are straight on the controller in (along, A, Z), so
  // the merge may drop the interior points of a ring; along mode keeps the old
  // merge and its byte-identical output (#1045 slice G).
  const merged = mergeCollinearCuts(moves, tolerance, params.passDirection === 'around' ? pivot : undefined)
  return { operationId, moves: merged.moves, warnings, bounds: boundsOf(merged.moves) }
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

export interface RotaryRoughParams extends RotaryFinishParams {
  /** Radial depth of each layer. */
  readonly stepdown: number
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
  const layers = Math.ceil((maxRadius - lowest) / params.stepdown)
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
            && (insideRegion === null || insideRegion(along[i], angles[k]))
          if (!cuts) full = false
          samples.push(cuts ? point(along[i], Math.max(tip, layerRadius), angles[k]) : null)
        }
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
        if (layerRings[ringIndex].full) {
          let band = ringIndex
          while (band + 1 < along.length && layerRings[band + 1].full) band++
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
          && (insideRegion === null || insideRegion(along[indexAt(i)], angle))
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
  return {
    operationId,
    moves: merged.moves,
    warnings,
    bounds: boundsOf(merged.moves),
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

