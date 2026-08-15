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
 * Engagement-scaled pocket feed wiring (issue #498, slice S2): tests for
 * `pocketFeedReduction` on pocket clearing.
 *
 * The slots-only byte-identity invariant is proven two ways: JSON equality between
 * the field-absent and field-'slots_only' move streams in-process, and — when
 * `ENGAGEMENT_DUMP_DIR` is set — a full JSON dump of every fixture's move
 * stream for diffing against the pre-change tree (see the slice's required
 * checks).
 *
 * Run with: npx tsx src/engine/toolpaths/engagementPocket.test.ts
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Operation, Project, SketchFeature, Tool } from '../../types/project'
import { circleProfile, defaultTool, newProject, rectProfile } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import { normalizeProject } from '../../store/helpers/projectFormat'
import {
  ENGAGEMENT_ESTIMATE_EPSILON,
  ENGAGEMENT_FEED_BUCKET_COUNT,
  SweptMaterialIndex,
  engagementFeedScale,
  nominalEngagement,
} from './engagement'
import {
  buildOffsetBandEngagementClassification,
  engagementCacheProbeCounts,
  generatePocketToolpath,
  resetEngagementCacheProbeCounts,
} from './pocket'
import type { PocketToolpathResult, ToolpathMove, ToolpathPoint } from './types'

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

// ── Fixtures ─────────────────────────────────────────────────────────

const TOOL_DIAMETER = 6
/** Configured minimum fragment length of the engagement feed path (a tool diameter). */
const MIN_FRAGMENT_LENGTH = TOOL_DIAMETER
/** Slot feed of the built fixtures (buildFixture sets pocketSlotFeedPercent 50). */
const SLOT_SCALE = 0.5

function makeTool(): Tool {
  return {
    ...defaultTool('mm', 1),
    id: 'tool-1',
    name: '6 mm endmill',
    diameter: TOOL_DIAMETER,
    defaultStepdown: 2,
    defaultStepover: 0.4,
  }
}

function makeSquareFeature(
  id: string,
  half: number,
  zTop: number,
  zBottom: number,
  featureOperation: 'subtract' | 'add',
): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(-half, -half, half * 2, half * 2),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: featureOperation,
    z_top: zTop,
    z_bottom: zBottom,
    visible: true,
    locked: false,
  }
}

interface FixtureSpec {
  name: string
  pattern: 'offset' | 'parallel'
  island: boolean
  multiLevel: boolean
  pass: 'rough' | 'finish'
}

/** The required matrix — offset and parallel, with and without islands, single
 * and multi-level — plus one finish-pass fixture for the finish call site. */
function fixtureSpecs(): FixtureSpec[] {
  const specs: FixtureSpec[] = []
  for (const pattern of ['offset', 'parallel'] as const) {
    for (const island of [false, true]) {
      for (const multiLevel of [false, true]) {
        specs.push({
          name: `${pattern}${island ? '-island' : ''}-${multiLevel ? 'multi' : 'single'}`,
          pattern,
          island,
          multiLevel,
          pass: 'rough',
        })
      }
    }
  }
  specs.push({ name: 'finish-offset-single', pattern: 'offset', island: false, multiLevel: false, pass: 'finish' })
  return specs
}

function buildFixture(spec: FixtureSpec, overrides: Partial<Operation> = {}): { project: Project; operation: Operation } {
  const zTop = spec.multiLevel ? 4 : 2
  const features: SketchFeature[] = [makeSquareFeature('pocket', 30, zTop, 0, 'subtract')]
  if (spec.island) {
    features.push(makeSquareFeature('island', 10, zTop, 0, 'add'))
  }
  const project = projectWithFeatures({
    ...newProject(spec.name, 'mm'),
    tools: [makeTool()],
  }, features)
  const operation: Operation = {
    id: 'op-1',
    name: 'op',
    kind: 'pocket',
    pass: spec.pass,
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: ['pocket'] },
    toolRef: 'tool-1',
    stepdown: 2,
    stepover: 0.4,
    feed: 800,
    plungeFeed: 300,
    rpm: 18000,
    pocketPattern: spec.pattern,
    pocketAngle: 0,
    pocketSlotFeedPercent: 50,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 2,
    maxCarveDepth: 2,
    cutDirection: 'conventional',
    machiningOrder: 'level_first',
    ...overrides,
  }
  return { project, operation }
}

function operationWithoutPocketFeedReduction(operation: Operation): Operation {
  const copy = { ...operation }
  delete copy.pocketFeedReduction
  return copy
}

interface CachedResult {
  slotsOnlyAbsent: PocketToolpathResult
  slotsOnlyExplicit: PocketToolpathResult
  engagement: PocketToolpathResult
}

/** Dump a move stream as JSON for external diffing (the byte-identity proof). */
function dumpMoves(name: string, variant: string, moves: ToolpathMove[]): void {
  const dir = process.env.ENGAGEMENT_DUMP_DIR
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.${variant}.json`), JSON.stringify(moves, null, 2))
}

function generateCached(spec: FixtureSpec, key: string, overrides: Partial<Operation> = {}): CachedResult {
  const { project, operation } = buildFixture(spec, overrides)
  const slotsOnlyAbsent = generatePocketToolpath(project, operationWithoutPocketFeedReduction(operation))
  const slotsOnlyExplicit = generatePocketToolpath(project, { ...operation, pocketFeedReduction: 'slots_only' })
  const engagement = generatePocketToolpath(project, { ...operation, pocketFeedReduction: 'engagement' })
  dumpMoves(key, 'slots-only-absent', slotsOnlyAbsent.moves)
  dumpMoves(key, 'slots-only-explicit', slotsOnlyExplicit.moves)
  dumpMoves(key, 'engagement', engagement.moves)
  return { slotsOnlyAbsent, slotsOnlyExplicit, engagement }
}

// ── Precomputation (runs before every test so the JSON dumps are complete
//    even when a later assertion fails) ────────────────────────────────

const FIXTURES = fixtureSpecs()
const results = new Map<string, CachedResult>()
for (const spec of FIXTURES) {
  results.set(spec.name, generateCached(spec, spec.name))
}

// The no-anchor variant: engagement mode with no pocketSlotFeedPercent.
{
  const spec = FIXTURES.find((candidate) => candidate.name === 'offset-single')
  if (!spec) throw new Error('missing offset-single fixture')
  const { project, operation } = buildFixture(spec, { pocketSlotFeedPercent: undefined })
  const noAnchorSlotsOnly = generatePocketToolpath(project, operationWithoutPocketFeedReduction(operation))
  const noAnchorEngagement = generatePocketToolpath(project, { ...operation, pocketFeedReduction: 'engagement' })
  dumpMoves('offset-single-no-anchor', 'slots-only-absent', noAnchorSlotsOnly.moves)
  dumpMoves('offset-single-no-anchor', 'engagement', noAnchorEngagement.moves)
}

// ── Test runner ──────────────────────────────────────────────────────

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

function specByName(name: string): FixtureSpec {
  const spec = FIXTURES.find((candidate) => candidate.name === name)
  if (!spec) throw new Error(`unknown fixture ${name}`)
  return spec
}

// ── 1. Slots-only byte-identity ───────────────────────────────────────

for (const spec of FIXTURES) {
  test(`${spec.name}: field absent and 'slots_only' emit byte-identical move streams`, () => {
    const { slotsOnlyAbsent, slotsOnlyExplicit } = results.get(spec.name) as CachedResult
    assert(
      JSON.stringify(slotsOnlyAbsent.moves) === JSON.stringify(slotsOnlyExplicit.moves),
      'move streams must be identical field for field, including feedScale presence',
    )
    assert(
      JSON.stringify(slotsOnlyAbsent.warnings) === JSON.stringify(slotsOnlyExplicit.warnings),
      'warnings must be identical',
    )
    assert(slotsOnlyAbsent.engagementTelemetry === undefined, 'slots_only mode must not expose engagement telemetry')
    assert(slotsOnlyExplicit.engagementTelemetry === undefined, 'slots_only mode must not expose engagement telemetry')
  })
}

// ── 2. Output actually changes ────────────────────────────────────────

for (const name of ['offset-single', 'offset-island-single', 'parallel-single', 'parallel-multi', 'finish-offset-single']) {
  test(`${name}: engagement changes the emitted moves`, () => {
    const { slotsOnlyAbsent, engagement } = results.get(name) as CachedResult
    assert(
      JSON.stringify(slotsOnlyAbsent.moves) !== JSON.stringify(engagement.moves),
      'engagement must change the emitted move stream — the field must not be a no-op',
    )
    assert(engagement.engagementTelemetry !== undefined, 'engagement mode must expose telemetry')
  })
}

// ── 3. Corner detection ───────────────────────────────────────────────

const CORNER_PROBE_DISTANCE = TOOL_DIAMETER
const STRAIGHT_CLEARANCE = TOOL_DIAMETER * 2

/**
 * Ring geometry of the offset-single fixture: the 60 mm square pocket region
 * is inset by the tool radius (3) and then by the stepover (2.4) per ring, so
 * ring `k` is a square of half-side `30 - 3 - 2.4 * k`. Ring 0 is the
 * wall-adjacent ring, whose outboard flank the estimator (deliberately, per
 * the S1 contract) counts as stock — the corner-spike claim is asserted on
 * interior rings only.
 */
function ringHalfSide(ring: number): number {
  return 30 - 3 - 2.4 * ring
}

function endpointRing(point: Pick<ToolpathPoint, 'x' | 'y'>): number | null {
  const h = Math.max(Math.abs(point.x), Math.abs(point.y))
  for (let ring = 1; ring <= 11; ring += 1) {
    if (Math.abs(h - ringHalfSide(ring)) <= 0.05) return ring
  }
  return null
}

function cornerDistance(midpoint: Pick<ToolpathPoint, 'x' | 'y'>, ring: number): number {
  const hs = ringHalfSide(ring)
  let best = Number.POSITIVE_INFINITY
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      best = Math.min(best, Math.hypot(midpoint.x - sx * hs, midpoint.y - sy * hs))
    }
  }
  return best
}

function sideMidpointDistance(midpoint: Pick<ToolpathPoint, 'x' | 'y'>, ring: number): number {
  const hs = ringHalfSide(ring)
  return Math.min(
    Math.hypot(midpoint.x, midpoint.y - hs),
    Math.hypot(midpoint.x, midpoint.y + hs),
    Math.hypot(midpoint.x - hs, midpoint.y),
    Math.hypot(midpoint.x + hs, midpoint.y),
  )
}

interface RingPieces {
  cornerPieces: ToolpathMove[]
  straightPieces: ToolpathMove[]
  sideMidPieces: ToolpathMove[]
}

/** Cut pieces lying on ring `ring`, partitioned by neighbourhood. */
function ringPieces(moves: ToolpathMove[], ring: number): RingPieces {
  const cornerPieces: ToolpathMove[] = []
  const straightPieces: ToolpathMove[] = []
  const sideMidPieces: ToolpathMove[] = []
  for (const move of moves) {
    if (move.kind !== 'cut') continue
    if (endpointRing(move.from) !== ring || endpointRing(move.to) !== ring) continue
    const midpoint = {
      x: (move.from.x + move.to.x) / 2,
      y: (move.from.y + move.to.y) / 2,
    }
    if (cornerDistance(midpoint, ring) <= CORNER_PROBE_DISTANCE) cornerPieces.push(move)
    if (cornerDistance(midpoint, ring) >= STRAIGHT_CLEARANCE) straightPieces.push(move)
    if (sideMidpointDistance(midpoint, ring) <= CORNER_PROBE_DISTANCE) sideMidPieces.push(move)
  }
  return { cornerPieces, straightPieces, sideMidPieces }
}

function minScale(pieces: ToolpathMove[]): number {
  assert(pieces.length > 0, 'expected at least one piece')
  let best = Number.POSITIVE_INFINITY
  for (const move of pieces) {
    best = Math.min(best, move.feedScale ?? 1)
  }
  return best
}

test('corner spike lowers the emitted feed within one tool diameter of interior ring corners', () => {
  const { engagement } = results.get('offset-single') as CachedResult
  // Interior rings 1..4: half-side 24.6 down to 17.4, so every side has a
  // straight zone at least two tool diameters from its corners.
  for (let ring = 1; ring <= 4; ring += 1) {
    const pieces = ringPieces(engagement.moves, ring)
    assert(pieces.cornerPieces.length > 0, `ring ${ring}: no corner pieces found`)
    assert(pieces.straightPieces.length > 0, `ring ${ring}: no straight-run pieces found`)
    assert(pieces.sideMidPieces.length > 0, `ring ${ring}: no side-midpoint pieces found`)
    const cornerMin = minScale(pieces.cornerPieces)
    const straightMin = minScale(pieces.straightPieces)
    const sideMidMin = minScale(pieces.sideMidPieces)
    assert(
      cornerMin < straightMin,
      `ring ${ring}: corner scale ${cornerMin} must be strictly below the straight-run scale ${straightMin} — the corner spike was not detected`,
    )
    // Falsifiable, not satisfied: the same strict comparison must fail when
    // the corner neighbourhood is excluded. Side-midpoint pieces are a subset
    // of the straight-run pieces (they sit at least a half-side from every
    // corner), so their minimum can never dip below the straight-run minimum.
    assert(
      !(sideMidMin < straightMin),
      `ring ${ring}: excluding the corner neighbourhood must remove the strict inequality (got ${sideMidMin} < ${straightMin})`,
    )
  }
})

// ── 4. Controller friendliness ────────────────────────────────────────

/**
 * Maximal runs of one scale over consecutive cut moves; non-cut moves break a
 * run. `minHalfSide` is the smallest ring half-side the run touches (the
 * largest coordinate magnitude of any of its moves), which on the offset
 * pattern is the run's local ring size and therefore its scaled minimum
 * fragment length.
 */
function maximalScaleRuns(moves: ToolpathMove[]): Array<{ scale: number; length: number; minHalfSide: number }> {
  const runs: Array<{ scale: number; length: number; minHalfSide: number }> = []
  let currentScale: number | null = null
  let currentLength = 0
  let currentMinHalfSide = Number.POSITIVE_INFINITY
  const flush = (): void => {
    if (currentScale !== null) runs.push({ scale: currentScale, length: currentLength, minHalfSide: currentMinHalfSide })
    currentScale = null
    currentLength = 0
    currentMinHalfSide = Number.POSITIVE_INFINITY
  }
  for (const move of moves) {
    if (move.kind !== 'cut') {
      flush()
      continue
    }
    const scale = move.feedScale ?? 1
    const length = Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y)
    const halfSide = Math.max(Math.abs(move.from.x), Math.abs(move.from.y), Math.abs(move.to.x), Math.abs(move.to.y))
    if (scale === currentScale) {
      currentLength += length
      currentMinHalfSide = Math.min(currentMinHalfSide, halfSide)
    } else {
      flush()
      currentScale = scale
      currentLength = length
      currentMinHalfSide = halfSide
    }
  }
  flush()
  return runs
}

test('controller friendliness: bounded distinct scales and minimum fragment length', () => {
  for (const spec of FIXTURES) {
    const { engagement } = results.get(spec.name) as CachedResult
    const stampedScales = new Set<number>()
    for (const move of engagement.moves) {
      if (move.feedScale !== undefined) stampedScales.add(move.feedScale)
    }
    assert(
      stampedScales.size <= ENGAGEMENT_FEED_BUCKET_COUNT,
      `${spec.name}: ${stampedScales.size} distinct feedScale values exceed the ${ENGAGEMENT_FEED_BUCKET_COUNT}-bucket bound`,
    )
    const runs = maximalScaleRuns(engagement.moves)
    for (let runIndex = 0; runIndex < runs.length; runIndex += 1) {
      const run = runs[runIndex]
      // The offset pattern scales a ring's minimum fragment length down to its
      // half-side (perimeter/8) so a short ring can hold its own fragment; the
      // parallel pattern has no ring tree and keeps the tool-diameter floor.
      const minFragment = spec.pattern === 'offset'
        ? Math.min(MIN_FRAGMENT_LENGTH, run.minHalfSide)
        : MIN_FRAGMENT_LENGTH
      if (run.length >= minFragment - 1e-9) continue
      // A short run next to full feed is a genuine short slot (or a genuine
      // cleared gap) that the S8 fix keeps at its own length instead of
      // merging across the 1.0 ceiling. The minimum fragment rule still binds
      // bucket-to-bucket transitions: a short reduced run whose neighbours are
      // both reduced must still be merged, so it must not appear here.
      const prevScale = runIndex > 0 ? runs[runIndex - 1].scale : null
      const nextScale = runIndex + 1 < runs.length ? runs[runIndex + 1].scale : null
      const adjacentToFull = (prevScale === null || prevScale >= 1) || (nextScale === null || nextScale >= 1)
      const isClearedGap = run.scale >= 1
      // S9: a short reduced run more than one rung above its lower-scale
      // neighbour keeps its own scale — the merge that would drag it to the
      // slot floor is refused. This is the same "genuine short feature" carve-
      // out the S8 fix made for full feed, and it is the fragmentation the
      // arc-run bound (run count ≤ +25%, longest run ≥ 50) tolerates.
      const bucketWidth = (1 - SLOT_SCALE) / (ENGAGEMENT_FEED_BUCKET_COUNT - 1)
      const lowerNeighbour = Math.min(
        prevScale === null ? Number.POSITIVE_INFINITY : prevScale,
        nextScale === null ? Number.POSITIVE_INFINITY : nextScale,
      )
      const refusedMultiRungMerge = run.scale < 1 && lowerNeighbour < run.scale - bucketWidth * (1 + 1e-9)
      assert(
        adjacentToFull || isClearedGap || refusedMultiRungMerge,
        `${spec.name}: scale run ${run.scale} of ${run.length} is shorter than the ${minFragment} minimum fragment length and is not next to full feed`,
      )
    }
  }
})

// ── 4b. A short ring with genuinely varying engagement emits more than one feed value ──
//
// S6's second acceptance test, restated against the production estimator. Ring
// 5.40 (half-side 5.40 mm) is the innermost ring whose measured engagement
// actually varies: each side's middle reports exactly the nominal wrap angle
// (78.46° — feed scale 1.0) while each corner reports 161° (a full-width slot,
// feed scale below 1.0). Its 4.8 mm-wide sibling is, per the conservative
// own-trail exclusion, a genuine full slot at every point and correctly stays
// at the slot scale; this ring is where the reduced feed was previously held
// past the cut that justified it, and it must now emit both scales instead of
// running its whole perimeter at slot feed.

test('the innermost ring whose engagement genuinely varies emits more than one feed value', () => {
  const { engagement } = results.get('offset-single') as CachedResult
  const scales = new Set<number>()
  let sampled = 0
  for (const move of engagement.moves) {
    if (move.kind !== 'cut') continue
    if (endpointRing(move.from) !== 9 && endpointRing(move.to) !== 9) continue
    scales.add(move.feedScale ?? 1)
    sampled += 1
  }
  assert(sampled > 0, 'ring 5.40 must be present in the offset-single fixture')
  assert(scales.size > 1, `ring 5.40 must emit more than one feed value, got ${[...scales].sort((a, b) => a - b).join(', ')}`)
  assert(scales.has(1), 'ring 5.40 must recover to full feed on its nominal runs')
  assert(Math.min(...scales) < 1, 'ring 5.40 must still emit a reduced feed at its corners')
})

// ── 5. Conservative composition ───────────────────────────────────────

/** Cumulative path distance → scale profile of a move stream (absent = 1). */
function scaleProfile(moves: ToolpathMove[]): Array<{ at: number; scale: number }> {
  const profile: Array<{ at: number; scale: number }> = []
  let distance = 0
  for (const move of moves) {
    if (move.kind !== 'cut') continue
    profile.push({ at: distance, scale: move.feedScale ?? 1 })
    distance += Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y)
  }
  profile.push({ at: distance, scale: profile.at(-1)?.scale ?? 1 })
  return profile
}

function profileScaleAt(profile: Array<{ at: number; scale: number }>, distance: number): number {
  let scale = 1
  for (const point of profile) {
    if (point.at <= distance + 1e-9) scale = point.scale
    else break
  }
  return scale
}

/** Squared distance from (px, py) to the segment A→B. */
function pointSegmentDistanceSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax
  const dy = by - ay
  const lenSq = dx * dx + dy * dy
  const t = lenSq > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq)) : 0
  const qx = ax + dx * t - px
  const qy = ay + dy * t - py
  return qx * qx + qy * qy
}

/**
 * Never-raise, measured geometrically (issue #498 slice S2c): every engagement
 * cut move's midpoint is matched to every slots-only cut segment covering it — an
 * index-wise comparison is invalid because the two modes split moves
 * differently — and the engagement scale must never exceed the lowest
 * slots-only scale at that physical location. Fails on the shipped chunkwise
 * clamp, whose slots-only verdicts are captured per chunk and miss a slots-only
 * slot span that a later move retraces (the parallel pattern's boundary
 * contour and first fill line).
 */
test('never-raise, geometric: no engagement move exceeds the slots-only scale covering its midpoint', () => {
  for (const [name, overrides] of [
    ['parallel slot 40', { pocketPattern: 'parallel' as const, pocketAngle: 0, pocketSlotFeedPercent: 40 }],
    ['parallel 45 slot 40', { pocketPattern: 'parallel' as const, pocketAngle: 45, pocketSlotFeedPercent: 40 }],
    ['offset roundOutsideCorners slot 40', { pocketPattern: 'offset' as const, roundOutsideCorners: true, pocketSlotFeedPercent: 40 }],
  ] as Array<[string, Partial<Operation>]>) {
    const spec = specByName(overrides.pocketPattern === 'parallel' ? 'parallel-single' : 'offset-single')
    const { project, operation } = buildFixture(spec, overrides)
    const slotsOnly = generatePocketToolpath(project, { ...operation, pocketFeedReduction: 'slots_only' })
    const engagement = generatePocketToolpath(project, { ...operation, pocketFeedReduction: 'engagement' })
    const slotsOnlyCuts = slotsOnly.moves.filter((move) => move.kind === 'cut')
    for (const move of engagement.moves) {
      if (move.kind !== 'cut') continue
      const mx = (move.from.x + move.to.x) / 2
      const my = (move.from.y + move.to.y) / 2
      let lowestSlotsOnly = 1
      let covered = false
      for (const candidate of slotsOnlyCuts) {
        if (pointSegmentDistanceSq(mx, my, candidate.from.x, candidate.from.y, candidate.to.x, candidate.to.y) <= 1e-12) {
          covered = true
          lowestSlotsOnly = Math.min(lowestSlotsOnly, candidate.feedScale ?? 1)
        }
      }
      assert(covered, `${name}: engagement midpoint (${mx.toFixed(2)}, ${my.toFixed(2)}) is covered by no slots-only cut segment`)
      assert(
        (move.feedScale ?? 1) <= lowestSlotsOnly + 1e-12,
        `${name}: engagement scale ${move.feedScale ?? 1} exceeds the slots-only scale ${lowestSlotsOnly} covering its midpoint (${mx.toFixed(2)}, ${my.toFixed(2)})`,
      )
    }
  }
})

test('conservative composition: engagement never carries a higher feedScale than slots_only', () => {
  for (const spec of FIXTURES) {
    const { slotsOnlyAbsent, engagement } = results.get(spec.name) as CachedResult
    const engagementProfile = scaleProfile(engagement.moves)
    const slotsOnlyProfile = scaleProfile(slotsOnlyAbsent.moves)
    const engagementTotal = engagementProfile.at(-1)?.at ?? 0
    const slotsOnlyTotal = slotsOnlyProfile.at(-1)?.at ?? 0
    assert(
      Math.abs(engagementTotal - slotsOnlyTotal) < 1e-6,
      `${spec.name}: both streams must cover the same path (${engagementTotal} vs ${slotsOnlyTotal})`,
    )
    const distances = [...new Set(
      [...engagementProfile, ...slotsOnlyProfile]
        .map((point) => point.at)
        .filter((distance) => distance < engagementTotal - 1e-9),
    )].sort((a, b) => a - b)
    for (const distance of distances) {
      const engagementScale = profileScaleAt(engagementProfile, distance)
      const slotsOnlyScale = profileScaleAt(slotsOnlyProfile, distance)
      assert(
        engagementScale <= slotsOnlyScale + 1e-12,
        `${spec.name}: engagement scale ${engagementScale} exceeds slots_only ${slotsOnlyScale} at path distance ${distance}`,
      )
    }
  }
})

// ── 5b. Per-band classification cache ─────────────────────────────────
//
// The offset ring tree is Z-invariant, so the engagement classification of a
// ring segment is computed once per band and every level looks it up by
// canonical segment identity — never by emission order, which the greedy
// traversal reseeds per level. Two proofs: (1) on a three-lobe fixture the
// per-level ring orders actually differ, and the cached classification still
// equals an independent emission-order recomputation at every chunk of every
// level; (2) call-count probes show the swept-material index is built once
// per band and reused per level (cost counted, never timed).

function makeCircleFeature(id: string, cx: number, cy: number, r: number, zTop: number, zBottom: number): SketchFeature {
  return {
    id,
    name: id,
    kind: 'circle',
    folderId: null,
    sketch: {
      profile: circleProfile(cx, cy, r),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    z_top: zTop,
    z_bottom: zBottom,
    visible: true,
    locked: false,
  }
}

/** Three-lobe pocket: circles at x = −22, 0, 22, radius 10, so adjacent lobe
 * rings stay ≥ 8 mm apart — beyond the 2r = 6 mm cross-lobe influence — while
 * the lobes share one band, so the level-to-level tree order is free to vary. */
function buildThreeLobeFixture(): { project: Project; operation: Operation } {
  const zTop = 4
  const features = [
    makeCircleFeature('lobe-1', -22, 0, 10, zTop, 0),
    makeCircleFeature('lobe-2', 0, 0, 10, zTop, 0),
    makeCircleFeature('lobe-3', 22, 0, 10, zTop, 0),
  ]
  const project = projectWithFeatures({
    ...newProject('three-lobe', 'mm'),
    tools: [makeTool()],
  }, features)
  const operation: Operation = {
    id: 'op-1',
    name: 'op',
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: ['lobe-1', 'lobe-2', 'lobe-3'] },
    toolRef: 'tool-1',
    stepdown: 2,
    stepover: 0.4,
    feed: 800,
    plungeFeed: 300,
    rpm: 18000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    pocketSlotFeedPercent: 40,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 2,
    maxCarveDepth: 2,
    cutDirection: 'conventional',
    machiningOrder: 'level_first',
  }
  return { project, operation }
}

test('cache equivalence: each distinct level traversal gets an exact classification', () => {
  const { project, operation } = buildThreeLobeFixture()
  // The raw (unsplit) move stream: engagement mode without a slot anchor emits
  // exactly the generated moves, so per-level cut sequences come from here.
  resetEngagementCacheProbeCounts()
  const raw = generatePocketToolpath(project, { ...operation, pocketFeedReduction: 'engagement', pocketSlotFeedPercent: undefined })
  const rawCuts = raw.moves.filter((move) => move.kind === 'cut')
  // The level cut sequences, in emission order, grouped by level z.
  const levels: ToolpathMove[][] = []
  for (const move of rawCuts) {
    const existing = levels.find((level) => level[0].from.z === move.from.z)
    if (existing) {
      existing.push(move)
    } else {
      levels.push([move])
    }
  }
  assert(levels.length >= 2, `the fixture must cut at least two step levels, got ${levels.length}`)

  // Label each move by its lobe (nearest circle centre). The fixture proves
  // that position seeding can produce genuinely different level traversals.
  const lobeCenters = [
    { x: -22, y: 0 },
    { x: 0, y: 0 },
    { x: 22, y: 0 },
  ]
  const labelSequence = (level: ToolpathMove[]): number[] =>
    level.map((move) => {
      const mx = (move.from.x + move.to.x) / 2
      const my = (move.from.y + move.to.y) / 2
      let best = 0
      let bestDistance = Number.POSITIVE_INFINITY
      lobeCenters.forEach((center, index) => {
        const distance = Math.hypot(mx - center.x, my - center.y)
        if (distance < bestDistance) {
          bestDistance = distance
          best = index
        }
      })
      return best
    })
  const firstLabels = labelSequence(levels[0])
  const secondLabels = labelSequence(levels[1])
  assert(
    JSON.stringify(firstLabels) !== JSON.stringify(secondLabels),
    `the fixture must exercise distinct traversal orders (got ${firstLabels.join('')} vs ${secondLabels.join('')})`,
  )
  const counts = engagementCacheProbeCounts()
  assert(counts.bandCacheBuilds === 2, `two distinct traversals must build two classifications, got ${counts.bandCacheBuilds}`)
  assert(counts.cacheLevelUses === 2, `both levels must consume an exact classification, got ${counts.cacheLevelUses}`)
  assert(counts.cacheMisses === 0, `exact traversal classifications must have zero misses, got ${counts.cacheMisses}`)

  // Each distinct ordered stream gets an exact cache. Index plus coordinates
  // are checked, so repeated geometry cannot silently reuse another
  // occurrence's engagement context.
  for (const level of levels) {
    const cache = buildOffsetBandEngagementClassification(level, 0, level.length, {
      toolRadius: 3,
      ringPerimeters: new Map(),
    })
    assert(cache.segmentCount === level.length, 'the exact classification must cover every emitted cut')
    assert(cache.indexEntryCount > 0, 'the classification must build a swept-material index')
    level.forEach((move, cutIndex) => {
      const cached = cache.chunksForMove(
        cutIndex,
        move.from.x,
        move.from.y,
        move.to.x,
        move.to.y,
      )
      assert(cached !== null, `cut ${cutIndex} must match the cached traversal occurrence`)
    })
  }
})

test('cost probe: identical level traversals reuse one classification', () => {
  const spec = specByName('offset-multi')
  const { project, operation } = buildFixture(spec)
  resetEngagementCacheProbeCounts()
  generatePocketToolpath(project, { ...operation, pocketFeedReduction: 'engagement' })
  const engagementCounts = engagementCacheProbeCounts()
  assert(
    engagementCounts.bandCacheBuilds === 1,
    `the identical traversal must be classified once, got ${engagementCounts.bandCacheBuilds} builds`,
  )
  assert(
    engagementCounts.cacheLevelUses === 2,
    `both step levels must consume the one build, got ${engagementCounts.cacheLevelUses} level uses`,
  )
  resetEngagementCacheProbeCounts()
  generatePocketToolpath(project, { ...operation, pocketFeedReduction: 'slots_only' })
  const slotsOnlyCounts = engagementCacheProbeCounts()
  assert(slotsOnlyCounts.bandCacheBuilds === 0 && slotsOnlyCounts.cacheLevelUses === 0, 'slots_only mode must build no classification')
  resetEngagementCacheProbeCounts()
  generatePocketToolpath(project, { ...operation, pocketFeedReduction: 'engagement', pocketPattern: 'parallel' })
  const parallelCounts = engagementCacheProbeCounts()
  assert(
    parallelCounts.bandCacheBuilds === 0 && parallelCounts.cacheLevelUses === 0,
    'the parallel pattern has no ring tree and must not build a band classification',
  )
})

// ── 5c. Depth invariance and miss observability (S2d) ─────────────────
//
// The band's ring tree is Z-invariant, so the emitted feed pattern must be
// too. S2c's cache already classified every ring segment once, but
// the emitted stream still drifted with depth for two reasons: the
// never-raise clamp's `legacySlotSpans` collected spans from the whole
// accumulated move array, so each deeper level clamped against its own
// shallower siblings' engagement-stamped fragments (measured: the span set
// grew 3 → 95 → 184 → 272 → 356 over five levels, and the slot-feed share
// grew 35.4% → 71.2%); and the inter-ring link cuts were never classified,
// so every level resolved them to full engagement. Both are fixed: the
// clamp is level-scoped and exact traversal caches classify links too.
// The depth-invariance property below failed before the fix (fed sequences
// differed at every level) and passes after it. Cache misses are counted
// and asserted so a silent conservative fallback can never hide a
// classification regression again.

test('depth invariance: every level emits the same fed-move count, XY sequence, and feedScale sequence', () => {
  const spec = specByName('offset-multi')
  const { project, operation } = buildFixture(spec)
  const engagement = generatePocketToolpath(project, { ...operation, pocketFeedReduction: 'engagement' })
  const levels: ToolpathMove[][] = []
  for (const move of engagement.moves) {
    if (move.kind !== 'cut') continue
    const existing = levels.find((level) => level[0].from.z === move.from.z)
    if (existing) existing.push(move)
    else levels.push([move])
  }
  assert(levels.length >= 2, `the fixture must cut at least two step levels, got ${levels.length}`)
  const fedPattern = (level: ToolpathMove[]): string[] =>
    level
      .filter((move) => move.feedScale !== undefined)
      .map((move) => `${move.feedScale}:${move.from.x},${move.from.y}>${move.to.x},${move.to.y}`)
  const first = fedPattern(levels[0])
  assert(first.length > 0, 'the fixture must emit some fed moves')
  for (let index = 1; index < levels.length; index += 1) {
    const other = fedPattern(levels[index])
    assert(
      other.length === first.length,
      `level ${index}: fed-move count ${other.length} must equal level 0's ${first.length}`,
    )
    assert(
      JSON.stringify(other) === JSON.stringify(first),
      `level ${index}: the fed XY and feedScale sequence must match level 0's`,
    )
  }
})

test('exact traversal caches serve every offset cut without a conservative miss fallback', () => {
  for (const name of ['offset-single', 'offset-multi', 'offset-island-single', 'offset-island-multi']) {
    const spec = specByName(name)
    const { project, operation } = buildFixture(spec)
    resetEngagementCacheProbeCounts()
    generatePocketToolpath(project, { ...operation, pocketFeedReduction: 'engagement' })
    const counts = engagementCacheProbeCounts()
    assert(
      counts.cacheMisses === 0,
      `${name}: every emitted cut must hit its exact traversal cache, got ${counts.cacheMisses} misses`,
    )
  }
  // The parallel pattern has no ring tree, builds no canonical cache, and
  // classifies per level — nothing can miss.
  for (const name of ['parallel-single', 'parallel-multi']) {
    const spec = specByName(name)
    const { project, operation } = buildFixture(spec)
    resetEngagementCacheProbeCounts()
    generatePocketToolpath(project, { ...operation, pocketFeedReduction: 'engagement' })
    const counts = engagementCacheProbeCounts()
    assert(
      counts.bandCacheBuilds === 0 && counts.cacheMisses === 0,
      `${name}: the parallel pattern builds no cache and must record no misses`,
    )
  }
})

// ── 6. Determinism ────────────────────────────────────────────────────

test('determinism: repeated generation produces identical move streams', () => {
  for (const name of ['offset-single', 'parallel-island-multi']) {
    const spec = specByName(name)
    const { project, operation } = buildFixture(spec)
    const engagementOp = { ...operation, pocketFeedReduction: 'engagement' as const }
    const first = generatePocketToolpath(project, engagementOp)
    const second = generatePocketToolpath(project, engagementOp)
    assert(JSON.stringify(first.moves) === JSON.stringify(second.moves), `${name}: moves must be deterministic`)
    assert(
      JSON.stringify(first.engagementTelemetry) === JSON.stringify(second.engagementTelemetry),
      `${name}: telemetry must be deterministic`,
    )
  }
})

// ── 7. Telemetry and the no-anchor rule ───────────────────────────────

test('engagement telemetry records the corner spike on a square pocket', () => {
  const { engagement } = results.get('offset-single') as CachedResult
  const telemetry = engagement.engagementTelemetry
  assert(telemetry !== undefined, 'engagement mode must expose telemetry')
  // The manager measured the spike at 2.9404 rad against a nominal of
  // 1.3695 rad on this exact fixture; sampling must capture at least 2.7.
  assert(
    telemetry.maxEngagement >= 2.7,
    `max engagement ${telemetry.maxEngagement} must reflect the measured corner spike`,
  )
  assert(
    telemetry.p95Engagement < telemetry.maxEngagement,
    `p95 ${telemetry.p95Engagement} must sit below the corner-spike max ${telemetry.maxEngagement}`,
  )
  assert(telemetry.totalCutDistance > 0, 'total cut distance must be positive')
  assert(telemetry.distanceAboveNominal > 0, 'some path distance must be cut above the nominal engagement')
})

test('engagement mode without a slot percent applies no scaling but records telemetry', () => {
  const spec = specByName('offset-single')
  const { project, operation } = buildFixture(spec, { pocketSlotFeedPercent: undefined })
  const engagement = generatePocketToolpath(project, { ...operation, pocketFeedReduction: 'engagement' })
  const slotsOnly = generatePocketToolpath(project, operationWithoutPocketFeedReduction(operation))
  assert(
    JSON.stringify(engagement.moves) === JSON.stringify(slotsOnly.moves),
    'no pocketSlotFeedPercent anchor means no scaling — the move stream must match slots_only',
  )
  assert(
    engagement.moves.every((move) => move.feedScale === undefined),
    'no feedScale stamps without an anchor',
  )
  assert(engagement.engagementTelemetry !== undefined, 'telemetry is still recorded')
})

// ── 8. S8: no reduced feed into already-cleared material ──────────────
//
// The defect reproduced from real use (issue #498, slice S8): after a genuine
// slot the quantizer's rise hysteresis and minimum fragment length carried the
// reduced feed into moves cutting already-cleared material. The property
// restates the manager's probe — walk the emitted cut moves, measure each
// against everything swept before it with the estimator, and require that a
// move whose measured engagement is at or below nominal never emits the slot
// feed. It failed with 146 violations before the fix and must be zero after.

/**
 * Number of emitted cut moves that carry the slot feed while the estimator
 * measures them at or below the operation's nominal engagement. Moves are
 * measured against everything swept before them in emission order, sampled at
 * three interior points (the production sampler takes the max over the same
 * points). Near-zero tessellation fragments — shorter than a tenth of a tool
 * diameter — are excluded: they are degenerate duplicate points, not cuts.
 */
function slotFeedIntoClearedCount(project: Project, operation: Operation): number {
  const tool = project.tools.find((candidate) => candidate.id === operation.toolRef)
  if (!tool) throw new Error('the fixture must reference a tool')
  const toolRadius = tool.diameter / 2
  const slotScale = Math.min(1, Math.max(0, (operation.pocketSlotFeedPercent ?? 100) / 100))
  const nominal = nominalEngagement(tool.diameter * operation.stepover, toolRadius)
  const result = generatePocketToolpath(project, { ...operation, pocketFeedReduction: 'engagement' })
  const index = new SweptMaterialIndex(toolRadius)
  let violations = 0
  for (const move of result.moves) {
    if (move.kind !== 'cut') continue
    const length = Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y)
    if (length < toolRadius / 10) continue
    const dirX = (move.to.x - move.from.x) / length
    const dirY = (move.to.y - move.from.y) / length
    let engagement = 0
    for (let point = 1; point <= 3; point += 1) {
      const t = point / 4
      const sample = index.engagementAt(
        move.from.x + (move.to.x - move.from.x) * t,
        move.from.y + (move.to.y - move.from.y) * t,
        dirX,
        dirY,
      )
      if (sample > engagement) engagement = sample
    }
    if ((move.feedScale ?? 1) <= slotScale + 1e-9 && engagement <= nominal + ENGAGEMENT_ESTIMATE_EPSILON) {
      violations += 1
    }
    index.addSweptSegment(move.from.x, move.from.y, move.to.x, move.to.y)
  }
  return violations
}

test('S8: the inch feed-reduction fixture emits no slot feed into material at or below nominal', () => {
  const project = normalizeProject(
    JSON.parse(readFileSync(join('src', 'engine', 'test-fixtures', 'pocket-feed-reduction.camj'), 'utf8')) as Project,
  )
  const operation = project.operations.find((candidate) => candidate.kind === 'pocket')
  assert(operation !== undefined, 'the fixture must contain a pocket operation')
  resetEngagementCacheProbeCounts()
  const violations = slotFeedIntoClearedCount(project, operation)
  assert(violations === 0, `${violations} fed moves cut already-cleared material at slot feed`)
  // The first fixture with feature definitions/instances and inch units: pin
  // the per-band cache miss count rather than leaving it unbounded.
  const misses = engagementCacheProbeCounts().cacheMisses
  assert(misses === 0, `the inch fixture must be fully served by the per-band cache, got ${misses} misses`)
})

test('S8: a synthetic island fixture also emits no slot feed into cleared material', () => {
  const spec = specByName('offset-island-single')
  const { project, operation } = buildFixture(spec, { pocketSlotFeedPercent: 40, roundOutsideCorners: true })
  const violations = slotFeedIntoClearedCount(project, operation)
  assert(violations === 0, `${violations} synthetic-island fed moves cut already-cleared material at slot feed`)
})

test('cached offset engagement uses the emitted prior-cut context on the real island fixture', () => {
  const project = normalizeProject(
    JSON.parse(readFileSync(join('src', 'engine', 'test-fixtures', 'pocket-feed-reduction.camj'), 'utf8')) as Project,
  )
  const operation = project.operations.find((candidate) => candidate.kind === 'pocket')
  assert(operation !== undefined, 'the fixture must contain a pocket operation')
  const result = generatePocketToolpath(project, { ...operation, pocketFeedReduction: 'engagement' })
  const target = result.moves.find((move) =>
    move.kind === 'cut'
    && Math.abs(move.from.y - 0.705) < 1e-6
    && Math.abs(move.to.y - 0.705) < 1e-6
    && Math.min(move.from.x, move.to.x) <= 2
    && Math.max(move.from.x, move.to.x) >= 2,
  )
  assert(target !== undefined, 'the fixture must emit the long outer island pass through x=2, y=0.705')
  assert(
    Math.abs((target.feedScale ?? 1) - 0.92) <= 1e-12,
    `the 74-degree outer pass is entitled to the 0.92 rung, got ${target.feedScale ?? 1}`,
  )
})

// ── 9. S9: no move may emit below its own engagement entitlement ─────
//
// The defect (issue #498, slice S9): bucket-to-bucket merges take the LOWER
// scale, so a fragment entitled to a near-full scale that merely touches a
// slot is dragged to the slot floor. The fix refuses a minimum-fragment merge
// that would lower the higher-scale stretch by more than one rung, so the
// fragment keeps its own scale. The property below restates the manager's
// probe: walk the emitted cut moves, measure each against everything swept
// before it with the estimator, and require the emitted scale to be at least
// `engagementFeedScale(e, nominal, slot)` for that point's engagement. It is
// asserted as a bound on over-slowed path length because one emitted fragment
// intentionally spans several sampled chunks and therefore carries one
// conservative scale across locally varying entitlement.

/**
 * Path length, in project units, cut at a feed scale strictly below the
 * entitlement `engagementFeedScale(e, nominal, slot)` of the point's own
 * measured engagement. Each emitted cut move is sampled every half tool radius
 * against a fresh swept-material index in emission order (the manager's probe),
 * so a merged move that spans both a genuine slot and a higher-entitlement
 * fragment is measured at the resolution that exposes the fragment.
 */
function overSlowedPathLength(project: Project, operation: Operation): number {
  const tool = project.tools.find((candidate) => candidate.id === operation.toolRef)
  if (!tool) throw new Error('the fixture must reference a tool')
  const toolRadius = tool.diameter / 2
  const slotScale = Math.min(1, Math.max(0, (operation.pocketSlotFeedPercent ?? 100) / 100))
  const nominal = nominalEngagement(tool.diameter * operation.stepover, toolRadius)
  const result = generatePocketToolpath(project, { ...operation, pocketFeedReduction: 'engagement' })
  const index = new SweptMaterialIndex(toolRadius)
  const step = toolRadius / 2
  let overSlowed = 0
  for (const move of result.moves) {
    if (move.kind !== 'cut') continue
    const length = Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y)
    if (length < toolRadius / 10) continue
    const dirX = (move.to.x - move.from.x) / length
    const dirY = (move.to.y - move.from.y) / length
    const emitted = move.feedScale ?? 1
    const samples = Math.max(1, Math.floor(length / step))
    const sampleStep = length / samples
    for (let sample = 0; sample < samples; sample += 1) {
      const t = (sample + 0.5) / samples
      const engagement = index.engagementAt(
        move.from.x + (move.to.x - move.from.x) * t,
        move.from.y + (move.to.y - move.from.y) * t,
        dirX,
        dirY,
      )
      if (emitted < engagementFeedScale(engagement, nominal, slotScale) - 1e-12) {
        overSlowed += sampleStep
      }
    }
    index.addSweptSegment(move.from.x, move.from.y, move.to.x, move.to.y)
  }
  return overSlowed
}

/**
 * Maximal contiguous cut runs sharing a feed scale — the arc-fitting proxy the
 * probe reports. Matches `scripts/pocket-output-probe.ts` `arcRuns` so the run
 * counts are directly comparable with the handoff's table (12→61, 33→84).
 */
function arcRunStats(moves: ToolpathMove[]): { runs: number; longest: number } {
  const cutKinds = new Set(['cut', 'lead-in', 'lead-out'])
  let runs = 0
  let longest = 0
  let current = 0
  let previousScale: number | null | undefined
  let previousTo: ToolpathPoint | null = null
  for (const move of moves) {
    if (!cutKinds.has(move.kind)) {
      if (current > 0) runs += 1
      longest = Math.max(longest, current)
      current = 0
      previousScale = undefined
      previousTo = null
      continue
    }
    const contiguous = previousTo !== null
      && Math.hypot(move.from.x - previousTo.x, move.from.y - previousTo.y, move.from.z - previousTo.z) < 1e-6
    if (current > 0 && contiguous && (move.feedScale ?? 1) === previousScale) {
      current += 1
    } else {
      if (current > 0) runs += 1
      longest = Math.max(longest, current)
      current = 1
    }
    previousScale = move.feedScale ?? 1
    previousTo = move.to
  }
  if (current > 0) runs += 1
  longest = Math.max(longest, current)
  return { runs, longest }
}

const S9_FIXTURE_NAMES = [
  'pocket-feed-reduction',
  'pocket-feed-reduction-2',
  'pocket-feed-reduction-3',
  'pocket-feed-reduction-parallel',
  'pocket-feed-reduction-parallel-2',
] as const

/** Over-slowed path length bound per inch fixture (project units, inches). */
const S9_OVER_SLOWED_BOUND_INCHES: Record<string, number> = {
  'pocket-feed-reduction': 8.6,
  'pocket-feed-reduction-2': 9.8,
  'pocket-feed-reduction-3': 6.8,
  'pocket-feed-reduction-parallel': 7.6,
  'pocket-feed-reduction-parallel-2': 8.2,
}

test('S9: over-slowed path length is bounded on every feed-reduction fixture', () => {
  for (const name of S9_FIXTURE_NAMES) {
    const project = normalizeProject(
      JSON.parse(readFileSync(join('src', 'engine', 'test-fixtures', `${name}.camj`), 'utf8')) as Project,
    )
    const operation = project.operations.find((candidate) => candidate.kind === 'pocket')
    assert(operation !== undefined, `${name}: the fixture must contain a pocket operation`)
    const overSlowed = overSlowedPathLength(project, operation)
    const bound = S9_OVER_SLOWED_BOUND_INCHES[name]
    assert(
      overSlowed <= bound + 1e-9,
      `${name}: ${overSlowed.toFixed(3)}in over-slowed exceeds the ${bound}in bound`,
    )
  }
})

test('S9: a synthetic island fixture also keeps over-slowed path length bounded', () => {
  const spec = specByName('offset-island-single')
  const { project, operation } = buildFixture(spec, { pocketSlotFeedPercent: 40, roundOutsideCorners: true })
  const overSlowed = overSlowedPathLength(project, operation)
  // The synthetic mm fixture's slot is 40%, so its bound is expressed as a
  // fraction of its own cut path rather than the inch fixtures' inch bound.
  const totalCut = generatePocketToolpath(project, { ...operation, pocketFeedReduction: 'engagement' }).moves
    .filter((move) => move.kind === 'cut')
    .reduce((sum, move) => sum + Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y), 0)
  assert(
    overSlowed / totalCut <= 0.20,
    `synthetic island: ${((overSlowed / totalCut) * 100).toFixed(1)}% of the cut path over-slowed exceeds the 20% bound`,
  )
})

test('S9: the arc-run constraint holds — runs stay within +25%, longest run stays ≥ 50', () => {
  const cases = [
    { name: 'pocket-feed-reduction', engagementRuns: 61, longestFloor: 50 },
    { name: 'pocket-feed-reduction-parallel-2', engagementRuns: 84, longestFloor: 0 },
  ] as const
  for (const fixture of cases) {
    const project = normalizeProject(
      JSON.parse(readFileSync(join('src', 'engine', 'test-fixtures', `${fixture.name}.camj`), 'utf8')) as Project,
    )
    const operation = project.operations.find((candidate) => candidate.kind === 'pocket')
    assert(operation !== undefined, `${fixture.name}: the fixture must contain a pocket operation`)
    const { runs, longest } = arcRunStats(
      generatePocketToolpath(project, { ...operation, pocketFeedReduction: 'engagement' }).moves,
    )
    const runBound = Math.ceil(fixture.engagementRuns * 1.25)
    assert(runs <= runBound, `${fixture.name}: ${runs} runs exceed the ${runBound} bound (+25% over ${fixture.engagementRuns})`)
    if (fixture.longestFloor > 0) {
      assert(longest >= fixture.longestFloor, `${fixture.name}: longest run ${longest} fell below ${fixture.longestFloor}`)
    }
  }
})

test('issue #517: the worst real fixture keeps exact index work bounded', () => {
  const project = normalizeProject(
    JSON.parse(readFileSync(join('src', 'engine', 'test-fixtures', 'pocket-feed-reduction-3.camj'), 'utf8')) as Project,
  )
  const operation = project.operations.find((candidate) => candidate.kind === 'pocket')
  assert(operation !== undefined, 'the fixture must contain a pocket operation')
  const tool = project.tools.find((candidate) => candidate.id === operation.toolRef)
  assert(tool !== undefined, 'the fixture operation must resolve its tool')
  const raw = generatePocketToolpath(project, { ...operation, pocketFeedReduction: 'slots_only' })
  const classification = buildOffsetBandEngagementClassification(raw.moves, 0, raw.moves.length, {
    toolRadius: tool.diameter / 2,
    ringPerimeters: new Map(),
  })

  // Measured on this exact fixture: 1,033,682 scanned candidates and 400,366
  // trigonometric candidates. The caps leave 66,318 / 24,634 candidates of
  // headroom, while restoring the repeated dilation path scans 1,616,690.
  assert(
    classification.queryStats.capsulesScanned <= 1_100_000,
    `worst fixture scanned ${classification.queryStats.capsulesScanned} capsules (bound 1,100,000)`,
  )
  assert(
    classification.queryStats.capsulesTrigTested <= 425_000,
    `worst fixture sent ${classification.queryStats.capsulesTrigTested} capsules to trig (bound 425,000)`,
  )
})

// ── Summary ──

console.log(`\nengagementPocket: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
