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
 * Containment backstop for corner-unwind excursions (issue #499, slice S4) —
 * the predicate that will run in production (wired by slice S5): *does any
 * part of the cutter body leave already-cleared material?*
 *
 * Containment is not the engagement bound. The S3 generator bounds
 * *engagement* — the angular measure of the leading semicircle in uncut
 * material. This module answers the different and stronger question: for
 * every point of a candidate path, is the entire cutter disc (radius
 * `toolRadius`) inside the swept envelope of the moves already emitted at
 * that level? A path can satisfy an engagement bound and still put the
 * trailing flank into stock, so the check judges the **cutter body**, never
 * the tool centre alone.
 *
 * Pure module in the sense `engagement.ts` is pure: no `Project`/`Operation`
 * imports, no generator coupling, no I/O, fully deterministic.
 *
 * ## The check
 *
 * The candidate path is a polyline; each linear segment between consecutive
 * points is the swept body (a radius-r capsule) of one emitted move, so the
 * union of those capsules is exactly what the path cuts. The predicate
 * certifies each capsule against the prior swept set — the radius-r capsules
 * of `priorSegments`, the moves already emitted at this level — with a
 * covering argument:
 *
 * - Sample the capsule on a square grid of step `g` (a fraction of `r`, see
 *   `CONTAINMENT_GRID_STEP_FRACTION`), including a rim of one margin `m`
 *   beyond the capsule so the grid certifies the boundary too.
 * - Every grid point must lie at least `m` **inside** the envelope boundary:
 *   `distance(point, priorSegments) ≤ r − m`.
 *
 * Then every point Q of the capsule is covered, because the nearest grid
 * point P satisfies `|Q − P| ≤ g/√2` and the distance function is
 * 1-Lipschitz: `dist(Q) ≤ dist(P) + g/√2 ≤ r − m + g/√2 ≤ r`, the last step
 * by the invariant `g ≤ m·√2`. Acceptance is therefore **proven**, not
 * sampled: a grid pass means no point of the cutter body can leave the
 * envelope. The bias never runs in the permissive direction.
 *
 * The cost of a proof is the margin: a capsule whose every point is inside
 * but rides the envelope boundary closer than `m` is **rejected** (fail
 * closed). Rejection is signalled by a checked grid point at distance
 * `> r − m`; the reported point is the worst one found (maximum distance,
 * first in scan order on ties). Because the checked rim extends `m` beyond
 * the capsule, the witness alone does not always certify a gouge: a witness
 * with `penetration = dist − r ≤ m` can be a rim artifact of a capsule that
 * is itself fully inside — the caller's warning should say "within the
 * safety margin" — while `penetration > m` certifies a genuine crossing,
 * since the true maximum distance over the capsule is within `m` of the
 * reported distance and therefore exceeds `r`.
 *
 * ## Fail closed
 *
 * Every uncertainty resolves to not contained, never to contained:
 *
 * - an empty prior set is rejected (`'empty-prior-set'`) — no evidence of
 *   cleared material is not evidence of cleared material;
 * - degenerate input (empty path, non-finite coordinates, a non-positive
 *   tool radius) is rejected with a structured reason;
 * - a non-finite prior segment cannot be trusted to describe cleared
 *   material, so it is ignored — which shrinks the envelope and biases
 *   toward rejection.
 *
 * ## Measured constants
 *
 * The margin and the grid step are derived from the measured excursion
 * geometry of the slice-1 fixture pack (d = 6 mm, r = 3 mm, stepover 0.4),
 * measured with the independent disc sampler of the slice-4 test:
 *
 * - The deepest-inboard excursion disc sits `1.84 mm` inside the envelope
 *   boundary (penetration `−1.84 mm`), so a margin of `0.1·r = 0.3 mm`
 *   leaves ~6× headroom for a genuinely contained excursion.
 * - The same measurement found every generated excursion pokes **out** of
 *   the envelope at re-entry (max penetration `+0.65 … +2.40 mm` across the
 *   pack) — the containment failure the backstop exists to catch; see the
 *   test file and the slice-4 completion report for the finding.
 * - `0.1·r` is ~8 orders of magnitude above the floating-point dust
 *   (`~1e-9`) of the distance computations, so the margin is geometry, not
 *   noise.
 *
 * The grid step is the soundness bound `m·√2` rounded down to three
 * decimals: `0.1·√2 = 0.1414…` → `0.141`. The bracket test
 * (`excursionContainment.test.ts`) asserts both derivations so a retune
 * cannot silently break the covering argument.
 */

/**
 * Coverage margin as a fraction of the tool radius: every checked point
 * must sit at least `m·r` inside the cleared envelope's boundary.
 *
 * Derivation: measured on the slice-1 fixture pack (d = 6, r = 3, stepover
 * 0.4) with the test's independent disc sampler, the deepest-inboard disc of
 * any generated excursion sits 1.84 mm inside the envelope boundary; the
 * margin of 0.1·r = 0.3 mm leaves ~6× headroom there, while rejecting
 * boundary-riding tangent geometry (which the generated excursions do at
 * departure) and staying ~8 orders above floating-point dust. The test's
 * marginal-clearance case fails when this constant is halved
 * (mutation-checked during development); the bracket premise test constrains
 * any retune.
 */
export const CONTAINMENT_COVERAGE_MARGIN_FRACTION = 0.1

/**
 * Sampling-grid step as a fraction of the tool radius. The covering
 * argument above requires `g ≤ m·√2`; `0.1·√2 = 0.14142…` rounded down to
 * `0.141` leaves a 0.3% float guard. The bracket premise test asserts the
 * invariant; the interior-hole test fails when the step is coarsened past
 * the measured hole scale (mutation-checked during development).
 */
export const CONTAINMENT_GRID_STEP_FRACTION = 0.141

/** One point of the candidate excursion polyline, in project units. */
export interface ContainmentPoint {
  x: number
  y: number
}

/** One previously emitted cut move at this level, swept at the tool radius. */
export interface ContainmentSegment {
  ax: number
  ay: number
  bx: number
  by: number
}

/** Structured rejection reason, for the caller's warning path. */
export type ContainmentRejectionReason =
  | 'empty-prior-set'
  | 'empty-path'
  | 'invalid-tool-radius'
  | 'non-finite-coordinate'
  | 'coverage-violation'

/** Per-check cost counters; reported, never asserted. */
export interface ExcursionContainmentStats {
  /** Candidate polyline segments checked (path length − 1, ≥ 1 for a point path). */
  pathSegmentsChecked: number
  /** Grid points evaluated against the prior set. */
  gridPointsChecked: number
  /** Stored prior segments iterated by the grid queries. */
  priorSegmentsScanned: number
}

export interface ExcursionContainmentResult {
  status: 'contained' | 'rejected'
  rejectionReason: ContainmentRejectionReason | null
  /**
   * The worst grid point found when rejecting, `null` when contained or when
   * the rejection predates any geometry (empty prior, degenerate input).
   */
  violatingPoint: ContainmentPoint | null
  /**
   * Signed distance of the violating point past the envelope boundary,
   * `dist − r`. `> margin`: the witness certifies a genuine crossing — the
   * cutter body provably leaves the cleared union. `≤ margin`: the capsule
   * may still be fully inside and the witness a rim artifact of the
   * coverage margin — rejected fail-closed, reported honestly. When no
   * prior segment is anywhere near the witness (a starved prior set) the
   * value is `Infinity`: the point is unambiguously outside everything
   * swept.
   */
  penetration: number | null
  stats: ExcursionContainmentStats
}

/** One indexed prior segment. */
interface IndexedSegment {
  ax: number
  ay: number
  bx: number
  by: number
  dx: number
  dy: number
  lengthSq: number
}

/**
 * Spatial index over the prior swept segments. Cells are `2r` wide and every
 * segment is stored in each cell its own extent covers (centreline
 * supercover, the same construction as `SweptMaterialIndex`), so a query's
 * 3×3 cell block holds every segment within `r` of the query point — and a
 * segment outside the block is at least `2r` from the point, farther than
 * any distance that could flip the `r − m` decision.
 */
class PriorSegmentIndex {
  private readonly cells = new Map<string, IndexedSegment[]>()
  private readonly cellSize: number
  /** Inserted finite segments — the empty-prior evidence counter. */
  insertedCount = 0
  /** Stored segments iterated by queries — the scan-cost counter. */
  scannedCount = 0

  constructor(cellSize: number) {
    this.cellSize = cellSize
  }

  addSegment(ax: number, ay: number, bx: number, by: number): void {
    const dx = bx - ax
    const dy = by - ay
    const segment: IndexedSegment = { ax, ay, bx, by, dx, dy, lengthSq: dx * dx + dy * dy }
    this.insertedCount += 1
    for (const key of this.extentCellKeys(segment)) {
      const bucket = this.cells.get(key)
      if (bucket) {
        bucket.push(segment)
      } else {
        this.cells.set(key, [segment])
      }
    }
  }

  /** Supercover cells of one segment's extent, from its grid-line crossings. */
  private extentCellKeys(segment: IndexedSegment): string[] {
    const c = this.cellSize
    const { ax, ay, dx, dy } = segment
    const minX = Math.min(ax, segment.bx)
    const maxX = Math.max(ax, segment.bx)
    const minY = Math.min(ay, segment.by)
    const maxY = Math.max(ay, segment.by)
    const crossings: number[] = [0, 1]
    if (Math.abs(dx) > 1e-12) {
      for (let k = Math.floor(minX / c) + 1; k * c < maxX; k += 1) {
        const t = (k * c - ax) / dx
        if (t > 0 && t < 1) crossings.push(t)
      }
    }
    if (Math.abs(dy) > 1e-12) {
      for (let k = Math.floor(minY / c) + 1; k * c < maxY; k += 1) {
        const t = (k * c - ay) / dy
        if (t > 0 && t < 1) crossings.push(t)
      }
    }
    crossings.sort((p, q) => p - q)
    const keys = new Set<string>()
    for (let i = 0; i + 1 < crossings.length; i += 1) {
      const t = (crossings[i] + crossings[i + 1]) / 2
      const col = Math.floor((ax + dx * t) / c)
      const row = Math.floor((ay + dy * t) / c)
      keys.add(`${col},${row}`)
    }
    return Array.from(keys)
  }

  /** Minimum distance from (x, y) to the indexed segments, over the 3×3 block. */
  minDistance(x: number, y: number): number {
    const c = this.cellSize
    const col = Math.floor(x / c)
    const row = Math.floor(y / c)
    let best = Number.POSITIVE_INFINITY
    for (let dc = -1; dc <= 1; dc += 1) {
      for (let dr = -1; dr <= 1; dr += 1) {
        const bucket = this.cells.get(`${col + dc},${row + dr}`)
        if (!bucket) continue
        for (const segment of bucket) {
          this.scannedCount += 1
          const { ax, ay, dx, dy, lengthSq } = segment
          const t = lengthSq > 0
            ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSq))
            : 0
          const px = ax + dx * t - x
          const py = ay + dy * t - y
          const distance = Math.sqrt(px * px + py * py)
          if (distance < best) best = distance
        }
      }
    }
    return best
  }
}

/**
 * Decide whether the cutter body swept along `path` is provably contained in
 * the swept envelope of `options.priorSegments` — the moves already emitted
 * at this level. Fail closed: every uncertainty resolves to not contained.
 *
 * The polyline is judged as given: each linear segment between consecutive
 * points is one emitted move whose radius-r capsule must lie inside the
 * prior envelope. A path of a single point checks that point's disc.
 */
export function checkExcursionContainment(
  path: ReadonlyArray<ContainmentPoint>,
  options: { toolRadius: number; priorSegments: ReadonlyArray<ContainmentSegment> },
): ExcursionContainmentResult {
  const stats: ExcursionContainmentStats = {
    pathSegmentsChecked: 0,
    gridPointsChecked: 0,
    priorSegmentsScanned: 0,
  }
  const radius = options.toolRadius
  if (!Number.isFinite(radius) || radius <= 0) {
    return {
      status: 'rejected',
      rejectionReason: 'invalid-tool-radius',
      violatingPoint: null,
      penetration: null,
      stats,
    }
  }
  if (path.length === 0) {
    return {
      status: 'rejected',
      rejectionReason: 'empty-path',
      violatingPoint: null,
      penetration: null,
      stats,
    }
  }
  for (const point of path) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      return {
        status: 'rejected',
        rejectionReason: 'non-finite-coordinate',
        violatingPoint: null,
        penetration: null,
        stats,
      }
    }
  }

  const index = new PriorSegmentIndex(2 * radius)
  for (const segment of options.priorSegments) {
    if (
      !Number.isFinite(segment.ax)
      || !Number.isFinite(segment.ay)
      || !Number.isFinite(segment.bx)
      || !Number.isFinite(segment.by)
    ) {
      continue // cannot describe cleared material; ignoring it biases toward rejection
    }
    index.addSegment(segment.ax, segment.ay, segment.bx, segment.by)
  }
  if (index.insertedCount === 0) {
    return {
      status: 'rejected',
      rejectionReason: 'empty-prior-set',
      violatingPoint: null,
      penetration: null,
      stats,
    }
  }

  const margin = CONTAINMENT_COVERAGE_MARGIN_FRACTION * radius
  const step = CONTAINMENT_GRID_STEP_FRACTION * radius
  const acceptThreshold = radius - margin
  const rim = radius + margin

  let worst: ContainmentPoint | null = null
  let worstDistance = Number.NEGATIVE_INFINITY

  for (let i = 0; i + 1 < path.length; i += 1) {
    const a = path[i]
    const b = path[i + 1]
    stats.pathSegmentsChecked += 1
    scanCapsule(a.x, a.y, b.x, b.y)
  }
  if (path.length === 1) {
    stats.pathSegmentsChecked += 1
    scanCapsule(path[0].x, path[0].y, path[0].x, path[0].y)
  }

  function scanCapsule(ax: number, ay: number, bx: number, by: number): void {
    const minX = Math.min(ax, bx) - rim
    const maxX = Math.max(ax, bx) + rim
    const minY = Math.min(ay, by) - rim
    const maxY = Math.max(ay, by) + rim
    const dx = bx - ax
    const dy = by - ay
    const lengthSq = dx * dx + dy * dy
    for (let kx = Math.ceil(minX / step); kx <= Math.floor(maxX / step); kx += 1) {
      const x = kx * step
      for (let ky = Math.ceil(minY / step); ky <= Math.floor(maxY / step); ky += 1) {
        const y = ky * step
        const t = lengthSq > 0
          ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSq))
          : 0
        const px = ax + dx * t - x
        const py = ay + dy * t - y
        if (Math.sqrt(px * px + py * py) > rim) continue
        stats.gridPointsChecked += 1
        const distance = index.minDistance(x, y)
        if (distance > worstDistance) {
          worstDistance = distance
          worst = { x, y }
        }
      }
    }
  }

  if (worst !== null && worstDistance > acceptThreshold) {
    return {
      status: 'rejected',
      rejectionReason: 'coverage-violation',
      violatingPoint: worst,
      penetration: worstDistance - radius,
      stats: { ...stats, priorSegmentsScanned: index.scannedCount },
    }
  }
  return {
    status: 'contained',
    rejectionReason: null,
    violatingPoint: null,
    penetration: null,
    stats: { ...stats, priorSegmentsScanned: index.scannedCount },
  }
}
