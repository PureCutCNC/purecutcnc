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

import { getProfileBounds, type Operation, type Point, type Project, type SketchFeature } from '../../types/project'
import type { ToolpathWarning } from './warningCodes'
import type { ClipperPath, NormalizedTool, ToolpathMove, ToolpathPoint } from './types'
import { DEFAULT_CLIPPER_SCALE, flattenProfile, normalizeWinding, toClipperPath } from './geometry'
import { buildSurfaceSlopeDomain, createSurfaceDomainLinkCheck, intersectSurfaceSlopeDomain } from './finishSurfaceSlope'
import { retractToSafe, transitionToCutEntry } from './pocket'
import { buildRegionMask } from './regions'
import { resolveRegionDomainCentre } from './regionDomain'
import { significantSilhouettePaths } from './silhouette'
import { appendClampBlockedWarnings, buildProtectedFootprintPaths, clampsBlockingArea, clipperPathsToTupleContours, differenceClipperPaths, unionClipperPaths } from './modelProtection'
import { appendAll } from './appendAll'
import { finishScallopSpacing } from './scallopHeight'
import type { RetainedMaterialCheck } from './retainedMaterial'
import type { FinishModelSurface } from './finishModelSurface'
import { refineSurfacePathAtCliffs } from './surfacePathCliffs'

function computeContourBounds(
  contours: Iterable<Array<Array<[number, number]>>>,
): { minX: number; maxX: number; minY: number; maxY: number } | null {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const contourSet of contours) {
    for (const contour of contourSet) {
      for (const [x, y] of contour) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  return Number.isFinite(minX) && Number.isFinite(maxX) && Number.isFinite(minY) && Number.isFinite(maxY)
    ? { minX, maxX, minY, maxY }
    : null
}

function pointEpsilonEqual(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9
}

function rotatePoint(point: Point, cosTheta: number, sinTheta: number): Point {
  return {
    x: point.x * cosTheta - point.y * sinTheta,
    y: point.x * sinTheta + point.y * cosTheta,
  }
}

function scanlineIntervalsForContours(contours: Point[][], y: number): Array<[number, number]> {
  const intersections: number[] = []
  for (const contour of contours) {
    const closed = contour.length > 0 && pointEpsilonEqual(contour[0], contour[contour.length - 1])
      ? contour
      : [...contour, contour[0]]

    for (let index = 0; index < closed.length - 1; index += 1) {
      const a = closed[index]
      const b = closed[index + 1]

      if (Math.abs(a.y - b.y) <= 1e-9) continue

      const intersects = (a.y <= y && b.y > y) || (b.y <= y && a.y > y)
      if (!intersects) continue

      const t = (y - a.y) / (b.y - a.y)
      intersections.push(a.x + (b.x - a.x) * t)
    }
  }

  intersections.sort((left, right) => left - right)

  const intervals: Array<[number, number]> = []
  for (let index = 0; index + 1 < intersections.length; index += 2) {
    const start = intersections[index]
    const end = intersections[index + 1]
    if (end - start > 1e-9) {
      intervals.push([start, end])
    }
  }
  return intervals
}

export function computeXYBounds(positions: Float32Array): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]
    const y = positions[i + 1]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return { minX, maxX, minY, maxY }
}

function computeRegionFeatureBounds(regionFeatures: SketchFeature[]): { minX: number; maxX: number; minY: number; maxY: number } | null {
  if (regionFeatures.length === 0) return null

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const region of regionFeatures) {
    const bounds = getProfileBounds(region.sketch.profile)
    if (bounds.minX < minX) minX = bounds.minX
    if (bounds.maxX > maxX) maxX = bounds.maxX
    if (bounds.minY < minY) minY = bounds.minY
    if (bounds.maxY > maxY) maxY = bounds.maxY
  }

  return Number.isFinite(minX) && Number.isFinite(maxX) && Number.isFinite(minY) && Number.isFinite(maxY)
    ? { minX, maxX, minY, maxY }
    : null
}

function clampExpandedBoundsToModel(
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
  modelBounds: { minX: number; maxX: number; minY: number; maxY: number },
  padding: number,
): { minX: number; maxX: number; minY: number; maxY: number } {
  const expanded = {
    minX: Math.max(modelBounds.minX, bounds.minX - padding),
    maxX: Math.min(modelBounds.maxX, bounds.maxX + padding),
    minY: Math.max(modelBounds.minY, bounds.minY - padding),
    maxY: Math.min(modelBounds.maxY, bounds.maxY + padding),
  }

  return expanded.maxX > expanded.minX && expanded.maxY > expanded.minY
    ? expanded
    : modelBounds
}

function toOpenCutMoves3D(points: ToolpathPoint[]): ToolpathMove[] {
  if (points.length < 2) return []
  const moves: ToolpathMove[] = []
  for (let i = 0; i < points.length - 1; i += 1) {
    moves.push({
      kind: 'cut',
      from: points[i],
      to: points[i + 1],
    })
  }
  return moves
}

function clampSurfaceSegmentToMinZ(
  segment: Array<{ x: number; y: number; z: number; rotX: number }>,
  minZAtPoint: (point: Point) => number,
): Array<{ x: number; y: number; z: number; rotX: number }> {
  return segment.map((point) => ({
    ...point,
    z: Math.max(point.z, minZAtPoint(point)),
  }))
}

/**
 * Split a scanline wherever the depth limit steps, leaving Z untouched.
 *
 * This used to clamp each point up to the floor as well. It no longer does, so
 * that `applyGougeProtection` produces the *unclamped* cutter-location surface
 * and `hasMachinableSurface` can tell a real surface from one sitting under a
 * floor another operation owns (issue #711). Nothing is lost by dropping the
 * clamp: `clampSurfaceSegmentToMinZ` still runs afterwards, and `Math.max` is
 * associative, so the emitted Z is unchanged.
 */
function splitSurfaceSegmentOnFloorChange(
  segment: Array<{ x: number; y: number; z: number; rotX: number }>,
  minZAtPoint: (point: Point) => number,
): Array<Array<{ x: number; y: number; z: number; rotX: number }>> {
  const chunks: Array<Array<{ x: number; y: number; z: number; rotX: number }>> = []
  let current: Array<{ x: number; y: number; z: number; rotX: number }> = []
  let currentFloor: number | null = null

  for (const point of segment) {
    const floorZ = minZAtPoint(point)

    if (currentFloor !== null && Math.abs(floorZ - currentFloor) > 1e-9) {
      if (current.length >= 2) {
        chunks.push(current)
      }
      current = []
    }

    current.push(point)
    currentFloor = floorZ
  }

  if (current.length >= 2) {
    chunks.push(current)
  }

  return chunks
}

/**
 * Drop the stretches of a gouge-protected scanline that have no machinable
 * surface under them, returning the runs that survive (issue #711). Points are
 * judged on their lifted cutter-location Z, which is why this runs after
 * `applyGougeProtection` and before the floor clamp.
 */
function splitSegmentAtUnmachinableSurface(
  segment: Array<{ x: number; y: number; z: number; rotX: number }>,
  hasMachinableSurface: (point: Point, liftedSurfaceZ: number) => boolean,
): Array<Array<{ x: number; y: number; z: number; rotX: number }>> {
  const chunks: Array<Array<{ x: number; y: number; z: number; rotX: number }>> = []
  let current: Array<{ x: number; y: number; z: number; rotX: number }> = []
  for (const point of segment) {
    if (hasMachinableSurface(point, point.z)) {
      current.push(point)
      continue
    }
    if (current.length >= 2) chunks.push(current)
    current = []
  }
  if (current.length >= 2) chunks.push(current)
  return chunks
}

const MAX_HEIGHT_MAP_CELLS = 1_000_000

/**
 * Scratch records for the no-centre clip candidates, reused across height maps.
 * The raster builds one map at a time, and the map it returns never references
 * these arrays, so a single set grown to the largest map seen is enough. A fine
 * mesh produces hundreds of thousands of candidates per map and dozens of maps
 * per operation; allocating them per map is measurable GC.
 */
interface CandidateScratch {
  triangles: Int32Array
  maxZ: Float64Array
  cells: Int32Array
  boxes: Int32Array
}
let candidateScratch: CandidateScratch | undefined

function candidateWorkspace(capacity: number): CandidateScratch {
  const current = candidateScratch
  if (current !== undefined && current.triangles.length >= capacity) return current
  const next = Math.max(capacity, current !== undefined ? current.triangles.length * 2 : 4096)
  candidateScratch = {
    triangles: new Int32Array(next),
    maxZ: new Float64Array(next),
    cells: new Int32Array(next),
    boxes: new Int32Array(next * 4),
  }
  return candidateScratch
}

export interface HeightMap {
  data: Float32Array
  width: number
  height: number
  originX: number
  originY: number
  cellSize: number
  /**
   * With `trackCellRise`, the largest `(|dz/dx| + |dz/dy|) * cellSize / 2` over
   * the **centre-sampled** triangles that rasterised a cell (issue #1045 slice
   * F). A #1050 no-centre triangle contributes its exact maximum inside the
   * cell, so it is excluded: it cannot under-read and must not inflate this one
   * scalar. Omitted (or 0) otherwise.
   */
  cellRise?: number
  /**
   * Coverage of each cell by the wall triangles a caller separated out with
   * `HeightMapBuildOptions.wallTriangleStart` (#1095 slice D), one byte per cell:
   * `1` when only model triangles covered the cell, `2` when only wall triangles
   * did, `3` when both, `0` when neither. Omitted when the caller marks no
   * walls.
   */
  wallCoverage?: Uint8Array
  /**
   * The highest **model** material in each cell, for the cells a wall triangle
   * also covered (`wallCoverage` has bit `2`). A padded sample that only reaches
   * such a cell must read this, not {@link data}: `data` holds the wall's top,
   * which is stock to keep, and lifting the tip over it is exactly the air pass
   * #1095 slice D removes. `-Infinity` when no model covers the cell. Omitted
   * when no walls are marked.
   */
  modelOnly?: Float32Array
}

type CoverageContours = Array<Array<[number, number]>>
export type FinishSurfaceParallelCacheHost = { finishHeightMapCache?: Map<string, HeightMap> }

export function chooseHeightMapCellSize(
  bbox: { minX: number; maxX: number; minY: number; maxY: number },
  requestedCellSize: number,
  warnings: ToolpathWarning[],
): number {
  let cellSize = Math.max(requestedCellSize, 1e-6)
  const spanX = Math.max(0, bbox.maxX - bbox.minX)
  const spanY = Math.max(0, bbox.maxY - bbox.minY)
  const requestedWidth = Math.max(1, Math.ceil(spanX / cellSize))
  const requestedHeight = Math.max(1, Math.ceil(spanY / cellSize))
  const requestedCells = requestedWidth * requestedHeight
  if (requestedCells <= MAX_HEIGHT_MAP_CELLS) return cellSize

  cellSize *= Math.sqrt(requestedCells / MAX_HEIGHT_MAP_CELLS)
  warnings.push({
    code: 'surfaceHeightMapReduced',
    params: { from: requestedCells.toLocaleString(), to: MAX_HEIGHT_MAP_CELLS.toLocaleString() },
  })
  return cellSize
}

/**
 * A band of the height map to rasterise, in cell indices. The grid itself --
 * `originX/originY`, `cellSize`, `width`, `height` and the full-size `data`
 * array -- is unaffected, so a windowed map has exactly the geometry a full map
 * would; only the cells outside the band stay at `-Infinity` (issue #1015 slice
 * L). A caller that reads one row (or column) of cells and their tool-reach
 * neighbours can therefore pay for those rows alone.
 */
export interface HeightMapWindow {
  /** Lowest row to rasterise, inclusive. */
  readonly minRow?: number
  /** Highest row to rasterise, inclusive. */
  readonly maxRow?: number
  /** Lowest column to rasterise, inclusive. */
  readonly minCol?: number
  /** Highest column to rasterise, inclusive. */
  readonly maxCol?: number
}

export interface HeightMapBuildOptions {
  /** Rasterise only this band of rows / columns. */
  readonly window?: HeightMapWindow
  /**
   * Triangle starts (every third `index` entry) to rasterise, in any order;
   * every triangle when omitted. A cell's value is the maximum over the
   * triangles covering it, so a caller that rasterises a superset of the
   * triangles that can touch its window gets exactly the full map's values
   * there.
   */
  readonly triangles?: Uint32Array
  /**
   * Track the largest rise a centre-sampled triangle's plane makes across half
   * of one cell (issue #1045 slice F). Reported as {@link HeightMap.cellRise},
   * it bounds how far a cell-centre height can sit below the true surface
   * inside that cell, so a caller that reads the map as a support can pad its
   * tip by exactly that much. #1050's clipped no-centre contributions are exact
   * and are deliberately not counted.
   */
  readonly trackCellRise?: boolean
  /**
   * The first triangle that belongs to a **retained wall** — stock the operation
   * must not cut, as opposed to the model surface (#1095 slice D). `triangles`
   * are triangle starts, so a triangle is a wall when its start is at least
   * `wallTriangleStart * 3`. A cell a wall covers and the model does not is
   * recorded in {@link HeightMap.wallCoverage} as `2`.
   *
   * A wall cell is what makes a tangent pass read as contact: a vertical face
   * at exactly one cutter radius smears the wall's top into the cell that
   * straddles the face, and the conservative cell pad
   * (`safeToolTipZAt`'s `cellPad`) then lifts a pass the cutter only *touches*.
   * Marking the cells lets that caller keep the pad for model geometry while
   * treating a wall cell as contact only when the unpadded footprint reaches it.
   */
  readonly wallTriangleStart?: number
}

/**
 * Scratch polygons for {@link triangleMaxZInCell}. A triangle clipped by four
 * cell edges has at most 7 vertices, so 8 is enough; module scope keeps the
 * no-centre path allocation-free, and the helper never calls itself.
 */
const CLIP_VERTICES = 8
const clipA = new Float64Array(CLIP_VERTICES * 3)
const clipB = new Float64Array(CLIP_VERTICES * 3)

/**
 * Clip one polygon against one axis-aligned cell edge, carrying Z by linear
 * interpolation so a clipped vertex keeps the triangle's plane height.
 *
 * `keepAbove` selects `coord >= limit` (the cell's low edge) instead of
 * `coord <= limit` (its high edge). Vertices are packed `x, y, z`.
 */
function clipPolygonAtEdge(
  src: Float64Array,
  srcCount: number,
  axis: 0 | 1,
  limit: number,
  keepAbove: boolean,
  dst: Float64Array,
): number {
  let out = 0
  let prev = srcCount - 1
  let prevX = src[prev * 3]
  let prevY = src[prev * 3 + 1]
  let prevZ = src[prev * 3 + 2]
  let prevInside = keepAbove
    ? (axis === 0 ? prevX : prevY) >= limit
    : (axis === 0 ? prevX : prevY) <= limit
  for (let v = 0; v < srcCount; v++) {
    const curX = src[v * 3]
    const curY = src[v * 3 + 1]
    const curZ = src[v * 3 + 2]
    const curCoord = axis === 0 ? curX : curY
    const inside = keepAbove ? curCoord >= limit : curCoord <= limit
    if (inside !== prevInside) {
      // The edge crosses the boundary. On the way **in**, the intersection
      // comes before the vertex; on the way out, after it. Keeping that order
      // is what stops the clipped polygon from self-intersecting (and its
      // signed area from cancelling to zero) at a cell edge.
      const prevCoord = axis === 0 ? prevX : prevY
      const denom = curCoord - prevCoord
      const t = denom !== 0 ? (limit - prevCoord) / denom : 0
      dst[out * 3] = prevX + (curX - prevX) * t
      dst[out * 3 + 1] = prevY + (curY - prevY) * t
      dst[out * 3 + 2] = prevZ + (curZ - prevZ) * t
      out++
    }
    if (inside) {
      dst[out * 3] = curX
      dst[out * 3 + 1] = curY
      dst[out * 3 + 2] = curZ
      out++
    }
    prev = v
    prevX = curX
    prevY = curY
    prevZ = curZ
    prevInside = inside
  }
  return out
}

/**
 * The highest point of a triangle inside an axis-aligned cell (issue #1050).
 *
 * The height map samples one cell centre, so a narrow feature that misses
 * every centre used to contribute nothing and could be cut through silently.
 * For a triangle that covers no cell centre the rasteriser raises each cell it
 * overlaps to this value instead: clip the triangle to the cell and take the
 * maximum Z at a clipped-polygon vertex, because Z is linear over the triangle
 * and a linear function on a convex polygon peaks at a vertex.
 *
 * Returns `-Infinity` when the triangle only touches the cell boundary: a
 * zero-area sliver occupies no cell, so it must not lift one.
 */
export function triangleMaxZInCell(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  minX: number, minY: number, maxX: number, maxY: number,
): number {
  clipA[0] = ax; clipA[1] = ay; clipA[2] = az
  clipA[3] = bx; clipA[4] = by; clipA[5] = bz
  clipA[6] = cx; clipA[7] = cy; clipA[8] = cz
  let count = clipPolygonAtEdge(clipA, 3, 0, minX, true, clipB)
  if (count === 0) return Number.NEGATIVE_INFINITY
  count = clipPolygonAtEdge(clipB, count, 0, maxX, false, clipA)
  if (count === 0) return Number.NEGATIVE_INFINITY
  count = clipPolygonAtEdge(clipA, count, 1, minY, true, clipB)
  if (count === 0) return Number.NEGATIVE_INFINITY
  count = clipPolygonAtEdge(clipB, count, 1, maxY, false, clipA)
  if (count === 0) return Number.NEGATIVE_INFINITY
  // A boundary touch clips to a line: area zero. Reject it before its (real)
  // Z can lift a cell the triangle does not actually occupy.
  let area2 = 0
  for (let v = 0; v < count; v++) {
    const next = (v + 1) % count
    area2 += clipA[v * 3] * clipA[next * 3 + 1] - clipA[next * 3] * clipA[v * 3 + 1]
  }
  if (!(Math.abs(area2) > 1e-12 * (maxX - minX) * (maxY - minY))) {
    return Number.NEGATIVE_INFINITY
  }
  let maxZ = Number.NEGATIVE_INFINITY
  for (let v = 0; v < count; v++) {
    const z = clipA[v * 3 + 2]
    if (z > maxZ) maxZ = z
  }
  return maxZ
}

/**
 * The fraction of a cell by which a no-centre triangle's clipped maximum must
 * stand above the cell's own centre sample **and** all eight of its neighbours'
 * before it counts as a local peak the centre sampling missed (issue #1050
 * slice B).
 *
 * A smooth surface cannot clear a positive threshold. Across one cell a plane's
 * height changes by at most `g * cell` for a gradient magnitude `g`; the highest
 * of the eight neighbours is the uphill diagonal, at least `g * cell` above the
 * centre, while the clipped maximum inside the cell is at most
 * `g * cell * sqrt(2) / 2` above it. A curved-but-smooth surface leaves only
 * the sagitta of one cell -- a fraction of a percent of the cell on the meshes
 * that matter -- and float32 vertex noise is smaller again. One percent is two
 * orders of magnitude below a real thin feature (the 0.02 mm fin on 0.1 mm
 * cells is 20 % of a cell, the 1 mm tube on 1 mm cells 50 %), so a fin or tube
 * clears it while a smooth steep wall never does.
 */
export const THIN_FEATURE_PEAK_FRACTION = 0.01

/** The absolute height, in project units, of the local-peak test above. */
export function thinFeaturePeakThreshold(cellSize: number): number {
  return cellSize * THIN_FEATURE_PEAK_FRACTION
}

/** Which height category a triangle contributes to the #1095 wall bookkeeping. */
type CoverageBit = 1 | 2

/**
 * What the centre-sampled map already reads, for the height category a triangle
 * belongs to. A retained wall's top is not the model surface (#1095 slice D), so
 * a model triangle is compared with the *model-only* height of a wall-covered
 * cell and a wall triangle with the cell's full top. Without that split a wall
 * standing beside a floor would mask -- or be masked by -- the other surface.
 */
function readCellHeight(
  data: Float32Array,
  idx: number,
  coverageBit: CoverageBit,
  wallCoverage: Uint8Array | undefined,
  modelOnly: Float32Array | undefined,
): number {
  if (coverageBit === 1 && wallCoverage !== undefined && (wallCoverage[idx] & 2) !== 0) {
    return modelOnly !== undefined ? modelOnly[idx] : data[idx]
  }
  return data[idx]
}

/**
 * The highest centre-sampled height in a cell's 3x3 neighbourhood, for the
 * height category a triangle belongs to (issue #1050 slice B). A clipped
 * maximum is a local peak only when it beats this by more than the threshold.
 *
 * `windowMinRow..windowMaxRow`/`windowMinCol..windowMaxCol` are the cells the
 * caller actually rasterised. A neighbour outside that band (but inside the
 * grid) has no sample, so the cell cannot be judged: `+Infinity` makes every
 * comparison against it fail. Only a full map -- whose band is the whole grid --
 * decides the grid's own edge cells; a neighbour outside the grid proper is
 * genuinely absent, exactly as in a full map. (The window's edge cells are
 * outside the tool's reach, so the sampler never reads them.)
 */
function neighbourhoodLimit(
  data: Float32Array,
  width: number,
  height: number,
  row: number,
  col: number,
  coverageBit: CoverageBit,
  windowMinRow: number,
  windowMaxRow: number,
  windowMinCol: number,
  windowMaxCol: number,
  wallCoverage?: Uint8Array,
  modelOnly?: Float32Array,
): number {
  const minRow = Math.max(0, row - 1)
  const maxRow = Math.min(height - 1, row + 1)
  const minCol = Math.max(0, col - 1)
  const maxCol = Math.min(width - 1, col + 1)
  let limit = Number.NEGATIVE_INFINITY
  for (let nr = minRow; nr <= maxRow; nr++) {
    for (let nc = minCol; nc <= maxCol; nc++) {
      if ((nr < windowMinRow || nr > windowMaxRow || nc < windowMinCol || nc > windowMaxCol)
        && nr >= 0 && nr < height && nc >= 0 && nc < width) {
        return Number.POSITIVE_INFINITY
      }
      const read = readCellHeight(data, nr * width + nc, coverageBit, wallCoverage, modelOnly)
      if (read > limit) limit = read
    }
  }
  return limit
}

/**
 * Precompute {@link neighbourhoodLimit} for every cell in the rasterised window
 * (issue #1050 slice B). The clip pass then tests a candidate with one array read
 * per cell instead of nine, which is what keeps a fine smooth mesh close to the
 * centre-sampled raster's cost. Only window cells are written, and the clip
 * pass never reads outside the window.
 */
export function buildPeakLimitMap(
  data: Float32Array,
  width: number,
  height: number,
  minRow: number,
  maxRow: number,
  minCol: number,
  maxCol: number,
  coverageBit: CoverageBit,
  wallCoverage?: Uint8Array,
  modelOnly?: Float32Array,
): Float32Array {
  // Only the window is written, and only the window is ever read: the clip pass
  // clamps candidate cells to the window, so the zero-filled rest is inert. That
  // keeps a windowed map from paying a full-grid fill on every angle.
  const limit = new Float32Array(width * height)
  for (let row = minRow; row <= maxRow; row++) {
    for (let col = minCol; col <= maxCol; col++) {
      limit[row * width + col] = neighbourhoodLimit(data, width, height, row, col,
        coverageBit, minRow, maxRow, minCol, maxCol, wallCoverage, modelOnly)
    }
  }
  return limit
}

/**
 * Whether a no-centre triangle's clipped maximum inside a cell is a local peak
 * the centre sampling missed (issue #1050 slice B).
 *
 * It has to beat the cell's own centre-sampled height **and** every one of the
 * eight neighbours' by more than `threshold`. A fin or a thin tube between
 * centres is such a peak; a wall's vertical face beside a floor is not, because
 * the neighbour on the high side already reads the wall's top, and a smooth
 * surface never is, because its uphill neighbour reads at least what the
 * clipped maximum can add (see {@link THIN_FEATURE_PEAK_FRACTION}).
 *
 * This is the reference form of the rule, used by the tests; the kernels
 * compare against a precomputed {@link buildPeakLimitMap} instead.
 */
export function clippedMaxIsLocalPeak(
  z: number,
  data: Float32Array,
  width: number,
  height: number,
  row: number,
  col: number,
  threshold: number,
  coverageBit: CoverageBit,
  windowMinRow: number,
  windowMaxRow: number,
  windowMinCol: number,
  windowMaxCol: number,
  wallCoverage?: Uint8Array,
  modelOnly?: Float32Array,
): boolean {
  return z > neighbourhoodLimit(data, width, height, row, col, coverageBit,
    windowMinRow, windowMaxRow, windowMinCol, windowMaxCol, wallCoverage, modelOnly) + threshold
}

/**
 * Rasterise a triangle mesh into a height map, one value per cell.
 *
 * A cell's value is normally the highest triangle at the cell's centre. That
 * loses any feature narrower than a cell (issue #1050), so a triangle that
 * covers **no** cell centre may also raise a cell to the highest point of the
 * triangle inside it -- but only when that height is a local peak the centre
 * sampling missed ({@link clippedMaxIsLocalPeak}). A smooth fine mesh therefore
 * keeps exactly its centre-sampled map and its old cost.
 *
 * The rule is two-pass: all centre samples are rasterised first (collecting the
 * no-centre triangles as candidates), then a single 3x3 neighbourhood-max map is
 * built from those samples and every candidate is rejected in O(1) per cell it
 * overlaps before anything is clipped. The comparison heights are always the
 * centre-sampled map before any clipped contribution, so the order candidates
 * are visited in cannot change the result. A triangle that covers a centre is
 * rasterised exactly as before, and the no-centre decision is made over the
 * whole grid even when a window is rasterised, so a windowed map still agrees
 * with a full one apart from cells at the window edge (whose missing neighbours
 * read `-Infinity`; those cells are outside the tool's reach).
 */
export function buildHeightMap(
  positions: Float32Array,
  index: Uint32Array,
  bbox: { minX: number; maxX: number; minY: number; maxY: number },
  cellSize: number,
  options?: HeightMapBuildOptions,
): HeightMap {
  const width = Math.max(1, Math.ceil((bbox.maxX - bbox.minX) / cellSize))
  const height = Math.max(1, Math.ceil((bbox.maxY - bbox.minY) / cellSize))
  const data = new Float32Array(width * height)
  data.fill(-Infinity)
  let cellRise = 0
  // #1095 slice D: one byte per cell recording whether the height came from the
  // model, from a retained wall, or both. Only allocated when the caller names
  // the wall triangles, so every existing caller pays nothing.
  const wallStart = options?.wallTriangleStart
  const wallCoverage = wallStart !== undefined ? new Uint8Array(width * height) : undefined
  // The model-only height for the cells a wall also covers. `-Infinity` is the
  // no-model value; a wall-only cell starts there and stays there.
  const modelOnly = wallStart !== undefined ? new Float32Array(width * height).fill(-Infinity) : undefined

  const minRow = Math.max(0, options?.window?.minRow ?? 0)
  const maxRow = Math.min(height - 1, options?.window?.maxRow ?? height - 1)
  const minCol = Math.max(0, options?.window?.minCol ?? 0)
  const maxCol = Math.min(width - 1, options?.window?.maxCol ?? width - 1)
  const triangles = options?.triangles
  const triangleCount = triangles ? triangles.length : Math.floor(index.length / 3)
  if (minRow > maxRow || minCol > maxCol) {
    return {
      data, width, height, originX: bbox.minX, originY: bbox.minY, cellSize,
      ...(wallCoverage !== undefined ? { wallCoverage } : null),
      ...(modelOnly !== undefined ? { modelOnly } : null),
    }
  }

  const wallStartIndex = wallStart !== undefined ? wallStart * 3 : Infinity
  const peakThreshold = thinFeaturePeakThreshold(cellSize)
  // #1050 slice C: a no-centre triangle is collected with its global maximum
  // and the cell box it overlaps. Once every centre sample is in place, a
  // precomputed 3x3 neighbourhood-max map lets the clip pass reject it with one
  // comparison per overlapped cell, so only the handful of genuine local peaks
  // is ever projected and clipped. The cheap rejection is what keeps a fine
  // smooth mesh near the centre-sampled raster's cost.
  let peakLimit: Float32Array | undefined
  let modelPeakLimit: Float32Array | undefined
  let candidates: Int32Array | undefined
  let candidateMax: Float64Array | undefined
  let candidateCell: Int32Array | undefined
  let candidateBBox: Int32Array | undefined
  let candidateCount = 0
  for (let t = 0; t < triangleCount; t++) {
    const i = triangles ? triangles[t] : t * 3
    const coverageBit: CoverageBit = i >= wallStartIndex ? 2 : 1
    const i0 = index[i] * 3
    const i1 = index[i + 1] * 3
    const i2 = index[i + 2] * 3

    const v0x = positions[i0],     v0y = positions[i0 + 1], v0z = positions[i0 + 2]
    const v1x = positions[i1],     v1y = positions[i1 + 1], v1z = positions[i1 + 2]
    const v2x = positions[i2],     v2y = positions[i2 + 1], v2z = positions[i2 + 2]

    const tMinX = Math.min(v0x, v1x, v2x)
    const tMaxX = Math.max(v0x, v1x, v2x)
    const tMinY = Math.min(v0y, v1y, v2y)
    const tMaxY = Math.max(v0y, v1y, v2y)

    const fullColStart = Math.max(0, Math.floor((tMinX - bbox.minX) / cellSize))
    const fullColEnd   = Math.min(width - 1, Math.floor((tMaxX - bbox.minX) / cellSize))
    const fullRowStart = Math.max(0, Math.floor((tMinY - bbox.minY) / cellSize))
    const fullRowEnd   = Math.min(height - 1, Math.floor((tMaxY - bbox.minY) / cellSize))
    const colStart = Math.max(minCol, fullColStart)
    const colEnd   = Math.min(maxCol, fullColEnd)
    const rowStart = Math.max(minRow, fullRowStart)
    const rowEnd   = Math.min(maxRow, fullRowEnd)
    if (colStart > colEnd || rowStart > rowEnd) continue

    const e0x = v1x - v0x, e0y = v1y - v0y
    const e1x = v2x - v0x, e1y = v2y - v0y
    const denom = e0x * e1y - e0y * e1x
    if (Math.abs(denom) < 1e-15) continue
    let triangleRise = 0
    if (options?.trackCellRise) {
      const dz0 = v1z - v0z
      const dz1 = v2z - v0z
      const dzdx = (dz0 * e1y - dz1 * e0y) / denom
      const dzdy = (dz1 * e0x - dz0 * e1x) / denom
      const rise = (Math.abs(dzdx) + Math.abs(dzdy)) * cellSize / 2
      if (Number.isFinite(rise)) triangleRise = rise
    }
    let touched = false
    for (let row = rowStart; row <= rowEnd; row++) {
      for (let col = colStart; col <= colEnd; col++) {
        const cx = bbox.minX + (col + 0.5) * cellSize
        const cy = bbox.minY + (row + 0.5) * cellSize

        const px = cx - v0x, py = cy - v0y
        const u = (px * e1y - py * e1x) / denom
        const v = (py * e0x - px * e0y) / denom
        if (u < 0 || v < 0 || u + v > 1) continue

        const w = 1 - u - v
        const z = w * v0z + u * v1z + v * v2z
        const idx = row * width + col
        if (wallCoverage !== undefined && modelOnly !== undefined) {
          const coverage = wallCoverage[idx]
          if (coverageBit === 2) {
            if ((coverage & 2) === 0) modelOnly[idx] = data[idx]
            wallCoverage[idx] = coverage | 2
          } else {
            if ((coverage & 2) !== 0 && z > modelOnly[idx]) modelOnly[idx] = z
            wallCoverage[idx] |= 1
          }
        }
        if (z > data[idx]) data[idx] = z
        touched = true
      }
    }
    if (touched) {
      // Only a centre-sampled triangle can under-read the surface between its
      // centre and the cell edge. A no-centre triangle contributes the exact
      // maximum inside the cell, so it needs no rise allowance and must not
      // inflate the one scalar the around sampler adds to every sample.
      if (triangleRise > cellRise) cellRise = triangleRise
      continue
    }
    // A triangle that covers no cell centre contributes nothing to the
    // centre-sampled map, which is how a fin narrower than a cell used to
    // vanish. Before treating it as a clip candidate, decide whether it covers
    // a centre *outside* this window: a full map would then have sampled it
    // normally and must not also clip, so a windowed map has to agree with the
    // full one (the strip-culling sampler relies on that).
    let centreOutsideWindow = false
    if (fullColStart < colStart || fullColEnd > colEnd || fullRowStart < rowStart || fullRowEnd > rowEnd) {
      for (let row = fullRowStart; row <= fullRowEnd && !centreOutsideWindow; row++) {
        const rowInWindow = row >= rowStart && row <= rowEnd
        for (let col = fullColStart; col <= fullColEnd; col++) {
          if (rowInWindow && col >= colStart && col <= colEnd) continue
          const cx = bbox.minX + (col + 0.5) * cellSize
          const cy = bbox.minY + (row + 0.5) * cellSize
          const px = cx - v0x, py = cy - v0y
          const u = (px * e1y - py * e1x) / denom
          const v = (py * e0x - px * e0y) / denom
          if (u >= 0 && v >= 0 && u + v <= 1) {
            centreOutsideWindow = true
            break
          }
        }
      }
    }
    if (centreOutsideWindow) continue
    if (candidates === undefined) {
      const scratch = candidateWorkspace(triangleCount)
      candidates = scratch.triangles
      candidateMax = scratch.maxZ
      candidateCell = scratch.cells
      candidateBBox = scratch.boxes
    }
    const tris = candidates!
    const maxes = candidateMax!
    const cells = candidateCell!
    const boxes = candidateBBox!
    const k = candidateCount++
    tris[k] = i
    const triangleMaxZ = v0z > v1z ? (v0z > v2z ? v0z : v2z) : (v1z > v2z ? v1z : v2z)
    const singleCell = colStart === colEnd && rowStart === rowEnd
      && tMinX >= bbox.minX + colStart * cellSize
      && tMaxX <= bbox.minX + (colStart + 1) * cellSize
      && tMinY >= bbox.minY + rowStart * cellSize
      && tMaxY <= bbox.minY + (rowStart + 1) * cellSize
    maxes[k] = triangleMaxZ
    cells[k] = singleCell ? rowStart * width + colStart : -1
    const b = k * 4
    boxes[b] = colStart
    boxes[b + 1] = colEnd
    boxes[b + 2] = rowStart
    boxes[b + 3] = rowEnd
  }

  // Clip pass, #1050 slice C: a no-centre triangle can only raise a cell its
  // clipped maximum stands above by more than the threshold. The global maximum
  // of the triangle is an upper bound for every clipped maximum, so one
  // comparison per overlapped cell rejects almost every candidate on a fine
  // smooth mesh; only a survivor is projected and clipped exactly.
  //
  // The neighbourhood-max map is computed once from the centre-sampled map,
  // before any clipped contribution, so the order candidates are visited in
  // cannot change the result. Two maps only when the caller marks retained
  // walls (#1095 slice D): a model triangle is judged against the model surface,
  // a wall triangle against the cell's full top.
  const tris = candidates
  const maxes = candidateMax
  const cells = candidateCell
  const boxes = candidateBBox
  if (tris !== undefined && maxes !== undefined && cells !== undefined && boxes !== undefined) {
    peakLimit = buildPeakLimitMap(data, width, height, minRow, maxRow, minCol, maxCol,
      wallCoverage !== undefined ? 2 : 1, wallCoverage, modelOnly)
    if (wallCoverage !== undefined) {
      modelPeakLimit = buildPeakLimitMap(data, width, height, minRow, maxRow, minCol, maxCol,
        1, wallCoverage, modelOnly)
    }
    const raiseCell = (idx: number, z: number, coverageBit: CoverageBit): void => {
      if (wallCoverage !== undefined && modelOnly !== undefined) {
        const coverage = wallCoverage[idx]
        if (coverageBit === 2) {
          // A clipped wall contribution never changes the model-only height: the
          // centre samples already recorded it, and `data` may hold an earlier
          // clipped raise (issue #1095 slice D).
          wallCoverage[idx] = coverage | 2
        } else {
          if ((coverage & 2) !== 0 && z > modelOnly[idx]) modelOnly[idx] = z
          wallCoverage[idx] |= 1
        }
      }
      if (z > data[idx]) data[idx] = z
    }
    for (let k = 0; k < candidateCount; k++) {
      const i = tris[k]
      const coverageBit: CoverageBit = i >= wallStartIndex ? 2 : 1
      const limit = coverageBit === 1 && modelPeakLimit !== undefined ? modelPeakLimit : peakLimit
      const z = maxes[k]
      const cell = cells[k]
      if (cell >= 0) {
        // The whole triangle lies in one cell, so its clipped maximum is its
        // global maximum and most fine-mesh triangles take this path.
        if (z > limit[cell] + peakThreshold) raiseCell(cell, z, coverageBit)
        continue
      }
      const b = k * 4
      const colStart = boxes[b]
      const colEnd = boxes[b + 1]
      const rowStart = boxes[b + 2]
      const rowEnd = boxes[b + 3]
      // The global maximum is an upper bound for every clipped maximum. One
      // comparison per overlapped cell rejects the smooth-surface candidates
      // before any projection is paid for.
      let possible = false
      for (let row = rowStart; row <= rowEnd && !possible; row++) {
        for (let col = colStart; col <= colEnd; col++) {
          if (z > limit[row * width + col] + peakThreshold) {
            possible = true
            break
          }
        }
      }
      if (!possible) continue
      const i0 = index[i] * 3
      const i1 = index[i + 1] * 3
      const i2 = index[i + 2] * 3
      const v0x = positions[i0], v0y = positions[i0 + 1], v0z = positions[i0 + 2]
      const v1x = positions[i1], v1y = positions[i1 + 1], v1z = positions[i1 + 2]
      const v2x = positions[i2], v2y = positions[i2 + 1], v2z = positions[i2 + 2]
      const e0x = v1x - v0x, e0y = v1y - v0y
      const e1x = v2x - v0x, e1y = v2y - v0y
      if (Math.abs(e0x * e1y - e0y * e1x) < 1e-15) continue
      for (let row = rowStart; row <= rowEnd; row++) {
        for (let col = colStart; col <= colEnd; col++) {
          const idx = row * width + col
          if (!(z > limit[idx] + peakThreshold)) continue
          const cellMinX = bbox.minX + col * cellSize
          const cellMinY = bbox.minY + row * cellSize
          const exact = triangleMaxZInCell(v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z,
            cellMinX, cellMinY, cellMinX + cellSize, cellMinY + cellSize)
          if (exact === Number.NEGATIVE_INFINITY) continue
          if (!(exact > limit[idx] + peakThreshold)) continue
          raiseCell(idx, exact, coverageBit)
        }
      }
    }
  }
  return {
    data, width, height, originX: bbox.minX, originY: bbox.minY, cellSize,
    ...(options?.trackCellRise ? { cellRise } : null),
    ...(wallCoverage !== undefined ? { wallCoverage } : null),
    ...(modelOnly !== undefined ? { modelOnly } : null),
  }
}

function heightMapCacheKey(
  bbox: { minX: number; maxX: number; minY: number; maxY: number },
  cellSize: number,
): string {
  return [
    bbox.minX,
    bbox.maxX,
    bbox.minY,
    bbox.maxY,
    cellSize,
  ].map((value) => value.toFixed(6)).join('|')
}

export function getCachedHeightMap(
  host: FinishSurfaceParallelCacheHost,
  positions: Float32Array,
  index: Uint32Array,
  bbox: { minX: number; maxX: number; minY: number; maxY: number },
  cellSize: number,
): HeightMap {
  const key = heightMapCacheKey(bbox, cellSize)
  const cached = host.finishHeightMapCache?.get(key)
  if (cached) return cached

  const heightMap = buildHeightMap(positions, index, bbox, cellSize)
  if (!host.finishHeightMapCache) {
    host.finishHeightMapCache = new Map()
  }
  host.finishHeightMapCache.set(key, heightMap)
  return heightMap
}

/**
 * Minimum tool-tip Z at (x, y) given the height map and tool kinematics.
 * Same logic as `applyGougeProtection` but for a single XY query. Returns
 * `-Infinity` if no model cells fall under the tool footprint (free travel).
 */
export function safeToolTipZAt(
  x: number,
  y: number,
  heightMap: HeightMap,
  tool: NormalizedTool,
  /**
   * Half the distance across one cell, when a caller reads the map as an upper
   * bound over each cell's square rather than a point sample (issue #1045 slice
   * F). Any cell whose nearest point can reach the tool is included, and the
   * tool's lift is measured from that nearest point, so the support is an
   * over-estimate of the true one.
   */
  cellPad = 0,
): number {
  const toolRadius = tool.radius
  const pad = cellPad > 0 ? cellPad : 0
  const neighbourRadius = toolRadius + pad
  const neighborCells = Math.ceil(neighbourRadius / heightMap.cellSize)
  const radiusSq = toolRadius * toolRadius
  const isBall = tool.type === 'ball_endmill'
  const vBitHalfAngleDeg = tool.type === 'v_bit' && tool.vBitAngle && tool.vBitAngle > 0
    ? tool.vBitAngle / 2
    : 0
  const cotHalfAngle = vBitHalfAngleDeg > 0
    ? 1 / Math.tan((vBitHalfAngleDeg * Math.PI) / 180)
    : 0

  const col = Math.floor((x - heightMap.originX) / heightMap.cellSize)
  const row = Math.floor((y - heightMap.originY) / heightMap.cellSize)

  let safeZ = Number.NEGATIVE_INFINITY
  const minC = Math.max(0, col - neighborCells)
  const maxC = Math.min(heightMap.width - 1, col + neighborCells)
  const minR = Math.max(0, row - neighborCells)
  const maxR = Math.min(heightMap.height - 1, row + neighborCells)

  for (let nr = minR; nr <= maxR; nr += 1) {
    for (let nc = minC; nc <= maxC; nc += 1) {
      const idx = nr * heightMap.width + nc
      let cellZ = heightMap.data[idx]
      const cx = heightMap.originX + (nc + 0.5) * heightMap.cellSize
      const cy = heightMap.originY + (nr + 0.5) * heightMap.cellSize
      const dx = cx - x
      const dy = cy - y
      const dSq = dx * dx + dy * dy
      // #1095 slice D: a retained wall is stock to keep, not a surface to
      // finish. A cell a wall covers, which the **unpadded** footprint misses,
      // is material the cutter's body only touches at the wall face -- a
      // tangency, not contact -- so it must not lift the tip to the wall's top.
      // Read the model-only height of that cell instead: the target here is the
      // model beside the wall, and a ball tangent to a wall a full radius away
      // cannot gouge it. Any real overlap puts the wall cell inside `radiusSq`
      // (the pull-in keeps every sample at or beyond one radius) and still
      // lifts, which keeps the wall safe.
      const coverage = heightMap.wallCoverage?.[idx]
      if (pad > 0 && coverage !== undefined && (coverage & 2) !== 0 && dSq > radiusSq) {
        cellZ = heightMap.modelOnly?.[idx] ?? Number.NEGATIVE_INFINITY
      }
      if (!isFinite(cellZ)) continue
      const reachSq = pad > 0 ? Math.max(0, Math.sqrt(dSq) - pad) ** 2 : dSq
      if (reachSq > radiusSq) continue
      let constrained: number
      if (isBall) {
        constrained = cellZ - toolRadius + Math.sqrt(radiusSq - reachSq)
      } else if (cotHalfAngle > 0) {
        constrained = cellZ - Math.sqrt(reachSq) * cotHalfAngle
      } else {
        constrained = cellZ
      }
      if (constrained > safeZ) safeZ = constrained
    }
  }

  return safeZ
}

/**
 * Raise each scan point to the kinematic cutter-location surface, plus the
 * operation's axial stock to leave.
 *
 * The leave belongs here and not on the raw sample this receives: gouge
 * protection raises Z to a minimum, so an offset applied beforehand would be
 * swallowed wherever that minimum binds. Before issue #712 the leave was not
 * applied at all — `finishSurfaceParallel.ts` never read
 * `stockToLeaveAxial`, so a parallel finish asked to leave stock cut the part
 * to final size, silently, while waterline and constant scallop both honoured
 * it. At a leave of zero the arithmetic below is what it always was.
 */
function applyGougeProtection(
  scanPoints: Array<{ x: number; y: number; z: number; rotX: number }>,
  heightMap: HeightMap,
  tool: NormalizedTool,
  axialLeave: number,
): void {
  const toolRadius = tool.radius
  const neighborCells = Math.ceil(toolRadius / heightMap.cellSize)
  const radiusSq = toolRadius * toolRadius
  // Kinematic constraint depends on tool geometry. For a model cell at lateral
  // distance d (d <= R) and height cellZ, the constraint on the tool-tip Z is:
  //   - Ball endmill:  sp.z >= cellZ - R + sqrt(R² - d²)   (sphere clearance)
  //   - Flat endmill:  sp.z >= cellZ                       (cylinder clearance)
  //   - V-bit (cone θ): sp.z >= cellZ - d / tan(θ/2)
  //   - Other:         fall back to flat (conservative — never gouges)
  const isBall = tool.type === 'ball_endmill'
  const vBitHalfAngleDeg = tool.type === 'v_bit' && tool.vBitAngle && tool.vBitAngle > 0
    ? tool.vBitAngle / 2
    : 0
  const cotHalfAngle = vBitHalfAngleDeg > 0
    ? 1 / Math.tan((vBitHalfAngleDeg * Math.PI) / 180)
    : 0

  for (let pi = 0; pi < scanPoints.length; pi++) {
    const sp = scanPoints[pi]
    const col = Math.floor((sp.x - heightMap.originX) / heightMap.cellSize)
    const row = Math.floor((sp.y - heightMap.originY) / heightMap.cellSize)

    let safeZ = sp.z

    const minC = Math.max(0, col - neighborCells)
    const maxC = Math.min(heightMap.width - 1, col + neighborCells)
    const minR = Math.max(0, row - neighborCells)
    const maxR = Math.min(heightMap.height - 1, row + neighborCells)

    for (let nr = minR; nr <= maxR; nr++) {
      for (let nc = minC; nc <= maxC; nc++) {
        const cellZ = heightMap.data[nr * heightMap.width + nc]
        if (!isFinite(cellZ)) continue

        const cx = heightMap.originX + (nc + 0.5) * heightMap.cellSize
        const cy = heightMap.originY + (nr + 0.5) * heightMap.cellSize

        const dx = cx - sp.x
        const dy = cy - sp.y
        const dSq = dx * dx + dy * dy
        if (dSq > radiusSq) continue

        let constrained: number
        if (isBall) {
          constrained = cellZ - toolRadius + Math.sqrt(radiusSq - dSq)
        } else if (cotHalfAngle > 0) {
          constrained = cellZ - Math.sqrt(dSq) * cotHalfAngle
        } else {
          // Flat endmill (and conservative fallback): any model material at
          // lateral distance <= R must be at or below the tool tip.
          constrained = cellZ
        }
        if (constrained > safeZ) safeZ = constrained
      }
    }

    // The leave lifts the cutter-location surface as a whole, so every point
    // rises by exactly it — matching `liftFragment`'s `surfaceZ + axialLeave`
    // in finishSurfaceConstantScallop.ts. At a leave of zero this is the
    // original assignment unchanged.
    sp.z = safeZ + axialLeave
  }
}

export function queryHeightMapTopZ(heightMap: HeightMap, x: number, y: number): number | null {
  const gridX = (x - heightMap.originX) / heightMap.cellSize - 0.5
  const gridY = (y - heightMap.originY) / heightMap.cellSize - 0.5

  const col0 = Math.floor(gridX)
  const row0 = Math.floor(gridY)
  const col1 = col0 + 1
  const row1 = row0 + 1
  const tx = gridX - col0
  const ty = gridY - row0

  const samples: Array<{ z: number; weight: number }> = []
  const pushSample = (col: number, row: number, weight: number): void => {
    if (weight <= 1e-12) return
    if (col < 0 || col >= heightMap.width || row < 0 || row >= heightMap.height) return
    const z = heightMap.data[row * heightMap.width + col]
    if (!isFinite(z)) return
    samples.push({ z, weight })
  }

  pushSample(col0, row0, (1 - tx) * (1 - ty))
  pushSample(col1, row0, tx * (1 - ty))
  pushSample(col0, row1, (1 - tx) * ty)
  pushSample(col1, row1, tx * ty)

  if (samples.length === 0) {
    const centerCol = Math.floor((x - heightMap.originX) / heightMap.cellSize)
    const centerRow = Math.floor((y - heightMap.originY) / heightMap.cellSize)
    let nearestZ: number | null = null
    let nearestDistSq = Infinity

    for (let r = Math.max(0, centerRow - 2); r <= Math.min(heightMap.height - 1, centerRow + 2); r += 1) {
      for (let c = Math.max(0, centerCol - 2); c <= Math.min(heightMap.width - 1, centerCol + 2); c += 1) {
        const z = heightMap.data[r * heightMap.width + c]
        if (!isFinite(z)) continue
        const cx = heightMap.originX + (c + 0.5) * heightMap.cellSize
        const cy = heightMap.originY + (r + 0.5) * heightMap.cellSize
        const dx = cx - x
        const dy = cy - y
        const distSq = dx * dx + dy * dy
        if (distSq < nearestDistSq) {
          nearestDistSq = distSq
          nearestZ = z
        }
      }
    }

    return nearestZ
  }

  let weightedZ = 0
  let totalWeight = 0
  for (const sample of samples) {
    weightedZ += sample.z * sample.weight
    totalWeight += sample.weight
  }
  return totalWeight > 1e-12 ? weightedZ / totalWeight : null
}

function buildTopSurfaceSegment(
  x1: number,
  x2: number,
  rotY: number,
  cosPos: number,
  sinPos: number,
  heightMap: HeightMap,
  sampleDistance: number,
): Array<{ x: number; y: number; z: number; rotX: number }> {
  const length = Math.abs(x2 - x1)
  const sampleCount = Math.max(1, Math.ceil(length / sampleDistance))
  const points: Array<{ x: number; y: number; z: number; rotX: number }> = []

  for (let index = 0; index <= sampleCount; index += 1) {
    const t = index / sampleCount
    const rotX = x1 + (x2 - x1) * t
    const point = rotatePoint({ x: rotX, y: rotY }, cosPos, sinPos)
    const topZ = queryHeightMapTopZ(heightMap, point.x, point.y)
    if (topZ === null) continue

    points.push({
      x: point.x,
      y: point.y,
      z: topZ,
      rotX,
    })
  }

  return points
}

function modelSilhouetteContours(modelFeature: SketchFeature): CoverageContours {
  if (modelFeature.kind === 'stl' && modelFeature.stl?.silhouettePaths?.length) {
    return significantSilhouettePaths(modelFeature.stl.silhouettePaths)
      .map((path) => path.map((point) => [point.x, point.y]))
  }

  const flattened = flattenProfile(modelFeature.sketch.profile)
  return flattened.points.length >= 3
    ? [flattened.points.map((point) => [point.x, point.y])]
    : []
}

function coverageContoursToClipperPaths(contours: CoverageContours): ClipperPath[] {
  return contours
    .filter((contour) => contour.length >= 3)
    .map((contour) => toClipperPath(
      normalizeWinding(contour.map(([x, y]) => ({ x, y })), false),
      DEFAULT_CLIPPER_SCALE,
    ))
}

export function modelSilhouettePathsForFinishSurface(modelFeature: SketchFeature): ClipperPath[] {
  return unionClipperPaths(coverageContoursToClipperPaths(modelSilhouetteContours(modelFeature)))
}

/**
 * The outline a finish covers (issue #934): one target's silhouette as it
 * always was, or several joined so the pass covers each place once.
 */
function targetSilhouetteContours(modelFeatures: SketchFeature[]): CoverageContours {
  if (modelFeatures.length === 1) return modelSilhouetteContours(modelFeatures[0])
  return clipperPathsToTupleContours(unionClipperPaths(
    modelFeatures.flatMap((feature) => coverageContoursToClipperPaths(modelSilhouetteContours(feature))),
  ))
}

function subtractProtectedContours(contours: CoverageContours, protectedPaths: ClipperPath[]): CoverageContours {
  if (contours.length === 0 || protectedPaths.length === 0) return contours
  const clipped = differenceClipperPaths(
    unionClipperPaths(coverageContoursToClipperPaths(contours)),
    protectedPaths,
  )
  return clipperPathsToTupleContours(clipped)
}

export function generateFinishSurfaceParallel(
  project: Project,
  operation: Operation,
  modelFeatures: SketchFeature[],
  regionFeatures: SketchFeature[],
  tool: NormalizedTool,
  surface: FinishModelSurface,
  safeZ: number,
  minCutZAtPoint: (point: Point) => number,
  hasMachinableSurface: (point: Point, liftedSurfaceZ: number) => boolean,
  warnings: ToolpathWarning[],
  retainedCheck: RetainedMaterialCheck | null = null,
): { moves: ToolpathMove[]; stepLevels: Set<number> } {
  const stepoverRatio = operation.stepover ?? 0.5
  const stepoverDistance = Math.max(
    finishScallopSpacing(operation, tool) ?? stepoverRatio * tool.diameter,
    1e-3,
  )
  const angleDeg = operation.pocketAngle ?? 0
  // Issue #712: this strategy never read the field, so the value was stored,
  // shown in the panel, and silently dropped.
  const axialLeave = Math.max(0, operation.stockToLeaveAxial)

  if (operation.debugToolpath) {
    warnings.push({ code: 'debug', params: { text: `Debug: parallel mode, angle=${angleDeg}°, stepover=${stepoverDistance.toFixed(4)}` } })
  }

  // Every target model, as one surface (issue #934).
  const { positions: transformedPos, index } = surface.mesh
  const sliceIndexHost = surface.mesh as FinishSurfaceParallelCacheHost
  const modelBbox = computeXYBounds(transformedPos)
  const regionMask = buildRegionMask(regionFeatures)
  const regionBounds = regionMask && !regionMask.baseIncludesSubject
    ? computeRegionFeatureBounds(regionFeatures)
    : null
  const heightMapBbox = regionBounds
    ? clampExpandedBoundsToModel(regionBounds, modelBbox, tool.radius)
    : modelBbox
  const requestedWaterlineCellSize = Math.min(tool.radius / 3, stepoverDistance * 0.5)
  const heightMapCellSize = chooseHeightMapCellSize(heightMapBbox, requestedWaterlineCellSize, warnings)
  const heightMap = getCachedHeightMap(sliceIndexHost, transformedPos, index, heightMapBbox, heightMapCellSize)
  const slopeDomain = buildSurfaceSlopeDomain(operation, heightMap,
    (x, y) => safeToolTipZAt(x, y, heightMap, tool), warnings)
  if (slopeDomain !== null && slopeDomain.length === 0) return { moves: [], stepLevels: new Set() }
  let linkInSlopeDomain: ((from: Point, to: Point) => boolean) | null = null
  const topSurfaceSampleDistance = Math.max(heightMapCellSize, Math.min(stepoverDistance, tool.radius * 0.5))

  // Safe link check for scanline → scanline transitions. The straight 3D
  // segment from one scanline's end to the next scanline's start (already
  // gouge-protected at the endpoints) is allowed when the linearly
  // interpolated link Z stays above the kinematic safe Z along the way. The
  // common flat-pocket-floor case: surface Z = link Z everywhere, link is
  // accepted, and the tool moves straight across at constant Z instead of
  // retracting and re-plunging on every scanline.
  const linkSampleSpacing = Math.max(heightMapCellSize, tool.radius * 0.5)
  const linkCushion = Math.max(heightMapCellSize * 0.5, 1e-3)
  const safeLinkCheck = (from: ToolpathPoint, to: ToolpathPoint): boolean => {
    if (slopeDomain !== null && (!linkInSlopeDomain || !linkInSlopeDomain(from, to))) return false
    // Exact and without `linkCushion`: a link that dips half a height-map cell
    // into a pocket wall or a plate is a gouge, not sampling noise (issue #773).
    if (retainedCheck !== null && !retainedCheck.segmentIsClear(from, to)) return false
    const dx = to.x - from.x
    const dy = to.y - from.y
    const dz = to.z - from.z
    const length = Math.hypot(dx, dy)
    if (length === 0) return true
    const steps = Math.max(1, Math.ceil(length / linkSampleSpacing))
    for (let i = 1; i < steps; i += 1) {
      const t = i / steps
      const sx = from.x + dx * t
      const sy = from.y + dy * t
      const sz = from.z + dz * t
      const required = safeToolTipZAt(sx, sy, heightMap, tool)
      if (sz + linkCushion < required) return false
    }
    return true
  }
  // Allow the link to extend up to a couple of stepovers — slightly more than
  // the natural Y jump between adjacent scanlines so segments with small X
  // misalignment still link. The kinematic check above is the real guard.
  const linkMaxDistance = stepoverDistance * 2

  /**
   * The Z this strategy gives a scan point at (x, y), every clamp included:
   * what `applyGougeProtection` and `clampSurfaceSegmentToMinZ` make of a
   * sample there. A vertex the cliff refinement adds is one a scanline would
   * have placed itself (issue #938).
   */
  const scanPointZ = (x: number, y: number): number => {
    const lifted = Math.max(queryHeightMapTopZ(heightMap, x, y) ?? Number.NEGATIVE_INFINITY, safeToolTipZAt(x, y, heightMap, tool))
    if (!Number.isFinite(lifted)) return lifted
    return Math.max(lifted + axialLeave, minCutZAtPoint({ x, y }))
  }

  const angleRad = (angleDeg * Math.PI) / 180
  const cosNeg = Math.cos(-angleRad)
  const sinNeg = Math.sin(-angleRad)
  const cosPos = Math.cos(angleRad)
  const sinPos = Math.sin(angleRad)

  function emitScanlines(
    contours: CoverageContours,
    bbox: { minX: number; maxX: number; minY: number; maxY: number },
    startScanIndex: number,
    moves: ToolpathMove[],
    outStepLevels: Set<number>,
    position: ToolpathPoint | null,
  ): ToolpathPoint | null {
    const corners = [
      { x: bbox.minX, y: bbox.minY },
      { x: bbox.maxX, y: bbox.minY },
      { x: bbox.maxX, y: bbox.maxY },
      { x: bbox.minX, y: bbox.maxY },
    ].map((p) => rotatePoint(p, cosNeg, sinNeg))

    const rotMinY = Math.min(...corners.map((c) => c.y))
    const rotMaxY = Math.max(...corners.map((c) => c.y))
    const rotatedContours = contours.map((contour) => contour.map(([x, y]) => rotatePoint({ x, y }, cosNeg, sinNeg)))
    let pos = position
    // startScanIndex is preserved on the signature for API stability but no
    // longer drives an even/odd zigzag flip — phase 5 of the link-optimization
    // plan replaces that with closer-endpoint pickup per segment.
    void startScanIndex

    for (
      let rotY = rotMinY + stepoverDistance / 2;
      rotY < rotMaxY;
      rotY += stepoverDistance
    ) {
      const scanSegments: Array<Array<{ x: number; y: number; z: number; rotX: number }>> = []

      const intervals = scanlineIntervalsForContours(rotatedContours, rotY)
      for (const [x1, x2] of intervals) {
        const segment = buildTopSurfaceSegment(x1, x2, rotY, cosPos, sinPos, heightMap, topSurfaceSampleDistance)
        if (segment.length >= 2) {
          appendAll(scanSegments, splitSurfaceSegmentOnFloorChange(segment, minCutZAtPoint))
        }
      }

      if (scanSegments.length === 0) continue

      scanSegments.sort((a, b) => a[0].rotX - b[0].rotX)

      // Closer-endpoint pickup. Instead of always cutting segments in their
      // sorted-rotX order with a blanket reverse on odd scanlines, pick the
      // next segment whose nearest endpoint is closest to the current tool
      // position and reverse the segment only if its end is nearer than its
      // start. This preserves the zigzag macro-pattern (the geometric reason
      // we still chose to keep zigzag) while shortening cross-table travel
      // between segments, especially on scanlines split by protected regions.
      const remainingSegments = [...scanSegments]
      while (remainingSegments.length > 0) {
        let bestIdx = 0
        let bestReverse = false
        let bestDist = Number.POSITIVE_INFINITY
        for (let i = 0; i < remainingSegments.length; i += 1) {
          const seg = remainingSegments[i]
          const startP = seg[0]
          const endP = seg[seg.length - 1]
          const dStart = pos ? (startP.x - pos.x) ** 2 + (startP.y - pos.y) ** 2 : 0
          const dEnd = pos ? (endP.x - pos.x) ** 2 + (endP.y - pos.y) ** 2 : 0
          const local = Math.min(dStart, dEnd)
          if (local < bestDist) {
            bestDist = local
            bestIdx = i
            bestReverse = dEnd < dStart
          }
        }
        const segment = remainingSegments.splice(bestIdx, 1)[0]
        if (bestReverse) segment.reverse()

        applyGougeProtection(segment, heightMap, tool, axialLeave)

        // A scanline can now leave the surface part-way along it (issue #711),
        // so what used to be one emission is a run per machinable stretch.
        for (const machinable of splitSegmentAtUnmachinableSurface(segment, hasMachinableSurface)) {
          const clampedSegment = clampSurfaceSegmentToMinZ(machinable, minCutZAtPoint)
          const clampedPoints: ToolpathPoint[] = refineSurfacePathAtCliffs(clampedSegment.map((sp) => ({
            x: sp.x,
            y: sp.y,
            z: sp.z,
          })), scanPointZ, heightMapCellSize)
          // The mesh height map knows nothing of retained 2.5D material, so a
          // scanline runs straight over a plate or into a pocket wall; break it
          // where the cutter body would enter one (issue #773). The whole
          // segment is its own only run when nothing is violated.
          const runs = retainedCheck === null
            ? [clampedPoints]
            : retainedCheck
              .splitPolyline(clampedPoints, false, (point) => point.z, (x, y, z) => ({ x, y, z }))
              .map((run) => run.points)

          for (const cutPoints3D of runs) {
            for (const sp of cutPoints3D) {
              outStepLevels.add(sp.z)
            }
            const entryPoint = cutPoints3D[0]

            // The transition helper's same-XY shortcut bypasses its link check.
            if (pos && pos.z < safeZ && (
              (slopeDomain !== null && !safeLinkCheck(pos, entryPoint))
              || (retainedCheck !== null && !retainedCheck.segmentIsClear(pos, entryPoint))
            )) {
              pos = retractToSafe(moves, pos, safeZ)
            }
            pos = transitionToCutEntry(moves, pos, entryPoint, safeZ, linkMaxDistance, safeLinkCheck)
            appendAll(moves, toOpenCutMoves3D(cutPoints3D))
            pos = cutPoints3D[cutPoints3D.length - 1]
          }
        }
      }
    }

    return pos
  }

  const allMoves: ToolpathMove[] = []
  const allStepLevels = new Set<number>()
  const scanIndex = 0
  const baseContours = targetSilhouetteContours(modelFeatures)
  const baseCoveragePaths = unionClipperPaths(coverageContoursToClipperPaths(baseContours))
  // Tabs are NOT 2D-subtracted from coverage here — they were being subtracted
  // unconditionally, which carved a hole above every tab regardless of how far
  // below the cut surface the tab actually sat. Tab preservation is instead
  // handled per-point via minCutZAtPoint, which clamps cut Z up to tab.z_top
  // only where the surface would otherwise dip into a tab.
  // Name the clamps that actually ate into this operation, the same way the 2D
  // generators do. Avoiding a clamp without saying so leaves an unexplained bare
  // patch on the finished surface (issue #458).
  appendClampBlockedWarnings(
    warnings,
    clampsBlockingArea(project, baseCoveragePaths, { expansion: tool.radius }),
  )
  const protectedPaths = buildProtectedFootprintPaths(project, {
    targetFeatureIds: new Set(operation.target.source === 'features' ? operation.target.featureIds : []),
    featureExpansion: tool.radius + Math.max(0, operation.stockToLeaveRadial),
    clampExpansion: tool.radius,
    includeTabs: false,
    machiningEnvelopePaths: baseCoveragePaths,
  })
  const baseBounds = computeContourBounds([baseContours])
  if (!baseBounds) {
    warnings.push({ code: 'surfaceSilhouetteDegenerate' })
    return { moves: allMoves, stepLevels: allStepLevels }
  }

  // Resolve the region mask into the coverage domain before scanline
  // generation.  The coverage contours define the tool-centre area (the
  // scanline endpoints stay on the silhouette boundary, and the tool body
  // extends radius beyond), so use the centre-domain resolver: both
  // polarities dilate by centreInset.
  const centreInset = tool.radius + Math.max(0, operation.stockToLeaveRadial ?? 0)
  const coverageContours = regionMask
    ? clipperPathsToTupleContours(resolveRegionDomainCentre(baseCoveragePaths, regionMask, centreInset))
    : baseContours
  const slopeContours = slopeDomain === null ? coverageContours
    : clipperPathsToTupleContours(intersectSurfaceSlopeDomain(coverageContoursToClipperPaths(coverageContours), slopeDomain))
  if (slopeDomain !== null && slopeContours.length === 0) {
    warnings.push({ code: 'finishSlopeEmpty' })
    return { moves: allMoves, stepLevels: allStepLevels }
  }
  const clippedContours = subtractProtectedContours(slopeContours, protectedPaths)
  if (slopeDomain !== null) linkInSlopeDomain = createSurfaceDomainLinkCheck(coverageContoursToClipperPaths(clippedContours))
  const clippedBounds = computeContourBounds([clippedContours])
  if (clippedBounds) {
    emitScanlines(clippedContours, clippedBounds, scanIndex, allMoves, allStepLevels, null)
  } else if (operation.debugToolpath && regionMask && !regionMask.baseIncludesSubject) {
    warnings.push({ code: 'debug', params: { text: 'Debug: region mask does not intersect the model silhouette' } })
  } else if (operation.debugToolpath) {
    warnings.push({ code: 'debug', params: { text: 'Debug: protected footprints remove all finish surface coverage' } })
  }

  return { moves: allMoves, stepLevels: allStepLevels }
}
