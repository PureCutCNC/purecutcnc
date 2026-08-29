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
 * The two trochoidal point guards, which issue #662 separated (`trochoidalEdge.ts`).
 *
 * One flat 500,000-point budget used to answer two unrelated questions and
 * refused the whole operation for both, with the same message:
 *
 * | Failure | Nature | What must happen |
 * | --- | --- | --- |
 * | the advance approaching zero | a defective parameter, per fragment | refuse, naming the advance |
 * | a large or deep part | legitimate work | generate |
 *
 * So the tests here are about which guard fires, not only that one does. The
 * degeneracy fixture is deliberately far too small to reach any ceiling — it
 * costs well under half of even the old 500,000, so before the cap it generated
 * a path that re-cut the same material hundreds of times, silently — and the
 * ceiling fixture uses a legal advance so it cannot be mistaken for degeneracy.
 *
 * ## What each mutation kills
 *
 * Verified by breaking the code on purpose, not by a green run.
 *
 * | Mutation | Killed by |
 * | --- | --- |
 * | degeneracy cap removed | `a degenerate advance refuses…` (generates instead of refusing) |
 * | degeneracy branch dropped from the warning mapping | `a degenerate advance refuses…` |
 * | ceiling reported as degeneracy | `a job past the ceiling refuses…` |
 * | ceiling lowered back towards 500,000 | `the 400 x 300 mm case…` |
 * | ceiling made non-fatal / partial | both refusal tests assert zero moves |
 * | `loopCount > 1` exemption dropped | `trochoidalEdge.test.ts` single-orbit guide |
 * | cap measured on the ceil'd loop count again | `the panel's smallest advance…` |
 *
 * Run with: npx tsx src/engine/toolpaths/trochoidalPointBudget.test.ts
 */

import { defaultTool, newProject, rectProfile, type Operation, type Project } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import { generateEdgeRouteToolpath } from './edge'
import { DEFAULT_TROCHOIDAL_POINT_BUDGET } from './trochoidalEdge'

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

const TOOL_DIAMETER = 6

function partProject(width: number, height: number, depth: number): Project {
  const base = newProject('budget', 'mm')
  const stockTop = depth + 2
  const project: Project = {
    ...base,
    meta: { ...base.meta, units: 'mm' },
    stock: {
      ...base.stock,
      profile: rectProfile(-60, -60, width + 120, height + 120),
      thickness: stockTop,
    },
    tools: [{ ...defaultTool('mm', 1), id: 't1', name: 'em6', diameter: TOOL_DIAMETER, units: 'mm' }],
  }
  return projectWithFeatures(project, [
    {
      id: 'part',
      name: 'Part',
      kind: 'rect',
      folderId: null,
      sketch: {
        profile: rectProfile(0, 0, width, height),
        origin: { x: 0, y: 0 },
        orientationAngle: 0,
        dimensions: [],
        constraints: [],
      },
      operation: 'add',
      z_top: stockTop,
      z_bottom: stockTop - depth,
      visible: true,
      locked: false,
    },
  ])
}

function trochoidalOutside(stepdown: number, advance: number): Operation {
  return {
    id: 'op1',
    name: 'Edge',
    kind: 'edge_route_outside',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: ['part'] },
    toolRef: 't1',
    stepdown,
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
    edgeStrategy: 'trochoidal',
    trochoidalCutWidth: TOOL_DIAMETER * 1.5,
    trochoidalAdvance: advance,
    entryStrategy: 'helix',
    entryRampAngle: 5,
  }
}

/**
 * The case issue #662 was filed on. It refused at the old 500,000 ceiling with
 * `edgeTrochoidalMoveBudget` after 8 of its 10 levels — legitimate work turned
 * away by a guard meant for defective parameters.
 */
test('the 400 x 300 mm case at 2 mm stepdown and 20 mm deep generates', () => {
  const result = generateEdgeRouteToolpath(partProject(400, 300, 20), trochoidalOutside(2, 0.1))
  assert(
    result.warnings.length === 0,
    `must generate cleanly, got [${result.warnings.map((w) => w.code).join(', ')}]`,
  )
  assert(result.moves.length > 500_000, `the fixture must exceed the old ceiling, got ${result.moves.length}`)
  assert(
    result.moves.length <= DEFAULT_TROCHOIDAL_POINT_BUDGET,
    `and must sit inside the current one, got ${result.moves.length} against ${DEFAULT_TROCHOIDAL_POINT_BUDGET}`,
  )
})

/**
 * Fail closed, deliberately: a partial trochoidal path re-enters material the
 * orbit never cleared, so there is no safe half-answer. See
 * `planning/TROCHOIDAL_EDGE_DESIGN.md` § Budgets.
 */
test('a job past the ceiling refuses whole, and as a ceiling breach', () => {
  const result = generateEdgeRouteToolpath(partProject(400, 300, 60), trochoidalOutside(2, 0.1))
  assert(result.moves.length === 0, `refusal must be total, got ${result.moves.length} moves`)
  assert(
    result.warnings.some((w) => w.code === 'edgeTrochoidalMoveBudget'),
    `expected the ceiling, got [${result.warnings.map((w) => w.code).join(', ') || 'none'}]`,
  )
  assert(
    !result.warnings.some((w) => w.code === 'edgeTrochoidalAdvanceDegenerate'),
    'a job that is merely too big must not be blamed on the advance',
  )
})

/**
 * The check the ceiling can never be. This part is small enough that the
 * degenerate path costs well under the ceiling, so before #662 it generated with
 * no warning at all: 0.005 x D advances the orbit 30 microns per loop and cuts
 * the same material over and over.
 */
test('a degenerate advance refuses by naming the advance, on a part no ceiling would catch', () => {
  const project = partProject(50, 50, 2)
  const result = generateEdgeRouteToolpath(project, trochoidalOutside(2, 0.005))
  assert(result.moves.length === 0, `a degenerate advance must emit nothing, got ${result.moves.length}`)
  assert(
    result.warnings.some((w) => w.code === 'edgeTrochoidalAdvanceDegenerate'),
    `expected the advance to be named, got [${result.warnings.map((w) => w.code).join(', ') || 'none'}]`,
  )
  assert(
    !result.warnings.some((w) => w.code === 'edgeTrochoidalMoveBudget'),
    'a defective parameter must not be reported as an exhausted ceiling',
  )

  // The same geometry at a legal advance generates, and generates small — which
  // is what makes the point: the ceiling was never going to fire here.
  const healthy = generateEdgeRouteToolpath(project, trochoidalOutside(2, 0.1))
  assert(healthy.warnings.length === 0, `the control must generate: [${healthy.warnings.map((w) => w.code).join(', ')}]`)
  assert(
    healthy.moves.length * 10 < DEFAULT_TROCHOIDAL_POINT_BUDGET,
    `the control must sit far below the ceiling, got ${healthy.moves.length}`,
  )
})

/**
 * The other end of the cap: the smallest advance the CAM panel offers is exactly
 * `0.01 x D` (`CAMPanel.tsx`, `min={1}` percent clamped by `Math.max(0.01, …)`),
 * so it is an ordinary setting, not a defect, and must cut.
 *
 * The first form of the cap compared the ceil'd orbit count with the real
 * quotient it was rounded up from, which made `ceil(m) > m` true for every guide
 * whose length was not a whole number of advances — so the panel's minimum
 * refused these three parts outright, where before the cap they generated
 * 70,743 / 94,743 / 94,743 moves.
 */
test("the panel's smallest advance cuts on ordinary parts", () => {
  for (const [width, height] of [[40, 30], [50, 50], [60, 40]] as const) {
    const result = generateEdgeRouteToolpath(partProject(width, height, 2), trochoidalOutside(2, 0.01))
    assert(
      result.warnings.length === 0,
      `${width} x ${height} at the panel minimum must generate: [${result.warnings.map((w) => w.code).join(', ')}]`,
    )
    assert(result.moves.length > 0, `${width} x ${height} at the panel minimum must emit motion`)
  }

  // And the bound still discriminates: a hair below it is degenerate.
  const under = generateEdgeRouteToolpath(partProject(60, 40, 2), trochoidalOutside(2, 0.0099))
  assert(under.moves.length === 0, `just under the panel minimum must refuse, got ${under.moves.length} moves`)
  assert(
    under.warnings.some((w) => w.code === 'edgeTrochoidalAdvanceDegenerate'),
    `expected the advance to be named, got [${under.warnings.map((w) => w.code).join(', ') || 'none'}]`,
  )
})

console.log(`\ntrochoidalPointBudget: ${passed} passed, ${failed} failed`)
if (failed > 0) throw new Error(`${failed} test(s) failed`)
