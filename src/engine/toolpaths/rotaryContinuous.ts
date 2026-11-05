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
 * Continuous rotary finishing (#1103 slice ca-b): the forward helix.
 *
 * Around mode cuts one ring per along position and reverses A at every ring, so
 * A decelerates to a stop and turns back at each pass boundary (#1045). This
 * module builds the alternative for an **uninterrupted full-ring band** of a
 * **round** bar: a helix that turns A one way while it advances along the bar,
 * so A never stops or reverses.
 *
 * ## Shape
 *
 * The band `[band.start, band.end]` (the cutter-centre span -- one cutter radius
 * inside a retained end, exactly the span the ring grid covers) is cut by
 * `turns = ceil(length / stepover)` whole revolutions. The axial advance per
 * revolution, `pitch = length / turns`, is therefore **at most the requested
 * stepover**, and no thread is farther than one stepover from the next. A
 * **complete ring at each axial end** closes the triangular strips the helix
 * would otherwise leave at the band's two edges: the path opens with a full
 * turn at `band.start`, runs the helix, and closes with a full turn at
 * `band.end`. Commanded A is the same one-way rotation throughout and grows by
 * `360 * (turns + 2)` across the path; nothing is wrapped modulo 360 (#1091 --
 * the controller owns the A range).
 *
 * The path is one run of cut points from the first boundary ring's first point
 * to the last boundary ring's last point, in commanded order. The start ring's
 * last point **is** the helix's first point and the helix's last point **is**
 * the end ring's first point, so the rings and the helix are one continuous cut.
 *
 * The whole path is parameterised by the **path parameter** `u`, one unit per
 * revolution: `A = startAngle + 360 u`. `u` runs from 0 to `turns + 2`, the
 * start ring is `0 <= u <= 1`, the helix is `1 <= u <= turns + 1`, and the end
 * ring is `turns + 1 <= u <= turns + 2`. The along coordinate is a function of
 * `u`: it is `band.start` on the first ring, advances evenly over the helix and
 * is `band.end` on the last ring. Bisecting a segment is then just the midpoint
 * of `u`, which is what makes the ring legs and the helix one uniform path.
 *
 * ## Sampling
 *
 * A helix point is a **combined** pose: `(along, A)` advance together, and the
 * safe tip at that pose is not the tip of either neighbouring ring. Every point
 * is therefore sampled at its own `(along, A)` through the operation's sampler
 * and workspace (`sampleAnglesWithPrep` on a prep whose `along` list is the
 * row's own positions), never interpolated between ring positions. Poses are
 * grouped into rows by the fraction of a revolution they sit at, on one shared
 * integer phase grid: the helix crosses the same physical angle once per turn,
 * so one height map serves every turn's pose there -- one row per physical angle,
 * not one per pose.
 *
 * Between two samples the emitter commands one straight move in `(along, A, Z)`.
 * A pair is safe only while the surface between them does not stand more than
 * the operation's tolerance above that chord, so a segment whose sampled
 * midpoint does rise above it is bisected, exactly as the ring refinement
 * bisects an angular segment (#1045 slice E). The tolerance is the same one:
 * the 0.005 mm floor, or for a ball nose the between-sample error
 * `s^2 / (8 r)` at the segment's own surface distance, where a combined move's
 * distance is `hypot(axial, arc)` -- the two sagittas add, so the hypotenuse is
 * the right single spacing.
 *
 * ## Contracts
 *
 * - The first ring sits at `band.start` and the last at `band.end`; **no point
 *   lies outside the band**. The caller passes the cutter-centre span, so a
 *   retained end keeps its one-cutter-radius pull-in and a boundary ring can
 *   never walk into retained stock.
 * - A sample with no model under the tool (`NaN`) makes the band *uncovered*:
 *   the path is refused rather than cut through free air, and the caller keeps
 *   the ring path (which skips those samples).
 * - Cancellation (`shouldStop`) and the sample/row/round budgets are honoured; a
 *   budget that runs out -- a sampling limit, or a refinement that is still
 *   unresolved when its last round is spent -- reports `exhausted`, so the
 *   caller can fall back to forward-only rings for that band.
 * - Round bars, and (since #1103 slice ca-j) **square blanks on a band that has
 *   become round**. A square blank's corners are not a surface of revolution,
 *   so the square blank's own rules are supplied through
 *   {@link ContinuousHelixLayer.material} and
 *   {@link ContinuousHelixInput.stubFloor} and applied at every sampled pose: a
 *   pose the ring path skips as air, or floors off a retained end, refuses or
 *   lifts the pose. A band whose every ring is a whole ring under those rules --
 *   the corners already gone -- is helixed; any other keeps its rings.
 *
 * #1103 slice ca-c wires it into `generateRotaryFinish`: a maximal run of
 * fully-covered rings (and, when the operation has a region, a band whose every
 * segment the mask's boundary test proves) is emitted as one helix, and any band
 * the builder refuses keeps forward-only rings.
 *
 * Slice ca-d uses it for the around **rough**, one layer at a time: the caller
 * passes {@link ContinuousHelixLayer}, so every pose is clamped to the layer's
 * own depth (`max(tip, layer.radius)`, the clamp a ring sample takes) and a pose
 * with **no material standing at this layer** (`tip >= previousRadius`) refuses
 * the band -- the layer's rings skip such a sample, so a helix that kept going
 * would be cutting air the ring path does without, and the caller keeps rings.
 * The layer's gate is what the ring sample's `tip < previousRadius` is, so a
 * band the helix covers cuts exactly the material that layer's rings would.
 *
 * ## A band that cannot be verified everywhere is split, not refused (ca-g)
 *
 * A band is all-or-nothing above: one segment the refinement cannot bring inside
 * the surface tolerance refuses the whole band, and the caller cuts every ring
 * of it forward-only (busto-round's finish and its single-deep-layer rough: 29
 * unverifiable segments of 1706 turn a whole part's finish into rings, so A
 * stops at every link).
 *
 * {@link walkContinuousBand} is the alternative. When an attempt is refused
 * because segments are **still unresolved after the last refinement round** --
 * not because it was cancelled, not because the caller's region trims it, not
 * because a roughing pose has no material standing -- it reports the along spans
 * of those segments ({@link ContinuousHelix.failures}). The walk splits there:
 * the ring positions covering each failing span (plus the ring on each side, so
 * every helix piece begins and ends on a **complete** ring, the ca-b boundary
 * rule that keeps a triangular strip from standing uncut at a seam) become
 * forward-only rings, and each remaining run of at least two rings gets its own
 * helix attempt. An attempt may fail again, so the split recurses to
 * {@link MAX_HELIX_SPLIT_DEPTH}; past it, and once the band's shared work budget
 * ({@link ContinuousHelixBudget.work}, charged across every attempt of the band
 * through {@link ContinuousHelixInput.spent}) or the cancellation hook says so,
 * the remaining rings are cut as rings.
 *
 * Every link between a helix piece and the rings beside it is the caller's
 * existing one (#1093 surface-following on the finish, #1117 at-layer on the
 * rough) -- this module never invents a link. Commanded A still only grows: a
 * piece opens where the caller's A cursor stands, so the caller advances its
 * cursor by the piece's own turns.
 */

import { barCentre, barMaxRadius, barPivotZ } from '../../types/barStock'
import type { BarStock } from '../../types/project'
import { convertLength, type Units } from '../../utils/units'
import {
  AROUND_ANGLE_TOLERANCE_MM,
  MAX_ROTARY_SAMPLES,
  createRotarySamplingPrep,
  sampleAnglesWithPrep,
} from './rotarySampling'
import type { RotarySamplingPrep } from './rotarySampling'
import type { NormalizedTool, ToolpathPoint } from './types'
import type { ToolpathWarning } from './warningCodes'

/**
 * The axial span one helix covers, in the bar's along coordinate.
 *
 * It is the **cutter-centre** span: `rotaryModel.ts`'s `rotaryCutterSpan` pulls
 * each stubbed end one cutter radius inside the operation's band, and the ring
 * grid is drawn on that span. Passing the same span here is what keeps the
 * pull-in: the helix's two boundary rings sit exactly on it.
 */
export interface ContinuousHelixBand {
  readonly start: number
  readonly end: number
}

/**
 * The most sampling one helix may ask for. Both limits are counted over every
 * row the path samples, boundary rings and refinement rounds included:
 *
 * - `samples` is the number of `(along, A)` surface samples (row lengths
 *   summed), the same unit as `MAX_ROTARY_SAMPLES`;
 * - `rows` is the number of height maps, which is the cost a sample count
 *   cannot see when a row is short;
 * - `work` is the candidate triangles every row's raster pass visits (see
 *   {@link MAX_HELIX_RASTER_WORK}). A row count alone cannot price an attempt:
 *   a row visits a few hundred candidate triangles on the small fixtures and
 *   ~96 000 on a fine organic surface, so the same 300-row attempt can cost a
 *   second or a minute. This is the limit that keeps a **refused** attempt
 *   cheap, and it is counted only for rows that actually rasterise a map, so a
 *   row served from the workspace's angle-map cache is free;
 * - `rounds` is the bisection limit, matching the ring refinement's eight. A
 *   path that is still unresolved when the last round is spent is `exhausted`,
 *   because its refinement can go no finer on the phase grid this budget builds.
 *
 * Over any of the four limits the result is `exhausted` and carries no points,
 * so the caller falls back to rings for the whole band rather than emitting
 * half a helix or an unverified move.
 */
export interface ContinuousHelixBudget {
  readonly samples: number
  readonly rows: number
  readonly work: number
  readonly rounds: number
}

/**
 * The depth of one roughing layer (#1103 slice ca-d).
 *
 * A rough cuts a layer at a time, and a layer's ring samples are the model
 * clamped up to the layer's radius and cut only where material still stands
 * below the layer above (`tip < previousRadius`; a sample at or above it is
 * air the layer skips). A rough helix takes exactly the same two rules, so it
 * removes the same material the rings would over the band it covers:
 *
 * - `radius` is the layer's own radius; every sampled pose is floored there, so
 *   the helix can never dive to the model through the layer (the ring clamp);
 * - `previousRadius` is what the layer above cut to. A pose whose model stands
 *   at or above it has no material for this layer, which makes the band **not
 *   uninterrupted** (`ineligible`), and the caller keeps rings so its air skip
 *   stays exactly as it was.
 */
export interface ContinuousHelixLayer {
  readonly radius: number
  readonly previousRadius: number
  /**
   * The square blank's material-touch gate at the layer's own radius (#1103
   * slice ca-j), or absent on a round bar.
   *
   * A square blank stands material out to its corners while a flat is only half
   * the side, so a layer above the material at some angle is air there and the
   * ring path skips that sample (`squareRotaryTouchRadius`, `rotaryModel`). A
   * `false` answer makes the band **not uninterrupted** exactly as a pose with
   * no material under it does (`ineligible`), so the caller keeps the rings and
   * its air skip is never relaxed. The helix asks it at every sampled pose, on
   * its own finer angle grid, rather than trusting the ring grid's angles.
   */
  readonly material?: (angleDeg: number) => boolean
}

/**
 * The along span of one stretch of a band whose helix segments could not be
 * verified (#1103 slice ca-g).
 *
 * It is the `along` range covered by a segment that was **still unresolved when
 * the last refinement round was spent**. {@link walkContinuousBand} turns that
 * span into the ring positions to cut as forward-only rings; the helix never
 * cuts there on the strength of a move whose between-sample error was never
 * confirmed.
 */
export interface ContinuousHelixFailure {
  readonly start: number
  readonly end: number
}

/**
 * The work earlier attempts of the same band already spent (#1103 slice ca-g).
 *
 * {@link walkContinuousBand} hands this to every attempt it makes, so one band's
 * splits -- and the attempts inside those splits -- share a single
 * {@link ContinuousHelixBudget} instead of each getting a fresh one. Without it
 * a refusal that splits into a dozen sub-bands would spend a dozen times the
 * speculative work the ca-e cap exists to bound.
 */
export interface ContinuousHelixSpend {
  readonly samples: number
  readonly rows: number
  readonly work: number
}

/** Nothing spent yet: the seed for a band's first attempt. */
export const ZERO_HELIX_SPEND: ContinuousHelixSpend = { samples: 0, rows: 0, work: 0 }

/**
 * The most times one refused band may be split before the rest is cut as rings
 * (#1103 slice ca-g).
 *
 * Each split marks at least the two rings bracketing a failing span, so every
 * recursion is on a strictly shorter band and terminates on its own; this cap is
 * the second bound, for a surface whose failures keep landing in the same place
 * and would otherwise pay an attempt per ring.
 */
export const MAX_HELIX_SPLIT_DEPTH = 3

/** The most angle rows (height maps) one helix may build. */
export const MAX_HELIX_ROWS = 65_536

/**
 * The most candidate triangles one helix attempt may rasterise (#1103 ca-e
 * correction round 2).
 *
 * A helix is an optimisation over the rings: when its refinement cannot verify
 * a band, the caller keeps the rings it already sampled and the attempt's work
 * is spent to prove a refusal. On a fine mesh that proof is not cheap -- one
 * height-map row visits every triangle the strip plan's buckets select, which on
 * the `busto-round` finish is ~96 000 candidates per row, so a 4.4-rowset
 * attempt costs ~171 M triangle passes (~13 s of the measured run). The ring
 * pass that the band falls back to stays whatever it was; this cap bounds only
 * the speculative addition.
 *
 * The value is a **work** count, not a time: the same attempt obeys the same
 * limit on any machine. 24 M is about 2 s of raster at the ~80 ns per candidate
 * the measured machine takes, and it is ~160x the largest attempt the committed
 * suites make (150 k candidate triangles, measured on the chiral finish
 * fixtures), so a helix that can verify its band is not refused for cost. What it refuses is the
 * speculation that would spend seconds re-rasterising angles the ring grid has
 * already proved this surface cannot resolve; a mesh fine enough that even its
 * base rowset passes the cap forgoes the helix and keeps those rings, exactly
 * as an exhausted refinement does.
 */
export const MAX_HELIX_RASTER_WORK = 24_000_000

/** The bisection rounds, matching the around grid's refinement (#1045 slice E). */
export const MAX_HELIX_REFINEMENT_ROUNDS = 8

/** The default budget: the operation's existing sample cap and the limits above. */
export const DEFAULT_CONTINUOUS_HELIX_BUDGET: ContinuousHelixBudget = {
  samples: MAX_ROTARY_SAMPLES,
  rows: MAX_HELIX_ROWS,
  work: MAX_HELIX_RASTER_WORK,
  rounds: MAX_HELIX_REFINEMENT_ROUNDS,
}

export interface ContinuousHelixInput {
  /**
   * The operation's sampling prep: its mesh, stock-to-leave-enlarged tool,
   * requested cell size, retained-wall metadata and the workspace that is
   * shared with the ring grid. Only those operation-wide fields are read; the
   * helix supplies its own along lists, so each angle row can hold the exact
   * positions that angle is visited at.
   */
  readonly prep: RotarySamplingPrep
  /** The real cutter: the refinement tolerance and the ball radius are its measure. */
  readonly tool: NormalizedTool
  /** The band to cover; see {@link ContinuousHelixBand}. */
  readonly band: ContinuousHelixBand
  /** The requested stepover: the largest axial advance one revolution may make. */
  readonly stepover: number
  /** The requested between-sample spacing, on the blank's surface. */
  readonly sampleSpacing: number
  /** Material left on the model, added back to every sampled tip. */
  readonly stockToLeave: number
  /**
   * The roughing layer to cut (#1103 slice ca-d); absent for a finish, whose
   * path cuts to the model itself. See {@link ContinuousHelixLayer}.
   */
  readonly layer?: ContinuousHelixLayer
  /**
   * The square blank's retained-stub contact floor at one pose (#1103 slice
   * ca-j), or absent on a round bar and on a square blank with no retained end.
   *
   * The ring path floors every one of its `(angle, along)` samples at this
   * closed form (`squareRotaryStubContactFloor`, applied by
   * `completeRotaryTargets`): the cutter's side must never enter the retained
   * square stock beyond a cut range's ends. The helix samples its own, finer
   * poses -- angles no ring row visits and along positions no ring sits on -- so
   * it asks the same form directly at each of them, and a pose is never lower
   * than the ring path would allow there. It is a **floor**: a value at or below
   * the pose does not move it.
   */
  readonly stubFloor?: (along: number, angleDeg: number) => number
  /** The commanded A of the first boundary ring's first point. Default 0. */
  readonly startAngle?: number
  /** The operation's warnings; the sampler's height-map warnings are merged here. */
  readonly warnings: ToolpathWarning[]
  readonly shouldStop?: () => boolean
  readonly budget?: Partial<ContinuousHelixBudget>
  /**
   * The work earlier attempts of this band already spent (#1103 slice ca-g).
   * Every budget check adds it, so the attempts a split makes share one cap.
   * Absent on a first attempt; {@link walkContinuousBand} supplies it.
   */
  readonly spent?: ContinuousHelixSpend
}

export interface ContinuousHelix {
  /**
   * The cut points, in commanded order: the start boundary ring, the helix and
   * the end boundary ring as one run. Empty when the band is not usable.
   */
  readonly points: readonly ToolpathPoint[]
  /** Whole revolutions of the helix. */
  readonly turns: number
  /** The axial advance per revolution; never more than the requested stepover. */
  readonly pitch: number
  /** `(along, A)` surface samples taken, boundary rings and refinement included. */
  readonly samples: number
  /** Angle rows (height maps) sampled. */
  readonly rows: number
  /**
   * Candidate triangles the built rows rasterised (#1103 ca-e correction round
   * 2): the work the attempt actually spent. A row served from the angle-map
   * cache costs nothing and adds 0, so this is the figure
   * {@link ContinuousHelixBudget.work} bounds.
   */
  readonly rasterWork: number
  /**
   * Angle rows whose height map was already in the operation's workspace at
   * this physical angle (#1103 ca-e): the row was read, not rasterised. The row
   * count above still charges every row, so the budgets are unchanged.
   */
  readonly reusedRows: number
  /** A budget ran out: the caller keeps rings for this band. */
  readonly exhausted: boolean
  /** The operation was cancelled: the caller emits no motion. */
  readonly stopped: boolean
  /** A sampled pose had no model under the tool: the caller keeps rings. */
  readonly uncovered: boolean
  /**
   * A roughing pose had no material standing at this layer (#1103 slice ca-d):
   * its model is at or above what the layer above cut to, so the ring path
   * skips it and would cut air the helix cannot -- the caller keeps rings.
   */
  readonly ineligible: boolean
  /**
   * The along spans whose segments were still unresolved when the last
   * refinement round was spent (#1103 slice ca-g), merged and in path order.
   * Non-empty exactly when the refusal is a **tolerance** one -- `points` is
   * empty and the caller may split the band at these spans instead of cutting
   * all of it as rings ({@link walkContinuousBand}). Every other refusal (a
   * budget, cancellation, no model, no material at this layer, a case this
   * module does not cover) leaves it empty, because there is nothing to split
   * around.
   */
  readonly failures: readonly ContinuousHelixFailure[]
}

/**
 * One pose of the path, in path order.
 *
 * `u` is the path parameter: `A = startAngle + 360 u`, one unit per revolution.
 * Every pose's `along` and `angle` are functions of `u`, so a bisection midpoint
 * is the midpoint of `u`.
 */
interface HelixNode {
  readonly u: number
  readonly along: number
  readonly angle: number
  /** Pivot-relative tip radius, or `NaN` before it is sampled. */
  tip: number
}

/** One height-map row's positions: every pose at one fraction of a revolution. */
interface HelixRow {
  /** The row's place on the shared integer phase grid. */
  readonly phase: number
  readonly along: number[]
  /** `along` value -> index into `along`; the same value is one sample. */
  readonly index: Map<number, number>
  /** The sampled row, once it has been read: the effective cut height per pose. */
  tips?: Float32Array
  /**
   * A pose on this row has no material standing at the roughing layer this
   * helix cuts (#1103 slice ca-d), so the band is not uninterrupted.
   */
  ineligible?: boolean
}

/** A straight move between two neighbouring poses and its one bisection. */
interface HelixSegment {
  readonly left: HelixNode
  readonly right: HelixNode
  mid?: HelixNode
  checked: boolean
}

/** Sampling progress, shared by the initial grid and every refinement round. */
interface HelixSampling {
  samples: number
  rows: number
  reused: number
  /** Candidate triangles the built rows rasterised; a reused row adds nothing. */
  work: number
}

/** What a sampling/budget step decided. */
type HelixStatus = 'ok' | 'stopped' | 'exhausted' | 'ineligible' | 'unresolved'

/**
 * The between-sample tolerance of one helix segment, in the operation's units.
 *
 * This is the around rule `aroundSegmentationTolerance` applies to an angular
 * segment, generalised to a move that turns and advances at once: the same
 * 0.005 mm floor, and for a ball the along path's `s^2 / (8 r)` at the segment's
 * own surface distance. That distance is `hypot(axial, arc)` because the two
 * between-sample errors add -- a chord over a combined move loses the axial
 * sagitta and the angular one at the same point, so their squares sum.
 */
function helixTolerance(
  tipA: number,
  tipB: number,
  axialDistance: number,
  deltaDegrees: number,
  tool: NormalizedTool,
  units: Units,
): number {
  const floor = convertLength(AROUND_ANGLE_TOLERANCE_MM, 'mm', units)
  if (tool.type !== 'ball_endmill') return floor
  const radius = Math.max(0, Math.min(tipA, tipB))
  const arc = radius * Math.abs(deltaDegrees) * Math.PI / 180
  const spacing = Math.hypot(axialDistance, arc)
  return Math.max(floor, (spacing * spacing) / (8 * tool.radius))
}

/** The revolutions per turn, from the same cap `aroundGrid` applies to a ring. */
function angularIntervals(stock: BarStock, sampleSpacing: number, units: Units): number | null {
  const radius = barMaxRadius(stock)
  if (!(radius > 0) || !Number.isFinite(radius)) return null
  const tolerance = convertLength(AROUND_ANGLE_TOLERANCE_MM, 'mm', units)
  const cap = Math.sqrt(8 * radius * tolerance)
  const step = Number.isFinite(cap) && cap > 0 ? Math.min(sampleSpacing, cap) : sampleSpacing
  const intervals = Math.ceil((2 * Math.PI * radius) / Math.max(step, 1e-9))
  if (!Number.isFinite(intervals) || intervals < 1 || intervals > MAX_ROTARY_SAMPLES) return null
  return Math.max(1, intervals)
}

/** Where along the bar the path parameter `u` sits. */
function alongAtU(band: ContinuousHelixBand, turns: number, u: number): number {
  if (u <= 1) return band.start
  if (u >= 1 + turns) return band.end
  return band.start + (band.end - band.start) * ((u - 1) / turns)
}

/** The commanded A of path parameter `u`. */
function angleAtU(startAngle: number, u: number): number {
  return startAngle + 360 * u
}

/** A pose at path parameter `u`, with its along and A derived from it. */
function nodeAtU(band: ContinuousHelixBand, turns: number, startAngle: number, u: number): HelixNode {
  return { u, along: alongAtU(band, turns, u), angle: angleAtU(startAngle, u), tip: NaN }
}

/**
 * The path's initial poses: the start boundary ring (without the point that is
 * the helix's first), every helix knot, and the end boundary ring (without the
 * point that is the helix's last). The three pieces share the `u` grid, so a
 * pose and the same pose a turn later land on the same sampling row.
 */
function initialNodes(
  band: ContinuousHelixBand,
  turns: number,
  intervals: number,
  startAngle: number,
): HelixNode[] {
  const nodes: HelixNode[] = []
  for (let k = 0; k < intervals; k++) nodes.push(nodeAtU(band, turns, startAngle, k / intervals))
  for (let q = 0; q <= turns * intervals; q++) nodes.push(nodeAtU(band, turns, startAngle, 1 + q / intervals))
  for (let k = 1; k <= intervals; k++) nodes.push(nodeAtU(band, turns, startAngle, 1 + turns + k / intervals))
  return nodes
}

/**
 * The pose's place on the shared integer phase grid. Every `u` the path
 * constructs is a multiple of `1 / phaseScale`, so the grid is exact and the
 * same fraction of a revolution is the same key in every turn -- which is what
 * lets one height map serve all of them.
 */
function phaseKey(u: number, phaseScale: number): number {
  return ((Math.round(u * phaseScale) % phaseScale) + phaseScale) % phaseScale
}

/** Group poses into one row per fraction of a revolution, in first-seen order. */
function helixRows(nodes: readonly HelixNode[], phaseScale: number): HelixRow[] {
  const byPhase = new Map<number, HelixRow>()
  const rows: HelixRow[] = []
  for (const node of nodes) {
    const phase = phaseKey(node.u, phaseScale)
    let row = byPhase.get(phase)
    if (row === undefined) {
      row = { phase, along: [], index: new Map() }
      byPhase.set(phase, row)
      rows.push(row)
    }
    if (!row.index.has(node.along)) {
      row.index.set(node.along, row.along.length)
      row.along.push(node.along)
    }
  }
  return rows
}

/** The physical (one-turn) angle of a row, in `[0, 360)`. */
function rowAngle(startAngle: number, row: HelixRow, phaseScale: number): number {
  return (((startAngle + (360 * row.phase) / phaseScale) % 360) + 360) % 360
}

/**
 * Sample every row at its own poses, charging the sample and row budgets.
 *
 * Each row is one batch through the operation's sampler: a prep built on the
 * same mesh, tool, cell size, retained-wall metadata and workspace, with the
 * row's own `along` list. The workspace is shared, so the cross-section, strip
 * plan and raster geometry are paid once for the whole helix, exactly as they
 * are for the ring grid.
 */
function sampleHelixRows(
  rows: readonly HelixRow[],
  input: ContinuousHelixInput,
  phaseScale: number,
  sampling: HelixSampling,
  budget: ContinuousHelixBudget,
): HelixStatus {
  const prep = input.prep
  const startAngle = input.startAngle ?? 0
  const maxRadius = barMaxRadius(prep.stock)
  const stubFloor = input.stubFloor
  const spent = input.spent ?? ZERO_HELIX_SPEND
  for (const row of rows) {
    if (input.shouldStop?.() === true) return 'stopped'
    if (spent.rows + sampling.rows + 1 > budget.rows) return 'exhausted'
    if (spent.samples + sampling.samples + row.along.length > budget.samples) return 'exhausted'
    // #1103 ca-e correction round 2: the raster work is charged after the row
    // (it is only known once the map is built), so the check is here, before the
    // next one. A refused attempt may overshoot by its last row, never by a round.
    // #1103 slice ca-g: `spent` is what the band's earlier attempts already used,
    // so a split cannot spend the cap again per piece.
    if (spent.work + sampling.work > budget.work) return 'exhausted'
    // The row is one physical angle: its poses differ only in along.
    const angle = rowAngle(startAngle, row, phaseScale)
    const rowPrep = createRotarySamplingPrep(prep.mesh, prep.stock, prep.tool, {
      along: row.along,
      requestedCellSize: prep.requestedCellSize,
      conservativeCellBounds: true,
      ...(prep.wallTriangleStart !== undefined ? { wallTriangleStart: prep.wallTriangleStart } : {}),
      ...(prep.gridExtra !== undefined ? { gridExtra: prep.gridExtra } : {}),
      workspace: prep.workspace,
      // #1103 ca-e: the ring grid has just rasterised the same physical angles
      // on this workspace; read those maps instead of building a second set.
      ...(prep.angleMaps === 'off' ? {} : { angleMaps: 'read-write' as const }),
    })
    const sampled = sampleAnglesWithPrep(
      rowPrep,
      [angle],
      input.warnings,
      input.shouldStop ? { shouldStop: input.shouldStop } : {},
    )
    if (!sampled.valid) return 'exhausted'
    if (sampled.stopped) return 'stopped'
    sampling.reused += sampled.reused
    sampling.work += sampled.rasterWork
    // The row arrives lifted by the angle's conservative cell rise, exactly as
    // the ring grid reads it; every finite value takes the operation's stock
    // offset and the clamp the ring path applies (`completeRotaryTargets`).
    // A roughing layer (#1103 slice ca-d) adds the two rules the ring sample
    // takes there: a pose with no material standing (`tip >= previousRadius`)
    // is air this layer skips, which makes the band not uninterrupted, and a
    // pose that does cut is floored at the layer's radius so the helix never
    // dives through the layer to the model. On a **square blank** (#1103 slice
    // ca-j) the layer also carries the ring path's material-touch gate, and the
    // pose then takes the retained-stub contact floor the ring sample takes --
    // at the pose's own along and angle, not only at a ring position.
    const layer = input.layer
    const raw = sampled.tipRadius[0]
    const tips = new Float32Array(raw.length)
    let ineligible = false
    for (let i = 0; i < raw.length; i++) {
      if (!Number.isFinite(raw[i])) {
        tips[i] = NaN
        continue
      }
      let tip = Math.min(Math.max(raw[i] + input.stockToLeave, 0), maxRadius)
      if (layer !== undefined) {
        if (!(tip < layer.previousRadius)) {
          ineligible = true
          continue
        }
        if (layer.material !== undefined && !layer.material(angle)) {
          ineligible = true
          continue
        }
        tip = Math.max(tip, layer.radius)
      }
      if (stubFloor !== undefined) {
        const floor = stubFloor(row.along[i], angle)
        if (floor > tip) tip = floor
      }
      tips[i] = tip
    }
    row.tips = tips
    row.ineligible = ineligible
    sampling.samples += row.along.length
    sampling.rows++
    if (ineligible) return 'ineligible'
  }
  return 'ok'
}

/** Put each pose's sampled tip on the pose, or `NaN` when it has no row. */
function assignTips(nodes: readonly HelixNode[], rows: readonly HelixRow[], phaseScale: number): void {
  const byPhase = new Map<number, HelixRow>()
  for (const row of rows) byPhase.set(row.phase, row)
  for (const node of nodes) {
    const row = byPhase.get(phaseKey(node.u, phaseScale))
    const index = row?.index.get(node.along)
    const tips = row?.tips
    node.tip = index === undefined || tips === undefined ? NaN : tips[index]
  }
}

/**
 * Bisect every segment whose sampled midpoint stands more than its tolerance
 * above the straight move between its ends.
 *
 * A segment that passes is not revisited: its endpoints and its own midpoint
 * decide it, and none of those move when a neighbouring segment is split. A
 * split replaces the segment with two unchecked children, so each round refines
 * only what is still too coarse -- the same bisection the around grid runs, over
 * the path instead of over an angle step.
 *
 * Returns `uncovered` if a sampled pose has no model under the tool. A path
 * whose refinement is still unresolved when the round limit is spent is
 * **`unresolved`, never `ok`**: every round halves the segment again, so a chain
 * that still holds an unchecked segment is a move whose between-sample error was
 * never confirmed, and emitting it would cut below the operation's tolerance.
 * The caller's fallback to rings is then the same one the sampling budgets use.
 * #1103 slice ca-g keeps the answer `unresolved` distinct from `exhausted` and
 * reports **where** those segments are ({@link ContinuousHelixFailure}), so the
 * caller can cut rings there and helix the rest of the band instead of giving
 * the whole band up. Cancellation, a spent budget and a pose with no model stay
 * whole-band refusals: there is nothing to split around them.
 */
function refineHelix(
  chain: readonly HelixSegment[],
  input: ContinuousHelixInput,
  turns: number,
  phaseScale: number,
  sampling: HelixSampling,
  budget: ContinuousHelixBudget,
): { status: HelixStatus; uncovered: boolean; chain: HelixSegment[] } {
  let current = [...chain]
  for (let round = 0; round < budget.rounds; round++) {
    const pending = current.filter((segment) => !segment.checked)
    if (pending.length === 0) return { status: 'ok', uncovered: false, chain: current }
    for (const segment of pending) {
      segment.mid = nodeAtU(input.band, turns, input.startAngle ?? 0, (segment.left.u + segment.right.u) / 2)
    }
    const mids = pending.map((segment) => segment.mid!)
    const rows = helixRows(mids, phaseScale)
    const status = sampleHelixRows(rows, input, phaseScale, sampling, budget)
    if (status !== 'ok') return { status, uncovered: false, chain: current }
    assignTips(mids, rows, phaseScale)
    const next: HelixSegment[] = []
    let uncovered = false
    for (const segment of current) {
      if (segment.checked) {
        next.push(segment)
        continue
      }
      const mid = segment.mid!
      if (!Number.isFinite(mid.tip)) {
        uncovered = true
        next.push(segment)
        continue
      }
      const tolerance = helixTolerance(
        segment.left.tip,
        segment.right.tip,
        Math.abs(segment.right.along - segment.left.along),
        segment.right.angle - segment.left.angle,
        input.tool,
        input.tool.units,
      )
      if (mid.tip - (segment.left.tip + segment.right.tip) / 2 > tolerance) {
        next.push({ left: segment.left, right: mid, checked: false })
        next.push({ left: mid, right: segment.right, checked: false })
      } else {
        next.push({ left: segment.left, right: segment.right, checked: true, mid })
      }
    }
    if (uncovered) return { status: 'ok', uncovered: true, chain: current }
    current = next
  }
  // Every round is spent. A chain that still holds an unchecked segment was
  // still splitting -- its last round created children that no later round
  // measured -- so the path it would produce is unresolved, not safe. The phase
  // grid has no finer step than this budget allows, so those segments are
  // reported (**`unresolved`**) with no points, and the caller either splits the
  // band around them or keeps its rings.
  const unresolved = current.filter((segment) => !segment.checked)
  if (unresolved.length > 0) {
    return { status: 'unresolved', uncovered: false, chain: current }
  }
  return { status: 'ok', uncovered: false, chain: current }
}

/**
 * The along spans a refused refinement could not verify, merged in path order.
 *
 * An unchecked segment's own ends bracket the stretch of the bar its straight
 * move would have cut, and adjacent unchecked segments overlap or touch, so the
 * caller gets a short list of disjoint spans rather than one per segment.
 */
function unresolvedSpans(chain: readonly HelixSegment[]): ContinuousHelixFailure[] {
  const spans: { start: number; end: number }[] = []
  for (const segment of chain) {
    if (segment.checked) continue
    const start = Math.min(segment.left.along, segment.right.along)
    const end = Math.max(segment.left.along, segment.right.along)
    const last = spans[spans.length - 1]
    if (last !== undefined && start <= last.end + 1e-9) {
      if (end > last.end) last.end = end
      continue
    }
    spans.push({ start, end })
  }
  return spans.sort((a, b) => a.start - b.start)
}

/** A refused/empty result carrying the work already done. */
function emptyHelix(
  turns: number,
  pitch: number,
  sampling: HelixSampling,
  flags: Partial<Pick<ContinuousHelix, 'exhausted' | 'stopped' | 'uncovered' | 'ineligible'>>,
  failures: readonly ContinuousHelixFailure[] = [],
): ContinuousHelix {
  return {
    points: [],
    turns,
    pitch,
    samples: sampling.samples,
    rows: sampling.rows,
    rasterWork: sampling.work,
    reusedRows: sampling.reused,
    exhausted: flags.exhausted === true,
    stopped: flags.stopped === true,
    uncovered: flags.uncovered === true,
    ineligible: flags.ineligible === true,
    failures,
  }
}

/**
 * Build a forward helix over one band, or `null` when the band is not a case
 * this module covers (a degenerate band, a missing operation precondition). A
 * non-null result with `exhausted`, `stopped` or `uncovered` set carries no
 * points; see {@link ContinuousHelix}.
 */
export function buildContinuousHelix(input: ContinuousHelixInput): ContinuousHelix | null {
  const { prep, band, stockToLeave } = input
  const stock = prep.stock
  // A **square blank** is admitted since #1103 slice ca-j, but only on the same
  // terms as a round one: the caller walks bands whose every ring is a whole
  // ring (material at every angle under the blank's touch gate, `tip <
  // previousRadius`, one run), and each sampled pose below re-checks that gate
  // and takes the retained-stub contact floor at its own along and angle. A
  // band whose corners are still standing therefore never reaches here, and a
  // pose the ring path would skip or lift keeps the caller's rings.
  //
  // Around mode samples with the conservative cell rise; without it the path
  // would be less safe than the ring grid it replaces.
  if (!prep.conservativeCellBounds) return null
  if (!Number.isFinite(input.stepover) || !(input.stepover > 0)) return null
  if (!Number.isFinite(input.sampleSpacing) || !(input.sampleSpacing > 0)) return null
  if (!Number.isFinite(band.start) || !Number.isFinite(band.end) || !(band.end > band.start)) return null
  if (!Number.isFinite(stockToLeave) || stockToLeave < 0) return null
  const startAngle = input.startAngle ?? 0
  if (!Number.isFinite(startAngle)) return null
  if (!(input.tool.radius > 0) || !Number.isFinite(input.tool.radius)) return null
  const intervals = angularIntervals(stock, input.sampleSpacing, input.tool.units)
  if (intervals === null) return null
  const budget: ContinuousHelixBudget = {
    samples: input.budget?.samples ?? DEFAULT_CONTINUOUS_HELIX_BUDGET.samples,
    rows: input.budget?.rows ?? DEFAULT_CONTINUOUS_HELIX_BUDGET.rows,
    work: input.budget?.work ?? DEFAULT_CONTINUOUS_HELIX_BUDGET.work,
    rounds: input.budget?.rounds ?? DEFAULT_CONTINUOUS_HELIX_BUDGET.rounds,
  }
  if (!Number.isFinite(budget.samples) || budget.samples < 0) return null
  if (!Number.isFinite(budget.rows) || budget.rows < 0) return null
  if (!Number.isFinite(budget.work) || budget.work < 0) return null
  if (!Number.isSafeInteger(budget.rounds) || budget.rounds < 0 || budget.rounds > 30) return null
  const phaseScale = intervals * 2 ** budget.rounds
  if (!Number.isSafeInteger(phaseScale)) return null
  const length = band.end - band.start
  const turns = Math.max(1, Math.ceil(length / input.stepover))
  if (!Number.isFinite(turns) || turns < 1 || turns > MAX_ROTARY_SAMPLES) return null
  const pitch = length / turns
  const sampling: HelixSampling = { samples: 0, rows: 0, reused: 0, work: 0 }
  const spent = input.spent ?? ZERO_HELIX_SPEND
  // Refuse before allocating the grid when the initial poses alone are over
  // budget: `intervals x (turns + 2)` is the whole first pass.
  if (spent.samples + intervals * (turns + 2) > budget.samples
    || spent.rows + intervals > budget.rows
    || spent.work > budget.work) {
    return emptyHelix(turns, pitch, sampling, { exhausted: true })
  }
  const nodes = initialNodes(band, turns, intervals, startAngle)
  const rows = helixRows(nodes, phaseScale)
  const initial = sampleHelixRows(rows, input, phaseScale, sampling, budget)
  if (initial === 'stopped') return emptyHelix(turns, pitch, sampling, { stopped: true })
  if (initial === 'exhausted') return emptyHelix(turns, pitch, sampling, { exhausted: true })
  if (initial === 'ineligible') return emptyHelix(turns, pitch, sampling, { ineligible: true })
  assignTips(nodes, rows, phaseScale)
  if (nodes.some((node) => !Number.isFinite(node.tip))) {
    return emptyHelix(turns, pitch, sampling, { uncovered: true })
  }
  const chain: HelixSegment[] = []
  for (let i = 0; i + 1 < nodes.length; i++) {
    chain.push({ left: nodes[i], right: nodes[i + 1], checked: false })
  }
  const refined = refineHelix(chain, input, turns, phaseScale, sampling, budget)
  if (refined.status === 'stopped') return emptyHelix(turns, pitch, sampling, { stopped: true })
  if (refined.status === 'exhausted') return emptyHelix(turns, pitch, sampling, { exhausted: true })
  if (refined.status === 'ineligible') return emptyHelix(turns, pitch, sampling, { ineligible: true })
  if (refined.status === 'unresolved') {
    return emptyHelix(turns, pitch, sampling, {}, unresolvedSpans(refined.chain))
  }
  if (refined.uncovered) return emptyHelix(turns, pitch, sampling, { uncovered: true })
  const path: HelixNode[] = [refined.chain[0].left]
  for (const segment of refined.chain) path.push(segment.right)
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const points = path.map((node): ToolpathPoint => stock.axis === 'x'
    ? { x: node.along, y: centre, z: pivot + node.tip, a: node.angle }
    : { x: centre, y: node.along, z: pivot + node.tip, a: node.angle })
  return {
    points,
    turns,
    pitch,
    samples: sampling.samples,
    rows: sampling.rows,
    rasterWork: sampling.work,
    reusedRows: sampling.reused,
    exhausted: false,
    stopped: false,
    uncovered: false,
    ineligible: false,
    failures: [],
  }
}

/**
 * The ring positions a set of failing along spans covers (#1103 slice ca-g).
 *
 * A span is bracketed by the ring grid's own positions: `lo` is the last ring at
 * or before the span's start and `hi` is the first ring at or after its end, and
 * every ring between them is marked. Marking both brackets and not only the
 * rings strictly inside the span is what keeps the **ca-b boundary rule** at a
 * seam: a failing segment narrower than one ring interval would otherwise mark
 * no ring at all and the split would make no progress, and a sub-band's helix
 * would be bounded by a ring the failing motion had already crossed. With the
 * bracket marked, every helix piece opens and closes on a **complete** ring that
 * the ring path itself cuts, so no triangular strip is left standing between a
 * piece and the rings beside it.
 */
function failingRings(
  failures: readonly ContinuousHelixFailure[],
  along: readonly number[],
  fromRing: number,
  toRing: number,
): Set<number> {
  const marked = new Set<number>()
  for (const failure of failures) {
    let lo = fromRing
    for (let k = fromRing; k <= toRing; k++) if (along[k] <= failure.start + 1e-9) lo = k
    let hi = toRing
    for (let k = toRing; k >= fromRing; k--) if (along[k] >= failure.end - 1e-9) hi = k
    for (let k = lo; k <= hi; k++) marked.add(k)
  }
  return marked
}

/**
 * One caller's account of what to do with a band (#1103 slice ca-g).
 *
 * The callbacks are the caller's own emitters, so the A cursor, the ring
 * bookkeeping and every link stay exactly where they already live: this walk
 * decides only *which* rings become helices and which are cut as rings, and the
 * caller advances its cursor as it emits.
 */
export interface ContinuousBandVisit {
  /** The ring grid's along positions, in increasing order. */
  readonly along: readonly number[]
  /**
   * Build one helix over the ring range, charging the band's shared spend.
   * `null` means the case is not this module's (a degenerate band, or a
   * precondition the caller's prep does not meet): the whole range is cut as
   * rings and nothing is split.
   */
  readonly attempt: (fromRing: number, toRing: number, spent: ContinuousHelixSpend) => ContinuousHelix | null
  /**
   * Whether the caller will cut this verified helix -- the region test, in
   * practice. `false` keeps that range's rings, and is **not** a tolerance
   * refusal, so the walk does not split there.
   */
  readonly accept?: (helix: ContinuousHelix) => boolean
  /** Emit a verified helix; the caller advances its A cursor. */
  readonly emitHelix: (helix: ContinuousHelix) => void
  /** Emit one forward-only ring at its index. */
  readonly emitRing: (ring: number) => void
  readonly shouldStop?: () => boolean
  /** The split cap for **this** band; {@link MAX_HELIX_SPLIT_DEPTH} by default. */
  readonly maxDepth?: number
  /** Work an earlier band already spent, if the caller shares one cap across bands. */
  readonly spent?: ContinuousHelixSpend
}

export interface ContinuousBandResult {
  /** The operation was cancelled while walking: the caller emits no motion. */
  readonly stopped: boolean
  /** The band's spend after every attempt, splits included. */
  readonly spent: ContinuousHelixSpend
}

/**
 * Cut one ring band as helices where they verify and forward-only rings where
 * they do not (#1103 slice ca-g).
 *
 * The band is attempted as one helix. A verified helix is emitted and the walk
 * ends. A refusal with **failing spans** (a tolerance refusal -- see
 * {@link ContinuousHelix.failures}) is split: the rings covering each span are
 * cut as rings, every remaining run of two or more rings is attempted as its own
 * helix, and the split recurses up to `maxDepth`. Any other refusal -- a spent
 * budget, cancellation, no model under the tool, no material at a roughing
 * layer, a case this module does not cover, the caller's region -- keeps that
 * range's rings, so nothing here can relax a rule the caller relies on.
 */
export function walkContinuousBand(
  visit: ContinuousBandVisit,
  fromRing: number,
  toRing: number,
): ContinuousBandResult {
  const { along } = visit
  const maxDepth = visit.maxDepth ?? MAX_HELIX_SPLIT_DEPTH
  const spend = {
    samples: visit.spent?.samples ?? 0,
    rows: visit.spent?.rows ?? 0,
    work: visit.spent?.work ?? 0,
  }
  let stopped = false

  const rings = (from: number, to: number): void => {
    for (let k = from; k <= to; k++) {
      if (visit.shouldStop?.() === true) { stopped = true; return }
      visit.emitRing(k)
    }
  }

  const walk = (from: number, to: number, depth: number): void => {
    if (stopped) return
    if (!(to > from)) { rings(from, to); return }
    const helix = visit.attempt(from, to, { ...spend })
    if (helix === null) { rings(from, to); return }
    spend.samples += helix.samples
    spend.rows += helix.rows
    spend.work += helix.rasterWork
    if (helix.stopped) { stopped = true; return }
    if (helix.points.length > 1 && !helix.exhausted && !helix.uncovered && !helix.ineligible
      && (visit.accept === undefined || visit.accept(helix))) {
      if (visit.shouldStop?.() === true) { stopped = true; return }
      visit.emitHelix(helix)
      return
    }
    // Only a tolerance refusal says where it failed; everything else is a
    // whole-range ring fallback, exactly as before this slice.
    if (helix.failures.length === 0 || depth >= maxDepth) { rings(from, to); return }
    const marked = failingRings(helix.failures, along, from, to)
    // No progress is possible when the failing spans cover every ring: the
    // split would attempt the same band forever. Cut the range as rings.
    if (marked.size === 0 || marked.size >= to - from + 1) { rings(from, to); return }
    let k = from
    while (k <= to) {
      if (stopped) return
      if (marked.has(k)) {
        let end = k
        while (end + 1 <= to && marked.has(end + 1)) end++
        rings(k, end)
        k = end + 1
        continue
      }
      let end = k
      while (end + 1 <= to && !marked.has(end + 1)) end++
      walk(k, end, depth + 1)
      k = end + 1
    }
  }

  walk(fromRing, toRing, 0)
  return { stopped, spent: { ...spend } }
}

/**
 * The band-independent half of {@link ContinuousHelixInput}: what a caller
 * prepares once per operation, leaving the band, the A cursor and the band's
 * shared spend to each attempt ({@link walkContinuousBand}).
 */
export type ContinuousBandInput = Omit<ContinuousHelixInput, 'band' | 'startAngle' | 'spent'>
