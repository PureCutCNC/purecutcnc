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
 * Containment-backstop acceptance (issue #499, slice S4): the predicate
 * `checkExcursionContainment` — *does any part of the cutter body leave
 * already-cleared material?* — against the acceptance criteria of the
 * slice-4 handoff, and over the real generator's output.
 *
 * Acceptance mapping:
 *
 * - *An excursion wholly inside cleared material is contained* — test 1
 *   (a loop deep inside a swept block), cross-checked against the
 *   independent sampler below.
 * - *An excursion crossing into uncut stock is rejected, and the reported
 *   violating point actually lies outside the cleared union* — tests 2–3;
 *   the witness is verified by raw distance, never by the module's own
 *   boolean. Test 3 is the cutter-body case: the centre stays inside (with
 *   margin) while the flank exits; the development mutation that reduced
 *   the check to the centre made it fail, and was restored.
 * - *Starved prior set → rejected* — tests 4–5: an empty prior and a
 *   deliberately starved one-segment prior both reject, and the bias is
 *   tested rather than asserted in a comment.
 * - *Degenerate input → rejected* — test 6, with structured reasons.
 * - *A strictly-interior hole is caught* — test 7: a small island hole that
 *   leaves the disc boundary and centre covered is found by the grid; the
 *   grid-step mutation (0.141 → 1.0) made this test fail and was restored.
 * - *The margin bites* — test 8: a disc riding the envelope boundary within
 *   the margin is rejected fail-closed with `penetration ≤ margin` (the
 *   checked rim extends one margin past the capsule, so a margin witness
 *   never certifies a gouge) — reported honestly, not as a crossing. The
 *   margin mutation (0.1 → 0.02) made this test fail and was restored.
 * - *The constants carry their derivations* — test 9, the S2b premise
 *   shape: the margin bracket (float dust below, the measured pack inboard
 *   slack above) and the soundness invariant `grid step ≤ margin·√2`, so a
 *   retune cannot silently break the covering argument.
 * - *Deterministic; CPU time reported, never asserted* — tests 10, 14, 15.
 * - *Run over the real generator's output* — the pack scan and its three
 *   integrity tests (12–14), the deliverable: every excursion
 *   `cornerUnwindPath` produces across the fixture pack, checked against
 *   the production-faithful prior set (the rings already emitted at the
 *   level, the inter-ring links, and the ring's own emitted prefix up to
 *   the excursion's departure point). The verdict table is printed; the
 *   finding the handoff anticipates is reported in the completion block,
 *   not adjusted here.
 *
 * ## The independent sampler
 *
 * The module proves coverage with a grid and a Lipschitz margin; the test
 * verifies it with a different construction: dense point sampling of each
 * candidate capsule (boundary circle + interior) against the raw segment
 * array by direct point-to-segment distance — no grid, no margin, no index.
 * The sampler confirms every rejected witness genuinely lies at or past the
 * margin, and every contained verdict is re-measured independently.
 *
 * Run with: ./node_modules/.bin/tsx src/engine/toolpaths/excursionContainment.test.ts
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
import { cornerUnwindPath } from './engagementLimitedPath'
import {
  CONTAINMENT_COVERAGE_MARGIN_FRACTION,
  CONTAINMENT_GRID_STEP_FRACTION,
  checkExcursionContainment,
  type ContainmentPoint,
  type ContainmentSegment,
} from './excursionContainment'

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

// ── Raw geometry (independent of the module's grid, margin, and index) ─────

type RawSegment = [number, number, number, number]

function pointSegmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax
  const dy = by - ay
  const lengthSq = dx * dx + dy * dy
  const t = lengthSq > 0
    ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq))
    : 0
  return Math.hypot(ax + dx * t - px, ay + dy * t - py)
}

function minDistanceToSegments(x: number, y: number, segments: RawSegment[]): number {
  let best = Number.POSITIVE_INFINITY
  for (const [ax, ay, bx, by] of segments) {
    best = Math.min(best, pointSegmentDistance(x, y, ax, ay, bx, by))
  }
  return best
}

/** The raw tuple segments in the module's typed input shape. */
function asContainmentSegments(segments: RawSegment[]): ContainmentSegment[] {
  return segments.map(([ax, ay, bx, by]) => ({ ax, ay, bx, by }))
}

/**
 * Independent dense sampler over the candidate path's swept capsules:
 * walks each segment at `step`, sampling each disc's boundary circle and
 * an interior grid, and measures the raw distance to the segment array.
 * Reports the worst penetration (`dist − r`) and the count of samples that
 * lie strictly outside the cleared union. The segments passed in must
 * include every segment within `2r` of the path's bounding box (the callers
 * window the prior set), which makes the measured distances exact wherever
 * they can be below `2r`.
 */
function sampleCoverage(
  path: ContainmentPoint[],
  radius: number,
  segments: RawSegment[],
): { maxPenetration: number; outsideCount: number } {
  let maxPenetration = Number.NEGATIVE_INFINITY
  let outsideCount = 0
  const step = radius * 0.15
  const checkDisc = (cx: number, cy: number): void => {
    const angles = 32
    for (let k = 0; k < angles; k += 1) {
      const angle = (2 * Math.PI * k) / angles
      const distance = minDistanceToSegments(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle), segments)
      const penetration = distance - radius
      if (penetration > maxPenetration) maxPenetration = penetration
      if (distance > radius) outsideCount += 1
    }
    for (let gx = -1; gx <= 1; gx += 1) {
      for (let gy = -1; gy <= 1; gy += 1) {
        const distance = minDistanceToSegments(cx + gx * radius * 0.4, cy + gy * radius * 0.4, segments)
        const penetration = distance - radius
        if (penetration > maxPenetration) maxPenetration = penetration
        if (distance > radius) outsideCount += 1
      }
    }
  }
  for (let i = 0; i + 1 < path.length; i += 1) {
    const a = path[i]
    const b = path[i + 1]
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    const pieces = Math.max(1, Math.ceil(length / step))
    for (let k = 0; k <= pieces; k += 1) {
      const t = k / pieces
      checkDisc(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)
    }
  }
  if (path.length === 1) checkDisc(path[0].x, path[0].y)
  return { maxPenetration, outsideCount }
}

/**
 * Window the raw prior set to the segments whose bounding box comes within
 * `2r` of the path's bounding box. Every segment that can cover a point of
 * the path's swept capsules is inside the window, so the windowed distances
 * are exact wherever they are below `2r` — which is everywhere the
 * containment decision lives.
 */
function windowSegments(path: ContainmentPoint[], radius: number, segments: RawSegment[]): RawSegment[] {
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const point of path) {
    minX = Math.min(minX, point.x)
    maxX = Math.max(maxX, point.x)
    minY = Math.min(minY, point.y)
    maxY = Math.max(maxY, point.y)
  }
  const pad = 2 * radius
  return segments.filter(([ax, ay, bx, by]) => {
    const sx = Math.min(ax, bx)
    const ex = Math.max(ax, bx)
    const sy = Math.min(ay, by)
    const ey = Math.max(ay, by)
    return ex >= minX - pad && sx <= maxX + pad && ey >= minY - pad && sy <= maxY + pad
  })
}

// ── Synthetic fixtures ─────────────────────────────────────────────────────

/** Tool radius used by the synthetic cases. */
const R = 3

const MARGIN = CONTAINMENT_COVERAGE_MARGIN_FRACTION * R

/**
 * A solid cleared block: horizontal cut rows spaced `4 < 2r` apart, so the
 * swept envelope covers the rectangle `[−53, 53] × [−33, 33]` with no hole.
 */
function clearedBlock(topRow: number): RawSegment[] {
  const segments: RawSegment[] = []
  for (let y = -30; y <= topRow; y += 4) {
    segments.push([-50, y, 50, y])
  }
  return segments
}

/** A circle polyline of the given radius around the origin. */
function circlePath(radius: number, pointCount: number): ContainmentPoint[] {
  const points: ContainmentPoint[] = []
  for (let k = 0; k < pointCount; k += 1) {
    const angle = (2 * Math.PI * k) / pointCount
    points.push({ x: radius * Math.cos(angle), y: radius * Math.sin(angle) })
  }
  return points
}

// ── 1. Wholly inside cleared material → contained ───────────────────────────

test('contained: a loop deep inside a swept block is accepted, verified by the sampler', () => {
  const segments = clearedBlock(30)
  const path = circlePath(8, 24)
  const result = checkExcursionContainment(path, { toolRadius: R, priorSegments: asContainmentSegments(segments) })
  assert(result.status === 'contained', `the deep loop must be contained, got ${result.status}`)
  assert(result.penetration === null && result.violatingPoint === null, 'a contained verdict carries no witness')
  const oracle = sampleCoverage(path, R, segments)
  assert(
    oracle.maxPenetration < -0.5,
    `the sampler must see the loop far inside (max penetration ${oracle.maxPenetration.toFixed(3)} < −0.5)`,
  )
})

// ── 2. Crossing into uncut stock → rejected with a true witness ─────────────

test('rejected: a path crossing out of the envelope reports a point verifiably outside', () => {
  const segments = clearedBlock(18) // envelope top at 18 + 3 = 21
  const path: ContainmentPoint[] = [{ x: 0, y: 14 }, { x: 0, y: 22 }]
  const result = checkExcursionContainment(path, { toolRadius: R, priorSegments: asContainmentSegments(segments) })
  assert(result.status === 'rejected', 'the crossing path must be rejected')
  assert(result.rejectionReason === 'coverage-violation', `expected coverage-violation, got ${result.rejectionReason}`)
  const witness = result.violatingPoint
  assert(witness !== null, 'the rejection must carry a violating point')
  assert(
    result.penetration !== null && result.penetration > MARGIN,
    `the witness must certify a crossing (penetration ${result.penetration} > margin ${MARGIN})`,
  )
  const rawDistance = minDistanceToSegments(witness.x, witness.y, segments)
  assert(
    rawDistance > R,
    `the witness must be verifiably outside by raw distance: ${rawDistance.toFixed(4)} > ${R}`,
  )
})

// ── 3. Cutter body, not centre ─────────────────────────────────────────────

test('cutter body: a centre-inside flank-exit path is rejected, the centre-with-margin premise first', () => {
  const segments: RawSegment[] = [[-50, 0, 50, 0]]
  const centre: ContainmentPoint = { x: 0, y: 2.6 }
  // Premise: the centre itself sits inside the envelope with margin to spare,
  // so a centre-only check would accept this path.
  assert(
    minDistanceToSegments(centre.x, centre.y, segments) <= R - MARGIN,
    'premise: the centre must be inside by at least the margin',
  )
  const result = checkExcursionContainment([centre], { toolRadius: R, priorSegments: asContainmentSegments(segments) })
  assert(result.status === 'rejected', 'the flank-exit disc must be rejected even though its centre is inside')
  const witness = result.violatingPoint
  assert(
    witness !== null && result.penetration !== null && result.penetration > MARGIN,
    `the flank witness must certify a crossing (penetration ${result.penetration} > margin ${MARGIN})`,
  )
  const rawDistance = minDistanceToSegments(witness.x, witness.y, segments)
  assert(rawDistance > R, `the flank witness must be verifiably outside by raw distance: ${rawDistance.toFixed(4)} > ${R}`)
})

// ── 4. Fail closed: starved prior set ──────────────────────────────────────

test('fail closed: an empty prior set rejects, whatever the path', () => {
  const result = checkExcursionContainment(circlePath(8, 16), { toolRadius: R, priorSegments: [] })
  assert(result.status === 'rejected', 'an empty prior set must reject')
  assert(result.rejectionReason === 'empty-prior-set', `expected empty-prior-set, got ${result.rejectionReason}`)
})

test('fail closed: a starved one-segment prior far from the path rejects', () => {
  const segments: RawSegment[] = [[1000, 1000, 1001, 1001]]
  const result = checkExcursionContainment([{ x: 0, y: 0 }], { toolRadius: R, priorSegments: asContainmentSegments(segments) })
  assert(result.status === 'rejected', 'a prior set with no nearby evidence must reject')
  assert(result.rejectionReason === 'coverage-violation', `expected coverage-violation, got ${result.rejectionReason}`)
  const witness = result.violatingPoint
  assert(witness !== null && result.penetration !== null && result.penetration > MARGIN, 'the starved rejection must carry an outside witness')
})

// ── 5. Degenerate input → structured rejection, never containment ───────────

test('degenerate input rejects with structured reasons', () => {
  const segments: RawSegment[] = [[-50, 0, 50, 0]]
  const emptyPath = checkExcursionContainment([], { toolRadius: R, priorSegments: asContainmentSegments(segments) })
  assert(emptyPath.status === 'rejected' && emptyPath.rejectionReason === 'empty-path', 'an empty path must reject')
  const nanPath = checkExcursionContainment([{ x: Number.NaN, y: 0 }], { toolRadius: R, priorSegments: asContainmentSegments(segments) })
  assert(
    nanPath.status === 'rejected' && nanPath.rejectionReason === 'non-finite-coordinate',
    'a non-finite path coordinate must reject',
  )
  const badRadius = checkExcursionContainment([{ x: 0, y: 0 }], { toolRadius: 0, priorSegments: asContainmentSegments(segments) })
  assert(
    badRadius.status === 'rejected' && badRadius.rejectionReason === 'invalid-tool-radius',
    'a non-positive tool radius must reject',
  )
})

// ── 6. A strictly-interior hole is caught by the grid ───────────────────────

/**
 * The island-hole construction: prior = a closed cut ring of radius 1.6r
 * around the origin (its capsule covers the disc boundary at distance 0.6r
 * everywhere) plus a vertical segment at x = −0.7r covering the centre and
 * the left half. The uncut island (radius 0.6r) leaves a hole band
 * `x ∈ (0.3r, 0.6r]` strictly inside the candidate disc that neither the
 * boundary nor the centre can see — only the grid can. The shipped grid
 * step (0.141r) puts a grid column inside the band; the development mutation
 * to step 1.0r missed it and this test failed, then was restored.
 */
test('interior hole: a sub-boundary uncut pocket is caught by the grid', () => {
  const ringRadius = 1.6 * R
  const segments: RawSegment[] = []
  const ringPoints = 64
  for (let k = 0; k < ringPoints; k += 1) {
    const from = (2 * Math.PI * k) / ringPoints
    const to = (2 * Math.PI * (k + 1)) / ringPoints
    segments.push([
      ringRadius * Math.cos(from),
      ringRadius * Math.sin(from),
      ringRadius * Math.cos(to),
      ringRadius * Math.sin(to),
    ])
  }
  segments.push([-0.7 * R, -5 * R, -0.7 * R, 5 * R])
  const result = checkExcursionContainment([{ x: 0, y: 0 }], { toolRadius: R, priorSegments: asContainmentSegments(segments) })
  assert(result.status === 'rejected', 'the interior island hole must be caught')
  assert(result.rejectionReason === 'coverage-violation', `expected coverage-violation, got ${result.rejectionReason}`)
  const witness = result.violatingPoint
  assert(
    witness !== null && result.penetration !== null && result.penetration > MARGIN,
    `the hole witness must certify a crossing (penetration ${result.penetration} > margin ${MARGIN})`,
  )
  const rawDistance = minDistanceToSegments(witness.x, witness.y, segments)
  assert(rawDistance > R, `the hole witness must be verifiably outside by raw distance: ${rawDistance.toFixed(4)} > ${R}`)
})

// ── 7. The margin: boundary-riding geometry rejects fail-closed ─────────────

test('margin: a disc riding the envelope boundary within the margin rejects with penetration ≤ 0', () => {
  // Two parallel cut rows at ±2.5 (their capsules overlap: the cleared band
  // is solid to ±5.5). The disc centred at y = 2.2 has its top at 5.2 —
  // distance 2.7 = r − m to the nearest segment, exactly at the margin
  // threshold: genuinely contained, but riding the boundary. The shipped
  // margin rejects it (the rim row at 5.499 reads 2.999 > r − m) with a
  // non-certifying witness; the development mutation 0.1 → 0.02 shrank the
  // rim below that row and accepted the disc, failing this test — restored.
  const segments: RawSegment[] = [[-50, -2.5, 50, -2.5], [-50, 2.5, 50, 2.5]]
  const centre: ContainmentPoint = { x: 0, y: 2.2 }
  const result = checkExcursionContainment([centre], { toolRadius: R, priorSegments: asContainmentSegments(segments) })
  assert(result.status === 'rejected', 'boundary-riding geometry must reject fail-closed')
  assert(
    result.penetration !== null && result.penetration <= 0,
    `the margin witness must not certify a gouge: penetration ${result.penetration} ≤ 0`,
  )
  const oracle = sampleCoverage([centre], R, segments)
  assert(
    oracle.maxPenetration <= 0,
    `the sampler must confirm nothing truly pokes out (max ${oracle.maxPenetration.toFixed(4)})`,
  )
})

// ── 8. The constants carry their derivations (the S2b premise shape) ────────

test('premise: the margin sits in its measured bracket', () => {
  // Measured on the fixture pack (d = 6, r = 3, stepover 0.4) with the
  // independent sampler: the deepest-inboard excursion disc sits 1.84 mm
  // inside the envelope boundary — a 0.61r slack — while every generated
  // excursion pokes OUT at re-entry (max penetration +0.65 … +2.40 mm). The
  // margin must stay orders above float dust and below the inboard slack;
  // 0.1r sits 6× under the slack. A retune out of the bracket needs a new
  // measurement.
  assert(
    CONTAINMENT_COVERAGE_MARGIN_FRACTION >= 1e-6,
    `the margin (${CONTAINMENT_COVERAGE_MARGIN_FRACTION}) must stay far above floating-point dust`,
  )
  assert(
    CONTAINMENT_COVERAGE_MARGIN_FRACTION <= 0.3,
    `the margin (${CONTAINMENT_COVERAGE_MARGIN_FRACTION}) must stay below the measured 0.61r inboard slack; a larger margin would reject genuinely contained excursions`,
  )
  // The soundness invariant of the covering argument: grid step ≤ margin·√2.
  assert(
    CONTAINMENT_GRID_STEP_FRACTION <= CONTAINMENT_COVERAGE_MARGIN_FRACTION * Math.SQRT2,
    `the grid step (${CONTAINMENT_GRID_STEP_FRACTION}) must not exceed margin·√2 (${(CONTAINMENT_COVERAGE_MARGIN_FRACTION * Math.SQRT2).toFixed(6)}) or the covering proof breaks`,
  )
  assert(
    CONTAINMENT_GRID_STEP_FRACTION >= 0.01,
    `the grid step (${CONTAINMENT_GRID_STEP_FRACTION}) must stay at its cost floor; finer steps grow the point count quadratically`,
  )
})

// ── 9. Determinism (synthetic) ──────────────────────────────────────────────

test('determinism: the synthetic verdicts are pure functions of their inputs', () => {
  const segments = clearedBlock(18)
  const path: ContainmentPoint[] = [{ x: 0, y: 14 }, { x: 0, y: 22 }]
  const first = checkExcursionContainment(path, { toolRadius: R, priorSegments: asContainmentSegments(segments) })
  const second = checkExcursionContainment(path, { toolRadius: R, priorSegments: asContainmentSegments(segments) })
  assert(JSON.stringify(first) === JSON.stringify(second), 'two runs must be byte-identical')
})

// ── The pack scan — the deliverable ─────────────────────────────────────────

/** The pack's nominal configuration: the #498 anchor tool/stepover. */
const PACK_OPTIONS = { toolDiameter: 6, stepover: 0.4 }

const pointKey = (point: Pick<ToolpathPoint, 'x' | 'y'>): string =>
  `${Math.round(point.x * 1e6)},${Math.round(point.y * 1e6)}`

interface EmittedPiece {
  kind: 'ring' | 'link'
  points: CornerQualifierPoint[]
  level: number
}

/**
 * Reconstruct the emitted cut path of one fixture, level by level, into
 * closed rings and the inter-ring links in emission order. The closure
 * detection is the same as the corner-qualifier suite's: a ring closes when
 * a move revisits a point already on the open path; the path prefix before
 * the ring's start point is the incoming link.
 */
function reconstructPieces(moves: ToolpathMove[]): EmittedPiece[] {
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
  const pieces: EmittedPiece[] = []
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
        if (revisit >= 1) {
          pieces.push({ kind: 'link', points: openPath.slice(0, revisit + 1), level: level.z })
        }
        const points = openPath.slice(revisit)
        const first = points[0]
        const last = points[points.length - 1]
        if (Math.hypot(last.x - first.x, last.y - first.y) <= 1e-9) points.pop()
        if (points.length >= 3) pieces.push({ kind: 'ring', points, level: level.z })
        openPath = []
        openIndex.clear()
      } else {
        openPath.push(to)
        openIndex.set(toKey, openPath.length - 1)
      }
    }
  }
  return pieces
}

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

function ringWinding(points: ReadonlyArray<CornerQualifierPoint>): number {
  let sum = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    sum += current.x * next.y - next.x * current.y
  }
  return sum
}

function ringSegments(points: ReadonlyArray<CornerQualifierPoint>): RawSegment[] {
  const segments: RawSegment[] = []
  for (let k = 0; k < points.length; k += 1) {
    const a = points[k]
    const b = points[(k + 1) % points.length]
    if (Math.hypot(b.x - a.x, b.y - a.y) > 1e-9) segments.push([a.x, a.y, b.x, b.y])
  }
  return segments
}

interface PackAttempt {
  fixture: string
  ringHalf: number
  status: 'contained' | 'rejected'
  rejectionReason: string | null
  penetration: number | null
  violatingPoint: ContainmentPoint | null
  /** The excursion polyline checked, for the independent re-measurement. */
  path: ContainmentPoint[]
  /** The full prior set the check ran against. */
  priorSegments: RawSegment[]
}

interface PackScan {
  id: string
  qualified: number
  unwound: number
  attempts: PackAttempt[]
}

/**
 * Qualify one fixture, generate the unwind excursion at every qualifying
 * corner, and check containment of each generated excursion against the
 * production-faithful prior set: every ring and link already emitted at the
 * level, and the ring's own emitted prefix up to the excursion's departure
 * point A (the moves already emitted when the excursion is about to start).
 */
function scanFixture(entry: PocketFixtureEntry): PackScan {
  const operation = entry.project.operations.find((candidate) => candidate.kind === 'pocket')
  if (!operation) throw new Error(`${entry.id}: the fixture must contain a pocket operation`)
  const tool = entry.project.tools.find((candidate) => candidate.id === operation.toolRef)
  if (!tool) throw new Error(`${entry.id}: the fixture must reference a tool`)
  const toolDiameter = tool.diameter
  const toolRadius = toolDiameter / 2
  const nominal = nominalEngagement(toolDiameter * operation.stepover, toolRadius)
  const result = generatePocketToolpath(entry.project, { ...operation, pocketFeedReduction: 'engagement' })
  const pieces = reconstructPieces(result.moves)
  const rings = pieces
    .map((piece, pieceIndex) => ({ piece, pieceIndex }))
    .filter((entry2) => entry2.piece.kind === 'ring')

  // Emission-order accumulation of every piece at each level: the "already
  // emitted" envelope any later ring sees. Links land between rings, so the
  // accumulation must follow the emission order, not the ring list.
  const priorBefore = new Map<number, RawSegment[]>()
  const accumulatedByLevel = new Map<number, RawSegment[]>()
  pieces.forEach((piece, pieceIndex) => {
    const accumulated = accumulatedByLevel.get(piece.level) ?? []
    if (piece.kind === 'ring') {
      priorBefore.set(pieceIndex, accumulated.slice())
      accumulatedByLevel.set(piece.level, accumulated.concat(ringSegments(piece.points)))
    } else {
      const segments: RawSegment[] = []
      for (let k = 0; k + 1 < piece.points.length; k += 1) {
        segments.push([piece.points[k].x, piece.points[k].y, piece.points[k + 1].x, piece.points[k + 1].y])
      }
      accumulatedByLevel.set(piece.level, accumulated.concat(segments))
    }
  })

  // Per-ring engagement index (the production per-level model: the ring
  // segments emitted before this ring at its level, links excluded) — the
  // same construction the qualifier suite uses.
  const accumulatedEngagement = new Map<number, RawSegment[]>()
  const qualifierRings: CornerQualifierRing[] = rings.map(({ piece }) => {
    const ring = piece
    const prior = accumulatedEngagement.get(ring.level) ?? []
    const index = new SweptMaterialIndex(toolRadius)
    for (const segment of prior) index.addSweptSegment(segment[0], segment[1], segment[2], segment[3])
    accumulatedEngagement.set(ring.level, prior.concat(ringSegments(ring.points)))
    return {
      ...ring,
      engagementAt: (x: number, y: number, dirX: number, dirY: number): number =>
        index.engagementAt(x, y, dirX, dirY),
    }
  })

  const corners = qualifyCorners(qualifierRings, { toolDiameter, nominalEngagement: nominal })
  const attempts: PackAttempt[] = []
  for (const corner of corners) {
    const ringEntry = rings[corner.ringIndex]
    const ring = ringEntry.piece
    const points = ring.points
    const count = points.length
    const vertex = points[corner.vertexIndex]
    const previous = points[(corner.vertexIndex - 1 + count) % count]
    const next = points[(corner.vertexIndex + 1) % count]
    const approachLength = Math.hypot(vertex.x - previous.x, vertex.y - previous.y)
    const excursion = cornerUnwindPath({
      cornerX: vertex.x,
      cornerY: vertex.y,
      approachX: vertex.x - previous.x,
      approachY: vertex.y - previous.y,
      departureX: next.x - vertex.x,
      departureY: next.y - vertex.y,
      side: ringWinding(points) > 0 ? 'left' : 'right',
      toolDiameter,
      nominalEngagement: nominal,
      engagementAt: qualifierRings[corner.ringIndex].engagementAt,
    })
    if (excursion.status !== 'ok') continue // not an emitted excursion

    // The containment prior: the pieces already emitted before this ring at
    // its level, then the ring's own prefix from its start point along the
    // emission order to A — the departure point 2d before the corner on the
    // approach edge.
    const prior: RawSegment[] = (priorBefore.get(ringEntry.pieceIndex) ?? []).slice()
    const approach = {
      x: (vertex.x - previous.x) / approachLength,
      y: (vertex.y - previous.y) / approachLength,
    }
    const leadIn = 2 * toolDiameter
    const aPoint = { x: vertex.x - leadIn * approach.x, y: vertex.y - leadIn * approach.y }
    let prefixComplete = false
    for (let k = 0; k < count && !prefixComplete; k += 1) {
      const from = points[k]
      const to = points[(k + 1) % count]
      if ((k + 1) % count === corner.vertexIndex) {
        prior.push([from.x, from.y, aPoint.x, aPoint.y])
        prefixComplete = true
      } else {
        prior.push([from.x, from.y, to.x, to.y])
      }
    }
    if (!prefixComplete) throw new Error(`${entry.id}: the corner's approach edge was not found on the ring`)

    const path: ContainmentPoint[] = excursion.samples.map((sample) => ({ x: sample.x, y: sample.y }))
    const containment = checkExcursionContainment(path, { toolRadius, priorSegments: asContainmentSegments(prior) })
    attempts.push({
      fixture: entry.id,
      ringHalf: ringHalfExtent(points),
      status: containment.status,
      rejectionReason: containment.rejectionReason,
      penetration: containment.penetration,
      violatingPoint: containment.violatingPoint,
      path,
      priorSegments: prior,
    })
  }
  const unwound = attempts.length
  return { id: entry.id, qualified: corners.length, unwound, attempts }
}

const PACK = buildPocketFixturePack(PACK_OPTIONS)
const SCANS = PACK.map((entry) => scanFixture(entry))

console.log('=== containment scan — d=6, stepover=0.4, margin 0.1r, prior = rings + links + ring prefix ===')
for (const scan of SCANS) {
  const contained = scan.attempts.filter((attempt) => attempt.status === 'contained')
  const rejected = scan.attempts.filter((attempt) => attempt.status === 'rejected')
  const worstPenetration = scan.attempts.reduce(
    (worst, attempt) => Math.max(worst, attempt.penetration ?? Number.NEGATIVE_INFINITY),
    Number.NEGATIVE_INFINITY,
  )
  console.log(
    `  ${scan.id.padEnd(14)} qualifying=${String(scan.qualified).padStart(3)}`
    + ` unwound=${String(scan.unwound).padStart(3)} contained=${String(contained.length).padStart(3)}`
    + ` rejected=${String(rejected.length).padStart(3)}`
    + ` | worst excursion penetration ${scan.unwound > 0 ? worstPenetration.toFixed(3) : '     –'} mm`,
  )
}

function scanById(id: string): PackScan {
  const scan = SCANS.find((candidate) => candidate.id === id)
  if (!scan) throw new Error(`no scan for fixture ${id}`)
  return scan
}

// ── 10. Pack verdict integrity ──────────────────────────────────────────────

test('scan: every rejected witness is verified by raw distance, never by the module boolean', () => {
  for (const scan of SCANS) {
    for (const attempt of scan.attempts) {
      if (attempt.status !== 'rejected') continue
      const witness = attempt.violatingPoint
      assert(witness !== null, `${scan.id}: a rejected excursion must carry a violating point`)
      assert(attempt.penetration !== null, `${scan.id}: a rejected excursion must carry a penetration`)
      const rawDistance = minDistanceToSegments(witness.x, witness.y, attempt.priorSegments)
      const toolRadius = PACK_OPTIONS.toolDiameter / 2
      assert(
        rawDistance > toolRadius - MARGIN - 1e-9,
        `${scan.id}: the witness must sit at or past the coverage margin by raw distance (${rawDistance.toFixed(4)} vs threshold ${(toolRadius - MARGIN).toFixed(4)})`,
      )
      if (attempt.penetration > MARGIN) {
        assert(
          rawDistance > toolRadius,
          `${scan.id}: a witness with penetration beyond the margin must lie strictly outside the union (${rawDistance.toFixed(4)} > ${toolRadius})`,
        )
      }
    }
  }
})

test('scan: every verdict is consistent with the independent sampler', () => {
  for (const scan of SCANS) {
    for (const attempt of scan.attempts) {
      const toolRadius = PACK_OPTIONS.toolDiameter / 2
      const windowed = windowSegments(attempt.path, toolRadius, attempt.priorSegments)
      const oracle = sampleCoverage(attempt.path, toolRadius, windowed)
      if (attempt.status === 'rejected') {
        // The module rejects when a checked point exceeds r − m; the true
        // maximum over the capsule is then at least r − 2m, and the sampler
        // loses at most its own sampling resolution. It must never see the
        // whole excursion sitting deep inside while the module rejects.
        assert(
          oracle.maxPenetration >= -0.75 * toolRadius,
          `${scan.id}: the sampler must not see a rejected excursion deep inside (max ${oracle.maxPenetration.toFixed(3)})`,
        )
      } else {
        // The safety direction: a contained verdict is a proven bound, so
        // the sampler must confirm every sampled point inside the union.
        assert(
          oracle.maxPenetration <= 1e-6,
          `${scan.id}: a contained excursion must be inside by the sampler (max ${oracle.maxPenetration.toFixed(4)})`,
        )
      }
    }
  }
})

// ── 11. Determinism of the whole scan ───────────────────────────────────────

test('determinism: the pack scan is a pure function of the fixtures', () => {
  const second = buildPocketFixturePack(PACK_OPTIONS).map((entry) => scanFixture(entry))
  const summarize = (scans: PackScan[]): unknown => scans.map((scan) => ({
    id: scan.id,
    qualified: scan.qualified,
    unwound: scan.unwound,
    attempts: scan.attempts.map((attempt) => ({
      ringHalf: attempt.ringHalf,
      status: attempt.status,
      rejectionReason: attempt.rejectionReason,
      penetration: attempt.penetration,
      violatingPoint: attempt.violatingPoint,
    })),
  }))
  assert(
    JSON.stringify(summarize(SCANS)) === JSON.stringify(summarize(second)),
    'two pack scans must be byte-identical',
  )
})

// ── 12. Cost, reported in CPU time, never asserted ──────────────────────────

test('cost: containment-check CPU time over the pack (reported, never asserted)', () => {
  const scan = scanById('rectangular')
  const anchorAttempt = scan.attempts[0]
  assert(anchorAttempt !== undefined, 'rectangular must produce at least one excursion')
  const cpuMs = bestCpuMs({
    run: () => {
      checkExcursionContainment(anchorAttempt.path, {
        toolRadius: PACK_OPTIONS.toolDiameter / 2,
        priorSegments: asContainmentSegments(anchorAttempt.priorSegments),
      })
    },
    reps: 5,
  })
  const scanTotal = SCANS.reduce((sum, item) => sum + item.unwound, 0)
  console.log(`   one anchor excursion check (${anchorAttempt.priorSegments.length} prior segments): best-of-5 CPU ${cpuMs.toFixed(2)} ms`)
  console.log(`   pack scan: ${scanTotal} excursions checked, ${SCANS.reduce((sum, item) => sum + item.attempts.length, 0)} verdicts`)
})

// ── Summary ──

console.log(`\nexcursionContainment tests: ${passed} passed, ${failed} failed, ${passed + failed} total`)
if (failed > 0) process.exitCode = 1
