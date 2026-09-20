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
 * Cost of the helix placement search per candidate cell (issue #812).
 *
 * `pointToRegionDistance` and `pointInRegion` used to walk every contour of a
 * clearance region up to four times for every cell the search pops:
 * `pointInContour` runs `pointOnContour` before its own crossing pass,
 * `pointInRegion` runs `pointOnContour` a second time per island in its
 * `&& !pointOnContour` guard, and the distance loop then walks everything
 * again. With ~80 tab keep-out islands hung on a region by `withEntryKeepOut`
 * that is ~2,400 contour points rescanned several times per cell, and on the
 * reported project it cost 63.7 s of a 64.6 s regeneration. `entry.ts` now
 * makes one indexed pass per contour and skips a contour whose cached bounding
 * box cannot beat the running minimum.
 *
 * Two instruments guard that, because neither covers the whole property:
 *
 *  - `contour reads`, below, counts element accesses on the contour arrays
 *    through a `Proxy`. It is exact, machine independent and cannot flake, and
 *    it moves for *every* reintroduced pass including the one on the outer
 *    contour. It is the primary guard.
 *  - `cpuRatio`, below, is the timing assertion `docs/PERF_ASSERTIONS.md`
 *    prescribes. It catches the collapse cases — the bounding-box skip going
 *    away, or the whole thing reverting — with ~2.4x headroom either side. It
 *    cannot catch a single reintroduced pass; see its own comment for why.
 *
 * Neither is a correctness test. `entryDenseIslandsFixture.test.ts` is what
 * stands between a refactor of `pointToRegionDistance` and a moved toolpath.
 *
 * Run with: npx tsx src/engine/toolpaths/entrySearchPerf.test.ts
 */

import type { Point } from '../../types/project'
import { cpuRatio } from '../../test/cpuRatio'
import { synthesizeEntry, type EntryClearanceRegion, type EntryPolicy } from './entry'
import type { ToolpathMove } from './types'

function assert(condition: unknown, message: string): asserts condition {
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

const TOOL_DIAMETER = 0.25

function policy(region: EntryClearanceRegion): EntryPolicy {
  return {
    strategy: 'helix',
    rampAngle: 5,
    helixDiameterPercent: 80,
    toolDiameter: TOOL_DIAMETER,
    cutFeed: 800,
    plungeFeed: 200,
    cutDirection: 'conventional',
    cutSide: 'internal',
    clearanceRegions: [region],
  }
}

/** A circle at the density a flattened arc gets, 5° per segment. */
function circle(center: Point, radius: number): Point[] {
  const points: Point[] = []
  for (let index = 0; index < 72; index += 1) {
    const angle = Math.PI * 2 * index / 72
    points.push({
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
    })
  }
  return points
}

// ── the timing pair ───────────────────────────────────────────────────
//
// Both halves run the same search over the same outer contour, so they pop the
// same cells and differ only in how much contour work each popped cell costs.

const SLOT_WIDTH = 0.19
const SLOT_LENGTH = 1.5
/**
 * The slot is tilted off the search lattice on purpose. `findReachableHelixPlacement`
 * seeds its quadtree from the region's bounding box, so an axis-aligned slot puts
 * the first row of cell centres exactly on the maximum-clearance ridge and the
 * search accepts immediately. Tilted, the ridge is a diagonal the lattice never
 * lands on, the search runs to its 20,000-cell budget, and the per-cell cost is
 * what the clock measures.
 */
const SLOT_ANGLE = 0.4
const COS = Math.cos(SLOT_ANGLE)
const SIN = Math.sin(SLOT_ANGLE)

function slotPoint(along: number, across: number): Point {
  return { x: along * COS - across * SIN, y: along * SIN + across * COS }
}

/** The invariant reference: the same slot with nothing hung on it. */
function bareSlot(): EntryClearanceRegion {
  return {
    outer: [
      slotPoint(0, 0),
      slotPoint(SLOT_LENGTH, 0),
      slotPoint(SLOT_LENGTH, SLOT_WIDTH),
      slotPoint(0, SLOT_WIDTH),
    ],
    islands: [],
  }
}

/** The subject: the same slot carrying 80 keep-out islands, as `withEntryKeepOut` leaves it. */
function slotWithKeepOuts(): EntryClearanceRegion {
  const region = bareSlot()
  for (let index = 0; index < 80; index += 1) {
    const along = (index + 0.5) / 80 * SLOT_LENGTH
    const across = index % 2 === 0 ? -0.16 : SLOT_WIDTH + 0.16
    region.islands.push(circle(slotPoint(along, across), 0.14))
  }
  return region
}

const slotTarget = { ...slotPoint(SLOT_LENGTH / 2, SLOT_WIDTH / 2), z: -0.1 }

function placeHelix(region: EntryClearanceRegion): { moves: ToolpathMove[]; strategy: string; warnings: number } {
  const moves: ToolpathMove[] = []
  const result = synthesizeEntry(moves, null, slotTarget, 1, policy(region))
  return { moves, strategy: result.usedStrategy, warnings: result.warnings.length }
}

test('the timing pair searches identically — only the per-cell contour work differs', () => {
  const bare = placeHelix(bareSlot())
  const loaded = placeHelix(slotWithKeepOuts())
  // Same strategy, same warning count and the same emitted moves: the 80
  // keep-outs sit clear of every centre the search would accept, so they add
  // scanning work and change nothing about the outcome. If this ever fails the
  // ratio below has stopped measuring one variable and must be re-derived.
  assert(
    bare.strategy === 'helix' && loaded.strategy === 'helix',
    `both halves must place a helix, got ${bare.strategy} and ${loaded.strategy}`,
  )
  assert(
    bare.warnings === loaded.warnings,
    `warning counts must match, got ${bare.warnings} and ${loaded.warnings}`,
  )
  assert(
    JSON.stringify(bare.moves) === JSON.stringify(loaded.moves),
    'the two halves must emit identical moves, or they are not running the same search',
  )
})

test('80 keep-out islands do not multiply the cost of every candidate cell', () => {
  // Subject: the tilted slot with 80 keep-out islands, 72 points each.
  // Reference: the same slot with no islands. Both exhaust the same 20,000-cell
  // budget in both searches — measured 40,000 pops and ~48,000 distance calls on
  // each half, within 1% — so the reference is invariant to everything the
  // island path does, and only the per-contour work moves the ratio.
  //
  //                                       subject      reference       ratio
  //     current                       92.2..112.2ms   6.4..19.2ms   12.52..16.24
  //     one island pass reintroduced 174.6..187.7ms    6.4..7.6ms   23.30..28.27
  //     bounding-box skip removed    703.8..864.4ms    6.8..8.3ms   92.13..121.28
  //     pre-#812 `pointToRegionDistance`  ~2.1..2.4s   7.6..10.0ms  238.06..272.61
  //
  // The reference column stays put across all four rows, which is the property
  // that makes the ratio mean anything. Node v26, 5 reps subject / 3 reference,
  // measured both idle and against eight competing spinners; the one 19.2ms
  // reference reading is a loaded run, and it only ever *lowers* the ratio, so
  // contention cannot redden this.
  //
  // The limit is the geometric mid-point of the worst pair — highest observed
  // baseline 16.24 against lowest observed collapse 92.13 — so ~2.4x clear
  // either side.
  //
  // **It does not catch a single reintroduced pass.** One extra pass can at most
  // double the island work, and 16.24 against 23.30 leaves 1.20x each side of
  // the mid-point, inside the ±1.45x cross-session spread `cpuRatio` documents.
  // Pretending otherwise would buy a flaky required check. The exact contour-read
  // counts below are what guard the pass count, and they catch the outer
  // contour's pass too, which no subject/reference ratio can see: it scales both
  // halves alike.
  const subject = slotWithKeepOuts()
  const reference = bareSlot()
  placeHelix(subject)
  placeHelix(reference)
  const { ratio, subjectMs, referenceMs } = cpuRatio(
    { run: () => { placeHelix(subject) } },
    { run: () => { placeHelix(reference) } },
  )
  console.log(
    `  80 keep-out islands: ${subjectMs.toFixed(0)}ms CPU vs `
    + `${referenceMs.toFixed(0)}ms bare-slot reference (ratio ${ratio.toFixed(2)})`,
  )
  assert(
    ratio < 38,
    `a slot carrying 80 keep-out islands costs ${ratio.toFixed(2)}x the bare slot `
    + `(limit 38x; ${subjectMs.toFixed(0)}ms vs ${referenceMs.toFixed(0)}ms CPU) — `
    + 'check that a candidate cell still skips a contour whose cached bounding box '
    + 'cannot beat the running minimum, and still makes one pass over the ones it keeps',
  )
})

// ── the exact instrument ──────────────────────────────────────────────
//
// Counting element reads on the contour arrays measures the thing directly:
// passes over contour points. It needs nothing from production code — the
// region is handed in by the caller, so a `Proxy` over each contour array sees
// every `contour[index]` the search makes.

let contourReads = 0

function counted(points: Point[]): Point[] {
  return new Proxy(points, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) contourReads += 1
      return Reflect.get(target, key, receiver) as unknown
    },
  }) as Point[]
}

/** An open 4 x 4 pocket, optionally with a row of keep-outs along one edge. */
function countedRegion(islands: number): EntryClearanceRegion {
  return {
    outer: counted([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }]),
    islands: Array.from(
      { length: islands },
      (_unused, index) => counted(circle({ x: 0.5 + index * 0.35, y: 0.5 }, 0.12)),
    ),
  }
}

function readsToPlace(islands: number): { reads: number; strategy: string; moves: number; warnings: number } {
  const region = countedRegion(islands)
  contourReads = 0
  const moves: ToolpathMove[] = []
  const result = synthesizeEntry(moves, null, { x: 2, y: 2, z: -0.1 }, 1, policy(region))
  return { reads: contourReads, strategy: result.usedStrategy, moves: moves.length, warnings: result.warnings.length }
}

/**
 * Measured on `f512e774`. These are cost figures, not outputs — a deliberate
 * ratchet, in the spirit of the move counts in `trochoidal249kFixture.test.ts`.
 * Re-derive rather than guess if the search itself is ever retuned: print
 * `readsToPlace(0)` and `readsToPlace(8)` and check the placement below is
 * still the same one.
 *
 * What each removed pass costs, measured by reintroducing it one at a time:
 *
 *     variant                                 0 islands   8 islands
 *     current                                     1,376     179,504
 *     outer `pointOnContour` pass restored        2,720     186,320
 *     island `pointOnContour` pass restored       1,376     348,848
 *     bounding-box skip removed                   1,376     992,960
 *     pre-#812 `pointToRegionDistance`            4,060   2,964,268
 *
 * Every one of them moves a column, so any single reintroduced pass reddens
 * this test — including the outer one, which the timing ratio above is blind
 * to. The 0-island column is the pass count on the outer contour alone; the
 * 8-island column adds the island path and the bounding-box skip.
 */
const EXPECTED_READS_BARE = 1_376
const EXPECTED_READS_WITH_ISLANDS = 179_504

test('one pass over the outer contour per distance evaluation', () => {
  const bare = readsToPlace(0)
  assert(bare.strategy === 'helix', `expected a helix placement, got ${bare.strategy}`)
  assert(
    bare.reads === EXPECTED_READS_BARE,
    `expected ${EXPECTED_READS_BARE.toLocaleString('en-US')} contour reads placing a helix in a bare `
    + `4 x 4 pocket, got ${bare.reads.toLocaleString('en-US')}. Above it, a pass over the outer contour `
    + 'has come back (#812); below it, or on any change to the search itself, re-derive the number.',
  )
})

test('islands are scanned once each, and skipped when their bounding box is out of reach', () => {
  const loaded = readsToPlace(8)
  assert(loaded.strategy === 'helix', `expected a helix placement, got ${loaded.strategy}`)
  assert(
    loaded.reads === EXPECTED_READS_WITH_ISLANDS,
    `expected ${EXPECTED_READS_WITH_ISLANDS.toLocaleString('en-US')} contour reads placing a helix in a `
    + `4 x 4 pocket with 8 keep-outs, got ${loaded.reads.toLocaleString('en-US')}. Above it, a pass over the `
    + 'island contours has come back or the bounding-box skip has stopped firing (#812).',
  )
})

test('the read counts are measured on an unchanged placement', () => {
  // A count is only evidence if the search it counts still reaches the same
  // answer, so pin the placement the two counts were measured against.
  const bare = readsToPlace(0)
  const loaded = readsToPlace(8)
  assert(bare.moves === 1010, `expected 1,010 moves with no islands, got ${bare.moves}`)
  assert(loaded.moves === 1010, `expected 1,010 moves with 8 islands, got ${loaded.moves}`)
  assert(bare.warnings === 0 && loaded.warnings === 0,
    `expected no warnings, got ${bare.warnings} and ${loaded.warnings}`)
})

console.log(`\nentry search cost: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
