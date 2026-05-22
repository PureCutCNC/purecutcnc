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
  buildProtectedFootprintPaths,
  clipperPathsToPointContours,
  offsetClipperPaths,
  pointInClipperPaths,
  unionClipperPaths,
  unionClipperPathsEvenOdd,
} from './modelProtection'
import { contourStartPoint, rotateContourToNearestEntry, toClosedCutMoves, toOpenCutMoves, transitionToCutEntry } from './pocket'
import { buildRegionMask, clipToolpathResultToRegionMask } from './regions'
import type { ClipperPath, NormalizedTool, ToolpathMove, ToolpathPoint } from './types'

const MIN_Z_STEP = 0.01

/**
 * Clip a set of CLOSED contour polygons against `clipPaths`, returning the
 * parts of each contour boundary that lie OUTSIDE the clip region.
 *
 * Returned paths are OPEN polylines (sequences of points the tool follows
 * without auto-closing). A contour that doesn't intersect the clip region is
 * returned as a closed polyline (start point repeated at end) — callers should
 * detect closure by comparing first/last points.
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

function clipContourBoundariesAgainstRegion(
  closedContourPaths: ClipperPath[],
  clipPaths: ClipperPath[],
): { paths: ClipperPath[]; closed: boolean[] } {
  if (closedContourPaths.length === 0) return { paths: [], closed: [] }
  if (clipPaths.length === 0) {
    return {
      paths: closedContourPaths,
      closed: closedContourPaths.map(() => true),
    }
  }

  // Treat each closed contour as an open polyline by appending the start point.
  const openSubjects: ClipperPath[] = closedContourPaths.map((path) => {
    if (path.length < 2) return path
    return [...path, { X: path[0].X, Y: path[0].Y }]
  })

  const clipper = new ClipperLib.Clipper()
  clipper.AddPaths(openSubjects, ClipperLib.PolyType.ptSubject, false)
  clipper.AddPaths(clipPaths, ClipperLib.PolyType.ptClip, true)
  const polytree = new ClipperLib.PolyTree()
  clipper.Execute(
    ClipperLib.ClipType.ctDifference,
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

function slicePolygonsToClipperPaths(slicePolygons: Array<Array<[number, number]>>): ClipperPath[] {
  const paths = slicePolygons
    .filter((poly) => poly.length >= 3)
    .map((poly) => toClipperPath(
      normalizeWinding(poly.map(([x, y]) => ({ x, y })), false),
      DEFAULT_CLIPPER_SCALE,
    ))
  return unionClipperPathsEvenOdd(paths)
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
}

function pointDistance3D(a: ToolpathPoint, b: ToolpathPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
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

  if (operation.debugToolpath) {
    warnings.push(
      `Debug: waterline mode, stepover=${stepoverDistance.toFixed(4)}, toolOffset=${toolOffset.toFixed(4)}`,
    )
  }

  const sliceAtZ = (z: number): ClipperPath[] => {
    // Slice biased slightly ABOVE the requested z so horizontal model floors
    // at z (bump bases, pocket rims) don't produce a degenerate empty slice.
    // The slicer skips triangles whose three vertices all sit on the plane,
    // so for a flat floor at exactly z we'd get 0 polygons — biasing up by
    // sliceSampleEpsilon catches the walls coming up from the floor instead.
    const clampedZ = z >= modelTopZ - sliceSampleEpsilon
      ? Math.max(effectiveBottom + sliceSampleEpsilon, modelTopZ - sliceSampleEpsilon)
      : Math.min(modelTopZ - sliceSampleEpsilon, Math.max(effectiveBottom + sliceSampleEpsilon, z + sliceSampleEpsilon))
    const polygons = sliceMeshAtZ(sliceIndex, clampedZ)
    if (polygons.length === 0) return []
    return slicePolygonsToClipperPaths(polygons)
  }

  const coarseLevels: WaterlineLevel[] = []
  // Slice material at each level — kept around so we can geometrically classify
  // each ring as tool-inside (pocket cavity, centroid in empty space) vs
  // tool-outside (around a bump or outer wall, centroid in solid material).
  // This is more reliable than inferring topology from Clipper's post-clip
  // winding, which can flip during open-path difference.
  const sliceMaterialByZ = new Map<number, ClipperPath[]>()
  {
    let shadow: ClipperPath[] = []
    for (const z of stepLevels) {
      const slice = sliceAtZ(z)
      if (slice.length > 0) {
        shadow = shadow.length === 0
          ? slice
          : unionClipperPaths([...shadow, ...slice])
      }
      sliceMaterialByZ.set(z, slice)
      coarseLevels.push({
        z,
        contourPaths: shadow.length > 0 ? offsetClipperPaths(shadow, toolOffset) : [],
      })
    }
  }

  // Flatten coarseLevels into individual closed-ring entries. Each level may
  // carry multiple disjoint paths (outer-wall + pocket-walls + island-walls);
  // we machine each column (cluster of rings sharing an XY locus) top-to-bottom
  // so the tool finishes one feature before traveling to the next.
  interface RingEntry {
    z: number
    path: ClipperPath
    bbox: { minX: number; maxX: number; minY: number; maxY: number }
  }
  const allRingEntries: RingEntry[] = []
  for (const level of coarseLevels) {
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
      allRingEntries.push({ z: level.z, path, bbox: { minX, maxX, minY, maxY } })
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
    coarseLevels.flatMap((level) => level.contourPaths),
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
      `Debug: ${coarseLevels.length} coarse levels → ${allRingEntries.length} rings → ${clusters.length} columns`,
    )
  }

  const allMoves: ToolpathMove[] = []
  const allStepLevels = new Set<number>()
  let currentPosition: ToolpathPoint | null = null

  const depthWarning = checkMaxCutDepthWarning(tool, Math.abs(modelTopZ - effectiveBottom))
  if (depthWarning) warnings.push(depthWarning)

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
      // Clip the contour boundary (treated as a polyline) against protected
      // regions. Where a contour passes through an add-feature / clamp / tab,
      // the resulting OPEN polyline segments break around the protected region
      // — the tool then traces each segment with a retract between them, never
      // dipping into protected material and never chord-cutting across it.
      const { paths: clippedPaths, closed: pathClosed } = protectedAtLevel.length > 0
        ? clipContourBoundariesAgainstRegion([ringEntry.path], protectedAtLevel)
        : { paths: [ringEntry.path], closed: [true] }

      if (clippedPaths.length === 0) continue

      const pointContours = clipperPathsToPointContours(clippedPaths)

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

        const cutZ = ringEntry.z
        allStepLevels.add(cutZ)
        const entry = isClosed ? contourStartPoint(contour, cutZ) : { ...contour[0], z: cutZ }
        currentPosition = transitionToCutEntry(allMoves, currentPosition, entry, safeZ, 0)
        if (isClosed) {
          allMoves.push(...simplifyContiguousCutMoves(toClosedCutMoves(contour, cutZ)))
        } else {
          allMoves.push(...simplifyContiguousCutMoves(toOpenCutMoves(contour, cutZ)))
        }
        currentPosition = { x: contour[contour.length - 1].x, y: contour[contour.length - 1].y, z: cutZ }
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
