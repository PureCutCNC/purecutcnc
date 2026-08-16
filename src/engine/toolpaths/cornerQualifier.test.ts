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
 * Corner-qualifier acceptance (issue #499, slice S2): qualifies the corners
 * of the slice-1 fixture pack's emitted offset rings and asserts each
 * fixture's known geometry. Detection only — nothing here asserts on, or
 * changes, emitted motion.
 *
 * Harness. Rings are reconstructed from the emitted cut moves per level by
 * closure detection: every closed loop of the emission stream is one ring,
 * its first point the closure point where the inter-ring link landed. The
 * engagement oracle handed to the qualifier is the #498 anchor
 * construction: per ring, a `SweptMaterialIndex` over every cut segment
 * emitted before the ring at its level, ring segments only — inter-ring
 * links are excluded, exactly as the #498 probe (no region boundary, no
 * links) indexed the inner ring before querying the anchor ring. That is
 * the construction under which the anchor figures were measured, and the
 * test pins them below.
 *
 * The negative-control assertion (curvedCorner → zero) is mutation-checked
 * during development, per the slice contract: with the module's turn-angle
 * threshold relaxed to zero, curvedCorner fires through its interior rings'
 * tessellated arc vertices (their engagement reads above nominal under the
 * anchor oracle — the ring's own just-cut wall, which covers the apex in
 * emission order, is not in the index) and the test fails. See the module
 * doc for the threshold derivations.
 *
 * Run with: npx tsx src/engine/toolpaths/cornerQualifier.test.ts
 */

import { bestCpuMs } from '../../test/cpuRatio'
import { buildPocketFixturePack, type PocketFixtureEntry } from '../../test/pocketFixturePack'
import {
  ENGAGEMENT_ESTIMATE_EPSILON,
  SweptMaterialIndex,
  nominalEngagement,
} from './engagement'
import { generatePocketToolpath } from './pocket'
import type { ToolpathMove, ToolpathPoint } from './types'
import {
  qualifyCorners,
  type CornerQualifierPoint,
  type CornerQualifierRing,
  type QualifyingCorner,
} from './cornerQualifier'

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

/** The #498 anchor corner figure (60 mm square, r = 3, stepover 2.4). */
const ANCHOR_CORNER_ENGAGEMENT = 2.9404

// ── Ring reconstruction ────────────────────────────────────────────────────

const pointKey = (point: Pick<ToolpathPoint, 'x' | 'y'>): string =>
  `${Math.round(point.x * 1e6)},${Math.round(point.y * 1e6)}`

/**
 * Reconstruct the emitted rings of one level: every closed loop of the cut
 * move stream is one ring, in emission order. The loop closes when a move's
 * end point revisits a point already on the open path; the ring is the
 * suffix of the open path from that point on. The prefix ahead of the
 * closure point is the inter-ring link, which is dropped from the ring and
 * from the engagement index — the #498 anchor construction. Returns raw
 * ring geometry; `qualifyFixture` attaches the per-ring engagement oracle.
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

// ── Measurement model ──────────────────────────────────────────────────────

interface FixtureQualification {
  id: string
  toolDiameter: number
  nominal: number
  rings: CornerQualifierRing[]
  corners: QualifyingCorner[]
}

/**
 * Qualify one fixture: reconstruct its rings, build one #498-anchor index
 * per ring (every ring segment emitted before it at the level — links
 * excluded), and run the qualifier.
 */
function qualifyFixture(entry: PocketFixtureEntry): FixtureQualification {
  const operation = entry.project.operations.find((candidate) => candidate.kind === 'pocket')
  if (!operation) throw new Error(`${entry.id}: the fixture must contain a pocket operation`)
  const tool = entry.project.tools.find((candidate) => candidate.id === operation.toolRef)
  if (!tool) throw new Error(`${entry.id}: the fixture must reference a tool`)
  const toolDiameter = tool.diameter
  const toolRadius = toolDiameter / 2
  const nominal = nominalEngagement(toolDiameter * operation.stepover, toolRadius)
  const result = generatePocketToolpath(entry.project, { ...operation, pocketFeedReduction: 'engagement' })
  const rawRings = reconstructRings(result.moves)

  const accumulated: Array<[number, number, number, number]> = []
  const rings: CornerQualifierRing[] = rawRings.map((ring) => {
    const index = new SweptMaterialIndex(toolRadius)
    for (const [ax, ay, bx, by] of accumulated) index.addSweptSegment(ax, ay, bx, by)
    for (let k = 0; k < ring.points.length; k += 1) {
      const current = ring.points[k]
      const next = ring.points[(k + 1) % ring.points.length]
      if (Math.hypot(next.x - current.x, next.y - current.y) > 1e-9) {
        accumulated.push([current.x, current.y, next.x, next.y])
      }
    }
    return {
      ...ring,
      engagementAt: (x: number, y: number, dirX: number, dirY: number): number =>
        index.engagementAt(x, y, dirX, dirY),
    }
  })

  const corners = qualifyCorners(rings, { toolDiameter, nominalEngagement: nominal })
  return { id: entry.id, toolDiameter, nominal, rings, corners }
}

// ── Reporting ──────────────────────────────────────────────────────────────

function summarizeSpans(corners: QualifyingCorner[]): { median: number | null; p95: number | null; max: number | null } {
  const spans = corners.map((corner) => corner.span).sort((a, b) => a - b)
  if (spans.length === 0) return { median: null, p95: null, max: null }
  const median = spans.length % 2 === 1
    ? spans[(spans.length - 1) / 2]
    : (spans[spans.length / 2 - 1] + spans[spans.length / 2]) / 2
  const p95 = spans[Math.min(spans.length - 1, Math.ceil(0.95 * spans.length) - 1)]
  return { median, p95, max: spans[spans.length - 1] }
}

function formatSpan(value: number | null, toolDiameter: number): string {
  if (value === null) return '   –'
  return `${value.toFixed(2)} (${(value / toolDiameter).toFixed(2)}d)`
}

// ── Precomputation (runs before the tests; the table is the deliverable) ───

const PACK = buildPocketFixturePack(PACK_OPTIONS)
const QUALIFICATIONS = PACK.map((entry) => qualifyFixture(entry))

console.log('=== corner qualifier — d=6, stepover=0.4 (s=2.4), slot=40% ===')
console.log('turn threshold 0.374 rad (21.4°) — geometric midpoint of the measured 5.1° tessellation ceiling and the 90° rectangular corner')
console.log('span threshold 8d — smallest whole diameter above largeComplex\'s measured 7.39d max run (the #499 handoff\'s designated source)')
for (const qualification of QUALIFICATIONS) {
  const spans = summarizeSpans(qualification.corners)
  console.log(
    `  ${qualification.id.padEnd(14)} rings=${String(qualification.rings.length).padStart(2)}`
    + ` qualifying=${String(qualification.corners.length).padStart(3)}`
    + ` | spans median ${formatSpan(spans.median, qualification.toolDiameter)}`
    + ` p95 ${formatSpan(spans.p95, qualification.toolDiameter)}`
    + ` max ${formatSpan(spans.max, qualification.toolDiameter)}`,
  )
}

function qualificationById(id: string): FixtureQualification {
  const qualification = QUALIFICATIONS.find((candidate) => candidate.id === id)
  if (!qualification) throw new Error(`no qualification for fixture ${id}`)
  return qualification
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

// ── 1. The negative control ────────────────────────────────────────────────

test('negative control: curvedCorner (a capsule, no sharp corner) qualifies nothing', () => {
  // The single most important assertion: the qualifier must not fire on
  // tessellated arcs. Mutation-checked during development: with the module's
  // turn-angle threshold relaxed to zero, the interior rings' 5° arc
  // vertices pass the turn check and — under the anchor oracle, which omits
  // the ring's own just-cut wall — their engagement reads above nominal, so
  // curvedCorner fires (222 corners across the three interior rings) and
  // this test fails. Restored from a `cp` backup; the suite is green again.
  const qualification = qualificationById('curvedCorner')
  assert(
    qualification.corners.length === 0,
    `curvedCorner must qualify zero corners, got ${qualification.corners.length}`,
  )
})

// ── 2. The rectangular acceptance ──────────────────────────────────────────

test('rectangular: the interior-ring right-angle corners, and only those', () => {
  const qualification = qualificationById('rectangular')
  // 12 rings: the innermost slotting ring (half 0.60) and the wall-adjacent
  // ring (half 27.00) are excluded by half-size selection; the 10 interior
  // rings (half 3.00…24.60) each contribute their 4 right-angle corners.
  const corners = qualification.corners
  assert(corners.length === 40, `expected 40 qualifying corners (10 interior rings × 4), got ${corners.length}`)
  const perRing = new Map<number, number>()
  for (const corner of corners) perRing.set(corner.ringIndex, (perRing.get(corner.ringIndex) ?? 0) + 1)
  for (const [ringIndex, count] of perRing) {
    assert(count === 4, `each interior ring must yield 4 corners, ring ${ringIndex} yielded ${count}`)
  }
  for (const corner of corners) {
    assert(
      Math.abs(Math.abs(corner.turnAngle) - Math.PI / 2) <= 1e-3,
      `rectangular corner turn ${corner.turnAngle.toFixed(4)} must be a right angle`,
    )
    // The #498 regression anchor: every rectangular corner (including the
    // closure corner) reads the measured near-corner maximum 2.9404 rad. If
    // this drifts, either the estimator or the anchor-oracle construction
    // has drifted since #498 — stop and report, do not adjust the value.
    assert(
      Math.abs(corner.engagement - ANCHOR_CORNER_ENGAGEMENT) <= 1e-3,
      `rectangular corner engagement ${corner.engagement.toFixed(4)} must reproduce the #498 figure ${ANCHOR_CORNER_ENGAGEMENT}`,
    )
  }
})

test('rectangular: selection is by half-size, never by ordinal', () => {
  // The slice-1 trap: ordinal 0 is the innermost ring, not the wall ring.
  // Qualifying corners must lie only on rings whose half-extent sits
  // strictly between the level's innermost and wall-adjacent extremes.
  const qualification = qualificationById('rectangular')
  const halves = qualification.rings.map((ring) => ringHalfExtent(ring.points))
  const minHalf = Math.min(...halves)
  const maxHalf = Math.max(...halves)
  for (const corner of qualification.corners) {
    const half = ringHalfExtent(qualification.rings[corner.ringIndex].points)
    assert(
      half > minHalf + 1e-9 && half < maxHalf - 1e-9,
      `corner on ring with half-extent ${half.toFixed(2)} must be interior (${minHalf.toFixed(2)}, ${maxHalf.toFixed(2)})`,
    )
  }
})

// ── 3. The acute-corner acceptance ─────────────────────────────────────────

test('acuteCorner: three corners per qualifying ring', () => {
  const qualification = qualificationById('acuteCorner')
  // 7 rings: the innermost (half 1.85) and the wall ring (half 25.15) are
  // excluded; the 5 interior rings each contribute their 3 corners — the
  // 53.13° apex and the two 63.43° base corners.
  const corners = qualification.corners
  assert(corners.length === 15, `expected 15 qualifying corners (5 interior rings × 3), got ${corners.length}`)
  const perRing = new Map<number, number>()
  for (const corner of corners) perRing.set(corner.ringIndex, (perRing.get(corner.ringIndex) ?? 0) + 1)
  for (const [ringIndex, count] of perRing) {
    assert(count === 3, `each interior ring must yield 3 corners, ring ${ringIndex} yielded ${count}`)
  }
  const apexTurn = (180 - 53.13) * Math.PI / 180
  const baseTurn = (180 - 63.43) * Math.PI / 180
  for (const corner of corners) {
    const matchesApex = Math.abs(Math.abs(corner.turnAngle) - apexTurn) <= 0.02
    const matchesBase = Math.abs(Math.abs(corner.turnAngle) - baseTurn) <= 0.02
    assert(
      matchesApex || matchesBase,
      `acute corner turn ${(corner.turnAngle * 180 / Math.PI).toFixed(1)}° must be the apex (${(apexTurn * 180 / Math.PI).toFixed(1)}°) or a base (${(baseTurn * 180 / Math.PI).toFixed(1)}°) corner`,
    )
    assert(
      corner.engagement > qualification.nominal + 0.5,
      `acute corner engagement ${corner.engagement.toFixed(4)} must exceed the straight-wall value ${qualification.nominal.toFixed(4)} by a real margin`,
    )
  }
})

// ── 4. The large-complex acceptance ────────────────────────────────────────

test('largeComplex: a non-zero set (count and spans are reported, not asserted)', () => {
  const qualification = qualificationById('largeComplex')
  assert(
    qualification.corners.length > 0,
    'largeComplex must qualify a non-zero set of corners',
  )
  const spans = summarizeSpans(qualification.corners)
  console.log(
    `   largeComplex qualifying ${qualification.corners.length} corners:`
    + ` spans median ${formatSpan(spans.median, qualification.toolDiameter)}`
    + ` p95 ${formatSpan(spans.p95, qualification.toolDiameter)}`
    + ` max ${formatSpan(spans.max, qualification.toolDiameter)}`,
  )
})

// ── 5. The engagement property over every fixture ──────────────────────────

test('every qualifying corner exceeds the straight-wall value for its stepover', () => {
  for (const qualification of QUALIFICATIONS) {
    for (const corner of qualification.corners) {
      assert(
        corner.engagement > qualification.nominal + ENGAGEMENT_ESTIMATE_EPSILON,
        `${qualification.id}: corner engagement ${corner.engagement.toFixed(4)} must exceed nominal ${qualification.nominal.toFixed(4)} + deadband`,
      )
    }
  }
})

// ── 6. The degenerate case ─────────────────────────────────────────────────

test('tinyPocket: a pocket smaller than an unwind excursion declines', () => {
  // Two rings: the innermost slotting ring (half 2.10) and the wall ring
  // (half 4.50) — half-size selection excludes both, leaving nothing.
  const qualification = qualificationById('tinyPocket')
  assert(
    qualification.corners.length === 0,
    `tinyPocket must qualify zero corners, got ${qualification.corners.length}`,
  )
})

// ── 7. Determinism ─────────────────────────────────────────────────────────

test('determinism: qualification is a pure function of the toolpath', () => {
  for (const id of ['rectangular', 'acuteCorner', 'curvedCorner', 'largeComplex']) {
    const entry = PACK.find((candidate) => candidate.id === id)
    if (!entry) throw new Error(`${id}: missing from the pack`)
    const first = qualifyFixture(entry)
    const second = qualifyFixture(entry)
    assert(
      JSON.stringify(first.corners) === JSON.stringify(second.corners),
      `${id}: qualification must be deterministic`,
    )
  }
})

// ── 8. Cost, reported in CPU time, never asserted ──────────────────────────

test('cost: qualification CPU time per fixture (reported, never asserted)', () => {
  for (const qualification of QUALIFICATIONS) {
    const { rings, toolDiameter, nominal } = qualification
    const cpuMs = bestCpuMs({
      run: () => {
        qualifyCorners(rings, { toolDiameter, nominalEngagement: nominal })
      },
      reps: 3,
    })
    console.log(`   ${qualification.id}: best-of-3 qualification CPU ${cpuMs.toFixed(1)} ms`)
  }
})

// ── Summary ──

console.log(`\ncornerQualifier tests: ${passed} passed, ${failed} failed, ${passed + failed} total`)
if (failed > 0) process.exitCode = 1
