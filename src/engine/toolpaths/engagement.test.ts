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

import {
  ENGAGEMENT_ESTIMATE_EPSILON,
  ENGAGEMENT_FEED_BUCKET_COUNT,
  EngagementFeedQuantizer,
  EngagementTelemetryAccumulator,
  SweptMaterialIndex,
  engagementFeedScale,
  nominalEngagement,
} from './engagement'

let passed = 0
let failed = 0

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed += 1
  } else {
    failed += 1
    console.error(`FAIL: ${message}`)
  }
}

function approx(a: number, b: number, epsilon = 1e-9): boolean {
  return Math.abs(a - b) < epsilon
}

/** 32-bit LCG (Numerical Recipes constants) with a constant seed — the
 *  determinism rules forbid Math.random. */
function makeLcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0
    return state / 4294967296
  }
}

/**
 * Independent swept-stock reference for the capsule equivalence check: the
 * same swept segments as a chain of discs at spacing `spacing`, evaluated
 * with the disc closed form from the domain contract. Deliberately
 * brute-force (no spatial index) — it exists only to grade the production
 * estimator, which must not grade its own homework. A chain under-covers
 * the true swept capsule by a lens of radial depth `r − √(r² − (s/2)²)`
 * between consecutive discs, so its worst-case engagement over-report is
 * `2·arcsin(s / (4r))` ≈ 0.0025 rad at `s = r/200`.
 */
class DiscChainReference {
  private readonly discs: Array<{ x: number; y: number }> = []
  private readonly radius: number
  private readonly spacing: number

  constructor(radius: number, spacing: number) {
    this.radius = radius
    this.spacing = spacing
  }

  addSweptSegment(ax: number, ay: number, bx: number, by: number): void {
    const dx = bx - ax
    const dy = by - ay
    const length = Math.hypot(dx, dy)
    if (length <= 1e-12) return
    const discCount = Math.max(2, Math.ceil(length / this.spacing) + 1)
    for (let disc = 0; disc < discCount; disc += 1) {
      const t = disc / (discCount - 1)
      this.discs.push({ x: ax + dx * t, y: ay + dy * t })
    }
  }

  engagementAt(x: number, y: number, dirX: number, dirY: number): number {
    const dirLength = Math.hypot(dirX, dirY)
    const psi = Math.atan2(dirY / dirLength, dirX / dirLength)
    const twoR = 2 * this.radius
    const intervals: Array<[number, number]> = []
    for (const disc of this.discs) {
      const vx = disc.x - x
      const vy = disc.y - y
      const dSq = vx * vx + vy * vy
      if (dSq > twoR * twoR) continue
      if (vx === 0 && vy === 0) return 0
      const h = Math.acos(Math.min(1, Math.max(-1, Math.sqrt(dSq) / twoR)))
      let a = Math.atan2(vy, vx) - psi - h
      while (a < -Math.PI) a += 2 * Math.PI
      while (a >= Math.PI) a -= 2 * Math.PI
      const b = a + 2 * h
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

// ── Fixture helpers ─────────────────────────────────────────────

/** Index holding a single straight prior pass along y = 0 from −halfLength to +halfLength. */
function wallIndex(toolRadius: number, halfLength: number): SweptMaterialIndex {
  const index = new SweptMaterialIndex(toolRadius)
  index.addSweptSegment(-halfLength, 0, halfLength, 0)
  return index
}

/** Max engagement over the query x positions for a pass at radial depth a_e below the wall. */
function wallEngagementAt(index: SweptMaterialIndex, radialDepth: number, xPositions: number[]): number {
  let max = -Infinity
  for (const x of xPositions) {
    const measured = index.engagementAt(x, -radialDepth, 1, 0)
    if (measured > max) max = measured
  }
  return max
}

// ── 1. Validation identity: straight pass parallel to a prior pass ──
//
// For a prior wall along y = 0 and a query pass at radial depth a_e below it,
// moving +x, the covered arc of the leading semicircle satisfies
// sin θ ≥ a_e/r − 1, so the uncovered measure is
// arcsin(a_e/r − 1) + π/2 ≡ arccos(1 − a_e/r). Both sides agree at
// a_e = 0 (0), a_e = r (π/2), and a_e = 2r (π).

console.log('Testing wall validation identity against arccos(1 − a_e/r)...')
{
  const r = 1
  // Query x positions deliberately include arbitrary phases along the wall:
  // the capsule model is exact at every phase, so the identity must now hold
  // to floating-point precision (the former disc chain only reached its
  // 0.03 rad tolerance at favourable phases — the capsule rewrite makes this
  // MORE accurate, and the tolerance is tightened to prove it).
  const xPositions = [0.31, 0.77, 1.13, 0.32]
  const index = wallIndex(r, 10 * r)
  const depthCases = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75].map((f) => f * r)
  for (const a_e of depthCases) {
    const expected = Math.acos(Math.min(1, Math.max(-1, 1 - a_e / r)))
    const measured = wallEngagementAt(index, a_e, xPositions)
    assert(
      Math.abs(measured - expected) <= 1e-9,
      `wall identity at a_e = ${a_e}r: expected ${expected.toFixed(4)}, measured ${measured.toFixed(4)}`,
    )
  }
  // a_e = 2r: the cutter just grazes the prior kerf — full slot π, exactly.
  const fullSlot = wallEngagementAt(index, 2 * r, xPositions)
  assert(Math.abs(fullSlot - Math.PI) <= 0.001, `a_e = 2r should be π exactly, measured ${fullSlot.toFixed(4)}`)

  // Fully-covered special case: the query centre exactly on the swept
  // capsule's centreline (the cutter circle lies inside the capsule,
  // everything covered) must give exactly 0 — for any motion direction,
  // since the whole circle is covered.
  const onDiscIndex = new SweptMaterialIndex(r)
  onDiscIndex.addSweptSegment(-1, 0, 1, 0)
  // An interior point of the swept centreline (discX was the former disc
  // chain's centre and remains a valid interior point).
  const discCount = Math.ceil(2 / (2 * r * Math.sqrt(2 * 2e-4 - 4e-8))) + 1
  const discX = -1 + 2 * (26 / (discCount - 1))
  assert(onDiscIndex.engagementAt(discX, 0, 1, 0) === 0, 'query exactly on a prior disc centre must give exactly 0')
  assert(onDiscIndex.engagementAt(discX, 0, 0, 1) === 0, 'on-disc query with perpendicular direction must give exactly 0')
  assert(onDiscIndex.engagementAt(discX, 0, 0.6, 0.8) === 0, 'on-disc query with oblique direction must give exactly 0')
}

console.log('Testing wall identity is scale-invariant (r = 3)...')
{
  const r = 3
  const xPositions = [0.93, 2.31, 3.39, 0.96]
  const index = wallIndex(r, 10 * r)
  for (const f of [0, 0.5, 1, 1.5]) {
    const a_e = f * r
    const expected = Math.acos(Math.min(1, Math.max(-1, 1 - a_e / r)))
    const measured = wallEngagementAt(index, a_e, xPositions)
    assert(
      Math.abs(measured - expected) <= 1e-9,
      `r=3 wall identity at a_e = ${f}r: expected ${expected.toFixed(4)}, measured ${measured.toFixed(4)}`,
    )
  }
}

// ── 2. Out of contact with any prior sweep is full engagement ──
//
// Virgin material: the whole leading semicircle lies in uncut material, so
// the answer is π. Getting this backwards inverts the whole feature.

console.log('Testing out of contact returns π...')
{
  const empty = new SweptMaterialIndex(1)
  assert(approx(empty.engagementAt(3, -4, 1, 0), Math.PI), 'empty index should report π')
  assert(approx(empty.engagementAt(0, 0, 0, 1), Math.PI), 'empty index at origin should report π')

  const farAway = new SweptMaterialIndex(1)
  farAway.addSweptSegment(50, 0, 60, 0)
  assert(approx(farAway.engagementAt(0, 0, 1, 0), Math.PI), 'prior sweep beyond one tool diameter should report π')
  assert(approx(farAway.engagementAt(0, 0, -1, 0), Math.PI), 'far prior sweep, reversed direction, should report π')
}

// ── 3. Concave circular corner amplifies engagement ──
//
// Prior sweep: a straight wall along y = 0 (kerf |y| ≤ r). The query pass
// runs parallel at the nominal stepover a_e = r (y = −r) and then rounds a
// concave circular corner of radius r bending toward the wall, so the
// leading semicircle swings away from the wall kerf into the uncut material
// beside it. Analytic reference for the cutter 60° into the corner arc,
// centre C = (r·sin π/3, −r + r·cos π/3), tangent (cos π/3, −sin π/3): the
// wall covers exactly P_y ≥ −r ⟺ sin θ ≥ −0.5, which inside the leading
// semicircle [−5π/6, π/6] is [−π/6, π/6] — measure π/3 — so engagement is
// 2π/3, i.e. π/6 above the straight-wall value arccos(1 − r/r) = π/2 for the
// same nominal stepover.

console.log('Testing concave circular corner amplification...')
const CORNER_MARGIN = 0.4 // asserted amplification floor; analytic margin is π/6 ≈ 0.52
let cornerEngagement: number | null = null
let straightWallEngagement: number | null = null
{
  const r = 1
  const wall = wallIndex(r, 10 * r)
  const t = Math.PI / 3
  const cornerX = r * Math.sin(t)
  const cornerY = -r + r * Math.cos(t)
  cornerEngagement = wall.engagementAt(cornerX, cornerY, Math.cos(t), -Math.sin(t))
  assert(
    Math.abs(cornerEngagement - (2 * Math.PI) / 3) <= 0.03,
    `corner arc should measure 2π/3 within tolerance, measured ${cornerEngagement.toFixed(4)}`,
  )

  // Same nominal stepover on the straight part of the pass, away from the corner.
  straightWallEngagement = wall.engagementAt(cornerX, -r, 1, 0)
  assert(
    Math.abs(straightWallEngagement - Math.PI / 2) <= 0.03,
    `straight wall should measure π/2 within tolerance, measured ${straightWallEngagement.toFixed(4)}`,
  )
}

// The amplification claim itself: the corner must clear the straight wall by
// a measured margin. Written as a throwing check so its failure mode can be
// observed in isolation below.
function expectCornerAmplification(atCorner: number, atWall: number): void {
  if (!(atCorner >= atWall + CORNER_MARGIN)) {
    throw new Error(
      `concave corner (${atCorner.toFixed(4)}) must exceed the straight wall (${atWall.toFixed(4)}) by ${CORNER_MARGIN}`,
    )
  }
}
if (cornerEngagement !== null && straightWallEngagement !== null) {
  console.log('Testing corner amplification exceeds the straight wall by a measured margin...')
  let amplified = true
  try {
    expectCornerAmplification(cornerEngagement, straightWallEngagement)
  } catch {
    amplified = false
  }
  assert(amplified, 'concave corner must exceed the straight wall by the measured margin')
  const margin = cornerEngagement - straightWallEngagement
  assert(margin >= Math.PI / 6 - 0.03, `measured margin ${margin.toFixed(4)} should reproduce the analytic π/6`)

  // Falsifiability: with the corner removed from the fixture (a straight wall
  // at the same stepover, i.e. the same comparison with the amplification
  // removed) the amplification assertion must FAIL — otherwise the claim is
  // un-falsifiable and the test above is decoration.
  console.log('Testing the amplification assertion rejects the no-corner fixture...')
  let falsified = false
  try {
    expectCornerAmplification(straightWallEngagement, straightWallEngagement)
  } catch {
    falsified = true
  }
  assert(falsified, 'amplification assertion must fail when the corner is removed from the fixture')
}

// ── 4. Conservative bias: a starved index reports more engagement ──

console.log('Testing conservative bias for a starved index...')
{
  const r = 1
  // The prior wall as 20 explicit segments of 0.5r each.
  const segmentHalfCount = 10
  const segmentLength = 0.5 * r
  const full = new SweptMaterialIndex(r)
  const starved = new SweptMaterialIndex(r)
  for (let i = -segmentHalfCount; i < segmentHalfCount; i += 1) {
    const ax = i * segmentLength
    const segment = [ax, 0, ax + segmentLength, 0] as const
    full.addSweptSegment(...segment)
    if (i % 2 === 0) starved.addSweptSegment(...segment)
  }
  // Queries at depth r below, near the dropped segments (odd indices).
  const queryX = [-2.25, -1.25, -0.25, 0.75, 1.75]
  let sawStrictlyMore = false
  for (const x of queryX) {
    const fullEngagement = full.engagementAt(x, -r, 1, 0)
    const starvedEngagement = starved.engagementAt(x, -r, 1, 0)
    assert(
      starvedEngagement >= fullEngagement,
      `starved (${starvedEngagement.toFixed(4)}) must never report less than full (${fullEngagement.toFixed(4)}) at x=${x}`,
    )
    if (starvedEngagement > fullEngagement + 1e-9) sawStrictlyMore = true
  }
  assert(sawStrictlyMore, 'starved index must report strictly more engagement somewhere near a dropped segment')
  // Fully starved = empty index = maximum engagement.
  const empty = new SweptMaterialIndex(r)
  for (const x of queryX) {
    assert(
      empty.engagementAt(x, -r, 1, 0) >= full.engagementAt(x, -r, 1, 0),
      'empty index must report at least as much engagement as the full index',
    )
  }
}

// ── 5. engagementFeedScale: exact anchors, monotonicity, bucket count ──

console.log('Testing engagementFeedScale anchors and quantization...')
{
  const nominal = Math.PI / 2
  const slotScale = 0.4
  assert(approx(engagementFeedScale(0, nominal, slotScale), 1), 'at engagement 0 the scale must be exactly 1')
  assert(approx(engagementFeedScale(nominal / 2, nominal, slotScale), 1), 'below nominal the scale must be exactly 1')
  assert(approx(engagementFeedScale(nominal, nominal, slotScale), 1), 'at nominal the scale must be exactly 1')
  assert(approx(engagementFeedScale(Math.PI, nominal, slotScale), slotScale), 'at π the scale must be exactly slotScale')

  const bucketWidth = (1 - slotScale) / (ENGAGEMENT_FEED_BUCKET_COUNT - 1)
  const distinct = new Set<number>()
  let previous = Infinity
  const step = 0.0005
  for (let engagement = 0; engagement <= Math.PI; engagement += step) {
    const scale = engagementFeedScale(engagement, nominal, slotScale)
    distinct.add(scale)
    assert(scale <= previous + 1e-12, `scale must be monotonically non-increasing, ${previous} → ${scale} at ${engagement}`)
    previous = scale
    // Round-down: never above the unquantized interpolation.
    const t = Math.min(engagement, Math.PI) <= nominal ? 0 : (Math.min(engagement, Math.PI) - nominal) / (Math.PI - nominal)
    const continuous = 1 + (slotScale - 1) * t
    assert(scale <= continuous + 1e-12, `scale ${scale} must round down from continuous ${continuous}`)
    // Values must come from the stated bucket set.
    const k = Math.round((scale - slotScale) / bucketWidth)
    assert(
      scale === 1 || (Number.isInteger(k) && k >= 0 && k < ENGAGEMENT_FEED_BUCKET_COUNT - 1 && approx(scale, slotScale + k * bucketWidth, 1e-12)),
      `scale ${scale} is not a member of the ${ENGAGEMENT_FEED_BUCKET_COUNT}-bucket set`,
    )
  }
  assert(
    distinct.size <= ENGAGEMENT_FEED_BUCKET_COUNT,
    `dense sweep must emit at most ${ENGAGEMENT_FEED_BUCKET_COUNT} distinct scales, got ${distinct.size}`,
  )
  assert(distinct.size > 1, 'dense sweep must actually quantize to more than one distinct scale')

  // Degenerate inputs: nominal at/above π or slotScale at/above 1 → always 1.
  assert(approx(engagementFeedScale(Math.PI, Math.PI, slotScale), 1), 'nominal = π should always return 1')
  assert(approx(engagementFeedScale(Math.PI, 4, slotScale), 1), 'nominal above π should always return 1')
  assert(approx(engagementFeedScale(Math.PI, nominal, 1), 1), 'slotScale = 1 should always return 1')
  assert(approx(engagementFeedScale(Number.NaN, nominal, slotScale), 1), 'NaN engagement should return 1')
  // Negative slotScale clamps to 0 — the lowest possible feed.
  assert(approx(engagementFeedScale(Math.PI, nominal, -0.5), 0), 'negative slotScale should clamp to 0 at π')
}

// ── 5b. Nominal-boundary deadband ──
//
// The measured cliff defect: a real straight ring run reported engagement
// 4.16e-8 rad above nominal — dust from the estimator's own floating-point
// evaluation — and the old boundary (scale 1 only for engagement ≤ nominal)
// charged it a full feed bucket, running every straight pass 12% slow.
// The deadband treats anything within ENGAGEMENT_ESTIMATE_EPSILON of nominal
// as at nominal, i.e. scale exactly 1.

console.log('Testing the deadband around nominal...')
{
  const nominal = Math.PI / 2
  const slotScale = 0.4
  assert(
    engagementFeedScale(nominal + ENGAGEMENT_ESTIMATE_EPSILON / 2, nominal, slotScale) === 1,
    'engagement inside the tolerance must map to exactly 1',
  )
  assert(
    engagementFeedScale(nominal + ENGAGEMENT_ESTIMATE_EPSILON, nominal, slotScale) === 1,
    'the tolerance edge itself must map to exactly 1',
  )
  // The number from the field: 4.16e-8 rad above nominal, measured on a real
  // straight ring run, sits inside the deadband.
  assert(
    engagementFeedScale(nominal + 4.16e-8, nominal, slotScale) === 1,
    'the measured 4.16e-8 rad field over-report must map to exactly 1',
  )
  assert(
    engagementFeedScale(nominal - ENGAGEMENT_ESTIMATE_EPSILON, nominal, slotScale) === 1,
    'below nominal the scale must stay exactly 1',
  )
  assert(
    engagementFeedScale(nominal + 2 * ENGAGEMENT_ESTIMATE_EPSILON, nominal, slotScale) < 1,
    'outside the tolerance the scale must step down',
  )
}

// ── 5c. Bucket ladder: 1.0 is a rung, π maps to slotScale exactly ──

console.log('Testing the bucket ladder includes 1.0 as its top rung...')
{
  const nominal = Math.PI / 2
  const slotScale = 0.4
  const distinct = new Set<number>()
  let previous = Infinity
  for (let engagement = 0; engagement <= Math.PI; engagement += 0.0005) {
    const scale = engagementFeedScale(engagement, nominal, slotScale)
    distinct.add(scale)
    assert(scale <= previous + 1e-12, `ladder must be monotone, ${previous} → ${scale} at ${engagement}`)
    previous = scale
  }
  assert(distinct.has(1), '1.0 must be a member of the emitted scale set')
  assert(
    distinct.size === ENGAGEMENT_FEED_BUCKET_COUNT,
    `the ladder must emit exactly the stated ${ENGAGEMENT_FEED_BUCKET_COUNT} buckets, got ${distinct.size}: ${[...distinct].sort((a, b) => a - b).join(', ')}`,
  )
  // The value at π must be exactly slotScale — not slotScale minus a step.
  assert(engagementFeedScale(Math.PI, nominal, slotScale) === slotScale, 'the value at π must be exactly slotScale')
}

// ── 6. Determinism: identical input sequences, identical output ──

console.log('Testing determinism across independent index instances...')
{
  const segments: Array<[number, number, number, number]> = []
  let x = -4
  let y = 2
  for (let i = 0; i < 12; i += 1) {
    const nx = x + 0.7 + 0.1 * i
    const ny = y + (i % 2 === 0 ? 0.4 : -0.4)
    segments.push([x, y, nx, ny])
    x = nx
    y = ny
  }
  const queries: Array<[number, number, number, number]> = [
    [-1.5, 1.2, 1, 0.3],
    [0.5, 0.8, -0.7, 0.7],
    [2.1, 2.6, 0, -1],
    [-3.2, 1.7, 0.2, 1],
    [0.9, 0.2, 1, 0],
  ]
  const first = new SweptMaterialIndex(1)
  const second = new SweptMaterialIndex(1)
  for (const segment of segments) {
    first.addSweptSegment(...segment)
    second.addSweptSegment(...segment)
  }
  for (const [qx, qy, dx, dy] of queries) {
    const a = first.engagementAt(qx, qy, dx, dy)
    const b = second.engagementAt(qx, qy, dx, dy)
    assert(a === b, `two instances must agree exactly at (${qx}, ${qy}) dir (${dx}, ${dy}): ${a} vs ${b}`)
  }
  // Quantizer determinism: same sample sequence, identical fragments.
  const makeQuantizer = (): EngagementFeedQuantizer =>
    new EngagementFeedQuantizer({ nominal: Math.PI / 2, slotScale: 0.4, minFragmentLength: 0.5 })
  const q1 = makeQuantizer()
  const q2 = makeQuantizer()
  for (let i = 0; i <= 100; i += 1) {
    const engagement = (i / 100) * Math.PI * (i % 3 === 0 ? 1 : 0.5)
    q1.push(engagement, 0.1)
    q2.push(engagement, 0.1)
  }
  const f1 = JSON.stringify(q1.fragments())
  const f2 = JSON.stringify(q2.fragments())
  assert(f1 === f2, 'two quantizers fed the same sequence must emit identical fragments')
}

// ── 7. nominalEngagement ──

console.log('Testing nominalEngagement...')
{
  assert(approx(nominalEngagement(0, 1), 0), 'zero stepover should give 0')
  assert(approx(nominalEngagement(1, 1), Math.PI / 2), 'stepover = r should give π/2')
  assert(approx(nominalEngagement(2, 1), Math.PI), 'stepover = 2r should give π')
  assert(approx(nominalEngagement(3, 1), Math.PI), 'stepover above 2r should clamp to π')
  assert(approx(nominalEngagement(-1, 1), 0), 'negative stepover should clamp to 0')
  assert(approx(nominalEngagement(1, 2), Math.acos(0.5)), 'stepover 1 with r = 2 should give arccos(0.5)')
  let threw = false
  try {
    nominalEngagement(1, 0)
  } catch {
    threw = true
  }
  assert(threw, 'non-positive tool radius must throw (fail closed)')
}

// ── 8. Quantizer: hysteresis and minimum fragment length ──
//
// Bucket reference (nominal = π/2, slotScale = 0.4, bucket width 0.12):
// engagement 3.0 → scale 0.4; 2.60 → 0.52 (continuous ≈ 0.607, past the
// 0.55 up-switch margin); 2.82 → 0.52 (continuous ≈ 0.523, inside the margin).

console.log('Testing quantizer hysteresis margin...')
{
  const nominal = Math.PI / 2
  const slotScale = 0.4
  // A sample just past the bucket boundary (inside the hysteresis margin)
  // must NOT lift the feed.
  const quantizer = new EngagementFeedQuantizer({ nominal, slotScale, minFragmentLength: 0.4 })
  quantizer.push(3.0, 2.0)
  quantizer.push(2.82, 0.3)
  quantizer.push(3.0, 0.3)
  const fragments = quantizer.fragments()
  assert(fragments.length === 1, `barely-crossing sample must not switch buckets, got ${fragments.length} fragments`)
  assert(approx(fragments[0].scale, 0.4, 1e-12), 'hysteresis must hold the lower bucket')
  assert(approx(fragments[0].distance, 2.6, 1e-9), 'held samples must keep the total distance')

  // A sample clearly past the margin must lift the feed.
  const rising = new EngagementFeedQuantizer({ nominal, slotScale, minFragmentLength: 0.4 })
  rising.push(3.0, 2.0)
  rising.push(2.6, 1.0)
  const risen = rising.fragments()
  assert(risen.length === 2, 'clearly-rising engagement should switch buckets once')
  assert(approx(risen[0].scale, 0.4, 1e-12) && approx(risen[1].scale, 0.52, 1e-12), 'rise should land on the next bucket up')
}

console.log('Testing quantizer does not alternate at a bucket boundary...')
{
  const nominal = Math.PI / 2
  const slotScale = 0.4
  // Oscillate engagement across the 0.4 ↔ 0.52 bucket boundary: the first
  // drop is immediate (conservative), the rise back never happens because the
  // held stretch never reaches the minimum fragment length.
  const quantizer = new EngagementFeedQuantizer({ nominal, slotScale, minFragmentLength: 0.4 })
  quantizer.push(2.627, 1.0)
  for (let i = 0; i < 4; i += 1) {
    quantizer.push(3.027, 0.05)
    quantizer.push(2.627, 0.05)
  }
  quantizer.push(3.027, 2.0)
  const fragments = quantizer.fragments()
  assert(fragments.length === 2, `boundary oscillation must not alternate buckets, got ${fragments.length} fragments`)
  assert(approx(fragments[0].scale, 0.52, 1e-12), 'oscillation must hold the initial higher bucket')
  assert(approx(fragments[1].scale, 0.4, 1e-12), 'the sustained drop must settle at the lower bucket')
  const totalDistance = fragments.reduce((sum, fragment) => sum + fragment.distance, 0)
  assert(approx(totalDistance, 3.4, 1e-9), 'quantizer must preserve total distance')
}

console.log('Testing quantizer minimum fragment length...')
{
  const nominal = Math.PI / 2
  const slotScale = 0.4
  // A short reduced fragment after a full-feed stretch is a genuine short
  // slot: it stays reduced at its own length instead of being merged into the
  // full feed — merging it would hold the slot feed backward into cleared
  // material (the S8 defect). The minimum fragment rule still binds
  // bucket-to-bucket transitions; it just never bridges the 1.0 ceiling.
  const trailing = new EngagementFeedQuantizer({ nominal, slotScale, minFragmentLength: 0.4 })
  trailing.push(0, 2.0)
  trailing.push(Math.PI, 0.1)
  const fragments = trailing.fragments()
  assert(fragments.length === 2, `short trailing slot must stay distinct, got ${fragments.length} fragments`)
  assert(approx(fragments[0].scale, 1, 1e-12) && approx(fragments[0].distance, 2.0, 1e-9), 'the full-feed stretch must stay full feed')
  assert(approx(fragments[1].scale, 0.4, 1e-12) && approx(fragments[1].distance, 0.1, 1e-9), 'the short slot must stay reduced at its own length')
  assert(approx(fragments[0].distance + fragments[1].distance, 2.1, 1e-9), 'total distance must be preserved')

  // A short full-feed gap before a slot is genuine cleared material: it stays
  // full feed instead of being absorbed into the reduced feed.
  const midStream = new EngagementFeedQuantizer({ nominal, slotScale, minFragmentLength: 0.4 })
  midStream.push(0, 0.05)
  midStream.push(Math.PI, 0.05)
  midStream.push(Math.PI, 2.0)
  const merged = midStream.fragments()
  assert(merged.length === 2, `short cleared gap must stay full feed, got ${merged.length} fragments`)
  assert(approx(merged[0].scale, 1, 1e-12) && approx(merged[0].distance, 0.05, 1e-9), 'the cleared gap must stay full feed at its own length')
  assert(approx(merged[1].scale, 0.4, 1e-12) && approx(merged[1].distance, 2.05, 1e-9), 'the slot stretch must stay reduced')

  // Bucket-to-bucket consolidation is unchanged for adjacent rungs: a short
  // reduced fragment one rung above its neighbours still merges into the lower
  // scale (2.7 rad quantizes to 0.52, one rung above the 0.4 slot).
  const between = new EngagementFeedQuantizer({ nominal, slotScale, minFragmentLength: 0.4 })
  between.push(Math.PI, 2.0)
  between.push(2.7, 0.1)
  between.push(Math.PI, 2.0)
  const consolidated = between.fragments()
  assert(consolidated.every((fragment) => approx(fragment.scale, 0.4, 1e-12)), 'bucket-to-bucket merge must resolve toward the lower scale')
  assert(approx(consolidated.reduce((sum, fragment) => sum + fragment.distance, 0), 4.1, 1e-9), 'bucket-to-bucket merge must keep the total distance')

  // S9: a merge that would lower the higher-scale stretch by more than one rung
  // is refused — a fragment entitled to a near-full scale must not be dragged
  // to the slot floor by the slot it merely touches. A 2.0 rad fragment
  // quantizes to 0.76, three rungs above the 0.4 slot, so it keeps its own
  // scale instead of being consolidated into the slot.
  const dragged = new EngagementFeedQuantizer({ nominal, slotScale, minFragmentLength: 0.4 })
  dragged.push(Math.PI, 2.0)
  dragged.push(2.0, 0.1)
  dragged.push(Math.PI, 2.0)
  const kept = dragged.fragments()
  assert(
    kept.some((fragment) => approx(fragment.scale, 0.76, 1e-12) && approx(fragment.distance, 0.1, 1e-9)),
    `a short fragment more than one rung above its neighbours must keep its own scale, got ${JSON.stringify(kept)}`,
  )
}

// ── 8b. Quantizer recovers to full feed through the deadband ──
//
// With 1.0 as the ladder's top rung, a straight run whose engagement sits
// within the deadband of nominal must rise back to full feed after a spike —
// the deadband is the top rung's hysteresis margin. Without this, a pocket
// that ever hits a corner would stay at the slot feed forever, the same
// 12%-slow symptom the cliff defect produces.

console.log('Testing the quantizer rises back to full feed on a deadbanded straight run...')
{
  const nominal = Math.PI / 2
  const slotScale = 0.4
  const quantizer = new EngagementFeedQuantizer({ nominal, slotScale, minFragmentLength: 0.5 })
  quantizer.push(Math.PI, 1.0) // corner spike: slot feed
  quantizer.push(nominal + 4.16e-8, 1.0) // the measured straight-run dust: full feed
  const fragments = quantizer.fragments()
  assert(fragments.length === 2, `spike then straight run should emit two fragments, got ${fragments.length}`)
  assert(approx(fragments[0].scale, 0.4, 1e-12), 'the spike fragment must hold the slot scale')
  assert(approx(fragments[1].scale, 1, 1e-12), 'the deadbanded straight run must rise back to scale 1')
  assert(approx(fragments[1].distance, 1, 1e-9), 'the risen fragment must keep its distance')

  // Just outside the deadband the rise lands on the next rung down, not 1.
  const outside = new EngagementFeedQuantizer({ nominal, slotScale, minFragmentLength: 0.5 })
  outside.push(Math.PI, 1.0)
  outside.push(nominal + 2 * ENGAGEMENT_ESTIMATE_EPSILON, 1.0)
  const stepped = outside.fragments()
  assert(stepped.length === 2, 'a real excess must still step the ladder, not jump to 1')
  assert(stepped[1].scale < 1, 'a real excess above the deadband must not restore full feed')
}

// ── 8c. A long nominal stretch after a link recovers within a bounded distance ──
//
// S6's delayed-recovery defect: a genuine full-width link (180°) drops the
// feed to the slot scale, and a fixed one-tool-diameter minimum fragment
// length held that reduced feed into the following ring until a full tool
// diameter of the ring had been cut at slot feed. With the per-ring minimum,
// the reduced feed must end with the link itself — at most one tool diameter —
// and the long nominal stretch must run at full feed.

console.log('Testing a long nominal stretch after a slot link recovers full feed within a bounded distance...')
{
  const nominal = Math.PI / 2
  const slotScale = 0.4
  const quantizer = new EngagementFeedQuantizer({ nominal, slotScale, minFragmentLength: 6 })
  // The link leaves a short ring (perimeter 4.8 mm → minimum fragment 0.6 mm)
  // and enters a long ring whose minimum is one tool diameter.
  quantizer.setMinFragmentLength(0.6)
  quantizer.push(Math.PI, 4.8)
  quantizer.setMinFragmentLength(6)
  let remaining = 130
  while (remaining > 1e-9) {
    const step = Math.min(3, remaining)
    quantizer.push(nominal, step)
    remaining -= step
  }
  const fragments = quantizer.fragments()
  assert(fragments.length === 2, `link then nominal stretch should emit two fragments, got ${fragments.length}`)
  assert(approx(fragments[0].scale, 0.4, 1e-12), 'the link fragment must hold the slot scale')
  assert(approx(fragments[1].scale, 1, 1e-12), 'the nominal stretch must recover to full feed')
  assert(
    fragments[0].distance <= 6 + 1e-9,
    `the reduced feed must not extend past the link by more than one tool diameter, got ${fragments[0].distance.toFixed(2)}`,
  )
}

// ── 9. Telemetry accumulator ──

console.log('Testing engagement telemetry...')
{
  const accumulator = new EngagementTelemetryAccumulator(Math.PI / 2)
  accumulator.addSample(1.0, 4)
  accumulator.addSample(1.2, 2)
  accumulator.addSample(2.5, 2)
  accumulator.addSample(3.0, 2)
  const telemetry = accumulator.toTelemetry()
  assert(approx(telemetry.maxEngagement, 3.0), 'max engagement should be the largest sample')
  // Total distance 10; 95% = 9.5 → cumulative 4, 6, 8, 10 crosses at the last sample.
  assert(approx(telemetry.p95Engagement, 3.0), 'p95 should be the sample where cumulative distance crosses 95%')
  // Above nominal (π/2 ≈ 1.571): samples 2.5 and 3.0 → distance 4.
  assert(approx(telemetry.distanceAboveNominal, 4), 'distance above nominal should sum only the above-nominal samples')
  assert(approx(telemetry.totalCutDistance, 10), 'total cut distance should sum all sample distances')

  const p95Mid = new EngagementTelemetryAccumulator(Math.PI / 2)
  p95Mid.addSample(0.5, 3)
  p95Mid.addSample(2.0, 7)
  // 95% of 10 = 9.5 → crosses during the second sample → p95 = 2.0.
  assert(approx(p95Mid.toTelemetry().p95Engagement, 2.0), 'p95 should reflect distance weighting, not sample count')

  const empty = new EngagementTelemetryAccumulator(Math.PI / 2).toTelemetry()
  assert(approx(empty.maxEngagement, Math.PI), 'empty accumulator max must be π (no evidence → full engagement)')
  assert(approx(empty.p95Engagement, Math.PI), 'empty accumulator p95 must be π')
  assert(approx(empty.distanceAboveNominal, 0), 'empty accumulator distance above nominal must be 0')
  assert(approx(empty.totalCutDistance, 0), 'empty accumulator total distance must be 0')
}

// ── 10. Degenerate input resolves toward more engagement ──

console.log('Testing degenerate inputs...')
{
  const index = new SweptMaterialIndex(1)
  assert(approx(index.engagementAt(1, 1, 0, 0), Math.PI), 'zero-length direction should report full engagement')
  assert(approx(index.engagementAt(Number.NaN, 1, 1, 0), Math.PI), 'non-finite query coordinate should report full engagement')
  assert(approx(index.engagementAt(1, 1, Number.POSITIVE_INFINITY, 0), Math.PI), 'non-finite direction should report full engagement')

  // A zero-length segment sweeps nothing: conservative is to skip it entirely.
  index.addSweptSegment(2, 2, 2, 2)
  assert(approx(index.engagementAt(2, 2, 1, 0), Math.PI), 'zero-length swept segment must not reduce engagement')

  let threw = false
  try {
    new SweptMaterialIndex(0)
  } catch {
    threw = true
  }
  assert(threw, 'non-positive tool radius must throw (fail closed)')
  threw = false
  try {
    new SweptMaterialIndex(Number.NaN)
  } catch {
    threw = true
  }
  assert(threw, 'NaN tool radius must throw (fail closed)')
}

// ── 11. Capsule model matches a fine disc-chain reference ──
//
// The equivalence proof for the capsule rewrite: the same swept segments are
// graded twice — once by the production estimator (one exact capsule per
// segment) and once by DiscChainReference (a fine disc chain). The reference
// under-covers the true capsule by a lens of radial depth r − √(r² − (s/2)²)
// between consecutive discs; at s = r/200 its worst-case engagement
// over-report is 2·arcsin(s/(4r)) ≈ 0.0025 rad, so the capsule estimate must
// agree within 0.005 rad. Segments and queries come from a fixed-seed LCG —
// never Math.random, per the determinism rules.

console.log('Testing capsule model against a fine disc-chain reference...')
{
  const r = 1
  const rand = makeLcg(0x498)
  const segments: Array<[number, number, number, number]> = []
  for (let i = 0; i < 12; i += 1) {
    const ax = (rand() - 0.5) * 8
    const ay = (rand() - 0.5) * 4
    const length = 0.2 + rand() * 3
    const angle = rand() * 2 * Math.PI
    segments.push([ax, ay, ax + length * Math.cos(angle), ay + length * Math.sin(angle)])
  }
  const capsules = new SweptMaterialIndex(r)
  const reference = new DiscChainReference(r, r / 200)
  for (const segment of segments) {
    capsules.addSweptSegment(...segment)
    reference.addSweptSegment(...segment)
  }
  let maxError = 0
  for (let i = 0; i < 50; i += 1) {
    const qx = (rand() - 0.5) * 10
    const qy = (rand() - 0.5) * 6
    const angle = rand() * 2 * Math.PI
    const got = capsules.engagementAt(qx, qy, Math.cos(angle), Math.sin(angle))
    const want = reference.engagementAt(qx, qy, Math.cos(angle), Math.sin(angle))
    const error = Math.abs(got - want)
    if (error > maxError) maxError = error
    assert(
      error <= 0.005,
      `capsule estimate ${got.toFixed(5)} must match the disc-chain reference ${want.toFixed(5)} within 0.005 rad at query ${i}`,
    )
  }
  console.log(`  (max capsule/reference error ${maxError.toFixed(5)} rad, reference bias bound 0.0025 rad)`)
}

// ── 12. Index size is O(segments), not O(path length) ──
//
// The complexity fix, asserted on entry count — never wall clock (AGENTS.md
// § Build & Verify — wall-clock assertions cost #383 and #386). The former
// disc chain stored ~2500 discs × 9 cells = 22,500 entries for one 100·r
// segment, which made generation 9×–40× slower than legacy. The capsule
// index stores one entry per cell the sweep's own extent covers.

console.log('Testing the index stores a small per-segment constant of entries...')
{
  const r = 1
  const index = new SweptMaterialIndex(r)
  index.addSweptSegment(-50 * r, 0, 50 * r, 0) // one segment, length 100·r
  const entries = index.storedEntryCount()
  // Derivation: the axis-aligned centreline crosses ceil(100r / 2r) + 1 = 51
  // cells (cell size 2r), and the radius-r tube dilates each crossed cell to
  // its 3-row neighbourhood, so ≤ 3 × 51 = 153 entries — a small constant
  // per segment, independent of path length beyond the cells it actually
  // covers.
  assert(entries <= 160, `one 100·r segment must store ≤ 160 entries, got ${entries}`)
  assert(entries > 0, 'a 100·r segment must actually be indexed')

  // The bound scales with the number of segments: six axis-aligned segments
  // of mixed length (≤ 100r each, parallel walls spaced 5r apart so their
  // extents barely overlap) stay under 160 entries per segment.
  const mixed = new SweptMaterialIndex(r)
  const lengths = [100, 40, 70, 5, 90, 20]
  for (let i = 0; i < lengths.length; i += 1) {
    mixed.addSweptSegment(0, 5 * r * i, lengths[i] * r, 5 * r * i)
  }
  assert(
    mixed.storedEntryCount() <= 160 * lengths.length,
    `entries must be bounded by a small constant × segment count, got ${mixed.storedEntryCount()} for ${lengths.length} segments`,
  )
}

// ── 13. Early capsule rejection: far capsules never reach the trig path ──
//
// The capsule trig (two endpoint discs + the rectangle body, each an
// acos/asin block) is gated by an exact squared point-to-segment distance
// test. The measured rect-round regression (26× → 203.7× legacy on thousands
// of sub-millimetre segments) is exactly the case this test models: a dense
// cluster of short segments whose cell the query scans but whose capsules are
// all farther than 2r away. Assert on the counted work — capsules scanned vs
// capsules reaching the trig path — never on wall clocks (AGENTS.md § Build &
// Verify).

console.log('Testing the early rejection gates the trig path...')
{
  const r = 1
  const rand = makeLcg(0x51)
  const dense = new SweptMaterialIndex(r)
  const segmentCount = 400
  // All segments inside the single cell column 1 (x ∈ [2r, 3r]), row 0:
  // short tessellated strokes like a rounded-corner polyline contributes.
  for (let i = 0; i < segmentCount; i += 1) {
    const ax = 2 * r + (rand() * 0.9 + 0.05) * r
    const ay = (rand() - 0.5) * r
    const angle = rand() * 2 * Math.PI
    const length = 0.25 * r
    dense.addSweptSegment(ax, ay, ax + length * Math.cos(angle), ay + length * Math.sin(angle))
  }
  // Query in the adjacent column: its 3×3 scan covers the cluster's cell, so
  // every capsule is scanned (a capsule is stored once per cell its extent
  // covers plus each cell's 8 neighbours, hence ≥ segmentCount scans) — and
  // every capsule is beyond 2r (the cluster ends at 3.25r, the query sits at
  // 5.5r), so none may reach the trig path.
  const farEngagement = dense.engagementAt(5.5 * r, 0, 1, 0)
  const farStats = dense.queryStats()
  assert(farStats.capsulesScanned >= segmentCount, `the far query must scan at least all ${segmentCount} capsules, got ${farStats.capsulesScanned}`)
  assert(farStats.capsulesTrigTested === 0, 'no capsule beyond 2r may reach the trig path')
  assert(approx(farEngagement, Math.PI), 'far from the cluster the engagement must still be exactly π')

  // A query inside the cluster does reach the trig path and sees the coverage.
  const nearEngagement = dense.engagementAt(2.5 * r, 0, 1, 0)
  const nearStats = dense.queryStats()
  assert(nearStats.capsulesTrigTested > farStats.capsulesTrigTested, 'the near query must push capsules past the rejection')
  assert(nearEngagement < Math.PI, 'the near query must see the cluster coverage')
  console.log(
    `  (scanned ${nearStats.capsulesScanned}, trig-tested ${nearStats.capsulesTrigTested}; far query tested ${farStats.capsulesTrigTested}/${farStats.capsulesScanned})`,
  )
}

// ── Summary ──

console.log(`\nengagement.ts tests: ${passed} passed, ${failed} failed, ${passed + failed} total`)
if (failed > 0) process.exitCode = 1
