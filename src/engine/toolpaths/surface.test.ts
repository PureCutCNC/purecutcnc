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
 * Unit tests for the #584 surface-clean upgrade: seeded-offset clearing
 * (rough offset branch + finish floor) and pocket feed-reduction parity.
 *
 * Covers the five test cases #583's acceptance criteria required:
 *   1. no-seed byte identity on regions too small to fit seed circles
 *   2. seeded concentric emission (inner-first) on rough + finish floor
 *   3. slots_only feed reduction across offset / parallel / floor branches,
 *      with 100% slot feed byte-identical to no reduction
 *   4. engagement-mode telemetry + quantized scales
 *   5. pocket-only corner settings stay a no-op for surface_clean
 *
 * Run with: npx tsx src/engine/toolpaths/surface.test.ts
 */

import type { Operation, Project, SketchFeature, Tool } from '../../types/project'
import { defaultTool, newProject, rectProfile } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import { generateSurfaceCleanToolpath } from './surface'
import { ENGAGEMENT_FEED_BUCKET_COUNT } from './engagement'
import type { PocketToolpathResult, ToolpathMove } from './types'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

// ── Fixtures ─────────────────────────────────────────────────────────

function makeEndmill(id = 't1', diameter = 4): Tool {
  const base = defaultTool('mm', 1)
  return {
    ...base,
    id,
    name: `${diameter} mm endmill`,
    diameter,
    defaultStepdown: 2,
    defaultStepover: 0.4,
  }
}

/** An add-feature boss: surface_clean clears around it. */
function makeBoss(id: string, x: number, y: number, w: number, h: number, zTop = 4): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(x, y, w, h),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'add',
    z_top: zTop,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function baseProject(tools: Tool[], features: SketchFeature[]): Project {
  const project = newProject('surface-test', 'mm')
  return projectWithFeatures({ ...project, tools }, features)
}

function makeSurfaceOp(overrides: Partial<Operation> & { featureIds?: string[] } = {}): Operation {
  const base: Operation = {
    id: 'sc1',
    name: 'surface clean',
    kind: 'surface_clean',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: overrides.featureIds ?? ['boss'] },
    toolRef: 't1',
    stepdown: 1,
    stepover: 0.4,
    feed: 800,
    plungeFeed: 300,
    rpm: 18000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 2,
    maxCarveDepth: 2,
    cutDirection: 'conventional',
    machiningOrder: 'level_first',
  }
  const { featureIds: _ignored, ...rest } = overrides
  return { ...base, ...rest }
}

// ── Move-stream analysis helpers ─────────────────────────────────────

const serializeMoves = (moves: ToolpathMove[]): string => JSON.stringify(moves)

interface CircularRun {
  /** Stream position of the run's first cut move. */
  startIndex: number
  centerX: number
  centerY: number
  radius: number
  points: number
}

/** Kasa least-squares circle fit — stable across FULL laps where a
 *  three-point circumcenter degenerates (first ≈ last point).
 *
 * Fits x² + y² + Dx + Ey + F = 0 via the normal equations
 * [[Σxx,Σxy,Σx],[Σxy,Σyy,Σy],[Σx,Σy,n]]·[D,E,F]ᵀ = −[Σxz,Σyz,Σz]ᵀ
 * (z = x²+y²); center = (−D/2, −E/2), r = √(D²/4 + E²/4 − F). */
export function fitCircle(points: Array<{ x: number; y: number }>): { x: number; y: number; radius: number } | null {
  let sxx = 0, sxy = 0, sx = 0, syy = 0, sy = 0, n = 0, sxz = 0, syz = 0, szz = 0
  for (const p of points) {
    const z = p.x * p.x + p.y * p.y
    sxx += p.x * p.x; sxy += p.x * p.y; sx += p.x
    syy += p.y * p.y; sy += p.y
    sxz += p.x * z; syz += p.y * z; szz += z
    n += 1
  }
  const det3 = (m: number[][]): number =>
    m[0]![0]! * (m[1]![1]! * m[2]![2]! - m[1]![2]! * m[2]![1]!)
    - m[0]![1]! * (m[1]![0]! * m[2]![2]! - m[1]![2]! * m[2]![0]!)
    + m[0]![2]! * (m[1]![0]! * m[2]![1]! - m[1]![1]! * m[2]![0]!)
  const matrix = [
    [sxx, sxy, sx],
    [sxy, syy, sy],
    [sx, sy, n],
  ]
  const rhs = [-sxz, -syz, -szz]
  const det = det3(matrix)
  if (!(Math.abs(det) > 1e-9)) return null
  const replaceCol = (column: number): number[][] =>
    matrix.map((row, rowIndex) => row.map((value, index) => (index === column ? rhs[rowIndex] ?? value : value)))
  const bigD = det3(replaceCol(0)) / det
  const bigE = det3(replaceCol(1)) / det
  const bigF = det3(replaceCol(2)) / det
  const radiusSq = bigD * bigD / 4 + bigE * bigE / 4 - bigF
  if (!(radiusSq > 0)) return null
  return { x: -bigD / 2, y: -bigE / 2, radius: Math.sqrt(radiusSq) }
}

/** Greedy longest-circular-window scan over the cut-move stream.
 *
 * Seed laps may be chained together by short cut links (retract-free level
 * moves), so a "run" of cut moves can contain several laps plus the link.
 * Growth is gated on the least-squares residual only; the ≥85%-of-full-turn
 * sweep requirement is applied afterwards as an acceptance filter (a short
 * window can never satisfy it, so it must not stop the growth). */
function findCircularRuns(moves: ToolpathMove[], tolerance = 0.05): CircularRun[] {
  const cutIndexes: number[] = []
  const points: Array<{ x: number; y: number }> = []
  moves.forEach((move, index) => {
    if (move.kind === 'cut') {
      cutIndexes.push(index)
      points.push({ x: move.to.x, y: move.to.y })
    }
  })

  /** Fit + worst residual of points[start..end). Null when the fit degenerates
   *  or any point sits further than `tolerance` off the fitted circle. */
  const residualFit = (start: number, end: number): { x: number; y: number; radius: number } | null => {
    const circle = fitCircle(points.slice(start, end))
    if (!circle) return null
    for (const point of points.slice(start, end)) {
      if (Math.abs(Math.hypot(point.x - circle.x, point.y - circle.y) - circle.radius) > tolerance) return null
    }
    return circle
  }

  const sweptTurns = (start: number, end: number, circle: { x: number; y: number }): number => {
    let sweep = 0
    let previousAngle = Math.atan2(points[start]!.y - circle.y, points[start]!.x - circle.x)
    for (let index = start; index < end; index += 1) {
      const point = points[index]!
      const angle = Math.atan2(point.y - circle.y, point.x - circle.x)
      let delta = angle - previousAngle
      while (delta > Math.PI) delta -= 2 * Math.PI
      while (delta < -Math.PI) delta += 2 * Math.PI
      sweep += delta
      previousAngle = angle
    }
    return Math.abs(sweep)
  }

  const runs: CircularRun[] = []
  const MIN_WINDOW = 12
  const MAX_WINDOW = 600
  let start = 0
  while (start < points.length) {
    // Grow while the residual holds, then judge the sweep of the largest window.
    let end = Math.min(start + MIN_WINDOW, points.length)
    if (points.length - start < MIN_WINDOW || !residualFit(start, end)) {
      start += 1
      continue
    }
    let next = end + 1
    const limit = Math.min(points.length, start + MAX_WINDOW)
    while (next <= limit && residualFit(start, next)) {
      end = next
      next += 1
    }
    const circle = residualFit(start, end)!
    if (sweptTurns(start, end, circle) >= 2 * Math.PI * 0.85) {
      runs.push({
        startIndex: cutIndexes[start]!,
        centerX: circle.x,
        centerY: circle.y,
        radius: circle.radius,
        points: end - start,
      })
      start = end
    } else {
      start += 1
    }
  }
  return runs
}

// ── 1. No-seed byte identity ─────────────────────────────────────────

function testNoSeedByteIdentity() {
  console.log('1. no-seed byte identity (region too small for seed circles)...')
  // A tiny boss expands into an ~8×8 tool-centre region; with a 4 mm tool the
  // seed radii (2, 3.6, 5.2, …) cannot place three circles, so seeded_offset
  // must take exactly the legacy offset path — byte-identical moves.
  const features = [makeBoss('boss-t1', 0, 0, 4, 4)]
  const project = baseProject([makeEndmill()], features)

  const plain = generateSurfaceCleanToolpath(project, makeSurfaceOp({ pocketPattern: 'offset', featureIds: ['boss-t1'], id: 'sc-t1-a' }))
  const seeded = generateSurfaceCleanToolpath(project, makeSurfaceOp({ pocketPattern: 'seeded_offset', featureIds: ['boss-t1'], id: 'sc-t1-b' }))
  assert(plain.moves.length > 0, 'plain offset should produce moves')
  assert(
    serializeMoves(seeded.moves) === serializeMoves(plain.moves),
    `seeded_offset must be byte-identical to offset when no seeds fit (${seeded.moves.length} vs ${plain.moves.length} moves)`,
  )
  assert(findCircularRuns(seeded.moves).length === 0, 'no seed laps may appear on the too-small region')
  console.log('   PASSED')
}

// ── 2. Seeded rough + finish-floor emission ──────────────────────────

function assertSeededEmission(result: PocketToolpathResult, label: string) {
  const cuts = result.moves.filter((move) => move.kind === 'cut')
  assert(cuts.length > 0, `${label}: should produce cut moves`)
  const runs = findCircularRuns(result.moves)
  assert(runs.length >= 2, `${label}: expected multiple concentric seed laps, found ${runs.length}`)

  // All seed laps share the same center (the region's seed anchor).
  const centerX = runs[0]!.centerX
  const centerY = runs[0]!.centerY
  for (const run of runs) {
    assert(Math.hypot(run.centerX - centerX, run.centerY - centerY) < 0.05, `${label}: seed laps must share a center`)
  }

  // Inner-first within every Z pass: each pass starts back at the innermost
  // seed (≈ tool radius) and its laps grow outward until the pass ends. So
  // between two consecutive laps the radius either keeps growing (same pass)
  // or drops back to the innermost seed (a new pass began).
  const minSeedRadius = 2 // toolRadius — seedStartRadius for a non-helix entry
  for (let index = 1; index < runs.length; index += 1) {
    const previous = runs[index - 1]!.radius
    const current = runs[index]!.radius
    const growing = current >= previous - 0.05
    const restartedPass = current <= minSeedRadius + 0.05
    assert(growing || restartedPass,
      `${label}: seed laps must run inner-first within a pass (radius ${previous} followed by ${current})`)
  }

  // The offset ring tree continues after the last seed lap: some cut move
  // beyond the last lap's start must NOT belong to a circular run.
  const lastRunStart = Math.max(...runs.map((run) => run.startIndex))
  const laterCuts = result.moves.filter((move, index) => index > lastRunStart && move.kind === 'cut')
  assert(laterCuts.length > 0, `${label}: offset ring tree must follow the seed laps`)
}

function testSeededRoughAndFinishEmission() {
  console.log('2. seeded rough + finish-floor emission (large region)...')
  // A large boss expands into a ~44×44 tool-centre region: many seeds fit.
  const features = [makeBoss('boss-t2', 0, 0, 40, 40)]
  const project = baseProject([makeEndmill()], features)

  // Sanity for case 1's premise: here seeded output genuinely differs.
  const plain = generateSurfaceCleanToolpath(project, makeSurfaceOp({ pocketPattern: 'offset', featureIds: ['boss-t2'], id: 'sc-t2-a' }))
  const seededRough = generateSurfaceCleanToolpath(project, makeSurfaceOp({ pocketPattern: 'seeded_offset', featureIds: ['boss-t2'], id: 'sc-t2-b' }))
  assert(serializeMoves(seededRough.moves) !== serializeMoves(plain.moves),
    'seeded_offset must differ from plain offset when seeds fit')

  assertSeededEmission(seededRough, 'rough offset branch')

  const seededFinish = generateSurfaceCleanToolpath(project, makeSurfaceOp({
    pass: 'finish',
    pocketPattern: 'seeded_offset',
    featureIds: ['boss-t2'],
    id: 'sc-t2-c',
  }))
  assert(seededFinish.moves.length > 0, 'finish floor should produce moves')
  assertSeededEmission(seededFinish, 'finish floor')
  console.log('   PASSED')
}

// ── 3. Feed reduction across branches ────────────────────────────────

function testFeedReductionAcrossBranches() {
  console.log('3. slots_only feed reduction across offset / parallel / floor...')
  const features = [makeBoss('boss-t3', 0, 0, 40, 40)]
  const project = baseProject([makeEndmill()], features)

  const branches: Array<[string, PocketToolpathResult]> = [
    ['rough offset', generateSurfaceCleanToolpath(project, makeSurfaceOp({
      pocketPattern: 'offset',
      pocketSlotFeedPercent: 60,
      pocketFeedReduction: 'slots_only',
      featureIds: ['boss-t3'],
      id: 'sc-t3-a',
    }))],
    ['rough parallel', generateSurfaceCleanToolpath(project, makeSurfaceOp({
      pocketPattern: 'parallel',
      pocketSlotFeedPercent: 60,
      pocketFeedReduction: 'slots_only',
      featureIds: ['boss-t3'],
      id: 'sc-t3-b',
    }))],
    ['finish floor', generateSurfaceCleanToolpath(project, makeSurfaceOp({
      pass: 'finish',
      pocketPattern: 'offset',
      pocketSlotFeedPercent: 60,
      pocketFeedReduction: 'slots_only',
      featureIds: ['boss-t3'],
      id: 'sc-t3-a',
    }))],
  ]

  for (const [label, result] of branches) {
    const reduced = result.moves.filter((move) => move.kind === 'cut' && move.feedScale !== undefined && move.feedScale < 1)
    assert(reduced.length > 0, `${label}: expected slotting cuts to carry feedScale < 1, got none`)
    for (const move of reduced) {
      assert(Math.abs(move.feedScale! - 0.6) < 1e-9, `${label}: slots_only scale must be exactly 0.6, got ${String(move.feedScale)}`)
    }
  }

  // 100% slot feed is byte-identical to no reduction at all.
  const noReduction = generateSurfaceCleanToolpath(project, makeSurfaceOp())
  const fullSlot = generateSurfaceCleanToolpath(project, makeSurfaceOp({
    pocketSlotFeedPercent: 100,
    pocketFeedReduction: 'slots_only',
  }))
  assert(serializeMoves(noReduction.moves) === serializeMoves(fullSlot.moves),
    '100% slot feed must be byte-identical to no reduction')
  console.log('   PASSED')
}

// ── 4. Engagement telemetry ──────────────────────────────────────────

function testEngagementTelemetry() {
  console.log('4. engagement reduction emits quantized scales + telemetry...')
  const features = [makeBoss('boss-t4', 0, 0, 40, 40)]
  const project = baseProject([makeEndmill()], features)

  const result = generateSurfaceCleanToolpath(project, makeSurfaceOp({
    pocketPattern: 'offset',
    pocketSlotFeedPercent: 60,
    pocketFeedReduction: 'engagement',
    featureIds: ['boss-t4'],
    id: 'sc-t4',
  }))

  assert(result.engagementTelemetry !== undefined, 'engagement mode must attach telemetry')
  assert(result.engagementTelemetry!.totalCutDistance > 0, 'telemetry must record sampled distance')

  const scales = new Set(result.moves
    .filter((move) => move.kind === 'cut' && move.feedScale !== undefined)
    .map((move) => move.feedScale as number))
  assert(scales.size > 0, 'engagement mode must stamp feedScale somewhere')
  assert(scales.size <= ENGAGEMENT_FEED_BUCKET_COUNT,
    `${scales.size} distinct scales exceed the ${ENGAGEMENT_FEED_BUCKET_COUNT}-bucket quantization`)
  const reduced = [...scales].some((scale) => scale < 1)
  assert(reduced, 'at least one above-nominal-engagement cut must reduce feed below 1×')
  console.log('   PASSED')
}

// ── 5. Pocket-only corner settings stay a no-op ──────────────────────

function testCornerSettingsNoOp() {
  console.log('5. corner settings surface_clean does not expose stay a no-op...')

  // DOCUMENTED DIVERGENCE from #583's literal wording, flagged for maintainer
  // review in #600: #583 expected roundLinkCorners/cleanWallCorners to be
  // no-ops for surface_clean ("it does not expose them"), but #584 shipped the
  // opposite contract — operationFields.ts exposes both knobs for
  // surface_clean, and surface.ts honors them (tangent ring links; wall
  // cleanup under roundOutsideCorners && cleanWallCorners). This test locks
  // the SHIPPED contract instead: knobs surface_clean does NOT expose stay
  // inert, and roundLinkCorners demonstrably changes its links.

  const features = [makeBoss('boss-t5', 0, 0, 40, 40)]
  const project = baseProject([makeEndmill()], features)

  // cornerRelief is pocket/edge-route-only per operationFields.ts.
  const baseline = generateSurfaceCleanToolpath(project, makeSurfaceOp({ pocketPattern: 'offset', featureIds: ['boss-t5'], id: 'sc-t5-a' }))
  const withRelief = generateSurfaceCleanToolpath(project, makeSurfaceOp({ pocketPattern: 'offset', cornerRelief: 'dogbone', featureIds: ['boss-t5'], id: 'sc-t5-b' }))
  assert(serializeMoves(withRelief.moves) === serializeMoves(baseline.moves),
    'cornerRelief must not alter surface-clean output')
  assert(baseline.warnings.length === withRelief.warnings.length,
    'inert corner settings must not introduce warnings either')

  // Shipped behavior worth locking in: roundLinkCorners switches ring links.
  const roundedLinks = generateSurfaceCleanToolpath(project, makeSurfaceOp({ pocketPattern: 'offset', roundLinkCorners: true, featureIds: ['boss-t5'], id: 'sc-t5-c' }))
  assert(serializeMoves(roundedLinks.moves) !== serializeMoves(baseline.moves),
    'roundLinkCorners must switch ring links to tangent curves')
}

// ── 6. Machining order: feature_first splits per feature ─────────────

function testMachiningOrderFeatureFirst() {
  console.log('6. machining order feature_first splits per feature...')
  // Two disjoint bosses at different XY positions so we can tell which
  // feature a cut move belongs to.
  const features = [
    makeBoss('boss-a', 0, 0, 10, 10, 4),
    makeBoss('boss-b', 50, 50, 10, 10, 4),
  ]
  const project = baseProject([makeEndmill()], features)

  const featureFirst = generateSurfaceCleanToolpath(project, makeSurfaceOp({
    featureIds: ['boss-a', 'boss-b'],
    machiningOrder: 'feature_first',
    id: 'sc-mo-ff',
  }))

  assert(featureFirst.moves.length > 0, 'feature_first should produce moves')

  // Find the XY boundary between the two features. Boss A's tool-centre
  // region is roughly X ∈ [-2, 12], boss B's is roughly X ∈ [48, 62].
  // A cut at X < 30 belongs to feature A; X ≥ 30 belongs to feature B.
  const cutMoves = featureFirst.moves.filter((m) => m.kind === 'cut')
  assert(cutMoves.length > 0, 'feature_first should produce cut moves')

  // Find the last cut for feature A and the first cut for feature B.
  let lastACut = -1
  let firstBCut = cutMoves.length
  for (let i = 0; i < cutMoves.length; i++) {
    if (cutMoves[i]!.to.x < 30) lastACut = i
    if (cutMoves[i]!.to.x >= 30 && firstBCut === cutMoves.length) firstBCut = i
  }
  assert(lastACut >= 0, 'must have cuts for feature A')
  assert(firstBCut < cutMoves.length, 'must have cuts for feature B')
  assert(lastACut < firstBCut,
    `feature_first: all feature-A cuts must precede feature-B cuts (last A at ${lastACut}, first B at ${firstBCut})`)
  console.log('   PASSED')
}

// ── 7. Machining order: level_first interleaves ──────────────────────

function testMachiningOrderLevelFirst() {
  console.log('7. machining order level_first interleaves across features...')
  const features = [
    makeBoss('boss-a', 0, 0, 10, 10, 4),
    makeBoss('boss-b', 50, 50, 10, 10, 4),
  ]
  const project = baseProject([makeEndmill()], features)

  const levelFirst = generateSurfaceCleanToolpath(project, makeSurfaceOp({
    featureIds: ['boss-a', 'boss-b'],
    machiningOrder: 'level_first',
    id: 'sc-mo-lf',
  }))

  assert(levelFirst.moves.length > 0, 'level_first should produce moves')

  const cutMoves = levelFirst.moves.filter((m) => m.kind === 'cut')
  // With level_first the operation is NOT split per feature, so the two
  // features' regions are merged and cleared together. The stream should
  // contain cuts from both features interleaved at each level.
  const hasA = cutMoves.some((m) => m.to.x < 30)
  const hasB = cutMoves.some((m) => m.to.x >= 30)
  assert(hasA && hasB, 'level_first stream must contain cuts from both features')

  // Verify the two settings produce different streams.
  const featureFirst = generateSurfaceCleanToolpath(project, makeSurfaceOp({
    featureIds: ['boss-a', 'boss-b'],
    machiningOrder: 'feature_first',
    id: 'sc-mo-ff2',
  }))
  assert(serializeMoves(featureFirst.moves) !== serializeMoves(levelFirst.moves),
    'feature_first and level_first must produce different streams')
  console.log('   PASSED')
}

// ── 8. Single-feature: both settings identical ───────────────────────

function testMachiningOrderSingleFeatureIdentical() {
  console.log('8. single-feature operation identical under both settings...')
  const features = [makeBoss('boss-s', 0, 0, 20, 20, 4)]
  const project = baseProject([makeEndmill()], features)

  const levelFirst = generateSurfaceCleanToolpath(project, makeSurfaceOp({
    featureIds: ['boss-s'],
    machiningOrder: 'level_first',
    id: 'sc-sf-lf',
  }))
  const featureFirst = generateSurfaceCleanToolpath(project, makeSurfaceOp({
    featureIds: ['boss-s'],
    machiningOrder: 'feature_first',
    id: 'sc-sf-ff',
  }))
  assert(serializeMoves(levelFirst.moves) === serializeMoves(featureFirst.moves),
    'single-feature operation must be byte-identical under both machiningOrder settings')
  console.log('   PASSED')
}

// ── 9. Telemetry survives feature-first split ────────────────────────

function testMachiningOrderTelemetrySurvives() {
  console.log('9. engagement telemetry survives feature-first split...')
  const features = [
    makeBoss('boss-a', 0, 0, 10, 10, 4),
    makeBoss('boss-b', 50, 50, 10, 10, 4),
  ]
  const project = baseProject([makeEndmill()], features)

  const result = generateSurfaceCleanToolpath(project, makeSurfaceOp({
    featureIds: ['boss-a', 'boss-b'],
    machiningOrder: 'feature_first',
    pocketFeedReduction: 'engagement',
    id: 'sc-tel',
  }))
  assert(result.engagementTelemetry !== undefined,
    'feature-first engagement mode must attach telemetry')
  assert(result.engagementTelemetry!.totalCutDistance > 0,
    'telemetry must record sampled distance')
  console.log('   PASSED')
}

// ── Runner ───────────────────────────────────────────────────────────

try {
  testNoSeedByteIdentity()
  testSeededRoughAndFinishEmission()
  testFeedReductionAcrossBranches()
  testEngagementTelemetry()
  testCornerSettingsNoOp()
  testMachiningOrderFeatureFirst()
  testMachiningOrderLevelFirst()
  testMachiningOrderSingleFeatureIdentical()
  testMachiningOrderTelemetrySurvives()
  console.log('\nAll surface.test.ts tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
