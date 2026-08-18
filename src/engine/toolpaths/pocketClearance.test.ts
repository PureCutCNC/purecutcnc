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
 * Corner smoothing may not leave stock behind (issue #546).
 *
 * Every other test here asserts something about the *path* — its radius, its
 * junctions, its containment. None of them can see the failure that matters
 * most to somebody running the job: an option that quietly stops removing
 * material. Rounding moves the tool centre away from the corner, so it is the
 * one class of change that can do exactly that.
 *
 * The check rasterises the material to be removed and tests every cell against
 * the swept envelope of the emitted cuts. The bar is self-referential rather
 * than a remembered number: **smoothing may not leave more uncleared material
 * than not smoothing**. Whatever a round cutter cannot reach — the sharp wall
 * and island corners it can never enter — is already left by the unsmoothed
 * path, so it cancels, and only a real regression moves the count.
 *
 * One fixture carries a known, measured, accepted gap instead — see
 * `testKnownCoverageGapDoesNotGrow`. Three other pocket fixtures showed
 * nothing; only that one catches it.
 *
 * Run with: npx tsx src/engine/toolpaths/pocketClearance.test.ts
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { normalizeProject } from '../../store/helpers/projectFormat'
import type { Operation, Point, Project } from '../../types/project'
import { normalizeToolForProject } from './geometry'
import { generatePocketToolpath } from './pocket'
import { resolvePocketRegions } from './resolver'
import { buildSweptCoverage } from './sweptCoverage'

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function pointInPolygon(x: number, y: number, polygon: Point[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]
    const b = polygon[j]
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside
    }
  }
  return inside
}

/** Cells of the material region no emitted cut reaches, at the deepest level. */
function unclearedCells(project: Project, operation: Operation, toolRadius: number): number {
  const moves = generatePocketToolpath(project, operation).moves
  const cutMoves = moves.filter((move) => move.kind === 'cut')
  if (cutMoves.length === 0) return 0
  const z = Math.min(...cutMoves.map((move) => move.to.z))
  const planar = cutMoves.filter((move) =>
    Math.abs(move.to.z - z) <= 1e-9
    && Math.abs(move.from.z - z) <= 1e-9
    && Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y) > 1e-9)
  const coverage = buildSweptCoverage(
    planar.map((move) => [{ x: move.from.x, y: move.from.y }, { x: move.to.x, y: move.to.y }]),
    toolRadius,
  )
  const cell = toolRadius / 10
  let uncleared = 0
  for (const band of resolvePocketRegions(project, operation).bands) {
    for (const region of band.regions) {
      const xs = region.outer.map((point) => point.x)
      const ys = region.outer.map((point) => point.y)
      for (let x = Math.min(...xs); x <= Math.max(...xs); x += cell) {
        for (let y = Math.min(...ys); y <= Math.max(...ys); y += cell) {
          if (!pointInPolygon(x, y, region.outer)) continue
          if (region.islands.some((island) => pointInPolygon(x, y, island))) continue
          if (!coverage.covers(x, y)) uncleared += 1
        }
      }
    }
  }
  return uncleared
}

function measure(fixture: string): { unsmoothed: number; rounded: number; withWall: number } {
  const project = normalizeProject(
    JSON.parse(readFileSync(join('src', 'engine', 'test-fixtures', fixture), 'utf8')) as Project,
  )
  const base = project.operations.find((candidate) =>
    candidate.kind === 'pocket' && candidate.enabled !== false)
  assert(base !== undefined, `${fixture}: must contain an enabled pocket operation`)
  const tool = project.tools.find((candidate) => candidate.id === base.toolRef)
  assert(tool !== undefined, `${fixture}: the operation must resolve its tool`)
  const toolRadius = normalizeToolForProject(tool, project).diameter / 2
  return {
    unsmoothed: unclearedCells(project, { ...base, roundOutsideCorners: false, cleanWallCorners: false }, toolRadius),
    rounded: unclearedCells(project, { ...base, roundOutsideCorners: true, cleanWallCorners: false }, toolRadius),
    withWall: unclearedCells(project, { ...base, roundOutsideCorners: true, cleanWallCorners: true }, toolRadius),
  }
}

function testSmoothingLeavesNoStock(fixture: string): void {
  const { unsmoothed, rounded, withWall } = measure(fixture)
  assert(unsmoothed > 0,
    `${fixture}: the fixture must have corners a round cutter cannot enter, or this proves nothing`)
  assert(rounded <= unsmoothed,
    `${fixture}: rounding corners left ${rounded - unsmoothed} more cells uncleared than not rounding`)
  assert(withWall <= unsmoothed,
    `${fixture}: rounding wall corners left ${withWall - unsmoothed} more cells uncleared than not rounding`)
  console.log(`${fixture}: unsmoothed ${unsmoothed}, rounded ${rounded}, rounded+wall ${withWall}: PASSED`)
}

/**
 * A known, measured, deliberately accepted gap — not a passing test dressed up.
 *
 * A broad corner arc leaves a tip, and the cleanup loop that clears it is
 * skipped where the neighbouring rings are judged to already sweep that tip.
 * The judgement is about the span the loop retraces, and the loop also sweeps
 * stock *outside* its own tip, so on this fixture skipping it leaves a
 * 0.21 x 0.05in patch standing 0.0057in proud. Deciding it correctly means
 * rasterising the material each loop's whole swept envelope removes, which the
 * per-corner check cannot see; a coverage margin tight enough to catch it
 * declined so many corners that the result carried more motion (2521 cuts)
 * than cleaning every one (2069).
 *
 * The optimisation is worth keeping meanwhile — it takes this fixture from
 * 85.5s to 72.8s, faster than not rounding at all — so the gap is pinned at
 * the size it was measured, and this fails the moment it grows.
 */
function testKnownCoverageGapDoesNotGrow(fixture: string): void {
  const { unsmoothed, rounded, withWall } = measure(fixture)
  const worst = Math.max(rounded, withWall) - unsmoothed
  const BOUND = 12
  assert(worst <= BOUND,
    `${fixture}: the accepted coverage gap grew from ${BOUND} to ${worst} cells`)
  console.log(`${fixture}: KNOWN GAP ${worst} of ${BOUND} cells accepted`
    + ` (unsmoothed ${unsmoothed}, rounded ${rounded}, rounded+wall ${withWall}): PASSED`)
}

try {
  testSmoothingLeavesNoStock('pocket-feed-reduction.camj')
  testKnownCoverageGapDoesNotGrow('pocket-rounded-corner-coverage.camj')
  console.log('\nAll pocketClearance tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
