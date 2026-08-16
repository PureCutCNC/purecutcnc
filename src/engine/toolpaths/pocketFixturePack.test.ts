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
 * Fixture-pack measurement (issue #499, slice S1): measures the eight
 * fixtures of `src/test/pocketFixturePack.ts` exactly as the #499 amended
 * plan asks, and asserts only what the slice contract allows.
 *
 * Per fixture, generated with `pocketFeedReduction: 'engagement'`:
 *
 * - **Telemetry** — the shipped `EngagementTelemetry` on the generated
 *   result (`maxEngagement`, `p95Engagement`, `distanceAboveNominal`,
 *   `totalCutDistance`).
 * - **Nominal** — `nominalEngagement(stepoverDistance, toolRadius)`.
 * - **Spike runs** — contiguous runs of sampled cut path whose engagement
 *   exceeds nominal. "Exceeds" is operationalized with the shipped
 *   `ENGAGEMENT_ESTIMATE_EPSILON` deadband, the same margin the feed map
 *   uses: a straight ring run measures ~4e-8 rad above nominal from the
 *   estimator's deliberately conservative capsule dust, and calling that a
 *   spike would turn every nominal run into one. The deadband is a shipped
 *   constant, not a threshold chosen here.
 * - **Cost and shape** — estimated time, point count, feed-change count,
 *   recovered arc runs (the arc-fitting proxy), and generation cost in CPU
 *   time (`bestCpuMs`, never wall clock — AGENTS.md §Build & Verify).
 *
 * Ring attribution. The #498 caveat is honoured: the wall-adjacent ring
 * (centreline at one tool radius from the cleared-region boundary — the
 * root ring, and equally any island-adjacent ring) counts retained material
 * beyond the wall as stock, so it is **reported separately**, never mixed
 * into the interior-ring numbers. Ring classification is geometric, from
 * the pack's analytic boundary distance: a sample closer than
 * `toolRadius + stepoverDistance/2` to any cleared-region boundary is
 * wall-adjacent. Inter-ring links are genuine full-width slots (measured
 * 180° in #498) and are reported as their own row so they neither inflate
 * the corner spans nor hide inside them.
 *
 * Spike spans are **reported, never asserted**: the no-threshold rule is
 * that a span figure chosen in advance may not appear in this file as a
 * bound. The assertions are the #498 regression anchor (1.3694 rad
 * straight, 2.9404 rad corner on the 60 mm square at r = 3, stepover 2.4),
 * the independent-oracle agreement for the acute-corner figure,
 * determinism, and tool-independence of spans expressed in diameters.
 *
 * Run with: npx tsx src/engine/toolpaths/pocketFixturePack.test.ts
 */

import { bestCpuMs } from '../../test/cpuRatio'
import {
  buildPocketFixturePack,
  type PocketFixtureEntry,
  type PocketFixtureOptions,
} from '../../test/pocketFixturePack'
import type { Operation } from '../../types/project'
import {
  ENGAGEMENT_ESTIMATE_EPSILON,
  SweptMaterialIndex,
  nominalEngagement,
  type EngagementTelemetry,
} from './engagement'
import { effectiveFeed } from './feed'
import { generatePocketToolpath } from './pocket'
import type { PocketToolpathResult, ToolpathMove, ToolpathPoint } from './types'

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
//
// The pack's nominal configuration: the #498 anchor tool/stepover. Every
// report below is at this point; the tool-independence test re-measures the
// rectangular fixture at half the diameter to show spans scale with the tool.

const PACK_OPTIONS: PocketFixtureOptions = { toolDiameter: 6, stepover: 0.4 }

/** Sampling step: a quarter tool diameter — fine enough to resolve a spike
 * that decays over ~2 diameters, and identical in diameter units at every
 * tool size, which is what makes the tool-independence comparison fair. */
const SAMPLE_STEP_FRACTION = 0.25

/** Oracle-agreement tolerance: #498's probe agreed to ~2e-4 rad; 0.01 admits
 * sampling noise while still rejecting a wrong magnitude or algorithm. */
const ORACLE_TOLERANCE = 0.01

// ── Measurement model ──────────────────────────────────────────────────────

interface SpikeSample {
  /** Cumulative path distance of the sample position. */
  distance: number
  /** Path length this sample covers (half-width at move endpoints). */
  coverage: number
  engagement: number
  x: number
  y: number
  dirX: number
  dirY: number
  /** True when closer than `toolRadius + stepoverDistance/2` to a boundary. */
  boundaryAdjacent: boolean
  /** Ordinal of the ring loop this sample's move lies on, −1 for links. */
  loopOrdinal: number
  moveIndex: number
  z: number
  /** True on the last sample before a non-cut move or a level change. */
  gapAfter: boolean
}

interface SpikeRun {
  length: number
  peak: number
  sampleCount: number
}

interface RunStats {
  runCount: number
  spikeSampleCount: number
  spikeDistance: number
  peakEngagement: number
  medianLength: number | null
  p95Length: number | null
  maxLength: number | null
}

interface ShapeMetrics {
  moveCount: number
  cutMoveCount: number
  cutDistance: number
  estimatedMinutes: number
  feedChangeCount: number
  arcRunCount: number
  longestArcRun: number
}

interface FixtureMeasurement {
  id: string
  toolDiameter: number
  toolRadius: number
  stepoverDistance: number
  nominal: number
  telemetry: EngagementTelemetry
  samples: SpikeSample[]
  /** Spike-run summaries over the five sample classes defined below. */
  runs: {
    /** All samples off the wall rings (rings + links). */
    fullInterior: RunStats
    /** All wall-adjacent samples (the #498 ring-0 caveat, reported separately). */
    fullBoundary: RunStats
    /** Interior ring samples only — the corner-span deliverable. */
    ringInterior: RunStats
    /** Wall-adjacent ring samples only. */
    ringBoundary: RunStats
    /** Inter-ring link samples only (genuine full-width slots). */
    links: RunStats
  }
  shape: ShapeMetrics
}

/** Per-level closed-loop detection over the emitted cut path.

 * A ring is a closed polyline: it closes when a cut move's end point
 * revisits the point the loop started at. Inter-ring links never revisit a
 * point, so every closure interval is one ring. With the `'inner-first'`
 * traversal the first interval of each level is the innermost ring — which
 * is a genuine full slot at every point (nothing inside it was cut before)
 * and must not be mistaken for a corner spike. Rings detected this way are
 * used only to exclude links from the ring-only statistics; wall-adjacency
 * is classified geometrically (boundary distance), not topologically. */
function loopOrdinalsByMove(moves: ToolpathMove[]): Map<number, number> {
  const key = (point: Pick<ToolpathPoint, 'x' | 'y'>): string =>
    `${Math.round(point.x * 1e6)},${Math.round(point.y * 1e6)}`
  const ordinals = new Map<number, number>()
  const levels: Array<Array<{ move: ToolpathMove; moveIndex: number }>> = []
  for (let moveIndex = 0; moveIndex < moves.length; moveIndex += 1) {
    const move = moves[moveIndex]
    if (move.kind !== 'cut') continue
    const level = levels.find((entry) => entry[0].move.from.z === move.from.z)
    if (level) {
      level.push({ move, moveIndex })
    } else {
      levels.push([{ move, moveIndex }])
    }
  }
  for (const level of levels) {
    const firstVisit = new Map<string, number>()
    const intervals: Array<{ start: number; end: number }> = []
    const entries: Array<{ moveIndex: number; start: number; end: number }> = []
    let distance = 0
    for (const { move, moveIndex } of level) {
      const length = Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y)
      const fromKey = key(move.from)
      if (!firstVisit.has(fromKey)) firstVisit.set(fromKey, distance)
      const start = distance
      distance += length
      const toKey = key(move.to)
      if (firstVisit.has(toKey)) {
        intervals.push({ start: firstVisit.get(toKey) ?? start, end: distance })
        // The closure consumes the point: a later link that starts here is a
        // new visit, not a closure of the same loop.
        firstVisit.delete(toKey)
      } else {
        firstVisit.set(toKey, distance)
      }
      entries.push({ moveIndex, start, end: distance })
    }
    for (const entry of entries) {
      let ordinal = -1
      for (let index = 0; index < intervals.length; index += 1) {
        const interval = intervals[index]
        if (entry.start >= interval.start - 1e-9 && entry.end <= interval.end + 1e-9) {
          ordinal = index
          break
        }
      }
      ordinals.set(entry.moveIndex, ordinal)
    }
  }
  return ordinals
}

/** Walk the emitted cut path in emission order, querying the production
 * estimator at every sample point against everything swept before it —
 * the same replay construction as #498's manager probe.
 *
 * One degenerate case is excluded, deliberately: a sample whose position is
 * exactly a previously indexed swept-disc centre. The estimator special-
 * cases that coincidence as "the whole cutter circle was already swept"
 * (engagement 0), and it is hit at every ring junction — the ring start
 * after the incoming link, and the closure corner where the ring returns to
 * its own start point. Production never queries those points (its chunk
 * sampler queries strictly interior points) and #498's probe queried
 * hand-picked positions, so the coincidence is a replay artifact, not an
 * engagement signal: the physically meaningful measurement at a junction is
 * the *approaching* direction (the previous move's end sample), which is
 * kept. A skipped sample's coverage is carried to the neighbouring kept
 * sample so run lengths still sum to the cut path. */
function sampleReplay(
  result: PocketToolpathResult,
  toolRadius: number,
  stepoverDistance: number,
  toolDiameter: number,
  boundaryDistance: (x: number, y: number) => number,
): SpikeSample[] {
  const ordinals = loopOrdinalsByMove(result.moves)
  const pointKey = (x: number, y: number): string =>
    `${Math.round(x * 1e6)},${Math.round(y * 1e6)}`
  const samples: SpikeSample[] = []
  const visitedDiscCentres = new Set<string>()
  let index = new SweptMaterialIndex(toolRadius)
  let lastCutZ: number | null = null
  let pathDistance = 0
  const step = toolDiameter * SAMPLE_STEP_FRACTION
  const boundaryThreshold = toolRadius + stepoverDistance / 2
  result.moves.forEach((move, moveIndex) => {
    if (move.kind !== 'cut') {
      if (samples.length > 0) samples[samples.length - 1].gapAfter = true
      return
    }
    const dx = move.to.x - move.from.x
    const dy = move.to.y - move.from.y
    const length = Math.hypot(dx, dy)
    if (length <= 1e-9) return
    if (move.from.z !== lastCutZ) {
      // A fresh level starts with virgin material at that Z: the swept
      // index models "everything already swept at this level", exactly like
      // production's per-level classification.
      index = new SweptMaterialIndex(toolRadius)
      visitedDiscCentres.clear()
      lastCutZ = move.from.z
      if (samples.length > 0) samples[samples.length - 1].gapAfter = true
    }
    const dirX = dx / length
    const dirY = dy / length
    const pieceCount = Math.max(1, Math.ceil(length / step))
    const pieceLength = length / pieceCount
    const ordinal = ordinals.get(moveIndex) ?? -1
    const fromVisited = visitedDiscCentres.has(pointKey(move.from.x, move.from.y))
    const toVisited = visitedDiscCentres.has(pointKey(move.to.x, move.to.y))
    let carriedCoverage = 0
    for (let piece = 0; piece <= pieceCount; piece += 1) {
      const t = piece / pieceCount
      if ((piece === 0 && fromVisited) || (piece === pieceCount && toVisited)) {
        carriedCoverage += pieceLength / 2
        continue
      }
      const x = move.from.x + dx * t
      const y = move.from.y + dy * t
      samples.push({
        distance: pathDistance + piece * pieceLength,
        coverage: pieceLength / (piece === 0 || piece === pieceCount ? 2 : 1) + carriedCoverage,
        engagement: index.engagementAt(x, y, dirX, dirY),
        x,
        y,
        dirX,
        dirY,
        boundaryAdjacent: boundaryDistance(x, y) < boundaryThreshold,
        loopOrdinal: ordinal,
        moveIndex,
        z: move.from.z,
        gapAfter: false,
      })
      carriedCoverage = 0
    }
    pathDistance += length
    index.addSweptSegment(move.from.x, move.from.y, move.to.x, move.to.y)
    visitedDiscCentres.add(pointKey(move.from.x, move.from.y))
    visitedDiscCentres.add(pointKey(move.to.x, move.to.y))
  })
  return samples
}

/** Contiguous runs of spike samples; a run breaks at any non-spike sample,
 * at a non-cut move, at a level change, or at a sample-class change. */
function spikeRuns(
  samples: SpikeSample[],
  nominal: number,
  include: (sample: SpikeSample) => boolean,
): SpikeRun[] {
  const runs: SpikeRun[] = []
  let current: SpikeRun | null = null
  for (const sample of samples) {
    const spike = include(sample) && sample.engagement > nominal + ENGAGEMENT_ESTIMATE_EPSILON
    if (current !== null && (sample.gapAfter || !spike)) {
      runs.push(current)
      current = null
    }
    if (spike) {
      if (current === null) current = { length: 0, peak: 0, sampleCount: 0 }
      current.length += sample.coverage
      current.peak = Math.max(current.peak, sample.engagement)
      current.sampleCount += 1
    }
  }
  if (current !== null) runs.push(current)
  return runs
}

function summarizeRuns(runs: SpikeRun[]): RunStats {
  const lengths = runs.map((run) => run.length).sort((a, b) => a - b)
  const count = lengths.length
  const median = count === 0
    ? null
    : count % 2 === 1
      ? lengths[(count - 1) / 2]
      : (lengths[count / 2 - 1] + lengths[count / 2]) / 2
  const p95 = count === 0 ? null : lengths[Math.min(count - 1, Math.ceil(0.95 * count) - 1)]
  let peak = 0
  let spikeDistance = 0
  let spikeSampleCount = 0
  for (const run of runs) {
    peak = Math.max(peak, run.peak)
    spikeDistance += run.length
    spikeSampleCount += run.sampleCount
  }
  return {
    runCount: count,
    spikeSampleCount,
    spikeDistance,
    peakEngagement: peak,
    medianLength: median,
    p95Length: p95,
    maxLength: count === 0 ? null : lengths[count - 1],
  }
}

/** Cost and shape figures through the same helpers the app and the #498
 * probe use: `effectiveFeed` for time, the probe's arc-run proxy for the
 * arc-fittable runs. */
function shapeMetrics(result: PocketToolpathResult, operation: Operation): ShapeMetrics {
  let cutMoveCount = 0
  let cutDistance = 0
  let estimatedMinutes = 0
  for (const move of result.moves) {
    const distance = Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y, move.to.z - move.from.z)
    if (move.kind === 'cut') {
      cutMoveCount += 1
      cutDistance += Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y)
    }
    if (move.kind === 'rapid' || distance <= 0) continue
    estimatedMinutes += distance / effectiveFeed(move.kind, move.feedScale, operation.feed, operation.plungeFeed)
  }

  // Feed-change count: transitions between contiguous cut moves.
  let feedChangeCount = 0
  let previousScale: number | null = null
  let previousTo: ToolpathPoint | null = null
  for (const move of result.moves) {
    if (move.kind !== 'cut') {
      previousScale = null
      previousTo = null
      continue
    }
    const contiguous = previousTo !== null
      && Math.hypot(move.from.x - previousTo.x, move.from.y - previousTo.y, move.from.z - previousTo.z) < 1e-6
    if (contiguous && previousScale !== null && (move.feedScale ?? 1) !== previousScale) {
      feedChangeCount += 1
    }
    previousScale = move.feedScale ?? 1
    previousTo = move.to
  }

  // Arc-run proxy, matching scripts/pocket-output-probe.ts arcRuns.
  const cutKinds = new Set(['cut', 'lead_in', 'lead_out'])
  let arcRunCount = 0
  let longestArcRun = 0
  let currentRun = 0
  let previousRunScale: number | null | undefined
  let previousRunTo: ToolpathPoint | null = null
  for (const move of result.moves) {
    if (!cutKinds.has(move.kind)) {
      if (currentRun > 0) arcRunCount += 1
      longestArcRun = Math.max(longestArcRun, currentRun)
      currentRun = 0
      previousRunScale = undefined
      previousRunTo = null
      continue
    }
    const contiguous = previousRunTo !== null
      && Math.hypot(move.from.x - previousRunTo.x, move.from.y - previousRunTo.y, move.from.z - previousRunTo.z) < 1e-6
    if (currentRun > 0 && contiguous && (move.feedScale ?? 1) === previousRunScale) {
      currentRun += 1
    } else {
      if (currentRun > 0) arcRunCount += 1
      longestArcRun = Math.max(longestArcRun, currentRun)
      currentRun = 1
    }
    previousRunScale = move.feedScale ?? 1
    previousRunTo = move.to
  }
  if (currentRun > 0) arcRunCount += 1
  longestArcRun = Math.max(longestArcRun, currentRun)

  return {
    moveCount: result.moves.length,
    cutMoveCount,
    cutDistance,
    estimatedMinutes,
    feedChangeCount,
    arcRunCount,
    longestArcRun,
  }
}

function measureFixture(entry: PocketFixtureEntry): FixtureMeasurement {
  const operation = entry.project.operations.find((candidate) => candidate.kind === 'pocket')
  if (!operation) throw new Error(`${entry.id}: the fixture must contain a pocket operation`)
  const tool = entry.project.tools.find((candidate) => candidate.id === operation.toolRef)
  if (!tool) throw new Error(`${entry.id}: the fixture must reference a tool`)
  const toolDiameter = tool.diameter
  const toolRadius = toolDiameter / 2
  const stepoverDistance = toolDiameter * operation.stepover
  const nominal = nominalEngagement(stepoverDistance, toolRadius)
  const result = generatePocketToolpath(entry.project, { ...operation, pocketFeedReduction: 'engagement' })
  const telemetry = result.engagementTelemetry
  if (!telemetry) throw new Error(`${entry.id}: engagement mode must expose telemetry`)

  const samples = sampleReplay(result, toolRadius, stepoverDistance, toolDiameter, entry.boundaryDistance)
  const ring = (sample: SpikeSample): boolean => sample.loopOrdinal >= 0
  const interior = (sample: SpikeSample): boolean => !sample.boundaryAdjacent
  const boundary = (sample: SpikeSample): boolean => sample.boundaryAdjacent
  const link = (sample: SpikeSample): boolean => sample.loopOrdinal === -1

  return {
    id: entry.id,
    toolDiameter,
    toolRadius,
    stepoverDistance,
    nominal,
    telemetry,
    samples,
    runs: {
      fullInterior: summarizeRuns(spikeRuns(samples, nominal, interior)),
      fullBoundary: summarizeRuns(spikeRuns(samples, nominal, boundary)),
      ringInterior: summarizeRuns(spikeRuns(samples, nominal, (s) => interior(s) && ring(s))),
      ringBoundary: summarizeRuns(spikeRuns(samples, nominal, (s) => boundary(s) && ring(s))),
      links: summarizeRuns(spikeRuns(samples, nominal, link)),
    },
    shape: shapeMetrics(result, operation),
  }
}

/** Anchor samples: interior ring samples excluding the innermost ring of
 * each level (a genuine full slot) and excluding inter-ring links (also
 * genuine full slots). What remains on the rectangular fixture is the
 * #498 geometry: interior rings with a nominal straight run and a corner
 * spike, nothing else. */
function anchorSamples(measurement: FixtureMeasurement): SpikeSample[] {
  return measurement.samples.filter(
    (sample) => !sample.boundaryAdjacent && sample.loopOrdinal > 0,
  )
}

// ── Independent oracle ─────────────────────────────────────────────────────
//
// A brute-force leading-semicircle sampler, deliberately unrelated to the
// production arc-union in `engagement.ts`: it point-samples the leading
// semicircle and tests each point against the prior swept capsules by
// direct distance. #498's manager probe used exactly this construction and
// agreed with the estimator to ~2e-4 rad. The production estimator is never
// imported to compute the expected value.

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

/** The prior swept segments the production index held when `sample` was
 * queried: every cut move emitted before it at the same level. */
function priorSegmentsFor(
  result: PocketToolpathResult,
  sample: SpikeSample,
): Array<[number, number, number, number]> {
  const segments: Array<[number, number, number, number]> = []
  for (let moveIndex = 0; moveIndex < sample.moveIndex; moveIndex += 1) {
    const move = result.moves[moveIndex]
    if (move.kind !== 'cut' || move.from.z !== sample.z) continue
    if (Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y) <= 1e-9) continue
    segments.push([move.from.x, move.from.y, move.to.x, move.to.y])
  }
  return segments
}

function sampleByEngagement(measurement: FixtureMeasurement, mode: 'max' | 'min'): SpikeSample {
  const samples = anchorSamples(measurement)
  if (samples.length === 0) throw new Error(`${measurement.id}: no anchor samples found`)
  let best = samples[0]
  for (const sample of samples) {
    if (mode === 'max' ? sample.engagement > best.engagement : sample.engagement < best.engagement) {
      best = sample
    }
  }
  return best
}

// ── Reporting ──────────────────────────────────────────────────────────────

function formatLength(value: number | null): string {
  return value === null ? '    –' : value.toFixed(2)
}

function printRunStats(label: string, stats: RunStats, toolDiameter: number): void {
  const fmt = (value: number | null): string => formatLength(value)
  console.log(
    `  ${label.padEnd(28)}`
    + ` runs=${String(stats.runCount).padStart(3)}`
    + ` | median ${fmt(stats.medianLength)}mm (${fmt(stats.medianLength === null ? null : stats.medianLength / toolDiameter)}d)`
    + ` | p95 ${fmt(stats.p95Length)}mm (${fmt(stats.p95Length === null ? null : stats.p95Length / toolDiameter)}d)`
    + ` | max ${fmt(stats.maxLength)}mm (${fmt(stats.maxLength === null ? null : stats.maxLength / toolDiameter)}d)`
    + ` | peak ${stats.peakEngagement.toFixed(4)} rad`,
  )
}

function reportMeasurement(measurement: FixtureMeasurement): void {
  const { telemetry, nominal, runs, shape } = measurement
  console.log(`\n── ${measurement.id} ─────────────────────────────────────────────`)
  console.log(
    `  tool d=${measurement.toolDiameter} r=${measurement.toolRadius}`
    + ` | stepover ${measurement.stepoverDistance.toFixed(2)} (${(measurement.stepoverDistance / measurement.toolDiameter).toFixed(2)})`
    + ` | nominal ${nominal.toFixed(4)} rad`,
  )
  console.log(
    `  telemetry: max=${telemetry.maxEngagement.toFixed(4)}`
    + ` p95=${telemetry.p95Engagement.toFixed(4)}`
    + ` aboveNominal=${telemetry.distanceAboveNominal.toFixed(2)}mm`
    + ` total=${telemetry.totalCutDistance.toFixed(2)}mm`,
  )
  console.log('  spike runs (lengths in mm and tool diameters):')
  printRunStats('interior, full path', runs.fullInterior, measurement.toolDiameter)
  printRunStats('wall-adjacent, full path', runs.fullBoundary, measurement.toolDiameter)
  printRunStats('interior rings only', runs.ringInterior, measurement.toolDiameter)
  printRunStats('wall-adjacent rings only', runs.ringBoundary, measurement.toolDiameter)
  printRunStats('inter-ring links only', runs.links, measurement.toolDiameter)
  console.log(
    `  cost/shape: moves=${shape.moveCount} cut=${shape.cutMoveCount}`
    + ` cutDist=${shape.cutDistance.toFixed(2)}mm`
    + ` est=${shape.estimatedMinutes.toFixed(3)}min`
    + ` feedChanges=${shape.feedChangeCount}`
    + ` arcRuns=${shape.arcRunCount} longest=${shape.longestArcRun}`,
  )
}

// ── Precomputation (runs before the tests; the table is the deliverable) ───

const PACK = buildPocketFixturePack(PACK_OPTIONS)
const MEASUREMENTS = PACK.map((entry) => measureFixture(entry))

console.log('=== pocket fixture pack measurement — d=6, stepover=0.4 (s=2.4), slot=40% ===')
console.log('wall-adjacent rows carry the #498 ring-0 caveat: reported separately, never mixed in.')
for (const measurement of MEASUREMENTS) reportMeasurement(measurement)

function measurementById(id: string): FixtureMeasurement {
  const measurement = MEASUREMENTS.find((candidate) => candidate.id === id)
  if (!measurement) throw new Error(`no measurement for fixture ${id}`)
  return measurement
}

function entryById(id: string): PocketFixtureEntry {
  const entry = PACK.find((candidate) => candidate.id === id)
  if (!entry) throw new Error(`no fixture ${id} in the pack`)
  return entry
}

// ── 1. The #498 regression anchor ──────────────────────────────────────────

/** Representative half-side of each emitted ring loop (max |coordinate|). */
function loopHalfByOrdinal(
  result: PocketToolpathResult,
  ordinals: Map<number, number>,
): Map<number, number> {
  const halves = new Map<number, number>()
  result.moves.forEach((move, moveIndex) => {
    if (move.kind !== 'cut') return
    const ordinal = ordinals.get(moveIndex)
    if (ordinal === undefined || ordinal < 0) return
    const half = Math.max(
      Math.abs(move.from.x),
      Math.abs(move.from.y),
      Math.abs(move.to.x),
      Math.abs(move.to.y),
    )
    halves.set(ordinal, Math.max(halves.get(ordinal) ?? 0, half))
  })
  return halves
}

test('anchor: the rectangular fixture reproduces the #498 60 mm square figures', () => {
  // Replicates #498's probe construction directly: on the pack's rectangular
  // fixture (60 mm square at d = 6 — the pack builds it as a 10·d square),
  // index the emitted inner ring exactly as the generator cut it and query
  // ring 1 at the documented positions. Ring half-sides follow the
  // generator's insets: ring k at half = 5d − d/2 − k·s = 27 − 2.4k, so the
  // queried ring (ring 1) is 24.6 and the indexed inner ring (ring 2) is
  // 22.4 less than that, found in the emitted path by its half-size rather
  // than by a hardcoded ordinal.
  const entry = entryById('rectangular')
  const operation = entry.project.operations.find((candidate) => candidate.kind === 'pocket')
  if (!operation) throw new Error('rectangular: missing pocket operation')
  const result = generatePocketToolpath(entry.project, { ...operation, pocketFeedReduction: 'engagement' })
  const ordinals = loopOrdinalsByMove(result.moves)
  const ring1Half = 5 * 6 - 3 - 2.4 // = 24.6
  const innerHalf = ring1Half - 2.4 // = 22.2, one stepover inboard
  let innerOrdinal: number | null = null
  for (const [ordinal, half] of loopHalfByOrdinal(result, ordinals)) {
    if (Math.abs(half - innerHalf) <= 0.05) innerOrdinal = ordinal
  }
  assert(innerOrdinal !== null, `no emitted ring at half ${innerHalf} found in the rectangular fixture`)
  const index = new SweptMaterialIndex(3)
  result.moves.forEach((move, moveIndex) => {
    if (move.kind !== 'cut' || ordinals.get(moveIndex) !== innerOrdinal) return
    if (Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y) <= 1e-9) return
    index.addSweptSegment(move.from.x, move.from.y, move.to.x, move.to.y)
  })
  const straight = index.engagementAt(0, ring1Half, 1, 0)
  const corner = index.engagementAt(ring1Half, ring1Half, 1, 0)
  // #498 measured straight run 1.3695 rad against nominalEngagement(2.4, 3)
  // = 1.3694 rad. The anchor is the analytic nominal, not the measured value.
  const nominal = nominalEngagement(2.4, 3)
  assert(
    Math.abs(straight - nominal) <= 1e-3,
    `straight run ${straight.toFixed(4)} must reproduce nominalEngagement(2.4, 3) = ${nominal.toFixed(4)}`,
  )
  // #498 measured the near-corner maximum at 2.9404 rad (168°), identical on
  // every interior ring. If this drifts, either the pack or the estimator has
  // drifted since #498 — the slice contract says to stop and report, not to
  // adjust the expected value.
  assert(
    Math.abs(corner - 2.9404) <= 1e-3,
    `near-corner max ${corner.toFixed(4)} must reproduce the #498 figure 2.9404 rad`,
  )
  // Falsifiability of the spike claim itself: the corner must exceed its own
  // straight run by a real margin, not merely sit above nominal.
  assert(
    corner > straight + 0.3,
    `corner ${corner.toFixed(4)} must exceed the straight run ${straight.toFixed(4)} by a real margin`,
  )
})

// ── 2. Independent oracle cross-check ──────────────────────────────────────

test('oracle: the acute-corner engagement figure agrees with the brute-force sampler', () => {
  const entry = entryById('acuteCorner')
  const operation = entry.project.operations.find((candidate) => candidate.kind === 'pocket')
  if (!operation) throw new Error('acuteCorner: missing pocket operation')
  const result = generatePocketToolpath(entry.project, { ...operation, pocketFeedReduction: 'engagement' })
  const measurement = measurementById('acuteCorner')
  const corner = sampleByEngagement(measurement, 'max')
  const straight = sampleByEngagement(measurement, 'min')
  const cornerOracle = oracleEngagement(
    corner.x,
    corner.y,
    corner.dirX,
    corner.dirY,
    measurement.toolRadius,
    priorSegmentsFor(result, corner),
  )
  const straightOracle = oracleEngagement(
    straight.x,
    straight.y,
    straight.dirX,
    straight.dirY,
    measurement.toolRadius,
    priorSegmentsFor(result, straight),
  )
  assert(
    Math.abs(corner.engagement - cornerOracle) <= ORACLE_TOLERANCE,
    `acute corner: estimator ${corner.engagement.toFixed(4)} vs oracle ${cornerOracle.toFixed(4)}`,
  )
  assert(
    Math.abs(straight.engagement - straightOracle) <= ORACLE_TOLERANCE,
    `acute straight run: estimator ${straight.engagement.toFixed(4)} vs oracle ${straightOracle.toFixed(4)}`,
  )
  assert(
    cornerOracle > straightOracle + 0.3,
    `the oracle must see the acute corner spike too (${cornerOracle.toFixed(4)} vs ${straightOracle.toFixed(4)})`,
  )
})

test('oracle: the #498 anchor corner figure also agrees with the brute-force sampler', () => {
  const entry = entryById('rectangular')
  const operation = entry.project.operations.find((candidate) => candidate.kind === 'pocket')
  if (!operation) throw new Error('rectangular: missing pocket operation')
  const result = generatePocketToolpath(entry.project, { ...operation, pocketFeedReduction: 'engagement' })
  const measurement = measurementById('rectangular')
  const corner = sampleByEngagement(measurement, 'max')
  const oracle = oracleEngagement(
    corner.x,
    corner.y,
    corner.dirX,
    corner.dirY,
    measurement.toolRadius,
    priorSegmentsFor(result, corner),
  )
  assert(
    Math.abs(corner.engagement - oracle) <= ORACLE_TOLERANCE,
    `anchor corner: estimator ${corner.engagement.toFixed(4)} vs oracle ${oracle.toFixed(4)}`,
  )
})

// ── 3. Tool-independence of spans expressed in diameters ───────────────────

test('tool-independence: spans in diameters are the same at half the tool size', () => {
  const halfOptions: PocketFixtureOptions = { toolDiameter: 3, stepover: 0.4 }
  const halfPack = buildPocketFixturePack(halfOptions)
  const halfEntry = halfPack.find((entry) => entry.id === 'rectangular')
  if (!halfEntry) throw new Error('half-size pack missing rectangular')
  const half = measureFixture(halfEntry)
  const full = measurementById('rectangular')
  // The corner spike is an angle: scale-invariant exactly.
  const fullCorner = sampleByEngagement(full, 'max')
  const halfCorner = sampleByEngagement(half, 'max')
  assert(
    Math.abs(fullCorner.engagement - halfCorner.engagement) <= 1e-2,
    `corner spike must not depend on tool size (${fullCorner.engagement.toFixed(4)} vs ${halfCorner.engagement.toFixed(4)} rad)`,
  )
  // Span lengths in diameters: both fixtures sample at d/4, so the same path
  // is measured at the same resolution in diameter units.
  const spanComparison = (name: string, fullValue: number | null, halfValue: number | null): void => {
    if (fullValue === null || halfValue === null) throw new Error(`${name}: expected span figures on both fixtures`)
    const fullDiameters = fullValue / full.toolDiameter
    const halfDiameters = halfValue / half.toolDiameter
    assert(
      Math.abs(fullDiameters - halfDiameters) <= 0.3,
      `${name} span ${fullDiameters.toFixed(3)}d vs ${halfDiameters.toFixed(3)}d must agree within one sample step`,
    )
  }
  spanComparison('interior-ring median', full.runs.ringInterior.medianLength, half.runs.ringInterior.medianLength)
  spanComparison('interior-ring max', full.runs.ringInterior.maxLength, half.runs.ringInterior.maxLength)
  spanComparison('link median', full.runs.links.medianLength, half.runs.links.medianLength)
})

// ── 4. Determinism ─────────────────────────────────────────────────────────

test('determinism: every fixture regenerates byte-identical project, moves and telemetry', () => {
  for (const id of ['rectangular', 'acuteCorner', 'curvedCorner', 'longNeck', 'islandPinch', 'multiSection', 'tinyPocket', 'largeComplex']) {
    const first = entryById(id)
    const second = buildPocketFixturePack(PACK_OPTIONS).find((entry) => entry.id === id)
    if (!second) throw new Error(`${id}: missing on rebuild`)
    assert(
      JSON.stringify(first.project) === JSON.stringify(second.project),
      `${id}: the rebuilt project must be byte-identical (timestamps pinned in the pack)`,
    )
    const operationOf = (entry: PocketFixtureEntry): Operation => {
      const operation = entry.project.operations.find((candidate) => candidate.kind === 'pocket')
      if (!operation) throw new Error(`${id}: missing pocket operation`)
      return operation
    }
    const firstResult = generatePocketToolpath(first.project, { ...operationOf(first), pocketFeedReduction: 'engagement' })
    const secondResult = generatePocketToolpath(second.project, { ...operationOf(second), pocketFeedReduction: 'engagement' })
    assert(
      JSON.stringify(firstResult.moves) === JSON.stringify(secondResult.moves),
      `${id}: generated moves must be deterministic`,
    )
    assert(
      JSON.stringify(firstResult.engagementTelemetry) === JSON.stringify(secondResult.engagementTelemetry),
      `${id}: engagement telemetry must be deterministic`,
    )
  }
})

test('determinism: the measurement itself is a pure function of the toolpath', () => {
  for (const id of ['rectangular', 'largeComplex']) {
    const entry = entryById(id)
    const first = measureFixture(entry)
    const second = measureFixture(entry)
    assert(
      JSON.stringify(first.runs) === JSON.stringify(second.runs)
        && JSON.stringify(first.shape) === JSON.stringify(second.shape),
      `${id}: spike-run statistics and shape metrics must be deterministic`,
    )
  }
})

// ── 5. Structural soundness of every fixture ───────────────────────────────

test('every fixture generates a real engagement-mode toolpath with telemetry', () => {
  for (const measurement of MEASUREMENTS) {
    assert(
      measurement.shape.cutMoveCount > 0 && measurement.shape.cutDistance > 0,
      `${measurement.id}: the fixture must generate cut moves`,
    )
    assert(
      measurement.telemetry.totalCutDistance > 0,
      `${measurement.id}: engagement telemetry must record cut distance`,
    )
    assert(
      measurement.samples.length > 0,
      `${measurement.id}: the replay must sample the emitted path`,
    )
  }
})

// ── 6. Cost, reported in CPU time, never asserted ──────────────────────────

test('cost: generation CPU time per fixture (reported, never asserted)', () => {
  for (const entry of PACK) {
    const operation = entry.project.operations.find((candidate) => candidate.kind === 'pocket')
    if (!operation) throw new Error(`${entry.id}: missing pocket operation`)
    const engagementOperation = { ...operation, pocketFeedReduction: 'engagement' as const }
    const cpuMs = bestCpuMs({ run: () => { generatePocketToolpath(entry.project, engagementOperation) }, reps: 3 })
    console.log(`   ${entry.id}: best-of-3 generation CPU ${cpuMs.toFixed(1)} ms`)
  }
})

// ── Summary ──

console.log(`\npocketFixturePack tests: ${passed} passed, ${failed} failed, ${passed + failed} total`)
if (failed > 0) process.exitCode = 1
