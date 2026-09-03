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
 * Trochoidal pocket clearing (issue #676): offset ring centrelines used as
 * trochoidal guides.
 *
 * The acceptance criteria the issue names are the first two tests — coverage
 * asserted against the swept envelope rather than by eye, and peak radial
 * engagement measured below the equivalent contour pocket. The rest hold the
 * safety contract in planning/TROCHOIDAL_EDGE_DESIGN.md: a per-operation
 * budget, and failures that refuse the operation instead of trimming it.
 *
 * Run with: npx tsx src/engine/toolpaths/pocketTrochoidal.test.ts
 */

import type { Operation, Project, SketchFeature, Tool } from '../../types/project'
import { defaultTool, isTrochoidalPocket, newProject, rectProfile } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import { SweptMaterialIndex } from './engagement'
import { generateEdgeRouteToolpath } from './edge'
import { generatePocketToolpath } from './pocket'
import { TROCHOIDAL_MAX_COVERING_STEPOVER, TROCHOIDAL_RING_STEPOVER, usesTangentLinks } from './pocketPatterns'
import { OPERATION_FIELDS } from '../../components/cam/operationFields'
import { buildSweptCoverage } from './sweptCoverage'
import type { ToolpathMove } from './types'

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

// ── Fixtures ─────────────────────────────────────────────────────────

const TOOL_DIAMETER = 6
const TOOL_RADIUS = TOOL_DIAMETER / 2
/** The default channel: 1.5 x D, as `resolveTrochoidalGeometry` resolves it. */
const DEFAULT_CUT_WIDTH = TOOL_DIAMETER * 1.5

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

function makeSquareFeature(id: string, half: number, zTop: number, zBottom: number): SketchFeature {
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
    operation: 'subtract',
    z_top: zTop,
    z_bottom: zBottom,
    visible: true,
    locked: false,
  }
}

/**
 * A square pocket, trochoidal by default. `half` is the half-width, so the
 * default 30 is a 60 x 60 pocket — ten channel widths across, enough for
 * several rings without making the orbit count unreasonable in a unit test.
 */
function buildPocket(overrides: Partial<Operation> = {}, half = 30, zBottom = 0): {
  project: Project
  operation: Operation
} {
  const zTop = 2
  const project = projectWithFeatures(
    { ...newProject('trochoidal-pocket', 'mm'), tools: [makeTool()] },
    [makeSquareFeature('pocket', half, zTop, zBottom)],
  )
  const operation: Operation = {
    id: 'op-1',
    name: 'op',
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: ['pocket'] },
    toolRef: 'tool-1',
    stepdown: 2,
    stepover: TROCHOIDAL_RING_STEPOVER,
    feed: 800,
    plungeFeed: 300,
    rpm: 18000,
    pocketPattern: 'trochoidal',
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

function cutMoves(moves: readonly ToolpathMove[]): ToolpathMove[] {
  return moves.filter((move) => move.kind === 'cut')
}

/**
 * Sustained peak radial engagement over a move stream — the 95th percentile by
 * cut length, measured the way `engagementPocket.test.ts` measures engagement:
 * sweep each cut move into the index after querying it, so every sample sees
 * only what was cut before it.
 *
 * The percentile rather than the maximum, because `engagementAt` resolves to
 * `π` whenever nothing has been swept in range — the conservative default. The
 * opening move of any stream therefore reads as full engagement, trochoidal or
 * not, and a bare maximum measures that artifact instead of the cut. What the
 * strategy actually changes is how much of the cut LENGTH runs buried, which is
 * what a length-weighted percentile reports.
 */
function sustainedEngagement(moves: ToolpathMove[]): number {
  const index = new SweptMaterialIndex(TOOL_RADIUS)
  const samples: { engagement: number; length: number }[] = []
  for (const move of cutMoves(moves)) {
    const length = Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y)
    if (length < TOOL_RADIUS / 10) continue
    const dirX = (move.to.x - move.from.x) / length
    const dirY = (move.to.y - move.from.y) / length
    let worst = 0
    for (let point = 1; point <= 3; point += 1) {
      const t = point / 4
      const sample = index.engagementAt(
        move.from.x + (move.to.x - move.from.x) * t,
        move.from.y + (move.to.y - move.from.y) * t,
        dirX,
        dirY,
      )
      if (sample > worst) worst = sample
    }
    samples.push({ engagement: worst, length })
    index.addSweptSegment(move.from.x, move.from.y, move.to.x, move.to.y)
  }
  if (samples.length === 0) return 0
  samples.sort((a, b) => a.engagement - b.engagement)
  const total = samples.reduce((sum, sample) => sum + sample.length, 0)
  let walked = 0
  for (const sample of samples) {
    walked += sample.length
    if (walked >= total * 0.95) return sample.engagement
  }
  return samples[samples.length - 1].engagement
}

function warningCodes(result: { warnings: readonly { code: string }[] }): string[] {
  return result.warnings.map((warning) => warning.code)
}

// ── Acceptance: coverage ─────────────────────────────────────────────

console.log('Testing trochoidal pocket clearing (#676)...')

test('acceptance: a rectangular pocket clears with no uncut ridge between rings', () => {
  const { project, operation } = buildPocket()
  const result = generatePocketToolpath(project, operation)
  assert(result.moves.length > 0, 'the trochoidal pocket must generate')

  // The deepest level is the one that has to be clear: every level above it
  // cuts the same footprint, so a ridge shows up at the bottom too.
  const levels = [...new Set(cutMoves(result.moves).map((move) => move.to.z))].sort((a, b) => a - b)
  const deepest = levels[0]
  const atDepth = cutMoves(result.moves).filter((move) => move.from.z === deepest && move.to.z === deepest)
  assert(atDepth.length > 0, 'the deepest level must have cut moves')

  // Assert on the CUTTER BODY, not the tool centre: the question is whether
  // material is left, and the tool sweeps a radius either side of its path.
  const covered = buildSweptCoverage(
    atDepth.map((move) => [
      { x: move.from.x, y: move.from.y },
      { x: move.to.x, y: move.to.y },
    ]),
    TOOL_RADIUS,
  )
  assert(covered.segmentCount > 0, 'the swept envelope must index the level')

  // Sample the pocket interior on a grid finer than the channel. The walls are
  // finished by a contour pass, so the region checked is the area the rings are
  // responsible for: inside the pocket by one channel width.
  const half = 30
  const margin = DEFAULT_CUT_WIDTH
  const step = TOOL_RADIUS / 2
  let uncovered = 0
  let sampled = 0
  for (let x = -half + margin; x <= half - margin; x += step) {
    for (let y = -half + margin; y <= half - margin; y += step) {
      sampled += 1
      if (!covered.covers(x, y)) uncovered += 1
    }
  }
  assert(sampled > 100, `the sample grid must be meaningful, got ${sampled} points`)
  assert(uncovered === 0, `${uncovered} of ${sampled} interior points were left uncut`)
})

test('the coverage assertion bites: a channel too narrow for its ring spacing leaves material', () => {
  // The mutation that must fail the test above — rings spaced for a wide channel
  // while the cutter orbits a narrow one. If this passes, the coverage grid is
  // not actually measuring coverage.
  const { project, operation } = buildPocket({ trochoidalCutWidth: TOOL_DIAMETER * 1.15, stepover: 1 })
  const result = generatePocketToolpath(project, operation)
  const levels = [...new Set(cutMoves(result.moves).map((move) => move.to.z))].sort((a, b) => a - b)
  const atDepth = cutMoves(result.moves).filter((move) => move.from.z === levels[0] && move.to.z === levels[0])
  const covered = buildSweptCoverage(
    atDepth.map((move) => [
      { x: move.from.x, y: move.from.y },
      { x: move.to.x, y: move.to.y },
    ]),
    // Measure with a cutter narrower than the one that cut, which is what an
    // under-overlapped ring pitch looks like from the material's side.
    TOOL_RADIUS * 0.35,
  )
  let uncovered = 0
  for (let x = -20; x <= 20; x += TOOL_RADIUS / 2) {
    for (let y = -20; y <= 20; y += TOOL_RADIUS / 2) {
      if (!covered.covers(x, y)) uncovered += 1
    }
  }
  assert(uncovered > 0, 'the grid must be able to detect uncut material at all')
})

/** Even-odd point-in-polygon, for bounding a sample grid to the real shape. */
function insidePolygon(point: { x: number; y: number }, polygon: readonly { x: number; y: number }[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i]
    const b = polygon[j]
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside
    }
  }
  return inside
}

/**
 * Uncut floor area at the deepest level, in mm^2, measured on the cutter body.
 *
 * The sample domain is the pocket outline itself, eroded by the tool radius —
 * NOT a bounding box. A box over-reports wildly on any non-rectangular pocket:
 * it counts stock that was never inside the feature as "uncut". The erosion is
 * what the rings are actually answerable for, since the tool centre cannot come
 * closer than its own radius to the wall and the wall is finished by a contour.
 */
function uncutFloorArea(
  result: { moves: readonly ToolpathMove[] },
  outline: readonly { x: number; y: number }[],
  sampleStep = TOOL_RADIUS / 8,
): number {
  const cuts = cutMoves(result.moves)
  if (cuts.length === 0) return Infinity
  const deepest = Math.min(...cuts.map((move) => move.to.z))
  const atDepth = cuts.filter((move) => move.from.z === deepest && move.to.z === deepest)
  const covered = buildSweptCoverage(
    atDepth.map((move) => [
      { x: move.from.x, y: move.from.y },
      { x: move.to.x, y: move.to.y },
    ]),
    TOOL_RADIUS,
  )
  if (covered.segmentCount === 0) return Infinity
  // Points within a tool radius of the outline are the wall's business.
  const wallZone = buildSweptCoverage([[...outline]], TOOL_RADIUS)
  const xs = outline.map((p) => p.x)
  const ys = outline.map((p) => p.y)
  let area = 0
  for (let x = Math.min(...xs); x <= Math.max(...xs); x += sampleStep) {
    for (let y = Math.min(...ys); y <= Math.max(...ys); y += sampleStep) {
      if (!insidePolygon({ x, y }, outline)) continue
      if (wallZone.covers(x, y)) continue
      if (!covered.covers(x, y)) area += sampleStep * sampleStep
    }
  }
  return area
}

/** The square outline `buildPocket` cuts, for the coverage domain. */
function squareOutline(half: number): { x: number; y: number }[] {
  return [{ x: -half, y: -half }, { x: half, y: -half }, { x: half, y: half }, { x: -half, y: half }]
}

test('acceptance: no pocket size leaves an uncut core, across a range of widths', () => {
  // The original coverage test above used ONE pocket size and passed on it by
  // luck: whether the innermost ring's channel reaches the middle depends on
  // where that last ring happens to land, which is a function of the size. A
  // single size therefore proves nothing, and this shipped with a 2.6 % uncut
  // bar along the centreline of a real 2.74 x 1.74 in pocket.
  //
  // Sweeping the width is the actual guard: at least one of these lands badly
  // for any given pitch rule, so no lucky fixture can hide the defect.
  const failures: string[] = []
  for (let half = 12; half <= 26; half += 1) {
    const { project, operation } = buildPocket({}, half)
    const result = generatePocketToolpath(project, operation)
    if (result.moves.length === 0) {
      failures.push(`${half * 2} mm: refused (${warningCodes(result).join(', ') || 'no warning'})`)
      continue
    }
    const area = uncutFloorArea(result, squareOutline(half))
    if (area > 0) failures.push(`${half * 2} mm square: ${area.toFixed(2)} mm² uncut`)
  }
  assert(failures.length === 0, `pockets left material uncut:\n    ${failures.join('\n    ')}`)
})

// ── Acceptance: engagement ───────────────────────────────────────────

test('acceptance: peak radial engagement is below the equivalent contour pocket', () => {
  const { project, operation } = buildPocket()
  const trochoidal = generatePocketToolpath(project, operation)
  const contour = generatePocketToolpath(project, { ...operation, pocketPattern: 'offset', stepover: 0.4 })
  assert(trochoidal.moves.length > 0 && contour.moves.length > 0, 'both patterns must generate')

  const trochoidalPeak = sustainedEngagement(trochoidal.moves)
  const contourPeak = sustainedEngagement(contour.moves)
  console.log(`      engagement p95: trochoidal ${trochoidalPeak.toFixed(3)} rad, contour ${contourPeak.toFixed(3)} rad`)
  assert(
    trochoidalPeak < contourPeak,
    `trochoidal p95 engagement ${trochoidalPeak.toFixed(3)} must be below contour ${contourPeak.toFixed(3)}`,
  )
})

// ── The budget belongs to the operation ──────────────────────────────

test('#676 the point budget is shared across bands, not restarted per band', () => {
  // Two features at different depths resolve to two bands. With a per-band
  // budget each would report the same remaining ceiling; with one operation
  // budget the second band continues from what the first left.
  const zTop = 4
  const project = projectWithFeatures(
    { ...newProject('two-band', 'mm'), tools: [makeTool()] },
    [makeSquareFeature('pocket', 30, zTop, 0), makeSquareFeature('deeper', 12, 0, -3)],
  )
  const { operation } = buildPocket()
  const result = generatePocketToolpath(project, {
    ...operation,
    debugToolpath: true,
    target: { source: 'features', featureIds: ['pocket', 'deeper'] },
  })
  const remaining = result.warnings
    .filter((warning) => warning.code === 'debug')
    .map((warning) => /trochoidal budget left = (\d+)/.exec(String(warning.params?.text ?? '')))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]))
  assert(remaining.length >= 2, `expected a budget readout per band, got ${remaining.length}`)
  assert(
    remaining.every((value, index) => index === 0 || value < remaining[index - 1]),
    `each band must continue the previous band's budget, got ${remaining.join(' -> ')}`,
  )
})

test('acceptance: the 200 x 150 / 9 mm channel case generates inside one operation budget', () => {
  // The worked example #676 is written around: a 200 x 150 pocket cleared with
  // 9 mm channels (1.5 x D on a 6 mm cutter) at 0.1 x D advance, six 2 mm levels.
  //
  // The issue put this at ~864,000 emitted moves from 144,025 points per level.
  // That figure counts orbit geometry alone; the budget also carries the helical
  // entries, which is why the real cost is nearer 160,000 per level. It fits
  // because the entry starts just above the level above's floor rather than at
  // safe Z — boring the full depth on every ring of every level costs about
  // 56,000 moves more and puts this case over the ceiling.
  const zTop = 0
  const project = projectWithFeatures(
    { ...newProject('worked-example', 'mm'), tools: [makeTool()] },
    [{
      ...makeSquareFeature('pocket', 100, zTop, -12),
      sketch: {
        profile: rectProfile(-100, -75, 200, 150),
        origin: { x: 0, y: 0 },
        orientationAngle: 0,
        dimensions: [],
        constraints: [],
      },
    }],
  )
  // Pinned at 0.85, the spacing #676 computed the example for — NOT the shipped
  // default. The default is now the more conservative 0.5, and at that spacing
  // this case needs more rings than one operation's budget allows and refuses.
  // That is a real consequence of the conservative default, recorded here rather
  // than hidden by quietly relaxing the assertion.
  const { operation } = buildPocket({ stepover: TROCHOIDAL_MAX_COVERING_STEPOVER })
  const result = generatePocketToolpath(project, { ...operation, target: { source: 'features', featureIds: ['pocket'] } })
  const levels = new Set(cutMoves(result.moves).map((move) => move.to.z)).size
  console.log(`      worked example: ${levels} levels, ${result.moves.length} moves against a 1,000,000 ceiling`)
  assert(levels === 6, `the worked example is six 2 mm levels, got ${levels}`)
  assert(
    warningCodes(result).length === 0,
    `it must generate cleanly, got ${warningCodes(result).join(', ')}`,
  )
  assert(
    result.moves.length < 1_000_000,
    `it must fit one operation budget, got ${result.moves.length}`,
  )
})

test('#676 a pocket past the ceiling refuses whole rather than emitting the rings that fit', () => {
  // The failure the operation-level refusal exists for. Rings are emitted until
  // the budget runs out partway through, so without failing closed the caller
  // gets a path whose later levels descend into stock no orbit has cleared —
  // planning/TROCHOIDAL_EDGE_DESIGN.md § Budgets calls that unsafe by
  // construction. The ceiling is checked before emission, so this refuses long
  // before it materialises a million moves.
  const { project, operation } = buildPocket({}, 200, -40)
  const result = generatePocketToolpath(project, operation)
  assert(
    warningCodes(result).includes('pocketTrochoidalMoveBudget'),
    `expected the ceiling, got ${warningCodes(result).join(', ') || 'none'}`,
  )
  assert(result.moves.length === 0, `refusal must be total, got ${result.moves.length} moves`)
  assert(
    !warningCodes(result).includes('pocketTrochoidalAdvanceDegenerate'),
    'a job that is merely too big must not be blamed on the advance',
  )
})

// ── Failures refuse the operation ────────────────────────────────────

test('#676 a channel below 1.15 x D refuses the operation and names the width', () => {
  const { project, operation } = buildPocket({ trochoidalCutWidth: TOOL_DIAMETER * 1.05 })
  const result = generatePocketToolpath(project, operation)
  const codes = warningCodes(result)
  assert(
    codes.includes('pocketTrochoidalWidthTooSmall'),
    `expected pocketTrochoidalWidthTooSmall, got ${codes.join(', ') || 'none'}`,
  )
  assert(result.moves.length === 0, `a refused operation must emit nothing, got ${result.moves.length} moves`)
})

test('#676 a channel at or below the tool diameter refuses rather than emitting an empty floor', () => {
  // orbitRadius = (W - D) / 2 is not positive here. Before the width check this
  // reached the sampler and came back as an invalid guide, which named the
  // geometry for what is a parameter the user typed.
  const { project, operation } = buildPocket({ trochoidalCutWidth: TOOL_DIAMETER })
  const result = generatePocketToolpath(project, operation)
  assert(
    warningCodes(result).includes('pocketTrochoidalWidthTooSmall'),
    `expected the width warning, got ${warningCodes(result).join(', ') || 'none'}`,
  )
  assert(result.moves.length === 0, 'a refused operation must emit nothing')
})

test('#676 a degenerate advance names the advance, not the guide', () => {
  // Below 0.01 x D the orbit re-traces the same arc. The warning has to point
  // at the advance: telling the user their guide is invalid sends them to look
  // at geometry that is fine (planning/TROCHOIDAL_EDGE_DESIGN.md § degeneracy).
  const { project, operation } = buildPocket({ trochoidalAdvance: 0.001 })
  const result = generatePocketToolpath(project, operation)
  const codes = warningCodes(result)
  assert(
    codes.includes('pocketTrochoidalAdvanceDegenerate'),
    `expected pocketTrochoidalAdvanceDegenerate, got ${codes.join(', ') || 'none'}`,
  )
  assert(
    !codes.includes('pocketTrochoidalInvalidGuide'),
    'a degenerate advance must not be reported as an invalid guide',
  )
  assert(result.moves.length === 0, 'a refused operation must emit nothing')
})

test('#676 a channel wider than 2 x D advises about the entry core but still cuts', () => {
  const { project, operation } = buildPocket({ trochoidalCutWidth: TOOL_DIAMETER * 2.5 })
  const result = generatePocketToolpath(project, operation)
  assert(
    warningCodes(result).includes('pocketTrochoidalWidthLeavesCore'),
    `expected the leaves-core advisory, got ${warningCodes(result).join(', ') || 'none'}`,
  )
  assert(result.moves.length > 0, 'the advisory must not refuse the operation')
})

// ── Ring spacing follows the channel, not the cutter ─────────────────

test('#676 ring spacing scales with the channel width, not the tool diameter', () => {
  const { project, operation } = buildPocket()
  const narrow = generatePocketToolpath(project, operation)
  const wide = generatePocketToolpath(project, { ...operation, trochoidalCutWidth: DEFAULT_CUT_WIDTH * 2 })
  assert(narrow.moves.length > 0 && wide.moves.length > 0, 'both channels must generate')

  // A wider channel steps further per ring, so the same pocket needs fewer of
  // them. Counting helical entries counts rings: one entry per guide.
  const entries = (moves: ToolpathMove[]): number =>
    moves.filter((move) => move.kind === 'rapid' && move.source === 'trochoidal-transition').length
  assert(
    entries(wide.moves) < entries(narrow.moves),
    `a 2x channel must need fewer rings, got ${entries(wide.moves)} vs ${entries(narrow.moves)}`,
  )
})

// ── Non-trochoidal patterns are untouched ────────────────────────────

test('#676 the trochoidal fields do not leak into a contour pocket', () => {
  const { project, operation } = buildPocket({ pocketPattern: 'offset', stepover: 0.4 })
  const plain = generatePocketToolpath(project, operation)
  const withFields = generatePocketToolpath(project, {
    ...operation,
    trochoidalCutWidth: TOOL_DIAMETER * 1.8,
    trochoidalAdvance: 0.2,
  })
  assert(plain.moves.length > 0, 'the contour pocket must generate')
  assert(
    JSON.stringify(plain.moves) === JSON.stringify(withFields.moves),
    'setting trochoidal fields must not change a non-trochoidal pattern',
  )
})

test('#676 every non-trochoidal pattern is free of trochoidal warnings', () => {
  for (const pattern of ['offset', 'seeded_offset', 'parallel'] as const) {
    const { project, operation } = buildPocket({ pocketPattern: pattern, stepover: 0.4 })
    const result = generatePocketToolpath(project, operation)
    const leaked = warningCodes(result).filter((code) => code.startsWith('pocketTrochoidal'))
    assert(leaked.length === 0, `${pattern} emitted ${leaked.join(', ')}`)
  }
})

// ── Cut direction ────────────────────────────────────────────────────

/**
 * Net turning of a cut path. A trochoid's small loops dominate the sum, so the
 * sign reports which way the orbit goes round — the quantity that, together
 * with the guide winding, decides whether the cut is climb or conventional.
 */
function orbitTurning(moves: readonly ToolpathMove[]): number {
  const cuts = cutMoves(moves)
  let sum = 0
  for (let index = 0; index + 1 < cuts.length; index += 1) {
    const ax = cuts[index].to.x - cuts[index].from.x
    const ay = cuts[index].to.y - cuts[index].from.y
    const bx = cuts[index + 1].to.x - cuts[index + 1].from.x
    const by = cuts[index + 1].to.y - cuts[index + 1].from.y
    sum += ax * by - ay * bx
  }
  return sum
}

test('#676 the orbit turns the same way as a trochoidal inside edge route', () => {
  // The contract in planning/TROCHOIDAL_EDGE_DESIGN.md § Load-bearing
  // constraints #4, asserted against the shipped implementation of it rather
  // than restated. A pocket's outer ring and an inside edge route are the same
  // cut — tool within a closed guide, material outboard — so for one cut
  // direction they must orbit the same way.
  //
  // This shipped reversed: a single sense derived from `cutDirection` alone
  // gives every ring the EXTERNAL mapping, so climb cut conventional and
  // conventional cut climb, on every trochoidal pocket.
  for (const cutDirection of ['climb', 'conventional'] as const) {
    const { project, operation } = buildPocket({ cutDirection, finishWalls: false })
    const pocket = generatePocketToolpath(project, operation)
    const edge = generateEdgeRouteToolpath(project, {
      ...operation,
      kind: 'edge_route_inside',
      pocketPattern: 'offset',
      stepover: 0.4,
      edgeStrategy: 'trochoidal',
    })
    const pocketTurning = orbitTurning(pocket.moves)
    const edgeTurning = orbitTurning(edge.moves)
    assert(pocketTurning !== 0 && edgeTurning !== 0, `${cutDirection}: both paths must orbit`)
    assert(
      Math.sign(pocketTurning) === Math.sign(edgeTurning),
      `${cutDirection}: pocket orbit turns ${pocketTurning > 0 ? 'CCW' : 'CW'} but the inside edge route turns ${edgeTurning > 0 ? 'CCW' : 'CW'}`,
    )
  }
})

test('#676 reversing the cut direction reverses the orbit', () => {
  const climb = generatePocketToolpath(...(() => {
    const { project, operation } = buildPocket({ cutDirection: 'climb', finishWalls: false })
    return [project, operation] as const
  })())
  const conventional = generatePocketToolpath(...(() => {
    const { project, operation } = buildPocket({ cutDirection: 'conventional', finishWalls: false })
    return [project, operation] as const
  })())
  assert(
    Math.sign(orbitTurning(climb.moves)) === -Math.sign(orbitTurning(conventional.moves)),
    'climb and conventional must orbit in opposite senses',
  )
})

test('#676 an island ring orbits opposite to the outer ring it sits inside', () => {
  // The tool runs inside an outer ring and around an island, so one cut
  // direction puts them on opposite orbit senses. Emitting both the same way
  // is what a single per-operation sense does.
  const zTop = 2
  const project = projectWithFeatures(
    { ...newProject('island', 'mm'), tools: [makeTool()] },
    [
      makeSquareFeature('pocket', 30, zTop, 0),
      { ...makeSquareFeature('island', 8, zTop, 0), operation: 'add' as const },
    ],
  )
  const { operation } = buildPocket({ finishWalls: false })
  const result = generatePocketToolpath(project, {
    ...operation,
    target: { source: 'features', featureIds: ['pocket'] },
  })
  assert(result.moves.length > 0, 'the island pocket must generate')
  assert(
    warningCodes(result).length === 0,
    `it must generate cleanly, got ${warningCodes(result).join(', ')}`,
  )
  // Each ring is entered by its own helix, so the transitions split the stream
  // into per-ring runs. The island run must turn opposite to the outer run.
  const senses = new Set<number>()
  let run: ToolpathMove[] = []
  for (const move of result.moves) {
    if (move.kind === 'rapid' && move.source === 'trochoidal-transition') {
      if (run.length > 0) senses.add(Math.sign(orbitTurning(run)))
      run = []
    } else {
      run.push(move)
    }
  }
  if (run.length > 0) senses.add(Math.sign(orbitTurning(run)))
  senses.delete(0)
  assert(senses.size === 2, `a pocket with an island must emit both orbit senses, got ${[...senses].join(', ')}`)
})

// ── Passages the channel cannot enter ────────────────────────────────

test('#676 a gap too narrow for the channel is named, not silently skipped', () => {
  // The channel is a virtual tool of width W, but its guide needs
  // W/2 + allowance of clearance where a plain cutter needs only its radius. An
  // island sited so the gap to the wall fits the CUTTER but not the CHANNEL
  // therefore gets no pass at all — and said nothing, which is how it reached
  // the running app: the program looked complete and stock was left standing.
  const zTop = 2
  const gap = DEFAULT_CUT_WIDTH - 1        // 8 mm: wider than the 6 mm cutter, under the 9 mm channel
  const half = 30
  const project = projectWithFeatures(
    { ...newProject('tight', 'mm'), tools: [makeTool()] },
    [
      makeSquareFeature('pocket', half, zTop, 0),
      { ...makeSquareFeature('island', half - gap, zTop, 0), id: 'island', name: 'island', operation: 'add' as const },
    ],
  )
  const { operation } = buildPocket()
  const result = generatePocketToolpath(project, {
    ...operation,
    target: { source: 'features', featureIds: ['pocket'] },
  })
  const tight = result.warnings.filter((warning) => warning.code === 'pocketTrochoidalTightSpot')
  assert(tight.length > 0, `expected a tight-spot warning, got ${warningCodes(result).join(', ') || 'none'}`)
  assert(
    tight.every((warning) => Number.isFinite(warning.params?.x) && Number.isFinite(warning.params?.y)),
    'each tight spot must carry the location the UI points at',
  )
})

test('#676 an ordinary pocket reports no tight spots', () => {
  const { project, operation } = buildPocket()
  const result = generatePocketToolpath(project, operation)
  assert(
    !warningCodes(result).includes('pocketTrochoidalTightSpot'),
    'a pocket the channel fits everywhere must not warn about tight spots',
  )
})

// ── Panel controls that cannot change the program ────────────────────

test('#676 a stepover above the measured limit advises, without refusing', () => {
  const { project, operation } = buildPocket({ stepover: 0.95 })
  const result = generatePocketToolpath(project, operation)
  assert(
    warningCodes(result).includes('pocketTrochoidalStepoverHigh'),
    `expected the stepover advisory, got ${warningCodes(result).join(', ') || 'none'}`,
  )
  assert(result.moves.length > 0, 'the advisory must not refuse the operation')

  const atLimit = generatePocketToolpath(project, { ...operation, stepover: TROCHOIDAL_RING_STEPOVER })
  assert(
    !warningCodes(atLimit).includes('pocketTrochoidalStepoverHigh'),
    'the shipped default must not warn about itself',
  )
})

test('#676 corner relief on a trochoidal pocket says so once, not once per corner', () => {
  // It used to emit one `cornerReliefCornerNotCut` per corner and cut no
  // relief: four warnings naming geometry the user cannot act on.
  const { project, operation } = buildPocket({ cornerRelief: 'dogbone', roundOutsideCorners: true })
  const result = generatePocketToolpath(project, operation)
  const codes = warningCodes(result)
  const unsupported = codes.filter((code) => code === 'pocketTrochoidalCornerReliefUnsupported')
  assert(unsupported.length === 1, `expected exactly one advisory, got ${unsupported.length}`)
  assert(
    !codes.includes('cornerReliefCornerNotCut'),
    'the per-corner warnings must not survive alongside it',
  )
  assert(result.moves.length > 0, 'the pocket must still cut')
})

test('#676 the panel withholds the controls a trochoidal orbit cannot use', () => {
  const { operation } = buildPocket({ roundOutsideCorners: true })
  const contour: Operation = { ...operation, pocketPattern: 'offset', stepover: 0.4 }

  // Tangential S-links do not exist on an orbit, and this one predicate gates
  // both the link-rounding row and the XY lead row.
  assert(!usesTangentLinks(operation.kind, operation.pocketPattern), 'trochoidal splices no S-links')
  assert(usesTangentLinks(contour.kind, contour.pocketPattern), 'a contour pocket still does')

  const hidden = ['roundLinkCorners', 'xyLeadStrategy', 'cornerRelief', 'cleanWallCorners']
  for (const id of hidden) {
    const spec = OPERATION_FIELDS.find((field) => field.id === id)
    assert(spec !== undefined, `${id} must exist`)
    assert(!spec.appliesTo(operation), `${id} must be withheld from a trochoidal pocket`)
    assert(spec.appliesTo(contour), `${id} must still be offered on a contour pocket`)
  }

  // Kept deliberately: it picks the island join type, which shapes the ring
  // tree the guides are cut from, so it changes the program.
  const rounding = OPERATION_FIELDS.find((field) => field.id === 'roundOutsideCorners')
  assert(rounding !== undefined && rounding.appliesTo(operation), 'roundOutsideCorners stays offered')
})

// ── The predicate covers every pass that orbits ──────────────────────

test('#676 the CAM predicate covers a finish pass whose floor orbits', () => {
  const { operation } = buildPocket()
  assert(isTrochoidalPocket(operation), 'a rough trochoidal pocket must be trochoidal')
  assert(
    isTrochoidalPocket({ ...operation, pass: 'finish', finishFloor: true }),
    'a finish pass clearing its floor trochoidally must show the channel fields',
  )
  assert(
    !isTrochoidalPocket({ ...operation, pass: 'finish', finishFloor: false }),
    'a finish pass that cuts only walls is a contour operation',
  )
  assert(
    !isTrochoidalPocket({ ...operation, pocketPattern: 'offset' }),
    'a contour pocket is never trochoidal',
  )
})

// ── Summary ──

console.log(`\npocketTrochoidal: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
