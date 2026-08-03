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

console.log(`\nentry.ts tests: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
