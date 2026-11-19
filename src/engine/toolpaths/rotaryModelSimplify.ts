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

import type { ToolpathMove, ToolpathPoint } from './types'

/** Perpendicular distance of `point` from the line through `a` and `b`. */
function distanceFromLine(
  point: { x: number; y: number; z: number },
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const abz = b.z - a.z
  const apx = point.x - a.x
  const apy = point.y - a.y
  const apz = point.z - a.z
  const lengthSq = abx * abx + aby * aby + abz * abz
  if (lengthSq <= 1e-18) return Math.hypot(apx, apy, apz)
  const crossX = apy * abz - apz * aby
  const crossY = apz * abx - apx * abz
  const crossZ = apx * aby - apy * abx
  return Math.hypot(crossX, crossY, crossZ) / Math.sqrt(lengthSq)
}

/**
 * How much higher than its sampled heights an around pass may run where
 * `raiseShortAroundSegments` merges short steps (#1173), in mm.
 */
export const AROUND_RAISE_TOLERANCE_MM = 0.02

/**
 * Drop the short steps the around refinement leaves on a smooth surface by
 * merging upward only (#1173).
 *
 * The refinement bisects a segment whenever its sampled midpoint stands more
 * than 0.005 mm above the chord, and the conservative read's per-angle lift
 * varies by more than that between neighbouring angles (0.0088-0.0093 in on the
 * plain Ø1 shank of Frank's bolt). So it halves good chords down to 0.28-0.45
 * degree steps: 4-10 ms blocks in inverse time next to blocks of a second, which
 * a controller cannot follow at a steady A speed.
 *
 * An interior point of a run of around cuts is dropped only when the chord that
 * replaces it stands **at or above every original point it spans**, at that
 * point's own A, and by no more than `raise`. The new path is then at or above
 * the old one everywhere -- above each original segment, because both are
 * straight and the chord is above their ends -- so it can never cut deeper than
 * the sampled heights allowed; it can only leave up to `raise` more material.
 * Only points next to a step finer than `baseStep` -- the base angular
 * grid's, so a step the refinement inserted -- are considered, and the
 * ordinary grid, which the 0.005 mm sagitta cap spaces, is left exactly as it
 * was. A run is a chain of contiguous cut moves that all turn A the same way
 * (rings and helices alike; a stepped leg, which does not turn A, ends it), and
 * a helix point is dropped only when the chord also reaches its along position
 * within `alongTolerance`.
 */
export function raiseShortAroundSegments(
  moves: readonly ToolpathMove[],
  baseStep: number,
  raise: number,
  alongTolerance: number,
  /**
   * A point that is never dropped (#1177). The finish's shoulder-cleanup ring is
   * cut on its own 0.45 degree grid -- a step this pass would otherwise merge
   * back to the base grid because the chord over it stays within `raise` -- and
   * merging it would put the scallop above the neighbour's flat back over the
   * handoff's 0.05 mm.
   */
  protectedPoint?: (point: ToolpathPoint) => boolean,
): ToolpathMove[] {
  const out: ToolpathMove[] = []
  const turns = (move: ToolpathMove): number => Math.sign((move.to.a ?? 0) - (move.from.a ?? 0))
  // A step finer than the base grid's was inserted by the refinement.
  const short = (a: ToolpathPoint, b: ToolpathPoint): boolean =>
    Math.abs((b.a ?? 0) - (a.a ?? 0)) < baseStep * (1 - 1e-6)
  let index = 0
  while (index < moves.length) {
    const first = moves[index]
    const direction = first.kind === 'cut' ? turns(first) : 0
    if (direction === 0) {
      out.push(first)
      index++
      continue
    }
    let end = index
    while (end + 1 < moves.length) {
      const next = moves[end + 1]
      const previous = moves[end]
      if (next.kind !== 'cut' || turns(next) !== direction) break
      if (next.from.x !== previous.to.x || next.from.y !== previous.to.y
        || next.from.z !== previous.to.z || next.from.a !== previous.to.a) break
      end++
    }
    const points: ToolpathPoint[] = [moves[index].from]
    for (let i = index; i <= end; i++) points.push(moves[i].to)
    const last = points.length - 1
    // A point may go only when a step next to it is short, and a pinned point
    // (#1177: the cleanup ring's own samples) never goes.
    const droppable = points.map((point, i) => i > 0 && i < last
      && (protectedPoint === undefined || !protectedPoint(point))
      && (short(points[i - 1], point) || short(point, points[i + 1])))
    // Whether the chord from `a` to `b` stands over every original point between them.
    const chordHolds = (a: number, b: number): boolean => {
      const from = points[a]
      const to = points[b]
      const turn = (to.a ?? 0) - (from.a ?? 0)
      for (let i = a + 1; i < b; i++) {
        const f = ((points[i].a ?? 0) - (from.a ?? 0)) / turn
        const z = from.z + (to.z - from.z) * f
        const lift = z - points[i].z
        if (!(lift >= 0 && lift <= raise)) return false
        if (Math.abs(from.x + (to.x - from.x) * f - points[i].x) > alongTolerance) return false
        if (Math.abs(from.y + (to.y - from.y) * f - points[i].y) > alongTolerance) return false
      }
      return true
    }
    let anchor = 0
    while (anchor < last) {
      let reach = anchor + 1
      while (reach < last && droppable[reach] && chordHolds(anchor, reach + 1)) reach++
      out.push({ kind: 'cut', from: points[anchor], to: points[reach] })
      anchor = reach
    }
    index = end + 1
  }
  return out
}

/**
 * The error a merged around move makes at one original sample (#1045 slice H).
 *
 * The controller interpolates A and Z linearly along one move, so the sample's
 * own A fixes the fraction: the merged move is interrogated **at that A** and
 * the difference in Z (and in the along coordinate) is the real tool-position
 * error. Slice G measured the perpendicular distance in (along, A, Z) space
 * instead. That is not the same test: an error in Z can be hidden by the A
 * component of the perpendicular, so at a fixed A the move commanded more Z
 * error than the tolerance. Codex's three tips -- (A0, 10), (A0.1, 10.0151),
 * (A0.2, 10.028) -- collapse to one perpendicular distance of 0.000858 mm under
 * the old metric yet command 10.014 at A0.1: 0.0011 mm off the 0.001 mm
 * tolerance. Interpolating at the sample's own A keeps the middle point.
 *
 * When A does not change (a stepped leg has its own run), the fraction comes
 * from the along motion, and a point outside the segment's A span is never
 * dropped (it has no commanded position on the merged move).
 */
function interpolationErrorAtOwnAngle(
  point: { x: number; y: number; z: number; a?: number },
  a: { x: number; y: number; z: number; a?: number },
  b: { x: number; y: number; z: number; a?: number },
): number {
  const deltaAngle = (b.a ?? 0) - (a.a ?? 0)
  let fraction: number
  if (deltaAngle !== 0) {
    fraction = ((point.a ?? 0) - (a.a ?? 0)) / deltaAngle
  } else {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const lengthSq = dx * dx + dy * dy
    if (lengthSq <= 1e-18) return Math.hypot(point.x - a.x, point.y - a.y, point.z - a.z)
    fraction = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq
  }
  if (!(fraction >= -1e-9 && fraction <= 1 + 1e-9)) return Number.POSITIVE_INFINITY
  const f = Math.min(1, Math.max(0, fraction))
  return Math.max(
    Math.abs(point.x - (a.x + (b.x - a.x) * f)),
    Math.abs(point.y - (a.y + (b.y - a.y) * f)),
    Math.abs(point.z - (a.z + (b.z - a.z) * f)),
  )
}

/**
 * Drop the collinear interior points of every run of `cut` moves that share one
 * pass, keeping the run's first and last point. A run never crosses a move that
 * turns the stock -- the same rule `linearMoveOptimization` follows (issue
 * #393): the merged move would keep only one endpoint's angle, and every angle
 * this toolpath emits is a command the machine must reach. Runs also stop where
 * the tool reverses along the bar, so a merge can never join two passes that
 * happen to line up in X through the link between them.
 *
 * With `pivot` (an around pass, #1045 slice G) a run *is* allowed to turn: the
 * controller interpolates A and Z linearly, so consecutive cut moves inside one
 * ring are one straight move in (along, A, Z). Runs still stop where A reverses
 * and at a stepped leg (A constant, Z or along moving), so the emitter's
 * rise/traverse/drop links are never joined into one diagonal. Along mode and
 * round bars pass no pivot and keep the old rule and the old distance exactly.
 */
export function mergeCollinearCuts(
  moves: readonly ToolpathMove[],
  tolerance: number,
  pivot?: number,
  /**
   * A point that is never dropped (#1177). The finish's shoulder-cleanup ring is
   * cut on its own 0.45 degree grid, whose steps are inside this merge's
   * 0.001 mm tolerance of one chord; merging them would put the ring back on the
   * coarse emitted path and the scallop above the neighbour's flat back over the
   * handoff's 0.05 mm. Nothing else passes a predicate, so every other run
   * merges as it did.
   */
  protectedPoint?: (point: ToolpathPoint) => boolean,
): { moves: ToolpathMove[]; dropped: number } {
  const angular = pivot !== undefined
  const merged: ToolpathMove[] = []
  let index = 0
  while (index < moves.length) {
    const first = moves[index]
    if (first.kind !== 'cut' || (!angular && first.from.a !== first.to.a)) {
      merged.push(first)
      index++
      continue
    }
    const direction = angular
      ? angularDirection(first.from, first.to)
      : Math.sign((first.to.x - first.from.x) + (first.to.y - first.from.y))
    let end = index
    while (
      end + 1 < moves.length
      && moves[end + 1].kind === 'cut'
      && moves[end + 1].from.x === moves[end].to.x
      && moves[end + 1].from.y === moves[end].to.y
      && (!angular || moves[end + 1].from.z === moves[end].to.z)
      && (!angular || moves[end + 1].from.a === moves[end].to.a)
      && (!angular || angularDirection(moves[end + 1].from, moves[end + 1].to) === direction)
      && (angular
        || (moves[end + 1].from.a === moves[end + 1].to.a
          && moves[end + 1].from.a === first.from.a
          && Math.sign((moves[end + 1].to.x - moves[end + 1].from.x) + (moves[end + 1].to.y - moves[end + 1].from.y)) === direction))
    ) end++
    const points: ToolpathPoint[] = [moves[index].from]
    for (let i = index; i <= end; i++) points.push(moves[i].to)
    // A protected point is never dropped (#1177). The cleanup ring's run can
    // continue into the forward link that leaves it, so the run is not wholly
    // at one along position; pinning the ring's own points keeps its 0.45 degree
    // grid while the link after it still merges as every other link does.
    const pinned = protectedPoint === undefined
      ? undefined
      : Uint8Array.from(points, (candidate, i) => (i > 0 && i < points.length - 1
        && protectedPoint(candidate) ? 1 : 0))
    // An around run interpolates at each sample's own A; the along and round-bar
    // paths keep the original 3D perpendicular distance byte for byte.
    const kept = simplifyRun(points, tolerance, angular, pinned)
    for (let i = 0; i + 1 < kept.length; i++) {
      merged.push({ kind: 'cut', from: kept[i], to: kept[i + 1] })
    }
    index = end + 1
  }
  return { moves: merged, dropped: moves.length - merged.length }
}

/**
 * The direction of one move for the around-pass merge: A when the move turns the
 * blank, otherwise the along/centre motion the old rule used. A stepped leg (A
 * constant, a pure Z move) yields zero, so it always starts its own run and is
 * never folded into a ring chord.
 */
function angularDirection(from: ToolpathPoint, to: ToolpathPoint): number {
  const deltaAngle = (to.a ?? from.a ?? 0) - (from.a ?? 0)
  if (deltaAngle !== 0) return Math.sign(deltaAngle)
  return Math.sign((to.x - from.x) + (to.y - from.y))
}

/**
 * Douglas--Peucker: a straight segment replaces the points it spans only when
 * **every** one of them is within `tolerance` of it, so the merged path can
 * never drift further from a dropped point than the tolerance. The check this
 * replaced tested each point against the *next original* point only, so on a
 * gently curved profile (`r(x) = 6 - 0.001 (x - 20)^2`, 0.05 mm samples) every
 * step looked straight and the whole run collapsed into one chord 0.0995 mm
 * below the surface -- 100 times the 0.001 mm the merge promises.
 *
 * Cost on the slice-B fixture (the merge over every pass at once): Douglas--
 * Peucker took 15 ms from 78,624 pre-merge moves to 7,296 on the finish, and
 * 2.8 ms from 36,282 to 2,136 on the rough, against the old neighbour scan's
 * single pass. The farthest-point split makes it near `n log n` per run rather
 * than `n`, which the fixture's 252 passes and 751 samples do not notice.
 *
 * `interpolate` (an around pass) measures each point as the merged move's error
 * **at that point's own A**, as {@link interpolationErrorAtOwnAngle} describes.
 * Without it the distance is the original 3D one, to the bit.
 */
function simplifyRun(
  points: readonly ToolpathPoint[],
  tolerance: number,
  interpolate = false,
  /** Points that must be kept (#1177); they also bound each merged segment. */
  pinned?: Uint8Array,
): ToolpathPoint[] {
  const distance = interpolate
    ? (point: ToolpathPoint, a: ToolpathPoint, b: ToolpathPoint): number => interpolationErrorAtOwnAngle(point, a, b)
    : (point: ToolpathPoint, a: ToolpathPoint, b: ToolpathPoint): number => distanceFromLine(point, a, b)
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack: Array<[number, number]> = []
  let segmentStart = 0
  if (pinned !== undefined) {
    for (let i = 1; i < points.length - 1; i++) {
      if (pinned[i] === 0) continue
      keep[i] = 1
      stack.push([segmentStart, i])
      segmentStart = i
    }
  }
  stack.push([segmentStart, points.length - 1])
  while (stack.length > 0) {
    const [first, last] = stack.pop() as [number, number]
    let split = -1
    let farthest = tolerance
    for (let i = first + 1; i < last; i++) {
      const pointDistance = distance(points[i], points[first], points[last])
      if (pointDistance > farthest) {
        farthest = pointDistance
        split = i
      }
    }
    if (split < 0) continue
    keep[split] = 1
    stack.push([first, split], [split, last])
  }
  const kept: ToolpathPoint[] = []
  for (let i = 0; i < points.length; i++) if (keep[i]) kept.push(points[i])
  return kept
}
