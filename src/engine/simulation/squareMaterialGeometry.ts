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
 * Boundary geometry for the remaining square material (issue #1016 C2-R2M).
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
 * ## Clipping and splitting
 *
 * `blankRadius(theta)` is piecewise (`R/cos(theta - phi)` on the flat whose
 * normal is `phi`), so an angular wedge is split at the blank's corners
 * (odd multiples of pi/4), at its flat normals (multiples of pi/2), and
 * wherever an interval endpoint crosses the blank. Within one sub-wedge the
 * outer surface is either a constant-radius arc or one planar flat, and no
 * face ever spans a removed radial interval.
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
  breaks: number[]
}

interface MeshAccumulator {
  positions: number[]
  normals: number[]
  min: [number, number, number]
  max: [number, number, number]
}

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
 * neighbour on each side (its shared-edge walls changed too), and the periodic
 * opposite chunk when the region meets either seam.
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
  const eps = layout.epsilon
  const acc = createAccumulator()
  const first = Math.max(0, angularStart)
  const last = Math.min(layout.angularCount - 1, angularEnd)

  for (let ci = first; ci <= last; ci += 1) {
    for (let ai = 0; ai < layout.alongCount; ai += 1) {
      const cell = readCell(grid, layout, ci, ai, eps)
      if (!cell) continue
      emitRadialFaces(acc, layout, cell, eps, segmentRadians, maxSegments)
      emitAngularFaces(acc, grid, layout, cell, eps)
      emitAxialFaces(acc, grid, layout, cell, eps, segmentRadians, maxSegments)
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
 * happens at the pivot, where every radius-0 corner is the same world point) is
 * dropped, so no zero-area triangle and no zero-length edge reaches the GPU.
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
  const area = cross(sub(b, a), sub(c, a))
  if (!(Math.hypot(area[0], area[1], area[2]) > 1e-18)) return
  pushVertex(acc, a, nx, ny, nz)
  pushVertex(acc, b, nx, ny, nz)
  pushVertex(acc, c, nx, ny, nz)
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
  // A fully removed cell is still a real cell: it emits no material faces, but
  // it must run its +edge interfaces so a material neighbour's exposed wall is
  // emitted exactly once (by the lower-index / lower-along side).
  const hasMaterial = intervals.length > 0
  const topHi = hasMaterial ? intervals[intervals.length - 1] : Number.NaN
  const intact = hasMaterial && topHi >= baseline - Math.max(1, Math.abs(baseline)) * BASELINE_TOLERANCE
  const cell: CellInfo = {
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
    breaks: [],
  }
  cell.breaks = cellBreakPoints(layout, cell, eps)
  return cell
}

/**
 * The cell's angular partition: its own edges, every blank corner and flat
 * normal inside it, and every angle where an interval endpoint meets the
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
  acc: MeshAccumulator,
  layout: SquareMaterialLayout,
  cell: CellInfo,
  eps: number,
  segmentRadians: number,
  maxSegments: number,
): void {
  for (let i = 0; i + 1 < cell.breaks.length; i += 1) {
    const t0 = cell.breaks[i]
    const t1 = cell.breaks[i + 1]
    if (!(t1 - t0 > ANGLE_EPSILON)) continue
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

function emitAngularFaces(
  acc: MeshAccumulator,
  grid: SimulationGrid,
  layout: SquareMaterialLayout,
  cell: CellInfo,
  eps: number,
): void {
  // Every angular interface is emitted exactly once, by the lower-index cell's
  // +theta edge; the top cell's +theta edge is the periodic seam to index 0.
  // Emitting it from the wrap-neighbour too would duplicate the seam plane,
  // because theta = -pi and theta = +pi are the same physical angle.
  const neighbourCi = cell.ci + 1 < layout.angularCount ? cell.ci + 1 : 0
  emitAngularEdge(acc, grid, layout, cell, neighbourCi, layout.angularEdges[cell.ci + 1], 1, eps)
}

/**
 * The exposed wall at one angular edge, emitted once for the interface. The
 * bands this cell holds and its neighbour does not face toward the neighbour,
 * and the neighbour-only bands face back the other way; together they are the
 * whole interface.
 */
function emitAngularEdge(
  acc: MeshAccumulator,
  grid: SimulationGrid,
  layout: SquareMaterialLayout,
  cell: CellInfo,
  neighbourCi: number,
  theta: number,
  direction: 1 | -1,
  eps: number,
): void {
  const blank = blankRadius(layout, theta)
  const aBands = clipBands(cell.intervals, cell.intact, blank, eps)
  const neighbour = readCell(grid, layout, neighbourCi, cell.ai, eps)
  const bBands = neighbour ? clipBands(neighbour.intervals, neighbour.intact, blank, eps) : []
  const diff = differenceBands(aBands, bBands, eps)
  const dir = thetaDirection(layout, theta)
  for (const band of diff) {
    const sign = band.side === 'a' ? direction : -direction
    const expected: Vec3 = [sign * dir[0], sign * dir[1], sign * dir[2]]
    emitQuad(
      acc,
      world(layout, cell.alongLo, theta, band.lo),
      world(layout, cell.alongHi, theta, band.lo),
      world(layout, cell.alongHi, theta, band.hi),
      world(layout, cell.alongLo, theta, band.hi),
      expected,
    )
  }
}

function emitAxialFaces(
  acc: MeshAccumulator,
  grid: SimulationGrid,
  layout: SquareMaterialLayout,
  cell: CellInfo,
  eps: number,
  segmentRadians: number,
  maxSegments: number,
): void {
  // Axial neighbours do not wrap. Each interface is emitted once, by the lower
  // cell's +along edge; the +along edge of the last existing cell and the
  // -along edge of the first existing cell are the stock endcaps. The lower
  // cell is located by extent, not by material, so an air cell still emits its
  // material neighbour's exposed wall.
  const lowerExtent = cell.ai > 0 ? layout.alongEdges[cell.ai] - layout.alongEdges[cell.ai - 1] : 0
  if (!(lowerExtent > eps)) {
    emitAxialEdge(acc, layout, cell, null, cell.alongLo, -1, eps, segmentRadians, maxSegments)
  }
  const upper = cell.ai + 1 < layout.alongCount ? readCell(grid, layout, cell.ci, cell.ai + 1, eps) : null
  emitAxialEdge(acc, layout, cell, upper, cell.alongHi, 1, eps, segmentRadians, maxSegments)
}

/**
 * The exposed wall at one axial end, emitted once for the interface. A missing
 * neighbour (stock end) exposes the whole profile as the endcap. The angular
 * partition is the union of both cells' breaks, so the difference structure is
 * constant across every emitted sub-range.
 */
function emitAxialEdge(
  acc: MeshAccumulator,
  layout: SquareMaterialLayout,
  cell: CellInfo,
  neighbour: CellInfo | null,
  along: number,
  direction: 1 | -1,
  eps: number,
  segmentRadians: number,
  maxSegments: number,
): void {
  const breaks = neighbour ? sortUnique([...cell.breaks, ...neighbour.breaks], ANGLE_EPSILON) : cell.breaks
  const alongVec = alongDirection(layout)
  for (let i = 0; i + 1 < breaks.length; i += 1) {
    const t0 = breaks[i]
    const t1 = breaks[i + 1]
    if (!(t1 - t0 > ANGLE_EPSILON)) continue
    const blank = blankRadius(layout, (t0 + t1) / 2)
    const aBands = clipBands(cell.intervals, cell.intact, blank, eps)
    const bBands = neighbour ? clipBands(neighbour.intervals, neighbour.intact, blank, eps) : []
    const diff = differenceBands(aBands, bBands, eps)
    for (const band of diff) {
      const sign = band.side === 'a' ? direction : -direction
      const expected: Vec3 = [sign * alongVec[0], sign * alongVec[1], sign * alongVec[2]]
      emitAxialBand(acc, layout, along, t0, t1, band.lo, band.hi, band.hiBlank, expected, segmentRadians, maxSegments)
    }
  }
}

function emitAxialBand(
  acc: MeshAccumulator,
  layout: SquareMaterialLayout,
  along: number,
  t0: number,
  t1: number,
  lo: number,
  hi: number,
  hiBlank: boolean,
  expected: Vec3,
  segmentRadians: number,
  maxSegments: number,
): void {
  if (!(hi > lo)) return
  const segments = segmentCount(t1 - t0, segmentRadians, maxSegments)
  for (let s = 0; s < segments; s += 1) {
    const ta = t0 + (t1 - t0) * (s / segments)
    const tb = t0 + (t1 - t0) * ((s + 1) / segments)
    const ua = hiBlank ? blankRadius(layout, ta) : hi
    const ub = hiBlank ? blankRadius(layout, tb) : hi
    if (!(ua > lo) || !(ub > lo)) continue
    emitQuad(
      acc,
      world(layout, along, ta, lo),
      world(layout, along, tb, lo),
      world(layout, along, tb, ub),
      world(layout, along, ta, ua),
      expected,
    )
  }
}

function sortUnique(values: number[], eps: number): number[] {
  values.sort((a, b) => a - b)
  const out: number[] = []
  for (const value of values) {
    if (out.length === 0 || value - out[out.length - 1] > eps) out.push(value)
  }
  return out
}
