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
 * Focused resolver tests for closed-Line V-carve targets (issue #270 S2).
 *
 * Run with: npx tsx src/engine/toolpaths/vcarveLineResolver.test.ts
 */

import type { Operation, Point, Project, SketchFeature } from '../../types/project'
import { newProject, rectProfile } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import { resolvePocketRegions } from './resolver'
import type { ResolvedPocketRegion } from './types'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

// ── Geometry helpers ──────────────────────────────────────────────────

/** Shoelace formula — absolute area of a simple polygon. */
function polygonArea(points: Point[]): number {
  let area = 0
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length
    area += points[i].x * points[j].y
    area -= points[j].x * points[i].y
  }
  return Math.abs(area) / 2
}

/** Machinable area of a resolved region (outer minus island areas). */
function regionArea(region: ResolvedPocketRegion): number {
  const outerArea = polygonArea(region.outer)
  const islandsArea = region.islands.reduce((sum, island) => sum + polygonArea(island), 0)
  return outerArea - islandsArea
}

function approx(a: number, b: number, epsilon = 0.5): boolean {
  return Math.abs(a - b) < epsilon
}

// ── Feature factories ─────────────────────────────────────────────────

function closedProfile(w: number, h: number, cx = w / 2, cy = h / 2) {
  return rectProfile(cx - w / 2, cy - h / 2, w, h)
}

function openProfile(fromX: number, fromY: number, toX: number, toY: number) {
  return {
    start: { x: fromX, y: fromY },
    segments: [{ type: 'line' as const, to: { x: toX, y: toY } }],
    closed: false,
  }
}

function makeFeature(
  id: string,
  operation: 'subtract' | 'line' | 'add' | 'region',
  profile = closedProfile(20, 20),
  zTop = 5,
  zBottom = 0,
): SketchFeature {
  const isOpen = !profile.closed
  return {
    id,
    name: id,
    kind: isOpen ? 'polygon' : 'rect',
    folderId: null,
    sketch: {
      profile,
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation,
    z_top: zTop,
    z_bottom: zBottom,
    visible: true,
    locked: false,
  }
}

function makeProject(features: SketchFeature[]): Project {
  return projectWithFeatures(newProject(), features)
}

function makeVCarveOp(id: string, featureIds: string[]): Operation {
  return {
    id,
    name: id,
    kind: 'v_carve',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds },
    toolRef: null,
    stepdown: 2,
    stepover: 0.5,
    feed: 100,
    plungeFeed: 50,
    rpm: 10000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: false,
    finishFloor: false,
    carveDepth: 0,
    maxCarveDepth: 0,
  }
}

function makePocketOp(id: string, featureIds: string[]): Operation {
  return { ...makeVCarveOp(id, featureIds), kind: 'pocket' }
}

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`   ✓ ${name}`)
  } catch (err: unknown) {
    failed += 1
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`   ✗ ${name}: ${msg}`)
  }
}

// ═══════════════════════════════════════════════════════════════════════
// S2 REQUIRED REGRESSION: Z-span isolation for candidate island discovery
// ═══════════════════════════════════════════════════════════════════════

test('Z-span isolation: Add island inside inner Line spanning different Z from outer Line must be discovered', () => {
  // Outer Line: 30×30, Z 5→3 (top band only)
  // Inner Line: 10×10 nested at same center, Z 2→0 (bottom band only)
  // Add island: 5×5 inside inner contour, Z 5→0 (spans both bands)
  //
  // The outer and inner Lines are NEVER simultaneously active.  Before the
  // fix the all-depth even-odd union created a center hole that hid the Add
  // island from candidate discovery.  After the fix the Add island must be
  // discovered and protected in both bands.
  const outer = makeFeature('outer', 'line', closedProfile(30, 30, 15, 15), 5, 3)
  const inner = makeFeature('inner', 'line', closedProfile(10, 10, 15, 15), 2, 0)
  const addIsland = makeFeature('add1', 'add', closedProfile(5, 5, 15, 15), 5, 0)
  const project = makeProject([outer, inner, addIsland])
  const op = makeVCarveOp('op1', ['outer', 'inner'])
  const result = resolvePocketRegions(project, op)

  assert(result.bands.length === 2,
    `expected 2 bands (5→3 and 2→0), got ${result.bands.length}`)

  // Top band (5→3): only outer Line active — Add island must be discovered
  // and protected.
  const topBand = result.bands.find((b) => b.topZ === 5 && b.bottomZ === 3)
  assert(topBand !== undefined, 'top band 5→3 must exist')
  assert(topBand.islandFeatureIds.includes('add1'),
    `top band must discover add1 as island, got islands: ${topBand.islandFeatureIds.join(', ')}`)
  // Machinable area = 30×30 outer minus 5×5 island = 900 - 25 = 875
  const topArea = topBand.regions.reduce((sum, r) => sum + regionArea(r), 0)
  assert(approx(topArea, 875),
    `top band area should be ~875, got ${topArea}`)

  // Bottom band (2→0): only inner Line active — Add island must also be
  // discovered and protected.
  const bottomBand = result.bands.find((b) => b.topZ === 2 && b.bottomZ === 0)
  assert(bottomBand !== undefined, 'bottom band 2→0 must exist')
  assert(bottomBand.islandFeatureIds.includes('add1'),
    `bottom band must discover add1 as island, got islands: ${bottomBand.islandFeatureIds.join(', ')}`)
  // Machinable area = 10×10 inner minus 5×5 island = 100 - 25 = 75
  const bottomArea = bottomBand.regions.reduce((sum, r) => sum + regionArea(r), 0)
  assert(approx(bottomArea, 75),
    `bottom band area should be ~75, got ${bottomArea}`)
})

// ═══════════════════════════════════════════════════════════════════════
// S2 REQUIRED: geometry area assertions for even-odd and region clipping
// ═══════════════════════════════════════════════════════════════════════

test('nested same-winding Lines resolve to even-odd hole area (800 sq units)', () => {
  // Outer 30×30 (area 900), inner 10×10 (area 100) — both CW winding.
  // Even-odd fill: inner creates a hole → machinable = 900 - 100 = 800.
  const outer = makeFeature('outer', 'line', closedProfile(30, 30, 15, 15))
  const inner = makeFeature('inner', 'line', closedProfile(10, 10, 15, 15))
  const project = makeProject([outer, inner])
  const op = makeVCarveOp('op1', ['outer', 'inner'])
  const result = resolvePocketRegions(project, op)

  assert(result.bands.length > 0, 'should produce bands for nested lines')
  const totalArea = result.bands.reduce(
    (sum, band) => sum + band.regions.reduce((s, r) => s + regionArea(r), 0),
    0,
  )
  assert(approx(totalArea, 800),
    `nested even-odd area should be ~800, got ${totalArea}`)
  // Also verify the island geometry: at least one region should have an
  // island representing the hole.
  const hasIslands = result.bands.some((b) => b.regions.some((r) => r.islands.length > 0))
  assert(hasIslands, 'even-odd hole should appear as an island on a region')
})

test('region mask clips Line target to include-only area (200 sq units)', () => {
  // 20×20 Line (area 400), clipped by 10×20 region covering the right half.
  const line = makeFeature('l1', 'line', closedProfile(20, 20))
  const region = makeFeature('reg', 'region', closedProfile(10, 20, 15, 10))
  const project = makeProject([line, region])
  const op = makeVCarveOp('op1', ['l1', 'reg'])
  const result = resolvePocketRegions(project, op)

  assert(result.bands.length > 0,
    `region mask should produce bands, got ${result.bands.length}`)
  const totalArea = result.bands.reduce(
    (sum, band) => sum + band.regions.reduce((s, r) => s + regionArea(r), 0),
    0,
  )
  assert(approx(totalArea, 200),
    `region-clipped area should be ~200, got ${totalArea}`)
  // Region itself should not be a targetFeatureId — it's a mask, not a
  // machining target.
  const hasRegionAsTarget = result.bands.some((b) => b.targetFeatureIds.includes('reg'))
  assert(!hasRegionAsTarget, 'region should not appear as a machining target')

  // The warnings should not call the line invalid merely because it's not subtract.
  const hasSubtractOnlyWarning = result.warnings.some(
    (w) => w.includes('subtract') && !w.includes('line') && !w.includes('subtract/line'),
  )
  assert(!hasSubtractOnlyWarning,
    `should not warn about subtract-only with line targets, got: ${result.warnings.join('; ')}`)
})

// ═══════════════════════════════════════════════════════════════════════
// S2 REQUIRED: closed Line vs equivalent Subtract area comparison
// ═══════════════════════════════════════════════════════════════════════

test('single closed Line and equivalent Subtract produce matching band Z ranges and resolved area', () => {
  const lineProj = makeProject([makeFeature('l1', 'line', closedProfile(20, 20))])
  const subProj = makeProject([makeFeature('s1', 'subtract', closedProfile(20, 20))])
  const lineResult = resolvePocketRegions(lineProj, makeVCarveOp('op1', ['l1']))
  const subResult = resolvePocketRegions(subProj, makeVCarveOp('op1', ['s1']))

  assert(lineResult.bands.length === subResult.bands.length,
    `Line and Subtract should produce same band count`)
  assert(lineResult.bands.length > 0, 'should produce at least one band')

  for (let i = 0; i < lineResult.bands.length; i++) {
    const lb = lineResult.bands[i]
    const sb = subResult.bands[i]
    assert(lb.topZ === sb.topZ && lb.bottomZ === sb.bottomZ,
      `band ${i}: Line Z [${lb.topZ},${lb.bottomZ}] should match Subtract Z [${sb.topZ},${sb.bottomZ}]`)
    const lineArea = lb.regions.reduce((sum, r) => sum + regionArea(r), 0)
    const subArea = sb.regions.reduce((sum, r) => sum + regionArea(r), 0)
    assert(approx(lineArea, subArea),
      `band ${i}: Line area ${lineArea} should match Subtract area ${subArea}`)
  }
})

// ── Single closed Line ─────────────────────────────────────────────────

test('single closed Line produces regions for V-carve', () => {
  const project = makeProject([makeFeature('l1', 'line')])
  const op = makeVCarveOp('op1', ['l1'])
  const result = resolvePocketRegions(project, op)
  assert(result.bands.length > 0, 'should produce at least one band')
  assert(result.warnings.filter((w) => w.includes('warning') || w.includes('invalid')).length === 0,
    `unexpected warnings: ${result.warnings.join('; ')}`)
  for (const band of result.bands) {
    assert(band.regions.length > 0, 'band should have regions')
    assert(band.targetFeatureIds.includes('l1'), 'band should reference the line feature')
  }
})

// ── Open Line rejection ────────────────────────────────────────────────

test('open Line is rejected for V-carve', () => {
  const project = makeProject([makeFeature('openL', 'line', openProfile(0, 0, 10, 10))])
  const op = makeVCarveOp('op1', ['openL'])
  const result = resolvePocketRegions(project, op)
  assert(result.bands.length === 0, 'open line should produce no bands')
  assert(
    result.warnings.some((w) => w.toLowerCase().includes('closed')),
    `should warn about closed geometry, got: ${result.warnings.join('; ')}`,
  )
})

test('open Line for Pocket produces no bands', () => {
  const project = makeProject([makeFeature('openL', 'line', openProfile(0, 0, 10, 10))])
  const op = makePocketOp('op1', ['openL'])
  const result = resolvePocketRegions(project, op)
  assert(
    result.warnings.length > 0 || result.bands.length === 0,
    'pocket with line should produce warnings',
  )
})

// ── Nested same-winding even-odd hole ──────────────────────────────────

test('nested same-winding Lines produce even-odd hole', () => {
  const outer = makeFeature('outer', 'line', closedProfile(30, 30, 15, 15))
  const inner = makeFeature('inner', 'line', closedProfile(10, 10, 15, 15))
  const project = makeProject([outer, inner])
  const op = makeVCarveOp('op1', ['outer', 'inner'])
  const result = resolvePocketRegions(project, op)
  assert(result.bands.length > 0, 'should produce bands for nested lines')
  for (const band of result.bands) {
    assert(band.regions.length > 0, 'band should have regions')
    const hasIslands = band.regions.some((r) => r.islands.length > 0)
    assert(hasIslands,
      `even-odd hole should appear as islands on a region, got ${band.regions.length} regions without islands`)
  }
})

// ── Disjoint Lines ─────────────────────────────────────────────────────

test('disjoint closed Lines produce separate areas', () => {
  const left = makeFeature('left', 'line', closedProfile(10, 10, 5, 5))
  const right = makeFeature('right', 'line', closedProfile(10, 10, 30, 5))
  const project = makeProject([left, right])
  const op = makeVCarveOp('op1', ['left', 'right'])
  const result = resolvePocketRegions(project, op)
  assert(result.bands.length > 0, 'should produce bands for disjoint lines')
  for (const band of result.bands) {
    const regionCount = band.regions.length
    assert(regionCount >= 2 || band.regions.reduce((sum, r) => sum + 1 + r.islands.length, 0) >= 2,
      `disjoint lines should produce multiple machinable areas, got ${regionCount} regions`)
  }
})

// ── Mixed Subtract + Line ──────────────────────────────────────────────

test('mixed Subtract + closed Line combine correctly', () => {
  const sub = makeFeature('sub', 'subtract', closedProfile(15, 15, 7.5, 7.5))
  const line = makeFeature('line1', 'line', closedProfile(10, 10, 25, 15))
  const project = makeProject([sub, line])
  const op = makeVCarveOp('op1', ['sub', 'line1'])
  const result = resolvePocketRegions(project, op)
  assert(result.bands.length > 0, 'should produce bands for mixed features')
  const allTargetIds = new Set(result.bands.flatMap((b) => b.targetFeatureIds))
  assert(allTargetIds.has('sub'), 'subtract feature should be in target ids')
  assert(allTargetIds.has('line1'), 'line feature should be in target ids')
})

// ── Mixed union behavior: Subtract may fill a Line even-odd hole ───────

test('overlapping Subtract fills a Line even-odd hole in the overlap area', () => {
  // Outer Line 30×30, inner Line 10×10 same-winding → even-odd hole.
  // A Subtract 12×12 overlapping the hole should fill the hole where it
  // overlaps, because the Subtract non-zero union overrides the empty area.
  // The Line subset outside the Subtract fill still observes even-odd.
  const outer = makeFeature('outer', 'line', closedProfile(30, 30, 15, 15))
  const inner = makeFeature('inner', 'line', closedProfile(10, 10, 15, 15))
  const sub = makeFeature('sub', 'subtract', closedProfile(12, 12, 15, 15))
  const project = makeProject([outer, inner, sub])
  const op = makeVCarveOp('op1', ['outer', 'inner', 'sub'])
  const result = resolvePocketRegions(project, op)

  assert(result.bands.length > 0, 'should produce bands for mixed union')
  // The Subtract 12×12 covers the 10×10 even-odd hole, so the resolved
  // area should be at least the outer area (900) — no hole in the center.
  const totalArea = result.bands.reduce(
    (sum, band) => sum + band.regions.reduce((s, r) => s + regionArea(r), 0),
    0,
  )
  // The Subtract area (144) overlays the hole area (100). Non-zero union
  // of outer + subtract removes the hole. Expected ≈ 900.
  assert(approx(totalArea, 900),
    `subtract filling hole should produce ~900 area, got ${totalArea}`)
})

// ── Subtract-only regression ───────────────────────────────────────────

test('V-carve with subtract-only works as before', () => {
  const sub = makeFeature('sub', 'subtract', closedProfile(20, 20))
  const project = makeProject([sub])
  const op = makeVCarveOp('op1', ['sub'])
  const result = resolvePocketRegions(project, op)
  assert(result.bands.length > 0, 'should produce bands for subtract feature')
  assert(result.bands[0].regions.length > 0, 'should have machinable regions')
})

// ── Pocket remains Subtract-only ───────────────────────────────────────

test('Pocket rejects Line targets', () => {
  const line = makeFeature('l1', 'line', closedProfile(20, 20))
  const project = makeProject([line])
  const op = makePocketOp('op1', ['l1'])
  const result = resolvePocketRegions(project, op)
  assert(result.bands.length === 0, 'pocket should produce no bands for line-only target')
  assert(
    result.warnings.some((w) => w.toLowerCase().includes('subtract')),
    `pocket should warn about needing subtract features, got: ${result.warnings.join('; ')}`,
  )
})

// ── V-carve recursive with closed Line ─────────────────────────────────

test('v_carve_medial accepts closed Line', () => {
  const line = makeFeature('l1', 'line', closedProfile(20, 20))
  const project = makeProject([line])
  const op = { ...makeVCarveOp('op1', ['l1']), kind: 'v_carve_medial' as const }
  const result = resolvePocketRegions(project, op)
  assert(result.bands.length > 0, 'v_carve_medial should produce bands for closed line')
})

// ── Summary ────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
