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
  preferredToolTypes,
  selectToolForOperation,
  targetFeatureSize,
  TOOL_SIZE_FRACTION,
} from './toolSelection'
import {
  newProject,
  rectProfile,
  type OperationTarget,
  type Project,
  type SketchFeature,
  type Tool,
  type ToolType,
} from '../../types/project'
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
  return { ...base, tools, features }
}

function featureTarget(...ids: string[]): OperationTarget {
  return { source: 'features', featureIds: ids }
}

// ── preferredToolTypes ────────────────────────────────────────────

function testPreferredToolTypes(): void {
  assert(preferredToolTypes('v_carve')[0] === 'v_bit', 'v_carve prefers v_bit')
  assert(preferredToolTypes('v_carve_recursive').join() === 'v_bit', 'v_carve_recursive only v_bit')
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
  // Feature min dimension = 1.0 → maxDiameter = 0.5. Tools: 0.125, 0.25, 0.5, 1.0.
  const tools = [
    makeTool('t-eighth', 'flat_endmill', 0.125),
    makeTool('t-quarter', 'flat_endmill', 0.25),
    makeTool('t-half', 'flat_endmill', 0.5),
    makeTool('t-one', 'flat_endmill', 1.0),
  ]
  const project = projectWith(tools, [makeFeature('f', 'subtract', 1, 1)])
  const sel = selectToolForOperation(project, 'pocket', featureTarget('f'), [])
  assert(sel?.source === 'existing', 'should pick an existing tool')
  assert(sel.toolId === 't-half', `largest tool <= 0.5 should win, got ${sel.toolId} (fraction ${TOOL_SIZE_FRACTION})`)
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

function testImportConvertsUnits(): void {
  // mm project, inch library v_bit → imported tool is in mm with a converted diameter.
  const project = projectWith([], [makeFeature('f', 'subtract', 50, 50)], 'mm')
  const library = [libEntry('lib-vbit', 'v_bit', 0.5, 'inch')]
  const sel = selectToolForOperation(project, 'v_carve', featureTarget('f'), library)
  assert(sel?.source === 'import', 'should import')
  assert(sel.tool.units === 'mm', 'imported tool converted to project units')
  assert(Math.abs(sel.tool.diameter - 12.7) < 1e-6, `0.5in → 12.7mm, got ${sel.tool.diameter}`)
}

function testReturnsNullWhenNoCandidates(): void {
  const project = projectWith([], [makeFeature('f', 'subtract', 2, 2)])
  assert(selectToolForOperation(project, 'pocket', featureTarget('f'), []) === null, 'no tools and no library → null')
}

testPreferredToolTypes()
testTargetFeatureSize()
testSizePicksLargestThatFits()
testSizeFallsBackToSmallestWhenNoneFit()
testImportsVBitWhenProjectHasNone()
testPrefersIdealTypeOverExistingLesserType()
testDrillingFallsBackToFlatWhenNoDrill()
testImportConvertsUnits()
testReturnsNullWhenNoCandidates()

console.log('toolSelection tests passed')
