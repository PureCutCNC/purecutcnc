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
 * The pocket finish pass may not leave reachable stock at island corners
 * (issue #550).
 *
 * The measurement is geometric, not raster: the nominal pocket region is
 * opened by the finish tool radius (everything outside the opening is a corner
 * no round cutter of that size can enter and never counts as a defect), and
 * what remains of the opening after subtracting the swept envelope of the
 * emitted cuts is the leftover. See src/test/pocketLeftover.ts.
 *
 * Fixture: pocket-finish-island-leftover.camj, reduced from the issue's repro
 * (work/feed-reduction-test2.camj) — a 3 x 2 in rectangle with a 10-point star
 * island, 1/4 in rough with 0.04/0.04 stock to leave, 1/8 in offset finish
 * with zero stock, round corners on.
 *
 * Recorded measurements:
 *   main d3ed477 (before the fix):  0.015495 in2 leftover, 8 patches
 *   after the fix:                  clear — 0.000037 in2 total, all hairline
 *                                   residue under the noise radius
 *
 * The defect was a missing ring: the finish floor skipped the tree regions'
 * island contours (loops 'outer'), which the rough pass cuts, so the corner
 * lens between the rounded wall contour and the floor rings was never cut.
 *
 * Run with: npx tsx src/engine/toolpaths/pocketFinishLeftover.test.ts
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { normalizeProject } from '../../store/helpers/projectFormat'
import { measurePocketLeftover } from '../../test/pocketLeftover'
import type { Operation, Point, Project } from '../../types/project'
import { generatePocketToolpath } from './pocket'
import { resolvePocketRegions } from './resolver'

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function loadFixture(): Project {
  return normalizeProject(
    JSON.parse(readFileSync(
      join('src', 'engine', 'test-fixtures', 'pocket-finish-island-leftover.camj'),
      'utf8',
    )) as Project,
  )
}

function finishOperation(project: Project): Operation {
  const finish = project.operations.find((operation) =>
    operation.kind === 'pocket' && operation.pass === 'finish' && operation.enabled !== false)
  assert(finish !== undefined, 'the fixture must contain an enabled finish pocket operation')
  return finish
}

function leftoverFor(project: Project, overrides: Partial<Operation> = {}): number {
  const finish = finishOperation(project)
  const report = measurePocketLeftover(project, { ...finish, ...overrides })
  return report.regions.reduce((sum, region) => sum + region.leftoverArea, 0)
}

/** The fixture with the star island removed — the island-free control. */
function withoutIsland(project: Project): Project {
  const raw = JSON.parse(JSON.stringify(project)) as Project & {
    featureTree?: Array<{ type?: string; featureId?: string }>
  }
  raw.featureDefinitions = Object.fromEntries(
    Object.entries(raw.featureDefinitions).filter(([id]) => id !== 'f-0010'),
  )
  raw.features = raw.features.filter((feature) => feature.id !== 'f0009')
  raw.featureTree = (raw.featureTree ?? []).filter((row) => row.type !== 'feature' || row.featureId !== 'f0009')
  return normalizeProject(raw)
}

/** Min distance from a point to a polygon's edges. */
function distanceToPolygon(point: Point, polygon: Point[]): number {
  let best = Number.POSITIVE_INFINITY
  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index]
    const b = polygon[(index + 1) % polygon.length]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const lengthSquared = dx * dx + dy * dy
    const t = lengthSquared > 0
      ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared))
      : 0
    best = Math.min(best, Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t)))
  }
  return best
}

/**
 * The tool-centre domain for the rounded finish wall is the pocket eroded by
 * the finish tool radius — at an island corner the rounded contour cuts inside
 * the *miter* offset polygon, so containment is distance-to-island, not
 * point-in-miter-polygon.
 */
function cutClearsIslands(
  point: Point,
  islands: Point[][],
  finishDelta: number,
  tolerance: number,
): boolean {
  for (const island of islands) {
    if (distanceToPolygon(point, island) < finishDelta - tolerance) return false
  }
  return true
}

function testRoundedFinishClears(): void {
  console.log('Testing rounded pocket finish leaves no reachable island-corner stock...')
  const project = loadFixture()
  const finish = finishOperation(project)
  const leftover = leftoverFor(project)
  // Fixed: clear — 0.000037 in2 total, all hairline residue under the noise
  // radius. The threshold sits far below the 0.015495 baseline; the
  // measurement core counts only islands above LEFTOVER_NOISE_RADIUS.
  assert(leftover <= 0.0002, `expected <= 0.0002 in2 leftover, got ${leftover.toFixed(6)}`)

  // Every emitted cut of the finish pass must clear every island by at least
  // the finish tool radius: no pass may cut into an island.
  const { bands } = resolvePocketRegions(project, finish)
  const islands = bands.flatMap((band) => band.regions.flatMap((region) => region.islands))
  const cuts = generatePocketToolpath(project, finish).moves.filter((move) => move.kind === 'cut')
  assert(cuts.length > 0, 'the finish pass must emit cut moves')
  for (const move of cuts) {
    for (const point of [move.from, move.to]) {
      assert(
        cutClearsIslands(point, islands, 0.0625, 5e-4),
        `finish cut at (${point.x.toFixed(4)}, ${point.y.toFixed(4)}) is within the finish tool radius of an island`,
      )
    }
  }
  console.log('rounded pocket finish island-corner stock: PASSED')
}

function testUnroundedFinishAlsoClears(): void {
  console.log('Testing the unrounded finish pass also comes back clear...')
  const project = loadFixture()
  const leftover = leftoverFor(project, { roundOutsideCorners: false })
  // The unrounded pass cuts the same island rings with miter joins, so it
  // clears too — the missing ring, not the corner treatment, was the defect.
  assert(leftover <= 0.0002, `expected <= 0.0002 in2 leftover, got ${leftover.toFixed(6)}`)
  console.log('unrounded finish reference: PASSED')
}

function testIslandFreeControlClears(): void {
  console.log('Testing the island-free control comes back clear...')
  const project = withoutIsland(loadFixture())
  const leftover = leftoverFor(project)
  assert(leftover === 0, `expected zero leftover for the island-free control, got ${leftover.toFixed(6)}`)
  console.log('island-free control: PASSED')
}

testRoundedFinishClears()
testUnroundedFinishAlsoClears()
testIslandFreeControlClears()
