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
 * Smooth-tab machine motion (issue #414).
 *
 * These tests are about what the machine actually does: where Z is at each
 * point of a tab crossing, that it never dips below what the tab requires, and
 * that re-cutting the identical XY path split a different way produces the same
 * Z envelope. The tool-centre coordinates are the quantity that would physically
 * go wrong, so they are what is asserted.
 *
 * Run with: npx tsx src/engine/toolpaths/tabSmoothing.test.ts
 */

import { defaultTool, newProject, rectProfile, type Operation, type Project, type Tab } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import { generateEdgeRouteToolpath } from './edge'
import { applyEdgeRouteTabs, applyTabsToEdgeRoute } from './tabs'
import { optimizeLinearMoves } from './linearMoveOptimization'
import { smoothTabZAt } from './tabProfile'
import type { ToolpathMove, ToolpathResult } from './types'

// ── Harness ──────────────────────────────────────────────────────────

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function assertClose(actual: number, expected: number, tolerance: number, message: string): void {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new Error(`Assertion failed: ${message} (expected ${expected}, got ${actual})`)
  }
}

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`   ✓ ${name}`)
  } catch (err: unknown) {
    failed += 1
    console.log(`   ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────

/**
 * Z is measured from the stock bottom, so the final profile pass sits at 0 and a
 * tab spanning `z_bottom: 0` to `z_top: 3` is exactly what interrupts it.
 */
const CUT_Z = 0
const TAB_TOP = 3

/**
 * No tool reference and no radial stock-to-leave, so the expanded obstacle is
 * exactly the tab rectangle. The cutter-envelope expansion is `tabs.ts`'s own
 * concern and already covered by `tabs.test.ts`; keeping it out here means the
 * crossing arc lengths are the tab dimensions and the expected Z values can be
 * written down exactly.
 */
function operation(): Operation {
  const base: Operation = {
    id: 'op1',
    name: 'Edge',
    kind: 'edge_route_inside',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: ['f1'] },
    toolRef: null,
    stepdown: 4,
    stepover: 0.4,
    feed: 800,
    plungeFeed: 300,
    rpm: 18000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    roundOutsideCorners: false,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 1,
    maxCarveDepth: 1,
    cutDirection: 'conventional',
    machiningOrder: 'level_first',
  }
  return base
}

function projectWithTabs(tabs: Tab[]): Project {
  const base = newProject()
  return {
    ...base,
    meta: { ...base.meta, units: 'mm' },
    stock: { ...base.stock, thickness: 12 },
    tools: [{ ...defaultTool('mm', 1), id: 't1', name: 'em6', diameter: 6, units: 'mm' }],
    tabs,
  }
}

/** Tab spanning [x, x+w] × [y, y+h]; `rectProfile` treats x/y as the corner. */
function tab(id: string, x: number, y: number, w: number, h: number, shape: Tab['shape'], zTop = TAB_TOP): Tab {
  return { id, name: `Tab ${id}`, x, y, w, h, z_top: zTop, z_bottom: 0, visible: true, shape }
}

function result(moves: ToolpathMove[]): ToolpathResult {
  return { operationId: 'op1', moves, warnings: [], bounds: null }
}

/** One straight cut along y = 50, from x = 0 to x = 100, split into `pieces`. */
function straightPass(pieces: number, reversed = false): ToolpathMove[] {
  const moves: ToolpathMove[] = []
  for (let index = 0; index < pieces; index += 1) {
    const a = (index / pieces) * 100
    const b = ((index + 1) / pieces) * 100
    const fromX = reversed ? 100 - a : a
    const toX = reversed ? 100 - b : b
    moves.push({ kind: 'cut', from: { x: fromX, y: 50, z: CUT_Z }, to: { x: toX, y: 50, z: CUT_Z } })
  }
  return moves
}

/** Highest Z the emitted polyline occupies at abscissa `x`. */
function zAtX(moves: ToolpathMove[], x: number): number {
  let best = Number.NEGATIVE_INFINITY
  for (const move of moves) {
    const lo = Math.min(move.from.x, move.to.x)
    const hi = Math.max(move.from.x, move.to.x)
    if (x < lo - 1e-9 || x > hi + 1e-9) continue
    if (Math.abs(hi - lo) <= 1e-9) {
      best = Math.max(best, move.from.z, move.to.z)
      continue
    }
    const t = (x - move.from.x) / (move.to.x - move.from.x)
    best = Math.max(best, move.from.z + (move.to.z - move.from.z) * t)
  }
  return best
}

function cutMoves(moves: ToolpathMove[]): ToolpathMove[] {
  return moves.filter((move) => move.kind === 'cut')
}

function verticalTransitions(moves: ToolpathMove[]): ToolpathMove[] {
  return moves.filter(
    (move) =>
      Math.abs(move.from.x - move.to.x) <= 1e-9
      && Math.abs(move.from.y - move.to.y) <= 1e-9
      && Math.abs(move.from.z - move.to.z) > 1e-9,
  )
}

// ── Rectangular tabs are untouched ───────────────────────────────────

test('a rect tab still steps: vertical lift at the boundary, flat top, vertical drop', () => {
  const project = projectWithTabs([tab('tb1', 40, 40, 20, 20, 'rect')])
  const out = applyTabsToEdgeRoute(project, operation(), result(straightPass(1)))

  const lifts = verticalTransitions(out.moves)
  assert(lifts.length === 2, `expected exactly two vertical transitions, got ${lifts.length}`)
  assertClose(lifts[0].from.x, 40, 1e-6, 'lift happens at the footprint entry')
  assertClose(lifts[1].from.x, 60, 1e-6, 'drop happens at the footprint exit')

  // Flat across the whole footprint — the rectangular envelope, unchanged.
  for (const x of [40, 45, 50, 55, 60]) {
    assertClose(zAtX(out.moves, x), TAB_TOP, 1e-9, `rect tab rides z_top at x=${x}`)
  }
})

test('a legacy tab with no shape field behaves as rectangular', () => {
  const legacy = { ...tab('tb1', 40, 40, 20, 20, 'rect') }
  delete (legacy as { shape?: Tab['shape'] }).shape

  const project = projectWithTabs([legacy])
  const out = applyTabsToEdgeRoute(project, operation(), result(straightPass(1)))

  assert(verticalTransitions(out.moves).length === 2, 'legacy tab steps like a rect tab')
  assertClose(zAtX(out.moves, 45), TAB_TOP, 1e-9, 'legacy tab rides z_top')
})

// ── The smooth crossing itself ───────────────────────────────────────

test('a smooth crossing enters at the cut Z, peaks at exactly z_top, and exits at the cut Z', () => {
  const project = projectWithTabs([tab('tb1', 40, 40, 20, 20, 'smooth')])
  const out = applyTabsToEdgeRoute(project, operation(), result(straightPass(1)))

  assertClose(zAtX(out.moves, 40), CUT_Z, 1e-9, 'no step at the footprint entry')
  assertClose(zAtX(out.moves, 60), CUT_Z, 1e-9, 'no step at the footprint exit')
  assertClose(zAtX(out.moves, 50), TAB_TOP, 1e-9, 'z_top reached exactly at the crossing centre')

  // The peak is reached, not merely approached: some emitted vertex is at z_top.
  const peak = Math.max(...out.moves.flatMap((move) => [move.from.z, move.to.z]))
  assertClose(peak, TAB_TOP, 1e-9, 'the emitted path actually touches z_top')
})

test('a smooth crossing has no vertical step anywhere', () => {
  const project = projectWithTabs([tab('tb1', 40, 40, 20, 20, 'smooth')])
  const out = applyTabsToEdgeRoute(project, operation(), result(straightPass(1)))

  assert(
    verticalTransitions(out.moves).length === 0,
    'smooth tabs must never emit a vertical lift or plunge',
  )
  assert(
    out.moves.every((move) => move.kind === 'cut'),
    'every emitted move across a smooth tab is a cut, moving XY and Z together',
  )
})

test('a smooth crossing rises monotonically then falls monotonically', () => {
  const project = projectWithTabs([tab('tb1', 40, 40, 20, 20, 'smooth')])
  const out = applyTabsToEdgeRoute(project, operation(), result(straightPass(1)))

  let previous = zAtX(out.moves, 40)
  for (let x = 40; x <= 50; x += 0.25) {
    const z = zAtX(out.moves, x)
    assert(z >= previous - 1e-9, `rise is monotonic at x=${x}`)
    previous = z
  }
  previous = zAtX(out.moves, 50)
  for (let x = 50; x <= 60; x += 0.25) {
    const z = zAtX(out.moves, x)
    assert(z <= previous + 1e-9, `fall is monotonic at x=${x}`)
    previous = z
  }
})

test('a smooth crossing never cuts below the pass depth', () => {
  const project = projectWithTabs([tab('tb1', 40, 40, 20, 20, 'smooth')])
  const out = applyTabsToEdgeRoute(project, operation(), result(straightPass(1)))

  for (const move of out.moves) {
    assert(move.from.z >= CUT_Z - 1e-9, 'no emitted point dips below the pass depth')
    assert(move.to.z >= CUT_Z - 1e-9, 'no emitted point dips below the pass depth')
  }
})

test('the pass still reaches full depth outside the tab', () => {
  const project = projectWithTabs([tab('tb1', 40, 40, 20, 20, 'smooth')])
  const out = applyTabsToEdgeRoute(project, operation(), result(straightPass(1)))

  assertClose(zAtX(out.moves, 10), CUT_Z, 1e-9, 'material before the tab is cut to depth')
  assertClose(zAtX(out.moves, 90), CUT_Z, 1e-9, 'material after the tab is cut to depth')
  assert(
    out.warnings.every((warning) => warning.code !== 'tabsBlockFinalDepth'),
    'a single smooth tab does not block the final pass',
  )
})

// ── Re-segmentation invariance ───────────────────────────────────────

test('splitting the same XY path differently does not change the Z envelope', () => {
  const project = projectWithTabs([tab('tb1', 40, 40, 20, 20, 'smooth')])

  // Compare every segmentation against the *analytic* profile rather than
  // against each other. Two sampled polylines through the same curve can differ
  // by up to twice the chord tolerance purely because one has more vertices, so
  // comparing them directly measures sampling luck; comparing each to the ideal
  // curve measures the thing that matters. CHORD_TOLERANCE is the documented
  // 0.01 mm budget from `tabs.ts`.
  const CHORD_TOLERANCE = 0.01
  const analytic = (x: number) => smoothTabZAt((x - 40) / 20, CUT_Z, TAB_TOP)

  for (const pieces of [1, 2, 3, 7, 40, 137]) {
    const out = applyTabsToEdgeRoute(project, operation(), result(straightPass(pieces)))
    for (let x = 40; x <= 60; x += 0.1) {
      assertClose(
        zAtX(out.moves, x),
        analytic(x),
        CHORD_TOLERANCE,
        `${pieces}-piece path tracks the ideal curve at x=${x}`,
      )
    }
    // And the invariants that must be exact regardless of segmentation.
    assertClose(zAtX(out.moves, 50), TAB_TOP, 1e-9, `${pieces}-piece path peaks exactly at z_top`)
    assertClose(zAtX(out.moves, 40), CUT_Z, 1e-9, `${pieces}-piece path enters exactly at the cut Z`)
    assertClose(zAtX(out.moves, 60), CUT_Z, 1e-9, `${pieces}-piece path exits exactly at the cut Z`)
  }
})

test('a path split exactly on the footprint boundary matches one split across it', () => {
  const project = projectWithTabs([tab('tb1', 40, 40, 20, 20, 'smooth')])
  const aligned = result([
    { kind: 'cut', from: { x: 0, y: 50, z: CUT_Z }, to: { x: 40, y: 50, z: CUT_Z } },
    { kind: 'cut', from: { x: 40, y: 50, z: CUT_Z }, to: { x: 60, y: 50, z: CUT_Z } },
    { kind: 'cut', from: { x: 60, y: 50, z: CUT_Z }, to: { x: 100, y: 50, z: CUT_Z } },
  ])
  const reference = applyTabsToEdgeRoute(project, operation(), result(straightPass(1)))
  const out = applyTabsToEdgeRoute(project, operation(), aligned)

  for (let x = 35; x <= 65; x += 0.1) {
    assertClose(zAtX(out.moves, x), zAtX(reference.moves, x), 2e-3, `boundary-aligned split matches at x=${x}`)
  }
})

test('approaching the tab from the other direction mirrors the same envelope', () => {
  const project = projectWithTabs([tab('tb1', 40, 40, 20, 20, 'smooth')])
  const forward = applyTabsToEdgeRoute(project, operation(), result(straightPass(1)))
  const backward = applyTabsToEdgeRoute(project, operation(), result(straightPass(1, true)))

  for (let x = 35; x <= 65; x += 0.1) {
    assertClose(zAtX(backward.moves, x), zAtX(forward.moves, x), 2e-3, `reverse pass matches at x=${x}`)
  }
})

// ── Overlaps take the highest envelope ───────────────────────────────

test('overlapping smooth tabs never cut below the higher of the two', () => {
  const project = projectWithTabs([
    tab('tb1', 40, 40, 20, 20, 'smooth', 2),
    tab('tb2', 50, 40, 20, 20, 'smooth', 5),
  ])
  const out = applyTabsToEdgeRoute(project, operation(), result(straightPass(1)))

  // Each tab's own peak must still be reached at its own centre.
  assertClose(zAtX(out.moves, 60), 5, 1e-9, 'the taller tab reaches its own z_top at its centre')
  assert(zAtX(out.moves, 50) >= 2 - 1e-9, 'the shorter tab is not machined away by its neighbour')

  for (let x = 40; x <= 70; x += 0.1) {
    assert(zAtX(out.moves, x) >= CUT_Z - 1e-9, `never below the pass depth at x=${x}`)
  }
})

test('a rect tab overlapping a smooth tab keeps the rectangular envelope', () => {
  const project = projectWithTabs([
    tab('tb1', 40, 40, 20, 20, 'rect', 2),
    tab('tb2', 50, 40, 20, 20, 'smooth', 5),
  ])
  const out = applyTabsToEdgeRoute(project, operation(), result(straightPass(1)))

  // The rect footprint spans [40, 60] and demands z = 2 across all of it. The
  // smooth tab may raise Z further, never lower it.
  for (let x = 40; x <= 60; x += 0.1) {
    assert(zAtX(out.moves, x) >= 2 - 1e-9, `rect envelope is respected at x=${x}`)
  }
  assertClose(zAtX(out.moves, 60), 5, 1e-9, 'the smooth tab still reaches its own peak')
})

test('a crossing buried inside one long move is still found', () => {
  // The move is sampled at a few points to decide which crossings touch it. A
  // small tab far from every sample point — here the move spans 0..200 and the
  // footprint is 120..140, while the midpoint sample sits at 100 — is exactly
  // what a sample-only test would miss, leaving the tab uncut.
  const project = projectWithTabs([tab('tb1', 120, 40, 20, 20, 'smooth')])
  const out = applyTabsToEdgeRoute(
    project,
    operation(),
    result([{ kind: 'cut', from: { x: 0, y: 50, z: CUT_Z }, to: { x: 200, y: 50, z: CUT_Z } }]),
  )

  assertClose(zAtX(out.moves, 130), TAB_TOP, 1e-9, 'the buried crossing still peaks at z_top')
  assertClose(zAtX(out.moves, 120), CUT_Z, 1e-9, 'and enters at the cut Z')
  assertClose(zAtX(out.moves, 140), CUT_Z, 1e-9, 'and exits at the cut Z')
})

// ── Safety differential ──────────────────────────────────────────────
// The strongest statement available: recompute the required envelope in the
// test, independently of the engine, and check every emitted point against it.
// A per-x lookup that takes the maximum over overlapping segments can hide a
// wrong envelope behind a neighbouring segment; sampling each emitted segment
// individually cannot.

/** Required Z at abscissa `x` for a pass along y = 50, derived from the tabs. */
function analyticEnvelope(tabs: Tab[], x: number): number {
  let required = CUT_Z
  for (const entry of tabs) {
    if (!(entry.z_top > entry.z_bottom) || !(entry.z_top > CUT_Z)) continue
    if (!(CUT_Z < entry.z_top && CUT_Z >= entry.z_bottom)) continue
    // Strictly inside. A rectangular footprint's boundary legitimately carries
    // two Z values — the approach cut ends there at depth and the raised cut
    // begins there at z_top — so the boundary itself cannot be constrained.
    if (x <= entry.x + 1e-6 || x >= entry.x + entry.w - 1e-6) continue
    required = Math.max(
      required,
      entry.shape === 'smooth'
        ? smoothTabZAt((x - entry.x) / entry.w, CUT_Z, entry.z_top)
        : entry.z_top,
    )
  }
  return required
}

function assertNeverBelowEnvelope(tabs: Tab[], moves: ToolpathMove[], tolerance: number): void {
  for (const move of moves) {
    if (move.kind !== 'cut') continue
    for (let step = 0; step <= 16; step += 1) {
      const t = step / 16
      const x = move.from.x + (move.to.x - move.from.x) * t
      const z = move.from.z + (move.to.z - move.from.z) * t
      const required = analyticEnvelope(tabs, x)
      assert(
        z >= required - tolerance,
        `emitted cut is below the tab envelope at x=${x.toFixed(4)}: z=${z.toFixed(5)} < ${required.toFixed(5)}`,
      )
    }
  }
}

test('every emitted segment stays at or above the analytic tab envelope', () => {
  const matrix: Tab[][] = [
    [tab('tb1', 40, 40, 20, 20, 'smooth')],
    [tab('tb1', 40, 40, 20, 20, 'rect')],
    [tab('tb1', 40, 40, 20, 20, 'smooth', 2), tab('tb2', 50, 40, 20, 20, 'smooth', 5)],
    [tab('tb1', 40, 40, 20, 20, 'rect', 2), tab('tb2', 50, 40, 20, 20, 'smooth', 5)],
    [tab('tb1', 40, 40, 20, 20, 'smooth', 5), tab('tb2', 50, 40, 20, 20, 'rect', 2)],
    [tab('tb1', 20, 40, 10, 20, 'smooth'), tab('tb2', 70, 40, 10, 20, 'smooth')],
  ]

  for (const tabs of matrix) {
    for (const pieces of [1, 5, 61]) {
      const out = applyTabsToEdgeRoute(projectWithTabs(tabs), operation(), result(straightPass(pieces)))
      assertNeverBelowEnvelope(tabs, out.moves, 0.01)
    }
  }
})

test('non-tab stretches still reach the intended final depth', () => {
  const tabs = [tab('tb1', 40, 40, 20, 20, 'smooth'), tab('tb2', 70, 40, 10, 20, 'smooth')]
  const out = applyTabsToEdgeRoute(projectWithTabs(tabs), operation(), result(straightPass(1)))

  for (const x of [5, 20, 35, 65, 68, 85, 98]) {
    assertClose(zAtX(out.moves, x), CUT_Z, 1e-9, `material clear of every tab is cut to depth at x=${x}`)
  }
})

// ── Malformed input ──────────────────────────────────────────────────

test('a smooth tab whose top is below the pass depth changes nothing', () => {
  const project = projectWithTabs([tab('tb1', 40, 40, 20, 20, 'smooth', -8)])
  const out = applyTabsToEdgeRoute(project, operation(), result(straightPass(1)))

  for (const move of out.moves) {
    assertClose(move.from.z, CUT_Z, 1e-9, 'no lift for a tab below the cut')
    assertClose(move.to.z, CUT_Z, 1e-9, 'no lift for a tab below the cut')
  }
})

test('a smooth tab with a reversed Z range never plunges', () => {
  const reversed: Tab = { ...tab('tb1', 40, 40, 20, 20, 'smooth'), z_top: 0, z_bottom: 6 }
  const project = projectWithTabs([reversed])
  const out = applyTabsToEdgeRoute(project, operation(), result(straightPass(1)))

  for (const move of out.moves) {
    assert(move.from.z >= CUT_Z - 1e-9, 'no point below the pass depth')
    assert(move.to.z >= CUT_Z - 1e-9, 'no point below the pass depth')
  }
})

// ── The optimizer must not flatten the ramp ──────────────────────────

test('the linear-move optimizer cannot merge away the ramp samples', () => {
  const project = projectWithTabs([tab('tb1', 40, 40, 20, 20, 'smooth')])
  const out = applyTabsToEdgeRoute(project, operation(), result(straightPass(1)))
  const optimized = optimizeLinearMoves(out)

  const rampSegments = cutMoves(optimized.moves).filter(
    (move) => Math.abs(move.from.z - move.to.z) > 1e-9,
  )
  assert(rampSegments.length >= 8, `ramp survives optimization, got ${rampSegments.length} sloped cuts`)
  assertClose(zAtX(optimized.moves, 50), TAB_TOP, 1e-9, 'the peak survives optimization')
  assertClose(zAtX(optimized.moves, 40), CUT_Z, 1e-9, 'the entry survives optimization')
})

// ── Closed loops and seams ───────────────────────────────────────────

/** Square loop, counter-clockwise from (20,20) to (80,80), split per side. */
function squareLoop(startCorner: number): ToolpathMove[] {
  const corners = [
    { x: 20, y: 20 },
    { x: 80, y: 20 },
    { x: 80, y: 80 },
    { x: 20, y: 80 },
  ]
  const moves: ToolpathMove[] = []
  for (let index = 0; index < 4; index += 1) {
    const from = corners[(startCorner + index) % 4]
    const to = corners[(startCorner + index + 1) % 4]
    moves.push({ kind: 'cut', from: { ...from, z: CUT_Z }, to: { ...to, z: CUT_Z } })
  }
  return moves
}

test('a closed loop crossing a smooth tab mid-side ramps continuously', () => {
  // Tab straddling the bottom edge (y = 20) between x = 45 and x = 55.
  const project = projectWithTabs([tab('tb1', 45, 15, 10, 10, 'smooth')])
  const out = applyTabsToEdgeRoute(project, operation(), result(squareLoop(0)))

  assert(verticalTransitions(out.moves).length === 0, 'no vertical step on a smooth crossing')
  const bottomEdge = out.moves.filter((move) => Math.abs(move.from.y - 20) <= 1e-9 && Math.abs(move.to.y - 20) <= 1e-9)
  assertClose(zAtX(bottomEdge, 50), TAB_TOP, 1e-9, 'peak reached at the tab centre')
  assertClose(zAtX(bottomEdge, 45), CUT_Z, 1e-9, 'entry at the footprint boundary')
  assertClose(zAtX(bottomEdge, 55), CUT_Z, 1e-9, 'exit at the footprint boundary')
})

test('a loop whose seam falls inside a smooth tab is still one continuous crossing', () => {
  // The tab covers the (20,20) corner, which is where `squareLoop(0)` starts and
  // ends. Handled naively the crossing arrives as two fragments at opposite ends
  // of the arc-length axis and the tool would plunge to depth at the seam.
  const project = projectWithTabs([tab('tb1', 14, 14, 12, 12, 'smooth')])
  const out = applyTabsToEdgeRoute(project, operation(), result(squareLoop(0)))

  // The seam is the crossing centre, so the loop must both arrive at and leave
  // it at z_top. Anything less means the crossing was treated as two fragments
  // and the tool dropped to depth in the middle of the tab.
  const arrivalZ = out.moves[out.moves.length - 1].to.z
  assertClose(arrivalZ, TAB_TOP, 1e-9, 'the loop arrives at the seam at z_top')

  const departure = out.moves.find((move) => move.kind === 'cut')
  assert(departure !== undefined, 'the loop emits a cut')
  assertClose(departure.from.z, TAB_TOP, 1e-9, 'and leaves the seam at z_top')

  // The only vertical move allowed is the initial lift, which exists solely
  // because this fixture's move list opens mid-tab with no preceding plunge for
  // `adjustVerticalMoveForTabs` to raise. Nothing may plunge later.
  const interiorLifts = verticalTransitions(out.moves.slice(1))
  assert(interiorLifts.length === 0, `no plunge inside the loop, got ${interiorLifts.length}`)

  // Rotating which corner the loop starts at must not change the envelope: the
  // crossing is measured in path distance, not from the seam.
  const rotated = applyTabsToEdgeRoute(project, operation(), result(squareLoop(2)))
  const peakA = Math.max(...out.moves.flatMap((move) => [move.from.z, move.to.z]))
  const peakB = Math.max(...rotated.moves.flatMap((move) => [move.from.z, move.to.z]))
  assertClose(peakB, peakA, 1e-9, 'peak height is independent of the loop seam')
  assertClose(peakA, TAB_TOP, 1e-9, 'the wrapped crossing still reaches z_top exactly')
})

// ── Truncated crossings ──────────────────────────────────────────────

test('an open path ending inside a smooth tab holds z_top instead of plunging', () => {
  const project = projectWithTabs([tab('tb1', 40, 40, 20, 20, 'smooth')])
  // Path stops at x = 50, the tab centre — the exit ramp does not exist.
  const out = applyTabsToEdgeRoute(
    project,
    operation(),
    result([{ kind: 'cut', from: { x: 0, y: 50, z: CUT_Z }, to: { x: 50, y: 50, z: CUT_Z } }]),
  )

  const last = out.moves[out.moves.length - 1]
  assert(
    last.to.z > CUT_Z + 0.5,
    `path ending inside the footprint must stay lifted, got z=${last.to.z}`,
  )
  assertClose(zAtX(out.moves, 40), CUT_Z, 1e-9, 'the entry ramp still starts at the cut Z')
})

test('an open path starting inside a smooth tab does not cut out of it at depth', () => {
  const project = projectWithTabs([tab('tb1', 40, 40, 20, 20, 'smooth')])
  const out = applyTabsToEdgeRoute(
    project,
    operation(),
    result([{ kind: 'cut', from: { x: 50, y: 50, z: CUT_Z }, to: { x: 100, y: 50, z: CUT_Z } }]),
  )

  assert(out.moves[0].from.z > CUT_Z + 0.5 || out.moves[0].to.z > CUT_Z + 0.5,
    'a path starting inside the footprint lifts before travelling')
  assertClose(zAtX(out.moves, 60), CUT_Z, 1e-9, 'it still comes back to depth at the footprint exit')
})

// ── Multi-level passes ───────────────────────────────────────────────

test('a smooth tab only affects passes that are below its top', () => {
  const project = projectWithTabs([tab('tb1', 40, 40, 20, 20, 'smooth')])
  // A pass above the tab top is untouched; one below it ramps.
  const shallow = result([{ kind: 'cut', from: { x: 0, y: 50, z: 6 }, to: { x: 100, y: 50, z: 6 } }])
  const out = applyTabsToEdgeRoute(project, operation(), shallow)

  assert(out.moves.length === 1, 'a pass above the tab top is left alone')
  assertClose(out.moves[0].to.z, 6, 1e-9, 'and stays at its own depth')
})

// ── Every strategy the shared pass owns ──────────────────────────────

test('finish-surface passes ramp exactly like contour Edge Route', () => {
  // `useToolpathGeneration` routes finish_surface and finish_surface_cleanup
  // through `applyTabsToEdgeRoute` too, so smooth motion has to reach them. If
  // this ever diverges from the edge-route result, one of the two is wrong.
  const project = projectWithTabs([tab('tb1', 40, 40, 20, 20, 'smooth')])
  const reference = applyTabsToEdgeRoute(project, operation(), result(straightPass(1)))

  for (const kind of ['finish_surface', 'finish_surface_cleanup', 'pocket'] as const) {
    const out = applyTabsToEdgeRoute(project, { ...operation(), kind }, result(straightPass(1)))
    assert(out.moves.length === reference.moves.length, `${kind} emits the same move count`)
    for (let index = 0; index < out.moves.length; index += 1) {
      assertClose(out.moves[index].to.z, reference.moves[index].to.z, 1e-9, `${kind} matches at move ${index}`)
    }
  }
})

test('an unsupported operation kind is left alone entirely', () => {
  const project = projectWithTabs([tab('tb1', 40, 40, 20, 20, 'smooth')])
  const input = result(straightPass(1))
  const out = applyTabsToEdgeRoute(project, { ...operation(), kind: 'drilling' }, input)
  assert(out === input, 'drilling is not a tab-bearing operation and is returned untouched')
})

// ── Trochoidal Edge Route falls back, and says so ────────────────────

test('a smooth tab on a trochoidal Edge Route warns instead of silently stepping', () => {
  const project = projectWithFeatures(projectWithTabs([tab('tb1', 56, 16, 8, 8, 'smooth')]), [
    {
      id: 'f1',
      name: 'Boss',
      kind: 'rect',
      folderId: null,
      sketch: {
        profile: rectProfile(20, 20, 80, 60),
        origin: { x: 0, y: 0 },
        orientationAngle: 0,
        dimensions: [],
        constraints: [],
      },
      operation: 'add',
      z_top: 12,
      z_bottom: 0,
      visible: true,
      locked: false,
    },
  ] as never)

  const trochoidal: Operation = {
    ...operation(),
    kind: 'edge_route_outside',
    toolRef: 't1',
    edgeStrategy: 'trochoidal',
    trochoidalCutWidth: 9,
    trochoidalAdvance: 0.35,
    entryStrategy: 'helix',
  }

  const generated = generateEdgeRouteToolpath({ ...project, tabs: projectWithTabs([tab('tb1', 56, 16, 8, 8, 'smooth')]).tabs }, trochoidal)
  const codes = generated.warnings.map((warning) => warning.code)
  assert(
    codes.includes('edgeTrochoidalSmoothTabFallback'),
    `expected the smooth-tab fallback warning, got ${JSON.stringify(codes)}`,
  )

  // And the shared pass must still decline to touch trochoidal output at all —
  // the guide-domain design owns tab motion there.
  const afterTabs = applyEdgeRouteTabs(project, trochoidal, generated)
  assert(afterTabs.moves === generated.moves, 'the shared tab pass leaves trochoidal output untouched')
})

test('a rectangular tab on a trochoidal Edge Route raises no fallback warning', () => {
  const project = projectWithFeatures(projectWithTabs([tab('tb1', 56, 16, 8, 8, 'rect')]), [
    {
      id: 'f1',
      name: 'Boss',
      kind: 'rect',
      folderId: null,
      sketch: {
        profile: rectProfile(20, 20, 80, 60),
        origin: { x: 0, y: 0 },
        orientationAngle: 0,
        dimensions: [],
        constraints: [],
      },
      operation: 'add',
      z_top: 12,
      z_bottom: 0,
      visible: true,
      locked: false,
    },
  ] as never)

  const trochoidal: Operation = {
    ...operation(),
    kind: 'edge_route_outside',
    toolRef: 't1',
    edgeStrategy: 'trochoidal',
    trochoidalCutWidth: 9,
    trochoidalAdvance: 0.35,
    entryStrategy: 'helix',
  }

  const codes = generateEdgeRouteToolpath(
    { ...project, tabs: projectWithTabs([tab('tb1', 56, 16, 8, 8, 'rect')]).tabs },
    trochoidal,
  ).warnings.map((warning) => warning.code)
  assert(!codes.includes('edgeTrochoidalSmoothTabFallback'), 'no fallback warning for a rectangular tab')
})

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\n  tabSmoothing: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  process.exit(1)
}
