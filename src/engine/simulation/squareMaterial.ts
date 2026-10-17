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
 * Square-blank material intervals and the physical finite-cutter kernel
 * (issue #1016 C2-R1F).
 *
 * `topZ` alone cannot represent square material. A pass can cut a groove part
 * way out along a cell's radial ray and leave the lip beyond it standing, so
 * one cell holds two surviving pieces — an inner core and an outer shell —
 * separated by air the cutter reached. Keeping only the outermost endpoint of
 * the connected removed band loses where the outer shell runs (manager
 * measurement: at along 50 / A0 of the actual generated rough, a 50° ray
 * loses `[9.3314, 10.4433]` while `[10.4433, 13.0541]` survives), and no
 * fixed-point sweep over an outer height can put it back.
 *
 * So square material is stored per cell as the **remaining canonical radial
 * intervals**: ordered, disjoint `[lo, hi]` endpoint pairs measured from the
 * true pivot — a 1D CSG per ray. A key missing from the map is virgin
 * material; an empty array is fully removed. Values are immutable after
 * assignment: a cut replaces a cell's canonical array and never mutates one,
 * so a shared array cannot alias two grids.
 *
 * ## The cutter
 *
 * Take the machine plane spanned by the bar axis and the pivot's radial
 * direction. A material point at radius `u` on the cell's ray, whose machine
 * angle differs from the tool's program angle by `θ`, sits at
 *
 *     radial = u·cos θ,   across = u·sin θ
 *
 * from the pivot. The tool is a **solid of revolution about the radial axis**
 * whose tip rides it at radial height `tip` (`move.z`) and which is confined
 * to `±rt` about the tool's own bar position:
 *
 *   - **flat**: the cylinder `radial ≥ tip`, radius `rt` — its radial reach on
 *     an oblique ray is `√(rt² − Δx²)/|sin θ|` (the cylinder wall) and its
 *     floor is `tip/cos θ`;
 *   - **ball**: the ball of radius `rt` centred at radial `tip + rt` (the lower
 *     hemisphere — it reaches down to `tip` on the axis), **plus the
 *     cylindrical shank beyond its equator**, `radial ≥ tip + rt` with the same
 *     radius. A bare-sphere kernel loses the shank entirely (measured:
 *     constant tip 5, radius 2 leaves radius 10 instead of 5).
 *
 * A move keeps the tip radius and the along coordinate **correlated**: at one
 * parameter the tip sits at `tip(s)`, the tool at `along(s)`, so a cell's axial
 * offset is `Δx(s) = cellAlong − along(s)`. Both the sphere and the shank cut
 * the cell's ray in a closed-form interval, and the material removed by the
 * whole move is the union of those intervals.
 *
 * For a constant-angle move the ray meets each part of the body over one
 * interval of the move parameter — the part's margin (its reach minus its inner
 * boundary, or the ball's discriminant) is concave, so its non-negative set is
 * an interval — and over a connected feasible interval the removed set is
 * `[min floor, max reach]`, because the per-pose interval varies continuously.
 * The feasible interval is found from the concavity (a converged maximum, then
 * bisected crossings) and the extrema are converged on it, so no uniform scan
 * has to land inside a narrow window and a sloping pass keeps its tip and its
 * axial position correlated. A move that changes the program angle below the
 * blank's envelope sweeps a rotating body whose removed set is not certified at
 * grid resolution; it is refused explicitly before any material is touched.
 *
 * ## The angle window (C2-P3)
 *
 * A cell only ever loses material where the tool body actually reaches its
 * ray, and the body is confined to `±rt` about the tool's own bar position
 * while never dipping below `tip`. With the cell's ray at machine angle `θ`
 * from the tool and its radius `u` measured from the pivot, a hit needs
 * `u·|sin θ| ≤ rt` (across reach) and `u·cos θ ≥ tip` (the flat floor, the
 * ball's lowest point, or the shank's inner wall). For a tip that stays above
 * the pivot (`tipMin > 0`) those two force `|θ| ≤ atan(rt / tipMin)`, so each
 * move iterates only the across cells inside that window instead of searching
 * every cell all the way round the bar. See `angleWindowBound` for the proof
 * and `acrossWindow` for the index mapping; a window that reaches the seam is
 * two index ranges, and anything not finite, a tip at or below the pivot, or a
 * window that covers the circumference falls back to the full loop.
 */

import type { ToolType } from '../../types/project'
import type { ToolpathMove, ToolpathPoint } from '../toolpaths/types'
import type { DirtyRegion, SimulationGrid } from './types'

const TWO_PI = Math.PI * 2

/**
 * Hard upper bound on the golden-section extrema and the bisected
 * feasible-window crossings. A bracket shrinks by the golden ratio (~0.618) per
 * step, so 96 reaches Float64 resolution long before the budget runs out. The
 * loops stop as soon as the bracket is below `searchTolerance` and, for a
 * crossing, the stored radial endpoint has stopped moving (see
 * `storedEndpointsAgree`); this stays as a safety net so a pathological
 * bracket can never loop without end.
 */
const CONVERGE_ITERATIONS = 96

/** A sine below this is treated as exactly axial, where the reach is infinite. */
const AXIAL_EPSILON = 1e-12

/** Relative tolerance of one Float32 ulp, for "did the stored value move". */
const ULP = 2 ** -23

/** Test-only iteration accounting for the fixed-count searches. */
export interface SearchIterationStats {
  maximizeCalls: number
  maximizeIterations: number
  bisectCalls: number
  bisectIterations: number
  /**
   * Bisected feasible-window endpoints that came back on the infeasible side.
   * The search contract is the last known non-negative point, so this must stay
   * zero; it is recorded here because a sign-side regression can still land
   * within the Float32 endpoint tolerance and be invisible in the stored
   * material.
   */
  crossingsOnNegativeSide: number
  /**
   * Stored endpoint values compared by `storedEndpointsAgree`, and the number
   * of times that comparison ran. A crossing search only reaches the comparison
   * once its parameter bracket has converged, so these count the Float32 work
   * that actually resolves the stored boundary. The convergence test uses them
   * to prove each configured endpoint list is consulted: an endpoint silently
   * dropped from a list lowers `endpointChecks` without changing any iteration
   * count, which is exactly the C2-P1F manager mutation.
   */
  endpointChecks: number
  endpointCalls: number
}

/**
 * Test-only control over the fixed-count searches (issue #1016 C2-P1).
 *
 * Production callers never pass this: the early exit is the default. The
 * convergence test supplies it to replay the pre-P1 fixed-96 search through
 * exactly the same code, so any difference in stored material comes from the
 * tolerance and not from a re-implementation.
 */
export interface SquareSearchOptions {
  /** Run the legacy fixed-count search with no early exit. */
  legacyFixedSearch?: boolean
  /** Accumulate the iterations each search actually took. */
  searchIterations?: SearchIterationStats
  /**
   * Visit every across cell for every move instead of the angle window the
   * tool can reach (issue #1016 C2-P3). The window test replays a move set
   * both ways through exactly the same code, so a difference in stored
   * material can only come from the window itself.
   */
  legacyFullLoop?: boolean
  /** Accumulate the across cells the loop tested and how many got a band. */
  testedCells?: TestedCellStats
}

/** Test-only accounting for the across cells a replay actually searched. */
export interface TestedCellStats {
  /** Across cells that reached the per-cell cut search. */
  tested: number
  /**
   * Of those, the cells whose search returned a removal band. Every band a
   * full loop finds must still be found, so this count is the invariant the
   * window is not allowed to shrink.
   */
  withBand: number
}

interface LoopControl {
  /** Search every across cell, whatever the angle window says. */
  fullLoop: boolean
  tested?: TestedCellStats
}

interface SearchControl {
  legacy: boolean
  stats?: SearchIterationStats
}

export interface SquareApplyResult {
  changedCount: number
  dirtyRegion: DirtyRegion | null
}

const ZERO_RESULT: SquareApplyResult = { changedCount: 0, dirtyRegion: null }

/** True for the two cutter bodies the square kernel can model physically. */
export function squareToolSupported(toolType: ToolType): boolean {
  return toolType === 'flat_endmill' || toolType === 'ball_endmill'
}

/**
 * Validate a transient square descriptor before it initializes a grid: the
 * side must be finite and positive and the frame must be the square's own
 * nominal reference cylinder (`radius = side/2`, `circumference = π·side`).
 * Throws a `RangeError` on anything else — a mismatched frame would silently
 * map every cell to the wrong angle.
 */
export function validateSquareBarDescriptor(descriptor: SquareBarDescriptorLike): void {
  const { side, frame } = descriptor
  if (!Number.isFinite(side) || side <= 0) {
    throw new RangeError(`squareBar: side must be a positive finite number, got ${side}`)
  }
  if (!frame) {
    throw new RangeError('squareBar: frame is required')
  }
  if (frame.axis !== 'x' && frame.axis !== 'y') {
    throw new RangeError(`squareBar: frame.axis must be 'x' or 'y', got ${String(frame.axis)}`)
  }
  const scale = Math.max(1, side)
  const radiusTolerance = 1e-9 * scale
  if (!Number.isFinite(frame.radius) || Math.abs(frame.radius - side / 2) > radiusTolerance) {
    throw new RangeError(`squareBar: frame.radius must be side/2 (${side / 2}), got ${frame.radius}`)
  }
  if (!Number.isFinite(frame.circumference) || Math.abs(frame.circumference - Math.PI * side) > radiusTolerance) {
    throw new RangeError(`squareBar: frame.circumference must be π·side (${Math.PI * side}), got ${frame.circumference}`)
  }
  for (const [name, value] of [['zero', frame.zero], ['centre', frame.centre], ['sheetStart', frame.sheetStart]] as const) {
    if (!Number.isFinite(value)) {
      throw new RangeError(`squareBar: frame.${name} must be finite, got ${value}`)
    }
  }
}

interface SquareBarDescriptorLike {
  side: number
  frame: {
    axis: 'x' | 'y'
    centre: number
    radius: number
    zero: number
    sheetStart: number
    circumference: number
  }
}

/** Validate a transient square descriptor before it initializes a grid. */
export function squareSurfaceRadius(side: number, angle: number): number {
  return (side / 2) / Math.max(Math.abs(Math.sin(angle)), Math.abs(Math.cos(angle)))
}

/**
 * The remaining radial intervals of one grid cell, always a canonical set:
 * ordered, disjoint, non-negative `[lo, hi]` pairs. A cell missing from
 * `squareMaterial` is virgin material — `[stockBottomZ, initialTopZ[index]]` —
 * and an empty array is fully removed.
 *
 * This is the frozen transient API the square renderer consumes: read every
 * pair, not just the outermost endpoint, and rebuild when the cell lands in a
 * dirty region.
 */
export function squareMaterialIntervals(grid: SimulationGrid, index: number): readonly number[] {
  const stored = grid.squareMaterial?.get(index)
  if (stored !== undefined) return stored
  const baseline = grid.initialTopZ
  if (!baseline) return [grid.stockBottomZ, grid.stockTopZ]
  return [grid.stockBottomZ, baseline[index]]
}

/**
 * Replace one cell's remaining material. `intervals` must already be
 * canonical; the array is stored as given, which is why a cut always builds a
 * new one instead of editing a live cell in place.
 */
export function setSquareMaterialIntervals(
  grid: SimulationGrid,
  index: number,
  intervals: readonly number[],
): void {
  let map = grid.squareMaterial
  if (!map) {
    map = new Map<number, readonly number[]>()
    grid.squareMaterial = map
  }
  map.set(index, intervals)
}

/** Copy a square material map; the immutable interval arrays may share. */
export function cloneSquareMaterial(
  source: ReadonlyMap<number, readonly number[]> | undefined,
): Map<number, readonly number[]> | undefined {
  if (!source) return undefined
  return new Map(source)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/** Wrap an angle difference into (-π, π]; the blank is periodic. */
function wrapPi(angle: number): number {
  let wrapped = angle % TWO_PI
  if (wrapped > Math.PI) wrapped -= TWO_PI
  else if (wrapped <= -Math.PI) wrapped += TWO_PI
  return wrapped
}

/** A move in the unrolled sheet, already resolved to along/tip/angle axes. */
interface MoveGeometry {
  fromAlong: number
  toAlong: number
  fromAcross: number
  toAcross: number
  tipFrom: number
  tipTo: number
  /**
   * The explicit rotary program angle in radians at each end, or null when the
   * move carries none — in which case the program angle is the move's own
   * across position mapped through the frame, exactly as the sheet unrolls it.
   */
  angleFrom: number | null
  angleTo: number | null
  zero: number
  anglePerAcross: number
}

/**
 * The unwrapped machine angle between a cell's ray and the tool's program angle
 * at move parameter `s`, before the periodic wrap. `thetaAt` is this wrapped;
 * the angle window solves against the unwrapped form.
 */
function rawThetaAt(geometry: MoveGeometry, cellAcross: number, s: number): number {
  if (geometry.angleFrom !== null && geometry.angleTo !== null) {
    const materialAngle = (cellAcross - geometry.zero) * geometry.anglePerAcross
    return materialAngle - (geometry.angleFrom + (geometry.angleTo - geometry.angleFrom) * s)
  }
  const toolAcross = geometry.fromAcross + (geometry.toAcross - geometry.fromAcross) * s
  return (cellAcross - toolAcross) * geometry.anglePerAcross
}

/**
 * The machine angle between a cell's ray and the tool's program angle, in
 * radians. When the move carries no explicit rotary coordinate the difference
 * is taken from the across coordinates themselves, so a move and the same move
 * one circumference on are bit-identical rather than differing by a wrapped
 * 2π.
 */
function thetaAt(geometry: MoveGeometry, cellAcross: number, s: number): number {
  return wrapPi(rawThetaAt(geometry, cellAcross, s))
}

/** True when the move's program angle is constant over its whole travel. */
function angleIsConstant(geometry: MoveGeometry): boolean {
  return geometry.angleFrom !== null && geometry.angleTo !== null
    ? geometry.angleFrom === geometry.angleTo
    : geometry.fromAcross === geometry.toAcross
}

/**
 * Absolute widening applied to the proven angle bound before it is turned into
 * cells, in radians. Well above the rounding of the angular step (one Float64
 * ulp of an angle near π is ~1e-16, and the index solve is a handful of ulps),
 * and far below any cell. The index ranges are widened by a whole cell on top
 * of this, so the window is never narrower than the proof.
 */
const ANGLE_WINDOW_EPSILON = 1e-12

/**
 * The widest `|θ|` at which a cell can still lose material, or null when the
 * whole across loop must be searched.
 *
 * Proof. A material point at radius `u ≥ 0` on a cell's ray, at machine angle
 * `θ` from the tool's program angle, sits at radial `u·cos θ` and across
 * `u·|sin θ|` from the pivot. The tool body — the flat cutter's cylinder, the
 * ball and its shank — is confined to `|across| ≤ rt` about the tool's own bar
 * position and never reaches below the tip, so a hit needs both
 *
 *     u·|sin θ| ≤ rt        (across reach)
 *     u·cos θ ≥ tip         (radial floor; the ball's lowest point and the
 *                            shank's inner wall are both at or above the tip)
 *
 * with `tip ≥ tipMin` for every reachable move parameter (the tip is linear in
 * the parameter, so its minimum over any reachable sub-window is at least the
 * minimum over the whole move). For `tipMin > 0` the second inequality forces
 * `cos θ > 0` and `u ≥ tipMin / cos θ`; substituting into the first gives
 * `tipMin·tan|θ| ≤ rt`, i.e. `|θ| ≤ atan(rt / tipMin)`. The bound is necessary,
 * never sufficient, so widening it can only cost cells, never material.
 *
 * The material's own outer radius tightens this only through
 * `|θ| ≤ acos(tipMin / R)` (`R = side/√2`, the corner radius), which is looser
 * than the tan bound exactly when `rt² + tipMin² ≤ R²` — always true inside
 * the certified region `rt ≤ side/2`, `tipMin ≤ side/2`. It is therefore
 * omitted rather than rested on a material bound the kernel would have to scan
 * the grid to prove.
 *
 * A tip at or below the pivot (`tipMin ≤ 0`) makes the radial condition
 * satisfiable at any angle, and any non-finite input has no usable bound: both
 * return null for the full loop.
 */
function angleWindowBound(toolRadius: number, tipMin: number): number | null {
  if (!Number.isFinite(toolRadius) || !(toolRadius > 0)) return null
  if (!Number.isFinite(tipMin) || !(tipMin > 0)) return null
  const ratio = toolRadius / tipMin
  const bound = Math.atan(ratio)
  if (!Number.isFinite(bound) || !(bound > 0) || bound >= Math.PI) return null
  return bound
}

/** An inclusive range of across-cell indices. */
type AcrossRange = [number, number]

/**
 * The across coordinate of one cell centre, exactly as the apply loop computes
 * it. The window solves its edges against this same expression: once the sheet
 * origin is large the kernel's own `origin + (c + 0.5)·cell` rounds per cell,
 * and a model built from a first-cell angle plus `c·step` is not that value.
 */
function acrossCellCentre(acrossOrigin: number, cellSize: number, index: number): number {
  return acrossOrigin + (index + 0.5) * cellSize
}

/**
 * Safety factor on the Float64 rounding bound of the angle-index solve. The
 * linear model's error is accumulated from two rounded angle evaluations, a
 * rounded across coordinate, a rounded explicit angle and the rounded step —
 * roughly a dozen unit roundoffs. `Number.EPSILON` is two unit roundoffs, so
 * sixteen of them is deliberately generous. The solve may absorb one whole
 * cell of that error; past that the writer falls back to the full loop.
 */
const INDEX_SOLVE_ERROR_FACTOR = 16

/**
 * Hard cap on the periodic copies the wrap loop may visit. A sheet that spans a
 * realistic number of circumferences needs a handful; anything larger is a
 * pathological solve and returns the full range instead of iterating.
 */
const MAX_WRAP_COPIES = 4096

/**
 * The across cells whose ray can lie within `bound` of the tool's program
 * angle, as ascending inclusive index ranges. The angle is periodic, so a
 * window that reaches the seam is two ranges (one at each end of the sheet); a
 * window that covers the circumference is the single full range.
 *
 * The mapping is the one `rawThetaAt` uses, solved for the across coordinate:
 * the unwrapped angle is linear in the cell index (the across coordinates are
 * uniform), so each periodic copy of `[−bound, bound]` gives one `c` interval.
 * Ranges are widened by a whole cell at each end on top of
 * `ANGLE_WINDOW_EPSILON`, so the Float64 solve can never exclude a cell whose
 * angle sits on the bound.
 *
 * That padding is only good for one cell of error, so the solve is guarded by
 * `INDEX_SOLVE_ERROR_FACTOR`: the error of the linear model grows with the
 * angle and across magnitudes (a program angle near 1e18°, or a sheet origin
 * near 1e16 over 0.03 cells), and once it could exceed a cell the whole
 * circumference is searched. The loop itself is also bounded: a finite angle
 * large enough to make the periodic index non-safe-integer would leave
 * `wrap += 1` a no-op, so that falls back as well.
 */
function acrossWindow(
  geometry: MoveGeometry,
  acrossOrigin: number,
  cellSize: number,
  acrossCount: number,
  bound: number,
): AcrossRange[] {
  const full: AcrossRange[] = [[0, acrossCount - 1]]
  const step = geometry.anglePerAcross * cellSize
  if (!Number.isFinite(step) || !(step > 0) || acrossCount <= 0) return full
  const widened = bound + ANGLE_WINDOW_EPSILON * Math.max(1, bound)
  if (!Number.isFinite(widened) || widened >= Math.PI) return full

  // The unwrapped angle at the first and last cell centres, both computed with
  // the kernel's own across expression rather than by stepping from the first
  // cell, because the kernel rounds that coordinate per cell.
  const u0 = rawThetaAt(geometry, acrossCellCentre(acrossOrigin, cellSize, 0), 0)
  if (!Number.isFinite(u0)) return full
  const lastAngle = rawThetaAt(geometry, acrossCellCentre(acrossOrigin, cellSize, acrossCount - 1), 0)
  if (!Number.isFinite(lastAngle)) return full

  // The error of `angle(c) ≈ u0 + c·step`, in angle units. Every term is a
  // magnitude whose Float64 representation can be off by about one ulp: the
  // angles themselves (which include the explicit program angle), and the
  // across coordinates fed through `anglePerAcross` (which include the sheet
  // origin and the pivot `zero`). Four ulps of their sum, divided by the angle
  // per cell, is the worst-case index error; the solve may absorb one cell.
  const acrossScale = Math.max(
    Math.abs(acrossOrigin),
    Math.abs(geometry.zero),
    Math.abs(acrossCellCentre(acrossOrigin, cellSize, 0)),
    Math.abs(acrossCellCentre(acrossOrigin, cellSize, acrossCount - 1)),
    Math.abs(geometry.fromAcross),
    Math.abs(geometry.toAcross),
    cellSize,
  )
  const angleScale = Math.max(
    Math.abs(u0),
    Math.abs(lastAngle),
    Math.abs(geometry.angleFrom ?? 0),
    Math.abs(geometry.angleTo ?? 0),
    Math.abs(step) * Math.max(1, acrossCount),
  )
  const solveError = Number.EPSILON * INDEX_SOLVE_ERROR_FACTOR
    * (angleScale + Math.abs(geometry.anglePerAcross) * acrossScale)
  if (!(solveError <= step)) return full

  // One interval per periodic copy of the window that the grid can reach. The
  // reach carries a whole cell on top of the widened bound, because the ±1
  // index widening below can pull in a cell whose angle lies up to one cell
  // outside the span.
  const reach = widened + step
  const first = Math.floor((Math.min(u0, lastAngle) - reach) / TWO_PI)
  const last = Math.ceil((Math.max(u0, lastAngle) + reach) / TWO_PI)
  // `wrap += 1` must actually advance: above the safe-integer range it does
  // not, and the loop would run forever on a finite but enormous program angle.
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return full
  const copies = last - first
  if (!(copies >= 0) || !Number.isSafeInteger(copies) || copies > MAX_WRAP_COPIES || copies > acrossCount + 4) {
    return full
  }

  const ranges: AcrossRange[] = []
  for (let wrap = first; wrap <= last; wrap += 1) {
    const lowAngle = -widened + TWO_PI * wrap
    const highAngle = widened + TWO_PI * wrap
    // c·step + u0 ∈ [lowAngle, highAngle], solved for c and widened one cell.
    const from = Math.max(0, Math.ceil((lowAngle - u0) / step) - 1)
    const to = Math.min(acrossCount - 1, Math.floor((highAngle - u0) / step) + 1)
    if (from <= to) ranges.push([from, to])
  }
  if (ranges.length === 0) return []
  ranges.sort((a, b) => a[0] - b[0])

  // The copies of one periodic window meet at the seam; an adjacent pair is the
  // same window and merges.
  const merged: AcrossRange[] = []
  for (const [from, to] of ranges) {
    const lastRange = merged.length > 0 ? merged[merged.length - 1] : null
    if (lastRange && from <= lastRange[1] + 1) {
      if (to > lastRange[1]) lastRange[1] = to
    } else {
      merged.push([from, to])
    }
  }
  return merged
}

/**
 * The move-parameter bracket width below which another golden-section step
 * cannot change the stored result. Kept next to its only use so the derivation
 * stays with the code.
 *
 * The parameter is the fraction along the move, so the bracket's own scale is
 * its bounds, about one; one Float32 ulp of the parameter is `ULP`. A concave
 * maximum is value-stable at this width: the returned value is the maximum of
 * the sampled points, and near an interior maximum the value error is
 * quadratic in the argument error, so the bracket already resolves it far past
 * one ulp. A maximum that lands on a domain endpoint is returned exactly. Both
 * loops keep `CONVERGE_ITERATIONS` as the hard ceiling; the old fixed 96 drove
 * the bracket to ~1e-20, twenty orders below anything the grid can hold.
 */
const SEARCH_TOLERANCE_ULPS = ULP / 64

function searchTolerance(lo: number, hi: number): number {
  return SEARCH_TOLERANCE_ULPS * Math.max(1, Math.abs(lo), Math.abs(hi))
}

/**
 * Whether every stored radial quantity a crossing determines has stopped
 * moving across its bracket in the space the grid actually stores.
 *
 * The parameter tolerance alone is not enough for a *crossing*. Its stored
 * endpoint is a closed-form function of `s` (a tip plane, a ball centre, a
 * cylinder reach) whose slope can be arbitrarily large where the feasibility
 * margin touches zero: at a tangential boundary the reach changes like
 * `√(s − s*)`, so a bracket a thousand times below one parameter ulp can still
 * move the endpoint by a whole Float32 ulp. That is not academic: side 12, a
 * cell at along 0.5 whose ray is 0.6 rad from the tool, a flat 2.4 cutter and a
 * (0, 4.6) → (2.9000000572999998, 0) move leave a `[0, 1.1921845e-7]` sliver
 * under the parameter-only stop (the endpoint moved just across the
 * compaction threshold) where fixed-96 stores one interval.
 *
 * So the crossing also has to settle the endpoint at Float32 resolution, which
 * is what `Math.fround` equality across the bracket means: `a` is the
 * infeasible side and `b` the non-negative side, so the exact crossing value
 * lies between them, and if both ends round to the same Float32 value the whole
 * bracket stores one endpoint — well inside one Float32 ulp. Each closure is a
 * quantity the band will store (a flat floor, a shank's inner wall or reach, a
 * ball's lower or upper ray intersection), so this is the stored material, not
 * a proxy scaled from the parameter. Floating point floors the achievable
 * width, so `CONVERGE_ITERATIONS` remains the hard ceiling.
 */
type EndpointValue = (s: number) => number

function storedEndpointsAgree(
  endpoints: readonly EndpointValue[],
  a: number,
  b: number,
): boolean {
  for (const endpoint of endpoints) {
    if (Math.fround(endpoint(a)) !== Math.fround(endpoint(b))) return false
  }
  return true
}

/**
 * The converged maximum of a concave function on `[lo, hi]`, by golden section
 * with the endpoints also compared. Concavity is what makes the sweep exact: a
 * uniform scan can step over a narrow window, a converged maximum cannot.
 *
 * The loop stops once the bracket is below `searchTolerance`, because another
 * step cannot move the stored value; `CONVERGE_ITERATIONS` remains the hard
 * upper bound.
 */
function maximizeConcave(
  evaluate: (s: number) => number,
  lo: number,
  hi: number,
  search: SearchControl,
  // Callers that already have the endpoint values (the feasible-domain search
  // does) pass them in, so the maximum evaluates each endpoint once instead of
  // once for the sign check and again for the final comparison.
  loValue: number = evaluate(lo),
  hiValue: number = evaluate(hi),
): { s: number; value: number } {
  const invPhi = (Math.sqrt(5) - 1) / 2
  const tolerance = searchTolerance(lo, hi)
  const earlyExit = !search.legacy
  let a = lo
  let b = hi
  let c = b - (b - a) * invPhi
  let d = a + (b - a) * invPhi
  let fc = evaluate(c)
  let fd = evaluate(d)
  let iterations = 0
  for (let i = 0; i < CONVERGE_ITERATIONS; i += 1) {
    if (earlyExit && b - a <= tolerance) break
    iterations += 1
    if (fc > fd) {
      b = d
      d = c
      fd = fc
      c = b - (b - a) * invPhi
      fc = evaluate(c)
    } else {
      a = c
      c = d
      fc = fd
      d = a + (b - a) * invPhi
      fd = evaluate(d)
    }
  }
  if (search.stats) {
    search.stats.maximizeCalls += 1
    search.stats.maximizeIterations += iterations
  }
  const mid = (a + b) / 2
  let bestS = mid
  let bestValue = evaluate(mid)
  if (loValue > bestValue) {
    bestValue = loValue
    bestS = lo
  }
  if (hiValue > bestValue) {
    bestValue = hiValue
    bestS = hi
  }
  return { s: bestS, value: bestValue }
}

/** The converged minimum of a convex function on `[lo, hi]`. */
function minimizeConvex(
  evaluate: (s: number) => number,
  lo: number,
  hi: number,
  search: SearchControl,
): { s: number; value: number } {
  const peak = maximizeConcave((s) => -evaluate(s), lo, hi, search)
  return { s: peak.s, value: -peak.value }
}

/**
 * The non-negative side of a sign change of `evaluate` on `[negative, positive]`.
 * The bracket is halved until it is below `searchTolerance` **and** the stored
 * radial quantities the crossing determines have stopped moving
 * (`storedEndpointsAgree`), then the last known non-negative point is returned.
 * The value check is the part that guarantees a Float32-stable endpoint: the
 * parameter tolerance alone is not enough where the endpoint's slope is large
 * (see `storedEndpointsAgree`).
 */
function bisectCrossing(
  evaluate: (s: number) => number,
  negative: number,
  positive: number,
  search: SearchControl,
  endpoints: readonly EndpointValue[],
): number {
  const tolerance = searchTolerance(negative, positive)
  const earlyExit = !search.legacy
  let a = negative
  let b = positive
  let iterations = 0
  for (let i = 0; i < CONVERGE_ITERATIONS; i += 1) {
    if (earlyExit && Math.abs(b - a) <= tolerance) {
      if (search.stats) {
        search.stats.endpointCalls += 1
        search.stats.endpointChecks += endpoints.length
      }
      if (storedEndpointsAgree(endpoints, a, b)) break
    }
    const mid = (a + b) / 2
    // A tangential endpoint changes like √(s − s*), so the value check can sit
    // just above tolerance when the bracket is already two adjacent doubles.
    // No further halving can move either end, and legacy's 96 iterations would
    // return this same `b`, so stop here rather than spin to the hard cap.
    if (earlyExit && (mid === a || mid === b)) break
    iterations += 1
    if (evaluate(mid) >= 0) b = mid
    else a = mid
  }
  if (search.stats) {
    search.stats.bisectCalls += 1
    search.stats.bisectIterations += iterations
  }
  return b
}

/**
 * The sub-interval of `[lo, hi]` on which a concave `evaluate` is non-negative,
 * or null when it never is. A concave function's non-negative set is a single
 * interval, so the maximum is converged and each side's crossing is bisected —
 * a narrow feasible window between any two scan nodes is still found exactly.
 * The endpoint values are computed once here and passed into the maximum, so
 * the feasible-domain search never evaluates the same endpoint twice, and the
 * `endpoints` closures let each crossing settle in stored-value space as well
 * as in the parameter (see `bisectCrossing`).
 */
function concaveDomain(
  evaluate: (s: number) => number,
  lo: number,
  hi: number,
  search: SearchControl,
  endpoints: readonly EndpointValue[],
): [number, number] | null {
  if (!(hi > lo)) return evaluate(lo) >= 0 ? [lo, hi] : null
  const loValue = evaluate(lo)
  const hiValue = evaluate(hi)
  const peak = maximizeConcave(evaluate, lo, hi, search, loValue, hiValue)
  if (!(peak.value >= 0)) return null
  const left = loValue >= 0 ? lo : bisectCrossing(evaluate, lo, peak.s, search, endpoints)
  const right = hiValue >= 0 ? hi : bisectCrossing(evaluate, hi, peak.s, search, endpoints)
  if (search.stats) {
    // Test-only invariant: a crossing must be the non-negative side. The
    // stored endpoint is resolved to Float32, so an off-by-one-side return can
    // still be inside the tolerance and invisible in the stored values; this
    // check is what catches it.
    if (!(evaluate(left) >= 0)) search.stats.crossingsOnNegativeSide += 1
    if (!(evaluate(right) >= 0)) search.stats.crossingsOnNegativeSide += 1
  }
  return [left, right]
}

/**
 * The move-parameter window over which the tool's own bar position can reach a
 * cell, i.e. `|along(s) − cellAlong| ≤ rt`. Null when the move never reaches
 * it — that is the O(1) above-envelope rejection the generators rely on.
 */
function reachableWindow(cellAlong: number, geometry: MoveGeometry, rt: number): [number, number] | null {
  const d = geometry.toAlong - geometry.fromAlong
  if (d === 0) {
    return Math.abs(cellAlong - geometry.fromAlong) <= rt ? [0, 1] : null
  }
  const tLow = (cellAlong - rt - geometry.fromAlong) / d
  const tHigh = (cellAlong + rt - geometry.fromAlong) / d
  const lo = Math.max(0, Math.min(tLow, tHigh))
  const hi = Math.min(1, Math.max(tLow, tHigh))
  return hi > lo ? [lo, hi] : null
}

/**
 * The radial bands a constant-angle move removes from one cell's ray, canonical
 * and ascending. Null when the body never meets the ray.
 *
 * The tool never changes orientation, so the ray's machine angle `θ` is fixed
 * and only the move parameter matters. Each part of the body is feasible where
 * its concave margin is non-negative:
 *
 *   - the flat cylinder and the ball's shank are feasible where
 *     `reach(s) − inner(s) ≥ 0`, with `reach = √(rt² − Δx(s)²)/|sin θ|` concave
 *     and `inner` linear (`tip/cos` for the flat, `(tip+rt)/cos` for the shank);
 *   - the ball is feasible where its discriminant
 *     `rt² − (tip+rt)²sin²θ − Δx(s)² ≥ 0`, a concave quadratic.
 *
 * A concave margin's non-negative set is one interval, so each part's feasible
 * parameters are found by a converged maximum plus bisected crossings and no
 * uniform scan can step over a narrow window. The parts' intervals form one or
 * two connected components; over a connected component the per-pose interval
 * `[min floor, max reach]` varies continuously, so the removed set is exactly
 * `[min floor, max reach]` there — the extrema are converged, never sampled.
 */
function constantAngleBands(
  cellAlong: number,
  cellAcross: number,
  geometry: MoveGeometry,
  rt: number,
  ball: boolean,
  loS: number,
  hiS: number,
  search: SearchControl,
): Array<[number, number]> | null {
  const theta = thetaAt(geometry, cellAcross, loS)
  const cos = Math.cos(theta)
  if (!(cos > 0)) return null
  const sinAbs = Math.abs(Math.sin(theta))
  const axial = sinAbs < AXIAL_EPSILON

  const alongDelta = geometry.toAlong - geometry.fromAlong
  const tipDelta = geometry.tipTo - geometry.tipFrom
  const dxAt = (s: number): number => cellAlong - geometry.fromAlong - alongDelta * s
  const tipAt = (s: number): number => geometry.tipFrom + tipDelta * s
  /** The cylinder wall's radial reach at `s`; only valid inside the strip. */
  const reachAt = (s: number): number => {
    const dx = dxAt(s)
    const squared = rt * rt - dx * dx
    return squared > 0 ? Math.sqrt(squared) / sinAbs : 0
  }

  const bands: Array<[number, number]> = []

  if (!ball) {
    const floorAt = (s: number): number => tipAt(s) / cos
    // The band is `[min floor, max reach]` over this feasible domain. Its low
    // end is `floorAt` at the domain ends; its high end is the maximum of
    // `reachAt`, which can be attained *at* a crossing-determined end (reach
    // increasing with the floor rising faster, or the mirror image). Both
    // stored quantities are therefore pinned at the crossing, not just the
    // floor.
    const domain = axial
      ? [loS, hiS] as [number, number]
      : concaveDomain((s) => reachAt(s) - floorAt(s), loS, hiS, search, [floorAt, reachAt])
    if (!domain) return null
    const low = Math.min(floorAt(domain[0]), floorAt(domain[1]))
    const high = axial ? Infinity : maximizeConcave(reachAt, domain[0], domain[1], search).value
    return high > low ? [[low, high]] : null
  }

  const centreAt = (s: number): number => tipAt(s) + rt
  /** The ball's ray discriminant from its centre and axial offset at `s`. */
  const discFrom = (centre: number, dx: number): number =>
    rt * rt - centre * centre * sinAbs * sinAbs - dx * dx
  /** The ball's ray discriminant; concave, so its non-negative set is one interval. */
  const discAt = (s: number): number => discFrom(centreAt(s), dxAt(s))
  // Each of these needs the centre, the axial offset and the discriminant; the
  // discriminant is built from the same two values instead of recomputing them,
  // which halves the closure work on the hot ball path.
  const sphereLow = (s: number): number => {
    const centre = centreAt(s)
    return centre * cos - Math.sqrt(Math.max(0, discFrom(centre, dxAt(s))))
  }
  const sphereHigh = (s: number): number => {
    const centre = centreAt(s)
    return centre * cos + Math.sqrt(Math.max(0, discFrom(centre, dxAt(s))))
  }

  // The sphere's two ray intersections are its stored low and high, and at a
  // discriminant crossing they coincide at `centre·cos`. The non-negative-side
  // endpoint the bisection returns sits just inside the domain, and the sign of
  // the centre's slope decides which of the two intersections is the one that
  // settles in Float32, so both are checked. The shank's boundary values are
  // its inner wall and its reach, which also meet at its crossing.
  const shankInnerAt = (s: number): number => centreAt(s) / cos
  const sphereDomain = concaveDomain(discAt, loS, hiS, search, [sphereLow, sphereHigh])
  const shankDomain: [number, number] | null = axial
    ? [loS, hiS]
    : concaveDomain((s) => reachAt(s) - shankInnerAt(s), loS, hiS, search, [shankInnerAt, reachAt])

  const domains = [sphereDomain, shankDomain].filter((domain): domain is [number, number] => domain !== null)
  if (domains.length === 0) return null
  domains.sort((a, b) => a[0] - b[0])
  const components: Array<[number, number]> = []
  for (const domain of domains) {
    const last = components.length > 0 ? components[components.length - 1] : null
    if (last && domain[0] <= last[1]) {
      if (domain[1] > last[1]) last[1] = domain[1]
    } else {
      components.push([domain[0], domain[1]])
    }
  }

  const overlaps = (domain: [number, number], component: [number, number]): boolean =>
    domain[0] <= component[1] && domain[1] >= component[0]

  for (const [componentLow, componentHigh] of components) {
    let low = Infinity
    let high = -Infinity
    if (sphereDomain && overlaps(sphereDomain, [componentLow, componentHigh])) {
      const from = Math.max(componentLow, sphereDomain[0])
      const to = Math.min(componentHigh, sphereDomain[1])
      low = Math.min(low, minimizeConvex(sphereLow, from, to, search).value)
      high = Math.max(high, maximizeConcave(sphereHigh, from, to, search).value)
    }
    if (shankDomain && overlaps(shankDomain, [componentLow, componentHigh])) {
      const from = Math.max(componentLow, shankDomain[0])
      const to = Math.min(componentHigh, shankDomain[1])
      low = Math.min(low, centreAt(from) / cos, centreAt(to) / cos)
      high = Math.max(high, axial ? Infinity : maximizeConcave(reachAt, from, to, search).value)
    }
    if (high > low) bands.push([low, high])
  }

  if (bands.length === 0) return null
  return mergeIntervals(bands, 1e-9 * (1 + Math.abs(rt)))
}

/**
 * The radial bands a move removes from one cell's ray, canonical and ascending.
 * Null when the body never meets it.
 *
 * Only a constant-angle move reaches here: an angle-changing move below the
 * blank's envelope is refused before any material is touched (see
 * `applySquareMoveToGrid`), and an above-envelope one never reaches a cell. The
 * feasible parameter window and its extrema are solved from the body's
 * concavity in `constantAngleBands`, so the answer does not depend on a uniform
 * scan landing inside the window.
 */
function removedBandsForCell(
  cellAlong: number,
  cellAcross: number,
  geometry: MoveGeometry,
  rt: number,
  ball: boolean,
  search: SearchControl,
): Array<[number, number]> | null {
  const window = reachableWindow(cellAlong, geometry, rt)
  if (!window) return null
  return constantAngleBands(cellAlong, cellAcross, geometry, rt, ball, window[0], window[1], search)
}

/** Merge overlapping and touching intervals into a canonical ascending order. */
function mergeIntervals(intervals: Array<[number, number]>, epsilon: number): Array<[number, number]> {
  intervals.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const [lo, hi] of intervals) {
    if (!(hi > lo)) continue
    const last = merged.length > 0 ? merged[merged.length - 1] : null
    if (last && lo <= last[1] + epsilon) {
      if (hi > last[1]) last[1] = hi
    } else {
      merged.push([lo, hi])
    }
  }
  return merged
}

/**
 * Subtract one removed band from a canonical material array, returning a new
 * canonical array (or the same reference when nothing survived changed).
 */
function subtractBand(material: readonly number[], lo: number, hi: number): readonly number[] {
  let out: number[] | null = null
  for (let i = 0; i < material.length; i += 2) {
    const mLo = material[i]
    const mHi = material[i + 1]
    if (!(mHi > lo) || !(mLo < hi)) {
      // This interval is disjoint from the band and survives untouched.
      if (out) out.push(mLo, mHi)
      continue
    }
    if (!out) {
      out = []
      for (let j = 0; j < i; j += 1) out.push(material[j])
    }
    if (mLo < lo) out.push(mLo, Math.min(mHi, lo))
    if (mHi > hi) out.push(Math.max(mLo, hi), mHi)
  }
  return out ?? material
}

/**
 * Canonicalize a subtracted material array: merge bands that meet within one
 * Float32 ulp and drop intervals whose width is below it. Two geometrically
 * identical boundaries reached through different arithmetic differ by a few
 * Float32 ulps, and without this they would leave a hairline sliver that a
 * later pass could expose as a false surviving shell.
 */
function compactIntervals(intervals: number[]): number[] {
  const out: number[] = []
  for (let i = 0; i < intervals.length; i += 2) {
    const lo = intervals[i]
    const hi = intervals[i + 1]
    if (!(hi > lo)) continue
    const epsilon = Math.max(1, Math.abs(hi)) * ULP
    const last = out.length >= 2 ? out[out.length - 1] : null
    if (last !== null && lo - last <= epsilon) {
      if (hi > last) out[out.length - 1] = hi
      continue
    }
    if (hi - lo <= epsilon) continue
    out.push(lo, hi)
  }
  return out
}

/**
 * Whether two canonical interval arrays differ by more than one Float32 ulp at
 * any endpoint. The stored heights are Float32, so a removal smaller than that
 * resolves to the same value and is not a change — the just-touch boundary
 * must not count as removed material.
 */
function materialDiffers(next: readonly number[], previous: readonly number[]): boolean {
  if (next.length !== previous.length) return true
  for (let i = 0; i < next.length; i += 1) {
    const scale = Math.max(Math.abs(next[i]), Math.abs(previous[i]), 1)
    if (Math.abs(next[i] - previous[i]) > scale * ULP) return true
  }
  return false
}

function finitePoint(point: ToolpathPoint): boolean {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) return false
  if (point.a !== undefined && !Number.isFinite(point.a)) return false
  return true
}

/**
 * The physical square cut kernel. `move` is in the unrolled Around sheet: its
 * along coordinate is the bar axis, its `a` is the program angle the stock is
 * turned to, and `z` is the tool tip's radial distance above the pivot.
 * Returns the number of cells whose material actually changed and the dirty
 * rectangle, exactly like the flat/round kernel.
 *
 * A cell counts as changed whenever its remaining intervals lose material —
 * including an interior interval whose outer `topZ` is unchanged, which the
 * envelope-only representation could not report at all.
 *
 * `options` exists only for the #1016 tests: P1's convergence test can replay
 * the pre-P1 fixed-96 search and collect iteration counts, and P3's window test
 * can replay the pre-window every-cell loop and count the cells a replay
 * searches. Every production caller omits it and gets the early-exit search
 * inside the angle window, so the public call shape is unchanged.
 */
export function applySquareMoveToGrid(
  grid: SimulationGrid,
  move: ToolpathMove,
  toolRadius: number,
  toolType: ToolType,
  options?: SquareSearchOptions,
): SquareApplyResult {
  const bar = grid.squareBar
  if (!bar) return ZERO_RESULT
  if (!Number.isFinite(toolRadius) || toolRadius <= 0) {
    throw new RangeError(`square kernel: tool radius must be a positive finite number, got ${toolRadius}`)
  }
  if (!squareToolSupported(toolType)) {
    throw new RangeError(`square kernel: tool type '${toolType}' is not supported; the square kernel models flat and ball cutters only`)
  }
  if (!Number.isFinite(grid.cellSize) || grid.cellSize <= 0 || grid.cols <= 0 || grid.rows <= 0) {
    throw new RangeError('square kernel: grid cell size and dimensions must be positive and finite')
  }
  if (!finitePoint(move.from) || !finitePoint(move.to)) {
    throw new RangeError('square kernel: move coordinates must be finite')
  }

  const frame = bar.frame
  // The test-only options are read once; production takes the early-exit path
  // and the angle window.
  const search: SearchControl = {
    legacy: options?.legacyFixedSearch === true,
    stats: options?.searchIterations,
  }
  const loop: LoopControl = {
    fullLoop: options?.legacyFullLoop === true,
    tested: options?.testedCells,
  }
  const xAxis = frame.axis === 'x'
  const ball = toolType === 'ball_endmill'
  const rt = toolRadius
  const cellSize = grid.cellSize
  const alongCount = xAxis ? grid.cols : grid.rows
  const acrossCount = xAxis ? grid.rows : grid.cols
  const alongOrigin = xAxis ? grid.originX : grid.originY
  const acrossOrigin = xAxis ? grid.originY : grid.originX

  const fromAlong = xAxis ? move.from.x : move.from.y
  const toAlong = xAxis ? move.to.x : move.to.y
  const fromAcross = xAxis ? move.from.y : move.from.x
  const toAcross = xAxis ? move.to.y : move.to.x

  const anglePerAcross = TWO_PI / frame.circumference
  // The program angle is the move's explicit rotary coordinate when it carries
  // one, and otherwise the across position the sheet unrolls it to.
  const explicitAngle = move.from.a !== undefined && move.to.a !== undefined
  const angleFrom = explicitAngle ? (move.from.a as number) * Math.PI / 180 : null
  const angleTo = explicitAngle ? (move.to.a as number) * Math.PI / 180 : null

  const geometry: MoveGeometry = {
    fromAlong,
    toAlong,
    fromAcross,
    toAcross,
    tipFrom: move.from.z,
    tipTo: move.to.z,
    angleFrom,
    angleTo,
    zero: frame.zero,
    anglePerAcross,
  }

  // A tip above the whole blank can never reach any cell's outer surface: the
  // tip plane crossing z/cos θ is then above the material everywhere. This is
  // the above-envelope link the generators retract through, and it costs O(1).
  if (Math.min(move.from.z, move.to.z) >= grid.stockTopZ) {
    return ZERO_RESULT
  }

  // A move that turns the stock as it travels sweeps a rotating body whose
  // removed set is not certified at grid resolution, so it is refused
  // explicitly before any cell is touched rather than approximated by a fixed
  // pose sample. Generated square motion is constant-angle and its angle links
  // are above the envelope, returned just above; a constant explicit `a` with a
  // changing `across` is a constant-angle move too (the program angle is `a`).
  if (!angleIsConstant(geometry)) {
    throw new RangeError(
      'square kernel: a move that changes the program angle below the corner envelope is not supported; ' +
        'the square kernel certifies constant-angle cuts and plunges only',
    )
  }

  const topZ = grid.topZ
  const bottom = grid.stockBottomZ
  let changed = 0
  let dirtyColMin = grid.cols
  let dirtyColMax = -1
  let dirtyRowMin = grid.rows
  let dirtyRowMax = -1

  const [alongStart, alongEnd] = pointToCellRange(
    Math.min(fromAlong, toAlong) - rt,
    Math.max(fromAlong, toAlong) + rt,
    alongOrigin,
    cellSize,
    alongCount,
  )

  // Only the across cells inside the angle window can possibly lose material
  // (see `angleWindowBound`); everything outside it is skipped without a search
  // instead of searched all the way round the bar. The window is constant over
  // the move because a constant-angle move's θ depends on the cell's across
  // position alone, so it is solved once here. `legacyFullLoop` replays the old
  // every-cell loop through this same code.
  const tipMin = Math.min(geometry.tipFrom, geometry.tipTo)
  const bound = loop.fullLoop ? null : angleWindowBound(rt, tipMin)
  const acrossRanges: AcrossRange[] = bound === null
    ? [[0, acrossCount - 1]]
    : acrossWindow(geometry, acrossOrigin, cellSize, acrossCount, bound)

  const tested = loop.tested
  for (let a = alongStart; a <= alongEnd; a += 1) {
    const along = alongOrigin + (a + 0.5) * cellSize
    for (const [rangeStart, rangeEnd] of acrossRanges) {
      for (let c = rangeStart; c <= rangeEnd; c += 1) {
        const across = acrossCellCentre(acrossOrigin, cellSize, c)
        const col = xAxis ? a : c
        const row = xAxis ? c : a
        const idx = row * grid.cols + col
        const height = topZ[idx]
        if (!(height > bottom + 1e-12)) continue

        if (tested) tested.tested += 1
        const bands = removedBandsForCell(along, across, geometry, rt, ball, search)
        if (!bands) continue
        if (tested) tested.withBand += 1

        const material = squareMaterialIntervals(grid, idx)
        let next: readonly number[] = material
        for (const [bandLo, bandHi] of bands) {
          const lo = bandLo > bottom ? bandLo : bottom
          const hi = bandHi < height ? bandHi : height
          if (!(hi > lo)) continue
          next = subtractBand(next, lo, hi)
        }
        if (next !== material) next = compactIntervals([...next])
        if (!materialDiffers(next, material)) continue

        setSquareMaterialIntervals(grid, idx, next)
        topZ[idx] = next.length > 0 ? Math.fround(next[next.length - 1]) : bottom
        changed += 1
        if (col < dirtyColMin) dirtyColMin = col
        if (col > dirtyColMax) dirtyColMax = col
        if (row < dirtyRowMin) dirtyRowMin = row
        if (row > dirtyRowMax) dirtyRowMax = row
      }
    }
  }

  return {
    changedCount: changed,
    dirtyRegion: changed > 0 ? { colMin: dirtyColMin, colMax: dirtyColMax, rowMin: dirtyRowMin, rowMax: dirtyRowMax } : null,
  }
}

function pointToCellRange(min: number, max: number, origin: number, cellSize: number, count: number): [number, number] {
  const start = clamp(Math.floor((min - origin) / cellSize), 0, count - 1)
  const end = clamp(Math.floor((max - origin) / cellSize), 0, count - 1)
  return [Math.min(start, end), Math.max(start, end)]
}
