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

import { barMaxRadius, isSquareStock } from '../../types/barStock'
import { type BarStock, getStockBounds } from '../../types/project'
import { minRenderHeight } from '../csg'
import type { RotaryFinishParams } from './rotaryModelParams'
import {
  concatRotaryMeshes,
  modelOutsideBar,
  retainedBarStubs,
  rotaryCutterSpan,
  rotarySampledMesh,
} from './rotaryModelTargetGeometry'
import {
  mergeAlongPositions,
  mergeWallFootPositions,
  rotaryBandEnds,
  rotaryNeighbourColumns,
  type RotaryNeighbourColumns,
  rotaryWallFeet,
  type RotaryWallFoot,
  type RotaryWallFootRead,
  shoulderCleanFaces,
  WALL_FOOT_EPSILON,
  wallFootPreps,
} from './rotaryModelTargetNeighbours'
import {
  aroundArcStep,
  aroundGrid,
  exactLayerFloor,
  rotaryAlongPositions,
  rotaryConservativeSampling,
  rotaryRefinementToleranceFloor,
  turnAngle,
} from './rotaryModelTargetSampling'
import {
  createRotarySamplingPrep,
  MAX_ROTARY_SAMPLES,
  refineAroundSampling,
  refineAroundSamplingAsync,
  type RotaryAngleBatch,
  type RotaryBatchFactory,
  type RotaryModelMesh,
  type RotarySampleOptions,
  type RotarySamplingPrep,
  type RotarySamplingWorkspace,
  sampleAnglesWithPrep,
  sampleAnglesWithPrepAsync,
  sampleRotaryModelWithWorkspace,
} from './rotarySampling'
import { squareRotaryStubContactFloor } from './squareRotaryStock'
import type { NormalizedTool } from './types'
import type { ToolpathWarning, ToolpathWarningCode } from './warningCodes'

/**
 * The finest angular step a shoulder-cleanup ring is cut at (#1177), degrees.
 *
 * The step is a **block time** before it is a scallop: 0.4 degrees at the flat's
 * own 0.75 in radius and a 30 ipm feed is a 10.5 ms block, which is what #1173's
 * smoothness rule bounds from below -- a finer step would add the 4-10 ms blocks
 * the corner-lift fix removed. The scallop the step leaves is not one pass's
 * business (`cleanupRuns`): each spring pass cuts on a grid a third of a step on
 * from the last, so three passes give a third of this step's effective landing
 * without shortening a single block.
 */
export const CLEANUP_MIN_STEP_DEG = 0.4

/**
 * The coarsest step a shoulder-cleanup ring may be cut at (#1177). A coarser
 * base grid (`sampleSpacing` over the tool radius / 4) would leave the three
 * passes' landing coarser than the handoff's 0.05 mm, so the ring's own grid is
 * capped here rather than following it. 0.5 degrees is still 13 ms at the flat's
 * 0.75 in radius and a 30 ipm feed.
 */
const CLEANUP_MAX_STEP_DEG = 0.5

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
export const MAX_LINK_WORK = 4_000_000

/** One start-face shoulder-cleanup ring on its own uniform angular grid (#1177). */
interface RotaryShoulderCleanRing {
  /** The cleanup column's index in `RotaryTargets.along`. */
  readonly index: number
  /**
   * The ring's angular grid, degrees, ascending over one turn. Three rings share
   * a column, the first starting at 0 and the others a third and two thirds of a
   * step later, and they are cut in that order; the last one ends on the turn
   * itself, which is the angle the next unit starts at.
   */
  readonly angles: readonly number[]
  /** The exact tool tip at each angle, already through the stock offset and clamp. */
  readonly tips: readonly number[]
}

/**
 * The rows every generator emits from, and how a ring link finds its surface.
 *
 * `rotaryTargets` is the synchronous entry; `rotaryTargetsAsync` runs the same
 * stages through an injected batch factory (#1115 slice p-d1). Both call the
 * same preparation, assembly and completion, so the only thing that can differ
 * between them is where an angle's row comes from.
 */
export interface RotaryTargets {
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
  /**
   * The columns in `along` that are cut as their **own** ring -- no helix band
   * starts, ends or runs through them -- in ascending order:
   *
   * - a neighbour's wall foot (#1155 rn-d): the helix resamples every pose on
   *   the operation's mesh, where the conservative read lifts the tangent pose
   *   onto the wall;
   * - a column a neighbour can reach (#1173): its row is the exact footprint
   *   read on the mesh with the neighbours, while the helix samples the base
   *   prep, which holds the target and stubs only.
   */
  ringOnlyIndices: readonly number[]
  /**
   * The shoulder-cleanup rings (#1177): the columns whose ring a driver emits
   * **after** the operation's own rings instead of in grid order.
   *
   * The grid is ascending along the bar, so the band face sorts first -- but the
   * ring it adds must not lead the motion: a ring emitted before the first one
   * would advance the commanded A cursor a whole turn, and #1173's committed
   * suite fixes the first ring at A0..A360 (the corner-bump window). Emitting it
   * last also cuts it on the material the operation has already removed, which
   * is what a shoulder clean-up pass should do. The traverse back to the face
   * has no surface link (links run forward only), so the emitter's own
   * retract/rapid/plunge takes it.
   */
  shoulderCleanIndices: readonly number[]
  /**
   * The cleanup rings' cut points, three per column in emission order: see
   * `RotaryShoulderCleanRing`.
   */
  shoulderCleanRings: readonly RotaryShoulderCleanRing[]
  /**
   * The base angular grid's step in degrees, before any refinement (#1173): a
   * step finer than this was inserted by the between-sample refinement, which
   * is what `raiseShortAroundSegments` may merge. 360 when there is no grid.
   */
  baseAngleStep: number
  /**
   * #1173 fix 3: the exact footprint minimum the last layer's floor may reach,
   * read on the target and stubs alone (`RotaryTargetPlan.floorPrep`), or
   * `null` when the floor keeps the ring grid's conservative read. The rough
   * reads it; the finish has no layers.
   */
  layerFloor: number | null
  stopped: boolean
  refusal: ToolpathWarningCode | null
}

/** The "refused before emitting" shape every caller returns. */
function targetRefusal(code: ToolpathWarningCode): RotaryTargets {
  return {
    angles: [], along: [], tips: [], stubFloor: null, linkRowAt: () => null,
    prep: null, stockToLeave: 0, ringOnlyIndices: [], shoulderCleanIndices: [],
    shoulderCleanRings: [], baseAngleStep: 360, layerFloor: null,
    stopped: false, refusal: code,
  }
}

/** The "cancelled" shape; the caller emits no motion and no warnings. */
function targetStopped(angles: number[], along: number[]): RotaryTargets {
  return {
    angles, along, tips: [], stubFloor: null, linkRowAt: () => null,
    prep: null, stockToLeave: 0, ringOnlyIndices: [], shoulderCleanIndices: [],
    shoulderCleanRings: [], baseAngleStep: 360, layerFloor: null,
    stopped: true, refusal: null,
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
  /**
   * The workspace the link rows sample `samplingMesh` with (#1173). It is
   * `workspace` itself unless the base prep samples a different mesh (an around
   * operation with neighbours): a workspace caches the hull, strip plan and
   * candidate buffer of the mesh it first saw, so sharing it would read the
   * link rows on the target alone and let a link cut into a neighbour.
   */
  readonly linkWorkspace: RotarySamplingWorkspace
  readonly prep: RotarySamplingPrep
  /**
   * #1173 fix 3: the prep the last layer's floor is read exactly on -- the
   * **target and stubs**, the same mesh the base grid reads, never a neighbour
   * -- or `undefined` when the floor keeps the ring grid's conservative read
   * (along mode, a square blank, a non-flat cutter). See `exactLayerFloor`.
   */
  readonly floorPrep?: RotarySamplingPrep
  /**
   * The neighbour wall-foot rings (#1155 rn-d): their columns in `along` and the
   * prep that reads each one on the target's own surface. Empty when no
   * neighbour rises out of the band, so an ordinary operation reads nothing.
   */
  readonly wallFootReads: readonly RotaryWallFootRead[]
  /**
   * The columns a neighbour can reach and the prep that reads them exactly
   * (#1173), or `null` when the operation has no neighbour or is an along pass.
   * See `rotaryNeighbourColumns`.
   */
  readonly neighbourColumns: RotaryNeighbourColumns | null
  /**
   * #1177: the shoulder-cleanup rings' columns in `along` (see
   * `RotaryTargets.shoulderCleanIndices`). Empty for an ordinary operation.
   */
  readonly shoulderCleanIndices: readonly number[]
  /**
   * #1155 rn-e: the ends the target itself ends at, where the retained wall is
   * gone from the sampled mesh. A sample there can read "no model under the
   * tool" for the sliver the cutter's footprint puts past the model's end, so
   * that end's `NaN` run takes the target's surface at the end instead of
   * becoming "no contour" (the finish) or "cut to the layer" (the rough).
   */
  readonly overrunStart: boolean
  readonly overrunEnd: boolean
}

/**
 * The neighbour-reach columns' rows (#1173), merged into the operation's grid.
 *
 * The base grid samples the target and stubs only, so a neighbour's facets do
 * not raise the per-angle lift at columns it cannot reach (the lift is one
 * value per angle, added at every along position: the Hex on Frank's bolt
 * raised it from 0.009 to 0.019 in for A280-284 along the whole shank). The
 * columns a neighbour **can** reach take the exact footprint maximum on the
 * mesh with the neighbours instead of the conservative cell read, whose
 * full-cell pad and per-angle lift made a Hex corner read differently at every
 * angle (0.886 / 0.881 / 0.890 in at A19 / 20 / 21, against an exact corner of
 * 0.886). Those columns are then refined on their exact rows with the around
 * rule (`refineAroundSampling`), so a chord between two exact samples is
 * checked against the neighbour too, and every angle that refinement adds is
 * sampled on the base prep for the other columns. Both drivers call this
 * synchronously after their own base refinement, so pool and serial runs stay
 * byte-identical.
 *
 * Returns `null` when a row is invalid or the refined grid is over budget.
 */
function mergeNeighbourColumns(
  plan: RotaryTargetPlan,
  stock: BarStock,
  tool: NormalizedTool,
  warnings: ToolpathWarning[],
  angles: number[],
  tipRows: readonly Float32Array[],
  shouldStop: (() => boolean) | undefined,
): { angles: number[]; tips: readonly Float32Array[]; stopped: boolean } | null {
  const columns = plan.neighbourColumns
  if (columns === null) return { angles, tips: tipRows, stopped: false }
  const hooks = shouldStop ? { shouldStop } : {}
  const sampled = sampleAnglesWithPrep(columns.prep, angles, warnings, hooks)
  if (!sampled.valid) return null
  if (sampled.stopped) return { angles, tips: tipRows, stopped: true }
  let columnAngles: number[] = angles
  let columnRows: readonly Float32Array[] = sampled.tipRadius
  if (angles.length > 1) {
    const refined = refineAroundSampling({
      prep: columns.prep, stock, tool, warnings, angles, tips: sampled.tipRadius, lifts: sampled.lifts, ...hooks,
    })
    if (refined === null) return null
    if (refined.stopped) return { angles, tips: tipRows, stopped: true }
    columnAngles = refined.angles
    columnRows = refined.tips
  }
  if (columnAngles.length * plan.along.length > MAX_ROTARY_SAMPLES) return null
  const known = new Map<number, number>()
  angles.forEach((angle, k) => known.set(angle, k))
  const added = columnAngles.filter((angle) => !known.has(angle))
  let addedRows: readonly Float32Array[] = []
  if (added.length > 0) {
    const base = sampleAnglesWithPrep(plan.prep, added, warnings, hooks)
    if (!base.valid) return null
    if (base.stopped) return { angles, tips: tipRows, stopped: true }
    addedRows = base.tipRadius
  }
  const addedAt = new Map<number, number>()
  added.forEach((angle, j) => addedAt.set(angle, j))
  const tips = columnAngles.map((angle, k) => {
    const knownAt = known.get(angle)
    const row = Float32Array.from(knownAt !== undefined ? tipRows[knownAt] : addedRows[addedAt.get(angle) ?? 0])
    columns.indices.forEach((column, j) => {
      row[column] = columnRows[k][j]
    })
    return row
  })
  return { angles: columnAngles, tips, stopped: false }
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
  //
  // #1155 rn-e: the pull is skipped at an end the target itself ends at, so the
  // centre reaches the model's end and the cutter reaches the edge there. A
  // neighbour's wall, a support and a keep-out still bound it (`rotaryBandEnds`
  // decides which is which); only the plain bar beyond the model stops bounding
  // it, which is the rule Frank approved on 2026-11-06.
  const ends = rotaryBandEnds(mesh, params.neighbours, stock, tool, params)
  const span = rotaryCutterSpan(stock, tool, params, ends)
  if (!span) {
    return { refusal: 'rotaryNoRoom' }
  }
  // #1177: the shoulder-cleanup ring (see `shoulderCleanFaces`).
  const cleanFaces = shoulderCleanFaces(params.neighbours, stock, tool, params, ends)
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
    // The target's own mesh: a neighbour's along extent must not widen the
    // shoulder envelope this refines (#1155).
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
  // below sit on the bar's surface by construction and must not trip it, and a
  // neighbour that pokes out of the bar is the neighbour's own warning (#1155).
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
  // #1155: every other model standing on the bar is material this operation
  // must not cut into, so it is joined into the **sampled** mesh right after
  // the target and before the retained stubs. The sampler, the around
  // refinement, the helix's raster maps and the ring/helix eligibility then all
  // read the neighbour through the one mesh, with no second code path -- and
  // `retainedTriangleStart` still marks only wall triangles, because the stubs
  // are appended last. The along range, `modelOutsideBar`, the target ids and
  // the #1096 region stay the target's: the neighbours are a separate argument
  // on `params`, never part of `mesh`.
  const samplingMesh = rotarySampledMesh(mesh, params.neighbours, stock, tool.units, params)
  // #1095: the erosion must move the wall's sampled height, not the height-map
  // grid. The un-eroded stubs (the ones the stock-to-leave-zero run sampled) are
  // unioned back into the grid envelope, so every sample more than one cutter
  // radius from a retained wall keeps the exact cell it had before: the eroded
  // stub only changes the cells its own footprint can read, instead of shifting
  // the origin under the whole bar. A zero inset adds nothing, so the old
  // single-mesh path stays byte for byte.
  //
  // #1155 rn-e: an end that lost its retained stub keeps the same treatment, for
  // the same reason. Only the stub's *wall* is gone from the sampled mesh (so the
  // cutter may cut the plain bar beyond the model's end); the grid envelope is
  // still widened to it, so every cell more than a footprint away from the end
  // keeps the height it had and the fix stays local to the band's ends instead of
  // moving the whole height map. A zero inset with both stubs (the ordinary
  // operation) adds nothing, so that path stays byte for byte.
  const gridStubs = includeSquareStubs
    && (wallInset !== 0 || !ends.stubStart || !ends.stubEnd)
    ? retainedBarStubs(stock, tool.units, params.alongStart, params.alongEnd)
    : []
  const gridExtra = gridStubs.length > 0 ? concatRotaryMeshes(gridStubs) : undefined
  // #1155 rn-d: a neighbour's wall inside the band gets a ring at its foot. The
  // positions come from the neighbours' meshes and are merged into the along
  // grid, so the ring exists at every angle; the foot's own tip is read on the
  // target's surface below (`wallFootReads`), because the conservative read
  // reaches a whole cell past its sample and would lift the tangent ring onto
  // the neighbour it is tangent to. An operation with no wall foot keeps the
  // exact grid, the exact rows and the exact motion it had.
  const walls = rotaryWallFeet(mesh, params.neighbours, stock, tool, params, span)
  // #1177: a face a neighbour's flat runs across, and that the centre pull left
  // behind the first ring's rim, gets a ring of its own. It is added *after*
  // `floorAlong` so the exact layer floor still reads the target's own grid
  // (#1173), and *before* `rotaryNeighbourColumns` so it is sampled exactly on
  // the mesh with the neighbours and marked ring-only, like any other
  // neighbour-reach column. It is merged *before* the wall feet so their indices
  // are the final grid's.
  const rings = cleanFaces.length === 0 ? along : mergeAlongPositions(along, cleanFaces)
  const merged = walls.length === 0
    ? { along: rings, footReads: [] as Array<{ index: number; foot: RotaryWallFoot }> }
    : mergeWallFootPositions(rings, walls)
  // #1173 fix 3: the along grid the exact layer floor is read on, taken before
  // the merge below adds the neighbours' wall-foot positions. It is the
  // **target's own** grid, so the same project with the neighbour removed reads
  // the floor at exactly the same along positions and gets the same value.
  const floorAlong = along.slice()
  along = merged.along
  // #1177: where the cleanup rings landed in the final grid. The merges above
  // sort and dedupe, so the positions are looked up rather than assumed.
  const shoulderCleanIndices = cleanFaces
    .map((face) => along.findIndex((position) => Math.abs(position - face) <= WALL_FOOT_EPSILON))
    .filter((index) => index >= 0)
  // One workspace for the base grid and every refinement round: the mesh, tool
  // and along positions are the same in all of them, so the hull, the strip
  // index and the candidate buffer are built once (issue #1045 slice T).
  const workspace: RotarySamplingWorkspace = {}
  // #1155 correction: along mode samples conservatively too whenever a
  // neighbour is in the mesh. Its old centre-sampled read left a pass one
  // cutter radius past a neighbour's end face blind to the half cell that face
  // covers, and the cutter stepped into that face by up to that cell (0.500 mm
  // measured on the bolt case, against the 0.01 mm the rule requires). Around
  // mode has always read this way; an along operation without a neighbour still
  // takes the old path byte for byte.
  //
  // #1173: an around operation with neighbours samples its base grid on the
  // target and stubs only. The columns a neighbour can reach are read exactly on
  // `samplingMesh` below (`neighbourColumns`); every other column cannot reach a
  // neighbour, so leaving it out changes no drop-cutter value there -- it only
  // stops the neighbour's facets raising that angle's lift along the whole bar.
  // The link rows keep reading `samplingMesh`, neighbours included.
  const aroundWithNeighbours = params.passDirection === 'around'
    && params.neighbours !== undefined && params.neighbours.length > 0
  const baseMesh = aroundWithNeighbours
    ? rotarySampledMesh(mesh, undefined, stock, tool.units, params)
    : samplingMesh
  const prep = createRotarySamplingPrep(baseMesh, stock, samplingTool, {
    along,
    requestedCellSize: params.requestedCellSize,
    // #1177: a **ball** ring grid reads the exact footprint maximum. The
    // conservative read is a flat-bottom answer -- a cell's centre sample plus
    // the cell's rise and pad -- and on a facet tilted `delta` it stands above a
    // ball's true tip by `(r + pad)(1/cos delta - 1) + pad tan delta`: 0.21 mm at
    // 25 degrees on Frank's bolt, which is the raised band along every facet
    // edge. The read is exact for both tool shapes (`exactFootprintTips`), so the
    // ball takes it exactly as its wall-foot rings and its helix do. A square
    // blank keeps the conservative read for its retained-corner rules, exactly
    // as its helix does.
    ...(tool.type === 'ball_endmill' && !isSquareStock(stock) ? { exactTipRows: true } : {}),
    ...(rotaryConservativeSampling(params) ? { conservativeCellBounds: true } : {}),
    ...((gridExtra !== undefined) ? { gridExtra } : {}),
    ...(baseMesh.retainedTriangleStart !== undefined
      ? { wallTriangleStart: baseMesh.retainedTriangleStart }
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
  // #1173 fix 3: the layer floor's exact read. It borrows the base prep's
  // workspace -- the hull, strip plan and candidate buffer are the sampled
  // mesh's, not the read mode's -- and its own `along` is the target's grid, so
  // neither a neighbour nor a wall-foot column can enter the value. It exists
  // only where the last layer is planned from an exact read anyway: an around
  // pass, a flat cutter (the helix that rides the floor is only exactly read
  // there) and a round bar (a square blank's floor carries the retained-corner
  // rules).
  const floorPrep = params.passDirection === 'around'
    && tool.type === 'flat_endmill'
    && !isSquareStock(stock)
    ? createRotarySamplingPrep(baseMesh, stock, samplingTool, {
      along: floorAlong,
      requestedCellSize: params.requestedCellSize,
      exactTipRows: true,
      conservativeCellBounds: true,
      ...((gridExtra !== undefined) ? { gridExtra } : {}),
      ...(baseMesh.retainedTriangleStart !== undefined
        ? { wallTriangleStart: baseMesh.retainedTriangleStart }
        : {}),
      workspace,
    })
    : undefined
  // The foot rings' own rows: the target's surface, read on a mesh that keeps
  // only the neighbours the cutter can actually reach at that position. The
  // wall's own neighbour is tangent there (the foot is exactly one leave plus
  // one cutter radius off its face), so it drops out and the ring reads the
  // target -- while any other neighbour genuinely under the cutter keeps its
  // lift, so the ring can never be read lower than the material it must clear.
  const wallFootReads = wallFootPreps(merged.footReads, mesh, params.neighbours, stock, samplingTool,
    params, along, gridExtra)
  // #1173: the columns a neighbour can reach, read exactly on the mesh with the
  // neighbours (see `mergeNeighbourColumns`).
  const columnIndices = aroundWithNeighbours && params.neighbours !== undefined
    ? rotaryNeighbourColumns(along, params.neighbours, stock, samplingTool.radius + params.requestedCellSize,
      new Set(merged.footReads.map((read) => read.index)))
    : []
  const neighbourColumns: RotaryNeighbourColumns | null = columnIndices.length === 0 ? null : {
    indices: columnIndices,
    prep: createRotarySamplingPrep(samplingMesh, stock, samplingTool, {
      along: columnIndices.map((index) => along[index]),
      requestedCellSize: params.requestedCellSize,
      exactTipRows: true,
      conservativeCellBounds: true,
      ...((gridExtra !== undefined) ? { gridExtra } : {}),
      ...(samplingMesh.retainedTriangleStart !== undefined
        ? { wallTriangleStart: samplingMesh.retainedTriangleStart }
        : {}),
    }),
  }
  return {
    plan: {
      angles, along, stockToLeave, maxRadius,
      samplingMesh, samplingTool, workspace, prep,
      linkWorkspace: baseMesh === samplingMesh ? workspace : {},
      ...(floorPrep !== undefined ? { floorPrep } : {}),
      wallFootReads,
      neighbourColumns,
      shoulderCleanIndices,
      overrunStart: !ends.stubStart,
      overrunEnd: !ends.stubEnd,
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
  layerFloor: number | null,
): RotaryTargets {
  const { along, stockToLeave, maxRadius, samplingMesh, samplingTool, gridExtra, linkWorkspace } = plan
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
  // #1155 rn-e: at an end the target itself ends at, the footprint puts a sliver
  // of the cutter past the model's end where no sampled mesh stands at all (the
  // retained wall that used to be there is gone, which is the point), so the
  // edge sample can read "no model under the tool". Beyond the end the height
  // the tool may go down to is the target's surface **at** its end -- the
  // drop-cutter on the target and its neighbours -- so the edge's `NaN` run
  // takes the first finite sample inside it. Leaving the `NaN` would make the
  // finish drop the whole end ring (a ridge again) and the rough cut the layer
  // radius there, i.e. the retained bar beyond the end down to the last layer.
  const fillOverrunNaNs = (fromStart: boolean): void => {
    for (const row of tips) {
      const limit = row.length
      if (limit === 0) continue
      let edge = 0
      while (edge < limit && Number.isNaN(row[fromStart ? edge : limit - 1 - edge])) edge++
      if (edge === 0 || edge === limit) continue
      const inside = row[fromStart ? edge : limit - 1 - edge]
      for (let i = 0; i < edge; i++) row[fromStart ? i : limit - 1 - i] = inside
    }
  }
  if (plan.overrunStart) fillOverrunNaNs(true)
  if (plan.overrunEnd) fillOverrunNaNs(false)
  // #1155 rn-d: a wall-foot ring follows the **target's** surface. The ring sits
  // exactly one leave plus one cutter radius off the neighbour's face, so its
  // body is tangent to that face and never inside it -- but the conservative
  // read reaches a whole cell past its sample, so the shared row lifts it onto
  // the neighbour it is tangent to and the ring would leave the ledge it exists
  // to remove. Its own row is read here, on the mesh without the neighbour the
  // ring is tangent to (see `wallFootPreps`), through the same stock offset and
  // clamp as every other sample. That row is the **exact** footprint maximum
  // (`exactTipRows`, correction 3): the conservative cell bounds are an upper
  // bound only with a margin, and the margin both left the foot 0.00915 in above
  // a smooth target (correction 2) and, taken back off, cut 0.0078 in into a
  // polygon target's corner (this correction). Correctness against the material
  // the cutter may not enter is unchanged: the prep keeps every neighbour the
  // body reaches besides the tangent one.
  if (plan.wallFootReads.length > 0) {
    const rowsByPrep = new Map<RotarySamplingPrep, readonly Float32Array[]>()
    for (const read of plan.wallFootReads) {
      let rows = rowsByPrep.get(read.prep)
      if (rows === undefined) {
        const result = sampleAnglesWithPrep(read.prep, angles, warnings)
        if (!result.valid) continue
        rows = result.tipRadius
        rowsByPrep.set(read.prep, rows)
      }
      for (let k = 0; k < tips.length && k < rows.length; k++) {
        const raw = rows[k][read.position]
        tips[k][read.index] = Number.isFinite(raw)
          ? Math.min(Math.max(raw + stockToLeave, 0), maxRadius)
          : NaN
      }
    }
  }
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
  // #1185 L1: a link row's angle is usually one the ring grid has rasterised
  // already, and the map depends only on the turn, so the row restores that map
  // instead of building it a second time. It may only do so when the grid's
  // maps are the maps this row would build: the same workspace (which means the
  // same sampled mesh -- `linkWorkspace` is a fresh one when the grid left the
  // neighbours out), the conservative raster, and the same wall marking. The
  // tool, cell size and grid envelope are the same arguments on both calls. A
  // grid that reads exact tips builds no map, so there is nothing to restore
  // and the row is rasterised as before; the reader checks the turn, the grid
  // and the arrays of every map it takes (`restoreRotaryAngleMap`).
  const linkRowsReadGridMaps = linkWorkspace === plan.workspace
    && plan.prep.conservativeCellBounds
    && plan.prep.angleMaps !== 'off'
    && plan.prep.mesh === samplingMesh
    && plan.prep.tool === samplingTool
    && plan.prep.requestedCellSize === params.requestedCellSize
    && plan.prep.gridExtra === gridExtra
    && plan.prep.wallTriangleStart === samplingMesh.retainedTriangleStart
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
        ...(linkRowsReadGridMaps ? { angleMaps: 'read' as const } : {}),
      },
      warnings,
      linkWorkspace,
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
  // #1177: a start-face cleanup ring on its own uniform `CLEANUP_MIN_STEP_DEG`
  // grid, read exactly on the mesh with the neighbours. The operation's grid is
  // too coarse for the 0.05 mm bound (its scallop over the flat is 0.06 mm) and
  // the refined grid's sub-0.45 degree steps would be new sub-10 ms blocks. The
  // ring is only built where the neighbour columns' prep already reads this
  // column -- the cleanup face is inside a neighbour's span, so it always is.
  const shoulderCleanRings: RotaryShoulderCleanRing[] = []
  const neighbourColumns = plan.neighbourColumns
  if (neighbourColumns !== null && !isSquareStock(stock)) {
    const baseStep = plan.angles.length > 1 ? plan.angles[1] - plan.angles[0] : 360
    const step = Math.min(Math.max(baseStep / 4, CLEANUP_MIN_STEP_DEG), CLEANUP_MAX_STEP_DEG)
    const count = Math.max(1, Math.round(360 / step))
    // A **start** cleanup ring is the one below the operation's first ordinary
    // ring (the band face the cutter was pulled in from). An end-face ring is
    // above every ordinary ring and keeps the operation's own grid.
    const clean = new Set(plan.shoulderCleanIndices)
    let firstNormal = 0
    while (firstNormal < along.length && clean.has(firstNormal)) firstNormal++
    for (const index of plan.shoulderCleanIndices) {
      if (index >= firstNormal) continue
      const position = neighbourColumns.indices.indexOf(index)
      if (position < 0) continue
      // Three spring passes per column, each on a grid a third of a step on
      // from the last: see `RotaryShoulderCleanRing`. A pass can only spend the
      // one pose per angle whose rim reaches furthest, so a pass lowers the
      // shoulder by one landing step and the next pass -- on the grid between
      // the last one's samples -- spends the next. The seam between two passes
      // is more than one step (the emitter's `cleanupTurns` accounting), and
      // the last pass ends on the turn itself, which is the angle the next unit
      // starts at.
      const stepDeg = 360 / count
      const grids = [
        Array.from({ length: count }, (_, k) => k * stepDeg),
        Array.from({ length: count }, (_, k) => stepDeg / 3 + k * stepDeg),
        [...Array.from({ length: count - 1 }, (_, k) => 2 * stepDeg / 3 + k * stepDeg), 360],
      ]
      for (const ringAngles of grids) {
        const sampled = sampleAnglesWithPrep(neighbourColumns.prep, ringAngles, warnings)
        if (!sampled.valid) continue
        if (sampled.stopped) break
        const ringTips = Array.from({ length: ringAngles.length }, (_, k) => {
          const raw = sampled.tipRadius[k][position]
          return Number.isFinite(raw) ? Math.min(Math.max(raw + stockToLeave, 0), maxRadius) : NaN
        })
        if (ringTips.some((tip) => Number.isFinite(tip))) {
          shoulderCleanRings.push({ index, angles: ringAngles, tips: ringTips })
        }
      }
    }
  }
  return {
    angles, along, tips, stubFloor, linkRowAt: linkRowAtPhysical, prep: plan.prep,
    stockToLeave: plan.stockToLeave,
    ringOnlyIndices: [
      ...plan.wallFootReads.map((read) => read.index),
      ...(plan.neighbourColumns?.indices ?? []),
    ].sort((a, b) => a - b),
    shoulderCleanIndices: plan.shoulderCleanIndices,
    shoulderCleanRings,
    baseAngleStep: plan.angles.length > 1 ? plan.angles[1] - plan.angles[0] : 360,
    layerFloor,
    stopped: false, refusal: null,
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
export function rotaryTargets(
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
  // #1173 fix 3: the rough's layer plan reads the floor from the **base** grid,
  // before the refinement and the neighbour columns below can move a sample.
  // The finish has no layers, so it pays for no extra row.
  const layerFloor = 'stepdown' in params && plan.floorPrep !== undefined
    ? exactLayerFloor(plan.floorPrep, plan.angles, sampling.tipRadius, plan.stockToLeave, plan.maxRadius, warnings)
    : null
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
      lifts: sampling.lifts,
      toleranceFloor: rotaryRefinementToleranceFloor(params, tool.units),
      ...(hooks.shouldStop ? { shouldStop: hooks.shouldStop } : {}),
    })
    if (refined === null) return targetRefusal('operationStepoverRatioRange')
    if (refined.stopped) return targetStopped([], [])
    angles = refined.angles
    tipRows = refined.tips
  }
  const columns = mergeNeighbourColumns(plan, stock, tool, warnings, angles, tipRows, hooks.shouldStop)
  if (columns === null) return targetRefusal('operationStepoverRatioRange')
  if (columns.stopped) return targetStopped([], [])
  return completeRotaryTargets(operationId, stock, tool, params, plan, columns.angles, columns.tips, warnings, layerFloor)
}

/**
 * `rotaryTargets` through an injected batch factory (#1115 slice p-d1).
 *
 * One runner is built from the plan's prep and used for the base grid and every
 * refinement round, so a worker pool is torn down and rebuilt once per
 * operation, not once per round. Every guard, every warning and the completion
 * step are the synchronous functions above.
 */
export async function rotaryTargetsAsync(
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
  // #1173 fix 3: the same base-grid floor the synchronous driver reads; see
  // `rotaryTargets`. The wall-foot rows in `completeRotaryTargets` are already
  // read synchronously here for the same reason: it is a handful of rows.
  const layerFloor = 'stepdown' in params && plan.floorPrep !== undefined
    ? exactLayerFloor(plan.floorPrep, plan.angles, sampling.tipRadius, plan.stockToLeave, plan.maxRadius, warnings)
    : null
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
      lifts: sampling.lifts,
      toleranceFloor: rotaryRefinementToleranceFloor(params, tool.units),
      ...(hooks.shouldStop ? { shouldStop: hooks.shouldStop } : {}),
    }, batches)
    if (refined === null) return targetRefusal('operationStepoverRatioRange')
    if (refined.stopped) return targetStopped([], [])
    angles = refined.angles
    tipRows = refined.tips
  }
  const columns = mergeNeighbourColumns(plan, stock, tool, warnings, angles, tipRows, hooks.shouldStop)
  if (columns === null) return targetRefusal('operationStepoverRatioRange')
  if (columns.stopped) return targetStopped([], [])
  return completeRotaryTargets(operationId, stock, tool, params, plan, columns.angles, columns.tips, warnings, layerFloor)
}
