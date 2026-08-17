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
 * Engagement-limited path generator acceptance (issue #499, slice S3): the
 * reusable A→B generator whose measured engagement stays at or below a
 * bound, with the corner unwind as its first caller. Nothing here is wired
 * into the pocket generator — the module is inert, so this suite cannot
 * move machine output; it proves the generator is correct the day it is
 * wired (slice S5).
 *
 * ## Scenario — the #498 anchor corner
 *
 * The pack's rectangular fixture at d = 6, stepover 0.4 (the 60 mm square):
 * the anchor ring is the emitted ring at half-size 24.6, its inner
 * neighbours (half ≤ 22.2) are swept into a `SweptMaterialIndex` — the
 * production per-level index (every ring segment emitted before the anchor
 * ring, links excluded), under which the #498 figures were measured. The
 * corner under test is the emitted vertex at (24.6, 24.6); the test derives
 * the approach/departure directions from the emitted polyline and pins them
 * (approach south, departure west — conventional pockets wind positively in
 * the internal coordinates, so the interior is on the left of travel).
 *
 * ## Acceptance mapping (issue #499 / the S3 handoff)
 *
 * - *Peak engagement through the corner drops below the straight-wall value
 *   plus a stated margin* — test 3: the excursion's every sample (measured
 *   by the module, and re-measured independently at d/4 in test 4) sits at
 *   or below `nominal + ENGAGEMENT_MARGIN_ABOVE_NOMINAL_RAD`; the same
 *   assertion run on the suppressed excursion (the direct corner turn) must
 *   fail — it does, at the #498 anchor figure 2.9404 rad.
 * - *Every emitted excursion point lies on the interior side* — test 5: the
 *   two inboard half-planes of the corner, in the general side-normal form.
 * - *Flipping the direction sign must fail a test* — test 6 (the module's
 *   side-vs-turn assertion rejects a flipped side) and the development
 *   mutation check (flipping the module's sign mapping fails test 3).
 * - *Re-entry engagement is bounded, not merely lower* — test 7: the final
 *   sample is B, and its engagement is at most
 *   `nominal + ENGAGEMENT_MARGIN_ABOVE_NOMINAL_RAD`; it measures the
 *   straight-wall value to ~1e-7.
 * - *Deterministic* — test 8.
 * - *Reusable, not bespoke* — tests 10–12 exercise the core on non-corner
 *   inputs (a cleared band, the straight-chord fallback, fail-closed on a
 *   tight bound) with no corner geometry involved.
 * - *Every exported threshold constant has a test that bites* — tests 9a/9b
 *   (premise brackets), each mutation-checked during development.
 *
 * ## The pack scan (tests 13–14) — the deliverable
 *
 * Every qualifying corner of every fixture is handed to `cornerUnwindPath`
 * and the verdicts are reported. The measured reality, pinned here:
 *
 * - Rectangular corners unwind exactly when the ring's half-size reaches
 *   10.2 mm: the re-entry disc (centre 2d = 12 mm past the corner) must fit
 *   inside the inner kerf's capsule body, which requires
 *   `2·half ≥ l + r + s = 17.4` — rings at half 7.8 fail closed, 10.2 pass.
 * - Every acute-corner excursion is declined: the apex wedge must be cut at
 *   ~its own angle (measured 1.99 rad) no matter the approach, and the base
 *   corners' exit approach reads 1.56 rad — both above the stated bound.
 *   The decline is the fail-closed path, not a defect: those corners keep
 *   the legacy turn at slot feed (the issue's fallback).
 * - `longNeck`, `islandPinch`, `multiSection`, `largeComplex` split between
 *   unwinds and fail-closed declines on the same geometric basis; counts are
 *   reported, and the per-verdict engagement invariants are asserted.
 *
 * Run with: ./node_modules/.bin/tsx src/engine/toolpaths/engagementLimitedPath.test.ts
 */

import { bestCpuMs } from '../../test/cpuRatio'
import { buildPocketFixturePack, type PocketFixtureEntry } from '../../test/pocketFixturePack'
import {
  SweptMaterialIndex,
  nominalEngagement,
} from './engagement'
import { generatePocketToolpath } from './pocket'
import type { ToolpathMove, ToolpathPoint } from './types'
import {
  qualifyCorners,
  type CornerQualifierPoint,
  type CornerQualifierRing,
} from './cornerQualifier'
import {
  cornerUnwindPath,
  engagementLimitedPath,
  CORNER_LEAD_IN_TOOL_DIAMETERS,
  ENGAGEMENT_MARGIN_ABOVE_NOMINAL_RAD,
  type EngagementLimitedPathResult,
  type EngagementLimitedPathSample,
} from './engagementLimitedPath'

// ── Assertion scaffolding (same style as the neighbouring engine tests) ────

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`   ✓ ${name}`)
  } catch (error: unknown) {
    failed += 1
    console.log(`   ✗ ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// ── Measurement parameters ─────────────────────────────────────────────────

/** The pack's nominal configuration: the #498 anchor tool/stepover. */
const PACK_OPTIONS = { toolDiameter: 6, stepover: 0.4 }

/** The analytic straight-wall engagement at the anchor point. */
const NOMINAL = nominalEngagement(2.4, 3)

/** The #498 anchor corner figure (60 mm square, r = 3, stepover 2.4). */
const ANCHOR_DIRECT_PEAK = 2.9404

/** The anchor corner's direct excess over the straight-wall value. */
const ANCHOR_DIRECT_EXCESS = ANCHOR_DIRECT_PEAK - NOMINAL

/**
 * The worst measured excursion excess above nominal among the pack's
 * ACCEPTED corners (1.5002 − 1.3694 on `largeComplex`; the anchor corner
 * measures 0.1213). Pinned from measurement so the margin's premise test
 * cannot silently become vacuous under a retune.
 */
const WORST_ACCEPTED_EXCESS = 0.1308

/** The anchor excursion's measured peak excess (1.4907 − 1.3694), reported. */
const ANCHOR_EXCURSION_EXCESS = 0.1213

/** Engagement bound of every corner excursion: the module's stated margin. */
const EXCURSION_BOUND = NOMINAL + ENGAGEMENT_MARGIN_ABOVE_NOMINAL_RAD

/** Sample step for replay measurements: d/4, the slice-1 resolution. */
const SAMPLE_STEP = PACK_OPTIONS.toolDiameter * 0.25

// ── Ring reconstruction ────────────────────────────────────────────────────

const pointKey = (point: Pick<ToolpathPoint, 'x' | 'y'>): string =>
  `${Math.round(point.x * 1e6)},${Math.round(point.y * 1e6)}`

/**
 * Reconstruct the emitted rings of one level: every closed loop of the cut
 * move stream is one ring, in emission order — the same closure detection
 * as the corner-qualifier suite.
 */
function reconstructRings(moves: ToolpathMove[]): Array<{ points: CornerQualifierPoint[]; level: number }> {
  const levels: Array<{ z: number; moves: Array<{ from: ToolpathPoint; to: ToolpathPoint }> }> = []
  for (const move of moves) {
    if (move.kind !== 'cut') continue
    const level = levels.find((candidate) => candidate.z === move.from.z)
    if (level) {
      level.moves.push({ from: move.from, to: move.to })
    } else {
      levels.push({ z: move.from.z, moves: [{ from: move.from, to: move.to }] })
    }
  }
  const rings: Array<{ points: CornerQualifierPoint[]; level: number }> = []
  for (const level of levels) {
    let openPath: CornerQualifierPoint[] = []
    const openIndex = new Map<string, number>()
    for (const move of level.moves) {
      const from = { x: move.from.x, y: move.from.y }
      const to = { x: move.to.x, y: move.to.y }
      if (openPath.length === 0) {
        openPath.push(from)
        openIndex.set(pointKey(from), 0)
      }
      const toKey = pointKey(to)
      const revisit = openIndex.get(toKey)
      if (revisit !== undefined) {
        const points = openPath.slice(revisit)
        const first = points[0]
        const last = points[points.length - 1]
        if (Math.hypot(last.x - first.x, last.y - first.y) <= 1e-9) points.pop()
        if (points.length >= 3) rings.push({ points, level: level.z })
        openPath = []
        openIndex.clear()
      } else {
        openPath.push(to)
        openIndex.set(toKey, openPath.length - 1)
      }
    }
  }
  return rings
}

/** Ring half-extent, matching the qualifier's selection measure. */
function ringHalfExtent(points: ReadonlyArray<CornerQualifierPoint>): number {
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const point of points) {
    minX = Math.min(minX, point.x)
    maxX = Math.max(maxX, point.x)
    minY = Math.min(minY, point.y)
    maxY = Math.max(maxY, point.y)
  }
  return Math.max((maxX - minX) / 2, (maxY - minY) / 2)
}

/** Signed shoelace area of the ring; its sign is the winding direction. */
function ringWinding(points: ReadonlyArray<CornerQualifierPoint>): number {
  let sum = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    sum += current.x * next.y - next.x * current.y
  }
  return sum
}

// ── Anchor scenario construction ───────────────────────────────────────────

interface AnchorScenario {
  /** The anchor ring's polyline (half-size 24.6). */
  ring: CornerQualifierPoint[]
  /** The corner vertex under test. */
  vertex: CornerQualifierPoint
  /** Unit approach direction INTO the vertex, from the emitted polyline. */
  approach: CornerQualifierPoint
  /** Unit departure direction OUT of the vertex, from the emitted polyline. */
  departure: CornerQualifierPoint
  /** Interior side, derived from the emitted ring's winding sign. */
  side: 'left' | 'right'
  /** Production per-level index: every inner ring segment, links excluded. */
  index: SweptMaterialIndex
  /** The excursion result under test. */
  excursion: EngagementLimitedPathResult
  /** The direct (suppressed) corner turn, sampled at d/4. */
  directSamples: Array<{ x: number; y: number; directionX: number; directionY: number; engagement: number }>
}

function buildAnchorScenario(): AnchorScenario {
  const pack = buildPocketFixturePack(PACK_OPTIONS)
  const entry = pack.find((candidate) => candidate.id === 'rectangular')
  if (!entry) throw new Error('rectangular fixture missing from the pack')
  const operation = entry.project.operations.find((candidate) => candidate.kind === 'pocket')
  if (!operation) throw new Error('rectangular fixture must contain a pocket operation')
  const result = generatePocketToolpath(entry.project, { ...operation, pocketFeedReduction: 'engagement' })
  const rings = reconstructRings(result.moves)
  const anchorRing = rings.find((ring) => Math.abs(ringHalfExtent(ring.points) - 24.6) <= 0.05)
  if (!anchorRing) throw new Error('no emitted ring at half-size 24.6 found')
  const index = new SweptMaterialIndex(PACK_OPTIONS.toolDiameter / 2)
  for (const ring of rings) {
    if (ring.level !== anchorRing.level) continue
    if (ringHalfExtent(ring.points) >= 24.6 - 1e-6) continue
    for (let k = 0; k < ring.points.length; k += 1) {
      const a = ring.points[k]
      const b = ring.points[(k + 1) % ring.points.length]
      if (Math.hypot(b.x - a.x, b.y - a.y) > 1e-9) index.addSweptSegment(a.x, a.y, b.x, b.y)
    }
  }
  let cornerIndex = -1
  let bestDistance = Number.POSITIVE_INFINITY
  anchorRing.points.forEach((point, i) => {
    const distance = Math.hypot(point.x - 24.6, point.y - 24.6)
    if (distance < bestDistance) {
      bestDistance = distance
      cornerIndex = i
    }
  })
  const count = anchorRing.points.length
  const previous = anchorRing.points[(cornerIndex - 1 + count) % count]
  const vertex = anchorRing.points[cornerIndex]
  const next = anchorRing.points[(cornerIndex + 1) % count]
  const approachLength = Math.hypot(vertex.x - previous.x, vertex.y - previous.y)
  const departureLength = Math.hypot(next.x - vertex.x, next.y - vertex.y)
  const approach = {
    x: (vertex.x - previous.x) / approachLength,
    y: (vertex.y - previous.y) / approachLength,
  }
  const departure = {
    x: (next.x - vertex.x) / departureLength,
    y: (next.y - vertex.y) / departureLength,
  }
  const side = ringWinding(anchorRing.points) > 0 ? 'left' : 'right'
  const excursion = cornerUnwindPath({
    cornerX: vertex.x,
    cornerY: vertex.y,
    approachX: approach.x,
    approachY: approach.y,
    departureX: departure.x,
    departureY: departure.y,
    side,
    toolDiameter: PACK_OPTIONS.toolDiameter,
    nominalEngagement: NOMINAL,
    engagementAt: (x, y, dirX, dirY): number => index.engagementAt(x, y, dirX, dirY),
  })

  // The suppressed excursion: the direct corner turn A → V → B, sampled at d/4.
  const leadIn = CORNER_LEAD_IN_TOOL_DIAMETERS * PACK_OPTIONS.toolDiameter
  const directSamples: AnchorScenario['directSamples'] = []
  const pushSample = (x: number, y: number, directionX: number, directionY: number): void => {
    directSamples.push({
      x,
      y,
      directionX,
      directionY,
      engagement: index.engagementAt(x, y, directionX, directionY),
    })
  }
  const a = { x: vertex.x - leadIn * approach.x, y: vertex.y - leadIn * approach.y }
  const b = { x: vertex.x + leadIn * departure.x, y: vertex.y + leadIn * departure.y }
  const approachSteps = Math.max(1, Math.ceil(leadIn / SAMPLE_STEP))
  for (let step = 0; step <= approachSteps; step += 1) {
    const t = step / approachSteps
    pushSample(a.x + (vertex.x - a.x) * t, a.y + (vertex.y - a.y) * t, approach.x, approach.y)
  }
  const departureSteps = Math.max(1, Math.ceil(leadIn / SAMPLE_STEP))
  for (let step = 1; step <= departureSteps; step += 1) {
    const t = step / departureSteps
    pushSample(vertex.x + (b.x - vertex.x) * t, vertex.y + (b.y - vertex.y) * t, departure.x, departure.y)
  }
  return { ring: anchorRing.points, vertex, approach, departure, side, index, excursion, directSamples }
}

const ANCHOR = buildAnchorScenario()

/** The same bound assertion the acceptance requires, over a sample list. */
function assertEngagementBound(samples: ReadonlyArray<{ engagement: number }>, bound: number): void {
  for (const sample of samples) {
    assert(
      sample.engagement <= bound,
      `engagement ${sample.engagement.toFixed(4)} must be at most the bound ${bound.toFixed(4)}`,
    )
  }
}

/** Walk a polyline at d/4 and report the maximum measured engagement. */
function measurePolyline(
  samples: ReadonlyArray<EngagementLimitedPathSample>,
  index: SweptMaterialIndex,
): number {
  let maxEngagement = 0
  for (let k = 0; k + 1 < samples.length; k += 1) {
    const from = samples[k]
    const to = samples[k + 1]
    const length = Math.hypot(to.x - from.x, to.y - from.y)
    if (length <= 1e-12) continue
    const steps = Math.max(1, Math.ceil(length / SAMPLE_STEP))
    for (let step = 1; step < steps; step += 1) {
      const t = step / steps
      const x = from.x + (to.x - from.x) * t
      const y = from.y + (to.y - from.y) * t
      maxEngagement = Math.max(maxEngagement, index.engagementAt(x, y, to.directionX, to.directionY))
    }
  }
  return maxEngagement
}

// ── 1. The scenario premises ───────────────────────────────────────────────

test('premise: the emitted anchor corner is approached south and departed west, interior left', () => {
  // Pins the scenario to the emitted reality: conventional pocket rings wind
  // positively in the internal coordinates, so the interior is on the left of
  // travel and the corner under test is the bottom-right corner. If the
  // generator's emission order or direction ever changes, this fails loudly
  // instead of silently testing a different corner.
  assert(Math.abs(ANCHOR.approach.x - 0) <= 1e-6 && Math.abs(ANCHOR.approach.y - 1) <= 1e-6,
    `approach must be south, got (${ANCHOR.approach.x.toFixed(4)}, ${ANCHOR.approach.y.toFixed(4)})`)
  assert(Math.abs(ANCHOR.departure.x + 1) <= 1e-6 && Math.abs(ANCHOR.departure.y - 0) <= 1e-6,
    `departure must be west, got (${ANCHOR.departure.x.toFixed(4)}, ${ANCHOR.departure.y.toFixed(4)})`)
  assert(ANCHOR.side === 'left', `the interior side must be left of travel, got '${ANCHOR.side}'`)
})

test('premise: the suppressed (direct) corner turn reproduces the #498 anchor figure', () => {
  // The direct A → V → B turn under the production index must read the #498
  // measured near-corner maximum, 2.9404 rad. If this drifts, either the pack
  // or the estimator has drifted since #498 — stop and report, do not adjust.
  const maxEngagement = Math.max(...ANCHOR.directSamples.map((sample) => sample.engagement))
  assert(
    Math.abs(maxEngagement - ANCHOR_DIRECT_PEAK) <= 1e-3,
    `direct corner peak ${maxEngagement.toFixed(4)} must reproduce the #498 figure ${ANCHOR_DIRECT_PEAK}`,
  )
})

// ── 2. The acceptance: peak engagement drops below the straight-wall value ──

test('acceptance: the excursion drops the peak below the straight-wall value plus the stated margin', () => {
  assert(
    ANCHOR.excursion.status === 'ok',
    `the excursion must be accepted, got ${ANCHOR.excursion.status}`,
  )
  assertEngagementBound(ANCHOR.excursion.samples, EXCURSION_BOUND)
  assert(
    ANCHOR.excursion.maxEngagement <= EXCURSION_BOUND,
    `reported maxEngagement ${ANCHOR.excursion.maxEngagement.toFixed(4)} must be at most the bound ${EXCURSION_BOUND.toFixed(4)}`,
  )
  console.log(
    `   anchor excursion peak ${ANCHOR.excursion.maxEngagement.toFixed(4)} rad`
    + ` = nominal + ${(ANCHOR.excursion.maxEngagement - NOMINAL).toFixed(4)}`
    + ` (bound nominal + ${ENGAGEMENT_MARGIN_ABOVE_NOMINAL_RAD.toFixed(2)})`,
  )
})

test('acceptance: the same assertion with the excursion suppressed must fail', () => {
  // The issue names this explicitly: a test that passes either way proves
  // nothing. The identical bound assertion run on the direct corner turn must
  // fail — and it does, at the #498 anchor figure.
  let suppressedFailed = false
  try {
    assertEngagementBound(ANCHOR.directSamples, EXCURSION_BOUND)
  } catch {
    suppressedFailed = true
  }
  assert(
    suppressedFailed,
    'the direct corner turn must violate the engagement bound (peak 2.9404 rad ≫ nominal + margin)',
  )
})

// ── 3. Independent re-measurement of the emitted polyline ───────────────────

test('acceptance: an independent d/4 re-measure of the emitted polyline holds the bound', () => {
  // Re-samples every emitted segment at d/4 with the same index — chord
  // midpoints included — so a coarser emission could not slip through the
  // module's own verification. The chords lie inboard of the arcs (toward
  // the arc centres), so this also checks the emission's geometric fidelity.
  if (ANCHOR.excursion.status !== 'ok') throw new Error('excursion must be ok here')
  const reMeasuredMax = measurePolyline(ANCHOR.excursion.samples, ANCHOR.index)
  assert(
    reMeasuredMax <= EXCURSION_BOUND + 1e-9,
    `re-measured polyline peak ${reMeasuredMax.toFixed(4)} must hold the bound ${EXCURSION_BOUND.toFixed(4)}`,
  )
})

// ── 4. Every emitted point lies on the interior side ────────────────────────

test('acceptance: every emitted excursion point lies on the interior side', () => {
  // The general inboard form: a point is on the interior side of the corner
  // when it lies in both inboard half-planes, (P − V)·n ≥ 0 for the interior
  // normals of the two edges, n = side · left(edge direction). For this
  // corner (south/west, side left) that is x ≤ V.x and y ≤ V.y. Mutation-
  // checked during development: flipping the module's side mapping makes the
  // excursion unreachable (the direction assertion fires) and this scenario
  // fails.
  if (ANCHOR.excursion.status !== 'ok') throw new Error('excursion must be ok here')
  const sideSign = ANCHOR.side === 'left' ? 1 : -1
  const normalOf = (direction: CornerQualifierPoint): CornerQualifierPoint => ({
    x: sideSign * -direction.y,
    y: sideSign * direction.x,
  })
  const approachNormal = normalOf(ANCHOR.approach)
  const departureNormal = normalOf(ANCHOR.departure)
  for (const sample of ANCHOR.excursion.samples) {
    const fromVertex = { x: sample.x - ANCHOR.vertex.x, y: sample.y - ANCHOR.vertex.y }
    const inApproach = fromVertex.x * approachNormal.x + fromVertex.y * approachNormal.y >= -1e-9
    const inDeparture = fromVertex.x * departureNormal.x + fromVertex.y * departureNormal.y >= -1e-9
    assert(
      inApproach && inDeparture,
      `excursion point (${sample.x.toFixed(2)}, ${sample.y.toFixed(2)}) must lie on the interior side of the corner`,
    )
  }
})

// ── 5. The direction assertion ──────────────────────────────────────────────

test('direction assertion: a flipped side is rejected before any geometry is built', () => {
  // The load-bearing geometric fact: cleared space lies toward the pocket
  // interior under inner-first traversal, and that is the only direction an
  // excursion may unwind. The module asserts the sign explicitly.
  let flippedRejected = false
  try {
    cornerUnwindPath({
      cornerX: ANCHOR.vertex.x,
      cornerY: ANCHOR.vertex.y,
      approachX: ANCHOR.approach.x,
      approachY: ANCHOR.approach.y,
      departureX: ANCHOR.departure.x,
      departureY: ANCHOR.departure.y,
      side: 'right',
      toolDiameter: PACK_OPTIONS.toolDiameter,
      nominalEngagement: NOMINAL,
      engagementAt: (x, y, dirX, dirY): number => ANCHOR.index.engagementAt(x, y, dirX, dirY),
    })
  } catch (error) {
    flippedRejected = error instanceof RangeError
  }
  assert(flippedRejected, "the flipped side ('right' for a left turn) must throw a RangeError")
})

// ── 6. Re-entry engagement is bounded, not merely lower ─────────────────────

test('re-entry: the final sample rejoins the ring at B and reads the straight-wall value', () => {
  if (ANCHOR.excursion.status !== 'ok') throw new Error('excursion must be ok here')
  const samples = ANCHOR.excursion.samples
  const last = samples[samples.length - 1]
  const leadIn = CORNER_LEAD_IN_TOOL_DIAMETERS * PACK_OPTIONS.toolDiameter
  const expectedB = {
    x: ANCHOR.vertex.x + leadIn * ANCHOR.departure.x,
    y: ANCHOR.vertex.y + leadIn * ANCHOR.departure.y,
  }
  assert(
    Math.hypot(last.x - expectedB.x, last.y - expectedB.y) <= 1e-6,
    `the excursion must end at B (${expectedB.x}, ${expectedB.y}), got (${last.x.toFixed(4)}, ${last.y.toFixed(4)})`,
  )
  // The stated re-entry bound: nominal + the stated margin.
  assert(
    last.engagement <= EXCURSION_BOUND,
    `re-entry engagement ${last.engagement.toFixed(4)} must be at most nominal + margin = ${EXCURSION_BOUND.toFixed(4)}`,
  )
  // And the measured figure: B sits 2d past the corner, where the spike has
  // decayed to the straight-wall value — the estimator reads nominal to ~1e-7.
  assert(
    Math.abs(last.engagement - NOMINAL) <= 1e-3,
    `re-entry engagement ${last.engagement.toFixed(4)} must read the straight-wall value ${NOMINAL.toFixed(4)}`,
  )
  console.log(`   re-entry engagement ${last.engagement.toFixed(7)} rad vs nominal ${NOMINAL.toFixed(7)}`)
})

// ── 7. Determinism ──────────────────────────────────────────────────────────

test('determinism: the excursion is a pure function of its inputs', () => {
  const run = (): EngagementLimitedPathResult => cornerUnwindPath({
    cornerX: ANCHOR.vertex.x,
    cornerY: ANCHOR.vertex.y,
    approachX: ANCHOR.approach.x,
    approachY: ANCHOR.approach.y,
    departureX: ANCHOR.departure.x,
    departureY: ANCHOR.departure.y,
    side: ANCHOR.side,
    toolDiameter: PACK_OPTIONS.toolDiameter,
    nominalEngagement: NOMINAL,
    engagementAt: (x, y, dirX, dirY): number => ANCHOR.index.engagementAt(x, y, dirX, dirY),
  })
  const first = run()
  const second = run()
  assert(
    JSON.stringify(first) === JSON.stringify(second),
    'two runs of the excursion must be byte-identical',
  )
})

// ── 8. The threshold premises (the S2b standing rule) ───────────────────────

test('premise: CORNER_LEAD_IN_TOOL_DIAMETERS sits at its derived floor', () => {
  // The corner spike decays over roughly two tool diameters of path either
  // side of the corner (#498/#499 measured), so the lead-in must be at least
  // 2d to place the departure and re-entry points at the straight-wall
  // value. A deliberate retune below the floor needs a new derivation — and
  // fails the acceptance first (mutation-checked during development).
  assert(
    CORNER_LEAD_IN_TOOL_DIAMETERS >= 2,
    `CORNER_LEAD_IN_TOOL_DIAMETERS (${CORNER_LEAD_IN_TOOL_DIAMETERS}) must sit at or above its measured 2d floor; a retune needs a new spike-decay derivation`,
  )
})

test('premise: ENGAGEMENT_MARGIN_ABOVE_NOMINAL_RAD sits in its measured bracket', () => {
  // The bracket: the margin must cover the worst measured accepted excess
  // (0.1308 rad on largeComplex) and must stay clear of the anchor's direct
  // excess (1.5710 rad) so the suppressed-excursion contrast cannot go
  // vacuous. A retune out of the bracket fails here with the instruction.
  assert(
    ENGAGEMENT_MARGIN_ABOVE_NOMINAL_RAD >= WORST_ACCEPTED_EXCESS,
    `the margin (${ENGAGEMENT_MARGIN_ABOVE_NOMINAL_RAD}) must cover the measured worst accepted excess (${WORST_ACCEPTED_EXCESS}); a deliberate retune needs a new measurement`,
  )
  assert(
    ENGAGEMENT_MARGIN_ABOVE_NOMINAL_RAD <= ANCHOR_DIRECT_EXCESS / 2,
    `the margin (${ENGAGEMENT_MARGIN_ABOVE_NOMINAL_RAD}) must stay below half the anchor's direct excess (${(ANCHOR_DIRECT_EXCESS / 2).toFixed(4)}); a larger margin would weaken the suppressed-excursion contrast`,
  )
  assert(
    ANCHOR_EXCURSION_EXCESS < ENGAGEMENT_MARGIN_ABOVE_NOMINAL_RAD,
    `the anchor excursion's measured excess (${ANCHOR_EXCURSION_EXCESS}) must sit inside the margin (${ENGAGEMENT_MARGIN_ABOVE_NOMINAL_RAD})`,
  )
})

// ── 9. The generic core — reusable, not bespoke ─────────────────────────────

test('generic core: a non-corner A→B turn over a cleared band is emitted and verified', () => {
  // No corner geometry anywhere: A and B with perpendicular tangents over a
  // synthetic cleared band (two swept strips). The generator must emit a
  // path, bulge toward the requested side, and verify every sample.
  const index = new SweptMaterialIndex(3)
  index.addSweptSegment(-30, 2, 30, 2)
  index.addSweptSegment(-30, 8, 30, 8)
  const result = engagementLimitedPath(
    { x: 0, y: 0, directionX: 1, directionY: 0 },
    { x: 0, y: 3, directionX: 0, directionY: -1 },
    {
      toolDiameter: 6,
      maxEngagement: 1.7,
      side: 'left',
      engagementAt: (x, y, dirX, dirY): number => index.engagementAt(x, y, dirX, dirY),
    },
  )
  assert(result.status === 'ok', `the cleared-band path must be accepted, got ${result.status}`)
  assert(result.samples.length >= 3, `expected a real path, got ${result.samples.length} samples`)
  assertEngagementBound(result.samples, 1.7)
  // The initial bulge: the first emitted step must move toward the requested
  // side of travel — left of east is south (screen-Y-down), so y grows.
  const first = result.samples[1]
  assert(
    first.y > 0,
    `the first emitted step must bulge toward the requested side (left of east), got y = ${first.y.toFixed(4)}`,
  )
  const runAgain = engagementLimitedPath(
    { x: 0, y: 0, directionX: 1, directionY: 0 },
    { x: 0, y: 3, directionX: 0, directionY: -1 },
    {
      toolDiameter: 6,
      maxEngagement: 1.7,
      side: 'left',
      engagementAt: (x, y, dirX, dirY): number => index.engagementAt(x, y, dirX, dirY),
    },
  )
  assert(JSON.stringify(result) === JSON.stringify(runAgain), 'the cleared-band path must be deterministic')
})

test('generic core: parallel tangents emit the straight chord, verified fail-closed', () => {
  // The near-parallel degeneracy: no loop shape exists, so the generator
  // emits the straight chord and lets the verification decide. The two
  // cases differ only in how far the swept strip extends ahead of A.
  const okIndex = new SweptMaterialIndex(3)
  okIndex.addSweptSegment(-20, 0, 2, 0)
  const accepted = engagementLimitedPath(
    { x: 0, y: 0, directionX: 1, directionY: 0 },
    { x: 0, y: 3, directionX: 1, directionY: 0 },
    {
      toolDiameter: 6,
      maxEngagement: 1.7,
      side: 'left',
      engagementAt: (x, y, dirX, dirY): number => okIndex.engagementAt(x, y, dirX, dirY),
    },
  )
  assert(accepted.status === 'ok', `the straight chord over the swept strip must be accepted, got ${accepted.status}`)
  for (const sample of accepted.samples) {
    assert(
      Math.abs(sample.x) <= 1e-9,
      `the straight chord must lie on the A→B line, got x = ${sample.x.toFixed(6)}`,
    )
  }
  const failIndex = new SweptMaterialIndex(3)
  failIndex.addSweptSegment(-20, 0, 0, 0)
  const declined = engagementLimitedPath(
    { x: 0, y: 0, directionX: 1, directionY: 0 },
    { x: 0, y: 3, directionX: 1, directionY: 0 },
    {
      toolDiameter: 6,
      maxEngagement: 1.7,
      side: 'left',
      engagementAt: (x, y, dirX, dirY): number => failIndex.engagementAt(x, y, dirX, dirY),
    },
  )
  assert(
    declined.status === 'engagement-exceeded',
    `the straight chord into virgin material must fail closed, got ${declined.status}`,
  )
  assert(
    declined.maxEngagement > 1.7,
    `the declined chord must report the violating engagement, got ${declined.maxEngagement.toFixed(4)}`,
  )
})

test('generic core: a bound below the path engagement fails closed with the violation', () => {
  // The anchor A/B with an impossible bound: the departure point itself
  // reads the straight-wall value, above nominal − 0.1, so the generator
  // must refuse the path and carry the violating sample.
  const result = engagementLimitedPath(
    { x: ANCHOR.excursion.samples[0].x, y: ANCHOR.excursion.samples[0].y, directionX: 0, directionY: 1 },
    { x: 12.6, y: 24.6, directionX: -1, directionY: 0 },
    {
      toolDiameter: 6,
      maxEngagement: NOMINAL - 0.1,
      side: 'left',
      engagementAt: (x, y, dirX, dirY): number => ANCHOR.index.engagementAt(x, y, dirX, dirY),
    },
  )
  assert(result.status === 'engagement-exceeded', 'a bound below the path engagement must fail closed')
  assert(
    result.violation.engagement > NOMINAL - 0.1,
    `the violation must carry the exceeding engagement, got ${result.violation.engagement.toFixed(4)}`,
  )
})

// ── 10. The pack scan — the deliverable ─────────────────────────────────────

interface CornerAttempt {
  fixture: string
  ringHalf: number
  turnDeg: number
  status: 'ok' | 'engagement-exceeded'
  maxEngagement: number
}

interface FixtureScan {
  id: string
  toolDiameter: number
  nominal: number
  attempts: CornerAttempt[]
}

/**
 * Qualify one fixture and attempt the unwind at every qualifying corner,
 * with the production per-level index (accumulated ring segments, links
 * excluded, reset per level) and the interior side derived from the emitted
 * ring's winding sign.
 */
function scanFixture(entry: PocketFixtureEntry): FixtureScan {
  const operation = entry.project.operations.find((candidate) => candidate.kind === 'pocket')
  if (!operation) throw new Error(`${entry.id}: the fixture must contain a pocket operation`)
  const tool = entry.project.tools.find((candidate) => candidate.id === operation.toolRef)
  if (!tool) throw new Error(`${entry.id}: the fixture must reference a tool`)
  const toolDiameter = tool.diameter
  const nominal = nominalEngagement(toolDiameter * operation.stepover, toolDiameter / 2)
  const result = generatePocketToolpath(entry.project, { ...operation, pocketFeedReduction: 'engagement' })
  const rawRings = reconstructRings(result.moves)

  const accumulated = new Map<number, Array<[number, number, number, number]>>()
  const rings: CornerQualifierRing[] = rawRings.map((ring) => {
    const prior = accumulated.get(ring.level) ?? []
    const index = new SweptMaterialIndex(toolDiameter / 2)
    for (const [ax, ay, bx, by] of prior) index.addSweptSegment(ax, ay, bx, by)
    const next: Array<[number, number, number, number]> = prior.slice()
    for (let k = 0; k < ring.points.length; k += 1) {
      const current = ring.points[k]
      const following = ring.points[(k + 1) % ring.points.length]
      if (Math.hypot(following.x - current.x, following.y - current.y) > 1e-9) {
        next.push([current.x, current.y, following.x, following.y])
      }
    }
    accumulated.set(ring.level, next)
    return {
      ...ring,
      engagementAt: (x: number, y: number, dirX: number, dirY: number): number =>
        index.engagementAt(x, y, dirX, dirY),
    }
  })

  const corners = qualifyCorners(rings, { toolDiameter, nominalEngagement: nominal })
  const attempts: CornerAttempt[] = []
  for (const corner of corners) {
    const ring = rings[corner.ringIndex]
    const points = ring.points
    const count = points.length
    const vertex = points[corner.vertexIndex]
    const previous = points[(corner.vertexIndex - 1 + count) % count]
    const next = points[(corner.vertexIndex + 1) % count]
    const winding = ringWinding(points)
    const side = winding > 0 ? 'left' : 'right'
    const outcome = cornerUnwindPath({
      cornerX: vertex.x,
      cornerY: vertex.y,
      approachX: vertex.x - previous.x,
      approachY: vertex.y - previous.y,
      departureX: next.x - vertex.x,
      departureY: next.y - vertex.y,
      side,
      toolDiameter,
      nominalEngagement: nominal,
      engagementAt: ring.engagementAt,
    })
    attempts.push({
      fixture: entry.id,
      ringHalf: ringHalfExtent(points),
      turnDeg: (corner.turnAngle * 180) / Math.PI,
      status: outcome.status,
      maxEngagement: outcome.maxEngagement,
    })
  }
  return { id: entry.id, toolDiameter, nominal, attempts }
}

const PACK = buildPocketFixturePack(PACK_OPTIONS)
const SCANS = PACK.map((entry) => scanFixture(entry))

console.log('=== corner unwind scan — d=6, stepover=0.4, lead-in 2d, bound nominal+0.15 ===')
for (const scan of SCANS) {
  const ok = scan.attempts.filter((attempt) => attempt.status === 'ok')
  const declined = scan.attempts.filter((attempt) => attempt.status === 'engagement-exceeded')
  const okPeak = ok.reduce((max, attempt) => Math.max(max, attempt.maxEngagement), 0)
  const declinedPeak = declined.reduce((max, attempt) => Math.max(max, attempt.maxEngagement), 0)
  console.log(
    `  ${scan.id.padEnd(14)} qualifying=${String(scan.attempts.length).padStart(3)}`
    + ` unwound=${String(ok.length).padStart(3)} declined=${String(declined.length).padStart(3)}`
    + ` | worst accepted peak ${ok.length > 0 ? okPeak.toFixed(4) : '     –'}`
    + ` | worst declined peak ${declined.length > 0 ? declinedPeak.toFixed(4) : '     –'}`,
  )
}

function scanById(id: string): FixtureScan {
  const scan = SCANS.find((candidate) => candidate.id === id)
  if (!scan) throw new Error(`no scan for fixture ${id}`)
  return scan
}

test('scan: every verdict is consistent with the bound', () => {
  for (const scan of SCANS) {
    const bound = scan.nominal + ENGAGEMENT_MARGIN_ABOVE_NOMINAL_RAD
    for (const attempt of scan.attempts) {
      if (attempt.status === 'ok') {
        assert(
          attempt.maxEngagement <= bound,
          `${scan.id}: an accepted corner must stay at or below the bound ${bound.toFixed(4)}, got ${attempt.maxEngagement.toFixed(4)}`,
        )
      } else {
        assert(
          attempt.maxEngagement > bound,
          `${scan.id}: a declined corner must exceed the bound ${bound.toFixed(4)}, got ${attempt.maxEngagement.toFixed(4)}`,
        )
      }
    }
  }
})

test('scan: rectangular unwinds exactly where the ring fits the excursion', () => {
  // Derived boundary, not a guessed one: the excursion's re-entry disc
  // (centre l = 2d = 12 mm past the corner, radius r = 3 mm) must fit inside
  // the inner ring's kerf capsule body, whose edge extends `half − s` from
  // its own corner — `(half − l) − r ≥ −(half − s)` ⟺ half ≥ (l + r + s)/2
  // = 8.7 mm. The emitted halves are 7.8 (declined) and 10.2 (unwound), the
  // two closest rings to the boundary on either side.
  const scan = scanById('rectangular')
  for (const attempt of scan.attempts) {
    if (attempt.ringHalf >= 10.2 - 0.05) {
      assert(
        attempt.status === 'ok',
        `rectangular ring at half ${attempt.ringHalf.toFixed(1)} must unwind, got ${attempt.status}`,
      )
    } else if (attempt.ringHalf <= 7.8 + 0.05) {
      assert(
        attempt.status === 'engagement-exceeded',
        `rectangular ring at half ${attempt.ringHalf.toFixed(1)} must fail closed, got ${attempt.status}`,
      )
    }
  }
})

test('scan: every acute-corner excursion is declined — the wedge is cut at its own angle', () => {
  // A measured decline, not a defect: the acute apex's excursion reads 1.99
  // rad (the wedge between the converging walls must be cut at ~its own
  // angle no matter the approach) and the base corners' re-entry approach
  // reads 1.56 rad — both above the stated bound, so the generator fails
  // closed and those corners keep the legacy turn at slot feed, which is
  // exactly the issue's fallback path. Asserted so a silent change to that
  // boundary cannot slip through.
  const scan = scanById('acuteCorner')
  assert(scan.attempts.length > 0, 'acuteCorner must qualify corners')
  for (const attempt of scan.attempts) {
    assert(
      attempt.status === 'engagement-exceeded',
      `acuteCorner turn ${attempt.turnDeg.toFixed(0)}° must be declined, got ${attempt.status}`,
    )
  }
})

// ── 11. Cost, reported in CPU time, never asserted ──────────────────────────

test('cost: unwind CPU time per corner (reported, never asserted)', () => {
  const entry = PACK.find((candidate) => candidate.id === 'rectangular')
  if (!entry) throw new Error('rectangular fixture missing from the pack')
  const cpuMs = bestCpuMs({
    run: () => {
      cornerUnwindPath({
        cornerX: ANCHOR.vertex.x,
        cornerY: ANCHOR.vertex.y,
        approachX: ANCHOR.approach.x,
        approachY: ANCHOR.approach.y,
        departureX: ANCHOR.departure.x,
        departureY: ANCHOR.departure.y,
        side: ANCHOR.side,
        toolDiameter: PACK_OPTIONS.toolDiameter,
        nominalEngagement: NOMINAL,
        engagementAt: (x, y, dirX, dirY): number => ANCHOR.index.engagementAt(x, y, dirX, dirY),
      })
    },
    reps: 5,
  })
  console.log(`   anchor unwind: best-of-5 CPU ${cpuMs.toFixed(3)} ms (${ANCHOR.excursion.samples.length} samples emitted)`)
})

// ── Summary ──

console.log(`\nengagementLimitedPath tests: ${passed} passed, ${failed} failed, ${passed + failed} total`)
if (failed > 0) process.exitCode = 1
