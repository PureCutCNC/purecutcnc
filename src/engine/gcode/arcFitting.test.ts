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
 * Tests for export-stage arc fitting.
 *
 * Run with: npx tsx src/engine/gcode/arcFitting.test.ts
 */

import { fitArcsInMachineMoves } from './arcFitting'
import type { ToolpathMove, ToolpathPoint } from '../toolpaths/types'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function pt(x: number, y: number, z = 0): ToolpathPoint {
  return { x, y, z }
}

function cut(from: ToolpathPoint, to: ToolpathPoint, extras?: Partial<ToolpathMove>): ToolpathMove {
  return { kind: 'cut', from, to, ...extras }
}

function rapid(from: ToolpathPoint, to: ToolpathPoint): ToolpathMove {
  return { kind: 'rapid', from, to }
}

const TOL = 0.01
const MAX_DEG = 90

// ── accepted circular chord run ────────────────────────────────

function testAcceptedCircularRun(): void {
  console.log('Testing accepted circular chord run...')

  // 16 points on a circle of radius 10 centred at (0, 0) — well within tolerance.
  const r = 10
  const n = 16
  const points: ToolpathPoint[] = []
  for (let i = 0; i <= n; i++) {
    const angle = (Math.PI * 2 * i) / n
    points.push(pt(r * Math.cos(angle), r * Math.sin(angle), 0))
  }
  // Build chord moves: from points[i] to points[i+1].
  const moves: ToolpathMove[] = []
  for (let i = 0; i < n; i++) {
    moves.push(cut(points[i], points[i + 1]))
  }

  const result = fitArcsInMachineMoves(moves, TOL, MAX_DEG)

  // Should produce arc segments (split into ≤ 90° pieces).
  // 16 segments at 22.5° each = 360° → 4 arcs of 90°.
  const arcCount = result.filter(d => d.kind === 'arc').length
  assert(arcCount === 4, `expected 4 arc segments for full circle, got ${arcCount}`)

  // First arc should be CCW (mathematically positive).
  const firstArc = result.find(d => d.kind === 'arc')
  assert(firstArc !== undefined, 'expected at least one arc')
  if (firstArc && firstArc.kind === 'arc') {
    assert(firstArc.clockwise === false, 'expected CCW (counter-clockwise) arc')
  }

  // Endpoint of the last arc should match the final point.
  const last = result[result.length - 1]
  assert(last !== undefined, 'expected at least one descriptor')
  if (last && last.kind === 'arc') {
    const dx = last.endPoint.x - points[n].x
    const dy = last.endPoint.y - points[n].y
    assert(Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6,
      `last arc endpoint should match input end: got (${last.endPoint.x}, ${last.endPoint.y}) expected (${points[n].x}, ${points[n].y})`)
  }
}

// ── clock-wise direction after Y inversion ─────────────────────

function testClockwiseAfterYInvert(): void {
  console.log('Testing clockwise direction after Y-inverting transform...')

  // Simulate a CCW circle in screen space (Y-down) that becomes CW
  // after Y inversion: project coords Y-down → machine coords Y-up.
  // In screen space (Y-down), a CW circle goes: right → down → left → up.
  // After Y inversion, that becomes: right → up → left → down = CCW in Y-up.
  // For CW in Y-up (G2), the input must be CW in Y-up machine space.
  // Let's just construct a known CW arc in machine coords directly.
  const r = 10
  const n = 8
  const points: ToolpathPoint[] = []
  for (let i = 0; i <= n; i++) {
    // CW in Y-up: decreasing angle.
    const angle = -(Math.PI * 2 * i) / n
    points.push(pt(r * Math.cos(angle), r * Math.sin(angle), 0))
  }
  const moves: ToolpathMove[] = []
  for (let i = 0; i < n; i++) {
    moves.push(cut(points[i], points[i + 1]))
  }

  const result = fitArcsInMachineMoves(moves, TOL, MAX_DEG)
  const arcs = result.filter(d => d.kind === 'arc')
  assert(arcs.length > 0, 'expected at least one arc')
  if (arcs[0] && arcs[0].kind === 'arc') {
    assert(arcs[0].clockwise === true, `expected clockwise arc (CW), got clockwise=${arcs[0].clockwise}`)
  }
}

// ── rejection of straight / near-collinear runs ─────────────────

function testRejectsStraightRun(): void {
  console.log('Testing rejection of straight line run...')

  const moves: ToolpathMove[] = [
    cut(pt(0, 0), pt(1, 0)),
    cut(pt(1, 0), pt(2, 0)),
    cut(pt(2, 0), pt(3, 0)),
    cut(pt(3, 0), pt(4, 0)),
  ]

  const result = fitArcsInMachineMoves(moves, TOL, MAX_DEG)
  const arcs = result.filter(d => d.kind === 'arc')
  assert(arcs.length === 0, 'straight run should produce no arcs')
  assert(result.length === 4, 'all 4 moves should remain as linear')
  for (const d of result) {
    assert(d.kind === 'linear', 'every descriptor should be linear')
  }
}

// ── rejection of ramping (Z-changing) run ───────────────────────

function testRejectsZChangingRun(): void {
  console.log('Testing rejection of ramping (Z-changing) run...')

  const moves: ToolpathMove[] = [
    cut(pt(10, 0, 0), pt(7.07, 7.07, -0.5)),
    cut(pt(7.07, 7.07, -0.5), pt(0, 10, -1)),
    cut(pt(0, 10, -1), pt(-7.07, 7.07, -1.5)),
  ]

  const result = fitArcsInMachineMoves(moves, TOL, MAX_DEG)
  const arcs = result.filter(d => d.kind === 'arc')
  assert(arcs.length === 0, 'Z-changing run should produce no arcs')
}

// ── rejection of mixed-feed run ─────────────────────────────────

function testRejectsMixedFeedScaleRun(): void {
  console.log('Testing rejection of mixed feedScale run...')

  // 8 points on a circle, but alternating feedScale.
  const r = 10
  const n = 8
  const points: ToolpathPoint[] = []
  for (let i = 0; i <= n; i++) {
    const angle = (Math.PI * 2 * i) / n
    points.push(pt(r * Math.cos(angle), r * Math.sin(angle), 0))
  }
  const moves: ToolpathMove[] = []
  for (let i = 0; i < n; i++) {
    moves.push(cut(points[i], points[i + 1], { feedScale: i % 2 === 0 ? 0.5 : 1 }))
  }

  const result = fitArcsInMachineMoves(moves, TOL, MAX_DEG)
  // The first two moves share feedScale 0.5 (a run of 2 — not enough for ≥ 3)
  // Then moves with feedScale 1 form a run of 2 — also not enough.
  // The pattern alternates, so no qualifying run.
  const arcs = result.filter(d => d.kind === 'arc')
  assert(arcs.length === 0, 'mixed feedScale run should produce no arcs')
}

// ── rejection of discontinuous run (non-contiguous to/from) ─────

function testRejectsDiscontinuousRun(): void {
  console.log('Testing rejection of discontinuous run...')

  // Points on a circle but with a gap.
  const r = 10
  const moves: ToolpathMove[] = [
    cut(pt(r, 0, 0), pt(r * Math.cos(Math.PI / 4), r * Math.sin(Math.PI / 4), 0)),
    cut(pt(r * Math.cos(Math.PI / 4), r * Math.sin(Math.PI / 4), 0), pt(0, r, 0)),
    // gap: next from is different
    cut(pt(10, 5, 0), pt(0, 5, 0)),
    cut(pt(0, 5, 0), pt(5, 10, 0)),
  ]

  const result = fitArcsInMachineMoves(moves, TOL, MAX_DEG)
  const arcs = result.filter(d => d.kind === 'arc')
  assert(arcs.length === 0, 'discontinuous run should produce no arcs')
}

// ── run split around rapid moves ────────────────────────────────

function testSplitsAroundRapids(): void {
  console.log('Testing that rapid moves split fitting runs...')

  const r = 10
  // first arc: 4 chord segments on a circle
  const arc1Points: ToolpathPoint[] = []
  for (let i = 0; i <= 4; i++) {
    const angle = (Math.PI / 2 * i) / 4  // 0 to 90°
    arc1Points.push(pt(r * Math.cos(angle), r * Math.sin(angle), 0))
  }
  // second arc: 4 chord segments on a different circle
  const arc2Points: ToolpathPoint[] = []
  for (let i = 0; i <= 4; i++) {
    const angle = Math.PI + (Math.PI / 2 * i) / 4  // 180° to 270°
    arc2Points.push(pt(r * Math.cos(angle), r * Math.sin(angle), 0))
  }

  const moves: ToolpathMove[] = []
  for (let i = 0; i < 4; i++) moves.push(cut(arc1Points[i], arc1Points[i + 1]))
  moves.push(rapid(arc1Points[4], arc2Points[0]))
  for (let i = 0; i < 4; i++) moves.push(cut(arc2Points[i], arc2Points[i + 1]))

  const result = fitArcsInMachineMoves(moves, TOL, MAX_DEG)
  const arcs = result.filter(d => d.kind === 'arc')
  // Each 90° arc fits in one ≤90° segment — so 2 arcs expected.
  assert(arcs.length === 2, `expected 2 arcs, got ${arcs.length}`)

  // The rapid move should pass through as linear.
  const linears = result.filter(d => d.kind === 'linear')
  assert(linears.length === 1, `expected 1 linear (rapid), got ${linears.length}`)
}

// ── runs with fewer than 3 chords stay linear ───────────────────

function testShortRunStaysLinear(): void {
  console.log('Testing that runs with < 3 chord segments stay linear...')

  const moves: ToolpathMove[] = [
    cut(pt(10, 0, 0), pt(7, 7, 0)),
    cut(pt(7, 7, 0), pt(0, 10, 0)),
  ]

  const result = fitArcsInMachineMoves(moves, TOL, MAX_DEG)
  const arcs = result.filter(d => d.kind === 'arc')
  assert(arcs.length === 0, 'run with 2 moves should produce no arcs')
  assert(result.length === 2, 'both moves should be retained')
}

// ── source tag is carried through ───────────────────────────────

function testSourceTagCarriedThrough(): void {
  console.log('Testing source tag is carried through to arcs and linear moves...')

  const r = 10
  const n = 4
  const points: ToolpathPoint[] = []
  for (let i = 0; i <= n; i++) {
    const angle = (Math.PI / 2 * i) / n
    points.push(pt(r * Math.cos(angle), r * Math.sin(angle), 0))
  }
  const moves: ToolpathMove[] = []
  for (let i = 0; i < n; i++) {
    moves.push(cut(points[i], points[i + 1], { source: 'debug:offset-ring' }))
  }

  const result = fitArcsInMachineMoves(moves, TOL, MAX_DEG)
  for (const d of result) {
    assert(d.source === 'debug:offset-ring', `expected source tag, got ${d.source}`)
  }
}

// ── feedScale is carried through ────────────────────────────────

function testFeedScaleCarriedThrough(): void {
  console.log('Testing feedScale is carried through to arcs and linear moves...')

  const r = 10
  const n = 4
  const points: ToolpathPoint[] = []
  for (let i = 0; i <= n; i++) {
    const angle = (Math.PI / 2 * i) / n
    points.push(pt(r * Math.cos(angle), r * Math.sin(angle), 0))
  }
  const moves: ToolpathMove[] = []
  for (let i = 0; i < n; i++) {
    moves.push(cut(points[i], points[i + 1], { feedScale: 0.5 }))
  }

  const result = fitArcsInMachineMoves(moves, TOL, MAX_DEG)
  const arcs = result.filter(d => d.kind === 'arc')
  assert(arcs.length > 0, 'expected arcs with feedScale')
  for (const d of result) {
    assert(d.feedScale === 0.5, `expected feedScale 0.5, got ${d.feedScale}`)
  }
}

// ── runs with inconsistent direction are rejected ───────────────

function testRejectsAmbiguousDirection(): void {
  console.log('Testing rejection of ambiguous direction (S-curve)...')

  // An S-curve that alternates direction.
  const moves: ToolpathMove[] = [
    cut(pt(0, 0, 0), pt(1, 1, 0)),
    cut(pt(1, 1, 0), pt(2, 0, 0)),
    cut(pt(2, 0, 0), pt(3, 1, 0)),
    cut(pt(3, 1, 0), pt(4, 0, 0)),
  ]

  const result = fitArcsInMachineMoves(moves, TOL, MAX_DEG)
  const arcs = result.filter(d => d.kind === 'arc')
  assert(arcs.length === 0, 'S-curve should produce no arcs')
}

// ── run with different source tags are split ────────────────────

function testSplitsOnDifferentSource(): void {
  console.log('Testing that different source tags split runs...')

  const r = 10
  const points1: ToolpathPoint[] = [pt(r, 0, 0), pt(0, r, 0), pt(-r, 0, 0)]
  const points2: ToolpathPoint[] = [pt(-r, 0, 0), pt(0, -r, 0), pt(r, 0, 0)]

  const moves: ToolpathMove[] = [
    cut(points1[0], points1[1], { source: 'tag-a' }),
    cut(points1[1], points1[2], { source: 'tag-a' }),
    cut(points2[0], points2[1], { source: 'tag-b' }),
    cut(points2[1], points2[2], { source: 'tag-b' }),
  ]

  const result = fitArcsInMachineMoves(moves, TOL, MAX_DEG)
  // Each run has only 2 moves — not enough for arc fitting.
  const arcs = result.filter(d => d.kind === 'arc')
  assert(arcs.length === 0, 'runs split by source tag with < 3 chords should produce no arcs')
}

// ── plunge and lead moves are excluded ──────────────────────────

function testExcludesPlungeAndLead(): void {
  console.log('Testing that plunge and lead moves are excluded from fitting...')

  const r = 10
  const n = 4
  const points: ToolpathPoint[] = []
  for (let i = 0; i <= n; i++) {
    // 90° arc from angle 0 to π/2 (4 chord segments).
    const angle = (Math.PI / 2 * i) / n
    points.push(pt(r * Math.cos(angle), r * Math.sin(angle), 0))
  }

  const moves: ToolpathMove[] = [
    { kind: 'lead_in', from: pt(0, 0, 5), to: pt(r, 0, 0) },
    cut(points[0], points[1]),
    cut(points[1], points[2]),
    cut(points[2], points[3]),
    cut(points[3], points[4]),
    { kind: 'lead_out', from: points[4], to: pt(0, 0, 5) },
    { kind: 'plunge', from: pt(0, 0, 5), to: pt(0, 0, -2) },
  ]

  const result = fitArcsInMachineMoves(moves, TOL, MAX_DEG)
  // lead_in → linear, 4 cuts = 1 arc (90°), lead_out → linear, plunge → linear.
  const arcs = result.filter(d => d.kind === 'arc')
  assert(arcs.length === 1, `expected 1 arc from the 4 cut moves (90° sweep), got ${arcs.length}`)
  const linears = result.filter(d => d.kind === 'linear')
  assert(linears.length === 3, `expected 3 linear moves (lead_in, lead_out, plunge), got ${linears.length}`)
}

// ── high residual run rejected ──────────────────────────────────

function testRejectsHighResidualRun(): void {
  console.log('Testing rejection of high-residual run...')

  // Points that roughly follow an ellipse (not a circle) — fitting will have high residual.
  const a = 10, b = 5  // ellipse semi-axes
  const n = 8
  const points: ToolpathPoint[] = []
  for (let i = 0; i <= n; i++) {
    const angle = (Math.PI * 2 * i) / n
    points.push(pt(a * Math.cos(angle), b * Math.sin(angle), 0))
  }
  const moves: ToolpathMove[] = []
  for (let i = 0; i < n; i++) {
    moves.push(cut(points[i], points[i + 1]))
  }

  const result = fitArcsInMachineMoves(moves, 0.01, MAX_DEG)
  const arcs = result.filter(d => d.kind === 'arc')
  // Ellipse of 10x5 deviates ~2.5mm from best-fit circle — way above 0.01mm tolerance.
  assert(arcs.length === 0, `ellipse should produce no arcs (residual > 0.01), got ${arcs.length}`)
}

// ── empty input ─────────────────────────────────────────────────

function testEmptyInput(): void {
  console.log('Testing empty input...')
  const result = fitArcsInMachineMoves([], TOL, MAX_DEG)
  assert(result.length === 0, 'empty input should produce empty output')
}

// ── all moves are rapids only ───────────────────────────────────

function testAllRapids(): void {
  console.log('Testing all-rapid input...')
  const moves: ToolpathMove[] = [
    rapid(pt(0, 0, 5), pt(10, 0, 5)),
    rapid(pt(10, 0, 5), pt(10, 10, 5)),
  ]
  const result = fitArcsInMachineMoves(moves, TOL, MAX_DEG)
  assert(result.length === 2, 'both rapids should be retained')
  for (const d of result) {
    assert(d.kind === 'linear', 'rapids should be linear descriptors')
  }
}

// ── single-move cut run stays linear ────────────────────────────

function testSingleCutStaysLinear(): void {
  console.log('Testing single cut move stays linear...')
  const moves: ToolpathMove[] = [cut(pt(0, 0, 0), pt(10, 0, 0))]
  const result = fitArcsInMachineMoves(moves, TOL, MAX_DEG)
  assert(result.length === 1 && result[0].kind === 'linear', 'single cut should stay linear')
}

// ── 270° arc split into ≤90° segments ──────────────────────────

function testSplitsLargeArc(): void {
  console.log('Testing large arc (270°) is split into ≤90° segments...')

  const r = 10
  const n = 32  // many segments for good fitting
  const points: ToolpathPoint[] = []
  for (let i = 0; i <= n; i++) {
    const angle = (Math.PI * 3 / 2 * i) / n  // 0 to 270°
    points.push(pt(r * Math.cos(angle), r * Math.sin(angle), 0))
  }
  const moves: ToolpathMove[] = []
  for (let i = 0; i < n; i++) {
    moves.push(cut(points[i], points[i + 1]))
  }

  const result = fitArcsInMachineMoves(moves, TOL, MAX_DEG)
  const arcs = result.filter(d => d.kind === 'arc')
  // 270° total → ceil(270/90) = 3 segments.
  assert(arcs.length === 3, `expected 3 arc segments for 270°, got ${arcs.length}`)

  // Verify each arc sweep ≤ 90°.
  for (const a of arcs) {
    if (a.kind !== 'arc') continue
    // Centre = (startPoint - centerOffsets)
    const cx = a.startPoint.x - a.centerOffsets.i
    const cy = a.startPoint.y - a.centerOffsets.j
    const a0 = Math.atan2(a.startPoint.y - cy, a.startPoint.x - cx)
    const a1 = Math.atan2(a.endPoint.y - cy, a.endPoint.x - cx)
    let sweep = Math.abs(a1 - a0)
    if (sweep > Math.PI) sweep = TWO_PI - sweep
    const sweepDeg = (sweep * 180) / Math.PI
    assert(sweepDeg <= 90.1, `arc sweep ${sweepDeg.toFixed(1)}° exceeds 90°`)
  }
}

const TWO_PI = Math.PI * 2

// ── run all ─────────────────────────────────────────────────────

testAcceptedCircularRun()
testClockwiseAfterYInvert()
testRejectsStraightRun()
testRejectsZChangingRun()
testRejectsMixedFeedScaleRun()
testRejectsDiscontinuousRun()
testSplitsAroundRapids()
testShortRunStaysLinear()
testSourceTagCarriedThrough()
testFeedScaleCarriedThrough()
testRejectsAmbiguousDirection()
testSplitsOnDifferentSource()
testExcludesPlungeAndLead()
testRejectsHighResidualRun()
testEmptyInput()
testAllRapids()
testSingleCutStaysLinear()
testSplitsLargeArc()

console.log('arcFitting tests passed')
