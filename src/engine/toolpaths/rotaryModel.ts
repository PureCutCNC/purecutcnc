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
import type { BarStock, Clamp, RoundStock } from '../../types/project'
import { barCentre, barInscribedRadius, barMaxRadius, barPivotZ, isSquareStock } from '../../types/barStock'
import { convertLength, type Units } from '../../utils/units'
import { minRenderHeight } from '../csg'
import { buildHeightMap, chooseHeightMapCellSize, safeToolTipZAt } from './finishSurfaceParallel'
import type { HeightMapWindow } from './finishSurfaceParallel'
import { rotaryTravelZ, squareBlankRetainedStub, squareBlankSectionExit, squareRotaryTouchRadius } from './squareRotaryStock'
import type { NormalizedTool, ToolpathMove, ToolpathPoint, ToolpathResult } from './types'
import type { ToolpathWarning, ToolpathWarningCode } from './warningCodes'

export interface RotaryModelMesh {
  /** Project coordinates of the model as placed in the unturned bar. */
  readonly positions: Float32Array
  readonly index: Uint32Array
}

export interface RotarySampleOptions {
  /** Angles in degrees, any order, any range (not reduced to one turn). */
  readonly anglesDeg: readonly number[]
  /** Positions along the bar's axis (project X for an X bar, Y for a Y bar). */
  readonly along: readonly number[]
  /** Requested height-map cell size before `chooseHeightMapCellSize` caps it. */
  readonly requestedCellSize: number
  /** Called after each angle with (done, total); worker generation reports progress through it later. */
  readonly onAngle?: (done: number, total: number) => void
  /** Return true to stop early; the result then holds the angles done so far. */
  readonly shouldStop?: () => boolean
}

export interface RotarySampling {
  readonly anglesDeg: readonly number[]
  readonly along: readonly number[]
  /**
   * One row per angle, one value per `along` position: the tool tip's radius
   * from the bar's turning pivot (tool tip height − `barPivotZ`) where the tool
   * may go without gouging the model, or `NaN` where no model lies under the
   * tool (free travel). Values may be negative (below the pivot); the
   * generators decide what to do with that. On a square blank a value may
   * exceed the inscribed radius — the retained corners are material.
   */
  readonly tipRadius: readonly Float32Array[]
  readonly stopped: boolean
  /**
   * False when the tool geometry handed to the sampler cannot describe a
   * cutter at all (`radius` not finite or not positive). Such a result carries
   * no angle rows, so an invalid radius can never be mistaken for the
   * legitimate "no model under the tool" sample, which is a `NaN` inside a
   * row. The rotary generators refuse before sampling; this keeps a direct
   * caller from turning a meaningless sample into motion.
   */
  readonly valid: boolean
}

/** The turned X/Y bounds of a mesh, accumulated by `turnModelInto`. */
interface TurnedBounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

/**
 * Write `positions` turned to `angleDeg` into `out`, and return the turned
 * points' X/Y bounds.
 *
 * This is `toolSpacePoint` inlined so the cos/sin, centre and half-height are
 * computed once per angle and no point object is built per vertex (issue #1015
 * slice J): on the 1.47 M-vertex bust bench, turning fell from about 860 ms an
 * angle through `toolSpacePoint` to about 29 ms inlined. The arithmetic is
 * deliberately identical to `rotaryFrame.toolSpacePoint` --
 * `centre + across * cos - up * sin` and `height + across * sin + up * cos` --
 * so a vertex here is bit-identical to the frame function's result stored in a
 * Float32. The test asserts that on the fixtures and on random vertices at
 * random angles on both bar axes; keep the two in step.
 *
 * `out` is a plain buffer the caller may reuse across angles; nothing here
 * retains it. The bounds are folded into the same pass (a second full scan per
 * angle `computeXYBounds` used to pay). They are accumulated on the exact
 * turned values and rounded to Float32 before they are returned: rounding is
 * monotone, so `Math.fround(min)` is the minimum of the rounded values, and the
 * result is exactly `computeXYBounds(out)`. Returning the unrounded value would
 * move the height map's origin by a fraction of a Float32 ulp and change which
 * cells a boundary triangle hits.
 */
function turnModelInto(
  out: Float32Array,
  positions: Float32Array,
  stock: BarStock,
  angleDeg: number,
): TurnedBounds {
  const centre = barCentre(stock)
  const height = barPivotZ(stock)
  const t = (angleDeg * Math.PI) / 180
  const cos = Math.cos(t)
  const sin = Math.sin(t)
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  if (stock.axis === 'x') {
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i]
      const across = positions[i + 1] - centre
      const up = positions[i + 2] - height
      const y = centre + across * cos - up * sin
      out[i] = x
      out[i + 1] = y
      out[i + 2] = height + across * sin + up * cos
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  } else {
    for (let i = 0; i < positions.length; i += 3) {
      const across = positions[i] - centre
      const up = positions[i + 2] - height
      const x = centre + across * cos - up * sin
      const y = positions[i + 1]
      out[i] = x
      out[i + 1] = y
      out[i + 2] = height + across * sin + up * cos
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  return {
    minX: Math.fround(minX),
    maxX: Math.fround(maxX),
    minY: Math.fround(minY),
    maxY: Math.fround(maxY),
  }
}

/** The model's vertices as they sit when the stock is turned to `angleDeg`. */
export function turnedModelPositions(positions: Float32Array, stock: BarStock, angleDeg: number): Float32Array {
  const turned = new Float32Array(positions.length)
  turnModelInto(turned, positions, stock, angleDeg)
  return turned
}

/** Directions per turn in the strip triangle index; must be even. */
const STRIP_BUCKETS = 256

const TAU = Math.PI * 2

/**
 * Everything about a mesh that does not depend on the turn angle (issue #1015
 * slice L): the cross-section in the bar's own plane, the convex hull that owns
 * the turned bounds, the along extremes, and an index of which triangles can
 * reach the narrow strip of cells the samples actually read.
 */
interface RotaryStripPlan {
  /** `across` from the centreline and `up` from the half-height, per vertex. */
  readonly across: Float64Array
  readonly up: Float64Array
  /** The cross-section's convex hull as `(across, up)` pairs. */
  readonly hull: Float64Array
  readonly minAlong: number
  readonly maxAlong: number
  /** CSR offsets into `bucketTriangles`: `STRIP_BUCKETS + 1` entries. */
  readonly bucketStarts: Uint32Array
  readonly bucketTriangles: Uint32Array
  /** Triangle starts (offsets into `index`) that reach the strip at every turn. */
  readonly always: Uint32Array
  readonly bucketWidth: number
}

/** The arc of turn directions over which a triangle can reach the strip. */
interface StripArc {
  lo: number
  length: number
}

/** Every vertex's position in the bar's cross-section plane. */
function crossSection(positions: Float32Array, stock: BarStock): { across: Float64Array; up: Float64Array } {
  const centre = barCentre(stock)
  const height = barPivotZ(stock)
  const count = positions.length / 3
  const across = new Float64Array(count)
  const up = new Float64Array(count)
  if (stock.axis === 'x') {
    for (let v = 0; v < count; v++) {
      across[v] = positions[v * 3 + 1] - centre
      up[v] = positions[v * 3 + 2] - height
    }
  } else {
    for (let v = 0; v < count; v++) {
      across[v] = positions[v * 3] - centre
      up[v] = positions[v * 3 + 2] - height
    }
  }
  return { across, up }
}

/** The along-axis extremes `turnModelInto` folds into its turned bounds. */
function alongExtremes(positions: Float32Array, stock: BarStock): { min: number; max: number } {
  const offset = stock.axis === 'x' ? 0 : 1
  let min = Infinity
  let max = -Infinity
  for (let i = offset; i < positions.length; i += 3) {
    const value = positions[i]
    if (value < min) min = value
    if (value > max) max = value
  }
  return { min, max }
}

/**
 * The convex hull of the cross-section points, as `(across, up)` pairs.
 *
 * `turnModelInto` accumulates its turned Y (or X) extreme over every vertex, but
 * that value is `centre + across cos - up sin` -- a linear function of the
 * cross-section point -- so its extreme is always attained at a hull vertex.
 * Folding the same expression over the hull gives the same double, and
 * `Math.fround` of it the same Float32 bound, because rounding is monotone:
 * `Math.fround(min(v)) === min(Math.fround(v))`. The hull is computed once per
 * operation, so the 1.47 M-vertex bust pays one sort instead of a full vertex
 * scan every angle.
 *
 * Collinear points are dropped as the standard monotone chain does. That cannot
 * move an extreme: a point on the segment between two hull vertices takes a
 * value between theirs, so it is never the strict argmin, and the coordinates
 * are the Float32 the mesh stores, so the collinearity test is exact whenever
 * the products cancel. Only a genuinely convex vertex stays.
 */
function crossSectionHull(across: Float64Array, up: Float64Array): Float64Array {
  const count = across.length
  if (count === 0) return new Float64Array(0)
  const order: number[] = new Array(count)
  for (let i = 0; i < count; i++) order[i] = i
  order.sort((a, b) => (across[a] - across[b]) || (up[a] - up[b]))
  const clockwiseOrCollinear = (o: number, a: number, b: number): boolean => {
    const dx1 = across[a] - across[o]
    const dy1 = up[a] - up[o]
    const dx2 = across[b] - across[o]
    const dy2 = up[b] - up[o]
    return dx1 * dy2 - dy1 * dx2 <= 0
  }
  const hull: number[] = []
  for (let s = 0; s < count; s++) {
    const i = order[s]
    while (hull.length >= 2 && clockwiseOrCollinear(hull[hull.length - 2], hull[hull.length - 1], i)) hull.pop()
    hull.push(i)
  }
  const lowerEnd = hull.length + 1
  for (let s = count - 2; s >= 0; s--) {
    const i = order[s]
    while (hull.length >= lowerEnd && clockwiseOrCollinear(hull[hull.length - 2], hull[hull.length - 1], i)) hull.pop()
    hull.push(i)
  }
  if (hull.length >= 2 && hull[0] === hull[hull.length - 1]) hull.pop()
  const points = new Float64Array(hull.length * 2)
  for (let i = 0; i < hull.length; i++) {
    points[i * 2] = across[hull[i]]
    points[i * 2 + 1] = up[hull[i]]
  }
  return points
}

/**
 * The turned X/Y bounds of the whole mesh, computed the way `turnModelInto`
 * computes them without visiting every vertex: the along extent is constant at
 * every angle, and the across extreme is folded over the cross-section hull.
 */
function turnedBounds(
  hull: Float64Array,
  minAlong: number,
  maxAlong: number,
  stock: BarStock,
  angleDeg: number,
): TurnedBounds {
  const centre = barCentre(stock)
  const t = (angleDeg * Math.PI) / 180
  const cos = Math.cos(t)
  const sin = Math.sin(t)
  let minAcross = Infinity
  let maxAcross = -Infinity
  for (let i = 0; i < hull.length; i += 2) {
    const value = centre + hull[i] * cos - hull[i + 1] * sin
    if (value < minAcross) minAcross = value
    if (value > maxAcross) maxAcross = value
  }
  return stock.axis === 'x'
    ? { minX: Math.fround(minAlong), maxX: Math.fround(maxAlong), minY: Math.fround(minAcross), maxY: Math.fround(maxAcross) }
    : { minX: Math.fround(minAcross), maxX: Math.fround(maxAcross), minY: Math.fround(minAlong), maxY: Math.fround(maxAlong) }
}

/** Distance from the cross-section origin to the segment `a`-`b`. */
function segmentDistance(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const lengthSq = dx * dx + dy * dy
  let t = lengthSq > 0 ? -(ax * dx + ay * dy) / lengthSq : 0
  if (t < 0) t = 0
  else if (t > 1) t = 1
  const px = ax + dx * t
  const py = ay + dy * t
  return Math.sqrt(px * px + py * py)
}

/**
 * Write the arc of turn directions over which a cross-section triangle can
 * reach a strip of half-width `reach` around the axis, or return true when it
 * reaches the strip at every turn.
 *
 * A triangle point `p` is in the strip exactly when `|p| |sin(phi - psi)| <=
 * reach`, where `phi` is its direction and `psi` the strip's own direction.
 * Within `asin(reach / distance)` of the triangle's direction arc that can
 * happen, and the arc's own directions are covered by the triangle's span; the
 * two together are the returned interval. A triangle that comes within `reach`
 * of the axis -- the axis-crossing case included -- has some point projecting
 * into the strip for *every* direction, so it is `always`.
 */
function stripArc(
  across: Float64Array,
  up: Float64Array,
  v0: number,
  v1: number,
  v2: number,
  reach: number,
  out: StripArc,
): boolean {
  const a0 = across[v0], b0 = up[v0]
  const a1 = across[v1], b1 = up[v1]
  const a2 = across[v2], b2 = up[v2]
  // Edge functions of the origin: all three the same sign means it is outside.
  const e0 = (a1 - a0) * -b0 - (b1 - b0) * -a0
  const e1 = (a2 - a1) * -b1 - (b2 - b1) * -a1
  const e2 = (a0 - a2) * -b2 - (b0 - b2) * -a2
  if (!((e0 < 0 || e1 < 0 || e2 < 0) && (e0 > 0 || e1 > 0 || e2 > 0))) return true
  const distance = Math.min(
    segmentDistance(a0, b0, a1, b1),
    segmentDistance(a1, b1, a2, b2),
    segmentDistance(a2, b2, a0, b0),
  )
  if (!(distance > reach)) return true
  const delta = Math.asin(Math.min(1, reach / distance)) + 1e-9
  let s0 = Math.atan2(b0, a0)
  let s1 = Math.atan2(b1, a1)
  let s2 = Math.atan2(b2, a2)
  if (s0 > s1) { const swap = s0; s0 = s1; s1 = swap }
  if (s1 > s2) { const swap = s1; s1 = s2; s2 = swap }
  if (s0 > s1) { const swap = s0; s0 = s1; s1 = swap }
  const g0 = s1 - s0
  const g1 = s2 - s1
  const g2 = s0 + TAU - s2
  let maxGap = g0
  let lo = s1
  if (g1 > maxGap) { maxGap = g1; lo = s2 }
  if (g2 > maxGap) { maxGap = g2; lo = s0 }
  // Outside the triangle, the directions it covers are the complement of the
  // largest gap between its vertices. A rounding error that hides the outside
  // case is treated as "covers every direction".
  if (maxGap < Math.PI) return true
  const length = TAU - maxGap + 2 * delta
  if (!(length < TAU)) return true
  out.lo = lo - delta
  out.length = length
  return false
}

/** The bucket holding direction `angle` (radians, any range). */
function bucketIndex(angle: number, bucketWidth: number): number {
  let value = angle % TAU
  if (value < 0) value += TAU
  return Math.floor(value / bucketWidth) % STRIP_BUCKETS
}

/** Build the angle-independent strip plan for one `sampleRotaryModel` call. */
function buildStripPlan(
  mesh: RotaryModelMesh,
  stock: BarStock,
  tool: NormalizedTool,
  requestedCellSize: number,
  anglesDeg: readonly number[],
): RotaryStripPlan {
  const { across, up } = crossSection(mesh.positions, stock)
  const hull = crossSectionHull(across, up)
  const { min: minAlong, max: maxAlong } = alongExtremes(mesh.positions, stock)
  const bucketWidth = TAU / STRIP_BUCKETS
  const triangleCount = Math.floor(mesh.index.length / 3)
  // The widest strip any angle of this operation reads: `safeToolTipZAt` reads
  // `ceil(radius / cell)` cells either way from the sample row, the row's own
  // offset from the centreline adds under half a cell, and one more cell of
  // slack absorbs the grid arithmetic. A triangle that cannot reach this band
  // cannot touch any angle's window.
  let reach = 0
  for (const angle of anglesDeg) {
    const bounds = turnedBounds(hull, minAlong, maxAlong, stock, angle)
    const cellSize = chooseHeightMapCellSize(bounds, requestedCellSize, [])
    const candidate = (Math.ceil(tool.radius / cellSize) + 2) * cellSize
    if (candidate > reach) reach = candidate
  }
  if (!(reach > 0) || !Number.isFinite(reach)) {
    const all = new Uint32Array(triangleCount * 3)
    for (let t = 0; t < all.length; t++) all[t] = t
    return {
      across, up, hull, minAlong, maxAlong,
      bucketStarts: new Uint32Array(STRIP_BUCKETS + 1), bucketTriangles: new Uint32Array(0),
      always: all, bucketWidth,
    }
  }
  const arcFirst = new Int32Array(triangleCount)
  const arcLast = new Int32Array(triangleCount)
  const arc: StripArc = { lo: 0, length: 0 }
  let alwaysCount = 0
  for (let t = 0; t < triangleCount; t++) {
    const offset = t * 3
    if (stripArc(across, up, mesh.index[offset], mesh.index[offset + 1], mesh.index[offset + 2], reach, arc)) {
      arcFirst[t] = -1
      alwaysCount++
      continue
    }
    const first = bucketIndex(arc.lo, bucketWidth)
    const last = bucketIndex(arc.lo + arc.length, bucketWidth)
    // One bucket of slack each side absorbs the rounding in `delta`, the polar
    // angles and the grid arithmetic; the price is a little over-inclusion.
    const paddedFirst = (first + STRIP_BUCKETS - 1) % STRIP_BUCKETS
    const paddedLast = (last + 1) % STRIP_BUCKETS
    if (((paddedLast - paddedFirst + STRIP_BUCKETS) % STRIP_BUCKETS) + 1 >= STRIP_BUCKETS) {
      arcFirst[t] = -1
      alwaysCount++
      continue
    }
    arcFirst[t] = paddedFirst
    arcLast[t] = paddedLast
  }
  const always = new Uint32Array(alwaysCount)
  let alwaysIndex = 0
  for (let t = 0; t < triangleCount; t++) if (arcFirst[t] < 0) always[alwaysIndex++] = t * 3
  const bucketStarts = new Uint32Array(STRIP_BUCKETS + 1)
  for (let t = 0; t < triangleCount; t++) {
    const first = arcFirst[t]
    if (first < 0) continue
    const last = arcLast[t]
    if (last >= first) {
      for (let k = first; k <= last; k++) bucketStarts[k + 1]++
    } else {
      for (let k = first; k < STRIP_BUCKETS; k++) bucketStarts[k + 1]++
      for (let k = 0; k <= last; k++) bucketStarts[k + 1]++
    }
  }
  for (let k = 0; k < STRIP_BUCKETS; k++) bucketStarts[k + 1] += bucketStarts[k]
  const bucketTriangles = new Uint32Array(bucketStarts[STRIP_BUCKETS])
  const cursor = bucketStarts.slice(0, STRIP_BUCKETS)
  for (let t = 0; t < triangleCount; t++) {
    const first = arcFirst[t]
    if (first < 0) continue
    const last = arcLast[t]
    const offset = t * 3
    if (last >= first) {
      for (let k = first; k <= last; k++) bucketTriangles[cursor[k]++] = offset
    } else {
      for (let k = first; k < STRIP_BUCKETS; k++) bucketTriangles[cursor[k]++] = offset
      for (let k = 0; k <= last; k++) bucketTriangles[cursor[k]++] = offset
    }
  }
  return { across, up, hull, minAlong, maxAlong, bucketStarts, bucketTriangles, always, bucketWidth }
}

/**
 * Write the turned positions of `triangles` (offsets into `index`) into `out`,
 * with exactly the arithmetic `turnModelInto` uses -- `centre + across cos - up
 * sin` across and `height + across sin + up cos` up, stored in a Float32 -- so a
 * rasterised cell is bit-identical to the full-map sampler's.
 */
function turnStripTriangles(
  out: Float32Array,
  positions: Float32Array,
  index: Uint32Array,
  across: Float64Array,
  up: Float64Array,
  stock: BarStock,
  cos: number,
  sin: number,
  triangles: Uint32Array,
  count: number,
): void {
  const centre = barCentre(stock)
  const height = barPivotZ(stock)
  if (stock.axis === 'x') {
    for (let s = 0; s < count; s++) {
      const i = triangles[s]
      for (let j = 0; j < 3; j++) {
        const v = index[i + j]
        const p = v * 3
        const a = across[v]
        const u = up[v]
        out[p] = positions[p]
        out[p + 1] = centre + a * cos - u * sin
        out[p + 2] = height + a * sin + u * cos
      }
    }
    return
  }
  for (let s = 0; s < count; s++) {
    const i = triangles[s]
    for (let j = 0; j < 3; j++) {
      const v = index[i + j]
      const p = v * 3
      const a = across[v]
      const u = up[v]
      out[p] = centre + a * cos - u * sin
      out[p + 1] = positions[p + 1]
      out[p + 2] = height + a * sin + u * cos
    }
  }
}

export function sampleRotaryModel(
  mesh: RotaryModelMesh,
  stock: BarStock,
  tool: NormalizedTool,
  options: RotarySampleOptions,
  warnings: ToolpathWarning[],
): RotarySampling {
  const anglesDeg: number[] = []
  const along = [...options.along]
  const tipRadius: Float32Array[] = []
  // A tool radius that is not finite and positive cannot sample a surface: the
  // window arithmetic would silently read no cells and every row would be
  // `NaN`, which is indistinguishable from "no model under the tool". Return
  // no rows and an explicit invalid verdict instead, so no caller can turn
  // that failure into a cut along the axis (issue #1016 C2 correction M1).
  if (!(tool.radius > 0) || !Number.isFinite(tool.radius)) {
    return { anglesDeg, along, tipRadius, stopped: false, valid: false }
  }
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  // One turned buffer for the whole operation: the mesh is the same size at
  // every angle, and neither the height map nor the sampling retains it, so a
  // fresh 3 V Float32 per angle is allocation the run does not need. Only the
  // vertices of the triangles this angle rasterises are written into it.
  const turned = new Float32Array(mesh.positions.length)
  // A triangle can appear in both queried buckets, so the gathered list can be
  // twice the triangle count; anything beyond that would be a bug.
  const subset = new Uint32Array(2 * Math.floor(mesh.index.length / 3))
  let plan: RotaryStripPlan | null = null
  let stopped = false
  for (const angle of options.anglesDeg) {
    if (options.shouldStop?.()) {
      stopped = true
      break
    }
    // Built lazily so an immediate stop -- a cancelled worker -- never pays for
    // a 1.47 M-vertex hull and bucket index.
    plan ??= buildStripPlan(mesh, stock, tool, options.requestedCellSize, options.anglesDeg)
    const t = (angle * Math.PI) / 180
    const cos = Math.cos(t)
    const sin = Math.sin(t)
    const bbox = turnedBounds(plan.hull, plan.minAlong, plan.maxAlong, stock, angle)
    const angleWarnings: ToolpathWarning[] = []
    const cellSize = chooseHeightMapCellSize(bbox, options.requestedCellSize, angleWarnings)
    for (const warning of angleWarnings) {
      if (!warnings.some((existing) => existing.code === warning.code)) warnings.push(warning)
    }
    // Every sample sits on the line over the centreline, and `safeToolTipZAt`
    // only reads cells within `ceil(radius / cell)` of its own. Rasterising the
    // rows (X bar) or columns (Y bar) that line can reach reproduces every value
    // the sampling reads, out of a map whose grid is unchanged: same bbox, cell
    // size, origin, width and height (issue #1015 slice L). The map is not put
    // through `getCachedHeightMap`, whose key carries neither orientation nor
    // mesh and which only ever builds full maps.
    const margin = Math.ceil(tool.radius / cellSize) + 1
    const window: HeightMapWindow = stock.axis === 'x'
      ? { minRow: Math.floor((centre - bbox.minY) / cellSize) - margin, maxRow: Math.floor((centre - bbox.minY) / cellSize) + margin }
      : { minCol: Math.floor((centre - bbox.minX) / cellSize) - margin, maxCol: Math.floor((centre - bbox.minX) / cellSize) + margin }
    // Only triangles whose cross-section arc covers this turn's strip direction
    // can put a cell in that window. The bucket index is conservative -- a
    // triangle lands in every bucket its arc touches, padded a bucket either
    // side -- so the rasterised set is a superset of the covering triangles, and
    // a cell's value is the maximum over all covering triangles either way.
    let count = plan.always.length
    for (let i = 0; i < plan.always.length; i++) subset[i] = plan.always[i]
    for (const bucket of [bucketIndex(Math.PI / 2 - t, plan.bucketWidth), bucketIndex(Math.PI / 2 - t + Math.PI, plan.bucketWidth)]) {
      const start = plan.bucketStarts[bucket]
      const end = plan.bucketStarts[bucket + 1]
      for (let i = start; i < end; i++) subset[count++] = plan.bucketTriangles[i]
    }
    turnStripTriangles(turned, mesh.positions, mesh.index, plan.across, plan.up, stock, cos, sin, subset, count)
    const heightMap = buildHeightMap(turned, mesh.index, bbox, cellSize, {
      window,
      triangles: subset.subarray(0, count),
    })
    const row = new Float32Array(along.length)
    for (let i = 0; i < along.length; i++) {
      const x = stock.axis === 'x' ? along[i] : centre
      const y = stock.axis === 'x' ? centre : along[i]
      const z = safeToolTipZAt(x, y, heightMap, tool)
      row[i] = z === Number.NEGATIVE_INFINITY ? NaN : z - pivot
    }
    anglesDeg.push(angle)
    tipRadius.push(row)
    options.onAngle?.(anglesDeg.length, options.anglesDeg.length)
  }
  return { anglesDeg, along, tipRadius, stopped, valid: true }
}

export interface RotaryFinishParams {
  /** Distance between passes, measured round the bar's surface. */
  readonly stepover: number
  /** Distance between samples along a pass. */
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
 * Drop the collinear interior points of every run of `cut` moves that share one
 * pass, keeping the run's first and last point. A run never crosses a move that
 * turns the stock -- the same rule `linearMoveOptimization` follows (issue
 * #393): the merged move would keep only one endpoint's angle, and every angle
 * this toolpath emits is a command the machine must reach. Runs also stop where
 * the tool reverses along the bar, so a merge can never join two passes that
 * happen to line up in X through the link between them.
 */
function mergeCollinearCuts(moves: readonly ToolpathMove[], tolerance: number): { moves: ToolpathMove[]; dropped: number } {
  const merged: ToolpathMove[] = []
  let index = 0
  while (index < moves.length) {
    const first = moves[index]
    if (first.kind !== 'cut' || first.from.a !== first.to.a) {
      merged.push(first)
      index++
      continue
    }
    const direction = Math.sign((first.to.x - first.from.x) + (first.to.y - first.from.y))
    let end = index
    while (
      end + 1 < moves.length
      && moves[end + 1].kind === 'cut'
      && moves[end + 1].from.a === moves[end + 1].to.a
      && moves[end + 1].from.a === first.from.a
      && moves[end + 1].from.x === moves[end].to.x
      && moves[end + 1].from.y === moves[end].to.y
      && Math.sign((moves[end + 1].to.x - moves[end + 1].from.x) + (moves[end + 1].to.y - moves[end + 1].from.y)) === direction
    ) end++
    const points: ToolpathPoint[] = [moves[index].from]
    for (let i = index; i <= end; i++) points.push(moves[i].to)
    const kept = simplifyRun(points, tolerance)
    for (let i = 0; i + 1 < kept.length; i++) {
      merged.push({ kind: 'cut', from: kept[i], to: kept[i + 1] })
    }
    index = end + 1
  }
  return { moves: merged, dropped: moves.length - merged.length }
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
 */
function simplifyRun(points: readonly ToolpathPoint[], tolerance: number): ToolpathPoint[] {
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack: Array<[number, number]> = [[0, points.length - 1]]
  while (stack.length > 0) {
    const [first, last] = stack.pop() as [number, number]
    let split = -1
    let farthest = tolerance
    for (let i = first + 1; i < last; i++) {
      const distance = distanceFromLine(points[i], points[first], points[last])
      if (distance > farthest) {
        farthest = distance
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
 */
interface RotaryRun {
  readonly points: readonly ToolpathPoint[]
  readonly atStart: boolean
  readonly atEnd: boolean
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
 */
function emitRotaryRuns(
  moves: ToolpathMove[],
  here: ToolpathPoint | undefined,
  runs: readonly RotaryRun[],
  safeZ: number,
  travelZ: number,
  previousEndedAtEnd: boolean,
): { here: ToolpathPoint | undefined; endedAtEnd: boolean } {
  let current = here
  let endedAtEnd = false
  for (const run of runs) {
    const first = run.points[0]
    const canLink = current !== undefined && previousEndedAtEnd && run.atStart
      && current.x === first.x && current.y === first.y
    if (canLink && current) {
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
      // The along distance between the two samples: the run is over the
      // centreline, so only one of x and y changes, and this is the spacing.
      const spacing = Math.hypot(to.x - from.x, to.y - from.y)
      const rise = to.z - from.z
      if (Math.abs(rise) > spacing) {
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
 * The most samples one rotary operation may derive (`passes x along positions`).
 * Both counts are quotients of caller parameters (`2 pi R / stepover` and
 * `span / sampleSpacing`), so a value that is positive and finite can still ask
 * for tens of billions of samples; `Array.from` on that length exhausts the
 * worker rather than refusing. Sixteen million keeps the per-angle tip rows
 * under a few hundred megabytes and is far above any job the panel describes.
 */
const MAX_ROTARY_SAMPLES = 16_000_000

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
function rotaryRefusal(stock: BarStock, params: RotaryFinishParams): ToolpathWarningCode | null {
  const radius = barInscribedRadius(stock)
  if (!(radius > 0) || !Number.isFinite(radius)) return 'aroundStockMismatch'
  if (!(params.stepover > 0) || !Number.isFinite(params.stepover)) return 'operationStepoverRatioRange'
  if (!(params.sampleSpacing > 0) || !Number.isFinite(params.sampleSpacing)) return 'operationStepoverRatioRange'
  // A non-finite cell makes the height map's own derived width/height
  // non-finite, which `Array` cannot size; `chooseHeightMapCellSize` clamps a
  // zero or negative request to 1e-6 but passes a non-finite one through.
  if (!Number.isFinite(params.requestedCellSize)) return 'operationStepoverRatioRange'
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
function retainedBarStub(stock: BarStock, units: Units, alongFrom: number, alongTo: number): RotaryModelMesh | null {
  return isSquareStock(stock)
    ? squareBlankRetainedStub(stock, alongFrom, alongTo)
    : retainedRoundStub(stock, units, alongFrom, alongTo)
}

/**
 * A closed solid cylinder of the bar's own radius, coaxial with it, spanning
 * `alongFrom` to `alongTo`. `segments` is the smallest count whose facet
 * sagitta `R (1 - cos(pi / segments))` stays within `minRenderHeight` of the
 * true surface, so the height map never reads the stub below the bar by more
 * than the 3D view's own minimum height (100 segments for a 40 mm bar at
 * 0.01 mm). Returns `null` for an empty span.
 */
function retainedRoundStub(stock: RoundStock, units: Units, alongFrom: number, alongTo: number): RotaryModelMesh | null {
  const radius = barInscribedRadius(stock)
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
 */
function withRetainedBar(
  mesh: RotaryModelMesh,
  stock: BarStock,
  units: Units,
  alongStart: number,
  alongEnd: number,
): RotaryModelMesh {
  const bounds = getStockBounds(stock)
  const lower = stock.axis === 'x' ? bounds.minX : bounds.minY
  const upper = stock.axis === 'x' ? bounds.maxX : bounds.maxY
  const stubs = [
    retainedBarStub(stock, units, lower, alongStart),
    retainedBarStub(stock, units, alongEnd, upper),
  ].filter((stub): stub is RotaryModelMesh => stub !== null)
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
  return { positions, index }
}

/**
 * The along positions the sampler reads for one operation.
 *
 * On a round bar this is exactly the uniform grid `sampleSpacing` asks for.
 *
 * A square blank's retained stub beyond each cut range (#1016 C2-S3) puts a
 * step in the required tip height one (stock-to-leave-enlarged) cutter footprint
 * inside that range: while the tool's axial rim still reaches the stub the tip
 * is lifted to the blank's surface, and it drops to the target the moment the
 * rim clears. That step is a
 * discontinuity, so a single straight move between two samples that straddle it
 * cuts the chord below the stub and the rim enters the retained square — a
 * finer *uniform* grid does not remove it, because the step still falls between
 * two samples unless one lands on it. The stepped move `emitRotaryRuns` already
 * knows (rise, run at the higher tip, drop) is safe there, but it only fires
 * when the rise exceeds the spacing. Both shoulders are therefore sampled at
 * the height map's own resolution — the requested cell, the bound on the
 * sampler's discretization — across one cutter footprint plus that cell. There
 * either the step makes the rise exceed the spacing and the stepped move is
 * emitted, or the residual chord dip is at most that spacing, the same error
 * every sampled tip already carries. The rest of the range, and every round
 * bar, is untouched.
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
): number[] | null {
  const start = params.alongStart
  const end = params.alongEnd
  const intervals = boundedIntervals(end - start, params.sampleSpacing) ?? 1
  const base: number[] = []
  for (let i = 0; i <= intervals; i++) base.push(start + (end - start) * i / intervals)
  if (!isSquareStock(stock)) return base
  const stockBounds = getStockBounds(stock)
  const meshAlong = alongExtremes(mesh.positions, stock)
  const lower = Math.min(stock.axis === 'x' ? stockBounds.minX : stockBounds.minY, meshAlong.min)
  const upper = Math.max(stock.axis === 'x' ? stockBounds.maxX : stockBounds.maxY, meshAlong.max)
  // Only a real stub makes a step: `withRetainedBar` leaves one out where the
  // cut range already meets the bar's end, and then there is no shoulder to
  // refine and no cap to prove.
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
  // A grid already at or below the resolution resolves the step by itself.
  if (!(params.sampleSpacing > fine)) return base
  // The sampler widens the tool by `stockToLeave` (see `rotaryTargets`), so the
  // step sits one *enlarged* footprint inside the range.
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

/** Sampling and normal stock offset shared by finishing and every rough layer. */
function rotaryTargets(
  operationId: string,
  mesh: RotaryModelMesh,
  stock: BarStock,
  tool: NormalizedTool,
  params: RotaryFinishParams,
  hooks: Pick<RotarySampleOptions, 'onAngle' | 'shouldStop'>,
  warnings: ToolpathWarning[],
): { angles: number[]; along: number[]; tips: number[][]; stopped: boolean; refusal: ToolpathWarningCode | null } {
  // The tool and its radial allowance are validated before any grid work: an
  // invalid radius makes every sample read "no model", which the rough would
  // turn into a cut down to the axis. The allowance must be finite and
  // non-negative, and the radius it derives for the sampler must still be
  // positive, or the operation refuses with no motion (issue #1016 C2
  // correction M1).
  const stockToLeave = params.stockToLeave
  if (!(tool.radius > 0) || !Number.isFinite(tool.radius)) {
    return { angles: [], along: [], tips: [], stopped: false, refusal: 'toolDiameterPositive' }
  }
  const samplingRadius = tool.radius + stockToLeave
  if (!Number.isFinite(stockToLeave) || stockToLeave < 0
    || !(samplingRadius > 0) || !Number.isFinite(samplingRadius)) {
    return { angles: [], along: [], tips: [], stopped: false, refusal: 'rotaryStockToLeaveInvalid' }
  }
  // The radius the samples are capped at and the angular step is derived from
  // is the blank's *largest* radius, not the inscribed one (#1016 C2-S3): a
  // square blank stands material out to its corners at every angle, so passes
  // spaced for the inscribed circle would step past the corners. The step is
  // therefore conservative for a square and exactly the old one for a round
  // bar (where the two radii are equal).
  const maxRadius = barMaxRadius(stock)
  const passes = Math.max(1, Math.ceil((2 * Math.PI * maxRadius) / Math.max(params.stepover, 1e-9)))
  const along = rotaryAlongPositions(mesh, stock, tool, params)
  if (along === null) {
    return { angles: [], along: [], tips: [], stopped: false, refusal: 'operationStepoverRatioRange' }
  }
  // The budget is checked against the *refined* along count (#1016 C2-S3
  // correction). `rotaryRefusal` bounds the uniform `passes x (intervals + 1)`
  // grid, but a square blank's shoulder zones add up to
  // `2 * MAX_SHOULDER_SAMPLES` positions on top of it, and `passes x
  // along.length` is the size of the angle-row grid allocated just below. A
  // 100,000-pass operation with 8,000 shoulder positions passed the uniform
  // bound at 300,000 samples and then asked for ~8e8; refusing here is what
  // keeps that allocation from happening.
  if (!Number.isFinite(passes) || passes > MAX_ROTARY_SAMPLES || passes * along.length > MAX_ROTARY_SAMPLES) {
    return { angles: [], along: [], tips: [], stopped: false, refusal: 'operationStepoverRatioRange' }
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
  const angleStep = 360 / passes
  const angles = Array.from({ length: passes }, (_, k) => k * angleStep)
  const sampling = sampleRotaryModel(
    withRetainedBar(mesh, stock, tool.units, params.alongStart, params.alongEnd),
    stock,
    samplingTool,
    {
      anglesDeg: angles,
      along,
      requestedCellSize: params.requestedCellSize,
      ...hooks,
    },
    warnings,
  )
  if (!sampling.valid) {
    return { angles: [], along: [], tips: [], stopped: false, refusal: 'toolDiameterPositive' }
  }
  if (sampling.stopped) return { angles, along, tips: [], stopped: true, refusal: null }
  // The first sample below the centreline is the only place the warning names
  // (one warning per operation, however many places need it). The value that
  // decides it carries the stock offset, so leaving stock does not hide a model
  // that needs a cut below the centreline. `tipRadius[k][i]` is the height at
  // along[i], whichever direction the pass runs.
  outer: for (let k = 0; k < passes; k++) {
    for (let i = 0; i < along.length; i++) {
      if (sampling.tipRadius[k][i] + stockToLeave < 0) {
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
  const tips = sampling.tipRadius.map((row) => Array.from(row, (raw) =>
    Number.isFinite(raw) ? Math.min(Math.max(raw + stockToLeave, 0), maxRadius) : NaN))
  return { angles, along, tips, stopped: false, refusal: null }
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
 */
export function generateRotaryFinish(
  operationId: string,
  mesh: RotaryModelMesh,
  stock: BarStock,
  tool: NormalizedTool,
  params: RotaryFinishParams,
  hooks: Pick<RotarySampleOptions, 'onAngle' | 'shouldStop'>,
): ToolpathResult {
  const warnings: ToolpathWarning[] = []
  if (tool.type !== 'ball_endmill' && tool.type !== 'flat_endmill') {
    return {
      operationId,
      moves: [],
      warnings: [{ code: 'rotaryToolUnsupported', params: { operation: operationId } }],
      bounds: null,
    }
  }
  const refusal = rotaryRefusal(stock, params)
  if (refusal) {
    return { operationId, moves: [], warnings: [{ code: refusal, params: { operation: operationId } }], bounds: null }
  }
  const pivot = barPivotZ(stock)
  const centre = barCentre(stock)
  if (params.alongEnd <= params.alongStart) {
    return { operationId, moves: [], warnings: [{ code: 'rotaryNoRoom', params: { operation: operationId } }], bounds: null }
  }
  const sampling = rotaryTargets(operationId, mesh, stock, tool, params, hooks, warnings)
  if (sampling.refusal) {
    return { operationId, moves: [], warnings: [{ code: sampling.refusal, params: { operation: operationId } }], bounds: null }
  }
  if (sampling.stopped) return { operationId, moves: [], warnings: [], bounds: null }
  const { angles, along } = sampling
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
  const moves: ToolpathMove[] = []
  let here: ToolpathPoint | undefined
  let previousEndedAtEnd = false
  for (let k = 0; k < angles.length; k++) {
    // A `NaN` sample has no model under the tool: the finish follows the model,
    // and removing waste is the rough's job, so it is not cut. Each pass is the
    // runs of finite samples; a pass with none emits nothing at all.
    const runs: RotaryRun[] = []
    let i = 0
    while (i < along.length) {
      if (!Number.isFinite(tipAt(k, i))) { i++; continue }
      const start = i
      while (i + 1 < along.length && Number.isFinite(tipAt(k, i + 1))) i++
      const end = i
      const points: ToolpathPoint[] = []
      for (let j = start; j <= end; j++) points.push(point(alongAt(k, j), tipAt(k, j), angles[k]))
      runs.push({ points, atStart: start === 0, atEnd: end === along.length - 1 })
      i++
    }
    const emitted = emitRotaryRuns(moves, here, runs, safeZ, travelZ, previousEndedAtEnd)
    here = emitted.here
    previousEndedAtEnd = emitted.endedAtEnd
  }
  if (here) moves.push({ kind: 'rapid', from: here, to: { ...here, z: safeZ } })
  const merged = mergeCollinearCuts(moves, tolerance)
  return { operationId, moves: merged.moves, warnings, bounds: boundsOf(merged.moves) }
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

/** Sample once, then remove only the material still standing at each layer. */
export function generateRotaryRough(
  operationId: string,
  mesh: RotaryModelMesh,
  stock: BarStock,
  tool: NormalizedTool,
  params: RotaryRoughParams,
  hooks: Pick<RotarySampleOptions, 'onAngle' | 'shouldStop'>,
): ToolpathResult {
  if (tool.type !== 'ball_endmill' && tool.type !== 'flat_endmill') {
    return { operationId, moves: [], warnings: [{ code: 'rotaryToolUnsupported', params: { operation: operationId } }], bounds: null }
  }
  const refusal = rotaryRefusal(stock, params)
  if (refusal) {
    return { operationId, moves: [], warnings: [{ code: refusal, params: { operation: operationId } }], bounds: null }
  }
  if (params.alongEnd <= params.alongStart) {
    return { operationId, moves: [], warnings: [{ code: 'rotaryNoRoom', params: { operation: operationId } }], bounds: null }
  }
  if (!Number.isFinite(params.stepdown) || params.stepdown <= 0) {
    return { operationId, moves: [], warnings: [{ code: 'stepdownPositive', params: { operation: operationId } }], bounds: null }
  }
  const warnings: ToolpathWarning[] = []
  const sampling = rotaryTargets(operationId, mesh, stock, tool, params, hooks, warnings)
  if (sampling.refusal) {
    return { operationId, moves: [], warnings: [{ code: sampling.refusal, params: { operation: operationId } }], bounds: null }
  }
  if (sampling.stopped) return { operationId, moves: [], warnings: [], bounds: null }
  // A `NaN` sample means "no model under the tool", which for the rough is the
  // pivot: it removes the layer down to the axis there. The finish does
  // the opposite -- a `NaN` sample is not cut -- because only the rough exists
  // to take waste off.
  const tips = sampling.tips.map((row) => row.map((tip) => Number.isFinite(tip) ? tip : 0))
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
  // bands a pass actually cuts: the cutter is a cylinder along the pass ray, so
  // a pass skips a band whose tip is at or above the inside-slab material
  // height the blank reaches at that angle (#1016 C2-F2, C2-F2b). A round
  // bar's footprint radius is constant, so it keeps the old output byte for
  // byte and the helper is not even called.
  let lowest = maxRadius
  for (const row of tips) for (const tip of row) lowest = Math.min(lowest, tip)
  const layers = Math.ceil((maxRadius - lowest) / params.stepdown)
  const moves: ToolpathMove[] = []
  let here: ToolpathPoint | undefined
  const point = (position: number, tip: number, angle: number): ToolpathPoint => stock.axis === 'x'
    ? { x: position, y: centre, z: pivot + tip, a: angle }
    : { x: centre, y: position, z: pivot + tip, a: angle }
  for (let layer = 1; layer <= layers; layer++) {
    const previousRadius = maxRadius - (layer - 1) * params.stepdown
    const layerRadius = Math.max(lowest, maxRadius - layer * params.stepdown)
    // A new layer never links to the previous one, however its last pass ended.
    let previousEndedAtEnd = false
    for (let pass = 0; pass < angles.length; pass++) {
      const angle = angles[pass] + (layer - 1) * 360
      const touchesMaterial = !square
        || layerRadius < squareRotaryTouchRadius(stock, angle, tool.radius)
      const indexAt = (i: number): number => pass % 2 === 0 ? i : along.length - 1 - i
      const needsCut = (i: number): boolean =>
        touchesMaterial && tips[pass][indexAt(i)] < previousRadius
      const at = (i: number): ToolpathPoint => {
        const index = indexAt(i)
        return point(along[index], Math.max(tips[pass][index], layerRadius), angle)
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
      const emitted = emitRotaryRuns(moves, here, runs, safeZ, travelZ, previousEndedAtEnd)
      here = emitted.here
      previousEndedAtEnd = emitted.endedAtEnd
    }
  }
  if (here) moves.push({ kind: 'rapid', from: here, to: { ...here, z: safeZ } })
  const merged = mergeCollinearCuts(moves, convertLength(0.001, 'mm', tool.units))
  return { operationId, moves: merged.moves, warnings, bounds: boundsOf(merged.moves) }
}
