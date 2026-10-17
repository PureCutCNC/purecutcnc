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
 * Boundary geometry for the remaining square material (issue #1016 C2-R2MF).
 *
 * The material model is the frozen transient one from `squareMaterial.ts`: a
 * sparse map of per-cell, remaining canonical radial intervals. Rendering it
 * needs every interval — the inner and outer radial surfaces, the real gap
 * ceilings and floors between two surviving pieces, and the exposed axial and
 * angular walls where a neighbour holds different material. A `topZ`-only
 * surface cannot show any of that, so this module reads each cell through
 * `squareMaterialIntervals` and never through `topZ`.
 *
 * ## The solid
 *
 * A cell owns an angular wedge `[thetaLo, thetaHi]` and an axial extent
 * `[alongLo, alongHi]`. Its material is
 *
 *     { (theta, along, u) : theta in wedge, along in extent, u in intervals }
 *
 * clipped to the **actual square blank**: no point may sit outside
 * `|across - centre| <= side/2` and `|projectZ - pivot| <= side/2`. A virgin
 * cell's outer surface is therefore the physical square flat (and the corner
 * where two flats meet), never a circumscribed cylinder — `initialTopZ` gives
 * the blank radius at the cell's own ray, and an interval that reaches that
 * baseline is the blank surface, so its outer boundary is `blankRadius(theta)`
 * across the whole wedge. A cut interval is capped at `min(hi, blankRadius)`.
 *
 * An interval whose outer endpoint *is* the blank surface can leave the wedge
 * through the blank: where `blankRadius(theta) <= lo` there is no material at
 * all, and the exposed wall shrinks to a point. That collapsed endpoint is a
 * legitimate triangular wall and is emitted as a triangle, never dropped.
 *
 * ## Clipping and splitting
 *
 * `blankRadius(theta)` is piecewise (`R/cos(theta - phi)` on the flat whose
 * normal is `phi`), so an angular wedge is split at the blank's corners
 * (odd multiples of pi/4), at its flat normals (multiples of pi/2), and
 * wherever an interval endpoint crosses the blank. Within one sub-wedge the
 * outer surface is either a constant-radius arc or one planar flat, and no
 * face ever spans a removed radial interval.
 *
 * ## Conforming angular partition
 *
 * Every face that shares an edge must subdivide that edge the same way. The
 * angular partition is therefore **row-transitive**: column `ci` has one
 * partition, the union of every along-cell's breaks in that column, including
 * crossings introduced by a cell several positions away. The radial faces,
 * the axial end/interface walls and their tessellation knots all use that one
 * partition, so a crossing added by one cell can never leave a T-junction in a
 * neighbour. The chunk selection in `squareMaterialMesh.ts` still covers this:
 * a column's partition only depends on that column, and the corner refinement
 * below only reaches the two columns on either side of an angular edge, i.e.
 * the touched chunk and its angular neighbours (plus the periodic seam).
 *
 * Within an axial or angular wall the radial (`u`) direction is refined at the
 * **corner line** where the wall meets the two perpendicular interfaces. The
 * corner's knot set is the union of the four adjacent cells' clipped interval
 * endpoints, so both walls split the shared radial line at the same values.
 * An unchanged cell therefore keeps its geometry byte-for-byte, and a null
 * dirty region stays an unconditional no-op; callers pass `undefined` (not
 * `null`) whenever the frame, topology or material generation is reset,
 * because a non-null region still forces a full rebuild when the layout
 * signature changes.
 *
 * ## Coordinates
 *
 * The mapping is the frozen true-pivot frame: `pivot = frame.radius = side/2`,
 * never the corner radius. `theta = (across - frame.zero)/frame.radius` and a
 * point at radius `u` on the cell's ray is
 *
 *     axis x:  (along, pivot + u*cos(theta), centre + u*sin(theta))
 *     axis y:  (centre + u*sin(theta), pivot + u*cos(theta), along)
 *
 * in Three's world axes (project X, project Z, project Y), which is why the
 * round pipeline's shader wrap must not be applied on top of this.
 */

import { squareMaterialIntervals, squareSurfaceRadius } from './squareMaterial'
import type { DirtyRegion, SimulationGrid } from './types'

const HALF_PI = Math.PI / 2
const QUARTER_PI = Math.PI / 4
/** Blank corners (flat junctions) inside the one-turn sheet (-pi, pi]. */
const CORNER_ANGLES: readonly number[] = [-3 * QUARTER_PI, -QUARTER_PI, QUARTER_PI, 3 * QUARTER_PI]
/** Blank flat normals inside the sheet; the seam at +-pi is already an edge. */
const FLAT_NORMALS: readonly number[] = [-HALF_PI, 0, HALF_PI]
/** Relative tolerance used to call a stored top endpoint "the blank surface". */
const BASELINE_TOLERANCE = 1e-6
/** Angular epsilon for splitting/de-duplicating breakpoints (radians). */
const ANGLE_EPSILON = 1e-12

/** Max angular span of one tessellated segment on a constant-radius face. */
export const DEFAULT_SQUARE_ANGULAR_SEGMENT_RADIANS = Math.PI / 45
/** Hard cap on segments per angular sub-range, so one huge cell cannot explode. */
export const DEFAULT_SQUARE_MAX_ANGULAR_SEGMENTS = 24
/** Default angular cells bundled into one BufferGeometry resource. */
export const DEFAULT_SQUARE_ANGULAR_CELLS_PER_CHUNK = 8

export interface SquareMaterialAlongBounds {
  min: number
  max: number
}

/**
 * Required options. `alongBounds` are absolute stock-space coordinates on the
 * bar axis (project X for an x bar, project Y for a y bar) and cannot be
 * derived from the grid: the count `ceil(along / cellSize)` rounds up, so
 * `cols * cellSize` does not encode the real stock end. The renderer's caller
 * supplies them from `getStockBounds`.
 */
export interface SquareMaterialGeometryOptions {
  alongBounds: SquareMaterialAlongBounds
  angularSegmentRadians?: number
  maxAngularSegmentsPerEdge?: number
}

export interface SquareMaterialLayout {
  readonly axis: 'x' | 'y'
  readonly side: number
  readonly pivot: number
  readonly centre: number
  readonly radius: number
  readonly zero: number
  readonly sheetStart: number
  readonly circumference: number
  readonly angularCount: number
  readonly alongCount: number
  readonly cellSize: number
  readonly alongBounds: SquareMaterialAlongBounds
  /** Angular edges, `angularCount + 1` values, clamped to the exact sheet. */
  readonly angularEdges: readonly number[]
  /** Axial edges, `alongCount + 1` values, clamped to the exact stock bounds. */
  readonly alongEdges: readonly number[]
  /** Radial/axial epsilon derived from the blank size. */
  readonly epsilon: number
  readonly signature: string
}

export interface SquareMaterialChunkBuffer {
  readonly angularStart: number
  readonly angularEnd: number
  readonly positions: Float32Array
  readonly normals: Float32Array
  readonly triangleCount: number
  readonly min: readonly [number, number, number]
  readonly max: readonly [number, number, number]
}

type Vec3 = readonly [number, number, number]

interface RadialBand {
  lo: number
  hi: number
  /** True when `hi` is the blank surface and therefore varies with theta. */
  hiBlank: boolean
}

interface DiffBand {
  lo: number
  hi: number
  hiBlank: boolean
  side: 'a' | 'b'
}

interface CellInfo {
  ci: number
  ai: number
  index: number
  alongLo: number
  alongHi: number
  thetaLo: number
  thetaHi: number
  baseline: number
  intervals: readonly number[]
  intact: boolean
}

interface MeshAccumulator {
  positions: number[]
  normals: number[]
  min: [number, number, number]
  max: [number, number, number]
}

/** Read-only state shared by one chunk build; every lookup is deterministic. */
interface BuildContext {
  readonly grid: SimulationGrid
  readonly layout: SquareMaterialLayout
  readonly eps: number
  readonly segmentRadians: number
  readonly maxSegments: number
  /** One row-transitive angular partition per built angular column. */
  readonly partitions: Map<number, readonly number[]>
  /** Corner-line radial knots, keyed by `angularEdge:alongEdge`. */
  readonly cornerKnots: Map<string, readonly number[]>
}

const NO_KNOTS: readonly number[] = []

/**
 * Resolve the render layout from the accepted square grid. Throws a
 * `RangeError` before any allocation on a non-square grid or bad bounds.
 */
export function resolveSquareMaterialLayout(
  grid: SimulationGrid,
  options: SquareMaterialGeometryOptions,
): SquareMaterialLayout {
  const bar = grid.squareBar
  if (!bar) {
    throw new RangeError('square material geometry: grid has no squareBar descriptor')
  }
  const bounds = options.alongBounds
  if (!bounds || !Number.isFinite(bounds.min) || !Number.isFinite(bounds.max) || !(bounds.max > bounds.min)) {
    throw new RangeError('square material geometry: alongBounds must be finite and ascending')
  }
  if (!Number.isFinite(bar.side) || bar.side <= 0) {
    throw new RangeError(`square material geometry: side must be positive and finite, got ${bar.side}`)
  }
  if (!Number.isFinite(grid.cellSize) || grid.cellSize <= 0) {
    throw new RangeError(`square material geometry: cellSize must be positive and finite, got ${grid.cellSize}`)
  }
  const frame = bar.frame
  const xAxis = frame.axis === 'x'
  const angularCount = xAxis ? grid.rows : grid.cols
  const alongCount = xAxis ? grid.cols : grid.rows
  if (!(angularCount >= 1) || !(alongCount >= 1)) {
    throw new RangeError('square material geometry: grid must have at least one cell on each axis')
  }

  const alongOrigin = xAxis ? grid.originX : grid.originY
  const acrossOrigin = xAxis ? grid.originY : grid.originX

  // Axial cells clamp to the real stock ends. The first and last edges carry
  // the exact bounds so the mesh never invents or drops an end.
  const alongEdges = new Array<number>(alongCount + 1)
  for (let i = 0; i <= alongCount; i += 1) {
    alongEdges[i] = clamp(alongOrigin + i * grid.cellSize, bounds.min, bounds.max)
  }
  alongEdges[0] = bounds.min
  alongEdges[alongCount] = bounds.max

  // Angular cells clamp to the exact one-turn sheet; the two seam edges are
  // forced so the union is exactly one circumference.
  const sheetEnd = frame.sheetStart + frame.circumference
  const angularEdges = new Array<number>(angularCount + 1)
  for (let i = 0; i <= angularCount; i += 1) {
    const across = clamp(acrossOrigin + i * grid.cellSize, frame.sheetStart, sheetEnd)
    angularEdges[i] = (across - frame.zero) / frame.radius
  }
  angularEdges[0] = (frame.sheetStart - frame.zero) / frame.radius
  angularEdges[angularCount] = (sheetEnd - frame.zero) / frame.radius

  const signature = squareMaterialLayoutSignature(grid, options)
  return {
    axis: frame.axis,
    side: bar.side,
    pivot: frame.radius,
    centre: frame.centre,
    radius: frame.radius,
    zero: frame.zero,
    sheetStart: frame.sheetStart,
    circumference: frame.circumference,
    angularCount,
    alongCount,
    cellSize: grid.cellSize,
    alongBounds: { min: bounds.min, max: bounds.max },
    angularEdges,
    alongEdges,
    epsilon: 1e-9 * Math.max(1, bar.side),
    signature,
  }
}

/**
 * Everything that must invalidate a whole rebuild. A dirty region cannot
 * repair a changed frame or topology, so an update compares this first.
 */
export function squareMaterialLayoutSignature(
  grid: SimulationGrid,
  options: SquareMaterialGeometryOptions,
): string {
  const bar = grid.squareBar
  const frame = bar?.frame
  return [
    bar ? 1 : 0,
    bar?.side,
    frame?.axis,
    frame?.centre,
    frame?.radius,
    frame?.zero,
    frame?.sheetStart,
    frame?.circumference,
    grid.cols,
    grid.rows,
    grid.cellSize,
    grid.originX,
    grid.originY,
    options.alongBounds?.min,
    options.alongBounds?.max,
  ].join('|')
}

/** Number of chunk resources the layout splits into. */
export function squareMaterialChunkCount(layout: SquareMaterialLayout, angularCellsPerChunk: number): number {
  const size = Math.max(1, Math.floor(angularCellsPerChunk))
  return Math.max(1, Math.ceil(layout.angularCount / size))
}

/** Inclusive angular cell range owned by one chunk. */
export function squareMaterialChunkAngularRange(
  layout: SquareMaterialLayout,
  angularCellsPerChunk: number,
  chunkIndex: number,
): [number, number] {
  const size = Math.max(1, Math.floor(angularCellsPerChunk))
  const start = chunkIndex * size
  return [start, Math.min(layout.angularCount - 1, start + size - 1)]
}

/**
 * Chunks a dirty grid rectangle can change: every touched angular chunk, one
 * neighbour on each side (its shared-edge walls and corner refinement changed
 * too), and the periodic opposite chunk when the region meets either seam.
 */
export function squareMaterialChunkIndicesForDirtyRegion(
  layout: SquareMaterialLayout,
  angularCellsPerChunk: number,
  region: DirtyRegion,
): number[] {
  const xAxis = layout.axis === 'x'
  const rawMin = xAxis ? region.rowMin : region.colMin
  const rawMax = xAxis ? region.rowMax : region.colMax
  const lo = clamp(Math.min(rawMin, rawMax), 0, layout.angularCount - 1)
  const hi = clamp(Math.max(rawMin, rawMax), 0, layout.angularCount - 1)
  const chunkCount = squareMaterialChunkCount(layout, angularCellsPerChunk)
  const size = Math.max(1, Math.floor(angularCellsPerChunk))
  const first = Math.floor(lo / size)
  const last = Math.floor(hi / size)
  const indices = new Set<number>()
  for (let c = first - 1; c <= last + 1; c += 1) {
    if (c >= 0 && c < chunkCount) indices.add(c)
  }
  if (lo === 0) indices.add(chunkCount - 1)
  if (hi === layout.angularCount - 1) indices.add(0)
  return [...indices].sort((a, b) => a - b)
}

/**
 * Build one chunk's boundary triangles. The grid is read through the frozen
 * `squareMaterialIntervals` accessor, so an in-place material-map update is
 * seen without swapping the grid or the map.
 */
export function buildSquareMaterialChunk(
  grid: SimulationGrid,
  layout: SquareMaterialLayout,
  options: SquareMaterialGeometryOptions,
  angularStart: number,
  angularEnd: number,
): SquareMaterialChunkBuffer {
  const segmentRadians = options.angularSegmentRadians && options.angularSegmentRadians > 0
    ? options.angularSegmentRadians
    : DEFAULT_SQUARE_ANGULAR_SEGMENT_RADIANS
  const maxSegments = options.maxAngularSegmentsPerEdge && options.maxAngularSegmentsPerEdge > 0
    ? Math.floor(options.maxAngularSegmentsPerEdge)
    : DEFAULT_SQUARE_MAX_ANGULAR_SEGMENTS
  const ctx: BuildContext = {
    grid,
    layout,
    eps: layout.epsilon,
    segmentRadians,
    maxSegments,
    partitions: new Map<number, readonly number[]>(),
    cornerKnots: new Map<string, readonly number[]>(),
  }
  const acc = createAccumulator()
  const first = Math.max(0, angularStart)
  const last = Math.min(layout.angularCount - 1, angularEnd)

  for (let ci = first; ci <= last; ci += 1) {
    const partition = columnPartition(ctx, ci)
    for (let ai = 0; ai < layout.alongCount; ai += 1) {
      const cell = readCell(grid, layout, ci, ai, ctx.eps)
      if (!cell) continue
      emitRadialFaces(ctx, acc, cell, partition)
      emitAngularFaces(ctx, acc, cell)
      emitAxialFaces(ctx, acc, cell, partition)
    }
  }
  return finishChunk(acc, first, last)
}

/** Conservative render envelope: the blank plus its corners, on the true pivot. */
export function squareMaterialEnvelope(layout: SquareMaterialLayout): { min: Vec3; max: Vec3 } {
  const maxRadius = layout.side * Math.SQRT1_2
  if (layout.axis === 'x') {
    return {
      min: [layout.alongBounds.min, layout.pivot - maxRadius, layout.centre - maxRadius],
      max: [layout.alongBounds.max, layout.pivot + maxRadius, layout.centre + maxRadius],
    }
  }
  return {
    min: [layout.centre - maxRadius, layout.pivot - maxRadius, layout.alongBounds.min],
    max: [layout.centre + maxRadius, layout.pivot + maxRadius, layout.alongBounds.max],
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function blankRadius(layout: SquareMaterialLayout, theta: number): number {
  return squareSurfaceRadius(layout.side, theta)
}

function world(layout: SquareMaterialLayout, along: number, theta: number, u: number): Vec3 {
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  return layout.axis === 'x'
    ? [along, layout.pivot + u * cos, layout.centre + u * sin]
    : [layout.centre + u * sin, layout.pivot + u * cos, along]
}

function radialDirection(layout: SquareMaterialLayout, theta: number): Vec3 {
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  return layout.axis === 'x' ? [0, cos, sin] : [sin, cos, 0]
}

function thetaDirection(layout: SquareMaterialLayout, theta: number): Vec3 {
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  return layout.axis === 'x' ? [0, -sin, cos] : [cos, -sin, 0]
}

function alongDirection(layout: SquareMaterialLayout): Vec3 {
  return layout.axis === 'x' ? [1, 0, 0] : [0, 0, 1]
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function createAccumulator(): MeshAccumulator {
  return {
    positions: [],
    normals: [],
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
  }
}

function pushVertex(acc: MeshAccumulator, point: Vec3, nx: number, ny: number, nz: number): void {
  acc.positions.push(point[0], point[1], point[2])
  acc.normals.push(nx, ny, nz)
  for (let i = 0; i < 3; i += 1) {
    if (point[i] < acc.min[i]) acc.min[i] = point[i]
    if (point[i] > acc.max[i]) acc.max[i] = point[i]
  }
}

/**
 * Emit one quad as up to two triangles, oriented so its face normal agrees with
 * `expected` (the outward direction at that face). Winding is therefore derived
 * from the geometry, not from an axis-dependent guess. A degenerate half (which
 * happens at the pivot, where every radius-0 corner is the same world point, or
 * where one edge collapses against the blank) is dropped, so no zero-area
 * triangle and no zero-length edge reaches the GPU.
 */
function emitQuad(acc: MeshAccumulator, p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, expected: Vec3): void {
  const normal = cross(sub(p2, p0), sub(p3, p1))
  const length = Math.hypot(normal[0], normal[1], normal[2])
  if (!(length > 1e-20)) return
  let nx = normal[0] / length
  let ny = normal[1] / length
  let nz = normal[2] / length
  let a = p0
  let b = p1
  let c = p2
  let d = p3
  if (nx * expected[0] + ny * expected[1] + nz * expected[2] < 0) {
    a = p0
    b = p3
    c = p2
    d = p1
    nx = -nx
    ny = -ny
    nz = -nz
  }
  emitTriangle(acc, a, b, c, nx, ny, nz)
  emitTriangle(acc, a, c, d, nx, ny, nz)
}

function emitTriangle(acc: MeshAccumulator, a: Vec3, b: Vec3, c: Vec3, nx: number, ny: number, nz: number): void {
  const edge1 = sub(b, a)
  const edge2 = sub(c, a)
  const area = cross(edge1, edge2)
  // A relative test, not an absolute area: three exactly collinear points still
  // produce a rounding-noise cross product (~1e-16 of the edge product), and
  // emitting that sliver would give the surface a random winding.
  const scale = Math.hypot(edge1[0], edge1[1], edge1[2]) * Math.hypot(edge2[0], edge2[1], edge2[2])
  if (!(Math.hypot(area[0], area[1], area[2]) > scale * 1e-12)) return
  pushVertex(acc, a, nx, ny, nz)
  pushVertex(acc, b, nx, ny, nz)
  pushVertex(acc, c, nx, ny, nz)
}

/** Emit one triangle, deriving its outward normal from `expected`. */
function emitOrientedTriangle(acc: MeshAccumulator, a: Vec3, b: Vec3, c: Vec3, expected: Vec3): void {
  const normal = cross(sub(b, a), sub(c, a))
  const length = Math.hypot(normal[0], normal[1], normal[2])
  if (!(length > 1e-20)) return
  let nx = normal[0] / length
  let ny = normal[1] / length
  let nz = normal[2] / length
  let first = b
  let second = c
  if (nx * expected[0] + ny * expected[1] + nz * expected[2] < 0) {
    first = c
    second = b
    nx = -nx
    ny = -ny
    nz = -nz
  }
  emitTriangle(acc, a, first, second, nx, ny, nz)
}

function finishChunk(acc: MeshAccumulator, angularStart: number, angularEnd: number): SquareMaterialChunkBuffer {
  const triangleCount = acc.positions.length / 9
  const hasGeometry = triangleCount > 0
  return {
    angularStart,
    angularEnd,
    positions: new Float32Array(acc.positions),
    normals: new Float32Array(acc.normals),
    triangleCount,
    min: hasGeometry ? acc.min : [0, 0, 0],
    max: hasGeometry ? acc.max : [0, 0, 0],
  }
}

function segmentCount(span: number, segmentRadians: number, maxSegments: number): number {
  if (!(span > 0)) return 1
  return Math.max(1, Math.min(maxSegments, Math.ceil(span / segmentRadians)))
}

function readCell(
  grid: SimulationGrid,
  layout: SquareMaterialLayout,
  ci: number,
  ai: number,
  eps: number,
): CellInfo | null {
  if (ci < 0 || ci >= layout.angularCount || ai < 0 || ai >= layout.alongCount) return null
  const alongLo = layout.alongEdges[ai]
  const alongHi = layout.alongEdges[ai + 1]
  if (!(alongHi - alongLo > eps)) return null
  const thetaLo = layout.angularEdges[ci]
  const thetaHi = layout.angularEdges[ci + 1]
  if (!(thetaHi - thetaLo > ANGLE_EPSILON)) return null
  const index = layout.axis === 'x' ? ci * grid.cols + ai : ai * grid.cols + ci
  const intervals = squareMaterialIntervals(grid, index)
  const baseline = grid.initialTopZ
    ? grid.initialTopZ[index]
    : blankRadius(layout, (thetaLo + thetaHi) / 2)
  const hasMaterial = intervals.length > 0
  const topHi = hasMaterial ? intervals[intervals.length - 1] : Number.NaN
  const intact = hasMaterial && topHi >= baseline - Math.max(1, Math.abs(baseline)) * BASELINE_TOLERANCE
  return {
    ci,
    ai,
    index,
    alongLo,
    alongHi,
    thetaLo,
    thetaHi,
    baseline,
    intervals,
    intact,
  }
}

/**
 * One cell's angular breakpoints: its own edges, every blank corner and flat
 * normal inside it, and every angle where an interval endpoint crosses the
 * blank. Inside one sub-wedge the outer surface is a single arc or flat and no
 * interval appears or disappears.
 */
function cellBreakPoints(layout: SquareMaterialLayout, cell: CellInfo, eps: number): number[] {
  const points: number[] = [cell.thetaLo, cell.thetaHi]
  const inside = (value: number): boolean => value > cell.thetaLo + ANGLE_EPSILON && value < cell.thetaHi - ANGLE_EPSILON
  for (const corner of CORNER_ANGLES) if (inside(corner)) points.push(corner)
  for (const normal of FLAT_NORMALS) if (inside(normal)) points.push(normal)

  const base = sortUnique(points, ANGLE_EPSILON)
  const endpoints: number[] = []
  const topLoIndex = cell.intervals.length - 2
  for (let i = 0; i < cell.intervals.length; i += 2) {
    endpoints.push(cell.intervals[i])
    // An intact top's outer endpoint is the blank itself, so it never crosses.
    if (!(cell.intact && i === topLoIndex)) endpoints.push(cell.intervals[i + 1])
  }
  for (const u of endpoints) {
    for (let i = 0; i + 1 < base.length; i += 1) {
      const crossing = solveBlankCrossing(layout, base[i], base[i + 1], u, eps)
      if (crossing !== null && inside(crossing)) points.push(crossing)
    }
  }
  return sortUnique(points, ANGLE_EPSILON)
}

/**
 * Solve `blankRadius(theta) = u` on `[s0, s1]`, which lies inside one flat
 * branch. `blankRadius = R/cos(theta - phi)`, so the solution is
 * `phi +- acos(R/u)`; the sign is fixed by which side of `phi` the sub-range is
 * on. Returns null outside the sub-wedge.
 */
function solveBlankCrossing(
  layout: SquareMaterialLayout,
  s0: number,
  s1: number,
  u: number,
  eps: number,
): number | null {
  const half = layout.side / 2
  if (!(u > half)) return null
  const cosDelta = half / u
  if (!(cosDelta > 0) || cosDelta > 1) return null
  const delta = Math.acos(cosDelta)
  const mid = (s0 + s1) / 2
  const phi = Math.round(mid / HALF_PI) * HALF_PI
  const d0 = s0 - phi
  const d1 = s1 - phi
  if (d0 > QUARTER_PI + eps || d1 < -QUARTER_PI - eps) return null
  let candidate: number
  if (d0 >= -eps) candidate = phi + delta
  else if (d1 <= eps) candidate = phi - delta
  else return null
  return candidate > s0 + ANGLE_EPSILON && candidate < s1 - ANGLE_EPSILON ? candidate : null
}

/**
 * The row-transitive partition of one angular column: every along cell's own
 * breaks, unioned. All faces of every cell in that column use this one set, so
 * a crossing introduced by one cell (or several cells away) cannot leave a
 * T-junction on a shared edge.
 */
function columnPartition(ctx: BuildContext, ci: number): readonly number[] {
  const cached = ctx.partitions.get(ci)
  if (cached) return cached
  const points: number[] = []
  for (let ai = 0; ai < ctx.layout.alongCount; ai += 1) {
    const cell = readCell(ctx.grid, ctx.layout, ci, ai, ctx.eps)
    if (!cell) continue
    for (const point of cellBreakPoints(ctx.layout, cell, ctx.eps)) points.push(point)
  }
  const partition = sortUnique(points, ANGLE_EPSILON)
  ctx.partitions.set(ci, partition)
  return partition
}

/**
 * Radial knots on the corner line where an angular edge meets an axial edge:
 * the union of the four adjacent cells' clipped interval endpoints. Splitting
 * both perpendicular walls at these values is what makes their shared radial
 * line conform (the axial wall's bands and the angular wall's bands generally
 * differ, so without this one introduces a vertex the other lacks).
 */
function cornerKnots(ctx: BuildContext, angularEdgeIndex: number, alongEdgeIndex: number): readonly number[] {
  const count = ctx.layout.angularCount
  const edge = ((angularEdgeIndex % count) + count) % count
  const key = `${edge}:${alongEdgeIndex}`
  const cached = ctx.cornerKnots.get(key)
  if (cached) return cached
  const theta = ctx.layout.angularEdges[edge]
  const blank = blankRadius(ctx.layout, theta)
  const leftColumn = edge === 0 ? count - 1 : edge - 1
  const points: number[] = []
  for (const column of [leftColumn, edge]) {
    for (const row of [alongEdgeIndex - 1, alongEdgeIndex]) {
      const cell = readCell(ctx.grid, ctx.layout, column, row, ctx.eps)
      if (!cell) continue
      for (const band of clipBands(cell.intervals, cell.intact, blank, ctx.eps)) {
        points.push(band.lo, band.hi)
      }
    }
  }
  const knots = sortUnique(points, ANGLE_EPSILON)
  ctx.cornerKnots.set(key, knots)
  return knots
}

/** Clip a cell's canonical intervals to the blank at one angle. */
function clipBands(intervals: readonly number[], intact: boolean, blank: number, eps: number): RadialBand[] {
  const bands: RadialBand[] = []
  const topLoIndex = intervals.length - 2
  for (let i = 0; i < intervals.length; i += 2) {
    const lo = intervals[i]
    let hi = intervals[i + 1]
    let hiBlank = false
    if (intact && i === topLoIndex) {
      hi = blank
      hiBlank = true
    }
    if (hi > blank) {
      hi = blank
      hiBlank = true
    }
    if (hi - lo > eps) bands.push({ lo, hi, hiBlank })
  }
  return bands
}

function findBand(bands: RadialBand[], value: number): RadialBand | null {
  for (const band of bands) {
    if (value >= band.lo && value <= band.hi) return band
  }
  return null
}

/**
 * The radial bands present in exactly one of the two profiles, tagged with the
 * side that owns them and whether their upper edge is the blank. Bands with the
 * same owner and edge kind are merged, so a difference never emits a sliver per
 * elementary interval.
 */
function differenceBands(a: RadialBand[], b: RadialBand[], eps: number): DiffBand[] {
  const points: number[] = []
  for (const band of a) points.push(band.lo, band.hi)
  for (const band of b) points.push(band.lo, band.hi)
  points.sort((x, y) => x - y)
  const out: DiffBand[] = []
  for (let i = 0; i + 1 < points.length; i += 1) {
    const x0 = points[i]
    const x1 = points[i + 1]
    if (!(x1 - x0 > eps)) continue
    const mid = (x0 + x1) / 2
    const bandA = findBand(a, mid)
    const bandB = findBand(b, mid)
    if (bandA === null && bandB === null) continue
    if (bandA !== null && bandB !== null) continue
    const band = bandA ?? bandB
    if (band === null) continue
    const side: 'a' | 'b' = bandA !== null ? 'a' : 'b'
    const hiBlank = band.hiBlank && x1 >= band.hi - eps
    const last = out.length > 0 ? out[out.length - 1] : null
    if (last !== null && last.side === side && last.hiBlank === hiBlank && Math.abs(last.hi - x0) <= eps) {
      last.hi = x1
    } else {
      out.push({ lo: x0, hi: x1, hiBlank, side })
    }
  }
  return out
}

function emitRadialFaces(
  ctx: BuildContext,
  acc: MeshAccumulator,
  cell: CellInfo,
  partition: readonly number[],
): void {
  const { layout, eps, segmentRadians, maxSegments } = ctx
  for (let i = 0; i + 1 < partition.length; i += 1) {
    const t0 = partition[i]
    const t1 = partition[i + 1]
    if (!(t1 - t0 > ANGLE_EPSILON)) continue
    if (t0 < cell.thetaLo - ANGLE_EPSILON || t1 > cell.thetaHi + ANGLE_EPSILON) continue
    const blank = blankRadius(layout, (t0 + t1) / 2)
    const bands = clipBands(cell.intervals, cell.intact, blank, eps)
    for (const band of bands) {
      // Inner surface of the piece (a gap floor for the piece below it).
      if (band.lo > eps) {
        emitRadialArc(acc, layout, band.lo, t0, t1, cell.alongLo, cell.alongHi, -1, segmentRadians, maxSegments)
      }
      // Outer surface: the actual blank flat, or the cut radius. Both use the
      // same angular tessellation as the axial walls, so their shared edges
      // carry the same vertices (no T-junctions).
      if (band.hiBlank) {
        emitFlatOuter(acc, layout, t0, t1, cell.alongLo, cell.alongHi, segmentRadians, maxSegments)
      } else {
        emitRadialArc(acc, layout, band.hi, t0, t1, cell.alongLo, cell.alongHi, 1, segmentRadians, maxSegments)
      }
    }
  }
}

function emitRadialArc(
  acc: MeshAccumulator,
  layout: SquareMaterialLayout,
  u: number,
  t0: number,
  t1: number,
  alongLo: number,
  alongHi: number,
  sign: 1 | -1,
  segmentRadians: number,
  maxSegments: number,
): void {
  const segments = segmentCount(t1 - t0, segmentRadians, maxSegments)
  for (let s = 0; s < segments; s += 1) {
    const ta = t0 + (t1 - t0) * (s / segments)
    const tb = t0 + (t1 - t0) * ((s + 1) / segments)
    const dir = radialDirection(layout, (ta + tb) / 2)
    const expected: Vec3 = [sign * dir[0], sign * dir[1], sign * dir[2]]
    emitQuad(
      acc,
      world(layout, alongLo, ta, u),
      world(layout, alongHi, ta, u),
      world(layout, alongHi, tb, u),
      world(layout, alongLo, tb, u),
      expected,
    )
  }
}

/**
 * The physical blank flat, tessellated with the same angular step as the arc
 * and axial faces of the cell. A whole sub-wedge lies on one flat plane, but
 * subdividing it keeps every shared edge's vertex set identical to the wall and
 * endcap faces, which is what keeps the boundary a 2-manifold.
 */
function emitFlatOuter(
  acc: MeshAccumulator,
  layout: SquareMaterialLayout,
  t0: number,
  t1: number,
  alongLo: number,
  alongHi: number,
  segmentRadians: number,
  maxSegments: number,
): void {
  const phi = Math.round(((t0 + t1) / 2) / HALF_PI) * HALF_PI
  const dir = radialDirection(layout, phi)
  const segments = segmentCount(t1 - t0, segmentRadians, maxSegments)
  for (let s = 0; s < segments; s += 1) {
    const ta = t0 + (t1 - t0) * (s / segments)
    const tb = t0 + (t1 - t0) * ((s + 1) / segments)
    const ua = blankRadius(layout, ta)
    const ub = blankRadius(layout, tb)
    emitQuad(
      acc,
      world(layout, alongLo, ta, ua),
      world(layout, alongHi, ta, ua),
      world(layout, alongHi, tb, ub),
      world(layout, alongLo, tb, ub),
      dir,
    )
  }
}

function emitAngularFaces(ctx: BuildContext, acc: MeshAccumulator, cell: CellInfo): void {
  // Every angular interface is emitted exactly once, by the lower-index cell's
  // +theta edge; the top cell's +theta edge is the periodic seam to index 0.
  // Emitting it from the wrap-neighbour too would duplicate the seam plane,
  // because theta = -pi and theta = +pi are the same physical angle.
  const neighbourCi = cell.ci + 1 < ctx.layout.angularCount ? cell.ci + 1 : 0
  emitAngularEdge(ctx, acc, cell, neighbourCi, ctx.layout.angularEdges[cell.ci + 1], cell.ci + 1, 1)
}

/**
 * The exposed wall at one angular edge, emitted once for the interface. The
 * bands this cell holds and its neighbour does not face toward the neighbour,
 * and the neighbour-only bands face back the other way; together they are the
 * whole interface. Its along edges sit on the corner lines where it meets the
 * axial walls, so they carry that corner's radial knots.
 */
function emitAngularEdge(
  ctx: BuildContext,
  acc: MeshAccumulator,
  cell: CellInfo,
  neighbourCi: number,
  theta: number,
  angularEdgeIndex: number,
  direction: 1 | -1,
): void {
  const { grid, layout, eps } = ctx
  const blank = blankRadius(layout, theta)
  const aBands = clipBands(cell.intervals, cell.intact, blank, eps)
  const neighbour = readCell(grid, layout, neighbourCi, cell.ai, eps)
  const bBands = neighbour ? clipBands(neighbour.intervals, neighbour.intact, blank, eps) : []
  const diff = differenceBands(aBands, bBands, eps)
  if (diff.length === 0) return
  const dir = thetaDirection(layout, theta)
  const startKnots = cornerKnots(ctx, angularEdgeIndex, cell.ai)
  const endKnots = cornerKnots(ctx, angularEdgeIndex, cell.ai + 1)
  for (const band of diff) {
    if (!(band.hi - band.lo > eps)) continue
    const sign = band.side === 'a' ? direction : -direction
    const expected: Vec3 = [sign * dir[0], sign * dir[1], sign * dir[2]]
    const startU = edgeKnots(startKnots, band.lo, band.hi, layout.epsilon)
    const endU = edgeKnots(endKnots, band.lo, band.hi, layout.epsilon)
    const startPoints = startU.map((u) => world(layout, cell.alongLo, theta, u))
    const endPoints = endU.map((u) => world(layout, cell.alongHi, theta, u))
    emitStrip(acc, startPoints, endPoints, startU, endU, band.lo, band.hi, band.hi, expected)
  }
}

function emitAxialFaces(ctx: BuildContext, acc: MeshAccumulator, cell: CellInfo, partition: readonly number[]): void {
  // Axial neighbours do not wrap. Each interface is emitted once, by the lower
  // cell's +along edge; the +along edge of the last existing cell and the
  // -along edge of the first existing cell are the stock endcaps. The lower
  // cell is located by extent, not by material, so an air cell still emits its
  // material neighbour's exposed wall.
  const lowerExtent = cell.ai > 0 ? ctx.layout.alongEdges[cell.ai] - ctx.layout.alongEdges[cell.ai - 1] : 0
  if (!(lowerExtent > ctx.eps)) {
    emitAxialEdge(ctx, acc, cell, null, cell.alongLo, cell.ai, -1, partition)
  }
  const upper = cell.ai + 1 < ctx.layout.alongCount
    ? readCell(ctx.grid, ctx.layout, cell.ci, cell.ai + 1, ctx.eps)
    : null
  emitAxialEdge(ctx, acc, cell, upper, cell.alongHi, cell.ai + 1, 1, partition)
}

/**
 * The exposed wall at one axial end, emitted once for the interface. A missing
 * neighbour (stock end) exposes the whole profile as the endcap. The angular
 * partition is the column's shared partition, so the wall's theta knots match
 * the radial faces on both sides; its radial edges are refined at the corner
 * lines where it meets the angular interfaces.
 */
function emitAxialEdge(
  ctx: BuildContext,
  acc: MeshAccumulator,
  cell: CellInfo,
  neighbour: CellInfo | null,
  along: number,
  alongEdgeIndex: number,
  direction: 1 | -1,
  partition: readonly number[],
): void {
  const { layout, eps, segmentRadians, maxSegments } = ctx
  const alongVec = alongDirection(layout)
  for (let i = 0; i + 1 < partition.length; i += 1) {
    const t0 = partition[i]
    const t1 = partition[i + 1]
    if (!(t1 - t0 > ANGLE_EPSILON)) continue
    if (t0 < cell.thetaLo - ANGLE_EPSILON || t1 > cell.thetaHi + ANGLE_EPSILON) continue
    const blank = blankRadius(layout, (t0 + t1) / 2)
    const aBands = clipBands(cell.intervals, cell.intact, blank, eps)
    const bBands = neighbour ? clipBands(neighbour.intervals, neighbour.intact, blank, eps) : []
    const diff = differenceBands(aBands, bBands, eps)
    if (diff.length === 0) continue
    const atThetaLo = Math.abs(t0 - cell.thetaLo) <= ANGLE_EPSILON
    const atThetaHi = Math.abs(t1 - cell.thetaHi) <= ANGLE_EPSILON
    const knotsAtLo = atThetaLo ? cornerKnots(ctx, cell.ci, alongEdgeIndex) : NO_KNOTS
    const knotsAtHi = atThetaHi ? cornerKnots(ctx, cell.ci + 1, alongEdgeIndex) : NO_KNOTS
    const segments = segmentCount(t1 - t0, segmentRadians, maxSegments)
    for (let s = 0; s < segments; s += 1) {
      const ta = t0 + (t1 - t0) * (s / segments)
      const tb = t0 + (t1 - t0) * ((s + 1) / segments)
      const knotsA = s === 0 ? knotsAtLo : NO_KNOTS
      const knotsB = s === segments - 1 ? knotsAtHi : NO_KNOTS
      for (const band of diff) {
        if (!(band.hi - band.lo > eps)) continue
        const sign = band.side === 'a' ? direction : -direction
        const expected: Vec3 = [sign * alongVec[0], sign * alongVec[1], sign * alongVec[2]]
        const topA = band.hiBlank ? blankRadius(layout, ta) : band.hi
        const topB = band.hiBlank ? blankRadius(layout, tb) : band.hi
        // A collapsed end (the interval endpoint meets the blank at this angle)
        // is a real triangular wall: emit it instead of dropping the segment.
        if (!(topA > band.lo) && !(topB > band.lo)) continue
        const leftU = edgeKnots(knotsA, band.lo, topA, layout.epsilon)
        const rightU = edgeKnots(knotsB, band.lo, topB, layout.epsilon)
        const leftPoints = leftU.map((u) => world(layout, along, ta, u))
        const rightPoints = rightU.map((u) => world(layout, along, tb, u))
        emitStrip(acc, leftPoints, rightPoints, leftU, rightU, band.lo, topA, topB, expected)
      }
    }
  }
}

/**
 * A patch's edge knot list from `lo` to `top`: the endpoints plus every corner
 * knot strictly inside. A collapsed edge (`top <= lo`) stays a single point.
 */
function edgeKnots(knots: readonly number[], lo: number, top: number, eps: number): number[] {
  const values = [lo]
  if (top > lo + eps) {
    for (const knot of knots) {
      if (knot > lo + eps && knot < top - eps) values.push(knot)
    }
    values.push(top)
  }
  return values
}

/**
 * Triangulate a planar patch whose two opposite edges carry their own radial
 * knot lists. The zipper advances whichever edge's next knot is nearer (as a
 * fraction of that edge's radial span), so every boundary segment is used by
 * exactly one triangle and no edge gains a vertex the neighbouring face lacks.
 * A collapsed edge (a single point) fans from that point.
 */
function emitStrip(
  acc: MeshAccumulator,
  leftPoints: readonly Vec3[],
  rightPoints: readonly Vec3[],
  leftU: readonly number[],
  rightU: readonly number[],
  lo: number,
  leftTop: number,
  rightTop: number,
  expected: Vec3,
): void {
  if (leftPoints.length === 0 || rightPoints.length === 0) return
  if (leftPoints.length === 1 && rightPoints.length === 1) return
  if (leftPoints.length === 1) {
    for (let j = 0; j + 1 < rightPoints.length; j += 1) {
      emitOrientedTriangle(acc, leftPoints[0], rightPoints[j], rightPoints[j + 1], expected)
    }
    return
  }
  if (rightPoints.length === 1) {
    for (let i = 0; i + 1 < leftPoints.length; i += 1) {
      emitOrientedTriangle(acc, leftPoints[i], rightPoints[0], leftPoints[i + 1], expected)
    }
    return
  }
  const leftSpan = leftTop - lo
  const rightSpan = rightTop - lo
  let i = 0
  let j = 0
  // Both edges start at the same radius. At u = 0 that start is the pivot, the
  // same world point on both edges, so the first triangle advances both edges
  // at once and carries their first boundary segments.
  if (samePoint(leftPoints[0], rightPoints[0])) {
    if (leftPoints.length < 2 || rightPoints.length < 2) return
    emitOrientedTriangle(acc, leftPoints[0], leftPoints[1], rightPoints[1], expected)
    i = 1
    j = 1
  }
  while (i < leftPoints.length - 1 || j < rightPoints.length - 1) {
    const nextLeft = i < leftPoints.length - 1 ? (leftU[i + 1] - lo) / leftSpan : Infinity
    const nextRight = j < rightPoints.length - 1 ? (rightU[j + 1] - lo) / rightSpan : Infinity
    if (nextLeft <= nextRight) {
      emitOrientedTriangle(acc, leftPoints[i], rightPoints[j], leftPoints[i + 1], expected)
      i += 1
    } else {
      emitOrientedTriangle(acc, leftPoints[i], rightPoints[j], rightPoints[j + 1], expected)
      j += 1
    }
  }
}

function samePoint(a: Vec3, b: Vec3): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
}

function sortUnique(values: number[], eps: number): number[] {
  values.sort((a, b) => a - b)
  const out: number[] = []
  for (const value of values) {
    if (out.length === 0 || value - out[out.length - 1] > eps) out.push(value)
  }
  return out
}
