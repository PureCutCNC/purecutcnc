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

import { buildSurfaceSlopeDomain, intersectSurfaceSlopeDomain, segmentInSurfaceDomain } from './finishSurfaceSlope'
import ClipperLib from 'clipper-lib'
import type { ToolpathWarning } from './warningCodes'
import type { CutDirection, Operation, Project, SketchFeature } from '../../types/project'
import { convertLength } from '../../utils/units'

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
import { simplifyClosedRing } from './arcReconstruction'
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
  safeSubtractBottomZAtPoint,
  unionClipperPaths,
  unionClipperPathsEvenOdd,
} from './modelProtection'
import { retractToSafe, rotateContourToNearestEntry, toClosedCutMoves, toOpenCutMoves, transitionToCutEntry } from './pocket'
import { resolveRegionDomainCentre } from './regionDomain'
import { buildRegionMask } from './regions'
import type { ClipperPath, NormalizedTool, ToolpathMove, ToolpathPoint } from './types'
import { appendAll } from './appendAll'

const WATERLINE_LENGTH_EPSILON_MM = 0.01

/**
 * How many times over the adaptive refinement may cover the model footprint
 * (issue #698).
 *
 * The refinement's cost is the length of path it emits, and covering an area
 * `A` at spacing `s` costs `A / s` of path. So the bound is stated as an area
 * ratio, with the spacing cancelling out of it: the refinement may cover
 * `WATERLINE_REFINEMENT_COVERAGE * footprintArea`, and when the bands and caps
 * it has to fill add up to more than that, every one of them is machined at a
 * proportionally coarser spacing
 *
 *     effective = requested * demandArea / (COVERAGE * footprintArea)
 *
 * rather than the first ones getting everything they ask for and the rest
 * getting nothing.
 *
 * **What this replaces was a single global ring counter spent top-down**, which
 * made a finer Adaptive spacing produce *worse* coverage: halving the spacing
 * doubled what each band consumed, so the counter ran out higher up the model
 * and everything below it was left uncut. On a synthetic hills-and-flats
 * fixture (3 mm ball, 0.5 mm stepdown) the share of flat area never cut ran
 * 14.3 / 14.3 / 16.2 / 33.9 % at 1.20 / 0.60 / 0.30 / 0.15 mm — backwards, and
 * at 0.15 mm no better than switching adaptive refinement off entirely.
 *
 * Stating the bound this way fixes that by construction rather than by tuning.
 * `demandArea` is a property of the model and the coarse level set, not of the
 * spacing — measured at 1.00x footprint on the hills fixture at 0.30 mm and the
 * same 1.00x at 0.15 mm — so `effective` is a *fixed multiple* of `requested`.
 * Halving Adaptive spacing halves the spacing actually machined, budget or no
 * budget. It is also scale-free, which a ring count is not: a 600 mm part gets
 * 100x the budget of a 60 mm one, so the same setting means the same thing on
 * both.
 *
 * Measured demand, i.e. what each fixture would need for the budget never to
 * bind at all:
 *
 *     hills fixture, 0.30 mm and 0.15 mm    1.00x footprint
 *     hills fixture, 0.25 mm stepdown       3.43x footprint
 *     Makera_Model.camj, default            4.56x footprint
 *
 * 2 sits well above the first and below the last on purpose. The hills fixture
 * is the one whose acceptance criterion is monotone coverage, and it clears the
 * bound at every spacing tested, so its refinement is never coarsened. Makera
 * is the one that pays, and what it buys there is the pair of criteria that
 * pull against each other, since cusp height goes as the *square* of spacing:
 *
 *                      spacing            flat p90   never cut   moves     gen
 *     shipped          0.0100 in          0.992 mm      0.3 %  115,828    8.6 s
 *     COVERAGE 3       0.0100 -> 0.0152   0.048 mm      0.0 %  177,119   24.2 s
 *     COVERAGE 2       0.0100 -> 0.0228   0.064 mm      0.0 %  117,791   14.1 s
 *     COVERAGE 1.5     0.0100 -> 0.0304   0.098 mm      0.0 %   90,157   11.8 s
 *     no bound         0.0100             0.041 mm      0.0 %  271,836   33.1 s
 *
 * 3 costs 2.8x the shipped generation time, and 1.5 lands on the 0.10 mm cusp
 * budget with nothing to spare. 2 is the only row with room on both.
 */
const WATERLINE_REFINEMENT_COVERAGE = 2

/**
 * Catastrophic backstop on inserted rings — **not** the allocator (issue #698).
 *
 * `WATERLINE_REFINEMENT_COVERAGE` bounds the refinement's total path length but
 * not the number of rings that length is cut into, and a model dense in tiny
 * peaks emits very short rings that each still cost a Clipper offset and a
 * link. This stops that case spinning, and nothing else — it sits an order of
 * magnitude above both calibration fixtures (2,199 rings on the hills fixture
 * at 0.15 mm, 2,888 on Makera with no bound at all), so an ordinary model never
 * reaches it. When it does fire the operation says so with
 * `waterlineRefinementTruncated`, because unlike coarsening it leaves the
 * surface uneven rather than uniformly rougher.
 */
const WATERLINE_PROJECTED_MAX_TOTAL_RINGS = 20_000
const WATERLINE_ADAPTIVE_Z_KEY_DECIMALS = 6
const WATERLINE_PROJECTED_MIN_BBOX_OVERLAP = 0.05
const WATERLINE_PROJECTED_PARENT_MAX_AREA_RATIO = 8

/**
 * Deviation a waterline finish contour may carry, in mm (issue #685).
 *
 * `sliceMeshAtZDetailed` emits one contour vertex per triangle-edge crossing
 * and nothing downstream thinned it — `cleanClipperPath(path, 1.0)` drops
 * vertices closer than 0.1 um at `DEFAULT_CLIPPER_SCALE`, i.e. nothing for a
 * real mesh. Every one of them then entered a `ClipperOffset.Execute` per Z
 * level over a shadow that only ever grows, and that cost is superlinear in the
 * total: the mesh behind #673 handed 3,978,229 contour vertices to Clipper and
 * spent 177.9 s of a 305.2 s run inside that one offset.
 *
 * **This is not #677's tolerance and cannot be argued the way #677's was.** In
 * roughing the contours are a keep-out, so thinning could be paid for by
 * expanding the keep-out by the error measured — the error always moves the
 * boundary away from the model and the worst case is extra stock. Here the
 * offset contours *are* the cut path, so the error lands in the finished
 * surface and can go either way.
 *
 * **The obvious bound is wrong, and measuring it is what found that out.**
 * `simplifyClosedRing` reports a true Hausdorff bound, and it is tempting to
 * conclude that a constant offset carries it through to the ring. It does not:
 * an outward offset at a *concave* corner is trimmed where the two walls'
 * offsets collide, and moving each wall by `d` moves that trim vertex along the
 * valley bisector by `d / sin(theta / 2)`, which is unbounded as the valley
 * narrows. Measured on `Oldman-splash-final.camj` at 5 um, the emitted ring
 * moves by up to **129x** the tolerance.
 *
 * That excursion is a tool-*centre* artifact, not a surface error. At a trim
 * vertex the cutter is simultaneously tangent to both valley walls — it has
 * bottomed out — so what moves is where it stops, not what it removes. The
 * surface is the boundary the cutter stays tangent to, and that is the shadow
 * the ring is offset from. Measured there, on the same two models, per boundary
 * vertex against the undecimated boundary:
 *
 *                          p50     p99     p99.9   worst
 *     #673's relief       0.0d    1.0d    1.3d     1.5d  (7.4 um)
 *     Oldman-splash       0.0d    1.0d    1.3d     5.0d  (25.0 um)
 *
 * 5 um is chosen against that measurement rather than against the nominal
 * bound. Oldman's own scallop between adjacent passes — a 1.5875 mm ball at its
 * 0.02 in micro-stepover — is 21.7 um, so even that model's worst single vertex
 * sits at the finish the pass already leaves, and 99.9% of its surface is
 * inside 6.5 um.
 *
 * Tightening does not buy what it looks like it should: at 2.5 um the worst case
 * only improves to 5.1 um and 17.8 um, the operation costs 31% more, and the
 * densest slice grows to 10,531 vertices, which spends most of the headroom
 * under `DEFAULT_WATERLINE_SLICE_VERTEX_BUDGET`. Loosening falls off a cliff: at
 * 10 um Oldman's worst case jumps to 294 um, because features start collapsing
 * rather than merely shifting.
 *
 * It is expressed in mm and converted, because waterline runs in project units
 * and `sliceDecimationTolerance`'s `clamp(r * 0.01, 0.002, 0.02)` — fine where
 * it lives, since roughing re-expands the keep-out by the measured error — would
 * mean 51-508 um on an inch project.
 */
export const WATERLINE_SLICE_DECIMATION_TOLERANCE_MM = 0.005

/**
 * Contour vertices one mesh slice may hand to Clipper before the operation is
 * refused (issue #685).
 *
 * Decimation buys a large constant factor but not a complexity class, so this
 * is the backstop for a mesh dense enough to blow through it. Measured through
 * `generateFinishSurfaceWaterline` with decimation in place and this budget
 * disabled, node v26.0.0 on an i7-8850H, two fixture families that agree:
 *
 *     densest slice   wall          CPU        source
 *              649    3.2 s         4.1 s      Oldman-splash-final.camj (real)
 *            4 001    3.2 s         4.6 s      tapered relief tube, sawtooth
 *            8 001    9.8-16.0 s   11.4-12.2 s tapered relief tube, sawtooth
 *            8 334    9.6 s        11.7 s      the mesh behind #673 (real)
 *           16 001   40.4-151.3 s  43.6-68.1 s tapered relief tube, sawtooth
 *           32 001  197.9-208.6 s 204.2-216.2 s tapered relief tube, sawtooth
 *
 * The synthetic tube and the real relief landing within 15% of each other at
 * ~8 000 is the cross-validation #677 could not get, and it is why this number
 * is trusted where that issue's island harness was not.
 *
 * **Deliberately per-slice, and the first draft of this was per-operation.** A
 * cumulative count was tried first and does not work: the same real mesh spends
 * 210 428 vertices in 6.8 s at a 0.005 in stepdown and 77 918 in 9.6 s at
 * 0.02 in, because a finer stepdown gives the adaptive refinement less to
 * insert. Meanwhile the tube spends 224 007 in 198 s. Any threshold that
 * refuses the tube refuses the real file too. The vertex count of a *single*
 * slice is what the superlinear `ClipperOffset.Execute` is charged for, and it
 * is the quantity that orders the table above correctly.
 *
 * 12 000 is about the geometric mid-point of the densest usable row (8 334 real
 * at 11.7 s) and the lowest unusable one (16 001 at 43.6-68.1 s), and
 * interpolates to roughly 20 s. It is only 1.4x over the densest real mesh
 * measured, which is tighter headroom than #677 has, and that is a property of
 * this resolver rather than a choice: real relief work already sits at ten
 * seconds here, so a ten-second refusal point is not available. A mesh twice
 * that dense takes the better part of a minute, which is past where a browser's
 * slow-script watchdog starts complaining — refusing it with an actionable
 * message beats freezing the tab, which is #673's failure mode.
 *
 * The freeze itself is #675's to remove; this only bounds it.
 */
export const DEFAULT_WATERLINE_SLICE_VERTEX_BUDGET = 12_000

/**
 * Densest slice the operation has produced, checked as slices are built.
 *
 * Once `exceeded` is set every further mesh slice returns empty, which winds the
 * level builds and the adaptive refinement down within one iteration instead of
 * letting them run to completion on a mesh already known to be unbounded. The
 * caller then refuses the whole operation rather than emitting a partial
 * program built from the slices that happened to fit.
 *
 * `spent` is a diagnostic only — it is reported by `debugToolpath` and nothing
 * is refused on it; see the budget constant for why it cannot be the instrument.
 */
interface WaterlineSliceBudget {
  limit: number
  spent: number
  maxSlice: number
  exceeded: boolean
  /** Z of the slice that crossed the limit. */
  exceededAtZ: number
}

interface XYPoint {
  x: number
  y: number
}

function heightMapWithIntersectingAddTops(
  baseHeightMap: HeightMap,
  intersectingAdds: IntersectingAddFeature[],
): HeightMap {
  if (intersectingAdds.length === 0) return baseHeightMap

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
    for (let row = rowStart; row <= rowEnd; row += 1) {
      for (let col = colStart; col <= colEnd; col += 1) {
        const x = originX + (col + 0.5) * cellSize
        const y = originY + (row + 0.5) * cellSize
        if (!pointInClipperPaths(add.paths, { x, y })) continue
        const index = row * width + col
        if (add.topZ > data[index]) data[index] = add.topZ
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

/**
 * Mesh cross-section at one Z, thinned to `decimationTolerance` and charged
 * against the operation's vertex budget.
 *
 * Unlike `surfaceStepdown3d.ts`'s function of the same name there is no margin
 * to re-expand by and no deviation to report: these contours are the cut path,
 * not a keep-out, so the tolerance itself is the bound on the surface error and
 * expanding the ring would gouge on one side while leaving a ridge on the other
 * (issue #685).
 *
 * A tolerance of 0 disables thinning outright, which is what keeps a coarse or
 * box-like cross-section byte-identical: RDP has no vertex to drop there, but
 * skipping it also skips the ring rebuild.
 */
function slicePolygonsToClipperPaths(
  slicePolygons: Array<Array<[number, number]>>,
  decimationTolerance: number,
  budget: WaterlineSliceBudget,
  z: number,
): ClipperPath[] {
  const paths = slicePolygons
    .filter((poly) => poly.length >= 3)
    .map((poly) => {
      const ring = poly.map(([x, y]) => ({ x, y }))
      const thinned = decimationTolerance > 0
        ? simplifyClosedRing(ring, decimationTolerance).points
        : ring
      return toClipperPath(normalizeWinding(thinned, false), DEFAULT_CLIPPER_SCALE)
    })
  // Counted before the even-odd union rather than after it: the union is itself
  // a Clipper boolean over these vertices, so a slice that unions down to
  // nothing has still been paid for.
  let sliceVerts = 0
  for (const path of paths) sliceVerts += path.length
  budget.spent += sliceVerts
  if (sliceVerts > budget.maxSlice) budget.maxSlice = sliceVerts
  if (!budget.exceeded && sliceVerts > budget.limit) {
    budget.exceeded = true
    budget.exceededAtZ = z
    return []
  }
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
  microStepover: number
  hitCap: boolean
  hitPassLimit: boolean
}

/**
 * State shared by the refinement's two passes (issue #698).
 *
 * The same walk runs twice: once with `dryRun` set, which prices every band and
 * cap the refinement would fill and emits nothing, and once for real at the
 * spacing that pricing chose. Pricing before emitting is the whole point — a
 * band's share must not depend on how far down the model it sits.
 *
 * Repeating the walk is safe because it is deterministic: `processTipStack`
 * branches only on sliced contours and `pathsAreRelatedForProjectedBand`, never
 * on what was emitted, `upperPathHasHigherParent` reads the caller's coarse
 * levels rather than the mutated copy, and every other piece of walk state is
 * local to one call.
 *
 * The caches make the repeat close to free, and keep the slice budget honest:
 * the projected slices are the only expensive thing the dry pass does, and
 * memoizing them means each Z is sliced exactly once across both passes, which
 * is what a single pass did.
 */
interface WaterlineRefinementPass {
  dryRun: boolean
  /** Total band/cap area the refinement would cover, in project units squared. */
  demandArea: number
  contourCache: Map<string, ClipperPath[]>
  materialCache: Map<string, ClipperPath[]>
}

/** Net area of a Clipper path set in project units, holes subtracted. */
function clipperPathsArea(paths: ClipperPath[]): number {
  let area = 0
  for (const path of paths) area += ClipperLib.Clipper.Area(path)
  return Math.abs(area) / (DEFAULT_CLIPPER_SCALE * DEFAULT_CLIPPER_SCALE)
}

/** Machinable footprint of the model, in project units squared. */
function heightMapFootprintArea(heightMap: HeightMap): number {
  let cells = 0
  for (let at = 0; at < heightMap.data.length; at += 1) {
    if (Number.isFinite(heightMap.data[at])) cells += 1
  }
  return cells * heightMap.cellSize * heightMap.cellSize
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
  budget: WaterlineSliceBudget,
): WaterlineLevelBuild {
  const levels: WaterlineLevel[] = []
  const sliceMaterialByZ = new Map<number, ClipperPath[]>()
  let shadow: ClipperPath[] = []

  for (const z of uniqueDescendingZLevels(zLevels)) {
    // The shadow only grows, so every level past the budget costs more than the
    // one that blew it. The caller refuses the operation outright; stopping here
    // is what keeps the refusal cheap rather than arriving after the freeze.
    if (budget.exceeded) break
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
  gapThreshold: number,
  maxRingsPerBand: number,
  waterlineLengthEpsilon: number,
  intersectingAdds: IntersectingAddFeature[],
  toolOffset: number,
  tipStepdownDistance: number,
  sliceProjectedAtZ: (z: number) => ClipperPath[],
  isCriticalFloorZ: (z: number) => boolean,
  projectTerminalCapsToTargetContact: boolean,
  budget: WaterlineSliceBudget,
  pass: WaterlineRefinementPass,
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
  const levels: WaterlineLevel[] = coarseBuild.levels.map((level) => ({
    ...level,
    contourPaths: [...level.contourPaths],
  }))
  let insertedLevels = 0
  let maxObservedGap = 0
  let hitCap = false
  let hitPassLimit = false
  const emitLevel = (level: WaterlineLevel): boolean => {
    if (budget.exceeded) return false
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

  // Memoized across both refinement passes so the dry pass costs no extra
  // slicing and the slice vertex budget is charged exactly once per Z, as it
  // was when the refinement ran only once (issue #698).
  const zCacheKey = (z: number): string => z.toFixed(WATERLINE_ADAPTIVE_Z_KEY_DECIMALS)
  const projectedContourPathsAtZ = (z: number): ClipperPath[] => {
    const key = zCacheKey(z)
    const cached = pass.contourCache.get(key)
    if (cached) return cached
    const slice = sliceProjectedAtZ(z)
    const contours = slice.length === 0
      ? []
      : clipRingsAgainstAdds(offsetClipperPaths(slice, toolOffset), z)
    pass.contourCache.set(key, contours)
    return contours
  }
  const projectedMaterialAtZ = (z: number): ClipperPath[] => {
    const key = zCacheKey(z)
    const cached = pass.materialCache.get(key)
    if (cached) return cached
    const material = sliceProjectedAtZ(z)
    pass.materialCache.set(key, material)
    return material
  }

  const emitProjectedCapTerminal = (path: ClipperPath, z: number): boolean => {
    const center = clipperPathCentroid(path)
    const terminalCapPaths = clipRingsAgainstAdds([path], z)
    if (!pointInClipperPaths(terminalCapPaths, center)) return true
    const terminalMaterial = projectedMaterialAtZ(z - waterlineLengthEpsilon)
    if (!pointInClipperPaths(terminalMaterial, center)) return true

    // The inward fill below sweeps the whole cap disc, so its cost is that
    // disc's area at whatever spacing the allocator picks (issue #698).
    if (pass.dryRun) {
      if (projectTerminalCapsToTargetContact) pass.demandArea += clipperPathsArea(terminalCapPaths)
      return true
    }

    // Tool-offset contours around a peak stop shrinking when their radius
    // approaches the cutter radius. Fill that remaining disk at the requested
    // micro-step before placing the cutter over the local maximum; otherwise
    // the last offset ring and the center pass are separated by roughly one
    // tool radius, leaving a flat crown on cone and nose tips.
    if (projectTerminalCapsToTargetContact) {
      if (!emitLevel({
        z,
        contourPaths: terminalCapPaths,
        projectZAtPoint: () => z,
        source: 'projectedCap',
      })) return false

      let stoppedByCollapse = false
      for (let step = 1; step <= maxRingsPerBand; step += 1) {
        const inward = clipRingsAgainstAdds(
          offsetClipperPaths([path], -(step * stepoverDistance)),
          z,
        )
        if (inward.length === 0) {
          stoppedByCollapse = true
          break
        }
        if (!emitLevel({
          z,
          contourPaths: inward,
          projectZAtPoint: () => z,
          source: 'projectedCap',
        })) return false
      }
      if (!stoppedByCollapse) hitPassLimit = true
    }

    // Keep the terminal move as a tiny closed pass rather than adding a
    // special single-point move to the shared toolpath model.
    const centerX = Math.round(center.x * DEFAULT_CLIPPER_SCALE)
    const centerY = Math.round(center.y * DEFAULT_CLIPPER_SCALE)
    const terminalRadius = Math.max(
      2,
      Math.round(waterlineLengthEpsilon * DEFAULT_CLIPPER_SCALE),
    )
    const terminalPath: ClipperPath = [
      { X: centerX, Y: centerY - terminalRadius },
      { X: centerX + terminalRadius, Y: centerY + terminalRadius },
      { X: centerX - terminalRadius, Y: centerY + terminalRadius },
    ]
    const clippedTerminalPaths = clipRingsAgainstAdds(
      intersectClipperPaths([terminalPath], [path]),
      z,
    ).filter((candidate) => candidate.length >= 3)
    if (clippedTerminalPaths.length === 0) return true

    return emitLevel({
      z,
      contourPaths: clippedTerminalPaths,
      projectZAtPoint: () => z,
      source: 'projectedCap',
    })
  }

  const emitProjectedBandFill = (
    upper: WaterlineLevel,
    lower: WaterlineLevel,
    lowerPath: ClipperPath,
    matchedUpperPaths: ClipperPath[],
    source: 'projectedBand' | 'projectedCap',
    minimumGap: number,
  ): boolean => {
    const gap = maxContourGap(matchedUpperPaths, [lowerPath])
    if (gap > maxObservedGap) maxObservedGap = gap
    if (gap <= minimumGap) return true

    const bandPaths = differenceClipperPaths([lowerPath], matchedUpperPaths)
    if (bandPaths.length === 0) return true

    // Pricing pass: a band is charged its own area, because filling it costs
    // `area / spacing` of path whatever the spacing turns out to be. Nothing is
    // emitted and the per-ring offsets below — the expensive part — are skipped
    // entirely (issue #698).
    if (pass.dryRun) {
      pass.demandArea += clipperPathsArea(bandPaths)
      return true
    }

    let stoppedByCollapse = false
    for (let step = 1; step <= maxRingsPerBand; step += 1) {
      const distance = step * stepoverDistance
      const inward = offsetClipperPaths([lowerPath], -distance)
      if (inward.length === 0) {
        stoppedByCollapse = true
        break
      }
      const z = lower.z + (upper.z - lower.z) * Math.max(0, Math.min(1, distance / gap))
      const clippedToBand = clipRingsAgainstAdds(
        intersectClipperPaths(inward, bandPaths),
        z,
      )
      if (clippedToBand.length === 0) {
        stoppedByCollapse = true
        break
      }
      const projectZAtPoint = (point: { x: number; y: number }): number => (
        matchedUpperPaths.length > 0
          ? projectedBandZAtPoint(point, upper, lower)
          : lower.z + (upper.z - lower.z) * Math.max(
              0,
              Math.min(1, distanceToClipperPathBoundary(lowerPath, point) / Math.max(gap, waterlineLengthEpsilon)),
            )
      )
      if (!emitLevel({
        z,
        contourPaths: clippedToBand,
        projectZAtPoint,
        source,
      })) return false
    }
    if (!stoppedByCollapse) {
      hitPassLimit = true
    }
    return true
  }

  const processTipStack = (
    basePath: ClipperPath,
    baseZ: number,
    peakZ: number,
  ): boolean => {
    type ActiveTipPath = { path: ClipperPath; z: number }
    let active: ActiveTipPath[] = [{ path: basePath, z: baseZ }]
    let currentZ = baseZ

    while (!hitCap && currentZ < peakZ - waterlineLengthEpsilon) {
      const nextZ = Math.min(peakZ, currentZ + tipStepdownDistance)
      if (nextZ <= currentZ + waterlineLengthEpsilon) break
      const queryZ = nextZ >= peakZ - waterlineLengthEpsilon
        ? Math.max(currentZ + waterlineLengthEpsilon, peakZ - waterlineLengthEpsilon)
        : nextZ
      const nextContours = projectedContourPathsAtZ(queryZ)
      if (nextContours.length === 0) {
        for (const activePath of active) {
          if (!emitProjectedBandFill(
            { z: nextZ, contourPaths: [] },
            { z: activePath.z, contourPaths: [activePath.path] },
            activePath.path,
            [],
            'projectedCap',
            waterlineLengthEpsilon,
          )) return false
          if (!emitProjectedCapTerminal(activePath.path, nextZ)) return false
        }
        break
      }

      const nextActive: ActiveTipPath[] = []
      const claimedNextContours = new Set<ClipperPath>()
      for (const activePath of active) {
        const related = nextContours.filter((path) => (
          !claimedNextContours.has(path)
          && pathsAreRelatedForProjectedBand(path, activePath.path)
        ))
        if (related.length === 0) {
          if (!emitProjectedBandFill(
            { z: nextZ, contourPaths: [] },
            { z: activePath.z, contourPaths: [activePath.path] },
            activePath.path,
            [],
            'projectedCap',
            waterlineLengthEpsilon,
          )) return false
          if (!emitProjectedCapTerminal(activePath.path, nextZ)) return false
          continue
        }
        if (!emitProjectedBandFill(
          { z: nextZ, contourPaths: related },
          { z: activePath.z, contourPaths: [activePath.path] },
          activePath.path,
          related,
          'projectedCap',
          waterlineLengthEpsilon,
        )) return false
        for (const path of related) {
          claimedNextContours.add(path)
          nextActive.push({ path, z: nextZ })
        }
      }

      if (nextActive.length === 0) break
      active = nextActive
      currentZ = nextZ
    }

    if (currentZ >= peakZ - waterlineLengthEpsilon) {
      for (const activePath of active) {
        if (!emitProjectedCapTerminal(activePath.path, peakZ)) return false
      }
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

    // Build a quick lookup so each local top can start from the first real
    // stepdown shape below it, then climb back upward through real sliced
    // micro-levels.
    const upperToMatchedLower = new Map<ClipperPath, ClipperPath>()
    const upperToMatchedLowerIndex = new Map<ClipperPath, number>()
    for (const [lowerIndex, matchedUpperPaths] of matches) {
      const matchedLower = lower.contourPaths[lowerIndex]
      for (const upperPath of matchedUpperPaths) {
        upperToMatchedLower.set(upperPath, matchedLower)
        upperToMatchedLowerIndex.set(upperPath, lowerIndex)
      }
    }
    const capBaseLowerIndices = new Set<number>()
    const capBaseGroups = new Map<number, { lowerPath: ClipperPath; upperPaths: ClipperPath[]; peakZ: number }>()
    const unbasedLocalTopPaths: ClipperPath[] = []

    // Tip processing for upper-level rings. A ring qualifies as an island
    // top when it is an outer ring and either it was born at this level or
    // it has no higher-level parent while growing as Z descends. Instead of
    // inventing inward cap offsets from the tiny first-slice contour, start
    // from the first real stepdown shape and insert real sliced micro-levels
    // upward until the island collapses into air.
    for (const upperPath of upper.contourPaths) {
      if (hitCap) break
      if (processedTipPaths.has(upperPath)) continue
      const upperSignedArea = ClipperLib.Clipper.Area(upperPath)
      if (upperSignedArea <= 0) continue
      const matchedLowerPath = upperToMatchedLower.get(upperPath)
      const matchedLowerArea = matchedLowerPath
        ? Math.abs(ClipperLib.Clipper.Area(matchedLowerPath))
        : 0
      // Nothing above covers a ring at a top, and the region inside a topmost
      // contour is filled by the tip stack or by nothing at all —
      // `emitProjectedBandFill` only ever covers the annulus *between* two
      // contours. So what a top looks like has to be recognised here, and there
      // are two shapes of it that no single test sees.
      //
      // A peak — a cone, a nose, a dome apex — shrinks fast as Z rises, and
      // carries no horizontal triangle at all, so only the area ratio finds it.
      const isShrinkingFromLower = matchedLowerPath
        ? matchedLowerArea > upperSignedArea * 1.3
        : false
      // A plateau is the opposite: it does not shrink, which is why the ratio
      // alone left every flat top in the model unmachined (issue #699). The
      // hills fixture's largest clamped dome is 6.82 mm across at its top
      // against 7.16 mm one stepdown down, a ratio of 1.10 against the 1.3 the
      // gate wanted, and its whole face went uncut. `criticalWaterlineFloorZs`
      // already answers this half: it keeps a Z only when its flat area clears
      // `PI * r^2`, the bound below which the cutter cannot stand on the plateau
      // at all, so a top too small to reach still gets nothing and #682/#685's
      // reachability rule is inherited rather than worked around.
      const isLocalTop = forcedLocalTopPaths.has(upperPath)
        || (!upperPathHasHigherParent(upperPath, higher)
          && (isShrinkingFromLower || isCriticalFloorZ(upper.z)))
      if (!isLocalTop) continue

      processedTipPaths.add(upperPath)
      const peakZ = higher ? higher.z : upper.z
      suppressCoarsePath(i, upperPath)
      suppressedCoarsePaths.push({ z: upper.z, path: upperPath })
      if (matchedLowerPath) {
        const matchedLowerIndex = upperToMatchedLowerIndex.get(upperPath)
        if (matchedLowerIndex !== undefined) {
          const group = capBaseGroups.get(matchedLowerIndex) ?? {
            lowerPath: matchedLowerPath,
            upperPaths: [],
            peakZ,
          }
          group.upperPaths.push(upperPath)
          group.peakZ = Math.max(group.peakZ, peakZ)
          capBaseGroups.set(matchedLowerIndex, group)
        }
      } else {
        unbasedLocalTopPaths.push(upperPath)
      }
    }

    for (const [lowerIndex, group] of capBaseGroups) {
      if (hitCap) break
      capBaseLowerIndices.add(lowerIndex)
      if (!processTipStack(group.lowerPath, lower.z, group.peakZ)) break
    }

    for (const upperPath of unbasedLocalTopPaths) {
      if (hitCap) break
      const peakZ = higher ? higher.z : upper.z
      if (!processTipStack(upperPath, upper.z, peakZ)) break
    }

    for (const [lowerIndex, matchedUpperPaths] of matches) {
      if (hitCap) break
      if (capBaseLowerIndices.has(lowerIndex)) continue
      const lowerPath = lower.contourPaths[lowerIndex]
      if (!emitProjectedBandFill({
        ...upper,
        contourPaths: matchedUpperPaths,
      }, {
        ...lower,
        contourPaths: [lowerPath],
      }, lowerPath, matchedUpperPaths, 'projectedBand', gapThreshold)) break
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
      processedTipPaths.add(path)
      if (!processTipStack(path, lastLevel.z, peakZForLast)) break
    }
  }

  return {
    levels: levels.sort((a, b) => b.z - a.z),
    sliceMaterialByZ: coarseBuild.sliceMaterialByZ,
    metrics: {
      insertedLevels,
      maxObservedGap,
      gapThreshold,
      microStepover: stepoverDistance,
      hitCap,
      hitPassLimit,
    },
    suppressedCoarsePaths,
  }
}

function suppressProjectedCoarsePaths(
  coarseLevels: WaterlineLevel[],
  suppressedPaths: WaterlineSuppressedPath[],
  xyTolerance: number,
  zTolerance: number,
): WaterlineLevel[] {
  if (suppressedPaths.length === 0) return coarseLevels
  return coarseLevels.map((level) => ({
    ...level,
    contourPaths: level.contourPaths.filter((path) => !suppressedPaths.some((suppressed) => (
      Math.abs(suppressed.z - level.z) <= zTolerance
      && maxContourGap([path], [suppressed.path]) <= xyTolerance
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
  waterlineLengthEpsilon: number,
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
    const steps = Math.max(1, Math.ceil(length / Math.max(maxSegmentLength, waterlineLengthEpsilon)))
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

export function snapClosedContourEntryToAnchor(
  contour: Array<{ x: number; y: number }>,
  anchor: { x: number; y: number } | null,
  tolerance: number,
): Array<{ x: number; y: number }> {
  if (contour.length < 3 || anchor === null || tolerance <= 0) {
    return contour
  }

  const first = contour[0]
  const distance = Math.hypot(first.x - anchor.x, first.y - anchor.y)
  if (distance <= 1e-9) {
    return contour
  }
  if (distance > tolerance) {
    return contour
  }

  return [{ x: anchor.x, y: anchor.y }, ...contour.slice(1)]
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
  waterlineLengthEpsilon: number,
  meshBoundaryPaths: ClipperPath[],
  meshBoundaryDistance: number,
  meshBoundaryTolerance: number,
): Array<{ contour: XYPoint[]; closed: boolean }> {
  if (contour.length < 2) return []
  const dense = densifyContour(contour, maxSegmentLength, waterlineLengthEpsilon, closed)
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

/**
 * Refuse the operation rather than emit a program built from whichever slices
 * happened to fit inside the budget (issue #685).
 */
function refuseMeshTooDense(
  budget: WaterlineSliceBudget,
  warnings: ToolpathWarning[],
): { moves: ToolpathMove[]; stepLevels: Set<number> } {
  warnings.push({
    code: 'surface3dMeshTooDense',
    params: {
      z: budget.exceededAtZ.toFixed(4),
      vertices: budget.maxSlice.toLocaleString(),
      budget: budget.limit.toLocaleString(),
    },
  })
  return { moves: [], stepLevels: new Set<number>() }
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
  warnings: ToolpathWarning[],
  intersectingAdds: IntersectingAddFeature[] = [],
  modelSilhouettePaths: ClipperPath[] = [],
  relatedSubtracts: RelatedSubtractFeature[] = [],
  criticalFloorZs: Set<number> = new Set(),
): { moves: ToolpathMove[]; stepLevels: Set<number> } {
  const radialLeave = Math.max(0, operation.stockToLeaveRadial)
  const toolOffset = tool.radius + radialLeave
  const direction: CutDirection = operation.cutDirection ?? 'conventional'
  const stepoverRatio = operation.stepover ?? 0.5
  const waterlineLengthEpsilon = convertLength(WATERLINE_LENGTH_EPSILON_MM, 'mm', project.meta.units)
  const autoStepoverDistance = stepoverRatio * tool.diameter
  const stepoverDistance = Math.max(
    operation.waterlineMicroStepover && operation.waterlineMicroStepover > 0
      ? operation.waterlineMicroStepover
      : autoStepoverDistance,
    waterlineLengthEpsilon,
  )
  const refinementGapThreshold = Math.max(
    operation.waterlineRefinementThreshold && operation.waterlineRefinementThreshold > 0
      ? operation.waterlineRefinementThreshold
      : stepoverDistance,
    waterlineLengthEpsilon,
  )
  // Rings per band is a loop guard, not an allocator: the coverage budget below
  // bounds what the refinement costs, so this only has to stop an offset loop
  // that never collapses. It was a fixed 96, which reproduced #698's own bug one
  // level down — a fixed *count* at half the spacing reaches half as far, so the
  // widest bands lost coverage as Adaptive spacing got finer (14.3 % of the
  // hills fixture's flat area never cut at 0.30 mm, 14.6 % at 0.15 mm, with the
  // global budget already fixed). Expressed as a reach it cannot: a band may be
  // refined across the whole model whatever the spacing.
  const userMaxRingsPerBand = operation.waterlineMaxRingsPerBand && operation.waterlineMaxRingsPerBand > 0
    ? Math.floor(operation.waterlineMaxRingsPerBand)
    : 0
  const tipStepdownDistance = Math.max(
    operation.waterlineTipStepdown && operation.waterlineTipStepdown > 0
      ? operation.waterlineTipStepdown
      : operation.stepdown / 2,
    waterlineLengthEpsilon,
  )
  const adaptiveRefinementEnabled = operation.waterlineAdaptiveRefinement ?? true

  const regionMask = buildRegionMask(regionFeatures)
  // Build the composite allowed area for pre-generation contour clipping.
  // The waterline rings are tool-centre paths (already offset by toolOffset
  // from the mesh surface), so both polarities dilate the region mask entries
  // by toolOffset = tool.radius + stockToLeaveRadial — exactly the
  // `resolveRegionDomainCentre` contract: the resolver supplies the clearance
  // itself and constrains the result to the model silhouette, so coverage
  // over-reach can never introduce a cut the unmasked operation would not
  // have made (see planning/REGION_FEATURE_SEMANTICS.md).
  const compositeAllowedForRegion: ClipperPath[] | null = regionMask
    ? resolveRegionDomainCentre(modelSilhouettePaths, regionMask, toolOffset)
    : null
  const sliceIndex = getMeshSliceIndex(stlData as Parameters<typeof getMeshSliceIndex>[0])
  const sliceSampleEpsilon = Math.max(Math.abs(modelTopZ - effectiveBottom) * 1e-6, 1e-6)
  const sliceDecimationTolerance = convertLength(
    WATERLINE_SLICE_DECIMATION_TOLERANCE_MM,
    'mm',
    project.meta.units,
  )
  const sliceBudget: WaterlineSliceBudget = {
    limit: DEFAULT_WATERLINE_SLICE_VERTEX_BUDGET,
    spent: 0,
    maxSlice: 0,
    exceeded: false,
    exceededAtZ: 0,
  }

  const targetFeatureIds = new Set(
    operation.target.source === 'features' ? operation.target.featureIds : [],
  )
  // Intersecting add features create vertical walls inside the model envelope.
  // Their boundaries must be finished, not protected — treat them like targets
  // for the protected-footprint builder so the contour can run along their
  // walls instead of being clipped away.
  for (const add of intersectingAdds) targetFeatureIds.add(add.feature.id)

  if (operation.debugToolpath) {
    warnings.push({ code: 'debug', params: { text: `Debug: waterline mode, adaptive=${adaptiveRefinementEnabled ? 'on' : 'off'}, ` +
      `spacing=${stepoverDistance.toFixed(4)}, triggerGap=${refinementGapThreshold.toFixed(4)}, ` +
      `tipStepdown=${tipStepdownDistance.toFixed(4)}, ` +
      `maxRingsPerBand=${userMaxRingsPerBand > 0 ? userMaxRingsPerBand : 'auto'}, ` +
      `epsilon=${waterlineLengthEpsilon.toFixed(6)}, ` +
      `toolOffset=${toolOffset.toFixed(4)}` } })
    warnings.push({ code: 'debug', params: { text: `Debug: intersectingAdds=${intersectingAdds.length} ` +
      `[${intersectingAdds.map((a) => `${a.feature.name}:z=${a.bottomZ.toFixed(2)}..${a.topZ.toFixed(2)}`).join(', ')}], ` +
      `relatedSubtracts=${relatedSubtracts.length} ` +
      `[${relatedSubtracts.map((s) => `z=${s.bottomZ.toFixed(2)}..${s.topZ.toFixed(2)}`).join(', ')}]` } })
  }

  // Mesh top extracted from the slice index domain — separate from the
  // requested step-level top, which may extend above the mesh when an
  // intersecting add feature pokes higher than the model surface.
  const meshTopZ = modelTopZ

  const sliceMeshOnlyAtZ = (z: number): ClipperPath[] => {
    // Past the budget every slice is empty, so the level builds and the adaptive
    // refinement wind down instead of running to completion on a mesh the
    // operation is already going to refuse.
    if (sliceBudget.exceeded) return []
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
    return polygons.length === 0
      ? []
      : slicePolygonsToClipperPaths(polygons, sliceDecimationTolerance, sliceBudget, clampedZ)
  }

  const sliceAtZ = (z: number): ClipperPath[] => {
    const meshPaths = sliceMeshOnlyAtZ(z)
    // Add footprints of intersecting add features that are active at z. Their
    // vertical walls live above the mesh surface and must contribute to the
    // waterline contour so the finish pass cleans the intersection walls.
    const addPaths: ClipperPath[] = []
    for (const add of intersectingAdds) {
      if (z > add.topZ + 1e-9 || z < add.bottomZ - 1e-9) continue
      appendAll(addPaths, add.paths)
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

  const coarseLevelBuild = buildWaterlineLevels(stepLevels, sliceAtZ, toolOffset, sliceBudget)
  const projectedSliceAtZ = intersectingAdds.length > 0 ? sliceMeshOnlyAtZ : sliceAtZ
  const projectedInputBuild = intersectingAdds.length > 0
    ? buildWaterlineLevels(stepLevels, projectedSliceAtZ, toolOffset, sliceBudget)
    : coarseLevelBuild
  // Refuse before the height map, the adaptive refinement and the move
  // emission, all of which scale with what the level build just produced.
  if (sliceBudget.exceeded) return refuseMeshTooDense(sliceBudget, warnings)

  // Build (or reuse) the mesh heightmap for intersecting-add plunge/split
  // safety later in this function. Cell size mirrors the parallel-finish
  // choice so a project that runs both strategies pays the build cost once.
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
  const slopeMask = buildSurfaceSlopeDomain(operation, baseHeightMap,
    (x, y) => safeToolTipZAt(x, y, baseHeightMap, tool), warnings)
  const slopeDomain = slopeMask === null ? null
    : intersectSurfaceSlopeDomain(compositeAllowedForRegion ?? modelSilhouettePaths, slopeMask)
  if (slopeDomain !== null && slopeDomain.length === 0) return { moves: [], stepLevels: new Set() }
  const safetyHeightMap = heightMapWithIntersectingAddTops(baseHeightMap, intersectingAdds)
  const shouldProjectToTargetContact = radialLeave <= 1e-9
    && operation.stockToLeaveAxial <= 1e-9
  const targetToolTipZCache = new Map<string, number>()
  const targetToolTipZAtPoint = (point: XYPoint): number => {
    const key = `${point.x.toFixed(6)},${point.y.toFixed(6)}`
    const cached = targetToolTipZCache.get(key)
    if (cached !== undefined) return cached
    const z = safeToolTipZAt(point.x, point.y, baseHeightMap, tool)
    targetToolTipZCache.set(key, z)
    return z
  }
  const surfaceZAtPoint = (point: XYPoint): number => {
    const col = Math.floor((point.x - safetyHeightMap.originX) / safetyHeightMap.cellSize)
    const row = Math.floor((point.y - safetyHeightMap.originY) / safetyHeightMap.cellSize)
    if (
      col < 0
      || col >= safetyHeightMap.width
      || row < 0
      || row >= safetyHeightMap.height
    ) return Number.NEGATIVE_INFINITY
    return safetyHeightMap.data[row * safetyHeightMap.width + col]
  }
  // Adaptive refinement, priced then filled (issue #698). The first pass walks
  // the whole level list and charges every band and cap the area it would have
  // to cover, emitting nothing; the second runs at the spacing that pricing
  // chose. Allocating from a total known in advance is what stops a band's
  // share depending on where it sits in the model — the previous bound was a
  // global ring counter spent from the top down, so the flats at the bottom got
  // whatever the hills above them had left, which was nothing.
  const refinementEnabled = adaptiveRefinementEnabled && regionFeatures.length === 0
  const refinementPass: WaterlineRefinementPass = {
    dryRun: true,
    demandArea: 0,
    contourCache: new Map<string, ClipperPath[]>(),
    materialCache: new Map<string, ClipperPath[]>(),
  }
  // A band can be no wider than the model, so the reach that can never truncate
  // a real band is the footprint's diagonal (issue #698).
  const refinementReach = Math.hypot(
    heightMapBbox.maxX - heightMapBbox.minX,
    heightMapBbox.maxY - heightMapBbox.minY,
  )
  const bandRingLimit = (spacing: number): number => Math.max(1, Math.min(
    WATERLINE_PROJECTED_MAX_TOTAL_RINGS,
    userMaxRingsPerBand > 0 ? userMaxRingsPerBand : Math.ceil(refinementReach / spacing),
  ))
  // Zs carrying horizontal model surface the cutter can actually reach, which
  // is what tells a tip apart from a continuing wall (issue #699). Keyed the
  // same way `uniqueDescendingZLevels` dedupes the ladder, so a critical floor
  // that merged with a stepdown one bit away is still recognised at the level
  // that survived.
  const criticalFloorZKeys = new Set([...criticalFloorZs].map(waterlineZKey))
  const isCriticalFloorZ = (z: number): boolean => criticalFloorZKeys.has(waterlineZKey(z))
  const buildRefinement = (
    spacing: number,
    activePass: WaterlineRefinementPass,
  ): ReturnType<typeof generateProjectedWaterlineLevels> => generateProjectedWaterlineLevels(
    projectedInputBuild,
    spacing,
    refinementGapThreshold,
    bandRingLimit(spacing),
    waterlineLengthEpsilon,
    intersectingAdds,
    toolOffset,
    tipStepdownDistance,
    projectedSliceAtZ,
    isCriticalFloorZ,
    shouldProjectToTargetContact,
    sliceBudget,
    activePass,
  )
  const refinementFootprintArea = heightMapFootprintArea(baseHeightMap)
  const refinementBudgetArea = WATERLINE_REFINEMENT_COVERAGE * refinementFootprintArea
  let effectiveStepover = stepoverDistance
  if (refinementEnabled && refinementBudgetArea > 0) {
    buildRefinement(stepoverDistance, refinementPass)
    if (sliceBudget.exceeded) return refuseMeshTooDense(sliceBudget, warnings)
    if (refinementPass.demandArea > refinementBudgetArea) {
      effectiveStepover = stepoverDistance * (refinementPass.demandArea / refinementBudgetArea)
    }
  }
  const projectedLevelBuild = refinementEnabled
    ? buildRefinement(effectiveStepover, { ...refinementPass, dryRun: false, demandArea: 0 })
    : null
  const coarseLevelsWithSuppressedCaps = projectedLevelBuild
    ? suppressProjectedCoarsePaths(
        coarseLevelBuild.levels,
        projectedLevelBuild.suppressedCoarsePaths,
        Math.max(waterlineLengthEpsilon, stepoverDistance * 0.25),
        waterlineLengthEpsilon,
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
          gapThreshold: refinementGapThreshold,
          microStepover: stepoverDistance,
          hitCap: false,
          hitPassLimit: false,
        },
      }
  if (sliceBudget.exceeded) return refuseMeshTooDense(sliceBudget, warnings)
  const waterlineLevels = refinedLevelBuild.levels
  // Slice material at each level — kept around so we can geometrically classify
  // each ring as tool-inside (pocket cavity, centroid in empty space) vs
  // tool-outside (around a bump or outer wall, centroid in solid material).
  // This is more reliable than inferring topology from Clipper's post-clip
  // winding, which can flip during open-path difference.
  const sliceMaterialByZ = refinedLevelBuild.sliceMaterialByZ

  // The refinement budget is a real bound on the surface produced, so it says so
  // out loud rather than in a `debug` line nobody has switched on (issue #698).
  if (effectiveStepover > stepoverDistance * (1 + 1e-9)) {
    warnings.push({
      code: 'waterlineRefinementCoarsened',
      params: {
        requested: stepoverDistance.toFixed(4),
        effective: effectiveStepover.toFixed(4),
      },
    })
  }
  if (refinedLevelBuild.metrics.hitCap) {
    warnings.push({
      code: 'waterlineRefinementTruncated',
      params: { rings: WATERLINE_PROJECTED_MAX_TOTAL_RINGS.toLocaleString() },
    })
  }

  if (operation.debugToolpath) {
    warnings.push({ code: 'debug', params: { text: `Debug: waterline refinement demand ` +
      `${refinementPass.demandArea.toFixed(2)} (${(refinementPass.demandArea / Math.max(refinementFootprintArea, 1e-9)).toFixed(2)}x footprint) ` +
      `against a budget of ${refinementBudgetArea.toFixed(2)} ` +
      `(${WATERLINE_REFINEMENT_COVERAGE}x a ${refinementFootprintArea.toFixed(2)} footprint), ` +
      `spacing ${stepoverDistance.toFixed(4)} -> ${effectiveStepover.toFixed(4)}` } })
    warnings.push({ code: 'debug', params: { text: `Debug: waterline densest slice ${sliceBudget.maxSlice} of a ` +
      `${sliceBudget.limit} vertex budget (${sliceBudget.spent} contour vertices over the whole operation) ` +
      `at a ${sliceDecimationTolerance.toFixed(6)} decimation tolerance` } })
    const metrics = refinedLevelBuild.metrics
    warnings.push({ code: 'debug', params: { text: `Debug: adaptive waterline inserted ${metrics.insertedLevels} projected rings (${coarseLevelBuild.levels.length} coarse levels → ${waterlineLevels.length} projected levels), ` +
      `maxGap=${metrics.maxObservedGap.toFixed(4)}, threshold=${metrics.gapThreshold.toFixed(4)}, spacing=${metrics.microStepover.toFixed(4)}` } })
    if (!adaptiveRefinementEnabled) {
      warnings.push({ code: 'debug', params: { text: 'Debug: adaptive waterline skipped because adaptive refinement is disabled' } })
    }
    if (regionFeatures.length > 0) {
      warnings.push({ code: 'debug', params: { text: 'Debug: adaptive waterline skipped because region-filtered waterline clipping must not emit boundary contours' } })
    }
    if (intersectingAdds.length > 0 && metrics.insertedLevels > 0) {
      warnings.push({ code: 'debug', params: { text: 'Debug: adaptive waterline projected bands were generated from mesh slices only; add-wall contours remain coarse' } })
    }
    if (metrics.hitCap || metrics.hitPassLimit) {
      warnings.push({ code: 'debug', params: { text: `Debug: adaptive waterline stopped before all gaps were accepted (${metrics.hitCap ? 'insert cap' : 'pass limit'})` } })
    }
  }

  // Flatten waterlineLevels into individual closed-ring entries. Each level may
  // carry multiple disjoint paths (outer-wall + pocket-walls + island-walls);
  // we machine each column (cluster of rings sharing an XY locus) as a unit so
  // the tool finishes one feature before traveling to the next.
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
    const realWaterlines = cluster
      .filter((entry) => !entry.source)
      .sort((a, b) => b.z - a.z)
    const projectedFills = cluster
      .filter((entry) => entry.source)
      .sort((a, b) => a.z - b.z)
    cluster.splice(0, cluster.length, ...realWaterlines, ...projectedFills)
  }
  // A terminal cap can be much smaller than the surrounding rings and thus
  // form its own XY cluster. Keep every cluster with a real waterline ahead
  // of projected-only clusters so adaptive fill remains a finishing step.
  clusters.sort((a, b) => {
    const aProjectedOnly = a.every((entry) => Boolean(entry.source))
    const bProjectedOnly = b.every((entry) => Boolean(entry.source))
    return Number(aProjectedOnly) - Number(bProjectedOnly)
  })

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
    warnings.push({ code: 'debug', params: { text: `Debug: ${waterlineLevels.length} waterline levels → ${allRingEntries.length} rings → ${clusters.length} columns` } })
  }

  const allMoves: ToolpathMove[] = []
  const allStepLevels = new Set<number>()
  let currentPosition: ToolpathPoint | null = null

  const depthWarning = checkMaxCutDepthWarning(tool, Math.abs(modelTopZ - effectiveBottom))
  if (depthWarning) warnings.push(depthWarning)
  const maxEntrySnapTolerance = Math.max(
    waterlineLengthEpsilon,
    Math.min(tool.radius * 0.25, convertLength(0.25, 'mm', project.meta.units)),
  )
  const entrySnapTolerance = Math.min(
    Math.max(waterlineLengthEpsilon, stepoverDistance * 0.5),
    maxEntrySnapTolerance,
  )
  const columnLinkDistance = Math.max(
    waterlineLengthEpsilon,
    Math.min(stepoverDistance * 1.5, tool.radius * 0.5),
  )

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
    : (): boolean => false

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

    // Walk this column with real waterline boundaries first, followed by
    // generated projected fill rings. Each ring's start is rotated to the
    // vertex closest to the previous ring's end so nearby column transitions
    // can reuse XY instead of retracting to safe Z.
    let previousRingHadCut = false
    for (const ringEntry of cluster) {
      let emittedRingCut = false
      const protectionQueryZ = ringEntry.z
      const protectedAtLevel = protectedPathsAtZ(protectionQueryZ)
      // Pre-generation region mask: clip the closed contour ring to keep
      // only the parts inside the composite allowed area.
      const regionClipped = compositeAllowedForRegion
        ? clipContourBoundariesToRegion([ringEntry.path], compositeAllowedForRegion)
        : { paths: [ringEntry.path], closed: [true] }
      if (regionClipped.paths.length === 0) {
        previousRingHadCut = false
        continue
      }
      const envelopeClippedRaw = contourClipEnvelope
        ? clipContourBoundariesToRegion(regionClipped.paths, contourClipEnvelope)
        : regionClipped
      const envelopeClipped = contourClipEnvelope
        ? trimOpenContourCaps(
            envelopeClippedRaw.paths,
            envelopeClippedRaw.closed,
            ringEntry.projectZAtPoint ? Math.max(toolOffset * 2, stepoverDistance * 4) : toolOffset * 2,
          )
        : envelopeClippedRaw
      if (envelopeClipped.paths.length === 0) {
        previousRingHadCut = false
        continue
      }

      // Additionally clip to the containing-subtract pocket active at this
      // ring's z. For stepped-pocket setups (old-man-in-box.camj), at z
      // below a shallower subtract's floor only the deeper subtract is
      // open; the shallower step area still has stock material at z and a
      // ring there would gouge through the step.
      const activeMachiningRegion = machiningRegionAtZ(protectionQueryZ)
      const machiningClipped = activeMachiningRegion
        ? clipContourBoundariesToRegion(envelopeClipped.paths, activeMachiningRegion)
        : envelopeClipped
      if (machiningClipped.paths.length === 0) {
        previousRingHadCut = false
        continue
      }
      const machiningClippedTrimmed = activeMachiningRegion
        ? trimOpenContourCaps(
            machiningClipped.paths,
            machiningClipped.closed,
            ringEntry.projectZAtPoint ? Math.max(toolOffset * 2, stepoverDistance * 4) : toolOffset * 2,
          )
        : machiningClipped
      if (machiningClippedTrimmed.paths.length === 0) {
        previousRingHadCut = false
        continue
      }
      // Clip the contour boundary (treated as a polyline) against protected
      // regions. Where a contour passes through an add-feature / clamp / tab,
      // the resulting OPEN polyline segments break around the protected region
      // — the tool then traces each segment with a retract between them, never
      // dipping into protected material and never chord-cutting across it.
      const protectedClipped = protectedAtLevel.length > 0
        ? clipContourBoundariesAgainstRegion(
            machiningClippedTrimmed.paths,
            protectedAtLevel,
            machiningClippedTrimmed.closed,
          )
        : machiningClippedTrimmed

      // Clip last, preserving open flags through all existing protection.
      const { paths: clippedPaths, closed: pathClosed } = slopeDomain === null ? protectedClipped
        : clipContourBoundariesByRegion(protectedClipped.paths, slopeDomain, protectedClipped.closed, true)
      if (clippedPaths.length === 0) {
        previousRingHadCut = false
        continue
      }

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
          contour = rotateContourToNearestEntry(contour, { x: currentPosition.x, y: currentPosition.y })
          if (slopeDomain === null) contour = snapClosedContourEntryToAnchor(contour, currentPosition, entrySnapTolerance)
        }

        const meshBoundaryPaths = intersectingAdds.length > 0 ? sliceMeshOnlyAtZ(ringEntry.z) : []
        const meshBoundaryTolerance = Math.max(stepoverDistance * 1.5, tool.radius * 0.15, 1e-5)
        const isNearMeshBoundary = (point: XYPoint): boolean => {
          if (meshBoundaryPaths.length === 0) return false
          const distance = distanceToClipperPathsBoundary(meshBoundaryPaths, point)
          return Math.abs(distance - toolOffset) <= meshBoundaryTolerance
        }
        const projectedZAtPoint = ringEntry.projectZAtPoint ?? (() => ringEntry.z)
        // A ball endmill offset horizontally by its full radius must run below
        // the original mesh-slice Z on a slope. Project zero-stock Waterline
        // rings onto the same swept-cutter contact surface used by Parallel;
        // otherwise the remaining material equals the slope-induced height
        // change across one tool radius.
        const shouldProjectRingToTargetContact = shouldProjectToTargetContact
          && (intersectingAdds.length === 0 || ringEntry.source === 'projectedCap')
        const zAtPoint = shouldProjectRingToTargetContact
          ? (point: XYPoint): number => {
              const contactZ = targetToolTipZAtPoint(point)
              const projectedZ = Number.isFinite(contactZ) ? contactZ : projectedZAtPoint(point)
              const pocketFloorZ = safeSubtractBottomZAtPoint(relatedSubtracts, point)
                ?? effectiveBottom
              // Height-map cells can miss a surface that is exactly tangent
              // to the cutter footprint at a vertical wall. A ball cannot
              // side-contact the nominal slice below sliceZ - radius, so keep
              // that geometric lower bound as the boundary fallback.
              const sideContactFloorZ = tool.type === 'ball_endmill'
                ? ringEntry.z - tool.radius
                : Number.NEGATIVE_INFINITY
              const minimumZ = Math.max(pocketFloorZ, sideContactFloorZ)
              return Math.max(projectedZ, minimumZ)
            }
          : projectedZAtPoint
        const shouldLiftForMeshSafety = !shouldProjectRingToTargetContact
          && (intersectingAdds.length > 0 || Boolean(ringEntry.projectZAtPoint))
        const liftedZAtPoint = shouldLiftForMeshSafety
          ? (point: XYPoint): number => {
              const baseZ = zAtPoint(point)
              if (
                intersectingAdds.length > 0
                && !ringEntry.projectZAtPoint
                && isNearMeshBoundary(point)
              ) return baseZ
              const safeMeshZ = intersectingAdds.length > 0
                ? safeToolTipZAt(point.x, point.y, safetyHeightMap, tool)
                : surfaceZAtPoint(point)
              if (!Number.isFinite(safeMeshZ)) return baseZ
              const intersectingAddClearance = intersectingAdds.length > 0 && !isNearMeshBoundary(point)
                ? stepoverDistance * 0.5
                : 0
              return Math.max(baseZ, safeMeshZ + intersectingAddClearance)
            }
          : zAtPoint
        if (ringEntry.projectZAtPoint) {
          if (!shouldProjectToTargetContact) {
            contour = densifyContour(contour, stepoverDistance / 2, waterlineLengthEpsilon, isClosed)
          }
          if (!isClosed && contourPolylineLength(contour, false) <= Math.max(toolOffset * 2, stepoverDistance * 2)) {
            continue
          }
        }
        const safeRuns = intersectingAdds.length > 0
          ? splitContourByTargetMeshSafety(
              contour,
              isClosed,
              zAtPoint,
              safetyHeightMap,
              tool,
              Math.max(1e-5, Math.min(stepoverDistance / 2, tool.radius / 4)),
              waterlineLengthEpsilon,
              meshBoundaryPaths,
              toolOffset,
              meshBoundaryTolerance,
            )
          : [{ contour, closed: isClosed }]

        let canLinkFromPreviousRing = previousRingHadCut && protectedAtLevel.length === 0
        for (const safeRun of safeRuns) {
          if (safeRun.contour.length < 2) continue
          if (!safeRun.closed && contourPolylineLength(safeRun.contour, false) <= Math.max(toolOffset * 0.5, stepoverDistance)) {
            continue
          }
          if (
            ringEntry.projectZAtPoint
            && safeRun.contour.every((point) => (
              liftedZAtPoint(point) > zAtPoint(point) + waterlineLengthEpsilon
            ))
          ) {
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
          const slopeSafeLink = slopeDomain === null ? undefined : (from: ToolpathPoint, to: ToolpathPoint): boolean => {
            if (!segmentInSurfaceDomain(slopeDomain, from, to)) return false
            const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / (heightMapCellSize / 2)))
            for (let sample = 0; sample <= steps; sample += 1) {
              const t = sample / steps
              const required = safeToolTipZAt(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, safetyHeightMap, tool)
              if (from.z + (to.z - from.z) * t + waterlineLengthEpsilon < required) return false
            }
            return true
          }
          if (currentPosition && slopeSafeLink && currentPosition.z < safeZ && !slopeSafeLink(currentPosition, entry)) {
            currentPosition = retractToSafe(allMoves, currentPosition, safeZ)
          }
          const moveCountBeforeTransition = allMoves.length
          currentPosition = transitionToCutEntry(
            allMoves,
            currentPosition,
            entry,
            safeZ,
            canLinkFromPreviousRing ? columnLinkDistance : 0,
            slopeSafeLink,
          )
          const transitionMove = allMoves[moveCountBeforeTransition]
          if (transitionMove?.kind === 'cut' && ringEntry.source) {
            transitionMove.source = ringEntry.source
          }
          canLinkFromPreviousRing = false
          const cutMovesForContour = shouldProjectToTargetContact
            || intersectingAdds.length > 0
            || ringEntry.projectZAtPoint
            ? toProjectedCutMoves(safeRun.contour, safeRun.closed, liftedZAtPoint, ringEntry.source)
            : safeRun.closed
              ? toClosedCutMoves(safeRun.contour, ringEntry.z)
              : toOpenCutMoves(safeRun.contour, ringEntry.z)
          // Approximate simplification could shortcut across a slope-mask corner.
          const simplified = slopeDomain === null ? simplifyContiguousCutMoves(cutMovesForContour) : cutMovesForContour
          appendAll(allMoves, simplified)
          for (const move of simplified) {
            allStepLevels.add(move.from.z)
            allStepLevels.add(move.to.z)
          }
          currentPosition = simplified.at(-1)?.to ?? entry
          emittedRingCut = emittedRingCut || simplified.length > 0
        }
      }
      previousRingHadCut = emittedRingCut
    }
  }

  const finalStepLevels = new Set<number>()
  for (const move of allMoves) {
    if (move.kind !== 'cut') continue
    finalStepLevels.add(move.from.z)
    finalStepLevels.add(move.to.z)
  }

  return {
    moves: allMoves,
    stepLevels: finalStepLevels.size > 0 ? finalStepLevels : allStepLevels,
  }
}
