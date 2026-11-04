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
 * - Cancellation (`shouldStop`) and the sample/row budgets are honoured; a
 *   budget that runs out reports `exhausted` so the caller can fall back to
 *   forward-only rings for that band.
 * - Round bars only. A square blank's corners are not a surface of revolution
 *   and its retained-corner floor belongs to the ring path (#1045 slice C), so
 *   a square blank is **not applicable** (`null`) and the caller keeps rings.
 *
 * This slice builds the path only: `rotaryModel.ts` does not call it yet
 * (ca-c/ca-d wire it in for the around finish and rough).
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
 * - `rounds` is the bisection limit, matching the ring refinement's eight.
 *
 * Over either sampling limit the result is `exhausted` and carries no points,
 * so the caller falls back to rings for the whole band rather than emitting
 * half a helix.
 */
export interface ContinuousHelixBudget {
  readonly samples: number
  readonly rows: number
  readonly rounds: number
}

/** The most angle rows (height maps) one helix may build. */
export const MAX_HELIX_ROWS = 65_536

/** The bisection rounds, matching the around grid's refinement (#1045 slice E). */
export const MAX_HELIX_REFINEMENT_ROUNDS = 8

/** The default budget: the operation's existing sample cap and the limits above. */
export const DEFAULT_CONTINUOUS_HELIX_BUDGET: ContinuousHelixBudget = {
  samples: MAX_ROTARY_SAMPLES,
  rows: MAX_HELIX_ROWS,
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
  /** The commanded A of the first boundary ring's first point. Default 0. */
  readonly startAngle?: number
  /** The operation's warnings; the sampler's height-map warnings are merged here. */
  readonly warnings: ToolpathWarning[]
  readonly shouldStop?: () => boolean
  readonly budget?: Partial<ContinuousHelixBudget>
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
  /** A budget ran out: the caller keeps rings for this band. */
  readonly exhausted: boolean
  /** The operation was cancelled: the caller emits no motion. */
  readonly stopped: boolean
  /** A sampled pose had no model under the tool: the caller keeps rings. */
  readonly uncovered: boolean
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
  /** The sampled row, once it has been read. */
  tips?: Float32Array
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
}

/** What a sampling/budget step decided. */
type HelixStatus = 'ok' | 'stopped' | 'exhausted'

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
  for (const row of rows) {
    if (input.shouldStop?.() === true) return 'stopped'
    if (sampling.rows + 1 > budget.rows) return 'exhausted'
    if (sampling.samples + row.along.length > budget.samples) return 'exhausted'
    const rowPrep = createRotarySamplingPrep(prep.mesh, prep.stock, prep.tool, {
      along: row.along,
      requestedCellSize: prep.requestedCellSize,
      conservativeCellBounds: true,
      ...(prep.wallTriangleStart !== undefined ? { wallTriangleStart: prep.wallTriangleStart } : {}),
      ...(prep.gridExtra !== undefined ? { gridExtra: prep.gridExtra } : {}),
      workspace: prep.workspace,
    })
    const sampled = sampleAnglesWithPrep(
      rowPrep,
      [rowAngle(startAngle, row, phaseScale)],
      input.warnings,
      input.shouldStop ? { shouldStop: input.shouldStop } : {},
    )
    if (!sampled.valid) return 'exhausted'
    if (sampled.stopped) return 'stopped'
    // The row arrives lifted by the angle's conservative cell rise, exactly as
    // the ring grid reads it; every finite value takes the operation's stock
    // offset and the clamp the ring path applies (`completeRotaryTargets`).
    const raw = sampled.tipRadius[0]
    const tips = new Float32Array(raw.length)
    for (let i = 0; i < raw.length; i++) {
      tips[i] = Number.isFinite(raw[i])
        ? Math.min(Math.max(raw[i] + input.stockToLeave, 0), maxRadius)
        : NaN
    }
    row.tips = tips
    sampling.samples += row.along.length
    sampling.rows++
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
 * Returns `uncovered` if a sampled pose has no model under the tool. After the
 * round limit the path is returned with the refinement it reached, the ring
 * refinement's rule; the caller's fallback is for the two sampling budgets.
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
  return { status: 'ok', uncovered: false, chain: current }
}

/** A refused/empty result carrying the work already done. */
function emptyHelix(
  turns: number,
  pitch: number,
  sampling: HelixSampling,
  flags: Partial<Pick<ContinuousHelix, 'exhausted' | 'stopped' | 'uncovered'>>,
): ContinuousHelix {
  return {
    points: [],
    turns,
    pitch,
    samples: sampling.samples,
    rows: sampling.rows,
    exhausted: flags.exhausted === true,
    stopped: flags.stopped === true,
    uncovered: flags.uncovered === true,
  }
}

/**
 * Build a forward helix over one band, or `null` when the band is not a case
 * this module covers (a square blank, a degenerate band, a missing operation
 * precondition). A non-null result with `exhausted`, `stopped` or `uncovered`
 * set carries no points; see {@link ContinuousHelix}.
 */
export function buildContinuousHelix(input: ContinuousHelixInput): ContinuousHelix | null {
  const { prep, band, stockToLeave } = input
  const stock = prep.stock
  // The helix is a round-bar path. A square blank's retained corners are not a
  // surface of revolution, and its corner floor is the ring path's; the caller
  // keeps rings there (ca-d's forward-only arcs).
  if (stock.shape !== 'round') return null
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
    rounds: input.budget?.rounds ?? DEFAULT_CONTINUOUS_HELIX_BUDGET.rounds,
  }
  if (!Number.isFinite(budget.samples) || budget.samples < 0) return null
  if (!Number.isFinite(budget.rows) || budget.rows < 0) return null
  if (!Number.isSafeInteger(budget.rounds) || budget.rounds < 0 || budget.rounds > 30) return null
  const phaseScale = intervals * 2 ** budget.rounds
  if (!Number.isSafeInteger(phaseScale)) return null
  const length = band.end - band.start
  const turns = Math.max(1, Math.ceil(length / input.stepover))
  if (!Number.isFinite(turns) || turns < 1 || turns > MAX_ROTARY_SAMPLES) return null
  const pitch = length / turns
  const sampling: HelixSampling = { samples: 0, rows: 0 }
  // Refuse before allocating the grid when the initial poses alone are over
  // budget: `intervals x (turns + 2)` is the whole first pass.
  if (intervals * (turns + 2) > budget.samples || intervals > budget.rows) {
    return emptyHelix(turns, pitch, sampling, { exhausted: true })
  }
  const nodes = initialNodes(band, turns, intervals, startAngle)
  const rows = helixRows(nodes, phaseScale)
  const initial = sampleHelixRows(rows, input, phaseScale, sampling, budget)
  if (initial === 'stopped') return emptyHelix(turns, pitch, sampling, { stopped: true })
  if (initial === 'exhausted') return emptyHelix(turns, pitch, sampling, { exhausted: true })
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
    exhausted: false,
    stopped: false,
    uncovered: false,
  }
}
