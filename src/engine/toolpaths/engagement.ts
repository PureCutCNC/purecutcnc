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
 * Number of feed-scale buckets emitted by `engagementFeedScale`; the ladder's
 * top rung is 1.0 (full feed) and its bottom rung is the slot scale. Small on
 * purpose: arc fitting refuses to join two moves whose `feedScale` differs at
 * all (`sameRun`, `src/engine/gcode/arcFitting.ts`), so a continuously varying
 * scale would shatter every arc run into linear moves.
 */
export const ENGAGEMENT_FEED_BUCKET_COUNT = 6

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
}

/**
 * Interval `[u, v]` with `u ≤ v ≤ u + 2π`, normalized into arcs inside
 * `[0, 2π)`: one arc when it fits, two when it wraps past `2π`.
 */
function arcsInRange(u: number, v: number): Array<[number, number]> {
  const width = v - u
  if (width >= 2 * Math.PI) return [[0, 2 * Math.PI]]
  let lo = u
  while (lo < 0) lo += 2 * Math.PI
  while (lo >= 2 * Math.PI) lo -= 2 * Math.PI
  const hi = lo + width
  if (hi <= 2 * Math.PI) return [[lo, hi]]
  return [
    [lo, 2 * Math.PI],
    [0, hi - 2 * Math.PI],
  ]
}

/** Intersection of two arc sets: pairwise interval overlap, dropping empties. */
function intersectArcSets(
  a: Array<[number, number]>,
  b: Array<[number, number]>,
): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const [aLo, aHi] of a) {
    for (const [bLo, bHi] of b) {
      const lo = Math.max(aLo, bLo)
      const hi = Math.min(aHi, bHi)
      if (lo < hi) out.push([lo, hi])
    }
  }
  return out
}

/**
 * The angular set `{α : cos α ∈ [cLo, cHi] and sin α ∈ [sLo, sHi]}` on
 * `[0, 2π)`, as arcs. The caller checks the raw intervals are non-empty;
 * every acos/asin argument is clamped into `[−1, 1]`. Each constraint
 * contributes at most two arcs, the intersection at most eight.
 */
function rectangleBodyArcs(
  cLo: number,
  cHi: number,
  sLo: number,
  sHi: number,
): Array<[number, number]> {
  const loC = Math.max(-1, Math.min(1, cLo))
  const hiC = Math.max(-1, Math.min(1, cHi))
  const loS = Math.max(-1, Math.min(1, sLo))
  const hiS = Math.max(-1, Math.min(1, sHi))
  let cosSet: Array<[number, number]> = [[0, 2 * Math.PI]]
  if (loC > -1) {
    const a = Math.acos(loC)
    cosSet = intersectArcSets(cosSet, arcsInRange(-a, a))
  }
  if (hiC < 1) {
    const b = Math.acos(hiC)
    cosSet = intersectArcSets(cosSet, arcsInRange(b, 2 * Math.PI - b))
  }
  let sinSet: Array<[number, number]> = [[0, 2 * Math.PI]]
  if (loS > -1) {
    const a = Math.asin(loS)
    sinSet = intersectArcSets(sinSet, arcsInRange(a, Math.PI - a))
  }
  if (hiS < 1) {
    const b = Math.asin(hiS)
    sinSet = intersectArcSets(sinSet, arcsInRange(Math.PI - b, 2 * Math.PI + b))
  }
  return intersectArcSets(cosSet, sinSet)
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
  intervals: Array<[number, number]>,
): void {
  let s = arcLo - psi
  while (s < -Math.PI) s += 2 * Math.PI
  while (s >= Math.PI) s -= 2 * Math.PI
  const hi = s + (arcHi - arcLo)
  const firstLo = Math.max(s, -Math.PI / 2)
  const firstHi = Math.min(hi, Math.PI / 2)
  if (firstLo < firstHi) intervals.push([firstLo, firstHi])
  if (hi > (3 * Math.PI) / 2) {
    const wrapHi = hi - 2 * Math.PI
    if (wrapHi > -Math.PI / 2) intervals.push([-Math.PI / 2, wrapHi])
  }
}

/**
 * Spatial index over previously swept capsules. Each swept segment is stored
 * once per grid cell its own extent covers — the cells the centreline
 * crosses (supercover), each dilated by its 8 neighbours so the radius-r
 * tube is fully indexed — not per cell of a 2r-padded bbox. A query scans
 * only the 3×3 cell block around its own cell, which is exact: a sweep
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
    if (Math.hypot(bx - ax, by - ay) <= ZERO_LENGTH_EPS) return
    const sweep: PriorSweep = { ax, ay, bx, by }
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
   * Cells whose extent the capsule covers: the supercover cells the
   * centreline crosses, each dilated by its 8 neighbours so every point of
   * the radius-r tube sits in an indexed cell.
   */
  private extentCellKeys(sweep: PriorSweep): string[] {
    const c = this.cellSize
    const dx = sweep.bx - sweep.ax
    const dy = sweep.by - sweep.ay
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
      for (let dc = -1; dc <= 1; dc += 1) {
        for (let dr = -1; dr <= 1; dr += 1) {
          keys.add(`${col + dc},${row + dr}`)
        }
      }
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
    const psi = Math.atan2(dirY / dirLength, dirX / dirLength)
    const col = Math.floor(x / this.cellSize)
    const row = Math.floor(y / this.cellSize)
    const intervals: Array<[number, number]> = []
    let foundAny = false
    for (let dc = -1; dc <= 1; dc += 1) {
      for (let dr = -1; dr <= 1; dr += 1) {
        const bucket = this.cells.get(`${col + dc},${row + dr}`)
        if (!bucket) continue
        foundAny = true
        for (const sweep of bucket) {
          if (this.appendCapsuleArcs(sweep, x, y, psi, intervals)) return 0
        }
      }
    }
    if (!foundAny) return Math.PI

    intervals.sort((p, q) => p[0] - q[0])
    let covered = 0
    let currentLo = 0
    let currentHi = 0
    let hasCurrent = false
    for (const [lo, hi] of intervals) {
      if (!hasCurrent || lo > currentHi) {
        if (hasCurrent) covered += currentHi - currentLo
        currentLo = lo
        currentHi = hi
        hasCurrent = true
      } else if (hi > currentHi) {
        currentHi = hi
      }
    }
    if (hasCurrent) covered += currentHi - currentLo
    return Math.min(Math.PI, Math.max(0, Math.PI - covered))
  }

  /**
   * Append the covered arcs of one swept capsule (both endpoint discs and
   * the rectangular body); return true when the whole cutter circle is
   * covered (engagement 0).
   */
  private appendCapsuleArcs(
    sweep: PriorSweep,
    x: number,
    y: number,
    psi: number,
    intervals: Array<[number, number]>,
  ): boolean {
    if (this.appendDiscArcs(sweep.ax, sweep.ay, x, y, psi, intervals)) return true
    if (this.appendDiscArcs(sweep.bx, sweep.by, x, y, psi, intervals)) return true
    const dx = sweep.bx - sweep.ax
    const dy = sweep.by - sweep.ay
    const length = Math.hypot(dx, dy)
    const ex = dx / length
    const ey = dy / length
    const nx = -ey
    const ny = ex
    const wx = x - sweep.ax
    const wy = y - sweep.ay
    const along = ex * wx + ey * wy
    const perp = nx * wx + ny * wy
    const r = this.radius
    const cLo = -along / r
    const cHi = (length - along) / r
    const sLo = -(r + perp) / r
    const sHi = (r - perp) / r
    if (cLo > cHi || sLo > sHi) return false // the rectangle covers no cutter-circle point
    const phiE = Math.atan2(ey, ex)
    for (const [lo, hi] of rectangleBodyArcs(cLo, cHi, sLo, sHi)) {
      pushLeadingClip(phiE + lo, phiE + hi, psi, intervals)
    }
    return false
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
    intervals: Array<[number, number]>,
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
    pushLeadingClip(arcLo, arcLo + 2 * h, psi, intervals)
    return false
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
 * then quantizes to `ENGAGEMENT_FEED_BUCKET_COUNT` buckets whose top rung is
 * 1.0 and whose bottom rung is `slotScale`, rounding DOWN — toward the
 * lower feed, so quantization is itself conservative.
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
  const bucketWidth = (1 - clampedSlot) / (ENGAGEMENT_FEED_BUCKET_COUNT - 1)
  const bucket = Math.min(
    ENGAGEMENT_FEED_BUCKET_COUNT - 1,
    Math.max(0, Math.floor((continuous - clampedSlot) / bucketWidth + 1e-12)),
  )
  return clampedSlot + bucket * bucketWidth
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
 * Stateful feed quantization for one operation: consumes a sequence of
 * (engagement, distance) samples along a path and emits stretches of constant
 * `feedScale` with two controller-friendliness guarantees —
 *
 * - Hysteresis: drops to a lower bucket are immediate (a feed reduction is
 *   never delayed), rises to a higher bucket require the raw scale to sit
 *   past a hysteresis margin inside the target bucket, so a bucket boundary
 *   crossed repeatedly does not alternate. The top rung (scale 1) is
 *   special: `ENGAGEMENT_ESTIMATE_EPSILON` inside `engagementFeedScale` is
 *   its margin — engagement within the estimator's worst-case error of
 *   nominal counts as exactly 1 and rises to full feed with no further
 *   margin.
 * - Minimum fragment length: no emitted stretch is shorter than
 *   `minFragmentLength`; a shorter stretch is merged into its lower-scale
 *   neighbour, so the merge itself also resolves toward the lower feed.
 *
 * Both guarantees are conservative: while in doubt the quantizer holds the
 * lower feed.
 */
export class EngagementFeedQuantizer {
  private readonly nominal: number
  private readonly slotScale: number
  private readonly minFragmentLength: number
  private readonly hysteresisFraction: number
  private readonly bucketWidth: number
  private readonly emitted: EngagementFeedFragment[] = []
  private currentScale: number | null = null
  private heldDistance = 0

  constructor(options: {
    nominal: number
    slotScale: number
    minFragmentLength: number
    hysteresis?: number
  }) {
    this.nominal = options.nominal
    this.slotScale = Math.min(1, Math.max(0, options.slotScale))
    this.minFragmentLength = Math.max(0, options.minFragmentLength)
    this.hysteresisFraction = options.hysteresis ?? DEFAULT_HYSTERESIS_FRACTION
    this.bucketWidth = (1 - this.slotScale) / (ENGAGEMENT_FEED_BUCKET_COUNT - 1)
  }

  /** Feed the next sample: `distance` path units travelled at `engagement` radians. */
  push(engagement: number, distance: number): void {
    const clamped = Math.min(Math.PI, Math.max(0, engagement))
    const safeDistance = Math.max(0, distance)
    const rawScale = engagementFeedScale(clamped, this.nominal, this.slotScale)
    if (this.currentScale === null) {
      this.currentScale = rawScale
      this.heldDistance = safeDistance
      return
    }
    if (rawScale === this.currentScale) {
      this.heldDistance += safeDistance
      return
    }
    if (rawScale < this.currentScale) {
      // Engagement rose: drop the feed immediately (conservative).
      this.emitted.push({ scale: this.currentScale, distance: this.heldDistance })
      this.currentScale = rawScale
      this.heldDistance = safeDistance
      return
    }
    // Engagement fell: rise only past the hysteresis margin inside the target
    // bucket and only after the current stretch has reached the minimum
    // fragment length. The top rung (scale 1) uses the deadband as its
    // margin; a NaN sample never rises (NaN comparisons are false). Otherwise
    // hold the current (lower) feed.
    const continuous = continuousFeedScale(clamped, this.nominal, this.slotScale)
    const effective = clamped <= this.nominal + ENGAGEMENT_ESTIMATE_EPSILON ? 1 : continuous
    const margin = rawScale >= 1 ? 0 : this.hysteresisFraction * this.bucketWidth
    if (effective >= rawScale + margin && this.heldDistance >= this.minFragmentLength) {
      this.emitted.push({ scale: this.currentScale, distance: this.heldDistance })
      this.currentScale = rawScale
      this.heldDistance = safeDistance
    } else {
      this.heldDistance += safeDistance
    }
  }

  /** Emitted stretches, with every stretch shorter than the minimum fragment length merged away. */
  fragments(): EngagementFeedFragment[] {
    const result = this.emitted.slice()
    if (this.currentScale !== null) result.push({ scale: this.currentScale, distance: this.heldDistance })
    for (let i = 0; i < result.length; ) {
      const fragment = result[i]
      if (result.length === 1 || fragment.distance >= this.minFragmentLength) {
        i += 1
        continue
      }
      const next = result[i + 1]
      const prev = result[i - 1]
      const targetIndex = next && (!prev || next.scale <= prev.scale) ? i + 1 : i - 1
      const target = result[targetIndex]
      result.splice(Math.min(i, targetIndex), 2, {
        scale: Math.min(fragment.scale, target.scale),
        distance: fragment.distance + target.distance,
      })
      if (targetIndex < i) i = targetIndex
    }
    return result
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
