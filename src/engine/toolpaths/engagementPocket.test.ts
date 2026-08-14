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
 * `pocketEngagementMode` on pocket clearing.
 *
 * The legacy byte-identity invariant is proven two ways: JSON equality between
 * the field-absent and field-'legacy' move streams in-process, and — when
 * `ENGAGEMENT_DUMP_DIR` is set — a full JSON dump of every fixture's move
 * stream for diffing against the pre-change tree (see the slice's required
 * checks).
 *
 * Run with: npx tsx src/engine/toolpaths/engagementPocket.test.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import ClipperLib from 'clipper-lib'
import type { Operation, Project, SketchFeature, Tool } from '../../types/project'
import { circleProfile, defaultTool, newProject, rectProfile } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import { ENGAGEMENT_FEED_BUCKET_COUNT, SweptMaterialIndex } from './engagement'
import {
  buildInsetRegions,
  buildOffsetBandEngagementClassification,
  buildOffsetRegionTree,
  engagementCacheProbeCounts,
  generatePocketToolpath,
  resetEngagementCacheProbeCounts,
} from './pocket'
import { resolvePocketRegions } from './resolver'
import type { PocketToolpathResult, ToolpathMove, ToolpathPoint } from './types'

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

// ── Fixtures ─────────────────────────────────────────────────────────

const TOOL_DIAMETER = 6
/** Configured minimum fragment length of the engagement feed path (a tool diameter). */
const MIN_FRAGMENT_LENGTH = TOOL_DIAMETER

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

function operationWithoutPocketEngagementMode(operation: Operation): Operation {
  const copy = { ...operation }
  delete copy.pocketEngagementMode
  return copy
}

interface CachedResult {
  legacyAbsent: PocketToolpathResult
  legacyExplicit: PocketToolpathResult
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
  const legacyAbsent = generatePocketToolpath(project, operationWithoutPocketEngagementMode(operation))
  const legacyExplicit = generatePocketToolpath(project, { ...operation, pocketEngagementMode: 'legacy' })
  const engagement = generatePocketToolpath(project, { ...operation, pocketEngagementMode: 'engagement_feed' })
  dumpMoves(key, 'legacy-absent', legacyAbsent.moves)
  dumpMoves(key, 'legacy-explicit', legacyExplicit.moves)
  dumpMoves(key, 'engagement', engagement.moves)
  return { legacyAbsent, legacyExplicit, engagement }
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
  const noAnchorLegacy = generatePocketToolpath(project, operationWithoutPocketEngagementMode(operation))
  const noAnchorEngagement = generatePocketToolpath(project, { ...operation, pocketEngagementMode: 'engagement_feed' })
  dumpMoves('offset-single-no-anchor', 'legacy-absent', noAnchorLegacy.moves)
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

// ── 1. Legacy byte-identity ───────────────────────────────────────────

for (const spec of FIXTURES) {
  test(`${spec.name}: field absent and 'legacy' emit byte-identical move streams`, () => {
    const { legacyAbsent, legacyExplicit } = results.get(spec.name) as CachedResult
    assert(
      JSON.stringify(legacyAbsent.moves) === JSON.stringify(legacyExplicit.moves),
      'move streams must be identical field for field, including feedScale presence',
    )
    assert(
      JSON.stringify(legacyAbsent.warnings) === JSON.stringify(legacyExplicit.warnings),
      'warnings must be identical',
    )
    assert(legacyAbsent.engagementTelemetry === undefined, 'legacy mode must not expose engagement telemetry')
    assert(legacyExplicit.engagementTelemetry === undefined, 'legacy mode must not expose engagement telemetry')
  })
}

// ── 2. Output actually changes ────────────────────────────────────────

for (const name of ['offset-single', 'offset-island-single', 'parallel-single', 'parallel-multi', 'finish-offset-single']) {
  test(`${name}: engagement_feed changes the emitted moves`, () => {
    const { legacyAbsent, engagement } = results.get(name) as CachedResult
    assert(
      JSON.stringify(legacyAbsent.moves) !== JSON.stringify(engagement.moves),
      'engagement_feed must change the emitted move stream — the field must not be a no-op',
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

/** Maximal runs of one scale over consecutive cut moves; non-cut moves break a run. */
function maximalScaleRuns(moves: ToolpathMove[]): Array<{ scale: number; length: number }> {
  const runs: Array<{ scale: number; length: number }> = []
  let currentScale: number | null = null
  let currentLength = 0
  for (const move of moves) {
    if (move.kind !== 'cut') {
      if (currentScale !== null) {
        runs.push({ scale: currentScale, length: currentLength })
        currentScale = null
        currentLength = 0
      }
      continue
    }
    const scale = move.feedScale ?? 1
    const length = Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y)
    if (scale === currentScale) {
      currentLength += length
    } else {
      if (currentScale !== null) runs.push({ scale: currentScale, length: currentLength })
      currentScale = scale
      currentLength = length
    }
  }
  if (currentScale !== null) runs.push({ scale: currentScale, length: currentLength })
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
    for (const run of maximalScaleRuns(engagement.moves)) {
      assert(
        run.length >= MIN_FRAGMENT_LENGTH - 1e-9,
        `${spec.name}: scale run ${run.scale} of ${run.length} is shorter than the ${MIN_FRAGMENT_LENGTH} minimum fragment length`,
      )
    }
  }
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
 * cut move's midpoint is matched to every legacy cut segment covering it — an
 * index-wise comparison is invalid because the two modes split moves
 * differently — and the engagement scale must never exceed the lowest legacy
 * scale at that physical location. Fails on the shipped chunkwise clamp, whose
 * legacy verdicts are captured per chunk and miss a legacy slot span that a
 * later move retraces (the parallel pattern's boundary contour and first fill
 * line).
 */
test('never-raise, geometric: no engagement move exceeds the legacy scale covering its midpoint', () => {
  for (const [name, overrides] of [
    ['parallel slot 40', { pocketPattern: 'parallel' as const, pocketAngle: 0, pocketSlotFeedPercent: 40 }],
    ['parallel 45 slot 40', { pocketPattern: 'parallel' as const, pocketAngle: 45, pocketSlotFeedPercent: 40 }],
    ['offset roundOutsideCorners slot 40', { pocketPattern: 'offset' as const, roundOutsideCorners: true, pocketSlotFeedPercent: 40 }],
  ] as Array<[string, Partial<Operation>]>) {
    const spec = specByName(overrides.pocketPattern === 'parallel' ? 'parallel-single' : 'offset-single')
    const { project, operation } = buildFixture(spec, overrides)
    const legacy = generatePocketToolpath(project, { ...operation, pocketEngagementMode: 'legacy' })
    const engagement = generatePocketToolpath(project, { ...operation, pocketEngagementMode: 'engagement_feed' })
    const legacyCuts = legacy.moves.filter((move) => move.kind === 'cut')
    for (const move of engagement.moves) {
      if (move.kind !== 'cut') continue
      const mx = (move.from.x + move.to.x) / 2
      const my = (move.from.y + move.to.y) / 2
      let lowestLegacy = 1
      let covered = false
      for (const candidate of legacyCuts) {
        if (pointSegmentDistanceSq(mx, my, candidate.from.x, candidate.from.y, candidate.to.x, candidate.to.y) <= 1e-12) {
          covered = true
          lowestLegacy = Math.min(lowestLegacy, candidate.feedScale ?? 1)
        }
      }
      assert(covered, `${name}: engagement midpoint (${mx.toFixed(2)}, ${my.toFixed(2)}) is covered by no legacy cut segment`)
      assert(
        (move.feedScale ?? 1) <= lowestLegacy + 1e-12,
        `${name}: engagement scale ${move.feedScale ?? 1} exceeds the legacy scale ${lowestLegacy} covering its midpoint (${mx.toFixed(2)}, ${my.toFixed(2)})`,
      )
    }
  }
})

test('conservative composition: engagement mode never carries a higher feedScale than legacy', () => {
  for (const spec of FIXTURES) {
    const { legacyAbsent, engagement } = results.get(spec.name) as CachedResult
    const engagementProfile = scaleProfile(engagement.moves)
    const legacyProfile = scaleProfile(legacyAbsent.moves)
    const engagementTotal = engagementProfile.at(-1)?.at ?? 0
    const legacyTotal = legacyProfile.at(-1)?.at ?? 0
    assert(
      Math.abs(engagementTotal - legacyTotal) < 1e-6,
      `${spec.name}: both streams must cover the same path (${engagementTotal} vs ${legacyTotal})`,
    )
    const distances = [...new Set(
      [...engagementProfile, ...legacyProfile]
        .map((point) => point.at)
        .filter((distance) => distance < engagementTotal - 1e-9),
    )].sort((a, b) => a - b)
    for (const distance of distances) {
      const engagementScale = profileScaleAt(engagementProfile, distance)
      const legacyScale = profileScaleAt(legacyProfile, distance)
      assert(
        engagementScale <= legacyScale + 1e-12,
        `${spec.name}: engagement scale ${engagementScale} exceeds legacy ${legacyScale} at path distance ${distance}`,
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

test('cache equivalence: cached per-band classification equals recomputation on a multi-lobe fixture', () => {
  const { project, operation } = buildThreeLobeFixture()
  // The raw (unsplit) move stream: engagement mode without a slot anchor emits
  // exactly the generated moves, so per-level cut sequences come from here.
  const raw = generatePocketToolpath(project, { ...operation, pocketEngagementMode: 'engagement_feed', pocketSlotFeedPercent: undefined })
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

  // Level ordering actually differs: label each move by its lobe (nearest
  // circle centre) and compare the label sequences.
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
    `level ordering must actually differ between levels (got ${firstLabels.join('')} vs ${secondLabels.join('')})`,
  )

  // Build the same band classification the generator builds, from the same
  // resolved regions (initial inset = tool radius, no radial stock, mitered
  // islands, no corner rounding).
  const band = resolvePocketRegions(project, operation).bands[0]
  if (!band) throw new Error('the fixture must resolve one band')
  // Exact generator values: the stepover is the tool diameter times the ratio
  // (6 × 0.4, not the 2.4 literal — a 1-ulp difference changes smoothed
  // contours, and the cache keys are exact float strings).
  const trees = band.regions
    .flatMap((region) => buildInsetRegions(region, 3, ClipperLib.JoinType.jtMiter, ClipperLib.JoinType.jtMiter))
    .map((region) => buildOffsetRegionTree(region, 6 * 0.4, ClipperLib.JoinType.jtMiter))
  const cache = buildOffsetBandEngagementClassification(trees, {
    toolRadius: 3,
    direction: 'conventional',
    smoothRadius: null,
  })
  assert(cache.segmentCount > 0, 'the band classification must classify segments')
  assert(cache.indexEntryCount > 0, 'the band classification must build swept-material indexes')

  // Independent recomputation: a fresh incremental index walked in each
  // level's real emission order, sampling at the cached chunk boundaries.
  // Two production semantics the reference mirrors exactly:
  //  - moves outside the ring tree — the entry helix and any link cut the
  //    canonical traversal did not reproduce (a level whose position-seeded
  //    order diverges emits different links) — are cache misses, and
  //    production resolves them to full engagement (conservative; they cut
  //    virgin strips), indexing none of them. The reference skips them the
  //    same way, and a served-distance bound below proves that only those
  //    fringe moves miss;
  //  - a contour's own segments are inserted only once the whole contour is
  //    classified (the canonical model excludes the tool's own trail, which
  //    only over-reports engagement — the conservative direction). Consecutive
  //    cut moves of one contour share an endpoint, so the reference groups
  //    them by that and inserts per contour. A served LINK is the boundary
  //    between two contours — production classifies it against everything cut
  //    earlier, including the contour it just left, so the reference flushes
  //    before comparing one; the shared endpoint alone cannot mark the
  //    boundary because a link and the ring it leaves share a vertex.
  for (const level of levels) {
    const reference = new SweptMaterialIndex(3)
    let totalCutDistance = 0
    let servedDistance = 0
    let contour: ToolpathMove[] = []
    const flushContour = (): void => {
      for (const done of contour) {
        reference.addSweptSegment(done.from.x, done.from.y, done.to.x, done.to.y)
      }
      contour = []
    }
    for (const move of level) {
      const length = Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y)
      totalCutDistance += length
      const dirX = (move.to.x - move.from.x) / length
      const dirY = (move.to.y - move.from.y) / length
      const cached = cache.chunksForMove(move.from.x, move.from.y, move.to.x, move.to.y)
      if (cached === null) {
        flushContour()
        continue
      }
      servedDistance += length
      if (cached.isLink) flushContour()
      const previous = contour[contour.length - 1]
      if (previous !== undefined && (previous.to.x !== move.from.x || previous.to.y !== move.from.y)) {
        flushContour()
      }
      for (const chunk of cached.chunks) {
        let engagement = 0
        for (let point = 0; point < 3; point += 1) {
          const t = chunk.t0 + ((chunk.t1 - chunk.t0) * (point + 1)) / 4
          const sample = reference.engagementAt(
            move.from.x + (move.to.x - move.from.x) * t,
            move.from.y + (move.to.y - move.from.y) * t,
            dirX,
            dirY,
          )
          if (sample > engagement) engagement = sample
        }
        assert(
          Math.abs(engagement - chunk.engagement) <= 1e-9,
          `cached engagement ${chunk.engagement} must equal the emission-order recomputation ${engagement}`,
        )
      }
      if (!cached.isLink) contour.push(move)
    }
    flushContour()
    // The ring path is 2π·(7 + 4.6 + 2.2) = 86.7 mm per lobe (260 mm total,
    // measured 259.8 with tessellation chords); the only cut distance outside
    // it is the six stepover-length links between rings (6 × 2.4 = 14.4 mm).
    // The cache must serve the whole ring path.
    assert(
      servedDistance >= totalCutDistance - 20,
      `the cache must serve the ring path (served ${servedDistance.toFixed(1)} of ${totalCutDistance.toFixed(1)} mm)`,
    )
  }
})

test('cost probe: the swept-material index is built once per band and reused per level', () => {
  const spec = specByName('offset-multi')
  const { project, operation } = buildFixture(spec)
  resetEngagementCacheProbeCounts()
  generatePocketToolpath(project, { ...operation, pocketEngagementMode: 'engagement_feed' })
  const engagementCounts = engagementCacheProbeCounts()
  assert(
    engagementCounts.bandCacheBuilds === 1,
    `the band classification must be built once per band, got ${engagementCounts.bandCacheBuilds} builds`,
  )
  assert(
    engagementCounts.cacheLevelUses === 2,
    `both step levels must consume the one build, got ${engagementCounts.cacheLevelUses} level uses`,
  )
  resetEngagementCacheProbeCounts()
  generatePocketToolpath(project, { ...operation, pocketEngagementMode: 'legacy' })
  const legacyCounts = engagementCacheProbeCounts()
  assert(legacyCounts.bandCacheBuilds === 0 && legacyCounts.cacheLevelUses === 0, 'legacy mode must build no classification')
  resetEngagementCacheProbeCounts()
  generatePocketToolpath(project, { ...operation, pocketEngagementMode: 'engagement_feed', pocketPattern: 'parallel' })
  const parallelCounts = engagementCacheProbeCounts()
  assert(
    parallelCounts.bandCacheBuilds === 0 && parallelCounts.cacheLevelUses === 0,
    'the parallel pattern has no ring tree and must not build a band classification',
  )
})

// ── 5c. Depth invariance and miss observability (S2d) ─────────────────
//
// The band's ring tree is Z-invariant, so the emitted feed pattern must be
// too. S2c's cache already classified every ring segment once per band, but
// the emitted stream still drifted with depth for two reasons: the
// never-raise clamp's `legacySlotSpans` collected spans from the whole
// accumulated move array, so each deeper level clamped against its own
// shallower siblings' engagement-stamped fragments (measured: the span set
// grew 3 → 95 → 184 → 272 → 356 over five levels, and the slot-feed share
// grew 35.4% → 71.2%); and the inter-ring link cuts were never classified,
// so every level resolved them to full engagement. Both are fixed: the
// clamp is level-scoped and the canonical traversal classifies links too.
// The depth-invariance property below failed before the fix (fed sequences
// differed at every level) and passes after it. Cache misses are counted
// and asserted so a silent conservative fallback can never hide a
// classification regression again.

test('depth invariance: every level emits the same fed-move count, XY sequence, and feedScale sequence', () => {
  const spec = specByName('offset-multi')
  const { project, operation } = buildFixture(spec)
  const engagement = generatePocketToolpath(project, { ...operation, pocketEngagementMode: 'engagement_feed' })
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

test('cache misses are observable: zero on the canonical fixtures, a known number where the traversal diverges', () => {
  // A plain offset pocket, a multi-level pocket, and an island pocket: the
  // canonical (null-seeded) traversal reproduces every emitted level, so
  // every cut move — ring segment and link alike — hits the cache.
  for (const name of ['offset-single', 'offset-multi', 'offset-island-single']) {
    const spec = specByName(name)
    const { project, operation } = buildFixture(spec)
    resetEngagementCacheProbeCounts()
    generatePocketToolpath(project, { ...operation, pocketEngagementMode: 'engagement_feed' })
    const counts = engagementCacheProbeCounts()
    assert(
      counts.cacheMisses === 0,
      `${name}: every emitted cut must hit the canonical cache, got ${counts.cacheMisses} misses`,
    )
  }
  // The parallel pattern has no ring tree, builds no canonical cache, and
  // classifies per level — nothing can miss.
  for (const name of ['parallel-single', 'parallel-multi']) {
    const spec = specByName(name)
    const { project, operation } = buildFixture(spec)
    resetEngagementCacheProbeCounts()
    generatePocketToolpath(project, { ...operation, pocketEngagementMode: 'engagement_feed' })
    const counts = engagementCacheProbeCounts()
    assert(
      counts.bandCacheBuilds === 0 && counts.cacheMisses === 0,
      `${name}: the parallel pattern builds no cache and must record no misses`,
    )
  }
  // The island multi-level band legitimately cannot be fully cached: level 1
  // is seeded from level 0's carried position, which rotates the two island
  // rings differently than the canonical traversal, so their two links miss
  // and resolve conservatively to full engagement. The number is pinned — a
  // known miss count is reviewable, an unbounded one is not.
  {
    const spec = specByName('offset-island-multi')
    const { project, operation } = buildFixture(spec)
    resetEngagementCacheProbeCounts()
    generatePocketToolpath(project, { ...operation, pocketEngagementMode: 'engagement_feed' })
    const counts = engagementCacheProbeCounts()
    assert(
      counts.cacheMisses === 2,
      `the island multi-level band's two island-ring links miss the canonical cache, got ${counts.cacheMisses} misses`,
    )
  }
})

// ── 6. Determinism ────────────────────────────────────────────────────

test('determinism: repeated generation produces identical move streams', () => {
  for (const name of ['offset-single', 'parallel-island-multi']) {
    const spec = specByName(name)
    const { project, operation } = buildFixture(spec)
    const engagementOp = { ...operation, pocketEngagementMode: 'engagement_feed' as const }
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
  const engagement = generatePocketToolpath(project, { ...operation, pocketEngagementMode: 'engagement_feed' })
  const legacy = generatePocketToolpath(project, operationWithoutPocketEngagementMode(operation))
  assert(
    JSON.stringify(engagement.moves) === JSON.stringify(legacy.moves),
    'no pocketSlotFeedPercent anchor means no scaling — the move stream must match legacy',
  )
  assert(
    engagement.moves.every((move) => move.feedScale === undefined),
    'no feedScale stamps without an anchor',
  )
  assert(engagement.engagementTelemetry !== undefined, 'telemetry is still recorded')
})

// ── Summary ──

console.log(`\nengagementPocket: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
