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
  // Query x positions deliberately include phases both on and between the
  // disc-chain centres; the between-disc phase bounds the chain error.
  const xPositions = [0.31, 0.77, 1.13, 0.32]
  const index = wallIndex(r, 10 * r)
  const depthCases = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75].map((f) => f * r)
  for (const a_e of depthCases) {
    const expected = Math.acos(Math.min(1, Math.max(-1, 1 - a_e / r)))
    const measured = wallEngagementAt(index, a_e, xPositions)
    assert(
      Math.abs(measured - expected) <= 0.03,
      `wall identity at a_e = ${a_e}r: expected ${expected.toFixed(4)}, measured ${measured.toFixed(4)}`,
    )
  }
  // a_e = 2r: the cutter just grazes the prior kerf — full slot π, exactly.
  const fullSlot = wallEngagementAt(index, 2 * r, xPositions)
  assert(Math.abs(fullSlot - Math.PI) <= 0.001, `a_e = 2r should be π exactly, measured ${fullSlot.toFixed(4)}`)

  // D = 0 special case: the query centre exactly on a prior disc centre (the
  // cutter circle lies inside the disc, everything covered) must give exactly
  // 0 — for any motion direction, since the whole circle is covered.
  const onDiscIndex = new SweptMaterialIndex(r)
  onDiscIndex.addSweptSegment(-1, 0, 1, 0)
  // Recompute a disc centre with the same expression the chain uses.
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
      Math.abs(measured - expected) <= 0.03,
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
  // A trailing short fragment gets merged into its lower-scale neighbour.
  const quantizer = new EngagementFeedQuantizer({ nominal, slotScale, minFragmentLength: 0.4 })
  quantizer.push(0, 2.0)
  quantizer.push(Math.PI, 0.1)
  const fragments = quantizer.fragments()
  assert(fragments.length === 1, `short trailing fragment must be merged away, got ${fragments.length} fragments`)
  assert(approx(fragments[0].distance, 2.1, 1e-9), 'merged fragment must keep the total distance')
  assert(approx(fragments[0].scale, 0.4, 1e-12), 'the merge must resolve toward the lower (spike) scale, never restore the full feed')

  // A mid-stream short fragment is also merged away at the lower scale.
  const midStream = new EngagementFeedQuantizer({ nominal, slotScale, minFragmentLength: 0.4 })
  midStream.push(0, 0.05)
  midStream.push(Math.PI, 0.05)
  midStream.push(Math.PI, 2.0)
  const merged = midStream.fragments()
  assert(merged.length === 1, 'short mid-stream fragment must be merged away')
  assert(approx(merged[0].scale, 0.4, 1e-12), 'mid-stream merge must take the lower scale')
  assert(approx(merged[0].distance, 2.1, 1e-9), 'mid-stream merge must keep the total distance')
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

// ── Summary ──

console.log(`\nengagement.ts tests: ${passed} passed, ${failed} failed, ${passed + failed} total`)
if (failed > 0) process.exitCode = 1
