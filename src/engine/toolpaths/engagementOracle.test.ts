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
 * Independent oracle for the cutter engagement estimator (issue #498).
 *
 * `engagement.test.ts` checks the estimator against its own stated contract.
 * This file checks it against a *different algorithm*: where the production
 * code computes closed-form angular intervals and unions them, the oracle here
 * brute-force samples the leading semicircle and tests each sample point
 * against prior swept geometry by direct distance. Same question, unrelated
 * implementation, so the two cannot share a bug.
 *
 * That separation is the point, and it is load-bearing. During the #498 review
 * an estimator that passed its own suite still mispriced every straight run in
 * a real pocket; agreement with an independently written oracle is what makes
 * "the estimator is correct" a falsifiable claim rather than a restatement of
 * its own tests.
 *
 * The tolerances below are deliberately loose enough to admit any *conservative*
 * modelling of prior sweeps (a model that under-covers prior material reports
 * more engagement, which is the safe direction) while still rejecting a wrong
 * magnitude, a wrong sign, or a wrong domain.
 */

import { SweptMaterialIndex, nominalEngagement } from './engagement'

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

/**
 * Oracle: the measure of the leading semicircle NOT within `radius` of any
 * prior swept segment, found by dense sampling and direct point-segment
 * distance. Deliberately naive — its value is that it shares no code path with
 * the estimator.
 */
function oracleEngagement(
  cx: number,
  cy: number,
  dirX: number,
  dirY: number,
  radius: number,
  segments: Array<[number, number, number, number]>,
  samples = 20_000,
): number {
  const base = Math.atan2(dirY, dirX)
  let uncovered = 0
  for (let index = 0; index < samples; index += 1) {
    const theta = base - Math.PI / 2 + (Math.PI * (index + 0.5)) / samples
    const px = cx + radius * Math.cos(theta)
    const py = cy + radius * Math.sin(theta)
    let covered = false
    for (const [ax, ay, bx, by] of segments) {
      const dx = bx - ax
      const dy = by - ay
      const lengthSq = dx * dx + dy * dy
      const t = lengthSq > 0
        ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq))
        : 0
      const vx = ax + dx * t - px
      const vy = ay + dy * t - py
      if (vx * vx + vy * vy <= radius * radius) {
        covered = true
        break
      }
    }
    if (!covered) uncovered += 1
  }
  return (uncovered / samples) * Math.PI
}

function indexOf(radius: number, segments: Array<[number, number, number, number]>): SweptMaterialIndex {
  const index = new SweptMaterialIndex(radius)
  for (const [ax, ay, bx, by] of segments) index.addSweptSegment(ax, ay, bx, by)
  return index
}

/** Deterministic LCG — never `Math.random`, so a failure is always reproducible. */
function lcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}

const RADIUS = 3
/** Admits a conservative model's under-coverage; rejects a wrong magnitude. */
const ORACLE_TOLERANCE = 0.05

// ── 1. The analytic identity, independently reproduced ──────────────────────

console.log('Testing the wall identity against the analytic wrap angle...')
for (const ratio of [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]) {
  const radialDepth = ratio * RADIUS
  const segments: Array<[number, number, number, number]> = [
    [-40 * RADIUS, radialDepth, 40 * RADIUS, radialDepth],
  ]
  const measured = indexOf(RADIUS, segments).engagementAt(0, 0, 1, 0)
  const analytic = Math.acos(Math.max(-1, Math.min(1, 1 - radialDepth / RADIUS)))
  assert(
    Math.abs(measured - analytic) <= ORACLE_TOLERANCE,
    `a_e = ${ratio}r: estimator ${measured.toFixed(4)} vs analytic ${analytic.toFixed(4)}`,
  )
}

// ── 2. Agreement with the oracle on geometry that has no closed form ─────────

console.log('Testing agreement with the brute-force oracle on pseudo-random geometry...')
{
  const random = lcg(20260814)
  for (let trial = 0; trial < 40; trial += 1) {
    const segments: Array<[number, number, number, number]> = []
    for (let count = 0; count < 4; count += 1) {
      const ax = (random() - 0.5) * 8 * RADIUS
      const ay = (random() - 0.5) * 8 * RADIUS
      const angle = random() * Math.PI * 2
      const length = RADIUS * (0.5 + random() * 6)
      segments.push([ax, ay, ax + Math.cos(angle) * length, ay + Math.sin(angle) * length])
    }
    const heading = random() * Math.PI * 2
    const dirX = Math.cos(heading)
    const dirY = Math.sin(heading)
    const measured = indexOf(RADIUS, segments).engagementAt(0, 0, dirX, dirY)
    const expected = oracleEngagement(0, 0, dirX, dirY, RADIUS, segments)
    assert(
      Math.abs(measured - expected) <= ORACLE_TOLERANCE,
      `trial ${trial}: estimator ${measured.toFixed(4)} vs oracle ${expected.toFixed(4)}`,
    )
  }
}

// ── 2b. Grid boundaries and long sweeps keep the exact candidate domain ─────

console.log('Testing grid-boundary and long-diagonal candidate coverage...')
{
  const cases = [
    {
      name: 'vertical sweep on a cell boundary',
      segments: [[0, -8 * RADIUS, 0, 8 * RADIUS]] as Array<[number, number, number, number]>,
      query: [1.5 * RADIUS, 0, 1, 0] as const,
    },
    {
      name: 'long diagonal crossing many cells',
      segments: [[-8 * RADIUS, -8 * RADIUS, 8 * RADIUS, 8 * RADIUS]] as Array<[number, number, number, number]>,
      query: [0.8 * RADIUS, -0.2 * RADIUS, 0.6, -0.8] as const,
    },
    {
      name: 'near-endpoint sweep across a cell boundary',
      segments: [[-7 * RADIUS, 0.75 * RADIUS, 0.25 * RADIUS, 0.75 * RADIUS]] as Array<[number, number, number, number]>,
      query: [1.1 * RADIUS, 0, 1, 0] as const,
    },
  ]
  for (const fixture of cases) {
    const [cx, cy, dirX, dirY] = fixture.query
    const measured = indexOf(RADIUS, fixture.segments).engagementAt(cx, cy, dirX, dirY)
    const expected = oracleEngagement(cx, cy, dirX, dirY, RADIUS, fixture.segments)
    assert(
      Math.abs(measured - expected) <= ORACLE_TOLERANCE,
      `${fixture.name}: estimator ${measured.toFixed(4)} vs oracle ${expected.toFixed(4)}`,
    )
  }
}

// ── 3. Domain invariants the oracle also has to satisfy ─────────────────────

console.log('Testing the domain invariants (virgin material, own trail, out of range)...')
{
  const empty = new SweptMaterialIndex(RADIUS)
  assert(
    Math.abs(empty.engagementAt(0, 0, 1, 0) - Math.PI) <= 1e-9,
    'virgin material must report full engagement, not zero — inverting this inverts the feature',
  )

  const farAway: Array<[number, number, number, number]> = [[-100, 50, 100, 50]]
  assert(
    Math.abs(indexOf(RADIUS, farAway).engagementAt(0, 0, 1, 0) - Math.PI) <= 1e-9,
    'a prior sweep beyond one tool diameter must not reduce engagement',
  )

  // A kerf directly behind the cutter is its own trail. The leading-semicircle
  // domain excludes it structurally, so a straight slot stays fully engaged
  // however far it has already run — no own-trail heuristic required.
  const trail: Array<[number, number, number, number]> = [[-40 * RADIUS, 0, -0.01, 0]]
  const trailing = indexOf(RADIUS, trail).engagementAt(0, 0, 1, 0)
  assert(
    Math.abs(trailing - Math.PI) <= ORACLE_TOLERANCE,
    `a straight slot trailing its own kerf must stay fully engaged, measured ${trailing.toFixed(4)}`,
  )
}

// ── 4. Concentric ring corners spike; the oracle agrees ─────────────────────

console.log('Testing that a concentric ring corner exceeds its straight run...')
{
  // Two nested square rings in the generator's inner-first order: the inner
  // ring is already cut when the outer one runs. Measured on the real pattern,
  // corners reach ~168 degrees against a ~78 degree straight run, and #499
  // exists because of it — so this relationship is worth pinning down.
  const stepover = 2.4
  const inner = 20
  const outer = inner + stepover
  const ring = (half: number): Array<[number, number, number, number]> => [
    [-half, -half, half, -half],
    [half, -half, half, half],
    [half, half, -half, half],
    [-half, half, -half, -half],
  ]
  const index = indexOf(RADIUS, ring(inner))

  const straight = index.engagementAt(0, -outer, 1, 0)
  // Measured APPROACHING the corner, still travelling along the incoming edge.
  // Direction matters more than position here: once the tool has turned, the
  // inner kerf lies abeam again and engagement falls back to nominal. Arriving
  // at the corner it is heading into the wedge between the two rings' corners,
  // and the inner kerf has dropped behind the leading semicircle — which is
  // exactly why the spike is a real cutting hazard rather than a sampling
  // artifact, and why probing the outgoing direction misses it entirely.
  const corner = index.engagementAt(outer, -outer, 1, 0)
  const nominal = nominalEngagement(stepover, RADIUS)

  assert(
    Math.abs(straight - nominal) <= ORACLE_TOLERANCE,
    `a straight ring run should sit at the nominal wrap angle: ${straight.toFixed(4)} vs ${nominal.toFixed(4)}`,
  )
  assert(
    corner > straight + 0.3,
    `a ring corner must exceed its own straight run by a real margin: ${corner.toFixed(4)} vs ${straight.toFixed(4)}`,
  )
  assert(
    Math.abs(corner - oracleEngagement(outer, -outer, 1, 0, RADIUS, ring(inner))) <= ORACLE_TOLERANCE,
    'the corner spike must also be what the independent oracle measures',
  )

  // Falsifiability: with the inner ring absent there is nothing to be more
  // engaged *than*, so the spike assertion above must not hold vacuously.
  const noPrior = new SweptMaterialIndex(RADIUS)
  assert(
    !(noPrior.engagementAt(outer, -outer, 1, 0) > noPrior.engagementAt(0, -outer, 1, 0) + 0.3),
    'the corner-spike assertion must fail when there is no prior ring — otherwise it proves nothing',
  )
}

// ── Summary ──

console.log(`\nengagementOracle tests: ${passed} passed, ${failed} failed, ${passed + failed} total`)
if (failed > 0) process.exitCode = 1
