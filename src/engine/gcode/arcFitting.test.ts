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
import type { ArcMoveDescriptor } from './arcFitting'
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

// ── split-arc I/J is relative to each segment's own start ───────

function testSplitArcOffsetsRelative(): void {
  console.log('Testing that split-arc I/J offsets are relative to each segment start...')

  // Full circle of radius 10 centred at (0, 0) → 16 chord segments → 4 × 90° arcs.
  const r = 10
  const n = 16
  const points: ToolpathPoint[] = []
  for (let i = 0; i <= n; i++) {
    const angle = (Math.PI * 2 * i) / n
    points.push(pt(r * Math.cos(angle), r * Math.sin(angle), 0))
  }
  const moves: ToolpathMove[] = []
  for (let i = 0; i < n; i++) {
    moves.push(cut(points[i], points[i + 1]))
  }

  const result = fitArcsInMachineMoves(moves, TOL, MAX_DEG)
  const arcs = result.filter(d => d.kind === 'arc')
  assert(arcs.length >= 2, `need at least 2 arc segments for meaningful I/J test, got ${arcs.length}`)

  // Verify a common centre: for each arc, centre = startPoint + (i, j).
  const centers = arcs.map(a => {
    if (a.kind !== 'arc') throw new Error('expected arc')
    return {
      x: a.startPoint.x + a.centerOffsets.i,
      y: a.startPoint.y + a.centerOffsets.j,
    }
  })
  const c0 = centers[0]
  for (const c of centers) {
    const dcx = c.x - c0.x
    const dcy = c.y - c0.y
    assert(Math.abs(dcx) < 1e-6 && Math.abs(dcy) < 1e-6,
      `all arc segments must share the same centre; got (${c.x}, ${c.y}) vs (${c0.x}, ${c0.y})`)
  }

  // At least one later segment must have different I/J from the first — this
  // confirms offsets are computed per segment, not copied from the run start.
  const firstIJ = { i: (arcs[0] as ArcMoveDescriptor).centerOffsets.i, j: (arcs[0] as ArcMoveDescriptor).centerOffsets.j }
  let distinctCount = 0
  for (const a of arcs) {
    if (a.kind !== 'arc') continue
    const di = a.centerOffsets.i - firstIJ.i
    const dj = a.centerOffsets.j - firstIJ.j
    if (Math.abs(di) > 1e-6 || Math.abs(dj) > 1e-6) distinctCount++
  }
  assert(distinctCount > 0, `expected at least one split segment to have different I/J offsets; all were (${firstIJ.i}, ${firstIJ.j})`)
}

// ── non-planar rejection: Z-changing first cut ──────────────────

function testRejectsPlanarWithZChangingFirstCut(): void {
  console.log('Testing rejection when first cut changes Z (non-planar lead)...')

  // First move changes Z — the run must be rejected even though subsequent
  // cuts look circular and planar.
  const r = 10
  const moves: ToolpathMove[] = [
    cut(pt(r, 0, 0), pt(0, r, -0.5)),                           // Z-changing first cut
    cut(pt(0, r, -0.5), pt(-r, 0, -0.5)),                       // planar-looking at -0.5
    cut(pt(-r, 0, -0.5), pt(0, -r, -0.5)),                      // planar-looking at -0.5
    cut(pt(0, -r, -0.5), pt(r, 0, -0.5)),                       // planar-looking at -0.5
  ]

  const result = fitArcsInMachineMoves(moves, TOL, MAX_DEG)
  const arcs = result.filter(d => d.kind === 'arc')
  assert(arcs.length === 0, 'run with Z-changing first cut must produce no arcs')
  assert(result.length === 4, 'all 4 moves should remain as linear')
  for (const d of result) {
    assert(d.kind === 'linear', 'every descriptor should be linear')
  }
}

// ── near-collinear rejection ────────────────────────────────────

function testRejectsNearCollinearRun(): void {
  console.log('Testing rejection of near-collinear (shallow bend) run...')

  // A very shallow bend: points follow a huge-radius circle (R ≈ 100 000 mm)
  // with a tiny angular sweep (well below 0.5°).  The Kasa residual would
  // be tiny, but the total sweep gate must still reject it.
  const hugeR = 100000
  const shallowSweep = Math.PI / 720  // 0.25° — below the 0.5° threshold
  const points: ToolpathPoint[] = []
  const n = 4
  for (let i = 0; i <= n; i++) {
    const angle = shallowSweep * (i / n - 0.5)
    points.push(pt(hugeR * Math.cos(angle), hugeR * Math.sin(angle), 0))
  }
  // Re-centre so the chord is near the origin (avoids floating-point issues).
  const cx = points[0].x
  const cy = (points[0].y + points[n].y) / 2
  const recentred = points.map(p => pt(p.x - cx, p.y - cy, 0))
  const moves: ToolpathMove[] = []
  for (let i = 0; i < n; i++) {
    moves.push(cut(recentred[i], recentred[i + 1]))
  }

  const result = fitArcsInMachineMoves(moves, TOL, MAX_DEG)
  const arcs = result.filter(d => d.kind === 'arc')
  assert(arcs.length === 0, `near-collinear run (0.25° sweep) must produce no arcs, got ${arcs.length}`)
  assert(result.length === n, `all ${n} moves should remain as linear`)
}

// ── near-collinear: accepted ordinary circular arc ──────────────

function testAcceptsOrdinaryCircularArcAfterCollinearGate(): void {
  console.log('Testing that ordinary circular arcs still pass the collinearity gate...')

  // A 30° arc on R=5 — total sweep ≈ 0.524 rad, well above the 0.5° threshold.
  const r = 5
  const n = 4
  const totalSweep = Math.PI / 6  // 30°
  const points: ToolpathPoint[] = []
  for (let i = 0; i <= n; i++) {
    const angle = totalSweep * i / n
    points.push(pt(r * Math.cos(angle), r * Math.sin(angle), 0))
  }
  const moves: ToolpathMove[] = []
  for (let i = 0; i < n; i++) {
    moves.push(cut(points[i], points[i + 1]))
  }

  const result = fitArcsInMachineMoves(moves, TOL, MAX_DEG)
  const arcs = result.filter(d => d.kind === 'arc')
  // 30° fits in one ≤90° segment.
  assert(arcs.length === 1, `expected 1 arc for 30° sweep, got ${arcs.length}`)
}

// ── partial-run: full circular chord loop ──────────────────────

function testFullCircularChordLoop(): void {
  console.log('Testing full circular chord loop (partial-run regression)...')

  // 16 chord segments forming a full circle of radius 10 at (0,0).
  // Every point is on the circle — the entire run should fit as arcs.
  const r = 10
  const n = 16
  const points: ToolpathPoint[] = []
  for (let i = 0; i <= n; i++) {
    const angle = (Math.PI * 2 * i) / n
    points.push(pt(r * Math.cos(angle), r * Math.sin(angle), 0))
  }
  const moves: ToolpathMove[] = []
  for (let i = 0; i < n; i++) {
    moves.push(cut(points[i], points[i + 1]))
  }

  const result = fitArcsInMachineMoves(moves, TOL, MAX_DEG)
  const arcs = result.filter(d => d.kind === 'arc')

  // Full circle → 4 × 90° sub-arcs. No linear moves should remain.
  assert(arcs.length === 4, `expected 4 arc segments for full circle, got ${arcs.length}`)
  const linears = result.filter(d => d.kind === 'linear')
  assert(linears.length === 0, `expected 0 linear descriptors, got ${linears.length}`)
}

// ── partial-run: arc sub-run with straight leads/trails ─────────

function testPartialArcWithStraightLeads(): void {
  console.log('Testing partial circular sub-run with straight lead/trail cuts...')

  // 3 straight moves (lead-in along X axis), then 8 chord segments
  // forming a 180° arc (radius 10), then 3 more straight moves (lead-out).
  const r = 10

  // Lead-in: 3 straight segments from (-15, 0) to (r, 0).
  const leadIn: ToolpathMove[] = [
    cut(pt(-15, 0, 0), pt(-10, 0, 0)),
    cut(pt(-10, 0, 0), pt(-5, 0, 0)),
    cut(pt(-5, 0, 0), pt(r, 0, 0)),
  ]

  // 180° arc from angle 0 to π (8 chord segments).
  const arcN = 8
  const arcPoints: ToolpathPoint[] = []
  for (let i = 0; i <= arcN; i++) {
    const angle = (Math.PI * i) / arcN
    arcPoints.push(pt(r * Math.cos(angle), r * Math.sin(angle), 0))
  }
  const arcMoves: ToolpathMove[] = []
  for (let i = 0; i < arcN; i++) {
    arcMoves.push(cut(arcPoints[i], arcPoints[i + 1]))
  }

  // Lead-out: 3 straight segments from (-r, 0) going further left.
  const leadOut: ToolpathMove[] = [
    cut(pt(-r, 0, 0), pt(-13, 0, 0)),
    cut(pt(-13, 0, 0), pt(-16, 0, 0)),
    cut(pt(-16, 0, 0), pt(-19, 0, 0)),
  ]

  const allMoves = [...leadIn, ...arcMoves, ...leadOut]
  const result = fitArcsInMachineMoves(allMoves, TOL, MAX_DEG)

  // The arc portion (180°) should fit in 2 × ≤90° sub-arcs.
  const arcs = result.filter(d => d.kind === 'arc')
  assert(arcs.length === 2, `expected 2 arc segments for 180°, got ${arcs.length}`)

  // Lead-in (3) + lead-out (3) + any linear portions within the run = 6 linear.
  // The arc run's first move starts at (r,0) = leadIn[2].to, so those 3 lead-in
  // moves stay linear. Similarly the 3 lead-out moves after the arc stay linear.
  const linears = result.filter(d => d.kind === 'linear')
  assert(linears.length === 6, `expected 6 linear moves (3 lead-in + 3 lead-out), got ${linears.length}`)

  // Verify the arc centre is at origin.
  if (arcs[0] && arcs[0].kind === 'arc') {
    const cx = arcs[0].startPoint.x + arcs[0].centerOffsets.i
    const cy = arcs[0].startPoint.y + arcs[0].centerOffsets.j
    assert(Math.abs(cx) < 1e-6 && Math.abs(cy) < 1e-6,
      `expected arc centre at (0,0), got (${cx}, ${cy})`)
  }

  // Verify the endpoints: arc should start at lead-in end and finish at lead-out start.
  const firstArc = arcs[0]
  const lastArc = arcs[arcs.length - 1]
  if (firstArc && firstArc.kind === 'arc') {
    assert(pointsEq(firstArc.startPoint, pt(r, 0, 0)),
      `first arc should start at (${r}, 0, 0)`)
  }
  if (lastArc && lastArc.kind === 'arc') {
    assert(pointsEq(lastArc.endPoint, pt(-r, 0, 0)),
      `last arc should end at (${-r}, 0, 0)`)
  }

  // All leads should be linear cut moves.
  for (const d of linears) {
    assert(d.kind === 'linear' && d.moveKind === 'cut',
      'lead moves must be linear cuts')
  }
}

function pointsEq(a: ToolpathPoint, b: ToolpathPoint, eps = 1e-6): boolean {
  return Math.abs(a.x - b.x) <= eps
    && Math.abs(a.y - b.y) <= eps
    && Math.abs(a.z - b.z) <= eps
}

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
testSplitArcOffsetsRelative()
testRejectsPlanarWithZChangingFirstCut()
testRejectsNearCollinearRun()
testAcceptsOrdinaryCircularArcAfterCollinearGate()
testFullCircularChordLoop()
testPartialArcWithStraightLeads()

console.log('arcFitting tests passed')
