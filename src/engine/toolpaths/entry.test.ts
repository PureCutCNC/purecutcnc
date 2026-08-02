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

import {
  findLargestClearanceCircle,
  helixAngularDirection,
  pitchFromRampAngle,
  plungeLimitedFeedScale,
  synthesizeEntry,
  type EntryClearanceRegion,
  type EntryPolicy,
} from './entry'
import type { ToolpathMove, ToolpathPoint } from './types'

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(left: number, right: number, epsilon = 1e-6): boolean {
  return Math.abs(left - right) <= epsilon
}

function rectangle(width: number, height: number): EntryClearanceRegion {
  return {
    outer: [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: height },
      { x: 0, y: height },
    ],
    islands: [],
  }
}

function policy(
  region: EntryClearanceRegion,
  overrides: Partial<EntryPolicy> = {},
): EntryPolicy {
  return {
    strategy: 'helix',
    rampAngle: 5,
    helixDiameterPercent: 80,
    toolDiameter: 4,
    cutFeed: 800,
    plungeFeed: 200,
    cutDirection: 'conventional',
    cutSide: 'internal',
    clearanceRegions: [region],
    ...overrides,
  }
}

function entryTarget(x: number, y: number, z = 0): ToolpathPoint {
  return { x, y, z }
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
    console.error(`   ✗ ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

test('derives helix pitch from path diameter and ramp angle', () => {
  const expected = Math.PI * 3.2 * Math.tan(5 * Math.PI / 180)
  assert(approx(pitchFromRampAngle(3.2, 5), expected), 'pitch should follow π × diameter × tan(angle)')
})

test('finds the largest clearance circle inside a region with an island', () => {
  const region: EntryClearanceRegion = {
    ...rectangle(10, 10),
    islands: [[
      { x: 4, y: 4 },
      { x: 6, y: 4 },
      { x: 6, y: 6 },
      { x: 4, y: 6 },
    ]],
  }
  const circle = findLargestClearanceCircle([region], 0.005)
  assert(circle !== null, 'clearance circle should be found')
  assert(circle.radius > 2, `clearance radius should use the open corners, got ${circle.radius}`)
  assert(!(circle.center.x > 4 && circle.center.x < 6 && circle.center.y > 4 && circle.center.y < 6), 'center must avoid island')
})

test('clamps requested helix diameter to the no-core limit', () => {
  const moves: ToolpathMove[] = []
  const result = synthesizeEntry(
    moves,
    null,
    entryTarget(10, 10),
    6,
    policy(rectangle(20, 20), { helixDiameterPercent: 150 }),
  )
  assert(result.usedStrategy === 'helix', 'large open region should retain helix strategy')
  const clampWarning = result.warnings.find((warning) => warning.code === 'entryHelixDiameterClamped')
  assert(clampWarning !== undefined, 'no-core clamp should warn')
  assert(
    Number(clampWarning.params?.actualDiameter) <= 4,
    `path diameter must not exceed tool diameter, got ${clampWarning.params?.actualDiameter}`,
  )
})

test('bounds helix radius by available clearance and warns', () => {
  const moves: ToolpathMove[] = []
  const result = synthesizeEntry(moves, null, entryTarget(1.5, 1.5), 4, policy(rectangle(3, 3)))
  assert(result.usedStrategy === 'helix', 'clearance-limited region should still allow a smaller helix')
  assert(result.warnings.some((warning) => warning.code === 'entryHelixDiameterClamped'), 'clearance clamp should warn')
  const points = moves.filter((move) => move.kind === 'lead_in').flatMap((move) => [move.from, move.to])
  assert(points.every((point) => point.x >= -1e-6 && point.x <= 3 + 1e-6), 'helix must stay within X clearance')
  assert(points.every((point) => point.y >= -1e-6 && point.y <= 3 + 1e-6), 'helix must stay within Y clearance')
})

test('keeps every helix move outside protected islands', () => {
  const region: EntryClearanceRegion = {
    ...rectangle(10, 10),
    islands: [[
      { x: 4, y: 4 },
      { x: 6, y: 4 },
      { x: 6, y: 6 },
      { x: 4, y: 6 },
    ]],
  }
  const moves: ToolpathMove[] = []
  const result = synthesizeEntry(moves, null, entryTarget(2, 5), 4, policy(region))
  assert(result.usedStrategy === 'helix', 'open side of island should fit a helix')

  const leadInPoints = moves
    .filter((move) => move.kind === 'lead_in')
    .flatMap((move) => [move.from, move.to])
  assert(
    leadInPoints.every((point) => !(point.x > 4 && point.x < 6 && point.y > 4 && point.y < 6)),
    'helix and bottom link must avoid the island interior',
  )
})

test('emits the calculated descent revolutions plus a flat bottom revolution', () => {
  const moves: ToolpathMove[] = []
  const safeZ = 5
  const target = entryTarget(10, 10)
  const result = synthesizeEntry(moves, null, target, safeZ, policy(rectangle(20, 20)))
  assert(result.usedStrategy === 'helix', 'entry should use helix')

  const expectedRevolutions = (safeZ - target.z) / pitchFromRampAngle(3.2, 5)
  const descending = moves.filter((move) => move.kind === 'lead_in' && move.to.z < move.from.z - 1e-9)
  assert(
    descending.length === Math.ceil(expectedRevolutions * 48),
    `expected ${Math.ceil(expectedRevolutions * 48)} descent segments, got ${descending.length}`,
  )
  const flatAtBottom = moves.filter((move) =>
    move.kind === 'lead_in' && approx(move.from.z, target.z) && approx(move.to.z, target.z))
  assert(flatAtBottom.length >= 48, `expected a full flat revolution, got ${flatAtBottom.length} flat moves`)
})

test('maps climb/conventional direction for internal and external cuts', () => {
  assert(helixAngularDirection('climb', 'internal') === -1, 'internal climb should be machine-space CCW')
  assert(helixAngularDirection('conventional', 'internal') === 1, 'internal conventional should be machine-space CW')
  assert(helixAngularDirection('climb', 'external') === 1, 'external climb should be machine-space CW')
  assert(helixAngularDirection('conventional', 'external') === -1, 'external conventional should be machine-space CCW')
})

test('limits the entry feed so its vertical component does not exceed plunge feed', () => {
  const scale = plungeLimitedFeedScale(1000, 80, 15)
  const verticalFeed = 1000 * scale * Math.sin(15 * Math.PI / 180)
  assert(verticalFeed <= 80 + 1e-9, `vertical feed ${verticalFeed} must stay at or below plunge feed`)

  const moves: ToolpathMove[] = []
  synthesizeEntry(moves, null, entryTarget(10, 10), 5, policy(rectangle(20, 20), {
    rampAngle: 15,
    cutFeed: 1000,
    plungeFeed: 80,
  }))
  const descending = moves.find((move) => move.kind === 'lead_in' && move.to.z < move.from.z)
  assert(descending !== undefined, 'helix should contain a descending move')
  const dx = descending.to.x - descending.from.x
  const dy = descending.to.y - descending.from.y
  const dz = descending.to.z - descending.from.z
  const moveDistance = Math.hypot(dx, dy, dz)
  const commandedVerticalFeed = 1000 * (descending.feedScale ?? 1) * Math.abs(dz) / moveDistance
  assert(
    commandedVerticalFeed <= 80 + 1e-9,
    `segmented helix vertical feed ${commandedVerticalFeed} must stay at or below plunge feed`,
  )
})

test('falls back from helix to zig-zag ramp in a narrow slot', () => {
  const moves: ToolpathMove[] = []
  const result = synthesizeEntry(
    moves,
    null,
    entryTarget(0, 0.05),
    3,
    policy(rectangle(20, 0.1)),
  )
  assert(result.usedStrategy === 'ramp', `expected ramp fallback, got ${result.usedStrategy}`)
  assert(result.warnings.some((warning) => warning.code === 'entryStrategyFallback'), 'fallback should warn')
  assert(moves.some((move) => move.kind === 'lead_in'), 'ramp fallback should emit lead-in moves')
  assert(!moves.some((move) => move.kind === 'plunge'), 'usable slot should not fall through to plunge')
  assert(
    moves.filter((move) => move.kind === 'lead_in').every((move) => move.to.z <= move.from.z + 1e-9),
    'ramp Z should descend monotonically',
  )
})

test('falls back to plunge when neither a helix nor ramp has room', () => {
  const moves: ToolpathMove[] = []
  const result = synthesizeEntry(
    moves,
    null,
    entryTarget(0.005, 0.005),
    2,
    policy(rectangle(0.01, 0.01)),
  )
  assert(result.usedStrategy === 'plunge', `expected plunge fallback, got ${result.usedStrategy}`)
  assert(result.warnings.some((warning) => warning.code === 'entryStrategyFallback'), 'plunge fallback should warn')
  assert(moves.some((move) => move.kind === 'plunge'), 'plunge fallback should emit a plunge')
})

test('bounds pathological shallow-angle entry move counts with a deterministic fallback', () => {
  const moves: ToolpathMove[] = []
  const result = synthesizeEntry(
    moves,
    null,
    entryTarget(10, 10, -100),
    0,
    policy(rectangle(20, 20), {
      rampAngle: 0.1,
      helixDiameterPercent: 1,
    }),
  )
  assert(result.usedStrategy === 'ramp', `expected bounded ramp fallback, got ${result.usedStrategy}`)
  assert(result.warnings.some((warning) => warning.code === 'entryStrategyFallback'), 'budget fallback should warn')
  assert(moves.length < 20_010, `entry move count should stay bounded, got ${moves.length}`)
})

test('caps ramp run length instead of traversing the whole region', () => {
  const moves: ToolpathMove[] = []
  const region = rectangle(200, 200)
  const result = synthesizeEntry(
    moves,
    null,
    entryTarget(100, 100, -2),
    2,
    policy(region, { strategy: 'ramp', toolDiameter: 4 }),
  )
  assert(result.usedStrategy === 'ramp', `expected ramp, got ${result.usedStrategy}`)

  // 3 tool diameters of XY run, lengthened only by the ramp's own descent.
  const cap = 4 * 3 / Math.cos(5 * Math.PI / 180) + 1e-6
  const longest = Math.max(...moves
    .filter((move) => move.kind === 'lead_in')
    .map((move) => Math.hypot(
      move.to.x - move.from.x,
      move.to.y - move.from.y,
      move.to.z - move.from.z,
    )))
  assert(longest <= cap, `ramp move ${longest.toFixed(4)} should not exceed cap ${cap.toFixed(4)}`)
})

test('keeps ramp entry clear of the region boundary', () => {
  const moves: ToolpathMove[] = []
  const width = 40
  const height = 40
  const toolDiameter = 4
  const result = synthesizeEntry(
    moves,
    null,
    entryTarget(width / 2, height / 2, -2),
    2,
    policy(rectangle(width, height), { strategy: 'ramp', toolDiameter }),
  )
  assert(result.usedStrategy === 'ramp', `expected ramp, got ${result.usedStrategy}`)

  // Entry must not score the wall the finish pass will leave as the final
  // surface, so every ramp point stays a real standoff inside the boundary.
  const standoff = toolDiameter * 0.1
  for (const move of moves.filter((move) => move.kind === 'lead_in')) {
    for (const point of [move.from, move.to]) {
      const toEdge = Math.min(point.x, width - point.x, point.y, height - point.y)
      assert(
        toEdge >= standoff - 1e-6,
        `ramp point ${toEdge.toFixed(4)} from wall is inside the ${standoff} standoff`,
      )
    }
  }
})

test('still places a helix when the cut start sits on the region boundary', () => {
  // Wall-finish contours are the region boundary, so the cheap tangent
  // placement can never succeed there and every entry falls through to the
  // global search. That path is bounded (see MAX_HELIX_ENDPOINT_CANDIDATES);
  // this guards that bounding it did not stop it finding a placement.
  const moves: ToolpathMove[] = []
  const result = synthesizeEntry(moves, null, entryTarget(0, 20, -2), 2, policy(rectangle(40, 40)))
  assert(result.usedStrategy === 'helix', `expected helix, got ${result.usedStrategy}`)
  const descending = moves.filter((move) => move.kind === 'lead_in' && move.to.z < move.from.z - 1e-9)
  assert(descending.length > 0, 'boundary-start helix should still descend')
})

console.log(`\nentry.ts tests: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
