/**
 * Tests for simplifyOffsetContour — the post-Clipper-offset arc/circle fitting
 * pass. Each test runs Clipper offset on a synthesized source profile, hands
 * the result through simplifyOffsetContour, and asserts:
 *
 *   • the output is closed and well-formed (segment endpoints chain),
 *   • the vertex count drops meaningfully vs the raw offset polyline,
 *   • arcs are only emitted when concentric with a source arc/circle,
 *   • the arc sweep direction matches what the renderer expects (so the long
 *     side of the arc renders, not its short complement).
 *
 * Run with: npx tsx src/store/helpers/offsetSimplify.test.ts
 */

import {
  flattenFeatureToClipperPath,
  offsetClipperPaths,
  simplifyOffsetContour,
  unionClipperPaths,
} from './clipping'
import { sampleProfilePoints } from '../../types/project'
import type { Point, Segment, SketchFeature, SketchProfile } from '../../types/project'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approxEq(a: number, b: number, eps: number): boolean {
  return Math.abs(a - b) <= eps
}

function pointsApprox(a: Point, b: Point, eps: number): boolean {
  return approxEq(a.x, b.x, eps) && approxEq(a.y, b.y, eps)
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function makeFeature(profile: SketchProfile, name = 'F'): SketchFeature {
  return {
    id: name,
    name,
    kind: 'polygon',
    folderId: null,
    sketch: { profile, origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: 'add',
    z_top: { value: 0.75 },
    z_bottom: { value: 0 },
    visible: true,
    locked: false,
  } as unknown as SketchFeature
}

interface ProfileSummary {
  segCount: number
  arcCount: number
  circleCount: number
  lineCount: number
  arcCenters: Point[]
}

function summarize(profile: SketchProfile): ProfileSummary {
  const arcs: Point[] = []
  let arcCount = 0
  let circleCount = 0
  let lineCount = 0
  for (const seg of profile.segments) {
    if (seg.type === 'arc') {
      arcCount += 1
      arcs.push(seg.center)
    } else if (seg.type === 'circle') {
      circleCount += 1
      arcs.push(seg.center)
    } else if (seg.type === 'line') {
      lineCount += 1
    }
  }
  return { segCount: profile.segments.length, arcCount, circleCount, lineCount, arcCenters: arcs }
}

// ── Structural assertions every simplified profile must satisfy ──────────────

function assertStructurallyValid(profile: SketchProfile, label: string): void {
  assert(profile.closed === true, `${label}: profile.closed must be true`)
  assert(profile.segments.length >= 1, `${label}: need at least 1 segment`)

  // Each segment's `to` is the start of the next segment. The last segment's
  // `to` must coincide with profile.start (closure).
  let cursor: Point = profile.start
  for (let i = 0; i < profile.segments.length; i += 1) {
    const seg = profile.segments[i]
    const nextStart = seg.to
    // Detect zero-length segments — they're a sign of a buggy merge.
    assert(
      dist(cursor, nextStart) > 1e-9 || (seg.type === 'circle'),
      `${label}: zero-length segment at index ${i} (${seg.type})`,
    )
    cursor = nextStart
  }
  assert(
    pointsApprox(cursor, profile.start, 1e-6),
    `${label}: last segment endpoint ${JSON.stringify(cursor)} doesn't return to start ${JSON.stringify(profile.start)}`,
  )
}

// Verify each arc's rendered sweep covers the polyline it replaced, not the
// complement. We do this by re-sampling the arc the same way the renderer does
// and checking that the resulting polyline closely follows the source contour.
function assertArcSweepMatchesSource(
  simplified: SketchProfile,
  sourceFlattened: Point[],
  label: string,
): void {
  // Re-sample the simplified profile back to a polyline using the project's
  // canonical sampler — this is what every renderer/exporter ends up doing.
  const resampled = sampleProfilePoints(simplified)
  assert(resampled.length >= 4, `${label}: resampled polyline too small`)

  // For every resampled point, find the nearest point on the source-flattened
  // polyline and accumulate the worst-case distance. A correct arc fit should
  // resample within a small tolerance of the source offset (offsets of arcs
  // are concentric, so the polyline sits on the same circle).
  const bbox = bboxOf(sourceFlattened)
  const diag = Math.hypot(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY)
  let maxDeviation = 0
  for (const p of resampled) {
    let minDist = Infinity
    for (const sp of sourceFlattened) {
      const d = dist(p, sp)
      if (d < minDist) minDist = d
    }
    if (minDist > maxDeviation) maxDeviation = minDist
  }

  // The flattener uses arcStepRadians = π/36 ≈ 5°, with chord length R·2·sin(2.5°).
  // The source polyline is discrete, so resampled arc points can land between
  // adjacent source vertices. Allow up to 5% of the bounding-box diagonal —
  // generous enough to handle that discretisation, tight enough to catch a
  // wrong-direction arc (which would deviate by ~the full bbox).
  assert(
    maxDeviation < diag * 0.05,
    `${label}: arc resample deviates ${maxDeviation.toFixed(4)} from source (>${(diag * 0.05).toFixed(4)}) — probable wrong-direction arc`,
  )
}

function bboxOf(points: Point[]): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  return { minX, maxX, minY, maxY }
}

// ── Helpers for running a full offset+simplify scenario ──────────────────────

interface ScenarioResult {
  rawVertexCount: number
  profile: SketchProfile
  summary: ProfileSummary
  sourceFlattened: Point[]
}

function runOffset(sources: SketchFeature[], delta: number): ScenarioResult {
  const scale = 1000
  const paths = sources.map((s) => flattenFeatureToClipperPath(s))
  const unioned = unionClipperPaths(paths)
  const offsetPaths = offsetClipperPaths(unioned, delta * scale)
  assert(offsetPaths.length > 0, 'offsetClipperPaths returned no paths')
  // Use the largest path (the outer offset boundary).
  let best = offsetPaths[0]
  for (const p of offsetPaths) if (p.length > best.length) best = p
  const profile = simplifyOffsetContour(best, sources, delta)
  assert(profile !== null, 'simplifyOffsetContour returned null')
  // Use the union of all source points as the "source polyline" — what the
  // offset arc should hug (concentrically expanded/contracted, but for
  // structural sanity we just need a per-arc proximity check).
  const sourcePts: Point[] = []
  for (const s of sources) sourcePts.push(...sampleProfilePoints(s.sketch.profile))
  return {
    rawVertexCount: best.length,
    profile: profile!,
    summary: summarize(profile!),
    sourceFlattened: sourcePts,
  }
}

// ── Test scenarios ───────────────────────────────────────────────────────────

console.log('── pure circle ──')
{
  const F = makeFeature({
    start: { x: 10, y: 0 },
    segments: [{ type: 'circle', to: { x: 10, y: 0 }, center: { x: 0, y: 0 }, clockwise: false }],
    closed: true,
  } as SketchProfile)
  const r = runOffset([F], 2)
  assertStructurallyValid(r.profile, 'pure-circle')
  assert(r.summary.circleCount === 1, `expected one circle segment, got ${JSON.stringify(r.summary)}`)
  assert(r.summary.segCount === 1, `expected 1 segment total, got ${r.summary.segCount}`)
  const centerPt = (r.profile.segments[0] as Extract<Segment, { type: 'circle' }>).center
  assert(dist(centerPt, { x: 0, y: 0 }) < 0.01, `circle center off: ${JSON.stringify(centerPt)}`)
  console.log(`  PASS — ${r.rawVertexCount} verts → 1 circle (center error ${dist(centerPt, { x: 0, y: 0 }).toExponential(2)})`)
}

console.log('── half circle (arc + diameter) ──')
{
  const F = makeFeature({
    start: { x: 0, y: 10 },
    segments: [
      { type: 'arc', to: { x: 0, y: -10 }, center: { x: 0, y: 0 }, clockwise: false },
      { type: 'line', to: { x: 0, y: 10 } },
    ],
    closed: true,
  } as SketchProfile)
  const r = runOffset([F], 1)
  assertStructurallyValid(r.profile, 'half-circle')
  assert(r.summary.arcCount >= 1, `expected at least one arc, got ${JSON.stringify(r.summary)}`)
  // The arc center should match the source circle center (0,0).
  for (const c of r.summary.arcCenters) {
    assert(dist(c, { x: 0, y: 0 }) < 0.01, `arc center wandered: ${JSON.stringify(c)}`)
  }
  assertArcSweepMatchesSource(r.profile, r.sourceFlattened, 'half-circle')
  console.log(`  PASS — ${r.rawVertexCount} verts → ${r.summary.segCount} segs (${r.summary.arcCount} arc + ${r.summary.lineCount} line)`)
}

console.log('── pac-man (circle with wedge cut) ──')
{
  // Pac-man: an arc from 30° CCW around to -30° (i.e. the big 300° arc),
  // then two lines forming the wedge mouth meeting at the centre.
  const R = 10
  const wedgeAngle = Math.PI / 6 // 30° half-angle → 60° wedge mouth
  const top: Point = { x: R * Math.cos(wedgeAngle), y: R * Math.sin(wedgeAngle) }
  const bottom: Point = { x: R * Math.cos(-wedgeAngle), y: R * Math.sin(-wedgeAngle) }
  const F = makeFeature({
    start: top,
    segments: [
      // Big arc going the long way around (CCW) from top to bottom.
      { type: 'arc', to: bottom, center: { x: 0, y: 0 }, clockwise: false },
      { type: 'line', to: { x: 0, y: 0 } },
      { type: 'line', to: top },
    ],
    closed: true,
  } as SketchProfile)
  const r = runOffset([F], 1)
  assertStructurallyValid(r.profile, 'pac-man')
  assert(r.summary.arcCount >= 1, `expected an arc for the main body, got ${JSON.stringify(r.summary)}`)
  // Every fitted arc must be concentric with the source circle.
  for (const c of r.summary.arcCenters) {
    assert(dist(c, { x: 0, y: 0 }) < 0.05, `pac-man arc center wandered: ${JSON.stringify(c)}`)
  }
  // This is the key regression: the big arc must render as the long way around,
  // not its short complement. assertArcSweepMatchesSource catches the flipped
  // clockwise flag by detecting that the resampled profile leaves the source area.
  assertArcSweepMatchesSource(r.profile, r.sourceFlattened, 'pac-man')
  console.log(`  PASS — ${r.rawVertexCount} verts → ${r.summary.segCount} segs (${r.summary.arcCount} arc + ${r.summary.lineCount} line)`)
}

console.log('── rounded rectangle (4 arcs + 4 lines) ──')
{
  const r0 = 1, W = 10, H = 6
  const F = makeFeature({
    start: { x: r0, y: 0 },
    segments: [
      { type: 'line', to: { x: W - r0, y: 0 } },
      { type: 'arc', to: { x: W, y: r0 }, center: { x: W - r0, y: r0 }, clockwise: false },
      { type: 'line', to: { x: W, y: H - r0 } },
      { type: 'arc', to: { x: W - r0, y: H }, center: { x: W - r0, y: H - r0 }, clockwise: false },
      { type: 'line', to: { x: r0, y: H } },
      { type: 'arc', to: { x: 0, y: H - r0 }, center: { x: r0, y: H - r0 }, clockwise: false },
      { type: 'line', to: { x: 0, y: r0 } },
      { type: 'arc', to: { x: r0, y: 0 }, center: { x: r0, y: r0 }, clockwise: false },
    ],
    closed: true,
  } as SketchProfile)
  const r = runOffset([F], 0.5)
  assertStructurallyValid(r.profile, 'rounded-rect')
  assert(r.summary.arcCount === 4, `expected 4 arcs (one per corner), got ${JSON.stringify(r.summary)}`)
  const expectedCenters = [
    { x: W - r0, y: r0 }, { x: W - r0, y: H - r0 }, { x: r0, y: H - r0 }, { x: r0, y: r0 },
  ]
  for (const c of r.summary.arcCenters) {
    const matched = expectedCenters.some((e) => dist(c, e) < 0.01)
    assert(matched, `rounded-rect arc center ${JSON.stringify(c)} not at any corner`)
  }
  assertArcSweepMatchesSource(r.profile, r.sourceFlattened, 'rounded-rect')
  console.log(`  PASS — ${r.rawVertexCount} verts → ${r.summary.segCount} segs (4 corner arcs)`)
}

console.log('── plain polygon (no source arcs) ──')
{
  const F = makeFeature({
    start: { x: 0, y: 0 },
    segments: [
      { type: 'line', to: { x: 10, y: 0 } },
      { type: 'line', to: { x: 10, y: 10 } },
      { type: 'line', to: { x: 0, y: 10 } },
      { type: 'line', to: { x: 0, y: 0 } },
    ],
    closed: true,
  } as SketchProfile)
  const r = runOffset([F], 1)
  assertStructurallyValid(r.profile, 'polygon')
  assert(r.summary.arcCount === 0, `polygon offset must not invent arcs, got ${JSON.stringify(r.summary)}`)
  assert(r.summary.circleCount === 0, `polygon offset must not invent circles, got ${JSON.stringify(r.summary)}`)
  console.log(`  PASS — ${r.rawVertexCount} verts → ${r.summary.segCount} lines (no false arcs)`)
}

console.log('── slightly-bowed line shouldn\'t fit an arc ──')
{
  // A composite with one real arc plus a polyline edge that's slightly bowed.
  // The bowed edge's least-squares circle is huge and far from any source
  // centre — it must be rejected.
  const segs: Segment[] = []
  for (let i = 1; i <= 60; i += 1) {
    const x = i * 1
    const y = 0.05 * x * (60 - x) * 0.01
    segs.push({ type: 'line', to: { x, y } })
  }
  segs.push({ type: 'line', to: { x: 60, y: 10 } })
  segs.push({ type: 'arc', to: { x: 50, y: 20 }, center: { x: 50, y: 10 }, clockwise: false })
  segs.push({ type: 'line', to: { x: 0, y: 20 } })
  segs.push({ type: 'line', to: { x: 0, y: 0 } })
  const F = makeFeature({ start: { x: 0, y: 0 }, closed: true, segments: segs } as SketchProfile)
  const r = runOffset([F], 0.5)
  assertStructurallyValid(r.profile, 'bowed')
  // Real arc at (50,10) must be recovered.
  assert(r.summary.arcCount >= 1, 'real arc not recovered')
  // No fitted center may be far from the only source center (50,10).
  for (const c of r.summary.arcCenters) {
    assert(dist(c, { x: 50, y: 10 }) < 0.05, `bowed test: fitted arc center wandered to ${JSON.stringify(c)} — false fit`)
  }
  console.log(`  PASS — bowed run stayed polyline, real arc fitted at (50,10)`)
}

console.log('── two overlapping circles unioned then offset ──')
{
  // A "peanut" composite. Both source circles share a single centre line
  // (so their offsets are concentric with two distinct source centres).
  const c1 = makeFeature({
    start: { x: 5, y: 0 },
    segments: [{ type: 'circle', to: { x: 5, y: 0 }, center: { x: 0, y: 0 }, clockwise: false }],
    closed: true,
  } as SketchProfile, 'C1')
  const c2 = makeFeature({
    start: { x: 11, y: 0 },
    segments: [{ type: 'circle', to: { x: 11, y: 0 }, center: { x: 7, y: 0 }, clockwise: false }],
    closed: true,
  } as SketchProfile, 'C2')
  const r = runOffset([c1, c2], 1)
  assertStructurallyValid(r.profile, 'peanut')
  // Each source center may have one or more arc fragments around it; both
  // centers should be represented.
  const hasC1 = r.summary.arcCenters.some((c) => dist(c, { x: 0, y: 0 }) < 0.05)
  const hasC2 = r.summary.arcCenters.some((c) => dist(c, { x: 7, y: 0 }) < 0.05)
  assert(hasC1 && hasC2, `peanut should fit arcs at both centers, got centers ${JSON.stringify(r.summary.arcCenters)}`)
  // No fitted arc may have a wandering center.
  for (const c of r.summary.arcCenters) {
    const nearC1 = dist(c, { x: 0, y: 0 }) < 0.05
    const nearC2 = dist(c, { x: 7, y: 0 }) < 0.05
    assert(nearC1 || nearC2, `peanut: arc center ${JSON.stringify(c)} not concentric with either source`)
  }
  assertArcSweepMatchesSource(r.profile, r.sourceFlattened, 'peanut')
  console.log(`  PASS — ${r.rawVertexCount} verts → ${r.summary.segCount} segs (arcs at both source centres)`)
}

console.log('── dense polyline source (RDP cleanup) ──')
{
  // A wavy closed polyline sampled densely. The shape has no arcs the fitter
  // can recover; RDP should still cut the vertex count substantially without
  // distorting the shape beyond the tolerance budget.
  const segs: Segment[] = []
  const samples = 200
  for (let k = 1; k <= samples; k += 1) {
    const t = (k / samples) * Math.PI * 2
    const r = 10 + Math.sin(t * 3) * 1.5
    segs.push({ type: 'line', to: { x: r * Math.cos(t), y: r * Math.sin(t) } })
  }
  const F = makeFeature({
    start: { x: 10 + Math.sin(0) * 1.5, y: 0 },
    segments: segs,
    closed: true,
  } as SketchProfile, 'wavy')
  const r = runOffset([F], 0.5)
  assertStructurallyValid(r.profile, 'dense-polyline')
  // No source arcs → no arcs should be invented.
  assert(r.summary.arcCount === 0, `dense polyline should not produce arcs, got ${JSON.stringify(r.summary)}`)
  assert(r.summary.circleCount === 0, 'dense polyline should not produce circles')
  // RDP must reduce vertex count substantially — at conservative 0.1% bbox
  // tolerance, a 200-sample wavy circle should drop by at least 30%.
  const reduction = 1 - r.summary.segCount / r.rawVertexCount
  assert(reduction > 0.3, `expected >30% vertex reduction from RDP, got ${(reduction * 100).toFixed(1)}% (${r.rawVertexCount} → ${r.summary.segCount})`)
  // Shape must still approximate the source within the RDP tolerance budget.
  assertArcSweepMatchesSource(r.profile, r.sourceFlattened, 'dense-polyline')
  console.log(`  PASS — ${r.rawVertexCount} verts → ${r.summary.segCount} segs (${(reduction * 100).toFixed(0)}% reduction)`)
}

console.log('\nAll offsetSimplify tests PASS')
