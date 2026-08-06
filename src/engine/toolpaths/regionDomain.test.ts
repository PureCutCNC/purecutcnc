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

import type { Point } from '../../types/project'
import { DEFAULT_CLIPPER_SCALE } from './geometry'
import { differenceClipperPaths, intersectClipperPaths, offsetClipperPaths } from './modelProtection'
import { buildMaskFromClipperPaths, type RegionMask } from './regions'
import { resolveRegionDomainArea, resolveRegionDomainCurve } from './regionDomain'
import type { ClipperPath } from './types'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(left: number, right: number, epsilon = 1e-9): boolean {
  return Math.abs(left - right) <= epsilon
}

function samePoint(left: Point, right: Point): boolean {
  return approx(left.x, right.x) && approx(left.y, right.y)
}

function clipperPath(points: Point[]): ClipperPath {
  return points.map((p) => ({ X: Math.round(p.x * DEFAULT_CLIPPER_SCALE), Y: Math.round(p.y * DEFAULT_CLIPPER_SCALE) }))
}

function clipperPaths(pointArrays: Point[][]): ClipperPath[] {
  return pointArrays.map(clipperPath)
}

/** Build a simple closed rectangle guide (CCW, no repeated closing vertex). */
function rect(x0: number, y0: number, x1: number, y1: number): Point[] {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ]
}

/** Build a ClipperPath rectangle (CCW). */
function rectClipper(x0: number, y0: number, x1: number, y1: number): ClipperPath {
  return clipperPath(rect(x0, y0, x1, y1))
}

/**
 * Minimal RegionMask for tests.  Only `entries` and the function-typed
 * `containsPoint` are required by the interface; the resolver only reads
 * `entries`.
 */
function regionMask(
  entries: Array<{ mode: 'include' | 'exclude'; paths: ClipperPath[] }>,
): RegionMask {
  const hasIncludeRegions = entries.some((e) => e.mode === 'include')
  return {
    paths: hasIncludeRegions ? entries.filter((e) => e.mode === 'include').flatMap((e) => e.paths) : [],
    hasIncludeRegions,
    excludePaths: entries.filter((e) => e.mode === 'exclude').flatMap((e) => e.paths),
    boundaryPaths: entries.flatMap((e) => e.paths),
    baseIncludesSubject: entries.length > 0 && entries[0].mode === 'exclude',
    entries,
    containsPoint: () => false,
  }
}

/**
 * Convenience: single-entry exclude mask.
 */
function excludeMask(paths: ClipperPath[]): RegionMask {
  return regionMask([{ mode: 'exclude', paths }])
}

// ---------------------------------------------------------------------------
// resolveRegionDomainArea
// ---------------------------------------------------------------------------

/** Null mask returns the input domain by reference. */
function testAreaNullMaskReturnsDomainByReference(): void {
  const domain = [rectClipper(0, 0, 10, 10)]
  const result = resolveRegionDomainArea(domain, null, 2)
  assert(result === domain, 'null mask must return the domain argument by reference')
}

/** Null mask with empty domain returns the (empty) domain by reference. */
function testAreaNullMaskEmptyDomain(): void {
  const domain: ClipperPath[] = []
  const result = resolveRegionDomainArea(domain, null, 2)
  assert(result === domain, 'null mask with empty domain must return by reference')
  assert(result.length === 0, 'returned empty array')
}

/** Empty domain with a mask returns empty. */
function testAreaEmptyDomainWithMask(): void {
  const region = clipperPaths([rect(0, 0, 10, 10)])
  const mask = buildMaskFromClipperPaths(region)
  const result = resolveRegionDomainArea([], mask, 2)
  assert(result.length === 0, 'empty domain with mask returns empty')
}

/**
 * Area include: after the generator's own erosion by r, the tool centre
 * reaches the region boundary and no further.
 *
 *   D ∩ (R ⊕ r) eroded by r  =  (D ⊖ r) ∩ R
 */
function testAreaIncludePreDialation(): void {
  const domain = [rectClipper(0, 0, 20, 20)]                  // D = 20×20
  const region = clipperPaths([rect(4, 4, 16, 16)])            // R = 12×12 centred
  const r = 2

  const mask = buildMaskFromClipperPaths(region)
  assert(mask !== null, 'include mask built')

  const resolved = resolveRegionDomainArea(domain, mask!, r)
  assert(resolved.length > 0, 'include does not collapse the domain')

  // Generator erodes by r.
  const eroded = offsetClipperPaths(resolved, -r)
  assert(eroded.length > 0, 'eroded result is non-empty')

  // Expected: (D ⊖ r) ∩ R
  const erodedDomain = offsetClipperPaths(domain, -r)
  const expected = intersectClipperPaths(erodedDomain, region)

  // The morphological closing fills concave notches narrower than r but the
  // bulk of the shape must match.
  const diffFromExpected = differenceClipperPaths(eroded, expected)
  const diffFromActual = differenceClipperPaths(expected, eroded)
  // With a convex region and convex domain the match should be exact.
  assert(diffFromExpected.length === 0, 'eroded result is subset of (D⊖r)∩R')
  assert(diffFromActual.length === 0, '(D⊖r)∩R is subset of eroded result')
}

/**
 * Area exclude: the raw region is subtracted.  After the generator's erosion
 * by r the tool centre stays at least r clear of the exclude region.
 */
function testAreaExcludeRawSubtraction(): void {
  const domain = [rectClipper(0, 0, 20, 20)]                  // D = 20×20
  const excludePath = clipperPaths([rect(8, 8, 12, 12)])      // X = 4×4 hole
  const r = 2

  const mask = excludeMask(excludePath)

  const resolved = resolveRegionDomainArea(domain, mask, r)
  assert(resolved.length > 0, 'exclude leaves a non-empty domain')

  // The exclude region itself must be absent.
  const overlapWithX = intersectClipperPaths(resolved, excludePath)
  assert(overlapWithX.length === 0, 'resolved domain does not overlap the exclude region')

  // The resolved domain should be exactly D \ X.
  const diff = differenceClipperPaths(domain, excludePath)
  const extra = differenceClipperPaths(resolved, diff)
  const missing = differenceClipperPaths(diff, resolved)
  assert(extra.length === 0, 'resolved domain is subset of D\\X')
  assert(missing.length === 0, 'D\\X is subset of resolved domain')

  // After the generator erodes by r the tool centre must stay outside X.
  const eroded = offsetClipperPaths(resolved, -r)
  const erodedInX = intersectClipperPaths(eroded, excludePath)
  assert(erodedInX.length === 0, 'tool centre after erosion does not enter X')
}

/**
 * Include with centreInset = 0 adds the region raw (no dilation).
 */
function testAreaIncludeZeroInset(): void {
  const domain = [rectClipper(0, 0, 20, 20)]
  const region = clipperPaths([rect(4, 4, 16, 16)])
  const mask = buildMaskFromClipperPaths(region)
  assert(mask !== null, 'mask built')

  const resolved = resolveRegionDomainArea(domain, mask!, 0)
  // With zero inset the resolved = D ∩ R = R (since R ⊂ D).
  const expected = region
  const diff = differenceClipperPaths(resolved, expected)
  const missing = differenceClipperPaths(expected, resolved)
  assert(diff.length === 0, 'resolved equals region when inset is 0')
  assert(missing.length === 0, 'region equals resolved when inset is 0')
}

/**
 * Region narrower than the tool: the include intersection collapses.
 */
function testAreaIncludeRegionNarrowerThanTool(): void {
  const domain = [rectClipper(0, 0, 20, 20)]
  // A thin vertical strip 0.5 wide — after dilation by r=2 it's 4.5 wide and
  // still fits in D, so the result is the dilated strip intersected with D.
  const region = clipperPaths([rect(9.75, 0, 10.25, 20)])
  const mask = buildMaskFromClipperPaths(region)
  assert(mask !== null, 'mask built')

  const r = 2
  const resolved = resolveRegionDomainArea(domain, mask!, r)
  // After dilation the strip is (9.75-2, 0, 10.25+2, 20) = (7.75, 0, 12.25, 20)
  // which is inside D, so result is non-empty.
  assert(resolved.length > 0, 'dilated thin region stays inside D')

  // A 0.1-wide strip with r=2: the dilation makes it 4.1 wide, still inside D.
  const tinyRegion = clipperPaths([rect(9.95, 0, 10.05, 20)])
  const tinyMask = buildMaskFromClipperPaths(tinyRegion)
  assert(tinyMask !== null, 'tiny mask built')
  const tinyResult = resolveRegionDomainArea(domain, tinyMask!, r)
  assert(tinyResult.length > 0, 'even a 0.1-wide region dilates to a non-empty strip')
}

/**
 * Fully-excluded domain: when the entire domain is excluded, the result is empty.
 */
function testAreaFullyExcluded(): void {
  const domain = [rectClipper(0, 0, 10, 10)]
  const bigExclude = clipperPaths([rect(-1, -1, 11, 11)])  // covers D entirely
  const mask = excludeMask(bigExclude)

  const resolved = resolveRegionDomainArea(domain, mask, 0)
  assert(resolved.length === 0, 'wholly-excluded domain returns empty')
}

/**
 * Ordered composition — include then exclude.
 *
 * Start empty → union R1 → difference X1 → intersect D.
 */
function testAreaOrderedIncludeThenExclude(): void {
  const domain = [rectClipper(0, 0, 20, 20)]
  const r = 2
  const r1 = clipperPaths([rect(2, 2, 18, 18)])   // large include
  const x1 = clipperPaths([rect(14, 2, 18, 18)])   // exclude the right strip

  const mask = regionMask([
    { mode: 'include', paths: r1 },
    { mode: 'exclude', paths: x1 },
  ])

  const resolved = resolveRegionDomainArea(domain, mask, r)
  assert(resolved.length > 0, 'include-then-exclude is non-empty')

  // After include: (2-r, 2-r, 18+r, 18+r) = (0, 0, 20, 20) inside D.
  // After exclude: subtract the raw right strip (14,2)-(18,18).
  // The right portion (14,2)-(18,18) is removed from the domain.
  const excludeOverlap = intersectClipperPaths(resolved, x1)
  assert(excludeOverlap.length === 0, 'excluded area is absent from result')
}

/**
 * Ordered composition — exclude then include.
 *
 * Start from D → subtract X1 → union (R1 ⊕ r) → intersect D.
 * Different from include-then-exclude because the include adds back.
 */
function testAreaOrderedExcludeThenInclude(): void {
  const domain = [rectClipper(0, 0, 20, 20)]
  const r = 2
  const x1 = clipperPaths([rect(4, 4, 16, 16)])   // exclude a big middle block
  const r1 = clipperPaths([rect(8, 8, 12, 12)])   // include back a smaller block
  // After exclude-then-include:
  //   Start: D
  //   Exclude: D \ X1 = border frame around the middle
  //   Include: (D \ X1) ∪ (R1 ⊕ r) = border ∪ dilated(R1)
  //   R1 ⊕ r = (8-2,8-2,12+2,12+2) = (6,6,14,14)
  //   Intersect with D → unchanged since everything is inside D.
  //   Result: border frame ∪ dilated(R1) — the include adds back part of X1.
  const mask = regionMask([
    { mode: 'exclude', paths: x1 },
    { mode: 'include', paths: r1 },
  ])

  const resolved = resolveRegionDomainArea(domain, mask, r)
  assert(resolved.length > 0, 'exclude-then-include is non-empty')

  // The dilated include block (offset by r=2) must be present.
  const dilatedR1 = offsetClipperPaths(r1, r)
  const includeOverlap = intersectClipperPaths(resolved, dilatedR1)
  assert(includeOverlap.length > 0, 'dilated include region is present in result')

  // Now compare with include-then-exclude over the SAME regions:
  // include-then-exclude: ∅ ∪ (R1⊕r) \ X1 = (R1⊕r) \ X1 = dilatedR1 minus x1
  // x1 covers (4,4)-(16,16), dilatedR1 is (6,6)-(14,14) — fully inside x1
  // So dilatedR1 \ x1 = ∅ → empty result!
  const maskItE = regionMask([
    { mode: 'include', paths: r1 },
    { mode: 'exclude', paths: x1 },
  ])
  const resolvedItE = resolveRegionDomainArea(domain, maskItE, r)
  assert(resolvedItE.length === 0, 'include-then-exclude with big exclude swallows the include')
}

// ---------------------------------------------------------------------------
// resolveRegionDomainCurve
// ---------------------------------------------------------------------------

/** Null mask returns the whole guide as a single fragment. */
function testCurveNullMaskReturnsWholeGuide(): void {
  const guide = rect(2, 2, 8, 8)
  const result = resolveRegionDomainCurve(guide, true, null, 2)
  assert(result.length === 1, 'null mask returns one fragment')
  assert(result[0].closed, 'closed guide stays closed')
  assert(result[0].points.length === 4, 'original point count preserved')
  assert(samePoint(result[0].points[0], guide[0]), 'start point preserved')
}

/** Null mask with open guide returns a single open fragment. */
function testCurveNullMaskOpenGuide(): void {
  const guide = [{ x: 0, y: 0 }, { x: 10, y: 10 }]
  const result = resolveRegionDomainCurve(guide, false, null, 2)
  assert(result.length === 1, 'null mask returns one fragment for open guide')
  assert(!result[0].closed, 'open guide stays open')
  assert(samePoint(result[0].points[0], guide[0]), 'start point preserved')
  assert(samePoint(result[0].points[1], guide[1]), 'end point preserved')
}

/**
 * Curve include: keep guide inside the dilated include region.
 * A guide entirely inside stays a single closed fragment.
 */
function testCurveIncludeInsideKeepsSpans(): void {
  // Guide is a 10×10 square, region is a 20×20 square — guide is fully inside.
  const guide = rect(5, 5, 15, 15)
  const region = clipperPaths([rect(0, 0, 20, 20)])
  const r = 2
  const mask = buildMaskFromClipperPaths(region)
  assert(mask !== null, 'mask built')

  const result = resolveRegionDomainCurve(guide, true, mask!, r)
  assert(result.length === 1, 'fully-contained guide returns one fragment')
  assert(result[0].closed, 'fully-contained closed guide stays closed')
  // The guide should survive intact — all its points are well inside the dilated region.
  assert(result[0].points.length >= 4, 'all guide vertices preserved')
}

/**
 * Curve include: a guide that only partially overlaps the dilated region
 * produces only the inside span(s).
 */
function testCurveIncludePartialOverlap(): void {
  // Guide straddles the right edge of the dilated region.
  const guide = rect(0, 0, 20, 10)
  const region = clipperPaths([rect(0, 0, 10, 10)])        // left half
  const r = 2                                              // region dilates to (-2,-2,12,12)
  const mask = buildMaskFromClipperPaths(region)
  assert(mask !== null, 'mask built')

  const result = resolveRegionDomainCurve(guide, true, mask!, r)
  assert(result.length > 0, 'partial overlap produces at least one span')

  // The result must be open (cut at the mask boundary).
  for (const frag of result) {
    assert(!frag.closed, 'partial-overlap fragments are open')
    for (const pt of frag.points) {
      // Each point must be inside the dilated region.
      assert(pt.x <= 12 + 1e-9, `point x=${pt.x} is inside dilated region`)
    }
  }
}

/**
 * Curve exclude: keep guide outside the dilated exclude region.
 */
function testCurveExcludeOutsideKeepsSpans(): void {
  const guide = rect(0, 0, 20, 20)
  // Exclude a block in the middle.
  const excludePath = clipperPaths([rect(8, 8, 12, 12)])
  const r = 2
  const mask = excludeMask(excludePath)

  const result = resolveRegionDomainCurve(guide, true, mask, r)

  // The exclude creates a hole in the composite mask.  The guide goes around
  // the hole, producing at least one open fragment.
  assert(result.length >= 1, 'exclude split produces fragment(s)')
  for (const frag of result) {
    assert(frag.points.length >= 2, 'each fragment has at least 2 points')
  }
}

/**
 * Curve include then exclude: the composite is (A⊕r) \ (B⊕r).
 * The guide is split inside this composite.
 */
function testCurveOrderedIncludeThenExclude(): void {
  // Guide: 20×20 rectangle.  Include the left half, exclude a top-right block.
  // The include dilates to (-2,-2)-(12,22); the exclude dilates to (8,8)-(22,22).
  // Composite = (-2,-2)-(12,22) \ (8,8)-(22,22) = L-shape.
  // The guide edges cross the composite boundary so fragments are open.
  const guide = rect(0, 0, 20, 10)
  const r = 2
  const includePath = clipperPaths([rect(0, 0, 10, 10)])   // left half
  const excludePath = clipperPaths([rect(8, 8, 20, 20)])   // top-right corner

  const mask = regionMask([
    { mode: 'include', paths: includePath },
    { mode: 'exclude', paths: excludePath },
  ])

  const result = resolveRegionDomainCurve(guide, true, mask, r)
  assert(result.length > 0, 'include-then-exclude curve produces spans')
  // The exclude cuts the top-right off the include, so guide edges are split.
  // At least one fragment must be open.
  const anyOpen = result.some((frag) => !frag.closed)
  assert(anyOpen, 'at least one fragment is open after include-then-exclude split')
}

/**
 * Curve ordered composition: include-then-exclude ≠ exclude-then-include.
 * Uses two partially overlapping regions so the order matters.
 *
 *   A: include (0,0)-(10,10)   (bottom-left quadrant)
 *   B: exclude (5,5)-(15,15)   (overlapping centre)
 *
 * include-then-exclude: keep guide inside A, then remove B
 *  → quadrants inside A \ B = (0,0)-(10,10) minus (5,5)-(10,10)
 *
 * exclude-then-include: remove B from everything, then add A back
 *  → everything outside B ∪ A  (A adds back its area, including A∩B)
 *  → different result: includes area outside A (which include-then-exclude doesn't)
 */
function testCurveOrderedExcludeThenInclude(): void {
  const guide = rect(0, 0, 20, 20)
  const r = 0
  const includeA = clipperPaths([rect(0, 0, 10, 10)])
  const excludeB = clipperPaths([rect(5, 5, 15, 15)])

  // include-then-exclude
  const maskItE = regionMask([
    { mode: 'include', paths: includeA },
    { mode: 'exclude', paths: excludeB },
  ])
  const resultItE = resolveRegionDomainCurve(guide, true, maskItE, r)
  assert(resultItE.length > 0, 'include-then-exclude is non-empty')

  // exclude-then-include
  const maskEtI = regionMask([
    { mode: 'exclude', paths: excludeB },
    { mode: 'include', paths: includeA },
  ])
  const resultEtI = resolveRegionDomainCurve(guide, true, maskEtI, r)
  assert(resultEtI.length > 0, 'exclude-then-include is non-empty')

  // The two orderings produce different fragment counts because
  // exclude-then-include keeps spans outside B (more of the guide)
  // while include-then-exclude only keeps spans inside A \ B.
  const totalVerticesItE = resultItE.reduce((sum, f) => sum + f.points.length, 0)
  const totalVerticesEtI = resultEtI.reduce((sum, f) => sum + f.points.length, 0)
  assert(
    totalVerticesEtI > totalVerticesItE,
    `exclude-then-include should produce more guide area than include-then-exclude (${totalVerticesEtI} vs ${totalVerticesItE})`,
  )
}

/**
 * Empty guide with a mask returns empty.
 */
function testCurveEmptyGuide(): void {
  const region = clipperPaths([rect(0, 0, 10, 10)])
  const mask = buildMaskFromClipperPaths(region)
  assert(mask !== null, 'mask built')

  const result = resolveRegionDomainCurve([], true, mask!, 2)
  assert(result.length === 0, 'empty guide returns empty')
}

/**
 * Open guide with include mask keeps only the inside spans.
 */
function testCurveOpenGuideInclude(): void {
  const guide = [{ x: 0, y: 5 }, { x: 20, y: 5 }]  // horizontal line
  const region = clipperPaths([rect(2, 2, 8, 8)])   // region from (2,2) to (8,8)
  const r = 0
  const mask = buildMaskFromClipperPaths(region)
  assert(mask !== null, 'mask built')

  const result = resolveRegionDomainCurve(guide, false, mask!, r)
  assert(result.length === 1, 'open guide with include mask gives one span')
  assert(!result[0].closed, 'open guide fragment is open')
  // The span should be from x≈2 to x≈8 (inside the region).
  const pts = result[0].points
  assert(pts.length >= 2, 'fragment has at least two points')
  assert(approx(pts[0].x, 2, 0.01), `start x ≈ 2, got ${pts[0].x}`)
  assert(approx(pts.at(-1)!.x, 8, 0.01), `end x ≈ 8, got ${pts.at(-1)!.x}`)
}

/**
 * Open guide with exclude mask keeps only the outside spans.
 */
function testCurveOpenGuideExclude(): void {
  const guide = [{ x: 0, y: 5 }, { x: 20, y: 5 }]  // horizontal line
  const excludePath = clipperPaths([rect(4, 2, 6, 8)])  // exclude from (4,2) to (6,8)
  const r = 0
  const mask = excludeMask(excludePath)

  const result = resolveRegionDomainCurve(guide, false, mask, r)
  assert(result.length === 2, 'open guide with exclude mask gives two spans')
  // First span: (0,5) to (≈4,5)
  // Second span: (≈6,5) to (20,5)
  for (const frag of result) {
    assert(!frag.closed, 'exclude fragments are open')
  }
}

/**
 * Degenerate: mask whose composition collapses to nothing → empty result.
 * A fully-excluded guide region leaves no spans.
 */
function testCurveDegenerateCollapse(): void {
  const guide = rect(0, 0, 10, 10)
  // Exclude a block larger than the guide — nothing survives.
  const bigExclude = clipperPaths([rect(-10, -10, 20, 20)])
  const mask = excludeMask(bigExclude)
  const result = resolveRegionDomainCurve(guide, true, mask, 0)
  // The entire guide is inside the excluded region → no spans survive.
  assert(result.length === 0, 'wholly-excluded curve returns empty')
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

function run(): void {
  // Area
  testAreaNullMaskReturnsDomainByReference()
  testAreaNullMaskEmptyDomain()
  testAreaEmptyDomainWithMask()
  testAreaIncludePreDialation()
  testAreaExcludeRawSubtraction()
  testAreaIncludeZeroInset()
  testAreaIncludeRegionNarrowerThanTool()
  testAreaFullyExcluded()
  testAreaOrderedIncludeThenExclude()
  testAreaOrderedExcludeThenInclude()

  // Curve
  testCurveNullMaskReturnsWholeGuide()
  testCurveNullMaskOpenGuide()
  testCurveIncludeInsideKeepsSpans()
  testCurveIncludePartialOverlap()
  testCurveExcludeOutsideKeepsSpans()
  testCurveOrderedIncludeThenExclude()
  testCurveOrderedExcludeThenInclude()
  testCurveEmptyGuide()
  testCurveOpenGuideInclude()
  testCurveOpenGuideExclude()
  testCurveDegenerateCollapse()
}

run()
