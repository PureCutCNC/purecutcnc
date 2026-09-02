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
 * What the height-map finish strategies do at the depth limit
 * (issues #711 and #712).
 *
 * Both defects lived in the same few lines of the per-point Z chain, and both
 * were invisible to the existing suite because every finish-surface test pinned
 * `stockToLeaveAxial: 0` and no test looked at what was emitted *below* a
 * subtract's floor.
 *
 * **#711** — where the cutter-location surface sits under a floor a subtract
 * owns, the clamp turned "nothing here I may cut" into a flat pass at the
 * limit. `model-in-pocket.camj` is that shape exactly: a flat-topped block in a
 * pocket floored at Z 0.5, whose surface has only two levels (0.750 on 16.3 %
 * of cells, 0.300 on 83.7 %) and **nothing in between**. Parallel spent 4,041
 * moves and 126.71 of 164.32 units of cutting skimming Z 0.500.
 *
 * **#712** — `finishSurfaceParallel.ts` never read `stockToLeaveAxial` at all,
 * so a parallel finish asked to leave stock cut to final size, silently.
 *
 * The rule is deliberately narrow, and the tab test below is why: a tab-raised
 * floor must keep clamping, because riding at the tab top is what machines down
 * to the tab and preserves it.
 *
 * Mutations run against every assertion here, each failing exactly its own test:
 *   - `hasMachinableSurface` forced to `true` (the pre-#711 clamp): both
 *     pocket-floor tests fail with 4,041 parallel moves back at Z 0.500, and so
 *     does the tab test — its anti-vacuity guard requires the untabbed fixture
 *     to have *no* cutting in that footprint, which the old clamp violates.
 *   - `hasMachinableSurface` with the tab clause dropped: the tab test fails and
 *     both pocket-floor tests still pass, which is why they are separate claims.
 *   - `sp.z = safeZ + axialLeave` reverted to `sp.z = safeZ`: only the two axial
 *     tests fail, with a shift of 0 against the requested 0.5.
 *
 * Run with: npx tsx src/engine/toolpaths/finishSurfaceDepthClamp.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { normalizeProject } from '../../store/projectStore'
import { generateFinishSurfaceToolpath } from './finishSurface'
import { slopeTestMesh, surfaceTestProject } from '../../test/surfaceSlopeFixtures'
import { convertProjectUnits } from '../../utils/units'
import type { Operation, PocketPattern, Project, Tab } from '../../types/project'
import type { ToolpathMove } from './types'

// ── The tracked model-in-a-pocket fixture ───────────────────────────────────
const POCKET_FLOOR_Z = 0.5   // subtract "Rect 3" z_bottom
const MODEL_TOP_Z = 0.75     // the block's flat top, the only machinable surface

function pocketFixture(): { project: Project; operation: Operation } {
  const project = normalizeProject(
    JSON.parse(readFileSync(new URL('../test-fixtures/model-in-pocket.camj', import.meta.url), 'utf8')) as Project,
  )
  const operation = project.operations.find((o) => o.id === 'op6792442')!
  return { project, operation: { ...operation, kind: 'finish_surface' } }
}

const cuts = (moves: ToolpathMove[]): ToolpathMove[] => moves.filter((move) => move.kind === 'cut')
const lengthAtZ = (moves: ToolpathMove[], z: number): number => cuts(moves)
  .filter((move) => Math.abs(move.from.z - z) < 1e-6 && Math.abs(move.to.z - z) < 1e-6)
  .reduce((total, move) => total + Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y), 0)

for (const pattern of ['parallel', 'constant_scallop'] as PocketPattern[]) {
  test(`${pattern}: nothing is cut at a pocket floor the finish has no surface to reach`, () => {
    const { project, operation } = pocketFixture()
    const result = generateFinishSurfaceToolpath(project, { ...operation, pocketPattern: pattern })

    const atFloor = cuts(result.moves).filter(
      (move) => Math.abs(move.from.z - POCKET_FLOOR_Z) < 1e-6 && Math.abs(move.to.z - POCKET_FLOOR_Z) < 1e-6,
    )
    assert.equal(atFloor.length, 0, `${atFloor.length} cut moves still ride the pocket floor`)

    // No cut point may sit below the floor either — the pass should have
    // stopped, not descended.
    for (const move of cuts(result.moves)) {
      for (const point of [move.from, move.to]) {
        assert(
          point.z >= POCKET_FLOOR_Z - 1e-6,
          `cut point at Z ${point.z} is below the ${POCKET_FLOOR_Z} floor`,
        )
      }
    }

    // Anti-vacuity: the real surface is still machined. Without this the test
    // would pass on an empty toolpath, which is the obvious wrong fix.
    assert(
      lengthAtZ(result.moves, MODEL_TOP_Z) > 20,
      `the model top at Z ${MODEL_TOP_Z} is no longer machined`,
    )
  })
}

test('a tab still gets ridden over, even where the surface is below the floor', () => {
  // The tab sits over the block's base, which is at Z 0.300 — well under the
  // 0.5 pocket floor, so #711's rule would skip it if tabs were not exempt.
  // Riding at the tab top is the whole point: it machines down to the tab.
  const { project, operation } = pocketFixture()
  const tab: Tab = {
    id: 'tab-under-floor', name: 'Tab', x: 0.4, y: 0.4, w: 0.3, h: 0.3,
    z_top: 0.62, z_bottom: 0, visible: true,
  }
  const withTab: Project = { ...project, tabs: [tab] }
  const inTab = (move: ToolpathMove): boolean => {
    const x = (move.from.x + move.to.x) / 2, y = (move.from.y + move.to.y) / 2
    return x >= tab.x && x <= tab.x + tab.w && y >= tab.y && y <= tab.y + tab.h
  }

  const withoutTabResult = generateFinishSurfaceToolpath(project, { ...operation, pocketPattern: 'parallel' })
  assert.equal(
    cuts(withoutTabResult.moves).filter(inTab).length, 0,
    'the fixture must have no cutting in the tab footprint before the tab is added, or the test proves nothing',
  )

  const result = generateFinishSurfaceToolpath(withTab, { ...operation, pocketPattern: 'parallel' })
  const onTab = cuts(result.moves).filter(inTab)
  assert(onTab.length > 0, 'the tab footprint is no longer machined at all')
  for (const move of onTab) {
    for (const point of [move.from, move.to]) {
      assert(
        point.z >= tab.z_top - 1e-6,
        `a cut at Z ${point.z} inside the tab would cut into its ${tab.z_top} top`,
      )
    }
  }
})

// ── #712: parallel honours axial stock to leave ─────────────────────────────
const ramp = (degrees: number) => (_x: number, y: number): number =>
  2 + y * Math.tan(degrees * Math.PI / 180)

test('parallel raises every cut by exactly the axial stock to leave', () => {
  const leave = 0.5
  for (const pattern of ['parallel', 'constant_scallop'] as PocketPattern[]) {
    const { project, operation } = surfaceTestProject(slopeTestMesh(ramp(30), 60, 40, 1), 4)
    const base = { ...operation, pocketPattern: pattern, stepover: 0.25, pocketAngle: 0 }
    const none = generateFinishSurfaceToolpath(project, { ...base, stockToLeaveAxial: 0 })
    const raised = generateFinishSurfaceToolpath(project, { ...base, stockToLeaveAxial: leave })
    const a = cuts(none.moves), b = cuts(raised.moves)
    assert(a.length > 100, `${pattern} produced no cutting to compare`)
    assert.equal(b.length, a.length, `${pattern} changed which passes it emits when leaving stock`)
    for (let index = 0; index < a.length; index += 1) {
      assert(Math.abs(b[index].from.x - a[index].from.x) <= 1e-9, `${pattern} cut ${index} moved in X`)
      assert(Math.abs(b[index].from.y - a[index].from.y) <= 1e-9, `${pattern} cut ${index} moved in Y`)
      assert(
        Math.abs(b[index].from.z - a[index].from.z - leave) <= 1e-9,
        `${pattern} cut ${index} rose by ${(b[index].from.z - a[index].from.z).toFixed(6)}, not ${leave}`,
      )
    }
  }
})

test('the axial stock a parallel finish leaves survives unit conversion', () => {
  const leave = 0.5
  const { project, operation } = surfaceTestProject(slopeTestMesh(ramp(30), 60, 40, 1), 4)
  const base = { ...operation, pocketPattern: 'parallel' as const, stepover: 0.25, pocketAngle: 0 }
  for (const units of ['mm', 'inch'] as const) {
    const scale = units === 'mm' ? 1 : 1 / 25.4
    const converted = units === 'mm' ? project : convertProjectUnits(project, units)
    const patch = (axial: number): Operation =>
      ({ ...converted.operations[0], ...base, stockToLeaveAxial: axial * scale })
    const none = cuts(generateFinishSurfaceToolpath(converted, patch(0)).moves)
    const raised = cuts(generateFinishSurfaceToolpath(converted, patch(leave)).moves)
    assert(none.length > 100, `${units} produced no cutting to compare`)
    assert.equal(raised.length, none.length, `${units} changed which passes it emits`)
    const shift = raised[0].from.z - none[0].from.z
    assert(
      Math.abs(shift - leave * scale) <= 1e-9,
      `${units} raised the pass by ${shift}, not ${leave * scale}`,
    )
  }
})
