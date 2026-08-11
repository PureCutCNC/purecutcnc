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
 * Smooth-tab motion for the shared tab pass (issue #414).
 *
 * The rectangular tab branch in `tabs.ts` works one source move at a time,
 * which is fine because a rectangular tab's Z depends only on whether a point is
 * inside the footprint. A smooth tab's Z depends on *how far through the
 * crossing* a point is, and the source path has no obligation to split its moves
 * at footprint boundaries — a contour may cross one tab in a single long move or
 * in forty short ones, and an arc is always many.
 *
 * So this module measures crossings in path distance along whole connected,
 * coplanar cut chains before any sampling happens. The emitted Z envelope then
 * depends on the geometry of the crossing alone, and re-segmenting the same XY
 * path leaves it unchanged.
 */

import type { Point } from '../../types/project'
import type { TabShape } from '../../types/project'
import type { ToolpathMove, ToolpathPoint } from './types'
import { smoothTabSampleFractions, smoothTabZAt } from './tabProfile'

/** Tolerance for treating two arc-length positions as the same point. */
const ARC_EPSILON = 1e-6
/** Tolerance for parameter and Z comparisons, matching `tabs.ts`. */
const EPSILON = 1e-9

/** The tab envelope this module needs; `tabs.ts` owns how it is built. */
export interface TabEnvelope {
  points: Point[]
  zTop: number
  zBottom: number
  shape: TabShape
}

/** Geometry helpers `tabs.ts` already owns, injected so they stay single-source. */
export interface TabGeometryOps {
  pointInPolygon: (x: number, y: number, polygon: Point[]) => boolean
  clipSegmentPolygon2D: (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    polygon: Point[],
  ) => [number, number] | null
}

interface Crossing {
  envelopeIndex: number
  /** Arc length at footprint entry, measured from the chain start. */
  start: number
  /** Arc length at footprint exit. Exceeds the chain length when it wraps a seam. */
  end: number
  topZ: number
  entryTruncated: boolean
  exitTruncated: boolean
  /** Arc-length positions the profile must be sampled at. */
  samples: number[]
}

interface Chain {
  baseZ: number
  totalLength: number
  closed: boolean
  /** Arc length from the chain start to each member move's `from`. */
  startDistance: number[]
  /** XY length of each member move. */
  moveLength: number[]
  /** Index within `moveIndices` for each source move index. */
  memberOf: Map<number, number>
  smoothCrossings: Crossing[]
  /** Rectangular coverage, in arc length: one merged interval list per envelope. */
  rectIntervals: Array<{ envelopeIndex: number; start: number; end: number; topZ: number }>
}

export interface SmoothTabPlan {
  chains: Chain[]
  /** Source move index to its chain, or undefined when the move is not a flat cut. */
  chainOf: Map<number, number>
  envelopes: TabEnvelope[]
  ops: TabGeometryOps
}

function isFlatCut(move: ToolpathMove): boolean {
  return move.kind === 'cut' && Math.abs(move.from.z - move.to.z) <= EPSILON
}

function xyLength(move: ToolpathMove): number {
  return Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y)
}

function sameXY(a: ToolpathPoint, b: ToolpathPoint): boolean {
  return Math.abs(a.x - b.x) <= EPSILON && Math.abs(a.y - b.y) <= EPSILON
}

/**
 * Merge arc-length intervals that touch or overlap. Consecutive moves crossing
 * one footprint produce intervals that meet exactly at the move boundary, so
 * without this a single crossing would look like several.
 */
function mergeIntervals(intervals: Array<[number, number]>): Array<[number, number]> {
  if (intervals.length === 0) return []
  const sorted = [...intervals].sort((left, right) => left[0] - right[0])
  const merged: Array<[number, number]> = [[sorted[0][0], sorted[0][1]]]
  for (let index = 1; index < sorted.length; index += 1) {
    const [start, end] = sorted[index]
    const last = merged[merged.length - 1]
    if (start <= last[1] + ARC_EPSILON) {
      last[1] = Math.max(last[1], end)
    } else {
      merged.push([start, end])
    }
  }
  return merged
}

function buildChains(moves: ToolpathMove[]): { chains: Chain[]; chainOf: Map<number, number> } {
  const chains: Chain[] = []
  const chainOf = new Map<number, number>()

  let index = 0
  while (index < moves.length) {
    if (!isFlatCut(moves[index])) {
      index += 1
      continue
    }

    const baseZ = moves[index].from.z
    const members: number[] = [index]
    let end = index + 1
    while (
      end < moves.length
      && isFlatCut(moves[end])
      && Math.abs(moves[end].from.z - baseZ) <= EPSILON
      && sameXY(moves[end - 1].to, moves[end].from)
    ) {
      members.push(end)
      end += 1
    }

    const startDistance: number[] = []
    const moveLength: number[] = []
    let cumulative = 0
    for (const memberIndex of members) {
      startDistance.push(cumulative)
      const length = xyLength(moves[memberIndex])
      moveLength.push(length)
      cumulative += length
    }

    const memberOf = new Map<number, number>()
    members.forEach((moveIndex, position) => {
      memberOf.set(moveIndex, position)
      chainOf.set(moveIndex, chains.length)
    })

    chains.push({
      baseZ,
      totalLength: cumulative,
      closed: members.length > 1 && sameXY(moves[members[0]].from, moves[members[members.length - 1]].to),
      startDistance,
      moveLength,
      memberOf,
      smoothCrossings: [],
      rectIntervals: [],
    })

    index = end
  }

  return { chains, chainOf }
}

/**
 * Measure every tab crossing of every cut chain, once, before anything is
 * emitted. This is the step that makes the result independent of how the source
 * path was segmented.
 */
export function planSmoothTabMotion(
  moves: ToolpathMove[],
  envelopes: TabEnvelope[],
  chordTolerance: number,
  ops: TabGeometryOps,
): SmoothTabPlan {
  const { chains, chainOf } = buildChains(moves)

  const memberIndicesByChain: number[][] = chains.map(() => [])
  for (const [moveIndex, chainIndex] of chainOf) {
    memberIndicesByChain[chainIndex].push(moveIndex)
  }
  for (const list of memberIndicesByChain) {
    list.sort((left, right) => left - right)
  }

  chains.forEach((chain, chainIndex) => {
    const memberIndices = memberIndicesByChain[chainIndex]

    envelopes.forEach((envelope, envelopeIndex) => {
      const active = chain.baseZ < envelope.zTop && chain.baseZ >= envelope.zBottom
      if (!active) {
        return
      }

      const raw: Array<[number, number]> = []
      memberIndices.forEach((moveIndex, position) => {
        const move = moves[moveIndex]
        const interval = ops.clipSegmentPolygon2D(
          move.from.x,
          move.from.y,
          move.to.x,
          move.to.y,
          envelope.points,
        )
        if (!interval) {
          return
        }
        const start = chain.startDistance[position]
        const length = chain.moveLength[position]
        raw.push([start + interval[0] * length, start + interval[1] * length])
      })

      let merged = mergeIntervals(raw)
      if (merged.length === 0) {
        return
      }

      if (envelope.shape !== 'smooth') {
        for (const [start, end] of merged) {
          chain.rectIntervals.push({ envelopeIndex, start, end, topZ: envelope.zTop })
        }
        return
      }

      // A closed chain has no real ends. When its seam happens to fall inside a
      // footprint the crossing arrives here as two fragments, one at each end of
      // the arc-length axis; rejoining them across the seam is what keeps the
      // ramp continuous and independent of where the loop happens to start.
      const first = merged[0]
      const last = merged[merged.length - 1]
      let wrapped = false
      if (
        chain.closed
        && merged.length > 1
        && first[0] <= ARC_EPSILON
        && last[1] >= chain.totalLength - ARC_EPSILON
      ) {
        merged = merged.slice(1, -1)
        merged.push([last[0], first[1] + chain.totalLength])
        wrapped = true
      }

      const chainStart = moves[memberIndices[0]].from
      const chainEnd = moves[memberIndices[memberIndices.length - 1]].to
      const startsInside = ops.pointInPolygon(chainStart.x, chainStart.y, envelope.points)
      const endsInside = ops.pointInPolygon(chainEnd.x, chainEnd.y, envelope.points)

      for (const [start, end] of merged) {
        const isWrapCrossing = wrapped && end > chain.totalLength + ARC_EPSILON
        // Truncated only when the *chain* stops inside the footprint, not merely
        // when the crossing happens to begin at arc 0 because the chain starts
        // exactly on the boundary.
        const entryTruncated = !isWrapCrossing && !chain.closed && start <= ARC_EPSILON && startsInside
        const exitTruncated =
          !isWrapCrossing && !chain.closed && end >= chain.totalLength - ARC_EPSILON && endsInside

        const length = end - start
        if (!(length > ARC_EPSILON)) {
          continue
        }

        const rise = envelope.zTop - chain.baseZ
        const samples = smoothTabSampleFractions(rise, chordTolerance)
          .map((fraction) => start + fraction * length)

        chain.smoothCrossings.push({
          envelopeIndex,
          start,
          end,
          topZ: envelope.zTop,
          entryTruncated,
          exitTruncated,
          samples,
        })
      }
    })
  })

  return { chains, chainOf, envelopes, ops }
}

/** Normalized position of `arc` within a crossing, or null when outside it. */
function crossingFraction(crossing: Crossing, arc: number, totalLength: number): number | null {
  const length = crossing.end - crossing.start
  if (!(length > 0)) {
    return null
  }

  const candidates = [arc, arc + totalLength]
  for (const candidate of candidates) {
    if (candidate >= crossing.start - ARC_EPSILON && candidate <= crossing.end + ARC_EPSILON) {
      return Math.min(1, Math.max(0, (candidate - crossing.start) / length))
    }
  }
  return null
}

function crossingContains(crossing: Crossing, arc: number, totalLength: number): boolean {
  return crossingFraction(crossing, arc, totalLength) !== null
}

/**
 * Highest Z any active tab requires at `arc`.
 *
 * `activeRect` and `activeSmooth` are the tabs that cover the *sub-interval*
 * being emitted, decided once at its midpoint. Selecting them per sub-interval
 * rather than per query point is what keeps a rectangular footprint's step at
 * its own boundary instead of smearing across it, and it is how the existing
 * rectangular branch already behaves.
 */
function requiredZ(
  arc: number,
  baseZ: number,
  totalLength: number,
  activeRect: Array<{ topZ: number }>,
  activeSmooth: Crossing[],
): number {
  let required = baseZ
  for (const rect of activeRect) {
    required = Math.max(required, rect.topZ)
  }
  for (const crossing of activeSmooth) {
    const fraction = crossingFraction(crossing, arc, totalLength)
    if (fraction === null) {
      continue
    }
    required = Math.max(
      required,
      smoothTabZAt(fraction, baseZ, crossing.topZ, crossing.entryTruncated, crossing.exitTruncated),
    )
  }
  return required
}

/**
 * Split one flat cut move against the planned tab envelope.
 *
 * Mirrors `splitCutMoveAcrossTabsFrom` in `tabs.ts` — same breakpoint rounding,
 * same transition moves, same `actualFrom` threading — and differs only in that
 * a sub-interval whose required Z changes across it is emitted as one cut move
 * that moves XY and Z together, instead of a vertical step plus a flat cut.
 */
export function splitCutMoveWithSmoothTabs(
  plan: SmoothTabPlan,
  moveIndex: number,
  move: ToolpathMove,
  actualFrom: ToolpathPoint,
): ToolpathMove[] {
  const chainIndex = plan.chainOf.get(moveIndex)
  if (chainIndex === undefined) {
    return [{ ...move, from: { ...actualFrom } }]
  }

  const chain = plan.chains[chainIndex]
  const position = chain.memberOf.get(moveIndex)
  if (position === undefined) {
    return [{ ...move, from: { ...actualFrom } }]
  }

  const baseZ = chain.baseZ
  const moveStart = chain.startDistance[position]
  const moveLength = chain.moveLength[position]
  const arcAt = (t: number) => moveStart + t * moveLength
  const localT = (arc: number) => (moveLength > 0 ? (arc - moveStart) / moveLength : 0)

  const rectHere = chain.rectIntervals.filter(
    (interval) => interval.end > moveStart - ARC_EPSILON && interval.start < moveStart + moveLength + ARC_EPSILON,
  )
  const smoothHere = chain.smoothCrossings.filter((crossing) => {
    for (let step = 0; step <= 2; step += 1) {
      if (crossingContains(crossing, arcAt(step / 2), chain.totalLength)) {
        return true
      }
    }
    return (
      crossing.start >= moveStart - ARC_EPSILON
      && crossing.start <= moveStart + moveLength + ARC_EPSILON
    )
  })

  if (rectHere.length === 0 && smoothHere.length === 0) {
    return [{ ...move, from: { ...actualFrom } }]
  }

  const breakValues: number[] = [0, 1]
  for (const interval of rectHere) {
    breakValues.push(localT(interval.start), localT(interval.end))
  }
  for (const crossing of smoothHere) {
    breakValues.push(localT(crossing.start), localT(crossing.end))
    breakValues.push(localT(crossing.start - chain.totalLength), localT(crossing.end - chain.totalLength))
    for (const sample of crossing.samples) {
      breakValues.push(localT(sample), localT(sample - chain.totalLength))
    }
  }

  const breakpoints = Array.from(new Set(
    breakValues
      .filter((value) => value >= -1e-6 && value <= 1 + 1e-6)
      .map((value) => Math.max(0, Math.min(1, Number(value.toFixed(9))))),
  )).sort((left, right) => left - right)

  const result: ToolpathMove[] = []
  let current = { ...actualFrom }

  for (let index = 0; index < breakpoints.length - 1; index += 1) {
    const startT = breakpoints[index]
    const endT = breakpoints[index + 1]
    if (endT - startT <= EPSILON) {
      continue
    }

    const midArc = arcAt((startT + endT) / 2)
    const activeRect = rectHere.filter(
      (interval) => midArc >= interval.start - ARC_EPSILON && midArc <= interval.end + ARC_EPSILON,
    )
    const activeSmooth = smoothHere.filter((crossing) => crossingContains(crossing, midArc, chain.totalLength))

    const zStart = requiredZ(arcAt(startT), baseZ, chain.totalLength, activeRect, activeSmooth)
    const zEnd = requiredZ(arcAt(endT), baseZ, chain.totalLength, activeRect, activeSmooth)

    const segmentStart = {
      x: move.from.x + (move.to.x - move.from.x) * startT,
      y: move.from.y + (move.to.y - move.from.y) * startT,
      z: zStart,
    }
    const segmentEnd = {
      x: move.from.x + (move.to.x - move.from.x) * endT,
      y: move.from.y + (move.to.y - move.from.y) * endT,
      z: zEnd,
    }

    if (
      Math.abs(current.x - segmentStart.x) > EPSILON
      || Math.abs(current.y - segmentStart.y) > EPSILON
      || Math.abs(current.z - segmentStart.z) > EPSILON
    ) {
      const transitionTo = { x: segmentStart.x, y: segmentStart.y, z: segmentStart.z }
      result.push({
        kind: segmentStart.z > current.z ? 'lead_out' : 'lead_in',
        from: current,
        to: transitionTo,
      })
      current = transitionTo
    }

    if (
      Math.abs(segmentStart.x - segmentEnd.x) > EPSILON
      || Math.abs(segmentStart.y - segmentEnd.y) > EPSILON
      || Math.abs(segmentStart.z - segmentEnd.z) > EPSILON
    ) {
      result.push({
        kind: 'cut',
        from: { ...segmentStart },
        to: { ...segmentEnd },
      })
      current = { ...segmentEnd }
    }
  }

  return result.length > 0 ? result : [{ ...move, from: { ...actualFrom } }]
}
