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
 * Tests for automatic tool selection when an operation is added.
 *
 * Run with: npx tsx src/engine/operations/toolSelection.test.ts
 */

import {
  autoToolDiameterLimit,
  preferredToolTypes,
  selectToolForOperation,
  targetFeatureSize,
} from './toolSelection'
import { camPlanToolPool, rankCamPlanTools } from './camPlan/toolPlanning'
import {
  newProject,
  rectProfile,
  type OperationTarget,
  type Project,
  type SketchFeature,
  type Tool,
  type ToolType,
} from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import type { ToolLibraryEntry } from '../../toolLibrary'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function makeTool(id: string, type: ToolType, diameter: number, units: Tool['units'] = 'inch'): Tool {
  return {
    id,
    name: id,
    units,
    type,
    diameter,
    vBitAngle: type === 'v_bit' ? 60 : null,
    flutes: 2,
    material: 'carbide',
    defaultRpm: 18000,
    defaultFeed: 30,
    defaultPlungeFeed: 12,
    defaultStepdown: 0.1,
    defaultStepover: 0.4,
    maxCutDepth: 0,
  }
}

function libEntry(key: string, type: ToolType, diameter: number, units: Tool['units'] = 'inch'): ToolLibraryEntry {
  return { ...makeTool(key, type, diameter, units), key } as ToolLibraryEntry
}

function makeFeature(id: string, operation: SketchFeature['operation'], w: number, h: number): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(0, 0, w, h),
      origin: { x: 0, y: 0 },
      orientationAngle: 90,
      dimensions: [],
      constraints: [],
    },
    operation,
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function projectWith(tools: Tool[], features: SketchFeature[], units: 'mm' | 'inch' = 'inch'): Project {
  const base = newProject('t', units)
  return projectWithFeatures({ ...base, tools }, features)
}

function featureTarget(...ids: string[]): OperationTarget {
  return { source: 'features', featureIds: ids }
}

// ── preferredToolTypes ────────────────────────────────────────────

function testPreferredToolTypes(): void {
  assert(preferredToolTypes('v_carve')[0] === 'v_bit', 'v_carve prefers v_bit')
  assert(preferredToolTypes('v_carve_medial').join() === 'v_bit', 'v_carve_medial only v_bit')
  assert(preferredToolTypes('finish_surface')[0] === 'ball_endmill', 'finish prefers ball')
  assert(preferredToolTypes('rough_surface')[0] === 'flat_endmill', 'rough prefers flat')
  assert(preferredToolTypes('drilling')[0] === 'drill', 'drilling prefers drill')
  assert(preferredToolTypes('drilling').includes('flat_endmill'), 'drilling accepts flat as fallback')
  assert(preferredToolTypes('pocket')[0] === 'flat_endmill', 'pocket prefers flat')
}

// ── targetFeatureSize ─────────────────────────────────────────────

function testTargetFeatureSize(): void {
  const project = projectWith([], [makeFeature('a', 'subtract', 2, 1), makeFeature('b', 'subtract', 4, 4)])
  // min dimension of 'a' is 1, of 'b' is 4 → smallest across both is 1.
  assert(targetFeatureSize(project, featureTarget('a', 'b')) === 1, 'uses smallest min-dimension across features')
  assert(targetFeatureSize(project, featureTarget('b')) === 4, 'single feature uses its min dimension')
  // Regions are ignored.
  const withRegion = projectWith([], [makeFeature('m', 'subtract', 3, 3), makeFeature('r', 'region', 10, 10)])
  assert(targetFeatureSize(withRegion, featureTarget('m', 'r')) === 3, 'regions excluded from size')
}

// ── selectToolForOperation ────────────────────────────────────────

function testSizePicksLargestThatFits(): void {
  // Pocket on a 1.0 square → limit 0.2 × 1.0 = 0.2. Tools: 0.125, 0.25, 0.5, 1.0.
  const tools = [
    makeTool('t-eighth', 'flat_endmill', 0.125),
    makeTool('t-quarter', 'flat_endmill', 0.25),
    makeTool('t-half', 'flat_endmill', 0.5),
    makeTool('t-one', 'flat_endmill', 1.0),
  ]
  const project = projectWith(tools, [makeFeature('f', 'subtract', 1, 1)])
  const sel = selectToolForOperation(project, 'pocket', featureTarget('f'), [])
  assert(sel?.source === 'existing', 'should pick an existing tool')
  assert(sel.toolId === 't-eighth', `largest tool <= 0.2 should win, got ${sel.toolId}`)
}

const ROUTER_BITS = [0.125, 0.25, 0.375, 0.5, 0.75]
function routerBitTools(): Tool[] {
  return ROUTER_BITS.map((diameter) => makeTool(`t-${diameter}`, 'flat_endmill', diameter))
}

function testSmallOutsideProfileGetsQuarterNotThreeQuarter(): void {
  // #876: a 2×2 outside route used to pick the 3/4 (limit 0.5 × 2 = 1.0).
  // Now the limit is 0.15 × 2 = 0.3 → 1/4.
  const project = projectWith(routerBitTools(), [makeFeature('f', 'add', 2, 2)])
  const sel = selectToolForOperation(project, 'edge_route_outside', featureTarget('f'), [])
  assert(sel?.source === 'existing' && sel.toolId === 't-0.25', `2x2 outside route picks 1/4, got ${JSON.stringify(sel)}`)
}

function testLargePartIsCappedAtQuarterInch(): void {
  // 6" part: the fraction alone would allow 0.9 (outside) / 1.2 (pocket); the
  // 1/4" ceiling keeps both on the everyday cutter.
  const project = projectWith(routerBitTools(), [makeFeature('f', 'add', 6, 6), makeFeature('p', 'subtract', 6, 6)])
  for (const [kind, id] of [['edge_route_outside', 'f'], ['edge_route_inside', 'p'], ['pocket', 'p']] as const) {
    const sel = selectToolForOperation(project, kind, featureTarget(id), [])
    assert(sel?.source === 'existing' && sel.toolId === 't-0.25', `${kind} on a 6" part picks 1/4, got ${JSON.stringify(sel)}`)
  }
  const limit = autoToolDiameterLimit(project, 'pocket', featureTarget('p'))
  assert(limit === 0.25, `6" pocket limit is the 1/4" ceiling, got ${limit}`)
}

function testMetricCeilingAdmitsSixMillimetres(): void {
  const tools = [3, 6, 8, 12].map((diameter) => makeTool(`t-${diameter}mm`, 'flat_endmill', diameter, 'mm'))
  const project = projectWith(tools, [makeFeature('f', 'subtract', 150, 150)], 'mm')
  const sel = selectToolForOperation(project, 'pocket', featureTarget('f'), [])
  assert(sel?.source === 'existing' && sel.toolId === 't-6mm', `metric pocket picks 6 mm, got ${JSON.stringify(sel)}`)
}

function testOnlyBigToolStillFallsBack(): void {
  const project = projectWith([makeTool('t-half', 'flat_endmill', 0.5)], [makeFeature('f', 'add', 6, 6)])
  const sel = selectToolForOperation(project, 'edge_route_outside', featureTarget('f'), [])
  assert(sel?.source === 'existing' && sel.toolId === 't-half', 'a project holding only a 1/2 still gets it')
}

function testUncappedKindsKeepLargerTools(): void {
  // Drilling is sized to the hole (not half of it).
  const drills = [makeTool('d-eighth', 'drill', 0.125), makeTool('d-quarter', 'drill', 0.25)]
  const hole = projectWith(drills, [makeFeature('h', 'subtract', 0.25, 0.25)])
  const drill = selectToolForOperation(hole, 'drilling', featureTarget('h'), [])
  assert(drill?.source === 'existing' && drill.toolId === 'd-quarter', `1/4 hole picks the 1/4 drill, got ${JSON.stringify(drill)}`)

  // V-carve: no 1/4" ceiling on V-bit diameter.
  const vbits = [makeTool('v-half', 'v_bit', 0.5), makeTool('v-one', 'v_bit', 1)]
  const sign = projectWith(vbits, [makeFeature('s', 'subtract', 10, 10)])
  const vcarve = selectToolForOperation(sign, 'v_carve', featureTarget('s'), [])
  assert(vcarve?.source === 'existing' && vcarve.toolId === 'v-one', `v-carve keeps the 1" V-bit, got ${JSON.stringify(vcarve)}`)

  // Facing the stock wants a wide cutter.
  const surfacing = projectWith([makeTool('t-quarter', 'flat_endmill', 0.25), makeTool('t-surfacing', 'flat_endmill', 1)], [])
  surfacing.stock = { ...surfacing.stock, profile: rectProfile(0, 0, 12, 12) }
  const facing = selectToolForOperation(surfacing, 'surface_clean', { source: 'stock' }, [])
  assert(facing?.source === 'existing' && facing.toolId === 't-surfacing', `surface clean keeps the 1" surfacing bit, got ${JSON.stringify(facing)}`)
}

function testCamPlanRankingSharesTheCeiling(): void {
  const project = projectWith(routerBitTools(), [makeFeature('f', 'add', 6, 6)])
  const pool = camPlanToolPool(project, [])
  const ranked = rankCamPlanTools(project, 'edge_route_outside', featureTarget('f'), pool, 0, new Set())
  assert(ranked.maximumDiameter === 0.25, `CAM plan outside limit is capped at 1/4, got ${ranked.maximumDiameter}`)
  assert(ranked.tools[0]?.id === 't-0.25', `CAM plan picks 1/4 on a 6" part, got ${ranked.tools[0]?.id}`)

  // An explicit override (the imported-model footprint limit) is capped as well.
  const surface = rankCamPlanTools(project, 'rough_surface', featureTarget('f'), pool, 0, new Set(), 2)
  assert(surface.maximumDiameter === 0.25, `model-footprint override is capped at 1/4, got ${surface.maximumDiameter}`)
}

function testSizeFallsBackToSmallestWhenNoneFit(): void {
  // Feature min dimension = 0.1 → maxDiameter = 0.05. No tool fits → smallest.
  const tools = [makeTool('t-quarter', 'flat_endmill', 0.25), makeTool('t-eighth', 'flat_endmill', 0.125)]
  const project = projectWith(tools, [makeFeature('f', 'subtract', 0.1, 0.1)])
  const sel = selectToolForOperation(project, 'pocket', featureTarget('f'), [])
  assert(sel?.source === 'existing' && sel.toolId === 't-eighth', 'smallest tool when none fit')
}

function testImportsVBitWhenProjectHasNone(): void {
  // Project has only a flat endmill; v-carve needs a v_bit → import from library.
  const project = projectWith([makeTool('t-flat', 'flat_endmill', 0.25)], [makeFeature('f', 'subtract', 2, 2)])
  const library = [libEntry('lib-vbit', 'v_bit', 0.5), libEntry('lib-flat', 'flat_endmill', 0.25)]
  const sel = selectToolForOperation(project, 'v_carve', featureTarget('f'), library)
  assert(sel?.source === 'import', 'should import a v_bit')
  assert(sel.tool.type === 'v_bit', 'imported tool is a v_bit')
  assert(sel.tool.vBitAngle === 60, 'v_bit keeps its angle')
}

function testPrefersIdealTypeOverExistingLesserType(): void {
  // Finish surface prefers ball; project has only a flat → import the ball.
  const project = projectWith([makeTool('t-flat', 'flat_endmill', 0.25)], [makeFeature('f', 'model', 4, 4)])
  const library = [libEntry('lib-ball', 'ball_endmill', 0.125), libEntry('lib-flat', 'flat_endmill', 0.25)]
  const sel = selectToolForOperation(project, 'finish_surface', featureTarget('f'), library)
  assert(sel?.source === 'import' && sel.tool.type === 'ball_endmill', 'imports ball even though a flat exists')
}

function testDrillingFallsBackToFlatWhenNoDrill(): void {
  // No drill exists and the library has none → accept an existing flat endmill.
  const project = projectWith([makeTool('t-flat', 'flat_endmill', 0.125)], [makeFeature('c', 'subtract', 0.5, 0.5)])
  const sel = selectToolForOperation(project, 'drilling', featureTarget('c'), [])
  assert(sel?.source === 'existing' && sel.toolId === 't-flat', 'drilling accepts flat when no drill available')
}

function testEachUnitTakesItsOwnLibraryEntry(): void {
  // The bundled library holds some tools once per unit. Each project imports
  // the entry written in its own units, under its own name and values; the
  // other entry is never a candidate, so no conversion happens at all (#1132).
  const inchTorch = { ...libEntry('torch-in', 'plasma', 1.4 / 25.4, 'inch'), name: 'Torch — inch units', defaultFeed: 200 }
  const mmTorch = { ...libEntry('torch-mm', 'plasma', 1.4, 'mm'), name: 'Torch', defaultFeed: 5000 }
  const orders: Array<[string, ToolLibraryEntry[]]> = [['inch first', [inchTorch, mmTorch]], ['mm first', [mmTorch, inchTorch]]]
  for (const [order, library] of orders) {
    const metric = selectToolForOperation(projectWith([], [makeFeature('f', 'add', 100, 100)], 'mm'), 'plasma_profile', featureTarget('f'), library)
    assert(metric?.source === 'import', `${order}: a mm project imports a torch`)
    assert(metric.tool.name === 'Torch' && metric.tool.units === 'mm', `${order}: a mm project takes the mm entry, got "${metric.tool.name}"`)
    assert(metric.tool.diameter === 1.4 && metric.tool.defaultFeed === 5000, `${order}: with the mm entry's own values, got ${metric.tool.diameter} / ${metric.tool.defaultFeed}`)

    const imperial = selectToolForOperation(projectWith([], [makeFeature('f', 'add', 4, 4)], 'inch'), 'plasma_profile', featureTarget('f'), library)
    assert(imperial?.source === 'import', `${order}: an inch project imports a torch`)
    assert(imperial.tool.name === 'Torch — inch units' && imperial.tool.units === 'inch', `${order}: an inch project takes the inch entry, got "${imperial.tool.name}"`)
    assert(imperial.tool.diameter === 1.4 / 25.4 && imperial.tool.defaultFeed === 200, `${order}: with the inch entry's own values`)
  }
}

function testNeverImportsTheOtherUnitsEntry(): void {
  // #1132: the other unit's entry is not imported by conversion either. With
  // no entry in the project's units the caller gets `null` (its own fallback
  // then uses a project-units default tool) rather than a wrong-unit cutter.
  const metric = projectWith([], [makeFeature('f', 'subtract', 50, 50)], 'mm')
  const inchVBit = libEntry('lib-vbit', 'v_bit', 0.5, 'inch')
  assert(
    selectToolForOperation(metric, 'v_carve', featureTarget('f'), [inchVBit]) === null,
    'an inch library entry is never converted into a mm project',
  )

  // The rule is about the units, not one direction.
  const imperial = projectWith([], [makeFeature('f', 'subtract', 2, 2)], 'inch')
  const mmVBit = libEntry('lib-vbit-mm', 'v_bit', 12, 'mm')
  assert(
    selectToolForOperation(imperial, 'v_carve', featureTarget('f'), [mmVBit]) === null,
    'a mm library entry is never converted into an inch project',
  )
}

function testSameUnitsBeatsTheLargerCutter(): void {
  // Frank's report (#1132): an inch project holding a 6 mm and a 3/16" endmill
  // picked the 6 mm one, because converting it made it physically larger. Only
  // the inch tool is a candidate now, so the 3/16" wins despite being smaller.
  const inchProject = projectWith([
    makeTool('t-six-mm', 'flat_endmill', 6, 'mm'),
    makeTool('t-three-sixteenths', 'flat_endmill', 0.1875),
  ], [makeFeature('f', 'subtract', 2, 2)])
  const imperial = selectToolForOperation(inchProject, 'pocket', featureTarget('f'), [])
  assert(imperial?.source === 'existing' && imperial.toolId === 't-three-sixteenths', `an inch project picks the 3/16", got ${JSON.stringify(imperial)}`)

  // Mirrored: 1/4" is 6.35 mm and the larger cutter, but the mm project may
  // only take its own 5 mm.
  const metricProject = projectWith([
    makeTool('t-quarter-inch', 'flat_endmill', 0.25, 'inch'),
    makeTool('t-five-mm', 'flat_endmill', 5, 'mm'),
  ], [makeFeature('f', 'subtract', 50, 50)], 'mm')
  const metric = selectToolForOperation(metricProject, 'pocket', featureTarget('f'), [])
  assert(metric?.source === 'existing' && metric.toolId === 't-five-mm', `a mm project picks the 5 mm, got ${JSON.stringify(metric)}`)
}

function testFallsBackToTheProjectUnitsLibraryEntry(): void {
  // All of a project's own tools are in the other units: the pick comes from
  // the library in the project's units, never from one of those tools and never
  // by converting the other unit's entry.
  const inchProject = projectWith([makeTool('t-six-mm', 'flat_endmill', 6, 'mm')], [makeFeature('f', 'subtract', 2, 2)])
  const inchLibrary = [libEntry('lib-six-mm', 'flat_endmill', 6, 'mm'), libEntry('lib-quarter', 'flat_endmill', 0.25)]
  const imperial = selectToolForOperation(inchProject, 'pocket', featureTarget('f'), inchLibrary)
  assert(imperial?.source === 'import', `an inch project imports an inch library cutter, got ${JSON.stringify(imperial)}`)
  assert(imperial.tool.units === 'inch' && imperial.tool.name === 'lib-quarter', `the inch entry, got ${imperial.tool.name}`)

  const metricProject = projectWith([makeTool('t-quarter', 'flat_endmill', 0.25)], [makeFeature('f', 'subtract', 50, 50)], 'mm')
  const mmLibrary = [libEntry('lib-six-mm', 'flat_endmill', 6, 'mm'), libEntry('lib-quarter-inch', 'flat_endmill', 0.25)]
  const metric = selectToolForOperation(metricProject, 'pocket', featureTarget('f'), mmLibrary)
  assert(metric?.source === 'import', `a mm project imports a mm library cutter, got ${JSON.stringify(metric)}`)
  assert(metric.tool.units === 'mm' && metric.tool.name === 'lib-six-mm', `the metric entry, got ${metric.tool.name}`)
}

function testReturnsNullWhenNoCandidates(): void {
  const project = projectWith([], [makeFeature('f', 'subtract', 2, 2)])
  assert(selectToolForOperation(project, 'pocket', featureTarget('f'), []) === null, 'no tools and no library → null')
}

testPreferredToolTypes()
testTargetFeatureSize()
testSizePicksLargestThatFits()
testSmallOutsideProfileGetsQuarterNotThreeQuarter()
testLargePartIsCappedAtQuarterInch()
testMetricCeilingAdmitsSixMillimetres()
testOnlyBigToolStillFallsBack()
testUncappedKindsKeepLargerTools()
testCamPlanRankingSharesTheCeiling()
testSizeFallsBackToSmallestWhenNoneFit()
testImportsVBitWhenProjectHasNone()
testPrefersIdealTypeOverExistingLesserType()
testDrillingFallsBackToFlatWhenNoDrill()
testEachUnitTakesItsOwnLibraryEntry()
testNeverImportsTheOtherUnitsEntry()
testSameUnitsBeatsTheLargerCutter()
testFallsBackToTheProjectUnitsLibraryEntry()
testReturnsNullWhenNoCandidates()

console.log('toolSelection tests passed')
