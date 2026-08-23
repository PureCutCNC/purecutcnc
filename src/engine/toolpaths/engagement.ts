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
 * Cutter engagement estimation for pocket clearing — the measurement every
 * engagement-scaled feed decision is built on (issue #498). Pure module: no
 * project/operation types, no generator coupling, no I/O, fully deterministic.
 *
 * Definition: engagement is the angular measure, in `[0, π]`, of the cutter's
 * LEADING semicircle (the half centred on the motion direction) that lies in
 * material not yet swept at this level. A full slot is `π`; a cutter sitting
 * entirely in already-cut space is `0`. An index with no prior sweep nearby
 * reports `π` — virgin material is full engagement, never zero.
 *
 * Prior sweeps are modelled as capsules — one per swept straight segment —
 * each the union of three exact pieces: the radius-r disc at each endpoint
 * and the rectangular body between them. The covered angular interval of a
 * query circle is the union of those pieces' closed forms below, clipped to
 * the leading semicircle; the uncovered measure is the engagement. Because
 * every piece is exact, the estimate carries no systematic geometric bias:
 * conservative bias lives where uncertainty does — degenerate input,
 * zero-length sweeps, and anything an index cannot see all resolve toward
 * MORE engagement — and the feed map adds a deadband
 * (`ENGAGEMENT_ESTIMATE_EPSILON`) over the closed form's floating-point
 * dust.
 */

/**
 * Closed form for one endpoint disc. Query centre `C`, tool radius `r`, disc
 * centre `Q`: let `v = Q − C`, `D = |v|`, `φ = atan2(v.y, v.x)`. A cutter
 * circle point `P(θ) = C + r·u(θ)` lies inside the disc iff
 *
 *   |r·u − v|² ≤ r²  ⟺  u·v ≥ D² / (2r)  ⟺  cos(θ − φ) ≥ D / (2r)
 *
 * so the covered angular interval is the single arc `[φ − h, φ + h]` with
 * `h = arccos(D / (2r))`, non-empty only when `D ≤ 2r`. When `D = 0` the
 * cutter circle lies entirely inside the disc (covered measure `2π`);
 * `atan2` is undefined there, so that case is special-cased.
 */

/**
 * Closed form for the rectangular body. With `e` the unit vector along
 * `A→B`, `n` its perpendicular, `w = C − A`, `L = |B − A|`, and `α` the
 * angle of a circumference point measured **from `e`**, a point
 * `P(α) = C + r·u(α)` lies in the rectangle iff both hold:
 *
 *   along:  e·w + r·cos α ∈ [0, L]  →  cos α ∈ [(−e·w)/r, (L − e·w)/r]
 *   perp:   |n·w + r·sin α| ≤ r     →  sin α ∈ [(−r − n·w)/r, (r − n·w)/r]
 *
 * Each bound is an interval constraint on `cos α` or `sin α`, so each yields
 * a union of at most two arcs on `[0, 2π)`; the covered set is the
 * intersection of the two, then unioned with the endpoint discs. Every
 * acos/asin argument is clamped into `[−1, 1]` first.
 *
 * Validation identity: for a straight pass parallel to a prior pass at
 * radial depth `a_e`, the covered arcs reproduce the analytic wrap angle:
 * engagement = `arccos(1 − a_e/r)` (0 at `a_e = 0`, `π/2` at `a_e = r`,
 * `π` at `a_e = 2r`).
 */

/** Segments shorter than this sweep no measurable material and are not indexed. */
const ZERO_LENGTH_EPS = 1e-9

/** Query directions shorter than this cannot define a leading semicircle. */
const DEGENERATE_DIRECTION_EPS = 1e-12

/**
 * The feed-scale ladder, as cumulative fractions of the total drop
 * `(1 − slotScale)` measured DOWN from full feed: rung k is
 * `1 − FEED_RUNG_DROP_FRACTIONS[k] · (1 − slotScale)`, so the first entry (0)
 * is always full feed and the last (1) is always the slot scale.
 *
 * Non-uniform on purpose (issue #591): quantization error concentrates at the
 * top of the range, where curved constant-engagement laps sit — a lap a few
 * percent over nominal used to fall a whole 20%-of-drop rung (a 3.6% heavier
 * cut billed as an 8% feed reduction). The top three gaps price that zone at
 * 5% / 5% / 10% of the drop; everything below repeats the uniform ladder's
 * 20%-of-drop rungs verbatim, so corner and slot pricing is identical to the
 * pre-#591 engine at every slot percent.
 *
 * Small on purpose: arc fitting refuses to join two moves whose `feedScale`
 * differs at all (`sameRun`, `src/engine/gcode/arcFitting.ts`), so a
 * continuously varying scale would shatter every arc run into linear moves,
 * and extra resolution anywhere except the top adds fragment boundaries
 * without changing any price that mattered.
 */
const FEED_RUNG_DROP_FRACTIONS = [0, 0.05, 0.1, 0.2, 0.4, 0.6, 0.8, 1]

/**
 * Number of feed-scale rungs emitted by `engagementFeedScale` — the length
 * of the ladder above (8 since issue #591).
 */
export const ENGAGEMENT_FEED_BUCKET_COUNT = FEED_RUNG_DROP_FRACTIONS.length

/**
 * The emitted rung set for a slot scale, descending from full feed (index 0)
 * to `slotScale` (last index). Single source of truth: the theme colour ramp
 * and the structural tests consume this instead of re-deriving the arithmetic,
 * so what they render and assert can never desync from what the engine emits.
 *
 * The table is memoized for the most recent slot scale: this sits on hot paths
 * (`engagementFeedScale` per sample, `feedColourStep` per rendered cut move)
 * and the slot scale changes at most once per operation, so callers share one
 * array instead of allocating per call. Treat the result as immutable.
 */
let rungsCacheSlotScale = Number.NaN
let rungsCache: readonly number[] = []
export function engagementFeedRungs(slotScale: number): readonly number[] {
  if (!(slotScale === rungsCacheSlotScale) || rungsCache.length === 0) {
    const clamped = Math.min(1, Math.max(0, slotScale))
    const drop = 1 - clamped
    rungsCache = FEED_RUNG_DROP_FRACTIONS.map((fraction) => clamped + drop * (1 - fraction))
    rungsCacheSlotScale = slotScale
  }
  return rungsCache
}

/** Index of `scale` among an emitted rung set (to rounding dust), or −1. */
function rungIndexOfIn(rungs: readonly number[], scale: number): number {
  return rungs.findIndex((rung) => Math.abs(rung - scale) <= 1e-12)
}

/** Index of `scale` among the emitted rungs for a slot scale, or −1. */
function rungIndexOf(scale: number, slotScale: number): number {
  return rungIndexOfIn(engagementFeedRungs(slotScale), scale)
}

/**
 * Whether two emitted feed scales sit at most one rung apart on the ladder —
 * the merge-admissibility rule shared by `EngagementFeedQuantizer.fragments`
 * and the pocket's per-level run merge (issue #498 slice S9). On the
 * non-uniform ladder adjacent gaps differ, so "one rung apart" is judged by
 * rung index, not by any single width.
 */
function withinOneRungIndices(a: number, b: number, slotScale: number): boolean {
  const ia = rungIndexOf(a, slotScale)
  const ib = rungIndexOf(b, slotScale)
  return ia >= 0 && ib >= 0 && Math.abs(ia - ib) <= 1
}

/**
 * Worst-case over-report of the engagement estimate, in radians — the
 * deadband `engagementFeedScale` treats as "at nominal". Derived from the
 * evaluation geometry of the closed forms above, not guessed: every interval
 * bound is an acos/asin argument assembled from coordinate differences, and
 * near `±1` those functions amplify an argument error `δ` into an angle
 * error `√(2δ)` (acos(1 − δ) ≈ √(2δ)). A bound argument passes through at
 * most ~8 rounded operations, each contributing ≤ 1 ulp = 2⁻⁵², and that
 * count is doubled for margin, so `δ ≤ 16·2⁻⁵²` and the worst-case angle
 * error is `√(2·16·2⁻⁵²)` ≈ 8.4e-8 rad. A real straight ring run measured
 * 4.16e-8 rad above nominal — dust of exactly this kind — and this deadband
 * covers it with ~2× margin.
 */
export const ENGAGEMENT_ESTIMATE_EPSILON = Math.sqrt(2 * 16 * Number.EPSILON)

/** One swept straight segment, stored as a capsule of the tool radius. */
interface PriorSweep {
  ax: number
  ay: number
  bx: number
  by: number
  dx: number
  dy: number
  length: number
  lengthSq: number
  /** Query marker for per-query de-duplication. */
  queryMark: number
}

/**
 * Reusable fixed-size arc sets for clipping a rectangle against a leading
 * semicircle. The rectangle has only four angular constraints; 16 arcs is
 * deliberately well above the proven eight-arc result, while avoiding an
 * allocation cascade for every capsule query.
 */
class AngularIntervalScratch {
  private active = new Float64Array(32)
  private next = new Float64Array(32)
  private readonly constraint = new Float64Array(4)
  private count = 0

  reset(lo: number, hi: number): void {
    this.count = this.writeNormalizedRange(this.active, lo, hi)
  }

  clip(lo: number, hi: number): void {
    const constraintCount = this.writeNormalizedRange(this.constraint, lo, hi)
    let nextCount = 0
    for (let activeIndex = 0; activeIndex < this.count; activeIndex += 2) {
      for (let constraintIndex = 0; constraintIndex < constraintCount; constraintIndex += 2) {
        const from = Math.max(this.active[activeIndex], this.constraint[constraintIndex])
        const to = Math.min(this.active[activeIndex + 1], this.constraint[constraintIndex + 1])
        if (from < to) {
          if (nextCount + 2 > this.next.length) {
            throw new RangeError('AngularIntervalScratch exceeded its proven arc capacity')
          }
          this.next[nextCount] = from
          this.next[nextCount + 1] = to
          nextCount += 2
        }
      }
    }
    const previous = this.active
    this.active = this.next
    this.next = previous
    this.count = nextCount
  }

  appendTo(psi: number, phiE: number, intervals: LeadingIntervalUnion): boolean {
    for (let index = 0; index < this.count; index += 2) {
      if (pushLeadingClip(phiE + this.active[index], phiE + this.active[index + 1], psi, intervals)) return true
    }
    return false
  }

  private writeNormalizedRange(target: Float64Array, from: number, to: number): number {
    const twoPi = 2 * Math.PI
    if (to - from >= twoPi) {
      target[0] = 0
      target[1] = twoPi
      return 2
    }
    let lo = from
    while (lo < 0) lo += twoPi
    while (lo >= twoPi) lo -= twoPi
    const hi = lo + (to - from)
    if (hi <= twoPi) {
      target[0] = lo
      target[1] = hi
      return 2
    }
    target[0] = lo
    target[1] = twoPi
    target[2] = 0
    target[3] = hi - twoPi
    return 4
  }
}

/** Sorted union of arcs clipped into the leading semicircle. */
class LeadingIntervalUnion {
  private readonly intervals: Array<[number, number]> = []

  clear(): void {
    this.intervals.length = 0
  }

  /** Add an interval and report whether it now covers the whole semicircle. */
  add(lo: number, hi: number): boolean {
    let index = 0
    while (index < this.intervals.length && this.intervals[index][1] < lo) index += 1
    if (index === this.intervals.length || this.intervals[index][0] > hi) {
      this.intervals.splice(index, 0, [lo, hi])
    } else {
      const current = this.intervals[index]
      current[0] = Math.min(current[0], lo)
      current[1] = Math.max(current[1], hi)
      while (index + 1 < this.intervals.length && this.intervals[index + 1][0] <= current[1]) {
        const next = this.intervals[index + 1]
        current[1] = Math.max(current[1], next[1])
        this.intervals.splice(index + 1, 1)
      }
    }
    return this.intervals.length === 1
      && this.intervals[0][0] <= -Math.PI / 2
      && this.intervals[0][1] >= Math.PI / 2
  }

  /** Engagement after unioning the covered leading arcs. */
  engagement(): number {
    let covered = 0
    for (const [lo, hi] of this.intervals) covered += hi - lo
    return Math.min(Math.PI, Math.max(0, Math.PI - covered))
  }
}

/**
 * Clip a covered arc `[arcLo, arcHi]` (absolute angles, width ≤ 2π) to the
 * leading semicircle `[−π/2, π/2]` in ψ-relative coordinates and append the
 * pieces to `intervals`. The arc may wrap past π; the two-branch clip is
 * exhaustive for widths up to 2π.
 */
function pushLeadingClip(
  arcLo: number,
  arcHi: number,
  psi: number,
  intervals: LeadingIntervalUnion,
): boolean {
  let s = arcLo - psi
  while (s < -Math.PI) s += 2 * Math.PI
  while (s >= Math.PI) s -= 2 * Math.PI
  const hi = s + (arcHi - arcLo)
  const firstLo = Math.max(s, -Math.PI / 2)
  const firstHi = Math.min(hi, Math.PI / 2)
  if (firstLo < firstHi && intervals.add(firstLo, firstHi)) return true
  if (hi > (3 * Math.PI) / 2) {
    const wrapHi = hi - 2 * Math.PI
    if (wrapHi > -Math.PI / 2 && intervals.add(-Math.PI / 2, wrapHi)) return true
  }
  return false
}

/**
 * Spatial index over previously swept capsules. Each swept segment is stored
 * once per grid cell its own extent covers — the centreline supercover — not
 * per cell of a 2r-padded bbox. A query scans only the 3×3 cell block around
 * its own cell, which is exact: a sweep
 * point within `2r` of the query lies at most one cell away (cell size
 * `2r`), and its cell holds the sweep because the sweep is indexed by its
 * own extent. A capsule spanning many cells is still found because it is
 * indexed in each of them. Insertion cost is O(cells the extent covers),
 * which removes the 9×-per-disc cost of the former disc chain.
 */
export class SweptMaterialIndex {
  private readonly cells = new Map<string, PriorSweep[]>()
  private readonly radius: number
  private readonly cellSize: number
  private scannedCount = 0
  private trigTestedCount = 0
  private queryMark = 0
  private readonly leadingIntervals = new LeadingIntervalUnion()
  private readonly angularScratch = new AngularIntervalScratch()

  constructor(toolRadius: number) {
    if (!Number.isFinite(toolRadius) || toolRadius <= 0) {
      throw new RangeError(`SweptMaterialIndex: toolRadius must be a positive finite number, got ${toolRadius}`)
    }
    this.radius = toolRadius
    this.cellSize = 2 * toolRadius
  }

  /**
   * Record a swept straight segment `A → B` (a prior cut move at this level)
   * as one capsule, indexed by the cells its extent covers. Zero-length
   * segments are skipped — an unindexed sweep resolves toward more
   * engagement, which is the conservative direction.
   */
  addSweptSegment(ax: number, ay: number, bx: number, by: number): void {
    const dx = bx - ax
    const dy = by - ay
    const length = Math.hypot(dx, dy)
    if (length <= ZERO_LENGTH_EPS) return
    const sweep: PriorSweep = { ax, ay, bx, by, dx, dy, length, lengthSq: dx * dx + dy * dy, queryMark: -1 }
    for (const key of this.extentCellKeys(sweep)) {
      const bucket = this.cells.get(key)
      if (bucket) {
        bucket.push(sweep)
      } else {
        this.cells.set(key, [sweep])
      }
    }
  }

  /**
   * Centreline supercover cells of a swept segment. A query scans its own
   * 3×3 cell neighbourhood. With cells of side `2r`, every segment point
   * within `2r` of a query lies in that neighbourhood, so dilating every
   * stored segment into the same nine cells would only repeat candidates.
   */
  private extentCellKeys(sweep: PriorSweep): string[] {
    const c = this.cellSize
    const { dx, dy } = sweep
    const minX = Math.min(sweep.ax, sweep.bx)
    const maxX = Math.max(sweep.ax, sweep.bx)
    const minY = Math.min(sweep.ay, sweep.by)
    const maxY = Math.max(sweep.ay, sweep.by)
    // Grid-line crossing parameters: t where x(t) or y(t) equals k·c.
    const crossings: number[] = [0, 1]
    if (Math.abs(dx) > ZERO_LENGTH_EPS) {
      for (let k = Math.floor(minX / c) + 1; k * c < maxX; k += 1) {
        const t = (k * c - sweep.ax) / dx
        if (t > 0 && t < 1) crossings.push(t)
      }
    }
    if (Math.abs(dy) > ZERO_LENGTH_EPS) {
      for (let k = Math.floor(minY / c) + 1; k * c < maxY; k += 1) {
        const t = (k * c - sweep.ay) / dy
        if (t > 0 && t < 1) crossings.push(t)
      }
    }
    crossings.sort((p, q) => p - q)
    const keys = new Set<string>()
    for (let i = 0; i + 1 < crossings.length; i += 1) {
      const t = (crossings[i] + crossings[i + 1]) / 2
      const col = Math.floor((sweep.ax + dx * t) / c)
      const row = Math.floor((sweep.ay + dy * t) / c)
      keys.add(`${col},${row}`)
    }
    return Array.from(keys)
  }

  /** Number of stored cell entries — the index-size proxy for complexity checks. */
  storedEntryCount(): number {
    let total = 0
    for (const bucket of this.cells.values()) total += bucket.length
    return total
  }

  /**
   * Cumulative capsule-query counters since construction: how many stored
   * capsules a query's 3×3 cell scan iterated, and how many of those reached
   * the trigonometric path after the exact geometric rejections.
   * Cost assertions count these — never wall clocks (AGENTS.md § Build &
   * Verify).
   */
  queryStats(): { capsulesScanned: number; capsulesTrigTested: number } {
    return { capsulesScanned: this.scannedCount, capsulesTrigTested: this.trigTestedCount }
  }

  /**
   * Engagement in radians at cutter centre `(x, y)` moving in direction
   * `(dirX, dirY)` (need not be unit length): the measure of the leading
   * semicircle lying in material not yet swept, in `[0, π]`.
   *
   * The covered arcs of every capsule in the 3×3 cell block around the
   * query cell are unioned, then clipped to the leading semicircle;
   * engagement is the uncovered measure. Degenerate input (non-finite
   * coordinates, a zero-length direction, or no prior sweep in range)
   * resolves to `π` — full engagement — per the conservative-bias rule.
   */
  engagementAt(x: number, y: number, dirX: number, dirY: number): number {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(dirX) || !Number.isFinite(dirY)) {
      return Math.PI
    }
    const dirLength = Math.hypot(dirX, dirY)
    if (dirLength <= DEGENERATE_DIRECTION_EPS) return Math.PI
    const forwardX = dirX / dirLength
    const forwardY = dirY / dirLength
    const psi = Math.atan2(forwardY, forwardX)
    const col = Math.floor(x / this.cellSize)
    const row = Math.floor(y / this.cellSize)
    const intervals = this.leadingIntervals
    intervals.clear()
    // A long segment can cross more than one cell in this query's 3×3 scan.
    // Process its shared sweep record only once; repeated interval insertion
    // cannot change engagement but is disproportionately expensive for the
    // short tessellated moves common in real pockets (issue #517). A marker
    // on the shared record avoids allocating and hashing a Set per query.
    this.queryMark += 1
    const queryMark = this.queryMark
    let foundAny = false
    for (let dc = -1; dc <= 1; dc += 1) {
      for (let dr = -1; dr <= 1; dr += 1) {
        const bucket = this.cells.get(`${col + dc},${row + dr}`)
        if (!bucket) continue
        foundAny = true
        for (const sweep of bucket) {
          if (sweep.queryMark === queryMark) continue
          sweep.queryMark = queryMark
          this.scannedCount += 1
          if (this.appendCapsuleArcs(sweep, x, y, psi, forwardX, forwardY, intervals, this.angularScratch)) return 0
        }
      }
    }
    if (!foundAny) return Math.PI
    return intervals.engagement()
  }

  /**
   * Append the covered arcs of one swept capsule (both endpoint discs and
   * the rectangular body); return true when the whole leading semicircle is
   * covered (engagement 0).
   *
   * Cheap rejection first: the capsule meets the cutter circle exactly when
   * the query centre lies within `2r` of the segment, so a squared
   * point-to-segment distance — a handful of operations — gates all three
   * trigonometric blocks. Exact, not approximate: a capsule point within
   * `r` of the query exists iff the closest segment point is within `2r`.
   * This is what keeps a cell holding thousands of short segments from
   * paying the full closed-form cost per capsule.
   */
  private appendCapsuleArcs(
    sweep: PriorSweep,
    x: number,
    y: number,
    psi: number,
    forwardX: number,
    forwardY: number,
    intervals: LeadingIntervalUnion,
    angularScratch: AngularIntervalScratch,
  ): boolean {
    // Material whose centreline lies more than one tool radius behind the
    // cutter cannot reach its leading semicircle. This is an exact half-plane
    // rejection: every leading-circle point has forward projection at least
    // zero, while the capsule expands its centreline by only `r`.
    const forwardExtent = Math.max(
      (sweep.ax - x) * forwardX + (sweep.ay - y) * forwardY,
      (sweep.bx - x) * forwardX + (sweep.by - y) * forwardY,
    )
    if (forwardExtent < -this.radius) return false
    const { dx, dy, lengthSq } = sweep
    const t = lengthSq > 0
      ? Math.max(0, Math.min(1, ((x - sweep.ax) * dx + (y - sweep.ay) * dy) / lengthSq))
      : 0
    const px = sweep.ax + dx * t - x
    const py = sweep.ay + dy * t - y
    const twoR = 2 * this.radius
    if (px * px + py * py > twoR * twoR) return false
    if (!this.mayReachLeadingArc(sweep, x, y, forwardX, forwardY)) return false
    this.trigTestedCount += 1
    if (this.appendDiscArcs(sweep.ax, sweep.ay, x, y, psi, intervals)) return true
    if (this.appendDiscArcs(sweep.bx, sweep.by, x, y, psi, intervals)) return true
    const { length } = sweep
    const ex = dx / length
    const ey = dy / length
    const nx = -ey
    const ny = ex
    const wx = x - sweep.ax
    const wy = y - sweep.ay
    const along = ex * wx + ey * wy
    const perp = nx * wx + ny * wy
    const r = this.radius
    // The endpoint discs may meet the cutter circle when its centre is just
    // beyond this segment, while the rectangular capsule body cannot. Avoid
    // constructing angular interval sets unless the body rectangle expanded
    // by the cutter radius overlaps the query centre. Boundary contact has
    // zero angular measure, so excluding it leaves engagement exact.
    if (along <= -r || along >= length + r || perp <= -2 * r || perp >= 2 * r) return false
    const cLo = -along / r
    const cHi = (length - along) / r
    const sLo = -(r + perp) / r
    const sHi = (r - perp) / r
    if (cLo > cHi || sLo > sHi) return false // the rectangle covers no cutter-circle point
    const phiE = Math.atan2(ey, ex)
    const loC = Math.max(-1, Math.min(1, cLo))
    const hiC = Math.max(-1, Math.min(1, cHi))
    const loS = Math.max(-1, Math.min(1, sLo))
    const hiS = Math.max(-1, Math.min(1, sHi))
    angularScratch.reset(psi - phiE - Math.PI / 2, psi - phiE + Math.PI / 2)
    if (loC > -1) angularScratch.clip(-Math.acos(loC), Math.acos(loC))
    if (hiC < 1) {
      const bound = Math.acos(hiC)
      angularScratch.clip(bound, 2 * Math.PI - bound)
    }
    if (loS > -1) {
      const bound = Math.asin(loS)
      angularScratch.clip(bound, Math.PI - bound)
    }
    if (hiS < 1) {
      const bound = Math.asin(hiS)
      angularScratch.clip(Math.PI - bound, 2 * Math.PI + bound)
    }
    return angularScratch.appendTo(psi, phiE, intervals)
  }

  /**
   * Whether this centreline segment can reach any point of the leading
   * semicircle after its radius-r sweep. In forward/lateral coordinates, the
   * r-neighbourhood of that semicircle is exactly its front half-disc of
   * radius 2r plus the two radius-r discs at the half-circle endpoints.
   * Testing that shape avoids all angular work for capsules that only meet
   * the cutter's trailing half.
   */
  private mayReachLeadingArc(
    sweep: PriorSweep,
    x: number,
    y: number,
    forwardX: number,
    forwardY: number,
  ): boolean {
    const ax = sweep.ax - x
    const ay = sweep.ay - y
    const bx = sweep.bx - x
    const by = sweep.by - y
    const aForward = ax * forwardX + ay * forwardY
    const aLateral = -ax * forwardY + ay * forwardX
    const bForward = bx * forwardX + by * forwardY
    const bLateral = -bx * forwardY + by * forwardX
    const twoR = 2 * this.radius

    const aFront = aForward >= 0
    const bFront = bForward >= 0
    if (aFront || bFront) {
      const crossing = aFront === bFront ? 0 : -aForward / (bForward - aForward)
      const from = aFront ? 0 : crossing
      const to = bFront ? 1 : crossing
      if (this.rangeDistanceSq(aForward, aLateral, bForward, bLateral, 0, 0, from, to) <= twoR * twoR) {
        return true
      }
    }

    const aTrailing = aForward <= 0
    const bTrailing = bForward <= 0
    if (!aTrailing && !bTrailing) return false
    const crossing = aTrailing === bTrailing ? 0 : -aForward / (bForward - aForward)
    const from = aTrailing ? 0 : crossing
    const to = bTrailing ? 1 : crossing
    const radiusSq = this.radius * this.radius
    return (
      this.rangeDistanceSq(aForward, aLateral, bForward, bLateral, 0, this.radius, from, to) <= radiusSq
      || this.rangeDistanceSq(aForward, aLateral, bForward, bLateral, 0, -this.radius, from, to) <= radiusSq
    )
  }

  /** Squared distance from a point to the closed parameter sub-range of a segment. */
  private rangeDistanceSq(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    px: number,
    py: number,
    from: number,
    to: number,
  ): number {
    const dx = bx - ax
    const dy = by - ay
    const lengthSq = dx * dx + dy * dy
    const unclamped = lengthSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lengthSq : 0
    const t = Math.max(from, Math.min(to, unclamped))
    const offsetX = ax + dx * t - px
    const offsetY = ay + dy * t - py
    return offsetX * offsetX + offsetY * offsetY
  }

  /**
   * Append the covered arcs of one endpoint disc (closed form in the module
   * doc); return true when the query centre sits exactly on the disc centre
   * — the cutter circle lies inside the disc, so everything is covered.
   */
  private appendDiscArcs(
    px: number,
    py: number,
    x: number,
    y: number,
    psi: number,
    intervals: LeadingIntervalUnion,
  ): boolean {
    const vx = px - x
    const vy = py - y
    const dSq = vx * vx + vy * vy
    const twoR = 2 * this.radius
    if (dSq > twoR * twoR) return false
    if (vx === 0 && vy === 0) return true
    const d = Math.sqrt(dSq)
    const h = Math.acos(Math.min(1, Math.max(-1, d / twoR)))
    const arcLo = Math.atan2(vy, vx) - h
    return pushLeadingClip(arcLo, arcLo + 2 * h, psi, intervals)
  }
}

/**
 * Nominal engagement implied by a pocket's stepover: the analytic wrap angle
 * of a straight pass parallel to a prior pass at radial depth `stepover`,
 * `arccos(1 − stepover / toolRadius)`, clamped to `[0, π]`.
 */
export function nominalEngagement(stepover: number, toolRadius: number): number {
  if (!Number.isFinite(toolRadius) || toolRadius <= 0) {
    throw new RangeError(`nominalEngagement: toolRadius must be a positive finite number, got ${toolRadius}`)
  }
  return Math.min(Math.PI, Math.max(0, Math.acos(Math.min(1, Math.max(-1, 1 - stepover / toolRadius)))))
}

/** Unquantized feed scale: 1 at or below nominal, linear down to slotScale at π. */
function continuousFeedScale(engagement: number, nominal: number, slotScale: number): number {
  if (engagement <= nominal) return 1
  if (!(nominal < Math.PI)) return 1
  const t = (Math.min(engagement, Math.PI) - nominal) / (Math.PI - nominal)
  return 1 + (slotScale - 1) * t
}

/**
 * Map an engagement to a `feedScale`. At or below the nominal engagement
 * implied by the operation's stepover — plus `ENGAGEMENT_ESTIMATE_EPSILON`,
 * the deadband covering the estimator's worst-case over-report — the scale
 * is exactly `1`. Above that it interpolates linearly from 1 down to
 * `slotScale` (the feed at full-slot engagement) between nominal and `π`,
 * then quantizes onto the fixed non-uniform rung ladder
 * (`FEED_RUNG_DROP_FRACTIONS`, issue #591) whose top rung is 1.0 and whose
 * bottom rung is `slotScale`, rounding DOWN — toward the lower feed, so
 * quantization is itself conservative. The ladder is deliberately finer near
 * full feed, where curved constant-engagement laps carry entitlements a few
 * percent below 1, and coarser near slot, where corner pricing is already
 * well-scaled.
 *
 * The quantization is not a preference: arc fitting refuses to join moves
 * whose `feedScale` differs at all, so a continuous scale would shatter
 * every arc run into linear moves. Hysteresis between buckets and a minimum
 * fragment length are applied by `EngagementFeedQuantizer`.
 *
 * Degenerate inputs: engagement ≤ nominal + deadband (including NaN) → `1`;
 * `slotScale` is clamped to `[0, 1]` (≥ 1 → always 1); nominal ≥ π → always
 * 1.
 */
export function engagementFeedScale(engagement: number, nominal: number, slotScale: number): number {
  if (!(engagement > nominal + ENGAGEMENT_ESTIMATE_EPSILON)) return 1
  const clampedSlot = Math.min(1, Math.max(0, slotScale))
  if (clampedSlot >= 1) return 1
  if (!(nominal < Math.PI)) return 1
  const continuous = continuousFeedScale(engagement, nominal, clampedSlot)
  // Round DOWN onto the ladder: the first (highest-priced) entry in the
  // descending rung set that does not exceed the continuous scale. The 1e-12
  // slack keeps evaluation dust from dropping a whole rung — straight offset
  // rings hit rung boundaries analytically exactly, so a value one ulp under
  // a boundary must still charge the boundary's rung (the uniform ladder's
  // +1e-12 floor nudge, restated for the scanned table).
  const rungs = engagementFeedRungs(clampedSlot)
  for (let index = 0; index < rungs.length; index += 1) {
    if (rungs[index] <= continuous + 1e-12) return rungs[index]
  }
  return clampedSlot
}

export interface EngagementFeedFragment {
  /** Feed scale for this stretch of path. */
  scale: number
  /** Path length of this stretch, in project units. */
  distance: number
}

/**
 * Default up-switch margin as a fraction of the bucket width: the raw
 * (unquantized) scale must sit at least this far into the next bucket before
 * the quantizer leaves its current, lower bucket.
 */
const DEFAULT_HYSTERESIS_FRACTION = 0.25

/**
 * Floor on the up-switch margin, as a fraction of the whole drop
 * `(1 − slotScale)` at the default hysteresis fraction; the configured
 * fraction scales it proportionally, so `hysteresis: 0` means no margin at
 * all. On the pre-#591 uniform ladder every rung's proportional margin worked
 * out to exactly this share of the drop, so the floor preserves the
 * anti-chatter band widths that shipped against rings whose engagement barely
 * wanders. It is a target, not the realised value: the rise margin is capped
 * at half the gap to the rung above, and on the non-uniform ladder (#591)
 * that cap is what binds on the two finest top rungs. Without the cap they
 * would be drop-only — a pocket that touched one corner would run its
 * following straight stretch at slot feed forever.
 */
const MIN_HYSTERESIS_DROP_FRACTION = 0.05

/**
 * Tolerance for minimum-fragment comparisons. A ring's scaled minimum is
 * `perimeter / 8`, which a fragment distance summed from chunk lengths can
 * undershoot by one ulp; the tolerance is far below any meaningful precision
 * and only keeps an exact-boundary fragment from being merged away.
 */
const MIN_FRAGMENT_EPSILON = 1e-9

/**
 * Stateful feed quantization for one operation: consumes a sequence of
 * (engagement, distance) samples along a path and emits stretches of constant
 * `feedScale` with two controller-friendliness guarantees —
 *
 * - Hysteresis: drops to a lower bucket are immediate (a feed reduction is
 *   never delayed), rises to a higher bucket require the raw scale to sit
 *   past a hysteresis margin inside the target bucket, so a bucket boundary
 *   crossed repeatedly does not alternate. The margin is a quarter of the
 *   target rung's own width, floored at `MIN_HYSTERESIS_DROP_FRACTION` of the
 *   whole drop and capped at half the gap to the rung above: the floor keeps
 *   an anti-chatter band as wide as the uniform ladder's ever was, and the
 *   cap keeps every rung climbable — without it the fine top rungs (#591)
 *   could be dropped onto but never risen back out of. The configured
 *   `hysteresis` fraction scales the whole margin; `hysteresis: 0` means no
 *   margin at all. The top rung (scale 1) itself is special:
 *   `ENGAGEMENT_ESTIMATE_EPSILON` inside `engagementFeedScale` is its
 *   margin — engagement within the estimator's worst-case error of nominal
 *   counts as exactly 1 and rises to full feed with no further margin.
 * - Minimum fragment length: no emitted stretch is shorter than its own
 *   minimum fragment length — the tightest `minFragmentLength` carried by any
 *   of its chunks, overridable per ring via `setMinFragmentLength`; a shorter
 *   stretch is merged into its lower-scale neighbour, so the merge itself also
 *   resolves toward the lower feed.
 *
 * Both guarantees are conservative: while in doubt the quantizer holds the
 * lower feed.
 */
/**
 * One quantized stretch, tracking the minimum fragment length in force while
 * it was accumulated. The emitted `EngagementFeedFragment` keeps only the
 * scale and distance; the per-stretch minimum length is internal, so the
 * merge in `fragments` can judge a stretch against the tightest minimum that
 * applied to any of its chunks rather than one global constant.
 */
interface QuantizedFragment {
  scale: number
  distance: number
  minFragmentLength: number
}

export class EngagementFeedQuantizer {
  private readonly nominal: number
  private readonly slotScale: number
  private readonly hysteresisFraction: number
  /** This operation's ladder, captured once — every rung lookup uses it. */
  private readonly rungs: readonly number[]
  private readonly emitted: QuantizedFragment[] = []
  private currentScale: number | null = null
  private heldDistance = 0
  private minFragmentLength: number
  private heldMinFragmentLength: number

  constructor(options: {
    nominal: number
    slotScale: number
    minFragmentLength: number
    hysteresis?: number
  }) {
    this.nominal = options.nominal
    this.slotScale = Math.min(1, Math.max(0, options.slotScale))
    this.rungs = engagementFeedRungs(this.slotScale)
    this.minFragmentLength = Math.max(0, options.minFragmentLength)
    this.heldMinFragmentLength = this.minFragmentLength
    this.hysteresisFraction = options.hysteresis ?? DEFAULT_HYSTERESIS_FRACTION
  }

  /**
   * Whether two emitted scales sit at most one rung apart on this operation's
   * ladder — the pocket's per-level run merge applies the same rule
   * `fragments` applies to its own stretches.
   */
  scalesWithinOneRung(a: number, b: number): boolean {
    return withinOneRungIndices(a, b, this.slotScale)
  }

  /**
   * Width of the continuous-scale bucket a rung owns: the gap down to the
   * next lower rung; the bottom rung reuses the final gap so its width is
   * never zero. Throws on a scale that is not an emitted rung — margins are
   * only ever taken for scales `engagementFeedScale` produced, so that is a
   * programming error, not a degenerate input.
   */
  private rungWidth(scale: number): number {
    const index = rungIndexOfIn(this.rungs, scale)
    if (index < 0 || index >= this.rungs.length) {
      throw new RangeError(`EngagementFeedQuantizer: ${scale} is not an emitted feed-scale rung`)
    }
    return index === this.rungs.length - 1 ? this.rungs[index - 1] - this.rungs[index] : this.rungs[index] - this.rungs[index + 1]
  }

  /**
   * Gap from a rung up to the next higher rung — the room a rise into this
   * rung has before the entitlement itself moves up a rung. The top reduced
   * rung's gap reaches to full feed. Throws on anything but a reduced rung:
   * the call site short-circuits scale ≥ 1 before asking.
   */
  private gapAbove(scale: number): number {
    const index = rungIndexOfIn(this.rungs, scale)
    if (index <= 0 || index >= this.rungs.length) {
      throw new RangeError(`EngagementFeedQuantizer: ${scale} is not a reduced emitted rung`)
    }
    return this.rungs[index - 1] - this.rungs[index]
  }

  /**
   * Override the minimum fragment length for subsequent chunks. The pocket
   * scales a ring's minimum down to its perimeter so a short ring can hold its
   * own fragment; a stretch accumulates the tightest minimum any of its chunks
   * carried, and both the rise gate and the `fragments` merge judge the
   * stretch against that.
   */
  setMinFragmentLength(length: number): void {
    this.minFragmentLength = Math.max(0, length)
  }

  /** Feed the next sample: `distance` path units travelled at `engagement` radians. */
  push(engagement: number, distance: number): void {
    const clamped = Math.min(Math.PI, Math.max(0, engagement))
    const safeDistance = Math.max(0, distance)
    const rawScale = engagementFeedScale(clamped, this.nominal, this.slotScale)
    if (this.currentScale === null) {
      this.currentScale = rawScale
      this.heldDistance = safeDistance
      this.heldMinFragmentLength = this.minFragmentLength
      return
    }
    if (rawScale === this.currentScale) {
      this.heldDistance += safeDistance
      this.heldMinFragmentLength = Math.min(this.heldMinFragmentLength, this.minFragmentLength)
      return
    }
    if (rawScale < this.currentScale) {
      // Engagement rose: drop the feed immediately (conservative).
      this.emitted.push({ scale: this.currentScale, distance: this.heldDistance, minFragmentLength: this.heldMinFragmentLength })
      this.currentScale = rawScale
      this.heldDistance = safeDistance
      this.heldMinFragmentLength = this.minFragmentLength
      return
    }
    // Engagement fell: rise only past the hysteresis margin inside the target
    // bucket and only after the current stretch has reached its own minimum
    // fragment length (the tightest of its chunks). The top rung (scale 1)
    // uses the deadband as its margin; a NaN sample never rises (NaN
    // comparisons are false). Otherwise hold the current (lower) feed.
    const continuous = continuousFeedScale(clamped, this.nominal, this.slotScale)
    const effective = clamped <= this.nominal + ENGAGEMENT_ESTIMATE_EPSILON ? 1 : continuous
    // A quarter of the target rung's own width, floored at the share of the
    // drop the uniform ladder gave every rung (#591), and capped at half the
    // gap to the rung above so every rung stays climbable — without the cap,
    // a pocket that touched one corner would run its following straight
    // stretch at slot feed forever. The cap binds on the fine top rungs;
    // elsewhere the floor and proportional terms dominate.
    const margin = rawScale >= 1
      ? 0
      : Math.min(
          this.gapAbove(rawScale) / 2,
          Math.max(
            this.hysteresisFraction * this.rungWidth(rawScale),
            MIN_HYSTERESIS_DROP_FRACTION * (this.hysteresisFraction / DEFAULT_HYSTERESIS_FRACTION) * (1 - this.slotScale),
          ),
        )
    const fragmentGate = rawScale >= 1 || this.heldDistance >= this.heldMinFragmentLength - MIN_FRAGMENT_EPSILON
    if (effective >= rawScale + margin && fragmentGate) {
      this.emitted.push({ scale: this.currentScale, distance: this.heldDistance, minFragmentLength: this.heldMinFragmentLength })
      this.currentScale = rawScale
      this.heldDistance = safeDistance
      this.heldMinFragmentLength = this.minFragmentLength
    } else {
      this.heldDistance += safeDistance
      this.heldMinFragmentLength = Math.min(this.heldMinFragmentLength, this.minFragmentLength)
    }
  }

  /** Emitted stretches, with every stretch shorter than its own minimum fragment length merged away. */
  fragments(): EngagementFeedFragment[] {
    const result: QuantizedFragment[] = this.emitted.slice()
    if (this.currentScale !== null) {
      result.push({ scale: this.currentScale, distance: this.heldDistance, minFragmentLength: this.heldMinFragmentLength })
    }
    for (let i = 0; i < result.length; ) {
      const fragment = result[i]
      if (result.length === 1 || fragment.distance >= fragment.minFragmentLength - MIN_FRAGMENT_EPSILON) {
        i += 1
        continue
      }
      const next = result[i + 1]
      const prev = result[i - 1]
      const targetIndex = next && (!prev || next.scale <= prev.scale) ? i + 1 : i - 1
      const target = result[targetIndex]
      // A minimum-fragment merge must not bridge the full-feed ceiling in
      // either direction. Extending a reduced stretch into a full-feed
      // neighbour holds the slot feed into material measured at or below
      // nominal, and absorbing a short full-feed stretch into a reduced one
      // does the same from the other side. A short stretch next to full feed
      // is a genuine short slot or a genuine short cleared gap (a neck
      // crossing): it keeps its own scale at its own length. Only
      // bucket-to-bucket merges (both reduced) are still consolidated.
      if (fragment.scale >= 1 || target.scale >= 1) {
        i += 1
        continue
      }
      // A bucket-to-bucket merge takes the lower scale, so a merge that would
      // lower the higher-scale stretch by more than one rung is refused: a
      // fragment entitled to a near-full scale must not be dragged to the slot
      // floor by a slot it merely touches (issue #498, slice S9). Adjacent
      // rungs still consolidate, so the minimum-fragment guarantee does not
      // shatter the path into alternations. On the non-uniform ladder (#591)
      // "one rung apart" is pair-specific — adjacency is judged by rung index.
      if (!withinOneRungIndices(fragment.scale, target.scale, this.slotScale)) {
        i += 1
        continue
      }
      result.splice(Math.min(i, targetIndex), 2, {
        scale: Math.min(fragment.scale, target.scale),
        distance: fragment.distance + target.distance,
        minFragmentLength: Math.min(fragment.minFragmentLength, target.minFragmentLength),
      })
      if (targetIndex < i) i = targetIndex
    }
    return result.map(({ scale, distance }) => ({ scale, distance }))
  }
}

/** Per-operation engagement measurement, distance-weighted (issue #498 telemetry). */
export interface EngagementTelemetry {
  /** Highest engagement observed, radians. */
  maxEngagement: number
  /** Distance-weighted 95th percentile of engagement, radians. */
  p95Engagement: number
  /** Path distance cut at engagement above the operation's nominal, project units. */
  distanceAboveNominal: number
  /** Total sampled cut distance, project units. */
  totalCutDistance: number
}

/**
 * Accumulates distance-weighted engagement samples and folds them into
 * `EngagementTelemetry`. An accumulator that never saw a sample reports
 * `maxEngagement`/`p95Engagement` = `π` — no evidence resolves toward full
 * engagement, never toward a restored feed.
 */
export class EngagementTelemetryAccumulator {
  private readonly nominal: number
  private readonly samples: Array<{ engagement: number; distance: number }> = []

  constructor(nominal: number) {
    this.nominal = nominal
  }

  /** Record `distance` path units cut at `engagement` radians. */
  addSample(engagement: number, distance: number): void {
    this.samples.push({
      engagement: Math.min(Math.PI, Math.max(0, engagement)),
      distance: Math.max(0, distance),
    })
  }

  toTelemetry(): EngagementTelemetry {
    if (this.samples.length === 0) {
      return { maxEngagement: Math.PI, p95Engagement: Math.PI, distanceAboveNominal: 0, totalCutDistance: 0 }
    }
    let maxEngagement = 0
    let distanceAboveNominal = 0
    let totalCutDistance = 0
    for (const sample of this.samples) {
      if (sample.engagement > maxEngagement) maxEngagement = sample.engagement
      if (sample.engagement > this.nominal) distanceAboveNominal += sample.distance
      totalCutDistance += sample.distance
    }
    if (totalCutDistance <= 0) {
      return { maxEngagement, p95Engagement: maxEngagement, distanceAboveNominal: 0, totalCutDistance: 0 }
    }
    const sorted = this.samples.slice().sort((a, b) => a.engagement - b.engagement)
    const target = 0.95 * totalCutDistance
    let cumulative = 0
    let p95Engagement = sorted[sorted.length - 1].engagement
    for (const sample of sorted) {
      cumulative += sample.distance
      if (cumulative >= target) {
        p95Engagement = sample.engagement
        break
      }
    }
    return { maxEngagement, p95Engagement, distanceAboveNominal, totalCutDistance }
  }
}
