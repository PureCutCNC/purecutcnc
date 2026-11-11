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
import type { HeightMap, HeightMapWindow } from './finishSurfaceParallel'
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
   * Read a row's tip as the **exact** footprint maximum (#1177) instead of a
   * height-map cell's centre sample: the highest point of the turned surface
   * over the disc the cutter's body covers, which is what the rotary generators
   * read once `prepareRotaryTargets` asks for it. `conservativeCellBounds` is
   * ignored on an exact row (its lift is 0).
   */
  readonly exactTipRows?: boolean
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
  /**
   * How this call uses the workspace's angle-map cache (#1185 L1). Omitted, the
   * call neither reads nor writes it, which is the old behaviour byte for byte.
   * See {@link RotaryAngleMapMode}.
   */
  readonly angleMaps?: RotaryAngleMapMode
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
  /**
   * Angle rows whose height map came from one this workspace had already
   * rasterised at the same physical angle (#1103 ca-e): the row is still read
   * at its own along positions, only the map build was saved. Always 0 when no
   * angle-map cache is enabled.
   */
  readonly reused: number
  /**
   * Candidate triangles the rows' raster passes visited (#1103 ca-e correction
   * round 2): the work a row costs, summed over the angle rows this call built.
   * A reused row costs nothing, so it adds 0. It is the deterministic measure a
   * caller budgets an optional sampling pass with -- map builds scale with the
   * candidate set, which depends on the mesh, never on the clock.
   */
  readonly rasterWork: number
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
  /**
   * One **bit** per (bucket, triangle): the members of bucket `k` are the set
   * bits of words `k * bucketWords ... (k + 1) * bucketWords - 1`, bit `b` of
   * word `w` being triangle `w * 32 + b` (issue #1115 slice p-e).
   *
   * The same membership a CSR list of `bucketTriangles` held, at **one bit** per
   * listing instead of four bytes plus a `bucketStarts` offset. On the bust a
   * triangle is listed in ~41 of the 256 buckets, so the index was 19.7 M
   * listings: 79 MB in the CSR form, 15.8 MB here. It is the largest single
   * object a pool worker copies, and the compact form is what lets six workers
   * fit the 512 MiB budget instead of three.
   */
  readonly bucketBits: Uint32Array
  /** 32-bit words per bucket: `ceil(triangleCount / 32)`, `0` for an empty mesh. */
  readonly bucketWords: number
  /** Triangle starts (offsets into `index`) that reach the strip at every turn. */
  readonly always: Uint32Array
  readonly bucketWidth: number
}

/** The mesh-only half of a plan: it does not depend on the tool or the angles. */
type RotaryPlanGeometry = Pick<RotaryStripPlan, 'across' | 'up' | 'hull' | 'minAlong' | 'maxAlong'>

/**
 * Height maps one operation has already rasterised, keyed by physical angle
 * (#1103 ca-e).
 *
 * An around operation samples the same physical angle several times: the ring
 * grid, every refinement round, and -- when a continuous helix replaces a band
 * -- the helix's own rows. The map depends only on the angle (the mesh, tool,
 * cell size and workspace are fixed per operation), so a later row at the same
 * angle only needs the tip read at its own along positions. Reusing the map
 * removes the duplicate raster work without changing a single sampled value.
 *
 * A map is stored **cropped to the rows (or columns) the sampler reads** -- the
 * window `runRotaryAngleJob` rasterises -- so a map that is mostly window costs
 * the window, not the whole grid. Entries are only added while the byte budget
 * has room; the policy is deliberately fill-then-stop rather than evict, so the
 * earliest angles (the ring grid's, which the helix's first round needs) are the
 * ones kept. A map too large to be worth keeping is not stored at all.
 */
export interface RotaryAngleMapCache {
  readonly maps: Map<number, HeightMap>
  /**
   * The exact angle, in degrees, each stored map was rasterised at (#1185 L1).
   * The key rounds the physical angle to 1e-6 degrees, so two doubles that share
   * a key can still turn the mesh by a different last bit; a `'read'` prep needs
   * the angle itself to prove a stored map is the one it would build.
   */
  readonly angles: Map<number, number>
  bytes: number
  readonly budgetBytes: number
  /** The budget is spent: no entry is added after this, so no earlier one is lost. */
  full: boolean
}

/**
 * One angle's map, ready to be cached: the key it belongs under, what it costs
 * and the cropped map itself (#1103 slice ca-i).
 *
 * The serial path inserts this into the workspace cache where it built it. A
 * worker cannot: its workspace is its own copy, so the pool that dispatched the
 * row inserts the entry into the **parent** workspace's cache instead -- in job
 * order, under the same key and the same byte and `full` rules -- which is what
 * makes the cache state after a batch identical to the one a serial batch leaves.
 */
export interface RotaryAngleMapEntry {
  /** {@link cachedAngleKey} of the angle the map was rasterised at. */
  readonly key: number
  /** The angle itself, in degrees, exactly as the job named it (#1185 L1). */
  readonly angle: number
  /** Bytes the cropped map holds (its `data`, coverage and model-only arrays). */
  readonly bytes: number
  readonly map: HeightMap
}

/** The most one operation's angle-map cache may hold. */
export const MAX_ANGLE_MAP_CACHE_BYTES = 32 * 1024 * 1024

/** A single map bigger than this is not cached: the copy would cost as much as a build. */
export const MAX_CACHED_ANGLE_MAP_BYTES = 96 * 1024

/**
 * Whether one prep may write the workspace's angle maps, read them, or neither.
 *
 * `'read'` (#1185 L1) is the bit-exact reader: it never writes, and it takes a
 * stored map only when that map is provably the one this prep would rasterise
 * -- same turn (identical cosine and sine), same grid, same window, same wall
 * arrays -- and then reads it through the full grid it was cropped from, so the
 * row is the row a fresh raster gives, bit for bit. `'read-write'` reads the
 * cropped map directly, which the helix's own tolerance covers.
 */
export type RotaryAngleMapMode = 'off' | 'write' | 'read-write' | 'read'

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
  /**
   * Height maps already rasterised at a physical angle (#1103 ca-e), shared by
   * every prep that samples this operation. See {@link RotaryAngleMapCache}.
   */
  angleMaps?: RotaryAngleMapCache
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
      bucketBits: new Uint32Array(0), bucketWords: 0,
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
  // One bit per listing. A triangle's arc is contiguous (modulo the wrap), so the
  // set it fills is the same one a CSR list appended it to; the scatter costs the
  // same 19.7 M writes the counting pass plus the fill pass used to, for a
  // quarter of the bytes.
  const bucketWords = Math.ceil(triangleCount / 32)
  const bucketBits = new Uint32Array(STRIP_BUCKETS * bucketWords)
  const markBucket = (k: number, t: number): void => {
    bucketBits[k * bucketWords + (t >>> 5)] |= 1 << (t & 31)
  }
  for (let t = 0; t < triangleCount; t++) {
    const first = arcFirst[t]
    if (first < 0) continue
    const last = arcLast[t]
    if (last >= first) {
      for (let k = first; k <= last; k++) markBucket(k, t)
    } else {
      for (let k = first; k < STRIP_BUCKETS; k++) markBucket(k, t)
      for (let k = 0; k <= last; k++) markBucket(k, t)
    }
  }
  const plan: RotaryStripPlan = {
    across, up, hull, minAlong, maxAlong, bucketBits, bucketWords, always, bucketWidth,
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
  /**
   * True when the height map came from the workspace's cache (#1103 ca-e).
   * Optional because a worker's reply is the row alone: the cache lives in the
   * main thread's workspace, and a row sampled in a worker was not reused.
   */
  readonly reused?: boolean
  /**
   * Candidate triangles this row's raster pass visited (#1103 ca-e correction
   * round 2); 0 for a reused row. Optional because a worker's reply need not
   * report it -- a missing value is read as 0, and only an in-process caller
   * budgets on it.
   */
  readonly rasterWork?: number
  /**
   * The map this row built, when the caller asked the row to hand it over so
   * another realm can cache it (#1103 slice ca-i). Absent for every `'off'`
   * prep, and absent for a reused row: there is nothing new to store. The
   * caller inserts it under {@link RotaryAngleMapEntry.key} with the same byte
   * rules the serial path uses; see {@link storeRotaryAngleBatchMaps}.
   */
  readonly map?: RotaryAngleMapEntry
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
  /**
   * Read each along position as the **exact** maximum of the turned surface over
   * the cutter's lateral footprint (#1155 rn-d correction 3). A conservative
   * cell map is an *upper* bound only with a margin, and a wall-foot ring must
   * reach a smooth target's surface to within the surface tolerance while still
   * clearing a crease in it: no single margin does both (0.00915 in high on a
   * smooth target, 0.0078 in into a polygon target's corner).
   *
   * The exact read is the maximum over `tool.radius` of the projected surface,
   * so a prep that sets it must sample the wall-foot rings alone (one or two
   * along positions). Its rows never come from the angle-map cache: the read
   * needs the triangle candidates the raster pass gathered.
   */
  readonly exactTipRows?: boolean
  /**
   * Grow the exact footprint read's disc by this much (#1173).
   *
   * The exact read is the maximum over the cutter's **own** disc, and a disc
   * that only grazes a feature -- a boss's end face two millimetres from the
   * sample, say -- can take that feature's *rim* height instead of its top. A
   * whole-bar base grid meets that at every model end: on the two-boss gap
   * fixture the unpadded read came back 4 mm low. Growing the disc by one
   * half a sampling cell is the uncertainty the conservative cell read's own
   * centre sample has, so a grazing footprint still reads the material it
   * grazes, while a smooth
   * turned surface keeps its maximum inside the disc either way -- a shank still
   * reads the target's own radius. The ring-only columns (a wall foot, a
   * neighbour) keep the unpadded read: they exist to sit exactly on the surface
   * they are tangent to.
   */
  readonly exactTipPad?: number
  /** See `RotarySampleOptions.wallTriangleStart`. */
  readonly wallTriangleStart?: number
  /** See `RotarySampleOptions.gridExtra`. */
  readonly gridExtra?: RotaryModelMesh
  /** Scratch that outlives one sampling call, shared across refinement rounds. */
  readonly workspace?: RotarySamplingWorkspace
  /**
   * Share the operation's height maps by physical angle (#1103 ca-e): `write`
   * adds every map it builds without ever reading one back, `read-write` also
   * reuses a map the workspace already holds. `off` (the default) is the old
   * behaviour byte for byte.
   */
  readonly angleMaps?: RotaryAngleMapMode
  /**
   * Hand every built map back on its sample instead of (or as well as) caching
   * it here (#1103 slice ca-i). A worker sets this: its own workspace is not the
   * parent's, so the pool that dispatched the row is what inserts the entry into
   * the parent cache. `off` preps never emit, which is what keeps a non-helix
   * caller's transport unchanged.
   */
  readonly emitAngleMaps?: boolean
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
  /** See `RotarySamplingSetup.exactTipRows` (#1155 rn-d correction 3). */
  readonly exactTipRows?: boolean
  /** See `RotarySamplingSetup.exactTipPad` (#1173). */
  readonly exactTipPad?: number
  readonly wallTriangleStart?: number
  readonly gridExtra?: RotaryModelMesh
  /** See `RotarySamplingSetup.angleMaps` (#1103 ca-e). */
  readonly angleMaps: RotaryAngleMapMode
  /**
   * Return each built map on its sample for someone else to cache (#1103 slice
   * ca-i). A worker's prep sets this; the parent's does not, because the parent
   * caches where it builds. See `RotarySamplingSetup.emitAngleMaps`.
   */
  readonly emitAngleMaps?: boolean
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
    ...(setup.exactTipRows === true ? { exactTipRows: true } : {}),
    ...(setup.exactTipPad !== undefined ? { exactTipPad: setup.exactTipPad } : {}),
    ...(setup.wallTriangleStart !== undefined ? { wallTriangleStart: setup.wallTriangleStart } : {}),
    ...(setup.gridExtra !== undefined ? { gridExtra: setup.gridExtra } : {}),
    angleMaps: setup.angleMaps ?? 'off',
    ...(setup.emitAngleMaps === true ? { emitAngleMaps: true } : {}),
    workspace,
    centre: barCentre(stock),
    pivot: barPivotZ(stock),
    turned,
    planFor(anglesDeg) {
      return buildStripPlan(mesh, stock, tool, setup.requestedCellSize, anglesDeg, workspace, setup.gridExtra)
    },
  }
}

/** The workspace's angle-map cache, created on first use (#1103 ca-e). */
function angleMapCache(workspace: RotarySamplingWorkspace): RotaryAngleMapCache {
  return workspace.angleMaps ??= {
    maps: new Map(),
    angles: new Map(),
    bytes: 0,
    budgetBytes: MAX_ANGLE_MAP_CACHE_BYTES,
    full: false,
  }
}

/**
 * The cache key of a physical angle (#1103 ca-e).
 *
 * A turned surface repeats every 360 degrees, so A0 and A360 are one map; the
 * key is the physical angle in [0, 360) on a 1e-6-degree grid. The grid is far
 * finer than any difference that can move a cell: 1e-6 degrees is 1.7e-8 rad,
 * orders below a Float32 coordinate's resolution at any bar this app cuts. It
 * exists because the helix and the ring grid compute the same physical angle
 * from different path parameters, so their doubles can differ in the last bit.
 *
 * Exported for the pool (#1103 slice ca-i review round 1): a `read-write` batch
 * must partition on this exact identity, because two rows of one batch that name
 * the same physical angle -- A0 and A360, say -- share one map, and the later row
 * must reuse the earlier one's map rather than rasterise it again.
 */
export function cachedAngleKey(angle: number): number {
  const physical = ((angle % 360) + 360) % 360
  return Math.round(physical * 1_000_000)
}

/**
 * Whether the workspace already holds the map for this physical angle (#1103
 * slice ca-i).
 *
 * The pool asks this before it dispatches a `read-write` batch: a row the parent
 * can answer from its own cache must not be sent to a worker, which has no such
 * cache and would rasterise the map again.
 */
export function hasRotaryAngleMap(workspace: RotarySamplingWorkspace, angle: number): boolean {
  return workspace.angleMaps?.maps.has(cachedAngleKey(angle)) === true
}

/** The rows (X bar) or columns (Y bar) one angle's sampler actually reads. */
function cachedMapWindow(
  map: Pick<HeightMap, 'width' | 'height'>,
  window: HeightMapWindow | undefined,
  axis: BarStock['axis'],
): { rowStart: number; rowEnd: number; colStart: number; colEnd: number } {
  const rowStart = axis === 'x' ? Math.max(0, window?.minRow ?? 0) : 0
  const rowEnd = axis === 'x' ? Math.min(map.height - 1, window?.maxRow ?? map.height - 1) : map.height - 1
  const colStart = axis === 'y' ? Math.max(0, window?.minCol ?? 0) : 0
  const colEnd = axis === 'y' ? Math.min(map.width - 1, window?.maxCol ?? map.width - 1) : map.width - 1
  return { rowStart, rowEnd, colStart, colEnd }
}

/** Copy the windowed part of a per-cell array into its own buffer, or `undefined`. */
function cropCells(source: Float32Array | undefined, width: number, bounds: { rowStart: number; rowEnd: number; colStart: number; colEnd: number}): Float32Array | undefined {
  if (source === undefined) return undefined
  const { rowStart, rowEnd, colStart, colEnd } = bounds
  const copyWidth = colEnd - colStart + 1
  const copyHeight = rowEnd - rowStart + 1
  if (copyWidth === width && rowStart === 0 && copyHeight * width === source.length) return source
  const copy = new Float32Array(copyWidth * copyHeight)
  for (let row = 0; row < copyHeight; row++) {
    const from = (rowStart + row) * width + colStart
    copy.set(source.subarray(from, from + copyWidth), row * copyWidth)
  }
  return copy
}

/** `cropCells` for the byte-per-cell wall coverage. */
function cropBytes(source: Uint8Array | undefined, width: number, bounds: { rowStart: number; rowEnd: number; colStart: number; colEnd: number }): Uint8Array | undefined {
  if (source === undefined) return undefined
  const { rowStart, rowEnd, colStart, colEnd } = bounds
  const copyWidth = colEnd - colStart + 1
  const copyHeight = rowEnd - rowStart + 1
  if (copyWidth === width && rowStart === 0 && copyHeight * width === source.length) return source
  const copy = new Uint8Array(copyWidth * copyHeight)
  for (let row = 0; row < copyHeight; row++) {
    const from = (rowStart + row) * width + colStart
    copy.set(source.subarray(from, from + copyWidth), row * copyWidth)
  }
  return copy
}

/**
 * Crop one angle's map to the window the sampler reads (#1103 ca-e), or `null`
 * when the copy would cost about what a rebuild costs.
 *
 * Only the window is copied: for an around pass that is a thin strip along the
 * bar, so a cached map costs a fraction of the raster. A map larger than
 * {@link MAX_CACHED_ANGLE_MAP_BYTES} is refused **before** it is copied -- a gate
 * that copied first would cost the copy it exists to avoid.
 */
function cropAngleMap(
  key: number,
  angle: number,
  map: HeightMap,
  window: HeightMapWindow | undefined,
  axis: BarStock['axis'],
): RotaryAngleMapEntry | null {
  const bounds = cachedMapWindow(map, window, axis)
  // #1103 ca-j: a window entirely off the map has no cell to keep, so there is
  // nothing to copy and nothing to reuse. It happens when the sampler's ray --
  // the bar's centreline -- lies outside the model's own turned bounds, which an
  // offset box on a **square blank** (material all on one side of the axis)
  // makes routine: the row it would serve reads no cell and comes back `NaN`
  // either way. The empty intersection used to reach `cropCells` as a negative
  // length.
  if (bounds.colEnd < bounds.colStart || bounds.rowEnd < bounds.rowStart) return null
  const cells = (bounds.colEnd - bounds.colStart + 1) * (bounds.rowEnd - bounds.rowStart + 1)
  const perCell = 4 + (map.wallCoverage !== undefined ? 1 : 0) + (map.modelOnly !== undefined ? 4 : 0)
  if (cells * perCell > MAX_CACHED_ANGLE_MAP_BYTES) return null
  const coverage = cropBytes(map.wallCoverage, map.width, bounds)
  const modelOnly = cropCells(map.modelOnly, map.width, bounds)
  const cropped: HeightMap = {
    data: cropCells(map.data, map.width, bounds)!,
    width: bounds.colEnd - bounds.colStart + 1,
    height: bounds.rowEnd - bounds.rowStart + 1,
    originX: map.originX + bounds.colStart * map.cellSize,
    originY: map.originY + bounds.rowStart * map.cellSize,
    cellSize: map.cellSize,
    ...(map.cellRise !== undefined ? { cellRise: map.cellRise } : {}),
    ...(coverage !== undefined ? { wallCoverage: coverage } : {}),
    ...(modelOnly !== undefined ? { modelOnly } : {}),
  }
  return {
    key,
    angle,
    bytes: cropped.data.byteLength + (cropped.wallCoverage?.byteLength ?? 0) + (cropped.modelOnly?.byteLength ?? 0),
    map: cropped,
  }
}

/**
 * Put one entry in the cache, under the rules the serial path has always used
 * (#1103 ca-e): a key the cache already holds is not replaced, and the first
 * entry that would pass the byte budget stops the cache filling, so the earliest
 * angles (the ring grid's, which the helix's first round needs) are the ones
 * kept.
 *
 * Shared by the serial path and by the pool's insertion of worker maps, which is
 * what makes those two cache states the same (#1103 slice ca-i).
 */
export function insertRotaryAngleMap(cache: RotaryAngleMapCache, entry: RotaryAngleMapEntry): void {
  if (cache.full || cache.maps.has(entry.key)) return
  if (cache.bytes + entry.bytes > cache.budgetBytes) {
    cache.full = true
    return
  }
  cache.maps.set(entry.key, entry.map)
  cache.angles.set(entry.key, entry.angle)
  cache.bytes += entry.bytes
}

/**
 * The full-grid map a stored angle map was cropped from, or `undefined` when the
 * stored map is not provably the one this row would rasterise (#1185 L1).
 *
 * A link row asks for a map the ring grid has usually built already. Reading the
 * cropped copy directly would move the grid origin by `rowStart * cellSize`, and
 * a cell centre computed from the moved origin can differ from the original in
 * its last bit -- enough to flip a cell at the edge of the cutter's reach. So the
 * rows are copied back into a grid with the **original** origin, width and
 * height: every cell the window holds is the value the raster wrote, every cell
 * outside it is the empty value a windowed raster leaves, and the tip read that
 * follows is the same arithmetic on the same numbers.
 *
 * Every condition a fresh raster depends on is checked rather than assumed:
 *
 * - the turn: the stored map's exact angle must give the same cosine and sine,
 *   which are the only way the angle enters the projection and the bounds;
 * - the grid: `bbox` and `cellSize` are this row's own, so the stored map must
 *   have that cell size and exactly the window's extent on that grid;
 * - the arrays: wall coverage and the cell rise are present exactly when this
 *   prep's raster would have produced them.
 *
 * The mesh, tool and envelope are the caller's promise -- a prep is `'read'`
 * only on the workspace of the prep that wrote the maps.
 */
function restoreRotaryAngleMap(
  cache: RotaryAngleMapCache | undefined,
  key: number,
  cos: number,
  sin: number,
  bbox: TurnedBounds,
  cellSize: number,
  window: HeightMapWindow,
  axis: BarStock['axis'],
  expectWalls: boolean,
  expectCellRise: boolean,
): HeightMap | undefined {
  const stored = cache?.maps.get(key)
  const storedAngle = cache?.angles.get(key)
  if (stored === undefined || storedAngle === undefined) return undefined
  const storedTurn = (storedAngle * Math.PI) / 180
  if (Math.cos(storedTurn) !== cos || Math.sin(storedTurn) !== sin) return undefined
  if (stored.cellSize !== cellSize) return undefined
  if ((stored.wallCoverage !== undefined) !== expectWalls || (stored.modelOnly !== undefined) !== expectWalls) return undefined
  if ((stored.cellRise !== undefined) !== expectCellRise) return undefined
  // The grid `buildRotaryHeightMap` lays over these bounds.
  const width = Math.max(1, Math.ceil((bbox.maxX - bbox.minX) / cellSize))
  const height = Math.max(1, Math.ceil((bbox.maxY - bbox.minY) / cellSize))
  const bounds = cachedMapWindow({ width, height }, window, axis)
  if (bounds.colEnd < bounds.colStart || bounds.rowEnd < bounds.rowStart) return undefined
  const windowWidth = bounds.colEnd - bounds.colStart + 1
  const windowHeight = bounds.rowEnd - bounds.rowStart + 1
  if (stored.width !== windowWidth || stored.height !== windowHeight) return undefined
  const data = new Float32Array(width * height).fill(-Infinity)
  const wallCoverage = stored.wallCoverage !== undefined ? new Uint8Array(width * height) : undefined
  const modelOnly = stored.modelOnly !== undefined ? new Float32Array(width * height).fill(-Infinity) : undefined
  for (let row = 0; row < windowHeight; row++) {
    const from = row * windowWidth
    const to = (bounds.rowStart + row) * width + bounds.colStart
    data.set(stored.data.subarray(from, from + windowWidth), to)
    if (wallCoverage !== undefined) wallCoverage.set(stored.wallCoverage!.subarray(from, from + windowWidth), to)
    if (modelOnly !== undefined) modelOnly.set(stored.modelOnly!.subarray(from, from + windowWidth), to)
  }
  return {
    data, width, height, originX: bbox.minX, originY: bbox.minY, cellSize,
    ...(stored.cellRise !== undefined ? { cellRise: stored.cellRise } : {}),
    ...(wallCoverage !== undefined ? { wallCoverage } : {}),
    ...(modelOnly !== undefined ? { modelOnly } : {}),
  }
}

/**
 * Cache the maps a batch returned, in **job order** (#1103 slice ca-i).
 *
 * Order is the whole point. The pool's replies arrive in completion order, which
 * depends on which worker finished first, so inserting as they arrive would make
 * both the contents and the `full` latch timing-dependent. Inserting the batch's
 * samples in job order instead replays exactly the sequence a serial batch would
 * have inserted, so the cache state after any batch equals the serial one.
 */
export function storeRotaryAngleBatchMaps(
  prep: RotarySamplingPrep,
  samples: readonly RotaryAngleSample[],
): void {
  if (prep.angleMaps === 'off') return
  const cache = angleMapCache(prep.workspace)
  for (const sample of samples) {
    if (sample.map !== undefined) insertRotaryAngleMap(cache, sample.map)
  }
}

/**
 * Keep one angle's map for later rows at the same angle (#1103 ca-e).
 *
 * See {@link cropAngleMap} for the size gate and {@link insertRotaryAngleMap}
 * for the budget and `full` rules.
 */
function storeAngleMap(
  cache: RotaryAngleMapCache,
  key: number,
  angle: number,
  map: HeightMap,
  window: HeightMapWindow | undefined,
  axis: BarStock['axis'],
): void {
  if (cache.full || cache.maps.has(key)) return
  const entry = cropAngleMap(key, angle, map, window, axis)
  if (entry !== null) insertRotaryAngleMap(cache, entry)
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
  const angleWarnings: ToolpathWarning[] = []
  // #1103 ca-e: one map per physical angle serves every row that asks for it.
  // The map depends only on the angle -- this prep's mesh, tool, cell size and
  // workspace are fixed for the operation -- so a hit skips the whole raster
  // pass and only the tip read below remains. A `write` prep never reads, which
  // keeps every existing caller's rows exactly as they were.
  // #1185 L1: a `'read'` prep never writes, so it never creates the cache either.
  const cache = prep.angleMaps === 'off' || prep.angleMaps === 'read' ? undefined : angleMapCache(prep.workspace)
  const cacheKey = cachedAngleKey(angle)
  // #1155 rn-d correction 3: an exact-tip prep reads the candidate triangles the
  // raster pass gathered, so it never answers a row from the cache.
  const cached = prep.angleMaps === 'read-write' && prep.exactTipRows !== true
    ? cache?.maps.get(cacheKey)
    : undefined
  let reused = cached !== undefined
  let rasterWork = 0
  let candidates = 0
  let heightMap = cached
  let emittedMap: RotaryAngleMapEntry | undefined
  build: if (heightMap === undefined) {
    const bbox = turnedBounds(plan.hull, plan.minAlong, plan.maxAlong, stock, angle)
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
    // #1185 L1: a map the operation already rasterised at exactly this turn is
    // the map the raster below would build, so it is restored instead of built.
    // An exact-tip row reads the candidate triangles, never a map, so it does
    // not take one; neither does the along path's centre-sampled raster, whose
    // maps are never stored.
    if (prep.angleMaps === 'read' && prep.exactTipRows !== true && turned === null) {
      heightMap = restoreRotaryAngleMap(
        prep.workspace.angleMaps, cacheKey, cos, sin, bbox, cellSize, window, stock.axis,
        conservativeCellBounds && prep.wallTriangleStart !== undefined, conservativeCellBounds)
      if (heightMap !== undefined) {
        reused = true
        break build
      }
    }
    // Only triangles whose cross-section arc covers this turn's strip direction
    // can put a cell in that window. The bucket index is conservative -- a
    // triangle lands in every bucket its arc touches, padded a bucket either
    // side -- so the rasterised set is a superset of the covering triangles, and
    // a cell's value is the maximum over all covering triangles either way.
    let count = plan.always.length
    for (let i = 0; i < plan.always.length; i++) subset[i] = plan.always[i]
    // The two buckets' set bits, each bucket in ascending triangle order: the
    // order a triangle is rasterised in cannot change the map (a cell takes the
    // maximum), but keeping it ascending keeps the reads sequential.
    //
    // #1185 F1: the far bucket is listed in two parts. A triangle the near
    // bucket also holds is submitted a second time exactly as before; the rest
    // reach this strip **only** on the far side of the bar, and are listed last
    // so the raster can skip the ones the near side already covers. The list
    // holds the same triangles the same number of times -- only its order
    // changed, and a cell takes a maximum.
    const bucketWords = plan.bucketWords
    let farOnlyStart = count
    if (bucketWords > 0) {
      const bucketBits = plan.bucketBits
      const nearBase = bucketIndex(Math.PI / 2 - t, plan.bucketWidth) * bucketWords
      const farBase = bucketIndex(Math.PI / 2 - t + Math.PI, plan.bucketWidth) * bucketWords
      for (let word = 0; word < bucketWords; word++) {
        let bits = bucketBits[nearBase + word]
        while (bits !== 0) {
          const lowest = bits & -bits
          subset[count++] = ((word << 5) + 31 - Math.clz32(lowest)) * 3
          bits ^= lowest
        }
      }
      for (let word = 0; word < bucketWords; word++) {
        let bits = bucketBits[farBase + word] & bucketBits[nearBase + word]
        while (bits !== 0) {
          const lowest = bits & -bits
          subset[count++] = ((word << 5) + 31 - Math.clz32(lowest)) * 3
          bits ^= lowest
        }
      }
      farOnlyStart = count
      for (let word = 0; word < bucketWords; word++) {
        let bits = bucketBits[farBase + word] & ~bucketBits[nearBase + word]
        while (bits !== 0) {
          const lowest = bits & -bits
          subset[count++] = ((word << 5) + 31 - Math.clz32(lowest)) * 3
          bits ^= lowest
        }
      }
    }
    // The subset is this row's raster work: every candidate is projected and
    // tested whether or not it lands in the window (#1103 ca-e correction 2).
    rasterWork = count
    candidates = count
    // #1173: an exact-tip row reads the candidate triangles themselves and
    // never the map (its lift is 0, and it is never cached), so the raster pass
    // is skipped. The row is the same; only the wasted map is gone.
    if (prep.exactTipRows === true) {
      const row = new Float32Array(along.length)
      exactFootprintTips(row, prep, plan, subset, candidates, cos, sin)
      return { index: job.index, row, lift: 0, warnings: angleWarnings, reused: false, rasterWork }
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
    const built = turned
      ? buildHeightMap(turned, mesh.index, bbox, cellSize, buildOptions)
      : buildRotaryHeightMap({
        axis: stock.axis, centre, pivot, cos, sin,
        geometry: prep.workspace.raster ??= buildRotaryRasterGeometry(
          mesh.positions, mesh.index, stock.axis, centre, pivot),
      }, bbox, cellSize, { ...buildOptions, farOnlyStart })
    if (cache !== undefined) storeAngleMap(cache, cacheKey, angle, built, window, stock.axis)
    // #1103 slice ca-i: a worker's workspace is not the parent's, so it hands the
    // map it built back on the sample and the pool caches it there, in job order,
    // with the same key and byte rules. The crop is the one the serial path would
    // have stored -- done here so the parent never copies it a second time -- and
    // an `'off'` prep emits nothing at all.
    if (prep.emitAngleMaps === true) emittedMap = cropAngleMap(cacheKey, angle, built, window, stock.axis) ?? undefined
    heightMap = built
  }
  // #1045 slice F: around mode reads every cell as the top of its square, not
  // its centre, so the height map's centre samples can under-read a surface by
  // `(|dz/dx| + |dz/dy|) * cellSize / 2`. That margin is the angle's lift; it is
  // reported, not applied, and assembly adds it to every finite sample of the
  // angle it belongs to.
  const cellSize = heightMap.cellSize
  const lift = conservativeCellBounds && prep.exactTipRows !== true
    ? Math.min(heightMap.cellRise ?? 0, cellSize)
    : 0
  const row = new Float32Array(along.length)
  if (prep.exactTipRows === true) {
    // #1155 rn-d correction 3: the ring's tip is a geometric quantity -- the
    // maximum of the turned surface over the disc the cutter's body covers --
    // and the conservative map's margins are only an approximation of it. Read
    // it exactly, from the same candidate triangles the raster pass gathered.
    exactFootprintTips(row, prep, plan, subset, candidates, cos, sin)
    return {
      index: job.index, row, lift, warnings: angleWarnings, reused, rasterWork,
      ...(emittedMap !== undefined ? { map: emittedMap } : {}),
    }
  }
  for (let i = 0; i < along.length; i++) {
    const x = stock.axis === 'x' ? along[i] : centre
    const y = stock.axis === 'x' ? centre : along[i]
    // #1155 rn-c: the conservative read reaches a **full** cell past the sample,
    // not half a diagonal. A map records each cell's surface at the cell's
    // centre, so material that ends inside the next cell -- a neighbour's end
    // face, a Hex corner -- is recorded only when that cell's centre is inside
    // it. A face just below a cell centre therefore leaves the cell at the lower
    // surface, and the last centre that does hold the material can be a whole
    // cell from the face. The half-diagonal pad stopped short of that by up to
    // `cell / 2 - cell * (√2 - 1)`, and the cutter body entered a neighbour's
    // end face by that much (0.073 mm measured on Frank's bolt, whose Turn
    // starts 0.05 in inside the Hex, so the face sits in a cell the sampler
    // reads as the Turn).
    const z = safeToolTipZAt(x, y, heightMap, tool, conservativeCellBounds ? cellSize : 0)
    row[i] = z === Number.NEGATIVE_INFINITY ? NaN : z - pivot
  }
  return {
    index: job.index, row, lift, warnings: angleWarnings, reused, rasterWork,
    ...(emittedMap !== undefined ? { map: emittedMap } : {}),
  }
}

/**
 * The most bins one exact row files its candidates into along the bar (#1185
 * X1). The bins are a quarter of the footprint radius wide unless the model is
 * long enough to need more than this many; then they widen, which only makes a
 * position read a few more facets.
 */
const EXACT_ROW_MAX_BINS = 4096

/**
 * The relative slack on a facet's top when it is compared with the best tip so
 * far (#1185 X1): a facet is skipped only when its highest point is below the
 * tip by more than this, so rounding in a contact that would have tied can
 * never be what decides it.
 */
const EXACT_ROW_TOP_MARGIN = 1e-9

/**
 * The **exact** maximum of the turned surface over one cutter footprint (#1155
 * rn-d correction 3).
 *
 * The conservative cell read (`safeToolTipZAt` plus the cell pad and the angle's
 * lift) is an upper bound of this maximum, and a loose one. A wall-foot ring
 * needs the maximum itself: it must reach a smooth target's surface within the
 * surface tolerance (where the margin cut 0.00915 in high) and it must not cut
 * into a crease in the target (where taking the margin back off cut 0.0078 in
 * into a polygon's corner). No single margin is both, so the ring reads the
 * geometry:
 *
 * - The footprint is the disc `|(along, across) - (ring, centre)| <= radius`,
 *   exactly the cutter body's lateral cross-section in the turned frame --
 *   `across` is the tangential coordinate, so a surface point inside the disc is
 *   a point the flat's body covers.
 * - The turned height `up` is an **affine** function of `(along, across)` over
 *   each projected triangle (the turn is a rotation of the cross-section), so
 *   the maximum over triangle ∩ disc is at a vertex of that region or, when the
 *   region's boundary runs along the circle, at the disc's own highest point of
 *   that triangle's plane. Both are computed here; nothing is sampled.
 *
 * The candidate triangles are the raster pass's own subset, a superset of the
 * triangles covering the window band (`radius + one cell` wide) this disc sits
 * inside. A projection that collapses to a line is skipped, exactly as
 * `buildHeightMap` skips it; a position with no triangle over its disc stays
 * `NaN`, the "no model under the tool" rule every other row follows.
 *
 * A **ball** endmill does not read this maximum (#1177). The disc maximum is the
 * answer for a flat bottom, whose tip is the plane it stands on; a ball's tip is
 * one radius below its centre, so a surface point at distance `d` from the pose
 * only lifts the tip by `sqrt(r^2 - d^2)` above the contact -- and on a facet
 * tilted `delta` the disc maximum over-reads the true tip by
 * `r (sin delta + cos delta - 1) / cos delta`: 0.21 mm at 25 degrees with a
 * 1/8 in ball, 0.59 mm at the same angle through this read's use on a
 * neighbour's column. That is the raised band #1177 is about, so a ball reads
 * the **exact sphere drop** instead: the highest centre at which a sphere of the
 * tool radius clears each candidate triangle -- its interior plane, its edges
 * and its vertices, the standard drop-cutter -- and the tip is that centre less
 * the radius. Both branches are exact; only the tool shape differs.
 *
 * `exactTipPad` grows the **disc**, which is the flat bottom's lateral
 * footprint: it is the slack a flat needs so a pose cannot sit tangentially on a
 * face at a whole-cell grid position. A ball's pad would have to grow the sphere
 * itself, which lifts the tip by the pad on a level facet (0.32 mm for the
 * helix's 1.25 cells), so a ball takes no pad and covers the distance between
 * two samples by its own chord instead (see `continuousFinishInput`).
 */
function exactFootprintTips(
  row: Float32Array,
  prep: RotarySamplingPrep,
  plan: RotaryStripPlan,
  subset: Uint32Array,
  count: number,
  cos: number,
  sin: number,
): void {
  const { mesh, stock, tool, along, pivot } = prep
  const positions = mesh.positions
  const index = mesh.index
  const across = plan.across
  const up = plan.up
  // #1173: the disc a whole-grid read uses is the cutter's own, grown by one
  // sampling cell when the prep asks for it (see `exactTipPad`).
  // #1177: the pad belongs to the flat's lateral disc only. A ball reads its own
  // sphere, and growing that would lift every tip by the pad, so it takes none.
  const ball = tool.type === 'ball_endmill'
  const radius = tool.radius + (ball ? 0 : (prep.exactTipPad ?? 0))
  const radiusSq = radius * radius
  const alongAxis = stock.axis === 'x' ? 0 : 1
  // The projected triangle in one ring's local `(along, across)` frame.
  const vx = [0, 0, 0]
  const vy = [0, 0, 0]
  const vz = [0, 0, 0]
  // #1173: the turned `across` and `up` of each candidate vertex, and its along
  // position, depend only on the angle, so they are computed once here and read
  // by every ring; only `along - origin` is per ring. The values are the same
  // expressions the per-ring projection used, so every tip is bit for bit the
  // same, and a triangle whose along span misses a ring's disc is skipped
  // before anything else is read.
  const turned = new Float64Array(count * 9)
  const spanMin = new Float64Array(count)
  const spanMax = new Float64Array(count)
  // #1173: a candidate's turned `across` does not depend on the ring, so its
  // bounds against the footprint's `[-radius, radius]` window are hoisted out of
  // the ring walk -- one pair per candidate per angle instead of one per ring.
  // The exact reads are now the whole around grid's read, so this is the hot
  // path; the arithmetic it skips is a pure bound test, so every value below is
  // the statement it was.
  const acrossMin = new Float64Array(count)
  const acrossMax = new Float64Array(count)
  // #1185 X1: each facet's highest turned point. No point of a facet is above
  // it, and a cutter resting on a facet has its tip at or below the point it
  // touches, so a facet whose top is below the best tip found so far cannot
  // raise it.
  const top = new Float64Array(count)
  for (let s = 0; s < count; s++) {
    const offset = subset[s]
    let lo = Number.POSITIVE_INFINITY
    let hi = Number.NEGATIVE_INFINITY
    let low = Number.POSITIVE_INFINITY
    let high = Number.NEGATIVE_INFINITY
    let peak = Number.NEGATIVE_INFINITY
    for (let j = 0; j < 3; j++) {
      const v = index[offset + j]
      const a = positions[v * 3 + alongAxis]
      const y = across[v] * cos - up[v] * sin
      turned[s * 9 + j * 3] = a
      turned[s * 9 + j * 3 + 1] = y
      const z = pivot + across[v] * sin + up[v] * cos
      turned[s * 9 + j * 3 + 2] = z
      if (z > peak) peak = z
      if (a < lo) lo = a
      if (a > hi) hi = a
      if (y < low) low = y
      if (y > high) high = y
    }
    spanMin[s] = lo
    spanMax[s] = hi
    acrossMin[s] = low
    acrossMax[s] = high
    top[s] = peak
  }
  // #1185 X1: sort the row's candidates along the bar once, so each ring position
  // reads the facets its footprint can reach instead of testing every candidate.
  //
  // A facet whose across span misses the footprint is skipped at every position
  // (that test does not depend on the position), so it is dropped here. The rest
  // are filed by where they **start** along the bar, in bins a quarter of the
  // footprint radius wide. A facet no longer than a bin that reaches a position's
  // footprint starts no more than one bin before the footprint does, so the bins
  // from two before the footprint's low edge to one after its high edge hold every
  // such facet -- the extra bin on each side absorbs the rounding in the bin
  // arithmetic. A facet longer than a bin (a long strip, a retained wall) is kept
  // on a list every position reads. The bins only choose what is visited: each
  // visited facet still passes the same span tests as before, and a row's value is
  // a maximum, which the visiting order cannot change.
  const slots = new Int32Array(count)
  let longCount = 0
  let shortCount = 0
  let startLow = Number.POSITIVE_INFINITY
  let startHigh = Number.NEGATIVE_INFINITY
  for (let s = 0; s < count; s++) {
    if (acrossMin[s] > radius || acrossMax[s] < -radius) continue
    shortCount++
    if (spanMin[s] < startLow) startLow = spanMin[s]
    if (spanMin[s] > startHigh) startHigh = spanMin[s]
  }
  const startRange = shortCount > 0 && Number.isFinite(startLow) && Number.isFinite(startHigh) ? startHigh - startLow : 0
  const binWidth = Math.max(radius / 4, startRange / EXACT_ROW_MAX_BINS)
  const binCount = binWidth > 0 && Number.isFinite(binWidth) ? Math.floor(startRange / binWidth) + 1 : 1
  const binOf = new Int32Array(count)
  const binStart = new Int32Array(binCount + 1)
  for (let s = 0; s < count; s++) {
    if (acrossMin[s] > radius || acrossMax[s] < -radius) {
      binOf[s] = -2
      continue
    }
    // A facet longer than a bin, or one whose span is not a number at all, is
    // read at every position, exactly as it was before.
    if (!(spanMax[s] - spanMin[s] <= binWidth)) {
      binOf[s] = -1
      longCount++
      continue
    }
    const bin = Math.min(binCount - 1, Math.max(0, Math.floor((spanMin[s] - startLow) / binWidth)))
    binOf[s] = bin
    binStart[bin + 1]++
  }
  for (let b = 0; b < binCount; b++) binStart[b + 1] += binStart[b]
  // `slots` holds the long facets first, then each bin's facets in turn.
  const binFill = new Int32Array(binCount)
  let longFill = 0
  for (let s = 0; s < count; s++) {
    const bin = binOf[s]
    if (bin === -2) continue
    if (bin === -1) slots[longFill++] = s
    else slots[longCount + binStart[bin] + binFill[bin]++] = s
  }
  // Barycentric sign test against the projected triangle, in the disc's local
  // frame. Defined once per row (it reads the triangle scratch above), not per
  // ring position or candidate (#1185 X1: a function made per position is paid
  // for once per position).
  const contains = (px: number, py: number): boolean => {
    const c0 = (vx[1] - px) * (vy[2] - py) - (vx[2] - px) * (vy[1] - py)
    const c1 = (vx[2] - px) * (vy[0] - py) - (vx[0] - px) * (vy[2] - py)
    const c2 = (vx[0] - px) * (vy[1] - py) - (vx[1] - px) * (vy[0] - py)
    return (c0 >= -1e-12 && c1 >= -1e-12 && c2 >= -1e-12)
      || (c0 <= 1e-12 && c1 <= 1e-12 && c2 <= 1e-12)
  }
  for (let i = 0; i < along.length; i++) {
    const origin = along[i]
    let best = Number.NEGATIVE_INFINITY
    // The long facets, then the bins this position's footprint can reach.
    const firstBin = Math.max(0, Math.floor((origin - radius - startLow) / binWidth) - 2)
    const lastBin = Math.min(binCount - 1, Math.floor((origin + radius - startLow) / binWidth) + 1)
    const binnedFrom = longCount + (firstBin <= lastBin ? binStart[firstBin] : 0)
    const binnedTo = longCount + (firstBin <= lastBin ? binStart[lastBin + 1] : 0)
    for (let n = 0; n < binnedTo; n++) {
      if (n === longCount) n = binnedFrom
      if (n >= binnedTo) break
      const s = slots[n]
      if (spanMin[s] - origin > radius || spanMax[s] - origin < -radius) continue
      // A facet wholly below the best tip so far cannot raise it. The margin is
      // far above the rounding of the contact arithmetic (about 1e-13 at these
      // coordinates) and far below anything a tip is compared by, so a skipped
      // facet's own contact would have failed the `> best` test below.
      if (top[s] + EXACT_ROW_TOP_MARGIN * (1 + Math.abs(top[s])) < best) continue
      // Inlined projection (the same three statements the scratch closure wrote).
      const base = s * 9
      vx[0] = turned[base] - origin
      vy[0] = turned[base + 1]
      vz[0] = turned[base + 2]
      vx[1] = turned[base + 3] - origin
      vy[1] = turned[base + 4]
      vz[1] = turned[base + 5]
      vx[2] = turned[base + 6] - origin
      vy[2] = turned[base + 7]
      vz[2] = turned[base + 8]
      // A triangle whose projected bounds miss the disc cannot contribute.
      const minX = Math.min(vx[0], vx[1], vx[2])
      if (minX > radius) continue
      const maxX = Math.max(vx[0], vx[1], vx[2])
      if (maxX < -radius) continue
      const e1x = vx[1] - vx[0]
      const e1y = vy[1] - vy[0]
      const e2x = vx[2] - vx[0]
      const e2y = vy[2] - vy[0]
      const denom = e1x * e2y - e1y * e2x
      // The height map reads no surface from a projection that collapses to a
      // line either (`buildHeightMap`'s determinant test). A flat's bottom face
      // is right to skip one too -- a vertical wall cannot be under its plane --
      // but a **ball** is lifted by such a wall (its equator reaches it), and a
      // sector's radial end face projects exactly that way: skipping it read the
      // tip 0.40 mm low at the face (#1177). So the ball still reads the
      // triangle's vertices and edges; only its plane case, whose gradient is
      // infinite here, is dropped.
      if (Math.abs(denom) < 1e-15) {
        if (!ball) continue
        const contact = ballFootprintTip(vx, vy, vz, 0, 0, radius, contains, false)
        if (contact > best) best = contact
        continue
      }
      const rise1 = vz[1] - vz[0]
      const rise2 = vz[2] - vz[0]
      const gx = (rise1 * e2y - rise2 * e1y) / denom
      const gy = (rise2 * e1x - rise1 * e2x) / denom
      if (ball) {
        // #1177: the exact sphere drop onto this triangle. Every candidate below
        // is the centre height for the ball to touch one surface point, and the
        // resting height is their maximum.
        const contact = ballFootprintTip(vx, vy, vz, gx, gy, radius, contains, true)
        if (contact > best) best = contact
        continue
      }
      // (a) Its own vertices, where the height is read off the mesh.
      for (let j = 0; j < 3; j++) {
        if (vx[j] * vx[j] + vy[j] * vy[j] <= radiusSq + 1e-12 && vz[j] > best) best = vz[j]
      }
      // (b) Where each edge crosses the footprint's boundary: an affine height
      // over the clipped edge is highest at one of its ends.
      for (let j = 0; j < 3; j++) {
        const k = j === 2 ? 0 : j + 1
        const dx = vx[k] - vx[j]
        const dy = vy[k] - vy[j]
        const a = dx * dx + dy * dy
        if (!(a > 0)) continue
        const b = 2 * (vx[j] * dx + vy[j] * dy)
        const c = vx[j] * vx[j] + vy[j] * vy[j] - radiusSq
        let discriminant = b * b - 4 * a * c
        if (discriminant < 0) {
          if (discriminant < -1e-18) continue
          discriminant = 0
        }
        const root = Math.sqrt(discriminant)
        for (let side = 0; side < 2; side++) {
          const crossing = side === 0 ? (-b - root) / (2 * a) : (-b + root) / (2 * a)
          if (!(crossing >= 0) || crossing > 1) continue
          const value = vz[j] + (vz[k] - vz[j]) * crossing
          if (value > best) best = value
        }
      }
      // (c) The footprint's centre, which is in the region whenever the triangle
      // covers it. A triangle far larger than the disc (a long facet strip) has
      // every vertex and edge outside it, so this is its only interior point --
      // and for a plane whose gradient is zero it is the only candidate carrying
      // the plane's height at all.
      if (contains(0, 0)) {
        const value = vz[0] + gx * (0 - vx[0]) + gy * (0 - vy[0])
        if (value > best) best = value
      }
      // (d) The disc's own highest point of this triangle's plane, when it lies
      // inside the triangle. A plane over a disc peaks on the rim along its
      // gradient, which is an arc's interior rather than a vertex.
      const gradient = Math.hypot(gx, gy)
      if (gradient > 1e-12) {
        const px = (radius * gx) / gradient
        const py = (radius * gy) / gradient
        if (contains(px, py)) {
          const value = vz[0] + gx * (px - vx[0]) + gy * (py - vy[0])
          if (value > best) best = value
        }
      }
    }
    row[i] = best === Number.NEGATIVE_INFINITY ? NaN : best - pivot
  }
}


/**
 * The centre height for a sphere of squared radius `radiusSq` to touch the edge
 * from `(x0, y0, z0)` along `(dx, dy, dz)` at parameter `t` (#1177), or
 * `-Infinity` when that point lies outside the sphere's footprint.
 *
 * A module function rather than one made inside {@link ballFootprintTip} (#1185
 * X1): that function runs once per facet under the cutter, and a function made
 * on every call was a measurable share of the exact read.
 */
function ballEdgeContact(
  x0: number, y0: number, dx: number, dy: number, z0: number, dz: number, t: number, radiusSq: number,
): number {
  const x = x0 + dx * t
  const y = y0 + dy * t
  const offset = x * x + y * y
  // A rim point sits exactly on the circle; its `sqrt` is zero, so the
  // tolerance only decides whether roundoff rejects it.
  if (offset > radiusSq * (1 + 1e-9)) return Number.NEGATIVE_INFINITY
  return z0 + dz * t + Math.sqrt(Math.max(0, radiusSq - offset))
}
/**
 * The **exact** ball-nose tip over one projected triangle (#1177).
 *
 * The ball is a sphere of `radius` whose lowest point is the tip, so with the
 * pose's axis vertical the tip is the highest sphere centre that clears the
 * triangle, less the radius. Every value below is that centre height for the
 * sphere to touch one surface point, and the answer is their maximum:
 *
 * - a **vertex** at `(x, y, z)`: the centre stands `z + sqrt(r^2 - x^2 - y^2)`
 *   when the point is inside the footprint;
 * - an **edge**, parametrised `(x, y, z)(t) = v0 + t (v1 - v0)`: the same
 *   expression, maximised over `t` in `[0, 1]`. Its derivative vanishes where
 *   `dz sqrt(r^2 - |xy|^2) = A + B t`, whose square is a **quadratic** in `t`
 *   (`A = v0 . d`, `B = |d|^2`, `dz` the edge's rise), so the exact candidates
 *   are the closed form's roots plus the edge's ends and the two points where it
 *   crosses the footprint's circle;
 * - the **interior**: where the sphere is tangent to the triangle's own plane,
 *   the contact point is at `r grad / sqrt(1 + |grad|^2)` from the pose and the
 *   centre is `h(0) + r sqrt(1 + |grad|^2)`. That point is inside the triangle
 *   when `contains` says so -- and on a triangle far larger than the footprint
 *   (a long facet strip) it is the only candidate that lies inside at all.
 *
 * A projection that collapses to a line never reaches here (`exactFootprintTips`
 * skips it), so the edge's `B` is always positive for at least one of the three.
 */
function ballFootprintTip(
  vx: readonly number[],
  vy: readonly number[],
  vz: readonly number[],
  gx: number,
  gy: number,
  radius: number,
  contains: (px: number, py: number) => boolean,
  /**
   * Whether the triangle's own **plane** is a candidate contact: false when the
   * projection collapsed to a line (a vertical face, whose gradient is infinite)
   * -- the vertices and edges still are.
   */
  plane: boolean,
): number {
  const radiusSq = radius * radius
  let best = Number.NEGATIVE_INFINITY
  for (let j = 0; j < 3; j++) {
    const offset = vx[j] * vx[j] + vy[j] * vy[j]
    if (offset > radiusSq + 1e-12) continue
    const value = vz[j] + Math.sqrt(Math.max(0, radiusSq - offset))
    if (value > best) best = value
  }
  for (let j = 0; j < 3; j++) {
    const k = j === 2 ? 0 : j + 1
    const x0 = vx[j]
    const y0 = vy[j]
    const z0 = vz[j]
    const dx = vx[k] - x0
    const dy = vy[k] - y0
    const dz = vz[k] - z0
    const spanSq = dx * dx + dy * dy
    const q0 = x0 * x0 + y0 * y0
    let value = ballEdgeContact(x0, y0, dx, dy, z0, dz, 0, radiusSq)
    if (value > best) best = value
    value = ballEdgeContact(x0, y0, dx, dy, z0, dz, 1, radiusSq)
    if (value > best) best = value
    if (!(spanSq > 0)) continue
    const a = x0 * dx + y0 * dy
    // `gap = spanSq (r^2 - dmin^2)`, with `dmin` the closest approach of the
    // edge's horizontal projection to the pose: it decides both where the edge
    // enters the footprint and whether the eased function has a critical point.
    // It is written this way, and not as the quadratic's `b^2 - 4ac`, because
    // that form cancels catastrophically on a **level** edge (`dz = 0`, the
    // corner edge of a prism parallel to the bar): the discriminant is exactly
    // zero there, and the difference of two large squares came out negative, so
    // the ball's contact with the nearest corner was dropped and the tip read up
    // to 1.5 mm low. The closed form for the critical points' discriminant is
    // `4 dz^2 (dz^2 + spanSq) gap`, which is exact at `dz = 0`.
    const gap = a * a + spanSq * (radiusSq - q0)
    if (!(gap >= 0)) continue
    const rim = Math.sqrt(gap)
    // The points where the edge crosses the footprint's circle, where the
    // `sqrt` vanishes and the eased function can peak.
    for (let side = 0; side < 2; side++) {
      const t = side === 0 ? (-a - rim) / spanSq : (-a + rim) / spanSq
      if (!(t >= 0) || t > 1) continue
      value = ballEdgeContact(x0, y0, dx, dy, z0, dz, t, radiusSq)
      if (value > best) best = value
    }
    // The critical points of `z(t) + sqrt(r^2 - |xy(t)|^2)`.
    const quadratic = -spanSq * (dz * dz + spanSq)
    const linear = -2 * a * (dz * dz + spanSq)
    const root = 2 * Math.abs(dz) * Math.sqrt((dz * dz + spanSq) * gap)
    for (let side = 0; side < 2; side++) {
      const t = side === 0 ? (-linear - root) / (2 * quadratic) : (-linear + root) / (2 * quadratic)
      if (!(t >= 0) || t > 1) continue
      value = ballEdgeContact(x0, y0, dx, dy, z0, dz, t, radiusSq)
      if (value > best) best = value
    }
  }
  if (plane) {
    const gradientSq = gx * gx + gy * gy
    const scale = Math.sqrt(1 + gradientSq)
    const px = (radius * gx) / scale
    const py = (radius * gy) / scale
    if (contains(px, py)) {
      const value = vz[0] - gx * vx[0] - gy * vy[0] + radius * scale
      if (value > best) best = value
    }
  }
  return best === Number.NEGATIVE_INFINITY ? Number.NEGATIVE_INFINITY : best - radius
}

/**
 * The candidate triangles one angle row would rasterise, **without** building it
 * (#1103 slice ca-j correction round 2).
 *
 * `runRotaryAngleJob` gathers a row's candidates into the workspace buffer and
 * reports their count as that row's `rasterWork`; this counts the identical set
 * and returns it, so a caller can price a row -- or a whole round of rows --
 * before deciding whether to spend it. The two walk the same bits: `always`
 * plus the set members of the two strip buckets, a triangle listed in both
 * buckets counted twice, exactly as the raster visits it once per listing.
 *
 * A row the cache can answer costs `0`, because the raster pass is the whole of
 * a row's work and a hit skips it. `readCache` says whether this prep would read
 * the cache at all -- the helix's rows are prepared as `'read-write'` even when
 * the grid prep that seeded them was `'write'`, so the caller's prep cannot
 * answer that by itself.
 *
 * The popcount is the SWAR form rather than a per-set-bit loop: a bucket word
 * carries up to 32 listings, and the loop version would cost as much as the
 * gather it exists to avoid.
 */
export function rotaryAngleRowWork(
  prep: RotarySamplingPrep,
  angleDeg: number,
  readCache = prep.angleMaps === 'read-write',
): number {
  if (readCache && hasRotaryAngleMap(prep.workspace, angleDeg)) return 0
  // The same plan `runRotaryAngleJob` will be handed: one angle's reach, and
  // `buildStripPlan` caches it on the workspace, so pricing a row before
  // sampling it costs one plan lookup, not a second plan.
  const plan = prep.planFor([angleDeg])
  const t = (angleDeg * Math.PI) / 180
  let count = plan.always.length
  const bucketWords = plan.bucketWords
  if (bucketWords > 0) {
    const bucketBits = plan.bucketBits
    for (const bucket of [
      bucketIndex(Math.PI / 2 - t, plan.bucketWidth),
      bucketIndex(Math.PI / 2 - t + Math.PI, plan.bucketWidth),
    ]) {
      const base = bucket * bucketWords
      for (let word = 0; word < bucketWords; word++) count += popcount32(bucketBits[base + word])
    }
  }
  return count
}

/** The number of set bits in a 32-bit word (SWAR, no per-bit loop). */
function popcount32(value: number): number {
  let v = value - ((value >>> 1) & 0x55555555)
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333)
  v = (v + (v >>> 4)) & 0x0f0f0f0f
  return Math.imul(v, 0x01010101) >>> 24
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
  let reused = 0
  let rasterWork = 0
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
    if (sample.reused === true) reused++
    rasterWork += sample.rasterWork ?? 0
    anglesDeg.push(jobs[k].angle)
    tipRadius.push(row)
    lifts.push(lift)
  }
  return { anglesDeg, along: [...prep.along], tipRadius, lifts, reused, rasterWork, stopped, valid: true }
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
  return { anglesDeg: [], along: [...along], tipRadius: [], lifts: [], reused: 0, rasterWork: 0, stopped: false, valid: false }
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
    ...(options.exactTipRows === true ? { exactTipRows: true } : {}),
    ...(options.wallTriangleStart !== undefined ? { wallTriangleStart: options.wallTriangleStart } : {}),
    ...(options.gridExtra !== undefined ? { gridExtra: options.gridExtra } : {}),
    ...(options.angleMaps !== undefined ? { angleMaps: options.angleMaps } : {}),
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
 * #1177: a grid that reads **exact** rows does not use this allowance -- the
 * caller holds it to the floor. A midpoint above the chord is a tip curve that
 * bends down between the samples (a ball rolling over a convex corner), and
 * the chord then passes inside the corner by about this much: 0.0145 mm into
 * a Hex's vertex. The conservative read's rows stand a cell above the surface,
 * which covers it.
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
      // #1177: an exact-tip grid holds a ball to the plain floor; see
      // `aroundSegmentationTolerance` and the helix's own refinement.
      const tolerance = args.prep.exactTipRows === true
        ? convertLength(AROUND_ANGLE_TOLERANCE_MM, 'mm', tool.units)
        : aroundSegmentationTolerance(a, b, delta, tool, tool.units)
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
