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
import { buildHeightMap, chooseHeightMapCellSize, safeToolTipZAt } from './finishSurfaceParallel'
import type { HeightMapWindow } from './finishSurfaceParallel'
import { buildRotaryHeightMap, buildRotaryRasterGeometry } from './rotaryRaster'
import type { RotaryRasterGeometry } from './rotaryRaster'
import { rotaryTravelZ, squareBlankRetainedStub, squareBlankSectionExit, squareRotaryStubContactFloor, squareRotaryTouchRadius } from './squareRotaryStock'
import type { NormalizedTool, ToolpathMove, ToolpathPoint, ToolpathResult } from './types'
import type { ToolpathWarning, ToolpathWarningCode } from './warningCodes'

export interface RotaryModelMesh {
  /** Project coordinates of the model as placed in the unturned bar. */
  readonly positions: Float32Array
  readonly index: Uint32Array
  /**
   * The first triangle that is **retained-wall** geometry rather than the model
   * (#1095 slice D), when a caller appended the wall's mesh to the model's
   * (`withRetainedBar`). The cells such triangles cover are recorded in the
   * height map, so a pass the cutter only *touches* at the wall face is not
   * lifted to the wall's top. Omitted when the mesh is the model alone.
   */
  readonly retainedTriangleStart?: number
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
  /**
   * Raise every sample by the operation's largest cell-centre rise and query
   * the tool's support from each cell's nearest point (issue #1045 slice F).
   * Used by around mode: the stated 0.005 mm between-sample bound is a property
   * of the emitted motion against the model, and a cell-centre height map
   * under-reads a sharp face by up to a cell, which no interpolation can put
   * back. The returned tips are then at or above the true support, and the
   * between-sample tolerance is the only remaining error.
   */
  readonly conservativeCellBounds?: boolean
  /**
   * Extra geometry whose envelope is **unioned** into the height-map grid's
   * bounds (origin, extent and cell size) while `mesh` supplies the sampled
   * values (#1095). A retained stub eroded by the stock to leave is smaller
   * than the wall it stands for, so its mesh bounds would move the grid origin
   * and re-rasterise every cell — the mid-bar included. Passing the un-eroded
   * stub mesh here keeps the grid exactly where the stock-to-leave-zero run put
   * it; only cells the erosion actually changed can read a different value.
   * Omitted, the grid is `mesh`'s own envelope, which is the old single-mesh
   * behaviour byte for byte.
   */
  readonly gridExtra?: RotaryModelMesh
  /**
   * The first triangle in `mesh` that is retained-wall geometry (#1095 slice D),
   * passed to the height-map raster so a padded sample cannot mistake a tangent
   * wall face for contact. Omitted when the mesh carries no walls, which is the
   * old path byte for byte.
   */
  readonly wallTriangleStart?: number
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

/** The mesh-only half of a plan: it does not depend on the tool or the angles. */
type RotaryPlanGeometry = Pick<RotaryStripPlan, 'across' | 'up' | 'hull' | 'minAlong' | 'maxAlong'>

/**
 * Scratch storage owned by one operation, including every refinement round
 * (issue #1045 slice T). The geometry is mesh-only; the plan is valid for any
 * angle whose strip reach is not wider than the `reach` it was built with, so a
 * later round reuses it unless a midpoint widens the reach.
 */
interface RotarySamplingWorkspace {
  geometry?: RotaryPlanGeometry
  /**
   * The union of the sampled mesh's envelope with `gridExtra` when the sampled
   * mesh is eroded (#1095), cached beside the sampled mesh's geometry. Only the
   * height-map bounds use it; the strip index stays the sampled mesh's because
   * its triangles are the ones rasterised.
   */
  gridExtra?: RotaryModelMesh
  gridGeometry?: RotaryPlanGeometry
  subset?: Uint32Array
  plan?: RotaryStripPlan
  reach?: number
  /** The `gridExtra` the cached `plan`'s bounds were built from (#1095). */
  planGridExtra?: RotaryModelMesh
  /** Contiguous per-triangle records for the fused around-mode raster. */
  raster?: RotaryRasterGeometry
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

/** The mesh-only plan geometry: cross-section, its hull and the along extremes. */
function planGeometry(mesh: RotaryModelMesh, stock: BarStock): RotaryPlanGeometry {
  const section = crossSection(mesh.positions, stock)
  const hull = crossSectionHull(section.across, section.up)
  const { min: minAlong, max: maxAlong } = alongExtremes(mesh.positions, stock)
  return { ...section, hull, minAlong, maxAlong }
}

/**
 * The envelope of two point sets: the convex hull of their hulls and the union
 * of their along extremes. The hull of a union is the hull of the two hulls, so
 * a small extra mesh widens the sampled mesh's bounds without re-sorting its
 * vertices (#1095).
 */
function unionPlanGeometry(base: RotaryPlanGeometry, extra: RotaryPlanGeometry): RotaryPlanGeometry {
  const count = base.hull.length / 2 + extra.hull.length / 2
  const across = new Float64Array(count)
  const up = new Float64Array(count)
  for (let i = 0, v = 0; i < base.hull.length; i += 2, v++) {
    across[v] = base.hull[i]
    up[v] = base.hull[i + 1]
  }
  for (let i = 0, v = base.hull.length / 2; i < extra.hull.length; i += 2, v++) {
    across[v] = extra.hull[i]
    up[v] = extra.hull[i + 1]
  }
  return {
    across: base.across,
    up: base.up,
    hull: crossSectionHull(across, up),
    minAlong: Math.min(base.minAlong, extra.minAlong),
    maxAlong: Math.max(base.maxAlong, extra.maxAlong),
  }
}

/** Build the angle-independent strip plan for one `sampleRotaryModel` call. */
function buildStripPlan(
  mesh: RotaryModelMesh,
  stock: BarStock,
  tool: NormalizedTool,
  requestedCellSize: number,
  anglesDeg: readonly number[],
  workspace: RotarySamplingWorkspace,
  gridExtra?: RotaryModelMesh,
): RotaryStripPlan {
  // The cross-section, its hull and the along extremes are the same at every
  // angle and in every refinement round; a 1.47 M-vertex hull and its sort are
  // paid once per operation rather than once per `sampleRotaryModel` call.
  const geometry = workspace.geometry ??= planGeometry(mesh, stock)
  const { across, up } = geometry
  // #1095: an eroded sampling mesh borrows the envelope of the geometry it was
  // eroded from, so the height-map grid keeps the origin and extent the same run
  // had at stock to leave 0. The extra mesh is the un-eroded stub only, so the
  // union costs a hull of a few hundred points, not a second sort of the model.
  // The strip index and the rasterised triangles stay the sampled mesh's; only
  // the bounds move.
  let grid = geometry
  if (gridExtra !== undefined) {
    if (workspace.gridExtra !== gridExtra) {
      workspace.gridExtra = gridExtra
      workspace.gridGeometry = undefined
    }
    grid = workspace.gridGeometry ??= unionPlanGeometry(geometry, planGeometry(gridExtra, stock))
  }
  const { hull, minAlong, maxAlong } = grid
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
  // #1050: there is deliberately no axial-centre cull. A triangle whose axial
  // span holds no cell centre can still overlap a cell, and the raster now
  // clips such a triangle to every cell it overlaps instead of dropping it.
  // Excluding it here would make the fused kernel disagree with the general
  // one on exactly the thin features the clip exists for.
  if (!(reach > 0) || !Number.isFinite(reach)) {
    // An infinite reach keeps every triangle; it is valid for every angle.
    if (workspace.plan && workspace.reach === Number.POSITIVE_INFINITY
      && workspace.planGridExtra === gridExtra) return workspace.plan
    const all = new Uint32Array(triangleCount * 3)
    for (let t = 0; t < all.length; t++) all[t] = t
    const plan: RotaryStripPlan = {
      across, up, hull, minAlong, maxAlong,
      bucketStarts: new Uint32Array(STRIP_BUCKETS + 1), bucketTriangles: new Uint32Array(0),
      always: all, bucketWidth,
    }
    workspace.plan = plan
    workspace.reach = Number.POSITIVE_INFINITY
    workspace.planGridExtra = gridExtra
    return plan
  }
  // A plan built for a wider reach contains every triangle this call can need:
  // the strip index only ever over-includes, and the buckets are direction-only.
  // The bounds must be the grid mesh's they were taken from (#1095).
  if (workspace.plan && workspace.reach !== undefined && workspace.reach >= reach
    && workspace.planGridExtra === gridExtra) {
    return workspace.plan
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
  for (let t = 0; t < triangleCount; t++) if (arcFirst[t] === -1) always[alwaysIndex++] = t * 3
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
  const plan: RotaryStripPlan = {
    across, up, hull, minAlong, maxAlong, bucketStarts, bucketTriangles, always, bucketWidth,
  }
  workspace.plan = plan
  workspace.reach = reach
  workspace.planGridExtra = gridExtra
  return plan
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
  return sampleRotaryModelWithWorkspace(mesh, stock, tool, options, warnings, {})
}

/**
 * `sampleRotaryModel` with scratch storage that outlives one call. The around
 * grid is sampled once and then refined in rounds; every round runs over the
 * same mesh, tool and along positions, so the cross-section, hull, strip index
 * and candidate buffer are built once per operation instead of once per round
 * (issue #1045 slice T). A caller that has no rounds passes a fresh object.
 */
function sampleRotaryModelWithWorkspace(
  mesh: RotaryModelMesh,
  stock: BarStock,
  tool: NormalizedTool,
  options: RotarySampleOptions,
  warnings: ToolpathWarning[],
  workspace: RotarySamplingWorkspace,
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
  // Along mode keeps its established project-then-raster path, byte for byte:
  // one turned buffer for the whole operation, written only at the candidate
  // triangles' vertices. Around mode fuses the projection into the raster
  // kernel and needs no turned mesh at all (issue #1045 slice T).
  const turned = options.conservativeCellBounds ? null : new Float32Array(mesh.positions.length)
  // A triangle can appear in both queried buckets, so the gathered list can be
  // twice the triangle count; anything beyond that would be a bug.
  const subset = workspace.subset ??= new Uint32Array(2 * Math.floor(mesh.index.length / 3))
  let plan: RotaryStripPlan | null = null
  let stopped = false
  // #1045 slice F: around mode reads every cell as the top of its square, not
  // its centre. The height map's centre samples can under-read a surface by
  // `(|dz/dx| + |dz/dy|) * cellSize / 2` inside one cell; that margin is added
  // to every sample of the angle it belongs to (one scalar per angle, so the
  // pad varies no faster than the turned surface's own slope), which keeps the
  // emitted tip at or above the model.
  const angleLifts: number[] = []
  for (const angle of options.anglesDeg) {
    if (options.shouldStop?.()) {
      stopped = true
      break
    }
    // Built lazily so an immediate stop -- a cancelled worker -- never pays for
    // a 1.47 M-vertex hull and bucket index.
    plan ??= buildStripPlan(mesh, stock, tool, options.requestedCellSize, options.anglesDeg, workspace, options.gridExtra)
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
    const buildOptions = {
      window,
      triangles: subset.subarray(0, count),
      ...(options.conservativeCellBounds ? { trackCellRise: true } : {}),
      ...(options.conservativeCellBounds && options.wallTriangleStart !== undefined
        ? { wallTriangleStart: options.wallTriangleStart }
        : {}),
    }
    if (turned) turnStripTriangles(turned, mesh.positions, mesh.index, plan.across, plan.up, stock, cos, sin, subset, count)
    const heightMap = turned
      ? buildHeightMap(turned, mesh.index, bbox, cellSize, buildOptions)
      : buildRotaryHeightMap({
        axis: stock.axis, centre, pivot, cos, sin,
        geometry: workspace.raster ??= buildRotaryRasterGeometry(
          mesh.positions, mesh.index, stock.axis, centre, pivot),
      }, bbox, cellSize, buildOptions)
    if (options.conservativeCellBounds) angleLifts.push(Math.min(heightMap.cellRise ?? 0, cellSize))
    const row = new Float32Array(along.length)
    for (let i = 0; i < along.length; i++) {
      const x = stock.axis === 'x' ? along[i] : centre
      const y = stock.axis === 'x' ? centre : along[i]
      const z = safeToolTipZAt(x, y, heightMap, tool,
        options.conservativeCellBounds ? cellSize * Math.SQRT1_2 : 0)
      row[i] = z === Number.NEGATIVE_INFINITY ? NaN : z - pivot
    }
    anglesDeg.push(angle)
    tipRadius.push(row)
    options.onAngle?.(anglesDeg.length, options.anglesDeg.length)
  }
  if (options.conservativeCellBounds) {
    for (let k = 0; k < tipRadius.length; k++) {
      const lift = angleLifts[k]
      if (!(lift > 0)) continue
      const row = tipRadius[k]
      for (let i = 0; i < row.length; i++) {
        if (Number.isFinite(row[i])) row[i] += lift
      }
    }
  }
  return { anglesDeg, along, tipRadius, stopped, valid: true }
}

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
interface RotaryLinkRow {
  readonly along: readonly number[]
  readonly tips: readonly number[]
}

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
   * requires.
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
 * The largest surface error an around pass accepts between two angle samples,
 * in millimetres (#1045 slice D). A move between two angle samples interpolates
 * the tip radius linearly while the blank turns. Over a convex section the
 * material between the samples stands above that chord by about `R dTheta^2/8`
 * (bar radius `R`, angle step `dTheta` in radians), and the tool's rim then
 * cuts that much into the surface: on the radius-8 hex prism in a Ø40 bar with
 * a 1.5 mm ball and 1.5 mm sample spacing, the A325.7143 -> 330 move reached
 * radius 7.9247 at its midpoint against an independent contact of 7.9643 --
 * 0.0396 mm of gouge. 0.005 mm is the finer of the two tolerances the review
 * named: the along path's collinear-merge tolerance is 0.001 mm, while its
 * between-sample ball error is `s^2 / (8r)`, which is 0.02 mm at 0.5 mm spacing
 * and a 1.5 mm ball -- so a fixed 0.005 mm is a real tightening rather than a
 * re-statement of the along path's own allowance.
 */
const AROUND_ANGLE_TOLERANCE_MM = 0.005

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
 * The most samples one rotary operation may derive (`passes x along positions`).
 * Both counts are quotients of caller parameters (`2 pi R / stepover` and
 * `span / sampleSpacing`), so a value that is positive and finite can still ask
 * for tens of billions of samples; `Array.from` on that length exhausts the
 * worker rather than refusing. Sixteen million keeps the per-angle tip rows
 * under a few hundred megabytes and is far above any job the panel describes.
 */
const MAX_ROTARY_SAMPLES = 16_000_000

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
 */
const MAX_LINK_WINDOW_WORK = 4 * MAX_LINK_WORK

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
 * The most bisection rounds the around grid may add before it gives up and
 * refuses. The between-sample error of a linear move over a convex feature
 * falls roughly with the square of the angle step, so one round quarters it;
 * eight rounds is a 65,536-fold reduction and far beyond the "0.005 mm floor"
 * the check actually needs. A grid that still fails then is one the sample
 * budget will not let us resolve, and the caller refuses rather than posting a
 * move it could not bound.
 */
const MAX_AROUND_REFINEMENT_ROUNDS = 8

/**
 * The between-sample tolerance for one angular segment of an around pass
 * (#1045 slice E), in the operation's units.
 *
 * It is the larger of the stated 0.005 mm surface bound and the error the along
 * path accepts between samples that far apart on a ball-nosed cutter —
 * `s² / (8 r)` for a surface spacing `s` and ball radius `r`. Using the
 * segment's own spacing keeps the two modes honest: a coarser segment may not
 * do worse than the along path would at that spacing, and as bisection makes a
 * segment finer the bound approaches the 0.005 mm floor rather than vanishing.
 * A flat end mill has no ball to lift between samples, so it takes the floor.
 *
 * `tipA`/`tipB` are the sampled tip radii at the segment's ends; the smaller
 * one is the surface radius the move's arc actually travels at.
 */
function aroundSegmentationTolerance(
  tipA: number,
  tipB: number,
  deltaDegrees: number,
  tool: NormalizedTool,
  units: Units,
): number {
  const floor = convertLength(AROUND_ANGLE_TOLERANCE_MM, 'mm', units)
  if (tool.type !== 'ball_endmill') return floor
  const radius = Math.max(0, Math.min(tipA, tipB))
  const arc = radius * Math.abs(deltaDegrees) * Math.PI / 180
  return Math.max(floor, (arc * arc) / (8 * tool.radius))
}

/**
 * Make the around-mode interpolation bound a property of the **emitted motion**
 * (#1045 slice E).
 *
 * A ring is sampled at the angles `aroundGrid` built, and the emitter joins two
 * neighbouring samples with one straight move in A and Z. A pair of safe
 * endpoints is not a safe sweep: the material between them can stand above the
 * chord. The slice-D sagitta cap bounds that for a smooth convex section, but
 * not for a ball-nose cutter pivoting over a sharp feature — a hex prism's
 * vertex, or a square blank's corner. On the radius-8 hex in a Ø40 bar with a
 * 1.5 mm ball, the emitted Z values interpolated across the A209.362 -> A211.915
 * move gouge 0.0236 mm, because `R dTheta² / 8` says nothing about the ball's
 * contact envelope.
 *
 * So every adjacent pair is checked against the model at its **mid angle**, and
 * a pair whose mid contact stands more than {@link aroundSegmentationTolerance}
 * above the chord is bisected. Only the failing mid angle is kept, so a smooth
 * ring pays one extra sampling pass and a sharp feature pays one round per
 * halving it needs. The extra pass is the cost: one height-map row per
 * never-sampled midpoint, cached and reused in later rounds, and each round's
 * kept angles grow only by the failures.
 *
 * The pair is only checked when both ends sample the model (`NaN` means "no
 * model under the tool", which the finish does not cut and the rough replaces
 * with its axis fallback — neither is a smooth surface the chord interpolates).
 * The emitted tip of every generator is at or above these sampled values (a
 * rough clamps to its layer radius, a finish adds its stock and floors at a
 * retained stub), and `max` cannot lower the chord, so the check covers all of
 * them.
 *
 * Returns `null` when even the sampled grid is invalid, and `stopped: true`
 * when the caller cancelled during a refinement pass.
 */
function refineAroundSampling(args: {
  mesh: RotaryModelMesh
  workspace: RotarySamplingWorkspace
  stock: BarStock
  tool: NormalizedTool
  samplingTool: NormalizedTool
  along: readonly number[]
  angles: readonly number[]
  tips: readonly Float32Array[]
  requestedCellSize: number
  warnings: ToolpathWarning[]
  conservativeCellBounds: boolean
  shouldStop?: () => boolean
  /** The un-eroded grid envelope (#1095); defaults to `mesh`. */
  gridExtra?: RotaryModelMesh
}): { angles: number[]; tips: Float32Array[]; stopped: boolean } | null {
  const { mesh, stock, tool, samplingTool, along, requestedCellSize, warnings, conservativeCellBounds, shouldStop, gridExtra } = args
  let angles = [...args.angles]
  let tips: Float32Array[] = [...args.tips]
  // A midpoint row is a pure function of (mesh, tool, along positions, cell
  // size, angle), and all of those are fixed for this refinement. Every round
  // tests all current segments -- a segment that passed can still fail once a
  // subdivided neighbour changes the cusp test -- but only a midpoint that has
  // never been sampled needs a height map. Without this cache each round paid a
  // fresh map for every segment, passing ones included: six rounds of a smooth
  // ring cost six times the base grid even when almost nothing failed (issue
  // #1045 slice T).
  const midpointRows = new Map<number, Float32Array>()
  for (let round = 0; round < MAX_AROUND_REFINEMENT_ROUNDS; round++) {
    const mids = angles.slice(0, -1).map((angle, k) => (angle + angles[k + 1]) / 2)
    if (mids.length === 0) break
    const missing = mids.filter((angle) => !midpointRows.has(angle))
    if (missing.length > 0) {
      const sampled = sampleRotaryModelWithWorkspace(mesh, stock, samplingTool, {
        anglesDeg: missing,
        along,
        requestedCellSize,
        ...(conservativeCellBounds ? { conservativeCellBounds: true } : {}),
        ...(shouldStop ? { shouldStop } : {}),
        ...((gridExtra !== undefined) ? { gridExtra } : {}),
        ...(mesh.retainedTriangleStart !== undefined
          ? { wallTriangleStart: mesh.retainedTriangleStart }
          : {}),
      }, warnings, args.workspace)
      if (!sampled.valid) return null
      if (sampled.stopped) return { angles, tips, stopped: true }
      for (let k = 0; k < missing.length; k++) midpointRows.set(missing[k], sampled.tipRadius[k])
    }
    const midRow = (k: number): Float32Array => midpointRows.get(mids[k])!
    const fails = new Set<number>()
    for (let k = 0; k + 1 < angles.length && fails.size < mids.length; k++) {
      const delta = angles[k + 1] - angles[k]
      const rowA = tips[k]
      const rowB = tips[k + 1]
      const rowMid = midRow(k)
      const rowPrev = k > 0 ? tips[k - 1] : null
      const rowNext = k + 2 < angles.length ? tips[k + 2] : null
      for (let i = 0; i < along.length; i++) {
        const a = rowA[i]
        const b = rowB[i]
        const mid = rowMid[i]
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue
        const tolerance = aroundSegmentationTolerance(a, b, delta, tool, tool.units)
        // A peak that falls **between** the two samples is invisible to the mid
        // sample when the height map reads it low: the sampler's cell is wider
        // than one angle step near a sharp feature. Detect it from the sampled
        // tips instead -- the surface rises into this segment and falls out of
        // it -- and hold the segment to the exact sharp-corner bound
        // `dTheta^2 (R + R^2 / r) / 8` for a ball (`R dTheta^2 / 8` for a flat),
        // which is a property of the section and not of the sampler.
        //
        // A revolved surface samples almost flat (its ideal support is the same
        // at every angle), and the height map's own cell noise makes its tips
        // wobble by a few cell widths. Requiring each side of the sign change to
        // rise by half the sharp bound separates that noise from a real cusp:
        // the bound is what the cusp would put above the chord, and cell noise
        // is below it. A face's support is convex, so its chord never dips and
        // the sign change it cannot produce is never asked for.
        const radius = Math.max(0, Math.min(a, b))
        const radians = Math.abs(delta) * Math.PI / 180
        const sharp = tool.type === 'ball_endmill'
          ? radians * radians * (radius + radius * radius / tool.radius) / 8
          : radians * radians * radius / 8
        const rises = rowPrev === null || a > rowPrev[i] + sharp * 0.5
        const falls = rowNext === null || b > rowNext[i] + sharp * 0.5
        if (rises && falls) {
          if (sharp > tolerance) {
            fails.add(k)
            break
          }
          continue
        }
        if (!Number.isFinite(mid)) continue
        if (mid - (a + b) / 2 > tolerance) {
          fails.add(k)
          break
        }
      }
    }
    if (fails.size === 0) break
    const nextAngles: number[] = []
    const nextTips: Float32Array[] = []
    for (let k = 0; k < angles.length; k++) {
      nextAngles.push(angles[k])
      nextTips.push(tips[k])
      if (k + 1 < angles.length && fails.has(k)) {
        nextAngles.push(mids[k])
        nextTips.push(midRow(k))
      }
    }
    angles = nextAngles
    tips = nextTips
    if (angles.length * along.length > MAX_ROTARY_SAMPLES) return null
  }
  return { angles, tips, stopped: false }
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
): {
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
  /** The dense link row at a ring link's shared angle, around mode only. */
  linkRowAt: (angleDeg: number) => RotaryLinkRow | null
  stopped: boolean
  refusal: ToolpathWarningCode | null
} {
  // The tool and its radial allowance are validated before any grid work: an
  // invalid radius makes every sample read "no model", which the rough would
  // turn into a cut down to the axis. The allowance must be finite and
  // non-negative, and the radius it derives for the sampler must still be
  // positive, or the operation refuses with no motion (issue #1016 C2
  // correction M1).
  const stockToLeave = params.stockToLeave
  if (!(tool.radius > 0) || !Number.isFinite(tool.radius)) {
    return { angles: [], along: [], tips: [], stubFloor: null, linkRowAt: () => null, stopped: false, refusal: 'toolDiameterPositive' }
  }
  const samplingRadius = tool.radius + stockToLeave
  if (!Number.isFinite(stockToLeave) || stockToLeave < 0
    || !(samplingRadius > 0) || !Number.isFinite(samplingRadius)) {
    return { angles: [], along: [], tips: [], stubFloor: null, linkRowAt: () => null, stopped: false, refusal: 'rotaryStockToLeaveInvalid' }
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
    return { angles: [], along: [], tips: [], stubFloor: null, linkRowAt: () => null, stopped: false, refusal: 'rotaryNoRoom' }
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
      return { angles: [], along: [], tips: [], stubFloor: null, linkRowAt: () => null, stopped: false, refusal: 'operationStepoverRatioRange' }
    }
    angles = grid.angles
    along = grid.along
  } else {
    const passes = Math.max(1, Math.ceil((2 * Math.PI * maxRadius) / Math.max(params.stepover, 1e-9)))
    const positions = rotaryAlongPositions(mesh, stock, tool, params, span)
    if (positions === null) {
      return { angles: [], along: [], tips: [], stubFloor: null, linkRowAt: () => null, stopped: false, refusal: 'operationStepoverRatioRange' }
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
      return { angles: [], along: [], tips: [], stubFloor: null, linkRowAt: () => null, stopped: false, refusal: 'operationStepoverRatioRange' }
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
  const sampling = sampleRotaryModelWithWorkspace(
    samplingMesh,
    stock,
    samplingTool,
    {
      anglesDeg: angles,
      along,
      requestedCellSize: params.requestedCellSize,
      ...(params.passDirection === 'around' ? { conservativeCellBounds: true } : {}),
      ...hooks,
      ...((gridExtra !== undefined) ? { gridExtra } : {}),
      ...(samplingMesh.retainedTriangleStart !== undefined
        ? { wallTriangleStart: samplingMesh.retainedTriangleStart }
        : {}),
    },
    warnings,
    workspace,
  )
  if (!sampling.valid) {
    return { angles: [], along: [], tips: [], stubFloor: null, linkRowAt: () => null, stopped: false, refusal: 'toolDiameterPositive' }
  }
  if (sampling.stopped) return { angles, along, tips: [], stubFloor: null, linkRowAt: () => null, stopped: true, refusal: null }
  // #1045 slice E: the around path's between-sample safety is a property of the
  // emitted motion, not of the endpoint grid. Bisect every segment whose chord
  // falls more than the segment tolerance below the model at its mid angle.
  let tipRows = sampling.tipRadius
  if (params.passDirection === 'around' && angles.length > 1) {
    const refined = refineAroundSampling({
      mesh: samplingMesh,
      workspace,
      stock,
      tool,
      samplingTool,
      along,
      angles,
      tips: sampling.tipRadius,
      requestedCellSize: params.requestedCellSize,
      warnings,
      conservativeCellBounds: true,
      ...(hooks.shouldStop ? { shouldStop: hooks.shouldStop } : {}),
      ...((gridExtra !== undefined) ? { gridExtra } : {}),
    })
    if (refined === null) {
      return { angles: [], along: [], tips: [], stubFloor: null, linkRowAt: () => null, stopped: false, refusal: 'operationStepoverRatioRange' }
    }
    if (refined.stopped) return { angles: [], along: [], tips: [], stubFloor: null, linkRowAt: () => null, stopped: true, refusal: null }
    angles = refined.angles
    tipRows = refined.tips
  }
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
  const linkCache = new Map<number, RotaryLinkRow | null>()
  let linkSampleTotal = 0
  const linkRowAt = (angleDeg: number): RotaryLinkRow | null => {
    const key = ((angleDeg % 360) + 360) % 360
    const cached = linkCache.get(key)
    if (cached !== undefined) return cached
    if (params.passDirection !== 'around' || along.length <= 1) {
      linkCache.set(key, null)
      return null
    }
    const spacing = Math.min(
      aroundArcStep(stock, params, tool.units),
      params.stepover,
      tool.radius / 4,
    )
    const span = along[along.length - 1] - along[0]
    const intervals = span > 0 ? Math.ceil(span / Math.max(spacing, 1e-9)) : 0
    if (!Number.isFinite(intervals) || intervals <= 0 || intervals + 1 > MAX_LINK_SAMPLES
      || linkSampleTotal + intervals + 1 > MAX_LINK_TOTAL_SAMPLES
      // The row is walked once per ring boundary, and the rough's leftover walk
      // is row x along; cap that product and retract instead of running a
      // quadratic pass on a long bar with a small cutter.
      || (intervals + 1) * along.length > MAX_LINK_WORK) {
      linkCache.set(key, null)
      return null
    }
    const linkAlong = Array.from({ length: intervals + 1 }, (_, i) => along[0] + span * i / intervals)
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
    if (!sampled.valid || sampled.stopped) {
      linkCache.set(key, null)
      return null
    }
    linkSampleTotal += linkAlong.length
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
    const row: RotaryLinkRow = { along: linkAlong, tips: linkTips }
    linkCache.set(key, row)
    return row
  }
  return { angles, along, tips, stubFloor, linkRowAt, stopped: false, refusal: null }
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
 * then a step along. Rings alternate direction so A stays within [0, 360] and
 * each ring starts where the previous one ended. A full ring's end and the next
 * ring's start are the same physical angle, so #1093 links them with a feed
 * along the bar that follows the model at that angle through a sample row no
 * coarser than the ring spacing or a quarter of the tool radius; only a split
 * ring or a gap in the reachable surface retracts. A `NaN` sample
 * is still not cut, the layer links are the same emitter's, and the steep-step
 * rule measures their surface distance along the arc rather than across X/Y. A saved operation
 * without the field keeps the along motion above byte for byte -- the shape of
 * the motion, not its band: the slice-D retained-end pull applies to both modes
 * and is a safety fix.
 *
 * A **square** blank supports around mode too (#1045 slice C). Each sample is
 * already floored at its own exact retained-stub contact by `rotaryTargets`
 * (the C2-F6 floor), so a ring near a stubbed end cannot cut the square that
 * holds the part. Rings are separate runs -- the emitter retracts to the travel
 * height between them -- so, unlike an along grid, no cut chord spans two ring
 * positions and the stub's steep along profile needs no shoulder refinement
 * here; the along *step* is the operation's own `stepover`, and the stub's
 * angular profile is resolved by `sampleSpacing`.
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
  const refusal = rotaryRefusal(stock, params, tool.units)
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
  const forceStep = retainedStubStepForced(stock, params, tool)
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
    const points: RotaryLinkStep[] = []
    for (let i = 0; i < linkRow.along.length; i++) {
      const x = linkRow.along[i]
      if (x <= fromAlong + 1e-12 || x >= toAlong - 1e-12) continue
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
    // One ring per along position (#1045 slice A): the angle sweeps the whole
    // turn, so the along coordinate never changes inside a ring. Rings alternate
    // direction, which keeps A within [0, 360] for the operation and makes each
    // ring start where the last ended. Every point reads its own angle row, `k`,
    // at the ring's own along index -- a reversed ring uses its reversed `k` for
    // the along position, the angle and the tip alike.
    const last = angles.length - 1
    for (let ring = 0; ring < along.length; ring++) {
      if (hooks.shouldStop?.()) return { operationId, moves: [], warnings: [], bounds: null }
      const forward = ring % 2 === 0
      const samples: (ToolpathPoint | null)[] = []
      for (let step = 0; step <= last; step++) {
        const k = forward ? step : last - step
        const tip = sampling.tips[k][ring]
        samples.push(Number.isFinite(tip) ? point(along[ring], tip, angles[k]) : null)
      }
      const runs = ringRuns(samples)
      const emitted = emitRotaryRuns(moves, here, runs, safeZ, travelZ, previousEndedAtEnd, forceStep, pivot, followLink)
      here = emitted.here
      // A split ring is partial arcs: its last run can still reach the ring end,
      // but the issue's contract is that a split ring retracts rather than
      // feeding to the next ring. Only a ring that emitted one run may link.
      previousEndedAtEnd = emitted.endedAtEnd && runs.length <= 1
    }
  } else {
    for (let k = 0; k < angles.length; k++) {
      if (hooks.shouldStop?.()) return { operationId, moves: [], warnings: [], bounds: null }
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
 * Sample once, then remove only the material still standing at each layer.
 *
 * `passDirection: 'around'` replaces each layer's along passes with rings at one
 * along position (#1045 slice A): the per-sample `needsCut`/layer rule is the
 * along pass's, the direction alternation continues across layers (no
 * `(layer - 1) * 360` is added, so A never leaves [0, 360]), and every sample
 * reads its own angle row. Consecutive rings are linked (#1093) at the
 * angle their runs share -- a full ring's end and the next ring's start, or a
 * square corner arc's touch-gate boundary -- along the bar at the highest
 * material this operation's own earlier layers left on the path, plus the 1 mm
 * clearance. The constant-height traverse is a **rapid**: it is in air by
 * construction, and a feed through air makes the machine creep. Its rise and
 * drop stay feeds; the first layer has nothing removed in front of it and keeps
 * the travel height, and an A-changing link is left to the old travel-height
 * rule (or its retract), because the surface link requires one exact angle.
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
  const warnings: ToolpathWarning[] = []
  // #1095: the radial leave belongs to the model surface alone on a rough too.
  // The retained end walls keep their real size, so the outermost pass -- one
  // cutter radius from the wall -- reaches model + leave instead of being lifted
  // over a thickened wall's corner. `rotaryTargets` applies the same rule to
  // every operation, the finish included.
  const sampling = rotaryTargets(operationId, mesh, stock, tool, params, hooks, warnings)
  if (sampling.refusal) {
    return { operationId, moves: [], warnings: [{ code: sampling.refusal, params: { operation: operationId } }], bounds: null }
  }
  if (sampling.stopped) return { operationId, moves: [], warnings: [], bounds: null }
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
  let linkWindowWork = 0
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
  const linkLeftoverAt = (row: RotaryLinkRow, angleDeg: number, layer: number, reachDeg = 0): number[] => {
    const k = pointIndexAt(angleDeg)
    if (k < 0) return []
    // The base walk reads the link angle's own row and is already bounded by
    // `linkRowAt`'s `row.along x along` budget. Only the body window multiplies
    // that by the angle span, so only the window needs its own caps (#1093).
    const windowed = reachDeg > 0
    const windowRows = windowed ? angleWindow(k, reachDeg) : [k]
    const work = row.along.length * along.length * windowRows.length
    if (windowed && work > MAX_LINK_WORK) return []
    // Two reaches that select the same angle rows leave the same material, so
    // the key is the row span rather than the per-link height. Without this a
    // long job recomputes the whole walk for every ring boundary.
    const key = windowed
      ? `${k}:${layer}:w${windowRows[0]}-${windowRows[windowRows.length - 1]}`
      : `${k}:${layer}`
    const cached = leftoverCache.get(key)
    if (cached) return cached
    if (windowed) {
      // The per-call cap above cannot bound the operation: the link plan asks
      // at every ring boundary. Past the operation budget the rest of the links
      // retract, and the empty answer is cached so they do not retry the walk.
      if (linkWindowWork + work > MAX_LINK_WINDOW_WORK) {
        leftoverCache.set(key, [])
        return []
      }
      linkWindowWork += work
    }
    // The blank's own height over the body's window: a square blank's corner is
    // higher than its face, and an earlier layer that did not cut at a face
    // angle leaves that support standing.
    let support = maxRadius
    if (square) {
      support = Number.NEGATIVE_INFINITY
      for (const kk of windowRows) {
        support = Math.max(support, squareRotaryTouchRadius(stock, angles[kk], tool.radius, tool.type))
      }
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
  const linkPlan = (layer: number) => (from: ToolpathPoint, to: ToolpathPoint): readonly RotaryLinkStep[] | null => {
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
    // layers and the rings run along inside each one. The direction alternation
    // continues across the layer boundary -- a single `ring` counter -- so a
    // layer that ends at 360 degrees starts the next at 360 as well; A stays
    // within [0, 360] for the whole operation and no `(layer - 1) * 360` is
    // added. Each sample keeps its own angle row's height at the ring's own
    // along index, and the same `needsCut`/layer rule as an along pass: material
    // still standing at this layer is cut, a sample already at the layer radius
    // is not.
    //
    // A **square** blank's standing material is not the same at every angle
    // (#1045 slice C): the corners reach `barMaxRadius` while a flat is only
    // half the side. The along pass asks `squareRotaryTouchRadius` at its own
    // pass angle; the ring asks it per sample at **that sample's** angle, so a
    // layer above the material standing there is air and emits nothing. The
    // gate is computed once per layer -- it depends on the layer radius and the
    // angle, never on the along position -- and is `null` on a round bar, whose
    // output stays byte for byte.
    const last = angles.length - 1
    let ring = 0
    for (let layer = 1; layer <= layers; layer++) {
      if (hooks.shouldStop?.()) return { operationId, moves: [], warnings: [], bounds: null }
      const previousRadius = maxRadius - (layer - 1) * params.stepdown
      const layerRadius = Math.max(lowest, maxRadius - layer * params.stepdown)
      const touchesMaterial = square
        ? angles.map((angle) => layerRadius < squareRotaryTouchRadius(stock, angle, tool.radius, tool.type))
        : null
      // A new layer never links to the previous one, however its last ring ended.
      let previousEndedAtEnd = false
      const layerLink = linkPlan(layer)
      for (let i = 0; i < along.length; i++, ring++) {
        if (hooks.shouldStop?.()) return { operationId, moves: [], warnings: [], bounds: null }
        const forward = ring % 2 === 0
        const samples: (ToolpathPoint | null)[] = []
        for (let step = 0; step <= last; step++) {
          const k = forward ? step : last - step
          const tip = tips[k][i]
          const cuts = tip < previousRadius && (touchesMaterial === null || touchesMaterial[k])
          samples.push(cuts ? point(along[i], Math.max(tip, layerRadius), angles[k]) : null)
        }
        const emitted = emitRotaryRuns(moves, here, ringRuns(samples), safeZ, travelZ, previousEndedAtEnd, forceStep, pivot, layerLink, i > 0)
        here = emitted.here
        previousEndedAtEnd = emitted.endedAtEnd
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
