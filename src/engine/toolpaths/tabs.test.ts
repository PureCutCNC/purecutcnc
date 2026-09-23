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
 * Tab application tests — issue #445.
 *
 * Covers the three engine-side halves of that fix: the tab obstacle is the
 * tool's round swept envelope (not a square), a fully covered final pass is
 * reported rather than emitted silently, and tab spacing is measurable against
 * the real tool-centre path.
 *
 * Run with: npx tsx src/engine/toolpaths/tabs.test.ts
 */

import { circleProfile, defaultTool, newProject, rectProfile, type Operation, type Project, type Tab } from '../../types/project'
import { projectWithFeatures, resolvedFeature } from '../../test/projectFixtures'
import { flattenProfile } from './geometry'
import { generateEdgeRouteToolpath } from './edge'
import { buildAutoTabsForFeature } from '../operations/autoTabs'
import { computeOperationToolpath } from './generateOperation'
import { applyEdgeRouteTabs, applyTabsToEdgeRoute, applyTabWarnings, tabLayoutFreeFraction, toolCentreContours } from './tabs'
import type { ToolpathResult } from './types'

// ── Harness ──────────────────────────────────────────────────────────

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
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
    console.log(`   ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────

const TOOL_DIAMETER = 6
const TOOL_RADIUS = TOOL_DIAMETER / 2

function baseProject(): Project {
  const base = newProject()
  return {
    ...base,
    meta: { ...base.meta, units: 'mm' },
    stock: { ...base.stock, thickness: 12 },
    tools: [{ ...defaultTool('mm', 1), id: 't1', name: 'em6', diameter: TOOL_DIAMETER, units: 'mm' }],
  }
}

function edgeOperation(featureId: string, kind: Operation['kind'] = 'edge_route_inside'): Operation {
  return {
    id: 'op1',
    name: 'Edge',
    kind,
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: [featureId] },
    toolRef: 't1',
    stepdown: 4,
    stepover: 0.4,
    feed: 800,
    plungeFeed: 300,
    rpm: 18000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    roundOutsideCorners: false,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 1,
    maxCarveDepth: 1,
    cutDirection: 'conventional',
    machiningOrder: 'level_first',
  }
}

function tab(id: string, x: number, y: number, size: number, zTop = 3): Tab {
  return { id, name: `Tab ${id}`, x, y, w: size, h: size, z_top: zTop, z_bottom: 0, visible: true }
}

/** Circle feature of the given diameter centred at (60, 60), cut as a hole. */
function circleProject(diameter: number, tabs: Tab[]): { project: Project; operation: Operation } {
  const project = projectWithFeatures(baseProject(), [
    {
      id: 'f1',
      name: 'Hole',
      kind: 'circle',
      folderId: null,
      sketch: {
        profile: circleProfile(60, 60, diameter / 2),
        origin: { x: 0, y: 0 },
        orientationAngle: 0,
        dimensions: [],
        constraints: [],
      },
      operation: 'subtract',
      z_top: 12,
      z_bottom: 0,
      visible: true,
      locked: false,
    },
  ] as never)
  return { project: { ...project, tabs }, operation: edgeOperation('f1') }
}

function run(project: Project, operation: Operation): ToolpathResult {
  // Shipped pipeline order: warnings judge the pre-tab toolpath, tabs adjust it after.
  const warned = applyTabWarnings(project, operation, generateEdgeRouteToolpath(project, operation))
  return applyTabsToEdgeRoute(project, operation, warned)
}

function deepestCutZ(result: ToolpathResult): number {
  return result.moves
    .filter((move) => move.kind === 'cut')
    .reduce((min, move) => Math.min(min, move.from.z, move.to.z), Number.POSITIVE_INFINITY)
}

// ── Step 1: the raised zone is the tool's round envelope, not a square ──

console.log('\nTab obstacle uses the tool\'s round swept envelope')

test('path in the miter-only corner band is left free', () => {
  // Tab corner at (10, 10), tool radius 3. A path 3.6 away along the diagonal is
  // outside the tool's disc (3) but inside the square a miter join would produce
  // (radius * sqrt(2) = 4.243 along the diagonal), so a miter expansion would
  // wrongly claim it. Kept tiny so the whole loop stays inside that band.
  const diagonal = 3.6 / Math.SQRT2
  const centre = 10 + diagonal
  const half = 0.1
  const loop = [
    { x: centre - half, y: centre - half },
    { x: centre + half, y: centre - half },
    { x: centre + half, y: centre + half },
    { x: centre - half, y: centre + half },
  ]

  const nearest = Math.hypot(centre - half - 10, centre - half - 10)
  const furthest = Math.hypot(centre + half - 10, centre + half - 10)
  assert(nearest > 3, `loop clears the round envelope, nearest corner at ${nearest.toFixed(3)}`)
  assert(furthest < 3 * Math.SQRT2, `loop stays inside the miter square, furthest corner at ${furthest.toFixed(3)}`)

  const free = tabLayoutFreeFraction([loop], [{ x: 0, y: 0, w: 10, h: 10 }], 3)
  assert(free > 0.999, `path is fully free of the tab, got free fraction ${free.toFixed(3)}`)
})

test('path within the tool radius of a tab is still claimed', () => {
  // Same corner, but 2.4 away along the diagonal — inside the tool's disc.
  const diagonal = 2.4 / Math.SQRT2
  const centre = 10 + diagonal
  const half = 0.1
  const loop = [
    { x: centre - half, y: centre - half },
    { x: centre + half, y: centre - half },
    { x: centre + half, y: centre + half },
    { x: centre - half, y: centre + half },
  ]

  const free = tabLayoutFreeFraction([loop], [{ x: 0, y: 0, w: 10, h: 10 }], 3)
  assert(free < 0.001, `path is fully covered by the tab, got free fraction ${free.toFixed(3)}`)
})

test('a tab still raises the path it genuinely covers', () => {
  const { project, operation } = circleProject(40, [tab('tb1', 56, 36, 8)])
  const result = run(project, operation)
  const raised = result.moves.filter((move) => move.kind === 'cut' && Math.abs(move.from.z - 3) < 1e-6)
  assert(raised.length > 0, `tab raises part of the path, got ${raised.length} raised cut moves`)
  assert(Math.abs(deepestCutZ(result)) < 1e-9, 'the rest of the pass still reaches final depth')
})

// ── Step 2: warnings are judged against the pre-tab toolpath ──

console.log('\nTab warnings judge the pre-tab cut range')

test('an applied tab is not reported as outside the cut Z range', () => {
  const { project, operation } = circleProject(40, [tab('tb1', 56, 36, 8)])
  const codes = run(project, operation).warnings.map((warning) => warning.code)
  assert(
    !codes.some((code) => code === 'tabOutsideCutZ' || code.startsWith('tabsOutsideCutZ')),
    `no outside-cut-Z warning, got [${codes.join(', ')}]`,
  )
})

test('a tab genuinely above the cut range is still reported', () => {
  // Cut spans z 12 -> 0; a tab from z 20 to 24 never meets it.
  const { project, operation } = circleProject(40, [{ ...tab('tb1', 56, 36, 8), z_bottom: 20, z_top: 24 }])
  const codes = run(project, operation).warnings.map((warning) => warning.code)
  assert(
    codes.some((code) => code === 'tabOutsideCutZ' || code.startsWith('tabsOutsideCutZ')),
    `outside-cut-Z warning still fires, got [${codes.join(', ')}]`,
  )
})

// ── Issue #828: a finish pass cut at the tab's own bottom ──

console.log('\nFinish pass at the tab bottom (issue #828)')

/** The reported workflow: rectangle, Edge Out Both, auto tabs placed from the rough op. */
function rectangleEdgeOutBoth(): { project: Project; rough: Operation; finish: Operation } {
  const withFeature = projectWithFeatures(baseProject(), [
    {
      id: 'f1',
      name: 'Rect',
      kind: 'rect',
      folderId: null,
      sketch: {
        profile: rectProfile(20, 20, 80, 50),
        origin: { x: 0, y: 0 },
        orientationAngle: 0,
        dimensions: [],
        constraints: [],
      },
      operation: 'add',
      z_top: 12,
      z_bottom: 0,
      visible: true,
      locked: false,
    },
  ] as never)
  const rough = edgeOperation('f1', 'edge_route_outside')
  const finish: Operation = { ...rough, id: 'op2', name: 'Edge finish', pass: 'finish' }
  const tabs = buildAutoTabsForFeature(resolvedFeature(withFeature, 'f1'), withFeature, rough, [])
  return { project: { ...withFeature, tabs }, rough, finish }
}

function outsideCutZCodes(result: ToolpathResult): string[] {
  return result.warnings
    .map((warning) => warning.code)
    .filter((code) => code === 'tabOutsideCutZ' || code.startsWith('tabsOutsideCutZ'))
}

test('auto tabs are not reported outside the cut Z range on the finish pass', () => {
  const { project, rough, finish } = rectangleEdgeOutBoth()
  assert(project.tabs.length > 0, 'auto placement produced tabs')
  for (const operation of [rough, finish]) {
    const envelope = computeOperationToolpath(project, operation)
    assert(envelope, `${operation.pass} pass generated`)
    const codes = outsideCutZCodes(envelope.result)
    assert(codes.length === 0, `${operation.pass}: no outside-cut-Z warning, got [${codes.join(', ')}]`)
  }
})

test('the finish pass still lifts over the tabs and reaches final depth elsewhere', () => {
  const { project, finish } = rectangleEdgeOutBoth()
  const tabTop = project.tabs[0].z_top
  const envelope = computeOperationToolpath(project, finish)
  assert(envelope, 'finish pass generated')
  const cuts = envelope.result.moves.filter((move) => move.kind === 'cut')
  assert(cuts.some((move) => Math.abs(move.from.z - tabTop) < 1e-6 && Math.abs(move.to.z - tabTop) < 1e-6), 'part of the pass runs at the tab top')
  assert(Math.abs(deepestCutZ(envelope.result)) < 1e-9, 'the rest of the pass reaches z=0')
})

test('a tab raised clear of the finish level is still reported', () => {
  // The finish pass cuts only at z=0; a tab from z=1 never meets it, and the
  // motion pass leaves the finish cut at z=0 through it.
  const { project, finish } = rectangleEdgeOutBoth()
  const raised = { ...project, tabs: project.tabs.map((entry) => ({ ...entry, z_bottom: 1 })) }
  const envelope = computeOperationToolpath(raised, finish)
  assert(envelope, 'finish pass generated')
  const codes = outsideCutZCodes(envelope.result)
  assert(codes.length > 0, 'outside-cut-Z warning still fires for an ineffective tab')
})

// ── Step 3: total coverage is reported ──

console.log('\nTabs that swallow the final pass are reported')

test('full coverage raises tabsBlockFinalDepth', () => {
  // Four oversized tabs on a small circle cover the whole tool-centre path.
  const { project, operation } = circleProject(24, [
    tab('tb1', 54, 42, 12),
    tab('tb2', 54, 66, 12),
    tab('tb3', 42, 54, 12),
    tab('tb4', 66, 54, 12),
  ])
  const result = run(project, operation)
  assert(deepestCutZ(result) > 1e-9, `final pass never reaches z=0, got ${deepestCutZ(result)}`)
  assert(
    result.warnings.some((warning) => warning.code === 'tabsBlockFinalDepth'),
    `tabsBlockFinalDepth is raised, got [${result.warnings.map((w) => w.code).join(', ')}]`,
  )
})

test('partial coverage does not raise tabsBlockFinalDepth', () => {
  const { project, operation } = circleProject(40, [tab('tb1', 56, 36, 8), tab('tb2', 56, 76, 8)])
  const result = run(project, operation)
  assert(Math.abs(deepestCutZ(result)) < 1e-9, 'the pass still reaches final depth')
  assert(
    !result.warnings.some((warning) => warning.code === 'tabsBlockFinalDepth'),
    'tabsBlockFinalDepth is not raised when the part is cut free',
  )
})

// ── Step 4: coverage measurement against the real tool-centre path ──

console.log('\nTab coverage is measured on the tool-centre path')

test('a circle\'s inside path is shorter than its bounding box suggests', () => {
  const points = flattenProfile(circleProfile(60, 60, 12.7)).points
  const contours = toolCentreContours(points, -TOOL_RADIUS)
  assert(contours.length === 1, `one inside contour, got ${contours.length}`)
  let length = 0
  const contour = contours[0]
  for (let index = 0; index < contour.length; index += 1) {
    const start = contour[index]
    const end = contour[(index + 1) % contour.length]
    length += Math.hypot(end.x - start.x, end.y - start.y)
  }
  const expected = Math.PI * (25.4 - TOOL_DIAMETER)
  assert(Math.abs(length - expected) / expected < 0.01, `path length ~${expected.toFixed(2)}, got ${length.toFixed(2)}`)
})

test('four tabs cover a circle that the same four leave open on a square', () => {
  const rects = [
    { x: 60 - 3.96875, y: 60 - 12.7 - 3.96875, w: 7.9375, h: 7.9375 },
    { x: 60 - 3.96875, y: 60 + 12.7 - 3.96875, w: 7.9375, h: 7.9375 },
    { x: 60 - 12.7 - 3.96875, y: 60 - 3.96875, w: 7.9375, h: 7.9375 },
    { x: 60 + 12.7 - 3.96875, y: 60 - 3.96875, w: 7.9375, h: 7.9375 },
  ]
  const radius = 6.35 / 2
  const circle = toolCentreContours(flattenProfile(circleProfile(60, 60, 12.7)).points, -radius)
  const square = toolCentreContours(flattenProfile(rectProfile(60 - 12.7, 60 - 12.7, 25.4, 25.4)).points, -radius)

  const circleFree = tabLayoutFreeFraction(circle, rects, radius)
  const squareFree = tabLayoutFreeFraction(square, rects, radius)
  assert(circleFree < 0.05, `circle is all but covered, free fraction ${circleFree.toFixed(3)}`)
  assert(squareFree > 0.2, `square keeps real cut-through, free fraction ${squareFree.toFixed(3)}`)
})

test('two tabs leave a small circle usable', () => {
  const radius = 6.35 / 2
  const circle = toolCentreContours(flattenProfile(circleProfile(60, 60, 12.7)).points, -radius)
  const rects = [
    { x: 60 - 3.96875, y: 60 - 12.7 - 3.96875, w: 7.9375, h: 7.9375 },
    { x: 60 - 3.96875, y: 60 + 12.7 - 3.96875, w: 7.9375, h: 7.9375 },
  ]
  const free = tabLayoutFreeFraction(circle, rects, radius)
  assert(free > 0.4, `two tabs leave most of the path free, got ${free.toFixed(3)}`)
})

// ── Trochoidal bypass ────────────────────────────────────────────────

/**
 * The shared tab pass must not touch trochoidal output. That strategy plans its
 * tab motion in the guide domain — fragmenting before any orbit exists, cutting
 * the local tab-top interval, helically re-entering after — so a second pass
 * splits finished orbits and lifts them with synthesised lead-ins.
 *
 * The regression this pins: the two passes expand the tab footprint by
 * different clearances (tool radius + radial stock-to-leave here, orbit-derived
 * in the generator), so once stock-to-leave is set the shared pass finds
 * "unprotected" cut moves the generator deliberately placed and re-cuts them.
 */
test('applyEdgeRouteTabs leaves trochoidal output untouched', () => {
  const { project, operation } = circleProject(30, [tab('t1', 60 - 4, 60 - 15 - 4, 8, 6)])
  // Stock-to-leave large enough that the shared pass's expansion exceeds the
  // generator's tab clearance — the exact configuration that used to corrupt it.
  const trochoidal: Operation = {
    ...operation,
    pass: 'rough',
    edgeStrategy: 'trochoidal',
    trochoidalCutWidth: 9,
    trochoidalAdvance: 0.1,
    entryStrategy: 'helix',
    entryRampAngle: 5,
    stockToLeaveRadial: 0.4,
  }
  const generated = generateEdgeRouteToolpath(project, trochoidal)
  assert(generated.moves.length > 0, 'trochoidal fixture generated no motion')

  const viaEdgeRoutePass = applyEdgeRouteTabs(project, trochoidal, generated)
  assert(
    viaEdgeRoutePass.moves === generated.moves,
    'applyEdgeRouteTabs must return trochoidal moves by identity, not re-tab them',
  )

  // And prove the bypass is load-bearing rather than vacuous: the shared pass
  // really would rewrite this toolpath if it were still applied.
  const viaSharedPass = applyTabsToEdgeRoute(project, trochoidal, generated)
  assert(
    viaSharedPass.moves.length !== generated.moves.length,
    'shared tab pass no longer alters trochoidal output — this test is now vacuous, '
      + 'confirm the bypass is still needed before deleting it',
  )
})

test('applyEdgeRouteTabs still tabs a contour edge route', () => {
  const { project, operation } = circleProject(30, [tab('t1', 60 - 4, 60 - 15 - 4, 8, 6)])
  const contour: Operation = { ...operation, edgeStrategy: 'contour' }
  const generated = generateEdgeRouteToolpath(project, contour)
  const tabbed = applyEdgeRouteTabs(project, contour, generated)
  assert(
    tabbed.moves.length !== generated.moves.length,
    'contour edge routes must still go through the shared tab pass',
  )
})

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  throw new Error(`${failed} tab test(s) failed`)
}
