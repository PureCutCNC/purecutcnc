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
 * The constant-scallop finish strategy through `generateFinishSurfaceToolpath`
 * (issue #705, phase 2 of #697).
 *
 * The claim the strategy exists to make is **geometric and not a move count**:
 * passes are level sets of a geodesic distance field measured on the
 * cutter-location surface, so their separation stays at the requested spacing
 * *along the surface* however the surface tilts. Parallel finishing spaces its
 * passes in XY, so on a plane at slope theta its 3D separation is
 * `spacing / cos(theta)` — 1.41x at 45 degrees — and the scallop between passes
 * grows with the square of that. The inclined-plane test below measures exactly
 * those two numbers on the emitted stream and requires the second one, which is
 * what keeps the comparison from going vacuous if the fixture ever flattens.
 *
 * Every assertion here was mutation-verified, and each mutation failed exactly
 * the one test it should:
 *   - `relaxFrom`'s true 3D edge weight reduced to the XY step: 30-degree
 *     separation becomes 1.1547 — the strategy degenerates into parallel's
 *     `spacing / cos(theta)` exactly, which is the whole defect it exists to
 *     avoid, and the separation test fails.
 *   - the level-0 domain boundary pass dropped from `planContours`: the
 *     silhouette-seed test fails and interior separation is unchanged, which is
 *     why the two are separate claims.
 *   - `applyDirection` made to ignore `cutDirection`: the winding test fails.
 *   - the resolution guard relaxed to `cellSize > spacing * 1000`: the refused
 *     case does not emit coarse passes, it **runs the node heap out of memory**
 *     at 4 GB after 62 s. The guard is what keeps a 0.0008 mm spacing over a
 *     0.038 mm grid from being attempted at all.
 *   - `Math.max(surfaceZ + axialLeave, floor)` reduced to `Math.max(surfaceZ,
 *     floor)`: the stock-to-leave test fails.
 *
 * Run with: npx tsx src/engine/toolpaths/finishSurfaceConstantScallop.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateFinishSurfaceToolpath } from './finishSurface'
import { slopeTestMesh, surfaceTestProject } from '../../test/surfaceSlopeFixtures'
import type { Operation, Project } from '../../types/project'
import type { ToolpathMove } from './types'

const DEG = Math.PI / 180
const TOOL_DIAMETER = 4
const TOOL_RADIUS = TOOL_DIAMETER / 2
const STEPOVER = 0.25
const SPACING = STEPOVER * TOOL_DIAMETER

/** A plane rising in +Y at a fixed slope, so pass separation has a closed form. */
const ramp = (degrees: number) => (_x: number, y: number): number => 2 + y * Math.tan(degrees * DEG)
const dome = (x: number, y: number): number => {
  const dx = (x - 30) / 30, dy = (y - 12) / 12
  return 2 + 8 * Math.max(0, 1 - dx * dx - dy * dy)
}

function fixture(surface: (x: number, y: number) => number, width = 60, height = 40) {
  return surfaceTestProject(slopeTestMesh(surface, width, height, 1), TOOL_DIAMETER)
}

function generate(project: Project, operation: Operation, patch: Partial<Operation> = {}) {
  const op: Operation = { ...operation, pocketPattern: 'constant_scallop', stepover: STEPOVER, ...patch }
  return generateFinishSurfaceToolpath({ ...project, operations: [op] }, op)
}

const cutMoves = (moves: ToolpathMove[]): ToolpathMove[] => moves.filter((move) => move.kind === 'cut')
const cutPoints = (moves: ToolpathMove[]) => cutMoves(moves).flatMap((move) => [move.from, move.to])

/**
 * Median 3D separation between adjacent passes in a strip away from the ends.
 * On a plane rising in Y every pass runs at constant Y, so the gap between
 * consecutive distinct Y values, taken through the slope, is the separation the
 * cutter actually leaves between passes.
 */
function passSeparation3D(moves: ToolpathMove[], degrees: number, xLow: number, xHigh: number): number {
  const rows = new Set<number>()
  for (const point of cutPoints(moves)) {
    if (point.x >= xLow && point.x <= xHigh) rows.add(Math.round(point.y * 1e6) / 1e6)
  }
  const sorted = [...rows].sort((left, right) => left - right)
  const gaps: number[] = []
  for (let index = 1; index < sorted.length; index += 1) {
    const gap = sorted[index] - sorted[index - 1]
    if (gap > 1e-6) gaps.push(gap)
  }
  assert(gaps.length > 4, 'the strip must contain several passes for a median to mean anything')
  gaps.sort((left, right) => left - right)
  return gaps[Math.floor(gaps.length / 2)] * Math.hypot(1, Math.tan(degrees * DEG))
}

test('pass separation follows the surface, where parallel spacing stretches with slope', () => {
  for (const degrees of [0, 30, 45]) {
    const surface = ramp(degrees)
    const { project, operation } = fixture(surface)
    const scallop = passSeparation3D(generate(project, operation).moves, degrees, 25, 35)
    assert(
      Math.abs(scallop - SPACING) <= SPACING * 0.05,
      `constant scallop at ${degrees} degrees separated passes by ${scallop.toFixed(4)}, not ${SPACING}`,
    )
    const parallel = passSeparation3D(
      generate(project, operation, { pocketPattern: 'parallel', pocketAngle: 0 }).moves,
      degrees,
      25,
      35,
    )
    const stretch = 1 / Math.cos(degrees * DEG)
    assert(
      Math.abs(parallel - SPACING * stretch) <= SPACING * 0.05,
      `parallel at ${degrees} degrees separated passes by ${parallel.toFixed(4)}, not ${(SPACING * stretch).toFixed(4)}`,
    )
    // Anti-vacuity: at 45 degrees the two strategies must actually differ, or
    // the first assertion above proves nothing about the fixture.
    if (degrees === 45) assert(parallel >= SPACING * 1.3, 'the 45-degree fixture no longer discriminates')
  }
})

test('the cutter stays on the cutter-location surface it is lifted onto', () => {
  // A ball of radius r tangent to a plane at slope theta sits with its tip
  // `r * (sec(theta) - 1)` above the plane; anything below that is a gouge.
  // Measured in the interior, because at the model rim the plane simply ends
  // and the extrapolated ideal no longer describes the mesh.
  const degrees = 45
  const surface = ramp(degrees)
  const idealTip = (x: number, y: number): number =>
    surface(x, y) + TOOL_RADIUS * (Math.hypot(1, Math.tan(degrees * DEG)) - 1)
  const { project, operation } = fixture(surface)
  let worst = 0
  let interior = 0
  for (const point of cutPoints(generate(project, operation).moves)) {
    if (point.x <= 6 || point.x >= 54 || point.y <= 6 || point.y >= 34) continue
    interior += 1
    worst = Math.max(worst, idealTip(point.x, point.y) - point.z)
  }
  assert(interior > 1000, 'the interior sample is too small to mean anything')
  // A tenth of the pass spacing: the surface error has to stay small against
  // the scallop the pass is designed to leave. Measured 0.041 mm here, against
  // 0.037 mm for parallel on the same plane and the same tool.
  assert(worst <= SPACING * 0.1, `cut points sit ${worst.toFixed(4)} below the ball-tangent surface`)
})

test('the silhouette itself is machined as the seed pass', () => {
  const { project, operation } = fixture(ramp(30))
  const points = cutPoints(generate(project, operation).moves)
  for (const [label, hit] of [
    ['x=0 edge', points.some((point) => point.x <= 0.01)],
    ['x=60 edge', points.some((point) => point.x >= 59.99)],
    ['y=0 edge', points.some((point) => point.y <= 0.01)],
    ['y=40 edge', points.some((point) => point.y >= 39.99)],
  ] as const) {
    assert(hit, `the level-0 boundary pass never reached the ${label}`)
  }
})

test('flat, domed and mixed-slope surfaces all generate, and repeat exactly', () => {
  for (const [label, surface] of [
    ['flat', () => 5],
    ['dome', dome],
    ['ramp', ramp(30)],
  ] as const) {
    const { project, operation } = fixture(surface as (x: number, y: number) => number)
    const first = generate(project, operation)
    assert(cutMoves(first.moves).length > 100, `${label} produced no meaningful cutting motion`)
    assert.deepEqual(first.warnings, [], `${label} warned unexpectedly`)
    const second = generate(project, operation)
    assert.deepEqual(second.moves, first.moves, `${label} is not deterministic`)
  }
})

test('climb and conventional wind the same contours in opposite directions', () => {
  const { project, operation } = fixture(dome)
  const signedArea = (moves: ToolpathMove[]): number => cutMoves(moves)
    .reduce((total, move) => total + (move.from.x * move.to.y - move.to.x * move.from.y) / 2, 0)
  const conventional = signedArea(generate(project, operation, { cutDirection: 'conventional' }).moves)
  const climb = signedArea(generate(project, operation, { cutDirection: 'climb' }).moves)
  assert(Math.abs(conventional) > 1, 'the fixture emits no enclosed contours to wind')
  assert(
    Math.abs(conventional + climb) <= Math.abs(conventional) * 1e-6,
    `winding did not reverse: ${conventional.toFixed(3)} against ${climb.toFixed(3)}`,
  )
})

test('axial stock to leave raises every cut by exactly what was asked for', () => {
  const { project, operation } = fixture(dome)
  const leave = 0.5
  const base = cutPoints(generate(project, operation, { stockToLeaveAxial: 0 }).moves)
  const raised = cutPoints(generate(project, operation, { stockToLeaveAxial: leave }).moves)
  assert.equal(raised.length, base.length, 'leaving stock changed which passes are emitted')
  for (let index = 0; index < base.length; index += 1) {
    // The leave is folded into the cutter-location surface before the distance
    // field runs, so it cancels out of every edge weight to within a couple of
    // ulps rather than exactly; the passes are the same passes, one leave up.
    assert(Math.abs(raised[index].x - base[index].x) <= 1e-9, `cut ${index} moved in X`)
    assert(Math.abs(raised[index].y - base[index].y) <= 1e-9, `cut ${index} moved in Y`)
    assert(
      Math.abs(raised[index].z - base[index].z - leave) <= 1e-9,
      `cut ${index} rose by ${(raised[index].z - base[index].z).toFixed(6)}, not ${leave}`,
    )
  }
})

test('a spacing the bounded grid cannot represent refuses instead of cutting coarsely', () => {
  const { project, operation } = fixture(dome)
  const ordinary = generate(project, operation)
  assert(cutMoves(ordinary.moves).length > 100, 'the accepted case must still generate')
  assert(
    !ordinary.warnings.some((warning) => warning.code === 'constantScallopResolutionTooCoarse'),
    'an ordinary mesh must fit inside the cell ceiling',
  )
  // 0.0008 mm of spacing over a 60 x 40 mm model needs 2.25e9 cells; the height
  // map caps at 1e6, which lands on a 0.038 mm grid it cannot represent.
  const refused = generate(project, operation, { stepover: 0.0002 })
  assert.equal(cutMoves(refused.moves).length, 0, 'a refused operation must emit no partial cutting')
  assert(
    refused.warnings.some((warning) => warning.code === 'constantScallopResolutionTooCoarse'),
    'the refusal must be visible without Debug toolpath',
  )
})

test('an unusable stepover is rejected the way the other 3D strategies reject one', () => {
  const { project, operation } = fixture(dome)
  for (const stepover of [0, -0.25, Number.NaN]) {
    const result = generate(project, operation, { stepover })
    assert.equal(result.moves.length, 0, `stepover ${stepover} generated motion`)
    assert(
      result.warnings.some((warning) => warning.code === 'stepoverRatioRange'),
      `stepover ${stepover} was not explained`,
    )
  }
})
