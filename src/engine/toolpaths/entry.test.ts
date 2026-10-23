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
  emitCenterLockedCircularBore,
  entryBoundarySafety,
  findLargestClearanceCircle,
  helixAngularDirection,
  isEntryHandoffMove,
  pitchFromRampAngle,
  plungeLimitedFeedScale,
  synthesizeEntry,
  type EntryClearanceRegion,
  type EntryPolicy,
  type EntryRampPath,
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

/** Distance from `point` to the segment `a`-`b`, for on-cut-path assertions. */
function distanceToSegment(
  point: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return Math.hypot(point.x - a.x, point.y - a.y)
  const ratio = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared))
  return Math.hypot(point.x - (a.x + dx * ratio), point.y - (a.y + dy * ratio))
}

function onSegment(
  point: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
  epsilon = 1e-9,
): boolean {
  return distanceToSegment(point, a, b) <= epsilon
}

function rampPath(points: { x: number; y: number }[], closed: boolean): EntryRampPath {
  return { points, closed }
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

test('ramp follows the actual forward cut segment, capped, with an on-path handoff', () => {
  const moves: ToolpathMove[] = []
  const target = entryTarget(5, 5, 0)
  // The path turns a corner after 20 mm. The cap must end the run on the FIRST
  // segment, never bridge the corner or reach into the second one.
  const path = rampPath([{ x: 5, y: 5 }, { x: 25, y: 5 }, { x: 25, y: 25 }], false)
  const toolDiameter = 4
  const result = synthesizeEntry(
    moves,
    null,
    target,
    0.5,
    policy(rectangle(200, 40), { strategy: 'ramp', toolDiameter, rampPath: path }),
  )
  assert(result.usedStrategy === 'ramp', `expected ramp, got ${result.usedStrategy}`)
  assert(!result.warnings.some((warning) => warning.code === 'entryStrategyFallback'),
    'a real adjacent cut segment is a valid ramp, not a fallback')

  const segmentStart = { x: 5, y: 5 }
  const segmentEnd = { x: 25, y: 5 }
  const maxRun = toolDiameter * 3
  const leadIns = moves.filter((move) => move.kind === 'lead_in')
  assert(leadIns.length > 0, 'the constrained ramp emits lead-in moves')
  for (const move of leadIns) {
    assert(onSegment(move.from, segmentStart, segmentEnd),
      `ramp start ${move.from.x},${move.from.y} must lie on the cut segment`)
    assert(onSegment(move.to, segmentStart, segmentEnd),
      `ramp end ${move.to.x},${move.to.y} must lie on the cut segment`)
    assert(Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y) <= maxRun + 1e-9,
      'the run stays within the existing maximum ramp run')
    // 5 degrees x 800 ipm is an 8.7 ipm vertical component, below the 200 ipm
    // plunge limit, so the feed policy is unchanged and stays at cut feed.
    assert((move.feedScale ?? 1) === 1, 'the ramp preserves the existing feed policy')
  }

  const handoff = moves.find((move) => isEntryHandoffMove(move))
  assert(handoff !== undefined, 'the ramp hands off to the cut start')
  assert(onSegment(handoff.from, segmentStart, segmentEnd)
    && onSegment(handoff.to, segmentStart, segmentEnd),
  'the handoff stays on the cut polyline too')
  assert(approx(handoff.to.x, target.x) && approx(handoff.to.y, target.y),
    'the handoff ends at the actual entry vertex')
})

function onClosedPath(
  point: { x: number; y: number },
  points: Array<{ x: number; y: number }>,
  epsilon = 1e-9,
): boolean {
  for (let index = 0; index < points.length; index += 1) {
    if (onSegment(point, points[index], points[(index + 1) % points.length], epsilon)) return true
  }
  return false
}

test('a closed fragment crosses tessellation vertices in the chosen direction', () => {
  const corners = [
    { x: 5, y: 5 },
    { x: 9, y: 5 },
    { x: 9, y: 9 },
    { x: 5, y: 9 },
  ]
  const path = rampPath(corners, true)

  const forwardMoves: ToolpathMove[] = []
  const forward = synthesizeEntry(
    forwardMoves,
    null,
    entryTarget(5, 5, 0),
    0.5,
    policy(rectangle(30, 30), { strategy: 'ramp', toolDiameter: 4, rampPath: path }),
  )
  assert(forward.usedStrategy === 'ramp', 'a closed fragment offers a ramp')
  const forwardLeadIns = forwardMoves.filter((move) => move.kind === 'lead_in')
  assert(forwardLeadIns.length > 0, 'the closed ramp emits moves')
  // The run is capped at 3D = 12 mm, so it crosses the first corner and reaches
  // the real cut travel beyond it instead of reversing on the first 4 mm side.
  assert(forwardLeadIns.every((move) => onClosedPath(move.from, corners)
    && onClosedPath(move.to, corners)),
  'every closed-ramp move stays on the actual contour, tessellation vertices included')
  assert(forwardLeadIns.some((move) => move.to.y > 5 + 1e-6 || move.from.y > 5 + 1e-6),
    'the forward run crosses into the next real contour side')
  assert(forwardLeadIns.every((move) => Math.hypot(
    move.to.x - move.from.x, move.to.y - move.from.y,
  ) <= 12 + 1e-9), 'the run stays within the existing 3D cap')

  // A tab keep-out covering the forward side leaves the other actual
  // direction available, so the ramp must use it rather than fall back.
  const blocked: EntryClearanceRegion = {
    ...rectangle(30, 30),
    islands: [[
      { x: 6, y: 4.5 },
      { x: 9, y: 4.5 },
      { x: 9, y: 5.5 },
      { x: 6, y: 5.5 },
    ]],
  }
  const reverseMoves: ToolpathMove[] = []
  const reverse = synthesizeEntry(
    reverseMoves,
    null,
    entryTarget(5, 5, 0),
    0.5,
    policy(blocked, { strategy: 'ramp', toolDiameter: 4, rampPath: path }),
  )
  assert(reverse.usedStrategy === 'ramp', 'the other direction still allows a ramp')
  const reverseLeadIns = reverseMoves.filter((move) => move.kind === 'lead_in')
  assert(reverseLeadIns.length > 0, 'the reversed contour emits moves')
  assert(reverseLeadIns.every((move) => onClosedPath(move.from, corners)
    && onClosedPath(move.to, corners)),
  'the blocked forward side is never bridged off the contour')
  assert(reverseLeadIns.every((move) => !(Math.abs(move.from.y - 5) <= 1e-9 && move.from.x > 5 + 1e-9)
    && !(Math.abs(move.to.y - 5) <= 1e-9 && move.to.x > 5 + 1e-9)),
  'the blocked forward side is not entered; the ramp starts the other way')
})

test('an unavailable cut segment forces the warned plunge, never a broad-domain chord', () => {
  const moves: ToolpathMove[] = []
  const result = synthesizeEntry(
    moves,
    null,
    entryTarget(5, 5, 0),
    4,
    policy(rectangle(30, 30), { strategy: 'ramp', rampPath: null }),
  )
  assert(result.usedStrategy === 'plunge', `expected plunge, got ${result.usedStrategy}`)
  assert(result.warnings.some((warning) => warning.code === 'entryStrategyFallback'),
    'the fallback is explicit and warned')
  assert(!moves.some((move) => move.kind === 'lead_in'),
    'no broad-domain ramp is emitted when the cut segment is unavailable')
  const plunge = moves.find((move) => move.kind === 'plunge')
  assert(plunge !== undefined && approx(plunge.to.x, 5) && approx(plunge.to.y, 5),
    'the warned fallback descends at the actual entry vertex')

  // The same explicit result for a malformed/one-point fragment, so a caller
  // cannot accidentally turn "no segment" into the legacy domain search.
  const shortMoves: ToolpathMove[] = []
  const short = synthesizeEntry(
    shortMoves,
    null,
    entryTarget(5, 5, 0),
    4,
    policy(rectangle(30, 30), {
      strategy: 'ramp',
      rampPath: rampPath([{ x: 5, y: 5 }], false),
    }),
  )
  assert(short.usedStrategy === 'plunge', 'a fragment with no forward segment falls back')
})

test('a too-short cut segment falls back rather than ramping on the spot', () => {
  const moves: ToolpathMove[] = []
  const result = synthesizeEntry(
    moves,
    null,
    entryTarget(5, 5, 0),
    4,
    policy(rectangle(30, 30), {
      strategy: 'ramp',
      toolDiameter: 4,
      rampPath: rampPath([{ x: 5, y: 5 }, { x: 5.05, y: 5 }], false),
    }),
  )
  assert(result.usedStrategy === 'plunge', `expected plunge, got ${result.usedStrategy}`)
  assert(result.warnings.some((warning) => warning.code === 'entryStrategyFallback'),
    'the too-short segment is reported')
  assert(moves.some((move) => move.kind === 'plunge'), 'and descends as a plunge')
})

test('a meaningful stroke floor rejects a short contour instead of microscopic strokes', () => {
  // 2 mm of connected cut travel with a 4 mm cutter is below the documented
  // one-diameter useful-run floor. At 5 degrees it would reverse every few
  // micrometres of descent, which is the defect this correction removes.
  const moves: ToolpathMove[] = []
  const result = synthesizeEntry(
    moves,
    null,
    entryTarget(5, 5, 0),
    4,
    policy(rectangle(30, 30), {
      strategy: 'ramp',
      toolDiameter: 4,
      rampPath: rampPath([{ x: 5, y: 5 }, { x: 7, y: 5 }], false),
    }),
  )
  assert(result.usedStrategy === 'plunge', 'a sub-diameter contour falls back with a warning')
  assert(result.warnings.some((warning) => warning.code === 'entryStrategyFallback'),
    'the fallback is reported')
})

test('one tiny chord followed by long connected travel still supplies a useful stroke', () => {
  // The saved fixture's rounded-corner tessellation starts with a 0.03 in
  // chord; the useful run is the straight cut immediately after it. Reversing
  // on the chord alone is the 106/308-stroke defect.
  const moves: ToolpathMove[] = []
  const result = synthesizeEntry(
    moves,
    null,
    entryTarget(5, 5, 0),
    10,
    policy(rectangle(200, 40), {
      strategy: 'ramp',
      toolDiameter: 4,
      rampPath: rampPath([{ x: 5, y: 5 }, { x: 5.05, y: 5 }, { x: 25, y: 5 }], false),
    }),
  )
  assert(result.usedStrategy === 'ramp', `expected ramp, got ${result.usedStrategy}`)
  const descending = moves.filter((move) => move.kind === 'lead_in' && move.from.z > move.to.z + 1e-9)
  assert(descending.length > 0, 'the ramp descends')
  assert(descending.some((move) => Math.abs(move.to.x - 5.05) <= 1e-9 || move.to.x > 5.05 + 1e-6),
    'the stroke crosses the tiny chord onto the long connected run')
  const maxRun = 4 * 3
  for (const move of descending) {
    assert(Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y) <= maxRun + 1e-9,
      'the stroke is capped at the existing 3D maximum')
  }
})

test('an over-budget constrained ramp falls back instead of emitting a huge program', () => {
  const moves: ToolpathMove[] = []
  const result = synthesizeEntry(
    moves,
    null,
    entryTarget(5, 5, -200),
    200,
    policy(rectangle(200, 200), {
      strategy: 'ramp',
      toolDiameter: 4,
      rampAngle: 0.1,
      // A real, useful 4 mm stroke: the refusal has to come from the move
      // budget, not from the meaningful-run floor.
      rampPath: rampPath([{ x: 5, y: 5 }, { x: 9, y: 5 }], false),
    }),
  )
  assert(result.usedStrategy === 'plunge', `expected plunge, got ${result.usedStrategy}`)
  assert(result.warnings.some((warning) => warning.code === 'entryStrategyFallback'),
    'the move-budget fallback is reported')
  assert(moves.length < 20_010, `entry move count stays bounded, got ${moves.length}`)
})

test('a useful closed full loop ramps on arclength and does not retrace itself', () => {
  const corners = [
    { x: 5, y: 5 },
    { x: 5.5, y: 5 },
    { x: 5.5, y: 5.5 },
    { x: 5, y: 5.5 },
  ]
  const toolDiameter = 1
  const perimeter = 2
  const rampAngle = 5
  const rise = Math.tan(rampAngle * Math.PI / 180)
  // Exactly one loop of descent: the run reaches the entry vertex exactly at
  // target Z. The old count measured the zero chord between those endpoints and
  // returned Infinity, so a useful 2D loop fell back to a warned plunge.
  const depth = perimeter * rise
  const moves: ToolpathMove[] = []
  const result = synthesizeEntry(
    moves,
    null,
    entryTarget(5, 5, 0),
    depth,
    policy(rectangle(10, 10), {
      strategy: 'ramp',
      toolDiameter,
      rampAngle,
      rampPath: rampPath(corners, true),
      startZ: depth,
    }),
  )
  assert(result.usedStrategy === 'ramp',
    `a 2D closed loop is useful travel, not a zero-chord plunge (got ${result.usedStrategy})`)
  assert(!result.warnings.some((warning) => warning.code === 'entryStrategyFallback'),
    'the full loop is not rejected by its zero endpoint distance')

  const leadIns = moves.filter((move) => move.kind === 'lead_in')
  assert(leadIns.length === 4,
    `one move per side and no final-depth retrace (got ${leadIns.length})`)
  assert(leadIns.every((move) => onClosedPath(move.from, corners)
    && onClosedPath(move.to, corners)),
  'every move stays on the actual contour, with no off-path handoff')
  let planar = 0
  for (let index = 0; index < leadIns.length; index += 1) {
    const move = leadIns[index]
    const travel = Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y)
    planar += travel
    assert(approx(travel, perimeter / 4, 1e-9), 'the loop is cut side by side, without a gap')
    if (index > 0) {
      const previous = leadIns[index - 1]
      assert(approx(move.from.x, previous.to.x, 1e-12)
        && approx(move.from.y, previous.to.y, 1e-12)
        && approx(move.from.z, previous.to.z, 1e-12),
      'the descent is continuous, with no gap or jump')
    }
    if (move.from.z > move.to.z + 1e-9) {
      assert(approx((move.from.z - move.to.z) / travel, rise, 1e-9),
        'the descent follows the requested ramp angle')
    }
  }
  assert(approx(planar, perimeter, 1e-9),
    `one loop of travel, not a second retrace (got ${planar.toFixed(9)})`)
  const last = leadIns[leadIns.length - 1]
  assert(approx(last.to.x, 5, 1e-9) && approx(last.to.y, 5, 1e-9)
    && approx(last.to.z, 0, 1e-9),
  'the full loop finishes at the entry vertex at final depth')
})

test('a dense tessellation is costed before emission and falls back over budget', () => {
  // 6,001 vertices spanning the 3D cap: at 5 degrees a 1D descent needs four
  // strokes, which is 22,861 descending segment moves plus the final-depth
  // handoff, a 24,002-move stream. The pre-budget version emitted it without a
  // warning. Tessellation density must not hide behind a stroke count.
  const points = Array.from({ length: 6001 }, (_, index) => ({ x: 3 * index / 6000, y: 5 }))
  const moves: ToolpathMove[] = []
  const result = synthesizeEntry(
    moves,
    null,
    entryTarget(0, 5, 0),
    1,
    policy(rectangle(10, 10), {
      strategy: 'ramp',
      toolDiameter: 1,
      rampAngle: 5,
      rampPath: rampPath(points, false),
    }),
  )
  assert(result.usedStrategy === 'plunge',
    `a dense run over the move ceiling must fall back (got ${result.usedStrategy})`)
  assert(result.warnings.some((warning) => warning.code === 'entryStrategyFallback'),
    'the budget fallback is reported')
  assert(moves.length < 10,
    `the dense run is refused before its moves are emitted (got ${moves.length})`)
})

test('the move budget includes the final-depth contour handoff', () => {
  // 6,001 vertices, 3.1 strokes deep at 5 degrees: 18,600 descending moves fit
  // the ceiling, but the final-depth handoff retraces 5,400 vertices, taking
  // the program to 24,000. Counting only the descent would emit it.
  const points = Array.from({ length: 6001 }, (_, index) => ({ x: 3 * index / 6000, y: 5 }))
  const dropPerRun = 3 * Math.tan(5 * Math.PI / 180)
  const depth = 3.1 * dropPerRun
  const moves: ToolpathMove[] = []
  const result = synthesizeEntry(
    moves,
    null,
    entryTarget(0, 5, 0),
    depth,
    policy(rectangle(10, 10), {
      strategy: 'ramp',
      toolDiameter: 1,
      rampAngle: 5,
      rampPath: rampPath(points, false),
      startZ: depth,
    }),
  )
  assert(result.usedStrategy === 'plunge',
    `the handoff cost must count against the ceiling (got ${result.usedStrategy})`)
  assert(result.warnings.some((warning) => warning.code === 'entryStrategyFallback'),
    'the handoff-driven fallback is reported')
  assert(moves.length < 10,
    `the over-budget program is never emitted (got ${moves.length})`)
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

test('places the reachable helix next to the cut start, not in the roomiest spot', () => {
  // Regression for #581: roomiest-first exploration placed the fallback
  // helix at the region's largest-clearance spot (mid-pocket) and linked to
  // a boundary cut start at full depth, several diameters away.
  const moves: ToolpathMove[] = []
  const toolDiameter = 4
  const target = entryTarget(0, 100, -2)
  const result = synthesizeEntry(
    moves,
    null,
    target,
    2,
    policy(rectangle(200, 200), { toolDiameter }),
  )
  assert(result.usedStrategy === 'helix', `expected helix, got ${result.usedStrategy}`)

  const leadIns = moves.filter((move) => move.kind === 'lead_in')
  const maxDistance = Math.max(...leadIns.flatMap((move) => [
    Math.hypot(move.from.x - target.x, move.from.y - target.y),
    Math.hypot(move.to.x - target.x, move.to.y - target.y),
  ]))
  // A tangent placement caps this at one helix radius; the reachable
  // fallback must stay within a couple of tool diameters of the cut start.
  assert(
    maxDistance <= toolDiameter * 2 + 1e-6,
    'helix strayed ' + maxDistance.toFixed(3) + ' from the cut start; expected <= ' + toolDiameter * 2,
  )
})

// ── Center-locked circular bore (emitCenterLockedCircularBore) ──────────

test('center-locked bore: swept-envelope inequality at every emitted point', () => {
  const moves: ToolpathMove[] = []
  const center = { x: 20, y: 20 }
  const toolDiameter = 4
  const holeRadius = 10
  const requestedRadius = toolDiameter * 0.8 / 2  // 1.6
  const safety = entryBoundarySafety(toolDiameter) // 0.4
  const result = emitCenterLockedCircularBore(
    moves, null, center, requestedRadius, holeRadius, toolDiameter,
    -6, 10, 0, 5, 'conventional', 600, 180,
  )
  // Result position should be at safeZ
  assert(approx(result.position.z, 10), 'final retract should be at safeZ')
  assert(result.warnings.length === 0, 'clean bore should have no warnings')

  // Every lead-in point must satisfy: distanceFromCenter + toolRadius + safety <= holeRadius
  const toolRadius = toolDiameter / 2
  const maxAllowed = holeRadius - toolRadius - safety
  for (const move of moves) {
    for (const point of [move.from, move.to]) {
      const dist = Math.hypot(point.x - center.x, point.y - center.y)
      // Rapids to centre (0,0 offset) are fine — they're the travel moves
      if (move.kind === 'rapid' && dist < 1e-9) continue
      assert(
        dist <= maxAllowed + 1e-9,
        `point at dist ${dist.toFixed(6)} from centre exceeds max safe path radius ${maxAllowed.toFixed(6)}`,
      )
    }
  }

  // Verify the path radius is clamped correctly
  const leadInPoints = moves
    .filter((m) => m.kind === 'lead_in')
    .flatMap((m) => [m.from, m.to])
  const maxDist = Math.max(...leadInPoints.map((p) => Math.hypot(p.x - center.x, p.y - center.y)))
  assert(maxDist <= requestedRadius + 1e-9, `actual path radius ${maxDist.toFixed(6)} should not exceed requested ${requestedRadius}`)
})

test('center-locked bore: no-core cap limits path radius to tool radius', () => {
  const moves: ToolpathMove[] = []
  const toolDiameter = 4
  const result = emitCenterLockedCircularBore(
    moves, null, { x: 0, y: 0 },
    10,  // requested radius much larger than tool radius
    20,  // spacious hole
    toolDiameter,
    -5, 10, 0, 5, 'conventional', 600, 180,
  )
  assert(result.warnings.some((w) => w.code === 'entryHelixDiameterClamped'), 'should warn about clamping')
  const leadIns = moves.filter((m) => m.kind === 'lead_in')
  assert(leadIns.length > 0, 'should still emit helix moves')
  const maxDist = Math.max(...leadIns.flatMap((m) => [
    Math.hypot(m.from.x, m.from.y),
    Math.hypot(m.to.x, m.to.y),
  ]))
  assert(maxDist <= toolDiameter / 2 + 1e-9, `path radius ${maxDist} must not exceed tool radius ${toolDiameter / 2}`)
})

test('center-locked bore: monotonic descent', () => {
  const moves: ToolpathMove[] = []
  emitCenterLockedCircularBore(
    moves, null, { x: 0, y: 0 }, 1.6, 10, 4,
    -6, 10, 0, 5, 'conventional', 600, 180,
  )
  const descending = moves.filter((m) => m.kind === 'lead_in' && m.to.z < m.from.z - 1e-9)
  assert(descending.length > 0, 'should have descending lead-in moves')
  for (const move of descending) {
    assert(move.to.z < move.from.z, 'Z must descend monotonically')
  }
  // No move should ascend during the descent phase
  for (let i = 1; i < descending.length; i += 1) {
    assert(
      descending[i].from.z <= descending[i - 1].from.z + 1e-9,
      `descent start Z should not increase: ${descending[i].from.z} after ${descending[i - 1].from.z}`,
    )
  }
})

test('center-locked bore: feed clamp respects plunge feed', () => {
  const moves: ToolpathMove[] = []
  emitCenterLockedCircularBore(
    moves, null, { x: 0, y: 0 }, 1.6, 10, 4,
    -6, 10, 0, 15, 'conventional', 1000, 80,
  )
  const withFeedScale = moves.filter((m) => m.kind === 'lead_in' && m.feedScale !== undefined)
  assert(withFeedScale.length > 0, 'steep ramp angle should trigger feed scale')
  for (const move of withFeedScale) {
    const dz = move.to.z - move.from.z
    assert(dz < -1e-9, 'feed-scaled moves should be descending')
    const dx = move.to.x - move.from.x
    const dy = move.to.y - move.from.y
    const distance = Math.hypot(dx, dy, Math.abs(dz))
    const verticalFeed = 1000 * (move.feedScale ?? 1) * Math.abs(dz) / distance
    assert(verticalFeed <= 80 + 0.1, `vertical feed ${verticalFeed.toFixed(4)} exceeds plunge feed 80`)
  }
})

test('center-locked bore: direction respects cutDirection', () => {
  const climbMoves: ToolpathMove[] = []
  emitCenterLockedCircularBore(
    climbMoves, null, { x: 0, y: 0 }, 1.6, 10, 4,
    -6, 10, 0, 5, 'climb', 600, 180,
  )
  const climbLeadIns = climbMoves.filter((m) => m.kind === 'lead_in')
  // Climb (internal) → direction = -1 → CW in project space (Y-down)
  // At angle 0 (start), first move should go toward negative Y (clockwise)
  const firstClimb = climbLeadIns[0]
  assert(firstClimb !== undefined, 'should have at least one lead-in')
  const climbDY = firstClimb.to.y - firstClimb.from.y
  // For climb internal, direction = -1, starting at angle 0 means moving toward -Y
  assert(climbDY < 0, `climb first move should go CW (negative Y), got dy=${climbDY.toFixed(4)}`)

  const convMoves: ToolpathMove[] = []
  emitCenterLockedCircularBore(
    convMoves, null, { x: 0, y: 0 }, 1.6, 10, 4,
    -6, 10, 0, 5, 'conventional', 600, 180,
  )
  const convLeadIns = convMoves.filter((m) => m.kind === 'lead_in')
  const firstConv = convLeadIns[0]
  assert(firstConv !== undefined, 'should have at least one lead-in')
  const convDY = firstConv.to.y - firstConv.from.y
  // For conventional internal, direction = 1 → CCW in project space → +Y
  assert(convDY > -1e-9, `conventional first move should go CCW, got dy=${convDY.toFixed(4)}`)
})

test('center-locked bore: one constant-Z bottom-flattening revolution', () => {
  const moves: ToolpathMove[] = []
  const bottomZ = -6
  emitCenterLockedCircularBore(
    moves, null, { x: 0, y: 0 }, 1.6, 10, 4,
    bottomZ, 10, 0, 5, 'conventional', 600, 180,
  )
  const flatMoves = moves.filter((m) =>
    m.kind === 'lead_in' && approx(m.from.z, bottomZ) && approx(m.to.z, bottomZ))
  assert(flatMoves.length === 48, `expected 48 flat bottom moves, got ${flatMoves.length}`)
})

test('center-locked bore: shallow-angle move-budget fallback', () => {
  const moves: ToolpathMove[] = []
  const result = emitCenterLockedCircularBore(
    moves, null, { x: 0, y: 0 },
    0.02, 2, 0.03,  // tiny tool, tiny hole, tiny requested radius
    -100, 0, 0,   // very deep hole
    0.05,         // extremely shallow ramp angle (→ enormous move count)
    'conventional', 600, 180,
  )
  assert(result.warnings.some((w) => w.code === 'entryStrategyFallback'), 'should fall back when move budget exceeded')
})

test('center-locked bore: finish-bore move-budget rejection emits no moves', () => {
  const moves: ToolpathMove[] = []
  const result = emitCenterLockedCircularBore(
    moves, null, { x: 0, y: 0 },
    0.02, 2, 0.03,  // tiny tool, tiny hole, tiny requested radius
    -100, 0, 0,   // very deep hole: bottomZ, safeZ, retractZ
    0.05,         // extremely shallow ramp angle (→ enormous move count)
    'conventional', 600, 180,
    true, // isFinishBore
  )
  assert(result.warnings.some((w) => w.code === 'drillHelicalBoreUnmachinable'),
    'finish-bore move-budget breach should reject with unmachinable warning')
  assert(!moves.some((m) => m.kind === 'plunge'), 'rejection must emit zero moves')
  assert(moves.length === 0, 'rejection must emit zero moves')
})

test('center-locked bore: oversized tool in small hole falls back', () => {
  // toolDiameter=5, holeRadius=3 → toolRadius=2.5, safety=0.5 → maxSafePathRadius=0
  const moves: ToolpathMove[] = []
  const result = emitCenterLockedCircularBore(
    moves, null, { x: 0, y: 0 },
    2, 3, 5,  // tool diameter 5, hole radius 3 → max safe = 3 - 2.5 - 0.5 = 0
    -3, 10, 0, 5, 'conventional', 600, 180,
  )
  assert(result.warnings.some((w) => w.code === 'entryStrategyFallback'), 'oversized tool should fall back to plunge')
  assert(moves.some((m) => m.kind === 'plunge'), 'fallback should emit plunge')
})

test('center-locked bore: too-small hole falls back to plunge', () => {
  // Hole radius = tool radius + epsilon → no room for any path
  const moves: ToolpathMove[] = []
  const holeRadius = 2.1  // tool radius = 2, safety = 0.4, so maxSafePathRadius = 2.1 - 2 - 0.4 = -0.3 → 0
  const result = emitCenterLockedCircularBore(
    moves, null, { x: 0, y: 0 },
    1.6, holeRadius, 4,
    -3, 10, 0, 5, 'conventional', 600, 180,
  )
  assert(result.warnings.some((w) => w.code === 'entryStrategyFallback'), 'hole too tight for helix should fall back')
  assert(moves.some((m) => m.kind === 'plunge'), 'should emit plunge fallback')
})

test('center-locked bore: rapid travel and retract at safeZ', () => {
  const moves: ToolpathMove[] = []
  const safeZ = 10
  emitCenterLockedCircularBore(
    moves, null, { x: 20, y: 20 }, 1.6, 10, 4,
    -6, safeZ, 0, 5, 'conventional', 600, 180,
  )
  // Initial rapid should be at safeZ
  const rapids = moves.filter((m) => m.kind === 'rapid')
  assert(rapids.length >= 2, 'should have initial travel rapid and final retract rapid')
  // Final retract should reach safeZ
  const lastRapid = rapids[rapids.length - 1]
  assert(approx(lastRapid.to.z, safeZ), `final retract should be at safeZ=${safeZ}, got ${lastRapid.to.z}`)
})

test('center-locked bore: null current establishes safeZ before retract descent', () => {
  const moves: ToolpathMove[] = []
  const safeZ = 10
  const retractZ = 0
  emitCenterLockedCircularBore(
    moves, null, { x: 20, y: 20 }, 1.6, 10, 4,
    -6, safeZ, retractZ, 5, 'conventional', 600, 180,
  )
  // First move must be a rapid to { hole centre, safeZ } — establishes
  // safe XY *before* any Z descent, so the postprocessor (which emits Z
  // before XY on its first rapid) cannot descend at an unknown location.
  const first = moves[0]
  assert(first !== undefined, 'should have at least one move')
  assert(first.kind === 'rapid', `first move should be rapid, got ${first.kind}`)
  assert(approx(first.from.x, 20) && approx(first.from.y, 20) && approx(first.from.z, safeZ),
    `first rapid from should be at hole centre + safeZ=${safeZ}, got (${first.from.x}, ${first.from.y}, ${first.from.z})`)
  assert(approx(first.to.x, 20) && approx(first.to.y, 20) && approx(first.to.z, safeZ),
    `first rapid to should be at hole centre + safeZ=${safeZ}, got (${first.to.x}, ${first.to.y}, ${first.to.z})`)

  // After the safe-Z establishment, the next rapid may descend to retractZ.
  // Verify that no rapid descends below safeZ before the position is established.
  const rapids = moves.filter((m) => m.kind === 'rapid')
  const firstDescent = rapids.find((m) => m.to.z < safeZ - 1e-9)
  assert(firstDescent !== undefined, 'should have a descent rapid after safe-Z establishment')
  const firstDescentIdx = rapids.indexOf(firstDescent)
  assert(firstDescentIdx > 0, 'descent rapid must come after the initial safe-Z establishment rapid')
})

test('center-locked bore: fallback establishes safeZ before retract descent when current is null', () => {
  // Force fallback with an oversized tool in a small hole.
  const moves: ToolpathMove[] = []
  const safeZ = 10
  const retractZ = 0
  emitCenterLockedCircularBore(
    moves, null, { x: 0, y: 0 },
    2, 3, 5,  // tool diameter 5, hole radius 3 → max safe = 0 → fallback
    -3, safeZ, retractZ, 5, 'conventional', 600, 180,
  )
  // First move must establish safeZ at hole centre, even in the fallback path.
  const first = moves[0]
  assert(first !== undefined, 'fallback should have at least one move')
  assert(first.kind === 'rapid', `fallback first move should be rapid, got ${first.kind}`)
  assert(approx(first.from.z, safeZ) && approx(first.to.z, safeZ),
    `fallback first rapid should be at safeZ=${safeZ}, got from.z=${first.from.z} to.z=${first.to.z}`)
})

test('center-locked bore: warns when requested diameter is clamped by clearance', () => {
  const moves: ToolpathMove[] = []
  // Request 80% of 4mm tool = 3.2mm diameter = 1.6mm radius
  // But hole radius = 2.5, tool radius = 2, safety = 0.4
  // maxSafePathRadius = 2.5 - 2 - 0.4 = 0.1
  // So path is clamped from 1.6 to 0.1
  const result = emitCenterLockedCircularBore(
    moves, null, { x: 0, y: 0 },
    1.6, 2.5, 4,
    -3, 10, 0, 5, 'conventional', 600, 180,
  )
  assert(result.warnings.some((w) => w.code === 'entryHelixDiameterClamped'), 'tight clearance should clamp and warn')
})

// ── Finish-bore mode (isFinishBore=true) ─────────────────────────

test('finish-bore: exact H−T radius, no safety subtraction, no no-core clamp', () => {
  const moves: ToolpathMove[] = []
  const center = { x: 20, y: 20 }
  const toolDiameter = 4   // toolRadius = 2
  const holeRadius = 5     // boreRadius = 5 − 2 = 3
  const boreRadius = holeRadius - toolDiameter / 2 // = 3

  const result = emitCenterLockedCircularBore(
    moves, null, center, boreRadius, holeRadius, toolDiameter,
    -6, 10, 0, 5, 'conventional', 600, 180,
    true, // isFinishBore
  )
  assert(result.warnings.filter((w) => w.code !== 'entryHelixDiameterClamped').length === 0,
    'finish-bore should have no structural warnings')
  assert(approx(result.position.z, 10), 'final retract should be at safeZ')

  // Every lead-in point must be at exactly boreRadius from the centre.
  const leadIns = moves.filter((m) => m.kind === 'lead_in')
  assert(leadIns.length > 0, 'finish-bore should emit lead_in moves')
  for (const move of leadIns) {
    for (const pt of [move.from, move.to]) {
      const dist = Math.hypot(pt.x - center.x, pt.y - center.y)
      assert(approx(dist, boreRadius, 0.01),
        `finish-bore point at dist ${dist.toFixed(4)} must equal boreRadius=${boreRadius}`)
    }
  }

  // The swept envelope should reach the selected wall exactly:
  // boreRadius + toolRadius = (5−2) + 2 = 5 = holeRadius
  const maxDist = Math.max(...leadIns.flatMap((m) => [
    Math.hypot(m.from.x - center.x, m.from.y - center.y),
    Math.hypot(m.to.x - center.x, m.to.y - center.y),
  ]))
  assert(approx(maxDist + toolDiameter / 2, holeRadius, 0.01),
    `swept envelope ${(maxDist + toolDiameter / 2).toFixed(4)} must equal holeRadius ${holeRadius}`)
})

test('finish-bore: 2× boundary (holeDiameter = 2 × toolDiameter)', () => {
  const moves: ToolpathMove[] = []
  const toolDiameter = 4
  const holeRadius = 4  // holeDiameter = 8 = 2 × toolDiameter
  const boreRadius = holeRadius - toolDiameter / 2 // = 2

  const result = emitCenterLockedCircularBore(
    moves, null, { x: 0, y: 0 }, boreRadius, holeRadius, toolDiameter,
    -6, 10, 0, 5, 'conventional', 600, 180,
    true,
  )
  assert(result.warnings.filter((w) => w.code !== 'entryHelixDiameterClamped').length === 0,
    '2× boundary finish-bore should succeed')
  const leadIns = moves.filter((m) => m.kind === 'lead_in')
  assert(leadIns.length > 0, '2× boundary should emit moves')
  // boreRadius = 2, toolRadius = 2 → boreRadius <= toolRadius → core is removed
  assert(boreRadius <= toolDiameter / 2, 'bore radius must be at most tool radius')
})

test('finish-bore: swept-envelope gate rejects oversized radius with no moves', () => {
  const moves: ToolpathMove[] = []
  // Pass boreRadius larger than holeRadius − toolRadius — the gate should trip.
  const result = emitCenterLockedCircularBore(
    moves, null, { x: 0, y: 0 },
    3,  // boreRadius = 3
    4,  // holeRadius = 4 → toolRadius=2, so max boreRadius=2
    4,  // toolDiameter
    -3, 10, 0, 5, 'conventional', 600, 180,
    true,
  )
  // Swept envelope: 3 + 2 = 5 > 4 → gate rejects with no moves
  assert(result.warnings.some((w) => w.code === 'drillHelicalBoreUnmachinable'),
    'oversized finish-bore radius should reject with unmachinable warning')
  assert(!moves.some((m) => m.kind === 'plunge'), 'rejection must emit zero moves')
  assert(moves.length === 0, 'rejection must emit zero moves')
})

console.log(`\nentry.ts tests: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
