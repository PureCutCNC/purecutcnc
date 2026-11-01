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
 * Rotary sampling, split into the four stages a worker pool can drive (#1115
 * slice p-d1).
 *
 * Until this split the whole sampler was one loop in `rotaryModel.ts`: build the
 * angle-independent strip plan, then for each angle build that angle's height
 * map, read the tool tip at every along position and, on the way, apply the
 * conservative cell rise and merge the angle's warnings. Feeding that loop from
 * several workers is impossible without a boundary, so the loop is now four
 * named parts:
 *
 * 1. **preparation** — {@link createRotarySamplingPrep}: the cross-section, the
 *    hull, the strip/bucket plan, the raster geometry and the scratch buffers,
 *    all built once per operation and shared by every angle;
 * 2. **the per-angle job** — {@link runRotaryAngleJob}: one angle's height map,
 *    its tool-tip row and its own warnings. The row comes back **unlifted**,
 *    with the lift (`min(cellRise ?? 0, cellSize)`) reported beside it, so the
 *    job has no ordering side effects and identical jobs can run anywhere;
 * 3. **ordered assembly** — {@link assembleRotarySampling}: results are placed
 *    back at their own index, the lift is applied centrally through the existing
 *    Float32 assignment, and warnings are merged in angle order with the
 *    existing first-code-wins rule;
 * 4. **refinement decisions** — {@link refineAroundSampling} and its async twin:
 *    which segments fail, which midpoints are still unsampled, and where the
 *    midpoints are inserted. The decisions are shared; only the sampling call
 *    differs.
 *
 * Two drivers run those parts. The synchronous one,
 * {@link sampleRotaryModelWithWorkspace}, is what the generators call and is
 * byte-for-byte the old loop. The asynchronous one,
 * {@link sampleRotaryModelWithWorkspaceAsync}, runs each batch through an
 * injected {@link RotaryBatchFactory} and assembles by original index, which is
 * what a worker pool will implement (p-d2). No driver here starts a worker, and
 * the asynchronous driver is not on the generation path yet.
 *
 * The numerics are deliberately untouched: the strip plan, the window, the
 * triangle subset, the raster call, the Float32 rounding of the lifted row, the
 * midpoint cache, the insertion order and the eight-round refinement limit are
 * the same code as before, moved rather than rewritten.
 */

import { barCentre, barPivotZ } from '../../types/barStock'
import type { BarStock } from '../../types/project'
import { convertLength, type Units } from '../../utils/units'
import { buildHeightMap, chooseHeightMapCellSize, safeToolTipZAt } from './finishSurfaceParallel'
import type { HeightMapWindow } from './finishSurfaceParallel'
import { buildRotaryHeightMap, buildRotaryRasterGeometry } from './rotaryRaster'
import type { RotaryRasterGeometry } from './rotaryRaster'
import type { NormalizedTool } from './types'
import type { ToolpathWarning } from './warningCodes'

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
  /**
   * One value per angle: the conservative cell rise that was added to every
   * finite sample of that row, `min(cellRise ?? 0, cellSize)`, or `0` for a call
   * that did not ask for cell-rise tracking (issue #1045 slice F). It is
   * reported so the central lift is observable rather than implied -- the row
   * plus its lift is the per-angle job's whole answer (#1115 slice p-d1).
   */
  readonly lifts: readonly number[]
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
export interface RotarySamplingWorkspace {
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
export function alongExtremes(positions: Float32Array, stock: BarStock): { min: number; max: number } {
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
export const AROUND_ANGLE_TOLERANCE_MM = 0.005

/**
 * The most samples one rotary operation may derive (`passes x along positions`).
 * Both counts are quotients of caller parameters (`2 pi R / stepover` and
 * `span / sampleSpacing`), so a value that is positive and finite can still ask
 * for tens of billions of samples; `Array.from` on that length exhausts the
 * worker rather than refusing. Sixteen million keeps the per-angle tip rows
 * under a few hundred megabytes and is far above any job the panel describes.
 */
export const MAX_ROTARY_SAMPLES = 16_000_000

// ── the per-angle job (#1115 slice p-d1) ───────────────────────────────────

/**
 * One angle of a batch.
 *
 * It carries no data of its own beyond its place and its angle: everything a
 * job reads -- the mesh, the strip plan, the raster geometry, the scratch
 * buffers, the tool and the along positions -- belongs to the
 * {@link RotarySamplingPrep} it is run against. That is exactly the split a
 * worker pool needs: the prep is installed once per operation, and the job is
 * the only thing that crosses the wire per angle (p-d2 adds the transport).
 */
export interface RotaryAngleJob {
  /** The job's place in its batch; assembly puts the result back here. */
  readonly index: number
  readonly angle: number
}

/**
 * One finished angle: its **unlifted** tip row, the lift to apply to it, and the
 * warnings the angle itself raised.
 *
 * The lift is not folded in here on purpose (#1115 slice p-d1). A job that
 * applied its own lift would have two places to keep the Float32 arithmetic
 * right, and re-running a batch would apply it twice; applying it once,
 * centrally, in assembly keeps the arithmetic exactly where it was and makes
 * "the row plus its lift" the whole contract.
 */
export interface RotaryAngleSample {
  readonly index: number
  /** Tool tip radius from the turning pivot per along position, before the lift. */
  readonly row: Float32Array
  /** `min(cellRise ?? 0, cellSize)` for this angle; 0 when cell rise is not tracked. */
  readonly lift: number
  readonly warnings: readonly ToolpathWarning[]
}

/**
 * Run one batch of angle jobs.
 *
 * Results may come back in **any order**: each carries its own index and
 * assembly sorts them out, so a pool may answer in completion order. A runner
 * that loses, duplicates or invents an index makes assembly refuse rather than
 * quietly move a row to another angle.
 */
export type RotaryAngleBatch = (jobs: readonly RotaryAngleJob[]) => Promise<readonly RotaryAngleSample[]>

/**
 * Build the batch runner for one prepared operation.
 *
 * Called once per prep, which is the seam a worker pool installs its per-worker
 * geometry into: `factory(prep)` may copy the raster geometry and bucket data to
 * its workers, and the function it returns only ever sees jobs.
 */
export type RotaryBatchFactory = (prep: RotarySamplingPrep) => RotaryAngleBatch

/** What one operation's sampling needs beyond the job list. */
export interface RotarySamplingSetup {
  /** Positions along the bar's axis; every job reads them through the prep. */
  readonly along: readonly number[]
  /** Requested height-map cell size before `chooseHeightMapCellSize` caps it. */
  readonly requestedCellSize: number
  /** See `RotarySampleOptions.conservativeCellBounds`. */
  readonly conservativeCellBounds?: boolean
  /** See `RotarySampleOptions.wallTriangleStart`. */
  readonly wallTriangleStart?: number
  /** See `RotarySampleOptions.gridExtra`. */
  readonly gridExtra?: RotaryModelMesh
  /** Scratch that outlives one sampling call, shared across refinement rounds. */
  readonly workspace?: RotarySamplingWorkspace
}

/**
 * Everything the per-angle jobs of one operation share (#1115 slice p-d1).
 *
 * One prep is the unit a worker is set up with. It holds the operation's
 * geometry and scratch, not its angle list: the plan depends on the widest reach
 * of the angles being sampled, so it is asked for per batch through
 * {@link RotarySamplingPrep.planFor}.
 */
export interface RotarySamplingPrep {
  readonly mesh: RotaryModelMesh
  readonly stock: BarStock
  readonly tool: NormalizedTool
  readonly along: readonly number[]
  readonly requestedCellSize: number
  readonly conservativeCellBounds: boolean
  readonly wallTriangleStart?: number
  readonly gridExtra?: RotaryModelMesh
  /** The operation's cached geometry, plan and raster. */
  readonly workspace: RotarySamplingWorkspace
  /** The bar's cross-axis centre, from `barCentre`. */
  readonly centre: number
  /** The turning pivot height, from `barPivotZ`. */
  readonly pivot: number
  /**
   * The reused turned-vertex buffer for along mode, where the projection is
   * done by `turnStripTriangles`; `null` in around mode, which fuses the
   * projection into the raster kernel.
   */
  readonly turned: Float32Array | null
  /**
   * The strip plan for a batch's angles, built on first ask and cached on the
   * workspace. Lazily, so an immediate stop -- a cancelled worker -- never pays
   * for a 1.47 M-vertex hull and bucket index.
   */
  planFor(anglesDeg: readonly number[]): RotaryStripPlan
}

/**
 * Build one operation's sampling prep.
 *
 * The tool must be able to describe a cutter (`radius` finite and positive); the
 * public entry points check that before calling, because the old sampler
 * reported an invalid tool as `valid: false` with no rows instead of sampling
 * nothing (issue #1016 C2 correction M1).
 */
export function createRotarySamplingPrep(
  mesh: RotaryModelMesh,
  stock: BarStock,
  tool: NormalizedTool,
  setup: RotarySamplingSetup,
): RotarySamplingPrep {
  const workspace = setup.workspace ?? {}
  // A triangle can appear in both queried buckets, so the gathered list can be
  // twice the triangle count; anything beyond that would be a bug.
  workspace.subset ??= new Uint32Array(2 * Math.floor(mesh.index.length / 3))
  const conservativeCellBounds = setup.conservativeCellBounds === true
  // Along mode keeps its established project-then-raster path, byte for byte:
  // one turned buffer for the whole operation, written only at the candidate
  // triangles' vertices. Around mode fuses the projection into the raster
  // kernel and needs no turned mesh at all (issue #1045 slice T).
  const turned = conservativeCellBounds ? null : new Float32Array(mesh.positions.length)
  return {
    mesh,
    stock,
    tool,
    along: setup.along,
    requestedCellSize: setup.requestedCellSize,
    conservativeCellBounds,
    ...(setup.wallTriangleStart !== undefined ? { wallTriangleStart: setup.wallTriangleStart } : {}),
    ...(setup.gridExtra !== undefined ? { gridExtra: setup.gridExtra } : {}),
    workspace,
    centre: barCentre(stock),
    pivot: barPivotZ(stock),
    turned,
    planFor(anglesDeg) {
      return buildStripPlan(mesh, stock, tool, setup.requestedCellSize, anglesDeg, workspace, setup.gridExtra)
    },
  }
}

/**
 * One angle's height map and tool-tip row (#1115 slice p-d1).
 *
 * This is the old sampling loop's body with two changes: the plan and the
 * scratch come from the prep instead of the enclosing call, and the conservative
 * cell rise is returned instead of applied. Nothing numerical moved: the
 * window, the bucket subset, the turned buffer, the raster call, the padding and
 * the `NaN`-for-no-model rule are the same statements in the same order.
 *
 * `plan` is the batch's plan -- built from the full angle list, because its
 * reach is the widest strip any angle of the batch reads.
 */
export function runRotaryAngleJob(
  prep: RotarySamplingPrep,
  plan: RotaryStripPlan,
  job: RotaryAngleJob,
): RotaryAngleSample {
  const { mesh, stock, tool, along, centre, pivot, turned, conservativeCellBounds } = prep
  const subset = prep.workspace.subset!
  const angle = job.angle
  const t = (angle * Math.PI) / 180
  const cos = Math.cos(t)
  const sin = Math.sin(t)
  const bbox = turnedBounds(plan.hull, plan.minAlong, plan.maxAlong, stock, angle)
  const angleWarnings: ToolpathWarning[] = []
  const cellSize = chooseHeightMapCellSize(bbox, prep.requestedCellSize, angleWarnings)
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
    ...(conservativeCellBounds ? { trackCellRise: true } : {}),
    ...(conservativeCellBounds && prep.wallTriangleStart !== undefined
      ? { wallTriangleStart: prep.wallTriangleStart }
      : {}),
  }
  if (turned) turnStripTriangles(turned, mesh.positions, mesh.index, plan.across, plan.up, stock, cos, sin, subset, count)
  const heightMap = turned
    ? buildHeightMap(turned, mesh.index, bbox, cellSize, buildOptions)
    : buildRotaryHeightMap({
      axis: stock.axis, centre, pivot, cos, sin,
      geometry: prep.workspace.raster ??= buildRotaryRasterGeometry(
        mesh.positions, mesh.index, stock.axis, centre, pivot),
    }, bbox, cellSize, buildOptions)
  // #1045 slice F: around mode reads every cell as the top of its square, not
  // its centre, so the height map's centre samples can under-read a surface by
  // `(|dz/dx| + |dz/dy|) * cellSize / 2`. That margin is the angle's lift; it is
  // reported, not applied, and assembly adds it to every finite sample of the
  // angle it belongs to.
  const lift = conservativeCellBounds ? Math.min(heightMap.cellRise ?? 0, cellSize) : 0
  const row = new Float32Array(along.length)
  for (let i = 0; i < along.length; i++) {
    const x = stock.axis === 'x' ? along[i] : centre
    const y = stock.axis === 'x' ? centre : along[i]
    const z = safeToolTipZAt(x, y, heightMap, tool,
      conservativeCellBounds ? cellSize * Math.SQRT1_2 : 0)
    row[i] = z === Number.NEGATIVE_INFINITY ? NaN : z - pivot
  }
  return { index: job.index, row, lift, warnings: angleWarnings }
}

/**
 * Ordered assembly of a batch's results (#1115 slice p-d1).
 *
 * Three things happen here and nowhere else: a sample goes back to its **own**
 * index rather than the order it arrived in, its warnings are merged in angle
 * order with the operation's existing first-code-wins rule, and its lift is
 * applied through the same per-sample Float32 assignment the synchronous loop
 * used. A missing, duplicated or out-of-range index is refused outright: a row
 * silently written to the wrong angle is a gouge that no digest would explain.
 */
export function assembleRotarySampling(
  prep: RotarySamplingPrep,
  jobs: readonly RotaryAngleJob[],
  samples: readonly RotaryAngleSample[],
  warnings: ToolpathWarning[],
  stopped: boolean,
): RotarySampling {
  if (samples.length !== jobs.length) {
    throw new Error(`rotary sampling: ${jobs.length} angle job(s) but ${samples.length} result(s)`)
  }
  const ordered: Array<RotaryAngleSample | undefined> = new Array(jobs.length)
  for (const sample of samples) {
    if (!Number.isInteger(sample.index) || sample.index < 0 || sample.index >= jobs.length) {
      throw new Error(`rotary sampling: result carries index ${sample.index}, outside 0..${jobs.length - 1}`)
    }
    if (ordered[sample.index] !== undefined) {
      throw new Error(`rotary sampling: two results for angle job ${sample.index}`)
    }
    ordered[sample.index] = sample
  }
  const anglesDeg: number[] = []
  const tipRadius: Float32Array[] = []
  const lifts: number[] = []
  for (let k = 0; k < jobs.length; k++) {
    const sample = ordered[k]
    if (sample === undefined) throw new Error(`rotary sampling: angle job ${k} has no result`)
    // The lift first, through the same per-sample Float32 store the single-loop
    // sampler used, then the angle's warnings -- in angle order, first code wins.
    const row = sample.row
    const lift = sample.lift
    if (lift > 0) {
      for (let i = 0; i < row.length; i++) {
        if (Number.isFinite(row[i])) row[i] += lift
      }
    }
    for (const warning of sample.warnings) {
      if (!warnings.some((existing) => existing.code === warning.code)) warnings.push(warning)
    }
    anglesDeg.push(jobs[k].angle)
    tipRadius.push(row)
    lifts.push(lift)
  }
  return { anglesDeg, along: [...prep.along], tipRadius, lifts, stopped, valid: true }
}

/**
 * The in-process serial batch runner: the default, and the one this slice
 * exercises. It builds the batch's plan once (so the jobs share the widest
 * reach) and runs the jobs one after another -- no workers, no `Atomics`, no
 * blocking.
 */
export const serialRotaryBatches: RotaryBatchFactory = (prep) => async (jobs) => {
  if (jobs.length === 0) return []
  const plan = prep.planFor(jobs.map((job) => job.angle))
  const samples: RotaryAngleSample[] = []
  for (const job of jobs) samples.push(runRotaryAngleJob(prep, plan, job))
  return samples
}

/**
 * Sample `anglesDeg` against one prep, synchronously.
 *
 * Progress, cancellation and warning order keep the old loop's shapes: the stop
 * callback is polled before each angle (so an immediate stop samples nothing),
 * `onAngle` fires once per finished angle, and the plan is built on the first
 * angle the loop reaches.
 */
export function sampleAnglesWithPrep(
  prep: RotarySamplingPrep,
  anglesDeg: readonly number[],
  warnings: ToolpathWarning[],
  hooks: Pick<RotarySampleOptions, 'onAngle' | 'shouldStop'> = {},
): RotarySampling {
  // The prep's tool is what the window arithmetic divides by, so an invalid one
  // is refused here too, at the same point the single-call entry refuses it.
  if (!(prep.tool.radius > 0) || !Number.isFinite(prep.tool.radius)) return invalidSampling(prep.along)
  const jobs: RotaryAngleJob[] = []
  const samples: RotaryAngleSample[] = []
  let plan: RotaryStripPlan | null = null
  let stopped = false
  for (const angle of anglesDeg) {
    if (hooks.shouldStop?.()) {
      stopped = true
      break
    }
    plan ??= prep.planFor(anglesDeg)
    const job = { index: jobs.length, angle }
    samples.push(runRotaryAngleJob(prep, plan, job))
    jobs.push(job)
    hooks.onAngle?.(jobs.length, anglesDeg.length)
  }
  return assembleRotarySampling(prep, jobs, samples, warnings, stopped)
}

/**
 * Sample `anglesDeg` against one prep through an injected batch runner.
 *
 * One batch per call, assembled by original index. The stop callback is polled
 * before the batch and again when it completes -- a promise gives no other place
 * to look -- so a cancellation that arrives mid-batch returns the finished rows
 * with `stopped: true` rather than a partly written grid. That is what "each
 * refinement batch completes before any failure is evaluated" means for a batch
 * a worker pool owns: no refinement decision reads half a round.
 */
export async function sampleAnglesWithPrepAsync(
  prep: RotarySamplingPrep,
  anglesDeg: readonly number[],
  warnings: ToolpathWarning[],
  hooks: Pick<RotarySampleOptions, 'onAngle' | 'shouldStop'>,
  batches: RotaryAngleBatch,
): Promise<RotarySampling> {
  if (!(prep.tool.radius > 0) || !Number.isFinite(prep.tool.radius)) return invalidSampling(prep.along)
  const jobs = anglesDeg.map((angle, index) => ({ index, angle }))
  if (jobs.length === 0 || hooks.shouldStop?.()) {
    return assembleRotarySampling(prep, [], [], warnings, hooks.shouldStop?.() === true)
  }
  const samples = await batches(jobs)
  hooks.onAngle?.(jobs.length, anglesDeg.length)
  return assembleRotarySampling(prep, jobs, samples, warnings, hooks.shouldStop?.() === true)
}

/** A tool that cannot describe a cutter at all; sampling refuses it (see `RotarySampling.valid`). */
function invalidSampling(along: readonly number[]): RotarySampling {
  return { anglesDeg: [], along: [...along], tipRadius: [], lifts: [], stopped: false, valid: false }
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
export function sampleRotaryModelWithWorkspace(
  mesh: RotaryModelMesh,
  stock: BarStock,
  tool: NormalizedTool,
  options: RotarySampleOptions,
  warnings: ToolpathWarning[],
  workspace: RotarySamplingWorkspace,
): RotarySampling {
  // A tool radius that is not finite and positive cannot sample a surface: the
  // window arithmetic would silently read no cells and every row would be
  // `NaN`, which is indistinguishable from "no model under the tool". Return
  // no rows and an explicit invalid verdict instead, so no caller can turn
  // that failure into a cut along the axis (issue #1016 C2 correction M1).
  if (!(tool.radius > 0) || !Number.isFinite(tool.radius)) return invalidSampling(options.along)
  const prep = createRotarySamplingPrep(mesh, stock, tool, samplingSetup(options, workspace))
  return sampleAnglesWithPrep(prep, options.anglesDeg, warnings, options)
}

/** The prep setup one sampling call describes. */
function samplingSetup(options: RotarySampleOptions, workspace: RotarySamplingWorkspace): RotarySamplingSetup {
  return {
    along: options.along,
    requestedCellSize: options.requestedCellSize,
    ...(options.conservativeCellBounds === true ? { conservativeCellBounds: true } : {}),
    ...(options.wallTriangleStart !== undefined ? { wallTriangleStart: options.wallTriangleStart } : {}),
    ...(options.gridExtra !== undefined ? { gridExtra: options.gridExtra } : {}),
    workspace,
  }
}

/**
 * The asynchronous driver: `sampleRotaryModelWithWorkspace` with every angle
 * batch dispatched through `batches` instead of run inline.
 *
 * The default is the in-process serial runner, so this is the same computation
 * with an `await` in the middle; a worker pool supplies its own factory (p-d2).
 * Nothing about the numerics changes -- the same prep, the same jobs, the same
 * assembly -- and the parity suite pins the two drivers to identical rows,
 * lifts, warnings and motion.
 */
export async function sampleRotaryModelWithWorkspaceAsync(
  mesh: RotaryModelMesh,
  stock: BarStock,
  tool: NormalizedTool,
  options: RotarySampleOptions,
  warnings: ToolpathWarning[],
  workspace: RotarySamplingWorkspace,
  factory: RotaryBatchFactory = serialRotaryBatches,
): Promise<RotarySampling> {
  if (!(tool.radius > 0) || !Number.isFinite(tool.radius)) return invalidSampling(options.along)
  const prep = createRotarySamplingPrep(mesh, stock, tool, samplingSetup(options, workspace))
  return sampleAnglesWithPrepAsync(prep, options.anglesDeg, warnings, options, factory(prep))
}

/** `sampleRotaryModel` through the asynchronous driver and its default serial runner. */
export async function sampleRotaryModelAsync(
  mesh: RotaryModelMesh,
  stock: BarStock,
  tool: NormalizedTool,
  options: RotarySampleOptions,
  warnings: ToolpathWarning[],
  factory: RotaryBatchFactory = serialRotaryBatches,
): Promise<RotarySampling> {
  return sampleRotaryModelWithWorkspaceAsync(mesh, stock, tool, options, warnings, {}, factory)
}


// ── refinement decisions (#1115 slice p-d1) ────────────────────────────────

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
 * What one refinement round reads and writes (#1115 slice p-d1).
 *
 * The state is the whole difference between the two drivers: everything that
 * decides a round -- which midpoints are missing, which segments fail, where a
 * midpoint is inserted -- is a function of this state and the operation, and
 * both drivers call the same functions on it. Only the sampling call between
 * "missing" and "fails" differs.
 */
interface AroundRefinementState {
  angles: number[]
  tips: Float32Array[]
  /**
   * A midpoint row is a pure function of (mesh, tool, along positions, cell
   * size, angle), and all of those are fixed for this refinement. Every round
   * tests all current segments -- a segment that passed can still fail once a
   * subdivided neighbour changes the cusp test -- but only a midpoint that has
   * never been sampled needs a height map. Without this cache each round paid a
   * fresh map for every segment, passing ones included: six rounds of a smooth
   * ring cost six times the base grid even when almost nothing failed (issue
   * #1045 slice T).
   */
  readonly midpointRows: Map<number, Float32Array>
}

/** Everything a refinement reads besides its own state. */
interface AroundRefinementArgs {
  /**
   * The operation's prep: the same mesh, sampling tool, along positions,
   * requested cell size and grid envelope the base grid used, so a midpoint row
   * is sampled by exactly the code that sampled its neighbours.
   */
  readonly prep: RotarySamplingPrep
  readonly stock: BarStock
  /** The real cutter -- not the stock-to-leave-enlarged sampling tool. */
  readonly tool: NormalizedTool
  readonly warnings: ToolpathWarning[]
  readonly shouldStop?: () => boolean
  /** The grid to refine and its rows, in angle order. */
  readonly angles: readonly number[]
  readonly tips: readonly Float32Array[]
}

/** The midpoint of every current segment, in segment order. */
function refinementMidpoints(angles: readonly number[]): number[] {
  return angles.slice(0, -1).map((angle, k) => (angle + angles[k + 1]) / 2)
}

/** The midpoints with no row yet: exactly the jobs one round dispatches. */
function unsampledMidpoints(state: AroundRefinementState, mids: readonly number[]): number[] {
  return mids.filter((angle) => !state.midpointRows.has(angle))
}

/** Cache a round's freshly sampled rows, in the order they were asked for. */
function cacheMidpointRows(
  state: AroundRefinementState,
  missing: readonly number[],
  rows: readonly Float32Array[],
): void {
  for (let k = 0; k < missing.length; k++) state.midpointRows.set(missing[k], rows[k])
}

/**
 * The segments whose straight move falls more than their tolerance below the
 * model at the mid angle, plus the sharp-peak test below (#1045 slice E).
 *
 * Nothing here depends on where the rows came from: a segment decided from
 * synchronously sampled rows is decided the same way from rows a worker pool
 * returned, which is what lets both drivers share every decision.
 */
function failingSegments(
  state: AroundRefinementState,
  mids: readonly number[],
  args: AroundRefinementArgs,
): Set<number> {
  const { tool } = args
  const along = args.prep.along
  const { angles, tips, midpointRows } = state
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
  return fails
}

/**
 * Insert each failing segment's midpoint directly after the segment, in segment
 * order, and keep the angle each row belongs to.
 *
 * The insertion order is the contract the emitted motion depends on: the grid is
 * strictly increasing, a ring's samples are visited in that order, and a
 * midpoint belongs between the two angles it bisects. It is also what keeps the
 * refinement a bisection of the *current* grid rather than a second grid laid
 * on top of it, which is why rounds converge instead of interleaving.
 */
function insertMidpoints(state: AroundRefinementState, mids: readonly number[], fails: ReadonlySet<number>): void {
  const { angles, tips } = state
  const nextAngles: number[] = []
  const nextTips: Float32Array[] = []
  for (let k = 0; k < angles.length; k++) {
    nextAngles.push(angles[k])
    nextTips.push(tips[k])
    if (k + 1 < angles.length && fails.has(k)) {
      nextAngles.push(mids[k])
      nextTips.push(state.midpointRows.get(mids[k])!)
    }
  }
  state.angles = nextAngles
  state.tips = nextTips
}

/** The refinement's state for one grid, shared by both drivers. */
function refinementState(angles: readonly number[], tips: readonly Float32Array[]): AroundRefinementState {
  return { angles: [...angles], tips: [...tips], midpointRows: new Map() }
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
export function refineAroundSampling(
  args: AroundRefinementArgs,
): { angles: number[]; tips: Float32Array[]; stopped: boolean } | null {
  const along = args.prep.along
  const state = refinementState(args.angles, args.tips)
  for (let round = 0; round < MAX_AROUND_REFINEMENT_ROUNDS; round++) {
    const mids = refinementMidpoints(state.angles)
    if (mids.length === 0) break
    const missing = unsampledMidpoints(state, mids)
    if (missing.length > 0) {
      const sampled = sampleAnglesWithPrep(args.prep, missing, args.warnings,
        args.shouldStop ? { shouldStop: args.shouldStop } : {})
      if (!sampled.valid) return null
      if (sampled.stopped) return { angles: state.angles, tips: state.tips, stopped: true }
      cacheMidpointRows(state, missing, sampled.tipRadius)
    }
    const fails = failingSegments(state, mids, args)
    if (fails.size === 0) break
    insertMidpoints(state, mids, fails)
    if (state.angles.length * along.length > MAX_ROTARY_SAMPLES) return null
  }
  return { angles: state.angles, tips: state.tips, stopped: false }
}

/**
 * {@link refineAroundSampling} with each round's missing midpoints dispatched as
 * one batch through `batches`.
 *
 * A round never evaluates a failure until its whole batch is back, every
 * decision is the synchronous function above, and the eight-round limit,
 * midpoint cache and insertion order are the same state. The only difference is
 * where the rows come from.
 */
export async function refineAroundSamplingAsync(
  args: AroundRefinementArgs,
  batches: RotaryAngleBatch,
): Promise<{ angles: number[]; tips: Float32Array[]; stopped: boolean } | null> {
  const along = args.prep.along
  const state = refinementState(args.angles, args.tips)
  for (let round = 0; round < MAX_AROUND_REFINEMENT_ROUNDS; round++) {
    const mids = refinementMidpoints(state.angles)
    if (mids.length === 0) break
    const missing = unsampledMidpoints(state, mids)
    if (missing.length > 0) {
      const sampled = await sampleAnglesWithPrepAsync(args.prep, missing, args.warnings,
        args.shouldStop ? { shouldStop: args.shouldStop } : {}, batches)
      if (!sampled.valid) return null
      if (sampled.stopped) return { angles: state.angles, tips: state.tips, stopped: true }
      cacheMidpointRows(state, missing, sampled.tipRadius)
    }
    const fails = failingSegments(state, mids, args)
    if (fails.size === 0) break
    insertMidpoints(state, mids, fails)
    if (state.angles.length * along.length > MAX_ROTARY_SAMPLES) return null
  }
  return { angles: state.angles, tips: state.tips, stopped: false }
}
