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
 * Compare a rotary toolpath's depth with a baseline run of the same operation,
 * point by point (#1155 rn-a).
 *
 * Every point the candidate emits (both ends of every move, rapids included)
 * is checked against the **deepest baseline cut through the same along position
 * and angle**. That depth is interpolated along each baseline segment, because
 * a rotary move turns A and moves the radius linearly between its ends: a
 * ring, a helix, an along pass and a radial plunge are all handled by the same
 * parametrisation. Angles are compared modulo 360.
 *
 * A baseline move at or above `airRadius` is air (a travel-height link) and
 * never counts as a cut through a point (#1173): it removes nothing, so taking
 * it as the deepest pass over a spot the baseline cuts with neighbouring helix
 * turns reported a helix-to-ring change as 2.59 mm too deep.
 *
 * A point no baseline segment passes through -- a ring the candidate cuts
 * between two turns of a baseline helix, say -- is compared with the baseline
 * **across along**: the adjacent baseline crossings of the same angle on either
 * side (the nearest position, the deepest layer there), at most `maxAlongGap`
 * away, interpolated linearly. A point with neither
 * is not skipped: it must be in the air (at or above `airRadius`, the blank's
 * largest radius), or it counts as an uncovered point in material, which fails
 * the comparison just like a point that is too deep.
 */

import type { BarStock } from '../types/project'
import { barPivotZ } from '../types/barStock'
import type { ToolpathMove, ToolpathPoint } from '../engine/toolpaths/types'

interface Segment {
  readonly along0: number
  readonly along1: number
  readonly a0: number
  readonly a1: number
  readonly tip0: number
  readonly tip1: number
}

interface Crossing {
  readonly along: number
  readonly tip: number
}

export interface RotaryDepthComparison {
  /** Candidate points checked: both ends of every move. */
  readonly points: number
  /** Points a baseline segment passes through. */
  readonly covered: number
  /** Points between two baseline crossings of their angle, interpolated across along. */
  readonly bracketed: number
  /** Points no baseline segment passes through, at or above the air radius. */
  readonly uncoveredInAir: number
  /** Points no baseline segment passes through, below the air radius. */
  readonly uncoveredInMaterial: number
  /** Covered points deeper than the baseline by more than the tolerance. */
  readonly tooDeep: number
  /** The largest `baseline - candidate` depth over covered points (negative: never deeper). */
  readonly deepest: number
  /** Where the worst point is, for the failure message. */
  readonly where: string
}

export interface RotaryDepthOptions {
  /** How far along a point may sit from a baseline segment and still lie on it. */
  readonly alongTolerance: number
  /** How much deeper than the baseline a covered point may be. */
  readonly depthTolerance: number
  /** Tip radius at and above which a point is in the air. */
  readonly airRadius: number
  /** The widest along gap between two baseline crossings a point may be interpolated across. */
  readonly maxAlongGap: number
  /** Angle slack, in degrees, for a segment that does not turn A. */
  readonly angleTolerance?: number
}

const BIN_WIDTH_FACTOR = 8

function along(stock: BarStock, point: ToolpathPoint): number {
  return stock.axis === 'x' ? point.x : point.y
}

/** `angle + 360k` closest to `reference`. */
function nearestTurn(angle: number, reference: number): number {
  return angle + 360 * Math.round((reference - angle) / 360)
}

export function compareRotaryDepth(
  baseline: readonly ToolpathMove[],
  candidate: readonly ToolpathMove[],
  stock: BarStock,
  options: RotaryDepthOptions,
): RotaryDepthComparison {
  const pivot = barPivotZ(stock)
  const alongTolerance = options.alongTolerance
  const angleTolerance = options.angleTolerance ?? 1e-6
  const segments: Segment[] = []
  for (const move of baseline) {
    if (move.kind === 'rapid') continue
    segments.push({
      along0: along(stock, move.from), along1: along(stock, move.to),
      a0: move.from.a ?? 0, a1: move.to.a ?? 0,
      tip0: move.from.z - pivot, tip1: move.to.z - pivot,
    })
  }
  // Bin the segments by along so each point only reads the ones that can reach it.
  const reach = Math.max(alongTolerance, options.maxAlongGap)
  const binWidth = Math.max(reach, alongTolerance * BIN_WIDTH_FACTOR, 1e-6)
  const bins = new Map<number, Segment[]>()
  for (const segment of segments) {
    const lo = Math.floor((Math.min(segment.along0, segment.along1) - reach) / binWidth)
    const hi = Math.floor((Math.max(segment.along0, segment.along1) + reach) / binWidth)
    for (let b = lo; b <= hi; b++) {
      const bin = bins.get(b)
      if (bin) bin.push(segment)
      else bins.set(b, [segment])
    }
  }

  /**
   * The deepest baseline tip through (along, angle), and failing that the
   * baseline interpolated across along between its adjacent crossings of the
   * angle on either side. `kind` says which one answered.
   */
  const floorAt = (pointAlong: number, angle: number): { floor: number; kind: 'exact' | 'bracket' | 'none' } => {
    let floor = Number.POSITIVE_INFINITY
    // The adjacent crossing of this angle on each side, within `maxAlongGap`: the
    // nearest along position, and at that position the deepest tip (a rough
    // crosses the same place once per layer). Only adjacent positions: bridging
    // to a deeper crossing further away would pass under a raised baseline
    // section between them and hide a cut into it.
    // Held in an object: TypeScript does not see the closure below assign them.
    const side: { below: Crossing | null; above: Crossing | null } = { below: null, above: null }
    const adjacent = (current: Crossing | null, crossAlong: number, tip: number): Crossing => {
      if (current === null) return { along: crossAlong, tip }
      const nearer = Math.abs(crossAlong - pointAlong) - Math.abs(current.along - pointAlong)
      if (nearer < -alongTolerance) return { along: crossAlong, tip }
      if (nearer <= alongTolerance && tip < current.tip) return { along: current.along, tip }
      return current
    }
    const crossing = (crossAlong: number, tip: number): void => {
      // A baseline move above the blank cuts nothing (a travel-height link), so
      // it says nothing about the material there (#1173).
      if (tip >= options.airRadius) return
      const gap = crossAlong - pointAlong
      if (Math.abs(gap) <= alongTolerance) {
        floor = Math.min(floor, tip)
      } else if (gap < 0 && -gap <= options.maxAlongGap) {
        side.below = adjacent(side.below, crossAlong, tip)
      } else if (gap > 0 && gap <= options.maxAlongGap) {
        side.above = adjacent(side.above, crossAlong, tip)
      }
    }
    for (const s of bins.get(Math.floor(pointAlong / binWidth)) ?? []) {
      const turn = s.a1 - s.a0
      if (Math.abs(turn) > angleTolerance) {
        // The segment turns A: parametrise by angle, every turn of the point's angle
        // that falls inside the segment's span.
        const lo = Math.min(s.a0, s.a1) - angleTolerance
        const hi = Math.max(s.a0, s.a1) + angleTolerance
        for (let k = Math.ceil((lo - angle) / 360); angle + 360 * k <= hi; k++) {
          const t = Math.min(1, Math.max(0, (angle + 360 * k - s.a0) / turn))
          crossing(s.along0 + t * (s.along1 - s.along0), s.tip0 + t * (s.tip1 - s.tip0))
        }
        continue
      }
      // A fixed angle: the point must be at it.
      if (Math.abs(nearestTurn(angle, s.a0) - s.a0) > angleTolerance) continue
      const run = s.along1 - s.along0
      if (Math.abs(run) > alongTolerance) {
        const t = (pointAlong - s.along0) / run
        if (t >= -alongTolerance / Math.abs(run) && t <= 1 + alongTolerance / Math.abs(run)) {
          const clamped = Math.min(1, Math.max(0, t))
          const tip = s.tip0 + clamped * (s.tip1 - s.tip0)
          if (tip < options.airRadius) floor = Math.min(floor, tip)
        } else {
          crossing(s.along0, s.tip0)
          crossing(s.along1, s.tip1)
        }
        continue
      }
      // A radial move: it passes through every radius between its ends.
      crossing(s.along0, Math.min(s.tip0, s.tip1))
    }
    if (Number.isFinite(floor)) return { floor, kind: 'exact' }
    const { below, above } = side
    if (below !== null && above !== null) {
      const t = (pointAlong - below.along) / (above.along - below.along)
      return { floor: below.tip + t * (above.tip - below.tip), kind: 'bracket' }
    }
    return { floor: Number.POSITIVE_INFINITY, kind: 'none' }
  }

  let points = 0
  let covered = 0
  let bracketed = 0
  let uncoveredInAir = 0
  let uncoveredInMaterial = 0
  let tooDeep = 0
  let deepest = Number.NEGATIVE_INFINITY
  let where = 'nowhere'
  let worstUncovered = ''
  for (const move of candidate) {
    for (const point of [move.from, move.to]) {
      points += 1
      const pointAlong = along(stock, point)
      const angle = point.a ?? 0
      const tip = point.z - pivot
      const { floor, kind } = floorAt(pointAlong, angle)
      if (kind === 'none') {
        if (tip >= options.airRadius - options.depthTolerance) {
          uncoveredInAir += 1
        } else {
          uncoveredInMaterial += 1
          if (worstUncovered === '') {
            worstUncovered = `uncovered ${move.kind} point at along ${pointAlong.toFixed(4)}, `
              + `A ${angle.toFixed(3)}, tip ${tip.toFixed(4)} (air radius ${options.airRadius.toFixed(4)})`
          }
        }
        continue
      }
      if (kind === 'exact') covered += 1
      else bracketed += 1
      const depth = floor - tip
      if (depth > deepest) {
        deepest = depth
        where = `along ${pointAlong.toFixed(4)}, A ${angle.toFixed(3)}, tip ${tip.toFixed(4)} `
          + `vs the baseline's ${floor.toFixed(4)}`
      }
      if (depth > options.depthTolerance) tooDeep += 1
    }
  }
  return {
    points, covered, bracketed, uncoveredInAir, uncoveredInMaterial, tooDeep,
    deepest: Number.isFinite(deepest) ? deepest : 0,
    where: worstUncovered !== '' ? `${where}; first ${worstUncovered}` : where,
  }
}
