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
 * The `trochoidal-249k.camj` render fixture holds its move count (issue #664).
 *
 * This is a *calibration* guard, not a correctness test. #664 is a rendering
 * defect measured on one project — a 2 x 2 in outside trochoidal edge route
 * that emits 249,663 moves with no warning and then makes the app unusable for
 * as long as it is open. Every number in that issue, the profile taken against
 * it, and whatever threshold phase 3's advisory eventually lands on are all
 * calibrated against this one figure. If the fixture silently stops emitting
 * 249,663 moves, the issue's evidence quietly stops describing the fixture and
 * nobody finds out.
 *
 * So the assertion is **exact, not a range**. A generator change that moves the
 * count is not necessarily wrong — it is a signal to re-measure the profile and
 * update the issue, which a `> 200_000` bound would never give.
 *
 * The count is also the thing #659's three children were required *not* to
 * change: #661 shipped under a byte-identical-G-code criterion, #662 never
 * touched emission, and #660's sagitta bound landed before this figure was
 * taken. Measured identical on `fab1b9f` and on `9cd0325`.
 *
 * Recorded on `9cd0325` (node v26.0.0):
 *   moves     249,663   (cut 248,040 / lead_in 1,620 / rapid 2 / plunge 1)
 *   warnings  none
 *   levels    15 flat cut levels, 16,536 cut moves each
 *
 * ## What each mutation kills
 *
 * Verified by breaking things on purpose, not by a green run:
 *
 * | Mutation | Killed by |
 * | --- | --- |
 * | expected count edited to 249,662 | `emits exactly 249,663 moves` |
 * | fixture `stepdown` 0.05 -> 0.1 (halves the levels) | `emits exactly 249,663 moves`, `move mix` |
 * | `trochoidalAdvance` forced to 0.2 x D | `emits exactly 249,663 moves`, `move mix` |
 * | any budget guard lowered under 249,663 points | `generates without a warning` (refusal warning appears) |
 * | `edgeStrategy` no longer read as trochoidal | `move mix` (lead-in count collapses) |
 *
 * Run with: npx tsx src/engine/toolpaths/trochoidal249kFixture.test.ts
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { normalizeProject } from '../../store/projectStore'
import type { Operation, Project } from '../../types/project'
import { generateEdgeRouteToolpath } from './edge'
import type { ToolpathResult } from './types'

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
  } catch (err: unknown) {
    failed += 1
    console.log(`   ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Measured on `9cd0325`; the figure every number in issue #664 is calibrated against. */
const EXPECTED_MOVES = 249_663

/** Same run, broken out by kind so a change of *shape* cannot hide behind the total. */
const EXPECTED_MOVE_MIX: Record<string, number> = {
  cut: 248_040,
  lead_in: 1_620,
  rapid: 2,
  plunge: 1,
}

function loadFixture(): Project {
  return normalizeProject(
    JSON.parse(
      readFileSync(join('src', 'engine', 'test-fixtures', 'trochoidal-249k.camj'), 'utf8'),
    ) as Project,
  )
}

function generate(): { project: Project; operation: Operation; result: ToolpathResult } {
  const project = loadFixture()
  const operation = project.operations.find((candidate) => candidate.kind === 'edge_route_outside')
  assert(operation !== undefined, 'fixture must contain the edge_route_outside operation')
  return { project, operation, result: generateEdgeRouteToolpath(project, operation) }
}

// One generation shared by every assertion below — it is ~0.6 s and none of
// these tests mutate the result.
const { project, operation, result } = generate()

console.log('\ntrochoidal-249k fixture')

test('fixture still describes the repro: 2 x 2 in, 1/8 in flat, trochoidal, 0.05 stepdown', () => {
  assert(project.meta.units === 'inch', `expected an inch project, got ${project.meta.units}`)
  assert(
    operation.edgeStrategy === 'trochoidal',
    `expected a trochoidal edge route, got ${String(operation.edgeStrategy)}`,
  )
  assert(operation.stepdown === 0.05, `expected 0.05 in stepdown, got ${String(operation.stepdown)}`)
  assert(
    operation.trochoidalCutWidth === undefined && operation.trochoidalAdvance === undefined,
    'the repro leaves cut width and advance at their defaults; setting either changes the count',
  )
  const tool = project.tools.find((candidate) => candidate.id === operation.toolRef)
  assert(tool !== undefined, 'fixture must ship the tool the operation references')
  assert(tool.diameter === 0.125, `expected a 1/8 in cutter, got ${tool.diameter}`)
  assert(tool.type === 'flat_endmill', `expected a flat endmill, got ${tool.type}`)
})

test(`emits exactly ${EXPECTED_MOVES.toLocaleString('en-US')} moves`, () => {
  assert(
    result.moves.length === EXPECTED_MOVES,
    `expected ${EXPECTED_MOVES} moves, got ${result.moves.length}. ` +
      'This fixture calibrates issue #664 — if the change is intentional, re-measure ' +
      'the render profile and update the issue before updating this number.',
  )
})

test('move mix is unchanged (cut / lead_in / rapid / plunge)', () => {
  const actual: Record<string, number> = {}
  for (const move of result.moves) actual[move.kind] = (actual[move.kind] ?? 0) + 1
  const kinds = new Set([...Object.keys(EXPECTED_MOVE_MIX), ...Object.keys(actual)])
  for (const kind of kinds) {
    assert(
      actual[kind] === EXPECTED_MOVE_MIX[kind],
      `expected ${EXPECTED_MOVE_MIX[kind] ?? 0} ${kind} moves, got ${actual[kind] ?? 0}`,
    )
  }
})

test('generates without a warning — the whole point of #664', () => {
  assert(
    result.warnings.length === 0,
    `expected no warnings, got ${result.warnings.map((w) => w.code).join(', ')}. ` +
      'A user at this move count is told nothing today; that gap is #664 phase 3.',
  )
})

test('cuts 15 flat levels, 16,536 cut moves each', () => {
  const cutMovesPerLevel = new Map<string, number>()
  for (const move of result.moves) {
    if (move.kind !== 'cut') continue
    // A flat cut level holds Z constant across the whole move; ramping helix
    // entry and lead-ins are excluded by kind above and by this equality.
    if (move.from.z !== move.to.z) continue
    const key = move.to.z.toFixed(6)
    cutMovesPerLevel.set(key, (cutMovesPerLevel.get(key) ?? 0) + 1)
  }
  const levels = [...cutMovesPerLevel.values()].filter((count) => count > 1000)
  assert(levels.length === 15, `expected 15 flat cut levels, got ${levels.length}`)
  for (const count of levels) {
    assert(count === 16_536, `expected 16,536 cut moves on every level, got ${count}`)
  }
})

console.log(`\ntrochoidal-249k fixture: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
