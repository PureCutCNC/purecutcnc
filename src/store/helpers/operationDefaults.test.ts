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
 * Focused tests for operationDefaults: V-carve Line-target eligibility (issue
 * #270 S2), fallback targets, and the project-units rule of the automatic
 * tool fallback (issue #1132).
 *
 * Run with: npx tsx src/store/helpers/operationDefaults.test.ts
 */

import type { FeatureOperation, OperationTarget, Project, SketchFeature, Tool } from '../../types/project'
import { defaultTool, newProject, rectProfile } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import { defaultOperationForTarget, isOperationTargetValid, fallbackOperationTarget } from './operationDefaults'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

function makeFeature(
  id: string,
  operation: FeatureOperation,
  closed = true,
): SketchFeature {
  const openProfile = {
    start: { x: 0, y: 0 },
    segments: [{ type: 'line' as const, to: { x: 10, y: 10 } }],
    closed: false,
  }
  return {
    id,
    name: id,
    kind: 'polygon',
    folderId: null,
    sketch: {
      profile: closed ? rectProfile(0, 0, 10, 10) : openProfile,
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
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

function makeTarget(featureIds: string[]): OperationTarget {
  return { source: 'features', featureIds }
}

/** An imported mesh feature: rotary operations take only the `'model'` ones. */
function makeModelFeature(id: string, operation: 'model' | 'add'): SketchFeature {
  return {
    id,
    name: id,
    kind: 'stl',
    folderId: null,
    sketch: {
      profile: rectProfile(0, 0, 10, 10),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    stl: { format: 'stl', meshAssetId: 'mesh', scale: 1, axisSwap: 'none' },
    operation,
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function projectWith(features: SketchFeature[]): Project {
  return projectWithFeatures(newProject(), features)
}

function makeTool(id: string, diameter: number, units: Tool['units'], overrides: Partial<Tool> = {}): Tool {
  return {
    id,
    name: id,
    units,
    type: 'flat_endmill',
    diameter,
    vBitAngle: null,
    flutes: 2,
    material: 'carbide',
    defaultRpm: 18000,
    defaultFeed: 30,
    defaultPlungeFeed: 12,
    defaultStepdown: 0.1,
    defaultStepover: 0.4,
    maxCutDepth: 0,
    ...overrides,
  }
}

// ── isOperationTargetValid: V-carve + closed Line ──────────────────

function testClosedLineValidTargetForVCarve(): void {
  const project = projectWith([makeFeature('l1', 'line')])
  assert(
    isOperationTargetValid(project, 'v_carve', makeTarget(['l1'])),
    'closed line should be valid target for v_carve',
  )
  assert(
    isOperationTargetValid(project, 'v_carve_medial', makeTarget(['l1'])),
    'closed line should be valid target for v_carve_medial',
  )
}

function testClosedSubtractValidTargetForVCarve(): void {
  const project = projectWith([makeFeature('s1', 'subtract')])
  assert(
    isOperationTargetValid(project, 'v_carve', makeTarget(['s1'])),
    'closed subtract should remain valid for v_carve',
  )
}

function testOpenLineInvalidTargetForVCarve(): void {
  const project = projectWith([makeFeature('openL', 'line', false)])
  assert(
    !isOperationTargetValid(project, 'v_carve', makeTarget(['openL'])),
    'open line should be invalid for v_carve',
  )
}

function testOpenLineValidForFollowLine(): void {
  const project = projectWith([makeFeature('openL', 'line', false)])
  assert(
    isOperationTargetValid(project, 'follow_line', makeTarget(['openL'])),
    'open line should remain valid for follow_line',
  )
}

function testLineInvalidForPocket(): void {
  const project = projectWith([makeFeature('l1', 'line')])
  assert(
    !isOperationTargetValid(project, 'pocket', makeTarget(['l1'])),
    'line should be invalid for pocket',
  )
}

function testAddInvalidTargetForVCarve(): void {
  const project = projectWith([makeFeature('a1', 'add')])
  assert(
    !isOperationTargetValid(project, 'v_carve', makeTarget(['a1'])),
    'add should be invalid for v_carve',
  )
}

function testMixedSubtractAndLineValidForVCarve(): void {
  const project = projectWith([
    makeFeature('s1', 'subtract'),
    makeFeature('l1', 'line'),
  ])
  assert(
    isOperationTargetValid(project, 'v_carve', makeTarget(['s1', 'l1'])),
    'mixed subtract + closed line should be valid for v_carve',
  )
}

function testConstructionRejectedForVCarve(): void {
  const project = projectWith([makeFeature('c1', 'construction')])
  assert(
    !isOperationTargetValid(project, 'v_carve', makeTarget(['c1'])),
    'construction should be rejected for v_carve',
  )
}

// ── fallbackOperationTarget: V-carve picks first compatible ────────

function testFallbackVCarvePrefersSubtractBeforeLine(): void {
  const project = projectWith([
    makeFeature('s1', 'subtract'),
    makeFeature('l1', 'line'),
  ])
  const target = fallbackOperationTarget(project, 'v_carve')
  assert(target.source === 'features', 'fallback should use features source')
  assert(
    target.featureIds[0] === 's1',
    `fallback should pick first compatible feature (subtract), got ${target.featureIds[0]}`,
  )
}

function testFallbackVCarvePicksLineWhenNoSubtract(): void {
  const project = projectWith([
    makeFeature('add1', 'add'),
    makeFeature('l1', 'line'),
  ])
  const target = fallbackOperationTarget(project, 'v_carve')
  assert(target.source === 'features', 'fallback should use features source')
  assert(
    target.featureIds[0] === 'l1',
    `fallback should pick the line when no subtract exists, got ${target.featureIds[0]}`,
  )
}

function testFallbackVCarveSkipsOpenLine(): void {
  const project = projectWith([
    makeFeature('openL', 'line', false),
    makeFeature('s1', 'subtract'),
  ])
  const target = fallbackOperationTarget(project, 'v_carve')
  assert(target.source === 'features', 'fallback should use features source')
  assert(
    target.featureIds[0] === 's1',
    `fallback should skip open line, got ${target.featureIds[0]}`,
  )
}

function testFallbackVCarveStockWhenNoCompatible(): void {
  const project = projectWith([makeFeature('add1', 'add')])
  const target = fallbackOperationTarget(project, 'v_carve')
  assert(target.source === 'stock', 'fallback should return stock when no compatible feature exists')
}

function testFallbackPocketRemainsSubtractOnly(): void {
  const project = projectWith([
    makeFeature('l1', 'line'),
    makeFeature('s1', 'subtract'),
  ])
  const target = fallbackOperationTarget(project, 'pocket')
  assert(target.source === 'features', 'fallback should use features source')
  assert(
    target.featureIds[0] === 's1',
    'pocket fallback should still prefer subtract, not line',
  )
}

// ── fallbackOperationTarget: rotary takes only a model-operation STL ──

function testFallbackRotaryTakesOnlyModelStl(): void {
  const project = projectWith([
    makeModelFeature('plain', 'add'),
    makeModelFeature('model', 'model'),
  ])
  const target = fallbackOperationTarget(project, 'rotary_finish')
  assert(target.source === 'features', 'rotary fallback should use features source')
  assert(
    target.featureIds.length === 1 && target.featureIds[0] === 'model',
    `rotary fallback must take only an STL whose operation is 'model', got ${target.featureIds.join(', ')}`,
  )
}

// ── defaultOperationForTarget: the fallback cutter is in project units ──

function testFirstToolFallbackSkipsOtherUnits(): void {
  const target = makeTarget(['s1'])
  const features = [makeFeature('s1', 'subtract')]

  // A mm project holding only an inch tool falls back to the mm default tool
  // with no reference — never to the inch record (issue #1132).
  const metric = projectWithFeatures({ ...newProject('t', 'mm'), tools: [makeTool('inch-quarter', 0.25, 'inch')] }, features)
  const fallback = defaultOperationForTarget(metric, 'pocket', 'rough', target, 0)
  assert(fallback.toolRef === null, 'no same-units tool means no tool reference')
  assert(
    Math.abs(fallback.stepdown - defaultTool('mm', 1).defaultStepdown) < 1e-9,
    `defaults come from the project-units default tool, got ${fallback.stepdown}`,
  )

  // With a tool in the project's units present, that one is the fallback and
  // the foreign-unit one is skipped even though it is listed first.
  const mixed = projectWithFeatures({
    ...newProject('t', 'mm'),
    tools: [makeTool('inch-quarter', 0.25, 'inch'), makeTool('mm-six', 6, 'mm', { defaultStepdown: 2 })],
  }, features)
  const picked = defaultOperationForTarget(mixed, 'pocket', 'rough', target, 0)
  assert(picked.toolRef === 'mm-six', `the same-units tool is the fallback, got ${picked.toolRef}`)
  assert(picked.stepdown === 2, 'the fallback tool supplies the defaults')

  // The inch mirror.
  const imperial = projectWithFeatures({
    ...newProject('t', 'inch'),
    tools: [makeTool('mm-six', 6, 'mm')],
  }, features)
  assert(
    defaultOperationForTarget(imperial, 'pocket', 'rough', target, 0).toolRef === null,
    'an inch project does not fall back to a mm tool',
  )

  // The plasma branch is held to the same rule.
  const plasmaProject = projectWithFeatures({
    ...newProject('t', 'inch'),
    tools: [makeTool('mm-torch', 1.2, 'mm', { type: 'plasma' })],
  }, features)
  assert(
    defaultOperationForTarget(plasmaProject, 'plasma_profile', 'rough', target, 0).toolRef === null,
    'a mm torch is not the inch project\'s fallback',
  )
}

// ── Run ────────────────────────────────────────────────────────────

testClosedLineValidTargetForVCarve()
testClosedSubtractValidTargetForVCarve()
testOpenLineInvalidTargetForVCarve()
testOpenLineValidForFollowLine()
testLineInvalidForPocket()
testAddInvalidTargetForVCarve()
testMixedSubtractAndLineValidForVCarve()
testConstructionRejectedForVCarve()
testFallbackVCarvePrefersSubtractBeforeLine()
testFallbackVCarvePicksLineWhenNoSubtract()
testFallbackVCarveSkipsOpenLine()
testFallbackVCarveStockWhenNoCompatible()
testFallbackPocketRemainsSubtractOnly()
testFallbackRotaryTakesOnlyModelStl()
testFirstToolFallbackSkipsOtherUnits()

console.log('operationDefaults target, fallback and tool-units tests passed')
