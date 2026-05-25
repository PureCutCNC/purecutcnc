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

import ClipperLib from 'clipper-lib'
import type { CutDirection, Operation, Project, SketchFeature } from '../../types/project'

export interface IntersectingAddFeature {
  feature: SketchFeature
  paths: ClipperPath[]
  bottomZ: number
  topZ: number
}
import {
  DEFAULT_CLIPPER_SCALE,
  applyContourDirectionBySide,
  checkMaxCutDepthWarning,
  isClockwise,
  normalizeWinding,
  toClipperPath,
} from './geometry'
import { getMeshSliceIndex, sliceMeshAtZ } from './meshSlicing'
import {
  chooseHeightMapCellSize,
  computeXYBounds,
  getCachedHeightMap,
  safeToolTipZAt,
  type FinishSurfaceParallelCacheHost,
  type HeightMap,
} from './finishSurfaceParallel'
import {
  buildProtectedFootprintPaths,
  differenceClipperPaths,
  intersectClipperPaths,
  offsetClipperPaths,
  pathsContainEnvelope,
  pointInClipperPaths,
  unionClipperPaths,
  unionClipperPathsEvenOdd,
} from './modelProtection'
import { retractToSafe, rotateContourToNearestEntry, toClosedCutMoves, toOpenCutMoves, transitionToCutEntry } from './pocket'
import { buildRegionMask, clipToolpathResultToRegionMask } from './regions'
import type { ClipperPath, NormalizedTool, ToolpathMove, ToolpathPoint } from './types'

const MIN_Z_STEP = 0.01
const WATERLINE_PROJECTED_MAX_RINGS_PER_BAND = 96
const WATERLINE_PROJECTED_MAX_TOTAL_RINGS = 512
const WATERLINE_ADAPTIVE_Z_KEY_DECIMALS = 6
const WATERLINE_PROJECTED_MIN_BBOX_OVERLAP = 0.05
const WATERLINE_PROJECTED_PARENT_MAX_AREA_RATIO = 8

interface XYPoint {
  x: number
  y: number
}

/**
 * Inset a polygon with ROUND joins instead of the project-wide miter joins.
 * Used for tip-cap inset rings so small first-slice polygons (e.g., the nose
 * tip) don't keep getting offset into axis-aligned rectangles. Round joins
 * approximate corners with arc segments whose chord error is bounded by
 * `arcTolerance` — set tight relative to the requested inset distance so the
 * cap rings stay smooth-looking at fine scales.
 */
function offsetClipperPathsRound(paths: ClipperPath[], delta: number): ClipperPath[] {
  if (paths.length === 0) return []
  if (Math.abs(delta) <= 1e-9) return paths
  // The bundled .d.ts omits ArcTolerance on ClipperOffset; cast to set it.
  const offset = new ClipperLib.ClipperOffset() as unknown as {
    ArcTolerance: number
    AddPaths: (paths: ClipperPath[], joinType: unknown, endType: unknown) => void
    Execute: (solution: unknown, delta: number) => void
  }
  offset.ArcTolerance = Math.max(0.005 * DEFAULT_CLIPPER_SCALE, Math.abs(delta) * DEFAULT_CLIPPER_SCALE * 0.01)
  offset.AddPaths(paths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon)
  const solution = new ClipperLib.Paths()
  offset.Execute(solution, Math.round(delta * DEFAULT_CLIPPER_SCALE))
  return solution as ClipperPath[]
}

/**
 * Return a copy of `baseHeightMap` with each intersecting add's `topZ`
 * rasterised into cells whose centres lie inside the add's footprint
 * (max-take). The base heightmap is built from mesh triangles only, so
 * `safeToolTipZAt` queries near an add wall would otherwise see the head's
 * z and let the tool body gouge the add wall above the head's surface.
 *
 * The base heightmap may be cached and shared with the parallel-finish
 * pipeline; we never mutate `baseHeightMap.data` directly — we allocate a
 * fresh `Float32Array`.
 */
function heightMapWithIntersectingAddTops(
  baseHeightMap: HeightMap,
  intersectingAdds: IntersectingAddFeature[],
): HeightMap {
  const data = new Float32Array(baseHeightMap.data)
  const { width, height, originX, originY, cellSize } = baseHeightMap
  for (const add of intersectingAdds) {
    if (add.paths.length === 0) continue
    let minX = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    for (const path of add.paths) {
      for (const point of path) {
        const x = point.X / DEFAULT_CLIPPER_SCALE
        const y = point.Y / DEFAULT_CLIPPER_SCALE
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
    const colStart = Math.max(0, Math.floor((minX - originX) / cellSize))
    const colEnd = Math.min(width - 1, Math.floor((maxX - originX) / cellSize))
    const rowStart = Math.max(0, Math.floor((minY - originY) / cellSize))
    const rowEnd = Math.min(height - 1, Math.floor((maxY - originY) / cellSize))
    const topZ = add.topZ
    for (let row = rowStart; row <= rowEnd; row += 1) {
      for (let col = colStart; col <= colEnd; col += 1) {
        const cx = originX + (col + 0.5) * cellSize
        const cy = originY + (row + 0.5) * cellSize
        if (!pointInClipperPaths(add.paths, { x: cx, y: cy })) continue
        const idx = row * width + col
        if (topZ > data[idx]) data[idx] = topZ
      }
    }
  }
  return { ...baseHeightMap, data }
}

/**
 * Clip contour/polyline boundaries against `clipPaths`, preserving either the
 * parts that lie INSIDE or OUTSIDE the clip region.
 *
 * Closed subjects are fed to Clipper as open polylines with their start point
 * appended to the end. Returned paths remain open polylines unless the clipped
 * result still forms a loop, in which case `closed[i]` is true and the
 * duplicate terminal point is removed.
 */
function mergeChainedOpenPaths(paths: ClipperPath[]): ClipperPath[] {
  // Clipper's open-path difference may emit a single connected polyline as
  // multiple segments that share endpoints (typically because they branch from
  // an original polygon vertex). Stitch them back together end-to-end.
  if (paths.length <= 1) return paths.filter((p) => p.length >= 2)

  const ptsEqual = (a: ClipperPath[number], b: ClipperPath[number]) => a.X === b.X && a.Y === b.Y
  const remaining = paths.filter((p) => p.length >= 2).map((p) => [...p])
  const merged: ClipperPath[] = []
  while (remaining.length > 0) {
    let current = remaining.shift()!
    let changed = true
    while (changed) {
      changed = false
      for (let i = 0; i < remaining.length; i += 1) {
        const other = remaining[i]
        const curStart = current[0]
        const curEnd = current[current.length - 1]
        const othStart = other[0]
        const othEnd = other[other.length - 1]
        if (ptsEqual(curEnd, othStart)) {
          current = [...current, ...other.slice(1)]
        } else if (ptsEqual(curEnd, othEnd)) {
          current = [...current, ...other.slice(0, -1).reverse()]
        } else if (ptsEqual(curStart, othEnd)) {
          current = [...other, ...current.slice(1)]
        } else if (ptsEqual(curStart, othStart)) {
          current = [...other.slice().reverse(), ...current.slice(1)]
        } else {
          continue
        }
        remaining.splice(i, 1)
        changed = true
        break
      }
    }
    merged.push(current)
  }
  return merged
}

function clipContourBoundariesByRegion(
  subjectPaths: ClipperPath[],
  clipPaths: ClipperPath[],
  subjectClosed: boolean[],
  keepInside: boolean,
): { paths: ClipperPath[]; closed: boolean[] } {
  if (subjectPaths.length === 0) return { paths: [], closed: [] }
  if (clipPaths.length === 0) {
    return {
      paths: subjectPaths.map((path) => [...path]),
      closed: [...subjectClosed],
    }
  }

  const openSubjects: ClipperPath[] = []
  for (let i = 0; i < subjectPaths.length; i += 1) {
    const path = subjectPaths[i]
    if (path.length < 2) continue
    openSubjects.push(
      subjectClosed[i]
        ? [...path, { X: path[0].X, Y: path[0].Y }]
        : [...path],
    )
  }
  if (openSubjects.length === 0) return { paths: [], closed: [] }

  const clipper = new ClipperLib.Clipper()
  clipper.AddPaths(openSubjects, ClipperLib.PolyType.ptSubject, false)
  clipper.AddPaths(clipPaths, ClipperLib.PolyType.ptClip, true)
  const polytree = new ClipperLib.PolyTree()
  clipper.Execute(
    keepInside ? ClipperLib.ClipType.ctIntersection : ClipperLib.ClipType.ctDifference,
    polytree,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  )

  // OpenPathsFromPolyTree exists at runtime on the Clipper static, but is
  // missing from the bundled .d.ts. Cast to access it.
  const ClipperStatic = ClipperLib.Clipper as unknown as {
    OpenPathsFromPolyTree(tree: unknown): ClipperPath[]
  }
  const openPaths = ClipperStatic.OpenPathsFromPolyTree(polytree)
  const stitched = mergeChainedOpenPaths(openPaths)
  // After stitching, detect paths whose start and end coincide — those are
  // closed loops (contour wasn't actually cut by the clip region).
  const closed: boolean[] = stitched.map((p) => (
    p.length >= 3 && p[0].X === p[p.length - 1].X && p[0].Y === p[p.length - 1].Y
  ))
  const normalized = stitched.map((p, i) => (
    closed[i] ? p.slice(0, -1) : p
  ))
  return { paths: normalized, closed }
}

function clipContourBoundariesToRegion(
  closedContourPaths: ClipperPath[],
  clipPaths: ClipperPath[],
): { paths: ClipperPath[]; closed: boolean[] } {
  return clipContourBoundariesByRegion(
    closedContourPaths,
    clipPaths,
    closedContourPaths.map(() => true),
    true,
  )
}

function clipContourBoundariesAgainstRegion(
  subjectPaths: ClipperPath[],
  clipPaths: ClipperPath[],
  subjectClosed: boolean[] = subjectPaths.map(() => true),
): { paths: ClipperPath[]; closed: boolean[] } {
  return clipContourBoundariesByRegion(subjectPaths, clipPaths, subjectClosed, false)
}

function slicePolygonsToClipperPaths(slicePolygons: Array<Array<[number, number]>>): ClipperPath[] {
  const paths = slicePolygons
    .filter((poly) => poly.length >= 3)
    .map((poly) => toClipperPath(
      normalizeWinding(poly.map(([x, y]) => ({ x, y })), false),
      DEFAULT_CLIPPER_SCALE,
    ))
  return unionClipperPathsEvenOdd(paths)
}

function clipperPathsToPointContoursForWaterline(paths: ClipperPath[]): Array<Array<{ x: number; y: number }>> {
  return paths
    .filter((path) => path.length >= 2)
    .map((path) => path.map((point) => ({
      x: point.X / DEFAULT_CLIPPER_SCALE,
      y: point.Y / DEFAULT_CLIPPER_SCALE,
    })))
}

export function maxContourGap(pathsA: ClipperPath[], pathsB: ClipperPath[]): number {
  if (pathsA.length === 0 && pathsB.length === 0) return 0

  const clipper = new ClipperLib.Clipper()
  if (pathsA.length > 0) clipper.AddPaths(pathsA, ClipperLib.PolyType.ptSubject, true)
  if (pathsB.length > 0) clipper.AddPaths(pathsB, ClipperLib.PolyType.ptClip, true)
  const xorResult = new ClipperLib.Paths()
  clipper.Execute(
    ClipperLib.ClipType.ctXor,
    xorResult,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  )

  if (xorResult.length === 0) return 0

  let maxWidth = 0
  for (const path of xorResult as ClipperPath[]) {
    if (path.length < 3) continue
    const area = Math.abs(ClipperLib.Clipper.Area(path))
    const perimeter = ClipperLib.JS.PerimeterOfPath(path, true, 1)
    if (perimeter > 0) {
      const width = (2 * area) / perimeter / DEFAULT_CLIPPER_SCALE
      if (width > maxWidth) maxWidth = width
    }
  }

  return maxWidth
}

interface WaterlineLevel {
  z: number
  contourPaths: ClipperPath[]
  projectZAtPoint?: (point: { x: number; y: number }) => number
  source?: string
}

interface WaterlineLevelBuild {
  levels: WaterlineLevel[]
  sliceMaterialByZ: Map<number, ClipperPath[]>
}

interface WaterlineRefinementMetrics {
  insertedLevels: number
  maxObservedGap: number
  gapThreshold: number
  minZStep: number
  hitCap: boolean
  hitPassLimit: boolean
}

interface WaterlineSuppressedPath {
  z: number
  path: ClipperPath
}

function waterlineZKey(z: number): string {
  return z.toFixed(WATERLINE_ADAPTIVE_Z_KEY_DECIMALS)
}

function uniqueDescendingZLevels(zLevels: number[]): number[] {
  const unique = new Map<string, number>()
  for (const z of zLevels) {
    unique.set(waterlineZKey(z), z)
  }
  return [...unique.values()].sort((a, b) => b - a)
}

function buildWaterlineLevels(
  zLevels: number[],
  sliceAtZ: (z: number) => ClipperPath[],
  toolOffset: number,
): WaterlineLevelBuild {
  const levels: WaterlineLevel[] = []
  const sliceMaterialByZ = new Map<number, ClipperPath[]>()
  let shadow: ClipperPath[] = []

  for (const z of uniqueDescendingZLevels(zLevels)) {
    const slice = sliceAtZ(z)
    if (slice.length > 0) {
      shadow = shadow.length === 0
        ? slice
        : unionClipperPaths([...shadow, ...slice])
    }
    sliceMaterialByZ.set(z, slice)
    const contourPaths = shadow.length > 0 ? offsetClipperPaths(shadow, toolOffset) : []
    levels.push({ z, contourPaths })
  }

  return { levels, sliceMaterialByZ }
}

function pointToSegmentDistance(
  point: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const vx = b.x - a.x
  const vy = b.y - a.y
  const wx = point.x - a.x
  const wy = point.y - a.y
  const lenSq = vx * vx + vy * vy
  if (lenSq <= 1e-18) return Math.hypot(point.x - a.x, point.y - a.y)
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / lenSq))
  return Math.hypot(point.x - (a.x + vx * t), point.y - (a.y + vy * t))
}

function distanceToClipperPathBoundary(path: ClipperPath, point: { x: number; y: number }): number {
  if (path.length === 0) return Number.POSITIVE_INFINITY
  let minDistance = Number.POSITIVE_INFINITY
  for (let i = 0; i < path.length; i += 1) {
    const current = path[i]
    const next = path[(i + 1) % path.length]
    const distance = pointToSegmentDistance(
      point,
      { x: current.X / DEFAULT_CLIPPER_SCALE, y: current.Y / DEFAULT_CLIPPER_SCALE },
      { x: next.X / DEFAULT_CLIPPER_SCALE, y: next.Y / DEFAULT_CLIPPER_SCALE },
    )
    if (distance < minDistance) minDistance = distance
  }
  return minDistance
}

function distanceToClipperPathsBoundary(paths: ClipperPath[], point: { x: number; y: number }): number {
  let minDistance = Number.POSITIVE_INFINITY
  for (const path of paths) {
    const distance = distanceToClipperPathBoundary(path, point)
    if (distance < minDistance) minDistance = distance
  }
  return minDistance
}

function projectedBandZAtPoint(
  point: { x: number; y: number },
  upper: WaterlineLevel,
  lower: WaterlineLevel,
): number {
  const distanceFromLower = distanceToClipperPathsBoundary(lower.contourPaths, point)
  const distanceFromUpper = distanceToClipperPathsBoundary(upper.contourPaths, point)
  if (!Number.isFinite(distanceFromLower) || !Number.isFinite(distanceFromUpper)) {
    return (upper.z + lower.z) / 2
  }
  const denominator = distanceFromLower + distanceFromUpper
  if (denominator <= 1e-9) return lower.z
  const t = Math.max(0, Math.min(1, distanceFromLower / denominator))
  return lower.z + (upper.z - lower.z) * t
}

function clipperPathCentroid(path: ClipperPath): { x: number; y: number } {
  let x = 0
  let y = 0
  for (const point of path) {
    x += point.X / DEFAULT_CLIPPER_SCALE
    y += point.Y / DEFAULT_CLIPPER_SCALE
  }
  const count = Math.max(1, path.length)
  return { x: x / count, y: y / count }
}

function clipperPathBounds(path: ClipperPath): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const point of path) {
    if (point.X < minX) minX = point.X
    if (point.X > maxX) maxX = point.X
    if (point.Y < minY) minY = point.Y
    if (point.Y > maxY) maxY = point.Y
  }
  return { minX, maxX, minY, maxY }
}

function bboxOverlapRatio(
  a: { minX: number; maxX: number; minY: number; maxY: number },
  b: { minX: number; maxX: number; minY: number; maxY: number },
): number {
  const ix1 = Math.max(a.minX, b.minX)
  const ix2 = Math.min(a.maxX, b.maxX)
  const iy1 = Math.max(a.minY, b.minY)
  const iy2 = Math.min(a.maxY, b.maxY)
  if (ix2 <= ix1 || iy2 <= iy1) return 0
  const inter = (ix2 - ix1) * (iy2 - iy1)
  const smaller = Math.min(
    (a.maxX - a.minX) * (a.maxY - a.minY),
    (b.maxX - b.minX) * (b.maxY - b.minY),
  )
  return smaller > 0 ? inter / smaller : 0
}

function pathsAreRelatedForProjectedBand(upperPath: ClipperPath, lowerPath: ClipperPath): boolean {
  const upperArea = ClipperLib.Clipper.Area(upperPath)
  const lowerArea = ClipperLib.Clipper.Area(lowerPath)
  if (Math.sign(upperArea) !== Math.sign(lowerArea)) return false

  const upperCentroid = clipperPathCentroid(upperPath)
  const lowerCentroid = clipperPathCentroid(lowerPath)
  if (pointInClipperPaths([lowerPath], upperCentroid)) return true
  if (pointInClipperPaths([upperPath], lowerCentroid)) return true
  return bboxOverlapRatio(
    clipperPathBounds(upperPath),
    clipperPathBounds(lowerPath),
  ) >= WATERLINE_PROJECTED_MIN_BBOX_OVERLAP
}

function matchUpperPathsToLowerPaths(upperPaths: ClipperPath[], lowerPaths: ClipperPath[]): Map<number, ClipperPath[]> {
  const matches = new Map<number, ClipperPath[]>()

  for (const upperPath of upperPaths) {
    let bestLowerIndex = -1
    let bestGap = Number.POSITIVE_INFINITY
    for (let lowerIndex = 0; lowerIndex < lowerPaths.length; lowerIndex += 1) {
      const lowerPath = lowerPaths[lowerIndex]
      if (!pathsAreRelatedForProjectedBand(upperPath, lowerPath)) continue
      const gap = maxContourGap([upperPath], [lowerPath])
      if (gap < bestGap) {
        bestGap = gap
        bestLowerIndex = lowerIndex
      }
    }
    if (bestLowerIndex < 0) continue
    const bucket = matches.get(bestLowerIndex) ?? []
    bucket.push(upperPath)
    matches.set(bestLowerIndex, bucket)
  }

  return matches
}

function upperPathHasHigherParent(path: ClipperPath, higherLevel: WaterlineLevel | undefined): boolean {
  if (!higherLevel) return false
  const pathArea = Math.abs(ClipperLib.Clipper.Area(path))
  for (const higherPath of higherLevel.contourPaths) {
    const higherArea = Math.abs(ClipperLib.Clipper.Area(higherPath))
    const smallerArea = Math.max(1, Math.min(pathArea, higherArea))
    const areaRatio = Math.max(pathArea, higherArea) / smallerArea
    if (areaRatio > WATERLINE_PROJECTED_PARENT_MAX_AREA_RATIO) continue
    if (pathsAreRelatedForProjectedBand(higherPath, path)) return true
  }
  return false
}

function generateProjectedWaterlineLevels(
  coarseBuild: WaterlineLevelBuild,
  stepoverDistance: number,
  surfaceZAt: ((point: { x: number; y: number }) => number | null) | null,
  intersectingAdds: IntersectingAddFeature[],
  toolOffset: number,
): WaterlineLevelBuild & { metrics: WaterlineRefinementMetrics; suppressedCoarsePaths: WaterlineSuppressedPath[] } {
  // Active intersecting-add footprints expanded by toolOffset, so projected
  // band/cap rings can be subtracted away from areas occupied by add features
  // (e.g., the wedge that crosses the model in old-man-in-box.camj). The
  // coarse waterline already merges the mesh slice with the add footprints
  // via sliceAtZ, so coarse rings correctly trace around them. The projected
  // bands and caps are built from a MESH-ONLY shadow on purpose — that
  // keeps the band fills focused on the imported mesh surface and prevents
  // them from generating add-wall corner caps — but it means the mesh-only
  // rings happily cut through anywhere the wedge sits on top of the mesh.
  // Subtracting the toolOffset-expanded add footprints stops the rings at
  // the wedge wall. Z-aware: only adds whose [bottomZ, topZ] contains the
  // ring's z contribute. We skip adds with zero footprint defensively.
  const expandedAddFootprintAtZ = (z: number): ClipperPath[] => {
    if (intersectingAdds.length === 0) return []
    const active = intersectingAdds
      .filter((add) => z >= add.bottomZ - 1e-9 && z <= add.topZ + 1e-9)
      .flatMap((add) => add.paths)
    if (active.length === 0) return []
    return offsetClipperPaths(unionClipperPaths(active), toolOffset)
  }
  const clipRingsAgainstAdds = (paths: ClipperPath[], z: number): ClipperPath[] => {
    const expanded = expandedAddFootprintAtZ(z)
    if (expanded.length === 0) return paths
    return differenceClipperPaths(paths, expanded)
  }
  const gapThreshold = Math.max(stepoverDistance, MIN_Z_STEP)
  const levels: WaterlineLevel[] = coarseBuild.levels.map((level) => ({
    ...level,
    contourPaths: [...level.contourPaths],
  }))
  let insertedLevels = 0
  let maxObservedGap = 0
  let hitCap = false
  const emitLevel = (level: WaterlineLevel): boolean => {
    if (insertedLevels >= WATERLINE_PROJECTED_MAX_TOTAL_RINGS) {
      hitCap = true
      return false
    }
    levels.push(level)
    insertedLevels += level.contourPaths.length
    return true
  }
  const suppressCoarsePath = (levelIndex: number, pathToSuppress: ClipperPath): void => {
    const level = levels[levelIndex]
    if (!level) return
    level.contourPaths = level.contourPaths.filter((path) => path !== pathToSuppress)
  }
  const forcedLocalTopPaths = new Set<ClipperPath>()
  const suppressedCoarsePaths: WaterlineSuppressedPath[] = []
  // Each tip path is processed exactly once — either at the iteration where
  // its level is the upper (no-higher-parent case, includes the topmost level)
  // or at the next iteration after being added to forcedLocalTopPaths (newly
  // emerged island found as an unmatched lower in the previous pair).
  const processedTipPaths = new Set<ClipperPath>()

  const processTipPath = (
    levelIndex: number,
    tipPath: ClipperPath,
    tipZ: number,
    peakZ: number,
  ): boolean => {
    if (processedTipPaths.has(tipPath)) return true
    processedTipPaths.add(tipPath)
    // Suppress the boxy first-slice coarse ring at this z — the inset rings
    // below will replace it and the ball nose rounds whatever crown remains
    // after the offsets collapse.
    suppressCoarsePath(levelIndex, tipPath)
    suppressedCoarsePaths.push({ z: tipZ, path: tipPath })

    // First sweep: collect the inward offsets and remember the deepest
    // inset that still produced geometry. That distance approximates the
    // tip's inradius and serves as the "fully collapsed → at the peak"
    // reference for Z projection.
    const tipRings: Array<{ paths: ClipperPath[]; distance: number }> = []
    let maxInsetDistance = 0
    for (let step = 1; step <= WATERLINE_PROJECTED_MAX_RINGS_PER_BAND; step += 1) {
      const distance = step * stepoverDistance
      // Round joins for tip insets so small first-slice polygons don't keep
      // producing axis-aligned rectangles. The first-slice shape itself is
      // miter-derived upstream — we can't undo that here without re-slicing,
      // but each successive inset under round joins replaces the corners
      // with arc segments and the visible squareness fades quickly.
      const tipInwardRaw = offsetClipperPathsRound([tipPath], -distance)
      if (tipInwardRaw.length === 0) break
      // Subtract intersecting-add footprints expanded by toolOffset so the
      // cap rings don't cut through a wedge / cover / etc. that sits over
      // the mesh tip at this z. Z reference is tipZ since tip caps live in
      // the tipZ→peakZ band, and the add features in old-man-in-box span
      // the whole model range — z-aware filtering still works for adds
      // with limited z range.
      const tipInward = clipRingsAgainstAdds(tipInwardRaw, tipZ)
      if (tipInward.length === 0) break
      tipRings.push({ paths: tipInward, distance })
      maxInsetDistance = distance
    }
    if (tipRings.length === 0) return true

    // Per-point Z. First choice is to sample the actual mesh surface via
    // the heightmap — that follows the real shape of the island so the
    // rings climb the flank exactly. Fall back to a linear ramp from tipZ
    // at the boundary to peakZ at the deepest inset if the heightmap can't
    // resolve the point (off-mesh sample, etc.) or wasn't provided.
    const zSpan = peakZ - tipZ
    const denom = Math.max(maxInsetDistance, MIN_Z_STEP)
    const linearProjection = (point: { x: number; y: number }): number => {
      if (zSpan === 0) return tipZ
      const d = distanceToClipperPathBoundary(tipPath, point)
      return tipZ + Math.min(1, d / denom) * zSpan
    }
    const projectZAtPoint = (point: { x: number; y: number }): number => {
      const sampled = surfaceZAt ? surfaceZAt(point) : null
      if (sampled === null) return linearProjection(point)
      // Clamp into [tipZ, peakZ] so a noisy heightmap sample on the steep
      // flank can't drive the cut above the next-coarse-level rim (which
      // would already have been finished by the coarse waterline pass) or
      // below the tip's own first-slice z (which is the floor for this
      // island cap).
      const upper = peakZ >= tipZ ? peakZ : tipZ
      const lower = peakZ >= tipZ ? tipZ : peakZ
      return Math.min(upper, Math.max(lower, sampled))
    }

    // Emit one level per ring so each concentric ring carries its own
    // representative z. Clustering by bbox IoU keeps them in a single
    // column and the column walker descends them top-down.
    for (const { paths, distance } of tipRings) {
      // Representative z for clustering — use the linear estimate so the
      // sort still gives top-down ring order even when the heightmap-driven
      // per-vertex projection produces non-monotonic z within a single
      // ring (e.g., the ring crosses a saddle).
      const ringZ = zSpan === 0
        ? tipZ
        : tipZ + Math.min(1, distance / denom) * zSpan
      if (!emitLevel({
        z: ringZ,
        contourPaths: paths,
        projectZAtPoint,
        source: 'projectedCap',
      })) return false
    }
    return true
  }

  for (let i = 0; i + 1 < coarseBuild.levels.length && !hitCap; i += 1) {
    const upper = coarseBuild.levels[i]
    const lower = coarseBuild.levels[i + 1]
    const higher = coarseBuild.levels[i - 1]
    if (upper.contourPaths.length === 0 || lower.contourPaths.length === 0) continue

    const matches = matchUpperPathsToLowerPaths(upper.contourPaths, lower.contourPaths)
    const matchedLowerIndices = new Set(matches.keys())
    for (let lowerIndex = 0; lowerIndex < lower.contourPaths.length; lowerIndex += 1) {
      if (!matchedLowerIndices.has(lowerIndex)) {
        forcedLocalTopPaths.add(lower.contourPaths[lowerIndex])
      }
    }

    // Build a quick lookup so we can size-compare each upper ring against
    // its matched lower ring when deciding whether it's really an island
    // tip vs. a vertical-wall continuation.
    const upperToMatchedLower = new Map<ClipperPath, ClipperPath>()
    for (const [lowerIndex, matchedUpperPaths] of matches) {
      const matchedLower = lower.contourPaths[lowerIndex]
      for (const upperPath of matchedUpperPaths) {
        upperToMatchedLower.set(upperPath, matchedLower)
      }
    }

    // Tip processing for upper-level rings. A ring qualifies as an island
    // top when:
    //   (a) it's a CCW outer ring (positive signed area) — CW hole/pocket
    //       rims are depressions, not bumps, and must not be inset, and
    //   (b) either it was marked forced (lower had no upper match in the
    //       previous pair → island birth) or it has no analog at the
    //       higher level AND its matched lower ring is significantly
    //       larger (the island grows going down, which is what
    //       distinguishes a tip from a vertical-walled feature).
    // When it qualifies, suppress the boxy first-slice ring and emit inward
    // concentric offsets of the tip itself to collapse.
    for (const upperPath of upper.contourPaths) {
      if (hitCap) break
      if (processedTipPaths.has(upperPath)) continue
      const upperSignedArea = ClipperLib.Clipper.Area(upperPath)
      if (upperSignedArea <= 0) continue
      const matchedLowerPath = upperToMatchedLower.get(upperPath)
      const matchedLowerArea = matchedLowerPath
        ? Math.abs(ClipperLib.Clipper.Area(matchedLowerPath))
        : 0
      const isShrinkingFromLower = matchedLowerPath
        ? matchedLowerArea > upperSignedArea * 1.3
        : false
      const isLocalTop = forcedLocalTopPaths.has(upperPath)
        || (!upperPathHasHigherParent(upperPath, higher) && isShrinkingFromLower)
      if (!isLocalTop) continue
      // Peak-Z estimate: the next coarse level UP is the first z where the
      // tip had no material — the actual peak sits in (upper.z, higher.z].
      // Using higher.z as the upper bound gives the inset rings a sensible
      // ramp from tipZ at the boundary up toward the level above. When the
      // tip sits at the topmost level there's no higher level to ramp to,
      // so the inset rings stay flat at upper.z (which is already model
      // top, so there's nothing to ramp toward).
      const peakZ = higher ? higher.z : upper.z
      if (!processTipPath(i, upperPath, upper.z, peakZ)) break
    }

    for (const [lowerIndex, matchedUpperPaths] of matches) {
      if (hitCap) break
      const lowerPath = lower.contourPaths[lowerIndex]
      const gap = maxContourGap(matchedUpperPaths, [lowerPath])
      if (gap > maxObservedGap) maxObservedGap = gap
      if (gap <= gapThreshold) continue

      const bandPaths = differenceClipperPaths([lowerPath], matchedUpperPaths)
      if (bandPaths.length === 0) continue

      const localUpper: WaterlineLevel = {
        ...upper,
        contourPaths: matchedUpperPaths,
      }
      const localLower: WaterlineLevel = {
        ...lower,
        contourPaths: [lowerPath],
      }
      // Band fill: project micro-offset rings into the band between the
      // matched upper and lower contours. Tip caps are handled separately in
      // the local-top pass above, so this loop emits band rings only.
      //
      // Per-vertex Z uses the existing linear XY interpolation between
      // upper and lower contour boundaries (`projectedBandZAtPoint`). We
      // tried switching this to a heightmap-derived per-vertex Z too, but
      // bands cover most of the model surface and the heightmap's cell-size
      // quantization shows up as visible roughness across the entire face.
      // The linear ramp is visually smoother for the large band areas; the
      // tip caps still use the heightmap because their footprint is small
      // and the accuracy of following the actual surface matters most
      // there.
      for (let step = 1; step <= WATERLINE_PROJECTED_MAX_RINGS_PER_BAND; step += 1) {
        const distance = step * stepoverDistance
        const inward = offsetClipperPaths([lowerPath], -distance)
        if (inward.length === 0) break
        const z = lower.z + (upper.z - lower.z) * Math.max(0, Math.min(1, distance / gap))
        // Clip band against bandPaths AND subtract intersecting-add
        // footprints (expanded by toolOffset). Mesh-only band inputs ignore
        // the wedge/cover, so without this subtraction the band rings cut
        // through any intersecting add that sits on top of the mesh.
        const clippedToBand = clipRingsAgainstAdds(
          intersectClipperPaths(inward, bandPaths),
          z,
        )
        if (clippedToBand.length === 0) break
        const projectZAtPoint = (point: { x: number; y: number }): number => (
          projectedBandZAtPoint(point, localUpper, localLower)
        )
        if (!emitLevel({
          z,
          contourPaths: clippedToBand,
          projectZAtPoint,
          source: 'projectedBand',
        })) break
      }
    }
  }

  // Catch any local-top ring at the bottommost level that was added to
  // forcedLocalTopPaths but never had a chance to be the upper of a pair.
  if (!hitCap && coarseBuild.levels.length > 0) {
    const lastIndex = coarseBuild.levels.length - 1
    const lastLevel = coarseBuild.levels[lastIndex]
    const higherForLast = coarseBuild.levels[lastIndex - 1]
    const peakZForLast = higherForLast ? higherForLast.z : lastLevel.z
    for (const path of lastLevel.contourPaths) {
      if (hitCap) break
      if (processedTipPaths.has(path)) continue
      if (!forcedLocalTopPaths.has(path)) continue
      if (!processTipPath(lastIndex, path, lastLevel.z, peakZForLast)) break
    }
  }

  return {
    levels: levels.sort((a, b) => b.z - a.z),
    sliceMaterialByZ: coarseBuild.sliceMaterialByZ,
    metrics: {
      insertedLevels,
      maxObservedGap,
      gapThreshold,
      minZStep: stepoverDistance,
      hitCap,
      hitPassLimit: false,
    },
    suppressedCoarsePaths,
  }
}

function suppressProjectedCoarsePaths(
  coarseLevels: WaterlineLevel[],
  suppressedPaths: WaterlineSuppressedPath[],
  tolerance: number,
): WaterlineLevel[] {
  if (suppressedPaths.length === 0) return coarseLevels
  return coarseLevels.map((level) => ({
    ...level,
    contourPaths: level.contourPaths.filter((path) => !suppressedPaths.some((suppressed) => (
      Math.abs(suppressed.z - level.z) <= MIN_Z_STEP
      && maxContourGap([path], [suppressed.path]) <= tolerance
    ))),
  }))
}

function pointDistance3D(a: ToolpathPoint, b: ToolpathPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function trimOpenContourCaps(
  paths: ClipperPath[],
  closed: boolean[],
  maxCapLength: number,
): { paths: ClipperPath[]; closed: boolean[] } {
  if (paths.length === 0) return { paths, closed }
  const maxCapLengthScaled = maxCapLength * DEFAULT_CLIPPER_SCALE
  const trimStartByDistance = (path: ClipperPath): ClipperPath => {
    if (path.length <= 2 || maxCapLengthScaled <= 0) return path
    let remaining = maxCapLengthScaled
    let startIndex = 0
    while (startIndex + 1 < path.length && remaining > 0) {
      const from = path[startIndex]
      const to = path[startIndex + 1]
      const length = Math.hypot(to.X - from.X, to.Y - from.Y)
      if (length > remaining) {
        const t = remaining / Math.max(length, 1e-9)
        return [
          {
            X: Math.round(from.X + (to.X - from.X) * t),
            Y: Math.round(from.Y + (to.Y - from.Y) * t),
          },
          ...path.slice(startIndex + 1),
        ]
      }
      remaining -= length
      startIndex += 1
    }
    return path.slice(Math.min(startIndex, path.length - 2))
  }
  const trimEndByDistance = (path: ClipperPath): ClipperPath => {
    if (path.length <= 2 || maxCapLengthScaled <= 0) return path
    const reversed = [...path].reverse()
    return trimStartByDistance(reversed).reverse()
  }
  const trimmedPaths: ClipperPath[] = []
  const trimmedClosed: boolean[] = []

  for (let i = 0; i < paths.length; i += 1) {
    let path = [...paths[i]]
    const isClosed = closed[i] ?? false
    if (!isClosed) {
      path = trimEndByDistance(trimStartByDistance(path))
    }
    if (path.length < 2) continue
    trimmedPaths.push(path)
    trimmedClosed.push(isClosed)
  }

  return { paths: trimmedPaths, closed: trimmedClosed }
}

function movesAreContiguous(a: ToolpathMove, b: ToolpathMove, epsilon: number): boolean {
  return pointDistance3D(a.to, b.from) <= epsilon
}

function movesAreCollinear3D(a: ToolpathMove, b: ToolpathMove, epsilon: number): boolean {
  const ax = a.to.x - a.from.x
  const ay = a.to.y - a.from.y
  const az = a.to.z - a.from.z
  const bx = b.to.x - b.from.x
  const by = b.to.y - b.from.y
  const bz = b.to.z - b.from.z

  const aLen = Math.hypot(ax, ay, az)
  const bLen = Math.hypot(bx, by, bz)
  if (aLen <= epsilon || bLen <= epsilon) return true

  const crossX = ay * bz - az * by
  const crossY = az * bx - ax * bz
  const crossZ = ax * by - ay * bx
  const crossLen = Math.hypot(crossX, crossY, crossZ)
  const normalizedCross = crossLen / (aLen * bLen)
  if (normalizedCross > 1e-4) return false

  const dot = ax * bx + ay * by + az * bz
  return dot >= -epsilon
}

function simplifyContiguousCutMoves(moves: ToolpathMove[]): ToolpathMove[] {
  if (moves.length < 2) return moves
  const epsilon = 1e-6
  const simplified: ToolpathMove[] = []

  for (const move of moves) {
    if (move.kind === 'cut' && pointDistance3D(move.from, move.to) <= epsilon) {
      continue
    }

    const last = simplified[simplified.length - 1]
    if (
      last
      && last.kind === 'cut'
      && move.kind === 'cut'
      && movesAreContiguous(last, move, epsilon)
      && movesAreCollinear3D(last, move, epsilon)
      && last.source === move.source
    ) {
      last.to = move.to
      continue
    }

    simplified.push({
      kind: move.kind,
      from: { ...move.from },
      to: { ...move.to },
      source: move.source,
    })
  }

  return simplified
}

function densifyContour(
  contour: Array<{ x: number; y: number }>,
  maxSegmentLength: number,
  closed: boolean,
): Array<{ x: number; y: number }> {
  if (contour.length < 2) return contour
  const densified: Array<{ x: number; y: number }> = []
  const segmentCount = closed ? contour.length : contour.length - 1
  for (let i = 0; i < segmentCount; i += 1) {
    const from = contour[i]
    const to = contour[(i + 1) % contour.length]
    densified.push(from)
    const length = Math.hypot(to.x - from.x, to.y - from.y)
    const steps = Math.max(1, Math.ceil(length / Math.max(maxSegmentLength, MIN_Z_STEP)))
    for (let step = 1; step < steps; step += 1) {
      const t = step / steps
      densified.push({
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
      })
    }
  }
  if (!closed) {
    densified.push(contour[contour.length - 1])
  }
  return densified
}

function contourPolylineLength(contour: Array<{ x: number; y: number }>, closed: boolean): number {
  if (contour.length < 2) return 0
  let length = 0
  const segmentCount = closed ? contour.length : contour.length - 1
  for (let i = 0; i < segmentCount; i += 1) {
    const from = contour[i]
    const to = contour[(i + 1) % contour.length]
    length += Math.hypot(to.x - from.x, to.y - from.y)
  }
  return length
}

function projectedContourStartPoint(
  contour: Array<{ x: number; y: number }>,
  zAtPoint: (point: { x: number; y: number }) => number,
): ToolpathPoint {
  const first = contour[0] ?? { x: 0, y: 0 }
  return { x: first.x, y: first.y, z: zAtPoint(first) }
}

function toProjectedCutMoves(
  contour: Array<{ x: number; y: number }>,
  closed: boolean,
  zAtPoint: (point: { x: number; y: number }) => number,
  source?: string,
): ToolpathMove[] {
  if (contour.length < 2) return []
  const sequence = closed ? [...contour, contour[0]] : contour
  const moves: ToolpathMove[] = []
  for (let i = 0; i + 1 < sequence.length; i += 1) {
    const fromPoint = sequence[i]
    const toPoint = sequence[i + 1]
    moves.push({
      kind: 'cut',
      from: { x: fromPoint.x, y: fromPoint.y, z: zAtPoint(fromPoint) },
      to: { x: toPoint.x, y: toPoint.y, z: zAtPoint(toPoint) },
      source,
    })
  }
  return moves
}

function splitContourByTargetMeshSafety(
  contour: XYPoint[],
  closed: boolean,
  zAtPoint: (point: XYPoint) => number,
  heightMap: HeightMap,
  tool: NormalizedTool,
  maxSegmentLength: number,
  meshBoundaryPaths: ClipperPath[],
  meshBoundaryDistance: number,
  meshBoundaryTolerance: number,
): Array<{ contour: XYPoint[]; closed: boolean }> {
  if (contour.length < 2) return []
  const dense = densifyContour(contour, maxSegmentLength, closed)
  if (dense.length < 2) return []

  const tolerance = Math.max(1e-5, tool.radius * 0.05)
  const isNearMeshBoundary = (point: XYPoint): boolean => {
    if (meshBoundaryPaths.length === 0) return false
    const distance = distanceToClipperPathsBoundary(meshBoundaryPaths, point)
    return Math.abs(distance - meshBoundaryDistance) <= meshBoundaryTolerance
  }
  const isSafe = (point: XYPoint): boolean => {
    const safeZ = safeToolTipZAt(point.x, point.y, heightMap, tool)
    return !Number.isFinite(safeZ) || safeZ <= zAtPoint(point) + tolerance || isNearMeshBoundary(point)
  }
  const safe = dense.map(isSafe)
  if (safe.every(Boolean)) return [{ contour, closed }]
  if (safe.every((value) => !value)) return []

  const chunks: Array<{ contour: XYPoint[]; closed: boolean }> = []
  const flush = (run: XYPoint[]): void => {
    if (run.length >= 2 && contourPolylineLength(run, false) > 1e-9) {
      chunks.push({ contour: run, closed: false })
    }
  }

  if (!closed) {
    let run: XYPoint[] = []
    for (let i = 0; i < dense.length; i += 1) {
      if (safe[i]) {
        run.push(dense[i])
      } else {
        flush(run)
        run = []
      }
    }
    flush(run)
    return chunks
  }

  const firstUnsafe = safe.findIndex((value) => !value)
  let run: XYPoint[] = []
  for (let step = 1; step <= dense.length; step += 1) {
    const idx = (firstUnsafe + step) % dense.length
    if (safe[idx]) {
      run.push(dense[idx])
    } else {
      flush(run)
      run = []
    }
  }
  flush(run)
  return chunks
}

export interface RelatedSubtractFeature {
  paths: ClipperPath[]
  bottomZ: number
  topZ: number
}

export function generateFinishSurfaceWaterline(
  project: Project,
  operation: Operation,
  regionFeatures: SketchFeature[],
  tool: NormalizedTool,
  stepLevels: number[],
  stlData: { positions: Float32Array; index: Uint32Array; sliceIndex?: unknown },
  safeZ: number,
  effectiveBottom: number,
  modelTopZ: number,
  warnings: string[],
  intersectingAdds: IntersectingAddFeature[] = [],
  modelSilhouettePaths: ClipperPath[] = [],
  relatedSubtracts: RelatedSubtractFeature[] = [],
): { moves: ToolpathMove[]; stepLevels: Set<number> } {
  const radialLeave = Math.max(0, operation.stockToLeaveRadial)
  const toolOffset = tool.radius + radialLeave
  const direction: CutDirection = operation.cutDirection ?? 'conventional'
  const stepoverRatio = operation.stepover ?? 0.5
  const stepoverDistance = Math.max(stepoverRatio * tool.diameter, MIN_Z_STEP)

  const regionMask = buildRegionMask(regionFeatures)
  const sliceIndex = getMeshSliceIndex(stlData as Parameters<typeof getMeshSliceIndex>[0])
  const sliceSampleEpsilon = Math.max(Math.abs(modelTopZ - effectiveBottom) * 1e-6, 1e-6)

  const targetFeatureIds = new Set(
    operation.target.source === 'features' ? operation.target.featureIds : [],
  )
  // Intersecting add features create vertical walls inside the model envelope.
  // Their boundaries must be finished, not protected — treat them like targets
  // for the protected-footprint builder so the contour can run along their
  // walls instead of being clipped away.
  for (const add of intersectingAdds) targetFeatureIds.add(add.feature.id)

  if (operation.debugToolpath) {
    warnings.push(
      `Debug: waterline mode, stepover=${stepoverDistance.toFixed(4)}, toolOffset=${toolOffset.toFixed(4)}`,
    )
    warnings.push(
      `Debug: intersectingAdds=${intersectingAdds.length} ` +
      `[${intersectingAdds.map((a) => `${a.feature.name}:z=${a.bottomZ.toFixed(2)}..${a.topZ.toFixed(2)}`).join(', ')}], ` +
      `relatedSubtracts=${relatedSubtracts.length} ` +
      `[${relatedSubtracts.map((s) => `z=${s.bottomZ.toFixed(2)}..${s.topZ.toFixed(2)}`).join(', ')}]`,
    )
  }

  // Mesh top extracted from the slice index domain — separate from the
  // requested step-level top, which may extend above the mesh when an
  // intersecting add feature pokes higher than the model surface.
  const meshTopZ = modelTopZ

  const sliceMeshOnlyAtZ = (z: number): ClipperPath[] => {
    // Skip the mesh slice entirely above the mesh top; the slicer would return
    // empty anyway but the clamp below would force it to the top silhouette.
    if (z > meshTopZ + sliceSampleEpsilon) return []
    // Slice biased slightly ABOVE the requested z so horizontal model floors
    // at z (bump bases, pocket rims) don't produce a degenerate empty slice.
    // The slicer skips triangles whose three vertices all sit on the plane,
    // so for a flat floor at exactly z we'd get 0 polygons — biasing up by
    // sliceSampleEpsilon catches the walls coming up from the floor instead.
    const clampedZ = z >= meshTopZ - sliceSampleEpsilon
      ? Math.max(effectiveBottom + sliceSampleEpsilon, meshTopZ - sliceSampleEpsilon)
      : Math.min(meshTopZ - sliceSampleEpsilon, Math.max(effectiveBottom + sliceSampleEpsilon, z + sliceSampleEpsilon))
    const polygons = sliceMeshAtZ(sliceIndex, clampedZ)
    return polygons.length === 0 ? [] : slicePolygonsToClipperPaths(polygons)
  }

  const sliceAtZ = (z: number): ClipperPath[] => {
    const meshPaths = sliceMeshOnlyAtZ(z)
    // Add footprints of intersecting add features that are active at z. Their
    // vertical walls live above the mesh surface and must contribute to the
    // waterline contour so the finish pass cleans the intersection walls.
    const addPaths: ClipperPath[] = []
    for (const add of intersectingAdds) {
      if (z > add.topZ + 1e-9 || z < add.bottomZ - 1e-9) continue
      addPaths.push(...add.paths)
    }
    if (addPaths.length === 0) return meshPaths
    if (meshPaths.length === 0) return unionClipperPaths(addPaths)
    return unionClipperPaths([...meshPaths, ...addPaths])
  }

  // Clip envelope for waterline contours. When an intersecting add feature
  // protrudes beyond the model footprint (e.g. a wedge attached to the model
  // side), the offset contour around the (slice ∪ add) union would otherwise
  // trace the add's outer perimeter — material the 3D operation shouldn't
  // touch. We confine all generated contours to the model silhouette expanded
  // by the tool offset, mirroring how roughing's `outline` bounds its
  // clearable region. When no intersecting adds are present, leave the
  // envelope undefined to avoid unnecessary clipping.
  const contourClipEnvelope = intersectingAdds.length > 0 && modelSilhouettePaths.length > 0
    ? offsetClipperPaths(unionClipperPaths(modelSilhouettePaths), toolOffset + 1e-3)
    : null

  // Containing subtracts define the pocket the model sits inside (e.g., the
  // stepped pocket in old-man-in-box.camj). At each waterline z, only the
  // subtracts whose [bottomZ, topZ] spans z represent open pocket — outside
  // those active footprints the stock material is still present at z, and a
  // waterline ring there would gouge straight through that material (the
  // "step missing" symptom).
  //
  // We can't test containment per individual subtract — in a stepped pocket
  // the inner step (smaller footprint) doesn't contain the model silhouette
  // by itself, and the model silhouette is the FULL XY projection across
  // the whole z range so it may extend wider than any single subtract.
  // Instead test the UNION of all related subtracts: if the union contains
  // the model silhouette, all the subtracts together describe the pocket
  // the model sits in. A small subtract carved INTO the model
  // (block-with-pocket topology) won't have its union cover the model
  // silhouette, so containingSubtracts stays empty and clipping is skipped.
  const allRelatedSubtractPaths = relatedSubtracts.length > 0
    ? unionClipperPaths(relatedSubtracts.flatMap((sub) => sub.paths))
    : []
  const subtractUnionContainsModel = modelSilhouettePaths.length > 0
    && allRelatedSubtractPaths.length > 0
    && pathsContainEnvelope(allRelatedSubtractPaths, modelSilhouettePaths)
  const containingSubtracts = subtractUnionContainsModel
    ? relatedSubtracts.filter((sub) => sub.paths.length > 0)
    : []
  const activeContainingSubtractMaskAtZ = (z: number): ClipperPath[] => {
    if (containingSubtracts.length === 0) return []
    const active = containingSubtracts
      .filter((sub) => z >= sub.bottomZ - 1e-9 && z <= sub.topZ + 1e-9)
      .flatMap((sub) => sub.paths)
    if (active.length === 0) return []
    return unionClipperPaths(active)
  }
  const machiningRegionAtZ = (z: number): ClipperPath[] | null => {
    const subtractMask = activeContainingSubtractMaskAtZ(z)
    if (subtractMask.length === 0) return null
    return contourClipEnvelope
      ? intersectClipperPaths(subtractMask, contourClipEnvelope)
      : subtractMask
  }

  const coarseLevelBuild = buildWaterlineLevels(stepLevels, sliceAtZ, toolOffset)
  const projectedInputBuild = intersectingAdds.length > 0
    ? buildWaterlineLevels(stepLevels, sliceMeshOnlyAtZ, toolOffset)
    : coarseLevelBuild

  // Build (or reuse) the mesh heightmap so tip-cap rings can sample the
  // actual surface Z instead of relying on a linear ramp between adjacent
  // coarse levels. Cell size mirrors the parallel-finish choice so a project
  // that runs both strategies pays the build cost once.
  const heightMapBbox = computeXYBounds(stlData.positions)
  const requestedCellSize = Math.min(tool.radius / 3, stepoverDistance * 0.5)
  const heightMapCellSize = chooseHeightMapCellSize(heightMapBbox, requestedCellSize, warnings)
  const baseHeightMap = getCachedHeightMap(
    stlData as FinishSurfaceParallelCacheHost,
    stlData.positions,
    stlData.index,
    heightMapBbox,
    heightMapCellSize,
  )
  // The base heightmap is built from the mesh only. For an intersecting add
  // that stands taller than the local mesh surface (e.g., the wedge in
  // old-man-in-box.camj rising to z=0.75 above the head's mesh), the raw
  // heightmap returns the head's z under the wedge — so safeToolTipZAt
  // sampling near the wedge wall sees only the head's z and the tool body
  // gouges the wedge wall. Rasterise each intersecting add's topZ into
  // cells whose centres fall inside the add's footprint (max-take) so the
  // wedge becomes a constraint in the kinematic safety scan.
  const heightMap = intersectingAdds.length > 0
    ? heightMapWithIntersectingAddTops(baseHeightMap, intersectingAdds)
    : baseHeightMap
  // Kinematic-safe tool-tip Z, NOT the geometric surface Z. For a ball-end
  // tool, the tool body would gouge any nearby surface that's higher than
  // the tool tip; safeToolTipZAt scans every cell within toolRadius and
  // returns the most-constraining tip Z (cellZ - R + sqrt(R² - d²)). Using
  // the raw geometric surface Z (queryHeightMapTopZ) would put the cut
  // below the safe tip Z on every slope — producing the chewed-up "rough"
  // surface we saw before this fix.
  const surfaceZAt = (point: { x: number; y: number }): number | null => {
    const z = safeToolTipZAt(point.x, point.y, heightMap, tool)
    return Number.isFinite(z) ? z : null
  }

  const projectedLevelBuild = regionFeatures.length === 0
    ? generateProjectedWaterlineLevels(projectedInputBuild, stepoverDistance, surfaceZAt, intersectingAdds, toolOffset)
    : null
  const coarseLevelsWithSuppressedCaps = projectedLevelBuild
    ? suppressProjectedCoarsePaths(
        coarseLevelBuild.levels,
        projectedLevelBuild.suppressedCoarsePaths,
        Math.max(MIN_Z_STEP, stepoverDistance * 0.25),
      )
    : coarseLevelBuild.levels
  const refinedLevelBuild = projectedLevelBuild
    ? {
        levels: [
          ...coarseLevelsWithSuppressedCaps,
          ...projectedLevelBuild.levels.filter((level) => level.source),
        ].sort((a, b) => b.z - a.z),
        sliceMaterialByZ: coarseLevelBuild.sliceMaterialByZ,
        metrics: projectedLevelBuild.metrics,
      }
    : {
        ...coarseLevelBuild,
        metrics: {
          insertedLevels: 0,
          maxObservedGap: 0,
          gapThreshold: Math.max(stepoverDistance, MIN_Z_STEP),
          minZStep: Math.max(MIN_Z_STEP, Math.min(operation.stepdown, tool.diameter) / 8),
          hitCap: false,
          hitPassLimit: false,
        },
      }
  const waterlineLevels = refinedLevelBuild.levels
  // Slice material at each level — kept around so we can geometrically classify
  // each ring as tool-inside (pocket cavity, centroid in empty space) vs
  // tool-outside (around a bump or outer wall, centroid in solid material).
  // This is more reliable than inferring topology from Clipper's post-clip
  // winding, which can flip during open-path difference.
  const sliceMaterialByZ = refinedLevelBuild.sliceMaterialByZ

  if (operation.debugToolpath) {
    const metrics = refinedLevelBuild.metrics
    warnings.push(
      `Debug: adaptive waterline inserted ${metrics.insertedLevels} projected rings (${coarseLevelBuild.levels.length} coarse levels → ${waterlineLevels.length} projected levels), ` +
      `maxGap=${metrics.maxObservedGap.toFixed(4)}, threshold=${metrics.gapThreshold.toFixed(4)}, stepover=${metrics.minZStep.toFixed(4)}`,
    )
    if (regionFeatures.length > 0) {
      warnings.push('Debug: adaptive waterline skipped because region-filtered waterline clipping must not emit boundary contours')
    }
    if (intersectingAdds.length > 0 && metrics.insertedLevels > 0) {
      warnings.push('Debug: adaptive waterline projected bands were generated from mesh slices only; add-wall contours remain coarse')
    }
    if (metrics.hitCap || metrics.hitPassLimit) {
      warnings.push(
        `Debug: adaptive waterline stopped before all gaps were accepted (${metrics.hitCap ? 'insert cap' : 'pass limit'})`,
      )
    }
  }

  // Flatten waterlineLevels into individual closed-ring entries. Each level may
  // carry multiple disjoint paths (outer-wall + pocket-walls + island-walls);
  // we machine each column (cluster of rings sharing an XY locus) top-to-bottom
  // so the tool finishes one feature before traveling to the next.
  interface RingEntry {
    z: number
    path: ClipperPath
    bbox: { minX: number; maxX: number; minY: number; maxY: number }
    projectZAtPoint?: (point: { x: number; y: number }) => number
    source?: string
  }
  const allRingEntries: RingEntry[] = []
  for (const level of waterlineLevels) {
    for (const path of level.contourPaths) {
      if (path.length < 3) continue
      let minX = Number.POSITIVE_INFINITY, maxX = Number.NEGATIVE_INFINITY
      let minY = Number.POSITIVE_INFINITY, maxY = Number.NEGATIVE_INFINITY
      for (const p of path) {
        if (p.X < minX) minX = p.X
        if (p.X > maxX) maxX = p.X
        if (p.Y < minY) minY = p.Y
        if (p.Y > maxY) maxY = p.Y
      }
      allRingEntries.push({
        z: level.z,
        path,
        bbox: { minX, maxX, minY, maxY },
        projectZAtPoint: level.projectZAtPoint,
        source: level.source,
      })
    }
  }

  // Cluster rings into columns by bounding-box IoU. Vertical-walled features
  // produce identical bboxes across Z (IoU=1); tapered features stay above the
  // 0.5 threshold for adjacent Z levels; an outer wall and a nested pocket
  // share no bbox area overlap proportional to their union, so they cluster
  // separately. Single-link clustering via union-find.
  const parent: number[] = allRingEntries.map((_, i) => i)
  const find = (i: number): number => {
    let root = i
    while (parent[root] !== root) root = parent[root]
    while (parent[i] !== root) {
      const next = parent[i]
      parent[i] = root
      i = next
    }
    return root
  }
  const unite = (i: number, j: number): void => {
    const ri = find(i)
    const rj = find(j)
    if (ri !== rj) parent[ri] = rj
  }
  const bboxIoU = (a: RingEntry['bbox'], b: RingEntry['bbox']): number => {
    const ix1 = Math.max(a.minX, b.minX)
    const ix2 = Math.min(a.maxX, b.maxX)
    const iy1 = Math.max(a.minY, b.minY)
    const iy2 = Math.min(a.maxY, b.maxY)
    if (ix2 <= ix1 || iy2 <= iy1) return 0
    const inter = (ix2 - ix1) * (iy2 - iy1)
    const aA = (a.maxX - a.minX) * (a.maxY - a.minY)
    const aB = (b.maxX - b.minX) * (b.maxY - b.minY)
    const denom = aA + aB - inter
    return denom > 0 ? inter / denom : 0
  }
  const CLUSTER_IOU_THRESHOLD = 0.5
  for (let i = 0; i < allRingEntries.length; i += 1) {
    for (let j = i + 1; j < allRingEntries.length; j += 1) {
      if (bboxIoU(allRingEntries[i].bbox, allRingEntries[j].bbox) >= CLUSTER_IOU_THRESHOLD) {
        unite(i, j)
      }
    }
  }
  const clusterMap = new Map<number, RingEntry[]>()
  for (let i = 0; i < allRingEntries.length; i += 1) {
    const root = find(i)
    let bucket = clusterMap.get(root)
    if (!bucket) {
      bucket = []
      clusterMap.set(root, bucket)
    }
    bucket.push(allRingEntries[i])
  }
  const clusters: RingEntry[][] = [...clusterMap.values()]
  for (const cluster of clusters) {
    cluster.sort((a, b) => b.z - a.z)
  }

  const machiningEnvelopePaths = unionClipperPaths(
    contourClipEnvelope
      ? intersectClipperPaths(
          waterlineLevels.flatMap((level) => level.contourPaths),
          contourClipEnvelope,
        )
      : waterlineLevels.flatMap((level) => level.contourPaths),
  )
  const protectedPathsByZ = new Map<string, ClipperPath[]>()
  const protectedPathsAtZ = (z: number): ClipperPath[] => {
    const key = z.toFixed(6)
    const cached = protectedPathsByZ.get(key)
    if (cached) return cached

    const paths = buildProtectedFootprintPaths(project, {
      targetFeatureIds,
      z,
      featureExpansion: toolOffset,
      tabExpansion: tool.radius,
      clampExpansion: tool.radius,
      includeTabs: false,
      machiningEnvelopePaths: machiningEnvelopePaths.length > 0 ? machiningEnvelopePaths : undefined,
    })
    protectedPathsByZ.set(key, paths)
    return paths
  }

  if (operation.debugToolpath) {
    warnings.push(
      `Debug: ${waterlineLevels.length} waterline levels → ${allRingEntries.length} rings → ${clusters.length} columns`,
    )
  }

  const allMoves: ToolpathMove[] = []
  const allStepLevels = new Set<number>()
  let currentPosition: ToolpathPoint | null = null

  const depthWarning = checkMaxCutDepthWarning(tool, Math.abs(modelTopZ - effectiveBottom))
  if (depthWarning) warnings.push(depthWarning)

  // Intersecting-add proximity test for plunge safety. Build the union of
  // all intersecting-add footprints once, then for each ring entry test
  // whether the entry XY is close enough to the wedge wall that a same-XY
  // plunge from the previous ring would sweep the tool body through the
  // wedge material. When yes, force a retract+rapid+plunge from safeZ
  // instead of the direct plunge — `transitionToCutEntry` defaults to
  // direct plunge when distance ≤ XY_ALIGN_EPS, which is what causes the
  // wedge gouge on stacked rings along the wedge wall.
  //
  // The clearance threshold is `2 * toolRadius`: at the wedge wall the
  // tool body extends laterally by toolRadius and the wedge wall sits at
  // toolOffset (= toolRadius for radialLeave=0) from the tip, so any
  // plunge whose XY is within (toolRadius + wedge_offset) of the wedge
  // footprint risks the body sweeping wedge material. Using 2*toolRadius
  // is a safe upper bound that covers the common radialLeave=0 case.
  const intersectingAddUnion = intersectingAdds.length > 0
    ? unionClipperPaths(intersectingAdds.flatMap((add) => add.paths))
    : []
  const entryIsNearIntersectingAdd = intersectingAddUnion.length > 0
    ? (point: { x: number; y: number }): boolean => (
        distanceToClipperPathsBoundary(intersectingAddUnion, point) <= toolOffset + tool.radius + 1e-6
      )
    : (_point: { x: number; y: number }): boolean => false

  const remainingClusters: RingEntry[][] = [...clusters]

  while (remainingClusters.length > 0) {
    // Pick the column whose top ring's first vertex is nearest to current
    // position. With no current position yet, the input order is kept.
    let chosenIdx = 0
    if (currentPosition) {
      let bestDistSq = Number.POSITIVE_INFINITY
      for (let ci = 0; ci < remainingClusters.length; ci += 1) {
        const top = remainingClusters[ci][0]
        const p = top.path[0]
        const x = p.X / DEFAULT_CLIPPER_SCALE
        const y = p.Y / DEFAULT_CLIPPER_SCALE
        const dx = x - currentPosition.x
        const dy = y - currentPosition.y
        const d2 = dx * dx + dy * dy
        if (d2 < bestDistSq) {
          bestDistSq = d2
          chosenIdx = ci
        }
      }
    }
    const cluster = remainingClusters.splice(chosenIdx, 1)[0]

    // Walk this column top → bottom. Each ring's start is rotated to the
    // vertex closest to the previous ring's end so the descent between Z
    // levels lands at the same XY → transitionToCutEntry emits a single
    // plunge (phase 2) instead of retract+rapid+plunge.
    for (const ringEntry of cluster) {
      const protectionQueryZ = ringEntry.z
      const protectedAtLevel = protectedPathsAtZ(protectionQueryZ)
      const envelopeClippedRaw = contourClipEnvelope
        ? clipContourBoundariesToRegion([ringEntry.path], contourClipEnvelope)
        : { paths: [ringEntry.path], closed: [true] }
      const envelopeClipped = contourClipEnvelope
        ? trimOpenContourCaps(
            envelopeClippedRaw.paths,
            envelopeClippedRaw.closed,
            ringEntry.projectZAtPoint ? Math.max(toolOffset * 2, stepoverDistance * 4) : toolOffset * 2,
          )
        : envelopeClippedRaw
      if (envelopeClipped.paths.length === 0) continue

      // Additionally clip to the containing-subtract pocket active at this
      // ring's z. For stepped-pocket setups (old-man-in-box.camj), at z
      // below a shallower subtract's floor only the deeper subtract is
      // open; the shallower step area still has stock material at z and a
      // ring there would gouge through the step.
      const activeMachiningRegion = machiningRegionAtZ(protectionQueryZ)
      const machiningClipped = activeMachiningRegion
        ? clipContourBoundariesToRegion(envelopeClipped.paths, activeMachiningRegion)
        : envelopeClipped
      if (machiningClipped.paths.length === 0) continue
      const machiningClippedTrimmed = activeMachiningRegion
        ? trimOpenContourCaps(
            machiningClipped.paths,
            machiningClipped.closed,
            ringEntry.projectZAtPoint ? Math.max(toolOffset * 2, stepoverDistance * 4) : toolOffset * 2,
          )
        : machiningClipped
      if (machiningClippedTrimmed.paths.length === 0) continue
      // Clip the contour boundary (treated as a polyline) against protected
      // regions. Where a contour passes through an add-feature / clamp / tab,
      // the resulting OPEN polyline segments break around the protected region
      // — the tool then traces each segment with a retract between them, never
      // dipping into protected material and never chord-cutting across it.
      const { paths: clippedPaths, closed: pathClosed } = protectedAtLevel.length > 0
        ? clipContourBoundariesAgainstRegion(
            machiningClippedTrimmed.paths,
            protectedAtLevel,
            machiningClippedTrimmed.closed,
          )
        : machiningClippedTrimmed

      if (clippedPaths.length === 0) continue

      const pointContours = clipperPathsToPointContoursForWaterline(clippedPaths)

      // Geometrically classify each contour as tool-inside vs tool-outside.
      // Sample a point on each contour and offset it slightly toward the
      // ring's centroid (so we land inside the ring's enclosed area), then
      // test that point against the slice material at this Z. Inside material
      // → ring is around a bump / outer wall (tool-outside). Outside material
      // → ring is inside a pocket cavity (tool-inside). Robust to whatever
      // Clipper does to ring winding through union/offset/open-difference.
      const sliceMaterial = sliceMaterialByZ.get(ringEntry.z) ?? []
      // Source ring winding (pre-clip) — still useful as a fallback hint for
      // open polylines whose post-clip signed area is ambiguous.
      const sourceClockwise = isClockwise(
        ringEntry.path.map((p) => ({ x: p.X / DEFAULT_CLIPPER_SCALE, y: p.Y / DEFAULT_CLIPPER_SCALE })),
      )
      const naturalIsClockwise = pointContours.map(() => sourceClockwise)
      const toolInsidePerContour = pointContours.map((c) => {
        if (sliceMaterial.length === 0 || c.length < 3) return false
        // Sample a grid of points across the ring's bbox; for each one that
        // sits INSIDE the ring (even-odd test on the contour itself), check
        // whether the slice has material at that point. Majority vote.
        // Centroids alone fail for an outer wall whose pocket hole happens to
        // sit at the geometric center — the centroid lands in the hole and
        // gets misclassified as a pocket.
        let minX = Number.POSITIVE_INFINITY, maxX = Number.NEGATIVE_INFINITY
        let minY = Number.POSITIVE_INFINITY, maxY = Number.NEGATIVE_INFINITY
        for (const p of c) {
          if (p.x < minX) minX = p.x
          if (p.x > maxX) maxX = p.x
          if (p.y < minY) minY = p.y
          if (p.y > maxY) maxY = p.y
        }
        const ringPath = c.map((p) => ({
          X: Math.round(p.x * DEFAULT_CLIPPER_SCALE),
          Y: Math.round(p.y * DEFAULT_CLIPPER_SCALE),
        }))
        const samples = 7
        let inMaterial = 0
        let inRing = 0
        for (let iy = 1; iy <= samples; iy += 1) {
          const ty = iy / (samples + 1)
          const sy = minY + (maxY - minY) * ty
          for (let ix = 1; ix <= samples; ix += 1) {
            const tx = ix / (samples + 1)
            const sx = minX + (maxX - minX) * tx
            if (!pointInClipperPaths([ringPath], { x: sx, y: sy })) continue
            inRing += 1
            if (pointInClipperPaths(sliceMaterial, { x: sx, y: sy })) inMaterial += 1
          }
        }
        if (inRing === 0) return false
        // Majority points inside the ring lie in material → ring encloses
        // material → tool runs OUTSIDE the material (around the bump/exterior)
        // → tool-inside = false. Majority in empty space → ring encloses a
        // cavity → tool-inside = true.
        return inMaterial * 2 < inRing
      })
      // Waterline rings carry mixed topology: outer rings around the model
      // exterior (tool outside the contour) and hole rings inside pockets
      // (tool inside the contour). The two roles require opposite windings
      // to honor the same climb/conventional setting — pass per-contour
      // topology so the helper picks the correct winding regardless of what
      // Clipper did to the ring's traversal direction during slicing /
      // offsetting / clipping.
      const directedContours = applyContourDirectionBySide(
        pointContours,
        direction,
        'tool-outside',
        pathClosed,
        naturalIsClockwise,
        toolInsidePerContour,
      )

      for (let i = 0; i < directedContours.length; i += 1) {
        let contour = directedContours[i]
        if (contour.length < 2) continue
        const isClosed = pathClosed[i] && contour.length >= 3

        if (isClosed && currentPosition) {
          // TODO: For vertical-wall pockets (e.g. round pocket), rings at different Z
          // levels should share the same XY start point, enabling direct plunge descent.
          // Currently, floating-point drift in Clipper offset or simplification can shift
          // the nearest vertex slightly between levels, breaking XY alignment and causing
          // unnecessary retract+plunge cycles mid-column. Consider snapping the entry
          // point to the previous ring's endpoint when distance is below stepover/2.
          contour = rotateContourToNearestEntry(contour, { x: currentPosition.x, y: currentPosition.y })
        }

        const meshBoundaryPaths = intersectingAdds.length > 0 ? sliceMeshOnlyAtZ(ringEntry.z) : []
        const meshBoundaryTolerance = Math.max(stepoverDistance * 1.5, tool.radius * 0.15, 1e-5)
        const isNearMeshBoundary = (point: XYPoint): boolean => {
          if (meshBoundaryPaths.length === 0) return false
          const distance = distanceToClipperPathsBoundary(meshBoundaryPaths, point)
          return Math.abs(distance - toolOffset) <= meshBoundaryTolerance
        }
        const zAtPoint = ringEntry.projectZAtPoint ?? (() => ringEntry.z)
        const liftedZAtPoint = intersectingAdds.length > 0
          ? (point: XYPoint): number => {
              const baseZ = zAtPoint(point)
              if (isNearMeshBoundary(point)) return baseZ
              const safeMeshZ = safeToolTipZAt(point.x, point.y, baseHeightMap, tool)
              return Number.isFinite(safeMeshZ)
                ? Math.max(baseZ, safeMeshZ + stepoverDistance * 0.5)
                : baseZ
            }
          : zAtPoint
        if (ringEntry.projectZAtPoint) {
          contour = densifyContour(contour, stepoverDistance / 2, isClosed)
          if (!isClosed && contourPolylineLength(contour, false) <= Math.max(toolOffset * 2, stepoverDistance * 2)) {
            continue
          }
        }
        const safeRuns = intersectingAdds.length > 0
          ? splitContourByTargetMeshSafety(
              contour,
              isClosed,
              zAtPoint,
              baseHeightMap,
              tool,
              Math.max(1e-5, Math.min(stepoverDistance / 2, tool.radius / 4)),
              meshBoundaryPaths,
              toolOffset,
              meshBoundaryTolerance,
            )
          : [{ contour, closed: isClosed }]

        for (const safeRun of safeRuns) {
          if (safeRun.contour.length < 2) continue
          if (!safeRun.closed && contourPolylineLength(safeRun.contour, false) <= Math.max(toolOffset * 0.5, stepoverDistance)) {
            continue
          }
          const entry = safeRun.closed
            ? projectedContourStartPoint(safeRun.contour, liftedZAtPoint)
            : { ...safeRun.contour[0], z: liftedZAtPoint(safeRun.contour[0]) }
          // If the entry sits within the tool body's lateral reach of an
          // intersecting-add wall, force a retract first. Otherwise
          // transitionToCutEntry's same-XY shortcut would plunge straight
          // down at the wedge wall and the tool body's lateral extent sweeps
          // straight through the wedge material above the current tip z.
          // The retract path (rapid up to safeZ + lateral rapid + plunge)
          // performs the descent away from the wedge instead.
          if (
            currentPosition
            && currentPosition.z < safeZ - 1e-9
            && entryIsNearIntersectingAdd(entry)
          ) {
            currentPosition = retractToSafe(allMoves, currentPosition, safeZ)
          }
          currentPosition = transitionToCutEntry(allMoves, currentPosition, entry, safeZ, 0)
          const cutMovesForContour = intersectingAdds.length > 0 || ringEntry.projectZAtPoint
            ? toProjectedCutMoves(safeRun.contour, safeRun.closed, liftedZAtPoint, ringEntry.source)
            : safeRun.closed
              ? toClosedCutMoves(safeRun.contour, ringEntry.z)
              : toOpenCutMoves(safeRun.contour, ringEntry.z)
          const simplified = simplifyContiguousCutMoves(cutMovesForContour)
          allMoves.push(...simplified)
          for (const move of simplified) {
            allStepLevels.add(move.from.z)
            allStepLevels.add(move.to.z)
          }
          currentPosition = simplified.at(-1)?.to ?? entry
        }
      }
    }
  }

  const regionClipped = clipToolpathResultToRegionMask(project, {
    operationId: operation.id,
    moves: allMoves,
    warnings: [],
    bounds: null,
  }, regionMask)
  if (regionClipped.warnings.length > 0) {
    warnings.push(...regionClipped.warnings)
  }

  const finalStepLevels = new Set<number>()
  for (const move of regionClipped.moves) {
    if (move.kind !== 'cut') continue
    finalStepLevels.add(move.from.z)
    finalStepLevels.add(move.to.z)
  }

  return {
    moves: regionClipped.moves,
    stepLevels: finalStepLevels.size > 0 ? finalStepLevels : allStepLevels,
  }
}
