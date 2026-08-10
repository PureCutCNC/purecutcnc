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
 * The Z profile a smooth tab imposes on one crossing of its footprint.
 *
 * A rectangular tab steps the toolpath up to `z_top` at the footprint boundary,
 * rides it flat, and steps back down. A smooth tab keeps the same footprint and
 * the same peak, but rises and falls continuously across the crossing so the
 * machine never has to stop XY while Z moves — the whole point on machines whose
 * Z axis is much slower than XY.
 *
 * Everything here is pure and unit-agnostic: distances and heights are in
 * whatever unit the caller uses, and `u` is a normalized position along one
 * crossing (0 = footprint entry, 1 = footprint exit).
 */

/**
 * Normalized raised-cosine height: `u` in [0, 1] maps to [0, 1].
 *
 * Chosen over the Gaussian the original proposal used because every value the
 * tests care about is exact rather than approached:
 *
 * - `h(0) = h(1) = 0` — the crossing starts and ends exactly at the source cut
 *   Z, so there is no step at the footprint boundary in either direction.
 * - `h(0.5) = 1` — the requested `z_top` is reached exactly at the crossing
 *   centre, not merely sampled near.
 * - `h'(0) = h'(1) = h'(0.5) = 0` — zero-slope joins at both boundaries and at
 *   the peak, so Z velocity starts and ends at zero and the top is not a corner.
 * - Monotonic rising on [0, 0.5] and falling on [0.5, 1], and never negative, so
 *   the tool can never dip below the cut Z it came in at.
 *
 * A truncated Gaussian has none of these properties exactly.
 */
export function smoothTabHeightFraction(u: number): number {
  const clamped = Math.min(1, Math.max(0, u))
  return (1 - Math.cos(2 * Math.PI * clamped)) / 2
}

/**
 * Normalized position to use for a crossing whose entry or exit is truncated.
 *
 * A crossing is truncated when the cut chain starts or ends *inside* the tab
 * footprint rather than passing through it — an open profile whose end lies in a
 * tab, say. The missing half of the ramp cannot be reconstructed, and descending
 * to the cut Z inside the footprint would machine away exactly the material the
 * tab exists to keep. Pinning the parameter to the peak side instead holds
 * `z_top` for the truncated portion, which is what a rectangular tab already
 * does there, so the behaviour is never less conservative than today's.
 *
 * A chain that both starts and ends inside one footprint degenerates to a
 * constant `z_top` — again, exactly the rectangular envelope.
 */
export function clampCrossingFraction(
  u: number,
  entryTruncated: boolean,
  exitTruncated: boolean,
): number {
  let clamped = Math.min(1, Math.max(0, u))
  if (entryTruncated) {
    clamped = Math.max(clamped, 0.5)
  }
  if (exitTruncated) {
    clamped = Math.min(clamped, 0.5)
  }
  return clamped
}

/** Absolute Z at normalized position `u` across one crossing. */
export function smoothTabZAt(
  u: number,
  baseZ: number,
  topZ: number,
  entryTruncated = false,
  exitTruncated = false,
): number {
  if (!(topZ > baseZ)) {
    return baseZ
  }
  const fraction = smoothTabHeightFraction(clampCrossingFraction(u, entryTruncated, exitTruncated))
  return baseZ + (topZ - baseZ) * fraction
}

/** Smallest even sample count, and the widest the profile is ever subdivided. */
const MIN_SAMPLE_COUNT = 4
const MAX_SAMPLE_COUNT = 512

/**
 * Number of equal sub-intervals the crossing must be split into to keep the
 * straight-line approximation within `chordTolerance` of the true curve.
 *
 * For `z(s) = base + A·(1 − cos(2πs/L))/2` the second derivative peaks at
 * `2π²A/L²`, and a chord across `Δs` deviates by at most `|z''|·Δs²/8`. With
 * `Δs = L/n` that bound is `π²A/(4n²)`, so
 *
 *     n ≥ (π/2)·sqrt(A / tolerance)
 *
 * Note what is absent: the crossing length. A long crossing and a short one at
 * the same tab height need the same number of samples, because a longer crossing
 * is a gentler curve. This is why the count is derived per crossing from the
 * tolerance rather than fixed per source move — a fixed count subdivides a
 * finely segmented path far more than it needs to and a coarse one not enough.
 *
 * The result is forced even so that `u = 0.5`, where the profile reaches `z_top`
 * exactly, is always one of the emitted samples.
 */
export function smoothTabSampleCount(rise: number, chordTolerance: number): number {
  if (!(rise > 0) || !(chordTolerance > 0)) {
    return MIN_SAMPLE_COUNT
  }

  const required = (Math.PI / 2) * Math.sqrt(rise / chordTolerance)
  const rounded = Math.ceil(required)
  const even = rounded % 2 === 0 ? rounded : rounded + 1
  return Math.min(MAX_SAMPLE_COUNT, Math.max(MIN_SAMPLE_COUNT, even))
}

/**
 * Normalized sample positions across one crossing, always including 0, 0.5 and
 * 1 exactly. Callers map these onto arc length along the cut chain, so the XY
 * path is followed exactly and only Z is approximated.
 */
export function smoothTabSampleFractions(rise: number, chordTolerance: number): number[] {
  const count = smoothTabSampleCount(rise, chordTolerance)
  const fractions: number[] = []
  for (let index = 0; index <= count; index += 1) {
    fractions.push(index / count)
  }
  fractions[0] = 0
  fractions[count] = 1
  fractions[count / 2] = 0.5
  return fractions
}
