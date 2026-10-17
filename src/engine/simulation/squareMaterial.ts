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
 */

import type { ToolType } from '../../types/project'
import type { ToolpathMove, ToolpathPoint } from '../toolpaths/types'
import type { DirtyRegion, SimulationGrid } from './types'

const TWO_PI = Math.PI * 2

/**
 * Hard upper bound on the golden-section extrema and the bisected
 * feasible-window crossings. A bracket shrinks by the golden ratio (~0.618) per
 * step, so 96 reaches Float64 resolution long before the budget runs out. The
 * loops now stop as soon as the bracket is below `searchTolerance`, which is
 * where both the concave maximum and the crossings are already resolved past
 * one Float32 ulp of the stored material (see that function); this stays as a
 * safety net so a pathological bracket can never loop without end.
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
   * zero; it is recorded here because the tolerance is far below a stored ulp
   * and only a direct invariant check can see a sign-side regression.
   */
  crossingsOnNegativeSide: number
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

/** The explicit rotary program angle at move parameter `s`, or null. */
function explicitAngleAt(geometry: MoveGeometry, s: number): number | null {
  if (geometry.angleFrom === null || geometry.angleTo === null) return null
  return geometry.angleFrom + (geometry.angleTo - geometry.angleFrom) * s
}

/**
 * The machine angle between a cell's ray and the tool's program angle, in
 * radians. When the move carries no explicit rotary coordinate the difference
 * is taken from the across coordinates themselves, so a move and the same move
 * one circumference on are bit-identical rather than differing by a wrapped
 * 2π.
 */
function thetaAt(geometry: MoveGeometry, cellAcross: number, s: number): number {
  const explicit = explicitAngleAt(geometry, s)
  if (explicit !== null) {
    const materialAngle = (cellAcross - geometry.zero) * geometry.anglePerAcross
    return wrapPi(materialAngle - explicit)
  }
  const toolAcross = geometry.fromAcross + (geometry.toAcross - geometry.fromAcross) * s
  return wrapPi((cellAcross - toolAcross) * geometry.anglePerAcross)
}

/** True when the move's program angle is constant over its whole travel. */
function angleIsConstant(geometry: MoveGeometry): boolean {
  return geometry.angleFrom !== null && geometry.angleTo !== null
    ? geometry.angleFrom === geometry.angleTo
    : geometry.fromAcross === geometry.toAcross
}

/**
 * The move-parameter bracket width below which another search step cannot
 * change the stored result. Kept next to its only use so the derivation stays
 * with the code.
 *
 * The parameter is the fraction along the move, so the bracket's own scale is
 * its bounds, about one; one Float32 ulp of the parameter is `ULP`. A stored
 * radial endpoint is a closed-form function of `s` (a tip plane over `cos θ`, a
 * ball centre, a cylinder reach), so its error is the bracket width times that
 * slope, and the band is then clipped against the Float32 cell heights. One
 * ulp of the parameter still leaves a few clipped endpoints on the other side
 * of that Float32 boundary — a one-ulp move in the stored material, which is
 * the most the grid can express but is not "resolved past one ulp". The extra
 * 1/64 keeps the boundary error far below the height's ulp, so the clamped
 * endpoint is stable and the seeded replay stores bit-identical Float32
 * values. A concave maximum needs far less: its value error is quadratic in the
 * argument error, so the same bracket resolves it far past one ulp. Both loops
 * keep `CONVERGE_ITERATIONS` as the hard ceiling; the old fixed 96 drove the
 * bracket to ~1e-20, twenty orders below anything the grid can hold.
 */
const SEARCH_TOLERANCE_ULPS = ULP / 64

function searchTolerance(lo: number, hi: number): number {
  return SEARCH_TOLERANCE_ULPS * Math.max(1, Math.abs(lo), Math.abs(hi))
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
 * The bracket is halved until it is below `searchTolerance`, then the last
 * known non-negative point is returned; another halving cannot move the stored
 * endpoint by a Float32 ulp.
 */
function bisectCrossing(
  evaluate: (s: number) => number,
  negative: number,
  positive: number,
  search: SearchControl,
): number {
  const tolerance = searchTolerance(negative, positive)
  const earlyExit = !search.legacy
  let a = negative
  let b = positive
  let iterations = 0
  for (let i = 0; i < CONVERGE_ITERATIONS; i += 1) {
    if (earlyExit && Math.abs(b - a) <= tolerance) break
    iterations += 1
    const mid = (a + b) / 2
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
 * the feasible-domain search never evaluates the same endpoint twice.
 */
function concaveDomain(
  evaluate: (s: number) => number,
  lo: number,
  hi: number,
  search: SearchControl,
): [number, number] | null {
  if (!(hi > lo)) return evaluate(lo) >= 0 ? [lo, hi] : null
  const loValue = evaluate(lo)
  const hiValue = evaluate(hi)
  const peak = maximizeConcave(evaluate, lo, hi, search, loValue, hiValue)
  if (!(peak.value >= 0)) return null
  const left = loValue >= 0 ? lo : bisectCrossing(evaluate, lo, peak.s, search)
  const right = hiValue >= 0 ? hi : bisectCrossing(evaluate, hi, peak.s, search)
  if (search.stats) {
    // Test-only invariant: a crossing must be the non-negative side. The
    // tolerance is far below one stored ulp, so an off-by-one-side return
    // cannot be seen in the stored values; this check is what catches it.
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
    const domain = axial
      ? [loS, hiS] as [number, number]
      : concaveDomain((s) => reachAt(s) - floorAt(s), loS, hiS, search)
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

  const sphereDomain = concaveDomain(discAt, loS, hiS, search)
  const shankDomain: [number, number] | null = axial
    ? [loS, hiS]
    : concaveDomain((s) => reachAt(s) - centreAt(s) / cos, loS, hiS, search)

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
 * `options` exists only for the #1016-P1 convergence test: it can replay the
 * pre-P1 fixed-96 search and collect iteration counts. Every production caller
 * omits it and gets the early-exit search, so the public call shape is unchanged.
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
  // The test-only options are read once; production takes the early-exit path.
  const search: SearchControl = {
    legacy: options?.legacyFixedSearch === true,
    stats: options?.searchIterations,
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

  for (let a = alongStart; a <= alongEnd; a += 1) {
    const along = alongOrigin + (a + 0.5) * cellSize
    for (let c = 0; c < acrossCount; c += 1) {
      const across = acrossOrigin + (c + 0.5) * cellSize
      const col = xAxis ? a : c
      const row = xAxis ? c : a
      const idx = row * grid.cols + col
      const height = topZ[idx]
      if (!(height > bottom + 1e-12)) continue

      const bands = removedBandsForCell(along, across, geometry, rt, ball, search)
      if (!bands) continue

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
