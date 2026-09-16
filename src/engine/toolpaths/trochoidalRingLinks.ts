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
 * Joining consecutive trochoidal clearing rings at depth (issue #790).
 *
 * A clearing ring's orbit closes on itself, so the rings used to be joined by a
 * retract, a rapid and a fresh helical entry. They are now joined by a straight
 * guide from the ring just cut to the next one, orbited like any other guide —
 * the same thing an edge route does along its own guide.
 *
 * A plain feed move cannot do this. At the default channel the orbit radius is
 * `0.25 D` while rings sit `0.75 D` apart, so a straight cut would arrive with
 * the cutter's front half buried — the engagement the strategy exists to avoid.
 * An orbited link needs no cleared space: it cuts through stock at the orbit's
 * own bite.
 *
 * Both joins are chords of an orbit circle that is already swept. A closed
 * orbit ends on the circle round its guide start, and the link starts from that
 * same point, so its first point lies on the same circle. The link ends on the
 * circle round the next ring's guide start, which the ring then sweeps as its
 * first, stationary turn. That is also why the link itself has no stationary
 * turns (`dwell: false`): each would repeat a circle a ring sweeps anyway.
 *
 * Shared by every generator that emits rings through `cutOffsetNodeRings`:
 * pocket, surface clean and rough surface, rough band and finish floor alike.
 * Kept out of `pocket.ts`, which already carries the ring emitter, because
 * nothing here needs pocket internals.
 */

import type { Point } from '../../types/project'
import { XY_EPSILON, samePointXY } from './geometry'
import { buildOffsetDomainCheck, domainSafePathLength, type TangentLinkDomainRegion } from './tangentLink'
import { buildTrochoidalContour, type TrochoidalContourResult } from './trochoidalEdge'
import type { TrochoidalPathParams } from './trochoidalLevelPaths'
import type { TrochoidalOperationBudget } from './trochoidalPath'
import type { ToolpathMove, ToolpathPoint } from './types'

/** Source tag on a link's orbit moves. The two joining chords stay untagged, like the ring's own cuts. */
export const TROCHOIDAL_LINK_SOURCE = 'trochoidal-link'

/**
 * Longest link, in channel widths. Nested rings sit one pitch — at most one
 * channel — apart, so anything longer is a jump between branches of the tree,
 * and those keep the retract. Two rather than one leaves room for a seam that
 * lands at a corner.
 */
const MAX_LINK_CHANNELS = 2

/**
 * Sample spacing for proving a link inside its tree root, as a fraction of the
 * cutter diameter. Between two samples a straight segment can dip into a
 * rounded obstacle of radius `r` by at most `s^2 / (8 r)`. Every wall and
 * island is at least the guide inset `W / 2 + 0.01 D` from a rough root, which
 * puts that dip under `0.0006 D` even for the narrowest `1.15 D` channel — well
 * inside the `0.01 D` allowance the inset carries.
 */
const LINK_SAMPLE_FRACTION = 0.05

/**
 * A seam foot this close to an edge end takes the vertex instead, so no
 * near-zero edge is left for the orbit's frame to be sampled across.
 */
const SEAM_SNAP_FRACTION = 0.01

/**
 * The offset tree a ring belongs to. Its region is the root of the tree, the
 * area every ring of the tree lies in, and the domain a link is proven inside.
 */
export interface TrochoidalLinkRoot {
  readonly region: TangentLinkDomainRegion
}

interface RingEnd {
  readonly root: TrochoidalLinkRoot
  /** The ring's guide start: the centre of the circle its orbit ended on. */
  readonly center: Point
  readonly params: TrochoidalPathParams
}

/**
 * Where a ring left the tool, keyed by the last move it emitted. The next ring
 * may link only while that move is still the last in the stream: a retract,
 * a rapid or any other cut in between is a different last move, so a stale
 * entry is never read and nothing needs clearing.
 */
const ringEnds = new WeakMap<ToolpathMove, RingEnd>()

interface LinkDomain {
  readonly contains: (x: number, y: number) => boolean
  /** Per segment. The same links recur on every level of an unchanged tree. */
  readonly verdicts: Map<string, boolean>
}

const linkDomains = new WeakMap<TrochoidalLinkRoot, LinkDomain>()

function sameParams(a: TrochoidalPathParams, b: TrochoidalPathParams): boolean {
  return a.orbitRadius === b.orbitRadius
    && a.advance === b.advance
    && a.toolDiameter === b.toolDiameter
    && a.angularDirection === b.angularDirection
}

function linkInsideRoot(root: TrochoidalLinkRoot, from: Point, to: Point, spacing: number): boolean {
  let domain = linkDomains.get(root)
  if (domain === undefined) {
    domain = { contains: buildOffsetDomainCheck([root.region]), verdicts: new Map() }
    linkDomains.set(root, domain)
  }
  const key = `${from.x},${from.y},${to.x},${to.y},${spacing}`
  let verdict = domain.verdicts.get(key)
  if (verdict === undefined) {
    verdict = domainSafePathLength([from, to], spacing, domain.contains) !== null
    domain.verdicts.set(key, verdict)
  }
  return verdict
}

/**
 * `points` re-seamed at the point nearest `anchor`, inserted as a vertex when
 * it falls inside an edge. Rotating to the nearest VERTEX would join nested
 * rectangles corner to corner, a diagonal `sqrt(2)` pitches long, where the
 * foot of the perpendicular is one pitch away. Ties keep the first edge, so a
 * level that repeats the same traversal repeats the same seam and the #661
 * path store still shares the ring.
 */
export function seamClosedContourNearest(points: Point[], anchor: Point, snap: number): Point[] {
  let bestDistance = Number.POSITIVE_INFINITY
  let bestIndex = 0
  let bestT = 0
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index]
    const b = points[(index + 1) % points.length]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const lengthSquared = dx * dx + dy * dy
    const t = lengthSquared > 0
      ? Math.min(1, Math.max(0, ((anchor.x - a.x) * dx + (anchor.y - a.y) * dy) / lengthSquared))
      : 0
    const distance = Math.hypot(anchor.x - (a.x + dx * t), anchor.y - (a.y + dy * t))
    if (distance < bestDistance) {
      bestDistance = distance
      bestIndex = index
      bestT = t
    }
  }

  const nextIndex = (bestIndex + 1) % points.length
  const a = points[bestIndex]
  const b = points[nextIndex]
  const edgeLength = Math.hypot(b.x - a.x, b.y - a.y)
  const rotated = (start: number): Point[] => (start === 0 ? points : [...points.slice(start), ...points.slice(0, start)])
  if (bestT * edgeLength <= snap) return rotated(bestIndex)
  if ((1 - bestT) * edgeLength <= snap) return rotated(nextIndex)
  const foot = { x: a.x + (b.x - a.x) * bestT, y: a.y + (b.y - a.y) * bestT }
  return [foot, ...points.slice(nextIndex), ...points.slice(0, nextIndex)]
}

/** Cut along an orbit's points at `z`, one move per chord. */
export function appendOrbitCuts(moves: ToolpathMove[], points: readonly Point[], z: number, source?: string): void {
  for (let index = 0; index < points.length - 1; index += 1) {
    const move: ToolpathMove = {
      kind: 'cut',
      from: { x: points[index].x, y: points[index].y, z },
      to: { x: points[index + 1].x, y: points[index + 1].y, z },
    }
    if (source !== undefined) move.source = source
    moves.push(move)
  }
}

function appendChord(moves: ToolpathMove[], from: Point, to: Point, z: number): void {
  if (samePointXY(from, to)) return
  moves.push({ kind: 'cut', from: { x: from.x, y: from.y, z }, to: { x: to.x, y: to.y, z } })
}

/**
 * Mark the ring just emitted as one the next ring may link from. `moves` must
 * end with that ring's final orbit move.
 */
export function recordTrochoidalRingEnd(
  moves: readonly ToolpathMove[],
  root: TrochoidalLinkRoot,
  center: Point,
  params: TrochoidalPathParams,
): void {
  const last = moves.at(-1)
  if (last !== undefined) ringEnds.set(last, { root, center, params })
}

function usable(built: TrochoidalContourResult, ceiling: number): boolean {
  return built.error === undefined
    && built.points.length >= 2
    && built.points.length <= ceiling
    && built.entryCenter !== null
}

/**
 * Emit `contour` as a ring joined to the one just cut, or return null —
 * having emitted and charged nothing — so the caller retracts and enters it
 * the old way. Declined unless all of these hold:
 *
 * - the last move emitted is the previous ring's final orbit move, at this Z,
 *   and the tool is still there. A retract or another section in between
 *   breaks the chain.
 * - both rings belong to one tree. The floor and 3D roughing cut tree after
 *   tree without a retract between them; separate trees keep safe-Z travel.
 * - both orbit in the same sense. An outer ring and an island loop turn
 *   opposite ways, and a link can only turn one of them.
 * - the link is at most two channels long and lies inside the tree root. The
 *   root is already inset by the guide offset, so a link inside it sweeps its
 *   channel inside the pocket, as the rings do.
 * - the ring and the link fit the operation budget. A refusal here falls back
 *   to the retract path, which reports the budget the way it always has.
 *
 * Returns the tool position after the ring.
 */
export function appendLinkedTrochoidalRing(
  moves: ToolpathMove[],
  contour: Point[],
  z: number,
  fromPosition: ToolpathPoint | null,
  params: TrochoidalPathParams,
  root: TrochoidalLinkRoot,
  budget: TrochoidalOperationBudget,
): ToolpathPoint | null {
  const last = moves.at(-1)
  const previous = last === undefined ? undefined : ringEnds.get(last)
  if (last === undefined || previous === undefined || fromPosition === null) return null
  if (previous.root !== root || !sameParams(previous.params, params)) return null
  if (last.to.z !== z || fromPosition.z !== z || fromPosition.x !== last.to.x || fromPosition.y !== last.to.y) {
    return null
  }

  const { orbitRadius, toolDiameter } = params
  const guide = seamClosedContourNearest(contour, previous.center, toolDiameter * SEAM_SNAP_FRACTION)
  const start = guide[0]
  const length = Math.hypot(start.x - previous.center.x, start.y - previous.center.y)
  const channelWidth = 2 * orbitRadius + toolDiameter
  if (!(length > XY_EPSILON) || length > channelWidth * MAX_LINK_CHANNELS) return null
  if (!linkInsideRoot(root, previous.center, start, toolDiameter * LINK_SAMPLE_FRACTION)) return null

  // The two chords are charged the way the retract path charges its transition
  // moves; each path is charged by its point count, as a ring always has been.
  const ceiling = Math.min(budget.remainingPoints, budget.remainingMoves) - 2
  const ring = budget.paths.resolve(
    guide,
    true,
    params,
    () => buildTrochoidalContour(guide, { ...params, closed: true, maxPoints: ceiling }),
  )
  if (!usable(ring.built, ceiling)) return null
  const linkGuide = [previous.center, start]
  const linkParams: TrochoidalPathParams = { ...params, dwell: false }
  const linkCeiling = ceiling - ring.built.points.length
  const link = budget.paths.resolve(
    linkGuide,
    false,
    linkParams,
    () => buildTrochoidalContour(linkGuide, { ...linkParams, closed: false, maxPoints: linkCeiling }),
  )
  if (!usable(link.built, linkCeiling)) return null

  const ringPoints = ring.built.points
  const linkPoints = link.built.points
  const emitted = 2 + linkPoints.length + ringPoints.length
  const generated = 2 + (link.generated ? linkPoints.length : 0) + (ring.generated ? ringPoints.length : 0)
  if (emitted > budget.remainingMoves || generated > budget.remainingPoints) return null
  budget.remainingMoves -= emitted
  budget.remainingPoints -= generated

  appendChord(moves, fromPosition, linkPoints[0], z)
  appendOrbitCuts(moves, linkPoints, z, TROCHOIDAL_LINK_SOURCE)
  appendChord(moves, linkPoints[linkPoints.length - 1], ringPoints[0], z)
  appendOrbitCuts(moves, ringPoints, z)
  recordTrochoidalRingEnd(moves, root, ring.built.entryCenter ?? start, params)
  const end = ringPoints[ringPoints.length - 1]
  return { x: end.x, y: end.y, z }
}
