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
 * Prior sweeps are modelled as chains of discs of the tool radius, spaced so
 * the under-covered lens between consecutive discs stays below a stated
 * fraction of the tool radius (see `DISC_UNDERCOVER_FRACTION`). This is exact
 * per disc (closed form below), and its error is conservative by construction:
 * under-covering a prior sweep reports more uncut material, therefore more
 * engagement, therefore a lower feed.
 *
 * Conservative bias is a hard rule: sampling gaps, index misses, and
 * degenerate or zero-length input all resolve toward MORE engagement.
 * Nothing about uncertainty may restore full feed.
 */

/**
 * Closed form for one disc. Query centre `C`, tool radius `r`, prior disc
 * centre `Q`: let `v = Q − C`, `D = |v|`, `φ = atan2(v.y, v.x)`. A cutter
 * circle point `P(θ) = C + r·u(θ)` lies inside the prior disc iff
 *
 *   |r·u − v|² ≤ r²  ⟺  u·v ≥ D² / (2r)  ⟺  cos(θ − φ) ≥ D / (2r)
 *
 * so the covered angular interval is the single arc `[φ − h, φ + h]` with
 * `h = arccos(D / (2r))`, non-empty only when `D ≤ 2r`. When `D = 0` the
 * cutter circle lies entirely inside the prior disc (covered measure `2π`);
 * `atan2` is undefined there, so that case is special-cased.
 *
 * Validation identity: for a straight pass parallel to a prior pass at radial
 * depth `a_e`, the union of covered arcs over the wall reproduces the analytic
 * wrap angle exactly: engagement = `arccos(1 − a_e/r)` (0 at `a_e = 0`,
 * `π/2` at `a_e = r`, `π` at `a_e = 2r`).
 */

/**
 * Stated bound on the under-covered lens between consecutive discs of a swept
 * segment, as a fraction of the tool radius. Two discs at spacing `s` leave a
 * lens of radial depth `r − sqrt(r² − (s/2)²)` between them; requiring that
 * depth to stay below `ε·r` gives the disc spacing
 *
 *   s = 2r · sqrt(2ε − ε²)
 *
 * With `ε = 2e-4` the spacing is ≈ `0.04·r` and the worst-case engagement
 * error of the chain (a query centred midway between two discs on the same
 * centreline) is `2·arcsin(s / (4r))` ≈ `0.02` rad, which sets the tight
 * tolerance of the validation tests.
 */
const DISC_UNDERCOVER_FRACTION = 2e-4

/** Segments shorter than this sweep no measurable material and are not indexed. */
const ZERO_LENGTH_EPS = 1e-9

/** Query directions shorter than this cannot define a leading semicircle. */
const DEGENERATE_DIRECTION_EPS = 1e-12

/**
 * Number of feed-scale buckets emitted by `engagementFeedScale`. Small on
 * purpose: arc fitting refuses to join two moves whose `feedScale` differs at
 * all (`sameRun`, `src/engine/gcode/arcFitting.ts`), so a continuously varying
 * scale would shatter every arc run into linear moves.
 */
export const ENGAGEMENT_FEED_BUCKET_COUNT = 6

interface PriorDisc {
  x: number
  y: number
}

/**
 * Spatial index over previously swept segments: each segment is stored as a
 * chain of discs of the tool radius (spacing bounded by the under-cover
 * fraction above), and each disc is inserted into every grid cell its bbox
 * inflated by one tool diameter covers — so a query at distance ≤ 2r from a
 * disc always finds it in its own cell's bucket. Mirrors the grid approach of
 * `PriorCutIndex` in `pocket.ts`.
 */
export class SweptMaterialIndex {
  private readonly cells = new Map<string, PriorDisc[]>()
  private readonly radius: number
  private readonly discSpacing: number
  private readonly cellSize: number

  constructor(toolRadius: number) {
    if (!Number.isFinite(toolRadius) || toolRadius <= 0) {
      throw new RangeError(`SweptMaterialIndex: toolRadius must be a positive finite number, got ${toolRadius}`)
    }
    this.radius = toolRadius
    this.discSpacing =
      2 * toolRadius * Math.sqrt(2 * DISC_UNDERCOVER_FRACTION - DISC_UNDERCOVER_FRACTION * DISC_UNDERCOVER_FRACTION)
    this.cellSize = 2 * toolRadius
  }

  /**
   * Record a swept straight segment `A → B` (a prior cut move at this level).
   * The segment is stored as a chain of discs of the tool radius with both
   * endpoints included. Zero-length segments are skipped — an unindexed sweep
   * resolves toward more engagement, which is the conservative direction.
   */
  addSweptSegment(ax: number, ay: number, bx: number, by: number): void {
    const dx = bx - ax
    const dy = by - ay
    const length = Math.hypot(dx, dy)
    if (length <= ZERO_LENGTH_EPS) return
    const discCount = Math.max(2, Math.ceil(length / this.discSpacing) + 1)
    for (let disc = 0; disc < discCount; disc += 1) {
      const t = disc / (discCount - 1)
      this.insertDisc(ax + dx * t, ay + dy * t)
    }
  }

  private insertDisc(x: number, y: number): void {
    const pad = this.cellSize
    const colMin = Math.floor((x - pad) / this.cellSize)
    const colMax = Math.floor((x + pad) / this.cellSize)
    const rowMin = Math.floor((y - pad) / this.cellSize)
    const rowMax = Math.floor((y + pad) / this.cellSize)
    for (let col = colMin; col <= colMax; col += 1) {
      for (let row = rowMin; row <= rowMax; row += 1) {
        const key = `${col},${row}`
        const bucket = this.cells.get(key)
        if (bucket) {
          bucket.push({ x, y })
        } else {
          this.cells.set(key, [{ x, y }])
        }
      }
    }
  }

  /**
   * Engagement in radians at cutter centre `(x, y)` moving in direction
   * `(dirX, dirY)` (need not be unit length): the measure of the leading
   * semicircle lying in material not yet swept, in `[0, π]`.
   *
   * The covered arcs of every prior disc in the query cell are unioned, then
   * clipped to the leading semicircle; engagement is the uncovered measure.
   * Degenerate input (non-finite coordinates, a zero-length direction, or no
   * prior sweep in range) resolves to `π` — full engagement — per the
   * conservative-bias rule.
   */
  engagementAt(x: number, y: number, dirX: number, dirY: number): number {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(dirX) || !Number.isFinite(dirY)) {
      return Math.PI
    }
    const dirLength = Math.hypot(dirX, dirY)
    if (dirLength <= DEGENERATE_DIRECTION_EPS) return Math.PI
    const psi = Math.atan2(dirY / dirLength, dirX / dirLength)
    const bucket = this.cells.get(`${Math.floor(x / this.cellSize)},${Math.floor(y / this.cellSize)}`)
    if (!bucket) return Math.PI

    const twoR = 2 * this.radius
    const intervals: Array<[number, number]> = []
    for (const disc of bucket) {
      const vx = disc.x - x
      const vy = disc.y - y
      const dSq = vx * vx + vy * vy
      if (dSq > twoR * twoR) continue
      if (vx === 0 && vy === 0) {
        // The cutter circle lies inside the prior disc: everything covered.
        return 0
      }
      const d = Math.sqrt(dSq)
      const h = Math.acos(Math.min(1, Math.max(-1, d / twoR)))
      // Covered arc [φ − h, φ + h], shifted so the leading semicircle is
      // [−π/2, π/2].
      let a = Math.atan2(vy, vx) - psi - h
      while (a < -Math.PI) a += 2 * Math.PI
      while (a >= Math.PI) a -= 2 * Math.PI
      const b = a + 2 * h
      // Intersect [a, b] with [−π/2, π/2]; the arc may wrap past π.
      const firstLo = Math.max(a, -Math.PI / 2)
      const firstHi = Math.min(b, Math.PI / 2)
      if (firstLo < firstHi) intervals.push([firstLo, firstHi])
      if (b > (3 * Math.PI) / 2) {
        const wrapHi = b - 2 * Math.PI
        if (wrapHi > -Math.PI / 2) intervals.push([-Math.PI / 2, wrapHi])
      }
    }

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
 * Map an engagement to a `feedScale`: exactly `1` at or below the nominal
 * engagement implied by the operation's stepover, then linear interpolation
 * from 1 down to `slotScale` (the feed at full-slot engagement) between
 * nominal and `π`, then quantization to `ENGAGEMENT_FEED_BUCKET_COUNT`
 * buckets rounding DOWN — toward the lower feed, so quantization is itself
 * conservative.
 *
 * The quantization is not a preference: arc fitting refuses to join moves
 * whose `feedScale` differs at all, so a continuous scale would shatter every
 * arc run into linear moves. Hysteresis between buckets and a minimum
 * fragment length are applied by `EngagementFeedQuantizer`.
 *
 * Degenerate inputs: engagement ≤ nominal (including NaN) → `1`; `slotScale`
 * is clamped to `[0, 1]` (≥ 1 → always 1); nominal ≥ π → always 1.
 */
export function engagementFeedScale(engagement: number, nominal: number, slotScale: number): number {
  if (!(engagement > nominal)) return 1
  const clampedSlot = Math.min(1, Math.max(0, slotScale))
  if (clampedSlot >= 1) return 1
  if (!(nominal < Math.PI)) return 1
  const continuous = continuousFeedScale(engagement, nominal, clampedSlot)
  const bucketWidth = (1 - clampedSlot) / (ENGAGEMENT_FEED_BUCKET_COUNT - 1)
  const bucket = Math.min(
    ENGAGEMENT_FEED_BUCKET_COUNT - 2,
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
 *   crossed repeatedly does not alternate.
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
    // fragment length. Otherwise hold the current (lower) feed.
    const continuous = continuousFeedScale(clamped, this.nominal, this.slotScale)
    if (continuous >= rawScale + this.hysteresisFraction * this.bucketWidth && this.heldDistance >= this.minFragmentLength) {
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
