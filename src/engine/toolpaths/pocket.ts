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
import type { CutDirection, Operation, Point, Project } from '../../types/project'
import type {
  ClipperPath,
  PocketToolpathResult,
  ResolvedPocketBand,
  ResolvedPocketRegion,
  ToolpathBounds,
  ToolpathMove,
  ToolpathPoint,
} from './types'
import {
  DEFAULT_CLIPPER_SCALE,
  applyContourDirection,
  checkMaxCutDepthWarning,
  fromClipperPath,
  getOperationSafeZ,
  normalizeWinding,
  normalizeToolForProject,
  resolveFeatureZSpan,
  toClipperPath,
} from './geometry'
import { isFeatureFirst, mergePocketToolpathResults, perFeatureOperations } from './multiFeature'
import { resolvePocketRegions } from './resolver'
import { buildRegionMask, clipToolpathResultToRegionMask, splitFeatureTargets } from './regions'

const MAX_ROUND_JOIN_ARC_TOLERANCE = DEFAULT_CLIPPER_SCALE * 0.01
const ROUND_JOIN_ARC_TOLERANCE_RATIO = 0.01

interface PolyTreeNode {
  IsHole(): boolean
  Contour(): ClipperPath
  Childs?: () => PolyTreeNode[]
  m_Childs?: PolyTreeNode[]
}

function getChildren(node: PolyTreeNode): PolyTreeNode[] {
  return node.Childs ? node.Childs() : (node.m_Childs ?? [])
}

/**
 * Remove consecutive vertices that are closer than minDist (in integer Clipper units).
 * Reduces noise introduced by Clipper offset operations.
 */
function cleanClipperPath(path: ClipperPath, minDist: number): ClipperPath {
  if (path.length === 0) return path
  const out: ClipperPath = [path[0]]
  for (let i = 1; i < path.length; i++) {
    const prev = out[out.length - 1]
    const cur = path[i]
    const dx = cur.X - prev.X
    const dy = cur.Y - prev.Y
    if (Math.sqrt(dx * dx + dy * dy) >= minDist) {
      out.push(cur)
    }
  }
  return out
}

function offsetPaths(
  paths: ClipperPath[],
  delta: number,
  joinType: number = ClipperLib.JoinType.jtMiter,
): ClipperPath[] {
  if (paths.length === 0) {
    return []
  }

  const offset = new ClipperLib.ClipperOffset()
  offset.ArcTolerance = Math.max(
    1,
    Math.min(MAX_ROUND_JOIN_ARC_TOLERANCE, Math.abs(delta) * ROUND_JOIN_ARC_TOLERANCE_RATIO),
  )
  offset.AddPaths(paths, joinType, ClipperLib.EndType.etClosedPolygon)
  const solution = new ClipperLib.Paths()
  offset.Execute(solution, delta)
  // Filter near-duplicate vertices (threshold: 1 Clipper unit ≈ 1/scale project units)
  return (solution as ClipperPath[]).map((path) => cleanClipperPath(path, 1.0))
}

export function executeDifference(subjectPaths: ClipperPath[], clipPaths: ClipperPath[]): PolyTreeNode {
  const clipper = new ClipperLib.Clipper()
  if (subjectPaths.length > 0) {
    clipper.AddPaths(subjectPaths, ClipperLib.PolyType.ptSubject, true)
  }
  if (clipPaths.length > 0) {
    clipper.AddPaths(clipPaths, ClipperLib.PolyType.ptClip, true)
  }

  const polyTree = new ClipperLib.PolyTree()
  clipper.Execute(
    ClipperLib.ClipType.ctDifference,
    polyTree,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  )

  return polyTree as PolyTreeNode
}

export function polyTreeToRegions(
  node: PolyTreeNode,
  targetFeatureIds: string[],
  islandFeatureIds: string[],
  scale = DEFAULT_CLIPPER_SCALE,
): ResolvedPocketRegion[] {
  const regions: ResolvedPocketRegion[] = []
  const contour = node.Contour()

  if (contour.length > 0 && !node.IsHole()) {
    const children = getChildren(node)
    const islands = children
      .filter((child) => child.IsHole())
      .map((child) => fromClipperPath(child.Contour(), scale))

    regions.push({
      outer: fromClipperPath(contour, scale),
      islands,
      targetFeatureIds,
      islandFeatureIds,
    })
  }

  for (const child of getChildren(node)) {
    regions.push(...polyTreeToRegions(child, targetFeatureIds, islandFeatureIds, scale))
  }

  return regions
}

export function contourStartPoint(points: Point[], z: number): ToolpathPoint {
  const first = points[0] ?? { x: 0, y: 0 }
  return { x: first.x, y: first.y, z }
}

export function toClosedCutMoves(points: Point[], z: number): ToolpathMove[] {
  if (points.length < 2) {
    return []
  }

  const moves: ToolpathMove[] = []
  for (let index = 0; index < points.length - 1; index += 1) {
    moves.push({
      kind: 'cut',
      from: { x: points[index].x, y: points[index].y, z },
      to: { x: points[index + 1].x, y: points[index + 1].y, z },
    })
  }

  const first = points[0]
  const last = points[points.length - 1]
  if (first.x !== last.x || first.y !== last.y) {
    moves.push({
      kind: 'cut',
      from: { x: last.x, y: last.y, z },
      to: { x: first.x, y: first.y, z },
    })
  }

  return moves
}

export function pushRapidAndPlunge(
  moves: ToolpathMove[],
  from: ToolpathPoint | null,
  toXY: ToolpathPoint,
  safeZ: number,
): ToolpathPoint {
  const start = from ?? { x: toXY.x, y: toXY.y, z: safeZ }

  if (!from || from.x !== toXY.x || from.y !== toXY.y || from.z !== safeZ) {
    moves.push({
      kind: 'rapid',
      from: start,
      to: { x: toXY.x, y: toXY.y, z: safeZ },
    })
  }

  moves.push({
    kind: 'plunge',
    from: { x: toXY.x, y: toXY.y, z: safeZ },
    to: toXY,
  })

  return toXY
}

export function retractToSafe(moves: ToolpathMove[], from: ToolpathPoint | null, safeZ: number): ToolpathPoint | null {
  if (!from) {
    return null
  }

  const safePoint = { x: from.x, y: from.y, z: safeZ }
  if (from.z !== safeZ) {
    moves.push({
      kind: 'rapid',
      from,
      to: safePoint,
    })
  }
  return safePoint
}

/**
 * Optional callback for deciding whether a straight tool-center segment from
 * `from` to `to` can be cut directly at Z (skipping retract/plunge). Returns
 * true when the segment is known to lie inside already-cleared material.
 */
export type SafeLinkCheck = (from: ToolpathPoint, to: ToolpathPoint) => boolean

type OffsetTraversalMode = 'outer-first' | 'inner-first'

const XY_ALIGN_EPS = 1e-6

/**
 * A cut is fully engaged (slotting) when the nearest path already cut at the
 * same level is about a tool diameter away — at that distance no neighbouring
 * kerf absorbs any of the tool's width. The factor leaves a margin so cuts a
 * few percent shy of a true slot still get the reduced feed. Cuts closer to a
 * prior kerf are over-engaged at most transiently (e.g. ring corners, whose
 * diagonal spacing exceeds the stepover) and keep the normal feed.
 */
const SLOT_FEED_ENGAGEMENT_FACTOR = 0.9

/**
 * Lower bound on the slot distance: a pass at exactly one stepover from its
 * neighbour must never be misclassified as engaged, even with stepovers close
 * to (or beyond) the engagement threshold.
 */
const SLOT_FEED_ADJACENCY_FACTOR = 1.05

/**
 * Lateral wiggle (as a fraction of the stepover) tolerated when deciding that
 * a prior kerf directly behind the tool is its own trail: below half a
 * stepover it cannot be a neighbouring pass, so it must be the path just cut.
 */
const SLOT_FEED_OWN_TRAIL_FACTOR = 0.45

/**
 * Resolve the operation's slot-feed percentage into a cut-feed multiplier.
 * Returns null when the reduction is disabled (non-pocket kinds, undefined,
 * out-of-range, or 100%), which callers use to skip all slot-feed work so the
 * generated move stream is byte-identical to the pre-feature output.
 */
function resolveSlotFeedScale(operation: Operation): number | null {
  if (operation.kind !== 'pocket') return null
  const percent = operation.pocketSlotFeedPercent
  if (percent === undefined || !(percent > 0) || percent >= 100) return null
  return percent / 100
}

interface PriorCutSegment {
  ax: number
  ay: number
  bx: number
  by: number
}

/**
 * Spatial index over previously cut segments: segments are inserted into every
 * grid cell their adjacency-inflated bounding box covers, so a point query
 * only has to test its own cell's bucket.
 */
class PriorCutIndex {
  private readonly cells = new Map<string, PriorCutSegment[]>()
  private readonly cellSize: number
  private readonly adjacency: number
  private readonly ownTrailLateralTolerance: number
  private readonly maxPieceLength: number

  constructor(cellSize: number, adjacency: number, ownTrailLateralTolerance: number, maxPieceLength: number) {
    this.cellSize = cellSize
    this.adjacency = adjacency
    this.ownTrailLateralTolerance = ownTrailLateralTolerance
    this.maxPieceLength = maxPieceLength
  }

  /**
   * Segments are stored in pieces no longer than maxPieceLength. The
   * directional query below tests each piece's closest point: with long
   * segments the closest point can collapse onto a shared corner and be
   * dismissed as the tool's own trail even though the rest of the kerf wraps
   * laterally around the query point (e.g. a link hopping diagonally out of a
   * ring corner). Short pieces provide those lateral witness points.
   */
  insert(segment: PriorCutSegment): void {
    const dx = segment.bx - segment.ax
    const dy = segment.by - segment.ay
    const length = Math.hypot(dx, dy)
    const pieceCount = Math.max(1, Math.ceil(length / this.maxPieceLength))
    for (let piece = 0; piece < pieceCount; piece += 1) {
      const t0 = piece / pieceCount
      const t1 = (piece + 1) / pieceCount
      this.insertPiece({
        ax: segment.ax + dx * t0,
        ay: segment.ay + dy * t0,
        bx: segment.ax + dx * t1,
        by: segment.ay + dy * t1,
      })
    }
  }

  private insertPiece(segment: PriorCutSegment): void {
    const pad = this.adjacency
    const colMin = Math.floor((Math.min(segment.ax, segment.bx) - pad) / this.cellSize)
    const colMax = Math.floor((Math.max(segment.ax, segment.bx) + pad) / this.cellSize)
    const rowMin = Math.floor((Math.min(segment.ay, segment.by) - pad) / this.cellSize)
    const rowMax = Math.floor((Math.max(segment.ay, segment.by) + pad) / this.cellSize)
    for (let col = colMin; col <= colMax; col += 1) {
      for (let row = rowMin; row <= rowMax; row += 1) {
        const key = `${col},${row}`
        const bucket = this.cells.get(key)
        if (bucket) {
          bucket.push(segment)
        } else {
          this.cells.set(key, [segment])
        }
      }
    }
  }

  /**
   * Is the point (x, y), moving in direction (dirX, dirY) (unit vector),
   * within the adjacency distance of a prior kerf that actually reduces the
   * tool's engagement? A prior whose closest point lies directly BEHIND the
   * motion (negative along-component, near-zero lateral offset) is the tool's
   * own trail — the kerf it just cut — and says nothing about the material
   * ahead, so it is ignored. Priors beside or ahead of the motion count.
   */
  isNearPrior(x: number, y: number, dirX: number, dirY: number): boolean {
    const bucket = this.cells.get(`${Math.floor(x / this.cellSize)},${Math.floor(y / this.cellSize)}`)
    if (!bucket) return false
    const adjacencySq = this.adjacency * this.adjacency
    for (const segment of bucket) {
      const dx = segment.bx - segment.ax
      const dy = segment.by - segment.ay
      const lengthSq = dx * dx + dy * dy
      const t = lengthSq > 0
        ? Math.max(0, Math.min(1, ((x - segment.ax) * dx + (y - segment.ay) * dy) / lengthSq))
        : 0
      const vx = segment.ax + dx * t - x
      const vy = segment.ay + dy * t - y
      if (vx * vx + vy * vy > adjacencySq) continue
      const along = vx * dirX + vy * dirY
      const lateral = Math.abs(vx * dirY - vy * dirX)
      if (along < 1e-9 && lateral < this.ownTrailLateralTolerance) continue
      return true
    }
    return false
  }
}

function interpolateMovePoint(move: ToolpathMove, t: number): ToolpathPoint {
  if (t <= 0) return { ...move.from }
  if (t >= 1) return { ...move.to }
  return {
    x: move.from.x + (move.to.x - move.from.x) * t,
    y: move.from.y + (move.to.y - move.from.y) * t,
    z: move.from.z + (move.to.z - move.from.z) * t,
  }
}

/**
 * Stamp the reduced slot feed onto the fully engaged portions of the cut
 * moves appended since startIndex (one Z level's worth of cutting).
 *
 * Engagement model: a cut is fully engaged (slotting) exactly when it runs
 * farther than `slotDistance` (about a tool diameter) from every path already
 * cut at this level — no neighbouring kerf is absorbing part of the tool's
 * width. This single rule covers every case: the first pass into virgin
 * material, each disjoint section's own inner start, ring segments crossing
 * uncleared pinch corridors, and link cuts through virgin strips — while
 * passes near an existing kerf (ordinary stepover rings, ring corners, the
 * back side of a thin loop overlapping its own kerf, and links crossing
 * already-cleared floor) keep the normal feed.
 *
 * Moves are classified in chunks of a quarter of the slot distance and split
 * where the classification changes. The tool's own trail — a prior kerf lying
 * directly behind the motion direction — is excluded from the test, so a
 * straight slot stays fully engaged however long it runs, while a genuinely
 * lateral neighbour (an adjacent scanline or ring, however recently cut)
 * counts immediately. `ownTrailTolerance` is the lateral wiggle allowed for
 * that behind-the-tool exclusion (covers gently curved trails). Rapids and
 * plunges are left untouched and don't count as cleared paths.
 */
function applySlotFeedToLevel(
  moves: ToolpathMove[],
  startIndex: number,
  scale: number,
  slotDistance: number,
  ownTrailTolerance: number,
): void {
  if (startIndex >= moves.length) return

  const chunkLength = slotDistance / 4
  const index = new PriorCutIndex(slotDistance, slotDistance, ownTrailTolerance, chunkLength)
  const stamped: ToolpathMove[] = []

  for (let moveIndex = startIndex; moveIndex < moves.length; moveIndex += 1) {
    const move = moves[moveIndex]
    if (move.kind !== 'cut') {
      stamped.push(move)
      continue
    }

    const dx = move.to.x - move.from.x
    const dy = move.to.y - move.from.y
    const length = Math.hypot(dx, dy)
    if (length <= 1e-9) {
      stamped.push(move)
      continue
    }
    const dirX = dx / length
    const dirY = dy / length

    const chunkCount = Math.max(1, Math.ceil(length / chunkLength))
    let fragmentStartT = 0
    let fragmentEngaged: boolean | null = null

    const emitFragment = (t0: number, t1: number, engaged: boolean) => {
      const from = interpolateMovePoint(move, t0)
      const to = interpolateMovePoint(move, t1)
      stamped.push(engaged ? { ...move, from, to, feedScale: scale } : { ...move, from, to })
    }

    for (let chunk = 0; chunk < chunkCount; chunk += 1) {
      const t0 = chunk / chunkCount
      const t1 = (chunk + 1) / chunkCount
      const tMid = (t0 + t1) / 2
      const engaged = !index.isNearPrior(
        move.from.x + dx * tMid,
        move.from.y + dy * tMid,
        dirX,
        dirY,
      )
      if (fragmentEngaged === null) {
        fragmentEngaged = engaged
      } else if (engaged !== fragmentEngaged) {
        emitFragment(fragmentStartT, t0, fragmentEngaged)
        fragmentStartT = t0
        fragmentEngaged = engaged
      }
    }
    emitFragment(fragmentStartT, 1, fragmentEngaged ?? true)

    index.insert({
      ax: move.from.x,
      ay: move.from.y,
      bx: move.to.x,
      by: move.to.y,
    })
  }

  moves.length = startIndex
  for (const move of stamped) {
    moves.push(move)
  }
}

export function transitionToCutEntry(
  moves: ToolpathMove[],
  from: ToolpathPoint | null,
  toXY: ToolpathPoint,
  safeZ: number,
  maxLinkDistance: number,
  safeLinkCheck?: SafeLinkCheck,
): ToolpathPoint {
  if (from) {
    const dx = toXY.x - from.x
    const dy = toXY.y - from.y
    const distance = Math.hypot(dx, dy)
    const dz = toXY.z - from.z

    // Same XY (within epsilon): no XY travel needed. If Z descends, plunge
    // straight down to the next cut start rather than retracting to safe Z
    // and re-plunging. If Z ascends, rapid up. Same Z: no-op.
    if (distance <= XY_ALIGN_EPS) {
      if (dz < -XY_ALIGN_EPS) {
        moves.push({ kind: 'plunge', from, to: toXY })
      } else if (dz > XY_ALIGN_EPS) {
        moves.push({ kind: 'rapid', from, to: toXY })
      }
      return toXY
    }

    const isStartingFromSafeZ = Math.abs(from.z - safeZ) <= XY_ALIGN_EPS
    const isDescendingToCut = toXY.z < safeZ - XY_ALIGN_EPS
    if (isStartingFromSafeZ && isDescendingToCut) {
      // After a level retract, keep XY travel at safe Z and enter the next level vertically.
      return pushRapidAndPlunge(moves, from, toXY, safeZ)
    }

    if (distance <= maxLinkDistance) {
      // Direct cut link — works across Z levels (3D cut moves are valid
      // for ramping between layers in roughing/surface operations). When
      // a safe-link check is supplied it must also approve the segment;
      // this is the path used by 3D roughing to link offset rings at Z
      // inside the previously cleared area instead of round-tripping
      // through safe Z.
      if (!safeLinkCheck || safeLinkCheck(from, toXY)) {
        moves.push({
          kind: 'cut',
          from,
          to: toXY,
        })
        return toXY
      }
    }
  }

  const safePosition = retractToSafe(moves, from, safeZ)
  return pushRapidAndPlunge(moves, safePosition, toXY, safeZ)
}

export function generateStepLevels(topZ: number, bottomZ: number, stepdown: number): number[] {
  if (!(stepdown > 0)) {
    return [bottomZ]
  }

  const descending = bottomZ < topZ
  if (!descending) {
    return [bottomZ]
  }

  const levels: number[] = []
  let current = topZ
  while (current - stepdown > bottomZ) {
    current -= stepdown
    levels.push(current)
  }
  levels.push(bottomZ)
  return levels
}

export function resolveBandBottomZ(band: ResolvedPocketBand, operation: Operation): number | null {
  const descending = band.bottomZ < band.topZ
  const axialLeave = Math.max(0, operation.stockToLeaveAxial)
  const effectiveBottom = descending
    ? band.bottomZ + axialLeave
    : band.bottomZ - axialLeave

  if (descending && effectiveBottom >= band.topZ) {
    return null
  }

  if (!descending && effectiveBottom <= band.topZ) {
    return null
  }

  return effectiveBottom
}

export function updateBounds(bounds: ToolpathBounds | null, point: ToolpathPoint): ToolpathBounds {
  if (!bounds) {
    return {
      minX: point.x,
      minY: point.y,
      minZ: point.z,
      maxX: point.x,
      maxY: point.y,
      maxZ: point.z,
    }
  }

  return {
    minX: Math.min(bounds.minX, point.x),
    minY: Math.min(bounds.minY, point.y),
    minZ: Math.min(bounds.minZ, point.z),
    maxX: Math.max(bounds.maxX, point.x),
    maxY: Math.max(bounds.maxY, point.y),
    maxZ: Math.max(bounds.maxZ, point.z),
  }
}

export function buildInsetRegions(
  region: ResolvedPocketRegion,
  delta: number,
  outerJoinType: number = ClipperLib.JoinType.jtMiter,
  islandJoinType: number = outerJoinType,
): ResolvedPocketRegion[] {
  const scale = DEFAULT_CLIPPER_SCALE
  const outerPath = toClipperPath(normalizeWinding(region.outer, false), scale)
  const islandPaths = region.islands.map((island) => toClipperPath(normalizeWinding(island, false), scale))

  const insetOuterPaths = offsetPaths([outerPath], -delta * scale, outerJoinType)
  if (insetOuterPaths.length === 0) {
    return []
  }

  const expandedIslandPaths = offsetPaths(islandPaths, delta * scale, islandJoinType)
  const clipped = executeDifference(insetOuterPaths, expandedIslandPaths)
  return polyTreeToRegions(clipped, region.targetFeatureIds, region.islandFeatureIds, scale)
    .filter((nextRegion) => nextRegion.outer.length >= 3)
}

export function buildContourLoops(regions: ResolvedPocketRegion[]): Point[][] {
  const contours: Point[][] = []

  for (const region of regions) {
    if (region.outer.length >= 3) {
      contours.push(region.outer)
    }

    for (const island of region.islands) {
      if (island.length >= 3) {
        contours.push(island)
      }
    }
  }

  return contours
}

function buildExpandedIslandContours(
  regions: ResolvedPocketRegion[],
  delta: number,
  joinType: number,
): Point[][] {
  const scale = DEFAULT_CLIPPER_SCALE
  return regions.flatMap((region) => {
    const islandPaths = region.islands.map((island) => toClipperPath(normalizeWinding(island, false), scale))
    return offsetPaths(islandPaths, delta * scale, joinType)
      .map((path) => fromClipperPath(path, scale))
      .filter((island) => island.length >= 3)
  })
}

function withoutDuplicateClosingPoint(points: Point[]): Point[] {
  return points.length > 1 && pointEpsilonEqual(points[0], points[points.length - 1])
    ? points.slice(0, -1)
    : points
}

function isAcuteCorner(points: Point[], index: number): boolean {
  const count = points.length
  if (count < 3) return false
  const current = points[index]
  const previous = points[(index + count - 1) % count]
  const next = points[(index + 1) % count]
  const previousVector = { x: previous.x - current.x, y: previous.y - current.y }
  const nextVector = { x: next.x - current.x, y: next.y - current.y }
  const previousLength = Math.hypot(previousVector.x, previousVector.y)
  const nextLength = Math.hypot(nextVector.x, nextVector.y)
  if (previousLength <= 1e-9 || nextLength <= 1e-9) return false
  const cosine = (
    previousVector.x * nextVector.x + previousVector.y * nextVector.y
  ) / (previousLength * nextLength)
  return cosine > 1e-6
}

function circularPointRun(points: Point[], start: number, end: number): Point[] {
  const run: Point[] = []
  for (let index = start; ; index = (index + 1) % points.length) {
    run.push(points[index])
    if (index === end) break
  }
  return run
}

function extractRoundedCornerSegment(contour: Point[], corner: Point, delta: number): Point[] {
  if (contour.length < 2) return []
  const threshold = delta + Math.max(delta * 0.04, 2 / DEFAULT_CLIPPER_SCALE)
  const withinThreshold = (index: number) =>
    Math.sqrt(distanceSquared(contour[(index + contour.length) % contour.length], corner)) <= threshold
  let nearestIndex = 0
  let nearestDistance = Number.POSITIVE_INFINITY
  for (let index = 0; index < contour.length; index += 1) {
    const distance = distanceSquared(contour[index], corner)
    if (distance < nearestDistance) {
      nearestIndex = index
      nearestDistance = distance
    }
  }
  if (Math.sqrt(nearestDistance) > threshold) return []

  let start = nearestIndex
  for (let scanned = 0; scanned < contour.length - 1 && withinThreshold(start - 1); scanned += 1) {
    start = (start + contour.length - 1) % contour.length
  }
  let end = nearestIndex
  for (let scanned = 0; scanned < contour.length - 1 && withinThreshold(end + 1); scanned += 1) {
    end = (end + 1) % contour.length
  }

  const segment = circularPointRun(contour, start, end)
  return segment.length >= 2 ? segment : []
}

function buildAcuteIslandCornerCleanupSegments(regions: ResolvedPocketRegion[], delta: number): Point[][] {
  const scale = DEFAULT_CLIPPER_SCALE
  const segments: Point[][] = []
  for (const region of regions) {
    for (const island of region.islands) {
      const sourcePoints = withoutDuplicateClosingPoint(island)
      const acuteCorners = sourcePoints.filter((_, index) => isAcuteCorner(sourcePoints, index))
      if (acuteCorners.length === 0) continue

      const islandPath = toClipperPath(normalizeWinding(sourcePoints, false), scale)
      const offsetContours = offsetPaths([islandPath], delta * scale, ClipperLib.JoinType.jtRound)
        .map((path) => fromClipperPath(path, scale))
        .filter((contour) => contour.length >= 3)
      for (const corner of acuteCorners) {
        const candidates = offsetContours
          .map((contour) => extractRoundedCornerSegment(contour, corner, delta))
          .filter((segment) => segment.length >= 2)
        if (candidates.length > 0) {
          segments.push(candidates.sort((left, right) => right.length - left.length)[0])
        }
      }
    }
  }
  return segments
}

export function buildOuterContours(regions: ResolvedPocketRegion[]): Point[][] {
  return regions
    .map((region) => region.outer)
    .filter((contour) => contour.length >= 3)
}

export function buildPocketFloorContours(
  regions: ResolvedPocketRegion[],
  initialInset: number,
  stepoverDistance: number,
): Point[][] {
  const contours: Point[][] = []
  const minStepover = 1 / DEFAULT_CLIPPER_SCALE
  const effectiveStepover = Math.max(stepoverDistance, minStepover)
  let currentRegions = regions.flatMap((region) => buildInsetRegions(region, initialInset))

  // Floor cleanup should not implicitly double as a wall-finish contour.
  // Start one stepover inside the finish boundary so "Finish Floor" can be
  // used independently from "Finish Walls".
  currentRegions = currentRegions.flatMap((region) => buildInsetRegions(region, effectiveStepover))

  while (currentRegions.length > 0) {
    const loops = buildOuterContours(currentRegions)
    if (loops.length === 0) {
      break
    }

    contours.push(...loops)
    currentRegions = currentRegions.flatMap((region) => buildInsetRegions(region, effectiveStepover))
  }

  return contours
}

function pointEpsilonEqual(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) <= 1e-9 && Math.abs(a.y - b.y) <= 1e-9
}

function polygonYBounds(points: Point[]): { minY: number; maxY: number } | null {
  if (points.length < 3) {
    return null
  }

  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const point of points) {
    minY = Math.min(minY, point.y)
    maxY = Math.max(maxY, point.y)
  }

  return Number.isFinite(minY) && Number.isFinite(maxY) ? { minY, maxY } : null
}

function scanlineIntervals(points: Point[], y: number): Array<[number, number]> {
  const intersections: number[] = []
  const closed =
    points.length > 0 && pointEpsilonEqual(points[0], points[points.length - 1])
      ? points
      : [...points, points[0]]

  for (let index = 0; index < closed.length - 1; index += 1) {
    const a = closed[index]
    const b = closed[index + 1]

    if (Math.abs(a.y - b.y) <= 1e-9) {
      continue
    }

    const intersects =
      (a.y <= y && b.y > y) ||
      (b.y <= y && a.y > y)

    if (!intersects) {
      continue
    }

    const t = (y - a.y) / (b.y - a.y)
    intersections.push(a.x + (b.x - a.x) * t)
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

function subtractIntervals(
  baseIntervals: Array<[number, number]>,
  clipIntervals: Array<[number, number]>,
): Array<[number, number]> {
  let remaining = [...baseIntervals]

  for (const [clipStart, clipEnd] of clipIntervals) {
    const next: Array<[number, number]> = []
    for (const [start, end] of remaining) {
      if (clipEnd <= start || clipStart >= end) {
        next.push([start, end])
        continue
      }

      if (clipStart > start) {
        next.push([start, clipStart])
      }
      if (clipEnd < end) {
        next.push([clipEnd, end])
      }
    }
    remaining = next
  }

  return remaining.filter(([start, end]) => end - start > 1e-9)
}

function rotatePoint(point: Point, cosTheta: number, sinTheta: number): Point {
  return {
    x: point.x * cosTheta - point.y * sinTheta,
    y: point.x * sinTheta + point.y * cosTheta,
  }
}

function distanceSquared(a: Point, b: Point): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return dx * dx + dy * dy
}

function contourNearestVertexIndex(points: Point[], anchor: Point): { index: number; distance: number } {
  let bestIndex = 0
  let bestDistance = Number.POSITIVE_INFINITY

  for (let index = 0; index < points.length; index += 1) {
    const distance = distanceSquared(anchor, points[index])
    if (distance < bestDistance) {
      bestIndex = index
      bestDistance = distance
    }
  }

  return { index: bestIndex, distance: bestDistance }
}

function contourNearestVertexDistance(points: Point[], anchor: Point): number {
  return contourNearestVertexIndex(points, anchor).distance
}

function rotateClosedContour(points: Point[], startIndex: number): Point[] {
  if (points.length <= 1 || startIndex <= 0 || startIndex >= points.length) {
    return points
  }

  return [...points.slice(startIndex), ...points.slice(0, startIndex)]
}

function contourEntryDistanceSquared(points: Point[], anchor: Point): number {
  if (points.length === 0) {
    return Number.POSITIVE_INFINITY
  }

  return contourNearestVertexDistance(points, anchor)
}

export function rotateContourToNearestEntry(points: Point[], anchor: Point | null): Point[] {
  if (points.length === 0 || anchor === null) {
    return points
  }

  const { index } = contourNearestVertexIndex(points, anchor)
  return rotateClosedContour(points, index)
}

function rotateContourToBestEntry(
  points: Point[],
  fromAnchor: Point | null,
  nextAnchors: Point[],
): Point[] {
  if (points.length === 0) {
    return points
  }

  let bestIndex = 0
  let bestScore = Number.POSITIVE_INFINITY

  for (let index = 0; index < points.length; index += 1) {
    const candidate = points[index]
    const fromDistance = fromAnchor ? distanceSquared(fromAnchor, candidate) : 0
    const nextDistance = nextAnchors.length > 0
      ? Math.min(...nextAnchors.map((anchor) => distanceSquared(anchor, candidate)))
      : 0
    const score = fromDistance + nextDistance

    if (score < bestScore) {
      bestIndex = index
      bestScore = score
    }
  }

  return rotateClosedContour(points, bestIndex)
}

function contourAnchorPoint(points: Point[]): Point | null {
  const first = points[0]
  return first ? { x: first.x, y: first.y } : null
}

function regionEntryDistanceSquared(region: ResolvedPocketRegion, anchor: Point): number {
  return contourEntryDistanceSquared(region.outer, anchor)
}

export function orderRegionsGreedy(regions: ResolvedPocketRegion[], start: Point | null): ResolvedPocketRegion[] {
  if (regions.length <= 1 || start === null) {
    return regions
  }

  const remaining = [...regions]
  const ordered: ResolvedPocketRegion[] = []
  let current = start

  while (remaining.length > 0) {
    let bestIndex = 0
    let bestDistance = Number.POSITIVE_INFINITY

    for (let index = 0; index < remaining.length; index += 1) {
      const distance = regionEntryDistanceSquared(remaining[index], current)
      if (distance < bestDistance) {
        bestIndex = index
        bestDistance = distance
      }
    }

    const [nextRegion] = remaining.splice(bestIndex, 1)
    ordered.push(nextRegion)
    current = contourAnchorPoint(nextRegion.outer) ?? current
  }

  return ordered
}

export function orderClosedContoursGreedy(contours: Point[][], start: Point | null): Point[][] {
  if (contours.length <= 1 || start === null) {
    return contours
  }

  const remaining = contours
    .filter((contour) => contour.length >= 3)
    .map((contour) => [...contour])
  const ordered: Point[][] = []
  let current = start

  while (remaining.length > 0) {
    let bestIndex = 0
    let bestDistance = Number.POSITIVE_INFINITY

    for (let index = 0; index < remaining.length; index += 1) {
      const distance = contourEntryDistanceSquared(remaining[index], current)
      if (distance < bestDistance) {
        bestIndex = index
        bestDistance = distance
      }
    }

    const [nextContour] = remaining.splice(bestIndex, 1)
    const rotated = rotateContourToNearestEntry(nextContour, current)
    ordered.push(rotated)
    current = contourAnchorPoint(rotated) ?? current
  }

  return ordered
}

function orderClosedContoursGreedyPreservingRotation(contours: Point[][], start: Point | null): Point[][] {
  if (contours.length <= 1 || start === null) {
    return contours
  }

  const remaining = contours
    .filter((contour) => contour.length >= 3)
    .map((contour) => [...contour])
  const ordered: Point[][] = []
  let current = start

  while (remaining.length > 0) {
    let bestIndex = 0
    let bestDistance = Number.POSITIVE_INFINITY

    for (let index = 0; index < remaining.length; index += 1) {
      const distance = contourEntryDistanceSquared(remaining[index], current)
      if (distance < bestDistance) {
        bestIndex = index
        bestDistance = distance
      }
    }

    const [nextContour] = remaining.splice(bestIndex, 1)
    ordered.push(nextContour)
    current = contourAnchorPoint(nextContour) ?? current
  }

  return ordered
}

export function orderOpenSegmentsGreedy(segments: Point[][], start: Point | null): Point[][] {
  if (segments.length <= 1 || start === null) {
    return segments
  }

  const remaining = segments
    .filter((segment) => segment.length >= 2)
    .map((segment) => [...segment])
  const ordered: Point[][] = []
  let current = start

  while (remaining.length > 0) {
    let bestIndex = 0
    let bestReverse = false
    let bestDistance = Number.POSITIVE_INFINITY

    for (let index = 0; index < remaining.length; index += 1) {
      const segment = remaining[index]
      const first = segment[0]
      const last = segment[segment.length - 1]
      const forwardDistance = distanceSquared(current, first)
      if (forwardDistance < bestDistance) {
        bestIndex = index
        bestReverse = false
        bestDistance = forwardDistance
      }

      const reverseDistance = distanceSquared(current, last)
      if (reverseDistance < bestDistance) {
        bestIndex = index
        bestReverse = true
        bestDistance = reverseDistance
      }
    }

    const [nextSegment] = remaining.splice(bestIndex, 1)
    const orderedSegment = bestReverse ? [...nextSegment].reverse() : nextSegment
    ordered.push(orderedSegment)
    current = orderedSegment[orderedSegment.length - 1]
  }

  return ordered
}

export function buildPocketParallelSegments(
  regions: ResolvedPocketRegion[],
  stepoverDistance: number,
  angleDeg: number,
): Point[][] {
  const segments: Point[][] = []
  const minStepover = 1 / DEFAULT_CLIPPER_SCALE
  const step = Math.max(stepoverDistance, minStepover)
  const angleRad = (angleDeg * Math.PI) / 180
  const cosForward = Math.cos(angleRad)
  const sinForward = Math.sin(angleRad)
  const cosInverse = Math.cos(-angleRad)
  const sinInverse = Math.sin(-angleRad)

  regions.forEach((region, regionIndex) => {
    const rotatedOuter = region.outer.map((point) => rotatePoint(point, cosInverse, sinInverse))
    const rotatedIslands = region.islands.map((island) => island.map((point) => rotatePoint(point, cosInverse, sinInverse)))
    const bounds = polygonYBounds(rotatedOuter)
    if (!bounds) {
      return
    }

    let scanIndex = 0
    for (let y = bounds.minY + step / 2; y < bounds.maxY - step / 2 + 1e-9; y += step) {
      const outerIntervals = scanlineIntervals(rotatedOuter, y)
      if (outerIntervals.length === 0) {
        scanIndex += 1
        continue
      }

      const islandIntervals = rotatedIslands.flatMap((island) => scanlineIntervals(island, y))
      const fillIntervals = subtractIntervals(outerIntervals, islandIntervals)

      for (const [startX, endX] of fillIntervals) {
        const left = rotatePoint({ x: startX, y }, cosForward, sinForward)
        const right = rotatePoint({ x: endX, y }, cosForward, sinForward)
        const reverse = (regionIndex + scanIndex) % 2 === 1
        segments.push(reverse ? [right, left] : [left, right])
      }

      scanIndex += 1
    }
  })

  return segments
}

export function cutClosedContours(
  moves: ToolpathMove[],
  contours: Point[][],
  z: number,
  safeZ: number,
  maxLinkDistance: number,
  currentPosition: ToolpathPoint | null,
  preserveContourRotation = false,
  direction: CutDirection = 'conventional',
  safeLinkCheck?: SafeLinkCheck,
): ToolpathPoint | null {
  const directedContours = applyContourDirection(contours, direction)
  const start = currentPosition ? { x: currentPosition.x, y: currentPosition.y } : null
  const orderedContours = preserveContourRotation
    ? orderClosedContoursGreedyPreservingRotation(directedContours, start)
    : orderClosedContoursGreedy(directedContours, start)

  let nextPosition = currentPosition
  for (const contour of orderedContours) {
    const entryPoint = contourStartPoint(contour, z)
    nextPosition = transitionToCutEntry(moves, nextPosition, entryPoint, safeZ, maxLinkDistance, safeLinkCheck)
    const cutMoves = toClosedCutMoves(contour, z)
    moves.push(...cutMoves)
    nextPosition = cutMoves.at(-1)?.to ?? nextPosition
  }

  return nextPosition
}

interface OffsetRegionNode {
  region: ResolvedPocketRegion
  children: OffsetRegionNode[]
}

/**
 * Precompute the offset ring tree for a region. The successive insets depend
 * only on the region geometry and stepover — not on Z — so callers cutting
 * several step levels build the tree once and traverse it per level instead
 * of redoing the Clipper offsets at every level.
 */
function buildOffsetRegionTree(region: ResolvedPocketRegion, stepoverDistance: number): OffsetRegionNode {
  const childRegions = buildInsetRegions(region, stepoverDistance)
  return {
    region,
    children: childRegions.map((child) => buildOffsetRegionTree(child, stepoverDistance)),
  }
}

function orderNodesGreedy(nodes: OffsetRegionNode[], start: Point | null): OffsetRegionNode[] {
  if (nodes.length <= 1 || start === null) {
    return nodes
  }
  const byRegion = new Map(nodes.map((node) => [node.region, node]))
  return orderRegionsGreedy(nodes.map((node) => node.region), start)
    .map((region) => byRegion.get(region) as OffsetRegionNode)
}

function cutOffsetRegionNode(
  moves: ToolpathMove[],
  node: OffsetRegionNode,
  z: number,
  safeZ: number,
  maxLinkDistance: number,
  currentPosition: ToolpathPoint | null,
  direction: CutDirection,
  safeLinkCheck: SafeLinkCheck | undefined,
  traversalMode: OffsetTraversalMode,
  loops: 'all' | 'outer' = 'all',
): ToolpathPoint | null {
  const cutCurrentRegion = (fromPosition: ToolpathPoint | null): ToolpathPoint | null => {
    const childAnchors = traversalMode === 'outer-first'
      ? node.children
        .map((child) => child.region.outer)
        .filter((contour) => contour.length > 0)
        .map((contour) => contour[0])
      : []
    // 'outer' cuts only the region's outer boundary loop — used by the finish
    // floor pass, where island walls are the wall pass's job, matching the
    // outer-contours-only coverage of buildPocketFloorContours.
    const contours = loops === 'outer'
      ? (node.region.outer.length >= 3 ? [node.region.outer] : [])
      : buildContourLoops([node.region])
    const preparedContours = contours.map((contour) => rotateContourToBestEntry(
      contour,
      fromPosition ? { x: fromPosition.x, y: fromPosition.y } : null,
      childAnchors,
    ))

    return cutClosedContours(
      moves,
      preparedContours,
      z,
      safeZ,
      maxLinkDistance,
      fromPosition,
      true,
      direction,
      safeLinkCheck,
    )
  }

  let nextPosition = currentPosition
  if (traversalMode === 'outer-first') {
    nextPosition = cutCurrentRegion(nextPosition)
  }

  const orderedChildren = orderNodesGreedy(
    node.children,
    nextPosition ? { x: nextPosition.x, y: nextPosition.y } : null,
  )

  for (const childNode of orderedChildren) {
    nextPosition = cutOffsetRegionNode(
      moves,
      childNode,
      z,
      safeZ,
      maxLinkDistance,
      nextPosition,
      direction,
      safeLinkCheck,
      traversalMode,
      loops,
    )
  }

  if (traversalMode === 'inner-first') {
    nextPosition = cutCurrentRegion(nextPosition)
  }

  return nextPosition
}

export function cutOffsetRegionRecursive(
  moves: ToolpathMove[],
  region: ResolvedPocketRegion,
  z: number,
  safeZ: number,
  stepoverDistance: number,
  maxLinkDistance: number,
  currentPosition: ToolpathPoint | null,
  direction: CutDirection = 'conventional',
  safeLinkCheck?: SafeLinkCheck,
  traversalMode: OffsetTraversalMode = 'outer-first',
): ToolpathPoint | null {
  return cutOffsetRegionNode(
    moves,
    buildOffsetRegionTree(region, stepoverDistance),
    z,
    safeZ,
    maxLinkDistance,
    currentPosition,
    direction,
    safeLinkCheck,
    traversalMode,
  )
}

export function toOpenCutMoves(points: Point[], z: number): ToolpathMove[] {
  if (points.length < 2) {
    return []
  }

  const moves: ToolpathMove[] = []
  for (let index = 0; index < points.length - 1; index += 1) {
    moves.push({
      kind: 'cut',
      from: { x: points[index].x, y: points[index].y, z },
      to: { x: points[index + 1].x, y: points[index + 1].y, z },
    })
  }

  return moves
}

function generateRoughBandMoves(
  band: ResolvedPocketBand,
  operation: Operation,
  safeZ: number,
  stepdown: number,
  toolRadius: number,
  stepoverDistance: number,
  maxLinkDistance: number,
  direction: CutDirection = 'conventional',
): { moves: ToolpathMove[]; stepLevels: number[]; warnings: string[] } {
  const moves: ToolpathMove[] = []
  const warnings: string[] = []
  const effectiveBottom = resolveBandBottomZ(band, operation)
  if (effectiveBottom === null) {
    return {
      moves,
      stepLevels: [],
      warnings: [`Band ${band.topZ} -> ${band.bottomZ} leaves no roughing depth after axial stock-to-leave`],
    }
  }

  const radialLeave = Math.max(0, operation.stockToLeaveRadial)
  const initialInset = toolRadius + radialLeave
  const stepLevels = generateStepLevels(band.topZ, effectiveBottom, stepdown)
  const minStepover = 1 / DEFAULT_CLIPPER_SCALE
  const effectiveStepover = Math.max(stepoverDistance, minStepover)
  const slotScale = resolveSlotFeedScale(operation)
  const slotDistance = Math.max(
    toolRadius * 2 * SLOT_FEED_ENGAGEMENT_FACTOR,
    effectiveStepover * SLOT_FEED_ADJACENCY_FACTOR,
  )
  let currentPosition: ToolpathPoint | null = null

  if (operation.kind === 'pocket' && operation.pocketPattern === 'parallel') {
    const roughRegions = band.regions.flatMap((region) => buildInsetRegions(region, initialInset))
    if (roughRegions.length === 0) {
      return {
        moves,
        stepLevels,
        warnings: [`No machinable parallel floor region for band ${band.topZ} -> ${band.bottomZ}`],
      }
    }

    const boundaryContours = applyContourDirection(buildContourLoops(roughRegions), direction)
    const segments = buildPocketParallelSegments(roughRegions, effectiveStepover, operation.pocketAngle)
    if (segments.length === 0) {
      return {
        moves,
        stepLevels,
        warnings: [`No machinable parallel floor segments for band ${band.topZ} -> ${band.bottomZ}`],
      }
    }

    for (const z of stepLevels) {
      const levelStartIndex = moves.length
      for (const contour of boundaryContours) {
        const entryPoint = contourStartPoint(contour, z)
        currentPosition = transitionToCutEntry(moves, currentPosition, entryPoint, safeZ, maxLinkDistance)
        const cutMoves = toClosedCutMoves(contour, z)
        moves.push(...cutMoves)
        currentPosition = cutMoves.at(-1)?.to ?? currentPosition
      }

      const orderedSegments = orderOpenSegmentsGreedy(
        segments,
        currentPosition ? { x: currentPosition.x, y: currentPosition.y } : null,
      )

      for (const segment of orderedSegments) {
        const entryPoint = contourStartPoint(segment, z)
        currentPosition = transitionToCutEntry(moves, currentPosition, entryPoint, safeZ, maxLinkDistance)
        const cutMoves = toOpenCutMoves(segment, z)
        moves.push(...cutMoves)
        currentPosition = cutMoves.at(-1)?.to ?? currentPosition
      }

      if (slotScale !== null) {
        applySlotFeedToLevel(moves, levelStartIndex, slotScale, slotDistance, effectiveStepover * SLOT_FEED_OWN_TRAIL_FACTOR)
      }

      currentPosition = retractToSafe(moves, currentPosition, safeZ)
    }

    return { moves, stepLevels, warnings }
  }

  // The offset ring tree is identical at every step level — build it once
  // and traverse it per level.
  const regionTrees = band.regions
    .flatMap((region) => buildInsetRegions(region, initialInset))
    .map((region) => buildOffsetRegionTree(region, effectiveStepover))

  for (const z of stepLevels) {
    if (regionTrees.length === 0) {
      warnings.push(`No machinable offset contours for band ${band.topZ} -> ${band.bottomZ}`)
      currentPosition = retractToSafe(moves, currentPosition, safeZ)
      continue
    }

    const levelStartIndex = moves.length
    const orderedTrees = orderNodesGreedy(
      regionTrees,
      currentPosition ? { x: currentPosition.x, y: currentPosition.y } : null,
    )

    for (const tree of orderedTrees) {
      currentPosition = cutOffsetRegionNode(
        moves,
        tree,
        z,
        safeZ,
        maxLinkDistance,
        currentPosition,
        direction,
        undefined,
        'inner-first',
      )
    }

    if (slotScale !== null) {
      applySlotFeedToLevel(moves, levelStartIndex, slotScale, slotDistance, effectiveStepover * SLOT_FEED_OWN_TRAIL_FACTOR)
    }

    currentPosition = retractToSafe(moves, currentPosition, safeZ)
  }

  return { moves, stepLevels, warnings }
}

function generateFinishBandMoves(
  band: ResolvedPocketBand,
  operation: Operation,
  safeZ: number,
  _stepdown: number,
  toolRadius: number,
  stepoverDistance: number,
  maxLinkDistance: number,
  direction: CutDirection = 'conventional',
): { moves: ToolpathMove[]; stepLevels: number[]; warnings: string[] } {
  const moves: ToolpathMove[] = []
  const warnings: string[] = []
  const effectiveBottom = resolveBandBottomZ(band, operation)
  if (effectiveBottom === null) {
    return {
      moves,
      stepLevels: [],
      warnings: [`Band ${band.topZ} -> ${band.bottomZ} leaves no finish depth after axial stock-to-leave`],
    }
  }

  if (!operation.finishWalls && !operation.finishFloor) {
    return {
      moves,
      stepLevels: [],
      warnings: ['Finish operation has both Finish Walls and Finish Floor disabled'],
    }
  }

  const radialLeave = Math.max(0, operation.stockToLeaveRadial)
  const finishDelta = toolRadius + radialLeave
  const shouldRoundPocketWalls = operation.kind === 'pocket' && operation.finishWalls && operation.roundOutsideCorners
  const needsMiterFinishRegions = operation.finishFloor || operation.finishWalls
  const finishRegions = needsMiterFinishRegions
    ? band.regions.flatMap((region) => buildInsetRegions(region, finishDelta))
    : []
  let wallContours: Point[][] = []
  let wallOuterContours: Point[][] = []
  let wallFinalContours: Point[][] = []
  let wallCleanupSegments: Point[][] = []
  if (operation.finishWalls) {
    if (shouldRoundPocketWalls) {
      const roundedWallRegions = band.regions.flatMap((region) => buildInsetRegions(
        region,
        finishDelta,
        ClipperLib.JoinType.jtMiter,
        ClipperLib.JoinType.jtRound,
      ))
      const islandCleanupDelta = finishDelta + stepoverDistance
      wallOuterContours = buildOuterContours(roundedWallRegions)
      wallFinalContours = buildExpandedIslandContours(band.regions, finishDelta, ClipperLib.JoinType.jtRound)
      wallCleanupSegments = buildAcuteIslandCornerCleanupSegments(band.regions, islandCleanupDelta)
    } else {
      wallContours = buildContourLoops(finishRegions)
    }
  }
  const slotScale = resolveSlotFeedScale(operation)
  const isParallelPocket = operation.kind === 'pocket' && operation.pocketPattern === 'parallel'
  // Offset floors are cut through the same inner-first ring traversal as the
  // rough pass (each disjoint floor area starts at its innermost loop and
  // works outward). The tree roots replicate buildPocketFloorContours'
  // geometry: a zero-inset Clipper round-trip, then one extra stepover inset
  // so the floor pass doesn't double as a wall-finish contour.
  const minFloorStepover = 1 / DEFAULT_CLIPPER_SCALE
  const floorStepover = Math.max(stepoverDistance, minFloorStepover)
  const floorTrees = operation.finishFloor && !isParallelPocket
    ? finishRegions
      .flatMap((region) => buildInsetRegions(region, 0))
      .flatMap((region) => buildInsetRegions(region, floorStepover))
      .map((region) => buildOffsetRegionTree(region, floorStepover))
    : []
  const floorSegments = operation.finishFloor && isParallelPocket
    ? buildPocketParallelSegments(finishRegions, stepoverDistance, operation.pocketAngle)
    : []
  if (
    wallContours.length === 0
    && wallOuterContours.length === 0
    && wallFinalContours.length === 0
    && wallCleanupSegments.length === 0
    && floorTrees.length === 0
    && floorSegments.length === 0
  ) {
    return {
      moves,
      stepLevels: [],
      warnings: [`No finish contours available for band ${band.topZ} -> ${band.bottomZ}`],
    }
  }

  const wallStepLevels = operation.finishWalls ? [effectiveBottom] : []
  const floorStepLevels = operation.finishFloor ? [effectiveBottom] : []
  let currentPosition: ToolpathPoint | null = null

  // Floor before walls: when roughing left axial stock, a wall pass at final
  // depth would slot through the uncleared floor skin at full feed. Cutting
  // the floor first removes that skin (with its first pass at the reduced
  // slot feed), so the wall pass only shaves the radial stock — and cutting
  // walls last leaves the cleanest final wall surface.
  for (const z of floorStepLevels) {
    const floorStartIndex = moves.length

    const orderedTrees = orderNodesGreedy(
      floorTrees,
      currentPosition ? { x: currentPosition.x, y: currentPosition.y } : null,
    )
    for (const tree of orderedTrees) {
      currentPosition = cutOffsetRegionNode(
        moves,
        tree,
        z,
        safeZ,
        maxLinkDistance,
        currentPosition,
        direction,
        undefined,
        'inner-first',
        'outer',
      )
    }

    const orderedFloorSegments = orderOpenSegmentsGreedy(
      floorSegments,
      currentPosition ? { x: currentPosition.x, y: currentPosition.y } : null,
    )
    for (const segment of orderedFloorSegments) {
      const entryPoint = contourStartPoint(segment, z)
      currentPosition = transitionToCutEntry(moves, currentPosition, entryPoint, safeZ, maxLinkDistance)
      const cutMoves = toOpenCutMoves(segment, z)
      moves.push(...cutMoves)
      currentPosition = cutMoves.at(-1)?.to ?? currentPosition
    }

    if (slotScale !== null) {
      const slotDistance = Math.max(
        toolRadius * 2 * SLOT_FEED_ENGAGEMENT_FACTOR,
        floorStepover * SLOT_FEED_ADJACENCY_FACTOR,
      )
      applySlotFeedToLevel(moves, floorStartIndex, slotScale, slotDistance, floorStepover * SLOT_FEED_OWN_TRAIL_FACTOR)
    }

    currentPosition = retractToSafe(moves, currentPosition, safeZ)
  }

  for (const z of wallStepLevels) {
    if (shouldRoundPocketWalls) {
      currentPosition = cutClosedContours(
        moves,
        wallOuterContours,
        z,
        safeZ,
        maxLinkDistance,
        currentPosition,
        false,
        direction,
      )
      const orderedCleanupSegments = orderOpenSegmentsGreedy(
        wallCleanupSegments,
        currentPosition ? { x: currentPosition.x, y: currentPosition.y } : null,
      )
      for (const segment of orderedCleanupSegments) {
        const entryPoint = contourStartPoint(segment, z)
        currentPosition = transitionToCutEntry(moves, currentPosition, entryPoint, safeZ, maxLinkDistance)
        const cutMoves = toOpenCutMoves(segment, z)
        moves.push(...cutMoves)
        currentPosition = cutMoves.at(-1)?.to ?? currentPosition
      }
      currentPosition = cutClosedContours(
        moves,
        wallFinalContours,
        z,
        safeZ,
        maxLinkDistance,
        currentPosition,
        false,
        direction,
      )
    } else {
      currentPosition = cutClosedContours(moves, wallContours, z, safeZ, maxLinkDistance, currentPosition, false, direction)
    }

    currentPosition = retractToSafe(moves, currentPosition, safeZ)
  }

  return {
    moves,
    stepLevels: [...new Set([...wallStepLevels, ...floorStepLevels])].sort((a, b) => b - a),
    warnings,
  }
}

export function generatePocketToolpath(project: Project, operation: Operation): PocketToolpathResult {
  if (isFeatureFirst(operation)) {
    const parts = perFeatureOperations(operation, project).map((subOp) =>
      generatePocketToolpathSingle(project, subOp),
    )
    return mergePocketToolpathResults(operation.id, parts, { orderBlocks: 'nearest' })
  }
  return generatePocketToolpathSingle(project, operation)
}

function generatePocketToolpathSingle(project: Project, operation: Operation): PocketToolpathResult {
  const resolved = resolvePocketRegions(project, operation)
  const regionMask = operation.target.source === 'features'
    ? buildRegionMask(splitFeatureTargets(project, operation.target.featureIds).regionFeatures)
    : null
  const toolRecord = operation.toolRef
    ? project.tools.find((tool) => tool.id === operation.toolRef) ?? null
    : null

  if (!toolRecord) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...resolved.warnings, 'No tool assigned to this operation'],
      bounds: null,
      stepLevels: [],
    }
  }

  const tool = normalizeToolForProject(toolRecord, project)
  if (!(tool.diameter > 0)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...resolved.warnings, 'Tool diameter must be greater than zero'],
      bounds: null,
      stepLevels: [],
    }
  }

  if (!(operation.stepdown > 0)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...resolved.warnings, 'Operation stepdown must be greater than zero'],
      bounds: null,
      stepLevels: [],
    }
  }

  if (!(operation.stepover > 0 && operation.stepover <= 1)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...resolved.warnings, 'Operation stepover ratio must be between 0 and 1'],
      bounds: null,
      stepLevels: [],
    }
  }

  const safeZ = getOperationSafeZ(project)
  const stepoverDistance = tool.diameter * operation.stepover
  const maxLinkDistance = tool.diameter
  const direction = operation.cutDirection ?? 'conventional'
  const allMoves: ToolpathMove[] = []
  const warnings = [...resolved.warnings]
  const maxBandDepth = resolved.bands.reduce((max, band) => Math.max(max, Math.abs(band.topZ - band.bottomZ)), 0)
  const depthWarning = checkMaxCutDepthWarning(tool, maxBandDepth)
  if (depthWarning) {
    warnings.push(depthWarning)
  }
  const allStepLevels = new Set<number>()

  const formatZ = (value: number) => Number(value.toFixed(6)).toString()
  const formatFeatureSpan = (featureId: string) => {
    const feature = project.features.find((entry) => entry.id === featureId)
    if (!feature) {
      return `${featureId} [missing]`
    }

    const span = resolveFeatureZSpan(project, feature)
    return `${feature.name} (${feature.id}) [${formatZ(span.max)} -> ${formatZ(span.min)}]`
  }

  const formatIslandSpan = (id: string) => {
    const feature = project.features.find((entry) => entry.id === id)
    if (feature) {
      const span = resolveFeatureZSpan(project, feature)
      return `${feature.name} (${feature.id}) [${formatZ(span.max)} -> ${formatZ(span.min)}]`
    }

    const tab = project.tabs.find((entry) => entry.id === id)
    if (tab) {
      return `${tab.name} (${tab.id}) [${formatZ(Math.max(tab.z_top, tab.z_bottom))} -> ${formatZ(Math.min(tab.z_top, tab.z_bottom))}]`
    }

    return `${id} [missing]`
  }

  if (operation.debugToolpath) {
    const resolvedBandSummary = resolved.bands
      .map((band) => `${formatZ(band.topZ)} -> ${formatZ(band.bottomZ)}`)
      .join(', ')

    if (resolved.bands.length > 0) {
      warnings.push(`Debug: resolved pocket bands = ${resolvedBandSummary}`)
    }
  }

  for (const band of resolved.bands) {
    const result = operation.pass === 'finish'
      ? generateFinishBandMoves(
        band,
        operation,
        safeZ,
        operation.stepdown,
        tool.radius,
        stepoverDistance,
        maxLinkDistance,
        direction,
      )
      : generateRoughBandMoves(
        band,
        operation,
        safeZ,
        operation.stepdown,
        tool.radius,
        stepoverDistance,
        maxLinkDistance,
        direction,
      )
    const { moves, stepLevels, warnings: bandWarnings } = result
    moves.forEach((move) => allMoves.push(move))
    stepLevels.forEach((level) => allStepLevels.add(level))
    warnings.push(...bandWarnings)
    if (operation.debugToolpath) {
      warnings.push(
        `Debug: band ${formatZ(band.topZ)} -> ${formatZ(band.bottomZ)} cut levels = ${
          stepLevels.length > 0 ? stepLevels.map((level) => formatZ(level)).join(', ') : 'none'
        }`,
      )
      warnings.push(
        `Debug: band ${formatZ(band.topZ)} -> ${formatZ(band.bottomZ)} targets = ${
          band.targetFeatureIds.length > 0 ? band.targetFeatureIds.map((id) => formatFeatureSpan(id)).join('; ') : 'none'
        }`,
      )
      warnings.push(
        `Debug: band ${formatZ(band.topZ)} -> ${formatZ(band.bottomZ)} islands = ${
          band.islandFeatureIds.length > 0 ? band.islandFeatureIds.map((id) => formatIslandSpan(id)).join('; ') : 'none'
        }`,
      )
    }
  }

  let bounds: ToolpathBounds | null = null
  for (const move of allMoves) {
    bounds = updateBounds(bounds, move.from)
    bounds = updateBounds(bounds, move.to)
  }

  const result: PocketToolpathResult = {
    operationId: operation.id,
    moves: allMoves,
    warnings,
    bounds,
    stepLevels: [...allStepLevels].sort((a, b) => b - a),
  }
  return clipToolpathResultToRegionMask(project, result, regionMask) as PocketToolpathResult
}
