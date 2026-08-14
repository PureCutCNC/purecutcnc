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
import type { Operation, Project, SketchFeature, Tool } from '../../types/project'
import { defaultTool, newProject, rectProfile } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import { ENGAGEMENT_FEED_BUCKET_COUNT } from './engagement'
import { generatePocketToolpath } from './pocket'
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
