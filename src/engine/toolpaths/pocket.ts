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
import type { ToolpathWarning } from './warningCodes'
import type { CutDirection, Operation, Point, Project } from '../../types/project'
import {
  createEntryPolicy,
  synthesizeEntry,
  withEntryHandoffFeedScale,
  withEntryStartZ,
  type EntryPolicy,
} from './entry'
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
  getOperationClearance,
  getOperationSafeZ,
  normalizeWinding,
  normalizeToolForProject,
  resolveFeatureZSpan,
  toClipperPath,
} from './geometry'
import {
  collectReliefCorners,
  generateCornerReliefPass,
  resolveReliefStepdown,
  type ReliefLoop,
} from './cornerRelief'
import { isFeatureFirst, mergePocketToolpathResults, perFeatureOperations } from './multiFeature'
import {
  cornerSmoothingRadius,
  planContourSmoothing,
} from './offsetSmoothing'
import {
  buildOffsetDomainCheck,
  pocketTangentLinkOptions,
  tangentSLink,
  type TangentLinkOptions,
} from './tangentLink'
import { buildWallCornerCleanupContour } from './wallCornerCleanup'
import {
  EngagementFeedQuantizer,
  EngagementTelemetryAccumulator,
  SweptMaterialIndex,
  nominalEngagement,
} from './engagement'
import { resolvePocketRegions } from './resolver'
import {
  buildRegionMask,
  splitFeatureTargets,
} from './regions'
import { resolveRegionDomainArea } from './regionDomain'
import { unionClipperPaths } from './modelProtection'
import { resolveFeatureInstance } from '../../store/helpers/resolveFeatures'

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
  entryPolicy?: EntryPolicy,
): ToolpathPoint {
  if (entryPolicy) {
    return synthesizeEntry(moves, from, toXY, safeZ, entryPolicy).end
  }

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

function appendUniqueWarning(warnings: ToolpathWarning[], warning: ToolpathWarning): void {
  const key = `${warning.code}:${JSON.stringify(warning.params ?? {})}`
  if (!warnings.some((entry) => `${entry.code}:${JSON.stringify(entry.params ?? {})}` === key)) {
    warnings.push(warning)
  }
}

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
 * Sampling resolution for the engagement feed path, as fractions of the tool
 * diameter. The measured ring-corner spike peaks within about one diameter of
 * the corner and decays over roughly two; the legacy slot-feed chunking
 * (a quarter of the slot distance) is too coarse to resolve it.
 */
const ENGAGEMENT_SAMPLE_CORNER_ANGLE = Math.PI / 8
const ENGAGEMENT_SAMPLE_CORNER_SPAN = 2
const ENGAGEMENT_SAMPLE_BASE_LENGTH = 0.5
const ENGAGEMENT_SAMPLE_CORNER_LENGTH = 0.25
const ENGAGEMENT_SAMPLE_POINTS_PER_CHUNK = 3

/**
 * Minimum fragment length for one ring, scaled from the fixed one-tool-diameter
 * floor. A ring's natural feed pattern — the nominal straight run between two
 * corners — is half a side, i.e. `perimeter / 8` for a square ring. On a ring
 * whose perimeter is under eight tool diameters that natural run is shorter
 * than one tool diameter, so a fixed minimum would forbid the run from ever
 * holding its own fragment and the reduced corner feed would run the whole
 * ring. Capping at one tool diameter keeps the floor unchanged on rings large
 * enough to care.
 */
const ENGAGEMENT_MIN_FRAGMENT_PERIMETER_DIVISOR = 8

/** Minimum fragment length for a ring of the given perimeter; links (null) keep the tool-diameter floor. */
function ringMinFragmentLength(toolDiameter: number, ringPerimeter: number | null): number {
  if (ringPerimeter === null || !Number.isFinite(ringPerimeter)) return toolDiameter
  return Math.min(toolDiameter, ringPerimeter / ENGAGEMENT_MIN_FRAGMENT_PERIMETER_DIVISOR)
}

// ── Engagement cache probes ───────────────────────────────────────────
//
// Call-count probes for the per-distinct-traversal classification cache. Cost
// assertions count work — never wall clocks (AGENTS.md § Build & Verify) —
// so tests reset and read these counters instead of timing generation. Only
// `resetEngagementCacheProbeCounts` and `engagementCacheProbeCounts` are
// public; the counters advance only inside pocket generation.

let engagementBandCacheBuildCount = 0
let engagementCacheLevelUseCount = 0
let engagementCacheMissCount = 0

/** Read the engagement cache probe counters (builds, level uses, and misses so far). */
export function engagementCacheProbeCounts(): {
  bandCacheBuilds: number
  cacheLevelUses: number
  cacheMisses: number
} {
  return {
    bandCacheBuilds: engagementBandCacheBuildCount,
    cacheLevelUses: engagementCacheLevelUseCount,
    cacheMisses: engagementCacheMissCount,
  }
}

/** Reset the engagement cache probe counters. Tests call this before measuring. */
export function resetEngagementCacheProbeCounts(): void {
  engagementBandCacheBuildCount = 0
  engagementCacheLevelUseCount = 0
  engagementCacheMissCount = 0
}

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

/** One reduced-feed span of the legacy slot-feed stream, in level coordinates. */
interface SlotFeedSpan {
  from: ToolpathPoint
  to: ToolpathPoint
  scale: number
}

/**
 * The reduced-feed spans the shipped slot-feed pass stamps over one level's
 * moves — computed by running the shipped classifier itself over a clone, so
 * the spans are byte-for-byte what a legacy generation of the same level
 * emits. The engagement path clamps against these geometrically (see
 * `applyEngagementFeedToLevel`). Only the current level's spans are returned:
 * the clone carries every earlier level's engagement-stamped fragments too,
 * and letting those leak into the clamp would make deeper levels clamp
 * against their own shallower siblings' output — a Z-invariant ring tree
 * would then emit a depth-dependent feed (the S2d drift defect).
 */
function legacySlotSpans(
  moves: ToolpathMove[],
  startIndex: number,
  scale: number,
  slotDistance: number,
  ownTrailTolerance: number,
): SlotFeedSpan[] {
  const clone = moves.map((move) => ({ ...move, from: { ...move.from }, to: { ...move.to } }))
  applySlotFeedToLevel(clone, startIndex, scale, slotDistance, ownTrailTolerance)
  const spans: SlotFeedSpan[] = []
  for (let index = startIndex; index < clone.length; index += 1) {
    const move = clone[index]
    if (move.kind === 'cut' && move.feedScale !== undefined) {
      spans.push({ from: move.from, to: move.to, scale: move.feedScale })
    }
  }
  return spans
}

/** Squared distance from (px, py) to the segment A→B. */
function pointSegmentDistanceSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax
  const dy = by - ay
  const lenSq = dx * dx + dy * dy
  const t = lenSq > 0
    ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq))
    : 0
  const qx = ax + dx * t - px
  const qy = ay + dy * t - py
  return qx * qx + qy * qy
}

/** Two-fold signed-area orientation test. */
function orientation(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
}

/** Overlap tolerance for the pointwise clamp: retraced paths share exact
 * contour vertices, so 1e-9 in distance (1e-18 squared) covers only float
 * dust and never distinct parallel paths. */
const CLAMP_OVERLAP_EPS_SQ = 1e-18

/** Do the two segments share a point, within float dust? */
function segmentsTouch(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const o1 = orientation(ax, ay, bx, by, cx, cy)
  const o2 = orientation(ax, ay, bx, by, dx, dy)
  const o3 = orientation(cx, cy, dx, dy, ax, ay)
  const o4 = orientation(cx, cy, dx, dy, bx, by)
  // Proper crossing: opposite sides both ways.
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) {
    return true
  }
  // Collinear overlap (retraced paths share exact contour vertices) shows up
  // as an endpoint lying on the other segment.
  return Math.min(
    pointSegmentDistanceSq(ax, ay, cx, cy, dx, dy),
    pointSegmentDistanceSq(bx, by, cx, cy, dx, dy),
    pointSegmentDistanceSq(cx, cy, ax, ay, bx, by),
    pointSegmentDistanceSq(dx, dy, ax, ay, bx, by),
  ) <= CLAMP_OVERLAP_EPS_SQ
}

/**
 * Engagement-scaled feed application for one Z level, used when the
 * operation's pocketFeedReduction is 'engagement' (issue #498).
 * Composes with `applySlotFeedToLevel`'s structure rather than adding a
 * second pass: one traversal of the level's moves, one splitting rule
 * (split where the emitted scale changes), the tail rebuilt once.
 *
 * Sampling resolution — the load-bearing part. The corner spike the manager
 * measured on a 60 mm square pocket (2.94 rad within about one tool diameter
 * of every interior ring corner, decaying to nominal over roughly two
 * diameters) is invisible to `applySlotFeedToLevel`'s quarter-slot-distance
 * chunks. So each cut move is chunked at half a tool diameter, refined to a
 * quarter diameter within two diameters of a move end whose direction changes
 * by at least ENGAGEMENT_SAMPLE_CORNER_ANGLE, and each chunk reports the
 * maximum engagement across three interior points — a spike between chunk
 * midpoints is still seen. Every one of those choices biases toward more
 * engagement, therefore lower feed.
 *
 * The chunk samples feed an `EngagementFeedQuantizer` (hysteresis and a
 * minimum fragment length, because arc fitting refuses to join moves whose
 * feedScale differs at all) and the operation's telemetry accumulator. Moves
 * are split where the emitted scale changes; a maximal run of one scale that
 * falls below the minimum fragment length is merged into its lower-scale
 * neighbour. Moves at scale 1 carry no feedScale (absent means full feed, as
 * everywhere else). With `slotScale` null — no pocketSlotFeedPercent anchor to
 * interpolate toward — samples are recorded for telemetry only and the move
 * stream is untouched.
 *
 * Conservative composition with the shipped slot feed is geometric and
 * pointwise. The shipped classifier stamps its own spans over the level's
 * moves (`legacySlotSpans`), and any engagement chunk whose span shares a
 * point with a stamped span is clamped to the stamped scale. A chunkwise
 * verdict — the earlier form — cannot hold the never-raise invariant when the
 * two chunkings disagree: a later move retracing a legacy slot span (the
 * parallel pattern's boundary contour and first fill line) is classified
 * "near prior" by the legacy index and escapes unclamped, emitting full feed
 * where legacy reduced it. Matching spans geometrically closes that hole:
 * wherever legacy slowed, engagement may only slow further.
 */
function applyEngagementFeedToLevel(
  moves: ToolpathMove[],
  startIndex: number,
  slotScale: number | null,
  toolDiameter: number,
  stepoverDistance: number,
  slotDistance: number,
  ownTrailTolerance: number,
  telemetry: EngagementTelemetryAccumulator,
  cache: OffsetBandEngagementClassification | null,
): void {
  if (startIndex >= moves.length) return
  if (cache !== null) engagementCacheLevelUseCount += 1
  const toolRadius = toolDiameter / 2
  const nominal = nominalEngagement(stepoverDistance, toolRadius)
  const minFragmentLength = toolDiameter
  const baseStep = toolDiameter * ENGAGEMENT_SAMPLE_BASE_LENGTH
  const refinedStep = toolDiameter * ENGAGEMENT_SAMPLE_CORNER_LENGTH
  const refineSpan = toolDiameter * ENGAGEMENT_SAMPLE_CORNER_SPAN
  const index = cache === null ? new SweptMaterialIndex(toolRadius) : null
  const slotSpans = slotScale === null
    ? []
    : legacySlotSpans(moves, startIndex, slotScale, slotDistance, ownTrailTolerance)
  const quantizer = slotScale === null
    ? null
    : new EngagementFeedQuantizer({ nominal, slotScale, minFragmentLength })

  interface LevelCut {
    move: ToolpathMove
    moveIndex: number
    dirX: number
    dirY: number
    length: number
    refinedStart: boolean
    refinedEnd: boolean
  }

  // Pass A: collect the cut moves' geometry so sampling can refine near
  // direction changes at either end of a move. The previous/next CUT move
  // defines the junction angle even when a rapid sits in between.
  const cuts: LevelCut[] = []
  for (let moveIndex = startIndex; moveIndex < moves.length; moveIndex += 1) {
    const move = moves[moveIndex]
    if (move.kind !== 'cut') continue
    const dx = move.to.x - move.from.x
    const dy = move.to.y - move.from.y
    const length = Math.hypot(dx, dy)
    if (length <= 1e-9) continue
    cuts.push({
      move,
      moveIndex,
      dirX: dx / length,
      dirY: dy / length,
      length,
      refinedStart: false,
      refinedEnd: false,
    })
  }
  for (let cutIndex = 0; cutIndex < cuts.length; cutIndex += 1) {
    const cut = cuts[cutIndex]
    const junctionAngle = (other: LevelCut): number => {
      const dot = Math.min(1, Math.max(-1, cut.dirX * other.dirX + cut.dirY * other.dirY))
      return Math.acos(dot)
    }
    // Unknown neighbours (level start/end) refine too: no evidence about the
    // junction resolves toward more sampling, not less.
    cut.refinedStart = cutIndex === 0 || junctionAngle(cuts[cutIndex - 1]) >= ENGAGEMENT_SAMPLE_CORNER_ANGLE
    cut.refinedEnd = cutIndex === cuts.length - 1 || junctionAngle(cuts[cutIndex + 1]) >= ENGAGEMENT_SAMPLE_CORNER_ANGLE
  }

  interface SampledChunk {
    move: ToolpathMove
    cutIndex: number
    t0: number
    t1: number
    length: number
    scale: number
    minFragmentLength: number
  }

  // Pass B: sample each chunk (max over interior points), feed the quantizer
  // and telemetry, and index the move once it is cut. With a per-band cache
  // the chunk classification is looked up by canonical segment identity —
  // computed once, reused at every level — and no index is built or queried
  // here. A cache miss (a segment the canonical traversal did not emit) is
  // resolved conservatively: full engagement π, never a restored feed.
  const chunks: SampledChunk[] = []
  for (let cutIndex = 0; cutIndex < cuts.length; cutIndex += 1) {
    const cut = cuts[cutIndex]
    const cached = cache?.chunksForMove(
      cutIndex,
      cut.move.from.x,
      cut.move.from.y,
      cut.move.to.x,
      cut.move.to.y,
    ) ?? null
    if (cached !== null) {
      const chunkMinFragmentLength = ringMinFragmentLength(toolDiameter, cached.ringPerimeter)
      quantizer?.setMinFragmentLength(chunkMinFragmentLength)
      for (const chunk of cached.chunks) {
        const chunkLength = (chunk.t1 - chunk.t0) * cut.length
        if (chunkLength <= 1e-12) continue
        quantizer?.push(chunk.engagement, chunkLength)
        telemetry.addSample(chunk.engagement, chunkLength)
        chunks.push({ move: cut.move, cutIndex, t0: chunk.t0, t1: chunk.t1, length: chunkLength, scale: 1, minFragmentLength: chunkMinFragmentLength })
      }
      continue
    }
    if (cache !== null) engagementCacheMissCount += 1
    quantizer?.setMinFragmentLength(minFragmentLength)
    const boundaries = engagementChunkBoundaries(
      cut.length,
      cut.refinedStart,
      cut.refinedEnd,
      baseStep,
      refinedStep,
      refineSpan,
    )
    for (let boundary = 0; boundary + 1 < boundaries.length; boundary += 1) {
      const t0 = boundaries[boundary] / cut.length
      const t1 = boundaries[boundary + 1] / cut.length
      const chunkLength = (t1 - t0) * cut.length
      if (chunkLength <= 1e-12) continue
      let engagement = cache !== null ? Math.PI : 0
      if (index !== null) {
        for (let point = 0; point < ENGAGEMENT_SAMPLE_POINTS_PER_CHUNK; point += 1) {
          const t = t0 + ((t1 - t0) * (point + 1)) / (ENGAGEMENT_SAMPLE_POINTS_PER_CHUNK + 1)
          const sample = index.engagementAt(
            cut.move.from.x + (cut.move.to.x - cut.move.from.x) * t,
            cut.move.from.y + (cut.move.to.y - cut.move.from.y) * t,
            cut.dirX,
            cut.dirY,
          )
          if (sample > engagement) engagement = sample
        }
      }
      quantizer?.push(engagement, chunkLength)
      telemetry.addSample(engagement, chunkLength)
      chunks.push({ move: cut.move, cutIndex, t0, t1, length: chunkLength, scale: 1, minFragmentLength })
    }
    index?.addSweptSegment(cut.move.from.x, cut.move.from.y, cut.move.to.x, cut.move.to.y)
  }

  // Pass C: assign each chunk the quantizer's emitted scale by walking both
  // sequences by cumulative distance (both sum the same pushed distances).
  if (quantizer) {
    const fragments = quantizer.fragments()
    let fragmentIndex = 0
    let remaining = fragments[0]?.distance ?? 0
    for (const chunk of chunks) {
      while (fragmentIndex < fragments.length && remaining <= 1e-9) {
        fragmentIndex += 1
        remaining += fragments[fragmentIndex]?.distance ?? 0
      }
      chunk.scale = fragments[Math.min(fragmentIndex, fragments.length - 1)]?.scale ?? 1
      remaining -= chunk.length
    }
    // Pointwise conservative composition with the shipped slot feed: clamp any
    // chunk whose span shares a point with a legacy slot span. Geometry, not
    // chunk indices — a later move retracing a stamped span must inherit the
    // stamp, which a per-chunk legacy verdict cannot see.
    if (slotSpans.length > 0) {
      for (const chunk of chunks) {
        const from = interpolateMovePoint(chunk.move, chunk.t0)
        const to = interpolateMovePoint(chunk.move, chunk.t1)
        for (const span of slotSpans) {
          if (segmentsTouch(from.x, from.y, to.x, to.y, span.from.x, span.from.y, span.to.x, span.to.y)) {
            chunk.scale = Math.min(chunk.scale, span.scale)
            break
          }
        }
      }
    }
  }

  // Pass D: minimum fragment length over the emitted stream. A maximal run of
  // one scale — broken by non-cut moves, so the runs below are what a
  // controller actually sees — must not be shorter than its own minimum (the
  // tightest of its chunks' per-ring minima). Merge any shorter run into its
  // lower-scale neighbour, the same rule `EngagementFeedQuantizer.fragments`
  // applies to its own stretches.
  if (quantizer) {
    interface ScaleRun {
      scale: number
      start: number
      end: number
      length: number
      minFragmentLength: number
    }
    const runs: ScaleRun[] = []
    let runStart = 0
    for (let chunkIndex = 1; chunkIndex <= chunks.length; chunkIndex += 1) {
      const breaks = chunkIndex === chunks.length
        || chunks[chunkIndex].scale !== chunks[chunkIndex - 1].scale
        || (chunks[chunkIndex].cutIndex !== chunks[chunkIndex - 1].cutIndex
          && cuts[chunks[chunkIndex].cutIndex].moveIndex - cuts[chunks[chunkIndex - 1].cutIndex].moveIndex > 1)
      if (!breaks) continue
      let length = 0
      let minFragmentLength = Infinity
      for (let chunkIndex2 = runStart; chunkIndex2 < chunkIndex; chunkIndex2 += 1) {
        length += chunks[chunkIndex2].length
        if (chunks[chunkIndex2].minFragmentLength < minFragmentLength) minFragmentLength = chunks[chunkIndex2].minFragmentLength
      }
      runs.push({ scale: chunks[runStart].scale, start: runStart, end: chunkIndex, length, minFragmentLength })
      runStart = chunkIndex
    }
    // Two runs are emitted as one stretch only when their cut moves sit next
    // to each other in the stream — a non-cut move between them breaks what a
    // controller sees, so merging across one cannot repair a short run.
    const isAdjacent = (left: ScaleRun, right: ScaleRun): boolean => {
      const leftCut = chunks[left.end - 1].cutIndex
      const rightCut = chunks[right.start].cutIndex
      return leftCut === rightCut || cuts[rightCut].moveIndex - cuts[leftCut].moveIndex === 1
    }
    for (let runIndex = 0; runIndex < runs.length; ) {
      if (runs.length === 1 || runs[runIndex].length >= runs[runIndex].minFragmentLength - 1e-9) {
        runIndex += 1
        continue
      }
      const next = runs[runIndex + 1]
      const prev = runs[runIndex - 1]
      const adjacentBefore = prev !== undefined && isAdjacent(prev, runs[runIndex])
      const adjacentAfter = next !== undefined && isAdjacent(runs[runIndex], next)
      // Prefer a directly adjacent neighbour (only there does the merge grow
      // the emitted stretch); among adjacent ones prefer the lower scale, the
      // same rule EngagementFeedQuantizer.fragments uses. A run bounded by
      // non-cut moves on both sides keeps its scale — it is a lone fed
      // stretch, not an alternation.
      const targetIndex = adjacentAfter && (!adjacentBefore || next.scale <= prev.scale)
        ? runIndex + 1
        : adjacentBefore
          ? runIndex - 1
          : (next && (!prev || next.scale <= prev.scale) ? runIndex + 1 : runIndex - 1)
      const target = runs[targetIndex]
      // A minimum-fragment merge must not bridge the full-feed ceiling in
      // either direction. Extending a reduced run into a full-feed neighbour
      // holds the slot feed into material measured at or below nominal, and
      // absorbing a short full-feed run into a reduced one does the same from
      // the other side. A short run next to full feed is a genuine short slot
      // or a genuine short cleared gap (a neck crossing): it keeps its own
      // scale at its own length. Only bucket-to-bucket merges (both reduced)
      // are still consolidated.
      if (runs[runIndex].scale >= 1 || target.scale >= 1) {
        runIndex += 1
        continue
      }
      // A bucket-to-bucket merge takes the lower scale, so a merge that would
      // lower the higher-scale run by more than one rung is refused: a run
      // entitled to a near-full scale must not be dragged to the slot floor by
      // a slot it merely touches (issue #498, slice S9).
      if (Math.abs(runs[runIndex].scale - target.scale) > quantizer.bucketWidth * (1 + 1e-9)) {
        runIndex += 1
        continue
      }
      const mergedScale = Math.min(runs[runIndex].scale, target.scale)
      // Relabel the whole merged span, target included: the lower scale
      // extends over both runs, so the emitted chunks match the run table.
      const mergedStart = Math.min(runs[runIndex].start, target.start)
      const mergedEnd = Math.max(runs[runIndex].end, target.end)
      for (let chunkIndex = mergedStart; chunkIndex < mergedEnd; chunkIndex += 1) {
        chunks[chunkIndex].scale = mergedScale
      }
      target.scale = mergedScale
      target.length += runs[runIndex].length
      target.minFragmentLength = Math.min(runs[runIndex].minFragmentLength, target.minFragmentLength)
      target.start = mergedStart
      target.end = mergedEnd
      runs.splice(runIndex, 1)
      if (targetIndex < runIndex) runIndex = targetIndex
    }
  }

  // Pass E: rebuild the level's moves, splitting where the scale changes —
  // the same tail rebuild as applySlotFeedToLevel.
  const stamped: ToolpathMove[] = []
  let chunkCursor = 0
  for (let moveIndex = startIndex; moveIndex < moves.length; moveIndex += 1) {
    const move = moves[moveIndex]
    const moveChunks: SampledChunk[] = []
    while (chunkCursor < chunks.length && chunks[chunkCursor].move === move) {
      moveChunks.push(chunks[chunkCursor])
      chunkCursor += 1
    }
    if (moveChunks.length === 0) {
      // Cuts too short to chunk still carry the pointwise clamp: wherever
      // legacy slowed, engagement may only slow further.
      if (move.kind === 'cut' && slotSpans.length > 0 && move.feedScale === undefined) {
        let lowest = 1
        let touched = false
        for (const span of slotSpans) {
          if (pointSegmentDistanceSq(move.from.x, move.from.y, span.from.x, span.from.y, span.to.x, span.to.y) <= CLAMP_OVERLAP_EPS_SQ) {
            touched = true
            lowest = Math.min(lowest, span.scale)
          }
        }
        if (touched && lowest < 1) {
          stamped.push({ ...move, feedScale: lowest })
          continue
        }
      }
      stamped.push(move)
      continue
    }
    let fragmentStartT = 0
    let fragmentScale: number | null = null
    const emitFragment = (t0: number, t1: number, scale: number) => {
      const from = interpolateMovePoint(move, t0)
      const to = interpolateMovePoint(move, t1)
      stamped.push(scale < 1 ? { ...move, from, to, feedScale: scale } : { ...move, from, to })
    }
    for (const chunk of moveChunks) {
      if (fragmentScale === null) {
        fragmentScale = chunk.scale
      } else if (chunk.scale !== fragmentScale) {
        emitFragment(fragmentStartT, chunk.t0, fragmentScale)
        fragmentStartT = chunk.t0
        fragmentScale = chunk.scale
      }
    }
    emitFragment(fragmentStartT, 1, fragmentScale ?? 1)
  }

  moves.length = startIndex
  for (const move of stamped) {
    moves.push(move)
  }
}

/**
 * Chunk boundaries along a cut move of the given length: a refined region
 * (refinedStep) spans refineSpan from each end that needs it, the middle uses
 * baseStep. Each region contributes a whole number of equal chunks, so the
 * boundaries are deterministic; overlapping refined regions on a short move
 * resolve to the head region only.
 */
function engagementChunkBoundaries(
  length: number,
  refinedStart: boolean,
  refinedEnd: boolean,
  baseStep: number,
  refinedStep: number,
  refineSpan: number,
): number[] {
  const boundaries: number[] = [0]
  const appendChunks = (from: number, to: number, step: number) => {
    if (to - from <= 0) return
    const count = Math.max(1, Math.ceil((to - from) / step))
    for (let index = 1; index < count; index += 1) {
      boundaries.push(from + ((to - from) * index) / count)
    }
  }
  const headEnd = refinedStart ? Math.min(refineSpan, length) : 0
  const tailStart = Math.max(refinedEnd ? length - refineSpan : length, headEnd)
  appendChunks(0, headEnd, refinedStep)
  appendChunks(headEnd, tailStart, baseStep)
  appendChunks(tailStart, length, refinedStep)
  boundaries.push(length)
  return boundaries
}

/** Per-level feed application: the engagement path, or the shipped slot feed. */
function applyLevelFeed(
  moves: ToolpathMove[],
  startIndex: number,
  operation: Operation,
  slotScale: number | null,
  slotDistance: number,
  ownTrailTolerance: number,
  toolDiameter: number,
  stepoverDistance: number,
  telemetry: EngagementTelemetryAccumulator | null,
  cache: OffsetBandEngagementClassification | null = null,
): void {
  if (telemetry !== null && operation.pocketFeedReduction === 'engagement') {
    applyEngagementFeedToLevel(
      moves,
      startIndex,
      slotScale,
      toolDiameter,
      stepoverDistance,
      slotDistance,
      ownTrailTolerance,
      telemetry,
      cache,
    )
  } else if (slotScale !== null) {
    applySlotFeedToLevel(moves, startIndex, slotScale, slotDistance, ownTrailTolerance)
  }
}

export function transitionToCutEntry(
  moves: ToolpathMove[],
  from: ToolpathPoint | null,
  toXY: ToolpathPoint,
  safeZ: number,
  maxLinkDistance: number,
  safeLinkCheck?: SafeLinkCheck,
  entryPolicy?: EntryPolicy,
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
        if (entryPolicy) {
          const safePosition = retractToSafe(moves, from, safeZ)
          return pushRapidAndPlunge(moves, safePosition, toXY, safeZ, entryPolicy)
        }
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
      return pushRapidAndPlunge(moves, from, toXY, safeZ, entryPolicy)
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
  return pushRapidAndPlunge(moves, safePosition, toXY, safeZ, entryPolicy)
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
  // Start one stepover inside the finish boundary so "Finish floor" can be
  // used independently from "Finish walls".
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
  entryPolicy?: EntryPolicy,
  tangentLink?: TangentLinkOptions,
  contoursAlreadyDirected = false,
): ToolpathPoint | null {
  const directedContours = contoursAlreadyDirected
    ? contours
    : applyContourDirection(contours, direction)
  const start = currentPosition ? { x: currentPosition.x, y: currentPosition.y } : null
  const orderedContours = preserveContourRotation
    ? orderClosedContoursGreedyPreservingRotation(directedContours, start)
    : orderClosedContoursGreedy(directedContours, start)

  let nextPosition = currentPosition
  for (const contour of orderedContours) {
    const entryPoint = contourStartPoint(contour, z)
    const linkStartIndex = moves.length
    nextPosition = transitionToCutEntry(
      moves,
      nextPosition,
      entryPoint,
      safeZ,
      maxLinkDistance,
      safeLinkCheck,
      entryPolicy,
    )
    let cutMoves = toClosedCutMoves(contour, z)
    if (tangentLink && cutMoves.length > 0 && moves.length === linkStartIndex + 1 && linkStartIndex > 0) {
      // A single direct cut link: try the tangent S-link (issue #545). The S
      // departs the previous ring's closing cut along its tangent and arrives
      // on a vertex of this ring along this ring's tangent, so the ring
      // re-seams at the arrival vertex. When no S fits, the straight link
      // stays — today's behaviour.
      const linkMove = moves[linkStartIndex]
      const previous = moves[linkStartIndex - 1]
      if (
        linkMove.kind === 'cut'
        && previous.kind === 'cut'
        && Math.abs(previous.to.x - linkMove.from.x) <= 1e-9
        && Math.abs(previous.to.y - linkMove.from.y) <= 1e-9
        // The S is an XY planar link; a ramping cut link (3D) has no planar
        // S and must not be spliced at the wrong Z.
        && Math.abs(linkMove.from.z - linkMove.to.z) <= 1e-9
      ) {
        const exitTangentX = linkMove.from.x - previous.from.x
        const exitTangentY = linkMove.from.y - previous.from.y
        const exitTangentLen = Math.hypot(exitTangentX, exitTangentY)
        const linkDx = linkMove.to.x - linkMove.from.x
        const linkDy = linkMove.to.y - linkMove.from.y
        const linkLen = Math.hypot(linkDx, linkDy)
        const firstChordDx = cutMoves[0].to.x - cutMoves[0].from.x
        const firstChordDy = cutMoves[0].to.y - cutMoves[0].from.y
        const firstChordLen = Math.hypot(firstChordDx, firstChordDy)
        if (exitTangentLen > 1e-9 && linkLen > 1e-9 && firstChordLen > 1e-9) {
          const turnOf = (ax: number, ay: number, bx: number, by: number): number =>
            Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by)))))
          const exitTurn = turnOf(exitTangentX, exitTangentY, linkDx, linkDy)
          const entryTurn = turnOf(linkDx, linkDy, firstChordDx, firstChordDy)
          // Skip the S only when BOTH ends are already tangent — a link with
          // one shallow end and one sharp end still needs the curve.
          if (exitTurn >= (10 * Math.PI) / 180 || entryTurn >= (10 * Math.PI) / 180) {
            const result = tangentSLink(
              linkMove.from,
              { x: exitTangentX / exitTangentLen, y: exitTangentY / exitTangentLen },
              contour,
              tangentLink,
            )
            if (result !== null) {
              const z0 = linkMove.from.z
              const sMoves: ToolpathMove[] = []
              for (let index = 1; index < result.points.length; index += 1) {
                sMoves.push({
                  kind: 'cut',
                  from: { x: result.points[index - 1].x, y: result.points[index - 1].y, z: z0 },
                  to: { x: result.points[index].x, y: result.points[index].y, z: z0 },
                })
              }
              moves.splice(linkStartIndex, 1, ...sMoves)
              // Re-seam the ring at the arrival vertex.
              const rotated = [...contour.slice(result.arrivalIndex), ...contour.slice(0, result.arrivalIndex)]
              cutMoves = toClosedCutMoves(rotated, z)
              nextPosition = sMoves[sMoves.length - 1].to
            }
          }
        }
      }
    }
    moves.push(...cutMoves)
    nextPosition = cutMoves.at(-1)?.to ?? nextPosition
  }

  return nextPosition
}

export interface OffsetRegionNode {
  region: ResolvedPocketRegion
  children: OffsetRegionNode[]
}

/**
 * Precompute the offset ring tree for a region. The successive insets depend
 * only on the region geometry and stepover — not on Z — so callers cutting
 * several step levels build the tree once and traverse it per level instead
 * of redoing the Clipper offsets at every level.
 */
export function buildOffsetRegionTree(
  region: ResolvedPocketRegion,
  stepoverDistance: number,
  islandJoinType: number = ClipperLib.JoinType.jtMiter,
): OffsetRegionNode {
  const childRegions = buildInsetRegions(region, stepoverDistance, ClipperLib.JoinType.jtMiter, islandJoinType)
  return {
    region,
    children: childRegions.map((child) => buildOffsetRegionTree(child, stepoverDistance, islandJoinType)),
  }
}

type RingPerimeterIndex = ReadonlyMap<string, number>

export interface WallCornerCleanupContext {
  enabled: boolean
  onFallback?: () => void
}

const directedSegmentKey = (from: Point, to: Point): string =>
  `${from.x},${from.y}->${to.x},${to.y}`

function prepareOffsetOuterContour(
  node: OffsetRegionNode,
  direction: CutDirection,
  smoothRadius: number | null | undefined,
  depth: number,
  wallCleanup: WallCornerCleanupContext | undefined,
): { points: Point[]; cleanupFallback: boolean; preserveRotation: boolean } | null {
  if (node.region.outer.length < 3) return null
  const directed = applyContourDirection([node.region.outer], direction)[0]
  if (!smoothRadius) return { points: directed, cleanupFallback: false, preserveRotation: false }
  if (depth > 0) {
    // Interior rings. A corner reached through tessellation edges — the shape
    // an island's rounded offset leaves where it meets a straight wall — has
    // no straight edge to set back into, so the ordinary construction emits a
    // few percent of the requested radius and the ring stays visibly pointed.
    // Cut it with one full-radius arc instead, and clean the tip that arc
    // leaves the same way a wall corner is cleaned.
    //
    // The tip looks redundant: the neighbouring rings sit one stepover away
    // and sweep a whole tool radius, and on every corner measured they reach
    // it with room to spare. Skipping the loop on that basis is wrong, and
    // measurably so — `rounded-corners-poc-test-1.camj` came back with a
    // 0.21 x 0.05in ridge standing 0.0057in proud, because the loop had also
    // been sweeping stock *outside* its own tip that nothing else covers.
    // Whether a loop is redundant is a question about the material its whole
    // swept envelope removes, not about the span it retraces, and nothing
    // cheaper answers it: a coverage margin tight enough to catch that ridge
    // declined so many corners the result carried more motion than simply
    // cleaning every one.
    const plan = planContourSmoothing(directed, smoothRadius, { broadCorners: true })
    if (!plan.transitions.some((transition) => transition.cutsAcrossSource)) {
      return { points: plan.points, cleanupFallback: false, preserveRotation: false }
    }
    const cleaned = buildWallCornerCleanupContour(plan, {
      isInsideDomain: buildOffsetDomainCheck([node.region]),
      cleanup: 'cut-across',
    })
    if (!cleaned) {
      return { points: plan.points, cleanupFallback: false, preserveRotation: false }
    }
    return {
      points: cleaned.points,
      cleanupFallback: false,
      preserveRotation: false,
    }
  }
  if (!wallCleanup?.enabled) {
    return { points: directed, cleanupFallback: false, preserveRotation: false }
  }

  const plan = planContourSmoothing(directed, smoothRadius)
  const cleanup = buildWallCornerCleanupContour(plan, {
    isInsideDomain: buildOffsetDomainCheck([node.region]),
  })
  // A corner the cleanup declines keeps its exact sharp geometry, which is what
  // ships today, so a partly-cleaned ring is a normal outcome and stays quiet —
  // every reflex corner declines by construction, and warning on those would cry
  // wolf on any notched pocket. Warn only when the ring came back with nothing
  // cleaned at all despite planned transitions: there the feature did nothing.
  if (!cleanup) {
    return { points: directed, cleanupFallback: true, preserveRotation: false }
  }
  return {
    points: cleanup.points,
    cleanupFallback: cleanup.cleanupCount === 0 && plan.transitions.length > 0,
    preserveRotation: cleanup.cleanupCount > 0,
  }
}

/** Ring perimeter metadata is geometry-only and reusable across traversal orders. */
function buildRingPerimeterIndex(
  regionTrees: OffsetRegionNode[],
  direction: CutDirection,
  smoothRadius: number | null,
  wallCleanupEnabled: boolean,
): RingPerimeterIndex {
  const perimeters = new Map<string, number>()
  const visit = (node: OffsetRegionNode, depth: number): void => {
    const outer = prepareOffsetOuterContour(
      node,
      direction,
      smoothRadius,
      depth,
      wallCleanupEnabled ? { enabled: true } : undefined,
    )
    const islands = applyContourDirection(
      node.region.islands.filter((island) => island.length >= 3),
      direction,
    )
    for (const contour of [...(outer ? [outer.points] : []), ...islands]) {
      let perimeter = 0
      for (let index = 0; index < contour.length; index += 1) {
        const next = contour[(index + 1) % contour.length]
        perimeter += Math.hypot(next.x - contour[index].x, next.y - contour[index].y)
      }
      for (let index = 0; index < contour.length; index += 1) {
        const next = contour[(index + 1) % contour.length]
        if (Math.hypot(next.x - contour[index].x, next.y - contour[index].y) <= 1e-9) continue
        perimeters.set(directedSegmentKey(contour[index], next), perimeter)
      }
    }
    for (const child of node.children) {
      visit(child, depth + 1)
    }
  }
  for (const tree of regionTrees) {
    visit(tree, 0)
  }
  return perimeters
}

/** Engagement classification for one exact offset-level traversal. */
export interface OffsetBandEngagementClassification {
  /**
   * Cached chunks for the cut at `cutIndex`. Coordinates are checked as well
   * as the index so a traversal mismatch is observable and resolves through
   * the caller's conservative cache-miss path.
   */
  chunksForMove(
    cutIndex: number,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
  ): {
    chunks: ReadonlyArray<{ t0: number; t1: number; engagement: number }>
    /** Perimeter of the ring contour this segment lies on, or null for a link. */
    ringPerimeter: number | null
  } | null
  /** Stored cell entries of every swept-material index the build created —
   * the per-distinct-traversal index-size proxy for cost assertions. */
  indexEntryCount: number
  /** Number of emitted cut segments classified. */
  segmentCount: number
  /** Exact index work performed while classifying this traversal. */
  queryStats: {
    capsulesScanned: number
    capsulesTrigTested: number
  }
}

/**
 * Build one exact emission-order classification. The generator caches this by
 * the level's ordered cut-segment signature, so identical levels reuse it and
 * a genuinely different traversal gets its own safe classification.
 */
export function buildOffsetBandEngagementClassification(
  moves: ToolpathMove[],
  startIndex: number,
  endIndex: number,
  options: {
    toolRadius: number
    ringPerimeters: RingPerimeterIndex
  },
): OffsetBandEngagementClassification {
  const { toolRadius, ringPerimeters } = options
  const toolDiameter = toolRadius * 2
  const baseStep = toolDiameter * ENGAGEMENT_SAMPLE_BASE_LENGTH
  const refinedStep = toolDiameter * ENGAGEMENT_SAMPLE_CORNER_LENGTH
  const refineSpan = toolDiameter * ENGAGEMENT_SAMPLE_CORNER_SPAN
  const priorIndex = new SweptMaterialIndex(toolRadius)

  interface CachedCut {
    from: Point
    to: Point
    chunks: Array<{ t0: number; t1: number; engagement: number }>
    ringPerimeter: number | null
  }

  const cachedCuts: CachedCut[] = []

  interface LevelCut {
    move: ToolpathMove
    dirX: number
    dirY: number
    length: number
    refinedStart: boolean
    refinedEnd: boolean
  }

  const cuts: LevelCut[] = []
  for (let moveIndex = startIndex; moveIndex < endIndex; moveIndex += 1) {
    const move = moves[moveIndex]
    if (move.kind !== 'cut') continue
    const dx = move.to.x - move.from.x
    const dy = move.to.y - move.from.y
    const length = Math.hypot(dx, dy)
    if (length <= 1e-9) continue
    cuts.push({
      move,
      dirX: dx / length,
      dirY: dy / length,
      length,
      refinedStart: false,
      refinedEnd: false,
    })
  }
  for (let cutIndex = 0; cutIndex < cuts.length; cutIndex += 1) {
    const cut = cuts[cutIndex]
    const junctionAngle = (other: LevelCut): number =>
      Math.acos(Math.min(1, Math.max(-1, cut.dirX * other.dirX + cut.dirY * other.dirY)))
    cut.refinedStart = cutIndex === 0 || junctionAngle(cuts[cutIndex - 1]) >= ENGAGEMENT_SAMPLE_CORNER_ANGLE
    cut.refinedEnd = cutIndex === cuts.length - 1 || junctionAngle(cuts[cutIndex + 1]) >= ENGAGEMENT_SAMPLE_CORNER_ANGLE
  }

  for (const cut of cuts) {
    const boundaries = engagementChunkBoundaries(
      cut.length,
      cut.refinedStart,
      cut.refinedEnd,
      baseStep,
      refinedStep,
      refineSpan,
    )
    const chunks: Array<{ t0: number; t1: number; engagement: number }> = []
    for (let boundary = 0; boundary + 1 < boundaries.length; boundary += 1) {
      const t0 = boundaries[boundary] / cut.length
      const t1 = boundaries[boundary + 1] / cut.length
      const chunkLength = (t1 - t0) * cut.length
      if (chunkLength <= 1e-12) continue
      let engagement = 0
      for (let point = 0; point < ENGAGEMENT_SAMPLE_POINTS_PER_CHUNK; point += 1) {
        const t = t0 + ((t1 - t0) * (point + 1)) / (ENGAGEMENT_SAMPLE_POINTS_PER_CHUNK + 1)
        const sample = priorIndex.engagementAt(
          cut.move.from.x + (cut.move.to.x - cut.move.from.x) * t,
          cut.move.from.y + (cut.move.to.y - cut.move.from.y) * t,
          cut.dirX,
          cut.dirY,
        )
        if (sample > engagement) engagement = sample
      }
      chunks.push({ t0, t1, engagement })
    }
    cachedCuts.push({
      from: cut.move.from,
      to: cut.move.to,
      chunks,
      ringPerimeter: ringPerimeters.get(directedSegmentKey(cut.move.from, cut.move.to)) ?? null,
    })
    priorIndex.addSweptSegment(
      cut.move.from.x,
      cut.move.from.y,
      cut.move.to.x,
      cut.move.to.y,
    )
  }

  return {
    chunksForMove(cutIndex, fromX, fromY, toX, toY) {
      const cached = cachedCuts[cutIndex]
      if (
        cached === undefined
        || cached.from.x !== fromX
        || cached.from.y !== fromY
        || cached.to.x !== toX
        || cached.to.y !== toY
      ) {
        return null
      }
      return { chunks: cached.chunks, ringPerimeter: cached.ringPerimeter }
    },
    indexEntryCount: priorIndex.storedEntryCount(),
    segmentCount: cachedCuts.length,
    queryStats: priorIndex.queryStats(),
  }
}

/** Exact ordered-cut identity used to reuse a safe classification. */
function engagementTraversalKey(moves: ToolpathMove[], startIndex: number, endIndex: number): string {
  const parts: string[] = []
  for (let moveIndex = startIndex; moveIndex < endIndex; moveIndex += 1) {
    const move = moves[moveIndex]
    if (move.kind !== 'cut') continue
    parts.push(directedSegmentKey(move.from, move.to))
  }
  return parts.join('|')
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
  smoothRadius?: number,
  depth = 0,
  entryPolicy?: EntryPolicy,
  tangentLink?: TangentLinkOptions,
  wallCleanup?: WallCornerCleanupContext,
): ToolpathPoint | null {
  const cutCurrentRegion = (fromPosition: ToolpathPoint | null): ToolpathPoint | null => {
    const childAnchors = traversalMode === 'outer-first'
      ? node.children
        .map((child) => child.region.outer)
        .filter((contour) => contour.length > 0)
        .map((contour) => contour[0])
      : []
    // Outer (wall-side) and island (bump-side) rings are smoothed differently
    // because the tool relates to each corner oppositely:
    //
    //  - Outer ring: interior rings use broad contour-level transitions. A
    //    Pocket root ring may use the same transition only when it can return
    //    tangentially and immediately traverse the exact source span; if that
    //    contained cleanup loop cannot be built, it fails closed to sharp.
    //  - Island rings: the tool goes around convex material it can reach. Here
    //    the tight, smooth path is a rounded OFFSET (jtRound, applied when the
    //    region was built) — filleting the emitted polyline would instead pull
    //    the tool into the island and gouge it. So island loops are emitted
    //    as-is, already rounded (or mitered when the option is off).
    const outer = prepareOffsetOuterContour(
      node, direction, smoothRadius, depth, wallCleanup,
    )
    if (outer?.cleanupFallback) wallCleanup?.onFallback?.()
    const islandContours = loops === 'outer'
      ? []
      : applyContourDirection(
        node.region.islands.filter((island) => island.length >= 3),
        direction,
      )
    const contours = [...(outer ? [outer.points] : []), ...islandContours]
    const preparedContours = contours.map((contour, index) =>
      index === 0 && outer?.preserveRotation
        ? contour
        : rotateContourToBestEntry(
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
      entryPolicy,
      tangentLink,
      true,
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
      smoothRadius,
      depth + 1,
      entryPolicy,
      tangentLink,
      wallCleanup,
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
  smoothRadius?: number,
  islandJoinType: number = ClipperLib.JoinType.jtMiter,
  entryPolicy?: EntryPolicy,
  tangentLink?: TangentLinkOptions,
  wallCleanup?: WallCornerCleanupContext,
): ToolpathPoint | null {
  return cutOffsetRegionNode(
    moves,
    buildOffsetRegionTree(region, stepoverDistance, islandJoinType),
    z,
    safeZ,
    maxLinkDistance,
    currentPosition,
    direction,
    safeLinkCheck,
    traversalMode,
    'all',
    smoothRadius,
    0,
    entryPolicy,
    tangentLink,
    wallCleanup,
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
  entryClearance: number,
  stepdown: number,
  toolRadius: number,
  stepoverDistance: number,
  maxLinkDistance: number,
  direction: CutDirection = 'conventional',
  telemetry: EngagementTelemetryAccumulator | null = null,
): { moves: ToolpathMove[]; stepLevels: number[]; warnings: ToolpathWarning[] } {
  const moves: ToolpathMove[] = []
  const warnings: ToolpathWarning[] = []
  const effectiveBottom = resolveBandBottomZ(band, operation)
  if (effectiveBottom === null) {
    return {
      moves,
      stepLevels: [],
      warnings: [{ code: 'surfaceBandNoRoughDepth', params: { topZ: band.topZ, bottomZ: band.bottomZ } }],
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
        warnings: [{ code: 'pocketNoFloorRegion', params: { topZ: band.topZ, bottomZ: band.bottomZ } }],
      }
    }

    const entryPolicy = withEntryHandoffFeedScale(
      createEntryPolicy(
        operation,
        toolRadius * 2,
        roughRegions,
        (warning) => appendUniqueWarning(warnings, warning),
      ),
      slotScale,
    )

    const boundaryContours = applyContourDirection(buildContourLoops(roughRegions), direction)
    const segments = buildPocketParallelSegments(roughRegions, effectiveStepover, operation.pocketAngle)
    if (segments.length === 0) {
      return {
        moves,
        stepLevels,
        warnings: [{ code: 'pocketNoFloorSegments', params: { topZ: band.topZ, bottomZ: band.bottomZ } }],
      }
    }

    for (let levelIndex = 0; levelIndex < stepLevels.length; levelIndex += 1) {
      const z = stepLevels[levelIndex]
      const levelEntryPolicy = withEntryStartZ(
        entryPolicy,
        levelIndex === 0 ? safeZ : Math.min(safeZ, stepLevels[levelIndex - 1] + entryClearance),
      )
      const levelStartIndex = moves.length
      for (const contour of boundaryContours) {
        const entryPoint = contourStartPoint(contour, z)
        currentPosition = transitionToCutEntry(
          moves,
          currentPosition,
          entryPoint,
          safeZ,
          maxLinkDistance,
          undefined,
          levelEntryPolicy,
        )
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
        currentPosition = transitionToCutEntry(
          moves,
          currentPosition,
          entryPoint,
          safeZ,
          maxLinkDistance,
          undefined,
          levelEntryPolicy,
        )
        const cutMoves = toOpenCutMoves(segment, z)
        moves.push(...cutMoves)
        currentPosition = cutMoves.at(-1)?.to ?? currentPosition
      }

      applyLevelFeed(
        moves,
        levelStartIndex,
        operation,
        slotScale,
        slotDistance,
        effectiveStepover * SLOT_FEED_OWN_TRAIL_FACTOR,
        toolRadius * 2,
        effectiveStepover,
        telemetry,
      )

      currentPosition = retractToSafe(moves, currentPosition, safeZ)
    }

    return { moves, stepLevels, warnings }
  }

  // The offset ring tree is identical at every step level — build it once
  // and traverse it per level. When rounding is on, islands are offset with
  // round joins (extends #245's island rounding to rough clearing): the tool
  // wraps convex island corners smoothly at a true rounded offset, never
  // gouging the island. Outer/wall rings stay mitered and receive broad
  // emit-time transitions; a Pocket root ring pairs each transition with an
  // immediate contained cleanup of its exact source span.
  const islandJoinType = operation.roundOutsideCorners
    ? ClipperLib.JoinType.jtRound
    : ClipperLib.JoinType.jtMiter
  const regionTrees = band.regions
    .flatMap((region) => buildInsetRegions(region, initialInset, ClipperLib.JoinType.jtMiter, islandJoinType))
    .map((region) => buildOffsetRegionTree(region, effectiveStepover, islandJoinType))
  const smoothRadius = cornerSmoothingRadius(operation.roundOutsideCorners, toolRadius, effectiveStepover)
  // Tangential links (issue #545): replace the straight ring-to-ring link
  // with a tangent S-curve, gated by the operation field (absent = today's
  // straight links). The domain is the band's tool-centre region — the tree
  // roots are exactly that construction — and the solver falls back to the
  // straight link when nothing fits.
  const tangentLink = operation.kind === 'pocket'
    ? pocketTangentLinkOptions(
      operation.roundLinkCorners,
      toolRadius * 2,
      regionTrees.map((tree) => tree.region),
    )
    : undefined
  // Cache exact emission-order classification by the ordered cut-segment
  // stream. Most levels reuse one traversal; if position seeding genuinely
  // changes the order, that order gets its own classification instead of
  // reusing a conservative approximation with the wrong prior-cut context.
  const engagementCacheEnabled = telemetry !== null && operation.pocketFeedReduction === 'engagement'
  const wallCleanup = operation.kind === 'pocket' && operation.roundOutsideCorners
    && operation.cleanWallCorners === true
    ? {
        enabled: true,
        onFallback: (): void => appendUniqueWarning(warnings, {
          code: 'pocketWallCornerCleanupFallback',
        }),
      }
    : undefined
  const ringPerimeters = engagementCacheEnabled
    ? buildRingPerimeterIndex(regionTrees, direction, smoothRadius ?? null, wallCleanup !== undefined)
    : null
  const engagementCaches = new Map<string, OffsetBandEngagementClassification>()
  const entryPolicy = withEntryHandoffFeedScale(
    createEntryPolicy(
      operation,
      toolRadius * 2,
      regionTrees.map((tree) => tree.region),
      (warning) => appendUniqueWarning(warnings, warning),
    ),
    slotScale,
  )

  // Keep XY travel at the global safe Z, but start the entry just above the
  // previous level's floor instead of at safe Z — otherwise a deep pocket
  // spends most of its helix cutting air. Safe because the ring tree above is
  // built once and reused, so every level clears the same XY footprint and the
  // level above has already emptied everything down to stepLevels[i - 1]. The
  // first level of each band has no cleared floor yet and stays at safe Z.
  for (let levelIndex = 0; levelIndex < stepLevels.length; levelIndex += 1) {
    const z = stepLevels[levelIndex]
    const levelEntryPolicy = withEntryStartZ(
      entryPolicy,
      levelIndex === 0 ? safeZ : Math.min(safeZ, stepLevels[levelIndex - 1] + entryClearance),
    )
    if (regionTrees.length === 0) {
      warnings.push({ code: 'surfaceNoOffsetContours', params: { topZ: band.topZ, bottomZ: band.bottomZ } })
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
        'all',
        smoothRadius,
        0,
        levelEntryPolicy,
        tangentLink,
        wallCleanup,
      )
    }

    const levelEndIndex = moves.length
    let engagementCache: OffsetBandEngagementClassification | null = null
    if (ringPerimeters !== null) {
      const traversalKey = engagementTraversalKey(moves, levelStartIndex, levelEndIndex)
      engagementCache = engagementCaches.get(traversalKey) ?? null
      if (engagementCache === null) {
        engagementCache = buildOffsetBandEngagementClassification(
          moves,
          levelStartIndex,
          levelEndIndex,
          { toolRadius, ringPerimeters },
        )
        engagementCaches.set(traversalKey, engagementCache)
        engagementBandCacheBuildCount += 1
      }
    }

    applyLevelFeed(
      moves,
      levelStartIndex,
      operation,
      slotScale,
      slotDistance,
      effectiveStepover * SLOT_FEED_OWN_TRAIL_FACTOR,
      toolRadius * 2,
      effectiveStepover,
      telemetry,
      engagementCache,
    )

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
  telemetry: EngagementTelemetryAccumulator | null = null,
): { moves: ToolpathMove[]; stepLevels: number[]; warnings: ToolpathWarning[] } {
  const moves: ToolpathMove[] = []
  const warnings: ToolpathWarning[] = []
  const effectiveBottom = resolveBandBottomZ(band, operation)
  if (effectiveBottom === null) {
    return {
      moves,
      stepLevels: [],
      warnings: [{ code: 'surfaceBandNoFinishDepth', params: { topZ: band.topZ, bottomZ: band.bottomZ } }],
    }
  }

  if (!operation.finishWalls && !operation.finishFloor) {
    return {
      moves,
      stepLevels: [],
      warnings: [{ code: 'surfaceFinishBothDisabled' }],
    }
  }

  const radialLeave = Math.max(0, operation.stockToLeaveRadial)
  const finishDelta = toolRadius + radialLeave
  const shouldRoundPocketWalls = operation.kind === 'pocket' && operation.finishWalls && operation.roundOutsideCorners
  const needsMiterFinishRegions = operation.finishFloor || operation.finishWalls
  const finishRegions = needsMiterFinishRegions
    ? band.regions.flatMap((region) => buildInsetRegions(region, finishDelta))
    : []
  const slotScale = resolveSlotFeedScale(operation)
  const entryPolicy = withEntryHandoffFeedScale(
    createEntryPolicy(
      operation,
      toolRadius * 2,
      finishRegions,
      (warning) => appendUniqueWarning(warnings, warning),
    ),
    slotScale,
  )
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
  const isParallelPocket = operation.kind === 'pocket' && operation.pocketPattern === 'parallel'
  // Offset floors are cut through the same inner-first ring traversal as the
  // rough pass (each disjoint floor area starts at its innermost loop and
  // works outward). The tree roots replicate buildPocketFloorContours'
  // geometry: a zero-inset Clipper round-trip, then one extra stepover inset
  // so the floor pass doesn't double as a wall-finish contour.
  const minFloorStepover = 1 / DEFAULT_CLIPPER_SCALE
  const floorStepover = Math.max(stepoverDistance, minFloorStepover)
  const floorSmoothRadius = cornerSmoothingRadius(operation.roundOutsideCorners, toolRadius, floorStepover)
  const floorTrees = operation.finishFloor && !isParallelPocket
    ? finishRegions
      .flatMap((region) => buildInsetRegions(region, 0))
      .flatMap((region) => buildInsetRegions(region, floorStepover))
      .map((region) => buildOffsetRegionTree(region, floorStepover))
    : []
  // Tangential link junctions for the offset floor rings; the domain is the
  // wall-finish tool-centre path (finishRegions), which is the hard boundary
  // a floor-ring link may sweep up to.
  const floorTangentLink = operation.kind === 'pocket' && operation.finishFloor && !isParallelPocket
    ? pocketTangentLinkOptions(
      operation.roundLinkCorners,
      toolRadius * 2,
      finishRegions,
    )
    : undefined
  const floorWallCleanup = operation.kind === 'pocket' && operation.roundOutsideCorners
    && operation.cleanWallCorners === true
    ? {
        enabled: true,
        onFallback: (): void => appendUniqueWarning(warnings, {
          code: 'pocketWallCornerCleanupFallback',
        }),
      }
    : undefined
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
      warnings: [{ code: 'surfaceNoFinishContours', params: { topZ: band.topZ, bottomZ: band.bottomZ } }],
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
        floorSmoothRadius,
        0,
        entryPolicy,
        floorTangentLink,
        floorWallCleanup,
      )
    }

    const orderedFloorSegments = orderOpenSegmentsGreedy(
      floorSegments,
      currentPosition ? { x: currentPosition.x, y: currentPosition.y } : null,
    )
    for (const segment of orderedFloorSegments) {
      const entryPoint = contourStartPoint(segment, z)
      currentPosition = transitionToCutEntry(
        moves,
        currentPosition,
        entryPoint,
        safeZ,
        maxLinkDistance,
        undefined,
        entryPolicy,
      )
      const cutMoves = toOpenCutMoves(segment, z)
      moves.push(...cutMoves)
      currentPosition = cutMoves.at(-1)?.to ?? currentPosition
    }

    const slotDistance = Math.max(
      toolRadius * 2 * SLOT_FEED_ENGAGEMENT_FACTOR,
      floorStepover * SLOT_FEED_ADJACENCY_FACTOR,
    )
    applyLevelFeed(
      moves,
      floorStartIndex,
      operation,
      slotScale,
      slotDistance,
      floorStepover * SLOT_FEED_OWN_TRAIL_FACTOR,
      toolRadius * 2,
      floorStepover,
      telemetry,
    )

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
        undefined,
        entryPolicy,
      )
      const orderedCleanupSegments = orderOpenSegmentsGreedy(
        wallCleanupSegments,
        currentPosition ? { x: currentPosition.x, y: currentPosition.y } : null,
      )
      for (const segment of orderedCleanupSegments) {
        const entryPoint = contourStartPoint(segment, z)
        currentPosition = transitionToCutEntry(
          moves,
          currentPosition,
          entryPoint,
          safeZ,
          maxLinkDistance,
          undefined,
          entryPolicy,
        )
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
        undefined,
        entryPolicy,
      )
    } else {
      currentPosition = cutClosedContours(
        moves,
        wallContours,
        z,
        safeZ,
        maxLinkDistance,
        currentPosition,
        false,
        direction,
        undefined,
        entryPolicy,
      )
    }

    currentPosition = retractToSafe(moves, currentPosition, safeZ)
  }

  return {
    moves,
    stepLevels: [...new Set([...wallStepLevels, ...floorStepLevels])].sort((a, b) => b - a),
    warnings,
  }
}

/**
 * Clipper join type this pocket pass uses for its islands when offsetting to the
 * tool-centre wall path.
 *
 * Corner relief locates its descend point on the pass's own tool-centre path, so
 * this has to agree exactly with what the band generators pass to
 * `buildInsetRegions` — a rounded island join moves the path, and a descend point
 * that is not on the emitted path is rejected by the guard.
 */
function pocketWallIslandJoinType(operation: Operation): number {
  const roundsIslands = operation.pass === 'finish'
    // generateFinishBandMoves' shouldRoundPocketWalls
    ? operation.kind === 'pocket' && operation.finishWalls && operation.roundOutsideCorners === true
    // generateRoughBandMoves rounds islands for the offset ring tree only; the
    // parallel pattern builds its boundary contours with plain miter joins.
    : operation.roundOutsideCorners === true
      && !(operation.kind === 'pocket' && operation.pocketPattern === 'parallel')
  return roundsIslands ? ClipperLib.JoinType.jtRound : ClipperLib.JoinType.jtMiter
}

/**
 * Append the corner-relief pass for every band the operation actually cut.
 *
 * Runs after the whole main path so the descend guard reads the complete emitted
 * move stream: a deeper band that already cut through a corner position has
 * genuinely opened that column, and it is the emitted moves — not the settings —
 * that decide whether a corner is relieved.
 */
function appendPocketCornerRelief(
  allMoves: ToolpathMove[],
  warnings: ToolpathWarning[],
  bands: Array<{ band: ResolvedPocketBand; effectiveBottom: number }>,
  operation: Operation,
  toolRadius: number,
  reliefStepdown: number,
  safeZ: number,
): void {
  const style = operation.cornerRelief ?? 'none'
  if (style === 'none' || bands.length === 0) return

  const radialLeave = Math.max(0, operation.stockToLeaveRadial ?? 0)
  const wallInset = toolRadius + radialLeave
  const islandJoinType = pocketWallIslandJoinType(operation)
  const slotScale = resolveSlotFeedScale(operation)
  const mainPathMoves = [...allMoves]
  const reliefMoves: ToolpathMove[] = []
  let position: ToolpathPoint | null = null

  for (const { band, effectiveBottom } of bands) {
    const levels = generateStepLevels(band.topZ, effectiveBottom, reliefStepdown)
    if (levels.length === 0) continue

    // The cleared region is the nominal region eroded by the radial stock this
    // pass leaves, so the relief is sized to the wall this pass really produces.
    const clearedRegions = radialLeave > 0
      ? band.regions.flatMap((region) => buildInsetRegions(region, radialLeave))
      : band.regions
    const clearedLoops: ReliefLoop[] = clearedRegions.flatMap((region) => [
      { points: region.outer, clearedInside: true },
      // An island is a hole in the cleared region: its reflex corners (an
      // L-shaped island's notch) trap a cutter exactly like a boundary corner,
      // while its convex corners are wrapped and need nothing.
      ...region.islands.map((island) => ({ points: island, clearedInside: false })),
    ])
    const wallLoops = buildContourLoops(band.regions.flatMap((region) => buildInsetRegions(
      region,
      wallInset,
      ClipperLib.JoinType.jtMiter,
      islandJoinType,
    )))

    const found = collectReliefCorners({
      style,
      toolRadius,
      clearedLoops,
      wallLoops,
    })
    found.warnings.forEach((warning) => appendUniqueWarning(warnings, warning))

    const pass = generateCornerReliefPass(position, {
      corners: found.corners,
      levels,
      safeZ,
      mainPathMoves,
      ...(slotScale !== null ? { feedScale: slotScale } : {}),
      ...(operation.debugToolpath ? { source: 'cornerRelief' } : {}),
    })
    pass.warnings.forEach((warning) => appendUniqueWarning(warnings, warning))
    reliefMoves.push(...pass.moves)
    position = pass.endPosition
  }

  retractToSafe(reliefMoves, position, safeZ)
  allMoves.push(...reliefMoves)
}

export function generatePocketToolpath(project: Project, operation: Operation): PocketToolpathResult {
  if (isFeatureFirst(operation)) {
    const parts = perFeatureOperations(operation, project)
    const sharedTelemetry = createSharedEngagementTelemetry(project, operation)
    const merged = mergePocketToolpathResults(
      operation.id,
      parts.map((subOp) => generatePocketToolpathSingle(project, subOp, sharedTelemetry)),
      { orderBlocks: 'nearest' },
    )
    return sharedTelemetry
      ? { ...merged, engagementTelemetry: sharedTelemetry.toTelemetry() }
      : merged
  }
  return generatePocketToolpathSingle(project, operation)
}

/** Shared engagement telemetry for feature-first pockets: one accumulator fed
 * by every per-feature part so the merged result reports operation totals.
 * Mirrors generatePocketToolpathSingle's tool/stepover validation; when the
 * operation could not cut anyway there is nothing to measure. */
function createSharedEngagementTelemetry(
  project: Project,
  operation: Operation,
): EngagementTelemetryAccumulator | null {
  if (!(operation.kind === 'pocket' && operation.pocketFeedReduction === 'engagement')) return null
  const toolRecord = operation.toolRef
    ? project.tools.find((tool) => tool.id === operation.toolRef) ?? null
    : null
  if (!toolRecord) return null
  const tool = normalizeToolForProject(toolRecord, project)
  if (!(tool.diameter > 0)) return null
  if (!(operation.stepover > 0 && operation.stepover <= 1)) return null
  return new EngagementTelemetryAccumulator(
    nominalEngagement(Math.max(tool.diameter * operation.stepover, 1 / DEFAULT_CLIPPER_SCALE), tool.radius),
  )
}

function generatePocketToolpathSingle(
  project: Project,
  operation: Operation,
  sharedTelemetry?: EngagementTelemetryAccumulator | null,
): PocketToolpathResult {
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
      warnings: [...resolved.warnings, { code: 'noToolAssigned' }],
      bounds: null,
      stepLevels: [],
    }
  }

  const tool = normalizeToolForProject(toolRecord, project)
  if (!(tool.diameter > 0)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...resolved.warnings, { code: 'toolDiameterPositive' }],
      bounds: null,
      stepLevels: [],
    }
  }

  if (!(operation.stepdown > 0)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...resolved.warnings, { code: 'stepdownPositive' }],
      bounds: null,
      stepLevels: [],
    }
  }

  if (!(operation.stepover > 0 && operation.stepover <= 1)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...resolved.warnings, { code: 'operationStepoverRatioRange' }],
      bounds: null,
      stepLevels: [],
    }
  }

  const safeZ = getOperationSafeZ(project)
  const entryClearance = getOperationClearance(project)
  const stepoverDistance = tool.diameter * operation.stepover
  const maxLinkDistance = tool.diameter
  const engagementMode = operation.kind === 'pocket' && operation.pocketFeedReduction === 'engagement'
  const telemetry = sharedTelemetry ?? (engagementMode
    ? new EngagementTelemetryAccumulator(
      nominalEngagement(Math.max(stepoverDistance, 1 / DEFAULT_CLIPPER_SCALE), tool.radius),
    )
    : null)
  const direction = operation.cutDirection ?? 'conventional'
  const centreInset = tool.radius + Math.max(0, operation.stockToLeaveRadial ?? 0)
  const allMoves: ToolpathMove[] = []
  const warnings = [...resolved.warnings]
  const maxBandDepth = resolved.bands.reduce((max, band) => Math.max(max, Math.abs(band.topZ - band.bottomZ)), 0)
  const depthWarning = checkMaxCutDepthWarning(tool, maxBandDepth)
  if (depthWarning) {
    warnings.push(depthWarning)
  }
  const allStepLevels = new Set<number>()
  // Bands whose main path was actually generated, for the corner-relief pass.
  // Skipped bands are left out so a band that produced no moves at all does not
  // also produce one "corner never cut" warning per corner.
  const reliefBands: Array<{ band: ResolvedPocketBand; effectiveBottom: number }> = []
  const reliefStyle = operation.cornerRelief ?? 'none'
  const reliefStepdown = reliefStyle === 'none' ? null : resolveReliefStepdown(tool)
  if (reliefStyle !== 'none' && reliefStepdown === null) {
    warnings.push({ code: 'cornerReliefNoStepdown', params: { tool: tool.name } })
  }

  const formatZ = (value: number) => Number(value.toFixed(6)).toString()
  const formatFeatureSpan = (featureId: string) => {
    const feature = resolveFeatureInstance(project, featureId)
    if (!feature) {
      return `${featureId} [missing]`
    }

    const span = resolveFeatureZSpan(project, feature)
    return `${feature.name} (${feature.id}) [${formatZ(span.max)} -> ${formatZ(span.min)}]`
  }

  const formatIslandSpan = (id: string) => {
    const feature = resolveFeatureInstance(project, id)
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
      warnings.push({ code: 'debug', params: { text: `Debug: resolved pocket bands = ${resolvedBandSummary}` } })
    }
  }

  for (const band of resolved.bands) {
    if (regionMask) {
      const scale = DEFAULT_CLIPPER_SCALE
      const outerPaths = band.regions.map((r) => toClipperPath(normalizeWinding(r.outer, false), scale))
      const bandDomain = unionClipperPaths(outerPaths)
      if (bandDomain.length === 0) continue

      const maskedDomain = resolveRegionDomainArea(bandDomain, regionMask, centreInset)
      if (maskedDomain.length === 0) continue

      const islandPaths = band.regions.flatMap((r) =>
        r.islands.map((island) => toClipperPath(normalizeWinding(island, false), scale)),
      )
      const polyTree = executeDifference(maskedDomain, islandPaths)
      band.regions = polyTreeToRegions(polyTree, band.targetFeatureIds, band.islandFeatureIds, scale)
      if (band.regions.length === 0) continue
    }

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
        telemetry,
      )
      : generateRoughBandMoves(
        band,
        operation,
        safeZ,
        entryClearance,
        operation.stepdown,
        tool.radius,
        stepoverDistance,
        maxLinkDistance,
        direction,
        telemetry,
      )
    const { moves, stepLevels, warnings: bandWarnings } = result
    moves.forEach((move) => allMoves.push(move))
    stepLevels.forEach((level) => allStepLevels.add(level))
    warnings.push(...bandWarnings)
    if (reliefStepdown !== null && moves.length > 0) {
      const reliefBottom = resolveBandBottomZ(band, operation)
      if (reliefBottom !== null) {
        reliefBands.push({ band, effectiveBottom: reliefBottom })
      }
    }
    if (operation.debugToolpath) {
      warnings.push({ code: 'debug', params: { text: `Debug: band ${formatZ(band.topZ)} -> ${formatZ(band.bottomZ)} cut levels = ${
          stepLevels.length > 0 ? stepLevels.map((level) => formatZ(level)).join(', ') : 'none'
        }` } })
      warnings.push({ code: 'debug', params: { text: `Debug: band ${formatZ(band.topZ)} -> ${formatZ(band.bottomZ)} targets = ${
          band.targetFeatureIds.length > 0 ? band.targetFeatureIds.map((id) => formatFeatureSpan(id)).join('; ') : 'none'
        }` } })
      warnings.push({ code: 'debug', params: { text: `Debug: band ${formatZ(band.topZ)} -> ${formatZ(band.bottomZ)} islands = ${
          band.islandFeatureIds.length > 0 ? band.islandFeatureIds.map((id) => formatIslandSpan(id)).join('; ') : 'none'
        }` } })
    }
  }

  if (reliefStepdown !== null) {
    appendPocketCornerRelief(
      allMoves,
      warnings,
      reliefBands,
      operation,
      tool.radius,
      reliefStepdown,
      safeZ,
    )
  }

  let bounds: ToolpathBounds | null = null
  for (const move of allMoves) {
    bounds = updateBounds(bounds, move.from)
    bounds = updateBounds(bounds, move.to)
  }

  return {
    operationId: operation.id,
    moves: allMoves,
    warnings,
    bounds,
    // Deliberately not extended with the relief pass's own levels: stepLevels
    // reports the main path's cut levels, which rest-machining and the level
    // readout are built around. The relief pass derives its levels from the tool.
    stepLevels: [...allStepLevels].sort((a, b) => b - a),
    ...(telemetry ? { engagementTelemetry: telemetry.toTelemetry() } : {}),
  }
}
